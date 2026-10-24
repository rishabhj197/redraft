// Eval runner.
//
//   node eval/run-evals.js
//       Score the hand-written fixtures. No API call. This proves the pipeline
//       and writes a dashboard-shaped report. It is not a model score.
//
//   node eval/run-evals.js --live
//       Send each case through lib/redraft.js, the same path the extension uses.
//       Needs ANTHROPIC_API_KEY. Stops at the budget guard and says which cases
//       were not run.
//
//   node eval/run-evals.js --live --judge
//       After the hints, a second call scores voice and hint quality against
//       eval/rubric.js. The judge does not see the writer prompt. Same budget
//       guard. A guard trip stops the judge and leaves the rest unscored.
//
// Reports land in eval/results/. latest.json is the newest run. The previous
// run, if there is one, is the regression baseline. Do not edit the prompt to
// chase the heldOut split.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PROMPT_VERSION } from "../lib/prompts.js";
import { ANTHROPIC_API_URL, ANTHROPIC_VERSION, DEFAULT_MODEL } from "../lib/request.js";
import { runRedraft } from "../lib/redraft.js";
import { BudgetExceededError, assertWithinBudget, costOfCall } from "../lib/budget.js";
import { readSpend, recordSpend } from "../lib/budget-store-node.js";

import { changelogNote, fixtureOutput, scoreCases } from "./evaluate.js";
import { buildReport, changelogText } from "./report.js";
import {
  JUDGE_RUBRIC,
  RUBRIC_VERSION,
  judgeUserMessage,
  parseJudgeScores,
} from "./rubric.js";

const GOLDEN_PATH = fileURLToPath(new URL("./golden-set.json", import.meta.url));
const RESULTS_DIR = fileURLToPath(new URL("./results/", import.meta.url));

const diskBudget = {
  read: readSpend,
  add: recordSpend,
};

function argSet(argv) {
  return new Set(argv.slice(2));
}

async function loadGolden() {
  const raw = await readFile(GOLDEN_PATH, "utf8");
  return JSON.parse(raw);
}

async function loadPrevious(excludeName) {
  let names = [];
  try {
    names = await readdir(RESULTS_DIR);
  } catch {
    return null;
  }
  const reports = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === "latest.json" || name === excludeName) continue;
    try {
      const parsed = JSON.parse(await readFile(join(RESULTS_DIR, name), "utf8"));
      if (parsed?.schema && parsed.ranAt) reports.push(parsed);
    } catch {
      // A half-written file is not a baseline.
    }
  }
  reports.sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1));
  return reports[0] ?? null;
}

async function liveOutput(entry, { apiKey, model }) {
  const { result } = await runRedraft(
    {
      text: entry.source,
      style: entry.style,
      mode: "coach",
      model,
      apiKey,
    },
    { fetch: globalThis.fetch, budget: diskBudget }
  );
  return {
    noChangesNeeded: result.noChangesNeeded,
    hints: result.hints ?? [],
    rejected: result.rejected ?? [],
  };
}

async function judgeOutput(entry, hints, { apiKey, model }) {
  assertWithinBudget(await diskBudget.read());

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: JUDGE_RUBRIC,
      messages: [{ role: "user", content: judgeUserMessage(entry.source, hints) }],
    }),
  });
  const bodyText = await response.text();
  let data = null;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = null;
  }
  if (response.ok && data?.usage) {
    await diskBudget.add(costOfCall(model, data.usage));
  }
  if (!response.ok) {
    return { error: `Judge call failed (${response.status}).` };
  }
  const text = data?.content?.[0]?.text ?? "";
  const fenced = text.trim().match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/i);
  const payloadText = fenced ? fenced[1] : text;
  try {
    return parseJudgeScores(JSON.parse(payloadText));
  } catch {
    return null;
  }
}

async function main() {
  const args = argSet(process.argv);
  const live = args.has("--live");
  const withJudge = args.has("--judge");
  const golden = await loadGolden();
  const model = process.env.REDRAFT_MODEL || DEFAULT_MODEL;
  const apiKey = process.env.ANTHROPIC_API_KEY || "";

  if ((live || withJudge) && !apiKey) {
    console.log("Redraft eval: set ANTHROPIC_API_KEY to run --live or --judge.");
    process.exitCode = 1;
    return;
  }

  const outputs = {};
  let stopped = null;

  for (const [index, entry] of golden.cases.entries()) {
    if (stopped) break;
    if (!live) {
      outputs[entry.id] = fixtureOutput(entry);
      continue;
    }
    try {
      outputs[entry.id] = await liveOutput(entry, { apiKey, model });
      console.log(`Redraft eval: ${entry.id} (${entry.split})`);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        stopped = { at: entry.id, remaining: golden.cases.slice(index).map((item) => item.id) };
        console.log("Redraft eval: budget guard tripped. Stopping.");
        console.log(`Not run: ${stopped.remaining.join(", ")}`);
        break;
      }
      outputs[entry.id] = { error: error.message };
      console.log(`Redraft eval: ${entry.id} failed. ${error.message}`);
    }
  }

  if (withJudge && !stopped) {
    for (const entry of golden.cases) {
      const output = outputs[entry.id];
      if (!output || output.error) continue;
      try {
        const scores = await judgeOutput(entry, output.hints ?? [], { apiKey, model });
        if (scores?.error) output.judgeError = scores.error;
        else output.judge = scores;
      } catch (error) {
        if (error instanceof BudgetExceededError || error.name === "BudgetExceededError") {
          console.log("Redraft eval: budget guard tripped during judging. Stopping.");
          break;
        }
        output.judgeError = error.message;
      }
    }
  }

  const rows = scoreCases(golden.cases, outputs);
  const ranAt = new Date().toISOString();
  const previous = await loadPrevious(null);
  const judged = Object.values(outputs).filter((output) => output?.judge).length;

  const report = buildReport({
    promptVersion: PROMPT_VERSION,
    model: live ? model : "fixture",
    source: live ? "live" : "fixture",
    ranAt,
    cases: rows,
    previous,
    changelogNote: changelogNote(PROMPT_VERSION),
    judge: withJudge && judged
      ? { status: "scored", rubricVersion: RUBRIC_VERSION }
      : {
          status: "skipped",
          reason: withJudge
            ? "The judge returned nothing that matched the rubric."
            : "Pass --judge with ANTHROPIC_API_KEY to score voice and hint quality.",
          rubricVersion: RUBRIC_VERSION,
        },
  });

  if (golden.promptVersion && golden.promptVersion !== PROMPT_VERSION) {
    report.promptVersionMismatch = {
      goldenSet: golden.promptVersion,
      code: PROMPT_VERSION,
    };
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = ranAt.replace(/[:.]/g, "-");
  const fileName = `${stamp}-${PROMPT_VERSION}.json`;
  const body = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(join(RESULTS_DIR, fileName), body, "utf8");
  await writeFile(join(RESULTS_DIR, "latest.json"), body, "utf8");

  console.log("");
  console.log(changelogText(report));
  if (report.disclaimer) console.log(report.disclaimer);
  if (report.promptVersionMismatch) {
    console.log(
      `Golden set says ${report.promptVersionMismatch.goldenSet}; the code is ${report.promptVersionMismatch.code}.`
    );
  }
  console.log(`Wrote eval/results/${fileName}`);
}

const isDirect =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main().catch((error) => {
    console.log("Redraft eval: the run failed.", error.message);
    process.exitCode = 1;
  });
}
