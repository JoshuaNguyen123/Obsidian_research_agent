import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  type WorkspaceRepositoryProvisionerV2,
} from "../extensions/code/workspaceTools";
import {
  WORKSPACE_DEFAULT_EXPIRY_MS_V2,
  WORKSPACE_MAX_EXPIRY_MS_V2,
  WorkspaceManagerV2,
  isPersonWorkspaceOwnerV2,
  parseWorkspaceManifestV2,
  serializeWorkspaceManifestV2,
  workspaceRunMayWorkV2,
} from "../extensions/code/workspaces";

/*
 * The workspace lifecycle for a person (CODE-8, CODE-14): a workspace is kept
 * past its seven days, and a run works in a person's workspace without taking
 * it over.
 */

const PERSON = "person:code-page";
const DAY = 24 * 60 * 60 * 1_000;

async function fixture(name: string, start = Date.parse("2026-10-16T10:00:00.000Z")) {
  const root = await mkdtemp(path.join(tmpdir(), `code-lifecycle-${name}-`));
  let now = start;
  let sequence = 0;
  const manager = new WorkspaceManagerV2({
    applicationDataRoot: path.join(root, "app-data"),
    now: () => new Date(now),
    randomId: () => `id-${++sequence}`,
  });
  return {
    manager,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function refused(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

test("a workspace is kept past its seven days, never shortened, at most 30 days ahead", async () => {
  const { manager, advance, now, cleanup } = await fixture("keep");
  try {
    const created = await manager.createScratchWorkspace({ workspaceId: "keep-me", ownerRunId: PERSON });
    assert.equal(Date.parse(created.expiresAt), now() + WORKSPACE_DEFAULT_EXPIRY_MS_V2);
    advance(6 * DAY);
    const kept = await manager.renewWorkspaceExpiry("keep-me");
    assert.equal(kept.expiresAt, new Date(now() + 7 * DAY).toISOString());
    assert.equal((await manager.loadManifest("keep-me")).expiresAt, kept.expiresAt);
    // A time before the current expiry changes nothing.
    const same = await manager.renewWorkspaceExpiry("keep-me", { expiresAt: new Date(now() + DAY).toISOString() });
    assert.equal(same.expiresAt, kept.expiresAt);
    const far = await manager.renewWorkspaceExpiry("keep-me", {
      expiresAt: new Date(now() + WORKSPACE_MAX_EXPIRY_MS_V2).toISOString(),
    });
    assert.equal(far.expiresAt, new Date(now() + 30 * DAY).toISOString());
    await refused(manager.renewWorkspaceExpiry("keep-me", { expiresAt: new Date(now() + 30 * DAY + 1_000).toISOString() }), "invalid_expiry");
    await refused(manager.renewWorkspaceExpiry("keep-me", { expiresAt: new Date(now() - 1_000).toISOString() }), "invalid_expiry");
    await refused(manager.renewWorkspaceExpiry("keep-me", { expiresAt: "soon" }), "invalid_expiry");
    // A run's workspace is kept the same way, and its owner stays.
    await manager.createScratchWorkspace({ workspaceId: "a-pass", ownerRunId: "run-pass-1" });
    assert.equal((await manager.renewWorkspaceExpiry("a-pass")).ownerRunId, "run-pass-1");
    // An expired workspace is not brought back.
    advance(31 * DAY);
    await refused(manager.renewWorkspaceExpiry("keep-me"), "workspace_expired");
    await refused(manager.renewWorkspaceExpiry("missing"), "workspace_not_found");
  } finally {
    await cleanup();
  }
});

test("a run attaches to a person's workspace and never takes it over", async () => {
  const { manager, cleanup } = await fixture("attach");
  try {
    await manager.createScratchWorkspace({ workspaceId: "mine", ownerRunId: PERSON });
    const runs = await manager.createScratchWorkspace({ workspaceId: "runs", ownerRunId: "run-a" });
    assert.equal(isPersonWorkspaceOwnerV2(PERSON), true);
    assert.equal(isPersonWorkspaceOwnerV2("person:"), false);
    assert.equal(isPersonWorkspaceOwnerV2("run-a"), false);

    await refused(manager.attachRunToPersonWorkspace("runs", "run-b"), "workspace_not_person_owned");
    await refused(manager.attachRunToPersonWorkspace("mine", "person:someone"), "invalid_owner");
    const attached = await manager.attachRunToPersonWorkspace("mine", "run-b");
    assert.equal(attached.ownerRunId, PERSON);
    assert.equal(attached.attachedRunId, "run-b");
    assert.equal(workspaceRunMayWorkV2(attached, "run-b"), true);
    assert.equal(workspaceRunMayWorkV2(attached, PERSON), true);
    assert.equal(workspaceRunMayWorkV2(attached, "run-c"), false);
    // The attachment is durable and round-trips through the manifest.
    const reloaded = await manager.loadManifest("mine");
    assert.equal(reloaded.attachedRunId, "run-b");
    assert.deepEqual(parseWorkspaceManifestV2(JSON.parse(serializeWorkspaceManifestV2(reloaded))), reloaded);
    // Attaching the same run again changes nothing.
    assert.equal((await manager.attachRunToPersonWorkspace("mine", "run-b")).updatedAt, attached.updatedAt);

    // The attached run resumes the workspace; another run does not.
    assert.equal((await manager.resumeWorkspace("mine", "run-b")).ownerRunId, PERSON);
    await refused(manager.resumeWorkspace("mine", "run-c"), "workspace_owner_mismatch");
    // A continuation never re-owns a person's workspace.
    await refused(manager.rebindWorkspaceOwnerForContinuation("mine", "run-c"), "workspace_owned_by_person");
    assert.equal((await manager.loadManifest("mine")).ownerRunId, PERSON);

    // While the attached run holds a lease, no other run attaches.
    const leased = await manager.acquireLease("mine", "extension:run-b");
    await refused(manager.attachRunToPersonWorkspace("mine", "run-c"), "workspace_in_use");
    // Detaching another run changes nothing; detaching this one drops its lease.
    assert.equal((await manager.detachRunFromPersonWorkspace("mine", "run-c")).attachedRunId, "run-b");
    const detached = await manager.detachRunFromPersonWorkspace("mine", "run-b");
    assert.equal(detached.attachedRunId, undefined);
    assert.equal(detached.lease, null);
    assert.equal(detached.status, "active");
    assert.equal(detached.ownerRunId, PERSON);
    assert.equal("attachedRunId" in JSON.parse(serializeWorkspaceManifestV2(detached)), false);
    assert.ok(leased.lease);
    // A later run attaches once the workspace is free.
    assert.equal((await manager.attachRunToPersonWorkspace("mine", "run-c")).attachedRunId, "run-c");

    // Only a person's workspace can carry an attached run, and only a run.
    assert.throws(() => parseWorkspaceManifestV2({ ...runs, attachedRunId: "run-x" }), /Only a person's workspace/u);
    assert.throws(
      () => parseWorkspaceManifestV2({ ...detached, attachedRunId: "person:other" }),
      /Only a person's workspace/u,
    );
    assert.throws(() => parseWorkspaceManifestV2({ ...detached, attachedRunId: PERSON }), /Only a person's workspace/u);
  } finally {
    await cleanup();
  }
});

test("code_workspace_create on a person's scratch workspace attaches the run, whose prepared writes then go through", async () => {
  const { manager, cleanup } = await fixture("tools");
  try {
    await manager.createScratchWorkspace({ workspaceId: "person-space", ownerRunId: PERSON });
    const tools = toolMap(createCodeWorkspaceToolContributionsV2({
      manager,
      repositoryProvisioner: {} as WorkspaceRepositoryProvisionerV2,
      isForegroundUserMission: () => true,
    }));
    const runContext = context("run-code-page-1");
    const create = await requirePrepared(
      tools.get("code_workspace_create")!,
      { workspaceId: "person-space", kind: "scratch" },
      runContext,
    );
    assert.equal(create.normalizedArgs.workspaceOwner, PERSON);
    assert.equal(create.normalizedArgs.ownerRunId, "run-code-page-1");
    assert.match(create.preview.summary, /stays the person's/u);
    await tools.get("code_workspace_create")!.executePrepared!(create, authorize(runContext, create));
    let manifest = await manager.loadManifest("person-space");
    assert.equal(manifest.ownerRunId, PERSON);
    assert.equal(manifest.attachedRunId, "run-code-page-1");

    const write = await requirePrepared(
      tools.get("code_workspace_create_file")!,
      { workspaceId: "person-space", path: "main.py", content: "print('hello')\n" },
      runContext,
    );
    await tools.get("code_workspace_create_file")!.executePrepared!(write, authorize(runContext, write));
    assert.equal((await manager.read("person-space", "main.py")).content, "print('hello')\n");
    manifest = await manager.loadManifest("person-space");
    assert.equal(manifest.ownerRunId, PERSON, "the write did not take the workspace over");

    // A run that never attached cannot write there.
    const other = await tools.get("code_workspace_create_file")!.prepare!(
      { workspaceId: "person-space", path: "other.py", content: "x = 1\n" },
      context("run-other"),
    );
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.error.code, "workspace_owner_mismatch");

    // A run's own workspace still continues by rebinding, as before.
    await manager.createScratchWorkspace({ workspaceId: "pass-space", ownerRunId: "run-pass-1" });
    const continued = await requirePrepared(
      tools.get("code_workspace_create")!,
      { workspaceId: "pass-space", kind: "scratch" },
      context("run-pass-2"),
    );
    assert.equal(continued.normalizedArgs.workspaceOwner, undefined);
    assert.equal((await manager.loadManifest("pass-space")).ownerRunId, "run-pass-2");
  } finally {
    await cleanup();
  }
});

function context(missionId: string): ScopedExtensionContextV1 {
  let tick = Date.parse("2026-10-16T10:00:00.000Z");
  return {
    version: 1,
    extensionId: "agentic-researcher-code",
    missionId,
    operationId: `operation-${missionId}`,
    originalPrompt: "Work in my scratch workspace person-space.",
    abortSignal: new AbortController().signal,
    now: () => new Date(tick += 1),
    reportProgress: () => undefined,
  };
}

function toolMap(contributions: ExtensionToolContributionV1[]) {
  return new Map(contributions.map((item) => [item.tool.name, item.tool]));
}

async function requirePrepared(
  tool: ExtensionToolContributionV1["tool"],
  args: Record<string, unknown>,
  scoped: ScopedExtensionContextV1,
): Promise<PreparedActionV1> {
  const result = await tool.prepare!(args, scoped);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.action;
}

function authorize(scoped: ScopedExtensionContextV1, action: PreparedActionV1): ScopedExtensionContextV1 {
  return {
    ...scoped,
    authorizedAction: {
      preparedActionId: action.id,
      payloadFingerprint: action.payloadFingerprint,
      grantId: "grant-lifecycle",
    },
  };
}
