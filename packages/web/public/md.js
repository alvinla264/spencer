// A small Markdown renderer that builds DOM nodes directly. Message text comes from untrusted peers, so
// nothing here touches innerHTML: every piece of text ends up in a text node, links are http(s)/mailto only,
// images are shown as links (no remote loads), and ```html blocks are previewed only on request, inside a
// sandboxed iframe (no scripts, opaque origin).
//
// Supported: paragraphs (single newlines kept), # headings, **bold**, *italic*, ~~strike~~, `code`,
// ``` fenced code ```, > quotes, - / 1. lists (nested, - [ ] tasks), tables, --- rules, [links](url), autolinks.
import { h, icon, copyText } from "./dom.js";

const MAX_DEPTH = 8;
const plainLeaf = (s) => [document.createTextNode(s)];

/**
 * Render `src` as Markdown. `leaf(text)` turns a run of plain text into nodes (e.g. mention highlighting and
 * URL linkifying); the default is plain text. Returns a DocumentFragment-like array of nodes.
 */
export function markdown(src, leaf = plainLeaf, options = {}) {
  try {
    return blocks(String(src ?? "").replace(/\r\n?/g, "\n").split("\n"), leaf, 0, options);
  } catch (err) {
    console.error("markdown render failed", err);
    return leaf(String(src ?? ""));
  }
}

// ---------------------------------------------------------------- blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST = /^( {0,12})([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HTML_DOC = /^\s*(<!doctype html|<html[\s>])/i;

const indentOf = (l) => /^ */.exec(l)[0].length;
const isBlank = (l) => /^\s*$/.test(l);

function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) || isTableStart(lines, i);
}

function isTableStart(lines, i) {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-");
}

function blocks(lines, leaf, depth, options = {}) {
  const out = [];
  if (depth > MAX_DEPTH) return [h("p", null, leaf(lines.join("\n")))];
  let i = 0;
  if (lines.length && HTML_DOC.test(lines.find((l) => !isBlank(l)) ?? "")) return [codeBlock("html", lines.join("\n"), options)];
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    let m;
    if ((m = FENCE.exec(line))) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end)
      out.push(codeBlock(m[2], body.join("\n"), options));
      continue;
    }
    if ((m = HEADING.exec(line))) {
      out.push(h(`div.md-h.md-h${m[1].length}`, { role: "heading", "aria-level": String(m[1].length) }, inline(m[2], leaf)));
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push(h("hr"));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ""));
      out.push(h("blockquote", null, blocks(body, leaf, depth + 1, options)));
      continue;
    }
    if (isTableStart(lines, i)) {
      const [node, next] = table(lines, i, leaf);
      out.push(node);
      i = next;
      continue;
    }
    if (LIST.test(line)) {
      const [node, next] = list(lines, i, leaf, depth, options);
      out.push(node);
      i = next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) para.push(lines[i++].trim());
    out.push(h("p", null, inline(para.join("\n"), leaf)));
  }
  return out;
}

function list(lines, start, leaf, depth, options) {
  const first = LIST.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const el = ordered ? h("ol", Number.parseInt(first[2], 10) !== 1 ? { start: String(Number.parseInt(first[2], 10)) } : null) : h("ul");
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length < base || m[1].length > base + 3 || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + 1;
    const content = [m[3] ?? ""];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= contentIndent) {
          content.push("");
          i++;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind >= contentIndent || (ind > base && LIST.test(l))) {
        content.push(l.slice(Math.min(ind, contentIndent)));
        i++;
        continue;
      }
      if (LIST.test(l) || startsBlock(lines, i)) break;
      content.push(l.trim()); // lazy continuation
      i++;
    }
    let task = null;
    const t = /^\[([ xX])\]\s+/.exec(content[0]);
    if (t) {
      task = h("input", { type: "checkbox", checked: t[1] !== " ", disabled: true, "aria-label": t[1] !== " " ? "done" : "not done" });
      content[0] = content[0].slice(t[0].length);
    }
    const inner = blocks(content, leaf, depth + 1, options);
    // A single short paragraph renders inline (tight list).
    const kids = inner.length === 1 && inner[0].tagName === "P" ? [...inner[0].childNodes] : inner;
    el.append(h(`li${task ? ".task" : ""}`, null, task, kids));
    while (i < lines.length && isBlank(lines[i])) {
      const next = lines.slice(i).find((l) => !isBlank(l));
      const nm = next && LIST.exec(next);
      if (nm && nm[1].length >= base && nm[1].length <= base + 3 && /\d/.test(nm[2]) === ordered) i++;
      else break;
    }
  }
  return [el, i];
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  let code = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (c === "`") {
      code = !code;
      cur += c;
    } else if (c === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function table(lines, start, leaf) {
  const head = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : null));
  const cell = (tag, text, k) => h(tag, aligns[k] ? { class: `align-${aligns[k]}` } : null, inline(text, leaf));
  const thead = h("thead", null, h("tr", null, head.map((c, k) => cell("th", c, k))));
  const rows = [];
  let i = start + 2;
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
    const cells = splitRow(lines[i++]);
    rows.push(h("tr", null, head.map((_, k) => cell("td", cells[k] ?? "", k))));
  }
  return [h("div.md-table", null, h("table", null, thead, h("tbody", null, rows))), i];
}

function codeBlock(lang, code, options = {}) {
  const l = (lang || "").toLowerCase();
  const pre = h("pre", null, h("code", l ? { "data-lang": l } : null, code));
  const copy = h("button.md-code-btn", { type: "button", title: "Copy code" }, icon("copy", 13), " Copy");
  copy.addEventListener("click", async () => {
    copy.lastChild.textContent = (await copyText(code)) ? " Copied" : " Copy failed";
    setTimeout(() => (copy.lastChild.textContent = " Copy"), 1500);
  });
  const bar = h("div.md-code-bar", null, h("span.md-code-lang", null, l || "code"), h("span.spacer"));
  const box = h("div.md-code", null, bar, pre);
  if (options.htmlPreview !== false && (l === "html" || l === "svg" || l === "xml" && /<svg[\s>]/i.test(code))) {
    let frame = null;
    const toggle = h("button.md-code-btn", { type: "button", title: "Render this HTML in a sandbox (no scripts)" }, icon("eye", 13), " Preview");
    toggle.addEventListener("click", () => {
      if (frame) {
        frame.remove();
        frame = null;
        pre.hidden = false;
        toggle.lastChild.textContent = " Preview";
        return;
      }
      frame = htmlFrame(l === "html" ? code : `<!doctype html><meta charset="utf-8"><body style="margin:0">${code}</body>`);
      pre.hidden = true;
      box.append(frame);
      toggle.lastChild.textContent = " Source";
    });
    bar.append(toggle);
  }
  bar.append(copy);
  return box;
}

/** Sandboxed preview: no allow-scripts and no allow-same-origin, so it can't run code or reach the app. */
function htmlFrame(html) {
  const f = document.createElement("iframe");
  f.className = "md-html-frame";
  f.setAttribute("sandbox", "");
  f.setAttribute("referrerpolicy", "no-referrer");
  f.setAttribute("loading", "lazy");
  f.setAttribute("title", "HTML preview (sandboxed)");
  f.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">${html}`;
  return f;
}

// ---------------------------------------------------------------- inline

const URL_AT = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}*_~]/y;

function safeHref(raw) {
  try {
    const u = new URL(raw.replace(/^<|>$/g, ""));
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

function linkNode(href, children, title) {
  const safe = safeHref(href);
  if (!safe) return h("span", null, children);
  return h("a", { href: safe, target: "_blank", rel: "noopener noreferrer", title: title || safe }, children);
}

/** Inline Markdown → nodes. `leaf` renders runs of plain text. */
export function inline(text, leaf = plainLeaf) {
  const out = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) out.push(...leaf(buf));
    buf = "";
  };
  const at = (re) => {
    re.lastIndex = i;
    return re.exec(text);
  };
  while (i < text.length) {
    const c = text[i];
    const prev = i > 0 ? text[i - 1] : " ";
    let m;
    if (c === "\\" && /[\\`*_~[\]()#+\-.!|>{}]/.test(text[i + 1] ?? "")) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "h" && !/\w/.test(prev) && (m = at(URL_AT))) {
      buf += m[0]; // leaf() linkifies it; keeps * and _ inside URLs from becoming emphasis
      i += m[0].length;
      continue;
    }
    if (c === "`" && (m = at(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y))) {
      flush();
      const code = m[2].replace(/\n/g, " ");
      out.push(h("code", null, /^ .* $/.test(code) ? code.slice(1, -1) : code));
      i += m[0].length;
      continue;
    }
    if (c === "!" && (m = at(/!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"([^"\n]*)")?\s*\)/y))) {
      flush();
      out.push(linkNode(m[2], [icon("image", 13), ` ${m[1] || "image"}`], m[3]));
      i += m[0].length;
      continue;
    }
    if (c === "[" && (m = at(/\[((?:[^[\]\n]|\[[^\]\n]*\])+)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"([^"\n]*)")?\s*\)/y))) {
      flush();
      out.push(linkNode(m[2], inline(m[1]), m[3])); // no nested links: plain leaf inside
      i += m[0].length;
      continue;
    }
    if (c === "<" && (m = at(/<(https?:\/\/[^\s<>]+)>/y))) {
      flush();
      out.push(linkNode(m[1], [m[1]]));
      i += m[0].length;
      continue;
    }
    if ((c === "*" || c === "_") && text[i + 1] === c) {
      m = c === "*" ? at(/\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/y) : !/\w/.test(prev) ? at(/__(?=\S)([\s\S]*?\S)__(?!\w)/y) : null;
      if (m) {
        flush();
        out.push(h("strong", null, inline(m[1], leaf)));
        i += m[0].length;
        continue;
      }
    }
    if (c === "~" && text[i + 1] === "~" && (m = at(/~~(?=\S)([\s\S]*?\S)~~/y))) {
      flush();
      out.push(h("del", null, inline(m[1], leaf)));
      i += m[0].length;
      continue;
    }
    if (c === "*" || (c === "_" && !/\w/.test(prev))) {
      m = c === "*" ? at(/\*(?=[^\s*])((?:\*\*[\s\S]*?\*\*|[^*])*?[^\s*])\*(?!\*)/y) : at(/_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/y);
      if (m) {
        flush();
        out.push(h("em", null, inline(m[1], leaf)));
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}
