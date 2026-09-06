// Locating a model's quoted excerpt inside the writer's live text.
//
// Models normalise as they quote: straight quotes come back curly, "--" comes
// back as an em dash, runs of whitespace collapse, a line break becomes a
// space. An exact indexOf against the excerpt therefore fails often, and every
// one of those failures is an Apply button that does nothing. This module makes
// the match tolerant of the ways a quote drifts, without letting it replace
// text the model was not talking about.
//
// Pure — no chrome.*, no DOM, no I/O.
//
// LOADED TWO WAYS ON PURPOSE. content.js needs findExcerpt() synchronously:
// document.execCommand("insertText") has to run inside the click's user
// gesture, so a round trip through the service worker is not available. This
// file therefore uses no module syntax and hangs its surface on globalThis,
// which makes it valid both as a classic content script (listed ahead of
// content.js in the manifest) and as a file Node can import in tests.
//
// The character tables are written as \u escapes on purpose: a reader can tell
// a left curly quote from a right one, which is not true of the literals.

(() => {
  // --- normalisation -------------------------------------------------------

  // Every character below is one a model may substitute for the writer's.
  const QUOTES = {
    "\u2018": "'", // left single
    "\u2019": "'", // right single, and the curly apostrophe
    "\u201A": "'", // low-9
    "\u201B": "'", // reversed-9
    "\u2032": "'", // prime
    "\u201C": '"', // left double
    "\u201D": '"', // right double
    "\u201E": '"', // low-9 double
    "\u201F": '"', // reversed-9 double
    "\u2033": '"', // double prime
    "\u00AB": '"', // left guillemet
    "\u00BB": '"', // right guillemet
  };

  // Hyphen-likes and dashes. A run of any of them collapses to a single "-", so
  // the writer's "--" and the model's em dash land on the same normal form.
  const DASH = /[-\u2010-\u2015\u2212]/;

  // Whitespace, including the non-breaking and thin spaces that contenteditable
  // fields are full of. A run collapses to one space.
  const SPACE = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

  // Invisible characters that carry no meaning and should not block a match.
  const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/;

  const ELLIPSIS = "\u2026";

  /**
   * Fold the ways a quote drifts into one comparable form, keeping a map back
   * to the source so a match can be replaced in the original text.
   *
   * @param {string} text
   * @returns {{text: string, starts: number[], ends: number[]}}
   *   `starts[i]` and `ends[i]` are the half-open span of source text that
   *   produced normalised character `i`.
   */
  function normalise(text) {
    let out = "";
    const starts = [];
    const ends = [];

    const emit = (chars, from, to) => {
      for (const ch of chars) {
        out += ch;
        starts.push(from);
        ends.push(to);
      }
    };

    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      if (INVISIBLE.test(ch)) {
        i += 1;
        continue;
      }

      if (SPACE.test(ch)) {
        const from = i;
        while (i < text.length && (SPACE.test(text[i]) || INVISIBLE.test(text[i]))) {
          i += 1;
        }
        emit(" ", from, i);
        continue;
      }

      if (DASH.test(ch)) {
        const from = i;
        while (i < text.length && DASH.test(text[i])) i += 1;
        emit("-", from, i);
        continue;
      }

      if (ch === ELLIPSIS) {
        // The ellipsis character and three dots are the same pause. Emitting
        // three entries keeps the map at one entry per normalised character.
        emit("...", i, i + 1);
        i += 1;
        continue;
      }

      if (QUOTES[ch]) {
        emit(QUOTES[ch], i, i + 1);
        i += 1;
        continue;
      }

      emit(ch, i, i + 1);
      i += 1;
    }

    return { text: out, starts, ends };
  }

  /** Trim the whitespace a model tends to leave on the ends of a quote. */
  function trimEdges(text) {
    return text.replace(/^[\s\u00A0\u200B\uFEFF]+|[\s\u00A0\u200B\uFEFF]+$/g, "");
  }

  // --- similarity ----------------------------------------------------------

  function bigrams(text) {
    const counts = new Map();
    for (let i = 0; i < text.length - 1; i += 1) {
      const pair = text.slice(i, i + 2);
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
    return counts;
  }

  function sizeOf(counts) {
    let total = 0;
    for (const count of counts.values()) total += count;
    return total;
  }

  /** Sorensen-Dice over character bigrams. Cheap, and used only to rank. */
  function dice(a, aSize, b) {
    let shared = 0;
    let bSize = 0;
    for (const [pair, count] of b) {
      bSize += count;
      const mine = a.get(pair);
      if (mine) shared += Math.min(mine, count);
    }
    if (aSize + bSize === 0) return 0;
    return (2 * shared) / (aSize + bSize);
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let previous = new Array(b.length + 1);
    let current = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j += 1) previous[j] = j;

    for (let i = 1; i <= a.length; i += 1) {
      current[0] = i;
      const ca = a[i - 1];
      for (let j = 1; j <= b.length; j += 1) {
        const cost = ca === b[j - 1] ? 0 : 1;
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + cost
        );
      }
      const swap = previous;
      previous = current;
      current = swap;
    }
    return previous[b.length];
  }

  /** 1 for identical, 0 for nothing in common. */
  function similarity(a, b) {
    const longest = Math.max(a.length, b.length);
    if (longest === 0) return 1;
    return 1 - levenshtein(a, b) / longest;
  }

  // --- matching ------------------------------------------------------------

  /** Word spans of a normalised string, as [start, end) pairs. */
  function words(text) {
    const spans = [];
    const pattern = /\S+/g;
    let hit;
    while ((hit = pattern.exec(text)) !== null) {
      spans.push([hit.index, hit.index + hit[0].length]);
    }
    return spans;
  }

  /**
   * The closest window of `haystack` to `needle`, searched at word boundaries.
   * Returns normalised offsets, or null when nothing scores above `minScore`.
   */
  function bestWindow(haystack, needle, minScore) {
    const spans = words(haystack);
    if (!spans.length) return null;

    const target = words(needle).length || 1;
    const needleGrams = bigrams(needle);
    const needleSize = sizeOf(needleGrams);

    // A window may be a couple of words shorter or longer than the excerpt: a
    // model that drops "just" or adds "the" should still be found.
    const lengths = [];
    for (let n = Math.max(1, target - 2); n <= target + 2; n += 1) lengths.push(n);

    const ranked = [];
    for (let s = 0; s < spans.length; s += 1) {
      for (const n of lengths) {
        const last = s + n - 1;
        if (last >= spans.length) break;
        const start = spans[s][0];
        const end = spans[last][1];
        const rough = dice(needleGrams, needleSize, bigrams(haystack.slice(start, end)));
        if (rough > 0.4) ranked.push({ start, end, rough });
      }
    }

    if (!ranked.length) return null;

    // Dice ranks; edit distance decides. Confirming only the strongest handful
    // keeps the expensive comparison off the great majority of windows.
    ranked.sort((a, b) => b.rough - a.rough);
    let best = null;
    for (const candidate of ranked.slice(0, 8)) {
      const score = similarity(
        haystack.slice(candidate.start, candidate.end).toLowerCase(),
        needle.toLowerCase()
      );
      if (!best || score > best.score) best = { start: candidate.start, end: candidate.end, score };
    }

    if (!best) return null;
    const refined = refine(haystack, needle, best);
    return refined.score >= minScore ? refined : null;
  }

  const WORD_CHAR = /[\p{L}\p{N}]/u;

  function isPunctuationOnly(text, from, to) {
    for (let i = from; i < to; i += 1) {
      if (WORD_CHAR.test(text[i])) return false;
    }
    return true;
  }

  /**
   * Nudge a window's edges over the punctuation at either end.
   *
   * Windows are cut at whitespace, so a match against "more detail" lands on
   * the token "detail." and would swallow the full stop — the writer applies a
   * fix and loses the end of their sentence. Only offsets that add or remove
   * punctuation are considered: an edge that could land mid-word would leave
   * "deta" in the writer's text, which is worse than the full stop.
   */
  function refine(haystack, needle, window) {
    const lower = needle.toLowerCase();

    const edges = (anchor, reach) => {
      const options = [];
      for (let at = anchor - reach; at <= anchor + reach; at += 1) {
        if (at < 0 || at > haystack.length) continue;
        const from = Math.min(at, anchor);
        const to = Math.max(at, anchor);
        if (isPunctuationOnly(haystack, from, to)) options.push(at);
      }
      return options;
    };

    let best = window;
    for (const start of edges(window.start, 2)) {
      for (const end of edges(window.end, 3)) {
        if (end - start < 1) continue;
        const score = similarity(haystack.slice(start, end).toLowerCase(), lower);
        // On a tie the tighter span wins: it touches less of the writer's text.
        const tighter = end - start < best.end - best.start;
        if (score > best.score || (score === best.score && tighter)) {
          best = { start, end, score };
        }
      }
    }
    return best;
  }

  /** Map a span of normalised offsets back onto the source text. */
  function toSource(map, start, end) {
    if (end <= start) return null;
    return { start: map.starts[start], end: map.ends[end - 1] };
  }

  /** Below this, a fuzzy match is likelier to mangle the text than to fix it. */
  const DEFAULT_MIN_SCORE = 0.8;

  /**
   * Find `needle` in `haystack`, tolerating the ways a model requotes text.
   *
   * @param {string} haystack  the text as it stands in the field right now
   * @param {string} needle    the excerpt the model quoted back
   * @param {{minScore?: number}} [options]
   * @returns {{start: number, end: number, score: number, method: string} | null}
   *   offsets into `haystack`, or null when no match is confident enough.
   */
  function findExcerpt(haystack, needle, { minScore = DEFAULT_MIN_SCORE } = {}) {
    if (typeof haystack !== "string" || typeof needle !== "string") return null;
    const wanted = trimEdges(needle);
    if (wanted === "" || haystack === "") return null;

    // 1. The excerpt came back untouched.
    const exact = haystack.indexOf(wanted);
    if (exact !== -1) {
      return { start: exact, end: exact + wanted.length, score: 1, method: "exact" };
    }

    const hay = normalise(haystack);
    const normalisedNeedle = trimEdges(normalise(wanted).text);
    if (normalisedNeedle === "") return null;

    // 2. Only the punctuation or the spacing moved.
    const folded = hay.text.indexOf(normalisedNeedle);
    if (folded !== -1) {
      const span = toSource(hay, folded, folded + normalisedNeedle.length);
      if (span) return { ...span, score: 1, method: "normalised" };
    }

    // 3. The case moved too — at the start of a sentence, usually.
    const insensitive = hay.text
      .toLowerCase()
      .indexOf(normalisedNeedle.toLowerCase());
    if (insensitive !== -1) {
      const span = toSource(hay, insensitive, insensitive + normalisedNeedle.length);
      if (span) return { ...span, score: 1, method: "case-insensitive" };
    }

    // 4. A word drifted. Take the closest window, but only if it is close.
    const window = bestWindow(hay.text, normalisedNeedle, minScore);
    if (!window) return null;
    const span = toSource(hay, window.start, window.end);
    if (!span) return null;
    return { ...span, score: window.score, method: "similarity" };
  }

  /**
   * Stable non-cryptographic hash (FNV-1a), used to key the analysis cache so
   * the same draft is never sent twice.
   */
  function hashText(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
  }

  globalThis.RedraftMatch = {
    DEFAULT_MIN_SCORE,
    findExcerpt,
    hashText,
    normalise,
    similarity,
    trimEdges,
  };
})();
