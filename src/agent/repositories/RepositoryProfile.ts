import type {
  ValidationCommand,
  ValidationProfile,
} from "../../orchestrator/gitWorktreeManager";

export const REPOSITORY_PROFILE_SCHEMA_VERSION = 1 as const;

export interface RepositoryPromotionPolicyV1 {
  localBasePromotion: "disabled" | "guarded_fast_forward";
  completionProof: "local_verified" | "draft_pr" | "merged_pr";
  githubRepository: string | null;
  requiredChecks: string[];
}

export interface RepositoryProfileV1 {
  schemaVersion: typeof REPOSITORY_PROFILE_SCHEMA_VERSION;
  /** Stable key stored in executable work-item contracts. */
  key: string;
  displayName: string;
  /** Absolute local checkout root. No filesystem access occurs while parsing. */
  repositoryRoot: string;
  defaultBranch: string;
  /** Repository-relative prefixes an autonomous coding run may mutate. */
  allowedPathPrefixes: string[];
  validationProfile: ValidationProfile;
  /** Optional immutable runtime pins used when migrating this trusted V1 profile. */
  runtimeDigests?: Partial<Record<"node" | "python", string>>;
  promotionPolicy: RepositoryPromotionPolicyV1;
}

export interface RepositoryProfileRegistryV1 {
  schemaVersion: typeof REPOSITORY_PROFILE_SCHEMA_VERSION;
  profiles: Record<string, RepositoryProfileV1>;
}

export type RepositoryProfileInput = Omit<
  RepositoryProfileV1,
  "schemaVersion" | "promotionPolicy"
> & {
  schemaVersion?: typeof REPOSITORY_PROFILE_SCHEMA_VERSION;
  promotionPolicy?: Partial<RepositoryPromotionPolicyV1>;
};

export class RepositoryProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryProfileError";
  }
}

export function createRepositoryProfile(
  input: RepositoryProfileInput,
): RepositoryProfileV1 {
  return parseRepositoryProfile({
    ...input,
    schemaVersion: REPOSITORY_PROFILE_SCHEMA_VERSION,
  });
}

export function parseRepositoryProfile(value: unknown): RepositoryProfileV1 {
  const source = expectRecord(value, "repository profile");
  const record: Record<string, unknown> = {
    promotionPolicy: defaultRepositoryPromotionPolicy(),
    runtimeDigests: undefined,
    ...source,
  };
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "key",
      "displayName",
      "repositoryRoot",
      "defaultBranch",
      "allowedPathPrefixes",
      "validationProfile",
      "runtimeDigests",
      "promotionPolicy",
    ],
    "repository profile",
  );
  if (record.schemaVersion !== REPOSITORY_PROFILE_SCHEMA_VERSION) {
    throw new RepositoryProfileError("Unsupported repository profile schema version.");
  }
  const key = expectIdentifier(record.key, "repository profile key");
  const displayName = expectString(record.displayName, "display name", 1, 160);
  const repositoryRoot = expectAbsolutePath(record.repositoryRoot);
  const defaultBranch = expectBranch(record.defaultBranch);
  const allowedPathPrefixes = expectUniquePaths(
    record.allowedPathPrefixes,
    "allowed path prefix",
  );
  if (allowedPathPrefixes.length === 0) {
    throw new RepositoryProfileError(
      "Repository profile requires at least one allowed path prefix.",
    );
  }

  const runtimeDigests = parseRuntimeDigests(record.runtimeDigests);
  return {
    schemaVersion: REPOSITORY_PROFILE_SCHEMA_VERSION,
    key,
    displayName,
    repositoryRoot,
    defaultBranch,
    allowedPathPrefixes,
    validationProfile: parseValidationProfile(record.validationProfile),
    ...(runtimeDigests ? { runtimeDigests } : {}),
    promotionPolicy: parsePromotionPolicy(record.promotionPolicy),
  };
}

function parseRuntimeDigests(
  value: unknown,
): Partial<Record<"node" | "python", string>> | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, "repository runtime digests");
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "node" && key !== "python")) {
    throw new RepositoryProfileError("Repository runtime digests contain an unknown ecosystem.");
  }
  const output: Partial<Record<"node" | "python", string>> = {};
  for (const key of keys as Array<"node" | "python">) {
    const digest = record[key];
    if (
      typeof digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(digest)
    ) {
      throw new RepositoryProfileError(`${key} runtime digest must be an exact SHA-256 fingerprint.`);
    }
    output[key] = digest;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function defaultRepositoryPromotionPolicy(): RepositoryPromotionPolicyV1 {
  return {
    localBasePromotion: "guarded_fast_forward",
    completionProof: "local_verified",
    githubRepository: null,
    requiredChecks: [],
  };
}

export function createRepositoryProfileRegistry(
  profiles: readonly RepositoryProfileV1[] = [],
): RepositoryProfileRegistryV1 {
  const registry: RepositoryProfileRegistryV1 = {
    schemaVersion: REPOSITORY_PROFILE_SCHEMA_VERSION,
    profiles: {},
  };
  return profiles.reduce(upsertRepositoryProfile, registry);
}

export function parseRepositoryProfileRegistry(
  value: unknown,
): RepositoryProfileRegistryV1 {
  const record = expectRecord(value, "repository profile registry");
  assertExactKeys(record, ["schemaVersion", "profiles"], "repository profile registry");
  if (record.schemaVersion !== REPOSITORY_PROFILE_SCHEMA_VERSION) {
    throw new RepositoryProfileError("Unsupported repository profile registry version.");
  }
  const rawProfiles = expectRecord(record.profiles, "repository profiles");
  const profiles: Record<string, RepositoryProfileV1> = {};
  for (const [storedKey, rawProfile] of Object.entries(rawProfiles)) {
    const profile = parseRepositoryProfile(rawProfile);
    if (storedKey !== profile.key) {
      throw new RepositoryProfileError(
        `Repository profile registry key ${storedKey} does not match profile key ${profile.key}.`,
      );
    }
    profiles[profile.key] = profile;
  }
  return {
    schemaVersion: REPOSITORY_PROFILE_SCHEMA_VERSION,
    profiles,
  };
}

export function upsertRepositoryProfile(
  registry: RepositoryProfileRegistryV1,
  value: RepositoryProfileV1,
): RepositoryProfileRegistryV1 {
  const profile = parseRepositoryProfile(value);
  return {
    schemaVersion: REPOSITORY_PROFILE_SCHEMA_VERSION,
    profiles: {
      ...registry.profiles,
      [profile.key]: profile,
    },
  };
}

export function getRepositoryProfile(
  registry: RepositoryProfileRegistryV1,
  key: string,
): RepositoryProfileV1 | undefined {
  return registry.profiles[key];
}

function parseValidationProfile(value: unknown): ValidationProfile {
  const record = expectRecord(value, "validation profile");
  assertExactKeys(
    record,
    [
      "id",
      "bootstrapCommands",
      "validationCommands",
      "protectedPaths",
      "allowedGeneratedPaths",
    ],
    "validation profile",
  );
  const validationCommands = parseCommands(
    record.validationCommands,
    "validation command",
  );
  if (validationCommands.length === 0) {
    throw new RepositoryProfileError(
      "Validation profile requires at least one validation command.",
    );
  }
  return {
    id: expectIdentifier(record.id, "validation profile id"),
    bootstrapCommands: parseCommands(record.bootstrapCommands, "bootstrap command"),
    validationCommands,
    protectedPaths: expectUniquePaths(record.protectedPaths, "protected path"),
    allowedGeneratedPaths: expectUniquePaths(
      record.allowedGeneratedPaths,
      "allowed generated path",
    ),
  };
}

function parsePromotionPolicy(value: unknown): RepositoryPromotionPolicyV1 {
  const record = expectRecord(value, "repository promotion policy");
  const normalized = {
    ...defaultRepositoryPromotionPolicy(),
    ...record,
  };
  assertExactKeys(
    normalized,
    [
      "localBasePromotion",
      "completionProof",
      "githubRepository",
      "requiredChecks",
    ],
    "repository promotion policy",
  );
  if (
    normalized.localBasePromotion !== "disabled" &&
    normalized.localBasePromotion !== "guarded_fast_forward"
  ) {
    throw new RepositoryProfileError("Repository local promotion policy is invalid.");
  }
  if (
    normalized.completionProof !== "local_verified" &&
    normalized.completionProof !== "draft_pr" &&
    normalized.completionProof !== "merged_pr"
  ) {
    throw new RepositoryProfileError("Repository completion proof policy is invalid.");
  }
  const githubRepository =
    normalized.githubRepository === null
      ? null
      : expectString(normalized.githubRepository, "GitHub repository", 3, 200);
  if (
    githubRepository !== null &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)
  ) {
    throw new RepositoryProfileError("GitHub repository must use owner/name form.");
  }
  if (normalized.completionProof !== "local_verified" && !githubRepository) {
    throw new RepositoryProfileError(
      "Remote completion proof requires a pinned GitHub repository.",
    );
  }
  if (!Array.isArray(normalized.requiredChecks) || normalized.requiredChecks.length > 32) {
    throw new RepositoryProfileError("Repository required checks must be a bounded array.");
  }
  const requiredChecks = normalized.requiredChecks.map((check, index) =>
    expectString(check, `required check ${index + 1}`, 1, 200),
  );
  if (new Set(requiredChecks).size !== requiredChecks.length) {
    throw new RepositoryProfileError("Repository required checks must be unique.");
  }
  return {
    localBasePromotion: normalized.localBasePromotion,
    completionProof: normalized.completionProof,
    githubRepository,
    requiredChecks,
  };
}

function parseCommands(value: unknown, label: string): ValidationCommand[] {
  if (!Array.isArray(value)) {
    throw new RepositoryProfileError(`${label} list must be an array.`);
  }
  if (value.length > 32) {
    throw new RepositoryProfileError(`${label} list exceeds 32 entries.`);
  }
  return value.map((rawCommand, index) => {
    const record = expectRecord(rawCommand, `${label} ${index + 1}`);
    assertExactKeys(record, ["command", "args", "label"], `${label} ${index + 1}`);
    if (!Array.isArray(record.args) || record.args.length > 64) {
      throw new RepositoryProfileError(`${label} ${index + 1} args must be an array.`);
    }
    const command = expectString(record.command, `${label} command`, 1, 80);
    if (!["npm", "node", "py", "python", "python3"].includes(command)) {
      throw new RepositoryProfileError(`${label} uses an unsupported executable.`);
    }
    return {
      command,
      args: record.args.map((argument, argumentIndex) =>
        expectString(argument, `${label} argument ${argumentIndex + 1}`, 1, 500),
      ),
      label: expectString(record.label, `${label} label`, 1, 200),
    };
  });
}

function expectUniquePaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new RepositoryProfileError(`${label} list must be an array.`);
  }
  if (value.length > 256) {
    throw new RepositoryProfileError(`${label} list exceeds 256 entries.`);
  }
  const paths = value.map((entry, index) =>
    normalizeRelativePath(expectString(entry, `${label} ${index + 1}`, 1, 500), label),
  );
  if (new Set(paths).size !== paths.length) {
    throw new RepositoryProfileError(`${label} list must not contain duplicates.`);
  }
  return paths;
}

function normalizeRelativePath(value: string, label: string): string {
  const normalized = value.replace(/\/$/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new RepositoryProfileError(`${label} must be a safe repository-relative path.`);
  }
  return normalized;
}

function expectAbsolutePath(value: unknown): string {
  const path = expectString(value, "repository root", 1, 1_024);
  if (!(path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path))) {
    throw new RepositoryProfileError("Repository root must be an absolute local path.");
  }
  if (path.includes("\0")) {
    throw new RepositoryProfileError("Repository root contains an invalid null byte.");
  }
  return path === "/" || /^[a-zA-Z]:[\\/]$/.test(path)
    ? path
    : path.replace(/[\\/]$/, "");
}

function expectIdentifier(value: unknown, label: string): string {
  const identifier = expectString(value, label, 1, 128);
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(identifier) ||
    identifier === "__proto__" ||
    identifier === "prototype" ||
    identifier === "constructor"
  ) {
    throw new RepositoryProfileError(
      `${label} must use lowercase letters, digits, dots, underscores, or hyphens.`,
    );
  }
  return identifier;
}

function expectBranch(value: unknown): string {
  const branch = expectString(value, "default branch", 1, 255);
  if (
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[~^:?*[\\\s]/.test(branch)
  ) {
    throw new RepositoryProfileError("Default branch is not a safe Git branch name.");
  }
  return branch;
}

function expectString(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new RepositoryProfileError(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length < minimumLength || normalized.length > maximumLength) {
    throw new RepositoryProfileError(
      `${label} must contain ${minimumLength}-${maximumLength} characters.`,
    );
  }
  if (/\p{Cc}/u.test(normalized)) {
    throw new RepositoryProfileError(`${label} contains control characters.`);
  }
  return normalized;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RepositoryProfileError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RepositoryProfileError(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  const missing = keys.filter(
    (key) => !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (unknown.length > 0 || missing.length > 0) {
    throw new RepositoryProfileError(
      `${label} keys do not match the v1 contract (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
}
