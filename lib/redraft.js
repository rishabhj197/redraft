// One call, end to end: budget check -> request -> fetch -> charge -> parse.
// Pure of chrome.*; fetch and the budget store are injected, so the extension,
// the tests, and the eval harness all drive the exact same path.

import { buildRequest } from "./request.js";
import { ERROR_CODES, RedraftError, parseResponse } from "./parse.js";
import {
  assertWithinBudget,
  budgetSummary,
  costOfCall,
} from "./budget.js";

/**
 * @param {object} call    text, style, mode, model, apiKey, maxTokens
 * @param {object} deps
 * @param {Function} deps.fetch          fetch implementation
 * @param {{read: () => Promise<number>, add: (cost: number) => Promise<object>}} deps.budget
 * @returns {Promise<{result: object, costUsd: number, budget: object, meta: object}>}
 * @throws {import("./budget.js").BudgetExceededError} at or above the refusal threshold
 * @throws {RedraftError} on network, API, or contract failures
 */
export async function runRedraft(call, { fetch: fetchImpl, budget }) {
  // Before every API call. A caller that loops must let this propagate.
  const spentBefore = await budget.read();
  assertWithinBudget(spentBefore);

  const request = buildRequest(call);

  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
  } catch (error) {
    throw new RedraftError(
      ERROR_CODES.NETWORK,
      `Could not reach the Anthropic API: ${error.message}`
    );
  }

  const bodyText = await response.text();

  // Charge for the tokens actually consumed before judging the content — a
  // response whose shape we reject still cost money.
  let usage = null;
  if (response.ok) {
    try {
      usage = JSON.parse(bodyText)?.usage ?? null;
    } catch {
      usage = null;
    }
  }

  let costUsd = 0;
  let budgetAfter = budgetSummary(spentBefore);
  if (usage) {
    costUsd = costOfCall(request.meta.model, usage);
    budgetAfter = await budget.add(costUsd);
  }

  let result;
  try {
    result = parseResponse(
      { ok: response.ok, status: response.status, bodyText },
      request.meta
    );
  } catch (error) {
    // The spend still happened; say so even on the failure path.
    error.budget = budgetAfter;
    error.costUsd = costUsd;
    throw error;
  }

  return { result, costUsd, budget: budgetAfter, meta: request.meta };
}
