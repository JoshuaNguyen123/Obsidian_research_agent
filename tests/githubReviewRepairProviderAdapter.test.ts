import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubReviewRepairProviderAdapterV1,
  type GitHubReviewRepairClientV1,
} from "../src/integrations/github/GitHubReviewRepairProviderAdapterV1";
import type {
  GitHubPullRequestRecord,
  GitHubReviewRecord,
} from "../src/integrations/github/GitHubRestClient";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("review-repair provider projects the fixed catalog and keeps only the newest 50 reviews", async () => {
  let leases = 0;
  const client = fakeClient();
  client.listPullRequestReviews = async () => Array.from(
    { length: 51 },
    (_, index) => review(index + 1),
  );
  const provider = new GitHubReviewRepairProviderAdapterV1({
    async use<T>(operation: (leased: GitHubReviewRepairClientV1) => Promise<T>): Promise<T> {
      leases += 1;
      return operation(client);
    },
  });

  const pullRequest = await provider.getPullRequest("acme", "agent", 12);
  const reviews = await provider.listPullRequestReviews("acme", "agent", 12);
  const comments = await provider.listUnresolvedPullRequestReviewComments("acme", "agent", 12);
  const head = await provider.getRemoteBranchHead("acme", "agent", "codex/eng-12");

  assert.deepEqual(pullRequest, {
    number: 12,
    state: "open",
    draft: true,
    merged: false,
    head: { ref: "codex/eng-12", sha: SHA_A },
    base: { ref: "main", sha: SHA_B },
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  assert.equal(reviews.length, 50);
  assert.equal(reviews[0]?.id, 51);
  assert.equal(reviews.at(-1)?.id, 2);
  assert.deepEqual(reviews[0], {
    id: 51,
    authorLogin: "reviewer-51",
    state: "CHANGES_REQUESTED",
    submittedAt: "2026-07-12T00:00:51.000Z",
    body: "Review 51",
    commitSha: SHA_A,
  });
  assert.deepEqual(comments, [{
    id: 91,
    authorLogin: "reviewer-one",
    body: "Please add a restart test.",
    createdAt: "2026-07-12T01:00:00.000Z",
    updatedAt: "2026-07-12T02:00:00.000Z",
    reviewId: 50,
  }]);
  assert.equal("path" in (comments[0] ?? {}), false);
  assert.equal(head, SHA_A);
  assert.equal(leases, 4);
});

test("review-repair provider rejects unsupported review state and inexact ref readback", async () => {
  const badReviewClient = fakeClient();
  badReviewClient.listPullRequestReviews = async () => [{ ...review(1), state: "UNKNOWN" }];
  const badReviewProvider = providerFor(badReviewClient);
  await assert.rejects(
    badReviewProvider.listPullRequestReviews("acme", "agent", 12),
    /unsupported pull-request review state/,
  );

  const badRefClient = fakeClient();
  badRefClient.getReference = async () => ({
    ref: "refs/heads/codex/another-branch",
    sha: SHA_A,
    objectType: "commit",
  });
  const badRefProvider = providerFor(badRefClient);
  await assert.rejects(
    badRefProvider.getRemoteBranchHead("acme", "agent", "codex/eng-12"),
    /exact requested commit reference/,
  );
});

function providerFor(client: GitHubReviewRepairClientV1): GitHubReviewRepairProviderAdapterV1 {
  return new GitHubReviewRepairProviderAdapterV1({
    use<T>(operation: (leased: GitHubReviewRepairClientV1) => Promise<T>): Promise<T> {
      return operation(client);
    },
  });
}

function fakeClient(): GitHubReviewRepairClientV1 {
  return {
    async getPullRequest(): Promise<GitHubPullRequestRecord> {
      return {
        nodeId: "PR_agentic_12",
        number: 12,
        htmlUrl: "https://github.com/acme/agent/pull/12",
        state: "open",
        title: "Verified repair",
        body: "Body",
        draft: true,
        merged: false,
        head: { ref: "codex/eng-12", sha: SHA_A },
        base: { ref: "main", sha: SHA_B },
        updatedAt: "2026-07-12T00:00:00.000Z",
        mergeSha: null,
      };
    },
    async listPullRequestReviews(): Promise<GitHubReviewRecord[]> {
      return [review(1)];
    },
    async listUnresolvedPullRequestReviewComments() {
      return [{
        id: 91,
        authorLogin: "reviewer-one",
        body: "Please add a restart test.",
        createdAt: "2026-07-12T01:00:00.000Z",
        updatedAt: "2026-07-12T02:00:00.000Z",
        reviewId: 50,
      }];
    },
    async getReference() {
      return { ref: "refs/heads/codex/eng-12", sha: SHA_A, objectType: "commit" };
    },
  };
}

function review(id: number): GitHubReviewRecord {
  return {
    id,
    htmlUrl: `https://github.com/acme/agent/pull/12#pullrequestreview-${id}`,
    state: "changes_requested",
    body: `Review ${id}`,
    commitId: SHA_A,
    author: { id, login: `reviewer-${id}` },
    submittedAt: `2026-07-12T00:00:${String(id).padStart(2, "0")}.000Z`,
  };
}
