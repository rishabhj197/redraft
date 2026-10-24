import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  BASE_BLOCK,
  BASE_RULES,
  MODES,
  MODE_BLOCKS,
  PROMPT_VERSION,
  STYLES,
  STYLE_BLOCKS,
  buildSystemPrompt,
} from "../lib/prompts.js";

// Terms distinctive enough to each BASE rule that finding one inside a style
// block means the rule has been restated there.
const BASE_RULE_MARKERS = {
  restraint: [/meaningfully improved/i, /for their own sake/i, /invent a problem/i],
  keating: [/\bvery\b/i, /intensifier/i, /exhausted/i, /keating/i],
  vocabulary: [/exact word/i, /less common/i, /rarer word/i, /quota/i],
  preservation: [/\bpreservation\b/i, /formatting/i, /line breaks/i, /proper nouns/i],
  balance: [/ostentatious/i, /bare plainness/i, /earns its place/i],
};

describe("prompt assembly", () => {
  test("PROMPT_VERSION is v3", () => {
    assert.equal(PROMPT_VERSION, "v3");
  });

  test("every style, in every mode, carries every BASE rule verbatim", () => {
    for (const style of STYLES) {
      for (const mode of MODES) {
        const prompt = buildSystemPrompt({ style, mode });
        for (const [id, ruleText] of Object.entries(BASE_RULES)) {
          assert.ok(
            prompt.includes(ruleText),
            `${style}/${mode} is missing the "${id}" BASE rule`
          );
        }
      }
    }
  });

  test("BASE covers the four required rules", () => {
    assert.match(BASE_BLOCK, /cannot be meaningfully improved, leave it alone/i);
    assert.match(BASE_BLOCK, /"very tired"[\s\S]*"exhausted"/i);
    assert.match(BASE_BLOCK, /prefer the exact word over both the simpler and the fancier one/i);
    assert.match(BASE_BLOCK, /one-line justification of what it captures that the original does not/i);
    assert.match(BASE_BLOCK, /If no such word applies, offer none/i);
    assert.match(BASE_BLOCK, /Never reach for a rarer word for effect/i);
    assert.match(BASE_BLOCK, /Keep the writer's meaning, their names, their facts, and their formatting/i);
    assert.match(BASE_BLOCK, /Never be ostentatious, and never strip the writing to bare plainness/i);
    assert.match(BASE_BLOCK, /where it earns its place/i);
  });

  test("no style block restates a BASE rule", () => {
    for (const [style, block] of Object.entries(STYLE_BLOCKS)) {
      for (const [ruleId, ruleText] of Object.entries(BASE_RULES)) {
        assert.ok(
          !block.includes(ruleText),
          `style "${style}" contains the "${ruleId}" BASE rule verbatim`
        );
      }
      for (const [ruleId, markers] of Object.entries(BASE_RULE_MARKERS)) {
        for (const marker of markers) {
          assert.ok(
            !marker.test(block),
            `style "${style}" restates the "${ruleId}" BASE rule (matched ${marker})`
          );
        }
      }
    }
  });

  test("no mode block restates a BASE rule", () => {
    for (const [mode, block] of Object.entries(MODE_BLOCKS)) {
      for (const [ruleId, ruleText] of Object.entries(BASE_RULES)) {
        assert.ok(
          !block.includes(ruleText),
          `mode "${mode}" contains the "${ruleId}" BASE rule verbatim`
        );
      }
    }
  });

  test("the three v1 styles are present and no more", () => {
    assert.deepEqual(STYLES.sort(), ["classic", "plain", "warm"]);
  });

  test("both modes are present and no more", () => {
    assert.deepEqual(MODES.sort(), ["coach", "rewrite"]);
  });

  test("Classic forbids the behaviour of hedging, not just hedging phrases", () => {
    const classic = STYLE_BLOCKS.classic;

    // Behaviours, each named independently of the words that express them.
    assert.match(
      classic,
      /hand a claim to a generic subject/i,
      "Classic must forbid attributing the writer's own claim to a generic subject"
    );
    assert.match(
      classic,
      /demote a statement of fact into a suggestion or a possibility/i,
      "Classic must forbid demoting fact into suggestion via modals"
    );
    assert.match(
      classic,
      /stand back from a claim with qualifiers/i,
      "Classic must forbid distancing the writer from their own claim"
    );
    assert.match(
      classic,
      /concede a disagreement before the point has even been made/i,
      "Classic must forbid concessive throat-clearing"
    );
    assert.match(
      classic,
      /refuse the stance behind hedging, not merely its vocabulary/i,
      "Classic must say outright that the stance, not the wording, is the target"
    );

    // The phrase lists are illustration, so each behavioural clause has to
    // stand on its own once the parenthetical examples are stripped out.
    const withoutExamples = classic.replace(/\([^)]*\)/g, "");
    for (const clause of [
      /hand a claim to a generic subject/i,
      /demote a statement of fact/i,
      /stand back from a claim with qualifiers/i,
    ]) {
      assert.match(withoutExamples, clause);
    }

    // ...and the illustrations are still there, doing their secondary job.
    for (const phrase of ["one", "should", "might", "arguably", "I think"]) {
      assert.ok(
        classic.includes(`"${phrase}"`),
        `Classic should still illustrate the hedge "${phrase}"`
      );
    }
  });

  test("Coach mode states the hint contract and blesses the empty answer", () => {
    const coach = MODE_BLOCKS.coach;
    assert.match(coach, /Return one JSON object and nothing else/i);
    assert.match(coach, /"noChangesNeeded"/);
    assert.match(coach, /"hints"/);
    for (const field of ["span", "suggestion", "why", "category"]) {
      assert.match(coach, new RegExp(`"${field}"`));
    }
    for (const category of ["vocabulary", "precision", "rhythm", "ornament"]) {
      assert.match(coach, new RegExp(`"${category}"`));
    }
    assert.match(
      coach,
      /valid and welcome answer, not a failure/i,
      "Coach must say an empty answer is desirable, not an error"
    );
    assert.match(coach, /You do not rewrite the text/i);
    assert.match(coach, /never a rewritten sentence/i);
    assert.match(coach, /principles, not an imitation/i);
    assert.match(coach, /Richie Benaud/);
    assert.match(coach, /Shashi Tharoor/);
    assert.match(coach, /Karan Thapar/);
    assert.match(coach, /Never the whole sentence/i);
  });

  test("Rewrite mode asks for the text and nothing else", () => {
    assert.match(MODE_BLOCKS.rewrite, /Return the rewritten text and nothing else/i);
    assert.match(MODE_BLOCKS.rewrite, /return it exactly as it was given to you/i);
  });

  test("style and mode blocks both appear in the assembled prompt", () => {
    const prompt = buildSystemPrompt({ style: "warm", mode: "rewrite" });
    assert.ok(prompt.includes(STYLE_BLOCKS.warm));
    assert.ok(prompt.includes(MODE_BLOCKS.rewrite));
    assert.ok(!prompt.includes(STYLE_BLOCKS.plain));
    assert.ok(!prompt.includes(MODE_BLOCKS.coach));
  });

  test("an unknown style or mode throws rather than silently defaulting", () => {
    assert.throws(
      () => buildSystemPrompt({ style: "tharoor", mode: "coach" }),
      /unknown style "tharoor"/
    );
    assert.throws(
      () => buildSystemPrompt({ style: "plain", mode: "critique" }),
      /unknown mode "critique"/
    );
  });
});
