// Content script: finds the focused field, renders the widget, applies edits.
// Chrome-coupled and DOM-coupled by nature — no prompt, request, parsing, or
// budget logic lives here. Classic script (not a module): content scripts
// cannot be ES modules, so it talks to lib/ through the service worker.

const HOST_ID = "redraft-widget-host";
const ACCENT = "#9a4a2f";

const state = {
  field: null,
  original: "",
  meta: null,
  host: null,
  root: null,
  onKeydown: null,
  // Set when the writer dismisses the widget, so a result that lands after
  // they have moved on does not reopen it.
  dismissed: false,
};

// --- field capture -------------------------------------------------------

function focusedField() {
  const el = document.activeElement;
  if (!el) return null;

  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (tag === "textarea") return el;
  if (tag === "input" && (el.type === "text" || el.type === "search")) return el;
  if (el.isContentEditable) return el;
  return null;
}

function readField(field) {
  return field.isContentEditable ? field.innerText : field.value;
}

function writeField(field, text) {
  if (field.isContentEditable) {
    field.innerText = text;
  } else {
    field.value = text;
  }
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Replace the first occurrence of `from` with `to`. Returns false if absent. */
function replaceOnce(field, from, to) {
  const current = readField(field);
  const at = current.indexOf(from);
  if (at === -1) return false;
  writeField(field, current.slice(0, at) + to + current.slice(at + from.length));
  return true;
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

function position() {
  if (!state.host) return;
  const gap = 8;
  const width = 380;
  const field = state.field;
  const box = field?.isConnected
    ? field.getBoundingClientRect()
    : { left: 24, bottom: 24, top: 24 };

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
  return `${mode} · ${style} · ${short}`;
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
    const applied = apply();
    reportOutcome(suggestion, "applied");
    if (!applied) {
      const warning = el(
        "p",
        "footnote",
        "That wording is no longer in the field, so nothing was changed."
      );
      card.append(warning);
      return;
    }
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
    why: "Replaces the whole draft.",
  };

  const body = el("div", "body");
  const card = el("div", "card");
  card.append(el("div", "fix", result.text));
  card.append(
    cardActions(card, suggestion, () => {
      writeField(state.field, result.text);
      return true;
    })
  );
  body.append(card);

  panel([header(metaLine()), body]);
}

// --- messaging -----------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "REDRAFT_CAPTURE") {
    const field = focusedField();
    if (!field) {
      console.log("Redraft: no text field is focused.");
      sendResponse();
      return;
    }

    const text = readField(field);
    if (!text || text.trim() === "") {
      console.log("Redraft: the focused field is empty.");
      sendResponse();
      return;
    }

    state.field = field;
    state.original = text;
    state.meta = null;
    showLoading();
    chrome.runtime.sendMessage({ type: "REDRAFT_TEXT", text });
    sendResponse();
    return;
  }

  if (message?.type === "REDRAFT_RESULT") {
    if (state.dismissed) {
      sendResponse();
      return;
    }
    const { result } = message;
    state.original = message.original;
    state.meta = {
      mode: result.mode,
      style: result.style,
      model: result.model,
      promptVersion: result.promptVersion,
    };
    if (result.mode === "rewrite") showRewrite(result);
    else showCoach(result);
    sendResponse();
    return;
  }

  if (message?.type === "REDRAFT_ERROR") {
    if (state.dismissed) {
      sendResponse();
      return;
    }
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
    sendResponse();
  }
});

window.addEventListener("scroll", position, true);
window.addEventListener("resize", position);
