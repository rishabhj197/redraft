import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { checkCase } from "../eval/checks.js";
import { changelogNote, fixtureOutput, scoreCases } from "../eval/evaluate.js";
import { REPORT_SCHEMA, buildReport, changelogText } from "../eval/report.js";
import {
  JUDGE_AXES,
  judgeMean,
  judgeUserMessage,
  parseJudgeScores,
} from "../eval/rubric.js";
import { PROMPT_VERSION } from "../lib/prompts.js";

const golden = JSON.parse(
  readFileSync(new URL("../eval/golden-set.json", import.meta.url), "utf8")
);

function outputsFromFixtures(cases) {
  return Object.fromEntries(cases.map((entry) => [entry.id, fixtureOutput(entry)]));
}

describe("golden set", () => {
  test("every fixture passes the hard checks, and both splits exist", () => {
    const rows = scoreCases(golden.cases, outputsFromFixtures(golden.cases));
    const failed = rows.filter((row) => !row.hard.pass);
    assert.deepEqual(
      failed.map((row) => ({ id: row.id, checks: row.hard.checks.filter((check) => !check.pass) })),
      []
    );

    const splits = new Set(golden.cases.map((entry) => entry.split));
    assert.deepEqual([...splits].sort(), ["dev", "heldOut"]);
    const heldOut = golden.cases.filter((entry) => entry.split === "heldOut");
    assert.ok(heldOut.length >= 3);
    assert.ok(heldOut.length < golden.cases.filter((entry) => entry.split === "dev").length);
    assert.ok(golden.cases.some((entry) => entry.expect.mayBeEmpty));
    assert.equal(golden.promptVersion, PROMPT_VERSION);
  });

  test("a full rewrite fails, and a missing span fails", () => {
    const entry = golden.cases.find((item) => item.id === "keating-very-tired");
    const rewrite = checkCase(entry, {
      noChangesNeeded: false,
      hints: [
        {
          span: entry.source,
          suggestion: "The flight left me exhausted.",
          why: "A finished line.",
          category: "rhythm",
        },
      ],
    });
    assert.equal(rewrite.pass, false);
    assert.match(rewrite.checks.find((check) => check.name === "hint-0").detail, /full-rewrite/);

    const missing = checkCase(entry, {
      noChangesNeeded: false,
      hints: [
        {
          span: "utterly weary",
          suggestion: "exhausted",
          why: "More exact.",
          category: "vocabulary",
        },
      ],
    });
    assert.equal(missing.pass, false);
    assert.match(missing.checks.find((check) => check.name === "hint-0").detail, /span-missing/);
  });

  test("an empty answer fails when the case expected a hint", () => {
    const entry = golden.cases.find((item) => item.id === "keating-very-tired");
    const result = checkCase(entry, { noChangesNeeded: true, hints: [] });
    assert.equal(result.pass, false);
    assert.equal(result.checks.find((check) => check.name === "empty-answer").pass, false);
  });

  test("dropping a name that had to be kept fails", () => {
    const entry = golden.cases.find((item) => item.id === "names-stay");
    const result = checkCase(entry, {
      noChangesNeeded: false,
      hints: [
        {
          span: "Priya told Amir",
          suggestion: "Someone told someone",
          why: "Looser.",
          category: "precision",
        },
      ],
    });
    assert.equal(result.pass, false);
    assert.equal(result.checks.find((check) => check.name === "preserve-Priya").pass, false);
    assert.equal(result.checks.find((check) => check.name === "preserve-Amir").pass, false);
  });
});

describe("judge rubric", () => {
  test("a complete score parses, and the draft prompt is not in the user message", () => {
    const scores = parseJudgeScores({
      precision: 5,
      ornamentBalance: 4,
      locality: 5,
      lesson: 4,
      voice: 5,
      notes: "The hint is a word a person could reuse.",
    });
    assert.equal(judgeMean(scores), 4.6);
    assert.deepEqual(Object.keys(scores).slice(0, 5), JUDGE_AXES);

    const message = judgeUserMessage("I am very tired.", [
      { span: "very tired", suggestion: "exhausted" },
    ]);
    assert.match(message, /I am very tired/);
    assert.equal(message.includes("Mode — Coach"), false);
  });

  test("a score outside 1 to 5 is rejected", () => {
    assert.equal(
      parseJudgeScores({
        precision: 6,
        ornamentBalance: 4,
        locality: 5,
        lesson: 4,
        voice: 5,
        notes: "Too high.",
      }),
      null
    );
  });
});

describe("dashboard report", () => {
  test("a fixture run is labelled as a fixture run and splits dev from held-out", () => {
    const rows = scoreCases(golden.cases, outputsFromFixtures(golden.cases));
    const report = buildReport({
      promptVersion: PROMPT_VERSION,
      model: "fixture",
      source: "fixture",
      ranAt: "2026-10-24T20:00:00.000Z",
      cases: rows,
      previous: null,
      changelogNote: changelogNote(PROMPT_VERSION),
      judge: { status: "skipped", reason: "not asked", rubricVersion: "v1" },
    });

    assert.equal(report.schema, REPORT_SCHEMA);
    assert.equal(report.source, "fixture");
    assert.match(report.disclaimer, /Not a model score/);
    assert.equal(report.summary.hardFail, 0);
    assert.equal(report.summary.bySplit.dev.passRate, 1);
    assert.equal(report.summary.bySplit.heldOut.passRate, 1);
    assert.equal(report.summary.judge.status, "skipped");
    assert.equal(report.summary.humanPreference.status, "not-joined");
    assert.equal(report.summary.humanPreference.accepted, null);
    assert.equal(report.regression.baselineRanAt, null);
    assert.match(changelogText(report), /v3/);
    assert.match(changelogText(report), /held-out 100%/);
    assert.ok(report.cases.every((row) => row.hard && row.split));
  });

  test("a second run reports the movement against the first", () => {
    const rows = scoreCases(golden.cases, outputsFromFixtures(golden.cases));
    const first = buildReport({
      promptVersion: "v3",
      model: "fixture",
      source: "fixture",
      ranAt: "2026-10-24T20:00:00.000Z",
      cases: rows,
      changelogNote: "first",
      judge: { status: "skipped" },
    });

    const worse = rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            hard: { pass: false, checks: [{ name: "hint-0", pass: false, detail: "span-missing" }] },
          }
        : row
    );
    const second = buildReport({
      promptVersion: "v3",
      model: "fixture",
      source: "fixture",
      ranAt: "2026-10-25T20:00:00.000Z",
      cases: worse,
      previous: first,
      changelogNote: "second",
      judge: { status: "skipped" },
    });

    assert.equal(second.regression.baselinePromptVersion, "v3");
    assert.ok(second.regression.hardPassRateDelta.dev < 0);
    assert.equal(second.regression.hardPassRateDelta.heldOut, 0);
  });

  test("a case the budget guard never reached is not a failed hint", () => {
    const rows = scoreCases(golden.cases, {});
    assert.ok(rows.every((row) => row.status === "not-run"));
    const report = buildReport({
      promptVersion: "v3",
      model: "claude-haiku-4-5-20251001",
      source: "live",
      ranAt: "2026-10-24T20:00:00.000Z",
      cases: rows,
      changelogNote: "stopped",
      judge: { status: "skipped", reason: "budget" },
    });
    assert.equal(report.summary.notRun, golden.cases.length);
    assert.equal(report.summary.hardFail, 0);
    assert.equal(report.summary.passRate, null);
  });
});
