import assert from "node:assert/strict";
import test from "node:test";
import {
  MISSION_SCORE_WEIGHTS,
  formatMissionScorecard,
  mergeMissionScorecardObservationsV1,
  normalizeMissionScorecard,
  regressedAgainst,
  scoreMissionV1,
  type MissionScorecardInput,
} from "../src/agent/missionScorecard";

/** A run that met every criterion, cited everything, and stayed in budget. */
const CLEAN_PASS: MissionScorecardInput = {
  acceptanceCriteriaTotal: 5,
  acceptanceCriteriaMissing: 0,
  acceptancePassed: true,
  claimsRequiringEvidence: 10,
  claimsWithEvidence: 10,
  mutationsPerformed: 3,
  mutationsWithReceipts: 3,
  recoveryAttempts: 0,
  modelCalls: 20,
  modelCallBudget: 40,
  wallClockMs: 120_000,
  wallClockBudgetMs: 600_000,
};

test("a clean pass scores 1.0 across every dimension", () => {
  const card = scoreMissionV1(CLEAN_PASS);

  assert.equal(card.total, 1);
  assert.equal(card.acceptancePassed, true);
  for (const dimension of card.dimensions) {
    assert.equal(dimension.score, 1, `${dimension.id} should be 1`);
  }
});

test("a dimension with nothing to measure is excluded rather than banking a free 1", () => {
  // The live FLOW-REAL-01 shape: no claims needing citation and no web
  // research, so evidence_grounding (0.25), source_independence (0.05) and
  // research_depth (0.05) measured nothing — 35% of the weight.
  const card = scoreMissionV1({
    ...CLEAN_PASS,
    claimsRequiringEvidence: 0,
    claimsWithEvidence: 0,
    modelCalls: CLEAN_PASS.modelCallBudget * 3,
  });
  const byId = new Map(card.dimensions.map((item) => [item.id, item]));

  for (const id of ["evidence_grounding", "source_independence", "research_depth"] as const) {
    assert.equal(byId.get(id)?.applicable, false, id);
  }
  assert.equal(byId.get("receipt_coverage")?.applicable, true);

  // The wasteful model-call score must actually move the total. Under the old
  // empty-set convention the three unmeasured 1.0s diluted it by 35%.
  const measured = card.dimensions.filter((item) => item.applicable !== false);
  const weight = measured.reduce((sum, item) => sum + item.weight, 0);
  const expected =
    measured.reduce((sum, item) => sum + item.score * item.weight, 0) / weight;
  assert.ok(Math.abs(card.total - expected) < 1e-4, `total was ${card.total}`);
  assert.ok(card.total < 1, "an over-budget run must not total 1");
});

test("a read-only mission is graded only on what it could be graded on", () => {
  const card = scoreMissionV1({
    ...CLEAN_PASS,
    mutationsPerformed: 0,
    mutationsWithReceipts: 0,
  });
  const receipt = card.dimensions.find((item) => item.id === "receipt_coverage");
  assert.equal(receipt?.applicable, false);
  // Still not punished — excluded, not zeroed.
  assert.equal(card.total, 1);
});

test("inherited claims can be declared inapplicable to a non-research segment", () => {
  const card = scoreMissionV1({
    ...CLEAN_PASS,
    claimsRequiringEvidence: 31,
    claimsWithEvidence: 0,
    evidenceGroundingApplicable: false,
  });
  const grounding = card.dimensions.find(
    (item) => item.id === "evidence_grounding",
  );
  assert.equal(grounding?.score, 0);
  assert.equal(grounding?.applicable, false);
});

test("compound scorecards retain earlier research measurements across later non-research segments", () => {
  const research = scoreMissionV1({
    ...CLEAN_PASS,
    research: {
      usableSourceUrls: [
        "https://example.com/a",
        "https://example.org/b",
        "https://example.net/c",
        "https://example.edu/d",
      ],
      requiredDistinctDomains: 4,
      claimsRequiringEvidence: 10,
      citedPassageCount: 10,
      quotedSpanCount: 3,
      sectionCount: 4,
    },
  });
  const laterCode = scoreMissionV1({
    ...CLEAN_PASS,
    acceptancePassed: false,
    claimsRequiringEvidence: 31,
    claimsWithEvidence: 0,
    evidenceGroundingApplicable: false,
    mutationsPerformed: 10,
    mutationsWithReceipts: 9,
    modelCalls: 30,
  });

  const merged = mergeMissionScorecardObservationsV1(research, laterCode);
  const byId = new Map(merged.dimensions.map((item) => [item.id, item]));

  assert.equal(merged.acceptancePassed, false);
  assert.equal(byId.get("evidence_grounding")?.score, 1);
  assert.equal(byId.get("evidence_grounding")?.applicable, true);
  assert.equal(byId.get("source_independence")?.score, 1);
  assert.equal(byId.get("source_independence")?.applicable, true);
  assert.equal(byId.get("research_depth")?.score, 1);
  assert.equal(byId.get("research_depth")?.applicable, true);
  assert.equal(byId.get("receipt_coverage")?.score, 0.9);
  assert.equal(byId.get("model_call_efficiency")?.score, 1);
});

test("regression comparison skips a dimension either side could not measure", () => {
  // Baseline banked an unmeasured 1; the later run actually measured the
  // dimension and scored honestly below it. That is more work, not a
  // regression, and must not fail the gate.
  const baseline = scoreMissionV1({
    ...CLEAN_PASS,
    claimsRequiringEvidence: 0,
    claimsWithEvidence: 0,
  });
  const measured = scoreMissionV1({
    ...CLEAN_PASS,
    claimsRequiringEvidence: 10,
    claimsWithEvidence: 4,
  });
  assert.deepEqual(
    regressedAgainst(measured, baseline).map((item) => item.id),
    [],
  );
  // A genuine drop between two measured runs is still caught.
  assert.deepEqual(
    regressedAgainst(measured, scoreMissionV1(CLEAN_PASS)).map((item) => item.id),
    ["evidence_grounding"],
  );
});

test("a baseline written before applicability existed still parses as applicable", () => {
  const card = scoreMissionV1(CLEAN_PASS);
  const legacy = {
    ...card,
    dimensions: card.dimensions.map(({ applicable: _dropped, ...rest }) => rest),
  };
  const parsed = normalizeMissionScorecard(JSON.parse(JSON.stringify(legacy)));
  assert.ok(parsed);
  for (const dimension of parsed.dimensions) {
    assert.equal(dimension.applicable, true, dimension.id);
  }
  assert.equal(normalizeMissionScorecard({
    ...legacy,
    dimensions: legacy.dimensions.map((item, index) =>
      index === 0 ? { ...item, applicable: "yes" } : item,
    ),
  }), null);
});

test("dimension weights sum to 1", () => {
  const sum = Object.values(MISSION_SCORE_WEIGHTS).reduce(
    (total, weight) => total + weight,
    0,
  );
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights summed to ${sum}`);
});

test("the exact failure G4 describes: passing acceptance while burning 3x the calls scores lower", () => {
  const wasteful = scoreMissionV1({
    ...CLEAN_PASS,
    modelCalls: CLEAN_PASS.modelCallBudget * 3,
  });
  const clean = scoreMissionV1(CLEAN_PASS);

  // Both pass acceptance. Today they are indistinguishable.
  assert.equal(wasteful.acceptancePassed, true);
  assert.equal(clean.acceptancePassed, true);
  assert.ok(
    wasteful.total < clean.total,
    `wasteful ${wasteful.total} must score below clean ${clean.total}`,
  );

  const regressions = regressedAgainst(wasteful, clean);
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0]?.id, "model_call_efficiency");
  assert.ok(regressions[0]!.delta < 0);
});

test("citing half the evidence is caught even when acceptance passes", () => {
  const undercited = scoreMissionV1({
    ...CLEAN_PASS,
    claimsWithEvidence: 5,
  });

  assert.equal(undercited.acceptancePassed, true);
  const regressions = regressedAgainst(undercited, scoreMissionV1(CLEAN_PASS));
  assert.equal(regressions[0]?.id, "evidence_grounding");
  assert.equal(regressions[0]?.current, 0.5);
});

test("regressions are reported worst-first across several dimensions", () => {
  const degraded = scoreMissionV1({
    ...CLEAN_PASS,
    claimsWithEvidence: 2,
    mutationsWithReceipts: 2,
    recoveryAttempts: 3,
  });

  const regressions = regressedAgainst(degraded, scoreMissionV1(CLEAN_PASS));
  assert.equal(regressions.length, 3);
  assert.equal(regressions[0]?.id, "evidence_grounding");
  for (let index = 1; index < regressions.length; index += 1) {
    assert.ok(regressions[index]!.delta >= regressions[index - 1]!.delta);
  }
});

test("changes inside the tolerance band are not reported as regressions", () => {
  const slightlyWorse = scoreMissionV1({
    ...CLEAN_PASS,
    claimsRequiringEvidence: 100,
    claimsWithEvidence: 97,
  });

  assert.deepEqual(regressedAgainst(slightlyWorse, scoreMissionV1(CLEAN_PASS)), []);
  assert.equal(
    regressedAgainst(slightlyWorse, scoreMissionV1(CLEAN_PASS), 0.01).length,
    1,
  );
});

test("an improved run produces no regressions", () => {
  const baseline = scoreMissionV1({ ...CLEAN_PASS, recoveryAttempts: 4 });
  const improved = scoreMissionV1(CLEAN_PASS);

  assert.ok(improved.total > baseline.total);
  assert.deepEqual(regressedAgainst(improved, baseline), []);
});

test("a read-only mission is not punished for having nothing to receipt", () => {
  const readOnly = scoreMissionV1({
    ...CLEAN_PASS,
    mutationsPerformed: 0,
    mutationsWithReceipts: 0,
  });

  const receipts = readOnly.dimensions.find(
    (item) => item.id === "receipt_coverage",
  );
  assert.equal(receipts?.score, 1);
});

test("finishing early is not extra credit", () => {
  const fast = scoreMissionV1({ ...CLEAN_PASS, modelCalls: 1, wallClockMs: 1 });
  assert.equal(fast.total, 1);
});

test("recovery attempts decay smoothly rather than stepping to zero", () => {
  const scores = [0, 1, 3, 10].map(
    (attempts) =>
      scoreMissionV1({ ...CLEAN_PASS, recoveryAttempts: attempts }).dimensions.find(
        (item) => item.id === "recovery_cleanliness",
      )!.score,
  );

  assert.equal(scores[0], 1);
  assert.equal(scores[2], 0.5, "the half-life of 3 attempts should score 0.5");
  for (let index = 1; index < scores.length; index += 1) {
    assert.ok(scores[index]! < scores[index - 1]!);
    assert.ok(scores[index]! > 0);
  }
});

test("the scorecard never converts a failed acceptance into a pass", () => {
  const failedButEfficient = scoreMissionV1({
    ...CLEAN_PASS,
    acceptanceCriteriaMissing: 4,
    acceptancePassed: false,
  });

  assert.equal(failedButEfficient.acceptancePassed, false);
  assert.ok(failedButEfficient.total < 1);
});

test("degenerate inputs stay inside 0..1 instead of producing junk scores", () => {
  const degenerate = scoreMissionV1({
    acceptanceCriteriaTotal: 0,
    acceptanceCriteriaMissing: 5,
    acceptancePassed: false,
    claimsRequiringEvidence: 0,
    claimsWithEvidence: 7,
    mutationsPerformed: 2,
    mutationsWithReceipts: 9,
    recoveryAttempts: -3,
    modelCalls: 0,
    modelCallBudget: 0,
    wallClockMs: Number.NaN,
    wallClockBudgetMs: 0,
  });

  for (const dimension of degenerate.dimensions) {
    assert.ok(
      dimension.score >= 0 && dimension.score <= 1,
      `${dimension.id} escaped 0..1 with ${dimension.score}`,
    );
  }
  assert.ok(degenerate.total >= 0 && degenerate.total <= 1);
});

test("the projection is scannable and reports acceptance alongside the score", () => {
  const formatted = formatMissionScorecard(
    scoreMissionV1({ ...CLEAN_PASS, acceptancePassed: false }),
  );

  assert.match(formatted, /mission_score=1\.000 acceptance=needs_more_work/);
  assert.match(formatted, /- evidence_grounding: 1\.000 \(10\/10 claims cited\)/);
});
