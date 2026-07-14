import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  restoreOwnedE2EArtifacts,
  snapshotOwnedE2EArtifacts,
} from "../e2e/fixtures/ownedE2EArtifacts";

test("E2E cleanup restores prior fixtures and removes only newly owned artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "owned-e2e-artifacts-"));
  try {
    await mkdir(path.join(root, "E2E Agent Tests"), { recursive: true });
    await mkdir(path.join(root, "Designs"), { recursive: true });
    await mkdir(path.join(root, "Notes"), { recursive: true });
    await mkdir(path.join(root, "Agent Memory"), { recursive: true });
    await mkdir(path.join(root, "Agent Runs", "Mission Graphs"), { recursive: true });
    await mkdir(path.join(root, "Agent Runs", "Missions"), { recursive: true });
    await writeFile(path.join(root, "E2E Agent Tests", "before.md"), "before");
    await writeFile(path.join(root, "Designs", "e2e-before.svg"), "before-svg");
    await writeFile(path.join(root, "Notes", "user.md"), "user");
    await writeFile(
      path.join(root, "Agent Runs", "preexisting.md"),
      "preexisting E2E_MARKER_100_200",
    );
    await writeFile(
      path.join(root, "Agent Runs", "Mission Graphs", "preexisting.md"),
      "preexisting graph E2E_TEST_GRAPH",
    );
    await writeFile(
      path.join(root, "Agent Memory", "semantic-vault-index.json"),
      "semantic-before",
    );
    const snapshot = await snapshotOwnedE2EArtifacts(root);

    await writeFile(path.join(root, "E2E Agent Tests", "created.md"), "created");
    await writeFile(path.join(root, "Designs", "e2e-created.canvas"), "created");
    await writeFile(path.join(root, "Notes", "user.md"), "still-user");
    await writeFile(
      path.join(root, "Agent Runs", "e2e-created.md"),
      "mission objective: E2E_MARKER_123_456",
    );
    await writeFile(
      path.join(root, "Agent Runs", "Mission Graphs", "e2e-created.md"),
      "current note: E2E Agent Tests/created.md",
    );
    await writeFile(
      path.join(root, "Agent Runs", "user-created.md"),
      "ordinary user mission",
    );
    await writeFile(
      path.join(root, "Agent Runs", "Mission Graphs", "user-created.md"),
      "ordinary user graph",
    );
    await writeFile(
      path.join(root, "Agent Runs", "Missions", "outside-bounded-path.md"),
      "E2E_MARKER_123_456",
    );
    await writeFile(
      path.join(root, "Agent Memory", "semantic-vault-index.json"),
      "semantic-changed",
    );
    await restoreOwnedE2EArtifacts(snapshot);

    assert.equal(await readFile(path.join(root, "E2E Agent Tests", "before.md"), "utf8"), "before");
    await assert.rejects(readFile(path.join(root, "E2E Agent Tests", "created.md")), /ENOENT/u);
    assert.equal(await readFile(path.join(root, "Designs", "e2e-before.svg"), "utf8"), "before-svg");
    await assert.rejects(readFile(path.join(root, "Designs", "e2e-created.canvas")), /ENOENT/u);
    assert.equal(await readFile(path.join(root, "Notes", "user.md"), "utf8"), "still-user");
    assert.equal(
      await readFile(path.join(root, "Agent Runs", "preexisting.md"), "utf8"),
      "preexisting E2E_MARKER_100_200",
    );
    assert.equal(
      await readFile(
        path.join(root, "Agent Runs", "Mission Graphs", "preexisting.md"),
        "utf8",
      ),
      "preexisting graph E2E_TEST_GRAPH",
    );
    await assert.rejects(readFile(path.join(root, "Agent Runs", "e2e-created.md")), /ENOENT/u);
    await assert.rejects(
      readFile(path.join(root, "Agent Runs", "Mission Graphs", "e2e-created.md")),
      /ENOENT/u,
    );
    assert.equal(
      await readFile(path.join(root, "Agent Runs", "user-created.md"), "utf8"),
      "ordinary user mission",
    );
    assert.equal(
      await readFile(
        path.join(root, "Agent Runs", "Mission Graphs", "user-created.md"),
        "utf8",
      ),
      "ordinary user graph",
    );
    assert.equal(
      await readFile(
        path.join(root, "Agent Runs", "Missions", "outside-bounded-path.md"),
        "utf8",
      ),
      "E2E_MARKER_123_456",
    );
    assert.equal(
      await readFile(
        path.join(root, "Agent Memory", "semantic-vault-index.json"),
        "utf8",
      ),
      "semantic-before",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
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
