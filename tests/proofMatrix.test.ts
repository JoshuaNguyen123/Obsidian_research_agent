import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PLAYWRIGHT_PROJECTS } from "../scripts/run-e2e-exclusive.mjs";
import {
  ATTEMPT_LOG_DIR,
  ACCEPTANCE_PROOF_MISSING_FAILURE_CLASS,
  CELLS,
  DEFAULT_PROOF_MATRIX_MODEL,
  PROOF_MATRIX_MODEL,
  CLASSIFICATION_CONFIRMED,
  CLASSIFICATION_MECHANICAL,
  CLASSIFICATION_UNCLASSIFIED,
  CELL_STATUS_DONE,
  CELL_STATUS_EXHAUSTED,
  CELL_STATUS_NOT_RUN,
  ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS,
  HARNESS_CLEANUP_FAILURE_CLASS,
  PROVIDER_QUOTA_EXHAUSTED_FAILURE_CLASS,
  SANDBOX_UNAVAILABLE_FAILURE_CLASS,
  detectLaneCleanupFailure,
  IN_FLIGHT_FAILURE_CLASS,
  LANE_ASSERTION_FAILURE_CLASS,
  BLOCKER_BUCKETS,
  cellStatusIsScored,
  cellStatusOf,
  detectMissingRequiredEnvironment,
  recordCellStatus,
  LEGACY_RUN_CSV_HEADER,
  RUN_CSV_HEADER,
  TOOL_EVENT_SOURCE_GRAPHS,
  TOOL_EVENT_SOURCE_NONE,
  TOOL_EVENT_SOURCE_SUMMARY,
  collectMechanicalFailureClasses,
  fileMtimeMs,
  resolveAttemptToolEvents,
  resolveCampaignAttemptVerdict,
  summaryToolEventTotals,
  summaryWrittenSince,
  summarizeAttemptAcceptance,
  upgradeRunCsvHeader,
  LEGACY_MANIFEST_RELATIVE_PATH,
  MAX_CONSECUTIVE_HARNESS_FAILURES,
  PROOF_MATRIX_ATTEMPT_LOG_RELATIVE_DIR,
  PROOF_MATRIX_MANIFEST_RELATIVE_PATH,
  PROOF_MATRIX_STATE_RELATIVE_DIR,
  RENDERER_DEATH_FAILURE_CLASS,
  attemptConsumesBudget,
  attemptLogExcerpt,
  attemptLogExcerptFrom,
  classifyAttemptOutcome,
  clearAttemptInFlight,
  consecutiveGreens,
  consecutiveHarnessFailures,
  consumedAttemptCount,
  harnessFailureCount,
  initializeAttemptLogFile,
  isEmptyScorecardHarvestOutput,
  isInfrastructureFailureClass,
  laneHasScorecardBaselineFrom,
  markAttemptInFlight,
  migrateLegacyManifestFile,
  normalizeGitCommandOutput,
  porcelainWithoutAllowedHarvest,
  reconcileInFlightAttempt,
  registerProductFailure,
  resolveProofMatrixModel,
  writeJsonAtomic,
  type ProofMatrixAttempt,
  type ProofMatrixManifest,
} from "../scripts/run-proof-matrix.mjs";
import { TOOL_REFUSAL_MARKER_BUCKETS } from "../e2e/reporters/dailyUseReporter";
import { composeMandatoryCleanupError } from "../e2e/fixtures/externalCleanup";

function manifestWith(attempts: ProofMatrixAttempt[]): ProofMatrixManifest {
  return { attempts, productClassCounts: {} };
}

function green(cell: string): ProofMatrixAttempt {
  return { cell, green: true, failureClass: "none" };
}

function red(cell: string, failureClass: string): ProofMatrixAttempt {
  return { cell, green: false, failureClass };
}

test("proof matrix model pin is explicit and rejects ambiguous tags", () => {
  assert.equal(DEFAULT_PROOF_MATRIX_MODEL, "deepseek-v4-pro");
  assert.equal(PROOF_MATRIX_MODEL, DEFAULT_PROOF_MATRIX_MODEL);
  assert.equal(
    resolveProofMatrixModel(["--model=glm-5.3-flash:cloud"]),
    "glm-5.3-flash:cloud",
  );
  assert.throws(
    () => resolveProofMatrixModel(["--model=glm-5.3:cloud", "--model=kimi-k3:cloud"]),
    /only once/u,
  );
  assert.throws(() => resolveProofMatrixModel(["--model="]), /bounded exact model tag/u);
});

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
  const rawPorcelain = " M e2e/baselines/mission-scorecards.v1.json\r\n";
  const preserved = normalizeGitCommandOutput(rawPorcelain, {
    preserveLeading: true,
  });
  assert.equal(preserved[0], " ", "porcelain column 1 must survive Git output normalization");
  assert.equal(
    porcelainWithoutAllowedHarvest(preserved),
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

test("a lost persisted resume-attempt row is a stable product alarm", () => {
  const logText = [
    "Error: product:resume_attempt_projection_lost — persisted continuation Chat history must retain the compact run-bound attempt row",
    "Error: expect(locator).toBeVisible() failed",
  ].join("\n");
  const classified = classifyAttemptOutcome({
    exitCode: 1,
    summary: { records: [{ status: "failed" }] },
    summaryFresh: true,
    logText,
  });
  assert.equal(classified.failureClass, "product:resume_attempt_projection_lost");
  assert.equal(classified.confidence, CLASSIFICATION_MECHANICAL);
  assert.deepEqual(classified.secondaryClasses, [LANE_ASSERTION_FAILURE_CLASS]);
});

test("an exhausted semantic-index helper timeout is a stable product alarm", () => {
  const logText = [
    "Error: page.evaluate: Error: product:semantic_index_setup_timeout — Production semantic index update failed: timeout: FastEmbed helper timed out after 180000ms.",
    "  1) [real-ai-soak] › e2e/real-ai-soak.spec.ts › VAULT-01",
  ].join("\n");
  const classified = classifyAttemptOutcome({
    exitCode: 1,
    summary: { records: [{ status: "failed" }] },
    summaryFresh: true,
    logText,
  });
  assert.equal(classified.failureClass, "product:semantic_index_setup_timeout");
  assert.equal(classified.confidence, CLASSIFICATION_MECHANICAL);
  assert.deepEqual(classified.secondaryClasses, [LANE_ASSERTION_FAILURE_CLASS]);
});

test("a circular final-projection hold is a stable product alarm", () => {
  const logText = [
    "Error: product:final_projection_candidate_rejected — Mission stopped before acceptance",
    'missing=["plan:final:final_relevance","verifier:final:final_relevance","mission_plan_incomplete"]',
    "  1) [compound-flow-real-live] › e2e/compound-flow-real-live.spec.ts › FLOW-REAL-01",
  ].join("\n");
  const classified = classifyAttemptOutcome({
    exitCode: 1,
    summary: { records: [{ status: "failed" }] },
    summaryFresh: true,
    logText,
  });
  assert.equal(
    classified.failureClass,
    "product:final_projection_candidate_rejected",
  );
  assert.equal(classified.confidence, CLASSIFICATION_MECHANICAL);
  assert.deepEqual(classified.secondaryClasses, [LANE_ASSERTION_FAILURE_CLASS]);
});

test("an empty sealed frontier with unpaid claim_grounding is a stable product alarm", () => {
  const logText = [
    "Error: Mission exceeded 4 explicit continuations; approved=1; state={",
    '"stopReason":"budget","autoContinueReason":"segment_cap",',
    '"acceptanceStatus":"needs_more_work",',
    '"missing":["verifier:claim_grounding:ungrounded:claim:s-ab110bbfee"],',
    '"diagnostics":[{"id":"mission-graph-tool-frontier-2","message":"MissionGraph frontier tools: none"}]',
    "}",
    "  1) [byok-autonomous-journey] › e2e/byok-autonomous-journey.spec.ts › BYOK-01",
  ].join("\n");
  const classified = classifyAttemptOutcome({
    exitCode: 1,
    summary: { records: [{ status: "failed" }] },
    summaryFresh: true,
    logText,
  });
  assert.equal(
    classified.failureClass,
    "product:sealed_frontier_emptied_citation_gather",
  );
  assert.equal(classified.confidence, CLASSIFICATION_MECHANICAL);
});

test("an executable citation-gather menu killed by the no-tool breaker is a stable product alarm", () => {
  const logText = [
    "Error: Mission stopped before acceptance; approved=1; summary={",
    '"recentDiagnostics":[{"id":"mission-graph-tool-frontier-9","message":"MissionGraph frontier tools: web_search, web_fetch, verify_citation, read_source_section"}]',
    "}; state={",
    '"stopDetail":"Blocked: the model twice returned no tool call against the same unchanged executable frontier.",',
    '"missing":["verifier:claim_grounding:ungrounded:claim:s-84f3b5f31d"],',
    "}",
    "  1) [byok-autonomous-journey] › e2e/byok-autonomous-journey.spec.ts › BYOK-01",
  ].join("\n");
  const classified = classifyAttemptOutcome({
    exitCode: 1,
    summary: { records: [{ status: "failed" }] },
    summaryFresh: true,
    logText,
  });
  assert.equal(
    classified.failureClass,
    "product:citation_gather_no_tool_breaker",
  );
  assert.equal(classified.confidence, CLASSIFICATION_MECHANICAL);
});

test("proof-matrix cell projects are exclusive-runner allowlisted", () => {
  // 2026-08-25: interrupted-continuation-live existed in playwright.config.ts
  // and package.json but not PLAYWRIGHT_PROJECTS, so four proof-matrix
  // attempts died in seconds as Unknown E2E project.
  assert.equal(CELLS.length, 6);
  for (const cell of CELLS) {
    assert.equal(
      PLAYWRIGHT_PROJECTS.has(cell.project),
      true,
      `${cell.id} project ${cell.project} is missing from PLAYWRIGHT_PROJECTS`,
    );
  }
});

test("every proof-matrix cell pins the exact acceptance scenario it must emit", () => {
  assert.deepEqual(
    CELLS.map(({ id, scenarioId }) => [id, scenarioId]),
    [
      ["research-current-note", "DU-02"],
      ["vault-recall", "VAULT-01"],
      ["code-delivery", "CODE-DELIVERY-01"],
      ["interrupted-continuation", "INTERRUPT-01"],
      ["notebook-execution", "NOTEBOOK-01"],
      ["compound-linear-github", "FLOW-REAL-01"],
    ],
  );
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
  assert.equal(
    classifyAttemptOutcome({
      exitCode: 1,
      summaryFresh: false,
      logText:
        "Unknown E2E project interrupted-continuation-live. Allowed projects: core-native, real-ai-soak.",
    }).failureClass,
    "harness:unknown_project",
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
    {
      failureClass: "none",
      detail: "",
      confidence: CLASSIFICATION_CONFIRMED,
      secondaryClasses: [],
    },
  );
  const unknown = classifyAttemptOutcome({
    exitCode: 1,
    summaryFresh: false,
    logText: "something nobody anticipated\n",
  });
  assert.equal(unknown.failureClass, "process:matrix_unclassified");
  assert.match(unknown.detail, /something nobody anticipated/u);
  assert.equal(unknown.confidence, CLASSIFICATION_UNCLASSIFIED);
  assert.deepEqual(unknown.secondaryClasses, []);
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

// ---------------------------------------------------------------------------
// Durable campaign state (2026-08-25 defect A): the manifest and attempt logs
// must live OUTSIDE test-results/, which Playwright wipes at attempt start.
// ---------------------------------------------------------------------------

test("durable state lives outside the Playwright-wiped tree", () => {
  assert.equal(PROOF_MATRIX_STATE_RELATIVE_DIR, "proof-matrix-state");
  assert.ok(
    PROOF_MATRIX_MANIFEST_RELATIVE_PATH.startsWith(`${PROOF_MATRIX_STATE_RELATIVE_DIR}/`),
    "manifest must live inside the durable state dir",
  );
  assert.ok(
    PROOF_MATRIX_ATTEMPT_LOG_RELATIVE_DIR.startsWith(`${PROOF_MATRIX_STATE_RELATIVE_DIR}/`),
    "attempt logs must live inside the durable state dir",
  );
  assert.doesNotMatch(PROOF_MATRIX_MANIFEST_RELATIVE_PATH, /test-results/u);
  assert.doesNotMatch(PROOF_MATRIX_ATTEMPT_LOG_RELATIVE_DIR, /test-results/u);
  // Backward compat: the migration source is exactly the old wiped location.
  assert.equal(LEGACY_MANIFEST_RELATIVE_PATH, "test-results/proof-matrix-manifest.json");
});

test("the durable state dir is gitignored (exact-HEAD clean checks must not see it)", () => {
  const gitignore = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".gitignore"),
    "utf8",
  );
  assert.match(gitignore, /^\/proof-matrix-state\/$/mu);
});

test("a new attempt truncates stale same-ordinal output before launch", () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, "logs", "vault-recall-attempt-1.log");
    writeJsonAtomic(target, { stale: "prior campaign looked green" });

    initializeAttemptLogFile(target, {
      campaignStartedAt: "2026-09-01T22:00:00.000Z",
      attemptStartedAt: "2026-09-01T22:00:01.000Z",
      expectedHead: "a".repeat(40),
      model: "glm-5.3-flash:cloud",
      cell: "vault-recall",
      project: "real-ai-soak",
      attempt: 1,
    });

    const current = readFileSync(target, "utf8");
    assert.doesNotMatch(current, /prior campaign looked green/u);
    assert.deepEqual(JSON.parse(current), {
      schema: "proof-matrix-attempt-log-v1",
      status: "in_flight",
      campaignStartedAt: "2026-09-01T22:00:00.000Z",
      attemptStartedAt: "2026-09-01T22:00:01.000Z",
      expectedHead: "a".repeat(40),
      model: "glm-5.3-flash:cloud",
      cell: "vault-recall",
      project: "real-ai-soak",
      attempt: 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the attempt loop claims its log before launch and appends child output", () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run-proof-matrix.mjs"),
    "utf8",
  );
  const claim = source.indexOf("initializeAttemptLogFile(attemptLogPath, {");
  const launch = source.indexOf("const result = spawnSync(process.execPath, runnerArgs", claim);
  const append = source.indexOf("appendFileSync(\n        attemptLogPath", launch);
  assert.ok(claim > 0, "the attempt must claim its durable log path");
  assert.ok(launch > claim, "the stale log must be truncated before the child launches");
  assert.ok(append > launch, "completed child output must append after the in-flight header");
});

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "proof-matrix-test-"));
}

test("writeJsonAtomic uses temp-then-rename and leaves no torn or temp files", () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, "nested", "manifest.json");
    writeJsonAtomic(target, { attempts: [1, 2, 3] });
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { attempts: [1, 2, 3] });
    // Overwrite must succeed via rename (Windows MOVEFILE_REPLACE_EXISTING).
    writeJsonAtomic(target, { attempts: [] });
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { attempts: [] });
    const residue = readdirSync(path.dirname(target)).filter((name) => name.includes(".tmp"));
    assert.deepEqual(residue, [], "no temp file may remain after a completed write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy manifest in test-results/ migrates once and never clobbers durable state", () => {
  const dir = tempDir();
  try {
    const legacyPath = path.join(dir, "test-results", "proof-matrix-manifest.json");
    const newPath = path.join(dir, "proof-matrix-state", "proof-matrix-manifest.json");
    // Nothing anywhere: no migration.
    assert.equal(migrateLegacyManifestFile(legacyPath, newPath), false);
    // Legacy exists, durable does not: migrate (copy) and report it.
    writeJsonAtomic(legacyPath, { expectedHead: "abc", attempts: [{ cell: "vault-recall" }] });
    assert.equal(migrateLegacyManifestFile(legacyPath, newPath), true);
    assert.deepEqual(JSON.parse(readFileSync(newPath, "utf8")), {
      expectedHead: "abc",
      attempts: [{ cell: "vault-recall" }],
    });
    // Durable now exists: a second call must not re-migrate or overwrite.
    writeFileSync(legacyPath, JSON.stringify({ expectedHead: "SHOULD-NOT-WIN" }));
    assert.equal(migrateLegacyManifestFile(legacyPath, newPath), false);
    assert.equal(JSON.parse(readFileSync(newPath, "utf8")).expectedHead, "abc");
    // A torn/unparseable legacy file migrates nothing.
    rmSync(newPath);
    writeFileSync(legacyPath, '{"expectedHead": "torn-mid-wri');
    assert.equal(migrateLegacyManifestFile(legacyPath, newPath), false);
    assert.equal(existsSync(newPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// In-flight attempt marker: persisted BEFORE launch so a mid-attempt runner
// death is visible and resumable instead of silently restarting from zero.
// ---------------------------------------------------------------------------

test("a mid-attempt death reconciles as a budget-exempt harness attempt on resume", () => {
  const manifest = manifestWith([
    green("vault-recall"),
    green("vault-recall"),
  ]);
  markAttemptInFlight(manifest, {
    cell: "vault-recall",
    project: "real-ai-soak",
    attempt: 3,
    startedAt: "2026-08-25T04:00:00.000Z",
  });
  assert.deepEqual(manifest.inFlight, {
    cell: "vault-recall",
    project: "real-ai-soak",
    attempt: 3,
    startedAt: "2026-08-25T04:00:00.000Z",
  });
  const reconciled = reconcileInFlightAttempt(manifest);
  assert.ok(reconciled);
  assert.equal(reconciled.cell, "vault-recall");
  assert.equal(reconciled.attempt, 3);
  assert.equal(reconciled.green, false);
  assert.equal(reconciled.failureClass, IN_FLIGHT_FAILURE_CLASS);
  assert.equal(reconciled.interrupted, true);
  assert.equal(manifest.inFlight, undefined, "marker must be cleared after reconciliation");
  // The death is infrastructure: it spends no budget and preserves the streak.
  assert.equal(isInfrastructureFailureClass(IN_FLIGHT_FAILURE_CLASS), true);
  assert.equal(attemptConsumesBudget(reconciled), false);
  assert.equal(consecutiveGreens(manifest, "vault-recall"), 2);
  assert.equal(consumedAttemptCount(manifest, "vault-recall"), 2);
  assert.equal(harnessFailureCount(manifest, "vault-recall"), 1);
  assert.deepEqual(manifest.harnessFailureCounts, { "vault-recall": 1 });
  // But it does feed the consecutive-harness safety valve.
  assert.equal(consecutiveHarnessFailures(manifest, "vault-recall"), 1);
});

test("reconciliation is a no-op without a marker and tolerates a malformed one", () => {
  const clean = manifestWith([green("code-delivery")]);
  assert.equal(reconcileInFlightAttempt(clean), null);
  assert.equal(clean.attempts.length, 1);
  const malformed = manifestWith([]);
  malformed.inFlight = { notACell: true };
  assert.equal(reconcileInFlightAttempt(malformed), null);
  assert.equal(malformed.inFlight, undefined, "malformed marker must still be cleared");
  assert.equal(malformed.attempts.length, 0);
  // clearAttemptInFlight is what a completed attempt calls.
  const finished = manifestWith([]);
  markAttemptInFlight(finished, { cell: "x", project: "p", attempt: 1, startedAt: null });
  clearAttemptInFlight(finished);
  assert.equal(finished.inFlight, undefined);
});

// ---------------------------------------------------------------------------
// Exit-1-without-summary classification (2026-08-25 defect B): parse the
// captured attempt log instead of giving up as process:matrix_unclassified.
// ---------------------------------------------------------------------------

test("a renderer/target-closed death classifies as harness:renderer_death", () => {
  const logText = [
    "Running 1 test using 1 worker",
    "  1) [real-ai-soak] › e2e/real-ai-soak.spec.ts:41:5 › deep vault retrieval ─────",
    "    Error: page.waitForSelector: Target page, context or browser has been closed",
    "        at e2e/real-ai-soak.spec.ts:58:20",
    "  1 failed",
  ].join("\n");
  const outcome = classifyAttemptOutcome({ exitCode: 1, summaryFresh: false, logText });
  assert.equal(outcome.failureClass, RENDERER_DEATH_FAILURE_CLASS);
  assert.equal(outcome.failureClass, "harness:renderer_death");
  assert.match(outcome.detail, /Target page, context or browser has been closed/u);
  // Renderer deaths are infrastructure — budget-exempt like other harness:*.
  assert.equal(isInfrastructureFailureClass(outcome.failureClass), true);
});

test("a lane assertion in the log classifies as lane_assertion_failed with the excerpt", () => {
  const logText = [
    "Running 1 test using 1 worker",
    "  1) [real-ai-soak] › e2e/real-ai-soak.spec.ts:41:5 › deep vault retrieval ─────",
    "    Error: expect(received).toContain(expected)",
    '    Expected substring: "semantic expansion"',
    '    Received string: "Mission stopped before acceptance"',
    "  1 failed",
  ].join("\n");
  const outcome = classifyAttemptOutcome({ exitCode: 1, summaryFresh: false, logText });
  assert.equal(outcome.failureClass, LANE_ASSERTION_FAILURE_CLASS);
  assert.equal(outcome.failureClass, "lane_assertion_failed");
  assert.match(outcome.detail, /expect\(received\)\.toContain/u);
  assert.match(outcome.detail, /Mission stopped before acceptance/u);
  // Deliberately NOT model:/product: (cannot be decided mechanically) and NOT
  // infrastructure: it consumes budget and resets the streak like a real red.
  assert.equal(isInfrastructureFailureClass(outcome.failureClass), false);
  assert.equal(
    attemptConsumesBudget(red("vault-recall", outcome.failureClass)),
    true,
  );
  assert.equal(registerProductFailure(manifestWith([]), outcome.failureClass), false);
});

test("test timeouts and bare failing-test headers also classify as lane_assertion_failed", () => {
  assert.equal(
    classifyAttemptOutcome({
      exitCode: 1,
      summaryFresh: false,
      logText: "  Test timeout of 600000ms exceeded.\n  1 failed\n",
    }).failureClass,
    LANE_ASSERTION_FAILURE_CLASS,
  );
  const headerOnly = classifyAttemptOutcome({
    exitCode: 1,
    summaryFresh: false,
    logText:
      "  1) [interrupted-continuation-live] › e2e/interrupted-continuation-live.spec.ts:92:3 › resumes ─\n" +
      "    Mission stopped before acceptance\n",
  });
  assert.equal(headerOnly.failureClass, LANE_ASSERTION_FAILURE_CLASS);
  assert.match(headerOnly.detail, /Mission stopped before acceptance/u);
});

test("pre-Playwright harness deaths keep their exact classification, whatever else the log holds", () => {
  // A build-stage death whose log ALSO happens to contain assertion-looking
  // text must still classify as the harness stage that actually died.
  const logText = [
    "tests/example.test.ts(1,1): error TS2345: Error: expect( mention in a compiler string",
    "build exited with code 2.",
  ].join("\n");
  const outcome = classifyAttemptOutcome({ exitCode: 2, summaryFresh: false, logText });
  assert.equal(outcome.failureClass, "harness:build_failed");
  // And a fresh run-summary proof class still outranks all log parsing.
  assert.equal(
    classifyAttemptOutcome({
      exitCode: 1,
      summary: { records: [{ proofClass: "product:writeback_unproven" }] },
      summaryFresh: true,
      logText: "Error: expect(received).toBe(expected)\nTarget closed\n",
    }).failureClass,
    "product:writeback_unproven",
  );
});

test("attemptLogExcerptFrom reads forward from the match and stays bounded", () => {
  const lines = [
    "noise before",
    "    Error: expect(received).toBe(expected)",
    "    Expected: 2",
    "    Received: 1",
    ...Array.from({ length: 30 }, (_, i) => `    trailing ${i}`),
  ];
  const text = lines.join("\n");
  const excerpt = attemptLogExcerptFrom(text, text.indexOf("Error: expect"));
  assert.match(excerpt, /Error: expect/u);
  assert.match(excerpt, /Received: 1/u);
  assert.doesNotMatch(excerpt, /noise before/u);
  assert.ok(excerpt.length <= 1_000);
  assert.equal(attemptLogExcerptFrom(""), "");
});

// ---------------------------------------------------------------------------
// Success/uncertainty wave (2026-08-25): appended CSV columns, tool-event
// source precedence, unknown-vs-zero, secondary classes, and confidence.
// ---------------------------------------------------------------------------

test("new CSV columns are APPENDED - the legacy header survives as an exact prefix", () => {
  // Readers index existing columns by position/name; reordering would corrupt
  // every one of them. The new schema must start with the old one, verbatim.
  assert.ok(
    RUN_CSV_HEADER.startsWith(`${LEGACY_RUN_CSV_HEADER},`),
    "legacy header must be an exact comma-prefix of the new header",
  );
  const appended = RUN_CSV_HEADER.slice(LEGACY_RUN_CSV_HEADER.length + 1).split(",");
  assert.deepEqual(appended, [
    "tool_events_source",
    "tool_calls_succeeded",
    "pct_tool_calls_succeeded",
    "secondary_failure_classes",
    "classification_confidence",
    "tool_calls_vacuous",
    // Host-caused off-frontier refusals, split out of tool_not_allowed. They
    // are appended rather than placed beside the other bucket columns
    // precisely because of the rule this test guards.
    "frontier_narrowed_mid_response",
    "frontier_withheld_since_earlier_step",
    "harness_outcome",
    "acceptance_status",
    "scorecard_total",
    "scorecard_acceptance_passed",
    "retries",
    "artifact_proof_count",
    "cleanup_proof_count",
    // Cost/latency instruments (2026-09-03), blank when a lane did not
    // annotate them.
    "model_calls",
    "reported_tokens",
    "cached_prompt_tokens",
    "prompt_prefix_reuse_avg",
  ]);
});

test("the proof matrix and the reporter share one refusal-bucket vocabulary", () => {
  // Two hand-kept copies of the same bucket list is this repo's recurring
  // failure shape: they drift, and graph-mined rows stop being comparable
  // with summary-sourced rows in the same CSV.
  assert.deepEqual(
    BLOCKER_BUCKETS.map(([key]) => key),
    TOOL_REFUSAL_MARKER_BUCKETS.map(([key]) => key),
  );
  // Every bucket key must also have a column to land in, or a counted
  // refusal is silently dropped on the way to the CSV.
  for (const [key] of BLOCKER_BUCKETS) {
    assert.ok(
      RUN_CSV_HEADER.split(",").includes(key),
      `refusal bucket ${key} has no CSV column`,
    );
  }
});

test("every refusal bucket matches exactly one code - no double counting", () => {
  // The buckets are matched by substring against the same text. If any new
  // code contained "tool_not_allowed" (or each other), a single refusal would
  // be counted in two buckets and the split would be worthless.
  for (const [key] of BLOCKER_BUCKETS) {
    const matching = BLOCKER_BUCKETS.filter(([, pattern]) =>
      pattern.test(key),
    ).map(([matched]) => matched);
    assert.deepEqual(
      matching,
      [key],
      `refusal code ${key} lands in more than one bucket`,
    );
  }
});

test("upgradeRunCsvHeader rewrites only a legacy header line and never touches rows", () => {
  const rows =
    "2026-08-23T19:26:25Z,byok-autonomous-journey,deepseek-v4-pro,8e934f9,1286,red,product:x,,,,,,,,,2,,playwright_error_payload,notes\n" +
    '2026-08-24T00:35:00Z,lane,"model, with comma",abc1234,10,green,none,,47,45,95.7,1,44,0,0,0,0,src,"quoted ""notes"""\n';
  const legacyText = `${LEGACY_RUN_CSV_HEADER}\n${rows}`;
  const upgraded = upgradeRunCsvHeader(legacyText);
  assert.ok(upgraded);
  assert.ok(upgraded.startsWith(`${RUN_CSV_HEADER}\n`));
  // Old rows stay byte-for-byte identical (shorter than the header - readers
  // must treat the missing trailing cells as blank/unknown).
  assert.equal(upgraded.slice(RUN_CSV_HEADER.length + 1), rows);
  // Already-current headers and unrecognized files are left alone.
  assert.equal(upgradeRunCsvHeader(`${RUN_CSV_HEADER}\n${rows}`), null);
  assert.equal(upgradeRunCsvHeader("some,other,csv\n1,2,3\n"), null);
  assert.equal(upgradeRunCsvHeader(""), null);
  // A header-only legacy file still upgrades.
  assert.equal(upgradeRunCsvHeader(`${LEGACY_RUN_CSV_HEADER}\n`), `${RUN_CSV_HEADER}\n`);
});

test("a fresh run summary outranks graph mining as the tool-event source", () => {
  const summary = {
    records: [
      { toolCalls: 40, toolCallsFailed: 3, toolCallsVacuous: 1 },
      { toolCalls: 3, toolCallsFailed: 0, toolCallsVacuous: 0 },
    ],
  };
  const minedCounts = { observed: 12, failed: 2, buckets: { tool_not_allowed: 2 } };
  const events = resolveAttemptToolEvents({ summary, summaryFresh: true, minedCounts });
  assert.equal(events.source, TOOL_EVENT_SOURCE_SUMMARY);
  assert.equal(events.observed, 43);
  assert.equal(events.failed, 3);
  assert.equal(events.vacuous, 1);
  // Succeeded excludes BOTH failed and (known) vacuous calls.
  assert.equal(events.succeeded, 39);
  // A stale summary must never label a later attempt: graphs win instead.
  const stale = resolveAttemptToolEvents({ summary, summaryFresh: false, minedCounts });
  assert.equal(stale.source, TOOL_EVENT_SOURCE_GRAPHS);
  assert.equal(stale.observed, 12);
  assert.equal(stale.failed, 2);
  assert.equal(stale.succeeded, 10);
  // Graph nodes carry no receipts, so graphs can never claim a vacuous count.
  assert.equal(stale.vacuous, null);
});

test("fresh summaries preserve bounded failed-call identity after graph cleanup", () => {
  const detail = {
    id: "2:1:read_current_file",
    toolName: "read_current_file",
    errorCode: null,
    bucket: "other",
  };
  const summary = {
    records: [
      {
        toolCallsAttempted: 6,
        toolCallsFailed: 1,
        toolCallOutcomes: {
          failureDetails: [detail],
          failureDetailsTruncated: false,
        },
      },
    ],
  };
  const totals = summaryToolEventTotals(summary);
  assert.deepEqual(totals?.failureDetails, [detail]);
  assert.equal(totals?.failureDetailsTruncated, false);

  const events = resolveAttemptToolEvents({
    summary,
    summaryFresh: true,
    minedCounts: { observed: 0, failed: 0, buckets: null },
  });
  assert.deepEqual(events.failureDetails, [detail]);
  assert.equal(events.failureDetailsTruncated, false);

  const stale = resolveAttemptToolEvents({
    summary,
    summaryFresh: false,
    minedCounts: { observed: 2, failed: 1, buckets: { execution_failed: 1 } },
  });
  assert.equal(stale.failureDetails, null, "graphs cannot recover per-call failure identity");
  assert.equal(stale.failureDetailsTruncated, null);
});

test("unknown is never collapsed into zero: explicit summary zeros vs no source at all", () => {
  // A fresh summary that SAID zero is an explicit zero.
  const zeroSummary = {
    records: [{ toolCalls: 0, toolCallsFailed: 0, toolCallsVacuous: 0 }],
  };
  const explicitZero = resolveAttemptToolEvents({
    summary: zeroSummary,
    summaryFresh: true,
    minedCounts: { observed: 0, failed: 0, buckets: null },
  });
  assert.equal(explicitZero.source, TOOL_EVENT_SOURCE_SUMMARY);
  assert.equal(explicitZero.observed, 0);
  assert.equal(explicitZero.failed, 0);
  assert.equal(explicitZero.succeeded, 0);
  // No summary and an empty mine: green lanes DELETE their run-owned graphs,
  // so zero mined events is absence of evidence, not evidence of zero.
  const nothing = resolveAttemptToolEvents({
    summary: null,
    summaryFresh: false,
    minedCounts: { observed: 0, failed: 0, buckets: null },
  });
  assert.equal(nothing.source, TOOL_EVENT_SOURCE_NONE);
  assert.equal(nothing.observed, null);
  assert.equal(nothing.failed, null);
  assert.equal(nothing.vacuous, null);
  assert.equal(nothing.succeeded, null);
  assert.equal(nothing.buckets, null);
});

test("a summary that counts calls but not failures reports observed with failed unknown", () => {
  // Today's specs feed toolCalls from missionEvidence lengths (successful
  // calls only) and cannot distinguish failures: toolCallsFailed is null.
  const summary = { records: [{ toolCalls: 43, toolCallsFailed: null }] };
  const events = resolveAttemptToolEvents({
    summary,
    summaryFresh: true,
    minedCounts: { observed: 0, failed: 0, buckets: null },
  });
  assert.equal(events.source, TOOL_EVENT_SOURCE_SUMMARY);
  assert.equal(events.observed, 43);
  assert.equal(events.failed, null);
  assert.equal(events.succeeded, null, "succeeded must stay unknown when failed is unknown");
  assert.equal(events.vacuous, null);
});

test("summaryToolEventTotals sums refusal buckets and keeps partial knowledge a lower bound", () => {
  const totals = summaryToolEventTotals({
    records: [
      {
        toolCalls: 10,
        toolCallsFailed: 2,
        refusalBuckets: { mission_graph_authority_blocked: 2, bogus_bucket: 9 },
      },
      { toolCalls: 5, toolCallsFailed: null, refusalBuckets: null },
      { toolCalls: 1, toolCallsFailed: 1, refusalBuckets: { tool_not_allowed: 1 } },
    ],
  });
  assert.ok(totals);
  assert.equal(totals.observed, 16);
  // 2 + (unknown, skipped) + 1: a lower bound, not a fake zero for record 2.
  assert.equal(totals.failed, 3);
  assert.equal(totals.vacuous, null, "no record knew vacuous - the total is unknown");
  assert.ok(totals.buckets, "two records contributed vocabulary keys");
  assert.equal(totals.buckets!.mission_graph_authority_blocked, 2);
  assert.equal(totals.buckets!.tool_not_allowed, 1);
  assert.equal("bogus_bucket" in totals.buckets!, false, "unknown bucket keys are dropped");
  // No records: nothing to speak for the attempt.
  assert.equal(summaryToolEventTotals({ records: [] }), null);
  assert.equal(summaryToolEventTotals(null), null);
});

test("mission acceptance remains separate from the Playwright harness outcome", () => {
  const accepted = summarizeAttemptAcceptance({
    summaries: [{
      acceptanceStatus: "pass",
      retries: 2,
      artifactProofCount: 4,
      cleanupProofCount: 1,
      missionScorecard: { total: 0.96, acceptancePassed: true },
    }],
  }, true);
  assert.equal(accepted.missionOutcome, "accepted");
  assert.equal(accepted.acceptanceStatus, "pass");
  assert.equal(accepted.scorecardTotal, 0.96);
  assert.equal(accepted.scorecardAcceptancePassed, true);
  assert.equal(accepted.retries, 2);
  assert.equal(accepted.artifactProofCount, 4);
  assert.equal(accepted.cleanupProofCount, 1);

  assert.equal(
    summarizeAttemptAcceptance({ summaries: [] }, true).missionOutcome,
    "unknown",
  );
  assert.equal(
    summarizeAttemptAcceptance({ summaries: [{ acceptanceStatus: "pass" }] }, false)
      .missionOutcome,
    "unknown",
  );
  const crossScenario = {
    summaries: [
      {
        scenarioId: "DU-02",
        acceptanceStatus: "pass",
        missionScorecard: { total: 0.98, acceptancePassed: true },
      },
      {
        scenarioId: "VAULT-01",
        acceptanceStatus: "needs_more_work",
        missionScorecard: null,
      },
    ],
  };
  assert.equal(
    summarizeAttemptAcceptance(crossScenario, true, "VAULT-01").missionOutcome,
    "needs_more_work",
    "another scenario's passing scorecard must not satisfy this cell",
  );
  assert.equal(
    summarizeAttemptAcceptance(crossScenario, true, "NOTEBOOK-01").missionOutcome,
    "unknown",
    "a missing expected scenario stays explicit",
  );
});

test("a green Playwright exit without accepted scorecard proof fails fast as harness evidence debt", () => {
  const verdict = resolveCampaignAttemptVerdict({
    green: true,
    failureClass: "none",
    failureDetail: "",
    confidence: "confirmed",
    secondaryClasses: [],
    acceptance: summarizeAttemptAcceptance(
      {
        summaries: [
          {
            acceptanceStatus: "needs_more_work",
            missionScorecard: null,
          },
        ],
      },
      true,
    ),
  });
  assert.equal(verdict.green, false);
  assert.equal(verdict.failureClass, ACCEPTANCE_PROOF_MISSING_FAILURE_CLASS);
  assert.match(verdict.failureDetail, /accepted mission and scorecard proof/u);
  assert.ok(isInfrastructureFailureClass(verdict.failureClass));
  assert.equal(attemptConsumesBudget(verdict), false);

  const accepted = resolveCampaignAttemptVerdict({
    green: true,
    failureClass: "none",
    failureDetail: "",
    confidence: "confirmed",
    secondaryClasses: [],
    acceptance: summarizeAttemptAcceptance(
      {
        summaries: [
          {
            acceptanceStatus: "pass",
            missionScorecard: { total: 0.95, acceptancePassed: true },
          },
        ],
      },
      true,
    ),
  });
  assert.equal(accepted.green, true);
  assert.equal(accepted.failureClass, "none");
});

test("secondary failure classes surface every co-matching signature without stealing the primary", () => {
  // A build death whose log ALSO carries assertion text: primary stays the
  // harness stage (existing precedence), the assertion becomes secondary DATA.
  const logText = [
    "Error: expect(received).toBe(expected)",
    "tests/example.test.ts(1,1): error TS2345: boom",
    "build exited with code 2.",
  ].join("\n");
  const outcome = classifyAttemptOutcome({ exitCode: 2, summaryFresh: false, logText });
  assert.equal(outcome.failureClass, "harness:build_failed");
  assert.deepEqual(outcome.secondaryClasses, [LANE_ASSERTION_FAILURE_CLASS]);
  // A renderer death inside a failing lane co-matches the lane's own
  // failing-test header - both causes stay visible.
  const rendererLog = [
    "  1) [real-ai-soak] › e2e/real-ai-soak.spec.ts:41:5 › deep vault retrieval ─────",
    "    Error: page.waitForSelector: Target page, context or browser has been closed",
  ].join("\n");
  const renderer = classifyAttemptOutcome({ exitCode: 1, summaryFresh: false, logText: rendererLog });
  assert.equal(renderer.failureClass, RENDERER_DEATH_FAILURE_CLASS);
  assert.deepEqual(renderer.secondaryClasses, [LANE_ASSERTION_FAILURE_CLASS]);
  // A fresh summary primary keeps mechanically-matched log classes as secondaries.
  const confirmed = classifyAttemptOutcome({
    exitCode: 1,
    summary: { records: [{ proofClass: "product:writeback_unproven" }] },
    summaryFresh: true,
    logText: rendererLog,
  });
  assert.equal(confirmed.failureClass, "product:writeback_unproven");
  assert.deepEqual(confirmed.secondaryClasses, [
    RENDERER_DEATH_FAILURE_CLASS,
    LANE_ASSERTION_FAILURE_CLASS,
  ]);
  // collectMechanicalFailureClasses is deduplicated and ordered by precedence.
  assert.deepEqual(collectMechanicalFailureClasses(rendererLog), [
    RENDERER_DEATH_FAILURE_CLASS,
    LANE_ASSERTION_FAILURE_CLASS,
  ]);
  assert.deepEqual(collectMechanicalFailureClasses(""), []);
});

test("classification confidence: confirmed from summaries, mechanical from logs, unclassified otherwise", () => {
  assert.equal(
    classifyAttemptOutcome({
      exitCode: 1,
      summary: { records: [{ proofClass: "product:writeback_unproven" }] },
      summaryFresh: true,
      logText: "",
    }).confidence,
    CLASSIFICATION_CONFIRMED,
  );
  assert.equal(
    classifyAttemptOutcome({
      exitCode: 2,
      summaryFresh: false,
      logText: "build exited with code 2.",
    }).confidence,
    CLASSIFICATION_MECHANICAL,
  );
  assert.equal(
    classifyAttemptOutcome({
      exitCode: 1,
      summaryFresh: false,
      logText: "Test timeout of 600000ms exceeded.",
    }).confidence,
    CLASSIFICATION_MECHANICAL,
  );
  assert.equal(
    classifyAttemptOutcome({
      exitCode: 1,
      summaryFresh: false,
      logText: "nothing recognizable",
    }).confidence,
    CLASSIFICATION_UNCLASSIFIED,
  );
});

// ---------------------------------------------------------------------------
// environment_not_configured — a run that never happened must never be scored
// ---------------------------------------------------------------------------

/**
 * Verbatim shape of the 2026-08-26 08:49 attempt log: the lane threw at
 * compound-flow-real-live.spec.ts:116 because LINEAR_LIVE_TEST_TEAM_ID was
 * absent from the process environment, and Playwright still printed a numbered
 * failing-test header — which is exactly why the matrix filed all five
 * attempts as `lane_assertion_failed` and reported "streak 0/3".
 */
const MISSING_ENV_ATTEMPT_LOG = [
  "Running 1 test using 1 worker",
  "  1) [compound-flow-real-live] › e2e/compound-flow-real-live.spec.ts:98:3 › compound Linear + GitHub flow ─",
  "",
  "    Error: compound-flow-real-live is missing required environment LINEAR_LIVE_TEST_TEAM_ID. It mutates a real Linear workspace, so the target team must be named explicitly.",
  "",
  "      at requiredEnvironment (e2e/compound-flow-real-live.spec.ts:1984:11)",
  "      at e2e/compound-flow-real-live.spec.ts:116:18",
  "",
  "  1 failed",
].join("\n");

test("an absent required environment variable is NOT a lane assertion failure", () => {
  const outcome = classifyAttemptOutcome({
    exitCode: 1,
    summaryFresh: false,
    logText: MISSING_ENV_ATTEMPT_LOG,
  });
  // The whole point: this log used to land in the same bucket as a genuine
  // product failure.
  assert.notEqual(outcome.failureClass, LANE_ASSERTION_FAILURE_CLASS);
  assert.equal(outcome.failureClass, ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS);
  assert.equal(outcome.failureClass, "environment_not_configured");
  assert.deepEqual(outcome.missingEnvironment, ["LINEAR_LIVE_TEST_TEAM_ID"]);
  // The lane named the variable itself — that is a fact, not a mechanical guess.
  assert.equal(outcome.confidence, CLASSIFICATION_CONFIRMED);
  // The operator must be able to read the variable straight out of the detail.
  assert.match(outcome.detail, /LINEAR_LIVE_TEST_TEAM_ID/u);
  // The log DOES match the lane-assertion patterns; carrying that as a
  // secondary class would smuggle the same lie into another column.
  assert.deepEqual(outcome.secondaryClasses, []);
});

test("an absent required environment variable spends no attempt budget and moves no streak", () => {
  const outcome = classifyAttemptOutcome({
    exitCode: 1,
    summaryFresh: false,
    logText: MISSING_ENV_ATTEMPT_LOG,
  });
  const attempt = red("compound-linear-github", outcome.failureClass);
  // Budget: a misconfiguration is not evidence about the product.
  assert.equal(isInfrastructureFailureClass(outcome.failureClass), true);
  assert.equal(attemptConsumesBudget(attempt), false);
  // Streak: five of these in a row must not turn a 2-green cell into 0/3.
  const manifest = manifestWith([
    green("compound-linear-github"),
    green("compound-linear-github"),
    attempt,
    attempt,
    attempt,
    attempt,
    attempt,
  ]);
  assert.equal(consecutiveGreens(manifest, "compound-linear-github"), 2);
  assert.equal(consumedAttemptCount(manifest, "compound-linear-github"), 2);
  // And it is never a regression alarm either — it is not a product class.
  assert.equal(registerProductFailure(manifestWith([]), outcome.failureClass), false);
});

test("required-environment detection keys on the shared guard contract, across every spec that speaks it", () => {
  // e2e/compound-flow-real-live.spec.ts and e2e/daily-use-compound.spec.ts
  assert.deepEqual(
    detectMissingRequiredEnvironment(
      "Error: Protected DU-06 is missing required environment E2E_RELEASE_COMMIT_SHA.",
    ),
    ["E2E_RELEASE_COMMIT_SHA"],
  );
  // e2e/obsidian-hello-github-live.spec.ts (unified onto the same sentence)
  assert.deepEqual(
    detectMissingRequiredEnvironment(
      "Error: OBS-HELLO is missing required environment E2E_GITHUB_TOKEN.",
    ),
    ["E2E_GITHUB_TOKEN"],
  );
  // e2e/disposable-live-external.spec.ts — env guard and secret guard
  assert.deepEqual(
    detectMissingRequiredEnvironment(
      "Error: E2E_LIVE_PROVIDER is required and must be bounded; no external mutation was attempted.",
    ),
    ["E2E_LIVE_PROVIDER"],
  );
  assert.deepEqual(
    detectMissingRequiredEnvironment(
      "Error: E2E_GITHUB_TOKEN is missing or invalid; no external mutation was attempted.",
    ),
    ["E2E_GITHUB_TOKEN"],
  );
  // Several absent variables in one log: all named, first-seen order, deduped.
  assert.deepEqual(
    detectMissingRequiredEnvironment(
      [
        "Error: compound-flow-real-live is missing required environment LINEAR_LIVE_TEST_TEAM_ID.",
        "Error: compound-flow-real-live is missing required environment LINEAR_LIVE_TEST_PROJECT_ID.",
        "Error: compound-flow-real-live is missing required environment LINEAR_LIVE_TEST_TEAM_ID.",
      ].join("\n"),
    ),
    ["LINEAR_LIVE_TEST_TEAM_ID", "LINEAR_LIVE_TEST_PROJECT_ID"],
  );
});

test("product assertions that merely mention missing environments stay lane_assertion_failed", () => {
  // Every one of these is a REAL red whose text brushes against the words
  // "missing" / "environment" / "required". None may be excused as a
  // misconfiguration: that would silently forgive product failures.
  const productReds = [
    [
      "  1) [daily-use-research] › e2e/daily-use-research.spec.ts:41:5 › DU-02 sourced writeback ─",
      "    Error: expect(received).toContain(expected)",
      '    Expected substring: "semantic expansion"',
      '    Received string: "Mission stopped: the environment is missing a required note"',
      "  1 failed",
    ].join("\n"),
    [
      "  1) [compound-flow-real-live] › e2e/compound-flow-real-live.spec.ts:98:3 › compound flow ─",
      "    Error: expect(received).toBe(expected)",
      '    Expected: "missing required environment variables were reported to the user"',
      '    Received: "no such report"',
      "  1 failed",
    ].join("\n"),
    [
      "  1) [vault-recall] › e2e/vault-recall.spec.ts:12:1 › recalls ─",
      "    AssertionError: required environment section is missing from the note",
      "  1 failed",
    ].join("\n"),
  ];
  for (const logText of productReds) {
    assert.deepEqual(detectMissingRequiredEnvironment(logText), []);
    const outcome = classifyAttemptOutcome({ exitCode: 1, summaryFresh: false, logText });
    assert.equal(outcome.failureClass, LANE_ASSERTION_FAILURE_CLASS);
    assert.equal(attemptConsumesBudget(red("vault-recall", outcome.failureClass)), true);
  }
});

test("a not-run cell is neither green nor red, and never enters a pass-rate denominator", () => {
  const manifest = manifestWith([green("vault-recall"), green("vault-recall")]);
  recordCellStatus(manifest, "vault-recall", CELL_STATUS_DONE, { greens: 2 });
  recordCellStatus(manifest, "compound-linear-github", CELL_STATUS_NOT_RUN, {
    failureClass: ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS,
    missingEnvironment: ["LINEAR_LIVE_TEST_TEAM_ID"],
  });

  assert.equal(cellStatusOf(manifest, "compound-linear-github"), CELL_STATUS_NOT_RUN);
  assert.equal(cellStatusOf(manifest, "compound-linear-github"), "not_run");
  // The cell has NO attempt records at all — the abort happens before any are
  // written, so attempt arithmetic cannot present it as attempted-and-failed.
  assert.equal(consumedAttemptCount(manifest, "compound-linear-github"), 0);
  assert.equal(
    manifest.attempts.filter((a) => a.cell === "compound-linear-github").length,
    0,
  );
  // Scored/not-scored is one shared predicate for every reader.
  assert.equal(cellStatusIsScored(CELL_STATUS_NOT_RUN), false);
  assert.equal(cellStatusIsScored(CELL_STATUS_DONE), true);
  assert.equal(cellStatusIsScored(CELL_STATUS_EXHAUSTED), true);
  const scored = Object.values(manifest.cellStatus ?? {}).filter((verdict) =>
    cellStatusIsScored(verdict.status),
  );
  assert.equal(scored.length, 1, "a not-run cell must not sit in the denominator");
});

test("the matrix aborts on environment_not_configured before it records anything", () => {
  // main() cannot be unit-run (it drives real lanes), so pin the ORDER of the
  // recording steps in the source: the abort must come before the CSV row and
  // before the attempt record, or a not-run cell reappears as a red row.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run-proof-matrix.mjs"),
    "utf8",
  );
  const guard = source.indexOf("if (failureClass === ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS) {");
  const csvRow = source.indexOf("appendRunCsvRow([");
  const attemptPush = source.indexOf("manifest.attempts.push({");
  assert.ok(guard > 0, "the attempt loop must guard on environment_not_configured");
  assert.ok(csvRow > 0 && attemptPush > 0);
  assert.ok(guard < csvRow, "the abort must precede the CSV row (a run that never happened has no metrics)");
  assert.ok(guard < attemptPush, "the abort must precede the attempt record (budget and streak stay put)");
  // The in-flight marker must be cleared, or the next --resume reconciles this
  // non-attempt into a phantom harness attempt.
  const abortBlock = source.slice(guard, csvRow);
  assert.match(abortBlock, /clearAttemptInFlight\(manifest\)/u);
  assert.match(abortBlock, /CELL_STATUS_NOT_RUN/u);
  // And the operator is told exactly which variables to set.
  assert.match(abortBlock, /did NOT RUN — required environment not configured: \$\{missingList\}/u);
});

/**
 * The real 2026-08-26 compound-linear-github attempt 2: 1120s, every product
 * assertion passed, and the run went red purely on a teardown process probe.
 */
const CLEANUP_FAILED_ATTEMPT_LOG = [
  "Running 1 test using 1 worker",
  "FLOW-REAL success linear=https://linear.app/x/issue/E2E-41 github=https://github.com/o/r note=Results.md",
  "",
  "  1) [compound-flow-real-live] › e2e/compound-flow-real-live.spec.ts:98:3 › compound Linear + GitHub flow ─",
  "",
  "    Error: COMPOUND-REAL assertions passed; mandatory cleanup failed: Harness cleanup: Controlled Obsidian teardown did not drain cleanly (owned process exit; Obsidian process drain).",
  "",
  "      at e2e/compound-flow-real-live.spec.ts:884:13",
  "",
  "  1 failed",
].join("\n");

test("a mission that passed every assertion and only failed teardown is NOT a lane assertion failure", () => {
  const outcome = classifyAttemptOutcome({
    exitCode: 1,
    summaryFresh: false,
    logText: CLEANUP_FAILED_ATTEMPT_LOG,
  });
  // The defect: this log landed in the bucket a genuine product failure lands
  // in, so a fully successful mission capped the measured pass rate.
  assert.notEqual(outcome.failureClass, LANE_ASSERTION_FAILURE_CLASS);
  assert.equal(outcome.failureClass, HARNESS_CLEANUP_FAILURE_CLASS);
  assert.equal(outcome.failureClass, "harness:cleanup_failed");
  // The lane stated the fact about itself; the matrix did not guess it.
  assert.equal(outcome.confidence, CLASSIFICATION_CONFIRMED);
  assert.equal(outcome.cleanupFailure?.lane, "COMPOUND-REAL");
  assert.match(outcome.detail, /did not drain cleanly/u);
  // Playwright prints a numbered failing-test header for ANY throw, so the log
  // does match the lane-assertion patterns. Carrying that as a secondary class
  // would smuggle the product-failure reading into another column.
  assert.ok(!outcome.secondaryClasses.includes(LANE_ASSERTION_FAILURE_CLASS));
});

const DIRECT_CLEANUP_ATTEMPT_LOG = [
  "Running 1 test using 1 worker",
  "",
  "  1) [real-ai-soak] › e2e/real-ai-soak.spec.ts:102:9 › VAULT-01 deep vault retrieval and semantic expansion",
  "",
  "    Error: Controlled Obsidian teardown did not drain cleanly (owned process exit). Survivor sweep: observed 1 Obsidian process(es); STILL TERMINATING, unreapable by any kill: 17876",
  "",
  "      at scripts/obsidian-process-lifecycle.ts:119:9",
  "",
  "  1 failed",
].join("\n");

const DIRECT_CLEANUP_ACCEPTED_SUMMARY = {
  records: [
    {
      scenarioId: "VAULT-01",
      project: "real-ai-soak",
      status: "failed",
      missionScorecard: { acceptancePassed: true, total: 1 },
    },
  ],
};

test("a direct lane's sole controlled teardown failure is cleanup-only when its fresh scorecard passed", () => {
  const outcome = classifyAttemptOutcome({
    exitCode: 1,
    summary: DIRECT_CLEANUP_ACCEPTED_SUMMARY,
    summaryFresh: true,
    logText: DIRECT_CLEANUP_ATTEMPT_LOG,
  });
  assert.equal(outcome.failureClass, HARNESS_CLEANUP_FAILURE_CLASS);
  assert.equal(outcome.confidence, CLASSIFICATION_CONFIRMED);
  assert.equal(outcome.cleanupFailure?.lane, "VAULT-01");
  assert.match(outcome.detail, /fresh accepted scorecard/u);
  assert.ok(!outcome.secondaryClasses.includes(LANE_ASSERTION_FAILURE_CLASS));
});

test("direct teardown cannot hide behind a stale or failed scorecard", () => {
  const stale = classifyAttemptOutcome({
    exitCode: 1,
    summary: DIRECT_CLEANUP_ACCEPTED_SUMMARY,
    summaryFresh: false,
    logText: DIRECT_CLEANUP_ATTEMPT_LOG,
  });
  assert.equal(stale.failureClass, LANE_ASSERTION_FAILURE_CLASS);

  const unaccepted = classifyAttemptOutcome({
    exitCode: 1,
    summary: {
      records: [
        {
          ...DIRECT_CLEANUP_ACCEPTED_SUMMARY.records[0],
          missionScorecard: { acceptancePassed: false, total: 0.8 },
        },
      ],
    },
    summaryFresh: true,
    logText: DIRECT_CLEANUP_ATTEMPT_LOG,
  });
  assert.equal(unaccepted.failureClass, LANE_ASSERTION_FAILURE_CLASS);
});

test("direct teardown cannot hide an independent product assertion error", () => {
  const outcome = classifyAttemptOutcome({
    exitCode: 1,
    summary: DIRECT_CLEANUP_ACCEPTED_SUMMARY,
    summaryFresh: true,
    logText: DIRECT_CLEANUP_ATTEMPT_LOG.replace(
      "    Error: Controlled Obsidian teardown",
      "    Error: expect(locator).toBeVisible() failed\n\n    Error: Controlled Obsidian teardown",
    ),
  });
  assert.equal(outcome.failureClass, LANE_ASSERTION_FAILURE_CLASS);
  assert.equal(attemptConsumesBudget(red("vault-recall", outcome.failureClass)), true);
});

test("a lane whose ASSERTIONS failed stays a product-bucket red even when cleanup also failed", () => {
  // The discriminator. Both halves of the wrapper mention cleanup; only the
  // "assertions passed" half means the product succeeded. A failure on both
  // must never be laundered into the budget-exempt harness bucket.
  const bothFailed = CLEANUP_FAILED_ATTEMPT_LOG.replace(
    "COMPOUND-REAL assertions passed;",
    "COMPOUND-REAL failed: expected Results note to contain the marker;",
  );
  assert.equal(detectLaneCleanupFailure(bothFailed), null);
  const outcome = classifyAttemptOutcome({
    exitCode: 1,
    summaryFresh: false,
    logText: bothFailed,
  });
  assert.equal(outcome.failureClass, LANE_ASSERTION_FAILURE_CLASS);
  assert.equal(attemptConsumesBudget(red("compound-linear-github", outcome.failureClass)), true);
});

test("the lane's composed sentence and the matrix's detector are one contract", () => {
  // Anti-drift bond: the wrapper is written in exactly one place and parsed in
  // exactly one place, and this test is the only thing holding them together.
  // Re-wording either half silently returns the false red.
  const passed = composeMandatoryCleanupError("COMPOUND-REAL", null, [
    "Harness cleanup: Controlled Obsidian teardown did not drain cleanly (owned process exit).",
  ]);
  const detected = detectLaneCleanupFailure(passed.message);
  assert.equal(detected?.lane, "COMPOUND-REAL");
  assert.match(detected?.detail ?? "", /did not drain cleanly/u);

  const alsoFailed = composeMandatoryCleanupError(
    "BYOK-AUTONOMOUS",
    new Error("expected 19 deliverables, saw 17"),
    ["Harness cleanup: teardown did not drain cleanly"],
  );
  assert.equal(detectLaneCleanupFailure(alsoFailed.message), null);
});

test("a harness cleanup failure spends no attempt budget and preserves the green streak", () => {
  const outcome = classifyAttemptOutcome({
    exitCode: 1,
    summaryFresh: false,
    logText: CLEANUP_FAILED_ATTEMPT_LOG,
  });
  const attempt = red("compound-linear-github", outcome.failureClass);
  assert.equal(isInfrastructureFailureClass(outcome.failureClass), true);
  assert.equal(attemptConsumesBudget(attempt), false);
  // The concrete harm: a streak that needs 3 consecutive greens was reset by a
  // teardown probe, so two successful missions were thrown away.
  const manifest = manifestWith([
    green("compound-linear-github"),
    green("compound-linear-github"),
    attempt,
  ]);
  assert.equal(consecutiveGreens(manifest, "compound-linear-github"), 2);
  assert.equal(consumedAttemptCount(manifest, "compound-linear-github"), 2);
  // Still loud: it counts toward the valve that aborts a persistently broken
  // harness, so a genuinely leaking teardown cannot loop forever unnoticed.
  assert.equal(harnessFailureCount(manifest, "compound-linear-github"), 1);
  assert.equal(consecutiveHarnessFailures(manifest, "compound-linear-github"), 1);
});

test("a harness cleanup failure writes no run-metrics row but keeps its attempt record", () => {
  // main() cannot be unit-run, so pin the source shape: the CSV append is
  // conditioned on the class (every reader counts each row in its pass-rate
  // denominator and can only say green/not-green), while the attempt record is
  // NOT — the event must stay durable and greppable in the manifest.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run-proof-matrix.mjs"),
    "utf8",
  );
  // Generalized from `failureClass !== HARNESS_CLEANUP_FAILURE_CLASS` to the
  // ONE shared predicate. The intent is unchanged and strictly widened: the
  // reasoning is identical for EVERY infrastructure outcome, and a per-class
  // list is exactly how the third such class (provider quota exhaustion) was
  // missed. `green ||` keeps a passing run's row unconditional, so this can
  // never inflate a pass rate by withholding a product red.
  assert.match(
    source,
    /if \(green \|\| !isInfrastructureFailureClass\(failureClass\)\) appendRunCsvRow\(\[/u,
    "the run-metrics row must be skipped for every infrastructure failure",
  );
  const csvRow = source.indexOf("appendRunCsvRow([");
  const attemptPush = source.indexOf("manifest.attempts.push({");
  const guardedPush = source.slice(attemptPush - 400, attemptPush);
  assert.ok(csvRow > 0 && attemptPush > csvRow);
  assert.doesNotMatch(
    guardedPush,
    /HARNESS_CLEANUP_FAILURE_CLASS/u,
    "the attempt record must NOT be skipped — the leak has to stay on the record",
  );
});

test("a summary whose records know nothing falls through instead of reporting zero", () => {
  // Record EXISTENCE is not knowledge. Before this, any fresh summary with at
  // least one record returned source="summary" with observed=0 — which is how
  // the scenario-less proof lanes printed explicit observed=0 CSV rows for
  // runs that certainly called tools.
  const silent = {
    records: [
      { title: "soak", toolCalls: null, toolCallsAttempted: null },
      { title: "notebook", toolCalls: null, toolCallsAttempted: null },
    ],
  };
  const totals = summaryToolEventTotals(silent);
  assert.ok(totals);
  assert.equal(totals.observed, null, "no record knew: the total is unknown, not zero");
  assert.equal(totals.buckets, null, "no record contributed buckets: unknown, not six zeros");

  // With graphs available it falls through to mining...
  const mined = resolveAttemptToolEvents({
    summary: silent,
    summaryFresh: true,
    minedCounts: { observed: 7, failed: 1, buckets: { tool_not_allowed: 1 } },
  });
  assert.equal(mined.source, TOOL_EVENT_SOURCE_GRAPHS);
  assert.equal(mined.observed, 7);

  // ...and with nothing to mine either, all the way to "none".
  const nothing = resolveAttemptToolEvents({
    summary: silent,
    summaryFresh: true,
    minedCounts: { observed: 0, failed: 0, buckets: null },
  });
  assert.equal(nothing.source, TOOL_EVENT_SOURCE_NONE);
  assert.equal(nothing.observed, null);
  assert.equal(nothing.buckets, null);
});

test("refusal-bucket cells stay blank unless a record contributed the key", () => {
  // The old all-keys-at-0 seed printed six fabricated refusal zeros on EVERY
  // summary-sourced row, whatever the records actually knew.
  const partial = summaryToolEventTotals({
    records: [{ toolCalls: 5, refusalBuckets: { execution_failed: 2 } }],
  });
  assert.ok(partial?.buckets);
  assert.deepEqual(Object.keys(partial.buckets!), ["execution_failed"]);
  for (const [key] of BLOCKER_BUCKETS) {
    if (key === "execution_failed") continue;
    assert.equal(
      partial.buckets![key],
      undefined,
      `${key} was never contributed and must print blank, not 0`,
    );
  }
  // A record that DID watch every bucket (a complete fold) contributes them
  // all, explicit zeros included — that row's zeros are real knowledge.
  const watched = summaryToolEventTotals({
    records: [{
      toolCalls: 5,
      refusalBuckets: Object.fromEntries(
        BLOCKER_BUCKETS.map(([key]) => [key, key === "invalid_arguments" ? 1 : 0]),
      ),
    }],
  });
  assert.equal(watched?.buckets?.invalid_arguments, 1);
  assert.equal(watched?.buckets?.tool_not_allowed, 0);
  // Records with no bucket knowledge at all leave the whole vocabulary unknown.
  const silent = summaryToolEventTotals({ records: [{ toolCalls: 1 }] });
  assert.equal(silent?.buckets, null);
});

test("the folded per-call count outranks the evidence-derived DU counter", () => {
  // toolCalls is missionEvidence.length (successes only); toolCallsAttempted
  // comes from the event-stream fold and is the real denominator.
  const totals = summaryToolEventTotals({
    records: [
      { toolCalls: 12, toolCallsAttempted: 19, toolCallsFailed: 7 },
      { toolCalls: 3, toolCallsAttempted: null },
    ],
  });
  assert.equal(totals?.observed, 22, "19 folded + 3 fallback, never double counted");
  assert.equal(totals?.failed, 7);
});

test("summary freshness is an exact pre-spawn mtime comparison, with no grace window", () => {
  const root = mkdtempSync(path.join(tmpdir(), "proof-matrix-freshness-"));
  const summary = path.join(root, "daily-use-run-summary.json");
  try {
    // Attempt N wrote this summary.
    writeFileSync(summary, "{}");
    const previousAttemptMtimeSeconds = Date.now() / 1_000 - 60;
    utimesSync(summary, previousAttemptMtimeSeconds, previousAttemptMtimeSeconds);
    const beforeLaunch = fileMtimeMs(summary);
    assert.ok(typeof beforeLaunch === "number");

    // Attempt N+1 dies in the harness stage without writing anything. The old
    // rule (mtime >= windowStart - 5s) admitted attempt N's file as fresh
    // whenever N+1 died inside that 5-second window; the exact snapshot cannot.
    assert.equal(
      summaryWrittenSince(summary, beforeLaunch),
      false,
      "the PREVIOUS attempt's summary must never label this attempt",
    );

    // A real write during the attempt is strictly newer.
    const nowSeconds = Date.now() / 1_000;
    utimesSync(summary, nowSeconds, nowSeconds);
    assert.equal(summaryWrittenSince(summary, beforeLaunch), true);

    // Absent before, present now: fresh. Absent now: never fresh.
    const virgin = path.join(root, "absent.json");
    assert.equal(fileMtimeMs(virgin), null);
    assert.equal(summaryWrittenSince(virgin, null), false);
    writeFileSync(virgin, "{}");
    assert.equal(summaryWrittenSince(virgin, null), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a call that started and never finished is never scored as a success", () => {
  // `observed - failed` credits every undetermined call as a success, which is
  // exactly wrong for an interrupted run (the whole point of the
  // interrupted-continuation lane). Undetermined is subtracted, not credited.
  const interrupted = resolveAttemptToolEvents({
    summary: {
      records: [{
        toolCallsAttempted: 10,
        toolCallsFailed: 2,
        toolCallsVacuous: 1,
        toolCallsUndetermined: 3,
      }],
    },
    summaryFresh: true,
    minedCounts: { observed: 0, failed: 0, buckets: null },
  });
  assert.equal(interrupted.observed, 10);
  assert.equal(interrupted.failed, 2);
  assert.equal(interrupted.undetermined, 3);
  assert.equal(interrupted.succeeded, 4, "10 - 2 failed - 1 vacuous - 3 undetermined");

  // A record that cannot report undetermined contributes null, which leaves
  // the previous arithmetic untouched rather than assuming anything.
  const legacy = resolveAttemptToolEvents({
    summary: { records: [{ toolCalls: 10, toolCallsFailed: 2, toolCallsVacuous: 1 }] },
    summaryFresh: true,
    minedCounts: { observed: 0, failed: 0, buckets: null },
  });
  assert.equal(legacy.undetermined, null);
  assert.equal(legacy.succeeded, 7);
});

test("an exhausted provider quota is not a product failure", () => {
  // 2026-08-26: five of six compound attempts died on the provider's monthly
  // cap -- including one that had already reached five lifecycle stages in
  // 1044s before the quota cut it off. All five were filed as
  // `lane_assertion_failed` and the cell recorded 0/3 greens as though the
  // product had regressed. It had not; the account's cap was spent.
  const log = [
    "  1) [compound-flow-real-live] > FLOW-REAL-01 COMPOUND-REAL",
    '    Error: {"status":"error","message":"Connection failed: What: Cloud model rate limit reached.',
    "    Why: extra usage auto reload monthly max reached, increase your monthly max",
    "    expect(received).toMatchObject(expected)",
  ].join("\n");
  const outcome = classifyAttemptOutcome({ exitCode: 1, summary: null, summaryFresh: false, logText: log });
  assert.equal(outcome.failureClass, PROVIDER_QUOTA_EXHAUSTED_FAILURE_CLASS);
  // The lane-assertion signature genuinely co-matches (Playwright prints a
  // numbered failing-test header for any throw). It must not ride along as a
  // secondary, or the same lie reappears in another column.
  assert.ok(!outcome.secondaryClasses.includes("lane_assertion_failed"));
  // Budget-exempt and streak-neutral through the ONE shared predicate.
  assert.ok(isInfrastructureFailureClass(outcome.failureClass));
  assert.equal(
    attemptConsumesBudget({ green: false, failureClass: outcome.failureClass }),
    false,
  );
});

test("a product assertion mentioning a limit is still a product failure", () => {
  // The anti-false-positive half: detection keys on whole provider sentences,
  // never on a bare "limit", "quota" or "429", any of which a real
  // expected/received diff can contain.
  for (const text of [
    '  1) lane > test\n    Error: expect(received).toEqual(expected)\n    Received: "budget limit reached for the mission"',
    '  1) lane > test\n    AssertionError: rate limiting policy note was not written to the vault',
    '  1) lane > test\n    Error: expected 429 to equal 200',
  ]) {
    const outcome = classifyAttemptOutcome({ exitCode: 1, summary: null, summaryFresh: false, logText: text });
    assert.notEqual(
      outcome.failureClass,
      PROVIDER_QUOTA_EXHAUSTED_FAILURE_CLASS,
      `must not classify as provider quota: ${text.slice(0, 60)}`,
    );
  }
});

test("no infrastructure outcome writes a pass-rate row, by one shared predicate", async () => {
  // A per-class list is how the third infrastructure class got missed, so the
  // CSV gate consumes isInfrastructureFailureClass rather than naming classes.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../scripts/run-proof-matrix.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /if \(green \|\| !isInfrastructureFailureClass\(failureClass\)\) appendRunCsvRow\(/u,
    "the CSV row gate must consume the shared infrastructure predicate",
  );
  // A green run always records, so this can never inflate a pass rate.
  for (const cls of [
    "harness:cleanup_failed",
    "harness:provider_quota_exhausted",
    "harness:preflight_refused",
    "process:host_death",
    "environment_not_configured",
  ]) {
    assert.ok(isInfrastructureFailureClass(cls), `${cls} must be infrastructure`);
  }
  assert.ok(!isInfrastructureFailureClass("lane_assertion_failed"));
  assert.ok(!isInfrastructureFailureClass("product_assertion"));
});

test("a sandbox that never attested is not a product failure", () => {
  // 2026-08-27: two compound attempts died on the WSL2 boundary probe timing
  // out under 100% host CPU, each burning ~40 minutes of a pinned premium
  // model, and both were filed as lane_assertion_failed. The same lane had
  // proven 3 consecutive greens hours earlier on a quiet machine.
  const log = [
    "  1) [compound-flow-real-live] > FLOW-REAL-01 COMPOUND-REAL",
    '    Error: Mission stopped before acceptance; approved=1; blockerMessage":"No sandbox provider has passed its boundary probe. wsl2 rejected: Sandbox provider process exceeded its fixed timeout."',
  ].join("\n");
  const outcome = classifyAttemptOutcome({
    exitCode: 1,
    summary: null,
    summaryFresh: false,
    logText: log,
  });
  assert.equal(outcome.failureClass, SANDBOX_UNAVAILABLE_FAILURE_CLASS);
  assert.ok(!outcome.secondaryClasses.includes("lane_assertion_failed"));
  assert.ok(isInfrastructureFailureClass(outcome.failureClass));
  assert.equal(
    attemptConsumesBudget({ green: false, failureClass: outcome.failureClass }),
    false,
  );
});

test("a sandbox that RAN and failed its boundary stays a product failure", () => {
  // The safety half, and the reason detection requires the timeout clause. A
  // probe that executed and reported the boundary did not hold means code was
  // not confined -- a severe product finding. Letting it hide behind an
  // infrastructure label would be far worse than any mis-scored lane.
  for (const text of [
    '  1) lane > test\n    Error: No sandbox provider has passed its boundary probe. wsl2 rejected: boundary escape observed in probe output.',
    '  1) lane > test\n    Error: sandbox_boundary_probe_failed: attestation fingerprint mismatch',
    '  1) lane > test\n    Error: No sandbox provider has passed its boundary probe. wsl2 rejected: probe wrote outside the staging root.',
  ]) {
    const outcome = classifyAttemptOutcome({
      exitCode: 1,
      summary: null,
      summaryFresh: false,
      logText: text,
    });
    assert.notEqual(
      outcome.failureClass,
      SANDBOX_UNAVAILABLE_FAILURE_CLASS,
      `a real boundary violation must not be excused: ${text.slice(30, 90)}`,
    );
  }
});

test("the no-verdict contract keys on the manager's stable marker, not runner prose", () => {
  // The SandboxManager owns `sandbox_probe_no_verdict` and documents it as a
  // stable contract; the runner's "exceeded its fixed timeout" is incidental
  // prose that can be reworded without ceremony. Both match, but the marker is
  // the durable half -- and the paired violation marker must never match.
  const noVerdict =
    "Error: No sandbox provider has passed its boundary probe. wsl2 no_verdict: " +
    "sandbox_probe_no_verdict: Sandbox provider process exceeded its fixed timeout. " +
    "The boundary was neither proven nor disproven after 2 attempts (last budget 180000ms).";
  assert.equal(
    classifyAttemptOutcome({ exitCode: 1, summary: null, summaryFresh: false, logText: noVerdict })
      .failureClass,
    SANDBOX_UNAVAILABLE_FAILURE_CLASS,
  );
  const violation =
    "Error: No sandbox provider has passed its boundary probe. wsl2 rejected: " +
    "sandbox_probe_boundary_violation: Sandbox boundary probe did not prove every " +
    "required isolation property.";
  assert.notEqual(
    classifyAttemptOutcome({ exitCode: 1, summary: null, summaryFresh: false, logText: violation })
      .failureClass,
    SANDBOX_UNAVAILABLE_FAILURE_CLASS,
    "a boundary violation must stay a product finding",
  );
  const unavailable =
    "Error: No sandbox provider has passed its boundary probe. wsl2 unavailable: " +
    "Probe exited 127. wsl.exe: command not found";
  assert.notEqual(
    classifyAttemptOutcome({ exitCode: 1, summary: null, summaryFresh: false, logText: unavailable })
      .failureClass,
    SANDBOX_UNAVAILABLE_FAILURE_CLASS,
    "a provider that cannot run at all is not a transient no-verdict",
  );
});
