import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ExtensionToolContributionV1,
  PreparedActionV1,
  ScopedExtensionContextV1,
} from "../packages/core-api/src";
import {
  createCodeWorkspaceToolContributionsV2,
  type RepositoryInspectionV2,
  type WorkspaceRepositoryProvisionerV2,
} from "../extensions/code/workspaceTools";
import { WorkspaceManagerErrorV2, WorkspaceManagerV2 } from "../extensions/code/workspaces";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories";
import { serializeToolResultForModel } from "../src/model/toolResultPayload";

const NL = "\n";
const lines = (...text: string[]) => text.join(NL) + NL;

const APP = lines("import { a } from \"./a\";", "", "export const value = a;");
const OLD_NAME = lines("export const name = \"old\";");
const NOTES = lines("one", "two");

const FOUR_FILE_PATCH = lines(
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " import { a } from \"./a\";",
  "+import { b } from \"./lib/b\";",
  " ",
  "-export const value = a;",
  "+export const value = a + b;",
  "diff --git a/src/lib/b.ts b/src/lib/b.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/lib/b.ts",
  "@@ -0,0 +1 @@",
  "+export const b = 2;",
  "diff --git a/notes/old.txt b/notes/old.txt",
  "deleted file mode 100644",
  "--- a/notes/old.txt",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-one",
  "-two",
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "rename from src/old-name.ts",
  "rename to src/new-name.ts",
  "--- a/src/old-name.ts",
  "+++ b/src/new-name.ts",
  "@@ -1 +1 @@",
  "-export const name = \"old\";",
  "+export const name = \"new\";",
);

test("a four-file patch is one prepared action, and it lands as one change", async () => {
  const fixture = await createFixture("lands");
  try {
    const { tools, context } = await scratchWithFiles(fixture, {
      "src/app.ts": APP,
      "src/old-name.ts": OLD_NAME,
      "notes/old.txt": NOTES,
    });
    const applyPatch = tools.get("code_workspace_apply_patch")!;
    assert.equal(applyPatch.descriptor.effect, "reversible_mutation");
    assert.equal(applyPatch.descriptor.execution.preparation, "required");
    const action = await requirePrepared(applyPatch, { patch: FOUR_FILE_PATCH }, context);
    assert.equal(action.target.path, "src/app.ts");
    assert.deepEqual(action.relatedResources.map((resource) => resource.path).sort(), [
      "notes/old.txt",
      "src/lib/b.ts",
      "src/new-name.ts",
      "src/old-name.ts",
    ]);
    // A patch that deletes a file asks as a delete does.
    assert.equal(action.preview.after?.operation, "trash");
    assert.equal(action.preview.destination, "4 files");
    assert.match(action.preview.summary, /src\/app\.ts: \+2 −1/u);
    assert.match(action.preview.summary, /src\/lib\/b\.ts: new file, \+1 −0/u);
    assert.match(action.preview.summary, /notes\/old\.txt: deleted to the workspace trash, \+0 −2/u);
    assert.match(action.preview.summary, /src\/old-name\.ts → src\/new-name\.ts: renamed, \+1 −1/u);
    const bound = action.normalizedArgs.files as Array<Record<string, unknown>>;
    assert.deepEqual(bound.map((file) => [file.kind, file.path, file.fromPath]), [
      ["modify", "src/app.ts", null],
      ["add", "src/lib/b.ts", null],
      ["delete", "notes/old.txt", null],
      ["rename", "src/new-name.ts", "src/old-name.ts"],
    ]);
    assert.equal(bound[0]!.expectedSha256, sha256Text(APP));
    assert.equal(bound[2]!.expectedAfterSha256, null);
    // The new text is the patch's to carry; the action holds only hashes.
    assert.equal(Object.keys(bound[0]!).includes("after"), false);
    assert.equal(fixture.read("src/app.ts"), APP, "nothing is written by preparing");

    const committed = await applyPatch.executePrepared!(action, authorize(context, action));
    assert.equal(fixture.read("src/app.ts"), lines("import { a } from \"./a\";", "import { b } from \"./lib/b\";", "", "export const value = a + b;"));
    assert.equal(fixture.read("src/lib/b.ts"), lines("export const b = 2;"));
    assert.equal(existsSync(fixture.file("notes/old.txt")), false);
    assert.equal(existsSync(fixture.file("src/old-name.ts")), false);
    assert.equal(fixture.read("src/new-name.ts"), lines("export const name = \"new\";"));
    assert.deepEqual(committed.receipt.effects?.changedFields?.sort(), [
      "notes/old.txt",
      "src/app.ts",
      "src/lib/b.ts",
      "src/new-name.ts",
      "src/old-name.ts",
    ]);
    assert.equal(committed.receipt.effects?.affectedCount, 4);
    assert.equal(committed.receipt.commitKind, "committed");
    const output = committed.output as { files: Array<Record<string, unknown>>; receipts: Array<Record<string, unknown>> };
    assert.deepEqual(output.receipts.map((receipt) => receipt.operation), ["patch", "create", "trash", "move"]);
    // The deleted file is in the workspace trash, where restore finds it.
    const trashId = output.files[2]!.trashId as string;
    const trash = await fixture.manager.inspectTrash("run-apply-patch", trashId);
    assert.equal(trash.originalPath, "notes/old.txt");
    const manifest = await fixture.manager.loadManifest("run-apply-patch");
    assert.deepEqual(
      ["notes/old.txt", "src/app.ts", "src/lib/b.ts", "src/new-name.ts", "src/old-name.ts"].every((touched) => manifest.budget.changedPaths.includes(touched)),
      true,
    );
    assert.equal(manifest.hashes.files["src/old-name.ts"], undefined);
    assert.equal(manifest.hashes.files["src/new-name.ts"]?.sha256, sha256Text(lines("export const name = \"new\";")));

    // What the model is sent: one line per file, and nothing it is not told about.
    const serialized = serializeToolResultForModel({ ok: true, toolName: "code_workspace_apply_patch", output: { ...output, diagnostics: "After this edit: no problems." } });
    const envelope = JSON.parse(serialized) as Record<string, any>;
    assert.equal(envelope.summary, "Applied the patch to 4 files.");
    assert.equal(envelope.truncated, false);
    assert.equal(envelope.omittedKeys, undefined);
    assert.equal(envelope.output.changes, [
      "src/app.ts: +2 −1",
      "src/lib/b.ts: new file, +1 −0",
      "notes/old.txt: deleted to the workspace trash, +0 −2",
      "src/old-name.ts → src/new-name.ts: renamed, +1 −1",
    ].join("\n"));
    assert.equal(envelope.output.diagnostics, "After this edit: no problems.");

    // An execution cut off after it landed reconciles from the files themselves.
    const reconciled = await applyPatch.reconcile!(action, context);
    assert.equal(reconciled.outcome, "committed");
  } finally {
    await fixture.cleanup();
  }
});

test("a patch that does not apply changes nothing and says which hunk", async () => {
  const fixture = await createFixture("mismatch");
  try {
    const { tools, context } = await scratchWithFiles(fixture, { "src/app.ts": APP, "src/b.ts": lines("export const b = 1;") });
    const result = await tools.get("code_workspace_apply_patch")!.prepare!({
      patch: lines(
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -1 +1 @@",
        "-export const b = 1;",
        "+export const b = 2;",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "-import { a } from \"./a\";",
        "+import { a } from \"./alpha\";",
        "@@ -3 +3 @@",
        "-export const value = alpha;",
        "+export const value = a;",
      ),
    }, context);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "patch_hunk_mismatch");
    assert.match(result.error.message, /^Hunk 2 of src\/app\.ts does not apply/u);
    assert.equal(fixture.read("src/b.ts"), lines("export const b = 1;"));
    assert.equal(fixture.read("src/app.ts"), APP);

    const absent = await tools.get("code_workspace_apply_patch")!.prepare!({
      patch: lines("--- a/src/missing.ts", "+++ b/src/missing.ts", "@@ -1 +1 @@", "-a", "+b"),
    }, context);
    assert.equal(absent.ok, false);
    if (!absent.ok) {
      assert.equal(absent.error.code, "path_not_found");
      assert.match(absent.error.message, /--- \/dev\/null/u);
    }
    const exists = await tools.get("code_workspace_apply_patch")!.prepare!({
      patch: lines("--- /dev/null", "+++ b/src/b.ts", "@@ -0,0 +1 @@", "+export const b = 3;"),
    }, context);
    assert.equal(exists.ok, false);
    if (!exists.ok) assert.equal(exists.error.code, "path_exists");
  } finally {
    await fixture.cleanup();
  }
});

test("a file that changes after the approval refuses the whole patch", async () => {
  const fixture = await createFixture("drift");
  try {
    const { tools, context } = await scratchWithFiles(fixture, { "src/app.ts": APP, "src/old-name.ts": OLD_NAME, "notes/old.txt": NOTES });
    const applyPatch = tools.get("code_workspace_apply_patch")!;
    const action = await requirePrepared(applyPatch, { patch: FOUR_FILE_PATCH }, context);
    const notes = await fixture.manager.read("run-apply-patch", "notes/old.txt");
    await prepareAndExecute(tools.get("code_workspace_write_expected")!, {
      path: "notes/old.txt",
      content: lines("one", "two", "three"),
      expectedSha256: notes.sha256,
    }, context);
    await assert.rejects(
      applyPatch.executePrepared!(action, authorize(context, action)),
      (error: unknown) =>
        error instanceof WorkspaceManagerErrorV2 &&
        error.code === "precondition_failed" &&
        error.message.startsWith("notes/old.txt changed after the patch was approved"),
    );
    assert.equal(fixture.read("src/app.ts"), APP);
    assert.equal(fixture.read("src/old-name.ts"), OLD_NAME);
    assert.equal(existsSync(fixture.file("src/lib/b.ts")), false);
    const reconciled = await applyPatch.reconcile!(action, context);
    assert.equal(reconciled.outcome, "still_uncertain");
  } finally {
    await fixture.cleanup();
  }
});

test("a failure part-way puts every file back", async () => {
  let hook: (() => void) | null = null;
  const fixture = await createFixture("atomic", () => hook?.());
  try {
    const { tools, context } = await scratchWithFiles(fixture, { "src/app.ts": APP, "notes/old.txt": NOTES });
    const applyPatch = tools.get("code_workspace_apply_patch")!;
    const action = await requirePrepared(applyPatch, {
      patch: lines(
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -3 +3 @@",
        "-export const value = a;",
        "+export const value = a * 2;",
        "--- a/notes/old.txt",
        "+++ /dev/null",
        "--- /dev/null",
        "+++ b/src/zz.ts",
        "@@ -0,0 +1 @@",
        "+export const zz = true;",
      ),
    }, context);
    const before = await fixture.manager.loadManifest("run-apply-patch");
    // Once the first file has its new text, the next id the manager asks for
    // is the trash entry's; another writer makes the third file's path then.
    hook = () => {
      if (readFileSync(fixture.file("src/app.ts"), "utf8").includes("a * 2") && !existsSync(fixture.file("src/zz.ts"))) {
        writeFileSync(fixture.file("src/zz.ts"), "someone else's\n");
        hook = null;
      }
    };
    await assert.rejects(
      applyPatch.executePrepared!(action, authorize(context, action)),
      (error: unknown) => error instanceof WorkspaceManagerErrorV2 && error.code === "path_exists",
    );
    assert.equal(hook, null, "the other writer ran mid-batch");
    assert.equal(fixture.read("src/app.ts"), APP);
    assert.equal(fixture.read("notes/old.txt"), NOTES);
    assert.equal(fixture.read("src/zz.ts"), "someone else's\n", "what another writer made is left alone");
    const after = await fixture.manager.loadManifest("run-apply-patch");
    assert.deepEqual(after.hashes, before.hashes);
    assert.deepEqual(after.budget, before.budget);
    assert.deepEqual(await trashEntries(fixture), []);
    const leftovers = (await readdir(fixture.file("src"))).filter((name) => name.startsWith("."));
    assert.deepEqual(leftovers, [], "no temporary or backup files are left");
  } finally {
    await fixture.cleanup();
  }
});

test("a patch over protected files asks as a single write would, and redetects the profile", async () => {
  const fixture = await createFixture("protected");
  try {
    const tools = toolMap(createCodeWorkspaceToolContributionsV2({
      manager: fixture.manager,
      repositoryProvisioner: fixture.repositories,
      isForegroundUserMission: () => true,
    }));
    const context = fixture.context("Use trusted profile fixture-profile and update its controls.");
    await prepareAndExecute(tools.get("code_workspace_create")!, {
      workspaceId: "protected-space",
      kind: "repository",
      repositoryProfileKey: "fixture-profile",
    }, context);
    const action = await requirePrepared(tools.get("code_workspace_apply_patch")!, {
      workspaceId: "protected-space",
      patch: lines(
        "--- a/package.json",
        "+++ b/package.json",
        "@@ -1 +1 @@",
        "-{\"name\":\"fixture\"}",
        "+{\"name\":\"updated\"}",
        "--- a/.github/workflows/ci.yml",
        "+++ b/.github/workflows/ci.yml",
        "@@ -1 +1 @@",
        "-name: ci",
        "+name: updated",
      ),
    }, context);
    assert.equal(action.requiredConfirmations, 2);
    assert.equal(action.normalizedArgs.requiresProfileRedetection, true);
    assert.match(action.preview.warnings.join(" "), /double-exact.*profile re-detection/iu);
    assert.equal(action.target.repositoryProfileId, "fixture-profile");
    const weakened = { ...action, requiredConfirmations: 1 as const };
    await assert.rejects(
      tools.get("code_workspace_apply_patch")!.executePrepared!(weakened, authorize(context, weakened)),
      /fingerprint changed/u,
    );
    await tools.get("code_workspace_apply_patch")!.executePrepared!(action, authorize(context, action));
    assert.equal(fixture.redetectionCount(), 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a batch holds the workspace's change budget before it writes anything", async () => {
  const fixture = await createFixture("budget");
  try {
    await fixture.manager.createScratchWorkspace({ workspaceId: "budget-space", ownerRunId: "run-budget" });
    const leased = await fixture.manager.acquireLease("budget-space", "extension:run-budget");
    const leaseId = leased.lease!.id;
    for (let index = 0; index < 99; index += 1) {
      await fixture.manager.createFile("budget-space", leaseId, `f/${index}.txt`, `${index}\n`);
    }
    await assert.rejects(
      fixture.manager.applyFileChanges("budget-space", leaseId, [
        { kind: "create", path: "g/one.txt", content: "one\n" },
        { kind: "create", path: "g/two.txt", content: "two\n" },
      ]),
      (error: unknown) => error instanceof WorkspaceManagerErrorV2 && error.code === "workspace_file_budget_exceeded",
    );
    const root = (await fixture.manager.loadManifest("budget-space")).canonicalRoot;
    assert.equal(existsSync(path.join(root, "g")), false, "not even a folder is made");
    await assert.rejects(
      fixture.manager.applyFileChanges("budget-space", leaseId, Array.from({ length: 21 }, (_, index) => ({
        kind: "create" as const,
        path: `h/${index}.txt`,
        content: "x\n",
      }))),
      (error: unknown) => error instanceof WorkspaceManagerErrorV2 && error.code === "invalid_changes",
    );
  } finally {
    await fixture.cleanup();
  }
});

async function scratchWithFiles(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  files: Record<string, string>,
) {
  const tools = toolMap(createCodeWorkspaceToolContributionsV2({
    manager: fixture.manager,
    repositoryProvisioner: fixture.repositories,
    isForegroundUserMission: () => true,
  }));
  const context = fixture.context("Change several files in one patch.");
  await prepareAndExecute(tools.get("code_workspace_create")!, { workspaceId: "run-apply-patch", kind: "scratch" }, context);
  for (const [filePath, content] of Object.entries(files)) {
    await prepareAndExecute(tools.get("code_workspace_create_file")!, { path: filePath, content }, context);
  }
  fixture.useWorkspace((await fixture.manager.loadManifest("run-apply-patch")).canonicalRoot);
  return { tools, context };
}

async function trashEntries(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<string[]> {
  const folder = path.join(fixture.root, "app-data", "workspaces-v2", "run-apply-patch", "trash");
  return readdir(folder).catch(() => []);
}

async function createFixture(name: string, onRandomId?: () => void) {
  const root = await mkdtemp(path.join(tmpdir(), `code-apply-patch-${name}-`));
  const repositoryRoot = path.join(root, "repository");
  await mkdir(repositoryRoot);
  await writeFile(path.join(repositoryRoot, ".git"), "gitdir: fixture\n", "utf8");
  let sequence = 0;
  let milliseconds = Date.parse("2026-07-12T21:00:00.000Z");
  const manager = new WorkspaceManagerV2({
    applicationDataRoot: path.join(root, "app-data"),
    now: () => new Date(milliseconds += 1),
    randomId: () => {
      onRandomId?.();
      return `tool-${++sequence}`;
    },
  });
  const inspection: RepositoryInspectionV2 = {
    repositoryRoot: await realpath(repositoryRoot),
    baseSha: "a".repeat(40),
    branch: "main",
    clean: true,
  };
  const profile = detectRepositoryProfileV2({
    key: "fixture-profile",
    displayName: "Fixture profile",
    repositoryRoot: inspection.repositoryRoot,
    defaultBranch: "main",
    files: ["package.json", "package-lock.json", ".github/workflows/ci.yml"],
    fileContents: { "package.json": "{\"name\":\"fixture\"}\n" },
  });
  let redetections = 0;
  const repositories: WorkspaceRepositoryProvisionerV2 = {
    resolveProfile: async (profileKey) => (profileKey === "fixture-profile" ? inspection.repositoryRoot : null),
    resolveProfileContract: async (profileKey) => (profileKey === "fixture-profile" ? profile : null),
    resolveProfileByRoot: async () => profile,
    redetectProfile: async () => { redetections += 1; },
    inspect: async () => inspection,
    provision: async ({ workspaceId, profileKey }) => {
      const worktreeRoot = path.join(root, `worktree-${workspaceId}`);
      const branch = `codex/workspace-${workspaceId}`;
      await mkdir(path.join(worktreeRoot, ".github", "workflows"), { recursive: true });
      await writeFile(path.join(worktreeRoot, ".git"), "gitdir: fixture\n", "utf8");
      await writeFile(path.join(worktreeRoot, "package.json"), "{\"name\":\"fixture\"}\n", "utf8");
      await writeFile(path.join(worktreeRoot, "package-lock.json"), "{}\n", "utf8");
      await writeFile(path.join(worktreeRoot, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
      return {
        ...inspection,
        branch,
        profileKey,
        worktreeRoot: await realpath(worktreeRoot),
        bindingFingerprint: sha256Json({ profileKey, repositoryRoot: inspection.repositoryRoot, baseSha: inspection.baseSha, branch }),
      };
    },
  };
  let workspaceRoot = "";
  const context = (originalPrompt: string): ScopedExtensionContextV1 => ({
    version: 1,
    extensionId: "agentic-researcher-code",
    missionId: "run-apply-patch",
    operationId: `operation-${++sequence}`,
    originalPrompt,
    abortSignal: new AbortController().signal,
    now: () => new Date(milliseconds += 1),
    reportProgress: () => undefined,
  });
  return {
    root,
    manager,
    repositories,
    context,
    redetectionCount: () => redetections,
    useWorkspace: (canonicalRoot: string) => { workspaceRoot = canonicalRoot; },
    file: (relativePath: string) => path.join(workspaceRoot, ...relativePath.split("/")),
    read: (relativePath: string) => readFileSync(path.join(workspaceRoot, ...relativePath.split("/")), "utf8"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function toolMap(contributions: ExtensionToolContributionV1[]) {
  return new Map(contributions.map((item) => [item.tool.name, item.tool]));
}

async function requirePrepared(
  tool: ExtensionToolContributionV1["tool"],
  args: Record<string, unknown>,
  context: ScopedExtensionContextV1,
): Promise<PreparedActionV1> {
  const result = await tool.prepare!(args, context);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.action;
}

async function prepareAndExecute(
  tool: ExtensionToolContributionV1["tool"],
  args: Record<string, unknown>,
  context: ScopedExtensionContextV1,
) {
  const action = await requirePrepared(tool, args, context);
  return tool.executePrepared!(action, authorize(context, action));
}

function authorize(context: ScopedExtensionContextV1, action: PreparedActionV1): ScopedExtensionContextV1 {
  return {
    ...context,
    authorizedAction: {
      preparedActionId: action.id,
      payloadFingerprint: action.payloadFingerprint,
      grantId: "grant-apply-patch",
    },
  };
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

