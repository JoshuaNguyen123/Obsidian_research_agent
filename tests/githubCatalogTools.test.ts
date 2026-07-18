import assert from "node:assert/strict";
import test from "node:test";

import type { RepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import type { TrustedGitHubRepositoryBindingV1 } from "../src/integrations/github/TrustedGitHubRepositoryBindingV1";
import {
  GitHubApiError,
  type GitHubCommentRecord,
  type GitHubIssueRecord,
  type GitHubTreeRecord,
  type GitHubWorkflowRunRecord,
} from "../src/integrations/github/GitHubRestClient";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import {
  GITHUB_CATALOG_DESTRUCTIVE_TOOL_NAMES,
  GITHUB_CATALOG_MUTATION_TOOL_NAMES,
  GITHUB_CATALOG_READ_TOOL_NAMES,
  GITHUB_CATALOG_TOOL_OPERATION_MAP,
  createGitHubCatalogTools,
  getExplicitGitHubCatalogMutationToolNames,
  getGitHubCatalogReadToolNames,
  type GitHubCatalogRepositoryContextV1,
} from "../src/tools/githubCatalogTools";
import type { ActionReceipt, PreparedAction } from "../src/agent/actions";
import type { ToolExecutionContext } from "../src/tools/types";

const SHA_A = "a".repeat(40);
const FP_A = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;

test("GitHub catalog is fixed, closed, and excludes source edits, arbitrary transport, and merge", () => {
  const harness = createHarness();
  const tools = createGitHubCatalogTools(harness.options);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    Object.keys(GITHUB_CATALOG_TOOL_OPERATION_MAP).sort(),
  );
  assert.ok(GITHUB_CATALOG_READ_TOOL_NAMES.length >= 16);
  assert.ok(GITHUB_CATALOG_MUTATION_TOOL_NAMES.length >= 15);
  assert.deepEqual(GITHUB_CATALOG_DESTRUCTIVE_TOOL_NAMES, [
    "github_delete_owned_comment",
    "github_delete_owned_branch",
  ]);

  for (const tool of tools) {
    assert.equal(tool.parameters.additionalProperties, false, tool.name);
    const properties = Object.keys(tool.parameters.properties ?? {});
    for (const forbidden of ["owner", "repository", "token", "path", "endpoint", "url", "query", "graphql", "method"]) {
      assert.equal(properties.includes(forbidden), false, `${tool.name} exposes ${forbidden}`);
    }
  }
  assert.equal(tools.some((tool) => /contents|source_edit|force|merge/i.test(tool.name)), false);
});

test("GitHub traversal resolves the logical profile on the host and bounds untrusted provider data", async () => {
  const harness = createHarness();
  const registry = new DefaultToolRegistry(createGitHubCatalogTools(harness.options));
  const result = await registry.execute({
    name: "github_get_tree",
    arguments: { profileKey: "fixture", sha: SHA_A, recursive: true, maxEntries: 2 },
  }, context("Read the GitHub repository tree."));

  assert.equal(result.ok, true);
  assert.deepEqual(harness.profileKeys, ["fixture"]);
  assert.deepEqual(harness.treeRequests, [{ owner: "acme", repository: "research-agent", sha: SHA_A, recursive: true }]);
  const output = result.output as {
    source: string;
    authority: boolean;
    repository: { profileKey: string; fullName: string };
    result: { entries: unknown[]; modelTruncated: boolean };
  };
  assert.equal(output.source, "github_provider_untrusted");
  assert.equal(output.authority, false);
  assert.equal(output.repository.profileKey, "fixture");
  assert.equal(output.repository.fullName, "acme/research-agent");
  assert.equal(output.result.entries.length, 2);
  assert.equal(output.result.modelTruncated, true);
});

test("GitHub issue create requires preparation, exact authority, readback, and durable receipt persistence", async () => {
  const harness = createHarness();
  const registry = new DefaultToolRegistry(createGitHubCatalogTools(harness.options));
  const ctx = context("Create a GitHub issue in repository profile fixture.");
  const direct = await registry.execute({
    name: "github_create_issue",
    arguments: { profileKey: "fixture", title: "Catalog proof", body: "Verified through provider readback." },
  }, ctx);
  assert.equal(direct.ok, false);
  assert.equal(direct.error?.code, "prepared_action_required");

  const prepared = await registry.prepare!({
    name: "github_create_issue",
    arguments: { profileKey: "fixture", title: "Catalog proof", body: "Verified through provider readback." },
  }, ctx);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.action.target.id, "pending:issue");
  assert.equal(JSON.stringify(prepared.action.normalizedArgs).includes("token"), false);
  assert.equal(JSON.stringify(prepared.action.normalizedArgs).includes("C:\\"), false);

  const executed = await registry.executePrepared!(prepared.action, ctx, authorization(prepared.action));
  assert.equal(executed.ok, true);
  assert.equal(executed.mutationState, "applied");
  assert.equal(executed.receipt?.resource.id, "12");
  assert.equal(executed.receipt?.readback.status, "verified");
  assert.equal(harness.persisted.length, 1);
  assert.equal(harness.persisted[0]?.id, executed.receipt?.id);
});

test("ambiguous GitHub issue creation reconciles only one exact provider candidate and never redispatches", async () => {
  const harness = createHarness();
  const registry = new DefaultToolRegistry(createGitHubCatalogTools(harness.options));
  const ctx = context("Create a GitHub issue in repository profile fixture.");
  const prepared = await registry.prepare!({
    name: "github_create_issue",
    arguments: { profileKey: "fixture", title: "Recovered create", body: "Exact readback discriminator." },
  }, ctx);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  harness.simulateCreatedIssue("Recovered create", "Exact readback discriminator.");
  const reconciled = await registry.reconcile!(prepared.action, ctx);
  assert.equal(reconciled.outcome, "committed");
  assert.equal(reconciled.receipt?.resource.id, "13");
  assert.equal(reconciled.receipt?.commitKind, "reconciled");
  assert.equal(harness.createIssueDispatches, 0);
  assert.equal(harness.persisted.length, 1);
});

test("GitHub catalog rejects model-supplied repository coordinates before host resolution", async () => {
  const harness = createHarness();
  const registry = new DefaultToolRegistry(createGitHubCatalogTools(harness.options));
  const result = await registry.execute({
    name: "github_get_issue",
    arguments: {
      profileKey: "fixture",
      number: 7,
      owner: "attacker",
      repository: "escape",
      endpoint: "/user",
      token: "secret",
    },
  }, context("Read GitHub issue 7."));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "github_invalid_arguments");
  assert.equal(harness.profileKeys.length, 0);
});

test("owned GitHub comment deletion is fingerprinted exact-only and verifies absence", async () => {
  const harness = createHarness();
  const registry = new DefaultToolRegistry(createGitHubCatalogTools(harness.options));
  const ctx = context("Delete my GitHub issue comment 44.");
  const descriptor = registry.getDescriptor!("github_delete_owned_comment");
  assert.equal(descriptor?.effect, "destructive_mutation");
  assert.equal(descriptor?.approval.fallback, "exact");
  assert.equal(descriptor?.approval.allowPromptGrant, false);
  assert.equal(descriptor?.durability.readback, "required");
  assert.equal(descriptor?.durability.reconciliation, "required");

  const prepared = await registry.prepare!({
    name: "github_delete_owned_comment",
    arguments: { profileKey: "fixture", commentId: 44, kind: "issue" },
  }, ctx);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.action.requiredConfirmations, 1);
  const executed = await registry.executePrepared!(prepared.action, ctx, authorization(prepared.action));
  assert.equal(executed.ok, true);
  assert.equal(executed.receipt?.effects?.changedFields?.includes("deleted"), true);
  assert.equal(harness.deletedComments, 1);
});

test("GitHub intent routing selects bounded reads or the exact requested mutation", () => {
  assert.deepEqual(
    getGitHubCatalogReadToolNames("Read GitHub pull request 12 reviews and checks."),
    ["github_get_pull_request", "github_list_pull_request_reviews", "github_list_check_runs"],
  );
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames("Close GitHub issue 12."),
    ["github_close_issue"],
  );
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames("Rerun the failed GitHub workflow for this commit."),
    ["github_rerun_failed_workflow_jobs"],
  );
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames("Merge the GitHub pull request."),
    [],
  );
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames("Open GitHub issue 12 and summarize it."),
    [],
  );
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames(
      "Publish the commit to its agent-owned branch. Do not clean up or delete any provider resource.",
    ),
    [],
  );
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames(
      "Delete the agent-owned GitHub branch at its expected SHA.",
    ),
    ["github_delete_owned_branch"],
  );
});

test("workflow rerun receipt requires run_attempt advancement and otherwise remains reconcile-required", async () => {
  const verifiedHarness = createHarness();
  const verifiedRegistry = new DefaultToolRegistry(createGitHubCatalogTools(verifiedHarness.options));
  const ctx = context("Rerun failed GitHub workflow run 70 for the exact commit.");
  const prepared = await verifiedRegistry.prepare!({
    name: "github_rerun_failed_workflow_jobs",
    arguments: { profileKey: "fixture", runId: 70, headSha: SHA_A },
  }, ctx);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.action.preview.before?.runAttempt, 1);
  const executed = await verifiedRegistry.executePrepared!(prepared.action, ctx, authorization(prepared.action));
  assert.equal(executed.ok, true);
  assert.equal(executed.receipt?.effects?.changedFields?.includes("runAttempt"), true);

  const uncertainHarness = createHarness();
  uncertainHarness.setAdvanceWorkflowOnRerun(false);
  const uncertainRegistry = new DefaultToolRegistry(createGitHubCatalogTools(uncertainHarness.options));
  const uncertainPrepared = await uncertainRegistry.prepare!({
    name: "github_rerun_failed_workflow_jobs",
    arguments: { profileKey: "fixture", runId: 70, headSha: SHA_A },
  }, ctx);
  assert.equal(uncertainPrepared.ok, true);
  if (!uncertainPrepared.ok) return;
  const uncertainExecution = await uncertainRegistry.executePrepared!(uncertainPrepared.action, ctx, authorization(uncertainPrepared.action));
  assert.equal(uncertainExecution.ok, false);
  assert.equal(uncertainExecution.mutationState, "may_have_applied");
  assert.equal(uncertainExecution.error?.code, "github_readback_failed");
  const reconciliation = await uncertainRegistry.reconcile!(uncertainPrepared.action, ctx);
  assert.equal(reconciliation.outcome, "still_uncertain");
  assert.match(reconciliation.message, /run_attempt/u);
  assert.equal(uncertainHarness.persisted.length, 0);
});

function createHarness() {
  let issue: GitHubIssueRecord = issueRecord(7, "Existing issue", "Before");
  let comment: GitHubCommentRecord | null = commentRecord(44, "Owned comment");
  let workflowRun: GitHubWorkflowRunRecord = {
    id: 70,
    name: "CI",
    htmlUrl: "https://github.com/acme/research-agent/actions/runs/70",
    status: "completed",
    conclusion: "failure",
    headSha: SHA_A,
    event: "pull_request",
    runAttempt: 1,
    updatedAt: "2026-07-13T12:00:00.000Z",
  };
  let advanceWorkflowOnRerun = true;
  const persisted: ActionReceipt[] = [];
  const profileKeys: string[] = [];
  const treeRequests: Array<{ owner: string; repository: string; sha: string; recursive: boolean }> = [];
  let deletedComments = 0;
  let createIssueDispatches = 0;
  const tree: GitHubTreeRecord = {
    sha: SHA_A,
    truncated: false,
    entries: [0, 1, 2].map((index) => ({
      path: `src/file-${index}.ts`,
      mode: "100644",
      type: "blob" as const,
      sha: String(index + 1).repeat(40),
      size: 10,
    })),
  };

  const client = {
    async getRepository() {
      return { id: 99, fullName: "acme/research-agent", htmlUrl: "https://github.com/acme/research-agent", defaultBranch: "main", private: true, archived: false };
    },
    async getReference(_owner: string, _repository: string, branch: string) {
      return { ref: `refs/heads/${branch}`, sha: SHA_A, objectType: "commit" };
    },
    async getCommit() {
      return { sha: SHA_A, message: "fixture", treeSha: SHA_A };
    },
    async getTree(owner: string, repository: string, sha: string, recursive: boolean) {
      treeRequests.push({ owner, repository, sha, recursive });
      return tree;
    },
    async getBlob() {
      return { sha: SHA_A, encoding: "utf-8" as const, size: 5, content: "hello" };
    },
    async getIssue(_owner: string, _repository: string, number: number) {
      if (number !== issue.number) throw new GitHubApiError("github_not_found", "issue missing", 404);
      return { ...issue };
    },
    async listIssues() { return [{ ...issue }]; },
    async getIssueComment(_owner: string, _repository: string, commentId: number) {
      if (!comment || comment.id !== commentId) throw new GitHubApiError("github_not_found", "comment missing", 404);
      return { ...comment };
    },
    async listIssueComments() { return comment ? [{ ...comment }] : []; },
    async getPullRequest() { return pullRequestRecord(); },
    async listPullRequestsForHead() { return [pullRequestRecord()]; },
    async listPullRequestReviews() { return []; },
    async getReviewComment() { return { ...commentRecord(55, "review"), path: "src/a.ts" }; },
    async listPullRequestReviewComments() { return []; },
    async listCheckRuns() { return []; },
    async getCombinedStatus() { return { state: "success", sha: SHA_A, totalCount: 0, statuses: [] }; },
    async listWorkflowRunsForCommit(_owner: string, _repository: string, headSha: string) {
      return headSha === workflowRun.headSha ? [{ ...workflowRun }] : [];
    },
    async createIssue(input: { title: string; body: string }) {
      createIssueDispatches += 1;
      issue = issueRecord(12, input.title, input.body);
      return { ...issue };
    },
    async updateIssue(input: { title?: string; body?: string; state?: "open" | "closed" }) {
      issue = { ...issue, ...(input.title === undefined ? {} : { title: input.title }), ...(input.body === undefined ? {} : { body: input.body }), ...(input.state === undefined ? {} : { state: input.state }) };
      return { ...issue };
    },
    async closeIssue() { issue = { ...issue, state: "closed" }; return { ...issue }; },
    async reopenIssue() { issue = { ...issue, state: "open" }; return { ...issue }; },
    async createIssueComment(input: { body: string }) { comment = commentRecord(45, input.body); return { ...comment }; },
    async updateIssueComment(input: { body: string }) { if (!comment) throw new Error("missing"); comment = { ...comment, body: input.body }; return { ...comment }; },
    async updateReviewComment(input: { body: string }) { return { ...commentRecord(55, input.body), path: "src/a.ts" }; },
    async deleteOwnedComment() { deletedComments += 1; comment = null; },
    async createPullRequestReview() { return { id: 1, htmlUrl: "https://github.test/review/1", state: "COMMENTED", body: "", commitId: SHA_A, author: { id: 42, login: "agent-user" }, submittedAt: "2026-07-13T12:00:00.000Z" }; },
    async replyToReviewComment(input: { body: string }) { return { ...commentRecord(56, input.body), path: "src/a.ts" }; },
    async updatePullRequest() { return pullRequestRecord(); },
    async closePullRequest() { return { ...pullRequestRecord(), state: "closed" as const }; },
    async reopenPullRequest() { return pullRequestRecord(); },
    async rerunFailedWorkflowJobs() {
      if (advanceWorkflowOnRerun) {
        const { conclusion: _conclusion, ...current } = workflowRun;
        workflowRun = {
          ...current,
          status: "queued",
          runAttempt: workflowRun.runAttempt + 1,
          updatedAt: "2026-07-13T12:05:00.000Z",
        };
      }
    },
    async deleteAgentBranch() {},
  } as GitHubCatalogRepositoryContextV1["client"];

  const repository: GitHubCatalogRepositoryContextV1 = {
    client,
    binding: binding(),
    profile: {} as RepositoryProfileV2,
  };
  const options = {
    async withRepository<T>(profileKey: string, _signal: AbortSignal | undefined, use: (value: GitHubCatalogRepositoryContextV1) => Promise<T>) {
      profileKeys.push(profileKey);
      return use(repository);
    },
    async persistExternalReceipt(receipt: ActionReceipt) { persisted.push(receipt); },
    isAvailable() { return true; },
  };
  return {
    options,
    profileKeys,
    treeRequests,
    persisted,
    simulateCreatedIssue(title: string, body: string) {
      issue = issueRecord(13, title, body);
    },
    get createIssueDispatches() { return createIssueDispatches; },
    setAdvanceWorkflowOnRerun(value: boolean) { advanceWorkflowOnRerun = value; },
    get deletedComments() { return deletedComments; },
  };
}

function binding(): TrustedGitHubRepositoryBindingV1 {
  return {
    version: 1,
    key: "github-fixture",
    repositoryProfileKey: "fixture",
    repositoryProfileFingerprint: FP_B,
    canonicalRepositoryRoot: "C:\\fixtures\\research-agent",
    githubHost: "github.com",
    owner: "acme",
    repository: "research-agent",
    repositoryId: 99,
    defaultBranch: "main",
    remoteName: "origin",
    agentBranchPrefix: "codex/",
    verifiedAccountId: 42,
    verifiedAccountLogin: "agent-user",
    trustedAt: "2026-07-13T12:00:00.000Z",
    fingerprint: FP_A,
  };
}

function issueRecord(number: number, title: string, body: string): GitHubIssueRecord {
  return {
    number,
    htmlUrl: `https://github.com/acme/research-agent/issues/${number}`,
    state: "open",
    title,
    body,
    author: { id: 42, login: "agent-user" },
    pullRequest: false,
    createdAt: "2026-07-13T12:05:00.000Z",
    updatedAt: "2026-07-13T12:05:00.000Z",
  };
}

function commentRecord(id: number, body: string): GitHubCommentRecord {
  return {
    id,
    htmlUrl: `https://github.com/acme/research-agent/issues/comments/${id}`,
    body,
    author: { id: 42, login: "agent-user" },
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
  };
}

function pullRequestRecord() {
  return {
    nodeId: "PR_kwDOfixture",
    number: 9,
    htmlUrl: "https://github.com/acme/research-agent/pull/9",
    state: "open" as const,
    title: "Fixture PR",
    body: "Fixture body",
    draft: true,
    merged: false,
    head: { ref: "codex/fixture", sha: SHA_A },
    base: { ref: "main", sha: SHA_A },
    updatedAt: "2026-07-13T12:00:00.000Z",
  };
}

function context(originalPrompt: string): ToolExecutionContext {
  return {
    app: {} as never,
    settings: { githubEnabled: true } as never,
    originalPrompt,
    runId: "run-github-catalog",
    operationId: "call-github-catalog",
    httpTransport: async () => ({ status: 500, headers: {} }),
    now: () => new Date("2026-07-13T12:05:00.000Z"),
  };
}

function authorization(action: PreparedAction) {
  return {
    preparedActionId: action.id,
    payloadFingerprint: action.payloadFingerprint,
    grantId: "grant-github-catalog",
  };
}
