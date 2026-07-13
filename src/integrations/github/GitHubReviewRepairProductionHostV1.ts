import type { VerifiedCodePublicationHandoffV1 } from "../../../packages/core-api/src/verifiedCodePublicationHandoffV1";
import type {
  GitHubReviewRepairBindingV1,
  GitHubReviewRepairCodeResultV1,
  GitHubReviewRepairCommentV1,
  GitHubReviewRepairHostV1,
  GitHubReviewRepairPublicationResultV1,
  GitHubReviewRepairPullRequestV1,
  GitHubReviewRepairReviewV1,
} from "./GitHubReviewRepairCoordinatorV1";

/**
 * Credential-bound, fixed GitHub read catalog needed by review repair. The
 * implementation belongs to core/integrations and must project only unresolved
 * thread prose; it does not expose a generic REST or GraphQL escape hatch.
 */
export interface FixedGitHubReviewRepairProviderV1 {
  getPullRequest(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewRepairPullRequestV1>;
  listPullRequestReviews(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewRepairReviewV1[]>;
  listUnresolvedPullRequestReviewComments(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewRepairCommentV1[]>;
  getRemoteBranchHead(
    owner: string,
    repository: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

/**
 * Exact Code-extension methods required for production composition. The Code
 * extension must reconstruct worktree/profile paths and validation commands
 * from its own durable bindings. None of those values may come from review
 * prose or from this bridge's caller.
 */
export interface CodeExtensionReviewRepairBridgeV1 {
  resolveVerifiedReviewRepairBase(input: {
    profileKey: string;
    workspaceId: string;
    branch: string;
    runId: string;
    requestId: string;
    expectedFingerprint: string;
    signal?: AbortSignal;
  }): Promise<VerifiedCodePublicationHandoffV1 | null>;
  resolveVerifiedReviewRepairResult(input: {
    repairRequestId: string;
    runId: string;
    profileKey: string;
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<GitHubReviewRepairCodeResultV1 | null>;
  runVerifiedReviewRepairPipeline(input: {
    repairRequestId: string;
    runId: string;
    profileKey: string;
    workspaceId: string;
    branch: string;
    expectedBaseSha: string;
    baseRequestId: string;
    baseHandoffFingerprint: string;
    objective: string;
    reviewEvidenceFingerprint: string;
    maxCycles: 3;
    signal?: AbortSignal;
  }): Promise<GitHubReviewRepairCodeResultV1>;
}

/**
 * Existing secure-push/draft-publication workflow adapter. It may update only
 * the exact owned PR branch by verified fast-forward and must reconcile an
 * interrupted dispatch by readback instead of pushing again.
 */
export interface SecureGitHubReviewRepairPublisherV1 {
  publishVerifiedReviewRepairFastForward(input: {
    repairId: string;
    publicationId: string;
    binding: GitHubReviewRepairBindingV1;
    pullRequestNumber: number;
    expectedRemoteHeadSha: string;
    previousHandoffFingerprint: string;
    handoff: VerifiedCodePublicationHandoffV1;
    signal?: AbortSignal;
  }): Promise<GitHubReviewRepairPublicationResultV1>;
  reconcileVerifiedReviewRepairFastForward(input: {
    repairId: string;
    publicationId: string;
    binding: GitHubReviewRepairBindingV1;
    pullRequestNumber: number;
    expectedOldHeadSha: string;
    expectedNewHeadSha: string;
    handoffFingerprint: string;
    handoff: VerifiedCodePublicationHandoffV1;
    signal?: AbortSignal;
  }): Promise<GitHubReviewRepairPublicationResultV1>;
}

export interface GitHubReviewRepairProductionHostDependenciesV1 {
  provider: FixedGitHubReviewRepairProviderV1;
  code: CodeExtensionReviewRepairBridgeV1;
  publication: SecureGitHubReviewRepairPublisherV1;
}

/**
 * Narrow production composition adapter. It intentionally contains no fallback
 * executor, no generic GitHub client, and no direct source-mutation method.
 */
export class GitHubReviewRepairProductionHostV1
  implements GitHubReviewRepairHostV1 {
  constructor(
    private readonly dependencies: GitHubReviewRepairProductionHostDependenciesV1,
  ) {}

  getPullRequest(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewRepairPullRequestV1> {
    return this.dependencies.provider.getPullRequest(owner, repository, number, signal);
  }

  listPullRequestReviews(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewRepairReviewV1[]> {
    return this.dependencies.provider.listPullRequestReviews(owner, repository, number, signal);
  }

  listUnresolvedPullRequestReviewComments(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewRepairCommentV1[]> {
    return this.dependencies.provider.listUnresolvedPullRequestReviewComments(
      owner,
      repository,
      number,
      signal,
    );
  }

  getRemoteBranchHead(
    owner: string,
    repository: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.dependencies.provider.getRemoteBranchHead(owner, repository, branch, signal);
  }

  resolveVerifiedHandoff(input: Parameters<GitHubReviewRepairHostV1["resolveVerifiedHandoff"]>[0]) {
    return this.dependencies.code.resolveVerifiedReviewRepairBase(input);
  }

  resolveRepairResult(input: Parameters<GitHubReviewRepairHostV1["resolveRepairResult"]>[0]) {
    return this.dependencies.code.resolveVerifiedReviewRepairResult(input);
  }

  runVerifiedRepairPipeline(
    input: Parameters<GitHubReviewRepairHostV1["runVerifiedRepairPipeline"]>[0],
  ) {
    return this.dependencies.code.runVerifiedReviewRepairPipeline(input);
  }

  publishVerifiedFastForward(
    input: Parameters<GitHubReviewRepairHostV1["publishVerifiedFastForward"]>[0],
  ) {
    return this.dependencies.publication.publishVerifiedReviewRepairFastForward(input);
  }

  reconcileVerifiedFastForward(
    input: Parameters<GitHubReviewRepairHostV1["reconcileVerifiedFastForward"]>[0],
  ) {
    return this.dependencies.publication.reconcileVerifiedReviewRepairFastForward(input);
  }
}
