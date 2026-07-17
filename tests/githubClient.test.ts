import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubApiError,
  GitHubRestClient,
} from "../src/integrations/github/GitHubRestClient";
import type { HttpRequest, HttpResponse } from "../src/model/types";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("GitHubRestClient pins authenticated identity through the fixed /user endpoint", async () => {
  let request: HttpRequest | undefined;
  const client = clientWith(async (input) => {
    request = input;
    return response(200, {
      id: 77,
      login: "agent-bot",
      html_url: "https://github.com/agent-bot",
      name: "Agent Bot",
    });
  });

  const user = await client.getAuthenticatedUser();

  assert.deepEqual(user, {
    id: 77,
    login: "agent-bot",
    htmlUrl: "https://github.com/agent-bot",
    name: "Agent Bot",
  });
  assert.equal(request?.url, "https://api.github.com/user");
  assert.equal(request?.method, "GET");
  assert.equal(request?.headers?.Authorization, "Bearer secret-token");
  assert.equal(request?.headers?.["X-GitHub-Api-Version"], "2026-03-10");
});

test("GitHubRestClient reads a repository through fixed headers", async () => {
  let request: HttpRequest | undefined;
  const client = clientWith(async (input) => {
    request = input;
    return response(200, repositoryPayload());
  });

  const repository = await client.getRepository("acme", "research-agent");
  assert.equal(repository.fullName, "acme/research-agent");
  assert.equal(request?.url, "https://api.github.com/repos/acme/research-agent");
  assert.equal(request?.headers?.Authorization, "Bearer secret-token");
  assert.equal(request?.method, "GET");
});

test("GitHubRestClient creates only an exact private repository payload", async () => {
  const requests: HttpRequest[] = [];
  const client = clientWith(async (request) => {
    requests.push(request);
    return response(201, repositoryPayload());
  });

  const created = await client.createPrivateRepository({
    ownerKind: "organization",
    owner: "acme",
    repository: "research-agent",
    description: "Private daily-use fixture",
  });

  assert.equal(created.private, true);
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.url, "https://api.github.com/orgs/acme/repos");
  assert.deepEqual(JSON.parse(String(requests[0]?.body)), {
    name: "research-agent",
    private: true,
    visibility: "private",
    auto_init: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    description: "Private daily-use fixture",
  });
});

test("GitHubRestClient deletes only the exact fixed repository endpoint", async () => {
  const requests: HttpRequest[] = [];
  const client = clientWith(async (request) => {
    requests.push(request);
    return response(204, undefined);
  });

  await client.deleteRepository("acme", "disposable-private-proof");

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "DELETE");
  assert.equal(
    requests[0]?.url,
    "https://api.github.com/repos/acme/disposable-private-proof",
  );
  assert.equal(requests[0]?.body, undefined);
});

test("GitHubRestClient rejects a create response that is public or identity-drifted", async () => {
  const client = clientWith(async () => response(201, {
    ...repositoryPayload(),
    private: false,
  }));
  await assert.rejects(
    client.createPrivateRepository({
      ownerKind: "user",
      owner: "acme",
      repository: "research-agent",
    }),
    /exact active private repository/iu,
  );
});

test("GitHubRestClient exposes bounded Git database reads with exact paths", async () => {
  const paths: string[] = [];
  const client = clientWith(async (request) => {
    const path = new URL(request.url).pathname + new URL(request.url).search;
    paths.push(path);
    if (path.includes("/git/ref/")) {
      return response(200, referencePayload("refs/heads/codex/eng-12", SHA_A));
    }
    if (path.includes("/git/commits/")) {
      return response(200, {
        sha: SHA_A,
        message: "Verified change",
        tree: { sha: SHA_B },
        author: { name: "Agent Bot", email: "agent@example.test" },
      });
    }
    if (path.includes("/git/trees/")) {
      return response(200, {
        sha: SHA_B,
        truncated: false,
        tree: [{ path: "src/index.ts", mode: "100644", type: "blob", sha: SHA_A, size: 12 }],
      });
    }
    return response(200, {
      sha: SHA_A,
      encoding: "base64",
      size: 5,
      content: "aGVsbG8=",
    });
  });

  assert.equal((await client.getReference("acme", "research-agent", "codex/eng-12")).sha, SHA_A);
  assert.equal((await client.getCommit("acme", "research-agent", SHA_A)).treeSha, SHA_B);
  assert.equal((await client.getTree("acme", "research-agent", SHA_B, true)).entries[0]?.path, "src/index.ts");
  assert.equal((await client.getBlob("acme", "research-agent", SHA_A)).content, "aGVsbG8=");

  assert.deepEqual(paths, [
    "/repos/acme/research-agent/git/ref/heads/codex/eng-12",
    `/repos/acme/research-agent/git/commits/${SHA_A}`,
    `/repos/acme/research-agent/git/trees/${SHA_B}?recursive=1`,
    `/repos/acme/research-agent/git/blobs/${SHA_A}`,
  ]);
});

test("GitHubRestClient exposes bounded issue, review, check, status, and workflow reads", async () => {
  const paths: string[] = [];
  const client = clientWith(async (request) => {
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    paths.push(path);
    if (path.endsWith("/issues/9")) return response(200, issuePayload());
    if (path.includes("/issues?state=all")) return response(200, [issuePayload()]);
    if (path.includes("/issues/9/comments")) return response(200, [commentPayload()]);
    if (path.includes("/pulls/9/reviews")) return response(200, [reviewPayload()]);
    if (path.includes("/pulls/9/comments")) return response(200, [reviewCommentPayload()]);
    if (path.includes("/check-runs")) {
      return response(200, { check_runs: [{ id: 4, name: "test", status: "completed", conclusion: "success" }] });
    }
    if (path.includes("/status")) {
      return response(200, {
        state: "success",
        sha: SHA_A,
        total_count: 1,
        statuses: [{ id: 5, state: "success", context: "ci/test" }],
      });
    }
    return response(200, {
      workflow_runs: [{
        id: 6,
        name: "CI",
        html_url: "https://github.com/acme/research-agent/actions/runs/6",
        status: "completed",
        conclusion: "success",
        head_sha: SHA_A,
        event: "pull_request",
        run_attempt: 1,
        updated_at: "2026-07-12T00:00:00Z",
      }],
    });
  });

  assert.equal((await client.getIssue("acme", "research-agent", 9)).title, "Issue title");
  assert.equal((await client.listIssues("acme", "research-agent"))[0]?.number, 9);
  assert.equal((await client.listIssueComments("acme", "research-agent", 9))[0]?.author.login, "agent-bot");
  assert.equal((await client.listPullRequestReviews("acme", "research-agent", 9))[0]?.state, "APPROVED");
  assert.equal((await client.listPullRequestReviewComments("acme", "research-agent", 9))[0]?.path, "src/index.ts");
  assert.equal((await client.listCheckRuns("acme", "research-agent", SHA_A))[0]?.conclusion, "success");
  assert.equal((await client.getCombinedStatus("acme", "research-agent", SHA_A)).state, "success");
  assert.equal((await client.listWorkflowRunsForCommit("acme", "research-agent", SHA_A))[0]?.name, "CI");

  assert.deepEqual(paths, [
    "/repos/acme/research-agent/issues/9",
    "/repos/acme/research-agent/issues?state=all&sort=created&direction=desc&per_page=100",
    "/repos/acme/research-agent/issues/9/comments?per_page=100",
    "/repos/acme/research-agent/pulls/9/reviews?per_page=100",
    "/repos/acme/research-agent/pulls/9/comments?per_page=100",
    `/repos/acme/research-agent/commits/${SHA_A}/check-runs?per_page=100`,
    `/repos/acme/research-agent/commits/${SHA_A}/status?per_page=100`,
    `/repos/acme/research-agent/actions/runs?head_sha=${SHA_A}&per_page=100`,
  ]);
});

test("GitHubRestClient reads only bounded unresolved review prose through its fixed GraphQL query", async () => {
  let request: HttpRequest | undefined;
  const client = clientWith(async (input) => {
    request = input;
    return response(200, {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  isResolved: false,
                  comments: {
                    nodes: [{
                      databaseId: 91,
                      body: "  Please cover the restart case.  ",
                      createdAt: "2026-07-12T01:00:00Z",
                      updatedAt: "2026-07-12T02:00:00Z",
                      author: { login: "reviewer-one" },
                      pullRequestReview: { databaseId: 50 },
                      path: "src/ignored.ts",
                      diffHunk: "untrusted diff metadata",
                    }],
                  },
                },
                {
                  isResolved: true,
                  comments: {
                    nodes: [{
                      databaseId: 92,
                      body: "Already resolved",
                      createdAt: "2026-07-12T01:00:00Z",
                      updatedAt: "2026-07-12T02:00:00Z",
                      author: { login: "reviewer-two" },
                      pullRequestReview: { databaseId: 51 },
                    }],
                  },
                },
                {
                  isResolved: false,
                  comments: {
                    nodes: [{
                      databaseId: 93,
                      body: "Add a regression assertion.",
                      createdAt: "2026-07-12T03:00:00Z",
                      updatedAt: "2026-07-12T03:00:00Z",
                      author: { login: "reviewer-three" },
                      pullRequestReview: null,
                    }],
                  },
                },
              ],
            },
          },
        },
      },
    });
  });

  const comments = await client.listUnresolvedPullRequestReviewComments(
    "acme",
    "research-agent",
    9,
  );

  assert.deepEqual(comments, [
    {
      id: 91,
      authorLogin: "reviewer-one",
      body: "Please cover the restart case.",
      createdAt: "2026-07-12T01:00:00.000Z",
      updatedAt: "2026-07-12T02:00:00.000Z",
      reviewId: 50,
    },
    {
      id: 93,
      authorLogin: "reviewer-three",
      body: "Add a regression assertion.",
      createdAt: "2026-07-12T03:00:00.000Z",
      updatedAt: "2026-07-12T03:00:00.000Z",
      reviewId: null,
    },
  ]);
  assert.equal("path" in (comments[0] ?? {}), false);
  assert.equal(request?.url, "https://api.github.com/graphql");
  assert.equal(request?.method, "POST");
  const body = JSON.parse(String(request?.body));
  assert.match(body.query, /reviewThreads\(first: 50\)/);
  assert.match(body.query, /comments\(first: 1\)/);
  assert.doesNotMatch(body.query, /\bpath\b|diffHunk/);
  assert.deepEqual(body.variables, { owner: "acme", repository: "research-agent", number: 9 });
});

test("GitHubRestClient fails closed on GraphQL review errors and oversized thread results", async () => {
  const graphErrorClient = clientWith(async () => response(200, {
    errors: [{ message: "query failed" }],
    data: null,
  }));
  await assert.rejects(
    graphErrorClient.listUnresolvedPullRequestReviewComments("acme", "research-agent", 9),
    (error: unknown) => error instanceof GitHubApiError && error.code === "github_invalid_response",
  );

  const oversizedClient = clientWith(async () => response(200, {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array.from({ length: 51 }, () => ({ isResolved: true, comments: { nodes: [] } })),
          },
        },
      },
    },
  }));
  await assert.rejects(
    oversizedClient.listUnresolvedPullRequestReviewComments("acme", "research-agent", 9),
    (error: unknown) => error instanceof GitHubApiError && error.code === "github_invalid_response",
  );
});

test("GitHubRestClient always creates a draft pull request on an agent branch", async () => {
  let request: HttpRequest | undefined;
  const client = clientWith(async (input) => {
    request = input;
    return response(201, pullRequestPayload());
  });

  const pullRequest = await client.createDraftPullRequest({
    owner: "acme",
    repository: "research-agent",
    title: "Implement ENG-12",
    body: "Validated locally.",
    head: "codex/eng-12",
    base: "main",
  });

  assert.equal(pullRequest.draft, true);
  assert.equal(request?.url, "https://api.github.com/repos/acme/research-agent/pulls");
  assert.equal(request?.method, "POST");
  assert.deepEqual(JSON.parse(String(request?.body)), {
    title: "Implement ENG-12",
    body: "Validated locally.",
    head: "codex/eng-12",
    base: "main",
    draft: true,
  });
});

test("GitHubRestClient creates and updates only agent-owned refs without force", async () => {
  const requests: HttpRequest[] = [];
  const client = clientWith(async (request) => {
    requests.push(request);
    return response(200, referencePayload("refs/heads/codex/eng-12", SHA_B));
  });

  await client.createAgentBranch({ owner: "acme", repository: "research-agent", branch: "codex/eng-12", sha: SHA_A });
  await client.updateAgentBranchFastForward({ owner: "acme", repository: "research-agent", branch: "codex/eng-12", sha: SHA_B });

  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.url, "https://api.github.com/repos/acme/research-agent/git/refs");
  assert.deepEqual(JSON.parse(String(requests[0]?.body)), {
    ref: "refs/heads/codex/eng-12",
    sha: SHA_A,
  });
  assert.equal(requests[1]?.method, "PATCH");
  assert.equal(requests[1]?.url, "https://api.github.com/repos/acme/research-agent/git/refs/heads/codex/eng-12");
  assert.deepEqual(JSON.parse(String(requests[1]?.body)), { sha: SHA_B, force: false });

  await assert.rejects(
    client.updateAgentBranchFastForward({ owner: "acme", repository: "research-agent", branch: "main", sha: SHA_B }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "github_forbidden",
  );
  assert.equal(requests.length, 2);
});

test("GitHubRestClient verifies branch SHA before deleting an owned ref", async () => {
  const requests: HttpRequest[] = [];
  const client = clientWith(async (request) => {
    requests.push(request);
    if (request.method === "GET") return response(200, referencePayload("refs/heads/codex/eng-12", SHA_A));
    return response(204, undefined);
  });

  await client.deleteAgentBranch({
    owner: "acme",
    repository: "research-agent",
    branch: "codex/eng-12",
    expectedSha: SHA_A,
  });

  assert.deepEqual(requests.map((request) => request.method), ["GET", "DELETE"]);
  assert.equal(requests[1]?.url, "https://api.github.com/repos/acme/research-agent/git/refs/heads/codex/eng-12");
});

test("GitHubRestClient verifies pinned identity before updating or deleting comments", async () => {
  const requests: HttpRequest[] = [];
  const client = clientWith(async (request) => {
    requests.push(request);
    if (request.method === "GET") return response(200, commentPayload());
    if (request.method === "DELETE") return response(204, undefined);
    return response(200, { ...commentPayload(), body: "Updated" });
  });

  await client.updateIssueComment({
    owner: "acme",
    repository: "research-agent",
    commentId: 41,
    body: "Updated",
    expectedAuthorLogin: "agent-bot",
  });
  await client.deleteOwnedComment({
    owner: "acme",
    repository: "research-agent",
    commentId: 41,
    expectedAuthorLogin: "agent-bot",
    kind: "issue",
  });

  assert.deepEqual(requests.map((request) => request.method), ["GET", "PATCH", "GET", "DELETE"]);
  assert.equal(requests[1]?.url, "https://api.github.com/repos/acme/research-agent/issues/comments/41");
  assert.deepEqual(JSON.parse(String(requests[1]?.body)), { body: "Updated" });
});

test("GitHubRestClient refuses mutation when comment identity does not match", async () => {
  let requests = 0;
  const client = clientWith(async () => {
    requests += 1;
    return response(200, { ...commentPayload(), user: { id: 88, login: "someone-else" } });
  });

  await assert.rejects(
    client.deleteOwnedComment({
      owner: "acme",
      repository: "research-agent",
      commentId: 41,
      expectedAuthorLogin: "agent-bot",
      kind: "issue",
    }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "github_forbidden",
  );
  assert.equal(requests, 1);
});

test("GitHubRestClient merge primitive pins head SHA and squash method", async () => {
  let request: HttpRequest | undefined;
  const client = clientWith(async (input) => {
    request = input;
    return response(200, { sha: SHA_B, merged: true, message: "Pull Request successfully merged" });
  });

  const result = await client.mergePullRequestSquash({
    owner: "acme",
    repository: "research-agent",
    number: 12,
    expectedHeadSha: SHA_A,
    commitTitle: "Implement ENG-12",
  });

  assert.equal(result.merged, true);
  assert.equal(request?.method, "PUT");
  assert.equal(request?.url, "https://api.github.com/repos/acme/research-agent/pulls/12/merge");
  assert.deepEqual(JSON.parse(String(request?.body)), {
    sha: SHA_A,
    merge_method: "squash",
    commit_title: "Implement ENG-12",
  });
});

test("GitHubRestClient uses one fixed GraphQL mutation to mark a draft ready", async () => {
  const requests: HttpRequest[] = [];
  let readCount = 0;
  const client = clientWith(async (request) => {
    requests.push(request);
    if (request.url.endsWith("/graphql")) {
      return response(200, {
        data: {
          markPullRequestReadyForReview: {
            pullRequest: { id: "PR_kwDOAgentic12", isDraft: false },
          },
        },
      });
    }
    readCount += 1;
    return response(200, {
      ...pullRequestPayload(),
      draft: readCount === 1,
    });
  });

  const ready = await client.markPullRequestReadyForReview({
    owner: "acme",
    repository: "research-agent",
    number: 12,
  });

  assert.equal(ready.draft, false);
  assert.deepEqual(requests.map((request) => request.method), ["GET", "POST", "GET"]);
  const graphBody = JSON.parse(String(requests[1]?.body));
  assert.match(graphBody.query, /markPullRequestReadyForReview/);
  assert.deepEqual(graphBody.variables, { pullRequestId: "PR_kwDOAgentic12" });
});

test("GitHubRestClient mutation catalog uses fixed issue, review, reply, and rerun paths", async () => {
  const requests: HttpRequest[] = [];
  const client = clientWith(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/issues")) return response(201, issuePayload());
    if (path.endsWith("/issues/9/comments")) return response(201, commentPayload());
    if (path.endsWith("/pulls/9/reviews")) return response(200, reviewPayload());
    if (path.includes("/replies")) return response(201, reviewCommentPayload());
    return response(201, undefined);
  });

  await client.createIssue({ owner: "acme", repository: "research-agent", title: "Issue title", body: "Body" });
  await client.createIssueComment({ owner: "acme", repository: "research-agent", number: 9, body: "Comment" });
  await client.createPullRequestReview({
    owner: "acme",
    repository: "research-agent",
    number: 9,
    body: "Looks good",
    commitId: SHA_A,
    event: "APPROVE",
  });
  await client.replyToReviewComment({
    owner: "acme",
    repository: "research-agent",
    pullNumber: 9,
    commentId: 51,
    body: "Fixed locally",
  });
  await client.rerunFailedWorkflowJobs({ owner: "acme", repository: "research-agent", runId: 6 });

  assert.deepEqual(requests.map((request) => [request.method, new URL(request.url).pathname]), [
    ["POST", "/repos/acme/research-agent/issues"],
    ["POST", "/repos/acme/research-agent/issues/9/comments"],
    ["POST", "/repos/acme/research-agent/pulls/9/reviews"],
    ["POST", "/repos/acme/research-agent/pulls/9/comments/51/replies"],
    ["POST", "/repos/acme/research-agent/actions/runs/6/rerun-failed-jobs"],
  ]);
  assert.deepEqual(JSON.parse(String(requests[2]?.body)), {
    body: "Looks good",
    commit_id: SHA_A,
    event: "APPROVE",
  });
});

test("GitHubRestClient classifies and redacts authentication and transport failures", async () => {
  const apiClient = clientWith(async () =>
    response(401, { message: "Bad credentials secret-token github_pat_example" }),
  );
  await assert.rejects(apiClient.getRepository("acme", "research-agent"), (error: unknown) => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.code, "github_auth");
    assert.doesNotMatch(error.message, /secret-token|github_pat_example/);
    return true;
  });

  const transportClient = clientWith(async () => {
    throw new Error("socket failed for Bearer secret-token");
  });
  await assert.rejects(transportClient.getAuthenticatedUser(), (error: unknown) => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.code, "github_api");
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
});

function clientWith(transport: (request: HttpRequest) => Promise<HttpResponse>): GitHubRestClient {
  return new GitHubRestClient({ token: "secret-token", transport });
}

function repositoryPayload(): Record<string, unknown> {
  return {
    id: 1,
    full_name: "acme/research-agent",
    html_url: "https://github.com/acme/research-agent",
    default_branch: "main",
    private: true,
    archived: false,
  };
}

function referencePayload(ref: string, sha: string): Record<string, unknown> {
  return { ref, object: { type: "commit", sha } };
}

function actorPayload(): Record<string, unknown> {
  return { id: 77, login: "agent-bot" };
}

function issuePayload(): Record<string, unknown> {
  return {
    number: 9,
    html_url: "https://github.com/acme/research-agent/issues/9",
    state: "open",
    title: "Issue title",
    body: "Issue body",
    user: actorPayload(),
    created_at: "2026-07-12T00:00:00Z",
    updated_at: "2026-07-12T00:00:00Z",
  };
}

function commentPayload(): Record<string, unknown> {
  return {
    id: 41,
    html_url: "https://github.com/acme/research-agent/issues/9#issuecomment-41",
    body: "Comment body",
    user: actorPayload(),
    created_at: "2026-07-12T00:00:00Z",
    updated_at: "2026-07-12T00:00:00Z",
  };
}

function pullRequestPayload(): Record<string, unknown> {
  return {
    node_id: "PR_kwDOAgentic12",
    number: 12,
    html_url: "https://github.com/acme/research-agent/pull/12",
    state: "open",
    title: "Implement ENG-12",
    body: "Validated locally.",
    draft: true,
    merged: false,
    head: { ref: "codex/eng-12", sha: SHA_A },
    base: { ref: "main", sha: SHA_B },
    updated_at: "2026-07-12T00:00:00Z",
  };
}

function reviewPayload(): Record<string, unknown> {
  return {
    id: 50,
    html_url: "https://github.com/acme/research-agent/pull/9#pullrequestreview-50",
    state: "APPROVED",
    body: "Looks good",
    commit_id: SHA_A,
    user: actorPayload(),
    submitted_at: "2026-07-12T00:00:00Z",
  };
}

function reviewCommentPayload(): Record<string, unknown> {
  return {
    ...commentPayload(),
    id: 51,
    html_url: "https://github.com/acme/research-agent/pull/9#discussion_r51",
    path: "src/index.ts",
    line: 12,
    pull_request_review_id: 50,
  };
}

function response(status: number, json: unknown): HttpResponse {
  return { status, ...(json === undefined ? {} : { json }), headers: {} };
}
