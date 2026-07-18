import assert from "node:assert/strict";
import test from "node:test";

import {
  ResearchPublicationCheckpointStoreError,
  ResearchPublicationCheckpointStoreV1,
  appendWorkItemLineageTransitionV1,
  createAcceptedResearchArtifactV1,
  createExternalWorkItemBindingV1,
  createWorkItemLineageV1,
  parseResearchPublicationCheckpointNamespaceV1,
  type ResearchPublicationCheckpointNamespaceV1,
  type ResearchPublicationCheckpointPersistenceV1,
  type ResearchPublicationCheckpointV1,
} from "../src/integrations/linear";

const ACCEPTED_AT = "2026-07-12T20:00:00.000Z";
const VERIFIED_AT = "2026-07-12T20:01:00.000Z";
const LATER_AT = "2026-07-12T20:02:00.000Z";
const ARTIFACT_HASH = `sha256:${"a".repeat(64)}`;
const NOTE_HASH = `sha256:${"b".repeat(64)}`;
const WORK_ITEM_HASH = `sha256:${"c".repeat(64)}`;
const APPROVAL_HASH = `sha256:${"d".repeat(64)}`;
const ISSUE_HASH = `sha256:${"e".repeat(64)}`;
const REFRESHED_APPROVAL_HASH = `sha256:${"f".repeat(64)}`;

test("checkpoint store serializes concurrent upserts and returns detached deterministic snapshots", async () => {
  const persistence = new MemoryPersistence(8);
  const store = new ResearchPublicationCheckpointStoreV1(persistence);
  const first = noteVerifiedCheckpoint("publication-alpha");
  const second = noteVerifiedCheckpoint("publication-beta");

  await Promise.all([store.upsert(second), store.upsert(first)]);

  assert.equal(persistence.maxActiveWrites, 1);
  assert.equal(persistence.state?.revision, 2);
  const listed = await store.list();
  assert.deepEqual(listed.map((entry) => entry.publicationId), [
    "publication-alpha",
    "publication-beta",
  ]);
  listed[0]!.artifact.notePath = "Research/Tampered.md";
  assert.equal(
    (await store.get("publication-alpha"))?.artifact.notePath,
    "Research/Agent platform.md",
  );
});

test("reconcile_required and waiting_obsidian checkpoints survive plugin-data roundtrip", async () => {
  const persistence = new MemoryPersistence();
  const store = new ResearchPublicationCheckpointStoreV1(persistence);
  const reconcile = reconcileCheckpoint("publication-reconcile");
  const waiting = waitingObsidianCheckpoint("publication-waiting");

  await store.persist(reconcile);
  await store.persist(waiting);

  const restarted = new ResearchPublicationCheckpointStoreV1(persistence);
  assert.deepEqual(await restarted.get(reconcile.publicationId), reconcile);
  assert.deepEqual(await restarted.get(waiting.publicationId), waiting);
  assert.equal((await restarted.get(reconcile.publicationId))?.pendingAction?.actionId, "action-42");
  assert.equal((await restarted.get(waiting.publicationId))?.binding?.issueIdentifier, "ENG-42");
});

test("reconciliation may adopt the same pending issue after a fresh exact approval and verified binding", async () => {
  const persistence = new MemoryPersistence();
  const store = new ResearchPublicationCheckpointStoreV1(persistence);
  const publicationId = "publication-adopt-reconciliation";
  const reconcile = reconcileCheckpoint(publicationId);
  await store.persist(reconcile);
  const { binding, lineage, issue } = linearState();

  await store.persist({
    ...noteVerifiedCheckpoint(publicationId),
    status: "linear_verified",
    updatedAt: LATER_AT,
    lineage,
    approvalFingerprint: REFRESHED_APPROVAL_HASH,
    binding,
    issue,
  });

  const adopted = await store.get(publicationId);
  assert.equal(adopted?.status, "linear_verified");
  assert.equal(adopted?.issue?.id, reconcile.pendingAction?.issueId);
  assert.equal(adopted?.approvalFingerprint, REFRESHED_APPROVAL_HASH);
});

test("checkpoint validation rejects credentials and corrupt cross-contract identity without writing", async () => {
  const persistence = new MemoryPersistence();
  const store = new ResearchPublicationCheckpointStoreV1(persistence);
  const secret = failedCheckpoint("publication-secret");
  secret.error = {
    code: "provider_failed",
    message: "access_token=linear-secret-value",
  };
  await assert.rejects(
    store.upsert(secret),
    /must not contain credentials or secrets/u,
  );

  const corrupt = waitingObsidianCheckpoint("publication-corrupt");
  corrupt.binding = { ...corrupt.binding!, workItemFingerprint: ISSUE_HASH };
  await assert.rejects(
    store.upsert(corrupt),
    /fingerprint does not match|does not match its artifact and lineage/u,
  );
  assert.equal(persistence.writeCount, 0);
});

test("pending states cannot be overwritten by stale workflow stages and persistence conflicts fail closed", async () => {
  const persistence = new MemoryPersistence();
  const store = new ResearchPublicationCheckpointStoreV1(persistence);
  const reconcile = reconcileCheckpoint("publication-transition");
  await store.upsert(reconcile);

  const stale = noteVerifiedCheckpoint("publication-transition");
  await assert.rejects(
    store.upsert(stale),
    (error: unknown) =>
      error instanceof ResearchPublicationCheckpointStoreError &&
      (error.code === "research_publication_checkpoint_stale" ||
        error.code === "research_publication_checkpoint_invalid_transition"),
  );
  assert.equal((await store.get(reconcile.publicationId))?.status, "reconcile_required");

  const conflicting = new MemoryPersistence();
  conflicting.rejectNextWrite = true;
  await assert.rejects(
    new ResearchPublicationCheckpointStoreV1(conflicting).upsert(
      noteVerifiedCheckpoint("publication-conflict"),
    ),
    (error: unknown) =>
      error instanceof ResearchPublicationCheckpointStoreError &&
      error.code === "research_publication_checkpoint_conflict",
  );
});

test("namespace parser rejects unknown fields, mismatched keys, and unsupported versions", () => {
  const checkpoint = noteVerifiedCheckpoint("publication-one");
  assert.throws(
    () => parseResearchPublicationCheckpointNamespaceV1({
      version: 1,
      revision: 1,
      checkpoints: { "publication-other": checkpoint },
    }),
    /key must match its publication id/u,
  );
  assert.throws(
    () => parseResearchPublicationCheckpointNamespaceV1({
      version: 2,
      revision: 0,
      checkpoints: {},
    }),
    /Unsupported research publication checkpoint namespace version/u,
  );
  assert.throws(
    () => parseResearchPublicationCheckpointNamespaceV1({
      version: 1,
      revision: 0,
      checkpoints: {},
      plaintextToken: "linear-secret",
    }),
    /keys are invalid/u,
  );
});

class MemoryPersistence implements ResearchPublicationCheckpointPersistenceV1 {
  state: ResearchPublicationCheckpointNamespaceV1 | null = null;
  activeWrites = 0;
  maxActiveWrites = 0;
  writeCount = 0;
  rejectNextWrite = false;

  constructor(private readonly delayMs = 0) {}

  async read(): Promise<unknown | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async write(
    namespace: ResearchPublicationCheckpointNamespaceV1,
    expectedRevision: number,
  ): Promise<boolean> {
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    try {
      if (this.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.rejectNextWrite) {
        this.rejectNextWrite = false;
        return false;
      }
      assert.equal(this.state?.revision ?? 0, expectedRevision);
      this.state = structuredClone(namespace);
      this.writeCount += 1;
      return true;
    } finally {
      this.activeWrites -= 1;
    }
  }
}

function artifact() {
  return createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "artifact-42",
    originRunId: "run-42",
    vaultBindingKey: "primary-vault",
    notePath: "Research/Agent platform.md",
    noteSha256: NOTE_HASH,
    noteReceiptId: "research-note-42",
    evidence: [{
      id: "evidence-1",
      kind: "web",
      reference: "https://example.com/source",
      contentSha256: ARTIFACT_HASH,
    }],
    acceptanceCriteria: [{ id: "AC-1", text: "The publication is verified." }],
    riskClass: "medium",
    acceptedAt: ACCEPTED_AT,
    acceptedBy: "host",
  });
}

function noteLineage() {
  const accepted = artifact();
  const initial = createWorkItemLineageV1({
    schemaVersion: 1,
    lineageId: "publication-artifact-42",
    originRunId: accepted.originRunId,
    executionClass: "research",
    workItemFingerprint: WORK_ITEM_HASH,
    researchArtifactFingerprint: accepted.artifactFingerprint,
    events: [{
      sequence: 1,
      state: "accepted_research",
      domain: "research",
      occurredAt: ACCEPTED_AT,
      receiptId: "accepted-artifact-42",
      evidenceFingerprint: accepted.artifactFingerprint,
    }],
  });
  return appendWorkItemLineageTransitionV1(initial, {
    state: "note_verified",
    occurredAt: ACCEPTED_AT,
    receiptId: accepted.noteReceiptId,
    evidenceFingerprint: accepted.noteSha256,
  });
}

function linearState() {
  const accepted = artifact();
  const binding = createExternalWorkItemBindingV1({
    schemaVersion: 1,
    bindingId: "linear-artifact-42",
    provider: "linear",
    originRunId: accepted.originRunId,
    workspaceId: "workspace-acme",
    teamId: "team-eng",
    issueId: "issue-42",
    issueIdentifier: "ENG-42",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueUpdatedAt: VERIFIED_AT,
    workItemFingerprint: WORK_ITEM_HASH,
    acceptedResearchArtifactFingerprint: accepted.artifactFingerprint,
    verifiedAt: VERIFIED_AT,
  });
  const lineage = appendWorkItemLineageTransitionV1(noteLineage(), {
    state: "linear_verified",
    occurredAt: VERIFIED_AT,
    receiptId: "linear-readback-42",
    evidenceFingerprint: binding.bindingFingerprint,
    externalWorkItemBindingFingerprint: binding.bindingFingerprint,
  });
  return {
    binding,
    lineage,
    issue: {
      id: "issue-42",
      identifier: "ENG-42",
      url: "https://linear.app/acme/issue/ENG-42",
      updatedAt: VERIFIED_AT,
      snapshotHash: ISSUE_HASH,
    },
  };
}

function noteVerifiedCheckpoint(publicationId: string): ResearchPublicationCheckpointV1 {
  return {
    schemaVersion: 1,
    publicationId,
    status: "note_verified",
    updatedAt: ACCEPTED_AT,
    artifact: artifact(),
    lineage: noteLineage(),
    workItemFingerprint: WORK_ITEM_HASH,
    approvalFingerprint: null,
    binding: null,
    issue: null,
    pendingAction: null,
    backlink: null,
    error: null,
  };
}

function reconcileCheckpoint(publicationId: string): ResearchPublicationCheckpointV1 {
  return {
    ...noteVerifiedCheckpoint(publicationId),
    status: "reconcile_required",
    updatedAt: LATER_AT,
    approvalFingerprint: APPROVAL_HASH,
    pendingAction: {
      provider: "linear",
      operation: "publish_research_ticket",
      actionId: "action-42",
      issueId: "issue-42",
      grantId: "grant-42",
      workItemFingerprint: WORK_ITEM_HASH,
      error: {
        code: "linear_dispatch_ambiguous",
        message: "Linear dispatch outcome requires provider readback.",
      },
    },
    error: {
      code: "linear_dispatch_ambiguous",
      message: "Linear dispatch outcome requires provider readback.",
    },
  };
}

function waitingObsidianCheckpoint(publicationId: string): ResearchPublicationCheckpointV1 {
  const { binding, lineage, issue } = linearState();
  return {
    ...noteVerifiedCheckpoint(publicationId),
    status: "waiting_obsidian",
    updatedAt: LATER_AT,
    lineage,
    approvalFingerprint: APPROVAL_HASH,
    binding,
    issue,
    error: {
      code: "research_publication_backlink_waiting_obsidian",
      message: "Obsidian must reconnect before the backlink can be written.",
    },
  };
}

function failedCheckpoint(publicationId: string): ResearchPublicationCheckpointV1 {
  return {
    schemaVersion: 1,
    publicationId,
    status: "failed",
    updatedAt: ACCEPTED_AT,
    artifact: artifact(),
    lineage: null,
    workItemFingerprint: null,
    approvalFingerprint: null,
    binding: null,
    issue: null,
    pendingAction: null,
    backlink: null,
    error: {
      code: "provider_failed",
      message: "The provider rejected the request.",
    },
  };
}

