import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WORKSPACE_MAX_SEARCH_RESULTS_V2,
  WorkspaceManagerErrorV2,
  WorkspaceManagerV2,
  createVerifiedWorkspaceBaseReadbackV2,
  parseWorkspaceManifestV2,
  serializeWorkspaceManifestV2,
} from "../extensions/code/workspaces";

test("WorkspaceManifestV2 exact parser round-trips and rejects contract drift", async () => {
  const fixture = await fixtureManager("manifest");
  try {
    const manifest = await fixture.manager.createScratchWorkspace({
      workspaceId: "manifest-workspace",
      ownerRunId: "run-manifest",
    });
    assert.deepEqual(
      parseWorkspaceManifestV2(JSON.parse(serializeWorkspaceManifestV2(manifest))),
      manifest,
    );
    assert.throws(
      () => parseWorkspaceManifestV2({ ...manifest, unexpected: true }),
      /unknown or missing fields/u,
    );
    assert.throws(
      () => parseWorkspaceManifestV2({ ...manifest, version: 3 }),
      /Unsupported workspace manifest/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("metadata boundary permits a system alias above its root and rejects aliases inside it", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "workspace-v2-alias-"));
  const realParent = path.join(fixtureRoot, "real-parent");
  const aliasParent = path.join(fixtureRoot, "system-alias");
  const applicationRoot = path.join(realParent, "application-data");
  try {
    await mkdir(applicationRoot, { recursive: true });
    try {
      await symlink(
        realParent,
        aliasParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      t.skip("directory symlink creation is unavailable");
      return;
    }

    const manager = new WorkspaceManagerV2({
      applicationDataRoot: path.join(aliasParent, "application-data"),
    });
    const manifest = await manager.createScratchWorkspace({
      workspaceId: "through-system-alias",
      ownerRunId: "run-through-system-alias",
    });
    assert.equal(manifest.workspaceId, "through-system-alias");

    const outside = path.join(fixtureRoot, "outside-metadata");
    await mkdir(outside);
    await symlink(
      outside,
      path.join(manager.metadataRoot, "inside-alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      manager.createScratchWorkspace({
        workspaceId: "inside-alias",
        ownerRunId: "run-inside-alias",
      }),
      (error: unknown) =>
        error instanceof WorkspaceManagerErrorV2 &&
        error.code === "metadata_reparse",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("durable scratch CRUD survives manager restart with hashes, receipts, trash, and restore", async () => {
  const fixture = await fixtureManager("crud");
  try {
    await fixture.manager.createScratchWorkspace({
      workspaceId: "crud-workspace",
      ownerRunId: "run-crud",
    });
    const leased = await fixture.manager.acquireLease("crud-workspace", "worker-crud");
    const leaseId = leased.lease!.id;
    await fixture.manager.mkdir("crud-workspace", leaseId, "src/lib");
    const created = await fixture.manager.createFile(
      "crud-workspace",
      leaseId,
      "src/lib/value.ts",
      "export const value = 1;\n",
    );
    assert.match(created.afterSha256 ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.match(created.manifestSha256, /^sha256:[a-f0-9]{64}$/u);

    let read = await fixture.manager.read("crud-workspace", "src/lib/value.ts");
    const appended = await fixture.manager.appendFile(
      "crud-workspace",
      leaseId,
      read.path,
      "export const second = 2;\n",
      read.sha256,
    );
    assert.equal(appended.beforeSha256, read.sha256);
    read = await fixture.manager.read("crud-workspace", read.path);
    const patched = await fixture.manager.patchExact(
      "crud-workspace",
      leaseId,
      read.path,
      read.sha256,
      [{ oldText: "value = 1", newText: "value = 3" }],
    );
    assert.notEqual(patched.beforeSha256, patched.afterSha256);
    read = await fixture.manager.read("crud-workspace", read.path);
    const beforeBadWrite = await readFile(
      path.join((await fixture.manager.loadManifest("crud-workspace")).canonicalRoot, read.path),
      "utf8",
    );
    await assert.rejects(
      fixture.manager.writeExpected(
        "crud-workspace",
        leaseId,
        read.path,
        "tampered",
        fp("0"),
      ),
      /precondition hash changed|changed after preparation/u,
    );
    assert.equal(
      await readFile(
        path.join((await fixture.manager.loadManifest("crud-workspace")).canonicalRoot, read.path),
        "utf8",
      ),
      beforeBadWrite,
    );

    const fileStat = await fixture.manager.stat("crud-workspace", read.path);
    assert.equal(fileStat.kind, "file");
    await fixture.manager.mkdir("crud-workspace", leaseId, "moved");
    await fixture.manager.move(
      "crud-workspace",
      leaseId,
      read.path,
      "moved/value.ts",
      fileStat.sha256,
    );
    const movedStat = await fixture.manager.stat("crud-workspace", "moved/value.ts");
    await fixture.manager.copy(
      "crud-workspace",
      leaseId,
      "moved/value.ts",
      "moved/copy.ts",
      movedStat.sha256,
    );
    const listed = await fixture.manager.list("crud-workspace", "moved");
    assert.deepEqual(listed.map((item) => item.path), ["moved/copy.ts", "moved/value.ts"]);
    const searched = await fixture.manager.search("crud-workspace", "export const");
    assert.equal(searched.length, 4);

    const copyStat = await fixture.manager.stat("crud-workspace", "moved/copy.ts");
    const trashed = await fixture.manager.trash(
      "crud-workspace",
      leaseId,
      "moved/copy.ts",
      copyStat.sha256,
    );
    await assert.rejects(
      fixture.manager.read("crud-workspace", "moved/copy.ts"),
      /does not exist/u,
    );
    const trash = await fixture.manager.inspectTrash(
      "crud-workspace",
      trashed.trashId!,
    );
    const restored = await fixture.manager.restore(
      "crud-workspace",
      leaseId,
      trash.trashId,
      trash.fingerprint,
    );
    assert.equal(restored.afterSha256, trash.fingerprint);
    assert.match(
      (await fixture.manager.read("crud-workspace", "moved/copy.ts")).content,
      /value = 3/u,
    );

    const restarted = new WorkspaceManagerV2({
      applicationDataRoot: fixture.root,
      now: fixture.now,
      randomId: fixture.randomId,
    });
    const resumed = await restarted.resumeWorkspace("crud-workspace", "run-crud");
    assert.equal(resumed.status, "leased");
    assert.ok(resumed.hashes.files["moved/value.ts"]);
    assert.ok(resumed.hashes.files["moved/copy.ts"]);
  } finally {
    await fixture.cleanup();
  }
});

test("workspace search, text, changed-file, path, symlink, and hard-link boundaries fail closed", async (t) => {
  const fixture = await fixtureManager("limits");
  const outside = await mkdtemp(path.join(tmpdir(), "workspace-v2-outside-"));
  try {
    await fixture.manager.createScratchWorkspace({ workspaceId: "limits-workspace", ownerRunId: "run-limits" });
    const lease = (await fixture.manager.acquireLease("limits-workspace", "worker-limits")).lease!.id;
    await fixture.manager.createFile(
      "limits-workspace",
      lease,
      "matches.txt",
      `${"needle ".repeat(300)}\n`,
    );
    assert.equal(
      (await fixture.manager.search("limits-workspace", "needle", { limit: 999 })).length,
      WORKSPACE_MAX_SEARCH_RESULTS_V2,
    );
    await assert.rejects(
      fixture.manager.createFile("limits-workspace", lease, "too-large.txt", "x".repeat(2 * 1024 * 1024 + 1)),
      /2 MiB/u,
    );
    for (const unsafe of ["../escape.ts", "/absolute.ts", "C:/absolute.ts", ".git/config", "safe\\escape.ts"]) {
      await assert.rejects(
        fixture.manager.createFile("limits-workspace", lease, unsafe, "unsafe"),
        /relative|blocked path|workspace path/u,
        unsafe,
      );
    }

    const manifest = await fixture.manager.loadManifest("limits-workspace");
    await writeFile(path.join(outside, "outside.ts"), "outside", "utf8");
    try {
      await symlink(outside, path.join(manifest.canonicalRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        fixture.manager.createFile("limits-workspace", lease, "linked/escape.ts", "escape"),
        /symlink|junction|reparse/u,
      );
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      t.diagnostic("symlink creation unavailable");
    }

    await writeFile(path.join(manifest.canonicalRoot, "hard-a.ts"), "hard", "utf8");
    try {
      await link(path.join(manifest.canonicalRoot, "hard-a.ts"), path.join(manifest.canonicalRoot, "hard-b.ts"));
      await assert.rejects(
        fixture.manager.read("limits-workspace", "hard-a.ts"),
        /hard links|multiple hard links/u,
      );
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      t.diagnostic("hard-link creation unavailable");
    }

    for (let index = 0; index < 98; index += 1) {
      await fixture.manager.createFile("limits-workspace", lease, `budget-${index}.txt`, "x");
    }
    await fixture.manager.createFile("limits-workspace", lease, "budget-98.txt", "x");
    await assert.rejects(
      fixture.manager.createFile("limits-workspace", lease, "budget-over.txt", "x"),
      /100 changed files/u,
    );
  } finally {
    await fixture.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("repository workspace registration accepts only an explicit distinct trusted Git worktree", async () => {
  const fixture = await fixtureManager("repository");
  const repository = path.join(fixture.root, "repo");
  const worktree = path.join(fixture.root, "worktree");
  await mkdir(repository);
  await mkdir(worktree);
  await writeFile(path.join(repository, ".git"), "gitdir: fixture", "utf8");
  await writeFile(path.join(worktree, ".git"), "gitdir: fixture", "utf8");
  try {
    const manifest = await fixture.manager.registerTrustedRepositoryWorkspace({
      workspaceId: "repo-workspace",
      ownerRunId: "run-repository",
      profileKey: "fixture-repo",
      repositoryRoot: repository,
      worktreeRoot: worktree,
      branch: "codex/workspace-repo-workspace",
      baseSha: "a".repeat(40),
      bindingFingerprint: fp("b"),
      trusted: true,
    });
    assert.equal(manifest.kind, "repository");
    assert.equal(manifest.canonicalRoot, await import("node:fs/promises").then((mod) => mod.realpath(worktree)));
    await assert.rejects(
      fixture.manager.registerTrustedRepositoryWorkspace({
        workspaceId: "unsafe-repo",
        ownerRunId: "run-repository",
        profileKey: "fixture-repo",
        repositoryRoot: repository,
        worktreeRoot: repository,
        branch: "codex/workspace-unsafe-repo",
        baseSha: "a".repeat(40),
        bindingFingerprint: fp("c"),
        trusted: true,
      }),
      /original repository checkout/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("repository base advances only from exact clean verified head readback and reconciles after restart", async () => {
  const fixture = await fixtureManager("repository-base-advance");
  const repository = path.join(fixture.root, "repo");
  const worktree = path.join(fixture.root, "worktree");
  await mkdir(repository);
  await mkdir(worktree);
  await writeFile(path.join(repository, ".git"), "gitdir: fixture", "utf8");
  await writeFile(path.join(worktree, ".git"), "gitdir: fixture", "utf8");
  const previousBaseSha = "a".repeat(40);
  const nextBaseSha = "b".repeat(40);
  const handoffFingerprint = fp("c");
  const operationId = "review-base-advance-1";
  try {
    await fixture.manager.registerTrustedRepositoryWorkspace({
      workspaceId: "review-workspace",
      ownerRunId: "run-review",
      profileKey: "fixture-repo",
      repositoryRoot: repository,
      worktreeRoot: worktree,
      branch: "codex/review-workspace",
      baseSha: previousBaseSha,
      bindingFingerprint: fp("b"),
      trusted: true,
    });
    const leased = await fixture.manager.acquireLease("review-workspace", "initial-repair");
    await fixture.manager.mkdir("review-workspace", leased.lease!.id, "src");
    await fixture.manager.createFile(
      "review-workspace",
      leased.lease!.id,
      "src/fix.ts",
      "export const fixed = true;\n",
    );
    await fixture.manager.releaseLease("review-workspace", leased.lease!.id);
    const canonicalRoot = (await fixture.manager.loadManifest("review-workspace")).canonicalRoot;
    const readback = createVerifiedWorkspaceBaseReadbackV2({
      operationId,
      workspaceId: "review-workspace",
      worktreeRoot: canonicalRoot,
      branch: "codex/review-workspace",
      headSha: nextBaseSha,
      clean: true,
      handoffFingerprint,
    });

    const advanced = await fixture.manager.advanceRepositoryBaseAfterVerifiedReadback({
      operationId,
      workspaceId: "review-workspace",
      ownerRunId: "run-review",
      profileKey: "fixture-repo",
      expectedWorktreeRoot: canonicalRoot,
      expectedBranch: "codex/review-workspace",
      expectedPreviousBaseSha: previousBaseSha,
      nextBaseSha,
      handoffFingerprint,
      readback,
    });
    assert.equal(advanced.commitKind, "committed");
    const manifest = await fixture.manager.loadManifest("review-workspace");
    assert.equal(manifest.baseSha, nextBaseSha);
    assert.deepEqual(manifest.budget.changedPaths, []);
    assert.equal(manifest.budget.changedBytes, 0);
    assert.equal(manifest.hashes.files["src/fix.ts"].sha256, bytesFp(new TextEncoder().encode("export const fixed = true;\n")));

    const restarted = new WorkspaceManagerV2({
      applicationDataRoot: fixture.root,
      now: fixture.now,
      randomId: fixture.randomId,
    });
    const reconciled = await restarted.advanceRepositoryBaseAfterVerifiedReadback({
      operationId,
      workspaceId: "review-workspace",
      ownerRunId: "run-review",
      profileKey: "fixture-repo",
      expectedWorktreeRoot: canonicalRoot,
      expectedBranch: "codex/review-workspace",
      expectedPreviousBaseSha: previousBaseSha,
      nextBaseSha,
      handoffFingerprint,
      readback,
    });
    assert.equal(reconciled.commitKind, "reconciled");

    await assert.rejects(
      restarted.advanceRepositoryBaseAfterVerifiedReadback({
        operationId: "review-base-advance-2",
        workspaceId: "review-workspace",
        ownerRunId: "run-review",
        profileKey: "fixture-repo",
        expectedWorktreeRoot: canonicalRoot,
        expectedBranch: "codex/review-workspace",
        expectedPreviousBaseSha: previousBaseSha,
        nextBaseSha: "d".repeat(40),
        handoffFingerprint,
        readback,
      }),
      /does not prove a clean exact branch|readback/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("workspace byte budget and durable expiry remain enforced after lease acquisition", async () => {
  const fixture = await fixtureManager("byte-expiry");
  try {
    await fixture.manager.createScratchWorkspace({
      workspaceId: "byte-space",
      ownerRunId: "run-byte",
    });
    const lease = (await fixture.manager.acquireLease("byte-space", "worker-byte")).lease!.id;
    const chunk = "x".repeat(1_800_000);
    for (let index = 0; index < 5; index += 1) {
      await fixture.manager.createFile("byte-space", lease, `large-${index}.txt`, chunk);
    }
    await assert.rejects(
      fixture.manager.createFile("byte-space", lease, "large-over.txt", chunk),
      /10 MiB changed bytes/u,
    );

    await fixture.manager.createScratchWorkspace({
      workspaceId: "expiry-space",
      ownerRunId: "run-expiry",
      expiresAt: "2026-07-12T20:00:01.000Z",
    });
    await fixture.manager.acquireLease("expiry-space", "worker-expiry");
    fixture.advance(2_000);
    assert.equal((await fixture.manager.status("expiry-space")).manifest.status, "expired");
    await assert.rejects(
      fixture.manager.resumeWorkspace("expiry-space", "run-expiry"),
      /expired/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("sandbox-generated binary artifacts import transactionally with exact hashes and survive restart", async () => {
  const fixture = await fixtureManager("sandbox-artifact");
  try {
    await fixture.manager.createScratchWorkspace({
      workspaceId: "artifact-space",
      ownerRunId: "run-artifact",
    });
    const lease = (await fixture.manager.acquireLease(
      "artifact-space",
      "sandbox-importer",
    )).lease!.id;
    await fixture.manager.mkdir("artifact-space", lease, "dist");

    const firstBytes = new Uint8Array([0, 255, 128, 1, 2, 3]);
    const firstSha = bytesFp(firstBytes);
    const created = await fixture.manager.importSandboxArtifact({
      workspaceId: "artifact-space",
      leaseId: lease,
      relativePath: "dist/output.bin",
      bytes: firstBytes,
      expectedSha256: firstSha,
      maxBytes: 1024,
    });
    assert.equal(created.beforeSha256, null);
    assert.equal(created.afterSha256, firstSha);
    assert.equal(created.bytesWritten, firstBytes.byteLength);
    await assert.rejects(
      fixture.manager.read("artifact-space", "dist/output.bin"),
      /binary content|UTF-8 text/u,
    );

    const manifest = await fixture.manager.loadManifest("artifact-space");
    assert.deepEqual(manifest.hashes.files["dist/output.bin"], {
      sha256: firstSha,
      bytes: firstBytes.byteLength,
      updatedAt: manifest.hashes.files["dist/output.bin"].updatedAt,
    });

    const secondBytes = new Uint8Array([9, 0, 8, 7, 255]);
    const secondSha = bytesFp(secondBytes);
    await assert.rejects(
      fixture.manager.importSandboxArtifact({
        workspaceId: "artifact-space",
        leaseId: lease,
        relativePath: "dist/output.bin",
        bytes: secondBytes,
        expectedSha256: secondSha,
        expectedExistingSha256: fp("0"),
        maxBytes: 1024,
      }),
      /changed before (?:selective|batch) import/u,
    );
    assert.deepEqual(
      new Uint8Array(await readFile(path.join(manifest.canonicalRoot, "dist/output.bin"))),
      firstBytes,
    );

    const replaced = await fixture.manager.importSandboxArtifact({
      workspaceId: "artifact-space",
      leaseId: lease,
      relativePath: "dist/output.bin",
      bytes: secondBytes,
      expectedSha256: secondSha,
      expectedExistingSha256: firstSha,
      maxBytes: 1024,
    });
    assert.equal(replaced.beforeSha256, firstSha);
    assert.equal(replaced.afterSha256, secondSha);

    const siblingBytes = new Uint8Array([4, 5, 6]);
    const siblingSha = bytesFp(siblingBytes);
    await assert.rejects(
      fixture.manager.importSandboxArtifacts({
        workspaceId: "artifact-space",
        leaseId: lease,
        artifacts: [
          {
            relativePath: "nested/generated/sibling.bin",
            bytes: siblingBytes,
            expectedSha256: siblingSha,
            maxBytes: 1024,
          },
          {
            relativePath: "dist/output.bin",
            bytes: firstBytes,
            expectedSha256: firstSha,
            expectedExistingSha256: fp("0"),
            maxBytes: 1024,
          },
        ],
      }),
      /changed before batch import/u,
    );
    await assert.rejects(
      fixture.manager.stat("artifact-space", "nested/generated/sibling.bin"),
      /does not exist/u,
    );
    assert.deepEqual(
      new Uint8Array(await readFile(path.join(manifest.canonicalRoot, "dist/output.bin"))),
      secondBytes,
      "a later batch precondition failure must preserve every earlier artifact",
    );

    const batch = await fixture.manager.importSandboxArtifacts({
      workspaceId: "artifact-space",
      leaseId: lease,
      artifacts: [
        {
          relativePath: "nested/generated/sibling.bin",
          bytes: siblingBytes,
          expectedSha256: siblingSha,
          maxBytes: 1024,
        },
        {
          relativePath: "dist/output.bin",
          bytes: firstBytes,
          expectedSha256: firstSha,
          expectedExistingSha256: secondSha,
          maxBytes: 1024,
        },
      ],
    });
    assert.deepEqual(batch.map((receipt) => receipt.path), ["dist/output.bin", "nested/generated/sibling.bin"]);
    assert.equal((await fixture.manager.loadManifest("artifact-space")).hashes.files["nested/generated/sibling.bin"].sha256, siblingSha);

    for (const invalid of [
      {
        relativePath: "dist/hash-mismatch.bin",
        bytes: new Uint8Array([1, 2, 3]),
        expectedSha256: fp("0"),
        maxBytes: 1024,
        pattern: /do not match the declared SHA-256/u,
      },
      {
        relativePath: "dist/too-large.bin",
        bytes: new Uint8Array([1, 2, 3]),
        expectedSha256: bytesFp(new Uint8Array([1, 2, 3])),
        maxBytes: 2,
        pattern: /exceeds its declared byte limit/u,
      },
    ]) {
      await assert.rejects(
        fixture.manager.importSandboxArtifact({
          workspaceId: "artifact-space",
          leaseId: lease,
          relativePath: invalid.relativePath,
          bytes: invalid.bytes,
          expectedSha256: invalid.expectedSha256,
          maxBytes: invalid.maxBytes,
        }),
        invalid.pattern,
      );
      await assert.rejects(
        fixture.manager.stat("artifact-space", invalid.relativePath),
        /does not exist/u,
      );
    }

    const restarted = new WorkspaceManagerV2({
      applicationDataRoot: fixture.root,
      now: fixture.now,
      randomId: fixture.randomId,
    });
    const resumed = await restarted.resumeWorkspace("artifact-space", "run-artifact");
    assert.equal(resumed.hashes.files["dist/output.bin"].sha256, firstSha);
    assert.deepEqual(
      new Uint8Array(await readFile(path.join(resumed.canonicalRoot, "dist/output.bin"))),
      firstBytes,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("ordinary workspace mutations roll filesystem state back when manifest persistence fails", async () => {
  const fixture = await fixtureManager("ordinary-rollback");
  try {
    await fixture.manager.createScratchWorkspace({ workspaceId: "rollback-space", ownerRunId: "run-rollback" });
    const lease = (await fixture.manager.acquireLease("rollback-space", "worker-rollback")).lease!.id;
    const manager = fixture.manager as unknown as { persistManifest(manifest: unknown): Promise<void> };
    const persist = manager.persistManifest.bind(fixture.manager);
    const failNext = () => {
      let pending = true;
      manager.persistManifest = async (manifest) => {
        if (pending) { pending = false; throw new Error("injected manifest failure"); }
        return persist(manifest);
      };
    };

    failNext();
    await assert.rejects(fixture.manager.createFile("rollback-space", lease, "new.txt", "new\n"), /injected manifest failure/u);
    await assert.rejects(fixture.manager.stat("rollback-space", "new.txt"), /does not exist/u);

    manager.persistManifest = persist;
    await fixture.manager.createFile("rollback-space", lease, "source.txt", "before\n");
    let source = await fixture.manager.read("rollback-space", "source.txt");
    failNext();
    await assert.rejects(fixture.manager.writeExpected("rollback-space", lease, "source.txt", "after\n", source.sha256), /injected manifest failure/u);
    assert.equal((await fixture.manager.read("rollback-space", "source.txt")).content, "before\n");

    source = await fixture.manager.read("rollback-space", "source.txt");
    failNext();
    await assert.rejects(fixture.manager.move("rollback-space", lease, "source.txt", "moved.txt", source.sha256), /injected manifest failure/u);
    assert.equal((await fixture.manager.read("rollback-space", "source.txt")).content, "before\n");
    await assert.rejects(fixture.manager.stat("rollback-space", "moved.txt"), /does not exist/u);

    source = await fixture.manager.read("rollback-space", "source.txt");
    failNext();
    await assert.rejects(fixture.manager.copy("rollback-space", lease, "source.txt", "copy.txt", source.sha256), /injected manifest failure/u);
    await assert.rejects(fixture.manager.stat("rollback-space", "copy.txt"), /does not exist/u);

    failNext();
    await assert.rejects(fixture.manager.trash("rollback-space", lease, "source.txt", source.sha256), /injected manifest failure/u);
    assert.equal((await fixture.manager.read("rollback-space", "source.txt")).content, "before\n");

    manager.persistManifest = persist;
    const trashed = await fixture.manager.trash("rollback-space", lease, "source.txt", source.sha256);
    const trash = await fixture.manager.inspectTrash("rollback-space", trashed.trashId!);
    failNext();
    await assert.rejects(fixture.manager.restore("rollback-space", lease, trash.trashId, trash.fingerprint), /injected manifest failure/u);
    await assert.rejects(fixture.manager.stat("rollback-space", "source.txt"), /does not exist/u);
    assert.equal((await fixture.manager.inspectTrash("rollback-space", trash.trashId)).fingerprint, trash.fingerprint);
  } finally {
    await fixture.cleanup();
  }
});

test("workspace metadata inventory rejects no file merely because hashing would exceed the artifact boundary", async () => {
  const fixture = await fixtureManager("metadata-inventory");
  try {
    const manifest = await fixture.manager.createScratchWorkspace({
      workspaceId: "metadata-inventory-workspace",
      ownerRunId: "run-metadata-inventory",
    });
    const largePath = path.join(manifest.canonicalRoot, "large.bin");
    const handle = await open(largePath, "w");
    try {
      await handle.truncate(10 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }

    const metadata = await fixture.manager.listMetadata(
      "metadata-inventory-workspace",
    );
    assert.deepEqual(metadata.map(({ path: itemPath, kind, bytes }) => ({
      path: itemPath,
      kind,
      bytes,
    })), [{
      path: "large.bin",
      kind: "file",
      bytes: 10 * 1024 * 1024 + 1,
    }]);
    await assert.rejects(
      fixture.manager.list("metadata-inventory-workspace"),
      (error: unknown) =>
        error instanceof WorkspaceManagerErrorV2 && error.code === "file_too_large",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("workspace copy rejects a destination inside its source without leaving partial output", async () => {
  const fixture = await fixtureManager("copy-descendant");
  try {
    await fixture.manager.createScratchWorkspace({
      workspaceId: "copy-descendant-space",
      ownerRunId: "run-copy-descendant",
    });
    const lease = (await fixture.manager.acquireLease(
      "copy-descendant-space",
      "worker-copy-descendant",
    )).lease!.id;
    await fixture.manager.mkdir("copy-descendant-space", lease, "source");
    await fixture.manager.createFile(
      "copy-descendant-space",
      lease,
      "source/value.txt",
      "safe\n",
    );
    const source = await fixture.manager.stat("copy-descendant-space", "source");
    await assert.rejects(
      fixture.manager.copy(
        "copy-descendant-space",
        lease,
        "source",
        "source/nested-copy",
        source.sha256,
      ),
      (error: unknown) =>
        error instanceof WorkspaceManagerErrorV2 &&
        error.code === "copy_destination_inside_source",
    );
    await assert.rejects(
      fixture.manager.stat("copy-descendant-space", "source/nested-copy"),
      /does not exist/u,
    );
    assert.equal(
      (await fixture.manager.read("copy-descendant-space", "source/value.txt")).content,
      "safe\n",
    );
  } finally {
    await fixture.cleanup();
  }
});

async function fixtureManager(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `workspace-v2-${name}-`));
  let milliseconds = Date.parse("2026-07-12T20:00:00.000Z");
  let sequence = 0;
  const now = () => new Date(milliseconds += 1);
  const randomId = () => `fixture-${++sequence}`;
  return {
    root,
    now,
    randomId,
    advance: (amount: number) => { milliseconds += amount; },
    manager: new WorkspaceManagerV2({ applicationDataRoot: root, now, randomId }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function bytesFp(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
