// When a draft is finished enough to be worth reading.
//
// Pure — no chrome.*, no DOM, no I/O.
//
// LOADED TWO WAYS ON PURPOSE, same as lib/match.js. content.js has to decide
// synchronously, inside an input handler, whether the writer has finished a
// thought. This file uses no module syntax and hangs its surface on
// globalThis, so it loads as a classic content script and as a Node import.
//
// The old check lived inline in content.js and only looked at the very end of
// the field. A signature, a following block, or a zero-width character after
// the punctuation made "?", "!" and Enter look unfinished. The predicate here
// is the whole of that decision; the content script decides which slice of
// the field to hand it (the text up to the caret).

(() => {
  // Invisible characters editors drop into a field. They carry no meaning and
  // must not hide a question mark or a line break sitting just before them.
  const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

  /**
   * Has the writer finished a thought in `text`?
   *
   * True when the slice ends on sentence punctuation (`.`, `?`, `!`, an
   * ellipsis, then optional closing quotes) or on a line break — Enter, in a
   * field that represents it as a newline. False while they are still in the
   * middle of the line.
   *
   * @param {string} text  the draft up to the caret, not the whole field
   * @returns {boolean}
   */
  function isFinishedThought(text) {
    if (typeof text !== "string") return false;
    const clean = text.replace(INVISIBLE, "");
    if (!clean.trim()) return false;

    // Enter. A line break after a real word means they left the paragraph,
    // whether or not they typed a full stop.
    if (/[^\s]\s*\n\s*$/.test(clean)) return true;

    const end = clean.replace(/\s+$/u, "");
    if (!end) return false;
    return /[.!?…]["'’”)\]]*$/.test(end);
  }

  globalThis.RedraftTrigger = { isFinishedThought };
})();
