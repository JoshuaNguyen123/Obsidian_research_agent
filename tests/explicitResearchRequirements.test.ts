import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DEFAULT_MIN_FETCHED_SOURCES_V1,
  groundedToolStepBudgetForSourcesV1,
  parseExplicitResearchDomainCount,
  parseExplicitResearchSourceCount,
} from "../src/agent/explicitResearchRequirements";
import { minDistinctDomainsForEffort } from "../src/agent/researchPlan";
import { planLoopBudget } from "../src/agent/loopPlanner";
import { analyzeGeneratedOutputPrompt } from "../src/agent/generatedOutputPolicy";

/**
 * The prompt both real-web lane missions were given on 2026-09-14. It names
 * three sources and two domains; the product planned three domains and five
 * tool steps, and neither mission wrote a word before its budget ran out.
 */
const LANE_PROMPT_V1 =
  "Write a 300-word cited summary of how CRISPR base editing differs from prime editing, with at least 3 sources from at least 2 domains and a limitations section. Append it to the current note.";

test("a domain count is read out of the prompt", () => {
  assert.equal(parseExplicitResearchDomainCount(LANE_PROMPT_V1), 2);
  assert.equal(
    parseExplicitResearchDomainCount("use at least 4 distinct domains"),
    4,
  );
  assert.equal(
    parseExplicitResearchDomainCount("cite across three different publishers"),
    3,
  );
  assert.equal(parseExplicitResearchDomainCount("from two separate sites"), 2);
  assert.equal(
    parseExplicitResearchDomainCount("using 3 distinct source domains"),
    3,
  );
});

test("a bare source count is never read as a domain count", () => {
  // Three sources can all share one domain; only the domain word licenses a
  // domain floor. Reading "3 sources" as three domains is the defect itself.
  assert.equal(parseExplicitResearchDomainCount("use at least 3 sources"), null);
  assert.equal(parseExplicitResearchDomainCount("fetch both sources"), null);
  assert.equal(parseExplicitResearchDomainCount("summarize this note"), null);
});

test("the lane prompt yields three sources and two domains together", () => {
  assert.equal(parseExplicitResearchSourceCount(LANE_PROMPT_V1), 3);
  assert.equal(parseExplicitResearchDomainCount(LANE_PROMPT_V1), 2);
});

test("an explicit domain count outranks the effort tier", () => {
  // The regression: deep tier used to force 3 regardless of the request.
  for (const tier of ["standard", "deep", "extended"] as const) {
    assert.equal(
      minDistinctDomainsForEffort({
        mode: "deep_web",
        tier,
        minFetchedSources: 3,
        explicitDomains: 2,
      }),
      2,
      `${tier} tier must honor the two domains the request asked for`,
    );
  }
});

test("without an explicit count the tier floor still applies", () => {
  assert.equal(
    minDistinctDomainsForEffort({
      mode: "deep_web",
      tier: "deep",
      minFetchedSources: 3,
      explicitDomains: null,
    }),
    3,
  );
  assert.equal(
    minDistinctDomainsForEffort({
      mode: "deep_web",
      tier: "standard",
      minFetchedSources: 3,
    }),
    2,
  );
});

test("a domain floor never exceeds the sources owed, explicit or not", () => {
  assert.equal(
    minDistinctDomainsForEffort({
      mode: "deep_web",
      tier: "deep",
      minFetchedSources: 2,
      explicitDomains: 5,
    }),
    2,
  );
  assert.equal(
    minDistinctDomainsForEffort({ mode: "deep_vault", minFetchedSources: 3 }),
    0,
  );
});

test("the tool budget covers the ladder each source owes", () => {
  // search + (fetch, read, verify) per source + write, plus retry margin.
  assert.equal(groundedToolStepBudgetForSourcesV1(1), 6);
  assert.equal(groundedToolStepBudgetForSourcesV1(2), 10);
  assert.equal(groundedToolStepBudgetForSourcesV1(3), 14);
  assert.ok(
    groundedToolStepBudgetForSourcesV1(3) >= 1 + 3 * 3 + 1,
    "three sources must afford a search, three fetch/read/verify triples and a write",
  );
});

test("the lane mission is funded for the evidence it owes", () => {
  const generated = analyzeGeneratedOutputPrompt(LANE_PROMPT_V1);
  const budget = planLoopBudget({
    prompt: LANE_PROMPT_V1,
    route: "grounded_workflow",
    generated,
    configuredMaxSteps: 100,
  });
  // It used to get five tool steps for an eleven-call ladder.
  assert.equal(budget.toolStepBudget, 14);
  assert.ok(
    budget.toolStepBudget + budget.finalizationReserve > 12,
    "the mission must outlive the 12-step cap that truncated it",
  );
  // A cap, not a target: the loop still stops the moment acceptance is met.
  assert.equal(budget.stopWhenSatisfied, true);
});

test("naming a source count funds the mission even when grounding is not flagged", () => {
  const prompt = "Write a cited brief using 3 distinct source domains.";
  const budget = planLoopBudget({
    prompt,
    route: "grounded_workflow",
    generated: analyzeGeneratedOutputPrompt(prompt),
    configuredMaxSteps: 100,
  });
  assert.equal(budget.toolStepBudget, 14);
});

test("explicit deep research still reaches the hard cap", () => {
  const prompt = "Do deep research on carbon border adjustment mechanisms.";
  const budget = planLoopBudget({
    prompt,
    route: "grounded_workflow",
    generated: analyzeGeneratedOutputPrompt(prompt),
    configuredMaxSteps: 100,
  });
  assert.equal(budget.toolStepBudget, 96);
});

test("an ungrounded mission keeps its small budget", () => {
  const prompt = "What is 2 + 2?";
  const budget = planLoopBudget({
    prompt,
    route: "single_model_answer",
    generated: analyzeGeneratedOutputPrompt(prompt),
    configuredMaxSteps: 100,
  });
  assert.ok(
    budget.toolStepBudget <= DEFAULT_MIN_FETCHED_SOURCES_V1,
    `a mission that owes no evidence must not be funded like one (got ${budget.toolStepBudget})`,
  );
});

/**
 * Source-level guard: the budget and the source contract drifted apart because
 * each subsystem owned its own number. A flat literal here would reopen that.
 */
test("the loop budget reads the source count rather than owning one", () => {
  const source = readFileSync("src/agent/loopPlanner.ts", "utf8");
  assert.ok(
    source.includes("groundedToolStepBudgetForSourcesV1"),
    "loopPlanner must size grounded missions through the shared budget rule",
  );
  assert.ok(
    source.includes("parseExplicitResearchSourceCount"),
    "loopPlanner must read the request's own source count",
  );
});

test("the research planner and the loop budget share one parser", () => {
  const planner = readFileSync("src/agent/researchPlan.ts", "utf8");
  assert.ok(
    planner.includes('from "./explicitResearchRequirements"'),
    "researchPlan must import the shared parsers, not re-implement them",
  );
  assert.ok(
    !/function parseExplicitResearchSourceCount/u.test(planner),
    "researchPlan must not carry a second copy of the source parser",
  );
});
