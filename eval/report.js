// The shape a later dashboard can read without knowing how the run was produced.
// Pure. The runner fills it in and writes the JSON.

import { judgeMean } from "./rubric.js";

export const REPORT_SCHEMA = "redraft.evalReport.v1";

const SPLITS = ["dev", "heldOut"];

function roundRate(value) {
  if (value === null || value === undefined) return null;
  return Math.round(value * 1000) / 1000;
}

function splitSummary(rows) {
  const scored = rows.filter((row) => row.status === "scored");
  const passed = scored.filter((row) => row.hard?.pass).length;
  const judged = scored.map((row) => judgeMean(row.judge)).filter((value) => value !== null);
  const judgeTotal = judged.reduce((sum, value) => sum + value, 0);
  return {
    cases: rows.length,
    scored: scored.length,
    notRun: rows.filter((row) => row.status === "not-run").length,
    errors: rows.filter((row) => row.status === "error").length,
    hardPass: passed,
    hardFail: scored.length - passed,
    passRate: scored.length ? roundRate(passed / scored.length) : null,
    judgeMean: judged.length ? Math.round((judgeTotal / judged.length) * 100) / 100 : null,
  };
}

function delta(next, previous) {
  if (typeof next !== "number" || typeof previous !== "number") return null;
  return Math.round((next - previous) * 1000) / 1000;
}

/**
 * @param {object} input
 * @param {string} input.promptVersion
 * @param {string} input.model
 * @param {"fixture"|"live"} input.source
 * @param {string} input.ranAt
 * @param {object[]} input.cases
 * @param {object|null} input.previous  an earlier report, if there is one
 * @param {string} input.changelogNote
 * @param {{status: string, reason?: string}} input.judge
 */
export function buildReport({
  promptVersion,
  model,
  source,
  ranAt,
  cases,
  previous = null,
  changelogNote,
  judge,
}) {
  const bySplit = {};
  for (const split of SPLITS) {
    bySplit[split] = splitSummary(cases.filter((row) => row.split === split));
  }

  const scored = cases.filter((row) => row.status === "scored");
  const byCategory = {};
  for (const row of scored) {
    for (const hint of row.hints ?? []) {
      const category = hint.category ?? "unknown";
      byCategory[category] = (byCategory[category] ?? 0) + 1;
    }
  }

  const overall = splitSummary(cases);

  const regression = previous
    ? {
        baselineRanAt: previous.ranAt ?? null,
        baselinePromptVersion: previous.promptVersion ?? null,
        hardPassRateDelta: {
          dev: delta(bySplit.dev.passRate, previous.summary?.bySplit?.dev?.passRate),
          heldOut: delta(bySplit.heldOut.passRate, previous.summary?.bySplit?.heldOut?.passRate),
        },
        judgeMeanDelta: {
          dev: delta(bySplit.dev.judgeMean, previous.summary?.bySplit?.dev?.judgeMean),
          heldOut: delta(
            bySplit.heldOut.judgeMean,
            previous.summary?.bySplit?.heldOut?.judgeMean
          ),
        },
      }
    : {
        baselineRanAt: null,
        baselinePromptVersion: null,
        hardPassRateDelta: { dev: null, heldOut: null },
        judgeMeanDelta: { dev: null, heldOut: null },
        note: "No earlier report. This run is the baseline.",
      };

  return {
    schema: REPORT_SCHEMA,
    promptVersion,
    model,
    mode: "coach",
    source,
    ranAt,
    disclaimer:
      source === "fixture"
        ? "Pipeline check on hand-written fixtures. Not a model score."
        : "Live model run. Held-out cases were not used to edit the prompt.",
    summary: {
      cases: cases.length,
      scored: overall.scored,
      notRun: overall.notRun,
      errors: overall.errors,
      hardPass: overall.hardPass,
      hardFail: overall.hardFail,
      passRate: overall.passRate,
      bySplit,
      byCategory,
      judge: {
        status: judge?.status ?? "skipped",
        reason: judge?.reason ?? null,
        rubricVersion: judge?.rubricVersion ?? null,
        mean: overall.judgeMean ?? null,
        bySplit: {
          dev: bySplit.dev.judgeMean,
          heldOut: bySplit.heldOut.judgeMean,
        },
      },
      humanPreference: {
        status: "not-joined",
        accepted: null,
        dismissed: null,
        note: "Applied and dismissed hints are stored on the extension, with the prompt version. Joining them to this report is the online half. A seed run leaves the counts empty on purpose.",
      },
    },
    regression,
    changelog: {
      promptVersion,
      note: changelogNote,
      hardPassRate: {
        dev: bySplit.dev.passRate,
        heldOut: bySplit.heldOut.passRate,
      },
      judgeMean: {
        dev: bySplit.dev.judgeMean,
        heldOut: bySplit.heldOut.judgeMean,
      },
      comparedWith: previous?.promptVersion ?? null,
    },
    cases: cases.map((row) => ({
      id: row.id,
      split: row.split,
      style: row.style,
      source: row.source,
      note: row.note ?? null,
      status: row.status,
      hints: row.hints ?? [],
      rejected: row.rejected ?? [],
      hard: row.hard,
      judge: row.judge ?? null,
    })),
  };
}

/** A few lines a person can paste into a changelog. */
export function changelogText(report) {
  const { changelog, source, summary } = report;
  const judge =
    summary.judge.status === "scored"
      ? `judge dev ${changelog.judgeMean.dev ?? "—"}, held-out ${changelog.judgeMean.heldOut ?? "—"}`
      : "judge skipped";
  return [
    `${changelog.promptVersion} (${source})`,
    changelog.note,
    `hard checks: dev ${formatRate(changelog.hardPassRate.dev)}, held-out ${formatRate(changelog.hardPassRate.heldOut)}`,
    judge,
    changelog.comparedWith
      ? `compared with ${changelog.comparedWith}`
      : "no earlier report",
    summary.notRun ? `${summary.notRun} case(s) not run` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatRate(rate) {
  if (typeof rate !== "number") return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}
