# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Read `PROJECT_BRIEF.md` in full before starting work; it is the spec, and this file only summarizes the parts that constrain how code should be structured.

The extension loads and runs: `lib/` holds the pure logic, `background.js` / `content.js` / `options.*` hold the Chrome plumbing, and `tests/` covers `lib/`. The eval harness (`eval/`) has not been built yet.

## Commands

```
node --test                # the whole suite — no dependencies, fetch mocked
node --test tests/foo.test.js
```

There is no build step and no lint step. The extension is loaded unpacked from the repo root; there is nothing to compile.

**Re-run `node --test` after every prompt change.** The prompt tests assert the structure of the prompt (BASE rules present in every style and mode, no style restating a BASE rule, Classic forbidding hedging behaviour rather than just hedging phrases); a change that breaks one is a regression, not a stale test.

## Two rules that are easy to break

- **`lib/` must stay free of `chrome.*` and of I/O.** That is what makes it testable in Node, and what lets `run-evals.js` exercise the exact prompt-assembly code the extension ships. Storage and `fetch` are injected — see `lib/redraft.js`. The one exception is `lib/budget-store-node.js`, which is Node-only and imported only by Node scripts. Content scripts cannot be ES modules, so `content.js` reaches `lib/` through the service worker rather than importing it.
- **The budget guard is terminal.** `assertWithinBudget` throws at 90% of `BUDGET_LIMIT_USD`. Anything that loops must catch `BudgetExceededError`, stop immediately, and report what is left undone. Never retry it, never continue past it, never widen the cap to get a run to finish. `MODEL_RATES` in `lib/budget.js` is hand-maintained — if Anthropic changes pricing and that table does not, every cost figure is wrong.

## What Redraft is

A Chrome extension that rewrites text in-place inside whatever box the user is already typing in (Gmail, LinkedIn, Slack, GitHub, comment fields) — not a separate page you paste text into. The distribution (living inside the input field) is the point, not the model call itself.

Two deliverables live in this one repo:
1. **The extension** — the actual tool.
2. **The eval work** — golden set, rubric, LLM judge, and live acceptance-rate data from real usage. This is written up as a case study, so eval code and results are first-class artifacts, not throwaway scripts.

## Architecture (see `PROJECT_BRIEF.md` §3 for full detail)

```
lib/                    PURE — no chrome.*, no I/O, testable in Node
├── prompts.js          BASE + STYLE + MODE assembly, PROMPT_VERSION
├── request.js          API request body and headers, model list
├── parse.js            response parsing + Coach JSON contract validation
├── budget.js           MODEL_RATES, cost per call, the $5 cap and the guard
├── events.js           feedback event shape + the single recordEvent()
├── redraft.js          one call end to end; fetch and storage injected
└── budget-store-node.js   Node-only .budget.json store (not imported by the extension)

tests/                  node --test, no dependencies, fetch mocked

Chrome extension        THIN — Chrome plumbing only
├── content script      detects trigger, captures text, renders the Shadow DOM widget
├── service worker      ES module; calls the API via lib/, owns the storage adapters
├── options page        API key · mode · style · model · spend readout
├── chrome.storage      key, settings, budget total, feedback events
└── supabase-js         (not yet) writes feedback events directly from the extension

Supabase
└── suggestions table    original · suggestion · style · outcome · reason · timestamp

Eval harness (separate top-level folder, e.g. eval/)
├── golden-set.json      50-100 real writing samples
├── run-evals.js         Node script: runs samples through the system, scores via judge model
└── results/             scored runs, committed as files (regression history)
```

There is **no backend server in v1**. The extension talks to Supabase directly via `supabase-js` (anon key + row-level security) and to Anthropic directly using a key stored in `chrome.storage`. This is only safe because the developer is the sole user in v1.

**This changes at Phase 2** (Chrome Web Store publish): a personal API key can no longer ship inside code strangers run. That requires adding a Vercel serverless function that holds the Anthropic key, with the extension calling that endpoint instead of Anthropic directly, plus a cost ceiling / rate limit. Don't build this proxy until Phase 2 actually starts.

## Two modes

**Coach is the default.** It returns structured JSON only — `noChangesNeeded`, `suggestions[]` (excerpt/issue/fix/why), `vocabulary[]` (from/to/why) — and the widget renders it; the writer makes the edit. `noChangesNeeded: true` with empty arrays is a valid and desirable response, not an error. **Rewrite** is the option: it returns the rewritten text and nothing else.

Coach is the default because a tool that rewrites for you leaves you exactly as good a writer as you were — see `PROJECT_BRIEF.md` §"Why Coach is the default".

## The style engine

V1 ships exactly **three hardcoded styles** (no free-text style input yet):
1. **Plain** — Orwell's rules; shortest word that does the job.
2. **Classic** — Thomas & Turner's *Clear and Simple as the Truth*; confident, unhedged, presents rather than explains.
3. **Warm** — conversational, contractions, second person.

The always-on layer is the BASE block in `lib/prompts.js`, applied on every call whatever the style and whatever the mode: restraint (say so rather than inventing a change), the Keating rule (no "very" — name the thing exactly), the vocabulary principle (the exact word over both the simpler and the fancier one; offer a less common word only when it is genuinely more accurate, with a one-line justification, and never for effect), and preservation of meaning, names, facts and formatting.

**A rule that belongs to every call lives in BASE and appears nowhere else.** Style blocks describe only what makes that style itself; mode blocks describe only the shape of the response. There is a test for this.

Free-text style input (user types any name/publication/vibe, decoded into measurable dimensions per Thomas & Turner's four axes — truth, presentation, reader-writer relation, occasion — plus countable surface features like sentence-length variance, hedging density, Latinate/Germanic ratio) is the deferred v2 design. Do not build the decomposition engine until the three hardcoded styles have proven that style selection moves acceptance rate at all — see `PROJECT_BRIEF.md` §1.

## Evaluation — two distinct systems, both required

- **Offline evals** (`eval/run-evals.js`): deterministic harness over the golden set, scored by a judge model against a written rubric. Re-run after every prompt change; a dropped score is a regression, treated like a failing test.
- **Online metrics**: every suggestion shown in the wild emits an event to Supabase — `accepted`, `accepted_then_edited`, `rejected`, `retried`, `ignored`. `accepted_then_edited` is the highest-value event (it pairs original → suggestion → human correction). On retry, capture a reason from a fixed set (wrong style / changed meaning / too aggressive / too timid) — no free text. Keep the feedback UI to three buttons; more than that gets ignored and poisons the data with unlabeled silence.

These two systems can and are expected to disagree (e.g. judge score improves but acceptance rate doesn't move) — that disagreement is a legitimate, reportable result, not a bug to hide.

## Build sequence

Follow the phase order in `PROJECT_BRIEF.md` §5 — notably, **feedback capture (step 4) and the eval harness (step 5) come before making the UI pleasant (step 7)**. Every day without event capture is unrecoverable data, so don't polish UI ahead of instrumentation.

Site support for v1 is `<textarea>` and `contenteditable`, targeting 2-3 sites (Gmail, LinkedIn are the reference targets). Google Docs is explicitly out of scope — it renders to canvas and isn't readable by content scripts.

Suggestion trigger is on-demand (keyboard shortcut) in v1, not on-pause/automatic — deferred until acceptance data justifies the intrusiveness and token cost.
