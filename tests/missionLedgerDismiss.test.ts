import assert from "node:assert/strict";
import test from "node:test";
import {
  isUserDismissedMissionLedger,
  markMissionLedgerUserDismissed,
  summarizeMissionLedger,
  type MissionLedger,
} from "../src/agent/missionLedger";
import { buildMissionResumePlan } from "../src/agent/missionResume";

function sampleLedger(): MissionLedger {
  return {
    schemaVersion: 2,
    revision: 1,
    runId: "run-dismiss-1",
    mission: "Can you edit the entire page and turn it into essay format.",
    route: "grounded_workflow",
    createdAt: "2026-07-20T09:34:15.579Z",
    updatedAt: "2026-07-20T09:34:15.579Z",
    status: "blocked",
    loopBudget: {
      hardCap: 20,
      toolStepBudget: 16,
      finalizationReserve: 2,
      expectedTools: ["replace_current_file"],
    },
    tasks: [],
    milestones: [],
    evidence: [],
    receipts: [],
    blockers: [
      "Model step failed: Tool replace_current_file is not ready in the authoritative mission graph.",
    ],
    dependencyStatus: [],
    approvals: [],
    nextActions: ["Continue after unblocking replace_current_file."],
    remainingActions: ["replace_current_file"],
    iterationCount: 1,
    progressScore: 0,
    stalledCount: 1,
    resumeCount: 0,
    lastSafeStep: 1,
    continuationCommand: "continue run run-dismiss-1",
  };
}

test("user dismiss marks ledger non-resumable and persists timestamp", () => {
  const ledger = sampleLedger();
  assert.equal(isUserDismissedMissionLedger(ledger), false);
  assert.equal(buildMissionResumePlan(ledger).canResume, true);

  markMissionLedgerUserDismissed(ledger, new Date("2026-07-20T12:00:00.000Z"));
  assert.equal(isUserDismissedMissionLedger(ledger), true);
  assert.equal(ledger.status, "stopped");
  assert.equal(ledger.userDismissedAt, "2026-07-20T12:00:00.000Z");
  assert.equal(buildMissionResumePlan(ledger).canResume, false);
  assert.equal(buildMissionResumePlan(ledger).reason, "user_dismissed");
  assert.equal(summarizeMissionLedger(ledger).canResume, false);
});

test("mission ledger summaries retain only the redacted provider aggregate", () => {
  const ledger = sampleLedger();
  ledger.providerUsage = {
    schemaVersion: 1,
    modelCallCount: 7,
    successfulCallCount: 5,
    failedCallCount: 2,
    reportedTokens: 1_234,
    estimatedTokens: 56,
    retries: 2,
    wallClockMs: 9_876,
  };

  const summary = summarizeMissionLedger(ledger);

  assert.deepEqual(summary.providerUsage, ledger.providerUsage);
  assert.notEqual(summary.providerUsage, ledger.providerUsage);
});
