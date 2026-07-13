import {
  GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
  GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1,
  GITHUB_PULL_REQUEST_MERGE_OPERATION_V1,
  GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1,
  GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1,
  backgroundGitHubActionAttemptIdV1,
  backgroundGitHubTargetFingerprintV1,
  fingerprintBackgroundGitHubValueV1,
  parsePreparedBackgroundGitHubActionV1,
  type PreparedBackgroundGitHubActionV1,
} from "../../../packages/core-api/src/preparedBackgroundGitHubActionV1";
import type { HostApprovalReceiptV1 } from "../../../packages/core-api/src/hostApprovalReceiptV1";
import {
  createBackgroundGitHubVerifiedResultV1,
  type BackgroundGitHubVerifiedResultV1,
} from "../../../packages/core-api/src/backgroundGitHubVerifiedResultV1";
import {
  createPendingExternalActionStateV2,
  type PendingExternalActionStateV2,
} from "../../../src/integrations/PendingExternalActionStateV2";
import {
  GitHubPublicationWorkflowV1,
  type GitHubPublicationApprovalPortV1,
  type GitHubPublicationCheckpointV1,
  type GitHubPublicationHandoffV1,
  type TrustedGitHubPublicationBindingV1,
} from "../../../src/integrations/github/GitHubPublicationWorkflow";
import {
  VerifiedGitPushGatewayV1,
  type VerifiedGitPushResultV1,
} from "../../../src/integrations/github/VerifiedGitPushGateway";
import type { TrustedGitHubRepositoryBindingV1 } from "../../../src/integrations/github/TrustedGitHubRepositoryBindingV1";
import {
  type BackgroundGitHubActionAttemptStoreV1,
  type BackgroundGitHubActionAttemptV1,
} from "./BackgroundGitHubAttemptStoreV1";
import {
  parsePreparedBackgroundGitHubPackageV1,
  type BackgroundGitHubRepositoryProofV1,
  type PreparedBackgroundGitHubPackageV1,
} from "./PreparedBackgroundGitHubPackageStoreV1";

export interface BackgroundGitHubVerifiedAccountV1 {
  id: number;
  login: string;
}

/** Credential implementation must lease the opaque SecretStoreV1 reference and call /user. */
export interface BackgroundGitHubAccountVerifierV1 {
  verify(
    credentialReferenceId: string,
    signal?: AbortSignal,
  ): Promise<BackgroundGitHubVerifiedAccountV1>;
}

/** Fixed, credential-bound remote-head read. It exposes no arbitrary API transport. */
export interface BackgroundGitHubRemoteHeadReaderV1 {
  read(input: {
    credentialReferenceId: string;
    owner: string;
    repository: string;
    branch: string;
    signal?: AbortSignal;
  }): Promise<string | null>;
}

/**
 * Verifies the receipt authenticator against an independently trusted host
 * signing key. The package's embedded signing-key fingerprint is not itself a
 * trust anchor.
 */
export interface BackgroundGitHubHostApprovalReceiptVerifierV1 {
  verify(receipt: HostApprovalReceiptV1, signal?: AbortSignal): Promise<boolean>;
}

export interface BackgroundGitHubWorkflowRuntimeV1 {
  workflow: GitHubPublicationWorkflowV1;
  /** Current companion-owned checkpoint, or the immutable package snapshot on first use. */
  checkpoint: GitHubPublicationCheckpointV1;
  /** Background factories must never attach Linear or vault finalizers. */
  finalizers: "disabled_until_core_reconnect";
}

export interface BackgroundGitHubWorkflowFactoryV1 {
  create(input: {
    package: PreparedBackgroundGitHubPackageV1;
    binding: TrustedGitHubPublicationBindingV1;
    approvals: GitHubPublicationApprovalPortV1;
  }): Promise<BackgroundGitHubWorkflowRuntimeV1>;
}

export interface BackgroundGitHubAutoMergeReadbackV1 {
  enabled: boolean;
  pullRequestNumber: number;
  headSha: string;
  baseBranch: string;
  mergeMethod: "squash" | "merge" | "rebase";
  proofSnapshotFingerprint: string;
  observedAt: string;
  readbackFingerprint: string;
}

export type BackgroundGitHubAutoMergeEffectResultV1 =
  | { status: "verified"; readback: BackgroundGitHubAutoMergeReadbackV1 }
  | { status: "reconcile_required"; message: string }
  | { status: "not_applied"; message: string };

/** Fixed provider mutation; implementation owns GraphQL shape and secure credential lease. */
export interface BackgroundGitHubAutoMergePortV1 {
  enable(input: {
    credentialReferenceId: string;
    binding: TrustedGitHubPublicationBindingV1;
    checkpoint: GitHubPublicationCheckpointV1;
    approvalFingerprint: string;
    signal?: AbortSignal;
  }): Promise<BackgroundGitHubAutoMergeEffectResultV1>;
  /** Readback only. It must not call the enable mutation. */
  reconcile(input: {
    credentialReferenceId: string;
    binding: TrustedGitHubPublicationBindingV1;
    checkpoint: GitHubPublicationCheckpointV1;
    approvalFingerprint: string;
    signal?: AbortSignal;
  }): Promise<BackgroundGitHubAutoMergeEffectResultV1>;
}

export interface BackgroundGitHubContinuationDependenciesV1 {
  attempts: BackgroundGitHubActionAttemptStoreV1;
  pushGateway: VerifiedGitPushGatewayV1;
  accountVerifier: BackgroundGitHubAccountVerifierV1;
  remoteHeads: BackgroundGitHubRemoteHeadReaderV1;
  workflows: BackgroundGitHubWorkflowFactoryV1;
  autoMerge: BackgroundGitHubAutoMergePortV1;
  approvalReceipts: BackgroundGitHubHostApprovalReceiptVerifierV1;
  now?: () => Date;
}

export type BackgroundGitHubContinuationResultV1 =
  | { status: "verified"; proof: BackgroundGitHubVerifiedResultV1 }
  | { status: "reconcile_required"; attempt: BackgroundGitHubActionAttemptV1; message: string }
  | { status: "not_applied"; attempt: BackgroundGitHubActionAttemptV1; message: string }
  | { status: "blocked"; attempt?: BackgroundGitHubActionAttemptV1; message: string };

export class BackgroundGitHubContinuationErrorV1 extends Error {
  constructor(
    readonly code:
      | "invalid_package"
      | "authority_expired"
      | "authority_drift"
      | "repository_drift"
      | "checkpoint_drift"
      | "attempt_store_conflict",
    message: string,
  ) {
    super(message);
    this.name = "BackgroundGitHubContinuationErrorV1";
  }
}

/**
 * Executes one already-authorized GitHub action from a companion-owned package.
 * A durable uncertain-dispatch WAL entry is saved before every first provider
 * mutation. Once that marker exists, every future invocation is readback-only.
 */
export class BackgroundGitHubContinuationRuntimeV1 {
  private readonly now: () => Date;

  constructor(private readonly dependencies: BackgroundGitHubContinuationDependenciesV1) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(input: {
    jobId: string;
    package: PreparedBackgroundGitHubPackageV1;
    signal?: AbortSignal;
  }): Promise<BackgroundGitHubContinuationResultV1> {
    const preparedPackage = parsePreparedBackgroundGitHubPackageV1(input.package);
    const action = parsePreparedBackgroundGitHubActionV1(preparedPackage.action);
    if (preparedPackage.jobId !== input.jobId) {
      throw new BackgroundGitHubContinuationErrorV1(
        "invalid_package",
        "Prepared background GitHub package belongs to a different companion job.",
      );
    }
    await this.verifyHostApprovalReceipts(action, input.signal);
    const attemptId = backgroundGitHubActionAttemptIdV1(input.jobId, action);
    const prior = await this.dependencies.attempts.load(attemptId);
    if (prior) {
      assertAttemptScope(prior, input.jobId, action);
      if (prior.status === "verified" && prior.result) {
        return { status: "verified", proof: prior.result };
      }
      if (prior.status === "not_applied") {
        return { status: "not_applied", attempt: prior, message: prior.diagnostic ?? "GitHub readback proved the action was not applied." };
      }
      if (prior.status === "blocked") {
        return { status: "blocked", attempt: prior, message: prior.diagnostic ?? "Background GitHub action is blocked." };
      }
      return this.reconcile(preparedPackage, prior, input.signal);
    }
    if (Date.parse(action.expiresAt) <= this.now().getTime()) {
      return { status: "blocked", message: "Background GitHub authority expired before provider dispatch." };
    }
    await this.verifyFreshAccount(action, input.signal);
    await this.preflightExactState(preparedPackage, input.signal);

    const targetFingerprint = backgroundGitHubTargetFingerprintV1(action);
    const dispatchedAt = this.now().toISOString();
    const pendingAction = createPending(action, targetFingerprint, dispatchedAt);
    const attempt: BackgroundGitHubActionAttemptV1 = {
      version: 1,
      id: attemptId,
      revision: 0,
      jobId: input.jobId,
      actionFingerprint: action.fingerprint,
      preparedActionFingerprint: action.preparedActionFingerprint,
      operation: action.operation,
      publicationId: action.payload.publicationId,
      repositoryBindingFingerprint: action.binding.repositoryBindingFingerprint,
      targetFingerprint,
      status: "dispatching",
      dispatchCount: 1,
      startedAt: dispatchedAt,
      updatedAt: dispatchedAt,
      pendingAction,
      result: null,
      diagnostic: null,
    };
    if (!(await this.dependencies.attempts.save(attempt, null))) {
      const concurrent = await this.dependencies.attempts.load(attemptId);
      if (!concurrent) {
        throw new BackgroundGitHubContinuationErrorV1(
          "attempt_store_conflict",
          "Background GitHub provider WAL could not be claimed durably.",
        );
      }
      assertAttemptScope(concurrent, input.jobId, action);
      return this.reconcile(preparedPackage, concurrent, input.signal);
    }

    try {
      return await this.dispatch(preparedPackage, attempt, input.signal);
    } catch (error) {
      return this.markReconcileRequired(attempt, safeDiagnostic(error));
    }
  }

  private async dispatch(
    preparedPackage: PreparedBackgroundGitHubPackageV1,
    attempt: BackgroundGitHubActionAttemptV1,
    signal?: AbortSignal,
  ): Promise<BackgroundGitHubContinuationResultV1> {
    const action = preparedPackage.action;
    if (action.operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1) {
      const handoff = preparedPackage.localPlan.verifiedCodeHandoff!;
      const pushed = await this.dependencies.pushGateway.push({
        handoff,
        binding: preparedPackage.localPlan.repositoryBinding,
        profile: publicationProof(preparedPackage.localPlan.repositoryProof),
        credentialReferenceId: action.binding.credentialReferenceId,
        signal,
      });
      return this.acceptPushResult(preparedPackage, attempt, pushed);
    }

    const binding = publicationBinding(preparedPackage);
    const approvals = new ExactConsumedGitHubApprovalPortV1(action);
    const runtime = await this.dependencies.workflows.create({
      package: preparedPackage,
      binding,
      approvals,
    });
    assertWorkflowRuntime(runtime, preparedPackage, false);

    if (action.operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) {
      const document = preparedPackage.localPlan.pullRequestDocument!;
      const checkpoint = await runtime.workflow.resumeDraftPublication(runtime.checkpoint, {
        title: document.title,
        body: document.body,
        binding,
        signal,
      });
      return this.acceptDraftCheckpoint(preparedPackage, attempt, checkpoint);
    }
    if (action.operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1) {
      const result = await runtime.workflow.publishVerifiedReviewRepairFastForward({
        repairId: action.payload.repairId,
        checkpoint: runtime.checkpoint,
        binding,
        pullRequestNumber: action.payload.pullRequestNumber,
        expectedRemoteHeadSha: action.payload.expectedOldHeadSha,
        previousHandoffFingerprint: action.payload.previousHandoffFingerprint,
        handoff: publicationHandoff(preparedPackage),
        signal,
      });
      if (result.status === "verified") {
        return this.acceptReviewRepairCheckpoint(preparedPackage, attempt, result.checkpoint);
      }
      if (result.status === "approval_denied") {
        return this.markBlocked(attempt, result.message);
      }
      return this.markReconcileRequired(attempt, result.message);
    }
    if (action.operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1) {
      const checkpoint = await runtime.workflow.merge(runtime.checkpoint, binding, signal);
      return this.acceptMergeCheckpoint(preparedPackage, attempt, checkpoint);
    }
    const result = await this.dependencies.autoMerge.enable({
      credentialReferenceId: action.binding.credentialReferenceId,
      binding,
      checkpoint: runtime.checkpoint,
      approvalFingerprint: action.payload.workflowApprovalFingerprint,
      signal,
    });
    return this.acceptAutoMergeResult(preparedPackage, attempt, result);
  }

  private async reconcile(
    preparedPackage: PreparedBackgroundGitHubPackageV1,
    attempt: BackgroundGitHubActionAttemptV1,
    signal?: AbortSignal,
  ): Promise<BackgroundGitHubContinuationResultV1> {
    const action = preparedPackage.action;
    await this.verifyFreshAccount(action, signal);
    try {
      if (action.operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1) {
        const reconciled = await this.dependencies.pushGateway.reconcile({
          handoff: preparedPackage.localPlan.verifiedCodeHandoff!,
          binding: preparedPackage.localPlan.repositoryBinding,
          profile: publicationProof(preparedPackage.localPlan.repositoryProof),
          credentialReferenceId: action.binding.credentialReferenceId,
          signal,
        });
        return this.acceptPushResult(preparedPackage, attempt, reconciled);
      }
      const binding = publicationBinding(preparedPackage);
      const runtime = await this.dependencies.workflows.create({
        package: preparedPackage,
        binding,
        approvals: new ExactConsumedGitHubApprovalPortV1(action),
      });
      assertWorkflowRuntime(runtime, preparedPackage, true);
      if (action.operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) {
        const checkpoint = await runtime.workflow.reconcile(runtime.checkpoint, binding, signal);
        return this.acceptDraftCheckpoint(preparedPackage, attempt, checkpoint);
      }
      if (action.operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1) {
        const result = await runtime.workflow.reconcileVerifiedReviewRepairFastForward({
          repairId: action.payload.repairId,
          checkpoint: runtime.checkpoint,
          binding,
          pullRequestNumber: action.payload.pullRequestNumber,
          expectedOldHeadSha: action.payload.expectedOldHeadSha,
          handoff: publicationHandoff(preparedPackage),
          signal,
        });
        return result.status === "verified"
          ? this.acceptReviewRepairCheckpoint(preparedPackage, attempt, result.checkpoint)
          : this.markReconcileRequired(attempt, result.message);
      }
      if (action.operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1) {
        const checkpoint = await runtime.workflow.reconcile(runtime.checkpoint, binding, signal);
        return this.acceptMergeCheckpoint(preparedPackage, attempt, checkpoint);
      }
      const autoMerge = await this.dependencies.autoMerge.reconcile({
        credentialReferenceId: action.binding.credentialReferenceId,
        binding,
        checkpoint: runtime.checkpoint,
        approvalFingerprint: action.payload.workflowApprovalFingerprint,
        signal,
      });
      return this.acceptAutoMergeResult(preparedPackage, attempt, autoMerge);
    } catch (error) {
      return this.markReconcileRequired(attempt, safeDiagnostic(error));
    }
  }

  private async verifyFreshAccount(
    action: PreparedBackgroundGitHubActionV1,
    signal?: AbortSignal,
  ): Promise<void> {
    const account = await this.dependencies.accountVerifier.verify(
      action.binding.credentialReferenceId,
      signal,
    );
    if (
      account.id !== action.binding.verifiedAccountId ||
      account.login !== action.binding.verifiedAccountLogin
    ) {
      throw new BackgroundGitHubContinuationErrorV1(
        "repository_drift",
        "Secure GitHub credential account readback no longer matches the approved account.",
      );
    }
  }

  private async preflightExactState(
    preparedPackage: PreparedBackgroundGitHubPackageV1,
    signal?: AbortSignal,
  ): Promise<void> {
    const action = preparedPackage.action;
    if (action.operation !== GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1) return;
    const remote = await this.dependencies.remoteHeads.read({
      credentialReferenceId: action.binding.credentialReferenceId,
      owner: action.binding.owner,
      repository: action.binding.repository,
      branch: action.payload.branch,
      signal,
    });
    if (remote !== action.payload.expectedRemoteSha) {
      throw new BackgroundGitHubContinuationErrorV1(
        "repository_drift",
        "Remote branch head changed after the exact GitHub action was approved.",
      );
    }
  }

  private acceptPushResult(
    preparedPackage: PreparedBackgroundGitHubPackageV1,
    attempt: BackgroundGitHubActionAttemptV1,
    result: VerifiedGitPushResultV1,
  ): Promise<BackgroundGitHubContinuationResultV1> {
    if (result.status === "reconcile_required") {
      return this.markReconcileRequired(attempt, result.message);
    }
    if (result.status === "not_applied") {
      return this.markNotApplied(attempt, result.message);
    }
    const action = preparedPackage.action;
    if (
      action.operation !== GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1 ||
      result.receipt.remoteSha !== action.payload.headSha ||
      result.receipt.branch !== action.payload.branch ||
      result.receipt.repositoryBindingFingerprint !== action.binding.repositoryBindingFingerprint ||
      result.receipt.beforeRemoteSha !== action.payload.expectedRemoteSha
    ) {
      return this.markReconcileRequired(
        attempt,
        "Verified Git push receipt did not match the exact approved remote transition.",
      );
    }
    return this.markVerified(attempt, createProof(preparedPackage, {
      checkpointFingerprint: fingerprintBackgroundGitHubValueV1({
        checkpoint: action.payload.checkpointFingerprint,
        pushReceipt: result.receipt.fingerprint,
      }),
      headSha: result.receipt.remoteSha,
      pullRequestNumber: null,
      mergeSha: null,
      autoMergeEnabled: false,
    }, this.now().toISOString()));
  }

  private acceptDraftCheckpoint(
    preparedPackage: PreparedBackgroundGitHubPackageV1,
    attempt: BackgroundGitHubActionAttemptV1,
    checkpoint: GitHubPublicationCheckpointV1,
  ): Promise<BackgroundGitHubContinuationResultV1> {
    const action = preparedPackage.action;
    if (action.operation !== GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) {
      return this.markBlocked(attempt, "Draft checkpoint was returned for the wrong operation.");
    }
    if (checkpoint.status === "reconcile_required") {
      return this.markReconcileRequired(attempt, checkpoint.blocker?.message ?? "Draft PR readback remains ambiguous.");
    }
    const pr = checkpoint.pullRequest;
    if (
      checkpoint.status === "blocked" ||
      !pr ||
      pr.state !== "open" ||
      !pr.draft ||
      pr.merged ||
      pr.head.ref !== action.payload.branch ||
      pr.head.sha !== action.payload.headSha ||
      pr.base.ref !== action.payload.baseBranch ||
      checkpoint.remoteSha !== action.payload.headSha
    ) {
      return this.markNotApplied(attempt, checkpoint.blocker?.message ?? "Draft PR readback did not match the approved head and base.");
    }
    return this.markVerified(attempt, createProof(preparedPackage, {
      checkpointFingerprint: fingerprintBackgroundGitHubValueV1(checkpoint),
      headSha: pr.head.sha,
      pullRequestNumber: pr.number,
      mergeSha: null,
      autoMergeEnabled: false,
    }, this.now().toISOString()));
  }

  private acceptReviewRepairCheckpoint(
    preparedPackage: PreparedBackgroundGitHubPackageV1,
    attempt: BackgroundGitHubActionAttemptV1,
    checkpoint: GitHubPublicationCheckpointV1,
  ): Promise<BackgroundGitHubContinuationResultV1> {
    const action = preparedPackage.action;
    if (action.operation !== GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1) {
      return this.markBlocked(attempt, "Review-repair checkpoint was returned for the wrong operation.");
    }
    const pr = checkpoint.pullRequest;
    if (
      !pr ||
      checkpoint.status !== "draft_pr_verified" ||
      checkpoint.headSha !== action.payload.newHeadSha ||
      checkpoint.remoteSha !== action.payload.newHeadSha ||
      pr.number !== action.payload.pullRequestNumber ||
      pr.head.ref !== action.payload.branch ||
      pr.head.sha !== action.payload.newHeadSha ||
      pr.base.ref !== action.payload.baseBranch
    ) {
      return this.markReconcileRequired(attempt, "Review-repair branch or PR readback has not converged to the exact new head.");
    }
    return this.markVerified(attempt, createProof(preparedPackage, {
      checkpointFingerprint: fingerprintBackgroundGitHubValueV1(checkpoint),
      headSha: pr.head.sha,
      pullRequestNumber: pr.number,
      mergeSha: null,
      autoMergeEnabled: false,
    }, this.now().toISOString()));
  }

  private acceptMergeCheckpoint(
    preparedPackage: PreparedBackgroundGitHubPackageV1,
    attempt: BackgroundGitHubActionAttemptV1,
    checkpoint: GitHubPublicationCheckpointV1,
  ): Promise<BackgroundGitHubContinuationResultV1> {
    const action = preparedPackage.action;
    if (action.operation !== GITHUB_PULL_REQUEST_MERGE_OPERATION_V1) {
      return this.markBlocked(attempt, "Merge checkpoint was returned for the wrong operation.");
    }
    if (checkpoint.status === "reconcile_required") {
      return this.markReconcileRequired(attempt, checkpoint.blocker?.message ?? "Merge readback remains ambiguous.");
    }
    const pr = checkpoint.pullRequest;
    if (
      checkpoint.status !== "merged_verified" ||
      !pr?.merged ||
      pr.number !== action.payload.pullRequestNumber ||
      pr.head.sha !== action.payload.headSha ||
      pr.head.ref !== action.payload.branch ||
      pr.base.ref !== action.payload.baseBranch ||
      !checkpoint.mergeSha ||
      checkpoint.mergeApprovalFingerprint !== action.payload.workflowApprovalFingerprint
    ) {
      return this.markNotApplied(attempt, checkpoint.blocker?.message ?? "Merge readback did not prove the exact approved PR head.");
    }
    return this.markVerified(attempt, createProof(preparedPackage, {
      checkpointFingerprint: fingerprintBackgroundGitHubValueV1(checkpoint),
      headSha: pr.head.sha,
      pullRequestNumber: pr.number,
      mergeSha: checkpoint.mergeSha,
      autoMergeEnabled: false,
    }, this.now().toISOString()));
  }

  private acceptAutoMergeResult(
    preparedPackage: PreparedBackgroundGitHubPackageV1,
    attempt: BackgroundGitHubActionAttemptV1,
    result: BackgroundGitHubAutoMergeEffectResultV1,
  ): Promise<BackgroundGitHubContinuationResultV1> {
    if (result.status === "reconcile_required") return this.markReconcileRequired(attempt, result.message);
    if (result.status === "not_applied") return this.markNotApplied(attempt, result.message);
    const action = preparedPackage.action;
    if (
      action.operation !== GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1 ||
      !result.readback.enabled ||
      result.readback.pullRequestNumber !== action.payload.pullRequestNumber ||
      result.readback.headSha !== action.payload.headSha ||
      result.readback.baseBranch !== action.payload.baseBranch ||
      result.readback.mergeMethod !== action.payload.mergeMethod ||
      result.readback.proofSnapshotFingerprint !== action.payload.proofSnapshotFingerprint ||
      result.readback.readbackFingerprint !== fingerprintBackgroundGitHubValueV1({
        enabled: result.readback.enabled,
        pullRequestNumber: result.readback.pullRequestNumber,
        headSha: result.readback.headSha,
        baseBranch: result.readback.baseBranch,
        mergeMethod: result.readback.mergeMethod,
        proofSnapshotFingerprint: result.readback.proofSnapshotFingerprint,
        observedAt: result.readback.observedAt,
      })
    ) {
      return this.markReconcileRequired(attempt, "Auto-merge readback drifted from the double-approved PR proof.");
    }
    return this.markVerified(attempt, createProof(preparedPackage, {
      checkpointFingerprint: fingerprintBackgroundGitHubValueV1({
        checkpoint: action.payload.checkpointFingerprint,
        autoMergeReadback: result.readback.readbackFingerprint,
      }),
      headSha: result.readback.headSha,
      pullRequestNumber: result.readback.pullRequestNumber,
      mergeSha: null,
      autoMergeEnabled: true,
    }, this.now().toISOString()));
  }

  private async markVerified(
    attempt: BackgroundGitHubActionAttemptV1,
    result: BackgroundGitHubVerifiedResultV1,
  ): Promise<BackgroundGitHubContinuationResultV1> {
    const next: BackgroundGitHubActionAttemptV1 = {
      ...attempt,
      revision: attempt.revision + 1,
      status: "verified",
      updatedAt: this.now().toISOString(),
      pendingAction: null,
      result,
      diagnostic: null,
    };
    await this.saveReplacement(attempt, next);
    return { status: "verified", proof: result };
  }

  private async markReconcileRequired(
    attempt: BackgroundGitHubActionAttemptV1,
    message: string,
  ): Promise<BackgroundGitHubContinuationResultV1> {
    const pending = advancePending(attempt.pendingAction!, this.now(), message);
    const next: BackgroundGitHubActionAttemptV1 = {
      ...attempt,
      revision: attempt.revision + 1,
      status: "reconcile_required",
      updatedAt: this.now().toISOString(),
      pendingAction: pending,
      result: null,
      diagnostic: safeDiagnostic(message),
    };
    await this.saveReplacement(attempt, next);
    return { status: "reconcile_required", attempt: next, message: next.diagnostic! };
  }

  private async markNotApplied(
    attempt: BackgroundGitHubActionAttemptV1,
    message: string,
  ): Promise<BackgroundGitHubContinuationResultV1> {
    const next: BackgroundGitHubActionAttemptV1 = {
      ...attempt,
      revision: attempt.revision + 1,
      status: "not_applied",
      updatedAt: this.now().toISOString(),
      pendingAction: null,
      result: null,
      diagnostic: safeDiagnostic(message),
    };
    await this.saveReplacement(attempt, next);
    return { status: "not_applied", attempt: next, message: next.diagnostic! };
  }

  private async markBlocked(
    attempt: BackgroundGitHubActionAttemptV1,
    message: string,
  ): Promise<BackgroundGitHubContinuationResultV1> {
    const next: BackgroundGitHubActionAttemptV1 = {
      ...attempt,
      revision: attempt.revision + 1,
      status: "blocked",
      updatedAt: this.now().toISOString(),
      pendingAction: null,
      result: null,
      diagnostic: safeDiagnostic(message),
    };
    await this.saveReplacement(attempt, next);
    return { status: "blocked", attempt: next, message: next.diagnostic! };
  }

  private async saveReplacement(
    prior: BackgroundGitHubActionAttemptV1,
    next: BackgroundGitHubActionAttemptV1,
  ): Promise<void> {
    if (!(await this.dependencies.attempts.save(next, prior.revision))) {
      throw new BackgroundGitHubContinuationErrorV1(
        "attempt_store_conflict",
        "Background GitHub provider WAL changed concurrently.",
      );
    }
  }

  private async verifyHostApprovalReceipts(
    action: PreparedBackgroundGitHubActionV1,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const receipt of action.authority.confirmationReceipts) {
      let verified = false;
      try {
        verified = await this.dependencies.approvalReceipts.verify(receipt, signal);
      } catch {
        verified = false;
      }
      if (!verified) {
        throw new BackgroundGitHubContinuationErrorV1(
          "authority_drift",
          "Host GitHub approval receipt authentication failed.",
        );
      }
    }
  }
}

class ExactConsumedGitHubApprovalPortV1 implements GitHubPublicationApprovalPortV1 {
  constructor(private readonly action: PreparedBackgroundGitHubActionV1) {}

  async request(input: Parameters<GitHubPublicationApprovalPortV1["request"]>[0]) {
    const action = this.action;
    const expected = action.operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1
      ? { kind: "repair_fast_forward" as const, confirmations: 1 as const, fingerprint: action.payload.workflowApprovalFingerprint }
      : action.operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1
        ? { kind: "merge" as const, confirmations: 2 as const, fingerprint: action.payload.workflowApprovalFingerprint }
        : null;
    if (
      !expected ||
      input.kind !== expected.kind ||
      input.requiredConfirmations !== expected.confirmations ||
      input.approvalFingerprint !== expected.fingerprint ||
      input.preparedAction.payloadFingerprint !== expected.fingerprint ||
      action.authority.requiredConfirmations !== expected.confirmations ||
      action.authority.confirmationReceipts.length !== expected.confirmations
    ) {
      throw new BackgroundGitHubContinuationErrorV1(
        "authority_drift",
        "Workflow requested GitHub authority outside the exact consumed approval proof.",
      );
    }
    return {
      approved: true,
      approvalFingerprint: expected.fingerprint,
      approvalId: action.authority.confirmationReceipts
        .map((receipt) => receipt.fingerprint)
        .join(":"),
      confirmations: expected.confirmations,
    };
  }
}

function createPending(
  action: PreparedBackgroundGitHubActionV1,
  targetFingerprint: string,
  dispatchedAt: string,
): PendingExternalActionStateV2 {
  return createPendingExternalActionStateV2({
    schemaVersion: 2,
    provider: "github",
    operation: action.operation,
    actionId: action.id,
    resourceId: `github-${action.payload.publicationId}`,
    preparedActionFingerprint: action.preparedActionFingerprint,
    targetFingerprint,
    dispatchState: "dispatched_uncertain",
    attempt: 1,
    preparedAt: action.preparedAt,
    dispatchedAt,
    lastObservedAt: null,
    providerRequestId: null,
    error: {
      code: "github_background_dispatch_wal",
      message: "Provider dispatch is durably marked uncertain before the first effect; subsequent execution is readback-only.",
    },
  });
}

function advancePending(
  pending: PendingExternalActionStateV2,
  now: Date,
  message: string,
): PendingExternalActionStateV2 {
  const { pendingFingerprint: _ignored, ...unsigned } = pending;
  return createPendingExternalActionStateV2({
    ...unsigned,
    dispatchState: "reconcile_required",
    lastObservedAt: now.toISOString(),
    error: { code: "github_background_reconcile_required", message: safeDiagnostic(message) },
  });
}

function publicationBinding(
  preparedPackage: PreparedBackgroundGitHubPackageV1,
): TrustedGitHubPublicationBindingV1 {
  const action = preparedPackage.action;
  const proof = preparedPackage.localPlan.repositoryProof;
  return {
    bindingFingerprint: action.binding.repositoryBindingFingerprint,
    profileKey: action.binding.repositoryProfileKey,
    owner: action.binding.owner,
    repository: action.binding.repository,
    baseBranch: proof.defaultBranch,
    accountId: String(action.binding.verifiedAccountId),
    accountLogin: action.binding.verifiedAccountLogin,
    requiredChecks: [...proof.requiredChecks],
    mergeMethod: proof.mergeMethod,
  };
}

function publicationProof(
  proof: BackgroundGitHubRepositoryProofV1,
): {
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  canonicalRepositoryRoot: string;
  defaultBranch: string;
  forbidForcePush: true;
} {
  return {
    repositoryProfileKey: proof.repositoryProfileKey,
    repositoryProfileFingerprint: proof.repositoryProfileFingerprint,
    canonicalRepositoryRoot: proof.canonicalRepositoryRoot,
    defaultBranch: proof.defaultBranch,
    forbidForcePush: true,
  };
}

function publicationHandoff(
  preparedPackage: PreparedBackgroundGitHubPackageV1,
): GitHubPublicationHandoffV1 {
  const handoff = preparedPackage.localPlan.verifiedCodeHandoff!;
  return {
    profileKey: handoff.repositoryProfileKey,
    workspaceId: handoff.workspaceId,
    agentBranch: handoff.branch,
    baseSha: handoff.baseSha,
    commitSha: handoff.commitSha,
    treeSha: handoff.treeSha,
    diffFingerprint: handoff.diffFingerprint,
    validationReceiptFingerprints: [
      handoff.targetedValidationFingerprint,
      handoff.fullValidationFingerprint,
    ],
    handoffFingerprint: handoff.fingerprint,
  };
}

function assertWorkflowRuntime(
  runtime: BackgroundGitHubWorkflowRuntimeV1,
  preparedPackage: PreparedBackgroundGitHubPackageV1,
  reconciliation: boolean,
): void {
  if (runtime.finalizers !== "disabled_until_core_reconnect") {
    throw new BackgroundGitHubContinuationErrorV1(
      "authority_drift",
      "Background GitHub runtime must leave Linear and Obsidian finalization for core reconnect.",
    );
  }
  const checkpoint = runtime.checkpoint;
  const action = preparedPackage.action;
  if (
    checkpoint.publicationId !== action.payload.publicationId ||
    checkpoint.bindingFingerprint !== action.binding.repositoryBindingFingerprint ||
    checkpoint.branch !== action.payload.branch
  ) {
    throw new BackgroundGitHubContinuationErrorV1(
      "checkpoint_drift",
      "Companion-owned GitHub checkpoint drifted from the immutable local package.",
    );
  }
  if (!reconciliation && fingerprintBackgroundGitHubValueV1(checkpoint) !== action.payload.checkpointFingerprint) {
    throw new BackgroundGitHubContinuationErrorV1(
      "checkpoint_drift",
      "First GitHub dispatch requires the exact packaged checkpoint fingerprint.",
    );
  }
}

function assertAttemptScope(
  attempt: BackgroundGitHubActionAttemptV1,
  jobId: string,
  action: PreparedBackgroundGitHubActionV1,
): void {
  if (
    attempt.jobId !== jobId ||
    attempt.actionFingerprint !== action.fingerprint ||
    attempt.preparedActionFingerprint !== action.preparedActionFingerprint ||
    attempt.operation !== action.operation ||
    attempt.publicationId !== action.payload.publicationId ||
    attempt.repositoryBindingFingerprint !== action.binding.repositoryBindingFingerprint ||
    attempt.targetFingerprint !== backgroundGitHubTargetFingerprintV1(action)
  ) {
    throw new BackgroundGitHubContinuationErrorV1(
      "authority_drift",
      "Durable GitHub WAL does not belong to the exact prepared action.",
    );
  }
}

function createProof(
  preparedPackage: PreparedBackgroundGitHubPackageV1,
  input: {
    checkpointFingerprint: string;
    headSha: string | null;
    pullRequestNumber: number | null;
    mergeSha: string | null;
    autoMergeEnabled: boolean;
  },
  verifiedAt: string,
): BackgroundGitHubVerifiedResultV1 {
  return createBackgroundGitHubVerifiedResultV1({
    operation: preparedPackage.action.operation,
    publicationId: preparedPackage.action.payload.publicationId,
    repositoryBindingFingerprint: preparedPackage.action.binding.repositoryBindingFingerprint,
    verifiedAccountId: preparedPackage.action.binding.verifiedAccountId,
    ...input,
    verifiedAt,
  });
}

function safeDiagnostic(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]+/gu, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9]+/gu, "[REDACTED]")
    .replace(/[A-Za-z]:[\\/][^\s]+/gu, "[LOCAL_PATH]")
    .slice(0, 1_000);
}
