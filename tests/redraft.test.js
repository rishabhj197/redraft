import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runRedraft } from "../lib/redraft.js";
import { ERROR_CODES } from "../lib/parse.js";
import {
  BUDGET_REFUSAL_THRESHOLD_USD,
  BudgetExceededError,
  addSpend,
  budgetSummary,
} from "../lib/budget.js";
import { ANTHROPIC_API_URL } from "../lib/request.js";

const CALL = {
  text: "This meeting was very productive.",
  style: "plain",
  mode: "coach",
  model: "claude-haiku-4-5-20251001",
  apiKey: "sk-ant-test-key",
};

const COACH_JSON = JSON.stringify({
  noChangesNeeded: false,
  hints: [
    {
      span: "very productive",
      suggestion: "fruitful",
      why: "Names the quality instead of gesturing at its size.",
      category: "precision",
    },
  ],
});

// Every test here mocks fetch. No test in this suite makes a real API call.
function mockFetch(bodyObject, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      text: async () =>
        typeof bodyObject === "string" ? bodyObject : JSON.stringify(bodyObject),
    };
  };
  fn.calls = calls;
  return fn;
}

function messageBody(text, usage = { input_tokens: 1000, output_tokens: 500 }) {
  return { content: [{ type: "text", text }], usage };
}

function memoryBudget(initial = 0) {
  let spent = initial;
  return {
    read: async () => spent,
    add: async (cost) => {
      spent = addSpend(spent, cost);
      return budgetSummary(spent);
    },
    get spent() {
      return spent;
    },
  };
}

describe("runRedraft — happy path", () => {
  test("sends the built request and returns a parsed coach result", async () => {
    const fetchImpl = mockFetch(messageBody(COACH_JSON));
    const budget = memoryBudget();

    const { result, costUsd, budget: after, meta } = await runRedraft(CALL, {
      fetch: fetchImpl,
      budget,
    });

    assert.equal(fetchImpl.calls.length, 1);
    const [{ url, init }] = fetchImpl.calls;
    assert.equal(url, ANTHROPIC_API_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-api-key"], "sk-ant-test-key");
    assert.equal(init.headers["anthropic-version"], "2023-06-01");

    const sent = JSON.parse(init.body);
    assert.equal(sent.model, "claude-haiku-4-5-20251001");
    assert.match(sent.system, /Target style — Plain/);
    assert.match(sent.system, /Mode — Coach/);

    assert.equal(result.hints.length, 1);
    assert.equal(result.hints[0].suggestion, "fruitful");
    assert.equal(result.promptVersion, "v3");
    assert.equal(result.model, "claude-haiku-4-5-20251001");
    assert.equal(meta.promptVersion, "v3");

    assert.equal(costUsd, 0.0035);
    assert.equal(after.spentUsd, 0.0035);
    assert.equal(budget.spent, 0.0035);
  });

  test("rewrite mode returns text and charges the same way", async () => {
    const budget = memoryBudget();
    const { result, costUsd } = await runRedraft(
      { ...CALL, mode: "rewrite", model: "claude-opus-5" },
      { fetch: mockFetch(messageBody("The meeting was fruitful.")), budget }
    );

    assert.equal(result.text, "The meeting was fruitful.");
    assert.equal(result.model, "claude-opus-5");
    assert.equal(costUsd, 0.0175);
  });

  test("a noChangesNeeded response is a success, not an error", async () => {
    const body = messageBody(
      JSON.stringify({ noChangesNeeded: true, hints: [] })
    );
    const { result } = await runRedraft(CALL, {
      fetch: mockFetch(body),
      budget: memoryBudget(),
    });

    assert.equal(result.noChangesNeeded, true);
    assert.deepEqual(result.hints, []);
  });
});

describe("runRedraft — budget guard", () => {
  test("refuses before the call when spend is at the threshold", async () => {
    const fetchImpl = mockFetch(messageBody(COACH_JSON));
    const budget = memoryBudget(BUDGET_REFUSAL_THRESHOLD_USD);

    await assert.rejects(
      () => runRedraft(CALL, { fetch: fetchImpl, budget }),
      (error) => {
        assert.ok(error instanceof BudgetExceededError);
        assert.equal(error.spentUsd, 4.5);
        return true;
      }
    );

    assert.equal(fetchImpl.calls.length, 0, "no request may be sent once refused");
  });

  test("proceeds just under the threshold", async () => {
    const fetchImpl = mockFetch(messageBody(COACH_JSON));
    const budget = memoryBudget(4.4999);

    const { budget: after } = await runRedraft(CALL, { fetch: fetchImpl, budget });

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(after.spentUsd, 4.5034);
  });

  test("an autonomous loop stops at the guard and reports what is undone", async () => {
    const fetchImpl = mockFetch(
      messageBody(COACH_JSON, { input_tokens: 300_000, output_tokens: 0 })
    );
    const budget = memoryBudget();
    const queue = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const done = [];
    let stopReport = null;

    for (const [index, item] of queue.entries()) {
      try {
        await runRedraft(
          { ...CALL, text: `draft ${item}`, model: "claude-opus-5" },
          { fetch: fetchImpl, budget }
        );
        done.push(item);
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          stopReport = {
            stoppedAt: item,
            completed: [...done],
            remaining: queue.slice(index),
            spentUsd: error.spentUsd,
          };
          break; // stop immediately: never retry, never continue past it
        }
        throw error;
      }
    }

    assert.ok(stopReport, "the loop must have tripped the guard");
    assert.deepEqual(stopReport.completed, ["a", "b", "c"]);
    assert.deepEqual(stopReport.remaining, ["d", "e", "f", "g", "h"]);
    assert.equal(stopReport.stoppedAt, "d");
    assert.equal(stopReport.spentUsd, 4.5);
    assert.equal(fetchImpl.calls.length, 3, "no call is made after the guard trips");
  });

  test("a rejected response shape is still charged for", async () => {
    const budget = memoryBudget();

    await assert.rejects(
      () =>
        runRedraft(CALL, {
          fetch: mockFetch(messageBody("Here are some thoughts on your draft.")),
          budget,
        }),
      (error) => {
        assert.equal(error.code, ERROR_CODES.INVALID_COACH_JSON);
        assert.equal(error.costUsd, 0.0035);
        assert.equal(error.budget.spentUsd, 0.0035);
        return true;
      }
    );

    assert.equal(budget.spent, 0.0035, "tokens were spent, so the total must move");
  });

  test("an API error is not charged for", async () => {
    const budget = memoryBudget();

    await assert.rejects(
      () =>
        runRedraft(CALL, {
          fetch: mockFetch(
            { type: "error", error: { message: "overloaded" } },
            { ok: false, status: 529 }
          ),
          budget,
        }),
      (error) => {
        assert.equal(error.code, ERROR_CODES.API_ERROR);
        assert.equal(error.details.status, 529);
        return true;
      }
    );

    assert.equal(budget.spent, 0);
  });
});

describe("runRedraft — failure paths", () => {
  test("a network failure is reported as a network error", async () => {
    const failing = async () => {
      throw new Error("Failed to fetch");
    };

    await assert.rejects(
      () => runRedraft(CALL, { fetch: failing, budget: memoryBudget() }),
      (error) => {
        assert.equal(error.code, ERROR_CODES.NETWORK);
        assert.match(error.message, /Failed to fetch/);
        return true;
      }
    );
  });

  test("a malformed body is reported as malformed", async () => {
    await assert.rejects(
      () =>
        runRedraft(CALL, {
          fetch: mockFetch("{not json"),
          budget: memoryBudget(),
        }),
      (error) => {
        assert.equal(error.code, ERROR_CODES.MALFORMED_JSON);
        return true;
      }
    );
  });

  test("empty content is reported as empty", async () => {
    await assert.rejects(
      () =>
        runRedraft(CALL, {
          fetch: mockFetch({ content: [], usage: { input_tokens: 10 } }),
          budget: memoryBudget(),
        }),
      (error) => {
        assert.equal(error.code, ERROR_CODES.EMPTY_CONTENT);
        return true;
      }
    );
  });

  test("the API key never appears in an error message", async () => {
    await assert.rejects(
      () =>
        runRedraft(CALL, {
          fetch: mockFetch({ error: { message: "bad key" } }, { ok: false, status: 401 }),
          budget: memoryBudget(),
        }),
      (error) => {
        assert.ok(!error.message.includes(CALL.apiKey));
        return true;
      }
    );
  });
});
