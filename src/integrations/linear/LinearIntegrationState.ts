export const LINEAR_INTEGRATION_STATE_SCHEMA_VERSION = 1 as const;

export interface LinearIntegrationErrorStateV1 {
  code: string;
  message: string;
  retryable: boolean;
  at: string;
}

/** Secret-free integration metadata suitable for plugin data persistence. */
export interface LinearIntegrationStateV1 {
  schemaVersion: typeof LINEAR_INTEGRATION_STATE_SCHEMA_VERSION;
  workspaceId: string | null;
  configFingerprint: string | null;
  lastOperationId: string | null;
  lastSuccessfulSyncAt: string | null;
  lastReconciledAt: string | null;
  lastError: LinearIntegrationErrorStateV1 | null;
  createdAt: string;
  updatedAt: string;
}

export function createLinearIntegrationState(input: {
  at: string;
  workspaceId?: string;
  configFingerprint?: string;
}): LinearIntegrationStateV1 {
  const at = expectIsoTimestamp(input.at, "creation time");
  return {
    schemaVersion: LINEAR_INTEGRATION_STATE_SCHEMA_VERSION,
    workspaceId: input.workspaceId !== undefined
      ? expectIdentifier(input.workspaceId, "workspace id")
      : null,
    configFingerprint: input.configFingerprint !== undefined
      ? expectFingerprint(input.configFingerprint, "config fingerprint")
      : null,
    lastOperationId: null,
    lastSuccessfulSyncAt: null,
    lastReconciledAt: null,
    lastError: null,
    createdAt: at,
    updatedAt: at,
  };
}

export function parseLinearIntegrationState(value: unknown): LinearIntegrationStateV1 {
  const record = expectRecord(value, "Linear integration state");
  assertExactKeys(record, [
    "schemaVersion",
    "workspaceId",
    "configFingerprint",
    "lastOperationId",
    "lastSuccessfulSyncAt",
    "lastReconciledAt",
    "lastError",
    "createdAt",
    "updatedAt",
  ]);
  if (record.schemaVersion !== LINEAR_INTEGRATION_STATE_SCHEMA_VERSION) {
    throw new Error("Unsupported Linear integration state schema version.");
  }
  const createdAt = expectIsoTimestamp(record.createdAt, "creation time");
  const updatedAt = expectIsoTimestamp(record.updatedAt, "update time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("Linear integration update time precedes its creation time.");
  }
  const lastSuccessfulSyncAt = optionalNullableTimestamp(
    record.lastSuccessfulSyncAt,
    "last successful sync time",
  );
  const lastReconciledAt = optionalNullableTimestamp(
    record.lastReconciledAt,
    "last reconciliation time",
  );
  const lastError = parseError(record.lastError);
  for (const timestamp of [lastSuccessfulSyncAt, lastReconciledAt, lastError?.at ?? null]) {
    if (
      timestamp &&
      (Date.parse(timestamp) < Date.parse(createdAt) ||
        Date.parse(timestamp) > Date.parse(updatedAt))
    ) {
      throw new Error("Linear integration event time falls outside the state lifetime.");
    }
  }
  return {
    schemaVersion: LINEAR_INTEGRATION_STATE_SCHEMA_VERSION,
    workspaceId: optionalNullableIdentifier(record.workspaceId, "workspace id"),
    configFingerprint: optionalNullableFingerprint(
      record.configFingerprint,
      "config fingerprint",
    ),
    lastOperationId: optionalNullableIdentifier(record.lastOperationId, "operation id"),
    lastSuccessfulSyncAt,
    lastReconciledAt,
    lastError,
    createdAt,
    updatedAt,
  };
}

export function recordLinearIntegrationSuccess(
  state: LinearIntegrationStateV1,
  input: {
    at: string;
    workspaceId?: string;
    operationId?: string;
    reconciled?: boolean;
  },
): LinearIntegrationStateV1 {
  const current = parseLinearIntegrationState(state);
  const at = assertMonotonicTime(input.at, current.updatedAt);
  return {
    ...current,
    workspaceId: input.workspaceId !== undefined
      ? expectIdentifier(input.workspaceId, "workspace id")
      : current.workspaceId,
    lastOperationId: input.operationId !== undefined
      ? expectIdentifier(input.operationId, "operation id")
      : current.lastOperationId,
    lastSuccessfulSyncAt: at,
    lastReconciledAt: input.reconciled ? at : current.lastReconciledAt,
    lastError: null,
    updatedAt: at,
  };
}

export function recordLinearIntegrationFailure(
  state: LinearIntegrationStateV1,
  input: {
    at: string;
    code: string;
    message: string;
    retryable: boolean;
    operationId?: string;
  },
): LinearIntegrationStateV1 {
  const current = parseLinearIntegrationState(state);
  const at = assertMonotonicTime(input.at, current.updatedAt);
  if (typeof input.retryable !== "boolean") {
    throw new Error("Linear integration failure retryable must be a boolean.");
  }
  return {
    ...current,
    lastOperationId: input.operationId !== undefined
      ? expectIdentifier(input.operationId, "operation id")
      : current.lastOperationId,
    lastError: {
      code: expectIdentifier(input.code, "error code"),
      message: expectText(input.message, "error message", 2_000),
      retryable: input.retryable,
      at,
    },
    updatedAt: at,
  };
}

export function replaceLinearConfigFingerprint(
  state: LinearIntegrationStateV1,
  input: { at: string; configFingerprint: string },
): LinearIntegrationStateV1 {
  const current = parseLinearIntegrationState(state);
  const at = assertMonotonicTime(input.at, current.updatedAt);
  return {
    ...current,
    configFingerprint: expectFingerprint(input.configFingerprint, "config fingerprint"),
    updatedAt: at,
  };
}

function parseError(value: unknown): LinearIntegrationErrorStateV1 | null {
  if (value === null) {
    return null;
  }
  const record = expectRecord(value, "Linear integration error");
  assertExactKeys(record, ["code", "message", "retryable", "at"]);
  if (typeof record.retryable !== "boolean") {
    throw new Error("Linear integration error retryable must be a boolean.");
  }
  return {
    code: expectIdentifier(record.code, "error code"),
    message: expectText(record.message, "error message", 2_000),
    retryable: record.retryable,
    at: expectIsoTimestamp(record.at, "error time"),
  };
}

function optionalNullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : expectIdentifier(value, label);
}

function optionalNullableFingerprint(value: unknown, label: string): string | null {
  return value === null ? null : expectFingerprint(value, label);
}

function optionalNullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : expectIsoTimestamp(value, label);
}

function expectFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 fingerprint.`);
  }
  return value;
}

function expectIdentifier(value: unknown, label: string): string {
  const identifier = expectText(value, label, 256);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(identifier)) {
    throw new Error(`${label} contains unsupported identifier characters.`);
  }
  return identifier;
}

function expectText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is empty, too long, or contains control characters.`);
  }
  return normalized;
}

function assertMonotonicTime(value: unknown, previous: string): string {
  const at = expectIsoTimestamp(value, "event time");
  if (Date.parse(at) < Date.parse(previous)) {
    throw new Error("Linear integration event time must not move backwards.");
  }
  return at;
}

function expectIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`${label} must be an ISO timestamp.`);
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
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  const missing = keys.filter(
    (key) => !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Linear integration state keys are invalid (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
}
