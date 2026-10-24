// Response parsing and validation. Pure functions — no chrome.* calls, no fetch.

export const ERROR_CODES = {
  API_ERROR: "api_error",
  NETWORK: "network_error",
  MALFORMED_JSON: "malformed_json",
  EMPTY_CONTENT: "empty_content",
  INVALID_COACH_JSON: "invalid_coach_json",
  BUDGET_EXCEEDED: "budget_exceeded",
};

export class RedraftError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RedraftError";
    this.code = code;
    this.details = details;
  }
}

function extractApiErrorMessage(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    return data?.error?.message ?? bodyText;
  } catch {
    return bodyText;
  }
}

// Models sometimes wrap JSON in a fence despite being told not to. Stripping it
// is cheaper than a retry, and the fence is not a contract violation worth
// failing the call over.
function stripCodeFence(text) {
  const fenced = text
    .trim()
    .match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/i);
  return fenced ? fenced[1].trim() : text.trim();
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringFields(item, fields, where) {
  for (const field of fields) {
    if (typeof item[field] !== "string" || item[field].trim() === "") {
      throw new RedraftError(
        ERROR_CODES.INVALID_COACH_JSON,
        `Coach response: ${where} is missing a non-empty "${field}".`
      );
    }
  }
}

/** Categories a hint is allowed to carry. Anything else is a contract break. */
export const HINT_CATEGORIES = ["vocabulary", "precision", "rhythm", "ornament"];

/**
 * Validate and normalise a Coach-mode payload against the hint contract.
 * `noChangesNeeded: true` with an empty hint list is valid and desirable.
 * A hint is a span, a short replacement, a reason, and a category — not a rewrite.
 */
export function validateCoachPayload(payload) {
  if (!isPlainObject(payload)) {
    throw new RedraftError(
      ERROR_CODES.INVALID_COACH_JSON,
      "Coach response was not a JSON object."
    );
  }

  if (typeof payload.noChangesNeeded !== "boolean") {
    throw new RedraftError(
      ERROR_CODES.INVALID_COACH_JSON,
      'Coach response is missing a boolean "noChangesNeeded".'
    );
  }

  if (payload.hints !== undefined && !Array.isArray(payload.hints)) {
    throw new RedraftError(
      ERROR_CODES.INVALID_COACH_JSON,
      'Coach response: "hints" must be an array.'
    );
  }

  const hints = payload.hints ?? [];

  for (const item of hints) {
    if (!isPlainObject(item)) {
      throw new RedraftError(
        ERROR_CODES.INVALID_COACH_JSON,
        "Coach response: every hint must be an object."
      );
    }
    requireStringFields(item, ["span", "suggestion", "why", "category"], "a hint");
    if (!HINT_CATEGORIES.includes(item.category)) {
      throw new RedraftError(
        ERROR_CODES.INVALID_COACH_JSON,
        `Coach response: a hint has an unknown category "${item.category}". ` +
          `Known: ${HINT_CATEGORIES.join(", ")}.`
      );
    }
  }

  // Claiming there is nothing to change while still handing over hints is a
  // contract violation worth surfacing — the two halves disagree and we cannot
  // tell which one the model meant.
  if (payload.noChangesNeeded && hints.length > 0) {
    throw new RedraftError(
      ERROR_CODES.INVALID_COACH_JSON,
      'Coach response set "noChangesNeeded": true but still returned hints.'
    );
  }

  return {
    // The reverse contradiction — "changes needed" with nothing to show — is
    // unambiguous, so we take the list as the truth rather than erroring.
    noChangesNeeded: hints.length === 0,
    hints,
  };
}

/**
 * Parse an Anthropic Messages API response.
 *
 * @param {{ok: boolean, status: number, bodyText: string}} response
 * @param {{promptVersion: string, model: string, style: string, mode: string}} meta
 * @throws {RedraftError}
 */
export function parseResponse(response, meta) {
  const { ok, status, bodyText } = response;

  if (!ok) {
    throw new RedraftError(
      ERROR_CODES.API_ERROR,
      `Anthropic API returned ${status}: ${extractApiErrorMessage(bodyText)}`,
      { status }
    );
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new RedraftError(
      ERROR_CODES.MALFORMED_JSON,
      "Anthropic API returned a body that was not valid JSON."
    );
  }

  const text = data?.content?.[0]?.text;
  if (typeof text !== "string" || text.trim() === "") {
    throw new RedraftError(
      ERROR_CODES.EMPTY_CONTENT,
      "Anthropic API returned no text content."
    );
  }

  // The model and prompt version travel with every result, so a batch of good
  // output always says what produced it.
  const base = {
    promptVersion: meta.promptVersion,
    model: meta.model,
    style: meta.style,
    mode: meta.mode,
    usage: data.usage ?? null,
  };

  if (meta.mode === "rewrite") {
    return { ...base, text: text.trim() };
  }

  let payload;
  try {
    payload = JSON.parse(stripCodeFence(text));
  } catch {
    throw new RedraftError(
      ERROR_CODES.INVALID_COACH_JSON,
      "Coach response was not valid JSON."
    );
  }

  return { ...base, ...validateCoachPayload(payload) };
}
