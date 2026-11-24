// Transfer cards (used inline in channels and in the Transfers view) and the Transfers view.
import { h, icon, humanSize, relTime, timeShort, timeFull, copyText, iconButton } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { S, TERMINAL, on, needsAction, upsertTransfer, channelTitle, setTransfers } from "./state.js";
import { viewHeader, emptyState } from "./common.js";
import { markdown } from "./md.js";
import { openModal } from "./modal.js";

const STATE_LABEL = {
  awaiting_approval: "needs approval",
  offered: "offered",
  accepted: "accepted",
  sending: "sending",
  receiving: "receiving",
  completed: "completed",
  denied: "denied",
  declined: "declined",
  failed: "failed",
  expired: "expired",
  cancelled: "cancelled",
};

function stateTone(t) {
  if (needsAction(t)) return "warn";
  if (t.state === "completed") return "ok";
  if (t.state === "failed") return "bad";
  if (TERMINAL.has(t.state)) return "muted";
  return "info";
}

function peerLabel(t) {
  return t.peerName || `${t.peer.slice(0, 8)}…`;
}

function initiatorLine(t) {
  const reason = t.reason ? `: “${t.reason}”` : "";
  switch (t.initiatedBy) {
    case "peer-agent":
      return h("p.xfer-initiator.peer-agent", null, icon("warn", 14), h("span", null, `${peerLabel(t)} asked for this (their agent, not the person)${reason}`));
    case "owner-agent":
      return h("p.xfer-initiator", null, `Your Spencer started this${reason}`);
    case "peer":
      return t.direction === "in" ? null : h("p.xfer-initiator", null, `${peerLabel(t)} asked for this${reason}`);
    default:
      return reason ? h("p.xfer-initiator", null, `You started this${reason}`) : null;
  }
}

/** `Transfer.progress` is a fraction 0–1 (PROTOCOL §8). */
function progressFraction(p) {
  if (typeof p !== "number" || !Number.isFinite(p)) return undefined;
  return Math.min(Math.max(p, 0), 1);
}

async function act(t, action) {
  const res = await attempt(() => api.transferAction(t.tid, action));
  if (res && res.tid) upsertTransfer(res);
}

const PREVIEW_EXT = /\.(?:md|markdown|html|htm)$/i;

function inertHtml(source) {
  const unsafe = "script|iframe|frame|object|embed|applet|form|button|input|textarea|select|option|audio|video|source|track|link|base|meta|svg|math";
  let html = source.replace(new RegExp(`<\\s*(${unsafe})\\b[^>]*>[\\s\\S]*?<\\/\\s*\\1\\s*>`, "gi"), "");
  html = html.replace(new RegExp(`<\\/?(?:${unsafe})\\b[^>]*>`, "gi"), "");
  return html.replace(/<([a-z][^>]*)>/gi, (tag) => tag
    .replace(/\s(?:href|src|srcset|xlink:href|action|formaction|poster|background|data|manifest|ping|cite|longdesc|usemap|codebase|archive|profile)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ""));
}

function htmlPreview(source, name) {
  const safeHtml = inertHtml(source);
  const frame = document.createElement("iframe");
  frame.className = "document-preview-frame";
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", `HTML preview of ${name}`);
  frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'">${safeHtml}`;
  return frame;
}

async function previewTransfer(t) {
  const status = h("p.document-preview-status", { role: "status" }, "Loading preview…");
  const modal = openModal({ title: `Preview · ${t.name}`, wide: true, cls: "document-preview", body: status });
  try {
    const result = await api.transferPreview(t.tid);
    if (!modal.el.isConnected) return;
    if (result.kind === "markdown") {
      const rendered = h("div.document-preview-content.md", null, markdown(result.content, undefined, { htmlPreview: false }));
      rendered.querySelectorAll("a").forEach((a) => a.replaceWith(...a.childNodes));
      status.replaceWith(rendered);
    } else if (result.kind === "html") {
      status.replaceWith(htmlPreview(result.content, result.name));
    } else {
      status.textContent = "This file type is not supported for preview.";
    }
  } catch (err) {
    if (modal.el.isConnected) status.textContent = `Preview unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** A compact transfer card. opts.showChannel adds the channel name. */
export function transferCard(t, opts = {}) {
  const out = t.direction === "out";
  const actions = [];
  if (out && t.state === "awaiting_approval") {
    actions.push(h("button.btn.primary.sm", { type: "button", on: { click: () => act(t, "approve") } }, "Approve"));
    actions.push(h("button.btn.sm", { type: "button", on: { click: () => act(t, "deny") } }, "Deny"));
  } else if (!out && t.state === "offered") {
    actions.push(h("button.btn.primary.sm", { type: "button", on: { click: () => act(t, "accept") } }, "Accept"));
    actions.push(h("button.btn.sm", { type: "button", on: { click: () => act(t, "decline") } }, "Decline"));
  } else if (!TERMINAL.has(t.state)) {
    actions.push(h("button.btn.sm.danger-text", { type: "button", on: { click: () => act(t, "cancel") } }, "Cancel"));
  }

  const frac = progressFraction(t.progress);
  const moving = t.state === "sending" || t.state === "receiving";
  let bar = null;
  if (moving) {
    const fill = h("div.progress-fill");
    if (frac === undefined) fill.classList.add("indeterminate");
    else fill.style.width = `${(frac * 100).toFixed(1)}%`;
    bar = h(
      "div.progress",
      { role: "progressbar", "aria-label": `${t.name} progress`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": frac === undefined ? undefined : String(Math.round(frac * 100)) },
      fill,
    );
  }

  const ch = S.channels.get(t.ch);
  const finishedLater =
    TERMINAL.has(t.state) &&
    Number.isFinite(t.updatedAt) &&
    (!Number.isFinite(t.createdAt) || Math.abs(t.updatedAt - t.createdAt) >= 60_000);
  const meta = [
    humanSize(t.size),
    t.via === "link" ? "Direct" : t.via === "croc" ? "Through the server" : null,
    `${out ? "to" : "from"} ${peerLabel(t)}`,
    opts.showChannel && ch ? `in ${channelTitle(ch)}` : null,
    moving && frac !== undefined ? `${Math.round(frac * 100)}%` : null,
    t.attempt > 1 && !TERMINAL.has(t.state) ? `attempt ${t.attempt}` : null,
    !TERMINAL.has(t.state) && t.expiresAt ? `expires ${relTime(t.expiresAt)}` : null,
    finishedLater
      ? h(
          "time",
          { datetime: new Date(t.updatedAt).toISOString(), title: `${STATE_LABEL[t.state] ?? t.state} ${timeFull(t.updatedAt)}` },
          `${STATE_LABEL[t.state] ?? t.state} ${timeShort(t.updatedAt)}`,
        )
      : null,
  ].filter(Boolean);

  const createdTs = Number.isFinite(t.createdAt) ? t.createdAt : Number.isFinite(t.updatedAt) ? t.updatedAt : null;
  const timeTitle =
    createdTs !== null
      ? [
          `Created ${timeFull(createdTs)}`,
          Number.isFinite(t.updatedAt) && t.updatedAt !== createdTs ? `Updated ${timeFull(t.updatedAt)}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      : "";
  const timeBadge =
    createdTs !== null ? h("time.xfer-time", { datetime: new Date(createdTs).toISOString(), title: timeTitle }, timeShort(createdTs)) : null;

  let quarantine = null;
  if (!out && t.state === "completed" && t.path) {
    quarantine = h(
      "div.quarantine",
      null,
      h("div.quarantine-row", null, h("code.path", { title: t.path }, t.path), PREVIEW_EXT.test(t.name) ? h("button.btn.sm", { type: "button", on: { click: () => previewTransfer(t) } }, "Preview") : null, iconButton("copy", "Copy path", async () => toast((await copyText(t.path)) ? "Path copied" : "Copy failed", "info"), "sm")),
      h("p.quarantine-note", null, icon("warn", 14), " In quarantine. Inspect it before you open it."),
    );
  }

  return h(
    `div.xfer-card.${t.direction}${needsAction(t) ? ".attention" : ""}`,
    { dataset: { tid: t.tid, state: t.state } },
    h("div.xfer-icon", { "aria-hidden": "true" }, icon(out ? "up" : "down", 18)),
    h(
      "div.xfer-main",
      null,
      h(
        "div.xfer-top",
        null,
        h(
          "span.xfer-name",
          { title: [t.name, `sha256 ${t.sha256}`, timeTitle].filter(Boolean).join("\n") },
          t.name,
        ),
        h("span.xfer-top-meta", null, timeBadge, h(`span.pill.${stateTone(t)}`, null, STATE_LABEL[t.state] ?? t.state)),
      ),
      h("div.xfer-meta", null, meta.map((x) => (x instanceof Node ? x : h("span", null, x)))),
      bar,
      initiatorLine(t),
      t.error ? h("p.xfer-error", null, t.error) : null,
      quarantine,
      actions.length ? h("div.xfer-actions", null, actions) : null,
    ),
  );
}

// ---------------------------------------------------------------- view

export function transfersView(main) {
  let filter = "all";
  const list = h("div.xfer-list");
  const tabs = h("div.tabs", { role: "tablist", "aria-label": "Filter transfers" });
  const body = h("div.page-body", null, tabs, list);
  main.append(viewHeader([h("span.title-icon", { "aria-hidden": "true" }, icon("transfer", 18)), h("div.title-stack", null, h("h1", null, "Transfers"), h("span.subtitle", null, "Files sent directly (P2P) or through the server, end-to-end encrypted"))]), h("div.page", null, body));

  const render = () => {
    const all = [...S.transfers.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const groups = {
      all,
      action: all.filter(needsAction),
      active: all.filter((t) => !TERMINAL.has(t.state)),
      done: all.filter((t) => TERMINAL.has(t.state)),
    };
    tabs.replaceChildren(
      ...[
        ["all", "All"],
        ["action", "Needs action"],
        ["active", "Active"],
        ["done", "Finished"],
      ].map(([k, label]) =>
        h(
          `button.tab${filter === k ? ".active" : ""}`,
          { type: "button", role: "tab", "aria-selected": String(filter === k), on: { click: () => ((filter = k), render()) } },
          label,
          groups[k].length ? h("span.tab-count", null, String(groups[k].length)) : null,
        ),
      ),
    );
    const items = groups[filter];
    list.replaceChildren(
      ...(items.length
        ? items.map((t) => transferCard(t, { showChannel: true }))
        : [filter === "all" ? emptyState({ icon: "transfer", title: "No files yet", text: "Open a channel and use the paperclip to send one. Files you receive wait in quarantine until you look at them." }) : emptyState({ title: "Nothing here", text: "No transfers match this filter." })]),
    );
  };
  render();
  attempt(() => api.transfers()).then((r) => r && Array.isArray(r.items) && setTransfers(r.items));
  return {
    destroy: on("transfers", (t) => {
      const existing = t && list.querySelector(`.xfer-card[data-tid="${CSS.escape(t.tid)}"]`);
      // Same state (progress tick): swap the card only, so focus and scroll stay put.
      if (existing && existing.dataset.state === t.state) existing.replaceWith(transferCard(t, { showChannel: true }));
      else render();
    }),
  };
}
