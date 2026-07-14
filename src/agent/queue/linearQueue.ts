import type { WorkItemRiskClass } from "../../integrations/linear/WorkItemSpecV1";
import {
  parseCompatibleWorkItemSpec,
  type ParsedCompatibleWorkItemSpec,
} from "../../integrations/linear/WorkItemSpecV2";
import { fingerprintCanonicalJson } from "./fingerprint";
import {
  LINEAR_QUEUE_SCHEMA_VERSION,
  type CandidateEligibilityV1,
  type CandidateIneligibilityReason,
  type LinearQueueCandidateStatus,
  type LinearQueueCandidateV1,
  type LinearQueueCursorV1,
  type LinearQueueEventV1,
  type LinearQueueLeaseV1,
  type LinearQueueStateV1,
} from "./types";

export interface LinearQueueLeaseResult {
  accepted: boolean;
  state: LinearQueueStateV1;
  lease?: LinearQueueLeaseV1;
  reason?: "missing" | "ineligible" | "terminal" | "leased";
}

export function createLinearQueueState(input: {
  workspaceId: string;
  at: string;
}): LinearQueueStateV1 {
  const at = expectIsoTimestamp(input.at, "queue creation time");
  return {
    schemaVersion: LINEAR_QUEUE_SCHEMA_VERSION,
    revision: 0,
    workspaceId: expectIdentifier(input.workspaceId, "workspace id"),
    cursor: null,
    candidates: {},
    createdAt: at,
    updatedAt: at,
  };
}

export function normalizeLinearQueueState(value: unknown): LinearQueueStateV1 {
  const record = expectRecord(value, "Linear queue state");
  assertExactKeys(record, [
    "schemaVersion",
    "revision",
    "workspaceId",
    "cursor",
    "candidates",
    "createdAt",
    "updatedAt",
  ]);
  if (record.schemaVersion !== LINEAR_QUEUE_SCHEMA_VERSION) {
    throw new Error("Unsupported Linear queue state schema version.");
  }
  const createdAt = expectIsoTimestamp(record.createdAt, "queue creation time");
  const updatedAt = expectIsoTimestamp(record.updatedAt, "queue update time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("Linear queue update time precedes its creation time.");
  }
  const rawCandidates = expectRecord(record.candidates, "Linear queue candidates");
  const candidates: Record<string, LinearQueueCandidateV1> = {};
  for (const [storedId, rawCandidate] of Object.entries(rawCandidates)) {
    const candidate = parseCandidate(rawCandidate);
    if (candidate.issueId !== storedId) {
      throw new Error(`Queue candidate key ${storedId} does not match its issue id.`);
    }
    candidates[storedId] = candidate;
  }
  return {
    schemaVersion: LINEAR_QUEUE_SCHEMA_VERSION,
    revision: expectInteger(record.revision, "queue revision", 0, Number.MAX_SAFE_INTEGER),
    workspaceId: expectIdentifier(record.workspaceId, "workspace id"),
    cursor: record.cursor === null ? null : parseCursor(record.cursor),
    candidates,
    createdAt,
    updatedAt,
  };
}

export const parseLinearQueueState = normalizeLinearQueueState;

export function reduceLinearQueue(
  state: LinearQueueStateV1,
  event: LinearQueueEventV1,
): LinearQueueStateV1 {
  const current = normalizeLinearQueueState(state);
  if (event.expectedRevision !== current.revision) {
    throw new Error(
      `Linear queue revision conflict: expected ${event.expectedRevision}, current ${current.revision}.`,
    );
  }
  const at = expectMonotonicTimestamp(event.at, current.updatedAt);

  switch (event.type) {
    case "candidate_upserted":
      return applyCandidateUpsert(current, event, at);
    case "candidate_evaluated":
      return updateCandidate(current, event.issueId, at, (candidate) => {
        if (
          candidate.status === "running" ||
          candidate.status === "waiting_for_publication" ||
          candidate.status === "completed" ||
          candidate.status === "failed" ||
          isLeaseActive(candidate.lease, at)
        ) {
          throw new Error("Cannot re-evaluate an active or terminal queue candidate.");
        }
        const eligibility = parseEligibility(event.eligibility);
        if (eligibility.evaluatedAt !== at) {
          throw new Error("Candidate eligibility time must match the queue event time.");
        }
        return {
          ...candidate,
          status: eligibility.eligible ? "eligible" : "blocked",
          eligibility,
          lease: null,
          lastError: eligibility.eligible ? null : candidate.lastError,
          updatedAt: at,
        };
      });
    case "lease_acquired":
      return updateCandidate(current, event.issueId, at, (candidate) => {
        if (!candidate.eligibility?.eligible) {
          throw new Error("Cannot lease an ineligible queue candidate.");
        }
        if (
          candidate.status === "waiting_for_publication" ||
          candidate.status === "completed" ||
          candidate.status === "failed"
        ) {
          throw new Error("Cannot lease a terminal queue candidate.");
        }
        if (isLeaseActive(candidate.lease, at)) {
          throw new Error("Queue candidate already has an active lease.");
        }
        const lease = parseLease(event.lease);
        if (lease.acquiredAt !== at) {
          throw new Error("Candidate lease acquisition time must match the event time.");
        }
        return {
          ...candidate,
          status: "eligible",
          lease,
          updatedAt: at,
        };
      });
    case "lease_renewed":
      return updateCandidate(current, event.issueId, at, (candidate) => {
        assertMatchingActiveLease(candidate, event.ownerId, event.token, at);
        const expiresAt = expectIsoTimestamp(event.expiresAt, "candidate lease expiry");
        if (Date.parse(expiresAt) <= Date.parse(at)) {
          throw new Error("Renewed candidate lease must expire after the event time.");
        }
        return {
          ...candidate,
          lease: { ...candidate.lease!, expiresAt },
          updatedAt: at,
        };
      });
    case "lease_released":
      return updateCandidate(current, event.issueId, at, (candidate) => {
        assertMatchingLease(candidate, event.ownerId, event.token);
        return {
          ...candidate,
          status: candidate.status === "running" ? "eligible" : candidate.status,
          lease: null,
          updatedAt: at,
        };
      });
    case "candidate_started":
      return updateCandidate(current, event.issueId, at, (candidate) => {
        if (candidate.status !== "eligible") {
          throw new Error("Only an eligible candidate can start execution.");
        }
        assertMatchingActiveLease(candidate, event.ownerId, event.token, at);
        return {
          ...candidate,
          status: "running",
          attemptCount: candidate.attemptCount + 1,
          lastError: null,
          updatedAt: at,
        };
      });
    case "candidate_completed":
      return updateCandidate(current, event.issueId, at, (candidate) => {
        if (candidate.status !== "running") {
          throw new Error("Only a running candidate can complete.");
        }
        assertMatchingActiveLease(candidate, event.ownerId, event.token, at);
        return {
          ...candidate,
          status: "completed",
          lease: null,
          completedAt: at,
          lastError: null,
          updatedAt: at,
        };
      });
    case "candidate_reconciliation_completed":
      return updateCandidate(current, event.issueId, at, (candidate) => {
        const contractFingerprint = expectToken(
          event.contractFingerprint,
          "reconciled candidate contract fingerprint",
        );
        expectIdentifier(
          event.reconciliationReceiptId,
          "reconciled candidate receipt id",
        );
        if (candidate.workItem.fingerprint !== contractFingerprint) {
          throw new Error(
            "Reconciled completion proof belongs to a different work-item contract.",
          );
        }
        if (candidate.status !== "running" && candidate.status !== "completed") {
          throw new Error(
            "Only a running or already completed candidate can accept reconciled completion proof.",
          );
        }
        return {
          ...candidate,
          status: "completed",
          lease: null,
          completedAt: candidate.completedAt ?? at,
          lastError: null,
          updatedAt: at,
        };
      });
    case "candidate_waiting_for_publication":
      return updateCandidate(current, event.issueId, at, (candidate) => {
        if (candidate.status !== "running") {
          throw new Error("Only a running candidate can wait for publication.");
        }
        assertMatchingActiveLease(candidate, event.ownerId, event.token, at);
        return {
          ...candidate,
          status: "waiting_for_publication",
          lease: null,
          completedAt: null,
          lastError: expectText(event.message, "candidate publication wait", 2_000),
          updatedAt: at,
        };
      });
    case "candidate_publication_completed":
      return updateCandidate(current, event.issueId, at, (candidate) => {
        if (candidate.status !== "waiting_for_publication" || candidate.lease) {
          throw new Error(
            "Only a publication-waiting candidate without a lease can finalize.",
          );
        }
        return {
          ...candidate,
          status: "completed",
          completedAt: at,
          lastError: null,
          updatedAt: at,
        };
      });
    case "candidate_blocked":
      return updateCandidate(current, event.issueId, at, (candidate) => {
        if (candidate.status !== "running") {
          throw new Error("Only a running candidate can become blocked.");
        }
        assertMatchingActiveLease(candidate, event.ownerId, event.token, at);
        return {
          ...candidate,
          status: "blocked",
          lease: null,
          completedAt: null,
          lastError: expectText(event.error, "candidate blocker", 2_000),
          updatedAt: at,
        };
      });
    case "candidate_failed":
      return updateCandidate(current, event.issueId, at, (candidate) => {
        if (candidate.status !== "running") {
          throw new Error("Only a running candidate can record execution failure.");
        }
        assertMatchingActiveLease(candidate, event.ownerId, event.token, at);
        return {
          ...candidate,
          status: event.retryable ? "eligible" : "failed",
          lease: null,
          completedAt: null,
          lastError: expectText(event.error, "candidate failure", 2_000),
          updatedAt: at,
        };
      });
    case "cursor_advanced": {
      const cursor = parseCursor(event.cursor);
      if (current.cursor && compareLinearQueueCursors(cursor, current.cursor) < 0) {
        throw new Error("Linear queue cursor must not move backwards.");
      }
      return nextState(current, { ...current, cursor }, at);
    }
  }
}

export function upsertLinearQueueCandidate(
  state: LinearQueueStateV1,
  input: {
    at: string;
    issueId: string;
    identifier: string;
    remoteUpdatedAt: string;
    remoteStateId?: string;
    workItem: ParsedCompatibleWorkItemSpec;
  },
): LinearQueueStateV1 {
  return reduceLinearQueue(state, {
    type: "candidate_upserted",
    expectedRevision: state.revision,
    ...input,
  });
}

export function recordCandidateEligibility(
  state: LinearQueueStateV1,
  issueId: string,
  eligibility: CandidateEligibilityV1,
): LinearQueueStateV1 {
  return reduceLinearQueue(state, {
    type: "candidate_evaluated",
    expectedRevision: state.revision,
    at: eligibility.evaluatedAt,
    issueId,
    eligibility,
  });
}

export function advanceLinearQueueCursor(
  state: LinearQueueStateV1,
  cursor: LinearQueueCursorV1,
  at: string,
): LinearQueueStateV1 {
  return reduceLinearQueue(state, {
    type: "cursor_advanced",
    expectedRevision: state.revision,
    at,
    cursor,
  });
}

export function compareLinearQueueCursors(
  left: LinearQueueCursorV1,
  right: LinearQueueCursorV1,
): number {
  const leftCursor = parseCursor(left);
  const rightCursor = parseCursor(right);
  const timeDifference = Date.parse(leftCursor.updatedAt) - Date.parse(rightCursor.updatedAt);
  return timeDifference || leftCursor.issueId.localeCompare(rightCursor.issueId);
}

export function acquireLinearQueueLease(
  state: LinearQueueStateV1,
  input: { issueId: string; ownerId: string; at: string; leaseMs: number },
): LinearQueueLeaseResult {
  const candidate = state.candidates[input.issueId];
  if (!candidate) {
    return { accepted: false, reason: "missing", state };
  }
  if (!candidate.eligibility?.eligible) {
    return { accepted: false, reason: "ineligible", state };
  }
  if (
    candidate.status === "blocked" ||
    candidate.status === "waiting_for_publication" ||
    candidate.status === "completed" ||
    candidate.status === "failed"
  ) {
    return { accepted: false, reason: "terminal", state };
  }
  const at = expectMonotonicTimestamp(input.at, state.updatedAt);
  if (isLeaseActive(candidate.lease, at)) {
    return { accepted: false, reason: "leased", state };
  }
  const leaseMs = expectInteger(input.leaseMs, "candidate lease duration", 1_000, 86_400_000);
  const ownerId = expectIdentifier(input.ownerId, "candidate lease owner id");
  const lease: LinearQueueLeaseV1 = {
    ownerId,
    token: fingerprintCanonicalJson({
      kind: "linear-queue-lease",
      issueId: candidate.issueId,
      ownerId,
      at,
      revision: state.revision + 1,
    }),
    acquiredAt: at,
    expiresAt: new Date(Date.parse(at) + leaseMs).toISOString(),
  };
  return {
    accepted: true,
    lease,
    state: reduceLinearQueue(state, {
      type: "lease_acquired",
      expectedRevision: state.revision,
      at,
      issueId: candidate.issueId,
      lease,
    }),
  };
}

export function selectNextEligibleCandidate(
  state: LinearQueueStateV1,
  input: { at: string; repositoryKey?: string },
): LinearQueueCandidateV1 | undefined {
  const current = normalizeLinearQueueState(state);
  const at = expectIsoTimestamp(input.at, "candidate selection time");
  return Object.values(current.candidates)
    .filter((candidate) => {
      if (!candidate.eligibility?.eligible) {
        return false;
      }
      if (candidate.status !== "eligible" && candidate.status !== "running") {
        return false;
      }
      if (isLeaseActive(candidate.lease, at)) {
        return false;
      }
      return !input.repositoryKey || candidate.workItem.repositoryKey === input.repositoryKey;
    })
    .sort(
      (left, right) =>
        riskRank(left.workItem.riskClass) - riskRank(right.workItem.riskClass) ||
        left.workItem.generation - right.workItem.generation ||
        left.remoteUpdatedAt.localeCompare(right.remoteUpdatedAt) ||
        left.issueId.localeCompare(right.issueId),
    )[0];
}

export function isLinearQueueLeaseActive(
  lease: LinearQueueLeaseV1 | null,
  at: string,
): lease is LinearQueueLeaseV1 {
  return isLeaseActive(lease, at);
}

function applyCandidateUpsert(
  current: LinearQueueStateV1,
  event: Extract<LinearQueueEventV1, { type: "candidate_upserted" }>,
  at: string,
): LinearQueueStateV1 {
  const issueId = expectIdentifier(event.issueId, "Linear issue id");
  const identifier = expectIssueIdentifier(event.identifier);
  const remoteUpdatedAt = expectIsoTimestamp(event.remoteUpdatedAt, "Linear issue update time");
  const workItem = parseCompatibleWorkItemSpec(event.workItem);
  const existing = current.candidates[issueId];
  if (existing && Date.parse(remoteUpdatedAt) < Date.parse(existing.remoteUpdatedAt)) {
    throw new Error("Linear candidate update would regress its remote timestamp.");
  }
  if (
    existing &&
    remoteUpdatedAt === existing.remoteUpdatedAt &&
    workItem.fingerprint !== existing.workItem.fingerprint
  ) {
    throw new Error("Linear candidate changed without a newer remote timestamp.");
  }

  const contractChanged = Boolean(
    existing && workItem.fingerprint !== existing.workItem.fingerprint,
  );
  const candidate: LinearQueueCandidateV1 = existing
    ? {
        ...existing,
        identifier,
        remoteUpdatedAt,
        ...(event.remoteStateId ? { remoteStateId: expectIdentifier(event.remoteStateId, "Linear state id") } : {}),
        workItem,
        ...(contractChanged
          ? {
              status: "pending" as const,
              eligibility: null,
              lease: null,
              lastError: null,
              completedAt: null,
            }
          : {}),
        updatedAt: at,
      }
    : {
        issueId,
        identifier,
        remoteUpdatedAt,
        ...(event.remoteStateId ? { remoteStateId: expectIdentifier(event.remoteStateId, "Linear state id") } : {}),
        workItem,
        status: "pending",
        eligibility: null,
        lease: null,
        attemptCount: 0,
        lastError: null,
        completedAt: null,
        createdAt: at,
        updatedAt: at,
      };
  return nextState(
    current,
    {
      ...current,
      candidates: { ...current.candidates, [issueId]: candidate },
    },
    at,
  );
}

function updateCandidate(
  current: LinearQueueStateV1,
  issueIdValue: string,
  at: string,
  update: (candidate: LinearQueueCandidateV1) => LinearQueueCandidateV1,
): LinearQueueStateV1 {
  const issueId = expectIdentifier(issueIdValue, "Linear issue id");
  const candidate = current.candidates[issueId];
  if (!candidate) {
    throw new Error(`Linear queue candidate ${issueId} does not exist.`);
  }
  return nextState(
    current,
    {
      ...current,
      candidates: {
        ...current.candidates,
        [issueId]: update(candidate),
      },
    },
    at,
  );
}

function nextState(
  current: LinearQueueStateV1,
  next: LinearQueueStateV1,
  at: string,
): LinearQueueStateV1 {
  return {
    ...next,
    schemaVersion: LINEAR_QUEUE_SCHEMA_VERSION,
    revision: current.revision + 1,
    updatedAt: at,
  };
}

function parseCandidate(value: unknown): LinearQueueCandidateV1 {
  const record = expectRecord(value, "Linear queue candidate");
  assertExactKeys(record, [
    "issueId",
    "identifier",
    "remoteUpdatedAt",
    ...(record.remoteStateId === undefined ? [] : ["remoteStateId"]),
    "workItem",
    "status",
    "eligibility",
    "lease",
    "attemptCount",
    "lastError",
    "completedAt",
    "createdAt",
    "updatedAt",
  ]);
  const status = expectStatus(record.status);
  const eligibility = record.eligibility === null ? null : parseEligibility(record.eligibility);
  const lease = record.lease === null ? null : parseLease(record.lease);
  const completedAt = record.completedAt === null
    ? null
    : expectIsoTimestamp(record.completedAt, "candidate completion time");
  const lastError = record.lastError === null
    ? null
    : expectText(record.lastError, "candidate error", 2_000);
  if (status === "eligible" && !eligibility?.eligible) {
    throw new Error("Eligible queue candidate lacks a successful eligibility decision.");
  }
  if (status === "blocked" && !eligibility) {
    throw new Error("Blocked queue candidate lacks an eligibility decision.");
  }
  if (status === "blocked" && eligibility?.eligible && !lastError) {
    throw new Error("Execution-blocked queue candidate lacks a blocker explanation.");
  }
  if (status === "running" && !lease) {
    throw new Error("Running queue candidate lacks a lease.");
  }
  if (
    status === "waiting_for_publication" &&
    (!eligibility?.eligible || lease || completedAt || !lastError)
  ) {
    throw new Error(
      "Publication-waiting queue candidate lacks its durable wait state.",
    );
  }
  if (status === "completed" && !completedAt) {
    throw new Error("Completed queue candidate lacks a completion time.");
  }
  return {
    issueId: expectIdentifier(record.issueId, "Linear issue id"),
    identifier: expectIssueIdentifier(record.identifier),
    remoteUpdatedAt: expectIsoTimestamp(record.remoteUpdatedAt, "Linear issue update time"),
    ...(record.remoteStateId === undefined
      ? {}
      : { remoteStateId: expectIdentifier(record.remoteStateId, "Linear state id") }),
    workItem: parseCompatibleWorkItemSpec(record.workItem),
    status,
    eligibility,
    lease,
    attemptCount: expectInteger(record.attemptCount, "candidate attempt count", 0, 10_000),
    lastError,
    completedAt,
    createdAt: expectIsoTimestamp(record.createdAt, "candidate creation time"),
    updatedAt: expectIsoTimestamp(record.updatedAt, "candidate update time"),
  };
}

function parseEligibility(value: unknown): CandidateEligibilityV1 {
  const record = expectRecord(value, "candidate eligibility");
  assertExactKeys(record, [
    "eligible",
    "reasons",
    "repositoryKey",
    "policyFingerprint",
    "evaluatedAt",
  ]);
  if (typeof record.eligible !== "boolean" || !Array.isArray(record.reasons)) {
    throw new Error("Candidate eligibility flags or reasons are invalid.");
  }
  const allowedReasons: CandidateIneligibilityReason[] = [
    "queue_disabled",
    "invalid_work_item",
    "work_item_not_ready",
    "execution_class_not_allowed",
    "risk_not_allowed",
    "generation_exceeded",
    "missing_repository",
    "missing_trusted_binding",
    "repository_not_allowed",
    "unknown_repository",
    "missing_acceptance_criteria",
    "missing_validation_requirements",
    "missing_evidence",
  ];
  const reasons = record.reasons.map((reason) => {
    if (typeof reason !== "string" || !allowedReasons.includes(reason as CandidateIneligibilityReason)) {
      throw new Error("Candidate eligibility contains an unknown reason.");
    }
    return reason as CandidateIneligibilityReason;
  });
  if (new Set(reasons).size !== reasons.length || record.eligible === (reasons.length > 0)) {
    throw new Error("Candidate eligibility decision and reasons are inconsistent.");
  }
  return {
    eligible: record.eligible,
    reasons,
    repositoryKey: record.repositoryKey === null
      ? null
      : expectIdentifier(record.repositoryKey, "eligibility repository key"),
    policyFingerprint: expectToken(record.policyFingerprint, "eligibility policy fingerprint"),
    evaluatedAt: expectIsoTimestamp(record.evaluatedAt, "eligibility evaluation time"),
  };
}

function parseCursor(value: unknown): LinearQueueCursorV1 {
  const record = expectRecord(value, "Linear queue cursor");
  assertExactKeys(record, ["updatedAt", "issueId"]);
  return {
    updatedAt: expectIsoTimestamp(record.updatedAt, "cursor update time"),
    issueId: expectIdentifier(record.issueId, "cursor issue id"),
  };
}

function parseLease(value: unknown): LinearQueueLeaseV1 {
  const record = expectRecord(value, "Linear queue lease");
  assertExactKeys(record, ["ownerId", "token", "acquiredAt", "expiresAt"]);
  const acquiredAt = expectIsoTimestamp(record.acquiredAt, "candidate lease acquisition time");
  const expiresAt = expectIsoTimestamp(record.expiresAt, "candidate lease expiry time");
  if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) {
    throw new Error("Candidate lease expiry must follow its acquisition time.");
  }
  return {
    ownerId: expectIdentifier(record.ownerId, "candidate lease owner id"),
    token: expectToken(record.token, "candidate lease token"),
    acquiredAt,
    expiresAt,
  };
}

function assertMatchingLease(
  candidate: LinearQueueCandidateV1,
  ownerId: string,
  token: string,
): void {
  const expectedOwner = expectIdentifier(ownerId, "candidate lease owner id");
  const expectedToken = expectToken(token, "candidate lease token");
  if (
    !candidate.lease ||
    candidate.lease.ownerId !== expectedOwner ||
    candidate.lease.token !== expectedToken
  ) {
    throw new Error("Candidate lease owner or token does not match.");
  }
}

function assertMatchingActiveLease(
  candidate: LinearQueueCandidateV1,
  ownerId: string,
  token: string,
  at: string,
): void {
  assertMatchingLease(candidate, ownerId, token);
  if (!isLeaseActive(candidate.lease, at)) {
    throw new Error("Candidate lease has expired.");
  }
}

function isLeaseActive(
  lease: LinearQueueLeaseV1 | null,
  at: string,
): lease is LinearQueueLeaseV1 {
  return Boolean(lease && Date.parse(lease.expiresAt) > Date.parse(at));
}

function riskRank(value: WorkItemRiskClass): number {
  return { low: 0, medium: 1, high: 2 }[value];
}

function expectStatus(value: unknown): LinearQueueCandidateStatus {
  const statuses: LinearQueueCandidateStatus[] = [
    "pending",
    "eligible",
    "running",
    "waiting_for_publication",
    "blocked",
    "completed",
    "failed",
  ];
  if (typeof value !== "string" || !statuses.includes(value as LinearQueueCandidateStatus)) {
    throw new Error("Linear queue candidate status is invalid.");
  }
  return value as LinearQueueCandidateStatus;
}

function expectIssueIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,9}$/.test(value)) {
    throw new Error("Linear issue identifier is invalid.");
  }
  return value;
}

function expectToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 fingerprint.`);
  }
  return value;
}

function expectIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value) ||
    value === "__proto__" ||
    value === "prototype" ||
    value === "constructor"
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function expectText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new Error(`${label} is empty or too long.`);
  }
  return normalized;
}

function expectInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function expectMonotonicTimestamp(value: unknown, previous: string): string {
  const at = expectIsoTimestamp(value, "queue event time");
  if (Date.parse(at) < Date.parse(previous)) {
    throw new Error("Linear queue event time must not move backwards.");
  }
  return at;
}

function expectIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Linear queue state keys are invalid (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
}
