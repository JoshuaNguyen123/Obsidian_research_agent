import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  GitHubApiError,
  type GitHubRestClient,
} from "../../src/integrations/github/GitHubRestClient";

const execFileAsync = promisify(execFile);

/**
 * Known disposable GitHub repositories left by prior live compound/smoke runs.
 * Operator cleanup: `npm run cleanup:e2e-github-residue -- --execute`
 * (requires authenticated gh with delete_repo / a PAT that can delete).
 */
export const KNOWN_E2E_GITHUB_RESIDUE_REPOSITORY_NAMES = Object.freeze([
  "e2e-number-guess-5791ec950ef7",
  "e2e-compound-smoke-6025ad99b010",
  "e2e-compound-smoke-0ef7b19fcda1",
  "e2e-flow-real-f17e0747ef9d",
  "e2e-flow-real-88f06a57bd68",
  "e2e-compound-smoke-1621b6c837e7",
  "e2e-compound-smoke-59c14013e558",
] as const);

/**
 * Prefer classic/OAuth `repo` credentials for the compound push lane. A
 * fine-grained PAT may have Administration:write (repo create/delete) while
 * lacking Contents:write on the newly-created repository.
 */
export function orderGitHubHarnessTokensForPush(
  candidates: readonly string[],
): string[] {
  const unique = [...new Set(candidates.map((token) => token.trim()).filter(Boolean))];
  return unique.sort((left, right) => {
    const leftClassic = /^gh[pousr]_[A-Za-z0-9]{20,500}$/u.test(left);
    const rightClassic = /^gh[pousr]_[A-Za-z0-9]{20,500}$/u.test(right);
    return Number(rightClassic) - Number(leftClassic);
  });
}

/**
 * The live lanes create provider resources in stages.  Keep their cleanup
 * host-owned and LIFO: a later resource is removed before an earlier resource
 * that it may reference.  All callbacks run so one residue never hides another.
 */
export class DisposableExternalCleanupManifest {
  private readonly entries: Array<{ label: string; cleanup: () => Promise<void> }> = [];
  private readonly labels = new Set<string>();

  /**
   * Register cleanup immediately when the resource identity is known (or when
   * the test binds a suffix-scoped name before create). Duplicate labels are
   * ignored so create-path and preflight registration cannot double-delete.
   */
  register(label: string, cleanup: () => Promise<void>): void {
    const key = label.trim();
    if (!key || this.labels.has(key)) return;
    this.labels.add(key);
    this.entries.push({ label: key, cleanup });
  }

  /** Alias for register-at-create call sites in compound/live specs. */
  registerAtCreate(label: string, cleanup: () => Promise<void>): void {
    this.register(label, cleanup);
  }

  size(): number {
    return this.entries.length;
  }

  async cleanupAll(): Promise<string[]> {
    const failures: string[] = [];
    for (const entry of [...this.entries].reverse()) {
      try {
        await entry.cleanup();
      } catch (error) {
        failures.push(`${entry.label}: ${safeExternalCleanupError(error)}`);
      }
    }
    return failures;
  }
}

/**
 * CLI deletion is only a fallback.  Prove its classic/OAuth authority before
 * any disposable repository can be created, rather than discovering a leak
 * after REST deletion fails.
 */
export async function preflightGhRepositoryDeleteAuthority(): Promise<void> {
  const { stdout, stderr } = await execFileAsync(
    "gh",
    ["auth", "status", "-h", "github.com"],
    { windowsHide: true, timeout: 30_000 },
  );
  const status = `${String(stdout)}\n${String(stderr)}`;
  if (!/(?:^|[\s,'"])delete_repo(?:$|[\s,'"])/mu.test(status)) {
    throw new Error(
      "Disposable GitHub creation is blocked: the active gh OAuth/classic token lacks delete_repo fallback authority. Run gh auth refresh -h github.com -s delete_repo, then rerun.",
    );
  }
}

/**
 * Prove disposable-repo deletion authority before any live mission create.
 *
 * 1. Best-effort clear known residue via REST.
 * 2. Prove the live REST credential can create+delete a tiny private probe
 *    (handles fine-grained PATs that 404 old residue they cannot see).
 * 3. Fall back to gh CLI delete_repo when REST cannot prove.
 */
export async function preflightDisposableRepositoryDeleteAuthority(input?: {
  client?: GitHubRestClient | null;
  owner?: string | null;
}): Promise<{
  via: "rest_probe" | "rest_delete" | "gh_delete_repo";
  residue?: Awaited<ReturnType<typeof cleanupKnownE2EGitHubResidue>>;
}> {
  const owner = input?.owner?.trim() || "";
  const client = input?.client ?? null;
  let residue: Awaited<ReturnType<typeof cleanupKnownE2EGitHubResidue>> | undefined;
  if (client && owner) {
    residue = await cleanupKnownE2EGitHubResidue({ client, owner });
    const deleted = residue.some((item) => item.status === "deleted");
    try {
      await proveRestCreateAndDeleteProbe(client, owner);
      return {
        via: deleted ? "rest_delete" : "rest_probe",
        residue,
      };
    } catch (restError) {
      try {
        await preflightGhRepositoryDeleteAuthority();
        return { via: "gh_delete_repo", residue };
      } catch (ghError) {
        throw new Error(
          [
            "Disposable GitHub creation is blocked: REST create+delete probe failed and gh lacks delete_repo.",
            residue
              ? `residue=${residue.map((item) => `${item.repository}:${item.status}`).join(",")}`
              : "",
            `rest=${safeExternalCleanupError(restError)}`,
            `gh=${safeExternalCleanupError(ghError)}`,
            "Fix: vault/E2E fine-grained github_pat_ with Administration:write (and Contents), or gh auth refresh -h github.com -s delete_repo.",
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
    }
  }
  try {
    await preflightGhRepositoryDeleteAuthority();
    return { via: "gh_delete_repo", residue };
  } catch (error) {
    throw new Error(
      [
        "Disposable GitHub creation is blocked: no REST client/owner was supplied and gh lacks delete_repo.",
        safeExternalCleanupError(error),
        "Fix: use a vault/E2E fine-grained github_pat_ with Administration:write, or run gh auth refresh -h github.com -s delete_repo.",
      ].join(" "),
    );
  }
}

/** Create a private probe repository and delete it to prove Administration:write. */
export async function proveRestCreateAndDeleteProbe(
  client: GitHubRestClient,
  owner: string,
): Promise<void> {
  const login = owner.trim();
  if (!login) {
    throw new Error("GitHub owner is required for the delete probe.");
  }
  const repository = `e2e-delete-probe-${Date.now().toString(36).slice(-6)}`;
  await client.createPrivateRepository({
    owner: login,
    ownerKind: "user",
    repository,
    description: "Agentic Researcher disposable delete-authority probe",
  });
  await deleteDisposableGitHubRepositoryAndVerify({
    client,
    owner: login,
    repository,
  });
}

/** True when the REST credential has admin on at least one owned probe repo. */
export async function proveRestRepositoryAdministration(
  client: GitHubRestClient,
  owner: string,
): Promise<boolean> {
  const login = owner.trim();
  if (!login) return false;
  for (const repository of KNOWN_E2E_GITHUB_RESIDUE_REPOSITORY_NAMES) {
    try {
      const remote = await client.getRepository(login, repository);
      if (remote.permissions?.admin === true) {
        return true;
      }
    } catch (error) {
      if (error instanceof GitHubApiError && error.code === "github_not_found") {
        continue;
      }
      // Permission/auth failures mean this credential cannot administer.
      if (error instanceof GitHubApiError) {
        return false;
      }
      throw error;
    }
  }
  // No residue repo present: probe by reading the authenticated user and a
  // non-mutating permissions check is unavailable without a target. Fall through.
  return false;
}

/**
 * Delete every present known-residue repository with REST (+ gh fallback).
 * Returns per-repo outcomes for operator logs / e2e setup.
 */
export async function cleanupKnownE2EGitHubResidue(input: {
  client: GitHubRestClient;
  owner: string;
}): Promise<Array<{ repository: string; status: "absent" | "deleted" | "failed"; detail?: string }>> {
  const outcomes: Array<{
    repository: string;
    status: "absent" | "deleted" | "failed";
    detail?: string;
  }> = [];
  for (const repository of KNOWN_E2E_GITHUB_RESIDUE_REPOSITORY_NAMES) {
    try {
      const before = await readExactRepositoryState(
        input.client,
        input.owner,
        repository,
      );
      if (before === "absent") {
        outcomes.push({ repository, status: "absent" });
        continue;
      }
      await deleteDisposableGitHubRepositoryAndVerify({
        client: input.client,
        owner: input.owner,
        repository,
      });
      outcomes.push({ repository, status: "deleted" });
    } catch (error) {
      outcomes.push({
        repository,
        status: "failed",
        detail: safeExternalCleanupError(error),
      });
    }
  }
  return outcomes;
}

export async function deleteDisposableGitHubRepositoryAndVerify(input: {
  client: GitHubRestClient;
  owner: string;
  repository: string;
}): Promise<void> {
  const before = await readExactRepositoryState(input.client, input.owner, input.repository);
  if (before === "absent") return;

  let restError: unknown = null;
  try {
    await input.client.deleteRepository(input.owner, input.repository);
  } catch (error) {
    restError = error;
    try {
      await execFileAsync(
        "gh",
        ["repo", "delete", `${input.owner}/${input.repository}`, "--yes"],
        { windowsHide: true, timeout: 60_000 },
      );
    } catch (cliError) {
      throw new Error(
        `REST deletion failed (${safeExternalCleanupError(restError)}); gh fallback also failed (${safeExternalCleanupError(cliError)}).`,
      );
    }
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await readExactRepositoryState(input.client, input.owner, input.repository) === "absent") return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(
    `GitHub repository ${input.owner}/${input.repository} survived cleanup${restError ? ` after REST fallback (${safeExternalCleanupError(restError)})` : ""}.`,
  );
}

/**
 * Linear cleanup pattern for live specs: no-op when the id was never created;
 * otherwise run the host trash callback and require the caller to prove absence.
 */
export async function cleanupLinearResourceIfPresent(input: {
  resourceId: string | null | undefined;
  trash: (id: string) => Promise<void>;
}): Promise<"skipped" | "trashed"> {
  const id = input.resourceId?.trim();
  if (!id) return "skipped";
  await input.trash(id);
  return "trashed";
}

/** A 403/inaccessible response is never absence; only an authenticated API 404 is. */
export async function readExactRepositoryState(
  client: GitHubRestClient,
  owner: string,
  repository: string,
): Promise<"present" | "absent"> {
  try {
    await client.getRepository(owner, repository);
    return "present";
  } catch (error) {
    if (error instanceof GitHubApiError && error.code === "github_not_found") return "absent";
    throw error;
  }
}

export function safeExternalCleanupError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/(?:github_pat_|gh[opusr]_)[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/(?:lin_api_|Bearer\s+)[^\s,;]+/giu, "[REDACTED]")
    .slice(0, 1_000);
}
