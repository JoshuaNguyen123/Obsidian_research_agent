import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ExtensionToolContributionV1,
  PreparedActionV1,
  ScopedExtensionContextV1,
} from "../packages/core-api/src";
import { ExtensionRegistry } from "../src/extensions/ExtensionRegistry";
import { evaluateActionPolicy } from "../src/agent/policyEngine";
import { verifyPreparedActionFingerprint } from "../src/agent/actions/canonicalize";
import {
  CODE_WORKSPACE_TOOL_NAMES_V2,
  createCodeWorkspaceToolContributionsV2,
  type RepositoryInspectionV2,
  type WorkspaceRepositoryProvisionerV2,
} from "../extensions/code/workspaceTools";
import { WorkspaceManagerV2 } from "../extensions/code/workspaces";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories";
import { CODE_CREATION_LANGUAGE_CATALOG_V1 } from "../extensions/code/CodeCreationLanguagesV1";

test("workspace contribution factory replaces every new and legacy tool name", async () => {
  const fixture = await createFixture("names");
  try {
    const contributions = createCodeWorkspaceToolContributionsV2({
      manager: fixture.manager,
      repositoryProvisioner: fixture.repositories,
      isForegroundUserMission: () => true,
    });
    assert.deepEqual(
      contributions.map((item) => item.tool.name),
      [...CODE_WORKSPACE_TOOL_NAMES_V2],
    );
    assert.equal(new Set(contributions.map((item) => item.tool.name)).size, 21);
    for (const contribution of contributions) {
      assert.equal(contribution.descriptor.kind, "tool");
      assert.equal(contribution.tool.descriptor.capability.system === "workspace" || contribution.tool.descriptor.capability.system === "git", true);
      if (contribution.tool.descriptor.effect === "read") {
        assert.equal(contribution.tool.descriptor.execution.preparation, "none");
        assert.equal(contribution.tool.descriptor.approval.fallback, "none");
      } else {
        assert.equal(contribution.tool.descriptor.execution.preparation, "required");
        assert.equal(contribution.tool.descriptor.approval.fallback, "exact");
        assert.deepEqual(contribution.tool.descriptor.durability, {
          journal: true,
          receipt: true,
          readback: "required",
          reconciliation: "required",
        });
        assert.equal(typeof contribution.tool.prepare, "function");
        assert.equal(typeof contribution.tool.executePrepared, "function");
        assert.equal(typeof contribution.tool.reconcile, "function");
      }
    }
    const tools = toolMap(contributions);
    const context = fixture.context("Write a legacy workspace file.");
    await prepareAndExecute(
      tools.get("code_workspace_create")!,
      { workspaceId: "run-tools-v2", kind: "scratch" },
      context,
    );
    await assert.rejects(
      tools.get("write_workspace_file")!.execute(
        { path: "legacy.ts", content: "export const legacy = true;\n" },
        context,
      ),
      /must be prepared/u,
    );
    const legacyPrepared = await requirePrepared(
      tools.get("write_workspace_file")!,
      { path: "legacy.ts", content: "export const legacy = true;\n" },
      context,
    );
    assert.equal(legacyPrepared.normalizedArgs.mutationMode, "create");
    assert.equal(legacyPrepared.normalizedArgs.expectedTargetState, "absent");
    const legacyCommitted = await tools.get("write_workspace_file")!.executePrepared!(
      legacyPrepared,
      authorize(context, legacyPrepared),
    );
    assert.equal(
      legacyCommitted.receipt.operation,
      tools.get("write_workspace_file")!.descriptor.capability.action,
    );
    assert.equal(
      (legacyCommitted.output as { receipt?: { operation?: string } } | undefined)
        ?.receipt?.operation,
      "create",
    );
    const read = await tools.get("read_workspace_file")!.execute(
      { path: "legacy.ts" },
      context,
    ) as { content: string };
    assert.match(read.content, /legacy = true/u);
  } finally {
    await fixture.cleanup();
  }
});

test("prepared workspace creation supports eleven explicit source languages", async () => {
  const fixture = await createFixture("languages");
  try {
    const tools = toolMap(createCodeWorkspaceToolContributionsV2({
      manager: fixture.manager,
      repositoryProvisioner: fixture.repositories,
      isForegroundUserMission: () => true,
    }));
    const context = fixture.context("Create a multi-language source workspace.");
    await prepareAndExecute(
      tools.get("code_workspace_create")!,
      { workspaceId: "language-space", kind: "scratch" },
      context,
    );
    const files = [
      { language: "python", path: "app.py", content: "print('ok')\n" },
      { language: "typescript", path: "app.ts", content: "export const ok: boolean = true;\n" },
      { language: "javascript", path: "app.js", content: "export const ok = true;\n" },
      { language: "c", path: "app.c", content: "int main(void) { return 0; }\n" },
      { language: "cpp", path: "app.cpp", content: "int main() { return 0; }\n" },
      { language: "html", path: "index.html", content: "<!doctype html><title>OK</title>\n" },
      { language: "css", path: "styles.css", content: "body { color: green; }\n" },
      { language: "rust", path: "app.rs", content: "fn main() {}\n" },
      { language: "go", path: "app.go", content: "package main\nfunc main() {}\n" },
      { language: "java", path: "App.java", content: "final class App {}\n" },
      { language: "csharp", path: "Program.cs", content: "internal static class Program {}\n" },
    ] as const;
    assert.deepEqual(
      CODE_CREATION_LANGUAGE_CATALOG_V1.map((language) => language.id),
      files.map((file) => file.language),
    );
    const createTool = tools.get("code_workspace_create_file")!;
    assert.match(createTool.description, /Python, TypeScript, JavaScript, C, C\+\+/u);
    assert.match(createTool.description, /HTML, CSS, Rust, Go, Java, and C#/u);
    for (const file of files) {
      const prepared = await requirePrepared(
        createTool,
        { workspaceId: "language-space", path: file.path, content: file.content },
        context,
      );
      assert.equal(prepared.normalizedArgs.creationLanguage, file.language);
      await createTool.executePrepared!(prepared, authorize(context, prepared));
      const readback = await tools.get("code_workspace_read")!.execute(
        { workspaceId: "language-space", path: file.path },
        context,
      ) as { content: string };
      assert.equal(readback.content, file.content);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("workspace tools prepare every mutation and return exact readback receipts", async () => {
  const fixture = await createFixture("mutations");
  try {
    const tools = toolMap(createCodeWorkspaceToolContributionsV2({
      manager: fixture.manager,
      repositoryProvisioner: fixture.repositories,
      isForegroundUserMission: () => true,
    }));
    const context = fixture.context("Create and edit files in workspace tool-space.");
    const scratchTool = tools.get("code_workspace_create")!;
    await assert.rejects(
      scratchTool.execute({ workspaceId: "tool-space", kind: "scratch" }, context),
      /must be prepared/u,
    );
    const scratchPrepared = await requirePrepared(
      scratchTool,
      { workspaceId: "tool-space", kind: "scratch" },
      context,
    );
    assert.equal(scratchPrepared.normalizedArgs.expectedWorkspaceState, "absent");
    assert.equal(scratchPrepared.normalizedArgs.ownerRunId, "run-tools-v2");
    assert.equal(scratchPrepared.normalizedArgs.leaseId, null);
    assert.equal(scratchPrepared.normalizedArgs.payloadBytes, 0);
    await assert.rejects(fixture.manager.loadManifest("tool-space"), /does not exist/u);
    const scratch = await scratchTool.executePrepared!(
      scratchPrepared,
      authorize(context, scratchPrepared),
    );
    assert.equal(scratch.receipt.readback.status, "verified");

    const mkdirTool = tools.get("code_workspace_mkdir")!;
    const mkdirPrepared = await requirePrepared(
      mkdirTool,
      { workspaceId: "tool-space", path: "public/assets" },
      context,
    );
    assert.equal(mkdirPrepared.normalizedArgs.expectedTargetState, "absent");
    assert.equal(mkdirPrepared.normalizedArgs.payloadBytes, 0);
    const madeDirectory = await mkdirTool.executePrepared!(
      mkdirPrepared,
      authorize(context, mkdirPrepared),
    );
    assert.equal(madeDirectory.receipt.operation, "create");
    assert.equal((await fixture.manager.stat("tool-space", "public/assets")).kind, "directory");

    const createFileTool = tools.get("code_workspace_create_file")!;
    await assert.rejects(
      createFileTool.execute(
        { workspaceId: "tool-space", path: "index.html", content: "<h1>Before</h1>\n" },
        context,
      ),
      /must be prepared/u,
    );
    const createPrepared = await requirePrepared(
      createFileTool,
      { workspaceId: "tool-space", path: "index.html", content: "<h1>Before</h1>\n" },
      context,
    );
    assert.equal(createPrepared.normalizedArgs.expectedTargetState, "absent");
    assert.equal(createPrepared.normalizedArgs.payloadBytes, 16);
    assert.equal(typeof createPrepared.normalizedArgs.leaseId, "string");
    const created = await createFileTool.executePrepared!(
      createPrepared,
      authorize(context, createPrepared),
    );
    assert.equal(created.receipt.operation, "create");
    assert.equal(created.receipt.readback.status, "verified");
    assert.match((created.output as { receipt: { afterSha256: string } }).receipt.afterSha256, /^sha256:/u);

    const staleCreate = await requirePrepared(
      createFileTool,
      { workspaceId: "tool-space", path: "stale.txt", content: "first\n" },
      context,
    );
    await prepareAndExecute(
      createFileTool,
      { workspaceId: "tool-space", path: "stale.txt", content: "winner\n" },
      context,
    );
    await assert.rejects(
      createFileTool.executePrepared!(staleCreate, authorize(context, staleCreate)),
      /already exists/u,
    );
    assert.equal((await fixture.manager.read("tool-space", "stale.txt")).content, "winner\n");

    const writeTool = tools.get("code_workspace_write_expected")!;
    await assert.rejects(
      writeTool.execute(
        { workspaceId: "tool-space", path: "index.html", content: "<h1>After</h1>\n" },
        context,
      ),
      /must be prepared/u,
    );
    const prepared = await writeTool.prepare!(
      { workspaceId: "tool-space", path: "index.html", content: "<h1>After</h1>\n" },
      context,
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    assert.match(prepared.action.payloadFingerprint, /^sha256:/u);
    assert.equal(
      (await fixture.manager.read("tool-space", "index.html")).content,
      "<h1>Before</h1>\n",
      "prepare must not mutate bytes",
    );
    const authorized = authorize(context, prepared.action);
    const committed = await writeTool.executePrepared!(prepared.action, authorized);
    assert.equal(committed.mutationState, "applied");
    assert.equal(
      committed.receipt.operation,
      writeTool.descriptor.capability.action,
    );
    assert.equal(committed.receipt.readback.status, "verified");
    assert.equal(committed.receipt.payloadFingerprint, prepared.action.payloadFingerprint);
    assert.equal(
      (await fixture.manager.read("tool-space", "index.html")).content,
      "<h1>After</h1>\n",
    );

    const tampered: PreparedActionV1 = {
      ...prepared.action,
      normalizedArgs: { ...prepared.action.normalizedArgs, content: "tampered" },
    };
    await assert.rejects(
      writeTool.executePrepared!(tampered, authorize(context, tampered)),
      /fingerprint changed/u,
    );
    assert.equal(
      (await fixture.manager.read("tool-space", "index.html")).content,
      "<h1>After</h1>\n",
    );

    const appendTool = tools.get("code_workspace_append")!;
    const appendPrepared = await requirePrepared(
      appendTool,
      {
        workspaceId: "tool-space",
        path: "index.html",
        content: "<p>Tail</p>\n",
        expectedSha256: (await fixture.manager.stat("tool-space", "index.html")).sha256,
      },
      context,
    );
    assert.equal(appendPrepared.normalizedArgs.expectedTargetState, "existing");
    assert.equal(appendPrepared.normalizedArgs.payloadBytes, 12);
    const append = await appendTool.executePrepared!(
      appendPrepared,
      authorize(context, appendPrepared),
    );
    assert.equal(append.receipt.operation, "append");
    const preview = await tools.get("preview_workspace_html")!.execute(
      { workspaceId: "tool-space", htmlPath: "index.html" },
      context,
    ) as { execution: string; html: { sha256: string } };
    assert.equal(preview.execution, "blocked");
    assert.match(preview.html.sha256, /^sha256:/u);
    const artifact = await tools.get("export_workspace_artifact")!.execute(
      { workspaceId: "tool-space", workspacePath: "index.html" },
      context,
    ) as { artifact: { kind: string; sha256: string } };
    assert.equal(artifact.artifact.kind, "workspace_text_readback");
  } finally {
    await fixture.cleanup();
  }
});

test("move trash and restore require preparation and remain fingerprint bound", async () => {
  const fixture = await createFixture("lifecycle");
  try {
    const tools = toolMap(createCodeWorkspaceToolContributionsV2({
      manager: fixture.manager,
      repositoryProvisioner: fixture.repositories,
      isForegroundUserMission: () => true,
    }));
    const context = fixture.context("Move and trash workspace files.");
    await prepareAndExecute(
      tools.get("code_workspace_create")!,
      { workspaceId: "life-space" },
      context,
    );
    await prepareAndExecute(
      tools.get("code_workspace_create_file")!,
      { workspaceId: "life-space", path: "a.ts", content: "export const a = 1;\n" },
      context,
    );

    const moveTool = tools.get("code_workspace_move")!;
    await assert.rejects(
      moveTool.execute({ workspaceId: "life-space", path: "a.ts", destinationPath: "b.ts" }, context),
      /must be prepared/u,
    );
    const movePrepared = await requirePrepared(moveTool, {
      workspaceId: "life-space",
      path: "a.ts",
      destinationPath: "b.ts",
    }, context);
    await moveTool.executePrepared!(movePrepared, authorize(context, movePrepared));
    await assert.rejects(fixture.manager.read("life-space", "a.ts"));

    const trashTool = tools.get("code_workspace_trash")!;
    const trashPrepared = await requirePrepared(
      trashTool,
      { workspaceId: "life-space", path: "b.ts" },
      context,
    );
    const trashed = await trashTool.executePrepared!(
      trashPrepared,
      authorize(context, trashPrepared),
    );
    const trashId = (trashed.output as { receipt: { trashId: string } }).receipt.trashId;
    const restoreTool = tools.get("code_workspace_restore")!;
    const restorePrepared = await requirePrepared(
      restoreTool,
      { workspaceId: "life-space", trashId },
      context,
    );
    const restored = await restoreTool.executePrepared!(
      restorePrepared,
      authorize(context, restorePrepared),
    );
    assert.equal(restored.receipt.operation, "restore");
    assert.match((await fixture.manager.read("life-space", "b.ts")).content, /const a/u);
  } finally {
    await fixture.cleanup();
  }
});

test("the complete workspace contribution batch registers transactionally", async () => {
  const fixture = await createFixture("registry");
  try {
    const contributions = createCodeWorkspaceToolContributionsV2({
      manager: fixture.manager,
      repositoryProvisioner: fixture.repositories,
      isForegroundUserMission: () => true,
    });
    const registry = new ExtensionRegistry({ getCoreState: () => "ready" });
    const manifest = {
      id: "agentic-researcher-code",
      displayName: "Agentic Researcher Code",
      version: "0.2.0",
      apiMajor: 1,
      apiMinor: 2,
    };

    assert.throws(
      () => registry.registerExtension({
        manifest,
        contributions: [...contributions, contributions[0]],
      }),
      /duplicate extension contribution/iu,
    );
    assert.deepEqual(registry.getRegisteredExtensionIds(), []);
    assert.equal(registry.createMissionSnapshot("after-rejected-batch").tools.length, 0);

    registry.registerExtension({ manifest, contributions });
    const snapshot = registry.createMissionSnapshot("registered-workspace-batch");
    assert.equal(snapshot.tools.length, CODE_WORKSPACE_TOOL_NAMES_V2.length);
    assert.deepEqual(
      snapshot.tools.map((registered) => registered.contribution.tool.name),
      [...CODE_WORKSPACE_TOOL_NAMES_V2],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("raw repository roots require exact foreground prompt binding while logical profiles provision through prepared actions", async () => {
  const fixture = await createFixture("repository");
  try {
    const contributions = createCodeWorkspaceToolContributionsV2({
      manager: fixture.manager,
      repositoryProvisioner: fixture.repositories,
      isForegroundUserMission: (root, context) => context.originalPrompt?.includes(root) === true,
    });
    const create = toolMap(contributions).get("code_workspace_create")!;
    const canonicalRepo = await realpath(fixture.repositoryRoot);
    const denied = await create.prepare!(
      { workspaceId: "raw-denied", kind: "repository", repositoryRoot: canonicalRepo },
      fixture.context("Create a repository workspace."),
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "raw_repository_authority_missing");

    const rawContext = fixture.context(`Create an isolated worktree for ${canonicalRepo}.`);
    const rawPrepared = await requirePrepared(
      create,
      { workspaceId: "raw-allowed", kind: "repository", repositoryRoot: canonicalRepo },
      rawContext,
    );
    assert.equal(rawPrepared.target.system, "workspace");
    assert.equal(rawPrepared.target.resourceType, "code_workspace");
    assert.equal(await verifyPreparedActionFingerprint(rawPrepared), true);
    const hostDecision = evaluateActionPolicy({
      toolName: create.name,
      descriptor: create.descriptor,
      preparedAction: rawPrepared,
      principal: "single_agent",
      scopeAllowed: true,
      matchingGrant: null,
      isDesktop: true,
      writeAutonomy: false,
      now: rawContext.now(),
    });
    assert.equal(hostDecision.action, "require_approval");
    assert.doesNotMatch(hostDecision.reason, /does not match the tool descriptor/iu);
    const rawResult = await create.executePrepared!(
      rawPrepared,
      authorize(rawContext, rawPrepared),
    );
    assert.equal((rawResult.output as { kind: string }).kind, "repository");

    const profileContext = fixture.context("Use trusted profile fixture-profile.");
    const profilePrepared = await requirePrepared(
      create,
      {
        workspaceId: "profile-allowed",
        kind: "repository",
        repositoryProfileKey: "fixture-profile",
      },
      profileContext,
    );
    assert.equal(profilePrepared.normalizedArgs.profileKey, "fixture-profile");

    const equivalentPrepared = await requirePrepared(
      create,
      {
        workspaceId: "profile-and-root-equivalent",
        kind: "repository",
        repositoryProfileKey: "fixture-profile",
        repositoryRoot: canonicalRepo,
      },
      fixture.context(`Use trusted profile fixture-profile for ${canonicalRepo}.`),
    );
    assert.equal(equivalentPrepared.normalizedArgs.profileKey, "fixture-profile");
    assert.equal(equivalentPrepared.normalizedArgs.repositoryRoot, canonicalRepo);

    const conflicting = await create.prepare!(
      {
        workspaceId: "profile-and-root-conflict",
        kind: "repository",
        repositoryProfileKey: "fixture-profile",
        repositoryRoot: await realpath(fixture.root),
      },
      fixture.context(`Use trusted profile fixture-profile for ${fixture.root}.`),
    );
    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) assert.equal(conflicting.error.code, "repository_binding_conflict");
  } finally {
    await fixture.cleanup();
  }
});

test("repository protected controls escalate exact approvals and require profile re-detection", async () => {
  const fixture = await createFixture("protected-controls");
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
    const packageRead = await fixture.manager.read("protected-space", "package.json");
    const packageAction = await requirePrepared(tools.get("code_workspace_write_expected")!, {
      workspaceId: "protected-space",
      path: "package.json",
      content: "{\"name\":\"updated\"}\n",
      expectedSha256: packageRead.sha256,
    }, context);
    assert.equal(packageAction.requiredConfirmations, 1);
    assert.equal(packageAction.normalizedArgs.requiresProfileRedetection, true);
    assert.match(packageAction.preview.warnings.join(" "), /exact-diff.*profile re-detection/iu);
    await tools.get("code_workspace_write_expected")!.executePrepared!(packageAction, authorize(context, packageAction));
    assert.equal(fixture.redetectionCount(), 1);

    const workflowRead = await fixture.manager.read("protected-space", ".github/workflows/ci.yml");
    const workflowAction = await requirePrepared(tools.get("code_workspace_write_expected")!, {
      workspaceId: "protected-space",
      path: ".github/workflows/ci.yml",
      content: "name: updated\n",
      expectedSha256: workflowRead.sha256,
    }, context);
    assert.equal(workflowAction.requiredConfirmations, 2);
    const weakened = { ...workflowAction, requiredConfirmations: 1 as const };
    await assert.rejects(
      tools.get("code_workspace_write_expected")!.executePrepared!(weakened, authorize(context, weakened)),
      /fingerprint changed/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("workspace reconciliation resumes durable state and proves committed or not-applied outcomes", async () => {
  const fixture = await createFixture("reconciliation");
  try {
    const initial = toolMap(createCodeWorkspaceToolContributionsV2({ manager: fixture.manager, repositoryProvisioner: fixture.repositories }));
    const context = fixture.context("Create a restart-safe workspace file.");
    await prepareAndExecute(initial.get("code_workspace_create")!, { workspaceId: "reconcile-space" }, context);
    const committedAction = await requirePrepared(initial.get("code_workspace_create_file")!, {
      workspaceId: "reconcile-space", path: "committed.txt", content: "committed\n",
    }, context);
    await initial.get("code_workspace_create_file")!.executePrepared!(committedAction, authorize(context, committedAction));
    const pendingAction = await requirePrepared(initial.get("code_workspace_create_file")!, {
      workspaceId: "reconcile-space", path: "pending.txt", content: "pending\n",
    }, context);

    const restartedManager = new WorkspaceManagerV2({ applicationDataRoot: path.join(fixture.root, "app-data") });
    const restarted = toolMap(createCodeWorkspaceToolContributionsV2({ manager: restartedManager, repositoryProvisioner: fixture.repositories }));
    const committed = await restarted.get("code_workspace_create_file")!.reconcile!(committedAction, context);
    assert.equal(committed.outcome, "committed");
    assert.equal(committed.receipt?.readback.status, "verified");
    const notApplied = await restarted.get("code_workspace_create_file")!.reconcile!(pendingAction, context);
    assert.equal(notApplied.outcome, "not_applied");
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `code-tools-v2-${name}-`));
  const repositoryRoot = path.join(root, "repository");
  await mkdir(repositoryRoot);
  await writeFile(path.join(repositoryRoot, ".git"), "gitdir: fixture\n", "utf8");
  let sequence = 0;
  let milliseconds = Date.parse("2026-07-12T21:00:00.000Z");
  const manager = new WorkspaceManagerV2({
    applicationDataRoot: path.join(root, "app-data"),
    now: () => new Date(milliseconds += 1),
    randomId: () => `tool-${++sequence}`,
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
    resolveProfile: async (profileKey) =>
      profileKey === "fixture-profile" ? inspection.repositoryRoot : null,
    resolveProfileContract: async (profileKey) => profileKey === "fixture-profile" ? profile : null,
    redetectProfile: async () => { redetections += 1; },
    inspect: async (rootPath) => {
      assert.equal(await realpath(rootPath), inspection.repositoryRoot);
      return inspection;
    },
    provision: async ({ workspaceId, profileKey }) => {
      const worktreeRoot = path.join(root, `worktree-${workspaceId}`);
      const branch = `codex/workspace-${workspaceId}`;
      await mkdir(worktreeRoot);
      await writeFile(path.join(worktreeRoot, ".git"), "gitdir: fixture\n", "utf8");
      await mkdir(path.join(worktreeRoot, ".github", "workflows"), { recursive: true });
      await writeFile(path.join(worktreeRoot, "package.json"), "{\"name\":\"fixture\"}\n", "utf8");
      await writeFile(path.join(worktreeRoot, "package-lock.json"), "{}\n", "utf8");
      await writeFile(path.join(worktreeRoot, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
      return {
        ...inspection,
        branch,
        profileKey,
        worktreeRoot: await realpath(worktreeRoot),
        bindingFingerprint: sha256({
          profileKey,
          repositoryRoot: inspection.repositoryRoot,
          baseSha: inspection.baseSha,
          branch,
        }),
      };
    },
  };
  const context = (originalPrompt: string): ScopedExtensionContextV1 => ({
    version: 1,
    extensionId: "agentic-researcher-code",
    missionId: "run-tools-v2",
    operationId: `operation-${++sequence}`,
    originalPrompt,
    abortSignal: new AbortController().signal,
    now: () => new Date(milliseconds += 1),
    reportProgress: () => undefined,
  });
  return {
    root,
    repositoryRoot,
    manager,
    repositories,
    redetectionCount: () => redetections,
    context,
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

function authorize(
  context: ScopedExtensionContextV1,
  action: PreparedActionV1,
): ScopedExtensionContextV1 {
  return {
    ...context,
    authorizedAction: {
      preparedActionId: action.id,
      payloadFingerprint: action.payloadFingerprint,
      grantId: "grant-workspace-v2",
    },
  };
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
