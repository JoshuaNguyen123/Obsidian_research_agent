import type { MissionEvidence } from "./missionLedger";
import { isBroadUnscopedVaultMutation } from "./missionScope";
import type { MissionIntent } from "../tools/types";
import {
  requiresVaultEvidenceProof,
  requiresWebEvidenceProof,
} from "./evidenceIntent";
import type { RunPlanDecision } from "./runPlan";

export type MissionPlanStatus =
  | "pending"
  | "in_progress"
  | "needs_verification"
  | "complete"
  | "blocked";

export type MissionPlanActionKind =
  | "model"
  | "tool"
  | "write"
  | "verify"
  | "resume"
  | "blocker"
  | "final";

export type MissionPlanProofKind =
  | "web_evidence"
  | "vault_evidence"
  | "write_receipt"
  | "external_action_receipt"
  | "artifact_receipt"
  | "word_count"
  | "rename_receipt"
  | "highlight_receipt"
  | "code_execution"
  | "final_relevance"
  | "blocker";

export const CODE_RUN_SUCCESS_EVIDENCE_ID = "code_run:success";
export const CODE_RUN_FAILURE_EVIDENCE_ID = "code_run:failed";
export const FINAL_OUTPUT_RELEVANT_EVIDENCE_ID = "final_output:relevant";
export const RECEIPT_PROOF_ID_PREFIX = "receipt-proof:";

/**
 * A code run proves the mission's code contract only when it actually executed
 * and exited cleanly: exit code 0 without timeout for process runs, or a
 * verified HTML preview render. Blocked/approval-pending outputs never count.
 */
export function isSuccessfulCodeRunOutput(output: unknown): boolean {
  if (!isRecord(output)) {
    return false;
  }
  if (output.status === "blocked" || output.status === "requires_approval") {
    return false;
  }
  if (output.operation === "render_html_preview") {
    return true;
  }
  const run = isRecord(output.run) ? output.run : null;
  const result = isRecord(output.result) ? output.result : null;
  const processResult = run ?? result;
  if (!processResult) {
    return false;
  }
  return processResult.exitCode === 0 && processResult.timedOut !== true;
}

export interface MissionCompletionContract {
  requiredProof: MissionPlanProofKind[];
  citationMode?: "source" | "passage";
  minEvidenceCount?: number;
  minDistinctDomains?: number;
  wordTarget?: number;
  relevanceTerms?: string[];
}

export interface MissionPlanAction {
  kind: MissionPlanActionKind;
  summary: string;
  toolName?: string;
  taskId?: string;
}

export interface MissionPlanTask {
  id: string;
  title: string;
  status: MissionPlanStatus;
  allowedTools: string[];
  dependencies: string[];
  evidenceIds: string[];
  receiptIds: string[];
  completionContract: MissionCompletionContract;
  blocker?: string;
}

export interface MissionReceiptProofLike {
  toolName?: string;
  operation?: string;
  affectedCount?: number;
  path?: string;
  resource?: {
    system?: string;
    resourceType?: string;
    id?: string;
  };
}

export interface MissionPlanProgress {
  score: number;
  completedTasks: number;
  totalTasks: number;
  remainingTasks: number;
  stalledCount: number;
  lastMeaningfulAction?: string;
}

export interface MissionPlan {
  version: 1;
  runId: string;
  status: MissionPlanStatus;
  activeTaskId: string | null;
  tasks: MissionPlanTask[];
  progress: MissionPlanProgress;
  nextAction?: MissionPlanAction;
  createdAt: string;
  updatedAt: string;
}

export type MissionPlanNodeKind =
  | "root"
  | "research"
  | "read"
  | "act"
  | "write"
  | "verify"
  | "recover"
  | "final";

export interface MissionPlanNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  order: number;
  depth: number;
  kind: MissionPlanNodeKind;
  title: string;
  status: MissionPlanStatus;
  allowedTools: string[];
  dependencies: string[];
  completionContract: MissionCompletionContract;
  evidenceIds: string[];
  receiptIds: string[];
  verifierIds: string[];
  blocker?: string;
  attempts: number;
}

export interface HierarchicalMissionPlan {
  version: 2;
  runId: string;
  status: MissionPlanStatus;
  rootIds: string[];
  nodes: Record<string, MissionPlanNode>;
  activeNodeId: string | null;
  activePath: string[];
  progress: MissionPlanProgress;
  nextAction?: MissionPlanAction;
  createdAt: string;
  updatedAt: string;
}

export type MissionPlanLike = MissionPlan | HierarchicalMissionPlan;

export interface CreateMissionPlanInput {
  runId: string;
  prompt: string;
  missionIntent: MissionIntent;
  runPlan: Pick<RunPlanDecision, "allowedToolNames" | "slowPathReason" | "route">;
  requiredTools?: string[];
  now?: Date;
}

export function createMissionPlan({
  runId,
  prompt,
  missionIntent,
  runPlan,
  requiredTools = [],
  now = new Date(),
}: CreateMissionPlanInput): MissionPlan {
  const timestamp = now.toISOString();
  const tasks = createMissionPlanTasks({
    prompt,
    missionIntent,
    // Streaming current-note writes are runner-owned and may be intentionally
    // absent from the model-facing tool list. They still belong in the
    // persisted task authority when they are required mission operations.
    // Keep required tools first because each task has a bounded tool catalog;
    // broad read routes must not truncate the tools needed to satisfy proof.
    allowedTools: dedupeStrings([
      ...requiredTools,
      ...runPlan.allowedToolNames,
    ]),
    requiredTools,
  });
  const activeTaskId = tasks.find((task) => task.status !== "complete")?.id ?? null;
  const plan: MissionPlan = {
    version: 1,
    runId,
    status: tasks.length === 0 ? "complete" : "in_progress",
    activeTaskId,
    tasks,
    progress: createProgress(tasks),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  plan.nextAction = getNextMissionPlanAction(plan);
  return plan;
}

export function normalizeMissionPlan(value: unknown): MissionPlan | undefined {
  if (isRecord(value) && value.version === 2) {
    const hierarchical = normalizeMissionPlanV2(value);
    return hierarchical ? hierarchicalMissionPlanToV1(hierarchical) : undefined;
  }

  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  const runId = getString(value.runId);
  const status = getStatus(value.status);
  const createdAt = getString(value.createdAt);
  const updatedAt = getString(value.updatedAt);
  if (!runId || !status || !createdAt || !updatedAt) {
    return undefined;
  }
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.map(normalizeTask).filter((task): task is MissionPlanTask => Boolean(task))
    : [];
  const activeTaskId =
    getString(value.activeTaskId) ??
    tasks.find((task) => task.status !== "complete")?.id ??
    null;
  const progress = normalizeProgress(value.progress, tasks);
  const plan: MissionPlan = {
    version: 1,
    runId,
    status,
    activeTaskId,
    tasks,
    progress,
    nextAction: normalizeAction(value.nextAction),
    createdAt,
    updatedAt,
  };
  if (!plan.nextAction) {
    plan.nextAction = getNextMissionPlanAction(plan);
  }
  return plan;
}

export function createHierarchicalMissionPlan(
  input: CreateMissionPlanInput,
): HierarchicalMissionPlan {
  return upgradeMissionPlanV1(createMissionPlan(input));
}

export function normalizeMissionPlanV2(
  value: unknown,
): HierarchicalMissionPlan | undefined {
  if (isRecord(value) && value.version === 1) {
    const v1 = normalizeMissionPlan(value);
    return v1 ? upgradeMissionPlanV1(v1) : undefined;
  }
  if (!isRecord(value) || value.version !== 2) {
    return undefined;
  }
  const runId = getString(value.runId);
  const status = getStatus(value.status);
  const createdAt = getString(value.createdAt);
  const updatedAt = getString(value.updatedAt);
  if (!runId || !status || !createdAt || !updatedAt || !isRecord(value.nodes)) {
    return undefined;
  }
  const nodes = Object.entries(value.nodes).reduce<Record<string, MissionPlanNode>>(
    (output, [id, node]) => {
      const normalized = normalizeNode(id, node);
      if (normalized) {
        output[normalized.id] = normalized;
      }
      return output;
    },
    {},
  );
  const activeNodeId = getString(value.activeNodeId) ?? getFirstActiveNodeId(nodes);
  const plan: HierarchicalMissionPlan = {
    version: 2,
    runId,
    status,
    rootIds: getStringArray(value.rootIds).filter((id) => Boolean(nodes[id])),
    nodes,
    activeNodeId,
    activePath: getActivePath(nodes, activeNodeId),
    progress: normalizeProgress(value.progress, nodesToTasks(nodes)),
    nextAction: normalizeAction(value.nextAction),
    createdAt,
    updatedAt,
  };
  return {
    ...plan,
    nextAction: plan.nextAction ?? getHierarchicalMissionPlanAction(plan),
  };
}

export function upgradeMissionPlanV1(plan: MissionPlan): HierarchicalMissionPlan {
  const rootId = "root";
  const taskIds = plan.tasks.map((task) => task.id);
  const nodes: Record<string, MissionPlanNode> = {
    [rootId]: {
      id: rootId,
      parentId: null,
      childIds: taskIds,
      order: 0,
      depth: 0,
      kind: "root",
      title: "Complete requested mission",
      status: plan.status,
      allowedTools: [],
      dependencies: [],
      completionContract: { requiredProof: [] },
      evidenceIds: [],
      receiptIds: [],
      verifierIds: [],
      attempts: 0,
    },
  };
  plan.tasks.forEach((task, index) => {
    nodes[task.id] = {
      id: task.id,
      parentId: rootId,
      childIds: [],
      order: index,
      depth: 1,
      kind: task.completionContract.requiredProof.some((proof) =>
        proof === "write_receipt" ||
        proof === "external_action_receipt" ||
        proof === "artifact_receipt" ||
        proof === "rename_receipt" ||
        proof === "highlight_receipt",
      )
        ? "write"
        : task.completionContract.requiredProof.some((proof) =>
            proof === "web_evidence" || proof === "vault_evidence"
          )
          ? "research"
          : "act",
      title: task.title,
      status: task.status,
      allowedTools: [...task.allowedTools],
      dependencies:
        task.dependencies.length > 0
          ? [...task.dependencies]
          : index > 0
            ? [plan.tasks[index - 1].id]
            : [],
      completionContract: {
        ...task.completionContract,
        requiredProof: [...task.completionContract.requiredProof],
        relevanceTerms: task.completionContract.relevanceTerms
          ? [...task.completionContract.relevanceTerms]
          : undefined,
      },
      evidenceIds: [...task.evidenceIds],
      receiptIds: [...task.receiptIds],
      verifierIds: [],
      blocker: task.blocker,
      attempts: task.status === "blocked" ? 1 : 0,
    };
  });
  const activeNodeId = plan.activeTaskId ?? getFirstActiveNodeId(nodes);
  return {
    version: 2,
    runId: plan.runId,
    status: plan.status,
    rootIds: [rootId],
    nodes,
    activeNodeId,
    activePath: getActivePath(nodes, activeNodeId),
    progress: plan.progress,
    nextAction: plan.nextAction,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export function getActivePlanNode(
  plan: HierarchicalMissionPlan | null | undefined,
): MissionPlanNode | null {
  if (!plan || !plan.activeNodeId) {
    return null;
  }
  return plan.nodes[plan.activeNodeId] ?? null;
}

export function getPlanFrontier(plan: HierarchicalMissionPlan): MissionPlanNode[] {
  return Object.values(plan.nodes)
    .filter((node) => node.depth > 0)
    .filter((node) => node.status !== "complete" && node.status !== "blocked")
    .filter((node) =>
      node.dependencies.every((dependency) => plan.nodes[dependency]?.status === "complete"),
    )
    .sort((left, right) => left.depth - right.depth || left.order - right.order);
}

export function advanceNodeFromToolResult(
  plan: HierarchicalMissionPlan,
  nodeId: string,
  evidenceId: string,
  now = new Date(),
): HierarchicalMissionPlan {
  const node = plan.nodes[nodeId];
  if (!node) {
    return plan;
  }
  const nodes = {
    ...plan.nodes,
    [nodeId]: {
      ...node,
      evidenceIds: dedupeStrings([...node.evidenceIds, evidenceId]),
    },
  };
  return refreshHierarchicalPlan({ ...plan, nodes, updatedAt: now.toISOString() });
}

export function advanceNodeFromReceipt(
  plan: HierarchicalMissionPlan,
  nodeId: string,
  receiptId: string,
  now = new Date(),
): HierarchicalMissionPlan {
  const node = plan.nodes[nodeId];
  if (!node) {
    return plan;
  }
  const nodes = {
    ...plan.nodes,
    [nodeId]: {
      ...node,
      receiptIds: dedupeStrings([...node.receiptIds, receiptId]),
    },
  };
  return refreshHierarchicalPlan({ ...plan, nodes, updatedAt: now.toISOString() });
}

export function advanceNodeFromVerifier(
  plan: HierarchicalMissionPlan,
  nodeId: string,
  verifierId: string,
  passed: boolean,
  now = new Date(),
): HierarchicalMissionPlan {
  const node = plan.nodes[nodeId];
  if (!node) {
    return plan;
  }
  const nodes = {
    ...plan.nodes,
    [nodeId]: {
      ...node,
      verifierIds: dedupeStrings([...node.verifierIds, verifierId]),
      status: passed ? "complete" as const : "needs_verification" as const,
    },
  };
  return refreshHierarchicalPlan({ ...plan, nodes, updatedAt: now.toISOString() });
}

export function normalizeMissionPlanLike(value: unknown): MissionPlanLike | undefined {
  return normalizeMissionPlanV2(value) ?? normalizeMissionPlan(value);
}

export function createHierarchicalMissionPlanFromV1(
  plan: MissionPlan,
): HierarchicalMissionPlan {
  return upgradeMissionPlanV1(plan);
}

export function hierarchicalMissionPlanToV1(
  plan: HierarchicalMissionPlan,
): MissionPlan {
  const compatibleTasks = nodesToTasks(plan.nodes);
  const activeTaskId =
    plan.activeNodeId &&
    compatibleTasks.some((task) => task.id === plan.activeNodeId)
      ? plan.activeNodeId
      : compatibleTasks.find(
          (task) => task.status !== "complete" && task.status !== "blocked",
        )?.id ?? null;
  const v1: MissionPlan = {
    version: 1,
    runId: plan.runId,
    status: plan.status,
    activeTaskId,
    tasks: compatibleTasks.map(copyTask),
    progress: { ...plan.progress },
    nextAction: plan.nextAction ? { ...plan.nextAction } : undefined,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
  if (!v1.nextAction) {
    v1.nextAction = getNextMissionPlanAction(v1);
  }
  return v1;
}

export function flattenMissionPlanTasks(plan: MissionPlanLike): MissionPlanTask[] {
  if (plan.version === 1) {
    return plan.tasks.map(copyTask);
  }

  return nodesToTasks(plan.nodes).map(copyTask);
}

export function getNextMissionPlanActionCompat(
  plan: MissionPlanLike | null | undefined,
): MissionPlanAction | undefined {
  if (!plan) {
    return undefined;
  }
  return getNextMissionPlanAction(
    plan.version === 1 ? plan : hierarchicalMissionPlanToV1(plan),
  );
}

export function getActiveMissionPlanTask(
  plan: MissionPlan | null | undefined,
): MissionPlanTask | null {
  if (!plan) {
    return null;
  }
  return (
    plan.tasks.find(
      (task) => task.id === plan.activeTaskId && isTaskReady(plan.tasks, task),
    ) ??
    plan.tasks.find((task) => isTaskReady(plan.tasks, task)) ??
    null
  );
}

/**
 * Returns whether the currently ready task explicitly authorizes a tool.
 * A missing plan keeps legacy single-loop behavior; a completed/blocked plan
 * has no ready task and therefore cannot authorize a new planned mutation.
 */
export function isToolAllowedForActiveMissionTask(
  plan: MissionPlan | null | undefined,
  toolName: string,
): boolean {
  if (!plan) {
    return true;
  }
  return getActiveMissionPlanTask(plan)?.allowedTools.includes(toolName) === true;
}

export function getNextMissionPlanAction(
  plan: MissionPlan | null | undefined,
): MissionPlanAction | undefined {
  const active = getActiveMissionPlanTask(plan);
  if (!plan || !active) {
    return plan && isMissionPlanComplete(plan)
      ? {
          kind: "final",
          summary: "All mission-plan tasks have required proof; synthesize final answer.",
        }
      : undefined;
  }

  if (active.blocker) {
    return {
      kind: "blocker",
      taskId: active.id,
      summary: active.blocker,
    };
  }

  const missingProof = getMissingTaskProof(active);
  if (missingProof.includes("web_evidence")) {
    if (
      active.allowedTools.includes("web_fetch") &&
      active.evidenceIds.some((id) => id.startsWith("web_search:"))
    ) {
      return toolAction(active, "web_fetch", "Fetch a selected web source.");
    }
    return toolAction(active, "web_search", "Gather required web evidence.");
  }
  if (missingProof.includes("vault_evidence")) {
    const navigatedToCandidates = active.evidenceIds.some(
      (id) => id.startsWith("vault_search:") || id.startsWith("graph:"),
    );
    return toolAction(
      active,
      firstAllowed(
        active,
        navigatedToCandidates
          ? [
              "read_markdown_files",
              "read_file",
              "semantic_search_notes",
              "search_markdown_files",
              "inspect_vault_context",
            ]
          : [
              "semantic_search_notes",
              "inspect_vault_context",
              "search_markdown_files",
              "read_markdown_files",
              "read_file",
            ],
      ),
      navigatedToCandidates
        ? "Read the selected vault note content; navigation results are not read proof."
        : "Find candidate vault notes, then read their content.",
    );
  }
  if (missingProof.includes("word_count")) {
    return toolAction(active, "count_words", "Verify word count.");
  }
  if (missingProof.includes("code_execution")) {
    return toolAction(
      active,
      "run_code_block",
      "Run the requested code until it exits with code 0.",
    );
  }
  if (missingProof.includes("rename_receipt")) {
    return {
      kind: "write",
      taskId: active.id,
      toolName: firstAllowed(active, ["rename_current_file", "retitle_current_file"]),
      summary: "Rename the requested note and capture the matching rename receipt.",
    };
  }
  if (missingProof.includes("highlight_receipt")) {
    return {
      kind: "write",
      taskId: active.id,
      toolName: firstAllowed(active, ["highlight_current_file_phrase"]),
      summary: "Highlight the requested phrase and capture a non-zero highlight receipt.",
    };
  }
  if (missingProof.includes("artifact_receipt")) {
    return {
      kind: "write",
      taskId: active.id,
      toolName: active.allowedTools.find(isArtifactTool),
      summary: "Create the requested artifact and capture matching artifact proof.",
    };
  }
  if (missingProof.includes("external_action_receipt")) {
    return {
      kind: "write",
      taskId: active.id,
      toolName: active.allowedTools.find(isExternalActionTool),
      summary:
        "Complete the requested external-system action and capture its canonical receipt.",
    };
  }
  if (missingProof.includes("write_receipt")) {
    return {
      kind: "write",
      taskId: active.id,
      toolName: active.allowedTools.find(isGenericWriteTool),
      summary: "Complete the requested vault write and capture its write receipt.",
    };
  }

  if (missingProof.includes("final_relevance")) {
    return {
      kind: "verify",
      taskId: active.id,
      summary: "Produce a final answer that addresses the mission and cites bound source identifiers.",
    };
  }

  return {
    kind: "verify",
    taskId: active.id,
    summary: "Verify this task against its completion contract.",
  };
}

export function isMissionPlanComplete(plan: MissionPlan | null | undefined): boolean {
  return Boolean(
    plan &&
      plan.tasks.length > 0 &&
      plan.tasks.every((task) => task.status === "complete" || task.status === "blocked") &&
      plan.tasks.some((task) => task.status === "complete"),
  );
}

export function countRemainingMissionPlanTasks(
  plan: MissionPlan | null | undefined,
): number {
  return plan
    ? plan.tasks.filter(
        (task) => task.status !== "complete" && task.status !== "blocked",
      ).length
    : 0;
}

export function refreshMissionPlanProgress(plan: MissionPlan): MissionPlan {
  const tasks = blockTasksWithBlockedDependencies(plan.tasks);
  const progress = createProgress(tasks, plan.progress);
  const activeTaskId =
    tasks.find((task) => isTaskReady(tasks, task))?.id ?? null;
  const terminal =
    tasks.length > 0 &&
    tasks.every((task) => task.status === "complete" || task.status === "blocked");
  const complete = terminal && tasks.every((task) => task.status === "complete");
  const blocked = tasks.some((task) => task.status === "blocked");
  return {
    ...plan,
    tasks,
    activeTaskId,
    status: complete
      ? "complete"
      : terminal || blocked || plan.status === "blocked"
        ? "blocked"
        : "in_progress",
    progress,
    nextAction: getNextMissionPlanAction({ ...plan, tasks, activeTaskId, progress }),
  };
}

export function getEvidenceProofKinds(evidence: MissionEvidence[]): MissionPlanProofKind[] {
  const proofs = new Set<MissionPlanProofKind>();
  for (const item of evidence) {
    if (isWebEvidence(item)) {
      proofs.add("web_evidence");
    }
    if (isVaultReadEvidence(item)) {
      proofs.add("vault_evidence");
    }
    if (item.kind === "artifact") {
      proofs.add("artifact_receipt");
    }
    if (item.kind === "receipt") {
      if (item.id.startsWith("receipt:external:")) {
        proofs.add("external_action_receipt");
      } else if (item.id.startsWith("receipt:vault:") || item.path) {
        proofs.add("write_receipt");
      }
    }
  }
  return [...proofs];
}

export function isFetchedWebEvidence(evidence: MissionEvidence): boolean {
  if (evidence.kind !== "web_source" || !evidence.url?.trim()) {
    return false;
  }
  const record = evidence as MissionEvidence & Record<string, unknown>;
  if (record.usableSource === false) {
    return false;
  }
  return getEvidencePassageIdentifiers(evidence).length > 0;
}

export function isWebEvidence(evidence: MissionEvidence): boolean {
  return evidence.kind === "web_source";
}

export function isVaultReadEvidence(evidence: MissionEvidence): boolean {
  return (
    evidence.kind === "vault_note" &&
    (evidence.id.startsWith("vault:") ||
      evidence.id.startsWith("vault_batch:") ||
      evidence.id.startsWith("vault_search:"))
  );
}

export function getTaskEvidence(
  task: MissionPlanTask,
  evidence: MissionEvidence[],
  allowUnboundFallback = false,
): MissionEvidence[] {
  const boundIds = new Set(task.evidenceIds);
  const bound = evidence.filter((item) => boundIds.has(item.id));
  return bound.length > 0 || !allowUnboundFallback ? bound : evidence;
}

export function getEvidenceCitationIdentifiers(
  evidence: MissionEvidence,
): string[] {
  const passages = getEvidencePassageIdentifiers(evidence);
  if (passages.length > 0) {
    return passages;
  }
  const record = evidence as MissionEvidence & Record<string, unknown>;
  const sourceId = getString(record.sourceId);
  return sourceId ? [sourceId] : evidence.url ? [evidence.url] : [];
}

export function getEvidencePassageIdentifiers(
  evidence: MissionEvidence,
): string[] {
  const record = evidence as MissionEvidence & Record<string, unknown>;
  const passageIdentifiers = [
    getString(record.passageId),
    ...getStringArray(record.passageIds),
    ...(evidence.id.startsWith("source:") || evidence.id.startsWith("passage:")
      ? [evidence.id]
      : []),
  ];
  const passages = dedupeStrings(
    passageIdentifiers.filter((value): value is string => Boolean(value)),
  );
  return passages;
}

export function getReceiptProofKinds(
  receipt: MissionReceiptProofLike,
): MissionPlanProofKind[] {
  if (receiptSatisfiesProof("rename_receipt", receipt)) {
    return ["rename_receipt"];
  }
  if (receiptSatisfiesProof("highlight_receipt", receipt)) {
    return ["highlight_receipt"];
  }
  if (receiptSatisfiesProof("artifact_receipt", receipt)) {
    return ["artifact_receipt"];
  }
  if (receiptSatisfiesProof("external_action_receipt", receipt)) {
    return ["external_action_receipt"];
  }
  return receiptSatisfiesProof("write_receipt", receipt) ? ["write_receipt"] : [];
}

export function receiptSatisfiesProof(
  proof: MissionPlanProofKind,
  receipt: MissionReceiptProofLike,
): boolean {
  const toolName = receipt.toolName ?? "";
  const operation = receipt.operation ?? "";
  switch (proof) {
    case "rename_receipt":
      return isRenameTool(toolName) && /^(?:rename_current_file|retitle)$/.test(operation);
    case "highlight_receipt":
      return (
        isHighlightTool(toolName) &&
        operation === "highlight" &&
        (receipt.affectedCount ?? 0) > 0
      );
    case "artifact_receipt":
      return isArtifactTool(toolName);
    case "external_action_receipt":
      return (
        (receipt.resource?.system === "linear" ||
          receipt.resource?.system === "github") &&
        Boolean(receipt.resource.id) &&
        !["read", "list", "search"].includes(operation)
      );
    case "write_receipt":
      if (
        receipt.resource &&
        (receipt.resource.system === "workspace" || receipt.resource.system === "git")
      ) {
        return isCodeChangeTool(toolName) &&
          !["read", "list", "search", "validate"].includes(operation);
      }
      if (receipt.resource && receipt.resource.system !== "vault") {
        return false;
      }
      return (
        !isRenameTool(toolName) &&
        !isHighlightTool(toolName) &&
        !isArtifactTool(toolName) &&
        (isGenericWriteTool(toolName) || isGenericWriteOperation(operation))
      );
    default:
      return false;
  }
}

export function taskHasRecordedProof(
  task: MissionPlanTask,
  proof: MissionPlanProofKind,
): boolean {
  const minimum = Math.max(1, task.completionContract.minEvidenceCount ?? 1);
  switch (proof) {
    case "web_evidence":
      if (
        task.completionContract.citationMode !== undefined ||
        (task.completionContract.minDistinctDomains ?? 0) > 0
      ) {
        // Source/citation contracts require fetched source proof, not just
        // search-result navigation candidates.
        return task.evidenceIds.filter((id) => id.startsWith("web:")).length >= minimum;
      }
      return task.evidenceIds.filter(
        (id) => id.startsWith("web:") || id.startsWith("web_search:"),
      ).length >= minimum;
    case "vault_evidence":
      return task.evidenceIds.filter(
        (id) => id.startsWith("vault:") || id.startsWith("vault_batch:"),
      ).length >= minimum;
    case "artifact_receipt":
      return task.evidenceIds.some((id) => id.startsWith("artifact:")) ||
        task.receiptIds.includes(`${RECEIPT_PROOF_ID_PREFIX}${proof}`);
    case "write_receipt":
    case "external_action_receipt":
    case "rename_receipt":
    case "highlight_receipt":
      return task.receiptIds.includes(`${RECEIPT_PROOF_ID_PREFIX}${proof}`);
    case "word_count":
      return task.evidenceIds.includes("tool:count_words");
    case "code_execution":
      return task.evidenceIds.includes(CODE_RUN_SUCCESS_EVIDENCE_ID);
    case "final_relevance":
      return task.evidenceIds.includes(FINAL_OUTPUT_RELEVANT_EVIDENCE_ID);
    case "blocker":
      return Boolean(task.blocker);
  }
}

export function isFinalOutputRelevant(
  plan: MissionPlan,
  finalOutput: string | undefined,
): boolean {
  const output = finalOutput?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
  if (!output) {
    return false;
  }
  const verificationTasks = plan.tasks.filter((task) =>
    task.completionContract.requiredProof.includes("final_relevance"),
  );
  const tasks = verificationTasks.length > 0 ? verificationTasks : plan.tasks;
  const requiredLiteralAnchors = dedupeStrings(
    tasks.flatMap((task) => extractRequiredLiteralAnchors(task.title)),
  );
  if (
    requiredLiteralAnchors.some(
      (anchor) => !output.includes(anchor.toLowerCase()),
    )
  ) {
    return false;
  }
  const terms = dedupeStrings(
    tasks.flatMap((task) =>
      task.completionContract.relevanceTerms?.length
        ? task.completionContract.relevanceTerms
        : extractRelevanceTerms(task.title),
    ),
  );
  return terms.length === 0 || terms.some((term) => output.includes(term.toLowerCase()));
}

function createMissionPlanTasks({
  prompt,
  missionIntent,
  allowedTools,
  requiredTools,
}: {
  prompt: string;
  missionIntent: MissionIntent;
  allowedTools: string[];
  requiredTools: string[];
}): MissionPlanTask[] {
  const contract = inferProofContract(prompt, missionIntent, requiredTools);
  const sourceProof = contract.requiredProof.filter(
    (proof) => proof === "web_evidence" || proof === "vault_evidence",
  );
  const operationProof = contract.requiredProof.filter((proof) =>
    [
      "write_receipt",
      "external_action_receipt",
      "artifact_receipt",
      "rename_receipt",
      "highlight_receipt",
      "code_execution",
    ].includes(proof),
  );
  const verificationProof = contract.requiredProof.filter(
    (proof) => proof === "word_count",
  );
  const shouldDecompose =
    !contract.requiredProof.includes("blocker") &&
    sourceProof.length > 0 &&
    operationProof.length + verificationProof.length > 0 &&
    /\b(research|investigat(?:e|ion)|compare|verify|fact[-\s]?check|citations?|cited|latest|current)\b/i.test(
      prompt,
    );

  if (!shouldDecompose) {
    return [
      makeMissionTask({
        id: "task-1",
        title: summarizeMissionTaskTitle(prompt),
        allowedTools,
        completionContract: contract,
      }),
    ];
  }

  const tasks: MissionPlanTask[] = [];
  const addTask = (
    id: string,
    title: string,
    tools: string[],
    completionContract: MissionCompletionContract,
  ) => {
    const previous = tasks.at(-1);
    tasks.push(
      makeMissionTask({
        id,
        title,
        allowedTools: tools,
        dependencies: previous ? [previous.id] : [],
        completionContract,
        status: tasks.length === 0 ? "in_progress" : "pending",
      }),
    );
  };
  const missionTitle = summarizeMissionTaskTitle(prompt);

  if (sourceProof.includes("web_evidence")) {
    addTask(
      "task-research-web",
      `Gather fetched web sources for: ${missionTitle}`,
      allowedTools.filter(isWebResearchTool),
      {
        requiredProof: ["web_evidence"],
        citationMode: contract.citationMode,
        minEvidenceCount: 1,
        minDistinctDomains: 1,
      },
    );
  }
  if (sourceProof.includes("vault_evidence")) {
    addTask(
      "task-research-vault",
      `Read relevant vault notes for: ${missionTitle}`,
      allowedTools.filter(isVaultResearchTool),
      { requiredProof: ["vault_evidence"], minEvidenceCount: 1 },
    );
  }
  if (operationProof.length > 0) {
    addTask(
      "task-act",
      `Execute the requested action for: ${missionTitle}`,
      allowedTools.filter((tool) => toolSupportsProof(tool, operationProof)),
      { requiredProof: operationProof },
    );
  }
  addTask(
    "task-verify",
    `Verify the final answer for: ${missionTitle}`,
    allowedTools.filter(isVerificationTool),
    {
      requiredProof: dedupeProofKinds([...verificationProof, "final_relevance"]),
      relevanceTerms: extractRelevanceTerms(prompt),
    },
  );

  return tasks.slice(0, 4);
}

function inferProofContract(
  prompt: string,
  intent: MissionIntent,
  requiredTools: string[],
): MissionCompletionContract {
  const requiredProof = new Set<MissionPlanProofKind>();
  if (intent.explicitMutation && isBroadUnscopedVaultMutation(intent.autonomyScope)) {
    requiredProof.add("blocker");
    return {
      requiredProof: [...requiredProof],
    };
  }
  if (requiresWebEvidenceProof(prompt, intent)) {
    requiredProof.add("web_evidence");
  }
  if (requiresVaultEvidenceProof(prompt, intent)) {
    requiredProof.add("vault_evidence");
  }
  if (/\b(word\s*count|count\s+(?:the\s+)?words?|verify\s+(?:the\s+)?(?:word\s+)?length)\b/i.test(prompt)) {
    requiredProof.add("word_count");
  }
  const hasSpecializedWrite = requiredTools.some(
    (tool) =>
      isRenameTool(tool) ||
      isHighlightTool(tool) ||
      isArtifactTool(tool) ||
      isExternalActionTool(tool),
  );
  if (
    requiredTools.some(isGenericWriteTool) ||
    (intent.requireWriteCompletion && !hasSpecializedWrite)
  ) {
    requiredProof.add("write_receipt");
  }
  if (requiredTools.includes("run_code_block")) {
    requiredProof.add("code_execution");
  }
  if (requiredTools.some(isRenameTool)) {
    requiredProof.add("rename_receipt");
  }
  if (requiredTools.some(isHighlightTool)) {
    requiredProof.add("highlight_receipt");
  }
  if (requiredTools.some(isArtifactTool)) {
    requiredProof.add("artifact_receipt");
  }
  if (requiredTools.some(isExternalActionTool)) {
    requiredProof.add("external_action_receipt");
  }
  const passageCitationMode = requiresPassageCitationProof(prompt);
  return {
    requiredProof: [...requiredProof],
    citationMode: requiredProof.has("web_evidence")
      ? passageCitationMode
        ? "passage"
        : "source"
      : undefined,
    minEvidenceCount: requiredProof.has("web_evidence") ? 1 : undefined,
  };
}

export function extractRequiredLiteralAnchors(text: string): string[] {
  const anchors: string[] = [];
  const pattern = /\b(?:include(?:\s+the)?(?:\s+marker)?|containing)\s+[`"']?([a-z0-9][a-z0-9_.:-]{7,})[`"']?/giu;
  for (const match of text.matchAll(pattern)) {
    const anchor = match[1]?.replace(/[.,;!?]+$/gu, "") ?? "";
    if (anchor) anchors.push(anchor);
  }
  return anchors;
}

function requiresPassageCitationProof(prompt: string): boolean {
  return /\b(?:cite|cited|citation|citations|passage|passages|quote|quoted|quotations|text[-\s]?level\s+quotation|verify|fact[-\s]?check|deep\s+research|long[-\s]?running\s+(?:research|co-?research)|long\s+research|exhaustive\s+(?:research|investigation))\b/i.test(
    prompt,
  );
}

function getMissingTaskProof(task: MissionPlanTask): MissionPlanProofKind[] {
  return task.completionContract.requiredProof.filter(
    (proof) => !taskHasRecordedProof(task, proof),
  );
}

function createProgress(
  tasks: MissionPlanTask[],
  previous?: MissionPlanProgress,
): MissionPlanProgress {
  const completedTasks = tasks.filter((task) => task.status === "complete").length;
  const totalTasks = tasks.length;
  const remainingTasks = tasks.filter(
    (task) => task.status !== "complete" && task.status !== "blocked",
  ).length;
  return {
    score: totalTasks === 0 ? 1 : roundScore(completedTasks / totalTasks),
    completedTasks,
    totalTasks,
    remainingTasks,
    stalledCount: previous?.stalledCount ?? 0,
    lastMeaningfulAction: previous?.lastMeaningfulAction,
  };
}

function normalizeTask(value: unknown): MissionPlanTask | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  const title = getString(value.title);
  const status = getStatus(value.status);
  if (!id || !title || !status) {
    return null;
  }
  return {
    id,
    title,
    status,
    allowedTools: getStringArray(value.allowedTools),
    dependencies: getStringArray(value.dependencies),
    evidenceIds: getStringArray(value.evidenceIds),
    receiptIds: getStringArray(value.receiptIds),
    completionContract: normalizeContract(value.completionContract),
    blocker: getString(value.blocker),
  };
}

function normalizeNode(id: string, value: unknown): MissionPlanNode | null {
  if (!isRecord(value)) {
    return null;
  }
  const nodeId = getString(value.id) ?? id;
  const status = getStatus(value.status);
  const kind = getNodeKind(value.kind);
  const title = getString(value.title);
  if (!nodeId || !status || !kind || !title) {
    return null;
  }
  return {
    id: nodeId,
    parentId: getString(value.parentId) ?? null,
    childIds: getStringArray(value.childIds),
    order: getNumber(value.order) ?? 0,
    depth: getNumber(value.depth) ?? 0,
    kind,
    title,
    status,
    allowedTools: getStringArray(value.allowedTools),
    dependencies: getStringArray(value.dependencies),
    completionContract: normalizeContract(value.completionContract),
    evidenceIds: getStringArray(value.evidenceIds),
    receiptIds: getStringArray(value.receiptIds),
    verifierIds: getStringArray(value.verifierIds),
    blocker: getString(value.blocker),
    attempts: getNumber(value.attempts) ?? 0,
  };
}

function normalizeContract(value: unknown): MissionCompletionContract {
  if (!isRecord(value)) {
    return { requiredProof: [] };
  }
  return {
    requiredProof: getStringArray(value.requiredProof).filter(isProofKind),
    citationMode:
      value.citationMode === "passage" || value.citationMode === "source"
        ? value.citationMode
        : undefined,
    minEvidenceCount: getNumber(value.minEvidenceCount),
    minDistinctDomains: getNumber(value.minDistinctDomains),
    wordTarget: getNumber(value.wordTarget),
    relevanceTerms: getStringArray(value.relevanceTerms),
  };
}

function normalizeProgress(
  value: unknown,
  tasks: MissionPlanTask[],
): MissionPlanProgress {
  if (!isRecord(value)) {
    return createProgress(tasks);
  }
  return {
    score: getNumber(value.score) ?? createProgress(tasks).score,
    completedTasks: getNumber(value.completedTasks) ?? 0,
    totalTasks: getNumber(value.totalTasks) ?? tasks.length,
    remainingTasks: getNumber(value.remainingTasks) ?? countRemainingFromTasks(tasks),
    stalledCount: getNumber(value.stalledCount) ?? 0,
    lastMeaningfulAction: getString(value.lastMeaningfulAction),
  };
}

function normalizeAction(value: unknown): MissionPlanAction | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = getActionKind(value.kind);
  const summary = getString(value.summary);
  if (!kind || !summary) {
    return undefined;
  }
  return {
    kind,
    summary,
    toolName: getString(value.toolName),
    taskId: getString(value.taskId),
  };
}

function countRemainingFromTasks(tasks: MissionPlanTask[]): number {
  return tasks.filter((task) => task.status !== "complete" && task.status !== "blocked").length;
}

function toolAction(
  task: MissionPlanTask,
  toolName: string | undefined,
  summary: string,
): MissionPlanAction {
  return {
    kind: "tool",
    taskId: task.id,
    toolName,
    summary,
  };
}

function firstAllowed(task: MissionPlanTask, names: string[]): string | undefined {
  return names.find((name) => task.allowedTools.includes(name));
}

function summarizeMissionTaskTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

function makeMissionTask({
  id,
  title,
  allowedTools,
  completionContract,
  dependencies = [],
  status = "in_progress",
}: {
  id: string;
  title: string;
  allowedTools: string[];
  completionContract: MissionCompletionContract;
  dependencies?: string[];
  status?: MissionPlanStatus;
}): MissionPlanTask {
  return {
    id,
    title: summarizeMissionTaskTitle(title),
    status,
    allowedTools: dedupeStrings(allowedTools).slice(0, 12),
    dependencies: dedupeStrings(dependencies).slice(0, 3),
    evidenceIds: [],
    receiptIds: [],
    completionContract: {
      ...completionContract,
      requiredProof: dedupeProofKinds(completionContract.requiredProof),
      relevanceTerms: completionContract.relevanceTerms
        ? dedupeStrings(completionContract.relevanceTerms).slice(0, 8)
        : undefined,
    },
  };
}

function isTaskReady(tasks: MissionPlanTask[], task: MissionPlanTask): boolean {
  if (task.status === "complete" || task.status === "blocked") {
    return false;
  }
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return task.dependencies.every(
    (dependency) => byId.get(dependency)?.status === "complete",
  );
}

function blockTasksWithBlockedDependencies(
  tasks: MissionPlanTask[],
): MissionPlanTask[] {
  const next = tasks.map(copyTask);
  let changed = true;
  while (changed) {
    changed = false;
    const byId = new Map(next.map((task) => [task.id, task]));
    for (let index = 0; index < next.length; index += 1) {
      const task = next[index];
      if (task.status === "complete" || task.status === "blocked") {
        continue;
      }
      const blockedDependency = task.dependencies.find(
        (dependency) => byId.get(dependency)?.status === "blocked",
      );
      if (blockedDependency) {
        next[index] = {
          ...task,
          status: "blocked",
          blocker: `Dependency ${blockedDependency} is blocked.`,
        };
        changed = true;
      }
    }
  }
  return next;
}

function isWebResearchTool(tool: string): boolean {
  return (
    tool === "web_search" ||
    tool === "web_fetch" ||
    tool === "read_source_section"
  );
}

function isVaultResearchTool(tool: string): boolean {
  return [
    "read_current_file",
    "read_file",
    "read_markdown_files",
    "list_markdown_files",
    "search_markdown_files",
    "semantic_search_notes",
    "inspect_semantic_index",
    "inspect_vault_context",
    "get_note_graph_context",
    "find_related_notes",
  ].includes(tool);
}

function isVerificationTool(tool: string): boolean {
  return tool === "count_words" || tool === "read_current_file" || tool === "read_file";
}

function isRenameTool(tool: string): boolean {
  return tool === "rename_current_file" || tool === "retitle_current_file";
}

function isHighlightTool(tool: string): boolean {
  return tool === "highlight_current_file_phrase";
}

function isArtifactTool(tool: string): boolean {
  return tool.startsWith("create_design") ||
    tool === "create_svg_design" ||
    tool === "open_web_source";
}

function isGenericWriteTool(tool: string): boolean {
  if (
    isRenameTool(tool) ||
    isHighlightTool(tool) ||
    isArtifactTool(tool) ||
    isExternalActionTool(tool)
  ) {
    return false;
  }
  return /append|replace|edit|restore|create(?:_file|_folder|_template|_research_pack)?|seed_default_templates|move|delete|trash|link_related|memory_write|fill_template/.test(
    tool,
  );
}

function isExternalActionTool(tool: string): boolean {
  return (
    (
      tool === "publish_research_to_linear" ||
      tool === "publish_research_project_to_linear" ||
      /^(?:linear|github)_/u.test(tool)
    ) &&
    !/_(?:read|get|list|search|find|inspect|resolve)(?:_|$)/u.test(tool)
  );
}

function isCodeChangeTool(tool: string): boolean {
  return (
    (/^(?:code_workspace_|write_workspace_file$|replace_workspace_text$)/u.test(tool) &&
      !/^code_workspace_(?:status|stat|list|read|search)$/u.test(tool)) ||
    tool === "code_commit_verified"
  );
}

function isGenericWriteOperation(operation: string): boolean {
  return [
    "create",
    "create_folder",
    "append",
    "replace",
    "edit",
    "restore",
    "link_related_notes",
    "move",
    "trash",
    "delete",
  ].includes(operation);
}

function toolSupportsProof(
  tool: string,
  proof: MissionPlanProofKind[],
): boolean {
  return (
    (proof.includes("write_receipt") && isGenericWriteTool(tool)) ||
    (proof.includes("external_action_receipt") && isExternalActionTool(tool)) ||
    (proof.includes("rename_receipt") && isRenameTool(tool)) ||
    (proof.includes("highlight_receipt") && isHighlightTool(tool)) ||
    (proof.includes("artifact_receipt") && isArtifactTool(tool)) ||
    (proof.includes("code_execution") && tool === "run_code_block")
  );
}

function extractRelevanceTerms(value: string): string[] {
  const stopWords = new Set([
    "about",
    "across",
    "answer",
    "append",
    "cited",
    "citation",
    "citations",
    "compare",
    "current",
    "directly",
    "evidence",
    "final",
    "find",
    "latest",
    "mission",
    "note",
    "notes",
    "please",
    "research",
    "requested",
    "source",
    "sources",
    "summary",
    "verify",
    "web",
    "write",
  ]);
  const selectedBlock =
    /Selected text:\s*"""([\s\S]*?)"""/i.exec(value)?.[1] ??
    /Selected text:\s*"([\s\S]*?)"/i.exec(value)?.[1] ??
    "";
  const preferred = selectedBlock.trim()
    ? extractRelevanceTermsFromBlob(selectedBlock, stopWords)
    : [];
  const general = extractRelevanceTermsFromBlob(value, stopWords);
  return dedupeStrings([...preferred, ...general]).slice(0, 8);
}

function extractRelevanceTermsFromBlob(
  value: string,
  stopWords: Set<string>,
): string[] {
  return (
    value
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{3,}/g)
      ?.filter((term) => !stopWords.has(term)) ?? []
  );
}

function getStatus(value: unknown): MissionPlanStatus | null {
  return value === "pending" ||
    value === "in_progress" ||
    value === "needs_verification" ||
    value === "complete" ||
    value === "blocked"
    ? value
    : null;
}

function getActionKind(value: unknown): MissionPlanActionKind | null {
  return value === "model" ||
    value === "tool" ||
    value === "write" ||
    value === "verify" ||
    value === "resume" ||
    value === "blocker" ||
    value === "final"
    ? value
    : null;
}

function isProofKind(value: string): value is MissionPlanProofKind {
  return [
    "web_evidence",
    "vault_evidence",
    "write_receipt",
    "external_action_receipt",
    "artifact_receipt",
    "word_count",
    "rename_receipt",
    "highlight_receipt",
    "code_execution",
    "final_relevance",
    "blocker",
  ].includes(value);
}

function getNodeKind(value: unknown): MissionPlanNodeKind | null {
  return value === "root" ||
    value === "research" ||
    value === "read" ||
    value === "act" ||
    value === "write" ||
    value === "verify" ||
    value === "recover" ||
    value === "final"
    ? value
    : null;
}

function getFirstActiveNodeId(nodes: Record<string, MissionPlanNode>): string | null {
  return (
    Object.values(nodes)
      .sort((left, right) => left.depth - right.depth || left.order - right.order)
      .find((node) => node.depth > 0 && node.status !== "complete" && node.status !== "blocked")
      ?.id ?? null
  );
}

function getActivePath(
  nodes: Record<string, MissionPlanNode>,
  activeNodeId: string | null,
): string[] {
  const path: string[] = [];
  let cursor = activeNodeId ? nodes[activeNodeId] : undefined;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.unshift(cursor.id);
    cursor = cursor.parentId ? nodes[cursor.parentId] : undefined;
  }
  return path;
}

function nodesToTasks(nodes: Record<string, MissionPlanNode>): MissionPlanTask[] {
  return Object.values(nodes)
    .filter((node) => node.depth > 0)
    .map((node) => ({
      id: node.id,
      title: node.title,
      status: node.status,
      allowedTools: node.allowedTools,
      dependencies: node.dependencies,
      evidenceIds: node.evidenceIds,
      receiptIds: node.receiptIds,
      completionContract: node.completionContract,
      blocker: node.blocker,
    }));
}

function getHierarchicalMissionPlanAction(
  plan: HierarchicalMissionPlan,
): MissionPlanAction | undefined {
  const frontier = getPlanFrontier(plan);
  const active = frontier[0];
  if (!active) {
    return plan.status === "complete"
      ? {
          kind: "final",
          summary: "All mission-plan nodes have required proof; synthesize final answer.",
        }
      : undefined;
  }
  return getNextMissionPlanAction({
    version: 1,
    runId: plan.runId,
    status: plan.status,
    activeTaskId: active.id,
    tasks: nodesToTasks(plan.nodes),
    progress: plan.progress,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  });
}

function refreshHierarchicalPlan(
  plan: HierarchicalMissionPlan,
): HierarchicalMissionPlan {
  const tasks = nodesToTasks(plan.nodes);
  const activeNodeId = getFirstActiveNodeId(plan.nodes);
  const progress = createProgress(tasks, plan.progress);
  const complete = tasks.length > 0 && tasks.every((task) => task.status === "complete");
  const blocked =
    tasks.length > 0 &&
    tasks.every((task) => task.status === "complete" || task.status === "blocked") &&
    !complete;
  const next = {
    ...plan,
    status: complete ? "complete" as const : blocked ? "blocked" as const : "in_progress" as const,
    activeNodeId,
    activePath: getActivePath(plan.nodes, activeNodeId),
    progress,
  };
  return {
    ...next,
    nextAction: getHierarchicalMissionPlanAction(next),
  };
}

function copyTask(task: MissionPlanTask): MissionPlanTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    allowedTools: [...task.allowedTools],
    dependencies: [...task.dependencies],
    evidenceIds: [...task.evidenceIds],
    receiptIds: [...task.receiptIds],
    completionContract: {
      ...task.completionContract,
      requiredProof: [...task.completionContract.requiredProof],
      relevanceTerms: task.completionContract.relevanceTerms
        ? [...task.completionContract.relevanceTerms]
        : undefined,
    },
    blocker: task.blocker,
  };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function dedupeProofKinds(values: MissionPlanProofKind[]): MissionPlanProofKind[] {
  return [...new Set(values)];
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
