import { fingerprintCanonicalJson } from "./fingerprint";

export const QUEUE_DAILY_START_BUDGET_SCHEMA_VERSION = 1 as const;
export const QUEUE_DAILY_START_LIMIT = 25;

export interface QueueDailyStartReservationV1 {
  reservationKey: string;
  issueId: string;
  contractFingerprint: string;
  reservedAt: string;
}

/**
 * Host-persisted counter for distinct ticket contracts started during one UTC
 * day. The host must update this state through a serialized reducer so two
 * coordinators cannot both observe the final available slot.
 */
export interface QueueDailyStartBudgetStateV1 {
  schemaVersion: typeof QUEUE_DAILY_START_BUDGET_SCHEMA_VERSION;
  revision: number;
  utcDay: string;
  limit: number;
  reservations: Record<string, QueueDailyStartReservationV1>;
  createdAt: string;
  updatedAt: string;
}

export interface QueueDailyStartReservationResult {
  accepted: boolean;
  state: QueueDailyStartBudgetStateV1;
  reservation?: QueueDailyStartReservationV1;
  alreadyReserved?: boolean;
  reason?: "daily_limit_exhausted";
}

export function createQueueDailyStartBudgetState(input: {
  at: string;
  limit?: number;
}): QueueDailyStartBudgetStateV1 {
  const at = expectIsoTimestamp(input.at, "daily queue budget creation time");
  return {
    schemaVersion: QUEUE_DAILY_START_BUDGET_SCHEMA_VERSION,
    revision: 0,
    utcDay: utcDay(at),
    limit: expectLimit(input.limit ?? QUEUE_DAILY_START_LIMIT),
    reservations: {},
    createdAt: at,
    updatedAt: at,
  };
}

export function normalizeQueueDailyStartBudgetState(
  value: unknown,
): QueueDailyStartBudgetStateV1 {
  const record = expectRecord(value, "daily queue start budget");
  assertExactKeys(record, [
    "schemaVersion",
    "revision",
    "utcDay",
    "limit",
    "reservations",
    "createdAt",
    "updatedAt",
  ]);
  if (record.schemaVersion !== QUEUE_DAILY_START_BUDGET_SCHEMA_VERSION) {
    throw new Error("Unsupported daily queue start budget schema version.");
  }
  const createdAt = expectIsoTimestamp(record.createdAt, "daily queue budget creation time");
  const updatedAt = expectIsoTimestamp(record.updatedAt, "daily queue budget update time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("Daily queue budget update time precedes creation time.");
  }
  const day = expectUtcDay(record.utcDay);
  const limit = expectLimit(record.limit);
  const rawReservations = expectRecord(
    record.reservations,
    "daily queue start reservations",
  );
  const reservations: Record<string, QueueDailyStartReservationV1> = {};
  for (const [storedKey, value] of Object.entries(rawReservations)) {
    const reservation = parseReservation(value);
    if (reservation.reservationKey !== storedKey) {
      throw new Error("Daily queue reservation key does not match its stored key.");
    }
    if (utcDay(reservation.reservedAt) !== day) {
      throw new Error("Daily queue reservation belongs to a different UTC day.");
    }
    if (
      reservation.reservationKey !==
      queueDailyStartReservationKey({
        utcDay: day,
        issueId: reservation.issueId,
        contractFingerprint: reservation.contractFingerprint,
      })
    ) {
      throw new Error("Daily queue reservation fingerprint is invalid.");
    }
    reservations[storedKey] = reservation;
  }
  if (Object.keys(reservations).length > limit) {
    throw new Error("Daily queue start reservations exceed the configured limit.");
  }
  return {
    schemaVersion: QUEUE_DAILY_START_BUDGET_SCHEMA_VERSION,
    revision: expectInteger(record.revision, "daily queue budget revision", 0),
    utcDay: day,
    limit,
    reservations,
    createdAt,
    updatedAt,
  };
}

export const parseQueueDailyStartBudgetState = normalizeQueueDailyStartBudgetState;

/**
 * Reserves one distinct (issue, contract fingerprint) start. Repeating the
 * same reservation on the same UTC day is idempotent and does not spend a
 * second slot. A new UTC day atomically replaces the prior day's counters.
 */
export function reserveQueueDailyStart(
  state: QueueDailyStartBudgetStateV1,
  input: {
    issueId: string;
    contractFingerprint: string;
    at: string;
  },
): QueueDailyStartReservationResult {
  const current = normalizeQueueDailyStartBudgetState(state);
  const at = expectMonotonicTimestamp(input.at, current.updatedAt);
  const issueId = expectIdentifier(input.issueId, "Linear issue id");
  const contractFingerprint = expectFingerprint(input.contractFingerprint);
  const day = utcDay(at);
  const reservationKey = queueDailyStartReservationKey({
    utcDay: day,
    issueId,
    contractFingerprint,
  });
  const reservations = day === current.utcDay ? current.reservations : {};
  const existing = reservations[reservationKey];
  if (existing) {
    return {
      accepted: true,
      alreadyReserved: true,
      reservation: existing,
      state,
    };
  }
  if (Object.keys(reservations).length >= current.limit) {
    return {
      accepted: false,
      reason: "daily_limit_exhausted",
      state,
    };
  }
  const reservation: QueueDailyStartReservationV1 = {
    reservationKey,
    issueId,
    contractFingerprint,
    reservedAt: at,
  };
  return {
    accepted: true,
    alreadyReserved: false,
    reservation,
    state: {
      ...current,
      revision: current.revision + 1,
      utcDay: day,
      reservations: { ...reservations, [reservationKey]: reservation },
      updatedAt: at,
    },
  };
}

export function queueDailyStartReservationKey(input: {
  utcDay: string;
  issueId: string;
  contractFingerprint: string;
}): string {
  return fingerprintCanonicalJson({
    kind: "linear-queue-daily-start",
    utcDay: expectUtcDay(input.utcDay),
    issueId: expectIdentifier(input.issueId, "Linear issue id"),
    contractFingerprint: expectFingerprint(input.contractFingerprint),
  });
}

function parseReservation(value: unknown): QueueDailyStartReservationV1 {
  const record = expectRecord(value, "daily queue start reservation");
  assertExactKeys(record, [
    "reservationKey",
    "issueId",
    "contractFingerprint",
    "reservedAt",
  ]);
  return {
    reservationKey: expectFingerprint(record.reservationKey),
    issueId: expectIdentifier(record.issueId, "Linear issue id"),
    contractFingerprint: expectFingerprint(record.contractFingerprint),
    reservedAt: expectIsoTimestamp(record.reservedAt, "daily queue reservation time"),
  };
}

function utcDay(at: string): string {
  return at.slice(0, 10);
}

function expectUtcDay(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Daily queue budget UTC day is invalid.");
  }
  return value;
}

function expectLimit(value: unknown): number {
  return expectInteger(value, "daily queue start limit", 1, QUEUE_DAILY_START_LIMIT);
}

function expectFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("Daily queue fingerprint must be a SHA-256 fingerprint.");
  }
  return value;
}

function expectIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
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
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function expectMonotonicTimestamp(value: unknown, previous: string): string {
  const at = expectIsoTimestamp(value, "daily queue budget event time");
  if (Date.parse(at) < Date.parse(previous)) {
    throw new Error("Daily queue budget event time must not move backwards.");
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
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Daily queue budget keys are invalid (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
}
