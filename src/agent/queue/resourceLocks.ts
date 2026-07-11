import { fingerprintCanonicalJson } from "./fingerprint";

export const RESOURCE_LOCK_STATE_SCHEMA_VERSION = 1 as const;

export interface ResourceLockV1 {
  resourceKey: string;
  ownerId: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ResourceLockStateV1 {
  schemaVersion: typeof RESOURCE_LOCK_STATE_SCHEMA_VERSION;
  revision: number;
  locks: Record<string, ResourceLockV1>;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceLockResult {
  accepted: boolean;
  state: ResourceLockStateV1;
  token?: string;
  conflicts: string[];
}

export function createResourceLockState(at: string): ResourceLockStateV1 {
  const timestamp = expectIsoTimestamp(at, "resource lock creation time");
  return {
    schemaVersion: RESOURCE_LOCK_STATE_SCHEMA_VERSION,
    revision: 0,
    locks: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function normalizeResourceLockState(value: unknown): ResourceLockStateV1 {
  const record = expectRecord(value, "resource lock state");
  assertExactKeys(record, ["schemaVersion", "revision", "locks", "createdAt", "updatedAt"]);
  if (record.schemaVersion !== RESOURCE_LOCK_STATE_SCHEMA_VERSION) {
    throw new Error("Unsupported resource lock state schema version.");
  }
  const revision = expectInteger(record.revision, "resource lock revision", 0, Number.MAX_SAFE_INTEGER);
  const createdAt = expectIsoTimestamp(record.createdAt, "resource lock creation time");
  const updatedAt = expectIsoTimestamp(record.updatedAt, "resource lock update time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("Resource lock update time precedes creation time.");
  }
  const rawLocks = expectRecord(record.locks, "resource locks");
  const locks: Record<string, ResourceLockV1> = {};
  for (const [storedKey, rawLock] of Object.entries(rawLocks)) {
    const lock = parseResourceLock(rawLock);
    if (storedKey !== lock.resourceKey) {
      throw new Error(`Stored resource lock key ${storedKey} does not match its payload.`);
    }
    locks[storedKey] = lock;
  }
  return {
    schemaVersion: RESOURCE_LOCK_STATE_SCHEMA_VERSION,
    revision,
    locks,
    createdAt,
    updatedAt,
  };
}

export const parseResourceLockState = normalizeResourceLockState;

/** Validate and return one host-supplied canonical resource key. */
export function normalizeCanonicalResourceKey(value: unknown): string {
  return normalizeResourceKey(value);
}

/** Acquire all requested resources or none of them. */
export function acquireResourceLocks(
  state: ResourceLockStateV1,
  input: {
    resourceKeys: string[];
    ownerId: string;
    at: string;
    leaseMs: number;
  },
): ResourceLockResult {
  const current = normalizeResourceLockState(state);
  const at = expectMonotonicTimestamp(input.at, current.updatedAt);
  const resourceKeys = normalizeResourceKeys(input.resourceKeys);
  const ownerId = expectIdentifier(input.ownerId, "resource lock owner id");
  const leaseMs = expectInteger(input.leaseMs, "resource lock lease duration", 1_000, 86_400_000);
  const conflicts = resourceKeys.filter((resourceKey) =>
    isResourceLockActive(current.locks[resourceKey], at),
  );
  if (conflicts.length > 0) {
    return { accepted: false, state, conflicts };
  }

  const token = fingerprintCanonicalJson({
    kind: "resource-lock",
    ownerId,
    resourceKeys,
    at,
    revision: current.revision + 1,
  });
  const expiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
  const locks = { ...current.locks };
  for (const resourceKey of resourceKeys) {
    locks[resourceKey] = {
      resourceKey,
      ownerId,
      token,
      acquiredAt: at,
      expiresAt,
    };
  }
  return {
    accepted: true,
    token,
    conflicts: [],
    state: nextState(current, locks, at),
  };
}

export function renewResourceLocks(
  state: ResourceLockStateV1,
  input: {
    resourceKeys: string[];
    ownerId: string;
    token: string;
    at: string;
    leaseMs: number;
  },
): ResourceLockResult {
  const current = normalizeResourceLockState(state);
  const at = expectMonotonicTimestamp(input.at, current.updatedAt);
  const resourceKeys = normalizeResourceKeys(input.resourceKeys);
  const ownerId = expectIdentifier(input.ownerId, "resource lock owner id");
  const token = expectToken(input.token);
  const leaseMs = expectInteger(input.leaseMs, "resource lock lease duration", 1_000, 86_400_000);
  const conflicts = resourceKeys.filter((resourceKey) => {
    const lock = current.locks[resourceKey];
    return (
      !isResourceLockActive(lock, at) ||
      lock.ownerId !== ownerId ||
      lock.token !== token
    );
  });
  if (conflicts.length > 0) {
    return { accepted: false, state, conflicts };
  }
  const expiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
  if (
    resourceKeys.some(
      (resourceKey) =>
        Date.parse(expiresAt) <= Date.parse(current.locks[resourceKey].expiresAt),
    )
  ) {
    throw new Error("Resource lock renewal must extend every requested lease.");
  }
  const locks = { ...current.locks };
  for (const resourceKey of resourceKeys) {
    locks[resourceKey] = {
      ...locks[resourceKey],
      expiresAt,
    };
  }
  return {
    accepted: true,
    token,
    conflicts: [],
    state: nextState(current, locks, at),
  };
}

export function releaseResourceLocks(
  state: ResourceLockStateV1,
  input: {
    resourceKeys: string[];
    ownerId: string;
    token: string;
    at: string;
  },
): ResourceLockResult {
  const current = normalizeResourceLockState(state);
  const at = expectMonotonicTimestamp(input.at, current.updatedAt);
  const resourceKeys = normalizeResourceKeys(input.resourceKeys);
  const ownerId = expectIdentifier(input.ownerId, "resource lock owner id");
  const token = expectToken(input.token);
  const conflicts = resourceKeys.filter((resourceKey) => {
    const lock = current.locks[resourceKey];
    return !lock || lock.ownerId !== ownerId || lock.token !== token;
  });
  if (conflicts.length > 0) {
    return { accepted: false, state, conflicts };
  }
  const locks = { ...current.locks };
  for (const resourceKey of resourceKeys) {
    delete locks[resourceKey];
  }
  return {
    accepted: true,
    token,
    conflicts: [],
    state: nextState(current, locks, at),
  };
}

export function pruneExpiredResourceLocks(
  state: ResourceLockStateV1,
  at: string,
): ResourceLockStateV1 {
  const current = normalizeResourceLockState(state);
  const timestamp = expectMonotonicTimestamp(at, current.updatedAt);
  const locks: Record<string, ResourceLockV1> = {};
  let removed = false;
  for (const [resourceKey, lock] of Object.entries(current.locks)) {
    if (isResourceLockActive(lock, timestamp)) {
      locks[resourceKey] = lock;
    } else {
      removed = true;
    }
  }
  return removed ? nextState(current, locks, timestamp) : state;
}

export function isResourceLockActive(
  lock: ResourceLockV1 | undefined,
  at: string,
): lock is ResourceLockV1 {
  return Boolean(lock && Date.parse(lock.expiresAt) > Date.parse(at));
}

function nextState(
  current: ResourceLockStateV1,
  locks: Record<string, ResourceLockV1>,
  at: string,
): ResourceLockStateV1 {
  return {
    ...current,
    revision: current.revision + 1,
    locks,
    updatedAt: at,
  };
}

function parseResourceLock(value: unknown): ResourceLockV1 {
  const record = expectRecord(value, "resource lock");
  assertExactKeys(record, ["resourceKey", "ownerId", "token", "acquiredAt", "expiresAt"]);
  const acquiredAt = expectIsoTimestamp(record.acquiredAt, "resource lock acquisition time");
  const expiresAt = expectIsoTimestamp(record.expiresAt, "resource lock expiry time");
  if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) {
    throw new Error("Resource lock expiry must follow acquisition time.");
  }
  return {
    resourceKey: normalizeResourceKey(record.resourceKey),
    ownerId: expectIdentifier(record.ownerId, "resource lock owner id"),
    token: expectToken(record.token),
    acquiredAt,
    expiresAt,
  };
}

function normalizeResourceKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("Resource lock request requires 1-32 resource keys.");
  }
  const keys = value.map(normalizeResourceKey).sort();
  if (new Set(keys).size !== keys.length) {
    throw new Error("Resource lock request contains duplicate resource keys.");
  }
  return keys;
}

function normalizeResourceKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 300 ||
    !/^[a-z][a-z0-9._-]*:[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/.test(value) ||
    value.includes("..")
  ) {
    throw new Error("Resource key is invalid.");
  }
  return value;
}

function expectToken(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("Resource lock token must be a SHA-256 fingerprint.");
  }
  return value;
}

function expectIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
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
  const at = expectIsoTimestamp(value, "resource lock event time");
  if (Date.parse(at) < Date.parse(previous)) {
    throw new Error("Resource lock event time must not move backwards.");
  }
  return at;
}

function expectIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
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
      `Resource lock state keys are invalid (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
}
