import {
  type LinearMutationJournalRecord,
  type LinearMutationJournalState,
  type LinearReconciliationDecision,
  type LinearReconciliationObservation,
  type LinearResourceType,
} from "./types";

export function createLinearMutationJournalRecord(input: {
  operationId: string;
  operationKey: string;
  resourceType: LinearResourceType;
  resourceId?: string;
  clientResourceId?: string;
  payloadHash: string;
  preconditionHash?: string;
  expectedPostHash?: string;
  expectedAbsent?: boolean;
  now?: Date;
}): LinearMutationJournalRecord {
  const operationId = requireToken(input.operationId, "operationId");
  const operationKey = requireToken(input.operationKey, "operationKey");
  const payloadHash = requireHash(input.payloadHash, "payloadHash");
  if (!input.resourceId && !input.clientResourceId) {
    throw new Error("Linear mutation journal requires a resource id or client resource id.");
  }
  const timestamp = (input.now ?? new Date()).toISOString();
  return {
    version: 1,
    operationId,
    operationKey,
    resourceType: input.resourceType,
    resourceId: normalizeOptionalToken(input.resourceId),
    clientResourceId: normalizeOptionalToken(input.clientResourceId),
    payloadHash,
    preconditionHash: normalizeOptionalHash(input.preconditionHash),
    expectedPostHash: normalizeOptionalHash(input.expectedPostHash),
    expectedAbsent: input.expectedAbsent === true,
    state: "intent_recorded",
    mutationMayHaveApplied: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function transitionLinearMutationJournalRecord(
  record: LinearMutationJournalRecord,
  state: LinearMutationJournalState,
  options: {
    observedPostHash?: string;
    mutationMayHaveApplied?: boolean;
    now?: Date;
  } = {},
): LinearMutationJournalRecord {
  if (!isAllowedTransition(record.state, state)) {
    throw new Error(`Invalid Linear mutation transition: ${record.state} -> ${state}`);
  }
  return {
    ...record,
    state,
    observedPostHash:
      normalizeOptionalHash(options.observedPostHash) ?? record.observedPostHash,
    mutationMayHaveApplied:
      options.mutationMayHaveApplied ??
      (record.mutationMayHaveApplied ||
        state === "applied" ||
        state === "verified" ||
        state === "committed" ||
        state === "reconcile_required"),
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
}

export function reconcileLinearMutation(
  record: LinearMutationJournalRecord,
  observation: LinearReconciliationObservation,
): LinearReconciliationDecision {
  if (record.state === "committed") {
    return {
      action: "already_committed",
      reason: "The Linear mutation journal is already committed.",
    };
  }

  if (record.expectedAbsent && !observation.found) {
    if (record.state === "intent_recorded" && !record.mutationMayHaveApplied) {
      return {
        action: "safe_to_retry",
        reason: "The destructive mutation was never dispatched.",
      };
    }
    return {
      action: "commit_observed_result",
      reason: "Readback confirms the resource is absent as intended.",
    };
  }

  if (
    observation.found &&
    record.expectedPostHash &&
    observation.snapshotHash === record.expectedPostHash
  ) {
    return {
      action: "commit_observed_result",
      reason: "Readback matches the expected post-mutation snapshot.",
    };
  }

  if (
    observation.found &&
    record.preconditionHash &&
    observation.snapshotHash === record.preconditionHash
  ) {
    return {
      action:
        record.state === "intent_recorded" && !record.mutationMayHaveApplied
          ? "safe_to_retry"
          : "reapprove_retry",
      reason:
        "The target still matches the precondition; retry requires fresh authority after dispatch uncertainty.",
    };
  }

  if (!observation.found) {
    if (record.state === "intent_recorded" && !record.mutationMayHaveApplied) {
      return {
        action: "safe_to_retry",
        reason: "No mutation was dispatched and no resource exists.",
      };
    }
    return {
      action: "wait_and_recheck",
      reason:
        "The mutation may still complete after the transport returned; do not retry in the same turn.",
    };
  }

  return {
    action: "manual_review",
    reason: "Readback matches neither the approved precondition nor expected result.",
  };
}

export function buildLinearOperationId(input: {
  resourceType: LinearResourceType;
  verb: string;
  runId: string;
  taskId: string;
  sequence?: number;
}): string {
  const parts = [
    "linear",
    input.resourceType,
    input.verb,
    input.runId,
    input.taskId,
    String(Math.max(0, Math.trunc(input.sequence ?? 0))),
  ].map(toSafePart);
  return parts.join(":").slice(0, 240);
}

function isAllowedTransition(
  from: LinearMutationJournalState,
  to: LinearMutationJournalState,
): boolean {
  const transitions: Record<LinearMutationJournalState, LinearMutationJournalState[]> = {
    intent_recorded: ["applying", "failed"],
    applying: ["applied", "failed", "reconcile_required"],
    applied: ["verified", "failed", "reconcile_required"],
    verified: ["committed", "failed", "reconcile_required"],
    committed: [],
    failed: ["reconcile_required"],
    reconcile_required: ["verified", "committed", "failed"],
  };
  return transitions[from].includes(to);
}

function requireToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n\0]/.test(normalized)) {
    throw new Error(`Invalid Linear mutation ${label}.`);
  }
  return normalized;
}

function normalizeOptionalToken(value: string | undefined): string | undefined {
  return value === undefined ? undefined : requireToken(value, "resource id");
}

function requireHash(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^sha256:[0-9a-f]{64}$/i.test(normalized)) {
    throw new Error(`Invalid Linear mutation ${label}.`);
  }
  return normalized.toLowerCase();
}

function normalizeOptionalHash(value: string | undefined): string | undefined {
  return value === undefined ? undefined : requireHash(value, "hash");
}

function toSafePart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "unknown";
}
