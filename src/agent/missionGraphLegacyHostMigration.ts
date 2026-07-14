import type { ToolRegistry } from "../tools/types";
import type { MissionEvidence } from "./missionLedger";
import {
  flattenMissionPlanTasks,
  type MissionPlan,
  type MissionPlanProofKind,
} from "./missionPlan";
import {
  migrateLegacyMissionPlanToMissionGraphV3,
  type LegacyMissionNodeMappingV1,
  type LegacyMissionGraphMigrationOptionsV1,
} from "./missionGraphLegacyProjection";
import type { HostMissionGraphPlanV1 } from "./missionGraphHost";
import type {
  MissionAuthorityEffectV1,
  MissionEvidenceRefV1,
  MissionGraphV3,
  MissionReceiptRefV1,
} from "./missionGraphV3";
import { parseMissionGraphV3 } from "./missionGraphV3";
import { sha256Fingerprint } from "../../packages/headless-runtime/src/canonicalize";

export interface LegacyReceiptLike {
  id?: string;
  operation: string;
  message?: string;
  createdAt?: string;
  committedAt?: string;
  resource?: { system?: string };
}

/**
 * One-time, fail-closed host adapter for legacy runtime snapshots that predate
 * MissionGraphV3. It maps only installed tools and proof objects already
 * present in the durable snapshot; it never infers new mutation authority.
 */
export async function migrateLegacyPlanWithHostAuthority(input: {
  plan: MissionPlan;
  missionId: string;
  objective: string;
  hostPlan: HostMissionGraphPlanV1;
  toolRegistry: ToolRegistry;
  evidence: MissionEvidence[];
  receipts: LegacyReceiptLike[];
}): Promise<MissionGraphV3> {
  const plan: MissionPlan = {
    ...JSON.parse(JSON.stringify(input.plan)),
    runId: input.missionId,
  };
  const originalEvidenceIdByCanonical = new Map<string, string>();
  const originalReceiptIdByCanonical = new Map<string, string>();
  for (const task of plan.tasks) {
    // A persisted legacy `in_progress` state has no live owner after restart.
    // Ambiguous applying mutations were already blocked by the operation-WAL
    // reconciliation gate, so the remaining task is safely re-queued.
    if (task.status === "in_progress") {
      task.status = "pending";
    }
    task.evidenceIds = await Promise.all(
      task.evidenceIds.map(async (originalId) => {
        const canonicalId = await canonicalReferenceId(
          "legacy-evidence",
          originalId,
        );
        originalEvidenceIdByCanonical.set(canonicalId, originalId);
        return canonicalId;
      }),
    );
    task.receiptIds = await Promise.all(
      task.receiptIds.map(async (originalId) => {
        const canonicalId = await canonicalReferenceId(
          "legacy-receipt",
          originalId,
        );
        originalReceiptIdByCanonical.set(canonicalId, originalId);
        return canonicalId;
      }),
    );
  }
  const tasks = flattenMissionPlanTasks(plan);
  const proposalNodes = Object.values(input.hostPlan.deterministicProposal.nodes);
  const toolNameMap: Record<string, string> = {};
  const nodeMappings: Record<string, LegacyMissionNodeMappingV1> = {};
  const evidenceReferences: Record<string, MissionEvidenceRefV1> = {};
  const receiptReferences: Record<string, MissionReceiptRefV1> = {};

  for (const task of tasks) {
    const mappedTools = task.allowedTools.map((legacyName) => {
      const installed = input.toolRegistry
        .getDefinitions()
        .some((definition) => definition.function.name === legacyName);
      if (!installed || !input.hostPlan.capabilityEnvelope.tools[legacyName]) {
        throw new Error(
          `Legacy mission node ${task.id} references unavailable tool ${legacyName}.`,
        );
      }
      toolNameMap[legacyName] = legacyName;
      return legacyName;
    });
    const effects = new Set<MissionAuthorityEffectV1>(
      mappedTools.map(
        (name) => input.hostPlan.capabilityEnvelope.tools[name]!.effect,
      ),
    );
    if (effects.size > 1) {
      throw new Error(
        `Legacy mission node ${task.id} mixes incompatible authority effects.`,
      );
    }
    const effect = [...effects][0] ?? "read";
    const template = proposalNodes.find(
      (node) =>
        node.effect === effect &&
        mappedTools.every((name) => node.allowedTools.includes(name)),
    ) ?? proposalNodes.find(
      (node) =>
        node.effect === effect &&
        node.allowedTools.some((name) => mappedTools.includes(name)),
    );
    if (effect !== "read" && !template?.destination) {
      throw new Error(
        `Legacy mission node ${task.id} has no trusted destination mapping.`,
      );
    }
    nodeMappings[task.id] = {
      executorId: template?.executorId ?? "single-agent",
      executionHost: template?.executionHost ?? "obsidian_core",
      effect,
      ...(template?.inputs ? { inputs: template.inputs } : {}),
      ...(template?.destination ? { destination: template.destination } : {}),
      ...(template?.resourceLocks
        ? { resourceLocks: template.resourceLocks }
        : {}),
      budget: {
        toolCalls: mappedTools.length,
        externalActions: effect === "external_action" ? 1 : 0,
        wallClockMs: Math.max(1_000, template?.budget.wallClockMs ?? 1_000),
      },
      maxAttempts: Math.max(
        1,
        Math.min(
          input.hostPlan.capabilityEnvelope.budgets.maxAttemptsPerNode,
          template?.maxAttempts ?? 1,
        ),
      ),
    };

    for (const legacyEvidenceId of task.evidenceIds) {
      if (evidenceReferences[legacyEvidenceId]) continue;
      const originalEvidenceId =
        originalEvidenceIdByCanonical.get(legacyEvidenceId) ?? legacyEvidenceId;
      const evidence = input.evidence.find(
        (candidate) => candidate.id === originalEvidenceId,
      );
      if (!evidence) {
        throw new Error(
          `Legacy mission evidence ${legacyEvidenceId} is unavailable for migration.`,
        );
      }
      evidenceReferences[legacyEvidenceId] = {
        id: legacyEvidenceId,
        kind: evidenceKindForProof(task.completionContract.requiredProof, evidence),
        fingerprint: await sha256Fingerprint(
          JSON.parse(JSON.stringify(evidence)),
        ),
        observedAt: plan.updatedAt,
      };
    }

    for (const legacyReceiptId of task.receiptIds) {
      if (receiptReferences[legacyReceiptId]) continue;
      const originalReceiptId =
        originalReceiptIdByCanonical.get(legacyReceiptId) ?? legacyReceiptId;
      const proof = receiptProofFromLegacyId(originalReceiptId);
      const receipt = input.receipts.find(
        (candidate) =>
          candidate.id === originalReceiptId ||
          (proof !== null && receiptMatchesProof(candidate, proof)),
      );
      if (!receipt) {
        throw new Error(
          `Legacy mission receipt ${legacyReceiptId} is unavailable for migration.`,
        );
      }
      receiptReferences[legacyReceiptId] = {
        id: legacyReceiptId,
        kind: receiptKindForProof(proof ?? proofForReceipt(receipt)),
        fingerprint: await sha256Fingerprint(
          JSON.parse(JSON.stringify(receipt)),
        ),
        committedAt: receipt.committedAt ?? receipt.createdAt ?? plan.updatedAt,
      };
    }
  }

  const migrated = await migrateLegacyMissionPlanToMissionGraphV3(plan, {
    capabilityEnvelope: input.hostPlan.capabilityEnvelope,
    objective: input.objective,
    toolNameMap,
    nodeMappings,
    evidenceReferences,
    receiptReferences,
  });
  const originalTasksById = new Map(
    input.plan.tasks.map((task) => [task.id, task] as const),
  );
  const nodes = Object.fromEntries(
    Object.entries(migrated.nodes).map(([nodeId, node]) => {
      const originalTask = originalTasksById.get(nodeId);
      return [
        nodeId,
        {
          ...node,
          outputs: {
            ...node.outputs,
            ...(originalTask?.evidenceIds.length
              ? { legacyEvidenceIds: [...originalTask.evidenceIds] }
              : {}),
            ...(originalTask?.receiptIds.length
              ? { legacyReceiptIds: [...originalTask.receiptIds] }
              : {}),
          },
        },
      ];
    }),
  );
  return parseMissionGraphV3({ ...migrated, nodes });
}

function evidenceKindForProof(
  proofs: MissionPlanProofKind[],
  evidence: MissionEvidence,
): string {
  if (proofs.includes("web_evidence") || evidence.kind === "web_source") {
    return "web-source";
  }
  if (proofs.includes("vault_evidence") || evidence.kind === "vault_note") {
    return "vault-note";
  }
  if (proofs.includes("word_count")) return "word-count";
  if (proofs.includes("code_execution")) return "code-execution";
  if (proofs.includes("final_relevance")) return "final-relevance";
  return "tool-result";
}

function receiptProofFromLegacyId(value: string): MissionPlanProofKind | null {
  const match = /^receipt-proof:(.+)$/u.exec(value);
  return match ? (match[1] as MissionPlanProofKind) : null;
}

function proofForReceipt(receipt: LegacyReceiptLike): MissionPlanProofKind {
  if (/linear|github/i.test(receipt.resource?.system ?? "")) {
    return "external_action_receipt";
  }
  if (/rename|retitle/i.test(receipt.operation)) return "rename_receipt";
  if (/highlight/i.test(receipt.operation)) return "highlight_receipt";
  if (/artifact|canvas|svg|mermaid|diagram/i.test(receipt.operation)) {
    return "artifact_receipt";
  }
  return "write_receipt";
}

function receiptMatchesProof(
  receipt: LegacyReceiptLike,
  proof: MissionPlanProofKind,
): boolean {
  return proofForReceipt(receipt) === proof;
}

function receiptKindForProof(proof: MissionPlanProofKind): string {
  switch (proof) {
    case "external_action_receipt":
      return "external-action";
    case "artifact_receipt":
      return "artifact";
    case "rename_receipt":
      return "rename";
    case "highlight_receipt":
      return "highlight";
    default:
      return "vault-write";
  }
}

async function canonicalReferenceId(prefix: string, value: string): Promise<string> {
  if (
    value.length <= 128 &&
    /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/u.test(value)
  ) {
    return value;
  }
  return `${prefix}:${(await sha256Fingerprint(value)).slice(0, 32)}`;
}
