import type {
  AgentRunCompleteEvent,
  AgentRunConfigEvent,
  AgentRunEvents,
  ModelCallEvidenceV1,
  ModelUsageAggregateV1,
  MissionEvidenceAttestationV1,
  AgentRunReceipt,
  AgentRunStopReason,
} from "../AgentRunner";
import type { MissionGraphV3 } from "../../packages/headless-runtime/src/missionGraphV3";
import type { MissionLedgerSummary } from "./missionLedger";
import {
  mergeMissionScorecardObservationsV1,
  type MissionScorecardV1,
} from "./missionScorecard";
import type { MissionGraphStoreReferenceV1 } from "./runStore";
import {
  createRunSteeringQueue,
  drainSteeringDirectives,
  enqueueSteeringDirective,
  type RunSteeringQueueV1,
  type SteeringDirectiveV1,
  type SteeringEnqueueResult,
} from "./runSteering";

const MAX_BUFFERED_RUN_EVENTS = 800;
const MAX_BUFFERED_RUN_EVENT_CHARS = 2_000_000;
const MAX_RETAINED_RUN_RECEIPTS = 256;
let providerUsageScopeSequence = 0;

export type RunCoordinatorState = "idle" | "running" | "stopping";

export interface RunOutcome {
  runId: string | null;
  stopReason: AgentRunStopReason;
  step: number;
  maxSteps: number;
}

export interface RunCoordinatorSnapshot {
  isRunning: boolean;
  state: RunCoordinatorState;
  runId: string | null;
  bufferedEventCount: number;
  bufferedEventChars: number;
  droppedEventCount: number;
  eventSequence: number;
  startedAtMs: number | null;
  lastActivityAtMs: number | null;
  lastConfig: AgentRunConfigEvent | null;
  modelCallEvidence: ModelCallEvidenceV1[];
  missionEvidence: MissionEvidenceAttestationV1[];
  lastMissionScorecard: MissionScorecardV1 | null;
  diagnosticAttestations: RunDiagnosticAttestationV1[];
  /** Stable identity for one coordinator start, including all delegated model workers. */
  providerUsageScopeId: string | null;
  providerUsage: ModelUsageAggregateV1;
  lastMissionGraph: MissionGraphV3 | null;
  /**
   * Durable ledger projection restored from the latest integrity-checked
   * runtime snapshot. This is display/resume state only; the Agent Runs files
   * remain authoritative.
   */
  lastMissionLedger: MissionLedgerSummary | null;
  persistedProjection: PersistedMissionRunProjectionMetadata | null;
  lastReceipts: AgentRunReceipt[];
  lastComplete: AgentRunCompleteEvent | null;
}

export interface RunDiagnosticAttestationV1 {
  schemaVersion: 1;
  id: string;
  kind: string;
  step?: number;
  toolName?: string;
  message: string;
  errorCode?: string;
  missing: string[];
}

export interface PersistedMissionRunProjectionMetadata {
  runtimeSnapshotPath: string;
  missionLedgerPath: string;
  graphStorePath: string;
  graphReference: MissionGraphStoreReferenceV1;
}

export interface PersistedMissionRunProjection
  extends PersistedMissionRunProjectionMetadata {
  runId: string;
  missionLedger: MissionLedgerSummary;
  missionGraph: MissionGraphV3;
}

export class RunAlreadyActiveError extends Error {
  constructor() {
    super("An agent mission is already running.");
    this.name = "RunAlreadyActiveError";
  }
}

type RunExecutor = (
  abortSignal: AbortSignal,
  events: AgentRunEvents,
) => Promise<void>;

export interface RunCoordinatorStartOptions {
  /** Receives only events from the run accepted by this start call. */
  eventTap?: AgentRunEvents;
  /**
   * Exact durable continuations retain the prior ledger/graph until the child
   * publishes a ledger-bearing config or a canonical graph update.
   */
  preserveExistingProjectionUntilLedger?: boolean;
}

type BufferedRunEvent = {
  sequence: number;
  estimatedChars: number;
  key: keyof AgentRunEvents;
  args: unknown[];
};

export interface RunCoordinatorOptions {
  /**
   * Host-owned tap fired for every model-call evidence record the coordinator
   * accepts. Session-scoped observers (e.g. the latency tracker) live on the
   * plugin, not in per-run state, so they survive across runs.
   */
  observeModelCallEvidence?: (evidence: ModelCallEvidenceV1) => void;
}

export class RunCoordinator {
  constructor(private readonly options: RunCoordinatorOptions = {}) {}

  private readonly listeners = new Set<AgentRunEvents>();
  private readonly bufferedEvents: BufferedRunEvent[] = [];
  private activePromise: Promise<RunOutcome> | null = null;
  private activeController: AbortController | null = null;
  private steeringQueue: RunSteeringQueueV1 = createRunSteeringQueue();
  private activeEventTap: AgentRunEvents | null = null;
  private state: RunCoordinatorState = "idle";
  private runId: string | null = null;
  private lastConfig: AgentRunConfigEvent | null = null;
  private readonly modelCallEvidence: ModelCallEvidenceV1[] = [];
  private readonly missionEvidence: MissionEvidenceAttestationV1[] = [];
  private lastMissionScorecard: MissionScorecardV1 | null = null;
  private readonly diagnosticAttestations: RunDiagnosticAttestationV1[] = [];
  private providerUsageScopeId: string | null = null;
  private providerUsage: ModelUsageAggregateV1 = emptyProviderUsage();
  private lastMissionGraph: MissionGraphV3 | null = null;
  private lastMissionLedger: MissionLedgerSummary | null = null;
  private persistedProjection: PersistedMissionRunProjectionMetadata | null = null;
  private readonly lastReceipts: AgentRunReceipt[] = [];
  private lastComplete: AgentRunCompleteEvent | null = null;
  private bufferedEventChars = 0;
  private droppedEventCount = 0;
  private eventSequence = 0;
  private startedAtMs: number | null = null;
  private lastActivityAtMs: number | null = null;
  private activeProviderUsageScopeId: string | null = null;
  private activeRunPublishedAuthority = false;
  private activeRunStartedFromPersistedProjection = false;
  private activeRunRequiresDurableResumeAuthority = false;
  private activeRunAdoptedLedgerConfig = false;

  isRunning(): boolean {
    return this.activePromise !== null;
  }

  getSnapshot(): RunCoordinatorSnapshot {
    return {
      isRunning: this.isRunning(),
      state: this.state,
      runId: this.runId,
      bufferedEventCount: this.bufferedEvents.length,
      bufferedEventChars: this.bufferedEventChars,
      droppedEventCount: this.droppedEventCount,
      eventSequence: this.eventSequence,
      startedAtMs: this.startedAtMs,
      lastActivityAtMs: this.lastActivityAtMs,
      lastConfig: this.lastConfig ? { ...this.lastConfig } : null,
      modelCallEvidence: this.modelCallEvidence.map((item) => ({ ...item })),
      missionEvidence: this.missionEvidence.map((item) => ({
        ...item,
        passageIds: [...item.passageIds],
      })),
      lastMissionScorecard: this.lastMissionScorecard
        ? structuredCloneValue(this.lastMissionScorecard)
        : null,
      diagnosticAttestations: this.diagnosticAttestations.map((item) => ({
        ...item,
        missing: [...item.missing],
      })),
      providerUsageScopeId: this.providerUsageScopeId,
      providerUsage: { ...this.providerUsage },
      lastMissionGraph: this.lastMissionGraph
        ? structuredCloneValue(this.lastMissionGraph)
        : null,
      lastMissionLedger: this.lastMissionLedger
        ? structuredCloneValue(this.lastMissionLedger)
        : null,
      persistedProjection: this.persistedProjection
        ? structuredCloneValue(this.persistedProjection)
        : null,
      lastReceipts: this.lastReceipts.map((receipt) => ({ ...receipt })),
      lastComplete: this.lastComplete ? { ...this.lastComplete } : null,
    };
  }

  /**
   * Adds a bounded host diagnostic directly to Run Details. This bypasses the
   * model event/history stream and is intended for failures in host-owned
   * finalizers that would otherwise collapse to a generic workflow blocker.
   */
  recordHostDiagnostic(input: {
    id: string;
    kind?: string;
    toolName?: string;
    message: string;
    errorCode: string;
  }): void {
    const attestation: RunDiagnosticAttestationV1 = {
      schemaVersion: 1,
      id: sanitizeTerminalDiagnostic(input.id, 160) || "host-diagnostic",
      kind: sanitizeTerminalDiagnostic(input.kind ?? "error", 40) || "error",
      ...(input.toolName
        ? { toolName: sanitizeTerminalDiagnostic(input.toolName, 120) }
        : {}),
      message: sanitizeTerminalDiagnostic(input.message, 500),
      errorCode:
        sanitizeTerminalDiagnostic(input.errorCode, 80) ||
        "host_finalizer_failed",
      missing: [],
    };
    if (
      this.diagnosticAttestations.some(
        (item) =>
          item.id === attestation.id &&
          item.message === attestation.message,
      )
    ) return;
    this.diagnosticAttestations.push(attestation);
    if (this.diagnosticAttestations.length > 128) {
      this.diagnosticAttestations.shift();
    }
  }

  subscribe(
    listener: AgentRunEvents,
    options: { replay?: boolean } = {},
  ): () => void {
    this.listeners.add(listener);
    if (options.replay === true) {
      for (const event of this.bufferedEvents) {
        dispatchRunEvent(listener, event);
      }
      if (
        this.lastMissionGraph &&
        !this.bufferedEvents.some(
          (event) => event.key === "onMissionGraphUpdate",
        )
      ) {
        listener.onMissionGraphUpdate?.(
          structuredCloneValue(this.lastMissionGraph),
        );
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(
    executor: RunExecutor,
    options: RunCoordinatorStartOptions = {},
  ): Promise<RunOutcome> {
    if (this.activePromise) {
      throw new RunAlreadyActiveError();
    }

    const preserveExistingProjection =
      options.preserveExistingProjectionUntilLedger === true &&
      this.lastMissionLedger !== null &&
      this.lastMissionGraph !== null;
    const preservedRunId = preserveExistingProjection
      ? this.lastMissionLedger?.runId ?? this.runId
      : null;

    this.bufferedEvents.splice(0, this.bufferedEvents.length);
    this.bufferedEventChars = 0;
    this.droppedEventCount = 0;
    this.eventSequence = 0;
    this.runId = preservedRunId;
    this.lastConfig = null;
    this.modelCallEvidence.splice(0, this.modelCallEvidence.length);
    this.missionEvidence.splice(0, this.missionEvidence.length);
    this.lastMissionScorecard = null;
    this.diagnosticAttestations.splice(0, this.diagnosticAttestations.length);
    this.providerUsageScopeId = createProviderUsageScopeId();
    this.activeProviderUsageScopeId = this.providerUsageScopeId;
    this.providerUsage = emptyProviderUsage();
    // Keep an integrity-checked restart projection visible until the accepted
    // executor publishes its own config or graph. A continuation can be
    // cancelled while its structured router is in flight; eagerly clearing
    // here would turn that recoverable stop into a blank, non-resumable view.
    this.activeRunPublishedAuthority = false;
    this.activeRunStartedFromPersistedProjection = preserveExistingProjection;
    this.activeRunRequiresDurableResumeAuthority =
      this.activeRunStartedFromPersistedProjection;
    this.activeRunAdoptedLedgerConfig = false;
    this.lastReceipts.splice(0, this.lastReceipts.length);
    this.lastComplete = null;
    this.activeController = new AbortController();
    // Steering never carries across runs: a directive narrows the mission the
    // user was watching, not the next one.
    this.steeringQueue = createRunSteeringQueue();
    this.state = "running";
    this.startedAtMs = Date.now();
    this.lastActivityAtMs = this.startedAtMs;
    const controller = this.activeController;
    this.activeEventTap = options.eventTap ?? null;
    const events = this.createEvents();

    let resolveOutcome!: (outcome: RunOutcome) => void;
    let rejectOutcome!: (error: unknown) => void;
    const promise = new Promise<RunOutcome>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    // Reserve the coordinator before invoking the executor. Event handlers can
    // synchronously re-enter start(), so assigning this afterward would leave a
    // brief second-run acceptance window.
    this.activePromise = promise;

    void (async () => {
      try {
        await executor(controller.signal, events);
        if (
          !this.activeRunPublishedAuthority &&
          (controller.signal.aborted || this.activeRunStartedFromPersistedProjection)
        ) {
          this.emit("onTrace", [
            buildPreAuthorityCompletionDiagnostic(controller.signal),
          ]);
        }
        const fallbackComplete = {
          step: 0,
          maxSteps: this.lastConfig?.maxStepsForRun ?? 0,
          stopReason: controller.signal.aborted
            ? "user_stopped" as const
            : "error" as const,
        } satisfies AgentRunCompleteEvent;
        if (!this.lastComplete) {
          // A runtime may finish setup/backoff cancellation without entering a
          // child runner that emits its own terminal event. Publish the same
          // fallback used for the returned outcome so detached/replaced views
          // cannot remain stuck in Running or Stopping.
          this.emit("onRunComplete", [fallbackComplete]);
        }
        const complete = this.lastComplete ?? fallbackComplete;
        resolveOutcome({
          runId: this.runId,
          stopReason: complete.stopReason,
          step: complete.step,
          maxSteps: complete.maxSteps,
        });
      } catch (error) {
        this.emit("onTrace", [buildTerminalErrorDiagnostic(error)]);
        if (!this.lastComplete) {
          this.emit("onRunComplete", [
            {
              step: 0,
              maxSteps: this.lastConfig?.maxStepsForRun ?? 0,
              stopReason: "error",
            } satisfies AgentRunCompleteEvent,
          ]);
        }
        rejectOutcome(error);
      } finally {
        if (this.activePromise === promise) {
          this.activeProviderUsageScopeId = null;
          this.activePromise = null;
          this.activeController = null;
          this.activeEventTap = null;
          this.state = "idle";
        }
      }
    })();
    return promise;
  }

  /**
   * Restores the restart-safe Run Details projection without pretending that a
   * mission is currently executing. The caller must first verify the runtime
   * snapshot's exact graph-store reference; this method never performs or
   * persists an authority transition.
   */
  hydratePersistedMission(projection: PersistedMissionRunProjection): boolean {
    if (this.activePromise) {
      return false;
    }
    this.runId = projection.runId;
    this.lastConfig = null;
    this.lastMissionGraph = structuredCloneValue(projection.missionGraph);
    this.lastMissionLedger = structuredCloneValue(projection.missionLedger);
    this.persistedProjection = structuredCloneValue({
      runtimeSnapshotPath: projection.runtimeSnapshotPath,
      missionLedgerPath: projection.missionLedgerPath,
      graphStorePath: projection.graphStorePath,
      graphReference: projection.graphReference,
    });
    this.lastReceipts.splice(0, this.lastReceipts.length);
    this.missionEvidence.splice(0, this.missionEvidence.length);
    this.lastMissionScorecard = null;
    this.diagnosticAttestations.splice(0, this.diagnosticAttestations.length);
    this.providerUsageScopeId = null;
    this.activeProviderUsageScopeId = null;
    this.providerUsage = emptyProviderUsage();
    this.lastComplete = null;
    this.state = "idle";
    this.startedAtMs = null;
    this.lastActivityAtMs = Date.now();
    return true;
  }

  /**
   * Queue a narrowing steering directive for the active run. Rejects anything
   * that would widen authority, so a directive can never reach a tool the host
   * did not already authorize. Returns the typed result so callers can surface
   * the exact rejection reason.
   */
  steerActiveRun(input: {
    kind: string;
    text: string;
    toolName?: string;
  }): SteeringEnqueueResult {
    if (this.state !== "running") {
      return {
        ok: false,
        code: "no_active_run",
        message: "There is no active run to steer.",
      };
    }
    const result = enqueueSteeringDirective(this.steeringQueue, {
      ...input,
      enqueuedAt: new Date().toISOString(),
    });
    if (result.ok) {
      this.steeringQueue = result.queue;
      this.lastActivityAtMs = Date.now();
    }
    return result;
  }

  /** Runner-facing port: drains pending directives at a step boundary. */
  getRunSteeringPort(): { drain(): SteeringDirectiveV1[] } {
    return {
      drain: () => {
        const { queue, drained } = drainSteeringDirectives(this.steeringQueue);
        this.steeringQueue = queue;
        return drained;
      },
    };
  }

  requestStop(reason = "user_requested"): boolean {
    if (!this.activeController || this.activeController.signal.aborted) {
      return false;
    }
    this.state = "stopping";
    this.lastActivityAtMs = Date.now();
    this.activeController.abort(reason);
    return true;
  }

  async shutdown(): Promise<void> {
    this.requestStop("coordinator_shutdown");
    if (!this.activePromise) {
      return;
    }
    try {
      await this.activePromise;
    } catch {
      // Shutdown is best-effort; the runner records the actionable error.
    }
  }

  private createEvents(): AgentRunEvents {
    const providerUsageScopeId = this.activeProviderUsageScopeId;
    return new Proxy({} as AgentRunEvents, {
      get: (_target, property) => {
        if (typeof property !== "string") {
          return undefined;
        }
        return (...args: unknown[]) => {
          if (
            providerUsageScopeId === null ||
            this.activeProviderUsageScopeId !== providerUsageScopeId
          ) {
            return;
          }
          this.emit(property as keyof AgentRunEvents, args);
        };
      },
    });
  }

  private emit(key: keyof AgentRunEvents, args: unknown[]): void {
    this.lastActivityAtMs = Date.now();
    if (key === "onRunConfig") {
      const config = args[0] as AgentRunConfigEvent | undefined;
      const configLedger = config?.missionLedger ?? null;
      const carriesLedger = configLedger !== null;
      // Adopt a config only together with its identity, and never let a
      // ledger-less config demote an established ledger identity: once this
      // run has adopted a ledger-bearing config, a continuation segment's
      // early config (config now, ledger later) must not null the ledger or
      // split the snapshot into two run identities mid-flight — the ledger
      // attestation rightly rejects both shapes.
      if (
        carriesLedger ||
        (!this.activeRunRequiresDurableResumeAuthority &&
          !this.activeRunAdoptedLedgerConfig)
      ) {
        this.lastConfig = config ? { ...config } : this.lastConfig;
        this.acceptActiveRunAuthority();
        this.runId = config?.runId ?? this.runId;
        if (configLedger !== null) {
          this.lastMissionLedger = structuredCloneValue(configLedger);
          this.activeRunAdoptedLedgerConfig = true;
        } else {
          this.lastMissionLedger = null;
        }
      }
    } else if (key === "onMissionGraphUpdate") {
      const graph = args[0] as MissionGraphV3 | undefined;
      if (graph) {
        this.acceptActiveRunAuthority();
        // The run config owns the durable Agent Runs ledger identity. A graph
        // may use a canonicalized mission id, so it can seed an otherwise
        // unknown coordinator but must never replace an established root run.
        this.runId = this.runId ?? graph.missionId ?? null;
        this.lastMissionGraph = structuredCloneValue(graph);
      }
    } else if (key === "onModelCallEvidence") {
      const evidence = args[0] as ModelCallEvidenceV1 | undefined;
      if (evidence) {
        this.options.observeModelCallEvidence?.(evidence);
        this.modelCallEvidence.push({ ...evidence });
        if (this.modelCallEvidence.length > 256) this.modelCallEvidence.shift();
        // A local observer-budget rejection and a client-returned quota error
        // can both use `budget_exhausted`; client invocation is the exact split.
        this.providerUsage.modelCallCount += evidence.clientInvoked ? 1 : 0;
        this.providerUsage.successfulCallCount += evidence.outcome === "success" ? 1 : 0;
        this.providerUsage.failedCallCount +=
          evidence.clientInvoked && evidence.outcome !== "success" ? 1 : 0;
        this.providerUsage.reportedTokens += evidence.tokenUsageReported
          ? evidence.totalTokens
          : 0;
        this.providerUsage.estimatedTokens += evidence.tokenUsageReported
          ? 0
          : Math.max(0, Math.ceil(evidence.responseChars / 4));
        this.providerUsage.retries += evidence.phase === "retry" ? 1 : 0;
        this.providerUsage.wallClockMs += evidence.durationMs;
      }
    } else if (key === "onMissionEvidence") {
      const evidence = args[0] as MissionEvidenceAttestationV1 | undefined;
      if (evidence) {
        const copied = { ...evidence, passageIds: [...evidence.passageIds] };
        const existingIndex = this.missionEvidence.findIndex(
          (item) => item.id === evidence.id,
        );
        if (existingIndex >= 0) {
          this.missionEvidence[existingIndex] = copied;
        } else {
          this.missionEvidence.push(copied);
        }
      }
    } else if (key === "onMissionScorecard") {
      const scorecard = args[0] as MissionScorecardV1 | undefined;
      if (scorecard) {
        this.lastMissionScorecard = mergeMissionScorecardObservationsV1(
          this.lastMissionScorecard,
          scorecard,
        );
      }
    } else if (key === "onTrace") {
      const trace = args[0] as
        | {
            id?: string;
            kind?: string;
            step?: number;
            toolName?: string;
            message?: string;
            error?: { code?: string };
            outputPreview?: unknown;
          }
        | undefined;
      const failedToolResult = Boolean(
        trace?.id &&
          trace.kind === "tool_result" &&
          trace.error?.code,
      );
      if (
        trace?.id &&
        (isAttestedDiagnosticTraceId(trace.id) || failedToolResult)
      ) {
        this.diagnosticAttestations.push({
          schemaVersion: 1,
          id: trace.id,
          kind: trace.kind ?? "status",
          ...(trace.step === undefined ? {} : { step: trace.step }),
          ...(trace.toolName ? { toolName: trace.toolName } : {}),
          message: failedToolResult
            ? sanitizeTerminalDiagnostic(trace.message ?? "", 500)
            : trace.message ?? "",
          ...(trace.error?.code
            ? { errorCode: sanitizeTerminalDiagnostic(trace.error.code, 80) }
            : {}),
          missing: extractDiagnosticMissing(trace.outputPreview),
        });
        if (this.diagnosticAttestations.length > 128) {
          this.diagnosticAttestations.shift();
        }
      }
    } else if (key === "onOrchestratorEvent") {
      const snapshot = args[1] as { runId?: string } | undefined;
      // Team/orchestrator snapshots may identify a child or canonical mission.
      // Preserve the root ledger id already published by onRunConfig.
      this.runId = this.runId ?? snapshot?.runId ?? null;
    } else if (key === "onReceipt") {
      const receipt = args[0] as AgentRunReceipt | undefined;
      if (
        receipt &&
        !this.lastReceipts.some((existing) =>
          sameRetainedReceiptIdentity(existing, receipt),
        )
      ) {
        this.lastReceipts.push({ ...receipt });
        if (this.lastReceipts.length > MAX_RETAINED_RUN_RECEIPTS) {
          this.lastReceipts.splice(
            0,
            this.lastReceipts.length - MAX_RETAINED_RUN_RECEIPTS,
          );
        }
      }
    } else if (key === "onRunComplete") {
      const reported = args[0] as AgentRunCompleteEvent;
      const complete =
        this.activeRunRequiresDurableResumeAuthority &&
        !this.activeRunPublishedAuthority &&
        !this.activeController?.signal.aborted
          ? {
              ...reported,
              // A routing child cannot clarify, fail, or finish an already
              // accepted durable mission before it publishes the exact ledger
              // or graph authority it is acting on. Keep the verified
              // continuation resumable and let loop/stall controls decide if a
              // repeated internal yield must eventually block.
              stopReason: "budget" as const,
            }
          : reported;
      args[0] = complete;
      this.lastComplete = { ...complete };
    }

    const event: BufferedRunEvent = {
      sequence: ++this.eventSequence,
      estimatedChars: estimateRunEventChars(args),
      key,
      args: [...args],
    };
    this.bufferedEvents.push(event);
    this.bufferedEventChars += event.estimatedChars;
    while (
      this.bufferedEvents.length > MAX_BUFFERED_RUN_EVENTS ||
      this.bufferedEventChars > MAX_BUFFERED_RUN_EVENT_CHARS
    ) {
      const removed = this.bufferedEvents.shift();
      if (!removed) {
        break;
      }
      this.bufferedEventChars = Math.max(
        0,
        this.bufferedEventChars - removed.estimatedChars,
      );
      this.droppedEventCount += 1;
    }
    const activeEventTap = this.activeEventTap;
    if (activeEventTap) {
      this.dispatchObserverSafely(activeEventTap, event);
    }
    for (const listener of this.listeners) {
      this.dispatchObserverSafely(listener, event);
    }
  }

  private dispatchObserverSafely(
    observer: AgentRunEvents,
    event: BufferedRunEvent,
  ): void {
    try {
      dispatchRunEvent(observer, event);
    } catch (error) {
      const id = `run-event-listener-error:${String(event.key)}`;
      const record = isRecord(error) ? error : null;
      const rawCode =
        typeof record?.code === "string"
          ? record.code
          : "run_event_listener_failed";
      const rawMessage =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : typeof error === "string"
            ? error
            : "Run event observer rejected.";
      const attestation: RunDiagnosticAttestationV1 = {
        schemaVersion: 1,
        id,
        kind: "error",
        message: sanitizeTerminalDiagnostic(rawMessage, 500),
        errorCode:
          sanitizeTerminalDiagnostic(rawCode, 80) ||
          "run_event_listener_failed",
        missing: [],
      };
      if (
        !this.diagnosticAttestations.some(
          (item) =>
            item.id === attestation.id &&
            item.message === attestation.message,
        )
      ) {
        this.diagnosticAttestations.push(attestation);
        if (this.diagnosticAttestations.length > 128) {
          this.diagnosticAttestations.shift();
        }
      }
    }
  }

  private acceptActiveRunAuthority(): void {
    if (this.activeRunPublishedAuthority) return;
    this.activeRunPublishedAuthority = true;
    this.activeRunRequiresDurableResumeAuthority = false;
    this.lastMissionGraph = null;
    this.lastMissionLedger = null;
    this.persistedProjection = null;
  }
}

function createProviderUsageScopeId(): string {
  providerUsageScopeSequence += 1;
  return [
    "provider-usage",
    Date.now().toString(36),
    providerUsageScopeSequence.toString(36),
  ].join("-");
}

function emptyProviderUsage(): ModelUsageAggregateV1 {
  return {
    schemaVersion: 1,
    modelCallCount: 0,
    successfulCallCount: 0,
    failedCallCount: 0,
    reportedTokens: 0,
    estimatedTokens: 0,
    retries: 0,
    wallClockMs: 0,
  };
}

function isAttestedDiagnosticTraceId(id: string): boolean {
  return (
    /^(?:agent-step-response-|loop-decision-|passage-writeback-contract-|verified-final-append-|pending-write-gate-|tool-call-budget-precheck-|mission-acceptance-|terminal-acceptance-gate-|committed-write-acceptance-invariant-|wall-clock-budget-|mission-graph-tool-frontier-|mission-graph-initialization-failed$|run-coordinator-terminal-error$|run-coordinator-pre-authority-completion$|checkpoint-resume:|mission-ledger-resume:invalid-handoff$|resume-mutation-reconciliation-required$|operation-goals:)/u.test(
      id,
    ) ||
    id.endsWith(":proof-gated-writeback-rejected") ||
    id.endsWith(":rejected") ||
    id.endsWith(":append_to_current_file:result") ||
    id.endsWith(":append_to_current_file:graph-rejected")
  );
}

function extractDiagnosticMissing(outputPreview: unknown): string[] {
  if (!isRecord(outputPreview)) return [];
  const direct = outputPreview.missing;
  if (Array.isArray(direct)) {
    return direct.filter((item): item is string => typeof item === "string");
  }
  const acceptance = outputPreview.acceptance;
  if (isRecord(acceptance) && Array.isArray(acceptance.missing)) {
    return acceptance.missing.filter(
      (item): item is string => typeof item === "string",
    );
  }
  return [];
}

function buildPreAuthorityCompletionDiagnostic(signal: AbortSignal): {
  id: string;
  kind: string;
  message: string;
  error: { code: string };
  outputPreview: { missing: string[] };
} {
  const reason = signal.aborted
    ? sanitizeTerminalDiagnostic(
        typeof signal.reason === "string"
          ? signal.reason
          : signal.reason instanceof Error
            ? signal.reason.message
            : "aborted",
        120,
      )
    : "executor_returned";
  return {
    id: "run-coordinator-pre-authority-completion",
    kind: "error",
    message: signal.aborted
      ? `Mission stopped before publishing run authority; reason=${reason || "aborted"}. The verified restart projection was retained.`
      : "Mission executor returned before publishing run authority. The verified restart projection was retained.",
    error: {
      code: signal.aborted
        ? "run_stopped_before_authority"
        : "run_returned_before_authority",
    },
    outputPreview: { missing: [] },
  };
}

function buildTerminalErrorDiagnostic(error: unknown): {
  id: string;
  kind: string;
  message: string;
  error: { code: string };
  outputPreview: { missing: string[] };
} {
  const record = isRecord(error) ? error : null;
  const rawCode = typeof record?.code === "string" ? record.code : "run_failed";
  const rawName =
    error instanceof Error && error.name.trim() ? error.name.trim() : "Error";
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "The mission runtime rejected before publishing a run configuration.";
  return {
    id: "run-coordinator-terminal-error",
    kind: "error",
    message: `${sanitizeTerminalDiagnostic(rawName, 80)}: ${sanitizeTerminalDiagnostic(rawMessage, 500)}`,
    error: { code: sanitizeTerminalDiagnostic(rawCode, 80) || "run_failed" },
    outputPreview: { missing: [] },
  };
}

function sanitizeTerminalDiagnostic(value: string, maxChars: number): string {
  return value
    .replace(
      /(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{48,})/giu,
      "[REDACTED]",
    )
    .replace(/\b[A-Za-z]:[\\/][^\r\n\t"']+/gu, "[LOCAL_PATH]")
    .replace(/\\\\[^\s"']+/gu, "[NETWORK_PATH]")
    .replace(/([?&](?:token|key|secret|code|state)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/[\r\n\t]+/gu, " ")
    .trim()
    .slice(0, maxChars);
}

function sameRetainedReceiptIdentity(
  left: AgentRunReceipt,
  right: AgentRunReceipt,
): boolean {
  if (left.id && right.id) {
    return left.id === right.id;
  }
  return (
    left.toolName === right.toolName &&
    left.operation === right.operation &&
    left.path === right.path &&
    left.toPath === right.toPath &&
    left.resource?.system === right.resource?.system &&
    left.resource?.id === right.resource?.id &&
    left.message === right.message
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredCloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function estimateRunEventChars(args: unknown[]): number {
  try {
    return Math.max(1, JSON.stringify(args).length);
  } catch {
    return 1_000;
  }
}

function dispatchRunEvent(
  listener: AgentRunEvents,
  event: BufferedRunEvent,
): void {
  const handler = listener[event.key] as
    | ((...args: unknown[]) => void)
    | undefined;
  handler?.(...event.args);
}
