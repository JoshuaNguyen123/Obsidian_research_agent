import {
  parseVerifiedCodePublicationHandoffV1,
  type VerifiedCodePublicationHandoffV1,
} from "../../../packages/core-api/src/verifiedCodePublicationHandoffV1";
import type { GitHubReviewRepairBindingV1 } from "./GitHubReviewRepairCoordinatorV1";
import {
  GitHubPublicationWorkflowV1,
  type GitHubPublicationCheckpointV1,
  type GitHubPublicationHandoffV1,
  type TrustedGitHubPublicationBindingV1,
} from "./GitHubPublicationWorkflow";
import type { SecureGitHubReviewRepairPublisherV1 } from "./GitHubReviewRepairProductionHostV1";

export interface GitHubReviewRepairPublicationCheckpointReaderV1 {
  get(publicationId: string): Promise<GitHubPublicationCheckpointV1 | null>;
}

export interface GitHubReviewRepairPublicationRuntimeV1 {
  workflow: GitHubPublicationWorkflowV1;
  binding: TrustedGitHubPublicationBindingV1;
}

/**
 * The host resolves credentials, RepositoryProfileV2, secure push gateway, and
 * provider ports. The adapter receives none of their secret material.
 */
export interface GitHubReviewRepairPublicationRuntimeFactoryV1 {
  create(input: {
    repairId: string;
    binding: GitHubReviewRepairBindingV1;
    handoff: VerifiedCodePublicationHandoffV1;
  }): Promise<GitHubReviewRepairPublicationRuntimeV1>;
}

/**
 * Production bridge from the review coordinator to the existing publication
 * checkpoint and VerifiedGitPushGateway-backed workflow.
 */
export class GitHubReviewRepairPublisherAdapterV1
  implements SecureGitHubReviewRepairPublisherV1 {
  constructor(
    private readonly checkpoints: GitHubReviewRepairPublicationCheckpointReaderV1,
    private readonly runtimes: GitHubReviewRepairPublicationRuntimeFactoryV1,
  ) {}

  async publishVerifiedReviewRepairFastForward(
    input: Parameters<SecureGitHubReviewRepairPublisherV1["publishVerifiedReviewRepairFastForward"]>[0],
  ) {
    const handoff = parseVerifiedCodePublicationHandoffV1(input.handoff);
    const checkpoint = await this.requiredCheckpoint(input.publicationId);
    const runtime = await this.runtimes.create({
      repairId: input.repairId,
      binding: input.binding,
      handoff,
    });
    assertRuntimeBinding(runtime.binding, input.binding, handoff);
    const result = await runtime.workflow.publishVerifiedReviewRepairFastForward({
      repairId: input.repairId,
      checkpoint,
      binding: runtime.binding,
      pullRequestNumber: input.pullRequestNumber,
      expectedRemoteHeadSha: input.expectedRemoteHeadSha,
      previousHandoffFingerprint: input.previousHandoffFingerprint,
      handoff: adaptHandoff(handoff),
      signal: input.signal,
    });
    return result.status === "verified"
      ? {
          status: "verified" as const,
          remoteSha: result.remoteSha,
          receiptIds: [...result.receiptIds],
        }
      : result.status === "approval_denied"
        ? {
            status: "blocked" as const,
            message: result.message,
            evidenceFingerprint: result.approvalFingerprint,
          }
      : {
          status: "reconcile_required" as const,
          message: result.message,
        };
  }

  async reconcileVerifiedReviewRepairFastForward(
    input: Parameters<SecureGitHubReviewRepairPublisherV1["reconcileVerifiedReviewRepairFastForward"]>[0],
  ) {
    const handoff = parseVerifiedCodePublicationHandoffV1(input.handoff);
    if (
      handoff.commitSha !== input.expectedNewHeadSha ||
      handoff.fingerprint !== input.handoffFingerprint ||
      handoff.baseSha !== input.expectedOldHeadSha
    ) {
      throw new Error(
        "Review-repair reconciliation handoff does not match the exact expected old and new heads.",
      );
    }
    const checkpoint = await this.requiredCheckpoint(input.publicationId);
    const runtime = await this.runtimes.create({
      repairId: input.repairId,
      binding: input.binding,
      handoff,
    });
    assertRuntimeBinding(runtime.binding, input.binding, handoff);
    const result = await runtime.workflow.reconcileVerifiedReviewRepairFastForward({
      repairId: input.repairId,
      checkpoint,
      binding: runtime.binding,
      pullRequestNumber: input.pullRequestNumber,
      expectedOldHeadSha: input.expectedOldHeadSha,
      handoff: adaptHandoff(handoff),
      signal: input.signal,
    });
    return result.status === "verified"
      ? {
          status: "verified" as const,
          remoteSha: result.remoteSha,
          receiptIds: [...result.receiptIds],
        }
      : {
          status: "reconcile_required" as const,
          message: result.message,
        };
  }

  private async requiredCheckpoint(
    publicationId: string,
  ): Promise<GitHubPublicationCheckpointV1> {
    const checkpoint = await this.checkpoints.get(publicationId);
    if (!checkpoint) {
      throw new Error("The original durable GitHub publication checkpoint is missing.");
    }
    return checkpoint;
  }
}

function adaptHandoff(handoff: VerifiedCodePublicationHandoffV1): GitHubPublicationHandoffV1 {
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

function assertRuntimeBinding(
  runtime: TrustedGitHubPublicationBindingV1,
  requested: GitHubReviewRepairBindingV1,
  handoff: VerifiedCodePublicationHandoffV1,
): void {
  if (
    runtime.bindingFingerprint !== requested.bindingFingerprint ||
    runtime.profileKey !== requested.profileKey ||
    runtime.owner !== requested.owner ||
    runtime.repository !== requested.repository ||
    runtime.baseBranch !== requested.baseBranch ||
    runtime.accountId !== requested.accountId ||
    runtime.accountLogin !== requested.accountLogin ||
    handoff.repositoryProfileKey !== runtime.profileKey ||
    handoff.baseBranch !== runtime.baseBranch
  ) {
    throw new Error(
      "Resolved GitHub publication runtime does not match the exact review-repair binding and verified handoff.",
    );
  }
}
