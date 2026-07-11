import {
  canonicalJson,
  verifyPreparedActionFingerprint,
  type JsonValue,
  type PreparedAction,
  type PreparedActionPreview,
} from "../../agent/actions";
import type { AuthorityGrantV1 } from "../../agent/authority";
import {
  assertKeys,
  assertMonotonicTimestamp,
  assertNoCredentialKeys,
  assertNoCredentialMaterial,
  cloneSerializable,
  expectFingerprint,
  expectIdentifier,
  expectIsoTimestamp,
  expectJsonRecord,
  expectRecord,
  expectSafeInteger,
  expectText,
  parseResourceRef,
} from "./linearDurabilityValidation";

export const PENDING_LINEAR_RECONCILIATION_SCHEMA_VERSION = 1 as const;
export const MAX_PENDING_LINEAR_RECONCILIATIONS = 32;
export const MAX_PENDING_LINEAR_RECONCILIATION_STATE_BYTES = 4_000_000;

export type PendingLinearQueueStage =
  | "manual"
  | "ticket_publish"
  | "claim_comment"
  | "started_state"
  | "result_comment"
  | "completed_state"
  | "blocked_state";

export type PendingLinearReconciliationOutcome =
  | "committed"
  | "not_applied"
  | "still_uncertain";

export interface PendingLinearReconciliationErrorV1 {
  code: string;
  message: string;
  at: string;
}

export interface PendingLinearReconciliationEntryV1 {
  action: PreparedAction;
  grantId: string;
  issueId: string;
  queueStage: PendingLinearQueueStage;
  authoritySubject: AuthorityGrantV1["subject"];
  lastOutcome: "still_uncertain";
  lastError: PendingLinearReconciliationErrorV1 | null;
  firstUncertainAt: string;
  lastAttemptAt: string;
  updatedAt: string;
}

/** Secret-free, crash-durable host recovery state keyed by PreparedAction.id. */
export interface PendingLinearReconciliationStateV1 {
  schemaVersion: typeof PENDING_LINEAR_RECONCILIATION_SCHEMA_VERSION;
  revision: number;
  pendingByActionId: Record<string, PendingLinearReconciliationEntryV1>;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertUncertainLinearReconciliationInput {
  expectedRevision: number;
  action: PreparedAction;
  grantId: string;
  issueId: string;
  queueStage: PendingLinearQueueStage;
  authoritySubject: AuthorityGrantV1["subject"];
  at: string;
  error?: { code: string; message: string } | null;
}

export interface RecordLinearReconciliationOutcomeInput {
  expectedRevision: number;
  actionId: string;
  outcome: PendingLinearReconciliationOutcome;
  at: string;
  error?: { code: string; message: string } | null;
}

const QUEUE_STAGES = new Set<PendingLinearQueueStage>([
  "manual",
  "ticket_publish",
  "claim_comment",
  "started_state",
  "result_comment",
  "completed_state",
  "blocked_state",
]);

export function createPendingLinearReconciliationState(
  now = new Date(),
): PendingLinearReconciliationStateV1 {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Pending Linear reconciliation creation time is invalid.");
  }
  const at = now.toISOString();
  return {
    schemaVersion: PENDING_LINEAR_RECONCILIATION_SCHEMA_VERSION,
    revision: 0,
    pendingByActionId: {},
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Strictly parses persisted state and re-computes every prepared-action hash.
 * The async boundary is intentional: browser-safe SHA-256 uses SubtleCrypto.
 */
export async function parsePendingLinearReconciliationState(
  value: unknown,
): Promise<PendingLinearReconciliationStateV1> {
  assertSerializedBound(value, MAX_PENDING_LINEAR_RECONCILIATION_STATE_BYTES);
  const record = expectRecord(value, "Pending Linear reconciliation state");
  assertKeys(
    record,
    ["schemaVersion", "revision", "pendingByActionId", "createdAt", "updatedAt"],
    [],
    "Pending Linear reconciliation state",
  );
  if (record.schemaVersion !== PENDING_LINEAR_RECONCILIATION_SCHEMA_VERSION) {
    throw new Error("Unsupported pending Linear reconciliation schema version.");
  }
  const createdAt = expectIsoTimestamp(record.createdAt, "state creation time");
  const updatedAt = expectIsoTimestamp(record.updatedAt, "state update time");
  assertMonotonicTimestamp(updatedAt, createdAt, "State update time");
  const source = expectRecord(record.pendingByActionId, "pendingByActionId");
  const actionIds = Object.keys(source);
  if (actionIds.length > MAX_PENDING_LINEAR_RECONCILIATIONS) {
    throw new Error(
      `Pending Linear reconciliation state exceeds ${MAX_PENDING_LINEAR_RECONCILIATIONS} entries.`,
    );
  }
  const pendingByActionId: Record<string, PendingLinearReconciliationEntryV1> = {};
  for (const actionId of actionIds.sort()) {
    expectIdentifier(actionId, "Pending reconciliation action key");
    const entry = await parsePendingEntry(source[actionId], actionId);
    if (
      Date.parse(entry.firstUncertainAt) < Date.parse(createdAt) ||
      Date.parse(entry.updatedAt) > Date.parse(updatedAt)
    ) {
      throw new Error("Pending reconciliation entry time falls outside the state lifetime.");
    }
    pendingByActionId[actionId] = entry;
  }
  return {
    schemaVersion: PENDING_LINEAR_RECONCILIATION_SCHEMA_VERSION,
    revision: expectSafeInteger(record.revision, "State revision", 0, Number.MAX_SAFE_INTEGER),
    pendingByActionId,
    createdAt,
    updatedAt,
  };
}

export async function normalizePendingLinearReconciliationState(
  value: unknown,
): Promise<PendingLinearReconciliationStateV1 | null> {
  try {
    return await parsePendingLinearReconciliationState(value);
  } catch {
    return null;
  }
}

export async function upsertUncertainLinearReconciliation(
  state: PendingLinearReconciliationStateV1,
  input: UpsertUncertainLinearReconciliationInput,
): Promise<PendingLinearReconciliationStateV1> {
  const current = await parsePendingLinearReconciliationState(state);
  assertExpectedRevision(current.revision, input.expectedRevision);
  const action = await parsePreparedLinearAction(input.action);
  const at = expectIsoTimestamp(input.at, "Uncertain mutation time");
  assertMonotonicTimestamp(at, current.updatedAt, "Uncertain mutation time");
  assertMonotonicTimestamp(at, action.preparedAt, "Uncertain mutation time");
  const grantId = expectIdentifier(input.grantId, "Authority grant id");
  const issueId = expectIdentifier(input.issueId, "Linear issue id");
  const queueStage = parseQueueStage(input.queueStage);
  const authoritySubject = parseAuthoritySubject(input.authoritySubject);
  const previous = current.pendingByActionId[action.id];
  const lastError = input.error === undefined
    ? previous?.lastError ?? null
    : parseInputError(input.error, at);
  if (!previous && Object.keys(current.pendingByActionId).length >= MAX_PENDING_LINEAR_RECONCILIATIONS) {
    throw new Error("Pending Linear reconciliation entry limit reached.");
  }
  if (previous) {
    assertSamePendingIdentity(previous, {
      action,
      grantId,
      issueId,
      queueStage,
      authoritySubject,
    });
  }
  const entry: PendingLinearReconciliationEntryV1 = {
    action,
    grantId,
    issueId,
    queueStage,
    authoritySubject,
    lastOutcome: "still_uncertain",
    lastError,
    firstUncertainAt: previous?.firstUncertainAt ?? at,
    lastAttemptAt: at,
    updatedAt: at,
  };
  return parsePendingLinearReconciliationState({
    ...current,
    revision: current.revision + 1,
    pendingByActionId: {
      ...current.pendingByActionId,
      [action.id]: entry,
    },
    updatedAt: at,
  });
}

/**
 * Terminal readback outcomes remove the pending record. An uncertain readback
 * can only update and retain it, preventing a crash-recovery record from being
 * cleared without provider proof.
 */
export async function recordLinearReconciliationOutcome(
  state: PendingLinearReconciliationStateV1,
  input: RecordLinearReconciliationOutcomeInput,
): Promise<PendingLinearReconciliationStateV1> {
  const current = await parsePendingLinearReconciliationState(state);
  assertExpectedRevision(current.revision, input.expectedRevision);
  const actionId = expectIdentifier(input.actionId, "Pending reconciliation action id");
  const entry = current.pendingByActionId[actionId];
  if (!entry) {
    throw new Error(`Pending Linear reconciliation ${actionId} was not found.`);
  }
  const at = expectIsoTimestamp(input.at, "Reconciliation outcome time");
  assertMonotonicTimestamp(at, current.updatedAt, "Reconciliation outcome time");
  const outcome = parseOutcome(input.outcome);
  if (outcome === "still_uncertain") {
    const lastError = input.error === undefined
      ? entry.lastError
      : parseInputError(input.error, at);
    return parsePendingLinearReconciliationState({
      ...current,
      revision: current.revision + 1,
      pendingByActionId: {
        ...current.pendingByActionId,
        [actionId]: {
          ...entry,
          lastOutcome: "still_uncertain",
          lastError,
          lastAttemptAt: at,
          updatedAt: at,
        },
      },
      updatedAt: at,
    });
  }
  if (input.error !== undefined && input.error !== null) {
    throw new Error("A terminal reconciliation outcome may not persist an error.");
  }
  const pendingByActionId = { ...current.pendingByActionId };
  delete pendingByActionId[actionId];
  return parsePendingLinearReconciliationState({
    ...current,
    revision: current.revision + 1,
    pendingByActionId,
    updatedAt: at,
  });
}

async function parsePendingEntry(
  value: unknown,
  actionId: string,
): Promise<PendingLinearReconciliationEntryV1> {
  const record = expectRecord(value, `Pending reconciliation ${actionId}`);
  assertKeys(
    record,
    [
      "action",
      "grantId",
      "issueId",
      "queueStage",
      "authoritySubject",
      "lastOutcome",
      "lastError",
      "firstUncertainAt",
      "lastAttemptAt",
      "updatedAt",
    ],
    [],
    `Pending reconciliation ${actionId}`,
  );
  const action = await parsePreparedLinearAction(record.action);
  if (action.id !== actionId) {
    throw new Error("Pending reconciliation map key does not match PreparedAction.id.");
  }
  if (record.lastOutcome !== "still_uncertain") {
    throw new Error("Only still-uncertain outcomes may remain pending.");
  }
  const firstUncertainAt = expectIsoTimestamp(
    record.firstUncertainAt,
    "First uncertain time",
  );
  const lastAttemptAt = expectIsoTimestamp(record.lastAttemptAt, "Last attempt time");
  const updatedAt = expectIsoTimestamp(record.updatedAt, "Entry update time");
  assertMonotonicTimestamp(firstUncertainAt, action.preparedAt, "First uncertain time");
  assertMonotonicTimestamp(lastAttemptAt, firstUncertainAt, "Last attempt time");
  assertMonotonicTimestamp(updatedAt, lastAttemptAt, "Entry update time");
  const lastError = parseStoredError(record.lastError);
  if (
    lastError &&
    (Date.parse(lastError.at) < Date.parse(firstUncertainAt) ||
      Date.parse(lastError.at) > Date.parse(updatedAt))
  ) {
    throw new Error("Pending reconciliation error falls outside its entry lifetime.");
  }
  return {
    action,
    grantId: expectIdentifier(record.grantId, "Authority grant id"),
    issueId: expectIdentifier(record.issueId, "Linear issue id"),
    queueStage: parseQueueStage(record.queueStage),
    authoritySubject: parseAuthoritySubject(record.authoritySubject),
    lastOutcome: "still_uncertain",
    lastError,
    firstUncertainAt,
    lastAttemptAt,
    updatedAt,
  };
}

async function parsePreparedLinearAction(value: unknown): Promise<PreparedAction> {
  const record = expectRecord(value, "Prepared Linear action");
  assertKeys(
    record,
    [
      "version",
      "id",
      "runId",
      "toolCallId",
      "toolName",
      "target",
      "relatedResources",
      "normalizedArgs",
      "preview",
      "payloadFingerprint",
      "preparedAt",
      "expiresAt",
    ],
    [
      "expectedTargetRevision",
      "idempotencyKey",
      "reconciliationKey",
    ],
    "Prepared Linear action",
  );
  if (record.version !== 1) {
    throw new Error("Prepared Linear action version must be 1.");
  }
  const toolName = expectIdentifier(record.toolName, "Prepared action tool name");
  if (!toolName.startsWith("linear_")) {
    throw new Error("Pending host reconciliation only accepts fixed Linear tools.");
  }
  if (!Array.isArray(record.relatedResources) || record.relatedResources.length > 32) {
    throw new Error("Prepared Linear action related resources exceed 32 entries.");
  }
  const normalizedArgs = expectJsonRecord(
    record.normalizedArgs,
    "Prepared action normalized arguments",
  );
  assertNoCredentialKeys(normalizedArgs, "Prepared action normalized arguments");
  assertNoCredentialMaterial(normalizedArgs, "Prepared action normalized arguments");
  const preparedAt = expectIsoTimestamp(record.preparedAt, "Prepared action time");
  const expiresAt = expectIsoTimestamp(record.expiresAt, "Prepared action expiry");
  assertMonotonicTimestamp(expiresAt, preparedAt, "Prepared action expiry");
  const action: PreparedAction = {
    version: 1,
    id: expectIdentifier(record.id, "Prepared action id"),
    runId: expectIdentifier(record.runId, "Prepared action run id"),
    toolCallId: expectIdentifier(record.toolCallId, "Prepared action tool-call id"),
    toolName,
    target: parseResourceRef(record.target, "Prepared action target", "linear"),
    relatedResources: record.relatedResources.map((resource, index) =>
      parseResourceRef(resource, `Prepared action related resource ${index}`, "linear")),
    normalizedArgs,
    preview: parsePreparedPreview(record.preview),
    payloadFingerprint: expectFingerprint(
      record.payloadFingerprint,
      "Prepared action payload fingerprint",
    ),
    ...(record.expectedTargetRevision !== undefined
      ? {
          expectedTargetRevision: expectText(
            record.expectedTargetRevision,
            "Expected target revision",
            512,
          ),
        }
      : {}),
    ...(record.idempotencyKey !== undefined
      ? { idempotencyKey: expectIdentifier(record.idempotencyKey, "Idempotency key", 1_024) }
      : {}),
    ...(record.reconciliationKey !== undefined
      ? {
          reconciliationKey: expectIdentifier(
            record.reconciliationKey,
            "Reconciliation key",
            1_024,
          ),
        }
      : {}),
    preparedAt,
    expiresAt,
  };
  assertSerializedBound(action, 300_000);
  if (!(await verifyPreparedActionFingerprint(action))) {
    throw new Error("Prepared Linear action fingerprint is invalid or was tampered with.");
  }
  return action;
}

function parsePreparedPreview(value: unknown): PreparedActionPreview {
  const record = expectRecord(value, "Prepared action preview");
  assertKeys(
    record,
    ["summary", "destination", "warnings", "outboundBytes"],
    ["before", "after", "outboundPayload", "duplicateCandidates"],
    "Prepared action preview",
  );
  if (!Array.isArray(record.warnings) || record.warnings.length > 20) {
    throw new Error("Prepared action preview warnings exceed 20 entries.");
  }
  if (
    record.duplicateCandidates !== undefined &&
    (!Array.isArray(record.duplicateCandidates) || record.duplicateCandidates.length > 20)
  ) {
    throw new Error("Prepared action duplicate candidates exceed 20 entries.");
  }
  const outboundPayload = record.outboundPayload === undefined
    ? undefined
    : expectJsonRecord(record.outboundPayload, "Prepared action outbound payload");
  const preview: PreparedActionPreview = {
    summary: expectText(record.summary, "Prepared action summary", 4_000),
    destination: expectText(record.destination, "Prepared action destination", 2_048),
    ...(record.before !== undefined
      ? { before: expectJsonRecord(record.before, "Prepared action before preview") }
      : {}),
    ...(record.after !== undefined
      ? { after: expectJsonRecord(record.after, "Prepared action after preview") }
      : {}),
    ...(outboundPayload ? { outboundPayload } : {}),
    ...(record.duplicateCandidates !== undefined
      ? {
          duplicateCandidates: record.duplicateCandidates.map((resource, index) =>
            parseResourceRef(resource, `Duplicate candidate ${index}`, "linear")),
        }
      : {}),
    warnings: record.warnings.map((warning, index) =>
      expectText(warning, `Prepared action warning ${index}`, 2_000)),
    outboundBytes: expectSafeInteger(
      record.outboundBytes,
      "Prepared action outbound bytes",
      0,
      1_000_000,
    ),
  };
  assertNoCredentialKeys(
    preview as unknown as JsonValue,
    "Prepared action preview",
  );
  assertNoCredentialMaterial(
    preview as unknown as JsonValue,
    "Prepared action preview",
  );
  return preview;
}

function parseAuthoritySubject(value: unknown): AuthorityGrantV1["subject"] {
  const record = expectRecord(value, "Authority subject");
  assertKeys(record, ["type", "id"], [], "Authority subject");
  if (record.type !== "run" && record.type !== "schedule") {
    throw new Error("Authority subject type must be run or schedule.");
  }
  return {
    type: record.type,
    id: expectIdentifier(record.id, "Authority subject id"),
  };
}

function parseQueueStage(value: unknown): PendingLinearQueueStage {
  if (typeof value !== "string" || !QUEUE_STAGES.has(value as PendingLinearQueueStage)) {
    throw new Error("Pending Linear queue stage is invalid.");
  }
  return value as PendingLinearQueueStage;
}

function parseOutcome(value: unknown): PendingLinearReconciliationOutcome {
  if (
    value !== "committed" &&
    value !== "not_applied" &&
    value !== "still_uncertain"
  ) {
    throw new Error("Linear reconciliation outcome is invalid.");
  }
  return value;
}

function parseInputError(
  value: { code: string; message: string } | null,
  at: string,
): PendingLinearReconciliationErrorV1 | null {
  if (value === null) return null;
  return {
    code: expectIdentifier(value.code, "Reconciliation error code"),
    message: expectText(value.message, "Reconciliation error message", 2_000),
    at,
  };
}

function parseStoredError(value: unknown): PendingLinearReconciliationErrorV1 | null {
  if (value === null) return null;
  const record = expectRecord(value, "Pending reconciliation error");
  assertKeys(record, ["code", "message", "at"], [], "Pending reconciliation error");
  return {
    code: expectIdentifier(record.code, "Reconciliation error code"),
    message: expectText(record.message, "Reconciliation error message", 2_000),
    at: expectIsoTimestamp(record.at, "Reconciliation error time"),
  };
}

function assertExpectedRevision(actual: number, expected: number): void {
  expectSafeInteger(expected, "Expected state revision", 0, Number.MAX_SAFE_INTEGER);
  if (actual !== expected) {
    throw new Error(
      `Pending Linear reconciliation revision conflict (expected ${expected}, current ${actual}).`,
    );
  }
}

function assertSamePendingIdentity(
  previous: PendingLinearReconciliationEntryV1,
  next: Pick<
    PendingLinearReconciliationEntryV1,
    "action" | "grantId" | "issueId" | "queueStage" | "authoritySubject"
  >,
): void {
  const previousIdentity = {
    action: previous.action,
    grantId: previous.grantId,
    issueId: previous.issueId,
    queueStage: previous.queueStage,
    authoritySubject: previous.authoritySubject,
  };
  if (canonicalJson(previousIdentity) !== canonicalJson(next)) {
    throw new Error("Pending Linear action id collided with different durable identity.");
  }
}

function assertSerializedBound(value: unknown, maximumBytes: number): void {
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch {
    throw new Error("Pending Linear reconciliation state must contain serializable JSON only.");
  }
  if (new TextEncoder().encode(canonical).length > maximumBytes) {
    throw new Error(`Pending Linear reconciliation data exceeds ${maximumBytes} bytes.`);
  }
}

export function clonePendingLinearReconciliationState(
  state: PendingLinearReconciliationStateV1,
): PendingLinearReconciliationStateV1 {
  return cloneSerializable(state);
}
