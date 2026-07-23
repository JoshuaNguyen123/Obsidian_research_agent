import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupLinearResourceIfPresent,
  DisposableExternalCleanupManifest,
  KNOWN_E2E_GITHUB_RESIDUE_REPOSITORY_NAMES,
  preflightDisposableRepositoryDeleteAuthority,
  proveRestRepositoryAdministration,
  safeExternalCleanupError,
} from "../e2e/fixtures/externalCleanup";
import { GitHubApiError } from "../src/integrations/github/GitHubRestClient";

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
  const client = {
    async getRepository(_owner: string, repository: string) {
      if (deleted.includes(repository) || !created.includes(repository)) {
        throw new GitHubApiError("github_not_found", "gone", 404);
      }
      return { permissions: { admin: true, push: true, pull: true } };
    },
    async createPrivateRepository(input: {
      repository: string;
    }) {
      created.push(input.repository);
      return { name: input.repository, private: true };
    },
    async deleteRepository(_owner: string, repository: string) {
      deleted.push(repository);
    },
  };
  const result = await preflightDisposableRepositoryDeleteAuthority({
    client: client as never,
    owner: "owner",
  });
  assert.equal(result.via, "rest_probe");
  assert.equal(created.length, 1);
  assert.equal(deleted.length, 1);
  assert.match(created[0]!, /^e2e-delete-probe-/u);
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
