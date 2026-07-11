import {
  canonicalJson,
  type ActionReceipt,
  type JsonValue,
} from "../../agent/actions";
import {
  RESOURCE_ACTIONS,
  assertKeys,
  assertMonotonicTimestamp,
  assertNoCredentialMaterial,
  cloneSerializable,
  expectFingerprint,
  expectIdentifier,
  expectIsoTimestamp,
  expectRecord,
  expectSafeInteger,
  expectText,
  parseResourceRef,
} from "./linearDurabilityValidation";

export const EXTERNAL_ACTION_RECEIPT_LEDGER_SCHEMA_VERSION = 1 as const;
export const MAX_EXTERNAL_ACTION_RECEIPTS = 256;
export const EXTERNAL_ACTION_PROOF_KIND = "external_action" as const;
const MAX_EXTERNAL_ACTION_LEDGER_BYTES = 8_000_000;

export interface VerifiedExternalActionReceiptEntryV1 {
  /** Derived by the host; callers cannot select or upgrade this proof kind. */
  proofKind: typeof EXTERNAL_ACTION_PROOF_KIND;
  receipt: ActionReceipt;
  recordedAt: string;
}

/** A bounded, secret-free Run Details/restart history for host-verified receipts. */
export interface ExternalActionReceiptLedgerStateV1 {
  schemaVersion: typeof EXTERNAL_ACTION_RECEIPT_LEDGER_SCHEMA_VERSION;
  revision: number;
  entries: VerifiedExternalActionReceiptEntryV1[];
  createdAt: string;
  updatedAt: string;
}

export function createExternalActionReceiptLedgerState(
  now = new Date(),
): ExternalActionReceiptLedgerStateV1 {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("External action receipt ledger creation time is invalid.");
  }
  const at = now.toISOString();
  return {
    schemaVersion: EXTERNAL_ACTION_RECEIPT_LEDGER_SCHEMA_VERSION,
    revision: 0,
    entries: [],
    createdAt: at,
    updatedAt: at,
  };
}

export function parseExternalActionReceiptLedgerState(
  value: unknown,
): ExternalActionReceiptLedgerStateV1 {
  assertSerializedBound(value);
  const record = expectRecord(value, "External action receipt ledger");
  assertKeys(
    record,
    ["schemaVersion", "revision", "entries", "createdAt", "updatedAt"],
    [],
    "External action receipt ledger",
  );
  if (record.schemaVersion !== EXTERNAL_ACTION_RECEIPT_LEDGER_SCHEMA_VERSION) {
    throw new Error("Unsupported external action receipt ledger schema version.");
  }
  if (!Array.isArray(record.entries) || record.entries.length > MAX_EXTERNAL_ACTION_RECEIPTS) {
    throw new Error(
      `External action receipt ledger exceeds ${MAX_EXTERNAL_ACTION_RECEIPTS} entries.`,
    );
  }
  const createdAt = expectIsoTimestamp(record.createdAt, "Ledger creation time");
  const updatedAt = expectIsoTimestamp(record.updatedAt, "Ledger update time");
  assertMonotonicTimestamp(updatedAt, createdAt, "Ledger update time");
  const entries = record.entries.map((entry, index) => parseLedgerEntry(entry, index));
  const receiptIds = entries.map((entry) => entry.receipt.id);
  if (new Set(receiptIds).size !== receiptIds.length) {
    throw new Error("External action receipt ledger contains duplicate receipt ids.");
  }
  let previousRecordedAt = createdAt;
  for (const entry of entries) {
    assertMonotonicTimestamp(entry.recordedAt, previousRecordedAt, "Receipt recording time");
    if (Date.parse(entry.recordedAt) > Date.parse(updatedAt)) {
      throw new Error("External action receipt is newer than its ledger.");
    }
    previousRecordedAt = entry.recordedAt;
  }
  return {
    schemaVersion: EXTERNAL_ACTION_RECEIPT_LEDGER_SCHEMA_VERSION,
    revision: expectSafeInteger(record.revision, "Ledger revision", 0, Number.MAX_SAFE_INTEGER),
    entries,
    createdAt,
    updatedAt,
  };
}

export function normalizeExternalActionReceiptLedgerState(
  value: unknown,
): ExternalActionReceiptLedgerStateV1 | null {
  try {
    return parseExternalActionReceiptLedgerState(value);
  } catch {
    return null;
  }
}

/**
 * Appends an already host-validated external receipt. Duplicate ids are
 * idempotent only when the canonical receipt is identical; collisions fail.
 * The oldest entry rolls off after the fixed 256-receipt bound.
 */
export function appendVerifiedExternalActionReceipt(
  state: ExternalActionReceiptLedgerStateV1,
  input: {
    expectedRevision: number;
    receipt: ActionReceipt;
    recordedAt: string;
  },
): ExternalActionReceiptLedgerStateV1 {
  const current = parseExternalActionReceiptLedgerState(state);
  assertExpectedRevision(current.revision, input.expectedRevision);
  const receipt = parseVerifiedExternalReceipt(input.receipt);
  const existing = current.entries.find((entry) => entry.receipt.id === receipt.id);
  if (existing) {
    if (canonicalJson(existing.receipt) !== canonicalJson(receipt)) {
      throw new Error("External action receipt id collided with different receipt data.");
    }
    return cloneSerializable(current);
  }
  const recordedAt = expectIsoTimestamp(input.recordedAt, "Receipt recording time");
  assertMonotonicTimestamp(recordedAt, current.updatedAt, "Receipt recording time");
  assertMonotonicTimestamp(recordedAt, receipt.committedAt, "Receipt recording time");
  const entries = [
    ...current.entries,
    {
      proofKind: EXTERNAL_ACTION_PROOF_KIND,
      receipt,
      recordedAt,
    },
  ].slice(-MAX_EXTERNAL_ACTION_RECEIPTS);
  return parseExternalActionReceiptLedgerState({
    ...current,
    revision: current.revision + 1,
    entries,
    updatedAt: recordedAt,
  });
}

function parseLedgerEntry(
  value: unknown,
  index: number,
): VerifiedExternalActionReceiptEntryV1 {
  const record = expectRecord(value, `External receipt ledger entry ${index}`);
  assertKeys(
    record,
    ["proofKind", "receipt", "recordedAt"],
    [],
    `External receipt ledger entry ${index}`,
  );
  if (record.proofKind !== EXTERNAL_ACTION_PROOF_KIND) {
    throw new Error("External receipt proof kind must be host-derived external_action.");
  }
  const receipt = parseVerifiedExternalReceipt(record.receipt);
  const recordedAt = expectIsoTimestamp(record.recordedAt, "Receipt recording time");
  assertMonotonicTimestamp(recordedAt, receipt.committedAt, "Receipt recording time");
  return {
    proofKind: EXTERNAL_ACTION_PROOF_KIND,
    receipt,
    recordedAt,
  };
}

function parseVerifiedExternalReceipt(value: unknown): ActionReceipt {
  const record = expectRecord(value, "External action receipt");
  assertKeys(
    record,
    [
      "version",
      "id",
      "runId",
      "actionId",
      "toolName",
      "operation",
      "resource",
      "message",
      "payloadFingerprint",
      "grantId",
      "startedAt",
      "committedAt",
      "commitKind",
      "readback",
    ],
    [
      "relatedResources",
      "idempotencyKey",
      "providerRequestId",
      "effects",
    ],
    "External action receipt",
  );
  if (record.version !== 1) {
    throw new Error("External action receipt version must be 1.");
  }
  const resource = parseResourceRef(record.resource, "Receipt resource");
  if (resource.system !== "linear" && resource.system !== "github") {
    throw new Error("Only Linear or GitHub receipts may enter the external proof ledger.");
  }
  const toolName = expectIdentifier(record.toolName, "Receipt tool name");
  if (!toolName.startsWith(`${resource.system}_`)) {
    throw new Error("External receipt tool domain does not match its resource system.");
  }
  if (
    typeof record.operation !== "string" ||
    !RESOURCE_ACTIONS.has(record.operation as ActionReceipt["operation"])
  ) {
    throw new Error("External action receipt operation is invalid.");
  }
  if (
    record.relatedResources !== undefined &&
    (!Array.isArray(record.relatedResources) || record.relatedResources.length > 32)
  ) {
    throw new Error("External action receipt related resources exceed 32 entries.");
  }
  if (record.commitKind !== "committed" && record.commitKind !== "reconciled") {
    throw new Error("External action receipt commit kind is invalid.");
  }
  const startedAt = expectIsoTimestamp(record.startedAt, "Receipt start time");
  const committedAt = expectIsoTimestamp(record.committedAt, "Receipt commit time");
  assertMonotonicTimestamp(committedAt, startedAt, "Receipt commit time");
  const readback = parseVerifiedReadback(record.readback, startedAt, committedAt);
  const message = expectText(record.message, "Receipt message", 4_000);
  const providerRequestId = record.providerRequestId !== undefined
    ? expectText(record.providerRequestId, "Receipt provider request id", 1_024)
    : undefined;
  const receipt: ActionReceipt = {
    version: 1,
    id: expectIdentifier(record.id, "Receipt id"),
    runId: expectIdentifier(record.runId, "Receipt run id"),
    actionId: expectIdentifier(record.actionId, "Receipt action id"),
    toolName,
    operation: record.operation as ActionReceipt["operation"],
    resource,
    ...(record.relatedResources !== undefined
      ? {
          relatedResources: (record.relatedResources as unknown[]).map((related, index) =>
            parseResourceRef(related, `Receipt related resource ${index}`)),
        }
      : {}),
    message,
    payloadFingerprint: expectFingerprint(
      record.payloadFingerprint,
      "Receipt payload fingerprint",
    ),
    grantId: expectIdentifier(record.grantId, "Receipt grant id"),
    ...(record.idempotencyKey !== undefined
      ? { idempotencyKey: expectIdentifier(record.idempotencyKey, "Receipt idempotency key", 1_024) }
      : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    startedAt,
    committedAt,
    commitKind: record.commitKind,
    readback,
    ...(record.effects !== undefined ? { effects: parseEffects(record.effects) } : {}),
  };
  assertNoCredentialMaterial(
    receipt as unknown as JsonValue,
    "External action receipt",
  );
  return receipt;
}

function parseVerifiedReadback(
  value: unknown,
  startedAt: string,
  committedAt: string,
): ActionReceipt["readback"] {
  const record = expectRecord(value, "Receipt readback");
  assertKeys(
    record,
    ["status", "checkedAt"],
    ["observedRevision", "observedFingerprint"],
    "Receipt readback",
  );
  if (record.status !== "verified") {
    throw new Error("External receipt ledger requires verified provider readback.");
  }
  const checkedAt = expectIsoTimestamp(record.checkedAt, "Receipt readback time");
  assertMonotonicTimestamp(checkedAt, startedAt, "Receipt readback time");
  if (Date.parse(checkedAt) > Date.parse(committedAt)) {
    throw new Error("Receipt readback time must not follow its commit time.");
  }
  return {
    status: "verified",
    checkedAt,
    ...(record.observedRevision !== undefined
      ? {
          observedRevision: expectText(
            record.observedRevision,
            "Observed resource revision",
            1_024,
          ),
        }
      : {}),
    ...(record.observedFingerprint !== undefined
      ? {
          observedFingerprint: expectFingerprint(
            record.observedFingerprint,
            "Observed resource fingerprint",
          ),
        }
      : {}),
  };
}

function parseEffects(value: unknown): NonNullable<ActionReceipt["effects"]> {
  const record = expectRecord(value, "Receipt effects");
  assertKeys(
    record,
    [],
    ["bytesWritten", "bytesDeleted", "affectedCount", "changedFields"],
    "Receipt effects",
  );
  if (Object.keys(record).length === 0) {
    throw new Error("Receipt effects may not be empty.");
  }
  if (
    record.changedFields !== undefined &&
    (!Array.isArray(record.changedFields) || record.changedFields.length > 100)
  ) {
    throw new Error("Receipt changed fields exceed 100 entries.");
  }
  return {
    ...(record.bytesWritten !== undefined
      ? {
          bytesWritten: expectSafeInteger(
            record.bytesWritten,
            "Receipt bytes written",
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        }
      : {}),
    ...(record.bytesDeleted !== undefined
      ? {
          bytesDeleted: expectSafeInteger(
            record.bytesDeleted,
            "Receipt bytes deleted",
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        }
      : {}),
    ...(record.affectedCount !== undefined
      ? {
          affectedCount: expectSafeInteger(
            record.affectedCount,
            "Receipt affected count",
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        }
      : {}),
    ...(record.changedFields !== undefined
      ? {
          changedFields: (record.changedFields as unknown[]).map((field, index) =>
            expectIdentifier(field, `Receipt changed field ${index}`, 256)),
        }
      : {}),
  };
}

function assertExpectedRevision(actual: number, expected: number): void {
  expectSafeInteger(expected, "Expected ledger revision", 0, Number.MAX_SAFE_INTEGER);
  if (actual !== expected) {
    throw new Error(
      `External action receipt ledger revision conflict (expected ${expected}, current ${actual}).`,
    );
  }
}

function assertSerializedBound(value: unknown): void {
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch {
    throw new Error("External action receipt ledger must contain serializable JSON only.");
  }
  if (new TextEncoder().encode(canonical).length > MAX_EXTERNAL_ACTION_LEDGER_BYTES) {
    throw new Error(
      `External action receipt ledger exceeds ${MAX_EXTERNAL_ACTION_LEDGER_BYTES} bytes.`,
    );
  }
}

export function cloneExternalActionReceiptLedgerState(
  state: ExternalActionReceiptLedgerStateV1,
): ExternalActionReceiptLedgerStateV1 {
  return cloneSerializable(state);
}
