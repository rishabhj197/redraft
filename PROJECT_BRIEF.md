# Redraft — Project Brief

**Tagline:** *Laziness will not do.*
**Mark:** a torn-out page — Keating's students ripping the "Understanding Poetry" preface from their textbooks.
**Backup names:** Verse · Keating · Fair Copy

> "Avoid using the word 'very' because it's lazy. A man is not very tired, he is exhausted. Don't use very sad, use morose."
> — John Keating, *Dead Poets Society* (1989)

That line is the product specification.

---

## What it is

A Chrome extension that improves your writing **in the box where you're already writing it** — Gmail, LinkedIn, Slack, GitHub, comment fields.

## What it deliberately is not

A page you paste text into. That is Claude with a system prompt, and it earns nothing. **The distribution is the product.**

## Two deliverables, one repo

| Deliverable | What it is | Who it's for |
|---|---|---|
| **The extension** | A tool you use every day | You |
| **The eval work + write-up** | Golden set, rubric, judge, live acceptance data | Hiring managers |

---

# 1 · The style engine

The user picks how they want to write. Two obvious approaches, and the right answer is neither on its own.

### Approach A — name a person
*"Write like Shashi Tharoor."* Fails as a specification. The model reaches for ornate vocabulary and calls it done. Unmeasurable, so no eval is possible.

### Approach B — fixed frameworks
Five to ten named styles the user picks from. Measurable, but rigid, and every user's request has to be squeezed into a box that may not fit.

### Approach C — decompose *(recommended)*

Let the user name **anyone or anything** — a person, a publication, a vibe — then **decode it into a fixed set of measurable dimensions**. The prompt is assembled from dimensions, never from the name.

This is exactly the "more deliberate and quantifiable, repeatable without referring to some archaic repository" instinct you described. It is also the only version that can be evaluated, because dimensions can be measured in the output and names cannot.

### The academic backing — this already exists

Francis-Noël Thomas and Mark Turner, *Clear and Simple as the Truth: Writing Classic Prose* (Princeton), define a real taxonomy of prose styles: **classic, plain, reflexive, practical, contemplative, romantic, prophetic**, and others.

More useful than the list is **their method**. They argue a style is fully defined by its stand on four questions:

| Question | What it establishes |
|---|---|
| **Truth** | Can it be known and shown? Or is it contingent, personal, unstable? |
| **Presentation** | Is the writing a window onto something, or is it performing? |
| **Reader–writer relation** | Equals? Teacher and student? Advocate and audience? |
| **Occasion** | Formal, informal, ceremonial, transactional? |

That is your decoder. Any name the user types resolves into a position on those four axes, plus observable surface features you can actually count:

- Average sentence length and its variance
- Latinate vs Germanic word ratio
- Active vs passive constructions
- Concrete vs abstract nouns
- Hedging density (*perhaps, somewhat, arguably*)
- Ornamentation: subordinate clauses, appositives, rhetorical figures

A second useful frame is **register** — Martin Joos's *The Five Clocks* (1961): frozen, formal, consultative, casual, intimate. Orthogonal to style, and easy for users to grasp.

**Why this matters for the case study:** "I built a style taxonomy grounded in Thomas & Turner and made it measurable" is a far stronger claim than "I wrote some prompts." Citing prior art signals you researched rather than improvised.

### Is this overkill for v1?

**Yes, in full.** Ship v1 with **three** styles, hardcoded, and the free-text decoder deferred:

1. **Plain** — Orwell's rules. Shortest word that does the job.
2. **Classic** — Thomas & Turner. Confident, unhedged, presents rather than explains.
3. **Warm** — conversational, contractions, second person.

Three is enough to test whether style selection changes acceptance at all. If it doesn't move the metric, the elaborate version was never worth building — and **finding that out cheaply is itself a case-study result.**

---

# 2 · Evaluation

You said you need to understand evals first. Here is the distinction that matters, because they are two different things and you have proposed the second one.

### Offline evals — the harness

A fixed set of examples, run through the system on demand, scored automatically.

- **Golden set:** 50–100 real writing samples you've collected
- **Rubric:** a written definition of what "better" means for this product
- **Judge:** a second model call that scores the output against the rubric, ideally blind to which version produced it
- **Regression check:** re-run after every prompt change; a score that drops is a bug

Repeatable, runs in seconds, catches damage before it ships. **This is what AI-native interviews screen for.** It also cannot be faked after the fact — the baseline only exists if you captured it early.

### Online metrics — real behaviour

What actually happened when a real person used it. This is your idea, and it is the half most people skip.

Every suggestion emits an event:

| Event | Signal strength | What it tells you |
|---|---|---|
| **Accepted** | High | It was right |
| **Accepted, then edited** | **Highest** | Close but wrong in a specific, diagnosable way |
| **Rejected** | Medium | Wrong, or unwanted here |
| **Retried** | High | Wrong, and they still wanted help — the most valuable failure |
| **Ignored** | Low | Ambiguous; could mean anything |

**"Accepted then edited" was missing from your list and it is the most valuable event you can capture.** It localises the failure — you get the original, the suggestion, and the human correction, which is a free training example and a free eval case.

On retry, capture **why**: wrong style · changed the meaning · too aggressive · too timid. Four options, no free text at first.

**Keep it to three visible buttons.** A feedback UI that asks for too much gets ignored, and ignored feedback poisons your dataset with silence you can't interpret.

### Where the case study lives

The interesting finding is where the two disagree. *"My judge scored the new prompt 12% higher, but acceptance rate didn't move"* — that is a genuinely sophisticated result, and admitting it is more credible than any success story.

**Do both. The harness is the credential; the metrics are the evidence it worked.**

---

# 3 · Architecture

### Supabase is in v1 — you were right

I argued against it for the tracker. That was 13 static rows in a file. This is different: **feedback events accumulate over time and need querying.** That is what a database is for. The instinct was correct.

```
Chrome extension
├── content script      watches text fields, detects trigger, renders suggestion
├── service worker      calls the Anthropic API
├── options page        your API key + style preference
├── chrome.storage      key stored locally, never leaves your machine
└── supabase-js         writes feedback events directly from the extension

Supabase
└── suggestions table   original · suggestion · style · outcome · reason · timestamp

Eval harness (same repo, separate folder)
├── golden-set.json     50–100 real samples
├── run-evals.js        Node script → judge → scores
└── results/            scored runs, committed as files
```

**Still no server.** The Supabase JS client talks to the database directly from the extension using an anon key plus row-level security. Your Anthropic key stays in `chrome.storage` because you are the only user.

**This changes at Phase 2.** Publishing to the Chrome Web Store means strangers running your code — you cannot ship your Anthropic key inside it. That requires a proxy: a small Vercel serverless function holding the key, with the extension calling your endpoint instead of Anthropic directly. Plan for it; don't build it yet.

---

# 4 · The ecosystem

| Layer | Tool | What happens here |
|---|---|---|
| **Deciding** | Cowork | Spec, prompt design, eval rubric, case study writing. No machine access — for thinking, not building. |
| **Building** | Claude Code in VS Code | All code. Reads `CLAUDE.md` every session. ~90% of your time. |
| **History** | Git → GitHub | `rishabhj197/redraft`. Commit often, push when it works. |
| **Running the tool** | Chrome | Load unpacked from the repo folder. Reload to test. |
| **Feedback data** | Supabase | Suggestion events. Queried for the case study. |
| **Running the evals** | Node, in the VS Code terminal | `node run-evals.js` → results to disk → committed. |
| **The AI** | Anthropic API | Called from the extension. Pay-per-token, your key. |
| **Publishing the story** | Vercel | The write-up, on the pipeline you already proved. |

---

# 5 · Build sequence

### Phase 1 — a tool you use

**0 · Verify API access** *(15 min)* — console.anthropic.com → Billing. Confirm the credits exist and haven't expired. Everything downstream depends on it.

**1 · Skeleton** — extension loads, options page takes your key, logs to console on trigger. No AI. Proves the plumbing.

**2 · First real call** — text out, rewrite back, logged. Ugly is fine.

**3 · Three styles** — Plain, Classic, Warm. Hardcoded prompts, picked in options.

**4 · Feedback capture + Supabase** — three buttons, events written to the table. **Before the UI is pretty**, because every day without capture is lost data.

**5 · The eval harness** — golden set, rubric, judge, baseline recorded. **Do not skip to Phase 6 first.**

**6 · Iterate against the numbers** — change the prompt, re-run, compare, commit. This is the case study.

**7 · Make it pleasant** — inline UI, accept/reject, keyboard shortcut. Only now.

### Phase 2 — a thing you can hand someone

The goal is being able to say *"install it and try it"* in an interview. That requires:

- **Chrome Web Store listing** — review takes days to weeks; start early
- **Key proxy** — a Vercel function so you aren't shipping your own key
- **Cost ceiling** — rate limiting, or strangers will spend your money
- **Onboarding** — it must work for someone who has read nothing
- **The write-up** — published at `redraft.rishabh-jain.com`, linked from your tracker

**Phase 2 is where this stops being a project and becomes a portfolio piece.** Phase 1 is the prerequisite, not the goal.

---

# 6 · Open decisions

**Trigger: on-pause or on-demand?**
Start **on-demand** — a keyboard shortcut. Firing automatically while someone drafts an email is intrusive and burns tokens on unfinished text. Add on-pause once acceptance rate shows the output is worth surfacing unprompted.

**What does it improve?**
Style selection now answers this: it moves text toward a chosen style. That's measurable. Keep the Keating lesson — lazy word choice — as the always-on layer beneath whichever style is selected.

**Which sites for v1?**
`<textarea>` and `contenteditable`, tested on two or three sites. Gmail and LinkedIn are reasonable. **Avoid Google Docs** — it renders text to canvas, so extensions can't read it normally. Verify before promising it to yourself.

---

**Sources:** [Clear and Simple as the Truth — Princeton University Press](https://press.princeton.edu/books/paperback/9780691147437/clear-and-simple-as-the-truth) · [classicprose.com](https://classicprose.com/)
