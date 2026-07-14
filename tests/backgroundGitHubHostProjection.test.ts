import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1,
  GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1,
  createBackgroundGitHubVerifiedResultV1,
  createHostApprovalReceiptEvidenceV1,
  createPreparedBackgroundGitHubActionV1,
  fingerprintBackgroundGitHubValueV1,
  sealHostApprovalReceiptV1,
  type PreparedBackgroundGitHubActionDraftV1,
  type PreparedBackgroundGitHubActionV1,
} from "../packages/core-api/src";
import {
  parseGitHubPublicationCheckpointV1,
} from "../src/integrations/github/GitHubPublicationCheckpointStore";
import type {
  GitHubPublicationCheckpointV1,
} from "../src/integrations/github/GitHubPublicationWorkflow";
import {
  assertPreparedBackgroundGitHubMissionScopeV1,
  projectBackgroundGitHubPullRequestDocumentV1,
  projectVerifiedBackgroundGitHubCheckpointV1,
} from "../extensions/integrations/host/PreparedBackgroundGitHubHostV1";

const NOW = "2026-07-13T12:00:00.000Z";
const VERIFIED_AT = "2026-07-13T12:01:00.000Z";
const EXPIRES = "2026-07-13T12:15:00.000Z";
const OLD_HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);
const BINDING_FINGERPRINT = fp("1");
const APPROVAL_KEY = "background-github-host-projection-test";

test("GitHub host compares prepared run ids through the canonical graph projection", () => {
  assert.doesNotThrow(() =>
    assertPreparedBackgroundGitHubMissionScopeV1(
      "run-2026-07-13t03-23-36.470z-abc123",
      "run-2026-07-13T03-23-36.470Z-ABC123",
    ),
  );
  assert.throws(
    () =>
      assertPreparedBackgroundGitHubMissionScopeV1(
        "run-2026-07-13t03-23-36.470z-abc123",
        "run-2026-07-13T03-23-36.470Z-DIFFERENT",
      ),
    /different mission graph/iu,
  );
});

test("GitHub host exports only the companion package's closed pull-request document", () => {
  const title = "Exact draft title";
  const body = "Exact draft body";
  const projected = projectBackgroundGitHubPullRequestDocumentV1({
    version: 1,
    publicationId: "publication-host-projection-1",
    repositoryProfileKey: "profile-host-projection-1",
    title,
    body,
    titleFingerprint: fingerprintBackgroundGitHubValueV1(title),
    bodyFingerprint: fingerprintBackgroundGitHubValueV1(body),
    preparedAt: NOW,
    fingerprint: fp("2"),
  });
  assert.deepEqual(Object.keys(projected ?? {}).sort(), [
    "body",
    "bodyFingerprint",
    "title",
    "titleFingerprint",
  ]);
  assert.equal(projected?.title, title);
  assert.equal(projected?.body, body);
  assert.equal(projectBackgroundGitHubPullRequestDocumentV1(null), null);
});

test("verified review repair advances one exact epoch and replay is a no-op", () => {
  const current = reviewRepairCheckpoint();
  const action = reviewRepairAction(current);
  const result = createBackgroundGitHubVerifiedResultV1({
    operation: action.operation,
    publicationId: action.payload.publicationId,
    repositoryBindingFingerprint: action.binding.repositoryBindingFingerprint,
    verifiedAccountId: action.binding.verifiedAccountId,
    checkpointFingerprint: fp("2"),
    headSha: action.payload.newHeadSha,
    pullRequestNumber: action.payload.pullRequestNumber,
    mergeSha: null,
    autoMergeEnabled: false,
    verifiedAt: VERIFIED_AT,
  });
  const receiptIds = [...current.receiptIds, "receipt-review-repair"];

  const projected = projectVerifiedBackgroundGitHubCheckpointV1(
    current,
    action,
    result,
    receiptIds,
  );
  assert.equal(projected.status, "draft_pr_verified");
  assert.equal(projected.handoffFingerprint, action.payload.handoffFingerprint);
  assert.equal(projected.headSha, NEW_HEAD);
  assert.equal(projected.remoteSha, NEW_HEAD);
  assert.equal(projected.pullRequest?.head.sha, NEW_HEAD);
  assert.equal(projected.proofSnapshot, null);
  assert.equal(projected.repairBaseSha, OLD_HEAD);
  assert.equal(projected.repairId, action.payload.repairId);
  assert.equal(projected.repairPullRequestNumber, 12);
  assert.deepEqual(projected.receiptIds, receiptIds);

  assert.deepEqual(
    projectVerifiedBackgroundGitHubCheckpointV1(
      projected,
      action,
      result,
      receiptIds,
    ),
    projected,
  );

  const drifted = parseGitHubPublicationCheckpointV1({
    ...current,
    updatedAt: "2026-07-13T12:00:30.000Z",
  });
  assert.throws(
    () =>
      projectVerifiedBackgroundGitHubCheckpointV1(
        drifted,
        action,
        result,
        receiptIds,
      ),
    /checkpoint changed after the exact external action was prepared/iu,
  );
});

test("verified auto-merge enablement retains fresh proof and replay cannot duplicate it", () => {
  const current = mergeReadyCheckpoint();
  const action = autoMergeAction(current);
  const result = createBackgroundGitHubVerifiedResultV1({
    operation: action.operation,
    publicationId: action.payload.publicationId,
    repositoryBindingFingerprint: action.binding.repositoryBindingFingerprint,
    verifiedAccountId: action.binding.verifiedAccountId,
    checkpointFingerprint: fp("3"),
    headSha: action.payload.headSha,
    pullRequestNumber: action.payload.pullRequestNumber,
    mergeSha: null,
    autoMergeEnabled: true,
    verifiedAt: VERIFIED_AT,
  });
  const receiptIds = [...current.receiptIds, "receipt-auto-merge"];

  const projected = projectVerifiedBackgroundGitHubCheckpointV1(
    current,
    action,
    result,
    receiptIds,
  );
  assert.equal(projected.status, "checks_pending");
  assert.equal(
    projected.mergeApprovalFingerprint,
    action.preparedActionFingerprint,
  );
  assert.deepEqual(projected.proofSnapshot, current.proofSnapshot);
  assert.equal(projected.pullRequest?.merged, false);
  assert.deepEqual(projected.receiptIds, receiptIds);
  assert.deepEqual(
    projectVerifiedBackgroundGitHubCheckpointV1(
      projected,
      action,
      result,
      receiptIds,
    ),
    projected,
  );

  const falseProof = createBackgroundGitHubVerifiedResultV1({
    operation: result.operation,
    publicationId: result.publicationId,
    repositoryBindingFingerprint: result.repositoryBindingFingerprint,
    verifiedAccountId: result.verifiedAccountId,
    checkpointFingerprint: result.checkpointFingerprint,
    headSha: result.headSha,
    pullRequestNumber: result.pullRequestNumber,
    mergeSha: result.mergeSha,
    autoMergeEnabled: false,
    verifiedAt: result.verifiedAt,
  });
  assert.throws(
    () =>
      projectVerifiedBackgroundGitHubCheckpointV1(
        current,
        action,
        falseProof,
        receiptIds,
      ),
    /does not prove enablement/iu,
  );
});

function reviewRepairCheckpoint(): GitHubPublicationCheckpointV1 {
  return parseGitHubPublicationCheckpointV1({
    ...baseCheckpoint(),
    status: "repair_required",
    headSha: OLD_HEAD,
    remoteSha: OLD_HEAD,
    pullRequest: pullRequest(OLD_HEAD),
    publishApprovalFingerprint: fp("4"),
    receiptIds: ["receipt-push", "receipt-draft-pr"],
    blocker: {
      code: "github_review_repair_required",
      message: "A verified local repair is required.",
    },
  });
}

function mergeReadyCheckpoint(): GitHubPublicationCheckpointV1 {
  return parseGitHubPublicationCheckpointV1({
    ...baseCheckpoint(),
    status: "review_or_merge_ready",
    headSha: NEW_HEAD,
    remoteSha: NEW_HEAD,
    pullRequest: pullRequest(NEW_HEAD),
    proofSnapshot: {
      headSha: NEW_HEAD,
      pullRequestUpdatedAt: "2026-07-13T11:59:00.000Z",
      requiredChecks: ["ci"],
      passedChecks: ["ci"],
      pendingChecks: [],
      failedChecks: [],
      approvingReviewers: ["reviewer"],
      changesRequestedBy: [],
      checkedAt: "2026-07-13T11:59:30.000Z",
      snapshotFingerprint: fp("5"),
    },
    publishApprovalFingerprint: fp("4"),
    receiptIds: ["receipt-push", "receipt-draft-pr"],
  });
}

function baseCheckpoint(): GitHubPublicationCheckpointV1 {
  return {
    version: 1,
    publicationId: "publication-host-projection-1",
    status: "local_verified",
    updatedAt: NOW,
    handoffFingerprint: fp("6"),
    bindingFingerprint: BINDING_FINGERPRINT,
    headSha: NEW_HEAD,
    branch: "codex/host-projection-1",
    remoteSha: null,
    mergeSha: null,
    pullRequest: null,
    proofSnapshot: null,
    publishApprovalFingerprint: null,
    readyApprovalFingerprint: null,
    mergeApprovalFingerprint: null,
    completionProof: "merged_pr",
    linearLinkReceiptId: null,
    linearCompletionReceiptId: null,
    obsidianReceiptId: null,
    receiptIds: [],
    pendingAction: null,
    blocker: null,
  };
}

function reviewRepairAction(
  checkpoint: GitHubPublicationCheckpointV1,
): Extract<
  PreparedBackgroundGitHubActionV1,
  { operation: typeof GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1 }
> {
  const preparedActionFingerprint = fp("7");
  const action = createPreparedBackgroundGitHubActionV1({
    ...commonAction({
      operation: GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1,
      toolName: "github_update_owned_branch",
      preparedActionFingerprint,
      requiredConfirmations: 1,
    }),
    payload: {
      publicationId: checkpoint.publicationId,
      checkpointFingerprint: fingerprintBackgroundGitHubValueV1(checkpoint),
      checkpointStatus: "repair_required",
      workflowApprovalFingerprint: preparedActionFingerprint,
      repairId: "repair-host-projection-1",
      pullRequestNumber: 12,
      branch: checkpoint.branch,
      baseBranch: "main",
      baseSha: OLD_HEAD,
      expectedOldHeadSha: OLD_HEAD,
      newHeadSha: NEW_HEAD,
      previousHandoffFingerprint: checkpoint.handoffFingerprint,
      handoffFingerprint: fp("8"),
    },
  } as PreparedBackgroundGitHubActionDraftV1);
  if (action.operation !== GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1) {
    throw new Error("Review-repair fixture produced the wrong operation.");
  }
  return action;
}

function autoMergeAction(
  checkpoint: GitHubPublicationCheckpointV1,
): Extract<
  PreparedBackgroundGitHubActionV1,
  { operation: typeof GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1 }
> {
  const preparedActionFingerprint = fp("9");
  const action = createPreparedBackgroundGitHubActionV1({
    ...commonAction({
      operation: GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1,
      toolName: "github_enable_auto_merge",
      preparedActionFingerprint,
      requiredConfirmations: 2,
    }),
    payload: {
      publicationId: checkpoint.publicationId,
      checkpointFingerprint: fingerprintBackgroundGitHubValueV1(checkpoint),
      checkpointStatus: "review_or_merge_ready",
      workflowApprovalFingerprint: preparedActionFingerprint,
      pullRequestNumber: 12,
      branch: checkpoint.branch,
      headSha: checkpoint.headSha,
      baseBranch: "main",
      baseSha: OLD_HEAD,
      pullRequestUpdatedAt: checkpoint.pullRequest!.updatedAt,
      proofSnapshotFingerprint: checkpoint.proofSnapshot!.snapshotFingerprint,
      requiredChecksFingerprint: fp("a"),
      mergeMethod: "squash",
    },
  } as PreparedBackgroundGitHubActionDraftV1);
  if (action.operation !== GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1) {
    throw new Error("Auto-merge fixture produced the wrong operation.");
  }
  return action;
}

function commonAction(input: {
  operation:
    | typeof GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1
    | typeof GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1;
  toolName: "github_update_owned_branch" | "github_enable_auto_merge";
  preparedActionFingerprint: string;
  requiredConfirmations: 1 | 2;
}) {
  const preparedActionId = `prepared-${input.operation}`;
  return {
    id: `background-${input.operation}`,
    missionId: "mission-host-projection-1",
    graphRevision: 7,
    capabilityEnvelopeFingerprint: fp("b"),
    nodeId: `node-${input.operation}`,
    nodeFingerprint: fp("c"),
    executionHost: "headless_runtime" as const,
    operation: input.operation,
    toolName: input.toolName,
    descriptorFingerprint: fp("d"),
    preparedActionId,
    preparedActionFingerprint: input.preparedActionFingerprint,
    binding: {
      id: "github-binding-host-projection-1",
      destinationFingerprint: fp("e"),
      repositoryBindingKey: "github-profile-host-projection-1",
      repositoryBindingFingerprint: BINDING_FINGERPRINT,
      repositoryProfileKey: "profile-host-projection-1",
      repositoryProfileFingerprint: fp("f"),
      owner: "acme",
      repository: "research-agent",
      repositoryId: 101,
      verifiedAccountId: 202,
      verifiedAccountLogin: "agent-owner",
      credentialReferenceId: "secret_github-host-projection-1",
    },
    authority: {
      id: `grant-${input.operation}`,
      authorityFingerprint: fp("0"),
      actionFingerprint: input.preparedActionFingerprint,
      consumedAt: "2026-07-13T11:58:00.000Z",
      expiresAt: EXPIRES,
      requiredConfirmations: input.requiredConfirmations,
      confirmationReceipts: Array.from(
        { length: input.requiredConfirmations },
        (_unused, index) =>
          approvalReceipt(
            preparedActionId,
            input.preparedActionFingerprint,
            (index + 1) as 1 | 2,
            input.requiredConfirmations,
          ),
      ),
    },
    idempotencyKey: `github:${input.operation}:host-projection-1`,
    reconciliationKey: `github:${input.operation}:host-projection-1`,
    preparedAt: NOW,
    expiresAt: EXPIRES,
  };
}

function approvalReceipt(
  preparedActionId: string,
  preparedActionFingerprint: string,
  confirmationOrdinal: 1 | 2,
  requiredConfirmations: 1 | 2,
) {
  const evidence = createHostApprovalReceiptEvidenceV1({
    id: `approval-host-projection-${confirmationOrdinal}`,
    preparedActionId,
    preparedActionFingerprint,
    confirmationOrdinal,
    requiredConfirmations,
    decision: "approved",
    hostInstanceFingerprint: fp("1"),
    actorFingerprint: fp("2"),
    sessionFingerprint: fp("3"),
    decidedAt: "2026-07-13T11:57:00.000Z",
  });
  return sealHostApprovalReceiptV1(evidence, {
    signingKeyFingerprint: fp("4"),
    authenticator: createHmac("sha256", APPROVAL_KEY)
      .update(evidence.evidenceFingerprint, "utf8")
      .digest("base64url"),
  });
}

function pullRequest(headSha: string) {
  return {
    number: 12,
    htmlUrl: "https://github.com/acme/research-agent/pull/12",
    state: "open" as const,
    draft: false,
    merged: false,
    head: { ref: "codex/host-projection-1", sha: headSha },
    base: { ref: "main", sha: OLD_HEAD },
    updatedAt: "2026-07-13T11:59:00.000Z",
  };
}

function fp(character: string): string {
  return `sha256:${character.repeat(64).slice(0, 64)}`;
}
