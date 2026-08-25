import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTEMPT_LOG_DIR,
  attemptLogExcerpt,
  classifyAttemptOutcome,
  isEmptyScorecardHarvestOutput,
  laneHasScorecardBaselineFrom,
  porcelainWithoutAllowedHarvest,
} from "../scripts/run-proof-matrix.mjs";

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

test("attempt logs live outside Playwright's wiped test-results directory", () => {
  const normalized = ATTEMPT_LOG_DIR.replaceAll("\\", "/");
  assert.match(normalized, /\/docs\/eval\/proof-matrix-logs$/u);
  assert.equal(normalized.includes("/test-results/"), false);
});
