import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Classic script, same as lib/match.js. See the header of lib/trigger.js.
import "../lib/trigger.js";

const { isFinishedThought } = globalThis.RedraftTrigger;

describe("isFinishedThought", () => {
  test("a full stop ends a thought, with or without a trailing space", () => {
    assert.equal(isFinishedThought("I am tired."), true);
    assert.equal(isFinishedThought("I am tired. "), true);
  });

  test("a question mark ends a thought", () => {
    assert.equal(isFinishedThought("Are you coming?"), true);
    assert.equal(isFinishedThought('He asked "why?"'), true);
  });

  test("an exclamation ends a thought", () => {
    assert.equal(isFinishedThought("We won!"), true);
    assert.equal(isFinishedThought("We won!)"), true);
  });

  test("an ellipsis ends a thought", () => {
    assert.equal(isFinishedThought("And then…"), true);
  });

  test("Enter, as a trailing line break, ends a thought", () => {
    assert.equal(isFinishedThought("I am tired\n"), true);
    assert.equal(isFinishedThought("I am tired\n\n"), true);
    assert.equal(isFinishedThought("I am tired \n"), true);
  });

  test("a line the writer is still inside does not", () => {
    assert.equal(isFinishedThought("I am tired"), false);
    assert.equal(isFinishedThought("Are you coming? I think"), false);
    assert.equal(isFinishedThought("We won! and"), false);
  });

  test("a zero-width space after the punctuation does not hide it", () => {
    assert.equal(isFinishedThought("Are you coming?\u200B"), true);
    assert.equal(isFinishedThought("We won!\u200B\n"), true);
    assert.equal(isFinishedThought("I am tired.\uFEFF"), true);
  });

  test("empty text is not a finished thought", () => {
    assert.equal(isFinishedThought(""), false);
    assert.equal(isFinishedThought("   \n"), false);
    assert.equal(isFinishedThought("\u200B"), false);
    assert.equal(isFinishedThought(null), false);
  });
});
