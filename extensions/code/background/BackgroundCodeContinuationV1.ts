import * as path from "node:path";

import {
  PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1,
  backgroundCodeContinuationAttemptIdV1,
  createPreparedBackgroundCodeActionV1,
  parsePreparedBackgroundCodeActionV1,
  type ConsumedBackgroundCodeGrantV1,
  type PreparedBackgroundCodeActionV1,
} from "../../../packages/core-api/src/preparedBackgroundCodeActionV1";
import {
  buildCompanionReceiptV1,
  type CompanionJobV1,
  type CompanionReceiptV1,
  type HeadlessDomainExecutorV1,
  type HeadlessWorkerContextV1,
  type HeadlessWorkerResultV1,
} from "../../../packages/headless-runtime/src/backgroundContinuation";
import { sha256Fingerprint } from "../../../packages/headless-runtime/src/canonicalize";
import type { RepositoryProfileV2 } from "../repositories";
import type { SandboxCapabilityStatusV2 } from "../sandbox";
import type { WorkspaceManagerV2, WorkspaceManifestV2 } from "../workspaces";
import {
  CodeRepairCoordinatorV1,
  codeRepairCheckpointIdV1,
  type CodeRepairCheckpointStoreV1,
  type CodeRepairCheckpointV1,
  type CodeRepairResultV1,
  type VerifiedLocalCommitReceiptV1,
} from "../repair";

const MAX_REPAIR_CYCLES = 3;
const DEFAULT_LEASE_MS = 15 * 60_000;
const DEFAULT_LEASE_HEARTBEAT_MS = 4 * 60_000;

export interface BackgroundCodeContinuationDependenciesV1 {
  checkpoints: CodeRepairCheckpointStoreV1;
  coordinator: CodeRepairCoordinatorV1;
  workspaceManager: WorkspaceManagerV2;
  getRepositoryProfile(profileKey: string): Promise<RepositoryProfileV2 | null>;
  readSandboxStatus(): SandboxCapabilityStatusV2;
  now?: () => Date;
  leaseDurationMs?: number;
  leaseHeartbeatMs?: number;
}

export interface PrepareBackgroundCodeActionInputV1 {
  missionId: string;
  graphRevision: number;
  capabilityEnvelopeFingerprint: string;
  nodeId: string;
  nodeFingerprint: string;
  executionHost: "companion" | "headless_runtime";
  descriptorFingerprint: string;
  preparedActionId: string;
  preparedActionFingerprint: string;
  destinationFingerprint: string;
  authority: ConsumedBackgroundCodeGrantV1;
  repairCheckpointId: string;
}

interface BoundRepairStateV1 {
  checkpoint: CodeRepairCheckpointV1;
  manifest: WorkspaceManifestV2;
  profile: RepositoryProfileV2;
  sandbox: SandboxCapabilityStatusV2;
  workspaceBindingFingerprint: string;
  repositoryProfileFingerprint: string;
  sandboxCapabilityFingerprint: string;
}

/**
 * Production bridge for one fixed Code continuation. The bridge owns no model
 * loop and accepts no path or command from the companion job. It reloads the
 * exact durable repair request, trusted workspace/profile, and sandbox proof,
 * then delegates the bounded work to CodeRepairCoordinatorV1.
 */
export class BackgroundCodeContinuationRuntimeV1 {
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;
  private readonly leaseHeartbeatMs: number;

  constructor(private readonly dependencies: BackgroundCodeContinuationDependenciesV1) {
    this.now = dependencies.now ?? (() => new Date());
    this.leaseDurationMs = boundedDuration(
      dependencies.leaseDurationMs ?? DEFAULT_LEASE_MS,
      5_000,
      DEFAULT_LEASE_MS,
      "workspace lease duration",
    );
    this.leaseHeartbeatMs = boundedDuration(
      dependencies.leaseHeartbeatMs ?? DEFAULT_LEASE_HEARTBEAT_MS,
      1_000,
      Math.max(1_000, this.leaseDurationMs - 1_000),
      "workspace lease heartbeat",
    );
  }

  /** Host-only preparation after the exact action grant has been consumed. */
  async prepareAction(
    input: PrepareBackgroundCodeActionInputV1,
  ): Promise<PreparedBackgroundCodeActionV1> {
    const state = await this.loadBoundState(input.repairCheckpointId);
    if (state.checkpoint.terminal) {
      throw new BackgroundCodeContinuationErrorV1(
        "checkpoint_terminal",
        "A terminal code repair checkpoint does not need new background authority.",
      );
    }
    const preparedAt = canonicalTimestamp(this.now(), "prepared time");
    if (Date.parse(input.authority.expiresAt) <= Date.parse(preparedAt)) {
      throw new BackgroundCodeContinuationErrorV1(
        "authority_expired",
        "Background Code authority expired before the handoff was prepared.",
      );
    }
    const identity = await sha256Fingerprint({
      version: 1,
      operation: PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1,
      missionId: input.missionId,
      graphRevision: input.graphRevision,
      capabilityEnvelopeFingerprint: input.capabilityEnvelopeFingerprint,
      nodeId: input.nodeId,
      nodeFingerprint: input.nodeFingerprint,
      preparedActionFingerprint: input.preparedActionFingerprint,
      authorityFingerprint: input.authority.authorityFingerprint,
      repairCheckpointId: state.checkpoint.id,
      repairRequestFingerprint: state.checkpoint.requestFingerprint,
      preparedCheckpointSequence: state.checkpoint.sequence,
      workspaceBindingFingerprint: state.workspaceBindingFingerprint,
      repositoryProfileFingerprint: state.repositoryProfileFingerprint,
      sandboxCapabilityFingerprint: state.sandboxCapabilityFingerprint,
    });
    return createPreparedBackgroundCodeActionV1({
      id: `background-code-${identity.slice("sha256:".length, "sha256:".length + 32)}`,
      missionId: input.missionId,
      graphRevision: input.graphRevision,
      capabilityEnvelopeFingerprint: input.capabilityEnvelopeFingerprint,
      nodeId: input.nodeId,
      nodeFingerprint: input.nodeFingerprint,
      executionHost: input.executionHost,
      descriptorFingerprint: input.descriptorFingerprint,
      preparedActionId: input.preparedActionId,
      preparedActionFingerprint: input.preparedActionFingerprint,
      binding: {
        workspaceId: state.manifest.workspaceId,
        repositoryProfileKey: state.profile.key,
        destinationFingerprint: input.destinationFingerprint,
      },
      authority: input.authority,
      payload: {
        repairCheckpointId: state.checkpoint.id,
        repairRequestFingerprint: state.checkpoint.requestFingerprint,
        preparedCheckpointSequence: state.checkpoint.sequence,
        workspaceBindingFingerprint: state.workspaceBindingFingerprint,
        repositoryProfileFingerprint: state.repositoryProfileFingerprint,
        sandboxCapabilityFingerprint: state.sandboxCapabilityFingerprint,
      },
      idempotencyKey: identity,
      reconciliationKey: identity,
      preparedAt,
      expiresAt: input.authority.expiresAt,
    });
  }

  createExecutor(): HeadlessDomainExecutorV1 {
    return (job, context) => this.execute(job, context);
  }

  private async execute(
    job: Readonly<CompanionJobV1>,
    context: HeadlessWorkerContextV1,
  ): Promise<HeadlessWorkerResultV1> {
    const handoff = parsePreparedBackgroundCodeActionV1(
      (job as CompanionJobV1 & { preparedBackgroundCodeAction?: unknown })
        .preparedBackgroundCodeAction,
    );
    assertJobScope(job, handoff);
    if (!context.commitReceipt || !context.listCommittedReceipts) {
      return blocked(
        "receipt_journal_unavailable",
        "Effectful background Code continuation requires the durable companion receipt journal.",
        "Reconnect the authenticated companion with persistent receipt storage.",
      );
    }
    const receipts = await context.listCommittedReceipts();
    const attemptId = backgroundCodeContinuationAttemptIdV1(job.id, handoff);
    const matching = receipts.filter((receipt) => receiptMatches(receipt, handoff, attemptId));
    const state = await this.loadAndValidateHandoffState(handoff);
    const verifiedMarker = matching.find((receipt) => receipt.status === "verified");
    if (verifiedMarker) {
      const refreshed = await this.dependencies.coordinator.execute(
        state.checkpoint.request,
      );
      const verified = requireVerifiedCommit(refreshed.checkpoint);
      assertVerifiedMarker(verifiedMarker, verified);
      return completeResult(verified, verifiedMarker);
    }
    if (state.checkpoint.terminal?.status === "complete") {
      const refreshed = await this.dependencies.coordinator.execute(
        state.checkpoint.request,
      );
      return this.commitVerifiedResult(
        job,
        context,
        handoff,
        attemptId,
        refreshed.checkpoint,
      );
    }
    if (state.checkpoint.terminal?.status === "blocked") {
      return blocked(
        state.checkpoint.blocker?.code ?? "repair_blocked",
        state.checkpoint.blocker?.message ?? "The durable Code repair checkpoint is blocked.",
        "Resolve the durable repair blocker in Obsidian and prepare a new exact action.",
      );
    }

    const ambiguousMarker = matching.find((receipt) => receipt.status === "ambiguous");
    const ambiguousCheckpoint = isAmbiguousCommitCheckpoint(state.checkpoint);
    if (
      Date.parse(handoff.expiresAt) <= context.now().getTime() &&
      !ambiguousMarker &&
      !ambiguousCheckpoint
    ) {
      return blocked(
        "authority_expired",
        "Background Code authority expired before the continuation could start.",
        "Return to Obsidian and approve a fresh exact Code continuation.",
      );
    }

    const dispatchedMarker = matching.find((receipt) => receipt.status === "dispatched");
    if (!dispatchedMarker && !ambiguousMarker) {
      await context.commitReceipt(
        await this.buildReceipt(
          job,
          handoff,
          attemptId,
          ambiguousCheckpoint ? "ambiguous" : "dispatched",
          {
          checkpointSequence: state.checkpoint.sequence,
          repairRequestFingerprint: state.checkpoint.requestFingerprint,
          },
        ),
      );
    }

    const ownerId = `background-code:${job.id}`;
    return this.withWorkspaceLease(
      state.manifest.workspaceId,
      ownerId,
      context.signal,
      async (leaseSignal) => {
        if (ambiguousMarker || ambiguousCheckpoint) {
          return this.reconcileOnly(job, context, handoff, attemptId, leaseSignal);
        }
        try {
          if (leaseSignal.aborted) return { status: "cancelled" };
          const result = await this.dependencies.coordinator.execute(state.checkpoint.request);
          if (result.status === "blocked") {
            return blocked(
              result.blocker?.code ?? "repair_blocked",
              result.blocker?.message ?? "The bounded Code repair was blocked.",
              "Resolve the reported repair blocker and prepare a new exact continuation.",
            );
          }
          return this.commitVerifiedResult(job, context, handoff, attemptId, result.checkpoint);
        } catch (error) {
          const safeMessage = sanitizeMessage(error, [
            state.manifest.canonicalRoot,
            state.profile.repositoryRoot,
          ]);
          const latest = await this.dependencies.checkpoints.load(
            handoff.payload.repairCheckpointId,
          );
          if (latest && isAmbiguousCommitCheckpoint(latest)) {
            await context.commitReceipt!(
              await this.buildReceipt(job, handoff, attemptId, "ambiguous", {
                checkpointSequence: latest.sequence,
                failureFingerprint: await sha256Fingerprint({
                  stage: latest.stage,
                  message: safeMessage,
                }),
              }),
            );
            return {
              status: "reconcile_required",
              blocker: {
                code: "commit_reconcile_required",
                message:
                  "The local commit may have applied; every later attempt is readback-only.",
                requiredAction: null,
              },
            };
          }
          return {
            status: "reconcile_required",
            blocker: {
              code: "code_continuation_interrupted",
              message: safeMessage,
              requiredAction:
                "Resume the same durable checkpoint while its exact authority remains valid.",
            },
          };
        }
      },
    );
  }

  private async reconcileOnly(
    job: Readonly<CompanionJobV1>,
    context: HeadlessWorkerContextV1,
    handoff: PreparedBackgroundCodeActionV1,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<HeadlessWorkerResultV1> {
    if (signal.aborted) return { status: "cancelled" };
    const latest = await this.loadAndValidateHandoffState(handoff);
    if (latest.checkpoint.terminal?.status === "complete") {
      const refreshed = await this.dependencies.coordinator.execute(
        latest.checkpoint.request,
      );
      return this.commitVerifiedResult(
        job,
        context,
        handoff,
        attemptId,
        refreshed.checkpoint,
      );
    }
    if (!isAmbiguousCommitCheckpoint(latest.checkpoint)) {
      return blocked(
        "ambiguous_checkpoint_drift",
        "The checkpoint no longer matches the prepared ambiguous commit state.",
        "Inspect the durable checkpoint in Obsidian before granting new authority.",
      );
    }
    const reconciled = await this.dependencies.coordinator.reconcileAmbiguousCommit(
      latest.checkpoint.request,
    );
    if (reconciled.outcome === "complete") {
      return this.commitVerifiedResult(
        job,
        context,
        handoff,
        attemptId,
        reconciled.result.checkpoint,
      );
    }
    if (reconciled.outcome === "not_applied") {
      return blocked(
        "commit_not_applied",
        "Readback proved that the prepared local commit did not apply; it was not redispatched.",
        "Return to Obsidian and prepare a new repair checkpoint with fresh exact authority.",
      );
    }
    return {
      status: "reconcile_required",
      blocker: {
        code: "commit_reconcile_required",
        message: sanitizeMessage(reconciled.message, [
          latest.manifest.canonicalRoot,
          latest.profile.repositoryRoot,
        ]),
        requiredAction: null,
      },
    };
  }

  private async commitVerifiedResult(
    job: Readonly<CompanionJobV1>,
    context: HeadlessWorkerContextV1,
    handoff: PreparedBackgroundCodeActionV1,
    attemptId: string,
    checkpoint: CodeRepairCheckpointV1,
  ): Promise<HeadlessWorkerResultV1> {
    const verified = requireVerifiedCommit(checkpoint);
    const receipt = await this.buildReceipt(job, handoff, attemptId, "verified", {
      checkpointSequence: checkpoint.sequence,
      verifiedCommitReceiptFingerprint: verified.fingerprint,
      commitSha: verified.commitSha,
      workspaceBindingFingerprint: handoff.payload.workspaceBindingFingerprint,
      repositoryProfileFingerprint: handoff.payload.repositoryProfileFingerprint,
      sandboxCapabilityFingerprint: handoff.payload.sandboxCapabilityFingerprint,
    });
    const committed = await context.commitReceipt!(receipt);
    return completeResult(verified, committed);
  }

  private buildReceipt(
    job: Readonly<CompanionJobV1>,
    handoff: PreparedBackgroundCodeActionV1,
    attemptId: string,
    status: "dispatched" | "ambiguous" | "verified",
    payload: Record<string, string | number>,
  ): Promise<CompanionReceiptV1> {
    return buildCompanionReceiptV1({
      job,
      id: `background-code-${attemptId.slice("sha256:".length, "sha256:".length + 24)}-${status}`,
      provider: "code",
      operation: PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1,
      status,
      payload: {
        attemptId,
        handoffFingerprint: handoff.fingerprint,
        repairCheckpointId: handoff.payload.repairCheckpointId,
        ...payload,
      },
      committedAt: canonicalTimestamp(this.now(), "receipt time"),
    });
  }

  private async loadAndValidateHandoffState(
    handoff: PreparedBackgroundCodeActionV1,
  ): Promise<BoundRepairStateV1> {
    const state = await this.loadBoundState(handoff.payload.repairCheckpointId);
    if (
      state.manifest.workspaceId !== handoff.binding.workspaceId ||
      state.profile.key !== handoff.binding.repositoryProfileKey ||
      state.checkpoint.requestFingerprint !== handoff.payload.repairRequestFingerprint ||
      state.checkpoint.sequence < handoff.payload.preparedCheckpointSequence ||
      state.workspaceBindingFingerprint !== handoff.payload.workspaceBindingFingerprint ||
      state.repositoryProfileFingerprint !== handoff.payload.repositoryProfileFingerprint ||
      state.sandboxCapabilityFingerprint !== handoff.payload.sandboxCapabilityFingerprint
    ) {
      throw new BackgroundCodeContinuationErrorV1(
        "prepared_state_drift",
        "Trusted Code workspace, profile, sandbox, or checkpoint evidence drifted from the prepared action.",
      );
    }
    return state;
  }

  private async loadBoundState(checkpointId: string): Promise<BoundRepairStateV1> {
    const checkpoint = await this.dependencies.checkpoints.load(checkpointId);
    if (!checkpoint || checkpoint.id !== checkpointId) {
      throw new BackgroundCodeContinuationErrorV1(
        "checkpoint_unavailable",
        "The exact durable Code repair checkpoint is unavailable.",
      );
    }
    if (checkpoint.request.maxCycles < 1 || checkpoint.request.maxCycles > MAX_REPAIR_CYCLES) {
      throw new BackgroundCodeContinuationErrorV1(
        "repair_budget_invalid",
        "Background Code repair is limited to three cycles.",
      );
    }
    if (
      checkpoint.id !== codeRepairCheckpointIdV1(checkpoint.request) ||
      checkpoint.requestFingerprint !== await sha256Fingerprint(checkpoint.request)
    ) {
      throw new BackgroundCodeContinuationErrorV1(
        "checkpoint_fingerprint_invalid",
        "The durable Code repair checkpoint request fingerprint is invalid.",
      );
    }
    const manifest = await this.dependencies.workspaceManager.loadManifest(
      checkpoint.request.worktree.id,
    );
    const profile = await this.dependencies.getRepositoryProfile(
      checkpoint.request.worktree.profileId,
    );
    if (!profile) {
      throw new BackgroundCodeContinuationErrorV1(
        "profile_unavailable",
        "The trusted repository profile is unavailable.",
      );
    }
    assertTrustedBinding(checkpoint, manifest, profile);
    const sandbox = this.dependencies.readSandboxStatus();
    if (
      sandbox.mode !== "sandbox_verified" ||
      sandbox.executionAvailable !== true ||
      !sandbox.selectedProvider ||
      sandbox.blocker !== null
    ) {
      throw new BackgroundCodeContinuationErrorV1(
        "sandbox_unavailable",
        "Background Code execution is blocked because no sandbox passed its boundary probe.",
      );
    }
    return {
      checkpoint,
      manifest,
      profile,
      sandbox,
      workspaceBindingFingerprint: await workspaceBindingFingerprintV1(manifest),
      repositoryProfileFingerprint: await sha256Fingerprint(profile),
      sandboxCapabilityFingerprint: await sha256Fingerprint(sandbox),
    };
  }

  private async withWorkspaceLease(
    workspaceId: string,
    ownerId: string,
    parentSignal: AbortSignal,
    run: (signal: AbortSignal) => Promise<HeadlessWorkerResultV1>,
  ): Promise<HeadlessWorkerResultV1> {
    let manifest = await this.dependencies.workspaceManager.acquireLease(
      workspaceId,
      ownerId,
      this.leaseDurationMs,
    );
    if (!manifest.lease || manifest.lease.ownerId !== ownerId) {
      throw new BackgroundCodeContinuationErrorV1(
        "workspace_lease_conflict",
        "The exact trusted workspace resource lock could not be acquired.",
      );
    }
    manifest = await this.dependencies.workspaceManager.renewLease(
      workspaceId,
      manifest.lease.id,
      this.leaseDurationMs,
    );
    const leaseId = manifest.lease!.id;
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    let heartbeatFailure: unknown = null;
    let heartbeatChain = Promise.resolve();
    const timer = globalThis.setInterval(() => {
      heartbeatChain = heartbeatChain
        .then(async () => {
          if (controller.signal.aborted || heartbeatFailure) return;
          await this.dependencies.workspaceManager.renewLease(
            workspaceId,
            leaseId,
            this.leaseDurationMs,
          );
        })
        .catch((error) => {
          heartbeatFailure = error;
          controller.abort(error);
        });
    }, this.leaseHeartbeatMs);
    try {
      const result = await run(controller.signal);
      globalThis.clearInterval(timer);
      await heartbeatChain;
      if (heartbeatFailure) {
        return {
          status: "reconcile_required",
          blocker: {
            code: "workspace_lease_lost",
            message: "The workspace resource lock was lost during Code continuation.",
            requiredAction: "Reconcile the durable checkpoint before any new mutation.",
          },
        };
      }
      return result;
    } finally {
      globalThis.clearInterval(timer);
      parentSignal.removeEventListener("abort", abort);
      await heartbeatChain.catch(() => undefined);
      await this.dependencies.workspaceManager.releaseLease(workspaceId, leaseId).catch(() => undefined);
    }
  }
}

export class BackgroundCodeContinuationErrorV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BackgroundCodeContinuationErrorV1";
  }
}

export async function workspaceBindingFingerprintV1(
  manifest: WorkspaceManifestV2,
): Promise<string> {
  return sha256Fingerprint({
    version: 1,
    workspaceId: manifest.workspaceId,
    kind: manifest.kind,
    ownerRunId: manifest.ownerRunId,
    canonicalRoot: manifest.canonicalRoot,
    baseSha: manifest.baseSha,
    repositoryBinding: manifest.repositoryBinding,
    sandboxPolicy: manifest.sandboxPolicy,
  });
}

function assertJobScope(
  job: Readonly<CompanionJobV1>,
  handoff: PreparedBackgroundCodeActionV1,
): void {
  const binding = job.bindings.find(
    (candidate) =>
      candidate.id === handoff.binding.workspaceId &&
      candidate.destinationFingerprint === handoff.binding.destinationFingerprint,
  );
  if (
    job.domain !== "code" ||
    job.missionId !== handoff.missionId ||
    job.nodeId !== handoff.nodeId ||
    job.graphRevision !== handoff.graphRevision ||
    job.capabilityEnvelopeFingerprint !== handoff.capabilityEnvelopeFingerprint ||
    job.executionHost !== handoff.executionHost ||
    job.preparedExternalActionHandoff != null ||
    Object.keys(job.inputs).length !== 0 ||
    job.allowedTools.length !== 1 ||
    job.allowedTools[0] !== "code_validate_commit_prepared" ||
    job.bindings.length !== 1 ||
    job.requiredCapabilities.some((capability) => /vault|obsidian|note[._:-]?write/iu.test(capability)) ||
    !binding ||
    !["repository", "repository-workspace", "code-workspace"].includes(binding.kind)
  ) {
    throw new BackgroundCodeContinuationErrorV1(
      "job_scope_drift",
      "Prepared background Code action drifted from its exact companion job scope.",
    );
  }
}

function assertTrustedBinding(
  checkpoint: CodeRepairCheckpointV1,
  manifest: WorkspaceManifestV2,
  profile: RepositoryProfileV2,
): void {
  const request = checkpoint.request;
  const binding = manifest.repositoryBinding;
  if (
    manifest.kind !== "repository" ||
    !binding ||
    manifest.ownerRunId !== request.runId ||
    manifest.workspaceId !== request.worktree.id ||
    manifest.baseSha !== request.worktree.baseSha ||
    binding.profileKey !== request.worktree.profileId ||
    binding.branch !== request.worktree.branch ||
    profile.key !== request.worktree.profileId ||
    !sameLocalPath(manifest.canonicalRoot, request.worktree.path) ||
    !sameLocalPath(binding.worktreeRoot, request.worktree.path) ||
    !sameLocalPath(binding.repositoryRoot, request.worktree.repositoryRoot) ||
    !sameLocalPath(profile.repositoryRoot, request.worktree.repositoryRoot)
  ) {
    throw new BackgroundCodeContinuationErrorV1(
      "trusted_binding_mismatch",
      "Repair checkpoint no longer matches its exact trusted repository workspace and profile.",
    );
  }
}

function isAmbiguousCommitCheckpoint(checkpoint: CodeRepairCheckpointV1): boolean {
  return checkpoint.stage === "committing" && !checkpoint.commit && !checkpoint.terminal;
}

function requireVerifiedCommit(checkpoint: CodeRepairCheckpointV1): VerifiedLocalCommitReceiptV1 {
  if (
    checkpoint.terminal?.status !== "complete" ||
    checkpoint.terminal.publicationEligible !== true ||
    checkpoint.stage !== "complete" ||
    checkpoint.verifiedCommitReceipt?.status !== "verified"
  ) {
    throw new BackgroundCodeContinuationErrorV1(
      "verified_commit_missing",
      "Code continuation completed without a readback-verified local commit receipt.",
    );
  }
  return checkpoint.verifiedCommitReceipt;
}

function receiptMatches(
  receipt: CompanionReceiptV1,
  handoff: PreparedBackgroundCodeActionV1,
  attemptId: string,
): boolean {
  return (
    receipt.provider === "code" &&
    receipt.operation === PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1 &&
    receipt.payload.attemptId === attemptId &&
    receipt.payload.handoffFingerprint === handoff.fingerprint &&
    receipt.payload.repairCheckpointId === handoff.payload.repairCheckpointId
  );
}

function assertVerifiedMarker(
  receipt: CompanionReceiptV1,
  verified: VerifiedLocalCommitReceiptV1,
): void {
  if (
    receipt.payload.verifiedCommitReceiptFingerprint !== verified.fingerprint ||
    receipt.payload.commitSha !== verified.commitSha
  ) {
    throw new BackgroundCodeContinuationErrorV1(
      "verified_receipt_drift",
      "Companion Code receipt drifted from the durable verified commit.",
    );
  }
}

function completeResult(
  verified: VerifiedLocalCommitReceiptV1,
  receipt: CompanionReceiptV1,
): HeadlessWorkerResultV1 {
  return {
    status: "complete",
    outputs: {
      repairRequestId: verified.requestId,
      workspaceId: verified.workspaceId,
      commitSha: verified.commitSha,
      verifiedCommitReceiptFingerprint: verified.fingerprint,
    },
    evidence: [
      {
        kind: "verified_local_commit",
        fingerprint: verified.fingerprint,
        commitSha: verified.commitSha,
      },
    ],
    receipts: [receipt],
  };
}

function blocked(
  code: string,
  message: string,
  requiredAction: string | null,
): HeadlessWorkerResultV1 {
  return { status: "blocked", blocker: { code, message, requiredAction } };
}

function sameLocalPath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    path.resolve(value).replace(/[\\/]+$/u, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function boundedDuration(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BackgroundCodeContinuationErrorV1(
      "invalid_configuration",
      `${label} is outside its safe bound.`,
    );
  }
  return value;
}

function canonicalTimestamp(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new BackgroundCodeContinuationErrorV1("invalid_time", `${label} is invalid.`);
  }
  return value.toISOString();
}

function sanitizeMessage(error: unknown, boundaries: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error || "Background Code continuation failed.");
  for (const boundary of boundaries.filter(Boolean).sort((left, right) => right.length - left.length)) {
    message = message.split(boundary).join("<TRUSTED_BOUNDARY>");
    message = message.split(boundary.replace(/\\/gu, "/")).join("<TRUSTED_BOUNDARY>");
    message = message.split(boundary.replace(/\//gu, "\\")).join("<TRUSTED_BOUNDARY>");
  }
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(
      /(token|secret|password|authorization|cookie|credential|api[_-]?key)\s*[=:]\s*\S+/giu,
      "$1=[REDACTED]",
    )
    .slice(0, 1_000);
}
