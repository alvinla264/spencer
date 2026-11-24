/**
 * The thin adapter over `@earendil-works/pi-durable` 1.5.2 (and chord). This is the only file that imports
 * them, so API churn stays here. Everything else talks to `AgentRuntime`.
 *
 * Mapping:
 *  - storage: `openNodeSqliteStorage(<dataDir>/pi.sqlite)`, one writer (the core holds the data-dir lock).
 *  - "owner" → the root conversation; "ch:<id>" → one ownerless conversation per channel. The key → id map
 *    lives in `agent_conversations` in core.db.
 *  - tools: every `ToolSpec` becomes a pi-durable tool in one extension ("spencer"), reinstalled in place when
 *    the set changes. Each conversation enables exactly its own tools by name (`configure({ tools })`) and
 *    selects exactly its extensions (channel conversations never select the coding tools). A tool resolves
 *    the conversation key from `api.conversationId` and refuses to run outside the conversations it was
 *    configured for (defense in depth on top of pi-durable's own filtering).
 */
import type { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Models, Message, AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  createRegistry,
  defineExtension,
  defineTool,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type Extension,
  type Registry,
  type SubmissionId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { OwnerAttachment, OwnerItem } from "../contracts.ts";

// ------------------------------------------------------------------ public surface

export interface ToolContext {
  /** "owner" or "ch:<id>": the conversation the call runs in. */
  conversationKey: string;
  /** Unique id of this call (stable across a restart of the same call). */
  callId: string;
  signal?: AbortSignal;
}

export type ToolOutput = string | { text: string; isError?: boolean };

/**
 * A tool. Tools are global by name: two specs with the same name are the same tool, so `execute` must derive
 * per-conversation state from `ctx.conversationKey`, never from a closure over one conversation.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments (an object schema). */
  parameters: object;
  execute(args: any, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ConversationSetup {
  tools: ToolSpec[];
  instructions: string;
  /** Owner only: also enable pi-durable's read/write/edit/bash, running in `cwd` (default: home dir). */
  codingTools?: { cwd?: string };
  /** Reasoning effort ("off", "minimal", "low", "medium", "high"); absent: the model's default. */
  thinkingLevel?: string;
}

export interface NoteInput {
  kind: string;
  data: unknown;
  /** Text the model sees (as a user message). Absent: display only. */
  modelText?: string;
  /** Dedupe key, scoped to the conversation. */
  requestId?: string;
}

export interface InputSubmission {
  content: string;
  requestId: string;
  display?: { kind: string; data: unknown };
}

export type Answer = { status: "done"; text: string } | { status: "unanswered"; reason: string };

export interface WatchHandlers {
  /** New committed transcript items, oldest first. */
  onItems?(items: OwnerItem[]): void;
  onBusy?(busy: boolean): void;
}

export interface AgentRuntime {
  open(): Promise<void>;
  close(): Promise<void>;
  ensureConversation(key: string): Promise<string>;
  configure(key: string, setup: ConversationSetup): Promise<void>;
  submitInput(key: string, input: InputSubmission): Promise<string>;
  appendNote(key: string, note: NoteInput): Promise<void>;
  waitAnswer(submissionId: string): Promise<Answer>;
  transcript(key: string, limit: number): Promise<OwnerItem[]>;
  watch(key: string, handlers: WatchHandlers): Promise<() => Promise<void>>;
  isBusy(key: string): boolean;
  /** Tool names currently offered to the model in a conversation (for tests and diagnostics). */
  offeredTools(key: string): Promise<string[]>;
  /** Submission ids of the inputs the conversation's current run is answering ([] when idle). */
  runningInputs(key: string): Promise<string[]>;
}

export interface PiRuntimeOptions {
  /** Path of the pi-durable SQLite file. */
  file: string;
  /** core.db, for the `agent_conversations` table. */
  db: DatabaseSync;
  /** Current pi-ai models (read at each use). */
  models: () => Models;
  /** Model every conversation runs with; undefined = none configured (runs end `no_model`). */
  model: () => { provider: string; modelId: string } | undefined;
  log?: (msg: string) => void;
}

export const OWNER_KEY = "owner";
export const channelKey = (ch: string) => `ch:${ch}`;
const SPENCER_EXTENSION = "spencer";

// ------------------------------------------------------------------ implementation

export class PiRuntime implements AgentRuntime {
  private opts: PiRuntimeOptions;
  private log: (msg: string) => void;
  private harness: Harness | undefined;
  private registry: Registry = createRegistry();
  private extension: Extension = defineExtension({ name: SPENCER_EXTENSION, tools: [] });
  private specs = new Map<string, ToolSpec>();
  private registrations = new Map<string, ToolRegistration>();
  private keySpecs = new Map<string, ToolSpec[]>();
  private allowed = new Map<string, Set<string>>();
  private keyToConv = new Map<string, ConversationId>();
  private convToKey = new Map<number, string>();
  private ensuring = new Map<string, Promise<ConversationId>>();
  private busy = new Map<string, boolean>();
  private waits = new Set<(reason?: unknown) => void>();
  private watches = new Set<() => Promise<void>>();
  private closed = false;

  constructor(opts: PiRuntimeOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  async open(): Promise<void> {
    const { db } = this.opts;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_conversations (
      key TEXT PRIMARY KEY,
      conv_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    for (const row of db.prepare("SELECT key, conv_id FROM agent_conversations").all() as { key: string; conv_id: number }[]) {
      this.remember(row.key, row.conv_id as ConversationId);
    }
    this.remember(OWNER_KEY, ROOT_CONVERSATION_ID);
    this.registry.install(this.extension);
    this.registry.install(CodingTools);
    // The transcript holds private conversations: owner-only. SQLite creates -wal/-shm with the main file's mode.
    restrictFile(this.opts.file);
    const storage = await openNodeSqliteStorage(this.opts.file);
    restrictFile(this.opts.file);
    this.harness = await Harness.open(
      storage,
      {
        models: () => this.opts.models(),
        registry: this.registry,
        identity: { attribution: null },
        settings: {
          // Our own channel conversations must not stall behind a failed run: queued peer inputs go on.
          afterFailedRun: "continue",
          // Only explicitly selected extensions; channel conversations select only "spencer".
          extensions: [this.extension],
        },
        // Only the owner conversation gets an execution environment (for the optional coding tools).
        env: ({ conversationId, cwd }) =>
          conversationId === ROOT_CONVERSATION_ID ? new NodeExecutionEnv({ cwd: cwd ?? homedir() }) : undefined,
        onReport: (r) => this.log(`pi-durable ${r.kind}: ${errText(r.error)}`),
      },
      BACKGROUND_CONTEXT,
    );
    await this.harness.root(BACKGROUND_CONTEXT);
    // Continue runs (and tool calls) the last process left unfinished.
    this.harness.resume();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of [...this.waits]) cancel(new Error("runtime closing"));
    this.waits.clear();
    for (const stop of [...this.watches]) await stop().catch(() => {});
    this.watches.clear();
    const h = this.harness;
    this.harness = undefined;
    if (h) await h.close(BACKGROUND_CONTEXT);
  }

  private h(): Harness {
    if (!this.harness || this.closed) throw new Error("agent runtime is not open");
    return this.harness;
  }

  private remember(key: string, id: ConversationId): void {
    this.keyToConv.set(key, id);
    this.convToKey.set(id as number, key);
  }

  async ensureConversation(key: string): Promise<string> {
    return String(await this.convId(key));
  }

  private async convId(key: string): Promise<ConversationId> {
    if (key === OWNER_KEY) return ROOT_CONVERSATION_ID;
    if (!key.startsWith("ch:")) throw new Error(`bad conversation key: ${key}`);
    const pending = this.ensuring.get(key);
    if (pending) return pending;
    const p = (async () => {
      const known = this.keyToConv.get(key);
      if (known !== undefined && (await this.h().conversation(known, BACKGROUND_CONTEXT))) return known;
      // Unknown, or pi.sqlite was replaced: create it. A crash before the insert leaves an unused conversation.
      const conv = await this.h().createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
      this.opts.db
        .prepare("INSERT OR REPLACE INTO agent_conversations (key, conv_id, created_at) VALUES (?, ?, ?)")
        .run(key, conv.id as number, Date.now());
      this.remember(key, conv.id);
      return conv.id;
    })();
    this.ensuring.set(key, p);
    try {
      return await p;
    } finally {
      this.ensuring.delete(key);
    }
  }

  private async conversation(key: string): Promise<Conversation> {
    const id = await this.convId(key);
    const conv = id === ROOT_CONVERSATION_ID ? await this.h().root(BACKGROUND_CONTEXT) : await this.h().conversation(id, BACKGROUND_CONTEXT);
    if (!conv) throw new Error(`conversation ${key} not found`);
    return conv;
  }

  async configure(key: string, setup: ConversationSetup): Promise<void> {
    const conv = await this.conversation(key);
    this.keySpecs.set(key, setup.tools);
    this.allowed.set(key, new Set(setup.tools.map((t) => t.name)));
    this.reinstall();
    const regs = setup.tools.map((t) => this.registrations.get(t.name)!);
    const coding = key === OWNER_KEY && setup.codingTools !== undefined;
    const tools: ToolRegistration[] = coding ? [...regs, ...(CodingTools.tools ?? [])] : regs;
    const extensions: Extension[] = coding ? [this.extension, CodingTools] : [this.extension];
    const model = this.opts.model();
    // Skip the commit when nothing changed (start() configures every conversation each time).
    const current = await conv.agent(BACKGROUND_CONTEXT);
    const same =
      current.instructions === setup.instructions &&
      sameList(current.extensions.map((e) => e.name), extensions.map((e) => e.name)) &&
      sameList(current.tools.map((t) => t.name), tools.map((t) => t.name)) &&
      current.model?.provider === model?.provider &&
      current.model?.modelId === model?.modelId &&
      (setup.thinkingLevel === undefined || current.thinkingLevel === setup.thinkingLevel) &&
      (current.cwd ?? undefined) === (coding ? setup.codingTools?.cwd : undefined);
    if (same) return;
    await conv.configure(
      {
        model: model ?? null,
        extensions,
        tools,
        instructions: setup.instructions,
        cwd: coding ? (setup.codingTools?.cwd ?? null) : null,
        ...(setup.thinkingLevel !== undefined ? { thinkingLevel: setup.thinkingLevel as never } : {}),
      },
      BACKGROUND_CONTEXT,
    );
  }

  /** Rebuild the "spencer" extension from the union of every conversation's tools; replaces it in place. */
  private reinstall(): void {
    const union = new Map<string, ToolSpec>();
    for (const list of this.keySpecs.values()) for (const t of list) union.set(t.name, t);
    let changed = union.size !== this.specs.size;
    for (const [name, spec] of union) {
      if (this.specs.get(name) !== spec) changed = true;
      this.specs.set(name, spec);
      if (!this.registrations.has(name) || this.registrations.get(name)!.description !== spec.description) {
        this.registrations.set(name, this.toRegistration(spec));
        changed = true;
      }
    }
    for (const name of [...this.specs.keys()]) {
      if (!union.has(name)) {
        this.specs.delete(name);
        this.registrations.delete(name);
        changed = true;
      }
    }
    if (!changed) return;
    this.extension = defineExtension({ name: SPENCER_EXTENSION, tools: [...this.registrations.values()] });
    this.registry.install(this.extension);
  }

  private toRegistration(spec: ToolSpec): ToolRegistration {
    const name = spec.name;
    return defineTool<object>({
      name,
      description: spec.description,
      parameters: spec.parameters,
      execute: async (args, api, context) => {
        const key = this.convToKey.get(api.conversationId as number);
        const current = this.specs.get(name);
        if (!key || !current || !this.allowed.get(key)?.has(name)) {
          return { output: [{ type: "text", text: `Tool ${name} is not available in this conversation.` }], isError: true };
        }
        const out = await current.execute(args, { conversationKey: key, callId: api.callId, signal: context.abortSignal });
        const r = typeof out === "string" ? { text: out } : out;
        return { output: [{ type: "text", text: r.text }], isError: r.isError === true };
      },
    });
  }

  async submitInput(key: string, input: InputSubmission): Promise<string> {
    const conv = await this.conversation(key);
    const s = await conv.submit(
      {
        type: "input",
        content: input.content,
        requestId: input.requestId,
        ...(input.display ? { entry: { kind: input.display.kind, data: toJson(input.display.data) } } : {}),
      },
      BACKGROUND_CONTEXT,
    );
    return String(s.id);
  }

  async appendNote(key: string, note: NoteInput): Promise<void> {
    const conv = await this.conversation(key);
    const model: Message[] | undefined = note.modelText
      ? [{ role: "user", content: note.modelText, timestamp: Date.now() }]
      : undefined;
    await conv.submit(
      {
        type: "write",
        entry: { kind: note.kind, data: toJson(note.data), ...(model ? { model } : {}) },
        ...(note.requestId ? { requestId: note.requestId } : {}),
      },
      BACKGROUND_CONTEXT,
    );
  }

  async waitAnswer(submissionId: string): Promise<Answer> {
    const h = this.h();
    const s = await h.submission(Number(submissionId) as SubmissionId, BACKGROUND_CONTEXT);
    if (!s) return { status: "unanswered", reason: "unknown submission" };
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
    this.waits.add(cancel);
    try {
      const settled = await s.wait(context);
      if (settled.status !== "done" || settled.type === "write") {
        if (settled.status === "done") return { status: "unanswered", reason: "not an input" };
        const detail = settled.detail === undefined ? "" : `: ${typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)}`;
        return { status: "unanswered", reason: `${settled.reason}${detail}` };
      }
      const conv = await h.conversation(settled.conversationId, BACKGROUND_CONTEXT);
      const page = conv
        ? await conv.entries({ minEntryId: settled.answer, maxEntryId: settled.answer }, 1, undefined, BACKGROUND_CONTEXT)
        : undefined;
      const entry = page?.items[0];
      const msg = AssistantEntry.is(entry) ? entry.model?.[0] : undefined;
      return { status: "done", text: msg && msg.role === "assistant" ? assistantText(msg) : "" };
    } finally {
      this.waits.delete(cancel);
    }
  }

  async transcript(key: string, limit: number): Promise<OwnerItem[]> {
    const conv = await this.conversation(key);
    const page = await conv.entries({ order: "descending" }, Math.max(1, Math.min(limit, 500)) * 2, undefined, BACKGROUND_CONTEXT);
    const items = [...page.items].reverse().flatMap(entryItems);
    return items.slice(-limit);
  }

  async watch(key: string, handlers: WatchHandlers): Promise<() => Promise<void>> {
    const conv = await this.conversation(key);
    const watch = await conv.watch(BACKGROUND_CONTEXT);
    let last = maxId(watch.value.entries);
    let busy = Boolean(watch.value.docs["pi.live"]?.run);
    this.busy.set(key, busy);
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      const fresh = call.value.entries.filter((e) => (e.id as number) > last);
      if (fresh.length) {
        last = maxId(fresh);
        const items = fresh.flatMap(entryItems);
        if (items.length) handlers.onItems?.(items);
      }
      const nowBusy = Boolean(call.value.docs["pi.live"]?.run);
      if (nowBusy !== busy) {
        busy = nowBusy;
        this.busy.set(key, busy);
        handlers.onBusy?.(busy);
      }
    });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      this.watches.delete(stop);
      await watch.stop();
    };
    this.watches.add(stop);
    return stop;
  }

  isBusy(key: string): boolean {
    return this.busy.get(key) ?? false;
  }

  async runningInputs(key: string): Promise<string[]> {
    const live = await this.h().snapshot(LiveDoc, await this.convId(key), BACKGROUND_CONTEXT);
    return (live?.run?.inputs ?? []).map((id) => String(id));
  }

  async offeredTools(key: string): Promise<string[]> {
    const conv = await this.conversation(key);
    return (await conv.agent(BACKGROUND_CONTEXT)).tools.map((t) => t.name);
  }
}

// ------------------------------------------------------------------ helpers

/** Creates `file` (empty) with mode 0600 if missing, and chmods it and its -wal/-shm/-journal files to 0600. */
export function restrictFile(file: string): void {
  if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      if (existsSync(f)) chmodSync(f, 0o600);
    } catch {
      /* best effort */
    }
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function maxId(entries: readonly EntryRecord[]): number {
  let m = 0;
  for (const e of entries) m = Math.max(m, e.id as number);
  return m;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** JSON-safe copy (pi-durable stores JSON values only). */
function toJson(v: unknown): any {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

export function assistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as any).type === "text" ? String((b as any).text) : b?.type === "image" ? "[image]" : ""))
      .join("");
  }
  return "";
}

function short(s: string, n = 500): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Transcript entry → owner UI items. Our notes carry `{ text, ts, isError?, untrusted?, role? }` in `data`. */
function entryItems(e: EntryRecord): OwnerItem[] {
  const id = String(e.id);
  const msg = e.model?.[0];
  const ts = (msg && "timestamp" in msg ? (msg.timestamp as number) : undefined) ?? Number((e.data as any)?.ts ?? 0);
  switch (e.kind) {
    case "pi.system":
    case "pi.reset":
      return [];
    case "pi.user":
    case "spencer.owner-input": {
      const data = (e.data ?? {}) as { text?: unknown; attachments?: unknown };
      const item: OwnerItem = { id, role: "user", text: typeof data.text === "string" ? data.text : contentText(msg?.content), ts };
      if (Array.isArray(data.attachments)) {
        item.attachments = data.attachments.filter((file): file is OwnerAttachment =>
          !!file && typeof file === "object" && typeof (file as OwnerAttachment).id === "string" &&
          typeof (file as OwnerAttachment).name === "string" && Number.isSafeInteger((file as OwnerAttachment).size),
        );
      }
      return [item];
    }
    case "pi.assistant": {
      if (!msg || msg.role !== "assistant") return [];
      const am = msg as AssistantMessage;
      const out: OwnerItem[] = [];
      const text = assistantText(am);
      if (text) out.push({ id, role: "assistant", text, ts });
      if (am.stopReason === "error" || am.stopReason === "aborted") {
        out.push({ id: `${id}.err`, role: "assistant", text: `Model ${am.stopReason}: ${am.errorMessage ?? "no details"}`, ts, isError: true });
      }
      am.content.forEach((b, i) => {
        if (b.type === "toolCall") {
          out.push({ id: `${id}.${i}`, role: "tool", toolName: b.name, text: short(`call ${JSON.stringify(b.arguments)}`, 300), ts });
        }
      });
      return out;
    }
    case "pi.tool-result": {
      if (!msg || msg.role !== "toolResult") return [];
      const tr = msg as ToolResultMessage;
      return [{ id, role: "tool", toolName: tr.toolName, text: short(contentText(tr.content)), ts, isError: tr.isError }];
    }
    case "pi.compaction":
      return [{ id, role: "note", text: "(earlier conversation summarized)", ts }];
    default: {
      // Our own kinds: notes, peer messages, errors.
      const d = (e.data ?? {}) as { text?: string; ts?: number; isError?: boolean; untrusted?: boolean; request?: string; role?: OwnerItem["role"] };
      const text = d.text ?? contentText(msg?.content);
      if (!text) return [];
      const role = d.role ?? "note";
      const item: OwnerItem = { id, role, text, ts: d.ts ?? ts };
      if (d.isError) item.isError = true;
      if (d.untrusted) item.untrusted = true;
      if (typeof d.request === "string") item.request = d.request;
      return [item];
    }
  }
}
