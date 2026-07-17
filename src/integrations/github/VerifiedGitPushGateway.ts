import {
  parseVerifiedCodePublicationHandoffV1,
  type VerifiedCodePublicationHandoffV1,
} from "../../../packages/core-api/src/verifiedCodePublicationHandoffV1";
import type { RepositoryProfileV2 } from "../../../extensions/code/repositories/RepositoryProfileV2";
import {
  assertTrustedGitHubBindingMatchesPublicationProofV1,
  assertTrustedGitHubBindingMatchesProfileV1,
  buildTrustedGitHubHttpsRemoteUrlV1,
  type TrustedGitHubRepositoryBindingV1,
  type TrustedGitHubPublicationProfileProofV1,
} from "./TrustedGitHubRepositoryBindingV1";
import { portableSha256Text } from "../../../packages/core-api/src/portableSha256";
import { requireNodeModule } from "../../platform/nodeRequire";

const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface VerifiedGitCommandResultV1 {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Implement with spawn(gitExecutable, args, { shell: false, env, cwd }). */
export interface VerifiedGitCommandRunnerV1 {
  run(input: {
    cwd: string;
    args: readonly string[];
    environment: Readonly<Record<string, string>>;
    inheritEnvironment: false;
    signal?: AbortSignal;
  }): Promise<VerifiedGitCommandResultV1>;
}

export interface EphemeralGitAskpassHandleV1 {
  readonly id: string;
  readonly executablePath: string;
}

/**
 * The broker owns the secret lease and helper lifetime. The callback receives
 * only an opaque handle; plaintext credentials never cross this interface.
 */
export interface EphemeralGitAskpassBrokerV1 {
  withHandle<TResult>(input: {
    credentialReferenceId: string;
    repositoryBindingFingerprint: string;
    signal?: AbortSignal;
    use(handle: EphemeralGitAskpassHandleV1): Promise<TResult>;
  }): Promise<TResult>;
}

export type GitPushAttemptStatusV1 =
  | "dispatching"
  | "reconcile_required"
  | "verified"
  | "not_applied";

export interface GitPushAttemptRecordV1 {
  version: 1;
  id: string;
  revision: number;
  handoffFingerprint: string;
  bindingFingerprint: string;
  branch: string;
  remoteUrl: string;
  beforeRemoteSha: string | null;
  expectedCommitSha: string;
  status: GitPushAttemptStatusV1;
  dispatchCount: 0 | 1;
  reconciliationKey: string;
  startedAt: string;
  updatedAt: string;
  receipt: VerifiedGitPushReceiptV1 | null;
  diagnostic: string | null;
}

/** Durable, serialized compare-and-swap persistence is required in production. */
export interface GitPushAttemptStoreV1 {
  load(id: string): Promise<GitPushAttemptRecordV1 | null>;
  save(record: GitPushAttemptRecordV1, expectedRevision: number | null): Promise<boolean>;
}

export interface VerifiedGitPushReceiptV1 {
  version: 1;
  kind: "verified_git_push";
  id: string;
  status: "verified";
  commitKind: "committed" | "reconciled" | "already_present";
  handoffId: string;
  handoffFingerprint: string;
  repositoryBindingKey: string;
  repositoryBindingFingerprint: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  canonicalWorktreeRoot: string;
  canonicalWorktreeFingerprint: string;
  remoteUrl: string;
  branch: string;
  baseBranch: string;
  beforeRemoteSha: string | null;
  remoteSha: string;
  baseSha: string;
  parentSha: string;
  commitSha: string;
  treeSha: string;
  diffFingerprint: string;
  artifactFingerprint: string;
  localCommitReceiptId: string;
  localCommitReceiptFingerprint: string;
  targetedValidationReceiptId: string;
  fullValidationReceiptId: string;
  targetedValidationFingerprint: string;
  fullValidationFingerprint: string;
  pushedAt: string;
  verifiedAt: string;
  fingerprint: string;
}

export type VerifiedGitPushResultV1 =
  | { status: "pushed_verified"; receipt: VerifiedGitPushReceiptV1 }
  | {
      status: "reconcile_required";
      attemptId: string;
      reconciliationKey: string;
      message: string;
    }
  | {
      status: "not_applied";
      attemptId: string;
      reconciliationKey: string;
      message: string;
    };

export interface VerifiedGitPushGatewayOptionsV1 {
  runner: VerifiedGitCommandRunnerV1;
  askpassBroker: EphemeralGitAskpassBrokerV1;
  attemptStore: GitPushAttemptStoreV1;
  disabledHooksPath: string;
  now?: () => Date;
}

export interface VerifiedGitPushInputV1 {
  handoff: VerifiedCodePublicationHandoffV1;
  binding: TrustedGitHubRepositoryBindingV1;
  profile: RepositoryProfileV2 | TrustedGitHubPublicationProfileProofV1;
  credentialReferenceId: string;
  signal?: AbortSignal;
}

export class VerifiedGitPushErrorV1 extends Error {
  constructor(
    readonly code:
      | "invalid_publication_handoff"
      | "local_commit_drift"
      | "remote_non_fast_forward"
      | "git_command_failed"
      | "attempt_store_conflict",
    message: string,
  ) {
    super(message);
    this.name = "VerifiedGitPushErrorV1";
  }
}

export class VerifiedGitPushGatewayV1 {
  private readonly now: () => Date;
  private readonly disabledHooksPath: string;

  constructor(private readonly options: VerifiedGitPushGatewayOptionsV1) {
    this.now = options.now ?? (() => new Date());
    this.disabledHooksPath = absolutePath(options.disabledHooksPath, "disabled hooks path");
  }

  async push(input: VerifiedGitPushInputV1): Promise<VerifiedGitPushResultV1> {
    const prepared = this.prepare(input);
    const attemptId = attemptIdFor(prepared.handoff, prepared.binding);
    const prior = await this.options.attemptStore.load(attemptId);
    if (prior) return resultFromPrior(prior);

    await this.verifyLocalIdentity(prepared.handoff, input.signal);
    return this.options.askpassBroker.withHandle({
      credentialReferenceId: bounded(input.credentialReferenceId, "credential reference id", 1, 512),
      repositoryBindingFingerprint: prepared.binding.fingerprint,
      signal: input.signal,
      use: async (handle) => {
        const environment = askpassEnvironment(handle);
        const beforeRemoteSha = await this.readRemoteSha(
          prepared.handoff,
          prepared.remoteUrl,
          environment,
          input.signal,
        );
        const beforeBaseSha = await this.readRemoteRefSha(
          prepared.handoff,
          prepared.remoteUrl,
          prepared.handoff.baseBranch,
          environment,
          input.signal,
        );
        if (beforeBaseSha && beforeBaseSha !== prepared.handoff.baseSha) {
          throw new VerifiedGitPushErrorV1(
            "remote_non_fast_forward",
            "Remote base branch does not match the exact verified local base SHA; publication cannot rewrite or force-update it.",
          );
        }
        if (beforeRemoteSha && beforeRemoteSha !== prepared.handoff.commitSha) {
          await this.assertFastForward(
            prepared.handoff,
            prepared.remoteUrl,
            beforeRemoteSha,
            environment,
            input.signal,
          );
        }
        const startedAt = this.now().toISOString();
        const attempt: GitPushAttemptRecordV1 = {
          version: 1,
          id: attemptId,
          revision: 0,
          handoffFingerprint: prepared.handoff.fingerprint,
          bindingFingerprint: prepared.binding.fingerprint,
          branch: prepared.handoff.branch,
          remoteUrl: prepared.remoteUrl,
          beforeRemoteSha,
          expectedCommitSha: prepared.handoff.commitSha,
          status: "dispatching",
          dispatchCount:
            beforeRemoteSha === prepared.handoff.commitSha && beforeBaseSha
              ? 0
              : 1,
          reconciliationKey: `github-ref:${prepared.binding.owner}/${prepared.binding.repository}:refs/heads/${prepared.handoff.branch}`,
          startedAt,
          updatedAt: startedAt,
          receipt: null,
          diagnostic: null,
        };
        if (!(await this.options.attemptStore.save(attempt, null))) {
          const concurrent = await this.options.attemptStore.load(attemptId);
          if (concurrent) return resultFromPrior(concurrent);
          throw new VerifiedGitPushErrorV1("attempt_store_conflict", "Git push attempt could not be claimed durably.");
        }
        if (
          beforeRemoteSha === prepared.handoff.commitSha &&
          beforeBaseSha === prepared.handoff.baseSha
        ) {
          return this.completeVerified(
            attempt,
            prepared,
            "already_present",
            startedAt,
          );
        }
        let pushResult: VerifiedGitCommandResultV1;
        try {
          const refspecs = [
            ...(beforeBaseSha
              ? []
              : [
                  `${prepared.handoff.baseSha}:refs/heads/${prepared.handoff.baseBranch}`,
                ]),
            ...(beforeRemoteSha === prepared.handoff.commitSha
              ? []
              : [
                  `${prepared.handoff.commitSha}:refs/heads/${prepared.handoff.branch}`,
                ]),
          ];
          pushResult = await this.runGit(
            prepared.handoff.canonicalWorktreeRoot,
            [
              "push",
              "--atomic",
              "--porcelain",
              "--no-verify",
              prepared.remoteUrl,
              ...refspecs,
            ],
            environment,
            input.signal,
          );
        } catch (error) {
          return this.markReconcileRequired(attempt, safeDiagnostic(error));
        }
        if (pushResult.exitCode !== 0) {
          return this.markReconcileRequired(attempt, safeGitDiagnostic(pushResult));
        }
        let observed: string | null;
        try {
          observed = await this.readRemoteSha(
            prepared.handoff,
            prepared.remoteUrl,
            environment,
            input.signal,
          );
        } catch (error) {
          return this.markReconcileRequired(attempt, safeDiagnostic(error));
        }
        if (observed !== prepared.handoff.commitSha) {
          return this.markReconcileRequired(
            attempt,
            "Remote branch readback did not match the expected verified commit.",
          );
        }
        const observedBase = await this.readRemoteRefSha(
          prepared.handoff,
          prepared.remoteUrl,
          prepared.handoff.baseBranch,
          environment,
          input.signal,
        );
        if (observedBase !== prepared.handoff.baseSha) {
          return this.markReconcileRequired(
            attempt,
            "Remote base branch readback did not match the exact verified local base SHA.",
          );
        }
        return this.completeVerified(
          attempt,
          prepared,
          "committed",
          this.now().toISOString(),
        );
      },
    });
  }

  /** Readback-only reconciliation. It never dispatches another push. */
  async reconcile(input: VerifiedGitPushInputV1): Promise<VerifiedGitPushResultV1> {
    const prepared = this.prepare(input);
    const attemptId = attemptIdFor(prepared.handoff, prepared.binding);
    const attempt = await this.options.attemptStore.load(attemptId);
    if (!attempt) {
      throw new VerifiedGitPushErrorV1("attempt_store_conflict", "No durable Git push attempt exists to reconcile.");
    }
    if (attempt.status === "verified" || attempt.status === "not_applied") {
      return resultFromPrior(attempt);
    }
    await this.verifyLocalIdentity(prepared.handoff, input.signal);
    return this.options.askpassBroker.withHandle({
      credentialReferenceId: bounded(input.credentialReferenceId, "credential reference id", 1, 512),
      repositoryBindingFingerprint: prepared.binding.fingerprint,
      signal: input.signal,
      use: async (handle) => {
        let observed: string | null;
        try {
          observed = await this.readRemoteSha(
            prepared.handoff,
            prepared.remoteUrl,
            askpassEnvironment(handle),
            input.signal,
          );
        } catch (error) {
          return this.markReconcileRequired(attempt, safeDiagnostic(error));
        }
        if (observed === prepared.handoff.commitSha) {
          const observedBase = await this.readRemoteRefSha(
            prepared.handoff,
            prepared.remoteUrl,
            prepared.handoff.baseBranch,
            askpassEnvironment(handle),
            input.signal,
          );
          if (observedBase !== prepared.handoff.baseSha) {
            return this.markReconcileRequired(
              attempt,
              "Remote feature branch is present, but the exact verified base branch readback is missing or drifted.",
            );
          }
          return this.completeVerified(
            attempt,
            prepared,
            "reconciled",
            this.now().toISOString(),
          );
        }
        if (observed === attempt.beforeRemoteSha) {
          const next: GitPushAttemptRecordV1 = {
            ...attempt,
            revision: attempt.revision + 1,
            status: "not_applied",
            updatedAt: this.now().toISOString(),
            diagnostic: "Remote readback proves the prepared push was not applied.",
          };
          await this.saveReplacement(attempt, next);
          return resultFromPrior(next);
        }
        return this.markReconcileRequired(
          attempt,
          "Remote branch moved to an unexpected commit; manual reconciliation is required.",
        );
      },
    });
  }

  private prepare(input: VerifiedGitPushInputV1): {
    handoff: VerifiedCodePublicationHandoffV1;
    binding: TrustedGitHubRepositoryBindingV1;
    remoteUrl: string;
  } {
    let handoff: VerifiedCodePublicationHandoffV1;
    let binding: TrustedGitHubRepositoryBindingV1;
    try {
      handoff = parseVerifiedCodePublicationHandoffV1(input.handoff);
      ({ binding } = isRepositoryProfileV2(input.profile)
        ? assertTrustedGitHubBindingMatchesProfileV1(input.binding, input.profile)
        : assertTrustedGitHubBindingMatchesPublicationProofV1(input.binding, input.profile));
    } catch (error) {
      throw new VerifiedGitPushErrorV1("invalid_publication_handoff", safeDiagnostic(error));
    }
    if (
      handoff.repositoryProfileKey !== binding.repositoryProfileKey ||
      handoff.repositoryProfileFingerprint !== binding.repositoryProfileFingerprint ||
      handoff.baseBranch !== binding.defaultBranch ||
      !handoff.branch.startsWith(binding.agentBranchPrefix)
    ) {
      throw new VerifiedGitPushErrorV1(
        "invalid_publication_handoff",
        "Verified code handoff does not match the trusted GitHub repository binding.",
      );
    }
    return { handoff, binding, remoteUrl: buildTrustedGitHubHttpsRemoteUrlV1(binding) };
  }

  private async verifyLocalIdentity(
    handoff: VerifiedCodePublicationHandoffV1,
    signal?: AbortSignal,
  ): Promise<void> {
    const environment = nonInteractiveEnvironment();
    const cwd = handoff.canonicalWorktreeRoot;
    const root = await this.gitText(cwd, ["rev-parse", "--show-toplevel"], environment, signal);
    const branch = await this.gitText(cwd, ["branch", "--show-current"], environment, signal);
    const head = await this.gitText(cwd, ["rev-parse", "HEAD"], environment, signal);
    const tree = await this.gitText(cwd, ["rev-parse", "HEAD^{tree}"], environment, signal);
    const parent = await this.gitText(cwd, ["rev-parse", "HEAD^"], environment, signal);
    if (
      !sameHostPath(root, cwd) ||
      branch !== handoff.branch ||
      head !== handoff.commitSha ||
      tree !== handoff.treeSha ||
      parent !== handoff.baseSha ||
      parent !== handoff.parentSha
    ) {
      throw new VerifiedGitPushErrorV1(
        "local_commit_drift",
        "Canonical worktree, branch, commit, tree, or parent drifted after local verification.",
      );
    }
  }

  private async assertFastForward(
    handoff: VerifiedCodePublicationHandoffV1,
    remoteUrl: string,
    beforeRemoteSha: string,
    environment: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const fetch = await this.runGit(
      handoff.canonicalWorktreeRoot,
      ["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", remoteUrl, `refs/heads/${handoff.branch}`],
      environment,
      signal,
    );
    if (fetch.exitCode !== 0) {
      throw new VerifiedGitPushErrorV1("git_command_failed", safeGitDiagnostic(fetch));
    }
    const ancestor = await this.runGit(
      handoff.canonicalWorktreeRoot,
      ["merge-base", "--is-ancestor", beforeRemoteSha, handoff.commitSha],
      nonInteractiveEnvironment(),
      signal,
    );
    if (ancestor.exitCode === 1) {
      throw new VerifiedGitPushErrorV1(
        "remote_non_fast_forward",
        "Agent-owned remote branch is not an ancestor of the verified local commit; force-push is forbidden.",
      );
    }
    if (ancestor.exitCode !== 0) {
      throw new VerifiedGitPushErrorV1("git_command_failed", safeGitDiagnostic(ancestor));
    }
  }

  private async readRemoteSha(
    handoff: VerifiedCodePublicationHandoffV1,
    remoteUrl: string,
    environment: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return this.readRemoteRefSha(
      handoff,
      remoteUrl,
      handoff.branch,
      environment,
      signal,
    );
  }

  private async readRemoteRefSha(
    handoff: VerifiedCodePublicationHandoffV1,
    remoteUrl: string,
    branch: string,
    environment: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const ref = `refs/heads/${branch}`;
    const result = await this.runGit(
      handoff.canonicalWorktreeRoot,
      ["ls-remote", "--heads", remoteUrl, ref],
      environment,
      signal,
    );
    if (result.exitCode !== 0) throw new VerifiedGitPushErrorV1("git_command_failed", safeGitDiagnostic(result));
    const output = result.stdout.trim();
    if (!output) return null;
    const lines = output.split(/\r?\n/u);
    if (lines.length !== 1) throw new VerifiedGitPushErrorV1("git_command_failed", "Remote ref readback was ambiguous.");
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\s+(.+)$/u.exec(lines[0]);
    if (!match || match[2] !== ref) throw new VerifiedGitPushErrorV1("git_command_failed", "Remote ref readback was invalid.");
    return match[1];
  }

  private runGit(
    cwd: string,
    operationArgs: readonly string[],
    environment: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<VerifiedGitCommandResultV1> {
    const args = [
      "-c", "credential.helper=",
      "-c", `core.hooksPath=${this.disabledHooksPath}`,
      "-c", "credential.useHttpPath=true",
      ...operationArgs,
    ];
    if (args.some((arg) => arg === "--force" || arg === "-f" || arg.startsWith("--force-"))) {
      throw new VerifiedGitPushErrorV1("git_command_failed", "Force-push arguments are forbidden.");
    }
    return this.options.runner.run({
      cwd,
      args,
      environment,
      inheritEnvironment: false,
      ...(signal ? { signal } : {}),
    });
  }

  private async gitText(
    cwd: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.runGit(cwd, args, environment, signal);
    if (result.exitCode !== 0) throw new VerifiedGitPushErrorV1("git_command_failed", safeGitDiagnostic(result));
    const text = result.stdout.trim();
    if (!text || text.length > 4096 || /[\0\r\n]/u.test(text)) {
      throw new VerifiedGitPushErrorV1("git_command_failed", "Git identity readback was invalid.");
    }
    return text;
  }

  private async completeVerified(
    attempt: GitPushAttemptRecordV1,
    prepared: ReturnType<VerifiedGitPushGatewayV1["prepare"]>,
    commitKind: VerifiedGitPushReceiptV1["commitKind"],
    pushedAt: string,
  ): Promise<VerifiedGitPushResultV1> {
    const verifiedAt = this.now().toISOString();
    const evidence: Omit<VerifiedGitPushReceiptV1, "fingerprint"> = {
      version: 1,
      kind: "verified_git_push",
      id: `github-push-${prepared.handoff.fingerprint.slice("sha256:".length, "sha256:".length + 32)}`,
      status: "verified",
      commitKind,
      handoffId: prepared.handoff.id,
      handoffFingerprint: prepared.handoff.fingerprint,
      repositoryBindingKey: prepared.binding.key,
      repositoryBindingFingerprint: prepared.binding.fingerprint,
      repositoryProfileKey: prepared.handoff.repositoryProfileKey,
      repositoryProfileFingerprint: prepared.handoff.repositoryProfileFingerprint,
      canonicalWorktreeRoot: prepared.handoff.canonicalWorktreeRoot,
      canonicalWorktreeFingerprint: prepared.handoff.canonicalWorktreeFingerprint,
      remoteUrl: prepared.remoteUrl,
      branch: prepared.handoff.branch,
      baseBranch: prepared.handoff.baseBranch,
      beforeRemoteSha: attempt.beforeRemoteSha,
      remoteSha: prepared.handoff.commitSha,
      baseSha: prepared.handoff.baseSha,
      parentSha: prepared.handoff.parentSha,
      commitSha: prepared.handoff.commitSha,
      treeSha: prepared.handoff.treeSha,
      diffFingerprint: prepared.handoff.diffFingerprint,
      artifactFingerprint: prepared.handoff.artifactFingerprint,
      localCommitReceiptId: prepared.handoff.localCommitReceiptId,
      localCommitReceiptFingerprint: prepared.handoff.localCommitReceiptFingerprint,
      targetedValidationReceiptId: prepared.handoff.targetedValidationReceiptId,
      fullValidationReceiptId: prepared.handoff.fullValidationReceiptId,
      targetedValidationFingerprint: prepared.handoff.targetedValidationFingerprint,
      fullValidationFingerprint: prepared.handoff.fullValidationFingerprint,
      pushedAt,
      verifiedAt,
    };
    const receipt: VerifiedGitPushReceiptV1 = { ...evidence, fingerprint: sha256(evidence) };
    const next: GitPushAttemptRecordV1 = {
      ...attempt,
      revision: attempt.revision + 1,
      status: "verified",
      updatedAt: verifiedAt,
      receipt,
      diagnostic: null,
    };
    await this.saveReplacement(attempt, next);
    return { status: "pushed_verified", receipt };
  }

  private async markReconcileRequired(
    attempt: GitPushAttemptRecordV1,
    diagnostic: string,
  ): Promise<VerifiedGitPushResultV1> {
    const next: GitPushAttemptRecordV1 = {
      ...attempt,
      revision: attempt.revision + 1,
      status: "reconcile_required",
      updatedAt: this.now().toISOString(),
      diagnostic,
    };
    await this.saveReplacement(attempt, next);
    return resultFromPrior(next);
  }

  private async saveReplacement(
    prior: GitPushAttemptRecordV1,
    next: GitPushAttemptRecordV1,
  ): Promise<void> {
    if (!(await this.options.attemptStore.save(next, prior.revision))) {
      throw new VerifiedGitPushErrorV1("attempt_store_conflict", "Git push attempt changed concurrently.");
    }
  }
}

function isRepositoryProfileV2(
  value: RepositoryProfileV2 | TrustedGitHubPublicationProfileProofV1,
): value is RepositoryProfileV2 {
  return "schemaVersion" in value;
}

function resultFromPrior(attempt: GitPushAttemptRecordV1): VerifiedGitPushResultV1 {
  if (attempt.status === "verified" && attempt.receipt) {
    return { status: "pushed_verified", receipt: attempt.receipt };
  }
  if (attempt.status === "not_applied") {
    return {
      status: "not_applied",
      attemptId: attempt.id,
      reconciliationKey: attempt.reconciliationKey,
      message: attempt.diagnostic ?? "Remote readback proved the push was not applied; a new approved attempt is required.",
    };
  }
  return {
    status: "reconcile_required",
    attemptId: attempt.id,
    reconciliationKey: attempt.reconciliationKey,
    message: attempt.status === "dispatching"
      ? "A durable push attempt was interrupted; reconcile by remote readback before any new dispatch."
      : attempt.diagnostic ?? "Git push outcome is ambiguous and requires remote readback.",
  };
}

function attemptIdFor(
  handoff: VerifiedCodePublicationHandoffV1,
  binding: TrustedGitHubRepositoryBindingV1,
): string {
  return `git-push-${sha256({ handoff: handoff.fingerprint, binding: binding.fingerprint }).slice("sha256:".length, "sha256:".length + 40)}`;
}

function askpassEnvironment(handle: EphemeralGitAskpassHandleV1): Readonly<Record<string, string>> {
  const executable = absolutePath(handle.executablePath, "askpass executable path");
  const id = bounded(handle.id, "askpass handle id", 1, 512);
  return Object.freeze({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS_REQUIRE: "force",
    GIT_ASKPASS: executable,
    GCM_INTERACTIVE: "Never",
    AGENTIC_RESEARCHER_ASKPASS_HANDLE: id,
  });
}

function nonInteractiveEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  });
}

function sameHostPath(left: string, right: string): boolean {
  const path = nodePath();
  const normalize = (value: string): string => path.resolve(value).replace(/\\/gu, "/").replace(/\/$/u, "");
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function absolutePath(value: unknown, label: string): string {
  const path = nodePath();
  if (typeof value !== "string" || value.length < 1 || value.length > 2048 || /[\0\r\n]/u.test(value) || (!path.isAbsolute(value) && !path.win32.isAbsolute(value))) {
    throw new VerifiedGitPushErrorV1("invalid_publication_handoff", `${label} must be an absolute host path.`);
  }
  return value;
}

function bounded(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\0\r\n]/u.test(value)) {
    throw new VerifiedGitPushErrorV1("invalid_publication_handoff", `${label} is invalid.`);
  }
  return value;
}

function safeGitDiagnostic(result: VerifiedGitCommandResultV1): string {
  return safeDiagnostic(result.stderr || `Git exited with code ${result.exitCode}.`);
}

function safeDiagnostic(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/https:\/\/[^\s/@]+@github\.com/giu, "https://[REDACTED]@github.com")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/(?:token|password|secret|authorization|credential)\s*[=:]\s*\S+/giu, "credential=[REDACTED]")
    .slice(0, 1000);
}

function sha256(value: unknown): string {
  return `sha256:${portableSha256Text(canonicalJson(value))}`;
}

function nodePath(): typeof import("node:path") {
  return requireNodeModule<typeof import("node:path")>(
    "node:path",
    "verified Git publication",
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("Git receipt evidence contains an unsafe number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Git receipt evidence contains an unsupported value.");
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
