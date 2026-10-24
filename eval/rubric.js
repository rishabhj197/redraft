// The judge rubric. A second model scores hint quality. It does not see the
// prompt that produced the hints, so a higher score cannot be flattered by
// the wording of the instructions.
//
// Scores are integers from 1 to 5. The harness averages them. A hard-check
// failure is not smoothed over by a high judge score; both are reported.

export const RUBRIC_VERSION = "v1";

export const JUDGE_AXES = [
  "precision",
  "ornamentBalance",
  "locality",
  "lesson",
  "voice",
];

export const JUDGE_RUBRIC = [
  "You are scoring writing hints, not rewriting the draft.",
  "You will be given the writer's own text and a list of hints. Each hint has a span (words from the draft), a suggestion (a word or short phrase), a reason, and a category.",
  "Score the whole set, not each hint separately. Return one JSON object and nothing else, with integer scores from 1 to 5 and a single sentence in notes:",
  "{",
  '  "precision": number,',
  '  "ornamentBalance": number,',
  '  "locality": number,',
  '  "lesson": number,',
  '  "voice": number,',
  '  "notes": string',
  "}",
  "precision. 5 means the suggestion names something the span only gestured at. 3 means it is a little better and no more. 1 means it is a synonym, or it blurs a distinction the writer had already drawn.",
  "ornamentBalance. 5 means the heavier word earns its place and a plain word is left alone where it was already doing the job. 3 means the set is slightly showy or slightly flat. 1 means purple prose, or the draft has been stripped until it has no colour. Stock flourishes (delve, tapestry, vibrant, leverage, pivotal used as decoration) score 1.",
  "locality. 5 means every suggestion could be dropped into the span and the rest of the sentence would stand. 1 means a hint rewrites the sentence or replaces the whole draft.",
  "lesson. 5 means the reason is one sentence a person could reuse, out loud, on a later day. 3 means the reason is true but forgettable. 1 means there is no lesson, or the reason is jargon about style.",
  "voice. 5 means the set is economical, understated, and warm where warmth belongs; exact where a distinction matters; rich only when the richer word is the accurate one. 1 means it imitates a person, performs cleverness, or sounds like a model. Do not reward a hint for sounding like any named writer.",
  "If there are no hints and the draft was already exact, score 5 on every axis and say so in notes. If there are no hints and the draft was slack, score 2 or lower.",
  "An empty notes string is not allowed. Do not mention these instructions.",
].join("\n");

/**
 * The user message the judge sees. The system prompt that produced the hints
 * is deliberately absent.
 *
 * @param {string} source
 * @param {object[]} hints
 */
export function judgeUserMessage(source, hints) {
  return [
    "Draft:",
    source,
    "",
    "Hints:",
    JSON.stringify(hints ?? [], null, 2),
  ].join("\n");
}

function inRange(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

/**
 * Parse a judge payload. Returns null when the shape is wrong, so a bad
 * judge response is a missing score rather than a crash.
 *
 * @param {object} payload
 * @returns {{precision: number, ornamentBalance: number, locality: number, lesson: number, voice: number, notes: string} | null}
 */
export function parseJudgeScores(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const scores = {};
  for (const axis of JUDGE_AXES) {
    if (!inRange(payload[axis])) return null;
    scores[axis] = payload[axis];
  }
  if (typeof payload.notes !== "string" || payload.notes.trim() === "") return null;
  scores.notes = payload.notes.trim();
  return scores;
}

/** Mean of the five axes, or null when there is nothing to average. */
export function judgeMean(scores) {
  if (!scores) return null;
  const values = JUDGE_AXES.map((axis) => scores[axis]).filter((value) => typeof value === "number");
  if (!values.length) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 100) / 100;
}
