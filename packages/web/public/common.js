// Shared bits used by several views: the view header, presence marks, the live working trace,
// the composer, and loading/empty states.
import { h, icon, iconButton, ago, elapsed, relTime, autoGrow } from "./dom.js";
import { S, attentionCount, presenceOf, workingOf, pendingFollowups, upsertFollowup } from "./state.js";
import { api, attempt, toast } from "./api.js";

export function setSidebarOpen(open) {
  document.getElementById("app")?.classList.toggle("sidebar-open", open);
  const backdrop = document.getElementById("backdrop");
  if (backdrop) backdrop.hidden = !open;
  const btn = document.querySelector(".menu-btn");
  btn?.setAttribute("aria-expanded", String(open));
  if (open) document.querySelector("#sidebar .nav-item.active, #sidebar button")?.focus();
}

// ---------------------------------------------------------------- view header

/** The amber "N need you" link shown in every view header while something waits for the owner. */
function attentionLink() {
  const el = h("a.attn-link", { href: "#/inbox", hidden: true }, icon("inbox", 15), h("span.attn-n"), h("span.attn-word", null, " need you"));
  syncAttentionLink(el);
  return el;
}

function syncAttentionLink(el) {
  const n = attentionCount();
  el.hidden = n === 0 || S.view.name === "inbox";
  el.querySelector(".attn-n").textContent = String(n);
  el.querySelector(".attn-word").textContent = n === 1 ? " needs you" : " need you";
  el.setAttribute("aria-label", `${n} ${n === 1 ? "item needs" : "items need"} your decision. Open Needs you.`);
}

export function syncAttention() {
  for (const el of document.querySelectorAll(".attn-link")) syncAttentionLink(el);
}

/** Top bar of a view: menu button (narrow screens), title content, optional actions on the right. */
export function viewHeader(titleContent, actions = []) {
  const menu = iconButton("menu", "Open sidebar", () => setSidebarOpen(true), "menu-btn");
  menu.setAttribute("aria-controls", "sidebar");
  menu.setAttribute("aria-expanded", "false");
  return h("header.view-header", null, menu, h("div.view-title", null, titleContent), h("div.view-actions", null, attentionLink(), actions));
}

// ---------------------------------------------------------------- presence

/**
 * What to say about a member's Spencer: {state: "working"|"on"|"off", text} or null when nothing is known
 * (my own entry, or a daemon that does not report presence).
 */
export function presenceInfo(member, ch) {
  if (!member || member.me) return null;
  const w = ch && workingOf(ch, member.id);
  if (w) return w.waiting ? { state: "waiting", text: "waiting for its owner" } : { state: "working", text: "working" };
  const p = presenceOf(member);
  if (!p.known) return null;
  if (p.online) return { state: "on", text: "online" };
  if (!p.lastSeenAt) return { state: "off", text: "offline" };
  const a = ago(p.lastSeenAt);
  return { state: "off", text: a === "now" ? "seen just now" : `seen ${a} ago` };
}

const RING = new Set(["working", "thinking", "waiting", "blocked"]);

/**
 * Wrap an avatar so it carries the agent's state. info: {state, text}.
 * working / thinking: a sweeping ring. waiting (on the owner) / blocked: a still amber ring.
 * on / off: a presence dot. The text is the tooltip, so hovering shows the current action.
 */
export function mark(avatarEl, info) {
  const ring = info && RING.has(info.state);
  const el = h(`span.mark${ring ? "." + info.state : ""}`, info?.text ? { title: info.text } : null, avatarEl);
  if (info && !ring && (info.state === "on" || info.state === "off")) el.append(h(`span.pdot.${info.state}`, { role: "img", "aria-label": info.text }));
  const hval = avatarEl.style.getPropertyValue("--h");
  if (hval) el.style.setProperty("--h", hval);
  if (avatarEl.classList.contains("self")) el.classList.add("self");
  return el;
}

// ---------------------------------------------------------------- working trace

/** "Using t3code · thread read…" → {server, tool}; anything else → {text}. */
export function parseActivity(activity) {
  const a = String(activity ?? "").trim();
  const m = /^Using (.+?) · (.+?)…?$/.exec(a);
  if (m) return { server: m[1], tool: m[2] };
  const u = /^Using (.+?)…?$/.exec(a);
  if (u) return { tool: u[1] };
  return { text: a.replace(/…$/, "") || "Working" };
}

/** The activity as nodes, in the machine typeface: server name, then the tool. */
export function activityNode(activity, cls = "") {
  const p = parseActivity(activity);
  if (p.text) return h(`span.act${cls ? "." + cls : ""}`, null, p.text);
  return h(`span.act${cls ? "." + cls : ""}`, null, p.server ? h("span.act-server", null, p.server) : null, h("span.act-tool", null, p.tool));
}

/** One line for tight places (sidebar rows, the members panel). */
export function activityLine(activity) {
  const p = parseActivity(activity);
  return p.text ?? (p.server ? `${p.server} ${p.tool}` : p.tool);
}

/** A finished step, past tense: "Thinking" → "Thought", a tool → "Used server tool". */
function doneStep(activity) {
  const p = parseActivity(activity);
  if (p.text) return h("span.act", null, /^thinking/i.test(p.text) ? "Thought" : p.text);
  return h("span.act", null, h("span.act-verb", null, "Used"), p.server ? h("span.act-server", null, p.server) : null, h("span.act-tool", null, p.tool));
}

/** Which traces have their step log open (the trace is rebuilt on every status event). */
const openLogs = new Set();

/**
 * The live trace of an agent at work: its state and current action, with the log of earlier steps of
 * this run one click away (a summary by default; watching every step is supervising, not delegating).
 * opts: {key?, avatar: Node, name, activity, steps: string[], since: ms, context?: Node}
 */
export function trace({ key, avatar: av, name, activity, steps = [], since, context }) {
  const thinking = /^thinking/i.test(String(activity));
  let log = null;
  if (steps.length) {
    log = h("details.trace-log", { open: !!key && openLogs.has(key) }, h("summary", null, icon("chevron", 12), `${steps.length} earlier ${steps.length === 1 ? "step" : "steps"}`), h("ol.trace-steps", null, steps.map((s) => h("li.done", null, icon("check", 12), doneStep(s)))));
    if (key) log.addEventListener("toggle", () => (log.open ? openLogs.add(key) : openLogs.delete(key)));
  }
  const el = h(
    "div.trace",
    null,
    mark(av, { state: thinking ? "thinking" : "working", text: String(activity).replace(/…$/, "") }),
    h(
      "div.trace-body",
      null,
      h(
        "div.trace-head",
        null,
        h("span.who", null, name),
        h("span.trace-state", null, thinking ? "thinking" : "working"),
        since ? h("time.trace-time", { "data-since": String(since), "aria-hidden": "true" }, elapsed(Date.now() - since)) : null,
        context,
      ),
      h("div.trace-now", null, h("span.now-caret", { "aria-hidden": "true" }), activityNode(activity, "shimmer")),
      log,
    ),
  );
  const hval = av.style.getPropertyValue("--h");
  if (hval) el.style.setProperty("--h", hval);
  if (av.classList.contains("self")) el.classList.add("self");
  return el;
}

// One ticker for every running timer on the page.
setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll("time[data-since]")) el.textContent = elapsed(now - Number(el.dataset.since));
}, 1000);
// Ages ("asked 5 minutes ago") move slowly.
setInterval(() => {
  for (const el of document.querySelectorAll("time[data-rel]")) el.textContent = `asked ${relTime(Number(el.dataset.rel))}`;
}, 30_000);

// ---------------------------------------------------------------- composer

/**
 * A multi-line composer. Enter sends, Shift+Enter adds a line.
 * opts: {placeholder, label, hint?: (string|Node)[], left?: Node, popup?: Node, drafts?: Node, canSend?() → boolean, initialText?: string, onTextChange?(text), isBusy?() → boolean, onKey?(e) → handled, onSend(text) → truthy on success}
 */
export function composer({ placeholder, label, hint, left, popup, drafts, canSend, initialText, onTextChange, isBusy, onKey, onSend }) {
  const input = h("textarea.composer-input", { rows: "1", placeholder, "aria-label": label, enterkeyhint: "send" });
  input.value = initialText ?? "";
  const sendBtn = h("button.send-btn", { type: "submit", "aria-label": "Send", title: "Send (Enter)", disabled: true }, icon("up", 18));
  const form = h("form.composer", null, popup, drafts, h("div.composer-box", null, left, input, sendBtn), hint ? h("p.composer-hint", null, hint) : null);
  let busy = false;
  const sync = () => {
    const externallyBusy = !!isBusy?.();
    sendBtn.disabled = busy || externallyBusy || !(input.value.trim() || canSend?.());
    if (isBusy) input.disabled = busy || externallyBusy;
    autoGrow(input);
  };
  const submit = async () => {
    const text = input.value.trim();
    if (busy || (!text && !canSend?.())) return;
    busy = true;
    input.value = "";
    sync();
    let ok = false;
    try { ok = await onSend(text); } finally { busy = false; }
    if (!ok && !input.value) input.value = text; // sending failed: give the text back
    onTextChange?.(input.value);
    sync();
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  input.addEventListener("keydown", (e) => {
    if (onKey?.(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener("input", () => { onTextChange?.(input.value); sync(); });
  return { form, input, sync };
}

export const SEND_HINT = () => [h("kbd", null, "Enter"), " to send, ", h("kbd", null, "Shift"), " ", h("kbd", null, "Enter"), " for a new line"];

// ---------------------------------------------------------------- transcript stage

/**
 * Wrap a scroller with a "jump to latest" button that shows while the reader is scrolled up.
 * Returns {el, note()}: call note() when something new arrived below the fold.
 */
export function stage(scroller, keeper) {
  const btn = h("button.jump-latest", { type: "button", hidden: true }, icon("down", 14), h("span", null, "Latest"));
  const away = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 240;
  const sync = () => {
    btn.hidden = !away();
    if (btn.hidden) btn.classList.remove("fresh");
  };
  scroller.addEventListener("scroll", sync, { passive: true });
  btn.addEventListener("click", () => {
    keeper.toBottom();
    sync();
  });
  return {
    el: h("div.stage", null, scroller, btn),
    note() {
      if (away()) {
        btn.hidden = false;
        btn.classList.add("fresh");
        btn.lastChild.textContent = "New messages";
      } else btn.lastChild.textContent = "Latest";
    },
  };
}

// ---------------------------------------------------------------- loading and empty states

/** Placeholder rows while a transcript loads. */
export function skeleton(rows = 4) {
  return h(
    "div.skeleton",
    { role: "status", "aria-label": "Loading" },
    Array.from({ length: rows }, (_, i) => h("div.sk-row", null, h("span.sk-avatar"), h("div.sk-lines", null, h("span.sk-line.short"), h(`span.sk-line${i % 2 ? ".mid" : ""}`)))),
  );
}

/** emptyState({icon, title, text, actions}) */
export function emptyState({ icon: name, title, text, actions }) {
  return h("div.empty-state", null, name ? h("span.empty-icon", { "aria-hidden": "true" }, icon(name, 22)) : null, h("h2", null, title), text ? h("p", null, text) : null, actions ? h("div.empty-actions", null, actions) : null);
}

/**
 * Follow-ups a Spencer scheduled on itself ("I'll get back to you"), soonest first, each with a Cancel.
 * where: "owner" or a channel id. Returns null when there are none.
 * The note is the agent's own words, possibly shaped by peer text, so it is shown as plain text.
 */
export function followupList(where, opts = {}) {
  const items = pendingFollowups(where);
  if (!items.length) return null;
  const row = (f) => {
    const cancel = h("button.btn.ghost.xs", { type: "button", title: "Cancel this follow-up" }, "Cancel");
    cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      const res = await attempt(() => api.cancelFollowup(f.id));
      if (res?.id) {
        upsertFollowup(res);
        toast("Follow-up cancelled.", "info");
      } else cancel.disabled = false;
    });
    const when = f.state === "running" ? "now" : f.wakeOnReplyIn ? `on reply, or ${relTime(f.dueAt)}` : relTime(f.dueAt);
    return h(
      `li.followup${f.state === "running" ? ".running" : ""}`,
      null,
      icon("clock", 14),
      h("div.followup-body", null, h("p.followup-note", null, f.note), h("span.followup-when", { title: new Date(f.dueAt).toLocaleString() }, f.state === "running" ? "Running now" : `Due ${when}`)),
      f.state === "pending" ? cancel : null,
    );
  };
  return h(
    `section.followups${opts.compact ? ".compact" : ""}`,
    { "aria-label": "Scheduled follow-ups" },
    h("h2", null, opts.title ?? "Will get back to you", h("span.count", null, String(items.length))),
    h("ul", null, items.map(row)),
  );
}
