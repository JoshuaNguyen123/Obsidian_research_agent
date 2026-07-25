import type { GitHubPullRequestRecord } from "./GitHubRestClient";
import type { GitHubPublicationPullRequestV1 } from "./GitHubPublicationWorkflow";

/**
 * Narrows a REST pull-request record to the durable publication contract.
 * Provider-only prose and node identifiers are deliberately not checkpoint
 * fields, so they cannot make a strict checkpoint parse fail on persistence.
 */
export function projectGitHubPublicationPullRequestV1(
  value: GitHubPullRequestRecord,
): GitHubPublicationPullRequestV1 {
  return {
    number: value.number,
    htmlUrl: value.htmlUrl,
    state: value.state,
    draft: value.draft,
    merged: value.merged,
    head: { ref: value.head.ref, sha: value.head.sha },
    base: { ref: value.base.ref, sha: value.base.sha },
    updatedAt: value.updatedAt,
    ...(value.mergeSha === undefined ? {} : { mergeSha: value.mergeSha }),
  };
}
