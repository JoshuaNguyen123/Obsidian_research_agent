import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  isSafeGitBranchNameV1,
  type FixedArgvGitBytesRunnerV1,
} from "../repair/GitRepairProofAdaptersV1";

/**
 * Turning an agent-owned scratch workspace into a real Git repository.
 *
 * Every gateway downstream of a code mission — the verified commit adapter,
 * the fixed-argv proof reader, the audited push site — resolves through
 * `manifest.repositoryBinding`. A scratch workspace never has one, and nothing
 * in production could create one: `git init` existed only in e2e fixtures, so
 * the whole GitHub half of the pipeline was reachable only for repositories a
 * test had built beforehand. A mission that authors a new project therefore
 * dead-ended at `code_workspace_export_directory` — a folder on the user's
 * Desktop, never a repository.
 *
 * This module is the missing step, and it is deliberately not a general
 * escape hatch:
 *
 * - It only ever runs against a directory the WorkspaceManager itself created
 *   inside its own metadata container. The caller proves containment before
 *   calling; `base_checkout_forbidden` therefore still stands for every
 *   externally-rooted repository, which is the case that refusal exists for.
 * - It refuses a directory that already carries a `.git` marker, so it can
 *   neither reinitialize nor adopt an existing repository.
 * - It stages an exact, caller-supplied path list — the manager's own tracked
 *   files — never a wildcard, and requires a clean status afterwards.
 * - It runs on the hardened fixed-argv runner, which disables interactive
 *   credentials, system/global config, and hooks, refuses repositories with
 *   local clean/smudge filters on `add`/`commit`, and stamps the pinned
 *   neutral agent identity.
 *
 * The result is shaped exactly like a provisioned worktree binding: an agent
 * branch at an initial commit, plus a default branch pointing at the same
 * commit so the publication flow has a base to open a pull request against.
 */

export const SCRATCH_REPOSITORY_DEFAULT_BRANCH_V1 = "main";
export const SCRATCH_REPOSITORY_MAX_TRACKED_FILES_V1 = 100;
export const SCRATCH_REPOSITORY_MAX_COMMIT_MESSAGE_CHARS_V1 = 4_000;

const GIT_SHA_V1 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export class ScratchRepositoryPromotionErrorV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ScratchRepositoryPromotionErrorV1";
  }
}

export interface ScratchRepositoryInitializationV1 {
  /** Scratch promotion is in place: the repository is its own worktree. */
  repositoryRoot: string;
  worktreeRoot: string;
  /** Agent-owned branch that HEAD points at. */
  branch: string;
  /** Base branch created at the same commit for publication targets. */
  defaultBranch: string;
  baseSha: string;
  trackedPaths: string[];
  clean: true;
}

/**
 * The agent branch a promoted scratch workspace lands on. Deliberately the
 * same shape `LocalGitWorkspaceProvisionerV2.provision` uses for real
 * repository worktrees, so every downstream branch check sees one convention.
 */
export function scratchRepositoryAgentBranchV1(workspaceId: string): string {
  const branch = `codex/workspace-${workspaceId}`;
  if (!isSafeGitBranchNameV1(branch)) {
    throw new ScratchRepositoryPromotionErrorV1(
      "invalid_branch",
      `Workspace ${workspaceId} does not produce a safe agent branch name.`,
    );
  }
  return branch;
}

export interface InitializeScratchGitRepositoryInputV1 {
  git: FixedArgvGitBytesRunnerV1;
  /** Realpath of the workspace root; the caller proves containment first. */
  canonicalRoot: string;
  branch: string;
  defaultBranch?: string;
  commitMessage: string;
  /** Exact workspace-relative paths to stage. Never a wildcard. */
  trackedPaths: readonly string[];
  /** Host-owned empty directory used as `core.hooksPath` for the commit. */
  disabledHooksPath: string;
  signal?: AbortSignal;
}

export async function initializeScratchGitRepositoryV1(
  input: InitializeScratchGitRepositoryInputV1,
): Promise<ScratchRepositoryInitializationV1> {
  const root = await canonicalExistingDirectory(input.canonicalRoot);
  const branch = requireSafeBranch(input.branch, "agent branch");
  const defaultBranch = requireSafeBranch(
    input.defaultBranch ?? SCRATCH_REPOSITORY_DEFAULT_BRANCH_V1,
    "default branch",
  );
  if (branch === defaultBranch) {
    throw new ScratchRepositoryPromotionErrorV1(
      "branch_collision",
      "The agent branch and the publication base branch must differ.",
    );
  }
  const commitMessage = requireCommitMessage(input.commitMessage);
  const trackedPaths = normalizeTrackedPaths(input.trackedPaths);
  const hooksPath = await canonicalExistingDirectory(input.disabledHooksPath);

  const gitMarker = await fs.lstat(path.join(root, ".git")).catch(() => null);
  if (gitMarker) {
    throw new ScratchRepositoryPromotionErrorV1(
      "repository_already_initialized",
      "The workspace already carries a .git marker; promotion never reinitializes or adopts an existing repository.",
    );
  }
  for (const relative of trackedPaths) {
    const target = path.resolve(root, ...relative.split("/"));
    if (!isPathWithin(target, root)) {
      throw new ScratchRepositoryPromotionErrorV1(
        "tracked_path_escape",
        `Tracked path ${relative} escapes the workspace root.`,
      );
    }
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new ScratchRepositoryPromotionErrorV1(
        "tracked_path_missing",
        `Tracked path ${relative} is not a bounded regular file.`,
      );
    }
  }

  await run(input, root, ["init", "--quiet", "-b", branch]);
  await run(input, root, ["--literal-pathspecs", "add", "--", ...trackedPaths]);
  await run(input, root, [
    "-c",
    `core.hooksPath=${hooksPath}`,
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    commitMessage,
    "--",
  ]);

  const baseSha = (await text(input, root, ["rev-parse", "HEAD"])).trim();
  if (!GIT_SHA_V1.test(baseSha)) {
    throw new ScratchRepositoryPromotionErrorV1(
      "initial_commit_unverified",
      "The initial commit did not read back as an exact object id.",
    );
  }
  // A base branch at the same commit, created without moving HEAD. The
  // publication flow needs something to open a pull request against, and
  // `checkout` stays outside the allowlist by design.
  await run(input, root, ["branch", defaultBranch, baseSha]);

  const observedRoot = (
    await text(input, root, ["rev-parse", "--show-toplevel"])
  ).trim();
  const observedBranch = (
    await text(input, root, ["branch", "--show-current"])
  ).trim();
  const status = await text(
    input,
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    true,
  );
  if (!sameHostPath(observedRoot, root)) {
    throw new ScratchRepositoryPromotionErrorV1(
      "repository_root_drift",
      "The initialized repository does not report the workspace root as its toplevel.",
    );
  }
  if (observedBranch !== branch) {
    throw new ScratchRepositoryPromotionErrorV1(
      "repository_branch_drift",
      `The initialized repository is on ${observedBranch || "(detached)"}, not the prepared agent branch ${branch}.`,
    );
  }
  if (status.trim().length > 0) {
    throw new ScratchRepositoryPromotionErrorV1(
      "repository_not_clean",
      "The initial commit did not capture every workspace file; promotion requires a clean tree.",
    );
  }
  return {
    repositoryRoot: root,
    worktreeRoot: root,
    branch,
    defaultBranch,
    baseSha: baseSha.toLowerCase(),
    trackedPaths,
    clean: true,
  };
}

async function run(
  input: InitializeScratchGitRepositoryInputV1,
  cwd: string,
  args: readonly string[],
): Promise<void> {
  const result = await input.git.run({ cwd, args, signal: input.signal });
  if (result.exitCode !== 0) {
    throw new ScratchRepositoryPromotionErrorV1(
      "git_operation_failed",
      `Git ${args.find((arg) => !arg.startsWith("-")) ?? "command"} failed (${result.exitCode}): ${result.stderr.trim().slice(0, 1_000)}`,
    );
  }
}

async function text(
  input: InitializeScratchGitRepositoryInputV1,
  cwd: string,
  args: readonly string[],
  allowEmpty = false,
): Promise<string> {
  const result = await input.git.run({ cwd, args, signal: input.signal });
  if (result.exitCode !== 0) {
    throw new ScratchRepositoryPromotionErrorV1(
      "git_operation_failed",
      `Git ${args[0]} failed (${result.exitCode}): ${result.stderr.trim().slice(0, 1_000)}`,
    );
  }
  if (!allowEmpty && !result.stdout.trim()) {
    throw new ScratchRepositoryPromotionErrorV1(
      "git_empty_result",
      `Git ${args[0]} returned no output.`,
    );
  }
  return result.stdout;
}

function requireSafeBranch(value: unknown, label: string): string {
  if (!isSafeGitBranchNameV1(value)) {
    throw new ScratchRepositoryPromotionErrorV1(
      "invalid_branch",
      `Scratch repository ${label} is not a safe Git branch name.`,
    );
  }
  return value;
}

function requireCommitMessage(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > SCRATCH_REPOSITORY_MAX_COMMIT_MESSAGE_CHARS_V1 ||
    /[\0\r]/u.test(value)
  ) {
    throw new ScratchRepositoryPromotionErrorV1(
      "invalid_commit_message",
      "Scratch repository commit message is missing or outside its bounds.",
    );
  }
  return value;
}

function normalizeTrackedPaths(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1) {
    throw new ScratchRepositoryPromotionErrorV1(
      "tracked_paths_missing",
      "Scratch repository promotion requires at least one durable workspace file.",
    );
  }
  if (values.length > SCRATCH_REPOSITORY_MAX_TRACKED_FILES_V1) {
    throw new ScratchRepositoryPromotionErrorV1(
      "tracked_paths_exceeded",
      `Scratch repository promotion is bounded to ${SCRATCH_REPOSITORY_MAX_TRACKED_FILES_V1} files.`,
    );
  }
  const normalized = values.map((value) => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 1_024 ||
      value.startsWith("-") ||
      value.startsWith("/") ||
      value.includes("\\") ||
      /^[a-z]:/iu.test(value) ||
      /[\0\r\n]/u.test(value)
    ) {
      throw new ScratchRepositoryPromotionErrorV1(
        "tracked_path_invalid",
        "Scratch repository tracked paths must be plain workspace-relative files.",
      );
    }
    const parts = value.split("/");
    if (
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
    ) {
      throw new ScratchRepositoryPromotionErrorV1(
        "tracked_path_invalid",
        `Scratch repository tracked path ${value} is not canonical or targets .git.`,
      );
    }
    return parts.join("/");
  });
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) {
    throw new ScratchRepositoryPromotionErrorV1(
      "tracked_path_invalid",
      "Scratch repository tracked paths must be unique.",
    );
  }
  return unique;
}

async function canonicalExistingDirectory(value: string): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new ScratchRepositoryPromotionErrorV1(
      "invalid_absolute_path",
      "Scratch repository promotion requires absolute host paths.",
    );
  }
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ScratchRepositoryPromotionErrorV1(
      "unsafe_directory",
      `${value} is not a safe existing directory.`,
    );
  }
  return fs.realpath(value);
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function sameHostPath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    path.resolve(value).replace(/\\/gu, "/").toLowerCase();
  return normalize(left) === normalize(right);
}
