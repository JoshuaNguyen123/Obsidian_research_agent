import assert from "node:assert/strict";
import test from "node:test";

import {
  appendWorkItemLineageTransitionV1,
  createAcceptedResearchArtifactV1,
  createExternalWorkItemBindingV1,
  createWorkItemLineageV1,
  createWorkItemSpecV2,
  fingerprintContract,
  renderWorkItemSpecV2,
  resolveVerifiedLinearCodeRepositoryBindingV1,
  sha256LinearValue,
  type LinearIssueRecord,
  type ResearchPublicationCheckpointV1,
} from "../src/integrations/linear";

const ACCEPTED_AT = "2026-07-27T16:00:00.000Z";
const NOTE_AT = "2026-07-27T16:01:00.000Z";
const LINEAR_AT = "2026-07-27T16:02:00.000Z";
const ORIGIN_RUN_ID = "origin-run-phase-b";
const REPOSITORY_KEY = "research-agent";
const NOTE_HASH = hash("a");
const SOURCE_HASH = hash("b");
const APPROVAL_HASH = hash("c");

test("verified Linear code contract resolves one trusted repository binding", () => {
  const fixture = codePublicationFixture();
  const result = resolveVerifiedLinearCodeRepositoryBindingV1({
    issueRecord: fixture.issue,
    checkpoints: [fixture.checkpoint],
    trustedRepositoryProfileKeys: [REPOSITORY_KEY],
  });

  assert.deepEqual(result, {
    status: "verified",
    binding: {
      version: 1,
      repositoryProfileKey: REPOSITORY_KEY,
      issueId: fixture.issue.id,
      issueIdentifier: fixture.issue.identifier,
      publicationId: fixture.checkpoint.publicationId,
      workItemFingerprint: fixture.workItem.fingerprint,
      acceptedResearchArtifactFingerprint:
        fixture.checkpoint.artifact.artifactFingerprint,
      originRunId: ORIGIN_RUN_ID,
    },
  });
});

test("signed repository key must exist in the trusted host registry", () => {
  const fixture = codePublicationFixture();
  const result = resolveVerifiedLinearCodeRepositoryBindingV1({
    issueRecord: fixture.issue,
    checkpoints: [fixture.checkpoint],
    trustedRepositoryProfileKeys: ["different-repository"],
  });

  assert.deepEqual(result, {
    status: "rejected",
    code: "linear_code_repository_untrusted",
    reason:
      "The signed repository key is not present in the host's trusted repository registry.",
  });
});

test("tampered signed V2 contract is rejected before durable binding", () => {
  const fixture = codePublicationFixture();
  const issue = replaceDescription(
    fixture.issue,
    fixture.issue.description!.replace(
      fixture.workItem.fingerprint,
      hash("f"),
    ),
  );
  const result = resolveVerifiedLinearCodeRepositoryBindingV1({
    issueRecord: issue,
    checkpoints: [fixture.checkpoint],
    trustedRepositoryProfileKeys: [REPOSITORY_KEY],
  });

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.equal(result.code, "linear_code_contract_invalid");
});

test("current Linear issue identity must match checkpoint and external binding", () => {
  const fixture = codePublicationFixture();
  const issue = rehashIssue({
    ...fixture.issue,
    identifier: "APP-43",
  });
  const result = resolveVerifiedLinearCodeRepositoryBindingV1({
    issueRecord: issue,
    checkpoints: [fixture.checkpoint],
    trustedRepositoryProfileKeys: [REPOSITORY_KEY],
  });

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.equal(result.code, "linear_code_issue_identity_mismatch");
});

test("trashed and stale Linear issue readbacks cannot grant repository authority", async (t) => {
  const fixture = codePublicationFixture();
  const cases: Array<[string, LinearIssueRecord, string]> = [
    [
      "trashed",
      rehashIssue({ ...fixture.issue, trashed: true }),
      "linear_code_issue_trashed",
    ],
    [
      "stale",
      rehashIssue({ ...fixture.issue, updatedAt: NOTE_AT }),
      "linear_code_issue_stale",
    ],
  ];
  for (const [label, issue, code] of cases) {
    await t.test(label, () => {
      const result = resolveVerifiedLinearCodeRepositoryBindingV1({
        issueRecord: issue,
        checkpoints: [fixture.checkpoint],
        trustedRepositoryProfileKeys: [REPOSITORY_KEY],
      });
      assert.equal(result.status, "rejected");
      if (result.status !== "rejected") return;
      assert.equal(result.code, code);
    });
  }
});

test("normalized issue snapshot hash must match the complete current record", () => {
  const fixture = codePublicationFixture();
  const issue = {
    ...fixture.issue,
    title: "Changed without normalized snapshot",
  };
  const result = resolveVerifiedLinearCodeRepositoryBindingV1({
    issueRecord: issue,
    checkpoints: [fixture.checkpoint],
    trustedRepositoryProfileKeys: [REPOSITORY_KEY],
  });

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.equal(result.code, "linear_code_issue_snapshot_invalid");
});

test("verifier snapshot hashing matches the live Linear client canonical hash", async () => {
  const fixture = codePublicationFixture();
  const {
    snapshotHash,
    ...withoutSnapshotHash
  } = fixture.issue;
  assert.equal(
    await sha256LinearValue(withoutSnapshotHash),
    snapshotHash,
  );
});

test("matching but incomplete publication checkpoint is rejected", () => {
  const fixture = codePublicationFixture();
  const incomplete: ResearchPublicationCheckpointV1 = {
    ...fixture.checkpoint,
    status: "linear_verified",
    backlink: null,
  };
  const result = resolveVerifiedLinearCodeRepositoryBindingV1({
    issueRecord: fixture.issue,
    checkpoints: [incomplete],
    trustedRepositoryProfileKeys: [REPOSITORY_KEY],
  });

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.equal(result.code, "linear_code_publication_incomplete");
});

test("ambiguous durable publication origins are rejected", () => {
  const fixture = codePublicationFixture();
  const duplicate: ResearchPublicationCheckpointV1 = {
    ...fixture.checkpoint,
    publicationId: "publication-phase-b-duplicate",
  };
  const result = resolveVerifiedLinearCodeRepositoryBindingV1({
    issueRecord: fixture.issue,
    checkpoints: [fixture.checkpoint, duplicate],
    trustedRepositoryProfileKeys: [REPOSITORY_KEY],
  });

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.equal(result.code, "linear_code_publication_ambiguous");
});

test("unsigned and signed non-code issues are not applicable", async (t) => {
  const fixture = codePublicationFixture();
  const unsigned = replaceDescription(
    fixture.issue,
    "## Proposed work\nHuman-readable text without a signed V2 contract.",
  );
  const researchWorkItem = createWorkItemSpecV2({
    schemaVersion: 2,
    ready: true,
    executionClass: "research",
    objective: "Synthesize the accepted evidence.",
    acceptanceCriteria: [{ id: "AC-1", text: "Evidence is synthesized." }],
    validationRequirementKeys: ["research.evidence"],
    evidenceRefs: ["research:phase-b"],
    riskClass: "low",
    originRunId: ORIGIN_RUN_ID,
    acceptedResearchArtifactFingerprint:
      fixture.checkpoint.artifact.artifactFingerprint,
    generation: 0,
  });
  const nonCode = replaceDescription(
    fixture.issue,
    renderWorkItemSpecV2(researchWorkItem),
  );
  const cases: Array<[string, LinearIssueRecord, string]> = [
    ["unsigned", unsigned, "linear_code_contract_absent"],
    ["non-code", nonCode, "linear_code_contract_non_code"],
  ];
  for (const [label, issue, code] of cases) {
    await t.test(label, () => {
      const result = resolveVerifiedLinearCodeRepositoryBindingV1({
        issueRecord: issue,
        checkpoints: [fixture.checkpoint],
        trustedRepositoryProfileKeys: [REPOSITORY_KEY],
      });
      assert.equal(result.status, "not_applicable");
      if (result.status !== "not_applicable") return;
      assert.equal(result.code, code);
    });
  }
});

function codePublicationFixture() {
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-phase-b",
    originRunId: ORIGIN_RUN_ID,
    vaultBindingKey: "primary-vault",
    notePath: "Research/Phase B.md",
    noteSha256: NOTE_HASH,
    noteReceiptId: "note-receipt-phase-b",
    evidence: [{
      id: "source-1",
      kind: "web",
      reference: "https://example.com/research",
      contentSha256: SOURCE_HASH,
    }],
    acceptanceCriteria: [{
      id: "AC-1",
      text: "The implementation passes its trusted validation profile.",
    }],
    riskClass: "medium",
    acceptedAt: ACCEPTED_AT,
    acceptedBy: "host",
  });
  const workItem = createWorkItemSpecV2({
    schemaVersion: 2,
    ready: true,
    executionClass: "code",
    objective: "Implement the accepted Phase B behavior.",
    repositoryKey: REPOSITORY_KEY,
    acceptanceCriteria: [{
      id: "AC-1",
      text: "The implementation passes its trusted validation profile.",
    }],
    validationRequirementKeys: ["tests.unit", "build.production"],
    evidenceRefs: ["research:phase-b"],
    riskClass: "medium",
    originRunId: ORIGIN_RUN_ID,
    acceptedResearchArtifactFingerprint: artifact.artifactFingerprint,
    generation: 0,
  });
  const issue = makeIssue(renderWorkItemSpecV2(workItem));
  let lineage = createWorkItemLineageV1({
    schemaVersion: 1,
    lineageId: "lineage-phase-b",
    originRunId: ORIGIN_RUN_ID,
    executionClass: "code",
    workItemFingerprint: workItem.fingerprint,
    researchArtifactFingerprint: artifact.artifactFingerprint,
    repositoryKey: REPOSITORY_KEY,
    events: [{
      sequence: 1,
      state: "accepted_research",
      domain: "research",
      occurredAt: ACCEPTED_AT,
      receiptId: "accepted-receipt-phase-b",
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
    bindingId: "linear-accepted-phase-b",
    provider: "linear",
    originRunId: ORIGIN_RUN_ID,
    workspaceId: "workspace-acme",
    teamId: issue.team.id,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    issueUpdatedAt: LINEAR_AT,
    workItemFingerprint: workItem.fingerprint,
    acceptedResearchArtifactFingerprint: artifact.artifactFingerprint,
    verifiedAt: LINEAR_AT,
  });
  lineage = appendWorkItemLineageTransitionV1(lineage, {
    state: "linear_verified",
    occurredAt: LINEAR_AT,
    receiptId: "linear-readback-phase-b",
    evidenceFingerprint: binding.bindingFingerprint,
    externalWorkItemBindingFingerprint: binding.bindingFingerprint,
  });
  const checkpoint: ResearchPublicationCheckpointV1 = {
    schemaVersion: 1,
    publicationId: "publication-accepted-phase-b",
    status: "complete",
    updatedAt: LINEAR_AT,
    artifact,
    lineage,
    workItemFingerprint: workItem.fingerprint,
    approvalFingerprint: APPROVAL_HASH,
    binding,
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      updatedAt: LINEAR_AT,
      snapshotHash: issue.snapshotHash,
    },
    pendingAction: null,
    backlink: {
      path: artifact.notePath,
      operation: "no_op",
      beforeSha256: artifact.noteSha256,
      afterSha256: artifact.noteSha256,
      issueUrl: issue.url,
      transaction: null,
    },
    error: null,
  };
  return { artifact, binding, checkpoint, issue, lineage, workItem };
}

function makeIssue(description: string): LinearIssueRecord {
  return rehashIssue({
    resourceType: "issue",
    id: "issue-phase-b",
    identifier: "APP-42",
    url: "https://linear.app/acme/issue/APP-42",
    title: "Implement accepted Phase B behavior",
    description,
    priority: 2,
    trashed: false,
    team: { id: "team-app", key: "APP", name: "Application" },
    state: { id: "state-todo", name: "Todo", type: "unstarted" },
    labels: [],
    createdAt: ACCEPTED_AT,
    updatedAt: LINEAR_AT,
    snapshotHash: hash("0"),
  });
}

function replaceDescription(
  issue: LinearIssueRecord,
  description: string,
): LinearIssueRecord {
  return rehashIssue({ ...issue, description });
}

function rehashIssue(issue: LinearIssueRecord): LinearIssueRecord {
  const {
    snapshotHash: _ignored,
    ...withoutSnapshotHash
  } = issue;
  return {
    ...withoutSnapshotHash,
    snapshotHash: fingerprintContract(withoutSnapshotHash),
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
