import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type {
  ExtensionToolContributionV1,
  PreparedActionV1,
  ScopedExtensionContextV1,
} from "../packages/core-api/src";
import {
  createCodeWorkspaceToolContributionsV2,
} from "../extensions/code/workspaceTools";
import {
  WorkspaceManagerV2,
  type WorkspaceManifestV2,
} from "../extensions/code/workspaces";
import {
  FixedArgvArtifactHashReaderV1,
  FixedArgvRepairProofAdapterV1,
  SpawnFixedArgvGitRunnerV1,
} from "../extensions/code/repair";
import { detectSourceOnlyRepositoryProfileV2 } from "../extensions/code/repositories";
import {
  initializeScratchGitRepositoryV1,
  scratchRepositoryAgentBranchV1,
} from "../extensions/code/repositories/ScratchRepositoryPromotionV1";

const execFileAsync = promisify(execFile);

/**
 * Nothing here is handed a fixture repository. Every repository these tests
 * observe is one the production promotion path created from an ordinary
 * scratch workspace — which is the whole point of the capability: before it,
 * `git init` existed only inside e2e fixtures, so the commit and publication
 * gateways were reachable only for repositories a test had built beforehand.
 */

test("a scratch workspace promotes into a repository the commit gateway accepts", async () => {
  const fixture = await createFixture("promote");
  try {
    const tools = fixture.tools();
    const context = fixture.context("Write a small Python game and commit it.", "promote-space");
    await prepareAndExecute(
      tools.get("code_workspace_create")!,
      { workspaceId: "promote-space", kind: "scratch" },
      context,
    );
    await prepareAndExecute(
      tools.get("code_workspace_create_file")!,
      { path: "main.py", content: "print('hello')\n" },
      context,
    );
    await prepareAndExecute(
      tools.get("code_workspace_create_file")!,
      { path: "src/util.py", content: "VALUE = 1\n" },
      context,
    );

    const before = await fixture.manager.loadManifest("promote-space");
    assert.equal(before.kind, "scratch");
    assert.equal(before.repositoryBinding, null);
    assert.equal(before.baseSha, null);
    assert.deepEqual(before.budget.changedPaths, ["main.py", "src/util.py"]);

    const prepared = await requirePrepared(
      tools.get("code_workspace_init_repository")!,
      { workspaceId: "promote-space", commitMessage: "Initial commit" },
      context,
    );
    // The approval names the exact files, not a wildcard, and the branch is
    // host-derived rather than model-chosen.
    assert.deepEqual(prepared.normalizedArgs.trackedPaths, [
      "main.py",
      "src/util.py",
    ]);
    assert.equal(prepared.normalizedArgs.branch, "codex/workspace-promote-space");
    assert.match(prepared.preview.summary, /2 file\(s\) on branch/u);

    const committed = await tools.get("code_workspace_init_repository")!
      .executePrepared!(prepared, authorize(context, prepared));
    assert.equal(committed.mutationState, "applied");
    const output = committed.output as WorkspaceManifestV2 & {
      defaultBranch: string;
      trackedPaths: string[];
    };
    assert.equal(output.defaultBranch, "main");
    assert.deepEqual(output.trackedPaths, ["main.py", "src/util.py"]);

    const promoted = await fixture.manager.loadManifest("promote-space");
    assert.equal(promoted.kind, "repository");
    assert.match(promoted.baseSha ?? "", /^[0-9a-f]{40}$/u);
    assert.equal(
      promoted.repositoryBinding?.branch,
      "codex/workspace-promote-space",
    );
    assert.equal(
      promoted.repositoryBinding?.repositoryRoot,
      promoted.canonicalRoot,
    );
    assert.equal(
      promoted.repositoryBinding?.worktreeRoot,
      promoted.canonicalRoot,
    );
    // The initial commit is the new epoch, so the mission change budget resets.
    assert.deepEqual(promoted.budget.changedPaths, []);
    assert.equal(promoted.budget.changedBytes, 0);
    // Drift guards survive the promotion.
    assert.equal(Object.keys(promoted.hashes.files).length, 2);

    const gitDirectory = await fs.lstat(path.join(promoted.canonicalRoot, ".git"));
    assert.equal(gitDirectory.isDirectory(), true);
    const branches = await git(promoted.canonicalRoot, [
      "branch",
      "--format=%(refname:short)",
    ]);
    assert.deepEqual(
      branches.split("\n").map((line) => line.trim()).filter(Boolean).sort(),
      ["codex/workspace-promote-space", "main"],
    );

    // The exact precondition the verified-commit path resolves through. Before
    // this capability it could never be satisfied by a scratch workspace.
    const resolved = await fixture.proofAdapter(promoted).resolve({
      profileKey: "scratch-promote-space",
      workspaceId: "promote-space",
      runId: context.missionId!,
      requestId: "repair-1",
      manifest: promoted,
    });
    assert.equal(resolved?.worktreeBranch, "codex/workspace-promote-space");
    assert.equal(resolved?.profile.key, "scratch-promote-space");
  } finally {
    await fixture.cleanup();
  }
});

test("promotion is idempotent and refuses a second, different binding", async () => {
  const fixture = await createFixture("idempotent");
  try {
    const tools = fixture.tools();
    const context = fixture.context("Commit the project.", "idem-space");
    await prepareAndExecute(
      tools.get("code_workspace_create")!,
      { workspaceId: "idem-space", kind: "scratch" },
      context,
    );
    await prepareAndExecute(
      tools.get("code_workspace_create_file")!,
      { path: "main.py", content: "print(1)\n" },
      context,
    );
    const tool = tools.get("code_workspace_init_repository")!;
    const action = await requirePrepared(tool, {}, context);
    const first = await tool.executePrepared!(action, authorize(context, action));
    const firstSha = (first.output as WorkspaceManifestV2).baseSha;
    assert.match(firstSha ?? "", /^[0-9a-f]{40}$/u);

    // Re-executing the same approved action is a readback, never a second
    // repository. This is the path a retry after an interrupted run takes.
    const second = await tool.executePrepared!(action, authorize(context, action));
    assert.equal((second.output as WorkspaceManifestV2).baseSha, firstSha);
    assert.match(second.receipt.message, /Reused the promoted repository binding/u);

    const reconciled = await tool.reconcile!(action, context);
    assert.equal(reconciled.outcome, "committed");

    // Preparing a fresh promotion over the bound workspace yields a verified
    // no-op that records the existing binding — never a second repository.
    // (It used to refuse outright, which deadlocked planner-planted promotion
    // nodes whose workspace turned out to be already bound, 2026-08-25.)
    const reAction = await requirePrepared(tool, {}, context);
    assert.match(reAction.preview.summary, /already carries the trusted repository binding/u);
    const reResult = await tool.executePrepared!(
      reAction,
      authorize(context, reAction),
    );
    assert.equal((reResult.output as WorkspaceManifestV2).baseSha, firstSha);
    assert.match(
      reResult.receipt.message,
      /Recorded the existing repository binding/u,
    );
    assert.equal((await fixture.manager.loadManifest("idem-space")).kind, "repository");
  } finally {
    await fixture.cleanup();
  }
});

test("promotion refuses an empty workspace and an already-initialized one", async () => {
  const fixture = await createFixture("refusals");
  try {
    const tools = fixture.tools();
    const context = fixture.context("Commit the project.", "empty-space");
    await prepareAndExecute(
      tools.get("code_workspace_create")!,
      { workspaceId: "empty-space", kind: "scratch" },
      context,
    );
    await assert.rejects(
      () =>
        requirePrepared(
          tools.get("code_workspace_init_repository")!,
          {},
          context,
        ),
      /at least one durable file/u,
    );

    await prepareAndExecute(
      tools.get("code_workspace_create_file")!,
      { path: "main.py", content: "print(1)\n" },
      context,
    );
    const manifest = await fixture.manager.loadManifest("empty-space");
    // Someone put a repository there behind the manager's back.
    await git(manifest.canonicalRoot, ["init", "--quiet", "-b", "main"]);
    await assert.rejects(
      () =>
        prepareAndExecute(
          tools.get("code_workspace_init_repository")!,
          {},
          context,
        ),
      /never reinitializes or adopts an existing repository/u,
    );
    const unchanged = await fixture.manager.loadManifest("empty-space");
    assert.equal(unchanged.kind, "scratch");
  } finally {
    await fixture.cleanup();
  }
});

test("the manager door refuses a root outside the workspace container", async () => {
  const fixture = await createFixture("containment");
  try {
    const outside = path.join(fixture.root, "outside-checkout");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "a.txt"), "a\n", "utf8");
    await git(outside, ["init", "--quiet", "-b", "main"]);

    await fixture.manager.createScratchWorkspace({
      workspaceId: "contained",
      ownerRunId: "run-1",
    });
    const leased = await fixture.manager.acquireLease("contained", "owner-1");
    const canonicalOutside = await fs.realpath(outside);
    await assert.rejects(
      () =>
        fixture.manager.promoteScratchWorkspaceToRepositoryAfterVerifiedReadback({
          operationId: "op-1",
          workspaceId: "contained",
          ownerRunId: "run-1",
          leaseId: leased.lease!.id,
          profileKey: "scratch-contained",
          // The user's own checkout, not the agent's container.
          repositoryRoot: canonicalOutside,
          branch: "codex/workspace-contained",
          baseSha: "a".repeat(40),
          bindingFingerprint: `sha256:${"b".repeat(64)}`,
          handoffFingerprint: `sha256:${"c".repeat(64)}`,
          readback: {
            worktreeRoot: canonicalOutside,
            branch: "codex/workspace-contained",
            headSha: "a".repeat(40),
            clean: true,
            fingerprint: `sha256:${"d".repeat(64)}`,
          },
        }),
      /Only a workspace root inside its own durable container/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("the promotion primitive refuses paths, branches, and messages outside its bounds", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "scratch-promote-unit-"));
  const hooks = path.join(root, "hooks");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(hooks);
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "main.py"), "print(1)\n", "utf8");
  const git = new SpawnFixedArgvGitRunnerV1();
  const base = {
    git,
    canonicalRoot: workspace,
    branch: "codex/workspace-unit",
    commitMessage: "Initial commit",
    trackedPaths: ["main.py"],
    disabledHooksPath: hooks,
  };
  try {
    await assert.rejects(
      () => initializeScratchGitRepositoryV1({ ...base, trackedPaths: [] }),
      /at least one durable workspace file/u,
    );
    await assert.rejects(
      () =>
        initializeScratchGitRepositoryV1({
          ...base,
          trackedPaths: ["../escape.py"],
        }),
      /not canonical or targets \.git/u,
    );
    await assert.rejects(
      () =>
        initializeScratchGitRepositoryV1({
          ...base,
          trackedPaths: [".git/config"],
        }),
      /not canonical or targets \.git/u,
    );
    await assert.rejects(
      () =>
        initializeScratchGitRepositoryV1({ ...base, branch: "-dangerous" }),
      /not a safe Git branch name/u,
    );
    await assert.rejects(
      () => initializeScratchGitRepositoryV1({ ...base, branch: "main" }),
      /must differ/u,
    );
    await assert.rejects(
      () => initializeScratchGitRepositoryV1({ ...base, commitMessage: "  " }),
      /commit message is missing/u,
    );
    await assert.rejects(
      () =>
        initializeScratchGitRepositoryV1({
          ...base,
          trackedPaths: ["missing.py"],
        }),
      /not a bounded regular file/u,
    );
    // Nothing above may have created a repository.
    assert.equal(
      await fs.lstat(path.join(workspace, ".git")).then(() => true, () => false),
      false,
    );

    const initialized = await initializeScratchGitRepositoryV1(base);
    assert.equal(initialized.branch, "codex/workspace-unit");
    assert.equal(initialized.defaultBranch, "main");
    assert.match(initialized.baseSha, /^[0-9a-f]{40}$/u);
    assert.equal(initialized.repositoryRoot, initialized.worktreeRoot);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("git init stays inside the fixed-argv catalog and the branch predicate is shared", async () => {
  assert.equal(
    scratchRepositoryAgentBranchV1("my-space"),
    "codex/workspace-my-space",
  );
  const root = await fs.mkdtemp(path.join(tmpdir(), "scratch-promote-argv-"));
  try {
    const runner = new SpawnFixedArgvGitRunnerV1();
    // The promotion needs exactly one new subcommand; nothing else widened.
    await assert.rejects(
      runner.run({ cwd: root, args: ["clone", "https://example.invalid/x"] }),
      /outside the fixed repair catalog/u,
    );
    await assert.rejects(
      runner.run({ cwd: root, args: ["remote", "add", "origin", "x"] }),
      /outside the fixed repair catalog/u,
    );
    await assert.rejects(
      runner.run({ cwd: root, args: ["push", "origin", "main"] }),
      /outside the fixed repair catalog/u,
    );
    const result = await runner.run({
      cwd: root,
      args: ["init", "--quiet", "-b", "codex/workspace-argv"],
    });
    assert.equal(result.exitCode, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function createFixture(name: string) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), `scratch-promote-${name}-`)),
  );
  let sequence = 0;
  let milliseconds = Date.parse("2026-08-23T09:00:00.000Z");
  const manager = new WorkspaceManagerV2({
    applicationDataRoot: path.join(root, "app-data"),
    now: () => new Date((milliseconds += 1)),
    randomId: () => `promote-${++sequence}`,
  });
  const gitRunner = new SpawnFixedArgvGitRunnerV1();
  return {
    root,
    manager,
    tools: () =>
      new Map(
        createCodeWorkspaceToolContributionsV2({
          manager,
          isForegroundUserMission: () => true,
        }).map((item) => [item.tool.name, item.tool]),
      ),
    // missionId doubles as the default workspace id, exactly as production
    // resolves it when the model omits workspaceId.
    context: (
      originalPrompt: string,
      workspaceId: string,
    ): ScopedExtensionContextV1 => ({
      version: 1,
      extensionId: "agentic-researcher-code",
      missionId: workspaceId,
      operationId: `operation-${++sequence}`,
      originalPrompt,
      abortSignal: new AbortController().signal,
      now: () => new Date((milliseconds += 1)),
      reportProgress: () => undefined,
    }),
    proofAdapter: (manifest: WorkspaceManifestV2) =>
      new FixedArgvRepairProofAdapterV1({
        workspaceManager: manager,
        git: gitRunner,
        artifactHashReader: new FixedArgvArtifactHashReaderV1(gitRunner),
        getProfile: async (profileKey) =>
          detectSourceOnlyRepositoryProfileV2({
            key: profileKey,
            displayName: profileKey,
            repositoryRoot: manifest.canonicalRoot,
            defaultBranch: "main",
            files: Object.keys(manifest.hashes.files),
          }),
      }),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
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
      grantId: "grant-scratch-promotion",
    },
  };
}
