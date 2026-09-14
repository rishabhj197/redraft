// Content script: finds the field, watches it, renders the widget, applies
// edits. Chrome-coupled and DOM-coupled by nature — no prompt, request,
// parsing, or budget logic lives here. Classic script (not a module): content
// scripts cannot be ES modules, so it talks to lib/ through the service worker.
//
// The one exception is lib/match.js, loaded ahead of this file as a second
// classic content script. Apply has to locate the excerpt and call
// execCommand() inside the click's own user gesture, so that lookup cannot go
// round the service worker and back.

const { findExcerpt, hashText } = globalThis.RedraftMatch;

const HOST_ID = "redraft-widget-host";
const BADGE_ID = "redraft-badge-host";
const ACCENT = "#9a4a2f";

// Passive analysis. Value arrives without being asked for; nothing interrupts.
const IDLE_MS = 1500;
const MIN_AUTO_CHARS = 40;
const CACHE_LIMIT = 40;
// A draft is worth reading once the writer has finished a thought.
const SENTENCE_END = /[.!?…]["'’”)\]]*\s*$/;

const state = {
  field: null,
  original: "",
  meta: null,
  // The span of field text under analysis: a selection, or null for the whole
  // field. Kept up to date as edits change the length of what it contains.
  scope: null,
  host: null,
  root: null,
  onKeydown: null,
  // Set when the writer dismisses the widget, so a result that lands after
  // they have moved on does not reopen it.
  dismissed: false,
};

const auto = {
  enabled: true,
  // Set when the budget runs out. Passive analysis must never keep spending
  // against a guard that has already refused a call.
  stopped: false,
  timer: null,
  cache: new Map(),
  badge: null,
  badgeKey: null,
};

const pending = new Map();
let nextRequestId = 1;

// --- field capture -------------------------------------------------------

// A block editor (Notion, and anything built like it) can make the whole page
// one editing host with a contenteditable leaf per block. The focused element
// is then the page, and reading it sweeps up the title, every other block and
// the editor's own hover controls as one run of text. Focus says which field
// the writer is in; the caret says which block of it they are writing.
function focusedField() {
  const field = editableField(document.activeElement);
  if (!field?.isContentEditable) return field;
  return caretBlock(field) ?? field;
}

/** The innermost element that declares itself editable around the caret, inside `host`. */
function caretBlock(host) {
  const node = window.getSelection()?.anchorNode;
  if (!node || !host.contains(node)) return null;
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  for (; el && el !== host; el = el.parentElement) {
    if (declaresEditable(el)) return el;
  }
  return null;
}

function declaresEditable(el) {
  const value = el.getAttribute("contenteditable");
  if (value === null) return false;
  return ["", "true", "plaintext-only"].includes(value.toLowerCase());
}

function editableField(el) {
  if (!el) return null;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (tag === "textarea") return el;
  if (tag === "input" && (el.type === "text" || el.type === "search")) return el;
  if (el.isContentEditable) return el;
  return null;
}

// innerText cannot be walked back to the nodes that produced it, so a
// contenteditable field is serialised here instead: the same pass yields the
// text the model sees and the map that turns an offset in it back into a DOM
// position. The two can never drift apart, because there is only one pass.
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL",
  "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3",
  "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "TD", "TH", "TR", "UL",
]);

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

function serializeEditable(root) {
  let text = "";
  const segments = [];

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!child.data) continue;
        segments.push({
          node: child,
          start: text.length,
          end: text.length + child.data.length,
        });
        text += child.data;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName;
      if (SKIP_TAGS.has(tag)) continue;
      if (child.hidden || child.style?.display === "none") continue;
      // Editor controls that live inside the editable are not the writer's prose.
      if (child.getAttribute("aria-hidden") === "true") continue;
      if (child.getAttribute("role") === "button") continue;

      if (tag === "BR") {
        text += "\n";
        continue;
      }

      const block = BLOCK_TAGS.has(tag);
      if (block && text && !text.endsWith("\n")) text += "\n";
      walk(child);
      if (block && text && !text.endsWith("\n")) text += "\n";
    }
  };

  walk(root);
  return { text, segments };
}

function fieldText(field) {
  if (field.isContentEditable) return serializeEditable(field);
  return { text: field.value, segments: null };
}

/** A DOM position for a text offset. `preferStart` breaks segment-boundary ties. */
function pointAt(segments, offset, preferStart) {
  let fallback = null;
  for (const segment of segments) {
    if (offset > segment.end) {
      fallback = { node: segment.node, offset: segment.node.data.length };
      continue;
    }
    if (offset < segment.start) {
      return fallback ?? { node: segment.node, offset: 0 };
    }
    // Exactly on a boundary shared by two segments: a range start belongs to
    // the later one, a range end to the earlier one.
    if (offset === segment.end && preferStart) {
      fallback = { node: segment.node, offset: segment.node.data.length };
      continue;
    }
    return { node: segment.node, offset: offset - segment.start };
  }
  return fallback;
}

/** The text offset of a DOM position, or null when it cannot be placed. */
function offsetAt(segments, node, offset) {
  for (const segment of segments) {
    if (segment.node === node) return segment.start + offset;
  }
  // The boundary sits on an element rather than in text. Take the first
  // segment that starts at or after it.
  try {
    const probe = document.createRange();
    probe.setStart(node, offset);
    probe.collapse(true);
    for (const segment of segments) {
      if (probe.comparePoint(segment.node, 0) >= 0) return segment.start;
    }
  } catch {
    return null;
  }
  const last = segments[segments.length - 1];
  return last ? last.end : null;
}

/** The selected span of the field, as text offsets, or null if nothing is selected. */
function selectionScope(field, segments) {
  if (!field.isContentEditable) {
    const { selectionStart: start, selectionEnd: end } = field;
    if (typeof start !== "number" || typeof end !== "number") return null;
    return end > start ? { start, end } : null;
  }

  const selection = field.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;

  const range = selection.getRangeAt(0);
  if (!field.contains(range.commonAncestorContainer)) return null;

  const start = offsetAt(segments, range.startContainer, range.startOffset);
  const end = offsetAt(segments, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

// --- writing -------------------------------------------------------------

// document.execCommand is deprecated and still the only way to edit a field
// through the browser's own editing pipeline: it pushes onto the native undo
// stack, so Ctrl+Z reverses an applied suggestion, and it emits the real
// beforeinput/input events that React and other managed editors listen for.
// Setting .value or .innerText does neither.

function writeInput(field, start, end, replacement) {
  const caret = field.selectionStart;
  field.focus({ preventScroll: true });
  field.setSelectionRange(start, end);

  let inserted = false;
  try {
    inserted = field.ownerDocument.execCommand("insertText", false, replacement);
  } catch {
    inserted = false;
  }

  if (!inserted) {
    field.setRangeText(replacement, start, end, "end");
    // React tracks the last value it wrote and swallows an input event that
    // reports the same one. Clearing the tracker makes the change visible.
    field._valueTracker?.setValue?.("");
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: replacement,
      })
    );
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Keep the writer's caret where they left it, unless they were standing in
  // the text that just changed.
  if (typeof caret === "number") {
    const delta = replacement.length - (end - start);
    if (caret <= start) field.setSelectionRange(caret, caret);
    else if (caret >= end) field.setSelectionRange(caret + delta, caret + delta);
  }
  return true;
}

function writeEditable(field, segments, start, end, replacement) {
  const from = pointAt(segments, start, true);
  const to = pointAt(segments, end, false);
  if (!from || !to) return false;

  const doc = field.ownerDocument;
  const view = doc.defaultView;
  const range = doc.createRange();
  try {
    range.setStart(from.node, Math.min(from.offset, from.node.data.length));
    range.setEnd(to.node, Math.min(to.offset, to.node.data.length));
  } catch {
    return false;
  }

  field.focus({ preventScroll: true });
  const selection = view.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  let inserted = false;
  try {
    inserted = doc.execCommand("insertText", false, replacement);
  } catch {
    inserted = false;
  }
  if (inserted) return true;

  // Last resort. This edits the DOM directly, so the browser's undo stack does
  // not know about it — Ctrl+Z will not reverse it. Everything above exists to
  // avoid landing here.
  range.deleteContents();
  const node = doc.createTextNode(replacement);
  range.insertNode(node);
  const after = doc.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  selection.removeAllRanges();
  selection.addRange(after);
  field.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: replacement,
    })
  );
  return true;
}

/** Replace the span [start, end) of `field`'s text. Returns false if it could not. */
function writeRange(field, start, end, replacement) {
  if (!field?.isConnected) return false;
  if (field.isContentEditable) {
    const { segments } = fieldText(field);
    return writeEditable(field, segments, start, end, replacement);
  }
  return writeInput(field, start, end, replacement);
}

/**
 * Find `from` in the field — within the selection, if one scoped the run — and
 * replace it with `to`.
 *
 * @returns {{ok: boolean, method?: string}}
 */
function replaceOnce(field, from, to) {
  if (!field?.isConnected) return { ok: false };

  const { text } = fieldText(field);
  const scope = state.scope ?? { start: 0, end: text.length };
  const region = text.slice(scope.start, scope.end);

  const at = findExcerpt(region, from);
  if (!at) return { ok: false };

  const start = scope.start + at.start;
  const end = scope.start + at.end;
  if (!writeRange(field, start, end, to)) return { ok: false };

  // The selection still bounds the run, so it has to follow the edit.
  if (state.scope) state.scope.end += to.length - (end - start);
  return { ok: true, method: at.method };
}

// --- widget --------------------------------------------------------------

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .panel {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.55;
    color: #1c1a17;
    background: #fdfcfa;
    border: 1px solid #e0d9cf;
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(28, 26, 23, 0.13);
    width: 380px;
    max-height: 60vh;
    overflow-y: auto;
    padding: 0;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 18px 10px;
    border-bottom: 1px solid #efe9e0;
  }
  .title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: ${ACCENT};
  }
  .meta { font-size: 11px; color: #8a8178; }
  .close {
    font: inherit;
    font-size: 16px;
    line-height: 1;
    color: #8a8178;
    background: none;
    border: none;
    padding: 0 2px;
    cursor: pointer;
  }
  .body { padding: 6px 18px 18px; }
  .message { padding: 16px 18px 18px; color: #4b453e; }
  .message.error { color: #8a2f2f; }
  .message strong { display: block; margin-bottom: 4px; color: #1c1a17; }
  .section-label {
    margin: 18px 0 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #8a8178;
  }
  .card { padding: 14px 0; border-bottom: 1px solid #efe9e0; }
  .card:last-child { border-bottom: none; }
  .excerpt {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    color: #6b645c;
    background: #f4efe8;
    border-left: 2px solid #ded5c8;
    padding: 4px 8px;
    margin-bottom: 8px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .issue { margin: 0 0 8px; }
  .fix {
    margin: 0 0 8px;
    padding: 6px 8px;
    background: #f7f3ec;
    border-left: 2px solid ${ACCENT};
    white-space: pre-wrap;
    word-break: break-word;
  }
  .why { margin: 0; color: #6b645c; font-size: 12px; }
  .swap { margin: 0 0 6px; }
  .swap .from { color: #8a8178; text-decoration: line-through; }
  .swap .to { font-weight: 600; }
  .row { display: flex; gap: 8px; margin-top: 10px; }
  button.action {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid ${ACCENT};
    background: ${ACCENT};
    color: #fff;
  }
  button.action.ghost {
    background: transparent;
    color: #6b645c;
    border-color: #ded5c8;
    font-weight: 500;
  }
  .footnote { margin: 14px 0 0; font-size: 11px; color: #8a8178; }
`;

function closeWidget() {
  state.dismissed = true;
  if (state.onKeydown) {
    document.removeEventListener("keydown", state.onKeydown, true);
    state.onKeydown = null;
  }
  state.host?.remove();
  state.host = null;
  state.root = null;
}

function openWidget() {
  closeWidget();
  hideBadge();
  state.dismissed = false;

  const host = document.createElement("div");
  host.id = HOST_ID;
  Object.assign(host.style, {
    position: "fixed",
    zIndex: "2147483647",
    top: "0px",
    left: "0px",
  });

  // Never take focus from the field the writer is typing in.
  host.addEventListener("mousedown", (event) => event.preventDefault());

  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  root.append(style);

  document.body.append(host);
  state.host = host;
  state.root = root;

  state.onKeydown = (event) => {
    if (event.key === "Escape") closeWidget();
  };
  document.addEventListener("keydown", state.onKeydown, true);

  position();
  return root;
}

function fieldBox(field) {
  return field?.isConnected
    ? field.getBoundingClientRect()
    : { left: 24, right: 24, bottom: 24, top: 24 };
}

function position() {
  if (!state.host) return;
  const gap = 8;
  const width = 380;
  const box = fieldBox(state.field);

  const left = Math.min(
    Math.max(8, box.left),
    Math.max(8, window.innerWidth - width - 8)
  );
  const belowFits = window.innerHeight - box.bottom > 220;
  const top = belowFits ? box.bottom + gap : Math.max(8, box.top - gap - 220);

  state.host.style.left = `${left}px`;
  state.host.style.top = `${top}px`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function header(subtitle) {
  const bar = el("header");
  const left = el("div");
  left.append(el("div", "title", "Redraft"));
  if (subtitle) left.append(el("div", "meta", subtitle));
  const close = el("button", "close", "×");
  close.title = "Dismiss (Esc)";
  close.addEventListener("click", closeWidget);
  bar.append(left, close);
  return bar;
}

function panel(children) {
  const root = state.root ?? openWidget();
  root.querySelector(".panel")?.remove();
  const node = el("div", "panel");
  node.append(...children);
  root.append(node);
  position();
  return node;
}

function metaLine() {
  if (!state.meta) return "";
  const { mode, style, model } = state.meta;
  const short = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const scoped = state.scope ? "selection · " : "";
  return `${scoped}${mode} · ${style} · ${short}`;
}

// --- the passive badge ---------------------------------------------------

// Analysis is automatic; interruption is not. The badge is the whole of the
// interruption: a count, near the field, that opens the panel when clicked and
// otherwise sits there. Nothing opens the panel on the writer's behalf.

const BADGE_STYLES = `
  :host { all: initial; }
  button {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1;
    color: ${ACCENT};
    background: #fdfcfa;
    border: 1px solid #e0d9cf;
    border-radius: 999px;
    box-shadow: 0 2px 8px rgba(28, 26, 23, 0.12);
    padding: 6px 11px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  button:hover { background: #f7f3ec; }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${ACCENT};
  }
`;

function hideBadge() {
  auto.badge?.host.remove();
  auto.badge = null;
  auto.badgeKey = null;
}

function showBadge(field, key, count, onOpen) {
  hideBadge();

  const host = document.createElement("div");
  host.id = BADGE_ID;
  Object.assign(host.style, {
    position: "fixed",
    zIndex: "2147483646",
    top: "0px",
    left: "0px",
  });
  // Clicking the badge must not pull focus out of the writer's field.
  host.addEventListener("mousedown", (event) => event.preventDefault());

  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = BADGE_STYLES;

  const button = document.createElement("button");
  button.append(
    Object.assign(document.createElement("span"), { className: "dot" }),
    document.createTextNode(
      count === 1 ? "1 suggestion" : `${count} suggestions`
    )
  );
  button.addEventListener("click", onOpen);

  root.append(style, button);
  document.body.append(host);

  auto.badge = { host, button, field };
  auto.badgeKey = key;
  positionBadge();
}

function positionBadge() {
  if (!auto.badge) return;
  const { host, button, field } = auto.badge;
  if (!field?.isConnected) {
    hideBadge();
    return;
  }

  const box = field.getBoundingClientRect();
  // Off-screen fields would otherwise leave a badge floating over the page.
  if (box.bottom < 0 || box.top > window.innerHeight || box.width === 0) {
    host.style.visibility = "hidden";
    return;
  }
  host.style.visibility = "visible";

  const pill = button.getBoundingClientRect();
  const gap = 6;
  const belowFits = window.innerHeight - box.bottom > pill.height + gap + 4;
  const top = belowFits ? box.bottom + gap : box.bottom - pill.height - gap;

  host.style.left = `${Math.max(
    8,
    Math.min(box.right - pill.width, window.innerWidth - pill.width - 8)
  )}px`;
  host.style.top = `${Math.max(8, top)}px`;
}

// --- states --------------------------------------------------------------

function showLoading() {
  openWidget();
  const message = el("div", "message");
  message.append(el("strong", null, "Reading your draft…"));
  panel([header(""), message]);
}

function showMessage(text, { error = false, footnote = null, heading = null } = {}) {
  const message = el("div", error ? "message error" : "message");
  message.append(
    el("strong", null, heading ?? (error ? "Redraft could not run" : "Nothing to change"))
  );
  message.append(document.createTextNode(text));
  if (footnote) message.append(el("p", "footnote", footnote));
  panel([header(metaLine()), message]);
}

function reportOutcome(suggestion, outcome) {
  chrome.runtime.sendMessage({
    type: "REDRAFT_EVENT",
    payload: {
      original: state.original,
      mode: state.meta.mode,
      style: state.meta.style,
      model: state.meta.model,
      promptVersion: state.meta.promptVersion,
      suggestion,
      outcome,
    },
  });
}

function cardActions(card, suggestion, apply) {
  const row = el("div", "row");

  const applyButton = el("button", "action", "Apply");
  applyButton.addEventListener("click", () => {
    const { ok, method } = apply();
    if (!ok) {
      // An apply that changed nothing is not an accepted suggestion, so it is
      // not reported as one.
      card.append(
        el(
          "p",
          "footnote",
          "That wording is no longer in the field, so nothing was changed."
        )
      );
      return;
    }
    if (method && method !== "exact") {
      console.log(`Redraft: matched the excerpt by ${method}.`);
    }
    reportOutcome(suggestion, "applied");
    retire(card);
  });

  const dismissButton = el("button", "action ghost", "Dismiss");
  dismissButton.addEventListener("click", () => {
    reportOutcome(suggestion, "dismissed");
    retire(card);
  });

  row.append(applyButton, dismissButton);
  return row;
}

function retire(card) {
  const panelNode = card.closest(".panel");
  card.remove();
  if (panelNode && !panelNode.querySelector(".card")) closeWidget();
}

function suggestionCard(suggestion) {
  const card = el("div", "card");
  card.append(el("div", "excerpt", suggestion.excerpt));
  card.append(el("p", "issue", suggestion.issue));
  card.append(el("div", "fix", suggestion.fix));
  card.append(el("p", "why", suggestion.why));
  card.append(
    cardActions(card, suggestion, () =>
      replaceOnce(state.field, suggestion.excerpt, suggestion.fix)
    )
  );
  return card;
}

function vocabularyCard(entry) {
  const card = el("div", "card");
  const swap = el("p", "swap");
  swap.append(
    el("span", "from", entry.from),
    document.createTextNode("  →  "),
    el("span", "to", entry.to)
  );
  card.append(swap);
  card.append(el("p", "why", entry.why));
  card.append(
    cardActions(card, entry, () => replaceOnce(state.field, entry.from, entry.to))
  );
  return card;
}

function showCoach(result) {
  if (result.noChangesNeeded) {
    showMessage("This already does what it set out to do.");
    return;
  }

  const body = el("div", "body");

  if (result.suggestions.length) {
    body.append(el("p", "section-label", "Suggestions"));
    for (const suggestion of result.suggestions) {
      body.append(suggestionCard(suggestion));
    }
  }

  if (result.vocabulary.length) {
    body.append(el("p", "section-label", "Vocabulary"));
    for (const entry of result.vocabulary) {
      body.append(vocabularyCard(entry));
    }
  }

  panel([header(metaLine()), body]);
}

function showRewrite(result) {
  if (result.text.trim() === state.original.trim()) {
    showMessage("This already does what it set out to do.");
    return;
  }

  const suggestion = {
    excerpt: state.original,
    issue: "Rewritten in the target style.",
    fix: result.text,
    why: state.scope ? "Replaces the selection." : "Replaces the whole draft.",
  };

  const body = el("div", "body");
  const card = el("div", "card");
  card.append(el("div", "fix", result.text));
  card.append(
    cardActions(card, suggestion, () => {
      const field = state.field;
      if (!field?.isConnected) return { ok: false };
      const { text } = fieldText(field);
      const scope = state.scope ?? { start: 0, end: text.length };
      const ok = writeRange(field, scope.start, scope.end, result.text);
      if (ok && state.scope) state.scope.end = state.scope.start + result.text.length;
      return { ok, method: "whole" };
    })
  );
  body.append(card);

  panel([header(metaLine()), body]);
}

/** How many separate things a result offers the writer. */
function suggestionCount(result) {
  if (result.mode === "rewrite") return result.text?.trim() ? 1 : 0;
  return (result.suggestions?.length ?? 0) + (result.vocabulary?.length ?? 0);
}

function render(original, result, scope) {
  state.original = original;
  state.scope = scope ? { ...scope } : null;
  state.meta = {
    mode: result.mode,
    style: result.style,
    model: result.model,
    promptVersion: result.promptVersion,
  };
  if (result.mode === "rewrite") showRewrite(result);
  else showCoach(result);
}

// --- analysis ------------------------------------------------------------

function send({ field, text, scope, kind }) {
  const requestId = nextRequestId++;
  pending.set(requestId, { field, text, scope, kind, key: hashText(text) });
  chrome.runtime.sendMessage({ type: "REDRAFT_TEXT", text, requestId });
  return requestId;
}

/** The Ctrl+Shift+K path: analyse now, open the panel when the answer lands. */
function runManually() {
  const field = focusedField();
  if (!field) {
    console.log("Redraft: no text field is focused.");
    return;
  }

  const { text: full, segments } = fieldText(field);
  const scope = selectionScope(field, segments);
  const text = scope ? full.slice(scope.start, scope.end) : full;

  if (!text || text.trim() === "") {
    console.log("Redraft: nothing to work on in the focused field.");
    return;
  }

  state.field = field;
  state.original = text;
  state.scope = scope;
  state.meta = null;
  showLoading();
  send({ field, text, scope, kind: "manual" });
}

function remember(key, original, result) {
  if (auto.cache.size >= CACHE_LIMIT) {
    auto.cache.delete(auto.cache.keys().next().value);
  }
  auto.cache.set(key, { original, result });
}

function scheduleAnalysis() {
  hideBadge();
  clearTimeout(auto.timer);
  if (!auto.enabled || auto.stopped) return;
  auto.timer = setTimeout(analyseIfIdle, IDLE_MS);
}

/**
 * The passive path. Three gates keep it from spending on half-written text:
 * the draft has to be long enough to be worth reading, finished enough to end
 * a sentence, and different from whatever was read last.
 */
function analyseIfIdle() {
  if (!auto.enabled || auto.stopped) return;
  if (!document.hasFocus()) return;

  const field = focusedField();
  if (!field) return;

  const { text } = fieldText(field);
  if (text.trim().length < MIN_AUTO_CHARS) return;
  if (!SENTENCE_END.test(text)) return;

  const key = hashText(text);
  if (key === auto.badgeKey) return;

  const cached = auto.cache.get(key);
  if (cached) {
    offer(field, key, cached.original, cached.result);
    return;
  }

  send({ field, text, scope: null, kind: "auto" });
}

/** Show the badge, and nothing else. The panel opens only when it is clicked. */
function offer(field, key, original, result) {
  const count = suggestionCount(result);
  if (count === 0) return;
  if (focusedField() !== field) return;

  showBadge(field, key, count, () => {
    state.field = field;
    hideBadge();
    render(original, result, null);
  });
}

// --- messaging -----------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "REDRAFT_CAPTURE") {
    runManually();
    sendResponse();
    return;
  }

  if (message?.type === "REDRAFT_RESULT") {
    const request = pending.get(message.requestId);
    pending.delete(message.requestId);
    sendResponse();
    if (!request) return;

    if (request.kind === "auto") {
      remember(request.key, message.original, message.result);
      offer(request.field, request.key, message.original, message.result);
      return;
    }

    if (state.dismissed) return;
    remember(request.key, message.original, message.result);
    render(message.original, message.result, request.scope);
    return;
  }

  if (message?.type === "REDRAFT_ERROR") {
    const request = pending.get(message.requestId);
    pending.delete(message.requestId);
    sendResponse();

    if (message.code === "budget_exceeded") {
      // Terminal. Passive analysis stops for good rather than asking again.
      auto.stopped = true;
      clearTimeout(auto.timer);
    }

    // A background analysis nobody asked for must not raise a dialogue about
    // its own failure. It goes to the console and no further.
    if (!request || request.kind === "auto") {
      console.log("Redraft: background analysis failed.", message.message);
      return;
    }

    if (state.dismissed) return;
    if (message.code === "budget_exceeded") {
      showMessage(message.message, {
        error: true,
        heading: "Budget exhausted",
        footnote:
          "Redraft has stopped making calls. Raise the cap in lib/budget.js, or " +
          "reset the spend counter on the options page.",
      });
    } else {
      showMessage(message.message, { error: true });
    }
  }
});

// --- wiring --------------------------------------------------------------

chrome.storage.local.get(["autoAnalyse"], (stored) => {
  auto.enabled = stored.autoAnalyse !== false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.autoAnalyse) return;
  auto.enabled = changes.autoAnalyse.newValue !== false;
  if (!auto.enabled) {
    clearTimeout(auto.timer);
    hideBadge();
  }
});

document.addEventListener(
  "input",
  (event) => {
    if (!editableField(event.target)) return;
    scheduleAnalysis();
  },
  true
);

document.addEventListener(
  "focusin",
  (event) => {
    if (!editableField(event.target)) {
      hideBadge();
      return;
    }
    if (auto.badge && auto.badge.field !== event.target) hideBadge();
    scheduleAnalysis();
  },
  true
);

// Moving between blocks of one editor fires no focusin, so a badge counting
// another block's suggestions has to be dropped when the caret leaves it.
document.addEventListener("selectionchange", () => {
  if (auto.badge && focusedField() !== auto.badge.field) hideBadge();
});

window.addEventListener("scroll", reposition, true);
window.addEventListener("resize", reposition);

function reposition() {
  position();
  positionBadge();
}
