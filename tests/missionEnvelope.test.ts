import assert from "node:assert/strict";
import test from "node:test";
import { createMissionEnvelopeV2 } from "../src/orchestrator/missionEnvelope";

test("createMissionEnvelopeV2 preserves trusted bindings and graph proof", () => {
  const envelope = createMissionEnvelopeV2({
    missionId: "run-linear-1",
    objective: "Implement the accepted Linear ticket.",
    origin: {
      system: "linear",
      contractFingerprint: "a".repeat(64),
      resource: {
        system: "linear",
        resourceType: "issue",
        id: "issue-1",
        identifier: "ENG-1",
      },
    },
    trustedBindings: {
      repositoryProfileKey: "research-agent",
      vaultPaths: [],
      linearWorkspaceId: "workspace-1",
      linearProjectId: "project-1",
    },
    workGraph: {
      rootNodeIds: ["root"],
      nodes: {
        root: {
          id: "root",
          parentId: null,
          childIds: ["code"],
          kind: "mission",
          status: "ready",
          owner: "lead",
          dependencyIds: [],
          resources: [],
          requiredCapabilities: [],
          requiredProofKinds: [],
          acceptanceCriteriaIds: [],
          actionIds: [],
          receiptIds: [],
        },
        code: {
          id: "code",
          parentId: "root",
          childIds: [],
          kind: "code_work",
          status: "queued",
          owner: "code_worker",
          dependencyIds: [],
          resources: [
            { system: "git", resourceType: "repository", id: "research-agent" },
          ],
          requiredCapabilities: ["workspace.edit"],
          requiredProofKinds: ["local_promotion"],
          acceptanceCriteriaIds: ["AC-1"],
          actionIds: [],
          receiptIds: [],
        },
      },
    },
    grantId: "grant-1",
    budgets: {
      modelSteps: 100,
      toolCalls: 100,
      externalActions: 10,
      wallClockMs: 60_000,
    },
    acceptanceContract: { requiredProof: ["code_execution"] },
    lineage: { generation: 0 },
  });

  assert.equal(envelope.schemaVersion, 2);
  assert.equal(envelope.origin.contractFingerprint, `sha256:${"a".repeat(64)}`);
  assert.equal(envelope.workGraph.nodes.code.owner, "code_worker");
});

test("createMissionEnvelopeV2 rejects graph cycles and unreachable nodes", () => {
  assert.throws(
    () =>
      createMissionEnvelopeV2({
        missionId: "run-1",
        objective: "Invalid graph",
        origin: { system: "chat" },
        trustedBindings: { vaultPaths: [] },
        workGraph: {
          rootNodeIds: ["root"],
          nodes: {
            root: {
              id: "root",
              parentId: null,
              childIds: [],
              kind: "mission",
              status: "ready",
              owner: "lead",
              dependencyIds: [],
              resources: [],
              requiredCapabilities: [],
              requiredProofKinds: [],
              acceptanceCriteriaIds: [],
              actionIds: [],
              receiptIds: [],
            },
            orphan: {
              id: "orphan",
              parentId: null,
              childIds: [],
              kind: "research",
              status: "queued",
              owner: "researcher",
              dependencyIds: [],
              resources: [],
              requiredCapabilities: [],
              requiredProofKinds: [],
              acceptanceCriteriaIds: [],
              actionIds: [],
              receiptIds: [],
            },
          },
        },
        budgets: {
          modelSteps: 1,
          toolCalls: 1,
          externalActions: 0,
          wallClockMs: 1,
        },
        acceptanceContract: { requiredProof: [] },
        lineage: { generation: 0 },
      }),
    /reachable/,
  );
});

