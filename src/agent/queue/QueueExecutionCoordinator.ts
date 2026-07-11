import {
  acquireLinearQueueLease,
  reduceLinearQueue,
  type LinearQueueLeaseResult,
} from "./linearQueue";
import {
  reserveQueueDailyStart,
  type QueueDailyStartBudgetStateV1,
  type QueueDailyStartReservationResult,
} from "./dailyStartBudget";
import {
  acquireResourceLocks,
  normalizeCanonicalResourceKey,
  releaseResourceLocks,
  type ResourceLockResult,
  type ResourceLockStateV1,
} from "./resourceLocks";
import type {
  LinearQueueCandidateV1,
  LinearQueueLeaseV1,
  LinearQueueStateV1,
} from "./types";
import type {
  DurableLinearQueueReducer,
  LinearQueueClock,
  MaybePromise,
} from "./LinearQueueSupervisor";

export const QUEUE_EXECUTION_MAX_CONCURRENCY = 2;
export const QUEUE_EXECUTION_DEFAULT_LEASE_MS = 15 * 60_000;

export type DurableResourceLockReducer = (
  reduce: (current: ResourceLockStateV1) => ResourceLockStateV1,
) => Promise<ResourceLockStateV1>;

export type DurableQueueDailyStartBudgetReducer = (
  reduce: (
    current: QueueDailyStartBudgetStateV1,
  ) => QueueDailyStartBudgetStateV1,
) => Promise<QueueDailyStartBudgetStateV1>;

export interface ClaimMutationDispatchResult {
  status: "applied" | "ambiguous";
  operationId?: string;
}

export interface QueueExecutionCallbackInput {
  candidate: LinearQueueCandidateV1;
  lease: LinearQueueLeaseV1;
  signal: AbortSignal;
}

export interface QueueExecutionGrantCheckInput extends QueueExecutionCallbackInput {
  checkedAt: string;
}

export interface QueueExecutionResourceKeyInput {
  candidate: LinearQueueCandidateV1;
  signal: AbortSignal;
}

export type QueueWorkerResult =
  | { status: "completed" }
  | { status: "blocked"; error: string }
  | { status: "failed"; error: string; retryable: boolean }
  | {
      status: "reconcile_required";
      stage: "result_comment" | "completed_state" | "blocked_state";
      operationId?: string;
    };

export type QueueReconciliationStage =
  | "claim_comment"
  | "started_state"
  | "result_comment"
  | "completed_state"
  | "blocked_state";

export interface QueueLeaseLifecycleInput extends QueueExecutionCallbackInput {
  resourceKeys: string[];
  resourceLockToken: string | null;
  reason:
    | "execution_active"
    | "reconcile_required"
    | "claim_verification_failed"
    | "start_verification_failed"
    | "resource_conflict"
    | "grant_ineligible"
    | "daily_limit_exhausted"
    | "execution_completed"
    | "execution_blocked"
    | "execution_failed"
    | "stopped"
    | "coordinator_error";
}

export interface QueueExecutionCoordinatorOptions {
  ownerId: string;
  reduceQueueState: DurableLinearQueueReducer;
  reduceResourceLocks: DurableResourceLockReducer;
  /** Serialized, persisted reducer that atomically reserves daily starts. */
  reduceDailyStartBudget: DurableQueueDailyStartBudgetReducer;
  /** Re-read the live grant after leases are held and before any Linear write. */
  isExecutionGrantEligible(input: QueueExecutionGrantCheckInput): MaybePromise<boolean>;
  /** Resolve trusted host bindings such as canonical vault-path locks. */
  resolveAdditionalResourceKeys?(
    input: QueueExecutionResourceKeyInput,
  ): MaybePromise<readonly string[]>;
  createClaimComment(input: QueueExecutionCallbackInput): Promise<ClaimMutationDispatchResult>;
  verifyClaimComment(input: QueueExecutionCallbackInput): Promise<boolean>;
  moveIssueToStarted(input: QueueExecutionCallbackInput): Promise<ClaimMutationDispatchResult>;
  verifyIssueStarted(input: QueueExecutionCallbackInput): Promise<boolean>;
  execute(input: QueueExecutionCallbackInput): Promise<QueueWorkerResult>;
  /** Host hook for durable retention/renewal when reconciliation is required. */
  retainLease(input: QueueLeaseLifecycleInput): MaybePromise<void>;
  /** Host hook invoked after the coordinator releases its queue/resource leases. */
  releaseLease(input: QueueLeaseLifecycleInput): MaybePromise<void>;
  onReconcileRequired?(input: {
    candidate: LinearQueueCandidateV1;
    stage: QueueReconciliationStage;
    operationId?: string;
  }): MaybePromise<void>;
  onCoordinatorError?(error: unknown): void;
  clock?: LinearQueueClock;
  leaseMs?: number;
}

export type QueueCandidateExecutionResult =
  | { issueId: string; status: "completed" }
  | { issueId: string; status: "blocked"; error: string }
  | {
      issueId: string;
      status: "failed";
      stage: "claim" | "execute" | "coordinator";
      error: string;
      retryable: boolean;
    }
  | {
      issueId: string;
      status: "skipped";
      reason:
        | "stopped"
        | "missing"
        | "ineligible"
        | "terminal"
        | "leased"
        | "resource_locked"
        | "grant_ineligible"
        | "daily_limit_exhausted"
        | "claim_comment_unverified"
        | "started_state_unverified";
    }
  | {
      issueId: string;
      status: "reconcile_required";
      stage: QueueReconciliationStage;
      operationId?: string;
    };

export class QueueExecutionCoordinator {
  private readonly options: QueueExecutionCoordinatorOptions;
  private readonly clock: LinearQueueClock;
  private readonly leaseMs: number;
  private readonly semaphore = new AbortableSemaphore(QUEUE_EXECUTION_MAX_CONCURRENCY);
  private readonly stopController = new AbortController();
  private readonly inFlight = new Map<string, Promise<QueueCandidateExecutionResult>>();
  private readonly heldResourceLocks = new Map<
    string,
    { token: string; resourceKeys: ReadonlySet<string> }
  >();
  private stopped = false;

  constructor(options: QueueExecutionCoordinatorOptions) {
    this.options = options;
    this.clock = options.clock ?? { now: () => new Date() };
    this.leaseMs = clampInteger(
      options.leaseMs ?? QUEUE_EXECUTION_DEFAULT_LEASE_MS,
      1_000,
      86_400_000,
    );
    assertIdentifier(options.ownerId, "queue coordinator owner id");
  }

  async runCandidates(issueIds: readonly string[]): Promise<QueueCandidateExecutionResult[]> {
    if (issueIds.length > 100) {
      throw new Error("Queue coordinator accepts at most 100 issue ids per batch.");
    }
    return Promise.all(issueIds.map((issueId) => this.runCandidate(issueId)));
  }

  runCandidate(issueId: string): Promise<QueueCandidateExecutionResult> {
    assertIdentifier(issueId, "Linear issue id");
    if (this.stopped) {
      return Promise.resolve({ issueId, status: "skipped", reason: "stopped" });
    }
    const existing = this.inFlight.get(issueId);
    if (existing) {
      return existing;
    }
    const task = this.runWithPermit(issueId).finally(() => {
      if (this.inFlight.get(issueId) === task) {
        this.inFlight.delete(issueId);
      }
      this.heldResourceLocks.delete(issueId);
    });
    this.inFlight.set(issueId, task);
    return task;
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.stopController.abort();
      this.semaphore.stop();
    }
    await Promise.allSettled([...this.inFlight.values()]);
  }

  get activeCount(): number {
    return this.semaphore.activeCount;
  }

  private async runWithPermit(issueId: string): Promise<QueueCandidateExecutionResult> {
    let releasePermit: (() => void) | null = null;
    try {
      releasePermit = await this.semaphore.acquire(this.stopController.signal);
    } catch {
      return { issueId, status: "skipped", reason: "stopped" };
    }
    try {
      if (this.stopped) {
        return { issueId, status: "skipped", reason: "stopped" };
      }
      return await this.coordinateCandidate(issueId, this.stopController.signal);
    } finally {
      releasePermit();
    }
  }

  private async coordinateCandidate(
    issueId: string,
    signal: AbortSignal,
  ): Promise<QueueCandidateExecutionResult> {
    let leaseResult: LinearQueueLeaseResult | undefined;
    let candidate: LinearQueueCandidateV1 | undefined;
    const leaseAt = this.nowIso();
    try {
      await this.options.reduceQueueState((current) => {
        candidate = current.candidates[issueId];
        leaseResult = acquireLinearQueueLease(current, {
          issueId,
          ownerId: this.options.ownerId,
          at: leaseAt,
          leaseMs: this.leaseMs,
        });
        return leaseResult.state;
      });
    } catch (error) {
      return this.coordinatorFailure(issueId, error);
    }
    if (!leaseResult?.accepted || !leaseResult.lease || !candidate) {
      return {
        issueId,
        status: "skipped",
        reason: leaseResult?.reason ?? "missing",
      };
    }
    const lease = leaseResult.lease;
    let resourceKeys: string[];
    try {
      resourceKeys = await resourceKeysFor(
        candidate,
        signal,
        this.options.resolveAdditionalResourceKeys,
      );
    } catch (error) {
      await this.releaseQueueLease(candidate, lease, signal, "coordinator_error");
      await this.notifyRelease({
        candidate,
        lease,
        signal,
        resourceKeys: [],
        resourceLockToken: null,
        reason: "coordinator_error",
      });
      return this.coordinatorFailure(issueId, error);
    }
    let lockResult: ResourceLockResult | undefined;
    const lockAt = this.nowIso();
    try {
      await this.options.reduceResourceLocks((current) => {
        lockResult = acquireResourceLocks(current, {
          resourceKeys,
          ownerId: this.options.ownerId,
          at: lockAt,
          leaseMs: this.leaseMs,
        });
        return lockResult.state;
      });
    } catch (error) {
      await this.releaseQueueLease(candidate, lease, signal, "coordinator_error");
      await this.notifyRelease({
        candidate,
        lease,
        signal,
        resourceKeys: [],
        resourceLockToken: null,
        reason: "coordinator_error",
      });
      return this.coordinatorFailure(issueId, error);
    }
    if (!lockResult?.accepted || !lockResult.token) {
      const localBlockers = this.localResourceBlockers(
        issueId,
        lockResult?.conflicts ?? [],
      );
      await this.releaseQueueLease(candidate, lease, signal, "resource_conflict");
      if (localBlockers.length > 0 && !signal.aborted && !this.stopped) {
        await Promise.allSettled(localBlockers);
        if (!signal.aborted && !this.stopped) {
          return this.coordinateCandidate(issueId, signal);
        }
        return { issueId, status: "skipped", reason: "stopped" };
      }
      return { issueId, status: "skipped", reason: "resource_locked" };
    }
    const resourceLockToken = lockResult.token;
    this.heldResourceLocks.set(issueId, {
      token: resourceLockToken,
      resourceKeys: new Set(resourceKeys),
    });
    const callbackInput: QueueExecutionCallbackInput = { candidate, lease, signal };

    try {
      assertNotAborted(signal);
      const grantCheckedAt = this.nowIso();
      if (
        (await this.options.isExecutionGrantEligible({
          ...callbackInput,
          checkedAt: grantCheckedAt,
        })) !== true
      ) {
        await this.releaseAll(
          callbackInput,
          resourceKeys,
          resourceLockToken,
          "grant_ineligible",
        );
        return { issueId, status: "skipped", reason: "grant_ineligible" };
      }

      assertNotAborted(signal);
      let dailyStart: QueueDailyStartReservationResult | undefined;
      const budgetAt = this.nowIso();
      await this.options.reduceDailyStartBudget((current) => {
        dailyStart = reserveQueueDailyStart(current, {
          issueId: callbackInput.candidate.issueId,
          contractFingerprint: callbackInput.candidate.workItem.fingerprint,
          at: budgetAt,
        });
        return dailyStart.state;
      });
      if (!dailyStart?.accepted) {
        await this.releaseAll(
          callbackInput,
          resourceKeys,
          resourceLockToken,
          "daily_limit_exhausted",
        );
        return { issueId, status: "skipped", reason: "daily_limit_exhausted" };
      }

      // The durable daily reservation is the final host-local operation before
      // dispatching the first external claim mutation.
      assertNotAborted(signal);
      const commentDispatch = assertDispatchResult(
        await this.options.createClaimComment(callbackInput),
      );
      if (commentDispatch.status === "ambiguous") {
        return await this.reconcileRequired(
          callbackInput,
          resourceKeys,
          resourceLockToken,
          "claim_comment",
          commentDispatch.operationId,
        );
      }
      assertNotAborted(signal);
      if ((await this.options.verifyClaimComment(callbackInput)) !== true) {
        await this.releaseAll(
          callbackInput,
          resourceKeys,
          resourceLockToken,
          "claim_verification_failed",
        );
        return { issueId, status: "skipped", reason: "claim_comment_unverified" };
      }

      assertNotAborted(signal);
      const startedDispatch = assertDispatchResult(
        await this.options.moveIssueToStarted(callbackInput),
      );
      if (startedDispatch.status === "ambiguous") {
        return await this.reconcileRequired(
          callbackInput,
          resourceKeys,
          resourceLockToken,
          "started_state",
          startedDispatch.operationId,
        );
      }
      assertNotAborted(signal);
      if ((await this.options.verifyIssueStarted(callbackInput)) !== true) {
        await this.releaseAll(
          callbackInput,
          resourceKeys,
          resourceLockToken,
          "start_verification_failed",
        );
        return { issueId, status: "skipped", reason: "started_state_unverified" };
      }

      assertNotAborted(signal);
      await this.options.retainLease({
        ...callbackInput,
        resourceKeys,
        resourceLockToken,
        reason: "execution_active",
      });
      const startedAt = this.nowIso();
      await this.options.reduceQueueState((current) =>
        reduceLinearQueue(current, {
          type: "candidate_started",
          expectedRevision: current.revision,
          at: startedAt,
          issueId,
          ownerId: lease.ownerId,
          token: lease.token,
        }),
      );
      const workerResult = assertWorkerResult(
        await this.options.execute(callbackInput),
      );
      if (workerResult.status === "reconcile_required") {
        return await this.reconcileRequired(
          callbackInput,
          resourceKeys,
          resourceLockToken,
          workerResult.stage,
          workerResult.operationId,
        );
      }
      if (workerResult.status === "blocked") {
        await this.recordWorkerBlocked(callbackInput, workerResult.error);
        await this.releaseResourceLockAndNotify(
          callbackInput,
          resourceKeys,
          resourceLockToken,
          "execution_blocked",
        );
        return {
          issueId,
          status: "blocked",
          error: workerResult.error,
        };
      }
      if (workerResult.status === "completed") {
        const completedAt = this.nowIso();
        await this.options.reduceQueueState((current) =>
          reduceLinearQueue(current, {
            type: "candidate_completed",
            expectedRevision: current.revision,
            at: completedAt,
            issueId,
            ownerId: lease.ownerId,
            token: lease.token,
          }),
        );
        await this.releaseResourceLockAndNotify(
          callbackInput,
          resourceKeys,
          resourceLockToken,
          "execution_completed",
        );
        return { issueId, status: "completed" };
      }
      await this.recordWorkerFailure(callbackInput, workerResult);
      await this.releaseResourceLockAndNotify(
        callbackInput,
        resourceKeys,
        resourceLockToken,
        "execution_failed",
      );
      return {
        issueId,
        status: "failed",
        stage: "execute",
        error: workerResult.error,
        retryable: workerResult.retryable,
      };
    } catch (error) {
      const stopped = signal.aborted || this.stopped;
      try {
        await this.recordThrownWorkerFailure(callbackInput, error, stopped);
      } catch (recordError) {
        this.options.onCoordinatorError?.(recordError);
      }
      await this.releaseResourceLockAndNotify(
        callbackInput,
        resourceKeys,
        resourceLockToken,
        stopped ? "stopped" : "coordinator_error",
      );
      if (stopped) {
        return { issueId, status: "skipped", reason: "stopped" };
      }
      return {
        issueId,
        status: "failed",
        stage: "claim",
        error: errorMessage(error),
        retryable: true,
      };
    }
  }

  private async reconcileRequired(
    input: QueueExecutionCallbackInput,
    resourceKeys: string[],
    resourceLockToken: string,
    stage: QueueReconciliationStage,
    operationId?: string,
  ): Promise<QueueCandidateExecutionResult> {
    const lifecycle: QueueLeaseLifecycleInput = {
      ...input,
      resourceKeys,
      resourceLockToken,
      reason: "reconcile_required",
    };
    try {
      await this.options.retainLease(lifecycle);
      await this.options.onReconcileRequired?.({
        candidate: input.candidate,
        stage,
        operationId,
      });
    } catch (error) {
      this.options.onCoordinatorError?.(error);
    }
    return {
      issueId: input.candidate.issueId,
      status: "reconcile_required",
      stage,
      ...(operationId ? { operationId } : {}),
    };
  }

  private async recordWorkerFailure(
    input: QueueExecutionCallbackInput,
    result: Extract<QueueWorkerResult, { status: "failed" }>,
  ): Promise<void> {
    const at = this.nowIso();
    await this.options.reduceQueueState((current) =>
      reduceLinearQueue(current, {
        type: "candidate_failed",
        expectedRevision: current.revision,
        at,
        issueId: input.candidate.issueId,
        ownerId: input.lease.ownerId,
        token: input.lease.token,
        error: result.error,
        retryable: result.retryable,
      }),
    );
  }

  private async recordWorkerBlocked(
    input: QueueExecutionCallbackInput,
    error: string,
  ): Promise<void> {
    const at = this.nowIso();
    await this.options.reduceQueueState((current) =>
      reduceLinearQueue(current, {
        type: "candidate_blocked",
        expectedRevision: current.revision,
        at,
        issueId: input.candidate.issueId,
        ownerId: input.lease.ownerId,
        token: input.lease.token,
        error,
      }),
    );
  }

  private async recordThrownWorkerFailure(
    input: QueueExecutionCallbackInput,
    error: unknown,
    stopped: boolean,
  ): Promise<void> {
    const at = this.nowIso();
    await this.options.reduceQueueState((current) => {
      const candidate = current.candidates[input.candidate.issueId];
      if (!candidate?.lease || candidate.lease.token !== input.lease.token) {
        return current;
      }
      if (candidate.status === "running") {
        return reduceLinearQueue(current, {
          type: "candidate_failed",
          expectedRevision: current.revision,
          at,
          issueId: candidate.issueId,
          ownerId: input.lease.ownerId,
          token: input.lease.token,
          error: stopped ? "Queue coordinator stopped." : errorMessage(error),
          retryable: true,
        });
      }
      return reduceLinearQueue(current, {
        type: "lease_released",
        expectedRevision: current.revision,
        at,
        issueId: candidate.issueId,
        ownerId: input.lease.ownerId,
        token: input.lease.token,
      });
    });
  }

  private async releaseAll(
    input: QueueExecutionCallbackInput,
    resourceKeys: string[],
    resourceLockToken: string,
    reason: QueueLeaseLifecycleInput["reason"],
  ): Promise<void> {
    await this.releaseQueueLease(input.candidate, input.lease, input.signal, reason);
    await this.releaseResourceLockAndNotify(
      input,
      resourceKeys,
      resourceLockToken,
      reason,
    );
  }

  private async releaseQueueLease(
    candidate: LinearQueueCandidateV1,
    lease: LinearQueueLeaseV1,
    signal: AbortSignal,
    reason: QueueLeaseLifecycleInput["reason"],
  ): Promise<void> {
    const at = this.nowIso();
    try {
      await this.options.reduceQueueState((current) => {
        const currentCandidate = current.candidates[candidate.issueId];
        if (!currentCandidate?.lease || currentCandidate.lease.token !== lease.token) {
          return current;
        }
        return reduceLinearQueue(current, {
          type: "lease_released",
          expectedRevision: current.revision,
          at,
          issueId: candidate.issueId,
          ownerId: lease.ownerId,
          token: lease.token,
        });
      });
    } catch (error) {
      this.options.onCoordinatorError?.(error);
    }
    if (reason === "resource_conflict") {
      await this.notifyRelease({
        candidate,
        lease,
        signal,
        resourceKeys: [],
        resourceLockToken: null,
        reason,
      });
    }
  }

  private async releaseResourceLockAndNotify(
    input: QueueExecutionCallbackInput,
    resourceKeys: string[],
    resourceLockToken: string,
    reason: QueueLeaseLifecycleInput["reason"],
  ): Promise<void> {
    const at = this.nowIso();
    try {
      await this.options.reduceResourceLocks((current) => {
        const released = releaseResourceLocks(current, {
          resourceKeys,
          ownerId: this.options.ownerId,
          token: resourceLockToken,
          at,
        });
        return released.accepted ? released.state : current;
      });
    } catch (error) {
      this.options.onCoordinatorError?.(error);
    }
    await this.notifyRelease({
      ...input,
      resourceKeys,
      resourceLockToken,
      reason,
    });
  }

  private async notifyRelease(input: QueueLeaseLifecycleInput): Promise<void> {
    try {
      await this.options.releaseLease(input);
    } catch (error) {
      this.options.onCoordinatorError?.(error);
    }
  }

  private coordinatorFailure(issueId: string, error: unknown): QueueCandidateExecutionResult {
    this.options.onCoordinatorError?.(error);
    return {
      issueId,
      status: "failed",
      stage: "coordinator",
      error: errorMessage(error),
      retryable: true,
    };
  }

  private localResourceBlockers(
    issueId: string,
    conflictingKeys: readonly string[],
  ): Promise<QueueCandidateExecutionResult>[] {
    const conflicts = new Set(conflictingKeys);
    const blockers: Promise<QueueCandidateExecutionResult>[] = [];
    for (const [otherIssueId, held] of this.heldResourceLocks.entries()) {
      if (
        otherIssueId === issueId ||
        ![...held.resourceKeys].some((resourceKey) => conflicts.has(resourceKey))
      ) {
        continue;
      }
      const task = this.inFlight.get(otherIssueId);
      if (task) {
        blockers.push(task);
      }
    }
    return blockers;
  }

  private nowIso(): string {
    const now = this.clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Queue coordinator clock returned an invalid date.");
    }
    return now.toISOString();
  }
}

async function resourceKeysFor(
  candidate: LinearQueueCandidateV1,
  signal: AbortSignal,
  resolveAdditionalResourceKeys:
    | QueueExecutionCoordinatorOptions["resolveAdditionalResourceKeys"]
    | undefined,
): Promise<string[]> {
  const defaultKeys = [
    `linear:issue:${candidate.issueId}`,
    ...(candidate.workItem.repositoryKey
      ? [`repository:${candidate.workItem.repositoryKey}`]
      : []),
  ];
  const additional = resolveAdditionalResourceKeys
    ? await resolveAdditionalResourceKeys({ candidate, signal })
    : [];
  if (!Array.isArray(additional)) {
    throw new Error("Additional queue resource keys must be an array.");
  }
  const keys = [...defaultKeys, ...additional].map(normalizeCanonicalResourceKey);
  const unique = [...new Set(keys)].sort();
  if (unique.length > 32) {
    throw new Error("Queue execution requires at most 32 canonical resource keys.");
  }
  return unique;
}

function assertDispatchResult(
  value: ClaimMutationDispatchResult,
): ClaimMutationDispatchResult {
  if (
    !value ||
    typeof value !== "object" ||
    (value.status !== "applied" && value.status !== "ambiguous") ||
    (value.operationId !== undefined && typeof value.operationId !== "string")
  ) {
    throw new Error("Claim mutation callback returned an invalid dispatch result.");
  }
  return value;
}

function assertWorkerResult(value: QueueWorkerResult): QueueWorkerResult {
  if (!value || typeof value !== "object") {
    throw new Error("Queue worker returned an invalid result.");
  }
  if (value.status === "completed") {
    return value;
  }
  if (
    value.status === "blocked" &&
    typeof value.error === "string" &&
    value.error.trim().length > 0
  ) {
    return value;
  }
  if (
    value.status === "reconcile_required" &&
    (value.stage === "result_comment" ||
      value.stage === "completed_state" ||
      value.stage === "blocked_state") &&
    (value.operationId === undefined ||
      (typeof value.operationId === "string" && value.operationId.trim().length > 0))
  ) {
    return value;
  }
  if (
    value.status !== "failed" ||
    typeof value.error !== "string" ||
    !value.error.trim() ||
    typeof value.retryable !== "boolean"
  ) {
    throw new Error("Queue worker returned an invalid result.");
  }
  return value;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 2_000) || "Queue execution failed.";
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Queue execution was aborted.", "AbortError");
  }
}

interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

class AbortableSemaphore {
  private readonly capacity: number;
  private available: number;
  private readonly waiters: SemaphoreWaiter[] = [];
  private stopped = false;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.available = capacity;
  }

  get activeCount(): number {
    return this.capacity - this.available;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (this.stopped || signal.aborted) {
      return Promise.reject(new DOMException("Semaphore stopped.", "AbortError"));
    }
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.createRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(new DOMException("Semaphore wait aborted.", "AbortError"));
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new DOMException("Semaphore stopped.", "AbortError"));
    }
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (!this.stopped) {
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
          waiter.resolve(this.createRelease());
          return;
        }
      }
      this.available = Math.min(this.capacity, this.available + 1);
    };
  }
}
