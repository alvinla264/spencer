import { LinkManager, createTransferP2pAdapter, type LinkManagerTuning } from "./p2p/index.ts";
import { getP2pAddonStatus } from "./p2p/addon.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  MAX_CHAT_TEXT,
  P2P_FILES_FEATURE,
  fingerprint,
  isB64uId,
  isEnvelope,
  isLinkBody,
  openEnvelope,
  pairKey,
  sealEnvelope,
  type Body,
  type ChatBody,
  type StatusBody,
  type CrocInfo,
  type Identity,
  type ServerFrame,
} from "@spencer/protocol";
import { loadConfig, resolveConfig, type ModelConfig, type SpencerConfig } from "./config.ts";
import type {
  AgentService,
  Channel,
  CoreServices,
  IncomingChat,
  MessageOrigin,
  TransferDeps,
  TransferService,
} from "./contracts.ts";
import { EventBus } from "./events.ts";
import { openDb, Sql } from "./store/db.ts";
import { acquireLock, type DataDirLock } from "./store/lock.ts";
import { loadOrCreateIdentity, loadOrCreateToken } from "./store/files.ts";
import { RelayPool, type RelayConnection, type RelayTuning } from "./net/relay-client.ts";
import { Outbox } from "./net/outbox.ts";
import { Inbox, type StoredMessage } from "./net/inbox.ts";
import { ChannelManager, UserError } from "./channels.ts";
import { ApiServer } from "./api/http.ts";
import { OwnerAttachmentStore } from "./api/owner-attachments.ts";
import { embedded } from "./sea.ts";

/** Incoming working-status updates older than this are a catch-up after being offline: dropped. */
const STATUS_MAX_AGE_MS = 120_000;

export interface DaemonTuning {
  relay?: Partial<RelayTuning>;
  p2p?: LinkManagerTuning;
  outboxMinBackoffMs?: number;
  outboxMaxBackoffMs?: number;
  inboxRetryMs?: number;
}

export interface DaemonOptions {
  dataDir: string;
  /** Merged over `<dataDir>/config.json` (via resolveConfig). */
  config?: Partial<SpencerConfig>;
  agentFactory?: (core: CoreServices) => AgentService | Promise<AgentService>;
  transferFactory?: (deps: TransferDeps) => TransferService | Promise<TransferService>;
  log?: (msg: string) => void;
  /** Static UI dir. Default: `@spencer/web` webRoot if installed. `null` = placeholder page. */
  webRoot?: string | null;
  tuning?: DaemonTuning;
}

async function defaultAgentFactory(core: CoreServices): Promise<AgentService> {
  // Literal specifiers so a bundler (scripts/build-binary.mjs) can follow them; still loaded lazily.
  const mod = (await import("./agent/index.ts")) as { createAgent(core: CoreServices): AgentService | Promise<AgentService> };
  return mod.createAgent(core);
}

async function defaultTransferFactory(deps: TransferDeps): Promise<TransferService> {
  const mod = (await import("./transfers/index.ts")) as { createTransferService(deps: TransferDeps): TransferService | Promise<TransferService> };
  return mod.createTransferService(deps);
}

async function defaultWebRoot(log: (m: string) => void): Promise<string | undefined> {
  const bin = embedded();
  if (bin) return bin.webRoot;
  const spec = "@spencer/web";
  try {
    const mod = (await import(spec)) as { webRoot?: unknown };
    if (typeof mod.webRoot === "string" && existsSync(mod.webRoot)) return mod.webRoot;
  } catch {
    /* not installed yet */
  }
  log("web UI not found; serving a placeholder page");
  return undefined;
}

/** `<dataDir>/config.json` (created with defaults if missing) with `override` merged over it. */
export function loadMergedConfig(dataDir: string, override: Partial<SpencerConfig> = {}): SpencerConfig {
  const file = join(dataDir, "config.json");
  if (!existsSync(file)) loadConfig(dataDir);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<SpencerConfig> & Record<string, unknown>;
  const merged = {
    ...raw,
    ...override,
    http: { ...(raw.http ?? {}), ...(override.http ?? {}) },
    croc: { ...(raw.croc ?? {}), ...(override.croc ?? {}) },
    policy: { ...(raw.policy ?? {}), ...(override.policy ?? {}) },
    p2p: { ...(raw.p2p ?? {}), ...(override.p2p ?? {}) },
  } as Partial<SpencerConfig> & Record<string, unknown>;
  return resolveConfig(merged);
}

type Started = {
  lock: DataDirLock;
  cfg: SpencerConfig;
  db: DatabaseSync;
  sql: Sql;
  me: Identity;
  token: string;
  pool: RelayPool;
  channels: ChannelManager;
  outbox: Outbox;
  inbox: Inbox;
  core: CoreServices;
  links?: LinkManager;
  p2pAdapter?: ReturnType<typeof createTransferP2pAdapter>;
  transfers?: TransferService;
  agent?: AgentService;
  api?: ApiServer;
};

export class Daemon {
  readonly dataDir: string;
  readonly events: EventBus;
  private opts: DaemonOptions;
  private log: (m: string) => void;
  private s: Partial<Started> = {};
  private state: "new" | "starting" | "running" | "stopping" | "stopped" = "new";

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.dataDir = opts.dataDir;
    this.log = opts.log ?? ((m: string) => console.error(`[spencer] ${m}`));
    this.events = new EventBus(this.log);
  }

  // ------------------------------------------------------------- accessors

  private need<K extends keyof Started>(k: K): NonNullable<Started[K]> {
    const v = this.s[k];
    if (v === undefined || v === null) throw new Error(`daemon not started (${String(k)})`);
    return v as NonNullable<Started[K]>;
  }

  get links(): LinkManager | undefined { return this.s.links; }

  get running(): boolean {
    return this.state === "running";
  }
  get port(): number {
    return this.need("api").port;
  }
  get token(): string {
    return this.need("token");
  }
  get identity(): { id: string; name: string; fingerprint: string } {
    const me = this.need("me");
    return { id: me.id, name: this.need("cfg").name, fingerprint: fingerprint(me.id) };
  }
  get config(): SpencerConfig {
    return this.need("cfg");
  }
  get core(): CoreServices {
    return this.need("core");
  }
  get db(): DatabaseSync {
    return this.need("db");
  }
  get channels(): ChannelManager {
    return this.need("channels");
  }
  get outbox(): Outbox {
    return this.need("outbox");
  }
  get agent(): AgentService {
    return this.need("agent");
  }
  get transfers(): TransferService {
    return this.need("transfers");
  }
  get pool(): RelayPool {
    return this.need("pool");
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  // ------------------------------------------------------------- convenience (tests, CLI)

  createInvite(kind: "direct" | "group", name: string, relay?: string): Promise<{ link: string; channel: Channel }> {
    return this.channels.createInvite(kind, name, relay);
  }
  acceptInvite(link: string): Promise<Channel> {
    return this.channels.acceptInvite(link);
  }
  /** Owner speaks in a channel (hop 0, by human). */
  sendHuman(ch: string, text: string, mentions?: string[]): { id: string } {
    return this.core.sendChat(ch, { text, hop: 0, by: "human", origin: "human", ...(mentions ? { mentions } : {}) });
  }
  leave(ch: string): Promise<void> {
    this.s.links?.closeChannel(ch, "left channel");
    return this.channels.leave(ch);
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.state !== "new" && this.state !== "stopped") throw new Error(`cannot start a ${this.state} daemon`);
    this.state = "starting";
    this.s = {};
    try {
      await this.doStart();
      this.state = "running";
    } catch (e) {
      await this.teardown();
      this.state = "stopped";
      throw e;
    }
  }

  private async doStart(): Promise<void> {
    const dir = this.dataDir;
    const log = this.log;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
    const s = this.s;
    s.lock = acquireLock(dir);
    const cfg = (s.cfg = loadMergedConfig(dir, this.opts.config));
    s.db = openDb(dir);
    const sql = (s.sql = new Sql(s.db));
    const me = (s.me = loadOrCreateIdentity(dir));
    s.token = loadOrCreateToken(dir);
    const tuning = this.opts.tuning ?? {};

    const channelChanged = (ch: string) => {
      const a = this.s.agent;
      if (a) a.channelChanged(ch).catch((e: Error) => log(`agent.channelChanged(${ch}): ${e.message}`));
    };

    s.pool = new RelayPool(
      me,
      {
        onWake: () => this.s.links?.onWake(),
        onReady: (conn) => this.onRelayReady(conn),
        onDown: (conn) => this.s.channels?.relayChanged(conn.url, false),
        onState: (conn) => this.events.emit({ type: "relay", ...conn.status() }),
        onFrame: (conn, f) => this.onRelayFrame(conn, f),
      },
      log,
      tuning.relay,
    );
    const channels = (s.channels = new ChannelManager({
      sql,
      me,
      config: () => this.need("cfg"),
      pool: () => this.need("pool"),
      outbox: () => this.need("outbox"),
      events: this.events,
      log,
      channelChanged,
      localFeatures: () => this.need("cfg").p2p.mode === "files" && this.s.links?.status().available ? [P2P_FILES_FEATURE] : [],
    }));
    s.outbox = new Outbox({
      sql,
      me,
      log,
      channelInfo: (ch) => channels.info(ch),
      connection: (url) => this.s.pool?.peek(url),
      messageChanged: (id) => {
        const m = channels.message(id);
        if (m && m.origin !== "feature-hello") this.events.emit({ type: "message", ch: m.ch, message: m });
      },
      ...(tuning.outboxMinBackoffMs !== undefined ? { minBackoffMs: tuning.outboxMinBackoffMs } : {}),
      ...(tuning.outboxMaxBackoffMs !== undefined ? { maxBackoffMs: tuning.outboxMaxBackoffMs } : {}),
    });
    s.inbox = new Inbox({
      sql,
      me,
      log,
      channelInfo: (ch) => channels.info(ch),
      route: (msg, body) => this.route(msg, body),
      routed: (msg, body) => {
        if (body.type === "chat" || body.type === "hello") {
          const m = channels.message(msg.id);
          if (m && m.origin !== "feature-hello") this.events.emit({ type: "message", ch: msg.ch, message: m });
          if (body.type === "chat") channels.emitChannel(msg.ch); // unread changed
        }
      },
      ack: (url, ch, seq) => {
        this.s.pool?.peek(url)?.send({ t: "ack", ch, seq });
      },
      ...(tuning.inboxRetryMs !== undefined ? { retryMs: tuning.inboxRetryMs } : {}),
    });
    s.core = this.buildCore();

    const eligible = (ch: string, peerId: string) => {
      const info = channels.info(ch);
      const conn = info && s.pool?.peek(info.relayUrl);
      return cfg.p2p.mode === "files" && !!channels.row(ch) && channels.peers(ch).includes(peerId) && channels.directLinkConfig(ch)?.directLink !== "off" && channels.peerHasFeature(ch, peerId, P2P_FILES_FEATURE) && !!conn?.ready && conn.features.includes("ephemeral");
    };
    const linkNotes: Array<{ text: string; options?: { untrusted?: boolean } }> = [];
    s.links = new LinkManager({
      dataDir: dir, me, log, tuning: tuning.p2p,
      sendSignal: (ch, body) => { const info = channels.info(ch); const conn = info && s.pool?.peek(info.relayUrl); if (info && conn?.ready && conn.features.includes("ephemeral")) conn.request({ t: "send", env: sealEnvelope(me, ch, info.encKey, body), ephemeral: true }).catch(() => {}); },
      pairKey: (ch, peerId) => pairKey(me.secret, peerId, me.id, ch),
      authorize: (ch, peerId) => ({ ok: eligible(ch, peerId), allowLocalAddresses: !cfg.p2p.hideLocalAddresses || !!channels.directLinkConfig(ch)?.allowLocalAddresses, stunServers: [...(channels.stunFor(ch) ? [channels.stunFor(ch)!] : []), ...cfg.p2p.stun] }),
      onFileChannel: (ch, peerId, label, dc) => s.p2pAdapter?.onIncomingFileChannel(ch, peerId, label, dc),
      ownerNote: (text, options) => { const agent = this.s.agent; if (agent) void agent.ownerNote(text, options).catch(e => log(`agent.ownerNote: ${e.message}`)); else linkNotes.push({ text, options }); },
    });
    s.p2pAdapter = createTransferP2pAdapter({ links: s.links, canUseLink: (ch, peerId, size, hasCroc) => eligible(ch, peerId) && !!s.links?.status().available && !s.links.isCrashDisabled(ch) && (!hasCroc || size >= cfg.p2p.minFileBytes) });
    s.links.start();
    const tdeps = this.buildTransferDeps();
    s.transfers = await (this.opts.transferFactory ?? defaultTransferFactory)(tdeps);
    await s.transfers.start();
    s.agent = await (this.opts.agentFactory ?? defaultAgentFactory)(s.core);
    await s.agent.start();
    for (const note of linkNotes) await s.agent.ownerNote(note.text, note.options);

    await s.inbox.rerouteUnrouted();

    for (const url of channels.relayUrls()) s.pool.get(url);
    s.outbox.kick();

    const webRoot = this.opts.webRoot === null ? undefined : (this.opts.webRoot ?? (await defaultWebRoot(log)));
    s.api = new ApiServer({
      token: s.token,
      log,
      events: this.events,
      core: s.core,
      agent: () => this.need("agent"),
      transfers: () => this.need("transfers"),
      ownerAttachments: new OwnerAttachmentStore(this.need("db"), this.dataDir),
      state: () => this.apiState(),
      channelMessages: (ch, limit, before) => {
        const items = channels.messages(ch, limit, before, ["chat", "hello"]);
        if (!before) channels.markRead(ch);
        return items;
      },
      updateChannel: (ch, patch) => {
        const updated = channels.update(ch, patch);
        if (updated.directLink === "off") this.s.links?.closeChannel(ch, "direct links disabled");
        return updated;
      },
      leaveChannel: (ch) => this.leave(ch),
      acceptInvite: (link) => channels.acceptInvite(link),
      ...(webRoot ? { webRoot } : {}),
    });
    await s.api.listen(cfg.http.port);
  }

  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "new") return;
    if (this.state === "stopping") throw new Error("already stopping");
    this.state = "stopping";
    await this.teardown();
    this.state = "stopped";
  }

  /** Reverse of start; tolerant of partially started state. */
  private async teardown(): Promise<void> {
    const s = this.s;
    const step = async (name: string, fn: () => unknown) => {
      try {
        await fn();
      } catch (e) {
        this.log(`stop ${name}: ${(e as Error).message}`);
      }
    };
    if (s.api) await step("api", () => s.api!.close());
    if (s.pool) await step("relays", () => s.pool!.stop());
    if (s.outbox) await step("outbox", () => s.outbox!.stop());
    if (s.inbox) await step("inbox", () => s.inbox!.stop());
    if (s.agent) await step("agent", () => s.agent!.stop());
    if (s.transfers) await step("transfers", () => s.transfers!.stop());
    if (s.p2pAdapter) await step("p2p adapter", () => s.p2pAdapter!.stop());
    if (s.links) await step("links", () => s.links!.stop());
    if (s.db) await step("db", () => s.db!.close());
    if (s.lock) await step("lock", () => s.lock!.release());
    this.s = {};
  }

  // ------------------------------------------------------------- relay events

  private onRelayReady(conn: RelayConnection): void {
    this.need("channels").setStun(conn.url, conn.stun);
    const channels = this.need("channels");
    channels.setCroc(conn.url, conn.croc);
    channels.relayChanged(conn.url, true);
    const chs = channels.channelsOnRelay(conn.url);
    void Promise.allSettled(chs.map((ch) => channels.subscribe(conn, ch))).then(() => {
      channels.recheckHellos();
      this.s.outbox?.connectionReady(chs);
    });
  }

  private onRelayFrame(conn: RelayConnection, f: ServerFrame): void {
    switch (f.t) {
      case "msg":
        this.s.inbox?.onMsg(conn.url, f);
        return;
      case "member": {
        const channels = this.s.channels;
        const row = channels?.row(f.ch);
        if (channels && row && row.relay_url === conn.url) {
          channels.onMemberEvent(f.ch, f.id, f.event);
          // A member who just joined is connected; a presence relay announced it before it was a member here.
          if (f.event === "joined" && conn.features.includes("presence")) channels.onPresence(conn.url, f.ch, f.id, true, Date.now());
        }
        return;
      }
      case "presence":
        this.s.channels?.onPresence(conn.url, f.ch, f.id, f.online, f.lastSeen);
        return;
      case "eph":
        this.onEphemeral(conn, f.ch, f.env);
        return;
      case "err":
        this.log(`relay ${conn.url}: ${f.code}: ${f.msg}`);
        return;
    }
  }

  /**
   * An `eph` frame (PROTOCOL §4.7): a message the relay pushed without storing. Only `status` bodies travel this way;
   * anything else is ignored. Same checks as the inbox (relay, envelope, signature, membership), nothing is stored.
   */
  private onEphemeral(conn: RelayConnection, ch: unknown, env: unknown): void {
    const channels = this.s.channels;
    if (!channels || typeof ch !== "string") return;
    const row = channels.row(ch);
    const keys = channels.keys(ch);
    if (!row || !keys || row.relay_url !== conn.url) return;
    if (!isEnvelope(env) || env.ch !== ch || env.from === this.need("me").id) return;
    if (!channels.memberRows(ch).some((m) => m.id === env.from && m.present)) return;
    let body: Body;
    try {
      body = openEnvelope(env, keys.encKey);
    } catch (e) {
      this.log(`relay ${conn.url}: dropped ephemeral ${env.id}: ${(e as Error).message}`);
      return;
    }
    if (isLinkBody(body)) { if (body.to === this.need("me").id) void this.s.links?.onSignal(ch, env.from, body); return; }
    if (body.type !== "status" || Date.now() - env.ts >= STATUS_MAX_AGE_MS) return;
    this.events.emit({
      type: "status",
      ch,
      from: env.from,
      replyTo: body.replyTo,
      state: body.state,
      ...(body.activity ? { activity: body.activity } : {}),
      ts: env.ts,
    });
  }

  // ------------------------------------------------------------- routing

  private async route(msg: StoredMessage, body: Body): Promise<void> {
    const channels = this.need("channels");
    switch (body.type) {
      case "hello":
        if (channels.onHello(msg.ch, msg.from_id, body).featureOnly) this.need("sql").run("UPDATE messages SET origin = ? WHERE id = ?", "feature-hello", msg.id);
        return;
      case "chat":
        await this.routeChat(msg, body);
        return;
      case "status":
        // Ephemeral: show it if it is fresh (not a catch-up after being offline), then forget it.
        if (Date.now() - msg.ts < STATUS_MAX_AGE_MS) {
          this.events.emit({
            type: "status",
            ch: msg.ch,
            from: msg.from_id,
            replyTo: body.replyTo,
            state: body.state,
            ...(body.activity ? { activity: body.activity } : {}),
            ts: msg.ts,
          });
        }
        this.need("sql").run("DELETE FROM messages WHERE id = ?", msg.id);
        return;
      default:
        if (isLinkBody(body)) return;
        if (body.to === this.need("me").id) await this.need("transfers").onBody(msg.ch, msg.from_id, body);
    }
  }

  private async routeChat(msg: StoredMessage, body: ChatBody): Promise<void> {
    const channels = this.need("channels");
    const sql = this.need("sql");
    const row = channels.row(msg.ch);
    if (!row) return;
    const incoming: IncomingChat = {
      id: msg.id,
      ch: msg.ch,
      seq: msg.seq ?? 0,
      from: msg.from_id,
      ts: msg.ts,
      body,
      channelKind: row.kind,
      channelName: channels.displayName(row),
    };
    const fromName = channels.peerName(msg.ch, msg.from_id);
    if (fromName) incoming.fromName = fromName;
    if (body.replyTo) {
      const orig = sql.get<{ origin: string | null; body: string }>(
        "SELECT origin, body FROM messages WHERE id = ? AND ch = ? AND mine = 1",
        body.replyTo,
        msg.ch,
      );
      if (orig) {
        if (orig.origin) incoming.replyToOrigin = orig.origin as MessageOrigin;
        try {
          const t = (JSON.parse(orig.body) as { text?: unknown }).text;
          if (typeof t === "string") incoming.replyToText = t;
        } catch {
          /* ignore */
        }
      }
    }
    const res = await this.need("agent").onPeerChat(incoming);
    sql.run("UPDATE messages SET note = ? WHERE id = ?", res?.note ?? null, msg.id);
  }

  // ------------------------------------------------------------- services

  private buildCore(): CoreServices {
    const channels = this.need("channels");
    const outbox = this.need("outbox");
    const log = this.log;
    const daemon = this;
    return {
      db: this.need("db"),
      dataDir: this.dataDir,
      config: () => this.need("cfg"),
      saveModel: (model) => this.saveModel(model),
      me: () => this.identity,
      listChannels: () => channels.list(),
      getChannel: (ch) => channels.get(ch),
      readChannel: (ch, limit) => channels.messages(ch, limit),
      sendChat(ch, msg) {
        if (!channels.row(ch)) throw new UserError(404, `unknown channel ${ch}`);
        if (typeof msg.text !== "string" || msg.text.length === 0) throw new UserError(400, "text is required");
        if (msg.text.length > MAX_CHAT_TEXT) throw new UserError(400, `text too long (max ${MAX_CHAT_TEXT} chars)`);
        if (!Number.isSafeInteger(msg.hop) || msg.hop < 0) throw new UserError(400, "hop must be a non-negative integer");
        if (msg.by !== "human" && msg.by !== "agent") throw new UserError(400, "by must be human or agent");
        if (msg.replyTo !== undefined && !isB64uId(msg.replyTo)) throw new UserError(400, "invalid replyTo");
        if (msg.mentions !== undefined && (msg.mentions.length > 64 || !msg.mentions.every((m) => isB64uId(m, 32)))) {
          throw new UserError(400, "invalid mentions");
        }
        const body: ChatBody = { type: "chat", text: msg.text, hop: msg.hop, by: msg.by };
        if (msg.replyTo !== undefined) body.replyTo = msg.replyTo;
        if (msg.mentions !== undefined && msg.mentions.length > 0) body.mentions = [...new Set(msg.mentions)];
        if (msg.final === true) body.final = true;
        const res = outbox.enqueue(ch, body, {
          origin: msg.origin,
          ...(msg.idempotencyKey !== undefined ? { idempotencyKey: msg.idempotencyKey } : {}),
        });
        if (res.created && (msg.origin === "human" || msg.origin === "owner-agent")) {
          const agent = daemon.s.agent;
          if (agent) {
            const ts = Date.now();
            queueMicrotask(() => {
              agent
                .onOutgoingChat({ id: res.id, ch, text: msg.text, origin: msg.origin, ts })
                .catch((e: Error) => log(`agent.onOutgoingChat: ${e.message}`));
            });
          }
        }
        return { id: res.id };
      },
      requestFileSend: (ch, req) => this.need("transfers").request(ch, req),
      sendStatus(ch, s) {
        try {
          if (!channels.row(ch) || !isB64uId(s.replyTo)) return;
          const activity = s.activity?.slice(0, 200);
          const body: StatusBody = { type: "status", replyTo: s.replyTo, state: s.state, ...(activity ? { activity } : {}) };
          // Ephemeral (PROTOCOL §4.7): not through the durable outbox, and dropped when we are offline. A relay with the
          // "ephemeral" feature pushes it without storing it; an older relay ignores the flag and stores it, and
          // receivers drop it there once it is stale.
          const info = channels.info(ch);
          const conn = info ? daemon.s.pool?.peek(info.relayUrl) : undefined;
          if (info && conn?.ready) {
            const env = sealEnvelope(daemon.need("me"), ch, info.encKey, body);
            conn.request({ t: "send", env, ephemeral: true }).catch(() => {});
          }
          daemon.events.emit({ type: "status", ch, from: daemon.identity.id, replyTo: s.replyTo, state: s.state, ...(activity ? { activity } : {}), ts: Date.now() });
        } catch (e) {
          log(`status for ${ch}: ${(e as Error).message}`);
        }
      },
      listTransfers: (ch) => this.need("transfers").list(ch),
      createInvite: (kind, name, relay) => channels.createInvite(kind, name, relay),
      events: this.events,
    };
  }

  private buildTransferDeps(): TransferDeps {
    const channels = this.need("channels");
    const outbox = this.need("outbox");
    const me = this.need("me");
    return {
      db: this.need("db"),
      dataDir: this.dataDir,
      p2p: this.need("p2pAdapter").adapter,
      me,
      policy: () => this.need("cfg").policy,
      trust: (ch) => channels.get(ch)?.trust ?? "standard",
      enqueue: (ch, body) => {
        outbox.enqueue(ch, body);
      },
      crocInfo: (ch): CrocInfo | undefined => {
        const c = this.need("cfg").croc;
        const fromRelay = channels.crocFor(ch);
        const relay = c.relay ?? fromRelay?.relay;
        const pass = c.pass ?? fromRelay?.pass;
        return relay && pass ? { relay, pass } : undefined;
      },
      pairKey: (ch, peerId) => pairKey(me.secret, peerId, me.id, ch),
      peers: (ch) => channels.peers(ch),
      peerName: (ch, peerId) => channels.peerName(ch, peerId),
      // The binary carries the pinned croc; a croc.path the owner set explicitly still wins.
      crocPath: this.need("cfg").croc.path === "croc" ? (embedded()?.croc ?? "croc") : this.need("cfg").croc.path,
      ...(this.need("cfg").croc.throttleUpload ? { crocThrottleUpload: this.need("cfg").croc.throttleUpload! } : {}),
      events: this.events,
      log: this.log,
      ownerNote: (text, opts) => {
        const a = this.s.agent;
        if (!a) {
          this.log(`owner note (agent not ready): ${text}`);
          return;
        }
        a.ownerNote(text, opts).catch((e: Error) => this.log(`agent.ownerNote: ${e.message}`));
      },
    };
  }

  /** Writes `model` into config.json (keeping everything else in the file) and the running config. */
  saveModel(model: ModelConfig): void {
    const file = join(this.dataDir, "config.json");
    const raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
    raw.model = model;
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
    this.s.cfg = { ...this.need("cfg"), model };
  }

  apiState(): unknown {
    const cfg = this.need("cfg");
    const pool = this.need("pool");
    const channels = this.need("channels");
    const urls = new Set(channels.relayUrls());
    if (pool.peek(cfg.relay)) urls.add(cfg.relay);
    const relays = [...urls].map(
      (url) => pool.status(url) ?? { url, connected: false, state: "connecting" as const, since: Date.now(), features: [] as string[] },
    );
    const agent = this.s.agent;
    return {
      me: this.identity,
      p2p: { mode: cfg.p2p.mode, ...(this.s.links?.status() ?? getP2pAddonStatus()) },
      relay: { url: cfg.relay, connected: relays.length > 0 && relays.every((r) => r.connected) },
      relays,
      channels: channels.list(),
      transfers: this.s.transfers?.list() ?? [],
      mcp: agent?.mcpStatus() ?? [],
      policy: cfg.policy,
      ownerBusy: agent?.ownerBusy() ?? false,
      requests: agent?.listRequests?.() ?? [],
      followups: agent?.listFollowups?.() ?? [],
      model: agent?.modelStatus?.(),
    };
  }
}
