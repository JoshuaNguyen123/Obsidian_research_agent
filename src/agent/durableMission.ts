import { normalizeVaultPath } from "../tools/validation";

export const DURABLE_MISSION_MANIFEST_VERSION = 1 as const;
export const DURABLE_MISSION_MIN_DURATION_HOURS = 8;
export const DURABLE_MISSION_DEFAULT_DURATION_HOURS = 10;
export const DURABLE_MISSION_MAX_DURATION_HOURS = 12;
export const DURABLE_MISSION_MAX_SEGMENTS = 24;
export const DURABLE_MISSION_MAX_MODEL_STEPS = 2_400;
export const DURABLE_MISSION_MAX_TOOL_CALLS = 4_800;
export const DURABLE_MISSION_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1_000;
export const DURABLE_MISSION_LEASE_DURATION_MS = 5 * 60 * 1_000;
export const DURABLE_MISSION_MAX_TRANSIENT_FAILURES = 12;
export const DURABLE_MISSION_RETRY_DELAYS_MS = [
  30_000,
  60_000,
  2 * 60_000,
  4 * 60_000,
  8 * 60_000,
  15 * 60_000,
] as const;

const HOUR_MS = 60 * 60 * 1_000;

export type DurableMissionStatus =
  | "queued"
  | "running"
  | "backing_off"
  | "paused_for_approval"
  | "blocked"
  | "complete"
  | "cancelled"
  | "interrupted"
  | "expired";

export interface DurableMissionPolicy {
  durationHours: number;
  maxSegments: number;
  maxModelSteps: number;
  maxToolCalls: number;
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
  maxConsecutiveTransientFailures: number;
}

export const DEFAULT_DURABLE_MISSION_POLICY: Readonly<DurableMissionPolicy> =
  Object.freeze({
    durationHours: DURABLE_MISSION_DEFAULT_DURATION_HOURS,
    maxSegments: DURABLE_MISSION_MAX_SEGMENTS,
    maxModelSteps: DURABLE_MISSION_MAX_MODEL_STEPS,
    maxToolCalls: DURABLE_MISSION_MAX_TOOL_CALLS,
    heartbeatIntervalMs: DURABLE_MISSION_HEARTBEAT_INTERVAL_MS,
    leaseDurationMs: DURABLE_MISSION_LEASE_DURATION_MS,
    maxConsecutiveTransientFailures: DURABLE_MISSION_MAX_TRANSIENT_FAILURES,
  });

export interface DurableMissionUsage {
  segments: number;
  modelSteps: number;
  toolCalls: number;
}

export interface DurableMissionLineage {
  currentSegmentId?: string;
  segmentIndex: number;
  childSegmentIds: string[];
}

export interface DurableMissionLease {
  ownerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface DurableMissionRetryState {
  consecutiveFailures: number;
  lastFailureAt?: string;
  nextAttemptAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface DurableMissionPendingApproval {
  id: string;
  summary: string;
  requestedAt: string;
}

export type DurableMissionReconciliationStatus =
  | "clean"
  | "required"
  | "blocked";

export interface DurableMissionReconciliationState {
  status: DurableMissionReconciliationStatus;
  operationIds: string[];
  message?: string;
}

export interface DurableMissionKeepAwakeState {
  requested: boolean;
  active: boolean;
  warning?: string;
}

export interface DurableMissionBlocker {
  code: string;
  message: string;
  at: string;
}

export interface DurableMissionManifestV1 {
  version: typeof DURABLE_MISSION_MANIFEST_VERSION;
  revision: number;
  missionId: string;
  rootMissionId: string;
  prompt: string;
  status: DurableMissionStatus;
  policy: DurableMissionPolicy;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  currentNotePath?: string;
  lineage: DurableMissionLineage;
  usage: DurableMissionUsage;
  lastActivityAt: string;
  lastCheckpointAt?: string;
  lease?: DurableMissionLease;
  retry: DurableMissionRetryState;
  pendingApproval?: DurableMissionPendingApproval;
  reconciliation: DurableMissionReconciliationState;
  keepAwake: DurableMissionKeepAwakeState;
  blocker?: DurableMissionBlocker;
}

export interface CreateDurableMissionManifestInput {
  missionId: string;
  prompt: string;
  rootMissionId?: string;
  status?: DurableMissionStatus;
  durationHours?: number;
  policy?: Partial<DurableMissionPolicy>;
  currentNotePath?: string | null;
  keepAwakeRequested?: boolean;
  createdAt?: Date;
}

export type DurableMissionBudgetExhaustionReason =
  | "segment_budget_exhausted"
  | "model_step_budget_exhausted"
  | "tool_call_budget_exhausted";

export type DurableMissionRecoveryBlockReason =
  | "deadline_elapsed"
  | DurableMissionBudgetExhaustionReason
  | "terminal_status"
  | "blocked_status"
  | "approval_required"
  | "unsafe_reconciliation"
  | "live_lease"
  | "retry_exhausted"
  | "backoff_pending"
  | "status_not_recoverable";

export interface DurableMissionRecoverability {
  recoverable: boolean;
  reason?: DurableMissionRecoveryBlockReason;
  availableAt?: string;
}

export function normalizeDurableMissionDurationHours(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DURABLE_MISSION_DEFAULT_DURATION_HOURS;
  }
  return Math.min(
    DURABLE_MISSION_MAX_DURATION_HOURS,
    Math.max(DURABLE_MISSION_MIN_DURATION_HOURS, value),
  );
}

export function normalizeDurableMissionPolicy(
  value: unknown,
): DurableMissionPolicy {
  const input = isRecord(value) ? value : {};
  const durationHours = normalizeDurableMissionDurationHours(
    input.durationHours,
  );
  const heartbeatIntervalMs = clampInteger(
    input.heartbeatIntervalMs,
    15_000,
    10 * 60_000,
    DURABLE_MISSION_HEARTBEAT_INTERVAL_MS,
  );
  return {
    durationHours,
    maxSegments: clampInteger(
      input.maxSegments,
      1,
      DURABLE_MISSION_MAX_SEGMENTS,
      DURABLE_MISSION_MAX_SEGMENTS,
    ),
    maxModelSteps: clampInteger(
      input.maxModelSteps,
      1,
      DURABLE_MISSION_MAX_MODEL_STEPS,
      DURABLE_MISSION_MAX_MODEL_STEPS,
    ),
    maxToolCalls: clampInteger(
      input.maxToolCalls,
      1,
      DURABLE_MISSION_MAX_TOOL_CALLS,
      DURABLE_MISSION_MAX_TOOL_CALLS,
    ),
    heartbeatIntervalMs,
    leaseDurationMs: clampInteger(
      input.leaseDurationMs,
      heartbeatIntervalMs,
      30 * 60_000,
      Math.max(DURABLE_MISSION_LEASE_DURATION_MS, heartbeatIntervalMs),
    ),
    maxConsecutiveTransientFailures: clampInteger(
      input.maxConsecutiveTransientFailures,
      1,
      DURABLE_MISSION_MAX_TRANSIENT_FAILURES,
      DURABLE_MISSION_MAX_TRANSIENT_FAILURES,
    ),
  };
}

export function createDurableMissionManifest({
  missionId,
  prompt,
  rootMissionId = missionId,
  status = "queued",
  durationHours,
  policy,
  currentNotePath,
  keepAwakeRequested = false,
  createdAt = new Date(),
}: CreateDurableMissionManifestInput): DurableMissionManifestV1 {
  const normalizedPolicy = normalizeDurableMissionPolicy({
    ...policy,
    durationHours: durationHours ?? policy?.durationHours,
  });
  const timestamp = assertDate(createdAt, "createdAt").toISOString();
  const normalizedMissionId = requireNonEmptyString(missionId, "missionId");
  const normalizedRootMissionId = requireNonEmptyString(
    rootMissionId,
    "rootMissionId",
  );
  const normalizedPrompt = requireNonEmptyString(prompt, "prompt");
  if (!isDurableMissionStatus(status)) {
    throw new Error(`Invalid durable mission status: ${String(status)}`);
  }

  return {
    version: DURABLE_MISSION_MANIFEST_VERSION,
    revision: 0,
    missionId: normalizedMissionId,
    rootMissionId: normalizedRootMissionId,
    prompt: normalizedPrompt,
    status,
    policy: normalizedPolicy,
    createdAt: timestamp,
    updatedAt: timestamp,
    deadlineAt: computeDurableMissionDeadline(
      createdAt,
      normalizedPolicy.durationHours,
    ),
    currentNotePath: normalizeCurrentNotePath(currentNotePath),
    lineage: {
      segmentIndex: 0,
      childSegmentIds: [],
    },
    usage: {
      segments: 0,
      modelSteps: 0,
      toolCalls: 0,
    },
    lastActivityAt: timestamp,
    retry: {
      consecutiveFailures: 0,
    },
    reconciliation: {
      status: "clean",
      operationIds: [],
    },
    keepAwake: {
      requested: Boolean(keepAwakeRequested),
      active: false,
    },
  };
}

export function normalizeDurableMissionManifest(
  value: unknown,
): DurableMissionManifestV1 | null {
  if (!isRecord(value) || value.version !== DURABLE_MISSION_MANIFEST_VERSION) {
    return null;
  }

  const missionId = getNonEmptyString(value.missionId);
  const rootMissionId = getNonEmptyString(value.rootMissionId);
  const prompt = getNonEmptyString(value.prompt);
  const status = isDurableMissionStatus(value.status) ? value.status : null;
  const revision = getNonNegativeSafeInteger(value.revision);
  const policy = normalizePersistedDurableMissionPolicy(value.policy);
  const createdAt = normalizeTimestamp(value.createdAt);
  const updatedAt = normalizeTimestamp(value.updatedAt);
  const deadlineAt = normalizeTimestamp(value.deadlineAt);
  const lastActivityAt = normalizeTimestamp(value.lastActivityAt);
  const lineage = normalizeLineage(value.lineage);
  const usage = normalizeUsage(value.usage);
  if (
    !missionId ||
    !rootMissionId ||
    !prompt ||
    !status ||
    revision === undefined ||
    !policy ||
    !createdAt ||
    !updatedAt ||
    !deadlineAt ||
    !lastActivityAt ||
    !lineage ||
    !usage
  ) {
    return null;
  }
  if (!isPersistedDeadlineConsistent(createdAt, deadlineAt, policy)) {
    return null;
  }

  const lease = normalizeLease(value.lease);
  const retry = normalizeRetryState(value.retry);
  const pendingApproval = normalizePendingApproval(value.pendingApproval);
  const reconciliation = normalizeReconciliation(value.reconciliation);
  const keepAwake = normalizeKeepAwake(value.keepAwake);
  const blocker = normalizeBlocker(value.blocker);
  if (
    (value.lease !== undefined && !lease) ||
    !retry ||
    (value.pendingApproval !== undefined && !pendingApproval) ||
    !reconciliation ||
    !keepAwake ||
    (value.blocker !== undefined && !blocker)
  ) {
    return null;
  }

  const lastCheckpointAt = normalizeTimestamp(value.lastCheckpointAt);
  if (value.lastCheckpointAt !== undefined && !lastCheckpointAt) {
    return null;
  }

  return {
    version: DURABLE_MISSION_MANIFEST_VERSION,
    revision,
    missionId,
    rootMissionId,
    prompt,
    status,
    policy,
    createdAt,
    updatedAt,
    deadlineAt,
    currentNotePath: normalizeCurrentNotePath(value.currentNotePath),
    lineage,
    usage,
    lastActivityAt,
    lastCheckpointAt,
    lease,
    retry,
    pendingApproval,
    reconciliation,
    keepAwake,
    blocker,
  };
}

/**
 * Persisted policy is a trust boundary. Unlike creation-time normalization,
 * missing or corrupt caps must never expand a recovering mission's budget.
 */
function normalizePersistedDurableMissionPolicy(
  value: unknown,
): DurableMissionPolicy | null {
  if (!isRecord(value)) {
    return null;
  }

  const durationHours =
    typeof value.durationHours === "number" &&
    Number.isFinite(value.durationHours) &&
    value.durationHours >= DURABLE_MISSION_MIN_DURATION_HOURS &&
    value.durationHours <= DURABLE_MISSION_MAX_DURATION_HOURS
      ? value.durationHours
      : undefined;
  const maxSegments = getSafeIntegerInRange(
    value.maxSegments,
    1,
    DURABLE_MISSION_MAX_SEGMENTS,
  );
  const maxModelSteps = getSafeIntegerInRange(
    value.maxModelSteps,
    1,
    DURABLE_MISSION_MAX_MODEL_STEPS,
  );
  const maxToolCalls = getSafeIntegerInRange(
    value.maxToolCalls,
    1,
    DURABLE_MISSION_MAX_TOOL_CALLS,
  );
  const heartbeatIntervalMs = getSafeIntegerInRange(
    value.heartbeatIntervalMs,
    15_000,
    10 * 60_000,
  );
  const leaseDurationMs = getSafeIntegerInRange(
    value.leaseDurationMs,
    15_000,
    30 * 60_000,
  );
  const maxConsecutiveTransientFailures = getSafeIntegerInRange(
    value.maxConsecutiveTransientFailures,
    1,
    DURABLE_MISSION_MAX_TRANSIENT_FAILURES,
  );

  if (
    durationHours === undefined ||
    maxSegments === undefined ||
    maxModelSteps === undefined ||
    maxToolCalls === undefined ||
    heartbeatIntervalMs === undefined ||
    leaseDurationMs === undefined ||
    leaseDurationMs < heartbeatIntervalMs ||
    maxConsecutiveTransientFailures === undefined
  ) {
    return null;
  }

  return {
    durationHours,
    maxSegments,
    maxModelSteps,
    maxToolCalls,
    heartbeatIntervalMs,
    leaseDurationMs,
    maxConsecutiveTransientFailures,
  };
}

function isPersistedDeadlineConsistent(
  createdAt: string,
  deadlineAt: string,
  policy: DurableMissionPolicy,
): boolean {
  const createdAtMs = Date.parse(createdAt);
  const deadlineAtMs = Date.parse(deadlineAt);
  const minimumDeadlineMs =
    createdAtMs + DURABLE_MISSION_MIN_DURATION_HOURS * HOUR_MS;
  const maximumDeadlineMs =
    createdAtMs + DURABLE_MISSION_MAX_DURATION_HOURS * HOUR_MS;
  const policyDeadlineMs = Date.parse(
    computeDurableMissionDeadline(createdAt, policy.durationHours),
  );
  return (
    deadlineAtMs >= minimumDeadlineMs &&
    deadlineAtMs <= maximumDeadlineMs &&
    deadlineAtMs === policyDeadlineMs
  );
}

export function computeDurableMissionDeadline(
  startedAt: Date | string | number,
  durationHours: unknown = DURABLE_MISSION_DEFAULT_DURATION_HOURS,
): string {
  const start = toValidDate(startedAt);
  if (!start) {
    throw new Error("Cannot compute a durable mission deadline from an invalid date.");
  }
  return new Date(
    start.getTime() + normalizeDurableMissionDurationHours(durationHours) * HOUR_MS,
  ).toISOString();
}

export function hasDurableMissionDeadlineElapsed(
  manifestOrDeadline: DurableMissionManifestV1 | string,
  now: Date = new Date(),
): boolean {
  const deadline =
    typeof manifestOrDeadline === "string"
      ? Date.parse(manifestOrDeadline)
      : Date.parse(manifestOrDeadline.deadlineAt);
  return Number.isFinite(deadline) && assertDate(now, "now").getTime() >= deadline;
}

export function createDurableMissionLease({
  ownerId,
  now = new Date(),
  durationMs = DURABLE_MISSION_LEASE_DURATION_MS,
}: {
  ownerId: string;
  now?: Date;
  durationMs?: number;
}): DurableMissionLease {
  const timestamp = assertDate(now, "now");
  const normalizedDuration = clampInteger(
    durationMs,
    1_000,
    30 * 60_000,
    DURABLE_MISSION_LEASE_DURATION_MS,
  );
  const at = timestamp.toISOString();
  return {
    ownerId: requireNonEmptyString(ownerId, "ownerId"),
    acquiredAt: at,
    heartbeatAt: at,
    expiresAt: new Date(timestamp.getTime() + normalizedDuration).toISOString(),
  };
}

export function renewDurableMissionLease(
  lease: DurableMissionLease,
  now: Date = new Date(),
  durationMs: number = DURABLE_MISSION_LEASE_DURATION_MS,
): DurableMissionLease {
  const normalized = normalizeLease(lease);
  if (!normalized) {
    throw new Error("Cannot renew an invalid durable mission lease.");
  }
  const timestamp = assertDate(now, "now");
  const normalizedDuration = clampInteger(
    durationMs,
    1_000,
    30 * 60_000,
    DURABLE_MISSION_LEASE_DURATION_MS,
  );
  return {
    ...normalized,
    heartbeatAt: timestamp.toISOString(),
    expiresAt: new Date(timestamp.getTime() + normalizedDuration).toISOString(),
  };
}

export function isDurableMissionLeaseLive(
  lease: DurableMissionLease | undefined,
  now: Date = new Date(),
): boolean {
  if (!lease) {
    return false;
  }
  const normalized = normalizeLease(lease);
  return Boolean(
    normalized &&
      assertDate(now, "now").getTime() < Date.parse(normalized.expiresAt),
  );
}

export function canClaimDurableMissionLease(
  manifest: DurableMissionManifestV1,
  ownerId: string,
  now: Date = new Date(),
): boolean {
  const claimant = requireNonEmptyString(ownerId, "ownerId");
  return (
    !isDurableMissionLeaseLive(manifest.lease, now) ||
    manifest.lease?.ownerId === claimant
  );
}

export function getDurableMissionRetryDelayMs(
  consecutiveFailureCount: number,
): number {
  const count = normalizeNonNegativeInteger(consecutiveFailureCount);
  if (count === 0) {
    return 0;
  }
  const index = Math.min(count - 1, DURABLE_MISSION_RETRY_DELAYS_MS.length - 1);
  return DURABLE_MISSION_RETRY_DELAYS_MS[index];
}

export function advanceDurableMissionRetryState(
  previous: DurableMissionRetryState,
  {
    now = new Date(),
    errorCode,
    errorMessage,
    maxFailures = DURABLE_MISSION_MAX_TRANSIENT_FAILURES,
  }: {
    now?: Date;
    errorCode?: string;
    errorMessage?: string;
    maxFailures?: number;
  } = {},
): DurableMissionRetryState {
  const timestamp = assertDate(now, "now");
  const normalizedPrevious = normalizeRetryState(previous) ?? {
    consecutiveFailures: 0,
  };
  const cap = clampInteger(
    maxFailures,
    1,
    DURABLE_MISSION_MAX_TRANSIENT_FAILURES,
    DURABLE_MISSION_MAX_TRANSIENT_FAILURES,
  );
  const consecutiveFailures = Math.min(
    cap,
    normalizedPrevious.consecutiveFailures + 1,
  );
  const delayMs = getDurableMissionRetryDelayMs(consecutiveFailures);
  return {
    consecutiveFailures,
    lastFailureAt: timestamp.toISOString(),
    nextAttemptAt: new Date(timestamp.getTime() + delayMs).toISOString(),
    lastErrorCode: normalizeOptionalString(errorCode),
    lastErrorMessage: normalizeOptionalString(errorMessage),
  };
}

export function clearDurableMissionRetryState(): DurableMissionRetryState {
  return { consecutiveFailures: 0 };
}

export function isDurableMissionRetryExhausted(
  retry: DurableMissionRetryState,
  policy: DurableMissionPolicy = { ...DEFAULT_DURABLE_MISSION_POLICY },
): boolean {
  return (
    normalizeNonNegativeInteger(retry.consecutiveFailures) >=
    normalizeDurableMissionPolicy(policy).maxConsecutiveTransientFailures
  );
}

export function isDurableMissionRetryDue(
  retry: DurableMissionRetryState,
  now: Date = new Date(),
): boolean {
  if (!retry.nextAttemptAt) {
    return true;
  }
  const nextAttempt = Date.parse(retry.nextAttemptAt);
  return (
    Number.isFinite(nextAttempt) &&
    assertDate(now, "now").getTime() >= nextAttempt
  );
}

export function getDurableMissionBudgetExhaustionReason(
  manifest: DurableMissionManifestV1,
): DurableMissionBudgetExhaustionReason | undefined {
  if (manifest.usage.segments >= manifest.policy.maxSegments) {
    return "segment_budget_exhausted";
  }
  if (manifest.usage.modelSteps >= manifest.policy.maxModelSteps) {
    return "model_step_budget_exhausted";
  }
  if (manifest.usage.toolCalls >= manifest.policy.maxToolCalls) {
    return "tool_call_budget_exhausted";
  }
  return undefined;
}

export function getDurableMissionRecoverability(
  manifest: DurableMissionManifestV1,
  now: Date = new Date(),
): DurableMissionRecoverability {
  if (hasDurableMissionDeadlineElapsed(manifest, now)) {
    return { recoverable: false, reason: "deadline_elapsed" };
  }
  const budgetReason = getDurableMissionBudgetExhaustionReason(manifest);
  if (budgetReason) {
    return { recoverable: false, reason: budgetReason };
  }
  if (
    manifest.status === "complete" ||
    manifest.status === "cancelled" ||
    manifest.status === "expired"
  ) {
    return { recoverable: false, reason: "terminal_status" };
  }
  if (manifest.status === "blocked") {
    return { recoverable: false, reason: "blocked_status" };
  }
  if (manifest.status === "paused_for_approval" || manifest.pendingApproval) {
    return { recoverable: false, reason: "approval_required" };
  }
  if (manifest.reconciliation.status !== "clean") {
    return { recoverable: false, reason: "unsafe_reconciliation" };
  }
  if (isDurableMissionLeaseLive(manifest.lease, now)) {
    return { recoverable: false, reason: "live_lease" };
  }
  if (isDurableMissionRetryExhausted(manifest.retry, manifest.policy)) {
    return { recoverable: false, reason: "retry_exhausted" };
  }
  if (manifest.status === "backing_off" && !isDurableMissionRetryDue(manifest.retry, now)) {
    return {
      recoverable: false,
      reason: "backoff_pending",
      availableAt: manifest.retry.nextAttemptAt,
    };
  }
  if (
    manifest.status === "queued" ||
    manifest.status === "running" ||
    manifest.status === "interrupted" ||
    manifest.status === "backing_off"
  ) {
    return { recoverable: true };
  }
  return { recoverable: false, reason: "status_not_recoverable" };
}

export function isDurableMissionRecoverable(
  manifest: DurableMissionManifestV1,
  now: Date = new Date(),
): boolean {
  return getDurableMissionRecoverability(manifest, now).recoverable;
}

function normalizeLineage(value: unknown): DurableMissionLineage | null {
  if (!isRecord(value)) {
    return null;
  }
  const currentSegmentId = normalizeOptionalString(value.currentSegmentId);
  if (value.currentSegmentId !== undefined && !currentSegmentId) {
    return null;
  }
  const segmentIndex = getNonNegativeSafeInteger(value.segmentIndex);
  const childSegmentIds = normalizePersistedIdList(
    value.childSegmentIds,
    DURABLE_MISSION_MAX_SEGMENTS,
  );
  if (segmentIndex === undefined || !childSegmentIds) {
    return null;
  }
  return {
    currentSegmentId,
    segmentIndex,
    childSegmentIds,
  };
}

function normalizeUsage(value: unknown): DurableMissionUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  const segments = getNonNegativeSafeInteger(value.segments);
  const modelSteps = getNonNegativeSafeInteger(value.modelSteps);
  const toolCalls = getNonNegativeSafeInteger(value.toolCalls);
  if (
    segments === undefined ||
    modelSteps === undefined ||
    toolCalls === undefined
  ) {
    return null;
  }
  return {
    segments,
    modelSteps,
    toolCalls,
  };
}

function normalizeLease(value: unknown): DurableMissionLease | undefined {
  if (value === undefined || !isRecord(value)) {
    return undefined;
  }
  const ownerId = getNonEmptyString(value.ownerId);
  const acquiredAt = normalizeTimestamp(value.acquiredAt);
  const heartbeatAt = normalizeTimestamp(value.heartbeatAt);
  const expiresAt = normalizeTimestamp(value.expiresAt);
  return ownerId && acquiredAt && heartbeatAt && expiresAt
    ? { ownerId, acquiredAt, heartbeatAt, expiresAt }
    : undefined;
}

function normalizeRetryState(
  value: unknown,
): DurableMissionRetryState | null {
  if (!isRecord(value)) {
    return null;
  }
  const lastFailureAt = normalizeTimestamp(value.lastFailureAt);
  const nextAttemptAt = normalizeTimestamp(value.nextAttemptAt);
  const consecutiveFailures = getNonNegativeSafeInteger(
    value.consecutiveFailures,
  );
  if (
    consecutiveFailures === undefined ||
    (value.lastFailureAt !== undefined && !lastFailureAt) ||
    (value.nextAttemptAt !== undefined && !nextAttemptAt)
  ) {
    return null;
  }
  return {
    consecutiveFailures,
    lastFailureAt,
    nextAttemptAt,
    lastErrorCode: normalizeOptionalString(value.lastErrorCode),
    lastErrorMessage: normalizeOptionalString(value.lastErrorMessage),
  };
}

function normalizePendingApproval(
  value: unknown,
): DurableMissionPendingApproval | undefined {
  if (value === undefined || !isRecord(value)) {
    return undefined;
  }
  const id = getNonEmptyString(value.id);
  const summary = getNonEmptyString(value.summary);
  const requestedAt = normalizeTimestamp(value.requestedAt);
  return id && summary && requestedAt ? { id, summary, requestedAt } : undefined;
}

function normalizeReconciliation(
  value: unknown,
): DurableMissionReconciliationState | null {
  if (!isRecord(value)) {
    return null;
  }
  const status = value.status;
  if (status !== "clean" && status !== "required" && status !== "blocked") {
    return null;
  }
  if (!Array.isArray(value.operationIds)) {
    return null;
  }
  return {
    status,
    operationIds: dedupeStrings(value.operationIds).slice(-256),
    message: normalizeOptionalString(value.message),
  };
}

function normalizeKeepAwake(
  value: unknown,
): DurableMissionKeepAwakeState | null {
  if (
    !isRecord(value) ||
    typeof value.requested !== "boolean" ||
    typeof value.active !== "boolean"
  ) {
    return null;
  }
  return {
    requested: value.requested,
    active: value.active,
    warning: normalizeOptionalString(value.warning),
  };
}

function normalizeBlocker(value: unknown): DurableMissionBlocker | undefined {
  if (value === undefined || !isRecord(value)) {
    return undefined;
  }
  const code = getNonEmptyString(value.code);
  const message = getNonEmptyString(value.message);
  const at = normalizeTimestamp(value.at);
  return code && message && at ? { code, message, at } : undefined;
}

function normalizeCurrentNotePath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return normalizeVaultPath(value, { requireMarkdown: true });
  } catch {
    return undefined;
  }
}

function isDurableMissionStatus(value: unknown): value is DurableMissionStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "backing_off" ||
    value === "paused_for_approval" ||
    value === "blocked" ||
    value === "complete" ||
    value === "cancelled" ||
    value === "interrupted" ||
    value === "expired"
  );
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function toValidDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function assertDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function requireNonEmptyString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function getNonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function getSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function normalizePersistedIdList(
  value: unknown,
  maximumLength: number,
): string[] | null {
  if (!Array.isArray(value) || value.length > maximumLength) {
    return null;
  }
  const normalized = value.map(getNonEmptyString);
  if (normalized.some((item) => item === undefined)) {
    return null;
  }
  const ids = normalized as string[];
  return new Set(ids).size === ids.length ? ids : null;
}

function clampInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function dedupeStrings(value: unknown[]): string[] {
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
