import { portableSha256Text } from "./portableSha256";

export const PREPARED_BACKGROUND_CODE_ACTION_VERSION = 1 as const;
export const PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1 =
  "prepared_code_validation_commit_v1" as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CHECKPOINT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;

export interface PreparedBackgroundCodeBindingV1 {
  workspaceId: string;
  repositoryProfileKey: string;
  destinationFingerprint: string;
}

export interface ConsumedBackgroundCodeGrantV1 {
  id: string;
  authorityFingerprint: string;
  actionFingerprint: string;
  consumedAt: string;
  expiresAt: string;
}

export interface PreparedBackgroundCodePayloadV1 {
  repairCheckpointId: string;
  repairRequestFingerprint: string;
  preparedCheckpointSequence: number;
  workspaceBindingFingerprint: string;
  repositoryProfileFingerprint: string;
  sandboxCapabilityFingerprint: string;
}

/**
 * Secret-free proof that the host authorized one exact continuation of an
 * existing durable repair checkpoint. It intentionally carries no path,
 * command, patch, objective, model text, or credential reference. The Code
 * extension must reconstruct all execution state from its trusted stores.
 */
export interface PreparedBackgroundCodeActionV1 {
  version: typeof PREPARED_BACKGROUND_CODE_ACTION_VERSION;
  kind: "prepared_background_code_action";
  operation: typeof PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1;
  status: "prepared";
  id: string;
  missionId: string;
  graphRevision: number;
  capabilityEnvelopeFingerprint: string;
  nodeId: string;
  nodeFingerprint: string;
  executionHost: "companion" | "headless_runtime";
  toolName: "code_validate_commit_prepared";
  descriptorFingerprint: string;
  preparedActionId: string;
  preparedActionFingerprint: string;
  binding: PreparedBackgroundCodeBindingV1;
  authority: ConsumedBackgroundCodeGrantV1;
  payload: PreparedBackgroundCodePayloadV1;
  idempotencyKey: string;
  reconciliationKey: string;
  preparedAt: string;
  expiresAt: string;
  fingerprint: string;
}

export type PreparedBackgroundCodeActionDraftV1 = Omit<
  PreparedBackgroundCodeActionV1,
  "version" | "kind" | "operation" | "status" | "toolName" | "fingerprint"
>;

export class PreparedBackgroundCodeActionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedBackgroundCodeActionErrorV1";
  }
}

export function createPreparedBackgroundCodeActionV1(
  draft: PreparedBackgroundCodeActionDraftV1,
): PreparedBackgroundCodeActionV1 {
  const evidence = normalizeEvidence({
    version: PREPARED_BACKGROUND_CODE_ACTION_VERSION,
    kind: "prepared_background_code_action",
    operation: PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1,
    status: "prepared",
    toolName: "code_validate_commit_prepared",
    ...draft,
  });
  return { ...evidence, fingerprint: fingerprintOf(evidence) };
}

export function parsePreparedBackgroundCodeActionV1(
  value: unknown,
): PreparedBackgroundCodeActionV1 {
  const record = exactRecord(
    value,
    [
      "version",
      "kind",
      "operation",
      "status",
      "id",
      "missionId",
      "graphRevision",
      "capabilityEnvelopeFingerprint",
      "nodeId",
      "nodeFingerprint",
      "executionHost",
      "toolName",
      "descriptorFingerprint",
      "preparedActionId",
      "preparedActionFingerprint",
      "binding",
      "authority",
      "payload",
      "idempotencyKey",
      "reconciliationKey",
      "preparedAt",
      "expiresAt",
      "fingerprint",
    ],
    "prepared background code action",
  );
  const observedFingerprint = fingerprint(record.fingerprint, "handoff fingerprint");
  const { fingerprint: _ignored, ...evidenceRecord } = record;
  const evidence = normalizeEvidence(evidenceRecord);
  if (observedFingerprint !== fingerprintOf(evidence)) {
    fail("Prepared background code action fingerprint does not match its evidence.");
  }
  return { ...evidence, fingerprint: observedFingerprint };
}

export function backgroundCodeContinuationAttemptIdV1(
  jobId: string,
  value: PreparedBackgroundCodeActionV1,
): string {
  const handoff = parsePreparedBackgroundCodeActionV1(value);
  return fingerprintOf({
    version: 1,
    jobId: identifier(jobId, "companion job id"),
    handoffFingerprint: handoff.fingerprint,
    repairCheckpointId: handoff.payload.repairCheckpointId,
    reconciliationKey: handoff.reconciliationKey,
  });
}

function normalizeEvidence(
  value: unknown,
): Omit<PreparedBackgroundCodeActionV1, "fingerprint"> {
  const record = exactRecord(
    value,
    [
      "version",
      "kind",
      "operation",
      "status",
      "id",
      "missionId",
      "graphRevision",
      "capabilityEnvelopeFingerprint",
      "nodeId",
      "nodeFingerprint",
      "executionHost",
      "toolName",
      "descriptorFingerprint",
      "preparedActionId",
      "preparedActionFingerprint",
      "binding",
      "authority",
      "payload",
      "idempotencyKey",
      "reconciliationKey",
      "preparedAt",
      "expiresAt",
    ],
    "prepared background code action evidence",
  );
  if (
    record.version !== PREPARED_BACKGROUND_CODE_ACTION_VERSION ||
    record.kind !== "prepared_background_code_action" ||
    record.operation !== PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1 ||
    record.status !== "prepared" ||
    record.toolName !== "code_validate_commit_prepared"
  ) {
    fail("Unsupported prepared background code action contract.");
  }
  if (record.executionHost !== "companion" && record.executionHost !== "headless_runtime") {
    fail("Prepared background code action requires a background execution host.");
  }
  const binding = exactRecord(
    record.binding,
    ["workspaceId", "repositoryProfileKey", "destinationFingerprint"],
    "prepared background code binding",
  );
  const authority = exactRecord(
    record.authority,
    ["id", "authorityFingerprint", "actionFingerprint", "consumedAt", "expiresAt"],
    "consumed background code grant",
  );
  const payload = exactRecord(
    record.payload,
    [
      "repairCheckpointId",
      "repairRequestFingerprint",
      "preparedCheckpointSequence",
      "workspaceBindingFingerprint",
      "repositoryProfileFingerprint",
      "sandboxCapabilityFingerprint",
    ],
    "prepared background code payload",
  );
  const preparedAt = timestamp(record.preparedAt, "preparedAt");
  const expiresAt = timestamp(record.expiresAt, "expiresAt");
  const consumedAt = timestamp(authority.consumedAt, "authority consumedAt");
  const authorityExpiresAt = timestamp(authority.expiresAt, "authority expiresAt");
  if (
    Date.parse(consumedAt) > Date.parse(preparedAt) ||
    Date.parse(expiresAt) <= Date.parse(preparedAt) ||
    Date.parse(expiresAt) > Date.parse(authorityExpiresAt)
  ) {
    fail("Prepared background code timestamps are outside the consumed grant lifetime.");
  }
  const preparedActionFingerprint = fingerprint(
    record.preparedActionFingerprint,
    "prepared action fingerprint",
  );
  if (
    fingerprint(authority.actionFingerprint, "authority action fingerprint") !==
    preparedActionFingerprint
  ) {
    fail("Consumed background code authority is bound to a different action.");
  }
  const idempotencyKey = boundedText(record.idempotencyKey, "idempotency key", 1, 512);
  const reconciliationKey = boundedText(
    record.reconciliationKey,
    "reconciliation key",
    1,
    512,
  );
  if (idempotencyKey !== reconciliationKey) {
    fail("Background code idempotency and reconciliation keys must match.");
  }
  return {
    version: PREPARED_BACKGROUND_CODE_ACTION_VERSION,
    kind: "prepared_background_code_action",
    operation: PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1,
    status: "prepared",
    id: identifier(record.id, "handoff id"),
    missionId: identifier(record.missionId, "mission id"),
    graphRevision: integer(record.graphRevision, "graph revision", 0, Number.MAX_SAFE_INTEGER),
    capabilityEnvelopeFingerprint: fingerprint(
      record.capabilityEnvelopeFingerprint,
      "capability envelope fingerprint",
    ),
    nodeId: identifier(record.nodeId, "node id"),
    nodeFingerprint: fingerprint(record.nodeFingerprint, "node fingerprint"),
    executionHost: record.executionHost,
    toolName: "code_validate_commit_prepared",
    descriptorFingerprint: fingerprint(record.descriptorFingerprint, "descriptor fingerprint"),
    preparedActionId: identifier(record.preparedActionId, "prepared action id"),
    preparedActionFingerprint,
    binding: {
      workspaceId: identifier(binding.workspaceId, "workspace id"),
      repositoryProfileKey: identifier(
        binding.repositoryProfileKey,
        "repository profile key",
      ),
      destinationFingerprint: fingerprint(
        binding.destinationFingerprint,
        "destination fingerprint",
      ),
    },
    authority: {
      id: identifier(authority.id, "authority grant id"),
      authorityFingerprint: fingerprint(
        authority.authorityFingerprint,
        "authority grant fingerprint",
      ),
      actionFingerprint: preparedActionFingerprint,
      consumedAt,
      expiresAt: authorityExpiresAt,
    },
    payload: {
      repairCheckpointId: checkpointIdentifier(
        payload.repairCheckpointId,
        "repair checkpoint id",
      ),
      repairRequestFingerprint: fingerprint(
        payload.repairRequestFingerprint,
        "repair request fingerprint",
      ),
      preparedCheckpointSequence: integer(
        payload.preparedCheckpointSequence,
        "prepared checkpoint sequence",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      workspaceBindingFingerprint: fingerprint(
        payload.workspaceBindingFingerprint,
        "workspace binding fingerprint",
      ),
      repositoryProfileFingerprint: fingerprint(
        payload.repositoryProfileFingerprint,
        "repository profile fingerprint",
      ),
      sandboxCapabilityFingerprint: fingerprint(
        payload.sandboxCapabilityFingerprint,
        "sandbox capability fingerprint",
      ),
    },
    idempotencyKey,
    reconciliationKey,
    preparedAt,
    expiresAt,
  };
}

function exactRecord<const T extends readonly string[]>(
  value: unknown,
  keys: T,
  label: string,
): Record<T[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} does not match its closed contract.`);
  }
  return record as Record<T[number], unknown>;
}

function identifier(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 256);
  if (!IDENTIFIER.test(result) || isPrototypeKey(result)) fail(`${label} is invalid.`);
  return result;
}

function checkpointIdentifier(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 512);
  if (!CHECKPOINT_IDENTIFIER.test(result) || isPrototypeKey(result)) fail(`${label} is invalid.`);
  return result;
}

function isPrototypeKey(value: string): boolean {
  return ["__proto__", "prototype", "constructor"].includes(value);
}

function fingerprint(value: unknown, label: string): string {
  const result = boundedText(value, label, 71, 71);
  if (!SHA256.test(result)) fail(`${label} must be a SHA-256 fingerprint.`);
  return result;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  const result = boundedText(value, label, 20, 40);
  if (!Number.isFinite(Date.parse(result)) || new Date(Date.parse(result)).toISOString() !== result) {
    fail(`${label} must be a canonical ISO timestamp.`);
  }
  return result;
}

function boundedText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(`${label} must be bounded text.`);
  }
  return value;
}

function fingerprintOf(value: unknown): string {
  return `sha256:${portableSha256Text(canonicalJson(value))}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail("Prepared background code evidence contains an unsafe number.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    fail("Prepared background code evidence contains an unsupported value.");
  }
  return `{${Object.keys(value as object)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function fail(message: string): never {
  throw new PreparedBackgroundCodeActionErrorV1(message);
}
