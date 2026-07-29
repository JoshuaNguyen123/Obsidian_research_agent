import assert from "node:assert/strict";
import test from "node:test";

import type { RepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import type { TrustedGitHubRepositoryBindingV1 } from "../src/integrations/github/TrustedGitHubRepositoryBindingV1";
import {
  GitHubApiError,
  type GitHubCommentRecord,
  type GitHubIssueRecord,
  type GitHubPullRequestRecord,
  type GitHubRepositoryRecord,
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
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const FP_A = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;

test("GitHub catalog is fixed, closed, and excludes raw source edits, arbitrary transport, and force pushes", () => {
  const harness = createHarness();
  const tools = createGitHubCatalogTools(harness.options);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    Object.keys(GITHUB_CATALOG_TOOL_OPERATION_MAP).sort(),
  );
  assert.ok(GITHUB_CATALOG_READ_TOOL_NAMES.length >= 24);
  assert.ok(GITHUB_CATALOG_MUTATION_TOOL_NAMES.length >= 20);
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
  assert.equal(tools.some((tool) => /contents|source_edit|force/i.test(tool.name)), false);
  const merge = tools.find((tool) => tool.name === "github_merge_pull_request")?.descriptor;
  assert.equal(merge?.effect, "publish");
  assert.equal(merge?.risk, "critical");
  assert.equal(merge?.approval.fallback, "double_exact");
  assert.equal(merge?.approval.allowPromptGrant, true);
  assert.equal(merge?.approval.allowPersistentGrant, false);
  const ordinary = tools.find((tool) => tool.name === "github_update_issue")?.descriptor;
  assert.equal(ordinary?.approval.fallback, "exact");
  for (const name of GITHUB_CATALOG_MUTATION_TOOL_NAMES) {
    const descriptor = tools.find((tool) => tool.name === name)?.descriptor;
    assert.equal(descriptor?.approval.allowPromptGrant, true, name);
    assert.equal(descriptor?.approval.allowPersistentGrant, false, name);
  }
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
    repository: {
      profileKey: string;
      fullName: string;
      verifiedAccountId: number;
      verifiedAccountLogin: string;
      capabilities: { permissionsVerified: boolean; rawSourceEditTools: boolean; permissions: { push: boolean } };
    };
    result: { entries: unknown[]; modelTruncated: boolean };
  };
  assert.equal(output.source, "github_provider_untrusted");
  assert.equal(output.authority, false);
  assert.equal(output.repository.profileKey, "fixture");
  assert.equal(output.repository.fullName, "acme/research-agent");
  assert.equal(output.repository.verifiedAccountId, 42);
  assert.equal(output.repository.verifiedAccountLogin, "agent-user");
  assert.equal(output.repository.capabilities.permissionsVerified, true);
  assert.equal(output.repository.capabilities.permissions.push, true);
  assert.equal(output.repository.capabilities.rawSourceEditTools, false);
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
  assert.equal(descriptor?.approval.fallback, "double_exact");
  assert.equal(descriptor?.approval.allowPromptGrant, true);
  assert.equal(descriptor?.durability.readback, "required");
  assert.equal(descriptor?.durability.reconciliation, "required");

  const prepared = await registry.prepare!({
    name: "github_delete_owned_comment",
    arguments: { profileKey: "fixture", commentId: 44, kind: "issue" },
  }, ctx);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.action.requiredConfirmations, 2);
  const executed = await registry.executePrepared!(prepared.action, ctx, authorization(prepared.action));
  assert.equal(executed.ok, true);
  assert.equal(executed.receipt?.effects?.changedFields?.includes("deleted"), true);
  assert.equal(harness.deletedComments, 1);
});

test("GitHub intent routing selects bounded reads or the exact requested mutation", () => {
  assert.deepEqual(
    getGitHubCatalogReadToolNames("Read GitHub pull request 12 reviews and checks."),
    ["github_list_pull_request_reviews", "github_list_check_runs"],
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
    ["github_merge_pull_request"],
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
  assert.deepEqual(
    getGitHubCatalogReadToolNames("List the branches for the trusted GitHub repository."),
    ["github_list_branches"],
  );
  assert.deepEqual(
    getGitHubCatalogReadToolNames("Read the files changed in GitHub PR 9."),
    ["github_list_pull_request_files"],
  );
  assert.deepEqual(
    getGitHubCatalogReadToolNames("List jobs for GitHub workflow run 70."),
    ["github_list_workflow_jobs"],
  );
  const byokResearchPhase = [
    "Deeply research a Python CRDT library.",
    "The Linear issue contract must cover observed-remove tags and implementation behavior.",
    "Do not implement code or publish to GitHub in this phase.",
  ].join(" ");
  assert.deepEqual(getGitHubCatalogReadToolNames(byokResearchPhase), []);
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames(byokResearchPhase),
    [],
  );
  assert.deepEqual(
    getGitHubCatalogReadToolNames(
      "Review and implement Linear issue issue-1. Publish the tested commit to the issue-bound private GitHub destination as one open draft pull request.",
    ),
    [],
  );
  const byokImplementationPhase = [
    "Review and implement Linear issue issue-1.",
    "Publish the exact behaviorally tested commit to the issue-bound private GitHub destination as one open draft pull request; never merge it.",
  ].join(" ");
  assert.deepEqual(getGitHubCatalogReadToolNames(byokImplementationPhase), []);
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames(byokImplementationPhase),
    [],
  );
  assert.deepEqual(
    getGitHubCatalogReadToolNames(
      "Without changing anything, read GitHub issue 12.",
    ),
    ["github_get_issue"],
  );
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames(
      "Without changing anything, read GitHub issue 12.",
    ),
    [],
  );
  assert.deepEqual(
    getGitHubCatalogReadToolNames(
      "Inspect GitHub issue 12 without changing it.",
    ),
    ["github_get_issue"],
  );
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames(
      "Inspect GitHub issue 12 without changing it.",
    ),
    [],
  );
  assert.deepEqual(
    getGitHubCatalogReadToolNames(
      "Review GitHub pull request 9 without merging it.",
    ),
    ["github_list_pull_request_reviews"],
  );
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames(
      "Review GitHub pull request 9 without merging it.",
    ),
    [],
  );
  assert.deepEqual(
    getGitHubCatalogReadToolNames("Do not read GitHub issue 12."),
    [],
  );
  assert.deepEqual(
    getGitHubCatalogReadToolNames("List GitHub review comments on PR 9."),
    ["github_list_pull_request_review_comments"],
  );
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames("Create a draft GitHub pull request."),
    ["github_create_draft_pull_request"],
  );
  assert.deepEqual(
    getExplicitGitHubCatalogMutationToolNames("Mark GitHub pull request 9 ready for review."),
    ["github_mark_pull_request_ready"],
  );
});

test("GitHub discovery reads are bounded, exclude pull requests from issues, and use fresh repository capabilities", async () => {
  const harness = createHarness();
  const registry = new DefaultToolRegistry(createGitHubCatalogTools(harness.options));
  const ctx = context("Inspect bounded GitHub repository state.");
  const issues = await registry.execute({
    name: "github_list_issues",
    arguments: { profileKey: "fixture", limit: 10 },
  }, ctx);
  assert.equal(issues.ok, true);
  const issueOutput = issues.output as { result: { records: GitHubIssueRecord[] } };
  assert.equal(issueOutput.result.records.length, 1);
  assert.equal(issueOutput.result.records[0]?.pullRequest, false);

  for (const request of [
    { name: "github_list_branches", arguments: { profileKey: "fixture", limit: 1 } },
    { name: "github_list_tags", arguments: { profileKey: "fixture", limit: 1 } },
    { name: "github_list_releases", arguments: { profileKey: "fixture", limit: 1 } },
    { name: "github_get_release", arguments: { profileKey: "fixture", releaseId: 3 } },
    { name: "github_list_pull_request_files", arguments: { profileKey: "fixture", number: 9, limit: 1 } },
    { name: "github_get_workflow_run", arguments: { profileKey: "fixture", runId: 70 } },
    { name: "github_list_workflow_jobs", arguments: { profileKey: "fixture", runId: 70, limit: 1 } },
  ] as const) {
    const result = await registry.execute(request, ctx);
    assert.equal(result.ok, true, request.name);
  }
});

test("GitHub mutations fail closed without discovered permissions and reads reject explicit pull denial", async () => {
  const harness = createHarness();
  const registry = new DefaultToolRegistry(createGitHubCatalogTools(harness.options));
  harness.setPermissions(undefined);
  const prepared = await registry.prepare!({
    name: "github_create_issue",
    arguments: { profileKey: "fixture", title: "Denied", body: "No permission proof." },
  }, context("Create a GitHub issue."));
  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.equal(prepared.error.code, "github_permissions_unavailable");

  harness.setPermissions({ admin: false, maintain: false, push: false, triage: false, pull: false });
  const read = await registry.execute({
    name: "github_get_repository",
    arguments: { profileKey: "fixture" },
  }, context("Read the GitHub repository."));
  assert.equal(read.ok, false);
  assert.equal(read.error?.code, "github_permission_denied");
});

test("GitHub issue state mutations reject pull requests returned by the shared issues endpoint", async () => {
  const harness = createHarness();
  harness.setIssuePullRequest(true);
  const registry = new DefaultToolRegistry(createGitHubCatalogTools(harness.options));
  const prepared = await registry.prepare!({
    name: "github_close_issue",
    arguments: { profileKey: "fixture", number: 7 },
  }, context("Close GitHub issue 7."));
  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.equal(prepared.error.code, "github_issue_is_pull_request");
});

test("GitHub agent branch creation and exact non-force fast-forward verify state and receipts", async () => {
  const harness = createHarness();
  const registry = new DefaultToolRegistry(createGitHubCatalogTools(harness.options));
  const create = await registry.prepare!({
    name: "github_create_agent_branch",
    arguments: { profileKey: "fixture", branch: "codex/checkers", sha: SHA_B },
  }, context("Create the GitHub agent branch codex/checkers."));
  assert.equal(create.ok, true);
  if (!create.ok) return;
  assert.equal(create.action.requiredConfirmations, 2);
  const created = await registry.executePrepared!(create.action, context("Create the GitHub agent branch codex/checkers."), authorization(create.action));
  assert.equal(created.ok, true);
  assert.equal(harness.branchSha("codex/checkers"), SHA_B);
  assert.equal(created.receipt?.effects?.changedFields?.includes("sha"), true);

  const update = await registry.prepare!({
    name: "github_update_agent_branch_fast_forward",
    arguments: { profileKey: "fixture", branch: "codex/checkers", expectedSha: SHA_B, newSha: SHA_C },
  }, context("Fast-forward the GitHub agent branch codex/checkers."));
  assert.equal(update.ok, true);
  if (!update.ok) return;
  const updated = await registry.executePrepared!(update.action, context("Fast-forward the GitHub agent branch codex/checkers."), authorization(update.action));
  assert.equal(updated.ok, true);
  assert.equal(harness.branchSha("codex/checkers"), SHA_C);
});

test("GitHub draft pull request, ready transition, and exact-head merge form a verified publication chain", async () => {
  const harness = createHarness();
  harness.setBranch("codex/checkers", SHA_B);
  const registry = new DefaultToolRegistry(createGitHubCatalogTools(harness.options));
  const draft = await registry.prepare!({
    name: "github_create_draft_pull_request",
    arguments: { profileKey: "fixture", title: "Build checkers", body: "Verified implementation.", head: "codex/checkers", base: "main" },
  }, context("Create a draft GitHub pull request for checkers."));
  assert.equal(draft.ok, true);
  if (!draft.ok) return;
  assert.equal(draft.action.requiredConfirmations, 2);
  const drafted = await registry.executePrepared!(draft.action, context("Create a draft GitHub pull request for checkers."), authorization(draft.action));
  assert.equal(drafted.ok, true);
  const pullNumber = Number(drafted.receipt?.resource.id);
  assert.ok(pullNumber > 9);

  const ready = await registry.prepare!({
    name: "github_mark_pull_request_ready",
    arguments: { profileKey: "fixture", number: pullNumber },
  }, context("Mark the GitHub pull request ready for review."));
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  const madeReady = await registry.executePrepared!(ready.action, context("Mark the GitHub pull request ready for review."), authorization(ready.action));
  assert.equal(madeReady.ok, true);
  assert.equal(harness.pullRequest(pullNumber)?.draft, false);

  const merge = await registry.prepare!({
    name: "github_merge_pull_request",
    arguments: { profileKey: "fixture", number: pullNumber, expectedHeadSha: SHA_B, mergeMethod: "squash" },
  }, context("Squash merge the exact GitHub pull request head."));
  assert.equal(merge.ok, true);
  if (!merge.ok) return;
  assert.equal(merge.action.requiredConfirmations, 2);
  const merged = await registry.executePrepared!(merge.action, context("Squash merge the exact GitHub pull request head."), authorization(merge.action));
  assert.equal(merged.ok, true);
  assert.equal(harness.pullRequest(pullNumber)?.merged, true);
  assert.equal(merged.receipt?.effects?.changedFields?.includes("mergeSha"), true);
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
  const branches = new Map<string, string>([
    ["main", SHA_A],
    ["codex/fixture", SHA_A],
  ]);
  const pullRequests = new Map<number, GitHubPullRequestRecord>([
    [9, pullRequestRecord()],
  ]);
  let nextPullNumber = 10;
  let repositoryReadback: GitHubRepositoryRecord = repositoryRecord();
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
      return { ...repositoryReadback };
    },
    async getReference(_owner: string, _repository: string, branch: string) {
      const sha = branches.get(branch);
      if (!sha) throw new GitHubApiError("github_not_found", "reference missing", 404);
      return { ref: `refs/heads/${branch}`, sha, objectType: "commit" };
    },
    async listBranches() {
      return [...branches].map(([name, sha]) => ({ name, sha, protected: name === "main" }));
    },
    async listTags() {
      return [{ name: "v1.0.0", sha: SHA_A }];
    },
    async listReleases() {
      return [releaseRecord()];
    },
    async getRelease(_owner: string, _repository: string, releaseId: number) {
      if (releaseId !== 3) throw new GitHubApiError("github_not_found", "release missing", 404);
      return releaseRecord();
    },
    async getCommit(_owner: string, _repository: string, sha: string) {
      return { sha, message: "fixture", treeSha: sha };
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
    async listIssues() {
      return [
        { ...issue },
        { ...issueRecord(9, "PR-shaped issue", "Excluded"), pullRequest: true },
      ];
    },
    async getIssueComment(_owner: string, _repository: string, commentId: number) {
      if (!comment || comment.id !== commentId) throw new GitHubApiError("github_not_found", "comment missing", 404);
      return { ...comment };
    },
    async listIssueComments() { return comment ? [{ ...comment }] : []; },
    async getPullRequest(_owner: string, _repository: string, number: number) {
      const pull = pullRequests.get(number);
      if (!pull) throw new GitHubApiError("github_not_found", "pull request missing", 404);
      return structuredClone(pull);
    },
    async listPullRequestFiles() {
      return [{ sha: SHA_A, filename: "src/game.ts", status: "modified" as const, additions: 4, deletions: 1, changes: 5, patch: "@@ fixture @@", patchTruncated: false }];
    },
    async listPullRequestsForHead(_owner: string, _repository: string, head: string, base: string) {
      return [...pullRequests.values()]
        .filter((pull) => pull.head.ref === head && pull.base.ref === base)
        .map((pull) => structuredClone(pull));
    },
    async listPullRequestReviews() { return []; },
    async getReviewComment() { return { ...commentRecord(55, "review"), path: "src/a.ts" }; },
    async listPullRequestReviewComments() { return []; },
    async listCheckRuns() { return []; },
    async getCombinedStatus() { return { state: "success", sha: SHA_A, totalCount: 0, statuses: [] }; },
    async listWorkflowRunsForCommit(_owner: string, _repository: string, headSha: string) {
      return headSha === workflowRun.headSha ? [{ ...workflowRun }] : [];
    },
    async getWorkflowRun(_owner: string, _repository: string, runId: number) {
      if (runId !== workflowRun.id) throw new GitHubApiError("github_not_found", "workflow missing", 404);
      return { ...workflowRun };
    },
    async listWorkflowJobs(_owner: string, _repository: string, runId: number) {
      if (runId !== workflowRun.id) return [];
      return [{ id: 71, runId, name: "test", htmlUrl: "https://github.com/acme/research-agent/actions/jobs/71", status: "completed", conclusion: "failure", headSha: workflowRun.headSha }];
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
    async createAgentBranch(input: { branch: string; sha: string }) {
      if (branches.has(input.branch)) throw new GitHubApiError("github_conflict", "branch exists", 422);
      branches.set(input.branch, input.sha);
      return { ref: `refs/heads/${input.branch}`, sha: input.sha, objectType: "commit" };
    },
    async updateAgentBranchFastForward(input: { branch: string; sha: string }) {
      if (!branches.has(input.branch)) throw new GitHubApiError("github_not_found", "branch missing", 404);
      branches.set(input.branch, input.sha);
      return { ref: `refs/heads/${input.branch}`, sha: input.sha, objectType: "commit" };
    },
    async createDraftPullRequest(input: { title: string; body: string; head: string; base: string }) {
      const headSha = branches.get(input.head);
      const baseSha = branches.get(input.base);
      if (!headSha || !baseSha) throw new GitHubApiError("github_not_found", "branch missing", 404);
      const pull = pullRequestRecord({
        number: nextPullNumber++,
        title: input.title,
        body: input.body,
        head: { ref: input.head, sha: headSha },
        base: { ref: input.base, sha: baseSha },
        updatedAt: "2026-07-13T12:05:00.000Z",
      });
      pullRequests.set(pull.number, pull);
      return structuredClone(pull);
    },
    async markPullRequestReadyForReview(input: { number: number }) {
      const pull = requiredPull(pullRequests, input.number);
      const updated = { ...pull, draft: false, updatedAt: "2026-07-13T12:05:00.000Z" };
      pullRequests.set(input.number, updated);
      return structuredClone(updated);
    },
    async updatePullRequest(input: { number: number; title?: string; body?: string }) {
      const pull = requiredPull(pullRequests, input.number);
      const updated = { ...pull, ...(input.title === undefined ? {} : { title: input.title }), ...(input.body === undefined ? {} : { body: input.body }) };
      pullRequests.set(input.number, updated);
      return structuredClone(updated);
    },
    async closePullRequest(input: { number: number }) {
      const updated = { ...requiredPull(pullRequests, input.number), state: "closed" as const };
      pullRequests.set(input.number, updated);
      return structuredClone(updated);
    },
    async reopenPullRequest(input: { number: number }) {
      const updated = { ...requiredPull(pullRequests, input.number), state: "open" as const };
      pullRequests.set(input.number, updated);
      return structuredClone(updated);
    },
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
    async mergePullRequest(input: { number: number; expectedHeadSha: string }) {
      const pull = requiredPull(pullRequests, input.number);
      if (pull.head.sha !== input.expectedHeadSha) throw new GitHubApiError("github_conflict", "head changed", 409);
      const updated = { ...pull, state: "closed" as const, merged: true, mergeSha: SHA_C, updatedAt: "2026-07-13T12:05:00.000Z" };
      pullRequests.set(input.number, updated);
      return { sha: SHA_C, merged: true, message: "merged" };
    },
    async deleteAgentBranch(input: { branch: string; expectedSha: string }) {
      if (branches.get(input.branch) !== input.expectedSha) throw new GitHubApiError("github_conflict", "head changed", 409);
      branches.delete(input.branch);
    },
  } as unknown as GitHubCatalogRepositoryContextV1["client"];

  const repository: GitHubCatalogRepositoryContextV1 = {
    client,
    binding: binding(),
    profile: {} as RepositoryProfileV2,
    repositoryReadback,
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
    setPermissions(value: GitHubRepositoryRecord["permissions"]) {
      repositoryReadback = { ...repositoryReadback, permissions: value };
      repository.repositoryReadback = repositoryReadback;
    },
    setIssuePullRequest(value: boolean) { issue = { ...issue, pullRequest: value }; },
    setBranch(branch: string, sha: string) { branches.set(branch, sha); },
    branchSha(branch: string) { return branches.get(branch); },
    pullRequest(number: number) { return pullRequests.get(number); },
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

function repositoryRecord(): GitHubRepositoryRecord {
  return {
    id: 99,
    fullName: "acme/research-agent",
    htmlUrl: "https://github.com/acme/research-agent",
    defaultBranch: "main",
    private: true,
    archived: false,
    visibility: "private",
    hasIssues: true,
    permissions: {
      admin: true,
      maintain: true,
      push: true,
      triage: true,
      pull: true,
    },
  };
}

function releaseRecord() {
  return {
    id: 3,
    tagName: "v1.0.0",
    targetCommitish: "main",
    name: "Fixture release",
    body: "Release notes",
    bodyTruncated: false,
    draft: false,
    prerelease: false,
    immutable: false,
    htmlUrl: "https://github.com/acme/research-agent/releases/tag/v1.0.0",
    author: { id: 42, login: "agent-user" },
    createdAt: "2026-07-13T12:00:00.000Z",
    publishedAt: "2026-07-13T12:00:00.000Z",
  };
}

function pullRequestRecord(overrides: Partial<GitHubPullRequestRecord> = {}): GitHubPullRequestRecord {
  const number = overrides.number ?? 9;
  return {
    nodeId: `PR_kwDOfixture${number}`,
    number,
    htmlUrl: `https://github.com/acme/research-agent/pull/${number}`,
    state: "open" as const,
    title: "Fixture PR",
    body: "Fixture body",
    draft: true,
    merged: false,
    head: { ref: "codex/fixture", sha: SHA_A },
    base: { ref: "main", sha: SHA_A },
    updatedAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

function requiredPull(
  pullRequests: Map<number, GitHubPullRequestRecord>,
  number: number,
): GitHubPullRequestRecord {
  const pull = pullRequests.get(number);
  if (!pull) throw new GitHubApiError("github_not_found", "pull request missing", 404);
  return pull;
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
