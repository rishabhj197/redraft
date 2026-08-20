import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { OUTCOMES, buildEvent, recordEvent } from "../lib/events.js";

const BASE = {
  original: "This meeting was very productive.",
  mode: "coach",
  style: "plain",
  model: "claude-haiku-4-5-20251001",
  promptVersion: "v2",
  suggestion: { excerpt: "very productive", fix: "fruitful" },
  outcome: OUTCOMES.APPLIED,
  timestamp: "2026-08-20T09:00:00.000Z",
};

function memoryStore() {
  const events = [];
  return { events, append: async (event) => void events.push(event) };
}

describe("feedback events", () => {
  test("an event carries everything needed to interpret it later", () => {
    const event = buildEvent(BASE);

    assert.deepEqual(event, {
      original: BASE.original,
      mode: "coach",
      style: "plain",
      model: "claude-haiku-4-5-20251001",
      prompt_version: "v2",
      suggestion: BASE.suggestion,
      outcome: "applied",
      reason: null,
      timestamp: "2026-08-20T09:00:00.000Z",
    });
  });

  test("model and prompt version are always present", () => {
    for (const outcome of Object.values(OUTCOMES)) {
      const event = buildEvent({ ...BASE, outcome });
      assert.equal(event.model, "claude-haiku-4-5-20251001");
      assert.equal(event.prompt_version, "v2");
    }
  });

  test("a timestamp is stamped when none is given", () => {
    const { timestamp, ...withoutTimestamp } = BASE;
    const event = buildEvent(withoutTimestamp);
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("an unknown outcome is refused", () => {
    assert.throws(() => buildEvent({ ...BASE, outcome: "liked" }), /unknown outcome "liked"/);
  });

  test("a retry reason must come from the fixed set", () => {
    assert.doesNotThrow(() =>
      buildEvent({ ...BASE, outcome: OUTCOMES.RETRIED, reason: "too_timid" })
    );
    assert.throws(
      () => buildEvent({ ...BASE, outcome: OUTCOMES.RETRIED, reason: "just because" }),
      /unknown reason/
    );
  });

  test("the attribution fields are required", () => {
    for (const field of ["mode", "style", "model", "promptVersion"]) {
      assert.throws(
        () => buildEvent({ ...BASE, [field]: undefined }),
        new RegExp(`"${field}" is required`)
      );
    }
    assert.throws(() => buildEvent({ ...BASE, original: undefined }), /original text is required/);
  });

  test("recordEvent writes through the injected store", async () => {
    const store = memoryStore();

    await recordEvent(BASE, store);
    await recordEvent({ ...BASE, outcome: OUTCOMES.DISMISSED }, store);

    assert.equal(store.events.length, 2);
    assert.equal(store.events[0].outcome, "applied");
    assert.equal(store.events[1].outcome, "dismissed");
    assert.equal(store.events[1].prompt_version, "v2");
  });

  test("recordEvent needs a store — there is no silent default", async () => {
    await assert.rejects(() => recordEvent(BASE, undefined), /a store with an append/);
    await assert.rejects(() => recordEvent(BASE, {}), /a store with an append/);
  });

  test("a bad event never reaches the store", async () => {
    const store = memoryStore();
    await assert.rejects(() => recordEvent({ ...BASE, outcome: "nope" }, store));
    assert.equal(store.events.length, 0);
  });
});
