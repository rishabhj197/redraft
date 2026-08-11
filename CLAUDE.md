# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repository currently contains only the project brief (`PROJECT_BRIEF.md`) — no code has been written yet. There is no `package.json`, build tooling, or test suite. Read `PROJECT_BRIEF.md` in full before starting work; it is the spec, and this file only summarizes the parts that constrain how code should be structured. Once real commands (build/lint/test/eval) exist, add them to this file.

## What Redraft is

A Chrome extension that rewrites text in-place inside whatever box the user is already typing in (Gmail, LinkedIn, Slack, GitHub, comment fields) — not a separate page you paste text into. The distribution (living inside the input field) is the point, not the model call itself.

Two deliverables live in this one repo:
1. **The extension** — the actual tool.
2. **The eval work** — golden set, rubric, LLM judge, and live acceptance-rate data from real usage. This is written up as a case study, so eval code and results are first-class artifacts, not throwaway scripts.

## Architecture (target — see `PROJECT_BRIEF.md` §3 for full detail)

```
Chrome extension
├── content script      watches text fields, detects trigger, renders suggestion
├── service worker      calls the Anthropic API
├── options page        API key + style preference
├── chrome.storage      Anthropic key stored locally (v1 only — see below)
└── supabase-js         writes feedback events directly from the extension

Supabase
└── suggestions table    original · suggestion · style · outcome · reason · timestamp

Eval harness (separate top-level folder, e.g. eval/)
├── golden-set.json      50-100 real writing samples
├── run-evals.js         Node script: runs samples through the system, scores via judge model
└── results/             scored runs, committed as files (regression history)
```

There is **no backend server in v1**. The extension talks to Supabase directly via `supabase-js` (anon key + row-level security) and to Anthropic directly using a key stored in `chrome.storage`. This is only safe because the developer is the sole user in v1.

**This changes at Phase 2** (Chrome Web Store publish): a personal API key can no longer ship inside code strangers run. That requires adding a Vercel serverless function that holds the Anthropic key, with the extension calling that endpoint instead of Anthropic directly, plus a cost ceiling / rate limit. Don't build this proxy until Phase 2 actually starts.

## The style engine

V1 ships exactly **three hardcoded styles** (no free-text style input yet):
1. **Plain** — Orwell's rules; shortest word that does the job.
2. **Classic** — Thomas & Turner's *Clear and Simple as the Truth*; confident, unhedged, presents rather than explains.
3. **Warm** — conversational, contractions, second person.

A "lazy word choice" correction (the Keating rule — no "very", precise words over vague intensifiers) is an always-on layer applied regardless of which style is selected.

Free-text style input (user types any name/publication/vibe, decoded into measurable dimensions per Thomas & Turner's four axes — truth, presentation, reader-writer relation, occasion — plus countable surface features like sentence-length variance, hedging density, Latinate/Germanic ratio) is the deferred v2 design. Do not build the decomposition engine until the three hardcoded styles have proven that style selection moves acceptance rate at all — see `PROJECT_BRIEF.md` §1.

## Evaluation — two distinct systems, both required

- **Offline evals** (`eval/run-evals.js`): deterministic harness over the golden set, scored by a judge model against a written rubric. Re-run after every prompt change; a dropped score is a regression, treated like a failing test.
- **Online metrics**: every suggestion shown in the wild emits an event to Supabase — `accepted`, `accepted_then_edited`, `rejected`, `retried`, `ignored`. `accepted_then_edited` is the highest-value event (it pairs original → suggestion → human correction). On retry, capture a reason from a fixed set (wrong style / changed meaning / too aggressive / too timid) — no free text. Keep the feedback UI to three buttons; more than that gets ignored and poisons the data with unlabeled silence.

These two systems can and are expected to disagree (e.g. judge score improves but acceptance rate doesn't move) — that disagreement is a legitimate, reportable result, not a bug to hide.

## Build sequence

Follow the phase order in `PROJECT_BRIEF.md` §5 — notably, **feedback capture (step 4) and the eval harness (step 5) come before making the UI pleasant (step 7)**. Every day without event capture is unrecoverable data, so don't polish UI ahead of instrumentation.

Site support for v1 is `<textarea>` and `contenteditable`, targeting 2-3 sites (Gmail, LinkedIn are the reference targets). Google Docs is explicitly out of scope — it renders to canvas and isn't readable by content scripts.

Suggestion trigger is on-demand (keyboard shortcut) in v1, not on-pause/automatic — deferred until acceptance data justifies the intrusiveness and token cost.
