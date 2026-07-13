import {
  flattenMissionPlanTasks,
  CODE_RUN_SUCCESS_EVIDENCE_ID,
  FINAL_OUTPUT_RELEVANT_EVIDENCE_ID,
  RECEIPT_PROOF_ID_PREFIX,
  normalizeMissionPlan,
  normalizeMissionPlanV2,
  type MissionCompletionContract,
  type MissionPlan,
  type MissionPlanAction,
  type MissionPlanLike,
  type MissionPlanProofKind,
  type MissionPlanStatus,
  type MissionPlanTask,
} from "./missionPlan";
import {
  parseMissionCapabilityEnvelopeV1,
  parseMissionGraphV3,
  type MissionAuthorityEffectV1,
  type MissionCapabilityEnvelopeV1,
  type MissionCompletionContractV3,
  type MissionDestinationV1,
  type MissionEvidenceRefV1,
  type MissionExecutionHostV1,
  type MissionGraphV3,
  type MissionJsonValueV1,
  type MissionNodeBudgetV1,
  type MissionNodeInputV1,
  type MissionNodeStatusV3,
  type MissionNodeV3,
  type MissionReceiptRefV1,
  type MissionResourceLockRequirementV1,
  type MissionRoutingDecisionV1,
  type MissionVerificationRefV1,
} from "./missionGraphV3";
import { sha256Fingerprint } from "../../packages/headless-runtime/src/canonicalize";
import {
  normalizeOrchestratorSnapshot,
} from "../orchestrator/orchestratorStore";
import {
  ORCHESTRATOR_SNAPSHOT_VERSION,
  type AgentParticipantStatus,
  type OrchestrationMode,
  type OrchestratorRunStatus,
  type OrchestratorSnapshotV1,
  type OrchestratorWorkNode,
  type WorkNodeKind,
  type WorkNodeStatus,
} from "../orchestrator/types";

/**
 * Compatibility views are deliberately one-way projections. Callers must
 * never persist a projected plan or orchestrator snapshot as mission
 * authority; MissionGraphV3 remains the only mutable source of status.
 */
export function projectMissionGraphToLegacyPlan(
  graph: MissionGraphV3,
): MissionPlan {
  const ordered = topologicallyOrderGraphNodes(graph);
  let citationContractProjected = false;
  const tasks = ordered.map((node) => {
    const task = projectGraphNodeToLegacyTask(node);
    if (
      !citationContractProjected &&
      !node.id.startsWith("retry-") &&
      task.completionContract.requiredProof.includes("web_evidence") &&
      node.allowedTools.some((toolName) =>
        /web_fetch|read_source_section|browser_extract_markdown/i.test(toolName),
      )
    ) {
      citationContractProjected = true;
      return {
        ...task,
        completionContract: {
          ...task.completionContract,
          citationMode: "source" as const,
        },
      };
    }
    return task;
  });
  const activeNode = selectActiveGraphNode(ordered);
  const completedTasks = tasks.filter((task) => task.status === "complete").length;
  const remainingTasks = tasks.filter(
    (task) => task.status !== "complete" && task.status !== "blocked",
  ).length;
  const nextAction = projectLegacyNextAction(activeNode, ordered);

  return {
    version: 1,
    runId: graph.missionId,
    status: projectLegacyRunStatus(ordered),
    activeTaskId: activeNode?.id ?? null,
    tasks,
    progress: {
      score: tasks.length === 0 ? 1 : roundScore(completedTasks / tasks.length),
      completedTasks,
      totalTasks: tasks.length,
      remainingTasks,
      stalledCount: ordered.filter((node) => node.status === "blocked").length,
      lastMeaningfulAction: nextAction?.summary,
    },
    ...(nextAction ? { nextAction } : {}),
    createdAt: graph.createdAt,
    updatedAt: graph.updatedAt,
  };
}

/** Stable, projection-only bridge for the existing Orchestrator UI. */
export function projectMissionGraphToOrchestratorSnapshot(
  graph: MissionGraphV3,
): OrchestratorSnapshotV1 {
  const ordered = topologicallyOrderGraphNodes(graph);
  const activeNode = selectActiveGraphNode(ordered);
  const childIdsByDependency = new Map<string, string[]>();
  for (const node of ordered) {
    for (const dependencyId of node.dependencyIds) {
      const childIds = childIdsByDependency.get(dependencyId) ?? [];
      childIds.push(node.id);
      childIdsByDependency.set(dependencyId, childIds);
    }
  }
  const nodes = Object.fromEntries(
    ordered.map((node) => {
      const projected: OrchestratorWorkNode = {
        id: node.id,
        parentId: null,
        childIds: [...(childIdsByDependency.get(node.id) ?? [])].sort(),
        kind: projectOrchestratorNodeKind(node),
        title: node.objective,
        status: projectOrchestratorNodeStatus(node.status),
        ownerId: "lead",
        dependencyIds: [...node.dependencyIds],
        evidenceIds: node.evidence.map((item) => item.id),
        receiptIds: node.receipts.map((item) => item.id),
        artifactIds: node.receipts
          .filter((item) => /artifact|canvas|svg|mermaid/i.test(item.kind))
          .map((item) => item.id),
        proofContract: {
          requiredEvidenceKinds: [...node.completionContract.requiredEvidenceKinds],
          minEvidenceCount: node.completionContract.minimumEvidence,
          requiredReceiptKinds: [...node.completionContract.requiredReceiptKinds],
          verifierIds: node.completionContract.verifierId
            ? [node.completionContract.verifierId]
            : [],
        },
        lastAction: describeGraphNodeAction(node),
        ...(node.status === "complete"
          ? {
              resultSummary: `Verified with ${node.evidence.length} evidence reference(s) and ${node.receipts.length} receipt(s).`,
            }
          : {}),
        ...(node.blocker ? { blocker: node.blocker.message } : {}),
        createdAt: graph.createdAt,
        updatedAt: graph.updatedAt,
      };
      return [node.id, projected];
    }),
  );
  const status = projectOrchestratorRunStatus(ordered);
  const totalToolCalls = ordered.reduce(
    (total, node) => total + node.budget.toolCalls,
    0,
  );
  const usedAttempts = ordered.reduce(
    (total, node) => total + node.retries.attempts,
    0,
  );
  const totalWallClockMs = ordered.reduce(
    (total, node) => total + node.budget.wallClockMs,
    0,
  );
  const raw: OrchestratorSnapshotV1 = {
    version: ORCHESTRATOR_SNAPSHOT_VERSION,
    runId: graph.missionId,
    mode: projectOrchestrationMode(ordered),
    status,
    rootNodeIds: ordered
      .filter((node) => node.dependencyIds.length === 0)
      .map((node) => node.id),
    nodes,
    participants: {
      lead: {
        id: "lead",
        role: "lead",
        displayName: "Lead",
        status: projectParticipantStatus(status, activeNode),
        currentNodeId: activeNode?.id ?? null,
        budget: {
          modelSteps: {
            used: Math.min(graph.revision, graph.capabilityEnvelope.budgets.maxTotalToolCalls),
            limit: graph.capabilityEnvelope.budgets.maxTotalToolCalls,
          },
          toolCalls: {
            used: Math.min(usedAttempts, totalToolCalls),
            limit: totalToolCalls,
          },
          wallClockMs: { used: 0, limit: totalWallClockMs },
        },
        ...(activeNode ? { lastAction: describeGraphNodeAction(activeNode) } : {}),
        handoffStatus: "none",
        startedAt: graph.createdAt,
        updatedAt: graph.updatedAt,
        ...(activeNode?.blocker ? { blocker: activeNode.blocker.message } : {}),
      },
    },
    worktrees: {},
    handoffs: [],
    merge: {
      status: status === "blocked" ? "blocked" : status === "complete" ? "complete" : "idle",
      evidenceReceived: ordered.reduce(
        (total, node) => total + node.evidence.length,
        0,
      ),
      evidenceAccepted: ordered.reduce(
        (total, node) => total + node.evidence.length,
        0,
      ),
      evidenceRejected: 0,
      evidenceDeduplicated: 0,
      conflicts: 0,
      commitShas: [],
      verificationStatus:
        status === "complete" ? "passed" : status === "blocked" ? "blocked" : "pending",
      integrationStatus: "not_applicable",
      ...(status === "blocked" && activeNode?.blocker
        ? { blocker: activeNode.blocker.message }
        : {}),
      updatedAt: graph.updatedAt,
    },
    sequence: graph.revision,
    createdAt: graph.createdAt,
    updatedAt: graph.updatedAt,
  };
  const normalized = normalizeOrchestratorSnapshot(raw, {
    fallbackRunId: graph.missionId,
    now: new Date(graph.updatedAt),
  });
  if (!normalized) {
    throw new Error("MissionGraphV3 produced an invalid Orchestrator compatibility projection.");
  }
  return normalized;
}

export type LegacyMissionGraphMigrationErrorCode =
  | "invalid_legacy_state"
  | "invalid_mapping"
  | "unknown_tool_mapping"
  | "unknown_executor_mapping"
  | "unknown_proof_reference"
  | "cycle"
  | "proof_incomplete";

export class LegacyMissionGraphMigrationError extends Error {
  constructor(
    readonly code: LegacyMissionGraphMigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LegacyMissionGraphMigrationError";
  }
}

export interface LegacyMissionNodeMappingV1 {
  executorId: string;
  executionHost: MissionExecutionHostV1;
  effect: MissionAuthorityEffectV1;
  /** Required for Orchestrator nodes because snapshots have no tool catalog. */
  legacyToolNames?: string[];
  requiredCapabilities?: string[];
  inputs?: Record<string, MissionNodeInputV1>;
  destination?: MissionDestinationV1 | null;
  resourceLocks?: MissionResourceLockRequirementV1[];
  budget?: MissionNodeBudgetV1;
  maxAttempts?: number;
}

export interface LegacyMissionGraphMigrationOptionsV1 {
  capabilityEnvelope: MissionCapabilityEnvelopeV1;
  objective?: string;
  /** Identity mapping is intentionally not implicit. */
  toolNameMap: Readonly<Record<string, string>>;
  nodeMappings: Readonly<Record<string, LegacyMissionNodeMappingV1>>;
  verifierIdMap?: Readonly<Record<string, string>>;
  evidenceReferences?: Readonly<Record<string, MissionEvidenceRefV1>>;
  receiptReferences?: Readonly<Record<string, MissionReceiptRefV1>>;
  verificationReferencesByNodeId?: Readonly<
    Record<string, MissionVerificationRefV1>
  >;
  routing?: MissionRoutingDecisionV1;
}

/** Explicit, one-time migration. It is never used as a live reverse projection. */
export async function migrateLegacyMissionPlanToMissionGraphV3(
  value: MissionPlanLike,
  options: LegacyMissionGraphMigrationOptionsV1,
): Promise<MissionGraphV3> {
  const plan = normalizeStrictMissionPlan(value);
  const sources = extractLegacyPlanNodes(plan);
  assertAcyclicDependencies(sources, "legacy mission plan");
  return buildMigratedMissionGraph(
    {
      missionId: plan.runId,
      objective:
        options.objective ??
        sources.map((source) => source.objective).join("; ").slice(0, 8_000),
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      sources,
    },
    options,
  );
}

/** Explicit, one-time migration from the historical Orchestrator ledger. */
export async function migrateLegacyOrchestratorSnapshotToMissionGraphV3(
  value: OrchestratorSnapshotV1,
  options: LegacyMissionGraphMigrationOptionsV1,
): Promise<MissionGraphV3> {
  assertRawOrchestratorReferences(value);
  const snapshot = normalizeOrchestratorSnapshot(value, {
    fallbackRunId: value.runId,
    now: new Date(value.updatedAt),
  });
  if (!snapshot || Object.keys(snapshot.nodes).length !== Object.keys(value.nodes).length) {
    migrationFail("invalid_legacy_state", "Legacy Orchestrator snapshot is malformed.");
  }
  const sources: LegacyNodeSource[] = Object.values(snapshot.nodes).map((node) => ({
    id: node.id,
    objective: node.title,
    dependencyIds: [...node.dependencyIds],
    status: migrateOrchestratorNodeStatus(node.status),
    evidenceIds: [...node.evidenceIds],
    receiptIds: [...node.receiptIds],
    completionContract: {
      criteria: [node.title],
      minimumEvidence: node.proofContract?.minEvidenceCount ?? 0,
      requiredEvidenceKinds: [
        ...(node.proofContract?.requiredEvidenceKinds ?? []),
      ],
      minimumReceipts: node.proofContract?.requiredReceiptKinds.length ?? 0,
      requiredReceiptKinds: [
        ...(node.proofContract?.requiredReceiptKinds ?? []),
      ],
      legacyVerifierIds: [...(node.proofContract?.verifierIds ?? [])],
    },
    blocker: node.blocker,
    attempts: 0,
    legacyToolNames: options.nodeMappings[node.id]?.legacyToolNames ?? [],
    outputs: {
      ...(node.artifactIds.length > 0 ? { legacyArtifactIds: node.artifactIds } : {}),
      ...(node.resultSummary ? { legacyResultSummary: node.resultSummary } : {}),
    },
  }));
  assertAcyclicDependencies(sources, "legacy Orchestrator snapshot");
  return buildMigratedMissionGraph(
    {
      missionId: snapshot.runId,
      objective:
        options.objective ??
        sources.map((source) => source.objective).join("; ").slice(0, 8_000),
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      sources,
    },
    options,
  );
}

interface LegacyNodeSource {
  id: string;
  objective: string;
  dependencyIds: string[];
  status: MissionNodeStatusV3;
  evidenceIds: string[];
  receiptIds: string[];
  completionContract: {
    criteria: string[];
    minimumEvidence: number;
    requiredEvidenceKinds: string[];
    minimumReceipts: number;
    requiredReceiptKinds: string[];
    legacyVerifierIds: string[];
  };
  blocker?: string;
  attempts: number;
  legacyToolNames: string[];
  outputs: Record<string, MissionJsonValueV1>;
}

interface MigratedGraphSource {
  missionId: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  sources: LegacyNodeSource[];
}

async function buildMigratedMissionGraph(
  input: MigratedGraphSource,
  options: LegacyMissionGraphMigrationOptionsV1,
): Promise<MissionGraphV3> {
  const envelope = await parseMissionCapabilityEnvelopeV1(
    options.capabilityEnvelope,
  );
  if (envelope.missionId !== input.missionId) {
    migrationFail(
      "invalid_mapping",
      "Capability envelope missionId does not match the legacy mission.",
    );
  }
  const nodes: Record<string, MissionNodeV3> = {};
  for (const source of input.sources) {
    const mapping = options.nodeMappings[source.id];
    if (!mapping) {
      migrationFail(
        "unknown_executor_mapping",
        `Legacy node ${source.id} has no explicit executor mapping.`,
      );
    }
    assertExecutorMapping(source.id, mapping, envelope);
    const allowedTools = resolveToolMappings(
      source.id,
      source.legacyToolNames,
      options.toolNameMap,
      envelope,
    );
    assertMappedEffects(source.id, mapping.effect, allowedTools, envelope);
    const requiredCapabilities = unique([
      ...(mapping.requiredCapabilities ?? []),
      ...allowedTools.flatMap(
        (toolName) => envelope.tools[toolName]?.capabilityIds ?? [],
      ),
    ]);
    const verifierId = resolveVerifierId(
      source.id,
      source.completionContract.legacyVerifierIds,
      options.verifierIdMap ?? {},
      envelope,
    );
    const evidence = resolveEvidenceReferences(
      source.id,
      source.evidenceIds,
      options.evidenceReferences ?? {},
    );
    const receipts = resolveReceiptReferences(
      source.id,
      source.receiptIds,
      options.receiptReferences ?? {},
    );
    const verification =
      options.verificationReferencesByNodeId?.[source.id] ?? null;
    if (verification && verification.verifierId !== verifierId) {
      migrationFail(
        "invalid_mapping",
        `Legacy node ${source.id} verification does not match its verifier mapping.`,
      );
    }
    const maxAttempts = mapping.maxAttempts ?? Math.max(1, source.attempts);
    if (source.attempts > maxAttempts) {
      migrationFail(
        "invalid_mapping",
        `Legacy node ${source.id} attempts exceed its mapped retry budget.`,
      );
    }
    const destination = mapping.destination ?? null;
    if (mapping.effect !== "read" && !destination) {
      migrationFail(
        "invalid_mapping",
        `Effectful legacy node ${source.id} requires an explicit trusted destination.`,
      );
    }
    const resourceLocks =
      mapping.resourceLocks ??
      (destination
        ? [{ bindingId: destination.bindingId, mode: "exclusive" as const }]
        : []);
    const budget = mapping.budget ?? {
      toolCalls: allowedTools.length,
      externalActions: mapping.effect === "external_action" ? 1 : 0,
      wallClockMs: 1_000,
    };
    const completionContract: MissionCompletionContractV3 = {
      criteria: [...source.completionContract.criteria],
      minimumEvidence: Math.max(
        source.completionContract.minimumEvidence,
        source.completionContract.requiredEvidenceKinds.length,
      ),
      requiredEvidenceKinds: unique([
        ...source.completionContract.requiredEvidenceKinds,
      ]),
      minimumReceipts: Math.max(
        source.completionContract.minimumReceipts,
        source.completionContract.requiredReceiptKinds.length,
      ),
      requiredReceiptKinds: unique([
        ...source.completionContract.requiredReceiptKinds,
      ]),
      verifierId,
    };
    if (
      source.status === "complete" &&
      !legacyCompletionHasProof(
        completionContract,
        evidence,
        receipts,
        verification,
      )
    ) {
      migrationFail(
        "proof_incomplete",
        `Completed legacy node ${source.id} cannot be migrated without its proof.`,
      );
    }
    if (source.status === "blocked" && !source.blocker) {
      migrationFail(
        "invalid_legacy_state",
        `Blocked legacy node ${source.id} has no blocker.`,
      );
    }
    nodes[source.id] = {
      id: source.id,
      dependencyIds: [...source.dependencyIds],
      objective: source.objective,
      executorId: mapping.executorId,
      executionHost: mapping.executionHost,
      effect: mapping.effect,
      inputs: { ...(mapping.inputs ?? {}) },
      outputs: { ...source.outputs },
      requiredCapabilities,
      allowedTools,
      destination,
      resourceLocks,
      budget,
      retries: {
        maxAttempts,
        attempts: source.attempts,
        failureFingerprints: [],
        consecutiveFailureFingerprint: null,
        consecutiveFailureCount: 0,
      },
      status: source.status,
      evidence,
      receipts,
      verification,
      completionContract,
      blocker:
        source.status === "blocked"
          ? {
              code: "legacy_blocker",
              message: source.blocker!,
              requiredAction: null,
            }
          : null,
    };
  }
  const routing =
    options.routing ??
    (await createDeterministicMigrationRouting(input.missionId, input.updatedAt));
  return parseMissionGraphV3({
    schemaVersion: 3,
    missionId: input.missionId,
    objective: input.objective || "Resume migrated mission.",
    revision: 0,
    journalHeadFingerprint: null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    routing,
    continuationCheckpoint: null,
    capabilityEnvelope: envelope,
    nodes,
  });
}

function projectGraphNodeToLegacyTask(node: MissionNodeV3): MissionPlanTask {
  const legacyEvidenceIds = legacyOutputIds(
    node.outputs.legacyEvidenceIds,
  );
  const legacyReceiptIds = legacyOutputIds(node.outputs.legacyReceiptIds);
  return {
    id: node.id,
    title: node.objective,
    status: projectLegacyNodeStatus(node.status),
    allowedTools: [...node.allowedTools],
    dependencies: [...node.dependencyIds],
    evidenceIds:
      legacyEvidenceIds.length > 0
        ? legacyEvidenceIds
        : node.evidence.map((item) => projectLegacyEvidenceId(node, item)),
    receiptIds: node.receipts.flatMap((item, index) => [
      legacyReceiptIds[index] ?? item.id,
      `${RECEIPT_PROOF_ID_PREFIX}${projectReceiptKindToLegacyProof(item.kind)}`,
    ]),
    completionContract: projectLegacyCompletionContract(node),
    ...(node.blocker ? { blocker: node.blocker.message } : {}),
  };
}

function legacyOutputIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function projectLegacyEvidenceId(
  node: MissionNodeV3,
  evidence: MissionEvidenceRefV1,
): string {
  if (evidence.kind === "final-output") {
    return FINAL_OUTPUT_RELEVANT_EVIDENCE_ID;
  }
  if (evidence.kind === "tool-result") {
    if (node.allowedTools.some((toolName) => toolName === "count_words")) {
      return "tool:count_words";
    }
    if (
      /^(?:web|web_search|vault|vault_batch|vault_search|tool|source):/u.test(
        evidence.id,
      )
    ) {
      return evidence.id;
    }
    if (node.effect === "execution") return CODE_RUN_SUCCESS_EVIDENCE_ID;
    if (node.effect === "read") {
      if (node.allowedTools.some((toolName) => toolName === "web_fetch")) {
        return `web:${evidence.id}`;
      }
      if (node.allowedTools.some((toolName) => /web|source/i.test(toolName))) {
        return `web_search:${evidence.id}`;
      }
      return `vault:${evidence.id}`;
    }
  }
  return evidence.id;
}

function projectLegacyCompletionContract(
  node: MissionNodeV3,
): MissionCompletionContract {
  const requiredProof = uniqueProofKinds([
    ...node.completionContract.requiredEvidenceKinds.flatMap((kind) =>
      projectEvidenceKindToLegacyProof(kind, node),
    ),
    ...node.completionContract.requiredReceiptKinds.map(
      projectReceiptKindToLegacyProof,
    ),
    ...(node.completionContract.verifierId ? ["final_relevance" as const] : []),
  ]);
  return {
    requiredProof,
    ...(node.completionContract.minimumEvidence > 0
      ? { minEvidenceCount: node.completionContract.minimumEvidence }
      : {}),
  };
}

function projectEvidenceKindToLegacyProof(
  kind: string,
  node: MissionNodeV3,
): MissionPlanProofKind[] {
  if (/tool-result/i.test(kind)) {
    if (node.allowedTools.some((toolName) => toolName === "count_words")) {
      return ["word_count"];
    }
    if (node.effect === "mutation" || node.effect === "external_action") {
      return [];
    }
    if (node.effect === "execution") return ["code_execution"];
    if (
      node.allowedTools.some((toolName) =>
        /web_fetch|read_source_section/i.test(toolName),
      )
    ) {
      return ["web_evidence"];
    }
    if (node.allowedTools.some((toolName) => /web_search/i.test(toolName))) {
      return [];
    }
    return ["vault_evidence"];
  }
  if (/vault|note|graph/i.test(kind)) return ["vault_evidence"];
  if (/word.?count/i.test(kind)) return ["word_count"];
  if (/code|execution|test/i.test(kind)) return ["code_execution"];
  if (/final|relevance/i.test(kind)) return ["final_relevance"];
  return ["web_evidence"];
}

function projectReceiptKindToLegacyProof(kind: string): MissionPlanProofKind {
  if (/external|linear|github/i.test(kind)) return "external_action_receipt";
  if (/artifact|canvas|svg|mermaid|diagram/i.test(kind)) return "artifact_receipt";
  if (/rename|retitle/i.test(kind)) return "rename_receipt";
  if (/highlight/i.test(kind)) return "highlight_receipt";
  return "write_receipt";
}

function projectLegacyNodeStatus(status: MissionNodeStatusV3): MissionPlanStatus {
  switch (status) {
    case "queued":
    case "ready":
      return "pending";
    case "running":
    case "waiting_approval":
    case "waiting_obsidian":
      return "in_progress";
    case "verifying":
      return "needs_verification";
    case "blocked":
    case "cancelled":
      return "blocked";
    case "complete":
      return "complete";
  }
}

function projectLegacyRunStatus(nodes: MissionNodeV3[]): MissionPlanStatus {
  if (nodes.length > 0 && nodes.every((node) => node.status === "complete")) {
    return "complete";
  }
  if (nodes.some((node) => node.status === "verifying")) {
    return "needs_verification";
  }
  if (
    nodes.length > 0 &&
    nodes.every((node) => ["complete", "blocked", "cancelled"].includes(node.status))
  ) {
    return "blocked";
  }
  return "in_progress";
}

function projectLegacyNextAction(
  active: MissionNodeV3 | null,
  nodes: MissionNodeV3[],
): MissionPlanAction | undefined {
  if (!active) {
    return nodes.length > 0 && nodes.every((node) => node.status === "complete")
      ? {
          kind: "final",
          summary: "MissionGraphV3 is complete; synthesize the verified final answer.",
        }
      : undefined;
  }
  return {
    kind:
      active.status === "blocked"
        ? "blocker"
        : active.status === "verifying"
          ? "verify"
          : active.effect === "read"
            ? "tool"
            : "write",
    taskId: active.id,
    ...(active.allowedTools[0] ? { toolName: active.allowedTools[0] } : {}),
    summary: describeGraphNodeAction(active),
  };
}

function projectOrchestratorNodeKind(node: MissionNodeV3): WorkNodeKind {
  if (node.status === "verifying" || node.completionContract.verifierId) return "verify";
  if (node.effect === "execution") return "code";
  if (node.effect === "read") return "research";
  return "mission";
}

function projectOrchestratorNodeStatus(status: MissionNodeStatusV3): WorkNodeStatus {
  switch (status) {
    case "waiting_approval":
    case "waiting_obsidian":
      return "waiting";
    case "verifying":
      return "running";
    default:
      return status;
  }
}

function projectOrchestratorRunStatus(
  nodes: MissionNodeV3[],
): OrchestratorRunStatus {
  if (nodes.length > 0 && nodes.every((node) => node.status === "complete")) {
    return "complete";
  }
  if (nodes.length > 0 && nodes.every((node) => node.status === "cancelled")) {
    return "cancelled";
  }
  if (
    nodes.length > 0 &&
    nodes.every((node) => ["complete", "blocked", "cancelled"].includes(node.status))
  ) {
    return "blocked";
  }
  return "running";
}

function projectOrchestrationMode(nodes: MissionNodeV3[]): OrchestrationMode {
  if (nodes.some((node) => node.effect === "execution")) return "code_team";
  return nodes.length > 1 ? "research_team" : "single";
}

function projectParticipantStatus(
  status: OrchestratorRunStatus,
  active: MissionNodeV3 | null,
): AgentParticipantStatus {
  if (status === "complete" || status === "blocked" || status === "cancelled") {
    return status;
  }
  if (!active) return "planning";
  if (active.status === "verifying") return "verifying";
  if (active.status === "waiting_approval" || active.status === "waiting_obsidian") {
    return "waiting";
  }
  if (active.effect === "execution") return "coding";
  if (active.effect === "read") return "researching";
  return "planning";
}

function describeGraphNodeAction(node: MissionNodeV3): string {
  if (node.blocker?.requiredAction) return node.blocker.requiredAction;
  if (node.blocker) return node.blocker.message;
  switch (node.status) {
    case "queued":
      return `Wait for dependencies before ${node.objective}`;
    case "ready":
      return `Execute ${node.objective}`;
    case "running":
      return `Continue ${node.objective}`;
    case "waiting_approval":
      return `Await approval for ${node.objective}`;
    case "waiting_obsidian":
      return `Reconnect Obsidian for ${node.objective}`;
    case "verifying":
      return `Verify ${node.objective}`;
    case "blocked":
      return `Resolve blocker for ${node.objective}`;
    case "complete":
      return `Completed ${node.objective}`;
    case "cancelled":
      return `Cancelled ${node.objective}`;
  }
}

function normalizeStrictMissionPlan(value: MissionPlanLike): MissionPlanLike {
  const normalized =
    value.version === 1
      ? normalizeMissionPlan(value)
      : normalizeMissionPlanV2(value);
  if (!normalized) {
    migrationFail("invalid_legacy_state", "Legacy mission plan is malformed.");
  }
  const rawCount =
    value.version === 1
      ? value.tasks.length
      : Object.values(value.nodes).filter((node) => node.depth > 0).length;
  if (flattenMissionPlanTasks(normalized).length !== rawCount) {
    migrationFail(
      "invalid_legacy_state",
      "Legacy mission plan normalization would discard nodes.",
    );
  }
  return normalized;
}

function extractLegacyPlanNodes(plan: MissionPlanLike): LegacyNodeSource[] {
  const hierarchicalNodes =
    plan.version === 2
      ? Object.fromEntries(
          Object.values(plan.nodes)
            .filter((node) => node.depth > 0)
            .map((node) => [node.id, node]),
        )
      : null;
  return flattenMissionPlanTasks(plan).map((task) => {
    const hierarchical = hierarchicalNodes?.[task.id];
    const proof = migrateLegacyCompletionContract(task.completionContract);
    return {
      id: task.id,
      objective: task.title,
      dependencyIds: [...task.dependencies],
      status: migrateLegacyPlanStatus(task, flattenMissionPlanTasks(plan)),
      evidenceIds: [...task.evidenceIds],
      receiptIds: [...task.receiptIds],
      completionContract: {
        ...proof,
        legacyVerifierIds: [...(hierarchical?.verifierIds ?? [])],
      },
      blocker: task.blocker,
      attempts: hierarchical?.attempts ?? 0,
      legacyToolNames: [...task.allowedTools],
      outputs: {},
    };
  });
}

function migrateLegacyCompletionContract(
  contract: MissionCompletionContract,
): Omit<LegacyNodeSource["completionContract"], "legacyVerifierIds"> {
  const evidenceKinds: string[] = [];
  const receiptKinds: string[] = [];
  for (const proof of contract.requiredProof) {
    switch (proof) {
      case "web_evidence":
        evidenceKinds.push("web-source");
        break;
      case "vault_evidence":
        evidenceKinds.push("vault-note");
        break;
      case "word_count":
        evidenceKinds.push("word-count");
        break;
      case "code_execution":
        evidenceKinds.push("code-execution");
        break;
      case "final_relevance":
        evidenceKinds.push("final-relevance");
        break;
      case "blocker":
        evidenceKinds.push("blocker");
        break;
      case "write_receipt":
        receiptKinds.push("vault-write");
        break;
      case "external_action_receipt":
        receiptKinds.push("external-action");
        break;
      case "artifact_receipt":
        receiptKinds.push("artifact");
        break;
      case "rename_receipt":
        receiptKinds.push("rename");
        break;
      case "highlight_receipt":
        receiptKinds.push("highlight");
        break;
    }
  }
  const requiredEvidenceKinds = unique(evidenceKinds);
  const requiredReceiptKinds = unique(receiptKinds);
  return {
    criteria:
      contract.requiredProof.length > 0
        ? contract.requiredProof.map((proof) => `Preserve legacy proof: ${proof}.`)
        : ["Preserve the legacy task completion state."],
    minimumEvidence: Math.max(
      contract.minEvidenceCount ?? 0,
      requiredEvidenceKinds.length,
    ),
    requiredEvidenceKinds,
    minimumReceipts: requiredReceiptKinds.length,
    requiredReceiptKinds,
  };
}

function migrateLegacyPlanStatus(
  task: MissionPlanTask,
  tasks: MissionPlanTask[],
): MissionNodeStatusV3 {
  switch (task.status) {
    case "pending":
      return task.dependencies.every(
        (dependencyId) =>
          tasks.find((candidate) => candidate.id === dependencyId)?.status === "complete",
      )
        ? "ready"
        : "queued";
    case "in_progress":
      return "running";
    case "needs_verification":
      return "verifying";
    case "complete":
      return "complete";
    case "blocked":
      return "blocked";
  }
}

function migrateOrchestratorNodeStatus(
  status: WorkNodeStatus,
): MissionNodeStatusV3 {
  switch (status) {
    case "waiting":
      return "waiting_approval";
    default:
      return status;
  }
}

function assertAcyclicDependencies(
  sources: LegacyNodeSource[],
  label: string,
): void {
  const sourceById = new Map<string, LegacyNodeSource>();
  for (const source of sources) {
    if (sourceById.has(source.id)) {
      migrationFail("invalid_legacy_state", `${label} contains duplicate node ${source.id}.`);
    }
    sourceById.set(source.id, source);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      migrationFail("cycle", `${label} contains a dependency cycle at ${nodeId}.`);
    }
    if (visited.has(nodeId)) return;
    const source = sourceById.get(nodeId);
    if (!source) {
      migrationFail("invalid_legacy_state", `${label} references unknown node ${nodeId}.`);
    }
    visiting.add(nodeId);
    for (const dependencyId of source.dependencyIds) {
      if (!sourceById.has(dependencyId)) {
        migrationFail(
          "invalid_legacy_state",
          `${label} node ${nodeId} references unknown dependency ${dependencyId}.`,
        );
      }
      visit(dependencyId);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const source of sources) visit(source.id);
}

function assertRawOrchestratorReferences(value: OrchestratorSnapshotV1): void {
  if (!value || typeof value !== "object" || !value.nodes) {
    migrationFail("invalid_legacy_state", "Legacy Orchestrator snapshot is malformed.");
  }
  const nodes = Object.values(value.nodes);
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    for (const dependencyId of node.dependencyIds) {
      if (!ids.has(dependencyId)) {
        migrationFail(
          "invalid_legacy_state",
          `Legacy Orchestrator node ${node.id} references unknown dependency ${dependencyId}.`,
        );
      }
    }
    if (node.parentId && !ids.has(node.parentId)) {
      migrationFail(
        "invalid_legacy_state",
        `Legacy Orchestrator node ${node.id} references unknown parent ${node.parentId}.`,
      );
    }
  }
  const parentSources = nodes.map((node) => ({
    id: node.id,
    objective: node.title,
    dependencyIds: node.parentId ? [node.parentId] : [],
    status: "queued" as const,
    evidenceIds: [],
    receiptIds: [],
    completionContract: {
      criteria: [],
      minimumEvidence: 0,
      requiredEvidenceKinds: [],
      minimumReceipts: 0,
      requiredReceiptKinds: [],
      legacyVerifierIds: [],
    },
    attempts: 0,
    legacyToolNames: [],
    outputs: {},
  }));
  assertAcyclicDependencies(parentSources, "legacy Orchestrator hierarchy");
}

function assertExecutorMapping(
  nodeId: string,
  mapping: LegacyMissionNodeMappingV1,
  envelope: MissionCapabilityEnvelopeV1,
): void {
  const executor = envelope.executors[mapping.executorId];
  if (
    !executor ||
    !executor.executionHosts.includes(mapping.executionHost) ||
    !executor.allowedEffects.includes(mapping.effect)
  ) {
    migrationFail(
      "unknown_executor_mapping",
      `Legacy node ${nodeId} has an unavailable executor, host, or effect mapping.`,
    );
  }
}

function resolveToolMappings(
  nodeId: string,
  legacyToolNames: string[],
  toolNameMap: Readonly<Record<string, string>>,
  envelope: MissionCapabilityEnvelopeV1,
): string[] {
  return unique(
    legacyToolNames.map((legacyName) => {
      const mapped = toolNameMap[legacyName];
      if (!mapped || !envelope.tools[mapped]) {
        migrationFail(
          "unknown_tool_mapping",
          `Legacy node ${nodeId} tool ${legacyName} has no installed explicit mapping.`,
        );
      }
      return mapped;
    }),
  );
}

function assertMappedEffects(
  nodeId: string,
  effect: MissionAuthorityEffectV1,
  allowedTools: string[],
  envelope: MissionCapabilityEnvelopeV1,
): void {
  const effects = allowedTools.map((toolName) => envelope.tools[toolName].effect);
  if (effect === "read" && effects.some((candidate) => candidate !== "read")) {
    migrationFail(
      "invalid_mapping",
      `Read-only legacy node ${nodeId} maps to an effectful tool.`,
    );
  }
  if (effect !== "read" && !effects.includes(effect)) {
    migrationFail(
      "invalid_mapping",
      `Effectful legacy node ${nodeId} has no mapped ${effect} tool.`,
    );
  }
}

function resolveVerifierId(
  nodeId: string,
  legacyVerifierIds: string[],
  verifierIdMap: Readonly<Record<string, string>>,
  envelope: MissionCapabilityEnvelopeV1,
): string | null {
  const mapped = unique(
    legacyVerifierIds.map((legacyId) => {
      const verifierId = verifierIdMap[legacyId];
      if (!verifierId || !envelope.verifiers.includes(verifierId)) {
        migrationFail(
          "invalid_mapping",
          `Legacy node ${nodeId} verifier ${legacyId} has no installed explicit mapping.`,
        );
      }
      return verifierId;
    }),
  );
  if (mapped.length > 1) {
    migrationFail(
      "invalid_mapping",
      `Legacy node ${nodeId} requires multiple verifiers unsupported by MissionGraphV3.`,
    );
  }
  return mapped[0] ?? null;
}

function resolveEvidenceReferences(
  nodeId: string,
  ids: string[],
  references: Readonly<Record<string, MissionEvidenceRefV1>>,
): MissionEvidenceRefV1[] {
  return unique(ids).map((id) => {
    const reference = references[id];
    if (!reference || reference.id !== id) {
      migrationFail(
        "unknown_proof_reference",
        `Legacy node ${nodeId} evidence ${id} lacks a fingerprinted reference.`,
      );
    }
    return { ...reference };
  });
}

function resolveReceiptReferences(
  nodeId: string,
  ids: string[],
  references: Readonly<Record<string, MissionReceiptRefV1>>,
): MissionReceiptRefV1[] {
  return unique(ids).map((id) => {
    const reference = references[id];
    if (!reference || reference.id !== id) {
      migrationFail(
        "unknown_proof_reference",
        `Legacy node ${nodeId} receipt ${id} lacks a fingerprinted reference.`,
      );
    }
    return { ...reference };
  });
}

function legacyCompletionHasProof(
  contract: MissionCompletionContractV3,
  evidence: MissionEvidenceRefV1[],
  receipts: MissionReceiptRefV1[],
  verification: MissionVerificationRefV1 | null,
): boolean {
  const evidenceKinds = new Set(evidence.map((item) => item.kind));
  const receiptKinds = new Set(receipts.map((item) => item.kind));
  return (
    evidence.length >= contract.minimumEvidence &&
    receipts.length >= contract.minimumReceipts &&
    contract.requiredEvidenceKinds.every((kind) => evidenceKinds.has(kind)) &&
    contract.requiredReceiptKinds.every((kind) => receiptKinds.has(kind)) &&
    (!contract.verifierId ||
      (verification?.verifierId === contract.verifierId &&
        verification.status === "passed"))
  );
}

async function createDeterministicMigrationRouting(
  missionId: string,
  decidedAt: string,
): Promise<MissionRoutingDecisionV1> {
  const decision = {
    source: "deterministic" as const,
    fallbackFrom: null,
    fallbackReason: null,
    confidence: 1,
    decidedAt,
  };
  return {
    ...decision,
    decisionFingerprint: await sha256Fingerprint({ missionId, ...decision }),
  };
}

function topologicallyOrderGraphNodes(graph: MissionGraphV3): MissionNodeV3[] {
  const nodes = Object.values(graph.nodes);
  const visited = new Set<string>();
  const ordered: MissionNodeV3[] = [];
  const visit = (node: MissionNodeV3): void => {
    if (visited.has(node.id)) return;
    for (const dependencyId of [...node.dependencyIds].sort()) {
      visit(graph.nodes[dependencyId]);
    }
    visited.add(node.id);
    ordered.push(node);
  };
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    visit(node);
  }
  return ordered;
}

function selectActiveGraphNode(nodes: MissionNodeV3[]): MissionNodeV3 | null {
  const priority: MissionNodeStatusV3[] = [
    "running",
    "waiting_approval",
    "waiting_obsidian",
    "verifying",
    "ready",
    "blocked",
    "queued",
  ];
  for (const status of priority) {
    const node = nodes.find((candidate) => candidate.status === status);
    if (node) return node;
  }
  return null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueProofKinds(
  values: MissionPlanProofKind[],
): MissionPlanProofKind[] {
  return [...new Set(values)];
}

function roundScore(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function migrationFail(
  code: LegacyMissionGraphMigrationErrorCode,
  message: string,
): never {
  throw new LegacyMissionGraphMigrationError(code, message);
}
