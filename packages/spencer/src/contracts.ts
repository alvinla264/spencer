/**
 * Internal contracts between the parts of the Spencer daemon.
 *
 *   core  = store, relay client, outbox, inbox, channels, HTTP API, daemon wiring
 *   xfer  = transfers state machine + croc runner
 *   agent = pi-durable runtime adapter, models, MCP, tools, reply policy
 *
 * Each part depends only on these interfaces, never on another part's internals.
 * API-facing shapes (Channel, ChannelMessage, Transfer, OwnerItem, McpServer) are the
 * JSON the local HTTP API returns; see docs/PROTOCOL.md §8.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ChatBody, CrocInfo, FileBody, Identity, StatusState } from "@spencer/protocol";
import type { ModelConfig, SpencerConfig, Policy } from "./config.ts";

// ---------------------------------------------------------------- API shapes

/**
 * Whether a member's Spencer is reachable through the channel's relay right now. "unknown": we are not connected to
 * that relay, or it is an older relay without the "presence" feature. For `me`, whether we are connected.
 */
export type Presence = "online" | "offline" | "unknown";

export interface ChannelMember {
  features?: string[];
  id: string;
  name?: string;
  fingerprint: string;
  me: boolean;
  presence: Presence;
  /** When the relay last saw this member's Spencer connected (ms; while online, when it connected). Absent if unknown. */
  lastSeen?: number;
}

export type ChannelTrust = "standard" | "full";

export type ChannelDirectLink = "auto" | "off";
export type P2pStatus = { mode: "files" | "off"; available: boolean; error?: string };
export interface Channel {
  directLink: ChannelDirectLink;
  allowLocalAddresses: boolean;
  id: string;
  kind: "direct" | "group";
  name: string;
  relayUrl: string;
  members: ChannelMember[];
  autoReply: boolean;
  allowedMcpTools: string[];
  /**
   * How far the owner trusts this channel's peers. "standard": peer turns get only notify_owner, ask_owner,
   * propose_file_send and the MCP tools in `allowedMcpTools`; every outgoing file needs approval.
   * "full": peer turns may use every MCP tool, and file sends in this channel need no approval.
   */
  trust: ChannelTrust;
  unread: number;
  lastSeq: number;
  createdAt: number;
}

/**
 * Who made one of our messages: the owner typed it ("human"), the owner's Spencer sent it ("owner-agent"), the channel
 * agent answered a peer ("agent-reply"), or the channel agent reported back on its own after a follow-up it had
 * scheduled ("agent-followup"). Incoming messages are "peer".
 */
export type MessageOrigin = "human" | "owner-agent" | "agent-reply" | "agent-followup" | "peer" | "feature-hello";

export interface ChannelMessage {
  id: string;
  ch: string;
  from: string;
  fromName?: string;
  mine: boolean;
  ts: number;
  seq?: number;
  type: string;
  text?: string;
  hop?: number;
  by?: "human" | "agent";
  replyTo?: string;
  mentions?: string[];
  /** The sender marked the message as the end of the exchange (no answer expected). */
  final?: boolean;
  /** "failed": the relay permanently rejected our message (see `note`); it will not be retried. */
  status: "pending" | "sent" | "received" | "failed";
  /**
   * Why an incoming chat did not trigger a reply ("not addressed", "hop cap", "rate limited", "auto-reply off",
   * "conversation ended").
   */
  note?: string;
  origin?: MessageOrigin;
}

export type TransferDirection = "out" | "in";
export type TransferInitiator = "owner" | "owner-agent" | "peer-agent" | "peer";
export type OutgoingState =
  | "awaiting_approval"
  | "offered"
  | "sending"
  | "completed"
  | "denied"
  | "declined"
  | "failed"
  | "expired"
  | "cancelled";
export type IncomingState =
  | "offered"
  | "accepted"
  | "receiving"
  | "completed"
  | "declined"
  | "failed"
  | "expired"
  | "cancelled";
export const TERMINAL_STATES = new Set(["completed", "denied", "declined", "failed", "expired", "cancelled"]);

export type TransferVia = "link" | "croc";
export interface Transfer {
  via?: TransferVia;
  tid: string;
  ch: string;
  direction: TransferDirection;
  peer: string;
  peerName?: string;
  name: string;
  size: number;
  sha256: string;
  state: OutgoingState | IncomingState;
  attempt: number;
  initiatedBy: TransferInitiator;
  /** Free-text reason given by whoever initiated it (e.g. the peer agent's justification). */
  reason?: string;
  /** Fraction 0–1 while sending/receiving (1 once completed); absent before croc reports anything. */
  progress?: number;
  error?: string;
  /** Local path: staged copy (out) or quarantined file (in, once completed). */
  path?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface OwnerItem {
  id: string;
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  ts: number;
  toolName?: string;
  isError?: boolean;
  /** The text comes from another person's agent (e.g. a peer's reply to something the owner sent): show it as untrusted. */
  untrusted?: boolean;
  /** The note is an owner request (`ask_owner`) the owner can approve or deny: its id. */
  request?: string;
}

/**
 * Something that needs the owner's go-ahead. kind "peer": a peer asked for something the channel agent cannot do
 * (channel tool `ask_owner`); approving hands it to the owner conversation. kind "continue": the channel's turn budget
 * ran out (§7.2) and the channel is paused; approving refills the budget and answers the message that was waiting
 * (`msgId`), denying tells the peer the conversation is paused.
 */
export interface OwnerRequest {
  id: string;
  kind: "peer" | "continue";
  ch: string;
  channelName: string;
  /** Who asked (identity id) and their self-chosen name. */
  from: string;
  fromName?: string;
  /** What the channel agent says the peer wants (written from untrusted peer input), or why the channel paused. */
  text: string;
  /** kind "continue": the incoming message that is waiting for an answer. */
  msgId?: string;
  state: "pending" | "approved" | "denied";
  createdAt: number;
  decidedAt?: number;
}

/** A reminder an agent scheduled on itself (`schedule_followup`), see PROTOCOL.md §7.4. */
export interface Followup {
  id: string;
  /** Which conversation it wakes: the owner's, or a channel's (`ch`). */
  conversation: "owner" | "channel";
  ch?: string;
  /** What the agent wrote for itself (may be based on untrusted peer input). */
  note: string;
  /** When it fires at the latest. */
  dueAt: number;
  /** Owner follow-ups: also fire as soon as a peer writes in this channel. */
  wakeOnReplyIn?: string;
  /** "running": fired, the agent is working on it. */
  state: "pending" | "running" | "done" | "cancelled" | "failed";
  /** How many follow-ups in a row led to this one (0 = scheduled from an ordinary turn). */
  depth: number;
  createdAt: number;
  firedAt?: number;
  firedBy?: "time" | "reply";
  error?: string;
}

export interface McpServerStatus {
  name: string;
  transport: "stdio" | "http";
  status: "connected" | "error" | "disabled" | "connecting";
  error?: string;
  tools: { name: string; description?: string }[];
}

// ---------------------------------------------------------------- events

export type DaemonEvent =
  | { type: "channel"; channel: Channel }
  | { type: "channel_removed"; ch: string }
  | { type: "message"; ch: string; message: ChannelMessage }
  | { type: "transfer"; transfer: Transfer }
  | { type: "owner"; item: OwnerItem }
  | { type: "owner_busy"; busy: boolean }
  | { type: "request"; request: OwnerRequest }
  | { type: "followup"; followup: Followup }
  /** A member's Spencer is working on a reply (`from` may be me). Ephemeral: not stored for the UI. */
  | { type: "status"; ch: string; from: string; replyTo: string; state: StatusState; activity?: string; ts: number }
  /** A relay connection changed: `RelayStatus` (net/relay-client.ts) plus `type`. */
  | {
      type: "relay";
      url: string;
      connected: boolean;
      state: "connected" | "connecting" | "waiting";
      since: number;
      lastConnectedAt?: number;
      retryAt?: number;
      lastError?: string;
      features: string[];
      stun?: string;
    }
  /** A member's Spencer came online or went offline (relay "presence" feature). */
  | { type: "presence"; ch: string; id: string; presence: Presence; lastSeen?: number }
  | { type: "mcp"; servers: McpServerStatus[] }
  | { type: "model"; model: ModelStatus };

export interface EventSink {
  emit(e: DaemonEvent): void;
}

// ---------------------------------------------------------------- core → xfer

/** What the transfer manager needs from the core. */
export interface TransferP2pJob { kill(): void; done: Promise<{ ok: boolean; killed?: boolean; error?: string; resumedFrom?: number }>; }
export interface TransferP2pAdapter {
  canTryLink(ch: string, peerId: string, size: number, hasCroc: boolean): boolean;
  sendOverLink(opts: { tid: string; ch: string; peerId: string; attempt: number; filePath: string; size: number; onReady: () => void; onProgress: (fraction: number) => void }): TransferP2pJob;
  receiveOverLink(opts: { tid: string; ch: string; peerId: string; attempt: number; partPath: string; finalPath: string; size: number; onProgress: (fraction: number) => void }): TransferP2pJob;
}
export interface TransferDeps {
  p2p?: TransferP2pAdapter;
  db: DatabaseSync;
  dataDir: string;
  me: Identity;
  policy: () => Policy;
  /** The channel's trust level ("full" skips approval of outgoing files). Absent: "standard". */
  trust?: (ch: string) => ChannelTrust;
  /**
   * Durably enqueue a file_* body to the channel's outbox. Synchronous: it only inserts a row,
   * so it can be called inside a db transaction (BEGIN/COMMIT) together with a state change.
   */
  enqueue(ch: string, body: FileBody): void;
  /** Croc relay for this channel's relay (relay welcome/join info, overridden by config). */
  crocInfo(ch: string): CrocInfo | undefined;
  /** Symmetric pairwise key with a channel member (protocol pairKey). */
  pairKey(ch: string, peerId: string): Uint8Array;
  /** Channel members except me. */
  peers(ch: string): string[];
  peerName(ch: string, peerId: string): string | undefined;
  crocPath: string;
  /** croc `--throttleUpload` for sends (config `croc.throttleUpload`), e.g. "500k". */
  crocThrottleUpload?: string;
  events: EventSink;
  /**
   * Short informational note for the owner conversation (never starts a model run).
   * `untrusted`: the text contains peer-chosen strings (file names, display names), so the owner's
   * model sees it wrapped as data, not as instructions.
   */
  ownerNote(text: string, opts?: { untrusted?: boolean }): void;
  /** Diagnostic log line (not shown to the owner). */
  log?: (msg: string) => void;
  now?: () => number;
}

export interface TransferRequest {
  path: string;
  /** Recipient identity; optional for direct channels. */
  to?: string;
  initiatedBy: "owner" | "owner-agent" | "peer-agent";
  reason?: string;
  /** Local-only upload retry key; never sent to peers. */
  uploadId?: string;
}

export interface TransferUpload {
  name: string;
  /** Stable across retries after an ambiguous HTTP response. */
  uploadId: string;
  /** Recipient identity; optional for direct channels. */
  to?: string;
  /** Bounded by the transfer service before the existing owner-initiated request path is entered. */
  bytes: AsyncIterable<Uint8Array>;
}

export interface TransferService {
  start(): Promise<void>;
  stop(): Promise<void>;
  request(ch: string, req: TransferRequest): Promise<Transfer>;
  requestUpload(ch: string, upload: TransferUpload): Promise<Transfer>;
  approve(tid: string): Transfer;
  deny(tid: string): Transfer;
  accept(tid: string): Transfer;
  decline(tid: string): Transfer;
  cancel(tid: string): Transfer;
  /** Incoming file_* body from `from` in `ch`. Must be idempotent. */
  onBody(ch: string, from: string, body: FileBody): Promise<void>;
  list(ch?: string): Transfer[];
  get(tid: string): Transfer | undefined;
}

// ---------------------------------------------------------------- core → agent

export interface IncomingChat {
  id: string;
  ch: string;
  seq: number;
  from: string;
  fromName?: string;
  ts: number;
  body: ChatBody;
  channelKind: "direct" | "group";
  channelName: string;
  /** Origin of the local message this one replies to, if it replies to one of ours. */
  replyToOrigin?: MessageOrigin;
  /** Text of the message being replied to, if known. */
  replyToText?: string;
}

export interface OutgoingChat {
  id: string;
  ch: string;
  text: string;
  origin: MessageOrigin;
  ts: number;
}

/** What the agent layer needs from the core. */
export interface CoreServices {
  db: DatabaseSync;
  dataDir: string;
  config: () => SpencerConfig;
  /** Persist a new model choice to config.json (the model page). */
  saveModel?(model: ModelConfig): void;
  me(): { id: string; name: string; fingerprint: string };
  listChannels(): Channel[];
  getChannel(ch: string): Channel | undefined;
  readChannel(ch: string, limit: number): ChannelMessage[];
  /**
   * Durably enqueue a chat message. `idempotencyKey`: a second call with the same key returns the
   * first message's id and enqueues nothing (used for exactly-once replies).
   */
  sendChat(
    ch: string,
    msg: {
      text: string;
      hop: number;
      by: "human" | "agent";
      origin: MessageOrigin;
      replyTo?: string;
      mentions?: string[];
      /** End of the exchange: the peer's agent should not answer (`chat.final`). */
      final?: boolean;
      idempotencyKey?: string;
    },
  ): { id: string };
  requestFileSend(ch: string, req: TransferRequest): Promise<Transfer>;
  /** Tell the channel (and the local UI) that my agent is working on a reply to `replyTo`. Best effort. */
  sendStatus?(ch: string, s: { replyTo: string; state: StatusState; activity?: string }): void;
  listTransfers(ch?: string): Transfer[];
  createInvite(kind: "direct" | "group", name: string, relay?: string): Promise<{ link: string; channel: Channel }>;
  events: EventSink;
}

/** What the core calls on the agent layer. */
export interface AgentService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * An incoming chat from a peer. May be called more than once for the same id (crash recovery);
   * must be idempotent. Resolves once the message is durably handed to the agent runtime (not when
   * the reply is done). Returns the routing note shown in the UI (undefined = will reply).
   */
  onPeerChat(msg: IncomingChat): Promise<{ note?: string }>;
  /** We sent a chat in a channel (owner typed it, or the owner agent sent it): record as channel context. */
  onOutgoingChat(msg: OutgoingChat): Promise<void>;
  ownerSend(text: string): Promise<{ submissionId: string }>;
  ownerTranscript(limit: number): Promise<OwnerItem[]>;
  ownerBusy(): boolean;
  /** Informational note appended to the owner conversation (never starts a run). See TransferDeps.ownerNote. */
  ownerNote(text: string, opts?: { untrusted?: boolean }): Promise<void>;
  /** A channel was created/joined/updated (settings, members): reconfigure its conversation. */
  channelChanged(ch: string): Promise<void>;
  mcpStatus(): McpServerStatus[];
  /** Owner requests (`ask_owner`), newest first. */
  listRequests?(): OwnerRequest[];
  /** Approve (the owner conversation carries it out) or deny a pending request. */
  decideRequest?(id: string, approve: boolean): Promise<OwnerRequest>;
  /** Open follow-ups, then the most recently finished ones. */
  listFollowups?(): Followup[];
  /** The owner cancels a pending follow-up. */
  cancelFollowup?(id: string): Followup;
  /** Which model Spencer thinks with, and the sign-ins behind it. */
  modelStatus?(): ModelStatus | undefined;
  /** Latest model status. */
  refreshModelStatus?(): Promise<ModelStatus>;
  /** Switch the model (persisted to config.json; optional API key saved in secrets/credentials.json mode 0600). */
  setModel?(provider: string, modelId: string, opts?: SetModelOptions): Promise<ModelStatus>;
  /** Start "Sign in with GitHub" for Copilot; progress arrives as `model` events. */
  startCopilotLogin?(): Promise<ModelStatus>;
  cancelCopilotLogin?(): ModelStatus;
  /** Re-fetch the signed-in GitHub Copilot account's live model list. */
  refreshCopilotModels?(): Promise<ModelStatus>;
  copilotLogout?(): Promise<ModelStatus>;
  /** Reuse the GitHub Copilot CLI's saved sign-in for this login. */
  useCopilotCliLogin?(login: string): Promise<ModelStatus>;
}

/** A sign-in in progress ("Sign in with GitHub"), or how the last one ended. */
export interface LoginState {
  state: "waiting" | "connecting" | "failed" | "cancelled";
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  error?: string;
}

export interface SetModelOptions {
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  /** Optional API key saved in `<dataDir>/secrets/credentials.json` (mode 0600; never written to config.json). */
  apiKey?: string;
  /** Delete any saved API key for this provider. */
  clearApiKey?: boolean;
  /** Optional env var name for the API key (saved in config.json). */
  apiKeyEnv?: string;
  /** Optional base URL (required for `openai-compatible`). */
  baseUrl?: string;
}

export interface ModelProviderOption {
  id: string;
  name: string;
  defaultApiKeyEnv?: string;
  hasEnvKey?: boolean;
  hasSavedKey?: boolean;
  custom?: boolean;
  models: { id: string; name: string; reasoning?: boolean }[];
}

export interface ModelStatus {
  provider?: string;
  modelId?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  baseUrl?: string;
  apiKeyEnv?: string;
  /** A model is set up and signed in. */
  ready: boolean;
  /** Why not (never contains a secret). */
  error?: string;
  /** Providers and model catalogs available in the UI picker. */
  providers?: ModelProviderOption[];
  copilot: {
    connected: boolean;
    login?: string;
    plan?: string;
    via?: "device" | "copilot-cli";
    /** Models the account can use (id + display name), when connected. */
    models: { id: string; name: string }[];
    /** Epoch ms of the last successful live `/models` refresh. */
    modelsRefreshedAt?: number;
    /** Last live `/models` refresh error, if any. */
    modelsError?: string;
    /** "Sign in with GitHub" is available (Spencer's GitHub OAuth app is configured). */
    deviceLogin: boolean;
    /** GitHub accounts the Copilot CLI is signed in to on this machine, whose sign-in Spencer can reuse. */
    cliAccounts: string[];
    signIn?: LoginState;
  };
}
