import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  MODELS,
  MODEL_IDS,
  buildRequest,
  isKnownModel,
} from "../lib/request.js";
import { PROMPT_VERSION, buildSystemPrompt } from "../lib/prompts.js";

const VALID = {
  text: "This meeting was very productive and I think we should maybe proceed.",
  style: "classic",
  mode: "coach",
  model: "claude-sonnet-5",
  apiKey: "sk-ant-test-key",
};

describe("request construction", () => {
  test("targets the Messages API with the documented headers", () => {
    const request = buildRequest(VALID);

    assert.equal(request.url, ANTHROPIC_API_URL);
    assert.equal(request.url, "https://api.anthropic.com/v1/messages");
    assert.equal(request.method, "POST");
    assert.deepEqual(request.headers, {
      "x-api-key": "sk-ant-test-key",
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
  });

  test("body shape matches the Messages API", () => {
    const request = buildRequest(VALID);

    assert.deepEqual(Object.keys(request.body).sort(), [
      "max_tokens",
      "messages",
      "model",
      "system",
    ]);
    assert.equal(request.body.model, "claude-sonnet-5");
    assert.equal(request.body.max_tokens, DEFAULT_MAX_TOKENS);
    assert.equal(
      request.body.system,
      buildSystemPrompt({ style: "classic", mode: "coach" })
    );
    assert.deepEqual(request.body.messages, [
      { role: "user", content: VALID.text },
    ]);
  });

  test("max_tokens is overridable", () => {
    assert.equal(buildRequest({ ...VALID, maxTokens: 64 }).body.max_tokens, 64);
  });

  test("PROMPT_VERSION and model are carried on the request meta", () => {
    const request = buildRequest(VALID);
    assert.equal(request.meta.promptVersion, PROMPT_VERSION);
    assert.equal(request.meta.promptVersion, "v2");
    assert.equal(request.meta.model, "claude-sonnet-5");
    assert.equal(request.meta.style, "classic");
    assert.equal(request.meta.mode, "coach");
  });

  test("the model is never defaulted inside the request builder", () => {
    assert.throws(
      () => buildRequest({ ...VALID, model: undefined }),
      /a model must be passed explicitly/
    );
  });

  test("missing key or empty text is refused before any call is shaped", () => {
    assert.throws(() => buildRequest({ ...VALID, apiKey: "" }), /no API key/);
    assert.throws(() => buildRequest({ ...VALID, text: "   " }), /no text to work on/);
    assert.throws(() => buildRequest({ ...VALID, text: undefined }), /no text to work on/);
  });

  test("an unknown style still throws, via prompt assembly", () => {
    assert.throws(() => buildRequest({ ...VALID, style: "tharoor" }), /unknown style/);
  });

  test("the three selectable models are the ones the brief names", () => {
    assert.deepEqual(MODEL_IDS, [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
    assert.equal(DEFAULT_MODEL, "claude-haiku-4-5-20251001");
    assert.ok(MODELS.every((m) => m.key && m.id && m.label));
    assert.ok(isKnownModel("claude-opus-5"));
    assert.ok(!isKnownModel("claude-3-opus-20240229"));
  });

  test("the request body serialises to JSON", () => {
    const request = buildRequest(VALID);
    const roundTripped = JSON.parse(JSON.stringify(request.body));
    assert.deepEqual(roundTripped, request.body);
  });
});
