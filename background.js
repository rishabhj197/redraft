// Service worker: Chrome plumbing only. Everything that could be tested in
// Node lives in lib/ and is imported here.

import { runRedraft } from "./lib/redraft.js";
import { DEFAULT_MODEL, isKnownModel } from "./lib/request.js";
import { DEFAULT_MODE, DEFAULT_STYLE, MODES, STYLES } from "./lib/prompts.js";
import { addSpend, budgetSummary } from "./lib/budget.js";
import { recordEvent } from "./lib/events.js";
import { addToLexicon, entryFromHint } from "./lib/lexicon.js";

const SPEND_KEY = "budgetSpentUsd";
const EVENTS_KEY = "redraftEvents";
const LEXICON_KEY = "redraftLexicon";

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

// The extension's half of the budget guard: chrome.storage.local holds the
// running total. It never auto-resets.
const chromeBudgetStore = {
  async read() {
    const stored = await storageGet([SPEND_KEY]);
    return typeof stored[SPEND_KEY] === "number" ? stored[SPEND_KEY] : 0;
  },
  async add(costUsd) {
    const total = addSpend(await chromeBudgetStore.read(), costUsd);
    await storageSet({ [SPEND_KEY]: total });
    return budgetSummary(total);
  },
};

// The extension's half of feedback capture. Swapping this for Supabase later
// is a change to this object and nothing else.
const chromeEventStore = {
  async append(event) {
    const stored = await storageGet([EVENTS_KEY]);
    const events = Array.isArray(stored[EVENTS_KEY]) ? stored[EVENTS_KEY] : [];
    events.push(event);
    await storageSet({ [EVENTS_KEY]: events });
  },
};

async function readSettings() {
  const stored = await storageGet(["apiKey", "style", "mode", "model"]);
  return {
    apiKey: stored.apiKey ?? "",
    style: STYLES.includes(stored.style) ? stored.style : DEFAULT_STYLE,
    mode: MODES.includes(stored.mode) ? stored.mode : DEFAULT_MODE,
    model: isKnownModel(stored.model) ? stored.model : DEFAULT_MODEL,
  };
}

// Kept in step with manifest.json content_scripts. Reloading the extension
// leaves the copies already sitting in open tabs orphaned: their chrome.*
// calls throw, and a top-level const file cannot simply be evaluated again.
// content.js retires the previous copy when a new one starts, which is what
// makes injecting these files a second time safe.
const CONTENT_FILES = ["lib/match.js", "lib/trigger.js", "content.js"];

async function injectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_FILES,
    });
    return true;
  } catch (error) {
    // chrome:// pages, the Web Store, and discarded tabs all refuse injection.
    console.log("Redraft: could not inject into this tab.", error?.message);
    return false;
  }
}

function injectOpenTabs() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) injectContentScripts(tab.id);
    }
  });
}

// One retry. A second failure is reported and left alone — injecting in a
// loop would thrash every tab that cannot host a content script.
function sendToTab(tabId, message, attempt = 0) {
  chrome.tabs.sendMessage(tabId, message, () => {
    const error = chrome.runtime.lastError;
    if (!error) return;
    if (attempt >= 1) {
      console.log("Redraft: could not reach the content script.", error.message);
      return;
    }
    injectContentScripts(tabId).then((ok) => {
      if (!ok) {
        console.log("Redraft: could not reach the content script.", error.message);
        return;
      }
      sendToTab(tabId, message, attempt + 1);
    });
  });
}

// requestId travels out and back untouched. The content script now runs a
// passive analysis and an explicit one against the same worker, and has to be
// able to tell which answer belongs to which — and to drop the ones that belong
// to neither because the writer has moved on.
async function handleRedraftText(tabId, text, requestId) {
  const settings = await readSettings();

  if (!settings.apiKey) {
    sendToTab(tabId, {
      type: "REDRAFT_ERROR",
      code: "no_api_key",
      message: "No API key saved. Set one on the Redraft options page.",
      requestId,
    });
    return;
  }

  try {
    const { result, costUsd, budget } = await runRedraft(
      {
        text,
        style: settings.style,
        mode: settings.mode,
        model: settings.model,
        apiKey: settings.apiKey,
      },
      { fetch: globalThis.fetch.bind(globalThis), budget: chromeBudgetStore }
    );

    // Model and prompt version travel with every logged response.
    console.log("Redraft: result", {
      promptVersion: result.promptVersion,
      model: result.model,
      style: result.style,
      mode: result.mode,
      usage: result.usage,
      callCostUsd: costUsd,
      budget,
    });
    console.log(
      `Redraft: budget — spent ${budget.spentFormatted} of ${budget.limitUsd.toFixed(2)}, ` +
        `${budget.remainingFormatted} remaining.`
    );

    sendToTab(tabId, {
      type: "REDRAFT_RESULT",
      original: text,
      result,
      requestId,
    });
  } catch (error) {
    // Remaining budget is logged after every call, whatever the outcome.
    const budget = error.budget ?? budgetSummary(await chromeBudgetStore.read());
    console.log(
      `Redraft: budget — spent ${budget.spentFormatted} of ` +
        `${budget.limitUsd.toFixed(2)}, ${budget.remainingFormatted} remaining.`
    );

    // The budget guard is terminal. Report and stop; never retry.
    console.log("Redraft: call failed.", {
      code: error.code ?? "unknown",
      message: error.message,
    });

    sendToTab(tabId, {
      type: "REDRAFT_ERROR",
      code: error.code ?? "unknown",
      message: error.message,
      budget,
      requestId,
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  // Manifest injection does not reach tabs that were already open, and a
  // reload orphans the scripts those tabs still have. Put a fresh copy in.
  injectOpenTabs();
});

chrome.commands.onCommand.addListener((command) => {
  const type =
    command === "trigger-redraft"
      ? "REDRAFT_CAPTURE"
      : command === "apply-hint"
        ? "REDRAFT_APPLY"
        : null;
  if (!type) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    sendToTab(tab.id, { type });
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender?.tab?.id;
  if (!tabId) return;

  if (message?.type === "REDRAFT_TEXT") {
    handleRedraftText(tabId, message.text, message.requestId);
    return;
  }

  if (message?.type === "REDRAFT_EVENT") {
    recordEvent(message.payload, chromeEventStore).catch((error) =>
      console.log("Redraft: could not record feedback event.", error.message)
    );
    rememberLexicon(message.payload).catch((error) =>
      console.log("Redraft: could not update the lexicon.", error.message)
    );
  }
});

// Applied hints only. A rewrite of the whole draft is not a word to learn.
async function rememberLexicon(payload) {
  if (payload?.outcome !== "applied") return;
  const entry = entryFromHint(payload.suggestion, {
    style: payload.style ?? null,
    timestamp: new Date().toISOString(),
  });
  if (!entry) return;
  const stored = await storageGet([LEXICON_KEY]);
  const entries = Array.isArray(stored[LEXICON_KEY]) ? stored[LEXICON_KEY] : [];
  await storageSet({ [LEXICON_KEY]: addToLexicon(entries, entry) });
}
