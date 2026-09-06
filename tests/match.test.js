import { test, describe } from "node:test";
import assert from "node:assert/strict";

// lib/match.js is a classic script, not an ES module: content.js has to call it
// synchronously inside a click handler. Importing it for its side effect is how
// Node gets at the same code the extension ships. See the header of that file.
import "../lib/match.js";

const { findExcerpt, hashText, normalise, similarity, DEFAULT_MIN_SCORE } =
  globalThis.RedraftMatch;

/** Apply a match the way content.js does, so a test can read the result. */
function applied(text, excerpt, fix, options) {
  const at = findExcerpt(text, excerpt, options);
  if (!at) return null;
  return text.slice(0, at.start) + fix + text.slice(at.end);
}

describe("normalise", () => {
  test("maps every curly quote onto its straight equivalent", () => {
    assert.equal(normalise("‘a’ “b”").text, "'a' \"b\"");
    assert.equal(normalise("«c»").text, '"c"');
    assert.equal(normalise("6′ 5″").text, "6' 5\"");
  });

  test("collapses any run of dashes to a single hyphen", () => {
    assert.equal(normalise("a--b").text, "a-b");
    assert.equal(normalise("a—b").text, "a-b");
    assert.equal(normalise("a – b").text, "a - b");
    assert.equal(normalise("a---b").text, "a-b");
  });

  test("collapses runs of whitespace, newlines included, to one space", () => {
    assert.equal(normalise("a  b").text, "a b");
    assert.equal(normalise("a\n\nb").text, "a b");
    assert.equal(normalise("a  b").text, "a b");
    assert.equal(normalise("a \t\n b").text, "a b");
  });

  test("drops zero-width characters rather than turning them into spaces", () => {
    assert.equal(normalise("a​b").text, "ab");
    assert.equal(normalise("a﻿b").text, "ab");
  });

  test("treats the ellipsis character and three dots alike", () => {
    assert.equal(normalise("wait…").text, "wait...");
    assert.equal(normalise("wait...").text, "wait...");
  });

  test("the map spans back to the source characters that produced each one", () => {
    // "a  b" -> "a b": the single space came from source [1, 3).
    const folded = normalise("a  b");
    assert.equal(folded.text, "a b");
    assert.deepEqual(folded.starts, [0, 1, 3]);
    assert.deepEqual(folded.ends, [1, 3, 4]);
  });
});

describe("findExcerpt — exact and normalised matches", () => {
  const text = "We should probably ship it on Tuesday. That gives us room.";

  test("finds an untouched excerpt and reports it as exact", () => {
    const at = findExcerpt(text, "should probably ship");
    assert.equal(at.method, "exact");
    assert.equal(text.slice(at.start, at.end), "should probably ship");
    assert.equal(at.score, 1);
  });

  test("ignores whitespace the model left on the ends of the quote", () => {
    const at = findExcerpt(text, "  should probably ship\n");
    assert.equal(at.method, "exact");
    assert.equal(text.slice(at.start, at.end), "should probably ship");
  });

  test("finds it when the model returned curly quotes for straight ones", () => {
    const field = "I don't think that's the right call.";
    const quoted = "I don’t think that’s the right call.";
    const at = findExcerpt(field, quoted);
    assert.equal(at.method, "normalised");
    assert.equal(field.slice(at.start, at.end), field);
  });

  test("finds it when the model returned an em dash for a double hyphen", () => {
    const field = "The plan -- such as it is -- holds.";
    const at = findExcerpt(field, "The plan — such as it is — holds.");
    assert.equal(at.method, "normalised");
    assert.equal(field.slice(at.start, at.end), field);
  });

  test("finds it when the model collapsed a double space", () => {
    const field = "It works.  Mostly.";
    const at = findExcerpt(field, "It works. Mostly.");
    assert.equal(at.method, "normalised");
    assert.equal(field.slice(at.start, at.end), field);
  });

  test("finds it when the model turned a line break into a space", () => {
    const field = "Thanks for the note.\nI'll take a look tomorrow.";
    const at = findExcerpt(field, "Thanks for the note. I'll take a look tomorrow.");
    assert.equal(at.method, "normalised");
    assert.equal(field.slice(at.start, at.end), field);
  });

  test("finds it when the model turned a non-breaking space into a plain one", () => {
    const field = "Due Tuesday at noon.";
    const at = findExcerpt(field, "Due Tuesday at noon.");
    assert.equal(at.method, "normalised");
    assert.equal(field.slice(at.start, at.end), field);
  });

  test("finds it when only the case of the first letter moved", () => {
    const field = "we should ship it on Tuesday.";
    const at = findExcerpt(field, "We should ship it");
    assert.equal(at.method, "case-insensitive");
    assert.equal(field.slice(at.start, at.end), "we should ship it");
  });
});

describe("findExcerpt — replacement lands on the right characters", () => {
  test("a normalised match maps back to the original span exactly", () => {
    const field = "The plan -- such as it is -- holds up.";
    const result = applied(field, "The plan — such as it is — holds up.", "The plan holds.");
    assert.equal(result, "The plan holds.");
  });

  test("a match inside a longer field leaves the surrounding text alone", () => {
    const field = "Hi Sam,\n\nI think it’s very good.  Let me know.\n\nR";
    const result = applied(field, "it's very good.", "it's excellent.");
    assert.equal(result, "Hi Sam,\n\nI think it's excellent.  Let me know.\n\nR");
  });

  test("only the first occurrence is replaced", () => {
    const field = "very good, very fast";
    const result = applied(field, "very good", "excellent");
    assert.equal(result, "excellent, very fast");
  });
});

describe("findExcerpt — similarity fallback", () => {
  const field =
    "I wanted to reach out and see whether you would have some time next " +
    "week to talk through the proposal in a bit more detail.";

  test("finds an excerpt the model requoted with a word dropped", () => {
    const at = findExcerpt(field, "see whether you would have time next week");
    assert.equal(at.method, "similarity");
    assert.ok(at.score >= DEFAULT_MIN_SCORE);
    assert.ok(field.slice(at.start, at.end).startsWith("see whether"));
    assert.ok(field.slice(at.start, at.end).endsWith("next week"));
  });

  test("finds an excerpt the model requoted with a word changed", () => {
    const at = findExcerpt(field, "talk through the proposal in a bit more depth");
    assert.equal(at.method, "similarity");
    assert.equal(
      field.slice(at.start, at.end),
      "talk through the proposal in a bit more detail"
    );
    assert.ok(at.score >= DEFAULT_MIN_SCORE);
  });

  test("gives up rather than replacing text the model never quoted", () => {
    assert.equal(findExcerpt(field, "the quarterly revenue forecast is late"), null);
  });

  test("does not swallow the punctuation on the end of the sentence", () => {
    // The window is cut at whitespace, so the token is "detail." — applying
    // the fix must not take the writer's full stop with it.
    const result = applied(
      field,
      "talk through the proposal in a bit more depth",
      "walk through it properly"
    );
    assert.ok(result.endsWith("walk through it properly."));
  });

  test("gives up on an excerpt below the confidence threshold", () => {
    // Half the words match, which is not enough to be sure which span was meant.
    assert.equal(findExcerpt(field, "talk through the budget with finance"), null);
  });

  test("a caller can loosen the threshold deliberately", () => {
    const excerpt = "talk through the budget with finance";
    assert.equal(findExcerpt(field, excerpt), null);

    const loose = findExcerpt(field, excerpt, { minScore: 0.55 });
    assert.ok(loose);
    assert.ok(loose.score >= 0.55);
    assert.ok(loose.score < DEFAULT_MIN_SCORE);
  });
});

describe("findExcerpt — refusals", () => {
  test("an empty excerpt matches nothing", () => {
    assert.equal(findExcerpt("some text", ""), null);
    assert.equal(findExcerpt("some text", "   "), null);
  });

  test("an empty field matches nothing", () => {
    assert.equal(findExcerpt("", "anything"), null);
  });

  test("a non-string argument matches nothing rather than throwing", () => {
    assert.equal(findExcerpt(null, "a"), null);
    assert.equal(findExcerpt("a", undefined), null);
  });
});

describe("similarity", () => {
  test("scores identical strings 1 and disjoint ones near 0", () => {
    assert.equal(similarity("abc", "abc"), 1);
    assert.ok(similarity("abc", "xyz") < 0.1);
    assert.ok(similarity("the cat sat", "the cat sit") > 0.85);
  });
});

describe("hashText", () => {
  test("is stable for the same text and differs for different text", () => {
    assert.equal(hashText("hello"), hashText("hello"));
    assert.notEqual(hashText("hello"), hashText("hello."));
    assert.equal(typeof hashText(""), "string");
  });
});
