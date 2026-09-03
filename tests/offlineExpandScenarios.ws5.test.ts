import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OFFLINE_EXPAND_SCENARIO_IDS,
  OFFLINE_REQUIRED_SCENARIOS,
  evaluateOfflineApplicationRelease,
  offlineRequiredScenarioIdsForProjects,
  validateOfflineApplicationAttempt,
} from "../scripts/offline-application-attempt.mjs";
import { PLAYWRIGHT_PROJECTS, normalizeExclusiveArgs } from "../scripts/run-e2e-exclusive.mjs";
import {
  OFFLINE_EXPAND_SCENARIOS,
  assertOfflineExpandCatalogComplete,
  renderOfflineExpandPrompt,
} from "../e2e/fixtures/offlineExpandScenarios";

const HEAD = "a".repeat(40);
const BUNDLE_HASH = "b".repeat(64);

function green(scenarioId: string) {
  return {
    version: 1 as const,
    scenarioId,
    repetition: 1,
    exactHead: HEAD,
    sourceState: "clean_head" as const,
    bundleSha256: BUNDLE_HASH,
    installedBundleSha256: BUNDLE_HASH,
    status: "passed" as const,
    acceptanceStatus: "pass" as const,
    scorecardAcceptancePassed: true,
    scorecardTotal: 0.98,
    scorecardDimensions: [{ id: "receipt_coverage", score: 1 }],
    artifactReadbacks: ["note:verified"],
    failureClass: "none",
    cloudRequestCount: 0,
    safetyViolationCount: 0,
    duplicateMutationCount: 0,
    mutationsPerformed: 1,
    mutationsWithReceipts: 1,
    mutationEventsObserved: 1,
    toolEventsObserved: 1,
    toolEventsFailed: 0,
    modelCalls: 2,
    providerWaitMs: 10,
    durationMs: 100,
  };
}

test("offline-expand catalog covers the four new scenario ids and no others", () => {
  assertOfflineExpandCatalogComplete();
  assert.deepEqual(
    [...OFFLINE_EXPAND_SCENARIO_IDS],
    [
      "current_note_replace_with_backup",
      "page_clear_then_write",
      "word_count_correction",
      "title_rename_plus_body",
    ],
  );
  assert.equal(OFFLINE_EXPAND_SCENARIOS.length, 4);
  for (const scenario of OFFLINE_EXPAND_SCENARIOS) {
    assert.ok(OFFLINE_REQUIRED_SCENARIOS.includes(scenario.id), scenario.id);
    assert.match(
      renderOfflineExpandPrompt(scenario, "OFFLINE_PROBE_1"),
      /OFFLINE_PROBE_1/u,
    );
  }
});

test("the attempt validator accepts the four expand ids and rejects unknown ones", () => {
  for (const id of OFFLINE_EXPAND_SCENARIO_IDS) {
    assert.equal(validateOfflineApplicationAttempt(green(id)).scenarioId, id);
  }
  assert.throws(
    () => validateOfflineApplicationAttempt(green("not_a_real_scenario")),
    /Unknown offline scenario/u,
  );
});

test("exclusive runner gates expand scenarios only when that project ran", () => {
  assert.deepEqual(
    offlineRequiredScenarioIdsForProjects(["offline-core"]),
    ["chat_only", "current_note_append"],
  );
  assert.deepEqual(
    offlineRequiredScenarioIdsForProjects(["offline-expand"]),
    [...OFFLINE_EXPAND_SCENARIO_IDS],
  );
  const release = evaluateOfflineApplicationRelease({
    attempts: OFFLINE_EXPAND_SCENARIO_IDS.map((id) => green(id)),
    requiredScenarioIds: [...OFFLINE_EXPAND_SCENARIO_IDS],
    requiredRepetitions: 1,
  });
  assert.equal(release.passed, true);
  assert.equal(release.expectedAttempts, 4);
});

test("offline-expand is registered in the three-way lane contract", () => {
  const config = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
  const exclusive = readFileSync(
    new URL("../scripts/run-e2e-exclusive.mjs", import.meta.url),
    "utf8",
  );
  const preflight = readFileSync(
    new URL("../scripts/e2e-preflight.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(PLAYWRIGHT_PROJECTS.has("offline-expand"), true);
  assert.match(config, /name: "offline-expand"/u);
  assert.match(config, /offline-expand\\.spec\\.ts/u);
  assert.match(exclusive, /"offline-expand"/u);
  assert.match(preflight, /"offline-expand": \[\]/u);
  assert.match(preflight, /"offline-expand"/u);
});

test("offline-ai allows the expand project and still rejects live lanes", () => {
  assert.deepEqual(
    normalizeExclusiveArgs(["--offline-ai", "--project=offline-expand"]),
    {
      playwrightArgs: ["--project=offline-expand"],
      aiMode: "offline",
      liveExternal: false,
      projects: ["offline-expand"],
    },
  );
  assert.throws(
    () => normalizeExclusiveArgs(["--offline-ai", "--project=daily-use-research"]),
    /restricted to the offline-core/u,
  );
});
