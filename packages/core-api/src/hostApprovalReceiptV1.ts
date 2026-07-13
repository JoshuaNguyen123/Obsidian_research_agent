import { portableSha256Text } from "./portableSha256";

export const HOST_APPROVAL_RECEIPT_VERSION = 1 as const;

export interface HostApprovalReceiptEvidenceV1 {
  version: typeof HOST_APPROVAL_RECEIPT_VERSION;
  kind: "host_approval_receipt_evidence";
  id: string;
  preparedActionId: string;
  preparedActionFingerprint: string;
  confirmationOrdinal: 1 | 2;
  requiredConfirmations: 1 | 2;
  decision: "approved" | "denied";
  hostInstanceFingerprint: string;
  actorFingerprint: string;
  sessionFingerprint: string;
  decidedAt: string;
  evidenceFingerprint: string;
}

/**
 * Portable proof of one real host approval gesture. The authenticator is made
 * by the host over `evidenceFingerprint`; a background runtime must verify it
 * against its independently trusted host signing key before reading or writing
 * a provider-attempt WAL.
 */
export interface HostApprovalReceiptV1
  extends Omit<HostApprovalReceiptEvidenceV1, "kind"> {
  kind: "host_approval_receipt";
  signingKeyFingerprint: string;
  authenticator: string;
  fingerprint: string;
}

export type HostApprovalReceiptEvidenceDraftV1 = Omit<
  HostApprovalReceiptEvidenceV1,
  "version" | "kind" | "evidenceFingerprint"
>;

export interface HostApprovalReceiptSealV1 {
  signingKeyFingerprint: string;
  authenticator: string;
}

export class HostApprovalReceiptErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostApprovalReceiptErrorV1";
  }
}

export function createHostApprovalReceiptEvidenceV1(
  draft: HostApprovalReceiptEvidenceDraftV1,
): HostApprovalReceiptEvidenceV1 {
  const evidence = normalizeEvidence({
    version: HOST_APPROVAL_RECEIPT_VERSION,
    kind: "host_approval_receipt_evidence",
    ...draft,
  });
  return {
    ...evidence,
    evidenceFingerprint: fingerprintHostApprovalReceiptValueV1(evidence),
  };
}

export function sealHostApprovalReceiptV1(
  evidenceInput: HostApprovalReceiptEvidenceV1,
  sealInput: HostApprovalReceiptSealV1,
): HostApprovalReceiptV1 {
  const evidence = parseHostApprovalReceiptEvidenceV1(evidenceInput);
  const unsigned = {
    ...evidence,
    kind: "host_approval_receipt" as const,
    signingKeyFingerprint: sha256(
      sealInput.signingKeyFingerprint,
      "host approval signing-key fingerprint",
    ),
    authenticator: authenticator(sealInput.authenticator),
  };
  return {
    ...unsigned,
    fingerprint: fingerprintHostApprovalReceiptValueV1(unsigned),
  };
}

export function parseHostApprovalReceiptEvidenceV1(
  value: unknown,
): HostApprovalReceiptEvidenceV1 {
  const record = exactRecord(value, [
    "version",
    "kind",
    "id",
    "preparedActionId",
    "preparedActionFingerprint",
    "confirmationOrdinal",
    "requiredConfirmations",
    "decision",
    "hostInstanceFingerprint",
    "actorFingerprint",
    "sessionFingerprint",
    "decidedAt",
    "evidenceFingerprint",
  ], "host approval receipt evidence");
  const observed = sha256(
    record.evidenceFingerprint,
    "host approval evidence fingerprint",
  );
  const { evidenceFingerprint: _ignored, ...unsigned } = record;
  const evidence = normalizeEvidence(unsigned);
  if (observed !== fingerprintHostApprovalReceiptValueV1(evidence)) {
    fail("Host approval receipt evidence fingerprint does not match its contents.");
  }
  return { ...evidence, evidenceFingerprint: observed };
}

export function parseHostApprovalReceiptV1(value: unknown): HostApprovalReceiptV1 {
  const record = exactRecord(value, [
    "version",
    "kind",
    "id",
    "preparedActionId",
    "preparedActionFingerprint",
    "confirmationOrdinal",
    "requiredConfirmations",
    "decision",
    "hostInstanceFingerprint",
    "actorFingerprint",
    "sessionFingerprint",
    "decidedAt",
    "evidenceFingerprint",
    "signingKeyFingerprint",
    "authenticator",
    "fingerprint",
  ], "host approval receipt");
  if (record.kind !== "host_approval_receipt") {
    fail("Unsupported host approval receipt kind.");
  }
  const observed = sha256(record.fingerprint, "host approval receipt fingerprint");
  const evidence = parseHostApprovalReceiptEvidenceV1({
    version: record.version,
    kind: "host_approval_receipt_evidence",
    id: record.id,
    preparedActionId: record.preparedActionId,
    preparedActionFingerprint: record.preparedActionFingerprint,
    confirmationOrdinal: record.confirmationOrdinal,
    requiredConfirmations: record.requiredConfirmations,
    decision: record.decision,
    hostInstanceFingerprint: record.hostInstanceFingerprint,
    actorFingerprint: record.actorFingerprint,
    sessionFingerprint: record.sessionFingerprint,
    decidedAt: record.decidedAt,
    evidenceFingerprint: record.evidenceFingerprint,
  });
  const unsigned = {
    ...evidence,
    kind: "host_approval_receipt" as const,
    signingKeyFingerprint: sha256(
      record.signingKeyFingerprint,
      "host approval signing-key fingerprint",
    ),
    authenticator: authenticator(record.authenticator),
  };
  if (observed !== fingerprintHostApprovalReceiptValueV1(unsigned)) {
    fail("Host approval receipt fingerprint does not match its contents.");
  }
  return { ...unsigned, fingerprint: observed };
}

export function fingerprintHostApprovalReceiptValueV1(value: unknown): string {
  return `sha256:${portableSha256Text(canonicalJson(value))}`;
}

function normalizeEvidence(
  value: unknown,
): Omit<HostApprovalReceiptEvidenceV1, "evidenceFingerprint"> {
  const record = exactRecord(value, [
    "version",
    "kind",
    "id",
    "preparedActionId",
    "preparedActionFingerprint",
    "confirmationOrdinal",
    "requiredConfirmations",
    "decision",
    "hostInstanceFingerprint",
    "actorFingerprint",
    "sessionFingerprint",
    "decidedAt",
  ], "host approval receipt evidence fields");
  if (
    record.version !== HOST_APPROVAL_RECEIPT_VERSION ||
    record.kind !== "host_approval_receipt_evidence"
  ) {
    fail("Unsupported host approval receipt evidence contract.");
  }
  const requiredConfirmations = integer(
    record.requiredConfirmations,
    "required confirmations",
    1,
    2,
  ) as 1 | 2;
  const confirmationOrdinal = integer(
    record.confirmationOrdinal,
    "confirmation ordinal",
    1,
    2,
  ) as 1 | 2;
  if (confirmationOrdinal > requiredConfirmations) {
    fail("Host approval confirmation ordinal exceeds its required confirmation count.");
  }
  if (record.decision !== "approved" && record.decision !== "denied") {
    fail("Host approval receipt decision is invalid.");
  }
  return {
    version: HOST_APPROVAL_RECEIPT_VERSION,
    kind: "host_approval_receipt_evidence",
    id: identifier(record.id, "host approval receipt id"),
    preparedActionId: identifier(record.preparedActionId, "prepared action id"),
    preparedActionFingerprint: sha256(
      record.preparedActionFingerprint,
      "prepared action fingerprint",
    ),
    confirmationOrdinal,
    requiredConfirmations,
    decision: record.decision,
    hostInstanceFingerprint: sha256(
      record.hostInstanceFingerprint,
      "host instance fingerprint",
    ),
    actorFingerprint: sha256(record.actorFingerprint, "approval actor fingerprint"),
    sessionFingerprint: sha256(
      record.sessionFingerprint,
      "approval session fingerprint",
    ),
    decidedAt: timestamp(record.decidedAt, "approval decision time"),
  };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(`${label} does not match its closed contract.`);
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) ||
    ["__proto__", "prototype", "constructor"].includes(value)
  ) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} must be a canonical SHA-256 fingerprint.`);
  }
  return value;
}

function authenticator(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    fail("Host approval receipt authenticator must be bounded base64url text.");
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(`${label} is invalid.`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    fail(`${label} must be a canonical ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail("Host approval receipt contains an unsafe number.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    fail("Host approval receipt contains an unsupported value.");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function fail(message: string): never {
  throw new HostApprovalReceiptErrorV1(message);
}
