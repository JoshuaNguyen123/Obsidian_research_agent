import type {
  ActionReceipt,
  JsonValue,
  PreparedAction,
  PreparedActionInput,
} from "../../agent/actions";
import {
  createPendingExternalActionStateV2,
  type PendingExternalActionStateV2,
} from "../PendingExternalActionStateV2";
import {
  DurableLinearContractError,
  expectLogicalKey,
  expectSha256,
  expectString,
  fingerprintContract,
  parseHttpUrl,
  parseUniqueStrings,
} from "../linear/LinearContractSupport";

export type GitHubMergeMethodV1 = "squash" | "merge" | "rebase";
export type GitHubPublicationCompletionProofV1 = "draft_pr" | "merged_pr";

export interface GitHubPublicationHandoffV1 {
  profileKey: string;
  workspaceId: string;
  agentBranch: string;
  baseSha: string;
  commitSha: string;
  treeSha: string;
  diffFingerprint: string;
  validationReceiptFingerprints: string[];
  handoffFingerprint: string;
}

export interface TrustedGitHubPublicationBindingV1 {
  bindingFingerprint: string;
  profileKey: string;
  owner: string;
  repository: string;
  baseBranch: string;
  accountId: string;
  accountLogin: string;
  requiredChecks: string[];
  mergeMethod: GitHubMergeMethodV1;
}

export interface GitHubPublicationPullRequestV1 {
  number: number;
  htmlUrl: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  updatedAt: string;
  /** Present on merged readback and required to reconcile an ambiguous merge. */
  mergeSha?: string | null;
}

export interface GitHubPublicationCheckV1 {
  name: string;
  status: string;
  conclusion?: string;
}

export interface GitHubPublicationStatusV1 {
  context: string;
  state: string;
}

export interface GitHubPublicationReviewV1 {
  id: number;
  userLogin: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string;
  /** Untrusted provider text. It is evidence only and never grants tools or paths. */
  body: string;
}

export interface GitHubPublicationProofSnapshotV1 {
  headSha: string;
  pullRequestUpdatedAt: string;
  requiredChecks: string[];
  passedChecks: string[];
  pendingChecks: string[];
  failedChecks: string[];
  approvingReviewers: string[];
  changesRequestedBy: string[];
  checkedAt: string;
  snapshotFingerprint: string;
}

export type GitHubPublicationCheckpointStatusV1 =
  | "local_verified"
  | "push_prepared"
  | "pushed_verified"
  | "draft_pr_verified"
  | "checks_pending"
  | "repair_required"
  | "review_or_merge_ready"
  | "merge_prepared"
  | "merged_verified"
  | "waiting_linear_link"
  | "linear_linked"
  | "waiting_linear_completion"
  | "linear_completed"
  /** Legacy combined Linear-finalization state retained for persisted checkpoints. */
  | "waiting_linear"
  | "waiting_obsidian"
  | "finalized"
  | "blocked"
  | "reconcile_required";

export interface GitHubPublicationCheckpointV1 {
  version: 1;
  publicationId: string;
  status: GitHubPublicationCheckpointStatusV1;
  updatedAt: string;
  handoffFingerprint: string;
  bindingFingerprint: string;
  headSha: string;
  branch: string;
  remoteSha: string | null;
  mergeSha: string | null;
  pullRequest: GitHubPublicationPullRequestV1 | null;
  proofSnapshot: GitHubPublicationProofSnapshotV1 | null;
  publishApprovalFingerprint: string | null;
  readyApprovalFingerprint: string | null;
  mergeApprovalFingerprint: string | null;
  completionProof: GitHubPublicationCompletionProofV1;
  linearLinkReceiptId: string | null;
  linearCompletionReceiptId: string | null;
  obsidianReceiptId: string | null;
  receiptIds: string[];
  pendingAction: PendingExternalActionStateV2 | null;
  blocker: { code: string; message: string } | null;
  /** Present after a verified review-repair epoch advances the publication head. */
  repairBaseSha?: string | null;
  /** Durable review-repair identity; never sourced from GitHub review prose. */
  repairId?: string | null;
  /** Exact existing pull request whose owned branch was advanced. */
  repairPullRequestNumber?: number | null;
}

export interface GitHubPublicationCheckpointPortV1 {
  persist(checkpoint: GitHubPublicationCheckpointV1): Promise<void>;
}

export interface GitHubPublicationPushPortV1 {
  publish(input: {
    handoff: GitHubPublicationHandoffV1;
    binding: TrustedGitHubPublicationBindingV1;
    approvalFingerprint: string;
    signal?: AbortSignal;
  }): Promise<
    | { status: "verified"; remoteSha: string; receipt: ActionReceipt }
    | {
        status: "reconcile_required";
        pendingAction: PendingExternalActionStateV2;
      }
  >;
  /** Readback only. Implementations must never dispatch another push. */
  reconcile?(input: {
    handoff: GitHubPublicationHandoffV1;
    binding: TrustedGitHubPublicationBindingV1;
    approvalFingerprint: string;
    pendingAction: PendingExternalActionStateV2;
    signal?: AbortSignal;
  }): Promise<
    | { status: "verified"; remoteSha: string; receipt: ActionReceipt }
    | { status: "not_applied" }
    | { status: "reconcile_required"; pendingAction: PendingExternalActionStateV2 }
  >;
}

export interface GitHubPublicationProviderPortV1 {
  listPullRequestsForHead(
    owner: string,
    repository: string,
    head: string,
    base: string,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationPullRequestV1[]>;
  createDraftPullRequest(
    input: {
      owner: string;
      repository: string;
      title: string;
      body: string;
      head: string;
      base: string;
    },
    signal?: AbortSignal,
  ): Promise<{ pullRequest: GitHubPublicationPullRequestV1; receipt: ActionReceipt }>;
  getPullRequest(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationPullRequestV1>;
  listCheckRuns(
    owner: string,
    repository: string,
    reference: string,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationCheckV1[]>;
  getCombinedStatus(
    owner: string,
    repository: string,
    reference: string,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationStatusV1[]>;
  listPullRequestReviews(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationReviewV1[]>;
  markPullRequestReady(
    owner: string,
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<{ pullRequest: GitHubPublicationPullRequestV1; receipt: ActionReceipt }>;
  mergePullRequest(
    input: {
      owner: string;
      repository: string;
      number: number;
      sha: string;
      mergeMethod: GitHubMergeMethodV1;
    },
    signal?: AbortSignal,
  ): Promise<{ merged: boolean; sha: string; receipt: ActionReceipt }>;
}

export interface GitHubPublicationApprovalDecisionV1 {
  approved: boolean;
  approvalFingerprint: string;
  approvalId?: string;
  confirmations?: number;
  reason?: string;
}

export interface GitHubPublicationApprovalPortV1 {
  request(input: {
    kind: "publish" | "repair_fast_forward" | "ready" | "merge";
    approvalFingerprint: string;
    preparedAction: PreparedAction;
    requiredConfirmations: 1 | 2;
    summary: string;
    destination: string;
  }): Promise<GitHubPublicationApprovalDecisionV1>;
}

export type GitHubPublicationPreapprovedApprovalInputV1 =
  | {
      kind: "repair_fast_forward";
      publicationId: string;
      binding: TrustedGitHubPublicationBindingV1;
      pullRequestNumber: number;
      branch: string;
      previousHeadSha: string;
      newHeadSha: string;
      repairId: string;
      previousHandoffFingerprint: string;
      handoffFingerprint: string;
    }
  | {
      kind: "merge";
      publicationId: string;
      binding: TrustedGitHubPublicationBindingV1;
      pullRequestNumber: number;
      branch: string;
      headSha: string;
      pullRequestUpdatedAt: string;
      proofSnapshotFingerprint: string;
      requiredChecks: string[];
      mergeMethod: GitHubMergeMethodV1;
    };

/**
 * Closed background-only seam for an approval already authenticated by the
 * host. It avoids rebuilding a timestamp-bearing foreground PreparedAction.
 */
export interface GitHubPublicationPreapprovedApprovalPortV1 {
  consume(
    input: GitHubPublicationPreapprovedApprovalInputV1,
  ): Promise<GitHubPublicationApprovalDecisionV1>;
}

export interface GitHubPublicationFinalizerPortV1 {
  finalizeLinearLink(input: GitHubPublicationFinalizationInputV1): Promise<{
    receiptId: string;
  }>;
  finalizeLinearCompletion(input: GitHubPublicationFinalizationInputV1): Promise<{
    receiptId: string;
  }>;
  finalizeObsidian(input: GitHubPublicationFinalizationInputV1): Promise<{
    receiptId: string;
  }>;
}

export interface GitHubPublicationFinalizationInputV1 {
    publicationId: string;
    pullRequest: GitHubPublicationPullRequestV1;
    completionProof: GitHubPublicationCompletionProofV1;
    proofRevision: string;
    mergeSha: string | null;
}

export interface GitHubPublicationWorkflowOptionsV1 {
  push: GitHubPublicationPushPortV1;
  provider: GitHubPublicationProviderPortV1;
  approvals: GitHubPublicationApprovalPortV1;
  preapprovedApprovals?: GitHubPublicationPreapprovedApprovalPortV1;
  checkpoints: GitHubPublicationCheckpointPortV1;
  finalizers?: GitHubPublicationFinalizerPortV1;
  persistReconciledReceipt?: (receipt: ActionReceipt) => Promise<void>;
  approvalIdentity: {
    runId: string;
    toolCallId: string;
    toolName: string;
  };
  now?: () => Date;
}

export interface PublishVerifiedCodeRequestV1 {
  explicitUserMission: boolean;
  publicationId: string;
  title: string;
  body: string;
  handoff: GitHubPublicationHandoffV1;
  binding: TrustedGitHubPublicationBindingV1;
  completionProof?: GitHubPublicationCompletionProofV1;
  signal?: AbortSignal;
}

export interface PublishVerifiedReviewRepairFastForwardRequestV1 {
  repairId: string;
  checkpoint: GitHubPublicationCheckpointV1;
  binding: TrustedGitHubPublicationBindingV1;
  pullRequestNumber: number;
  expectedRemoteHeadSha: string;
  previousHandoffFingerprint: string;
  handoff: GitHubPublicationHandoffV1;
  signal?: AbortSignal;
}

export interface ReconcileVerifiedReviewRepairFastForwardRequestV1 {
  repairId: string;
  checkpoint: GitHubPublicationCheckpointV1;
  binding: TrustedGitHubPublicationBindingV1;
  pullRequestNumber: number;
  expectedOldHeadSha: string;
  handoff: GitHubPublicationHandoffV1;
  signal?: AbortSignal;
}

export type GitHubReviewRepairFastForwardResultV1 =
  | {
      status: "verified";
      checkpoint: GitHubPublicationCheckpointV1;
      remoteSha: string;
      receiptIds: string[];
    }
  | {
      status: "reconcile_required";
      checkpoint: GitHubPublicationCheckpointV1;
      message: string;
    }
  | {
      status: "approval_denied";
      checkpoint: GitHubPublicationCheckpointV1;
      approvalFingerprint: string;
      message: string;
    };

export class GitHubPublicationWorkflowV1 {
  private readonly now: () => Date;

  constructor(private readonly options: GitHubPublicationWorkflowOptionsV1) {
    this.now = options.now ?? (() => new Date());
  }

  async publishDraft(
    request: PublishVerifiedCodeRequestV1,
  ): Promise<GitHubPublicationCheckpointV1> {
    const normalized = validatePublishRequest(request);
    let checkpoint = baseCheckpoint(normalized, this.isoNow());
    await this.options.checkpoints.persist(checkpoint);

    const publishAction = buildGitHubApprovalPreparedActionV1({
      kind: "publish",
      identity: this.options.approvalIdentity,
      preparedAt: this.isoNow(),
      publicationId: normalized.publicationId,
      binding: normalized.binding,
      branch: normalized.handoff.agentBranch,
      headSha: normalized.handoff.commitSha,
      title: normalized.title,
      body: normalized.body,
    });
    const publishApprovalFingerprint = publishAction.payloadFingerprint;
    checkpoint = {
      ...checkpoint,
      status: "push_prepared",
      updatedAt: this.isoNow(),
      publishApprovalFingerprint,
    };
    await this.options.checkpoints.persist(checkpoint);
    const approval = await this.options.approvals.request({
      kind: "publish",
      approvalFingerprint: publishApprovalFingerprint,
      preparedAction: publishAction,
      requiredConfirmations: 1,
      summary: `Push ${normalized.handoff.commitSha} and create or reuse a draft pull request.`,
      destination: `${normalized.binding.owner}/${normalized.binding.repository}:${normalized.handoff.agentBranch}`,
    });
    requireApproval(approval, publishApprovalFingerprint, 1);

    const push = await this.options.push.publish({
      handoff: normalized.handoff,
      binding: normalized.binding,
      approvalFingerprint: publishApprovalFingerprint,
      signal: normalized.signal,
    });
    if (push.status === "reconcile_required") {
      checkpoint = {
        ...checkpoint,
        status: "reconcile_required",
        updatedAt: this.isoNow(),
        pendingAction: push.pendingAction,
        blocker: {
          code: "github_push_reconcile_required",
          message: "The remote branch must be read back before this publication can resume.",
        },
      };
      await this.options.checkpoints.persist(checkpoint);
      return checkpoint;
    }
    if (push.remoteSha !== normalized.handoff.commitSha) {
      throw new DurableLinearContractError(
        "Verified push readback did not match the local verified commit.",
      );
    }
    checkpoint = {
      ...checkpoint,
      status: "pushed_verified",
      updatedAt: this.isoNow(),
      remoteSha: push.remoteSha,
      receiptIds: [push.receipt.id],
    };
    await this.options.checkpoints.persist(checkpoint);

    return this.continueDraftPublication(checkpoint, {
      title: normalized.title,
      body: normalized.body,
      binding: normalized.binding,
      signal: normalized.signal,
    });
  }

  async resumeDraftPublication(
    checkpoint: GitHubPublicationCheckpointV1,
    input: {
      title: string;
      body: string;
      binding: TrustedGitHubPublicationBindingV1;
      signal?: AbortSignal;
    },
  ): Promise<GitHubPublicationCheckpointV1> {
    if (
      checkpoint.status !== "pushed_verified" ||
      checkpoint.remoteSha !== checkpoint.headSha ||
      !checkpoint.publishApprovalFingerprint
    ) {
      throw new DurableLinearContractError(
        "Draft publication resume requires verified push readback.",
      );
    }
    return this.continueDraftPublication(checkpoint, {
      ...input,
      title: expectString(input.title, "pull request title", 1, 256),
      body: expectString(input.body, "pull request body", 1, 65_536, {
        allowNewlines: true,
      }),
      binding: validateBinding(input.binding),
    });
  }

  /**
   * Advances an existing draft-PR publication after the normal local repair
   * pipeline produced a fresh verified descendant. This is an owned-branch
   * fast-forward only; it does not create a PR, force-push, or consume review
   * text as authority.
   */
  async publishVerifiedReviewRepairFastForward(
    request: PublishVerifiedReviewRepairFastForwardRequestV1,
  ): Promise<GitHubReviewRepairFastForwardResultV1> {
    const prepared = validateReviewRepairPublishRequest(request);
    const remote = await this.options.provider.getPullRequest(
      prepared.binding.owner,
      prepared.binding.repository,
      prepared.pullRequestNumber,
      prepared.signal,
    );
    verifyReviewRepairPullRequest(
      remote,
      prepared.checkpoint,
      prepared.binding,
      prepared.expectedRemoteHeadSha,
      prepared.pullRequestNumber,
    );

    const preparedAt = this.isoNow();
    let authorizationFingerprint = "";
    try {
      let approval: GitHubPublicationApprovalDecisionV1;
      if (this.options.preapprovedApprovals) {
        approval = await this.options.preapprovedApprovals.consume({
            kind: "repair_fast_forward",
            publicationId: prepared.checkpoint.publicationId,
            binding: prepared.binding,
            pullRequestNumber: prepared.pullRequestNumber,
            branch: prepared.handoff.agentBranch,
            previousHeadSha: prepared.expectedRemoteHeadSha,
            newHeadSha: prepared.handoff.commitSha,
            repairId: prepared.repairId,
            previousHandoffFingerprint: prepared.previousHandoffFingerprint,
            handoffFingerprint: prepared.handoff.handoffFingerprint,
          });
        // The preapproved adapter is the verifier for its independently sealed
        // background action. It returns only the already-validated fingerprint.
        authorizationFingerprint = approval.approvalFingerprint;
      } else {
        const reviewRepairAction = buildGitHubApprovalPreparedActionV1({
          kind: "repair_fast_forward",
          identity: this.options.approvalIdentity,
          preparedAt,
          publicationId: prepared.checkpoint.publicationId,
          repairId: prepared.repairId,
          binding: prepared.binding,
          pullRequestNumber: prepared.pullRequestNumber,
          pullRequestUrl: remote.htmlUrl,
          branch: prepared.handoff.agentBranch,
          previousHeadSha: prepared.expectedRemoteHeadSha,
          headSha: prepared.handoff.commitSha,
        });
        authorizationFingerprint = reviewRepairAction.payloadFingerprint;
        approval = await this.options.approvals.request({
          kind: "repair_fast_forward",
          approvalFingerprint: authorizationFingerprint,
          preparedAction: reviewRepairAction,
          requiredConfirmations: 1,
          summary:
            `Fast-forward pull request #${prepared.pullRequestNumber} from ` +
            `${prepared.expectedRemoteHeadSha} to ${prepared.handoff.commitSha}.`,
          destination: remote.htmlUrl,
        });
      }
      requireApproval(approval, authorizationFingerprint, 1);
    } catch {
      return {
        status: "approval_denied",
        checkpoint: prepared.checkpoint,
        approvalFingerprint: authorizationFingerprint,
        message:
          "The exact review-repair fast-forward approval was denied, expired, or did not match the prepared fingerprint.",
      };
    }
    const pendingAction = createPendingExternalActionStateV2({
      schemaVersion: 2,
      provider: "github",
      operation: "git_push",
      actionId: `github-review-fast-forward-${prepared.repairId}`,
      resourceId: `${prepared.binding.owner}-${prepared.binding.repository}-${prepared.pullRequestNumber}`,
      preparedActionFingerprint: authorizationFingerprint,
      targetFingerprint: fingerprintContract({
        bindingFingerprint: prepared.binding.bindingFingerprint,
        pullRequestNumber: prepared.pullRequestNumber,
        previousHeadSha: prepared.expectedRemoteHeadSha,
        newHeadSha: prepared.handoff.commitSha,
      }),
      dispatchState: "prepared",
      attempt: 1,
      preparedAt,
      dispatchedAt: null,
      lastObservedAt: null,
      providerRequestId: null,
      error: {
        code: "github_review_repair_push_prepared",
        message: "The exact verified review-repair fast-forward is durably prepared.",
      },
    });
    let checkpoint: GitHubPublicationCheckpointV1 = {
      ...prepared.checkpoint,
      status: "push_prepared",
      updatedAt: this.isoNow(),
      handoffFingerprint: prepared.handoff.handoffFingerprint,
      headSha: prepared.handoff.commitSha,
      remoteSha: null,
      pullRequest: null,
      proofSnapshot: null,
      publishApprovalFingerprint: authorizationFingerprint,
      readyApprovalFingerprint: null,
      mergeApprovalFingerprint: null,
      pendingAction,
      blocker: {
        code: "github_review_repair_push_prepared",
        message: "The verified review-repair fast-forward is prepared for secure dispatch.",
      },
      repairBaseSha: prepared.expectedRemoteHeadSha,
      repairId: prepared.repairId,
      repairPullRequestNumber: prepared.pullRequestNumber,
    };
    await this.options.checkpoints.persist(checkpoint);

    let push: Awaited<ReturnType<GitHubPublicationPushPortV1["publish"]>>;
    try {
      push = await this.options.push.publish({
        handoff: prepared.handoff,
        binding: prepared.binding,
        approvalFingerprint: authorizationFingerprint,
        signal: prepared.signal,
      });
    } catch {
      checkpoint = await this.markReviewRepairPushUncertain(
        checkpoint,
        pendingAction,
        "The secure fast-forward dispatch outcome is unknown; read-only reconciliation is required.",
      );
      return {
        status: "reconcile_required",
        checkpoint,
        message: checkpoint.blocker?.message ?? "Review-repair push reconciliation is required.",
      };
    }
    if (push.status === "reconcile_required") {
      checkpoint = {
        ...checkpoint,
        status: "reconcile_required",
        updatedAt: this.isoNow(),
        pendingAction: push.pendingAction,
        blocker: {
          code: "github_review_repair_push_reconcile_required",
          message: "The review-repair branch update must be reconciled by remote readback without redispatch.",
        },
      };
      await this.options.checkpoints.persist(checkpoint);
      return {
        status: "reconcile_required",
        checkpoint,
        message: checkpoint.blocker?.message ?? "Review-repair push reconciliation is required.",
      };
    }
    checkpoint = await this.acceptVerifiedReviewRepairPush(
      checkpoint,
      push,
      prepared.handoff,
    );
    return this.finishVerifiedReviewRepairReadback(
      checkpoint,
      prepared.binding,
      prepared.pullRequestNumber,
      prepared.signal,
    );
  }

  /** Readback only. This method never calls the push dispatch method. */
  async reconcileVerifiedReviewRepairFastForward(
    request: ReconcileVerifiedReviewRepairFastForwardRequestV1,
  ): Promise<GitHubReviewRepairFastForwardResultV1> {
    const prepared = validateReviewRepairReconcileRequest(request);
    let checkpoint = prepared.checkpoint;
    if (checkpoint.status === "blocked") {
      return {
        status: "reconcile_required",
        checkpoint,
        message: checkpoint.blocker?.message ?? "Review-repair publication is blocked.",
      };
    }
    if (
      checkpoint.status === "draft_pr_verified" ||
      checkpoint.status === "checks_pending" ||
      checkpoint.status === "repair_required" ||
      checkpoint.status === "review_or_merge_ready"
    ) {
      return this.finishVerifiedReviewRepairReadback(
        checkpoint,
        prepared.binding,
        prepared.pullRequestNumber,
        prepared.signal,
      );
    }
    if (checkpoint.status === "pushed_verified") {
      return this.finishVerifiedReviewRepairReadback(
        checkpoint,
        prepared.binding,
        prepared.pullRequestNumber,
        prepared.signal,
      );
    }
    const pending = checkpoint.pendingAction;
    if (
      (checkpoint.status !== "push_prepared" && checkpoint.status !== "reconcile_required") ||
      !pending ||
      pending.provider !== "github" ||
      pending.operation !== "git_push" ||
      !this.options.push.reconcile
    ) {
      return {
        status: "reconcile_required",
        checkpoint,
        message: "No exact durable review-repair push attempt is available for read-only reconciliation.",
      };
    }

    const reconciled = await this.options.push.reconcile({
      handoff: prepared.handoff,
      binding: prepared.binding,
      approvalFingerprint: pending.preparedActionFingerprint,
      pendingAction: pending,
      signal: prepared.signal,
    });
    if (reconciled.status === "not_applied") {
      checkpoint = {
        ...checkpoint,
        status: "blocked",
        updatedAt: this.isoNow(),
        pendingAction: null,
        blocker: {
          code: "github_review_repair_push_not_applied",
          message: "Remote readback proved the review-repair push was not applied; a fresh user mission is required.",
        },
      };
      await this.options.checkpoints.persist(checkpoint);
      return {
        status: "reconcile_required",
        checkpoint,
        message: checkpoint.blocker?.message ?? "Review-repair publication requires a fresh mission.",
      };
    }
    if (reconciled.status === "reconcile_required") {
      checkpoint = {
        ...checkpoint,
        status: "reconcile_required",
        updatedAt: this.isoNow(),
        pendingAction: reconciled.pendingAction,
        blocker: {
          code: "github_review_repair_push_reconcile_required",
          message: "Remote readback remains inconclusive; the review-repair push was not redispatched.",
        },
      };
      await this.options.checkpoints.persist(checkpoint);
      return {
        status: "reconcile_required",
        checkpoint,
        message: checkpoint.blocker?.message ?? "Review-repair push reconciliation is required.",
      };
    }
    checkpoint = await this.acceptVerifiedReviewRepairPush(
      checkpoint,
      reconciled,
      prepared.handoff,
    );
    return this.finishVerifiedReviewRepairReadback(
      checkpoint,
      prepared.binding,
      prepared.pullRequestNumber,
      prepared.signal,
    );
  }

  async merge(
    checkpoint: GitHubPublicationCheckpointV1,
    binding: TrustedGitHubPublicationBindingV1,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationCheckpointV1> {
    validateBinding(binding);
    if (checkpoint.status === "reconcile_required") {
      return this.reconcile(checkpoint, binding, signal);
    }
    if (!checkpoint.pullRequest || checkpoint.bindingFingerprint !== binding.bindingFingerprint) {
      throw new DurableLinearContractError(
        "Merge requires the exact trusted binding and verified pull request checkpoint.",
      );
    }
    let current = await this.refreshProof(checkpoint, binding, signal);
    if (current.status === "repair_required" || current.status === "checks_pending") {
      return current;
    }
    let pullRequest = current.pullRequest as GitHubPublicationPullRequestV1;
    if (pullRequest.draft) {
      const readyAction = buildGitHubApprovalPreparedActionV1({
        kind: "ready",
        identity: this.options.approvalIdentity,
        preparedAt: this.isoNow(),
        publicationId: current.publicationId,
        binding,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.head.sha,
        branch: current.branch,
        pullRequestUrl: pullRequest.htmlUrl,
      });
      const readyFingerprint = readyAction.payloadFingerprint;
      const decision = await this.options.approvals.request({
        kind: "ready",
        approvalFingerprint: readyFingerprint,
        preparedAction: readyAction,
        requiredConfirmations: 1,
        summary: `Mark draft pull request #${pullRequest.number} ready for review.`,
        destination: pullRequest.htmlUrl,
      });
      requireApproval(decision, readyFingerprint, 1);
      current = await this.persistPendingMutation(current, {
        operation: "pull_request_ready",
        approvalFingerprint: readyFingerprint,
        targetFingerprint: current.proofSnapshot?.snapshotFingerprint ?? current.handoffFingerprint,
        resourceId: `${binding.owner}-${binding.repository}-${pullRequest.number}`,
      });
      let ready: Awaited<ReturnType<GitHubPublicationProviderPortV1["markPullRequestReady"]>>;
      try {
        ready = await this.options.provider.markPullRequestReady(
          binding.owner,
          binding.repository,
          pullRequest.number,
          signal,
        );
      } catch {
        return this.markPendingMutationUncertain(
          current,
          "github_ready_reconcile_required",
          "Ready-for-review dispatch may have committed; pull-request readback is required before any retry.",
        );
      }
      pullRequest = await this.options.provider.getPullRequest(
        binding.owner,
        binding.repository,
        pullRequest.number,
        signal,
      );
      if (pullRequest.draft || ready.pullRequest.head.sha !== current.headSha) {
        throw new DurableLinearContractError(
          "Ready-for-review readback did not preserve the approved pull request head.",
        );
      }
      current = {
        ...current,
        status: "draft_pr_verified",
        updatedAt: this.isoNow(),
        pullRequest,
        readyApprovalFingerprint: readyFingerprint,
        receiptIds: [...current.receiptIds, ready.receipt.id],
        pendingAction: null,
        blocker: null,
      };
      await this.options.checkpoints.persist(current);
      current = await this.refreshProof(current, binding, signal);
      if (current.status !== "review_or_merge_ready") return current;
      pullRequest = current.pullRequest as GitHubPublicationPullRequestV1;
    }

    const proof = current.proofSnapshot as GitHubPublicationProofSnapshotV1;
    let mergeApprovalFingerprint: string;
    let preapprovedDecision: GitHubPublicationApprovalDecisionV1 | null = null;
    let mergeAction: PreparedAction | null = null;
    if (this.options.preapprovedApprovals) {
      preapprovedDecision = await this.options.preapprovedApprovals.consume({
        kind: "merge",
        publicationId: current.publicationId,
        binding,
        pullRequestNumber: pullRequest.number,
        branch: current.branch,
        headSha: pullRequest.head.sha,
        pullRequestUpdatedAt: pullRequest.updatedAt,
        proofSnapshotFingerprint: proof.snapshotFingerprint,
        requiredChecks: [...binding.requiredChecks],
        mergeMethod: binding.mergeMethod,
      });
      mergeApprovalFingerprint = preapprovedDecision.approvalFingerprint;
    } else {
      mergeAction = buildGitHubApprovalPreparedActionV1({
        kind: "merge",
        identity: this.options.approvalIdentity,
        preparedAt: this.isoNow(),
        publicationId: current.publicationId,
        binding,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.head.sha,
        branch: current.branch,
        pullRequestUrl: pullRequest.htmlUrl,
        proofSnapshotFingerprint: proof.snapshotFingerprint,
      });
      mergeApprovalFingerprint = mergeAction.payloadFingerprint;
    }
    current = {
      ...current,
      status: "merge_prepared",
      updatedAt: this.isoNow(),
      mergeApprovalFingerprint,
    };
    await this.options.checkpoints.persist(current);
    const approval = preapprovedDecision ?? await this.options.approvals.request({
      kind: "merge",
      approvalFingerprint: mergeApprovalFingerprint,
      preparedAction: mergeAction!,
      requiredConfirmations: 2,
      summary: `Merge pull request #${pullRequest.number} at ${pullRequest.head.sha}.`,
      destination: pullRequest.htmlUrl,
    });
    requireApproval(approval, mergeApprovalFingerprint, 2);

    const fresh = await this.refreshProof(current, binding, signal);
    if (
      fresh.status !== "review_or_merge_ready" ||
      !fresh.proofSnapshot ||
      fresh.proofSnapshot.snapshotFingerprint !== proof.snapshotFingerprint ||
      fresh.pullRequest?.head.sha !== pullRequest.head.sha ||
      fresh.pullRequest?.draft
    ) {
      const blocked = {
        ...fresh,
        status: "blocked" as const,
        updatedAt: this.isoNow(),
        mergeApprovalFingerprint: null,
        blocker: {
          code: "github_merge_approval_stale",
          message: "The pull request, checks, or reviews changed after merge approval.",
        },
      };
      await this.options.checkpoints.persist(blocked);
      return blocked;
    }
    current = await this.persistPendingMutation(fresh, {
      operation: "pull_request_merge",
      approvalFingerprint: mergeApprovalFingerprint,
      targetFingerprint: proof.snapshotFingerprint,
      resourceId: `${binding.owner}-${binding.repository}-${pullRequest.number}`,
    });
    let merged: Awaited<ReturnType<GitHubPublicationProviderPortV1["mergePullRequest"]>>;
    try {
      merged = await this.options.provider.mergePullRequest(
        {
          owner: binding.owner,
          repository: binding.repository,
          number: pullRequest.number,
          sha: pullRequest.head.sha,
          mergeMethod: binding.mergeMethod,
        },
        signal,
      );
    } catch {
      return this.markPendingMutationUncertain(
        current,
        "github_merge_reconcile_required",
        "Merge dispatch may have committed; pull-request and merge-SHA readback are required before any retry.",
      );
    }
    if (!merged.merged) {
      throw new DurableLinearContractError("GitHub did not confirm the pull request merge.");
    }
    const mergedReadback = await this.options.provider.getPullRequest(
      binding.owner,
      binding.repository,
      pullRequest.number,
      signal,
    );
    if (!mergedReadback.merged || mergedReadback.head.sha !== pullRequest.head.sha) {
      throw new DurableLinearContractError(
        "Merged pull request readback did not prove the approved head.",
      );
    }
    current = {
      ...fresh,
      status: "merged_verified",
      updatedAt: this.isoNow(),
      pullRequest: { ...mergedReadback, mergeSha: merged.sha },
      mergeSha: merged.sha,
      mergeApprovalFingerprint,
      receiptIds: [...current.receiptIds, merged.receipt.id],
      pendingAction: null,
      blocker: null,
    };
    await this.options.checkpoints.persist(current);
    return current.completionProof === "merged_pr" ? this.finalize(current) : current;
  }

  async resumeFinalization(
    checkpoint: GitHubPublicationCheckpointV1,
    binding?: TrustedGitHubPublicationBindingV1,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationCheckpointV1> {
    if (
      ![
        "draft_pr_verified",
        "merged_verified",
        "waiting_linear",
        "waiting_linear_link",
        "linear_linked",
        "waiting_linear_completion",
        "linear_completed",
        "waiting_obsidian",
      ].includes(
        checkpoint.status,
      ) || !checkpoint.pullRequest
    ) {
      throw new DurableLinearContractError(
        "GitHub finalization resume requires a verified publication checkpoint.",
      );
    }
    if (checkpoint.completionProof === "merged_pr") {
      if (!checkpoint.pullRequest.merged || !checkpoint.mergeSha) {
        throw new DurableLinearContractError(
          "Merged-pr finalization requires merged readback and its merge SHA.",
        );
      }
    } else if (
      checkpoint.pullRequest.state !== "open" ||
      checkpoint.pullRequest.merged ||
      checkpoint.pullRequest.head.sha !== checkpoint.headSha
    ) {
      throw new DurableLinearContractError(
        "Draft-pr finalization requires the verified open pull-request head.",
      );
    }
    if (binding) {
      const trusted = validateBinding(binding);
      if (trusted.bindingFingerprint !== checkpoint.bindingFingerprint) {
        throw new DurableLinearContractError(
          "Finalization resume binding does not match the durable publication.",
        );
      }
      const readback = await this.options.provider.getPullRequest(
        trusted.owner,
        trusted.repository,
        checkpoint.pullRequest.number,
        signal,
      );
      if (
        readback.head.sha !== checkpoint.headSha ||
        readback.head.ref !== checkpoint.branch ||
        readback.base.ref !== trusted.baseBranch ||
        (checkpoint.completionProof === "merged_pr"
          ? !readback.merged
          : readback.state !== "open" || readback.merged)
      ) {
        const blocked = {
          ...checkpoint,
          status: "blocked" as const,
          updatedAt: this.isoNow(),
          pullRequest: readback,
          blocker: {
            code: "github_finalization_proof_drift",
            message: "GitHub publication proof changed before finalization resumed.",
          },
        };
        await this.options.checkpoints.persist(blocked);
        return blocked;
      }
      checkpoint = { ...checkpoint, pullRequest: readback };
    }
    return this.finalize(checkpoint);
  }

  async reconcile(
    checkpoint: GitHubPublicationCheckpointV1,
    binding: TrustedGitHubPublicationBindingV1,
    signal?: AbortSignal,
    resumeDraft?: {
      handoff: GitHubPublicationHandoffV1;
      title: string;
      body: string;
    },
  ): Promise<GitHubPublicationCheckpointV1> {
    const trusted = validateBinding(binding);
    const pending = checkpoint.pendingAction;
    if (
      checkpoint.status !== "reconcile_required" ||
      !pending ||
      pending.provider !== "github" ||
      checkpoint.bindingFingerprint !== trusted.bindingFingerprint
    ) {
      throw new DurableLinearContractError(
        "GitHub reconciliation requires the exact pending action and trusted binding.",
      );
    }
    if (pending.operation === "git_push") {
      if (!this.options.push.reconcile || !resumeDraft) return checkpoint;
      const handoff = validateHandoff(resumeDraft.handoff);
      if (
        handoff.handoffFingerprint !== checkpoint.handoffFingerprint ||
        handoff.commitSha !== checkpoint.headSha ||
        handoff.agentBranch !== checkpoint.branch
      ) {
        throw new DurableLinearContractError(
          "Git push reconciliation handoff does not match the durable checkpoint.",
        );
      }
      const reconciled = await this.options.push.reconcile({
        handoff,
        binding: trusted,
        approvalFingerprint: pending.preparedActionFingerprint,
        pendingAction: pending,
        signal,
      });
      if (reconciled.status === "not_applied") {
        return this.resolvePendingNotApplied(
          checkpoint,
          "github_push_not_applied",
          "Remote readback proved that the prepared push did not apply; fresh approval is required.",
        );
      }
      if (reconciled.status === "reconcile_required") {
        const next = {
          ...checkpoint,
          updatedAt: this.isoNow(),
          pendingAction: reconciled.pendingAction,
          blocker: {
            code: "github_push_reconcile_required",
            message: "Remote branch readback remains inconclusive; the push was not redispatched.",
          },
        };
        await this.options.checkpoints.persist(next);
        return next;
      }
      if (reconciled.remoteSha !== checkpoint.headSha) {
        throw new DurableLinearContractError(
          "Reconciled Git push did not match the verified local head.",
        );
      }
      const pushed = {
        ...checkpoint,
        status: "pushed_verified" as const,
        updatedAt: this.isoNow(),
        remoteSha: reconciled.remoteSha,
        pendingAction: null,
        blocker: null,
        receiptIds: appendUnique(checkpoint.receiptIds, reconciled.receipt.id),
      };
      await this.options.checkpoints.persist(pushed);
      return this.continueDraftPublication(pushed, {
        title: expectString(resumeDraft.title, "pull request title", 1, 256),
        body: expectString(resumeDraft.body, "pull request body", 1, 65_536, {
          allowNewlines: true,
        }),
        binding: trusted,
        signal,
      });
    }

    if (pending.operation === "draft_pull_request_create") {
      const candidates = await this.options.provider.listPullRequestsForHead(
        trusted.owner,
        trusted.repository,
        checkpoint.branch,
        trusted.baseBranch,
        signal,
      );
      if (candidates.length !== 1) {
        return candidates.length === 0
          ? this.resolvePendingNotApplied(
              checkpoint,
              "github_draft_pr_not_applied",
              "Readback proved that no exact draft pull request was created; fresh approval is required before another dispatch.",
            )
          : this.observePendingStillUncertain(
              checkpoint,
              "github_draft_pr_ambiguous",
              "More than one pull request matches the exact head/base; manual reconciliation is required.",
            );
      }
      const pullRequest = await this.options.provider.getPullRequest(
        trusted.owner,
        trusted.repository,
        candidates[0]!.number,
        signal,
      );
      verifyDraftCheckpointPullRequest(pullRequest, checkpoint, trusted);
      const receipt = this.createReconciledReceipt(
        checkpoint,
        pending,
        pullRequest,
        "publish",
        "draft-pr",
      );
      await this.options.persistReconciledReceipt?.(receipt);
      const verified = {
        ...checkpoint,
        status: "draft_pr_verified" as const,
        updatedAt: this.isoNow(),
        pullRequest,
        pendingAction: null,
        blocker: null,
        receiptIds: appendUnique(checkpoint.receiptIds, receipt.id),
      };
      await this.options.checkpoints.persist(verified);
      return verified.completionProof === "draft_pr"
        ? this.finalize(verified)
        : this.refreshProof(verified, trusted, signal);
    }

    if (!checkpoint.pullRequest) {
      throw new DurableLinearContractError(
        "Pull-request mutation reconciliation requires its durable PR readback.",
      );
    }
    const pullRequest = await this.options.provider.getPullRequest(
      trusted.owner,
      trusted.repository,
      checkpoint.pullRequest.number,
      signal,
    );
    if (
      pullRequest.head.sha !== checkpoint.headSha ||
      pullRequest.head.ref !== checkpoint.branch ||
      pullRequest.base.ref !== trusted.baseBranch
    ) {
      return this.resolvePendingNotApplied(
        checkpoint,
        "github_reconciliation_target_drift",
        "Pull-request readback no longer matches the approved head/base; the pending action was not accepted as proof.",
        pullRequest,
      );
    }

    if (pending.operation === "pull_request_ready") {
      if (pullRequest.draft || pullRequest.merged || pullRequest.state !== "open") {
        return this.resolvePendingNotApplied(
          checkpoint,
          "github_ready_not_applied",
          "Readback did not prove the approved ready-for-review transition; fresh approval is required.",
          pullRequest,
        );
      }
      const receipt = this.createReconciledReceipt(
        checkpoint,
        pending,
        pullRequest,
        "update",
        "ready",
      );
      await this.options.persistReconciledReceipt?.(receipt);
      const verified = {
        ...checkpoint,
        status: "draft_pr_verified" as const,
        updatedAt: this.isoNow(),
        pullRequest,
        readyApprovalFingerprint: pending.preparedActionFingerprint,
        pendingAction: null,
        blocker: null,
        receiptIds: appendUnique(checkpoint.receiptIds, receipt.id),
      };
      await this.options.checkpoints.persist(verified);
      return this.refreshProof(verified, trusted, signal);
    }

    if (pending.operation === "pull_request_merge") {
      if (!pullRequest.merged) {
        return this.resolvePendingNotApplied(
          checkpoint,
          "github_merge_not_applied",
          "Readback proved that the pull request was not merged; the stale approval was cleared.",
          pullRequest,
          true,
        );
      }
      const mergeSha = pullRequest.mergeSha;
      if (!mergeSha || !/^[a-f0-9]{40}$/iu.test(mergeSha)) {
        return this.observePendingStillUncertain(
          checkpoint,
          "github_merge_sha_missing",
          "Merged readback lacks the exact merge commit SHA; reconciliation remains pending.",
          pullRequest,
        );
      }
      const receipt = this.createReconciledReceipt(
        checkpoint,
        pending,
        pullRequest,
        "merge",
        "merge",
        mergeSha,
      );
      await this.options.persistReconciledReceipt?.(receipt);
      const verified = {
        ...checkpoint,
        status: "merged_verified" as const,
        updatedAt: this.isoNow(),
        pullRequest,
        mergeSha,
        mergeApprovalFingerprint: pending.preparedActionFingerprint,
        pendingAction: null,
        blocker: null,
        receiptIds: appendUnique(checkpoint.receiptIds, receipt.id),
      };
      await this.options.checkpoints.persist(verified);
      return verified.completionProof === "merged_pr"
        ? this.finalize(verified)
        : verified;
    }
    throw new DurableLinearContractError(
      "Unsupported GitHub publication pending-action operation.",
    );
  }

  private async refreshProof(
    checkpoint: GitHubPublicationCheckpointV1,
    binding: TrustedGitHubPublicationBindingV1,
    signal?: AbortSignal,
  ): Promise<GitHubPublicationCheckpointV1> {
    const pullRequest = checkpoint.pullRequest;
    if (!pullRequest) throw new DurableLinearContractError("Proof refresh requires a pull request.");
    const readback = await this.options.provider.getPullRequest(
      binding.owner,
      binding.repository,
      pullRequest.number,
      signal,
    );
    if (
      readback.state !== "open" ||
      readback.merged ||
      readback.head.sha !== checkpoint.headSha ||
      readback.head.ref !== checkpoint.branch ||
      readback.base.ref !== binding.baseBranch
    ) {
      const blocked = {
        ...checkpoint,
        status: "blocked" as const,
        updatedAt: this.isoNow(),
        pullRequest: readback,
        blocker: {
          code: "github_pull_request_drift",
          message: "The pull request head, base, or state no longer matches the verified publication.",
        },
      };
      await this.options.checkpoints.persist(blocked);
      return blocked;
    }
    const [checks, statuses, reviews] = await Promise.all([
      this.options.provider.listCheckRuns(binding.owner, binding.repository, readback.head.sha, signal),
      this.options.provider.getCombinedStatus(binding.owner, binding.repository, readback.head.sha, signal),
      this.options.provider.listPullRequestReviews(binding.owner, binding.repository, readback.number, signal),
    ]);
    const proofSnapshot = createProofSnapshot(
      readback,
      binding.requiredChecks,
      checks,
      statuses,
      reviews,
      this.isoNow(),
    );
    const status: GitHubPublicationCheckpointStatusV1 =
      proofSnapshot.changesRequestedBy.length > 0
        ? "repair_required"
        : proofSnapshot.failedChecks.length > 0
          ? "blocked"
          : proofSnapshot.pendingChecks.length > 0
            ? "checks_pending"
            : "review_or_merge_ready";
    const next = {
      ...checkpoint,
      status,
      updatedAt: this.isoNow(),
      pullRequest: readback,
      proofSnapshot,
      blocker:
        status === "repair_required"
          ? {
              code: "github_review_repair_required",
              message: "Review changes must return through the local edit and validation loop.",
            }
          : status === "blocked"
            ? {
                code: "github_required_check_failed",
                message: "One or more required GitHub checks failed.",
              }
            : null,
    };
    await this.options.checkpoints.persist(next);
    return next;
  }

  private async finalize(
    checkpoint: GitHubPublicationCheckpointV1,
  ): Promise<GitHubPublicationCheckpointV1> {
    if (!this.options.finalizers || !checkpoint.pullRequest) return checkpoint;
    let current = checkpoint;
    const input: GitHubPublicationFinalizationInputV1 = {
      publicationId: checkpoint.publicationId,
      pullRequest: checkpoint.pullRequest,
      completionProof: checkpoint.completionProof,
      proofRevision:
        checkpoint.completionProof === "merged_pr"
          ? checkpoint.mergeSha as string
          : checkpoint.headSha,
      mergeSha: checkpoint.mergeSha,
    };
    if (!current.linearLinkReceiptId) {
      try {
        const linear = await this.options.finalizers.finalizeLinearLink(input);
        current = {
          ...current,
          status: "linear_linked",
          updatedAt: this.isoNow(),
          linearLinkReceiptId: linear.receiptId,
          receiptIds: appendUnique(current.receiptIds, linear.receiptId),
          blocker: null,
        };
        await this.options.checkpoints.persist(current);
      } catch {
        const linkCommitted = Boolean(current.linearLinkReceiptId);
        current = {
          ...current,
          status: linkCommitted ? "linear_linked" : "waiting_linear_link",
          updatedAt: this.isoNow(),
          blocker: linkCommitted
            ? null
            : {
                code: "github_linear_link_waiting",
                message: "GitHub proof is verified; the exact Linear linkage remains pending.",
              },
        };
        await this.options.checkpoints.persist(current);
        return current;
      }
    }
    if (!current.linearCompletionReceiptId) {
      try {
        const completed = await this.options.finalizers.finalizeLinearCompletion(input);
        current = {
          ...current,
          status: "linear_completed",
          updatedAt: this.isoNow(),
          linearCompletionReceiptId: completed.receiptId,
          receiptIds: appendUnique(current.receiptIds, completed.receiptId),
          blocker: null,
        };
        await this.options.checkpoints.persist(current);
      } catch {
        const completionCommitted = Boolean(current.linearCompletionReceiptId);
        current = {
          ...current,
          status: completionCommitted ? "linear_completed" : "waiting_linear_completion",
          updatedAt: this.isoNow(),
          blocker: completionCommitted
            ? null
            : {
                code: "github_linear_completion_waiting",
                message: "The GitHub link is durable; Linear completion remains pending.",
              },
        };
        await this.options.checkpoints.persist(current);
        return current;
      }
    }
    if (current.obsidianReceiptId) return current;
    try {
      const obsidian = await this.options.finalizers.finalizeObsidian(input);
      current = {
        ...current,
        status: "finalized",
        updatedAt: this.isoNow(),
        obsidianReceiptId: obsidian.receiptId,
        receiptIds: appendUnique(current.receiptIds, obsidian.receiptId),
        blocker: null,
      };
      await this.options.checkpoints.persist(current);
      return current;
    } catch {
      const obsidianCommitted = Boolean(current.obsidianReceiptId);
      current = {
        ...current,
        status: obsidianCommitted ? "finalized" : "waiting_obsidian",
        updatedAt: this.isoNow(),
        blocker: obsidianCommitted
          ? null
          : {
              code: "github_obsidian_finalization_waiting",
              message: "GitHub proof and Linear completion are verified; the Obsidian backlink waits for the core.",
            },
      };
      await this.options.checkpoints.persist(current);
      return current;
    }
  }

  private async continueDraftPublication(
    initial: GitHubPublicationCheckpointV1,
    input: {
      title: string;
      body: string;
      binding: TrustedGitHubPublicationBindingV1;
      signal?: AbortSignal;
    },
  ): Promise<GitHubPublicationCheckpointV1> {
    let checkpoint = initial;
    if (
      checkpoint.bindingFingerprint !== input.binding.bindingFingerprint ||
      checkpoint.remoteSha !== checkpoint.headSha ||
      !checkpoint.publishApprovalFingerprint
    ) {
      throw new DurableLinearContractError(
        "Draft publication continuation does not match verified push proof.",
      );
    }
    const candidates = await this.options.provider.listPullRequestsForHead(
      input.binding.owner,
      input.binding.repository,
      checkpoint.branch,
      input.binding.baseBranch,
      input.signal,
    );
    if (candidates.length > 1) {
      throw new DurableLinearContractError(
        "More than one pull request matched the exact head and base.",
      );
    }
    let pullRequest = candidates[0] ?? null;
    const receiptIds = [...checkpoint.receiptIds];
    if (!pullRequest) {
      checkpoint = await this.persistPendingMutation(checkpoint, {
        operation: "draft_pull_request_create",
        approvalFingerprint: checkpoint.publishApprovalFingerprint,
        targetFingerprint: input.binding.bindingFingerprint,
        resourceId: `github-${checkpoint.publicationId}`,
      });
      try {
        const created = await this.options.provider.createDraftPullRequest(
          {
            owner: input.binding.owner,
            repository: input.binding.repository,
            title: input.title,
            body: input.body,
            head: checkpoint.branch,
            base: input.binding.baseBranch,
          },
          input.signal,
        );
        pullRequest = created.pullRequest;
        receiptIds.push(created.receipt.id);
      } catch {
        return this.markPendingMutationUncertain(
          checkpoint,
          "github_draft_pr_reconcile_required",
          "Draft pull-request dispatch may have committed; exact head/base readback is required before any retry.",
        );
      }
    }
    const readback = await this.options.provider.getPullRequest(
      input.binding.owner,
      input.binding.repository,
      pullRequest.number,
      input.signal,
    );
    verifyDraftCheckpointPullRequest(readback, checkpoint, input.binding);
    checkpoint = {
      ...checkpoint,
      status: "draft_pr_verified",
      updatedAt: this.isoNow(),
      pullRequest: readback,
      receiptIds,
      pendingAction: null,
      blocker: null,
    };
    await this.options.checkpoints.persist(checkpoint);
    if (checkpoint.completionProof === "draft_pr") {
      return this.finalize(checkpoint);
    }
    return this.refreshProof(checkpoint, input.binding, input.signal);
  }

  private async markReviewRepairPushUncertain(
    checkpoint: GitHubPublicationCheckpointV1,
    pending: PendingExternalActionStateV2,
    message: string,
  ): Promise<GitHubPublicationCheckpointV1> {
    const { pendingFingerprint: _pendingFingerprint, ...unsigned } = pending;
    const observedAt = this.isoNow();
    const next: GitHubPublicationCheckpointV1 = {
      ...checkpoint,
      status: "reconcile_required",
      updatedAt: this.isoNow(),
      pendingAction: createPendingExternalActionStateV2({
        ...unsigned,
        dispatchState: "reconcile_required",
        dispatchedAt: observedAt,
        lastObservedAt: observedAt,
        error: {
          code: "github_review_repair_push_reconcile_required",
          message,
        },
      }),
      blocker: {
        code: "github_review_repair_push_reconcile_required",
        message,
      },
    };
    await this.options.checkpoints.persist(next);
    return next;
  }

  private async acceptVerifiedReviewRepairPush(
    checkpoint: GitHubPublicationCheckpointV1,
    push: Extract<
      Awaited<ReturnType<GitHubPublicationPushPortV1["publish"]>>,
      { status: "verified" }
    >,
    handoff: GitHubPublicationHandoffV1,
  ): Promise<GitHubPublicationCheckpointV1> {
    if (push.remoteSha !== handoff.commitSha) {
      throw new DurableLinearContractError(
        "Verified review-repair push readback did not match the repaired commit.",
      );
    }
    const next: GitHubPublicationCheckpointV1 = {
      ...checkpoint,
      status: "pushed_verified",
      updatedAt: this.isoNow(),
      remoteSha: push.remoteSha,
      pendingAction: null,
      blocker: null,
      receiptIds: appendUnique(checkpoint.receiptIds, push.receipt.id),
    };
    await this.options.checkpoints.persist(next);
    return next;
  }

  private async finishVerifiedReviewRepairReadback(
    checkpoint: GitHubPublicationCheckpointV1,
    binding: TrustedGitHubPublicationBindingV1,
    pullRequestNumber: number,
    signal?: AbortSignal,
  ): Promise<GitHubReviewRepairFastForwardResultV1> {
    let pullRequest: GitHubPublicationPullRequestV1;
    try {
      pullRequest = await this.options.provider.getPullRequest(
        binding.owner,
        binding.repository,
        pullRequestNumber,
        signal,
      );
    } catch {
      return {
        status: "reconcile_required",
        checkpoint,
        message: "The branch push is verified, but fresh pull-request readback is still required.",
      };
    }
    if (
      pullRequest.number !== pullRequestNumber ||
      pullRequest.state !== "open" ||
      pullRequest.merged ||
      pullRequest.head.ref !== checkpoint.branch ||
      pullRequest.head.sha !== checkpoint.headSha ||
      pullRequest.base.ref !== binding.baseBranch
    ) {
      return {
        status: "reconcile_required",
        checkpoint,
        message: "The branch push is verified, but the pull-request head/base readback has not converged.",
      };
    }
    const lastReceiptId = checkpoint.receiptIds.at(-1);
    if (!lastReceiptId) {
      throw new DurableLinearContractError(
        "Verified review-repair publication has no durable push receipt.",
      );
    }
    const next: GitHubPublicationCheckpointV1 = {
      ...checkpoint,
      status: "draft_pr_verified",
      updatedAt: this.isoNow(),
      remoteSha: checkpoint.headSha,
      pullRequest,
      proofSnapshot: null,
      pendingAction: null,
      blocker: null,
    };
    await this.options.checkpoints.persist(next);
    return {
      status: "verified",
      checkpoint: next,
      remoteSha: next.headSha,
      receiptIds: [lastReceiptId],
    };
  }

  private async persistPendingMutation(
    checkpoint: GitHubPublicationCheckpointV1,
    input: {
      operation: "draft_pull_request_create" | "pull_request_ready" | "pull_request_merge";
      approvalFingerprint: string;
      targetFingerprint: string;
      resourceId: string;
    },
  ): Promise<GitHubPublicationCheckpointV1> {
    const preparedAt = this.isoNow();
    const pendingAction = createPendingExternalActionStateV2({
      schemaVersion: 2,
      provider: "github",
      operation: input.operation,
      actionId: `github-${input.operation}-${checkpoint.publicationId}`,
      resourceId: input.resourceId,
      preparedActionFingerprint: input.approvalFingerprint,
      targetFingerprint: input.targetFingerprint,
      dispatchState: "prepared",
      attempt: 1,
      preparedAt,
      dispatchedAt: null,
      lastObservedAt: null,
      providerRequestId: null,
      error: {
        code: "github_mutation_prepared",
        message: "GitHub mutation is durably prepared; provider readback is required after uncertain dispatch.",
      },
    });
    const next = {
      ...checkpoint,
      status: "reconcile_required" as const,
      updatedAt: this.isoNow(),
      pendingAction,
      blocker: {
        code: "github_mutation_prepared",
        message: "GitHub mutation is prepared and must be reconciled if dispatch does not return verified readback.",
      },
    };
    await this.options.checkpoints.persist(next);
    return next;
  }

  private async markPendingMutationUncertain(
    checkpoint: GitHubPublicationCheckpointV1,
    code: string,
    message: string,
  ): Promise<GitHubPublicationCheckpointV1> {
    const pending = checkpoint.pendingAction;
    if (!pending) throw new DurableLinearContractError("Pending GitHub mutation state is missing.");
    const { pendingFingerprint: _pendingFingerprint, ...unsigned } = pending;
    const dispatchedAt = this.isoNow();
    const next = {
      ...checkpoint,
      status: "reconcile_required" as const,
      updatedAt: this.isoNow(),
      pendingAction: createPendingExternalActionStateV2({
        ...unsigned,
        dispatchState: "reconcile_required",
        dispatchedAt,
        lastObservedAt: dispatchedAt,
        error: { code, message },
      }),
      blocker: { code, message },
    };
    await this.options.checkpoints.persist(next);
    return next;
  }

  private async resolvePendingNotApplied(
    checkpoint: GitHubPublicationCheckpointV1,
    code: string,
    message: string,
    pullRequest: GitHubPublicationPullRequestV1 | null = checkpoint.pullRequest,
    clearMergeApproval = false,
  ): Promise<GitHubPublicationCheckpointV1> {
    const next = {
      ...checkpoint,
      status: "blocked" as const,
      updatedAt: this.isoNow(),
      pullRequest,
      pendingAction: null,
      ...(clearMergeApproval ? { mergeApprovalFingerprint: null } : {}),
      blocker: { code, message },
    };
    await this.options.checkpoints.persist(next);
    return next;
  }

  private async observePendingStillUncertain(
    checkpoint: GitHubPublicationCheckpointV1,
    code: string,
    message: string,
    pullRequest: GitHubPublicationPullRequestV1 | null = checkpoint.pullRequest,
  ): Promise<GitHubPublicationCheckpointV1> {
    const pending = checkpoint.pendingAction;
    if (!pending) throw new DurableLinearContractError("Pending GitHub mutation state is missing.");
    const { pendingFingerprint: _pendingFingerprint, ...unsigned } = pending;
    const observedAt = this.isoNow();
    const dispatchedAt = pending.dispatchedAt ?? pending.preparedAt;
    const next = {
      ...checkpoint,
      status: "reconcile_required" as const,
      updatedAt: this.isoNow(),
      pullRequest,
      pendingAction: createPendingExternalActionStateV2({
        ...unsigned,
        dispatchState: "reconcile_required",
        dispatchedAt,
        lastObservedAt: observedAt,
        error: { code, message },
      }),
      blocker: { code, message },
    };
    await this.options.checkpoints.persist(next);
    return next;
  }

  private createReconciledReceipt(
    checkpoint: GitHubPublicationCheckpointV1,
    pending: PendingExternalActionStateV2,
    pullRequest: GitHubPublicationPullRequestV1,
    operation: ActionReceipt["operation"],
    action: string,
    mergeSha?: string,
  ): ActionReceipt {
    const committedAt = this.isoNow();
    const observedFingerprint = fingerprintContract({
      action,
      number: pullRequest.number,
      headSha: pullRequest.head.sha,
      base: pullRequest.base.ref,
      draft: pullRequest.draft,
      merged: pullRequest.merged,
      mergeSha: mergeSha ?? null,
    });
    return {
      version: 1,
      id: `github-reconciled-${action}-${checkpoint.publicationId}`,
      runId: this.options.approvalIdentity.runId,
      actionId: pending.actionId,
      toolName: `github_${action}`,
      operation,
      resource: {
        system: "github",
        resourceType: "pull_request",
        id: String(pullRequest.number),
        url: pullRequest.htmlUrl,
        revision: mergeSha ?? pullRequest.head.sha,
      },
      message: `GitHub ${action} mutation was recovered by exact provider readback without redispatch.`,
      payloadFingerprint: pending.preparedActionFingerprint,
      grantId: "github-reconciled-readback",
      idempotencyKey: `github-publication:${checkpoint.publicationId}:${action}`,
      startedAt: pending.preparedAt,
      committedAt,
      commitKind: "reconciled",
      readback: {
        status: "verified",
        checkedAt: committedAt,
        observedRevision: mergeSha ?? pullRequest.head.sha,
        observedFingerprint,
      },
    };
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

export function buildGitHubApprovalPreparedActionV1(input: {
  kind: "publish" | "repair_fast_forward" | "ready" | "merge";
  identity: { runId: string; toolCallId: string; toolName: string };
  preparedAt: string;
  publicationId: string;
  binding: TrustedGitHubPublicationBindingV1;
  branch: string;
  headSha: string;
  previousHeadSha?: string;
  repairId?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  proofSnapshotFingerprint?: string;
  title?: string;
  body?: string;
}): PreparedAction {
  const binding = validateBinding(input.binding);
  const preparedAt = new Date(input.preparedAt).toISOString();
  const headSha = validateGitSha(input.headSha, "GitHub approval head SHA");
  const branch = validateBranch(input.branch);
  const publicationId = expectLogicalKey(
    input.publicationId,
    "GitHub approval publication id",
    180,
  );
  const pullRequestNumber = input.pullRequestNumber;
  if (
    input.kind !== "publish" &&
    (!Number.isSafeInteger(pullRequestNumber) || Number(pullRequestNumber) <= 0)
  ) {
    throw new DurableLinearContractError(
      "GitHub pull request approval requires a positive pull request number.",
    );
  }
  const proofSnapshotFingerprint =
    input.kind === "merge"
      ? expectSha256(
          input.proofSnapshotFingerprint,
          "GitHub merge proof snapshot fingerprint",
        )
      : undefined;
  const previousHeadSha =
    input.kind === "repair_fast_forward"
      ? validateGitSha(
          input.previousHeadSha ?? "",
          "GitHub review-repair previous head SHA",
        )
      : undefined;
  const repairId =
    input.kind === "repair_fast_forward"
      ? expectLogicalKey(input.repairId, "GitHub review-repair id", 180)
      : undefined;
  const requiredConfirmations: 1 | 2 = input.kind === "merge" ? 2 : 1;
  const summary =
    input.kind === "publish"
      ? `Push ${headSha} and create or reuse a draft pull request.`
      : input.kind === "repair_fast_forward"
        ? `Fast-forward pull request #${pullRequestNumber} from ${previousHeadSha} to ${headSha}.`
      : input.kind === "ready"
        ? `Mark pull request #${pullRequestNumber} ready for review.`
        : `Squash merge pull request #${pullRequestNumber} at ${headSha}.`;
  const targetId =
    input.kind === "publish"
      ? `${binding.owner}/${binding.repository}`
      : `${binding.owner}/${binding.repository}#${pullRequestNumber}`;
  const outboundPayload: Record<string, JsonValue> =
    input.kind === "publish"
      ? {
          title: expectString(input.title, "pull request title", 1, 256),
          body: expectString(input.body, "pull request body", 1, 65_536, {
            allowNewlines: true,
          }),
          head: branch,
          base: binding.baseBranch,
          draft: true,
        }
      : input.kind === "ready"
        ? { pullRequestNumber: Number(pullRequestNumber), draft: false }
        : input.kind === "repair_fast_forward"
          ? {
              pullRequestNumber: Number(pullRequestNumber),
              branch,
              previousHeadSha: previousHeadSha as string,
              newHeadSha: headSha,
            }
        : {
            pullRequestNumber: Number(pullRequestNumber),
            sha: headSha,
            mergeMethod: binding.mergeMethod,
            proofSnapshotFingerprint: proofSnapshotFingerprint as string,
          };
  const action: PreparedActionInput = {
    version: 1,
    id: `github-${input.kind}-${publicationId}`,
    runId: expectString(input.identity.runId, "GitHub approval run id", 1, 256),
    toolCallId: expectString(
      input.identity.toolCallId,
      "GitHub approval tool call id",
      1,
      256,
    ),
    toolName: expectString(
      input.identity.toolName,
      "GitHub approval tool name",
      1,
      128,
    ),
    target: {
      system: "github",
      resourceType: input.kind === "publish" ? "repository_branch" : "pull_request",
      id: targetId,
      ...(input.pullRequestUrl
        ? { url: parseHttpUrl(input.pullRequestUrl, "GitHub pull request URL") }
        : {}),
      accountId: binding.accountId,
      repositoryId: `${binding.owner}/${binding.repository}`,
      repositoryProfileId: binding.profileKey,
      revision: headSha,
    },
    relatedResources: [],
    normalizedArgs: {
      kind: input.kind,
      publicationId,
      bindingFingerprint: binding.bindingFingerprint,
      branch,
      headSha,
      baseBranch: binding.baseBranch,
      ...(proofSnapshotFingerprint ? { proofSnapshotFingerprint } : {}),
      ...(previousHeadSha ? { previousHeadSha } : {}),
      ...(repairId ? { repairId } : {}),
    },
    preview: {
      summary,
      destination:
        `GitHub ${binding.owner}/${binding.repository} ` +
        (input.kind === "publish" ? `${branch} -> ${binding.baseBranch}` : `PR #${pullRequestNumber}`),
      outboundPayload,
      warnings:
        input.kind === "merge"
          ? ["Merge is irreversible and approval becomes invalid if the head, checks, or review snapshot changes."]
          : [],
      outboundBytes: new TextEncoder().encode(JSON.stringify(outboundPayload)).byteLength,
    },
    expectedTargetRevision: headSha,
    idempotencyKey:
      `github-publication:${publicationId}:${input.kind}` +
      (repairId ? `:${repairId}` : ""),
    reconciliationKey:
      input.kind === "publish"
        ? `github-ref:${binding.owner}/${binding.repository}:refs/heads/${branch}`
        : `github-pr:${binding.owner}/${binding.repository}:${pullRequestNumber}`,
    preparedAt,
    expiresAt: new Date(Date.parse(preparedAt) + 120_000).toISOString(),
    requiredConfirmations,
  };
  return { ...action, payloadFingerprint: fingerprintContract(action) };
}

export function createProofSnapshot(
  pullRequest: GitHubPublicationPullRequestV1,
  requiredChecks: readonly string[],
  checks: readonly GitHubPublicationCheckV1[],
  statuses: readonly GitHubPublicationStatusV1[],
  reviews: readonly GitHubPublicationReviewV1[],
  checkedAt: string,
): GitHubPublicationProofSnapshotV1 {
  const required = parseUniqueStrings(
    [...requiredChecks],
    "required GitHub checks",
    0,
    64,
    200,
  );
  const passedChecks: string[] = [];
  const pendingChecks: string[] = [];
  const failedChecks: string[] = [];
  for (const name of required) {
    const matchingChecks = checks.filter((check) => check.name === name);
    const matchingStatuses = statuses.filter((status) => status.context === name);
    if (
      matchingChecks.some(
        (check) => check.status === "completed" && check.conclusion === "success",
      ) || matchingStatuses.some((status) => status.state === "success")
    ) {
      passedChecks.push(name);
    } else if (
      matchingChecks.some(
        (check) => check.status !== "completed" || !check.conclusion,
      ) || matchingStatuses.some((status) => ["pending", "expected"].includes(status.state)) ||
      (matchingChecks.length === 0 && matchingStatuses.length === 0)
    ) {
      pendingChecks.push(name);
    } else {
      failedChecks.push(name);
    }
  }
  const latestReviews = new Map<string, GitHubPublicationReviewV1>();
  for (const review of [...reviews].sort((left, right) =>
    left.submittedAt.localeCompare(right.submittedAt) || left.id - right.id,
  )) {
    latestReviews.set(review.userLogin, review);
  }
  const approvingReviewers = [...latestReviews.values()]
    .filter((review) => review.state === "APPROVED")
    .map((review) => review.userLogin)
    .sort();
  const changesRequestedBy = [...latestReviews.values()]
    .filter((review) => review.state === "CHANGES_REQUESTED")
    .map((review) => review.userLogin)
    .sort();
  const observed = {
    headSha: validateGitSha(pullRequest.head.sha, "pull request head SHA"),
    pullRequestUpdatedAt: expectString(
      pullRequest.updatedAt,
      "pull request update time",
      20,
      30,
    ),
    requiredChecks: required,
    passedChecks,
    pendingChecks,
    failedChecks,
    approvingReviewers,
    changesRequestedBy,
  };
  const unsigned = {
    ...observed,
    checkedAt: expectString(checkedAt, "GitHub proof check time", 20, 30),
  };
  return { ...unsigned, snapshotFingerprint: fingerprintContract(observed) };
}

export function isGitHubPublicationLineageProofCheckpointV1(
  checkpoint: GitHubPublicationCheckpointV1 | null,
  input: {
    handoffFingerprint: string;
    headSha: string;
    pullRequestNumber: number;
    completionProof: GitHubPublicationCompletionProofV1;
    mergeSha: string | null;
  },
): checkpoint is GitHubPublicationCheckpointV1 {
  if (
    !checkpoint ||
    checkpoint.handoffFingerprint !== input.handoffFingerprint ||
    checkpoint.headSha !== input.headSha ||
    checkpoint.remoteSha !== input.headSha ||
    checkpoint.pullRequest?.number !== input.pullRequestNumber ||
    checkpoint.completionProof !== input.completionProof ||
    !checkpoint.publishApprovalFingerprint
  ) {
    return false;
  }
  const retryStatuses: GitHubPublicationCheckpointStatusV1[] = [
    "waiting_linear_link",
    "waiting_linear",
  ];
  if (input.completionProof === "draft_pr") {
    return (
      ["draft_pr_verified", ...retryStatuses].includes(checkpoint.status) &&
      !checkpoint.pullRequest.merged &&
      checkpoint.pullRequest.draft &&
      input.mergeSha === null
    );
  }
  return (
    ["merged_verified", ...retryStatuses].includes(checkpoint.status) &&
    checkpoint.pullRequest.merged &&
    checkpoint.mergeSha === input.mergeSha &&
    Boolean(input.mergeSha) &&
    Boolean(checkpoint.mergeApprovalFingerprint) &&
    Boolean(checkpoint.proofSnapshot)
  );
}

function validatePublishRequest(
  request: PublishVerifiedCodeRequestV1,
): PublishVerifiedCodeRequestV1 {
  if (request.explicitUserMission !== true) {
    throw new DurableLinearContractError(
      "GitHub publication requires an explicit current user mission.",
    );
  }
  const binding = validateBinding(request.binding);
  const handoff = validateHandoff(request.handoff);
  if (binding.profileKey !== handoff.profileKey) {
    throw new DurableLinearContractError(
      "GitHub binding and verified code handoff profile keys do not match.",
    );
  }
  if (
    request.completionProof !== undefined &&
    request.completionProof !== "draft_pr" &&
    request.completionProof !== "merged_pr"
  ) {
    throw new DurableLinearContractError(
      "GitHub publication completion proof is invalid.",
    );
  }
  return {
    ...request,
    publicationId: expectLogicalKey(request.publicationId, "GitHub publication id", 180),
    title: expectString(request.title, "pull request title", 1, 256),
    body: expectString(request.body, "pull request body", 1, 65_536, {
      allowNewlines: true,
    }),
    completionProof:
      request.completionProof === "draft_pr" ? "draft_pr" : "merged_pr",
    handoff,
    binding,
  };
}

function validateReviewRepairPublishRequest(
  request: PublishVerifiedReviewRepairFastForwardRequestV1,
): PublishVerifiedReviewRepairFastForwardRequestV1 {
  const repairId = expectLogicalKey(request.repairId, "GitHub review-repair id", 180);
  const binding = validateBinding(request.binding);
  const handoff = validateHandoff(request.handoff);
  const expectedRemoteHeadSha = validateGitSha(
    request.expectedRemoteHeadSha,
    "GitHub review-repair previous head SHA",
  );
  const previousHandoffFingerprint = expectSha256(
    request.previousHandoffFingerprint,
    "GitHub review-repair previous handoff fingerprint",
  );
  const pullRequestNumber = positivePullRequestNumber(request.pullRequestNumber);
  const checkpoint = request.checkpoint;
  if (
    checkpoint.status !== "repair_required" ||
    checkpoint.bindingFingerprint !== binding.bindingFingerprint ||
    checkpoint.handoffFingerprint !== previousHandoffFingerprint ||
    checkpoint.headSha !== expectedRemoteHeadSha ||
    checkpoint.remoteSha !== expectedRemoteHeadSha ||
    checkpoint.branch !== handoff.agentBranch ||
    checkpoint.pullRequest?.number !== pullRequestNumber ||
    checkpoint.pullRequest.head.sha !== expectedRemoteHeadSha ||
    checkpoint.pullRequest.head.ref !== handoff.agentBranch ||
    checkpoint.pullRequest.base.ref !== binding.baseBranch ||
    checkpoint.pullRequest.state !== "open" ||
    checkpoint.pullRequest.merged ||
    checkpoint.completionProof !== "merged_pr"
  ) {
    throw new DurableLinearContractError(
      "Review repair requires the exact open pull request, verified remote head, publication checkpoint, and trusted binding.",
    );
  }
  if (
    handoff.profileKey !== binding.profileKey ||
    handoff.baseSha !== expectedRemoteHeadSha ||
    handoff.commitSha === expectedRemoteHeadSha
  ) {
    throw new DurableLinearContractError(
      "Review-repair handoff is not a new verified descendant for the trusted publication profile.",
    );
  }
  return {
    ...request,
    repairId,
    binding,
    handoff,
    expectedRemoteHeadSha,
    previousHandoffFingerprint,
    pullRequestNumber,
  };
}

function validateReviewRepairReconcileRequest(
  request: ReconcileVerifiedReviewRepairFastForwardRequestV1,
): ReconcileVerifiedReviewRepairFastForwardRequestV1 {
  const repairId = expectLogicalKey(request.repairId, "GitHub review-repair id", 180);
  const binding = validateBinding(request.binding);
  const handoff = validateHandoff(request.handoff);
  const expectedOldHeadSha = validateGitSha(
    request.expectedOldHeadSha,
    "GitHub review-repair previous head SHA",
  );
  const pullRequestNumber = positivePullRequestNumber(request.pullRequestNumber);
  const checkpoint = request.checkpoint;
  const allowedStatuses: GitHubPublicationCheckpointStatusV1[] = [
    "push_prepared",
    "pushed_verified",
    "draft_pr_verified",
    "checks_pending",
    "repair_required",
    "review_or_merge_ready",
    "blocked",
    "reconcile_required",
  ];
  if (
    !allowedStatuses.includes(checkpoint.status) ||
    checkpoint.bindingFingerprint !== binding.bindingFingerprint ||
    checkpoint.handoffFingerprint !== handoff.handoffFingerprint ||
    checkpoint.headSha !== handoff.commitSha ||
    checkpoint.branch !== handoff.agentBranch ||
    checkpoint.repairBaseSha !== expectedOldHeadSha ||
    checkpoint.repairId !== repairId ||
    checkpoint.repairPullRequestNumber !== pullRequestNumber ||
    handoff.profileKey !== binding.profileKey ||
    handoff.baseSha !== expectedOldHeadSha ||
    handoff.commitSha === expectedOldHeadSha ||
    (checkpoint.remoteSha !== null && checkpoint.remoteSha !== handoff.commitSha) ||
    (checkpoint.pullRequest !== null && checkpoint.pullRequest.number !== pullRequestNumber)
  ) {
    throw new DurableLinearContractError(
      "Review-repair reconciliation does not match the exact durable repair epoch and verified handoff.",
    );
  }
  return {
    ...request,
    repairId,
    binding,
    handoff,
    expectedOldHeadSha,
    pullRequestNumber,
  };
}

function validateHandoff(
  handoff: GitHubPublicationHandoffV1,
): GitHubPublicationHandoffV1 {
  const agentBranch = validateBranch(handoff.agentBranch);
  if (!agentBranch.startsWith("codex/")) {
    throw new DurableLinearContractError(
      "GitHub publication requires an agent-owned codex/ branch.",
    );
  }
  return {
    profileKey: expectLogicalKey(handoff.profileKey, "publication profile key"),
    workspaceId: expectLogicalKey(handoff.workspaceId, "publication workspace id", 180),
    agentBranch,
    baseSha: validateGitSha(handoff.baseSha, "publication base SHA"),
    commitSha: validateGitSha(handoff.commitSha, "publication commit SHA"),
    treeSha: validateGitSha(handoff.treeSha, "publication tree SHA"),
    diffFingerprint: expectSha256(handoff.diffFingerprint, "publication diff fingerprint"),
    validationReceiptFingerprints: parseUniqueStrings(
      handoff.validationReceiptFingerprints,
      "validation receipt fingerprints",
      1,
      128,
      71,
      (value, label) => expectSha256(value, label),
    ),
    handoffFingerprint: expectSha256(handoff.handoffFingerprint, "code handoff fingerprint"),
  };
}

function validateBinding(
  binding: TrustedGitHubPublicationBindingV1,
): TrustedGitHubPublicationBindingV1 {
  const owner = githubSegment(binding.owner, "GitHub owner");
  const repository = githubSegment(binding.repository, "GitHub repository");
  const accountLogin = githubSegment(binding.accountLogin, "GitHub account login");
  return {
    bindingFingerprint: expectSha256(binding.bindingFingerprint, "GitHub binding fingerprint"),
    profileKey: expectLogicalKey(binding.profileKey, "GitHub binding profile key"),
    owner,
    repository,
    baseBranch: validateBranch(binding.baseBranch),
    accountId: expectString(binding.accountId, "GitHub account id", 1, 80),
    accountLogin,
    requiredChecks: parseUniqueStrings(
      binding.requiredChecks,
      "required GitHub checks",
      0,
      64,
      200,
    ),
    mergeMethod:
      binding.mergeMethod === "merge" || binding.mergeMethod === "rebase"
        ? binding.mergeMethod
        : "squash",
  };
}

function baseCheckpoint(
  request: PublishVerifiedCodeRequestV1,
  updatedAt: string,
): GitHubPublicationCheckpointV1 {
  return {
    version: 1,
    publicationId: request.publicationId,
    status: "local_verified",
    updatedAt,
    handoffFingerprint: request.handoff.handoffFingerprint,
    bindingFingerprint: request.binding.bindingFingerprint,
    headSha: request.handoff.commitSha,
    branch: request.handoff.agentBranch,
    remoteSha: null,
    mergeSha: null,
    pullRequest: null,
    proofSnapshot: null,
    publishApprovalFingerprint: null,
    readyApprovalFingerprint: null,
    mergeApprovalFingerprint: null,
    completionProof: request.completionProof ?? "merged_pr",
    linearLinkReceiptId: null,
    linearCompletionReceiptId: null,
    obsidianReceiptId: null,
    receiptIds: [],
    pendingAction: null,
    blocker: null,
    repairBaseSha: null,
    repairId: null,
    repairPullRequestNumber: null,
  };
}

function appendUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function verifyDraftPullRequest(
  pullRequest: GitHubPublicationPullRequestV1,
  request: PublishVerifiedCodeRequestV1,
): void {
  parseHttpUrl(pullRequest.htmlUrl, "pull request URL");
  if (
    pullRequest.state !== "open" ||
    pullRequest.merged ||
    !pullRequest.draft ||
    pullRequest.head.ref !== request.handoff.agentBranch ||
    pullRequest.head.sha !== request.handoff.commitSha ||
    pullRequest.base.ref !== request.binding.baseBranch
  ) {
    throw new DurableLinearContractError(
      "Draft pull request readback did not match the verified head, base, and draft state.",
    );
  }
}

function verifyDraftCheckpointPullRequest(
  pullRequest: GitHubPublicationPullRequestV1,
  checkpoint: GitHubPublicationCheckpointV1,
  binding: TrustedGitHubPublicationBindingV1,
): void {
  parseHttpUrl(pullRequest.htmlUrl, "pull request URL");
  if (
    pullRequest.state !== "open" ||
    pullRequest.merged ||
    !pullRequest.draft ||
    pullRequest.head.ref !== checkpoint.branch ||
    pullRequest.head.sha !== checkpoint.headSha ||
    pullRequest.base.ref !== binding.baseBranch
  ) {
    throw new DurableLinearContractError(
      "Reconciled draft pull-request readback did not match the verified head, base, and draft state.",
    );
  }
}

function verifyReviewRepairPullRequest(
  pullRequest: GitHubPublicationPullRequestV1,
  checkpoint: GitHubPublicationCheckpointV1,
  binding: TrustedGitHubPublicationBindingV1,
  expectedHeadSha: string,
  pullRequestNumber: number,
): void {
  parseHttpUrl(pullRequest.htmlUrl, "review-repair pull request URL");
  if (
    pullRequest.number !== pullRequestNumber ||
    pullRequest.state !== "open" ||
    pullRequest.merged ||
    pullRequest.head.ref !== checkpoint.branch ||
    pullRequest.head.sha !== expectedHeadSha ||
    pullRequest.base.ref !== binding.baseBranch
  ) {
    throw new DurableLinearContractError(
      "Fresh pull-request readback did not preserve the exact review-repair head, base, and open state.",
    );
  }
}

function positivePullRequestNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DurableLinearContractError("GitHub pull request number must be a positive integer.");
  }
  return value;
}

function requireApproval(
  decision: GitHubPublicationApprovalDecisionV1,
  expectedFingerprint: string,
  requiredConfirmations: 1 | 2,
): void {
  if (
    !decision.approved ||
    decision.approvalFingerprint !== expectedFingerprint ||
    (requiredConfirmations === 2 && decision.confirmations !== 2)
  ) {
    throw new DurableLinearContractError(
      requiredConfirmations === 2
        ? "GitHub merge requires a fresh double-exact approval."
        : "GitHub action requires the exact prepared approval fingerprint.",
    );
  }
}

function githubSegment(value: string, label: string): string {
  const segment = expectString(value, label, 1, 100);
  if (!/^[A-Za-z0-9_.-]+$/u.test(segment)) {
    throw new DurableLinearContractError(`${label} is invalid.`);
  }
  return segment;
}

function validateBranch(value: string): string {
  const branch = expectString(value, "Git branch", 1, 255);
  if (
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\s~^:?*[\\\]]/u.test(branch)
  ) {
    throw new DurableLinearContractError("Git branch is invalid.");
  }
  return branch;
}

function validateGitSha(value: string, label: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new DurableLinearContractError(`${label} must be a complete Git object id.`);
  }
  return value;
}
