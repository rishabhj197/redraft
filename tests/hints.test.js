import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { guardCoachResult, hintProblems } from "../lib/hints.js";

const SOURCE = "I am very tired after the long flight, and the meeting was fine.";

function hint(overrides = {}) {
  return {
    span: "very tired",
    suggestion: "exhausted",
    why: "Names the state exactly.",
    category: "vocabulary",
    ...overrides,
  };
}

describe("hint guards", () => {
  test("a local, exact hint has nothing wrong with it", () => {
    assert.deepEqual(hintProblems(SOURCE, hint()), []);
  });

  test("the span has to be in the source, not merely similar", () => {
    const problems = hintProblems(SOURCE, hint({ span: "utterly weary" }));
    assert.ok(problems.includes("span-missing"));
  });

  test("a normalised span still counts as present", () => {
    const source = 'He said "very tired" and sat down.';
    const problems = hintProblems(source, hint({ span: "“very tired”" }));
    assert.deepEqual(problems, []);
  });

  test("replacing the whole draft is a rewrite", () => {
    const problems = hintProblems(SOURCE, hint({ span: SOURCE }));
    assert.ok(problems.includes("full-rewrite"));
  });

  test("a suggestion that restates the draft is a rewrite", () => {
    const problems = hintProblems(
      SOURCE,
      hint({
        span: "fine",
        suggestion: "I am weary after the long flight, and the meeting was adequate.",
      })
    );
    assert.ok(problems.includes("full-rewrite"));
  });

  test("a short phrase in place of a short span is not a rewrite", () => {
    const problems = hintProblems(
      SOURCE,
      hint({ span: "the meeting was fine", suggestion: "the meeting was adequate", category: "precision" })
    );
    assert.deepEqual(problems, []);
  });

  test("an intensifier in the suggestion is banned", () => {
    const problems = hintProblems(SOURCE, hint({ suggestion: "very exhausted" }));
    assert.ok(problems.includes("banned:intensifier"));
  });

  test("a stock flourish in the suggestion is banned", () => {
    const problems = hintProblems(SOURCE, hint({ suggestion: "a vibrant exhaustion" }));
    assert.ok(problems.includes("banned:ai-ism"));
  });

  test("a suggestion with a line break is not a phrase", () => {
    const problems = hintProblems(SOURCE, hint({ suggestion: "exhausted\nand done" }));
    assert.ok(problems.includes("suggestion-multiline"));
  });

  test("a span longer than a short phrase is refused", () => {
    const span = "one two three four five six seven eight nine ten eleven";
    const problems = hintProblems(`Start ${span} end.`, hint({ span, suggestion: "that" }));
    assert.ok(problems.includes("span-too-long"));
  });

  test("a hint that changes nothing is refused", () => {
    const problems = hintProblems(SOURCE, hint({ span: "very tired", suggestion: "Very Tired" }));
    assert.ok(problems.includes("no-change"));
  });
});

describe("guardCoachResult", () => {
  test("keeps the good hint and drops the rewrite", () => {
    const result = guardCoachResult(SOURCE, {
      mode: "coach",
      noChangesNeeded: false,
      hints: [
        hint(),
        hint({
          span: "fine",
          suggestion: "I am weary after the long flight, and the meeting was adequate.",
          category: "rhythm",
        }),
      ],
    });

    assert.equal(result.hints.length, 1);
    assert.equal(result.hints[0].suggestion, "exhausted");
    assert.equal(result.noChangesNeeded, false);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].problems.includes("full-rewrite"));
  });

  test("when every hint is refused, nothing needed changing", () => {
    const result = guardCoachResult(SOURCE, {
      mode: "coach",
      noChangesNeeded: false,
      hints: [hint({ span: "not in the draft" })],
    });

    assert.equal(result.noChangesNeeded, true);
    assert.deepEqual(result.hints, []);
    assert.equal(result.rejected.length, 1);
  });

  test("rewrite mode is left untouched", () => {
    const result = { mode: "rewrite", text: SOURCE };
    assert.equal(guardCoachResult(SOURCE, result), result);
  });
});
