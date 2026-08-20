import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ERROR_CODES,
  RedraftError,
  parseResponse,
  validateCoachPayload,
} from "../lib/parse.js";

const COACH_META = {
  promptVersion: "v2",
  model: "claude-haiku-4-5-20251001",
  style: "plain",
  mode: "coach",
};

const REWRITE_META = { ...COACH_META, mode: "rewrite" };

const USAGE = { input_tokens: 412, output_tokens: 96 };

function apiBody(text, usage = USAGE) {
  return JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: COACH_META.model,
    content: [{ type: "text", text }],
    usage,
  });
}

function ok(text, usage) {
  return { ok: true, status: 200, bodyText: apiBody(text, usage) };
}

const COACH_PAYLOAD = {
  noChangesNeeded: false,
  suggestions: [
    {
      excerpt: "very productive",
      issue: 'An intensifier stands in for the word that would say it.',
      fix: "fruitful",
      why: "Names the quality rather than gesturing at its size.",
    },
  ],
  vocabulary: [
    {
      from: "proceed",
      to: "press on",
      why: "Carries the effort of continuing, which proceed does not.",
    },
  ],
};

describe("response parsing — failures", () => {
  test("an API error carries the status and the API's message", () => {
    const response = {
      ok: false,
      status: 401,
      bodyText: JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
    };

    assert.throws(
      () => parseResponse(response, COACH_META),
      (error) => {
        assert.ok(error instanceof RedraftError);
        assert.equal(error.code, ERROR_CODES.API_ERROR);
        assert.equal(error.details.status, 401);
        assert.match(error.message, /401/);
        assert.match(error.message, /invalid x-api-key/);
        return true;
      }
    );
  });

  test("an API error with a non-JSON body still surfaces", () => {
    const response = { ok: false, status: 502, bodyText: "<html>bad gateway</html>" };
    assert.throws(() => parseResponse(response, COACH_META), (error) => {
      assert.equal(error.code, ERROR_CODES.API_ERROR);
      assert.match(error.message, /502/);
      return true;
    });
  });

  test("a malformed JSON body is reported as malformed, not as empty", () => {
    const response = { ok: true, status: 200, bodyText: "{not json" };
    assert.throws(() => parseResponse(response, COACH_META), (error) => {
      assert.equal(error.code, ERROR_CODES.MALFORMED_JSON);
      return true;
    });
  });

  test("empty content is caught for both modes", () => {
    for (const meta of [COACH_META, REWRITE_META]) {
      for (const body of [
        JSON.stringify({ content: [] }),
        JSON.stringify({ content: [{ type: "text", text: "" }] }),
        JSON.stringify({ content: [{ type: "text", text: "   " }] }),
        JSON.stringify({}),
      ]) {
        assert.throws(
          () => parseResponse({ ok: true, status: 200, bodyText: body }, meta),
          (error) => {
            assert.equal(error.code, ERROR_CODES.EMPTY_CONTENT);
            return true;
          }
        );
      }
    }
  });

  test("Coach prose instead of JSON is an invalid coach response", () => {
    assert.throws(
      () => parseResponse(ok("Here are some thoughts on your draft."), COACH_META),
      (error) => {
        assert.equal(error.code, ERROR_CODES.INVALID_COACH_JSON);
        return true;
      }
    );
  });
});

describe("response parsing — rewrite mode", () => {
  test("returns the text, trimmed, with model and prompt version attached", () => {
    const result = parseResponse(ok("  The meeting was fruitful.  "), REWRITE_META);

    assert.equal(result.mode, "rewrite");
    assert.equal(result.text, "The meeting was fruitful.");
    assert.equal(result.promptVersion, "v2");
    assert.equal(result.model, "claude-haiku-4-5-20251001");
    assert.equal(result.style, "plain");
    assert.deepEqual(result.usage, USAGE);
  });

  test("rewrite mode does not try to parse the text as JSON", () => {
    const result = parseResponse(ok("{ this is just prose with a brace"), REWRITE_META);
    assert.equal(result.text, "{ this is just prose with a brace");
  });
});

describe("response parsing — coach mode", () => {
  test("a well-formed payload parses, with model and prompt version attached", () => {
    const result = parseResponse(ok(JSON.stringify(COACH_PAYLOAD)), COACH_META);

    assert.equal(result.mode, "coach");
    assert.equal(result.noChangesNeeded, false);
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].excerpt, "very productive");
    assert.equal(result.vocabulary.length, 1);
    assert.equal(result.vocabulary[0].to, "press on");
    assert.equal(result.promptVersion, "v2");
    assert.equal(result.model, "claude-haiku-4-5-20251001");
    assert.deepEqual(result.usage, USAGE);
  });

  test("noChangesNeeded: true with empty arrays is valid, not an error", () => {
    const result = parseResponse(
      ok(JSON.stringify({ noChangesNeeded: true, suggestions: [], vocabulary: [] })),
      COACH_META
    );

    assert.equal(result.noChangesNeeded, true);
    assert.deepEqual(result.suggestions, []);
    assert.deepEqual(result.vocabulary, []);
    assert.equal(result.promptVersion, "v2");
    assert.equal(result.model, "claude-haiku-4-5-20251001");
  });

  test("a fenced payload is unwrapped rather than failed", () => {
    const fenced = "```json\n" + JSON.stringify(COACH_PAYLOAD) + "\n```";
    const result = parseResponse(ok(fenced), COACH_META);
    assert.equal(result.suggestions.length, 1);
  });

  test("missing arrays default to empty and imply nothing to change", () => {
    const result = parseResponse(ok(JSON.stringify({ noChangesNeeded: true })), COACH_META);
    assert.equal(result.noChangesNeeded, true);
    assert.deepEqual(result.suggestions, []);
    assert.deepEqual(result.vocabulary, []);
  });

  test('"changes needed" with nothing to show is read as nothing to change', () => {
    const result = validateCoachPayload({
      noChangesNeeded: false,
      suggestions: [],
      vocabulary: [],
    });
    assert.equal(result.noChangesNeeded, true);
  });

  test("vocabulary alone is enough to mean changes are needed", () => {
    const result = validateCoachPayload({
      noChangesNeeded: false,
      suggestions: [],
      vocabulary: COACH_PAYLOAD.vocabulary,
    });
    assert.equal(result.noChangesNeeded, false);
    assert.equal(result.vocabulary.length, 1);
  });
});

describe("coach payload validation", () => {
  const invalid = [
    ["a bare array", []],
    ["a string", "no changes"],
    ["null", null],
    ["a missing noChangesNeeded", { suggestions: [], vocabulary: [] }],
    [
      "a non-boolean noChangesNeeded",
      { noChangesNeeded: "false", suggestions: [], vocabulary: [] },
    ],
    [
      "suggestions that are not an array",
      { noChangesNeeded: false, suggestions: {}, vocabulary: [] },
    ],
    [
      "vocabulary that is not an array",
      { noChangesNeeded: false, suggestions: [], vocabulary: "none" },
    ],
    [
      "a suggestion missing why",
      {
        noChangesNeeded: false,
        suggestions: [{ excerpt: "a", issue: "b", fix: "c" }],
        vocabulary: [],
      },
    ],
    [
      "a suggestion with an empty excerpt",
      {
        noChangesNeeded: false,
        suggestions: [{ excerpt: "", issue: "b", fix: "c", why: "d" }],
        vocabulary: [],
      },
    ],
    [
      "a suggestion that is not an object",
      { noChangesNeeded: false, suggestions: ["cut the intensifier"], vocabulary: [] },
    ],
    [
      "a vocabulary entry missing to",
      {
        noChangesNeeded: false,
        suggestions: [],
        vocabulary: [{ from: "big", why: "more exact" }],
      },
    ],
    [
      "noChangesNeeded: true alongside actual changes",
      { ...COACH_PAYLOAD, noChangesNeeded: true },
    ],
  ];

  for (const [label, payload] of invalid) {
    test(`rejects ${label}`, () => {
      assert.throws(
        () => validateCoachPayload(payload),
        (error) => {
          assert.ok(error instanceof RedraftError);
          assert.equal(error.code, ERROR_CODES.INVALID_COACH_JSON);
          return true;
        }
      );
    });
  }
});
