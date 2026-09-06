// Service worker: Chrome plumbing only. Everything that could be tested in
// Node lives in lib/ and is imported here.

import { runRedraft } from "./lib/redraft.js";
import { DEFAULT_MODEL, isKnownModel } from "./lib/request.js";
import { DEFAULT_MODE, DEFAULT_STYLE, MODES, STYLES } from "./lib/prompts.js";
import { addSpend, budgetSummary } from "./lib/budget.js";
import { recordEvent } from "./lib/events.js";

const SPEND_KEY = "budgetSpentUsd";
const EVENTS_KEY = "redraftEvents";

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

function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      console.log(
        "Redraft: could not reach the content script.",
        chrome.runtime.lastError.message
      );
    }
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

chrome.commands.onCommand.addListener((command) => {
  if (command !== "trigger-redraft") return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    sendToTab(tab.id, { type: "REDRAFT_CAPTURE" });
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
  }
});
