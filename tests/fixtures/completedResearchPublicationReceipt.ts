import type { ActionReceipt } from "../../src/agent/actions";
import {
  appendWorkItemLineageTransitionV1,
  createAcceptedResearchArtifactV1,
  createExternalWorkItemBindingV1,
  createWorkItemLineageV1,
  createWorkItemSpecV2,
  renderQueueExecutableHumanWorkItemSpecV2,
} from "../../src/integrations/linear";

export type CompletedResearchPublicationReceiptFixture = ActionReceipt & {
  output: Record<string, unknown>;
};

export function completedResearchPublicationReceiptFixture(
  publication: "created" | "deduplicated" = "created",
): CompletedResearchPublicationReceiptFixture {
  const acceptedAt = "2026-07-27T20:00:00.000Z";
  const issueUpdatedAt = "2026-07-27T20:02:00.000Z";
  const observedAt =
    publication === "created"
      ? issueUpdatedAt
      : "2026-07-27T20:03:00.000Z";
  const noteSha256 = `sha256:${"a".repeat(64)}`;
  const evidenceSha256 = `sha256:${"b".repeat(64)}`;
  const providerPayloadFingerprint = `sha256:${"c".repeat(64)}`;
  const issueSnapshotHash = `sha256:${"d".repeat(64)}`;
  const backlinkSha256 = `sha256:${"e".repeat(64)}`;
  const approvalFingerprint = `sha256:${"f".repeat(64)}`;
  const issueId = "issue-publication-1";
  const issueIdentifier = "APP-1";
  const issueUrl = "https://linear.app/acme/issue/APP-1";
  const issueTeamId = "team-1";
  const issueProjectId = "project-1";
  const receiptRunId = "segment:run:42";
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-research-publication-1",
    originRunId: "root-publication-run",
    vaultBindingKey: "current-vault",
    notePath: "Research/Accepted publication.md",
    noteSha256,
    noteReceiptId: "note-receipt-1",
    evidence: [
      {
        id: "evidence-1",
        kind: "web",
        reference: "https://example.com/research-source",
        contentSha256: evidenceSha256,
      },
    ],
    acceptanceCriteria: [
      {
        id: "AC-1",
        text: "The accepted research is represented by one verified Linear issue.",
      },
    ],
    riskClass: "medium",
    acceptedAt,
    acceptedBy: "host",
  });
  const workItem = createWorkItemSpecV2({
    schemaVersion: 2,
    ready: true,
    executionClass: "code",
    objective: "Implement the actionable finding from the accepted research.",
    repositoryKey: "agentic-researcher",
    acceptanceCriteria: artifact.acceptanceCriteria,
    validationRequirementKeys: ["unit-tests"],
    evidenceRefs: artifact.evidence.map((entry) => entry.reference),
    riskClass: artifact.riskClass,
    originRunId: artifact.originRunId,
    acceptedResearchArtifactFingerprint: artifact.artifactFingerprint,
    generation: 0,
  });
  const issue = {
    resourceType: "issue" as const,
    id: issueId,
    identifier: issueIdentifier,
    url: issueUrl,
    title: "Accepted research publication",
    description: renderQueueExecutableHumanWorkItemSpecV2(workItem),
    priority: 0,
    trashed: false,
    team: { id: issueTeamId },
    project: { id: issueProjectId },
    state: { id: "state-1" },
    labels: [],
    createdAt: issueUpdatedAt,
    updatedAt: issueUpdatedAt,
    snapshotHash: issueSnapshotHash,
  };
  const binding = createExternalWorkItemBindingV1({
    schemaVersion: 1,
    bindingId: "linear-accepted-research-publication-1",
    provider: "linear",
    originRunId: artifact.originRunId,
    workspaceId: "workspace-1",
    teamId: issueTeamId,
    issueId,
    issueIdentifier,
    issueUrl,
    issueUpdatedAt,
    workItemFingerprint: workItem.fingerprint,
    acceptedResearchArtifactFingerprint: artifact.artifactFingerprint,
    verifiedAt: issueUpdatedAt,
  });
  const resource = {
    system: "linear" as const,
    resourceType: "issue",
    id: issueId,
    identifier: issueIdentifier,
    url: issueUrl,
    teamId: issueTeamId,
    projectId: issueProjectId,
    ...(publication === "deduplicated"
      ? { revision: issueUpdatedAt }
      : {}),
  };
  const createdProviderReceipt = {
    version: 1 as const,
    id: "linear-receipt-created-publication-1",
    runId: receiptRunId,
    actionId: "linear-action-created-publication-1",
    toolName: "linear_create_issue",
    operation: "create",
    resource,
    message: "Created and verified Linear issue APP-1.",
    payloadFingerprint: providerPayloadFingerprint,
    grantId: "grant-linear-create-1",
    idempotencyKey: "linear:issue:create:segment-run-42:publish-call-1:0",
    startedAt: "2026-07-27T20:01:00.000Z",
    committedAt: issueUpdatedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: issueUpdatedAt,
      observedRevision: issueSnapshotHash,
      observedFingerprint: issueSnapshotHash,
    },
  } as const;
  const deduplicatedReceipt = {
    version: 1 as const,
    id: "linear-research-readback-deduplicated-publication-1",
    runId: receiptRunId,
    actionId: "linear-readback-publish-call-1",
    toolName: "linear_read_issue",
    operation: "read",
    resource,
    message:
      "Verified exact duplicate Linear issue APP-1; no mutation grant was created or consumed.",
    payloadFingerprint: approvalFingerprint,
    grantId: "linear-deduplicated-readback",
    idempotencyKey: `research-publication:${workItem.fingerprint}`,
    startedAt: observedAt,
    committedAt: observedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: observedAt,
      observedRevision: issueUpdatedAt,
      observedFingerprint: issueSnapshotHash,
    },
  } as const;
  const outerReceipt =
    publication === "created"
      ? createdProviderReceipt
      : deduplicatedReceipt;
  let lineage = createWorkItemLineageV1({
    schemaVersion: 1,
    lineageId: "publication-accepted-research-publication-1",
    originRunId: artifact.originRunId,
    executionClass: workItem.executionClass,
    workItemFingerprint: workItem.fingerprint,
    researchArtifactFingerprint: artifact.artifactFingerprint,
    repositoryKey: workItem.repositoryKey!,
    events: [
      {
        sequence: 1,
        state: "accepted_research",
        domain: "research",
        occurredAt: acceptedAt,
        receiptId: "accepted-accepted-research-publication-1",
        evidenceFingerprint: artifact.artifactFingerprint,
      },
    ],
  });
  lineage = appendWorkItemLineageTransitionV1(lineage, {
    state: "note_verified",
    occurredAt: acceptedAt,
    receiptId: artifact.noteReceiptId,
    evidenceFingerprint: artifact.noteSha256,
  });
  lineage = appendWorkItemLineageTransitionV1(lineage, {
    state: "linear_verified",
    occurredAt: issueUpdatedAt,
    receiptId:
      publication === "created"
        ? createdProviderReceipt.id
        : `linear-readback-${issueId}`,
    evidenceFingerprint: binding.bindingFingerprint,
    externalWorkItemBindingFingerprint: binding.bindingFingerprint,
  });

  return {
    ...outerReceipt,
    output: {
      ok: true,
      status: "complete",
      publication,
      note: {
        path: artifact.notePath,
        operation: "create",
        beforeSha256: null,
        afterSha256: artifact.noteSha256,
        noteReceiptId: artifact.noteReceiptId,
        artifact: structuredClone(artifact),
        transaction: null,
      },
      artifact,
      lineage,
      approvalFingerprint,
      binding,
      issue,
      backlink: {
        path: artifact.notePath,
        operation: "append",
        beforeSha256: artifact.noteSha256,
        afterSha256: backlinkSha256,
        issueUrl,
        transaction: null,
      },
      receipt:
        publication === "created"
          ? structuredClone(createdProviderReceipt)
          : null,
    },
  };
}
