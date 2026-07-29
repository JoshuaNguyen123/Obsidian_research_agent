import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupOwnedRepositoryWorkspaceMetadata,
  inventoryOwnedRepositoryWorkspaceMetadata,
  OWNED_REPOSITORY_WORKSPACE_METADATA_LIMITS_V1,
} from "../e2e/fixtures/ownedRepositoryWorkspaceMetadata";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const BASE_SHA = "b".repeat(40);
const CREATED_AT = "2026-07-28T12:00:00.000Z";
const EXPIRES_AT = "2026-07-29T12:00:00.000Z";

test("cleans only exact owned metadata after source and worktree absence", async () => {
  const fixture = await createFixture("exact");
  const workspaceId = "byok-owned-exact";
  const sourceRoot = path.join(fixture.root, "source-owned");
  const normalizedEquivalentSourceRoot = `${sourceRoot}${path.sep}.`;
  const worktreeRoot = path.join(fixture.worktreeParent, workspaceId);
  const container = await writeRepositoryWorkspace({
    ...fixture,
    workspaceId,
    sourceRoot: normalizedEquivalentSourceRoot,
    worktreeRoot,
  });
  try {
    const inventory = await inventoryOwnedRepositoryWorkspaceMetadata({
      applicationDataRoot: fixture.applicationDataRoot,
      repositoryRoot: sourceRoot,
    });
    assert.equal(inventory.inspectedContainers, 1);
    assert.deepEqual(
      inventory.selected.map((selection) => selection.workspaceId),
      [workspaceId],
    );
    assert.equal(inventory.selected[0]?.worktreeRoot, worktreeRoot);

    await assert.rejects(
      cleanupOwnedRepositoryWorkspaceMetadata(inventory),
      /independently removed.*absent/iu,
    );
    assert.equal((await lstat(container)).isDirectory(), true);

    await rm(sourceRoot, { recursive: true });
    await rm(worktreeRoot, { recursive: true });
    const proof = await cleanupOwnedRepositoryWorkspaceMetadata(inventory);

    assert.deepEqual(proof.selectedWorkspaceIds, [workspaceId]);
    assert.deepEqual(proof.removedMetadataContainers, [container]);
    assert.equal(proof.repositoryRootAbsent, true);
    assert.deepEqual(proof.worktreeAbsence, [
      { workspaceId, worktreeRoot, absent: true },
    ]);
    assert.deepEqual(proof.survivingWorkspaceIds, []);
    assert.equal(proof.selectedSurvivorCount, 0);
    assert.equal(proof.absenceVerified, true);
    await assert.rejects(
      lstat(container),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("preserves unrelated repository workspace metadata and worktrees", async () => {
  const fixture = await createFixture("unrelated");
  const ownedWorkspaceId = "byok-owned-target";
  const unrelatedWorkspaceId = "byok-unrelated-target";
  const sourceRoot = path.join(fixture.root, "source-owned");
  const unrelatedSourceRoot = path.join(fixture.root, "source-unrelated");
  const ownedWorktreeRoot = path.join(
    fixture.worktreeParent,
    ownedWorkspaceId,
  );
  const unrelatedWorktreeRoot = path.join(
    fixture.worktreeParent,
    unrelatedWorkspaceId,
  );
  const ownedContainer = await writeRepositoryWorkspace({
    ...fixture,
    workspaceId: ownedWorkspaceId,
    sourceRoot,
    worktreeRoot: ownedWorktreeRoot,
  });
  const unrelatedContainer = await writeRepositoryWorkspace({
    ...fixture,
    workspaceId: unrelatedWorkspaceId,
    sourceRoot: unrelatedSourceRoot,
    worktreeRoot: unrelatedWorktreeRoot,
  });
  const unrelatedManifest = path.join(
    unrelatedContainer,
    "manifest.v2.json",
  );
  try {
    const inventory = await inventoryOwnedRepositoryWorkspaceMetadata({
      applicationDataRoot: fixture.applicationDataRoot,
      repositoryRoot: sourceRoot,
    });
    assert.deepEqual(
      inventory.selected.map((selection) => selection.workspaceId),
      [ownedWorkspaceId],
    );

    await rm(sourceRoot, { recursive: true });
    await rm(ownedWorktreeRoot, { recursive: true });
    const proof = await cleanupOwnedRepositoryWorkspaceMetadata(inventory);

    assert.deepEqual(proof.selectedWorkspaceIds, [ownedWorkspaceId]);
    await assert.rejects(lstat(ownedContainer), /ENOENT/u);
    assert.equal((await lstat(unrelatedContainer)).isDirectory(), true);
    assert.equal((await lstat(unrelatedWorktreeRoot)).isDirectory(), true);
    assert.equal((await lstat(unrelatedSourceRoot)).isDirectory(), true);
    assert.match(
      await readFile(unrelatedManifest, "utf8"),
      new RegExp(unrelatedWorkspaceId, "u"),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("linked metadata containers fail closed without touching their targets", async (t) => {
  const fixture = await createFixture("linked");
  const outside = await canonicalTempDirectory("owned-workspace-outside-");
  const linkedContainer = path.join(
    fixture.metadataRoot,
    "byok-owned-linked",
  );
  const sentinel = path.join(outside, "preserve.txt");
  await writeFile(sentinel, "preserve", "utf8");
  try {
    try {
      await symlink(
        outside,
        linkedContainer,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      t.skip("directory symlink creation is unavailable");
      return;
    }
    await assert.rejects(
      inventoryOwnedRepositoryWorkspaceMetadata({
        applicationDataRoot: fixture.applicationDataRoot,
        repositoryRoot: path.join(fixture.root, "source-owned"),
      }),
      /linked entry|non-linked directory/iu,
    );
    assert.equal(await readFile(sentinel, "utf8"), "preserve");
  } finally {
    await rm(linkedContainer, { force: true }).catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("matching manifests with worktree escapes or id mismatches fail closed", async () => {
  const fixture = await createFixture("mismatch");
  const sourceRoot = path.join(fixture.root, "source-owned");
  const escapedWorkspaceId = "byok-owned-escaped";
  const escapedContainer = await writeRepositoryWorkspace({
    ...fixture,
    workspaceId: escapedWorkspaceId,
    sourceRoot,
    worktreeRoot: path.join(
      fixture.applicationDataRoot,
      "outside-worktrees",
      escapedWorkspaceId,
    ),
  });
  try {
    await assert.rejects(
      inventoryOwnedRepositoryWorkspaceMetadata({
        applicationDataRoot: fixture.applicationDataRoot,
        repositoryRoot: sourceRoot,
      }),
      /not the exact direct repository-worktrees child/iu,
    );
    assert.equal((await lstat(escapedContainer)).isDirectory(), true);

    await rm(escapedContainer, { recursive: true });
    const containerName = "byok-container-name";
    const manifestWorkspaceId = "byok-manifest-name";
    const container = path.join(fixture.metadataRoot, containerName);
    const worktreeRoot = path.join(
      fixture.worktreeParent,
      manifestWorkspaceId,
    );
    await mkdir(container);
    await mkdir(worktreeRoot);
    await writeFile(
      path.join(container, "manifest.v2.json"),
      `${JSON.stringify(
        repositoryManifest({
          workspaceId: manifestWorkspaceId,
          sourceRoot,
          worktreeRoot,
        }),
      )}\n`,
      "utf8",
    );
    await assert.rejects(
      inventoryOwnedRepositoryWorkspaceMetadata({
        applicationDataRoot: fixture.applicationDataRoot,
        repositoryRoot: sourceRoot,
      }),
      /workspace id.*container basename/iu,
    );
    assert.equal((await lstat(container)).isDirectory(), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("oversized manifest inventory is refused before parsing", async () => {
  const fixture = await createFixture("oversized");
  const container = path.join(fixture.metadataRoot, "byok-oversized");
  await mkdir(container);
  await writeFile(
    path.join(container, "manifest.v2.json"),
    " ".repeat(
      OWNED_REPOSITORY_WORKSPACE_METADATA_LIMITS_V1.maxManifestBytes + 1,
    ),
    "utf8",
  );
  try {
    await assert.rejects(
      inventoryOwnedRepositoryWorkspaceMetadata({
        applicationDataRoot: fixture.applicationDataRoot,
        repositoryRoot: path.join(fixture.root, "source-owned"),
      }),
      /manifest exceeded its byte bound/iu,
    );
    assert.equal((await lstat(container)).isDirectory(), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

interface FixturePaths {
  root: string;
  applicationDataRoot: string;
  metadataRoot: string;
  worktreeParent: string;
}

async function createFixture(name: string): Promise<FixturePaths> {
  const root = await canonicalTempDirectory(
    `owned-workspace-metadata-${name}-`,
  );
  const applicationDataRoot = path.join(root, "application-data");
  const codeRoot = path.join(applicationDataRoot, "code");
  const metadataRoot = path.join(codeRoot, "workspaces-v2");
  const worktreeParent = path.join(codeRoot, "repository-worktrees");
  await mkdir(metadataRoot, { recursive: true });
  await mkdir(worktreeParent);
  return {
    root,
    applicationDataRoot,
    metadataRoot,
    worktreeParent,
  };
}

async function canonicalTempDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function writeRepositoryWorkspace(
  input: FixturePaths & {
    workspaceId: string;
    sourceRoot: string;
    worktreeRoot: string;
  },
): Promise<string> {
  const container = path.join(input.metadataRoot, input.workspaceId);
  await mkdir(input.sourceRoot, { recursive: true });
  await mkdir(input.worktreeRoot, { recursive: true });
  await mkdir(container);
  await writeFile(
    path.join(container, "manifest.v2.json"),
    `${JSON.stringify(repositoryManifest(input), null, 2)}\n`,
    "utf8",
  );
  return container;
}

function repositoryManifest(input: {
  workspaceId: string;
  sourceRoot: string;
  worktreeRoot: string;
}) {
  return {
    version: 2,
    workspaceId: input.workspaceId,
    kind: "repository",
    ownerRunId: `run-${input.workspaceId}`,
    repositoryBinding: {
      profileKey: "byok-autonomous-python",
      repositoryRoot: input.sourceRoot,
      worktreeRoot: input.worktreeRoot,
      branch: `codex/${input.workspaceId}`,
      bindingFingerprint: FINGERPRINT,
    },
    canonicalRoot: input.worktreeRoot,
    baseSha: BASE_SHA,
    sandboxPolicy: {
      mode: "editing_only",
      provider: null,
      boundaryFingerprint: null,
      network: "disabled",
    },
    hashes: {
      files: {},
      indexFingerprint: FINGERPRINT,
    },
    validationHistory: [],
    lease: null,
    status: "active",
    expiresAt: EXPIRES_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    budget: {
      changedPaths: [],
      changedBytes: 0,
      maxChangedFiles: 100,
      maxChangedBytes: 10 * 1024 * 1024,
    },
  };
}
