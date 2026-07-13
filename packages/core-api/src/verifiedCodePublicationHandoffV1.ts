import { portableSha256Text } from "./portableSha256";

export const VERIFIED_CODE_PUBLICATION_HANDOFF_VERSION = 1 as const;

const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;

export interface PublicationArtifactHashV1 {
  path: string;
  sha256: string;
  bytes: number;
}

export interface PublicationChangedArtifactV1 {
  path: string;
  sha256: string | null;
}

/**
 * Structural subset of the code extension's VerifiedLocalCommitReceiptV1.
 * Keeping the type here prevents the core API from depending on an optional
 * extension while still allowing the real receipt to be passed directly.
 */
export interface VerifiedLocalCommitForPublicationV1 {
  version: 1;
  kind: "verified_local_commit";
  id: string;
  status: "verified";
  requestId: string;
  runId: string;
  worktreeId: string;
  workspaceId: string;
  branch: string;
  baseSha: string;
  commitSha: string;
  parentSha: string;
  treeSha: string;
  diffFingerprint: string;
  changedPaths: string[];
  artifactHashes: PublicationArtifactHashV1[];
  changedArtifacts: PublicationChangedArtifactV1[];
  targetedValidationReceiptId: string;
  fullValidationReceiptId: string;
  targetedValidationFingerprint: string;
  fullValidationFingerprint: string;
  committedAt: string;
  fingerprint: string;
}

export interface VerifiedCodePublicationHandoffV1 {
  version: typeof VERIFIED_CODE_PUBLICATION_HANDOFF_VERSION;
  kind: "verified_code_publication_handoff";
  id: string;
  status: "verified";
  requestId: string;
  runId: string;
  worktreeId: string;
  workspaceId: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  canonicalWorktreeRoot: string;
  canonicalWorktreeFingerprint: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  commitSha: string;
  parentSha: string;
  treeSha: string;
  diffFingerprint: string;
  changedPaths: string[];
  artifactHashes: PublicationArtifactHashV1[];
  changedArtifacts: PublicationChangedArtifactV1[];
  artifactFingerprint: string;
  targetedValidationReceiptId: string;
  fullValidationReceiptId: string;
  targetedValidationFingerprint: string;
  fullValidationFingerprint: string;
  localCommitReceiptId: string;
  localCommitReceiptFingerprint: string;
  committedAt: string;
  preparedAt: string;
  fingerprint: string;
}

export interface CreateVerifiedCodePublicationHandoffInputV1 {
  id: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  canonicalWorktreeRoot: string;
  baseBranch: string;
  localCommit: VerifiedLocalCommitForPublicationV1;
  preparedAt: string;
}

export class VerifiedCodePublicationHandoffErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifiedCodePublicationHandoffErrorV1";
  }
}

export function createVerifiedCodePublicationHandoffV1(
  input: CreateVerifiedCodePublicationHandoffInputV1,
): VerifiedCodePublicationHandoffV1 {
  const localCommit = parseVerifiedLocalCommitForPublicationV1(input.localCommit);
  if (localCommit.parentSha !== localCommit.baseSha) {
    fail("Verified local commit parent does not match its trusted base SHA.");
  }
  const canonicalWorktreeRoot = absolutePath(
    input.canonicalWorktreeRoot,
    "canonical worktree root",
  );
  const branch = gitBranch(localCommit.branch, "agent-owned branch");
  if (!branch.startsWith("codex/")) {
    fail("Code publication is limited to agent-owned codex/ branches.");
  }
  const preparedAt = timestamp(input.preparedAt, "preparedAt");
  if (Date.parse(preparedAt) < Date.parse(localCommit.committedAt)) {
    fail("Code publication handoff cannot predate the verified local commit.");
  }
  const repositoryProfileKey = identifier(
    input.repositoryProfileKey,
    "repository profile key",
  );
  const repositoryProfileFingerprint = fingerprint(
    input.repositoryProfileFingerprint,
    "repository profile fingerprint",
  );
  const baseBranch = gitBranch(input.baseBranch, "base branch");
  const canonicalWorktreeFingerprint = sha256({
    repositoryProfileKey,
    worktreeId: localCommit.worktreeId,
    workspaceId: localCommit.workspaceId,
    canonicalWorktreeRoot,
    baseSha: localCommit.baseSha,
  });
  const artifactFingerprint = sha256({
    artifactHashes: localCommit.artifactHashes,
    changedArtifacts: localCommit.changedArtifacts,
  });
  const evidence: Omit<VerifiedCodePublicationHandoffV1, "fingerprint"> = {
    version: VERIFIED_CODE_PUBLICATION_HANDOFF_VERSION,
    kind: "verified_code_publication_handoff",
    id: identifier(input.id, "handoff id"),
    status: "verified",
    requestId: localCommit.requestId,
    runId: localCommit.runId,
    worktreeId: localCommit.worktreeId,
    workspaceId: localCommit.workspaceId,
    repositoryProfileKey,
    repositoryProfileFingerprint,
    canonicalWorktreeRoot,
    canonicalWorktreeFingerprint,
    branch,
    baseBranch,
    baseSha: localCommit.baseSha,
    commitSha: localCommit.commitSha,
    parentSha: localCommit.parentSha,
    treeSha: localCommit.treeSha,
    diffFingerprint: localCommit.diffFingerprint,
    changedPaths: [...localCommit.changedPaths],
    artifactHashes: clone(localCommit.artifactHashes),
    changedArtifacts: clone(localCommit.changedArtifacts),
    artifactFingerprint,
    targetedValidationReceiptId: localCommit.targetedValidationReceiptId,
    fullValidationReceiptId: localCommit.fullValidationReceiptId,
    targetedValidationFingerprint: localCommit.targetedValidationFingerprint,
    fullValidationFingerprint: localCommit.fullValidationFingerprint,
    localCommitReceiptId: localCommit.id,
    localCommitReceiptFingerprint: localCommit.fingerprint,
    committedAt: localCommit.committedAt,
    preparedAt,
  };
  return { ...evidence, fingerprint: sha256(evidence) };
}

export function parseVerifiedCodePublicationHandoffV1(
  value: unknown,
): VerifiedCodePublicationHandoffV1 {
  const record = exactRecord(value, HANDOFF_KEYS, "verified code publication handoff");
  if (record.version !== 1 || record.kind !== "verified_code_publication_handoff") {
    fail("Unsupported verified code publication handoff contract.");
  }
  if (record.status !== "verified") fail("Code publication handoff is not verified.");
  const result: VerifiedCodePublicationHandoffV1 = {
    version: 1,
    kind: "verified_code_publication_handoff",
    id: identifier(record.id, "handoff id"),
    status: "verified",
    requestId: identifier(record.requestId, "request id"),
    runId: boundedText(record.runId, "run id", 1, 256),
    worktreeId: boundedText(record.worktreeId, "worktree id", 1, 256),
    workspaceId: boundedText(record.workspaceId, "workspace id", 1, 256),
    repositoryProfileKey: identifier(record.repositoryProfileKey, "repository profile key"),
    repositoryProfileFingerprint: fingerprint(record.repositoryProfileFingerprint, "repository profile fingerprint"),
    canonicalWorktreeRoot: absolutePath(record.canonicalWorktreeRoot, "canonical worktree root"),
    canonicalWorktreeFingerprint: fingerprint(record.canonicalWorktreeFingerprint, "canonical worktree fingerprint"),
    branch: gitBranch(record.branch, "agent-owned branch"),
    baseBranch: gitBranch(record.baseBranch, "base branch"),
    baseSha: gitSha(record.baseSha, "base SHA"),
    commitSha: gitSha(record.commitSha, "commit SHA"),
    parentSha: gitSha(record.parentSha, "parent SHA"),
    treeSha: gitSha(record.treeSha, "tree SHA"),
    diffFingerprint: fingerprint(record.diffFingerprint, "diff fingerprint"),
    changedPaths: paths(record.changedPaths, "changed paths"),
    artifactHashes: artifactHashes(record.artifactHashes),
    changedArtifacts: changedArtifacts(record.changedArtifacts),
    artifactFingerprint: fingerprint(record.artifactFingerprint, "artifact fingerprint"),
    targetedValidationReceiptId: boundedText(record.targetedValidationReceiptId, "targeted validation receipt id", 1, 256),
    fullValidationReceiptId: boundedText(record.fullValidationReceiptId, "full validation receipt id", 1, 256),
    targetedValidationFingerprint: fingerprint(record.targetedValidationFingerprint, "targeted validation fingerprint"),
    fullValidationFingerprint: fingerprint(record.fullValidationFingerprint, "full validation fingerprint"),
    localCommitReceiptId: boundedText(record.localCommitReceiptId, "local commit receipt id", 1, 256),
    localCommitReceiptFingerprint: fingerprint(record.localCommitReceiptFingerprint, "local commit receipt fingerprint"),
    committedAt: timestamp(record.committedAt, "committedAt"),
    preparedAt: timestamp(record.preparedAt, "preparedAt"),
    fingerprint: fingerprint(record.fingerprint, "handoff fingerprint"),
  };
  if (!result.branch.startsWith("codex/")) fail("Code publication is limited to agent-owned codex/ branches.");
  if (result.parentSha !== result.baseSha) fail("Verified local commit parent does not match its trusted base SHA.");
  if (Date.parse(result.preparedAt) < Date.parse(result.committedAt)) fail("Code publication handoff cannot predate the verified local commit.");
  const expectedWorktreeFingerprint = sha256({
    repositoryProfileKey: result.repositoryProfileKey,
    worktreeId: result.worktreeId,
    workspaceId: result.workspaceId,
    canonicalWorktreeRoot: result.canonicalWorktreeRoot,
    baseSha: result.baseSha,
  });
  if (result.canonicalWorktreeFingerprint !== expectedWorktreeFingerprint) {
    fail("Canonical worktree fingerprint does not match the handoff identity.");
  }
  if (result.artifactFingerprint !== sha256({ artifactHashes: result.artifactHashes, changedArtifacts: result.changedArtifacts })) {
    fail("Artifact fingerprint does not match the verified artifacts.");
  }
  const { fingerprint: observed, ...evidence } = result;
  if (observed !== sha256(evidence)) fail("Verified code publication handoff fingerprint does not match its evidence.");
  return result;
}

export function parseVerifiedLocalCommitForPublicationV1(
  value: unknown,
): VerifiedLocalCommitForPublicationV1 {
  const record = exactRecord(value, LOCAL_COMMIT_KEYS, "verified local commit receipt");
  if (record.version !== 1 || record.kind !== "verified_local_commit" || record.status !== "verified") {
    fail("Unsupported or unverified local commit receipt.");
  }
  const result: VerifiedLocalCommitForPublicationV1 = {
    version: 1,
    kind: "verified_local_commit",
    id: boundedText(record.id, "local commit receipt id", 1, 256),
    status: "verified",
    requestId: identifier(record.requestId, "request id"),
    runId: boundedText(record.runId, "run id", 1, 256),
    worktreeId: boundedText(record.worktreeId, "worktree id", 1, 256),
    workspaceId: boundedText(record.workspaceId, "workspace id", 1, 256),
    branch: gitBranch(record.branch, "local commit branch"),
    baseSha: gitSha(record.baseSha, "base SHA"),
    commitSha: gitSha(record.commitSha, "commit SHA"),
    parentSha: gitSha(record.parentSha, "parent SHA"),
    treeSha: gitSha(record.treeSha, "tree SHA"),
    diffFingerprint: fingerprint(record.diffFingerprint, "diff fingerprint"),
    changedPaths: paths(record.changedPaths, "changed paths"),
    artifactHashes: artifactHashes(record.artifactHashes),
    changedArtifacts: changedArtifacts(record.changedArtifacts),
    targetedValidationReceiptId: boundedText(record.targetedValidationReceiptId, "targeted validation receipt id", 1, 256),
    fullValidationReceiptId: boundedText(record.fullValidationReceiptId, "full validation receipt id", 1, 256),
    targetedValidationFingerprint: fingerprint(record.targetedValidationFingerprint, "targeted validation fingerprint"),
    fullValidationFingerprint: fingerprint(record.fullValidationFingerprint, "full validation fingerprint"),
    committedAt: timestamp(record.committedAt, "committedAt"),
    fingerprint: fingerprint(record.fingerprint, "local commit fingerprint"),
  };
  assertUniqueArtifactPaths(result.artifactHashes, "artifact hashes");
  assertUniqueArtifactPaths(result.changedArtifacts, "changed artifacts");
  if (!samePathSet(result.changedPaths, result.changedArtifacts.map(({ path }) => path))) {
    fail("Changed artifact paths must exactly match verified changed paths.");
  }
  const changedArtifactMap = new Map(
    result.changedArtifacts.map((artifact) => [artifact.path, artifact.sha256]),
  );
  if (
    result.artifactHashes.some(
      (artifact) => changedArtifactMap.get(artifact.path) !== artifact.sha256,
    )
  ) {
    fail("Artifact hash readback must match a non-deleted changed artifact.");
  }
  const evidence = {
    requestId: result.requestId,
    runId: result.runId,
    worktreeId: result.worktreeId,
    workspaceId: result.workspaceId,
    branch: result.branch,
    baseSha: result.baseSha,
    commitSha: result.commitSha,
    parentSha: result.parentSha,
    treeSha: result.treeSha,
    diffFingerprint: result.diffFingerprint,
    changedPaths: result.changedPaths,
    artifactHashes: result.artifactHashes,
    changedArtifacts: result.changedArtifacts,
    targetedValidationReceiptId: result.targetedValidationReceiptId,
    fullValidationReceiptId: result.fullValidationReceiptId,
    targetedValidationFingerprint: result.targetedValidationFingerprint,
    fullValidationFingerprint: result.fullValidationFingerprint,
    committedAt: result.committedAt,
  };
  if (result.fingerprint !== sha256(evidence)) {
    fail("Verified local commit receipt fingerprint does not match its evidence.");
  }
  return result;
}

const LOCAL_COMMIT_KEYS = [
  "version", "kind", "id", "status", "requestId", "runId", "worktreeId",
  "workspaceId", "branch", "baseSha", "commitSha", "parentSha", "treeSha",
  "diffFingerprint", "changedPaths", "artifactHashes", "changedArtifacts",
  "targetedValidationReceiptId", "fullValidationReceiptId",
  "targetedValidationFingerprint", "fullValidationFingerprint", "committedAt",
  "fingerprint",
] as const;

const HANDOFF_KEYS = [
  "version", "kind", "id", "status", "requestId", "runId", "worktreeId",
  "workspaceId", "repositoryProfileKey", "repositoryProfileFingerprint",
  "canonicalWorktreeRoot", "canonicalWorktreeFingerprint", "branch", "baseBranch",
  "baseSha", "commitSha", "parentSha", "treeSha", "diffFingerprint",
  "changedPaths", "artifactHashes", "changedArtifacts", "artifactFingerprint",
  "targetedValidationReceiptId", "fullValidationReceiptId",
  "targetedValidationFingerprint", "fullValidationFingerprint",
  "localCommitReceiptId", "localCommitReceiptFingerprint", "committedAt",
  "preparedAt", "fingerprint",
] as const;

function artifactHashes(value: unknown): PublicationArtifactHashV1[] {
  return array(value, "artifact hashes", 0, 100).map((entry, index) => {
    const record = exactRecord(entry, ["path", "sha256", "bytes"], `artifact hash ${index + 1}`);
    return {
      path: relativePath(record.path, `artifact hash ${index + 1} path`),
      sha256: fingerprint(record.sha256, `artifact hash ${index + 1} sha256`),
      bytes: integer(record.bytes, `artifact hash ${index + 1} bytes`, 0, 10 * 1024 * 1024),
    };
  });
}

function changedArtifacts(value: unknown): PublicationChangedArtifactV1[] {
  return array(value, "changed artifacts", 0, 100).map((entry, index) => {
    const record = exactRecord(entry, ["path", "sha256"], `changed artifact ${index + 1}`);
    return {
      path: relativePath(record.path, `changed artifact ${index + 1} path`),
      sha256: record.sha256 === null ? null : fingerprint(record.sha256, `changed artifact ${index + 1} sha256`),
    };
  });
}

function paths(value: unknown, label: string): string[] {
  const result = array(value, label, 0, 100).map((entry, index) => relativePath(entry, `${label} ${index + 1}`));
  if (new Set(result).size !== result.length) fail(`${label} must be unique.`);
  return result;
}

function assertUniqueArtifactPaths(
  artifacts: ReadonlyArray<{ path: string }>,
  label: string,
): void {
  if (new Set(artifacts.map(({ path }) => path)).size !== artifacts.length) {
    fail(`${label} paths must be unique.`);
  }
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function relativePath(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 1024);
  if (result.startsWith("/") || result.includes("\\") || /^[a-z]:/iu.test(result) || result.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    fail(`${label} must be a safe repository-relative path.`);
  }
  return result;
}

function absolutePath(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 2048);
  if ((!result.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(result)) || /[\0\r\n]/u.test(result)) {
    fail(`${label} must be an absolute canonical host path.`);
  }
  return result;
}

function gitBranch(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 255);
  if (result.startsWith("-") || result.startsWith("/") || result.endsWith("/") || result.endsWith(".") || result.includes("..") || result.includes("@{") || /[~^:?*[\\\s\]]/u.test(result)) {
    fail(`${label} is invalid.`);
  }
  return result;
}

function gitSha(value: unknown, label: string): string {
  const result = boundedText(value, label, 40, 64);
  if (!GIT_SHA.test(result)) fail(`${label} must be a canonical Git object id.`);
  return result;
}

function fingerprint(value: unknown, label: string): string {
  const result = boundedText(value, label, 71, 71);
  if (!SHA256.test(result)) fail(`${label} must be a SHA-256 fingerprint.`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = boundedText(value, label, 20, 40);
  if (!Number.isFinite(Date.parse(result)) || new Date(Date.parse(result)).toISOString() !== result) {
    fail(`${label} must be a canonical ISO timestamp.`);
  }
  return result;
}

function identifier(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 256);
  if (!IDENTIFIER.test(result) || ["__proto__", "prototype", "constructor"].includes(result)) {
    fail(`${label} is invalid.`);
  }
  return result;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

function array(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${label} must contain between ${min} and ${max} entries.`);
  }
  return value;
}

function exactRecord<const T extends readonly string[]>(value: unknown, keys: T, label: string): Record<T[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) fail(`${label} does not match its closed contract.`);
  return record as Record<T[number], unknown>;
}

function boundedText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\0\r\n]/u.test(value)) {
    fail(`${label} must be bounded text.`);
  }
  return value;
}

function sha256(value: unknown): string {
  return `sha256:${portableSha256Text(canonicalJson(value))}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail("Fingerprint evidence contains an unsafe number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") fail("Fingerprint evidence contains an unsupported value.");
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fail(message: string): never {
  throw new VerifiedCodePublicationHandoffErrorV1(message);
}
