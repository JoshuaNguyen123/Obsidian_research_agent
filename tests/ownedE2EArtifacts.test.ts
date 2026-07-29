import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyVaultCleanupManifest,
  restoreOwnedE2EArtifacts,
  snapshotOwnedE2EArtifacts,
  vaultCleanupManifestFromSnapshot,
} from "../e2e/fixtures/ownedE2EArtifacts";
// @ts-ignore The preflight sweeper is an intentionally unbundled Node ESM script.
import { applyLeftoverVaultCleanupManifest } from "../scripts/vault-cleanup-manifest.mjs";

async function seedVault(root: string): Promise<void> {
  await mkdir(path.join(root, "E2E Agent Tests"), { recursive: true });
  await mkdir(path.join(root, "Designs"), { recursive: true });
  await mkdir(path.join(root, "Notes"), { recursive: true });
  await mkdir(path.join(root, "Agent Memory"), { recursive: true });
  await mkdir(path.join(root, "Agent Runs", "Mission Graphs"), { recursive: true });
  await mkdir(path.join(root, "Agent Sources", "github.com"), { recursive: true });
  await mkdir(path.join(root, "Agent Work", "templates"), { recursive: true });
  await writeFile(path.join(root, "E2E Agent Tests", "before.md"), "before");
  await writeFile(path.join(root, "Designs", "e2e-before.svg"), "before-svg");
  await writeFile(path.join(root, "Notes", "user.md"), "user");
  await writeFile(path.join(root, "User note.md"), "root user note");
  await writeFile(path.join(root, "Agent Runs", "preexisting.md"), "preexisting run");
  await writeFile(
    path.join(root, "Agent Runs", "Mission Graphs", "preexisting.md"),
    "preexisting graph",
  );
  await writeFile(
    path.join(root, "Agent Sources", "github.com", "preexisting.md"),
    "preexisting source",
  );
  await writeFile(
    path.join(root, "Agent Work", "templates", "Linear issue.md"),
    "managed template",
  );
  await writeFile(
    path.join(root, "Agent Memory", "semantic-vault-index.json"),
    "semantic-before",
  );
}

async function churnVault(root: string): Promise<void> {
  await writeFile(path.join(root, "E2E Agent Tests", "created.md"), "created");
  await writeFile(path.join(root, "Designs", "e2e-created.canvas"), "created");
  await writeFile(path.join(root, "Notes", "user.md"), "still-user");
  // No content markers anywhere below: ownership is purely diff-based now.
  await writeFile(path.join(root, "Agent Runs", "run-created.md"), "mission run log");
  await writeFile(
    path.join(root, "Agent Runs", "Mission Graphs", "graph-created.md"),
    "mission graph",
  );
  await mkdir(path.join(root, "Agent Runs", "Missions"), { recursive: true });
  await writeFile(
    path.join(root, "Agent Runs", "Missions", "nested-created.md"),
    "nested run artifact",
  );
  await writeFile(
    path.join(root, "Agent Sources", "github.com", "fetched-created.md"),
    "fetched source",
  );
  await writeFile(path.join(root, "CRDT Research 123.md"), "seed note");
  await writeFile(
    path.join(root, "Agent Memory", "semantic-vault-index.json"),
    "semantic-changed",
  );
}

test("E2E cleanup removes everything the session created in machine areas, keeping baselines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "owned-e2e-artifacts-"));
  try {
    await seedVault(root);
    const snapshot = await snapshotOwnedE2EArtifacts(root);
    await churnVault(root);
    await restoreOwnedE2EArtifacts(snapshot);

    assert.equal(await readFile(path.join(root, "E2E Agent Tests", "before.md"), "utf8"), "before");
    await assert.rejects(readFile(path.join(root, "E2E Agent Tests", "created.md")), /ENOENT/u);
    assert.equal(await readFile(path.join(root, "Designs", "e2e-before.svg"), "utf8"), "before-svg");
    await assert.rejects(readFile(path.join(root, "Designs", "e2e-created.canvas")), /ENOENT/u);
    assert.equal(await readFile(path.join(root, "Notes", "user.md"), "utf8"), "still-user");
    assert.equal(await readFile(path.join(root, "User note.md"), "utf8"), "root user note");
    assert.equal(
      await readFile(path.join(root, "Agent Runs", "preexisting.md"), "utf8"),
      "preexisting run",
    );
    assert.equal(
      await readFile(path.join(root, "Agent Sources", "github.com", "preexisting.md"), "utf8"),
      "preexisting source",
    );
    assert.equal(
      await readFile(path.join(root, "Agent Work", "templates", "Linear issue.md"), "utf8"),
      "managed template",
    );
    // Everything new in machine areas is gone — no marker required.
    await assert.rejects(readFile(path.join(root, "Agent Runs", "run-created.md")), /ENOENT/u);
    await assert.rejects(
      readFile(path.join(root, "Agent Runs", "Mission Graphs", "graph-created.md")),
      /ENOENT/u,
    );
    await assert.rejects(
      readFile(path.join(root, "Agent Runs", "Missions", "nested-created.md")),
      /ENOENT/u,
    );
    await assert.rejects(
      readFile(path.join(root, "Agent Sources", "github.com", "fetched-created.md")),
      /ENOENT/u,
    );
    await assert.rejects(readFile(path.join(root, "CRDT Research 123.md")), /ENOENT/u);
    // The new empty Missions directory folded up as well.
    await assert.rejects(
      readFile(path.join(root, "Agent Runs", "Missions")),
      /(?:ENOENT|EISDIR)/u,
    );
    assert.equal(
      await readFile(path.join(root, "Agent Memory", "semantic-vault-index.json"), "utf8"),
      "semantic-before",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("E2E cleanup honors retained lane deliverables", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "owned-e2e-retain-"));
  try {
    await seedVault(root);
    const snapshot = await snapshotOwnedE2EArtifacts(root);
    await churnVault(root);
    await restoreOwnedE2EArtifacts(snapshot, {
      retainPaths: ["CRDT Research 123.md"],
    });
    assert.equal(await readFile(path.join(root, "CRDT Research 123.md"), "utf8"), "seed note");
    await assert.rejects(readFile(path.join(root, "Agent Runs", "run-created.md")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a leftover cleanup manifest lets preflight sweep a killed run's residue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "owned-e2e-manifest-"));
  const manifestPath = path.join(root, "vault-cleanup-manifest.json");
  try {
    await seedVault(root);
    const snapshot = await snapshotOwnedE2EArtifacts(root);
    const manifest = vaultCleanupManifestFromSnapshot(snapshot, [
      "CRDT Research 123.md",
    ]);
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    // Simulate the crash: churn happens, restore never runs.
    await churnVault(root);

    const swept = await applyLeftoverVaultCleanupManifest(manifestPath, root);
    assert.equal(swept.applied, true);
    assert.ok(swept.removedFiles >= 5, `removed ${swept.removedFiles}`);
    await assert.rejects(readFile(path.join(root, "Agent Runs", "run-created.md")), /ENOENT/u);
    await assert.rejects(
      readFile(path.join(root, "Agent Sources", "github.com", "fetched-created.md")),
      /ENOENT/u,
    );
    // A killed run's seed note in the owned tree is swept too; the baseline
    // tree file survives.
    await assert.rejects(
      readFile(path.join(root, "E2E Agent Tests", "created.md")),
      /ENOENT/u,
    );
    assert.equal(
      await readFile(path.join(root, "E2E Agent Tests", "before.md"), "utf8"),
      "before",
    );
    assert.equal(await readFile(path.join(root, "CRDT Research 123.md"), "utf8"), "seed note");
    assert.equal(
      await readFile(path.join(root, "Agent Runs", "preexisting.md"), "utf8"),
      "preexisting run",
    );
    // Manifest consumed; a second call is a no-op.
    const again = await applyLeftoverVaultCleanupManifest(manifestPath, root);
    assert.deepEqual(again, { applied: false, removedFiles: 0 });
    // The TS-side applier agrees with the mjs sweeper on the same contract.
    const tsResult = await applyVaultCleanupManifest(manifest);
    assert.equal(tsResult.removedFiles, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a leftover cleanup manifest cannot target a different vault", async () => {
  const expectedRoot = await mkdtemp(
    path.join(os.tmpdir(), "owned-e2e-expected-vault-"),
  );
  const foreignRoot = await mkdtemp(
    path.join(os.tmpdir(), "owned-e2e-foreign-vault-"),
  );
  const manifestPath = path.join(expectedRoot, "vault-cleanup-manifest.json");
  try {
    await seedVault(foreignRoot);
    const manifest = vaultCleanupManifestFromSnapshot(
      await snapshotOwnedE2EArtifacts(foreignRoot),
    );
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const foreignArtifact = path.join(
      foreignRoot,
      "E2E Agent Tests",
      "foreign-after-manifest.md",
    );
    await writeFile(foreignArtifact, "preserve", "utf8");

    await assert.rejects(
      applyLeftoverVaultCleanupManifest(manifestPath, expectedRoot),
      /does not match the current isolated vault/u,
    );
    assert.equal(await readFile(foreignArtifact, "utf8"), "preserve");
    assert.match(await readFile(manifestPath, "utf8"), /"version":1/u);
  } finally {
    await rm(expectedRoot, { recursive: true, force: true });
    await rm(foreignRoot, { recursive: true, force: true });
  }
});

test("E2E cleanup refuses a linked recursive cleanup target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "owned-e2e-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "owned-e2e-outside-"));
  try {
    const snapshot = await snapshotOwnedE2EArtifacts(root);
    await symlink(outside, path.join(root, "E2E Agent Tests"), "junction");
    await assert.rejects(restoreOwnedE2EArtifacts(snapshot), /linked/u);
  } finally {
    await rm(path.join(root, "E2E Agent Tests"), { force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("E2E cleanup refuses a linked Mission Graphs target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "owned-e2e-graph-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "owned-e2e-graph-outside-"));
  try {
    await mkdir(path.join(root, "Agent Runs"), { recursive: true });
    const snapshot = await snapshotOwnedE2EArtifacts(root);
    await symlink(outside, path.join(root, "Agent Runs", "Mission Graphs"), "junction");
    await assert.rejects(restoreOwnedE2EArtifacts(snapshot), /linked/u);
  } finally {
    await rm(path.join(root, "Agent Runs", "Mission Graphs"), { force: true }).catch(
      () => undefined,
    );
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
