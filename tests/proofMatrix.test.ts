import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CONSECUTIVE_HARNESS_FAILURES,
  attemptConsumesBudget,
  attemptLogExcerpt,
  classifyAttemptOutcome,
  consecutiveGreens,
  consecutiveHarnessFailures,
  consumedAttemptCount,
  harnessFailureCount,
  isEmptyScorecardHarvestOutput,
  isInfrastructureFailureClass,
  laneHasScorecardBaselineFrom,
  porcelainWithoutAllowedHarvest,
  registerProductFailure,
  type ProofMatrixAttempt,
  type ProofMatrixManifest,
} from "../scripts/run-proof-matrix.mjs";

function manifestWith(attempts: ProofMatrixAttempt[]): ProofMatrixManifest {
  return { attempts, productClassCounts: {} };
}

function green(cell: string): ProofMatrixAttempt {
  return { cell, green: true, failureClass: "none" };
}

function red(cell: string, failureClass: string): ProofMatrixAttempt {
  return { cell, green: false, failureClass };
}

test("scorecard baseline detection reads records[].project, not array indices", () => {
  const baseline = {
    version: 1,
    records: [
      { project: "daily-use-research", key: "daily-use-research|DU-02|spec|title" },
      { project: "compound-flow-real-live" },
    ],
  };
  assert.equal(laneHasScorecardBaselineFrom(baseline, "daily-use-research"), true);
  assert.equal(
    laneHasScorecardBaselineFrom(baseline, "compound-flow-real-live"),
    true,
  );
  assert.equal(laneHasScorecardBaselineFrom(baseline, "real-ai-soak"), false);
  assert.equal(laneHasScorecardBaselineFrom({ records: [] }, "daily-use-research"), false);
});

test("exact-HEAD cleanliness allows only the harvested scorecard baseline", () => {
  assert.equal(
    porcelainWithoutAllowedHarvest(
      " M e2e/baselines/mission-scorecards.v1.json\n",
    ),
    "",
  );
  assert.match(
    porcelainWithoutAllowedHarvest(
      " M e2e/baselines/mission-scorecards.v1.json\n M src/AgentRunner.ts\n",
    ),
    /src\/AgentRunner\.ts/u,
  );
});

test("an attempt that dies in the build stage is a harness failure, not matrix_unclassified", () => {
  // The 2026-08-25 02:37 crash loop: tsc -noEmit failed (exit 2) inside the
  // build stage, before Playwright ran, and was misfiled as
  // process:matrix_unclassified with no captured evidence.
  const logText = [
    "> agentic-researcher@0.4.0 build",
    "tests/proofMatrix.test.ts(7,8): error TS2307: Cannot find module '../scripts/run-proof-matrix.mjs'.",
    "build exited with code 2.",
  ].join("\n");
  const outcome = classifyAttemptOutcome({
    exitCode: 2,
    summary: null,
    summaryFresh: false,
    logText,
  });
  assert.equal(outcome.failureClass, "harness:build_failed");
  assert.match(outcome.detail, /error TS2307/u);
});

test("preflight refusals and lock timeouts get their own harness classes", () => {
  assert.equal(
    classifyAttemptOutcome({
      exitCode: 1,
      summaryFresh: false,
      logText: "Installed artifact is stale: agentic-researcher/main.js\ne2e preflight exited with code 1.\n",
    }).failureClass,
    "harness:preflight_refused",
  );
  // The 2026-08-25 03:06 crash loop: every attempt burned 30 seconds against
  // a held e2e lock and died unclassified.
  assert.equal(
    classifyAttemptOutcome({
      exitCode: 1,
      summaryFresh: false,
      logText:
        "Timed out after 30000 ms waiting for the exclusive Obsidian e2e lock. Owner PID 24444 on host, started now.",
    }).failureClass,
    "harness:e2e_lock_timeout",
  );
});

test("a stale run summary must not classify a later attempt", () => {
  const staleSummary = {
    records: [{ proofClass: "product:writeback_unproven" }],
  };
  // Fresh summary: the lane's own annotation wins.
  assert.equal(
    classifyAttemptOutcome({
      exitCode: 1,
      summary: staleSummary,
      summaryFresh: true,
      logText: "",
    }).failureClass,
    "product:writeback_unproven",
  );
  // Stale summary (left behind by an earlier run): ignored; the harness
  // signature in this attempt's own log wins instead.
  assert.equal(
    classifyAttemptOutcome({
      exitCode: 2,
      summary: staleSummary,
      summaryFresh: false,
      logText: "build exited with code 2.",
    }).failureClass,
    "harness:build_failed",
  );
});

test("green attempts classify as none and unknown reds stay matrix_unclassified", () => {
  assert.deepEqual(
    classifyAttemptOutcome({ exitCode: 0, summaryFresh: false, logText: "" }),
    { failureClass: "none", detail: "" },
  );
  const unknown = classifyAttemptOutcome({
    exitCode: 1,
    summaryFresh: false,
    logText: "something nobody anticipated\n",
  });
  assert.equal(unknown.failureClass, "process:matrix_unclassified");
  assert.match(unknown.detail, /something nobody anticipated/u);
});

test("attempt log excerpt keeps the lines around the failure and stays bounded", () => {
  const noise = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const text = `${noise}\nerror TS2322: boom\nbuild exited with code 2.\ntrailing noise after`;
  const index = text.indexOf("build exited");
  const excerpt = attemptLogExcerpt(text, index);
  assert.match(excerpt, /error TS2322: boom/u);
  assert.ok(excerpt.length <= 1_000);
  assert.doesNotMatch(excerpt, /trailing noise after/u);
  assert.equal(attemptLogExcerpt(""), "");
});

test("harness and process deaths are infrastructure; real reds are not", () => {
  assert.equal(isInfrastructureFailureClass("harness:build_failed"), true);
  assert.equal(isInfrastructureFailureClass("harness:e2e_lock_timeout"), true);
  assert.equal(isInfrastructureFailureClass("process:matrix_unclassified"), true);
  assert.equal(isInfrastructureFailureClass("product:writeback_unproven"), false);
  assert.equal(isInfrastructureFailureClass("model:refusal"), false);
  assert.equal(isInfrastructureFailureClass("external:linear_api_down"), false);
  assert.equal(isInfrastructureFailureClass("none"), false);
  assert.equal(isInfrastructureFailureClass(undefined), false);
  // A green attempt always consumes budget, whatever its class says.
  assert.equal(attemptConsumesBudget(green("cell")), true);
  assert.equal(attemptConsumesBudget(red("cell", "harness:build_failed")), false);
  assert.equal(attemptConsumesBudget(red("cell", "product:x")), true);
});

test("a harness failure spends no attempt, preserves the streak, and is counted separately", () => {
  // The 2026-08-25 10:33-10:35Z pattern: one bad commit produced four
  // harness:build_failed reds in 3 minutes and exhausted the cell's budget
  // without ever measuring the product.
  const manifest = manifestWith([
    green("research-current-note"),
    red("research-current-note", "harness:build_failed"),
    red("research-current-note", "process:matrix_unclassified"),
    green("research-current-note"),
  ]);
  assert.equal(consecutiveGreens(manifest, "research-current-note"), 2);
  assert.equal(consumedAttemptCount(manifest, "research-current-note"), 2);
  assert.equal(harnessFailureCount(manifest, "research-current-note"), 2);
  // Other cells are untouched.
  assert.equal(consumedAttemptCount(manifest, "vault-recall"), 0);
  assert.equal(harnessFailureCount(manifest, "vault-recall"), 0);
});

test("a real red still consumes an attempt and resets the streak", () => {
  const manifest = manifestWith([
    green("vault-recall"),
    red("vault-recall", "product:writeback_unproven"),
    red("vault-recall", "model:refusal"),
  ]);
  assert.equal(consecutiveGreens(manifest, "vault-recall"), 0);
  assert.equal(consumedAttemptCount(manifest, "vault-recall"), 3);
  assert.equal(harnessFailureCount(manifest, "vault-recall"), 0);
});

test("more than six consecutive harness failures aborts; recovery resets the run", () => {
  assert.equal(MAX_CONSECUTIVE_HARNESS_FAILURES, 6);
  const sixDeaths = Array.from({ length: 6 }, () =>
    red("code-delivery", "harness:build_failed"),
  );
  const atLimit = manifestWith(sixDeaths);
  assert.equal(consecutiveHarnessFailures(atLimit, "code-delivery"), 6);
  assert.ok(
    consecutiveHarnessFailures(atLimit, "code-delivery") <=
      MAX_CONSECUTIVE_HARNESS_FAILURES,
    "six consecutive harness failures must not abort yet",
  );
  const seventh = manifestWith([
    ...sixDeaths,
    red("code-delivery", "harness:e2e_lock_timeout"),
  ]);
  assert.ok(
    consecutiveHarnessFailures(seventh, "code-delivery") >
      MAX_CONSECUTIVE_HARNESS_FAILURES,
    "the seventh consecutive harness failure must trip the safety valve",
  );
  // A green (or real red) in between proves the harness recovered.
  const recovered = manifestWith([
    ...sixDeaths,
    green("code-delivery"),
    red("code-delivery", "harness:build_failed"),
  ]);
  assert.equal(consecutiveHarnessFailures(recovered, "code-delivery"), 1);
  // Consecutive is per cell: another cell's runs do not extend the streak.
  assert.equal(consecutiveHarnessFailures(seventh, "vault-recall"), 0);
});

test("two product sightings of the same class still abort the campaign", () => {
  const manifest = manifestWith([]);
  assert.equal(registerProductFailure(manifest, "product:writeback_unproven"), false);
  assert.equal(registerProductFailure(manifest, "product:tool_menu_drift"), false);
  assert.equal(registerProductFailure(manifest, "product:writeback_unproven"), true);
  assert.deepEqual(manifest.productClassCounts, {
    "product:writeback_unproven": 2,
    "product:tool_menu_drift": 1,
  });
  // Harness and model classes never feed the product alarm.
  assert.equal(registerProductFailure(manifest, "harness:build_failed"), false);
  assert.equal(registerProductFailure(manifest, "model:refusal"), false);
  assert.equal(Object.keys(manifest.productClassCounts).length, 2);
});

test("an empty scorecard harvest is not a matrix-stopping failure", () => {
  assert.equal(
    isEmptyScorecardHarvestOutput(
      "No passing, fully-scored mission records to harvest. A baseline built from a red or partial run would lower the bar it exists to hold.\n",
    ),
    true,
  );
  assert.equal(
    isEmptyScorecardHarvestOutput("updated  daily-use-research|DU-02|spec|title\n"),
    false,
  );
});
