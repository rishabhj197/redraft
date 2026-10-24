// Hard checks for one golden-set case. No model call, no I/O.
//
// These are the checks a dashboard can show as pass or fail without asking a
// second model to have an opinion: the span is really in the draft, the
// suggestion is a phrase rather than a rewrite, names that must survive do,
// and an empty answer is only a pass when the case allows it.

import { hintProblems } from "../lib/hints.js";

/**
 * @param {object} entry  one golden-set case
 * @param {{noChangesNeeded?: boolean, hints?: object[]}} result
 * @returns {{pass: boolean, checks: {name: string, pass: boolean, detail: string|null}[]}}
 */
export function checkCase(entry, result) {
  const checks = [];
  const add = (name, pass, detail = null) => {
    checks.push({ name, pass: Boolean(pass), detail });
  };

  const hints = Array.isArray(result?.hints) ? result.hints : null;
  add(
    "schema",
    hints !== null && typeof result?.noChangesNeeded === "boolean",
    hints === null ? "hints was not a list" : null
  );

  if (hints === null) return { pass: false, checks };

  if (hints.length === 0) {
    const allowed = Boolean(entry.expect?.mayBeEmpty);
    add(
      "empty-answer",
      allowed,
      allowed ? "An empty answer is a pass on this case." : "This case expected a hint."
    );
    return { pass: checks.every((check) => check.pass), checks };
  }

  if (result.noChangesNeeded) {
    add("empty-flag", false, "noChangesNeeded was true alongside hints.");
  }

  hints.forEach((hint, index) => {
    const problems = hintProblems(entry.source, hint);
    add(
      `hint-${index}`,
      problems.length === 0,
      problems.length ? problems.join(", ") : hint.span ?? null
    );
  });

  const wanted = entry.expect?.wantedCategories ?? [];
  if (wanted.length) {
    const hit = hints.some((hint) => wanted.includes(hint.category));
    add("category", hit, hit ? null : `wanted one of ${wanted.join(", ")}`);
  }

  for (const name of entry.expect?.preserve ?? []) {
    const dropped = hints.some(
      (hint) =>
        typeof hint.span === "string" &&
        hint.span.includes(name) &&
        (typeof hint.suggestion !== "string" || !hint.suggestion.includes(name))
    );
    add(`preserve-${name}`, !dropped, dropped ? `A hint drops ${name}.` : null);
  }

  return { pass: checks.every((check) => check.pass), checks };
}
