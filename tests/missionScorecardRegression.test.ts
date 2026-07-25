import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMissionScorecardRegressions,
  missionScorecardRecordKey,
} from "../scripts/mission-scorecard-regression.mjs";
import {
  scoreMissionV1,
  type MissionScorecardV1,
} from "../src/agent/missionScorecard";

const identity = {
  project: "daily-use-note",
  scenarioId: "DU-01",
  file: "e2e/daily-use-note.spec.ts",
  title: "DU-01 creates a note",
};

function cleanScorecard(): MissionScorecardV1 {
  return scoreMissionV1({
    acceptanceCriteriaTotal: 4,
    acceptanceCriteriaMissing: 0,
    acceptancePassed: true,
    claimsRequiringEvidence: 0,
    claimsWithEvidence: 0,
    mutationsPerformed: 1,
    mutationsWithReceipts: 1,
    recoveryAttempts: 0,
    modelCalls: 1,
    modelCallBudget: 5,
    wallClockMs: 1_000,
    wallClockBudgetMs: 10_000,
  });
}

function withDimensionScore(
  scorecard: MissionScorecardV1,
  id: MissionScorecardV1["dimensions"][number]["id"],
  score: number,
): MissionScorecardV1 {
  const dimensions = scorecard.dimensions.map((dimension) =>
    dimension.id === id ? { ...dimension, score } : { ...dimension },
  );
  return {
    ...scorecard,
    dimensions,
    total: dimensions.reduce(
      (sum, dimension) => sum + dimension.score * dimension.weight,
      0,
    ),
  };
}

function baseline(scorecard = cleanScorecard()) {
  return {
    version: 1,
    tolerance: 0.05,
    records: [
      {
        ...identity,
        key: missionScorecardRecordKey(identity),
        scorecard,
      },
    ],
  };
}

function summary(scorecard: MissionScorecardV1 | null = cleanScorecard()) {
  return {
    version: 1,
    status: "passed",
    records: [{ ...identity, missionScorecard: scorecard }],
  };
}

test("mission scorecard gate passes an unchanged baselined record", () => {
  assert.deepEqual(
    assertMissionScorecardRegressions({
      summary: summary(),
      baseline: baseline(),
      selectedProjects: ["daily-use-note"],
    }),
    { checkedRecords: 1, skipped: false },
  );
});

test("mission scorecard gate allows a drop exactly at tolerance", () => {
  const current = withDimensionScore(
    cleanScorecard(),
    "model_call_efficiency",
    0.95,
  );
  assert.equal(
    assertMissionScorecardRegressions({
      summary: summary(current),
      baseline: baseline(),
      selectedProjects: ["daily-use-note"],
    }).checkedRecords,
    1,
  );
});

test("mission scorecard gate fails a dimension beyond tolerance", () => {
  const current = withDimensionScore(
    cleanScorecard(),
    "model_call_efficiency",
    0.9499,
  );
  assert.throws(
    () =>
      assertMissionScorecardRegressions({
        summary: summary(current),
        baseline: baseline(),
        selectedProjects: ["daily-use-note"],
      }),
    /model_call_efficiency regressed/u,
  );
});

test("mission scorecard gate fails closed on a missing card or record", () => {
  assert.throws(
    () =>
      assertMissionScorecardRegressions({
        summary: summary(null),
        baseline: baseline(),
        selectedProjects: ["daily-use-note"],
      }),
    /current scorecard/u,
  );
  assert.throws(
    () =>
      assertMissionScorecardRegressions({
        summary: { ...summary(), records: [] },
        baseline: baseline(),
        selectedProjects: ["daily-use-note"],
      }),
    /required baseline record is missing/u,
  );
});

test("mission scorecard gate skips projects with no committed baseline", () => {
  assert.deepEqual(
    assertMissionScorecardRegressions({
      summary: summary(),
      baseline: baseline(),
      selectedProjects: ["daily-use-research"],
    }),
    { checkedRecords: 0, skipped: true },
  );
});
