import assert from "node:assert/strict";
import test from "node:test";
import { projectMissionGraphRunDetails } from "../packages/headless-runtime/src/missionGraphProjection";
import type {
  MissionGraphV3,
  MissionNodeStatusV3,
  MissionNodeV3,
} from "../packages/headless-runtime/src/missionGraphV3";

test("Run Details projection exposes observable active-node state only", () => {
  const graph = graphFixture([
    node("research", [], "complete"),
    node("write", ["research"], "waiting_approval", {
      blocker: {
        code: "approval_required",
        message: "Exact write approval is required.",
        requiredAction: "Approve the prepared write.",
      },
      attempts: 2,
      evidenceIds: ["evidence-1"],
      receiptIds: ["receipt-1"],
    }),
  ]);

  const projection = projectMissionGraphRunDetails(graph);
  assert.equal(projection.objective, "Research then update the note");
  assert.equal(projection.revision, 4);
  assert.equal(projection.routingSource, "structured_model");
  assert.equal(projection.activeNode?.id, "write");
  assert.equal(projection.activeNode?.attempts, 2);
  assert.deepEqual(projection.activeNode?.evidenceIds, ["evidence-1"]);
  assert.deepEqual(projection.activeNode?.receiptIds, ["receipt-1"]);
  assert.equal(projection.nextAction, "Approve the prepared write.");
  assert.equal(JSON.stringify(projection).includes("reasoning"), false);
  assert.equal(JSON.stringify(projection).includes("rationale"), false);
});

test("projection selects nodes in dependency order and reports terminal graphs", () => {
  const graph = graphFixture([
    node("verify", ["write"], "complete"),
    node("write", ["read"], "complete"),
    node("read", [], "complete"),
  ]);
  const projection = projectMissionGraphRunDetails(graph);
  assert.equal(projection.activeNode, null);
  assert.equal(projection.completedNodeCount, 3);
  assert.equal(projection.totalNodeCount, 3);
  assert.equal(projection.nextAction, "Mission graph is terminal.");
});

function graphFixture(nodes: MissionNodeV3[]): MissionGraphV3 {
  return {
    schemaVersion: 3,
    missionId: "mission-projection",
    objective: "Research then update the note",
    revision: 4,
    journalHeadFingerprint: null,
    createdAt: "2026-07-11T12:00:00.000Z",
    updatedAt: "2026-07-11T12:01:00.000Z",
    routing: {
      source: "structured_model",
      fallbackFrom: null,
      fallbackReason: null,
      confidence: 0.96,
      decidedAt: "2026-07-11T12:00:00.000Z",
      decisionFingerprint: `sha256:${"a".repeat(64)}`,
    },
    continuationCheckpoint: null,
    capabilityEnvelope: {} as MissionGraphV3["capabilityEnvelope"],
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
  };
}

function node(
  id: string,
  dependencyIds: string[],
  status: MissionNodeStatusV3,
  options: {
    blocker?: MissionNodeV3["blocker"];
    attempts?: number;
    evidenceIds?: string[];
    receiptIds?: string[];
  } = {},
): MissionNodeV3 {
  return {
    id,
    dependencyIds,
    objective: `${id} objective`,
    executorId: "core",
    executionHost: "obsidian_core",
    effect: id === "read" || id === "research" ? "read" : "mutation",
    inputs: {},
    outputs: {},
    requiredCapabilities: [],
    allowedTools: [],
    destination: null,
    resourceLocks: [],
    budget: { toolCalls: 1, externalActions: 0, wallClockMs: 60_000 },
    retries: {
      maxAttempts: 3,
      attempts: options.attempts ?? 0,
      failureFingerprints: [],
      consecutiveFailureFingerprint: null,
      consecutiveFailureCount: 0,
    },
    status,
    evidence: (options.evidenceIds ?? []).map((evidenceId) => ({
      id: evidenceId,
      kind: "fixture",
      fingerprint: `sha256:${"b".repeat(64)}`,
      observedAt: "2026-07-11T12:00:30.000Z",
    })),
    receipts: (options.receiptIds ?? []).map((receiptId) => ({
      id: receiptId,
      kind: "fixture",
      fingerprint: `sha256:${"c".repeat(64)}`,
      committedAt: "2026-07-11T12:00:45.000Z",
    })),
    verification: null,
    completionContract: {
      criteria: [],
      minimumEvidence: 0,
      requiredEvidenceKinds: [],
      minimumReceipts: 0,
      requiredReceiptKinds: [],
      verifierId: null,
    },
    blocker: options.blocker ?? null,
  };
}
