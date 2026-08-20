// Feedback event capture. The event shape and its validation are pure; the
// storage layer is injected, so swapping chrome.storage.local for Supabase
// later touches exactly one adapter and no call site.

export const OUTCOMES = {
  APPLIED: "applied",
  DISMISSED: "dismissed",
  APPLIED_THEN_EDITED: "applied_then_edited",
  RETRIED: "retried",
  IGNORED: "ignored",
};

export const OUTCOME_VALUES = Object.values(OUTCOMES);

export const RETRY_REASONS = [
  "wrong_style",
  "changed_meaning",
  "too_aggressive",
  "too_timid",
];

/**
 * Build one feedback event. Pure — the caller supplies the clock.
 *
 * @param {object} input
 * @param {string} input.original       the writer's text as captured
 * @param {string} input.mode           coach | rewrite
 * @param {string} input.style          plain | classic | warm
 * @param {string} input.model          the model id that produced the suggestion
 * @param {string} input.promptVersion
 * @param {*}      input.suggestion     the single suggestion acted on
 * @param {string} input.outcome        one of OUTCOME_VALUES
 * @param {string} [input.reason]       one of RETRY_REASONS, on retry only
 * @param {string} [input.timestamp]    ISO 8601; defaults to now
 */
export function buildEvent({
  original,
  mode,
  style,
  model,
  promptVersion,
  suggestion,
  outcome,
  reason = null,
  timestamp = new Date().toISOString(),
}) {
  if (typeof original !== "string") {
    throw new Error("Redraft event: original text is required.");
  }
  for (const [name, value] of Object.entries({ mode, style, model, promptVersion })) {
    if (typeof value !== "string" || value === "") {
      throw new Error(`Redraft event: "${name}" is required.`);
    }
  }
  if (!OUTCOME_VALUES.includes(outcome)) {
    throw new Error(
      `Redraft event: unknown outcome "${outcome}". Known: ${OUTCOME_VALUES.join(", ")}.`
    );
  }
  if (reason !== null && !RETRY_REASONS.includes(reason)) {
    throw new Error(
      `Redraft event: unknown reason "${reason}". Known: ${RETRY_REASONS.join(", ")}.`
    );
  }

  return {
    original,
    mode,
    style,
    model,
    prompt_version: promptVersion,
    suggestion: suggestion ?? null,
    outcome,
    reason,
    timestamp,
  };
}

/**
 * The single write path for feedback events. Everything that captures feedback
 * goes through here; the store is the only thing that changes when the backing
 * store does.
 *
 * @param {object} input             as for buildEvent
 * @param {{append: (event: object) => Promise<void>}} store
 */
export async function recordEvent(input, store) {
  if (!store || typeof store.append !== "function") {
    throw new Error("Redraft event: a store with an append() is required.");
  }
  const event = buildEvent(input);
  await store.append(event);
  return event;
}
