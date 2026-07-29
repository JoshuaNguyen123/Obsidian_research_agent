import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMissionAcceptance,
  formatMissionAcceptanceCorrection,
  type MissionAcceptanceReceiptLike,
} from "../src/agent/missionAcceptance";
import type { SetLooseDeliveryReceiptLikeV1 } from "../src/agent/setLooseCompoundAutonomy";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import type { MissionIntent } from "../src/tools/types";
import type { ResearchPlan } from "../src/agent/researchPlan";
import {
  appendWorkItemLineageTransitionV1,
  createAcceptedResearchArtifactV1,
  createExternalWorkItemBindingV1,
  createWorkItemLineageV1,
  createWorkItemSpecV2,
  renderQueueExecutableHumanWorkItemSpecV2,
} from "../src/integrations/linear";

const baseIntent: MissionIntent = {
  mode: "chat_only",
  vaultContext: false,
  noteOutput: false,
  explicitPersistence: false,
  explicitMutation: false,
  explicitDelete: false,
  allowAutonomousWrite: false,
  requireWriteCompletion: false,
  autonomyScope: {
    read: { currentNote: false, vault: false, folders: [], files: [], web: false },
    write: { currentNote: false, folders: [], files: [], artifacts: false, researchMemory: false },
    destructive: { replaceCurrentNote: false, deleteCurrentNote: false, deletePaths: false },
  },
};

function completedResearchPublicationReceipt(
  publication: "created" | "deduplicated",
): MissionAcceptanceReceiptLike & SetLooseDeliveryReceiptLikeV1 {
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
    evidence: [{
      id: "evidence-1",
      kind: "web",
      reference: "https://example.com/research-source",
      contentSha256: evidenceSha256,
    }],
    acceptanceCriteria: [{
      id: "AC-1",
      text: "The accepted research is represented by one verified Linear issue.",
    }],
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
    idempotencyKey:
      "linear:issue:create:segment-run-42:publish-call-1:0",
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
    events: [{
      sequence: 1,
      state: "accepted_research",
      domain: "research",
      occurredAt: acceptedAt,
      receiptId: "accepted-accepted-research-publication-1",
      evidenceFingerprint: artifact.artifactFingerprint,
    }],
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

test("mission acceptance fails when a required write has no receipt", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Write a summary to the current note.",
    missionIntent: { ...baseIntent, requireWriteCompletion: true },
    requiredTools: ["append_to_current_file"],
    successfulTools: [],
    failedTools: [],
    evidence: [],
    receipts: [],
    operationGoals: { current_note_content: "pending" },
    finalOutput: "Done.",
  });

  assert.equal(result.status, "fail");
  assert.equal(result.nextAction, "Complete the required write or mutation with a receipt.");
  assert.ok(result.missing.includes("tool:append_to_current_file"));
  assert.ok(result.missing.includes("write_receipt"));
});

test("mission acceptance asks for more work when source evidence is missing", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Verify this with web sources and citations.",
    missionIntent: baseIntent,
    requiredTools: [],
    successfulTools: [],
    failedTools: [],
    evidence: [],
    receipts: [],
    operationGoals: {},
    finalOutput: "A citation-free answer.",
  });

  assert.equal(result.status, "needs_more_work");
  assert.equal(result.nextAction, "Gather web source evidence.");
  assert.ok(result.missing.includes("web_evidence"));
});

test("named vault Markdown sources do not require unrelated web evidence", () => {
  const result = evaluateMissionAcceptance({
    prompt:
      "Read the named vault notes Sources/Alpha.md and Sources/Beta.md, synthesize two findings, and append them to the current note.",
    missionIntent: {
      ...baseIntent,
      vaultContext: true,
      noteOutput: true,
      explicitPersistence: true,
      explicitMutation: true,
      requireWriteCompletion: true,
    },
    requiredTools: ["read_file", "append_to_current_file"],
    successfulTools: ["read_file", "append_to_current_file"],
    failedTools: [],
    evidence: [
      {
        id: "vault:alpha",
        kind: "vault_note",
        title: "Sources/Alpha.md",
        path: "Sources/Alpha.md",
        summary: "Owned vault evidence.",
        confidence: "high",
      },
    ],
    receipts: [
      {
        toolName: "append_to_current_file",
        operation: "append",
        path: "Current.md",
        bytesWritten: 42,
      },
    ],
    operationGoals: { current_note_content: "completed" },
    finalOutput: "Appended the two findings.",
  });

  assert.equal(result.missing.includes("web_evidence"), false);
  assert.equal(result.status, "pass");
});

test("mission acceptance passes when evidence and receipts satisfy the mission", () => {
  const receipt: MissionAcceptanceReceiptLike = {
    toolName: "append_to_current_file",
    path: "Current.md",
    operation: "append",
    bytesWritten: 42,
  };
  const result = evaluateMissionAcceptance({
    prompt: "Search my vault, cite sources, and write the answer to the note.",
    missionIntent: { ...baseIntent, requireWriteCompletion: true },
    requiredTools: ["inspect_vault_context", "web_fetch", "append_to_current_file"],
    successfulTools: ["inspect_vault_context", "web_fetch", "append_to_current_file"],
    failedTools: [],
    evidence: [
      {
        id: "vault:1",
        kind: "vault_note",
        title: "Vault search",
        summary: "Read two notes.",
        confidence: "high",
      },
      {
        id: "web:1",
        kind: "web_source",
        title: "Fetched source",
        summary: "Fetched source page.",
        confidence: "high",
      },
    ],
    receipts: [receipt],
    operationGoals: { current_note_content: "completed" },
    finalOutput: "Wrote the sourced answer.",
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.missing, []);
  assert.equal(result.confidence, 0.92);
});

test("mission acceptance accepts a scoped persistent artifact receipt without treating it as vault proof", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Draw a three-block architecture diagram.",
    missionIntent: {
      ...baseIntent,
      explicitMutation: true,
      requireWriteCompletion: true,
      autonomyScope: {
        ...baseIntent.autonomyScope,
        write: {
          ...baseIntent.autonomyScope.write,
          artifacts: true,
        },
      },
    },
    requiredTools: ["create_design_canvas"],
    successfulTools: ["create_design_canvas"],
    failedTools: [],
    evidence: [],
    receipts: [
      {
        toolName: "create_design_canvas",
        operation: "create",
        path: "Designs/architecture.canvas",
        bytesWritten: 1_024,
        resource: { system: "workspace", resourceType: "markdown" },
      },
    ],
    operationGoals: {},
    finalOutput: "Created the requested diagram.",
  });

  assert.equal(result.status, "pass");
  assert.ok(!result.missing.includes("write_receipt"));
});

test("mission acceptance does not let an external receipt satisfy artifact or vault proof", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Draw a three-block architecture diagram.",
    missionIntent: {
      ...baseIntent,
      explicitMutation: true,
      requireWriteCompletion: true,
      autonomyScope: {
        ...baseIntent.autonomyScope,
        write: {
          ...baseIntent.autonomyScope.write,
          artifacts: true,
        },
      },
    },
    requiredTools: ["create_design_canvas"],
    successfulTools: ["create_design_canvas"],
    failedTools: [],
    evidence: [],
    receipts: [
      {
        toolName: "linear_create_issue",
        operation: "create",
        path: "Designs/architecture.canvas",
        resource: { system: "linear", resourceType: "issue", id: "LIN-1" },
      },
    ],
    operationGoals: {},
    finalOutput: "Created the requested diagram.",
  });

  assert.equal(result.status, "fail");
  assert.ok(result.missing.includes("write_receipt"));
});

test("mission acceptance accepts a matching external mutation receipt only for that external action", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Create the approved Linear issue.",
    missionIntent: {
      ...baseIntent,
      explicitMutation: true,
      requireWriteCompletion: true,
    },
    requiredTools: ["linear_create_issue"],
    successfulTools: ["linear_create_issue"],
    failedTools: [],
    evidence: [],
    receipts: [
      {
        toolName: "linear_create_issue",
        operation: "create",
        resource: { system: "linear", resourceType: "issue", id: "LIN-2" },
      },
    ],
    operationGoals: {},
    finalOutput: "Created Linear issue LIN-2.",
  });

  assert.equal(result.status, "pass");
  assert.ok(!result.missing.includes("write_receipt"));
});

test("mission acceptance accepts only a strict canonical receipt for atomic research publication", () => {
  for (const publication of ["created", "deduplicated"] as const) {
    const accepted = evaluateMissionAcceptance({
      prompt:
        "Write accepted research into the initiating note, publish it to one Linear issue, and preserve the backlink.",
      missionIntent: {
        ...baseIntent,
        noteOutput: true,
        explicitPersistence: true,
        explicitMutation: true,
        requireWriteCompletion: true,
      },
      requiredTools: ["publish_research_to_linear"],
      successfulTools: ["publish_research_to_linear"],
      failedTools: [],
      evidence: [],
      receipts: [completedResearchPublicationReceipt(publication)],
      operationGoals: { current_note_content: "not_requested" },
      finalOutput: "Accepted research and its Linear backlink are durable.",
    });
    assert.equal(accepted.status, "pass", publication);
    assert.ok(!accepted.missing.includes("write_receipt"), publication);
  }

  const generic = completedResearchPublicationReceipt("created");
  generic.idempotencyKey = "linear-generic-issue:issue-publication-1";
  const rejected = evaluateMissionAcceptance({
    prompt:
      "Write accepted research into the initiating note, publish it to one Linear issue, and preserve the backlink.",
    missionIntent: {
      ...baseIntent,
      noteOutput: true,
      explicitPersistence: true,
      explicitMutation: true,
      requireWriteCompletion: true,
    },
    requiredTools: ["publish_research_to_linear"],
    successfulTools: ["publish_research_to_linear"],
    failedTools: [],
    evidence: [],
    receipts: [generic],
    operationGoals: { current_note_content: "not_requested" },
    finalOutput: "Accepted research and its Linear backlink are durable.",
  });
  assert.equal(rejected.status, "fail");
  assert.ok(rejected.missing.includes("write_receipt"));

  for (const invalid of [
    {
      label: "wrong provider tool",
      mutate: (receipt: MissionAcceptanceReceiptLike) => {
        receipt.toolName = "linear_get_issue";
      },
    },
    {
      label: "mismatched operation",
      mutate: (receipt: MissionAcceptanceReceiptLike) => {
        receipt.operation = "read";
      },
    },
    {
      label: "provider key bound to the wrong segment run",
      mutate: (receipt: MissionAcceptanceReceiptLike) => {
        receipt.idempotencyKey =
          "linear:issue:create:wrong-segment-run:publish-call-1:0";
      },
    },
    {
      label: "nested provider receipt differs from the outer receipt",
      mutate: (receipt: MissionAcceptanceReceiptLike) => {
        const output = receipt.output as {
          receipt: Record<string, unknown>;
        };
        output.receipt = {
          ...output.receipt,
          payloadFingerprint: `sha256:${"9".repeat(64)}`,
        };
      },
    },
  ]) {
    const receipt = completedResearchPublicationReceipt("created");
    invalid.mutate(receipt);
    const invalidResult = evaluateMissionAcceptance({
      prompt:
        "Write accepted research into the initiating note, publish it to one Linear issue, and preserve the backlink.",
      missionIntent: {
        ...baseIntent,
        noteOutput: true,
        explicitPersistence: true,
        explicitMutation: true,
        requireWriteCompletion: true,
      },
      requiredTools: ["publish_research_to_linear"],
      successfulTools: ["publish_research_to_linear"],
      failedTools: [],
      evidence: [],
      receipts: [receipt],
      operationGoals: { current_note_content: "not_requested" },
      finalOutput: "Accepted research and its Linear backlink are durable.",
    });
    assert.equal(invalidResult.status, "fail", invalid.label);
    assert.ok(
      invalidResult.missing.includes("write_receipt"),
      invalid.label,
    );
  }
});

test("mission acceptance treats broad unscoped mutations as blocked scope requests", () => {
  const prompt = "Update my whole vault with this project summary.";
  const result = evaluateMissionAcceptance({
    prompt,
    missionIntent: {
      ...baseIntent,
      mode: "explicit_file_mutation",
      vaultContext: true,
      explicitMutation: true,
      allowAutonomousWrite: false,
      requireWriteCompletion: false,
      autonomyScope: deriveAutonomyScope(prompt, {
        noteOutput: true,
        explicitMutation: true,
        explicitPersistence: true,
      }),
    },
    requiredTools: [],
    successfulTools: [],
    failedTools: [],
    evidence: [],
    receipts: [],
    operationGoals: {},
    finalOutput: "Explicit file or folder scope is required.",
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.reasons, [
    "broad_unscoped_mutation_requires_explicit_scope",
  ]);
});

test("visible title missions require a rename receipt", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Rename the current note to Purple Horizon.",
    missionIntent: { ...baseIntent, requireWriteCompletion: true },
    requiredTools: ["rename_current_file"],
    successfulTools: [],
    failedTools: [],
    evidence: [],
    receipts: [
      {
        toolName: "append_to_current_file",
        path: "Untitled.md",
        operation: "append",
        bytesWritten: 100,
      },
    ],
    operationGoals: { current_note_title: "pending" },
    finalOutput: "Done.",
  });

  assert.equal(result.status, "needs_more_work");
  assert.ok(result.missing.includes("visible_title_rename"));
  assert.equal(result.nextAction, "Rename the visible current note title and produce a receipt.");
});

test("highlight missions require a highlight receipt with matches", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Find and highlight silver lantern in the current note.",
    missionIntent: { ...baseIntent, requireWriteCompletion: true },
    requiredTools: ["highlight_current_file_phrase"],
    successfulTools: ["highlight_current_file_phrase"],
    failedTools: [],
    evidence: [],
    receipts: [
      {
        toolName: "highlight_current_file_phrase",
        path: "Current.md",
        operation: "highlight",
        affectedCount: 0,
      },
    ],
    operationGoals: { current_note_highlight: "done" },
    finalOutput: "Highlighted.",
  });

  assert.equal(result.status, "needs_more_work");
  assert.ok(result.missing.includes("highlight_receipt"));
  assert.equal(result.nextAction, "Highlight the requested phrase in the current note and produce a receipt.");
});

test("mission acceptance correction names missing tools that are still available", () => {
  const correction = formatMissionAcceptanceCorrection(
    {
      status: "needs_more_work",
      confidence: 0.55,
      missing: ["web_evidence", "web_fetch"],
      reasons: ["missing_web_evidence"],
      nextAction: "web_evidence",
    },
    ["web_search", "web_fetch"],
  );

  assert.match(correction, /Mission acceptance is incomplete/);
  assert.match(correction, /web_fetch/);
});

test("deep research acceptance requires fetched sources and final quality sections", () => {
  const researchPlan: ResearchPlan = {
    version: 1,
    mode: "deep_web",
    sourceRequirements: { minFetchedSources: 3, minDistinctDomains: 2 },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "rq-1",
        question: "Gather sources.",
        requiredEvidenceType: "web_source",
        minEvidence: 3,
        status: "in_progress",
        evidenceIds: ["web:1"],
      },
    ],
    evidenceIds: ["web:1"],
    status: "in_progress",
  };

  const result = evaluateMissionAcceptance({
    prompt: "Do deep research with sources.",
    missionIntent: baseIntent,
    requiredTools: [],
    successfulTools: ["web_fetch"],
    failedTools: [],
    evidence: [
      {
        id: "web:1",
        kind: "web_source",
        title: "One",
        url: "https://alpha.example.com/source",
        passageId: "source:alpha:passage:0-100",
        passageIds: ["source:alpha:passage:0-100"],
        usableSource: true,
        summary: "one",
        confidence: "high",
      },
    ],
    receipts: [],
    operationGoals: {},
    researchPlan,
    finalOutput: "One source only.",
  });

  assert.equal(result.status, "needs_more_work");
  assert.ok(result.missing.includes("fetched_sources:1/3"));
  assert.ok(result.missing.includes("research_plan_items"));
  assert.ok(result.missing.includes("citation_url_coverage"));
  assert.ok(result.missing.includes("limitations_section"));
  assert.ok(result.missing.includes("confidence_section"));
});

test("deep research acceptance passes with source coverage, limitations, and confidence", () => {
  const urls = [
    "https://alpha.example.com/source",
    "https://beta.example.org/source",
    "https://gamma.example.net/source",
  ];
  const researchPlan: ResearchPlan = {
    version: 1,
    mode: "deep_web",
    sourceRequirements: { minFetchedSources: 3, minDistinctDomains: 2 },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "rq-1",
        question: "Gather sources.",
        requiredEvidenceType: "web_source",
        minEvidence: 3,
        status: "complete",
        evidenceIds: ["web:1", "web:2", "web:3"],
      },
    ],
    evidenceIds: ["web:1", "web:2", "web:3"],
    status: "complete",
  };

  const result = evaluateMissionAcceptance({
    prompt: "Do deep research with sources.",
    missionIntent: baseIntent,
    requiredTools: [],
    successfulTools: ["web_fetch"],
    failedTools: [],
    evidence: urls.map((url, index) => ({
      id: `web:${index + 1}`,
      kind: "web_source" as const,
      title: `Source ${index + 1}`,
      url,
      passageId: `source:${index + 1}:passage:0-100`,
      passageIds: [`source:${index + 1}:passage:0-100`],
      usableSource: true,
      summary: "source",
      confidence: "high" as const,
    })),
    receipts: [],
    operationGoals: {},
    researchPlan,
    finalOutput: `Sources: ${urls.join(" ")} ${urls
      .map((_url, index) => `source:${index + 1}:passage:0-100`)
      .join(" ")}\n\nLimitations: e2e.\n\nConfidence: high.`,
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.missing, []);
});

test("deep research accepts exact persisted passage coverage without redundant bare URLs", () => {
  const passageIds = [
    "source:alpha:passage:0-100",
    "source:beta:passage:0-100",
  ];
  const researchPlan: ResearchPlan = {
    version: 1,
    mode: "deep_web",
    sourceRequirements: { minFetchedSources: 2, minDistinctDomains: 2 },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "rq-1",
        question: "Compare the two fetched sources.",
        requiredEvidenceType: "web_source",
        minEvidence: 2,
        status: "complete",
        evidenceIds: ["web:1", "web:2"],
      },
    ],
    evidenceIds: ["web:1", "web:2"],
    status: "complete",
  };

  const evidence = [
    {
      id: "web:1",
      kind: "web_source" as const,
      title: "Alpha",
      url: "https://alpha.example.com/source",
      passageId: passageIds[0],
      passageIds: [passageIds[0]],
      usableSource: true,
      summary: "alpha",
      confidence: "high" as const,
    },
    {
      id: "web:2",
      kind: "web_source" as const,
      title: "Beta",
      url: "https://beta.example.org/source",
      passageId: passageIds[1],
      passageIds: [passageIds[1]],
      usableSource: true,
      summary: "beta",
      confidence: "high" as const,
    },
  ];
  const accepted = evaluateMissionAcceptance({
    prompt: "Compare two sources and cite each exact passage.",
    missionIntent: baseIntent,
    requiredTools: [],
    successfulTools: ["web_fetch"],
    failedTools: [],
    evidence,
    receipts: [],
    operationGoals: {},
    researchPlan,
    finalOutput: `Alpha finding ${passageIds[0]}. Beta finding ${passageIds[1]}.\n\nLimitations: the sources conflict.\n\nConfidence: medium.`,
  });
  const missingOneSource = evaluateMissionAcceptance({
    prompt: "Compare two sources and cite each exact passage.",
    missionIntent: baseIntent,
    requiredTools: [],
    successfulTools: ["web_fetch"],
    failedTools: [],
    evidence,
    receipts: [],
    operationGoals: {},
    researchPlan,
    finalOutput: `Alpha finding ${passageIds[0]}.\n\nLimitations: one source is omitted.\n\nConfidence: low.`,
  });

  assert.equal(accepted.status, "pass");
  assert.deepEqual(accepted.missing, []);
  assert.ok(missingOneSource.missing.includes("citation_url_coverage"));
});
