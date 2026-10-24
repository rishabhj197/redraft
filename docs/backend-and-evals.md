# Backend, and the eval plan

Two questions get mixed together because both sound like "infrastructure". They are not the same decision.

- **Evals** answer "did this prompt change make the hints better?" They are how you defend Redraft in an interview, and how you stop a prompt edit from quietly getting worse. The seed of that system is already in the repo. It should be grown. It does not need a server to be real.
- **A backend** answers "does this data have to leave this browser?" Today the answer is no. The day it becomes yes is described below, with a small schema and an order of work.

The extension remains a tool with no server of its own until one of those days arrives. Do not stand up a database to feel finished.

## Do we need a backend now?

| Need | Now? | Why |
|---|---|---|
| Hide the API key before other people install it | No | You are the only user. The key stays in this browser. The moment a stranger can install Redraft, the key has to move to a small server. That is Phase 2 in the project brief. Building the proxy before then adds a thing to run and a thing to break. |
| Rate limits and billing | No | There is one person and a hard spend cap in `lib/budget.js`. Billing is a second-user problem. |
| Style rules and the lexicon on a second device | Not yet | The lexicon is on the options page, in this browser. Sync matters when you use two machines. It is the right second table, not the reason to create the project. |
| Store the golden set and the eval results | No | Both are files. `eval/golden-set.json` is the set. `eval/results/` is the history. Files in git are the right regression log while you are the only editor. A database helps when several people append runs, or when a dashboard reads them without a checkout. |
| Accepted and dismissed hints feeding the evals | Not yet, and it is the first thing to add when you do | Every apply and dismiss is already stored locally, with the prompt version. That data dies if the browser profile is reset. Shipping it to a table is worth doing once you want a chart, and not before the hints themselves are worth charting. |

**Recommendation for now:** no backend. Keep the key, the lexicon, and the feedback events on the machine. Keep eval results as JSON in the repo. Revisit when either (a) you want a chart of accepted hints for the case study, or (b) you are about to let someone else install the extension.

## Where the data should live, when it has to

Four ordinary options. All of them can hold the tables below. The difference is how much new machinery you take on.

**Supabase (Postgres, and a key the extension can use directly).** This is what the project brief already chose. The extension can insert a row without you operating a server, provided the database rules only allow your rows. It matches "I am the only user" better than a custom API. The cost is a service to learn, and you must not ship the secret key — only the public one, with those rules turned on.

**Neon (Postgres) plus Vercel functions.** Neon is just the database. Vercel functions are the place the API key would hide in Phase 2. This pair is the cleanest answer on the day strangers install Redraft, because the function holds the Anthropic key, checks a rate limit, and writes to Postgres. It is more to build than Supabase for a single user, and it is the right shape later. You would not use it tonight.

**Firebase.** It would store the rows, and it has login. It would also be a second dialect of data, different from the SQL you would want for "show me accept rate by prompt version". The eval report is a document with nested cases. SQL, or a JSON column in SQL, fits that. Firebase does not buy anything the other options lack. Skip it.

**Cloudflare Workers plus D1.** A Worker can hide the API key at the edge, and D1 is a small SQL database next to it. Cheap, and one vendor for the proxy and the tables. The limit is that D1 is a weaker fit once you want to slice feedback a dozen ways for a write-up, and you would be learning it instead of the Postgres the rest of this plan assumes. Reasonable if you later want the proxy as close to the user as possible. Not the first choice for the eval history.

**What to pick.** When you need a table and you are still the only user, use **Supabase**. It is the path the brief described, the extension can write to it directly, and the eval report can sit in a JSON column without a new API. When you publish to the Chrome Web Store, add a **Vercel function** in front of Anthropic and leave the Supabase tables where they are. Do not migrate the eval history just because the key moved. If you would rather have one vendor on that day, Neon plus Vercel can replace both — but that is a swap, not the starting point.

## Minimal schema

Names match the words the extension already uses. Prompt version and model travel on every row that came from a model. Without them a good week of hints cannot be tied to the prompt that produced them.

**users**

- `id`
- `email`
- `created_at`

One row, until there is a second person. Exists so the other tables have somewhere to point.

**style_rules**

- `id`
- `user_id`
- `name` — `plain`, `classic`, or `warm` for now
- `body` — the principles in force, if you ever pin a note to yourself. Not a free-text "write like X"
- `active`
- `created_at`

The three styles stay the ones in the extension. This table is not permission to add a box where you type a person's name.

**hints**

- `id`
- `user_id`
- `prompt_version`
- `model`
- `style`
- `category` — `vocabulary`, `precision`, `rhythm`, or `ornament`
- `span`
- `suggestion`
- `why`
- `source_hash` — a fingerprint of the draft, so you can group hints without storing the draft
- `source_text` — the draft itself, **only if you have switched keeping examples on**. Mail and chats contain other people's words. Default off.
- `created_at`

**feedback**

- `id`
- `hint_id`
- `outcome` — `applied`, `dismissed`, `applied_then_edited`, `retried`, `ignored`
- `reason` — only for a retry, from the fixed list (`wrong_style`, `changed_meaning`, `too_aggressive`, `too_timid`)
- `edited_to` — what you changed the suggestion to, when the outcome is `applied_then_edited`
- `created_at`

The extension today records `applied` and `dismissed`. The other outcomes are in the data model so the case study can use them later. They are not a reason to add more buttons. Three controls on the card is still the limit. `applied_then_edited` would be observed (you applied a hint, then changed that span yourself), not asked.

**lexicon**

- `id`
- `user_id`
- `from_text`
- `to_text`
- `why`
- `category`
- `style`
- `applied_at`

One row per pair you have taken up. Applying it again updates the row rather than adding a twin. This is the same list as "Your lexicon" on the options page. The page stays the place you read it. The table is how a second device would see it.

**eval_runs**

- `id`
- `prompt_version`
- `rubric_version`
- `model`
- `source` — `fixture` or `live`
- `report` — the whole JSON document the harness already writes (`redraft.evalReport.v1`)
- `created_at`

Store the report as one document. A dashboard reads `report.summary` and does not need a new shape. If you later want "this one sentence across every prompt", add a child table of case rows. Do not start there. The seed's file is the document.

## How the evals work

This is the part to walk someone through. The code is the short version. The discipline is the part they are asking about.

### A prompt has a version

`PROMPT_VERSION` in `lib/prompts.js` is `v3`. Every request, every stored hint, and every eval report carries it. v1 and v2 were real prompts and were **not** scored by this harness. The changelog says that, so you do not present a history you do not have. The next time the prompt changes, the version becomes v4 in the same edit as the words. A score with no version is not a result.

### A golden set, with a held-out split

`eval/golden-set.json` is fifteen sentences. Eleven are `dev`. Four are `heldOut`.

Dev is what you look at while you change the prompt. Held-out is reported beside it and is not the set you rewrite the prompt to please. Four is too small to be a statistic. It is large enough to practise the rule. The grown set should be on the order of fifty to a hundred real samples (your own sent mail, with names removed), frozen before the prompt edit you are testing, with a held-out slice you do not open while you are editing.

Each case has the draft, the style, and what a good hint is allowed to do. It does not demand one magic word. Demanding "exhausted" would make the test a memory of the fixture.

### Hard checks

`eval/checks.js` uses the same guards as the extension (`lib/hints.js`). A case fails when:

- the span is not actually in the draft
- the suggestion is a rewrite of the sentence or of the whole draft
- the suggestion is an intensifier or a stock flourish (`very`, `delve`, `tapestry`, and the rest of that list)
- the suggestion is a paragraph, or too long to be a phrase
- a name the case said to keep is dropped
- the model returned no hint on a draft that needed one
- the model returned a hint on a draft the case marked as already good enough — an empty answer is a pass only when the case allows it

Hard checks do not have taste. They stop the failures you should never ship. They are also why a fixture run can be green without the model being good. The fixtures were written to pass. Say that out loud if you show the file.

### The judge

`eval/rubric.js` is a second model call. It scores the hints, not the prompt, and it is not shown the prompt. Five scores, each from 1 to 5:

- **precision** — the suggestion names something the original only gestured at
- **ornament balance** — the heavier word earns its place, and a plain word is left alone when it was doing the job. Purple and stripped-bare both score badly
- **locality** — the suggestion fits in the span. A rewritten sentence scores 1
- **lesson** — the reason is one sentence you could reuse in speech
- **voice** — economical, exact, warm where warmth belongs. Imitating a person, or sounding like a model, scores badly

An empty hint list on a draft that was already exact can score 5. An empty list on a slack draft scores low. The mean is reported for dev and for held-out separately. A high judge score does not cancel a failed hard check. Both numbers stay on the report. If they disagree, that disagreement is a finding, not a bug to hide.

The judge is off unless you pass `--judge`. It spends money. The budget guard stops it mid-run and the report says which cases were not scored.

### What you actually did

Human preference is the online half, and it is not filled in by the seed. The report has a slot, `humanPreference`, with `status: "not-joined"` and null counts. That is deliberate. The counts become real when applied and dismissed events are joined to a prompt version. Until then the slot stays empty, so a dashboard cannot show a fake accept rate.

The outcome you will want most later is applied-then-edited: you took the hint and then changed it. The card does not ask for that. It would be inferred. Do not add a fourth button to collect it.

### Regression, and the changelog

Each run looks at the previous report and writes the change in hard-check pass rate and in judge mean, split by dev and held-out. The first run says there is no baseline. A drop on held-out is the number you treat as a regression. A drop only on dev means you are looking at sentences you have been editing against, and you should not comfort yourself with it.

The report's `changelog` block is the paragraph you can paste above a prompt commit: version, what changed, the two pass rates, the judge if it ran, and which version you compared with. `eval/evaluate.js` holds the note for v3. Write the v4 note in the same commit as the prompt.

### The file a dashboard would read

`node eval/run-evals.js` writes `eval/results/latest.json` and a dated copy. The shape is `redraft.evalReport.v1`. The summary a dashboard needs is already at the top: pass rate by split, counts by category, judge status, the empty human-preference slot, and the regression against the previous file. Per-case rows are underneath, for the drill-down.

The committed `latest.json` is a **pipeline check on hand-written fixtures**. The disclaimer inside the file says so. It is not a model score, and it should not be quoted as one. The first number that is a model score is a `--live` run, which you do when you want to spend the tokens, with `ANTHROPIC_API_KEY` set. `--live --judge` adds the rubric. Both stop if the spend cap is hit, and the cases they did not reach are marked not-run rather than failed.

Commands, for the record:

```
node --test
node eval/run-evals.js
node eval/run-evals.js --live
node eval/run-evals.js --live --judge
```

## Rolling it out

1. **Now.** Versioned prompt, golden set, hard checks, rubric, report files. Lexicon and feedback stay in the browser. No server.
2. **When you want the chart.** Supabase, with `hints`, `feedback`, `lexicon`, and `eval_runs`. The extension writes an event locally and, if the network works, to the table. A failed upload does not lose the local copy. `run-evals.js` gains a flag to upload the same JSON it already writes to disk. The dashboard, when you build one, reads `eval_runs.report` and does not invent a second format.
3. **When someone else can install it.** A Vercel function holds the Anthropic key, enforces a rate limit, and is the only new piece. The tables stay. The prompt version still travels with every hint, or the chart from step 2 becomes unreadable the day the proxy ships.
4. **Not in this sequence.** A free-text "write like this person" box, a public signup, billing, and a Docs add-on. Each of those is a different product decision. The eval has to show that style and hints change what you accept before any of them is worth building.

The seed and this plan are the same system. The files are the small version. The tables are that version, stored, once you have a reason to store it.
