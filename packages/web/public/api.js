// Local daemon API client (docs/PROTOCOL.md §8) and the events WebSocket.
import { h, icon, iconButton } from "./dom.js";

const token = document.querySelector('meta[name="spencer-token"]')?.getAttribute("content") ?? "";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = { "X-Spencer-Token": token, Accept: "application/json" };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Can't reach Spencer. Is the daemon running?", 0);
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg = data && typeof data.error === "string" ? data.error : `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  return data ?? {};
}

const enc = encodeURIComponent;

export const api = {
  state: () => request("GET", "/api/state"),
  ownerMessages: (limit = 200) => request("GET", `/api/owner/messages?limit=${limit}`),
  ownerSend: (text) => request("POST", "/api/owner/messages", { text }),
  channelMessages: (ch, limit = 100, before) =>
    request("GET", `/api/channels/${enc(ch)}/messages?limit=${limit}${before !== undefined ? `&before=${enc(before)}` : ""}`),
  channelSend: (ch, text, mentions) => request("POST", `/api/channels/${enc(ch)}/messages`, mentions?.length ? { text, mentions } : { text }),
  patchChannel: (ch, patch) => request("PATCH", `/api/channels/${enc(ch)}`, patch),
  leaveChannel: (ch) => request("DELETE", `/api/channels/${enc(ch)}`),
  createInvite: (kind, name, relay) => request("POST", "/api/invites", { kind, name, ...(relay ? { relay } : {}) }),
  acceptInvite: (link) => request("POST", "/api/invites/accept", { link }),
  transfers: () => request("GET", "/api/transfers"),
  sendFile: (ch, path, to) => request("POST", "/api/transfers", to ? { ch, path, to } : { ch, path }),
  uploadFile: (ch, file, to, uploadId, onProgress) => new Promise((resolve, reject) => {
    const params = new URLSearchParams({ ch, name: file.name, uploadId });
    if (to) params.set("to", to);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/transfers/upload?${params}`);
    xhr.setRequestHeader("X-Spencer-Token", token);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    });
    xhr.addEventListener("load", () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve(data ?? {});
      }
      else reject(new ApiError(data && typeof data.error === "string" ? data.error : `${xhr.status} ${xhr.statusText}`, xhr.status));
    });
    xhr.addEventListener("error", () => reject(new ApiError("Can't reach Spencer. Is the daemon running?", 0)));
    xhr.addEventListener("abort", () => reject(new ApiError("Upload was cancelled", 0)));
    xhr.send(file);
  }),
  transferAction: (tid, action) => request("POST", `/api/transfers/${enc(tid)}/${action}`),
  mcp: () => request("GET", "/api/mcp"),
  cancelFollowup: (id) => request("POST", `/api/followups/${enc(id)}/cancel`),
  decideRequest: (id, approve) => request("POST", `/api/requests/${enc(id)}/${approve ? "approve" : "deny"}`),
  model: () => request("GET", "/api/model"),
  setModel: (provider, modelId, opts = {}) => request("PUT", "/api/model", { provider, modelId, ...opts }),
  copilotLogin: () => request("POST", "/api/auth/github-copilot/login"),
  copilotCancel: () => request("POST", "/api/auth/github-copilot/cancel"),
  copilotRefresh: () => request("POST", "/api/auth/github-copilot/refresh"),
  copilotLogout: () => request("POST", "/api/auth/github-copilot/logout"),
  copilotCli: (login) => request("POST", "/api/auth/github-copilot/cli", { login }),
};

// ---------------------------------------------------------------- toasts

/**
 * toast(message, kind = "error" | "info" | "attn", {action: {label, onClick}, timeout})
 * Errors stay longer than confirmations; hovering or focusing a toast keeps it up; every toast can be dismissed.
 */
export function toast(message, kind = "error", opts = {}) {
  const root = document.getElementById("toasts");
  if (!root) return;
  const leave = () => {
    clearTimeout(timer);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 180);
  };
  const el = h(
    `div.toast.${kind}`,
    { role: kind === "error" ? "alert" : "status" },
    icon(kind === "error" ? "warn" : kind === "attn" ? "inbox" : "check", 16),
    h("span.toast-text", null, String(message)),
    opts.action ? h("button.toast-action", { type: "button", on: { click: () => (leave(), opts.action.onClick()) } }, opts.action.label) : null,
    iconButton("close", "Dismiss", leave, "toast-close"),
  );
  const ms = opts.timeout ?? (kind === "error" ? 8000 : opts.action ? 9000 : 4200);
  let timer = setTimeout(leave, ms);
  const hold = () => clearTimeout(timer);
  const resume = () => (timer = setTimeout(leave, 2500));
  el.addEventListener("mouseenter", hold);
  el.addEventListener("mouseleave", resume);
  el.addEventListener("focusin", hold);
  el.addEventListener("focusout", resume);
  while (root.children.length >= 4) root.firstChild.remove();
  root.append(el);
}

/** Run an API call; on failure show a toast and return undefined. */
export async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

// ---------------------------------------------------------------- events

/**
 * Connect the events WebSocket with exponential backoff.
 * onOpen(isReconnect) runs after every successful connect; onEvent(event) for each event.
 */
export function connectEvents({ onEvent, onOpen, onStatus }) {
  let delay = 1000;
  let connectedOnce = false;
  let ws;
  const connect = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/events?token=${enc(token)}`);
    ws.addEventListener("open", () => {
      delay = 1000;
      onStatus?.(true);
      onOpen?.(connectedOnce);
      connectedOnce = true;
    });
    ws.addEventListener("message", (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev && typeof ev.type === "string") onEvent(ev);
    });
    ws.addEventListener("close", () => {
      onStatus?.(false);
      setTimeout(connect, delay + Math.random() * 300);
      delay = Math.min(delay * 2, 15000);
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* closing anyway */
      }
    });
  };
  connect();
}
