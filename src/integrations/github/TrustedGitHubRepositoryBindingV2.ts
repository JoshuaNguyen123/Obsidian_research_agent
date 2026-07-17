import { portableSha256Text } from "../../../packages/core-api/src/portableSha256";
import {
  parseRepositoryProfileV2,
  type RepositoryProfileV2,
} from "../../../extensions/code/repositories/RepositoryProfileV2";
import {
  parseTrustedGitHubRepositoryBindingV1,
  type TrustedGitHubRepositoryBindingV1,
} from "./TrustedGitHubRepositoryBindingV1";
import type { GitHubRepositoryRecord } from "./GitHubRestClient";

export const TRUSTED_GITHUB_REPOSITORY_BINDING_V2_VERSION = 2 as const;
export const GITHUB_REPOSITORY_VISIBILITY_MAX_AGE_MS = 5 * 60_000;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface TrustedGitHubRepositoryBindingV2 {
  version: typeof TRUSTED_GITHUB_REPOSITORY_BINDING_V2_VERSION;
  key: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  canonicalRepositoryRoot: string;
  githubHost: "github.com";
  owner: string;
  repository: string;
  repositoryId: number;
  defaultBranch: string;
  visibility: "private";
  repositoryReadbackFingerprint: string;
  observedAt: string;
  remoteName: "origin";
  agentBranchPrefix: "codex/";
  verifiedAccountId: number;
  verifiedAccountLogin: string;
  trustedAt: string;
  fingerprint: string;
}

export interface CreateTrustedGitHubRepositoryBindingInputV2 {
  key: string;
  profile: RepositoryProfileV2;
  owner: string;
  repository: string;
  repositoryReadback: GitHubRepositoryRecord;
  observedAt: string;
  verifiedAccountId: number;
  verifiedAccountLogin: string;
  trustedAt: string;
}

export class TrustedGitHubRepositoryBindingErrorV2 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedGitHubRepositoryBindingErrorV2";
  }
}

export function createTrustedGitHubRepositoryBindingV2(
  input: CreateTrustedGitHubRepositoryBindingInputV2,
): TrustedGitHubRepositoryBindingV2 {
  const profile = parseRepositoryProfileV2(input.profile);
  const owner = githubLogin(input.owner, "GitHub owner");
  const repository = githubName(input.repository, "GitHub repository");
  const observedAt = timestamp(input.observedAt, "repository observation time");
  const readback = normalizePrivateReadback(
    input.repositoryReadback,
    owner,
    repository,
    profile.defaultBranch,
  );
  const unsigned: Omit<TrustedGitHubRepositoryBindingV2, "fingerprint"> = {
    version: TRUSTED_GITHUB_REPOSITORY_BINDING_V2_VERSION,
    key: logicalKey(input.key, "binding key"),
    repositoryProfileKey: profile.key,
    repositoryProfileFingerprint: sha256(profile),
    canonicalRepositoryRoot: absolutePath(profile.repositoryRoot),
    githubHost: "github.com",
    owner,
    repository,
    repositoryId: readback.id,
    defaultBranch: readback.defaultBranch,
    visibility: "private",
    repositoryReadbackFingerprint: fingerprintGitHubRepositoryReadbackV2(readback),
    observedAt,
    remoteName: "origin",
    agentBranchPrefix: "codex/",
    verifiedAccountId: positiveInteger(input.verifiedAccountId, "verified account id"),
    verifiedAccountLogin: githubLogin(input.verifiedAccountLogin, "verified account login"),
    trustedAt: timestamp(input.trustedAt, "trustedAt"),
  };
  return { ...unsigned, fingerprint: fingerprintTrustedGitHubRepositoryBindingV2(unsigned) };
}

export function upgradeTrustedGitHubRepositoryBindingV1ToV2(input: {
  binding: unknown;
  repositoryReadback: GitHubRepositoryRecord;
  observedAt: string;
}): TrustedGitHubRepositoryBindingV2 {
  const legacy = parseTrustedGitHubRepositoryBindingV1(input.binding);
  const observedAt = timestamp(input.observedAt, "repository observation time");
  const readback = normalizePrivateReadback(
    input.repositoryReadback,
    legacy.owner,
    legacy.repository,
    legacy.defaultBranch,
  );
  if (readback.id !== legacy.repositoryId) {
    fail("GitHub repository readback ID does not match the legacy trusted binding.");
  }
  const unsigned: Omit<TrustedGitHubRepositoryBindingV2, "fingerprint"> = {
    version: 2,
    key: legacy.key,
    repositoryProfileKey: legacy.repositoryProfileKey,
    repositoryProfileFingerprint: legacy.repositoryProfileFingerprint,
    canonicalRepositoryRoot: legacy.canonicalRepositoryRoot,
    githubHost: "github.com",
    owner: legacy.owner,
    repository: legacy.repository,
    repositoryId: legacy.repositoryId,
    defaultBranch: legacy.defaultBranch,
    visibility: "private",
    repositoryReadbackFingerprint: fingerprintGitHubRepositoryReadbackV2(readback),
    observedAt,
    remoteName: "origin",
    agentBranchPrefix: "codex/",
    verifiedAccountId: legacy.verifiedAccountId,
    verifiedAccountLogin: legacy.verifiedAccountLogin,
    trustedAt: legacy.trustedAt,
  };
  return { ...unsigned, fingerprint: fingerprintTrustedGitHubRepositoryBindingV2(unsigned) };
}

export function parseTrustedGitHubRepositoryBindingV2(
  value: unknown,
): TrustedGitHubRepositoryBindingV2 {
  const record = exactRecord(value, [
    "version", "key", "repositoryProfileKey", "repositoryProfileFingerprint",
    "canonicalRepositoryRoot", "githubHost", "owner", "repository",
    "repositoryId", "defaultBranch", "visibility", "repositoryReadbackFingerprint",
    "observedAt", "remoteName", "agentBranchPrefix", "verifiedAccountId",
    "verifiedAccountLogin", "trustedAt", "fingerprint",
  ], "trusted GitHub repository binding v2");
  if (
    record.version !== 2 ||
    record.githubHost !== "github.com" ||
    record.visibility !== "private" ||
    record.remoteName !== "origin" ||
    record.agentBranchPrefix !== "codex/"
  ) {
    fail("Unsupported trusted GitHub repository binding v2 contract.");
  }
  const result: TrustedGitHubRepositoryBindingV2 = {
    version: 2,
    key: logicalKey(record.key, "binding key"),
    repositoryProfileKey: logicalKey(record.repositoryProfileKey, "repository profile key"),
    repositoryProfileFingerprint: fingerprint(record.repositoryProfileFingerprint, "repository profile fingerprint"),
    canonicalRepositoryRoot: absolutePath(record.canonicalRepositoryRoot),
    githubHost: "github.com",
    owner: githubLogin(record.owner, "GitHub owner"),
    repository: githubName(record.repository, "GitHub repository"),
    repositoryId: positiveInteger(record.repositoryId, "repository id"),
    defaultBranch: gitBranch(record.defaultBranch, "default branch"),
    visibility: "private",
    repositoryReadbackFingerprint: fingerprint(record.repositoryReadbackFingerprint, "repository readback fingerprint"),
    observedAt: timestamp(record.observedAt, "repository observation time"),
    remoteName: "origin",
    agentBranchPrefix: "codex/",
    verifiedAccountId: positiveInteger(record.verifiedAccountId, "verified account id"),
    verifiedAccountLogin: githubLogin(record.verifiedAccountLogin, "verified account login"),
    trustedAt: timestamp(record.trustedAt, "trustedAt"),
    fingerprint: fingerprint(record.fingerprint, "binding fingerprint"),
  };
  if (result.fingerprint !== fingerprintTrustedGitHubRepositoryBindingV2(result)) {
    fail("Trusted GitHub repository binding v2 fingerprint does not match its evidence.");
  }
  return result;
}

export function parseTrustedGitHubRepositoryBindingMapV2(
  value: unknown,
): Record<string, TrustedGitHubRepositoryBindingV2> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: Record<string, TrustedGitHubRepositoryBindingV2> = {};
  for (const [profileKey, raw] of Object.entries(
    value as Record<string, unknown>,
  )) {
    try {
      const binding = parseTrustedGitHubRepositoryBindingV2(raw);
      if (binding.repositoryProfileKey === profileKey) {
        parsed[profileKey] = binding;
      }
    } catch {
      // Invalid persisted bindings are quarantined rather than becoming
      // publication authority. A fresh provider readback can replace them.
    }
  }
  return parsed;
}

export function fingerprintTrustedGitHubRepositoryBindingV2(
  value: Omit<TrustedGitHubRepositoryBindingV2, "fingerprint"> | TrustedGitHubRepositoryBindingV2,
): string {
  const {
    fingerprint: _fingerprint,
    observedAt: _observedAt,
    trustedAt: _trustedAt,
    ...stable
  } = value as TrustedGitHubRepositoryBindingV2;
  return sha256(stable);
}

export function fingerprintGitHubRepositoryReadbackV2(
  readback: GitHubRepositoryRecord,
): string {
  return sha256({
    id: positiveInteger(readback.id, "repository id"),
    fullName: fullName(readback.fullName),
    htmlUrl: httpsUrl(readback.htmlUrl),
    defaultBranch: gitBranch(readback.defaultBranch, "default branch"),
    private: readback.private === true,
    archived: readback.archived === true,
  });
}

export function assertFreshPrivateGitHubRepositoryBindingV2(
  value: unknown,
  options: { now?: Date; maxAgeMs?: number } = {},
): TrustedGitHubRepositoryBindingV2 {
  const binding = parseTrustedGitHubRepositoryBindingV2(value);
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? GITHUB_REPOSITORY_VISIBILITY_MAX_AGE_MS;
  const age = now.getTime() - Date.parse(binding.observedAt);
  if (age < -5_000 || age > maxAgeMs) {
    fail("Private GitHub repository visibility evidence is stale; perform a fresh provider readback.");
  }
  return binding;
}

/** Exact approvals are invalid if visibility was stale or the binding changed. */
export function assertGitHubApprovalBindingFreshV2(input: {
  binding: unknown;
  approvedBindingFingerprint: string;
  preparedAt: string;
  now?: Date;
  maxAgeMs?: number;
}): TrustedGitHubRepositoryBindingV2 {
  const binding = parseTrustedGitHubRepositoryBindingV2(input.binding);
  const approved = fingerprint(input.approvedBindingFingerprint, "approved binding fingerprint");
  if (approved !== binding.fingerprint) {
    fail("GitHub approval was prepared against a different or legacy visibility binding.");
  }
  const preparedAt = timestamp(input.preparedAt, "GitHub approval preparedAt");
  const visibilityAgeAtPreparation =
    Date.parse(preparedAt) - Date.parse(binding.observedAt);
  if (
    visibilityAgeAtPreparation < -5_000 ||
    visibilityAgeAtPreparation >
      (input.maxAgeMs ?? GITHUB_REPOSITORY_VISIBILITY_MAX_AGE_MS)
  ) {
    fail("GitHub approval was prepared against stale private-visibility evidence.");
  }
  return assertFreshPrivateGitHubRepositoryBindingV2(binding, {
    now: input.now,
    maxAgeMs: input.maxAgeMs,
  });
}

export type CompatibleTrustedGitHubRepositoryBinding =
  | TrustedGitHubRepositoryBindingV1
  | TrustedGitHubRepositoryBindingV2;

function normalizePrivateReadback(
  value: GitHubRepositoryRecord,
  owner: string,
  repository: string,
  defaultBranch: string,
): GitHubRepositoryRecord {
  if (!value || typeof value !== "object") fail("GitHub repository readback is missing.");
  const observedOwnerRepo = fullName(value.fullName);
  if (
    value.private !== true ||
    value.archived === true ||
    observedOwnerRepo.toLowerCase() !== `${owner}/${repository}`.toLowerCase() ||
    gitBranch(value.defaultBranch, "readback default branch") !== defaultBranch
  ) {
    fail("GitHub repository readback is not the exact active private repository binding.");
  }
  return {
    id: positiveInteger(value.id, "repository id"),
    fullName: observedOwnerRepo,
    htmlUrl: httpsUrl(value.htmlUrl),
    defaultBranch: value.defaultBranch,
    private: true,
    archived: false,
  };
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(`${label} does not match its closed contract.`);
  }
  return record;
}

function logicalKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,255}$/u.test(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function githubName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/u.test(value) || value === "." || value === "..") {
    fail(`${label} is invalid.`);
  }
  return value;
}

function githubLogin(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(value) || value.endsWith("-")) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function fullName(value: unknown): string {
  if (typeof value !== "string") fail("GitHub repository full name is invalid.");
  const [owner, repository, extra] = value.split("/");
  if (!owner || !repository || extra) fail("GitHub repository full name is invalid.");
  return `${githubLogin(owner, "repository owner")}/${githubName(repository, "repository name")}`;
}

function gitBranch(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..") || value.includes("@{") || /[~^:?*[\\\s\]]/u.test(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function absolutePath(value: unknown): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 2_048 || /[\0\r\n]/u.test(value) || (!/^[A-Za-z]:[\\/]/u.test(value) && !value.startsWith("/"))) {
    fail("Canonical repository root must be an absolute host path.");
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive integer.`);
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail(`${label} must be a canonical UTC ISO timestamp.`);
  }
  return value;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a SHA-256 fingerprint.`);
  return value;
}

function httpsUrl(value: unknown): string {
  if (typeof value !== "string") fail("GitHub repository URL is invalid.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("GitHub repository URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hostname !== "github.com") {
    fail("GitHub repository URL must be a credential-free github.com HTTPS URL.");
  }
  return url.toString();
}

function sha256(value: unknown): string {
  return `sha256:${portableSha256Text(canonicalJson(value))}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail("Binding evidence contains an unsafe number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") fail("Binding evidence contains an unsupported value.");
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function fail(message: string): never {
  throw new TrustedGitHubRepositoryBindingErrorV2(message);
}
