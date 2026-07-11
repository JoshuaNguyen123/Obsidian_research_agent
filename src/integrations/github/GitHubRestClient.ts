import type { HttpResponse, HttpTransport } from "../../model/types";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

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

export interface GitHubRepositoryRecord {
  id: number;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
}

export interface GitHubPullRequestRecord {
  number: number;
  htmlUrl: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface GitHubCheckRunRecord {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  htmlUrl?: string;
}

export class GitHubRestClient {
  constructor(
    private readonly options: {
      transport: HttpTransport;
      token: string;
      timeoutMs?: number;
    },
  ) {}

  async getRepository(
    owner: string,
    repository: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryRecord> {
    const payload = await this.request(
      "GET",
      `/repos/${segment(owner)}/${segment(repository)}`,
      undefined,
      signal,
    );
    return normalizeRepository(payload);
  }

  async getPullRequest(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRecord> {
    const payload = await this.request(
      "GET",
      `/repos/${segment(owner)}/${segment(repository)}/pulls/${positiveInteger(number, "number")}`,
      undefined,
      signal,
    );
    return normalizePullRequest(payload);
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
    const payload = await this.request(
      "GET",
      `/repos/${segment(owner)}/${segment(repository)}/pulls?${query.toString()}`,
      undefined,
      signal,
    );
    if (!Array.isArray(payload)) {
      throw invalidResponse("Expected a pull request array.");
    }
    return payload.map(normalizePullRequest);
  }

  async listCheckRuns(
    owner: string,
    repository: string,
    reference: string,
    signal?: AbortSignal,
  ): Promise<GitHubCheckRunRecord[]> {
    const payload = await this.request(
      "GET",
      `/repos/${segment(owner)}/${segment(repository)}/commits/${encodeURIComponent(validateRef(reference))}/check-runs?per_page=100`,
      undefined,
      signal,
    );
    if (!isRecord(payload) || !Array.isArray(payload.check_runs)) {
      throw invalidResponse("Expected check_runs in the GitHub response.");
    }
    return payload.check_runs.map(normalizeCheckRun);
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
    const title = boundedText(input.title, "title", 1, 256);
    const body = boundedText(input.body, "body", 0, 65_536);
    const payload = await this.request(
      "POST",
      `/repos/${segment(input.owner)}/${segment(input.repository)}/pulls`,
      {
        title,
        body,
        head: validateRef(input.head),
        base: validateRef(input.base),
        draft: true,
      },
      signal,
    );
    return normalizePullRequest(payload);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = this.options.token.trim();
    if (!token) {
      throw new GitHubApiError(
        "github_not_configured",
        "GitHub API token is not configured.",
      );
    }
    const response = await this.options.transport({
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
    return parseResponse(response);
  }
}

function parseResponse(response: HttpResponse): unknown {
  if (response.status >= 200 && response.status < 300) {
    if (response.json === undefined) {
      throw invalidResponse("GitHub returned no JSON body.");
    }
    return response.json;
  }
  const message = safeApiMessage(response.json);
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

function normalizeRepository(value: unknown): GitHubRepositoryRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid repository response.");
  return {
    id: requiredNumber(value.id, "repository.id"),
    fullName: requiredString(value.full_name, "repository.full_name"),
    htmlUrl: requiredString(value.html_url, "repository.html_url"),
    defaultBranch: requiredString(
      value.default_branch,
      "repository.default_branch",
    ),
    private: value.private === true,
    archived: value.archived === true,
  };
}

function normalizePullRequest(value: unknown): GitHubPullRequestRecord {
  if (!isRecord(value) || !isRecord(value.head) || !isRecord(value.base)) {
    throw invalidResponse("Invalid pull request response.");
  }
  const state = value.state;
  if (state !== "open" && state !== "closed") {
    throw invalidResponse("Invalid pull request state.");
  }
  return {
    number: requiredNumber(value.number, "pull_request.number"),
    htmlUrl: requiredString(value.html_url, "pull_request.html_url"),
    state,
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
  };
}

function normalizeCheckRun(value: unknown): GitHubCheckRunRecord {
  if (!isRecord(value)) throw invalidResponse("Invalid check run response.");
  return {
    id: requiredNumber(value.id, "check_run.id"),
    name: requiredString(value.name, "check_run.name"),
    status: requiredString(value.status, "check_run.status"),
    ...(typeof value.conclusion === "string"
      ? { conclusion: value.conclusion }
      : {}),
    ...(typeof value.html_url === "string" ? { htmlUrl: value.html_url } : {}),
  };
}

function segment(value: string): string {
  if (!OWNER_REPO_PATTERN.test(value)) {
    throw new GitHubApiError(
      "github_invalid_response",
      "GitHub owner or repository identifier is invalid.",
    );
  }
  return encodeURIComponent(value);
}

function validateRef(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 255 ||
    normalized.startsWith("-") ||
    normalized.includes("..") ||
    /[\s~^:?*[\\\]]/.test(normalized)
  ) {
    throw new GitHubApiError(
      "github_invalid_response",
      "Git reference is invalid.",
    );
  }
  return normalized;
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

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubApiError(
      "github_invalid_response",
      `${field} must be a positive integer.`,
    );
  }
  return value;
}

function safeApiMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") {
    return value.message.slice(0, 500);
  }
  return "GitHub API request failed.";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidResponse(`Missing ${field}.`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidResponse(`Missing ${field}.`);
  }
  return value;
}

function invalidResponse(message: string): GitHubApiError {
  return new GitHubApiError("github_invalid_response", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

