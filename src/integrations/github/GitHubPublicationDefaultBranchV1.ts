import type {
  GitHubReferenceRecord,
  GitHubRepositoryRecord,
} from "./GitHubRestClient";
import {
  repositoryVisibilityFromReadback,
  type RepositoryVisibility,
} from "./RepositoryVisibility";

export interface GitHubPublicationDefaultBranchClientV1 {
  getRepository(
    owner: string,
    repository: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryRecord>;
  getReference(
    owner: string,
    repository: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitHubReferenceRecord>;
  updateRepositoryDefaultBranch(
    owner: string,
    repository: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryRecord>;
}

export interface EnsureGitHubPublicationDefaultBranchInputV1 {
  owner: string;
  repository: string;
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
  /** Defaults to private for V1 callers and persisted private workflows. */
  expectedVisibility?: RepositoryVisibility;
}

export interface GitHubPublicationDefaultBranchProofV1 {
  status: "already_verified" | "updated_verified";
  previousDefaultBranch: string;
  repository: GitHubRepositoryRecord;
  baseReference: GitHubReferenceRecord;
  headReference: GitHubReferenceRecord;
}

/**
 * GitHub chooses one of the first refs pushed to a new empty repository as its
 * default branch. An atomic base+agent push can therefore leave the exact
 * agent branch as the default even though the trusted base ref also exists.
 *
 * This bounded repair accepts only that one transition state. Both refs must
 * still match the verified local handoff before the repository default is
 * changed, and all repository/ref evidence is independently read back after
 * the mutation.
 */
export async function ensureGitHubPublicationDefaultBranchV1(
  client: GitHubPublicationDefaultBranchClientV1,
  input: EnsureGitHubPublicationDefaultBranchInputV1,
  signal?: AbortSignal,
): Promise<GitHubPublicationDefaultBranchProofV1> {
  const owner = githubName(input.owner, "GitHub owner");
  const repository = githubName(input.repository, "GitHub repository");
  const baseBranch = gitBranch(input.baseBranch, "GitHub base branch");
  const headBranch = gitBranch(input.headBranch, "GitHub head branch");
  const baseSha = gitSha(input.baseSha, "GitHub base SHA");
  const headSha = gitSha(input.headSha, "GitHub head SHA");
  if (baseBranch === headBranch || !headBranch.startsWith("codex/")) {
    throw new Error(
      "GitHub publication default-branch repair requires distinct trusted base and agent branches.",
    );
  }

  const before = await client.getRepository(owner, repository, signal);
  const expectedVisibility = input.expectedVisibility ?? "private";
  assertExactRepository(before, owner, repository, expectedVisibility);
  const beforeReferences = await readExactReferences(
    client,
    { owner, repository, baseBranch, baseSha, headBranch, headSha },
    signal,
  );
  if (before.defaultBranch === baseBranch) {
    return {
      status: "already_verified",
      previousDefaultBranch: before.defaultBranch,
      repository: before,
      ...beforeReferences,
    };
  }
  if (before.defaultBranch !== headBranch) {
    throw new Error(
      "GitHub repository default branch drifted outside the exact empty-repository publication transition.",
    );
  }

  await client.updateRepositoryDefaultBranch(
    owner,
    repository,
    baseBranch,
    signal,
  );
  const after = await client.getRepository(owner, repository, signal);
  assertExactRepository(after, owner, repository, expectedVisibility);
  if (
    after.id !== before.id ||
    after.defaultBranch !== baseBranch
  ) {
    throw new Error(
      "GitHub default-branch readback did not match the exact trusted base branch.",
    );
  }
  const afterReferences = await readExactReferences(
    client,
    { owner, repository, baseBranch, baseSha, headBranch, headSha },
    signal,
  );
  return {
    status: "updated_verified",
    previousDefaultBranch: before.defaultBranch,
    repository: after,
    ...afterReferences,
  };
}

async function readExactReferences(
  client: GitHubPublicationDefaultBranchClientV1,
  input: {
    owner: string;
    repository: string;
    baseBranch: string;
    baseSha: string;
    headBranch: string;
    headSha: string;
  },
  signal?: AbortSignal,
): Promise<{
  baseReference: GitHubReferenceRecord;
  headReference: GitHubReferenceRecord;
}> {
  const [baseReference, headReference] = await Promise.all([
    client.getReference(
      input.owner,
      input.repository,
      input.baseBranch,
      signal,
    ),
    client.getReference(
      input.owner,
      input.repository,
      input.headBranch,
      signal,
    ),
  ]);
  if (
    baseReference.ref !== `refs/heads/${input.baseBranch}` ||
    baseReference.sha.toLowerCase() !== input.baseSha
  ) {
    throw new Error(
      "GitHub base branch no longer matches the exact verified local base SHA.",
    );
  }
  if (
    headReference.ref !== `refs/heads/${input.headBranch}` ||
    headReference.sha.toLowerCase() !== input.headSha
  ) {
    throw new Error(
      "GitHub agent branch no longer matches the exact verified local head SHA.",
    );
  }
  return { baseReference, headReference };
}

function assertExactRepository(
  value: GitHubRepositoryRecord,
  owner: string,
  repository: string,
  expectedVisibility: RepositoryVisibility,
): void {
  if (
    repositoryVisibilityFromReadback(value) !== expectedVisibility ||
    value.archived ||
    value.fullName.toLowerCase() !== `${owner}/${repository}`.toLowerCase()
  ) {
    throw new Error(
      `GitHub publication requires the exact active ${expectedVisibility} repository.`,
    );
  }
}

function githubName(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function gitBranch(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\s~^:?*[\\\]]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function gitSha(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
