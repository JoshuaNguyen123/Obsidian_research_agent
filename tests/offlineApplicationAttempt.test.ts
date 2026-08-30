import assert from "node:assert/strict";
import test from "node:test";

import {
  assertOfflineApplicationAttemptSummaryFile,
  evaluateOfflineApplicationRelease,
  offlineAttemptIsProofComplete,
  validateOfflineApplicationAttempt,
} from "../scripts/offline-application-attempt.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HEAD = "a".repeat(40);
const BUNDLE_HASH = "b".repeat(64);

function green(scenarioId: string, repetition: number) {
  return {
    version: 1 as const,
    scenarioId,
    repetition,
    exactHead: HEAD,
    sourceState: "clean_head" as const,
    bundleSha256: BUNDLE_HASH,
    installedBundleSha256: BUNDLE_HASH,
    status: "passed" as const,
    acceptanceStatus: "pass" as const,
    scorecardAcceptancePassed: true,
    scorecardTotal: 0.98,
    scorecardDimensions: [
      { id: "acceptance_coverage", score: 1 },
      { id: "receipt_coverage", score: 1 },
    ],
    artifactReadbacks: ["note:verified"],
    failureClass: "none",
    cloudRequestCount: 0,
    safetyViolationCount: 0,
    duplicateMutationCount: 0,
    mutationsPerformed: 1,
    mutationsWithReceipts: 1,
    mutationEventsObserved: 1,
    toolEventsObserved: 2,
    toolEventsFailed: 0,
    modelCalls: 2,
    providerWaitMs: 10,
    durationMs: 100,
  };
}

test("offline attempt contract rejects incomplete or contradictory evidence", () => {
  assert.throws(
    () => validateOfflineApplicationAttempt({ ...green("chat_only", 1), exactHead: "short" }),
    /40-character/u,
  );
  assert.throws(
    () => validateOfflineApplicationAttempt({
      ...green("chat_only", 1),
      mutationsPerformed: 0,
      mutationsWithReceipts: 1,
    }),
    /receipt more mutations/u,
  );
  assert.equal(
    offlineAttemptIsProofComplete({ ...green("chat_only", 1), cloudRequestCount: 1 }),
    false,
  );
  assert.equal(
    offlineAttemptIsProofComplete({ ...green("chat_only", 1), duplicateMutationCount: 1 }),
    false,
  );
  assert.equal(
    offlineAttemptIsProofComplete({
      ...green("chat_only", 1),
      installedBundleSha256: "c".repeat(64),
    }),
    false,
  );
  assert.equal(
    offlineAttemptIsProofComplete({ ...green("chat_only", 1), mutationEventsObserved: 0 }),
    false,
  );
});

test("release evidence rejects a dirty tree while a development gate labels it", () => {
  const attempt = { ...green("chat_only", 1), sourceState: "dirty_worktree" as const };
  const release = evaluateOfflineApplicationRelease({
    attempts: [attempt],
    requiredScenarioIds: ["chat_only"],
    requiredRepetitions: 1,
  });
  assert.equal(release.passed, false);
  assert.equal(release.releaseEligibleSource, false);
  assert.match(release.failures.join("\n"), /dirty working tree/u);

  const development = evaluateOfflineApplicationRelease({
    attempts: [attempt],
    requiredScenarioIds: ["chat_only"],
    requiredRepetitions: 1,
    requireCleanHead: false,
  });
  assert.equal(development.passed, true);
  assert.equal(development.releaseEligibleSource, false);
});

test("offline release is conjunctive across repetitions and scorecard dimensions", () => {
  const attempts = [1, 2, 3].map((repetition) => green("chat_only", repetition));
  const result = evaluateOfflineApplicationRelease({
    attempts,
    requiredScenarioIds: ["chat_only"],
    requiredRepetitions: 3,
    baselineDimensions: { chat_only: { acceptance_coverage: 1, receipt_coverage: 1 } },
  });
  assert.equal(result.passed, true);
  assert.equal(result.applicationSuccessRate, 1);
  assert.equal(result.receiptCoverage, 1);
  assert.equal(result.cloudRequests, 0);

  const unsafe = evaluateOfflineApplicationRelease({
    attempts: [
      green("chat_only", 1),
      { ...green("chat_only", 2), safetyViolationCount: 1 },
      { ...green("chat_only", 3), scorecardDimensions: [{ id: "acceptance_coverage", score: 0.9 }] },
    ],
    requiredScenarioIds: ["chat_only"],
    requiredRepetitions: 3,
    baselineDimensions: { chat_only: { acceptance_coverage: 1 } },
  });
  assert.equal(unsafe.passed, false);
  assert.match(unsafe.failures.join("\n"), /not proof-complete/u);
  assert.match(unsafe.failures.join("\n"), /regressed acceptance_coverage/u);
});

test("offline release refuses missing and duplicate scenario evidence", () => {
  const result = evaluateOfflineApplicationRelease({
    attempts: [green("chat_only", 1), green("chat_only", 1)],
    requiredScenarioIds: ["chat_only"],
    requiredRepetitions: 2,
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), /duplicate attempt chat_only#1/u);
  assert.match(result.failures.join("\n"), /missing attempt chat_only#2/u);
});

test("offline summary file is a fail-closed post-Playwright proof gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "offline-attempt-"));
  const filePath = path.join(root, "summary.json");
  try {
    await writeFile(filePath, JSON.stringify({ attempts: [green("chat_only", 1)] }), "utf8");
    const result = await assertOfflineApplicationAttemptSummaryFile({
      filePath,
      requiredScenarioIds: ["chat_only"],
    });
    assert.equal(result.passed, true);
    await assert.rejects(
      assertOfflineApplicationAttemptSummaryFile({
        filePath: path.join(root, "missing.json"),
        requiredScenarioIds: ["chat_only"],
      }),
      /wrote no valid attempt summary/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
