import { sha256Fingerprint } from "../../../packages/headless-runtime/src/canonicalize";

import { assertSafeRepositoryRelativePath } from "./protectedControls";
import {
  type ArtifactHashReadbackV1,
  type CodeCommitReadbackV1,
  type CodeCommitResultV1,
  type CodeDiffFileV1,
  type CodeDiffReceiptV1,
  type CodeRepairCheckpointStoreV1,
  type CodeRepairCheckpointV1,
  type CodeValidationReceiptV1,
  type NormalizedCodeRepairRequestV1,
  type VerifiedCommitGatewayV1,
} from "./types";
import { parseCodeRepairCheckpointV1 } from "./codeRepairCoordinator";

const CHECKPOINT_NAMESPACE_VERSION = 1 as const;
const MAX_CHECKPOINTS = 512;
const MAX_CHANGED_FILES = 100;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_GIT_OUTPUT_CHARACTERS = 12 * 1024 * 1024;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface CodeRepairCheckpointNamespaceV1 {
  version: typeof CHECKPOINT_NAMESPACE_VERSION;
  revision: number;
  checkpoints: Record<string, CodeRepairCheckpointV1>;
}

export interface CallbackCheckpointPersistenceV1 {
  /** Return only the extension-owned repair namespace from plugin data. */
  readNamespace(): Promise<CodeRepairCheckpointNamespaceV1 | null | undefined>;
  /**
   * Replace only that namespace. The owning extension must serialize this with
   * its other loadData/saveData writes so unrelated plugin data is preserved.
   */
  writeNamespace(
    namespace: CodeRepairCheckpointNamespaceV1,
    expectedRevision: number,
  ): Promise<boolean>;
}

/**
 * Plugin-data-compatible single-writer CAS store. All operations issued through
 * one instance are serialized; sequence conflicts fail instead of overwriting.
 */
export class CallbackCodeRepairCheckpointStoreV1
  implements CodeRepairCheckpointStoreV1
{
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: CallbackCheckpointPersistenceV1) {}

  load(id: string): Promise<CodeRepairCheckpointV1 | null> {
    const checkpointId = boundedIdentifier(id, "checkpoint id", 512);
    return this.serialized(async () => {
      const namespace = await normalizeCheckpointNamespace(
        await this.persistence.readNamespace(),
      );
      const checkpoint = namespace.checkpoints[checkpointId];
      return checkpoint ? cloneJson(checkpoint) : null;
    });
  }

  findByMissionWorkspace(input: {
    runId: string;
    workspaceId: string;
  }): Promise<CodeRepairCheckpointV1[]> {
    const runId = boundedIdentifier(input.runId, "repair mission id", 128);
    const workspaceId = boundedIdentifier(
      input.workspaceId,
      "repair workspace id",
      128,
    );
    return this.serialized(async () => {
      const namespace = await normalizeCheckpointNamespace(
        await this.persistence.readNamespace(),
      );
      return Object.values(namespace.checkpoints)
        .filter(
          (checkpoint) =>
            checkpoint.request.runId === runId &&
            checkpoint.request.worktree.id === workspaceId,
        )
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((checkpoint) => cloneJson(checkpoint));
    });
  }

  save(
    checkpointInput: CodeRepairCheckpointV1,
    expectedSequence: number | null,
  ): Promise<void> {
    const checkpointPromise = parseCodeRepairCheckpointV1(checkpointInput);
    if (
      expectedSequence !== null &&
      (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0)
    ) {
      return Promise.reject(
        new ProductionAdapterErrorV1(
          "checkpoint_sequence_invalid",
          "Expected checkpoint sequence must be null or a non-negative safe integer.",
        ),
      );
    }
    return this.serialized(async () => {
      const checkpoint = await checkpointPromise;
      const namespace = await normalizeCheckpointNamespace(
        await this.persistence.readNamespace(),
      );
      const current = namespace.checkpoints[checkpoint.id];
      if (expectedSequence === null) {
        if (current) {
          throw new ProductionAdapterErrorV1(
            "checkpoint_exists",
            `Checkpoint ${checkpoint.id} already exists.`,
          );
        }
        if (checkpoint.sequence !== 0) {
          throw new ProductionAdapterErrorV1(
            "checkpoint_sequence_conflict",
            "A newly created checkpoint must start at sequence zero.",
          );
        }
      } else {
        if (!current || current.sequence !== expectedSequence) {
          throw new ProductionAdapterErrorV1(
            "checkpoint_sequence_conflict",
            `Checkpoint ${checkpoint.id} no longer has sequence ${expectedSequence}.`,
          );
        }
        if (checkpoint.sequence !== expectedSequence + 1) {
          throw new ProductionAdapterErrorV1(
            "checkpoint_sequence_conflict",
            "The replacement checkpoint must increment sequence exactly once.",
          );
        }
        if (current.terminal && !sameJson(current, checkpoint)) {
          throw new ProductionAdapterErrorV1(
            "checkpoint_terminal",
            "A terminal repair checkpoint is immutable.",
          );
        }
      }
      const existingCount = Object.keys(namespace.checkpoints).length;
      if (!current && existingCount >= MAX_CHECKPOINTS) {
        throw new ProductionAdapterErrorV1(
          "checkpoint_capacity",
          `Repair checkpoint namespace is limited to ${MAX_CHECKPOINTS} records.`,
        );
      }
      const next: CodeRepairCheckpointNamespaceV1 = {
        version: CHECKPOINT_NAMESPACE_VERSION,
        revision: namespace.revision + 1,
        checkpoints: {
          ...namespace.checkpoints,
          [checkpoint.id]: cloneJson(checkpoint),
        },
      };
      const written = await this.persistence.writeNamespace(
        cloneJson(next),
        namespace.revision,
      );
      if (written !== true) {
        throw new ProductionAdapterErrorV1(
          "checkpoint_namespace_conflict",
          `Repair checkpoint namespace no longer has revision ${namespace.revision}.`,
        );
      }
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface FixedArgvGitResultV1 {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Implement with spawn("git", args, { shell: false }); never a command string. */
export interface FixedArgvGitRunnerV1 {
  run(input: {
    cwd: string;
    args: readonly string[];
    signal?: AbortSignal;
  }): Promise<FixedArgvGitResultV1>;
}

export type ArtifactHashSourceV1 =
  | { kind: "working" }
  | { kind: "git_revision"; revision: string };

export interface RevisionArtifactHashReaderV1 {
  readArtifactHash(input: {
    worktreePath: string;
    path: string;
    source: ArtifactHashSourceV1;
  }): Promise<ArtifactHashReadbackV1 | null>;
}

export interface CommitOnlyVerifiedGatewayOptionsV1 {
  git: FixedArgvGitRunnerV1;
  artifactHashReader: RevisionArtifactHashReaderV1;
  /** Exact repository-relative paths authorized for this trusted workspace. */
  resolveAllowedPaths(
    request: NormalizedCodeRepairRequestV1,
  ): Promise<readonly string[]> | readonly string[];
  /** Existing empty directory controlled by the host, not the repository. */
  disabledHooksPath: string;
  signal?: AbortSignal;
  now?: () => string;
}

/**
 * Commit-only Git adapter. It cannot run validators, dependency installers,
 * arbitrary commands, pushes, merges, or legacy GitWorktreeManager methods.
 */
export class CommitOnlyVerifiedCommitGatewayV1
  implements VerifiedCommitGatewayV1
{
  private readonly now: () => string;
  private readonly disabledHooksPath: string;

  constructor(private readonly options: CommitOnlyVerifiedGatewayOptionsV1) {
    this.disabledHooksPath = boundedArg(
      options.disabledHooksPath,
      "disabled hooks path",
      2_048,
    );
    if (!isAbsoluteHostPath(this.disabledHooksPath)) {
      throw new ProductionAdapterErrorV1(
        "hooks_path_invalid",
        "Disabled hooks path must be an absolute host-controlled directory.",
      );
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async commit(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    diff: CodeDiffReceiptV1;
    artifactHashes: ArtifactHashReadbackV1[];
    targetedValidation: CodeValidationReceiptV1;
    fullValidation: CodeValidationReceiptV1;
  }): Promise<CodeCommitResultV1> {
    const operationId = boundedIdentifier(input.operationId, "commit operation id", 512);
    assertRequestBinding(input.request);
    await assertGreenValidationPair(input.targetedValidation, input.fullValidation);
    const diff = await validatePreparedDiff(input.request, input.diff);
    assertValidationCoversDiff(
      input.request,
      diff,
      input.targetedValidation,
      input.fullValidation,
    );
    const expectedArtifacts = normalizeArtifacts(input.artifactHashes);
    assertArtifactsDescribeDiff(diff.files, expectedArtifacts);
    const allowedPaths = await this.allowedPaths(input.request);
    const involvedPaths = involvedDiffPaths(diff.files);
    assertPathsAllowed(involvedPaths, allowedPaths);
    await this.assertRepositoryBoundary(input.request);

    const head = await this.gitText(input.request.worktree.path, ["rev-parse", "HEAD"]);
    if (head !== input.request.worktree.baseSha) {
      const reconciled = await this.readCommit({
        operationId: `${operationId}:reconcile`,
        request: input.request,
        commitSha: head,
      });
      const mismatch = compareCommittedEvidence({
        readback: reconciled,
        request: input.request,
        diff,
        artifacts: expectedArtifacts,
      });
      if (mismatch) {
        throw new ProductionAdapterErrorV1(
          "commit_base_drift",
          `Worktree HEAD moved away from the trusted base: ${mismatch}`,
        );
      }
      const status = parsePorcelainStatus(
        await this.gitText(
          input.request.worktree.path,
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          true,
        ),
      );
      if (status.length > 0) {
        throw new ProductionAdapterErrorV1(
          "commit_reconcile_dirty",
          "The reconciled commit exists but the worktree is no longer clean.",
        );
      }
      return { operationId, commitSha: head, committedAt: this.timestamp() };
    }

    const status = parsePorcelainStatus(
      await this.gitText(
        input.request.worktree.path,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        true,
      ),
    );
    assertWorkingStatusMatchesDiff(status, diff.files);
    await this.assertDiffArtifactHashes({
      request: input.request,
      files: diff.files,
      expectedArtifacts,
      afterSource: { kind: "working" },
    });

    await this.gitOk(input.request.worktree.path, [
      "add",
      "--all",
      "--",
      ...involvedPaths,
    ]);

    const postStageStatus = parsePorcelainStatus(
      await this.gitText(
        input.request.worktree.path,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        true,
      ),
    );
    assertWorkingStatusMatchesDiff(postStageStatus, diff.files);

    const stagedFiles = parseNameStatus(
      await this.gitText(input.request.worktree.path, [
        "diff",
        "--cached",
        "--name-status",
        "-z",
        "--find-renames=50%",
        input.request.worktree.baseSha,
        "--",
      ]),
    );
    assertDiffShapeEqual(diff.files, stagedFiles);
    const stagedPatch = canonicalGitPatch(
      await this.gitText(
        input.request.worktree.path,
        canonicalDiffArgs({ cached: true, base: input.request.worktree.baseSha }),
      ),
    );
    if (stagedPatch !== diff.patch) {
      throw new ProductionAdapterErrorV1(
        "commit_diff_drift",
        "The staged Git patch differs from the exact approved patch.",
      );
    }
    const stagedFingerprint = await diffFingerprint({
      baseSha: input.request.worktree.baseSha,
      patch: stagedPatch,
      files: diff.files,
    });
    if (stagedFingerprint !== diff.fingerprint) {
      throw new ProductionAdapterErrorV1(
        "commit_diff_fingerprint",
        "The staged diff fingerprint differs from the approved fingerprint.",
      );
    }
    const indexMatchesWorking = await this.git(
      input.request.worktree.path,
      ["diff", "--quiet", "--no-ext-diff", "--"],
      [0, 1],
    );
    if (indexMatchesWorking.exitCode !== 0) {
      throw new ProductionAdapterErrorV1(
        "commit_worktree_drift",
        "The worktree changed after its files were staged.",
      );
    }
    await this.assertAfterArtifactHashes(
      input.request,
      diff.files,
      expectedArtifacts,
      { kind: "working" },
    );
    await this.assertRepositoryBoundary(input.request);
    const headBeforeCommit = await this.gitText(input.request.worktree.path, [
      "rev-parse",
      "HEAD",
    ]);
    if (headBeforeCommit !== input.request.worktree.baseSha) {
      throw new ProductionAdapterErrorV1(
        "commit_base_drift",
        "Worktree HEAD changed while the commit was being prepared.",
      );
    }

    await this.gitOk(input.request.worktree.path, [
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      boundedArg(input.request.commitMessage, "commit message", 4_000),
      "--",
    ]);
    const commitSha = assertGitSha(
      await this.gitText(input.request.worktree.path, ["rev-parse", "HEAD"]),
      "created commit SHA",
    );
    const readback = await this.readCommit({
      operationId: `${operationId}:verify`,
      request: input.request,
      commitSha,
    });
    const mismatch = compareCommittedEvidence({
      readback,
      request: input.request,
      diff,
      artifacts: expectedArtifacts,
    });
    if (mismatch) {
      throw new ProductionAdapterErrorV1(
        "commit_readback_mismatch",
        `Created commit failed object-level readback: ${mismatch}`,
      );
    }
    const postCommitStatus = parsePorcelainStatus(
      await this.gitText(
        input.request.worktree.path,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        true,
      ),
    );
    if (postCommitStatus.length > 0) {
      throw new ProductionAdapterErrorV1(
        "commit_post_readback_dirty",
        "Commit object was verified, but the worktree is no longer clean.",
      );
    }
    return { operationId, commitSha, committedAt: this.timestamp() };
  }

  async readCommit(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    commitSha: string;
  }): Promise<CodeCommitReadbackV1> {
    const operationId = boundedIdentifier(input.operationId, "readback operation id", 640);
    assertRequestBinding(input.request);
    await this.assertRepositoryBoundary(input.request);
    const commitSha = assertGitSha(input.commitSha, "readback commit SHA");
    const parentSha = assertGitSha(
      await this.gitText(input.request.worktree.path, [
        "rev-parse",
        `${commitSha}^`,
      ]),
      "commit parent SHA",
    );
    if (parentSha !== input.request.worktree.baseSha) {
      throw new ProductionAdapterErrorV1(
        "commit_parent_mismatch",
        "Commit parent does not match the trusted workspace base SHA.",
      );
    }
    const treeSha = assertGitSha(
      await this.gitText(input.request.worktree.path, [
        "rev-parse",
        `${commitSha}^{tree}`,
      ]),
      "commit tree SHA",
    );
    const shape = parseNameStatus(
      await this.gitText(input.request.worktree.path, [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        "--find-renames=50%",
        parentSha,
        commitSha,
        "--",
      ]),
    );
    if (shape.length < 1 || shape.length > MAX_CHANGED_FILES) {
      throw new ProductionAdapterErrorV1(
        "commit_readback_shape",
        "Commit readback contains an invalid changed-file count.",
      );
    }
    const allowedPaths = await this.allowedPaths(input.request);
    assertPathsAllowed(
      shape.flatMap((item) =>
        item.status === "renamed" && item.previousPath
          ? [item.path, item.previousPath]
          : [item.path],
      ),
      allowedPaths,
    );
    const patch = canonicalGitPatch(
      await this.gitText(
        input.request.worktree.path,
        canonicalDiffArgs({ base: parentSha, target: commitSha }),
      ),
    );
    const files: CodeDiffFileV1[] = [];
    const artifacts: ArtifactHashReadbackV1[] = [];
    for (const item of shape) {
      const beforePath = item.status === "renamed" ? item.previousPath : item.path;
      const before =
        item.status === "added"
          ? null
          : await this.requiredArtifactHash(input.request, beforePath!, {
              kind: "git_revision",
              revision: parentSha,
            });
      const after =
        item.status === "deleted"
          ? null
          : await this.requiredArtifactHash(input.request, item.path, {
              kind: "git_revision",
              revision: commitSha,
            });
      files.push({
        path: item.path,
        status: item.status,
        previousPath: item.previousPath,
        beforeSha256: before?.sha256 ?? null,
        afterSha256: after?.sha256 ?? null,
      });
      if (after) artifacts.push(after);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    artifacts.sort((left, right) => left.path.localeCompare(right.path));
    const fingerprint = await diffFingerprint({ baseSha: parentSha, patch, files });
    return {
      operationId,
      commitSha,
      parentSha,
      treeSha,
      diffFingerprint: fingerprint,
      changedPaths: files.map((file) => file.path),
      artifactHashes: artifacts,
      readAt: this.timestamp(),
    };
  }

  async reconcilePreparedCommit(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    diff: CodeDiffReceiptV1;
    artifactHashes: ArtifactHashReadbackV1[];
    targetedValidation: CodeValidationReceiptV1;
    fullValidation: CodeValidationReceiptV1;
  }): Promise<
    | { outcome: "committed"; commit: CodeCommitResultV1; readback: CodeCommitReadbackV1 }
    | { outcome: "not_applied" }
    | { outcome: "still_uncertain"; message: string }
  > {
    const operationId = boundedIdentifier(
      input.operationId,
      "commit reconciliation operation id",
      512,
    );
    try {
      assertRequestBinding(input.request);
      await assertGreenValidationPair(input.targetedValidation, input.fullValidation);
      const diff = await validatePreparedDiff(input.request, input.diff);
      assertValidationCoversDiff(
        input.request,
        diff,
        input.targetedValidation,
        input.fullValidation,
      );
      const artifacts = normalizeArtifacts(input.artifactHashes);
      assertArtifactsDescribeDiff(diff.files, artifacts);
      await this.assertRepositoryBoundary(input.request);
      const head = await this.gitText(input.request.worktree.path, ["rev-parse", "HEAD"]);
      if (head === input.request.worktree.baseSha) return { outcome: "not_applied" };
      const readback = await this.readCommit({
        operationId: `${operationId}:readback`,
        request: input.request,
        commitSha: head,
      });
      const mismatch = compareCommittedEvidence({
        readback,
        request: input.request,
        diff,
        artifacts,
      });
      if (mismatch) {
        return {
          outcome: "still_uncertain",
          message: `Current HEAD does not match the prepared commit evidence: ${mismatch}`,
        };
      }
      const status = parsePorcelainStatus(
        await this.gitText(
          input.request.worktree.path,
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          true,
        ),
      );
      if (status.length > 0) {
        return {
          outcome: "still_uncertain",
          message: "Prepared commit exists, but the worktree is no longer clean.",
        };
      }
      return {
        outcome: "committed",
        commit: { operationId, commitSha: head, committedAt: this.timestamp() },
        readback,
      };
    } catch (error) {
      return {
        outcome: "still_uncertain",
        message: `Git reconciliation could not prove the prepared commit: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000),
      };
    }
  }

  private async assertRepositoryBoundary(
    request: NormalizedCodeRepairRequestV1,
  ): Promise<void> {
    if (
      isHostPathWithin(this.disabledHooksPath, request.worktree.path) ||
      isHostPathWithin(this.disabledHooksPath, request.worktree.repositoryRoot)
    ) {
      throw new ProductionAdapterErrorV1(
        "hooks_path_invalid",
        "Disabled hooks directory must remain outside the worktree and repository.",
      );
    }
    const root = await this.gitText(request.worktree.path, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (!sameHostPath(root, request.worktree.path)) {
      throw new ProductionAdapterErrorV1(
        "git_boundary_mismatch",
        "Git resolved a different worktree root than the trusted workspace binding.",
      );
    }
    const branch = await this.gitText(request.worktree.path, [
      "branch",
      "--show-current",
    ]);
    if (branch !== request.worktree.branch) {
      throw new ProductionAdapterErrorV1(
        "git_branch_mismatch",
        "The worktree is no longer on its trusted agent-owned branch.",
      );
    }
  }

  private async assertDiffArtifactHashes(input: {
    request: NormalizedCodeRepairRequestV1;
    files: CodeDiffFileV1[];
    expectedArtifacts: ArtifactHashReadbackV1[];
    afterSource: ArtifactHashSourceV1;
  }): Promise<void> {
    for (const file of input.files) {
      if (file.beforeSha256) {
        const beforePath = file.status === "renamed" ? file.previousPath : file.path;
        const before = await this.requiredArtifactHash(input.request, beforePath!, {
          kind: "git_revision",
          revision: input.request.worktree.baseSha,
        });
        if (before.sha256 !== file.beforeSha256) {
          throw new ProductionAdapterErrorV1(
            "commit_base_hash_drift",
            `Base artifact hash changed for ${beforePath}.`,
          );
        }
      }
    }
    await this.assertAfterArtifactHashes(
      input.request,
      input.files,
      input.expectedArtifacts,
      input.afterSource,
    );
  }

  private async assertAfterArtifactHashes(
    request: NormalizedCodeRepairRequestV1,
    files: CodeDiffFileV1[],
    expectedArtifacts: ArtifactHashReadbackV1[],
    source: ArtifactHashSourceV1,
  ): Promise<void> {
    const expected = new Map(expectedArtifacts.map((artifact) => [artifact.path, artifact]));
    for (const file of files) {
      if (!file.afterSha256) continue;
      const actual = await this.requiredArtifactHash(request, file.path, source);
      const accepted = expected.get(file.path);
      if (
        !accepted ||
        actual.sha256 !== file.afterSha256 ||
        actual.sha256 !== accepted.sha256 ||
        actual.bytes !== accepted.bytes
      ) {
        throw new ProductionAdapterErrorV1(
          "commit_artifact_hash_drift",
          `Artifact hash or byte count changed for ${file.path}.`,
        );
      }
    }
  }

  private async requiredArtifactHash(
    request: NormalizedCodeRepairRequestV1,
    path: string,
    source: ArtifactHashSourceV1,
  ): Promise<ArtifactHashReadbackV1> {
    const safePath = safeGitPath(path);
    const artifact = await this.options.artifactHashReader.readArtifactHash({
      worktreePath: request.worktree.path,
      path: safePath,
      source,
    });
    if (!artifact) {
      throw new ProductionAdapterErrorV1(
        "commit_artifact_missing",
        `Required artifact ${safePath} is missing from ${source.kind}.`,
      );
    }
    const normalized = normalizeArtifact(artifact);
    if (normalized.path !== safePath) {
      throw new ProductionAdapterErrorV1(
        "commit_artifact_identity",
        "Artifact hash reader returned a different path than requested.",
      );
    }
    return normalized;
  }

  private async allowedPaths(
    request: NormalizedCodeRepairRequestV1,
  ): Promise<Set<string>> {
    const resolved = await this.options.resolveAllowedPaths(request);
    if (!Array.isArray(resolved) || resolved.length < 1 || resolved.length > 200) {
      throw new ProductionAdapterErrorV1(
        "commit_allowed_paths",
        "Trusted workspace binding must resolve one through 200 exact allowed paths.",
      );
    }
    return new Set(resolved.map(safeGitPath));
  }

  private gitText(
    cwd: string,
    args: readonly string[],
    allowEmpty = false,
  ): Promise<string> {
    return this.git(cwd, args, [0]).then((result) => {
      const output = result.stdout.replace(/(?:\r?\n)+$/u, "");
      if (!allowEmpty && !output) {
        throw new ProductionAdapterErrorV1(
          "git_empty_output",
          `Git ${args[0] ?? "command"} returned no output.`,
        );
      }
      return output;
    });
  }

  private async gitOk(cwd: string, args: readonly string[]): Promise<void> {
    await this.git(cwd, args, [0]);
  }

  private async git(
    cwd: string,
    commandArgs: readonly string[],
    allowedExitCodes: readonly number[],
  ): Promise<FixedArgvGitResultV1> {
    for (const argument of commandArgs) boundedArg(argument, "Git argument", 16_384);
    const args = [
      "-c",
      `core.hooksPath=${this.disabledHooksPath}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgSign=false",
      "--literal-pathspecs",
      ...commandArgs,
    ] as const;
    const result = await this.options.git.run({
      cwd,
      args,
      signal: this.options.signal,
    });
    if (
      !result ||
      !Number.isSafeInteger(result.exitCode) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string"
    ) {
      throw new ProductionAdapterErrorV1(
        "git_result_invalid",
        "Fixed-argv Git runner returned an invalid result.",
      );
    }
    if (
      result.stdout.length > MAX_GIT_OUTPUT_CHARACTERS ||
      result.stderr.length > MAX_GIT_OUTPUT_CHARACTERS
    ) {
      throw new ProductionAdapterErrorV1(
        "git_output_limit",
        "Git output exceeded the bounded adapter limit.",
      );
    }
    if (!allowedExitCodes.includes(result.exitCode)) {
      throw new ProductionAdapterErrorV1(
        "git_command_failed",
        `Git ${commandArgs[0] ?? "command"} failed (${result.exitCode}): ${result.stderr
          .trim()
          .slice(0, 1_000)}`,
      );
    }
    return result;
  }

  private timestamp(): string {
    return boundedArg(this.now(), "timestamp", 128);
  }
}

export class ProductionAdapterErrorV1 extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProductionAdapterErrorV1";
  }
}

interface GitChangedPathV1 {
  path: string;
  status: CodeDiffFileV1["status"];
  previousPath: string | null;
}

async function normalizeCheckpointNamespace(
  input: CodeRepairCheckpointNamespaceV1 | null | undefined,
): Promise<CodeRepairCheckpointNamespaceV1> {
  if (input === null || input === undefined) {
    return { version: CHECKPOINT_NAMESPACE_VERSION, revision: 0, checkpoints: {} };
  }
  if (!isPlainObject(input) || input.version !== CHECKPOINT_NAMESPACE_VERSION) {
    throw new ProductionAdapterErrorV1(
      "checkpoint_namespace_invalid",
      "Repair checkpoint namespace has an unsupported shape or version.",
    );
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new ProductionAdapterErrorV1(
      "checkpoint_namespace_invalid",
      "Repair checkpoint namespace revision is invalid.",
    );
  }
  if (!isPlainObject(input.checkpoints)) {
    throw new ProductionAdapterErrorV1(
      "checkpoint_namespace_invalid",
      "Repair checkpoint namespace records are invalid.",
    );
  }
  const entries = Object.entries(input.checkpoints);
  if (entries.length > MAX_CHECKPOINTS) {
    throw new ProductionAdapterErrorV1(
      "checkpoint_capacity",
      `Repair checkpoint namespace exceeds ${MAX_CHECKPOINTS} records.`,
    );
  }
  const checkpoints: Record<string, CodeRepairCheckpointV1> = {};
  for (const [id, checkpoint] of entries) {
    const normalized = await parseCodeRepairCheckpointV1(checkpoint);
    if (normalized.id !== id) {
      throw new ProductionAdapterErrorV1(
        "checkpoint_identity_mismatch",
        "Repair checkpoint key does not match the checkpoint identity.",
      );
    }
    checkpoints[id] = normalized;
  }
  return { version: CHECKPOINT_NAMESPACE_VERSION, revision: input.revision, checkpoints };
}

async function validatePreparedDiff(
  request: NormalizedCodeRepairRequestV1,
  input: CodeDiffReceiptV1,
): Promise<CodeDiffReceiptV1> {
  if (
    !isPlainObject(input) ||
    input.baseSha !== request.worktree.baseSha ||
    !GIT_SHA.test(input.baseSha) ||
    !Array.isArray(input.files) ||
    input.files.length < 1 ||
    input.files.length > MAX_CHANGED_FILES
  ) {
    throw new ProductionAdapterErrorV1(
      "commit_diff_invalid",
      "Prepared diff is absent, oversized, or bound to a different base.",
    );
  }
  const patch = canonicalGitPatch(input.patch);
  if (patch !== input.patch || !patch) {
    throw new ProductionAdapterErrorV1(
      "commit_patch_not_canonical",
      "Prepared diff patch is not in canonical Git LF form.",
    );
  }
  const files = input.files.map(normalizeDiffFile).sort(comparePath);
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new ProductionAdapterErrorV1(
      "commit_diff_invalid",
      "Prepared diff repeats a changed path.",
    );
  }
  const changedPaths = files.map((file) => file.path);
  if (!sameStrings(changedPaths, input.changedPaths)) {
    throw new ProductionAdapterErrorV1(
      "commit_diff_invalid",
      "Prepared diff changedPaths disagree with its file evidence.",
    );
  }
  const fingerprint = await diffFingerprint({ baseSha: input.baseSha, patch, files });
  if (fingerprint !== input.fingerprint) {
    throw new ProductionAdapterErrorV1(
      "commit_diff_fingerprint",
      "Prepared diff fingerprint does not match its canonical evidence.",
    );
  }
  return { ...cloneJson(input), patch, files, changedPaths, fingerprint };
}

function normalizeDiffFile(input: CodeDiffFileV1): CodeDiffFileV1 {
  if (!isPlainObject(input)) {
    throw new ProductionAdapterErrorV1("commit_diff_invalid", "Diff file evidence is invalid.");
  }
  const path = safeGitPath(input.path);
  const previousPath = input.previousPath === null ? null : safeGitPath(input.previousPath);
  const beforeSha256 = input.beforeSha256 === null ? null : assertSha256(input.beforeSha256);
  const afterSha256 = input.afterSha256 === null ? null : assertSha256(input.afterSha256);
  if (!(["added", "modified", "deleted", "renamed"] as const).includes(input.status)) {
    throw new ProductionAdapterErrorV1("commit_diff_invalid", `Invalid status for ${path}.`);
  }
  if (input.status === "added" && (beforeSha256 !== null || afterSha256 === null)) {
    throw new ProductionAdapterErrorV1("commit_diff_invalid", `Invalid added-file hashes for ${path}.`);
  }
  if (input.status === "deleted" && (beforeSha256 === null || afterSha256 !== null)) {
    throw new ProductionAdapterErrorV1("commit_diff_invalid", `Invalid deleted-file hashes for ${path}.`);
  }
  if (input.status === "modified" && (beforeSha256 === null || afterSha256 === null)) {
    throw new ProductionAdapterErrorV1("commit_diff_invalid", `Invalid modified-file hashes for ${path}.`);
  }
  if (
    input.status === "renamed" &&
    (previousPath === null || beforeSha256 === null || afterSha256 === null)
  ) {
    throw new ProductionAdapterErrorV1("commit_diff_invalid", `Invalid rename evidence for ${path}.`);
  }
  if (input.status !== "renamed" && previousPath !== null) {
    throw new ProductionAdapterErrorV1("commit_diff_invalid", `Unexpected previous path for ${path}.`);
  }
  return { path, status: input.status, previousPath, beforeSha256, afterSha256 };
}

function parsePorcelainStatus(output: string): GitChangedPathV1[] {
  if (!output) return [];
  const tokens = nulTokens(output);
  const entries: GitChangedPathV1[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4 || token[2] !== " ") {
      throw new ProductionAdapterErrorV1(
        "git_status_parse",
        "Git porcelain status returned an unsupported record.",
      );
    }
    const code = token.slice(0, 2);
    const path = safeGitPath(token.slice(3));
    if (/[U!]/u.test(code) || code === "AA" || code === "DD" || /C/u.test(code)) {
      throw new ProductionAdapterErrorV1(
        "git_status_unsupported",
        `Git status ${code} for ${path} cannot be committed automatically.`,
      );
    }
    if (/R/u.test(code)) {
      const previous = tokens[++index];
      if (!previous) {
        throw new ProductionAdapterErrorV1("git_status_parse", "Git rename record is truncated.");
      }
      entries.push({ path, status: "renamed", previousPath: safeGitPath(previous) });
      continue;
    }
    if (code.includes("A") && code.includes("D")) {
      throw new ProductionAdapterErrorV1(
        "git_status_unsupported",
        `Conflicting add/delete status for ${path}.`,
      );
    }
    const status: GitChangedPathV1["status"] =
      code === "??" || code.includes("A")
        ? "added"
        : code.includes("D")
          ? "deleted"
          : code.includes("M") || code.includes("T")
            ? "modified"
            : invalidStatus(code, path);
    entries.push({ path, status, previousPath: null });
  }
  return entries.sort(comparePath);
}

function parseNameStatus(output: string): GitChangedPathV1[] {
  const tokens = nulTokens(output);
  const entries: GitChangedPathV1[] = [];
  for (let index = 0; index < tokens.length; ) {
    let statusToken = tokens[index++];
    let inlinePath: string | null = null;
    const tab = statusToken.indexOf("\t");
    if (tab >= 0) {
      inlinePath = statusToken.slice(tab + 1);
      statusToken = statusToken.slice(0, tab);
    }
    const code = statusToken[0];
    if (!code || code === "C" || code === "U") {
      throw new ProductionAdapterErrorV1(
        "git_diff_parse",
        `Git name-status returned unsupported status ${statusToken}.`,
      );
    }
    if (code === "R") {
      const previous = inlinePath ?? tokens[index++];
      const path = tokens[index++];
      if (!previous || !path) {
        throw new ProductionAdapterErrorV1("git_diff_parse", "Git rename record is truncated.");
      }
      entries.push({
        path: safeGitPath(path),
        status: "renamed",
        previousPath: safeGitPath(previous),
      });
      continue;
    }
    const path = inlinePath ?? tokens[index++];
    if (!path) throw new ProductionAdapterErrorV1("git_diff_parse", "Git diff path is missing.");
    const status =
      code === "A"
        ? "added"
        : code === "D"
          ? "deleted"
          : code === "M" || code === "T"
            ? "modified"
            : invalidStatus(statusToken, path);
    entries.push({ path: safeGitPath(path), status, previousPath: null });
  }
  return entries.sort(comparePath);
}

function assertWorkingStatusMatchesDiff(
  status: GitChangedPathV1[],
  files: CodeDiffFileV1[],
): void {
  const actual = new Set(
    status.flatMap((entry) =>
      entry.status === "renamed"
        ? [`renamed:${entry.path}:${entry.previousPath}`]
        : [`${entry.status}:${entry.path}`],
    ),
  );
  const expected = new Set<string>();
  for (const file of files) {
    if (file.status === "renamed") {
      const rename = `renamed:${file.path}:${file.previousPath}`;
      const splitRename = actual.has(`deleted:${file.previousPath}`) && actual.has(`added:${file.path}`);
      if (actual.has(rename)) expected.add(rename);
      else if (splitRename) {
        expected.add(`deleted:${file.previousPath}`);
        expected.add(`added:${file.path}`);
      } else expected.add(rename);
    } else {
      expected.add(`${file.status}:${file.path}`);
    }
  }
  if (!sameStrings([...actual], [...expected])) {
    throw new ProductionAdapterErrorV1(
      "commit_status_drift",
      "Git status no longer matches the exact prepared diff footprint.",
    );
  }
}

function assertDiffShapeEqual(files: CodeDiffFileV1[], actual: GitChangedPathV1[]): void {
  const expected = files.map(({ path, status, previousPath }) => ({ path, status, previousPath }));
  if (!sameJson(expected.sort(comparePath), actual.sort(comparePath))) {
    throw new ProductionAdapterErrorV1(
      "commit_diff_shape",
      "Staged Git paths or statuses differ from the exact prepared diff.",
    );
  }
}

async function assertGreenValidationPair(
  targeted: CodeValidationReceiptV1,
  full: CodeValidationReceiptV1,
): Promise<void> {
  if (
    targeted.kind !== "targeted" ||
    targeted.status !== "passed" ||
    full.kind !== "full" ||
    full.status !== "passed" ||
    targeted.failureFingerprint !== null ||
    full.failureFingerprint !== null ||
    !Array.isArray(targeted.checks) ||
    targeted.checks.length < 1 ||
    targeted.checks.some((check) => check.exitCode !== 0) ||
    !Array.isArray(full.checks) ||
    full.checks.length < 1 ||
    full.checks.some((check) => check.exitCode !== 0) ||
    !full.freshSandbox ||
    full.sandboxId === targeted.sandboxId
  ) {
    throw new ProductionAdapterErrorV1(
      "commit_validation_proof",
      "Commit requires green targeted validation and green full validation from a distinct fresh sandbox.",
    );
  }
  assertSha256(targeted.fingerprint);
  assertSha256(full.fingerprint);
  for (const receipt of [targeted, full]) {
    const fingerprint = await sha256Fingerprint({
      operationId: receipt.operationId,
      kind: receipt.kind,
      sandboxId: receipt.sandboxId,
      freshSandbox: receipt.freshSandbox,
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
      checks: receipt.checks,
      status: receipt.status,
      failureFingerprint: receipt.failureFingerprint,
      binding: receipt.binding,
    });
    if (fingerprint !== receipt.fingerprint) {
      throw new ProductionAdapterErrorV1(
        "commit_validation_proof",
        `Validation receipt ${receipt.id} failed fingerprint verification.`,
      );
    }
  }
}

function assertValidationCoversDiff(
  request: NormalizedCodeRepairRequestV1,
  diff: CodeDiffReceiptV1,
  targeted: CodeValidationReceiptV1,
  full: CodeValidationReceiptV1,
): void {
  for (const receipt of [targeted, full]) {
    const binding = receipt.binding;
    if (
      !binding ||
      binding.requestId !== request.id ||
      binding.workspaceId !== request.worktree.id ||
      binding.profileKey !== request.worktree.profileId
    ) {
      throw new ProductionAdapterErrorV1(
        "commit_validation_binding",
        "Commit validation receipt lacks the exact request, workspace, and profile binding.",
      );
    }
    const covered = new Map(
      [...binding.stagedFiles, ...binding.importedArtifacts]
        .map((entry) => [entry.path, entry.sha256]),
    );
    for (const file of diff.files) {
      if (
        !binding.workspaceChangedPaths.includes(file.path) ||
        (file.afterSha256 !== null && covered.get(file.path) !== file.afterSha256)
      ) {
        throw new ProductionAdapterErrorV1(
          "commit_validation_binding",
          `Commit validation does not cover final diff bytes for ${file.path}.`,
        );
      }
    }
  }
  if (
    targeted.binding!.validatedWorkspaceManifestFingerprint !==
      full.binding!.validatedWorkspaceManifestFingerprint ||
    targeted.binding!.stagingManifestFingerprint !==
      full.binding!.stagingManifestFingerprint
  ) {
    throw new ProductionAdapterErrorV1(
      "commit_validation_binding",
      "Targeted and full validation do not bind the same final workspace and staging manifest.",
    );
  }
}

function assertRequestBinding(request: NormalizedCodeRepairRequestV1): void {
  if (!isPlainObject(request) || !isPlainObject(request.worktree)) {
    throw new ProductionAdapterErrorV1("commit_request_invalid", "Commit request is invalid.");
  }
  boundedIdentifier(request.id, "request id", 128);
  boundedIdentifier(request.runId, "run id", 128);
  boundedIdentifier(request.worktree.id, "workspace id", 128);
  boundedArg(request.worktree.path, "worktree path", 2_048);
  boundedArg(request.worktree.branch, "worktree branch", 512);
  assertGitSha(request.worktree.baseSha, "worktree base SHA");
}

function assertArtifactsDescribeDiff(
  files: CodeDiffFileV1[],
  artifacts: ArtifactHashReadbackV1[],
): void {
  const expected = files
    .filter((file) => file.afterSha256 !== null)
    .map((file) => `${file.path}:${file.afterSha256}`)
    .sort();
  const actual = artifacts.map((artifact) => `${artifact.path}:${artifact.sha256}`).sort();
  if (!sameStrings(expected, actual)) {
    throw new ProductionAdapterErrorV1(
      "commit_artifact_evidence",
      "Artifact readback does not cover every non-deleted diff path exactly.",
    );
  }
}

function compareCommittedEvidence(input: {
  readback: CodeCommitReadbackV1;
  request: NormalizedCodeRepairRequestV1;
  diff: CodeDiffReceiptV1;
  artifacts: ArtifactHashReadbackV1[];
}): string | null {
  if (input.readback.parentSha !== input.request.worktree.baseSha) return "parent SHA mismatch";
  if (input.readback.diffFingerprint !== input.diff.fingerprint) return "diff fingerprint mismatch";
  if (!sameStrings(input.readback.changedPaths, input.diff.changedPaths)) return "changed paths mismatch";
  if (!sameJson(normalizeArtifacts(input.readback.artifactHashes), input.artifacts)) {
    return "artifact hash readback mismatch";
  }
  return null;
}

function canonicalDiffArgs(input: {
  cached?: boolean;
  base: string;
  target?: string;
}): string[] {
  return [
    "diff",
    ...(input.cached ? ["--cached"] : []),
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-color",
    "--find-renames=50%",
    input.base,
    ...(input.target ? [input.target] : []),
    "--",
  ];
}

function canonicalGitPatch(input: string): string {
  if (typeof input !== "string" || input.includes("\u0000")) {
    throw new ProductionAdapterErrorV1("commit_patch_invalid", "Git patch is invalid.");
  }
  const lf = input.replace(/\r\n?/gu, "\n");
  if (!lf) return "";
  return `${lf.replace(/\n+$/u, "")}\n`;
}

function normalizeArtifacts(input: ArtifactHashReadbackV1[]): ArtifactHashReadbackV1[] {
  if (!Array.isArray(input) || input.length > MAX_CHANGED_FILES) {
    throw new ProductionAdapterErrorV1("commit_artifact_evidence", "Artifact list is invalid.");
  }
  const artifacts = input.map(normalizeArtifact).sort(comparePath);
  if (artifacts.reduce((total, artifact) => total + artifact.bytes, 0) > MAX_ARTIFACT_BYTES) {
    throw new ProductionAdapterErrorV1(
      "commit_artifact_evidence",
      "Artifact readback exceeds the 10 MiB mission boundary.",
    );
  }
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    throw new ProductionAdapterErrorV1("commit_artifact_evidence", "Artifact paths repeat.");
  }
  return artifacts;
}

function normalizeArtifact(input: ArtifactHashReadbackV1): ArtifactHashReadbackV1 {
  if (
    !isPlainObject(input) ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0 ||
    input.bytes > MAX_ARTIFACT_BYTES
  ) {
    throw new ProductionAdapterErrorV1(
      "commit_artifact_evidence",
      "Artifact byte count is invalid or exceeds the 10 MiB mission boundary.",
    );
  }
  return {
    path: safeGitPath(input.path),
    sha256: assertSha256(input.sha256),
    bytes: input.bytes,
  };
}

async function diffFingerprint(input: {
  baseSha: string;
  patch: string;
  files: CodeDiffFileV1[];
}): Promise<string> {
  return sha256Fingerprint({
    baseSha: input.baseSha,
    patch: input.patch,
    files: input.files.map(normalizeDiffFile).sort(comparePath),
  });
}

function involvedDiffPaths(files: CodeDiffFileV1[]): string[] {
  return [
    ...new Set(
      files.flatMap((file) =>
        file.status === "renamed" && file.previousPath
          ? [file.path, file.previousPath]
          : [file.path],
      ),
    ),
  ].sort();
}

function assertPathsAllowed(paths: string[], allowed: Set<string>): void {
  const rejected = paths.filter((path) => !allowed.has(path));
  if (rejected.length) {
    throw new ProductionAdapterErrorV1(
      "commit_path_not_allowed",
      `Prepared diff contains paths outside the trusted workspace grant: ${rejected.join(", ")}`,
    );
  }
}

function safeGitPath(input: string): string {
  const path = assertSafeRepositoryRelativePath(input);
  if (path !== input) {
    throw new ProductionAdapterErrorV1(
      "commit_path_not_canonical",
      "Git paths must already be canonical repository-relative paths.",
    );
  }
  if (path.split("/")[0].toLowerCase() === ".git") {
    throw new ProductionAdapterErrorV1(
      "commit_git_control_path",
      "Git administrative paths cannot enter a prepared commit.",
    );
  }
  return path;
}

function nulTokens(output: string): string[] {
  if (!output) return [];
  if (!output.endsWith("\u0000")) {
    throw new ProductionAdapterErrorV1("git_parse", "Expected NUL-terminated Git output.");
  }
  return output.split("\u0000").slice(0, -1);
}

function assertGitSha(value: string, label: string): string {
  if (!GIT_SHA.test(value)) {
    throw new ProductionAdapterErrorV1("git_sha_invalid", `${label} is not a full Git SHA.`);
  }
  return value;
}

function assertSha256(value: string): string {
  if (!SHA256.test(value)) {
    throw new ProductionAdapterErrorV1(
      "sha256_invalid",
      "Expected a canonical SHA-256 fingerprint.",
    );
  }
  return value;
}

function boundedIdentifier(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new ProductionAdapterErrorV1(
      "identifier_invalid",
      `${label} is not a bounded durable identifier.`,
    );
  }
  return value;
}

function boundedArg(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\u0000")
  ) {
    throw new ProductionAdapterErrorV1("git_argument_invalid", `${label} is invalid.`);
  }
  return value;
}

function sameHostPath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function isAbsoluteHostPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/u.test(value);
}

function isHostPathWithin(candidate: string, root: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  const child = normalize(candidate);
  const parent = normalize(root);
  return child === parent || child.startsWith(`${parent}/`);
}

function comparePath<T extends { path: string }>(left: T, right: T): number {
  return left.path.localeCompare(right.path);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function invalidStatus(code: string, path: string): never {
  throw new ProductionAdapterErrorV1(
    "git_status_unsupported",
    `Unsupported Git status ${code} for ${path}.`,
  );
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
