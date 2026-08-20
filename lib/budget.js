// Budget guard. Pure functions — no chrome.* calls, no I/O.
//
// The Anthropic API does not report a remaining balance, so spend is tracked
// locally: every response's usage is priced here and added to a persisted
// total. The extension persists that total in chrome.storage.local; Node
// scripts persist it in .budget.json (see budget-store-node.js). The total
// never resets on its own.

// ---------------------------------------------------------------------------
// MANUAL UPDATE REQUIRED IF ANTHROPIC CHANGES PRICING.
// USD per million tokens, from the published list rates. Nothing checks these
// against the API — if pricing moves and this table does not, every cost
// figure below is wrong and the guard trips at the wrong point.
// Last checked: 2026-08-20.
// (Sonnet 5 carries a lower introductory rate through 2026-08-31; the list
// rate is used here so the guard errs towards over-counting spend.)
// ---------------------------------------------------------------------------
export const MODEL_RATES = {
  "claude-haiku-4-5-20251001": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-sonnet-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-opus-5": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
};

// Cache writes cost 1.25x the input rate, cache reads 0.1x. Redraft does not
// use prompt caching yet, but usage may report these fields and they should be
// priced rather than silently dropped.
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** The whole cap, defined once. */
export const BUDGET_LIMIT_USD = 5.0;

/** Calls are refused at or above this fraction of the cap. */
export const BUDGET_REFUSAL_FRACTION = 0.9;

/** The spend figure at which calls stop, in USD. */
export const BUDGET_REFUSAL_THRESHOLD_USD =
  BUDGET_LIMIT_USD * BUDGET_REFUSAL_FRACTION;

const TOKENS_PER_MILLION = 1_000_000;

export class BudgetExceededError extends Error {
  constructor(spentUsd) {
    super(
      `Redraft: budget guard tripped. Spent ${formatUsd(spentUsd)} of a ` +
        `${formatUsd(BUDGET_LIMIT_USD)} cap, at or above the ` +
        `${Math.round(BUDGET_REFUSAL_FRACTION * 100)}% refusal threshold of ` +
        `${formatUsd(BUDGET_REFUSAL_THRESHOLD_USD)}. No further API calls will ` +
        `be made. Raise BUDGET_LIMIT_USD in lib/budget.js, or reset the stored ` +
        `total, to continue.`
    );
    this.name = "BudgetExceededError";
    this.code = "budget_exceeded";
    this.spentUsd = spentUsd;
    this.limitUsd = BUDGET_LIMIT_USD;
    this.thresholdUsd = BUDGET_REFUSAL_THRESHOLD_USD;
    this.remainingUsd = remainingBudget(spentUsd);
  }
}

export function formatUsd(amount) {
  return `$${amount.toFixed(4)}`;
}

/** Round to the nearest hundred-thousandth of a cent, so floats do not drift. */
function round(amount) {
  return Math.round(amount * 1e7) / 1e7;
}

/**
 * Price one call from its reported usage.
 * @param {string} model
 * @param {{input_tokens?: number, output_tokens?: number,
 *          cache_creation_input_tokens?: number,
 *          cache_read_input_tokens?: number}} usage
 * @returns {number} USD
 */
export function costOfCall(model, usage) {
  const rates = MODEL_RATES[model];
  if (!rates) {
    throw new Error(
      `Redraft: no pricing for model "${model}". Add it to MODEL_RATES in ` +
        `lib/budget.js — an unpriced call cannot be counted against the budget.`
    );
  }

  const u = usage ?? {};
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;

  const inputUnits =
    input +
    cacheWrite * CACHE_WRITE_MULTIPLIER +
    cacheRead * CACHE_READ_MULTIPLIER;

  const cost =
    (inputUnits * rates.inputPerMTok + output * rates.outputPerMTok) /
    TOKENS_PER_MILLION;

  return round(cost);
}

/** Add one call's cost to a running total. */
export function addSpend(spentUsd, callCostUsd) {
  return round((spentUsd ?? 0) + callCostUsd);
}

export function remainingBudget(spentUsd) {
  return round(BUDGET_LIMIT_USD - (spentUsd ?? 0));
}

export function isOverBudget(spentUsd) {
  return (spentUsd ?? 0) >= BUDGET_REFUSAL_THRESHOLD_USD;
}

/**
 * Call before every API call. Throws BudgetExceededError at or above the
 * refusal threshold. Any looping or autonomous process must catch this, stop
 * immediately, and report where it stopped — never retry, never continue.
 */
export function assertWithinBudget(spentUsd) {
  if (isOverBudget(spentUsd)) {
    throw new BudgetExceededError(spentUsd ?? 0);
  }
}

/** One line for the log after every call. */
export function budgetSummary(spentUsd) {
  const spent = spentUsd ?? 0;
  return {
    spentUsd: round(spent),
    limitUsd: BUDGET_LIMIT_USD,
    remainingUsd: remainingBudget(spent),
    refusalThresholdUsd: round(BUDGET_REFUSAL_THRESHOLD_USD),
    spentFormatted: formatUsd(spent),
    remainingFormatted: formatUsd(remainingBudget(spent)),
  };
}
