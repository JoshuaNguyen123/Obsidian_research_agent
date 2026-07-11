import test from "node:test";
import assert from "node:assert/strict";
import {
  reduceOrchestratorEvent,
  replayOrchestratorEvents,
} from "../src/orchestrator/orchestratorReducer";
import { SharedBudget } from "../src/orchestrator/sharedBudget";
import {
  normalizeOrchestratorSnapshot,
  OrchestratorStore,
  parseOrchestratorSnapshot,
  serializeOrchestratorSnapshot,
  type OrchestratorSnapshotRepository,
} from "../src/orchestrator/orchestratorStore";
import type {
  AgentParticipant,
  OrchestratorEvent,
  OrchestratorWorkNode,
} from "../src/orchestrator/types";

const NOW = "2026-07-10T12:00:00.000Z";

test("orchestrator reducer projects a visible team lifecycle and ignores duplicate events", () => {
  const lead = participant("lead", "lead");
  const researcher = participant("researcher", "researcher");
  const root = node("mission", null, "Mission");
  const research = node("research", "mission", "Research sources", "research");
  const events: OrchestratorEvent[] = [
    event(1, {
      kind: "orchestrator_started",
      mode: "research_team",
      participants: [lead, researcher],
      rootNodes: [root],
    }),
    event(2, { kind: "node_created", node: research }),
    event(3, {
      kind: "node_assigned",
      nodeId: "research",
      ownerId: "researcher",
    }),
    event(4, {
      kind: "node_progressed",
      nodeId: "research",
      status: "running",
      lastAction: "Fetching primary sources",
      evidenceIds: ["evidence:1"],
    }),
    event(5, {
      kind: "evidence_added",
      nodeId: "research",
      evidenceId: "evidence:1",
    }),
    event(6, {
      kind: "worktree_updated",
      worktree: {
        id: "tree-1",
        taskId: "research",
        repositoryRoot: "C:/repo",
        path: "C:/temp/tree-1",
        branch: "codex/agent-run-research",
        baseBranch: "main",
        baseSha: "abc123",
        status: "testing",
        changedFiles: 2,
        validationCommands: ["npm test"],
        validationPassed: false,
      },
    }),
    event(7, {
      kind: "handoff_ready",
      handoff: {
        id: "handoff-1",
        fromParticipantId: "researcher",
        toParticipantId: "lead",
        taskId: "research",
        status: "ready",
        summary: "Two supported findings.",
        sourceIds: ["source:1"],
        evidenceIds: ["evidence:1"],
        unresolvedQuestions: [],
        confidence: "high",
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    event(8, { kind: "merge_started" }),
    event(9, {
      kind: "merge_updated",
      patch: {
        evidenceReceived: 1,
        evidenceAccepted: 1,
        evidenceDeduplicated: 0,
      },
    }),
    event(10, { kind: "verification_updated", status: "passed" }),
    event(11, {
      kind: "node_completed",
      nodeId: "research",
      resultSummary: "Research complete.",
    }),
    event(12, { kind: "run_completed", status: "complete" }),
  ];

  const snapshot = replayOrchestratorEvents(events);
  assert.equal(snapshot?.status, "complete");
  assert.deepEqual(snapshot?.rootNodeIds, ["mission"]);
  assert.deepEqual(snapshot?.nodes.mission.childIds, ["research"]);
  assert.equal(snapshot?.nodes.research.ownerId, "researcher");
  assert.deepEqual(snapshot?.nodes.research.evidenceIds, ["evidence:1"]);
  assert.equal(snapshot?.nodes.research.worktreeId, "tree-1");
  assert.equal(snapshot?.participants.researcher.handoffStatus, "ready");
  assert.equal(snapshot?.merge.verificationStatus, "passed");

  const duplicate = reduceOrchestratorEvent(snapshot!, events[11]);
  assert.equal(duplicate, snapshot);
});

test("snapshot normalization migrates legacy tasks to a safe single-lead tree", () => {
  const restored = normalizeOrchestratorSnapshot({
    runId: "run-legacy",
    tasks: [
      {
        id: "root",
        title: "Legacy mission",
        status: "in_progress",
        dependencies: ["missing", "root"],
      },
      {
        id: "child",
        parentId: "root",
        title: "Legacy task",
        status: "complete",
        ownerId: "missing-worker",
      },
      { id: "__proto__", title: "unsafe" },
    ],
    rootNodeIds: ["missing"],
    sequence: -5,
  });

  assert.equal(restored?.version, 1);
  assert.equal(restored?.mode, "single");
  assert.deepEqual(Object.keys(restored?.participants ?? {}), ["lead"]);
  assert.equal(restored?.nodes.root.status, "running");
  assert.equal(restored?.nodes.child.ownerId, null);
  assert.deepEqual(restored?.nodes.root.childIds, ["child"]);
  assert.deepEqual(restored?.nodes.root.dependencyIds, []);
  assert.deepEqual(restored?.rootNodeIds, ["root"]);
  assert.equal(restored?.sequence, 0);
  assert.equal("__proto__" in (restored?.nodes ?? {}), true);
  assert.equal(Object.prototype.hasOwnProperty.call(restored?.nodes, "__proto__"), false);

  const json = serializeOrchestratorSnapshot(restored!);
  assert.deepEqual(parseOrchestratorSnapshot(json), restored);
  assert.equal(parseOrchestratorSnapshot("not-json"), null);
});

test("shared budget commits batches atomically and protects the lead reserve", () => {
  const budget = new SharedBudget({
    modelSteps: 10,
    toolCalls: 8,
    wallClockMs: 1_000,
    finalizationReserveModelSteps: 2,
  });
  budget.registerParticipant("lead", {
    limits: { modelSteps: 10, toolCalls: 8, wallClockMs: 1_000 },
    canUseFinalizationReserve: true,
  });
  budget.registerParticipant("researcher", {
    limits: { modelSteps: 8, toolCalls: 4, wallClockMs: 600 },
  });

  assert.equal(
    budget.tryConsume({ participantId: "researcher", resource: "modelSteps", amount: 8 })
      .accepted,
    true,
  );
  const beforeRejectedBatch = budget.getSnapshot();
  const rejected = budget.tryConsumeMany([
    { participantId: "researcher", resource: "toolCalls", amount: 2 },
    { participantId: "researcher", resource: "toolCalls", amount: 3 },
  ]);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "participant_limit");
  assert.deepEqual(budget.getSnapshot(), beforeRejectedBatch);

  assert.equal(
    budget.tryConsume({ participantId: "lead", resource: "modelSteps" }).reason,
    "finalization_reserve",
  );
  assert.equal(
    budget.tryConsume({
      participantId: "lead",
      resource: "modelSteps",
      amount: 2,
      allowFinalizationReserve: true,
    }).accepted,
    true,
  );
  assert.deepEqual(budget.toParticipantBudget("lead")?.modelSteps, {
    used: 2,
    limit: 10,
  });
});

test("orchestrator store serializes concurrent event persistence by run", async () => {
  const writes: number[] = [];
  let persisted: unknown = null;
  const repository: OrchestratorSnapshotRepository = {
    async read() {
      return persisted;
    },
    async write(snapshot) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      writes.push(snapshot.sequence);
      persisted = snapshot;
    },
  };
  const store = new OrchestratorStore(repository);
  await store.append(
    event(1, {
      kind: "orchestrator_started",
      mode: "single",
      rootNodes: [node("mission", null, "Mission")],
    }),
  );
  await Promise.all([
    store.append(event(2, { kind: "node_completed", nodeId: "mission" })),
    store.append(event(3, { kind: "run_completed", status: "complete" })),
  ]);

  assert.deepEqual(writes, [1, 2, 3]);
  assert.equal(store.get("run-1")?.status, "complete");
  const restoredStore = new OrchestratorStore(repository);
  assert.equal((await restoredStore.restore("run-1"))?.sequence, 3);
});

function event<T extends Omit<OrchestratorEvent, "runId" | "sequence" | "occurredAt">>(
  sequence: number,
  value: T,
): OrchestratorEvent {
  return {
    ...value,
    runId: "run-1",
    sequence,
    occurredAt: new Date(Date.parse(NOW) + sequence * 1_000).toISOString(),
  } as OrchestratorEvent;
}

function participant(
  id: string,
  role: AgentParticipant["role"],
): AgentParticipant {
  return {
    id,
    role,
    displayName: role === "lead" ? "Lead" : "Researcher",
    status: role === "lead" ? "planning" : "queued",
    currentNodeId: null,
    budget: {
      modelSteps: { used: 0, limit: role === "lead" ? 100 : 20 },
      toolCalls: { used: 0, limit: role === "lead" ? 100 : 24 },
      wallClockMs: { used: 0, limit: role === "lead" ? 3_600_000 : 900_000 },
    },
    handoffStatus: "none",
    updatedAt: NOW,
  };
}

function node(
  id: string,
  parentId: string | null,
  title: string,
  kind: OrchestratorWorkNode["kind"] = "mission",
): OrchestratorWorkNode {
  return {
    id,
    parentId,
    childIds: [],
    kind,
    title,
    status: "queued",
    ownerId: null,
    dependencyIds: [],
    evidenceIds: [],
    receiptIds: [],
    artifactIds: [],
  };
}

