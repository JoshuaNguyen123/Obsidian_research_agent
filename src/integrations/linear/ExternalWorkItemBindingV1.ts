import {
  assertCanonicalContract,
  assertExactKeys,
  constantTimeFingerprintEqual,
  DurableLinearContractError,
  expectIsoTimestamp,
  expectLogicalKey,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
  fingerprintContract,
  parseHttpUrl,
} from "./LinearContractSupport";

export const EXTERNAL_WORK_ITEM_BINDING_SCHEMA_VERSION = 1 as const;

export interface ExternalWorkItemBindingV1 {
  schemaVersion: typeof EXTERNAL_WORK_ITEM_BINDING_SCHEMA_VERSION;
  bindingId: string;
  provider: "linear";
  originRunId: string;
  workspaceId: string;
  teamId: string;
  issueId: string;
  issueIdentifier: string;
  issueUrl: string;
  issueUpdatedAt: string;
  workItemFingerprint: string;
  acceptedResearchArtifactFingerprint: string;
  verifiedAt: string;
  bindingFingerprint: string;
}

export type ExternalWorkItemBindingV1Unsigned = Omit<
  ExternalWorkItemBindingV1,
  "bindingFingerprint"
>;

export function createExternalWorkItemBindingV1(
  value: ExternalWorkItemBindingV1Unsigned,
): ExternalWorkItemBindingV1 {
  const unsigned = parseUnsigned(value);
  return {
    ...unsigned,
    bindingFingerprint: fingerprintExternalWorkItemBindingV1(unsigned),
  };
}

export function parseExternalWorkItemBindingV1(value: unknown): ExternalWorkItemBindingV1 {
  const record = expectPlainRecord(value, "external work item binding");
  assertKeys(record, true);
  const { bindingFingerprint: rawFingerprint, ...rawUnsigned } = record;
  const unsigned = parseUnsigned(rawUnsigned);
  assertCanonicalContract(rawUnsigned, unsigned, "External work item binding");
  const bindingFingerprint = expectSha256(
    rawFingerprint,
    "external work item binding fingerprint",
  );
  const expected = fingerprintExternalWorkItemBindingV1(unsigned);
  if (!constantTimeFingerprintEqual(bindingFingerprint, expected)) {
    throw new DurableLinearContractError(
      "External work item binding fingerprint does not match its canonical payload.",
    );
  }
  return { ...unsigned, bindingFingerprint };
}

export function fingerprintExternalWorkItemBindingV1(
  value: ExternalWorkItemBindingV1Unsigned | ExternalWorkItemBindingV1,
): string {
  const record = expectPlainRecord(value, "external work item binding fingerprint input");
  const { bindingFingerprint: _ignored, ...rawUnsigned } = record;
  return fingerprintContract(parseUnsigned(rawUnsigned));
}

function parseUnsigned(value: unknown): ExternalWorkItemBindingV1Unsigned {
  const record = expectPlainRecord(value, "external work item binding");
  assertKeys(record, false);
  if (record.schemaVersion !== EXTERNAL_WORK_ITEM_BINDING_SCHEMA_VERSION) {
    throw new DurableLinearContractError("Unsupported external work item binding version.");
  }
  if (record.provider !== "linear") {
    throw new DurableLinearContractError("External work item binding provider must be Linear.");
  }
  const issueUrl = parseLinearIssueUrl(record.issueUrl);
  const issueUpdatedAt = expectIsoTimestamp(record.issueUpdatedAt, "Linear issue updated at");
  const verifiedAt = expectIsoTimestamp(record.verifiedAt, "Linear binding verified at");
  if (Date.parse(verifiedAt) < Date.parse(issueUpdatedAt)) {
    throw new DurableLinearContractError(
      "Linear binding verification cannot predate the observed issue update.",
    );
  }
  return {
    schemaVersion: EXTERNAL_WORK_ITEM_BINDING_SCHEMA_VERSION,
    bindingId: expectLogicalKey(record.bindingId, "binding id", 160),
    provider: "linear",
    originRunId: expectOpaqueId(record.originRunId, "origin run id"),
    workspaceId: expectOpaqueId(record.workspaceId, "Linear workspace id"),
    teamId: expectOpaqueId(record.teamId, "Linear team id"),
    issueId: expectOpaqueId(record.issueId, "Linear issue id"),
    issueIdentifier: parseLinearIssueIdentifier(record.issueIdentifier),
    issueUrl,
    issueUpdatedAt,
    workItemFingerprint: expectSha256(record.workItemFingerprint, "work item fingerprint"),
    acceptedResearchArtifactFingerprint: expectSha256(
      record.acceptedResearchArtifactFingerprint,
      "accepted research artifact fingerprint",
    ),
    verifiedAt,
  };
}

function parseLinearIssueIdentifier(value: unknown): string {
  const identifier = expectOpaqueId(value, "Linear issue identifier", 80);
  if (!/^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,9}$/.test(identifier)) {
    throw new DurableLinearContractError(
      "Linear issue identifier must be an uppercase team key and issue number.",
    );
  }
  return identifier;
}

function parseLinearIssueUrl(value: unknown): string {
  const normalized = parseHttpUrl(value, "Linear issue URL");
  const url = new URL(normalized);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "linear.app" && !url.hostname.endsWith(".linear.app")) ||
    url.hash ||
    url.search
  ) {
    throw new DurableLinearContractError(
      "Linear issue URL must be a credential-free canonical linear.app HTTPS URL.",
    );
  }
  return url.toString();
}

function assertKeys(record: Record<string, unknown>, signed: boolean): void {
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "bindingId",
      "provider",
      "originRunId",
      "workspaceId",
      "teamId",
      "issueId",
      "issueIdentifier",
      "issueUrl",
      "issueUpdatedAt",
      "workItemFingerprint",
      "acceptedResearchArtifactFingerprint",
      "verifiedAt",
      ...(signed ? ["bindingFingerprint"] : []),
    ],
    [],
    "external work item binding",
  );
}
