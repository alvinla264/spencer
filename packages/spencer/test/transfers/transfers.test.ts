import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TransferStore } from "../../src/transfers/store.ts";
import { generateIdentity, pairKey, randomId } from "@spencer/protocol";
import type { FileBody } from "@spencer/protocol";
import { createTransferService, fakeCrocRunner, TransferError } from "../../src/transfers/index.ts";
import type { FakeCrocRunner } from "../../src/transfers/index.ts";
import { pair, sleep, waitFor } from "./harness.ts";
import type { TransferP2pAdapter } from "../../src/contracts.ts";
import type { TNode } from "./harness.ts";

type Pair = Awaited<ReturnType<typeof pair>>;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function makeFile(node: TNode, name: string, bytes = 64 * 1024): { path: string; data: Buffer } {
  const src = join(node.dir, "src");
  mkdirSync(src, { recursive: true });
  const data = randomBytes(bytes);
  const path = join(src, name);
  writeFileSync(path, data);
  return { path, data };
}

let current: Pair | undefined;
let fake: FakeCrocRunner;

async function setup(opts: Omit<Parameters<typeof pair>[0], "runner"> = {}): Promise<Pair> {
  fake = fakeCrocRunner();
  current = await pair({ runner: fake, ...opts });
  return current;
}

afterEach(async () => {
  if (!current) return;
  const p = current;
  current = undefined;
  await p.close();
  assert.equal(fake.active(), 0, "no croc jobs left running");
  assert.deepEqual(p.bus.errors, [], "onBody never threw");
});

const noApproval = { policy: { requireApprovalForOutgoingFiles: false } };

describe("transfers (fake croc)", () => {
  it("happy path: owner send, auto-accept, file lands in quarantine", async () => {
    const { A, B, ch, bus } = await setup({ a: noApproval });
    const { path, data } = makeFile(A, "report final.pdf");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    assert.equal(t.state, "offered");
    assert.equal(t.peer, B.id.id);
    assert.equal(t.sha256, sha(data));
    assert.equal(t.size, data.length);
    // staged copy: 0700 dir, 0600 file
    assert.equal(statSync(t.path!).mode & 0o777, 0o600);
    assert.equal(statSync(join(A.dataDir, "outgoing", t.tid)).mode & 0o777, 0o700);

    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
    const got = B.s.get(t.tid)!;
    assert.equal(got.direction, "in");
    assert.equal(got.path, join(B.dataDir, "quarantine", t.tid, "report final.pdf"));
    assert.equal(sha(readFileSync(got.path!)), t.sha256);
    assert.equal(statSync(got.path!).mode & 0o777, 0o600);
    assert.equal(got.progress, 1);
    // sender cleaned its staged copy, recipient its incoming dir
    assert.equal(existsSync(join(A.dataDir, "outgoing", t.tid)), false);
    assert.equal(existsSync(join(B.dataDir, "incoming", t.tid)), false);
    assert.equal(A.s.get(t.tid)!.path, undefined);
    assert.deepEqual(bus.types(), ["file_offer", "file_accept", "file_ready", "file_ack"]);
    assert.ok(B.notes.some((n) => n.includes("Received file") && n.includes(got.path!)));
    assert.equal(A.s.get(t.tid)!.attempt, 1);
    // the croc code never leaks into events, notes, or the API
    const code = (bus.log.find((d) => d.body.type === "file_accept")!.body as { sealed: string }).sealed;
    const dump = JSON.stringify([A.events, B.events, A.notes, B.notes, A.s.list(), B.s.list()]);
    assert.ok(!/\d{4}-[0-9a-f]{32}/.test(dump));
    assert.ok(!dump.includes(code));
    assert.equal(A.s.list(ch).length, 1);
    assert.equal(A.s.list(randomId()).length, 0);
  });

  it("uploaded bytes enter the owner transfer path and partial staging is cleaned", async () => {
    const { A, B, ch } = await setup();
    const data = Buffer.from("small synthetic upload");
    const uploadId = "upload-key-00000001";
    const t = await A.s.requestUpload(ch, { name: "../notes <draft>.txt", uploadId, bytes: (async function* () { yield data; })() });
    assert.equal(t.initiatedBy, "owner");
    assert.equal(t.peer, B.id.id);
    assert.equal(t.size, data.length);
    assert.equal(t.sha256, sha(data));
    assert.equal(t.name.includes("/"), false);
    assert.equal(readFileSync(t.path!).toString(), data.toString());
    assert.equal(existsSync(join(A.dataDir, "upload-staging")), true);
    assert.deepEqual(readdirSync(join(A.dataDir, "upload-staging")), []);
    const retry = await A.s.requestUpload(ch, { name: "../notes <draft>.txt", uploadId, bytes: (async function* () { yield data; })() });
    assert.equal(retry.tid, t.tid, "retry after a lost response returns the committed transfer");
    await assert.rejects(A.s.requestUpload(ch, { name: "../notes <draft>.txt", uploadId, bytes: (async function* () { yield Buffer.from("different"); })() }), /already used for different content/);

    const secondPeer = generateIdentity().id;
    A.peersOf.set(ch, [...A.peersOf.get(ch)!, secondPeer]);
    const groupUpload = await A.s.requestUpload(ch, { name: "group.bin", uploadId: "upload-key-group-0001", to: secondPeer, bytes: (async function* () { yield Buffer.from("group"); })() });
    assert.equal(groupUpload.peer, secondPeer, "group upload keeps the explicit single recipient");

    await assert.rejects(A.s.requestUpload(ch, {
      name: "broken.txt",
      uploadId: "upload-key-broken-001",
      bytes: (async function* () { yield Buffer.from("partial"); throw new Error("synthetic stream failure"); })(),
    }), /cannot stage uploaded file/);
    assert.equal(existsSync(t.path!), true, "failed staging must not remove an active transfer file");
    assert.deepEqual(readdirSync(join(A.dataDir, "upload-staging")), []);
    await assert.rejects(A.s.requestUpload(ch, {
      name: "too-large.bin",
      uploadId: "upload-key-too-large-01",
      bytes: (async function* () { yield Buffer.alloc(25 * 1024 * 1024); yield Buffer.from("x"); })(),
    }), /25 MiB upload limit/);
    assert.deepEqual(readdirSync(join(A.dataDir, "upload-staging")), []);
    assert.equal(A.s.list(ch).length, 2, "failed uploads must not create transfers");
  });

  it("outgoing approval: awaiting_approval → approve → completed", async () => {
    const { A, B, ch, bus } = await setup();
    const { path } = makeFile(A, "a.txt");
    const t = await A.s.request(ch, { path, initiatedBy: "owner-agent", reason: "you asked for it" });
    assert.equal(t.state, "awaiting_approval");
    assert.equal(t.reason, "you asked for it");
    assert.ok(A.notes.some((n) => n.includes("waiting for approval") && n.includes(t.tid)));
    await sleep(20);
    assert.equal(bus.log.length, 0, "peer is not told before approval");
    const ap = A.s.approve(t.tid);
    assert.equal(ap.state, "offered");
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
    assert.throws(() => A.s.approve(t.tid), (e: unknown) => e instanceof TransferError && e.code === "bad_state");
    assert.throws(() => A.s.approve("nope"), (e: unknown) => e instanceof TransferError && e.code === "not_found");
  });

  it("full-trust channel: even a peer agent's send needs no approval", async () => {
    const { A, B, ch } = await setup();
    A.trustOf.set(ch, "full");
    const { path } = makeFile(A, "a.txt");
    const t = await A.s.request(ch, { path, initiatedBy: "peer-agent", reason: "they asked" });
    assert.equal(t.state, "offered");
    assert.ok(!A.notes.some((n) => n.includes("waiting for approval")));
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
  });

  it("outgoing approval: deny deletes the staged copy and tells nobody", async () => {
    const { A, B, ch, bus } = await setup();
    const { path } = makeFile(A, "a.txt");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    assert.equal(t.state, "awaiting_approval");
    assert.equal(existsSync(t.path!), true);
    const d = A.s.deny(t.tid);
    assert.equal(d.state, "denied");
    assert.equal(existsSync(join(A.dataDir, "outgoing", t.tid)), false);
    await sleep(20);
    assert.equal(bus.log.length, 0);
    assert.equal(B.s.list().length, 0);
  });

  it("peer-agent requests always need approval", async () => {
    const { A, ch } = await setup({ a: noApproval });
    const { path } = makeFile(A, "a.txt");
    const t = await A.s.request(ch, { path, initiatedBy: "peer-agent", reason: "please" });
    assert.equal(t.state, "awaiting_approval");
    assert.ok(A.notes.some((n) => n.includes("the peer's agent")));
  });

  it("request validation", async () => {
    const { A, ch } = await setup();
    const { path } = makeFile(A, "a.txt");
    const bad = (e: unknown) => e instanceof TransferError && e.code === "bad_request";
    await assert.rejects(A.s.request(ch, { path: "relative.txt", initiatedBy: "owner" }), bad);
    await assert.rejects(A.s.request(ch, { path: join(A.dir, "src"), initiatedBy: "owner" }), bad);
    const link = join(A.dir, "dirlink");
    symlinkSync(join(A.dir, "src"), link);
    await assert.rejects(A.s.request(ch, { path: link, initiatedBy: "owner" }), bad);
    await assert.rejects(A.s.request(ch, { path: join(A.dir, "missing"), initiatedBy: "owner" }), bad);
    await assert.rejects(A.s.request(ch, { path, to: generateIdentity().id, initiatedBy: "owner" }), bad);
    // group with two peers needs `to`
    A.peersOf.set(ch, [...A.peersOf.get(ch)!, generateIdentity().id]);
    await assert.rejects(A.s.request(ch, { path, initiatedBy: "owner" }), /required in group/);
    const ok = await A.s.request(ch, { path, to: A.peersOf.get(ch)![1], initiatedBy: "owner" });
    assert.equal(ok.peer, A.peersOf.get(ch)![1]);
    // a symlink to a regular file is fine
    const flink = join(A.dir, "filelink");
    symlinkSync(path, flink);
    const t2 = await A.s.request(ch, { path: flink, to: A.peersOf.get(ch)![0], initiatedBy: "owner" });
    assert.equal(t2.name, "filelink");
  });

  it("incoming approval (auto-accept off): accept", async () => {
    const { A, B, ch } = await setup({ a: noApproval, b: { policy: { autoAcceptIncomingFiles: false } } });
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => B.state(t.tid) === "offered", "offer at B");
    assert.ok(B.notes.some((n) => n.toLowerCase().includes("incoming file waiting for approval")));
    await sleep(20);
    assert.equal(A.state(t.tid), "offered");
    assert.equal(B.s.accept(t.tid).state, "accepted");
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
  });

  it("incoming approval: decline", async () => {
    const { A, B, ch } = await setup({ a: noApproval, b: { policy: { autoAcceptIncomingFiles: false } } });
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => B.state(t.tid) === "offered", "offer at B");
    assert.equal(B.s.decline(t.tid).state, "declined");
    await waitFor(() => A.state(t.tid) === "declined", "declined at A");
    assert.equal(existsSync(join(A.dataDir, "outgoing", t.tid)), false);
    assert.throws(() => B.s.accept(t.tid), TransferError);
  });

  it("files above maxIncomingFileBytes wait for approval even with auto-accept", async () => {
    const { A, B, ch } = await setup({ a: noApproval, b: { policy: { maxIncomingFileBytes: 1000 } } });
    const { path } = makeFile(A, "big.bin", 2000);
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => B.state(t.tid) === "offered", "offer at B");
    await sleep(20);
    assert.equal(B.state(t.tid), "offered");
    assert.ok(B.notes.some((n) => n.includes("auto-accept limit")));
  });

  it("sha256 mismatch → failed on both sides, nothing quarantined", async () => {
    const { A, B, ch, bus } = await setup({ a: noApproval });
    fake.corruptNext = 1;
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "failed" && B.state(t.tid) === "failed", "failure");
    assert.match(B.s.get(t.tid)!.error!, /sha256/);
    assert.match(A.s.get(t.tid)!.error!, /sha256 mismatch/);
    assert.equal(existsSync(join(B.dataDir, "quarantine", t.tid)), false);
    assert.equal(existsSync(join(B.dataDir, "incoming", t.tid)), false);
    assert.equal(existsSync(join(A.dataDir, "outgoing", t.tid)), false);
    const ack = bus.log.find((d) => d.body.type === "file_ack")!.body as Extract<FileBody, { type: "file_ack" }>;
    assert.equal(ack.ok, false);
  });

  it("croc failures are retried with a new attempt, then succeed", async () => {
    const { A, B, ch, bus } = await setup({ a: noApproval });
    fake.failNext = 2;
    const { path, data } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
    assert.equal(A.s.get(t.tid)!.attempt, 3);
    assert.equal(B.s.get(t.tid)!.attempt, 3);
    assert.equal(sha(readFileSync(B.s.get(t.tid)!.path!)), sha(data));
    const readies = bus.log.filter((d) => d.body.type === "file_ready").map((d) => (d.body as { attempt: number }).attempt);
    assert.deepEqual(readies, [1, 2, 3]);
  });

  it("gives up after maxTransferAttempts → failed + file_cancel", async () => {
    const { A, B, ch, bus } = await setup({ a: { policy: { requireApprovalForOutgoingFiles: false, maxTransferAttempts: 3 } } });
    fake.failNext = 100;
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "failed" && B.state(t.tid) === "cancelled", "give up");
    assert.equal(A.s.get(t.tid)!.attempt, 3);
    assert.match(A.s.get(t.tid)!.error!, /gave up after 3 attempts/);
    assert.equal(bus.types(A).filter((x) => x === "file_ready").length, 3);
    assert.equal(bus.types(A).at(-1), "file_cancel");
    assert.equal(fake.spawned.filter((s) => s.kind === "send").length, 3);
  });

  it("expiry: sweeper expires the transfer and file_cancel reaches the peer", async () => {
    const { A, B, ch } = await setup({ a: noApproval, b: { policy: { autoAcceptIncomingFiles: false } } });
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => B.state(t.tid) === "offered", "offer at B");
    A.clock.offset = 25 * 3600_000; // only A's clock jumps, so B learns about it through file_cancel
    await waitFor(() => A.state(t.tid) === "expired", "expired at A");
    await waitFor(() => B.state(t.tid) === "cancelled", "cancelled at B");
    assert.match(B.s.get(t.tid)!.error!, /expired/);
    assert.equal(existsSync(join(A.dataDir, "outgoing", t.tid)), false);
  });

  it("expiry of an unapproved transfer sends nothing (peer never knew)", async () => {
    const { A, ch, bus } = await setup();
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    A.clock.offset = 25 * 3600_000;
    await waitFor(() => A.state(t.tid) === "expired", "expired");
    await sleep(20);
    assert.equal(bus.log.length, 0);
    assert.equal(existsSync(join(A.dataDir, "outgoing", t.tid)), false);
  });

  it("cancel by the sender mid-transfer", async () => {
    const { A, B, ch } = await setup({ a: noApproval });
    fake.hold = true;
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "sending" && B.state(t.tid) === "receiving", "in flight");
    assert.equal(fake.active(), 2);
    assert.equal(A.s.cancel(t.tid).state, "cancelled");
    await waitFor(() => B.state(t.tid) === "cancelled", "cancelled at B");
    await waitFor(() => fake.active() === 0, "croc killed");
    assert.equal(existsSync(join(B.dataDir, "incoming", t.tid)), false);
    assert.equal(existsSync(join(A.dataDir, "outgoing", t.tid)), false);
    assert.throws(() => A.s.cancel(t.tid), TransferError);
  });

  it("cancel by the recipient mid-transfer", async () => {
    const { A, B, ch } = await setup({ a: noApproval });
    fake.hold = true;
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "sending" && B.state(t.tid) === "receiving", "in flight");
    B.s.cancel(t.tid);
    await waitFor(() => A.state(t.tid) === "cancelled", "cancelled at A");
    await waitFor(() => fake.active() === 0, "croc killed");
    fake.release();
    await sleep(20);
    assert.equal(A.state(t.tid), "cancelled");
    assert.equal(B.state(t.tid), "cancelled");
  });

  it("duplicate and out-of-order events are ignored", async () => {
    const { A, B, ch, bus } = await setup({ a: noApproval });
    bus.filter = () => "dup";
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
    await sleep(30);
    assert.equal(A.s.get(t.tid)!.attempt, 1);
    assert.equal(fake.spawned.filter((s) => s.kind === "send").length, 1);
    assert.equal(fake.spawned.filter((s) => s.kind === "receive").length, 1);
    assert.equal(B.s.list().length, 1);
    bus.filter = undefined;

    // stale / out-of-order bodies after completion change nothing
    const toB = { tid: t.tid, to: B.id.id };
    const toA = { tid: t.tid, to: A.id.id };
    await B.s.onBody(ch, A.id.id, { type: "file_ready", ...toB, attempt: 1 });
    await B.s.onBody(ch, A.id.id, { type: "file_cancel", ...toB, reason: "late" });
    await A.s.onBody(ch, B.id.id, { type: "file_retry", ...toA, attempt: 1 });
    await A.s.onBody(ch, B.id.id, { type: "file_ack", ...toA, ok: false, reason: "late" });
    await A.s.onBody(ch, B.id.id, { type: "file_decline", ...toA });
    assert.equal(A.state(t.tid), "completed");
    assert.equal(B.state(t.tid), "completed");

    // out of order on a fresh transfer: ack/ready before accept
    const t2 = await A.s.request(ch, { path, initiatedBy: "owner" });
    bus.filter = (d) => (d.body.type === "file_accept" ? "drop" : undefined);
    await waitFor(() => B.state(t2.tid) === "accepted", "accepted at B");
    await A.s.onBody(ch, B.id.id, { type: "file_ack", tid: t2.tid, to: A.id.id, ok: true });
    await A.s.onBody(ch, B.id.id, { type: "file_retry", tid: t2.tid, to: A.id.id, attempt: 1 });
    assert.equal(A.state(t2.tid), "offered");
    // a ready for an attempt we are not on is ignored once newer ones were seen
    await B.s.onBody(ch, A.id.id, { type: "file_ready", tid: t2.tid, to: B.id.id, attempt: 2 });
    await waitFor(() => B.state(t2.tid) === "receiving", "receiving");
    await B.s.onBody(ch, A.id.id, { type: "file_ready", tid: t2.tid, to: B.id.id, attempt: 1 });
    assert.equal(B.s.get(t2.tid)!.attempt, 2);
    A.s.cancel(t2.tid);
    await waitFor(() => B.state(t2.tid) === "cancelled", "cancelled");
  });

  it("file_* from a non-peer identity is ignored", async () => {
    const { A, B, ch, bus } = await setup({ a: noApproval, b: { policy: { autoAcceptIncomingFiles: false } } });
    const mallory = generateIdentity();
    // offer from a non-member
    const bogusTid = randomId();
    await B.s.onBody(ch, mallory.id, {
      type: "file_offer",
      tid: bogusTid,
      to: B.id.id,
      name: "evil.exe",
      size: 10,
      sha256: "0".repeat(64),
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(B.s.get(bogusTid), undefined);
    // offer addressed to someone else
    await B.s.onBody(ch, A.id.id, {
      type: "file_offer",
      tid: bogusTid,
      to: mallory.id,
      name: "x",
      size: 10,
      sha256: "0".repeat(64),
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(B.s.get(bogusTid), undefined);

    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => B.state(t.tid) === "offered", "offer at B");
    // mallory tries to cancel / accept / ack on someone else's transfer
    await B.s.onBody(ch, mallory.id, { type: "file_cancel", tid: t.tid, to: B.id.id, reason: "x" });
    await A.s.onBody(ch, mallory.id, { type: "file_cancel", tid: t.tid, to: A.id.id, reason: "x" });
    await A.s.onBody(ch, mallory.id, { type: "file_accept", tid: t.tid, to: A.id.id, sealed: "AAAA" });
    await A.s.onBody(ch, mallory.id, { type: "file_decline", tid: t.tid, to: A.id.id });
    // right peer, wrong channel
    await A.s.onBody(randomId(), B.id.id, { type: "file_decline", tid: t.tid, to: A.id.id });
    assert.equal(A.state(t.tid), "offered");
    assert.equal(B.state(t.tid), "offered");
    // the real peer can still proceed
    B.s.accept(t.tid);
    await waitFor(() => A.state(t.tid) === "completed", "completed");
    assert.equal(bus.log.filter((d) => d.from === mallory.id).length, 0);
  });

  it("an accept with an undecryptable sealed code fails the transfer cleanly", async () => {
    const { A, B, ch } = await setup({ a: noApproval, b: { policy: { autoAcceptIncomingFiles: false } } });
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => B.state(t.tid) === "offered", "offer at B");
    await A.s.onBody(ch, B.id.id, { type: "file_accept", tid: t.tid, to: A.id.id, sealed: "A".repeat(80) });
    assert.equal(A.state(t.tid), "failed");
    await waitFor(() => B.state(t.tid) === "cancelled", "cancelled at B");
  });

  it("no croc relay info: keeps state, sets error, retries later", async () => {
    let available = false;
    const info = () => (available ? { relay: "fake-relay:9009", pass: "fake-pass" } : undefined);
    const { A, B, ch } = await setup({ a: { ...noApproval, crocInfo: info }, b: { crocInfo: info } });
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "sending" && !!A.s.get(t.tid)!.error, "error set");
    assert.match(A.s.get(t.tid)!.error!, /no croc relay/);
    await sleep(50);
    assert.equal(A.state(t.tid), "sending");
    available = true;
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
    assert.equal(A.s.get(t.tid)!.error, undefined);
  });

  it("wrong relay password on one side fails cleanly after max attempts", async () => {
    const { A, B, ch } = await setup({
      a: { policy: { requireApprovalForOutgoingFiles: false, maxTransferAttempts: 2 } },
    });
    fake.passwords.set("fake-relay:9009", "fake-pass");
    B.info = { relay: "fake-relay:9009", pass: "wrong" };
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "failed" && B.state(t.tid) === "cancelled", "failure");
    assert.match(A.s.get(t.tid)!.error!, /gave up/);
    assert.match(B.s.get(t.tid)!.error!, /cancelled by peer/);
  });

  it("crash/restart: sender restarts mid-sending and the transfer completes", async () => {
    const { A, B, ch, bus } = await setup({ a: noApproval });
    fake.hold = true;
    const { path, data } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "sending" && B.state(t.tid) === "receiving", "in flight");
    await A.stop(); // kills A's croc; B's receive fails and asks for a retry while A is down
    await waitFor(() => A.queue.some((d) => d.body.type === "file_retry"), "retry queued for A");
    fake.hold = false;
    await A.start();
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
    assert.equal(A.s.get(t.tid)!.attempt, 2);
    assert.equal(sha(readFileSync(B.s.get(t.tid)!.path!)), sha(data));
    // the stale retry for attempt 1 did not cause a third attempt
    assert.equal(bus.log.filter((d) => d.body.type === "file_ready").length, 2);
  });

  it("crash/restart: recipient restarts mid-receiving and the transfer completes", async () => {
    const { A, B, ch } = await setup({ a: noApproval });
    fake.hold = true;
    const { path, data } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "sending" && B.state(t.tid) === "receiving", "in flight");
    await B.stop();
    fake.hold = false;
    await B.start(); // no complete file → file_retry → A re-spawns with attempt 2
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
    assert.equal(B.s.get(t.tid)!.attempt, 2);
    assert.equal(sha(readFileSync(B.s.get(t.tid)!.path!)), sha(data));
  });

  it("crash/restart: recipient dies after croc wrote the file but before verifying", async () => {
    const { A, B, ch, bus } = await setup({ a: noApproval });
    fake.hangAfterWrite = true;
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => fake.transfers === 1, "bytes written");
    assert.equal(B.state(t.tid), "receiving");
    await B.stop();
    fake.hangAfterWrite = false;
    await B.start(); // finds the complete file, verifies, acks
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
    assert.equal(B.s.get(t.tid)!.attempt, 1);
    assert.equal(bus.log.filter((d) => d.body.type === "file_retry").length, 0);
  });

  it("restart while waiting (accepted / awaiting_approval) just waits; orphan staging dirs are removed", async () => {
    const { A, B, ch } = await setup({ b: { policy: { autoAcceptIncomingFiles: false } } });
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    mkdirSync(join(A.dataDir, "outgoing", "orphan"), { recursive: true });
    await A.restart();
    assert.equal(A.state(t.tid), "awaiting_approval");
    assert.deepEqual(readdirSync(join(A.dataDir, "outgoing")), [t.tid]);
    A.s.approve(t.tid);
    await waitFor(() => B.state(t.tid) === "offered", "offer");
    B.s.accept(t.tid);
    await B.restart();
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
  });

  it("events are emitted for every state change", async () => {
    const { A, B, ch } = await setup({ a: noApproval });
    const { path } = makeFile(A, "x.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completion");
    const states = (n: TNode) => [...new Set(n.events.filter((e) => e.tid === t.tid).map((e) => e.state))];
    assert.deepEqual(states(A), ["offered", "sending", "completed"]);
    assert.deepEqual(states(B), ["accepted", "receiving", "completed"]);
    assert.equal(B.events.at(-1)!.peerName, "alice");
  });
});


it("migrates existing transfer tables without losing rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE transfers (tid TEXT PRIMARY KEY, ch TEXT NOT NULL, direction TEXT NOT NULL, peer TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL, code TEXT, initiated_by TEXT NOT NULL, reason TEXT, error TEXT, path TEXT, peer_knows INTEGER NOT NULL, next_attempt_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO transfers VALUES ('id','channel','out','peer','file',1,'hash','offered',0,NULL,'owner',NULL,NULL,NULL,1,NULL,1,1,2)`);
    const store = new TransferStore(db);
    assert.equal(store.get("id")?.via, null);
    store.update("id", { via: "link" });
    assert.equal(store.get("id")?.via, "link");
    assert.equal(store.get("id")?.name, "file");
    new TransferStore(db);
  } finally { db.close(); }
});


type LinkMode = "success" | "drop" | "resumed-corrupt" | "corrupt" | "oversize";

async function setupLink(mode: LinkMode, noCroc = false) {
  const hasCroc: boolean[] = [];
  const sources = new Map<number, { path: string; finish: (ok: boolean) => void }>();
  const adapter: TransferP2pAdapter = {
    canTryLink(_ch, _peer, _size, has) { hasCroc.push(has); return true; },
    sendOverLink(o) {
      let finish!: (ok: boolean) => void;
      const done = new Promise<{ ok: boolean }>((resolve) => { finish = (ok) => resolve({ ok }); });
      sources.set(o.attempt, { path: o.filePath, finish });
      setImmediate(() => o.onReady());
      return { done, kill() {} };
    },
    receiveOverLink(o) {
      const done = new Promise<{ ok: boolean; resumedFrom: number; error?: string }>((resolve) => setImmediate(() => {
        const source = sources.get(o.attempt)!;
        if (mode === "resumed-corrupt" && o.attempt === 2) {
          assert.equal(existsSync(o.finalPath), false);
          assert.equal(existsSync(o.partPath), false);
        }
        if (mode === "drop" && o.attempt === 1) {
          writeFileSync(o.partPath, "partial");
          source.finish(false);
          resolve({ ok: false, resumedFrom: 0, error: "dropped" });
        } else if (mode === "oversize") {
          source.finish(true);
          resolve({ ok: false, resumedFrom: 0, error: "sender sent more data than offered" });
        } else {
          const data = readFileSync(source.path);
          if ((mode === "resumed-corrupt" && o.attempt === 1) || mode === "corrupt") data[0] ^= 255;
          writeFileSync(o.finalPath, data);
          o.onProgress(1);
          source.finish(true);
          resolve({ ok: true, resumedFrom: mode === "resumed-corrupt" && o.attempt === 1 ? 10 : 0 });
        }
      }));
      return { done, kill() {} };
    },
  };
  const p = await setup({ a: noApproval });
  for (const node of [p.A, p.B]) {
    await node.stop();
    node.start = async () => {
      node.db = new DatabaseSync(node.dbPath);
      node.svc = createTransferService({
        db: node.db, dataDir: node.dataDir, me: node.id, p2p: adapter,
        policy: () => node.policy, trust: () => "standard",
        enqueue: (ch, body) => { node.enqueued.push(body); p.bus.send(node.id.id, ch, body); },
        crocInfo: () => noCroc ? undefined : node.info,
        pairKey: (ch, peer) => pairKey(node.id.secret, peer, node.id.id, ch),
        peers: (ch) => node.peersOf.get(ch) ?? [], peerName: (_ch, peer) => p.bus.nodes.get(peer)?.name,
        crocPath: "/nonexistent/croc", events: { emit: (e) => { if (e.type === "transfer") node.events.push(e.transfer); } },
        ownerNote: (note) => node.notes.push(note), now: () => node.now(),
      }, { runner: fake, backoffMs: () => 5, sweepIntervalMs: 20, watchdogMs: 20 });
      await node.svc.start();
    };
    await node.start();
  }
  return { ...p, hasCroc };
}

for (const group of [false, true]) {
  it(`direct link completes in ${group ? "group" : "direct"} channel`, async () => {
    const { A, B, ch, bus } = await setupLink("success");
    if (group) {
      const third = generateIdentity().id;
      A.peersOf.set(ch, [B.id.id, third]);
      B.peersOf.set(ch, [A.id.id, third]);
    }
    const { path, data } = makeFile(A, "link.bin");
    const t = await A.s.request(ch, { path, to: B.id.id, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "link completed");
    assert.equal(A.s.get(t.tid)?.via, "link"); assert.equal(B.s.get(t.tid)?.via, "link");
    assert.equal(sha(readFileSync(B.s.get(t.tid)!.path!)), sha(data));
    assert.ok(bus.log.some((d) => d.body.type === "file_ready" && d.body.via === "link"));
    assert.ok(bus.log.some((d) => d.body.type === "file_ack" && d.body.ok));
    assert.equal(fake.spawned.length, 0);
  });
}

it("resumed corrupt link retries from zero", async () => {
  const { A, B, ch, bus } = await setupLink("resumed-corrupt");
  const { path, data } = makeFile(A, "link.bin");
  const t = await A.s.request(ch, { path, initiatedBy: "owner" });
  await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "retry completed");
  assert.equal(A.s.get(t.tid)?.attempt, 2);
  assert.ok(bus.log.some((d) => d.body.type === "file_retry"));
  assert.equal(B.events.some((e) => e.state === "failed"), false);
  assert.equal(sha(readFileSync(B.s.get(t.tid)!.path!)), sha(data));
  assert.equal(fake.spawned.length, 0);
});

for (const mode of ["corrupt", "oversize"] as const) {
  it(`link ${mode} fails terminally`, async () => {
    const { A, B, ch, bus } = await setupLink(mode);
    const { path } = makeFile(A, "link.bin");
    const t = await A.s.request(ch, { path, initiatedBy: "owner" });
    await waitFor(() => A.state(t.tid) === "failed" && B.state(t.tid) === "failed", "failed");
    const ack = bus.log.find((d) => d.body.type === "file_ack")?.body;
    assert.ok(ack?.type === "file_ack" && !ack.ok);
    if (mode === "oversize") assert.equal(ack.reason, "size exceeds offer");
  });
}

it("chat-only relay transfers a small file over link", async () => {
  const { A, B, ch, hasCroc } = await setupLink("success", true);
  const { path, data } = makeFile(A, "small.bin", 1024);
  const t = await A.s.request(ch, { path, initiatedBy: "owner" });
  await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "completed");
  assert.deepEqual(hasCroc, [false]);
  assert.equal(B.s.get(t.tid)?.via, "link");
  assert.equal(sha(readFileSync(B.s.get(t.tid)!.path!)), sha(data));
});


it("link failure falls back to croc after deleting partial file", async () => {
  const { A, B, ch, bus } = await setupLink("drop");
  const receive = fake.receive.bind(fake);
  let checked = false;
  fake.receive = (opts) => {
    assert.equal(readdirSync(opts.outDir).some((name) => name.endsWith(".part")), false);
    checked = true;
    return receive(opts);
  };
  const { path, data } = makeFile(A, "link.bin");
  const t = await A.s.request(ch, { path, initiatedBy: "owner" });
  await waitFor(() => A.state(t.tid) === "completed" && B.state(t.tid) === "completed", "croc fallback");
  assert.equal(checked, true);
  assert.equal(A.s.get(t.tid)?.attempt, 2);
  assert.equal(A.s.get(t.tid)?.via, "croc"); assert.equal(B.s.get(t.tid)?.via, "croc");
  assert.ok(bus.log.some((d) => d.body.type === "file_ready" && d.body.attempt === 1 && d.body.via === "link"));
  assert.equal(sha(readFileSync(B.s.get(t.tid)!.path!)), sha(data));
});
