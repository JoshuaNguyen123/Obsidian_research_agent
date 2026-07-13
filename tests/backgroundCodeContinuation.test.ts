import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  parsePreparedBackgroundCodeActionV1,
  type PreparedBackgroundCodeActionV1,
} from "../packages/core-api/src/preparedBackgroundCodeActionV1";
import type {
  CompanionJobV1,
  CompanionReceiptV1,
  HeadlessWorkerContextV1,
} from "../packages/headless-runtime/src/backgroundContinuation";
import { sha256Fingerprint } from "../packages/headless-runtime/src/canonicalize";
import {
  BackgroundCodeContinuationRuntimeV1,
  type BackgroundCodeContinuationDependenciesV1,
} from "../extensions/code/background";
import type { RepositoryProfileV2 } from "../extensions/code/repositories";
import type { SandboxCapabilityStatusV2 } from "../extensions/code/sandbox";
import {
  CodeRepairCoordinatorV1,
  codeRepairCheckpointIdV1,
  normalizeCodeRepairRequestV1,
  type CodeRepairCheckpointStoreV1,
  type CodeRepairCheckpointV1,
  type CodeRepairResultV1,
  type VerifiedLocalCommitReceiptV1,
} from "../extensions/code/repair";
import { WorkspaceManagerV2 } from "../extensions/code/workspaces";

const NOW = "2026-07-13T12:00:00.000Z";
const EXPIRES = "2026-07-13T12:10:00.000Z";
const AFTER_EXPIRY = "2026-07-13T12:20:00.000Z";
const BASE_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);

test("prepares a closed path-free action and runs the bounded coordinator under a workspace lease", async (t) => {
  const fixture = await createFixture(t);
  let executeCalls = 0;
  let observedLeaseOwner: string | null = null;
  const coordinator = {
    execute: async () => {
      executeCalls += 1;
      observedLeaseOwner = (await fixture.manager.loadManifest("workspace-1")).lease?.ownerId ?? null;
      const complete = completeCheckpoint(fixture.checkpoint);
      fixture.store.replace(complete);
      return resultFrom(complete);
    },
    reconcileAmbiguousCommit: async () => {
      throw new Error("unexpected reconciliation");
    },
  } as unknown as CodeRepairCoordinatorV1;
  const runtime = createRuntime(fixture, coordinator);
  const handoff = await prepare(runtime, fixture.checkpoint.id);

  assert.deepEqual(parsePreparedBackgroundCodeActionV1(handoff), handoff);
  assert.equal(JSON.stringify(handoff).includes(fixture.worktreeRoot), false);
  assert.equal(JSON.stringify(handoff).includes(fixture.repositoryRoot), false);
  assert.equal(JSON.stringify(handoff).includes("npm test"), false);
  assert.throws(
    () => parsePreparedBackgroundCodeActionV1({ ...handoff, command: "powershell -c whoami" }),
    /closed contract/u,
  );

  const receipts: CompanionReceiptV1[] = [];
  const result = await runtime.createExecutor()(jobFor(handoff), context(receipts, NOW));

  assert.equal(result.status, "complete");
  assert.equal(executeCalls, 1);
  assert.match(observedLeaseOwner ?? "", /^background-code:/u);
  assert.deepEqual(receipts.map((receipt) => receipt.status), ["dispatched", "verified"]);
  assert.equal((await fixture.manager.loadManifest("workspace-1")).lease, null);
  assert.equal(result.outputs?.commitSha, COMMIT_SHA);
  assert.equal(JSON.stringify(result).includes(fixture.worktreeRoot), false);
  assert.equal(JSON.stringify(result).includes(fixture.repositoryRoot), false);
});

test("an ambiguous commit restart performs readback reconciliation with zero redispatch", async (t) => {
  const fixture = await createFixture(t);
  let executeCalls = 0;
  let reconcileCalls = 0;
  const coordinator = {
    execute: async () => {
      executeCalls += 1;
      fixture.store.replace({
        ...fixture.checkpoint,
        sequence: fixture.checkpoint.sequence + 1,
        stage: "committing",
        updatedAt: NOW,
      });
      throw new Error("commit response lost after object creation");
    },
    reconcileAmbiguousCommit: async () => {
      reconcileCalls += 1;
      const latest = await fixture.store.load(fixture.checkpoint.id);
      assert.equal(latest?.stage, "committing");
      const complete = completeCheckpoint(latest!);
      fixture.store.replace(complete);
      return { outcome: "complete" as const, result: resultFrom(complete) };
    },
  } as unknown as CodeRepairCoordinatorV1;
  const runtime = createRuntime(fixture, coordinator);
  const handoff = await prepare(runtime, fixture.checkpoint.id);
  const job = jobFor(handoff);
  const receipts: CompanionReceiptV1[] = [];

  const first = await runtime.createExecutor()(job, context(receipts, NOW));
  assert.equal(first.status, "reconcile_required");
  assert.equal(executeCalls, 1);
  assert.equal(reconcileCalls, 0);
  assert.deepEqual(receipts.map((receipt) => receipt.status), ["dispatched", "ambiguous"]);

  const second = await runtime.createExecutor()(job, context(receipts, AFTER_EXPIRY));
  assert.equal(second.status, "complete");
  assert.equal(executeCalls, 1, "ambiguous restart must not invoke the mutation path again");
  assert.equal(reconcileCalls, 1);
  assert.equal(receipts.at(-1)?.status, "verified");
});

test("sandbox drift fails before WAL, lease acquisition, or coordinator execution", async (t) => {
  const fixture = await createFixture(t);
  let sandbox = verifiedSandbox();
  let executeCalls = 0;
  const coordinator = {
    execute: async () => {
      executeCalls += 1;
      throw new Error("must not execute");
    },
  } as unknown as CodeRepairCoordinatorV1;
  const runtime = createRuntime(fixture, coordinator, () => sandbox);
  const handoff = await prepare(runtime, fixture.checkpoint.id);
  sandbox = {
    version: 1,
    mode: "editing_only",
    executionAvailable: false,
    editingAvailable: true,
    selectedProvider: null,
    providers: [],
    blocker: {
      version: 1,
      code: "sandbox_provider_unavailable",
      message: "No isolated provider is available.",
      requiredAction: "Install an approved provider.",
      retryable: true,
      editingAvailable: true,
      executionAvailable: false,
      fingerprint: fp("9"),
    },
  };
  const receipts: CompanionReceiptV1[] = [];

  await assert.rejects(
    runtime.createExecutor()(jobFor(handoff), context(receipts, NOW)),
    /no sandbox passed/u,
  );
  assert.equal(executeCalls, 0);
  assert.equal(receipts.length, 0);
  assert.equal((await fixture.manager.loadManifest("workspace-1")).lease, null);
});

test("job payload injection is rejected and persisted diagnostics redact trusted paths and secrets", async (t) => {
  const fixture = await createFixture(t);
  let executeCalls = 0;
  const coordinator = {
    execute: async () => {
      executeCalls += 1;
      throw new Error(
        `validation failed in ${fixture.worktreeRoot}; token=super-secret-value`,
      );
    },
  } as unknown as CodeRepairCoordinatorV1;
  const runtime = createRuntime(fixture, coordinator);
  const handoff = await prepare(runtime, fixture.checkpoint.id);
  const receipts: CompanionReceiptV1[] = [];
  const injected = jobFor(handoff);
  injected.inputs = { command: "powershell -c whoami" };

  await assert.rejects(
    runtime.createExecutor()(injected, context(receipts, NOW)),
    /job scope/u,
  );
  assert.equal(executeCalls, 0);
  assert.equal(receipts.length, 0);

  const result = await runtime.createExecutor()(jobFor(handoff), context(receipts, NOW));
  assert.equal(result.status, "reconcile_required");
  assert.equal(executeCalls, 1);
  assert.equal(result.blocker?.message.includes(fixture.worktreeRoot), false);
  assert.equal(result.blocker?.message.includes("super-secret-value"), false);
  assert.match(result.blocker?.message ?? "", /<TRUSTED_BOUNDARY>/u);
  assert.match(result.blocker?.message ?? "", /token=\[REDACTED\]/u);
});

async function createFixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-background-code-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, "repository");
  const worktreeRoot = path.join(root, "worktree");
  await fs.mkdir(repositoryRoot, { recursive: true });
  await fs.mkdir(worktreeRoot, { recursive: true });
  await fs.writeFile(path.join(worktreeRoot, ".git"), "gitdir: ../repository/.git/worktrees/fixture\n");
  const manager = new WorkspaceManagerV2({
    applicationDataRoot: path.join(root, "app-data"),
    now: () => new Date(NOW),
    randomId: () => "background-code-lease",
  });
  await manager.registerTrustedRepositoryWorkspace({
    workspaceId: "workspace-1",
    ownerRunId: "run-1",
    profileKey: "profile-1",
    repositoryRoot,
    worktreeRoot,
    branch: "codex/background-code",
    baseSha: BASE_SHA,
    bindingFingerprint: fp("1"),
    trusted: true,
    expiresAt: "2026-07-14T12:00:00.000Z",
    sandboxPolicy: {
      mode: "sandbox_required",
      provider: "docker",
      boundaryFingerprint: fp("2"),
      network: "disabled",
    },
  });
  const request = normalizeCodeRepairRequestV1({
    id: "repair-1",
    runId: "run-1",
    objective: "Repair the trusted fixture.",
    worktree: {
      id: "workspace-1",
      path: worktreeRoot,
      repositoryRoot,
      branch: "codex/background-code",
      baseSha: BASE_SHA,
      profileId: "profile-1",
    },
    commitMessage: "Repair trusted fixture",
    maxCycles: 3,
  });
  const checkpoint: CodeRepairCheckpointV1 = {
    version: 1,
    id: codeRepairCheckpointIdV1(request),
    request,
    requestFingerprint: await sha256Fingerprint(request),
    sequence: 0,
    stage: "initialized",
    createdAt: NOW,
    updatedAt: NOW,
    attempts: [],
    failureHistory: [],
    validationHistory: [],
    approvalHistory: [],
  };
  const store = new MemoryCheckpointStore(checkpoint);
  const profile = profileFixture(repositoryRoot);
  return { root, repositoryRoot, worktreeRoot, manager, checkpoint, store, profile };
}

function createRuntime(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  coordinator: CodeRepairCoordinatorV1,
  sandbox = verifiedSandbox,
): BackgroundCodeContinuationRuntimeV1 {
  const dependencies: BackgroundCodeContinuationDependenciesV1 = {
    checkpoints: fixture.store,
    coordinator,
    workspaceManager: fixture.manager,
    getRepositoryProfile: async (key) => key === fixture.profile.key ? fixture.profile : null,
    readSandboxStatus: sandbox,
    now: () => new Date(NOW),
    leaseDurationMs: 5_000,
    leaseHeartbeatMs: 1_000,
  };
  return new BackgroundCodeContinuationRuntimeV1(dependencies);
}

function prepare(
  runtime: BackgroundCodeContinuationRuntimeV1,
  checkpointId: string,
): Promise<PreparedBackgroundCodeActionV1> {
  return runtime.prepareAction({
    missionId: "mission-1",
    graphRevision: 4,
    capabilityEnvelopeFingerprint: fp("3"),
    nodeId: "code-node",
    nodeFingerprint: fp("4"),
    executionHost: "headless_runtime",
    descriptorFingerprint: fp("5"),
    preparedActionId: "prepared-code-action",
    preparedActionFingerprint: fp("6"),
    destinationFingerprint: fp("7"),
    authority: {
      id: "code-grant-1",
      authorityFingerprint: fp("8"),
      actionFingerprint: fp("6"),
      consumedAt: "2026-07-13T11:59:59.000Z",
      expiresAt: EXPIRES,
    },
    repairCheckpointId: checkpointId,
  });
}

function jobFor(
  handoff: PreparedBackgroundCodeActionV1,
): CompanionJobV1 & { preparedBackgroundCodeAction: PreparedBackgroundCodeActionV1 } {
  return {
    version: 1,
    id: "companion-background-code-job",
    missionId: handoff.missionId,
    nodeId: handoff.nodeId,
    graphRevision: handoff.graphRevision,
    domain: "code",
    executionHost: handoff.executionHost,
    state: "queued",
    objective: "Continue the already-authorized repair checkpoint.",
    inputs: {},
    allowedTools: ["code_validate_commit_prepared"],
    requiredCapabilities: ["code.repair"],
    bindings: [
      {
        id: handoff.binding.workspaceId,
        kind: "repository-workspace",
        destinationFingerprint: handoff.binding.destinationFingerprint,
      },
    ],
    capabilityEnvelopeFingerprint: handoff.capabilityEnvelopeFingerprint,
    authorization: {
      version: 1,
      grantId: "background-node-grant",
      fingerprint: fp("1"),
      authorizedAt: handoff.authority.consumedAt,
      expiresAt: handoff.authority.expiresAt,
    },
    preparedExternalActionHandoff: null,
    preparedBackgroundCodeAction: handoff,
    idempotencyKey: fp("a"),
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function context(receipts: CompanionReceiptV1[], now: string): HeadlessWorkerContextV1 {
  return {
    signal: new AbortController().signal,
    now: () => new Date(now),
    reportProgress: async () => undefined,
    listCommittedReceipts: async () => structuredClone(receipts),
    commitReceipt: async (receipt) => {
      const existing = receipts.find((candidate) => candidate.fingerprint === receipt.fingerprint);
      if (existing) return existing;
      receipts.push(receipt);
      return receipt;
    },
  };
}

function completeCheckpoint(checkpoint: CodeRepairCheckpointV1): CodeRepairCheckpointV1 {
  const verified = verifiedCommitReceipt(checkpoint);
  return {
    ...structuredClone(checkpoint),
    sequence: checkpoint.sequence + 1,
    stage: "complete",
    updatedAt: NOW,
    verifiedCommitReceipt: verified,
    terminal: {
      status: "complete",
      publicationEligible: true,
      completedAt: NOW,
    },
  };
}

function verifiedCommitReceipt(checkpoint: CodeRepairCheckpointV1): VerifiedLocalCommitReceiptV1 {
  return {
    version: 1,
    kind: "verified_local_commit",
    id: "verified-commit-1",
    status: "verified",
    requestId: checkpoint.request.id,
    runId: checkpoint.request.runId,
    worktreeId: checkpoint.request.worktree.id,
    workspaceId: checkpoint.request.worktree.id,
    branch: checkpoint.request.worktree.branch,
    baseSha: checkpoint.request.worktree.baseSha,
    commitSha: COMMIT_SHA,
    parentSha: checkpoint.request.worktree.baseSha,
    treeSha: "c".repeat(40),
    diffFingerprint: fp("d"),
    changedPaths: ["src/index.ts"],
    artifactHashes: [{ path: "src/index.ts", sha256: fp("e"), bytes: 32 }],
    changedArtifacts: [{ path: "src/index.ts", sha256: fp("e") }],
    targetedValidationReceiptId: "targeted-validation",
    fullValidationReceiptId: "full-validation",
    targetedValidationFingerprint: fp("f"),
    fullValidationFingerprint: fp("0"),
    committedAt: NOW,
    fingerprint: fp("b"),
  };
}

function resultFrom(checkpoint: CodeRepairCheckpointV1): CodeRepairResultV1 {
  return {
    status: "complete",
    publicationEligible: true,
    checkpoint: structuredClone(checkpoint),
    verifiedCommitReceipt: structuredClone(checkpoint.verifiedCommitReceipt!),
  };
}

function profileFixture(repositoryRoot: string): RepositoryProfileV2 {
  return {
    schemaVersion: 2,
    key: "profile-1",
    displayName: "Background fixture",
    repositoryRoot,
    defaultBranch: "main",
    projects: [{ id: "root", root: ".", ecosystems: ["node"], allowedPaths: ["src/**"] }],
    ecosystems: ["node"],
    allowedPaths: ["src/**"],
    protectedControls: [],
    pinnedRuntimes: [],
    validationCatalog: [],
    generatedOutputs: [],
    requiredGitHubChecks: [],
    mergePolicy: {
      allowedMethods: ["squash"],
      defaultMethod: "squash",
      requireFreshRequiredChecks: true,
      requireSeparateMergeApproval: true,
      forbidForcePush: true,
    },
  };
}

function verifiedSandbox(): SandboxCapabilityStatusV2 {
  return {
    version: 1,
    mode: "sandbox_verified",
    executionAvailable: true,
    editingAvailable: true,
    selectedProvider: "docker",
    providers: [
      {
        provider: "docker",
        state: "verified",
        diagnostic: "Boundary probe passed.",
        probeFingerprint: fp("c"),
        checkedAt: NOW,
      },
    ],
    blocker: null,
  };
}

class MemoryCheckpointStore implements CodeRepairCheckpointStoreV1 {
  private checkpoint: CodeRepairCheckpointV1;

  constructor(checkpoint: CodeRepairCheckpointV1) {
    this.checkpoint = structuredClone(checkpoint);
  }

  async load(id: string): Promise<CodeRepairCheckpointV1 | null> {
    return id === this.checkpoint.id ? structuredClone(this.checkpoint) : null;
  }

  async save(checkpoint: CodeRepairCheckpointV1): Promise<void> {
    this.checkpoint = structuredClone(checkpoint);
  }

  replace(checkpoint: CodeRepairCheckpointV1): void {
    this.checkpoint = structuredClone(checkpoint);
  }
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
