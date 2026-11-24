/**
 * File transfer state machine (docs/PROTOCOL.md §6). Control messages go through the durable outbox
 * (deps.enqueue, always in the same SQLite transaction as the state change); bytes go through croc.
 */
import { chmodSync, existsSync, readdirSync, renameSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { openFrom, random, randomId, sanitizeFileName, sealFor } from "@spencer/protocol";
import type { FileBody } from "@spencer/protocol";
import { TERMINAL_STATES } from "../contracts.ts";
import type { Transfer, TransferDeps, TransferRequest, TransferService, TransferUpload } from "../contracts.ts";
import { CROC_CODE_RE, realCrocRunner } from "./croc.ts";
import type { CrocExit, CrocJob, CrocRunner } from "./croc.ts";
import { dirBytes, dirsFor, ensureDir, ensureDirAsync, findReceived, rmrf, sha256File, stageCopy } from "./files.ts";
import { TransferStore } from "./store.ts";
import type { TransferRow } from "./store.ts";

export interface TransferServiceOptions {
  /** croc implementation; defaults to realCrocRunner(deps.crocPath) with a pid file in the data dir. */
  runner?: CrocRunner;
  /** Delay before re-spawning after attempt `failedAttempt` failed. Default 1 s, 2 s, 4 s … capped at 30 s. */
  backoffMs?: (failedAttempt: number) => number;
  /** Expiry sweeper interval. Default 30 s. */
  sweepIntervalMs?: number;
  /** How long to wait before trying again when deps.crocInfo(ch) has nothing. Default 5 s. */
  noRelayRetryMs?: number;
  /** Receiver disk-usage watchdog interval (kills croc if it writes more than the offered size). Default 1 s. */
  watchdogMs?: number;
}

export type TransferErrorCode = "not_found" | "bad_state" | "bad_request" | "stopped";

export class TransferError extends Error {
  code: TransferErrorCode;
  constructor(code: TransferErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "TransferError";
  }
}

const NON_TERMINAL = new Set(["awaiting_approval", "offered", "accepted", "sending", "receiving"]);

interface Running {
  job: { kill(): void; done: Promise<unknown> };
  attempt: number;
  role: "send" | "receive";
  watchdog?: ReturnType<typeof setInterval>;
}

type Patch = Partial<TransferRow>;

export function defaultBackoff(failedAttempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, failedAttempt - 1), 30_000);
}

function newCode(): string {
  const r = random(18);
  const digits = (((r[0] << 8) | r[1]) % 10000).toString().padStart(4, "0");
  return `${digits}-${Buffer.from(r.subarray(2)).toString("hex")}`;
}

function clip(s: string | undefined | null, n = 300): string | undefined {
  if (s == null) return undefined;
  const t = s.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

export function createTransferService(deps: TransferDeps, options: TransferServiceOptions = {}): TransferService {
  const now = deps.now ?? Date.now;
  const runner =
    options.runner ??
    realCrocRunner(deps.crocPath, {
      pidFile: { path: join(deps.dataDir, "croc.pids"), ownedDir: deps.dataDir },
      ...(deps.crocThrottleUpload ? { throttleUpload: deps.crocThrottleUpload } : {}),
    });
  const backoff = options.backoffMs ?? defaultBackoff;
  const sweepIntervalMs = options.sweepIntervalMs ?? 30_000;
  const maxUploadBytes = 25 * 1024 * 1024;
  const noRelayRetryMs = options.noRelayRetryMs ?? 5000;
  const watchdogMs = options.watchdogMs ?? 1000;
  const store = new TransferStore(deps.db);
  const dirs = dirsFor(deps.dataDir);
  const uploadStagingDir = join(deps.dataDir, "upload-staging");

  const jobs = new Map<string, Running>();
  const linkTried = new Map<string, number>();
  const linkSendOk = new Map<string, boolean>();
  const linkZeroRetryUsed = new Set<string>();
  const resumedRetryUsed = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const progress = new Map<string, number>();
  const lastProgressEmit = new Map<string, number>();
  const tasks = new Set<Promise<unknown>>();
  let sweeper: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const ttlMs = () => Math.max(1, deps.policy().transferTtlHours) * 3_600_000;
  const maxAttempts = () => Math.max(1, deps.policy().maxTransferAttempts || 5);
  const outDir = (tid: string) => join(dirs.outgoing, tid);
  const inDir = (tid: string) => join(dirs.incoming, tid);

  // ------------------------------------------------------------ helpers

  function toApi(r: TransferRow): Transfer {
    const t: Transfer = {
      tid: r.tid,
      ch: r.ch,
      direction: r.direction,
      peer: r.peer,
      name: r.name,
      size: r.size,
      sha256: r.sha256,
      state: r.state,
      attempt: r.attempt,
      initiatedBy: r.initiatedBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      expiresAt: r.expiresAt,
    };
    let peerName: string | undefined;
    try {
      peerName = deps.peerName(r.ch, r.peer);
    } catch {
      /* channel gone */
    }
    if (r.via === "link" || r.via === "croc") t.via = r.via;
    if (peerName) t.peerName = peerName;
    if (r.reason) t.reason = r.reason;
    if (r.error) t.error = r.error;
    if (r.path) t.path = r.path;
    const p = r.state === "completed" ? 1 : progress.get(r.tid);
    if (p !== undefined) t.progress = p;
    return t;
  }

  function emitRow(r: TransferRow): void {
    try {
      deps.events.emit({ type: "transfer", transfer: toApi(r) });
    } catch {
      /* listeners must not break the state machine */
    }
  }

  function note(text: string): void {
    try {
      // File names, peer display names and transfer reasons come from other people's Spencers.
      deps.ownerNote(text, { untrusted: true });
    } catch {
      /* informational only */
    }
  }

  function peerLabel(r: TransferRow): string {
    let n: string | undefined;
    try {
      n = deps.peerName(r.ch, r.peer);
    } catch {
      /* ignore */
    }
    return n ? `${clip(n, 80)} (${r.peer.slice(0, 8)}…)` : `${r.peer.slice(0, 8)}…`;
  }

  function body<T extends FileBody["type"]>(type: T, r: TransferRow, extra: object): FileBody {
    return { type, tid: r.tid, to: r.peer, ...extra } as FileBody;
  }

  function track<T>(p: Promise<T>): Promise<T> {
    tasks.add(p);
    void p.finally(() => tasks.delete(p)).catch(() => {});
    return p;
  }

  function clearTimer(tid: string): void {
    const t = timers.get(tid);
    if (t) clearTimeout(t);
    timers.delete(tid);
  }

  function schedule(tid: string, ms: number, fn: () => void): void {
    clearTimer(tid);
    if (stopped) return;
    const t = setTimeout(() => {
      timers.delete(tid);
      if (!stopped) fn();
    }, ms);
    timers.set(tid, t);
  }

  function killJob(tid: string): void {
    const j = jobs.get(tid);
    if (!j) return;
    jobs.delete(tid);
    if (j.watchdog) clearInterval(j.watchdog);
    j.job.kill();
  }

  /** Kills croc, clears timers, and deletes staged/partial files. Never touches quarantine. */
  function cleanupRuntime(r: TransferRow): void {
    killJob(r.tid);
    linkTried.delete(r.tid);
    linkSendOk.delete(r.tid);
    linkZeroRetryUsed.delete(r.tid);
    resumedRetryUsed.delete(r.tid);
    clearTimer(r.tid);
    lastProgressEmit.delete(r.tid);
    progress.delete(r.tid);
    rmrf(outDir(r.tid));
    rmrf(inDir(r.tid));
  }

  /**
   * Atomic conditional state change: re-reads the row, checks `guard`, applies the patch and enqueues the
   * protocol bodies in one transaction. Emits the event after commit. Returns the new row, or undefined
   * if the guard rejected it (stale/duplicate event).
   */
  function transition(
    tid: string,
    guard: (r: TransferRow) => boolean,
    patch: Patch | ((r: TransferRow) => Patch),
    bodies?: (r: TransferRow) => FileBody[],
  ): TransferRow | undefined {
    const next = store.tx(() => {
      const r = store.get(tid);
      if (!r || !guard(r)) return undefined;
      const p: Patch = { ...(typeof patch === "function" ? patch(r) : patch), updatedAt: now() };
      const state = p.state ?? r.state;
      if (TERMINAL_STATES.has(state)) {
        p.code = null;
        p.nextAttemptAt = null;
        if (r.direction === "out") p.path = null;
      }
      store.update(tid, p);
      const n: TransferRow = { ...r, ...p };
      for (const b of bodies?.(n) ?? []) deps.enqueue(r.ch, b);
      return n;
    });
    if (!next) return undefined;
    if (TERMINAL_STATES.has(next.state)) cleanupRuntime(next);
    emitRow(next);
    return next;
  }

  /** `fraction`: 0–1 (the API's `Transfer.progress` unit). */
  function setProgress(tid: string, fraction: number): void {
    progress.set(tid, fraction);
    const t = now();
    if (fraction < 1 && t - (lastProgressEmit.get(tid) ?? 0) < 500) return;
    lastProgressEmit.set(tid, t);
    const r = store.get(tid);
    if (r && NON_TERMINAL.has(r.state)) emitRow(r);
  }

  function mustGet(tid: string): TransferRow {
    const r = store.get(tid);
    if (!r) throw new TransferError("not_found", `no such transfer: ${tid}`);
    return r;
  }

  function apiTransition(
    tid: string,
    verb: string,
    direction: "in" | "out" | undefined,
    allowed: Set<string>,
    patch: Patch | ((r: TransferRow) => Patch),
    bodies?: (r: TransferRow) => FileBody[],
  ): Transfer {
    const ok = (r: TransferRow) => (!direction || r.direction === direction) && allowed.has(r.state);
    const r = mustGet(tid);
    if (!ok(r)) {
      throw new TransferError("bad_state", `cannot ${verb} ${r.direction === "out" ? "an outgoing" : "an incoming"} transfer in state ${r.state}`);
    }
    const n = transition(tid, ok, patch, bodies);
    if (!n) throw new TransferError("bad_state", `cannot ${verb} transfer ${tid}`);
    return toApi(n);
  }

  // ------------------------------------------------------------ sender side

  function startSend(tid: string): void {
    clearTimer(tid);
    if (stopped) return;
    const r = store.get(tid);
    if (!r || r.direction !== "out" || r.state !== "sending") return;
    const existing = jobs.get(tid);
    if (existing && existing.attempt === r.attempt) return;
    killJob(tid);
    if (!r.code || !r.path || !existsSync(r.path)) {
      transition(tid, (x) => x.state === "sending", { state: "failed", error: "staged file is missing" }, (x) => [
        body("file_cancel", x, { reason: "sender lost the file" }),
      ]);
      return;
    }
    const info = deps.crocInfo(r.ch);
    const hasCroc = !!info;
    const zeroRetry = linkSendOk.get(tid) === true && !linkZeroRetryUsed.has(tid);
    if (deps.p2p?.canTryLink(r.ch, r.peer, r.size, hasCroc) && (!hasCroc || !linkTried.get(tid) || zeroRetry)) {
      const attempt = r.attempt;
      if (zeroRetry) linkZeroRetryUsed.add(tid);
      linkSendOk.delete(tid);
      linkTried.set(tid, (linkTried.get(tid) ?? 0) + 1);
      transition(tid, (x) => x.state === "sending" && x.attempt === attempt, { via: "link", error: null, nextAttemptAt: null });
      const job = deps.p2p.sendOverLink({ tid, ch: r.ch, peerId: r.peer, attempt, filePath: r.path, size: r.size,
        onReady: () => { if (jobs.get(tid)?.job === job) transition(tid, (x) => x.state === "sending" && x.attempt === attempt, {}, (x) => [body("file_ready", x, { attempt, via: "link" })]); },
        onProgress: (p) => { if (jobs.get(tid)?.job === job) setProgress(tid, p); },
      });
      jobs.set(tid, { job, attempt, role: "send" });
      void track(job.done.then((res) => {
        if (jobs.get(tid)?.job !== job) return;
        jobs.delete(tid);
        if (res.killed || stopped) return;
        linkSendOk.set(tid, res.ok);
        if (res.ok) setProgress(tid, 1);
        else retrySend(tid, attempt, res.error ?? "direct link failed");
      }));
      return;
    }
    if (!info) {
      transition(tid, (x) => x.state === "sending" && x.attempt === r.attempt && x.error !== NO_RELAY, { error: NO_RELAY });
      schedule(tid, noRelayRetryMs, () => startSend(tid));
      return;
    }
    const attempt = r.attempt;
    transition(tid, (x) => x.state === "sending" && x.attempt === attempt, { via: "croc", error: null, nextAttemptAt: null });
    const job = runner.send({
      file: r.path,
      code: r.code,
      relay: info.relay,
      pass: info.pass,
      onReady: () => {
        if (jobs.get(tid)?.job !== job) return;
        transition(tid, (x) => x.state === "sending" && x.attempt === attempt, {}, (x) => [body("file_ready", x, { attempt })]);
      },
      onProgress: (p) => {
        if (jobs.get(tid)?.job === job) setProgress(tid, p);
      },
    });
    jobs.set(tid, { job, attempt, role: "send" });
    void track(job.done.then((exit) => onSendExit(tid, job, attempt, exit)));
  }

  function onSendExit(tid: string, job: CrocJob, attempt: number, exit: CrocExit): void {
    if (jobs.get(tid)?.job !== job) return; // killed or replaced on purpose
    jobs.delete(tid);
    if (exit.killed || stopped) return;
    const r = store.get(tid);
    if (!r || r.state !== "sending" || r.attempt !== attempt) return;
    if (exit.code === 0) {
      setProgress(tid, 1); // bytes handed over; completion waits for file_ack
      return;
    }
    retrySend(tid, attempt, exit.error ?? `croc exited with code ${exit.code}`);
  }

  /** Attempt `failedAttempt` failed (croc error or file_retry): back off and re-spawn, or give up. */
  function retrySend(tid: string, failedAttempt: number, error: string | undefined): void {
    const r = store.get(tid);
    if (!r || r.direction !== "out" || r.state !== "sending" || r.attempt !== failedAttempt) return;
    killJob(tid);
    const guard = (x: TransferRow) => x.state === "sending" && x.attempt === failedAttempt;
    if (failedAttempt >= maxAttempts()) {
      transition(
        tid,
        guard,
        { state: "failed", error: clip(`gave up after ${failedAttempt} attempts${error ? `: ${error}` : ""}`) ?? null },
        (x) => [body("file_cancel", x, { reason: "too many failed attempts" })],
      );
      return;
    }
    const delay = Math.max(0, backoff(failedAttempt));
    const n = transition(tid, guard, { attempt: failedAttempt + 1, nextAttemptAt: now() + delay, error: clip(error) ?? null });
    if (n) schedule(tid, delay, () => startSend(tid));
  }

  // ------------------------------------------------------------ recipient side

  function startReceive(tid: string, attempt: number, via?: "link"): void {
    const n = transition(
      tid,
      (x) => x.direction === "in" && (x.state === "accepted" || x.state === "receiving") && attempt > x.attempt,
      { state: "receiving", attempt, via: via === "link" ? "link" : "croc", error: null },
    );
    if (!n) return;
    killJob(tid);
    progress.delete(tid);
    spawnReceive(tid);
  }

  function spawnReceive(tid: string): void {
    clearTimer(tid);
    if (stopped) return;
    const r = store.get(tid);
    if (!r || r.direction !== "in" || r.state !== "receiving" || !r.code) return;
    killJob(tid);
    const attempt = r.attempt;
    const dir = inDir(tid);
    ensureDir(dirs.incoming);
    ensureDir(dir);
    if (r.via === "link") {
      if (!deps.p2p) {
        transition(tid, (x) => x.state === "receiving" && x.attempt === attempt, { error: "direct links not supported" }, (x) => [body("file_retry", x, { attempt })]);
        return;
      }
      const job = deps.p2p.receiveOverLink({ tid, ch: r.ch, peerId: r.peer, attempt, partPath: join(dir, `${r.name}.part`), finalPath: join(dir, r.name), size: r.size,
        onProgress: (p) => { if (jobs.get(tid)?.job === job) setProgress(tid, p); },
      });
      jobs.set(tid, { job, attempt, role: "receive" });
      void track(job.done.then(async (res) => {
        if (jobs.get(tid)?.job !== job) return;
        jobs.delete(tid);
        if (res.killed || stopped) return;
        const guard = (x: TransferRow) => x.state === "receiving" && x.attempt === attempt;
        if (res.ok) await verifyReceived(tid, attempt, false, (res.resumedFrom ?? 0) > 0);
        else if (res.error?.includes("exceeds") || res.error?.includes("more data than offered") || (res as { oversize?: boolean }).oversize) {
          rmrf(dir);
          transition(tid, guard, { state: "failed", error: res.error ?? "size exceeds offer" }, (x) => [body("file_ack", x, { ok: false, reason: "size exceeds offer" })]);
        } else transition(tid, guard, { error: clip(res.error ?? "direct link failed") ?? null }, (x) => [body("file_retry", x, { attempt })]);
      }));
      return;
    }
    for (const name of readdirSync(dir)) if (name.endsWith(".part")) rmrf(join(dir, name));
    const info = deps.crocInfo(r.ch);
    if (!info) {
      transition(tid, (x) => x.state === "receiving" && x.attempt === attempt && x.error !== NO_RELAY, { error: NO_RELAY });
      schedule(tid, noRelayRetryMs, () => {
        const x = store.get(tid);
        if (x && x.state === "receiving" && x.attempt === attempt) spawnReceive(tid);
      });
      return;
    }
    if (r.error) transition(tid, (x) => x.state === "receiving" && x.attempt === attempt, { error: null });
    const job = runner.receive({
      outDir: dir,
      code: r.code,
      relay: info.relay,
      pass: info.pass,
      onProgress: (p) => {
        if (jobs.get(tid)?.job === job) setProgress(tid, p);
      },
    });
    const running: Running = { job, attempt, role: "receive" };
    running.watchdog = setInterval(() => {
      if (jobs.get(tid) !== running) return;
      if (dirBytes(dir) > r.size) {
        killJob(tid);
        rmrf(dir);
        transition(
          tid,
          (x) => x.state === "receiving" && x.attempt === attempt,
          { state: "failed", error: "sender sent more data than offered" },
          (x) => [body("file_ack", x, { ok: false, reason: "size exceeds offer" })],
        );
      }
    }, watchdogMs);
    jobs.set(tid, running);
    void track(job.done.then((exit) => onReceiveExit(tid, running, exit)));
  }

  async function onReceiveExit(tid: string, running: Running, exit: CrocExit): Promise<void> {
    if (running.watchdog) clearInterval(running.watchdog);
    if (jobs.get(tid) !== running) return;
    jobs.delete(tid);
    if (exit.killed || stopped) return;
    const attempt = running.attempt;
    const guard = (x: TransferRow) => x.state === "receiving" && x.attempt === attempt;
    const r = store.get(tid);
    if (!r || !guard(r)) return;
    if (exit.code !== 0) {
      transition(tid, guard, { error: clip(exit.error ?? `croc exited with code ${exit.code}`) ?? null }, (x) => [
        body("file_retry", x, { attempt }),
      ]);
      return;
    }
    await verifyReceived(tid, attempt, false);
  }

  /**
   * Checks the croc output dir. In recovery mode an incomplete/mismatching file is not fatal (it may be a
   * partial write from before the crash): the caller asks for a retry instead. Returns true if it settled
   * the transfer (completed or failed).
   */
  async function verifyReceived(tid: string, attempt: number, recovery: boolean, resumed = false): Promise<boolean> {
    const guard = (x: TransferRow) => x.direction === "in" && x.state === "receiving" && x.attempt === attempt;
    const r = store.get(tid);
    if (!r || !guard(r)) return true;
    const dir = inDir(tid);
    if (recovery && existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(".part"))) return false;
    const found = findReceived(dir);
    const retryFromZero = () => {
      if (recovery || !resumed || resumedRetryUsed.has(tid)) return false;
      resumedRetryUsed.add(tid);
      rmrf(dir);
      transition(tid, guard, { error: "checksum mismatch after resume; retrying from start" }, (x) => [body("file_retry", x, { attempt })]);
      return true;
    };
    const fail = (reason: string, error: string) => {
      rmrf(dir);
      transition(tid, guard, { state: "failed", error }, (x) => [body("file_ack", x, { ok: false, reason })]);
      return true;
    };
    if (found.kind === "none") {
      if (recovery) return false;
      transition(tid, guard, { error: "croc reported success but no file arrived" }, (x) => [body("file_retry", x, { attempt })]);
      return true;
    }
    if (found.kind === "unexpected") {
      if (!recovery) return fail("unexpected content", found.reason);
      rmrf(dir);
      return false;
    }
    if (found.size !== r.size) return recovery ? false : retryFromZero() || fail("size mismatch", `size mismatch: got ${found.size}, expected ${r.size}`);
    const hash = await sha256File(found.path);
    const cur = store.get(tid);
    if (!cur || !guard(cur)) return true; // cancelled/expired/newer attempt while hashing
    if (hash !== r.sha256) return recovery ? false : retryFromZero() || fail("sha256 mismatch", "sha256 mismatch");
    // Synchronous from here on: nothing can interleave between the move and the state change.
    const qdir = join(dirs.quarantine, tid);
    ensureDir(dirs.quarantine);
    ensureDir(qdir);
    const dest = join(qdir, sanitizeFileName(r.name));
    renameSync(found.path, dest);
    chmodSync(dest, 0o600);
    const n = transition(tid, guard, { state: "completed", path: dest, error: null }, (x) => [
      body("file_ack", x, { ok: true, sha256: hash }),
    ]);
    if (n) note(`Received file "${n.name}" (${fmtBytes(n.size)}) from ${peerLabel(n)}. Saved (unopened) to ${dest}`);
    else rmrf(qdir);
    return true;
  }

  // ------------------------------------------------------------ incoming bodies

  function onOffer(ch: string, from: string, b: Extract<FileBody, { type: "file_offer" }>): void {
    if (from === deps.me.id) return;
    let members: string[];
    try {
      members = deps.peers(ch);
    } catch {
      return;
    }
    if (!members.includes(from)) return;
    if (store.get(b.tid)) return; // duplicate (or a tid collision we refuse to merge)
    const t = now();
    if (b.expiresAt <= t) return;
    const policy = deps.policy();
    const auto = policy.autoAcceptIncomingFiles && b.size <= policy.maxIncomingFileBytes;
    const row: TransferRow = {
      tid: b.tid,
      uploadId: null,
      ch,
      direction: "in",
      peer: from,
      name: sanitizeFileName(b.name),
      size: b.size,
      sha256: b.sha256,
      state: "offered",
      attempt: 0,
      code: null,
      via: null,
      initiatedBy: "peer",
      reason: null,
      error: null,
      path: null,
      peerKnows: true,
      nextAttemptAt: null,
      createdAt: t,
      updatedAt: t,
      expiresAt: Math.min(b.expiresAt, t + ttlMs()),
    };
    let accepted = false;
    const n = store.tx(() => {
      if (store.get(b.tid)) return undefined;
      store.insert(row);
      if (!auto) return row;
      const code = newCode();
      const sealed = sealFor(deps.pairKey(ch, from), b.tid, { code });
      const p: Patch = { state: "accepted", code };
      store.update(b.tid, p);
      deps.enqueue(ch, body("file_accept", row, { sealed }));
      accepted = true;
      return { ...row, ...p };
    });
    if (!n) return;
    emitRow(n);
    if (!accepted) {
      const why = b.size > policy.maxIncomingFileBytes ? " (larger than the auto-accept limit)" : "";
      note(
        `Incoming file waiting for approval: "${n.name}" (${fmtBytes(n.size)}) from ${peerLabel(n)}${why}. Accept or decline transfer ${n.tid}.`,
      );
    }
  }

  function onAccept(r: TransferRow, b: Extract<FileBody, { type: "file_accept" }>): void {
    if (r.direction !== "out" || r.state !== "offered") return;
    let code: string | undefined;
    try {
      const o = openFrom<{ code?: unknown }>(deps.pairKey(r.ch, r.peer), r.tid, b.sealed);
      if (typeof o?.code === "string" && CROC_CODE_RE.test(o.code)) code = o.code;
    } catch {
      code = undefined;
    }
    if (!code) {
      transition(r.tid, (x) => x.state === "offered", { state: "failed", error: "peer sent an invalid sealed code" }, (x) => [
        body("file_cancel", x, { reason: "invalid sealed code" }),
      ]);
      return;
    }
    const n = transition(r.tid, (x) => x.state === "offered", { state: "sending", attempt: 1, code, error: null });
    if (n) startSend(r.tid);
  }

  // ------------------------------------------------------------ sweeper / recovery

  function sweep(): void {
    const t = now();
    for (const r of store.nonTerminal()) {
      if (r.expiresAt > t) continue;
      transition(
        r.tid,
        (x) => NON_TERMINAL.has(x.state) && x.expiresAt <= t,
        { state: "expired", error: "expired" },
        (x) => (x.peerKnows ? [body("file_cancel", x, { reason: "expired" })] : []),
      );
    }
  }

  function clearStaleUploadStaging(): void {
    ensureDir(uploadStagingDir);
    let names: string[];
    try {
      names = readdirSync(uploadStagingDir);
    } catch {
      return;
    }
    for (const name of names) rmrf(join(uploadStagingDir, name));
  }

  function removeOrphanDirs(): void {
    const live = new Set(store.nonTerminal().map((r) => r.tid));
    for (const base of [dirs.outgoing, dirs.incoming]) {
      let names: string[];
      try {
        names = readdirSync(base);
      } catch {
        continue;
      }
      for (const n of names) if (!live.has(n)) rmrf(join(base, n));
    }
  }

  async function recover(): Promise<void> {
    for (const r of store.nonTerminal()) {
      if (r.direction === "out" && r.state === "sending") {
        if (r.attempt >= maxAttempts()) {
          retrySend(r.tid, r.attempt, "interrupted by restart");
          continue;
        }
        const n = transition(r.tid, (x) => x.state === "sending" && x.attempt === r.attempt, {
          attempt: r.attempt + 1,
          nextAttemptAt: null,
        });
        if (n) startSend(r.tid);
      } else if (r.direction === "in" && r.state === "receiving") {
        const settled = await verifyReceived(r.tid, r.attempt, true).catch(() => false);
        if (!settled) {
          transition(r.tid, (x) => x.state === "receiving" && x.attempt === r.attempt, {}, (x) => [
            body("file_retry", x, { attempt: x.attempt }),
          ]);
        }
      }
      // awaiting_approval / offered / accepted: nothing to do but wait.
    }
  }

  // ------------------------------------------------------------ public API

  return {
    async start() {
      stopped = false;
      // croc children of a previous run that died without stopping them (SIGKILL, crash) would keep sending or
      // writing into incoming/; kill them before anything resumes.
      try {
        const reaped = runner.reapOrphans?.() ?? [];
        if (reaped.length) deps.log?.(`killed ${reaped.length} orphaned croc process(es) from a previous run: ${reaped.join(", ")}`);
      } catch {
        /* best effort */
      }
      for (const d of [dirs.outgoing, dirs.incoming, dirs.quarantine]) ensureDir(d);
      clearStaleUploadStaging();
      sweep();
      removeOrphanDirs();
      await recover();
      if (!sweeper) {
        sweeper = setInterval(() => {
          try {
            sweep();
          } catch {
            /* next round */
          }
        }, sweepIntervalMs);
      }
    },

    async stop() {
      stopped = true;
      if (sweeper) clearInterval(sweeper);
      sweeper = undefined;
      for (const tid of [...timers.keys()]) clearTimer(tid);
      const dones = [...jobs.values()].map((j) => j.job.done);
      for (const tid of [...jobs.keys()]) killJob(tid);
      const settle = Promise.all([...dones, ...tasks].map((p) => p.catch(() => {})));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([settle, new Promise((r) => (timeout = setTimeout(r, 5000)))]);
      if (timeout) clearTimeout(timeout);
    },

    async request(ch, req: TransferRequest) {
      if (stopped) throw new TransferError("stopped", "transfer service is stopped");
      if (typeof req.path !== "string" || !isAbsolute(req.path)) throw new TransferError("bad_request", "path must be absolute");
      let st;
      try {
        st = await stat(req.path); // follows symlinks: a symlink to a regular file is fine, to a dir is not
      } catch {
        throw new TransferError("bad_request", `cannot read ${req.path}`);
      }
      if (!st.isFile()) throw new TransferError("bad_request", `${req.path} is not a regular file`);
      const peers = deps.peers(ch);
      let to = req.to;
      if (to !== undefined) {
        if (to === deps.me.id || !peers.includes(to)) throw new TransferError("bad_request", "recipient is not a member of this channel");
      } else if (peers.length === 1) {
        to = peers[0];
      } else if (peers.length === 0) {
        throw new TransferError("bad_request", "channel has no other member yet");
      } else {
        throw new TransferError("bad_request", "`to` is required in group channels");
      }
      const name = sanitizeFileName(basename(req.path));
      if (req.uploadId !== undefined) {
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(req.uploadId)) throw new TransferError("bad_request", "invalid upload retry id");
        const previous = store.byUploadId(req.uploadId);
        if (previous) {
          const sha256 = await sha256File(req.path);
          if (previous.ch !== ch || previous.peer !== to || previous.name !== name || previous.size !== st.size || previous.sha256 !== sha256) {
            throw new TransferError("bad_request", "upload retry id was already used for different content or recipient");
          }
          return toApi(previous);
        }
      }
      const tid = randomId();
      const dir = outDir(tid);
      const staged = join(dir, name);
      let size: number;
      let sha256: string;
      try {
        await ensureDirAsync(dirs.outgoing);
        await ensureDirAsync(dir);
        size = await stageCopy(req.path, staged);
        sha256 = await sha256File(staged);
      } catch (e) {
        rmrf(dir);
        throw new TransferError("bad_request", `cannot stage file: ${(e as Error).message}`);
      }
      if (stopped) {
        rmrf(dir);
        throw new TransferError("stopped", "transfer service is stopped");
      }
      const policy = deps.policy();
      // A fully trusted channel needs no approval; otherwise the policy decides, and a peer's ask always does.
      const trusted = deps.trust?.(ch) === "full";
      const needsApproval = !trusted && (req.initiatedBy === "peer-agent" || policy.requireApprovalForOutgoingFiles);
      const t = now();
      const row: TransferRow = {
        tid,
        uploadId: req.uploadId ?? null,
        ch,
        direction: "out",
        peer: to,
        name,
        size,
        sha256,
        state: needsApproval ? "awaiting_approval" : "offered",
        attempt: 0,
        code: null,
        via: null,
        initiatedBy: req.initiatedBy,
        reason: clip(req.reason, 1000) ?? null,
        error: null,
        path: staged,
        peerKnows: !needsApproval,
        nextAttemptAt: null,
        createdAt: t,
        updatedAt: t,
        expiresAt: t + ttlMs(),
      };
      try {
        store.tx(() => {
          store.insert(row);
          if (!needsApproval) deps.enqueue(ch, body("file_offer", row, { name, size, sha256, expiresAt: row.expiresAt }));
        });
      } catch (e) {
        rmrf(dir);
        if (req.uploadId) {
          const previous = store.byUploadId(req.uploadId);
          if (previous && previous.ch === ch && previous.peer === to && previous.name === name && previous.size === size && previous.sha256 === sha256) {
            return toApi(previous);
          }
        }
        throw e;
      }
      emitRow(row);
      if (needsApproval) {
        const who = req.initiatedBy === "peer-agent" ? "the peer's agent" : req.initiatedBy === "owner-agent" ? "your agent" : "you";
        note(
          `File send waiting for approval: "${name}" (${fmtBytes(size)}) to ${peerLabel(row)}, requested by ${who}` +
            (row.reason ? ` (reason: ${clip(row.reason, 200)})` : "") +
            `. Approve or deny transfer ${tid}.`,
        );
      }
      return toApi(row);
    },

    async requestUpload(this: TransferService, ch: string, upload: TransferUpload) {
      if (stopped) throw new TransferError("stopped", "transfer service is stopped");
      if (typeof upload.name !== "string" || !upload.name.trim() || Buffer.byteLength(upload.name, "utf8") > 255) {
        throw new TransferError("bad_request", "filename must be between 1 and 255 bytes");
      }
      if (typeof upload.uploadId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(upload.uploadId)) {
        throw new TransferError("bad_request", "invalid upload retry id");
      }
      const dir = join(uploadStagingDir, randomId());
      const name = sanitizeFileName(upload.name);
      const path = join(dir, name);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let size = 0;
      try {
        await ensureDirAsync(dir);
        handle = await open(path, "wx", 0o600);
        for await (const chunk of upload.bytes) {
          if (!(chunk instanceof Uint8Array)) throw new TransferError("bad_request", "upload contains invalid data");
          size += chunk.byteLength;
          if (size > maxUploadBytes) throw new TransferError("bad_request", "file exceeds the 25 MiB upload limit");
          await handle.write(chunk);
        }
        await handle.close();
        handle = undefined;
        if (stopped) throw new TransferError("stopped", "transfer service is stopped");
        return await this.request(ch, { path, to: upload.to, initiatedBy: "owner", uploadId: upload.uploadId });
      } catch (e) {
        if (e instanceof TransferError) throw e;
        throw new TransferError("bad_request", `cannot stage uploaded file: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        await handle?.close().catch(() => {});
        rmrf(dir);
      }
    },

    approve(tid) {
      return apiTransition(
        tid,
        "approve",
        "out",
        new Set(["awaiting_approval"]),
        () => ({ state: "offered", peerKnows: true, expiresAt: now() + ttlMs() }),
        (x) => [body("file_offer", x, { name: x.name, size: x.size, sha256: x.sha256, expiresAt: x.expiresAt })],
      );
    },

    deny(tid) {
      return apiTransition(tid, "deny", "out", new Set(["awaiting_approval"]), { state: "denied" });
    },

    accept(tid) {
      return apiTransition(
        tid,
        "accept",
        "in",
        new Set(["offered"]),
        () => ({ state: "accepted", code: newCode() }),
        (x) => [body("file_accept", x, { sealed: sealFor(deps.pairKey(x.ch, x.peer), x.tid, { code: x.code }) })],
      );
    },

    decline(tid) {
      return apiTransition(tid, "decline", "in", new Set(["offered"]), { state: "declined" }, (x) => [
        body("file_decline", x, { reason: "declined by recipient" }),
      ]);
    },

    cancel(tid) {
      return apiTransition(tid, "cancel", undefined, NON_TERMINAL, { state: "cancelled", error: "cancelled" }, (x) =>
        x.peerKnows ? [body("file_cancel", x, { reason: "cancelled" })] : [],
      );
    },

    async onBody(ch, from, b) {
      if (stopped) throw new TransferError("stopped", "transfer service is stopped");
      if (!b || b.to !== deps.me.id || from === deps.me.id) return;
      if (b.type === "file_offer") {
        onOffer(ch, from, b);
        return;
      }
      const r = store.get(b.tid);
      if (!r || r.ch !== ch || r.peer !== from) return; // unknown transfer or not from its peer
      switch (b.type) {
        case "file_accept":
          onAccept(r, b);
          return;
        case "file_decline":
          if (r.direction !== "out") return;
          transition(r.tid, (x) => x.state === "offered", { state: "declined", error: clip(b.reason) ?? "declined" });
          return;
        case "file_ready":
          if (r.direction !== "in") return;
          startReceive(r.tid, b.attempt, b.via);
          return;
        case "file_retry":
          if (r.direction !== "out") return;
          retrySend(r.tid, b.attempt, "recipient's croc failed");
          return;
        case "file_ack": {
          if (r.direction !== "out") return;
          const sending = (x: TransferRow) => x.state === "sending";
          if (b.ok && (!b.sha256 || b.sha256 === r.sha256)) {
            transition(r.tid, sending, { state: "completed", error: null });
          } else {
            transition(r.tid, sending, {
              state: "failed",
              error: b.ok ? "recipient reported a different sha256" : `recipient rejected the file: ${clip(b.reason, 200) ?? "unknown reason"}`,
            });
          }
          return;
        }
        case "file_cancel":
          transition(r.tid, (x) => NON_TERMINAL.has(x.state), {
            state: "cancelled",
            error: `cancelled by peer: ${clip(b.reason, 200) ?? ""}`,
          });
          return;
      }
    },

    list(ch) {
      return store.list(ch).map(toApi);
    },

    get(tid) {
      const r = store.get(tid);
      return r ? toApi(r) : undefined;
    },
  };
}

const NO_RELAY = "no croc relay available yet; will retry";
