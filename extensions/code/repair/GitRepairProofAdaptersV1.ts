import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { RepositoryProfileV2 } from "../repositories/RepositoryProfileV2";
import type { WorkspaceManagerV2 } from "../workspaces/WorkspaceManagerV2";
import type { WorkspaceManifestV2 } from "../workspaces/WorkspaceManifestV2";
import type {
  RepositoryProfileResolutionForRepairV1,
  RepositoryProfileResolverForRepairV1,
} from "./CodeRepairToolRuntimeV1";
import {
  CommitOnlyVerifiedCommitGatewayV1,
  type ArtifactHashSourceV1,
  type FixedArgvGitResultV1,
  type FixedArgvGitRunnerV1,
  type RevisionArtifactHashReaderV1,
} from "./productionAdapters";
import { assertSafeRepositoryRelativePath } from "./protectedControls";
import type {
  ArtifactHashReadbackV1,
  CodeDiffFileV1,
  CodeDiffReadbackV1,
  CodeProofReaderV1,
  ExpectedArtifactV1,
  NormalizedCodeRepairRequestV1,
  VerifiedCommitGatewayV1,
} from "./types";

const MAX_TEXT_OUTPUT_BYTES = 12 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_CHANGED_FILES = 100;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SAFE_BRANCH = /^(?![-/.])(?!.*(?:\.\.|@\{|[~^:?*\[\\\s]))(?!.*[/.]$).{1,255}$/u;
const ALLOWED_GIT_COMMANDS = new Set([
  "add",
  "branch",
  "cat-file",
  "commit",
  "config",
  "diff",
  "diff-tree",
  "read-tree",
  "rev-parse",
  "status",
]);

export interface FixedArgvGitBytesResultV1 {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
}

export interface FixedArgvGitBytesRunnerV1 extends FixedArgvGitRunnerV1 {
  run(input: {
    cwd: string;
    args: readonly string[];
    signal?: AbortSignal;
    gitIndexFile?: string;
  }): Promise<FixedArgvGitResultV1>;
  runBytes(input: {
    cwd: string;
    args: readonly string[];
    signal?: AbortSignal;
    maxStdoutBytes?: number;
    gitIndexFile?: string;
  }): Promise<FixedArgvGitBytesResultV1>;
}

export interface SpawnFixedArgvGitRunnerOptionsV1 {
  executable?: string;
  authorName?: string;
  authorEmail?: string;
  maxOutputBytes?: number;
}

/**
 * Closed Git runner for proof and commit adapters. It uses argv-only spawn,
 * disables interactive credential access and global/system config, and rejects
 * commands outside the fixed proof/commit catalog.
 */
export class SpawnFixedArgvGitRunnerV1 implements FixedArgvGitBytesRunnerV1 {
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly maxOutputBytes: number;

  constructor(options: SpawnFixedArgvGitRunnerOptionsV1 = {}) {
    this.executable = options.executable ?? "git";
    if (!/^(?:git|git\.exe)$/iu.test(path.basename(this.executable))) {
      throw new GitRepairProofErrorV1(
        "git_executable_invalid",
        "Fixed-argv Git runner requires git or git.exe.",
      );
    }
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_TEXT_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1_024) {
      throw new Error("Git output bound is invalid.");
    }
    const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
    this.environment = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: nullConfig,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: options.authorName ?? "Agentic Researcher",
      GIT_AUTHOR_EMAIL: options.authorEmail ?? "agentic-researcher@localhost",
      GIT_COMMITTER_NAME: options.authorName ?? "Agentic Researcher",
      GIT_COMMITTER_EMAIL: options.authorEmail ?? "agentic-researcher@localhost",
    };
  }

  async run(input: {
    cwd: string;
    args: readonly string[];
    signal?: AbortSignal;
    gitIndexFile?: string;
  }): Promise<FixedArgvGitResultV1> {
    const result = await this.runBytes({ ...input, maxStdoutBytes: this.maxOutputBytes });
    let stdout: string;
    try {
      stdout = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    } catch {
      throw new GitRepairProofErrorV1(
        "git_output_not_utf8",
        "Git proof output was not valid UTF-8.",
      );
    }
    return { exitCode: result.exitCode, stdout, stderr: result.stderr };
  }

  async runBytes(input: {
    cwd: string;
    args: readonly string[];
    signal?: AbortSignal;
    maxStdoutBytes?: number;
    gitIndexFile?: string;
  }): Promise<FixedArgvGitBytesResultV1> {
    const cwd = await canonicalDirectory(input.cwd);
    const args = validateGitArgs(input.args);
    const command = gitSubcommand(args);
    if ((command === "add" || command === "commit") && await this.hasLocalFilters(cwd, input.signal)) {
      throw new GitRepairProofErrorV1(
        "git_filter_execution_blocked",
        "Repository-local Git filters are not permitted on the host commit path.",
      );
    }
    return this.spawnBytes({
      cwd,
      args,
      signal: input.signal,
      maxStdoutBytes: input.maxStdoutBytes ?? this.maxOutputBytes,
      gitIndexFile: input.gitIndexFile,
    });
  }

  private async hasLocalFilters(cwd: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.spawnBytes({
      cwd,
      args: ["config", "--local", "--get-regexp", "^filter\\."],
      signal,
      maxStdoutBytes: 64 * 1024,
    });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new GitRepairProofErrorV1(
        "git_config_read_failed",
        `Git local filter inspection failed (${result.exitCode}).`,
      );
    }
    return result.exitCode === 0 && result.stdout.byteLength > 0;
  }

  private spawnBytes(input: {
    cwd: string;
    args: readonly string[];
    signal?: AbortSignal;
    maxStdoutBytes: number;
    gitIndexFile?: string;
  }): Promise<FixedArgvGitBytesResultV1> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        const gitIndexFile = input.gitIndexFile === undefined
          ? undefined
          : safeAbsoluteAuxiliaryPath(input.gitIndexFile, "Git index file");
        child = spawn(this.executable, [...input.args], {
          cwd: input.cwd,
          env: {
            ...this.environment,
            ...(gitIndexFile ? { GIT_INDEX_FILE: gitIndexFile } : {}),
          },
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          signal: input.signal,
        });
      } catch (error) {
        reject(error);
        return;
      }
      child.stdin.end();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(error);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > input.maxStdoutBytes) {
          fail(new GitRepairProofErrorV1("git_output_limit", "Git stdout exceeded its bound."));
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > 1024 * 1024) {
          fail(new GitRepairProofErrorV1("git_output_limit", "Git stderr exceeded its bound."));
          return;
        }
        stderr.push(Buffer.from(chunk));
      });
      child.on("error", fail);
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        let stderrText: string;
        try {
          stderrText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stderr));
        } catch {
          reject(new GitRepairProofErrorV1("git_output_not_utf8", "Git stderr was not valid UTF-8."));
          return;
        }
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout),
          stderr: stderrText,
        });
      });
    });
  }
}

export class FixedArgvArtifactHashReaderV1
  implements RevisionArtifactHashReaderV1
{
  constructor(private readonly git: FixedArgvGitBytesRunnerV1) {}

  async readArtifactHash(input: {
    worktreePath: string;
    path: string;
    source: ArtifactHashSourceV1;
  }): Promise<ArtifactHashReadbackV1 | null> {
    const root = await canonicalDirectory(input.worktreePath);
    const relative = safePath(input.path);
    let bytes: Uint8Array;
    if (input.source.kind === "working") {
      const target = path.resolve(root, ...relative.split("/"));
      if (!isPathWithin(target, root)) throw new Error("Artifact path escaped the worktree.");
      const stat = await fs.lstat(target).catch((error) =>
        isMissing(error) ? null : Promise.reject(error),
      );
      if (!stat) return null;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES) {
        throw new GitRepairProofErrorV1(
          "artifact_boundary_rejected",
          `Artifact ${relative} is not a bounded regular file.`,
        );
      }
      const canonicalTarget = await fs.realpath(target);
      if (!isPathWithin(canonicalTarget, root)) {
        throw new GitRepairProofErrorV1(
          "artifact_boundary_rejected",
          `Artifact ${relative} escaped the canonical worktree.`,
        );
      }
      bytes = await fs.readFile(canonicalTarget);
    } else {
      if (!GIT_SHA.test(input.source.revision)) throw new Error("Artifact revision is invalid.");
      const result = await this.git.runBytes({
        cwd: root,
        args: ["cat-file", "blob", `${input.source.revision}:${relative}`],
        maxStdoutBytes: MAX_ARTIFACT_BYTES,
      });
      if (result.exitCode === 128) return null;
      if (result.exitCode !== 0) {
        throw new GitRepairProofErrorV1(
          "git_artifact_read_failed",
          `Git object readback failed for ${relative} (${result.exitCode}).`,
        );
      }
      bytes = result.stdout;
    }
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new GitRepairProofErrorV1(
        "artifact_boundary_rejected",
        `Artifact ${relative} exceeds the 10 MiB mission artifact boundary.`,
      );
    }
    return {
      path: relative,
      sha256: sha256Bytes(bytes),
      bytes: bytes.byteLength,
    };
  }
}

export interface FixedArgvRepairProofAdapterOptionsV1 {
  workspaceManager: WorkspaceManagerV2;
  git: FixedArgvGitBytesRunnerV1;
  artifactHashReader: RevisionArtifactHashReaderV1;
  getProfile(profileKey: string): Promise<RepositoryProfileV2 | null>;
  now?: () => Date;
}

/** Exact branch/profile resolver and tracked-diff proof reader. */
export class FixedArgvRepairProofAdapterV1
  implements RepositoryProfileResolverForRepairV1, CodeProofReaderV1
{
  private readonly now: () => Date;

  constructor(private readonly options: FixedArgvRepairProofAdapterOptionsV1) {
    this.now = options.now ?? (() => new Date());
  }

  async resolve(input: {
    profileKey: string;
    workspaceId: string;
    runId: string;
    requestId: string;
    manifest: WorkspaceManifestV2;
  }): Promise<RepositoryProfileResolutionForRepairV1 | null> {
    const profile = await this.options.getProfile(input.profileKey);
    if (!profile || !input.manifest.repositoryBinding || !input.manifest.baseSha) return null;
    const root = await this.gitText(input.manifest.canonicalRoot, ["rev-parse", "--show-toplevel"]);
    const head = await this.gitText(input.manifest.canonicalRoot, ["rev-parse", "HEAD"]);
    const branch = await this.gitText(input.manifest.canonicalRoot, ["branch", "--show-current"]);
    await this.gitText(
      input.manifest.canonicalRoot,
      ["cat-file", "-e", `${input.manifest.baseSha}^{commit}`],
      [0],
      true,
    );
    if (
      !sameHostPath(root, input.manifest.canonicalRoot) ||
      !GIT_SHA.test(head) ||
      !SAFE_BRANCH.test(branch) ||
      input.manifest.repositoryBinding.branch === null ||
      branch !== input.manifest.repositoryBinding.branch
    ) {
      throw new GitRepairProofErrorV1(
        "worktree_identity_drift",
        "Fixed-argv Git readback does not match the persisted worktree root, base SHA, and branch.",
      );
    }
    return {
      profile,
      worktreeBranch: branch,
      commitMessage: `Agent repair: ${input.requestId}`,
    };
  }

  async readDiff(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
  }): Promise<CodeDiffReadbackV1> {
    const manifest = await this.assertRequestBoundary(input.request);
    const status = await this.gitText(input.request.worktree.path, [
      "status", "--porcelain=v1", "-z", "--untracked-files=all",
    ], [0], true);
    const authorizedPaths = manifest.budget.changedPaths.map(safePath).sort();
    if (authorizedPaths.length < 1 || authorizedPaths.length > MAX_CHANGED_FILES) {
      throw new GitRepairProofErrorV1(
        "workspace_changed_paths_missing",
        "Ephemeral-index proof requires 1-100 WorkspaceManager-authorized changed paths.",
      );
    }
    assertWorkspaceAuthorizedStatus(status, new Set(authorizedPaths));
    const staged = await this.withEphemeralIndex(
      input.request.worktree.path,
      input.request.worktree.baseSha,
      authorizedPaths,
      async (gitIndexFile) => {
        const shapeOutput = await this.gitText(input.request.worktree.path, [
          "diff", "--cached", "--name-status", "-z", "--find-renames=50%",
          input.request.worktree.baseSha, "--",
        ], [0], true, gitIndexFile);
        const patch = canonicalPatch(await this.gitText(input.request.worktree.path, [
          "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-color",
          "--find-renames=50%", input.request.worktree.baseSha, "--",
        ], [0], false, gitIndexFile));
        return { shape: parseNameStatus(shapeOutput), patch };
      },
    );
    const shape = staged.shape;
    if (shape.length < 1 || shape.length > MAX_CHANGED_FILES) {
      throw new GitRepairProofErrorV1(
        "git_diff_shape_invalid",
        "Ephemeral-index diff must contain 1-100 changed files.",
      );
    }
    const patch = staged.patch;
    if (!patch) throw new Error("Canonical tracked diff patch is empty.");
    const files: CodeDiffFileV1[] = [];
    for (const item of shape) {
      const beforePath = item.status === "renamed" ? item.previousPath! : item.path;
      const before = item.status === "added"
        ? null
        : await this.options.artifactHashReader.readArtifactHash({
            worktreePath: input.request.worktree.path,
            path: beforePath,
            source: { kind: "git_revision", revision: input.request.worktree.baseSha },
          });
      const after = item.status === "deleted"
        ? null
        : await this.options.artifactHashReader.readArtifactHash({
            worktreePath: input.request.worktree.path,
            path: item.path,
            source: { kind: "working" },
          });
      if ((item.status !== "added" && !before) || (item.status !== "deleted" && !after)) {
        throw new GitRepairProofErrorV1(
          "git_artifact_read_failed",
          `Diff artifact hash readback is incomplete for ${item.path}.`,
        );
      }
      files.push({
        path: item.path,
        status: item.status,
        previousPath: item.previousPath,
        beforeSha256: before?.sha256 ?? null,
        afterSha256: after?.sha256 ?? null,
      });
    }
    return {
      operationId: input.operationId,
      baseSha: input.request.worktree.baseSha,
      patch,
      files: files.sort(comparePath),
      readAt: this.now().toISOString(),
    };
  }

  async readArtifactHashes(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    expectedArtifacts: ExpectedArtifactV1[];
  }): Promise<ArtifactHashReadbackV1[]> {
    await this.assertRequestBoundary(input.request);
    if (!Array.isArray(input.expectedArtifacts) || input.expectedArtifacts.length > MAX_CHANGED_FILES) {
      throw new Error("Expected artifact list is invalid.");
    }
    const artifacts: ArtifactHashReadbackV1[] = [];
    let totalBytes = 0;
    for (const expected of input.expectedArtifacts) {
      const artifact = await this.options.artifactHashReader.readArtifactHash({
        worktreePath: input.request.worktree.path,
        path: safePath(expected.path),
        source: { kind: "working" },
      });
      if (!artifact || artifact.sha256 !== expected.sha256) {
        throw new GitRepairProofErrorV1(
          "artifact_hash_mismatch",
          `Working artifact hash changed for ${expected.path}.`,
        );
      }
      artifacts.push(artifact);
      totalBytes += artifact.bytes;
      if (totalBytes > MAX_ARTIFACT_BYTES) {
        throw new GitRepairProofErrorV1(
          "artifact_total_limit",
          "Artifact readback exceeds the 10 MiB mission boundary.",
        );
      }
    }
    return artifacts.sort(comparePath);
  }

  private async assertRequestBoundary(request: NormalizedCodeRepairRequestV1): Promise<WorkspaceManifestV2> {
    const manifest = await this.options.workspaceManager.loadManifest(request.worktree.id);
    if (
      manifest.kind !== "repository" ||
      !manifest.repositoryBinding ||
      manifest.repositoryBinding.branch === null ||
      manifest.ownerRunId !== request.runId ||
      manifest.baseSha !== request.worktree.baseSha ||
      !sameHostPath(manifest.canonicalRoot, request.worktree.path) ||
      !sameHostPath(manifest.repositoryBinding.repositoryRoot, request.worktree.repositoryRoot) ||
      manifest.repositoryBinding.branch !== request.worktree.branch
    ) {
      throw new GitRepairProofErrorV1(
        "repair_workspace_binding_mismatch",
        "Repair request escaped its durable repository-worktree binding.",
      );
    }
    const root = await this.gitText(request.worktree.path, ["rev-parse", "--show-toplevel"]);
    const head = await this.gitText(request.worktree.path, ["rev-parse", "HEAD"]);
    const branch = await this.gitText(request.worktree.path, ["branch", "--show-current"]);
    if (!sameHostPath(root, request.worktree.path) || head !== request.worktree.baseSha || branch !== request.worktree.branch) {
      throw new GitRepairProofErrorV1(
        "worktree_identity_drift",
        "Live Git root, HEAD, or branch changed from the trusted repair request.",
      );
    }
    return manifest;
  }

  private async withEphemeralIndex<T>(
    worktreePath: string,
    baseSha: string,
    authorizedPaths: string[],
    operation: (gitIndexFile: string) => Promise<T>,
  ): Promise<T> {
    const applicationRoot = await canonicalDirectory(
      this.options.workspaceManager.applicationDataRoot,
    );
    const indexRoot = path.join(applicationRoot, "repair-proof-indexes");
    await fs.mkdir(indexRoot, { recursive: true });
    const canonicalIndexRoot = await canonicalDirectory(indexRoot);
    if (!isPathWithin(canonicalIndexRoot, applicationRoot)) {
      throw new GitRepairProofErrorV1(
        "proof_index_boundary",
        "Ephemeral Git index root escaped application data.",
      );
    }
    const container = await fs.mkdtemp(path.join(canonicalIndexRoot, "proof-"));
    const canonicalContainer = await fs.realpath(container);
    if (!isPathWithin(canonicalContainer, canonicalIndexRoot)) {
      throw new GitRepairProofErrorV1(
        "proof_index_boundary",
        "Ephemeral Git index container escaped its host-controlled root.",
      );
    }
    const gitIndexFile = path.join(canonicalContainer, "index");
    try {
      await this.gitText(
        worktreePath,
        ["read-tree", baseSha],
        [0],
        true,
        gitIndexFile,
      );
      await this.gitText(
        worktreePath,
        ["add", "--all", "--", ...authorizedPaths],
        [0],
        true,
        gitIndexFile,
      );
      return await operation(gitIndexFile);
    } finally {
      const resolvedContainer = path.resolve(canonicalContainer);
      if (!isPathWithin(resolvedContainer, canonicalIndexRoot)) {
        throw new GitRepairProofErrorV1(
          "proof_index_cleanup_boundary",
          "Refusing to remove an ephemeral index outside its verified root.",
        );
      }
      await fs.rm(resolvedContainer, { recursive: true, force: true });
    }
  }

  private async gitText(
    cwd: string,
    args: readonly string[],
    allowedExitCodes: readonly number[] = [0],
    allowEmpty = false,
    gitIndexFile?: string,
  ): Promise<string> {
    const result = await this.options.git.run({ cwd, args, gitIndexFile });
    if (!allowedExitCodes.includes(result.exitCode)) {
      throw new GitRepairProofErrorV1(
        "git_command_failed",
        `Git ${gitSubcommand(args)} failed (${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`,
      );
    }
    const output = result.stdout.replace(/(?:\r?\n)+$/u, "");
    if (!allowEmpty && !output) throw new Error(`Git ${gitSubcommand(args)} returned no output.`);
    return output;
  }
}

export async function createFixedArgvVerifiedCommitGatewayV1(input: {
  workspaceManager: WorkspaceManagerV2;
  git: FixedArgvGitBytesRunnerV1;
  artifactHashReader: RevisionArtifactHashReaderV1;
  disabledHooksPath: string;
  now?: () => Date;
}): Promise<VerifiedCommitGatewayV1> {
  const hooks = path.resolve(input.disabledHooksPath);
  await fs.mkdir(hooks, { recursive: true });
  const stat = await fs.lstat(hooks);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new GitRepairProofErrorV1(
      "hooks_path_invalid",
      "Host-controlled disabled-hooks path is not a safe directory.",
    );
  }
  const canonicalHooks = await fs.realpath(hooks);
  return new CommitOnlyVerifiedCommitGatewayV1({
    git: input.git,
    artifactHashReader: input.artifactHashReader,
    disabledHooksPath: canonicalHooks,
    now: () => (input.now ?? (() => new Date()))().toISOString(),
    async resolveAllowedPaths(request) {
      const manifest = await input.workspaceManager.loadManifest(request.worktree.id);
      if (
        manifest.kind !== "repository" ||
        manifest.ownerRunId !== request.runId ||
        manifest.repositoryBinding?.branch !== request.worktree.branch
      ) throw new Error("Commit allowed-path readback lost its workspace binding.");
      const allowed = manifest.budget.changedPaths.map(safePath);
      if (allowed.length < 1) {
        throw new GitRepairProofErrorV1(
          "commit_changed_paths_missing",
          "Verified commit requires WorkspaceManagerV2 changed-path receipts.",
        );
      }
      return allowed;
    },
  });
}

export class GitRepairProofErrorV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GitRepairProofErrorV1";
  }
}

interface GitShapeV1 {
  path: string;
  status: CodeDiffFileV1["status"];
  previousPath: string | null;
}

function parseNameStatus(output: string): GitShapeV1[] {
  if (!output) return [];
  const tokens = output.split("\u0000");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const result: GitShapeV1[] = [];
  for (let index = 0; index < tokens.length;) {
    let status = tokens[index++];
    let inline: string | null = null;
    const tab = status.indexOf("\t");
    if (tab >= 0) {
      inline = status.slice(tab + 1);
      status = status.slice(0, tab);
    }
    const code = status[0];
    if (code === "R") {
      const previous = inline ?? tokens[index++];
      const next = tokens[index++];
      if (!previous || !next) throw new Error("Git rename record is truncated.");
      result.push({ path: safePath(next), status: "renamed", previousPath: safePath(previous) });
      continue;
    }
    const file = inline ?? tokens[index++];
    if (!file) throw new Error("Git diff path is missing.");
    const mapped = code === "A" ? "added" : code === "M" || code === "T"
      ? "modified" : code === "D" ? "deleted" : null;
    if (!mapped) throw new Error(`Unsupported Git diff status ${status}.`);
    result.push({ path: safePath(file), status: mapped, previousPath: null });
  }
  return result.sort(comparePath);
}

function assertWorkspaceAuthorizedStatus(
  status: string,
  authorizedPaths: ReadonlySet<string>,
): void {
  if (!status) return;
  const tokens = status.split("\u0000");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4 || token[2] !== " ") throw new Error("Git status record is invalid.");
    const code = token.slice(0, 2);
    if (code !== "??" && token[0] !== " ") {
      throw new GitRepairProofErrorV1(
        "pre_staged_changes_blocked",
        "Repair proof requires a clean index; pre-staged changes are blocked.",
      );
    }
    if (code !== "??" && !/[MDTR]/u.test(token[1])) {
      throw new GitRepairProofErrorV1(
        "git_status_unsupported",
        `Git worktree status ${code} is unsupported by the proof adapter.`,
      );
    }
    const currentPath = safePath(token.slice(3));
    const involved = [currentPath];
    if (code.includes("R")) {
      const previous = tokens[++index];
      if (!previous) throw new Error("Git status rename record is truncated.");
      involved.push(safePath(previous));
    }
    const unauthorized = involved.filter((entry) => !authorizedPaths.has(entry));
    if (unauthorized.length > 0) {
      throw new GitRepairProofErrorV1(
        "workspace_status_not_authorized",
        `Git status contains paths without WorkspaceManager receipts: ${unauthorized.join(", ")}.`,
      );
    }
  }
}

function validateGitArgs(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 256) {
    throw new Error("Git argv is invalid.");
  }
  const args = input.map((entry) => {
    if (typeof entry !== "string" || entry.length > 16_384 || entry.includes("\u0000")) {
      throw new Error("Git argument is invalid.");
    }
    return entry;
  });
  const command = gitSubcommand(args);
  if (!ALLOWED_GIT_COMMANDS.has(command)) {
    throw new GitRepairProofErrorV1(
      "git_command_not_allowed",
      `Git command ${command} is outside the fixed repair catalog.`,
    );
  }
  return args;
}

function gitSubcommand(args: readonly string[]): string {
  let index = 0;
  while (args[index] === "-c") index += 2;
  if (args[index] === "--literal-pathspecs") index += 1;
  const command = args[index];
  if (!command || command.startsWith("-")) throw new Error("Git subcommand is missing.");
  return command;
}

function canonicalPatch(value: string): string {
  if (value.includes("\u0000")) throw new Error("Git patch contains NUL.");
  const normalized = value.replace(/\r\n?/gu, "\n").replace(/\n+$/u, "");
  return normalized ? `${normalized}\n` : "";
}

async function canonicalDirectory(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error("Git cwd must be absolute.");
  const canonical = await fs.realpath(value);
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Git cwd is unsafe.");
  return canonical;
}

function safeAbsoluteAuxiliaryPath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\u0000") ||
    path.resolve(value) === path.parse(path.resolve(value)).root
  ) throw new Error(`${label} is not a safe absolute path.`);
  return path.resolve(value);
}

function safePath(value: string): string {
  const safe = assertSafeRepositoryRelativePath(value);
  if (safe !== value || safe.split("/")[0].toLowerCase() === ".git") {
    throw new Error("Git path is not canonical or targets .git.");
  }
  return safe;
}

function sha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function comparePath<T extends { path: string }>(left: T, right: T): number {
  return left.path.localeCompare(right.path);
}

function sameHostPath(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(value).replace(/\\/gu, "/").toLowerCase();
  return normalize(left) === normalize(right);
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "ENOENT");
}
