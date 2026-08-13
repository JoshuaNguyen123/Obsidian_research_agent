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

const coreIdentity = {
  project: "core-native",
  scenarioId: "CORE-01",
  file: "e2e/core-native.spec.ts",
  title: "CORE-01 creates relevant artifacts",
};

function coreRecord(overrides: Record<string, unknown> = {}) {
  return {
    ...coreIdentity,
    status: "passed",
    proofClass: "mission",
    observed: {
      artifacts: ["vault:transformer_brief"],
      proofs: ["model:production_call"],
      approvals: [],
      bindings: [],
      cleanup: [],
    },
    acceptanceStatus: "pass",
    fingerprint: `sha256:${"1".repeat(64)}`,
    missionScorecard: cleanScorecard(),
    ...overrides,
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

test("mission scorecard gate skips unscored guard records and compares scored ones", () => {
  // A research lane mixes a scored mission scenario with unscored guard tests
  // (scenarioId=null). The guard tests cannot be keyed and carry nothing to
  // regress, so they must be skipped rather than crash the comparison.
  const mixed = {
    version: 1,
    status: "passed",
    records: [
      { ...identity, missionScorecard: cleanScorecard() },
      {
        project: "daily-use-note",
        scenarioId: null,
        file: "e2e/daily-use-note.spec.ts",
        title: "an unscored guard test",
        missionScorecard: null,
      },
    ],
  };
  assert.deepEqual(
    assertMissionScorecardRegressions({
      summary: mixed,
      baseline: baseline(),
      selectedProjects: ["daily-use-note"],
    }),
    { checkedRecords: 1, skipped: false },
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

test("targeted unscored tests do not demand an unrelated project baseline", () => {
  assert.deepEqual(
    assertMissionScorecardRegressions({
      summary: {
        version: 1,
        status: "passed",
        records: [
          {
            project: identity.project,
            scenarioId: null,
            file: identity.file,
            title: "Agent settings expose an API slot",
            missionScorecard: null,
          },
        ],
      },
      baseline: baseline(),
      selectedProjects: [identity.project],
      executedTests: [
        {
          project: identity.project,
          file: "daily-use-note.spec.ts",
          title: "Agent settings expose an API slot",
        },
      ],
    }),
    { checkedRecords: 0, skipped: true },
  );
});

test("targeted scored tests still fail closed when their record is missing", () => {
  assert.throws(
    () =>
      assertMissionScorecardRegressions({
        summary: { ...summary(), records: [] },
        baseline: baseline(),
        selectedProjects: [identity.project],
        executedTests: [
          {
            project: identity.project,
            file: "daily-use-note.spec.ts",
            title: identity.title,
          },
        ],
      }),
    /required baseline record is missing/u,
  );
});

test("targeted scored test cannot borrow a sibling baseline from the same project", () => {
  const exact = {
    ...identity,
    scenarioId: "DU-01-B",
    title: "DU-01-B creates a second note",
  };
  assert.throws(
    () =>
      assertMissionScorecardRegressions({
        summary: {
          version: 1,
          status: "passed",
          records: [{ ...exact, missionScorecard: cleanScorecard() }],
        },
        baseline: baseline(),
        selectedProjects: [identity.project],
        executedTests: [
          {
            project: exact.project,
            file: "daily-use-note.spec.ts",
            title: exact.title,
          },
        ],
      }),
    /No exact mission-scorecard baseline exists/u,
  );
});

test("core-native proof gate rejects an unlabeled passing result", () => {
  const expected = {
    ...coreIdentity,
    key: missionScorecardRecordKey(coreIdentity),
    scorecard: cleanScorecard(),
  };
  assert.throws(
    () =>
      assertMissionScorecardRegressions({
        summary: {
          version: 1,
          status: "passed",
          records: [coreRecord({ proofClass: null })],
        },
        baseline: { version: 1, tolerance: 0.05, records: [expected] },
        selectedProjects: [coreIdentity.project],
      }),
    /missing e2e proof class/u,
  );
});

test("core-native mission proof requires atomic acceptance and a passing scorecard", () => {
  const expected = {
    ...coreIdentity,
    key: missionScorecardRecordKey(coreIdentity),
    scorecard: cleanScorecard(),
  };
  assert.throws(
    () =>
      assertMissionScorecardRegressions({
        summary: {
          version: 1,
          status: "passed",
          records: [
            coreRecord({
              acceptanceStatus: "needs_more_work",
              missionScorecard: null,
            }),
          ],
        },
        baseline: { version: 1, tolerance: 0.05, records: [expected] },
        selectedProjects: [coreIdentity.project],
      }),
    /no complete atomic acceptance|no passing runtime scorecard/u,
  );
});

test("core-native mission proof passes when classification and scorecard are complete", () => {
  const expected = {
    ...coreIdentity,
    key: missionScorecardRecordKey(coreIdentity),
    scorecard: cleanScorecard(),
  };
  assert.deepEqual(
    assertMissionScorecardRegressions({
      summary: {
        version: 1,
        status: "passed",
        records: [coreRecord()],
      },
      baseline: { version: 1, tolerance: 0.05, records: [expected] },
      selectedProjects: [coreIdentity.project],
    }),
    { checkedRecords: 1, skipped: false },
  );
});
