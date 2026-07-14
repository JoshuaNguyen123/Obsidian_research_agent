import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SecretStoreV1 } from "../../../packages/core-api/src/secretStoreV1";
import {
  GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
  GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1,
  GITHUB_PULL_REQUEST_MERGE_OPERATION_V1,
  GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1,
  fingerprintBackgroundGitHubValueV1,
  type PreparedBackgroundGitHubActionV1,
} from "../../../packages/core-api/src/preparedBackgroundGitHubActionV1";
import type { ActionReceipt } from "../../../src/agent/actions";
import {
  GitHubApiError,
  GitHubRestClient,
  type GitHubPullRequestRecord,
} from "../../../src/integrations/github/GitHubRestClient";
import {
  GitHubPublicationCheckpointStoreV1,
} from "../../../src/integrations/github/GitHubPublicationCheckpointStore";
import {
  createProofSnapshot,
  GitHubPublicationWorkflowV1,
  type GitHubPublicationCheckpointV1,
  type GitHubPublicationProviderPortV1,
  type GitHubPublicationPullRequestV1,
  type GitHubPublicationPushPortV1,
  type GitHubPublicationPreapprovedApprovalInputV1,
  type TrustedGitHubPublicationBindingV1,
} from "../../../src/integrations/github/GitHubPublicationWorkflow";
import { DurableGitPushAttemptStoreV1 } from "../../../src/integrations/github/GitPushAttemptStore";
import {
  LoopbackEphemeralGitAskpassBrokerV1,
  SpawnVerifiedGitCommandRunnerV1,
} from "../../../src/integrations/github/SecureGitPushRuntime";
import {
  VerifiedGitPushGatewayV1,
  type EphemeralGitAskpassBrokerV1,
  type VerifiedGitCommandRunnerV1,
} from "../../../src/integrations/github/VerifiedGitPushGateway";
import { createPendingExternalActionStateV2 } from "../../../src/integrations/PendingExternalActionStateV2";
import type { HttpTransport } from "../../../src/model/types";
import type {
  BackgroundGitHubAutoMergeEffectResultV1,
  BackgroundGitHubContinuationDependenciesV1,
} from "./BackgroundGitHubContinuationV1";
import type { PreparedBackgroundGitHubPackageV1 } from "./PreparedBackgroundGitHubPackageStoreV1";
import type { PreparedBackgroundGitHubStandaloneExecutorOptionsV1 } from "./PreparedBackgroundGitHubStandaloneExecutorV1";
import { BackgroundGitHubProviderPersistenceV1 } from "./BackgroundGitHubProviderPersistenceV1";
import { createFixedGitHubNodeTransportV1 } from "./FixedGitHubNodeTransportV1";
import { ensureSafeCompanionDirectoryV1, validateCompanionAppDataRootV1 } from "./SafeCompanionAppDataV1";

type RuntimeFactoryV1 = NonNullable<
  PreparedBackgroundGitHubStandaloneExecutorOptionsV1["createRuntimeDependencies"]
>;

export interface BackgroundGitHubProviderFactoryOptionsV1 {
  applicationDataRoot: string;
  secretStore: SecretStoreV1;
  transport?: HttpTransport;
  gitExecutable?: string;
  gitCommandRunner?: VerifiedGitCommandRunnerV1;
  askpassBroker?: EphemeralGitAskpassBrokerV1;
  now?: () => Date;
}

export class BackgroundGitHubProviderBoundaryErrorV1 extends Error {
  constructor(
    readonly code:
      | "secure_store_unavailable"
      | "git_runtime_unavailable"
      | "credential_scope_rejected"
      | "account_drift"
      | "repository_drift"
      | "provider_contract_rejected",
    message: string,
  ) {
    super(message);
    this.name = "BackgroundGitHubProviderBoundaryErrorV1";
  }
}

/**
 * Builds the closed production dependency factory once at worker startup.
 * Every returned provider method still obtains a fresh lease for the action's
 * one opaque credential reference and re-pins /user plus /repos/{owner}/{repo}.
 */
export async function prepareBackgroundGitHubProviderDependencyFactoryV1(
  options: BackgroundGitHubProviderFactoryOptionsV1,
): Promise<RuntimeFactoryV1> {
  const health = await options.secretStore.health();
  if (!health.available || !health.persistent || !health.backgroundEligible) {
    throw new BackgroundGitHubProviderBoundaryErrorV1(
      "secure_store_unavailable",
      "Background GitHub execution requires a secure persistent credential backend.",
    );
  }
  const root = validateCompanionAppDataRootV1(options.applicationDataRoot);
  const runtimeRoot = path.join(root, "background-github-runtime-v1");
  const hooksRoot = path.join(runtimeRoot, "disabled-hooks");
  const askpassRoot = path.join(runtimeRoot, "askpass");
  await ensureSafeCompanionDirectoryV1(root, hooksRoot);
  await ensureSafeCompanionDirectoryV1(root, askpassRoot);

  const persistence = new BackgroundGitHubProviderPersistenceV1(root);
  const pushAttempts = new DurableGitPushAttemptStoreV1(persistence.gitPushAttempts());
  const runner = options.gitCommandRunner ?? new SpawnVerifiedGitCommandRunnerV1({
    gitExecutable: await resolveGitExecutable(options.gitExecutable),
  });
  const askpass = options.askpassBroker ?? new LoopbackEphemeralGitAskpassBrokerV1({
    secretStore: options.secretStore,
    tempRoot: askpassRoot,
  });
  const pushGateway = new VerifiedGitPushGatewayV1({
    runner,
    askpassBroker: askpass,
    attemptStore: pushAttempts,
    disabledHooksPath: hooksRoot,
    now: options.now,
  });
  const checkpoints = new GitHubPublicationCheckpointStoreV1(
    persistence.publicationCheckpoints(),
  );
  const transport = options.transport ?? createFixedGitHubNodeTransportV1();
  const now = options.now ?? (() => new Date());

  return ({ action, attempts, approvalReceipts }): BackgroundGitHubContinuationDependenciesV1 => {
    const scoped = new ActionScopedGitHubProviderV1({
      action,
      secretStore: options.secretStore,
      transport,
      now,
    });
    return {
      pushGateway,
      approvalReceipts,
      accountVerifier: {
        verify: (referenceId, signal) => {
          if (referenceId !== action.binding.credentialReferenceId) {
            throw boundary(
              "credential_scope_rejected",
              "Account verification requested a credential outside the prepared action.",
            );
          }
          return scoped.verifyAccount(signal);
        },
      },
      remoteHeads: {
        read: (input) => scoped.readRemoteHead(input, input.signal),
      },
      workflows: {
        create: async (input) => {
          assertSameAction(action, input.package.action);
          let checkpoint = await checkpoints.get(action.payload.publicationId);
          if (!checkpoint) checkpoint = await checkpoints.upsert(input.package.localPlan.checkpoint);
          const push = createWorkflowPushPort(action, input.package, pushGateway, now);
          return {
            workflow: new GitHubPublicationWorkflowV1({
              push,
              provider: scoped,
              approvals: input.approvals,
              preapprovedApprovals: {
                consume: (approval) => consumePreapprovedBackgroundApproval(action, approval),
              },
              checkpoints,
              approvalIdentity: {
                runId: action.missionId,
                toolCallId: action.preparedActionId,
                toolName: action.toolName,
              },
              now,
            }),
            checkpoint,
            finalizers: "disabled_until_core_reconnect",
          };
        },
      },
      autoMerge: {
        enable: (input) => scoped.enableAutoMerge(input, false),
        reconcile: (input) => scoped.enableAutoMerge(input, true),
      },
      attempts,
      now,
    };
  };
}

class ActionScopedGitHubProviderV1 implements GitHubPublicationProviderPortV1 {
  constructor(private readonly options: {
    action: PreparedBackgroundGitHubActionV1;
    secretStore: SecretStoreV1;
    transport: HttpTransport;
    now: () => Date;
  }) {}

  verifyAccount(signal?: AbortSignal) {
    return this.withPinnedClient(signal, async (_client, _secret, account) => account);
  }

  readRemoteHead(
    input: { credentialReferenceId: string; owner: string; repository: string; branch: string },
    signal?: AbortSignal,
  ): Promise<string | null> {
    this.assertCredential(input.credentialReferenceId);
    this.assertRepository(input.owner, input.repository);
    if (input.branch !== this.options.action.payload.branch) {
      throw boundary("repository_drift", "Remote branch readback drifted from the prepared action.");
    }
    return this.withPinnedClient(signal, async (client) => {
      try {
        return (await client.getReference(input.owner, input.repository, input.branch, signal)).sha;
      } catch (error) {
        if (error instanceof GitHubApiError && error.code === "github_not_found") return null;
        throw error;
      }
    });
  }

  listPullRequestsForHead(owner: string, repository: string, head: string, base: string, signal?: AbortSignal) {
    this.assertRepository(owner, repository);
    this.assertBranchAndBase(head, base);
    return this.withPinnedClient(signal, async (client) =>
      (await client.listPullRequestsForHead(owner, repository, head, base, signal)).map(projectPullRequest));
  }

  createDraftPullRequest(input: { owner: string; repository: string; title: string; body: string; head: string; base: string }, signal?: AbortSignal) {
    this.assertRepository(input.owner, input.repository);
    this.assertBranchAndBase(input.head, input.base);
    const action = this.options.action;
    if (
      action.operation !== GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1 ||
      fingerprintBackgroundGitHubValueV1(input.title) !== action.payload.titleFingerprint ||
      fingerprintBackgroundGitHubValueV1(input.body) !== action.payload.bodyFingerprint
    ) throw boundary("provider_contract_rejected", "Draft pull-request document drifted from the approved package.");
    return this.withPinnedClient(signal, async (client) => {
      const pullRequest = projectPullRequest(await client.createDraftPullRequest(input, signal));
      return { pullRequest, receipt: this.receipt("create", pullRequest) };
    });
  }

  getPullRequest(owner: string, repository: string, number: number, signal?: AbortSignal) {
    this.assertRepository(owner, repository);
    this.assertPullRequestNumber(number);
    return this.withPinnedClient(signal, async (client) =>
      projectPullRequest(await client.getPullRequest(owner, repository, number, signal)));
  }

  listCheckRuns(owner: string, repository: string, reference: string, signal?: AbortSignal) {
    this.assertRepository(owner, repository);
    this.assertHead(reference);
    return this.withPinnedClient(signal, async (client) =>
      (await client.listCheckRuns(owner, repository, reference, signal)).map((check) => ({
        name: check.name, status: check.status, ...(check.conclusion ? { conclusion: check.conclusion } : {}),
      })));
  }

  getCombinedStatus(owner: string, repository: string, reference: string, signal?: AbortSignal) {
    this.assertRepository(owner, repository);
    this.assertHead(reference);
    return this.withPinnedClient(signal, async (client) =>
      (await client.getCombinedStatus(owner, repository, reference, signal)).statuses.map((status) => ({
        context: status.context, state: status.state,
      })));
  }

  listPullRequestReviews(owner: string, repository: string, number: number, signal?: AbortSignal) {
    this.assertRepository(owner, repository);
    this.assertPullRequestNumber(number);
    return this.withPinnedClient(signal, async (client) =>
      (await client.listPullRequestReviews(owner, repository, number, signal)).map((review) => ({
        id: review.id,
        userLogin: review.author.login,
        state: normalizeReviewState(review.state),
        submittedAt: review.submittedAt,
        body: review.body,
      })));
  }

  async markPullRequestReady(): Promise<never> {
    throw boundary("provider_contract_rejected", "Background ready-for-review mutation is outside the prepared five-operation catalog.");
  }

  mergePullRequest(input: { owner: string; repository: string; number: number; sha: string; mergeMethod: "squash" | "merge" | "rebase" }, signal?: AbortSignal) {
    this.assertRepository(input.owner, input.repository);
    const action = this.options.action;
    if (
      action.operation !== GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 ||
      input.number !== action.payload.pullRequestNumber ||
      input.sha !== action.payload.headSha ||
      input.mergeMethod !== action.payload.mergeMethod
    ) throw boundary("provider_contract_rejected", "Merge request drifted from the double-exact approved package.");
    return this.withPinnedClient(signal, async (client) => {
      const merged = await client.mergePullRequest({
        owner: input.owner,
        repository: input.repository,
        number: input.number,
        expectedHeadSha: input.sha,
        mergeMethod: input.mergeMethod,
      }, signal);
      return { merged: merged.merged, sha: merged.sha, receipt: this.receipt("merge", {
        number: input.number, sha: merged.sha, merged: merged.merged,
      }) };
    });
  }

  async enableAutoMerge(
    input: {
      credentialReferenceId: string;
      binding: TrustedGitHubPublicationBindingV1;
      checkpoint: GitHubPublicationCheckpointV1;
      approvalFingerprint: string;
      signal?: AbortSignal;
    },
    reconcileOnly: boolean,
  ): Promise<BackgroundGitHubAutoMergeEffectResultV1> {
    this.assertCredential(input.credentialReferenceId);
    this.assertPublicationBinding(input.binding);
    const action = this.options.action;
    if (
      action.operation !== GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1 ||
      input.approvalFingerprint !== action.payload.workflowApprovalFingerprint ||
      input.checkpoint.proofSnapshot?.snapshotFingerprint !== action.payload.proofSnapshotFingerprint ||
      input.checkpoint.pullRequest?.number !== action.payload.pullRequestNumber
    ) return { status: "not_applied", message: "Auto-merge request drifted from its double-exact approved proof." };
    try {
      return await this.withPinnedClient(input.signal, async (client, secret) => {
        if (reconcileOnly) {
          const readback = await this.readAutoMerge(secret, input.signal);
          if (!readback.enabled) {
            return {
              status: "not_applied" as const,
              message: "Readback proved auto-merge is not enabled.",
            };
          }
          return {
            status: "verified" as const,
            readback: this.autoMergeReadbackEvidence(),
          };
        }
        const pullRequest = await client.getPullRequest(
          action.binding.owner, action.binding.repository, action.payload.pullRequestNumber, input.signal,
        );
        assertExactPullRequest(action, pullRequest);
        const [checks, combinedStatus, reviews] = await Promise.all([
          client.listCheckRuns(
            action.binding.owner,
            action.binding.repository,
            action.payload.headSha,
            input.signal,
          ),
          client.getCombinedStatus(
            action.binding.owner,
            action.binding.repository,
            action.payload.headSha,
            input.signal,
          ),
          client.listPullRequestReviews(
            action.binding.owner,
            action.binding.repository,
            action.payload.pullRequestNumber,
            input.signal,
          ),
        ]);
        const freshProof = createProofSnapshot(
          projectPullRequest(pullRequest),
          input.binding.requiredChecks,
          checks.map((check) => ({
            name: check.name,
            status: check.status,
            ...(check.conclusion ? { conclusion: check.conclusion } : {}),
          })),
          combinedStatus.statuses.map((status) => ({
            context: status.context,
            state: status.state,
          })),
          reviews.map((review) => ({
            id: review.id,
            userLogin: review.author.login,
            state: normalizeReviewState(review.state),
            submittedAt: review.submittedAt,
            body: review.body,
          })),
          this.options.now().toISOString(),
        );
        if (freshProof.snapshotFingerprint !== action.payload.proofSnapshotFingerprint) {
          return {
            status: "not_applied" as const,
            message: "Fresh pull-request checks or reviews drifted; auto-merge was not enabled.",
          };
        }
        await this.graphql(secret, {
          query: "mutation AgenticResearcherEnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) { pullRequest { id } } }",
          variables: { pullRequestId: pullRequest.nodeId, mergeMethod: action.payload.mergeMethod.toUpperCase() },
        }, input.signal);
        const readback = await this.readAutoMerge(secret, input.signal);
        if (!readback.enabled) {
          return {
            status: "reconcile_required",
            message: "Auto-merge dispatch returned without matching readback.",
          };
        }
        return { status: "verified", readback: this.autoMergeReadbackEvidence() };
      });
    } catch {
      return { status: "reconcile_required", message: reconcileOnly
        ? "Auto-merge readback remains ambiguous; the mutation was not replayed."
        : "Auto-merge dispatch may have committed; read-only reconciliation is required." };
    }
  }

  private async withPinnedClient<T>(
    signal: AbortSignal | undefined,
    use: (
      client: GitHubRestClient,
      secret: string,
      account: { id: number; login: string },
    ) => Promise<T>,
  ): Promise<T> {
    const reference = this.options.action.binding.credentialReferenceId;
    const description = await this.options.secretStore.describe(reference);
    if (
      !description.persistent ||
      description.referenceId !== reference ||
      description.metadata.provider !== "github"
    ) {
      throw boundary("credential_scope_rejected", "GitHub credential reference is not securely persistent.");
    }
    const lease = await this.options.secretStore.lease(reference, { ttlSeconds: 90 });
    try {
      if (!lease.description.persistent || lease.description.referenceId !== reference) {
        throw boundary("credential_scope_rejected", "GitHub credential lease escaped the approved reference.");
      }
      return await lease.withSecret(async (secret) => {
        if (!/^[\x21-\x7e]{1,4096}$/u.test(secret)) {
          throw boundary("credential_scope_rejected", "GitHub credential failed the bounded token contract.");
        }
        try {
          const client = new GitHubRestClient({ transport: this.options.transport, token: secret });
          const user = await client.getAuthenticatedUser(signal);
          if (
            user.id !== this.options.action.binding.verifiedAccountId ||
            user.login !== this.options.action.binding.verifiedAccountLogin
          ) throw boundary("account_drift", "GitHub /user no longer matches the approved account.");
          const repository = await client.getRepository(
            this.options.action.binding.owner,
            this.options.action.binding.repository,
            signal,
          );
          if (
            repository.id !== this.options.action.binding.repositoryId ||
            repository.fullName !== `${this.options.action.binding.owner}/${this.options.action.binding.repository}` ||
            repository.defaultBranch !== this.options.action.payload.baseBranch ||
            repository.archived
          ) throw boundary("repository_drift", "GitHub repository readback no longer matches the trusted binding.");
          const result = await use(client, secret, { id: user.id, login: user.login });
          if (JSON.stringify(result).includes(secret)) {
            throw boundary("credential_scope_rejected", "Secret material was rejected from GitHub provider output.");
          }
          return result;
        } catch (error) {
          if (error instanceof BackgroundGitHubProviderBoundaryErrorV1) throw error;
          throw boundary("provider_contract_rejected", safeProviderMessage(error, secret));
        }
      });
    } finally {
      lease.dispose();
    }
  }

  private async graphql(secret: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.options.transport({
      url: "https://api.github.com/graphql",
      method: "POST",
      contentType: "application/json",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${secret}`, "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
      abortSignal: signal,
      throw: false,
    });
    if (response.status < 200 || response.status >= 300 || !response.json || typeof response.json !== "object") {
      throw new Error("GitHub GraphQL readback failed.");
    }
    const record = response.json as Record<string, unknown>;
    if (Array.isArray(record.errors) && record.errors.length > 0) throw new Error("GitHub GraphQL returned a provider error.");
    return record;
  }

  private async readAutoMerge(secret: string, signal?: AbortSignal): Promise<{ enabled: boolean }> {
    const action = this.options.action;
    if (action.operation !== GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1) {
      throw boundary("provider_contract_rejected", "Auto-merge readback was requested for a different operation.");
    }
    const payload = await this.graphql(secret, {
      query: "query AgenticResearcherAutoMergeReadback($owner: String!, $repository: String!, $number: Int!) { repository(owner: $owner, name: $repository) { pullRequest(number: $number) { id number headRefOid baseRefName autoMergeRequest { enabledAt mergeMethod } } } }",
      variables: {
        owner: action.binding.owner,
        repository: action.binding.repository,
        number: action.payload.pullRequestNumber,
      },
    }, signal);
    const data = record(payload.data);
    const repository = record(data.repository);
    const node = record(repository.pullRequest);
    if (
      node.number !== action.payload.pullRequestNumber ||
      node.headRefOid !== action.payload.headSha ||
      node.baseRefName !== action.payload.baseBranch
    ) throw boundary("repository_drift", "Auto-merge readback drifted from the approved pull request.");
    if (node.autoMergeRequest === null || node.autoMergeRequest === undefined) {
      return { enabled: false };
    }
    const request = record(node.autoMergeRequest);
    return { enabled: typeof request.enabledAt === "string" && request.mergeMethod === action.payload.mergeMethod.toUpperCase() };
  }

  private autoMergeReadbackEvidence(): Extract<BackgroundGitHubAutoMergeEffectResultV1, { status: "verified" }>["readback"] {
    const action = this.options.action;
    if (action.operation !== GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1) {
      throw boundary("provider_contract_rejected", "Auto-merge evidence was requested for a different operation.");
    }
    const evidence = {
      enabled: true as const,
      pullRequestNumber: action.payload.pullRequestNumber,
      headSha: action.payload.headSha,
      baseBranch: action.payload.baseBranch,
      mergeMethod: action.payload.mergeMethod,
      proofSnapshotFingerprint: action.payload.proofSnapshotFingerprint,
      observedAt: this.options.now().toISOString(),
    };
    return {
      ...evidence,
      readbackFingerprint: fingerprintBackgroundGitHubValueV1(evidence),
    };
  }

  private assertCredential(reference: string): void {
    if (reference !== this.options.action.binding.credentialReferenceId) throw boundary("credential_scope_rejected", "Credential reference drifted from the prepared action.");
  }
  private assertRepository(owner: string, repository: string): void {
    if (owner !== this.options.action.binding.owner || repository !== this.options.action.binding.repository) throw boundary("repository_drift", "Repository arguments drifted from the prepared action.");
  }
  private assertBranchAndBase(head: string, base: string): void {
    const payload = this.options.action.payload;
    if (head !== payload.branch || base !== payload.baseBranch) throw boundary("repository_drift", "Branch or base drifted from the prepared action.");
  }
  private assertHead(reference: string): void {
    const action = this.options.action;
    const allowed = action.operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1
      ? [action.payload.expectedOldHeadSha, action.payload.newHeadSha]
      : [action.payload.headSha];
    if (!allowed.includes(reference)) throw boundary("repository_drift", "Provider reference drifted from the prepared action.");
  }
  private assertPullRequestNumber(number: number): void {
    const action = this.options.action;
    if (
      action.operation !== GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1 &&
      (action.operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1 ||
       action.operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 ||
       action.operation === GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1) &&
      number !== action.payload.pullRequestNumber
    ) throw boundary("repository_drift", "Pull-request number drifted from the prepared action.");
  }
  private assertPublicationBinding(binding: TrustedGitHubPublicationBindingV1): void {
    this.assertRepository(binding.owner, binding.repository);
    if (
      binding.bindingFingerprint !== this.options.action.binding.repositoryBindingFingerprint ||
      binding.accountId !== String(this.options.action.binding.verifiedAccountId)
    ) throw boundary("repository_drift", "Publication binding drifted from the prepared action.");
  }
  private receipt(operation: "create" | "merge", evidence: unknown): ActionReceipt {
    const action = this.options.action;
    const committedAt = this.options.now().toISOString();
    return {
      version: 1,
      id: fingerprintBackgroundGitHubValueV1({ action: action.fingerprint, operation, evidence }),
      runId: action.missionId,
      actionId: action.preparedActionId,
      toolName: action.toolName,
      operation,
      resource: {
        system: "github",
        resourceType: operation === "merge" ? "pull_request_merge" : "pull_request",
        id: `${action.binding.owner}/${action.binding.repository}`,
        repositoryId: String(action.binding.repositoryId),
      },
      message: operation === "merge" ? "GitHub merge verified by readback." : "GitHub draft pull request created and read back.",
      payloadFingerprint: action.preparedActionFingerprint,
      grantId: action.authority.id,
      idempotencyKey: action.idempotencyKey,
      startedAt: committedAt,
      committedAt,
      commitKind: "committed",
      readback: {
        status: "verified",
        checkedAt: committedAt,
        observedFingerprint: fingerprintBackgroundGitHubValueV1(evidence),
      },
    };
  }
}

function createWorkflowPushPort(
  action: PreparedBackgroundGitHubActionV1,
  preparedPackage: PreparedBackgroundGitHubPackageV1,
  gateway: VerifiedGitPushGatewayV1,
  now: () => Date,
): GitHubPublicationPushPortV1 {
  const execute = async (reconcile: boolean, input: Parameters<GitHubPublicationPushPortV1["publish"]>[0]) => {
    const handoff = preparedPackage.localPlan.verifiedCodeHandoff;
    if (!handoff || input.handoff.handoffFingerprint !== handoff.fingerprint || input.approvalFingerprint !== action.preparedActionFingerprint) {
      throw boundary("provider_contract_rejected", "Workflow push drifted from the verified package handoff.");
    }
    const request = {
      handoff,
      binding: preparedPackage.localPlan.repositoryBinding,
      profile: {
        repositoryProfileKey: preparedPackage.localPlan.repositoryProof.repositoryProfileKey,
        repositoryProfileFingerprint: preparedPackage.localPlan.repositoryProof.repositoryProfileFingerprint,
        canonicalRepositoryRoot: preparedPackage.localPlan.repositoryProof.canonicalRepositoryRoot,
        defaultBranch: preparedPackage.localPlan.repositoryProof.defaultBranch,
        forbidForcePush: true as const,
      },
      credentialReferenceId: action.binding.credentialReferenceId,
      signal: input.signal,
    };
    const result = reconcile ? await gateway.reconcile(request) : await gateway.push(request);
    if (result.status === "pushed_verified") return {
      status: "verified" as const,
      remoteSha: result.receipt.remoteSha,
      receipt: pushReceipt(action, result.receipt, now()),
    };
    if (reconcile && result.status === "not_applied") return { status: "not_applied" as const };
    return {
      status: "reconcile_required" as const,
      pendingAction: createPendingExternalActionStateV2({
        schemaVersion: 2,
        provider: "github",
        operation: "git_push",
        actionId: action.preparedActionId,
        resourceId: `${action.binding.owner}-${action.binding.repository}-${action.payload.branch}`,
        preparedActionFingerprint: action.preparedActionFingerprint,
        targetFingerprint: fingerprintBackgroundGitHubValueV1({ branch: action.payload.branch, head: handoff.commitSha }),
        dispatchState: "reconcile_required",
        attempt: 1,
        preparedAt: action.preparedAt,
        dispatchedAt: now().toISOString(),
        lastObservedAt: now().toISOString(),
        providerRequestId: null,
        error: { code: "github_push_reconcile_required", message: result.message },
      }),
    };
  };
  return {
    publish: async (input) => {
      const result = await execute(false, input);
      if (result.status === "not_applied") {
        throw boundary("provider_contract_rejected", "A first push dispatch unexpectedly returned not-applied.");
      }
      return result;
    },
    reconcile: (input) => execute(true, input),
  };
}

async function consumePreapprovedBackgroundApproval(
  action: PreparedBackgroundGitHubActionV1,
  input: GitHubPublicationPreapprovedApprovalInputV1,
) {
  const bindingMatches =
    input.binding.bindingFingerprint === action.binding.repositoryBindingFingerprint &&
    input.binding.owner === action.binding.owner &&
    input.binding.repository === action.binding.repository &&
    input.binding.accountId === String(action.binding.verifiedAccountId) &&
    input.binding.accountLogin === action.binding.verifiedAccountLogin &&
    input.binding.baseBranch === action.payload.baseBranch;
  if (!bindingMatches || input.publicationId !== action.payload.publicationId) {
    throw boundary(
      "provider_contract_rejected",
      "Preapproved workflow binding drifted from the signed background action.",
    );
  }
  const reviewRepairMatches =
    input.kind === "repair_fast_forward" &&
    action.operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1 &&
    input.pullRequestNumber === action.payload.pullRequestNumber &&
    input.branch === action.payload.branch &&
    input.previousHeadSha === action.payload.expectedOldHeadSha &&
    input.newHeadSha === action.payload.newHeadSha &&
    input.repairId === action.payload.repairId &&
    input.previousHandoffFingerprint === action.payload.previousHandoffFingerprint &&
    input.handoffFingerprint === action.payload.handoffFingerprint;
  const mergeMatches =
    input.kind === "merge" &&
    action.operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 &&
    input.pullRequestNumber === action.payload.pullRequestNumber &&
    input.branch === action.payload.branch &&
    input.headSha === action.payload.headSha &&
    input.pullRequestUpdatedAt === action.payload.pullRequestUpdatedAt &&
    input.proofSnapshotFingerprint === action.payload.proofSnapshotFingerprint &&
    fingerprintBackgroundGitHubValueV1(input.requiredChecks) ===
      action.payload.requiredChecksFingerprint &&
    input.mergeMethod === action.payload.mergeMethod;
  const requiredConfirmations = input.kind === "merge" ? 2 : 1;
  if (
    (!reviewRepairMatches && !mergeMatches) ||
    action.authority.requiredConfirmations !== requiredConfirmations ||
    action.authority.confirmationReceipts.length !== requiredConfirmations ||
    action.preparedActionFingerprint !== action.payload.workflowApprovalFingerprint
  ) {
    throw boundary(
      "provider_contract_rejected",
      "Workflow effect drifted from the already authenticated background approval.",
    );
  }
  return {
    approved: true,
    approvalFingerprint: action.payload.workflowApprovalFingerprint,
    approvalId: action.authority.confirmationReceipts
      .map((receipt) => receipt.fingerprint)
      .join(":"),
    confirmations: requiredConfirmations as 1 | 2,
  };
}

function pushReceipt(action: PreparedBackgroundGitHubActionV1, receipt: { id: string; remoteSha: string; fingerprint: string }, at: Date): ActionReceipt {
  const timestamp = at.toISOString();
  return {
    version: 1,
    id: receipt.id,
    runId: action.missionId,
    actionId: action.preparedActionId,
    toolName: action.toolName,
    operation: "publish",
    resource: { system: "github", resourceType: "branch", id: action.payload.branch, repositoryId: String(action.binding.repositoryId), revision: receipt.remoteSha },
    message: "Agent-owned GitHub branch push verified by remote SHA readback.",
    payloadFingerprint: action.preparedActionFingerprint,
    grantId: action.authority.id,
    idempotencyKey: action.idempotencyKey,
    startedAt: timestamp,
    committedAt: timestamp,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: timestamp,
      observedRevision: receipt.remoteSha,
      observedFingerprint: receipt.fingerprint,
    },
  };
}

function projectPullRequest(value: GitHubPullRequestRecord): GitHubPublicationPullRequestV1 {
  return {
    number: value.number,
    htmlUrl: value.htmlUrl,
    state: value.state,
    draft: value.draft,
    merged: value.merged,
    head: { ...value.head },
    base: { ...value.base },
    updatedAt: value.updatedAt,
    ...(value.mergeSha === undefined ? {} : { mergeSha: value.mergeSha }),
  };
}

function assertExactPullRequest(action: PreparedBackgroundGitHubActionV1, value: GitHubPullRequestRecord): void {
  if (
    action.operation !== GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 &&
    action.operation !== GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1
  ) throw boundary("provider_contract_rejected", "Merge readback was requested for a different operation.");
  if (
    value.number !== action.payload.pullRequestNumber ||
    value.state !== "open" || value.draft || value.merged ||
    value.head.ref !== action.payload.branch || value.head.sha !== action.payload.headSha ||
    value.base.ref !== action.payload.baseBranch || value.updatedAt !== action.payload.pullRequestUpdatedAt
  ) throw boundary("repository_drift", "Pull-request readback drifted from the approved proof snapshot.");
}

function normalizeReviewState(value: string): "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING" {
  return ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(value)
    ? value as "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"
    : "COMMENTED";
}

function assertSameAction(expected: PreparedBackgroundGitHubActionV1, observed: PreparedBackgroundGitHubActionV1): void {
  if (expected.fingerprint !== observed.fingerprint) throw boundary("provider_contract_rejected", "Runtime package action drifted from the worker action.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub GraphQL returned an invalid object.");
  return value as Record<string, unknown>;
}

function boundary(code: BackgroundGitHubProviderBoundaryErrorV1["code"], message: string) {
  return new BackgroundGitHubProviderBoundaryErrorV1(code, message);
}

function safeProviderMessage(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : "GitHub provider operation failed.";
  return message.split(secret).join("[REDACTED]").slice(0, 1_000);
}

async function resolveGitExecutable(explicit?: string): Promise<string> {
  const candidates = [
    explicit,
    ...(process.env.PATH ?? "").split(path.delimiter).map((entry) => path.join(entry, process.platform === "win32" ? "git.exe" : "git")),
    process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe") : "/usr/bin/git",
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "cmd", "git.exe") : "/usr/local/bin/git",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const absolute = path.resolve(candidate);
      const [stat, real] = await Promise.all([fs.stat(absolute), fs.realpath(absolute)]);
      if (stat.isFile() && path.resolve(real) === absolute) return absolute;
    } catch { /* continue through the fixed executable catalog */ }
  }
  throw boundary("git_runtime_unavailable", "An immutable Git executable could not be resolved for secure publication.");
}
