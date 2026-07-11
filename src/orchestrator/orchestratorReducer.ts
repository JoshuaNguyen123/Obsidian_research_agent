import {
  ORCHESTRATOR_SNAPSHOT_VERSION,
  type AgentParticipant,
  type AgentParticipantBudget,
  type GitWorktreeState,
  type MergeSummary,
  type OrchestrationMode,
  type OrchestratorEvent,
  type OrchestratorSnapshotV1,
  type OrchestratorWorkNode,
  type WorkerHandoff,
} from "./types";

export interface CreateOrchestratorSnapshotInput {
  runId: string;
  mode?: OrchestrationMode;
  sequence?: number;
  occurredAt?: string;
  participants?: AgentParticipant[];
  rootNodes?: OrchestratorWorkNode[];
}

export function createOrchestratorSnapshot({
  runId,
  mode = "single",
  sequence = 0,
  occurredAt = new Date().toISOString(),
  participants = [],
  rootNodes = [],
}: CreateOrchestratorSnapshotInput): OrchestratorSnapshotV1 {
  const normalizedParticipants =
    participants.length > 0
      ? participants
      : [createDefaultLeadParticipant(occurredAt)];
  const participantRecord = Object.fromEntries(
    normalizedParticipants.map((participant) => [
      participant.id,
      cloneParticipant(participant),
    ]),
  );
  const nodes = Object.fromEntries(
    rootNodes.map((node) => [node.id, cloneNode(node)]),
  );

  return {
    version: ORCHESTRATOR_SNAPSHOT_VERSION,
    runId,
    mode,
    status: "running",
    rootNodeIds: rootNodes
      .filter((node) => node.parentId === null)
      .map((node) => node.id),
    nodes,
    participants: participantRecord,
    worktrees: {},
    handoffs: [],
    merge: createEmptyMergeSummary(),
    sequence: Math.max(0, Math.trunc(sequence)),
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

export function createDefaultLeadParticipant(
  occurredAt = new Date().toISOString(),
): AgentParticipant {
  return {
    id: "lead",
    role: "lead",
    displayName: "Lead",
    status: "planning",
    currentNodeId: null,
    budget: createEmptyParticipantBudget(),
    handoffStatus: "none",
    startedAt: occurredAt,
    updatedAt: occurredAt,
  };
}

export function createEmptyParticipantBudget(): AgentParticipantBudget {
  return {
    modelSteps: { used: 0, limit: 0 },
    toolCalls: { used: 0, limit: 0 },
    wallClockMs: { used: 0, limit: 0 },
  };
}

export function createEmptyMergeSummary(): MergeSummary {
  return {
    status: "idle",
    evidenceReceived: 0,
    evidenceAccepted: 0,
    evidenceRejected: 0,
    evidenceDeduplicated: 0,
    conflicts: 0,
    commitShas: [],
    verificationStatus: "pending",
    integrationStatus: "not_applicable",
  };
}

/**
 * Pure and replay-safe projection of a single orchestrator event. Duplicate or
 * stale sequence numbers return the existing snapshot unchanged.
 */
export function reduceOrchestratorEvent(
  snapshot: OrchestratorSnapshotV1 | null,
  event: OrchestratorEvent,
): OrchestratorSnapshotV1 {
  if (!snapshot) {
    if (event.kind !== "orchestrator_started") {
      throw new Error("The first orchestrator event must be orchestrator_started.");
    }
    return createOrchestratorSnapshot({
      runId: event.runId,
      mode: event.mode,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      participants: event.participants,
      rootNodes: event.rootNodes,
    });
  }
  if (event.runId !== snapshot.runId) {
    throw new Error(
      `Cannot apply event for ${event.runId} to run ${snapshot.runId}.`,
    );
  }
  if (event.sequence <= snapshot.sequence) {
    return snapshot;
  }

  const next = cloneSnapshot(snapshot);
  next.sequence = event.sequence;
  next.updatedAt = event.occurredAt;

  switch (event.kind) {
    case "orchestrator_started": {
      next.mode = event.mode;
      for (const participant of event.participants ?? []) {
        next.participants[participant.id] = cloneParticipant(participant);
      }
      for (const node of event.rootNodes ?? []) {
        addNode(next, node);
      }
      return next;
    }
    case "participant_registered":
      next.participants[event.participant.id] = cloneParticipant(
        event.participant,
      );
      return next;
    case "participant_updated": {
      const current = next.participants[event.participantId];
      if (!current) return next;
      next.participants[event.participantId] = {
        ...current,
        ...event.patch,
        id: current.id,
        role: current.role,
        budget: event.patch.budget
          ? cloneBudget(event.patch.budget)
          : current.budget,
        updatedAt: event.occurredAt,
      };
      return next;
    }
    case "node_created":
      addNode(next, event.node);
      return next;
    case "node_assigned": {
      const node = next.nodes[event.nodeId];
      const participant = next.participants[event.ownerId];
      if (node) {
        next.nodes[event.nodeId] = {
          ...node,
          ownerId: participant ? event.ownerId : null,
          updatedAt: event.occurredAt,
        };
      }
      if (node && participant) {
        next.participants[event.ownerId] = {
          ...participant,
          currentNodeId: event.nodeId,
          updatedAt: event.occurredAt,
        };
      }
      return next;
    }
    case "node_progressed": {
      const node = next.nodes[event.nodeId];
      if (!node) return next;
      next.nodes[event.nodeId] = {
        ...node,
        ...(event.status ? { status: event.status } : {}),
        ...(event.lastAction !== undefined
          ? { lastAction: event.lastAction }
          : {}),
        evidenceIds: appendUnique(node.evidenceIds, event.evidenceIds ?? []),
        receiptIds: appendUnique(node.receiptIds, event.receiptIds ?? []),
        artifactIds: appendUnique(node.artifactIds, event.artifactIds ?? []),
        ...(event.resultSummary !== undefined
          ? { resultSummary: event.resultSummary }
          : {}),
        ...(event.blocker !== undefined ? { blocker: event.blocker } : {}),
        updatedAt: event.occurredAt,
      };
      return next;
    }
    case "node_completed":
      updateNode(next, event.nodeId, {
        status: "complete",
        blocker: undefined,
        ...(event.resultSummary !== undefined
          ? { resultSummary: event.resultSummary }
          : {}),
        updatedAt: event.occurredAt,
      });
      return next;
    case "node_blocked":
      updateNode(next, event.nodeId, {
        status: "blocked",
        blocker: event.blocker,
        updatedAt: event.occurredAt,
      });
      return next;
    case "node_cancelled":
      updateNode(next, event.nodeId, {
        status: "cancelled",
        ...(event.reason ? { blocker: event.reason } : {}),
        updatedAt: event.occurredAt,
      });
      return next;
    case "evidence_added": {
      const node = next.nodes[event.nodeId];
      if (node) {
        next.nodes[event.nodeId] = {
          ...node,
          evidenceIds: appendUnique(node.evidenceIds, [event.evidenceId]),
          updatedAt: event.occurredAt,
        };
      }
      return next;
    }
    case "worktree_updated": {
      const worktree = cloneWorktree(event.worktree);
      worktree.updatedAt = event.occurredAt;
      next.worktrees[worktree.id] = worktree;
      const node = next.nodes[worktree.taskId];
      if (node) {
        next.nodes[worktree.taskId] = {
          ...node,
          worktreeId: worktree.id,
          updatedAt: event.occurredAt,
        };
      }
      return next;
    }
    case "handoff_ready": {
      const handoff = cloneHandoff(event.handoff);
      const index = next.handoffs.findIndex((item) => item.id === handoff.id);
      if (index >= 0) next.handoffs[index] = handoff;
      else next.handoffs.push(handoff);
      updateParticipantHandoff(next, handoff.fromParticipantId, "ready", event.occurredAt);
      return next;
    }
    case "handoff_updated": {
      const handoff = next.handoffs.find((item) => item.id === event.handoffId);
      if (!handoff) return next;
      handoff.status = event.status;
      handoff.updatedAt = event.occurredAt;
      if (event.summary !== undefined) handoff.summary = event.summary;
      updateParticipantHandoff(
        next,
        handoff.fromParticipantId,
        event.status,
        event.occurredAt,
      );
      return next;
    }
    case "merge_started":
      next.merge = {
        ...next.merge,
        status: "running",
        updatedAt: event.occurredAt,
      };
      return next;
    case "merge_updated":
      next.merge = mergeSummary(next.merge, event.patch, event.occurredAt);
      return next;
    case "merge_completed":
      next.merge = {
        ...cloneMergeSummary(event.summary),
        status: event.summary.status,
        updatedAt: event.occurredAt,
      };
      return next;
    case "verification_updated":
      next.merge = {
        ...next.merge,
        verificationStatus: event.status,
        ...(event.blocker !== undefined ? { blocker: event.blocker } : {}),
        updatedAt: event.occurredAt,
      };
      return next;
    case "run_completed":
      next.status = event.status;
      if (event.summary) {
        for (const rootId of next.rootNodeIds) {
          updateNode(next, rootId, {
            resultSummary: event.summary,
            updatedAt: event.occurredAt,
          });
        }
      }
      return next;
  }
}

export function replayOrchestratorEvents(
  events: readonly OrchestratorEvent[],
  seed: OrchestratorSnapshotV1 | null = null,
): OrchestratorSnapshotV1 | null {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  let snapshot = seed;
  for (const event of ordered) {
    if (snapshot && event.runId !== snapshot.runId) continue;
    snapshot = reduceOrchestratorEvent(snapshot, event);
  }
  return snapshot;
}

function addNode(
  snapshot: OrchestratorSnapshotV1,
  source: OrchestratorWorkNode,
): void {
  const node = cloneNode(source);
  snapshot.nodes[node.id] = node;
  if (node.parentId === null) {
    snapshot.rootNodeIds = appendUnique(snapshot.rootNodeIds, [node.id]);
    return;
  }
  const parent = snapshot.nodes[node.parentId];
  if (parent) {
    snapshot.nodes[node.parentId] = {
      ...parent,
      childIds: appendUnique(parent.childIds, [node.id]),
      updatedAt: node.updatedAt ?? parent.updatedAt,
    };
  }
}

function updateNode(
  snapshot: OrchestratorSnapshotV1,
  nodeId: string,
  patch: Partial<OrchestratorWorkNode>,
): void {
  const current = snapshot.nodes[nodeId];
  if (!current) return;
  snapshot.nodes[nodeId] = { ...current, ...patch, id: current.id };
}

function updateParticipantHandoff(
  snapshot: OrchestratorSnapshotV1,
  participantId: string,
  status: AgentParticipant["handoffStatus"],
  occurredAt: string,
): void {
  const participant = snapshot.participants[participantId];
  if (!participant) return;
  snapshot.participants[participantId] = {
    ...participant,
    handoffStatus: status,
    updatedAt: occurredAt,
  };
}

function mergeSummary(
  current: MergeSummary,
  patch: Partial<MergeSummary>,
  occurredAt: string,
): MergeSummary {
  return {
    ...current,
    ...patch,
    commitShas: patch.commitShas
      ? appendUnique(current.commitShas, patch.commitShas)
      : current.commitShas,
    updatedAt: occurredAt,
  };
}

function appendUnique(current: string[], additions: readonly string[]): string[] {
  return [...new Set([...current, ...additions])];
}

function cloneSnapshot(snapshot: OrchestratorSnapshotV1): OrchestratorSnapshotV1 {
  return {
    ...snapshot,
    rootNodeIds: [...snapshot.rootNodeIds],
    nodes: Object.fromEntries(
      Object.entries(snapshot.nodes).map(([id, node]) => [id, cloneNode(node)]),
    ),
    participants: Object.fromEntries(
      Object.entries(snapshot.participants).map(([id, participant]) => [
        id,
        cloneParticipant(participant),
      ]),
    ),
    worktrees: Object.fromEntries(
      Object.entries(snapshot.worktrees).map(([id, worktree]) => [
        id,
        cloneWorktree(worktree),
      ]),
    ),
    handoffs: snapshot.handoffs.map(cloneHandoff),
    merge: cloneMergeSummary(snapshot.merge),
  };
}

function cloneParticipant(participant: AgentParticipant): AgentParticipant {
  return { ...participant, budget: cloneBudget(participant.budget) };
}

function cloneBudget(budget: AgentParticipantBudget): AgentParticipantBudget {
  return {
    modelSteps: { ...budget.modelSteps },
    toolCalls: { ...budget.toolCalls },
    wallClockMs: { ...budget.wallClockMs },
  };
}

function cloneNode(node: OrchestratorWorkNode): OrchestratorWorkNode {
  return {
    ...node,
    childIds: [...node.childIds],
    dependencyIds: [...node.dependencyIds],
    evidenceIds: [...node.evidenceIds],
    receiptIds: [...node.receiptIds],
    artifactIds: [...node.artifactIds],
    proofContract: node.proofContract
      ? {
          ...node.proofContract,
          requiredEvidenceKinds: [...node.proofContract.requiredEvidenceKinds],
          requiredReceiptKinds: [...node.proofContract.requiredReceiptKinds],
          verifierIds: [...node.proofContract.verifierIds],
        }
      : undefined,
  };
}

function cloneWorktree(worktree: GitWorktreeState): GitWorktreeState {
  return {
    ...worktree,
    changedFilePaths: worktree.changedFilePaths
      ? [...worktree.changedFilePaths]
      : undefined,
    validationCommands: [...worktree.validationCommands],
  };
}

function cloneHandoff(handoff: WorkerHandoff): WorkerHandoff {
  return {
    ...handoff,
    sourceIds: [...handoff.sourceIds],
    evidenceIds: [...handoff.evidenceIds],
    unresolvedQuestions: [...handoff.unresolvedQuestions],
  };
}

function cloneMergeSummary(summary: MergeSummary): MergeSummary {
  return { ...summary, commitShas: [...summary.commitShas] };
}
