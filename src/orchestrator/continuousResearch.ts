import { stableContentHash } from "./researchTemplateWorkflow";

export type ResearchMemoryState =
  | "unverified"
  | "verified"
  | "stale"
  | "superseded";

export interface ResearchMemoryRecord {
  id: string;
  targetId: string;
  state: ResearchMemoryState;
  sourceIds: string[];
  sourceHashes: Record<string, string>;
  verifiedAt?: string;
  staleAt?: string;
  supersededAt?: string;
  supersededById?: string;
  updatedAt: string;
}

export interface QuietHoursPolicy {
  /** Local minute of day, inclusive, from 0 through 1439. */
  startMinute: number;
  /** Local minute of day, exclusive, from 0 through 1439. */
  endMinute: number;
}

export interface ContinuousResearchPolicy {
  enabled: boolean;
  intervalMinutes: number;
  pinnedTargetIds: string[];
  quietHours?: QuietHoursPolicy;
  retry: {
    maxAttempts: number;
    baseDelayMinutes: number;
    maxDelayMinutes: number;
  };
}

export interface ContinuousResearchRunState {
  lastCompletedAt: string | null;
  lastAttemptAt: string | null;
  consecutiveFailures: number;
  lastSourceHashes: Record<string, string>;
}

export type ContinuousResearchDecisionReason =
  | "ready"
  | "disabled"
  | "no_pinned_targets"
  | "quiet_hours"
  | "interval_not_due"
  | "retry_backoff"
  | "retry_exhausted";

export interface ContinuousResearchDecision {
  shouldRun: boolean;
  reason: ContinuousResearchDecisionReason;
  nextEligibleAt: string | null;
  attemptNumber: number;
}

export interface ResearchSourceSnapshot {
  sourceId: string;
  content: string;
}

export interface ContinuousResearchVerificationInput {
  terminalSucceeded: boolean;
  acceptancePassed: boolean;
  acceptedEvidenceCount: number;
  previousSourceHashes: Record<string, string>;
  currentSourceHashes: Record<string, string>;
}

export type SourceDeltaKind = "added" | "changed" | "unchanged" | "removed";

export interface SourceDelta {
  sourceId: string;
  kind: SourceDeltaKind;
  previousHash?: string;
  currentHash?: string;
}

export function evaluateContinuousResearchRun(
  policyInput: ContinuousResearchPolicy,
  state: ContinuousResearchRunState,
  now = new Date(),
): ContinuousResearchDecision {
  const policy = normalizeContinuousResearchPolicy(policyInput);
  if (!policy.enabled) return decision(false, "disabled", null, state.consecutiveFailures + 1);
  if (policy.pinnedTargetIds.length === 0) {
    return decision(false, "no_pinned_targets", null, state.consecutiveFailures + 1);
  }

  const quietEnd = getQuietHoursEnd(policy.quietHours, now);
  if (quietEnd) {
    return decision(false, "quiet_hours", quietEnd, state.consecutiveFailures + 1);
  }

  const failures = Math.max(0, Math.trunc(state.consecutiveFailures));
  if (failures > 0) {
    if (failures >= policy.retry.maxAttempts) {
      return decision(false, "retry_exhausted", null, failures + 1);
    }
    const lastAttempt = parseTimestamp(state.lastAttemptAt);
    if (lastAttempt) {
      const delayMinutes = Math.min(
        policy.retry.maxDelayMinutes,
        policy.retry.baseDelayMinutes * 2 ** Math.max(0, failures - 1),
      );
      const retryAt = new Date(lastAttempt.getTime() + delayMinutes * 60_000);
      if (now < retryAt) {
        return decision(false, "retry_backoff", retryAt, failures + 1);
      }
    }
    return decision(true, "ready", null, failures + 1);
  }

  const lastCompleted = parseTimestamp(state.lastCompletedAt);
  if (lastCompleted) {
    const dueAt = new Date(
      lastCompleted.getTime() + policy.intervalMinutes * 60_000,
    );
    if (now < dueAt) {
      return decision(false, "interval_not_due", dueAt, 1);
    }
  }
  return decision(true, "ready", null, 1);
}

export function normalizeContinuousResearchPolicy(
  policy: ContinuousResearchPolicy,
): ContinuousResearchPolicy {
  const maxAttempts = clampInteger(policy.retry.maxAttempts, 1, 20);
  const baseDelayMinutes = clampInteger(policy.retry.baseDelayMinutes, 1, 24 * 60);
  return {
    enabled: policy.enabled === true,
    intervalMinutes: clampInteger(policy.intervalMinutes, 15, 365 * 24 * 60),
    pinnedTargetIds: uniqueStrings(policy.pinnedTargetIds).slice(0, 100),
    quietHours: policy.quietHours
      ? {
          startMinute: clampInteger(policy.quietHours.startMinute, 0, 1_439),
          endMinute: clampInteger(policy.quietHours.endMinute, 0, 1_439),
        }
      : undefined,
    retry: {
      maxAttempts,
      baseDelayMinutes,
      maxDelayMinutes: Math.max(
        baseDelayMinutes,
        clampInteger(policy.retry.maxDelayMinutes, 1, 7 * 24 * 60),
      ),
    },
  };
}

export function computeResearchSourceDeltas(
  previousHashes: Record<string, string>,
  currentSources: ResearchSourceSnapshot[],
): { deltas: SourceDelta[]; currentHashes: Record<string, string> } {
  const currentHashes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const source of currentSources) {
    const sourceId = source.sourceId.trim();
    if (!sourceId) continue;
    currentHashes[sourceId] = hashResearchSource(source.content);
  }
  const ids = Array.from(
    new Set([...Object.keys(previousHashes), ...Object.keys(currentHashes)]),
  ).sort();
  const deltas = ids.map((sourceId): SourceDelta => {
    const previousHash = previousHashes[sourceId];
    const currentHash = currentHashes[sourceId];
    if (previousHash === undefined) {
      return { sourceId, kind: "added", currentHash };
    }
    if (currentHash === undefined) {
      return { sourceId, kind: "removed", previousHash };
    }
    if (previousHash === currentHash) {
      return { sourceId, kind: "unchanged", previousHash, currentHash };
    }
    return { sourceId, kind: "changed", previousHash, currentHash };
  });
  return { deltas, currentHashes };
}

/** Fail-closed proof gate used before durable memory can become verified. */
export function evaluateContinuousResearchVerification(
  input: ContinuousResearchVerificationInput,
): boolean {
  if (
    !input.terminalSucceeded ||
    !input.acceptancePassed ||
    input.acceptedEvidenceCount <= 0
  ) {
    return false;
  }
  const currentKeys = Object.keys(input.currentSourceHashes);
  if (currentKeys.length === 0) return false;
  const previousKeys = Object.keys(input.previousSourceHashes);
  return (
    previousKeys.length === 0 ||
    previousKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(input.currentSourceHashes, key) &&
        typeof input.currentSourceHashes[key] === "string" &&
        input.currentSourceHashes[key].length > 0,
    )
  );
}

export function hashResearchSource(content: string): string {
  const normalized = content
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stableContentHash(normalized);
}

export function transitionResearchMemory(
  record: ResearchMemoryRecord,
  nextState: ResearchMemoryState,
  options: { now?: Date; supersededById?: string } = {},
): ResearchMemoryRecord {
  if (record.state === nextState) return record;
  const allowed: Record<ResearchMemoryState, ResearchMemoryState[]> = {
    unverified: ["verified", "stale", "superseded"],
    verified: ["stale", "superseded"],
    stale: ["verified", "superseded"],
    superseded: [],
  };
  if (!allowed[record.state].includes(nextState)) {
    throw new Error(`Invalid research-memory transition ${record.state} -> ${nextState}.`);
  }
  if (nextState === "superseded" && !options.supersededById?.trim()) {
    throw new Error("Superseded research memory requires a replacement record ID.");
  }
  const now = (options.now ?? new Date()).toISOString();
  return {
    ...record,
    state: nextState,
    verifiedAt: nextState === "verified" ? now : record.verifiedAt,
    staleAt: nextState === "stale" ? now : record.staleAt,
    supersededAt: nextState === "superseded" ? now : record.supersededAt,
    supersededById:
      nextState === "superseded"
        ? options.supersededById?.trim()
        : record.supersededById,
    updatedAt: now,
  };
}

export function applySourceDeltasToResearchMemory(
  records: ResearchMemoryRecord[],
  deltas: SourceDelta[],
  now = new Date(),
): ResearchMemoryRecord[] {
  const invalidatedSourceIds = new Set(
    deltas
      .filter((delta) => delta.kind === "changed" || delta.kind === "removed")
      .map((delta) => delta.sourceId),
  );
  return records.map((record) => {
    if (
      (record.state === "verified" || record.state === "unverified") &&
      record.sourceIds.some((sourceId) => invalidatedSourceIds.has(sourceId))
    ) {
      return transitionResearchMemory(record, "stale", { now });
    }
    return record;
  });
}

export function supersedeResearchMemory(
  records: ResearchMemoryRecord[],
  replacement: ResearchMemoryRecord,
  now = new Date(),
): ResearchMemoryRecord[] {
  const result = records.map((record) => {
    if (
      record.id !== replacement.id &&
      record.targetId === replacement.targetId &&
      record.state !== "superseded"
    ) {
      return transitionResearchMemory(record, "superseded", {
        now,
        supersededById: replacement.id,
      });
    }
    return record;
  });
  return [...result.filter((record) => record.id !== replacement.id), replacement];
}

export function recordContinuousResearchOutcome(
  state: ContinuousResearchRunState,
  input: {
    now?: Date;
    succeeded: boolean;
    sourceHashes?: Record<string, string>;
  },
): ContinuousResearchRunState {
  const now = (input.now ?? new Date()).toISOString();
  return {
    lastAttemptAt: now,
    lastCompletedAt: input.succeeded ? now : state.lastCompletedAt,
    consecutiveFailures: input.succeeded ? 0 : state.consecutiveFailures + 1,
    lastSourceHashes:
      input.succeeded && input.sourceHashes
        ? { ...input.sourceHashes }
        : { ...state.lastSourceHashes },
  };
}

function getQuietHoursEnd(
  policy: QuietHoursPolicy | undefined,
  now: Date,
): Date | null {
  if (!policy || policy.startMinute === policy.endMinute) return null;
  const start = clampInteger(policy.startMinute, 0, 1_439);
  const end = clampInteger(policy.endMinute, 0, 1_439);
  const minute = now.getHours() * 60 + now.getMinutes();
  const wraps = start > end;
  const quiet = wraps ? minute >= start || minute < end : minute >= start && minute < end;
  if (!quiet) return null;
  const result = new Date(now);
  result.setSeconds(0, 0);
  if (!wraps || minute < end) {
    result.setHours(Math.floor(end / 60), end % 60, 0, 0);
  } else {
    result.setDate(result.getDate() + 1);
    result.setHours(Math.floor(end / 60), end % 60, 0, 0);
  }
  return result;
}

function decision(
  shouldRun: boolean,
  reason: ContinuousResearchDecisionReason,
  nextEligibleAt: Date | null,
  attemptNumber: number,
): ContinuousResearchDecision {
  return {
    shouldRun,
    reason,
    nextEligibleAt: nextEligibleAt?.toISOString() ?? null,
    attemptNumber,
  };
}

function parseTimestamp(value: string | null): Date | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(value)))
    : minimum;
}
