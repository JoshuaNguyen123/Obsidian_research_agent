import { portableSha256Text } from "../../../packages/core-api/src/portableSha256";

import {
  parseRepositoryProfileV2,
  type RepositoryProfileV2,
} from "../../../extensions/code/repositories/RepositoryProfileV2";

export const TRUSTED_GITHUB_REPOSITORY_BINDING_VERSION = 1 as const;

const NAME = /^[A-Za-z0-9_.-]{1,100}$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface TrustedGitHubRepositoryBindingV1 {
  version: typeof TRUSTED_GITHUB_REPOSITORY_BINDING_VERSION;
  key: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  canonicalRepositoryRoot: string;
  githubHost: "github.com";
  owner: string;
  repository: string;
  repositoryId: number;
  defaultBranch: string;
  remoteName: "origin";
  agentBranchPrefix: "codex/";
  verifiedAccountId: number;
  verifiedAccountLogin: string;
  trustedAt: string;
  fingerprint: string;
}

/**
 * Narrow local publication proof used by the restart-safe companion package.
 * It deliberately excludes validation commands and is never accepted from a
 * remote job. The enclosing package and trusted binding fingerprint bind it.
 */
export interface TrustedGitHubPublicationProfileProofV1 {
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  canonicalRepositoryRoot: string;
  defaultBranch: string;
  forbidForcePush: true;
}

export interface CreateTrustedGitHubRepositoryBindingInputV1 {
  key: string;
  profile: RepositoryProfileV2;
  owner: string;
  repository: string;
  repositoryId: number;
  verifiedAccountId: number;
  verifiedAccountLogin: string;
  trustedAt: string;
}

export class TrustedGitHubRepositoryBindingErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedGitHubRepositoryBindingErrorV1";
  }
}

export function createTrustedGitHubRepositoryBindingV1(
  input: CreateTrustedGitHubRepositoryBindingInputV1,
): TrustedGitHubRepositoryBindingV1 {
  const profile = parseRepositoryProfileV2(input.profile);
  const evidence: Omit<TrustedGitHubRepositoryBindingV1, "fingerprint"> = {
    version: TRUSTED_GITHUB_REPOSITORY_BINDING_VERSION,
    key: identifier(input.key, "binding key"),
    repositoryProfileKey: profile.key,
    repositoryProfileFingerprint: sha256(profile),
    canonicalRepositoryRoot: profile.repositoryRoot,
    githubHost: "github.com",
    owner: githubLogin(input.owner, "GitHub owner"),
    repository: githubName(input.repository, "GitHub repository"),
    repositoryId: positiveInteger(input.repositoryId, "GitHub repository id"),
    defaultBranch: gitBranch(profile.defaultBranch, "default branch"),
    remoteName: "origin",
    agentBranchPrefix: "codex/",
    verifiedAccountId: positiveInteger(input.verifiedAccountId, "verified account id"),
    verifiedAccountLogin: githubLogin(input.verifiedAccountLogin),
    trustedAt: timestamp(input.trustedAt, "trustedAt"),
  };
  return { ...evidence, fingerprint: sha256(evidence) };
}

export function parseTrustedGitHubRepositoryBindingV1(
  value: unknown,
): TrustedGitHubRepositoryBindingV1 {
  const record = exactRecord(value, [
    "version", "key", "repositoryProfileKey", "repositoryProfileFingerprint",
    "canonicalRepositoryRoot", "githubHost", "owner", "repository",
    "repositoryId", "defaultBranch", "remoteName", "agentBranchPrefix",
    "verifiedAccountId", "verifiedAccountLogin", "trustedAt", "fingerprint",
  ], "trusted GitHub repository binding");
  if (record.version !== 1 || record.githubHost !== "github.com" || record.remoteName !== "origin" || record.agentBranchPrefix !== "codex/") {
    fail("Unsupported trusted GitHub repository binding contract.");
  }
  const result: TrustedGitHubRepositoryBindingV1 = {
    version: 1,
    key: identifier(record.key, "binding key"),
    repositoryProfileKey: identifier(record.repositoryProfileKey, "repository profile key"),
    repositoryProfileFingerprint: fingerprint(record.repositoryProfileFingerprint, "repository profile fingerprint"),
    canonicalRepositoryRoot: absolutePath(record.canonicalRepositoryRoot),
    githubHost: "github.com",
    owner: githubLogin(record.owner, "GitHub owner"),
    repository: githubName(record.repository, "GitHub repository"),
    repositoryId: positiveInteger(record.repositoryId, "GitHub repository id"),
    defaultBranch: gitBranch(record.defaultBranch, "default branch"),
    remoteName: "origin",
    agentBranchPrefix: "codex/",
    verifiedAccountId: positiveInteger(record.verifiedAccountId, "verified account id"),
    verifiedAccountLogin: githubLogin(record.verifiedAccountLogin),
    trustedAt: timestamp(record.trustedAt, "trustedAt"),
    fingerprint: fingerprint(record.fingerprint, "binding fingerprint"),
  };
  const { fingerprint: observed, ...evidence } = result;
  if (observed !== sha256(evidence)) fail("Trusted GitHub repository binding fingerprint does not match its evidence.");
  return result;
}

export function assertTrustedGitHubBindingMatchesProfileV1(
  bindingInput: unknown,
  profileInput: unknown,
): { binding: TrustedGitHubRepositoryBindingV1; profile: RepositoryProfileV2 } {
  const binding = parseTrustedGitHubRepositoryBindingV1(bindingInput);
  const profile = parseRepositoryProfileV2(profileInput);
  if (
    binding.repositoryProfileKey !== profile.key ||
    binding.repositoryProfileFingerprint !== sha256(profile) ||
    binding.canonicalRepositoryRoot !== profile.repositoryRoot ||
    binding.defaultBranch !== profile.defaultBranch
  ) {
    fail("Trusted GitHub repository binding no longer matches RepositoryProfileV2.");
  }
  if (profile.mergePolicy.forbidForcePush !== true) {
    fail("Trusted repository profile must forbid force pushes.");
  }
  return { binding, profile };
}

export function assertTrustedGitHubBindingMatchesPublicationProofV1(
  bindingInput: unknown,
  proofInput: TrustedGitHubPublicationProfileProofV1,
): {
  binding: TrustedGitHubRepositoryBindingV1;
  proof: TrustedGitHubPublicationProfileProofV1;
} {
  const binding = parseTrustedGitHubRepositoryBindingV1(bindingInput);
  if (!proofInput || typeof proofInput !== "object") {
    fail("Trusted GitHub publication profile proof is missing.");
  }
  const proof: TrustedGitHubPublicationProfileProofV1 = {
    repositoryProfileKey: identifier(
      proofInput.repositoryProfileKey,
      "repository profile key",
    ),
    repositoryProfileFingerprint: fingerprint(
      proofInput.repositoryProfileFingerprint,
      "repository profile fingerprint",
    ),
    canonicalRepositoryRoot: absolutePath(proofInput.canonicalRepositoryRoot),
    defaultBranch: gitBranch(proofInput.defaultBranch, "default branch"),
    forbidForcePush: proofInput.forbidForcePush,
  };
  if (
    proof.forbidForcePush !== true ||
    binding.repositoryProfileKey !== proof.repositoryProfileKey ||
    binding.repositoryProfileFingerprint !== proof.repositoryProfileFingerprint ||
    binding.canonicalRepositoryRoot !== proof.canonicalRepositoryRoot ||
    binding.defaultBranch !== proof.defaultBranch
  ) {
    fail("Trusted GitHub repository binding no longer matches its local publication proof.");
  }
  return { binding, proof };
}

/** Remote URLs are host-built only; callers cannot inject a remote or credentials. */
export function buildTrustedGitHubHttpsRemoteUrlV1(
  bindingInput: unknown,
): string {
  const binding = parseTrustedGitHubRepositoryBindingV1(bindingInput);
  return `https://github.com/${binding.owner}/${binding.repository}.git`;
}

function githubName(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME.test(value) || value === "." || value === "..") {
    fail(`${label} is invalid.`);
  }
  return value;
}

function githubLogin(value: unknown, label = "Verified GitHub account login"): string {
  if (typeof value !== "string" || !LOGIN.test(value) || value.endsWith("-")) fail(`${label} is invalid.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,255}$/u.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function gitBranch(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..") || value.includes("@{") || /[~^:?*[\\\s\]]/u.test(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function absolutePath(value: unknown): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 2048 || /[\0\r\n]/u.test(value) || (!/^[A-Za-z]:[\\/]/u.test(value) && !value.startsWith("/"))) {
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
    fail(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a SHA-256 fingerprint.`);
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) fail(`${label} does not match its closed contract.`);
  return record;
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
  throw new TrustedGitHubRepositoryBindingErrorV1(message);
}
