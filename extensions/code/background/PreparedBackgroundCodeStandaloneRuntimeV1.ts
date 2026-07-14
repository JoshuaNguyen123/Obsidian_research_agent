import * as path from "node:path";
import { createHash } from "node:crypto";

import {
  PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1,
  backgroundCodeContinuationAttemptIdV1,
  parsePreparedBackgroundCodeActionV1,
} from "../../../packages/core-api/src/preparedBackgroundCodeActionV1";
import { parsePreparedBackgroundCodePackageIdentityV1 } from "../../../packages/core-api/src/preparedBackgroundCodePackageIdentityV1";
import type {
  CompanionJobV1,
  CompanionReceiptV1,
  HeadlessDomainExecutorV1,
  HeadlessWorkerResultV1,
} from "../../../packages/headless-runtime/src/backgroundContinuation";
import { sha256Fingerprint } from "../../../packages/headless-runtime/src/canonicalize";
import {
  SandboxManagerV2,
  SpawnSandboxCommandRunnerV2,
  type PreparedSandboxActionV2,
  type SandboxAuthorizationV2,
} from "../sandbox";
import { WorkspaceManagerV2 } from "../workspaces";
import {
  CodeRepairCoordinatorV1,
  CallbackCodeRepairCheckpointStoreV1,
  DurableValidationReceiptRegistryV1,
  FixedArgvArtifactHashReaderV1,
  FixedArgvRepairProofAdapterV1,
  SpawnFixedArgvGitRunnerV1,
  createFixedArgvVerifiedCommitGatewayV1,
  type CallbackCheckpointPersistenceV1,
  type CodeRepairCheckpointNamespaceV1,
  type CodeRepairCheckpointV1,
  type CodeValidationReceiptV1,
  type DurableValidationReceiptNamespaceV1,
  type ValidationReceiptPersistenceV1,
} from "../repair";
import {
  BackgroundCodeContinuationRuntimeV1,
  workspaceBindingFingerprintV1,
} from "./BackgroundCodeContinuationV1";
import {
  PreparedBackgroundCodeExecutionPlanStoreV1,
  type PreparedBackgroundCodeExecutionPlanV1,
  type PreparedSandboxValidationStepV1,
} from "./PreparedBackgroundCodeExecutionPlanV1";
import {
  PreparedBackgroundCodePackageStoreV1,
  type PreparedBackgroundCodePackageRequirementsV1,
} from "./PreparedBackgroundCodePackageStoreV1";
import { SafeCompanionCodeStateFileV1 } from "./SafeCompanionCodeStateFileV1";

const LEASE_MS = 15 * 60_000;

export interface PreparedBackgroundCodeStandaloneRuntimeOptionsV1 {
  applicationDataRoot: string;
  now?: () => Date;
}

/**
 * Production standalone constructor. It has no plugin-data or model port: all
 * executable state must come from the exact local app-data package and plan.
 */
export function createPreparedBackgroundCodeStandaloneExecutorV1(
  options: PreparedBackgroundCodeStandaloneRuntimeOptionsV1,
): HeadlessDomainExecutorV1 {
  const now = options.now ?? (() => new Date());
  const packages = new PreparedBackgroundCodePackageStoreV1({
    applicationDataRoot: options.applicationDataRoot,
    now,
  });
  const plans = new PreparedBackgroundCodeExecutionPlanStoreV1(
    options.applicationDataRoot,
  );
  return async (job, context) => {
    const handoff = parsePreparedBackgroundCodeActionV1(
      job.preparedBackgroundCodeAction,
    );
    const identity = parsePreparedBackgroundCodePackageIdentityV1(
      job.preparedBackgroundCodePackage,
    );
    const attemptId = backgroundCodeContinuationAttemptIdV1(job.id, handoff);
    const prior = await context.listCommittedReceipts?.() ?? [];
    const reconciliationOnly = hasAmbiguousMarker(prior, attemptId, handoff.fingerprint);
    const requirements: PreparedBackgroundCodePackageRequirementsV1 = {
      packageId: identity.packageId,
      packageFingerprint: identity.packageFingerprint,
      jobId: job.id,
      handoffFingerprint: handoff.fingerprint,
      executionPlanFingerprint: identity.executionPlanFingerprint,
      workspaceId: handoff.binding.workspaceId,
      workspaceBindingFingerprint: handoff.payload.workspaceBindingFingerprint,
      repositoryProfileKey: handoff.binding.repositoryProfileKey,
      repositoryProfileFingerprint: handoff.payload.repositoryProfileFingerprint,
      consumedActionAuthorityFingerprint: handoff.authority.authorityFingerprint,
      backgroundAuthorizationFingerprint: job.authorization.fingerprint,
    };
    const ownerId = `background-code:${job.id}`;
    const lease = await packages.claim({
      requirements,
      ownerId,
      leaseMs: LEASE_MS,
      allowExpiredForReconciliation: reconciliationOnly,
    });
    try {
      const preparedPackage = await packages.loadForWorker({
        requirements,
        ownerId,
        leaseId: lease.leaseId,
        allowExpiredForReconciliation: reconciliationOnly,
      });
      const plan = await plans.load(identity.executionPlanFingerprint, {
        allowExpiredForReconciliation: reconciliationOnly,
      });
      await assertExactLocalPlan(job, plan, preparedPackage, handoff.fingerprint);
      const workspaceManager = new WorkspaceManagerV2({
        applicationDataRoot: options.applicationDataRoot,
        now,
      });
      const manifest = await workspaceManager.loadManifest(plan.checkpoint.request.worktree.id);
      if (
        await workspaceBindingFingerprintV1(manifest) !==
          preparedPackage.workspaceBindingFingerprint ||
        manifest.hashes.indexFingerprint !==
          plan.targetedValidation.action.workspaceManifestFingerprint ||
        manifest.hashes.indexFingerprint !==
          plan.fullValidation.action.workspaceManifestFingerprint
      ) {
        return blocked(
          "prepared_code_workspace_drift",
          "The trusted workspace manifest changed after the deterministic Code package was prepared.",
          "Return to Obsidian, re-read the exact diff, and prepare fresh validation/commit authority.",
        );
      }

      const sandbox = new SandboxManagerV2({
        runner: new SpawnSandboxCommandRunnerV2(),
        providers: plan.sandboxProviders,
        now,
      });
      const liveSandbox = await sandbox.probeProviders(context.signal);
      if (!liveSandbox.executionAvailable || !liveSandbox.selectedProvider) {
        return blocked(
          liveSandbox.blocker?.code ?? "sandbox_provider_unavailable",
          liveSandbox.blocker?.message ?? "No sandbox provider passed its boundary probe.",
          liveSandbox.blocker?.requiredAction ?? "Install or repair an approved sandbox provider.",
        );
      }
      const selected = liveSandbox.providers.find(
        (provider) => provider.provider === liveSandbox.selectedProvider,
      );
      if (
        liveSandbox.selectedProvider !== preparedPackage.sandboxProvider ||
        selected?.probeFingerprint !== preparedPackage.sandboxBoundaryFingerprint ||
        selected.probeFingerprint !== plan.targetedValidation.action.probeFingerprint ||
        selected.probeFingerprint !== plan.fullValidation.action.probeFingerprint
      ) {
        return blocked(
          "sandbox_boundary_probe_failed",
          "The live sandbox boundary no longer matches the exact prepared Code package.",
          "Re-probe the provider in Obsidian and prepare fresh validation/commit authority.",
        );
      }

      const checkpointPersistence = new FileCheckpointNamespacePersistenceV1(
        options.applicationDataRoot,
        plan.checkpoint.id,
      );
      await checkpointPersistence.initialize(plan.checkpoint);
      const checkpointStore = new CallbackCodeRepairCheckpointStoreV1(
        checkpointPersistence,
      );
      const registry = new DurableValidationReceiptRegistryV1(
        new FileValidationReceiptPersistenceV1(
          options.applicationDataRoot,
          plan.jobId,
        ),
        now,
      );
      const git = new SpawnFixedArgvGitRunnerV1();
      const artifactHashReader = new FixedArgvArtifactHashReaderV1(git);
      const proof = new FixedArgvRepairProofAdapterV1({
        workspaceManager,
        git,
        artifactHashReader,
        getProfile: async (profileKey) =>
          profileKey === plan.repositoryProfile.key
            ? plan.repositoryProfile
            : null,
        now,
      });
      const commitGateway = await createFixedArgvVerifiedCommitGatewayV1({
        workspaceManager,
        git,
        artifactHashReader,
        disabledHooksPath: path.join(
          options.applicationDataRoot,
          "background-code-disabled-hooks-v1",
        ),
        now,
      });
      const coordinator = new CodeRepairCoordinatorV1({
        checkpointStore,
        mutator: {
          async applyInitialEdit() { return forbidden("Background Code cannot create an edit."); },
          async applyRepair() { return forbidden("Background Code cannot repair or diagnose code."); },
        },
        diagnoser: {
          async diagnose() { return forbidden("Background Code has no model or diagnosis port."); },
        },
        validator: {
          runValidation: async (input) => {
            if (input.kind !== "targeted" && input.kind !== "full") {
              return forbidden("The host-prepared fast validation is immutable.");
            }
            const step = input.kind === "targeted"
              ? plan.targetedValidation
              : plan.fullValidation;
            return executeValidation({
              operationId: input.operationId,
              plan,
              step,
              sandbox,
              workspaceManager,
              registry,
              signal: context.signal,
            });
          },
        },
        proofReader: proof,
        approvalGateway: {
          async requestApproval() {
            return forbidden("Background Code cannot request or synthesize approval.");
          },
        },
        committer: commitGateway,
        now: () => now().toISOString(),
      });
      const runtime = new BackgroundCodeContinuationRuntimeV1({
        checkpoints: checkpointStore,
        coordinator,
        workspaceManager,
        getRepositoryProfile: async (profileKey) =>
          profileKey === plan.repositoryProfile.key ? plan.repositoryProfile : null,
        // This is the immutable host preparation proof. SandboxManager performs
        // a fresh boundary probe before and during each exact action above.
        readSandboxStatus: () => plan.sandboxCapabilityStatus,
        now,
      });
      return runtime.createExecutor()(job, context);
    } catch (error) {
      return failClosed(error);
    } finally {
      await packages.release({
        packageId: identity.packageId,
        packageFingerprint: identity.packageFingerprint,
        ownerId,
        leaseId: lease.leaseId,
      }).catch(() => undefined);
    }
  };
}

async function executeValidation(input: {
  operationId: string;
  plan: PreparedBackgroundCodeExecutionPlanV1;
  step: PreparedSandboxValidationStepV1;
  sandbox: SandboxManagerV2;
  workspaceManager: WorkspaceManagerV2;
  registry: DurableValidationReceiptRegistryV1;
  signal: AbortSignal;
}): Promise<CodeValidationReceiptV1> {
  const scope = {
    runId: input.plan.checkpoint.request.runId,
    workspaceId: input.plan.checkpoint.request.worktree.id,
    requestId: input.plan.checkpoint.request.id,
  };
  const receiptId = `sandbox-receipt-${input.step.action.payloadFingerprint.slice(7, 31)}`;
  const existing = await input.registry.readValidation({
    receiptId,
    ...scope,
    expectedAction: input.step.action,
  });
  const captured = existing ?? await runAndCaptureValidation(input, scope);
  const evidence = {
    operationId: input.operationId,
    kind: captured.kind,
    sandboxId: captured.sandboxId,
    freshSandbox: true,
    startedAt: captured.startedAt,
    completedAt: captured.completedAt,
    checks: captured.checks,
    status: captured.status,
    failureFingerprint: captured.failureFingerprint,
    binding: captured.binding,
  };
  return {
    version: 1,
    kindName: "code_validation",
    id: input.operationId,
    ...evidence,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

async function runAndCaptureValidation(
  input: Parameters<typeof executeValidation>[0],
  scope: { runId: string; workspaceId: string; requestId: string },
): Promise<CodeValidationReceiptV1> {
  const stagedFiles = await readExactStaging(
    input.workspaceManager,
    input.step.action,
  );
  const result = await input.sandbox.executePrepared(input.step.action, {
    authorization: input.step.authorization,
    stagedFiles,
    signal: input.signal,
  });
  if (result.status === "blocked") {
    throw new StandaloneCodeRuntimeErrorV1(result.blocker.code, result.blocker.message);
  }
  const manifest = await input.workspaceManager.loadManifest(scope.workspaceId);
  return input.registry.capture({
    scope,
    action: input.step.action,
    receipt: result.receipt,
    diagnostics: result.diagnostics,
    validatedWorkspaceManifestFingerprint: manifest.hashes.indexFingerprint,
    workspaceChangedPaths: manifest.budget.changedPaths,
  });
}

async function readExactStaging(
  manager: WorkspaceManagerV2,
  action: PreparedSandboxActionV2,
): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const output: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const entry of action.stagingManifest) {
    const readback = await manager.read(action.workspaceId, entry.path);
    if (readback.sha256 !== entry.sha256 || readback.bytes !== entry.bytes) {
      throw new StandaloneCodeRuntimeErrorV1(
        "sandbox_staging_mismatch",
        `Prepared staged bytes changed for ${entry.path}.`,
      );
    }
    output.push({ path: entry.path, bytes: new TextEncoder().encode(readback.content) });
  }
  return output;
}

async function assertExactLocalPlan(
  job: Readonly<CompanionJobV1>,
  plan: PreparedBackgroundCodeExecutionPlanV1,
  preparedPackage: Awaited<ReturnType<PreparedBackgroundCodePackageStoreV1["load"]>>,
  handoffFingerprint: string,
): Promise<void> {
  if (
    plan.jobId !== job.id ||
    plan.handoffFingerprint !== handoffFingerprint ||
    plan.fingerprint !== preparedPackage.executionPlanFingerprint ||
    plan.checkpoint.id !== preparedPackage.repairCheckpointId ||
    plan.checkpoint.requestFingerprint !== preparedPackage.repairRequestFingerprint ||
    plan.checkpoint.sequence !== preparedPackage.repairCheckpointSequence ||
    plan.checkpoint.stage !== preparedPackage.repairCheckpointStage ||
    plan.checkpoint.request.worktree.id !== preparedPackage.workspaceId ||
    plan.repositoryProfile.key !== preparedPackage.repositoryProfileKey ||
    await sha256Fingerprint(plan.repositoryProfile) !== preparedPackage.repositoryProfileFingerprint ||
    await sha256Fingerprint(plan.sandboxCapabilityStatus) !== preparedPackage.sandboxCapabilityFingerprint
  ) {
    throw new StandaloneCodeRuntimeErrorV1(
      "prepared_code_plan_drift",
      "Local deterministic Code plan does not match its remote-safe package identity.",
    );
  }
}

function hasAmbiguousMarker(
  receipts: CompanionReceiptV1[],
  attemptId: string,
  handoffFingerprint: string,
): boolean {
  return receipts.some((receipt) =>
    receipt.provider === "code" &&
    receipt.operation === PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1 &&
    receipt.status === "ambiguous" &&
    receipt.payload.attemptId === attemptId &&
    receipt.payload.handoffFingerprint === handoffFingerprint
  );
}

class FileCheckpointNamespacePersistenceV1 implements CallbackCheckpointPersistenceV1 {
  private readonly file: SafeCompanionCodeStateFileV1;
  constructor(applicationDataRoot: string, checkpointId: string) {
    this.file = new SafeCompanionCodeStateFileV1({
      applicationDataRoot,
      directory: "background-code-checkpoints-v1",
      fileName: `${safeFileId(checkpointId)}.json`,
    });
  }

  async initialize(checkpoint: CodeRepairCheckpointV1): Promise<void> {
    await this.file.withExclusiveLock(async () => {
      const current = await this.file.readJson<CodeRepairCheckpointNamespaceV1>();
      if (current) return;
      await this.file.writeJsonAtomic({
        version: 1,
        revision: 0,
        checkpoints: { [checkpoint.id]: checkpoint },
      } satisfies CodeRepairCheckpointNamespaceV1);
    });
  }

  readNamespace(): Promise<CodeRepairCheckpointNamespaceV1 | null> {
    return this.file.readJson<CodeRepairCheckpointNamespaceV1>();
  }

  writeNamespace(
    next: CodeRepairCheckpointNamespaceV1,
    expectedRevision: number,
  ): Promise<boolean> {
    return this.file.withExclusiveLock(async () => {
      const current = await this.file.readJson<CodeRepairCheckpointNamespaceV1>();
      if ((current?.revision ?? 0) !== expectedRevision) return false;
      await this.file.writeJsonAtomic(next);
      return true;
    });
  }
}

class FileValidationReceiptPersistenceV1 implements ValidationReceiptPersistenceV1 {
  private readonly file: SafeCompanionCodeStateFileV1;

  constructor(applicationDataRoot: string, jobId: string) {
    this.file = new SafeCompanionCodeStateFileV1({
      applicationDataRoot,
      directory: "background-code-validation-receipts-v1",
      fileName: `${safeFileId(jobId)}.json`,
    });
  }

  async readNamespace(): Promise<DurableValidationReceiptNamespaceV1 | null> {
    return this.file.readJson<DurableValidationReceiptNamespaceV1>();
  }

  async writeNamespace(next: DurableValidationReceiptNamespaceV1, expectedRevision: number): Promise<boolean> {
    return this.file.withExclusiveLock(async () => {
      const current = await this.readNamespace();
      if ((current?.revision ?? 0) !== expectedRevision) return false;
      await this.file.writeJsonAtomic(next);
      return true;
    });
  }
}

function safeFileId(value: string): string {
  return `sha256-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function forbidden(message: string): never {
  throw new StandaloneCodeRuntimeErrorV1("forbidden_background_code_operation", message);
}

function blocked(code: string, message: string, requiredAction: string | null): HeadlessWorkerResultV1 {
  return { status: "blocked", blocker: { code, message, requiredAction } };
}

function failClosed(error: unknown): HeadlessWorkerResultV1 {
  const code = error instanceof StandaloneCodeRuntimeErrorV1
    ? error.code
    : "prepared_code_execution_failed";
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/(?:[A-Za-z]:[\\/]|\/(?!\/))[^\s,;]+/gu, "<TRUSTED_PATH>")
    .slice(0, 1_000);
  return {
    status: code.includes("reconcile") ? "reconcile_required" : "blocked",
    blocker: {
      code,
      message,
      requiredAction: code.includes("reconcile")
        ? null
        : "Return to Obsidian and inspect the exact prepared Code package before retrying.",
    },
  };
}

class StandaloneCodeRuntimeErrorV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StandaloneCodeRuntimeErrorV1";
  }
}
