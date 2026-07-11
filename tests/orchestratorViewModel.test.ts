import assert from "node:assert/strict";
import test from "node:test";

import type { OrchestratorSnapshotV1 } from "../src/orchestrator/types";
import { buildOrchestratorViewModel } from "../src/ui/orchestratorViewModel";

function snapshotFixture(): OrchestratorSnapshotV1 {
  return {
    version: 1,
    runId: "run-1",
    mode: "code_team",
    status: "running",
    rootNodeIds: ["mission"],
    nodes: {
      mission: {
        id: "mission",
        parentId: null,
        childIds: ["research", "code"],
        kind: "mission",
        title: "Build template intelligence",
        status: "running",
        ownerId: "lead",
        dependencyIds: [],
        evidenceIds: ["evidence-1"],
        receiptIds: [],
        artifactIds: [],
        proofContract: {
          requiredEvidenceKinds: ["source"],
          minEvidenceCount: 2,
          requiredReceiptKinds: ["write"],
          verifierIds: ["claim-check"],
        },
      },
      research: {
        id: "research",
        parentId: "mission",
        childIds: [],
        kind: "research",
        title: "Find primary sources",
        status: "complete",
        ownerId: "researcher",
        dependencyIds: [],
        evidenceIds: ["evidence-1", "evidence-2"],
        receiptIds: [],
        artifactIds: ["source-note"],
        resultSummary: "Two supported findings",
      },
      code: {
        id: "code",
        parentId: "mission",
        childIds: [],
        kind: "code",
        title: "Implement catalog",
        status: "running",
        ownerId: "worker",
        dependencyIds: ["research"],
        evidenceIds: [],
        receiptIds: ["receipt-1"],
        artifactIds: ["src/catalog.ts"],
        worktreeId: "worktree-1",
        lastAction: "Running focused tests",
      },
    },
    participants: {
      lead: {
        id: "lead",
        role: "lead",
        displayName: "Lead",
        status: "verifying",
        currentNodeId: "mission",
        budget: {
          modelSteps: { used: 3, limit: 10 },
          toolCalls: { used: 2, limit: 10 },
          wallClockMs: { used: 2_000, limit: 60_000 },
        },
        handoffStatus: "accepted",
        updatedAt: "2026-07-10T00:00:05.000Z",
      },
      researcher: {
        id: "researcher",
        role: "researcher",
        displayName: "Researcher",
        status: "complete",
        currentNodeId: "research",
        budget: {
          modelSteps: { used: 2, limit: 8 },
          toolCalls: { used: 4, limit: 12 },
          wallClockMs: { used: 3_000, limit: 60_000 },
        },
        handoffStatus: "accepted",
        updatedAt: "2026-07-10T00:00:04.000Z",
      },
      worker: {
        id: "worker",
        role: "code_worker",
        displayName: "Code Worker",
        status: "coding",
        currentNodeId: "code",
        budget: {
          modelSteps: { used: 1, limit: 8 },
          toolCalls: { used: 1, limit: 12 },
          wallClockMs: { used: 1_000, limit: 60_000 },
        },
        handoffStatus: "none",
        updatedAt: "2026-07-10T00:00:05.000Z",
      },
    },
    worktrees: {
      "worktree-1": {
        id: "worktree-1",
        taskId: "code",
        repositoryRoot: "C:\\repo",
        path: "C:\\temp\\worktree-1",
        branch: "codex/agent-run-1-code",
        baseBranch: "main",
        baseSha: "1234567890abcdef",
        status: "testing",
        changedFiles: 2,
        changedFilePaths: ["src/catalog.ts", "tests/catalog.test.ts"],
        validationCommands: ["npm test"],
        currentValidationCommand: "npm test",
        validationPassed: false,
      },
    },
    handoffs: [
      {
        id: "handoff-1",
        fromParticipantId: "researcher",
        toParticipantId: "lead",
        taskId: "research",
        status: "accepted",
        summary: "Primary sources found",
        sourceIds: ["source-1"],
        evidenceIds: ["evidence-1", "evidence-2"],
        unresolvedQuestions: ["Publication date is unclear"],
        confidence: "high",
        createdAt: "2026-07-10T00:00:02.000Z",
        updatedAt: "2026-07-10T00:00:04.000Z",
      },
    ],
    merge: {
      status: "running",
      evidenceReceived: 2,
      evidenceAccepted: 1,
      evidenceRejected: 0,
      evidenceDeduplicated: 1,
      conflicts: 0,
      commitShas: ["abcdef123456"],
      verificationStatus: "pending",
      integrationStatus: "ready",
    },
    sequence: 12,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:05.000Z",
  };
}

test("orchestrator view model projects tasks, participants, worktrees, and merge state", () => {
  const view = buildOrchestratorViewModel(snapshotFixture(), {
    now: Date.parse("2026-07-10T00:00:05.000Z"),
  });

  assert.equal(view.summary.mode, "Code team");
  assert.equal(view.summary.status, "running");
  assert.equal(view.summary.completeTasks, 1);
  assert.equal(view.summary.totalTasks, 3);
  assert.equal(view.summary.evidenceCount, 2);
  assert.equal(view.summary.elapsed, "5s");
  assert.equal(view.summary.budget, "6/26 steps · 7/34 tools");
  assert.equal(view.nodes.mission?.proofContract.includes("2 evidence minimum"), true);
  assert.equal(view.agents[2]?.task, "Implement catalog");
  assert.deepEqual(view.worktrees[0]?.changedFilePaths, [
    "src/catalog.ts",
    "tests/catalog.test.ts",
  ]);
  assert.equal(
    view.worktrees[0]?.cleanupState,
    "Pending; automatic cleanup is disabled.",
  );
  assert.equal(view.handoffs[0]?.confidence, "high");
  assert.equal(view.handoffs[0]?.fromAgentId, "researcher");
  assert.equal(view.merge.received, 2);
  assert.equal(view.merge.accepted, 1);
  assert.equal(view.merge.deduplicated, 1);
  assert.equal(view.merge.verification, "pending");
  assert.equal(view.merge.integration, "ready");
});

test("orchestrator elapsed time advances while running and freezes when terminal", () => {
  const running = snapshotFixture();
  const runningView = buildOrchestratorViewModel(running, {
    now: Date.parse("2026-07-10T00:00:12.000Z"),
  });
  assert.equal(runningView.summary.elapsed, "12s");

  running.status = "complete";
  const completedView = buildOrchestratorViewModel(running, {
    now: Date.parse("2026-07-10T00:01:00.000Z"),
  });
  assert.equal(completedView.summary.elapsed, "5s");
});

test("orchestrator view model bounds task rows and removes hidden reasoning", () => {
  const snapshot = snapshotFixture();
  snapshot.nodes.mission.lastAction =
    "<think>private scratchpad</think>Gathering visible evidence";
  snapshot.nodes.mission.resultSummary =
    "Chain-of-thought: another private scratchpad";
  snapshot.nodes.extra = {
    id: "extra",
    parentId: null,
    childIds: [],
    kind: "verify",
    title: "Extra task",
    status: "queued",
    ownerId: null,
    dependencyIds: [],
    evidenceIds: [],
    receiptIds: [],
    artifactIds: [],
  };

  const view = buildOrchestratorViewModel(snapshot, {
    limits: { treeNodes: 2 },
  });

  assert.equal(Object.keys(view.nodes).length, 2);
  assert.equal(view.compacted.treeNodes, 2);
  assert.equal(view.nodes.mission?.lastAction.includes("private scratchpad"), false);
  assert.equal(view.nodes.mission?.lastAction.includes("Gathering visible evidence"), true);
  assert.equal(view.nodes.mission?.resultSummary.includes("another private"), false);
  assert.equal(view.nodes.mission?.resultSummary.includes("hidden reasoning omitted"), true);
});
