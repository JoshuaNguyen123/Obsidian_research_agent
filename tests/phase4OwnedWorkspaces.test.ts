import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  removeNewPhase4OwnedWorkspaces,
  snapshotPhase4OwnedWorkspaces,
} from "../e2e/fixtures/phase4OwnedWorkspaces";

test("Phase 4 workspace cleanup removes only new exact-marker containers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phase4-owned-workspaces-"));
  const marker = "E2E_PHASE4_123-456";
  try {
    const preexisting = path.join(root, "phase4-crud-e2e_phase4_123-456");
    await mkdir(preexisting);
    await writeFile(path.join(preexisting, "preserve.txt"), "before");
    const snapshot = await snapshotPhase4OwnedWorkspaces(root);

    const owned = path.join(root, "phase4-repair-e2e_phase4_123-456");
    const unrelated = path.join(root, "phase4-repair-e2e_phase4_999-999");
    await mkdir(owned);
    await mkdir(unrelated);
    await writeFile(path.join(owned, "remove.txt"), "owned");
    await writeFile(path.join(unrelated, "preserve.txt"), "other run");

    await removeNewPhase4OwnedWorkspaces(snapshot, marker);

    assert.equal(await readFile(path.join(preexisting, "preserve.txt"), "utf8"), "before");
    await assert.rejects(lstat(owned), /ENOENT/u);
    assert.equal(await readFile(path.join(unrelated, "preserve.txt"), "utf8"), "other run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 4 workspace cleanup refuses a new linked owned container", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phase4-owned-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "phase4-owned-outside-"));
  try {
    const snapshot = await snapshotPhase4OwnedWorkspaces(root);
    const linked = path.join(root, "phase4-crud-e2e_phase4_123-456");
    await symlink(outside, linked, "junction");
    await assert.rejects(
      removeNewPhase4OwnedWorkspaces(snapshot, "E2E_PHASE4_123-456"),
      /non-directory/iu,
    );
    assert.equal((await lstat(outside)).isDirectory(), true);
  } finally {
    await rm(path.join(root, "phase4-crud-e2e_phase4_123-456"), {
      force: true,
    }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
