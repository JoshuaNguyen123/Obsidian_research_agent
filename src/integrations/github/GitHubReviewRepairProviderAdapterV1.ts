import type {
  GitHubPullRequestRecord,
  GitHubReferenceRecord,
  GitHubRestClient,
  GitHubReviewRecord,
  GitHubUnresolvedReviewCommentRecord,
} from "./GitHubRestClient";
import type {
  GitHubReviewRepairCommentV1,
  GitHubReviewRepairPullRequestV1,
  GitHubReviewRepairReviewV1,
} from "./GitHubReviewRepairCoordinatorV1";
import type { FixedGitHubReviewRepairProviderV1 } from "./GitHubReviewRepairProductionHostV1";

const MAX_REVIEW_RECORDS = 50;

export type GitHubReviewRepairClientV1 = Pick<
  GitHubRestClient,
  | "getPullRequest"
  | "listPullRequestReviews"
  | "listUnresolvedPullRequestReviewComments"
  | "getReference"
>;

/**
 * Leases a credential-bound client for one fixed provider operation. The
 * adapter never receives or retains token plaintext.
 */
export interface GitHubReviewRepairClientLeaseV1 {
  use<T>(operation: (client: GitHubReviewRepairClientV1) => Promise<T>): Promise<T>;
}

/**
 * Production fixed-catalog adapter for the review-repair coordinator. It
 * deliberately projects away URLs, paths, diffs, and every mutation method.
 */
export class GitHubReviewRepairProviderAdapterV1
  implements FixedGitHubReviewRepairProviderV1 {
  constructor(private readonly clientLease: GitHubReviewRepairClientLeaseV1) {}

  getPullRequest(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewRepairPullRequestV1> {
    return this.clientLease.use(async (client) => projectPullRequest(
      await client.getPullRequest(owner, repository, number, signal),
    ));
  }

  listPullRequestReviews(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewRepairReviewV1[]> {
    return this.clientLease.use(async (client) => {
      const reviews = await client.listPullRequestReviews(owner, repository, number, signal);
      return [...reviews]
        .sort(compareNewestReviewFirst)
        .slice(0, MAX_REVIEW_RECORDS)
        .map(projectReview);
    });
  }

  listUnresolvedPullRequestReviewComments(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewRepairCommentV1[]> {
    return this.clientLease.use(async (client) => (
      await client.listUnresolvedPullRequestReviewComments(owner, repository, number, signal)
    ).map(projectUnresolvedComment));
  }

  getRemoteBranchHead(
    owner: string,
    repository: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.clientLease.use(async (client) => {
      const reference = await client.getReference(owner, repository, branch, signal);
      return exactBranchHead(reference, branch);
    });
  }
}

function projectPullRequest(record: GitHubPullRequestRecord): GitHubReviewRepairPullRequestV1 {
  return {
    number: record.number,
    state: record.state,
    draft: record.draft,
    merged: record.merged,
    head: { ref: record.head.ref, sha: record.head.sha },
    base: { ref: record.base.ref, sha: record.base.sha },
    updatedAt: record.updatedAt,
  };
}

function projectReview(record: GitHubReviewRecord): GitHubReviewRepairReviewV1 {
  return {
    id: record.id,
    authorLogin: record.author.login,
    state: reviewState(record.state),
    submittedAt: record.submittedAt,
    body: record.body,
    commitSha: record.commitId ?? null,
  };
}

function projectUnresolvedComment(
  record: GitHubUnresolvedReviewCommentRecord,
): GitHubReviewRepairCommentV1 {
  return {
    id: record.id,
    authorLogin: record.authorLogin,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    body: record.body,
    reviewId: record.reviewId,
  };
}

function compareNewestReviewFirst(left: GitHubReviewRecord, right: GitHubReviewRecord): number {
  const time = Date.parse(right.submittedAt) - Date.parse(left.submittedAt);
  return time || right.id - left.id;
}

function reviewState(value: string): GitHubReviewRepairReviewV1["state"] {
  const state = value.toUpperCase();
  if (
    state !== "APPROVED" &&
    state !== "CHANGES_REQUESTED" &&
    state !== "COMMENTED" &&
    state !== "DISMISSED" &&
    state !== "PENDING"
  ) {
    throw new Error("GitHub returned an unsupported pull-request review state.");
  }
  return state;
}

function exactBranchHead(reference: GitHubReferenceRecord, branch: string): string {
  if (reference.ref !== `refs/heads/${branch}` || reference.objectType !== "commit") {
    throw new Error("GitHub branch readback did not match the exact requested commit reference.");
  }
  return reference.sha;
}
