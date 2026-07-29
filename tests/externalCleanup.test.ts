import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupExactOwnedLinearIssuePermanently,
  cleanupExactOwnedLinearIssueToTrash,
  cleanupLinearResourceIfPresent,
  DisposableExternalCleanupManifest,
  filterActiveLinearIssueReadbacks,
  KNOWN_E2E_GITHUB_RESIDUE_REPOSITORY_NAMES,
  orderGitHubHarnessTokensForPush,
  preflightDisposableRepositoryDeleteAuthority,
  proveRestCreateAndDeleteProbe,
  proveRestRepositoryAdministration,
  safeExternalCleanupError,
} from "../e2e/fixtures/externalCleanup";
import { GitHubApiError } from "../src/integrations/github/GitHubRestClient";

test("GitHub harness tokens prefer repo-scoped classic/OAuth credentials for push", () => {
  const fineGrained = `github_pat_${"a".repeat(24)}`;
  const oauth = `gho_${"b".repeat(24)}`;
  assert.deepEqual(
    orderGitHubHarnessTokensForPush([
      fineGrained,
      oauth,
      fineGrained,
    ]),
    [oauth, fineGrained],
  );
});

test("external cleanup runs every registered resource in reverse order and aggregates failures", async () => {
  const observed: string[] = [];
  const manifest = new DisposableExternalCleanupManifest();

  manifest.register("Linear", async () => {
    observed.push("linear");
  });
  manifest.register("Workspace", async () => {
    observed.push("workspace");
    throw new Error("workspace cleanup failed");
  });
  manifest.register("GitHub", async () => {
    observed.push("github");
  });

  assert.deepEqual(await manifest.cleanupAll(), [
    "Workspace: workspace cleanup failed",
  ]);
  assert.deepEqual(observed, ["github", "workspace", "linear"]);
});

test("registerAtCreate is immediate idempotent and known residue list is fixed", async () => {
  const observed: string[] = [];
  const manifest = new DisposableExternalCleanupManifest();
  manifest.registerAtCreate("GitHub cleanup", async () => {
    observed.push("github");
  });
  manifest.registerAtCreate("GitHub cleanup", async () => {
    observed.push("duplicate");
  });
  assert.equal(manifest.size(), 1);
  assert.deepEqual(await manifest.cleanupAll(), []);
  assert.deepEqual(observed, ["github"]);
  assert.equal(KNOWN_E2E_GITHUB_RESIDUE_REPOSITORY_NAMES.length, 7);
  assert.ok(
    KNOWN_E2E_GITHUB_RESIDUE_REPOSITORY_NAMES.includes(
      "e2e-number-guess-5791ec950ef7",
    ),
  );
});

test("Linear cleanup pattern skips missing ids and trashes present ones", async () => {
  const trashed: string[] = [];
  assert.equal(
    await cleanupLinearResourceIfPresent({
      resourceId: null,
      trash: async (id) => {
        trashed.push(id);
      },
    }),
    "skipped",
  );
  assert.equal(
    await cleanupLinearResourceIfPresent({
      resourceId: " issue-1 ",
      trash: async (id) => {
        trashed.push(id);
      },
    }),
    "trashed",
  );
  assert.deepEqual(trashed, ["issue-1"]);
});

test("exact Linear cleanup trashes before permanent deletion and proves provider absence", async () => {
  const calls: string[] = [];
  let state: "active" | "trashed" | "absent" = "active";
  const issue = {
    id: "issue-owned-1234",
    teamId: "team-owned",
    title: "Disposable BYOK_AUTONOMOUS_abcdef123456",
    description: "Owned proof fixture",
  };

  const result = await cleanupExactOwnedLinearIssuePermanently({
    issueId: issue.id,
    marker: "BYOK_AUTONOMOUS_abcdef123456",
    teamId: issue.teamId,
    readIssue: async () => {
      calls.push(`read:${state}`);
      return state === "absent"
        ? null
        : { ...issue, trashed: state === "trashed" };
    },
    trashIssue: async () => {
      calls.push("trash");
      state = "trashed";
    },
    deleteIssuePermanently: async () => {
      calls.push("delete_permanently");
      assert.equal(
        state,
        "trashed",
        "the provider lifecycle must never hard-delete an active issue",
      );
      state = "absent";
    },
    findMarkerSurvivors: async () => {
      calls.push("scan");
      return [];
    },
    wait: async () => undefined,
  });

  assert.deepEqual(result, {
    version: 1,
    issueId: issue.id,
    initialState: "active",
    trashed: true,
    permanentlyDeleted: true,
    verifiedAbsent: true,
  });
  assert.deepEqual(calls, [
    "read:active",
    "trash",
    "read:trashed",
    "delete_permanently",
    "read:absent",
    "scan",
  ]);
});

test("ordinary exact Linear cleanup proves trashed retention without claiming absence", async () => {
  const calls: string[] = [];
  let state: "active" | "trashed" = "active";
  const issue = {
    id: "issue-owned-trash-1",
    teamId: "team-owned",
    title: "Disposable BYOK_AUTONOMOUS_a1b2c3d4e5f6",
    description: "Owned proof fixture",
  };
  const result = await cleanupExactOwnedLinearIssueToTrash({
    issueId: issue.id,
    marker: "BYOK_AUTONOMOUS_a1b2c3d4e5f6",
    teamId: issue.teamId,
    readIssue: async () => ({
      ...issue,
      trashed: state === "trashed",
    }),
    trashIssue: async () => {
      calls.push("trash");
      state = "trashed";
    },
    findActiveMarkerSurvivors: async () => {
      calls.push("active-scan");
      return [];
    },
    wait: async () => undefined,
  });
  assert.deepEqual(result, {
    version: 1,
    issueId: issue.id,
    initialState: "active",
    trashApplied: true,
    terminalState: "trashed",
    verifiedNoActiveMarkerIssue: true,
  });
  assert.deepEqual(calls, ["trash", "active-scan"]);
});

test("ordinary exact Linear cleanup retries transient reads without replaying the mutation", async () => {
  let reads = 0;
  let scans = 0;
  let trashCalls = 0;
  let state: "active" | "trashed" = "active";
  const owned = {
    id: "issue-owned-transient-1",
    teamId: "team-owned",
    title: "BYOK_AUTONOMOUS_abcdef654321",
    description: "Disposable proof fixture",
  };
  const waits: number[] = [];

  const result = await cleanupExactOwnedLinearIssueToTrash({
    issueId: owned.id,
    marker: "BYOK_AUTONOMOUS_abcdef654321",
    teamId: owned.teamId,
    readIssue: async () => {
      reads += 1;
      if (reads === 1 || reads === 3) {
        throw new Error(
          'page.evaluate: LinearClientError: Linear network request failed: Unexpected token "u", "upstream c"... is not valid JSON',
        );
      }
      return { ...owned, trashed: state === "trashed" };
    },
    trashIssue: async () => {
      trashCalls += 1;
      state = "trashed";
    },
    findActiveMarkerSurvivors: async () => {
      scans += 1;
      if (scans === 1) {
        throw Object.assign(new Error("temporary provider timeout"), {
          code: "linear_timeout",
          retryable: true,
        });
      }
      return [];
    },
    wait: async (delayMs) => {
      waits.push(delayMs);
    },
  });

  assert.equal(result.terminalState, "trashed");
  assert.equal(result.verifiedNoActiveMarkerIssue, true);
  assert.equal(trashCalls, 1);
  assert.equal(reads, 4);
  assert.equal(scans, 2);
  assert.deepEqual(waits, [250, 250, 250]);
});

test("ordinary exact Linear cleanup does not retry non-transient read failures", async () => {
  let reads = 0;
  let trashCalls = 0;
  await assert.rejects(
    cleanupExactOwnedLinearIssueToTrash({
      issueId: "issue-owned-forbidden-1",
      marker: "BYOK_AUTONOMOUS_012345abcdef",
      teamId: "team-owned",
      readIssue: async () => {
        reads += 1;
        throw Object.assign(new Error("Linear denied access."), {
          code: "linear_forbidden",
          retryable: false,
        });
      },
      trashIssue: async () => {
        trashCalls += 1;
      },
      findActiveMarkerSurvivors: async () => [],
      wait: async () => undefined,
    }),
    /denied access/iu,
  );
  assert.equal(reads, 1);
  assert.equal(trashCalls, 0);
});

test("ordinary exact Linear cleanup exhausts transient read retries before any mutation", async () => {
  let reads = 0;
  let trashCalls = 0;
  const waits: number[] = [];
  await assert.rejects(
    cleanupExactOwnedLinearIssueToTrash({
      issueId: "issue-owned-transient-exhausted-1",
      marker: "BYOK_AUTONOMOUS_deadbeef1234",
      teamId: "team-owned",
      readIssue: async () => {
        reads += 1;
        throw Object.assign(new Error("temporary provider timeout"), {
          code: "linear_timeout",
          retryable: true,
        });
      },
      trashIssue: async () => {
        trashCalls += 1;
      },
      findActiveMarkerSurvivors: async () => [],
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    }),
    /temporary provider timeout/iu,
  );
  assert.equal(reads, 3);
  assert.equal(trashCalls, 0);
  assert.deepEqual(waits, [250, 500]);
});

test("ordinary exact Linear cleanup rechecks ownership after a transient read", async () => {
  let reads = 0;
  let trashCalls = 0;
  const waits: number[] = [];
  await assert.rejects(
    cleanupExactOwnedLinearIssueToTrash({
      issueId: "issue-owned-drift-after-transient-1",
      marker: "BYOK_AUTONOMOUS_badcafe12345",
      teamId: "team-owned",
      readIssue: async () => {
        reads += 1;
        if (reads === 1) {
          throw Object.assign(new Error("temporary provider timeout"), {
            code: "linear_timeout",
            retryable: true,
          });
        }
        return {
          id: "issue-owned-drift-after-transient-1",
          teamId: "different-team",
          title: "BYOK_AUTONOMOUS_badcafe12345",
          description: "Ownership drifted before cleanup.",
          trashed: false,
        };
      },
      trashIssue: async () => {
        trashCalls += 1;
      },
      findActiveMarkerSurvivors: async () => [],
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    }),
    /failed its ID, marker, or team ownership check/iu,
  );
  assert.equal(reads, 2);
  assert.equal(trashCalls, 0);
  assert.deepEqual(waits, [250]);
});

test("active Linear marker scans exclude provider-retained trashed issues", () => {
  assert.deepEqual(
    filterActiveLinearIssueReadbacks([
      { id: "active-1", trashed: false },
      { id: "recently-deleted-1", trashed: true },
      { id: "active-2", trashed: false },
    ]),
    [
      { id: "active-1", trashed: false },
      { id: "active-2", trashed: false },
    ],
  );
});

test("exact Linear cleanup resumes from trash but refuses ownership drift before mutation", async () => {
  const mutations: string[] = [];
  let state: "trashed" | "absent" = "trashed";
  const owned = {
    id: "issue-owned-5678",
    teamId: "team-owned",
    title: "BYOK_AUTONOMOUS_123456abcdef",
    description: "Disposable proof fixture",
  };
  const resumed = await cleanupExactOwnedLinearIssuePermanently({
    issueId: owned.id,
    marker: "BYOK_AUTONOMOUS_123456abcdef",
    teamId: owned.teamId,
    readIssue: async () =>
      state === "absent" ? null : { ...owned, trashed: true },
    trashIssue: async () => {
      mutations.push("trash");
    },
    deleteIssuePermanently: async () => {
      mutations.push("delete_permanently");
      state = "absent";
    },
    findMarkerSurvivors: async () => [],
    wait: async () => undefined,
  });
  assert.equal(resumed.initialState, "trashed");
  assert.equal(resumed.trashed, false);
  assert.equal(resumed.permanentlyDeleted, true);
  assert.deepEqual(mutations, ["delete_permanently"]);

  mutations.length = 0;
  await assert.rejects(
    cleanupExactOwnedLinearIssuePermanently({
      issueId: owned.id,
      marker: "BYOK_AUTONOMOUS_123456abcdef",
      teamId: owned.teamId,
      readIssue: async () => ({
        ...owned,
        teamId: "wrong-team",
        trashed: false,
      }),
      trashIssue: async () => {
        mutations.push("trash");
      },
      deleteIssuePermanently: async () => {
        mutations.push("delete_permanently");
      },
      findMarkerSurvivors: async () => [],
      wait: async () => undefined,
    }),
    /failed its ID, marker, or team ownership check/iu,
  );
  assert.deepEqual(mutations, []);
});

test("REST admin proof accepts permissions.admin on residue repos", async () => {
  const client = {
    async getRepository(_owner: string, repository: string) {
      if (repository === "e2e-number-guess-5791ec950ef7") {
        return { permissions: { admin: true, push: true, pull: true } };
      }
      throw new GitHubApiError("github_not_found", "missing", 404);
    },
  };
  assert.equal(
    await proveRestRepositoryAdministration(client as never, "owner"),
    true,
  );
  const denied = {
    async getRepository() {
      throw new GitHubApiError("github_forbidden", "forbidden", 403);
    },
  };
  assert.equal(
    await proveRestRepositoryAdministration(denied as never, "owner"),
    false,
  );
});

test("disposable delete preflight proves REST via create+delete probe", async () => {
  const created: string[] = [];
  const deleted: string[] = [];
  const registered: string[] = [];
  const client = {
    async getAuthenticatedUser() {
      return { id: 7, login: "owner", htmlUrl: "https://github.com/owner" };
    },
    async getRepository(_owner: string, repository: string) {
      if (deleted.includes(repository) || !created.includes(repository)) {
        throw new GitHubApiError("github_not_found", "gone", 404);
      }
      return {
        id: 42,
        fullName: `owner/${repository}`,
        private: true,
        archived: false,
        permissions: {
          admin: true,
          maintain: true,
          push: true,
          triage: true,
          pull: true,
        },
      };
    },
    async createPrivateRepository(input: {
      repository: string;
    }) {
      assert.deepEqual(
        registered,
        [input.repository],
        "the cleanup identity must be registered before provider create",
      );
      created.push(input.repository);
      return {
        id: 42,
        fullName: `owner/${input.repository}`,
        private: true,
        archived: false,
      };
    },
    async deleteRepository(_owner: string, repository: string) {
      deleted.push(repository);
    },
  };
  const result = await preflightDisposableRepositoryDeleteAuthority({
    client: client as never,
    owner: "owner",
    onProbeRegistered: ({ repository }) => {
      registered.push(repository);
    },
  });
  assert.equal(result.via, "rest_probe");
  assert.equal(created.length, 1);
  assert.equal(deleted.length, 1);
  assert.deepEqual(registered, created);
  assert.match(created[0]!, /^e2e-delete-probe-/u);
});

test("REST delete probe rejects an actor mismatch before provider create", async () => {
  let created = false;
  const client = {
    async getAuthenticatedUser() {
      return { id: 8, login: "someone-else", htmlUrl: "https://github.com/x" };
    },
    async createPrivateRepository() {
      created = true;
      throw new Error("must not create");
    },
  };
  await assert.rejects(
    proveRestCreateAndDeleteProbe(
      client as never,
      "owner",
      () => {
        throw new Error("must not register");
      },
    ),
    /actor someone-else does not match expected owner owner/iu,
  );
  assert.equal(created, false);
});

test("external cleanup diagnostics redact GitHub and Linear credential shapes", () => {
  const message = safeExternalCleanupError(
    new Error(
      "github_pat_secret-value ghp_other-secret lin_api_linear-secret Bearer bearer-secret",
    ),
  );

  assert.doesNotMatch(message, /secret-value|other-secret|linear-secret|bearer-secret/u);
  assert.match(message, /\[REDACTED\]/u);
});
