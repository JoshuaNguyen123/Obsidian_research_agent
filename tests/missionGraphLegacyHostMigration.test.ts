import assert from "node:assert/strict";
import test from "node:test";
import { migrateLegacyPlanWithHostAuthority } from "../src/agent/missionGraphLegacyHostMigration";
import { projectMissionGraphToLegacyPlan } from "../src/agent/missionGraphLegacyProjection";
import { buildHostMissionGraphPlanV1 } from "../src/agent/missionGraphHost";
import { descriptorFor } from "../src/tools/toolDescriptors";
import type { MissionEvidence } from "../src/agent/missionLedger";
import type { MissionPlan } from "../src/agent/missionPlan";
import type { ToolRegistry } from "../src/tools/types";

const NOW = new Date("2026-07-11T20:00:00.000Z");

test("legacy host migration canonicalizes unsafe proof ids while preserving compatibility aliases", async () => {
  const registry = registryFor(["web_search", "web_fetch"]);
  const hostPlan = await buildHostMissionGraphPlanV1({
    missionId: "run-legacy-proof",
    objective: "Resume accepted web research.",
    toolRegistry: registry,
    allowedToolNames: ["web_search", "web_fetch"],
    plannedToolNames: ["web_search", "web_fetch"],
    maxToolCalls: 8,
    maxWallClockMs: 60_000,
    now: NOW,
  });
  const evidence: MissionEvidence = {
    id: "web_fetch:https://example.com/source",
    kind: "web_source",
    title: "Accepted source",
    url: "https://example.com/source",
    summary: "Durable source evidence.",
    confidence: "high",
  };
  const plan = legacyPlan({
    runId: "run-legacy-proof",
    allowedTools: ["web_search", "web_fetch"],
    evidenceIds: [evidence.id],
    requiredProof: ["web_evidence"],
    status: "complete",
  });

  const graph = await migrateLegacyPlanWithHostAuthority({
    plan,
    missionId: plan.runId,
    objective: "Resume accepted web research.",
    hostPlan,
    toolRegistry: registry,
    evidence: [evidence],
    receipts: [],
  });

  const node = graph.nodes["legacy-task"];
  assert.equal(node.status, "complete");
  assert.equal(node.evidence.length, 1);
  assert.doesNotMatch(node.evidence[0].id, /https?:\/\//);
  assert.match(node.evidence[0].fingerprint, /^sha256:[a-f0-9]{64}$/);
  const projected = projectMissionGraphToLegacyPlan(graph);
  assert.deepEqual(projected.tasks[0].evidenceIds, [evidence.id]);
});

test("legacy host migration requeues safe in-progress mutation and fails on missing proof", async () => {
  const registry = registryFor(["append_to_current_file"]);
  const hostPlan = await buildHostMissionGraphPlanV1({
    missionId: "run-legacy-write",
    objective: "Append the retained result.",
    toolRegistry: registry,
    allowedToolNames: ["append_to_current_file"],
    plannedToolNames: ["append_to_current_file"],
    currentNotePath: "Current.md",
    maxToolCalls: 2,
    maxWallClockMs: 30_000,
    now: NOW,
  });
  const pending = legacyPlan({
    runId: "run-legacy-write",
    allowedTools: ["append_to_current_file"],
    evidenceIds: [],
    requiredProof: ["write_receipt"],
    status: "in_progress",
  });

  const graph = await migrateLegacyPlanWithHostAuthority({
    plan: pending,
    missionId: pending.runId,
    objective: "Append the retained result.",
    hostPlan,
    toolRegistry: registry,
    evidence: [],
    receipts: [],
  });
  assert.equal(graph.nodes["legacy-task"].status, "ready");
  assert.equal(graph.nodes["legacy-task"].destination?.selector, "Current.md");

  const completedWithoutProof = {
    ...pending,
    status: "complete" as const,
    tasks: pending.tasks.map((task) => ({ ...task, status: "complete" as const })),
  };
  await assert.rejects(
    migrateLegacyPlanWithHostAuthority({
      plan: completedWithoutProof,
      missionId: completedWithoutProof.runId,
      objective: "Append the retained result.",
      hostPlan,
      toolRegistry: registry,
      evidence: [],
      receipts: [],
    }),
    /receipt .* unavailable|without its proof/i,
  );
});

function legacyPlan(input: {
  runId: string;
  allowedTools: string[];
  evidenceIds: string[];
  requiredProof: MissionPlan["tasks"][number]["completionContract"]["requiredProof"];
  status: MissionPlan["tasks"][number]["status"];
}): MissionPlan {
  return {
    version: 1,
    runId: input.runId,
    status: input.status,
    activeTaskId: input.status === "complete" ? null : "legacy-task",
    tasks: [
      {
        id: "legacy-task",
        title: "Legacy task",
        status: input.status,
        allowedTools: input.allowedTools,
        dependencies: [],
        evidenceIds: input.evidenceIds,
        receiptIds: [],
        completionContract: {
          requiredProof: input.requiredProof,
          minEvidenceCount: input.evidenceIds.length || undefined,
        },
      },
    ],
    progress: {
      score: input.status === "complete" ? 1 : 0.5,
      completedTasks: input.status === "complete" ? 1 : 0,
      totalTasks: 1,
      remainingTasks: input.status === "complete" ? 0 : 1,
      stalledCount: 0,
    },
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:05:00.000Z",
  };
}

function registryFor(names: string[]): ToolRegistry {
  const descriptors = new Map(
    names.map((name) => [name, descriptorFor(name)] as const),
  );
  return {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" as const } },
      })),
    getDescriptor: (name) => descriptors.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
}
