export const WORKSPACE_MANIFEST_VERSION_V2 = 2 as const;
export const WORKSPACE_MAX_TEXT_BYTES_V2 = 2 * 1024 * 1024;
export const WORKSPACE_MAX_CHANGED_FILES_V2 = 100;
export const WORKSPACE_MAX_CHANGED_BYTES_V2 = 10 * 1024 * 1024;
export const WORKSPACE_MAX_SEARCH_RESULTS_V2 = 200;

export type WorkspaceKindV2 = "scratch" | "repository";
export type WorkspaceStatusV2 = "active" | "leased" | "expired" | "blocked" | "closed";

export interface WorkspaceRepositoryBindingV2 {
  profileKey: string;
  repositoryRoot: string;
  worktreeRoot: string;
  /** Null only for a pre-branch V2 manifest; commit authority remains blocked. */
  branch: string | null;
  bindingFingerprint: string;
}

export interface WorkspaceSandboxPolicyV2 {
  mode: "editing_only" | "sandbox_required";
  provider: string | null;
  boundaryFingerprint: string | null;
  network: "disabled";
}

export interface WorkspaceFileHashV2 {
  sha256: string;
  bytes: number;
  updatedAt: string;
}

export interface WorkspaceValidationRecordV2 {
  id: string;
  profileId: string;
  status: "passed" | "failed" | "blocked";
  startedAt: string;
  finishedAt: string;
  fingerprint: string;
}

export interface WorkspaceLeaseV2 {
  id: string;
  ownerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface WorkspaceBudgetV2 {
  changedPaths: string[];
  changedBytes: number;
  maxChangedFiles: typeof WORKSPACE_MAX_CHANGED_FILES_V2;
  maxChangedBytes: typeof WORKSPACE_MAX_CHANGED_BYTES_V2;
}

export interface WorkspaceManifestV2 {
  version: typeof WORKSPACE_MANIFEST_VERSION_V2;
  workspaceId: string;
  kind: WorkspaceKindV2;
  ownerRunId: string;
  repositoryBinding: WorkspaceRepositoryBindingV2 | null;
  canonicalRoot: string;
  baseSha: string | null;
  sandboxPolicy: WorkspaceSandboxPolicyV2;
  hashes: {
    files: Record<string, WorkspaceFileHashV2>;
    indexFingerprint: string;
  };
  validationHistory: WorkspaceValidationRecordV2[];
  lease: WorkspaceLeaseV2 | null;
  status: WorkspaceStatusV2;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  budget: WorkspaceBudgetV2;
}

export class WorkspaceManifestErrorV2 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceManifestErrorV2";
  }
}

export function parseWorkspaceManifestV2(value: unknown): WorkspaceManifestV2 {
  const source = record(value, "workspace manifest");
  exact(source, [
    "version", "workspaceId", "kind", "ownerRunId", "repositoryBinding",
    "canonicalRoot", "baseSha", "sandboxPolicy", "hashes", "validationHistory",
    "lease", "status", "expiresAt", "createdAt", "updatedAt", "budget",
  ], "workspace manifest");
  if (source.version !== WORKSPACE_MANIFEST_VERSION_V2) {
    throw new WorkspaceManifestErrorV2("Unsupported workspace manifest version.");
  }
  const workspaceId = identifier(source.workspaceId, "workspace id");
  const kind = enumValue(source.kind, ["scratch", "repository"] as const, "workspace kind");
  const ownerRunId = boundedString(source.ownerRunId, "owner run id", 1, 256);
  const canonicalRoot = absolutePath(source.canonicalRoot, "canonical root");
  const repositoryBinding = source.repositoryBinding === null
    ? null
    : parseRepositoryBinding(source.repositoryBinding);
  const baseSha = source.baseSha === null
    ? null
    : sha(source.baseSha, "base SHA", /^[a-f0-9]{40,64}$/iu);
  if (kind === "scratch" && (repositoryBinding !== null || baseSha !== null)) {
    throw new WorkspaceManifestErrorV2("Scratch workspaces cannot carry repository binding state.");
  }
  if (kind === "repository") {
    if (!repositoryBinding || !baseSha || repositoryBinding.worktreeRoot !== canonicalRoot) {
      throw new WorkspaceManifestErrorV2("Repository workspace binding does not match its canonical root.");
    }
  }
  const sandboxPolicy = parseSandboxPolicy(source.sandboxPolicy);
  const hashesSource = record(source.hashes, "workspace hashes");
  exact(hashesSource, ["files", "indexFingerprint"], "workspace hashes");
  const rawFiles = record(hashesSource.files, "workspace file hashes");
  const files: Record<string, WorkspaceFileHashV2> = {};
  for (const [path, entry] of Object.entries(rawFiles)) {
    const normalized = relativePath(path, "hashed file path");
    if (normalized !== path) throw new WorkspaceManifestErrorV2("Hashed file paths must be normalized.");
    const item = record(entry, `hash entry ${path}`);
    exact(item, ["sha256", "bytes", "updatedAt"], `hash entry ${path}`);
    files[path] = {
      sha256: fingerprint(item.sha256, `hash entry ${path}`),
      bytes: integer(
        item.bytes,
        `hash entry ${path} bytes`,
        0,
        WORKSPACE_MAX_CHANGED_BYTES_V2,
      ),
      updatedAt: iso(item.updatedAt, `hash entry ${path} updatedAt`),
    };
  }
  const validationHistory = array(source.validationHistory, "validation history", 256)
    .map((entry, index) => parseValidation(entry, index));
  const lease = source.lease === null ? null : parseLease(source.lease);
  const status = enumValue(
    source.status,
    ["active", "leased", "expired", "blocked", "closed"] as const,
    "workspace status",
  );
  if ((status === "leased") !== (lease !== null)) {
    throw new WorkspaceManifestErrorV2("Workspace lease and status are inconsistent.");
  }
  const budgetSource = record(source.budget, "workspace budget");
  exact(budgetSource, ["changedPaths", "changedBytes", "maxChangedFiles", "maxChangedBytes"], "workspace budget");
  const changedPaths = array(budgetSource.changedPaths, "changed paths", WORKSPACE_MAX_CHANGED_FILES_V2)
    .map((path, index) => relativePath(path, `changed path ${index + 1}`));
  if (new Set(changedPaths).size !== changedPaths.length) {
    throw new WorkspaceManifestErrorV2("Workspace changed paths must be unique.");
  }
  if (
    budgetSource.maxChangedFiles !== WORKSPACE_MAX_CHANGED_FILES_V2 ||
    budgetSource.maxChangedBytes !== WORKSPACE_MAX_CHANGED_BYTES_V2
  ) {
    throw new WorkspaceManifestErrorV2("Workspace budget limits do not match the v2 contract.");
  }
  return {
    version: WORKSPACE_MANIFEST_VERSION_V2,
    workspaceId,
    kind,
    ownerRunId,
    repositoryBinding,
    canonicalRoot,
    baseSha,
    sandboxPolicy,
    hashes: {
      files,
      indexFingerprint: fingerprint(hashesSource.indexFingerprint, "hash index fingerprint"),
    },
    validationHistory,
    lease,
    status,
    expiresAt: iso(source.expiresAt, "workspace expiry"),
    createdAt: iso(source.createdAt, "workspace createdAt"),
    updatedAt: iso(source.updatedAt, "workspace updatedAt"),
    budget: {
      changedPaths,
      changedBytes: integer(source.budget && budgetSource.changedBytes, "changed bytes", 0, WORKSPACE_MAX_CHANGED_BYTES_V2),
      maxChangedFiles: WORKSPACE_MAX_CHANGED_FILES_V2,
      maxChangedBytes: WORKSPACE_MAX_CHANGED_BYTES_V2,
    },
  };
}

export function serializeWorkspaceManifestV2(value: WorkspaceManifestV2): string {
  return `${JSON.stringify(parseWorkspaceManifestV2(value), null, 2)}\n`;
}

export function assertWorkspaceRelativePathV2(value: unknown, label = "workspace path"): string {
  return relativePath(value, label);
}

export function isSha256FingerprintV2(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function parseRepositoryBinding(value: unknown): WorkspaceRepositoryBindingV2 {
  const source = record(value, "repository binding");
  const legacy = !Object.prototype.hasOwnProperty.call(source, "branch");
  exact(
    source,
    legacy
      ? ["profileKey", "repositoryRoot", "worktreeRoot", "bindingFingerprint"]
      : ["profileKey", "repositoryRoot", "worktreeRoot", "branch", "bindingFingerprint"],
    "repository binding",
  );
  return {
    profileKey: identifier(source.profileKey, "repository profile key"),
    repositoryRoot: absolutePath(source.repositoryRoot, "repository root"),
    worktreeRoot: absolutePath(source.worktreeRoot, "worktree root"),
    branch: legacy ? null : gitBranch(source.branch, "repository worktree branch"),
    bindingFingerprint: fingerprint(source.bindingFingerprint, "repository binding fingerprint"),
  };
}

function gitBranch(value: unknown, label: string): string {
  const input = boundedString(value, label, 1, 255);
  if (
    input.startsWith("-") || input.startsWith("/") || input.endsWith("/") ||
    input.endsWith(".") || input.includes("..") || input.includes("@{") ||
    /[~^:?*[\\\s]/u.test(input)
  ) {
    throw new WorkspaceManifestErrorV2(`${label} is invalid.`);
  }
  return input;
}

function parseSandboxPolicy(value: unknown): WorkspaceSandboxPolicyV2 {
  const source = record(value, "sandbox policy");
  exact(source, ["mode", "provider", "boundaryFingerprint", "network"], "sandbox policy");
  const mode = enumValue(source.mode, ["editing_only", "sandbox_required"] as const, "sandbox mode");
  const provider = source.provider === null ? null : identifier(source.provider, "sandbox provider");
  const boundaryFingerprint = source.boundaryFingerprint === null
    ? null
    : fingerprint(source.boundaryFingerprint, "sandbox boundary fingerprint");
  if ((provider === null) !== (boundaryFingerprint === null)) {
    throw new WorkspaceManifestErrorV2("Sandbox provider and boundary fingerprint must be paired.");
  }
  if (source.network !== "disabled") {
    throw new WorkspaceManifestErrorV2("Workspace sandbox network must default to disabled.");
  }
  return { mode, provider, boundaryFingerprint, network: "disabled" };
}

function parseValidation(value: unknown, index: number): WorkspaceValidationRecordV2 {
  const source = record(value, `validation record ${index + 1}`);
  exact(source, ["id", "profileId", "status", "startedAt", "finishedAt", "fingerprint"], `validation record ${index + 1}`);
  return {
    id: identifier(source.id, "validation id"),
    profileId: identifier(source.profileId, "validation profile id"),
    status: enumValue(source.status, ["passed", "failed", "blocked"] as const, "validation status"),
    startedAt: iso(source.startedAt, "validation startedAt"),
    finishedAt: iso(source.finishedAt, "validation finishedAt"),
    fingerprint: fingerprint(source.fingerprint, "validation fingerprint"),
  };
}

function parseLease(value: unknown): WorkspaceLeaseV2 {
  const source = record(value, "workspace lease");
  exact(source, ["id", "ownerId", "acquiredAt", "heartbeatAt", "expiresAt"], "workspace lease");
  return {
    id: identifier(source.id, "lease id"),
    ownerId: boundedString(source.ownerId, "lease owner", 1, 256),
    acquiredAt: iso(source.acquiredAt, "lease acquiredAt"),
    heartbeatAt: iso(source.heartbeatAt, "lease heartbeatAt"),
    expiresAt: iso(source.expiresAt, "lease expiresAt"),
  };
}

function relativePath(value: unknown, label: string): string {
  const input = boundedString(value, label, 1, 1_024);
  if (
    input.startsWith("/") || input.includes("\\") || /^[a-z]:/iu.test(input) ||
    /[\0\r\n]/u.test(input)
  ) throw new WorkspaceManifestErrorV2(`${label} must be workspace-relative.`);
  const parts = input.replace(/\/$/u, "").split("/");
  const blocked = new Set([".git", ".workspace", ".agent-workspace", "system volume information", "$recycle.bin", "__proto__", "prototype", "constructor"]);
  if (parts.some((part) => !part || part === "." || part === ".." || blocked.has(part.toLowerCase()))) {
    throw new WorkspaceManifestErrorV2(`${label} contains a blocked path component.`);
  }
  if (parts.some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part))) {
    throw new WorkspaceManifestErrorV2(`${label} contains a reserved system name.`);
  }
  return parts.join("/");
}

function absolutePath(value: unknown, label: string): string {
  const input = boundedString(value, label, 1, 2_048);
  if (!(input.startsWith("/") || /^[a-z]:[\\/]/iu.test(input)) || /[\0\r\n]/u.test(input)) {
    throw new WorkspaceManifestErrorV2(`${label} must be an absolute local path.`);
  }
  return input;
}

function fingerprint(value: unknown, label: string): string {
  if (!isSha256FingerprintV2(value)) throw new WorkspaceManifestErrorV2(`${label} is not SHA-256.`);
  return value;
}

function sha(value: unknown, label: string, pattern: RegExp): string {
  const input = boundedString(value, label, 1, 128);
  if (!pattern.test(input)) throw new WorkspaceManifestErrorV2(`${label} is invalid.`);
  return input.toLowerCase();
}

function identifier(value: unknown, label: string): string {
  const input = boundedString(value, label, 1, 128);
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(input) || ["__proto__", "prototype", "constructor"].includes(input)) {
    throw new WorkspaceManifestErrorV2(`${label} is invalid.`);
  }
  return input;
}

function iso(value: unknown, label: string): string {
  const input = boundedString(value, label, 20, 40);
  if (Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) {
    throw new WorkspaceManifestErrorV2(`${label} must be a canonical ISO timestamp.`);
  }
  return input;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new WorkspaceManifestErrorV2(`${label} must be an integer in range.`);
  }
  return Number(value);
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new WorkspaceManifestErrorV2(`${label} must be a bounded array.`);
  return value;
}

function boundedString(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max || /\p{Cc}/u.test(value)) {
    throw new WorkspaceManifestErrorV2(`${label} must be a bounded string.`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceManifestErrorV2(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new WorkspaceManifestErrorV2(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new WorkspaceManifestErrorV2(`${label} has unknown or missing fields.`);
  }
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new WorkspaceManifestErrorV2(`${label} is invalid.`);
  return value as T[number];
}
