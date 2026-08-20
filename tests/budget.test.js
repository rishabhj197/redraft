import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  BUDGET_LIMIT_USD,
  BUDGET_REFUSAL_FRACTION,
  BUDGET_REFUSAL_THRESHOLD_USD,
  BudgetExceededError,
  MODEL_RATES,
  addSpend,
  assertWithinBudget,
  budgetSummary,
  costOfCall,
  isOverBudget,
  remainingBudget,
} from "../lib/budget.js";
import { MODEL_IDS } from "../lib/request.js";

describe("budget constants", () => {
  test("the cap is $5.00 and lives in exactly one place", () => {
    assert.equal(BUDGET_LIMIT_USD, 5.0);
  });

  test("calls are refused at 90% of the cap", () => {
    assert.equal(BUDGET_REFUSAL_FRACTION, 0.9);
    assert.equal(BUDGET_REFUSAL_THRESHOLD_USD, 4.5);
    assert.equal(BUDGET_REFUSAL_THRESHOLD_USD, BUDGET_LIMIT_USD * 0.9);
  });

  test("every selectable model has a rate", () => {
    for (const model of MODEL_IDS) {
      assert.ok(MODEL_RATES[model], `no rate for ${model}`);
      assert.equal(typeof MODEL_RATES[model].inputPerMTok, "number");
      assert.equal(typeof MODEL_RATES[model].outputPerMTok, "number");
    }
  });
});

describe("cost calculation", () => {
  const usage = { input_tokens: 1000, output_tokens: 500 };

  test("prices Haiku from its own rate", () => {
    assert.equal(costOfCall("claude-haiku-4-5-20251001", usage), 0.0035);
  });

  test("prices Sonnet from its own rate", () => {
    assert.equal(costOfCall("claude-sonnet-5", usage), 0.0105);
  });

  test("prices Opus from its own rate", () => {
    assert.equal(costOfCall("claude-opus-5", usage), 0.0175);
  });

  test("the three models are priced differently, cheapest first", () => {
    const haiku = costOfCall("claude-haiku-4-5-20251001", usage);
    const sonnet = costOfCall("claude-sonnet-5", usage);
    const opus = costOfCall("claude-opus-5", usage);
    assert.ok(haiku < sonnet && sonnet < opus);
  });

  test("output tokens cost more than input tokens", () => {
    const allInput = costOfCall("claude-sonnet-5", {
      input_tokens: 1000,
      output_tokens: 0,
    });
    const allOutput = costOfCall("claude-sonnet-5", {
      input_tokens: 0,
      output_tokens: 1000,
    });
    assert.ok(allOutput > allInput);
  });

  test("cache tokens are priced, not dropped", () => {
    const cost = costOfCall("claude-haiku-4-5-20251001", {
      input_tokens: 1000,
      output_tokens: 0,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 1000,
    });
    // 1000 + (1000 * 1.25) + (1000 * 0.1) = 2350 input units at $1/MTok
    assert.equal(cost, 0.00235);
  });

  test("missing or empty usage costs nothing rather than throwing", () => {
    assert.equal(costOfCall("claude-opus-5", undefined), 0);
    assert.equal(costOfCall("claude-opus-5", {}), 0);
  });

  test("an unpriced model throws — an uncounted call is worse than a loud one", () => {
    assert.throws(
      () => costOfCall("claude-3-opus-20240229", usage),
      /no pricing for model "claude-3-opus-20240229"/
    );
  });
});

describe("accumulation", () => {
  test("costs add across calls and never reset on their own", () => {
    let spent = 0;
    const usage = { input_tokens: 1000, output_tokens: 500 };

    for (let i = 0; i < 4; i += 1) {
      spent = addSpend(spent, costOfCall("claude-haiku-4-5-20251001", usage));
    }

    assert.equal(spent, 0.014);
    assert.equal(remainingBudget(spent), 4.986);
  });

  test("accumulation survives float arithmetic across many small calls", () => {
    let spent = 0;
    for (let i = 0; i < 1000; i += 1) {
      spent = addSpend(spent, costOfCall("claude-sonnet-5", { input_tokens: 100 }));
    }
    // 1000 calls x 100 tokens x $3/MTok = $0.30
    assert.equal(spent, 0.3);
  });

  test("addSpend treats an absent total as zero", () => {
    assert.equal(addSpend(undefined, 0.25), 0.25);
    assert.equal(addSpend(null, 0.25), 0.25);
  });
});

describe("refusal at the threshold", () => {
  test("passes comfortably under the threshold", () => {
    assert.doesNotThrow(() => assertWithinBudget(0));
    assert.doesNotThrow(() => assertWithinBudget(1.25));
    assert.equal(isOverBudget(1.25), false);
  });

  test("passes just under the threshold", () => {
    assert.doesNotThrow(() => assertWithinBudget(4.4999));
    assert.equal(isOverBudget(4.4999), false);
  });

  test("refuses exactly at the threshold", () => {
    assert.equal(isOverBudget(4.5), true);
    assert.throws(() => assertWithinBudget(4.5), BudgetExceededError);
  });

  test("refuses above the threshold, and above the cap", () => {
    assert.throws(() => assertWithinBudget(4.75), BudgetExceededError);
    assert.throws(() => assertWithinBudget(6.0), BudgetExceededError);
  });

  test("the error names the spend and the cap", () => {
    assert.throws(
      () => assertWithinBudget(4.62),
      (error) => {
        assert.ok(error instanceof BudgetExceededError);
        assert.equal(error.code, "budget_exceeded");
        assert.equal(error.spentUsd, 4.62);
        assert.equal(error.limitUsd, 5.0);
        assert.equal(error.thresholdUsd, 4.5);
        assert.equal(error.remainingUsd, 0.38);
        assert.match(error.message, /\$4\.6200/);
        assert.match(error.message, /\$5\.0000/);
        assert.match(error.message, /90%/);
        return true;
      }
    );
  });

  test("a loop crosses the threshold and stops without a further call", () => {
    // Three Opus calls of $1.50 each land exactly on the $4.50 threshold.
    const usage = { input_tokens: 300_000, output_tokens: 0 };
    let spent = 0;
    let callsMade = 0;
    let stoppedAt = null;

    for (let i = 0; i < 10; i += 1) {
      try {
        assertWithinBudget(spent);
      } catch (error) {
        assert.ok(error instanceof BudgetExceededError);
        stoppedAt = i;
        break; // stop immediately — never retry, never continue
      }
      spent = addSpend(spent, costOfCall("claude-opus-5", usage));
      callsMade += 1;
    }

    assert.equal(callsMade, 3);
    assert.equal(spent, 4.5);
    assert.equal(stoppedAt, 3, "the loop must stop on the 4th iteration");
  });
});

describe("budget reporting", () => {
  test("the summary reports spend and what remains", () => {
    const summary = budgetSummary(1.234567);
    assert.equal(summary.limitUsd, 5.0);
    assert.equal(summary.spentUsd, 1.234567);
    assert.equal(summary.remainingUsd, 3.765433);
    assert.equal(summary.refusalThresholdUsd, 4.5);
    assert.equal(summary.spentFormatted, "$1.2346");
    assert.equal(summary.remainingFormatted, "$3.7654");
  });

  test("remaining budget can go negative rather than clamping and lying", () => {
    assert.equal(remainingBudget(5.5), -0.5);
  });
});
