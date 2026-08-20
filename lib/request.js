// Anthropic Messages API request construction. Pure functions — no chrome.*
// calls, no fetch. Hand this to fetch() in the extension, or to node's fetch in
// the eval harness; both then get exactly the same request.

import { PROMPT_VERSION, buildSystemPrompt } from "./prompts.js";

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_MAX_TOKENS = 2048;

// The model is a variable we will deliberately change during evals, so it is
// never hardcoded at a call site — it travels as a parameter and comes back out
// attached to every parsed response and every stored event.
export const MODELS = [
  { key: "haiku", id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { key: "sonnet", id: "claude-sonnet-5", label: "Sonnet 5" },
  { key: "opus", id: "claude-opus-5", label: "Opus 5" },
];

export const MODEL_IDS = MODELS.map((m) => m.id);
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export function isKnownModel(model) {
  return MODEL_IDS.includes(model);
}

/**
 * Build everything one API call needs.
 *
 * @param {object} options
 * @param {string} options.text     the writer's text
 * @param {string} options.style    plain | classic | warm
 * @param {string} options.mode     coach | rewrite
 * @param {string} options.model    an Anthropic model id — required, never defaulted here
 * @param {string} options.apiKey
 * @param {number} [options.maxTokens]
 * @returns {{url: string, method: string, headers: object, body: object, meta: object}}
 */
export function buildRequest({
  text,
  style,
  mode,
  model,
  apiKey,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Redraft: no text to work on.");
  }
  if (!model) {
    throw new Error("Redraft: a model must be passed explicitly.");
  }
  if (!apiKey) {
    throw new Error("Redraft: no API key. Set one on the options page.");
  }

  const system = buildSystemPrompt({ style, mode });

  return {
    url: ANTHROPIC_API_URL,
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      // Required for calls made from an extension's own origin.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: text }],
    },
    // Carried alongside the request so the model and prompt version can be
    // attached to the parsed response, the log line, and the stored event
    // without anyone having to remember to thread them through.
    meta: { promptVersion: PROMPT_VERSION, model, style, mode },
  };
}
