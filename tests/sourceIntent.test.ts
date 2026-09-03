import assert from "node:assert/strict";
import test from "node:test";
import { requiresWebEvidenceProof } from "../src/agent/evidenceIntent";
import { analyzeGeneratedOutputPrompt } from "../src/agent/generatedOutputPolicy";
import { planLoopBudget } from "../src/agent/loopPlanner";
import { hasExplicitGroundingIntentV1 } from "../src/agent/missionEffortDecision";
import {
  hasFetchedWebSourceIntent,
  hasStaticGenerationIntent,
  hasWebSearchIntent,
} from "../src/agent/promptIntentClassifiers";
import {
  matchesFetchedWebSourceLanguageV1,
  matchesSourcesOrWebLanguageV1,
} from "../src/agent/sourceIntent";

const PARAPHRASE_SOURCE_PROMPTS = [
  "Write a 1000 word essay on photosynthesis. Cite your sources.",
  "Write a 1000 word essay on photosynthesis. Include sources.",
  "Write a 1000 word essay on photosynthesis. Back this up with sources.",
] as const;

const STATIC_GEN_NO_SOURCES =
  "Write a 1000 word essay on photosynthesis in your own words.";

const LITERARY =
  "Write an essay. Use quotations and citations from the book.";

const CODE_SOURCE_FILES =
  "Read the source files and add tests. Do not search the web.";

const EMPTY_INTENT = {
  vaultContext: false,
  noteOutput: true,
  explicitMutation: false,
  requireWriteCompletion: false,
};

function seatsAgreeOnFetchedSources(prompt: string): {
  language: boolean;
  fetched: boolean;
  webSearch: boolean;
  generated: boolean;
  effort: boolean;
  proof: boolean;
  catalog: boolean;
} {
  const generated = analyzeGeneratedOutputPrompt(prompt);
  const budget = planLoopBudget({
    prompt,
    route: "grounded_workflow",
    generated,
    configuredMaxSteps: 13,
  });
  return {
    language: matchesFetchedWebSourceLanguageV1(prompt),
    fetched: hasFetchedWebSourceIntent(prompt),
    webSearch: hasWebSearchIntent(prompt),
    generated: generated.requiresGrounding,
    effort: hasExplicitGroundingIntentV1(prompt),
    proof: requiresWebEvidenceProof(prompt, EMPTY_INTENT),
    catalog: budget.expectedTools.includes("web_search"),
  };
}

test("possessive and paraphrase source asks share one family across route, proof, policy, effort, and catalog", () => {
  for (const prompt of PARAPHRASE_SOURCE_PROMPTS) {
    assert.equal(hasStaticGenerationIntent(prompt), true, prompt);
    const seats = seatsAgreeOnFetchedSources(prompt);
    for (const [seat, value] of Object.entries(seats)) {
      assert.equal(value, true, `${seat} must accept: ${prompt}`);
    }
  }
});

test("static generation without source language does not invent a web obligation", () => {
  assert.equal(hasStaticGenerationIntent(STATIC_GEN_NO_SOURCES), true);
  const seats = seatsAgreeOnFetchedSources(STATIC_GEN_NO_SOURCES);
  assert.equal(seats.language, false);
  assert.equal(seats.fetched, false);
  assert.equal(seats.webSearch, false);
  assert.equal(seats.generated, false);
  assert.equal(seats.catalog, false);
});

test("literary book citations and source-code artifacts stay out of the fetched-web family", () => {
  assert.equal(hasFetchedWebSourceIntent(LITERARY), false);
  assert.equal(analyzeGeneratedOutputPrompt(LITERARY).requiresGrounding, false);
  assert.equal(hasFetchedWebSourceIntent(CODE_SOURCE_FILES), false);
  assert.equal(
    matchesSourcesOrWebLanguageV1("Read the source files in src/agent."),
    false,
  );
});
