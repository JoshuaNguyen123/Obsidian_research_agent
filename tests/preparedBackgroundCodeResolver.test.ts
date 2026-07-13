import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { canonicalMissionGraphId } from "../packages/core-api/src";
import {
  buildMissionCapabilityEnvelopeV1,
  parseMissionGraphV3,
  type MissionGraphV3,
  type MissionNodeV3,
} from "../packages/headless-runtime/src/missionGraphV3";
import {
  buildBackgroundAuthorizationV1,
} from "../packages/headless-runtime/src/backgroundContinuation";
import { sha256Fingerprint } from "../packages/headless-runtime/src/canonicalize";
import {
  PreparedBackgroundCodeExecutionPlanStoreV1,
  PreparedBackgroundCodeHostV1,
  PreparedBackgroundCodeResolverV1,
  PREPARED_BACKGROUND_CODE_OBJECTIVE_V1,
} from "../extensions/code/background";
import {
  detectRepositoryProfileV2,
  type RepositoryProfileV2,
} from "../extensions/code/repositories";
import {
  normalizeCodeRepairRequestV1,
  parseCodeRepairCheckpointV1,
  type CodeRepairCheckpointStoreV1,
  type CodeRepairCheckpointV1,
  type CodeValidationReceiptV1,
} from "../extensions/code/repair";
import {
  SandboxManagerV2,
  type SandboxCommandRunnerV2,
  type SandboxProviderConfigV2,
} from "../extensions/code/sandbox";
import { WorkspaceManagerV2 } from "../extensions/code/workspaces";

const BASE_SHA = "a".repeat(40);
const BINDING_FINGERPRINT = fp("b");
const PROVIDER_DIGEST = fp("f");

test("production resolver prepares, seals, persists, reloads, and deterministically reuses one Node source package", async () => {
  const fixture = await createFixture();
  try {
    const prepared = await fixture.resolver.prepareApproval({
      repairCheckpointId: fixture.checkpoint.id,
      runId: fixture.runId,
      toolCallId: "tool-call-1",
    });
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") return;
    assert.deepEqual(Object.keys(prepared.preparedAction.normalizedArgs).sort(), [
      "checkpointSequence",
      "fullCommandId",
      "kind",
      "previewDiffFingerprint",
      "projectId",
      "repairCheckpointId",
      "repositoryProfileFingerprint",
      "repositoryProfileKey",
      "sandboxCapabilityFingerprint",
      "sourceRequestFingerprint",
      "stagingManifestFingerprint",
      "stateFingerprint",
      "targetedCommandId",
      "version",
      "workspaceBindingFingerprint",
      "workspaceId",
    ]);
    assert.equal(
      JSON.stringify(prepared.preparedAction.normalizedArgs).includes("powershell"),
      false,
    );

    const graph = await graphFixture(fixture);
    const authorization = await buildBackgroundAuthorizationV1({
      graph,
      nodeId: "code-node",
      grantId: "mission-capability-code",
      authorizedAt: fixture.now,
      expiresAt: prepared.preparedAction.expiresAt,
      authorizedGraphRevision: graph.revision,
    });
    const authority = {
      id: "consumed-code-grant",
      authorityFingerprint: fp("c"),
      actionFingerprint: prepared.preparedAction.payloadFingerprint,
      consumedAt: fixture.now,
      expiresAt: prepared.preparedAction.expiresAt,
    };
    const first = await fixture.resolver.sealPackage({
      graph,
      authorization,
      preparedAction: prepared.preparedAction,
      authority,
    });
    assert.equal(first.status, "ready");
    if (first.status !== "ready") return;
    assert.equal(first.packagePersistenceReceipt.readbackVerified, true);
    assert.equal(first.handoff.binding.workspaceId, fixture.workspaceId);
    assert.equal(first.handoff.binding.repositoryProfileKey, fixture.profile.key);
    const remoteIdentity = JSON.stringify({
      handoff: first.handoff,
      packageIdentity: first.packageIdentity,
    });
    assert.equal(remoteIdentity.includes(fixture.worktreeRoot), false);
    assert.equal(remoteIdentity.includes(fixture.repositoryRoot), false);
    assert.equal(remoteIdentity.includes("npm"), false);
    assert.equal(remoteIdentity.includes("powershell"), false);

    const plan = await new PreparedBackgroundCodeExecutionPlanStoreV1(
      fixture.applicationDataRoot,
    ).load(first.packageIdentity.executionPlanFingerprint);
    assert.equal(plan.checkpoint.request.objective, PREPARED_BACKGROUND_CODE_OBJECTIVE_V1);
    assert.equal(plan.checkpoint.request.objective.includes("powershell"), false);
    assert.equal(plan.checkpoint.attempts.length, 1);
    assert.equal(plan.checkpoint.attempts[0].diagnosis, undefined);
    assert.equal(plan.checkpoint.attempts[0].repair, undefined);
    assert.equal(plan.targetedValidation.action.network.mode, "disabled");
    assert.equal(plan.fullValidation.action.network.mode, "disabled");
    assert.equal(plan.targetedValidation.action.projectId, plan.fullValidation.action.projectId);
    assert.deepEqual(
      plan.targetedValidation.action.stagingManifest,
      plan.fullValidation.action.stagingManifest,
    );

    const restarted = new PreparedBackgroundCodeResolverV1({
      checkpoints: fixture.checkpoints,
      workspaceManager: fixture.workspaceManager,
      getRepositoryProfile: async () => fixture.profile,
      sandboxManager: fixture.sandboxManager,
      sandboxProviders: () => [fixture.provider],
      host: new PreparedBackgroundCodeHostV1({
        applicationDataRoot: fixture.applicationDataRoot,
        now: () => new Date(fixture.now),
      }),
      now: () => new Date(fixture.now),
    });
    const second = await restarted.sealPackage({
      graph,
      authorization,
      preparedAction: prepared.preparedAction,
      authority,
    });
    assert.equal(second.status, "ready");
    if (second.status === "ready") {
      assert.deepEqual(second.handoff, first.handoff);
      assert.deepEqual(second.packageIdentity, first.packageIdentity);
      assert.deepEqual(
        second.packagePersistenceReceipt.fingerprint,
        first.packagePersistenceReceipt.fingerprint,
      );
    }
  } finally {
    await fixture.dispose();
  }
});

test("production resolver prepares and seals one detected Python source package", async () => {
  const fixture = await createFixture({ ecosystem: "python" });
  try {
    const prepared = await fixture.resolver.prepareApproval({
      repairCheckpointId: fixture.checkpoint.id,
      runId: fixture.runId,
      toolCallId: "tool-call-python",
    });
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") return;
    const graph = await graphFixture(fixture);
    const authorization = await buildBackgroundAuthorizationV1({
      graph,
      nodeId: "code-node",
      grantId: "mission-capability-code",
      authorizedAt: fixture.now,
      expiresAt: prepared.preparedAction.expiresAt,
      authorizedGraphRevision: graph.revision,
    });
    const sealed = await fixture.resolver.sealPackage({
      graph,
      authorization,
      preparedAction: prepared.preparedAction,
      authority: {
        id: "consumed-code-grant",
        authorityFingerprint: fp("c"),
        actionFingerprint: prepared.preparedAction.payloadFingerprint,
        consumedAt: fixture.now,
        expiresAt: prepared.preparedAction.expiresAt,
      },
    });
    assert.equal(sealed.status, "ready");
    if (sealed.status !== "ready") return;
    const plan = await new PreparedBackgroundCodeExecutionPlanStoreV1(
      fixture.applicationDataRoot,
    ).load(sealed.packageIdentity.executionPlanFingerprint);
    assert.equal(plan.repositoryProfile.ecosystems.includes("python"), true);
    assert.equal(plan.targetedValidation.action.command.executable, "python");
    assert.equal(plan.fullValidation.action.command.executable, "python");
    assert.equal(JSON.stringify(sealed.handoff).includes("python"), false);
  } finally {
    await fixture.dispose();
  }
});

test("production resolver reauthorizes an exact prior-run checkpoint while rejecting graph, workspace, binding, and checkpoint drift", async () => {
  const fixture = await createFixture({ runId: "run-foreground-source" });
  const authorizingRunId = "run-2026-07-13T03-23-36.470Z-ABC123";
  try {
    const prepared = await fixture.resolver.prepareApproval({
      repairCheckpointId: fixture.checkpoint.id,
      runId: authorizingRunId,
      toolCallId: "tool-call-canonical-graph",
    });
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") return;
    assert.equal(prepared.preparedAction.runId, authorizingRunId);

    const canonicalGraph = await graphFixture(
      fixture,
      canonicalMissionGraphId(authorizingRunId),
    );
    assert.equal(
      canonicalGraph.missionId,
      canonicalMissionGraphId(authorizingRunId),
    );
    assert.notEqual(canonicalGraph.missionId, authorizingRunId);
    const authority = {
      id: "consumed-code-grant-canonical",
      authorityFingerprint: fp("c"),
      actionFingerprint: prepared.preparedAction.payloadFingerprint,
      consumedAt: fixture.now,
      expiresAt: prepared.preparedAction.expiresAt,
    };
    const canonicalAuthorization = await buildBackgroundAuthorizationV1({
      graph: canonicalGraph,
      nodeId: "code-node",
      grantId: "mission-capability-code-canonical",
      authorizedAt: fixture.now,
      expiresAt: prepared.preparedAction.expiresAt,
      authorizedGraphRevision: canonicalGraph.revision,
    });
    const accepted = await fixture.resolver.sealPackage({
      graph: canonicalGraph,
      authorization: canonicalAuthorization,
      preparedAction: prepared.preparedAction,
      authority,
    });
    assert.equal(accepted.status, "ready");
    if (accepted.status === "ready") {
      assert.equal(accepted.handoff.missionId, canonicalGraph.missionId);
      const plan = await new PreparedBackgroundCodeExecutionPlanStoreV1(
        fixture.applicationDataRoot,
      ).load(accepted.packageIdentity.executionPlanFingerprint);
      assert.equal(plan.checkpoint.request.runId, fixture.runId);
      assert.notEqual(plan.checkpoint.request.runId, authorizingRunId);
    }

    const driftedGraph = await graphFixture(fixture, "different-mission");
    const driftedAuthorization = await buildBackgroundAuthorizationV1({
      graph: driftedGraph,
      nodeId: "code-node",
      grantId: "mission-capability-code-drifted",
      authorizedAt: fixture.now,
      expiresAt: prepared.preparedAction.expiresAt,
      authorizedGraphRevision: driftedGraph.revision,
    });
    const rejected = await fixture.resolver.sealPackage({
      graph: driftedGraph,
      authorization: driftedAuthorization,
      preparedAction: prepared.preparedAction,
      authority,
    });
    assert.deepEqual(rejected, {
      status: "blocked",
      code: "background_code_graph_scope_drift",
      message:
        "The approved Code action belongs to a different authoritative mission graph.",
      requiredAction:
        "Prepare and approve the action again from the current mission graph.",
    });

    const mismatchedBindingGraph = await graphFixture(
      fixture,
      canonicalMissionGraphId(authorizingRunId),
      { destinationFingerprint: fp("e") },
    );
    const mismatchedBindingAuthorization = await buildBackgroundAuthorizationV1({
      graph: mismatchedBindingGraph,
      nodeId: "code-node",
      grantId: "mission-capability-code-mismatched-binding",
      authorizedAt: fixture.now,
      expiresAt: prepared.preparedAction.expiresAt,
      authorizedGraphRevision: mismatchedBindingGraph.revision,
    });
    const mismatchedBinding = await fixture.resolver.sealPackage({
      graph: mismatchedBindingGraph,
      authorization: mismatchedBindingAuthorization,
      preparedAction: prepared.preparedAction,
      authority,
    });
    assert.equal(mismatchedBinding.status, "blocked");
    if (mismatchedBinding.status === "blocked") {
      assert.equal(mismatchedBinding.code, "background_code_graph_node_ambiguous");
    }

    const wrongWorkspaceGraph = await graphFixture(
      fixture,
      canonicalMissionGraphId(authorizingRunId),
      { workspaceId: "workspace-other" },
    );
    const wrongWorkspaceAuthorization = await buildBackgroundAuthorizationV1({
      graph: wrongWorkspaceGraph,
      nodeId: "code-node",
      grantId: "mission-capability-code-wrong-workspace",
      authorizedAt: fixture.now,
      expiresAt: prepared.preparedAction.expiresAt,
      authorizedGraphRevision: wrongWorkspaceGraph.revision,
    });
    const wrongWorkspace = await fixture.resolver.sealPackage({
      graph: wrongWorkspaceGraph,
      authorization: wrongWorkspaceAuthorization,
      preparedAction: prepared.preparedAction,
      authority,
    });
    assert.equal(wrongWorkspace.status, "blocked");
    if (wrongWorkspace.status === "blocked") {
      assert.equal(wrongWorkspace.code, "background_code_graph_node_ambiguous");
    }

    const wrongCheckpoint = await fixture.resolver.prepareApproval({
      repairCheckpointId: `${fixture.checkpoint.id}-other`,
      runId: authorizingRunId,
      toolCallId: "tool-call-wrong-checkpoint",
    });
    assert.equal(wrongCheckpoint.status, "blocked");
    if (wrongCheckpoint.status === "blocked") {
      assert.equal(wrongCheckpoint.code, "background_code_checkpoint_unavailable");
    }
  } finally {
    await fixture.dispose();
  }
});

test("production resolver blocks protected source controls, checkpoint drift, and missing sandbox proof", async () => {
  const protectedFixture = await createFixture({
    changedPath: "package.json",
    allowedPaths: ["."],
    initialContent: '{"scripts":{"test":"node --test"}}\n',
    changedContent: '{"scripts":{"test":"powershell -c whoami"}}\n',
  });
  try {
    const result = await protectedFixture.resolver.prepareApproval({
      repairCheckpointId: protectedFixture.checkpoint.id,
      runId: protectedFixture.runId,
      toolCallId: "tool-call-protected",
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") {
      assert.equal(result.code, "background_code_protected_diff_forbidden");
    }
  } finally {
    await protectedFixture.dispose();
  }

  const driftFixture = await createFixture();
  try {
    const prepared = await driftFixture.resolver.prepareApproval({
      repairCheckpointId: driftFixture.checkpoint.id,
      runId: driftFixture.runId,
      toolCallId: "tool-call-drift",
    });
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") return;
    const nextRequest = normalizeCodeRepairRequestV1({
      ...driftFixture.checkpoint.request,
      objective: "A materially different objective after approval.",
    });
    const drifted = await parseCodeRepairCheckpointV1({
      ...driftFixture.checkpoint,
      request: nextRequest,
      requestFingerprint: await sha256Fingerprint(nextRequest),
      sequence: driftFixture.checkpoint.sequence + 1,
    });
    driftFixture.checkpoints.replace(drifted);
    const graph = await graphFixture(driftFixture);
    const authorization = await buildBackgroundAuthorizationV1({
      graph,
      nodeId: "code-node",
      grantId: "mission-capability-code",
      authorizedAt: driftFixture.now,
      expiresAt: prepared.preparedAction.expiresAt,
    });
    const result = await driftFixture.resolver.sealPackage({
      graph,
      authorization,
      preparedAction: prepared.preparedAction,
      authority: {
        id: "consumed-code-grant",
        authorityFingerprint: fp("c"),
        actionFingerprint: prepared.preparedAction.payloadFingerprint,
        consumedAt: driftFixture.now,
        expiresAt: prepared.preparedAction.expiresAt,
      },
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") {
      assert.equal(result.code, "background_code_prepared_state_drift");
    }
  } finally {
    await driftFixture.dispose();
  }

  const sandboxFixture = await createFixture({ sandboxAvailable: false });
  try {
    const result = await sandboxFixture.resolver.prepareApproval({
      repairCheckpointId: sandboxFixture.checkpoint.id,
      runId: sandboxFixture.runId,
      toolCallId: "tool-call-sandbox",
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") {
      assert.equal(result.code, "background_code_sandbox_unavailable");
    }
  } finally {
    await sandboxFixture.dispose();
  }
});

interface FixtureOptions {
  ecosystem?: "node" | "python";
  changedPath?: string;
  allowedPaths?: string[];
  initialContent?: string;
  changedContent?: string;
  sandboxAvailable?: boolean;
  runId?: string;
}

async function createFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "background-code-resolver-"));
  const repositoryRoot = path.join(root, "repository");
  const worktreeRoot = path.join(root, "worktree");
  const applicationDataRoot = path.join(root, "app-data");
  const ecosystem = options.ecosystem ?? "node";
  const markerPath = ecosystem === "python" ? "pyproject.toml" : "package.json";
  const markerContent = ecosystem === "python"
    ? "[project]\nname = \"fixture\"\nversion = \"0.0.0\"\n"
    : '{"scripts":{"test":"node --test","test:full":"node --test"}}\n';
  const changedPath = options.changedPath ??
    (ecosystem === "python" ? "src/value.py" : "src/value.ts");
  const initialContent = options.initialContent ??
    (ecosystem === "python" ? "value = 1\n" : "export const value = 1;\n");
  const changedContent = options.changedContent ??
    (ecosystem === "python" ? "value = 2\n" : "export const value = 2;\n");
  const now = new Date(Date.now() + 60_000).toISOString();
  const runId = options.runId ?? "run-background-node";
  const workspaceId = "workspace-background-node";
  const requestId = "repair-background-node";
  const branch = "codex/background-node";
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(path.join(worktreeRoot, ".git"), "gitdir: fixture\n", "utf8");
  await mkdir(path.dirname(path.join(worktreeRoot, changedPath)), { recursive: true });
  await writeFile(path.join(worktreeRoot, changedPath), initialContent, "utf8");
  if (changedPath !== markerPath) {
    await writeFile(
      path.join(worktreeRoot, markerPath),
      markerContent,
      "utf8",
    );
  }
  const fallbackSource = ecosystem === "python" ? "src/value.py" : "src/value.ts";
  const files = changedPath === markerPath
    ? [markerPath, fallbackSource]
    : [markerPath, changedPath];
  if (changedPath === markerPath) {
    await mkdir(path.join(worktreeRoot, "src"), { recursive: true });
    await writeFile(
      path.join(worktreeRoot, fallbackSource),
      ecosystem === "python" ? "value = None\n" : "export {};\n",
      "utf8",
    );
  }
  const profile = detectRepositoryProfileV2({
    key: "profile-background-node",
    displayName: "Background Node fixture",
    repositoryRoot,
    defaultBranch: "main",
    files,
    fileContents: {
      [markerPath]: changedPath === markerPath
        ? initialContent
        : markerContent,
    },
    runtimeDigests: ecosystem === "python"
      ? { python: fp("d") }
      : { node: fp("d") },
    allowedPaths: options.allowedPaths ?? ["src"],
  });
  const workspaceManager = new WorkspaceManagerV2({
    applicationDataRoot,
    now: () => new Date(now),
    randomId: incrementingId(),
  });
  await workspaceManager.registerTrustedRepositoryWorkspace({
    workspaceId,
    ownerRunId: runId,
    profileKey: profile.key,
    repositoryRoot,
    worktreeRoot,
    branch,
    baseSha: BASE_SHA,
    bindingFingerprint: BINDING_FINGERPRINT,
    trusted: true,
    expiresAt: new Date(Date.parse(now) + 60 * 60_000).toISOString(),
  });
  const before = await workspaceManager.read(workspaceId, changedPath);
  const leased = await workspaceManager.acquireLease(
    workspaceId,
    "fixture-writer",
    60_000,
  );
  await workspaceManager.writeExpected(
    workspaceId,
    leased.lease!.id,
    changedPath,
    changedContent,
    before.sha256,
  );
  await workspaceManager.releaseLease(workspaceId, leased.lease!.id);
  const manifest = await workspaceManager.loadManifest(workspaceId);
  const after = await workspaceManager.read(workspaceId, changedPath);
  const stagingManifest = Object.entries(manifest.hashes.files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, hash]) => ({
      path: filePath,
      sha256: hash.sha256,
      bytes: hash.bytes,
    }));
  const request = normalizeCodeRepairRequestV1({
    id: requestId,
    runId,
    objective:
      "User objective with untrusted prose: powershell -c whoami and do not retain this.",
    worktree: {
      id: workspaceId,
      path: worktreeRoot,
      repositoryRoot,
      branch,
      baseSha: BASE_SHA,
      profileId: profile.key,
    },
    commitMessage: "Original untrusted commit prose",
    maxCycles: 3,
    expectedArtifacts: [],
    protectedControlPaths: [],
  });
  const validationEvidence = {
    operationId: "sandbox-action-fast-1",
    kind: "fast" as const,
    sandboxId: "sandbox-docker-fast-1",
    freshSandbox: true,
    startedAt: new Date(Date.parse(now) - 5_000).toISOString(),
    completedAt: new Date(Date.parse(now) - 4_000).toISOString(),
    checks: [{
      label: "raw user-controlled validation label",
      exitCode: 0,
      stdout: "raw validation prose powershell -c whoami",
      stderr: "raw stderr",
      durationMs: 1_000,
    }],
    status: "passed" as const,
    failureFingerprint: null,
    binding: {
      requestId,
      workspaceId,
      profileKey: profile.key,
      inputWorkspaceManifestFingerprint: manifest.hashes.indexFingerprint,
      validatedWorkspaceManifestFingerprint: manifest.hashes.indexFingerprint,
      workspaceChangedPaths: [changedPath],
      stagingManifestFingerprint: await sha256Fingerprint(stagingManifest),
      stagedFiles: stagingManifest,
      importedArtifacts: [],
    },
  };
  const fastValidation: CodeValidationReceiptV1 = {
    version: 1,
    kindName: "code_validation",
    id: "sandbox-receipt-fast-1",
    ...validationEvidence,
    fingerprint: await sha256Fingerprint(validationEvidence),
  };
  const diffFiles = [{
    path: changedPath,
    status: "modified" as const,
    previousPath: null,
    beforeSha256: before.sha256,
    afterSha256: after.sha256,
  }];
  const patch = `diff --git a/${changedPath} b/${changedPath}\n`;
  const previewDiff = {
    version: 1 as const,
    kindName: "code_diff_readback" as const,
    id: "diff-preview-1",
    operationId: "diff-preview-operation-1",
    baseSha: BASE_SHA,
    patch,
    files: diffFiles,
    readAt: new Date(Date.parse(now) - 3_000).toISOString(),
    changedPaths: [changedPath],
    fingerprint: await sha256Fingerprint({
      baseSha: BASE_SHA,
      patch,
      files: diffFiles,
    }),
  };
  const checkpoint = await parseCodeRepairCheckpointV1({
    version: 1,
    id: `code-repair:${runId}:${workspaceId}:${requestId}`,
    request,
    requestFingerprint: await sha256Fingerprint(request),
    sequence: 4,
    stage: "diff_preview",
    createdAt: new Date(Date.parse(now) - 10_000).toISOString(),
    updatedAt: new Date(Date.parse(now) - 3_000).toISOString(),
    initialEdit: {
      operationId: "initial-edit-1",
      summary: "Original untrusted edit summary",
      changedPaths: [changedPath],
      expectedArtifacts: [],
      appliedAt: new Date(Date.parse(now) - 8_000).toISOString(),
    },
    attempts: [{ cycle: 1, fastValidation }],
    failureHistory: [],
    validationHistory: [fastValidation],
    approvalHistory: [],
    previewDiff,
  });
  const checkpoints = new MemoryCheckpointStore(checkpoint);
  const provider = dockerProvider();
  const runner = sandboxRunner(options.sandboxAvailable !== false);
  const sandboxManager = new SandboxManagerV2({
    runner,
    providers: [provider],
    now: () => new Date(now),
  });
  const host = new PreparedBackgroundCodeHostV1({
    applicationDataRoot,
    now: () => new Date(now),
  });
  const resolver = new PreparedBackgroundCodeResolverV1({
    checkpoints,
    workspaceManager,
    getRepositoryProfile: async (key) => key === profile.key ? profile : null,
    sandboxManager,
    sandboxProviders: () => [provider],
    host,
    now: () => new Date(now),
  });
  return {
    root,
    repositoryRoot,
    worktreeRoot,
    applicationDataRoot,
    now,
    runId,
    workspaceId,
    profile,
    checkpoint,
    checkpoints,
    workspaceManager,
    sandboxManager,
    provider,
    resolver,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function graphFixture(fixture: {
  now: string;
  runId: string;
  workspaceId: string;
  profile: RepositoryProfileV2;
}, missionId = canonicalMissionGraphId(fixture.runId), bindingOverride: {
  workspaceId?: string;
  destinationFingerprint?: string;
} = {}): Promise<MissionGraphV3> {
  const bindingWorkspaceId = bindingOverride.workspaceId ?? fixture.workspaceId;
  const destinationFingerprint =
    bindingOverride.destinationFingerprint ?? BINDING_FINGERPRINT;
  const envelope = await buildMissionCapabilityEnvelopeV1({
    missionId,
    issuedAt: fixture.now,
    expiresAt: null,
    capabilities: ["code.repair"],
    executionHosts: ["headless_runtime"],
    executors: {
      code: {
        id: "code",
        executionHosts: ["headless_runtime"],
        allowedEffects: ["execution"],
      },
    },
    verifiers: [],
    tools: {
      code_validate_commit_prepared: {
        name: "code_validate_commit_prepared",
        effect: "execution",
        capabilityIds: ["code.repair"],
        executionHosts: ["headless_runtime"],
        bindingKinds: ["repository-workspace"],
      },
    },
    bindings: {
      [bindingWorkspaceId]: {
        id: bindingWorkspaceId,
        kind: "repository-workspace",
        destinationFingerprint,
        allowedEffects: ["execution"],
      },
    },
    budgets: {
      maxNodes: 16,
      maxDepth: 4,
      maxConcurrentReadNodes: 3,
      maxTotalToolCalls: 12,
      maxExternalActions: 2,
      maxWallClockMs: 120_000,
      maxAttemptsPerNode: 3,
    },
  });
  return parseMissionGraphV3({
    schemaVersion: 3,
    missionId,
    objective: "Validate and commit the exact prepared Code checkpoint.",
    revision: 7,
    journalHeadFingerprint: fp("9"),
    createdAt: fixture.now,
    updatedAt: fixture.now,
    routing: {
      source: "deterministic",
      fallbackFrom: null,
      fallbackReason: null,
      confidence: 1,
      decidedAt: fixture.now,
      decisionFingerprint: fp("8"),
    },
    continuationCheckpoint: null,
    capabilityEnvelope: envelope,
    nodes: {
      "code-node": nodeFixture(bindingWorkspaceId),
    },
  });
}

function nodeFixture(workspaceId: string): MissionNodeV3 {
  return {
    id: "code-node",
    dependencyIds: [],
    objective: "Validate and commit the exact prepared change.",
    executorId: "code",
    executionHost: "headless_runtime",
    effect: "execution",
    inputs: {},
    outputs: {},
    requiredCapabilities: ["code.repair"],
    allowedTools: ["code_validate_commit_prepared"],
    destination: { bindingId: workspaceId, effect: "execution", selector: null },
    resourceLocks: [{ bindingId: workspaceId, mode: "exclusive" }],
    budget: { toolCalls: 1, externalActions: 0, wallClockMs: 60_000 },
    retries: {
      maxAttempts: 1,
      attempts: 0,
      failureFingerprints: [],
      consecutiveFailureFingerprint: null,
      consecutiveFailureCount: 0,
    },
    status: "running",
    evidence: [],
    receipts: [],
    verification: null,
    completionContract: {
      criteria: ["A readback-verified local commit receipt exists."],
      minimumEvidence: 1,
      requiredEvidenceKinds: ["verified_local_commit"],
      minimumReceipts: 1,
      requiredReceiptKinds: ["code_change"],
      verifierId: null,
    },
    blocker: null,
  };
}

function dockerProvider(): SandboxProviderConfigV2 {
  return {
    version: 1,
    kind: "docker",
    executable: "docker",
    priority: 1,
    runtimeReference: "registry.example/agentic-sandbox",
    runtimeDigest: PROVIDER_DIGEST,
    wslDistribution: null,
    runtimeRoot: null,
  };
}

function sandboxRunner(available: boolean): SandboxCommandRunnerV2 {
  return {
    async run(spec) {
      if (!available) {
        return { exitCode: 1, stdout: "", stderr: "provider unavailable" };
      }
      assert.equal(spec.purpose, "boundary_probe");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          version: 1,
          uid: 65532,
          networkBlocked: true,
          rootReadOnly: true,
          hostRootAbsent: true,
          containerSocketAbsent: true,
          runtimeReadOnly: true,
          runtimeDigest: PROVIDER_DIGEST,
          stagingIsolated: true,
          resourceLimitsEnforced: true,
        }),
        stderr: "",
      };
    },
  };
}

class MemoryCheckpointStore implements CodeRepairCheckpointStoreV1 {
  constructor(private checkpoint: CodeRepairCheckpointV1) {}

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

function incrementingId(): () => string {
  let value = 0;
  return () => `fixture-${++value}`;
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
