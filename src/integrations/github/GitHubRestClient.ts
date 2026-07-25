import type { HttpResponse, HttpTransport } from "../../model/types";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/;
const SHA_PATTERN = /^[a-fA-F0-9]{40}$/;
const AGENT_BRANCH_PREFIX = "codex/";
const MAX_LIST_RECORDS = 100;
const MAX_TREE_RECORDS = 5_000;
const MAX_BLOB_CONTENT_CHARS = 3_000_000;
const MAX_RELEASE_BODY_CHARS = 65_536;
const MAX_PULL_REQUEST_PATCH_CHARS = 20_000;
const MAX_PROVIDER_NAME_CHARS = 1_024;
const MAX_PROVIDER_PATH_CHARS = 4_096;
const MAX_PROVIDER_URL_CHARS = 4_096;

export type GitHubApiErrorCode =
  | "github_not_configured"
  | "github_auth"
  | "github_forbidden"
  | "github_not_found"
  | "github_conflict"
  | "github_rate_limited"
  | "github_api"
  | "github_invalid_response";

export class GitHubApiError extends Error {
  constructor(
    readonly code: GitHubApiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubAuthenticatedUserRecord {
  id: number;
  login: string;
  htmlUrl: string;
  name?: string;
}

export interface GitHubRepositoryRecord {
  id: number;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  visibility?: "private" | "public" | "internal";
  description?: string;
  language?: string;
  topics?: string[];
  hasIssues?: boolean;
  permissions?: {
    admin: boolean;
    maintain: boolean;
    push: boolean;
    triage: boolean;
    pull: boolean;
  };
}

export interface CreatePrivateGitHubRepositoryInput {
  ownerKind: "user" | "organization";
  owner: string;
  repository: string;
  description?: string;
}

export interface GitHubReferenceRecord {
  ref: string;
  sha: string;
  objectType: string;
}

export interface GitHubBranchRecord {
  name: string;
  sha: string;
  protected: boolean;
}

export interface GitHubTagRecord {
  name: string;
  sha: string;
}

export interface GitHubReleaseRecord {
  id: number;
  tagName: string;
  targetCommitish: string;
  name: string;
  body: string;
  bodyTruncated: boolean;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  htmlUrl: string;
  author: GitHubActorRecord;
  createdAt: string;
  publishedAt?: string;
}

export interface GitHubCommitRecord {
  sha: string;
  message: string;
  treeSha: string;
  authorName?: string;
  authorEmail?: string;
}

export interface GitHubTreeEntryRecord {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface GitHubTreeRecord {
  sha: string;
  truncated: boolean;
  entries: GitHubTreeEntryRecord[];
}

export interface GitHubBlobRecord {
  sha: string;
  encoding: "base64" | "utf-8";
  size: number;
  content: string;
}

export interface GitHubActorRecord {
  id: number;
  login: string;
}

export interface GitHubIssueRecord {
  number: number;
  htmlUrl: string;
  state: "open" | "closed";
  title: string;
  body: string;
  author: GitHubActorRecord;
  pullRequest: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface GitHubCommentRecord {
  id: number;
  htmlUrl: string;
  body: string;
  author: GitHubActorRecord;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPullRequestRecord {
  nodeId: string;
  number: number;
  htmlUrl: string;
  state: "open" | "closed";
  title: string;
  body: string;
  draft: boolean;
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  updatedAt: string;
  mergeSha?: string | null;
}

export type GitHubPullRequestFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

export interface GitHubPullRequestFileRecord {
  sha: string;
  filename: string;
  status: GitHubPullRequestFileStatus;
  additions: number;
  deletions: number;
  changes: number;
  previousFilename?: string;
  patch?: string;
  patchTruncated: boolean;
}

export interface GitHubReviewRecord {
  id: number;
  htmlUrl: string;
  state: string;
  body: string;
  commitId?: string;
  author: GitHubActorRecord;
  submittedAt: string;
}

export interface GitHubReviewCommentRecord extends GitHubCommentRecord {
  pullRequestReviewId?: number;
  path: string;
  line?: number;
  inReplyToId?: number;
}

/** Fixed GraphQL projection; path and diff hunk fields are intentionally absent. */
export interface GitHubUnresolvedReviewCommentRecord {
  id: number;
  authorLogin: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  reviewId: number | null;
}

export interface GitHubCheckRunRecord {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  htmlUrl?: string;
}

export interface GitHubCombinedStatusRecord {
  state: string;
  sha: string;
  totalCount: number;
  statuses: Array<{
    id: number;
    state: string;
    context: string;
    description?: string;
    targetUrl?: string;
  }>;
}

export interface GitHubWorkflowRunRecord {
  id: number;
  name: string;
  htmlUrl: string;
  status: string;
  conclusion?: string;
  headSha: string;
  event: string;
  runAttempt: number;
  updatedAt: string;
}

export interface GitHubWorkflowJobRecord {
  id: number;
  runId: number;
  name: string;
  htmlUrl: string;
  status: string;
  conclusion?: string;
  headSha: string;
  startedAt?: string;
  completedAt?: string;
  workflowName?: string;
  headBranch?: string;
  runnerName?: string;
}

export interface GitHubMergeRecord {
  sha: string;
  merged: boolean;
  message: string;
}

export interface GitHubCodeSearchResultRecord {
  path: string;
  name: string;
  htmlUrl: string;
  sha: string;
  score: number;
}

export interface GitHubIssueSearchResultRecord {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  pullRequest: boolean;
  updatedAt: string;
}

export interface GitHubCommitSearchResultRecord {
  sha: string;
  message: string;
  htmlUrl: string;
  authoredAt: string;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class GitHubRestClient {
  constructor(
    private readonly options: {
      transport: HttpTransport;
      token: string;
      timeoutMs?: number;
    },
  ) {}

  async getAuthenticatedUser(signal?: AbortSignal): Promise<GitHubAuthenticatedUserRecord> {
    return normalizeAuthenticatedUser(await this.request("GET", "/user", undefined, signal));
  }

  /**
   * Authenticated identity plus the scopes GitHub actually reported in the
   * `x-oauth-scopes` response header. Classic/OAuth tokens echo their scopes
   * there; fine-grained PATs omit the header entirely, so `oauthScopes` is
   * `null` (unverified) for them — never a fabricated claim.
   */
  async getAuthenticatedUserWithOAuthScopes(
    signal?: AbortSignal,
  ): Promise<GitHubAuthenticatedUserRecord & { oauthScopes: string[] | null }> {
    let scopesHeader: string | null = null;
    const payload = await this.request("GET", "/user", undefined, signal, false, (headers) => {
      const raw = headers["x-oauth-scopes"];
      scopesHeader = typeof raw === "string" ? raw : null;
    });
    const user = normalizeAuthenticatedUser(payload);
    const oauthScopes = scopesHeader === null
      ? null
      : (scopesHeader as string)
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean)
          .slice(0, 64);
    return { ...user, oauthScopes };
  }

  async getRepository(
    owner: string,
    repository: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryRecord> {
    return normalizeRepository(
      await this.request("GET", repoPath(owner, repository), undefined, signal),
    );
  }

  /**
   * The creation payload is intentionally fixed. In particular, callers
   * cannot request public visibility, initialize content, or widen unrelated
   * repository features through model-supplied fields.
   */
  async createPrivateRepository(
    input: CreatePrivateGitHubRepositoryInput,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryRecord> {
    const owner = validateLogin(input.owner);
    const repository = validateOwnerRepoSegment(input.repository, "repository");
    const description = optionalBoundedText(input.description, "description", 1_024);
    const path = input.ownerKind === "user"
      ? "/user/repos"
      : `/orgs/${encodeURIComponent(owner)}/repos`;
    const created = normalizeRepository(await this.request("POST", path, {
      name: repository,
      private: true,
      visibility: "private",
      auto_init: false,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      ...(description ? { description } : {}),
    }, signal));
    if (
      created.private !== true ||
      created.archived === true ||
      created.fullName.toLowerCase() !== `${owner}/${repository}`.toLowerCase()
    ) {
      throw invalidResponse(
        "GitHub did not create the exact active private repository requested.",
      );
    }
    return created;
  }

  /**
   * Permanently remove one exact repository. The caller must enforce
   * disposable ownership and obtain a separate destructive approval before
   * invoking this fixed endpoint.
   */
  async deleteRepository(
    owner: string,
    repository: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      "DELETE",
      repoPath(owner, repository),
      undefined,
      signal,
      true,
    );
  }

  /**
   * Change only the exact repository default branch. Callers must independently
   * verify the target ref and enforce the allowed transition before invoking
   * this mutation.
   */
  async updateRepositoryDefaultBranch(
    owner: string,
    repository: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryRecord> {
    const expectedFullName =
      `${validateLogin(owner)}/${validateOwnerRepoSegment(repository, "repository")}`;
    const defaultBranch = validateRef(branch);
    const readback = normalizeRepository(
      await this.request(
        "PATCH",
        repoPath(owner, repository),
        { default_branch: defaultBranch },
        signal,
      ),
    );
    if (
      readback.private !== true ||
      readback.archived ||
      readback.fullName.toLowerCase() !== expectedFullName.toLowerCase() ||
      readback.defaultBranch !== defaultBranch
    ) {
      throw new GitHubApiError(
        "github_conflict",
        "GitHub default-branch mutation did not return the exact active private repository.",
      );
    }
    return readback;
  }

  async getReference(
    owner: string,
    repository: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitHubReferenceRecord> {
    return normalizeReference(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/git/ref/heads/${refPath(branch)}`,
        undefined,
        signal,
      ),
    );
  }

  async listBranches(
    owner: string,
    repository: string,
    signal?: AbortSignal,
  ): Promise<GitHubBranchRecord[]> {
    return normalizeList(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/branches?per_page=100`,
        undefined,
        signal,
      ),
      "branches",
      normalizeBranch,
    );
  }

  async listTags(
    owner: string,
    repository: string,
    signal?: AbortSignal,
  ): Promise<GitHubTagRecord[]> {
    return normalizeList(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/tags?per_page=100`,
        undefined,
        signal,
      ),
      "tags",
      normalizeTag,
    );
  }

  async listReleases(
    owner: string,
    repository: string,
    signal?: AbortSignal,
  ): Promise<GitHubReleaseRecord[]> {
    return normalizeList(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/releases?per_page=100`,
        undefined,
        signal,
      ),
      "releases",
      normalizeRelease,
    );
  }

  async getRelease(
    owner: string,
    repository: string,
    releaseId: number,
    signal?: AbortSignal,
  ): Promise<GitHubReleaseRecord> {
    return normalizeRelease(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/releases/${positiveInteger(releaseId, "releaseId")}`,
        undefined,
        signal,
      ),
    );
  }

  async getCommit(
    owner: string,
    repository: string,
    sha: string,
    signal?: AbortSignal,
  ): Promise<GitHubCommitRecord> {
    return normalizeCommit(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/git/commits/${validateSha(sha)}`,
        undefined,
        signal,
      ),
    );
  }

  async getTree(
    owner: string,
    repository: string,
    sha: string,
    recursive = false,
    signal?: AbortSignal,
  ): Promise<GitHubTreeRecord> {
    const query = recursive ? "?recursive=1" : "";
    return normalizeTree(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/git/trees/${validateSha(sha)}${query}`,
        undefined,
        signal,
      ),
    );
  }

  async getBlob(
    owner: string,
    repository: string,
    sha: string,
    signal?: AbortSignal,
  ): Promise<GitHubBlobRecord> {
    return normalizeBlob(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/git/blobs/${validateSha(sha)}`,
        undefined,
        signal,
      ),
    );
  }

  async getIssue(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubIssueRecord> {
    return normalizeIssue(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/issues/${positiveInteger(number, "number")}`,
        undefined,
        signal,
      ),
    );
  }

  async listIssues(
    owner: string,
    repository: string,
    signal?: AbortSignal,
  ): Promise<GitHubIssueRecord[]> {
    return normalizeList(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/issues?state=all&sort=created&direction=desc&per_page=100`,
        undefined,
        signal,
      ),
      "issues",
      normalizeIssue,
    );
  }

  async getIssueComment(
    owner: string,
    repository: string,
    commentId: number,
    signal?: AbortSignal,
  ): Promise<GitHubCommentRecord> {
    return normalizeComment(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/issues/comments/${positiveInteger(commentId, "commentId")}`,
        undefined,
        signal,
      ),
    );
  }

  async listIssueComments(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubCommentRecord[]> {
    return normalizeList(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/issues/${positiveInteger(number, "number")}/comments?per_page=100`,
        undefined,
        signal,
      ),
      "issue comments",
      normalizeComment,
    );
  }

  async getPullRequest(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRecord> {
    return normalizePullRequest(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/pulls/${positiveInteger(number, "number")}`,
        undefined,
        signal,
      ),
    );
  }

  async listPullRequestFiles(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestFileRecord[]> {
    return normalizeList(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/pulls/${positiveInteger(number, "number")}/files?per_page=100`,
        undefined,
        signal,
      ),
      "pull request files",
      normalizePullRequestFile,
    );
  }

  async listPullRequestsForHead(
    owner: string,
    repository: string,
    head: string,
    base: string,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRecord[]> {
    const query = new URLSearchParams({
      state: "all",
      head: `${owner}:${validateRef(head)}`,
      base: validateRef(base),
      per_page: "10",
    });
    return normalizeList(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/pulls?${query.toString()}`,
        undefined,
        signal,
      ),
      "pull requests",
      normalizePullRequest,
      10,
    );
  }

  async listPullRequestReviews(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewRecord[]> {
    return normalizeList(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/pulls/${positiveInteger(number, "number")}/reviews?per_page=100`,
        undefined,
        signal,
      ),
      "pull request reviews",
      normalizeReview,
    );
  }

  async getReviewComment(
    owner: string,
    repository: string,
    commentId: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewCommentRecord> {
    return normalizeReviewComment(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/pulls/comments/${positiveInteger(commentId, "commentId")}`,
        undefined,
        signal,
      ),
    );
  }

  async listPullRequestReviewComments(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewCommentRecord[]> {
    return normalizeList(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/pulls/${positiveInteger(number, "number")}/comments?per_page=100`,
        undefined,
        signal,
      ),
      "pull request review comments",
      normalizeReviewComment,
    );
  }

  /**
   * GitHub REST review comments do not expose thread resolution. This fixed,
   * bounded query reads at most one root comment from each of 50 threads and
   * returns only unresolved prose without path/diff metadata.
   */
  async listUnresolvedPullRequestReviewComments(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubUnresolvedReviewCommentRecord[]> {
    // Validate the logical repository keys before putting them in variables.
    segment(owner);
    segment(repository);
    const payload = await this.request(
      "POST",
      "/graphql",
      {
        query:
          "query AgenticResearcherUnresolvedReviewThreads($owner: String!, $repository: String!, $number: Int!) { repository(owner: $owner, name: $repository) { pullRequest(number: $number) { reviewThreads(first: 50) { nodes { isResolved comments(first: 1) { nodes { databaseId body createdAt updatedAt author { login } pullRequestReview { databaseId } } } } } } } }",
        variables: {
          owner,
          repository,
          number: positiveInteger(number, "number"),
        },
      },
      signal,
    );
    return normalizeUnresolvedReviewComments(payload);
  }

  async listCheckRuns(
    owner: string,
    repository: string,
    reference: string,
    signal?: AbortSignal,
  ): Promise<GitHubCheckRunRecord[]> {
    const payload = await this.request(
      "GET",
      `${repoPath(owner, repository)}/commits/${encodeURIComponent(validateRef(reference))}/check-runs?per_page=100`,
      undefined,
      signal,
    );
    if (!isRecord(payload)) {
      throw invalidResponse("Expected check_runs in the GitHub response.");
    }
    return normalizeList(payload.check_runs, "check runs", normalizeCheckRun);
  }

  async getCombinedStatus(
    owner: string,
    repository: string,
    reference: string,
    signal?: AbortSignal,
  ): Promise<GitHubCombinedStatusRecord> {
    return normalizeCombinedStatus(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/commits/${encodeURIComponent(validateRef(reference))}/status?per_page=100`,
        undefined,
        signal,
      ),
    );
  }

  async listWorkflowRunsForCommit(
    owner: string,
    repository: string,
    headSha: string,
    signal?: AbortSignal,
  ): Promise<GitHubWorkflowRunRecord[]> {
    const query = new URLSearchParams({
      head_sha: validateSha(headSha),
      per_page: "100",
    });
    const payload = await this.request(
      "GET",
      `${repoPath(owner, repository)}/actions/runs?${query.toString()}`,
      undefined,
      signal,
    );
    if (!isRecord(payload)) {
      throw invalidResponse("Expected workflow_runs in the GitHub response.");
    }
    return normalizeList(payload.workflow_runs, "workflow runs", normalizeWorkflowRun);
  }

  async getWorkflowRun(
    owner: string,
    repository: string,
    runId: number,
    signal?: AbortSignal,
  ): Promise<GitHubWorkflowRunRecord> {
    return normalizeWorkflowRun(
      await this.request(
        "GET",
        `${repoPath(owner, repository)}/actions/runs/${positiveInteger(runId, "runId")}`,
        undefined,
        signal,
      ),
    );
  }

  async listWorkflowJobs(
    owner: string,
    repository: string,
    runId: number,
    signal?: AbortSignal,
  ): Promise<GitHubWorkflowJobRecord[]> {
    const payload = await this.request(
      "GET",
      `${repoPath(owner, repository)}/actions/runs/${positiveInteger(runId, "runId")}/jobs?filter=latest&per_page=100`,
      undefined,
      signal,
    );
    if (!isRecord(payload)) {
      throw invalidResponse("Expected jobs in the GitHub response.");
    }
    return normalizeList(payload.jobs, "workflow jobs", normalizeWorkflowJob);
  }

  /**
   * Repository-scoped code search. The repo: qualifier is host-appended and
   * caller qualifiers that would widen scope (repo:/org:/user:) are stripped,
   * so search can never escape the trusted repository binding.
   */
  async searchCode(
    owner: string,
    repository: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<GitHubCodeSearchResultRecord[]> {
    const payload = await this.searchRequest("code", owner, repository, query, signal);
    return normalizeList(payload.items, "code search results", (value) => {
      if (!isRecord(value)) throw invalidResponse("Invalid code search result.");
      return {
        path: requiredString(value.path, "item.path"),
        name: requiredString(value.name, "item.name"),
        htmlUrl: requiredString(value.html_url, "item.html_url"),
        sha: requiredString(value.sha, "item.sha"),
        score: typeof value.score === "number" ? value.score : 0,
      };
    });
  }

  /** Repository-scoped issue/PR search with the same widening protection. */
  async searchIssues(
    owner: string,
    repository: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<GitHubIssueSearchResultRecord[]> {
    const payload = await this.searchRequest("issues", owner, repository, query, signal);
    return normalizeList(payload.items, "issue search results", (value) => {
      if (!isRecord(value)) throw invalidResponse("Invalid issue search result.");
      return {
        number: requiredNumber(value.number, "item.number"),
        title: requiredString(value.title, "item.title"),
        state: requiredString(value.state, "item.state"),
        htmlUrl: requiredString(value.html_url, "item.html_url"),
        pullRequest: isRecord(value.pull_request),
        updatedAt: requiredString(value.updated_at, "item.updated_at"),
      };
    });
  }

  /** Repository-scoped commit search with the same widening protection. */
  async searchCommits(
    owner: string,
    repository: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<GitHubCommitSearchResultRecord[]> {
    const payload = await this.searchRequest("commits", owner, repository, query, signal);
    return normalizeList(payload.items, "commit search results", (value) => {
      if (!isRecord(value) || !isRecord(value.commit)) {
        throw invalidResponse("Invalid commit search result.");
      }
      return {
        sha: requiredString(value.sha, "item.sha"),
        message: requiredString(value.commit.message, "item.commit.message").slice(0, 500),
        htmlUrl: requiredString(value.html_url, "item.html_url"),
        authoredAt: isRecord(value.commit.author) && typeof value.commit.author.date === "string"
          ? value.commit.author.date
          : "",
      };
    });
  }

  private async searchRequest(
    kind: "code" | "issues" | "commits",
    owner: string,
    repository: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const cleaned = query
      .replace(/\b(?:repo|org|user):\S+/giu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 240);
    if (!cleaned) {
      throw new GitHubApiError(
        "github_api",
        "A non-empty search query is required after scope qualifiers are removed.",
      );
    }
    const scoped = `${cleaned} repo:${validateLogin(owner)}/${validateOwnerRepoSegment(repository, "repository")}`;
    const payload = await this.request(
      "GET",
      `/search/${kind}?q=${encodeURIComponent(scoped)}&per_page=50`,
      undefined,
      signal,
    );
    if (!isRecord(payload)) {
      throw invalidResponse("Expected search results in the GitHub response.");
    }
    return payload;
  }

  async createAgentBranch(
    input: { owner: string; repository: string; branch: string; sha: string },
    signal?: AbortSignal,
  ): Promise<GitHubReferenceRecord> {
    const branch = validateAgentBranch(input.branch);
    return normalizeReference(
      await this.request(
        "POST",
        `${repoPath(input.owner, input.repository)}/git/refs`,
        { ref: `refs/heads/${branch}`, sha: validateSha(input.sha) },
        signal,
      ),
    );
  }

  async updateAgentBranchFastForward(
    input: { owner: string; repository: string; branch: string; sha: string },
    signal?: AbortSignal,
  ): Promise<GitHubReferenceRecord> {
    const branch = validateAgentBranch(input.branch);
    return normalizeReference(
      await this.request(
        "PATCH",
        `${repoPath(input.owner, input.repository)}/git/refs/heads/${refPath(branch)}`,
        { sha: validateSha(input.sha), force: false },
        signal,
      ),
    );
  }

  async deleteAgentBranch(
    input: {
      owner: string;
      repository: string;
      branch: string;
      expectedSha: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const branch = validateAgentBranch(input.branch);
    const expectedSha = validateSha(input.expectedSha);
    const current = await this.getReference(input.owner, input.repository, branch, signal);
    if (current.sha.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new GitHubApiError(
        "github_conflict",
        "GitHub branch changed after approval; deletion was not attempted.",
      );
    }
    await this.request(
      "DELETE",
      `${repoPath(input.owner, input.repository)}/git/refs/heads/${refPath(branch)}`,
      undefined,
      signal,
      true,
    );
  }

  async createDraftPullRequest(
    input: {
      owner: string;
      repository: string;
      title: string;
      body: string;
      head: string;
      base: string;
    },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRecord> {
    const payload = await this.request(
      "POST",
      `${repoPath(input.owner, input.repository)}/pulls`,
      {
        title: boundedText(input.title, "title", 1, 256),
        body: boundedText(input.body, "body", 0, 65_536),
        head: validateAgentBranch(input.head),
        base: validateRef(input.base),
        draft: true,
      },
      signal,
    );
    return normalizePullRequest(payload);
  }

  /** Fixed GraphQL mutation because GitHub exposes ready-for-review only there. */
  async markPullRequestReadyForReview(
    input: { owner: string; repository: string; number: number },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRecord> {
    const current = await this.getPullRequest(
      input.owner,
      input.repository,
      input.number,
      signal,
    );
    if (!current.draft) return current;
    const payload = await this.request(
      "POST",
      "/graphql",
      {
        query:
          "mutation AgenticResearcherMarkPullRequestReady($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { id isDraft } } }",
        variables: { pullRequestId: current.nodeId },
      },
      signal,
    );
    if (!isRecord(payload) || !isRecord(payload.data) ||
        !isRecord(payload.data.markPullRequestReadyForReview)) {
      throw invalidResponse("GitHub did not confirm the fixed ready-for-review mutation.");
    }
    const readback = await this.getPullRequest(
      input.owner,
      input.repository,
      input.number,
      signal,
    );
    if (readback.draft || readback.nodeId !== current.nodeId) {
      throw new GitHubApiError(
        "github_conflict",
        "Pull request ready-for-review readback did not match the prepared pull request.",
      );
    }
    return readback;
  }

  async createIssue(
    input: { owner: string; repository: string; title: string; body: string },
    signal?: AbortSignal,
  ): Promise<GitHubIssueRecord> {
    return normalizeIssue(
      await this.request(
        "POST",
        `${repoPath(input.owner, input.repository)}/issues`,
        {
          title: boundedText(input.title, "title", 1, 256),
          body: boundedText(input.body, "body", 0, 65_536),
        },
        signal,
      ),
    );
  }

  async createIssueComment(
    input: { owner: string; repository: string; number: number; body: string },
    signal?: AbortSignal,
  ): Promise<GitHubCommentRecord> {
    return normalizeComment(
      await this.request(
        "POST",
        `${repoPath(input.owner, input.repository)}/issues/${positiveInteger(input.number, "number")}/comments`,
        { body: boundedText(input.body, "body", 1, 65_536) },
        signal,
      ),
    );
  }

  async createPullRequestReview(
    input: {
      owner: string;
      repository: string;
      number: number;
      body: string;
      commitId: string;
      event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    },
    signal?: AbortSignal,
  ): Promise<GitHubReviewRecord> {
    return normalizeReview(
      await this.request(
        "POST",
        `${repoPath(input.owner, input.repository)}/pulls/${positiveInteger(input.number, "number")}/reviews`,
        {
          body: boundedText(input.body, "body", 0, 65_536),
          commit_id: validateSha(input.commitId),
          event: input.event,
        },
        signal,
      ),
    );
  }

  async replyToReviewComment(
    input: {
      owner: string;
      repository: string;
      pullNumber: number;
      commentId: number;
      body: string;
    },
    signal?: AbortSignal,
  ): Promise<GitHubReviewCommentRecord> {
    return normalizeReviewComment(
      await this.request(
        "POST",
        `${repoPath(input.owner, input.repository)}/pulls/${positiveInteger(input.pullNumber, "pullNumber")}/comments/${positiveInteger(input.commentId, "commentId")}/replies`,
        { body: boundedText(input.body, "body", 1, 65_536) },
        signal,
      ),
    );
  }

  async updateIssue(
    input: {
      owner: string;
      repository: string;
      number: number;
      title?: string;
      body?: string;
      state?: "open" | "closed";
    },
    signal?: AbortSignal,
  ): Promise<GitHubIssueRecord> {
    const body = definedBody({
      ...(input.title === undefined
        ? {}
        : { title: boundedText(input.title, "title", 1, 256) }),
      ...(input.body === undefined
        ? {}
        : { body: boundedText(input.body, "body", 0, 65_536) }),
      ...(input.state === undefined ? {} : { state: input.state }),
    });
    return normalizeIssue(
      await this.request(
        "PATCH",
        `${repoPath(input.owner, input.repository)}/issues/${positiveInteger(input.number, "number")}`,
        body,
        signal,
      ),
    );
  }

  async closeIssue(
    input: { owner: string; repository: string; number: number },
    signal?: AbortSignal,
  ): Promise<GitHubIssueRecord> {
    return this.updateIssue({ ...input, state: "closed" }, signal);
  }

  async reopenIssue(
    input: { owner: string; repository: string; number: number },
    signal?: AbortSignal,
  ): Promise<GitHubIssueRecord> {
    return this.updateIssue({ ...input, state: "open" }, signal);
  }

  async updatePullRequest(
    input: {
      owner: string;
      repository: string;
      number: number;
      title?: string;
      body?: string;
      base?: string;
      state?: "open" | "closed";
    },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRecord> {
    const body = definedBody({
      ...(input.title === undefined
        ? {}
        : { title: boundedText(input.title, "title", 1, 256) }),
      ...(input.body === undefined
        ? {}
        : { body: boundedText(input.body, "body", 0, 65_536) }),
      ...(input.base === undefined ? {} : { base: validateRef(input.base) }),
      ...(input.state === undefined ? {} : { state: input.state }),
    });
    return normalizePullRequest(
      await this.request(
        "PATCH",
        `${repoPath(input.owner, input.repository)}/pulls/${positiveInteger(input.number, "number")}`,
        body,
        signal,
      ),
    );
  }

  async closePullRequest(
    input: { owner: string; repository: string; number: number },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRecord> {
    return this.updatePullRequest({ ...input, state: "closed" }, signal);
  }

  async reopenPullRequest(
    input: { owner: string; repository: string; number: number },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRecord> {
    return this.updatePullRequest({ ...input, state: "open" }, signal);
  }

  async updateIssueComment(
    input: {
      owner: string;
      repository: string;
      commentId: number;
      body: string;
      expectedAuthorLogin: string;
    },
    signal?: AbortSignal,
  ): Promise<GitHubCommentRecord> {
    await this.assertOwnedComment("issue", input, signal);
    return normalizeComment(
      await this.request(
        "PATCH",
        `${repoPath(input.owner, input.repository)}/issues/comments/${positiveInteger(input.commentId, "commentId")}`,
        { body: boundedText(input.body, "body", 1, 65_536) },
        signal,
      ),
    );
  }

  async updateReviewComment(
    input: {
      owner: string;
      repository: string;
      commentId: number;
      body: string;
      expectedAuthorLogin: string;
    },
    signal?: AbortSignal,
  ): Promise<GitHubReviewCommentRecord> {
    await this.assertOwnedComment("review", input, signal);
    return normalizeReviewComment(
      await this.request(
        "PATCH",
        `${repoPath(input.owner, input.repository)}/pulls/comments/${positiveInteger(input.commentId, "commentId")}`,
        { body: boundedText(input.body, "body", 1, 65_536) },
        signal,
      ),
    );
  }

  async deleteOwnedComment(
    input: {
      owner: string;
      repository: string;
      commentId: number;
      expectedAuthorLogin: string;
      kind: "issue" | "review";
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.assertOwnedComment(input.kind, input, signal);
    const collection = input.kind === "issue" ? "issues" : "pulls";
    await this.request(
      "DELETE",
      `${repoPath(input.owner, input.repository)}/${collection}/comments/${positiveInteger(input.commentId, "commentId")}`,
      undefined,
      signal,
      true,
    );
  }

  async rerunFailedWorkflowJobs(
    input: { owner: string; repository: string; runId: number },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      "POST",
      `${repoPath(input.owner, input.repository)}/actions/runs/${positiveInteger(input.runId, "runId")}/rerun-failed-jobs`,
      {},
      signal,
      true,
    );
  }

  async mergePullRequestSquash(
    input: {
      owner: string;
      repository: string;
      number: number;
      expectedHeadSha: string;
      commitTitle?: string;
      commitMessage?: string;
    },
    signal?: AbortSignal,
  ): Promise<GitHubMergeRecord> {
    return this.mergePullRequest({
      ...input,
      mergeMethod: "squash",
    }, signal);
  }

  async mergePullRequest(
    input: {
      owner: string;
      repository: string;
      number: number;
      expectedHeadSha: string;
      mergeMethod: "squash" | "merge" | "rebase";
      commitTitle?: string;
      commitMessage?: string;
    },
    signal?: AbortSignal,
  ): Promise<GitHubMergeRecord> {
    if (!(["squash", "merge", "rebase"] as const).includes(input.mergeMethod)) {
      throw new GitHubApiError("github_invalid_response", "GitHub merge method is invalid.");
    }
    const payload = await this.request(
      "PUT",
      `${repoPath(input.owner, input.repository)}/pulls/${positiveInteger(input.number, "number")}/merge`,
      {
        sha: validateSha(input.expectedHeadSha),
        merge_method: input.mergeMethod,
        ...(input.commitTitle === undefined
          ? {}
          : { commit_title: boundedText(input.commitTitle, "commitTitle", 1, 256) }),
        ...(input.commitMessage === undefined
          ? {}
          : { commit_message: boundedText(input.commitMessage, "commitMessage", 0, 65_536) }),
      },
      signal,
    );
    return normalizeMerge(payload);
  }

  private async assertOwnedComment(
    kind: "issue" | "review",
    input: {
      owner: string;
      repository: string;
      commentId: number;
      expectedAuthorLogin: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const expected = validateLogin(input.expectedAuthorLogin);
    const comment =
      kind === "issue"
        ? await this.getIssueComment(input.owner, input.repository, input.commentId, signal)
        : await this.getReviewComment(input.owner, input.repository, input.commentId, signal);
    if (comment.author.login.toLowerCase() !== expected.toLowerCase()) {
      throw new GitHubApiError(
        "github_forbidden",
        "The comment is not owned by the pinned GitHub identity.",
      );
    }
  }

  private async request(
    method: HttpMethod,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
    allowNoContent = false,
    captureHeaders?: (headers: Record<string, string>) => void,
  ): Promise<unknown> {
    const token = this.options.token.trim();
    if (!token) {
      throw new GitHubApiError(
        "github_not_configured",
        "GitHub API token is not configured.",
      );
    }
    let response: HttpResponse;
    try {
      response = await this.options.transport({
        url: `${GITHUB_API_BASE_URL}${path}`,
        method,
        contentType: "application/json",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        timeoutMs: this.options.timeoutMs ?? 30_000,
        abortSignal: signal,
        throw: false,
      });
    } catch (error) {
      throw new GitHubApiError(
        "github_api",
        redactSecret(error instanceof Error ? error.message : "GitHub request failed.", token),
      );
    }
    if (captureHeaders && response.status >= 200 && response.status < 300) {
      captureHeaders(response.headers ?? {});
    }
    return parseResponse(response, token, allowNoContent);
  }
}

function parseResponse(
  response: HttpResponse,
  token: string,
  allowNoContent: boolean,
): unknown {
  if (response.status >= 200 && response.status < 300) {
    if (response.json === undefined && allowNoContent) return null;
    if (response.json === undefined) {
      throw invalidResponse("GitHub returned no JSON body.");
    }
    return response.json;
  }
  const message = redactSecret(safeApiMessage(response.json), token);
  if (response.status === 401) {
    throw new GitHubApiError("github_auth", message, response.status);
  }
  if (response.status === 403) {
    const rateLimited =
      response.headers["x-ratelimit-remaining"] === "0" ||
      /rate limit/i.test(message);
    throw new GitHubApiError(
      rateLimited ? "github_rate_limited" : "github_forbidden",
      message,
      response.status,
    );
  }
  if (response.status === 404) {
    throw new GitHubApiError("github_not_found", message, response.status);
  }
  if (response.status === 409 || response.status === 422) {
    throw new GitHubApiError("github_conflict", message, response.status);
  }
  throw new GitHubApiError("github_api", message, response.status);
}

function normalizeAuthenticatedUser(value: unknown): GitHubAuthenticatedUserRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid authenticated user response.");
  return {
    id: requiredNumber(value.id, "user.id"),
    login: validateLogin(requiredString(value.login, "user.login")),
    htmlUrl: requiredString(value.html_url, "user.html_url"),
    ...(typeof value.name === "string" && value.name.trim() ? { name: value.name } : {}),
  };
}

function normalizeRepository(value: unknown): GitHubRepositoryRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid repository response.");
  const visibility = normalizeRepositoryVisibility(value);
  const permissions = normalizeRepositoryPermissions(value.permissions);
  return {
    id: requiredNumber(value.id, "repository.id"),
    fullName: requiredString(value.full_name, "repository.full_name"),
    htmlUrl: requiredString(value.html_url, "repository.html_url"),
    defaultBranch: requiredString(value.default_branch, "repository.default_branch"),
    private: value.private === true,
    archived: value.archived === true,
    visibility,
    ...(typeof value.description === "string" && value.description.trim()
      ? { description: value.description.trim().slice(0, 1_024) }
      : {}),
    ...(typeof value.language === "string" && value.language.trim()
      ? { language: value.language.trim().slice(0, 128) }
      : {}),
    topics: Array.isArray(value.topics)
      ? value.topics
          .filter((topic): topic is string => typeof topic === "string")
          .map((topic) => topic.trim())
          .filter(Boolean)
          .slice(0, 20)
      : [],
    hasIssues: value.has_issues !== false,
    ...(permissions ? { permissions } : {}),
  };
}

function normalizeRepositoryVisibility(
  value: Record<string, unknown>,
): GitHubRepositoryRecord["visibility"] {
  if (
    value.visibility === "private" ||
    value.visibility === "public" ||
    value.visibility === "internal"
  ) {
    return value.visibility;
  }
  return value.private === true ? "private" : "public";
}

function normalizeRepositoryPermissions(
  value: unknown,
): GitHubRepositoryRecord["permissions"] | undefined {
  if (!isRecord(value)) return undefined;
  const fields = ["admin", "maintain", "push", "triage", "pull"] as const;
  if (fields.some((field) => typeof value[field] !== "boolean")) {
    throw invalidResponse("Invalid repository permissions response.");
  }
  return {
    admin: value.admin as boolean,
    maintain: value.maintain as boolean,
    push: value.push as boolean,
    triage: value.triage as boolean,
    pull: value.pull as boolean,
  };
}

function normalizeReference(value: unknown): GitHubReferenceRecord {
  if (!isRecord(value) || !isRecord(value.object)) {
    throw invalidResponse("Invalid Git reference response.");
  }
  return {
    ref: requiredString(value.ref, "reference.ref"),
    sha: requiredString(value.object.sha, "reference.object.sha"),
    objectType: requiredString(value.object.type, "reference.object.type"),
  };
}

function normalizeBranch(value: unknown): GitHubBranchRecord {
  if (!isRecord(value) || !isRecord(value.commit)) {
    throw invalidResponse("Invalid branch response.");
  }
  if (typeof value.protected !== "boolean") {
    throw invalidResponse("Invalid branch.protected response.");
  }
  return {
    name: validateRef(
      boundedProviderString(value.name, "branch.name", 255),
    ),
    sha: validateSha(requiredString(value.commit.sha, "branch.commit.sha")),
    protected: value.protected,
  };
}

function normalizeTag(value: unknown): GitHubTagRecord {
  if (!isRecord(value) || !isRecord(value.commit)) {
    throw invalidResponse("Invalid tag response.");
  }
  return {
    name: validateRef(boundedProviderString(value.name, "tag.name", 255)),
    sha: validateSha(requiredString(value.commit.sha, "tag.commit.sha")),
  };
}

function normalizeRelease(value: unknown): GitHubReleaseRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid release response.");
  if (typeof value.draft !== "boolean" || typeof value.prerelease !== "boolean") {
    throw invalidResponse("Invalid release state response.");
  }
  const body = boundedProviderContent(
    value.body,
    "release.body",
    MAX_RELEASE_BODY_CHARS,
  );
  const name = value.name === null || value.name === undefined
    ? ""
    : boundedProviderString(value.name, "release.name", MAX_PROVIDER_NAME_CHARS);
  return {
    id: positiveInteger(requiredNumber(value.id, "release.id"), "release.id"),
    tagName: validateRef(
      boundedProviderString(value.tag_name, "release.tag_name", 255),
    ),
    targetCommitish: validateRef(
      boundedProviderString(value.target_commitish, "release.target_commitish", 255),
    ),
    name,
    body: body.text,
    bodyTruncated: body.truncated,
    draft: value.draft,
    prerelease: value.prerelease,
    immutable: value.immutable === true,
    htmlUrl: boundedProviderString(
      value.html_url,
      "release.html_url",
      MAX_PROVIDER_URL_CHARS,
    ),
    author: normalizeActor(value.author, "release.author"),
    createdAt: canonicalTimestamp(value.created_at, "release.created_at"),
    ...(typeof value.published_at === "string"
      ? { publishedAt: canonicalTimestamp(value.published_at, "release.published_at") }
      : {}),
  };
}

function normalizeCommit(value: unknown): GitHubCommitRecord {
  if (!isRecord(value) || !isRecord(value.tree)) {
    throw invalidResponse("Invalid Git commit response.");
  }
  const author = isRecord(value.author) ? value.author : undefined;
  return {
    sha: requiredString(value.sha, "commit.sha"),
    message: requiredString(value.message, "commit.message"),
    treeSha: requiredString(value.tree.sha, "commit.tree.sha"),
    ...(author && typeof author.name === "string" ? { authorName: author.name } : {}),
    ...(author && typeof author.email === "string" ? { authorEmail: author.email } : {}),
  };
}

function normalizeTree(value: unknown): GitHubTreeRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid Git tree response.");
  return {
    sha: requiredString(value.sha, "tree.sha"),
    truncated: value.truncated === true,
    entries: normalizeList(value.tree, "tree entries", normalizeTreeEntry, MAX_TREE_RECORDS),
  };
}

function normalizeTreeEntry(value: unknown): GitHubTreeEntryRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid Git tree entry.");
  const type = value.type;
  if (type !== "blob" && type !== "tree" && type !== "commit") {
    throw invalidResponse("Invalid Git tree entry type.");
  }
  return {
    path: requiredString(value.path, "tree_entry.path"),
    mode: requiredString(value.mode, "tree_entry.mode"),
    type,
    sha: requiredString(value.sha, "tree_entry.sha"),
    ...(typeof value.size === "number" ? { size: value.size } : {}),
  };
}

function normalizeBlob(value: unknown): GitHubBlobRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid Git blob response.");
  const encoding = value.encoding;
  if (encoding !== "base64" && encoding !== "utf-8") {
    throw invalidResponse("Unsupported Git blob encoding.");
  }
  if (typeof value.content !== "string") {
    throw invalidResponse("Missing blob.content.");
  }
  const content = value.content;
  if (content.length > MAX_BLOB_CONTENT_CHARS) {
    throw invalidResponse("Git blob response exceeds the bounded read limit.");
  }
  return {
    sha: requiredString(value.sha, "blob.sha"),
    encoding,
    size: requiredNumber(value.size, "blob.size"),
    content,
  };
}

function normalizeActor(value: unknown, field: string): GitHubActorRecord {
  if (!isRecord(value)) throw invalidResponse(`Missing ${field}.`);
  return {
    id: requiredNumber(value.id, `${field}.id`),
    login: validateLogin(requiredString(value.login, `${field}.login`)),
  };
}

function normalizeIssue(value: unknown): GitHubIssueRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid issue response.");
  const state = value.state;
  if (state !== "open" && state !== "closed") throw invalidResponse("Invalid issue state.");
  return {
    number: requiredNumber(value.number, "issue.number"),
    htmlUrl: requiredString(value.html_url, "issue.html_url"),
    state,
    title: requiredString(value.title, "issue.title"),
    body: typeof value.body === "string" ? value.body : "",
    author: normalizeActor(value.user, "issue.user"),
    pullRequest: isRecord(value.pull_request),
    ...(typeof value.created_at === "string"
      ? { createdAt: canonicalTimestamp(value.created_at, "issue.created_at") }
      : {}),
    ...(typeof value.updated_at === "string"
      ? { updatedAt: canonicalTimestamp(value.updated_at, "issue.updated_at") }
      : {}),
  };
}

function normalizeComment(value: unknown): GitHubCommentRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid comment response.");
  return {
    id: requiredNumber(value.id, "comment.id"),
    htmlUrl: requiredString(value.html_url, "comment.html_url"),
    body: typeof value.body === "string" ? value.body : "",
    author: normalizeActor(value.user, "comment.user"),
    createdAt: requiredString(value.created_at, "comment.created_at"),
    updatedAt: requiredString(value.updated_at, "comment.updated_at"),
  };
}

function normalizePullRequest(value: unknown): GitHubPullRequestRecord {
  if (!isRecord(value) || !isRecord(value.head) || !isRecord(value.base)) {
    throw invalidResponse("Invalid pull request response.");
  }
  const state = value.state;
  if (state !== "open" && state !== "closed") throw invalidResponse("Invalid pull request state.");
  return {
    nodeId: requiredString(value.node_id, "pull_request.node_id"),
    number: requiredNumber(value.number, "pull_request.number"),
    htmlUrl: requiredString(value.html_url, "pull_request.html_url"),
    state,
    title: requiredString(value.title, "pull_request.title"),
    body: typeof value.body === "string" ? value.body : "",
    draft: value.draft === true,
    merged: value.merged === true || typeof value.merged_at === "string",
    head: {
      ref: requiredString(value.head.ref, "pull_request.head.ref"),
      sha: requiredString(value.head.sha, "pull_request.head.sha"),
    },
    base: {
      ref: requiredString(value.base.ref, "pull_request.base.ref"),
      sha: requiredString(value.base.sha, "pull_request.base.sha"),
    },
    updatedAt: canonicalTimestamp(value.updated_at, "pull_request.updated_at"),
    mergeSha:
      typeof value.merge_commit_sha === "string"
        ? validateSha(value.merge_commit_sha)
        : null,
  };
}

function normalizePullRequestFile(value: unknown): GitHubPullRequestFileRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid pull request file response.");
  const status = value.status;
  if (
    status !== "added" &&
    status !== "removed" &&
    status !== "modified" &&
    status !== "renamed" &&
    status !== "copied" &&
    status !== "changed" &&
    status !== "unchanged"
  ) {
    throw invalidResponse("Invalid pull request file status.");
  }
  const patch = value.patch === undefined || value.patch === null
    ? undefined
    : boundedProviderContent(
        value.patch,
        "pull_request_file.patch",
        MAX_PULL_REQUEST_PATCH_CHARS,
      );
  return {
    sha: validateSha(requiredString(value.sha, "pull_request_file.sha")),
    filename: boundedProviderString(
      value.filename,
      "pull_request_file.filename",
      MAX_PROVIDER_PATH_CHARS,
    ),
    status,
    additions: nonNegativeInteger(value.additions, "pull_request_file.additions"),
    deletions: nonNegativeInteger(value.deletions, "pull_request_file.deletions"),
    changes: nonNegativeInteger(value.changes, "pull_request_file.changes"),
    ...(typeof value.previous_filename === "string"
      ? {
          previousFilename: boundedProviderString(
            value.previous_filename,
            "pull_request_file.previous_filename",
            MAX_PROVIDER_PATH_CHARS,
          ),
        }
      : {}),
    ...(patch ? { patch: patch.text } : {}),
    patchTruncated: patch?.truncated ?? false,
  };
}

function normalizeReview(value: unknown): GitHubReviewRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid review response.");
  return {
    id: requiredNumber(value.id, "review.id"),
    htmlUrl: requiredString(value.html_url, "review.html_url"),
    state: requiredString(value.state, "review.state"),
    body: typeof value.body === "string" ? value.body : "",
    ...(typeof value.commit_id === "string" ? { commitId: value.commit_id } : {}),
    author: normalizeActor(value.user, "review.user"),
    submittedAt: canonicalTimestamp(value.submitted_at, "review.submitted_at"),
  };
}

function normalizeReviewComment(value: unknown): GitHubReviewCommentRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid review comment response.");
  return {
    ...normalizeComment(value),
    path: requiredString(value.path, "review_comment.path"),
    ...(typeof value.pull_request_review_id === "number"
      ? { pullRequestReviewId: value.pull_request_review_id }
      : {}),
    ...(typeof value.line === "number" ? { line: value.line } : {}),
    ...(typeof value.in_reply_to_id === "number" ? { inReplyToId: value.in_reply_to_id } : {}),
  };
}

function normalizeUnresolvedReviewComments(
  value: unknown,
): GitHubUnresolvedReviewCommentRecord[] {
  if (!isRecord(value)) {
    throw invalidResponse("Invalid unresolved review-thread response.");
  }
  if (value.errors !== undefined) {
    if (!Array.isArray(value.errors) || value.errors.length > 0) {
      throw invalidResponse("GitHub unresolved review-thread query failed.");
    }
  }
  if (
    !isRecord(value.data) ||
    !isRecord(value.data.repository) ||
    !isRecord(value.data.repository.pullRequest) ||
    !isRecord(value.data.repository.pullRequest.reviewThreads)
  ) {
    throw invalidResponse("Missing unresolved review-thread data.");
  }

  const threads = normalizeList(
    value.data.repository.pullRequest.reviewThreads.nodes,
    "review threads",
    (entry) => entry,
    50,
  );
  const comments: GitHubUnresolvedReviewCommentRecord[] = [];
  const seenCommentIds = new Set<number>();

  for (const [threadIndex, threadValue] of threads.entries()) {
    if (!isRecord(threadValue) || typeof threadValue.isResolved !== "boolean") {
      throw invalidResponse(`Invalid review thread at index ${threadIndex}.`);
    }
    if (threadValue.isResolved) continue;
    if (!isRecord(threadValue.comments)) {
      throw invalidResponse(`Invalid review thread comments at index ${threadIndex}.`);
    }
    const threadComments = normalizeList(
      threadValue.comments.nodes,
      `review thread ${threadIndex} comments`,
      (entry) => entry,
      1,
    );
    for (const commentValue of threadComments) {
      if (!isRecord(commentValue)) {
        throw invalidResponse(`Invalid review thread comment at index ${threadIndex}.`);
      }
      const id = positiveInteger(
        requiredNumber(commentValue.databaseId, "review_thread_comment.databaseId"),
        "review_thread_comment.databaseId",
      );
      if (seenCommentIds.has(id)) {
        throw invalidResponse("Duplicate unresolved review-thread comment id.");
      }
      seenCommentIds.add(id);
      if (!isRecord(commentValue.author)) {
        throw invalidResponse("Missing review_thread_comment.author.");
      }
      const reviewId = commentValue.pullRequestReview === null
        ? null
        : isRecord(commentValue.pullRequestReview)
          ? positiveInteger(
              requiredNumber(
                commentValue.pullRequestReview.databaseId,
                "review_thread_comment.pullRequestReview.databaseId",
              ),
              "review_thread_comment.pullRequestReview.databaseId",
            )
          : (() => {
              throw invalidResponse("Invalid review_thread_comment.pullRequestReview.");
            })();
      comments.push({
        id,
        authorLogin: validateLogin(
          requiredString(commentValue.author.login, "review_thread_comment.author.login"),
        ),
        body: boundedText(
          typeof commentValue.body === "string" ? commentValue.body : "",
          "review_thread_comment.body",
          0,
          65_536,
        ),
        createdAt: canonicalTimestamp(
          commentValue.createdAt,
          "review_thread_comment.createdAt",
        ),
        updatedAt: canonicalTimestamp(
          commentValue.updatedAt,
          "review_thread_comment.updatedAt",
        ),
        reviewId,
      });
    }
  }

  return comments;
}

function normalizeCheckRun(value: unknown): GitHubCheckRunRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid check run response.");
  return {
    id: requiredNumber(value.id, "check_run.id"),
    name: requiredString(value.name, "check_run.name"),
    status: requiredString(value.status, "check_run.status"),
    ...(typeof value.conclusion === "string" ? { conclusion: value.conclusion } : {}),
    ...(typeof value.html_url === "string" ? { htmlUrl: value.html_url } : {}),
  };
}

function normalizeCombinedStatus(value: unknown): GitHubCombinedStatusRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid combined status response.");
  return {
    state: requiredString(value.state, "status.state"),
    sha: requiredString(value.sha, "status.sha"),
    totalCount: requiredNumber(value.total_count, "status.total_count"),
    statuses: normalizeList(value.statuses, "commit statuses", (entry) => {
      if (!isRecord(entry)) throw invalidResponse("Invalid commit status response.");
      return {
        id: requiredNumber(entry.id, "commit_status.id"),
        state: requiredString(entry.state, "commit_status.state"),
        context: requiredString(entry.context, "commit_status.context"),
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(typeof entry.target_url === "string" ? { targetUrl: entry.target_url } : {}),
      };
    }),
  };
}

function normalizeWorkflowRun(value: unknown): GitHubWorkflowRunRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid workflow run response.");
  return {
    id: positiveInteger(requiredNumber(value.id, "workflow_run.id"), "workflow_run.id"),
    name: boundedProviderString(value.name, "workflow_run.name", MAX_PROVIDER_NAME_CHARS),
    htmlUrl: boundedProviderString(
      value.html_url,
      "workflow_run.html_url",
      MAX_PROVIDER_URL_CHARS,
    ),
    status: boundedProviderString(value.status, "workflow_run.status", 64),
    ...(typeof value.conclusion === "string"
      ? { conclusion: boundedProviderString(value.conclusion, "workflow_run.conclusion", 64) }
      : {}),
    headSha: validateSha(requiredString(value.head_sha, "workflow_run.head_sha")),
    event: boundedProviderString(value.event, "workflow_run.event", 128),
    runAttempt: positiveInteger(
      requiredNumber(value.run_attempt, "workflow_run.run_attempt"),
      "workflow_run.run_attempt",
    ),
    updatedAt: canonicalTimestamp(value.updated_at, "workflow_run.updated_at"),
  };
}

function normalizeWorkflowJob(value: unknown): GitHubWorkflowJobRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid workflow job response.");
  return {
    id: positiveInteger(requiredNumber(value.id, "workflow_job.id"), "workflow_job.id"),
    runId: positiveInteger(
      requiredNumber(value.run_id, "workflow_job.run_id"),
      "workflow_job.run_id",
    ),
    name: boundedProviderString(value.name, "workflow_job.name", MAX_PROVIDER_NAME_CHARS),
    htmlUrl: boundedProviderString(
      value.html_url,
      "workflow_job.html_url",
      MAX_PROVIDER_URL_CHARS,
    ),
    status: boundedProviderString(value.status, "workflow_job.status", 64),
    ...(typeof value.conclusion === "string"
      ? { conclusion: boundedProviderString(value.conclusion, "workflow_job.conclusion", 64) }
      : {}),
    headSha: validateSha(requiredString(value.head_sha, "workflow_job.head_sha")),
    ...(typeof value.started_at === "string"
      ? { startedAt: canonicalTimestamp(value.started_at, "workflow_job.started_at") }
      : {}),
    ...(typeof value.completed_at === "string"
      ? { completedAt: canonicalTimestamp(value.completed_at, "workflow_job.completed_at") }
      : {}),
    ...(typeof value.workflow_name === "string" && value.workflow_name.trim()
      ? {
          workflowName: boundedProviderString(
            value.workflow_name,
            "workflow_job.workflow_name",
            MAX_PROVIDER_NAME_CHARS,
          ),
        }
      : {}),
    ...(typeof value.head_branch === "string" && value.head_branch.trim()
      ? {
          headBranch: validateRef(
            boundedProviderString(value.head_branch, "workflow_job.head_branch", 255),
          ),
        }
      : {}),
    ...(typeof value.runner_name === "string" && value.runner_name.trim()
      ? {
          runnerName: boundedProviderString(
            value.runner_name,
            "workflow_job.runner_name",
            MAX_PROVIDER_NAME_CHARS,
          ),
        }
      : {}),
  };
}

function normalizeMerge(value: unknown): GitHubMergeRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid merge response.");
  return {
    sha: requiredString(value.sha, "merge.sha"),
    merged: value.merged === true,
    message: requiredString(value.message, "merge.message"),
  };
}

function normalizeList<T>(
  value: unknown,
  field: string,
  normalize: (entry: unknown) => T,
  maximum = MAX_LIST_RECORDS,
): T[] {
  if (!Array.isArray(value)) throw invalidResponse(`Expected ${field} array.`);
  if (value.length > maximum) throw invalidResponse(`${field} exceeds the bounded result limit.`);
  return value.map(normalize);
}

function repoPath(owner: string, repository: string): string {
  return `/repos/${segment(owner)}/${segment(repository)}`;
}

function segment(value: string): string {
  const normalized = value.trim();
  if (
    !OWNER_REPO_PATTERN.test(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new GitHubApiError(
      "github_invalid_response",
      "GitHub owner or repository identifier is invalid.",
    );
  }
  return encodeURIComponent(normalized);
}

function validateOwnerRepoSegment(value: string, field: string): string {
  const normalized = value.trim();
  if (
    !OWNER_REPO_PATTERN.test(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new GitHubApiError(
      "github_invalid_response",
      `GitHub ${field} identifier is invalid.`,
    );
  }
  return normalized;
}

function validateLogin(value: string): string {
  const normalized = value.trim();
  const base = normalized.endsWith("[bot]") ? normalized.slice(0, -5) : normalized;
  if (!LOGIN_PATTERN.test(normalized) || base.startsWith("-") || base.endsWith("-")) {
    throw new GitHubApiError("github_invalid_response", "GitHub login is invalid.");
  }
  return normalized;
}

function validateRef(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 255 ||
    normalized.startsWith("-") ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("..") ||
    normalized.includes("//") ||
    /[\s~^:?*[\\\]]/.test(normalized)
  ) {
    throw new GitHubApiError("github_invalid_response", "Git reference is invalid.");
  }
  return normalized;
}

function validateAgentBranch(value: string): string {
  const branch = validateRef(value);
  if (!branch.startsWith(AGENT_BRANCH_PREFIX) || branch.length <= AGENT_BRANCH_PREFIX.length) {
    throw new GitHubApiError(
      "github_forbidden",
      `GitHub branch mutations are limited to ${AGENT_BRANCH_PREFIX} branches.`,
    );
  }
  return branch;
}

function refPath(value: string): string {
  return validateRef(value)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function validateSha(value: string): string {
  const normalized = value.trim();
  if (!SHA_PATTERN.test(normalized)) {
    throw new GitHubApiError("github_invalid_response", "Git commit SHA is invalid.");
  }
  return normalized.toLowerCase();
}

function boundedText(
  value: string,
  field: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new GitHubApiError(
      "github_invalid_response",
      `${field} must contain ${minimum}-${maximum} characters.`,
    );
  }
  return normalized;
}

function boundedProviderString(
  value: unknown,
  field: string,
  maximum: number,
): string {
  const text = requiredString(value, field);
  if (text.length > maximum) {
    throw invalidResponse(`${field} exceeds the bounded response limit.`);
  }
  return text;
}

function boundedProviderContent(
  value: unknown,
  field: string,
  maximum: number,
): { text: string; truncated: boolean } {
  if (value === null || value === undefined) {
    return { text: "", truncated: false };
  }
  if (typeof value !== "string") {
    throw invalidResponse(`Invalid ${field}.`);
  }
  return {
    text: value.slice(0, maximum),
    truncated: value.length > maximum,
  };
}

function optionalBoundedText(
  value: string | undefined,
  field: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return boundedText(value, field, 1, maximum);
}

function definedBody(body: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(body).length === 0) {
    throw new GitHubApiError("github_invalid_response", "At least one update field is required.");
  }
  return body;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubApiError("github_invalid_response", `${field} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse(`${field} must be a non-negative integer.`);
  }
  return value;
}

function safeApiMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") return value.message.slice(0, 500);
  return "GitHub API request failed.";
}

function redactSecret(message: string, token: string): string {
  let redacted = message.slice(0, 500);
  if (token) redacted = redacted.split(token).join("[REDACTED]");
  return redacted
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9]+/g, "[REDACTED]");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidResponse(`Missing ${field}.`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidResponse(`Missing ${field}.`);
  return value;
}

function canonicalTimestamp(value: unknown, field: string): string {
  const raw = requiredString(value, field);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw invalidResponse(`Invalid ${field}.`);
  return new Date(parsed).toISOString();
}

function invalidResponse(message: string): GitHubApiError {
  return new GitHubApiError("github_invalid_response", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
