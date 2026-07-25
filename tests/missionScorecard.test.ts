import assert from "node:assert/strict";
import test from "node:test";
import {
  MISSION_SCORE_WEIGHTS,
  formatMissionScorecard,
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
