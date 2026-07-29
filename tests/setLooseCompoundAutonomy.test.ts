import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceCompoundStageBudget,
  buildCompoundRunBudgetPlanV1,
  boundMayAutoWithoutGrant,
  COMPOUND_SET_LOOSE_NUM_CTX,
  decideSetLooseHostProgressV1,
  formatSetLooseResumeBindingCard,
  formatStageBudgetPromptBlock,
  hasSetLooseGithubCreateReceipt,
  isCompletedAcceptedResearchPublicationReceipt,
  isSetLooseEnabled,
  lifecycleStagePaidBySuccessfulTool,
  missionGraphHasIncompleteReadTemplateNode,
  pendingToolsAllowSetLooseWithoutGrant,
  pendingToolsForUnpaidSetLooseDelivery,
  resolveNumCtxForCompoundRun,
  resolveSemanticSearchCapsForCompoundRun,
  setLooseDeliveryComplete,
  setLooseSoftWriteBypassesPlanDependency,
  seedSetLooseDeliveryStateFromReceipts,
  shouldSoftAcknowledgeWorkspaceExists,
  applySetLooseDeliveryProofFromSuccessfulTool,
  filterSetLooseCodeLadderUntilPassedFast,
  toolsOfferedForSetLooseCodeStage,
  toolsOfferedForSetLoosePipeline,
  toolsOfferedForSetLooseStage,
  toolsOfferedForSetLooseTurn,
  unpaidSetLooseDeliveryStages,
  type SetLooseDeliveryReceiptLikeV1,
} from "../src/agent/setLooseCompoundAutonomy";
import { toolsAllowedForLifecycleStage } from "../src/agent/lifecycleStagePolicy";
import {
  evaluateCodeSpecSufficiency,
  filterToolsUntilCodeSpecSufficient,
  resolveSetLooseCodeSpecSufficiencyForSoftUnion,
} from "../src/agent/codeSpecBinding";
import {
  effectClassForTool,
  mayAutoExecute,
} from "../src/agent/autonomyEffectClass";
import { decideAutoContinuation } from "../src/agent/autoContinuation";
import type { ProjectLifecycleStageV1 } from "../src/agent/projectLifecycle";
import { createMissionRuntimeSnapshot } from "../src/agent/runStore";
import {
  appendWorkItemLineageTransitionV1,
  createAcceptedResearchArtifactV1,
  createExternalWorkItemBindingV1,
  createWorkItemLineageV1,
  createWorkItemSpecV2,
  renderQueueExecutableHumanWorkItemSpecV2,
} from "../src/integrations/linear";

function completedResearchPublicationReceiptFixture(
  publication: "created" | "deduplicated",
  deduplicatedLineage: "fresh_readback" | "prior_create" = "fresh_readback",
): SetLooseDeliveryReceiptLikeV1 {
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
      publication === "created" || deduplicatedLineage === "prior_create"
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

test("isSetLooseEnabled requires automatic + compound", () => {
  assert.equal(
    isSetLooseEnabled({
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
    }),
    true,
  );
  assert.equal(
    isSetLooseEnabled({
      autonomyProfile: "conservative",
      compoundLifecycleDetected: true,
    }),
    false,
  );
  assert.equal(
    isSetLooseEnabled({
      autonomyProfile: "automatic",
      compoundLifecycleDetected: false,
    }),
    false,
  );
  assert.equal(
    isSetLooseEnabled({
      autonomyProfile: "custom",
      compoundLifecycleDetected: true,
      workingMode: "automatic",
    }),
    true,
  );
  assert.equal(
    isSetLooseEnabled({
      autonomyProfile: "custom",
      compoundLifecycleDetected: true,
      workingMode: "assisted",
    }),
    false,
  );
});

test("boundMayAutoWithoutGrant and mayAutoExecute set-loose flag", () => {
  assert.equal(
    boundMayAutoWithoutGrant({
      toolName: "linear_create_issue",
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
    }),
    true,
  );
  assert.equal(
    boundMayAutoWithoutGrant({
      toolName: "code_repair_record_cycle",
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
    }),
    true,
  );
  assert.equal(
    boundMayAutoWithoutGrant({
      toolName: "code_validate_fast",
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
    }),
    true,
  );
  assert.equal(
    boundMayAutoWithoutGrant({
      toolName: "code_workspace_patch",
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
    }),
    true,
    "any Bound-class code tool auto under set-loose",
  );
  assert.equal(
    boundMayAutoWithoutGrant({
      toolName: "linear_trash_issue",
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
    }),
    false,
    "Hard trash never auto under set-loose",
  );
  assert.equal(
    mayAutoExecute({
      effectClass: "bound",
      autonomyProfile: "automatic",
      hasMatchingGrant: false,
      setLooseBoundWithoutGrant: true,
    }),
    true,
  );
  assert.equal(
    mayAutoExecute({
      effectClass: "hard",
      autonomyProfile: "automatic",
      hasMatchingGrant: true,
      setLooseBoundWithoutGrant: true,
    }),
    false,
  );
  assert.equal(
    mayAutoExecute({
      effectClass: "bound",
      autonomyProfile: "conservative",
      hasMatchingGrant: false,
      setLooseBoundWithoutGrant: true,
    }),
    false,
  );
});

test("resolveNumCtxForCompoundRun floors to 100k under set-loose", () => {
  assert.equal(
    resolveNumCtxForCompoundRun({
      settingsNumCtx: null,
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
    }),
    COMPOUND_SET_LOOSE_NUM_CTX,
  );
  assert.equal(
    resolveNumCtxForCompoundRun({
      settingsNumCtx: 32_000,
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
    }),
    COMPOUND_SET_LOOSE_NUM_CTX,
  );
  assert.equal(
    resolveNumCtxForCompoundRun({
      settingsNumCtx: 128_000,
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
    }),
    128_000,
  );
  assert.equal(
    resolveNumCtxForCompoundRun({
      settingsNumCtx: null,
      autonomyProfile: "automatic",
      compoundLifecycleDetected: false,
    }),
    null,
  );
});

test("resolveNumCtxForCompoundRun uses the model-reported window when Settings is blank", () => {
  assert.equal(
    resolveNumCtxForCompoundRun({
      settingsNumCtx: null,
      autonomyProfile: "automatic",
      compoundLifecycleDetected: false,
      modelReportedContextLength: 196_608,
    }),
    196_608,
  );
  assert.equal(
    resolveNumCtxForCompoundRun({
      settingsNumCtx: null,
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
      modelReportedContextLength: 196_608,
    }),
    196_608,
  );
  // The set-loose floor is capped at the model window when the model is smaller.
  assert.equal(
    resolveNumCtxForCompoundRun({
      settingsNumCtx: null,
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
      modelReportedContextLength: 65_536,
    }),
    65_536,
  );
  assert.equal(
    resolveNumCtxForCompoundRun({
      settingsNumCtx: 32_000,
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
      modelReportedContextLength: 65_536,
    }),
    65_536,
  );
  // Explicit Settings values are never lowered by the model report.
  assert.equal(
    resolveNumCtxForCompoundRun({
      settingsNumCtx: 262_144,
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
      modelReportedContextLength: 131_072,
    }),
    262_144,
  );
});

test("resolveSemanticSearchCapsForCompoundRun raises caps under set-loose", () => {
  const raised = resolveSemanticSearchCapsForCompoundRun({
    autonomyProfile: "automatic",
    compoundLifecycleDetected: true,
  });
  assert.equal(raised.maxLimit, 40);
  assert.equal(raised.preferDeepMode, true);
  const defaults = resolveSemanticSearchCapsForCompoundRun({
    autonomyProfile: "automatic",
    compoundLifecycleDetected: false,
  });
  assert.equal(defaults.maxLimit, 20);
  assert.equal(defaults.preferDeepMode, false);
  const disabled = resolveSemanticSearchCapsForCompoundRun({
    autonomyProfile: "automatic",
    compoundLifecycleDetected: true,
    semanticSearchEnabled: false,
  });
  assert.equal(disabled.maxLimit, 20);
});

test("stage budgets build, format, and advance", () => {
  const now = 1_000_000;
  const plan = buildCompoundRunBudgetPlanV1({
    stages: ["accepted_research", "linear_hierarchy", "code_execution"],
    nowMs: now,
  });
  assert.equal(plan.stages.length, 3);
  assert.equal(plan.currentStage, "accepted_research");
  assert.ok(plan.runBudgetMs > 0);
  const block = formatStageBudgetPromptBlock(plan);
  assert.match(block, /accepted_research/);
  assert.match(block, /linear_hierarchy/);

  const advanced = advanceCompoundStageBudget({
    plan,
    committedStage: "accepted_research",
    nowMs: now + 60_000,
  });
  assert.equal(advanced.currentStage, "linear_hierarchy");
  assert.ok(
    (advanced.stages.find((s) => s.stage === "accepted_research")
      ?.remainingMs ?? 1) < plan.stages[0]!.budgetMs,
  );
});

test("toolsOfferedForSetLooseStage unions Soft companions", () => {
  const offered = toolsOfferedForSetLooseStage("code_execution");
  assert.ok(offered.includes("code_commit_verified"));
  assert.ok(offered.includes("semantic_search_notes"));
  assert.ok(offered.includes("append_to_current_file"));
  assert.ok(offered.includes("replace_current_file"));
  assert.ok(offered.includes("code_workspace_patch"));
  assert.ok(offered.includes("code_workspace_mkdir"));
  assert.ok(offered.includes("code_repair_record_cycle"));
  assert.ok(
    offered.includes("read_template"),
    "set-loose Soft companions must offer read_template so Linear template gates are callable",
  );
  assert.ok(
    offered.includes("list_templates"),
    "set-loose Soft companions should offer list_templates alongside read_template",
  );
});

test("SET_LOOSE_STAGE_SOFT_COMPANIONS includes template reads for Linear compound gates", () => {
  const linearStage = toolsOfferedForSetLooseStage("linear_hierarchy");
  assert.ok(linearStage.includes("read_template"));
  assert.ok(linearStage.includes("list_templates"));
  assert.ok(linearStage.includes("linear_create_issue"));
  // Do not open template mutation Soft companions by default.
  assert.equal(linearStage.includes("fill_template"), false);
  assert.equal(linearStage.includes("create_template"), false);

  const pipeline = toolsOfferedForSetLoosePipeline({
    stages: ["linear_hierarchy", "code_execution"],
    currentStage: "linear_hierarchy",
    passedFastRepairCycle: false,
  });
  assert.ok(pipeline.includes("read_template"));
  assert.ok(pipeline.includes("list_templates"));
});

test("missionGraphHasIncompleteReadTemplateNode tracks tool-01-read_template payment", () => {
  const unpaidGraph = {
    nodes: {
      "tool-01-read_template": {
        status: "ready",
        allowedTools: ["read_template"],
      },
      "tool-02-linear_create_issue": {
        status: "queued",
        allowedTools: ["linear_create_issue"],
      },
    },
  };
  assert.equal(missionGraphHasIncompleteReadTemplateNode(unpaidGraph), true);

  const paidGraph = {
    nodes: {
      "tool-01-read_template": {
        status: "complete",
        allowedTools: ["read_template"],
      },
      "tool-02-linear_create_issue": {
        status: "ready",
        allowedTools: ["linear_create_issue"],
      },
    },
  };
  assert.equal(missionGraphHasIncompleteReadTemplateNode(paidGraph), false);
  assert.equal(missionGraphHasIncompleteReadTemplateNode(null), false);
});

test("setLooseSoftWriteBypassesPlanDependency unlocks append only for reflection-only debt", () => {
  const unpaid = ["linear_hierarchy", "code_execution", "note_reflection"];
  assert.equal(
    setLooseSoftWriteBypassesPlanDependency({
      toolName: "append_to_current_file",
      setLooseEnabled: true,
      unpaidDeliveryKeys: unpaid,
      successfulToolNames: [],
      incompleteReadTemplateNode: true,
    }),
    false,
    "append must not bypass unpaid external delivery stages",
  );
  assert.equal(
    setLooseSoftWriteBypassesPlanDependency({
      toolName: "append_to_current_file",
      setLooseEnabled: true,
      unpaidDeliveryKeys: unpaid,
      successfulToolNames: ["read_template"],
      incompleteReadTemplateNode: true,
    }),
    false,
    "read_template success cannot erase unpaid external delivery",
  );
  assert.equal(
    setLooseSoftWriteBypassesPlanDependency({
      toolName: "append_to_current_file",
      setLooseEnabled: true,
      unpaidDeliveryKeys: unpaid,
      successfulToolNames: ["read_template"],
      incompleteReadTemplateNode: false,
    }),
    false,
    "MissionGraph read progress cannot erase unpaid external delivery",
  );
  assert.equal(
    setLooseSoftWriteBypassesPlanDependency({
      toolName: "append_to_current_file",
      setLooseEnabled: true,
      unpaidDeliveryKeys: ["note_reflection"],
      successfulToolNames: ["publish_verified_code_to_github"],
      incompleteReadTemplateNode: true,
    }),
    true,
    "reflection-only append may bypass a stale legacy plan frontier",
  );
  assert.equal(
    setLooseSoftWriteBypassesPlanDependency({
      toolName: "append_to_current_file",
      setLooseEnabled: true,
      unpaidDeliveryKeys: ["linear_hierarchy", "code_execution"],
      successfulToolNames: ["read_template"],
      incompleteReadTemplateNode: false,
    }),
    false,
    "without unpaid note_reflection, Soft append bypass stays closed",
  );
  assert.equal(
    setLooseSoftWriteBypassesPlanDependency({
      toolName: "linear_create_issue",
      setLooseEnabled: true,
      unpaidDeliveryKeys: unpaid,
      successfulToolNames: ["read_template"],
      incompleteReadTemplateNode: false,
    }),
    false,
    "Bound Linear mutations must not use Soft write plan-dependency bypass",
  );
});

test("toolsOfferedForSetLoosePipeline keeps later-stage Bound tools from accepted_research", () => {
  const fullStages: ProjectLifecycleStageV1[] = [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "private_github_publication",
    "reconciliation_cleanup",
  ];
  const offered = toolsOfferedForSetLoosePipeline({
    stages: fullStages,
    currentStage: "accepted_research",
    passedFastRepairCycle: true,
  });
  assert.ok(offered.includes("linear_create_issue"));
  assert.ok(offered.includes("code_commit_verified"));
  assert.ok(offered.includes("github_create_private_repository"));
  assert.ok(offered.includes("github_get_issue"));
  assert.ok(offered.includes("github_update_issue"));
  assert.ok(offered.includes("semantic_search_notes"));
  // Cleanup tools only when that stage is in the plan (it is here).
  assert.ok(offered.includes("linear_trash_issue"));
  assert.ok(offered.includes("github_delete_owned_comment"));

  const withoutCleanup = toolsOfferedForSetLoosePipeline({
    stages: [
      "accepted_research",
      "linear_hierarchy",
      "code_execution",
      "private_github_publication",
    ],
    currentStage: "accepted_research",
    passedFastRepairCycle: true,
  });
  assert.ok(withoutCleanup.includes("linear_create_issue"));
  assert.ok(withoutCleanup.includes("code_commit_verified"));
  assert.ok(withoutCleanup.includes("github_create_private_repository"));
  assert.ok(withoutCleanup.includes("github_get_issue"));
  assert.ok(withoutCleanup.includes("github_update_issue"));
  assert.equal(withoutCleanup.includes("linear_trash_issue"), false);
  assert.equal(
    withoutCleanup.includes("github_delete_private_repository"),
    false,
  );
  assert.equal(withoutCleanup.includes("github_delete_owned_comment"), false);
  assert.equal(withoutCleanup.includes("github_delete_owned_branch"), false);
  assert.equal(effectClassForTool("github_get_issue"), "soft");
  assert.equal(effectClassForTool("github_update_issue"), "bound");
  assert.equal(effectClassForTool("github_delete_owned_comment"), "hard");
  assert.equal(effectClassForTool("github_delete_owned_branch"), "hard");
});

test("toolsOfferedForSetLoosePipeline withholds commit until passed fast repair cycle", () => {
  const stages: ProjectLifecycleStageV1[] = [
    "linear_hierarchy",
    "code_execution",
    "private_github_publication",
  ];
  const before = toolsOfferedForSetLoosePipeline({
    stages,
    currentStage: "code_execution",
    passedFastRepairCycle: false,
  });
  assert.ok(before.includes("code_validate_fast"));
  assert.ok(before.includes("code_repair_record_cycle"));
  assert.equal(before.includes("code_commit_verified"), false);

  const after = toolsOfferedForSetLoosePipeline({
    stages,
    currentStage: "code_execution",
    passedFastRepairCycle: true,
  });
  assert.ok(after.includes("code_commit_verified"));

  assert.deepEqual(
    filterSetLooseCodeLadderUntilPassedFast({
      offeredToolNames: ["code_validate_fast", "code_commit_verified"],
      passedFastRepairCycle: false,
    }),
    ["code_validate_fast"],
  );
});

test("lifecycleStagePaidBySuccessfulTool maps key tools and fails closed", () => {
  assert.equal(
    lifecycleStagePaidBySuccessfulTool({
      toolName: "publish_research_to_linear",
      ok: true,
    }),
    "accepted_research",
  );
  assert.equal(
    lifecycleStagePaidBySuccessfulTool({
      toolName: "linear_create_issue",
      ok: true,
    }),
    "linear_hierarchy",
  );
  assert.equal(
    lifecycleStagePaidBySuccessfulTool({
      toolName: "linear_get_issue",
      ok: true,
    }),
    "linear_hierarchy",
  );
  assert.equal(
    lifecycleStagePaidBySuccessfulTool({
      toolName: "publish_research_project_to_linear",
      ok: true,
    }),
    "linear_hierarchy",
  );
  assert.equal(
    lifecycleStagePaidBySuccessfulTool({
      toolName: "code_commit_verified",
      ok: true,
    }),
    "code_execution",
  );
  assert.equal(
    lifecycleStagePaidBySuccessfulTool({
      toolName: "github_create_private_repository",
      ok: true,
    }),
    "private_github_publication",
  );
  assert.equal(
    lifecycleStagePaidBySuccessfulTool({
      toolName: "github_publish_verified_branch",
      ok: true,
    }),
    "private_github_publication",
  );
  assert.equal(
    lifecycleStagePaidBySuccessfulTool({
      toolName: "linear_create_issue",
      ok: false,
    }),
    null,
  );
  assert.equal(
    lifecycleStagePaidBySuccessfulTool({
      toolName: "web_search",
      ok: true,
    }),
    null,
  );
});

test("setLooseDeliveryComplete requires delivery proofs without cleanup", () => {
  const stages: ProjectLifecycleStageV1[] = [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "private_github_publication",
  ];
  const missingLinearGithub = setLooseDeliveryComplete({
    stages,
    proofs: {
      acceptedResearchPublication: true,
      linearIssueUrlOrId: false,
      codeWorkspaceReadback: true,
      githubPrivateRepoOrPrUrl: false,
      noteReflectionWithMarkers: true,
    },
  });
  assert.equal(missingLinearGithub.complete, false);
  assert.ok(missingLinearGithub.unpaid.includes("linear_hierarchy"));
  assert.ok(missingLinearGithub.unpaid.includes("private_github_publication"));

  const complete = setLooseDeliveryComplete({
    stages,
    proofs: {
      acceptedResearchPublication: true,
      linearIssueUrlOrId: true,
      codeWorkspaceReadback: true,
      githubPrivateRepoOrPrUrl: true,
      noteReflectionWithMarkers: true,
    },
  });
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.unpaid, []);

  const missingReflection = setLooseDeliveryComplete({
    stages,
    proofs: {
      acceptedResearchPublication: true,
      linearIssueUrlOrId: true,
      codeWorkspaceReadback: true,
      githubPrivateRepoOrPrUrl: true,
    },
  });
  assert.deepEqual(missingReflection.unpaid, ["note_reflection"]);

  assert.deepEqual(
    unpaidSetLooseDeliveryStages({
      stages: [...stages, "reconciliation_cleanup"],
      paidStages: [
        "accepted_research",
        "linear_hierarchy",
        "code_execution",
      ],
    }),
    ["private_github_publication"],
  );

  const pending = pendingToolsForUnpaidSetLooseDelivery([
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "private_github_publication",
    "note_reflection",
  ]);
  assert.ok(pending.includes("publish_research_to_linear"));
  assert.ok(pending.includes("linear_get_connection_context"));
  assert.ok(pending.includes("linear_create_issue"));
  assert.ok(pending.includes("code_sandbox_status"));
  assert.ok(pending.includes("code_workspace_create"));
  assert.ok(pending.includes("code_validate_fast"));
  assert.ok(pending.includes("code_commit_verified"));
  assert.ok(pending.includes("github_create_private_repository"));
  assert.ok(pending.includes("publish_verified_code_to_github"));
  assert.ok(pending.includes("append_to_current_file"));
});

test("toolsOfferedForSetLooseCodeStage withholds GitHub until code paid", () => {
  const stages: ProjectLifecycleStageV1[] = [
    "linear_hierarchy",
    "code_execution",
    "private_github_publication",
  ];
  const unpaid = toolsOfferedForSetLooseCodeStage({
    stages,
    currentStage: "code_execution",
    passedFastRepairCycle: true,
    codeDeliveryPaid: false,
  });
  assert.ok(unpaid.includes("code_commit_verified"));
  assert.ok(unpaid.includes("code_workspace_write_expected"));
  assert.ok(unpaid.includes("linear_get_issue"));
  assert.equal(unpaid.includes("github_create_private_repository"), false);
  assert.equal(unpaid.includes("publish_verified_code_to_github"), false);

  const paidPipeline = toolsOfferedForSetLoosePipeline({
    stages,
    currentStage: "private_github_publication",
    passedFastRepairCycle: true,
    codeDeliveryPaid: true,
  });
  assert.ok(paidPipeline.includes("publish_verified_code_to_github"));
});

test("toolsOfferedForSetLooseTurn stages Soft-union after Linear / code / reflection pay", () => {
  const stages: ProjectLifecycleStageV1[] = [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "private_github_publication",
  ];

  const beforeResearchPublication = toolsOfferedForSetLooseTurn({
    stages,
    currentStage: "accepted_research",
    passedFastRepairCycle: false,
    codeDeliveryPaid: false,
    unpaidDeliveryKeys: [
      "accepted_research",
      "linear_hierarchy",
      "code_execution",
      "private_github_publication",
      "note_reflection",
    ],
  });
  assert.ok(beforeResearchPublication.includes("publish_research_to_linear"));
  assert.equal(beforeResearchPublication.includes("linear_create_issue"), false);
  assert.equal(beforeResearchPublication.includes("code_validate_fast"), false);
  assert.equal(
    beforeResearchPublication.includes("github_create_private_repository"),
    false,
  );

  const afterLinear = toolsOfferedForSetLooseTurn({
    stages,
    currentStage: "code_execution",
    passedFastRepairCycle: false,
    codeDeliveryPaid: false,
    unpaidDeliveryKeys: [
      "code_execution",
      "private_github_publication",
      "note_reflection",
    ],
  });
  assert.ok(afterLinear.includes("code_workspace_write_expected"));
  assert.ok(afterLinear.includes("code_validate_fast"));
  assert.ok(afterLinear.includes("code_workspace_create"));
  assert.ok(afterLinear.includes("append_to_current_file"));
  assert.equal(afterLinear.includes("code_commit_verified"), false);
  assert.equal(afterLinear.includes("github_create_private_repository"), false);
  assert.equal(afterLinear.includes("publish_verified_code_to_github"), false);

  const afterPassedFast = toolsOfferedForSetLooseTurn({
    stages,
    currentStage: "code_execution",
    passedFastRepairCycle: true,
    codeDeliveryPaid: false,
    unpaidDeliveryKeys: [
      "code_execution",
      "private_github_publication",
      "note_reflection",
    ],
  });
  assert.ok(afterPassedFast.includes("code_commit_verified"));
  assert.equal(
    afterPassedFast.includes("github_create_private_repository"),
    false,
    "GitHub must stay withheld while code delivery unpaid even if unpaid keys list it",
  );

  const afterCode = toolsOfferedForSetLooseTurn({
    stages,
    currentStage: "private_github_publication",
    passedFastRepairCycle: true,
    codeDeliveryPaid: true,
    unpaidDeliveryKeys: ["private_github_publication", "note_reflection"],
  });
  assert.ok(afterCode.includes("github_create_private_repository"));
  assert.ok(afterCode.includes("publish_verified_code_to_github"));
  assert.ok(afterCode.includes("append_to_current_file"));

  const reflectionOnly = toolsOfferedForSetLooseTurn({
    stages,
    currentStage: "private_github_publication",
    passedFastRepairCycle: true,
    codeDeliveryPaid: true,
    unpaidDeliveryKeys: ["note_reflection"],
  });
  assert.ok(reflectionOnly.includes("append_to_current_file"));
  assert.equal(reflectionOnly.includes("code_validate_fast"), false);
  assert.equal(reflectionOnly.includes("code_repair_record_cycle"), false);
  assert.equal(reflectionOnly.includes("code_commit_verified"), false);
  assert.equal(
    reflectionOnly.includes("publish_verified_code_to_github"),
    false,
  );
});

test("resolveSetLooseCodeSpecSufficiencyForSoftUnion unlocks writes after Linear pays", () => {
  const insufficient = evaluateCodeSpecSufficiency({
    binding: null,
    requireNote: true,
    requireLinear: true,
  });
  assert.equal(insufficient.sufficient, false);

  const afterLinear = resolveSetLooseCodeSpecSufficiencyForSoftUnion({
    sufficiency: insufficient,
    requireNote: true,
    requireLinear: true,
    linearDeliveryPaid: true,
    hostNoteObserved: false,
  });
  assert.equal(afterLinear.sufficient, true);
  assert.equal(afterLinear.hasLinear, true);

  const gated = filterToolsUntilCodeSpecSufficient({
    offeredToolNames: [
      "code_workspace_write_expected",
      "code_workspace_patch",
      "code_validate_fast",
      "code_commit_verified",
    ],
    sufficiency: insufficient,
  });
  assert.equal(gated.includes("code_workspace_write_expected"), false);
  assert.ok(gated.includes("code_validate_fast"));

  const unlocked = filterToolsUntilCodeSpecSufficient({
    offeredToolNames: [
      "code_workspace_write_expected",
      "code_workspace_patch",
      "code_validate_fast",
      "code_commit_verified",
    ],
    sufficiency: afterLinear,
  });
  assert.ok(unlocked.includes("code_workspace_write_expected"));
  assert.ok(unlocked.includes("code_workspace_patch"));
});

test("accepted_research allowlist includes semantic tools", () => {
  const research = toolsAllowedForLifecycleStage("accepted_research");
  assert.ok(research.includes("semantic_search_notes"));
  assert.ok(research.includes("find_related_notes"));
  assert.ok(research.includes("get_note_graph_context"));
});

test("set-loose Bound pending continues without grant", () => {
  assert.equal(
    pendingToolsAllowSetLooseWithoutGrant({
      pendingToolNames: ["linear_create_issue"],
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
    }),
    true,
  );
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: { status: "needs_more_work", reasons: [], missing: ["x"] },
      completionDriven: true,
      reflection: {
        done: false,
        confidence: 0.4,
        reason: "bound_write_pending",
        remainingActions: ["linear_create_issue"],
      },
      segmentsUsed: 1,
      maxSegments: 24,
      pendingToolNames: ["linear_create_issue"],
      autonomyProfile: "automatic",
      hasMatchingGrant: false,
      compoundLifecycleDetected: true,
    }),
    { recommended: true, reason: "budget_exhausted" },
  );
});

test("seedSetLooseDeliveryStateFromReceipts restores Linear and commit proofs", () => {
  const seeded = seedSetLooseDeliveryStateFromReceipts([
    {
      toolName: "linear_create_issue",
      output: {
        issueUrl: "https://linear.app/team/issue/APP-1",
        issueId: "issue-1",
      },
      resource: {
        system: "linear",
        id: "issue-1",
        url: "https://linear.app/team/issue/APP-1",
      },
    },
    {
      toolName: "code_commit_verified",
      output: { commitSha: "a".repeat(40) },
    },
  ]);
  assert.deepEqual(seeded.paidStages.sort(), [
    "code_execution",
    "linear_hierarchy",
  ]);
  assert.equal(seeded.proofs.linearIssueUrlOrId, true);
  assert.equal(seeded.proofs.codeWorkspaceReadback, true);
  assert.deepEqual(
    setLooseDeliveryComplete({
      stages: [
        "linear_hierarchy",
        "code_execution",
        "private_github_publication",
      ],
      proofs: seeded.proofs,
    }).unpaid,
    ["private_github_publication", "note_reflection"],
  );
});

test("completed canonical research publication receipts restore composite proof", () => {
  const deduplicated =
    completedResearchPublicationReceiptFixture("deduplicated");

  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt(deduplicated),
    true,
  );
  const restored = seedSetLooseDeliveryStateFromReceipts([deduplicated]);
  assert.deepEqual(restored.paidStages.sort(), [
    "accepted_research",
    "linear_hierarchy",
  ]);
  assert.equal(restored.proofs.acceptedResearchPublication, true);
  assert.equal(restored.proofs.linearIssueUrlOrId, true);
  assert.deepEqual(
    setLooseDeliveryComplete({
      stages: ["accepted_research", "linear_hierarchy"],
      proofs: restored.proofs,
    }),
    {
      complete: true,
      unpaid: [],
      reason: "all_delivery_proofs_present",
    },
  );

  const created = completedResearchPublicationReceiptFixture("created");
  assert.equal(isCompletedAcceptedResearchPublicationReceipt(created), true);
  assert.equal(
    seedSetLooseDeliveryStateFromReceipts([created]).proofs
      .acceptedResearchPublication,
    true,
  );
  const persistedCreatedReceipt = createMissionRuntimeSnapshot({
    runId: "segment-run-42",
    originalMission:
      "Research the topic, write accepted research, and publish it to Linear.",
    receipts: [created],
  }).receipts;
  assert.equal(
    persistedCreatedReceipt[0]?.toolName,
    "linear_create_issue",
    "the runtime store retains the provider operation name",
  );
  assert.equal(
    seedSetLooseDeliveryStateFromReceipts(persistedCreatedReceipt).proofs
      .acceptedResearchPublication,
    true,
    "a canonical persisted receipt must pay the composite proof on Continue",
  );
  const completedCheckpointReplay =
    completedResearchPublicationReceiptFixture("deduplicated");
  const completedCheckpointReplayOutput =
    completedCheckpointReplay.output as Record<string, unknown>;
  const completedCheckpointReplayBacklink =
    completedCheckpointReplayOutput.backlink as Record<string, unknown>;
  completedCheckpointReplay.output = {
    ...completedCheckpointReplayOutput,
    note: {
      ...(completedCheckpointReplayOutput.note as Record<string, unknown>),
      operation: "no_op",
      beforeSha256: completedCheckpointReplayBacklink.afterSha256,
      afterSha256: completedCheckpointReplayBacklink.afterSha256,
    },
  };
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt(completedCheckpointReplay),
    true,
  );
  assert.equal(
    seedSetLooseDeliveryStateFromReceipts([completedCheckpointReplay]).proofs
      .acceptedResearchPublication,
    true,
  );
  const completedReplayAfterNewerProviderRevision =
    structuredClone(completedCheckpointReplay);
  const newerReplayOutput =
    completedReplayAfterNewerProviderRevision.output as Record<string, unknown>;
  const newerReplayIssue =
    newerReplayOutput.issue as Record<string, unknown>;
  const newerIssueUpdatedAt = "2026-07-27T20:04:00.000Z";
  const newerIssueSnapshotHash = `sha256:${"6".repeat(64)}`;
  completedReplayAfterNewerProviderRevision.output = {
    ...newerReplayOutput,
    issue: {
      ...newerReplayIssue,
      updatedAt: newerIssueUpdatedAt,
      snapshotHash: newerIssueSnapshotHash,
    },
  };
  completedReplayAfterNewerProviderRevision.resource = {
    ...(completedReplayAfterNewerProviderRevision.resource ?? {}),
    revision: newerIssueUpdatedAt,
  };
  completedReplayAfterNewerProviderRevision.readback = {
    ...(completedReplayAfterNewerProviderRevision.readback ?? {}),
    observedRevision: newerIssueUpdatedAt,
    observedFingerprint: newerIssueSnapshotHash,
  };
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt(
      completedReplayAfterNewerProviderRevision,
    ),
    true,
  );
  assert.equal(
    seedSetLooseDeliveryStateFromReceipts([
      completedReplayAfterNewerProviderRevision,
    ]).proofs.acceptedResearchPublication,
    true,
  );
  const continuedCreatedAsDeduplicated =
    completedResearchPublicationReceiptFixture(
      "deduplicated",
      "prior_create",
    );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt(
      continuedCreatedAsDeduplicated,
    ),
    true,
  );

  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      idempotencyKey: "linear-generic-issue:issue-publication-1",
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...completedCheckpointReplay,
      output: {
        ...(completedCheckpointReplay.output as Record<string, unknown>),
        note: {
          ...((completedCheckpointReplay.output as {
            note: Record<string, unknown>;
          }).note),
          afterSha256: `sha256:${"7".repeat(64)}`,
        },
      },
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      toolName: "linear_get_issue",
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      operation: "create",
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      idempotencyKey: `research-publication:sha256:${"d".repeat(64)}`,
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      commitKind: "reconciled",
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      readback: { status: "not_verified" },
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      output: {
        ...(deduplicated.output as Record<string, unknown>),
        status: "waiting_obsidian",
      },
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      output: {
        ...(deduplicated.output as Record<string, unknown>),
        binding: {
          ...((deduplicated.output as {
            binding: Record<string, unknown>;
          }).binding),
          acceptedResearchArtifactFingerprint: `sha256:${"d".repeat(64)}`,
        },
      },
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...created,
      idempotencyKey:
        "linear:issue:create:wrong-segment-run:publish-call-1:0",
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...created,
      output: {
        ...(created.output as Record<string, unknown>),
        receipt: {
          ...((created.output as {
            receipt: Record<string, unknown>;
          }).receipt),
          payloadFingerprint: `sha256:${"9".repeat(64)}`,
        },
      },
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...created,
      commitKind: "reconciled",
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      payloadFingerprint: `sha256:${"8".repeat(64)}`,
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      grantId: "grant-linear-create-1",
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      resource: {
        ...(deduplicated.resource ?? {}),
        revision: "2026-07-27T20:04:00.000Z",
      },
    }),
    false,
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...deduplicated,
      readback: {
        ...(deduplicated.readback ?? {}),
        observedRevision: "2026-07-27T20:04:00.000Z",
      },
    }),
    false,
  );
});

test("a generic Linear issue does not pay accepted research publication", () => {
  const genericIssue = applySetLooseDeliveryProofFromSuccessfulTool({
    toolName: "linear_create_issue",
    output: {
      issueUrl: "https://linear.app/team/issue/APP-1",
      issueId: "issue-1",
    },
    proofs: {},
  });
  assert.equal(genericIssue.linearIssueUrlOrId, true);
  assert.equal(genericIssue.acceptedResearchPublication, undefined);
  assert.deepEqual(
    setLooseDeliveryComplete({
      stages: ["accepted_research", "linear_hierarchy"],
      proofs: genericIssue,
    }).unpaid,
    ["accepted_research"],
  );

  const published = applySetLooseDeliveryProofFromSuccessfulTool({
    toolName: "publish_research_to_linear",
    output: {
      issueUrl: "https://linear.app/team/issue/APP-2",
      issueId: "issue-2",
    },
    proofs: genericIssue,
  });
  assert.equal(published.acceptedResearchPublication, true);
  assert.equal(published.linearIssueUrlOrId, true);
  assert.deepEqual(
    setLooseDeliveryComplete({
      stages: ["accepted_research", "linear_hierarchy"],
      proofs: published,
    }),
    {
      complete: true,
      unpaid: [],
      reason: "all_delivery_proofs_present",
    },
  );
});

test("applySetLooseDeliveryProofFromSuccessfulTool pays note reflection markers", () => {
  const proofs = applySetLooseDeliveryProofFromSuccessfulTool({
    toolName: "append_to_current_file",
    argumentsText:
      "Flow real reflection FLOW_REAL_abc https://linear.app/x https://github.com/o/r/pull/3",
    proofs: {},
  });
  assert.equal(proofs.noteReflectionWithMarkers, true);

  const byokProof = applySetLooseDeliveryProofFromSuccessfulTool({
    toolName: "append_to_current_file",
    argumentsText:
      "BYOK_AUTONOMOUS_abc123 https://linear.app/x https://github.com/o/r/pull/4",
    proofs: {},
  });
  assert.equal(byokProof.noteReflectionWithMarkers, true);

  const finalizedPublication = applySetLooseDeliveryProofFromSuccessfulTool({
    toolName: "publish_verified_code_to_github",
    output: {
      status: "finalized",
      obsidianReceiptId: "github-note-reflection-proof",
      pullRequest: {
        htmlUrl: "https://github.com/o/r/pull/5",
      },
    },
    proofs: {},
  });
  assert.equal(finalizedPublication.githubPrivateRepoOrPrUrl, true);
  assert.equal(finalizedPublication.noteReflectionWithMarkers, true);

  const unfinalizedPublication = applySetLooseDeliveryProofFromSuccessfulTool({
    toolName: "publish_verified_code_to_github",
    output: {
      status: "draft_pr_verified",
      obsidianReceiptId: null,
      pullRequest: {
        htmlUrl: "https://github.com/o/r/pull/6",
      },
    },
    proofs: {},
  });
  assert.equal(unfinalizedPublication.githubPrivateRepoOrPrUrl, true);
  assert.equal(unfinalizedPublication.noteReflectionWithMarkers, undefined);

  const repoOnly = applySetLooseDeliveryProofFromSuccessfulTool({
    toolName: "append_to_current_file",
    argumentsText:
      "Flow real reflection FLOW_REAL_abc https://linear.app/x https://github.com/o/r",
    proofs: {},
  });
  assert.equal(repoOnly.noteReflectionWithMarkers, undefined);
});

test("applySetLooseDeliveryProofFromSuccessfulTool requires draft PR URL for GitHub delivery", () => {
  const publishWithoutPr = applySetLooseDeliveryProofFromSuccessfulTool({
    toolName: "publish_verified_code_to_github",
    output: { ok: true, repository: "https://github.com/o/r" },
    proofs: {},
  });
  assert.equal(publishWithoutPr.githubPrivateRepoOrPrUrl, undefined);

  const publishWithPr = applySetLooseDeliveryProofFromSuccessfulTool({
    toolName: "publish_verified_code_to_github",
    output: {
      pullRequestUrl: "https://github.com/o/r/pull/12",
    },
    proofs: {},
  });
  assert.equal(publishWithPr.githubPrivateRepoOrPrUrl, true);

  const textOnlyPr = applySetLooseDeliveryProofFromSuccessfulTool({
    toolName: "github_get_pull_request",
    argumentsText: "see https://github.com/o/r/pull/9",
    proofs: {},
  });
  assert.equal(textOnlyPr.githubPrivateRepoOrPrUrl, true);
});

test("shouldSoftAcknowledgeWorkspaceExists requires durable workspace binding", () => {
  assert.equal(
    shouldSoftAcknowledgeWorkspaceExists({
      toolName: "code_workspace_create",
      errorCode: "workspace_exists",
      durableWorkspaceId: "flow-real-abc",
    }),
    true,
  );
  assert.equal(
    shouldSoftAcknowledgeWorkspaceExists({
      toolName: "code_workspace_create",
      errorCode: "workspace_exists",
      durableWorkspaceId: null,
    }),
    false,
  );
  assert.equal(
    shouldSoftAcknowledgeWorkspaceExists({
      toolName: "code_workspace_read",
      errorCode: "workspace_exists",
      durableWorkspaceId: "flow-real-abc",
    }),
    false,
  );
});

test("decideSetLooseHostProgressV1 host-drives GitHub after workspace_exists stall", () => {
  assert.deepEqual(
    decideSetLooseHostProgressV1({
      unpaidDeliveryKeys: ["private_github_publication", "note_reflection"],
      profileKey: "compound-flow-real-ts",
      durableWorkspaceId: "flow-real-abc",
      githubCreatePaid: false,
      githubToolsOffered: true,
      stepsSinceGithubOfferedUnused: 0,
      sawWorkspaceExistsError: true,
      recentModelToolNames: ["code_workspace_create", "code_workspace_read"],
    }),
    {
      kind: "host_github_create",
      profileKey: "compound-flow-real-ts",
    },
  );

  assert.deepEqual(
    decideSetLooseHostProgressV1({
      unpaidDeliveryKeys: ["private_github_publication", "note_reflection"],
      profileKey: "compound-flow-real-ts",
      durableWorkspaceId: "flow-real-abc",
      githubCreatePaid: true,
      githubToolsOffered: true,
      stepsSinceGithubOfferedUnused: 2,
      sawWorkspaceExistsError: false,
    }),
    {
      kind: "host_github_publish_draft",
      profileKey: "compound-flow-real-ts",
    },
  );

  assert.equal(
    decideSetLooseHostProgressV1({
      unpaidDeliveryKeys: [
        "code_execution",
        "private_github_publication",
        "note_reflection",
      ],
      profileKey: "compound-flow-real-ts",
      durableWorkspaceId: "flow-real-abc",
      githubCreatePaid: false,
      githubToolsOffered: false,
      stepsSinceGithubOfferedUnused: 5,
      sawWorkspaceExistsError: true,
    }).kind,
    "soft_acknowledge_workspace_exists",
    "must not host-drive GitHub while Soft-union has not offered GitHub tools",
  );

  assert.deepEqual(
    decideSetLooseHostProgressV1({
      unpaidDeliveryKeys: [
        "code_execution",
        "private_github_publication",
        "note_reflection",
      ],
      profileKey: "compound-flow-real-ts",
      durableWorkspaceId: "flow-real-abc",
      githubCreatePaid: false,
      githubToolsOffered: true,
      stepsSinceGithubOfferedUnused: 2,
      sawWorkspaceExistsError: false,
    }),
    {
      kind: "host_github_create",
      profileKey: "compound-flow-real-ts",
    },
    "Soft-union offering GitHub unlocks host create even if code proof lagged",
  );

  assert.deepEqual(
    decideSetLooseHostProgressV1({
      unpaidDeliveryKeys: ["note_reflection"],
      profileKey: "compound-flow-real-ts",
      durableWorkspaceId: "flow-real-abc",
      githubCreatePaid: true,
      githubToolsOffered: false,
      stepsSinceGithubOfferedUnused: 0,
      sawWorkspaceExistsError: false,
    }),
    { kind: "host_note_reflection" },
  );
});

test("hasSetLooseGithubCreateReceipt and resume binding card surface paid work", () => {
  assert.equal(
    hasSetLooseGithubCreateReceipt([
      {
        toolName: "github_create_private_repository",
        resource: {
          system: "github",
          url: "https://github.com/o/r",
        },
      },
    ]),
    true,
  );
  assert.equal(
    hasSetLooseGithubCreateReceipt([
      { toolName: "code_commit_verified", output: { commitSha: "a".repeat(40) } },
    ]),
    false,
  );

  const card = formatSetLooseResumeBindingCard({
    proofs: {
      linearIssueUrlOrId: true,
      codeWorkspaceReadback: true,
    },
    unpaidDeliveryKeys: ["private_github_publication", "note_reflection"],
    durableWorkspaceId: "flow-real-abc",
    passedFastRepairCycle: true,
    profileKey: "compound-flow-real-ts",
  });
  assert.match(card, /Durable workspace binding already exists: flow-real-abc/);
  assert.match(card, /passed fast repair cycle/i);
  assert.match(card, /github_create_private_repository/);
  assert.match(card, /Do NOT call code_workspace_create/);
});
