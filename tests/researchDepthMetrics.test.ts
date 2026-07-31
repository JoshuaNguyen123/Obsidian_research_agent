import assert from "node:assert/strict";
import test from "node:test";
import {
  countMarkdownSections,
  scoreResearchDepth,
  scoreSourceIndependence,
  type ResearchDepthInput,
} from "../src/agent/researchDepthMetrics";
import {
  MISSION_SCORE_WEIGHTS,
  scoreMissionV1,
} from "../src/agent/missionScorecard";

const THIN: ResearchDepthInput = {
  usableSourceUrls: ["https://a.example/1"],
  requiredDistinctDomains: 2,
  claimsRequiringEvidence: 6,
  citedPassageCount: 1,
  quotedSpanCount: 0,
  sectionCount: 1,
};

const THOROUGH: ResearchDepthInput = {
  usableSourceUrls: [
    "https://a.example/1",
    "https://b.example/1",
    "https://c.example/1",
    "https://d.example/1",
  ],
  requiredDistinctDomains: 2,
  claimsRequiringEvidence: 6,
  citedPassageCount: 6,
  quotedSpanCount: 3,
  sectionCount: 4,
};

test("weights still sum to exactly 1 after the reweight", () => {
  const total = Object.values(MISSION_SCORE_WEIGHTS).reduce((sum, w) => sum + w, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
});

test("a thin summary scores far below a thorough one", () => {
  // This is the failure the changelog names and nothing measured: a run that
  // fetched four sources and cited one scored the same as one that used them.
  const thin = scoreResearchDepth(THIN);
  const thorough = scoreResearchDepth(THOROUGH);
  assert.ok(thin < 0.35, `expected a thin summary to score low, got ${thin}`);
  assert.ok(thorough > 0.9, `expected a thorough report to score high, got ${thorough}`);
});

test("source independence counts registrable domains, not urls", () => {
  // Three pages of one site are one source of authority, not three.
  const sameSite = scoreSourceIndependence({
    ...THIN,
    usableSourceUrls: [
      "https://news.example.com/a",
      "https://www.example.com/b",
      "https://example.com/c",
    ],
  });
  assert.equal(sameSite, 0.5);

  const twoSites = scoreSourceIndependence({
    ...THIN,
    usableSourceUrls: ["https://a.example/1", "https://b.example/1"],
  });
  assert.equal(twoSites, 1);
});

test("independence is vacuously satisfied when no domains were required", () => {
  assert.equal(
    scoreSourceIndependence({ ...THIN, requiredDistinctDomains: 0, usableSourceUrls: [] }),
    1,
  );
});

test("no signal can be gamed past its saturation target", () => {
  const overQuoted = scoreResearchDepth({ ...THOROUGH, quotedSpanCount: 500 });
  assert.ok(overQuoted <= 1);
  assert.equal(overQuoted, scoreResearchDepth({ ...THOROUGH, quotedSpanCount: 3 }));

  const overSourced = scoreResearchDepth({
    ...THOROUGH,
    usableSourceUrls: Array.from({ length: 40 }, (_, i) => `https://s${i}.example/1`),
  });
  assert.equal(overSourced, scoreResearchDepth(THOROUGH));
});

test("an unsourced run does not score highly on structure alone", () => {
  // Headings are the cheapest signal, so they can never exceed a quarter.
  const headingsOnly = scoreResearchDepth({
    usableSourceUrls: [],
    requiredDistinctDomains: 2,
    claimsRequiringEvidence: 0,
    citedPassageCount: 0,
    quotedSpanCount: 0,
    sectionCount: 20,
  });
  assert.ok(headingsOnly <= 0.25, `got ${headingsOnly}`);
});

test("section counting recognises markdown headings only", () => {
  assert.equal(
    countMarkdownSections("# A\n\ntext\n\n## B\n\n### C\n\nnot # a heading\n"),
    3,
  );
  assert.equal(countMarkdownSections("#no space\n#### \n"), 0);
  assert.equal(countMarkdownSections(""), 0);
});

test("a mission with no research block scores both dimensions vacuously", () => {
  // A code or publication mission must not be penalised for citing nothing.
  const card = scoreMissionV1({
    acceptanceCriteriaTotal: 4,
    acceptanceCriteriaMissing: 0,
    acceptancePassed: true,
    claimsRequiringEvidence: 0,
    claimsWithEvidence: 0,
    mutationsPerformed: 2,
    mutationsWithReceipts: 2,
    recoveryAttempts: 0,
    modelCalls: 5,
    modelCallBudget: 50,
    wallClockMs: 1000,
    wallClockBudgetMs: 100_000,
  });
  const byId = new Map(card.dimensions.map((d) => [d.id, d]));
  assert.equal(byId.get("source_independence")?.score, 1);
  assert.equal(byId.get("research_depth")?.score, 1);
  assert.equal(card.total, 1);
});

test("a thin research mission now scores below a thorough one end to end", () => {
  const base = {
    acceptanceCriteriaTotal: 4,
    acceptanceCriteriaMissing: 0,
    acceptancePassed: true,
    claimsRequiringEvidence: 6,
    claimsWithEvidence: 6,
    mutationsPerformed: 1,
    mutationsWithReceipts: 1,
    recoveryAttempts: 0,
    modelCalls: 5,
    modelCallBudget: 50,
    wallClockMs: 1000,
    wallClockBudgetMs: 100_000,
  };
  const thin = scoreMissionV1({ ...base, research: THIN });
  const thorough = scoreMissionV1({ ...base, research: THOROUGH });

  // Before these dimensions both of these scored a flat 1.0.
  assert.ok(thin.total < thorough.total, `${thin.total} !< ${thorough.total}`);
  assert.ok(thorough.total > 0.99);
  assert.ok(thin.total < 0.95);
});

test("the scorecard still cannot launder a failed acceptance", () => {
  const card = scoreMissionV1({
    acceptanceCriteriaTotal: 4,
    acceptanceCriteriaMissing: 0,
    acceptancePassed: false,
    claimsRequiringEvidence: 0,
    claimsWithEvidence: 0,
    mutationsPerformed: 0,
    mutationsWithReceipts: 0,
    recoveryAttempts: 0,
    modelCalls: 1,
    modelCallBudget: 50,
    wallClockMs: 1,
    wallClockBudgetMs: 100_000,
    research: THOROUGH,
  });
  assert.equal(card.acceptancePassed, false);
});
