import { portableSha256Text } from "./portableSha256";
import {
  isAgentGitCommitIdentityV1,
  type AgentGitCommitIdentityV1,
} from "./agentGitCommitIdentityV1";

export const VERIFIED_CODE_PUBLICATION_HANDOFF_VERSION = 1 as const;

const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const EXECUTION_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

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
  identity: AgentGitCommitIdentityV1;
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
  identity: AgentGitCommitIdentityV1;
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

export interface VerifiedCodeReflectionSourceV1 {
  /** Repository-relative path read from the verified commit. */
  path: string;
  /** Exact UTF-8 text read back for that path. */
  content: string;
}

export interface VerifiedCodeReflectionSelectionV1 {
  path: string;
  /** Inclusive, one-based source line. */
  startLine: number;
  /** Inclusive, one-based source line. */
  endLine: number;
  /** Optional Markdown fence language; inferred from the path by default. */
  language?: string;
}

export interface VerifiedCodeReflectionExampleV1 {
  version: 1;
  kind: "verified_code_reflection_example";
  path: string;
  language: string;
  commitSha: string;
  artifactSha256: string;
  artifactBytes: number;
  startLine: number;
  endLine: number;
  code: string;
  codeSha256: string;
}

export interface VerifiedCodeReflectionExamplesV1 {
  version: 1;
  kind: "verified_code_reflection_examples";
  handoffFingerprint: string;
  commitSha: string;
  examples: VerifiedCodeReflectionExampleV1[];
  fingerprint: string;
}

export interface CreateVerifiedCodeReflectionExamplesInputV1 {
  handoff: unknown;
  /** Exact file readbacks from the verified commit/tree, never model prose. */
  sources: readonly VerifiedCodeReflectionSourceV1[];
  /** One or two explicit excerpts, each bounded to 20 lines. */
  selections: readonly VerifiedCodeReflectionSelectionV1[];
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
    identity: { ...localCommit.identity },
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
    requestId: executionIdentity(record.requestId, "request id"),
    runId: executionIdentity(record.runId, "run id"),
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
    identity: commitIdentity(record.identity, "publication commit identity"),
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

/**
 * Bind concise reflection excerpts to an already verified publication handoff.
 *
 * The caller must read each source from the handoff's exact commit/tree. This
 * helper independently hashes the UTF-8 bytes and refuses any source whose
 * path, byte count, or digest differs from the handoff artifact readback.
 */
export function createVerifiedCodeReflectionExamplesV1(
  input: CreateVerifiedCodeReflectionExamplesInputV1,
): VerifiedCodeReflectionExamplesV1 {
  const handoff = parseVerifiedCodePublicationHandoffV1(input.handoff);
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 100) {
    fail("Verified code reflection sources must contain between 1 and 100 entries.");
  }
  if (!Array.isArray(input.selections) || input.selections.length < 1 || input.selections.length > 2) {
    fail("Verified code reflection requires one or two concise selections.");
  }

  const sourceByPath = new Map<string, VerifiedCodeReflectionSourceV1>();
  for (const [index, source] of input.sources.entries()) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      fail(`Verified code reflection source ${index + 1} must be an object.`);
    }
    const path = relativePath(source.path, `reflection source ${index + 1} path`);
    if (sourceByPath.has(path)) fail("Verified code reflection source paths must be unique.");
    const content = multilineText(source.content, `reflection source ${index + 1} content`, 1, 1_000_000);
    sourceByPath.set(path, { path, content });
  }

  const selectedRanges = new Set<string>();
  const artifactByPath = new Map(handoff.artifactHashes.map((artifact) => [artifact.path, artifact]));
  const changedByPath = new Map(handoff.changedArtifacts.map((artifact) => [artifact.path, artifact]));
  const examples = input.selections.map((selection, index): VerifiedCodeReflectionExampleV1 => {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
      fail(`Verified code reflection selection ${index + 1} must be an object.`);
    }
    const path = relativePath(selection.path, `reflection selection ${index + 1} path`);
    const source = sourceByPath.get(path);
    if (!source) fail(`Verified code reflection source is missing for ${path}.`);
    const artifact = artifactByPath.get(path);
    const changed = changedByPath.get(path);
    if (!artifact || !changed || changed.sha256 === null || changed.sha256 !== artifact.sha256) {
      fail(`Verified code reflection path ${path} is not a non-deleted verified changed artifact.`);
    }
    const sourceSha256 = `sha256:${portableSha256Text(source.content)}`;
    const sourceBytes = new TextEncoder().encode(source.content).byteLength;
    if (sourceSha256 !== artifact.sha256 || sourceBytes !== artifact.bytes) {
      fail(`Verified code reflection source ${path} does not match its artifact hash readback.`);
    }
    const lines = sourceLines(source.content);
    const startLine = integer(selection.startLine, `reflection selection ${index + 1} startLine`, 1, lines.length);
    const endLine = integer(selection.endLine, `reflection selection ${index + 1} endLine`, startLine, lines.length);
    const rangeKey = `${path}\0${startLine}\0${endLine}`;
    if (selectedRanges.has(rangeKey)) fail("Verified code reflection selections must be unique.");
    selectedRanges.add(rangeKey);
    if (endLine - startLine + 1 > 20) {
      fail("Verified code reflection examples are limited to 20 lines each.");
    }
    const code = lines.slice(startLine - 1, endLine).join("\n");
    if (!code.trim()) fail("Verified code reflection examples cannot be blank.");
    return {
      version: 1,
      kind: "verified_code_reflection_example",
      path,
      language: reflectionLanguage(selection.language, path),
      commitSha: handoff.commitSha,
      artifactSha256: artifact.sha256,
      artifactBytes: artifact.bytes,
      startLine,
      endLine,
      code,
      codeSha256: `sha256:${portableSha256Text(code)}`,
    };
  });
  const evidence: Omit<VerifiedCodeReflectionExamplesV1, "fingerprint"> = {
    version: 1,
    kind: "verified_code_reflection_examples",
    handoffFingerprint: handoff.fingerprint,
    commitSha: handoff.commitSha,
    examples,
  };
  return { ...evidence, fingerprint: sha256(evidence) };
}

/** Parse and optionally bind a reflection-example bundle to an exact handoff. */
export function parseVerifiedCodeReflectionExamplesV1(
  value: unknown,
  expectedHandoff?: unknown,
): VerifiedCodeReflectionExamplesV1 {
  const record = exactRecord(
    value,
    ["version", "kind", "handoffFingerprint", "commitSha", "examples", "fingerprint"],
    "verified code reflection examples",
  );
  if (record.version !== 1 || record.kind !== "verified_code_reflection_examples") {
    fail("Unsupported verified code reflection examples contract.");
  }
  const handoffFingerprint = fingerprint(record.handoffFingerprint, "reflection handoff fingerprint");
  const commitSha = gitSha(record.commitSha, "reflection commit SHA");
  const rawExamples = array(record.examples, "verified code reflection examples", 1, 2);
  const examples = rawExamples.map((entry, index): VerifiedCodeReflectionExampleV1 => {
    const item = exactRecord(
      entry,
      [
        "version", "kind", "path", "language", "commitSha", "artifactSha256",
        "artifactBytes", "startLine", "endLine", "code", "codeSha256",
      ],
      `verified code reflection example ${index + 1}`,
    );
    if (item.version !== 1 || item.kind !== "verified_code_reflection_example") {
      fail("Unsupported verified code reflection example contract.");
    }
    const startLine = integer(item.startLine, `reflection example ${index + 1} startLine`, 1, Number.MAX_SAFE_INTEGER);
    const endLine = integer(item.endLine, `reflection example ${index + 1} endLine`, startLine, Number.MAX_SAFE_INTEGER);
    const code = multilineText(item.code, `reflection example ${index + 1} code`, 1, 20_000);
    if (!code.trim() || sourceLines(code).length !== endLine - startLine + 1 || endLine - startLine + 1 > 20) {
      fail("Verified code reflection example lines do not match the bounded selection.");
    }
    const result: VerifiedCodeReflectionExampleV1 = {
      version: 1,
      kind: "verified_code_reflection_example",
      path: relativePath(item.path, `reflection example ${index + 1} path`),
      language: reflectionLanguage(item.language, String(item.path)),
      commitSha: gitSha(item.commitSha, `reflection example ${index + 1} commit SHA`),
      artifactSha256: fingerprint(item.artifactSha256, `reflection example ${index + 1} artifact hash`),
      artifactBytes: integer(item.artifactBytes, `reflection example ${index + 1} artifact bytes`, 1, 10 * 1024 * 1024),
      startLine,
      endLine,
      code,
      codeSha256: fingerprint(item.codeSha256, `reflection example ${index + 1} code hash`),
    };
    if (result.commitSha !== commitSha) fail("Verified code reflection example commit does not match its bundle.");
    if (result.codeSha256 !== `sha256:${portableSha256Text(result.code)}`) {
      fail("Verified code reflection example hash does not match its content.");
    }
    return result;
  });
  if (
    new Set(examples.map(({ path, startLine, endLine }) => `${path}\0${startLine}\0${endLine}`)).size !==
    examples.length
  ) {
    fail("Verified code reflection example selections must be unique.");
  }
  const result: VerifiedCodeReflectionExamplesV1 = {
    version: 1,
    kind: "verified_code_reflection_examples",
    handoffFingerprint,
    commitSha,
    examples,
    fingerprint: fingerprint(record.fingerprint, "verified code reflection examples fingerprint"),
  };
  const { fingerprint: observed, ...evidence } = result;
  if (observed !== sha256(evidence)) fail("Verified code reflection examples fingerprint does not match its evidence.");
  if (expectedHandoff !== undefined) {
    const handoff = parseVerifiedCodePublicationHandoffV1(expectedHandoff);
    if (result.handoffFingerprint !== handoff.fingerprint || result.commitSha !== handoff.commitSha) {
      fail("Verified code reflection examples do not match the expected publication handoff.");
    }
  }
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
    requestId: executionIdentity(record.requestId, "request id"),
    runId: executionIdentity(record.runId, "run id"),
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
    identity: commitIdentity(record.identity, "local commit identity"),
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
    identity: result.identity,
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
  "identity",
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
  "identity",
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

function commitIdentity(value: unknown, label: string): AgentGitCommitIdentityV1 {
  const record = exactRecord(
    value,
    ["authorName", "authorEmail", "committerName", "committerEmail"],
    label,
  );
  const identity: AgentGitCommitIdentityV1 = {
    authorName: boundedText(record.authorName, `${label} author name`, 1, 256),
    authorEmail: boundedText(record.authorEmail, `${label} author email`, 1, 320),
    committerName: boundedText(record.committerName, `${label} committer name`, 1, 256),
    committerEmail: boundedText(record.committerEmail, `${label} committer email`, 1, 320),
  };
  if (!isAgentGitCommitIdentityV1(identity)) {
    fail(`${label} must match the host-pinned neutral Agentic Researcher identity.`);
  }
  return identity;
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

function executionIdentity(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 128);
  if (
    !EXECUTION_IDENTITY.test(result) ||
    ["__proto__", "prototype", "constructor"].includes(result)
  ) {
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

function multilineText(value: unknown, label: string, min: number, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.includes("\0")
  ) {
    fail(`${label} must be bounded text without null bytes.`);
  }
  return value;
}

function sourceLines(content: string): string[] {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length > 0 ? lines : [""];
}

function reflectionLanguage(value: unknown, path: string): string {
  if (value !== undefined) {
    const explicit = boundedText(value, "reflection example language", 1, 32).toLowerCase();
    if (!/^[a-z0-9_+#.-]+$/u.test(explicit)) {
      fail("Reflection example language is invalid.");
    }
    return explicit;
  }
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const languages: Record<string, string> = {
    c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css", go: "go",
    html: "html", java: "java", js: "javascript", json: "json", jsx: "jsx",
    kt: "kotlin", md: "markdown", php: "php", py: "python", rb: "ruby",
    rs: "rust", sh: "shell", sql: "sql", swift: "swift", ts: "typescript",
    tsx: "tsx", yaml: "yaml", yml: "yaml",
  };
  return languages[extension] ?? "text";
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
