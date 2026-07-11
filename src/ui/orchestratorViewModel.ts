import type { OrchestratorSnapshotV1 } from "../orchestrator/types";

export const DEFAULT_ORCHESTRATOR_VIEW_LIMITS = {
  agents: 8,
  artifactsPerNode: 12,
  evidencePerNode: 20,
  handoffs: 12,
  treeNodes: 100,
  unresolvedQuestions: 8,
  validationCommands: 8,
  worktrees: 16,
} as const;

export interface OrchestratorViewLimits {
  agents: number;
  artifactsPerNode: number;
  evidencePerNode: number;
  handoffs: number;
  treeNodes: number;
  unresolvedQuestions: number;
  validationCommands: number;
  worktrees: number;
}

export interface OrchestratorSummaryViewModel {
  mode: string;
  status: string;
  agentCount: number;
  completeTasks: number;
  totalTasks: number;
  evidenceCount: number;
  worktreeCount: number;
  elapsed: string;
  budget: string;
}

export interface OrchestratorNodeViewModel {
  id: string;
  parentId: string | null;
  childIds: string[];
  omittedChildCount: number;
  kind: string;
  title: string;
  status: string;
  ownerId: string | null;
  ownerLabel: string;
  dependencyIds: string[];
  evidenceIds: string[];
  receiptIds: string[];
  artifactLabels: string[];
  worktreeId: string | null;
  proofContract: string;
  lastAction: string;
  resultSummary: string;
  blocker: string;
}

export interface OrchestratorAgentViewModel {
  id: string;
  label: string;
  role: string;
  status: string;
  task: string;
  currentNodeId: string | null;
  budget: string;
  lastAction: string;
  handoffStatus: string;
  evidenceCount: number;
  resultSummary: string;
  blocker: string;
}

export interface OrchestratorWorktreeViewModel {
  id: string;
  taskId: string;
  repositoryRoot: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  status: string;
  changedFiles: number;
  changedFilePaths: string[];
  validationCommands: string[];
  currentValidationCommand: string;
  validationPassed: boolean;
  commitSha: string;
  blocker: string;
  cleanupState: string;
}

export interface OrchestratorHandoffViewModel {
  id: string;
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  status: string;
  summary: string;
  sourceIds: string[];
  evidenceIds: string[];
  unresolvedQuestions: string[];
  confidence: string;
  stopReason: string;
  commitSha: string;
}

export interface OrchestratorMergeViewModel {
  status: string;
  received: number;
  accepted: number;
  rejected: number;
  deduplicated: number;
  conflicts: number;
  codeCommits: number;
  verification: string;
  integration: string;
  blocker: string;
}

export interface OrchestratorSourceLedgerViewModel {
  candidateCount: number;
  usableCount: number;
  unusableCount: number;
  rejectedCount: number;
  proofDebtMissing: number;
  proofDebtLines: string[];
  topSourceLines: string[];
}

export interface OrchestratorViewModel {
  runId: string;
  sequence: number;
  summary: OrchestratorSummaryViewModel;
  rootNodeIds: string[];
  nodes: Record<string, OrchestratorNodeViewModel>;
  agents: OrchestratorAgentViewModel[];
  worktrees: OrchestratorWorktreeViewModel[];
  handoffs: OrchestratorHandoffViewModel[];
  merge: OrchestratorMergeViewModel;
  sourceLedger: OrchestratorSourceLedgerViewModel | null;
  selectedNodeId: string | null;
  compacted: {
    agents: number;
    handoffs: number;
    treeNodes: number;
    worktrees: number;
  };
}

const HIDDEN_REASONING_BLOCK = /<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi;
const HIDDEN_REASONING_LINE = /^\s*(?:chain[- ]of[- ]thought|hidden reasoning|internal reasoning|thought process)\s*:.*$/gim;
const MAX_OBSERVABLE_TEXT = 1_500;

export function buildOrchestratorViewModel(
  snapshot: OrchestratorSnapshotV1,
  options: {
    limits?: Partial<OrchestratorViewLimits>;
    now?: number;
  } = {},
): OrchestratorViewModel {
  const limits = normalizeLimits(options.limits);
  const rawSnapshot = asRecord(snapshot);
  const rawNodes = recordOfRecords(rawSnapshot.nodes);
  const rawParticipants = recordOfRecords(rawSnapshot.participants);
  const rawWorktrees = recordOfRecords(rawSnapshot.worktrees);
  const rawHandoffs = arrayOfRecords(rawSnapshot.handoffs);
  const rawMerge = asRecord(rawSnapshot.merge);

  const allNodeIds = Object.keys(rawNodes);
  const allParticipantIds = Object.keys(rawParticipants);
  const allWorktreeIds = Object.keys(rawWorktrees);
  const allEvidence = new Set<string>();

  for (const node of Object.values(rawNodes)) {
    for (const evidenceId of stringArray(node.evidenceIds)) {
      allEvidence.add(evidenceId);
    }
  }
  for (const handoff of rawHandoffs) {
    for (const evidenceId of stringArray(handoff.evidenceIds)) {
      allEvidence.add(evidenceId);
    }
  }

  const requestedRootIds = stringArray(rawSnapshot.rootNodeIds).filter(
    (id) => rawNodes[id] !== undefined,
  );
  const naturalRootIds = allNodeIds.filter((id) => {
    const parentId = nullableString(rawNodes[id]?.parentId);
    return !parentId || rawNodes[parentId] === undefined;
  });
  const rootCandidates = unique([...requestedRootIds, ...naturalRootIds]);
  const includedNodeIds = collectBoundedNodeIds(
    rawNodes,
    rootCandidates,
    limits.treeNodes,
  );
  const includedNodeSet = new Set(includedNodeIds);
  const participantsById = new Map(
    allParticipantIds.map((id) => [id, rawParticipants[id]] as const),
  );
  const nodes: Record<string, OrchestratorNodeViewModel> = {};

  for (const id of includedNodeIds) {
    const node = rawNodes[id] ?? {};
    const allChildIds = unique(stringArray(node.childIds)).filter(
      (childId) => rawNodes[childId] !== undefined && childId !== id,
    );
    const ownerId = nullableString(node.ownerId);
    nodes[id] = {
      id,
      parentId: includedNodeSet.has(nullableString(node.parentId) ?? "")
        ? nullableString(node.parentId)
        : null,
      childIds: allChildIds.filter((childId) => includedNodeSet.has(childId)),
      omittedChildCount: allChildIds.filter(
        (childId) => !includedNodeSet.has(childId),
      ).length,
      kind: safeToken(node.kind, "task"),
      title: safeObservableText(node.title, "Untitled task"),
      status: safeToken(node.status, "queued"),
      ownerId,
      ownerLabel: participantLabel(ownerId, participantsById),
      dependencyIds: stringArray(node.dependencyIds),
      evidenceIds: stringArray(node.evidenceIds).slice(0, limits.evidencePerNode),
      receiptIds: stringArray(node.receiptIds).slice(0, limits.evidencePerNode),
      artifactLabels: artifactLabels(node).slice(0, limits.artifactsPerNode),
      worktreeId: nullableString(node.worktreeId),
      proofContract: structuredSummary(node.proofContract),
      lastAction: observableAction(node.lastAction),
      resultSummary: safeObservableText(node.resultSummary),
      blocker: safeObservableText(node.blocker),
    };
  }

  const displayedRootIds = unique([
    ...rootCandidates.filter((id) => includedNodeSet.has(id)),
    ...includedNodeIds.filter((id) => nodes[id]?.parentId === null),
  ]);
  if (displayedRootIds.length === 0 && includedNodeIds[0]) {
    displayedRootIds.push(includedNodeIds[0]);
  }
  const agents = allParticipantIds
    .slice(0, limits.agents)
    .map((id) =>
      participantViewModel(id, rawParticipants[id] ?? {}, rawNodes),
    );
  const worktrees = allWorktreeIds
    .slice(0, limits.worktrees)
    .map((id) => worktreeViewModel(id, rawWorktrees[id] ?? {}, limits));
  const handoffs = rawHandoffs
    .slice(0, limits.handoffs)
    .map((handoff, index) => handoffViewModel(handoff, index, limits));

  const completeTasks = allNodeIds.filter(
    (id) => safeToken(rawNodes[id]?.status) === "complete",
  ).length;
  const selectedNodeId = selectDefaultNode(includedNodeIds, nodes);
  const summaryStatus = overallStatus(rawSnapshot, rawNodes);

  return {
    runId: safeObservableText(rawSnapshot.runId, "unknown-run"),
    sequence: finiteNumber(rawSnapshot.sequence) ?? 0,
    summary: {
      mode: modeLabel(safeToken(rawSnapshot.mode, "single")),
      status: summaryStatus,
      agentCount: allParticipantIds.length,
      completeTasks,
      totalTasks: allNodeIds.length,
      evidenceCount: allEvidence.size,
      worktreeCount: allWorktreeIds.length,
      elapsed: formatOrchestratorElapsed(snapshot, options.now),
      budget: aggregateBudget(Object.values(rawParticipants)),
    },
    rootNodeIds: displayedRootIds,
    nodes,
    agents,
    worktrees,
    handoffs,
    merge: mergeViewModel(rawMerge),
    sourceLedger: sourceLedgerViewModel(rawSnapshot.sourceLedgerSummary),
    selectedNodeId,
    compacted: {
      agents: Math.max(0, allParticipantIds.length - agents.length),
      handoffs: Math.max(0, rawHandoffs.length - handoffs.length),
      treeNodes: Math.max(0, allNodeIds.length - includedNodeIds.length),
      worktrees: Math.max(0, allWorktreeIds.length - worktrees.length),
    },
  };
}

/** Computes the live clock without rebuilding the complete display projection. */
export function formatOrchestratorElapsed(
  snapshot: OrchestratorSnapshotV1,
  now = Date.now(),
): string {
  const rawSnapshot = asRecord(snapshot);
  const rawNodes = recordOfRecords(rawSnapshot.nodes);
  const status = overallStatus(rawSnapshot, rawNodes);
  const startedAt =
    dateValue(rawSnapshot.startedAt) ?? dateValue(rawSnapshot.createdAt);
  if (startedAt === null) return "—";
  const endedAt = status === "running"
    ? now
    : dateValue(rawSnapshot.completedAt) ??
      dateValue(rawSnapshot.updatedAt) ??
      now;
  return formatDuration(Math.max(0, endedAt - startedAt));
}

function participantViewModel(
  id: string,
  participant: Record<string, unknown>,
  nodes: Record<string, Record<string, unknown>>,
): OrchestratorAgentViewModel {
  const currentNodeId =
    nullableString(participant.currentNodeId) ??
    nullableString(participant.assignmentId) ??
    nullableString(participant.taskId);
  const evidenceIds = unique([
    ...stringArray(participant.evidenceIds),
    ...stringArray(participant.sourceIds),
  ]);
  const currentNode = currentNodeId ? nodes[currentNodeId] : undefined;

  return {
    id,
    label:
      safeObservableText(participant.displayName) ||
      safeObservableText(participant.label) ||
      safeObservableText(participant.name) ||
      roleLabel(safeToken(participant.role, "agent")),
    role: roleLabel(safeToken(participant.role, "agent")),
    status: safeToken(participant.status ?? participant.state, "queued"),
    task:
      safeObservableText(participant.task) ||
      safeObservableText(participant.assignment) ||
      safeObservableText(participant.currentTask) ||
      safeObservableText(currentNode?.title) ||
      "Waiting for assignment",
    currentNodeId,
    budget: participantBudget(participant),
    lastAction: observableAction(participant.lastAction),
    handoffStatus: safeObservableText(participant.handoffStatus),
    evidenceCount: evidenceIds.length,
    resultSummary:
      safeObservableText(participant.resultSummary) ||
      safeObservableText(currentNode?.resultSummary),
    blocker:
      safeObservableText(participant.blocker) || safeObservableText(currentNode?.blocker),
  };
}

function worktreeViewModel(
  id: string,
  worktree: Record<string, unknown>,
  limits: OrchestratorViewLimits,
): OrchestratorWorktreeViewModel {
  return {
    id,
    taskId: safeObservableText(worktree.taskId),
    repositoryRoot: safeObservableText(worktree.repositoryRoot),
    path: safeObservableText(worktree.path),
    branch: safeObservableText(worktree.branch, "unassigned"),
    baseBranch: safeObservableText(worktree.baseBranch),
    baseSha: safeObservableText(worktree.baseSha),
    status: safeToken(worktree.status, "planned"),
    changedFiles: finiteNumber(worktree.changedFiles) ?? 0,
    changedFilePaths: stringArray(worktree.changedFilePaths).slice(
      0,
      limits.artifactsPerNode,
    ),
    validationCommands: stringArray(worktree.validationCommands)
      .map((command) => safeObservableText(command))
      .slice(0, limits.validationCommands),
    currentValidationCommand: safeObservableText(
      worktree.currentValidationCommand,
    ),
    validationPassed: worktree.validationPassed === true,
    commitSha: safeObservableText(worktree.commitSha),
    blocker: safeObservableText(worktree.blocker),
    cleanupState:
      safeObservableText(worktree.cleanupState) ||
      worktreeCleanupState(safeToken(worktree.status, "planned")),
  };
}

function worktreeCleanupState(status: string): string {
  switch (status) {
    case "merged":
      return "Merged; branch and worktree retained until approved cleanup.";
    case "promotion_blocked":
    case "retained":
    case "failed":
      return "Retained; explicit cleanup approval required.";
    default:
      return "Pending; automatic cleanup is disabled.";
  }
}

function handoffViewModel(
  handoff: Record<string, unknown>,
  index: number,
  limits: OrchestratorViewLimits,
): OrchestratorHandoffViewModel {
  return {
    id: safeObservableText(handoff.id, `handoff-${index + 1}`),
    taskId: safeObservableText(handoff.taskId),
    fromAgentId: safeObservableText(
      handoff.fromParticipantId ?? handoff.fromAgentId ?? handoff.from,
    ),
    toAgentId: safeObservableText(
      handoff.toParticipantId ?? handoff.toAgentId ?? handoff.to,
    ),
    status: safeToken(handoff.status, "ready"),
    summary: safeObservableText(handoff.summary),
    sourceIds: stringArray(handoff.sourceIds).slice(0, limits.evidencePerNode),
    evidenceIds: stringArray(handoff.evidenceIds).slice(0, limits.evidencePerNode),
    unresolvedQuestions: stringArray(handoff.unresolvedQuestions)
      .map((question) => safeObservableText(question))
      .slice(0, limits.unresolvedQuestions),
    confidence: safeToken(handoff.confidence),
    stopReason: safeObservableText(handoff.stopReason),
    commitSha: safeObservableText(handoff.commitSha),
  };
}

function mergeViewModel(merge: Record<string, unknown>): OrchestratorMergeViewModel {
  return {
    status: safeToken(merge.status, "pending"),
    received:
      finiteNumber(merge.received) ??
      finiteNumber(merge.evidenceReceived) ??
      0,
    accepted:
      finiteNumber(merge.accepted) ??
      finiteNumber(merge.acceptedEvidence) ??
      finiteNumber(merge.evidenceAccepted) ??
      finiteNumber(merge.acceptedCount) ??
      0,
    rejected:
      finiteNumber(merge.rejected) ??
      finiteNumber(merge.rejectedEvidence) ??
      finiteNumber(merge.evidenceRejected) ??
      finiteNumber(merge.rejectedCount) ??
      0,
    deduplicated:
      finiteNumber(merge.deduplicated) ??
      finiteNumber(merge.duplicates) ??
      finiteNumber(merge.evidenceDeduplicated) ??
      finiteNumber(merge.duplicateCount) ??
      0,
    conflicts:
      finiteNumber(merge.conflicts) ?? finiteNumber(merge.conflictCount) ?? 0,
    codeCommits:
      finiteNumber(merge.codeCommits) ??
      finiteNumber(merge.commitCount) ??
      stringArray(merge.commitShas).length,
    verification:
      safeObservableText(merge.verification) ||
      safeObservableText(merge.verificationStatus),
    integration: safeObservableText(merge.integrationStatus),
    blocker: safeObservableText(merge.blocker),
  };
}

function sourceLedgerViewModel(
  value: unknown,
): OrchestratorSourceLedgerViewModel | null {
  const record = asRecord(value);
  if (!record) return null;
  const candidateCount = finiteNumber(record.candidateCount) ?? 0;
  const usableCount = finiteNumber(record.usableCount) ?? 0;
  const unusableCount = finiteNumber(record.unusableCount) ?? 0;
  const rejectedCount = finiteNumber(record.rejectedCount) ?? 0;
  const proofDebtMissing = finiteNumber(record.proofDebtMissing) ?? 0;
  if (
    candidateCount === 0 &&
    usableCount === 0 &&
    proofDebtMissing === 0 &&
    !Array.isArray(record.proofDebtItems) &&
    !Array.isArray(record.topSources)
  ) {
    return null;
  }
  const proofDebtLines = arrayOfRecords(record.proofDebtItems)
    .slice(0, 4)
    .map((item) => {
      const description = safeObservableText(item.description) || "Proof debt";
      const missing = finiteNumber(item.missing) ?? 0;
      return `${description}: ${missing} missing`;
    });
  const topSourceLines = arrayOfRecords(record.topSources)
    .slice(0, 4)
    .map((item) => {
      const title = safeObservableText(item.title) || safeObservableText(item.id) || "source";
      const status = safeToken(item.status, "candidate");
      return `${title} (${status})`;
    });
  return {
    candidateCount,
    usableCount,
    unusableCount,
    rejectedCount,
    proofDebtMissing,
    proofDebtLines,
    topSourceLines,
  };
}

function collectBoundedNodeIds(
  rawNodes: Record<string, Record<string, unknown>>,
  rootCandidates: string[],
  maxNodes: number,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (result.length >= maxNodes || visited.has(id) || !rawNodes[id]) {
      return;
    }
    visited.add(id);
    result.push(id);
    for (const childId of stringArray(rawNodes[id]?.childIds)) {
      visit(childId);
      if (result.length >= maxNodes) {
        return;
      }
    }
  };

  for (const rootId of rootCandidates) {
    visit(rootId);
  }
  for (const nodeId of Object.keys(rawNodes)) {
    visit(nodeId);
  }
  return result;
}

function selectDefaultNode(
  nodeIds: string[],
  nodes: Record<string, OrchestratorNodeViewModel>,
): string | null {
  return (
    nodeIds.find((id) =>
      ["running", "blocked", "waiting"].includes(nodes[id]?.status ?? ""),
    ) ??
    nodeIds[0] ??
    null
  );
}

function overallStatus(
  snapshot: Record<string, unknown>,
  rawNodes: Record<string, Record<string, unknown>>,
): string {
  const explicit = safeToken(snapshot.status);
  if (explicit) {
    return explicit;
  }
  const statuses = Object.values(rawNodes).map((node) => safeToken(node.status));
  if (statuses.includes("blocked")) {
    return "blocked";
  }
  if (statuses.some((status) => ["running", "ready", "waiting"].includes(status))) {
    return "running";
  }
  if (statuses.length > 0 && statuses.every((status) => status === "complete")) {
    return "complete";
  }
  if (statuses.includes("cancelled")) {
    return "cancelled";
  }
  return "queued";
}

function aggregateBudget(participants: Record<string, unknown>[]): string {
  let modelUsed = 0;
  let modelLimit = 0;
  let toolUsed = 0;
  let toolLimit = 0;
  for (const participant of participants) {
    const counters = participantBudgetCounters(participant);
    modelUsed += counters.modelUsed;
    modelLimit += counters.modelLimit;
    toolUsed += counters.toolUsed;
    toolLimit += counters.toolLimit;
  }
  const parts: string[] = [];
  if (modelUsed > 0 || modelLimit > 0) {
    parts.push(`${modelUsed}/${modelLimit || "—"} steps`);
  }
  if (toolUsed > 0 || toolLimit > 0) {
    parts.push(`${toolUsed}/${toolLimit || "—"} tools`);
  }
  return parts.join(" · ") || "—";
}

function participantBudget(participant: Record<string, unknown>): string {
  const counters = participantBudgetCounters(participant);
  const parts: string[] = [];
  if (counters.modelUsed > 0 || counters.modelLimit > 0) {
    parts.push(`${counters.modelUsed}/${counters.modelLimit || "—"} steps`);
  }
  if (counters.toolUsed > 0 || counters.toolLimit > 0) {
    parts.push(`${counters.toolUsed}/${counters.toolLimit || "—"} tools`);
  }
  if (counters.wallUsed > 0 || counters.wallLimit > 0) {
    parts.push(
      `${formatDuration(counters.wallUsed)}/${
        counters.wallLimit ? formatDuration(counters.wallLimit) : "—"
      }`,
    );
  }
  return parts.join(" · ") || "—";
}

function participantBudgetCounters(participant: Record<string, unknown>): {
  modelUsed: number;
  modelLimit: number;
  toolUsed: number;
  toolLimit: number;
  wallUsed: number;
  wallLimit: number;
} {
  const budget = asRecord(participant.budget);
  const modelSteps = asRecord(budget.modelSteps);
  const toolCalls = asRecord(budget.toolCalls);
  const wallClockMs = asRecord(budget.wallClockMs);
  return {
    modelUsed:
      finiteNumber(modelSteps.used) ??
      finiteNumber(budget.modelStepsUsed) ??
      finiteNumber(participant.modelStepsUsed) ??
      finiteNumber(budget.used) ??
      finiteNumber(participant.budgetUsed) ??
      0,
    modelLimit:
      finiteNumber(modelSteps.limit) ??
      finiteNumber(budget.maxModelSteps) ??
      finiteNumber(participant.maxModelSteps) ??
      finiteNumber(budget.limit) ??
      finiteNumber(participant.budgetLimit) ??
      0,
    toolUsed:
      finiteNumber(toolCalls.used) ??
      finiteNumber(budget.toolCallsUsed) ??
      finiteNumber(participant.toolCallsUsed) ??
      0,
    toolLimit:
      finiteNumber(toolCalls.limit) ??
      finiteNumber(budget.maxToolCalls) ??
      finiteNumber(participant.maxToolCalls) ??
      0,
    wallUsed: finiteNumber(wallClockMs.used) ?? 0,
    wallLimit: finiteNumber(wallClockMs.limit) ?? 0,
  };
}

function artifactLabels(node: Record<string, unknown>): string[] {
  const labels = stringArray(node.artifactIds);
  for (const artifact of arrayOfRecords(node.artifacts)) {
    const label =
      safeObservableText(artifact.title) ||
      safeObservableText(artifact.path) ||
      safeObservableText(artifact.id);
    if (label) {
      labels.push(label);
    }
  }
  return unique(labels);
}

function observableAction(value: unknown): string {
  if (typeof value === "string") {
    return safeObservableText(value);
  }
  const action = asRecord(value);
  return (
    safeObservableText(action.label) ||
    safeObservableText(action.message) ||
    safeObservableText(action.name)
  );
}

function structuredSummary(value: unknown): string {
  if (typeof value === "string") {
    return safeObservableText(value);
  }
  const record = asRecord(value);
  const summary =
    safeObservableText(record.summary) || safeObservableText(record.description);
  const requirements = stringArray(record.requirements)
    .map((requirement) => safeObservableText(requirement))
    .filter(Boolean);
  const evidenceKinds = stringArray(record.requiredEvidenceKinds);
  const receiptKinds = stringArray(record.requiredReceiptKinds);
  const verifiers = stringArray(record.verifierIds);
  const minimum = finiteNumber(record.minEvidenceCount);
  return [
    summary,
    ...requirements,
    minimum === null ? "" : `${minimum} evidence minimum`,
    evidenceKinds.length > 0 ? `evidence: ${evidenceKinds.join(", ")}` : "",
    receiptKinds.length > 0 ? `receipts: ${receiptKinds.join(", ")}` : "",
    verifiers.length > 0 ? `verifiers: ${verifiers.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function participantLabel(
  ownerId: string | null,
  participants: Map<string, Record<string, unknown>>,
): string {
  if (!ownerId) {
    return "Unassigned";
  }
  const participant = participants.get(ownerId);
  if (!participant) {
    return ownerId;
  }
  return (
    safeObservableText(participant.displayName) ||
    safeObservableText(participant.label) ||
    safeObservableText(participant.name) ||
    roleLabel(safeToken(participant.role, "agent"))
  );
}

function normalizeLimits(
  partial: Partial<OrchestratorViewLimits> | undefined,
): OrchestratorViewLimits {
  const normalized: OrchestratorViewLimits = {
    ...DEFAULT_ORCHESTRATOR_VIEW_LIMITS,
  };
  for (const key of Object.keys(normalized) as (keyof OrchestratorViewLimits)[]) {
    const candidate = partial?.[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      normalized[key] = Math.max(1, Math.floor(candidate));
    }
  }
  return normalized;
}

function modeLabel(mode: string): string {
  switch (mode) {
    case "research_team":
      return "Research team";
    case "code_team":
      return "Code team";
    default:
      return "Single agent";
  }
}

function roleLabel(role: string): string {
  return role
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function safeObservableText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const sanitized = value
    .replace(HIDDEN_REASONING_BLOCK, "[hidden reasoning omitted]")
    .replace(HIDDEN_REASONING_LINE, "[hidden reasoning omitted]:")
    .trim();
  if (!sanitized) {
    return fallback;
  }
  return sanitized.length > MAX_OBSERVABLE_TEXT
    ? `${sanitized.slice(0, MAX_OBSERVABLE_TEXT - 1)}…`
    : sanitized;
}

function safeToken(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return normalized || fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => safeObservableText(item))
        .filter(Boolean)
    : [];
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .filter((item) => item !== null && typeof item === "object")
        .map((item) => asRecord(item))
    : [];
}

function recordOfRecords(
  value: unknown,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (item !== null && typeof item === "object") {
      result[key] = asRecord(item);
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
