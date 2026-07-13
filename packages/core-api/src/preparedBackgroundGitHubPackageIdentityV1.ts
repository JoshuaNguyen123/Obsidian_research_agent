import { portableSha256Text } from "./portableSha256";
import {
  GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
  GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1,
  GITHUB_PULL_REQUEST_MERGE_OPERATION_V1,
  GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1,
  GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1,
  type PreparedBackgroundGitHubOperationV1,
} from "./preparedBackgroundGitHubActionV1";

export const PREPARED_BACKGROUND_GITHUB_PACKAGE_IDENTITY_VERSION = 1 as const;

export interface PreparedBackgroundGitHubPackageIdentityV1 {
  version: typeof PREPARED_BACKGROUND_GITHUB_PACKAGE_IDENTITY_VERSION;
  kind: "prepared_background_github_package_identity";
  packageId: string;
  packageFingerprint: string;
  actionFingerprint: string;
  preparedActionFingerprint: string;
  operation: PreparedBackgroundGitHubOperationV1;
  publicationId: string;
  repositoryBindingFingerprint: string;
  repositoryProfileFingerprint: string;
  verifiedAccountId: number;
  backgroundAuthorizationFingerprint: string;
  preparedAt: string;
  expiresAt: string;
  fingerprint: string;
}

export type PreparedBackgroundGitHubPackageIdentityDraftV1 = Omit<
  PreparedBackgroundGitHubPackageIdentityV1,
  "version" | "kind" | "fingerprint"
>;

export class PreparedBackgroundGitHubPackageIdentityErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedBackgroundGitHubPackageIdentityErrorV1";
  }
}

export function createPreparedBackgroundGitHubPackageIdentityV1(
  draft: PreparedBackgroundGitHubPackageIdentityDraftV1,
): PreparedBackgroundGitHubPackageIdentityV1 {
  const evidence = normalize({
    version: PREPARED_BACKGROUND_GITHUB_PACKAGE_IDENTITY_VERSION,
    kind: "prepared_background_github_package_identity",
    ...draft,
  });
  return { ...evidence, fingerprint: fingerprintOf(evidence) };
}

export function parsePreparedBackgroundGitHubPackageIdentityV1(
  value: unknown,
): PreparedBackgroundGitHubPackageIdentityV1 {
  const record = exactRecord(value, [
    "version", "kind", "packageId", "packageFingerprint", "actionFingerprint",
    "preparedActionFingerprint", "operation", "publicationId",
    "repositoryBindingFingerprint", "repositoryProfileFingerprint",
    "verifiedAccountId", "backgroundAuthorizationFingerprint", "preparedAt",
    "expiresAt", "fingerprint",
  ], "prepared background GitHub package identity");
  const observed = sha(record.fingerprint, "identity fingerprint");
  const { fingerprint: _ignored, ...unsigned } = record;
  const evidence = normalize(unsigned);
  if (observed !== fingerprintOf(evidence)) {
    fail("Prepared background GitHub package identity fingerprint does not match its evidence.");
  }
  return { ...evidence, fingerprint: observed };
}

function normalize(
  value: unknown,
): Omit<PreparedBackgroundGitHubPackageIdentityV1, "fingerprint"> {
  const record = exactRecord(value, [
    "version", "kind", "packageId", "packageFingerprint", "actionFingerprint",
    "preparedActionFingerprint", "operation", "publicationId",
    "repositoryBindingFingerprint", "repositoryProfileFingerprint",
    "verifiedAccountId", "backgroundAuthorizationFingerprint", "preparedAt",
    "expiresAt",
  ], "prepared background GitHub package identity evidence");
  if (
    record.version !== PREPARED_BACKGROUND_GITHUB_PACKAGE_IDENTITY_VERSION ||
    record.kind !== "prepared_background_github_package_identity"
  ) fail("Unsupported prepared background GitHub package identity contract.");
  const preparedAt = timestamp(record.preparedAt, "preparedAt");
  const expiresAt = timestamp(record.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(preparedAt)) fail("GitHub package identity expiry is invalid.");
  return {
    version: PREPARED_BACKGROUND_GITHUB_PACKAGE_IDENTITY_VERSION,
    kind: "prepared_background_github_package_identity",
    packageId: identifier(record.packageId, "package id"),
    packageFingerprint: sha(record.packageFingerprint, "package fingerprint"),
    actionFingerprint: sha(record.actionFingerprint, "action fingerprint"),
    preparedActionFingerprint: sha(record.preparedActionFingerprint, "prepared action fingerprint"),
    operation: operation(record.operation),
    publicationId: identifier(record.publicationId, "publication id"),
    repositoryBindingFingerprint: sha(record.repositoryBindingFingerprint, "repository binding fingerprint"),
    repositoryProfileFingerprint: sha(record.repositoryProfileFingerprint, "repository profile fingerprint"),
    verifiedAccountId: positiveInteger(record.verifiedAccountId, "verified account id"),
    backgroundAuthorizationFingerprint: sha(record.backgroundAuthorizationFingerprint, "background authorization fingerprint"),
    preparedAt,
    expiresAt,
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
  if (typeof value !== "string" || !allowed.includes(value as PreparedBackgroundGitHubOperationV1)) {
    fail("GitHub package identity operation is outside the fixed catalog.");
  }
  return value as PreparedBackgroundGitHubOperationV1;
}

function exactRecord<const T extends readonly string[]>(value: unknown, keys: T, label: string): Record<T[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} does not match its closed contract.`);
  return record as Record<T[number], unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) fail(`${label} is invalid.`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) fail(`${label} must be SHA-256.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${label} must be a positive integer.`);
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) fail(`${label} must be canonical ISO time.`);
  return value;
}

function fingerprintOf(value: unknown): string {
  return `sha256:${portableSha256Text(canonicalJson(value))}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail("Unsafe number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") fail("Unsupported identity value.");
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function fail(message: string): never {
  throw new PreparedBackgroundGitHubPackageIdentityErrorV1(message);
}
