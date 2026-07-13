import { portableSha256Text } from "./portableSha256";

export const PREPARED_EXTERNAL_ACTION_HANDOFF_VERSION = 1 as const;
export const LINEAR_ISSUE_STATE_UPDATE_OPERATION_V1 =
  "linear_issue_state_update_v1" as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const OPAQUE_CREDENTIAL_REFERENCE =
  /^(?:secret|credential)_[A-Za-z0-9-]{8,128}$/u;

export interface PreparedExternalActionBindingV1 {
  id: string;
  kind: "issue" | "linear-work-item";
  destinationFingerprint: string;
}

export interface ConsumedExternalActionGrantV1 {
  id: string;
  authorityFingerprint: string;
  actionFingerprint: string;
  consumedAt: string;
  expiresAt: string;
}

export interface LinearIssueStateUpdatePayloadV1 {
  issueId: string;
  stateId: string;
  preconditionFingerprint: string;
  credentialReferenceId: string;
}

/**
 * Secret-free, immutable proof that one exact, already-approved Linear state
 * update is eligible for a future background dispatch protocol. This is not a
 * command envelope and cannot represent any other provider operation.
 */
export interface PreparedExternalActionHandoffV1 {
  version: typeof PREPARED_EXTERNAL_ACTION_HANDOFF_VERSION;
  kind: "prepared_external_action_handoff";
  operation: typeof LINEAR_ISSUE_STATE_UPDATE_OPERATION_V1;
  status: "prepared";
  id: string;
  missionId: string;
  graphRevision: number;
  capabilityEnvelopeFingerprint: string;
  nodeId: string;
  nodeFingerprint: string;
  executionHost: "companion" | "headless_runtime";
  toolName: "linear_update_issue";
  descriptorFingerprint: string;
  preparedActionId: string;
  preparedActionFingerprint: string;
  binding: PreparedExternalActionBindingV1;
  authority: ConsumedExternalActionGrantV1;
  payload: LinearIssueStateUpdatePayloadV1;
  idempotencyKey: string;
  reconciliationKey: string;
  preparedAt: string;
  expiresAt: string;
  fingerprint: string;
}

export type PreparedExternalActionHandoffDraftV1 = Omit<
  PreparedExternalActionHandoffV1,
  "version" | "kind" | "operation" | "status" | "fingerprint"
>;

export class PreparedExternalActionHandoffErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedExternalActionHandoffErrorV1";
  }
}

export function createPreparedExternalActionHandoffV1(
  draft: PreparedExternalActionHandoffDraftV1,
): PreparedExternalActionHandoffV1 {
  const evidence = normalizeEvidence({
    version: PREPARED_EXTERNAL_ACTION_HANDOFF_VERSION,
    kind: "prepared_external_action_handoff",
    operation: LINEAR_ISSUE_STATE_UPDATE_OPERATION_V1,
    status: "prepared",
    ...draft,
  });
  return {
    ...evidence,
    fingerprint: fingerprintOf(evidence),
  };
}

export function parsePreparedExternalActionHandoffV1(
  value: unknown,
): PreparedExternalActionHandoffV1 {
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
    "prepared external action handoff",
  );
  const observedFingerprint = fingerprint(
    record.fingerprint,
    "handoff fingerprint",
  );
  const { fingerprint: _ignoredFingerprint, ...evidenceRecord } = record;
  const evidence = normalizeEvidence(evidenceRecord);
  if (observedFingerprint !== fingerprintOf(evidence)) {
    fail("Prepared external action handoff fingerprint does not match its evidence.");
  }
  return { ...evidence, fingerprint: observedFingerprint };
}

/** Stable local/remote attempt identity persisted before companion dispatch. */
export function linearIssueStateUpdateAttemptIdV1(
  jobId: string,
  value: PreparedExternalActionHandoffV1,
): string {
  const handoff = parsePreparedExternalActionHandoffV1(value);
  return fingerprintOf({
    version: 1,
    jobId: identifier(jobId, "companion job id"),
    handoffFingerprint: handoff.fingerprint,
    preparedActionFingerprint: handoff.preparedActionFingerprint,
    reconciliationKey: handoff.reconciliationKey,
  });
}

function normalizeEvidence(
  value: unknown,
): Omit<PreparedExternalActionHandoffV1, "fingerprint"> {
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
    "prepared external action handoff evidence",
  );
  if (
    record.version !== PREPARED_EXTERNAL_ACTION_HANDOFF_VERSION ||
    record.kind !== "prepared_external_action_handoff" ||
    record.operation !== LINEAR_ISSUE_STATE_UPDATE_OPERATION_V1 ||
    record.status !== "prepared" ||
    record.toolName !== "linear_update_issue"
  ) {
    fail("Unsupported prepared external action handoff contract.");
  }
  if (
    record.executionHost !== "companion" &&
    record.executionHost !== "headless_runtime"
  ) {
    fail("Prepared external action handoff requires a background execution host.");
  }
  const bindingRecord = exactRecord(
    record.binding,
    ["id", "kind", "destinationFingerprint"],
    "prepared external action binding",
  );
  if (bindingRecord.kind !== "issue" && bindingRecord.kind !== "linear-work-item") {
    fail("Prepared external action binding must identify a Linear work item.");
  }
  const authorityRecord = exactRecord(
    record.authority,
    ["id", "authorityFingerprint", "actionFingerprint", "consumedAt", "expiresAt"],
    "consumed external action grant",
  );
  const payloadRecord = exactRecord(
    record.payload,
    ["issueId", "stateId", "preconditionFingerprint", "credentialReferenceId"],
    "Linear issue state update payload",
  );
  const preparedAt = timestamp(record.preparedAt, "preparedAt");
  const expiresAt = timestamp(record.expiresAt, "expiresAt");
  const consumedAt = timestamp(authorityRecord.consumedAt, "authority consumedAt");
  const grantExpiresAt = timestamp(authorityRecord.expiresAt, "authority expiresAt");
  if (
    Date.parse(consumedAt) > Date.parse(preparedAt) ||
    Date.parse(expiresAt) <= Date.parse(preparedAt) ||
    Date.parse(expiresAt) > Date.parse(grantExpiresAt)
  ) {
    fail("Prepared external action handoff timestamps are not within the consumed grant lifetime.");
  }
  const preparedActionFingerprint = fingerprint(
    record.preparedActionFingerprint,
    "prepared action fingerprint",
  );
  const authorityActionFingerprint = fingerprint(
    authorityRecord.actionFingerprint,
    "authority action fingerprint",
  );
  if (authorityActionFingerprint !== preparedActionFingerprint) {
    fail("Consumed authority is bound to a different prepared action.");
  }
  const idempotencyKey = boundedText(record.idempotencyKey, "idempotency key", 1, 512);
  const reconciliationKey = boundedText(
    record.reconciliationKey,
    "reconciliation key",
    1,
    512,
  );
  if (idempotencyKey !== reconciliationKey) {
    fail("Linear state update idempotency and reconciliation keys must match.");
  }
  const credentialReferenceId = boundedText(
    payloadRecord.credentialReferenceId,
    "credential reference id",
    1,
    256,
  );
  if (!OPAQUE_CREDENTIAL_REFERENCE.test(credentialReferenceId)) {
    fail("Linear state update requires an opaque credential reference.");
  }
  return {
    version: PREPARED_EXTERNAL_ACTION_HANDOFF_VERSION,
    kind: "prepared_external_action_handoff",
    operation: LINEAR_ISSUE_STATE_UPDATE_OPERATION_V1,
    status: "prepared",
    id: identifier(record.id, "handoff id"),
    missionId: identifier(record.missionId, "mission id"),
    graphRevision: integer(
      record.graphRevision,
      "graph revision",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    capabilityEnvelopeFingerprint: fingerprint(
      record.capabilityEnvelopeFingerprint,
      "capability envelope fingerprint",
    ),
    nodeId: identifier(record.nodeId, "node id"),
    nodeFingerprint: fingerprint(record.nodeFingerprint, "node fingerprint"),
    executionHost: record.executionHost,
    toolName: "linear_update_issue",
    descriptorFingerprint: fingerprint(
      record.descriptorFingerprint,
      "descriptor fingerprint",
    ),
    preparedActionId: identifier(record.preparedActionId, "prepared action id"),
    preparedActionFingerprint,
    binding: {
      id: identifier(bindingRecord.id, "binding id"),
      kind: bindingRecord.kind,
      destinationFingerprint: fingerprint(
        bindingRecord.destinationFingerprint,
        "binding destination fingerprint",
      ),
    },
    authority: {
      id: identifier(authorityRecord.id, "authority grant id"),
      authorityFingerprint: fingerprint(
        authorityRecord.authorityFingerprint,
        "authority grant fingerprint",
      ),
      actionFingerprint: authorityActionFingerprint,
      consumedAt,
      expiresAt: grantExpiresAt,
    },
    payload: {
      issueId: identifier(payloadRecord.issueId, "Linear issue id"),
      stateId: identifier(payloadRecord.stateId, "Linear state id"),
      preconditionFingerprint: fingerprint(
        payloadRecord.preconditionFingerprint,
        "Linear issue precondition fingerprint",
      ),
      credentialReferenceId,
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
  if (actual.join("\0") !== expected.join("\0")) {
    fail(`${label} does not match its closed contract.`);
  }
  return record as Record<T[number], unknown>;
}

function identifier(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 256);
  if (
    !IDENTIFIER.test(result) ||
    ["__proto__", "prototype", "constructor"].includes(result)
  ) {
    fail(`${label} is invalid.`);
  }
  return result;
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
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  const result = boundedText(value, label, 20, 40);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(Date.parse(result)).toISOString() !== result
  ) {
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
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      fail("Handoff fingerprint evidence contains an unsafe number.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    fail("Handoff fingerprint evidence contains an unsupported value.");
  }
  return `{${Object.keys(value as object)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(",")}}`;
}

function fail(message: string): never {
  throw new PreparedExternalActionHandoffErrorV1(message);
}
