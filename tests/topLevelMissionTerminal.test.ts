import assert from "node:assert/strict";
import test from "node:test";
import { resolveTopLevelMissionTerminalV1 } from "../src/agent/topLevelMissionTerminal";
import {
  createTopLevelChildTerminalCheckpointV1,
  parseTopLevelChildTerminalCheckpointV1,
  reconcileTopLevelChildTerminalProjectionV1,
} from "../src/agent/topLevelMissionRecovery";
import { replayOrchestratorEvents } from "../src/orchestrator/orchestratorReducer";
import type {
  AgentParticipant,
  OrchestratorEvent,
  OrchestratorWorkNode,
} from "../src/orchestrator/types";

test("verified child completion completes the parent contract", () => {
  assert.equal(
    resolveTopLevelMissionTerminalV1({ childStatus: "complete" }).kind,
    "complete",
  );
});

test("blocked, cancelled, and failed children map to distinct parent terminals", () => {
  const blocked = resolveTopLevelMissionTerminalV1({ childStatus: "blocked" });
  assert.equal(blocked.kind, "blocked");
  assert.ok(blocked.requiredAction);

  const cancelled = resolveTopLevelMissionTerminalV1({
    childStatus: "blocked",
    userStopped: true,
  });
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.requiredAction, null);

  const failed = resolveTopLevelMissionTerminalV1({ childStatus: "failed" });
  assert.equal(failed.kind, "failed");
  assert.equal(failed.code, "direct_executor_failed");
});

test("missing child readback becomes a recoverable blocker, never running", () => {
  const terminal = resolveTopLevelMissionTerminalV1({ childStatus: null });
  assert.equal(terminal.kind, "blocked");
  assert.match(terminal.message, /did not return a readback snapshot/i);
});

test("startup reconciliation completes a running canonical parent from its terminal child checkpoint", () => {
  const snapshot = canonicalRunningSnapshot();
  const checkpoint = createTopLevelChildTerminalCheckpointV1({
    parentRunId: "run-1",
    childRunId: "run-1",
    terminal: resolveTopLevelMissionTerminalV1({ childStatus: "complete" }),
    observedAt: "2026-08-07T12:05:00.000Z",
  });

  const reconciled = reconcileTopLevelChildTerminalProjectionV1(
    snapshot,
    checkpoint,
  );
  assert.equal(reconciled?.status, "complete");
  assert.equal(reconciled?.nodes.dispatch.status, "complete");
  assert.equal(reconciled?.nodes.final.status, "complete");
  assert.equal(reconciled?.participants.lead.status, "complete");
  assert.equal(reconciled?.participants.lead.currentNodeId, null);
  assert.equal(reconciled?.merge.verificationStatus, "passed");
});

test("startup reconciliation preserves a blocked child as one actionable terminal parent", () => {
  const snapshot = canonicalRunningSnapshot();
  const checkpoint = createTopLevelChildTerminalCheckpointV1({
    parentRunId: "run-1",
    childRunId: "run-1",
    terminal: resolveTopLevelMissionTerminalV1({ childStatus: "blocked" }),
  });

  const reconciled = reconcileTopLevelChildTerminalProjectionV1(
    snapshot,
    checkpoint,
  );
  assert.equal(reconciled?.status, "blocked");
  assert.equal(reconciled?.nodes.dispatch.status, "blocked");
  assert.equal(reconciled?.nodes.final.status, "blocked");
  assert.equal(reconciled?.participants.lead.status, "blocked");
  assert.match(reconciled?.nodes.final.blocker ?? "", /proof requirement/i);
  assert.equal(parseTopLevelChildTerminalCheckpointV1({ version: 2 }), null);
});

function canonicalRunningSnapshot() {
  const events: OrchestratorEvent[] = [
    terminalEvent(1, {
      kind: "orchestrator_started",
      mode: "research_team",
      participants: [leadParticipant()],
      rootNodes: [workNode("dispatch"), workNode("final")],
    }),
    terminalEvent(2, {
      kind: "node_progressed",
      nodeId: "dispatch",
      status: "running",
      lastAction: "Running child executor",
    }),
  ];
  const snapshot = replayOrchestratorEvents(events);
  assert.ok(snapshot);
  return snapshot;
}

function terminalEvent<
  T extends Omit<OrchestratorEvent, "runId" | "sequence" | "occurredAt">,
>(sequence: number, value: T): OrchestratorEvent {
  return {
    ...value,
    runId: "run-1",
    sequence,
    occurredAt: new Date(Date.parse("2026-08-07T12:00:00.000Z") + sequence).toISOString(),
  } as OrchestratorEvent;
}

function leadParticipant(): AgentParticipant {
  return {
    id: "lead",
    role: "lead",
    displayName: "Lead",
    status: "researching",
    currentNodeId: "dispatch",
    budget: {
      modelSteps: { used: 1, limit: 6 },
      toolCalls: { used: 0, limit: 4 },
      wallClockMs: { used: 1, limit: 180_000 },
    },
    handoffStatus: "none",
    updatedAt: "2026-08-07T12:00:00.000Z",
  };
}

function workNode(id: "dispatch" | "final"): OrchestratorWorkNode {
  return {
    id,
    parentId: null,
    childIds: [],
    kind: id === "dispatch" ? "research" : "verify",
    title: id === "dispatch" ? "Run child" : "Finalize",
    status: "queued",
    ownerId: "lead",
    dependencyIds: id === "final" ? ["dispatch"] : [],
    evidenceIds: [],
    receiptIds: [],
    artifactIds: [],
  };
}
