import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
  GITHUB_PULL_REQUEST_MERGE_OPERATION_V1,
  createPreparedBackgroundGitHubActionV1,
  type PreparedBackgroundGitHubActionDraftV1,
  type PreparedBackgroundGitHubActionV1,
} from "../packages/core-api/src/preparedBackgroundGitHubActionV1";
import { createPreparedBackgroundGitHubPackageIdentityV1 } from "../packages/core-api/src/preparedBackgroundGitHubPackageIdentityV1";
import { createBackgroundGitHubVerifiedResultV1 } from "../packages/core-api/src/backgroundGitHubVerifiedResultV1";
import {
  createHostApprovalReceiptEvidenceV1,
  sealHostApprovalReceiptV1,
} from "../packages/core-api/src/hostApprovalReceiptV1";
import {
  sha256Fingerprint,
  withPreparedActionFingerprint,
} from "../src/agent/actions";
import {
  attachBackgroundGitHubDispatchAttemptV1,
  attachPreparedBackgroundGitHubActionV1,
  buildOperationReconciliationInputs,
  createMissionRuntimeSnapshot,
  createOperationJournalRecord,
  formatMissionRuntimeSnapshotBlock,
  isBackgroundGitHubProofVerifiedV1,
  markBackgroundGitHubJobSubmittedV1,
  parseMissionRuntimeSnapshotFromMarkdown,
  reconcileBackgroundGitHubDispatchAttemptV1,
  transitionOperationJournalRecord,
} from "../src/agent/runStore";
import { createPreparedBackgroundGitHubToolDescriptorV1 } from "../extensions/integrations/host/PreparedBackgroundGitHubToolsV1";

const NOW = "2026-07-13T12:00:00.000Z";
const EXPIRES = "2026-07-13T12:15:00.000Z";
const JOB_ID = "companion-github-0123456789abcdef0123456789abcdef";
const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);
const MERGE = "c".repeat(40);
const APPROVAL_KEY = "background-github-core-wal-test-key";

test("draft PR contract preserves predecessor push proof and requires a fresh workflow approval", () => {
  const preparedActionFingerprint = fp("1");
  const predecessorPushApprovalFingerprint = fp("2");
  const payload = {
    publicationId: "publication-draft-1",
    checkpointFingerprint: fp("3"),
    checkpointStatus: "pushed_verified" as const,
    handoffFingerprint: fp("4"),
    publishApprovalFingerprint: predecessorPushApprovalFingerprint,
    workflowApprovalFingerprint: preparedActionFingerprint,
    branch: "codex/draft-1",
    headSha: HEAD,
    baseBranch: "main",
    baseSha: BASE,
    titleFingerprint: fp("5"),
    bodyFingerprint: fp("6"),
  };
  const action = createPreparedBackgroundGitHubActionV1({
    ...commonAction({
      operation: GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
      toolName: "github_create_draft_pull_request",
      preparedActionFingerprint,
      requiredConfirmations: 1,
    }),
    payload,
  } as PreparedBackgroundGitHubActionDraftV1);
  assert.equal(action.operation, GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1);
  if (action.operation !== GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) return;
  assert.equal(
    action.payload.publishApprovalFingerprint,
    predecessorPushApprovalFingerprint,
  );
  assert.equal(
    action.payload.workflowApprovalFingerprint,
    preparedActionFingerprint,
  );

  assert.throws(
    () =>
      createPreparedBackgroundGitHubActionV1({
        ...commonAction({
          operation: GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
          toolName: "github_create_draft_pull_request",
          preparedActionFingerprint,
          requiredConfirmations: 1,
        }),
        payload: {
          ...payload,
          workflowApprovalFingerprint: predecessorPushApprovalFingerprint,
        },
      } as PreparedBackgroundGitHubActionDraftV1),
    /own exact workflow approval/iu,
  );
});

test("GitHub ActionJournal accepts one full merge proof and rejects auto-merge conflation", async () => {
  const fixture = await mergeJournalFixture();
  assert.equal(fixture.action.authority.confirmationReceipts.length, 2);
  assert.deepEqual(
    fixture.action.authority.confirmationReceipts.map((receipt) => ({
      fingerprint: receipt.preparedActionFingerprint,
      ordinal: receipt.confirmationOrdinal,
      session: receipt.sessionFingerprint,
    })),
    [
      {
        fingerprint: fixture.preparedAction.payloadFingerprint,
        ordinal: 1,
        session: fp("8"),
      },
      {
        fingerprint: fixture.preparedAction.payloadFingerprint,
        ordinal: 2,
        session: fp("8"),
      },
    ],
  );
  assert.equal(
    buildOperationReconciliationInputs([fixture.journal])[0]?.recommendedAction,
    "provider_reconcile",
  );

  const conflated = createBackgroundGitHubVerifiedResultV1({
    ...verifiedMergeEvidence(fixture.action),
    autoMergeEnabled: true,
  });
  assert.throws(
    () =>
      reconcileBackgroundGitHubDispatchAttemptV1(
        fixture.journal,
        [verifiedReceipt(fixture, conflated)],
        new Date("2026-07-13T12:01:00.000Z"),
      ),
    /merge proof does not prove the exact approved pull request/iu,
  );

  const proof = createBackgroundGitHubVerifiedResultV1({
    ...verifiedMergeEvidence(fixture.action),
    autoMergeEnabled: false,
  });
  const receipt = verifiedReceipt(fixture, proof);
  const reconciled = reconcileBackgroundGitHubDispatchAttemptV1(
    fixture.journal,
    [receipt],
    new Date("2026-07-13T12:01:00.000Z"),
  );
  assert.equal(reconciled.state, "readback_verified");
  assert.equal(
    isBackgroundGitHubProofVerifiedV1(reconciled, {
      jobId: JOB_ID,
      actionFingerprint: fixture.action.fingerprint,
      packageIdentityFingerprint: fixture.packageIdentity.fingerprint,
      verifiedReceiptFingerprint: receipt.fingerprint,
      verifiedResultFingerprint: proof.fingerprint,
    }),
    true,
  );

  const snapshot = createMissionRuntimeSnapshot({
    runId: fixture.preparedAction.runId,
    originalMission: "Merge the exact verified PR in the background.",
    operationJournal: [reconciled],
    createdAt: new Date(NOW),
    updatedAt: new Date("2026-07-13T12:01:00.000Z"),
  });
  const restored = parseMissionRuntimeSnapshotFromMarkdown(
    `# Agent Run\n\n${formatMissionRuntimeSnapshotBlock(snapshot)}`,
  )!;
  assert.equal(
    restored.operationJournal[0].backgroundGitHubDispatchAttempt
      ?.verifiedResultFingerprint,
    proof.fingerprint,
  );
  assert.equal(
    restored.operationJournal[0].preparedBackgroundGitHubPackage?.fingerprint,
    fixture.packageIdentity.fingerprint,
  );
});

async function mergeJournalFixture() {
  const descriptor = createPreparedBackgroundGitHubToolDescriptorV1(
    "github_merge_pull_request",
  );
  const preparedAction = await withPreparedActionFingerprint({
    version: 1,
    id: "prepared-github-merge-1",
    runId: "mission-github-core-wal-1",
    toolCallId: "tool-call-github-merge-1",
    toolName: descriptor.name,
    target: {
      system: "github",
      resourceType: "trusted_repository_publication",
      id: "github-profile-1",
      repositoryId: "101",
      repositoryProfileId: "profile-1",
    },
    relatedResources: [],
    normalizedArgs: {
      profileKey: "profile-1",
      publicationId: "publication-merge-1",
    },
    preview: {
      summary: "Merge exact PR #12",
      destination: "acme/research-agent",
      before: { headSha: HEAD },
      after: { mergeMethod: "squash" },
      warnings: ["Fresh proof required."],
      outboundBytes: 0,
    },
    idempotencyKey: "github-merge-publication-1",
    reconciliationKey: "github-merge-publication-1",
    requiredConfirmations: 2,
    preparedAt: NOW,
    expiresAt: EXPIRES,
  });
  const descriptorFingerprint = await sha256Fingerprint(descriptor);
  const action = createPreparedBackgroundGitHubActionV1({
    ...commonAction({
      operation: GITHUB_PULL_REQUEST_MERGE_OPERATION_V1,
      toolName: "github_merge_pull_request",
      preparedActionFingerprint: preparedAction.payloadFingerprint,
      requiredConfirmations: 2,
      descriptorFingerprint,
      preparedActionId: preparedAction.id,
    }),
    missionId: preparedAction.runId,
    payload: {
      publicationId: "publication-merge-1",
      checkpointFingerprint: fp("9"),
      checkpointStatus: "review_or_merge_ready",
      workflowApprovalFingerprint: preparedAction.payloadFingerprint,
      pullRequestNumber: 12,
      branch: "codex/merge-1",
      headSha: HEAD,
      baseBranch: "main",
      baseSha: BASE,
      pullRequestUpdatedAt: "2026-07-13T11:57:00.000Z",
      proofSnapshotFingerprint: fp("a"),
      requiredChecksFingerprint: fp("b"),
      mergeMethod: "squash",
    },
  } as PreparedBackgroundGitHubActionDraftV1);
  if (action.operation !== GITHUB_PULL_REQUEST_MERGE_OPERATION_V1) {
    throw new Error("Merge fixture produced the wrong operation.");
  }
  const packageIdentity = createPreparedBackgroundGitHubPackageIdentityV1({
    packageId: "package-github-merge-1",
    packageFingerprint: fp("c"),
    actionFingerprint: action.fingerprint,
    preparedActionFingerprint: preparedAction.payloadFingerprint,
    operation: action.operation,
    publicationId: action.payload.publicationId,
    repositoryBindingFingerprint: action.binding.repositoryBindingFingerprint,
    repositoryProfileFingerprint: action.binding.repositoryProfileFingerprint,
    verifiedAccountId: action.binding.verifiedAccountId,
    backgroundAuthorizationFingerprint: fp("d"),
    preparedAt: action.preparedAt,
    expiresAt: action.expiresAt,
  });
  let journal = createOperationJournalRecord({
    operationId: "operation-github-merge-1",
    rootRunId: preparedAction.runId,
    segmentId: preparedAction.runId,
    nodeId: action.nodeId,
    toolName: descriptor.name,
    operation: "merge",
    preparedAction,
    descriptor,
    authorization: {
      preparedActionId: preparedAction.id,
      payloadFingerprint: preparedAction.payloadFingerprint,
      grantId: action.authority.id,
    },
    now: new Date(NOW),
  });
  journal = transitionOperationJournalRecord(journal, "applying", {
    message: "Exact merge intent persisted.",
    now: new Date(NOW),
  });
  journal = await attachPreparedBackgroundGitHubActionV1(
    journal,
    action,
    packageIdentity,
    new Date(NOW),
  );
  journal = attachBackgroundGitHubDispatchAttemptV1(
    journal,
    JOB_ID,
    new Date(NOW),
  );
  journal = markBackgroundGitHubJobSubmittedV1(journal, new Date(NOW));
  return { descriptor, preparedAction, action, packageIdentity, journal };
}

function commonAction(input: {
  operation:
    | typeof GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1
    | typeof GITHUB_PULL_REQUEST_MERGE_OPERATION_V1;
  toolName: "github_create_draft_pull_request" | "github_merge_pull_request";
  preparedActionFingerprint: string;
  requiredConfirmations: 1 | 2;
  descriptorFingerprint?: string;
  preparedActionId?: string;
}) {
  const preparedActionId = input.preparedActionId ?? `prepared-${input.operation}`;
  return {
    id: `background-${input.operation}`,
    missionId: "mission-github-core-wal-1",
    graphRevision: 4,
    capabilityEnvelopeFingerprint: fp("3"),
    nodeId: `node-${input.operation}`,
    nodeFingerprint: fp("4"),
    executionHost: "headless_runtime" as const,
    operation: input.operation,
    toolName: input.toolName,
    descriptorFingerprint: input.descriptorFingerprint ?? fp("5"),
    preparedActionId,
    preparedActionFingerprint: input.preparedActionFingerprint,
    binding: {
      id: "github-binding-1",
      destinationFingerprint: fp("6"),
      repositoryBindingKey: "github-profile-1",
      repositoryBindingFingerprint: fp("7"),
      repositoryProfileKey: "profile-1",
      repositoryProfileFingerprint: fp("8"),
      owner: "acme",
      repository: "research-agent",
      repositoryId: 101,
      verifiedAccountId: 202,
      verifiedAccountLogin: "agent-owner",
      credentialReferenceId: "secret_github-credential-1",
    },
    authority: {
      id: `grant-${input.operation}`,
      authorityFingerprint: fp("9"),
      actionFingerprint: input.preparedActionFingerprint,
      consumedAt: "2026-07-13T11:59:00.000Z",
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
    idempotencyKey: `github:${input.operation}:1`,
    reconciliationKey: `github:${input.operation}:1`,
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
    id: `approval-github-${confirmationOrdinal}`,
    preparedActionId,
    preparedActionFingerprint,
    confirmationOrdinal,
    requiredConfirmations,
    decision: "approved",
    hostInstanceFingerprint: fp("6"),
    actorFingerprint: fp("7"),
    sessionFingerprint: fp("8"),
    decidedAt: "2026-07-13T11:58:00.000Z",
  });
  return sealHostApprovalReceiptV1(evidence, {
    signingKeyFingerprint: fp("f"),
    authenticator: createHmac("sha256", APPROVAL_KEY)
      .update(evidence.evidenceFingerprint, "utf8")
      .digest("base64url"),
  });
}

function verifiedMergeEvidence(
  action: Extract<
    PreparedBackgroundGitHubActionV1,
    { operation: typeof GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 }
  >,
) {
  return {
    operation: action.operation,
    publicationId: action.payload.publicationId,
    repositoryBindingFingerprint: action.binding.repositoryBindingFingerprint,
    verifiedAccountId: action.binding.verifiedAccountId,
    checkpointFingerprint: fp("e"),
    headSha: action.payload.headSha,
    pullRequestNumber: action.payload.pullRequestNumber,
    mergeSha: MERGE,
    verifiedAt: "2026-07-13T12:01:00.000Z",
  };
}

function verifiedReceipt(
  fixture: Awaited<ReturnType<typeof mergeJournalFixture>>,
  proof: ReturnType<typeof createBackgroundGitHubVerifiedResultV1>,
) {
  return {
    id: "receipt-github-merge-verified",
    provider: "github",
    operation: fixture.action.operation,
    status: "verified" as const,
    fingerprint: fp("0"),
    payload: {
      attemptId: fixture.journal.backgroundGitHubDispatchAttempt!.attemptId,
      actionFingerprint: fixture.action.fingerprint,
      packageFingerprint: fixture.packageIdentity.packageFingerprint,
      resultFingerprint: proof.fingerprint,
      verifiedResult: proof,
    },
    committedAt: proof.verifiedAt,
  };
}

function fp(character: string): string {
  return `sha256:${character.repeat(64).slice(0, 64)}`;
}
