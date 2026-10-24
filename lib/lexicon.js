// The writer's lexicon: hints they chose to apply.
//
// Pure — no chrome.*. The options page renders whatever this returns, and the
// service worker is the only thing that writes the stored list. A rewrite of
// a whole draft is not an entry. The lexicon is words, not finished paragraphs.

export const LEXICON_LIMIT = 80;

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * One lexicon row from a suggestion the writer applied, or null when the
 * suggestion is not a hint (a whole-draft rewrite, for example).
 *
 * @param {object} suggestion
 * @param {{style?: string|null, timestamp: string}} meta
 */
export function entryFromHint(suggestion, { style = null, timestamp }) {
  if (!suggestion || typeof suggestion !== "object") return null;

  const from = text(suggestion.span ?? suggestion.from);
  const to = text(suggestion.suggestion ?? suggestion.to);
  if (!from || !to) return null;
  if (typeof timestamp !== "string" || timestamp === "") return null;

  return {
    from,
    to,
    why: text(suggestion.why),
    category: text(suggestion.category) || "vocabulary",
    style: text(style) || null,
    timestamp,
  };
}

/**
 * Newest first. Applying the same pair again moves it to the top and refreshes
 * the reason, rather than listing it twice. The list is capped.
 *
 * @param {object[]} entries
 * @param {object} entry
 * @param {number} [limit]
 */
export function addToLexicon(entries, entry, limit = LEXICON_LIMIT) {
  const list = Array.isArray(entries) ? entries : [];
  const next = [
    entry,
    ...list.filter((item) => !(item && item.from === entry.from && item.to === entry.to)),
  ];
  return next.slice(0, limit);
}
