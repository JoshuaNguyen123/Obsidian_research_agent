import {
  GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
  GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1,
  GITHUB_PULL_REQUEST_MERGE_OPERATION_V1,
  GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1,
  GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1,
  fingerprintBackgroundGitHubValueV1,
  type PreparedBackgroundGitHubOperationV1,
} from "./preparedBackgroundGitHubActionV1";

export interface BackgroundGitHubVerifiedResultV1 {
  version: 1;
  kind: "verified_background_github_action";
  operation: PreparedBackgroundGitHubOperationV1;
  publicationId: string;
  repositoryBindingFingerprint: string;
  verifiedAccountId: number;
  checkpointFingerprint: string;
  headSha: string | null;
  pullRequestNumber: number | null;
  mergeSha: string | null;
  autoMergeEnabled: boolean;
  verifiedAt: string;
  fingerprint: string;
}

export function createBackgroundGitHubVerifiedResultV1(
  input: Omit<
    BackgroundGitHubVerifiedResultV1,
    "version" | "kind" | "fingerprint"
  >,
): BackgroundGitHubVerifiedResultV1 {
  const evidence = normalizeVerifiedResult({
    version: 1,
    kind: "verified_background_github_action",
    ...input,
  });
  return {
    ...evidence,
    fingerprint: fingerprintBackgroundGitHubValueV1(evidence),
  };
}

/** Environment-neutral closed parser for core, companion, and extension boundaries. */
export function parseBackgroundGitHubVerifiedResultV1(
  value: unknown,
): BackgroundGitHubVerifiedResultV1 {
  const record = exactRecord(value, [
    "version", "kind", "operation", "publicationId",
    "repositoryBindingFingerprint", "verifiedAccountId", "checkpointFingerprint",
    "headSha", "pullRequestNumber", "mergeSha", "autoMergeEnabled", "verifiedAt",
    "fingerprint",
  ], "verified background GitHub result");
  const observed = sha256(record.fingerprint, "verified result fingerprint");
  const { fingerprint: _ignored, ...unsigned } = record;
  const evidence = normalizeVerifiedResult(unsigned);
  if (observed !== fingerprintBackgroundGitHubValueV1(evidence)) {
    throw new Error("Verified background GitHub result fingerprint is invalid.");
  }
  return { ...evidence, fingerprint: observed };
}

function normalizeVerifiedResult(
  value: unknown,
): Omit<BackgroundGitHubVerifiedResultV1, "fingerprint"> {
  const record = exactRecord(value, [
    "version", "kind", "operation", "publicationId",
    "repositoryBindingFingerprint", "verifiedAccountId", "checkpointFingerprint",
    "headSha", "pullRequestNumber", "mergeSha", "autoMergeEnabled", "verifiedAt",
  ], "verified background GitHub result evidence");
  if (
    record.version !== 1 ||
    record.kind !== "verified_background_github_action"
  ) {
    throw new Error("Unsupported verified background GitHub result.");
  }
  if (typeof record.autoMergeEnabled !== "boolean") {
    throw new Error("Background GitHub auto-merge proof must be boolean.");
  }
  return {
    version: 1,
    kind: "verified_background_github_action",
    operation: operation(record.operation),
    publicationId: identifier(record.publicationId, "publication id"),
    repositoryBindingFingerprint: sha256(
      record.repositoryBindingFingerprint,
      "repository binding fingerprint",
    ),
    verifiedAccountId: integer(
      record.verifiedAccountId,
      "verified account id",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    checkpointFingerprint: sha256(
      record.checkpointFingerprint,
      "checkpoint fingerprint",
    ),
    headSha: nullableSha(record.headSha, "head SHA"),
    pullRequestNumber:
      record.pullRequestNumber === null
        ? null
        : integer(
            record.pullRequestNumber,
            "pull request number",
            1,
            Number.MAX_SAFE_INTEGER,
          ),
    mergeSha: nullableSha(record.mergeSha, "merge SHA"),
    autoMergeEnabled: record.autoMergeEnabled,
    verifiedAt: timestamp(record.verifiedAt, "verifiedAt"),
  };
}

function operation(value: unknown): PreparedBackgroundGitHubOperationV1 {
  const allowed: PreparedBackgroundGitHubOperationV1[] = [
    GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1,
    GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
    GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1,
    GITHUB_PULL_REQUEST_MERGE_OPERATION_V1,
    GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1,
  ];
  if (
    typeof value !== "string" ||
    !allowed.includes(value as PreparedBackgroundGitHubOperationV1)
  ) {
    throw new Error("Background GitHub operation is outside the fixed catalog.");
  }
  return value as PreparedBackgroundGitHubOperationV1;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} does not match its closed contract.`);
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function nullableSha(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
