import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cleanupOwnedExportDirectory,
  extractWorkspaceIdFromSnapshot,
  resolveOwnedWorkspaceContainerById,
} from "../e2e/fixtures/desktopDelivery";

test("cleanup refuses to delete a top-level Desktop entry from the baseline", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const desktopRoot = path.join(root, "Desktop");
  const topLevelName = "existing-export";
  const exportPath = path.join(desktopRoot, topLevelName);
  const sentinelPath = path.join(exportPath, "keep.txt");
  await mkdir(exportPath, { recursive: true });
  await writeFile(sentinelPath, "preserve me", "utf8");

  await assert.rejects(
    cleanupOwnedExportDirectory({
      desktopRoot,
      exportPath,
      desktopEntriesBefore: new Set([topLevelName]),
    }),
    /Refusing to clean a pre-existing Desktop entry/u,
  );
  assert.equal(await readFile(sentinelPath, "utf8"), "preserve me");
});

// ---------------------------------------------------------------------------
// extractWorkspaceIdFromSnapshot
// ---------------------------------------------------------------------------

test("extractWorkspaceIdFromSnapshot returns the workspaceId from a create receipt", () => {
  const snapshot = {
    lastReceipts: [
      {
        toolName: "code_workspace_create",
        operation: "create",
        resource: { workspaceId: "ws-abc-123" },
      },
    ],
  };
  assert.equal(extractWorkspaceIdFromSnapshot(snapshot), "ws-abc-123");
});

test("extractWorkspaceIdFromSnapshot returns null for an empty snapshot", () => {
  assert.equal(extractWorkspaceIdFromSnapshot(null), null);
  assert.equal(extractWorkspaceIdFromSnapshot({}), null);
  assert.equal(extractWorkspaceIdFromSnapshot({ lastReceipts: [] }), null);
});

test("extractWorkspaceIdFromSnapshot ignores non-create receipts", () => {
  const snapshot = {
    lastReceipts: [
      {
        toolName: "code_workspace_create",
        operation: "status", // not a create operation
        resource: { workspaceId: "should-be-ignored" },
      },
      {
        toolName: "code_workspace_export_directory",
        operation: "create",
        resource: { workspaceId: "also-ignored" },
      },
    ],
  };
  assert.equal(extractWorkspaceIdFromSnapshot(snapshot), null);
});

// ---------------------------------------------------------------------------
// resolveOwnedWorkspaceContainerById — capture-survives-empty-snapshot
// ---------------------------------------------------------------------------

test("capture-survives-empty-snapshot: resolveOwnedWorkspaceContainerById finds container even when snapshot is empty", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ws-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspacesRoot = path.join(root, "workspaces-v2");
  const workspaceId = "test-workspace-capture-abc";
  const containerPath = path.join(workspacesRoot, workspaceId);
  await mkdir(containerPath, { recursive: true });

  // Simulate that the snapshot is now empty (lastReceipts cleared after failure).
  const emptySnapshot = { lastReceipts: [] };
  assert.equal(
    extractWorkspaceIdFromSnapshot(emptySnapshot),
    null,
    "extractWorkspaceIdFromSnapshot must return null for cleared receipts",
  );

  // Despite the empty snapshot, the filesystem-only resolver still finds the
  // container because we captured workspaceId earlier in the run.
  const resolved = await resolveOwnedWorkspaceContainerById(
    workspaceId,
    workspacesRoot,
  );
  assert.ok(
    resolved !== null,
    "resolveOwnedWorkspaceContainerById must return the container path",
  );
  assert.equal(
    path.basename(resolved!),
    workspaceId,
    "Resolved path basename must equal the workspaceId",
  );
});

test("capture-survives-empty-snapshot: returns null when container does not exist", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ws-absent-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspacesRoot = path.join(root, "workspaces-v2");
  await mkdir(workspacesRoot, { recursive: true });
  // Do NOT create the container directory.

  const resolved = await resolveOwnedWorkspaceContainerById(
    "nonexistent-workspace-id",
    workspacesRoot,
  );
  assert.equal(resolved, null);
});

// ---------------------------------------------------------------------------
// resolveOwnedWorkspaceContainerById — refuse-to-delete-outside-owned-child
// ---------------------------------------------------------------------------

test("refuse-to-delete-outside-owned-child: rejects workspaceId with path separators", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ws-escape-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspacesRoot = path.join(root, "workspaces-v2");
  await mkdir(workspacesRoot, { recursive: true });

  await assert.rejects(
    resolveOwnedWorkspaceContainerById("../../etc/passwd", workspacesRoot),
    /Unsafe workspaceId rejected/u,
  );
  await assert.rejects(
    resolveOwnedWorkspaceContainerById("parent/child", workspacesRoot),
    /Unsafe workspaceId rejected/u,
  );
  await assert.rejects(
    resolveOwnedWorkspaceContainerById("parent\\child", workspacesRoot),
    /Unsafe workspaceId rejected/u,
  );
});

test("refuse-to-delete-outside-owned-child: rejects absolute workspaceId", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ws-abs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspacesRoot = path.join(root, "workspaces-v2");
  await mkdir(workspacesRoot, { recursive: true });

  await assert.rejects(
    resolveOwnedWorkspaceContainerById(
      path.isAbsolute("/tmp") ? "/tmp" : "C:\\Windows",
      workspacesRoot,
    ),
    /Unsafe workspaceId rejected/u,
  );
});
