import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeMissionScorecard,
  scoreMissionV1,
} from "../src/agent/missionScorecard";
import { baselineRecordIsCurrent } from "../scripts/mission-scorecard-regression.mjs";

const BASELINE_PATH = new URL(
  "../e2e/baselines/mission-scorecards.v1.json",
  import.meta.url,
);

const EMPTY_SET: Parameters<typeof scoreMissionV1>[0] = {
  acceptanceCriteriaTotal: 0,
  acceptanceCriteriaMissing: 0,
  acceptancePassed: true,
  claimsRequiringEvidence: 0,
  claimsWithEvidence: 0,
  mutationsPerformed: 0,
  mutationsWithReceipts: 0,
  recoveryAttempts: 0,
  modelCalls: 4,
  modelCallBudget: 8,
  wallClockMs: 1_000,
  wallClockBudgetMs: 10_000,
};

test("empty-set coverage still scores 1 but flags the dimension vacuous", () => {
  const card = scoreMissionV1(EMPTY_SET);
  const byId = new Map(card.dimensions.map((item) => [item.id, item]));

  const grounding = byId.get("evidence_grounding");
  assert.equal(grounding?.score, 1);
  assert.equal(grounding?.applicable, false);
  assert.equal(grounding?.vacuous, true);

  const receipt = byId.get("receipt_coverage");
  assert.equal(receipt?.score, 1);
  assert.equal(receipt?.applicable, false);
  assert.equal(receipt?.vacuous, true);

  const independence = byId.get("source_independence");
  assert.equal(independence?.score, 1);
  assert.equal(independence?.applicable, false);
  assert.equal(independence?.vacuous, true);

  const earned = byId.get("model_call_efficiency");
  assert.equal(earned?.score, 1);
  assert.equal(earned?.applicable, true);
  assert.equal(earned?.vacuous, false);
});

test("a fully cited research mission is earned 1.0, not vacuous", () => {
  const card = scoreMissionV1({
    ...EMPTY_SET,
    acceptanceCriteriaTotal: 2,
    claimsRequiringEvidence: 4,
    claimsWithEvidence: 4,
    mutationsPerformed: 1,
    mutationsWithReceipts: 1,
    research: {
      usableSourceUrls: [
        "https://example.com/a",
        "https://example.org/b",
      ],
      requiredDistinctDomains: 2,
      claimsRequiringEvidence: 4,
      citedPassageCount: 4,
      quotedSpanCount: 1,
      sectionCount: 2,
    },
  });
  for (const id of [
    "evidence_grounding",
    "receipt_coverage",
    "source_independence",
    "research_depth",
  ] as const) {
    const dim = card.dimensions.find((item) => item.id === id);
    assert.equal(dim?.applicable, true, id);
    assert.equal(dim?.vacuous, false, id);
  }
  assert.equal(
    card.dimensions.find((item) => item.id === "evidence_grounding")?.score,
    1,
  );
});

test("normalize rejects a non-boolean vacuous flag and keeps additive vacuous on parse", () => {
  const card = scoreMissionV1(EMPTY_SET);
  const parsed = normalizeMissionScorecard(card);
  assert.ok(parsed);
  assert.equal(
    parsed.dimensions.find((item) => item.id === "evidence_grounding")?.vacuous,
    true,
  );

  const tampered = {
    ...card,
    dimensions: card.dimensions.map((item, index) =>
      index === 0 ? { ...item, vacuous: "yes" } : item,
    ),
  };
  assert.equal(normalizeMissionScorecard(tampered), null);
});

test("the committed baseline still parses, including an extra vacuous flag", () => {
  const manifest = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
    records: Array<{ scorecard: Record<string, unknown> }>;
  };
  const first = manifest.records[0];
  assert.ok(first, "baseline must contain at least one record");
  assert.equal(baselineRecordIsCurrent(first), true);

  const parsed = normalizeMissionScorecard(first.scorecard);
  assert.ok(parsed);
  const grounding = parsed.dimensions.find(
    (item) => item.id === "evidence_grounding",
  );
  assert.equal(grounding?.score, 1);
  assert.equal(grounding?.applicable, false);

  const withVacuous = {
    ...first,
    scorecard: {
      ...first.scorecard,
      dimensions: (
        first.scorecard.dimensions as Array<Record<string, unknown>>
      ).map((dimension) =>
        dimension.id === "evidence_grounding"
          ? { ...dimension, vacuous: true }
          : dimension,
      ),
    },
  };
  assert.equal(baselineRecordIsCurrent(withVacuous), true);
  const parsedVacuous = normalizeMissionScorecard(withVacuous.scorecard);
  assert.equal(
    parsedVacuous?.dimensions.find((item) => item.id === "evidence_grounding")
      ?.vacuous,
    true,
  );
});
