// Turn golden-set cases plus model (or fixture) outputs into scored rows.
// Pure. The runner decides where the outputs came from.

import { checkCase } from "./checks.js";

/** Notes a changelog can print for each prompt the harness knows. */
export const PROMPT_CHANGELOG = {
  v3: "Coach returns discrete hints: a span, a suggestion, a reason, and a category. Full rewrites, missing spans, and banned flourishes fail the hard checks. Benaud, Tharoor, and Thapar are principles in the prompt, not voices to copy. This is the first prompt the harness scores. v1 and v2 were not.",
};

export function changelogNote(promptVersion) {
  return (
    PROMPT_CHANGELOG[promptVersion] ??
    `No changelog note written for ${promptVersion}. Add one in eval/evaluate.js before trusting a comparison.`
  );
}

/** The hand-written answer for a case, shaped like a coach result. */
export function fixtureOutput(entry) {
  return {
    noChangesNeeded: Boolean(entry.fixture?.noChangesNeeded),
    hints: entry.fixture?.hints ?? [],
  };
}

/**
 * @param {object[]} cases
 * @param {Record<string, object|undefined>} outputs  id -> coach result, or {error}
 */
export function scoreCases(cases, outputs) {
  return cases.map((entry) => {
    const output = outputs[entry.id];
    const base = {
      id: entry.id,
      split: entry.split,
      style: entry.style,
      source: entry.source,
      note: entry.expect?.note ?? null,
    };

    if (!output) {
      return {
        ...base,
        status: "not-run",
        hints: [],
        rejected: [],
        hard: {
          pass: false,
          checks: [
            {
              name: "not-run",
              pass: false,
              detail: "The run stopped before this case.",
            },
          ],
        },
        judge: null,
      };
    }

    if (output.error) {
      return {
        ...base,
        status: "error",
        hints: [],
        rejected: [],
        hard: {
          pass: false,
          checks: [{ name: "model-error", pass: false, detail: String(output.error) }],
        },
        judge: null,
      };
    }

    const hints = output.hints ?? [];
    return {
      ...base,
      status: "scored",
      hints,
      rejected: output.rejected ?? [],
      hard: checkCase(entry, { noChangesNeeded: Boolean(output.noChangesNeeded), hints }),
      judge: output.judge ?? null,
    };
  });
}
