import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireLinearQueueLease,
  createLinearQueueState,
  recordCandidateEligibility,
  reduceLinearQueue,
  upsertLinearQueueCandidate,
} from "../src/agent/queue";
import { createWorkItemSpecV2 } from "../src/integrations/linear";

const T0 = "2026-07-13T12:00:00.000Z";
const CONTRACT = createWorkItemSpecV2({
  schemaVersion: 2,
  ready: true,
  executionClass: "vault",
  objective: "Create the host-bound queue result note.",
  vaultBindingKey: "current-vault",
  acceptanceCriteria: [{ id: "AC-1", text: "The note is read back exactly." }],
  validationRequirementKeys: ["vault.readback"],
  evidenceRefs: ["research:queue-reconciled-completion"],
  riskClass: "low",
  originRunId: "run-queue-reconciled-completion",
  acceptedResearchArtifactFingerprint: `sha256:${"a".repeat(64)}`,
  generation: 0,
});

test("receipt-bound reconciliation completes an expired running lease without replay", () => {
  const running = runningQueue();
  assert.equal(running.candidates["issue-queue-1"].status, "running");
  assert.ok(running.candidates["issue-queue-1"].lease);

  const completed = reduceLinearQueue(running, {
    type: "candidate_reconciliation_completed",
    expectedRevision: running.revision,
    at: "2026-07-13T12:00:05.000Z",
    issueId: "issue-queue-1",
    contractFingerprint: CONTRACT.fingerprint,
    reconciliationReceiptId: "linear-receipt-completed-state-1",
  });

  assert.equal(completed.candidates["issue-queue-1"].status, "completed");
  assert.equal(completed.candidates["issue-queue-1"].lease, null);
  assert.equal(
    completed.candidates["issue-queue-1"].completedAt,
    "2026-07-13T12:00:05.000Z",
  );
  assert.equal(completed.candidates["issue-queue-1"].attemptCount, 1);

  const replayedProof = reduceLinearQueue(completed, {
    type: "candidate_reconciliation_completed",
    expectedRevision: completed.revision,
    at: "2026-07-13T12:00:06.000Z",
    issueId: "issue-queue-1",
    contractFingerprint: CONTRACT.fingerprint,
    reconciliationReceiptId: "linear-receipt-completed-state-1",
  });
  assert.equal(replayedProof.candidates["issue-queue-1"].status, "completed");
  assert.equal(
    replayedProof.candidates["issue-queue-1"].completedAt,
    "2026-07-13T12:00:05.000Z",
  );
});

test("reconciled completion rejects a different contract generation", () => {
  const running = runningQueue();
  assert.throws(
    () =>
      reduceLinearQueue(running, {
        type: "candidate_reconciliation_completed",
        expectedRevision: running.revision,
        at: "2026-07-13T12:00:05.000Z",
        issueId: "issue-queue-1",
        contractFingerprint: `sha256:${"b".repeat(64)}`,
        reconciliationReceiptId: "linear-receipt-completed-state-1",
      }),
    /different work-item contract/u,
  );
  assert.equal(running.candidates["issue-queue-1"].status, "running");
});

function runningQueue() {
  let state = createLinearQueueState({ workspaceId: "workspace-queue", at: T0 });
  state = upsertLinearQueueCandidate(state, {
    at: "2026-07-13T12:00:01.000Z",
    issueId: "issue-queue-1",
    identifier: "E2E-41",
    remoteUpdatedAt: "2026-07-13T11:59:00.000Z",
    remoteStateId: "state-backlog",
    workItem: CONTRACT,
  });
  state = recordCandidateEligibility(state, "issue-queue-1", {
    eligible: true,
    reasons: [],
    repositoryKey: null,
    policyFingerprint: `sha256:${"c".repeat(64)}`,
    evaluatedAt: "2026-07-13T12:00:02.000Z",
  });
  const leased = acquireLinearQueueLease(state, {
    issueId: "issue-queue-1",
    ownerId: "queue-owner",
    at: "2026-07-13T12:00:03.000Z",
    leaseMs: 1_000,
  });
  if (!leased.accepted || !leased.lease) {
    assert.fail("Expected the eligible queue candidate to receive a lease.");
  }
  state = leased.state;
  return reduceLinearQueue(state, {
    type: "candidate_started",
    expectedRevision: state.revision,
    at: "2026-07-13T12:00:03.500Z",
    issueId: "issue-queue-1",
    ownerId: leased.lease.ownerId,
    token: leased.lease.token,
  });
}
