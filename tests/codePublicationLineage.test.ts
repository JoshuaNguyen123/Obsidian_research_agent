import assert from "node:assert/strict";
import test from "node:test";

import {
  CodePublicationLineageErrorV1,
  ResearchPublicationCheckpointStoreV1,
  advanceCodePublicationLineageV1,
  appendWorkItemLineageTransitionV1,
  createAcceptedResearchArtifactV1,
  createExternalWorkItemBindingV1,
  createWorkItemLineageV1,
  latestCodePublicationLineageStateV1,
  resolveQueueCodePublicationOriginV1,
  resolveVerifiedCodePublicationOriginV1,
  type CodePublicationLineageTransitionV1,
  type ResearchPublicationCheckpointNamespaceV1,
  type ResearchPublicationCheckpointPersistenceV1,
  type ResearchPublicationCheckpointV1,
} from "../src/integrations/linear";

const ACCEPTED_AT = "2026-07-13T16:00:00.000Z";
const NOTE_AT = "2026-07-13T16:01:00.000Z";
const LINEAR_AT = "2026-07-13T16:02:00.000Z";
const CLAIMED_AT = "2026-07-13T16:03:00.000Z";
const WORKSPACE_AT = "2026-07-13T16:04:00.000Z";
const LOCAL_AT = "2026-07-13T16:05:00.000Z";

const NOTE_HASH = hash("a");
const SOURCE_HASH = hash("b");
const WORK_ITEM_HASH = hash("c");
const APPROVAL_HASH = hash("d");
const ISSUE_HASH = hash("e");
const CLAIM_HASH = hash("1");
const WORKSPACE_HASH = hash("2");
const HANDOFF_HASH = hash("3");

const CLAIM_TRANSITION: CodePublicationLineageTransitionV1 = {
  state: "claimed",
  occurredAt: CLAIMED_AT,
  receiptId: "linear-claim-readback-42",
  evidenceFingerprint: CLAIM_HASH,
};

const WORKSPACE_TRANSITION: CodePublicationLineageTransitionV1 = {
  state: "workspace_ready",
  occurredAt: WORKSPACE_AT,
  receiptId: "workspace-ready-queue-workspace-42",
  evidenceFingerprint: WORKSPACE_HASH,
};

const LOCAL_TRANSITION: CodePublicationLineageTransitionV1 = {
  state: "local_verified",
  occurredAt: LOCAL_AT,
  receiptId: "local-commit-receipt-42",
  evidenceFingerprint: HANDOFF_HASH,
};

test("queued code origin requires exact Linear, note, work-item, and repository lineage", () => {
  const checkpoint = codeCheckpoint();
  const resolved = resolveQueueCodePublicationOriginV1([checkpoint], {
    issueId: "issue-42",
    originRunId: "origin-run-42",
    repositoryKey: "repo-main",
    workItemFingerprint: WORK_ITEM_HASH,
    acceptedResearchArtifactFingerprint: checkpoint.artifact.artifactFingerprint,
  });
  assert.equal(resolved.publicationId, checkpoint.publicationId);

  assert.throws(
    () => resolveQueueCodePublicationOriginV1([checkpoint], {
      issueId: "issue-99",
      originRunId: "origin-run-42",
      repositoryKey: "repo-main",
      workItemFingerprint: WORK_ITEM_HASH,
      acceptedResearchArtifactFingerprint: checkpoint.artifact.artifactFingerprint,
    }),
    (error: unknown) =>
      error instanceof CodePublicationLineageErrorV1 &&
      error.code === "queue_code_origin_unavailable",
  );
  assert.throws(
    () => resolveQueueCodePublicationOriginV1([checkpoint], {
      issueId: "issue-42",
      originRunId: "origin-run-42",
      repositoryKey: "repo-other",
      workItemFingerprint: WORK_ITEM_HASH,
      acceptedResearchArtifactFingerprint: checkpoint.artifact.artifactFingerprint,
    }),
    (error: unknown) =>
      error instanceof CodePublicationLineageErrorV1 &&
      error.code === "queue_code_origin_unavailable",
  );
});

test("code publication lineage is ordered, replay-safe, and cannot rewrite completed proof", () => {
  const checkpoint = codeCheckpoint();
  const local = advanceCodePublicationLineageV1(checkpoint, [
    CLAIM_TRANSITION,
    WORKSPACE_TRANSITION,
    LOCAL_TRANSITION,
  ]);
  assert.equal(latestCodePublicationLineageStateV1(local), "local_verified");
  assert.equal(local.lineage?.events.length, 6);

  const replay = advanceCodePublicationLineageV1(local, [
    CLAIM_TRANSITION,
    WORKSPACE_TRANSITION,
    LOCAL_TRANSITION,
  ]);
  assert.strictEqual(replay, local);
  assert.throws(
    () => advanceCodePublicationLineageV1(local, [{
      ...LOCAL_TRANSITION,
      evidenceFingerprint: hash("4"),
    }]),
    (error: unknown) =>
      error instanceof CodePublicationLineageErrorV1 &&
      error.code === "code_lineage_replay_mismatch",
  );
  assert.throws(
    () => advanceCodePublicationLineageV1(checkpoint, [LOCAL_TRANSITION]),
    (error: unknown) =>
      error instanceof CodePublicationLineageErrorV1 &&
      error.code === "code_lineage_transition_gap",
  );
});

test("draft-pr completion policy finalizes lineage without fabricating check or merge proof", () => {
  const local = advanceCodePublicationLineageV1(codeCheckpoint(), [
    CLAIM_TRANSITION,
    WORKSPACE_TRANSITION,
    LOCAL_TRANSITION,
  ]);
  const finalized = advanceCodePublicationLineageV1(local, [
    {
      state: "push_prepared",
      occurredAt: "2026-07-13T16:06:00.000Z",
      receiptId: "github-push-prepared-draft",
      evidenceFingerprint: hash("4"),
    },
    {
      state: "pushed_verified",
      occurredAt: "2026-07-13T16:07:00.000Z",
      receiptId: "github-push-draft",
      evidenceFingerprint: hash("5"),
    },
    {
      state: "draft_pr_verified",
      occurredAt: "2026-07-13T16:08:00.000Z",
      receiptId: "github-draft-proof",
      evidenceFingerprint: hash("6"),
    },
    {
      state: "finalized",
      occurredAt: "2026-07-13T16:09:00.000Z",
      receiptId: "obsidian-draft-backlink",
      evidenceFingerprint: hash("7"),
    },
  ]);
  assert.equal(latestCodePublicationLineageStateV1(finalized), "finalized");
  assert.equal(
    finalized.lineage?.events.some((event) =>
      ["checks_pending", "merge_prepared", "merged_verified"].includes(event.state)),
    false,
  );
});

test("synthetic queue ids resolve publication finalization through durable local commit proof after restart", async () => {
  const persistence = new MemoryPersistence();
  const store = new ResearchPublicationCheckpointStoreV1(persistence);
  const checkpoint = codeCheckpoint();
  await store.upsert(checkpoint);
  const local = advanceCodePublicationLineageV1(checkpoint, [
    CLAIM_TRANSITION,
    WORKSPACE_TRANSITION,
    LOCAL_TRANSITION,
  ]);
  await store.upsert(local);

  const restarted = new ResearchPublicationCheckpointStoreV1(persistence);
  const durable = await restarted.get(checkpoint.publicationId);
  assert.ok(durable);
  const resolved = resolveVerifiedCodePublicationOriginV1(
    await restarted.list(),
    {
      repositoryKey: "repo-main",
      handoffRunId: "queue-code-synthetic-request-id",
      handoffFingerprint: HANDOFF_HASH,
      localCommitReceiptId: LOCAL_TRANSITION.receiptId,
      allowOriginRunFallback: false,
    },
  );
  assert.equal(resolved.publicationId, checkpoint.publicationId);
  assert.equal(resolved.issue?.id, "issue-42");
  assert.equal(resolved.artifact.notePath, "Research/Queue code lineage.md");
  assert.equal(latestCodePublicationLineageStateV1(resolved), "local_verified");

  assert.throws(
    () => resolveVerifiedCodePublicationOriginV1([durable], {
      repositoryKey: "repo-main",
      handoffRunId: "queue-code-synthetic-request-id",
      handoffFingerprint: hash("4"),
      localCommitReceiptId: LOCAL_TRANSITION.receiptId,
      allowOriginRunFallback: false,
    }),
    (error: unknown) =>
      error instanceof CodePublicationLineageErrorV1 &&
      error.code === "verified_code_origin_unavailable",
  );
});

test("foreground publication retains the explicit origin-run compatibility fallback", () => {
  const checkpoint = codeCheckpoint();
  const resolved = resolveVerifiedCodePublicationOriginV1([checkpoint], {
    repositoryKey: "repo-main",
    handoffRunId: "origin-run-42",
    handoffFingerprint: HANDOFF_HASH,
    localCommitReceiptId: "not-yet-recorded",
    allowOriginRunFallback: true,
  });
  assert.equal(resolved.publicationId, checkpoint.publicationId);
});

class MemoryPersistence implements ResearchPublicationCheckpointPersistenceV1 {
  state: ResearchPublicationCheckpointNamespaceV1 | null = null;

  async read(): Promise<unknown | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async write(
    namespace: ResearchPublicationCheckpointNamespaceV1,
    expectedRevision: number,
  ): Promise<boolean> {
    assert.equal(this.state?.revision ?? 0, expectedRevision);
    this.state = structuredClone(namespace);
    return true;
  }
}

function codeCheckpoint(): ResearchPublicationCheckpointV1 {
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "queue-code-artifact-42",
    originRunId: "origin-run-42",
    vaultBindingKey: "primary-vault",
    notePath: "Research/Queue code lineage.md",
    noteSha256: NOTE_HASH,
    noteReceiptId: "research-note-receipt-42",
    evidence: [{
      id: "evidence-42",
      kind: "web",
      reference: "https://example.com/queue-code-source",
      contentSha256: SOURCE_HASH,
    }],
    acceptanceCriteria: [{
      id: "AC-42",
      text: "The verified local commit reaches its required publication proof.",
    }],
    riskClass: "medium",
    acceptedAt: ACCEPTED_AT,
    acceptedBy: "host",
  });
  let lineage = createWorkItemLineageV1({
    schemaVersion: 1,
    lineageId: "publication-queue-code-artifact-42",
    originRunId: artifact.originRunId,
    executionClass: "code",
    workItemFingerprint: WORK_ITEM_HASH,
    researchArtifactFingerprint: artifact.artifactFingerprint,
    repositoryKey: "repo-main",
    events: [{
      sequence: 1,
      state: "accepted_research",
      domain: "research",
      occurredAt: ACCEPTED_AT,
      receiptId: "accepted-queue-code-artifact-42",
      evidenceFingerprint: artifact.artifactFingerprint,
    }],
  });
  lineage = appendWorkItemLineageTransitionV1(lineage, {
    state: "note_verified",
    occurredAt: NOTE_AT,
    receiptId: artifact.noteReceiptId,
    evidenceFingerprint: artifact.noteSha256,
  });
  const binding = createExternalWorkItemBindingV1({
    schemaVersion: 1,
    bindingId: "linear-queue-code-artifact-42",
    provider: "linear",
    originRunId: artifact.originRunId,
    workspaceId: "linear-workspace-acme",
    teamId: "linear-team-eng",
    issueId: "issue-42",
    issueIdentifier: "ENG-42",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueUpdatedAt: LINEAR_AT,
    workItemFingerprint: WORK_ITEM_HASH,
    acceptedResearchArtifactFingerprint: artifact.artifactFingerprint,
    verifiedAt: LINEAR_AT,
  });
  lineage = appendWorkItemLineageTransitionV1(lineage, {
    state: "linear_verified",
    occurredAt: LINEAR_AT,
    receiptId: "linear-readback-receipt-42",
    evidenceFingerprint: binding.bindingFingerprint,
    externalWorkItemBindingFingerprint: binding.bindingFingerprint,
  });
  return {
    schemaVersion: 1,
    publicationId: "publication-queue-code-artifact-42",
    status: "complete",
    updatedAt: LINEAR_AT,
    artifact,
    lineage,
    workItemFingerprint: WORK_ITEM_HASH,
    approvalFingerprint: APPROVAL_HASH,
    binding,
    issue: {
      id: binding.issueId,
      identifier: binding.issueIdentifier,
      url: binding.issueUrl,
      updatedAt: binding.issueUpdatedAt,
      snapshotHash: ISSUE_HASH,
    },
    pendingAction: null,
    backlink: {
      path: artifact.notePath,
      operation: "no_op",
      beforeSha256: artifact.noteSha256,
      afterSha256: artifact.noteSha256,
      issueUrl: binding.issueUrl,
      transaction: null,
    },
    error: null,
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
