import { DEFAULT_MODEL, MODELS } from "./lib/request.js";
import { DEFAULT_MODE, DEFAULT_STYLE, MODES, STYLES } from "./lib/prompts.js";
import { BUDGET_LIMIT_USD, budgetSummary, isOverBudget } from "./lib/budget.js";

const SPEND_KEY = "budgetSpentUsd";

const apiKeyInput = document.getElementById("api-key");
const modeSelect = document.getElementById("mode");
const modeHint = document.getElementById("mode-hint");
const styleSelect = document.getElementById("style");
const modelSelect = document.getElementById("model");
const autoAnalyseInput = document.getElementById("auto-analyse");
const saveButton = document.getElementById("save");
const status = document.getElementById("status");
const budgetBlock = document.getElementById("budget");
const budgetLine = document.getElementById("budget-line");
const resetBudgetButton = document.getElementById("reset-budget");

const MODE_LABELS = {
  coach: "Hints — a better word, and why",
  rewrite: "Rewrite — a finished line",
};

const MODE_HINTS = {
  coach:
    "Redraft offers a word or a short phrase, and a reason. You apply the one you want. The sentence stays yours.",
  rewrite:
    "Redraft returns a finished line. Kept for throwaway text. It is not the point of the tool.",
};

const STYLE_LABELS = {
  plain: "Plain — Orwell's rules",
  classic: "Classic — Thomas & Turner",
  warm: "Warm — conversational",
};

function fill(select, values, labels) {
  select.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = labels[value] ?? value;
      return option;
    })
  );
}

fill(modeSelect, MODES, MODE_LABELS);
fill(styleSelect, STYLES, STYLE_LABELS);
modelSelect.replaceChildren(
  ...MODELS.map(({ id, label }) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    return option;
  })
);

function updateModeHint() {
  modeHint.textContent = MODE_HINTS[modeSelect.value] ?? "";
}

modeSelect.addEventListener("change", updateModeHint);

function renderBudget(spentUsd) {
  const summary = budgetSummary(spentUsd);
  budgetLine.innerHTML = "";
  budgetLine.append(
    document.createTextNode("Spend so far: "),
    Object.assign(document.createElement("strong"), {
      textContent: summary.spentFormatted,
    }),
    document.createTextNode(
      ` of a $${BUDGET_LIMIT_USD.toFixed(2)} cap. ` +
        `${summary.remainingFormatted} remaining; calls stop at ` +
        `$${summary.refusalThresholdUsd.toFixed(2)}.`
    )
  );
  budgetBlock.classList.toggle("over", isOverBudget(spentUsd));
}

function flash(text) {
  status.textContent = text;
  setTimeout(() => {
    status.textContent = "";
  }, 2000);
}

function loadSaved() {
  chrome.storage.local.get(
    ["apiKey", "style", "mode", "model", "autoAnalyse", SPEND_KEY],
    (stored) => {
      if (stored.apiKey) apiKeyInput.value = stored.apiKey;
      modeSelect.value = MODES.includes(stored.mode) ? stored.mode : DEFAULT_MODE;
      styleSelect.value = STYLES.includes(stored.style) ? stored.style : DEFAULT_STYLE;
      modelSelect.value = MODELS.some((m) => m.id === stored.model)
        ? stored.model
        : DEFAULT_MODEL;
      autoAnalyseInput.checked = stored.autoAnalyse !== false;
      updateModeHint();
      renderBudget(typeof stored[SPEND_KEY] === "number" ? stored[SPEND_KEY] : 0);
    }
  );
}

saveButton.addEventListener("click", () => {
  chrome.storage.local.set(
    {
      apiKey: apiKeyInput.value.trim(),
      mode: modeSelect.value,
      style: styleSelect.value,
      model: modelSelect.value,
      autoAnalyse: autoAnalyseInput.checked,
    },
    () => flash("Saved")
  );
});

resetBudgetButton.addEventListener("click", () => {
  chrome.storage.local.set({ [SPEND_KEY]: 0 }, () => {
    renderBudget(0);
    flash("Spend counter reset");
  });
});

loadSaved();
