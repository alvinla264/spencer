/**
 * Standalone dev server for the Spencer web UI.
 *
 *   node packages/web/dev/mock-server.ts [port]
 *
 * Serves packages/web/public with the token substituted (and the daemon's CSP), and implements
 * the local API of docs/PROTOCOL.md §8 in memory with sample data. POSTs mutate the state and
 * push events on /api/events, and a few timers push live events (incoming messages, transfer
 * progress, working status, presence changes, an owner request), so every screen can be exercised
 * without a daemon.
 *
 * Presence follows PROTOCOL §8: `member.presence = "online"|"offline"|"unknown"` and `member.lastSeen`, plus
 * `{type:"presence", ch, id, presence, lastSeen}` events (one per channel the member is in).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, normalize, extname, basename, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Channel as BaseChannel, ChannelMember, ChannelMessage, Transfer as BaseTransfer, OwnerItem, OwnerRequest, McpServerStatus, DaemonEvent, Followup, ModelStatus } from "../../spencer/src/contracts.ts";

type Channel = BaseChannel & { directLink?: "auto" | "off"; allowLocalAddresses?: boolean };
type Transfer = BaseTransfer & { via?: "link" | "croc" };

interface Presence {
  online: boolean;
  lastSeenAt?: number;
}
type MockMember = ChannelMember;
type MockEvent = DaemonEvent;

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 7421);

// Model page. MOCK_MODEL=none starts signed out with no model (the first-run state).
const COPILOT_MODELS = [
  { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
  { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
  { id: "claude-haiku-5.5", name: "Claude Haiku 5.5" },
  { id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
  { id: "grok-4.7", name: "Grok 4.7" },
];
const MOCK_PROVIDERS = () => [
  { id: "github-copilot", name: "GitHub Copilot", models: model.copilot.connected ? COPILOT_MODELS : [] },
  {
    id: "anthropic",
    name: "Anthropic",
    defaultApiKeyEnv: "ANTHROPIC_API_KEY",
    hasEnvKey: false,
    hasSavedKey: mockSavedKeys.has("anthropic"),
    models: [
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true },
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    defaultApiKeyEnv: "OPENAI_API_KEY",
    hasEnvKey: true,
    hasSavedKey: mockSavedKeys.has("openai"),
    models: [
      { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", reasoning: true },
      { id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    defaultApiKeyEnv: "GEMINI_API_KEY",
    hasEnvKey: false,
    hasSavedKey: mockSavedKeys.has("google"),
    models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true }],
  },
  { id: "openai-compatible", name: "OpenAI-compatible (Ollama / vLLM / local)", custom: true, hasSavedKey: mockSavedKeys.has("openai-compatible"), models: [] },
];
const mockSavedKeys = new Set<string>();
const model: ModelStatus =
  process.env.MOCK_MODEL === "none"
    ? {
        provider: "anthropic",
        modelId: "claude-sonnet-5-5",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        ready: false,
        error: "environment variable ANTHROPIC_API_KEY (model.apiKeyEnv) is not set",
        copilot: { connected: false, models: [], deviceLogin: true, cliAccounts: ["alice"] },
      }
    : {
        provider: "github-copilot",
        modelId: "claude-sonnet-5.5",
        thinking: "medium",
        ready: true,
        copilot: { connected: true, login: "alice", plan: "individual", via: "device", models: COPILOT_MODELS, deviceLogin: true, cliAccounts: ["alice"] },
      };
model.providers = MOCK_PROVIDERS();
function syncMockProviders() {
  model.providers = MOCK_PROVIDERS();
}
let signInTimer: ReturnType<typeof setTimeout> | undefined;
function copilotConnected(login: string, via: "device" | "copilot-cli" = "device") {
  clearTimeout(signInTimer);
  const { signIn: _s, ...rest } = model.copilot;
  model.copilot = { ...rest, connected: true, login, plan: "individual", via, models: COPILOT_MODELS };
  if (!model.ready) Object.assign(model, { provider: "github-copilot", modelId: "claude-sonnet-5.5", thinking: "medium", ready: true, error: undefined });
  syncMockProviders();
}
const TOKEN = process.env.SPENCER_TOKEN ?? randomBytes(16).toString("hex");
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const now = () => Date.now();
const b64u = (n: number) => randomBytes(n).toString("base64url");
const MIN = 60_000;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------- identities

interface Person {
  id: string;
  name: string;
  fingerprint: string;
}
const fakeFp = () =>
  randomBytes(10)
    .toString("hex")
    .match(/.{4}/g)!
    .join("-");
const person = (name: string): Person => ({ id: b64u(32), name, fingerprint: fakeFp() });

const me: Person = { id: b64u(32), name: "Alice's Spencer", fingerprint: "a1b2-c3d4-e5f6-a7b8-c9d0" };
const bob = person("Bob's Spencer");
const carol = person("Carol's Spencer");
const dave = person("Dave's Spencer");

const relay = { url: "wss://spencer.pjalv.com/ws", connected: true };
const relays = [relay, { url: "wss://relay.example.org/ws", connected: true }];
/** Peer presence by identity id (the owner's own Spencer has none: it is this daemon). */
const presence = new Map<string, Presence>([
  [bob.id, { online: true, lastSeenAt: now() }],
  [carol.id, { online: false, lastSeenAt: now() - 47 * 60_000 }],
  [dave.id, { online: true, lastSeenAt: now() }],
]);
const policy = {
  maxHops: 4,
  repliesPerMinute: 6,
  repliesPerHour: 60,
  autoAcceptIncomingFiles: false,
  maxIncomingFileBytes: 512 * 1024 * 1024,
  requireApprovalForOutgoingFiles: true,
  ownerCodingTools: true,
  transferTtlHours: 24,
  maxTransferAttempts: 5,
};

// ---------------------------------------------------------------- state

const channels = new Map<string, Channel>();
const messages = new Map<string, ChannelMessage[]>();
const transfers = new Map<string, Transfer>();
const owner: OwnerItem[] = [];
const ownerAttachments = new Map<string, { id: string; name: string; size: number }>();
const ownerUploads = new Map<string, { attachment: { id: string; name: string; size: number }; sha256: string }>();
const ownerSends = new Map<string, { submissionId: string; text: string; attachments: string[] }>();
const requests = new Map<string, OwnerRequest>();
const followups = new Map<string, Followup>();
/** Live working statuses (ch -> from -> event), replayed to a UI that connects mid-run. */
const working = new Map<string, Extract<DaemonEvent, { type: "status" }>>();
let ownerBusy = false;
const people = new Map<string, Person>([me, bob, carol, dave].map((p) => [p.id, p]));

const mcp: McpServerStatus[] = [
  {
    name: "t3code",
    transport: "stdio",
    status: "connected",
    tools: [
      { name: "mcp__t3code__thread_read", description: "Read a T3 Code thread" },
      { name: "mcp__t3code__thread_launch", description: "Start a new agent thread in a project" },
      { name: "mcp__t3code__project_list", description: "List projects" },
    ],
  },
  {
    name: "github",
    transport: "http",
    status: "connected",
    tools: [
      { name: "mcp__github__list_issues", description: "List issues in a repository" },
      { name: "mcp__github__create_issue", description: "Open a new issue" },
      { name: "mcp__github__get_file", description: "Read a file from a repository" },
    ],
  },
  {
    name: "home-assistant",
    transport: "stdio",
    status: "error",
    error: "spawn hass-mcp ENOENT (is it installed and on PATH?)",
    tools: [],
  },
];

function member(p: Person): MockMember {
  const pr = presence.get(p.id);
  const mine = p.id === me.id;
  return {
    id: p.id,
    name: p.name,
    fingerprint: p.fingerprint,
    me: mine,
    presence: mine ? "online" : pr ? (pr.online ? "online" : "offline") : "unknown",
    ...(pr?.lastSeenAt ? { lastSeen: pr.lastSeenAt } : {}),
  };
}

function addChannel(kind: "direct" | "group", name: string, ps: Person[], extra: Partial<Channel> = {}): Channel {
  const c: Channel = {
    id: b64u(16),
    kind,
    name,
    relayUrl: relay.url,
    members: [me, ...ps].map(member),
    autoReply: true,
    directLink: "auto",
    allowLocalAddresses: false,
    allowedMcpTools: [],
    trust: "standard",
    unread: 0,
    lastSeq: 0,
    createdAt: now() - 3 * 24 * HOUR,
    ...extra,
  };
  channels.set(c.id, c);
  messages.set(c.id, []);
  return c;
}

function addMsg(ch: string, from: Person, m: Partial<ChannelMessage> & { text?: string }, ts = now()): ChannelMessage {
  const c = channels.get(ch)!;
  const msg: ChannelMessage = {
    id: b64u(16),
    ch,
    from: from.id,
    fromName: from.name,
    mine: from.id === me.id,
    ts,
    seq: ++c.lastSeq,
    type: "chat",
    hop: 0,
    by: "agent",
    status: from.id === me.id ? "sent" : "received",
    ...m,
  };
  messages.get(ch)!.push(msg);
  return msg;
}

function addOwner(item: Omit<OwnerItem, "id" | "ts">, ts = now()): OwnerItem {
  const it: OwnerItem = { id: b64u(12), ts, ...item };
  owner.push(it);
  return it;
}

function addTransfer(t: Partial<Transfer> & Pick<Transfer, "ch" | "direction" | "peer" | "name" | "size" | "state" | "initiatedBy">): Transfer {
  const full: Transfer = {
    tid: b64u(16),
    peerName: people.get(t.peer)?.name,
    sha256: randomBytes(32).toString("hex"),
    attempt: 1,
    createdAt: now(),
    updatedAt: now(),
    expiresAt: now() + 24 * HOUR,
    ...t,
  };
  transfers.set(full.tid, full);
  return full;
}

// ---------------------------------------------------------------- sample data

const t0 = now() - 50 * MIN;
const bobCh = addChannel("direct", "Bob", [bob], { allowedMcpTools: ["mcp__github__list_issues"], unread: 1 });
const group = addChannel("group", "Networking Group", [carol, dave], { unread: 2, createdAt: now() - 2 * 24 * HOUR });
addChannel("direct", "Erin", [], { createdAt: now() - 2 * HOUR });

addMsg(bobCh.id, bob, { type: "hello", text: "Bob's home-server agent", by: undefined, hop: undefined }, t0);
const ask = addMsg(bobCh.id, me, { text: "Hi Bob's Spencer — Alice wants to know whether last night's backup finished.", hop: 0, by: "agent", origin: "owner-agent" }, t0 + 2 * MIN);
const answer = addMsg(
  bobCh.id,
  bob,
  { text: "Yes. The nightly backup finished at 03:12 UTC: 41.2 GB, no errors. @Alice's Spencer do you want the log?", hop: 1, by: "agent", replyTo: ask.id, mentions: [me.id] },
  t0 + 3 * MIN,
);
const thanks = addMsg(bobCh.id, me, { text: "Thanks! Yes please, send the log over.", hop: 0, by: "human", replyTo: answer.id }, t0 + 6 * MIN);
addMsg(bobCh.id, me, { text: "Sure — I'll ask Bob to approve sending backup-2026-11-19.log.", hop: 2, by: "agent", replyTo: thanks.id }, t0 + 6.5 * MIN);
addMsg(bobCh.id, bob, { text: "👍 Approved on my side. It should show up in your transfers.", hop: 3, by: "agent", note: "hop cap" }, t0 + 7 * MIN);
addMsg(
  bobCh.id,
  bob,
  {
    text: [
      "Here is the summary of last night's run:",
      "",
      "| Step | Duration | Result |",
      "|---|---:|---|",
      "| snapshot | 1m 12s | ok |",
      "| upload | 14m 03s | ok, **41.2 GB** |",
      "| verify | 2m 40s | ok |",
      "",
      "The job is driven by this unit:",
      "",
      "```ini",
      "[Timer]",
      "OnCalendar=*-*-* 03:00:00",
      "Persistent=true",
      "```",
      "",
      "- [x] retention pruned to 14 days",
      "- [ ] off-site copy (waiting on *Bob*)",
    ].join("\n"),
    hop: 1,
    by: "agent",
  },
  t0 + 7.2 * MIN,
);
const fu = addMsg(bobCh.id, me, { text: "Following up as promised: the restore test from last night's backup passed (3,214 files, 0 mismatches).", hop: 1, by: "agent", origin: "agent-followup" }, t0 + 15 * MIN);
addMsg(bobCh.id, bob, { text: "Great, that's all I needed. Thanks!", hop: 2, by: "agent", replyTo: fu.id, final: true }, t0 + 15.5 * MIN);
addMsg(bobCh.id, bob, { text: "(Bob here, typing myself) are we still on for Friday?", hop: 0, by: "human", note: "not addressed" }, t0 + 20 * MIN);
addMsg(bobCh.id, me, { text: "Friday works — see you at 7. Details: https://example.com/friday?ref=spencer", hop: 0, by: "human", status: "pending" }, t0 + 21 * MIN);

addMsg(group.id, carol, { type: "hello", text: "", by: undefined, hop: undefined }, t0 - 30 * MIN);
addMsg(group.id, dave, { type: "hello", text: "Dave's laptop", by: undefined, hop: undefined }, t0 - 29 * MIN);
addMsg(group.id, carol, { text: "Anyone have the venue wifi details for Thursday?", hop: 0, by: "human", note: "not addressed" }, t0 + 1 * MIN);
const daveAsk = addMsg(group.id, dave, { text: "@Alice's Spencer can you share the slides from the last meetup?", hop: 0, by: "agent", mentions: [me.id] }, t0 + 4 * MIN);
const myReply = addMsg(group.id, me, { text: "Sure — I'll ask Alice to approve sending meetup-slides.key to you.", hop: 1, by: "agent", replyTo: daveAsk.id, mentions: [dave.id] }, t0 + 4.5 * MIN);
addMsg(group.id, carol, { text: "Thanks @Dave's Spencer and @Alice's Spencer! Agenda is up at https://example.com/agenda", hop: 2, by: "agent", replyTo: myReply.id, note: "rate limited" }, t0 + 5 * MIN);
addMsg(group.id, me, { text: "(huge paste of the meetup notes…)", hop: 0, by: "human", status: "failed", note: "envelope too large" }, t0 + 8 * MIN);
addMsg(group.id, dave, { text: "Auto-replies are off on my side today, ping Dave directly if urgent.", hop: 0, by: "human", note: "auto-reply off" }, t0 + 9 * MIN);
addMsg(group.id, dave, { text: "Also, could someone restart the staging preview? It has been stuck since lunch.", hop: 0, by: "human", note: "not addressed" }, t0 + 9.4 * MIN);
const daveTask = addMsg(group.id, dave, { text: "@Alice's Spencer can you start a T3 Code thread in `staging` to restart the preview server?", hop: 0, by: "agent", mentions: [me.id] }, t0 + 12 * MIN);
addMsg(group.id, me, { text: "I've asked Alice. I'll report back here once she decides.", hop: 1, by: "agent", replyTo: daveTask.id, mentions: [dave.id] }, t0 + 12.3 * MIN);
addMsg(
  group.id,
  carol,
  {
    text: "Here's the badge layout for Thursday:\n\n```html\n<!doctype html><body style=\"font-family:sans-serif;padding:16px\"><h2 style=\"margin:0\">Networking Night</h2><p>Thursday 19:00 · Room 4</p></body>\n```",
    hop: 0,
    by: "agent",
  },
  t0 + 14 * MIN,
);

addOwner({ role: "user", text: "Ask Bob's Spencer if the nightly backup finished" }, t0 + 1 * MIN);
addOwner({ role: "tool", toolName: "list_peers", text: "call {}" }, t0 + 1.1 * MIN);
addOwner({ role: "tool", toolName: "list_peers", text: JSON.stringify([{ name: "Bob's Spencer", channel: "Bob", kind: "direct" }, { name: "Networking Group", members: 3 }], null, 2) }, t0 + 1.2 * MIN);
addOwner({ role: "tool", toolName: "send_message", text: 'call {"to":"Bob\'s Spencer","text":"Hi Bob\'s Spencer — Alice wants to know whether last night\'s backup finished."}' }, t0 + 1.4 * MIN);
addOwner({ role: "tool", toolName: "send_message", text: `sent to Bob's Spencer (direct), id ${ask.id}` }, t0 + 1.5 * MIN);
addOwner({ role: "assistant", text: "I asked Bob's Spencer whether last night's backup finished. I'll tell you when it answers." }, t0 + 2 * MIN);
addOwner({ role: "note", untrusted: true, text: "Reply from Bob's Spencer in Bob (untrusted): Yes. The nightly backup finished at 03:12 UTC: 41.2 GB, no errors. Do you want the log?" }, t0 + 3 * MIN);
addOwner({ role: "note", untrusted: true, text: "Reply from Bob's Spencer in Bob (untrusted): The log is 18 MB. I can send it over croc if Alice wants it." }, t0 + 3.2 * MIN);
addOwner({ role: "user", text: "Great. Also check if there are open issues about backups in our repo" }, t0 + 10 * MIN);
addOwner({ role: "tool", toolName: "mcp__github__list_issues", text: 'call {"repo":"alice/infra","query":"backup"}' }, t0 + 10.2 * MIN);
addOwner({ role: "tool", toolName: "mcp__github__list_issues", isError: true, text: "401 Unauthorized: bad credentials\n(check the GITHUB_TOKEN env of the github MCP server)" }, t0 + 10.3 * MIN);
addOwner({ role: "assistant", text: "Bob's Spencer confirmed the backup finished at **03:12 UTC** with no errors.\n\nI couldn't check GitHub: the `github` MCP server rejected my credentials (401). To fix it:\n\n1. Create a new token with `repo` scope\n2. Put it in `GITHUB_TOKEN` in Spencer's config\n3. Restart the daemon" }, t0 + 11 * MIN);
addOwner({ role: "note", text: "Channel Networking Group used mcp__t3code__project_list (allowed in that channel)." }, t0 + 12.1 * MIN);
const req: OwnerRequest = {
  id: b64u(12),
  kind: "peer",
  ch: group.id,
  channelName: group.name,
  from: dave.id,
  fromName: dave.name,
  text: "Dave's Spencer asks me to start a T3 Code thread in the project “staging” that restarts the preview server (`systemctl --user restart preview`).",
  state: "pending",
  createdAt: t0 + 12.2 * MIN,
};
requests.set(req.id, req);
// The Networking Group used up its automatic replies: a "continue?" card.
const cont: OwnerRequest = {
  id: b64u(12),
  kind: "continue",
  ch: group.id,
  channelName: group.name,
  from: carol.id,
  fromName: carol.name,
  text: "Carol's Spencer and I have traded 20 automatic replies about the meetup agenda since you last wrote here.",
  state: "pending",
  createdAt: t0 + 13 * MIN,
};
requests.set(cont.id, cont);
addOwner({ role: "note", request: cont.id, text: cont.text }, t0 + 13 * MIN);
addOwner({ role: "note", untrusted: true, request: req.id, text: `Request from ${dave.name} in ${group.name}:\n${req.text}` }, t0 + 12.2 * MIN);
addOwner({ role: "note", text: "Transfer photos.zip from Bob's Spencer completed. It is in quarantine." }, t0 + 30 * MIN);

for (const f of [
  { conversation: "owner", note: "Check whether Bob's Spencer finished the restore test and tell me the result.", dueAt: now() + 25 * MIN, wakeOnReplyIn: bobCh.id },
  { conversation: "channel", ch: group.id, note: "Post the T3 thread result for Dave once the preview server restart finishes.", dueAt: now() + 8 * MIN },
] as const) {
  const id = b64u(9);
  followups.set(id, { id, depth: 0, state: "pending", createdAt: t0 + 20 * MIN, ...f } as Followup);
}

addTransfer({ ch: bobCh.id, direction: "out", peer: bob.id, name: "q3-report.pdf", size: 2_516_582, state: "awaiting_approval", initiatedBy: "peer-agent", reason: "Bob asked for the Q3 report for tomorrow's review", createdAt: t0 + 8 * MIN, path: "/home/alice/.local/share/spencer/outgoing/x/q3-report.pdf" });
addTransfer({ ch: bobCh.id, direction: "in", peer: bob.id, name: "backup-2026-11-19.log", size: 18_874_368, state: "offered", initiatedBy: "peer", createdAt: t0 + 7.5 * MIN });
addTransfer({ ch: group.id, direction: "out", peer: dave.id, name: "meetup-slides.key", size: 48_234_496, state: "sending", via: "link", initiatedBy: "owner-agent", progress: 0.35, createdAt: t0 + 5.5 * MIN });
addTransfer({ ch: bobCh.id, direction: "in", peer: bob.id, name: "photos.zip", size: 125_829_120, state: "completed", via: "croc", initiatedBy: "peer", progress: 1, createdAt: t0 - 2 * HOUR, path: "/home/alice/.local/share/spencer/quarantine/k2Jd9sQx/photos.zip" });
addTransfer({ ch: group.id, direction: "out", peer: carol.id, name: "notes.txt", size: 4_096, state: "failed", initiatedBy: "owner", attempt: 5, error: "croc exited with code 1 after 5 attempts (relay unreachable)", createdAt: t0 - 3 * HOUR });

// MOCK_EMPTY_OWNER=1 starts with an empty owner chat (to see the example prompts).
if (process.env.MOCK_EMPTY_OWNER) owner.length = 0;

// ---------------------------------------------------------------- events

const sockets = new Set<WebSocket>();
function emit(e: MockEvent) {
  const data = JSON.stringify(e);
  for (const s of sockets) if (s.readyState === s.OPEN) s.send(data);
}
const emitChannel = (c: Channel) => emit({ type: "channel", channel: c });
const emitMsg = (m: ChannelMessage) => emit({ type: "message", ch: m.ch, message: m });
const emitTransfer = (t: Transfer) => emit({ type: "transfer", transfer: t });
const emitOwner = (it: OwnerItem) => emit({ type: "owner", item: it });
const setBusy = (b: boolean) => {
  ownerBusy = b;
  emit({ type: "owner_busy", busy: b });
};
const later = (ms: number, fn: () => void) => setTimeout(fn, ms).unref();

function setStatus(ch: string, from: string, replyTo: string, state: "working" | "done", activity?: string) {
  const e = { type: "status" as const, ch, from, replyTo, state, activity, ts: now() };
  if (state === "done") working.delete(`${ch} ${from}`);
  else working.set(`${ch} ${from}`, e);
  emit(e);
}

/** Run `steps` as a working status (one every `gap` ms), then call `done`. */
function workThrough(ch: string, from: string, replyTo: string, steps: string[], gap: number, done?: () => void) {
  steps.forEach((a, i) => later(i * gap, () => channels.has(ch) && setStatus(ch, from, replyTo, "working", a)));
  later(steps.length * gap, () => {
    setStatus(ch, from, replyTo, "done");
    if (channels.has(ch)) done?.();
  });
}

function setPresence(p: Person, online: boolean) {
  const pr: Presence = { online, lastSeenAt: now() };
  presence.set(p.id, pr);
  for (const c of channels.values()) {
    const m = (c.members as MockMember[]).find((x) => x.id === p.id);
    if (!m) continue;
    m.presence = online ? "online" : "offline";
    m.lastSeen = pr.lastSeenAt;
    emit({ type: "presence", ch: c.id, id: p.id, presence: m.presence, ...(m.lastSeen ? { lastSeen: m.lastSeen } : {}) });
  }
}

function incoming(ch: Channel, from: Person, m: Partial<ChannelMessage> & { text?: string }) {
  const msg = addMsg(ch.id, from, m);
  ch.unread++;
  emitMsg(msg);
  emitChannel(ch);
  return msg;
}

function setTransfer(t: Transfer, patch: Partial<Transfer>) {
  Object.assign(t, patch, { updatedAt: now() });
  emitTransfer(t);
}

// Transfer progress ticks.
setInterval(() => {
  for (const t of transfers.values()) {
    if (t.state !== "sending" && t.state !== "receiving") continue;
    const p = Math.min(1, (t.progress ?? 0) + 0.03 + Math.random() * 0.05);
    if (p < 1) {
      setTransfer(t, { progress: p });
      continue;
    }
    if (t.direction === "in") {
      setTransfer(t, { progress: 1, state: "completed", path: `/home/alice/.local/share/spencer/quarantine/${t.tid.slice(0, 8)}/${t.name}` });
      emitOwner(addOwner({ role: "note", text: `Transfer ${t.name} from ${t.peerName} completed. It is in quarantine.` }));
    } else {
      setTransfer(t, { progress: 1, state: "completed", path: undefined });
      emitOwner(addOwner({ role: "note", text: `${t.peerName} received ${t.name}.` }));
    }
  }
}, 1500).unref();

// A few scripted incoming messages.
const chatter: [Channel, Person, Partial<ChannelMessage>][] = [
  [group, carol, { text: "Found it: wifi is “venue-guest”, password on the whiteboard.", hop: 0, by: "human", note: "not addressed" }],
  [bobCh, bob, { text: "Bob's Spencer here: the q3-report request is still waiting on your approval.", hop: 0, by: "agent" }],
  [group, dave, { text: "@Alice's Spencer got the first half of the slides, looks good!", hop: 0, by: "agent", mentions: [me.id] }],
  [group, carol, { text: "See everyone Thursday 👋", hop: 0, by: "human", note: "not addressed" }],
];
let chatIdx = 0;
setInterval(() => {
  const [c, p, m] = chatter[chatIdx++ % chatter.length];
  if (channels.has(c.id)) incoming(c, p, m);
}, 25_000).unref();
later(8_000, () => {
  const pending = messages.get(bobCh.id)!.find((m) => m.status === "pending");
  if (pending) {
    pending.status = "sent";
    emitMsg(pending);
  }
});

// Bob's Spencer is in the middle of a long task when the UI opens, then starts another one every minute.
const BOB_STEPS = ["Thinking…", "Using t3code · project list", "Using t3code · thread read", "Using github · list issues", "Using t3code · thread read", "Thinking…"];
let bobRuns = 0;
function bobWorks() {
  if (!channels.has(bobCh.id)) return;
  const target = messages.get(bobCh.id)!.findLast((m) => m.mine) ?? messages.get(bobCh.id)![0];
  if (!target) return;
  workThrough(bobCh.id, bob.id, target.id, BOB_STEPS, 6000, () => {
    if (bobRuns++ === 0) incoming(bobCh, bob, { text: "Checked the staging thread and the open issues: nothing blocks Friday. One issue (**#42**, backup retention) is still open; I left a comment.", hop: 1, by: "agent", replyTo: target.id, mentions: [me.id] });
  });
}
bobWorks();
setInterval(bobWorks, 60_000).unref();
// My own Spencer answers Dave in the group for a while (shows the "mine" working row).
workThrough(group.id, me.id, daveAsk.id, ["Thinking…", "Asking its owner for approval", "Using t3code · project list"], 15_000);

// Carol's Spencer comes and goes.
setInterval(() => setPresence(carol, !presence.get(carol.id)!.online), 40_000).unref();

// One relay blip so the connection dot can be seen changing.
later(60_000, () => {
  relay.connected = false;
  emit({ type: "relay", url: relay.url, connected: false });
  setPresence(dave, false);
  later(6_000, () => {
    relay.connected = true;
    emit({ type: "relay", url: relay.url, connected: true });
    setPresence(dave, true);
  });
});

// ---------------------------------------------------------------- API

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function getChannel(ch: string): Channel {
  const c = channels.get(ch);
  if (!c) throw new HttpError(404, "unknown channel");
  return c;
}

function getTransfer(tid: string): Transfer {
  const t = transfers.get(tid);
  if (!t) throw new HttpError(404, "unknown transfer");
  return t;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1 << 20) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function ownerReply(text: string) {
  setBusy(true);
  const lower = text.toLowerCase();
  later(700, () => {
    if (lower.includes("peer")) {
      emitOwner(addOwner({ role: "tool", toolName: "list_peers", text: "call {}" }));
      emitOwner(addOwner({ role: "tool", toolName: "list_peers", text: JSON.stringify([...channels.values()].map((c) => ({ channel: c.name, kind: c.kind, members: c.members.filter((m) => !m.me).map((m) => m.name) })), null, 2) }));
    } else if (lower.includes("bob")) {
      const m = addMsg(bobCh.id, me, { text: text.replace(/^ask bob'?s spencer (for|to)?\s*/i, "Alice asks: "), hop: 0, by: "agent", origin: "owner-agent" });
      emitMsg(m);
      emitOwner(addOwner({ role: "tool", toolName: "send_message", text: `sent to Bob's Spencer (direct), id ${m.id}` }));
      later(3500, () => {
        const r = incoming(bobCh, bob, { text: "Here's the tail of the log:\n03:10:58 snapshot ok\n03:12:04 upload ok (41.2 GB)\nWant the full file?", hop: 1, by: "agent", replyTo: m.id, mentions: [me.id] });
        emitOwner(addOwner({ role: "note", untrusted: true, text: `Reply from Bob's Spencer in Bob (untrusted): ${r.text}` }));
      });
    } else if (lower.includes("issue") || lower.includes("github")) {
      emitOwner(addOwner({ role: "tool", toolName: "mcp__github__list_issues", text: 'call {"repo":"alice/infra"}' }));
    } else if (lower.includes("transfer")) {
      emitOwner(addOwner({ role: "tool", toolName: "list_transfers", text: "call {}" }));
      emitOwner(addOwner({ role: "tool", toolName: "list_transfers", text: [...transfers.values()].map((t) => `${t.direction} ${t.name} ${t.state}`).join("\n") }));
    }
  });
  later(lower.includes("issue") || lower.includes("github") ? 6000 : 1800, () => {
    let answer: string;
    if (lower.includes("peer")) answer = `You have ${[...channels.values()].filter((c) => c.kind === "direct").length} direct channels and ${[...channels.values()].filter((c) => c.kind === "group").length} group(s). Bob's Spencer is the most active.`;
    else if (lower.includes("bob")) answer = "I've asked Bob's Spencer. Its answer will show up here as a note.";
    else if (lower.includes("transfer")) answer = "Two transfers need you: approve or deny q3-report.pdf (Bob's agent asked for it), and accept or decline backup-2026-11-19.log.";
    else answer = `(mock) You said: “${text}”. In the real daemon, the model answers here.`;
    emitOwner(addOwner({ role: "assistant", text: answer }));
    setBusy(false);
  });
}

function channelSend(c: Channel, text: string, mentions: string[]) {
  const msg = addMsg(c.id, me, { text, hop: 0, by: "human", status: "pending", mentions: mentions.length ? mentions : undefined, origin: "human" });
  later(600, () => {
    msg.status = "sent";
    emitMsg(msg);
  });
  const others = c.members.filter((m) => !m.me);
  const responders = c.kind === "direct" ? others : others.filter((m) => mentions.includes(m.id) || text.toLowerCase().includes(`@${(m.name ?? "").toLowerCase()}`));
  responders.forEach((m, i) => {
    later(900 + i * 1200, () => {
      const p = people.get(m.id);
      if (!p || !channels.has(c.id)) return;
      workThrough(c.id, p.id, msg.id, ["Thinking…", "Using t3code · thread read", "Thinking…"], 1500, () => incoming(c, p, { text: `(${p.name}, auto-reply) Got your message: “${text.slice(0, 80)}”.`, hop: 1, by: "agent", replyTo: msg.id, mentions: [me.id] }));
    });
  });
  return msg;
}

function transferAction(t: Transfer, action: string): Transfer {
  const bad = () => new HttpError(409, `can't ${action} a transfer in state ${t.state}`);
  switch (action) {
    case "approve":
      if (t.direction !== "out" || t.state !== "awaiting_approval") throw bad();
      setTransfer(t, { state: "offered" });
      later(2000, () => t.state === "offered" && setTransfer(t, { state: "sending", progress: 0 }));
      break;
    case "deny":
      if (t.direction !== "out" || t.state !== "awaiting_approval") throw bad();
      setTransfer(t, { state: "denied", path: undefined });
      break;
    case "accept":
      if (t.direction !== "in" || t.state !== "offered") throw bad();
      setTransfer(t, { state: "accepted" });
      later(1200, () => t.state === "accepted" && setTransfer(t, { state: "receiving", progress: 0 }));
      break;
    case "decline":
      if (t.direction !== "in" || t.state !== "offered") throw bad();
      setTransfer(t, { state: "declined" });
      break;
    case "cancel":
      if (["completed", "denied", "declined", "failed", "expired", "cancelled"].includes(t.state)) throw bad();
      setTransfer(t, { state: "cancelled", error: "cancelled by you" });
      break;
    default:
      throw new HttpError(404, "unknown action");
  }
  return t;
}

async function api(req: IncomingMessage, url: URL): Promise<unknown> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
  const [, a, b, c] = parts;

  if (method === "GET" && a === "state" && !b) {
    return {
      me,
      relay: { url: relay.url, connected: relays.every((r) => r.connected) },
      relays,
      channels: [...channels.values()],
      transfers: [...transfers.values()],
      mcp,
      policy,
      ownerBusy,
      requests: [...requests.values()].reverse(),
      followups: [...followups.values()],
      model,
      p2p: { mode: "files", available: true },
    };
  }
  if (a === "owner" && b === "attachments" && c === "upload" && method === "POST") {
    const name = url.searchParams.get("name") ?? "";
    const uploadId = url.searchParams.get("uploadId") ?? "";
    if (!name.trim() || Buffer.byteLength(name, "utf8") > 255 || !/^[A-Za-z0-9_-]{16,64}$/.test(uploadId)) throw new HttpError(400, "invalid owner attachment");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.byteLength; if (size > 25 * 1024 * 1024) throw new HttpError(413, "file too large"); chunks.push(Buffer.from(chunk)); }
    const sha256 = createHash("sha256").update(Buffer.concat(chunks, size)).digest("hex");
    const previous = ownerUploads.get(uploadId);
    if (previous) {
      if (previous.attachment.name !== name || previous.sha256 !== sha256) throw new HttpError(409, "upload ID was already used for different content");
      return previous.attachment;
    }
    const attachment = { id: b64u(12), name, size };
    ownerAttachments.set(attachment.id, attachment);
    ownerUploads.set(uploadId, { attachment, sha256 });
    return attachment;
  }
  if (a === "owner" && b === "messages" && !c) {
    if (method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return { items: owner.slice(-limit) };
    }
    if (method === "POST") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const ids = Array.isArray(body.attachments) ? body.attachments.filter((id): id is string => typeof id === "string") : [];
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      const previous = requestId ? ownerSends.get(requestId) : undefined;
      if (previous) {
        if (previous.text !== text || previous.attachments.join("\0") !== ids.join("\0")) throw new HttpError(409, "request ID was already used for different content");
        return { submissionId: previous.submissionId };
      }
      const attached = ids.map((id) => ownerAttachments.get(id));
      if (!text && !ids.length) throw new HttpError(400, "text or attachments are required");
      if (attached.some((item) => !item)) throw new HttpError(400, "attachment unavailable");
      if (ownerBusy) throw new HttpError(409, "Spencer is still working on the previous message");
      const submissionId = b64u(12);
      if (requestId) ownerSends.set(requestId, { submissionId, text, attachments: ids });
      emitOwner(addOwner({ role: "user", text, ...(attached.length ? { attachments: attached as { id: string; name: string; size: number }[] } : {}) }));
      ownerReply(text || "I received the attached files.");
      return { submissionId };
    }
  }
  if (a === "channels" && b) {
    const ch = getChannel(b);
    if (c === "messages") {
      if (method === "GET") {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 100)));
        const before = url.searchParams.get("before");
        let list = messages.get(ch.id)!;
        if (before !== null) {
          // `before` is a message id, like the daemon (PROTOCOL §8).
          const i = list.findIndex((m) => m.id === before);
          if (i === -1) throw new HttpError(404, "unknown message");
          list = list.slice(0, i);
        }
        return { items: list.slice(-limit) };
      }
      if (method === "POST") {
        const body = await readJson(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) throw new HttpError(400, "text is required");
        if (text.length > 16000) throw new HttpError(400, "text too long (max 16000 chars)");
        const mentions = Array.isArray(body.mentions) ? body.mentions.filter((x): x is string => typeof x === "string") : [];
        const msg = channelSend(ch, text, mentions);
        emitMsg(msg);
        return { id: msg.id };
      }
    }
    if (!c && method === "PATCH") {
      const body = await readJson(req);
      if (typeof body.name === "string" && body.name.trim()) ch.name = body.name.trim();
      if (body.directLink === "auto" || body.directLink === "off") ch.directLink = body.directLink;
      if (typeof body.allowLocalAddresses === "boolean") ch.allowLocalAddresses = body.allowLocalAddresses;
      if (typeof body.autoReply === "boolean") ch.autoReply = body.autoReply;
      if (body.trust === "standard" || body.trust === "full") ch.trust = body.trust;
      if (Array.isArray(body.allowedMcpTools)) ch.allowedMcpTools = body.allowedMcpTools.filter((x): x is string => typeof x === "string");
      emitChannel(ch);
      return ch;
    }
    if (!c && method === "DELETE") {
      channels.delete(ch.id);
      messages.delete(ch.id);
      emit({ type: "channel_removed", ch: ch.id });
      return {};
    }
  }
  if (a === "invites" && method === "POST") {
    const body = await readJson(req);
    if (!b) {
      const kind = body.kind === "group" ? "group" : body.kind === "direct" ? "direct" : null;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!kind) throw new HttpError(400, "kind must be direct or group");
      if (!name) throw new HttpError(400, "name is required");
      let hub = relay.url;
      if (body.relay !== undefined) {
        if (typeof body.relay !== "string") throw new HttpError(400, "invalid hub URL");
        try {
          const url = new URL(body.relay);
          if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error();
          url.protocol = url.protocol === "http:" ? "ws:" : url.protocol === "https:" ? "wss:" : url.protocol;
          url.pathname = "/ws";
          url.search = "";
          url.hash = "";
          hub = url.toString();
        } catch { throw new HttpError(400, "invalid hub URL"); }
      }
      const chn = addChannel(kind, name, [], { createdAt: now(), relayUrl: hub });
      emitChannel(chn);
      // Simulate the friend joining a little later.
      later(12_000, () => {
        if (!channels.has(chn.id)) return;
        const p = person(kind === "direct" ? `${name}'s Spencer` : "Grace's Spencer");
        people.set(p.id, p);
        chn.members.push(member(p));
        emitChannel(chn);
        incoming(chn, p, { type: "hello", text: "", hop: undefined, by: undefined });
      });
      return { link: `${hub.replace(/^ws/, "http").replace(/\/ws$/, "")}/i/${chn.id}#${b64u(32)}`, channel: chn };
    }
    if (b === "accept") {
      const link = typeof body.link === "string" ? body.link.trim() : "";
      const m = /^https?:\/\/[^/\s]+\/i\/([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$/.exec(link);
      if (!m) throw new HttpError(400, "invalid invite link");
      if (channels.has(m[1])) throw new HttpError(409, "you are already in this channel");
      const p = person("Frank's Spencer");
      people.set(p.id, p);
      const inviteUrl = new URL(link);
      const hub = `${inviteUrl.protocol === "https:" ? "wss:" : "ws:"}//${inviteUrl.host}/ws`;
      const chn = addChannel("direct", "Frank", [p], { id: m[1], createdAt: now(), relayUrl: hub });
      later(1500, () => channels.has(chn.id) && incoming(chn, p, { type: "hello", text: "Frank's VPS", hop: undefined, by: undefined }));
      emitChannel(chn);
      return { channel: chn };
    }
  }
  if (a === "transfers") {
    if (!b && method === "GET") return { items: [...transfers.values()] };
    if (!b && method === "POST") {
      const body = await readJson(req);
      const chn = getChannel(typeof body.ch === "string" ? body.ch : "");
      const path = typeof body.path === "string" ? body.path.trim() : "";
      if (!path.startsWith("/")) throw new HttpError(400, "path must be absolute");
      if (path.includes("missing")) throw new HttpError(404, `ENOENT: no such file ${path}`);
      const peersOf = chn.members.filter((m) => !m.me);
      let to = typeof body.to === "string" ? body.to : undefined;
      if (chn.kind === "group" && !to) throw new HttpError(400, "to is required in groups");
      if (!to) to = peersOf[0]?.id;
      if (!to || !peersOf.some((m) => m.id === to)) throw new HttpError(400, "recipient is not a member of this channel");
      const t = addTransfer({ ch: chn.id, direction: "out", peer: to, name: basename(path), size: Math.floor(Math.random() * 30_000_000) + 1000, state: "awaiting_approval", initiatedBy: "owner", path });
      emitTransfer(t);
      return t;
    }
    if (b && c && method === "POST") return transferAction(getTransfer(b), c);
    if (b && !c && method === "GET") return getTransfer(b);
  }
  if (a === "mcp" && method === "GET" && !b) return { servers: mcp };
  if (a === "model" && !b) {
    if (method === "GET") return model;
    if (method === "PUT") {
      const body = await readJson(req);
      const provId = typeof body.provider === "string" ? body.provider.trim() : "";
      const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
      const prov = MOCK_PROVIDERS().find((p) => p.id === provId);
      if (!prov || !modelId) throw new HttpError(400, "unknown provider or model");
      if (provId === "github-copilot") {
        if (!model.copilot.connected) throw new HttpError(409, "Sign in to GitHub Copilot first.");
        if (!COPILOT_MODELS.some((m) => m.id === modelId)) throw new HttpError(400, "unknown model");
      } else if (provId === "openai-compatible") {
        if (!body.baseUrl && !model.baseUrl) throw new HttpError(400, 'baseUrl is required for "openai-compatible"');
      } else if (!prov.models.some((m) => m.id === modelId)) {
        throw new HttpError(400, "unknown model");
      }
      if (body.clearApiKey) mockSavedKeys.delete(provId);
      else if (typeof body.apiKey === "string" && body.apiKey.trim()) mockSavedKeys.add(provId);
      syncMockProviders();
      const updatedProv = model.providers?.find((p) => p.id === provId);
      const ready = provId === "github-copilot" ? model.copilot.connected : provId === "openai-compatible" ? true : Boolean(updatedProv?.hasEnvKey || updatedProv?.hasSavedKey);
      Object.assign(model, {
        provider: provId,
        modelId,
        thinking: typeof body.thinking === "string" && body.thinking !== "off" ? body.thinking : provId === "github-copilot" ? "medium" : undefined,
        baseUrl: provId === "openai-compatible" ? String(body.baseUrl ?? model.baseUrl) : undefined,
        apiKeyEnv: updatedProv?.defaultApiKeyEnv,
        ready,
        error: ready ? undefined : `environment variable ${updatedProv?.defaultApiKeyEnv ?? "API_KEY"} is not set`,
      });
      emit({ type: "model", model });
      return model;
    }
  }
  if (a === "auth" && b === "github-copilot" && method === "POST") {
    if (c === "login") {
      // The mock "approves" after 20 s (or cancel it); a real daemon polls GitHub.
      model.copilot.signIn = { state: "waiting", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 15 * MIN };
      clearTimeout(signInTimer);
      signInTimer = setTimeout(() => {
        copilotConnected("alice");
        emit({ type: "model", model });
      }, 20_000);
    } else if (c === "cancel") {
      clearTimeout(signInTimer);
      model.copilot.signIn = { state: "cancelled" };
    } else if (c === "refresh") {
      if (!model.copilot.connected) throw new HttpError(409, "Sign in to GitHub Copilot first.");
      model.copilot.models = COPILOT_MODELS;
      model.copilot.modelsRefreshedAt = Date.now();
      model.copilot.modelsError = undefined;
      syncMockProviders();
    } else if (c === "cli") {
      const body = await readJson(req);
      if (!model.copilot.cliAccounts.includes(String(body.login))) throw new HttpError(400, `The GitHub Copilot CLI has no saved sign-in for @${body.login}.`);
      copilotConnected(String(body.login), "copilot-cli");
    } else if (c === "logout") {
      model.copilot = { connected: false, models: [], deviceLogin: true, cliAccounts: ["alice"] };
      syncMockProviders();
      if (model.provider === "github-copilot") {
        Object.assign(model, { ready: false, error: "GitHub Copilot is not connected yet: sign in on the Model page" });
      }
    } else throw new HttpError(404, "not found");
    emit({ type: "model", model });
    return model;
  }
  if (a === "followups") {
    if (!b && method === "GET") return { items: [...followups.values()] };
    if (b && c === "cancel" && method === "POST") {
      const f = followups.get(b);
      if (!f) throw new HttpError(404, "unknown follow-up");
      if (f.state !== "pending" && f.state !== "running") throw new HttpError(409, `follow-up already ${f.state}`);
      f.state = "cancelled";
      emit({ type: "followup", followup: f });
      return f;
    }
  }
  if (a === "requests") {
    if (!b && method === "GET") return { items: [...requests.values()].reverse() };
    if (b && (c === "approve" || c === "deny") && method === "POST") {
      const r = requests.get(b);
      if (!r) throw new HttpError(404, "unknown request");
      if (r.state !== "pending") throw new HttpError(409, `request already ${r.state}`);
      r.state = c === "approve" ? "approved" : "denied";
      r.decidedAt = now();
      emit({ type: "request", request: r });
      if (r.kind === "continue") {
        if (c === "deny" && channels.has(r.ch)) emitMsg(addMsg(r.ch, me, { text: "Pausing here; my owner will pick this up.", hop: 1, by: "agent", origin: "agent-reply", final: true }));
      } else if (c === "approve") {
        emitOwner(addOwner({ role: "user", text: `I approve this request from ${r.fromName}: ${r.text}` }));
        ownerReply("approved request");
      } else if (channels.has(r.ch)) {
        emitMsg(addMsg(r.ch, me, { text: "My owner declined this request.", hop: policy.maxHops, by: "agent", origin: "agent-reply" }));
      }
      return r;
    }
  }
  throw new HttpError(404, "not found");
}

// ---------------------------------------------------------------- HTTP

const TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function hostOk(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const CSP = `default-src 'self'; connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'`;

const server = createServer(async (req, res) => {
  if (!hostOk(req)) {
    res.writeHead(421).end("bad host");
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    if (req.headers["x-spencer-token"] !== TOKEN) return send(res, 401, { error: "missing or bad token" });
    try {
      const out = await api(req, url);
      // Small delay so pending states are visible.
      await new Promise((r) => setTimeout(r, 120));
      send(res, 200, out);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC.endsWith(sep) ? PUBLIC : PUBLIC + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    let data: Buffer | string = await readFile(file);
    if (extname(file) === ".html") data = data.toString("utf8").replaceAll("__SPENCER_TOKEN__", TOKEN);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (!hostOk(req) || url.pathname !== "/api/events" || url.searchParams.get("token") !== TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.send(JSON.stringify({ type: "relay", url: relay.url, connected: relay.connected } satisfies DaemonEvent));
    if (ownerBusy) ws.send(JSON.stringify({ type: "owner_busy", busy: true } satisfies DaemonEvent));
    for (const e of working.values()) ws.send(JSON.stringify(e));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Spencer mock UI: http://127.0.0.1:${PORT}/`);
  console.log(`token: ${TOKEN}`);
});
