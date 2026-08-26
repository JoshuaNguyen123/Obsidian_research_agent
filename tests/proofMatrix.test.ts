import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PLAYWRIGHT_PROJECTS } from "../scripts/run-e2e-exclusive.mjs";
import {
  ATTEMPT_LOG_DIR,
  CELLS,
  CLASSIFICATION_CONFIRMED,
  CLASSIFICATION_MECHANICAL,
  CLASSIFICATION_UNCLASSIFIED,
  IN_FLIGHT_FAILURE_CLASS,
  LANE_ASSERTION_FAILURE_CLASS,
  LEGACY_RUN_CSV_HEADER,
  RUN_CSV_HEADER,
  TOOL_EVENT_SOURCE_GRAPHS,
  TOOL_EVENT_SOURCE_NONE,
  TOOL_EVENT_SOURCE_SUMMARY,
  collectMechanicalFailureClasses,
  extractPlaywrightReportErrorText,
  resolveAttemptToolEvents,
  summaryToolEventTotals,
  summaryWrittenSince,
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
  isEmptyScorecardHarvestOutput,
  isInfrastructureFailureClass,
  laneHasScorecardBaselineFrom,
  markAttemptInFlight,
  migrateLegacyManifestFile,
  porcelainWithoutAllowedHarvest,
  reconcileInFlightAttempt,
  registerProductFailure,
  writeJsonAtomic,
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
  ]);
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
  assert.ok(totals.buckets, "records contributed buckets");
  assert.equal(totals.buckets.mission_graph_authority_blocked, 2);
  assert.equal(totals.buckets.tool_not_allowed, 1);
  assert.equal("bogus_bucket" in totals.buckets, false, "unknown bucket keys are dropped");
  // No records: nothing to speak for the attempt.
  assert.equal(summaryToolEventTotals({ records: [] }), null);
  assert.equal(summaryToolEventTotals(null), null);
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
// Tool-call census wave (2026-08-25): record existence is not knowledge, the
// six fabricated refusal zeros, strict summary freshness, and sidecar
// classification.
// ---------------------------------------------------------------------------

test("a fresh summary whose records know no counts is not an observed zero", () => {
  // The exact false-zero regression: the three scenario-less proof lanes
  // (real-ai-soak, code-delivery, interrupted-continuation) push records with
  // null counters. Their mere existence must not become source=summary
  // observed=0 — it falls through to graphs, then none.
  const knowNothing = {
    records: [
      { toolCalls: null, toolCallsObserved: null, toolCallsFailed: null },
      { toolCalls: null, toolCallsObserved: null, toolCallsFailed: null },
    ],
  };
  assert.equal(summaryToolEventTotals(knowNothing)?.observed, null);
  const fellThrough = resolveAttemptToolEvents({
    summary: knowNothing,
    summaryFresh: true,
    minedCounts: { observed: 0, failed: 0, buckets: null },
  });
  assert.equal(fellThrough.source, TOOL_EVENT_SOURCE_NONE);
  assert.equal(fellThrough.observed, null);
  // With mined evidence available, the mine speaks instead.
  const mined = resolveAttemptToolEvents({
    summary: knowNothing,
    summaryFresh: true,
    minedCounts: { observed: 5, failed: 1, buckets: null },
  });
  assert.equal(mined.source, TOOL_EVENT_SOURCE_GRAPHS);
  assert.equal(mined.observed, 5);
});

test("the census per-call count outranks the legacy DU-acceptance counter", () => {
  // daily-use-research annotates toolCalls from missionEvidence lengths (an
  // evidence count, successes only); the census counts actual calls. When
  // both are present the census speaks for observed.
  const totals = summaryToolEventTotals({
    records: [{ toolCalls: 7, toolCallsObserved: 11, toolCallsFailed: 2 }],
  });
  assert.equal(totals?.observed, 11);
  assert.equal(totals?.failed, 2);
});

test("refusal bucket cells are blank when no record contributed them", () => {
  // The previous all-keys-at-0 seed printed six fabricated refusal zeros on
  // every summary-sourced row. Unobserved buckets are now null (blank cells).
  const noBuckets = summaryToolEventTotals({
    records: [{ toolCalls: 4, toolCallsFailed: 0 }],
  });
  assert.equal(noBuckets?.buckets, null);
  // A record that DID contribute buckets makes exactly its keys known —
  // census records carry all six with explicit zeros, mined records only the
  // sighted keys.
  const censusBuckets = summaryToolEventTotals({
    records: [{
      toolCalls: 4,
      toolCallsFailed: 1,
      refusalBuckets: { mission_graph_authority_blocked: 1, tool_not_allowed: 0 },
    }],
  });
  assert.deepEqual(censusBuckets?.buckets, {
    mission_graph_authority_blocked: 1,
    tool_not_allowed: 0,
  });
});

test("summary freshness is strictly newer than the pre-launch snapshot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "proof-matrix-freshness-"));
  const file = path.join(root, "daily-use-run-summary.json");
  try {
    // Absent before and after: not fresh.
    assert.equal(summaryWrittenSince(file, null), false);
    writeFileSync(file, "{}");
    const mtimeBefore = (() => {
      const { statSync } = require("node:fs") as typeof import("node:fs");
      return statSync(file).mtimeMs;
    })();
    // Untouched since the snapshot: stale — the old 5s wall-clock grace
    // admitted attempt N's summary into a fast-failing attempt N+1.
    assert.equal(summaryWrittenSince(file, mtimeBefore), false);
    // Strictly newer than the snapshot: fresh.
    assert.equal(summaryWrittenSince(file, mtimeBefore - 1), true);
    // Absent at snapshot time, present now: fresh (first-ever summary).
    assert.equal(summaryWrittenSince(file, null), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sidecar product signatures classify the reds the launcher log cannot", () => {
  // The runner's --reporter override keeps diagnostics off stdout, so the
  // deadlock evidence lives only in the Playwright JSON report. Tonight's
  // interrupted-continuation reds carried exactly this stop diagnostic.
  const sidecarText = extractPlaywrightReportErrorText({
    suites: [{
      specs: [{
        tests: [{
          results: [{
            error: {
              message:
                "Mission stopped before acceptance; approved=0; action=force_final_no_tools; " +
                "reason=required_tools_satisfied; successful_tools=0; " +
                "required_tools_satisfied=false; graph_final_only=true",
            },
          }],
        }],
      }],
      suites: [],
    }],
  });
  assert.match(sidecarText, /force_final_no_tools/u);
  const outcome = classifyAttemptOutcome({
    exitCode: 1,
    summaryFresh: false,
    logText: "nothing recognizable on stdout",
    sidecarText,
  });
  assert.equal(outcome.failureClass, "product:final_only_graph_deadlock");
  assert.equal(outcome.confidence, CLASSIFICATION_MECHANICAL);
  // product: consumes attempt budget — the whole point: unclassified reds
  // were budget-exempt and looped forever.
  assert.equal(isInfrastructureFailureClass(outcome.failureClass), false);
  // Harness-stage deaths keep their classification even when a sidecar from
  // an earlier phase carries product text: harness signatures stay first.
  const harnessFirst = classifyAttemptOutcome({
    exitCode: 1,
    summaryFresh: false,
    logText: "build exited with code 2.",
    sidecarText,
  });
  assert.equal(harnessFirst.failureClass, "harness:build_failed");
  assert.deepEqual(
    harnessFirst.secondaryClasses.includes("product:final_only_graph_deadlock"),
    true,
  );
});

test("an assertion that only the sidecar carries still classifies as a lane assertion", () => {
  const outcome = classifyAttemptOutcome({
    exitCode: 1,
    summaryFresh: false,
    logText: "nothing recognizable",
    sidecarText: "Error: expect(received).toBe(expected)\nexpect(received)",
  });
  assert.equal(outcome.failureClass, LANE_ASSERTION_FAILURE_CLASS);
});
