import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMissionCapabilityEnvelopeV1,
  parseMissionGraphV3,
  type MissionCapabilityEnvelopeV1,
  type MissionGraphV3,
} from "../src/agent/missionGraphV3";
import {
  LegacyMissionGraphMigrationError,
  migrateLegacyMissionPlanToMissionGraphV3,
  migrateLegacyOrchestratorSnapshotToMissionGraphV3,
  projectMissionGraphToLegacyPlan,
  projectMissionGraphToOrchestratorSnapshot,
  type LegacyMissionGraphMigrationOptionsV1,
} from "../src/agent/missionGraphLegacyProjection";
import {
  createHierarchicalMissionPlanFromV1,
  type MissionPlan,
} from "../src/agent/missionPlan";
import type { OrchestratorSnapshotV1 } from "../src/orchestrator/types";

const CREATED_AT = "2026-07-11T12:00:00.000Z";
const UPDATED_AT = "2026-07-11T12:05:00.000Z";

test("MissionGraphV3 projects status, progress, next action, evidence, and receipts into read-only legacy views", async () => {
  const envelope = await createEnvelope();
  const completeGraph = await migrateLegacyMissionPlanToMissionGraphV3(
    completePlan(),
    migrationOptions(envelope),
  );
  const legacy = projectMissionGraphToLegacyPlan(completeGraph);

  assert.equal(legacy.status, "complete");
  assert.equal(legacy.activeTaskId, null);
  assert.deepEqual(legacy.tasks[0].evidenceIds, ["web:evidence-web"]);
  assert.deepEqual(legacy.tasks[1].receiptIds, [
    "receipt-write",
    "receipt-proof:write_receipt",
  ]);
  assert.deepEqual(legacy.progress, {
    score: 1,
    completedTasks: 2,
    totalTasks: 2,
    remainingTasks: 0,
    stalledCount: 0,
    lastMeaningfulAction:
      "MissionGraphV3 is complete; synthesize the verified final answer.",
  });
  assert.equal(legacy.nextAction?.kind, "final");

  const waitingGraph = await parseMissionGraphV3({
    ...completeGraph,
    nodes: {
      ...completeGraph.nodes,
      write: {
        ...completeGraph.nodes.write,
        status: "waiting_approval",
        receipts: [],
      },
    },
  });
  const waitingLegacy = projectMissionGraphToLegacyPlan(waitingGraph);
  assert.equal(waitingLegacy.status, "in_progress");
  assert.equal(waitingLegacy.activeTaskId, "write");
  assert.equal(waitingLegacy.nextAction?.summary, "Await approval for Write the result");

  const orchestrator = projectMissionGraphToOrchestratorSnapshot(waitingGraph);
  assert.equal(orchestrator.sequence, waitingGraph.revision);
  assert.equal(orchestrator.status, "running");
  assert.equal(orchestrator.nodes.write.status, "waiting");
  assert.deepEqual(orchestrator.nodes.research.childIds, ["write"]);
  assert.equal(orchestrator.participants.lead.currentNodeId, "write");
  assert.deepEqual(orchestrator.nodes.research.evidenceIds, ["evidence-web"]);
});

test("host-added read retry nodes do not become semantic citation obligations", async () => {
  const envelope = await createEnvelope();
  const migrated = await migrateLegacyMissionPlanToMissionGraphV3(
    completePlan(),
    migrationOptions(envelope),
  );
  const retryOnlyGraph = await parseMissionGraphV3({
    ...migrated,
    nodes: {
      "retry-5-web_fetch": {
        ...migrated.nodes.research,
        id: "retry-5-web_fetch",
        allowedTools: ["web_fetch"],
      },
      write: {
        ...migrated.nodes.write,
        dependencyIds: ["retry-5-web_fetch"],
      },
    },
  });
  const projected = projectMissionGraphToLegacyPlan(retryOnlyGraph);
  assert.equal(
    projected.tasks.find((task) => task.id === "retry-5-web_fetch")
      ?.completionContract.citationMode,
    undefined,
  );
});

test("legacy citation projection preserves passage-level verification requested by the mission", async () => {
  const envelope = await createEnvelope();
  const migrated = await migrateLegacyMissionPlanToMissionGraphV3(
    completePlan(),
    {
      ...migrationOptions(envelope),
      toolNameMap: {
        ...migrationOptions(envelope).toolNameMap,
        "legacy-web": "web_fetch",
      },
      objective:
        "Fetch both sources and verify each finding against the fetched passages.",
    },
  );
  const projected = projectMissionGraphToLegacyPlan(migrated);

  assert.equal(
    projected.tasks.find((task) => task.id === "research")
      ?.completionContract.citationMode,
    "passage",
  );
});

test("legacy citation projection keeps ordinary cited research at source level", async () => {
  const envelope = await createEnvelope();
  const migrated = await migrateLegacyMissionPlanToMissionGraphV3(
    completePlan(),
    {
      ...migrationOptions(envelope),
      toolNameMap: {
        ...migrationOptions(envelope).toolNameMap,
        "legacy-web": "web_fetch",
      },
      objective: "Research the topic and include a citation.",
    },
  );
  const projected = projectMissionGraphToLegacyPlan(migrated);

  assert.equal(
    projected.tasks.find((task) => task.id === "research")
      ?.completionContract.citationMode,
    "source",
  );
});

test("legacy projection does not invent a citation contract for an external prerequisite", async () => {
  const envelope = await createEnvelope();
  const migrated = await migrateLegacyMissionPlanToMissionGraphV3(
    completePlan(),
    {
      ...migrationOptions(envelope),
      toolNameMap: {
        ...migrationOptions(envelope).toolNameMap,
        "legacy-web": "web_fetch",
      },
      objective:
        "Complete the external prerequisite, then append the exact authorized marker.",
    },
  );
  const externalGraph = await parseMissionGraphV3({
    ...migrated,
    nodes: {
      ...migrated.nodes,
      research: {
        ...migrated.nodes.research,
        outputs: {},
        evidence: [{
          id: "external-evidence-proof",
          kind: "public_web_source",
          fingerprint: `sha256:${"a".repeat(64)}`,
          observedAt: UPDATED_AT,
        }],
        verification: {
          verifierId: "companion-external-result-v1",
          status: "passed",
          fingerprint: `sha256:${"b".repeat(64)}`,
          verifiedAt: UPDATED_AT,
        },
        completionContract: {
          ...migrated.nodes.research.completionContract,
          minimumEvidence: 1,
          requiredEvidenceKinds: ["public_web_source"],
          verifierId: "companion-external-result-v1",
        },
      },
    },
  });
  const projected = projectMissionGraphToLegacyPlan(externalGraph);
  const research = projected.tasks.find((task) => task.id === "research");

  assert.equal(
    research?.completionContract.citationMode,
    undefined,
  );
  assert.deepEqual(research?.evidenceIds, ["web:external-evidence-proof"]);
  assert.deepEqual(research?.completionContract.requiredProof, ["web_evidence"]);
});

test("count_words graph nodes project metadata proof instead of vault-content proof", async () => {
  const envelope = await createEnvelope();
  const migrated = await migrateLegacyMissionPlanToMissionGraphV3(
    completePlan(),
    migrationOptions(envelope),
  );
  const countGraph = await parseMissionGraphV3({
    ...migrated,
    nodes: {
      ...migrated.nodes,
      research: {
        ...migrated.nodes.research,
        allowedTools: ["count_words"],
        evidence: migrated.nodes.research.evidence.map((item) => ({
          ...item,
          kind: "tool-result",
        })),
        completionContract: {
          ...migrated.nodes.research.completionContract,
          requiredEvidenceKinds: ["tool-result"],
        },
      },
    },
  });

  const projected = projectMissionGraphToLegacyPlan(countGraph);
  assert.deepEqual(
    projected.tasks.find((task) => task.id === "research")
      ?.completionContract.requiredProof,
    ["word_count"],
  );
  assert.deepEqual(
    projected.tasks.find((task) => task.id === "research")?.evidenceIds,
    ["tool:count_words"],
  );
});

test("semantic vault evidence IDs remain canonical through legacy projection", async () => {
  const envelope = await createEnvelope();
  const migrated = await migrateLegacyMissionPlanToMissionGraphV3(
    completePlan(),
    migrationOptions(envelope),
  );
  const semanticGraph = await parseMissionGraphV3({
    ...migrated,
    nodes: {
      ...migrated.nodes,
      research: {
        ...migrated.nodes.research,
        evidence: [{
          ...migrated.nodes.research.evidence[0],
          id: "vault_search:semantic-local-retrieval",
          kind: "tool-result",
        }],
        completionContract: {
          ...migrated.nodes.research.completionContract,
          requiredEvidenceKinds: ["tool-result"],
        },
      },
    },
  });

  const projected = projectMissionGraphToLegacyPlan(semanticGraph);
  assert.deepEqual(
    projected.tasks.find((task) => task.id === "research")?.evidenceIds,
    ["vault_search:semantic-local-retrieval"],
  );
});

test("explicit MissionPlan migration preserves proof, dependency state, and mapped budgets", async () => {
  const envelope = await createEnvelope();
  const hierarchical = createHierarchicalMissionPlanFromV1(completePlan());
  hierarchical.nodes.research.attempts = 2;
  const graph = await migrateLegacyMissionPlanToMissionGraphV3(
    hierarchical,
    migrationOptions(envelope),
  );

  assert.equal(graph.schemaVersion, 3);
  assert.equal(graph.nodes.research.status, "complete");
  assert.deepEqual(graph.nodes.research.evidence, [
    {
      id: "evidence-web",
      kind: "web-source",
      fingerprint: fp("a"),
      observedAt: UPDATED_AT,
    },
  ]);
  assert.deepEqual(graph.nodes.write.receipts, [
    {
      id: "receipt-write",
      kind: "vault-write",
      fingerprint: fp("b"),
      committedAt: UPDATED_AT,
    },
  ]);
  assert.deepEqual(graph.nodes.write.budget, {
    toolCalls: 2,
    externalActions: 0,
    wallClockMs: 8_000,
  });
  assert.deepEqual(graph.nodes.write.dependencyIds, ["research"]);
  assert.equal(graph.nodes.research.retries.attempts, 2);
  assert.equal(graph.routing.source, "deterministic");
});

test("MissionPlan migration fails closed on unknown tools, cycles, and proof-incomplete completion", async () => {
  const envelope = await createEnvelope();
  const unknownToolOptions = migrationOptions(envelope);
  unknownToolOptions.toolNameMap = { "legacy-append": "append-note" };
  await rejectsMigration(
    migrateLegacyMissionPlanToMissionGraphV3(
      completePlan(),
      unknownToolOptions,
    ),
    "unknown_tool_mapping",
  );

  const cyclic = completePlan();
  cyclic.status = "in_progress";
  cyclic.activeTaskId = "research";
  cyclic.tasks[0].status = "pending";
  cyclic.tasks[1].status = "pending";
  cyclic.tasks[0].dependencies = ["write"];
  cyclic.tasks[1].dependencies = ["research"];
  await rejectsMigration(
    migrateLegacyMissionPlanToMissionGraphV3(
      cyclic,
      migrationOptions(envelope),
    ),
    "cycle",
  );

  const incomplete = completePlan();
  incomplete.tasks[0].evidenceIds = [];
  await rejectsMigration(
    migrateLegacyMissionPlanToMissionGraphV3(
      incomplete,
      migrationOptions(envelope),
    ),
    "proof_incomplete",
  );
});

test("Orchestrator migration is explicit and rejects missing executor mappings and cycles", async () => {
  const envelope = await createEnvelope();
  const graph = await migrateLegacyMissionPlanToMissionGraphV3(
    completePlan(),
    migrationOptions(envelope),
  );
  const snapshot = projectMissionGraphToOrchestratorSnapshot(graph);
  const options = migrationOptions(envelope);
  options.nodeMappings = {
    research: {
      ...options.nodeMappings.research,
      legacyToolNames: ["legacy-web"],
    },
    write: {
      ...options.nodeMappings.write,
      legacyToolNames: ["legacy-append"],
    },
  };
  const migrated = await migrateLegacyOrchestratorSnapshotToMissionGraphV3(
    snapshot,
    options,
  );
  assert.deepEqual(migrated.nodes.write.dependencyIds, ["research"]);
  assert.deepEqual(migrated.nodes.write.outputs, {
    legacyResultSummary:
      "Verified with 0 evidence reference(s) and 1 receipt(s).",
  });

  const missing = migrationOptions(envelope);
  missing.nodeMappings = { research: missing.nodeMappings.research };
  await rejectsMigration(
    migrateLegacyOrchestratorSnapshotToMissionGraphV3(snapshot, missing),
    "unknown_executor_mapping",
  );

  const cyclic = clone(snapshot);
  cyclic.nodes.research.dependencyIds = ["write"];
  cyclic.nodes.write.dependencyIds = ["research"];
  await rejectsMigration(
    migrateLegacyOrchestratorSnapshotToMissionGraphV3(cyclic, options),
    "cycle",
  );
});

test("Orchestrator hierarchy cycles are rejected instead of normalized away", async () => {
  const envelope = await createEnvelope();
  const graph = await migrateLegacyMissionPlanToMissionGraphV3(
    completePlan(),
    migrationOptions(envelope),
  );
  const snapshot = projectMissionGraphToOrchestratorSnapshot(graph);
  snapshot.nodes.research.parentId = "write";
  snapshot.nodes.write.parentId = "research";
  const options = migrationOptions(envelope);
  options.nodeMappings.research.legacyToolNames = ["legacy-web"];
  options.nodeMappings.write.legacyToolNames = ["legacy-append"];

  await rejectsMigration(
    migrateLegacyOrchestratorSnapshotToMissionGraphV3(snapshot, options),
    "cycle",
  );
});

async function createEnvelope(): Promise<MissionCapabilityEnvelopeV1> {
  return buildMissionCapabilityEnvelopeV1({
    missionId: "legacy-mission",
    issuedAt: CREATED_AT,
    expiresAt: null,
    capabilities: ["web.read", "vault.write"],
    executionHosts: ["obsidian_core"],
    executors: {
      core: {
        id: "core",
        executionHosts: ["obsidian_core"],
        allowedEffects: ["read", "mutation"],
      },
    },
    verifiers: ["companion-external-result-v1"],
    tools: {
      "web-search": {
        name: "web-search",
        effect: "read",
        capabilityIds: ["web.read"],
        executionHosts: ["obsidian_core"],
        bindingKinds: [],
      },
      web_fetch: {
        name: "web_fetch",
        effect: "read",
        capabilityIds: ["web.read"],
        executionHosts: ["obsidian_core"],
        bindingKinds: [],
      },
      count_words: {
        name: "count_words",
        effect: "read",
        capabilityIds: ["web.read"],
        executionHosts: ["obsidian_core"],
        bindingKinds: [],
      },
      "append-note": {
        name: "append-note",
        effect: "mutation",
        capabilityIds: ["vault.write"],
        executionHosts: ["obsidian_core"],
        bindingKinds: ["vault-note"],
      },
    },
    bindings: {
      "note-main": {
        id: "note-main",
        kind: "vault-note",
        destinationFingerprint: fp("c"),
        allowedEffects: ["read", "mutation"],
      },
    },
    budgets: {
      maxNodes: 16,
      maxDepth: 4,
      maxConcurrentReadNodes: 3,
      maxTotalToolCalls: 8,
      maxExternalActions: 0,
      maxWallClockMs: 30_000,
      maxAttemptsPerNode: 3,
    },
  });
}

function completePlan(): MissionPlan {
  return {
    version: 1,
    runId: "legacy-mission",
    status: "complete",
    activeTaskId: null,
    tasks: [
      {
        id: "research",
        title: "Research the claim",
        status: "complete",
        allowedTools: ["legacy-web"],
        dependencies: [],
        evidenceIds: ["evidence-web"],
        receiptIds: [],
        completionContract: {
          requiredProof: ["web_evidence"],
          minEvidenceCount: 1,
        },
      },
      {
        id: "write",
        title: "Write the result",
        status: "complete",
        allowedTools: ["legacy-append"],
        dependencies: ["research"],
        evidenceIds: [],
        receiptIds: ["receipt-write"],
        completionContract: { requiredProof: ["write_receipt"] },
      },
    ],
    progress: {
      score: 1,
      completedTasks: 2,
      totalTasks: 2,
      remainingTasks: 0,
      stalledCount: 0,
    },
    nextAction: {
      kind: "final",
      summary: "Legacy completion text must not become authority.",
    },
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function migrationOptions(
  capabilityEnvelope: MissionCapabilityEnvelopeV1,
): LegacyMissionGraphMigrationOptionsV1 {
  return {
    capabilityEnvelope,
    objective: "Research and write a verified result.",
    toolNameMap: {
      "legacy-web": "web-search",
      "legacy-append": "append-note",
    },
    nodeMappings: {
      research: {
        executorId: "core",
        executionHost: "obsidian_core",
        effect: "read",
        budget: {
          toolCalls: 1,
          externalActions: 0,
          wallClockMs: 5_000,
        },
        maxAttempts: 3,
      },
      write: {
        executorId: "core",
        executionHost: "obsidian_core",
        effect: "mutation",
        destination: {
          bindingId: "note-main",
          effect: "mutation",
          selector: "Research.md",
        },
        resourceLocks: [{ bindingId: "note-main", mode: "exclusive" }],
        budget: {
          toolCalls: 2,
          externalActions: 0,
          wallClockMs: 8_000,
        },
        maxAttempts: 3,
      },
    },
    evidenceReferences: {
      "evidence-web": {
        id: "evidence-web",
        kind: "web-source",
        fingerprint: fp("a"),
        observedAt: UPDATED_AT,
      },
    },
    receiptReferences: {
      "receipt-write": {
        id: "receipt-write",
        kind: "vault-write",
        fingerprint: fp("b"),
        committedAt: UPDATED_AT,
      },
    },
  };
}

async function rejectsMigration(
  promise: Promise<unknown>,
  code: LegacyMissionGraphMigrationError["code"],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LegacyMissionGraphMigrationError);
    assert.equal(error.code, code);
    return true;
  });
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
