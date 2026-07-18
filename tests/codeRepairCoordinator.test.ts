import test from "node:test";
import assert from "node:assert/strict";
import { sha256Fingerprint } from "../packages/headless-runtime/src/canonicalize";

import {
  CodeRepairCoordinatorV1,
  CODE_COMMIT_VERIFIED_TOOL,
  CODE_REPAIR_RECORD_CYCLE_TOOL,
  CODE_REPAIR_STATUS_TOOL,
  classifyProtectedControlChanges,
  codeRepairCheckpointIdV1,
  createCodeRepairToolContributionsV1,
  type ArtifactHashReadbackV1,
  type CodeDiffReceiptV1,
  type CodeRepairCheckpointStoreV1,
  type CodeRepairCheckpointV1,
  type CodeRepairCoordinatorDependenciesV1,
  type CodeRepairRequestV1,
  type CodeRepairToolHandlersV1,
  type CodeValidationReceiptV1,
  type NormalizedCodeRepairRequestV1,
  type ProtectedDiffApprovalRequestV1,
} from "../extensions/code/repair";

const BASE_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const BEFORE_HASH = `sha256:${"1".repeat(64)}`;
const AFTER_HASH = `sha256:${"2".repeat(64)}`;
const SHA_DRIFT = `sha256:${"9".repeat(64)}`;
const NOW = "2026-07-12T12:00:00.000Z";

test("exports the fixed AgentRunner tool catalog with fail-closed commit preparation", () => {
  const unavailable = async () => {
    throw new Error("adapter unavailable");
  };
  const contributions = createCodeRepairToolContributionsV1({
    readStatus: unavailable,
    prepareCycleRecord: unavailable,
    executePreparedCycleRecord: unavailable,
    reconcileCycleRecord: unavailable,
    prepareVerifiedCommit: unavailable,
    executePreparedVerifiedCommit: unavailable,
    reconcileVerifiedCommit: unavailable,
  } as CodeRepairToolHandlersV1);
  assert.deepEqual(
    contributions.map((contribution) => contribution.tool.name),
    [CODE_REPAIR_STATUS_TOOL, CODE_REPAIR_RECORD_CYCLE_TOOL, CODE_COMMIT_VERIFIED_TOOL],
  );
  assert.equal(contributions[0].tool.descriptor.effect, "read");
  assert.equal(contributions[1].tool.descriptor.effect, "reversible_mutation");
  assert.equal(contributions[1].tool.descriptor.execution.preparation, "required");
  assert.ok(contributions[1].tool.descriptor.allowedPrincipals.includes("single_agent"));
  assert.equal(contributions[2].tool.descriptor.capability.action, "commit");
  assert.equal(contributions[2].tool.descriptor.execution.preparation, "required");
  assert.equal(contributions[2].tool.descriptor.approval.fallback, "exact");
  assert.ok(contributions[2].tool.descriptor.allowedPrincipals.includes("single_agent"));
  assert.equal(contributions[2].tool.descriptor.durability.readback, "required");
});

test("production repair contributions bind model run aliases to the host mission identity", async () => {
  const observed: Array<{ operation: string; runId: string }> = [];
  const unavailable = async () => {
    throw new Error("not used");
  };
  const handlers = {
    async readStatus(args: { runId: string }) {
      observed.push({ operation: "status", runId: args.runId });
      return {
        ...args,
        workspaceId: "workspace-1",
        requestId: "request-1",
        kind: "code_repair_status" as const,
        checkpointId: "checkpoint-1",
        sequence: 0,
        stage: "pending",
        attempts: [],
        targetedValidationReceiptId: null,
        fullValidationReceiptId: null,
        terminalStatus: null,
        publicationEligible: false,
        blockerCode: null,
      };
    },
    async prepareCycleRecord(args: Record<string, unknown>) {
      observed.push({ operation: "cycle", runId: String(args.runId) });
      return { ok: false as const, code: "expected", message: "captured" };
    },
    executePreparedCycleRecord: unavailable,
    reconcileCycleRecord: unavailable,
    async prepareVerifiedCommit(args: Record<string, unknown>) {
      observed.push({ operation: "commit", runId: String(args.runId) });
      return { ok: false as const, code: "expected", message: "captured" };
    },
    executePreparedVerifiedCommit: unavailable,
    reconcileVerifiedCommit: unavailable,
  } as unknown as CodeRepairToolHandlersV1;
  const contributions = createCodeRepairToolContributionsV1(handlers, {
    hostResolvesDurableProof: true,
  });
  const context = {
    version: 1 as const,
    extensionId: "agentic-researcher-code",
    missionId: "run-2026-07-18t16-48-26.022z-host",
    rootMissionId: "run-2026-07-18t16-00-00.000z-root",
    operationId: "repair-host-scope-test",
    abortSignal: new AbortController().signal,
    now: () => new Date(NOW),
    reportProgress() {},
  };
  const args = {
    runId: "run-2026-07-18T16-48-26.022Z-display",
    workspaceId: "workspace-1",
    requestId: "request-1",
  };
  await contributions[0].tool.execute(args, context);
  await contributions[1].tool.prepare!(args, context);
  await contributions[2].tool.prepare!(args, context);
  assert.deepEqual(observed, [
    { operation: "status", runId: context.rootMissionId },
    { operation: "cycle", runId: context.rootMissionId },
    { operation: "commit", runId: context.rootMissionId },
  ]);
});

test("repairs a later cycle, validates fresh, and emits only a readback-verified commit", async () => {
  const harness = createHarness({ fastOutcomes: ["TS2322", null] });
  const request = createRequest("repair-success");
  const result = await harness.coordinator.execute(request);

  assert.equal(result.status, "complete");
  assert.equal(result.publicationEligible, true);
  assert.equal(result.verifiedCommitReceipt?.kind, "verified_local_commit");
  assert.equal(result.verifiedCommitReceipt?.workspaceId, "workspace-1");
  assert.equal(result.verifiedCommitReceipt?.baseSha, BASE_SHA);
  assert.equal(result.verifiedCommitReceipt?.commitSha, COMMIT_SHA);
  assert.equal(result.verifiedCommitReceipt?.treeSha, TREE_SHA);
  assert.deepEqual(result.verifiedCommitReceipt?.changedArtifacts, [
    { path: "src/index.ts", sha256: AFTER_HASH },
  ]);
  assert.match(result.verifiedCommitReceipt?.targetedValidationReceiptId ?? "", /targeted/);
  assert.match(result.verifiedCommitReceipt?.fullValidationReceiptId ?? "", /full/);
  assert.deepEqual(
    result.checkpoint.attempts.map((attempt) => attempt.cycleReceipt?.kind),
    ["code_repair_cycle", "code_repair_cycle"],
  );
  assert.equal(result.checkpoint.attempts[0].cycleReceipt?.outcome, "repaired");
  assert.equal(result.checkpoint.attempts[1].cycleReceipt?.outcome, "passed");
  assert.equal(harness.calls.diagnose, 1);
  assert.equal(harness.calls.repair, 1);
  assert.equal(harness.calls.commit, 1);
  assert.equal(harness.approvals.filter((approval) => approval.purpose === "verified_commit").length, 1);
  assert.ok(
    harness.order.indexOf("validate:targeted") < harness.order.indexOf("validate:full"),
  );
  assert.ok(harness.order.indexOf("validate:full") < harness.order.indexOf("commit"));
  assert.ok(harness.order.indexOf("commit") < harness.order.indexOf("commit-readback"));
});

test("stops early when the same failure fingerprint survives a repair", async () => {
  const harness = createHarness({ fastOutcomes: ["same compiler failure", "same compiler failure"] });
  const result = await harness.coordinator.execute(createRequest("unchanged-failure"));

  assert.equal(result.status, "blocked");
  assert.equal(result.publicationEligible, false);
  assert.equal(result.blocker?.code, "unchanged_failure");
  assert.equal(harness.calls.fastValidation, 2);
  assert.equal(harness.calls.diagnose, 1);
  assert.equal(harness.calls.repair, 1);
  assert.equal(harness.calls.targetedValidation, 0);
  assert.equal(harness.calls.fullValidation, 0);
  assert.equal(harness.calls.commit, 0);
  assert.equal(result.checkpoint.attempts[1].cycleReceipt?.outcome, "blocked");
});

test("classifies protected controls and double-confirms workflow bytes", async () => {
  assert.deepEqual(classifyProtectedControlChanges(["package.json"]), {
    level: "exact",
    protectedPaths: ["package.json"],
    doubleExactPaths: [],
  });
  assert.equal(
    classifyProtectedControlChanges(["config/release.json"], ["config/*.json"]).level,
    "exact",
  );
  assert.equal(classifyProtectedControlChanges(["src/hooks/useThing.ts"]).level, "none");

  const path = ".github/workflows/ci.yml";
  const harness = createHarness({ path });
  const result = await harness.coordinator.execute(createRequest("workflow-approval", path));
  assert.equal(result.status, "complete");
  const protectedApprovals = harness.approvals.filter(
    (approval) => approval.purpose === "protected_diff",
  );
  assert.equal(protectedApprovals.length, 2);
  assert.deepEqual(protectedApprovals.map((approval) => approval.confirmationIndex), [1, 2]);
  assert.ok(protectedApprovals.every((approval) => approval.level === "double_exact"));
  assert.ok(
    protectedApprovals.every(
      (approval) => approval.payloadFingerprint === approval.diffFingerprint,
    ),
  );
  assert.equal(
    harness.approvals.filter((approval) => approval.purpose === "verified_commit").length,
    1,
  );
});

test("red targeted or full validation never invokes commit", async (t) => {
  await t.test("targeted red", async () => {
    const harness = createHarness({ targetedOutcome: "targeted failed" });
    const result = await harness.coordinator.execute(createRequest("targeted-red"));
    assert.equal(result.blocker?.code, "targeted_validation_failed");
    assert.equal(result.publicationEligible, false);
    assert.equal(harness.calls.fullValidation, 0);
    assert.equal(harness.calls.commit, 0);
  });

  await t.test("full red", async () => {
    const harness = createHarness({ fullOutcome: "full failed" });
    const result = await harness.coordinator.execute(createRequest("full-red"));
    assert.equal(result.blocker?.code, "full_validation_failed");
    assert.equal(result.publicationEligible, false);
    assert.equal(harness.calls.commit, 0);
  });
});

test("a reused or non-fresh full sandbox blocks commit", async (t) => {
  await t.test("non-fresh", async () => {
    const harness = createHarness({ fullFresh: false });
    const result = await harness.coordinator.execute(createRequest("nonfresh-full"));
    assert.equal(result.blocker?.code, "full_validation_not_fresh");
    assert.equal(harness.calls.commit, 0);
  });

  await t.test("reused sandbox id", async () => {
    const harness = createHarness({ fullSandboxId: "sandbox-targeted" });
    const result = await harness.coordinator.execute(createRequest("reused-full"));
    assert.equal(result.blocker?.code, "full_validation_not_fresh");
    assert.equal(harness.calls.commit, 0);
  });
});

test("commit SHA or diff drift cannot produce a verified receipt", async () => {
  const harness = createHarness({ commitReadbackDiff: `sha256:${"9".repeat(64)}` });
  const result = await harness.coordinator.execute(createRequest("commit-drift"));

  assert.equal(result.status, "blocked");
  assert.equal(result.blocker?.code, "commit_readback_mismatch");
  assert.equal(result.publicationEligible, false);
  assert.equal(result.verifiedCommitReceipt, undefined);
  assert.equal(harness.calls.commit, 1);
  assert.equal(harness.calls.commitReadback, 1);
});

test("terminal replay performs only fresh Git readback and returns the identical durable result", async () => {
  const harness = createHarness({});
  const request = createRequest("terminal-replay");
  const first = await harness.coordinator.execute(request);
  const sideEffectsAfterFirst = harness.order.length;
  const second = await harness.coordinator.execute(request);

  assert.deepEqual(second, first);
  assert.deepEqual(harness.order.slice(sideEffectsAfterFirst), ["commit-readback"]);
  assert.equal(harness.calls.commit, 1);
  assert.equal(harness.calls.commitReadback, 2);
});

test("terminal replay rejects fresh Git drift instead of trusting persisted completion", async () => {
  const harness = createHarness({ replayCommitReadbackDiff: SHA_DRIFT });
  const request = createRequest("terminal-replay-drift");
  const first = await harness.coordinator.execute(request);
  assert.equal(first.status, "complete");
  await assert.rejects(
    harness.coordinator.execute(request),
    /Fresh terminal Git readback failed.*diff fingerprint/i,
  );
  assert.equal(harness.calls.commit, 1, "fresh verification must never redispatch Git commit");
  assert.equal(harness.calls.commitReadback, 2);
});

test("restart resumes the same checkpoint and retries the same operation id", async () => {
  const harness = createHarness({ throwFirstFast: true });
  const request = createRequest("resume-fast");
  await assert.rejects(harness.coordinator.execute(request), /simulated validator interruption/);

  const normalized = normalizedRequest(request);
  const saved = await harness.store.load(codeRepairCheckpointIdV1(normalized));
  assert.equal(saved?.stage, "fast_validation");
  assert.equal(saved?.attempts[0].fastValidation, undefined);

  const result = await harness.coordinator.execute(request);
  assert.equal(result.status, "complete");
  const fastOperationIds = harness.validationOperationIds.filter((id) =>
    id.endsWith("validation-fast-1"),
  );
  assert.equal(fastOperationIds.length, 2);
  assert.equal(fastOperationIds[0], fastOperationIds[1]);
  assert.equal(harness.calls.initialEdit, 1);
});

test("ambiguous commit recovery is readback-only and folds proof into the ordinary terminal receipt", async () => {
  const harness = createHarness({ throwAmbiguousCommit: true });
  const request = createRequest("ambiguous-commit-readback");

  await assert.rejects(
    harness.coordinator.execute(request),
    /commit response lost after local commit/u,
  );
  const before = await harness.store.load(
    codeRepairCheckpointIdV1(normalizedRequest(request)),
  );
  assert.equal(before?.stage, "committing");
  assert.equal(before?.commit, undefined);

  const reconciled = await harness.coordinator.reconcileAmbiguousCommit(request);
  assert.equal(reconciled.outcome, "complete");
  if (reconciled.outcome !== "complete") return;
  assert.equal(reconciled.result.verifiedCommitReceipt?.commitSha, COMMIT_SHA);
  assert.equal(reconciled.result.publicationEligible, true);
  assert.equal(harness.calls.commit, 1, "reconciliation must not invoke commit again");
  assert.equal(harness.calls.commitReconcile, 1);
});

interface HarnessOptions {
  path?: string;
  fastOutcomes?: Array<string | null>;
  targetedOutcome?: string | null;
  fullOutcome?: string | null;
  fullFresh?: boolean;
  fullSandboxId?: string;
  commitReadbackDiff?: string;
  replayCommitReadbackDiff?: string;
  throwFirstFast?: boolean;
  throwAmbiguousCommit?: boolean;
}

function createHarness(options: HarnessOptions) {
  const path = options.path ?? "src/index.ts";
  const store = new MemoryCheckpointStore();
  const order: string[] = [];
  const approvals: ProtectedDiffApprovalRequestV1[] = [];
  const validationOperationIds: string[] = [];
  const calls = {
    initialEdit: 0,
    repair: 0,
    diagnose: 0,
    fastValidation: 0,
    targetedValidation: 0,
    fullValidation: 0,
    commit: 0,
    commitReadback: 0,
    commitReconcile: 0,
  };
  let fastIndex = 0;
  let threwFast = false;
  let committedDiff: CodeDiffReceiptV1 | null = null;
  let committedArtifacts: ArtifactHashReadbackV1[] = [];

  const dependencies: CodeRepairCoordinatorDependenciesV1 = {
    checkpointStore: store,
    now: () => NOW,
    mutator: {
      async applyInitialEdit({ operationId, request }) {
        calls.initialEdit += 1;
        order.push("initial-edit");
        return editResult(operationId, request, path);
      },
      async applyRepair({ operationId, request }) {
        calls.repair += 1;
        order.push("repair");
        return editResult(operationId, request, path);
      },
    },
    diagnoser: {
      async diagnose({ operationId, failedValidation }) {
        calls.diagnose += 1;
        order.push("diagnose");
        return {
          operationId,
          failureFingerprint: failedValidation.failureFingerprint!,
          summary: "Compiler evidence identifies the faulty edit.",
          proposedRepair: "Apply the smallest typed correction.",
          diagnosedAt: NOW,
        };
      },
    },
    validator: {
      async runValidation(input) {
        validationOperationIds.push(input.operationId);
        order.push(`validate:${input.kind}`);
        if (input.kind === "fast") {
          calls.fastValidation += 1;
          if (options.throwFirstFast && !threwFast) {
            threwFast = true;
            throw new Error("simulated validator interruption");
          }
          const outcomes = options.fastOutcomes ?? [null];
          const outcome = outcomes[Math.min(fastIndex, outcomes.length - 1)] ?? null;
          fastIndex += 1;
          return validationExecution(input, outcome, `sandbox-fast-${input.cycle}`);
        }
        if (input.kind === "targeted") {
          calls.targetedValidation += 1;
          return validationExecution(input, options.targetedOutcome ?? null, "sandbox-targeted");
        }
        calls.fullValidation += 1;
        return validationExecution(
          input,
          options.fullOutcome ?? null,
          options.fullSandboxId ?? "sandbox-full-fresh",
          options.fullFresh ?? true,
        );
      },
    },
    proofReader: {
      async readDiff({ operationId, request }) {
        order.push("diff-readback");
        return {
          operationId,
          baseSha: request.worktree.baseSha,
          patch: `diff --git a/${path} b/${path}\n+fixed`,
          files: [
            {
              path,
              status: "modified" as const,
              previousPath: null,
              beforeSha256: BEFORE_HASH,
              afterSha256: AFTER_HASH,
            },
          ],
          readAt: NOW,
        };
      },
      async readArtifactHashes({ expectedArtifacts }) {
        order.push("artifact-readback");
        return expectedArtifacts.map((artifact) => ({ ...artifact, bytes: 128 }));
      },
    },
    approvalGateway: {
      async requestApproval(request) {
        approvals.push(structuredClone(request));
        order.push(`approval:${request.purpose}:${request.confirmationIndex}`);
        return { operationId: request.operationId, decision: "approved", decidedAt: NOW };
      },
    },
    committer: {
      async commit(input) {
        calls.commit += 1;
        order.push("commit");
        committedDiff = structuredClone(input.diff);
        committedArtifacts = structuredClone(input.artifactHashes);
        if (options.throwAmbiguousCommit) {
          throw new Error("commit response lost after local commit");
        }
        return { operationId: input.operationId, commitSha: COMMIT_SHA, committedAt: NOW };
      },
      async readCommit(input) {
        calls.commitReadback += 1;
        order.push("commit-readback");
        assert.ok(committedDiff);
        return {
          operationId: input.operationId,
          commitSha: input.commitSha,
          parentSha: input.request.worktree.baseSha,
          treeSha: TREE_SHA,
          diffFingerprint:
            (calls.commitReadback > 1 ? options.replayCommitReadbackDiff : undefined) ??
            options.commitReadbackDiff ??
            committedDiff.fingerprint,
          changedPaths: [...committedDiff.changedPaths],
          artifactHashes: structuredClone(committedArtifacts),
          readAt: NOW,
        };
      },
      async reconcilePreparedCommit(input) {
        calls.commitReconcile += 1;
        order.push("commit-reconcile-readback-only");
        assert.ok(committedDiff);
        return {
          outcome: "committed" as const,
          commit: {
            operationId: input.operationId,
            commitSha: COMMIT_SHA,
            committedAt: NOW,
          },
          readback: {
            operationId: `${input.operationId}:readback`,
            commitSha: COMMIT_SHA,
            parentSha: input.request.worktree.baseSha,
            treeSha: TREE_SHA,
            diffFingerprint: committedDiff.fingerprint,
            changedPaths: [...committedDiff.changedPaths],
            artifactHashes: structuredClone(committedArtifacts),
            readAt: NOW,
          },
        };
      },
    },
  };

  return {
    coordinator: new CodeRepairCoordinatorV1(dependencies),
    store,
    order,
    approvals,
    calls,
    validationOperationIds,
  };
}

function createRequest(id: string, path = "src/index.ts"): CodeRepairRequestV1 {
  return {
    id,
    runId: "mission-1",
    objective: "Repair the fixture and prove the local commit.",
    worktree: {
      id: "workspace-1",
      path: "C:\\durable\\workspace-1",
      repositoryRoot: "C:\\trusted\\repository",
      branch: `codex/${id}`,
      baseSha: BASE_SHA,
      profileId: "node-profile",
    },
    commitMessage: "Repair fixture",
    maxCycles: 3,
    expectedArtifacts: [{ path, sha256: AFTER_HASH }],
    protectedControlPaths: [],
  };
}

function normalizedRequest(request: CodeRepairRequestV1): NormalizedCodeRepairRequestV1 {
  return {
    ...request,
    maxCycles: request.maxCycles ?? 3,
    expectedArtifacts: request.expectedArtifacts ?? [],
    protectedControlPaths: request.protectedControlPaths ?? [],
  };
}

function editResult(
  operationId: string,
  request: NormalizedCodeRepairRequestV1,
  path: string,
) {
  return {
    operationId,
    summary: "Applied bounded fixture edit.",
    changedPaths: [path],
    expectedArtifacts: request.expectedArtifacts,
    appliedAt: NOW,
  };
}

async function validationExecution(
  input: {
    operationId: string;
    kind: "fast" | "targeted" | "full";
    cycle: number | null;
    request: NormalizedCodeRepairRequestV1;
  },
  failure: string | null,
  sandboxId: string,
  freshSandbox = false,
) {
  const execution = {
    operationId: input.operationId,
    kind: input.kind,
    sandboxId,
    freshSandbox,
    startedAt: NOW,
    completedAt: NOW,
    checks: [
      {
        label: `${input.kind} validation`,
        exitCode: failure ? 1 : 0,
        stdout: "",
        stderr: failure ?? "",
        durationMs: 25,
      },
    ],
  };
  if (failure || input.kind === "fast") return execution;
  const stagedFiles = input.request.expectedArtifacts.map((artifact) => ({
    ...artifact,
    bytes: 128,
  }));
  const evidence = {
    ...execution,
    status: "passed" as const,
    failureFingerprint: null,
    binding: {
      requestId: input.request.id,
      workspaceId: input.request.worktree.id,
      profileKey: input.request.worktree.profileId,
      inputWorkspaceManifestFingerprint: `sha256:${"3".repeat(64)}`,
      validatedWorkspaceManifestFingerprint: `sha256:${"4".repeat(64)}`,
      workspaceChangedPaths: stagedFiles.map((artifact) => artifact.path),
      stagingManifestFingerprint: await sha256Fingerprint(stagedFiles),
      stagedFiles,
      importedArtifacts: [],
    },
  };
  return {
    version: 1 as const,
    kindName: "code_validation" as const,
    id: input.operationId,
    ...evidence,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

class MemoryCheckpointStore implements CodeRepairCheckpointStoreV1 {
  private readonly checkpoints = new Map<string, CodeRepairCheckpointV1>();

  async load(id: string): Promise<CodeRepairCheckpointV1 | null> {
    const checkpoint = this.checkpoints.get(id);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async save(checkpoint: CodeRepairCheckpointV1, expectedSequence: number | null): Promise<void> {
    const existing = this.checkpoints.get(checkpoint.id);
    if (expectedSequence === null) {
      if (existing) throw new Error("checkpoint already exists");
      assert.equal(checkpoint.sequence, 0);
    } else {
      assert.equal(existing?.sequence, expectedSequence, "checkpoint CAS sequence");
      assert.equal(checkpoint.sequence, expectedSequence + 1);
    }
    this.checkpoints.set(checkpoint.id, structuredClone(checkpoint));
  }
}
