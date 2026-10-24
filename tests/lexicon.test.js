import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { LEXICON_LIMIT, addToLexicon, entryFromHint } from "../lib/lexicon.js";

const WHEN = "2026-10-24T18:00:00.000Z";

describe("entryFromHint", () => {
  test("a hint becomes a lexicon row", () => {
    const entry = entryFromHint(
      {
        span: "very tired",
        suggestion: "exhausted",
        why: "Names the state.",
        category: "vocabulary",
      },
      { style: "classic", timestamp: WHEN }
    );

    assert.deepEqual(entry, {
      from: "very tired",
      to: "exhausted",
      why: "Names the state.",
      category: "vocabulary",
      style: "classic",
      timestamp: WHEN,
    });
  });

  test("a whole-draft rewrite is not a word the writer learned", () => {
    const entry = entryFromHint(
      {
        excerpt: "I am very tired after the flight.",
        fix: "The flight left me exhausted.",
        why: "Rewritten.",
      },
      { style: "plain", timestamp: WHEN }
    );
    assert.equal(entry, null);
  });

  test("an empty suggestion is refused", () => {
    assert.equal(
      entryFromHint({ span: "tired", suggestion: "  ", why: "x", category: "vocabulary" }, {
        timestamp: WHEN,
      }),
      null
    );
  });
});

describe("addToLexicon", () => {
  test("newest first, and the same pair is not listed twice", () => {
    const first = entryFromHint(
      { span: "very tired", suggestion: "exhausted", why: "First.", category: "vocabulary" },
      { timestamp: WHEN }
    );
    const again = entryFromHint(
      { span: "very tired", suggestion: "exhausted", why: "Sharper.", category: "vocabulary" },
      { timestamp: "2026-10-25T18:00:00.000Z" }
    );
    const other = entryFromHint(
      { span: "big", suggestion: "vast", why: "Scale.", category: "precision" },
      { timestamp: "2026-10-25T19:00:00.000Z" }
    );

    const list = addToLexicon(addToLexicon([first], again), other);
    assert.equal(list.length, 2);
    assert.equal(list[0].to, "vast");
    assert.equal(list[1].why, "Sharper.");
    assert.equal(list[1].timestamp, "2026-10-25T18:00:00.000Z");
  });

  test("the list is capped and keeps the newest", () => {
    let list = [];
    for (let i = 0; i < LEXICON_LIMIT + 5; i += 1) {
      list = addToLexicon(
        list,
        entryFromHint(
          { span: `word ${i}`, suggestion: `better ${i}`, why: "x", category: "vocabulary" },
          { timestamp: WHEN }
        )
      );
    }
    assert.equal(list.length, LEXICON_LIMIT);
    assert.equal(list[0].to, `better ${LEXICON_LIMIT + 4}`);
    assert.equal(list.at(-1).to, "better 5");
  });

  test("a missing list is treated as empty", () => {
    const entry = entryFromHint(
      { span: "nice", suggestion: "exact", why: "Which kind of good.", category: "precision" },
      { timestamp: WHEN }
    );
    assert.deepEqual(addToLexicon(undefined, entry), [entry]);
  });
});
