// Guards on a Coach hint, once the JSON contract has already been checked.
//
// The parser accepts any well-shaped hint. This module decides whether that
// hint is safe to show: the span has to be in the writer's text, the
// suggestion has to be a word or a short phrase, and it must not be a
// rewritten sentence, a banned flourish, or a lazy intensifier.
//
// Pure — no chrome.*, no fetch. findExcerpt comes from lib/match.js, the same
// matcher the Apply button uses, so a hint we refuse to show is a hint we
// would not have been able to place honestly.

import "./match.js";
import { HINT_CATEGORIES } from "./parse.js";

const { findExcerpt } = globalThis.RedraftMatch;

export { HINT_CATEGORIES };

/** Patterns that must not appear in a suggestion. The id is what evals report. */
export const BANNED_PATTERNS = [
  {
    id: "intensifier",
    pattern: /\b(very|really|quite|extremely|incredibly)\b/i,
  },
  {
    id: "ai-ism",
    pattern:
      /\b(delve|delves|tapestry|vibrant|leverage|leveraging|underscore|underscores|pivotal|streamline|robust)\b/i,
  },
  {
    id: "throat-clear",
    pattern: /\bit's important to note\b|\bin today's\b|\bnot only\b[^.]{0,40}\bbut also\b/i,
  },
];

const MAX_SPAN_WORDS = 10;
const MAX_SUGGESTION_WORDS = 14;
const MAX_WHY_CHARS = 280;

export function wordCount(text) {
  if (typeof text !== "string") return 0;
  return text.trim().match(/\S+/g)?.length ?? 0;
}

/**
 * Reasons `hint` must not be shown against `source`. An empty list means show it.
 *
 * @param {string} source
 * @param {{span?: string, suggestion?: string, why?: string, category?: string}} hint
 * @returns {string[]}
 */
export function hintProblems(source, hint) {
  const problems = [];
  if (!hint || typeof hint !== "object") return ["not-a-hint"];

  const span = typeof hint.span === "string" ? hint.span.trim() : "";
  const suggestion = typeof hint.suggestion === "string" ? hint.suggestion.trim() : "";
  const why = typeof hint.why === "string" ? hint.why.trim() : "";

  if (!HINT_CATEGORIES.includes(hint.category)) problems.push("bad-category");
  if (!span) problems.push("empty-span");
  if (!suggestion) problems.push("empty-suggestion");
  if (!why) problems.push("empty-why");
  if (span && suggestion && span.toLowerCase() === suggestion.toLowerCase()) {
    problems.push("no-change");
  }
  if (suggestion.includes("\n")) problems.push("suggestion-multiline");
  if (wordCount(span) > MAX_SPAN_WORDS) problems.push("span-too-long");
  if (wordCount(suggestion) > MAX_SUGGESTION_WORDS) problems.push("suggestion-too-long");
  if (why.length > MAX_WHY_CHARS) problems.push("why-too-long");

  if (typeof source === "string" && span) {
    const found = findExcerpt(source, span);
    // A similarity hit can land on the wrong words. Exact, normalised, and
    // case-insensitive matches are the ones that are really in the source.
    if (!found || found.method === "similarity") problems.push("span-missing");
    else if (coversWholeDraft(source, found)) problems.push("full-rewrite");
  }

  if (readsAsFullRewrite(source, span, suggestion)) problems.push("full-rewrite");

  for (const banned of BANNED_PATTERNS) {
    if (suggestion && banned.pattern.test(suggestion)) {
      problems.push(`banned:${banned.id}`);
      break;
    }
  }

  return problems;
}

/** The span the matcher found is the entire draft, so applying it would replace everything. */
function coversWholeDraft(source, found) {
  const trimmed = source.trim();
  if (wordCount(trimmed) <= 4) return false;
  const region = source.slice(found.start, found.end).trim();
  return region === trimmed;
}

/**
 * A suggestion that is most of the draft, and much longer than the span it
 * claims to replace, is a rewrite wearing a hint's clothes.
 */
function readsAsFullRewrite(source, span, suggestion) {
  const sourceWords = wordCount(source);
  const spanWords = wordCount(span);
  const suggestionWords = wordCount(suggestion);
  if (!suggestion || sourceWords <= 8) return false;
  return (
    suggestionWords >= Math.max(8, Math.ceil(sourceWords * 0.8)) &&
    suggestionWords > spanWords + 3
  );
}

/**
 * Drop hints that fail the guards. If none survive, the honest answer is that
 * nothing should change — the rejected list says why, for the log and the eval.
 *
 * @param {string} source
 * @param {object} result  a parsed coach or rewrite result
 */
export function guardCoachResult(source, result) {
  if (!result || result.mode !== "coach") return result;

  const hints = [];
  const rejected = [];
  for (const hint of result.hints ?? []) {
    const problems = hintProblems(source, hint);
    if (problems.length) rejected.push({ hint, problems });
    else hints.push(hint);
  }

  return {
    ...result,
    hints,
    noChangesNeeded: hints.length === 0,
    rejected,
  };
}
