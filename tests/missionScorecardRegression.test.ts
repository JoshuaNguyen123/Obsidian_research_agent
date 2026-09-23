import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MISSION_SCORECARD_BASELINE_PATH,
  NO_RUN_SUMMARY_SKIP_MESSAGE,
  assertMissionScorecardRegressions,
  assertMissionScorecardSummaryFile,
  formatMissionScorecardCliResult,
  missionScorecardCliExitCode,
  missionScorecardRecordKey,
  parseMissionScorecardCliArgs,
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

test("a lane that did not pass is excused from comparison and named in the result", () => {
  // `test-results/` is gitignored runtime residue that nothing cleans. Before
  // this branch existed, one failed e2e lane made every later `npm run test:ci`
  // on that machine die at this gate before a single unit test ran, reporting
  // the failed run as a structurally invalid scorecard. The lane's own exit
  // code is the failure signal; this gate measures scorecard regressions.
  const result = assertMissionScorecardRegressions({
    summary: {
      version: 1,
      status: "failed",
      records: [{ ...identity, status: "failed", missionScorecard: null }],
    },
    baseline: baseline(),
    selectedProjects: [identity.project],
  });
  assert.equal(result.skipped, false);
  assert.equal(result.checkedRecords, 0);
  assert.deepEqual(result.unscoredNonPassing, [
    `${missionScorecardRecordKey(identity)} (status=failed)`,
  ]);
  // Excused is not silent: the CLI line has to name the red lane.
  const line = formatMissionScorecardCliResult(result);
  assert.match(line, /NOT COMPARED/u);
  assert.match(line, /status=failed/u);
});

test("a PASSING record that dropped its scorecard is still fatal proof debt", () => {
  // The anti-gaming half of the pair above. Excusing non-passing records must
  // not open a door where a lane goes green while emitting nothing to score --
  // that is precisely the silent-weakening shape this gate exists to catch.
  assert.throws(
    () =>
      assertMissionScorecardRegressions({
        summary: {
          version: 1,
          status: "passed",
          records: [{ ...identity, status: "passed", missionScorecard: null }],
        },
        baseline: baseline(),
        selectedProjects: [identity.project],
      }),
    /current scorecard .* is invalid/u,
  );
});

test("a record with no status at all keeps the strict pre-existing behaviour", () => {
  // Absent status must not opt itself into the excuse: older summaries and
  // hand-written fixtures carry no status field, and they stay strict.
  assert.throws(
    () =>
      assertMissionScorecardRegressions({
        summary: {
          version: 1,
          status: "passed",
          records: [{ ...identity, missionScorecard: null }],
        },
        baseline: baseline(),
        selectedProjects: [identity.project],
      }),
    /current scorecard .* is invalid/u,
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

test("a baseline record harvested before `applicable` existed is rejected", () => {
  // Such a record asserts a hard 1.0 floor on dimensions that measured nothing
  // — "0/0 claims cited" scoring a perfect evidence_grounding — which is the
  // vacuous-perfect bug the field was added to close. It must invalidate the
  // whole manifest loudly and demand a fresh harvest, not read green forever.
  const stale = baseline();
  stale.records[0].scorecard = {
    ...stale.records[0].scorecard,
    dimensions: stale.records[0].scorecard.dimensions.map(
      ({ applicable: _dropped, ...rest }) => rest,
    ),
  };
  assert.throws(
    () =>
      assertMissionScorecardRegressions({
        summary: summary(),
        baseline: stale,
        selectedProjects: ["daily-use-note"],
      }),
    /invalid dimension/u,
  );
});

test("the committed baseline manifest carries `applicable` on every dimension", async () => {
  // The gate now runs in `npm run test:ci`, where there is no run summary to
  // compare against. Validating the committed manifest is what that CI run
  // actually checks, so this pins the file itself rather than only the parser.
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(
    await readFile(DEFAULT_MISSION_SCORECARD_BASELINE_PATH, "utf8"),
  ) as {
    records: Array<{
      project: string;
      scorecard: { dimensions: Array<{ applicable?: unknown }> };
    }>;
  };
  assert.ok(manifest.records.length > 0, "the baseline must not be empty");
  for (const record of manifest.records) {
    for (const dimension of record.scorecard.dimensions) {
      assert.equal(
        typeof dimension.applicable,
        "boolean",
        `${record.project} carries a dimension with no applicable flag`,
      );
    }
  }
});

test("empty selectedProjects compares every lane present in the summary", () => {
  assert.deepEqual(
    assertMissionScorecardRegressions({
      summary: summary(),
      baseline: baseline(),
      selectedProjects: [],
    }),
    { checkedRecords: 1, skipped: false },
    "no-args comparison uses the summary's lanes rather than skipping",
  );
});

test("missing run summary is a loud skip unless --require-summary is set", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "mission-scorecards-"));
  try {
    const baselinePath = path.join(dir, "baseline.json");
    const summaryPath = path.join(dir, "missing-summary.json");
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    const skipped = await assertMissionScorecardSummaryFile({
      baselinePath,
      summaryPath,
    });
    assert.deepEqual(skipped, {
      checkedRecords: 0,
      skipped: true,
      reason: "no_run_summary",
      validatedBaselineRecords: 1,
    });
    assert.equal(
      formatMissionScorecardCliResult(skipped),
      NO_RUN_SUMMARY_SKIP_MESSAGE,
    );
    assert.equal(
      NO_RUN_SUMMARY_SKIP_MESSAGE,
      "mission-scorecards: NO RUN SUMMARY — regression comparison skipped (baseline structure validated only)",
    );
  await assert.rejects(
    () =>
      assertMissionScorecardSummaryFile({
        baselinePath,
        summaryPath,
        requireSummary: true,
      }),
    /--require-summary requires a daily-use run summary/u,
  );
    const presentSummaryPath = path.join(dir, "present-summary.json");
    await writeFile(presentSummaryPath, JSON.stringify(summary()), "utf8");
    assert.deepEqual(
      await assertMissionScorecardSummaryFile({
        baselinePath,
        summaryPath: presentSummaryPath,
        selectedProjects: [],
      }),
      { checkedRecords: 1, skipped: false },
      "when a summary exists, no-args comparison uses the lanes in it",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scorecard CLI treats --require-summary as a fail-closed flag", () => {
  assert.deepEqual(parseMissionScorecardCliArgs([]), {
    requireSummary: false,
    baselineOnly: false,
    allowSkip: false,
  });
  assert.deepEqual(parseMissionScorecardCliArgs(["--require-summary"]), {
    requireSummary: true,
    baselineOnly: false,
    allowSkip: false,
  });
});

test("scorecard CLI does not exit 0 on a comparison that compared nothing", () => {
  // "skipped: no baselined records were selected" used to share exit 0 with
  // "passed", so every caller reading the exit code heard a pass.
  assert.equal(missionScorecardCliExitCode({ checkedRecords: 3, skipped: false }), 0);
  assert.equal(missionScorecardCliExitCode({ checkedRecords: 0, skipped: true }), 1);
  assert.equal(
    missionScorecardCliExitCode({ checkedRecords: 0, skipped: true, reason: "empty_baseline" }),
    1,
  );
  assert.equal(
    missionScorecardCliExitCode({ checkedRecords: 0, skipped: true, reason: "no_run_summary" }),
    1,
  );
  assert.equal(
    missionScorecardCliExitCode({ checkedRecords: 0, skipped: true }, { allowSkip: true }),
    0,
  );
  assert.equal(
    missionScorecardCliExitCode({ checkedRecords: 2, skipped: false, reason: "baseline_only" }),
    0,
  );
  assert.equal(parseMissionScorecardCliArgs(["--allow-skip"]).allowSkip, true);
});

test("baseline-only CLI validates structure and rejects conflicting runtime flags", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const script = "scripts/mission-scorecard-regression.mjs";
  const { stdout } = await exec(process.execPath, [script, "--baseline-only"], { windowsHide: true });
  assert.match(stdout, /baseline structure validated; no runtime comparison requested/u);
  await assert.rejects(exec(process.execPath, [script, "--baseline-only", "--require-summary"], { windowsHide: true }),
    /Baseline-only validation cannot substitute/u);
});
