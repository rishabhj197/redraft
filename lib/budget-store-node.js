// Node-only budget store. Persists the running total in .budget.json at the
// repo root. Imported by Node scripts (the eval harness); never by extension
// code — it touches the filesystem.
//
// The total never auto-resets. Delete .budget.json by hand if you mean to.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { addSpend, assertWithinBudget, budgetSummary } from "./budget.js";

export const BUDGET_FILE = fileURLToPath(new URL("../.budget.json", import.meta.url));

export async function readSpend() {
  try {
    const raw = await readFile(BUDGET_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.spentUsd === "number" ? parsed.spentUsd : 0;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function writeSpend(spentUsd) {
  const payload = {
    spentUsd,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(BUDGET_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** Throws BudgetExceededError if the stored total is at or above the threshold. */
export async function assertWithinBudgetOnDisk() {
  assertWithinBudget(await readSpend());
}

/** Add one call's cost to the stored total and return the new summary. */
export async function recordSpend(callCostUsd) {
  const total = addSpend(await readSpend(), callCostUsd);
  await writeSpend(total);
  return budgetSummary(total);
}
