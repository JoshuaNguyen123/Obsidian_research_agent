import type { MissionCompletionContract } from "../agent/missionPlan";
import type { ResourceRef } from "../agent/actions/types";

export const MISSION_ENVELOPE_VERSION = 2 as const;

export type MissionEnvelopeOrigin = "chat" | "linear" | "schedule";
export type MissionEnvelopeNodeOwner =
  | "lead"
  | "researcher"
  | "code_worker"
  | "host";
export type MissionEnvelopeNodeKind =
  | "mission"
  | "research"
  | "evidence_verification"
  | "external_read"
  | "external_write"
  | "ticket_publish"
  | "queue_claim"
  | "vault_work"
  | "code_work"
  | "validation"
  | "local_commit"
  | "local_promotion"
  | "remote_publication"
  | "linear_finalization"
  | "final_verification";

export interface MissionEnvelopeNodeV2 {
  id: string;
  parentId: string | null;
  childIds: string[];
  kind: MissionEnvelopeNodeKind;
  status:
    | "queued"
    | "ready"
    | "running"
    | "waiting"
    | "verifying"
    | "blocked"
    | "complete"
    | "cancelled";
  owner: MissionEnvelopeNodeOwner;
  dependencyIds: string[];
  resources: ResourceRef[];
  requiredCapabilities: string[];
  requiredProofKinds: string[];
  acceptanceCriteriaIds: string[];
  actionIds: string[];
  receiptIds: string[];
  blocker?: string;
}

export interface MissionEnvelopeV2 {
  schemaVersion: typeof MISSION_ENVELOPE_VERSION;
  missionId: string;
  objective: string;
  origin: {
    system: MissionEnvelopeOrigin;
    resource?: ResourceRef;
    contractFingerprint?: string;
  };
  trustedBindings: {
    repositoryProfileKey?: string;
    vaultPaths: string[];
    linearWorkspaceId?: string;
    linearProjectId?: string;
  };
  workGraph: {
    rootNodeIds: string[];
    nodes: Record<string, MissionEnvelopeNodeV2>;
  };
  grantId?: string;
  budgets: {
    modelSteps: number;
    toolCalls: number;
    externalActions: number;
    wallClockMs: number;
  };
  acceptanceContract: MissionCompletionContract;
  lineage: {
    parentMissionId?: string;
    parentIssueId?: string;
    generation: number;
  };
}

export function createMissionEnvelopeV2(
  input: Omit<MissionEnvelopeV2, "schemaVersion">,
): MissionEnvelopeV2 {
  const missionId = requiredId(input.missionId, "missionId");
  const objective = requiredText(input.objective, "objective", 4_000);
  const nodes = normalizeNodes(input.workGraph.nodes);
  const rootNodeIds = uniqueIds(input.workGraph.rootNodeIds).filter(
    (id) => nodes[id]?.parentId === null,
  );
  if (rootNodeIds.length === 0) {
    throw new Error("Mission envelope requires at least one valid root node.");
  }
  validateNodeGraph(nodes, rootNodeIds);
  const generation = integerInRange(input.lineage.generation, 0, 2, "generation");

  return {
    schemaVersion: MISSION_ENVELOPE_VERSION,
    missionId,
    objective,
    origin: {
      system: input.origin.system,
      ...(input.origin.resource ? { resource: cloneResource(input.origin.resource) } : {}),
      ...(input.origin.contractFingerprint
        ? {
            contractFingerprint: requiredFingerprint(
              input.origin.contractFingerprint,
            ),
          }
        : {}),
    },
    trustedBindings: {
      ...(input.trustedBindings.repositoryProfileKey
        ? {
            repositoryProfileKey: requiredId(
              input.trustedBindings.repositoryProfileKey,
              "repositoryProfileKey",
            ),
          }
        : {}),
      vaultPaths: uniqueIds(input.trustedBindings.vaultPaths),
      ...(input.trustedBindings.linearWorkspaceId
        ? {
            linearWorkspaceId: requiredId(
              input.trustedBindings.linearWorkspaceId,
              "linearWorkspaceId",
            ),
          }
        : {}),
      ...(input.trustedBindings.linearProjectId
        ? {
            linearProjectId: requiredId(
              input.trustedBindings.linearProjectId,
              "linearProjectId",
            ),
          }
        : {}),
    },
    workGraph: { rootNodeIds, nodes },
    ...(input.grantId ? { grantId: requiredId(input.grantId, "grantId") } : {}),
    budgets: {
      modelSteps: positiveInteger(input.budgets.modelSteps, "modelSteps"),
      toolCalls: positiveInteger(input.budgets.toolCalls, "toolCalls"),
      externalActions: nonNegativeInteger(
        input.budgets.externalActions,
        "externalActions",
      ),
      wallClockMs: positiveInteger(input.budgets.wallClockMs, "wallClockMs"),
    },
    acceptanceContract: {
      ...input.acceptanceContract,
      requiredProof: [...input.acceptanceContract.requiredProof],
      ...(input.acceptanceContract.relevanceTerms
        ? { relevanceTerms: [...input.acceptanceContract.relevanceTerms] }
        : {}),
    },
    lineage: {
      ...(input.lineage.parentMissionId
        ? {
            parentMissionId: requiredId(
              input.lineage.parentMissionId,
              "parentMissionId",
            ),
          }
        : {}),
      ...(input.lineage.parentIssueId
        ? {
            parentIssueId: requiredId(
              input.lineage.parentIssueId,
              "parentIssueId",
            ),
          }
        : {}),
      generation,
    },
  };
}

function normalizeNodes(
  source: Record<string, MissionEnvelopeNodeV2>,
): Record<string, MissionEnvelopeNodeV2> {
  const entries = Object.entries(source);
  if (entries.length === 0 || entries.length > 512) {
    throw new Error("Mission envelope requires 1-512 work nodes.");
  }
  return Object.fromEntries(
    entries.map(([key, node]) => {
      const id = requiredId(node.id || key, "node.id");
      if (id !== key) throw new Error(`Work node key must equal id: ${key}.`);
      return [
        id,
        {
          ...node,
          id,
          parentId: node.parentId ? requiredId(node.parentId, "parentId") : null,
          childIds: uniqueIds(node.childIds),
          dependencyIds: uniqueIds(node.dependencyIds),
          resources: node.resources.map(cloneResource),
          requiredCapabilities: uniqueIds(node.requiredCapabilities),
          requiredProofKinds: uniqueIds(node.requiredProofKinds),
          acceptanceCriteriaIds: uniqueIds(node.acceptanceCriteriaIds),
          actionIds: uniqueIds(node.actionIds),
          receiptIds: uniqueIds(node.receiptIds),
          ...(node.blocker
            ? { blocker: requiredText(node.blocker, "blocker", 2_000) }
            : {}),
        },
      ];
    }),
  );
}

function validateNodeGraph(
  nodes: Record<string, MissionEnvelopeNodeV2>,
  rootNodeIds: string[],
): void {
  for (const node of Object.values(nodes)) {
    if (node.parentId && !nodes[node.parentId]) {
      throw new Error(`Unknown parent node: ${node.parentId}.`);
    }
    for (const id of [...node.childIds, ...node.dependencyIds]) {
      if (!nodes[id]) throw new Error(`Unknown referenced node: ${id}.`);
      if (id === node.id) throw new Error(`Node ${node.id} references itself.`);
    }
    for (const childId of node.childIds) {
      if (nodes[childId]?.parentId !== node.id) {
        throw new Error(`Child ${childId} does not reference parent ${node.id}.`);
      }
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new Error(`Work graph cycle detected at ${id}.`);
    if (visited.has(id)) return;
    active.add(id);
    for (const child of nodes[id].childIds) visit(child);
    active.delete(id);
    visited.add(id);
  };
  rootNodeIds.forEach(visit);
  if (visited.size !== Object.keys(nodes).length) {
    throw new Error("Every work node must be reachable from a root node.");
  }
}

function cloneResource(resource: ResourceRef): ResourceRef {
  return { ...resource };
}

function requiredFingerprint(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("contractFingerprint must be a SHA-256 fingerprint.");
  }
  return normalized.startsWith("sha256:") ? normalized : `sha256:${normalized}`;
}

function requiredId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`${field} is invalid.`);
  }
  return normalized;
}

function requiredText(value: string, field: string, maximum: number): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${field} is invalid.`);
  }
  return normalized;
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => requiredId(value, "id")))];
}

function positiveInteger(value: number, field: string): number {
  return integerInRange(value, 1, Number.MAX_SAFE_INTEGER, field);
}

function nonNegativeInteger(value: number, field: string): number {
  return integerInRange(value, 0, Number.MAX_SAFE_INTEGER, field);
}

function integerInRange(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} is out of range.`);
  }
  return value;
}

