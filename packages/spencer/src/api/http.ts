import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentService, Channel, ChannelMessage, CoreServices, TransferService } from "../contracts.ts";
import type { EventBus } from "../events.ts";
import { UserError } from "../channels.ts";
import { RelayError } from "../net/relay-client.ts";

/** What the HTTP layer needs from the daemon. */
export interface ApiBackend {
  token: string;
  log: (m: string) => void;
  events: EventBus;
  core: CoreServices;
  agent(): AgentService;
  transfers(): TransferService;
  state(): unknown;
  channelMessages(ch: string, limit: number, before?: string): ChannelMessage[];
  updateChannel(ch: string, patch: Record<string, unknown>): Channel;
  leaveChannel(ch: string): Promise<void>;
  acceptInvite(link: string): Promise<Channel>;
  /** Absolute path of the static UI, or undefined for the placeholder page. */
  webRoot?: string;
}

const MAX_BODY = 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 3;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const PLACEHOLDER = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="spencer-token" content="__SPENCER_TOKEN__"><title>Spencer</title></head>
<body style="font-family:system-ui;max-width:40em;margin:3em auto;padding:0 1em">
<h1>Spencer is running</h1><p>The web UI package is not installed. The local API is available under <code>/api</code>.</p>
</body></html>
`;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

function errorStatus(e: unknown): number {
  if (e instanceof HttpError || e instanceof UserError) return e.status;
  const err = e as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  for (const s of [err?.status, err?.statusCode]) {
    if (typeof s === "number" && s >= 400 && s < 600) return s;
  }
  if (e instanceof RelayError) {
    switch (e.code) {
      case "full":
        return 409;
      case "not_member":
      case "no_channel":
        return 404;
      case "bad_request":
      case "bad_proof":
      case "too_large":
        return 400;
      case "unreachable":
      case "timeout":
      case "disconnected":
      case "closed":
        return 503;
      default:
        return 502;
    }
  }
  if (err?.code === "ENOENT") return 404;
  if (err?.code === "EACCES" || err?.code === "EISDIR") return 400;
  const msg = typeof err?.message === "string" ? err.message : "";
  if (/\b(upload limit)\b/i.test(msg)) return 413;
  if (/\bnot found\b|\bunknown (channel|transfer|message)\b|\bno such\b/i.test(msg)) return 404;
  if (/\b(invalid|required|must|too (large|long|big)|not allowed|missing)\b/i.test(msg)) return 400;
  if (/\b(state|already|cannot .* in)\b/i.test(msg)) return 409;
  return 500;
}

function tokenEq(a: string | undefined, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function* boundedUpload(req: IncomingMessage): AsyncGenerator<Uint8Array> {
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_UPLOAD_BYTES) {
      tooLarge = true;
      continue; // Drain the request without staging more bytes so the daemon can return a useful 413.
    }
    yield chunk;
  }
  if (tooLarge) throw new Error("file exceeds the 25 MiB upload limit");
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        reject(new HttpError(413, "request body too large"));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolvePromise({});
      try {
        const v = JSON.parse(text) as unknown;
        if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
        resolvePromise(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "body must be a JSON object"));
      }
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

function intParam(v: string | null, def: number, max: number): number {
  if (v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "invalid limit");
  return Math.min(n, max);
}

export class ApiServer {
  private b: ApiBackend;
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private unsub: (() => void) | undefined;
  private _port = 0;
  private activeUploads = 0;

  constructor(backend: ApiBackend) {
    this.b = backend;
  }

  get port(): number {
    return this._port;
  }

  private allowedHosts(): Set<string> {
    return new Set([`127.0.0.1:${this._port}`, `localhost:${this._port}`]);
  }

  private allowedOrigins(): Set<string> {
    return new Set([`http://127.0.0.1:${this._port}`, `http://localhost:${this._port}`]);
  }

  private securityHeaders(): Record<string, string> {
    const p = this._port;
    return {
      "Content-Security-Policy": `default-src 'self'; connect-src 'self' ws://127.0.0.1:${p} ws://localhost:${p}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
    };
  }

  async listen(port: number): Promise<number> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e: Error) => {
        this.b.log(`http: ${e.stack ?? e.message}`);
        if (!res.headersSent) this.sendJson(res, 500, { error: "internal error" });
        else res.destroy();
      });
    });
    server.headersTimeout = 20_000;
    server.requestTimeout = 60_000;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
    this.unsub = this.b.events.subscribe((e) => {
      if (!this.wss) return;
      const data = JSON.stringify(e);
      for (const ws of this.wss.clients) {
        if (ws.readyState === ws.OPEN) ws.send(data);
      }
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    this.server = server;
    const addr = server.address();
    this._port = typeof addr === "object" && addr ? addr.port : port;
    return this._port;
  }

  async close(): Promise<void> {
    this.unsub?.();
    this.unsub = undefined;
    if (this.wss) {
      for (const ws of this.wss.clients) ws.terminate();
      await new Promise<void>((r) => this.wss!.close(() => r()));
      this.wss = undefined;
    }
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    }
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!this.allowedHosts().has(req.headers.host ?? "")) return reject(403, "Forbidden");
    const origin = req.headers.origin;
    if (origin !== undefined && !this.allowedOrigins().has(origin)) return reject(403, "Forbidden");
    if (url.pathname !== "/api/events") return reject(404, "Not Found");
    const tok = url.searchParams.get("token") ?? (req.headers["x-spencer-token"] as string | undefined);
    if (!tokenEq(tok ?? undefined, this.b.token)) return reject(401, "Unauthorized");
    this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      ws.on("error", () => {});
      ws.on("message", () => {
        /* server → client only */
      });
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      ...this.securityHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": data.length,
    });
    res.end(data);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowedHosts().has(req.headers.host ?? "")) {
      return this.sendJson(res, 403, { error: "forbidden host" });
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this._port}`);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (!tokenEq(req.headers["x-spencer-token"] as string | undefined, this.b.token)) {
        return this.sendJson(res, 401, { error: "missing or invalid X-Spencer-Token" });
      }
      try {
        const out = await this.route(req.method ?? "GET", url, req);
        if (out === NOT_FOUND) return this.sendJson(res, 404, { error: "not found" });
        return this.sendJson(res, 200, out);
      } catch (e) {
        const status = errorStatus(e);
        if (status >= 500) this.b.log(`api ${req.method} ${url.pathname}: ${(e as Error).stack ?? String(e)}`);
        return this.sendJson(res, status, { error: (e as Error)?.message || "error" });
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return this.sendJson(res, 405, { error: "method not allowed" });
    return this.serveStatic(url.pathname, req, res);
  }

  private async route(method: string, url: URL, req: IncomingMessage): Promise<unknown> {
    const p = url.pathname.replace(/\/+$/, "");
    const q = url.searchParams;
    const b = this.b;
    let m: RegExpExecArray | null;

    if (p === "/api/state" && method === "GET") return b.state();

    if (p === "/api/owner/messages") {
      if (method === "GET") return { items: await b.agent().ownerTranscript(intParam(q.get("limit"), 200, 2000)) };
      if (method === "POST") {
        const body = await readJson(req);
        if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text is required");
        if (body.text.length > 100_000) throw new HttpError(400, "text too long");
        return await b.agent().ownerSend(body.text);
      }
    }

    if (p === "/api/requests" && method === "GET") return { items: b.agent().listRequests?.() ?? [] };
    if (p === "/api/followups" && method === "GET") return { items: b.agent().listFollowups?.() ?? [] };
    if ((m = /^\/api\/followups\/([A-Za-z0-9_-]{1,64})\/cancel$/.exec(p)) && method === "POST") {
      const agent = b.agent();
      if (!agent.cancelFollowup) throw new HttpError(404, "follow-ups are not supported");
      return agent.cancelFollowup(m[1]!);
    }
    if ((m = /^\/api\/requests\/([A-Za-z0-9_-]{1,64})\/(approve|deny)$/.exec(p)) && method === "POST") {
      const agent = b.agent();
      if (!agent.decideRequest) throw new HttpError(404, "requests are not supported");
      return await agent.decideRequest(m[1]!, m[2] === "approve");
    }

    if (p === "/api/channels" && method === "GET") return { items: b.core.listChannels() };

    if ((m = /^\/api\/channels\/([A-Za-z0-9_-]{1,64})\/messages$/.exec(p))) {
      const ch = m[1];
      if (!b.core.getChannel(ch)) throw new HttpError(404, "unknown channel");
      if (method === "GET") {
        return { items: b.channelMessages(ch, intParam(q.get("limit"), 100, 1000), q.get("before") || undefined) };
      }
      if (method === "POST") {
        const body = await readJson(req);
        if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text is required");
        if (body.mentions !== undefined && (!Array.isArray(body.mentions) || !body.mentions.every((x) => typeof x === "string"))) {
          throw new HttpError(400, "mentions must be an array of identity ids");
        }
        return b.core.sendChat(ch, {
          text: body.text,
          hop: 0,
          by: "human",
          origin: "human",
          ...(body.mentions !== undefined ? { mentions: body.mentions as string[] } : {}),
        });
      }
    }

    if ((m = /^\/api\/channels\/([A-Za-z0-9_-]{1,64})$/.exec(p))) {
      const ch = m[1];
      if (method === "GET") {
        const c = b.core.getChannel(ch);
        if (!c) throw new HttpError(404, "unknown channel");
        return c;
      }
      if (method === "PATCH") return b.updateChannel(ch, await readJson(req));
      if (method === "DELETE") {
        await b.leaveChannel(ch);
        return {};
      }
    }

    if (p === "/api/invites" && method === "POST") {
      const body = await readJson(req);
      if (body.relay !== undefined && typeof body.relay !== "string") throw new UserError(400, "relay must be a string");
      return await b.core.createInvite(body.kind as "direct" | "group", body.name as string, body.relay as string | undefined);
    }
    if (p === "/api/invites/accept" && method === "POST") {
      const body = await readJson(req);
      if (typeof body.link !== "string") throw new HttpError(400, "link is required");
      return { channel: await b.acceptInvite(body.link) };
    }

    if (p === "/api/transfers/upload" && method === "POST") {
      const ch = q.get("ch");
      const name = q.get("name");
      const to = q.get("to") ?? undefined;
      const uploadId = q.get("uploadId");
      if (!ch || !b.core.getChannel(ch)) throw new HttpError(400, "ch must be a known channel");
      if (!uploadId || !/^[A-Za-z0-9_-]{16,64}$/.test(uploadId)) throw new HttpError(400, "uploadId must be a valid retry id");
      if (!name?.trim() || Buffer.byteLength(name, "utf8") > 255) throw new HttpError(400, "filename must be between 1 and 255 bytes");
      if (to !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(to)) throw new HttpError(400, "to must be an identity id");
      if (!/^application\/octet-stream(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        throw new HttpError(415, "content-type must be application/octet-stream");
      }
      const contentLength = req.headers["content-length"];
      if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_UPLOAD_BYTES)) {
        throw new HttpError(413, "file exceeds the 25 MiB upload limit");
      }
      if (this.activeUploads >= MAX_CONCURRENT_UPLOADS) throw new HttpError(429, "too many active uploads; try again shortly");
      this.activeUploads++;
      try {
        return await b.transfers().requestUpload(ch, { name, uploadId, bytes: boundedUpload(req), ...(to ? { to } : {}) });
      } finally {
        this.activeUploads--;
      }
    }

    if (p === "/api/transfers") {
      if (method === "GET") return { items: b.transfers().list(q.get("ch") || undefined) };
      if (method === "POST") {
        const body = await readJson(req);
        if (typeof body.ch !== "string" || !b.core.getChannel(body.ch)) throw new HttpError(400, "ch must be a known channel");
        if (typeof body.path !== "string" || !body.path) throw new HttpError(400, "path is required");
        if (body.to !== undefined && typeof body.to !== "string") throw new HttpError(400, "to must be an identity id");
        return await b.transfers().request(body.ch, {
          path: body.path,
          initiatedBy: "owner",
          ...(body.to !== undefined ? { to: body.to as string } : {}),
        });
      }
    }
    if ((m = /^\/api\/transfers\/([A-Za-z0-9_-]{1,64})$/.exec(p)) && method === "GET") {
      const t = b.transfers().get(m[1]);
      if (!t) throw new HttpError(404, "unknown transfer");
      return t;
    }
    if ((m = /^\/api\/transfers\/([A-Za-z0-9_-]{1,64})\/(approve|deny|accept|decline|cancel)$/.exec(p)) && method === "POST") {
      const tid = m[1];
      const t = b.transfers();
      if (!t.get(tid)) throw new HttpError(404, "unknown transfer");
      switch (m[2]) {
        case "approve":
          return t.approve(tid);
        case "deny":
          return t.deny(tid);
        case "accept":
          return t.accept(tid);
        case "decline":
          return t.decline(tid);
        case "cancel":
          return t.cancel(tid);
      }
    }

    if (p === "/api/mcp" && method === "GET") return { servers: b.agent().mcpStatus() };

    if (p === "/api/model") {
      const agent = b.agent();
      if (!agent.refreshModelStatus || !agent.setModel) throw new HttpError(404, "model settings are not supported");
      if (method === "GET") return await agent.refreshModelStatus();
      if (method === "PUT") {
        const body = await readJson(req);
        if (typeof body.provider !== "string" || typeof body.modelId !== "string") throw new HttpError(400, "provider and modelId are required");
        const opts: import("../contracts.ts").SetModelOptions = {};
        if (body.thinking !== undefined) {
          if (typeof body.thinking !== "string") throw new HttpError(400, "thinking must be a string");
          opts.thinking = body.thinking as import("../contracts.ts").SetModelOptions["thinking"];
        }
        if (body.apiKey !== undefined) {
          if (typeof body.apiKey !== "string") throw new HttpError(400, "apiKey must be a string");
          opts.apiKey = body.apiKey;
        }
        if (body.clearApiKey !== undefined) {
          if (typeof body.clearApiKey !== "boolean") throw new HttpError(400, "clearApiKey must be a boolean");
          opts.clearApiKey = body.clearApiKey;
        }
        if (body.apiKeyEnv !== undefined) {
          if (typeof body.apiKeyEnv !== "string") throw new HttpError(400, "apiKeyEnv must be a string");
          opts.apiKeyEnv = body.apiKeyEnv;
        }
        if (body.baseUrl !== undefined) {
          if (typeof body.baseUrl !== "string") throw new HttpError(400, "baseUrl must be a string");
          opts.baseUrl = body.baseUrl;
        }
        return await agent.setModel(body.provider, body.modelId, opts);
      }
    }
    if ((m = /^\/api\/auth\/github-copilot\/(login|cancel|refresh|logout|cli)$/.exec(p)) && method === "POST") {
      const agent = b.agent();
      if (!agent.startCopilotLogin || !agent.cancelCopilotLogin || !agent.copilotLogout) {
        throw new HttpError(404, "sign-in is not supported");
      }
      switch (m[1]) {
        case "login":
          return await agent.startCopilotLogin();
        case "cancel":
          return agent.cancelCopilotLogin();
        case "refresh":
          if (!agent.refreshCopilotModels) throw new HttpError(404, "refresh is not supported");
          return await agent.refreshCopilotModels();
        case "logout":
          return await agent.copilotLogout();
        case "cli": {
          if (!agent.useCopilotCliLogin) throw new HttpError(404, "Copilot CLI sign-in is not supported");
          const body = await readJson(req);
          if (typeof body.login !== "string" || !body.login) throw new HttpError(400, "login is required");
          return await agent.useCopilotCliLogin(body.login);
        }
      }
    }

    return NOT_FOUND;
  }

  private async serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const root = this.b.webRoot;
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return this.sendJson(res, 400, { error: "bad path" });
    }
    if (rel.includes("\0")) return this.sendJson(res, 400, { error: "bad path" });
    if (rel === "/" || rel === "") rel = "/index.html";
    const isIndex = rel === "/index.html";

    let data: Buffer | undefined;
    let type = MIME[extname(rel).toLowerCase()] ?? "application/octet-stream";
    if (root) {
      const base = resolve(root);
      const file = resolve(join(base, rel));
      if (file !== base && !file.startsWith(base + sep)) return this.sendJson(res, 403, { error: "forbidden" });
      try {
        const st = await stat(file);
        if (st.isFile()) data = await readFile(file);
      } catch {
        /* not found */
      }
      if (!data && !extname(rel)) {
        // SPA fallback for client-side routes.
        try {
          data = await readFile(join(base, "index.html"));
          type = MIME[".html"];
          return this.sendHtml(res, req, data);
        } catch {
          /* no index */
        }
      }
    }
    if (!data && isIndex) return this.sendHtml(res, req, Buffer.from(PLACEHOLDER));
    if (!data) return this.sendJson(res, 404, { error: "not found" });
    if (isIndex) return this.sendHtml(res, req, data);
    res.writeHead(200, { ...this.securityHeaders(), "Cache-Control": "no-cache", "Content-Type": type, "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  private sendHtml(res: ServerResponse, req: IncomingMessage, raw: Buffer): void {
    const html = Buffer.from(raw.toString("utf8").replaceAll("__SPENCER_TOKEN__", this.b.token));
    res.writeHead(200, { ...this.securityHeaders(), "Cache-Control": "no-cache", "Content-Type": MIME[".html"], "Content-Length": html.length });
    res.end(req.method === "HEAD" ? undefined : html);
  }
}

const NOT_FOUND = Symbol("not found");
