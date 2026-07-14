import {
  assertCanonicalContract,
  assertExactKeys,
  assertNoRawAuthority,
  constantTimeFingerprintEqual,
  DurableLinearContractError,
  expectEnum,
  expectIsoTimestamp,
  expectLogicalKey,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
  expectString,
  fingerprintContract,
  parseHttpUrl,
  parseVaultMarkdownPath,
} from "./LinearContractSupport";
import type {
  WorkItemAcceptanceCriterionV1,
  WorkItemRiskClass,
} from "./WorkItemSpecV1";

export const ACCEPTED_RESEARCH_ARTIFACT_SCHEMA_VERSION = 1 as const;

export type AcceptedResearchEvidenceKindV1 = "web" | "vault" | "user";

export interface AcceptedResearchEvidenceV1 {
  id: string;
  kind: AcceptedResearchEvidenceKindV1;
  reference: string;
  contentSha256: string;
}

export interface AcceptedResearchArtifactV1 {
  schemaVersion: typeof ACCEPTED_RESEARCH_ARTIFACT_SCHEMA_VERSION;
  artifactId: string;
  originRunId: string;
  vaultBindingKey: string;
  notePath: string;
  noteSha256: string;
  noteReceiptId: string;
  evidence: AcceptedResearchEvidenceV1[];
  acceptanceCriteria: WorkItemAcceptanceCriterionV1[];
  riskClass: WorkItemRiskClass;
  acceptedAt: string;
  acceptedBy: "host";
  artifactFingerprint: string;
}

export type AcceptedResearchArtifactV1Unsigned = Omit<
  AcceptedResearchArtifactV1,
  "artifactFingerprint"
>;

export function createAcceptedResearchArtifactV1(
  value: AcceptedResearchArtifactV1Unsigned,
): AcceptedResearchArtifactV1 {
  const unsigned = parseUnsigned(value);
  return {
    ...unsigned,
    artifactFingerprint: fingerprintAcceptedResearchArtifactV1(unsigned),
  };
}

export function parseAcceptedResearchArtifactV1(
  value: unknown,
): AcceptedResearchArtifactV1 {
  const record = expectPlainRecord(value, "accepted research artifact");
  assertKeys(record, true);
  const { artifactFingerprint: rawFingerprint, ...rawUnsigned } = record;
  const unsigned = parseUnsigned(rawUnsigned);
  assertCanonicalContract(rawUnsigned, unsigned, "Accepted research artifact");
  const artifactFingerprint = expectSha256(
    rawFingerprint,
    "accepted research artifact fingerprint",
  );
  const expected = fingerprintAcceptedResearchArtifactV1(unsigned);
  if (!constantTimeFingerprintEqual(artifactFingerprint, expected)) {
    throw new DurableLinearContractError(
      "Accepted research artifact fingerprint does not match its canonical payload.",
    );
  }
  return { ...unsigned, artifactFingerprint };
}

export function fingerprintAcceptedResearchArtifactV1(
  value: AcceptedResearchArtifactV1Unsigned | AcceptedResearchArtifactV1,
): string {
  const record = expectPlainRecord(value, "accepted research artifact fingerprint input");
  const { artifactFingerprint: _ignored, ...rawUnsigned } = record;
  return fingerprintContract(parseUnsigned(rawUnsigned));
}

function parseUnsigned(value: unknown): AcceptedResearchArtifactV1Unsigned {
  const record = expectPlainRecord(value, "accepted research artifact");
  assertKeys(record, false);
  if (record.schemaVersion !== ACCEPTED_RESEARCH_ARTIFACT_SCHEMA_VERSION) {
    throw new DurableLinearContractError("Unsupported accepted research artifact version.");
  }
  if (record.acceptedBy !== "host") {
    throw new DurableLinearContractError("Accepted research artifacts must be host-accepted.");
  }
  const evidence = parseEvidence(record.evidence);
  const acceptanceCriteria = parseAcceptanceCriteria(record.acceptanceCriteria);
  return {
    schemaVersion: ACCEPTED_RESEARCH_ARTIFACT_SCHEMA_VERSION,
    artifactId: expectLogicalKey(record.artifactId, "artifact id", 160),
    originRunId: expectOpaqueId(record.originRunId, "origin run id"),
    vaultBindingKey: expectLogicalKey(record.vaultBindingKey, "vault binding key"),
    notePath: parseVaultMarkdownPath(record.notePath, "research note path"),
    noteSha256: expectSha256(record.noteSha256, "research note hash"),
    noteReceiptId: expectOpaqueId(record.noteReceiptId, "research note receipt id"),
    evidence,
    acceptanceCriteria,
    riskClass: expectEnum(record.riskClass, "risk class", ["low", "medium", "high"]),
    acceptedAt: expectIsoTimestamp(record.acceptedAt, "accepted at"),
    acceptedBy: "host",
  };
}

function parseEvidence(value: unknown): AcceptedResearchEvidenceV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new DurableLinearContractError("Research evidence requires 1-50 entries.");
  }
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const record = expectPlainRecord(raw, `research evidence ${index + 1}`);
    assertExactKeys(
      record,
      ["id", "kind", "reference", "contentSha256"],
      [],
      `research evidence ${index + 1}`,
    );
    const id = expectLogicalKey(record.id, `research evidence ${index + 1} id`, 80);
    if (ids.has(id)) {
      throw new DurableLinearContractError(`Research evidence id ${id} is duplicated.`);
    }
    ids.add(id);
    const kind = expectEnum<AcceptedResearchEvidenceKindV1>(
      record.kind,
      `research evidence ${index + 1} kind`,
      ["web", "vault", "user"],
    );
    let reference: string;
    if (kind === "web") {
      reference = parseHttpUrl(record.reference, `research evidence ${index + 1} reference`);
    } else if (kind === "vault") {
      reference = parseVaultMarkdownPath(
        record.reference,
        `research evidence ${index + 1} reference`,
      );
    } else {
      reference = expectOpaqueId(record.reference, `research evidence ${index + 1} reference`);
    }
    return {
      id,
      kind,
      reference,
      contentSha256: expectSha256(
        record.contentSha256,
        `research evidence ${index + 1} content hash`,
      ),
    };
  });
}

function parseAcceptanceCriteria(value: unknown): WorkItemAcceptanceCriterionV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new DurableLinearContractError("Acceptance criteria require 1-20 entries.");
  }
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const record = expectPlainRecord(raw, `acceptance criterion ${index + 1}`);
    assertExactKeys(record, ["id", "text"], [], `acceptance criterion ${index + 1}`);
    if (typeof record.id !== "string" || !/^AC-[1-9][0-9]?$/.test(record.id)) {
      throw new DurableLinearContractError(
        `Acceptance criterion ${index + 1} id must match AC-1 through AC-99.`,
      );
    }
    if (ids.has(record.id)) {
      throw new DurableLinearContractError(`Acceptance criterion id ${record.id} is duplicated.`);
    }
    ids.add(record.id);
    const text = expectString(record.text, `acceptance criterion ${index + 1} text`, 1, 500, {
      allowNewlines: true,
      secretFree: true,
    });
    assertNoRawAuthority(text, `acceptance criterion ${index + 1} text`);
    return {
      id: record.id,
      text,
    };
  });
}

function assertKeys(record: Record<string, unknown>, signed: boolean): void {
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "artifactId",
      "originRunId",
      "vaultBindingKey",
      "notePath",
      "noteSha256",
      "noteReceiptId",
      "evidence",
      "acceptanceCriteria",
      "riskClass",
      "acceptedAt",
      "acceptedBy",
      ...(signed ? ["artifactFingerprint"] : []),
    ],
    [],
    "accepted research artifact",
  );
}
