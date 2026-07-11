import {
  canClaimDurableMissionLease,
  createDurableMissionLease,
  getDurableMissionBudgetExhaustionReason,
  hasDurableMissionDeadlineElapsed,
  isDurableMissionLeaseLive,
  isDurableMissionRetryDue,
  isDurableMissionRetryExhausted,
  normalizeDurableMissionManifest,
  renewDurableMissionLease,
  type DurableMissionManifestV1,
} from "./durableMission";
import {
  reduceDurableMissionTransition,
  type DurableMissionManifestRepository,
  type DurableMissionSupervisor,
  type DurableMissionSupervisorRunOptions,
  type DurableSegmentOutcome,
} from "./durableMissionSupervisor";
import {
  createNoopKeepAwakeController,
  type KeepAwakeController,
  type KeepAwakeLease,
} from "../platform/keepAwake";
import { formatFailureCopy, keepAwakeFailureCopy } from "./failureCopy";

export type DurableMissionBudgetStopReason =
  | "budget"
  | "step_budget"
  | "time_budget"
  | "wall_clock_budget"
  | "segment_budget";

export interface DurableMissionContinuation {
  recommended: boolean;
  stopReason: DurableMissionBudgetStopReason;
  reason?: string;
}

/**
 * A segment may request another bounded invocation only by reporting both
 * productive progress and a budget stop. This prevents a generic final/error
 * response from silently turning into an unbounded loop.
 */
export interface DurableMissionRuntimeSegmentOutcome
  extends DurableSegmentOutcome {
  continuation?: DurableMissionContinuation;
}

export interface DurableMissionRemainingBudget {
  segments: number;
  modelSteps: number;
  toolCalls: number;
  wallClockMs: number;
}

export interface DurableMissionRuntimeSegmentOptions {
  signal: AbortSignal;
  deadlineAt: string;
  remaining: DurableMissionRemainingBudget;
  /** Persist the child runner id before its first model or tool side effect. */
  checkpointSegment(segmentId: string): Promise<void>;
  /** Persist approval/WAL safety state while the child is still executing. */
  checkpointSafetyState(checkpoint: DurableMissionSafetyCheckpoint): Promise<void>;
}

export interface DurableMissionSafetyCheckpoint {
  approval?: { id: string; summary: string };
  clearApprovalId?: string;
  unsafeWal?: { operationIds?: string[]; message?: string };
}

export interface DurableMissionRuntimeSegmentExecutor {
  executeSegment(
    manifest: DurableMissionManifestV1,
    options: DurableMissionRuntimeSegmentOptions,
  ): Promise<DurableMissionRuntimeSegmentOutcome>;
}

export interface DurableMissionRuntimeTimer {
  now(): Date;
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
  setTimeout(
    handler: () => void | Promise<void>,
    delayMs: number,
  ): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(
    handler: () => void | Promise<void>,
    intervalMs: number,
  ): unknown;
  clearInterval(handle: unknown): void;
}

export type DurableMissionRuntimeEventKind =
  | "claimed"
  | "keep_awake"
  | "heartbeat"
  | "segment_started"
  | "segment_finished"
  | "backoff"
  | "cancelled"
  | "interrupted"
  | "terminal"
  | "warning";

export interface DurableMissionRuntimeEvent {
  kind: DurableMissionRuntimeEventKind;
  missionId: string;
  at: string;
  status: DurableMissionManifestV1["status"];
  message: string;
  decision?: string;
  segmentIndex?: number;
  nextAttemptAt?: string;
}

export interface DurableMissionRuntimeErrorClassification {
  transientFailure?: DurableSegmentOutcome["transientFailure"];
  safetyPause?: DurableSegmentOutcome["safetyPause"];
}

export interface LiveDurableMissionRuntimeOptions {
  repository: DurableMissionManifestRepository;
  executor: DurableMissionRuntimeSegmentExecutor;
  ownerId: string;
  keepAwakeController?: KeepAwakeController;
  timer?: DurableMissionRuntimeTimer;
  classifyError?: (
    error: unknown,
  ) => DurableMissionRuntimeErrorClassification;
  onEvent?: (event: DurableMissionRuntimeEvent) => void;
}

export interface LiveDurableMissionRunOptions
  extends DurableMissionSupervisorRunOptions {
  /** External aborts default to plugin/runtime interruption, never user cancel. */
  abortDisposition?: "cancelled" | "interrupted";
}

type RuntimeStopDisposition =
  | "cancelled"
  | "interrupted"
  | "deadline"
  | "persistence_failure";

interface RunningDurableMission {
  current: DurableMissionManifestV1;
  readonly controller: AbortController;
  writeTail: Promise<void>;
  promise: Promise<DurableMissionManifestV1>;
  stopDisposition?: RuntimeStopDisposition;
  persistenceFailure?: unknown;
  keepAwakeLease?: KeepAwakeLease;
  heartbeatHandle?: unknown;
  deadlineHandle?: unknown;
  externalAbortCleanup?: () => void;
  executionFinished: boolean;
}

export class DurableMissionLeaseConflictError extends Error {
  readonly code = "durable_mission_live_lease";

  constructor(
    readonly missionId: string,
    readonly ownerId: string,
  ) {
    super(
      [
        "What: Overnight mission is waiting on a live lease.",
        `Why: Durable mission ${missionId} is owned by live lease ${ownerId}.`,
        "Next: Leave Obsidian open; resume after the lease window, or use Resume Latest Overnight Research once the wait ends.",
      ].join(" "),
    );
    this.name = "DurableMissionLeaseConflictError";
  }
}

export class DurableMissionTransientError extends Error {
  constructor(
    message: string,
    readonly code = "transient_provider_error",
  ) {
    super(message);
    this.name = "DurableMissionTransientError";
  }
}

/**
 * Live orchestration around the existing bounded AgentRunner-style segment.
 * The durable runtime owns only lifecycle, checkpoints, leases and retry. The
 * injected executor remains responsible for one finite model/tool segment.
 */
export class LiveDurableMissionRuntime implements DurableMissionSupervisor {
  private readonly repository: DurableMissionManifestRepository;
  private readonly executor: DurableMissionRuntimeSegmentExecutor;
  private readonly ownerId: string;
  private readonly keepAwakeController: KeepAwakeController;
  private readonly timer: DurableMissionRuntimeTimer;
  private readonly classifyError: (
    error: unknown,
  ) => DurableMissionRuntimeErrorClassification;
  private readonly onEvent?: (event: DurableMissionRuntimeEvent) => void;
  private readonly running = new Map<string, RunningDurableMission>();

  constructor(options: LiveDurableMissionRuntimeOptions) {
    this.repository = options.repository;
    this.executor = options.executor;
    this.ownerId = requireNonEmptyString(options.ownerId, "ownerId");
    this.keepAwakeController =
      options.keepAwakeController ?? createNoopKeepAwakeController();
    this.timer = options.timer ?? createDefaultDurableMissionRuntimeTimer();
    this.classifyError = options.classifyError ?? classifyRuntimeError;
    this.onEvent = options.onEvent;
  }

  run(
    manifest: DurableMissionManifestV1,
    options: LiveDurableMissionRunOptions = {},
  ): Promise<DurableMissionManifestV1> {
    const normalized = cloneManifest(manifest);
    const existing = this.running.get(normalized.missionId);
    if (existing) {
      return existing.promise;
    }

    const state: RunningDurableMission = {
      current: normalized,
      controller: new AbortController(),
      writeTail: Promise.resolve(),
      promise: Promise.resolve(normalized),
      executionFinished: false,
    };
    this.attachExternalAbort(state, options);
    state.promise = this.runState(state)
      .then(() => state.current)
      .finally(() => {
        state.externalAbortCleanup?.();
        if (this.running.get(normalized.missionId) === state) {
          this.running.delete(normalized.missionId);
        }
      });
    this.running.set(normalized.missionId, state);
    return state.promise;
  }

  async resume(
    missionId: string,
    options: LiveDurableMissionRunOptions = {},
  ): Promise<DurableMissionManifestV1 | null> {
    const loaded = await this.repository.load(
      requireNonEmptyString(missionId, "missionId"),
    );
    return loaded ? this.run(loaded, options) : null;
  }

  async recoverLatest(
    options: LiveDurableMissionRunOptions = {},
  ): Promise<DurableMissionManifestV1 | null> {
    const recoverable = await this.repository.listRecoverable(this.now());
    return recoverable[0] ? this.run(recoverable[0], options) : null;
  }

  async stop(missionId: string): Promise<void> {
    await this.cancel(missionId);
  }

  async cancel(missionId: string): Promise<DurableMissionManifestV1 | null> {
    return this.requestStop(missionId, "cancelled");
  }

  async interrupt(
    missionId: string,
  ): Promise<DurableMissionManifestV1 | null> {
    return this.requestStop(missionId, "interrupted");
  }

  async interruptAll(): Promise<DurableMissionManifestV1[]> {
    const results = await Promise.all(
      [...this.running.keys()].map((missionId) => this.interrupt(missionId)),
    );
    return results.filter(
      (manifest): manifest is DurableMissionManifestV1 => Boolean(manifest),
    );
  }

  isRunning(missionId: string): boolean {
    return this.running.has(missionId.trim());
  }

  private async runState(
    state: RunningDurableMission,
  ): Promise<DurableMissionManifestV1> {
    try {
      const persisted = await this.repository.load(state.current.missionId);
      if (persisted) {
        state.current = cloneManifest(persisted);
      } else {
        state.current = cloneManifest(
          await this.repository.save(
            cloneManifest(state.current),
            state.current.revision,
          ),
        );
      }

      if (!(await this.prepareForExecution(state))) {
        return state.current;
      }

      await this.acquireKeepAwake(state);
      this.armDeadline(state);
      this.startHeartbeat(state);

      while (!state.executionFinished) {
        if (state.controller.signal.aborted) {
          await this.persistAbortDisposition(state);
          break;
        }
        if (hasDurableMissionDeadlineElapsed(state.current, this.now())) {
          state.stopDisposition = "deadline";
          await this.persistAbortDisposition(state);
          break;
        }

        if (state.current.status === "backing_off") {
          const canContinue = await this.waitForBackoff(state);
          if (!canContinue) {
            break;
          }
        }

        try {
          await this.persistBeforeSegment(state);
        } catch (error) {
          if (
            isAbortError(error) &&
            hasDurableMissionDeadlineElapsed(state.current, this.now())
          ) {
            state.stopDisposition = "deadline";
            await this.persistAbortDisposition(state);
            break;
          }
          throw error;
        }
        const segmentNumber = state.current.usage.segments + 1;
        this.emit(state, {
          kind: "segment_started",
          message: `Starting bounded segment ${segmentNumber}.`,
          segmentIndex: segmentNumber,
        });

        let outcome: DurableMissionRuntimeSegmentOutcome;
        try {
          outcome = await this.executor.executeSegment(
            cloneManifest(state.current),
            {
              signal: state.controller.signal,
              deadlineAt: state.current.deadlineAt,
              remaining: getRemainingBudget(state.current, this.now()),
              checkpointSegment: (segmentId) =>
                this.checkpointSegment(state, segmentId),
              checkpointSafetyState: (checkpoint) =>
                this.checkpointSafetyState(state, checkpoint),
            },
          );
        } catch (error) {
          if (state.controller.signal.aborted) {
            await this.persistAbortDisposition(state);
            break;
          }
          outcome = {
            ...this.classifyError(error),
            productive: false,
          };
        }

        if (state.controller.signal.aborted) {
          await this.persistAbortDisposition(state);
          break;
        }

        await state.writeTail;
        const reduced = reduceDurableMissionTransition(
          state.current,
          restrictContinuation(outcome),
          this.now(),
        );
        if (
          reduced.decision.type !== "continue" &&
          reduced.decision.type !== "transient_backoff"
        ) {
          state.executionFinished = true;
        }
        await this.persistReplacement(state, reduced.manifest);
        this.emit(state, {
          kind: "segment_finished",
          message: reduced.decision.reason,
          decision: reduced.decision.type,
          segmentIndex: state.current.usage.segments,
          nextAttemptAt: reduced.decision.nextAttemptAt,
        });

        if (reduced.decision.type === "continue") {
          continue;
        }
        if (reduced.decision.type === "transient_backoff") {
          await this.claimLease(state, true, false);
          this.emit(state, {
            kind: "backoff",
            message: reduced.decision.reason,
            decision: reduced.decision.type,
            nextAttemptAt: reduced.decision.nextAttemptAt,
          });
          continue;
        }
        break;
      }

      return state.current;
    } finally {
      state.executionFinished = true;
      this.disarmTimers(state);
      await state.writeTail;
      await this.releaseKeepAwake(state);
    }
  }

  private async prepareForExecution(
    state: RunningDurableMission,
  ): Promise<boolean> {
    const now = this.now();
    if (hasDurableMissionDeadlineElapsed(state.current, now)) {
      await this.persistTerminalState(state, "expired", {
        code: "deadline_reached",
        message: "The durable mission reached its absolute deadline.",
      });
      return false;
    }

    const budgetReason = getDurableMissionBudgetExhaustionReason(state.current);
    if (budgetReason) {
      await this.persistTerminalState(state, "blocked", {
        code: budgetReason,
        message: `The durable mission cannot resume because ${budgetReason.replace(/_/g, " ")}.`,
      });
      return false;
    }

    if (
      state.current.status === "complete" ||
      state.current.status === "cancelled" ||
      state.current.status === "expired" ||
      state.current.status === "blocked" ||
      state.current.status === "paused_for_approval" ||
      state.current.pendingApproval ||
      state.current.reconciliation.status !== "clean"
    ) {
      return false;
    }

    if (isDurableMissionRetryExhausted(state.current.retry, state.current.policy)) {
      await this.persistTerminalState(state, "blocked", {
        code: "transient_failure_limit",
        message: "The durable mission exhausted its transient retry budget.",
      });
      return false;
    }

    if (
      isDurableMissionLeaseLive(state.current.lease, now) &&
      !canClaimDurableMissionLease(state.current, this.ownerId, now)
    ) {
      throw new DurableMissionLeaseConflictError(
        state.current.missionId,
        state.current.lease?.ownerId ?? "unknown",
      );
    }

    const retryStillPending =
      state.current.retry.consecutiveFailures > 0 &&
      !isDurableMissionRetryDue(state.current.retry, now);
    await this.claimLease(
      state,
      state.current.status === "backing_off" || retryStillPending,
      true,
    );
    return true;
  }

  private async claimLease(
    state: RunningDurableMission,
    preserveBackoff: boolean,
    resetStaleKeepAwakeState: boolean,
  ): Promise<void> {
    await this.persistMutation(state, (next, now) => {
      if (!canClaimDurableMissionLease(next, this.ownerId, now)) {
        throw new DurableMissionLeaseConflictError(
          next.missionId,
          next.lease?.ownerId ?? "unknown",
        );
      }
      next.lease =
        next.lease?.ownerId === this.ownerId &&
        isDurableMissionLeaseLive(next.lease, now)
          ? renewDurableMissionLease(
              next.lease,
              now,
              next.policy.leaseDurationMs,
            )
          : createDurableMissionLease({
              ownerId: this.ownerId,
              now,
              durationMs: next.policy.leaseDurationMs,
            });
      next.status = preserveBackoff ? "backing_off" : "running";
      next.lastActivityAt = now.toISOString();
      next.blocker = undefined;
      if (resetStaleKeepAwakeState) {
        next.keepAwake.active = false;
      }
    });
    this.emit(state, {
      kind: "claimed",
      message: `Lease claimed by ${this.ownerId}.`,
    });
  }

  private async acquireKeepAwake(state: RunningDurableMission): Promise<void> {
    if (!state.current.keepAwake.requested) {
      return;
    }

    try {
      const lease = await this.keepAwakeController.acquire({
        missionId: state.current.missionId,
      });
      state.keepAwakeLease = lease;
      await this.persistMutation(state, (next, now) => {
        next.keepAwake = {
          requested: true,
          active: lease.acquired,
          warning: lease.warning
            ? formatFailureCopy(keepAwakeFailureCopy(lease.warning))
            : lease.warning,
        };
        next.lastActivityAt = now.toISOString();
      });
      this.emit(state, {
        kind: lease.acquired ? "keep_awake" : "warning",
        message: lease.acquired
          ? (lease.warning ??
            "Native application-suspension protection is active.")
          : formatFailureCopy(
              keepAwakeFailureCopy(
                lease.warning ??
                  "Keep-awake is unavailable; application suspension is not prevented.",
              ),
            ),
      });
    } catch (error) {
      const warning = `Keep-awake acquisition failed: ${getErrorMessage(error)}`;
      const copy = formatFailureCopy(keepAwakeFailureCopy(warning));
      await this.persistMutation(state, (next) => {
        next.keepAwake = {
          requested: true,
          active: false,
          warning: copy,
        };
      });
      this.emit(state, {
        kind: "warning",
        message: copy,
      });
    }
  }

  private async releaseKeepAwake(state: RunningDurableMission): Promise<void> {
    const lease = state.keepAwakeLease;
    let releaseWarning: string | undefined;
    if (lease && !lease.released) {
      try {
        await lease.release();
      } catch (error) {
        releaseWarning = formatFailureCopy(
          keepAwakeFailureCopy(
            `Keep-awake release failed: ${getErrorMessage(error)}`,
          ),
        );
        this.emit(state, { kind: "warning", message: releaseWarning });
      }
    }

    if (!state.current.keepAwake.active && !releaseWarning) {
      return;
    }
    try {
      await this.persistMutation(state, (next) => {
        next.keepAwake.active = false;
        if (releaseWarning) {
          next.keepAwake.warning = releaseWarning;
        }
      });
    } catch (error) {
      this.emit(state, {
        kind: "warning",
        message: `Could not persist keep-awake cleanup: ${getErrorMessage(error)}`,
      });
    }
  }

  private startHeartbeat(state: RunningDurableMission): void {
    state.heartbeatHandle = this.timer.setInterval(async () => {
      if (state.executionFinished || state.controller.signal.aborted) {
        return;
      }
      try {
        await this.persistMutation(state, (next, now) => {
          if (!next.lease || next.lease.ownerId !== this.ownerId) {
            throw new DurableMissionLeaseConflictError(
              next.missionId,
              next.lease?.ownerId ?? "missing",
            );
          }
          next.lease = renewDurableMissionLease(
            next.lease,
            now,
            next.policy.leaseDurationMs,
          );
          next.lastActivityAt = now.toISOString();
        });
        this.emit(state, {
          kind: "heartbeat",
          message: "Durable mission heartbeat persisted.",
        });
      } catch (error) {
        state.persistenceFailure = error;
        state.stopDisposition = "persistence_failure";
        state.controller.abort();
      }
    }, state.current.policy.heartbeatIntervalMs);
  }

  private armDeadline(state: RunningDurableMission): void {
    const remainingMs = getRemainingWallClockMs(state.current, this.now());
    if (remainingMs <= 0) {
      state.stopDisposition = "deadline";
      state.controller.abort();
      return;
    }
    state.deadlineHandle = this.timer.setTimeout(() => {
      state.stopDisposition = "deadline";
      state.controller.abort();
    }, remainingMs);
  }

  private disarmTimers(state: RunningDurableMission): void {
    if (state.heartbeatHandle !== undefined) {
      this.timer.clearInterval(state.heartbeatHandle);
      state.heartbeatHandle = undefined;
    }
    if (state.deadlineHandle !== undefined) {
      this.timer.clearTimeout(state.deadlineHandle);
      state.deadlineHandle = undefined;
    }
  }

  private async persistBeforeSegment(
    state: RunningDurableMission,
  ): Promise<void> {
    await this.persistMutation(state, (next, now) => {
      if (hasDurableMissionDeadlineElapsed(next, now)) {
        throw new DOMException("The mission deadline elapsed.", "AbortError");
      }
      const budgetReason = getDurableMissionBudgetExhaustionReason(next);
      if (budgetReason) {
        throw new Error(`Cannot start another segment: ${budgetReason}.`);
      }
      if (!next.lease || next.lease.ownerId !== this.ownerId) {
        throw new DurableMissionLeaseConflictError(
          next.missionId,
          next.lease?.ownerId ?? "missing",
        );
      }
      next.lease = renewDurableMissionLease(
        next.lease,
        now,
        next.policy.leaseDurationMs,
      );
      next.status = "running";
      next.lastActivityAt = now.toISOString();
    });
  }

  private checkpointSegment(
    state: RunningDurableMission,
    segmentId: string,
  ): Promise<void> {
    const normalizedSegmentId = requireNonEmptyString(segmentId, "segmentId");
    return this.persistMutation(state, (next, now) => {
      next.lineage.currentSegmentId = normalizedSegmentId;
      next.lineage.childSegmentIds = [
        ...new Set([
          ...next.lineage.childSegmentIds,
          normalizedSegmentId,
        ]),
      ].slice(-next.policy.maxSegments);
      next.lastCheckpointAt = now.toISOString();
      next.lastActivityAt = now.toISOString();
    }).then(() => undefined);
  }

  private checkpointSafetyState(
    state: RunningDurableMission,
    checkpoint: DurableMissionSafetyCheckpoint,
  ): Promise<void> {
    return this.persistMutation(state, (next, now) => {
      if (checkpoint.approval) {
        next.pendingApproval = {
          id: requireNonEmptyString(checkpoint.approval.id, "approval.id"),
          summary: requireNonEmptyString(
            checkpoint.approval.summary,
            "approval.summary",
          ),
          requestedAt: now.toISOString(),
        };
      }
      if (
        checkpoint.clearApprovalId &&
        next.pendingApproval?.id === checkpoint.clearApprovalId.trim()
      ) {
        next.pendingApproval = undefined;
      }
      if (checkpoint.unsafeWal) {
        const operationIds = [
          ...new Set(
            (checkpoint.unsafeWal.operationIds ?? [])
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ];
        const message =
          checkpoint.unsafeWal.message?.trim() ||
          "Mutation reconciliation is required before execution can resume.";
        next.reconciliation = {
          status: "required",
          operationIds,
          message,
        };
        next.status = "blocked";
        next.blocker = {
          code: "unsafe_wal",
          message,
          at: now.toISOString(),
        };
      }
      next.lastCheckpointAt = now.toISOString();
      next.lastActivityAt = now.toISOString();
    }).then(() => undefined);
  }

  private async waitForBackoff(
    state: RunningDurableMission,
  ): Promise<boolean> {
    const nextAttemptAt = state.current.retry.nextAttemptAt
      ? Date.parse(state.current.retry.nextAttemptAt)
      : this.now().getTime();
    const nowMs = this.now().getTime();
    const backoffMs = Number.isFinite(nextAttemptAt)
      ? Math.max(0, nextAttemptAt - nowMs)
      : 0;
    const deadlineMs = getRemainingWallClockMs(state.current, this.now());
    const delayMs = Math.min(backoffMs, deadlineMs);

    if (delayMs > 0) {
      try {
        await this.timer.sleep(delayMs, state.controller.signal);
      } catch (error) {
        if (!isAbortError(error)) {
          throw error;
        }
      }
    }

    if (
      state.controller.signal.aborted ||
      hasDurableMissionDeadlineElapsed(state.current, this.now())
    ) {
      if (!state.stopDisposition) {
        state.stopDisposition = "deadline";
      }
      await this.persistAbortDisposition(state);
      return false;
    }
    return true;
  }

  private async persistAbortDisposition(
    state: RunningDurableMission,
  ): Promise<void> {
    if (state.executionFinished) {
      return;
    }
    state.executionFinished = true;
    const disposition = state.stopDisposition ?? "interrupted";
    if (disposition === "deadline") {
      await this.persistTerminalState(state, "expired", {
        code: "deadline_reached",
        message: "The durable mission reached its absolute deadline.",
      });
      this.emit(state, {
        kind: "terminal",
        message: "Absolute durable mission deadline reached.",
        decision: "deadline_reached",
      });
      return;
    }
    if (disposition === "persistence_failure") {
      await this.persistTerminalState(state, "blocked", {
        code: "persistence_failure",
        message: `Durable heartbeat persistence failed: ${getErrorMessage(
          state.persistenceFailure,
        )}`,
      });
      this.emit(state, {
        kind: "terminal",
        message: "Mission paused because its durable heartbeat could not be saved.",
        decision: "persistence_failure",
      });
      return;
    }

    await this.persistTerminalState(state, disposition);
    this.emit(state, {
      kind: disposition,
      message:
        disposition === "cancelled"
          ? "Durable mission cancelled by the user."
          : "Durable mission interrupted for safe reload recovery.",
      decision: disposition,
    });
  }

  private async persistTerminalState(
    state: RunningDurableMission,
    status: "blocked" | "cancelled" | "interrupted" | "expired",
    blocker?: { code: string; message: string },
  ): Promise<void> {
    await this.persistMutation(state, (next, now) => {
      next.status = status;
      next.lease = undefined;
      next.lastActivityAt = now.toISOString();
      next.updatedAt = now.toISOString();
      next.blocker = blocker
        ? { ...blocker, at: now.toISOString() }
        : undefined;
    });
  }

  private persistMutation(
    state: RunningDurableMission,
    mutate: (manifest: DurableMissionManifestV1, now: Date) => void,
  ): Promise<DurableMissionManifestV1> {
    const operation = state.writeTail.then(async () => {
      const expectedRevision = state.current.revision;
      const next = cloneManifest(state.current);
      mutate(next, this.now());
      next.revision = expectedRevision;
      const saved = await this.repository.save(next, expectedRevision);
      state.current = cloneManifest(saved);
      return state.current;
    });
    state.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private persistReplacement(
    state: RunningDurableMission,
    replacement: DurableMissionManifestV1,
  ): Promise<DurableMissionManifestV1> {
    return this.persistMutation(state, (next) => {
      const normalized = cloneManifest(replacement);
      Object.assign(next, normalized, { revision: next.revision });
    });
  }

  private async requestStop(
    missionId: string,
    disposition: "cancelled" | "interrupted",
  ): Promise<DurableMissionManifestV1 | null> {
    const normalizedMissionId = requireNonEmptyString(missionId, "missionId");
    const active = this.running.get(normalizedMissionId);
    if (active) {
      active.stopDisposition = disposition;
      active.controller.abort();
      return active.promise;
    }

    const loaded = await this.repository.load(normalizedMissionId);
    if (!loaded) {
      return null;
    }
    if (
      loaded.status === "complete" ||
      loaded.status === "cancelled" ||
      loaded.status === "expired"
    ) {
      return loaded;
    }
    if (
      isDurableMissionLeaseLive(loaded.lease, this.now()) &&
      loaded.lease?.ownerId !== this.ownerId
    ) {
      throw new DurableMissionLeaseConflictError(
        loaded.missionId,
        loaded.lease?.ownerId ?? "unknown",
      );
    }
    const next = cloneManifest(loaded);
    next.status = disposition;
    next.lease = undefined;
    next.blocker = undefined;
    next.keepAwake.active = false;
    next.lastActivityAt = this.now().toISOString();
    next.updatedAt = next.lastActivityAt;
    return this.repository.save(next, loaded.revision);
  }

  private attachExternalAbort(
    state: RunningDurableMission,
    options: LiveDurableMissionRunOptions,
  ): void {
    if (!options.signal) {
      return;
    }
    const onAbort = () => {
      state.stopDisposition = options.abortDisposition ?? "interrupted";
      state.controller.abort();
    };
    if (options.signal.aborted) {
      onAbort();
      return;
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
    state.externalAbortCleanup = () =>
      options.signal?.removeEventListener("abort", onAbort);
  }

  private now(): Date {
    const value = this.timer.now();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Durable mission timer returned an invalid date.");
    }
    return new Date(value.getTime());
  }

  private emit(
    state: RunningDurableMission,
    event: Omit<
      DurableMissionRuntimeEvent,
      "missionId" | "at" | "status"
    >,
  ): void {
    if (!this.onEvent) {
      return;
    }
    try {
      this.onEvent({
        ...event,
        missionId: state.current.missionId,
        at: this.now().toISOString(),
        status: state.current.status,
      });
    } catch {
      // Observability must never become an execution dependency.
    }
  }
}

export function createDefaultDurableMissionRuntimeTimer(): DurableMissionRuntimeTimer {
  return {
    now: () => new Date(),
    sleep: abortableDelay,
    setTimeout: (handler, delayMs) =>
      globalThis.setTimeout(() => void handler(), Math.max(0, delayMs)),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (handler, intervalMs) =>
      globalThis.setInterval(
        () => void handler(),
        Math.max(1, intervalMs),
      ),
    clearInterval: (handle) =>
      globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  };
}

function restrictContinuation(
  outcome: DurableMissionRuntimeSegmentOutcome,
): DurableSegmentOutcome {
  const continuation = outcome.continuation;
  const productiveBudgetStop = Boolean(
    outcome.productive === true &&
      continuation?.recommended === true &&
      isBudgetStopReason(continuation.stopReason),
  );
  return {
    ...outcome,
    productive: productiveBudgetStop,
  };
}

function getRemainingBudget(
  manifest: DurableMissionManifestV1,
  now: Date,
): DurableMissionRemainingBudget {
  return {
    segments: Math.max(0, manifest.policy.maxSegments - manifest.usage.segments),
    modelSteps: Math.max(
      0,
      manifest.policy.maxModelSteps - manifest.usage.modelSteps,
    ),
    toolCalls: Math.max(
      0,
      manifest.policy.maxToolCalls - manifest.usage.toolCalls,
    ),
    wallClockMs: getRemainingWallClockMs(manifest, now),
  };
}

function getRemainingWallClockMs(
  manifest: DurableMissionManifestV1,
  now: Date,
): number {
  return Math.max(0, Date.parse(manifest.deadlineAt) - now.getTime());
}

function isBudgetStopReason(
  value: unknown,
): value is DurableMissionBudgetStopReason {
  return (
    value === "budget" ||
    value === "step_budget" ||
    value === "time_budget" ||
    value === "wall_clock_budget" ||
    value === "segment_budget"
  );
}

function classifyRuntimeError(
  error: unknown,
): DurableMissionRuntimeErrorClassification {
  if (error instanceof DurableMissionTransientError) {
    return {
      transientFailure: {
        code: error.code,
        message: error.message,
      },
    };
  }
  return {
    safetyPause: {
      code: "segment_execution_error",
      message: `Bounded segment failed: ${getErrorMessage(error)}`,
    },
  };
}

function cloneManifest(
  manifest: DurableMissionManifestV1,
): DurableMissionManifestV1 {
  const normalized = normalizeDurableMissionManifest(
    JSON.parse(JSON.stringify(manifest)),
  );
  if (!normalized) {
    throw new Error("Cannot run an invalid durable mission manifest.");
  }
  return normalized;
}

function requireNonEmptyString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function getErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 1_000) || "Unknown error";
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  );
}

function abortableDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const handle = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      globalThis.clearTimeout(handle);
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
