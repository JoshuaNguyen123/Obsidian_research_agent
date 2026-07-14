import { portableSha256Text } from "./portableSha256";

export const PREPARED_BACKGROUND_CODE_PACKAGE_IDENTITY_VERSION = 1 as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

/** Remote-safe pointer to a local companion package; never executable state. */
export interface PreparedBackgroundCodePackageIdentityV1 {
  version: typeof PREPARED_BACKGROUND_CODE_PACKAGE_IDENTITY_VERSION;
  kind: "prepared_background_code_package_identity";
  packageId: string;
  packageFingerprint: string;
  executionPlanFingerprint: string;
  handoffFingerprint: string;
  workspaceId: string;
  workspaceBindingFingerprint: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  consumedActionAuthorityFingerprint: string;
  backgroundAuthorizationFingerprint: string;
  preparedAt: string;
  expiresAt: string;
  fingerprint: string;
}

export type PreparedBackgroundCodePackageIdentityDraftV1 = Omit<
  PreparedBackgroundCodePackageIdentityV1,
  "version" | "kind" | "fingerprint"
>;

export class PreparedBackgroundCodePackageIdentityErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedBackgroundCodePackageIdentityErrorV1";
  }
}

export function createPreparedBackgroundCodePackageIdentityV1(
  draft: PreparedBackgroundCodePackageIdentityDraftV1,
): PreparedBackgroundCodePackageIdentityV1 {
  const evidence = normalize({
    version: PREPARED_BACKGROUND_CODE_PACKAGE_IDENTITY_VERSION,
    kind: "prepared_background_code_package_identity",
    ...draft,
  });
  return { ...evidence, fingerprint: fingerprintOf(evidence) };
}

export function parsePreparedBackgroundCodePackageIdentityV1(
  value: unknown,
): PreparedBackgroundCodePackageIdentityV1 {
  const record = exactRecord(value, [
    "version", "kind", "packageId", "packageFingerprint",
    "executionPlanFingerprint", "handoffFingerprint", "workspaceId",
    "workspaceBindingFingerprint", "repositoryProfileKey",
    "repositoryProfileFingerprint", "consumedActionAuthorityFingerprint",
    "backgroundAuthorizationFingerprint", "preparedAt", "expiresAt", "fingerprint",
  ], "prepared background Code package identity");
  const observed = sha(record.fingerprint, "identity fingerprint");
  const { fingerprint: _ignored, ...evidenceRecord } = record;
  const evidence = normalize(evidenceRecord);
  if (observed !== fingerprintOf(evidence)) fail("Prepared background Code package identity fingerprint does not match its evidence.");
  return { ...evidence, fingerprint: observed };
}

function normalize(value: unknown): Omit<PreparedBackgroundCodePackageIdentityV1, "fingerprint"> {
  const record = exactRecord(value, [
    "version", "kind", "packageId", "packageFingerprint",
    "executionPlanFingerprint", "handoffFingerprint", "workspaceId",
    "workspaceBindingFingerprint", "repositoryProfileKey",
    "repositoryProfileFingerprint", "consumedActionAuthorityFingerprint",
    "backgroundAuthorizationFingerprint", "preparedAt", "expiresAt",
  ], "prepared background Code package identity evidence");
  if (record.version !== 1 || record.kind !== "prepared_background_code_package_identity") fail("Unsupported prepared background Code package identity contract.");
  const preparedAt = timestamp(record.preparedAt, "preparedAt");
  const expiresAt = timestamp(record.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(preparedAt)) fail("Prepared background Code package identity expiry is invalid.");
  return {
    version: 1,
    kind: "prepared_background_code_package_identity",
    packageId: identifier(record.packageId, "package id"),
    packageFingerprint: sha(record.packageFingerprint, "package fingerprint"),
    executionPlanFingerprint: sha(record.executionPlanFingerprint, "execution plan fingerprint"),
    handoffFingerprint: sha(record.handoffFingerprint, "handoff fingerprint"),
    workspaceId: identifier(record.workspaceId, "workspace id"),
    workspaceBindingFingerprint: sha(record.workspaceBindingFingerprint, "workspace binding fingerprint"),
    repositoryProfileKey: identifier(record.repositoryProfileKey, "repository profile key"),
    repositoryProfileFingerprint: sha(record.repositoryProfileFingerprint, "repository profile fingerprint"),
    consumedActionAuthorityFingerprint: sha(record.consumedActionAuthorityFingerprint, "consumed action authority fingerprint"),
    backgroundAuthorizationFingerprint: sha(record.backgroundAuthorizationFingerprint, "background authorization fingerprint"),
    preparedAt,
    expiresAt,
  };
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
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(`${label} is invalid.`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a SHA-256 fingerprint.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) fail(`${label} must be a canonical ISO timestamp.`);
  return value;
}

function fingerprintOf(value: unknown): string {
  return `sha256:${portableSha256Text(canonicalJson(value))}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail("Prepared background Code package identity contains an unsafe number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") fail("Prepared background Code package identity contains an unsupported value.");
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function fail(message: string): never {
  throw new PreparedBackgroundCodePackageIdentityErrorV1(message);
}
