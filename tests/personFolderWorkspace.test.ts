import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WORKSPACE_TEMPORARY_PREFIX_V2,
  WorkspaceManagerErrorV2,
  WorkspaceManagerV2,
  parseWorkspaceManifestV2,
  registerPersonFolderWorkspaceV1,
} from "../extensions/code/workspaces";

/*
 * CODE2-5 (D-287): a workspace whose root is the person's own folder. The host
 * registers it; the manager keeps its manifest, lease, receipts, trash and each
 * run's originals in the container under application data, never removes
 * anything under the folder, and can put the folder back as it was before a run.
 */

const PERSON = "person:code-page";

async function fixture(name: string) {
  const base = await mkdtemp(path.join(tmpdir(), `person-folder-${name}-`));
  const appData = path.join(base, "app-data");
  const folder = path.join(base, "my project");
  await mkdir(appData, { recursive: true });
  await mkdir(path.join(folder, "src"), { recursive: true });
  await writeFile(path.join(folder, "src", "main.py"), "print('hello')\n");
  await writeFile(path.join(folder, "README.md"), "# My project\n");
  let milliseconds = Date.parse("2026-10-17T12:00:00.000Z");
  let sequence = 0;
  const now = () => new Date(milliseconds += 1);
  const randomId = () => `fixture-${++sequence}`;
  const manager = new WorkspaceManagerV2({ applicationDataRoot: appData, now, randomId });
  return {
    base,
    appData,
    folder,
    manager,
    now,
    randomId,
    advance: (amount: number) => { milliseconds += amount; },
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

/** Every file under a folder, as path → SHA-256, in order. */
async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (folder: string, relative: string) => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(folder, entry.name), child);
      else files[child] = createHash("sha256").update(await readFile(path.join(folder, entry.name))).digest("hex");
    }
  };
  await visit(root, "");
  return files;
}

async function sha(file: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}

async function attachedLease(f: Awaited<ReturnType<typeof fixture>>, runId: string): Promise<string> {
  await f.manager.attachRunToPersonWorkspace("my-project", runId);
  return (await f.manager.acquireLease("my-project", `extension:${runId}`)).lease!.id;
}

test("the host registers a workspace in the person's folder; its records stay under application data", async () => {
  const f = await fixture("register");
  try {
    const before = await tree(f.folder);
    const { manifest, leftovers } = await registerPersonFolderWorkspaceV1(f.manager, {
      workspaceId: "my-project",
      ownerRunId: PERSON,
      root: f.folder,
      changeBudget: { maxChangedFiles: 1_000, maxChangedBytes: 64 * 1024 * 1024 },
    });
    assert.equal(manifest.personFolder, true);
    assert.equal(manifest.kind, "scratch");
    assert.equal(manifest.canonicalRoot, await import("node:fs/promises").then((fs) => fs.realpath(f.folder)));
    assert.equal(manifest.budget.maxChangedFiles, 1_000);
    assert.deepEqual(leftovers, { removed: [], keptAside: [], truncated: false });
    assert.deepEqual(await tree(f.folder), before, "registering writes nothing into the folder");
    assert.ok((await stat(path.join(f.appData, "workspaces-v2", "my-project", "manifest.v2.json"))).isFile());
    // Registering it again opens it again.
    const again = await f.manager.registerPersonFolderWorkspace({ workspaceId: "my-project", ownerRunId: PERSON, root: f.folder });
    assert.equal(again.manifest.createdAt, manifest.createdAt);
    await assert.rejects(
      f.manager.registerPersonFolderWorkspace({ workspaceId: "my-project", ownerRunId: "person:other", root: f.folder }),
      (error: unknown) => error instanceof WorkspaceManagerErrorV2 && error.code === "workspace_binding_conflict",
    );
  } finally {
    await f.cleanup();
  }
});

test("a person-folder registration refuses a run's owner, a relative or missing path, a file, a link, a root and application data", async (t) => {
  const f = await fixture("refusals");
  try {
    const refused = async (input: { ownerRunId?: string; root: string }, code: string) => {
      await assert.rejects(
        f.manager.registerPersonFolderWorkspace({ workspaceId: "refused", ownerRunId: input.ownerRunId ?? PERSON, root: input.root }),
        (error: unknown) => error instanceof WorkspaceManagerErrorV2 && error.code === code,
        `${input.root} → ${code}`,
      );
    };
    await refused({ ownerRunId: "run-1", root: f.folder }, "invalid_owner");
    await refused({ root: "my project" }, "invalid_absolute_path");
    await refused({ root: path.join(f.base, "missing") }, "folder_not_found");
    await refused({ root: path.join(f.folder, "README.md") }, "unsafe_directory");
    await refused({ root: path.parse(f.folder).root }, "unsafe_directory");
    await refused({ root: path.join(f.appData, "inside") }, "folder_not_found");
    await mkdir(path.join(f.appData, "inside"));
    await refused({ root: path.join(f.appData, "inside") }, "unsafe_directory");
    await refused({ root: f.base }, "unsafe_directory");
    const link = path.join(f.base, "link");
    try {
      await symlink(f.folder, link, "junction");
      await refused({ root: link }, "unsafe_directory");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      t.diagnostic("link creation unavailable");
    }
    await assert.rejects(f.manager.loadManifest("refused"), /does not exist/u, "nothing was registered");
  } finally {
    await f.cleanup();
  }
});

test("only a person's own scratch workspace can be rooted in their folder; the manifest says so", async () => {
  const f = await fixture("manifest");
  try {
    const { manifest } = await f.manager.registerPersonFolderWorkspace({ workspaceId: "my-project", ownerRunId: PERSON, root: f.folder });
    assert.deepEqual(parseWorkspaceManifestV2(JSON.parse(JSON.stringify(manifest))), manifest);
    assert.throws(() => parseWorkspaceManifestV2({ ...manifest, ownerRunId: "run-1" }), /person's own scratch/u);
    assert.throws(() => parseWorkspaceManifestV2({ ...manifest, personFolder: false }), /person's own scratch/u);
    // A scratch workspace made the ordinary way has no such mark.
    const scratch = await f.manager.createScratchWorkspace({ workspaceId: "plain", ownerRunId: "run-plain" });
    assert.equal(scratch.personFolder, undefined);
    assert.ok(scratch.canonicalRoot.startsWith(f.appData));
  } finally {
    await f.cleanup();
  }
});

test("nothing under the folder is removed by expiry or close", async () => {
  const f = await fixture("expiry-close");
  try {
    await f.manager.registerPersonFolderWorkspace({
      workspaceId: "my-project",
      ownerRunId: PERSON,
      root: f.folder,
      expiresAt: "2026-10-17T13:00:00.000Z",
    });
    const lease = await attachedLease(f, "run-1");
    const main = await f.manager.read("my-project", "src/main.py");
    await f.manager.writeExpected("my-project", lease, "src/main.py", "print('changed')\n", main.sha256);
    await f.manager.createFile("my-project", lease, "src/new.py", "NEW = 1\n");
    const readme = await f.manager.stat("my-project", "README.md");
    await f.manager.trash("my-project", lease, "README.md", readme.sha256);
    const held = await tree(f.folder);
    assert.deepEqual(Object.keys(held), ["src/main.py", "src/new.py"]);

    f.advance(2 * 60 * 60 * 1_000);
    assert.equal((await f.manager.status("my-project")).manifest.status, "expired");
    assert.deepEqual(await tree(f.folder), held, "expiry removed nothing");
    const closed = await f.manager.closeWorkspace("my-project");
    assert.equal(closed.status, "closed");
    assert.equal(closed.lease, null);
    assert.equal(closed.attachedRunId, undefined);
    assert.deepEqual(await tree(f.folder), held, "close removed nothing");
    await assert.rejects(
      f.manager.registerPersonFolderWorkspace({ workspaceId: "my-project", ownerRunId: PERSON, root: f.folder }),
      /workspace_(expired|closed)|is (expired|closed)/u,
    );
    // The run's originals and the trash are still in the container.
    const container = path.join(f.appData, "workspaces-v2", "my-project");
    assert.ok((await readdir(path.join(container, "trash"))).length === 1);
    assert.ok((await readdir(path.join(container, "preimages"))).length === 1);
  } finally {
    await f.cleanup();
  }
});

test("a run's originals are kept before its first write, and restoring the run puts every byte back", async () => {
  const f = await fixture("restore");
  try {
    await mkdir(path.join(f.folder, "lib"));
    await writeFile(path.join(f.folder, "lib", "util.py"), "def util():\n    return 1\n");
    const before = await tree(f.folder);
    await f.manager.registerPersonFolderWorkspace({ workspaceId: "my-project", ownerRunId: PERSON, root: f.folder });
    const lease = await attachedLease(f, "run-1");
    // Two edits to one file: the original kept is the one before the first.
    let main = await f.manager.read("my-project", "src/main.py");
    await f.manager.writeExpected("my-project", lease, "src/main.py", "print('one')\n", main.sha256);
    main = await f.manager.read("my-project", "src/main.py");
    await f.manager.patchExact("my-project", lease, "src/main.py", main.sha256, [{ oldText: "one", newText: "two" }]);
    await f.manager.createFile("my-project", lease, "src/added.py", "ADDED = True\n");
    const util = await f.manager.stat("my-project", "lib/util.py");
    await f.manager.move("my-project", lease, "lib/util.py", "src/util.py", util.sha256);
    const readme = await f.manager.stat("my-project", "README.md");
    await f.manager.applyFileChanges("my-project", lease, [{ kind: "trash", path: "README.md", expectedSha256: readme.sha256 }]);

    const originals = await f.manager.runOriginals("my-project", "run-1");
    assert.deepEqual(originals.entries.map((entry) => [entry.path, entry.existed, entry.unchangedSinceRun]), [
      ["lib/util.py", true, true],
      ["README.md", true, true],
      ["src/added.py", false, true],
      ["src/main.py", true, true],
      ["src/util.py", false, true],
    ]);
    // The run's lease is held: a restore waits for it.
    await assert.rejects(
      f.manager.restoreRunOriginals("my-project", "run-1"),
      (error: unknown) => error instanceof WorkspaceManagerErrorV2 && error.code === "workspace_in_use",
    );
    await f.manager.releaseLease("my-project", lease);
    await f.manager.detachRunFromPersonWorkspace("my-project", "run-1");

    const restored = await f.manager.restoreRunOriginals("my-project", "run-1");
    assert.deepEqual(restored.restored, ["lib/util.py", "README.md", "src/main.py"]);
    assert.deepEqual(restored.removed, ["src/added.py", "src/util.py"]);
    assert.deepEqual(restored.skipped, []);
    assert.deepEqual(await tree(f.folder), before, "every byte is back");
    assert.equal(
      (await readdir(f.folder, { recursive: true })).some((name) => String(name).includes(WORKSPACE_TEMPORARY_PREFIX_V2)),
      false,
      "no temporary is left behind",
    );
    const again = await f.manager.restoreRunOriginals("my-project", "run-1");
    assert.deepEqual([again.restored, again.removed, again.skipped], [[], [], []], "a second restore does nothing");
  } finally {
    await f.cleanup();
  }
});

test("a restore never overwrites what the person changed after the run, and says so", async () => {
  const f = await fixture("restore-skip");
  try {
    await f.manager.registerPersonFolderWorkspace({ workspaceId: "my-project", ownerRunId: PERSON, root: f.folder });
    const lease = await attachedLease(f, "run-2");
    const main = await f.manager.read("my-project", "src/main.py");
    await f.manager.writeExpected("my-project", lease, "src/main.py", "print('agent')\n", main.sha256);
    const readme = await f.manager.read("my-project", "README.md");
    await f.manager.writeExpected("my-project", lease, "README.md", "# Agent\n", readme.sha256);
    await f.manager.releaseLease("my-project", lease);
    // The person edits one of them afterwards, in their own editor.
    await writeFile(path.join(f.folder, "README.md"), "# Mine now\n");
    const restored = await f.manager.restoreRunOriginals("my-project", "run-2");
    assert.deepEqual(restored.restored, ["src/main.py"]);
    assert.deepEqual(restored.skipped, [{ path: "README.md", reason: "changed_since_run" }]);
    assert.equal(await readFile(path.join(f.folder, "README.md"), "utf8"), "# Mine now\n");
    assert.equal(await readFile(path.join(f.folder, "src", "main.py"), "utf8"), "print('hello')\n");
    // What was skipped stays to be asked about again.
    const listed = await f.manager.runOriginals("my-project", "run-2");
    assert.deepEqual(listed.entries.map((entry) => [entry.path, entry.unchangedSinceRun]), [["README.md", false]]);
  } finally {
    await f.cleanup();
  }
});

test("the person's own writes keep no originals, and their edits are not drift", async () => {
  const f = await fixture("person-writes");
  try {
    await f.manager.registerPersonFolderWorkspace({ workspaceId: "my-project", ownerRunId: PERSON, root: f.folder });
    const own = (await f.manager.acquireLease("my-project", PERSON)).lease!.id;
    const main = await f.manager.read("my-project", "src/main.py");
    await f.manager.writeExpected("my-project", own, "src/main.py", "print('mine')\n", main.sha256);
    await f.manager.releaseLease("my-project", own);
    const container = path.join(f.appData, "workspaces-v2", "my-project");
    assert.equal(await stat(path.join(container, "preimages")).then(() => true, () => false), false);
    // Edited outside the manager since it last wrote the file: forgotten, not blocked.
    await writeFile(path.join(f.folder, "src", "main.py"), "print('edited in my editor')\n");
    await f.manager.attachRunToPersonWorkspace("my-project", "run-3");
    const resumed = await f.manager.resumeWorkspace("my-project", "run-3");
    assert.equal(resumed.status, "active");
    assert.equal(resumed.hashes.files["src/main.py"], undefined);
  } finally {
    await f.cleanup();
  }
});

test("opening a person's folder sweeps an interrupted write's leftovers, and only those", async () => {
  const f = await fixture("sweep");
  try {
    await f.manager.registerPersonFolderWorkspace({ workspaceId: "my-project", ownerRunId: PERSON, root: f.folder });
    await writeFile(path.join(f.folder, "src", `${WORKSPACE_TEMPORARY_PREFIX_V2}new-abc.tmp`), "half-written\n");
    await writeFile(path.join(f.folder, "src", `${WORKSPACE_TEMPORARY_PREFIX_V2}old-def.bak`), "the only copy\n");
    await writeFile(path.join(f.folder, `${WORKSPACE_TEMPORARY_PREFIX_V2}notes.txt`), "the person's own\n");
    await mkdir(path.join(f.folder, "node_modules"), { recursive: true });
    await writeFile(path.join(f.folder, "node_modules", `${WORKSPACE_TEMPORARY_PREFIX_V2}new-zzz.tmp`), "skipped\n");
    const { leftovers } = await f.manager.registerPersonFolderWorkspace({ workspaceId: "my-project", ownerRunId: PERSON, root: f.folder });
    assert.deepEqual(leftovers, {
      removed: [`src/${WORKSPACE_TEMPORARY_PREFIX_V2}new-abc.tmp`],
      keptAside: [`src/${WORKSPACE_TEMPORARY_PREFIX_V2}old-def.bak`],
      truncated: false,
    });
    const files = Object.keys(await tree(f.folder));
    assert.ok(files.includes(`${WORKSPACE_TEMPORARY_PREFIX_V2}notes.txt`));
    assert.ok(files.includes(`node_modules/${WORKSPACE_TEMPORARY_PREFIX_V2}new-zzz.tmp`));
    assert.ok(!files.some((name) => name.startsWith("src/.agentws")));
    const kept = path.join(f.appData, "workspaces-v2", "my-project", "leftovers");
    const [stamp] = await readdir(kept);
    assert.equal(await readFile(path.join(kept, stamp!, "src", `${WORKSPACE_TEMPORARY_PREFIX_V2}old-def.bak`), "utf8"), "the only copy\n");
  } finally {
    await f.cleanup();
  }
});

test("every temporary file a write makes beside its target carries the prefix and is gone after", async () => {
  const f = await fixture("temporaries");
  try {
    await f.manager.registerPersonFolderWorkspace({ workspaceId: "my-project", ownerRunId: PERSON, root: f.folder });
    const lease = await attachedLease(f, "run-4");
    const main = await f.manager.read("my-project", "src/main.py");
    await f.manager.applyFileChanges("my-project", lease, [
      { kind: "write", path: "src/main.py", expectedSha256: main.sha256, content: "print('batch')\n" },
      { kind: "create", path: "src/other.py", content: "OTHER = 2\n" },
    ]);
    await f.manager.importSandboxArtifacts({
      workspaceId: "my-project",
      leaseId: lease,
      artifacts: [{ relativePath: "src/generated.txt", bytes: Buffer.from("generated\n"), expectedSha256: `sha256:${createHash("sha256").update("generated\n").digest("hex")}`, maxBytes: 1_000 }],
    });
    const names = (await readdir(f.folder, { recursive: true })).map(String);
    assert.equal(names.some((name) => path.basename(name).startsWith(".")), false, JSON.stringify(names));
    assert.equal(await sha(path.join(f.folder, "src", "main.py")), `sha256:${createHash("sha256").update("print('batch')\n").digest("hex")}`);
  } finally {
    await f.cleanup();
  }
});
