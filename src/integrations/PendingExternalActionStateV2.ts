import {
  assertCanonicalContract,
  assertExactKeys,
  assertSecretFree,
  constantTimeFingerprintEqual,
  DurableLinearContractError,
  expectEnum,
  expectInteger,
  expectIsoTimestamp,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
  expectString,
  fingerprintContract,
} from "./linear/LinearContractSupport";

export const PENDING_EXTERNAL_ACTION_SCHEMA_VERSION_V2 = 2 as const;

export type PendingExternalActionProviderV2 = "linear" | "github";
export type PendingExternalActionDispatchStateV2 =
  | "prepared"
  | "dispatched_uncertain"
  | "reconcile_required";

export interface PendingExternalActionErrorV2 {
  code: string;
  message: string;
}

export interface PendingExternalActionStateV2 {
  schemaVersion: typeof PENDING_EXTERNAL_ACTION_SCHEMA_VERSION_V2;
  provider: PendingExternalActionProviderV2;
  operation: string;
  actionId: string;
  resourceId: string;
  preparedActionFingerprint: string;
  targetFingerprint: string;
  dispatchState: PendingExternalActionDispatchStateV2;
  attempt: number;
  preparedAt: string;
  dispatchedAt: string | null;
  lastObservedAt: string | null;
  providerRequestId: string | null;
  error: PendingExternalActionErrorV2;
  pendingFingerprint: string;
}

export type PendingExternalActionUnsignedV2 = Omit<
  PendingExternalActionStateV2,
  "pendingFingerprint"
>;

export function createPendingExternalActionStateV2(
  value: PendingExternalActionUnsignedV2,
): PendingExternalActionStateV2 {
  const unsigned = parseUnsigned(value);
  return {
    ...unsigned,
    pendingFingerprint: fingerprintContract(unsigned),
  };
}

export function parsePendingExternalActionStateV2(
  value: unknown,
): PendingExternalActionStateV2 {
  const record = expectPlainRecord(value, "pending external action");
  assertKeys(record, true);
  const { pendingFingerprint: rawFingerprint, ...rawUnsigned } = record;
  const unsigned = parseUnsigned(rawUnsigned);
  assertCanonicalContract(rawUnsigned, unsigned, "Pending external action");
  const pendingFingerprint = expectSha256(
    rawFingerprint,
    "pending external action fingerprint",
  );
  const expected = fingerprintContract(unsigned);
  if (!constantTimeFingerprintEqual(pendingFingerprint, expected)) {
    throw new DurableLinearContractError(
      "Pending external action fingerprint does not match its canonical payload.",
    );
  }
  return { ...unsigned, pendingFingerprint };
}

function parseUnsigned(value: unknown): PendingExternalActionUnsignedV2 {
  const record = expectPlainRecord(value, "pending external action");
  assertKeys(record, false);
  if (record.schemaVersion !== PENDING_EXTERNAL_ACTION_SCHEMA_VERSION_V2) {
    throw new DurableLinearContractError(
      "Unsupported pending external action schema version.",
    );
  }
  const provider = expectEnum<PendingExternalActionProviderV2>(
    record.provider,
    "pending external action provider",
    ["linear", "github"],
  );
  const operation = expectString(
    record.operation,
    "pending external action operation",
    1,
    120,
  );
  if (!/^[a-z][a-z0-9_]*$/u.test(operation)) {
    throw new DurableLinearContractError(
      "Pending external action operation must be a fixed catalog identifier.",
    );
  }
  const dispatchState = expectEnum<PendingExternalActionDispatchStateV2>(
    record.dispatchState,
    "pending external action dispatch state",
    ["prepared", "dispatched_uncertain", "reconcile_required"],
  );
  const preparedAt = expectIsoTimestamp(
    record.preparedAt,
    "pending external action prepared time",
  );
  const dispatchedAt = nullableTimestamp(
    record.dispatchedAt,
    "pending external action dispatch time",
  );
  const lastObservedAt = nullableTimestamp(
    record.lastObservedAt,
    "pending external action observation time",
  );
  if (dispatchState === "prepared" && dispatchedAt !== null) {
    throw new DurableLinearContractError(
      "A prepared external action cannot claim it was dispatched.",
    );
  }
  if (dispatchState !== "prepared" && dispatchedAt === null) {
    throw new DurableLinearContractError(
      "An uncertain external action requires its dispatch timestamp.",
    );
  }
  if (dispatchedAt && Date.parse(dispatchedAt) < Date.parse(preparedAt)) {
    throw new DurableLinearContractError(
      "Pending external action dispatch time cannot precede preparation.",
    );
  }
  if (
    lastObservedAt &&
    Date.parse(lastObservedAt) < Date.parse(dispatchedAt ?? preparedAt)
  ) {
    throw new DurableLinearContractError(
      "Pending external action observation cannot precede dispatch or preparation.",
    );
  }
  const errorRecord = expectPlainRecord(
    record.error,
    "pending external action error",
  );
  assertExactKeys(
    errorRecord,
    ["code", "message"],
    [],
    "pending external action error",
  );
  const code = expectOpaqueId(errorRecord.code, "pending external action error code", 120);
  const message = expectString(
    errorRecord.message,
    "pending external action error message",
    1,
    1_000,
    { allowNewlines: true },
  );
  assertSecretFree(message, "pending external action error message");
  return {
    schemaVersion: PENDING_EXTERNAL_ACTION_SCHEMA_VERSION_V2,
    provider,
    operation,
    actionId: expectOpaqueId(record.actionId, "pending external action id"),
    resourceId: expectOpaqueId(record.resourceId, "pending external resource id", 300),
    preparedActionFingerprint: expectSha256(
      record.preparedActionFingerprint,
      "prepared external action fingerprint",
    ),
    targetFingerprint: expectSha256(
      record.targetFingerprint,
      "pending external action target fingerprint",
    ),
    dispatchState,
    attempt: expectInteger(record.attempt, "pending external action attempt", 1, 3),
    preparedAt,
    dispatchedAt,
    lastObservedAt,
    providerRequestId:
      record.providerRequestId === null
        ? null
        : expectOpaqueId(
            record.providerRequestId,
            "pending external action provider request id",
            200,
          ),
    error: { code, message },
  };
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : expectIsoTimestamp(value, label);
}

function assertKeys(
  record: Record<string, unknown>,
  signed: boolean,
): void {
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "provider",
      "operation",
      "actionId",
      "resourceId",
      "preparedActionFingerprint",
      "targetFingerprint",
      "dispatchState",
      "attempt",
      "preparedAt",
      "dispatchedAt",
      "lastObservedAt",
      "providerRequestId",
      "error",
      ...(signed ? ["pendingFingerprint"] : []),
    ],
    [],
    "pending external action",
  );
}
