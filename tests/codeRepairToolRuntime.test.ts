import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  PreparedActionV1,
  ScopedExtensionContextV1,
} from "@agentic-researcher/core-api";
import { sha256Fingerprint } from "../packages/headless-runtime/src/canonicalize";
import {
  createCodeRepairToolRuntimeV1,
  type ArtifactHashReadbackV1,
  type CallbackCheckpointPersistenceV1,
  type CodeCommitReadbackV1,
  type CodeCommitResultV1,
  type CodeDiffFileV1,
  type CodeDiffReceiptV1,
  type CodeRepairCheckpointNamespaceV1,
  type CodeValidationReceiptV1,
  type NormalizedCodeRepairRequestV1,
  type VerifiedCommitGatewayV1,
} from "../extensions/code/repair";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories";
import { WorkspaceManagerV2 } from "../extensions/code/workspaces";

const BASE_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const BEFORE_HASH = `sha256:${"1".repeat(64)}`;
const AFTER_HASH = `sha256:${"2".repeat(64)}`;
const FAILURE_HASH = `sha256:${"3".repeat(64)}`;
const NOW = new Date("2026-07-12T18:00:00.000Z");
const SCOPE = { runId: "mission-1", workspaceId: "workspace-1", requestId: "request-1" };

test("normal exact repair proof commits only after fresh proof readback", async (t) => {
  const harness = await createHarness(t, "src/index.ts");
  const passingFast = await validation("fast", "fast-sandbox", true, "fast-pass", 0, true, null, harness.validationBinding);
  harness.validations.set(passingFast.id, passingFast);
  const cycleAction = await prepareCycle(harness, passingFast, 1, 0);
  assert.equal(
    (await harness.handlers.reconcileCycleRecord(cycleAction, authorizedContext(cycleAction))).outcome,
    "not_applied",
  );
  const cycle = await harness.handlers.executePreparedCycleRecord(
    cycleAction,
    authorizedContext(cycleAction),
  );
  assert.equal(cycle.domainReceipt.outcome, "passed");
  assert.equal(cycle.actionReceipt.readback.status, "verified");
  const reconciledCycle = await harness.handlers.reconcileCycleRecord(
    cycleAction,
    authorizedContext(cycleAction),
  );
  assert.equal(reconciledCycle.outcome, "committed", reconciledCycle.message);

  const targeted = await validation("targeted", "targeted-sandbox", true, "targeted-pass", 0, true, null, harness.validationBinding);
  const full = await validation("full", "full-sandbox", true, "full-pass", 60_000, true, null, harness.validationBinding);
  harness.validations.set(targeted.id, targeted);
  harness.validations.set(full.id, full);
  const omittedDiffArgs = commitArgs(1, harness.diffFingerprint, targeted.id, full.id);
  delete (omittedDiffArgs as { diffFingerprint?: string }).diffFingerprint;
  const prepared = await harness.handlers.prepareVerifiedCommit(
    omittedDiffArgs,
    context(),
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.action.requiredConfirmations, 1);
  assert.equal(
    (await harness.handlers.reconcileVerifiedCommit(
      prepared.action,
      authorizedContext(prepared.action),
    )).outcome,
    "not_applied",
  );
  const result = await harness.handlers.executePreparedVerifiedCommit(
    prepared.action,
    authorizedContext(prepared.action),
  );
  assert.equal(result.domainReceipt.kind, "verified_local_commit");
  assert.equal(result.domainReceipt.commitSha, COMMIT_SHA);
  assert.equal(result.domainReceipt.parentSha, BASE_SHA);
  assert.equal(result.actionReceipt.operation, "commit");
  assert.equal(harness.gateway.commitCalls, 1);
  assert.equal(harness.gateway.readbackCalls, 1);
  const status = await harness.handlers.readStatus(SCOPE, context());
  assert.equal(status.terminalStatus, "complete");
  assert.equal(status.publicationEligible, true);
  assert.equal(
    (await harness.handlers.reconcileVerifiedCommit(
      prepared.action,
      authorizedContext(prepared.action),
    )).outcome,
    "committed",
  );
});

test("read-only reconciliation completes a crash-after-commit without duplicate commit", async (t) => {
  const harness = await createHarness(t, "src/index.ts");
  await recordPassingFast(harness);
  const targeted = await validation(
    "targeted", "targeted-sandbox", true, "targeted-reconcile",
    0, true, null, harness.validationBinding,
  );
  const full = await validation(
    "full", "full-sandbox", true, "full-reconcile",
    60_000, true, null, harness.validationBinding,
  );
  harness.validations.set(targeted.id, targeted);
  harness.validations.set(full.id, full);
  const prepared = await harness.handlers.prepareVerifiedCommit(
    commitArgs(1, harness.diffFingerprint, targeted.id, full.id),
    context(),
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  harness.gateway.throwAfterCommit = true;
  await assert.rejects(
    harness.handlers.executePreparedVerifiedCommit(
      prepared.action,
      authorizedContext(prepared.action),
    ),
    /simulated crash after commit/i,
  );
  assert.equal(harness.gateway.commitCalls, 1);
  const reconciled = await harness.handlers.reconcileVerifiedCommit(
    prepared.action,
    authorizedContext(prepared.action),
  );
  assert.equal(reconciled.outcome, "committed", reconciled.message);
  assert.equal(harness.gateway.commitCalls, 1, "reconciliation must never create a second commit");
  const status = await harness.handlers.readStatus(SCOPE, context());
  assert.equal(status.terminalStatus, "complete");
});

test("optional caller diff fingerprint rejects a stale supplied value", async (t) => {
  const harness = await createHarness(t, "src/index.ts");
  await recordPassingFast(harness);
  const targeted = await validation("targeted", "targeted-sandbox", true, "targeted-stale-input", 0, true, null, harness.validationBinding);
  const full = await validation("full", "full-sandbox", true, "full-stale-input", 60_000, true, null, harness.validationBinding);
  harness.validations.set(targeted.id, targeted);
  harness.validations.set(full.id, full);
  const prepared = await harness.handlers.prepareVerifiedCommit(
    commitArgs(1, `sha256:${"8".repeat(64)}`, targeted.id, full.id),
    context(),
  );
  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.equal(prepared.error.code, "diff_fingerprint_stale");
  assert.equal(harness.gateway.commitCalls, 0);
});

test("workflow changes place requiredConfirmations=2 inside the fingerprinted action", async (t) => {
  const harness = await createHarness(t, ".github/workflows/ci.yml", true);
  const fast = await validation("fast", "fast-sandbox", true, "fast-workflow", 0, true, null, harness.validationBinding);
  harness.validations.set(fast.id, fast);
  const cycleAction = await prepareCycle(harness, fast, 1, 0);
  await harness.handlers.executePreparedCycleRecord(cycleAction, authorizedContext(cycleAction));
  const targeted = await validation("targeted", "targeted-sandbox", true, "targeted-workflow", 0, true, null, harness.validationBinding);
  const full = await validation("full", "full-sandbox", true, "full-workflow", 60_000, true, null, harness.validationBinding);
  harness.validations.set(targeted.id, targeted);
  harness.validations.set(full.id, full);

  const prepared = await harness.handlers.prepareVerifiedCommit(
    commitArgs(1, harness.diffFingerprint, targeted.id, full.id),
    context(),
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.action.requiredConfirmations, 2);
  assert.match(prepared.action.preview.warnings.join(" "), /double-exact/i);
  const originalFingerprint = prepared.action.payloadFingerprint;
  const weakened: PreparedActionV1 = { ...prepared.action, requiredConfirmations: 1 };
  await assert.rejects(
    harness.handlers.executePreparedVerifiedCommit(
      weakened,
      authorizedContext(weakened, originalFingerprint),
    ),
    /fingerprint changed|confirmation/i,
  );
  assert.equal(harness.gateway.commitCalls, 0);
});

test("stale diff after approval durably blocks before the commit gateway", async (t) => {
  const harness = await createHarness(t, "src/index.ts");
  const fast = await validation("fast", "fast-sandbox", true, "fast-stale", 0, true, null, harness.validationBinding);
  harness.validations.set(fast.id, fast);
  const cycleAction = await prepareCycle(harness, fast, 1, 0);
  await harness.handlers.executePreparedCycleRecord(cycleAction, authorizedContext(cycleAction));
  const targeted = await validation("targeted", "targeted-sandbox", true, "targeted-stale", 0, true, null, harness.validationBinding);
  const full = await validation("full", "full-sandbox", true, "full-stale", 60_000, true, null, harness.validationBinding);
  harness.validations.set(targeted.id, targeted);
  harness.validations.set(full.id, full);
  const prepared = await harness.handlers.prepareVerifiedCommit(
    commitArgs(1, harness.diffFingerprint, targeted.id, full.id),
    context(),
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  harness.patch = `${harness.patch}# drift\n`;
  await assert.rejects(
    harness.handlers.executePreparedVerifiedCommit(
      prepared.action,
      authorizedContext(prepared.action),
    ),
    /proof is stale/i,
  );
  assert.equal(harness.gateway.commitCalls, 0);
  const status = await harness.handlers.readStatus(SCOPE, context());
  assert.equal(status.stage, "blocked");
  assert.equal(status.blockerCode, "diff_readback_invalid");
  assert.equal(status.terminalStatus, null, "pre-commit proof blockers remain resumable");
});

test("workspace byte drift invalidates previously green validation proof", async (t) => {
  const harness = await createHarness(t, "src/index.ts");
  await recordPassingFast(harness);
  const targeted = await validation(
    "targeted", "targeted-sandbox", true, "targeted-byte-drift",
    0, true, null, harness.validationBinding,
  );
  const full = await validation(
    "full", "full-sandbox", true, "full-byte-drift",
    60_000, true, null, harness.validationBinding,
  );
  harness.validations.set(targeted.id, targeted);
  harness.validations.set(full.id, full);

  const lease = await harness.manager.acquireLease(SCOPE.workspaceId, SCOPE.runId);
  const current = await harness.manager.read(SCOPE.workspaceId, "src/index.ts");
  await harness.manager.appendFile(
    SCOPE.workspaceId,
    lease.lease!.id,
    "src/index.ts",
    "// post-validation drift\n",
    current.sha256,
  );
  await harness.manager.releaseLease(SCOPE.workspaceId, lease.lease!.id);

  const prepared = await harness.handlers.prepareVerifiedCommit(
    commitArgs(1, harness.diffFingerprint, targeted.id, full.id),
    context(),
  );
  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.equal(prepared.error.code, "validation_workspace_drift");
  assert.equal(harness.gateway.commitCalls, 0);
});

test("red or non-fresh full validation fails closed", async (t) => {
  await t.test("red full", async (t) => {
    const harness = await createHarness(t, "src/index.ts");
    await recordPassingFast(harness);
    const targeted = await validation("targeted", "targeted-sandbox", true, "targeted-red", 0, true, null, harness.validationBinding);
    const full = await validation("full", "full-sandbox", true, "full-red", 60_000, false, FAILURE_HASH, harness.validationBinding);
    harness.validations.set(targeted.id, targeted);
    harness.validations.set(full.id, full);
    const prepared = await harness.handlers.prepareVerifiedCommit(
      commitArgs(1, harness.diffFingerprint, targeted.id, full.id),
      context(),
    );
    assert.deepEqual(prepared, {
      ok: false,
      error: { code: "full_validation_failed", message: "Full sandbox validation is not green." },
    });
    assert.equal(harness.gateway.commitCalls, 0);
  });

  await t.test("full sandbox reused", async (t) => {
    const harness = await createHarness(t, "src/index.ts");
    await recordPassingFast(harness);
    const targeted = await validation("targeted", "shared-sandbox", true, "targeted-reuse", 0, true, null, harness.validationBinding);
    const full = await validation("full", "shared-sandbox", false, "full-reuse", 60_000, true, null, harness.validationBinding);
    harness.validations.set(targeted.id, targeted);
    harness.validations.set(full.id, full);
    const prepared = await harness.handlers.prepareVerifiedCommit(
      commitArgs(1, harness.diffFingerprint, targeted.id, full.id),
      context(),
    );
    assert.equal(prepared.ok, false);
    if (!prepared.ok) assert.equal(prepared.error.code, "full_validation_not_fresh");
    assert.equal(harness.gateway.commitCalls, 0);
  });
});

test("unchanged fast failure stops at cycle two and persists the blocker", async (t) => {
  const harness = await createHarness(t, "src/index.ts");
  const first = await validation("fast", "fast-one", true, "fast-failed-one", 0, false, FAILURE_HASH, harness.validationBinding);
  harness.validations.set(first.id, first);
  const firstAction = await prepareCycle(harness, first, 1, 0);
  const firstResult = await harness.handlers.executePreparedCycleRecord(
    firstAction,
    authorizedContext(firstAction),
  );
  assert.equal(firstResult.domainReceipt.outcome, "repaired");

  const second = await validation("fast", "fast-two", true, "fast-failed-two", 60_000, false, FAILURE_HASH, harness.validationBinding);
  harness.validations.set(second.id, second);
  const prepared = await harness.handlers.prepareCycleRecord(
    cycleArgs(second, 2, 1),
    context(),
  );
  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.equal(prepared.error.code, "unchanged_failure");
  const status = await harness.handlers.readStatus(SCOPE, context());
  assert.equal(status.terminalStatus, "blocked");
  assert.equal(status.blockerCode, "unchanged_failure");
  assert.deepEqual(status.attempts.map((attempt) => attempt.outcome), ["repaired", "blocked"]);
  assert.equal(harness.gateway.commitCalls, 0);
});

test("production commit scope recovers one durable request id from the trusted mission workspace", async (t) => {
  const harness = await createHarness(t, "src/index.ts", false, true);
  await recordPassingFast(harness);
  const targeted = await validation(
    "targeted", "targeted-sandbox", true, "targeted-host-scope",
    0, true, null, harness.validationBinding,
  );
  const full = await validation(
    "full", "full-sandbox", true, "full-host-scope",
    60_000, true, null, harness.validationBinding,
  );
  harness.validations.set(targeted.id, targeted);
  harness.validations.set(full.id, full);
  const modelArgs = commitArgs(
    1,
    harness.diffFingerprint,
    targeted.id,
    full.id,
  );
  modelArgs.requestId = "model-transcribed-request-alias";

  const prepared = await harness.handlers.prepareVerifiedCommit(
    modelArgs,
    context(),
  );

  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const scope = prepared.action.normalizedArgs.scope as Record<string, unknown>;
  assert.equal(scope.runId, SCOPE.runId);
  assert.equal(scope.workspaceId, SCOPE.workspaceId);
  assert.equal(scope.requestId, SCOPE.requestId);
});

test("production commit scope fails closed when a mission workspace has multiple repair checkpoints", async (t) => {
  const harness = await createHarness(t, "src/index.ts", false, true);
  await recordPassingFast(harness);
  const secondScope = { ...SCOPE, requestId: "request-2" };
  const secondBinding = {
    ...harness.validationBinding,
    requestId: secondScope.requestId,
  };
  const secondFast = await validation(
    "fast", "fast-sandbox-2", true, "fast-pass-2",
    2_000, true, null, secondBinding,
  );
  harness.validations.set(secondFast.id, secondFast);
  const secondPrepared = await harness.handlers.prepareCycleRecord(
    {
      ...cycleArgs(secondFast, 1, 0),
      ...secondScope,
    },
    context(),
  );
  assert.equal(secondPrepared.ok, true);
  if (!secondPrepared.ok) return;
  await harness.handlers.executePreparedCycleRecord(
    secondPrepared.action,
    authorizedContext(secondPrepared.action),
  );

  const prepared = await harness.handlers.prepareVerifiedCommit(
    {
      ...commitArgs(1, harness.diffFingerprint, "targeted", "full"),
      requestId: "unknown-request",
    },
    context(),
  );

  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.equal(prepared.error.code, "repair_checkpoint_ambiguous");
  assert.equal(harness.gateway.commitCalls, 0);
});

test("production repair preparation derives checkpoint sequence and latest scoped validation proof", async (t) => {
  const harness = await createHarness(t, "src/index.ts");
  const fast = await validation(
    "fast", "fast-host", true, "fast-host-proof", 0, true, null,
    harness.validationBinding,
  );
  harness.validations.set(fast.id, fast);
  const cyclePrepared = await harness.handlers.prepareCycleRecord(SCOPE, context());
  assert.equal(cyclePrepared.ok, true);
  if (!cyclePrepared.ok) return;
  assert.deepEqual(
    cyclePrepared.action.normalizedArgs,
    {
      kind: "code_repair_cycle_v1",
      scope: SCOPE,
      checkpointSequence: 0,
      cycle: 1,
      validationReceiptId: fast.id,
      validationFingerprint: fast.fingerprint,
      cycleFingerprint: fast.fingerprint,
      outcome: "passed",
    },
  );
  await harness.handlers.executePreparedCycleRecord(
    cyclePrepared.action,
    authorizedContext(cyclePrepared.action),
  );

  const targeted = await validation(
    "targeted", "targeted-host", true, "targeted-host-proof", 60_000, true, null,
    harness.validationBinding,
  );
  const full = await validation(
    "full", "full-host", true, "full-host-proof", 120_000, true, null,
    harness.validationBinding,
  );
  harness.validations.set(targeted.id, targeted);
  harness.validations.set(full.id, full);
  const commitPrepared = await harness.handlers.prepareVerifiedCommit(SCOPE, context());
  assert.equal(commitPrepared.ok, true);
  if (!commitPrepared.ok) return;
  assert.equal(
    (commitPrepared.action.normalizedArgs as Record<string, unknown>).checkpointSequence,
    1,
  );
  assert.equal(
    (commitPrepared.action.normalizedArgs as Record<string, unknown>).targetedValidationReceiptId,
    targeted.id,
  );
  assert.equal(
    (commitPrepared.action.normalizedArgs as Record<string, unknown>).fullValidationReceiptId,
    full.id,
  );
});

test("denial means execute is not called, and missing authorization cannot reach Git", async (t) => {
  const harness = await createHarness(t, "src/index.ts");
  await recordPassingFast(harness);
  const targeted = await validation("targeted", "targeted-sandbox", true, "targeted-deny", 0, true, null, harness.validationBinding);
  const full = await validation("full", "full-sandbox", true, "full-deny", 60_000, true, null, harness.validationBinding);
  harness.validations.set(targeted.id, targeted);
  harness.validations.set(full.id, full);
  const prepared = await harness.handlers.prepareVerifiedCommit(
    commitArgs(1, harness.diffFingerprint, targeted.id, full.id),
    context(),
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  // The host denies by not invoking executePrepared. The prepared action alone
  // has no side effect. A direct unauthorized invocation also fails closed.
  assert.equal(harness.gateway.commitCalls, 0);
  await assert.rejects(
    harness.handlers.executePreparedVerifiedCommit(prepared.action, context()),
    /lacks exact host authorization/i,
  );
  assert.equal(harness.gateway.commitCalls, 0);
  const status = await harness.handlers.readStatus(SCOPE, context());
  assert.equal(status.sequence, 1);
  assert.equal(status.terminalStatus, null);
});

async function createHarness(
  t: test.TestContext,
  changedPath: string,
  includeWorkflow = false,
  hostResolvesDurableScope = false,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-repair-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appData = path.join(root, "app-data");
  const repositoryRoot = path.join(root, "repository");
  const worktreeRoot = path.join(root, "worktree");
  await fs.mkdir(repositoryRoot, { recursive: true });
  await fs.mkdir(worktreeRoot, { recursive: true });
  await fs.writeFile(path.join(worktreeRoot, ".git"), "gitdir: ../repository/.git/worktrees/test\n");
  await fs.mkdir(path.dirname(path.join(worktreeRoot, changedPath)), { recursive: true });
  await fs.writeFile(path.join(worktreeRoot, changedPath), "fixed\n");
  const repositoryReal = await fs.realpath(repositoryRoot);
  const worktreeReal = await fs.realpath(worktreeRoot);
  const manager = new WorkspaceManagerV2({ applicationDataRoot: appData, now: () => NOW });
  await manager.registerTrustedRepositoryWorkspace({
    workspaceId: SCOPE.workspaceId,
    ownerRunId: SCOPE.runId,
    profileKey: "profile-1",
    repositoryRoot: repositoryReal,
    worktreeRoot: worktreeReal,
    branch: "codex/fixture-repair",
    baseSha: BASE_SHA,
    bindingFingerprint: `sha256:${"4".repeat(64)}`,
    trusted: true,
  });
  const changeLease = await manager.acquireLease(SCOPE.workspaceId, SCOPE.runId);
  const currentChangedFile = await manager.read(SCOPE.workspaceId, changedPath);
  await manager.writeExpected(
    SCOPE.workspaceId,
    changeLease.lease!.id,
    changedPath,
    currentChangedFile.content,
    currentChangedFile.sha256,
  );
  await manager.releaseLease(SCOPE.workspaceId, changeLease.lease!.id);
  const validationManifest = await manager.loadManifest(SCOPE.workspaceId);
  const validationBinding: NonNullable<CodeValidationReceiptV1["binding"]> = {
    requestId: SCOPE.requestId,
    workspaceId: SCOPE.workspaceId,
    profileKey: "profile-1",
    inputWorkspaceManifestFingerprint: validationManifest.hashes.indexFingerprint,
    validatedWorkspaceManifestFingerprint: validationManifest.hashes.indexFingerprint,
    workspaceChangedPaths: [...validationManifest.budget.changedPaths],
    stagingManifestFingerprint: `sha256:${"6".repeat(64)}`,
    stagedFiles: [{ path: changedPath, sha256: AFTER_HASH, bytes: 6 }],
    importedArtifacts: [],
  };
  const files = ["package.json", changedPath];
  if (includeWorkflow && !files.includes(".github/workflows/ci.yml")) {
    files.push(".github/workflows/ci.yml");
  }
  const profile = detectRepositoryProfileV2({
    key: "profile-1",
    displayName: "Fixture",
    repositoryRoot: repositoryReal,
    defaultBranch: "main",
    files,
    fileContents: { "package.json": JSON.stringify({ scripts: { test: "node --test" } }) },
    runtimeDigests: { node: `sha256:${"5".repeat(64)}` },
    allowedPaths: files,
  });
  let namespace: CodeRepairCheckpointNamespaceV1 | null = null;
  const persistence: CallbackCheckpointPersistenceV1 = {
    async readNamespace() {
      return namespace ? structuredClone(namespace) : null;
    },
    async writeNamespace(next, expectedRevision) {
      if ((namespace?.revision ?? 0) !== expectedRevision) return false;
      namespace = structuredClone(next);
      return true;
    },
  };
  const validations = new Map<string, CodeValidationReceiptV1>();
  const gateway = new FakeCommitGateway();
  const patch = patchFor(changedPath);
  const filesReadback: CodeDiffFileV1[] = [{
    path: changedPath,
    status: "modified",
    previousPath: null,
    beforeSha256: BEFORE_HASH,
    afterSha256: AFTER_HASH,
  }];
  const diffFingerprint = await sha256Fingerprint({ baseSha: BASE_SHA, patch, files: filesReadback });
  const state = {
    patch,
    diffFingerprint,
    validations,
    validationBinding,
    gateway,
    manager,
    handlers: null as unknown as ReturnType<typeof createCodeRepairToolRuntimeV1>,
  };
  state.handlers = createCodeRepairToolRuntimeV1({
    workspaceManager: manager,
    repositoryProfiles: {
      async resolve() {
        return {
          profile,
          worktreeBranch: "codex/fixture-repair",
          commitMessage: "Repair fixture",
        };
      },
    },
    validations: {
      async readValidation({ receiptId }) {
        return validations.get(receiptId) ?? null;
      },
      async readLatestValidation({ kind }) {
        return [...validations.values()]
          .filter((receipt) => receipt.kind === kind)
          .sort((left, right) =>
            Date.parse(right.completedAt) - Date.parse(left.completedAt) ||
            right.id.localeCompare(left.id),
          )[0] ?? null;
      },
    },
    checkpointPersistence: persistence,
    proofReader: {
      async readDiff({ operationId }): Promise<CodeDiffReceiptV1> {
        return {
          version: 1,
          kindName: "code_diff_readback",
          id: `${operationId}:source`,
          operationId,
          baseSha: BASE_SHA,
          patch: state.patch,
          files: structuredClone(filesReadback),
          changedPaths: [changedPath],
          readAt: NOW.toISOString(),
          fingerprint: "ignored-and-host-recomputed",
        };
      },
      async readArtifactHashes(): Promise<ArtifactHashReadbackV1[]> {
        return [{ path: changedPath, sha256: AFTER_HASH, bytes: 6 }];
      },
    },
    commitGateway: gateway,
    hostResolvesDurableScope,
    now: () => NOW,
  });
  return state;
}

class FakeCommitGateway implements VerifiedCommitGatewayV1 {
  commitCalls = 0;
  readbackCalls = 0;
  throwAfterCommit = false;
  private last: {
    request: NormalizedCodeRepairRequestV1;
    diff: CodeDiffReceiptV1;
    artifactHashes: ArtifactHashReadbackV1[];
  } | null = null;

  async commit(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    diff: CodeDiffReceiptV1;
    artifactHashes: ArtifactHashReadbackV1[];
    targetedValidation: CodeValidationReceiptV1;
    fullValidation: CodeValidationReceiptV1;
  }): Promise<CodeCommitResultV1> {
    this.commitCalls += 1;
    this.last = {
      request: structuredClone(input.request),
      diff: structuredClone(input.diff),
      artifactHashes: structuredClone(input.artifactHashes),
    };
    if (this.throwAfterCommit) throw new Error("simulated crash after commit");
    return { operationId: input.operationId, commitSha: COMMIT_SHA, committedAt: NOW.toISOString() };
  }

  async readCommit(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    commitSha: string;
  }): Promise<CodeCommitReadbackV1> {
    this.readbackCalls += 1;
    assert.ok(this.last);
    return {
      operationId: input.operationId,
      commitSha: input.commitSha,
      parentSha: this.last.request.worktree.baseSha,
      treeSha: TREE_SHA,
      diffFingerprint: this.last.diff.fingerprint,
      changedPaths: [...this.last.diff.changedPaths],
      artifactHashes: structuredClone(this.last.artifactHashes),
      readAt: NOW.toISOString(),
    };
  }

  async reconcilePreparedCommit(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    diff: CodeDiffReceiptV1;
    artifactHashes: ArtifactHashReadbackV1[];
    targetedValidation: CodeValidationReceiptV1;
    fullValidation: CodeValidationReceiptV1;
  }) {
    if (!this.last) return { outcome: "not_applied" as const };
    const commit = {
      operationId: input.operationId,
      commitSha: COMMIT_SHA,
      committedAt: NOW.toISOString(),
    };
    const readback = await this.readCommit({
      operationId: `${input.operationId}:readback`,
      request: input.request,
      commitSha: COMMIT_SHA,
    });
    return { outcome: "committed" as const, commit, readback };
  }
}

async function recordPassingFast(
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<void> {
  const fast = await validation("fast", "fast-sandbox", true, `fast-${Math.random()}`, 0, true, null, harness.validationBinding);
  harness.validations.set(fast.id, fast);
  const action = await prepareCycle(harness, fast, 1, 0);
  await harness.handlers.executePreparedCycleRecord(action, authorizedContext(action));
}

async function prepareCycle(
  harness: Awaited<ReturnType<typeof createHarness>>,
  receipt: CodeValidationReceiptV1,
  cycle: number,
  sequence: number,
): Promise<PreparedActionV1> {
  const prepared = await harness.handlers.prepareCycleRecord(
    cycleArgs(receipt, cycle, sequence),
    context(),
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("Expected a prepared repair-cycle action.");
  return prepared.action;
}

function cycleArgs(receipt: CodeValidationReceiptV1, cycle: number, sequence: number) {
  return {
    ...SCOPE,
    cycle,
    checkpointSequence: sequence,
    validationReceiptId: receipt.id,
    cycleFingerprint: receipt.failureFingerprint ?? receipt.fingerprint,
  };
}

function commitArgs(
  sequence: number,
  diffFingerprint: string,
  targetedValidationReceiptId: string,
  fullValidationReceiptId: string,
) {
  return {
    ...SCOPE,
    checkpointSequence: sequence,
    diffFingerprint,
    targetedValidationReceiptId,
    fullValidationReceiptId,
  };
}

async function validation(
  kind: "fast" | "targeted" | "full",
  sandboxId: string,
  freshSandbox: boolean,
  id: string,
  offsetMs = 0,
  passed = true,
  failureFingerprint: string | null = passed ? null : FAILURE_HASH,
  binding: CodeValidationReceiptV1["binding"] = null,
): Promise<CodeValidationReceiptV1> {
  const startedAt = new Date(NOW.getTime() + offsetMs).toISOString();
  const completedAt = new Date(NOW.getTime() + offsetMs + 1_000).toISOString();
  const checks = [{
    label: `${kind} validation`,
    exitCode: passed ? 0 : 1,
    stdout: passed ? "ok" : "",
    stderr: passed ? "" : "failure",
    durationMs: 1_000,
  }];
  const evidence = {
    operationId: `operation-${id}`,
    kind,
    sandboxId,
    freshSandbox,
    startedAt,
    completedAt,
    checks,
    status: passed ? "passed" as const : "failed" as const,
    failureFingerprint,
    binding,
  };
  return {
    version: 1,
    kindName: "code_validation",
    id,
    ...evidence,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

function context(): ScopedExtensionContextV1 {
  return {
    version: 1,
    extensionId: "agentic-researcher-code",
    missionId: SCOPE.runId,
    operationId: "repair-tool-operation",
    originalPrompt: "Repair the fixture and create a verified local commit.",
    abortSignal: new AbortController().signal,
    now: () => new Date(NOW),
    reportProgress() {},
  };
}

function authorizedContext(
  action: PreparedActionV1,
  payloadFingerprint = action.payloadFingerprint,
): ScopedExtensionContextV1 {
  return {
    ...context(),
    authorizedAction: {
      preparedActionId: action.id,
      payloadFingerprint,
      grantId: "grant-1",
    },
  };
}

function patchFor(changedPath: string): string {
  return [
    `diff --git a/${changedPath} b/${changedPath}`,
    `--- a/${changedPath}`,
    `+++ b/${changedPath}`,
    "@@ -1 +1 @@",
    "-broken",
    "+fixed",
    "",
  ].join("\n");
}
