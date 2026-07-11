import { OrchestratorStore, type OrchestratorSnapshotRepository } from "./orchestratorStore";
import { SharedBudget, type BudgetResource } from "./sharedBudget";
import type {
  AgentParticipant,
  MergeSummary,
  OrchestrationMode,
  OrchestratorEvent,
  OrchestratorSnapshotV1,
  OrchestratorWorkNode,
  WorkerHandoff,
  GitWorktreeState,
  VerificationStatus,
  WorkNodeStatus,
} from "./types";

type EventPayload<T> = T extends OrchestratorEvent
  ? Omit<T, "runId" | "sequence" | "occurredAt">
  : never;
export type OrchestratorEventPayload = EventPayload<OrchestratorEvent>;

export interface OrchestratorRuntimeOptions {
  runId: string;
  mode: OrchestrationMode;
  repository?: OrchestratorSnapshotRepository;
  onEvent?: (
    event: OrchestratorEvent,
    snapshot: OrchestratorSnapshotV1,
  ) => void | Promise<void>;
  now?: () => Date;
  rootModelSteps?: number;
  rootToolCalls?: number;
  rootWallClockMs?: number;
  finalizationReserveSteps?: number;
}

/**
 * Event-sourced parent lifecycle for one accepted coordinator run. The class
 * owns projection order, shared accounting, and cancellation-safe terminal
 * transitions; model workers never mutate the UI snapshot directly.
 */
export class OrchestratorRuntime {
  readonly runId: string;
  readonly mode: OrchestrationMode;
  readonly budget: SharedBudget;
  private readonly store: OrchestratorStore;
  private readonly onEvent?: OrchestratorRuntimeOptions["onEvent"];
  private readonly now: () => Date;
  private sequence = 0;

  constructor(options: OrchestratorRuntimeOptions) {
    this.runId = options.runId;
    this.mode = options.mode;
    this.store = new OrchestratorStore(options.repository);
    this.onEvent = options.onEvent;
    this.now = options.now ?? (() => new Date());
    this.budget = new SharedBudget({
      modelSteps: options.rootModelSteps ?? 100,
      toolCalls: options.rootToolCalls ?? 200,
      wallClockMs: options.rootWallClockMs ?? 30 * 60_000,
      finalizationReserveModelSteps: options.finalizationReserveSteps ?? 4,
    });
  }

  registerParticipantBudget(input: {
    participantId: string;
    modelSteps: number;
    toolCalls: number;
    wallClockMs: number;
    lead?: boolean;
  }): void {
    this.budget.registerParticipant(input.participantId, {
      limits: {
        modelSteps: input.modelSteps,
        toolCalls: input.toolCalls,
        wallClockMs: input.wallClockMs,
      },
      canUseFinalizationReserve: input.lead === true,
    });
  }

  async start(input: {
    participants: AgentParticipant[];
    nodes: OrchestratorWorkNode[];
  }): Promise<OrchestratorSnapshotV1> {
    return this.emit({
      kind: "orchestrator_started",
      mode: this.mode,
      participants: input.participants,
      rootNodes: input.nodes,
    });
  }

  async assign(nodeId: string, ownerId: string): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "node_assigned", nodeId, ownerId });
  }

  async progress(
    nodeId: string,
    input: {
      status?: WorkNodeStatus;
      lastAction?: string;
      evidenceIds?: string[];
      receiptIds?: string[];
      artifactIds?: string[];
      resultSummary?: string;
      blocker?: string;
    },
  ): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "node_progressed", nodeId, ...input });
  }

  async completeNode(
    nodeId: string,
    resultSummary?: string,
  ): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "node_completed", nodeId, resultSummary });
  }

  async blockNode(
    nodeId: string,
    blocker: string,
  ): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "node_blocked", nodeId, blocker });
  }

  async addEvidence(
    nodeId: string,
    evidenceId: string,
  ): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "evidence_added", nodeId, evidenceId });
  }

  async handoffReady(handoff: WorkerHandoff): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "handoff_ready", handoff });
  }

  async updateHandoff(
    handoffId: string,
    status: WorkerHandoff["status"],
    summary?: string,
  ): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "handoff_updated", handoffId, status, summary });
  }

  async mergeStarted(): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "merge_started" });
  }

  async mergeCompleted(summary: MergeSummary): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "merge_completed", summary });
  }

  async updateWorktree(
    worktree: GitWorktreeState,
  ): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "worktree_updated", worktree });
  }

  async updateVerification(
    status: VerificationStatus,
    blocker?: string,
  ): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "verification_updated", status, blocker });
  }

  async updateParticipant(
    participantId: string,
    patch: Partial<Omit<AgentParticipant, "id" | "role">>,
  ): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "participant_updated", participantId, patch });
  }

  async consume(
    participantId: string,
    resource: BudgetResource,
    amount: number,
    allowFinalizationReserve = false,
  ): Promise<boolean> {
    const result = this.budget.tryConsume({
      participantId,
      resource,
      amount,
      allowFinalizationReserve,
    });
    const participantBudget = this.budget.toParticipantBudget(participantId);
    if (participantBudget) {
      await this.updateParticipant(participantId, { budget: participantBudget });
    }
    return result.accepted;
  }

  async consumeOrThrow(
    participantId: string,
    resource: BudgetResource,
    amount: number,
    allowFinalizationReserve = false,
  ): Promise<void> {
    const result = this.budget.tryConsume({
      participantId,
      resource,
      amount,
      allowFinalizationReserve,
    });
    const participantBudget = this.budget.toParticipantBudget(participantId);
    if (participantBudget) {
      await this.updateParticipant(participantId, { budget: participantBudget });
    }
    if (!result.accepted) {
      throw new Error(
        `Orchestrator budget rejected ${participantId} ${resource} (${result.reason ?? "unknown"}).`,
      );
    }
  }

  async finish(
    status: "complete" | "blocked" | "cancelled" | "failed",
    summary?: string,
  ): Promise<OrchestratorSnapshotV1> {
    return this.emit({ kind: "run_completed", status, summary });
  }

  async setSourceLedgerSummary(
    summary: import("./types").SourceLedgerSummary,
  ): Promise<OrchestratorSnapshotV1> {
    const snapshot = await this.store.patch(this.runId, {
      sourceLedgerSummary: summary,
    });
    this.sequence = Math.max(this.sequence, snapshot.sequence);
    await this.onEvent?.(
      {
        kind: "merge_updated",
        runId: this.runId,
        sequence: snapshot.sequence,
        occurredAt: this.now().toISOString(),
        patch: {},
      },
      snapshot,
    );
    return snapshot;
  }

  getSnapshot(): OrchestratorSnapshotV1 | null {
    return this.store.get(this.runId);
  }

  private async emit(
    payload: OrchestratorEventPayload,
  ): Promise<OrchestratorSnapshotV1> {
    const event = {
      ...payload,
      runId: this.runId,
      sequence: ++this.sequence,
      occurredAt: this.now().toISOString(),
    } as OrchestratorEvent;
    const snapshot = await this.store.append(event);
    await this.onEvent?.(event, snapshot);
    return snapshot;
  }
}

export function createResearchTeamScaffold(input: {
  runId: string;
  mission: string;
  workerMaxSteps: number;
  workerMaxToolCalls: number;
  workerMaxMinutes: number;
  now?: Date;
}): { participants: AgentParticipant[]; nodes: OrchestratorWorkNode[] } {
  const now = (input.now ?? new Date()).toISOString();
  const workerMs = input.workerMaxMinutes * 60_000;
  const budget = (modelSteps: number, toolCalls: number, wallClockMs: number) => ({
    modelSteps: { used: 0, limit: modelSteps },
    toolCalls: { used: 0, limit: toolCalls },
    wallClockMs: { used: 0, limit: wallClockMs },
  });
  const participants: AgentParticipant[] = [
    {
      id: "lead",
      role: "lead",
      displayName: "Lead",
      status: "planning",
      currentNodeId: `${input.runId}:mission`,
      budget: budget(100, 200, 30 * 60_000),
      handoffStatus: "none",
      startedAt: now,
      updatedAt: now,
    },
    {
      id: "researcher",
      role: "researcher",
      displayName: "Researcher",
      status: "queued",
      currentNodeId: `${input.runId}:research`,
      budget: budget(input.workerMaxSteps, input.workerMaxToolCalls, workerMs),
      handoffStatus: "none",
      updatedAt: now,
    },
  ];
  const node = (
    id: string,
    parentId: string | null,
    childIds: string[],
    kind: OrchestratorWorkNode["kind"],
    title: string,
    status: WorkNodeStatus,
    ownerId: string,
    dependencyIds: string[] = [],
  ): OrchestratorWorkNode => ({
    id,
    parentId,
    childIds,
    kind,
    title,
    status,
    ownerId,
    dependencyIds,
    evidenceIds: [],
    receiptIds: [],
    artifactIds: [],
    createdAt: now,
    updatedAt: now,
  });
  const root = `${input.runId}:mission`;
  const research = `${input.runId}:research`;
  const handoff = `${input.runId}:handoff`;
  const lead = `${input.runId}:lead`;
  const verify = `${input.runId}:verify`;
  return {
    participants,
    nodes: [
      node(root, null, [research, handoff, lead, verify], "mission", input.mission, "running", "lead"),
      node(research, root, [], "research", "Independent source and vault research", "ready", "researcher"),
      node(handoff, root, [], "handoff", "Review structured evidence handoff", "queued", "lead", [research]),
      node(lead, root, [], "mission", "Synthesize and execute mission", "queued", "lead", [handoff]),
      node(verify, root, [], "verify", "Verify proof and final result", "queued", "lead", [lead]),
    ],
  };
}

export function shouldUseResearchTeam(
  prompt: string,
  previewEnabled: boolean,
  forceChatOnly = false,
): boolean {
  if (!previewEnabled || forceChatOnly) return false;
  // Require deep/sources/verify-style language — bare "research" alone is not enough.
  return /\b(deep\s+research|investigate|sources?|citations?|verify|fact[-\s]?check|evidence|compare\s+(?:sources?|evidence)|current\s+(?:events?|sources?)|latest\s+(?:sources?|research)|web\s+research|vault\s+research)\b/i.test(
    prompt,
  );
}

export function createCodeTeamScaffold(input: {
  runId: string;
  mission: string;
  workerMaxSteps: number;
  workerMaxToolCalls: number;
  workerMaxMinutes: number;
  now?: Date;
}): { participants: AgentParticipant[]; nodes: OrchestratorWorkNode[] } {
  const base = createResearchTeamScaffold(input);
  const now = (input.now ?? new Date()).toISOString();
  const root = `${input.runId}:mission`;
  const code = `${input.runId}:code`;
  const test = `${input.runId}:test`;
  const merge = `${input.runId}:merge`;
  const verify = `${input.runId}:verify`;
  const worker = base.participants[1];
  worker.id = "code_worker";
  worker.role = "code_worker";
  worker.displayName = "Code Worker";
  worker.currentNodeId = code;
  return {
    participants: base.participants,
    nodes: [
      {
        id: root,
        parentId: null,
        childIds: [code, test, merge, verify],
        kind: "mission",
        title: input.mission,
        status: "running",
        ownerId: "lead",
        dependencyIds: [],
        evidenceIds: [],
        receiptIds: [],
        artifactIds: [],
        createdAt: now,
        updatedAt: now,
      },
      codeNode(code, root, "Implement in isolated worktree", "code_worker", [], now, "code"),
      codeNode(test, root, "Run task validation", "lead", [code], now, "verify"),
      codeNode(merge, root, "Integrate green worker commit", "lead", [test], now, "merge"),
      codeNode(verify, root, "Run integration validation and promote safely", "lead", [merge], now, "verify"),
    ],
  };
}

function codeNode(
  id: string,
  parentId: string,
  title: string,
  ownerId: string,
  dependencyIds: string[],
  now: string,
  kind: OrchestratorWorkNode["kind"],
): OrchestratorWorkNode {
  return {
    id,
    parentId,
    childIds: [],
    kind,
    title,
    status: dependencyIds.length > 0 ? "queued" : "ready",
    ownerId,
    dependencyIds,
    evidenceIds: [],
    receiptIds: [],
    artifactIds: [],
    createdAt: now,
    updatedAt: now,
  };
}
