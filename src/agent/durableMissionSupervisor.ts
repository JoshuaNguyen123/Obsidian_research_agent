import {
  DURABLE_MISSION_MAX_SEGMENTS,
  advanceDurableMissionRetryState,
  clearDurableMissionRetryState,
  getDurableMissionBudgetExhaustionReason,
  hasDurableMissionDeadlineElapsed,
  isDurableMissionRetryExhausted,
  normalizeDurableMissionManifest,
  type DurableMissionManifestV1,
} from "./durableMission";

export interface DurableSegmentOutcome {
  segmentId?: string;
  /** Defaults to true because an outcome normally closes one runner segment. */
  segmentCompleted?: boolean;
  modelSteps?: number;
  toolCalls?: number;
  accepted?: boolean;
  checkpointAt?: string;
  unsafeWal?: {
    operationIds?: string[];
    message?: string;
  };
  approval?: {
    id: string;
    summary: string;
  };
  safetyPause?: {
    code: string;
    message: string;
  };
  transientFailure?: {
    code?: string;
    message?: string;
  };
  productive?: boolean;
}

export type DurableMissionSupervisorDecisionType =
  | "deadline_reached"
  | "budget_exhausted"
  | "accepted_complete"
  | "unsafe_wal"
  | "approval_required"
  | "safety_pause"
  | "transient_backoff"
  | "transient_failure_limit"
  | "continue"
  | "no_productive_progress";

export interface DurableMissionSupervisorDecision {
  type: DurableMissionSupervisorDecisionType;
  reason: string;
  nextAttemptAt?: string;
}

export interface DurableMissionTransition {
  manifest: DurableMissionManifestV1;
  decision: DurableMissionSupervisorDecision;
}

/** Persistence boundary used by a future activated supervisor. */
export interface DurableMissionManifestRepository {
  load(missionId: string): Promise<DurableMissionManifestV1 | null>;
  save(
    manifest: DurableMissionManifestV1,
    expectedRevision: number,
  ): Promise<DurableMissionManifestV1>;
  listRecoverable(now: Date): Promise<DurableMissionManifestV1[]>;
}

/** Existing AgentRunner segments can implement this without owning durability. */
export interface DurableMissionSegmentExecutor {
  executeSegment(
    manifest: DurableMissionManifestV1,
    options: { signal?: AbortSignal },
  ): Promise<DurableSegmentOutcome>;
}

export interface DurableMissionSupervisorRunOptions {
  signal?: AbortSignal;
}

export interface DurableMissionSupervisor {
  run(
    manifest: DurableMissionManifestV1,
    options?: DurableMissionSupervisorRunOptions,
  ): Promise<DurableMissionManifestV1>;
  stop(missionId: string): Promise<void>;
}

/**
 * Reduces one bounded segment outcome into durable mission state. The priority
 * order is deliberate: unsafe mutation reconciliation, absolute deadline,
 * accepted in-budget result, exhausted continuation budgets, approval/safety,
 * transient retry, then productive continuation. Reaching a cap on the
 * segment that finishes the mission is valid; the cap prevents another segment
 * from starting. An ambiguous mutation always wins because completion or
 * budget labels must never erase the operation ids needed for safe recovery.
 */
export function reduceDurableMissionTransition(
  current: DurableMissionManifestV1,
  outcome: DurableSegmentOutcome,
  now: Date = new Date(),
): DurableMissionTransition {
  const manifest = cloneManifest(current);
  const timestamp = assertDate(now).toISOString();
  applyOutcomeAccounting(manifest, outcome, timestamp);

  if (outcome.unsafeWal) {
    const operationIds = dedupeStrings(outcome.unsafeWal.operationIds ?? []);
    const reconciliationMessage =
      normalizeOptionalString(outcome.unsafeWal.message) ??
      "Mutation reconciliation is required before execution can resume.";
    manifest.reconciliation = {
      status: "required",
      operationIds,
      message: reconciliationMessage,
    };
    return transition(manifest, {
      status: "blocked",
      releaseLease: true,
      blocker: {
        code: "unsafe_wal",
        message: reconciliationMessage,
        at: timestamp,
      },
      decision: {
        type: "unsafe_wal",
        reason: reconciliationMessage,
      },
    });
  }

  if (hasDurableMissionDeadlineElapsed(manifest, now)) {
    return transition(manifest, {
      status: "expired",
      releaseLease: true,
      blocker: {
        code: "deadline_reached",
        message: "The durable mission reached its absolute deadline.",
        at: timestamp,
      },
      decision: {
        type: "deadline_reached",
        reason: "Absolute mission deadline reached before another segment.",
      },
    });
  }

  if (outcome.accepted) {
    manifest.retry = clearDurableMissionRetryState();
    manifest.pendingApproval = undefined;
    return transition(manifest, {
      status: "complete",
      releaseLease: true,
      clearBlocker: true,
      decision: {
        type: "accepted_complete",
        reason: "The bounded segment returned an accepted mission result.",
      },
    });
  }

  const budgetReason = getDurableMissionBudgetExhaustionReason(manifest);
  if (budgetReason) {
    return transition(manifest, {
      status: "blocked",
      releaseLease: true,
      blocker: {
        code: budgetReason,
        message: describeBudgetReason(budgetReason),
        at: timestamp,
      },
      decision: {
        type: "budget_exhausted",
        reason: describeBudgetReason(budgetReason),
      },
    });
  }

  if (outcome.approval) {
    manifest.pendingApproval = {
      id: requireString(outcome.approval.id, "approval.id"),
      summary: requireString(outcome.approval.summary, "approval.summary"),
      requestedAt: timestamp,
    };
    return transition(manifest, {
      status: "paused_for_approval",
      releaseLease: true,
      clearBlocker: true,
      decision: {
        type: "approval_required",
        reason: manifest.pendingApproval.summary,
      },
    });
  }

  if (outcome.safetyPause) {
    const code = requireString(outcome.safetyPause.code, "safetyPause.code");
    const message = requireString(
      outcome.safetyPause.message,
      "safetyPause.message",
    );
    return transition(manifest, {
      status: "blocked",
      releaseLease: true,
      blocker: { code, message, at: timestamp },
      decision: {
        type: "safety_pause",
        reason: message,
      },
    });
  }

  if (outcome.transientFailure) {
    manifest.retry = advanceDurableMissionRetryState(manifest.retry, {
      now,
      errorCode: outcome.transientFailure.code,
      errorMessage: outcome.transientFailure.message,
      maxFailures: manifest.policy.maxConsecutiveTransientFailures,
    });
    if (isDurableMissionRetryExhausted(manifest.retry, manifest.policy)) {
      return transition(manifest, {
        status: "blocked",
        releaseLease: true,
        blocker: {
          code: "transient_failure_limit",
          message: `Stopped after ${manifest.retry.consecutiveFailures} consecutive transient failures.`,
          at: timestamp,
        },
        decision: {
          type: "transient_failure_limit",
          reason: `Transient provider failure limit reached (${manifest.retry.consecutiveFailures}).`,
        },
      });
    }
    return transition(manifest, {
      status: "backing_off",
      releaseLease: true,
      clearBlocker: true,
      decision: {
        type: "transient_backoff",
        reason: "A transient provider failure was persisted for bounded retry.",
        nextAttemptAt: manifest.retry.nextAttemptAt,
      },
    });
  }

  if (outcome.productive) {
    manifest.retry = clearDurableMissionRetryState();
    manifest.pendingApproval = undefined;
    return transition(manifest, {
      status: "running",
      clearBlocker: true,
      decision: {
        type: "continue",
        reason: "The segment made productive progress and another segment is allowed.",
      },
    });
  }

  return transition(manifest, {
    status: "blocked",
    releaseLease: true,
    blocker: {
      code: "no_productive_progress",
      message: "The segment ended without accepted or productive progress.",
      at: timestamp,
    },
    decision: {
      type: "no_productive_progress",
      reason: "The segment ended without accepted or productive progress.",
    },
  });
}

function applyOutcomeAccounting(
  manifest: DurableMissionManifestV1,
  outcome: DurableSegmentOutcome,
  timestamp: string,
): void {
  const segmentCompleted = outcome.segmentCompleted !== false;
  manifest.usage = {
    segments: manifest.usage.segments + (segmentCompleted ? 1 : 0),
    modelSteps: manifest.usage.modelSteps + normalizeCount(outcome.modelSteps),
    toolCalls: manifest.usage.toolCalls + normalizeCount(outcome.toolCalls),
  };
  const segmentId = normalizeOptionalString(outcome.segmentId);
  if (segmentId) {
    manifest.lineage.currentSegmentId = segmentId;
    manifest.lineage.childSegmentIds = dedupeStrings([
      ...manifest.lineage.childSegmentIds,
      segmentId,
    ]).slice(-DURABLE_MISSION_MAX_SEGMENTS);
  }
  manifest.lineage.segmentIndex = manifest.usage.segments;
  manifest.updatedAt = timestamp;
  manifest.lastActivityAt = timestamp;
  const checkpointAt = normalizeTimestamp(outcome.checkpointAt);
  if (checkpointAt) {
    manifest.lastCheckpointAt = checkpointAt;
  }
}

function transition(
  manifest: DurableMissionManifestV1,
  options: {
    status: DurableMissionManifestV1["status"];
    releaseLease?: boolean;
    clearBlocker?: boolean;
    blocker?: DurableMissionManifestV1["blocker"];
    decision: DurableMissionSupervisorDecision;
  },
): DurableMissionTransition {
  manifest.status = options.status;
  if (options.releaseLease) {
    manifest.lease = undefined;
  }
  if (options.clearBlocker) {
    manifest.blocker = undefined;
  } else if (options.blocker) {
    manifest.blocker = options.blocker;
  }
  return { manifest, decision: options.decision };
}

function cloneManifest(
  manifest: DurableMissionManifestV1,
): DurableMissionManifestV1 {
  const clone = normalizeDurableMissionManifest(
    JSON.parse(JSON.stringify(manifest)),
  );
  if (!clone) {
    throw new Error("Cannot reduce an invalid durable mission manifest.");
  }
  return clone;
}

function describeBudgetReason(reason: string): string {
  if (reason === "segment_budget_exhausted") {
    return "The durable mission exhausted its segment budget.";
  }
  if (reason === "model_step_budget_exhausted") {
    return "The durable mission exhausted its model-step budget.";
  }
  return "The durable mission exhausted its tool-call budget.";
}

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function dedupeStrings(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ];
}

function assertDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Invalid durable mission transition timestamp.");
  }
  return value;
}
