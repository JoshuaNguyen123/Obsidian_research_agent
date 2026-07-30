import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AGENT_STEPS,
  applyExactWorkspaceCorrectionReplacements,
  applyExactWorkspaceLineRangeCorrections,
  attachGroundedPassageCitations,
  attachMissingRequiredLiteralAnchors,
  bindAuthoritativeGraphCodeValidation,
  bindExplicitWebFetchContract,
  bindExactWorkspaceDestinationToolSchemas,
  bindIncompleteWorkspaceReplacementToVerifiedNoop,
  isIncompleteWorkspaceReplacementContent,
  bindTrustedRepositoryWorkspaceCreate,
  bindVerifiedWorkspaceCreateFile,
  bindVerifiedWorkspaceDirectoryExport,
  bindVerifiedWorkspaceIdentityToolCall,
  bindVerifiedWorkspaceIdentityToolSchemas,
  bindVerifiedWorkspaceLifecycleTool,
  bindVerifiedWorkspaceObservationTool,
  buildVerifiedHostExportFinalAnswer,
  missionAcceptanceHasOnlyFinalProjectionDebt,
  settleTerminalRuntimeSnapshotPersistence,
  settleToolOutcomeMemoryPersistence,
  shouldFinalizeVerifiedHostExportAfterToolUse,
  shouldInspectAutoContinuationGrant,
  shouldRequestStreamingFinalProjection,
  buildExactCodeValidationFallbackToolCall,
  bindVerifiedWorkspaceRead,
  bindVerifiedWorkspaceWriteExpected,
  resolveSingleNamedTrustedRepositoryProfileKey,
  buildScopedDurableEvidenceForWriteback,
  buildOffFrontierToolRejectionMessage,
  describeOffFrontierToolNearMiss,
  isWorkspaceCreateFilePlaceholderContent,
  buildObservedMissionGraphFrontierBinding,
  buildValidatorFailureSourceContext,
  buildMissionGraphFrontierTurnContext,
  canonicalMissionGraphId,
  countOutstandingMissionGraphToolActions,
  countReadyMissionGraphToolSlots,
  constrainValidationRecoveryWorkspaceToolsV1,
  constrainPassageCitationScope,
  constrainSetLooseTemplateDiscoveryToMissionIntent,
  constrainToolsToMissionGraphFrontier,
  filterSetLooseToolNamesByMissionGraphAuthority,
  dedupeSingletonMissionGraphPrerequisites,
  isMissionGraphAcceptablyComplete,
  isReceiptBackedFinalProjectionReady,
  constrainOrchestratedHandoffTools,
  ensureResearchSourceLoopBudget,
  ensureRequiredWriteLoopBudget,
  evaluateValidationRecoveryCorrectionReceiptV1,
  evaluateCompoundResearchBudgetGateV1,
  evaluateCompoundResearchToolCallGateV1,
  executePreparedToolWithMetrics,
  extractExactMarkdownReplacementPayload,
  findExactGraphBoundToolCallIndex,
  getExplicitMermaidWorkflowToolNames,
  getExplicitCodeToolNames,
  getCodeCapabilityRegistrationBlockerV1,
  getRequiredCodeWorkflowToolNames,
  getExplicitLinearMutationToolNames,
  getExplicitLinearReadToolNames,
  getUnsafeModelLinearIssueCreateOutputMessage,
  getActiveValidationRecoveryFrontierV1,
  diagnosticRequestsFullFileReplacement,
  getDiagnosticSelectedWorkspaceCorrectionPaths,
  getLatestFastValidationDiagnostic,
  getValidationRecoveryCorrectionTargetPathV1,
  getVerifiedWorkspaceReadObservation,
  getVerifiedWorkspaceReadRefreshBinding,
  getVerifiedWorkspaceSupportingReadRefreshBindings,
  getVerifiedWorkspaceWriteObservation,
  getVerifiedLinearHierarchyIssueId,
  getCompoundLifecycleResearchGraphToolNames,
  rejectDuplicateResearchSourceFetchV1,
  getMissionGraphFrontierDestinationSelector,
  getPendingMissionGraphWriteToolNames,
  getPendingRequiredWriteToolNames,
  getRequiredWriteToolNamesForTests,
  getDurablyProvenCompletedGraphToolNames,
  getRestorableCompletedGraphToolNames,
  hasPreparedBackgroundCodeValidationCommitIntent,
  hasIgnoreRememberedContextIntent,
  insertExplicitLinearReadbacksIntoLifecycleToolNames,
  hasReadyOrRunningMissionGraphUnpaidWork,
  hasUnpaidCodeExecutionTerminalValidationBlocker,
  isTerminalMissionGraphBlocker,
  mayBypassMissionGraphStartForSetLooseSoftCompanion,
  missionGraphOwnsAcceptedResearchNoteWritebackV1,
  shouldFinishRunForTerminalMissionGraphBlockers,
  resolveEffectiveTerminalStopReasonV1,
  resolveMissionGraphToolResultOk,
  resolveToolOutcomeMemoryDispositionV1,
  receiptProvesWorkspaceContentChangeV1,
  resolveLinearIssueReadbackBinding,
  decideLinearGetIssueHostBindingV1,
  collectLinearIssueBindingCandidates,
  pickCanonicalLinearIssueId,
  resolveActiveCompoundLifecycleStageV1,
  resolveCompoundCompletionSegmentBudgetV1,
  restrictCompoundResearchClosureToolsV1,
  resolveThinkingMode,
  rememberVerifiedWorkspaceReadResult,
  rememberLatestFastValidationDiagnostic,
  restoreLatestFastValidationDiagnosticFromReceipts,
  restorePassedFastRepairCycleFromReceipts,
  reconcileOutstandingMissionGraphToolStepBudget,
  resolveMissionGraphExecutionProofContractV1,
  resolveHasMatchingGrantForAutoContinuation,
  restoreTrustedWebFetchResultsFromEvidence,
  runAgentMission,
  sanitizeAssistantContent,
  shouldDeferAdditionalProjectLifecycleMutation,
  shouldDeferAdditionalWorkspaceCorrection,
  buildStreamingWritebackPromptForTests,
  buildWordCountCorrectionPromptForTests,
  softWordCountCorrectionBand,
  type AgentRunCompleteEvent,
  type AgentRunConfigEvent,
  type AgentRunMetricEvent,
  type AgentRunReceipt,
  type AgentTraceEvent,
} from "../src/AgentRunner";
import {
  hasCodeDeliverableIntent,
  hasExplicitCodeExecutionProhibition,
} from "../src/agent/codeDeliverableIntent";
import { ModelClientError } from "../src/model/types";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
  ModelToolCall,
} from "../src/model/types";
import type {
  AgentRuntimeCache,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "../src/tools/types";
import type {
  AgentSettings,
  StreamWritebackMode,
  ThinkingMode,
} from "../src/settings";
import type { SemanticEmbeddingProvider } from "../src/embeddings/types";
import {
  BACKUP_FOLDER,
  MAX_INITIAL_CURRENT_NOTE_CHARS,
} from "../src/tools/constants";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import {
  LINEAR_ISSUE_TEMPLATE_PATH,
  LINEAR_ISSUE_TEMPLATE_V1,
} from "../src/tools/agentTemplateLibrary";
import {
  ApprovalBroker,
  type ApprovalRequest,
} from "../src/agent/approvalBroker";
import { __setCodeToolsDesktopAppForTests } from "../src/tools/codeTools";
import { extractEvidencePassages } from "../src/agent/researchDossier";
import {
  sha256Fingerprint,
  withPreparedActionFingerprint,
  type ActionReceipt,
  type AuthorizedActionContext,
  type PreparedAction,
  type ToolDescriptor,
} from "../src/agent/actions";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import type { AgentTool } from "../src/tools/types";
import { parseMissionRuntimeSnapshotFromMarkdown } from "../src/agent/runStore";
import { buildOperationReconciliationInputs } from "../src/agent/runStore";
import { parseMissionGraphStoreRecordFromMarkdown } from "../src/agent/missionGraphStore";
import {
  parseMissionLedgerFromMarkdown,
  type MissionEvidence,
} from "../src/agent/missionLedger";
import type { MissionAcceptanceResult } from "../src/agent/missionAcceptance";
import { validateContinuationHandoffV1 } from "../src/agent/continuationMemory";
import {
  prepareCompanionJobV1,
  type CompanionJobV1,
} from "../packages/headless-runtime/src/backgroundContinuation";
import type { CompanionRemoteJobV1 } from "../packages/headless-runtime/src/companionCoordinatorClient";
import { createPreparedBackgroundCodeActionV1 } from "../packages/core-api/src/preparedBackgroundCodeActionV1";
import { createPreparedBackgroundCodePackageIdentityV1 } from "../packages/core-api/src/preparedBackgroundCodePackageIdentityV1";
import type { BackgroundMissionDispatchPortV1 } from "../src/agent/backgroundMissionDispatch";
import {
  consumeAuthorityGrant,
  createBoundedGrant,
} from "../src/agent/authority";
import {
  CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  createGitHubPrivateRepositoryTool,
} from "../src/tools/githubPrivateRepositoryTool";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import { hasExplicitResearchPublicationIntent } from "../src/tools/researchPublicationTool";
import { buildByokPhaseAResearchPrompt } from "../e2e/fixtures/byokAutonomousJourneyPrompt";
import { isCompletedAcceptedResearchPublicationReceipt } from "../src/agent/setLooseCompoundAutonomy";
import { completedResearchPublicationReceiptFixture } from "./fixtures/completedResearchPublicationReceipt";

test("resumed atomic publication graph keeps current-note ownership only without a standalone writer", () => {
  const graph = (allowedTools: string[][]) => ({
    nodes: Object.fromEntries(
      allowedTools.map((tools, index) => [
        `node-${index}`,
        { allowedTools: tools },
      ]),
    ),
  });
  assert.equal(
    missionGraphOwnsAcceptedResearchNoteWritebackV1(
      graph([
        ["web_fetch"],
        ["publish_research_to_linear"],
        ["read_current_file"],
      ]),
    ),
    true,
  );
  assert.equal(
    missionGraphOwnsAcceptedResearchNoteWritebackV1(
      graph([
        ["publish_research_to_linear"],
        ["append_to_current_file"],
      ]),
    ),
    false,
  );
  assert.equal(
    missionGraphOwnsAcceptedResearchNoteWritebackV1(
      graph([["linear_create_issue"], ["append_to_current_file"]]),
    ),
    false,
  );
});

test("prepared background Code intent requires an affirmative scoped continuation", () => {
  assert.equal(
    hasPreparedBackgroundCodeValidationCommitIntent(
      "Continue the exact prepared Code validation commit in the background.",
    ),
    true,
  );
  assert.equal(
    hasPreparedBackgroundCodeValidationCommitIntent(
      "Invoke only code_validate_commit_prepared for repairRequestId bg1, then continue this Code validation and commit in the background.",
    ),
    true,
  );
  assert.equal(
    hasPreparedBackgroundCodeValidationCommitIntent(
      "Explain how background Code validation commit execution works.",
    ),
    false,
  );
  assert.equal(
    hasPreparedBackgroundCodeValidationCommitIntent(
      "Do not run the exact prepared Code validation commit in the background; only describe it.",
    ),
    false,
  );
});

test("explicit Code tool selection does not widen a tool name to its prefix", () => {
  assert.deepEqual(
    getExplicitCodeToolNames(
      "Use code_workspace_create_file through the prepared action path.",
    ),
    ["code_workspace_create_file"],
  );
  assert.deepEqual(
    getExplicitCodeToolNames(
      "Use code_workspace_create, then code_workspace_create_file exactly once.",
    ),
    ["code_workspace_create", "code_workspace_create_file"],
  );
});

test("single explicit web_fetch target and cache policy override provider drift", () => {
  const bound = bindExplicitWebFetchContract(
    "Call web_fetch once for https://primary.owned.example/evidence/marker with refresh=false.",
    {
      id: "fetch-1",
      name: "web_fetch",
      arguments: {
        url: "https://alternate.owned.example/evidence/marker",
        refresh: true,
      },
    },
  );
  assert.deepEqual(bound?.arguments, {
    url: "https://primary.owned.example/evidence/marker",
    refresh: false,
  });

  assert.equal(
    bindExplicitWebFetchContract(
      "Compare web_fetch results from https://one.example/a and https://two.example/b.",
      {
        id: "fetch-2",
        name: "web_fetch",
        arguments: { url: "https://one.example/a" },
      },
    ),
    null,
  );
  assert.equal(
    bindExplicitWebFetchContract(
      "Read https://primary.owned.example/evidence/marker without naming a tool.",
      {
        id: "fetch-3",
        name: "web_fetch",
        arguments: { url: "https://primary.owned.example/evidence/marker" },
      },
    ),
    null,
  );
});

test("verified candidates restore only missing exact user-required literal markers", () => {
  const marker = "E2E_MARKER_LITERAL_NORMALIZATION_01";
  const normalized = attachMissingRequiredLiteralAnchors(
    "## Findings\n\nGrounded candidate.",
    `Append the findings and include ${marker}.`,
  );
  assert.deepEqual(normalized.insertedAnchors, [marker]);
  assert.equal(
    normalized.content,
    `## Findings\n\nGrounded candidate.\n\n${marker}`,
  );
  assert.deepEqual(
    attachMissingRequiredLiteralAnchors(
      normalized.content,
      `Append the findings and include ${marker}.`,
    ),
    { content: normalized.content, insertedAnchors: [] },
  );
});

test("explicit code commit naming expands the durable validate/repair ladder", () => {
  assert.deepEqual(
    getRequiredCodeWorkflowToolNames(
      [
        "call code_sandbox_status, code_workspace_create, code_workspace_create_file for src/flow_real.ts,",
        "validate, then code_commit_verified when ready.",
      ].join(" "),
    ),
    [
      "code_sandbox_status",
      "code_workspace_create",
      "code_workspace_create_file",
      "code_validate_fast",
      "code_repair_record_cycle",
      "code_validate_targeted",
      "code_validate_full",
      "code_commit_verified",
    ],
  );
});

test("issue-bound private publication bootstraps the repository before publish", () => {
  const prompt = [
    "Review and implement Linear issue issue-1.",
    "Begin with an independent linear_get_issue read of that exact identity.",
    "Implement the requested Python library in its bound trusted repository and create one verified local commit.",
    "Publish the exact behaviorally tested commit to the issue-bound private GitHub destination as one open draft pull request; never merge it.",
  ].join(" ");
  const required = getRequiredWriteToolNamesForTests(prompt, [
    "linear_get_issue",
    "code_sandbox_status",
    "code_workspace_create",
    "code_workspace_create_file",
    "code_validate_fast",
    "code_repair_record_cycle",
    "code_validate_targeted",
    "code_validate_full",
    "code_commit_verified",
    CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    "publish_verified_code_to_github",
  ]);
  const createIndex = required.indexOf(
    CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  );
  const publishIndex = required.indexOf("publish_verified_code_to_github");
  assert.ok(
    createIndex >= 0,
    `expected repository bootstrap in ${required.join(", ")}`,
  );
  assert.ok(
    publishIndex > createIndex,
    `repository bootstrap must precede publication: ${required.join(", ")}`,
  );
});

test("standalone nested code delivery routes through workspace creation and approved Desktop export without a repository commit", () => {
  assert.deepEqual(
    getRequiredCodeWorkflowToolNames(
      "Create a Python checkers game with nested folders and put it on my desktop.",
    ),
    // No code_repair_record_cycle: it resolves a trusted repository worktree
    // and fails closed on a scratch workspace, which stranded the mission
    // after the files were authored but before they were exported. create_file
    // creates missing parents, so delivery-folder prose must not add an empty
    // mkdir action to this source-authoring ladder.
    [
      "code_sandbox_status",
      "code_workspace_create",
      "code_workspace_create_file",
      "code_validate_fast",
      "code_validate_targeted",
      "code_validate_full",
      "code_workspace_export_directory",
    ],
  );
});

test("bare Python Desktop delivery requires scratch creation, validation, and export without note writeback or commit", () => {
  assert.deepEqual(
    getRequiredCodeWorkflowToolNames(
      "write a number guessing game in Python on my desktop",
    ),
    [
      "code_sandbox_status",
      "code_workspace_create",
      "code_workspace_create_file",
      "code_validate_fast",
      "code_validate_targeted",
      "code_validate_full",
      "code_workspace_export_directory",
    ],
  );
});

test("phase-scoped code creation prohibition does not erase constrained authoring intent", () => {
  const cases = [
    {
      prompt:
        "Research the library. Do not implement code in this phase. The Phase B package uses Python.",
      prohibited: true,
      deliverable: false,
    },
    {
      prompt: "Do not just research; implement code.",
      prohibited: false,
      deliverable: true,
    },
    {
      prompt: "Implement a Python package without committing the code.",
      prohibited: false,
      deliverable: true,
    },
    {
      prompt:
        "Do not execute the script; write the Python script but do not run it.",
      prohibited: false,
      deliverable: true,
    },
    {
      prompt: "Never implement code without tests; build the Python library.",
      prohibited: false,
      deliverable: true,
    },
    {
      prompt:
        "Do not implement code now; implement the accepted contract in Phase B.",
      prohibited: true,
      deliverable: false,
    },
  ] as const;

  for (const fixture of cases) {
    assert.equal(
      hasExplicitCodeExecutionProhibition(fixture.prompt),
      fixture.prohibited,
      fixture.prompt,
    );
    assert.equal(
      hasCodeDeliverableIntent(fixture.prompt),
      fixture.deliverable,
      fixture.prompt,
    );
  }
});

test("code delivery with no offered Code tools produces a host blocker before model execution", () => {
  const blocker = getCodeCapabilityRegistrationBlockerV1({
    prompt: "write a number guessing game in Python on my desktop",
    offeredToolNames: new Set(["append_to_current_file"]),
    registeredToolNames: new Set(),
    readiness: [{
      version: 2,
      id: "code",
      name: "Code",
      status: "Blocked",
      reason: "The Code runtime is not registered.",
      evidenceAt: null,
      nextAction: "Reload Code capability",
      setupTarget: "code",
    }],
  });
  assert.equal(blocker?.code, "code_capability_tools_unavailable");
  assert.match(blocker?.message ?? "", /No model call was made/iu);
  assert.equal(blocker?.reason, "The Code runtime is not registered.");
  assert.equal(blocker?.nextAction, "Reload Code capability");
  assert.ok(blocker?.requiredToolNames.includes("code_workspace_export_directory"));
});

test("Code capability blocker ignores direct discussion and non-workspace code surfaces", () => {
  assert.equal(
    getCodeCapabilityRegistrationBlockerV1({
      prompt:
        "What is difficult about turning Linear issues into real code project files?",
      offeredToolNames: new Set(),
      registeredToolNames: new Set(),
      executionTier: "direct_chat",
    }),
    null,
  );
  assert.deepEqual(
    getRequiredCodeWorkflowToolNames(
      "Write Hello World in TypeScript on this page and stream it to the note.",
    ),
    [],
  );
  assert.deepEqual(
    getRequiredCodeWorkflowToolNames(
      "Run the python code snippet after installing the requests package.",
    ),
    [],
  );
  assert.deepEqual(
    getRequiredCodeWorkflowToolNames(
      "Research American checkers rules and write the result to Projects/Checkers/Research.md.",
    ),
    [],
  );
  assert.deepEqual(
    getRequiredCodeWorkflowToolNames(
      "Push the latest verified local commit for profile trusted-repository to GitHub and open a draft PR.",
    ),
    [],
  );
});

test("canonical mission graph ids normalize generated run ids and bounded suffixes", () => {
  assert.equal(
    canonicalMissionGraphId("run-2026-07-13T03-23-36.470Z-ABC123"),
    "run-2026-07-13t03-23-36.470z-abc123",
  );
  const bounded = canonicalMissionGraphId(`${"a".repeat(127)}--lead`);
  assert.equal(bounded.length, 127);
  assert.match(bounded, /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/u);
});

test("Researcher handoff hides unrequested word-count verification", () => {
  const tools = ["web_fetch", "count_words", "append_to_current_file"].map(
    (name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object", properties: {} } },
    }),
  );
  const prompt =
    "Use the Researcher handoff and append the verified synthesis to the current note.";

  assert.deepEqual(
    constrainOrchestratedHandoffTools(
      tools,
      prompt,
      "Researcher handoff with verified source passages.",
    ).map((tool) => tool.function.name),
    ["web_fetch", "append_to_current_file"],
  );
  assert.ok(
    constrainOrchestratedHandoffTools(
      tools,
      `${prompt} Then verify the word count.`,
      "Researcher handoff with verified source passages.",
    ).some((tool) => tool.function.name === "count_words"),
  );
});

test("grounded citation normalization adds only known verifier-bound passage ids", () => {
  const alpha = "source:alpha:passage:0-40";
  const beta = "source:beta:passage:0-42";
  const draft = [
    "Alpha evidence supports the first bounded finding.",
    "Beta evidence supports the second bounded finding.",
  ].join("\n");
  const normalized = attachGroundedPassageCitations(draft, {
    version: 1,
    status: "pass",
    knownPassageIds: [alpha, beta],
    missing: [],
    reasons: [],
    requireQuoteSpans: false,
    claims: [
      {
        id: "claim:1",
        text: "Alpha evidence supports the first bounded finding.",
        status: "grounded",
        passageIds: [alpha],
      },
      {
        id: "claim:2",
        text: "Beta evidence supports the second bounded finding.",
        status: "grounded",
        passageIds: [beta, "source:unknown:passage:0-99"],
      },
    ],
  });

  assert.deepEqual(normalized.insertedPassageIds, [alpha, beta]);
  assert.match(
    normalized.content,
    /Alpha evidence supports the first bounded finding \[source:alpha:passage:0-40\]\./u,
  );
  assert.match(
    normalized.content,
    /Beta evidence supports the second bounded finding \[source:beta:passage:0-42\]\./u,
  );
  assert.doesNotMatch(normalized.content, /unknown/u);

  const scoped = attachGroundedPassageCitations(
    draft,
    {
      version: 1,
      status: "pass",
      knownPassageIds: [alpha, beta],
      missing: [],
      reasons: [],
      requireQuoteSpans: false,
      claims: [
        {
          id: "claim:1",
          text: "Alpha evidence supports the first bounded finding.",
          status: "grounded",
          passageIds: [alpha],
        },
        {
          id: "claim:2",
          text: "Beta evidence supports the second bounded finding.",
          status: "grounded",
          passageIds: [beta],
        },
      ],
    },
    [beta],
  );
  assert.deepEqual(scoped.insertedPassageIds, [beta]);
  assert.doesNotMatch(scoped.content, /source:alpha/u);
});

test("passage citation scope removes context-only ids without authorizing the draft", () => {
  const web = "source:web-evidence:passage:0-80";
  const currentNote = "source:current-note:passage:0-120";
  const scoped = constrainPassageCitationScope(
    [
      `Fetched evidence supports the result [${web}] [${currentNote}].`,
      `Context-only assertion [${currentNote}] remains text but loses its marker.`,
    ].join("\n"),
    [web],
  );

  assert.deepEqual(scoped.removedPassageIds, [currentNote]);
  assert.match(scoped.content, new RegExp(`\\[${web}\\]`, "u"));
  assert.doesNotMatch(scoped.content, /source:current-note/u);
  assert.match(scoped.content, /supports the result \[source:web-evidence/u);

  const noAcceptedProof = constrainPassageCitationScope(
    `Unsupported claim [${currentNote}].`,
    [web],
  );
  assert.equal(noAcceptedProof.content, "Unsupported claim.");
  assert.deepEqual(noAcceptedProof.removedPassageIds, [currentNote]);
});

test("pure-vault durable writeback retains vault citation authority while hybrid remains web-only", () => {
  const vaultPassageId = "source:vault-note:passage:0-90";
  const webPassageId = "source:web-evidence:passage:0-80";
  const evidence = [
    {
      id: "vault:note",
      kind: "vault_note" as const,
      title: "Vault note",
      path: "Research/Vault note.md",
      passageId: vaultPassageId,
      passageIds: [vaultPassageId],
      summary: "The vault note contains the local finding.",
      confidence: "high" as const,
    },
    {
      id: "web:source",
      kind: "web_source" as const,
      title: "Fetched source",
      url: "https://example.com/source",
      passageId: webPassageId,
      passageIds: [webPassageId],
      summary: "The fetched source contains the public finding.",
      confidence: "high" as const,
      usableSource: true,
      parserStatus: "parsed" as const,
    },
  ];
  const basePlan = {
    version: 1 as const,
    coverageRequirements: {
      minVaultCoverageConfidence: "high" as const,
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [],
    evidenceIds: [],
    status: "in_progress" as const,
  };

  const vaultScoped = buildScopedDurableEvidenceForWriteback(evidence, {
    ...basePlan,
    mode: "deep_vault",
    sourceRequirements: {
      minFetchedSources: 0,
      minDistinctDomains: 0,
    },
  });
  assert.equal(vaultScoped.citationScope, "vault");
  assert.deepEqual(vaultScoped.acceptedPassageIds, [vaultPassageId]);
  assert.match(vaultScoped.content, new RegExp(vaultPassageId, "u"));
  assert.doesNotMatch(vaultScoped.content, new RegExp(webPassageId, "u"));
  assert.match(vaultScoped.content, /durable vault passage identifiers/iu);

  const hybridScoped = buildScopedDurableEvidenceForWriteback(evidence, {
    ...basePlan,
    mode: "deep_hybrid",
    sourceRequirements: {
      minFetchedSources: 1,
      minDistinctDomains: 1,
    },
  });
  assert.equal(hybridScoped.citationScope, "fetched_web");
  assert.deepEqual(hybridScoped.acceptedPassageIds, [webPassageId]);
  assert.match(hybridScoped.content, new RegExp(webPassageId, "u"));
  assert.doesNotMatch(hybridScoped.content, new RegExp(vaultPassageId, "u"));
  assert.match(hybridScoped.content, /Vault context may inform synthesis/iu);

  const legacyWebPassageId = "source:legacy-web:passage:0-70";
  const legacyScoped = buildScopedDurableEvidenceForWriteback(
    [
      {
        id: "web:legacy",
        kind: "web_source",
        title: "Legacy fetched source",
        url: "https://example.com/legacy",
        passageId: legacyWebPassageId,
        passageIds: [legacyWebPassageId],
        summary: "Persisted legacy evidence has a URL and exact passage proof.",
        confidence: "high",
      },
    ],
    {
      ...basePlan,
      mode: "deep_web",
      sourceRequirements: {
        minFetchedSources: 1,
        minDistinctDomains: 1,
      },
    },
  );
  assert.deepEqual(legacyScoped.acceptedPassageIds, [legacyWebPassageId]);

  const emptyWebScope = buildScopedDurableEvidenceForWriteback(
    [evidence[0]!],
    {
      ...basePlan,
      mode: "deep_web",
      sourceRequirements: {
        minFetchedSources: 1,
        minDistinctDomains: 1,
      },
    },
  );
  assert.deepEqual(emptyWebScope.acceptedPassageIds, []);
  assert.doesNotMatch(emptyWebScope.content, new RegExp(vaultPassageId, "u"));
});

test("research plans reserve web search and fetch in the authoritative loop budget", () => {
  const updated = ensureResearchSourceLoopBudget(
    {
      hardCap: 10,
      toolStepBudget: 1,
      finalizationReserve: 2,
      expectedTools: ["append_to_current_file", "web_search"],
      stopWhenSatisfied: false,
    },
    3,
  );

  assert.equal(updated.toolStepBudget, 4);
  assert.deepEqual(updated.expectedTools, [
    "append_to_current_file",
    "web_search",
    "web_fetch",
  ]);
  assert.equal(updated.stopWhenSatisfied, true);
});

test("research source budget augmentation is bounded and skips vault-only plans", () => {
  const vaultOnly = {
    hardCap: 4,
    toolStepBudget: 1,
    finalizationReserve: 1,
    expectedTools: ["semantic_search_notes"],
    stopWhenSatisfied: true,
  };
  assert.equal(ensureResearchSourceLoopBudget(vaultOnly, 0), vaultOnly);

  const constrained = ensureResearchSourceLoopBudget(
    {
      hardCap: 2,
      toolStepBudget: 0,
      finalizationReserve: 1,
      expectedTools: [],
      stopWhenSatisfied: false,
    },
    1,
  );
  assert.equal(constrained.toolStepBudget, 1);
  assert.deepEqual(constrained.expectedTools, ["web_search", "web_fetch"]);
});

test("exact platform assessment override is one-call direct chat with no side effects", async () => {
  const prompt =
    "The current platform that I created to give you tools, NO specific document, I want you to rate actual usefulness.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const traces: AgentTraceEvent[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          "The platform is useful, but its intent routing and durable proof ergonomics still need work.",
        ),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({ maxAgentSteps: 100 }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
      onTrace: (event) => traces.push(event),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.deepEqual(chatRequests[0].tools ?? [], []);
  assert.deepEqual(executedCalls, []);
  assert.deepEqual(deltas, [
    "The platform is useful, but its intent routing and durable proof ergonomics still need work.",
  ]);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stopReason, "final");
  assert.ok(
    traces.some((event) => event.id === "capability-snapshot-v1"),
    "platform assessment should receive a truthful capability snapshot",
  );
  assert.equal(
    chatRequests[0].messages.some((message) =>
      /Mission Plan|Remaining tasks|progress score/iu.test(message.content),
    ),
    false,
  );
});

test("exact pipeline-difficulty question stays one-call direct chat", async () => {
  const prompt =
    "From your perspective, what is hard about doing research in Obsidian, agentically, converting the notebook into Linear issues, Linear issues to real code project code files, GitHub and finally a reflection?";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          "The hard parts are preserving provenance, binding each handoff, proving the exact commit and PR head, and grounding reflection in the durable ledger.",
        ),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({ maxAgentSteps: 100 }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.deepEqual(chatRequests[0].tools ?? [], []);
  assert.deepEqual(executedCalls, []);
  assert.equal(completions[0]?.stopReason, "final");
  assert.equal(
    chatRequests[0].messages.some((message) =>
      /\b(?:append_research_memory|code_workspace_create|linear_create_issue)\b/u.test(
        message.content,
      ),
    ),
    false,
  );
});

test("unchanged executable frontier blocks after two no-tool model responses", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];
  const traces: AgentTraceEvent[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I should search, but I did not call the tool."),
      () => responseWithContent("I still did not call the required tool."),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for the latest Obsidian release and cite the source.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings(),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
      onTrace: (event) => traces.push(event),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.equal(chatRequests[1]?.toolChoice, "required");
  assert.equal(chatRequests[1]?.think, false);
  assert.match(
    chatRequests[1]?.messages
      .map((message) => String(message.content ?? ""))
      .join("\n") ?? "",
    /prior response contained prose but no tool call[\s\S]*Call the single most relevant tool now[\s\S]*Return the tool call only/iu,
  );
  assert.deepEqual(executedCalls, []);
  assert.match(deltas.join(""), /twice returned no tool call/iu);
  assert.ok(
    traces.some(
      (event) =>
        event.error?.code === "model_tool_noncompliance" &&
        (event.outputPreview as { attempts?: number } | undefined)?.attempts === 2,
    ),
  );
  assert.equal(completions[0]?.stopReason, "error");
});

test("observes the current note before the first model planning step", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Final answer")],
  });

  await runAgentMission({
    prompt: "What is this current note about?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.deepEqual(executedCalls[0].arguments, {
    maxChars: MAX_INITIAL_CURRENT_NOTE_CHARS,
  });
  assert.equal(chatRequests.length, 1);
  const currentNoteContextMessage = chatRequests[0].messages.find((message) =>
    /Current note context/.test(message.content),
  );
  assert.ok(currentNoteContextMessage);
  assert.match(currentNoteContextMessage.content, /"path":"Current.md"/);
  assert.match(currentNoteContextMessage.content, /"content":"Initial note"/);
  const progressStatuses = statuses.filter(
    (message) => !message.startsWith("set_loose_compound="),
  );
  assert.deepEqual(progressStatuses.slice(0, 3), [
    "Reading current note...",
    "Planning...",
    "Agent step 1 of max 6...",
  ]);
  assert.deepEqual(deltas, ["Final answer"]);
  assert.ok(statuses.includes("Done."));
});

test("current-note observe failure stops before calling the model", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("should not run")],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt: "What is this current note about?",
        modelClient: client,
        toolRegistry: createRegistry(executedCalls, {
          readCurrentError: "An active markdown file is required.",
        }),
        toolContext: {} as ToolExecutionContext,
        enableStreaming: false,
      }),
    /active markdown file/,
  );

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.equal(chatRequests.length, 0);
});

test("vague follow-up continues a pending current-note read", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Current note content: Initial note")],
  });

  await runAgentMission({
    prompt: "Continue",
    conversationHistory: [
      {
        role: "assistant",
        content: "I'll read the current note to see what prompt is available.",
      },
    ],
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.equal(chatRequests.length, 1);
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /Resolve this turn's tool routing as: "Read the current note\."/i.test(
        message.content,
      ),
    ),
  );
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /Current note context/.test(message.content),
    ),
  );
  assert.deepEqual(deltas, ["Current note content: Initial note"]);
});

test("includes prior user and assistant chat history before current prompt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          "Coral reefs are living ocean cities with intricate food webs and natural storm protection.",
        ),
    ],
  });

  await runAgentMission({
    prompt: "Edit the essay you gave me with more details.",
    conversationHistory: [
      { role: "user", content: "Write a short essay about coral reefs." },
      { role: "assistant", content: "Coral reefs are living ocean cities." },
    ],
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 1);
  const messages = chatRequests[0].messages;
  assert.match(
    messages.at(-4)?.content ?? "",
    /Recent chat history is included/,
  );
  assert.deepEqual(messages.slice(-3), [
    { role: "user", content: "Write a short essay about coral reefs." },
    { role: "assistant", content: "Coral reefs are living ocean cities." },
    { role: "user", content: "Edit the essay you gave me with more details." },
  ]);
  assert.deepEqual(deltas, [
    "Coral reefs are living ocean cities with intricate food webs and natural storm protection.",
  ]);
});

test("tool-loop turns use chat only and emit direct final answer without synthesis", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const deltas: string[] = [];
  const thinkingDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "WW2 causes" }),
      () => responseWithToolCall("web_search", { query: "WW2 battles" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () =>
        responseWithContent(
          "Final WW2 answer. Source: https://example.com/source",
          "thinking from final",
        ),
    ],
  });

  await runAgentMission({
    prompt: "Search the web and give me a short overview of WW2.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 4);
  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_search", "web_fetch"],
  );
  assert.deepEqual(
    executedCalls
      .filter((call) => call.name === "web_search")
      .map((call) => call.arguments.query),
    ["WW2 causes", "WW2 battles"],
  );
  assert.deepEqual(deltas, [
    "Final WW2 answer. Source: https://example.com/source",
  ]);
  assert.deepEqual(thinkingDeltas, ["thinking from final"]);
});

test("streaming tool-loop steps stream thinking, keep in-flight thinking, and skip note writeback for pre-tool content", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const streamToolRequests: ModelChatRequest[] = [];
  const assistantDeltas: string[] = [];
  const thinkingDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt: "Search the web and give me a short overview of WW2.",
    content: "Do not overwrite this note.",
  });
  vault.context.settings = createRunnerSettings({
    enableStreaming: true,
    streamWritebackMode: "off",
    thinkingMode: "high",
    model: "qwen3:8b",
    modelRouterMode: "off",
    workingMode: "chat_only",
    outputProfile: "chat_first",
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamToolRequests,
    chatResponders: [
      () => ({
        ...responseWithToolCall("web_search", { query: "WW2 causes" }, ""),
        message: {
          role: "assistant" as const,
          content: "pre-tool prose must not hit the note",
          thinking: "planning web search",
          toolCalls: [
            { name: "web_search", arguments: { query: "WW2 causes" } },
          ],
        },
        thinkingDeltas: ["planning web search"],
        contentDeltas: ["pre-tool prose must not hit the note"],
      }),
      () =>
        responseWithContent(
          "Final WW2 answer. Source: https://example.com/source",
          "final private thinking",
        ),
    ],
  });

  await runAgentMission({
    prompt: "Search the web and give me a short overview of WW2.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    forceChatOnly: true,
    events: {
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
    },
  });

  assert.ok(
    streamToolRequests.length > 0,
    "tool steps should use streamChat when streaming is enabled",
  );
  assert.ok(
    chatRequests.some((request) =>
      request.messages.some(
        (message) =>
          message.role === "assistant" &&
          (message.toolCalls?.length ?? 0) > 0 &&
          message.thinking === "planning web search",
      ),
    ),
    "in-flight assistant tool turns must retain thinking for the next model call",
  );
  assert.ok(
    thinkingDeltas.includes("planning web search"),
    thinkingDeltas.join(" | "),
  );
  assert.ok(
    !assistantDeltas.some((delta) =>
      delta.includes("pre-tool prose must not hit the note"),
    ),
    assistantDeltas.join(" | "),
  );
  assert.equal(
    vault.content.get("Current.md"),
    "Do not overwrite this note.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search"],
  );
});

test("assistant JSON tool blocks are recovered and executed as tool calls", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const deltas: string[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          [
            "I'll inspect the current folder first.",
            "",
            "```json",
            '{ "name": "list_current_folder" }',
            "```",
          ].join("\n"),
        ),
      () => responseWithContent("I found the folder details."),
    ],
  });

  await runAgentMission({
    prompt: "Inspect the vault structure with tools.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["list_current_folder"],
  );
  assert.deepEqual(deltas, ["I found the folder details."]);
  assert.ok(
    statuses.some((message) =>
      message.includes("Recovered text tool request: list_current_folder"),
    ),
  );
});

test("assistant compact tool JSON recovers tool field and top-level arguments", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          '{"tool":"rename_current_file","title":"History Snapshot"}',
        ),
      () => responseWithContent("Renamed."),
    ],
  });

  await runAgentMission({
    prompt: "No, you need to target Untitled and then change that.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  assert.deepEqual(
    executedCalls.map((call) => [call.name, call.arguments.title]),
    [["read_current_file", undefined], ["rename_current_file", "History Snapshot"]],
  );
});

test("vague keep-going prompts inherit prior vault tool exploration intent", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("list_folder", { path: "" }),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () => responseWithContentDeltas(["Vault folder exploration can continue."]),
    ],
  });

  await runAgentMission({
    prompt: "Keep going",
    conversationHistory: [
      {
        role: "assistant",
        content:
          'I will inspect the vault root.\n```json\n{ "name": "list_folder", "arguments": { "path": "/" } }\n```',
      },
    ],
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.equal(streamRequests.length, 1);
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /Continue the prior vault exploration/.test(message.content),
    ),
  );
  assert.ok(
    chatRequests[0].tools
      ?.map((tool) => tool.function.name)
      .includes("list_folder"),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["list_folder"],
  );
  assert.deepEqual(finalDeltas, ["Vault folder exploration can continue."]);
});

test("static essay prompts stream to chat and append to the current note", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const planningDeltas: string[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const statuses: string[] = [];
  const vault = createRunnerVaultContext({
    prompt: "Write me a short essay about the Mexican-American war.",
    content: "Existing note",
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "A 300 word ",
          "Mexican-American War essay.",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Write me a short essay about the Mexican-American war.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onPlanningDelta: (delta) => planningDeltas.push(delta),
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [],
  );
  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].tools, undefined);
  assert.equal(streamRequests[0].think, false);
  assert.deepEqual(planningDeltas, []);
  assert.deepEqual(finalDeltas, ["A 300 word Mexican-American War essay."]);
  assert.deepEqual(assistantDeltas, ["A 300 word Mexican-American War essay."]);
  assert.equal(
    vault.content.get("Current.md"),
    "Existing note\nA 300 word Mexican-American War essay.",
  );
  assert.ok(statuses.includes("Using direct note writeback; no tool loop needed..."));
  assert.ok(statuses.includes("Streaming writeback to note..."));
});

test("plain Q&A defaults to streamed current-note writeback when an active note exists", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const receipts: AgentRunReceipt[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const vault = createRunnerVaultContext({
    prompt: "What is 2+2?",
    content: "# Scratch\n\n",
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["2+2 equals ", "4."]),
    ],
  });

  await runAgentMission({
    prompt: "What is 2+2?",
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(vault.content.get("Current.md"), "# Scratch\n\n2+2 equals 4.");
  assert.equal(finalDeltas.join(""), "2+2 equals 4.");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "append");
  assert.equal((receipts[0].output as { streamed?: boolean }).streamed, true);
  assert.equal(configs[0].writebackMode, "streaming_current_note");
  assert.equal(configs[0].chatOnlyOverride, false);
  assert.ok((configs[0].modelExecutionBudget?.maxCalls ?? 0) > 0);
  assert.ok(
    (configs[0].modelExecutionBudget?.maxTokens ?? 0) >=
      (configs[0].modelExecutionBudget?.maxCalls ?? 0) * 8_192,
  );
});

test("sourced write budgets reserve a distinct final mutation step", () => {
  const updated = ensureRequiredWriteLoopBudget(
    {
      hardCap: 10,
      toolStepBudget: 3,
      finalizationReserve: 2,
      expectedTools: ["web_search", "web_fetch"],
      stopWhenSatisfied: true,
    },
    ["append_to_current_file"],
  );

  assert.equal(updated.toolStepBudget, 5);
  assert.deepEqual(updated.expectedTools, [
    "web_search",
    "web_fetch",
    "append_to_current_file",
  ]);
});

test("model tool schemas narrow to the authoritative ready graph frontier", () => {
  const definitions = ["web_search", "web_fetch", "append_to_current_file"].map(
    (name) => ({
      type: "function" as const,
      function: {
        name,
        description: name,
        parameters: { type: "object" as const, properties: {} },
      },
    }),
  );
  const constrained = constrainToolsToMissionGraphFrontier(definitions, {
    nodes: {
      search: { status: "complete", allowedTools: ["web_search"] },
      fetch: { status: "complete", allowedTools: ["web_fetch"] },
      write: { status: "ready", allowedTools: ["append_to_current_file"] },
      final: { status: "queued", allowedTools: [] },
    },
  } as never);

  assert.deepEqual(
    constrained.map((tool) => tool.function.name),
    ["append_to_current_file"],
  );
});

test("mission graph acceptance ignores unread optional sibling reads", () => {
  assert.equal(
    isMissionGraphAcceptablyComplete({
      nodes: {
        context: {
          status: "complete",
          dependencyIds: [],
          allowedTools: ["read_current_file"],
          completionContract: { requiredEvidenceKinds: [] },
        },
        research: {
          status: "ready",
          dependencyIds: [],
          allowedTools: ["web_search"],
          completionContract: { requiredEvidenceKinds: [] },
        },
        write: {
          status: "complete",
          dependencyIds: ["context"],
          allowedTools: ["replace_current_file"],
          completionContract: { requiredEvidenceKinds: [] },
        },
        final: {
          status: "complete",
          dependencyIds: ["context", "write"],
          allowedTools: [],
          completionContract: {
            requiredEvidenceKinds: ["final-output"],
          },
        },
      },
    } as never),
    true,
  );
  assert.equal(
    isMissionGraphAcceptablyComplete({
      nodes: {
        write: {
          status: "complete",
          dependencyIds: [],
          allowedTools: ["replace_current_file"],
          completionContract: { requiredEvidenceKinds: [] },
        },
        final: {
          status: "queued",
          dependencyIds: ["write"],
          allowedTools: [],
          completionContract: {
            requiredEvidenceKinds: ["final-output"],
          },
        },
      },
    } as never),
    false,
  );
  // Optional enrichment wrongly listed under final deps must not block.
  assert.equal(
    isMissionGraphAcceptablyComplete({
      nodes: {
        "optional-web_search": {
          status: "ready",
          dependencyIds: [],
          allowedTools: ["web_search"],
          objective: "optional enrichment",
          completionContract: { requiredEvidenceKinds: [] },
        },
        write: {
          status: "complete",
          dependencyIds: [],
          allowedTools: ["replace_current_file"],
          completionContract: { requiredEvidenceKinds: [] },
        },
        final: {
          status: "complete",
          dependencyIds: ["write", "optional-web_search"],
          allowedTools: [],
          completionContract: {
            requiredEvidenceKinds: ["final-output"],
          },
        },
      },
    } as never),
    true,
  );
});

test("ready final suppresses optional tool frontiers and optional write debt", () => {
  const definitions = ["linear_get_issue", "append_file", "web_search"].map((name) => ({
    type: "function" as const,
    function: {
      name,
      parameters: { type: "object" as const, properties: {} },
    },
  }));
  const graph = {
    capabilityEnvelope: {
      tools: {
        linear_get_issue: { effect: "read" },
        append_file: { effect: "mutation" },
      },
    },
    nodes: {
      publication: {
        status: "complete",
        dependencyIds: [],
        allowedTools: ["publish_research_to_linear"],
        completionContract: { requiredEvidenceKinds: [] },
      },
      "optional-tool-12-linear_get_issue": {
        status: "ready",
        dependencyIds: [],
        allowedTools: ["linear_get_issue"],
        objective: "Optional provider readback enrichment.",
        completionContract: { requiredEvidenceKinds: [] },
      },
      "optional-tool-13-append_file": {
        status: "ready",
        dependencyIds: [],
        allowedTools: ["append_file"],
        objective: "Optional compatibility write.",
        completionContract: { requiredEvidenceKinds: [] },
      },
      final: {
        status: "ready",
        dependencyIds: ["publication"],
        allowedTools: [],
        completionContract: { requiredEvidenceKinds: ["final-output"] },
      },
    },
  } as never;

  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(definitions, graph, {
      includeCapabilityReads: true,
    }).map((tool) => tool.function.name),
    [],
    "optional reads must not force another model tool call after the required closure reaches final",
  );
  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(definitions, graph, {
      setLooseOfferedToolNames: ["linear_get_issue", "append_file"],
    }).map((tool) => tool.function.name),
    [],
    "the set-loose stage union must not re-add optional-only tools after final becomes ready",
  );
  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(definitions, graph, {
      setLooseOfferedToolNames: [
        "linear_get_issue",
        "append_file",
        "web_search",
      ],
    }).map((tool) => tool.function.name),
    ["web_search"],
    "unrelated unplanned Soft companions remain available until terminal projection",
  );
  assert.deepEqual(
    getPendingMissionGraphWriteToolNames(graph),
    [],
    "optional mutations never become required write debt",
  );

  const beforeFinal = structuredClone(graph) as any;
  beforeFinal.nodes.final.status = "queued";
  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(definitions, beforeFinal, {
      includeCapabilityReads: false,
    }).map((tool) => tool.function.name),
    ["linear_get_issue", "append_file"],
    "optional enrichment remains callable before the required final frontier is ready",
  );
});

test("authoritative graph writes remain required when router-derived writes are empty", () => {
  const graph = {
    nodes: {
      search: { status: "complete", allowedTools: ["web_search"] },
      write: { status: "ready", allowedTools: ["append_to_current_file"] },
      final: { status: "queued", allowedTools: [] },
    },
  } as never;

  assert.deepEqual(getPendingMissionGraphWriteToolNames(graph), [
    "append_to_current_file",
  ]);
});

test("conventional code graph nodes remain required through validation and commit", () => {
  const graph = {
    nodes: {
      sandbox: { status: "complete", allowedTools: ["code_sandbox_status"] },
      workspace: { status: "complete", allowedTools: ["code_workspace_create"] },
      sourceRead: { status: "complete", allowedTools: ["code_workspace_read"] },
      sourceWrite: { status: "complete", allowedTools: ["code_workspace_create_file"] },
      fast: { status: "ready", allowedTools: ["code_validate_fast"] },
      repair: { status: "queued", allowedTools: ["code_repair_record_cycle"] },
      targeted: { status: "queued", allowedTools: ["code_validate_targeted"] },
      full: { status: "queued", allowedTools: ["code_validate_full"] },
      commit: { status: "queued", allowedTools: ["code_commit_verified"] },
      final: { status: "queued", allowedTools: [] },
    },
  } as never;

  assert.deepEqual(getPendingMissionGraphWriteToolNames(graph), [
    "code_validate_fast",
    "code_repair_record_cycle",
    "code_validate_targeted",
    "code_validate_full",
    "code_commit_verified",
  ]);
});

test("remembered research context can be suppressed for one mission in plain language", () => {
  assert.equal(
    hasIgnoreRememberedContextIntent(
      "Research checkers, but ignore remembered context for this mission.",
    ),
    true,
  );
  assert.equal(
    hasIgnoreRememberedContextIntent(
      "Use remembered research context and verify it against fresh sources.",
    ),
    false,
  );
});

test("exact graph parallel reads cannot reserve duplicate calls against one ready slot", () => {
  const graph = {
    nodes: {
      current: {
        status: "ready",
        allowedTools: ["code_workspace_read"],
      },
      later: {
        status: "queued",
        allowedTools: ["code_workspace_read"],
      },
    },
  } as never;

  assert.equal(
    countReadyMissionGraphToolSlots(graph, "code_workspace_read"),
    1,
  );
});

test("singleton graph bootstraps dedupe overlapping prerequisites only", () => {
  assert.deepEqual(
    dedupeSingletonMissionGraphPrerequisites([
      "read_current_file",
      "read_current_file",
      "read_template",
      "read_template",
      "web_fetch",
      "web_fetch",
      "replace_current_file",
    ]),
    [
      "read_current_file",
      "read_template",
      "web_fetch",
      "web_fetch",
      "replace_current_file",
    ],
  );
});

test("same-response workspace creates select the exact current graph destination", () => {
  const calls: ModelToolCall[] = [
    {
      name: "code_workspace_create_file",
      arguments: { path: "checkers/game.py", content: "game" },
    },
    {
      name: "code_workspace_create_file",
      arguments: { path: "README.md", content: "readme" },
    },
  ];
  assert.equal(
    findExactGraphBoundToolCallIndex(
      calls,
      0,
      "code_workspace_create_file",
      "README.md",
    ),
    1,
  );
  assert.equal(
    findExactGraphBoundToolCallIndex(
      calls,
      0,
      "code_workspace_create_file",
      "tests/test_checkers.py",
    ),
    -1,
  );
});

test("exact workspace frontier exposes only its authoritative path in tool schema", () => {
  const definitions = [{
    type: "function" as const,
    function: {
      name: "code_workspace_create_file",
      parameters: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["workspaceId", "path", "content"],
      },
    },
  }];
  const graph = {
    nodes: {
      createReadme: {
        status: "ready",
        allowedTools: ["code_workspace_create_file"],
        destination: { selector: "README.md" },
      },
    },
  } as never;
  const bound = bindExactWorkspaceDestinationToolSchemas(definitions, graph);
  assert.deepEqual(
    bound[0]?.function.parameters.properties?.path?.enum,
    ["README.md"],
  );
  assert.deepEqual(
    definitions[0]?.function.parameters.properties?.path,
    { type: "string" },
    "schema binding must not mutate the shared registry definition",
  );
});

test("exact hash-bound correction schema requires complete replacement content", () => {
  const definitions = [{
    type: "function" as const,
    function: {
      name: "code_workspace_write_expected",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  }];
  const graph = {
    nodes: {
      repairGame: {
        status: "ready",
        allowedTools: ["code_workspace_write_expected"],
        destination: { selector: "checkers/game.py" },
      },
    },
  } as never;
  const bound = bindExactWorkspaceDestinationToolSchemas(definitions, graph);
  assert.match(
    String(
      bound[0]?.function.parameters.properties?.content?.description ?? "",
    ),
    /complete replacement content/iu,
  );
  assert.equal(
    (definitions[0]?.function.parameters.properties?.content as {
      description?: string;
    })?.description,
    undefined,
    "schema binding must not mutate the registry content schema",
  );
});

test("red diagnostic switches only its exact correction target to localized patches", () => {
  const definitions = [{
    type: "function" as const,
    function: {
      name: "code_workspace_write_expected",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  }];
  const graph = {
    nodes: {
      repairGame: {
        status: "ready",
        allowedTools: ["code_workspace_write_expected"],
        destination: { selector: "checkers/game.py" },
      },
    },
  } as never;
  const bound = bindExactWorkspaceDestinationToolSchemas(
    definitions,
    graph,
    {
      stdout: "",
      stderr:
        "ImportError: cannot import name 'CheckersGame' from 'checkers.game' (/workspace/checkers/game.py)",
      truncated: false,
      redactedLines: 0,
    },
  );
  assert.equal(
    bound[0]?.function.parameters.properties?.content,
    undefined,
  );
  assert.ok(bound[0]?.function.parameters.properties?.lineReplacements);
  assert.deepEqual(
    bound[0]?.function.parameters.required,
    ["path", "lineReplacements"],
  );
  assert.ok(definitions[0]?.function.parameters.properties.content);
});

test("indent or syntax failures expose a complete content replacement", () => {
  const definitions = [{
    type: "function" as const,
    function: {
      name: "code_workspace_write_expected",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  }];
  const graph = {
    nodes: {
      repairGame: {
        status: "ready",
        allowedTools: ["code_workspace_write_expected"],
        destination: { selector: "checkers/game.py" },
      },
    },
  } as never;
  const diagnostic = {
    stdout: "",
    stderr: [
      '  File "/workspace/checkers/game.py", line 169',
      "    simple.update(set(self._simple_moves(coord, piece)))",
      "IndentationError: unexpected indent",
    ].join("\n"),
    truncated: false,
    redactedLines: 0,
  };
  assert.equal(
    diagnosticRequestsFullFileReplacement(diagnostic, "checkers/game.py"),
    true,
  );
  const bound = bindExactWorkspaceDestinationToolSchemas(
    definitions,
    graph,
    diagnostic,
  );
  assert.ok(bound[0]?.function.parameters.properties?.content);
  assert.equal(
    bound[0]?.function.parameters.properties?.lineReplacements,
    undefined,
  );
  assert.deepEqual(bound[0]?.function.parameters.required, ["path", "content"]);
});

test("unselected or ambiguous validator evidence exposes preservation only", () => {
  const definitions = [{
    type: "function" as const,
    function: {
      name: "code_workspace_write_expected",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  }];
  const graph = {
    nodes: {
      repairReadme: {
        status: "ready",
        allowedTools: ["code_workspace_write_expected"],
        destination: { selector: "README.md" },
      },
      repairBoard: {
        status: "queued",
        allowedTools: ["code_workspace_write_expected"],
        destination: { selector: "src/board.ts" },
      },
      repairGame: {
        status: "queued",
        allowedTools: ["code_workspace_write_expected"],
        destination: { selector: "src/game.ts" },
      },
    },
  } as never;
  const bound = bindExactWorkspaceDestinationToolSchemas(
    definitions,
    graph,
    {
      stdout: "",
      stderr: "AssertionError: protected behavior mismatch",
      truncated: false,
      redactedLines: 0,
    },
  );
  assert.equal(bound[0]?.function.parameters.properties?.content, undefined);
  assert.equal(
    bound[0]?.function.parameters.properties?.lineReplacements,
    undefined,
  );
  assert.deepEqual(
    bound[0]?.function.parameters.properties?.preserveCurrent?.enum,
    [true],
  );
  assert.deepEqual(
    bound[0]?.function.parameters.required,
    ["path", "preserveCurrent"],
  );
});

test("localized correction materializes against the complete SHA-read file", () => {
  const current = [
    "RED = 'r'",
    "BLACK = 'b'",
    "",
    "class CheckersGame:",
    "    def winner(self):",
    "        return None",
    "",
  ].join("\n");
  const next = applyExactWorkspaceCorrectionReplacements(current, [{
    oldText: "    def winner(self):\n        return None",
    newText: "    def winner(self):\n        return BLACK",
    expectedOccurrences: 1,
  }]);
  assert.equal(
    next,
    current.replace("return None", "return BLACK"),
  );
  assert.match(next ?? "", /class CheckersGame/u);
  assert.match(next ?? "", /RED = 'r'/u);
  assert.equal(
    applyExactWorkspaceCorrectionReplacements("same\nsame\n", [{
      oldText: "same",
      newText: "changed",
    }]),
    null,
    "ambiguous text must fail closed instead of patching the first match",
  );
  assert.equal(
    applyExactWorkspaceCorrectionReplacements("same\nsame\n", [{
      oldText: "same",
      newText: "changed",
      expectedOccurrences: 2,
    }]),
    "changed\nchanged\n",
    "an explicit bounded count permits the exact repeated correction",
  );
  assert.equal(
    applyExactWorkspaceCorrectionReplacements("same\nsame\n", [{
      oldText: "same",
      newText: "changed",
      expectedOccurrences: 3,
    }]),
    null,
    "an incorrect declared count must fail closed",
  );
  assert.equal(
    applyExactWorkspaceCorrectionReplacements("same\n", [{
      oldText: "same",
      newText: "changed",
      expectedOccurrences: 13,
    }]),
    null,
    "the declared count remains bounded",
  );
});

test("SHA-bound line-range correction preserves bytes outside non-overlapping ranges", () => {
  const current = [
    "RED = 'r'",
    "",
    "class CheckersGame:",
    "    def legal_moves(self):",
    "        return self._multi_jump_endpoints()",
    "",
    "    def apply_move(self, start, end):",
    "        return None",
    "",
  ].join("\n");
  const next = applyExactWorkspaceLineRangeCorrections(current, [{
    startLine: 4,
    endLine: 5,
    newText: [
      "    def legal_moves(self):",
      "        return self._next_capture_hops()",
    ].join("\n"),
  }]);
  assert.equal(
    next,
    current.replace("self._multi_jump_endpoints()", "self._next_capture_hops()"),
  );
  assert.match(next ?? "", /^RED = 'r'/u);
  assert.match(next ?? "", /def apply_move/u);
  assert.equal(
    applyExactWorkspaceLineRangeCorrections(current, [{
      startLine: 4,
      endLine: 6,
      newText: "    def legal_moves(self):\n        return []",
    }, {
      startLine: 6,
      endLine: 7,
      newText: "    def apply_move(self, start, end):\n        return None",
    }]),
    null,
    "overlapping ranges must fail closed",
  );
  assert.equal(
    applyExactWorkspaceLineRangeCorrections(current, [{
      startLine: 0,
      endLine: 1,
      newText: "unsafe",
    }]),
    null,
    "out-of-bounds ranges must fail closed",
  );
  assert.equal(
    applyExactWorkspaceLineRangeCorrections(current, [{
      startLine: 1.5,
      endLine: 2,
      newText: "unsafe",
    }]),
    null,
    "fractional line numbers must fail closed",
  );
  assert.equal(
    applyExactWorkspaceLineRangeCorrections(current, [{
      startLine: 1,
      endLine: 1,
      newText: "RED = 'r'",
    }]),
    null,
    "a byte-identical selected correction must not masquerade as progress",
  );
  const crlf = "alpha\r\nbeta\r\ngamma\r\n";
  assert.equal(
    applyExactWorkspaceLineRangeCorrections(crlf, [{
      startLine: 2,
      endLine: 2,
      newText: "BETA",
    }]),
    "alpha\r\nBETA\r\ngamma\r\n",
    "line-range edits preserve CRLF and the trailing EOF newline",
  );
});

test("hash-bound corrections classify only whole-payload omitted-content stubs", () => {
  for (const value of [
    "",
    "placeholder",
    "# TODO",
    "/* implementation omitted */",
    "```python\npass\n```",
    "same as above",
    undefined,
  ]) {
    assert.equal(
      isIncompleteWorkspaceReplacementContent(value),
      true,
      `expected incomplete replacement: ${String(value)}`,
    );
  }
  for (const value of [
    "placeholder = None\n",
    "def main():\n    pass\n",
    "# TODO: add animation\nexport function play() { return true; }\n",
    "Complete source content.",
  ]) {
    assert.equal(
      isIncompleteWorkspaceReplacementContent(value),
      false,
      `expected complete replacement: ${value}`,
    );
  }
});

test("omitted-content repair shorthand becomes only a verified byte-identical no-op", () => {
  const observation = {
    workspaceId: "verified-workspace",
    path: "checkers/__init__.py",
    sha256: `sha256:${"a".repeat(64)}`,
    content: "from .game import CheckersGame\n",
  };
  const bound = bindIncompleteWorkspaceReplacementToVerifiedNoop(
    {
      name: "code_workspace_write_expected",
      arguments: {
        workspaceId: "model-workspace",
        path: "checkers/__init__.py",
        content: "placeholder",
        replacements: [{
          oldText: "not present",
          newText: "unsafe",
        }],
        expectedSha256: `sha256:${"b".repeat(64)}`,
      },
    },
    observation,
  );
  assert.deepEqual(bound.arguments, {
    workspaceId: observation.workspaceId,
    path: observation.path,
    content: observation.content,
    expectedSha256: observation.sha256,
  });
});

test("graph-bound workspace creation keeps content but replaces workspace transcription", () => {
  const bound = bindVerifiedWorkspaceCreateFile(
    {
      name: "code_workspace_create_file",
      arguments: {
        workspaceId: "model-transcribed",
        path: "README.md",
        content: "# Checkers",
      },
    },
    "README.md",
    [{
      toolName: "code_workspace_create",
      operation: "create",
      message: "Created durable workspace.",
      commitKind: "committed",
      readback: {
        status: "verified",
        checkedAt: "2026-07-19T17:30:00.000Z",
      },
      resource: {
        system: "workspace",
        resourceType: "code_workspace",
        id: "verified-workspace",
        path: "verified-workspace",
        workspaceId: "verified-workspace",
      },
    }],
  );
  assert.deepEqual(bound?.arguments, {
    workspaceId: "verified-workspace",
    path: "README.md",
    content: "# Checkers",
  });
});

test("prompt-scoped workspace creation preserves the model file choice but replaces its stale workspace alias", () => {
  const durableReceipt: AgentRunReceipt = {
    toolName: "code_workspace_create",
    operation: "create",
    message: "Created durable workspace.",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-28T15:11:31.000Z",
    },
    resource: {
      system: "workspace",
      resourceType: "code_workspace",
      id: "byok-autonomous-python-31090d88debd:byok-autonomous-python-31090d88debd",
      path: "byok-autonomous-python-31090d88debd",
      workspaceId: "byok-autonomous-python-31090d88debd",
    },
  };
  const bound = bindVerifiedWorkspaceCreateFile(
    {
      name: "code_workspace_create_file",
      arguments: {
        workspaceId: "byok-autonomous-python-ws",
        path: "crdt_sync.py",
        content: "# implementation chosen from the signed issue\n",
      },
    },
    "prompt-scoped-workspace-target",
    [durableReceipt],
  );
  assert.deepEqual(bound?.arguments, {
    workspaceId: "byok-autonomous-python-31090d88debd",
    path: "crdt_sync.py",
    content: "# implementation chosen from the signed issue\n",
  });
});

test("verified durable workspace identity is pinned across a multi-tool frontier without mutating registry schemas", () => {
  const durableReceipt: AgentRunReceipt = {
    toolName: "code_workspace_create",
    operation: "create",
    message: "Created durable workspace.",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-28T15:11:31.000Z",
    },
    resource: {
      system: "workspace",
      resourceType: "code_workspace",
      id: "verified-workspace:verified-workspace",
      path: "verified-workspace",
      workspaceId: "verified-workspace",
    },
  };
  const definitions = [
    "code_workspace_create_file",
    "code_workspace_mkdir",
    "code_workspace_read",
    "code_workspace_write_expected",
    "code_validate_fast",
    "linear_get_issue",
    "code_workspace_create",
  ].map((name) => ({
    type: "function" as const,
    function: {
      name,
      parameters: {
        type: "object" as const,
        properties: {
          workspaceId: { type: "string" as const },
          path: { type: "string" as const },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  }));
  const original = structuredClone(definitions);
  const bound = bindVerifiedWorkspaceIdentityToolSchemas(
    definitions,
    [durableReceipt],
  );
  for (const definition of bound) {
    const workspaceIdentity =
      definition.function.parameters.properties?.workspaceId;
    if (
      definition.function.name === "linear_get_issue" ||
      definition.function.name === "code_workspace_create"
    ) {
      assert.equal(workspaceIdentity?.enum, undefined);
      assert.equal(
        definition.function.parameters.required?.includes("workspaceId"),
        false,
      );
      continue;
    }
    assert.deepEqual(workspaceIdentity?.enum, ["verified-workspace"]);
    assert.equal(
      definition.function.parameters.required?.includes("workspaceId"),
      true,
    );
  }
  assert.deepEqual(
    definitions,
    original,
    "schema projection must not mutate shared registry definitions",
  );

  const rebound = bindVerifiedWorkspaceIdentityToolCall(
    {
      name: "code_workspace_mkdir",
      arguments: {
        workspaceId: "model-stale-alias",
        path: "src",
      },
    },
    [durableReceipt],
  );
  assert.deepEqual(rebound?.arguments, {
    workspaceId: "verified-workspace",
    path: "src",
  });
});

test("downstream workspace identity binding fails closed on missing or ambiguous verified creation receipts", () => {
  const call: ModelToolCall = {
    name: "code_workspace_create_file",
    arguments: {
      workspaceId: "model-stale-alias",
      path: "crdt_sync.py",
      content: "pass\n",
    },
  };
  assert.equal(bindVerifiedWorkspaceIdentityToolCall(call, []), null);
  assert.equal(
    bindVerifiedWorkspaceCreateFile(
      call,
      "prompt-scoped-workspace-target",
      [],
    ),
    null,
  );
  const receiptFor = (workspaceId: string): AgentRunReceipt => ({
    toolName: "code_workspace_create",
    operation: "create",
    message: `Created ${workspaceId}.`,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-28T15:11:31.000Z",
    },
    resource: {
      system: "workspace",
      resourceType: "code_workspace",
      id: `${workspaceId}:${workspaceId}`,
      path: workspaceId,
      workspaceId,
    },
  });
  const ambiguous = [receiptFor("workspace-a"), receiptFor("workspace-b")];
  assert.equal(bindVerifiedWorkspaceIdentityToolCall(call, ambiguous), null);
  assert.equal(
    bindVerifiedWorkspaceCreateFile(
      call,
      "prompt-scoped-workspace-target",
      ambiguous,
    ),
    null,
  );
});

test("lifecycle validate/repair/commit rebind prompt workspaceId to durable create receipt", () => {
  const durableReceipt: AgentRunReceipt = {
    toolName: "code_workspace_create",
    operation: "create",
    message: "Created durable workspace.",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-23T09:05:27.467Z",
    },
    resource: {
      system: "workspace",
      resourceType: "code_workspace",
      id: "run-2026-07-23t09-05-27.467z-f700e841eec0",
      path: "run-2026-07-23t09-05-27.467z-f700e841eec0",
      workspaceId: "run-2026-07-23t09-05-27.467z-f700e841eec0",
    },
  };
  const promptWorkspaceId = "flow-real-fcf9c989c265";

  for (const name of [
    "code_validate_fast",
    "code_validate_targeted",
    "code_validate_full",
    "code_repair_record_cycle",
    "code_repair_status",
    "code_commit_verified",
  ] as const) {
    const bound = bindVerifiedWorkspaceLifecycleTool(
      {
        name,
        arguments: {
          workspaceId: promptWorkspaceId,
          requestId: "repair-1",
          repairRequestId: "model-selected-repair",
          profileKey: "repo-profile",
        },
      },
      [durableReceipt],
      "run-root-1",
    );
    assert.deepEqual(bound?.arguments, {
      workspaceId: "run-2026-07-23t09-05-27.467z-f700e841eec0",
      profileKey: "repo-profile",
      ...(name.startsWith("code_validate_")
        ? { repairRequestId: "repair-run-root-1" }
        : { requestId: "repair-run-root-1" }),
    });
  }

  assert.equal(
    bindVerifiedWorkspaceLifecycleTool(
      {
        name: "code_workspace_create_file",
        arguments: { workspaceId: promptWorkspaceId, path: "README.md" },
      },
      [durableReceipt],
      "run-root-1",
    ),
    null,
  );
  assert.equal(
    bindVerifiedWorkspaceLifecycleTool(
      {
        name: "code_validate_fast",
        arguments: { workspaceId: promptWorkspaceId },
      },
      [],
      "run-root-1",
    ),
    null,
  );
});

test("receipt-backed final projection closes only a proof-complete final node", () => {
  const graph = {
    nodes: {
      publish: {
        status: "complete",
        dependencyIds: [],
        allowedTools: ["publish_research_to_linear"],
        completionContract: { requiredEvidenceKinds: ["external-action"] },
      },
      final: {
        status: "ready",
        dependencyIds: ["publish"],
        allowedTools: [],
        completionContract: {
          requiredEvidenceKinds: ["final-output", "final-relevance"],
        },
      },
    },
  };
  const onlyFinalOutput = {
    status: "needs_more_work",
    confidence: 1,
    missing: ["plan:final_output", "verifier:final_relevance"],
    reasons: ["durable work is complete"],
  } as MissionAcceptanceResult;

  assert.equal(
    isReceiptBackedFinalProjectionReady({
      acceptance: onlyFinalOutput,
      graph: graph as never,
      frontierToolNames: [],
      hasCompletedAcceptedResearchPublicationProof: true,
    }),
    true,
  );
  assert.equal(
    isReceiptBackedFinalProjectionReady({
      acceptance: {
        ...onlyFinalOutput,
        missing: ["web_evidence", ...onlyFinalOutput.missing],
      },
      graph: graph as never,
      frontierToolNames: [],
      hasCompletedAcceptedResearchPublicationProof: true,
    }),
    false,
    "research or action proof debt must never be waived",
  );
  assert.equal(
    isReceiptBackedFinalProjectionReady({
      acceptance: onlyFinalOutput,
      graph: graph as never,
      frontierToolNames: [],
      hasCompletedAcceptedResearchPublicationProof: false,
    }),
    false,
    "a model-only turn cannot manufacture receipt-backed completion",
  );
  assert.equal(
    isReceiptBackedFinalProjectionReady({
      acceptance: onlyFinalOutput,
      graph: {
        nodes: {
          ...graph.nodes,
          publish: { ...graph.nodes.publish, status: "ready" },
        },
      } as never,
      frontierToolNames: [],
      hasCompletedAcceptedResearchPublicationProof: true,
    }),
    false,
    "the final node cannot close before every exact dependency",
  );
  assert.equal(
    isReceiptBackedFinalProjectionReady({
      acceptance: onlyFinalOutput,
      graph: graph as never,
      frontierToolNames: ["web_fetch"],
      hasCompletedAcceptedResearchPublicationProof: true,
    }),
    false,
    "a callable frontier must remain model-directed",
  );
});

test("read-only workspace observations rebind stale workspaceId to durable create receipt", () => {
  const durableReceipt: AgentRunReceipt = {
    toolName: "code_workspace_create",
    operation: "create",
    message: "Created durable workspace.",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-28T05:24:41.767Z",
    },
    resource: {
      system: "workspace",
      resourceType: "code_workspace",
      id: "run-verified-workspace",
      path: "run-verified-workspace",
      workspaceId: "run-verified-workspace",
    },
  };

  const bound = bindVerifiedWorkspaceObservationTool(
    {
      name: "code_workspace_search",
      arguments: {
        workspaceId: "run-stale-workspace",
        query: "class CRDTSync",
        path: "src",
        limit: 20,
      },
    },
    [durableReceipt],
  );
  assert.deepEqual(bound?.arguments, {
    workspaceId: "run-verified-workspace",
    query: "class CRDTSync",
    path: "src",
    limit: 20,
  });
  assert.equal(
    bindVerifiedWorkspaceObservationTool(
      {
        name: "code_workspace_create_file",
        arguments: {
          workspaceId: "run-stale-workspace",
          path: "src/new.py",
        },
      },
      [durableReceipt],
    ),
    null,
    "mutation tools do not gain authority through an observation binding",
  );
  assert.equal(
    bindVerifiedWorkspaceObservationTool(
      {
        name: "code_workspace_search",
        arguments: { workspaceId: "run-stale-workspace", query: "CRDT" },
      },
      [],
    ),
    null,
    "an absent durable workspace receipt fails closed",
  );
});

test("exact code validation fallback is bounded to one ready validator and one durable run scope", () => {
  assert.deepEqual(
    buildExactCodeValidationFallbackToolCall(
      ["code_validate_fast"],
      "run-2026-07-25T07:23:48.793Z-05a3723046f5",
    ),
    {
      name: "code_validate_fast",
      arguments: {
        repairRequestId:
          "repair-run-2026-07-25t07-23-48.793z-05a3723046f5",
        expectedArtifacts: [],
        environment: {},
      },
    },
  );
  assert.equal(
    buildExactCodeValidationFallbackToolCall(
      ["code_validate_fast", "code_validate_targeted"],
      "run-1",
    ),
    null,
  );
  assert.equal(
    buildExactCodeValidationFallbackToolCall(
      ["code_workspace_export_directory"],
      "run-1",
    ),
    null,
  );
});

test("known-folder export binds the verified workspace root and run-scoped Desktop destination", () => {
  const durableReceipt: AgentRunReceipt = {
    toolName: "code_workspace_create",
    operation: "create",
    message: "Created durable workspace.",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-25T07:37:49.925Z",
    },
    resource: {
      system: "workspace",
      resourceType: "code_workspace",
      id: "verified-workspace",
      path: "verified-workspace",
      workspaceId: "verified-workspace",
    },
  };

  const bound = bindVerifiedWorkspaceDirectoryExport(
    {
      name: "code_workspace_export_directory",
      arguments: {
        workspaceId: "model-workspace",
        sourcePath: "main.py",
        destinationRoot: "downloads",
        destinationPath: "guessing.py",
      },
    },
    "Write a number guessing game in Python on my Desktop.",
    "run-2026-07-25T07-37-49.925Z-beaccbf21521",
    [durableReceipt],
  );
  assert.deepEqual(bound?.arguments, {
    workspaceId: "verified-workspace",
    sourcePath: "",
    destinationRoot: "desktop",
    destinationPath: "number-guessing-game-beaccbf21521",
  });
  const organizer = bindVerifiedWorkspaceDirectoryExport(
    {
      name: "code_workspace_export_directory",
      arguments: {},
    },
    "Write a text file organizer in Python on my Desktop.",
    "run-2026-07-30T11-28-40.572Z-724046e1d674",
    [durableReceipt],
  );
  assert.equal(
    organizer?.arguments.destinationPath,
    "text-file-organizer-724046e1d674",
  );
  assert.equal(
    bindVerifiedWorkspaceDirectoryExport(
      {
        name: "code_workspace_export_directory",
        arguments: {},
      },
      "Export this to Desktop and Downloads.",
      "run-1",
      [durableReceipt],
    ),
    null,
  );
});

test("verified host export final answer replaces model path claims with receipt truth", () => {
  const exportPath =
    "C:\\Users\\example\\OneDrive\\Desktop\\number-guessing-game-beaccbf21521";
  const receipts: AgentRunReceipt[] = [
    {
      toolName: "code_workspace_create_file",
      operation: "create",
      message: "Created main.py.",
      commitKind: "committed",
      readback: {
        status: "verified",
        checkedAt: "2026-07-25T07:37:49.925Z",
      },
      resource: {
        system: "workspace",
        resourceType: "code_workspace",
        id: "workspace-1:main.py",
        path: "main.py",
        workspaceId: "workspace-1",
      },
    },
    {
      toolName: "code_workspace_export_directory",
      operation: "create",
      message: `Exported to ${exportPath}.`,
      commitKind: "committed",
      readback: {
        status: "verified",
        checkedAt: "2026-07-25T07:38:49.925Z",
      },
      resource: {
        system: "workspace",
        resourceType: "host_directory",
        id: "host-directory:desktop:number-guessing-game",
        path: "desktop/number-guessing-game",
        workspaceId: "workspace-1",
      },
      output: {
        status: "ok",
        destinationPath: exportPath,
      },
    },
  ];

  const finalAnswer = buildVerifiedHostExportFinalAnswer(
    "write a number guessing game in Python on my desktop",
    receipts,
    [
      "code_validate_fast",
      "code_validate_targeted",
      "code_validate_full",
    ],
  );
  // The title is derived from the request now, so every deliverable is named
  // rather than only the one prompt this assertion used to hardcode.
  assert.match(finalAnswer ?? "", /number guessing game delivered/u);
  assert.equal(finalAnswer?.includes(exportPath), true);
  assert.match(finalAnswer ?? "", /Entry point: `main\.py`/u);
  assert.match(finalAnswer ?? "", /fast, targeted, full/u);
  assert.doesNotMatch(finalAnswer ?? "", /Projects[\\/]number_guessing_game/u);
  assert.equal(
    buildVerifiedHostExportFinalAnswer(
      "Continue the existing mission.",
      receipts,
      ["code_validate_fast"],
    )?.includes(exportPath),
    true,
    "the verified export receipt must remain authoritative on a continuation segment",
  );
});

test("verified host export skips a redundant streaming final projection", () => {
  assert.equal(
    shouldRequestStreamingFinalProjection({
      enableStreaming: true,
      hasDirectFinalContent: false,
      verifiedHostExportFinalAnswer:
        "Text file organizer delivered to C:\\Users\\example\\Desktop\\organizer.",
    }),
    false,
  );
  assert.equal(
    shouldRequestStreamingFinalProjection({
      enableStreaming: true,
      hasDirectFinalContent: false,
      verifiedHostExportFinalAnswer: null,
    }),
    true,
  );
  assert.equal(
    shouldRequestStreamingFinalProjection({
      enableStreaming: true,
      hasDirectFinalContent: true,
      verifiedHostExportFinalAnswer: null,
    }),
    false,
  );
});

test("verified host export finalizes immediately only after all proof debt is paid", () => {
  const ready = {
    verifiedHostExportFinalAnswer:
      "## Done — text file organizer delivered\n\nLocation: `C:\\Users\\example\\Desktop\\text-file-organizer`",
    acceptanceStatus: "pass" as const,
    onlyFinalProjectionProofMissing: false,
    pendingRequiredWriteCount: 0,
    missingRequiredWebToolCount: 0,
    hasPendingOperationGoals: false,
    pendingStreamingWriteback: false,
    setLooseDeliveryStillUnpaid: false,
  };

  assert.equal(shouldFinalizeVerifiedHostExportAfterToolUse(ready), true);
  assert.equal(
    shouldFinalizeVerifiedHostExportAfterToolUse({
      ...ready,
      verifiedHostExportFinalAnswer: null,
    }),
    false,
  );
  assert.equal(
    shouldFinalizeVerifiedHostExportAfterToolUse({
      ...ready,
      acceptanceStatus: "needs_more_work",
    }),
    false,
  );
  assert.equal(
    shouldFinalizeVerifiedHostExportAfterToolUse({
      ...ready,
      acceptanceStatus: "needs_more_work",
      onlyFinalProjectionProofMissing: true,
    }),
    true,
  );
  assert.equal(
    shouldFinalizeVerifiedHostExportAfterToolUse({
      ...ready,
      pendingRequiredWriteCount: 1,
    }),
    false,
  );
  assert.equal(
    shouldFinalizeVerifiedHostExportAfterToolUse({
      ...ready,
      hasPendingOperationGoals: true,
      onlyFinalProjectionProofMissing: true,
    }),
    false,
  );
  assert.equal(
    shouldFinalizeVerifiedHostExportAfterToolUse({
      ...ready,
      setLooseDeliveryStillUnpaid: true,
      onlyFinalProjectionProofMissing: true,
    }),
    false,
  );
});

test("verified host export recognizes only terminal projection debt", () => {
  assert.equal(
    missionAcceptanceHasOnlyFinalProjectionDebt({
      missing: ["plan:final:final_relevance", "final_output"],
    }),
    true,
  );
  assert.equal(
    missionAcceptanceHasOnlyFinalProjectionDebt({
      missing: ["plan:final:final_relevance", "receipt:write_receipt"],
    }),
    false,
  );
  assert.equal(
    missionAcceptanceHasOnlyFinalProjectionDebt({ missing: [] }),
    false,
  );
});

test("verified host export rechecks readiness after active-task acceptance advances", () => {
  const beforeActiveTaskAcceptance = {
    verifiedHostExportFinalAnswer:
      "## Done — text file organizer delivered\n\nLocation: `C:\\Users\\example\\Desktop\\text-file-organizer`",
    acceptanceStatus: "needs_more_work" as const,
    onlyFinalProjectionProofMissing: false,
    pendingRequiredWriteCount: 0,
    missingRequiredWebToolCount: 0,
    hasPendingOperationGoals: false,
    pendingStreamingWriteback: false,
    setLooseDeliveryStillUnpaid: false,
  };
  assert.equal(
    shouldFinalizeVerifiedHostExportAfterToolUse(beforeActiveTaskAcceptance),
    false,
    "the lifecycle node must be verified first",
  );
  assert.equal(
    shouldFinalizeVerifiedHostExportAfterToolUse({
      ...beforeActiveTaskAcceptance,
      onlyFinalProjectionProofMissing: true,
    }),
    true,
    "the receipt-backed answer may then pay only the final projection debt",
  );
  assert.equal(
    shouldFinalizeVerifiedHostExportAfterToolUse({
      ...beforeActiveTaskAcceptance,
      onlyFinalProjectionProofMissing: true,
      missingRequiredWebToolCount: 1,
    }),
    false,
    "active-task verification must not waive unrelated proof debt",
  );
});

test("terminal success never waits on an auto-continuation grant lookup", () => {
  assert.equal(shouldInspectAutoContinuationGrant("final", false), false);
  assert.equal(
    shouldInspectAutoContinuationGrant("write_completed", false),
    false,
  );
  assert.equal(shouldInspectAutoContinuationGrant("error", false), false);
  assert.equal(shouldInspectAutoContinuationGrant("user_stopped", false), false);
  assert.equal(shouldInspectAutoContinuationGrant("budget", false), true);
  assert.equal(shouldInspectAutoContinuationGrant("budget", true), false);
});

test("advisory tool outcome memory cannot retain terminal UI ownership", async () => {
  const startedAt = Date.now();

  const result = await settleToolOutcomeMemoryPersistence(
    new Promise<void>(() => undefined),
    20,
  );

  assert.equal(result, "timed_out");
  assert.ok(
    Date.now() - startedAt < 1_000,
    "a stalled advisory memory write must release mission completion",
  );
});

test("terminal runtime snapshot cannot retain completion ownership indefinitely", async () => {
  const startedAt = Date.now();
  assert.equal(
    await settleTerminalRuntimeSnapshotPersistence(
      new Promise<boolean>(() => undefined),
      20,
    ),
    "timed_out",
  );
  assert.ok(
    Date.now() - startedAt < 1_000,
    "a stalled duplicate runtime snapshot must release mission completion",
  );
  assert.equal(
    await settleTerminalRuntimeSnapshotPersistence(Promise.resolve(true)),
    "persisted",
  );
  assert.equal(
    await settleTerminalRuntimeSnapshotPersistence(Promise.resolve(false)),
    "not_available",
  );
});

test("code_workspace_create missing kind/profile rebinds when mission names one registry key", () => {
  const prompt = [
    "Use the trusted local repository profile key compound-flow-real-ts:",
    "call code_sandbox_status, then code_workspace_create",
    "(kind repository, repositoryProfileKey compound-flow-real-ts, workspaceId flow-real-abc).",
  ].join(" ");
  const trusted = ["compound-flow-real-ts", "other-profile"];

  assert.equal(
    resolveSingleNamedTrustedRepositoryProfileKey(prompt, trusted),
    "compound-flow-real-ts",
  );

  const bound = bindTrustedRepositoryWorkspaceCreate(
    {
      name: "code_workspace_create",
      arguments: {
        workspaceId: "flow-real-abc",
      },
    },
    prompt,
    trusted,
  );
  assert.deepEqual(bound?.arguments, {
    workspaceId: "flow-real-abc",
    kind: "repository",
    repositoryProfileKey: "compound-flow-real-ts",
  });

  const boundWithoutWorkspaceId = bindTrustedRepositoryWorkspaceCreate(
    {
      name: "code_workspace_create",
      arguments: {},
    },
    prompt,
    trusted,
  );
  assert.deepEqual(boundWithoutWorkspaceId?.arguments, {
    kind: "repository",
    repositoryProfileKey: "compound-flow-real-ts",
  });

  assert.equal(
    bindTrustedRepositoryWorkspaceCreate(
      {
        name: "code_workspace_create",
        arguments: { workspaceId: "flow-real-abc" },
      },
      prompt,
      ["other-profile"],
    ),
    null,
  );

  const multiPrompt =
    `${prompt} Also mention other-profile for comparison.`;
  assert.equal(
    resolveSingleNamedTrustedRepositoryProfileKey(multiPrompt, trusted),
    null,
  );
  assert.equal(
    bindTrustedRepositoryWorkspaceCreate(
      {
        name: "code_workspace_create",
        arguments: { kind: "scratch" },
      },
      multiPrompt,
      trusted,
    ),
    null,
  );

  assert.equal(
    bindTrustedRepositoryWorkspaceCreate(
      {
        name: "code_workspace_read",
        arguments: { workspaceId: "flow-real-abc", path: "src/flow_real.ts" },
      },
      prompt,
      trusted,
    ),
    null,
  );
});

test("graph-bound workspace creation fails closed on path mismatch with foreign content", () => {
  const bound = bindVerifiedWorkspaceCreateFile(
    {
      name: "code_workspace_create_file",
      arguments: {
        workspaceId: "model-transcribed",
        path: "checkers/__init__.py",
        content: "from .game import CheckersGame\n",
      },
    },
    "README.md",
    [{
      toolName: "code_workspace_create",
      operation: "create",
      message: "Created durable workspace.",
      commitKind: "committed",
      readback: {
        status: "verified",
        checkedAt: "2026-07-19T19:45:00.000Z",
      },
      resource: {
        system: "workspace",
        resourceType: "code_workspace",
        id: "verified-workspace",
        path: "verified-workspace",
        workspaceId: "verified-workspace",
      },
    }],
  );
  assert.equal(bound, null);
});

test("graph-bound workspace creation may rebind empty or placeholder content onto the ready path", () => {
  assert.equal(isWorkspaceCreateFilePlaceholderContent(""), true);
  assert.equal(isWorkspaceCreateFilePlaceholderContent("# placeholder"), true);
  assert.equal(
    isWorkspaceCreateFilePlaceholderContent("from .game import CheckersGame\n"),
    false,
  );
  const bound = bindVerifiedWorkspaceCreateFile(
    {
      name: "code_workspace_create_file",
      arguments: {
        workspaceId: "model-transcribed",
        path: "checkers/__init__.py",
        content: "# placeholder",
      },
    },
    "README.md",
    [{
      toolName: "code_workspace_create",
      operation: "create",
      message: "Created durable workspace.",
      commitKind: "committed",
      readback: {
        status: "verified",
        checkedAt: "2026-07-19T19:45:00.000Z",
      },
      resource: {
        system: "workspace",
        resourceType: "code_workspace",
        id: "verified-workspace",
        path: "verified-workspace",
        workspaceId: "verified-workspace",
      },
    }],
  );
  assert.deepEqual(bound?.arguments, {
    workspaceId: "verified-workspace",
    path: "README.md",
    content: "# placeholder",
  });
});

test("off-frontier rejection names ready tools and near-miss code ladder hints", () => {
  assert.match(
    String(describeOffFrontierToolNearMiss("verify_all")),
    /code_validate_fast/u,
  );
  assert.match(
    String(describeOffFrontierToolNearMiss("patch")),
    /code_workspace_patch/u,
  );
  assert.match(
    String(
      describeOffFrontierToolNearMiss("patch", [
        "code_workspace_write_expected",
      ]),
    ),
    /code_workspace_write_expected/u,
  );
  assert.doesNotMatch(
    String(
      describeOffFrontierToolNearMiss("patch", [
        "code_workspace_write_expected",
      ]),
    ),
    /code_workspace_patch/u,
  );
  assert.match(
    String(describeOffFrontierToolNearMiss("read_file")),
    /code_workspace_read/u,
  );
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "verify_all",
    readyFrontierToolNames: ["code_sandbox_status"],
  });
  assert.match(message, /Tool is not available for this prompt: verify_all/u);
  assert.match(message, /Ready frontier tool\(s\) now: code_sandbox_status/u);
  assert.match(message, /code_validate_fast/u);
  const writeExpectedMessage = buildOffFrontierToolRejectionMessage({
    toolName: "patch",
    readyFrontierToolNames: ["code_workspace_write_expected"],
  });
  assert.match(writeExpectedMessage, /code_workspace_write_expected/u);
  assert.doesNotMatch(writeExpectedMessage, /code_workspace_patch/u);
  assert.match(
    String(
      describeOffFrontierToolNearMiss("code_workspace_write_expected", [
        "code_repair_record_cycle",
      ]),
    ),
    /code_repair_record_cycle/u,
  );
});

test("hash-bound workspace corrections require fresh per-target provider turns", () => {
  assert.equal(
    shouldDeferAdditionalWorkspaceCorrection(
      "code_workspace_write_expected",
      false,
    ),
    false,
  );
  assert.equal(
    shouldDeferAdditionalWorkspaceCorrection(
      "code_workspace_write_expected",
      true,
    ),
    true,
  );
  assert.equal(
    shouldDeferAdditionalWorkspaceCorrection("code_workspace_read", true),
    false,
  );
});

test("composite lifecycle frontier exposes only its durable current action and selector", () => {
  const lifecycleNode = {
    id: "lifecycle-code_execution",
    status: "ready",
    allowedTools: [
      "code_workspace_read",
      "code_workspace_write_expected",
    ],
    inputs: {
      lifecycle: {
        kind: "literal",
        value: {
          version: 1,
          composite: true,
          intentFingerprint: `sha256:${"a".repeat(64)}`,
          stage: "code_execution",
          actions: [
            {
              id: "action-001-code_workspace_read",
              toolName: "code_workspace_read",
              effect: "read",
              bindingId: "binding-workspace",
              selector: "README.md",
              objective: "Read the exact workspace file.",
              minimumEvidence: 1,
              requiredEvidenceKinds: ["tool-result"],
              minimumReceipts: 0,
              requiredReceiptKinds: [],
            },
            {
              id: "action-002-code_workspace_read",
              toolName: "code_workspace_read",
              effect: "read",
              bindingId: "binding-workspace",
              selector: "scripts/verify_project.py",
              objective: "Read the protected contract.",
              minimumEvidence: 1,
              requiredEvidenceKinds: ["tool-result"],
              minimumReceipts: 0,
              requiredReceiptKinds: [],
            },
            {
              id: "action-003-code_workspace_write_expected",
              toolName: "code_workspace_write_expected",
              effect: "mutation",
              bindingId: "binding-workspace",
              selector: "README.md",
              objective: "Write the exact observed workspace file.",
              minimumEvidence: 1,
              requiredEvidenceKinds: ["tool-result"],
              minimumReceipts: 1,
              requiredReceiptKinds: ["action-receipt"],
            },
          ],
        },
      },
    },
    outputs: {
      lifecycleActionCursor: 2,
      lifecycleCompletedActionIds: [
        "action-001-code_workspace_read",
        "action-002-code_workspace_read",
      ],
      lifecycleActionAttemptCounts: {
        "action-001-code_workspace_read": 1,
        "action-002-code_workspace_read": 1,
      },
    },
  } as any;
  const graph = { nodes: { code: lifecycleNode } } as any;
  const definitions = [
    "code_workspace_read",
    "code_workspace_write_expected",
  ].map((name) => ({
    type: "function" as const,
    function: {
      name,
      parameters: { type: "object" as const, properties: {} },
    },
  }));
  const frontier = constrainToolsToMissionGraphFrontier(definitions, graph);
  assert.deepEqual(frontier.map((tool) => tool.function.name), [
    "code_workspace_write_expected",
  ]);
  assert.equal(
    getMissionGraphFrontierDestinationSelector(graph, frontier),
    "README.md",
  );
  assert.deepEqual(getPendingMissionGraphWriteToolNames(graph), [
    "code_workspace_write_expected",
  ]);
  assert.equal(countOutstandingMissionGraphToolActions([lifecycleNode]), 1);
  assert.equal(
    countOutstandingMissionGraphToolActions([{
      ...lifecycleNode,
      outputs: {
        lifecycleActionCursor: 0,
        lifecycleCompletedActionIds: [],
        lifecycleActionAttemptCounts: {},
      },
    }]),
    3,
  );

  const conventionalNode = {
    id: "conventional-read",
    status: "queued",
    allowedTools: ["code_workspace_read"],
    inputs: {},
    outputs: {},
  } as any;
  assert.equal(
    countOutstandingMissionGraphToolActions([lifecycleNode, conventionalNode]),
    2,
  );
  assert.equal(
    reconcileOutstandingMissionGraphToolStepBudget({
      hardCap: 2,
      finalizationReserve: 1,
      toolStepBudget: 0,
      nodes: [{ ...lifecycleNode, outputs: {} }],
    }),
    1,
  );
  assert.equal(
    reconcileOutstandingMissionGraphToolStepBudget({
      hardCap: 80,
      finalizationReserve: 4,
      toolStepBudget: 5,
      nodes: Array.from({ length: 38 }, (_unused, index) => ({
        ...conventionalNode,
        id: `bounded-repair-${index}`,
      })),
    }),
    54,
  );

  const receipt: AgentRunReceipt = {
    toolName: "code_workspace_create",
    operation: "create",
    message: "Created durable workspace.",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-18T23:30:00.000Z",
    },
    resource: {
      system: "workspace",
      resourceType: "code_workspace",
      id: "du06-workspace",
      path: "du06-workspace",
      workspaceId: "du06-workspace",
    },
  };
  assert.deepEqual(
    getVerifiedWorkspaceReadRefreshBinding(
      graph,
      frontier,
      [receipt],
      "README.md",
    ),
    { workspaceId: "du06-workspace", path: "README.md" },
  );
  assert.deepEqual(
    getVerifiedWorkspaceSupportingReadRefreshBindings(
      graph,
      frontier,
      [receipt],
      "README.md",
    ),
    [{
      workspaceId: "du06-workspace",
      path: "scripts/verify_project.py",
    }],
  );
});

test("composite execution maps proof to the current action instead of the stage aggregate", () => {
  const node = {
    id: "lifecycle-code_execution",
    status: "running",
    allowedTools: ["code_sandbox_status", "code_workspace_create"],
    inputs: {
      lifecycle: {
        kind: "literal",
        value: {
          version: 1,
          composite: true,
          intentFingerprint: `sha256:${"a".repeat(64)}`,
          stage: "code_execution",
          actions: [
            {
              id: "action-001-code_sandbox_status",
              toolName: "code_sandbox_status",
              effect: "read",
              bindingId: null,
              selector: null,
              objective: "Verify the sandbox boundary.",
              minimumEvidence: 1,
              requiredEvidenceKinds: ["sandbox-attestation"],
              minimumReceipts: 0,
              requiredReceiptKinds: [],
            },
            {
              id: "action-002-code_workspace_create",
              toolName: "code_workspace_create",
              effect: "mutation",
              bindingId: "binding-workspace",
              selector: "du06-workspace",
              objective: "Create the trusted repository workspace.",
              minimumEvidence: 1,
              requiredEvidenceKinds: ["tool-result"],
              minimumReceipts: 1,
              requiredReceiptKinds: ["code_change"],
            },
          ],
        },
      },
    },
    outputs: {
      lifecycleActionCursor: 1,
      lifecycleCompletedActionIds: ["action-001-code_sandbox_status"],
      lifecycleActionAttemptCounts: {
        "action-001-code_sandbox_status": 1,
      },
    },
    completionContract: {
      criteria: ["Complete the whole code stage."],
      minimumEvidence: 2,
      requiredEvidenceKinds: ["sandbox-attestation", "tool-result"],
      minimumReceipts: 1,
      requiredReceiptKinds: ["artifact", "code_change"],
      verifierId: null,
    },
  } as any;

  assert.deepEqual(resolveMissionGraphExecutionProofContractV1(node), {
    requiredEvidenceKinds: ["tool-result"],
    requiredReceiptKinds: ["code_change"],
  });
});

test("pending receipt-backed write goals outrank advisory completed-tool entries", () => {
  assert.deepEqual(
    getPendingRequiredWriteToolNames(
      {
        goals: { current_note_content: "pending" },
        completedTools: ["append_to_current_file"],
      } as never,
      ["append_to_current_file"],
    ),
    ["append_to_current_file"],
  );
});

test("continuation restores completed graph reads but never graph-only mutations", () => {
  assert.deepEqual(
    getRestorableCompletedGraphToolNames(
      ["read_design_canvas", "update_design_canvas", "delete_path"],
      ["read_design_canvas", "update_design_canvas", "delete_path"],
    ),
    ["read_design_canvas"],
  );
});

test("prompt-level chat-only wording leaves the active note unchanged", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const assistantDeltas: string[] = [];
  const receipts: AgentRunReceipt[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const original = "Original note";
  const prompt = "What is 2+2? Answer in chat only; do not write to the note.";
  const vault = createRunnerVaultContext({ prompt, content: original });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["In chat only: 2+2 equals 4."]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(assistantDeltas, ["In chat only: 2+2 equals 4."]);
  assert.equal(vault.content.get("Current.md"), original);
  assert.equal(receipts.length, 0);
  assert.equal(configs[0].writebackMode, "off");
  assert.equal(configs[0].chatOnlyOverride, true);
});

test("forceChatOnly leaves the active note unchanged without mutating the prompt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const original = "Original note";
  const prompt = "What is 2+2?";
  const vault = createRunnerVaultContext({ prompt, content: original });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["2+2 equals 4."]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    forceChatOnly: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].messages.at(-1)?.content, prompt);
  assert.equal(vault.content.get("Current.md"), original);
  assert.equal(receipts.length, 0);
  assert.equal(configs[0].writebackMode, "off");
  assert.equal(configs[0].chatOnlyOverride, true);
});

test("vault folder synthesis defaults to streamed note writeback after reads", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const prompt = "Synthesize what the notes in the Other folder say.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Synthesis\n\n",
  });
  vault.folders.add("Other");
  vault.content.set("Other/alpha.md", "The Other folder mentions quasarflux.");

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["Other notes mention quasarflux."]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["inspect_vault_context"],
  );
  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(vault.content.get("Current.md"), "# Synthesis\n\nOther notes mention quasarflux.");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "append");
  assert.equal(configs.at(-1)?.writebackMode, "streaming_current_note");
  assert.equal(configs.at(-1)?.route, "prefetched_vault_writeback");
});

test("plain Q&A creates a new note when no active markdown note exists", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const assistantDeltas: string[] = [];
  const receipts: AgentRunReceipt[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const vault = createRunnerVaultContext({
    prompt: "What is 2+2?",
    content: "",
  });
  // No active markdown note — force autonomous create path.
  (vault.context.app.workspace as { getActiveFile: () => null }).getActiveFile =
    () => null;
  vault.context.getCurrentMarkdownFile = () => null;
  (vault.context.app as { fileManager?: unknown }).fileManager = {
    getNewFileParent: () => ({ path: "" }),
    renameFile: async (
      file: { path: string; basename?: string },
      newPath: string,
    ) => {
      await vault.context.app.vault.rename(file as never, newPath);
    },
  };
  vault.context.settings = createRunnerSettings({
    outputProfile: "active_or_new_note",
    autonomyProfile: "automatic",
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["# Answer\n\n2+2 equals 4."]),
    ],
  });

  await runAgentMission({
    prompt: "What is 2+2?",
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.ok(assistantDeltas.join("").includes("2+2 equals 4."));
  assert.ok(receipts.length >= 1);
  const planEvent = configs.find((event) => event.noteOutputPlan);
  assert.equal(planEvent?.noteOutputPlan?.destination, "new_note");
  assert.ok(
    [...vault.content.keys()].some(
      (path) =>
        path.endsWith(".md") &&
        !path.startsWith("Agent Runs/") &&
        (path.includes("Untitled") || path.includes("Answer")),
    ),
  );
});

test("plain Q&A falls back to chat when output profile is chat_first and no note is active", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const assistantDeltas: string[] = [];
  const receipts: AgentRunReceipt[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["2+2 equals 4."]),
    ],
  });

  await runAgentMission({
    prompt: "What is 2+2?",
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: {
      app: {
        workspace: {
          getActiveFile: () => null,
        },
        vault: {},
      } as never,
      settings: createRunnerSettings({
        outputProfile: "chat_first",
        streamWritebackMode: "off",
      }),
      originalPrompt: "What is 2+2?",
      httpTransport: async () => ({
        status: 500,
        headers: {},
        json: { error: "not mocked" },
      }),
    },
    enableStreaming: true,
    events: {
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(assistantDeltas, ["2+2 equals 4."]);
  assert.equal(receipts.length, 0);
});

test("artifact path destructive code and browser prompts are not coerced into current-note append", async () => {
  const cases = [
    "Create a design canvas for onboarding.",
    "Create a note at Projects/Test.md with hello.",
    "Delete the current note.",
    "Run this JavaScript code: console.log(1).",
    "Open the browser and inspect https://example.com.",
  ];

  for (const prompt of cases) {
    const chatRequests: ModelChatRequest[] = [];
    const streamRequests: ModelChatRequest[] = [];
    const receipts: AgentRunReceipt[] = [];
    const configs: AgentRunConfigEvent[] = [];
    const original = "Original note";
    const vault = createRunnerVaultContext({ prompt, content: original });
    vault.context.settings = createRunnerSettings({
      browserToolsEnabled: true,
    });
    const client = createClient({
      chatRequests,
      streamRequests,
      chatResponders: Array.from(
        { length: MAX_AGENT_STEPS },
        () => () => responseWithContent("Handled in chat/tool routing."),
      ),
    });

    await runAgentMission({
      prompt,
      modelClient: client,
      toolRegistry: createDefaultToolRegistry(),
      toolContext: vault.context,
      enableStreaming: true,
      events: {
        onReceipt: (receipt) => receipts.push(receipt),
        onRunConfig: (event) => configs.push(event),
      },
    });

    assert.equal(vault.content.get("Current.md"), original, prompt);
    assert.equal(streamRequests.length, 0, prompt);
    assert.equal(receipts.length, 0, prompt);
    assert.notEqual(configs[0].writebackMode, "streaming_current_note", prompt);
  }
});

test("word-target generation writeback performs one internal correction pass", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const finalReplacements: string[] = [];
  const statuses: string[] = [];
  const correctedDraft = "one two three four five six seven eight nine ten";
  const vault = createRunnerVaultContext({
    prompt: "Write exactly 10 words about Obsidian.",
    content: "Existing note",
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["Obsidian draft."]),
    ],
    chatResponders: [
      () => responseWithContent(correctedDraft),
    ],
  });

  await runAgentMission({
    prompt: "Write exactly 10 words about Obsidian.",
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onFinalReplace: (content) => finalReplacements.push(content),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(streamRequests.length, 1);
  assert.equal(chatRequests.length, 1);
  assert.deepEqual(finalDeltas, ["Obsidian draft."]);
  assert.deepEqual(finalReplacements, [correctedDraft]);
  assert.ok(
    statuses.includes(
      "Word count 2/10 outside target; requesting one correction pass...",
    ),
  );
  assert.ok(
    statuses.includes("Word count: 10/10 (within target; correction=used)."),
  );
  assert.equal(vault.content.get("Current.md"), `Existing note\n${correctedDraft}`);
});

test("streaming word-count near-miss within ±5% keeps draft without correction", async () => {
  const statuses: string[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  // 95/100 is inside the soft streaming ±5% band (95–105). Bare "100 word"
  // still floors resume/shortfall checks, but streamed near-misses keep the
  // note instead of risking an append-prone correction pass.
  const nearMissDraft = Array.from({ length: 95 }, (_, i) => `w${i + 1}`).join(
    " ",
  );
  const vault = createRunnerVaultContext({
    prompt: "Write a 100 word essay about rain.",
    content: "",
  });

  await runAgentMission({
    prompt: "Write a 100 word essay about rain.",
    modelClient: createClient({
      chatRequests,
      streamRequests,
      streamResponders: [() => responseWithContentDeltas([nearMissDraft])],
      chatResponders: [
        () => {
          throw new Error("word-count correction must not run for soft near-miss");
        },
      ],
    }),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(
    statuses.some((line) => /requesting one correction pass/u.test(line)),
    false,
    statuses.join(" | "),
  );
  assert.ok(
    statuses.includes("Word count: 95/100 (within target; correction=not used)."),
    statuses.join(" | "),
  );
  assert.equal(chatRequests.length, 0);
});

test("streaming word-count far under soft band still requests one correction", async () => {
  const statuses: string[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const farUnderDraft = Array.from({ length: 50 }, (_, i) => `w${i + 1}`).join(
    " ",
  );
  const correctedDraft = Array.from({ length: 100 }, (_, i) => `c${i + 1}`).join(
    " ",
  );
  const vault = createRunnerVaultContext({
    prompt: "Write a 100 word essay about rain.",
    content: "",
  });

  await runAgentMission({
    prompt: "Write a 100 word essay about rain.",
    modelClient: createClient({
      chatRequests,
      streamRequests,
      streamResponders: [() => responseWithContentDeltas([farUnderDraft])],
      chatResponders: [() => responseWithContent(correctedDraft)],
    }),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.ok(
    statuses.some((line) =>
      /Word count 50\/100 outside target; requesting one correction pass/u.test(
        line,
      ),
    ),
    statuses.join(" | "),
  );
  assert.ok(
    statuses.includes("Word count: 100/100 (within target; correction=used)."),
    statuses.join(" | "),
  );
});

test("streamed writeback does not re-stream after partial note apply on provider 500", async () => {
  const statuses: string[] = [];
  let streamCalls = 0;
  // Long enough to clear the writeback safety buffer and flush into the note.
  const partialDraft = [
    "# Alienated Adolescent Draft",
    "",
    Array.from({ length: 80 }, (_, i) => `partial${i + 1}`).join(" "),
  ].join("\n");
  assert.ok(partialDraft.length > 120);
  const vault = createRunnerVaultContext({
    prompt: "Write a 200 word essay about the catcher in the rye.",
    content: "",
    liveEditorWrite: true,
  });
  vault.context.settings.modelRouterMode = "off";

  await assert.rejects(
    () =>
      runAgentMission({
        prompt: "Write a 200 word essay about the catcher in the rye.",
        modelClient: {
          chat: async () => {
            throw new Error("chat should not be required before stream failure");
          },
          streamChat: async (_request, events = {}) => {
            streamCalls += 1;
            events.onRawChunk?.("{}");
            events.onContentDelta?.(partialDraft);
            throw new ModelClientError("api", "Internal Server Error", {
              status: 500,
            });
          },
        },
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onStatus: (message) => statuses.push(message),
        },
      }),
    /partial_write_no_safe_retry|Internal Server Error|cannot safely retry/i,
  );

  assert.equal(
    streamCalls,
    1,
    `provider stream must not retry after note bytes applied; calls=${streamCalls}`,
  );
  const note = vault.content.get("Current.md") ?? "";
  assert.ok(/\bpartial1\b/.test(note), note);
  assert.equal(
    (note.match(/\bpartial1\b/g) ?? []).length,
    1,
    `partial draft was duplicated by a stream retry:\n${note}`,
  );
  assert.equal(
    (note.match(/\bpartial80\b/g) ?? []).length,
    1,
    `tail marker duplicated by a stream retry:\n${note}`,
  );
  assert.ok(
    statuses.some((line) => /partial|Streaming writeback|Internal Server/i.test(line)),
    statuses.join(" | "),
  );
});

test("continue after under-target partial essay expands in place instead of appending", async () => {
  const statuses: string[] = [];
  const broker = new ApprovalBroker();
  const partialEssay = [
    "# Catcher Partial",
    "",
    Array.from({ length: 60 }, (_, i) => `keep${i + 1}`).join(" "),
  ].join("\n");
  const expandedEssay = [
    "# Catcher Partial",
    "",
    Array.from({ length: 98 }, (_, i) => `exp${i + 1}`).join(" "),
  ].join("\n");
  const mission = "Write a 100 word essay about the catcher in the rye.";
  const vault = createRunnerVaultContext({
    prompt: mission,
    content: partialEssay,
    now: new Date(5151),
  });
  vault.context.settings.modelRouterMode = "off";

  // Seed a failed/incomplete run ledger so Continue restores originalMission.
  const runId = "run-partial-essay-expand-1";
  const { writeMissionLedger, createMissionLedger } = await import(
    "../src/agent/missionLedger"
  );
  const ledger = createMissionLedger({
    runId,
    mission,
    route: "direct_writeback",
    loopBudget: {
      hardCap: 12,
      toolStepBudget: 4,
      finalizationReserve: 2,
      expectedTools: [],
      stopWhenSatisfied: true,
    },
    now: new Date(5151),
  });
  ledger.status = "blocked";
  ledger.nextActions = [
    "Streamed writeback cannot safely retry after partial note apply (partial_write_no_safe_retry). Partial draft was kept.",
  ];
  ledger.continuationCommand = `continue run ${runId}`;
  ledger.blockers = ["partial_write_no_safe_retry"];
  await writeMissionLedger(vault.context, ledger);

  await runAgentMission({
    prompt: `continue run ${runId}`,
    modelClient: createClient({
      chatRequests: [],
      streamRequests: [],
      streamResponders: [
        () => responseWithContentDeltas([expandedEssay]),
        () => responseWithContentDeltas([expandedEssay]),
      ],
      chatResponders: [
        () => responseWithContent(expandedEssay),
        () => responseWithContent(expandedEssay),
        () => responseWithContent(expandedEssay),
      ],
    }),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        broker.resolve(request.id, "approved");
      },
      onStatus: (message) => statuses.push(message),
    },
  });

  const note = vault.content.get("Current.md") ?? "";
  assert.ok(
    statuses.some((line) =>
      /Partial draft under word target|expand-in-place|Streaming writeback/i.test(
        line,
      ),
    ),
    statuses.join(" | "),
  );
  assert.equal(note.includes("keep1"), false, `old partial still present:\n${note}`);
  assert.ok(note.includes("exp1"), note);
  assert.equal(
    note.includes(partialEssay),
    false,
    "must replace the under-target draft, not append a second essay",
  );
});

test("word-count shortfall follow-up replaces the draft instead of appending", async () => {
  const statuses: string[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const broker = new ApprovalBroker();
  const existingEssay = [
    "# Catcher in the Rye Draft",
    "",
    "Holden Caulfield old1 old2 old3 old4 old5 old6 old7 old8 old9 old10 ",
    "old11 old12 old13 old14 old15 old16 old17 old18 old19 old20 old21 old22 ",
    "old23 old24 old25 old26 old27 old28 old29 old30 old31 old32 old33 old34 ",
    "old35 old36 old37 old38 old39 old40 old41 old42 old43 old44 old45 old46 ",
    "old47 old48 old49 old50 old51 old52 old53 old54 old55 old56 old57 old58 ",
    "old59 old60 old61 old62 old63 old64 old65 old66 old67 old68 old69 old70 ",
    "old71 old72 old73 old74 old75 old76 old77 old78 old79 old80",
  ].join("\n");
  const expandedEssay = [
    "# Catcher in the Rye Draft",
    "",
    "Holden Caulfield new1 new2 new3 new4 new5 new6 new7 new8 new9 new10 ",
    "new11 new12 new13 new14 new15 new16 new17 new18 new19 new20 new21 new22 ",
    "new23 new24 new25 new26 new27 new28 new29 new30 new31 new32 new33 new34 ",
    "new35 new36 new37 new38 new39 new40 new41 new42 new43 new44 new45 new46 ",
    "new47 new48 new49 new50 new51 new52 new53 new54 new55 new56 new57 new58 ",
    "new59 new60 new61 new62 new63 new64 new65 new66 new67 new68 new69 new70 ",
    "new71 new72 new73 new74 new75 new76 new77 new78 new79 new80 new81 new82 ",
    "new83 new84 new85 new86 new87 new88 new89 new90 new91 new92 new93 new94 ",
    "new95 new96 new97 new98 new99 new100",
  ].join("\n");
  const prompt =
    "The Catcher in the Rye essay still isn't 100 words. Expand it to at least 100 words.";
  const vault = createRunnerVaultContext({
    prompt,
    content: existingEssay,
    now: new Date(4242),
  });
  vault.context.settings.modelRouterMode = "off";

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      streamRequests,
      streamResponders: [
        () => responseWithContentDeltas([expandedEssay]),
        () => responseWithContentDeltas([expandedEssay]),
        () => responseWithContentDeltas([expandedEssay]),
      ],
      chatResponders: [
        () => responseWithContent(expandedEssay),
        () => responseWithContent(expandedEssay),
        () => responseWithContent(expandedEssay),
        () => responseWithContent(expandedEssay),
        () => responseWithContent(expandedEssay),
      ],
    }),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        broker.resolve(request.id, "approved");
      },
      onStatus: (message) => statuses.push(message),
    },
  });

  const note = vault.content.get("Current.md") ?? "";
  assert.ok(
    statuses.some((line) => /direct note writeback|Streaming writeback|Write complete/i.test(line)),
    statuses.join(" | "),
  );
  assert.equal(note.includes("old1"), false, `old draft still present:\n${note}\nstatuses=${statuses.join(" | ")}`);
  assert.ok(note.includes("new1"), note);
  assert.equal(
    note.includes(existingEssay),
    false,
    "must replace rather than append the prior draft",
  );
});

test("word-count correction replaces flushed under-target draft instead of appending a second essay", async () => {
  const statuses: string[] = [];
  // Longer than LIVE_FLUSH_CHAR_THRESHOLD so the under-target draft is already
  // on disk before correction (the live Obsidian failure mode).
  const underTargetDraft = [
    "# Short Draft About Governance",
    "",
    "This under-target governance essay is intentionally padded so the streaming",
    "writeback flushes it into the note before the host word-count correction",
    "runs. Marker UNDER_TARGET_DRAFT_SHOULD_NOT_REMAIN must not survive.",
  ].join("\n");
  const correctedDraft =
    "exactly one governance topic two three four five six seven eight";
  assert.ok(
    underTargetDraft.length > 120,
    `under-target draft length ${underTargetDraft.length} must exceed live flush threshold`,
  );
  const vault = createRunnerVaultContext({
    prompt: "Write exactly 10 words about governance.",
    content: "Existing preface",
    liveEditorWrite: true,
  });

  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  await runAgentMission({
    prompt: "Write exactly 10 words about governance.",
    modelClient: createClient({
      chatRequests,
      streamRequests,
      streamResponders: [() => responseWithContentDeltas([underTargetDraft])],
      chatResponders: [() => responseWithContent(correctedDraft)],
    }),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const note = vault.content.get("Current.md") ?? "";
  assert.ok(
    statuses.some((line) =>
      /Word count \d+\/10 outside target; requesting one correction pass/u.test(
        line,
      ),
    ),
    statuses.join(" | "),
  );
  assert.equal(note, `Existing preface\n${correctedDraft}`);
  assert.equal(
    note.includes("UNDER_TARGET_DRAFT_SHOULD_NOT_REMAIN"),
    false,
    `under-target draft was left in the note (double append):\n${note}`,
  );
});

test("word-count correction strips a leading tool marker and preserves H1 title handling", async () => {
  const statuses: string[] = [];
  const assistantReplacements: string[] = [];
  // Live Grapes-of-Wrath failure: correction returned a new H1; replaceContent
  // used to refresh append base from the live note and concatenate two essays.
  const underTargetDraft = [
    "# Grapes Draft Should Not Remain",
    "",
    "This under-target grapes essay is intentionally padded so the streaming",
    "writeback flushes it into the note before the host word-count correction",
    "runs. Marker FIRST_ESSAY_SHOULD_NOT_REMAIN must not survive after replace.",
  ].join("\n");
  const correctedDraft = [
    "replace_current_file",
    "",
    "# The Grapes of Wrath Corrected",
    "",
    "exactly one grapes topic two three four five six seven eight",
  ].join("\n");
  assert.ok(underTargetDraft.length > 120);
  const vault = createRunnerVaultContext({
    prompt: "Write exactly 10 words about grapes of wrath.",
    content: "Existing preface",
    liveEditorWrite: true,
  });

  await runAgentMission({
    prompt: "Write exactly 10 words about grapes of wrath.",
    modelClient: createClient({
      chatRequests: [],
      streamRequests: [],
      streamResponders: [() => responseWithContentDeltas([underTargetDraft])],
      chatResponders: [() => responseWithContent(correctedDraft)],
    }),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantReplace: (content) => assistantReplacements.push(content),
    },
  });

  const note = vault.content.get("Current.md") ?? "";
  assert.ok(
    statuses.some((line) =>
      /Word count \d+\/10 outside target; requesting one correction pass/u.test(
        line,
      ),
    ),
    statuses.join(" | "),
  );
  assert.equal(
    note.includes("FIRST_ESSAY_SHOULD_NOT_REMAIN"),
    false,
    `first essay was left in the note (H1 correction appended):\n${note}`,
  );
  assert.equal(
    note.includes("Grapes Draft Should Not Remain"),
    false,
    `old H1 survived after correction:\n${note}`,
  );
  assert.ok(
    /exactly one grapes topic two three four five six seven eight/u.test(note),
    note,
  );
  assert.equal(note, "Existing preface\nexactly one grapes topic two three four five six seven eight");
  assert.deepEqual(assistantReplacements, [
    "# The Grapes of Wrath Corrected\n\nexactly one grapes topic two three four five six seven eight",
  ]);
  assert.equal(note.includes("replace_current_file"), false);
});

test("prompt-on-page generation streams the extracted answer into the current note", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const statuses: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const notePrompt =
    "Prompt: Write a short English response about The Grapes of Wrath by John Steinbeck.";
  const vault = createRunnerVaultContext({
    prompt: "Read the prompt on the page",
    content: notePrompt,
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "Steinbeck's ",
          "The Grapes of Wrath follows migrant families with grounded detail.",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Read the prompt on the page",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onReceipt: (receipt) =>
        receipts.push(receipt.output as Record<string, unknown>),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].tools, undefined);
  assert.equal(streamRequests[0].think, false);
  assert.ok(
    streamRequests[0].messages.some((message) =>
      /Current note context/.test(message.content),
    ),
  );
  assert.ok(
    streamRequests[0].messages.some((message) =>
      /Extract the prompt, instructions, question, or task/.test(message.content),
    ),
  );
  assert.ok(
    streamRequests[0].messages.some((message) =>
      /Prompt-on-page writeback is active/.test(message.content),
    ),
  );
  assert.match(
    streamRequests[0].messages.at(-1)?.content ?? "",
    /Write the markdown content to append to the current note now/i,
  );
  assert.equal(
    finalDeltas.join(""),
    "Steinbeck's The Grapes of Wrath follows migrant families with grounded detail.",
  );
  assert.deepEqual(assistantDeltas, finalDeltas);
  assert.equal(
    vault.content.get("Current.md"),
    `${notePrompt}\nSteinbeck's The Grapes of Wrath follows migrant families with grounded detail.`,
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "append");
  assert.equal(receipts[0].streamed, true);
  assert.ok(statuses.includes("Reading current note..."));
  assert.ok(statuses.includes("Streaming writeback to note..."));
  assert.ok(statuses.includes("Streaming writeback complete."));
});

test("prompt-on-page citation prompts use tools before streamed writeback", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const notePrompt =
    "Use web search to write a concise essay about The Grapes of Wrath with cited source URLs.";
  let finalDraft = "";
  const vault = createRunnerVaultContext({
    prompt: "Read the prompt on the page",
    content: notePrompt,
  });
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "The Grapes of Wrath source",
              url: "https://example.com/grapes-of-wrath",
              snippet: "Steinbeck and the Joad family during the Depression.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "The Grapes of Wrath source",
          content:
            "Steinbeck's novel follows the Joad family under Depression-era pressure.",
          links: [],
        },
      };
    }
    return { status: 404, headers: {}, json: { error: "not mocked" } };
  };

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("web_search", {
          query: "The Grapes of Wrath Steinbeck sources",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/grapes-of-wrath",
        }),
      (request) => {
        const passageId = getPassageCitationIds(request)[0];
        assert.ok(passageId, "final writeback must receive a fetched passage id");
        finalDraft =
          "Steinbeck's novel follows the Joad family under Depression-era pressure. " +
          `Source: https://example.com/grapes-of-wrath Passage evidence: [${passageId}]`;
        return responseWithContent(finalDraft);
      },
    ],
    streamResponders: [
      (request) => {
        const passageId = getPassageCitationIds(request)[0];
        assert.ok(passageId, "streamed writeback must receive a fetched passage id");
        return responseWithContentDeltas([
          "Steinbeck's novel follows the Joad family under Depression-era pressure. ",
          `Source: https://example.com/grapes-of-wrath Passage evidence: [${passageId}]`,
        ]);
      },
    ],
  });

  await runAgentMission({
    prompt: "Read the prompt on the page",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 0);
  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(
    firstStepToolNames.includes("web_search"),
    JSON.stringify(
      chatRequests.map(
        (request) => request.tools?.map((tool) => tool.function.name) ?? [],
      ),
    ),
  );
  assert.ok(firstStepToolNames.includes("web_fetch"));
  // Prompt-on-page refinement can expose the already host-authorized write
  // alongside capability reads; proof gates still prevent early mutation.
  assert.ok(firstStepToolNames.includes("append_to_current_file"));
  assert.ok(
    chatRequests.some((request) =>
      request.tools?.some(
        (tool) => tool.function.name === "append_to_current_file",
      ),
    ),
  );
  assert.match(chatRequests[0].messages.at(-1)?.content ?? "", /cited source URLs/);
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /current note has already been read/i.test(message.content),
    ),
  );
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /Use the relevant available tools before final writeback/i.test(
        message.content,
      ),
    ),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "web_search", "web_fetch", "append_to_current_file"],
  );
  assert.equal(
    executedCalls.filter((call) => call.name === "read_current_file").length,
    1,
  );
  assert.ok(statuses.includes("Using prompt from current note for tool routing..."));
  assert.ok(
    !statuses.includes(
      "Sources or vault tools are required; asking model to use tools before writing...",
    ),
  );
  assert.equal(
    vault.content.get("Current.md"),
    `${notePrompt}\n${finalDraft}`,
  );
});

test("notepage prompt wrapper routes to prefetched vault writeback", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const receipts: AgentRunReceipt[] = [];
  const notePrompt = [
    "You job is to traverse the 3 untitled folders. They are named Untitled, Untitled 1 and Untitled 2.",
    "",
    "I need you to tell me about the things discovered in those folders. Specifically, I want you to stream them onto this page.",
  ].join("\n");
  const streamedFinding = "quasarflux";
  const vault = createRunnerVaultContext({
    prompt: "Refer  to the notes in the notepage as the prompt",
    content: notePrompt,
  });
  vault.content.set("Untitled/alpha.md", "quasarflux discovery");
  vault.content.set("Untitled 1/beta.md", "beta discovery");
  vault.content.set("Untitled 2/gamma.md", "gamma discovery");

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas([streamedFinding]),
    ],
  });

  await runAgentMission({
    prompt: "Refer  to the notes in the notepage as the prompt",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onRunConfig: (event) => configs.push(event),
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "inspect_vault_context"],
  );
  assert.deepEqual(executedCalls[1].arguments, {
    scope: "all_vault",
    targetFolders: ["Untitled", "Untitled 1", "Untitled 2"],
  });
  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].tools, undefined);
  assert.equal(streamRequests[0].think, false);
  assert.equal(configs.at(-1)?.route, "prefetched_vault_writeback");
  assert.equal(configs.at(-1)?.writebackMode, "streaming_current_note");
  assert.ok(
    streamRequests[0].messages.some((message) =>
      /Prefetched vault context/.test(message.content),
    ),
  );
  assert.equal(vault.content.get("Current.md"), `${notePrompt}\n${streamedFinding}`);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "append");
  assert.ok(statuses.includes("Inspecting named vault folders locally..."));
  assert.ok(!statuses.some((status) => /Vault traversal required/i.test(status)));
  assert.ok(
    !statuses.some((status) =>
      /could not get the model to request vault tools/i.test(status),
    ),
  );
});

test("prompt-on-page routing ignores prior generated findings as instructions", async () => {
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const notePrompt = [
    "You job is to traverse the 3 untitled folders. They are named Untitled, Untitled 1 and Untitled 2.",
    "",
    "I need you to tell me about the things discovered in those folders. Specifically, I want you to stream them onto this page.",
    "## Findings",
    "",
    "- Old generated finding that should remain context only.",
    "",
    "## A Tale of Toyota, Lion, and Blue",
    "",
    "Old generated story that should not become the new mission.",
  ].join("\n");
  const vault = createRunnerVaultContext({
    prompt: "Refer to the notes in the notepage as the prompt",
    content: notePrompt,
  });
  vault.content.set("Untitled/alpha.md", "alpha discovery");
  vault.content.set("Untitled 1/beta.md", "beta discovery");
  vault.content.set("Untitled 2/gamma.md", "gamma discovery");
  const client = createClient({
    chatRequests: [],
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["Fresh folder findings."]),
    ],
  });

  await runAgentMission({
    prompt: "Refer to the notes in the notepage as the prompt",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "inspect_vault_context"],
  );
  assert.deepEqual(executedCalls[1].arguments, {
    scope: "all_vault",
    targetFolders: ["Untitled", "Untitled 1", "Untitled 2"],
  });
  const userMission =
    [...streamRequests[0].messages]
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
  assert.match(userMission, /traverse the 3 untitled folders/i);
  assert.doesNotMatch(userMission, /Old generated finding/);
  assert.doesNotMatch(userMission, /A Tale of Toyota/);
  assert.equal(vault.content.get("Current.md"), `${notePrompt}\nFresh folder findings.`);
});

test("below Findings section routes to section append with backup", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const vault = createRunnerVaultContext({
    prompt:
      "Great, below the Findings section, can you write me a short story incorporating my favorite things?",
    content: [
      "# Research Note",
      "",
      "## Findings",
      "",
      "- Favorite car brand: Toyota.",
      "- Favorite animal: Lion.",
      "- Favorite color: Blue.",
      "",
      "## Next",
      "",
      "Keep this section.",
    ].join("\n"),
    now: new Date(321),
  });
  const story = "A blue Toyota carried a lion toward a quiet sunrise.";
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_section", {
          heading: "Findings",
          level: 2,
          content: story,
        }),
    ],
  });

  await runAgentMission({
    prompt:
      "Great, below the Findings section, can you write me a short story incorporating my favorite things?",
    conversationHistory: [
      {
        role: "assistant",
        content:
          "Favorite car brand: Toyota. Favorite animal: Lion. Favorite color: Blue.",
      },
    ],
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "append_to_current_section"],
  );
  const firstToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstToolNames.includes("append_to_current_section"));
  assert.ok(!firstToolNames.includes("append_to_current_file"));
  assert.equal(
    vault.content.get("Current.md"),
    [
      "# Research Note",
      "",
      "## Findings",
      "",
      "- Favorite car brand: Toyota.",
      "- Favorite animal: Lion.",
      "- Favorite color: Blue.",
      "",
      story,
      "",
      "## Next",
      "",
      "Keep this section.",
    ].join("\n"),
  );
  assert.equal(
    vault.content.get(".agent-backups/321-Current.md"),
    [
      "# Research Note",
      "",
      "## Findings",
      "",
      "- Favorite car brand: Toyota.",
      "- Favorite animal: Lion.",
      "- Favorite color: Blue.",
      "",
      "## Next",
      "",
      "Keep this section.",
    ].join("\n"),
  );
  assert.equal(receipts[0].toolName, "append_to_current_section");
  assert.equal(receipts[0].backupPath, ".agent-backups/321-Current.md");
});

test("context follow-up favorite things passes relevance gate", async () => {
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const statuses: string[] = [];
  const client = createClient({
    chatRequests: [],
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "A blue Toyota waited as a lion crossed the quiet road.",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Write a short story incorporating my favorite things.",
    conversationHistory: [
      {
        role: "assistant",
        content:
          "Favorite car brand: Toyota. Favorite animal: Lion. Favorite color: Blue.",
      },
    ],
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(streamRequests.length, 1);
  assert.equal(
    finalDeltas.join(""),
    "A blue Toyota waited as a lion crossed the quiet road.",
  );
  assert.ok(
    !statuses.includes(
      "Stopped model output because it drifted off topic from the current mission.",
    ),
  );
});

test("delete all notes on the page routes to replace-current-page with backup", async () => {
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const broker = new ApprovalBroker();
  const prompt =
    "I want you to delete all the notes on the page and then write a 300 word essay on the renaissance.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Old Notes\n\nOld Renaissance notes to remove.",
    now: new Date(987),
  });
  const backupVault = vault.context.app.vault as never as {
    getFolderByPath: (path: string) => unknown;
    createFolder: (path: string) => Promise<void>;
  };
  const originalGetFolderByPath = backupVault.getFolderByPath;
  backupVault.getFolderByPath = (path: string) =>
    path === BACKUP_FOLDER ? null : originalGetFolderByPath(path);
  backupVault.createFolder = async (path: string) => {
    vault.operations.push(`createFolder:${path}`);
    if (path === BACKUP_FOLDER) {
      throw new Error("Folder already exists.");
    }
  };
  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithContent("Ready to replace the page."),
      () =>
        responseWithContent(
          "# The Renaissance\n\nThe Renaissance reshaped European art, science, and humanist thought.",
        ),
    ],
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# The Renaissance\n\n",
          "The Renaissance reshaped European art, science, and humanist thought.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        assert.equal(
          vault.content.get("Current.md"),
          "# Old Notes\n\nOld Renaissance notes to remove.",
        );
        broker.resolve(request.id, "approved");
      },
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "replace_current_file"],
  );
  assert.equal(streamRequests.length, 1);
  assert.equal(
    vault.content.get("Current.md"),
    "# The Renaissance\n\nThe Renaissance reshaped European art, science, and humanist thought.",
  );
  assert.equal(
    vault.content.get(".agent-backups/987-Current.md"),
    "# Old Notes\n\nOld Renaissance notes to remove.",
  );
  assert.ok(vault.operations.includes(`createFolder:${BACKUP_FOLDER}`));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "replace");
  assert.equal(receipts[0].toolName, "replace_current_file");
});

test("research memory save uses durable memory tool with streaming enabled", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const prompt =
    "Save this to research memory for E2E memory topic: E2E_MEMORY_MARKER.";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-04T12:00:00.000Z"),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      (request) => {
        const toolNames =
          request.tools?.map((tool) => tool.function.name).filter(Boolean) ?? [];
        assert.ok(toolNames.includes("append_research_memory"));
        assert.ok(!toolNames.includes("append_to_current_file"));
        return responseWithToolCall("append_research_memory", {
          topic: "E2E memory topic",
          text: "E2E_MEMORY_MARKER",
          keywords: ["e2e", "memory"],
        });
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["append_research_memory"],
  );
  assert.match(
    vault.content.get("Agent Memory/Research/e2e-memory-topic.md") ?? "",
    /E2E_MEMORY_MARKER/,
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].toolName, "append_research_memory");
});

test("prompt-on-page word target counts generated output only before writing", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const notePrompt = "Prompt: Write exactly 5 words about Obsidian.";
  const correctedDraft = "one two three four five";
  const vault = createRunnerVaultContext({
    prompt: "Read the prompt on the page",
    content: notePrompt,
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["Obsidian note"]),
    ],
    chatResponders: [
      () => responseWithContent(correctedDraft),
    ],
  });

  await runAgentMission({
    prompt: "Read the prompt on the page",
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(streamRequests.length, 1);
  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].think, undefined);
  assert.equal(vault.content.get("Current.md"), `${notePrompt}\n${correctedDraft}`);
  assert.ok(
    statuses.includes(
      "Word count 2/5 outside target; requesting one correction pass...",
    ),
  );
  assert.ok(
    statuses.includes("Word count: 5/5 (within target; correction=used)."),
  );
});

test("buffered final answers strip raw model special tokens", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("<|begin_of_sentence|>Final answer<|end_of_sentence|>"),
    ],
  });

  await runAgentMission({
    prompt: "What is one fact about the Vietnam War?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.deepEqual(deltas, ["Final answer"]);
});

test("english prompts include english response policy", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("English answer")],
  });

  await runAgentMission({
    prompt: "Write a short essay about The Grapes of Wrath.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const promptText = chatRequests[0].messages
    .map((message) => message.content)
    .join("\n");

  assert.match(promptText, /Default to English for English missions/);
  assert.match(promptText, /Do not switch to Chinese/);
  assert.match(promptText, /Stay on the user's requested topic/);
});

test("plain static writing prompts do not expose current-note write tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("Static answer"),
    ],
  });

  await runAgentMission({
    prompt: "I want you to generate a concise research paragraph regarding the Vietnam War.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(!toolNames.includes("read_current_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("web_search"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [],
  );
  assert.deepEqual(deltas, ["Static answer"]);
});

test("vault traversal prompts expose folder and path inspection tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("list_current_folder", {}),
      () => responseWithContent("Vault placement answer"),
    ],
  });

  await runAgentMission({
    prompt: "Browse the vault folders and suggest where this note belongs.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("list_current_folder"));
  assert.ok(toolNames.includes("list_folder"));
  assert.ok(toolNames.includes("get_path_info"));
  assert.ok(toolNames.includes("list_markdown_files"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "list_current_folder"],
  );
});

test("path CRUD prompts expose only the relevant mutation tools", async () => {
  const scenarios: Array<{
    prompt: string;
    expected: string[];
    absent: string[];
  }> = [
    {
      prompt: "Create a new markdown file at Projects/Brief.md.",
      expected: ["create_file"],
      absent: ["create_folder", "append_to_current_file", "replace_current_file"],
    },
    {
      prompt:
        "Create E2E Agent Tests/Scoped Folder/scoped-output.md with a marker. Only write to that requested file.",
      expected: ["create_file"],
      absent: [
        "create_folder",
        "append_to_current_file",
        "append_file",
        "replace_current_file",
      ],
    },
    {
      prompt: "Create a folder at Projects/New.",
      expected: ["create_folder"],
      absent: ["create_file", "replace_file", "delete_path"],
    },
    {
      prompt: "Append this text to the file Projects/Brief.md.",
      expected: ["append_file"],
      absent: ["append_to_current_file", "replace_file"],
    },
    {
      prompt:
        "Append CURRENT_MARKER to the current note, then append FILE_MARKER to the existing markdown file Projects/Brief.md.",
      expected: ["append_to_current_file", "append_file"],
      absent: ["replace_current_file", "replace_file"],
    },
    {
      prompt:
        "Read the current note, create folder Projects/Chain, create file Projects/Chain/Brief.md, append text to it, replace that file, move it to Projects/Chain/Moved.md, then trash Projects/Chain/Moved.md.",
      expected: [
        "create_folder",
        "create_file",
        "append_file",
        "replace_file",
        "move_path",
        "delete_path",
      ],
      absent: ["append_to_current_file", "replace_current_file", "delete_current_file"],
    },
    {
      prompt: "Replace the file Projects/Brief.md with a clean brief.",
      expected: ["replace_file"],
      absent: ["replace_current_file", "append_file"],
    },
    {
      prompt: "Rename the file Projects/Brief.md to Projects/Renamed.md.",
      expected: ["move_path"],
      absent: ["retitle_current_file", "replace_file"],
    },
    {
      prompt: "Delete the folder Projects/Archive.",
      expected: ["delete_path"],
      absent: ["delete_current_file", "replace_file"],
    },
  ];

  for (const scenario of scenarios) {
    const chatRequests: ModelChatRequest[] = [];
    const client = createClient({
      chatRequests,
      chatResponders: Array.from(
        { length: MAX_AGENT_STEPS },
        () => () => responseWithContent("Done"),
      ),
    });

    await runAgentMission({
      prompt: scenario.prompt,
      modelClient: client,
      toolRegistry: createRegistry([]),
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
    });

    const toolNames =
      chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
    for (const toolName of scenario.expected) {
      assert.ok(
        toolNames.includes(toolName),
        `${scenario.prompt} Missing ${toolName}; exposed: ${toolNames.join(", ")}`,
      );
    }

    for (const toolName of scenario.absent) {
      assert.ok(
        !toolNames.includes(toolName),
        `${scenario.prompt} Unexpected ${toolName}; exposed: ${toolNames.join(", ")}`,
      );
    }
  }
});

test("template prompts expose template tools without generic file creation", async () => {
  const scenarios: Array<{
    prompt: string;
    expected: string[];
    absent: string[];
  }> = [
    {
      prompt: "List my saved templates.",
      expected: ["list_templates", "read_template"],
      absent: ["create_template", "fill_template", "create_file"],
    },
    {
      prompt: "Create a reusable meeting notes template.",
      expected: ["create_template"],
      absent: ["seed_default_templates", "fill_template", "create_file"],
    },
    {
      prompt: "Seed the default starter templates.",
      expected: ["seed_default_templates"],
      absent: ["create_template", "fill_template", "create_file"],
    },
    {
      prompt:
        "Use the meeting template to create a note at Meetings/Product Sync.md.",
      expected: ["list_templates", "read_template", "fill_template"],
      absent: ["seed_default_templates", "create_file", "append_to_current_file"],
    },
    {
      prompt: "Create a research pack with a brief, sources index, and synthesis.",
      expected: ["create_research_pack"],
      absent: ["create_file", "fill_template", "append_to_current_file"],
    },
    {
      prompt: "Write a 500 word essay about coral reefs.",
      expected: [],
      absent: [
        "list_templates",
        "read_template",
        "seed_default_templates",
        "create_template",
        "fill_template",
      ],
    },
    {
      prompt: "Research checkers in the form of a short brief with two sources.",
      expected: [],
      absent: [
        "list_templates",
        "read_template",
        "seed_default_templates",
        "create_template",
        "fill_template",
      ],
    },
  ];

  for (const scenario of scenarios) {
    const chatRequests: ModelChatRequest[] = [];
    const client = createClient({
      chatRequests,
      chatResponders: Array.from(
        { length: MAX_AGENT_STEPS },
        () => () => responseWithContent("Done"),
      ),
    });

    await runAgentMission({
      prompt: scenario.prompt,
      modelClient: client,
      toolRegistry: createRegistry([]),
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
    });

    const toolNames =
      chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
    for (const toolName of scenario.expected) {
      assert.ok(
        toolNames.includes(toolName),
        `${scenario.prompt} Missing ${toolName}; exposed: ${toolNames.join(", ")}`,
      );
    }

    for (const toolName of scenario.absent) {
      assert.ok(!toolNames.includes(toolName), scenario.prompt);
    }
  }
});

test("full-pipeline create-one-issue compound requires the Linear template before create", async () => {
  const prompt = [
    "Run the full pipeline for Flow real MARKER: Linear issue, repository workspace, private GitHub, and note reflection.",
    "Call linear_create_issue for team TEAM titled Flow real MARKER, then call linear_get_issue to read it back.",
    "Create workspace WS, write src/flow_real.ts, validate, commit, create the exact private GitHub repository login/repo, then append_to_current_file reflection.",
  ].join(" ");
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.linearEnabled = true;
  vault.context.settings.githubEnabled = true;
  vault.context.settings.autonomyProfile = "automatic";
  vault.context.settings.workingMode = "automatic";
  const base = createDefaultToolRegistry();
  const linearStubs: AgentTool[] = [
    {
      name: "linear_create_issue",
      description: "Create a Linear issue.",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    },
    {
      name: "linear_get_issue",
      description: "Read a Linear issue.",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    },
  ];
  const registry = new DefaultToolRegistry([
    ...linearStubs,
    // Prefer stubs for Linear names; keep the rest of the default catalog via
    // a thin execute/getDefinitions wrapper below is unnecessary when stubs
    // alone plus default registry merge through getDefinitions composition.
  ]);
  const composedRegistry: ToolRegistry = {
    getDefinitions: () => {
      const seen = new Set<string>();
      const defs = [];
      for (const definition of [
        ...registry.getDefinitions(),
        ...base.getDefinitions(),
      ]) {
        if (seen.has(definition.function.name)) continue;
        seen.add(definition.function.name);
        defs.push(definition);
      }
      return defs;
    },
    execute: async (call, context) => {
      if (linearStubs.some((tool) => tool.name === call.name)) {
        return registry.execute(call, context);
      }
      return base.execute(call, context);
    },
  };
  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("Done")],
    }),
    toolRegistry: composedRegistry,
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });
  const allowed = configs[0]?.allowedToolNames ?? [];
  assert.equal(
    allowed.includes("linear_create_issue"),
    true,
    `expected linear_create_issue allowed; got: ${allowed.join(", ")}`,
  );
  assert.equal(
    allowed.includes("linear_get_issue"),
    true,
    `expected linear_get_issue allowed; got: ${allowed.join(", ")}`,
  );
  const firstFrontier =
    chatRequests[0]?.tools?.map((tool) => tool.function.name) ?? [];
  if (firstFrontier.length > 0) {
    assert.equal(
      firstFrontier.includes("read_template"),
      true,
      `expected read_template in frontier; got: ${firstFrontier.join(", ")}`,
    );
    assert.equal(
      firstFrontier.includes("linear_create_issue"),
      false,
      `linear_create_issue must wait for the template; got: ${firstFrontier.join(", ")}`,
    );
  }
});

test("exact named vault read frontier exposes only its authoritative path", () => {
  const definitions = [{
    type: "function" as const,
    function: {
      name: "read_file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  }];
  const graph = {
    nodes: {
      readSource: {
        status: "ready",
        allowedTools: ["read_file"],
        inputs: {
          resource: {
            kind: "binding",
            bindingId: "binding-vault-markdown",
            selector: "Sources/Alpha.md",
          },
        },
      },
    },
  } as never;
  const bound = bindExactWorkspaceDestinationToolSchemas(definitions, graph);
  assert.deepEqual(
    bound[0]?.function.parameters.properties?.path?.enum,
    ["Sources/Alpha.md"],
  );
});

test("essay then Linear issues keeps append before template and create", async () => {
  const prompt =
    "Could you write me a 1000 word essay on china's government? Then turn the essay into linear issues?";
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.linearEnabled = true;
  const base = createDefaultToolRegistry();
  const linearStubs: AgentTool[] = [
    {
      name: "linear_create_issue",
      description: "Create a Linear issue.",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    },
  ];
  const registry = new DefaultToolRegistry(linearStubs);
  const composedRegistry: ToolRegistry = {
    getDefinitions: () => {
      const seen = new Set<string>();
      const defs = [];
      for (const definition of [
        ...registry.getDefinitions(),
        ...base.getDefinitions(),
      ]) {
        if (seen.has(definition.function.name)) continue;
        seen.add(definition.function.name);
        defs.push(definition);
      }
      return defs;
    },
    execute: async (call, context) => {
      if (linearStubs.some((tool) => tool.name === call.name)) {
        return registry.execute(call, context);
      }
      return base.execute(call, context);
    },
  };
  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Done")],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: composedRegistry,
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(
    configs[0]?.route,
    "tool_required",
    `expected tool_required route; got ${configs[0]?.route}`,
  );
  const allowed = configs[0]?.allowedToolNames ?? [];
  assert.equal(
    allowed.includes("linear_create_issue"),
    true,
    `expected linear_create_issue allowed; got: ${allowed.join(", ")}`,
  );
  assert.equal(
    allowed.includes("append_to_current_file"),
    true,
    `expected append_to_current_file allowed; got: ${allowed.join(", ")}`,
  );
  assert.deepEqual(
    getRequiredWriteToolNamesForTests(prompt, allowed),
    ["append_to_current_file", "read_template", "linear_create_issue"],
    "ordinary note-plus-Linear work must retain its standalone append before publication",
  );
});

test("affirmative generic and literal Linear creates route through a template first", async () => {
  for (const prompt of [
    "Create an issue in Linear for the accepted research.",
    "Create one Linear issue titled Fix onboarding in team TEAM.",
  ]) {
    const chatRequests: ModelChatRequest[] = [];
    const vault = createRunnerVaultContext({ prompt });
    vault.context.settings.linearEnabled = true;
    vault.context.settings.autonomyProfile = "automatic";
    vault.context.settings.workingMode = "automatic";
    await runAgentMission({
      prompt,
      modelClient: createClient({
        chatRequests,
        chatResponders: [() => responseWithContent("Done")],
      }),
      toolRegistry: createDefaultToolRegistry(),
      toolContext: vault.context,
      enableStreaming: false,
    });

    const firstFrontier =
      chatRequests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    assert.equal(
      firstFrontier.includes("read_template"),
      true,
      `${prompt} frontier=${firstFrontier.join(",")}`,
    );
    assert.equal(firstFrontier.includes("list_templates"), false, prompt);
    assert.equal(firstFrontier.includes("linear_create_issue"), false, prompt);
  }

  for (const negativePrompt of [
    "Read Linear issue ENG-42 from the workspace.",
    "Do not create an issue in Linear; explain the workflow only.",
    "Explain why eigenvectors matter in linear algebra.",
  ]) {
    const negativeRequests: ModelChatRequest[] = [];
    const negativeVault = createRunnerVaultContext({ prompt: negativePrompt });
    negativeVault.context.settings.linearEnabled = true;
    await runAgentMission({
      prompt: negativePrompt,
      modelClient: createClient({
        chatRequests: negativeRequests,
        chatResponders: [() => responseWithContent("Done")],
      }),
      toolRegistry: createDefaultToolRegistry(),
      toolContext: negativeVault.context,
      enableStreaming: false,
    });
    const exposed =
      negativeRequests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    assert.equal(exposed.includes("read_template"), false, negativePrompt);
    assert.equal(exposed.includes("list_templates"), false, negativePrompt);
  }
});

test("Linear create binds the canonical template by default and preserves an explicit template override", async () => {
  const cases = [
    {
      prompt: "Create one Linear issue titled Fix onboarding in team TEAM.",
      requestedPath: "Templates/Invented.md",
      expectedPath: LINEAR_ISSUE_TEMPLATE_PATH,
    },
    {
      prompt:
        "Use a template to create one Linear issue titled Fix onboarding in team TEAM.",
      requestedPath: "Templates/Invented.md",
      expectedPath: LINEAR_ISSUE_TEMPLATE_PATH,
    },
    {
      prompt:
        "Using the template at Templates/Custom Linear.md, create one Linear issue titled Fix onboarding in team TEAM.",
      requestedPath: "Templates/Invented.md",
      expectedPath: "Templates/Custom Linear.md",
    },
  ];

  for (const item of cases) {
    const chatRequests: ModelChatRequest[] = [];
    const executedCalls: ModelToolCall[] = [];
    const graphUpdates: any[] = [];
    const traces: AgentTraceEvent[] = [];
    const vault = createRunnerVaultContext({ prompt: item.prompt });
    vault.context.settings.linearEnabled = true;
    vault.context.settings.autonomyProfile = "automatic";
    vault.context.settings.workingMode = "automatic";
    vault.content.set(LINEAR_ISSUE_TEMPLATE_PATH, LINEAR_ISSUE_TEMPLATE_V1);
    vault.content.set("Templates/Custom Linear.md", "# {{title}}\n\nCustom body");
    const baseRegistry = createDefaultToolRegistry();
    const linearStubRegistry = new DefaultToolRegistry([
      {
        name: "linear_create_issue",
        description: "Create one Linear issue.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ ok: true }),
      },
    ]);
    const linearCreateDescriptor: ToolDescriptor = {
      version: 1,
      name: "linear_create_issue",
      capability: { system: "linear", resourceType: "issue", action: "create" },
      effect: "reversible_mutation",
      risk: "medium",
      approval: {
        allowPromptGrant: true,
        allowPersistentGrant: true,
        fallback: "exact",
      },
      execution: { preparation: "required", cacheable: false, parallelSafe: false },
      durability: {
        journal: true,
        receipt: true,
        readback: "required",
        reconciliation: "required",
      },
      allowedPrincipals: ["single_agent", "lead", "researcher"],
      receiptKind: "external_action",
    };
    const registry: ToolRegistry = {
      getDefinitions: () => [
        ...linearStubRegistry.getDefinitions(),
        ...baseRegistry.getDefinitions(),
      ],
      getDescriptor: (name) =>
        name === "linear_create_issue"
          ? linearCreateDescriptor
          : (baseRegistry.getDescriptor?.(name) ?? null),
      execute: async (call, context) => {
        executedCalls.push(call);
        return call.name === "linear_create_issue"
          ? linearStubRegistry.execute(call, context)
          : baseRegistry.execute(call, context);
      },
    };

    await runAgentMission({
      prompt: item.prompt,
      modelClient: createClient({
        chatRequests,
        chatResponders: [
          () => responseWithToolCall("read_template", { path: item.requestedPath }),
          () => responseWithContent("Template read complete."),
        ],
      }),
      toolRegistry: registry,
      toolContext: vault.context,
      enableStreaming: false,
      maxSteps: 2,
      events: {
        onMissionGraphUpdate: (graph) => graphUpdates.push(graph),
        onTrace: (trace) => traces.push(trace),
      },
    });

    const firstFrontier =
      chatRequests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    assert.equal(
      firstFrontier.includes("read_template"),
      true,
      `${item.prompt} frontier=${firstFrontier.join(",")} traces=${JSON.stringify(
        traces.filter((trace) => trace.kind === "error"),
      )}`,
    );
    const postTemplateFrontier =
      chatRequests[1]?.tools?.map((tool) => tool.function.name) ?? [];
    assert.equal(
      postTemplateFrontier.includes("linear_create_issue"),
      true,
      `${item.prompt} post-template frontier=${postTemplateFrontier.join(",")} graph=${JSON.stringify(
        graphUpdates.at(-1)?.nodes ?? {},
      )}`,
    );
    assert.equal(
      postTemplateFrontier.includes("append_to_current_file"),
      false,
      `${item.prompt} invented a current-note write after the template read`,
    );
    assert.deepEqual(
      executedCalls.map((call) => [call.name, call.arguments.path]),
      [["read_template", item.expectedPath]],
      item.prompt,
    );
  }
});

test("model Linear create rejects unsafe provider-visible fields", () => {
  const cases = [
    {
      label: "clean template-shaped Markdown",
      title: "Fix onboarding",
      description:
        "## Problem / impact\nOnboarding fails for invited users.\n\n## Acceptance criteria\n- Invited users can sign in.",
      expectedUnsafe: false,
    },
    {
      label: "unresolved title placeholder",
      title: "{{title}}",
      description: "## Problem / impact\nOnboarding fails for invited users.",
      expectedUnsafe: true,
    },
    {
      label: "internal description marker",
      title: "Fix onboarding",
      description: "## Machine contract\nsha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expectedUnsafe: true,
    },
  ];

  for (const item of cases) {
    const message = getUnsafeModelLinearIssueCreateOutputMessage({
      name: "linear_create_issue",
      arguments: {
        teamId: "TEAM",
        title: item.title,
        description: item.description,
      },
    });
    assert.equal(message !== null, item.expectedUnsafe, item.label);
    if (item.expectedUnsafe) {
      assert.match(message ?? "", /internal agent metadata|unresolved template placeholder/iu);
    }
  }
});

test("path write prompts require the matching path-based write tool", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I would create it in chat only."),
      () =>
        responseWithToolCall("create_file", {
          path: "Projects/Brief.md",
          content: "# Brief",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Create a new markdown file at Projects/Brief.md.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: create_file/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["create_file"],
  );
  assert.ok(statuses.includes("Created file Projects/Brief.md."));
});

test("template fill prompts require fill_template and emit a create receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const receipts: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I filled it in chat only."),
      () =>
        responseWithToolCall("fill_template", {
          templatePath: "Meeting.md",
          values: { title: "Product Sync" },
          targetPath: "Meetings/Product Sync.md",
        }),
    ],
  });

  await runAgentMission({
    prompt:
      "Use the meeting template to create a note at Meetings/Product Sync.md.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  // Nudge (chat 1) + write tool (chat 2); an optional post-write planning turn
  // may follow when the loop budget still has headroom.
  assert.ok(chatRequests.length >= 2, `chatCount=${chatRequests.length}`);
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now:.*\bfill_template\b/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["fill_template"],
  );
  assert.ok(statuses.includes("Created filled template note Meetings/Product Sync.md."));
  assert.deepEqual(receipts, ["create Meetings/Product Sync.md"]);
});

test("default template seed prompts require seed_default_templates and emit receipts", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const receipts: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I created the templates in chat only."),
      () =>
        responseWithToolCall("seed_default_templates", {
          createFolders: true,
        }),
    ],
  });

  await runAgentMission({
    prompt: "Seed the default starter templates in my vault.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: seed_default_templates/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["seed_default_templates"],
  );
  assert.ok(statuses.includes("Created 7 default templates."));
  assert.deepEqual(receipts, ["create Templates; affected: 7"]);
});

test("design prompts expose and require native artifact write tools", async () => {
  const scenarios: Array<{
    prompt: string;
    requiredTool: string;
    absentTool: string;
    expectedStatus: string;
    expectedReceipt: string;
  }> = [
    {
      prompt: "Draw an Obsidian canvas product flow diagram.",
      requiredTool: "create_design_canvas",
      absentTool: "create_svg_design",
      expectedStatus: "Created canvas Designs/Product Flow.canvas with 2 nodes and 1 edges.",
      expectedReceipt: "create Designs/Product Flow.canvas",
    },
    {
      prompt: "Create a software architecture diagram for the agent.",
      requiredTool: "create_design_canvas",
      absentTool: "create_svg_design",
      expectedStatus: "Created canvas Designs/Product Flow.canvas with 2 nodes and 1 edges.",
      expectedReceipt: "create Designs/Product Flow.canvas",
    },
    {
      prompt: "Architect E2E_DISTRIBUTED_SYSTEM_PACKAGE as a globally distributed order system at scale. Create an editable Canvas, SVG image, and brief covering capacity, failover, security, observability, and data flow.",
      requiredTool: "create_design_package",
      absentTool: "create_svg_design",
      expectedStatus: "Created design package Design Packages/System Architecture.md with canvas Design Packages/System Architecture.canvas.",
      expectedReceipt: "create Design Packages/System Architecture.md",
    },
    {
      prompt: "Map a manufacturing business process with production, quality-control, and OEE swimlanes.",
      requiredTool: "create_design_package",
      absentTool: "create_svg_design",
      expectedStatus: "Created design package Design Packages/System Architecture.md with canvas Design Packages/System Architecture.canvas.",
      expectedReceipt: "create Design Packages/System Architecture.md",
    },
    {
      prompt: "Create an SVG wireframe mockup for the settings screen.",
      requiredTool: "create_svg_design",
      absentTool: "create_design_canvas",
      expectedStatus: "Created SVG Designs/settings-wireframe.svg with 3 shapes.",
      expectedReceipt: "create Designs/settings-wireframe.svg",
    },
  ];

  for (const scenario of scenarios) {
    const chatRequests: ModelChatRequest[] = [];
    const statuses: string[] = [];
    const receipts: string[] = [];
    const executedCalls: ModelToolCall[] = [];

    const client = createClient({
      chatRequests,
      chatResponders: [
        () => responseWithContent("I described the design in chat only."),
        () => responseWithToolCall(scenario.requiredTool, {}),
      ],
    });

    await runAgentMission({
      prompt: scenario.prompt,
      modelClient: client,
      toolRegistry: createRegistry(executedCalls),
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
      events: {
        onStatus: (message) => statuses.push(message),
        onReceipt: (receipt) => receipts.push(receipt.message),
      },
    });

    const firstToolNames =
      chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
    assert.ok(firstToolNames.includes(scenario.requiredTool), scenario.prompt);
    assert.ok(!firstToolNames.includes(scenario.absentTool), scenario.prompt);
    assert.match(
      chatRequests[1].messages.at(-1)?.content ?? "",
      new RegExp(`Request one of these allowed write tools now: ${scenario.requiredTool}`),
    );
    assert.deepEqual(
      executedCalls.map((call) => call.name),
      [scenario.requiredTool],
    );
    assert.ok(statuses.includes(scenario.expectedStatus), scenario.prompt);
    assert.deepEqual(receipts, [scenario.expectedReceipt]);
  }
});

test("existing Canvas revisions require read then patch without injecting current-note rename", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const path = "Designs/Product Flow.canvas";
  const baseHash = `sha256:${"a".repeat(64)}`;

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("read_design_canvas", { path }),
      () => responseWithContent("I updated the diagram title."),
      () =>
        responseWithToolCall("update_design_canvas", {
          path,
          baseHash,
          operations: [
            {
              op: "update_node",
              id: "canvas-title",
              patch: { text: "Revised Canvas Title" },
            },
          ],
        }),
    ],
  });

  await runAgentMission({
    prompt:
      "Update the title in my existing Obsidian Canvas diagram at Designs/Product Flow.canvas.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const firstToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstToolNames.includes("read_design_canvas"));
  assert.ok(firstToolNames.includes("update_design_canvas"));
  assert.ok(!firstToolNames.includes("rename_current_file"));
  assert.match(
    chatRequests[2].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: update_design_canvas/,
  );
  const executedDesignCalls = executedCalls
    .map((call) => call.name)
    .filter((name) =>
      name === "read_design_canvas" || name === "update_design_canvas",
    );
  assert.deepEqual(executedDesignCalls, [
    "read_design_canvas",
    "update_design_canvas",
  ]);
  assert.ok(
    !executedCalls.some((call) => call.name === "rename_current_file"),
  );
});

test("existing SVG revisions require safe read then hash-bound patch", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const path = "Designs/Settings.svg";
  const baseHash = `sha256:${"c".repeat(64)}`;
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("read_svg_design", { path }),
      () => responseWithContent("I described the revised SVG in chat only."),
      () => responseWithToolCall("update_svg_design", {
        path,
        baseHash,
        operations: [{ op: "update_text", id: "title", text: "Revised SVG" }],
      }),
    ],
  });

  await runAgentMission({
    prompt: "Update the title in my existing SVG diagram at Designs/Settings.svg.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const firstToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstToolNames.includes("read_svg_design"));
  assert.ok(firstToolNames.includes("update_svg_design"));
  assert.ok(!firstToolNames.includes("read_design_canvas"));
  assert.ok(!firstToolNames.includes("update_design_canvas"));
  assert.match(
    chatRequests[2].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: update_svg_design/,
  );
  assert.deepEqual(
    executedCalls
      .map((call) => call.name)
      .filter((name) => name === "read_svg_design" || name === "update_svg_design"),
    ["read_svg_design", "update_svg_design"],
  );
});

test("existing Mermaid revisions expose only the read then upsert artifact workflow", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const path = "Designs/System.md";
  const baseHash = `sha256:${"e".repeat(64)}`;
  const selector = { kind: "heading", heading: "Architecture" };
  const prompt =
    "Revise the Mermaid diagram under the Architecture heading in Designs/System.md.";
  const { context } = createRunnerVaultContext({ prompt });
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("read_mermaid_block", { path, selector }),
      () => responseWithContent("I described the revised Mermaid diagram."),
      () =>
        responseWithToolCall("upsert_mermaid_block", {
          path,
          baseHash,
          selector,
          mermaid: "flowchart LR\n  A[Research] --> B[Verified note]",
        }),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: context,
    enableStreaming: false,
  });

  const agentRequests = chatRequests.filter(
    (request) => request.evidencePhase === "agent_step",
  );
  const firstToolNames =
    agentRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.deepEqual(firstToolNames, ["read_mermaid_block"]);
  assert.deepEqual(
    agentRequests[1].tools?.map((tool) => tool.function.name) ?? [],
    ["upsert_mermaid_block"],
  );
  const mutationFrontierContext = agentRequests[1].messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  assert.match(mutationFrontierContext, /OBSERVED READBACK BINDING/);
  assert.match(mutationFrontierContext, new RegExp(baseHash));
  assert.match(mutationFrontierContext, /Designs\/System\.md/);
  for (const unrelatedTool of [
    "create_design_canvas",
    "read_design_canvas",
    "update_design_canvas",
    "create_svg_design",
    "read_svg_design",
    "update_svg_design",
    "read_current_file",
    "rename_current_file",
    "retitle_current_file",
    "append_to_current_file",
    "append_to_current_section",
    "prepare_edit_current_section",
    "edit_current_section",
    "replace_current_file",
    "create_file",
    "replace_file",
  ]) {
    assert.ok(
      !firstToolNames.includes(unrelatedTool),
      `${unrelatedTool} must not leak into an explicit Mermaid revision`,
    );
  }
  assert.match(
    agentRequests[2].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: upsert_mermaid_block/,
  );
  assert.deepEqual(
    executedCalls
      .map((call) => call.name)
      .filter(
        (name) =>
          name === "read_mermaid_block" || name === "upsert_mermaid_block",
      ),
    ["read_mermaid_block", "upsert_mermaid_block"],
  );
});

test("Mermaid mutation frontier restores its base hash from a durable receipt", () => {
  const baseHash = `sha256:${"7".repeat(64)}`;
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "upsert_mermaid_block",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  const binding = buildObservedMissionGraphFrontierBinding([], tools, [
    {
      toolName: "upsert_mermaid_block",
      operation: "edit",
      message: "Committed Mermaid revision.",
      path: "Designs/System.md",
      readback: {
        status: "verified",
        checkedAt: "2026-07-16T00:00:00.000Z",
        observedRevision: baseHash,
      },
      output: {
        selector: { kind: "heading", heading: "Architecture" },
      },
    },
  ]);

  assert.match(binding ?? "", /OBSERVED READBACK BINDING/);
  assert.match(binding ?? "", new RegExp(baseHash));
  assert.match(binding ?? "", /Designs\/System\.md/);
  assert.match(binding ?? "", /Architecture/);
});

test("Mermaid create then revise plans read, upsert, read, upsert, read frontier", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const path = "Designs/New System.md";
  const baseHash = `sha256:${"e".repeat(64)}`;
  const selector = { kind: "heading", heading: "E2E Diagram" };
  const prompt =
    `At the exact vault-relative path "${path}" under the exact heading "E2E Diagram", create a Mermaid diagram, read it back, then revise it to add a verification node and read it again.`;
  assert.deepEqual(getExplicitMermaidWorkflowToolNames(prompt), [
    "read_mermaid_block",
    "upsert_mermaid_block",
    "read_mermaid_block",
    "upsert_mermaid_block",
    "read_mermaid_block",
  ]);
  const { context } = createRunnerVaultContext({ prompt });
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("read_mermaid_block", {
          path: "wrong.md",
          selector: "E2E Diagram",
        }),
      () =>
        responseWithToolCall("upsert_mermaid_block", {
          path,
          baseHash,
          selector,
          mermaid: "flowchart LR\n  Plan --> Tool --> Receipt",
        }),
      () => responseWithToolCall("read_mermaid_block", { path, selector }),
      () =>
        responseWithToolCall("upsert_mermaid_block", {
          path,
          baseHash,
          selector,
          mermaid: "flowchart LR\n  Plan --> Tool --> Receipt --> Verification",
        }),
      () => responseWithToolCall("read_mermaid_block", { path, selector }),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: context,
    enableStreaming: false,
    maxSteps: 5,
  });

  const agentRequests = chatRequests.filter(
    (request) => request.evidencePhase === "agent_step",
  );
  assert.deepEqual(
    agentRequests.map(
      (request) => request.tools?.map((tool) => tool.function.name) ?? [],
    ),
    [
      ["read_mermaid_block"],
      ["upsert_mermaid_block"],
    ],
  );
  assert.deepEqual(
    executedCalls
      .map((call) => call.name)
      .filter(
        (name) =>
          name === "read_mermaid_block" || name === "upsert_mermaid_block",
      ),
    [
      "read_mermaid_block",
      "upsert_mermaid_block",
    ],
  );
  for (const call of executedCalls.filter(
    (candidate) => candidate.name === "read_mermaid_block",
  )) {
    assert.equal(call.arguments.path, path);
    assert.deepEqual(call.arguments.selector, selector);
  }
});

test("diagram follow-up after chat answer creates a native canvas artifact", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const receipts: string[] = [];
  const assistantDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I can describe the diagram in chat."),
      () => responseWithToolCall("create_design_canvas", {}),
    ],
  });

  await runAgentMission({
    prompt: "Can you create us the diagram?",
    conversationHistory: [
      {
        role: "assistant",
        content:
          "Here is Mermaid diagram text for a literary recommendation flowchart.",
      },
      {
        role: "user",
        content: "Why can't you create the diagram?",
      },
    ],
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onReceipt: (receipt) => receipts.push(receipt.message),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
    },
  });

  const firstToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstToolNames.includes("create_design_canvas"));
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: create_design_canvas/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["create_design_canvas"],
  );
  assert.ok(
    statuses.includes("Created canvas Designs/Product Flow.canvas with 2 nodes and 1 edges."),
  );
  assert.deepEqual(receipts, ["create Designs/Product Flow.canvas"]);
  assert.deepEqual(assistantDeltas, [
    "Done. create Designs/Product Flow.canvas.",
  ]);
});

test("turn content into a design graph requires a native canvas instead of note prose", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const receipts: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          "Since I cannot render a visual image, paste this Mermaid text elsewhere.",
        ),
      () => responseWithToolCall("create_design_canvas", {}),
    ],
  });

  await runAgentMission({
    prompt: "Can you turn those 5 laws into a design graph?",
    conversationHistory: [
      {
        role: "assistant",
        content:
          "The first five laws cover the master, friends, intentions, silence, and reputation.",
      },
    ],
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  const firstToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstToolNames.includes("create_design_canvas"));
  assert.ok(!firstToolNames.includes("append_to_current_file"));
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: create_design_canvas/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["create_design_canvas"],
  );
  assert.deepEqual(receipts, ["create Designs/Product Flow.canvas"]);
});

test("explicit Canvas destination overrides Mermaid source wording and note writeback", async () => {
  for (const prompt of [
    "I want this to be on a canvas.",
    "Move this Mermaid diagram into an Obsidian Canvas.",
  ]) {
    const chatRequests: ModelChatRequest[] = [];
    const executedCalls: ModelToolCall[] = [];
    const client = createClient({
      chatRequests,
      chatResponders: [
        () => responseWithToolCall("create_design_canvas", {}),
      ],
    });

    await runAgentMission({
      prompt,
      conversationHistory: [
        {
          role: "assistant",
          content:
            "```mermaid\ngraph TD\n  Goal --> Law1\n  Goal --> Law2\n```",
        },
      ],
      modelClient: client,
      toolRegistry: createRegistry(executedCalls),
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
    });

    const firstToolNames =
      chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
    assert.ok(firstToolNames.includes("create_design_canvas"), prompt);
    for (const wrongDestination of [
      "append_to_current_file",
      "read_mermaid_block",
      "upsert_mermaid_block",
    ]) {
      assert.ok(!firstToolNames.includes(wrongDestination), `${prompt}: ${wrongDestination}`);
    }
    assert.deepEqual(
      executedCalls.map((call) => call.name),
      ["create_design_canvas"],
      prompt,
    );
  }
});

test("explicit web and citation prompts expose web_search and web_fetch", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "Vietnam War scholarship" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/vietnam" }),
      () => responseWithContent("Research answer with https://example.com/vietnam"),
    ],
  });

  await runAgentMission({
    prompt: "Search the web and give me source URLs on recent Vietnam War scholarship.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("web_search"));
  assert.ok(toolNames.includes("web_fetch"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
});

test("current-note summary prompts expose read and append tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "Summary" }),
    ],
  });

  await runAgentMission({
    prompt: "Summarize this note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  assert.deepEqual(chatRequests[0].tools?.map((tool) => tool.function.name), [
    "read_current_file",
    "append_to_current_file",
  ]);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "append_to_current_file"],
  );
});

test("append-only prompts expose append_to_current_file without reading target-only note content", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "## Actions" }),
    ],
  });

  await runAgentMission({
    prompt: "Append 5 action items to this note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  assert.deepEqual(
    chatRequests[0].tools?.map((tool) => tool.function.name),
    ["append_to_current_file"],
  );
});

test("page and document write targets expose append_to_current_file", async () => {
  const scenarios = [
    "Can you write this short update onto the page?",
    "Copy this summary into the document.",
  ];

  for (const prompt of scenarios) {
    const chatRequests: ModelChatRequest[] = [];
    const executedCalls: ModelToolCall[] = [];
    const client = createClient({
      chatRequests,
      chatResponders: [
        () =>
          responseWithToolCall("append_to_current_file", {
            text: `Content for ${prompt}`,
          }),
      ],
    });

    await runAgentMission({
      prompt,
      modelClient: client,
      toolRegistry: createRegistry(executedCalls),
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
    });

    const toolNames =
      chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
    assert.ok(toolNames.includes("append_to_current_file"), prompt);
    assert.deepEqual(
      executedCalls.map((call) => call.name),
      ["append_to_current_file"],
    );
  }
});

test("prior assistant essay follow-up requires current-note append", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const priorEssay =
    "The Mexican-American War reshaped borders and politics in North America.";

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          "You can copy the text from my previous response and paste it directly.",
        ),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: priorEssay,
        }),
    ],
  });

  await runAgentMission({
    prompt: "Can you write this essay onto the page?",
    conversationHistory: [
      {
        role: "assistant",
        content: priorEssay,
      },
    ],
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.equal(chatRequests[0].tools?.some((tool) => tool.function.name === "append_to_current_file"), true);
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /Append the most recent assistant response/.test(message.content),
    ),
  );
  assert.ok(
    chatRequests[0].messages.some((message) => message.content.includes(priorEssay)),
  );
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: append_to_current_file/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["append_to_current_file"],
  );
  assert.deepEqual(deltas, ["Done. append Current.md."]);
  assert.ok(statuses.includes("Write required; asking model to use a write tool..."));
});

test("vault placement prompts expose markdown file listing", async () => {
  const chatRequests: ModelChatRequest[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Placement suggestion")],
  });

  await runAgentMission({
    prompt: "Look at the markdown file names in this vault and suggest where this note belongs.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("list_markdown_files"));
});

test("what do you know about me prompts expose read-only vault traversal tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I can answer from general context."),
      () => responseWithToolCall("list_markdown_files", {}),
      () => responseWithContent("I found notes about you in the vault."),
    ],
  });

  await runAgentMission({
    prompt: "What do you know about me?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  for (const toolName of [
    "read_current_file",
    "list_current_folder",
    "list_markdown_files",
    "search_markdown_files",
    "read_markdown_files",
    "read_file",
    "list_folder",
    "get_path_info",
  ]) {
    assert.ok(toolNames.includes(toolName), toolName);
  }

  for (const toolName of [
    "append_to_current_file",
    "replace_current_file",
    "delete_current_file",
    "append_file",
    "replace_file",
    "delete_path",
  ]) {
    assert.ok(!toolNames.includes(toolName), toolName);
  }

  assert.equal(chatRequests.length, 3);
  assert.equal(chatRequests[1].toolChoice, "required");
  assert.equal(chatRequests[1].think, false);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["list_markdown_files"],
  );
  assert.deepEqual(deltas, ["I found notes about you in the vault."]);
  assert.ok(
    statuses.some((message) =>
      /Executable frontier still requires .*asking the model for a tool-only correction/.test(
        message,
      ),
    ),
  );
  assert.ok(!statuses.includes("Write required; asking model to use a write tool..."));
});

test("other-folder content prompts prefetch vault context before final answer", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          "People/Untitled.md says Alex likes local AI tools. Projects/Untitled.md says Alex is building an Obsidian research agent. Archive/Untitled.md says Alex prefers traceable agent actions.",
        ),
    ],
  });

  await runAgentMission({
    prompt: "What do the other notes in the other folders say?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].tools, undefined);
  assert.equal(chatRequests[0].think, undefined);
  assert.match(
    chatRequests[0].messages.map((message) => message.content).join("\n"),
    /Prefetched vault context/i,
  );
  assert.ok(
    statuses.includes(
      "Inspecting vault context locally...",
    ),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["inspect_vault_context"],
  );
  assert.match(deltas.join(""), /People\/Untitled\.md/);
  assert.ok(!deltas.join("").includes("cannot access"));
});

test("gather-details folder prompts are classified as vault context answers", async () => {
  const configs: AgentRunConfigEvent[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          "People/Untitled.md says Alex likes local AI tools.",
        ),
    ],
  });

  await runAgentMission({
    prompt:
      "On this note, I want you to gather details from the other folders and report back to me what they say.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].missionMode, "vault_context_answer");
  assert.equal(configs[0].contextScope, "vault");
  assert.equal(configs[0].vaultContext, true);
  assert.equal(configs[0].currentNoteContext, false);
  assert.equal(configs[0].route, "prefetched_vault_answer");
  assert.equal(configs[0].slowPathReason, "needs_vault_context");
  assert.deepEqual(configs[0].allowedToolNames, []);
  assert.ok(configs[0].routeTraceReasons.includes("prefetchable_vault_folder_answer"));
  assert.equal(
    chatRequests[0].tools,
    undefined,
  );
  assert.equal(chatRequests[0].think, undefined);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["inspect_vault_context"],
  );
});

test("vault traversal fallback stops after one non-tool correction", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const completions: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I cannot access the vault."),
      () => responseWithContent("I still cannot access the vault."),
    ],
  });

  await runAgentMission({
    prompt: "What do the other notes in the other folders say?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls, {
      inspectVaultError: "mock prefetch failure",
    }),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.ok(
    statuses.includes(
      "Vault traversal required; asking model to inspect folders and notes before answering...",
    ),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["inspect_vault_context"],
  );
  assert.match(deltas.join(""), /could not get the model to request vault tools/i);
  assert.deepEqual(completions, ["error"]);
});

test("model planning errors complete as resumable error stops", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const completions: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => {
        throw new Error("mock model transport failure");
      },
    ],
  });

  await runAgentMission({
    prompt: "Answer a simple question.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.deepEqual(completions, ["error"]);
  assert.ok(
    statuses.includes("Model step failed: mock model transport failure"),
  );
  assert.match(deltas.join(""), /Model step failed: mock model transport failure/);
  assert.match(deltas.join(""), /run "continue run run-/);
});

test("graph connection questions expose read-only graph tools", async () => {
  const chatRequests: ModelChatRequest[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("These notes are related.")],
  });

  await runAgentMission({
    prompt: "Are my current note and related notes connected in the Obsidian graph?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  for (const toolName of [
    "get_note_graph_context",
    "find_related_notes",
    "suggest_note_links",
  ]) {
    assert.ok(toolNames.includes(toolName), toolName);
  }
  assert.ok(!toolNames.includes("link_related_notes_in_current_file"));
});

test("connect-note prompts expose inline graph link writing", async () => {
  const chatRequests: ModelChatRequest[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("link_related_notes_in_current_file", {}),
    ],
  });

  await runAgentMission({
    prompt: "Connect this note to related notes with inline wiki links.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("get_note_graph_context"));
  assert.ok(toolNames.includes("find_related_notes"));
  assert.ok(toolNames.includes("suggest_note_links"));
  assert.ok(toolNames.includes("link_related_notes_in_current_file"));
});

test("word count prompts expose count_words without write tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("The note has 12 words."),
      () => responseWithToolCall("count_words", {}),
      () => responseWithContent("The note has 12 words."),
    ],
  });

  await runAgentMission({
    prompt: "Count the words in the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(
    toolNames.includes("count_words"),
    JSON.stringify(chatRequests.map((request) => request.tools?.map((tool) => tool.function.name) ?? [])),
  );
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.deepEqual(executedCalls.map((call) => call.name), ["count_words"]);
});

test("streaming-mode word count stays read-only and accepts a concise numeric answer", async () => {
  const prompt = "Use the count_words tool to count the words in the current note.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note content",
  });
  vault.context.settings = createRunnerSettings({
    streamWritebackMode: "all_current_note_content_writes",
  });
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("count_words", {}),
      () => responseWithContent("3"),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(
    toolNames.includes("count_words"),
    JSON.stringify(
      chatRequests.map(
        (request) => request.tools?.map((tool) => tool.function.name) ?? [],
      ),
    ),
  );
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(executedCalls.map((call) => call.name), ["count_words"]);
  assert.equal(vault.content.get("Current.md"), "Initial note content");
  assert.equal(deltas.join(""), "3");
});

test("chat-only note write negation does not require append receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("2+2 equals 4. No note write was needed."),
    ],
  });

  await runAgentMission({
    prompt:
      "What is 2+2? Answer in chat only; do not write to the note and do not use tools.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.deepEqual(executedCalls, []);
  assert.deepEqual(deltas, ["2+2 equals 4. No note write was needed."]);
});

test("what did you learn about me can traverse untitled notes before answering", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("list_markdown_files", {}),
      () =>
        responseWithToolCall("read_markdown_files", {
          paths: [
            "People/Untitled.md",
            "Projects/Untitled.md",
            "Archive/Untitled.md",
          ],
        }),
      () =>
        responseWithContent(
          "You like local AI tools (People/Untitled.md), are building an Obsidian research agent (Projects/Untitled.md), and prefer traceable actions (Archive/Untitled.md).",
        ),
    ],
  });

  await runAgentMission({
    prompt: "What did you learn about me?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["list_markdown_files", "read_markdown_files"],
  );
  assert.match(deltas.join(""), /People\/Untitled\.md/);
  assert.match(deltas.join(""), /Projects\/Untitled\.md/);
  assert.match(deltas.join(""), /Archive\/Untitled\.md/);
});

test("vault context search prompts expose search and batch read tools", async () => {
  const chatRequests: ModelChatRequest[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("search_markdown_files", { query: "MCP" }),
      () => responseWithContent("MCP appears in your notes."),
    ],
  });

  await runAgentMission({
    prompt: "What do my notes say about MCP?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("search_markdown_files"));
  assert.ok(toolNames.includes("inspect_semantic_index"));
  assert.ok(toolNames.includes("semantic_search_notes"));
  assert.ok(toolNames.includes("read_markdown_files"));
  assert.ok(!toolNames.includes("append_to_current_file"));
});

test("parallel vault plan reads remain callable by the model", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("The bounded parallel inspection is not complete yet."),
    ],
  });

  await runAgentMission({
    prompt:
      "Inspect the current note with parallel vault reads, then append the verified marker to this note.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    maxSteps: 1,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("semantic_search_notes"));
  assert.ok(toolNames.includes("read_markdown_files"));
  assert.ok(toolNames.includes("append_to_current_file"));
});

test("conceptual vault prompts expose semantic search as a read tool", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("semantic_search_notes", {
          query: "ritual kingship themes",
        }),
      () =>
        responseWithContent(
          "People/Untitled.md is related to ritual kingship themes.",
        ),
    ],
  });

  await runAgentMission({
    prompt: "What do my notes say about ritual kingship themes?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("inspect_semantic_index"));
  assert.ok(toolNames.includes("semantic_search_notes"));
  assert.ok(toolNames.includes("search_markdown_files"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["semantic_search_notes"],
  );
});

test("explicit semantic retrieval uses the exact semantic then batch-read frontier", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const graphs: Array<{ nodes: Record<string, { allowedTools: string[] }> }> = [];
  const prompt =
    "Use semantic retrieval, batch-read only returned note paths, then append a grounded synthesis to the current note.";
  const { context } = createRunnerVaultContext({ prompt });
  context.semanticEmbeddingProvider = createReflexSemanticEmbeddingProvider();
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("semantic_search_notes", {
          query: "owned semantic anchor",
          mode: "deep",
        }),
      () =>
        responseWithToolCall("read_markdown_files", {
          paths: ["People/Untitled.md"],
        }),
      // A live model may ignore the exposed frontier and invent a narrower
      // single-file retry. The host must reject it without growing the graph.
      () =>
        responseWithToolCall("read_file", {
          path: "People/Untitled.md",
        }),
    ],
    streamResponders: [
      () =>
        responseWithContent(
          "## Semantic retrieval synthesis\n\nThe semantic retrieval and batch read show that local AI tools support the requested grounded synthesis in `People/Untitled.md`.",
        ),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: context,
    enableStreaming: false,
    maxSteps: 3,
    events: {
      onMissionGraphUpdate: (graph) => graphs.push(graph),
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const agentRequests = chatRequests.filter(
    (request) => request.evidencePhase === "agent_step",
  );

  assert.deepEqual(
    agentRequests[0]?.tools?.map((tool) => tool.function.name) ?? [],
    ["semantic_search_notes"],
  );
  assert.deepEqual(
    agentRequests[1]?.tools?.map((tool) => tool.function.name) ?? [],
    ["read_markdown_files"],
  );
  assert.deepEqual(
    agentRequests[2]?.tools?.map((tool) => tool.function.name) ?? [],
    ["append_to_current_file"],
  );
  assert.deepEqual(
    executedCalls
      .map((call) => call.name)
      .filter((name) => name !== "read_current_file"),
    ["semantic_search_notes", "read_markdown_files"],
  );
  assert.equal(
    Object.entries(graphs.at(-1)?.nodes ?? {}).some(
      ([id, node]) => id.startsWith("retry-") && node.allowedTools.includes("read_file"),
    ),
    false,
  );
  assert.equal(receipts.filter((receipt) => receipt.operation === "append").length, 1);
});

test("direct mutation prompts withhold semantic search", async () => {
  const chatRequests: ModelChatRequest[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("replace_current_file", {
          text: "# Replacement\n\nRitual kingship summary.",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Replace the current note with a ritual kingship summary.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(!toolNames.includes("inspect_semantic_index"));
  assert.ok(!toolNames.includes("semantic_search_notes"));
});

test("semantic index maintenance prompts expose rebuild tool only on request", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("rebuild_semantic_index", {}),
      () => responseWithContent("Semantic index rebuilt."),
    ],
  });

  await runAgentMission({
    prompt: "Rebuild the semantic vault index.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("rebuild_semantic_index"));
  assert.ok(!toolNames.includes("inspect_semantic_index"));
  assert.ok(!toolNames.includes("semantic_search_notes"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["rebuild_semantic_index"],
  );
});

test("agentic reflex can upgrade ambiguous prompts to semantic vault routing", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Reflex routed answer.")],
  });
  const { context } = createRunnerVaultContext({
    prompt: "Surface ritual kingship implications.",
  });
  context.settings = createRunnerSettings({
    agenticReflexEnabled: true,
  });
  context.semanticEmbeddingProvider = createReflexSemanticEmbeddingProvider();

  await runAgentMission({
    prompt: "Surface ritual kingship implications.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: context,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(
    toolNames.includes("semantic_search_notes"),
    JSON.stringify(
      chatRequests.map(
        (request) => request.tools?.map((tool) => tool.function.name) ?? [],
      ),
    ),
  );
  assert.ok(toolNames.includes("search_markdown_files"));
  assert.equal(configs.at(-1)?.reflexLabel, "semantic_vault_search");
});

test("agentic reflex cannot expose semantic tools for explicit mutation prompts", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("replace_current_file", {
          text: "# Replacement\n\nRitual kingship summary.",
        }),
    ],
  });
  const { context } = createRunnerVaultContext({
    prompt: "Replace the current note with a ritual kingship summary.",
  });
  context.settings = createRunnerSettings({
    agenticReflexEnabled: true,
  });
  context.semanticEmbeddingProvider = createReflexSemanticEmbeddingProvider();

  await runAgentMission({
    prompt: "Replace the current note with a ritual kingship summary.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: context,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("replace_current_file"));
  assert.ok(!toolNames.includes("semantic_search_notes"));
  assert.ok(!toolNames.includes("inspect_semantic_index"));
});

test("saving a vault-context answer enables agent-selected current-note writeback", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "## What I know\n- You like local AI tools.",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Save what you know about me into the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "append_to_current_file"],
  );
  assert.deepEqual(receipts, ["append Current.md"]);
});

test("path update prompts enable path write tools and require completion", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_file", {
          path: "People/Profile.md",
          text: "## Learned\n- Prefers traceable AI actions.",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Update the note in People/Profile.md with what you learned.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("append_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(executedCalls.map((call) => call.name), ["append_file"]);
  assert.deepEqual(receipts, ["append People/Profile.md"]);
});

test("delete path prompts expose delete_path and emit a trash receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("delete_path", { path: "Projects/Old.md" }),
    ],
  });

  await runAgentMission({
    prompt: "Delete Projects/Old.md.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("delete_path"));
  assert.ok(!toolNames.includes("append_file"));
  assert.ok(!toolNames.includes("replace_file"));
  assert.deepEqual(executedCalls.map((call) => call.name), ["delete_path"]);
  assert.deepEqual(receipts, ["trash Projects/Old.md; affected: 1"]);
});

test("workspace creation frontier exposes its exact graph-bound path", () => {
  const binding = buildObservedMissionGraphFrontierBinding(
    [],
    [
      {
        type: "function",
        function: {
          name: "code_workspace_create_file",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    [],
    "checkers/game.py",
  );
  assert.match(binding ?? "", /EXACT GRAPH-BOUND NEW WORKSPACE FILE/u);
  assert.match(binding ?? "", /path="checkers\/game\.py"/u);
  assert.match(binding ?? "", /complete content string for only this file/u);
});

test("bare Python entry-point frontier requires one self-contained runnable file", () => {
  const binding = buildObservedMissionGraphFrontierBinding(
    [],
    [
      {
        type: "function",
        function: {
          name: "code_workspace_create_file",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    [],
    "main.py",
    null,
    null,
    [],
    "write a number guessing game in Python on my desktop",
  );
  assert.match(binding ?? "", /one Python source file/u);
  assert.match(binding ?? "", /directly runnable and self-contained/u);
  assert.match(binding ?? "", /do not import a local module or package/iu);
});

test("workspace correction frontiers bind exact reads, hashes, content, and Linear traceability", () => {
  const readTool = [{
    type: "function" as const,
    function: {
      name: "code_workspace_read",
      parameters: { type: "object", properties: {} },
    },
  }];
  assert.match(
    buildObservedMissionGraphFrontierBinding(
      [],
      readTool,
      [],
      "scripts/verify_project.py",
    ) ?? "",
    /EXACT GRAPH-BOUND WORKSPACE READ/u,
  );

  const sha256 = `sha256:${"a".repeat(64)}`;
  const messages = [
    {
      role: "tool" as const,
      toolName: "code_validate_fast",
      content: JSON.stringify({
        status: "success",
        output: {
          status: "failed",
          validationDiagnosticExcerpt: {
            trust: "untrusted_sandbox_output",
            stdout: "test/math.test.mjs must import node:test",
            stderr: "Assertion failed in the protected verifier",
          },
        },
      }),
    },
    {
      role: "tool" as const,
      toolName: "linear_get_issue",
      content: JSON.stringify({
        ok: true,
        output: {
          data: {
            issue: {
              id: "issue-id",
              identifier: "APP-42",
              title: "Build checkers",
              url: "https://linear.app/example/issue/APP-42",
            },
          },
        },
      }),
    },
    {
      role: "tool" as const,
      toolName: "code_workspace_read",
      content: JSON.stringify({
        ok: true,
        output: {
          path: "README.md",
          sha256,
          content: "# Checkers\n",
        },
      }),
    },
  ];
  const binding = buildObservedMissionGraphFrontierBinding(
    messages,
    [{
      type: "function",
      function: {
        name: "code_workspace_write_expected",
        parameters: { type: "object", properties: {} },
      },
    }],
    [],
    "README.md",
    null,
    null,
    [],
    "Create src/math.ts and test/math.test.mjs; the test must use node:test.",
  );
  assert.match(binding ?? "", /EXACT GRAPH-BOUND HASHED WORKSPACE CORRECTION/u);
  assert.match(binding ?? "", new RegExp(sha256));
  assert.match(binding ?? "", /currentContent="# Checkers\\n"/u);
  assert.match(binding ?? "", /APP-42/u);
  assert.match(binding ?? "", /linear\.app\/example\/issue\/APP-42/u);
  assert.match(binding ?? "", /LATEST REDACTED UNTRUSTED FAST-VALIDATION DIAGNOSTIC/u);
  assert.match(binding ?? "", /test\/math\.test\.mjs must import node:test/u);
  assert.match(binding ?? "", /ORIGINAL USER MISSION REQUIREMENTS/u);
  assert.match(binding ?? "", /the test must use node:test/u);
  assert.match(
    binding ?? "",
    /If a self-authored test conflicts with those authorities, correct the test instead/u,
  );
  assert.match(binding ?? "", /Never weaken or rewrite a protected control file/u);
  assert.match(binding ?? "", /AUTHORITATIVE CURRENT TARGET "README\.md"/u);
  assert.match(binding ?? "", /A module must never import itself/u);
  assert.match(binding ?? "", /preserve the current content byte-for-byte/u);
  assert.ok(
    (binding ?? "").lastIndexOf('currentContent="# Checkers\\n"') >
      (binding ?? "").indexOf("BOUNDED UNTRUSTED SUPPORTING READ CONTEXT"),
  );
});

test("workspace correction preserves the verified read binding after transcript compaction", () => {
  const sha256 = `sha256:${"b".repeat(64)}`;
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  rememberVerifiedWorkspaceReadResult(
    runtimeCache,
    {
      name: "code_workspace_read",
      arguments: { workspaceId: "Checkers Workspace", path: "checkers/game.py" },
    },
    { rootMissionId: "ignored-root" },
    {
      ok: true,
      toolName: "code_workspace_read",
      output: {
        path: "checkers/game.py",
        sha256,
        content: "def legal_moves():\n    return []\n",
      },
    },
  );
  const observation = getVerifiedWorkspaceReadObservation(
    runtimeCache,
    "checkers/game.py",
  );
  assert.ok(observation);
  assert.equal(observation.workspaceId, "checkers-workspace");
  const supportingObservation = {
    workspaceId: "checkers-workspace",
    path: "scripts/verify_project.py",
    sha256: `sha256:${"d".repeat(64)}`,
    content: "assert CheckersGame.initial()\n",
  };
  const rejectedLargeSibling = {
    workspaceId: "checkers-workspace",
    path: "checkers/generated_large.py",
    sha256: `sha256:${"e".repeat(64)}`,
    content: "x".repeat(39_990),
  };
  const laterSmallSibling = {
    workspaceId: "checkers-workspace",
    path: "checkers/cli.py",
    sha256: `sha256:${"f".repeat(64)}`,
    content: "def main():\n    return 0\n",
  };

  const frontier = buildObservedMissionGraphFrontierBinding(
    [],
    [{
      type: "function",
      function: {
        name: "code_workspace_write_expected",
        parameters: { type: "object", properties: {} },
      },
    }],
    [],
    "checkers/game.py",
    null,
    observation,
    [supportingObservation, rejectedLargeSibling, laterSmallSibling],
  );
  assert.match(frontier ?? "", new RegExp(sha256));
  assert.match(frontier ?? "", /currentContent="def legal_moves\(\):\\n    return \[\]\\n"/u);
  assert.match(frontier ?? "", /scripts\/verify_project\.py/u);
  assert.match(frontier ?? "", /assert CheckersGame\.initial\(\)/u);
  assert.doesNotMatch(frontier ?? "", /checkers\/generated_large\.py/u);
  assert.match(frontier ?? "", /checkers\/cli\.py/u);
  assert.match(frontier ?? "", /def main/u);
  assert.match(frontier ?? "", /UNTRUSTED SUPPORTING READ CONTEXT/u);

  const bound = bindVerifiedWorkspaceWriteExpected(
    {
      name: "code_workspace_write_expected",
      arguments: {
        path: "model/alias.py",
        content: "def legal_moves():\n    return [\"forced\"]\n",
        expectedSha256: `sha256:${"c".repeat(64)}`,
      },
    },
    "checkers/game.py",
    observation,
  );
  assert.deepEqual(bound?.arguments, {
    workspaceId: "checkers-workspace",
    path: "checkers/game.py",
    content: "def legal_moves():\n    return [\"forced\"]\n",
    expectedSha256: sha256,
  });
});

test("workspace correction preserves the redacted fast diagnostic after transcript compaction", () => {
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  rememberLatestFastValidationDiagnostic(
    runtimeCache,
    "code_validate_fast",
    {
      ok: true,
      toolName: "code_validate_fast",
      output: {
        status: "failed",
        validationDiagnosticExcerpt: {
          version: 1,
          stdout: "protected checkers contract failed at mandatory capture",
          stderr: "AssertionError: capture.legal_moves() omitted the forced jump",
          truncated: false,
          redactedLines: 1,
        },
      },
    },
  );
  const diagnostic = getLatestFastValidationDiagnostic(runtimeCache);
  assert.deepEqual(diagnostic, {
    stdout: "protected checkers contract failed at mandatory capture",
    stderr: "AssertionError: capture.legal_moves() omitted the forced jump",
    truncated: false,
    redactedLines: 1,
  });
  const binding = buildObservedMissionGraphFrontierBinding(
    [],
    [{
      type: "function",
      function: {
        name: "code_workspace_write_expected",
        parameters: { type: "object", properties: {} },
      },
    }],
    [],
    "checkers/game.py",
    null,
    {
      workspaceId: "du06-workspace",
      path: "checkers/game.py",
      sha256: `sha256:${"a".repeat(64)}`,
      content: "class CheckersGame:\n    pass\n",
    },
    [],
    "Implement mandatory captures for American checkers.",
    diagnostic,
  );
  assert.match(binding ?? "", /LATEST REDACTED UNTRUSTED FAST-VALIDATION DIAGNOSTIC/u);
  assert.match(binding ?? "", /mandatory capture/u);
  assert.match(binding ?? "", /omitted the forced jump/u);

  rememberLatestFastValidationDiagnostic(
    runtimeCache,
    "code_validate_fast",
    {
      ok: true,
      toolName: "code_validate_fast",
      output: { status: "verified" },
    },
  );
  assert.equal(getLatestFastValidationDiagnostic(runtimeCache), null);
});

test("workspace correction retains red diagnostics from targeted and full validation", () => {
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  rememberLatestFastValidationDiagnostic(
    runtimeCache,
    "code_validate_targeted",
    {
      ok: true,
      toolName: "code_validate_targeted",
      output: {
        status: "failed",
        validationDiagnosticExcerpt: {
          stdout: "",
          stderr: "README.md must include the accepted proof marker",
          truncated: false,
          redactedLines: 0,
        },
      },
    },
  );
  assert.deepEqual(getLatestFastValidationDiagnostic(runtimeCache), {
    stdout: "",
    stderr: "README.md must include the accepted proof marker",
    truncated: false,
    redactedLines: 0,
  });

  rememberLatestFastValidationDiagnostic(runtimeCache, "code_validate_full", {
    ok: true,
    toolName: "code_validate_full",
    output: { status: "verified" },
  });
  assert.equal(
    getLatestFastValidationDiagnostic(runtimeCache),
    null,
    "a newer green full validation clears the older targeted failure",
  );
});

test("workspace correction surfaces the bounded protected assertion around a traceback line", () => {
  const verifier = [
    "from checkers.game import CheckersGame",
    "",
    ...Array.from({ length: 18 }, (_, index) => `# contract ${index + 1}`),
    "assert all(",
    "    piece is None or (row_index + column_index) % 2 == 1",
    "    for row_index, row in enumerate(CheckersGame.initial().board)",
    "    for column_index, piece in enumerate(row)",
    ")",
  ].join("\n");
  const supporting = [{
    workspaceId: "du03-workspace",
    path: "scripts/verify_project.py",
    sha256: `sha256:${"d".repeat(64)}`,
    content: verifier,
  }];
  const diagnostic = {
    stdout: "",
    stderr: [
      "Traceback (most recent call last):",
      '  File "/workspace/scripts/verify_project.py", line 21, in <module>',
      "    assert all(",
      "AssertionError",
    ].join("\n"),
    truncated: false,
    redactedLines: 0,
  };
  const excerpt = buildValidatorFailureSourceContext(
    diagnostic.stdout,
    diagnostic.stderr,
    supporting,
  );
  assert.match(excerpt, /scripts\/verify_project\.py/u);
  assert.match(excerpt, /failingLine=21/u);
  assert.match(excerpt, /21\|assert all\(/u);
  assert.match(excerpt, /row_index \+ column_index/u);

  const binding = buildObservedMissionGraphFrontierBinding(
    [],
    [{
      type: "function",
      function: {
        name: "code_workspace_write_expected",
        parameters: { type: "object", properties: {} },
      },
    }],
    [],
    "checkers/game.py",
    null,
    {
      workspaceId: "du03-workspace",
      path: "checkers/game.py",
      sha256: `sha256:${"a".repeat(64)}`,
      content: "class CheckersGame:\n    pass\n",
    },
    supporting,
    "Place pieces on playable dark squares.",
    diagnostic,
  );
  assert.match(binding ?? "", /BOUNDED UNTRUSTED FAILING VALIDATOR SOURCE CONTEXT/u);
  assert.match(binding ?? "", /row_index \+ column_index/u);
});

test("workspace correction preserves both ends of a bounded fast-validation diagnostic", () => {
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  rememberLatestFastValidationDiagnostic(
    runtimeCache,
    "code_validate_fast",
    {
      ok: true,
      toolName: "code_validate_fast",
      output: {
        status: "failed",
        validationDiagnosticExcerpt: {
          version: 1,
          stdout: "",
          stderr: `FIRST_ASSERTION\n${"x".repeat(8_000)}\nFINAL_TRACEBACK`,
          truncated: false,
          redactedLines: 0,
        },
      },
    },
  );
  const diagnostic = getLatestFastValidationDiagnostic(runtimeCache);
  assert.ok(diagnostic);
  assert.equal(diagnostic.truncated, true);
  assert.ok(diagnostic.stderr.length <= 6_000);
  assert.match(diagnostic.stderr, /FIRST_ASSERTION/u);
  assert.match(diagnostic.stderr, /bounded diagnostic middle omitted/u);
  assert.match(diagnostic.stderr, /FINAL_TRACEBACK/u);
});

test("durable continuation restores the latest verified fast-validation diagnostic", () => {
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  const canonical = {
    version: 1 as const,
    toolName: "code_validate_fast",
    actionId: "validate-fast-action",
    payloadFingerprint: `sha256:${"a".repeat(64)}`,
    grantId: "validate-fast-grant",
    commitKind: "committed" as const,
    readback: {
      status: "verified" as const,
      checkedAt: "2026-07-19T08:00:00.000Z",
    },
  };
  restoreLatestFastValidationDiagnosticFromReceipts(runtimeCache, [
    {
      ...canonical,
      output: {
        status: "failed",
        validationDiagnosticExcerpt: {
          stdout: "",
          stderr: "ImportError: cannot import name 'main' from 'checkers.cli'",
          truncated: false,
          redactedLines: 0,
        },
      },
    },
  ]);

  assert.deepEqual(getLatestFastValidationDiagnostic(runtimeCache), {
    stdout: "",
    stderr: "ImportError: cannot import name 'main' from 'checkers.cli'",
    truncated: false,
    redactedLines: 0,
  });
});

test("durable continuation does not revive an older validation failure", () => {
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  const canonical = {
    version: 1 as const,
    toolName: "code_validate_fast",
    actionId: "validate-fast-action",
    payloadFingerprint: `sha256:${"b".repeat(64)}`,
    grantId: "validate-fast-grant",
    commitKind: "reconciled" as const,
    readback: {
      status: "verified" as const,
      checkedAt: "2026-07-19T08:05:00.000Z",
    },
  };
  restoreLatestFastValidationDiagnosticFromReceipts(runtimeCache, [
    {
      ...canonical,
      output: {
        status: "failed",
        validationDiagnosticExcerpt: {
          stdout: "old failure",
          stderr: "",
        },
      },
    },
    {
      ...canonical,
      actionId: "validate-fast-action-2",
      output: { status: "verified" },
    },
  ]);

  assert.equal(getLatestFastValidationDiagnostic(runtimeCache), null);
});

test("durable continuation restores targeted/full validation diagnostics chronologically", () => {
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  const canonical = {
    version: 1 as const,
    actionId: "validate-targeted-action",
    payloadFingerprint: `sha256:${"e".repeat(64)}`,
    grantId: "validate-targeted-grant",
    commitKind: "committed" as const,
    readback: {
      status: "verified" as const,
      checkedAt: "2026-07-28T00:00:00.000Z",
    },
  };
  restoreLatestFastValidationDiagnosticFromReceipts(runtimeCache, [
    {
      ...canonical,
      toolName: "code_validate_targeted",
      output: {
        status: "failed",
        validationDiagnosticExcerpt: {
          stdout: "",
          stderr: "AssertionError: crdt_sync.py did not converge",
          truncated: false,
          redactedLines: 0,
        },
      },
    },
  ]);
  assert.deepEqual(getLatestFastValidationDiagnostic(runtimeCache), {
    stdout: "",
    stderr: "AssertionError: crdt_sync.py did not converge",
    truncated: false,
    redactedLines: 0,
  });

  restoreLatestFastValidationDiagnosticFromReceipts(runtimeCache, [
    {
      ...canonical,
      toolName: "code_validate_full",
      actionId: "validate-full-action",
      output: { status: "verified" },
    },
  ]);
  assert.equal(getLatestFastValidationDiagnostic(runtimeCache), null);
});

test("durable continuation ignores non-canonical validation evidence", () => {
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  restoreLatestFastValidationDiagnosticFromReceipts(runtimeCache, [
    {
      toolName: "code_validate_fast",
      output: {
        status: "failed",
        validationDiagnosticExcerpt: {
          stdout: "unverified failure",
          stderr: "",
        },
      },
    },
  ]);

  assert.equal(getLatestFastValidationDiagnostic(runtimeCache), null);
});

test("durable continuation restores the commit gate only from a passed repair-cycle receipt", () => {
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  restorePassedFastRepairCycleFromReceipts(runtimeCache, [
    {
      toolName: "code_validate_fast",
      output: {
        status: "complete",
        validationReceipt: { status: "passed" },
      },
    },
    {
      toolName: "code_validate_targeted",
      output: { status: "complete" },
    },
  ]);
  assert.equal(runtimeCache.passedFastRepairCycle, undefined);

  restorePassedFastRepairCycleFromReceipts(runtimeCache, [
    {
      toolName: "code_repair_record_cycle",
      output: { outcome: "passed" },
    },
  ]);
  assert.equal(runtimeCache.passedFastRepairCycle, true);
});

test("prepared fast validation preserves its redacted diagnostic for bounded repair", async () => {
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  const preparedAction = {
    toolName: "code_validate_fast",
    normalizedArgs: {},
    target: { path: "validation" },
  } as unknown as PreparedAction;
  const authorization = {
    preparedActionId: "prepared-fast-validation",
    payloadFingerprint: `sha256:${"a".repeat(64)}`,
    grantId: "grant-fast-validation",
  } satisfies AuthorizedActionContext;
  const registry: ToolRegistry = {
    getDefinitions: () => [],
    execute: async () => ({
      ok: false,
      toolName: "unused",
      error: { code: "unused", message: "unused" },
    }),
    executePrepared: async () => ({
      ok: true,
      toolName: "code_validate_fast",
      output: {
        status: "failed",
        validationDiagnosticExcerpt: {
          stdout: "protected contract failed",
          stderr: "AssertionError: mandatory capture missing",
          truncated: false,
          redactedLines: 1,
        },
      },
    }),
  };

  await executePreparedToolWithMetrics({
    toolRegistry: registry,
    preparedAction,
    authorization,
    toolContext: { runtimeCache } as ToolExecutionContext,
    events: {},
    step: 7,
  });

  assert.deepEqual(getLatestFastValidationDiagnostic(runtimeCache), {
    stdout: "protected contract failed",
    stderr: "AssertionError: mandatory capture missing",
    truncated: false,
    redactedLines: 1,
  });
});

test("prepared Bound execute envelope gate fails closed without silent retry", async () => {
  const {
    assertEnvelopeAllowsBoundExecute,
    consumeEnvelopeMutation,
    ensureMissionStageEnvelope,
    lifecycleStageForEnvelopeTool,
    MISSION_STAGE_ENVELOPE_BLOCKER_CODES,
  } = await import("../src/agent/missionStageEnvelope");

  assert.equal(
    lifecycleStageForEnvelopeTool("code_commit_verified"),
    "code_execution",
  );
  const fingerprint = `sha256:${"9".repeat(64)}`;
  let envelope = ensureMissionStageEnvelope({
    existing: null,
    runId: "run-envelope-bound",
    stage: "code_execution",
    authorityFingerprint: fingerprint,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    grantId: "grant-envelope",
    maxMutations: 1,
  });
  assert.equal(
    assertEnvelopeAllowsBoundExecute({
      envelope,
      toolName: "code_commit_verified",
      runId: "run-envelope-bound",
      authorityFingerprint: fingerprint,
    }).ok,
    true,
  );
  const consumed = consumeEnvelopeMutation(envelope);
  assert.equal("exhausted" in consumed, false);
  if ("exhausted" in consumed) return;
  envelope = consumed;
  const blocked = assertEnvelopeAllowsBoundExecute({
    envelope,
    toolName: "code_commit_verified",
    runId: "run-envelope-bound",
    authorityFingerprint: fingerprint,
  });
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(
    blocked.code,
    MISSION_STAGE_ENVELOPE_BLOCKER_CODES.budgetExhausted,
  );
  assert.match(blocked.message, /will not silently retry/i);
});

test("terminal mission graph blockers stop even before retry counters exhaust", () => {
  const node = {
    status: "blocked",
    blocker: {
      code: "tool_failure_terminal",
      message: "Host-classified terminal repair failure.",
      requiredAction: "Inspect the failure evidence before resuming.",
    },
    retries: {
      maxAttempts: 3,
      attempts: 1,
      failureFingerprints: [],
      consecutiveFailureFingerprint: null,
      consecutiveFailureCount: 0,
    },
  } satisfies Parameters<typeof isTerminalMissionGraphBlocker>[0];
  assert.equal(isTerminalMissionGraphBlocker(node), true);
  assert.equal(
    isTerminalMissionGraphBlocker({
      ...node,
      status: "ready",
    }),
    false,
  );
});

test("paid set-loose delivery stays resumable until graph and acceptance are terminal", () => {
  assert.equal(
    resolveEffectiveTerminalStopReasonV1({
      terminalProjectionsAgree: true,
      setLooseDeliveryUnpaid: false,
      stopReason: "write_completed",
      acceptanceStatus: "needs_more_work",
      graphComplete: false,
    }),
    "budget",
    "external delivery receipts must not bypass the authoritative final proof",
  );
  assert.equal(
    resolveEffectiveTerminalStopReasonV1({
      terminalProjectionsAgree: true,
      setLooseDeliveryUnpaid: false,
      stopReason: "write_completed",
      acceptanceStatus: "pass",
      graphComplete: true,
    }),
    "write_completed",
  );
});

test("terminal MissionGraph blockers finish even when Soft companions keep tools offered", () => {
  const blocked = {
    status: "blocked" as const,
    blocker: {
      code: "tool_failure_repeated" as const,
      message: "Validation completed red; a passing cycle is still required.",
      requiredAction: "Inspect the failure evidence before resuming.",
    },
    retries: {
      maxAttempts: 3,
      attempts: 3,
      failureFingerprints: [
        {
          fingerprint: "fp",
          count: 3,
          lastSeenAt: "2026-07-23T00:00:00.000Z",
        },
      ],
      consecutiveFailureFingerprint: "fp",
      consecutiveFailureCount: 3,
    },
    allowedTools: ["code_validate_targeted"],
  };
  const complete = {
    status: "complete" as const,
    blocker: null,
    retries: {
      maxAttempts: 3,
      attempts: 1,
      failureFingerprints: [],
      consecutiveFailureFingerprint: null,
      consecutiveFailureCount: 0,
    },
    allowedTools: ["code_validate_fast"],
  };
  const graphWithoutReady = {
    nodes: {
      "tool-targeted": blocked,
      "tool-fast": complete,
    },
  };
  assert.equal(isTerminalMissionGraphBlocker(blocked), true);
  assert.equal(hasReadyOrRunningMissionGraphUnpaidWork(graphWithoutReady), false);
  assert.equal(
    shouldFinishRunForTerminalMissionGraphBlockers(graphWithoutReady),
    true,
    "Soft companions must not hide a terminal blocker when no ready/running work remains",
  );

  const graphWithReady = {
    nodes: {
      "tool-targeted": blocked,
      "tool-repair": {
        ...complete,
        status: "ready" as const,
        allowedTools: ["code_repair_record_cycle"],
      },
    },
  };
  assert.equal(hasReadyOrRunningMissionGraphUnpaidWork(graphWithReady), true);
  assert.equal(
    shouldFinishRunForTerminalMissionGraphBlockers(graphWithReady),
    false,
    "ready unpaid MissionGraph work still takes priority over finishing",
  );

  const graphWithOptionalReady = {
    nodes: {
      "tool-targeted": blocked,
      "optional-retry-code_workspace_read": {
        ...complete,
        status: "ready" as const,
        allowedTools: ["code_workspace_read"],
      },
    },
  };
  assert.equal(
    hasReadyOrRunningMissionGraphUnpaidWork(graphWithOptionalReady),
    false,
  );
  assert.equal(
    shouldFinishRunForTerminalMissionGraphBlockers(graphWithOptionalReady),
    true,
    "optional retry work must not mask a required terminal blocker",
  );

  const graphWithOnlyOptionalBlocked = {
    nodes: {
      "optional-tool-code_validate_targeted": blocked,
    },
  };
  assert.equal(
    shouldFinishRunForTerminalMissionGraphBlockers(
      graphWithOnlyOptionalBlocked,
    ),
    false,
    "an optional blocked node is not a terminal mission blocker",
  );
});

test("unpaid code execution cannot bypass a required terminal validation blocker", () => {
  const terminalRetries = {
    maxAttempts: 3,
    attempts: 1,
    failureFingerprints: [],
    consecutiveFailureFingerprint: null,
    consecutiveFailureCount: 0,
  };
  const requiredRepairBlocker = {
    id: "action-019-code_repair_record_cycle",
    objective: "Record the required bounded repair cycle.",
    status: "blocked" as const,
    blocker: {
      code: "tool_failure_terminal" as const,
      message: "Fast validation remained red after the final repair cycle.",
      requiredAction: "Inspect the terminal validation evidence.",
    },
    retries: terminalRetries,
    allowedTools: ["code_repair_record_cycle"],
  };
  const graphWithIndependentReadyDelivery = {
    nodes: {
      "action-019-code_repair_record_cycle": requiredRepairBlocker,
      "action-020-github_create_private_repository": {
        id: "action-020-github_create_private_repository",
        objective: "Create the private delivery repository.",
        status: "ready" as const,
        blocker: null,
        retries: {
          ...terminalRetries,
          attempts: 0,
        },
        allowedTools: ["github_create_private_repository"],
      },
    },
  };

  assert.equal(
    hasUnpaidCodeExecutionTerminalValidationBlocker(
      graphWithIndependentReadyDelivery,
      ["code_execution", "private_github_publication"],
    ),
    true,
    "an offered GitHub companion cannot pay the terminally blocked code proof",
  );
  assert.equal(
    hasUnpaidCodeExecutionTerminalValidationBlocker(
      graphWithIndependentReadyDelivery,
      ["private_github_publication"],
    ),
    false,
    "independent Soft delivery remains legitimate after code_execution is paid",
  );
  assert.equal(
    hasUnpaidCodeExecutionTerminalValidationBlocker(
      {
        nodes: {
          "optional-repair-observation": {
            ...requiredRepairBlocker,
            id: "optional-repair-observation",
            objective: "Optional repair-state observation.",
          },
        },
      },
      ["code_execution"],
    ),
    false,
    "optional enrichment blockers do not terminate required delivery",
  );
  assert.equal(
    hasUnpaidCodeExecutionTerminalValidationBlocker(
      {
        nodes: {
          "required-linear-read": {
            ...requiredRepairBlocker,
            id: "required-linear-read",
            objective: "Read an unrelated Linear issue.",
            allowedTools: ["linear_get_issue"],
          },
        },
      },
      ["code_execution"],
    ),
    false,
    "an unrelated terminal blocker does not impersonate the code proof chain",
  );
});

test("red code_validate_fast advances the MissionGraph; red targeted/full do not", () => {
  const redFailed = {
    ok: true as const,
    output: { status: "failed" },
  };
  const redReceipt = {
    ok: true as const,
    output: {
      status: "verified",
      validationReceipt: { status: "failed" },
    },
  };

  assert.equal(
    resolveMissionGraphToolResultOk("code_validate_fast", redFailed).ok,
    true,
    "red fast must advance into code_repair_record_cycle",
  );
  assert.equal(
    resolveMissionGraphToolResultOk("code_validate_fast", redFailed)
      .validationStatusFailed,
    false,
  );

  assert.equal(
    resolveMissionGraphToolResultOk("code_validate_targeted", redFailed).ok,
    false,
  );
  assert.equal(
    resolveMissionGraphToolResultOk("code_validate_full", redReceipt).ok,
    false,
  );

  assert.equal(
    resolveMissionGraphToolResultOk("code_repair_record_cycle", {
      ok: true,
      output: { outcome: "repaired" },
    }).ok,
    true,
  );
  assert.equal(
    resolveMissionGraphToolResultOk("code_repair_record_cycle", {
      ok: true,
      output: { outcome: "blocked" },
    }).ok,
    false,
  );
});

test("tool outcome memory records semantic red validation and repair results as failures", () => {
  for (const toolName of [
    "code_validate_fast",
    "code_validate_targeted",
    "code_validate_full",
  ]) {
    assert.deepEqual(
      resolveToolOutcomeMemoryDispositionV1(toolName, {
        ok: true,
        output: { status: "failed" },
      }),
      { ok: false, errorCode: "validation_red" },
      `${toolName} red is not a successful outcome`,
    );
  }
  assert.deepEqual(
    resolveToolOutcomeMemoryDispositionV1("code_validate_targeted", {
      ok: true,
      output: {
        status: "verified",
        validationReceipt: { status: "failed" },
      },
    }),
    { ok: false, errorCode: "validation_red" },
  );
  for (const outcome of ["repaired", "blocked"]) {
    assert.deepEqual(
      resolveToolOutcomeMemoryDispositionV1("code_repair_record_cycle", {
        ok: true,
        output: { outcome },
      }),
      { ok: false, errorCode: "repair_still_red" },
      `${outcome} is not proof of a passing repair checkpoint`,
    );
  }
  assert.deepEqual(
    resolveToolOutcomeMemoryDispositionV1("code_repair_record_cycle", {
      ok: true,
      output: { outcome: "passed" },
    }),
    { ok: true, errorCode: undefined },
  );
  assert.deepEqual(
    resolveToolOutcomeMemoryDispositionV1("linear_get_issue", {
      ok: false,
      error: { code: "provider_timeout", message: "timed out" },
    }),
    { ok: false, errorCode: "provider_timeout" },
    "ordinary transport failures preserve their stable provider code",
  );
});

test("validation recovery accepts only read-back workspace receipts with a changed content hash", () => {
  const beforeSha256 = `sha256:${"a".repeat(64)}`;
  const afterSha256 = `sha256:${"b".repeat(64)}`;
  const receipt = {
    toolName: "code_workspace_write_expected",
    operation: "edit" as const,
    message: "Workspace write committed.",
    commitKind: "committed" as const,
    readback: {
      status: "verified" as const,
      checkedAt: "2026-07-27T00:00:00.000Z",
      observedRevision: afterSha256,
    },
    output: {
      status: "ok",
      receipt: {
        version: 2,
        beforeSha256,
        afterSha256,
      },
    },
  };
  assert.equal(receiptProvesWorkspaceContentChangeV1(receipt), true);
  assert.equal(
    receiptProvesWorkspaceContentChangeV1({
      ...receipt,
      output: {
        status: "ok",
        receipt: {
          version: 2,
          beforeSha256,
          afterSha256: beforeSha256,
        },
      },
      readback: {
        ...receipt.readback,
        observedRevision: beforeSha256,
      },
    }),
    false,
    "a byte-identical write receipt is not a correction",
  );
  assert.equal(
    receiptProvesWorkspaceContentChangeV1({
      ...receipt,
      readback: {
        ...receipt.readback,
        observedRevision: beforeSha256,
      },
    }),
    false,
    "the readback revision must match the changed content hash",
  );
  assert.equal(
    receiptProvesWorkspaceContentChangeV1({
      ...receipt,
      commitKind: undefined,
    }),
    false,
    "a noncanonical legacy receipt cannot unlock the recovery gate",
  );
});

test("validation recovery rejects an unrelated changed path and binds the selected path read then write", () => {
  const beforeSha256 = `sha256:${"a".repeat(64)}`;
  const afterSha256 = `sha256:${"b".repeat(64)}`;
  const diagnostic = {
    stdout: "",
    stderr:
      'File "tests/test_crdt_contract.py", line 12\nAssertionError: crdt_sync.py merge did not converge',
    truncated: false,
    redactedLines: 0,
  };
  const graph = {
    nodes: {
      implementation: {
        id: "implementation",
        status: "complete",
        allowedTools: ["code_workspace_create_file"],
        inputs: {
          lifecycle: {
            kind: "literal",
            value: {
              version: 1,
              composite: true,
              intentFingerprint: `sha256:${"c".repeat(64)}`,
              stage: "code_execution",
              actions: [
                {
                  id: "action-crdt",
                  toolName: "code_workspace_create_file",
                  effect: "mutation",
                  bindingId: "workspace-binding",
                  selector: "crdt_sync.py",
                  objective: "Create the public CRDT module.",
                  minimumEvidence: 1,
                  requiredEvidenceKinds: ["artifact_receipt"],
                  minimumReceipts: 1,
                  requiredReceiptKinds: ["code_change"],
                },
                {
                  id: "action-readme",
                  toolName: "code_workspace_create_file",
                  effect: "mutation",
                  bindingId: "workspace-binding",
                  selector: "README.md",
                  objective: "Create the public README.",
                  minimumEvidence: 1,
                  requiredEvidenceKinds: ["artifact_receipt"],
                  minimumReceipts: 1,
                  requiredReceiptKinds: ["code_change"],
                },
              ],
            },
          },
        },
        outputs: {},
      },
      fast: {
        id: "fast",
        status: "queued",
        allowedTools: ["code_validate_fast"],
        inputs: {},
        outputs: {},
      },
      repair: {
        id: "repair",
        status: "queued",
        allowedTools: ["code_repair_record_cycle"],
        inputs: {},
        outputs: {
          validationRecovery: {
            version: 1,
            status: "awaiting_correction",
            fastNodeId: "fast",
            repairNodeId: "repair",
          },
        },
      },
    },
  } as any;
  const changedReceipt = (path: string): AgentRunReceipt => ({
    toolName: "code_workspace_create_file",
    operation: "create",
    message: `Workspace create committed for ${path}.`,
    path,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-28T00:00:00.000Z",
      observedRevision: afterSha256,
    },
    output: {
      status: "ok",
      path,
      receipt: {
        version: 2,
        path,
        beforeSha256,
        afterSha256,
      },
    },
  });

  assert.deepEqual(
    evaluateValidationRecoveryCorrectionReceiptV1({
      graph,
      diagnostic,
      receipt: changedReceipt("src/run_marker.py"),
    }),
    {
      eligible: false,
      reason: "diagnostic_path_mismatch",
      receiptPath: "src/run_marker.py",
      selectedPaths: ["crdt_sync.py"],
    },
    "an unrelated but valid in-scope file cannot spend the next validation cycle",
  );
  assert.deepEqual(
    evaluateValidationRecoveryCorrectionReceiptV1({
      graph,
      diagnostic,
      receipt: changedReceipt("crdt_sync.py"),
    }),
    {
      eligible: true,
      reason: "verified_content_change",
      receiptPath: "crdt_sync.py",
      selectedPaths: ["crdt_sync.py"],
    },
  );
  assert.equal(
    getValidationRecoveryCorrectionTargetPathV1(graph, diagnostic),
    "crdt_sync.py",
  );

  const durableWorkspaceReceipt: AgentRunReceipt = {
    toolName: "code_workspace_create",
    operation: "create",
    message: "Created durable workspace.",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-28T00:00:00.000Z",
    },
    resource: {
      system: "workspace",
      resourceType: "code_workspace",
      id: "verified-workspace:verified-workspace",
      path: "verified-workspace",
      workspaceId: "verified-workspace",
    },
    output: {
      status: "ok",
      repositoryWriteScope: {
        profileKey: "byok-autonomous-python",
        projects: [{
          projectId: "root",
          projectRoot: ".",
          allowedPaths: [
            "README.md",
            "crdt_sync.py",
            "pyproject.toml",
            "src",
            "docs",
          ],
        }],
      },
    },
  };
  const tools = [
    "code_workspace_stat",
    "code_workspace_list",
    "code_workspace_read",
    "code_workspace_search",
    "code_workspace_create_file",
    "code_workspace_append",
    "code_workspace_patch",
    "code_workspace_write_expected",
  ].map((name) => ({
    type: "function" as const,
    function: {
      name,
      parameters: {
        type: "object" as const,
        properties: {
          workspaceId: { type: "string" as const },
          path: { type: "string" as const },
          content: { type: "string" as const },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  }));
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  const readFrontier = constrainValidationRecoveryWorkspaceToolsV1({
    tools,
    graph,
    diagnostic,
    runtimeCache,
    durableReceipts: [durableWorkspaceReceipt],
  });
  assert.deepEqual(
    readFrontier.map((tool) => tool.function.name),
    ["code_workspace_read"],
  );
  assert.deepEqual(
    readFrontier[0]?.function.parameters.properties?.path?.enum,
    ["crdt_sync.py"],
  );

  rememberVerifiedWorkspaceReadResult(
    runtimeCache,
    {
      name: "code_workspace_read",
      arguments: {
        workspaceId: "verified-workspace",
        path: "crdt_sync.py",
      },
    },
    { rootMissionId: "root-run" },
    {
      ok: true,
      toolName: "code_workspace_read",
      output: {
        path: "crdt_sync.py",
        sha256: beforeSha256,
        content: "class GCounter:\n    pass\n",
      },
    },
  );
  const writeFrontier = constrainValidationRecoveryWorkspaceToolsV1({
    tools,
    graph,
    diagnostic,
    runtimeCache,
    durableReceipts: [durableWorkspaceReceipt],
  });
  assert.deepEqual(
    writeFrontier.map((tool) => tool.function.name),
    ["code_workspace_write_expected"],
  );
  assert.deepEqual(
    writeFrontier[0]?.function.parameters.properties?.path?.enum,
    ["crdt_sync.py"],
  );
  assert.ok(
    writeFrontier[0]?.function.parameters.properties?.lineReplacements,
    "the correction stays on the existing SHA-bound line replacement path",
  );
  assert.equal(
    writeFrontier[0]?.function.parameters.properties?.content,
    undefined,
  );

  const promptScopedGraph = structuredClone(graph);
  const promptScopedLifecycle =
    promptScopedGraph.nodes.implementation.inputs.lifecycle.value;
  for (const action of promptScopedLifecycle.actions) {
    action.selector = null;
  }
  const readmeDiagnostic = {
    stdout: "",
    stderr: "README.md must include proof marker BYOK_AUTONOMOUS_TEST",
    truncated: false,
    redactedLines: 0,
  };
  assert.deepEqual(
    getDiagnosticSelectedWorkspaceCorrectionPaths(
      promptScopedGraph,
      readmeDiagnostic,
      [durableWorkspaceReceipt],
    ),
    ["README.md"],
    "the canonical repository-write receipt narrows a model-chosen file absent from the initial graph",
  );
  assert.equal(
    getValidationRecoveryCorrectionTargetPathV1(
      promptScopedGraph,
      readmeDiagnostic,
      [durableWorkspaceReceipt],
    ),
    "README.md",
  );
  const scopeBoundReadFrontier = constrainValidationRecoveryWorkspaceToolsV1({
    tools,
    graph: promptScopedGraph,
    diagnostic: readmeDiagnostic,
    runtimeCache: {
      toolResults: new Map(),
      verifiedWorkspaceReads: new Map(),
    },
    durableReceipts: [durableWorkspaceReceipt],
  });
  assert.deepEqual(
    scopeBoundReadFrontier.map((tool) => tool.function.name),
    ["code_workspace_read"],
  );
  assert.deepEqual(
    scopeBoundReadFrontier[0]?.function.parameters.properties?.path?.enum,
    ["README.md"],
  );
  assert.deepEqual(
    evaluateValidationRecoveryCorrectionReceiptV1({
      graph: promptScopedGraph,
      diagnostic: readmeDiagnostic,
      receipt: changedReceipt("crdt_sync.py"),
      durableReceipts: [durableWorkspaceReceipt],
    }),
    {
      eligible: false,
      reason: "diagnostic_path_mismatch",
      receiptPath: "crdt_sync.py",
      selectedPaths: ["README.md"],
    },
    "a different verified patch cannot spend the README correction gate",
  );
  assert.deepEqual(
    evaluateValidationRecoveryCorrectionReceiptV1({
      graph: promptScopedGraph,
      diagnostic: readmeDiagnostic,
      receipt: changedReceipt("README.md"),
      durableReceipts: [durableWorkspaceReceipt],
    }),
    {
      eligible: true,
      reason: "verified_content_change",
      receiptPath: "README.md",
      selectedPaths: ["README.md"],
    },
  );
  assert.deepEqual(
    getDiagnosticSelectedWorkspaceCorrectionPaths(
      promptScopedGraph,
      {
        stdout: "",
        stderr:
          "FAIL: test_observed_remove_and_concurrent_add\nAssertionError: expected convergence",
        truncated: false,
        redactedLines: 0,
      },
      [durableWorkspaceReceipt],
    ),
    ["crdt_sync.py"],
    "a protected assertion with one allowlisted implementation candidate narrows to that module",
  );
});

test("validation recovery fails closed when no exact diagnostic path is available", () => {
  const graph = {
    nodes: {
      fast: {
        id: "fast",
        status: "queued",
        allowedTools: ["code_validate_fast"],
        inputs: {},
        outputs: {},
      },
      repair: {
        id: "repair",
        status: "queued",
        allowedTools: ["code_repair_record_cycle"],
        inputs: {},
        outputs: {
          validationRecovery: {
            version: 1,
            status: "awaiting_correction",
            fastNodeId: "fast",
            repairNodeId: "repair",
          },
        },
      },
    },
  } as any;
  const tools = [
    "code_workspace_stat",
    "code_workspace_list",
    "code_workspace_read",
    "code_workspace_search",
    "code_workspace_create_file",
    "code_workspace_append",
    "code_workspace_patch",
    "code_workspace_write_expected",
  ].map((name) => ({
    type: "function" as const,
    function: {
      name,
      parameters: {
        type: "object" as const,
        properties: { path: { type: "string" as const } },
      },
    },
  }));
  assert.deepEqual(
    constrainValidationRecoveryWorkspaceToolsV1({
      tools,
      graph,
      diagnostic: null,
      runtimeCache: {
        toolResults: new Map(),
        verifiedWorkspaceReads: new Map(),
      },
      durableReceipts: [],
    }),
    [],
    "an unresolved active recovery must not preserve broad diagnosis or mutation authority",
  );
  const changedReceipt = {
    toolName: "code_workspace_patch",
    operation: "update",
    path: "unrelated.py",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-28T00:00:00.000Z",
      observedRevision: `sha256:${"b".repeat(64)}`,
    },
    output: {
      path: "unrelated.py",
      receipt: {
        version: 2,
        path: "unrelated.py",
        beforeSha256: `sha256:${"a".repeat(64)}`,
        afterSha256: `sha256:${"b".repeat(64)}`,
      },
    },
  } as AgentRunReceipt;
  assert.deepEqual(
    evaluateValidationRecoveryCorrectionReceiptV1({
      graph,
      diagnostic: null,
      receipt: changedReceipt,
    }),
    {
      eligible: false,
      reason: "diagnostic_path_mismatch",
      receiptPath: "unrelated.py",
      selectedPaths: [],
    },
  );
});

test("multi-file correction selects the host-verified workspace when path observations are ambiguous", () => {
  const path = "checkers/game.py";
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  rememberVerifiedWorkspaceReadResult(
    runtimeCache,
    { name: "code_workspace_read", arguments: { path } },
    { rootMissionId: "root-segment" },
    {
      ok: true,
      toolName: "code_workspace_read",
      output: {
        path,
        sha256: `sha256:${"a".repeat(64)}`,
        content: "unscoped earlier observation\n",
      },
    },
  );
  rememberVerifiedWorkspaceReadResult(
    runtimeCache,
    {
      name: "code_workspace_read",
      arguments: { workspaceId: "du06-workspace", path },
    },
    { rootMissionId: "root-segment" },
    {
      ok: true,
      toolName: "code_workspace_read",
      output: {
        path,
        sha256: `sha256:${"b".repeat(64)}`,
        content: "host-refreshed observation\n",
      },
    },
  );
  assert.equal(
    getVerifiedWorkspaceReadObservation(runtimeCache, path),
    null,
    "a path-only lookup must remain fail-closed across workspace labels",
  );
  const receipt: AgentRunReceipt = {
    toolName: "code_workspace_create",
    operation: "create",
    message: "Created durable workspace.",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-19T01:40:00.000Z",
    },
    resource: {
      system: "workspace",
      resourceType: "code_workspace",
      id: "du06-workspace",
      path: "du06-workspace",
      workspaceId: "du06-workspace",
    },
  };
  assert.deepEqual(
    bindVerifiedWorkspaceRead(
      {
        name: "code_workspace_read",
        arguments: {
          workspaceId: "root-segment",
          path: "wrong/model/path.py",
          maxBytes: 10_000,
        },
      },
      path,
      [receipt],
    )?.arguments,
    {
      workspaceId: "du06-workspace",
      path,
      maxBytes: 10_000,
    },
  );
  assert.deepEqual(
    getVerifiedWorkspaceWriteObservation(runtimeCache, path, [receipt]),
    {
      workspaceId: "du06-workspace",
      path,
      sha256: `sha256:${"b".repeat(64)}`,
      content: "host-refreshed observation\n",
    },
  );
});

test("workspace correction retains the SHA-bound observation for an empty file", () => {
  const path = "checkers/__init__.py";
  const sha256 = `sha256:${"0".repeat(64)}`;
  const runtimeCache: AgentRuntimeCache = {
    toolResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  rememberVerifiedWorkspaceReadResult(
    runtimeCache,
    {
      name: "code_workspace_read",
      arguments: { workspaceId: "du06-workspace", path },
    },
    { rootMissionId: "du06-root" },
    {
      ok: true,
      toolName: "code_workspace_read",
      output: { path, sha256, content: "" },
    },
  );

  assert.deepEqual(
    getVerifiedWorkspaceReadObservation(
      runtimeCache,
      path,
      "du06-workspace",
    ),
    {
      workspaceId: "du06-workspace",
      path,
      sha256,
      content: "",
    },
  );
});

test("workspace correction narrows mutations to files named by validator evidence", () => {
  const paths = [
    "README.md",
    "checkers/__init__.py",
    "checkers/cli.py",
    "checkers/game.py",
    "tests/test_checkers.py",
  ];
  const graph = {
    nodes: Object.fromEntries(
      paths.map((path, index) => [
        `write-${index}`,
        {
          id: `write-${index}`,
          status: "queued",
          allowedTools: ["code_workspace_write_expected"],
          inputs: {},
          destination: {
            bindingId: "workspace-binding",
            effect: "workspace_mutation",
            selector: path,
          },
        },
      ]),
    ),
  } as any;

  assert.deepEqual(
    getDiagnosticSelectedWorkspaceCorrectionPaths(graph, {
      stdout: "",
      stderr:
        "ImportError: cannot import name 'main' from 'checkers.cli' (/workspace/checkers/cli.py)",
      truncated: false,
      redactedLines: 0,
    }),
    ["checkers/cli.py"],
  );
  assert.deepEqual(
    getDiagnosticSelectedWorkspaceCorrectionPaths(graph, {
      stdout: "",
      stderr: [
        'File "/workspace/checkers/__init__.py", line 3, in <module>',
        "from .game import RED",
        "ImportError: cannot import name 'RED' from 'checkers.game' (/workspace/checkers/game.py)",
      ].join("\n"),
      truncated: false,
      redactedLines: 0,
    }),
    ["checkers/__init__.py", "checkers/game.py"],
  );
});

test("workspace correction selects the sole implementation file for a pathless assertion", () => {
  const graph = {
    nodes: {
      readme: {
        id: "readme",
        status: "ready",
        allowedTools: ["code_workspace_write_expected"],
        inputs: {},
        destination: {
          bindingId: "workspace-binding",
          effect: "workspace_mutation",
          selector: "README.md",
        },
      },
      entrypoint: {
        id: "entrypoint",
        status: "queued",
        allowedTools: ["code_workspace_write_expected"],
        inputs: {},
        destination: {
          bindingId: "workspace-binding",
          effect: "workspace_mutation",
          selector: "src/index.ts",
        },
      },
      implementation: {
        id: "implementation",
        status: "queued",
        allowedTools: ["code_workspace_write_expected"],
        inputs: {},
        destination: {
          bindingId: "workspace-binding",
          effect: "workspace_mutation",
          selector: "src/game.ts",
        },
      },
      test: {
        id: "test",
        status: "queued",
        allowedTools: ["code_workspace_write_expected"],
        inputs: {},
        destination: {
          bindingId: "workspace-binding",
          effect: "workspace_mutation",
          selector: "tests/game.test.ts",
        },
      },
    },
  } as any;
  assert.deepEqual(
    getDiagnosticSelectedWorkspaceCorrectionPaths(graph, {
      stdout: "protected contract failed",
      stderr: "AssertionError: mandatory capture mismatch",
      truncated: false,
      redactedLines: 0,
    }),
    ["src/game.ts"],
  );
});

test("workspace correction prefers implementation when assertion traceback names it", () => {
  const paths = [
    "README.md",
    "checkers/__init__.py",
    "checkers/game.py",
    "tests/__init__.py",
    "tests/test_checkers.py",
  ];
  const graph = {
    nodes: Object.fromEntries(
      paths.map((path, index) => [
        `write-${index}`,
        {
          id: `write-${index}`,
          status: index === 0 ? "ready" : "queued",
          allowedTools: ["code_workspace_write_expected"],
          inputs: {},
          destination: {
            bindingId: "workspace-binding",
            effect: "workspace_mutation",
            selector: path,
          },
        },
      ]),
    ),
  } as any;

  assert.deepEqual(
    getDiagnosticSelectedWorkspaceCorrectionPaths(graph, {
      stdout: "",
      stderr: [
        "FAIL: test_multi_jump (test_checkers.TestCheckersGame.test_multi_jump)",
        '  File "/workspace/tests/test_checkers.py", line 55, in test_multi_jump',
        '  File "/workspace/checkers/game.py", line 120, in legal_moves',
        "AssertionError: ((5, 0), (1, 4)) not found in [((5, 0), (3, 2))]",
      ].join("\n"),
      truncated: false,
      redactedLines: 0,
    }),
    ["checkers/game.py"],
  );
});

test("workspace correction selects self-authored tests when only they fail and protected contract did not", () => {
  const paths = [
    "README.md",
    "checkers/__init__.py",
    "checkers/game.py",
    "tests/test_checkers.py",
  ];
  const graph = {
    nodes: Object.fromEntries(
      paths.map((path, index) => [
        `write-${index}`,
        {
          id: `write-${index}`,
          status: index === 0 ? "ready" : "queued",
          allowedTools: ["code_workspace_write_expected"],
          inputs: {},
          destination: {
            bindingId: "workspace-binding",
            effect: "workspace_mutation",
            selector: path,
          },
        },
      ]),
    ),
  } as any;

  assert.deepEqual(
    getDiagnosticSelectedWorkspaceCorrectionPaths(graph, {
      stdout: "",
      stderr: [
        "FAIL: test_mandatory_capture (test_checkers.TestCheckersGame.test_mandatory_capture)",
        '  File "/workspace/tests/test_checkers.py", line 33, in test_mandatory_capture',
        "AssertionError: 'b' != 'r'",
      ].join("\n"),
      truncated: false,
      redactedLines: 0,
    }),
    ["tests/test_checkers.py"],
  );
});

test("workspace correction still prefers sole implementation when protected contract assertion fails", () => {
  const paths = [
    "README.md",
    "checkers/game.py",
    "tests/test_checkers.py",
  ];
  const graph = {
    nodes: Object.fromEntries(
      paths.map((path, index) => [
        `write-${index}`,
        {
          id: `write-${index}`,
          status: index === 0 ? "ready" : "queued",
          allowedTools: ["code_workspace_write_expected"],
          inputs: {},
          destination: {
            bindingId: "workspace-binding",
            effect: "workspace_mutation",
            selector: path,
          },
        },
      ]),
    ),
  } as any;

  assert.deepEqual(
    getDiagnosticSelectedWorkspaceCorrectionPaths(graph, {
      stdout: "",
      stderr: [
        'File "/workspace/scripts/verify_project.py", line 40, in <module>',
        '  File "/workspace/tests/test_checkers.py", line 33, in test_mandatory_capture',
        "AssertionError: mandatory capture mismatch",
      ].join("\n"),
      truncated: false,
      redactedLines: 0,
    }),
    ["checkers/game.py"],
  );
});

test("workspace correction does not guess between multiple pathless implementation targets", () => {
  const graph = {
    nodes: Object.fromEntries(
      ["src/board.ts", "src/game.ts"].map((selector, index) => [
        `write-${index}`,
        {
          id: `write-${index}`,
          status: index === 0 ? "ready" : "queued",
          allowedTools: ["code_workspace_write_expected"],
          inputs: {},
          destination: {
            bindingId: "workspace-binding",
            effect: "workspace_mutation",
            selector,
          },
        },
      ]),
    ),
  } as any;
  assert.deepEqual(
    getDiagnosticSelectedWorkspaceCorrectionPaths(graph, {
      stdout: "",
      stderr: "AssertionError: legal move mismatch",
      truncated: false,
      redactedLines: 0,
    }),
    [],
  );
});

test("workspace correction refreshes completed exact reads in its durably created workspace", () => {
  const path = "checkers/game.py";
  const writeTool = [{
    type: "function" as const,
    function: {
      name: "code_workspace_write_expected",
      parameters: { type: "object", properties: {} },
    },
  }];
  const graph = {
    nodes: {
      read: {
        id: "read",
        status: "complete",
        allowedTools: ["code_workspace_read"],
        inputs: {
          resource: {
            kind: "binding",
            bindingId: "workspace-binding",
            selector: path,
          },
        },
      },
      protectedRead: {
        id: "protectedRead",
        status: "complete",
        allowedTools: ["code_workspace_read"],
        inputs: {
          resource: {
            kind: "binding",
            bindingId: "workspace-binding",
            selector: path,
          },
        },
      },
      contractRead: {
        id: "contractRead",
        status: "complete",
        allowedTools: ["code_workspace_read"],
        inputs: {
          resource: {
            kind: "binding",
            bindingId: "workspace-binding",
            selector: "scripts/verify_project.py",
          },
        },
      },
      siblingRead: {
        id: "siblingRead",
        status: "complete",
        allowedTools: ["code_workspace_read"],
        inputs: {
          resource: {
            kind: "binding",
            bindingId: "workspace-binding",
            selector: "checkers/cli.py",
          },
        },
      },
      siblingWrite: {
        id: "siblingWrite",
        status: "queued",
        allowedTools: ["code_workspace_write_expected"],
        dependencyIds: ["siblingRead"],
        inputs: {},
        destination: {
          bindingId: "workspace-binding",
          effect: "workspace_mutation",
          selector: "checkers/cli.py",
        },
      },
      write: {
        id: "write",
        status: "ready",
        allowedTools: ["code_workspace_write_expected"],
        dependencyIds: ["read", "protectedRead", "contractRead", "siblingRead"],
        inputs: {},
        destination: {
          bindingId: "workspace-binding",
          effect: "workspace_mutation",
          selector: path,
        },
      },
    },
  } as any;
  const receipt: AgentRunReceipt = {
    toolName: "code_workspace_create",
    operation: "create",
    message: "Created durable workspace.",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-18T23:30:00.000Z",
    },
    resource: {
      system: "workspace",
      resourceType: "code_workspace",
      id: "du06-workspace",
      path: "du06-workspace",
      workspaceId: "du06-workspace",
    },
  };
  assert.deepEqual(
    getVerifiedWorkspaceReadRefreshBinding(
      graph,
      writeTool,
      [receipt],
      path,
    ),
    { workspaceId: "du06-workspace", path },
  );
  assert.deepEqual(
    getVerifiedWorkspaceSupportingReadRefreshBindings(
      graph,
      writeTool,
      [receipt],
      path,
    ),
    [{
      workspaceId: "du06-workspace",
      path: "scripts/verify_project.py",
    }, {
      workspaceId: "du06-workspace",
      path: "checkers/cli.py",
    }],
  );
  assert.deepEqual(
    getVerifiedWorkspaceSupportingReadRefreshBindings(
      {
        ...graph,
        nodes: {
          ...graph.nodes,
          contractWrite: {
            id: "contractWrite",
            status: "queued",
            allowedTools: ["code_workspace_write_expected"],
            dependencyIds: ["contractRead"],
            inputs: {},
            destination: {
              bindingId: "workspace-binding",
              effect: "workspace_mutation",
              selector: "scripts/verify_project.py",
            },
          },
        },
      },
      writeTool,
      [receipt],
      path,
    ),
    [{
      workspaceId: "du06-workspace",
      path: "checkers/cli.py",
    }, {
      workspaceId: "du06-workspace",
      path: "scripts/verify_project.py",
    }],
    "another writable selector may be untrusted context but cannot change the active write binding",
  );
  assert.equal(
    getVerifiedWorkspaceReadRefreshBinding(
      {
        ...graph,
        nodes: {
          ...graph.nodes,
          read: { ...graph.nodes.read, status: "queued" },
          protectedRead: {
            ...graph.nodes.protectedRead,
            status: "queued",
          },
        },
      },
      writeTool,
      [receipt],
      path,
    ),
    null,
  );
  assert.equal(
    getVerifiedWorkspaceReadRefreshBinding(graph, writeTool, [], path),
    null,
  );
});

test("authoritative graph validation cannot import unmodeled generated artifacts", () => {
  assert.deepEqual(
    bindAuthoritativeGraphCodeValidation({
      name: "code_validate_fast",
      arguments: {
        workspaceId: "du06-workspace",
        repairRequestId: "du06-request",
        expectedArtifacts: [
          "README.md",
          { path: "dist/unmodeled.txt" },
        ],
      },
    }),
    {
      name: "code_validate_fast",
      arguments: {
        workspaceId: "du06-workspace",
        repairRequestId: "du06-request",
        expectedArtifacts: [],
      },
    },
  );
  const unrelated = {
    name: "code_workspace_read",
    arguments: { workspaceId: "du06-workspace", path: "README.md" },
  };
  assert.equal(bindAuthoritativeGraphCodeValidation(unrelated), unrelated);
});

test("Linear issue readback binds the one durable hierarchy issue instead of a model alias", () => {
  const issueId = "12345678-1234-4234-8234-1234567890ab";
  const context = {
    rootMissionId: "root-linear-run",
    runId: "restart-segment",
    getProjectLineages: () => [
      {
        schemaVersion: 1 as const,
        kind: "project_lineage" as const,
        lineageId: "project-test",
        runId: "root-linear-run",
        vaultBindingKey: "vault:test",
        commits: [
          {
            stage: "linear_hierarchy" as const,
            committedAt: "2026-07-18T22:00:00.000Z",
            proof: {
              stage: "linear_hierarchy" as const,
              planFingerprint: `sha256:${"1".repeat(64)}`,
              workspaceId: "workspace",
              teamId: "team",
              initiativeId: "initiative",
              projectId: "project",
              issueIds: [issueId],
              workItemFingerprints: [`sha256:${"2".repeat(64)}`],
              providerReadbackFingerprints: [`sha256:${"3".repeat(64)}`],
            },
            proofFingerprint: `sha256:${"4".repeat(64)}`,
          },
        ],
        updatedAt: "2026-07-18T22:00:00.000Z",
        fingerprint: `sha256:${"5".repeat(64)}`,
      },
    ],
  };
  assert.equal(getVerifiedLinearHierarchyIssueId(context), issueId);
  assert.deepEqual(
    resolveLinearIssueReadbackBinding({
      dependencyToolNames: ["publish_research_project_to_linear"],
      context,
      messages: [],
    }),
    { required: true, issueId, source: "linear_hierarchy" },
  );
  const binding = buildObservedMissionGraphFrontierBinding(
    [],
    [{
      type: "function",
      function: {
        name: "linear_get_issue",
        parameters: { type: "object", properties: {} },
      },
    }],
    [],
    null,
    issueId,
  );
  assert.match(binding ?? "", /EXACT VERIFIED LINEAR ISSUE READBACK/u);
  assert.match(binding ?? "", new RegExp(issueId, "u"));
  assert.deepEqual(
    resolveLinearIssueReadbackBinding({
      dependencyToolNames: ["linear_create_issue"],
      context: {},
      messages: [{
        role: "tool",
        toolName: "linear_create_issue",
        content: JSON.stringify({
          ok: true,
          output: {
            resourceType: "issue",
            id: issueId,
            identifier: "APP-42",
            title: "Retained evidence",
            url: "https://linear.app/example/issue/APP-42",
          },
        }),
      }],
    }),
    { required: true, issueId, source: "linear_create_issue" },
  );
  // Continue segments often keep only durable receipts (no tool messages). UUID
  // + human identifier must not be treated as ambiguous dual IDs.
  assert.deepEqual(
    resolveLinearIssueReadbackBinding({
      dependencyToolNames: ["linear_create_issue"],
      context: {},
      messages: [],
      durableReceipts: [
        {
          id: "receipt-linear-create",
          toolName: "linear_create_issue",
          operation: "linear_create_issue",
          message: "Created Linear issue APP-42",
          resource: {
            system: "linear",
            resourceType: "issue",
            id: issueId,
            url: "https://linear.app/example/issue/APP-42",
          },
          output: {
            id: issueId,
            identifier: "APP-42",
            url: "https://linear.app/example/issue/APP-42",
          },
        } as never,
      ],
    }),
    { required: true, issueId, source: "linear_create_issue" },
  );
});

test("set-loose Soft-union binds linear_get_issue from create receipt when publish dependency projection lags", () => {
  const issueId = "abcdef01-2345-4789-a012-3456789abcde";
  const durableReceipts = [
    {
      id: "receipt-set-loose-create",
      toolName: "linear_create_issue",
      operation: "create",
      message: "Created Linear issue FLOW-7",
      resource: {
        system: "linear",
        resourceType: "issue",
        id: issueId,
        identifier: "FLOW-7",
        url: "https://linear.app/example/issue/FLOW-7",
      },
      output: {
        id: issueId,
        identifier: "FLOW-7",
        url: "https://linear.app/example/issue/FLOW-7",
        title: "Flow real marker",
      },
    } as never,
  ];

  // MissionGraph still projects publish_research_project_to_linear, but set-loose
  // Soft-union already paid Linear via linear_create_issue (no hierarchy lineage).
  assert.deepEqual(
    resolveLinearIssueReadbackBinding({
      dependencyToolNames: ["publish_research_project_to_linear"],
      context: {},
      messages: [],
      durableReceipts,
    }),
    { required: true, issueId, source: "linear_create_issue" },
  );

  assert.deepEqual(
    decideLinearGetIssueHostBindingV1({
      dependencyToolNames: ["publish_research_project_to_linear"],
      context: {},
      messages: [],
      durableReceipts,
      setLooseCompoundEnabled: true,
      linearDeliveryPaid: true,
    }),
    {
      action: "bind",
      issueId,
      source: "linear_create_issue",
    },
  );

  // Paid Linear with no recoverable ID must Soft-skip, not hard-stop the graph.
  assert.deepEqual(
    decideLinearGetIssueHostBindingV1({
      dependencyToolNames: ["publish_research_project_to_linear"],
      context: {},
      messages: [],
      durableReceipts: [],
      setLooseCompoundEnabled: true,
      linearDeliveryPaid: true,
    }),
    { action: "soft_skip", issueId: null, source: null },
  );

  // Non-set-loose still hard-blocks when hierarchy projection has no ID.
  assert.deepEqual(
    decideLinearGetIssueHostBindingV1({
      dependencyToolNames: ["publish_research_project_to_linear"],
      context: {},
      messages: [],
      durableReceipts: [],
      setLooseCompoundEnabled: false,
      linearDeliveryPaid: false,
    }),
    { action: "block", issueId: null, source: "linear_hierarchy" },
  );

  assert.equal(
    pickCanonicalLinearIssueId(
      collectLinearIssueBindingCandidates({
        messages: [],
        durableReceipts,
      }),
    ),
    issueId,
  );
});

test("explicit Linear mutations keep named creates even when catalog shrink omitted them", () => {
  assert.deepEqual(
    getExplicitLinearMutationToolNames(
      [
        "Create exactly one Linear issue.",
        "Required tools: linear_create_issue, linear_get_issue, append_to_current_file.",
        "Do not create Linear projects or Linear initiatives.",
      ].join(" "),
      new Set(["linear_get_issue", "append_to_current_file"]),
    ),
    ["linear_create_issue"],
  );
});

test("explicit Linear reads preserve order and obey negation", () => {
  const allowed = new Set([
    "linear_get_issue",
    "linear_list_comments",
    "linear_create_issue",
  ]);
  assert.deepEqual(
    getExplicitLinearReadToolNames(
      "Call linear_get_issue, then linear_list_comments.",
      allowed,
    ),
    ["linear_get_issue", "linear_list_comments"],
  );
  assert.deepEqual(
    getExplicitLinearReadToolNames(
      "Do not call linear_get_issue or linear_list_comments.",
      allowed,
    ),
    [],
  );
  assert.deepEqual(
    insertExplicitLinearReadbacksIntoLifecycleToolNames(
      [
        "publish_research_to_linear",
        "publish_research_project_to_linear",
        "code_workspace_create",
      ],
      ["linear_get_issue"],
    ),
    [
      "publish_research_to_linear",
      "publish_research_project_to_linear",
      "linear_get_issue",
      "code_workspace_create",
    ],
  );
});

test("compound public-web lifecycle reserves exact research reads before effects", () => {
  const prompt = [
    "Research American checkers using exactly two public web sources and fetch both sources.",
    "Write the accepted research notebook, create the Linear hierarchy, implement Python in the repository,",
    "run targeted validation, commit it, and publish it to a private GitHub repository.",
  ].join(" ");
  assert.deepEqual(
    getCompoundLifecycleResearchGraphToolNames(prompt),
    ["web_search", "web_fetch", "web_fetch"],
  );
  assert.deepEqual(
    getCompoundLifecycleResearchGraphToolNames(prompt, 1),
    ["web_search", "web_fetch"],
  );
  assert.deepEqual(
    getCompoundLifecycleResearchGraphToolNames(prompt, 2),
    [],
  );
});

test("explicit source proof rejects duplicate fetches while distinct debt remains", () => {
  const contentHash = `sha256:${"a".repeat(64)}`;
  const evidence: MissionEvidence[] = [{
    id: "web:source-1",
    kind: "web_source",
    title: "Source one",
    url: "https://source-1.example.test/evidence",
    contentHash,
    summary: "Verified content.",
    confidence: "high",
    usableSource: true,
    parserStatus: "parsed",
    passageIds: ["passage-1"],
  }];

  assert.equal(
    rejectDuplicateResearchSourceFetchV1({
      toolCall: {
        name: "web_fetch",
        arguments: { url: "https://source-1.example.test/evidence#repeat" },
      },
      originalPrompt: "Use exactly two independent sources.",
      evidence,
    })?.error?.code,
    "duplicate_research_source",
  );
  assert.equal(
    rejectDuplicateResearchSourceFetchV1({
      toolCall: {
        name: "web_fetch",
        arguments: { url: "https://source-2.example.test/evidence" },
      },
      originalPrompt: "Use exactly two independent sources.",
      evidence,
    }),
    null,
  );
});

test("continuation restores a mutation only from receipt-bound graph proof", () => {
  const proven = {
    id: "tool-1",
    status: "complete",
    effect: "external_action",
    allowedTools: ["publish_research_to_linear"],
    evidence: [{ id: "evidence-1", kind: "tool-result" }],
    receipts: [{ id: "receipt-1", kind: "external_action" }],
    verification: null,
    completionContract: {
      minimumEvidence: 1,
      requiredEvidenceKinds: ["tool-result"],
      minimumReceipts: 1,
      requiredReceiptKinds: ["external_action"],
      verifierId: null,
    },
  } as any;
  assert.deepEqual(
    getDurablyProvenCompletedGraphToolNames(
      [proven],
      ["publish_research_to_linear"],
    ),
    ["publish_research_to_linear"],
  );
  assert.deepEqual(
    getDurablyProvenCompletedGraphToolNames(
      [{ ...proven, receipts: [] }],
      ["publish_research_to_linear"],
    ),
    [],
  );
  assert.deepEqual(
    getDurablyProvenCompletedGraphToolNames(
      [{
        ...proven,
        verification: { verifierId: "provider-v1", status: "failed" },
        completionContract: {
          ...proven.completionContract,
          verifierId: "provider-v1",
        },
      }],
      ["publish_research_to_linear"],
    ),
    [],
  );
});

test("durable strong-hash web evidence restores the publication proof registry", () => {
  const runtimeCache: AgentRuntimeCache = { toolResults: new Map() };
  const contentHash = `sha256:${"a".repeat(64)}`;
  restoreTrustedWebFetchResultsFromEvidence(runtimeCache, [
    {
      id: "web:source",
      kind: "web_source",
      title: "Verified rules",
      url: "https://example.test/rules",
      contentHash,
      usableSource: true,
      parserStatus: "parsed",
      summary: "Verified American checkers rules.",
      confidence: "high",
    },
  ]);
  const restored = runtimeCache.trustedWebFetchResults?.get(
    `https://example.test/rules:${contentHash}`,
  );
  assert.equal(restored?.ok, true);
  assert.deepEqual(restored?.output, {
    url: "https://example.test/rules",
    normalizedUrl: "https://example.test/rules",
    title: "Verified rules",
    content: "Verified American checkers rules.",
    contentHash,
    parserStatus: "parsed",
  });
});

test("one provider response cannot cross two durable project lifecycle mutation boundaries", () => {
  assert.equal(
    shouldDeferAdditionalProjectLifecycleMutation(
      "publish_research_project_to_linear",
      true,
    ),
    true,
  );
  assert.equal(
    shouldDeferAdditionalProjectLifecycleMutation(
      "code_commit_verified",
      true,
    ),
    true,
  );
  assert.equal(
    shouldDeferAdditionalProjectLifecycleMutation("web_fetch", true),
    false,
  );
  assert.equal(
    shouldDeferAdditionalProjectLifecycleMutation(
      "publish_research_project_to_linear",
      false,
    ),
    false,
  );
});

test("accepted-research frontier separates publication from hierarchy arguments", () => {
  const context = buildMissionGraphFrontierTurnContext([
    {
      type: "function",
      function: {
        name: "publish_research_to_linear",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  assert.match(context, /fields directly: schemaVersion, title, problemImpact/u);
  assert.match(context, /proposedWork, scope, acceptanceCriteria/u);
  assert.match(context, /must each contain at least one item/u);
  assert.match(context, /exact JSON string "create"/u);
  assert.match(context, /omit baseHash entirely/u);
  assert.match(context, /Never send an empty baseHash placeholder/u);
  assert.match(context, /never use write, overwrite, upsert, create_or_append/iu);
  assert.match(context, /Do not add research, initiativeKey, projectKey/u);
  assert.match(context, /separate later frontier/u);
  assert.match(context, /exact riskClass values low, medium, or high/u);
  assert.match(context, /exact executionClass values research, vault, code, or human/u);
  assert.match(context, /executionClass=code/u);
});

test("set-loose accepted-research frontier retains the nonempty JSON array contract", () => {
  const context = buildMissionGraphFrontierTurnContext(
    [
      {
        type: "function",
        function: {
          name: "publish_research_to_linear",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "web_search",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    null,
    { setLoose: true, currentStage: "accepted_research" },
  );
  assert.match(context, /proposedWork, scope, acceptanceCriteria/u);
  assert.match(context, /nonempty JSON arrays/u);
  assert.match(context, /Even one proposedWork item must be written as \["\.\.\."\]/u);
  assert.match(context, /never send a bare string, object, null, or empty array/u);
});

test("research-hierarchy frontier states exact issue list and fingerprint contracts", () => {
  const context = buildMissionGraphFrontierTurnContext([
    {
      type: "function",
      function: {
        name: "publish_research_project_to_linear",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  assert.match(context, /dependencyKeys must be a JSON array/u);
  assert.match(context, /use \[\] when it has no dependency/u);
  assert.match(context, /acceptanceCriteria must be a nonempty JSON array/u);
  assert.match(context, /initiative and project must each contain nonempty key, title, and description/u);
  assert.match(context, /Use title, not name/u);
  assert.match(context, /Omit workItemFingerprint/u);
});

test("write_expected frontier forbids inventing patch or re-validate", () => {
  const context = buildMissionGraphFrontierTurnContext([
    {
      type: "function",
      function: {
        name: "code_workspace_write_expected",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  assert.match(context, /only code_workspace_write_expected/u);
  assert.match(context, /Do not call code_workspace_patch/u);
  assert.match(context, /code_validate_\*/u);
});

test("code workspace bootstrap frontiers advertise later nested writes and approved host delivery", () => {
  const createContext = buildMissionGraphFrontierTurnContext([
    {
      type: "function",
      function: {
        name: "code_workspace_create",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  assert.match(createContext, /bootstrap frontier/u);
  assert.match(createContext, /code_workspace_create_file/u);
  assert.match(createContext, /automatically creates missing parent directories/u);
  assert.match(createContext, /code_workspace_export_directory/u);
  assert.match(createContext, /Do not return code-only chat prose/u);

  const fileContext = buildMissionGraphFrontierTurnContext([
    {
      type: "function",
      function: {
        name: "code_workspace_create_file",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  assert.match(fileContext, /src\/game\/ui\/checkers\.py/u);
  assert.match(fileContext, /missing parent directories/u);

  const exportContext = buildMissionGraphFrontierTurnContext([
    {
      type: "function",
      function: {
        name: "code_workspace_export_directory",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  assert.match(exportContext, /desktop, documents, or downloads/u);
  assert.match(exportContext, /never overwrites/u);

  const mixedCodeContext = buildMissionGraphFrontierTurnContext([
    {
      type: "function",
      function: {
        name: "code_workspace_read",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "code_validate_fast",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  assert.match(mixedCodeContext, /real directories on the user's local filesystem/iu);
  assert.match(mixedCodeContext, /Later dependency-ready frontiers/iu);
  assert.match(mixedCodeContext, /Do not claim filesystem access/iu);

  const setLooseCodeContext = buildMissionGraphFrontierTurnContext(
    [{
      type: "function",
      function: {
        name: "code_workspace_create",
        parameters: { type: "object", properties: {} },
      },
    }],
    null,
    { setLoose: true, currentStage: "code_execution" },
  );
  assert.match(setLooseCodeContext, /real directories on the user's local filesystem/iu);
  assert.match(setLooseCodeContext, /Do not claim filesystem access/iu);
});

test("negated cleanup after a research path does not become a delete mission", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const statuses: string[] = [];
  const prompt = [
    "Research American checkers rules using at least two credible public web sources.",
    "Write the accepted research into Projects/Checkers/Research.md.",
    "Then prepare exactly one Linear issue, create it after approval, and read it back independently.",
    "Stop after the Linear readback. Do not delete or clean up the issue.",
  ].join(" ");

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("Research is still in progress.")],
    }),
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    maxSteps: 1,
    events: {
      onRunConfig: (event) => configs.push(event),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(configs[0]?.missionMode, "explicit_file_mutation");
  assert.equal(configs[0]?.allowedToolNames.includes("delete_path"), false);
  assert.equal(configs[0]?.allowedToolNames.includes("delete_current_file"), false);
  assert.equal(configs[0]?.allowedToolNames.includes("web_search"), true);
  assert.equal(configs[0]?.allowedToolNames.includes("web_fetch"), true);
  assert.deepEqual(
    configs[0]?.projectLifecycleEstimate?.stages.map((stage) => stage.stage),
    ["accepted_research", "linear_hierarchy"],
  );
  assert.equal(configs[0]?.projectLifecycleEstimate?.activeMinutesMin, 6);
  assert.equal(configs[0]?.projectLifecycleEstimate?.activeMinutesMax, 18);
  assert.equal(
    statuses.some(
      (message) =>
        message.includes("Pipeline: 1/2 Research and Obsidian note") &&
        // Set-loose (automatic + multi-stage) omits mid-run approval from the
        // Linear stage label; classic wording still mentions approval.
        (message.includes("2/2 Linear prepare, create, and readback") ||
          message.includes(
            "2/2 Linear prepare, approval, create, and readback",
          )) &&
        message.includes("6-18 minutes"),
    ),
    true,
  );
  assert.equal(
    chatRequests[0]?.tools?.some((tool) => tool.function.name === "delete_path"),
    false,
  );
});

test("runner emits structured trace events for intent, tools, receipts, metrics, and final state", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const traceKinds: string[] = [];
  const traceMessages: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "Trace me" }),
    ],
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onTrace: (event) => {
        traceKinds.push(event.kind);
        traceMessages.push(event.message);
      },
    },
  });

  for (const kind of [
    "mission_intent",
    "allowed_tools",
    "model_call",
    "tool_start",
    "tool_result",
    "receipt",
    "metric",
    "acceptance",
    "final",
  ]) {
    assert.ok(traceKinds.includes(kind), kind);
  }
  assert.ok(traceMessages.some((message) => /Mission mode:/.test(message)));
});

test("run config reports current-note context separately from vault questions", async () => {
  const configs: AgentRunConfigEvent[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "Context" }),
    ],
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].missionMode, "explicit_file_mutation");
  assert.equal(configs[0].contextScope, "none");
  assert.equal(configs[0].currentNoteContext, false);
  assert.equal(configs[0].vaultContext, false);
});

test("run config reports vault and mixed context scopes", async () => {
  const vaultConfigs: AgentRunConfigEvent[] = [];
  const mixedConfigs: AgentRunConfigEvent[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("list_markdown_files", {}),
      () => responseWithContent("Vault answer"),
      () => responseWithToolCall("list_markdown_files", {}),
      () => responseWithContent("Mixed answer"),
    ],
  });

  await runAgentMission({
    prompt: "What do my notes say about me?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => vaultConfigs.push(event),
    },
  });

  await runAgentMission({
    prompt: "Look through my vault and summarize this current note.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => mixedConfigs.push(event),
    },
  });

  const vaultConfig = vaultConfigs.at(-1);
  const mixedConfig = mixedConfigs.at(-1);
  assert.equal(vaultConfig?.missionMode, "vault_context_answer");
  assert.equal(vaultConfig?.contextScope, "vault");
  assert.equal(vaultConfig?.currentNoteContext, false);
  assert.equal(vaultConfig?.vaultContext, true);
  assert.equal(mixedConfig?.missionMode, "vault_context_answer");
  assert.equal(mixedConfig?.contextScope, "vault_and_current_note");
  assert.equal(mixedConfig?.currentNoteContext, true);
  assert.equal(mixedConfig?.vaultContext, true);
});

test("run config reports browse-only vault routes as vault context", async () => {
  const configs: AgentRunConfigEvent[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("list_current_folder", {}),
      () => responseWithContent("Vault placement answer"),
    ],
  });

  await runAgentMission({
    prompt: "Browse the vault folders and suggest where this note belongs.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].missionMode, "vault_context_answer");
  assert.equal(configs[0].contextScope, "vault_and_current_note");
  assert.equal(configs[0].vaultContext, true);
  assert.equal(configs[0].currentNoteContext, true);
  assert.equal(configs[0].route, "grounded_workflow");
  assert.equal(configs[0].slowPathReason, "needs_vault_context");
});

test("run config reports structured dependency blockers", async () => {
  const configs: AgentRunConfigEvent[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Four.")],
  });

  await runAgentMission({
    prompt: "What is 2+2?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {
      app: {} as never,
      settings: createRunnerSettings({
        modelProvider: "openai_compatible",
        openAiCompatibleApiKey: "",
        requestTimeoutMs: 1000,
      }),
      originalPrompt: "What is 2+2?",
      httpTransport: async () => ({
        status: 500,
        headers: {},
        json: {},
      }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  const dependencyStatus = configs.at(-1)?.dependencyStatus ?? [];
  const providerAuth = dependencyStatus.find(
    (item) => item.category === "provider_auth",
  );
  const modelTimeout = dependencyStatus.find(
    (item) => item.category === "model_timeout",
  );
  const vaultApi = dependencyStatus.find(
    (item) => item.category === "obsidian_vault",
  );
  assert.equal(providerAuth?.status, "blocked");
  assert.match(providerAuth?.nextAction ?? "", /API key/i);
  assert.equal(modelTimeout?.status, "degraded");
  assert.equal(vaultApi?.status, "blocked");
});

test("web append prompts expose web and current-note write tools without path CRUD", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/mcp" }),
      () => responseWithToolCall("append_to_current_file", { text: "Summary" }),
    ],
  });

  await runAgentMission({
    prompt: "Research MCP servers and append a concise cited summary to this note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(!toolNames.includes("read_current_file"));
  assert.ok(toolNames.includes("web_search"));
  assert.ok(toolNames.includes("web_fetch"));
  assert.ok(toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("list_folder"));
  assert.ok(!toolNames.includes("get_path_info"));
  assert.ok(!toolNames.includes("create_file"));
  assert.ok(!toolNames.includes("append_file"));
  assert.ok(!toolNames.includes("replace_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
});

test("named source paths do not turn a current-note append into path replace tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: Array.from({ length: 12 }, () =>
      () => responseWithContent("More source work is required."),
    ),
  });

  await runAgentMission({
    prompt:
      "Read Sources/Alpha.md and Sources/Beta.md, synthesize two findings, and append them to the current note. Do not replace existing text.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("read_file"));
  assert.ok(toolNames.includes("append_to_current_file"));
  assert.ok(
    chatRequests.some((request) =>
      request.tools?.some(
        (tool) => tool.function.name === "append_to_current_file",
      ),
    ),
  );
  assert.ok(!toolNames.includes("append_file"));
  assert.ok(!toolNames.includes("replace_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
});

test("semantic expansion with explicit append does not authorize whole-note replacement", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const prompt =
    "Explore the vault deeply, expand to related notes, and append a grounded synthesis to the current note.";
  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("More vault work is required.")],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({ maxAgentSteps: 1 }),
    } as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests.at(-1)?.tools?.map(
    (tool) => tool.function.name,
  ) ?? [];
  assert.ok(
    toolNames.includes("semantic_search_notes"),
    JSON.stringify(chatRequests.map((request) => request.tools?.map((tool) => tool.function.name) ?? [])),
  );
  assert.ok(toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
});

test("mixed current-note rename and web research keeps grounded web tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("Research remains incomplete."),
    ],
  });

  await runAgentMission({
    prompt:
      'Rename the current note to "Durable Target", then research with deep web sources.',
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({ maxAgentSteps: 1 }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.equal(configs[0]?.route, "grounded_workflow");
  assert.ok(toolNames.includes("rename_current_file"));
  assert.ok(toolNames.includes("web_search"));
  assert.ok(toolNames.includes("web_fetch"));
});

test("premature current-note append is rejected until required web fetch completes", async () => {
  const prompt =
    "Research MCP servers on the web and append a concise summary with citations to this note.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const traces: AgentTraceEvent[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          query: "MCP servers",
          results: [
            {
              title: "MCP overview",
              snippet: "MCP servers expose tools and resources.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "MCP overview",
          url: "https://example.com/mcp",
          content:
            "MCP servers expose tools and resources through a standard protocol.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const allowedAppend =
    "MCP servers expose tools and resources through a standard protocol. Source: https://example.com/mcp";
  let verifiedAppend = "";
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "PREMATURE APPEND MUST NEVER REACH THE NOTE",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/mcp",
        }),
      () =>
        responseWithContent(allowedAppend),
      (request) => {
        const passageId = getPassageCitationIds(request)[0];
        assert.ok(passageId);
        verifiedAppend = `${allowedAppend} [${passageId}]`;
        return responseWithContent(verifiedAppend);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onTrace: (event) => traces.push(event),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch", "append_to_current_file"],
  );
  assert.equal(
    executedCalls.filter((call) => call.name === "append_to_current_file")
      .length,
    1,
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].toolName, "append_to_current_file");
  assert.equal(receipts[0].path, "Current.md");
  assert.equal(
    vault.content.get("Current.md"),
    `Initial note\n${verifiedAppend}`,
  );
  assert.doesNotMatch(
    vault.content.get("Current.md") ?? "",
    /PREMATURE APPEND/,
  );

  const rejected = traces.find(
    (event) =>
      event.kind === "tool_rejected" &&
      event.toolName === "append_to_current_file" &&
      event.error?.code === "plan_dependency_violation",
  );
  assert.ok(rejected, "the premature append must produce an observable dependency rejection");
  assert.match(
    rejected.message,
    /authoritative mission node .* is not on the ready frontier/i,
  );

  const ledgerMarkdown = [...vault.content.entries()]
    .filter(([path]) => /^Agent Runs\/.+\.md$/u.test(path))
    .map(([, content]) => content)
    .find((content) => /## Mission Ledger/u.test(content));
  assert.ok(ledgerMarkdown, "the run must persist its mission plan");
  const ledgerJson = /## Mission Ledger\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(
    ledgerMarkdown,
  )?.[1];
  assert.ok(ledgerJson, "the persisted mission ledger JSON must be readable");
  const ledger = JSON.parse(ledgerJson) as {
    missionPlan?: {
      tasks?: Array<{
        id?: string;
        allowedTools?: string[];
        receiptIds?: string[];
      }>;
    };
  };
  const taskAct = ledger.missionPlan?.tasks?.find(
    (task) =>
      task.id === "task-act" ||
      task.allowedTools?.includes("append_to_current_file"),
  );
  assert.ok(taskAct);
  assert.equal(taskAct.receiptIds?.length, 2);
  assert.ok(taskAct.receiptIds?.some((id) => id.startsWith("receipt:")));
});

test("sourced streaming writeback keeps the write tool visible but stages its payload", async () => {
  const prompt =
    "Research MCP servers and append a concise cited summary with source URLs to this note.";
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "Current note",
  });

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/mcp" }),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "MCP server cited summary. Source: https://example.com/mcp",
        }),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  const writeStepToolNames =
    chatRequests[2].tools?.map((tool) => tool.function.name) ?? [];

  assert.ok(firstStepToolNames.includes("web_search"));
  assert.ok(firstStepToolNames.includes("web_fetch"));
  assert.ok(!firstStepToolNames.includes("append_to_current_file"));
  assert.ok(writeStepToolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.ok(
    statuses.some((message) =>
      /Held append_to_current_file before mutation.*requires final passage verification/i.test(
        message,
      ),
    ),
  );
  assert.ok(
    !statuses.some((message) =>
      /Rejected unavailable tool: (web_search|append_to_current_file|replace_current_file)/.test(
        message,
      ),
    ),
  );
  assert.equal(vault.content.get("Current.md"), "Current note");
});

test("broad vault mutation without a target removes write tools and records no write receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const receipts: AgentRunReceipt[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt: "Update my whole vault with this project summary.",
    content: "Do not overwrite this note.",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithContent("Which file or folder should I update?"),
    ],
  });

  await runAgentMission({
    prompt: "Update my whole vault with this project summary.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onRunConfig: (event) => configs.push(event),
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const firstRequest = chatRequests[0] ?? streamRequests[0];
  assert.ok(firstRequest);
  const toolNames = firstRequest.tools?.map((tool) => tool.function.name) ?? [];
  assert.equal(configs[0].writeAutonomy, false);
  assert.equal(configs[0].autonomyScope.read.vault, true);
  assert.equal(configs[0].autonomyScope.write.currentNote, false);
  assert.deepEqual(toolNames, []);
  assert.deepEqual(receipts, []);
  assert.equal(vault.content.get("Current.md"), "Do not overwrite this note.");
});

test("BYOK research binds initiating-note authority only to a real active Markdown note", async () => {
  const prompt = [
    "Deeply research a small dependency-free Python CRDT library for marker E2E_BYOK_SCOPE_UNIT.",
    "Use and fetch at least four independent sources exposed through the configured research backend. Reconcile their guidance on state-based G-Counter joins and observed-remove sets, including convergence, idempotence, concurrent add versus remove, and practical validation.",
    "Write accepted research into the initiating note as an implementation brief, then publish that accepted research to one Linear implementation issue in the configured destination.",
    "The accepted package is executable code work for trusted repository key byok-autonomous-python and validation requirement key byok-autonomous-python-validation.",
    "The issue must carry the source citations and behavioral acceptance contract: a GCounter supports replica-local non-negative increments, value, and convergent pointwise-max merge; an ORSet supports add, observed remove, value, union-style merge, concurrent add survival, and convergence after all tags are observed and removed.",
    "Require the public implementation and README to carry proof marker E2E_BYOK_SCOPE_UNIT, but leave filenames, internal design, workspace identity, and implementation choices to the coding agent.",
    "Do not implement code or publish to GitHub in this phase. Finish only after accepted-research lineage, Linear provider readback, and the note backlink are durable.",
  ].join(" ");
  const run = async (hasActiveMarkdownNote: boolean) => {
    const requests: ModelChatRequest[] = [];
    const configs: AgentRunConfigEvent[] = [];
    const vault = createRunnerVaultContext({ prompt });
    vault.context.settings.modelRouterMode = "off";
    vault.context.settings.linearEnabled = true;
    vault.context.settings.githubEnabled = true;
    if (!hasActiveMarkdownNote) {
      vault.context.getCurrentMarkdownFile = () => null;
      (
        vault.context.app as unknown as {
          workspace: { getActiveFile: () => null };
        }
      ).workspace.getActiveFile = () => null;
    }
    const baseRegistry = createCollectingRegistry([]);
    const registry: ToolRegistry = {
      ...baseRegistry,
      getDefinitions: () => [
        ...baseRegistry.getDefinitions(),
        {
          type: "function",
          function: {
            name: "publish_research_to_linear",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        },
        ...[
          "github_list_tags",
          "github_get_issue",
          "publish_verified_code_to_github",
        ].map((name) => ({
          type: "function" as const,
          function: {
            name,
            parameters: {
              type: "object" as const,
              properties: {},
              additionalProperties: false,
            },
          },
        })),
      ],
    };

    await runAgentMission({
      prompt,
      modelClient: createClient({
        chatRequests: requests,
        chatResponders: [() => responseWithContent("More tool work is required.")],
      }),
      toolRegistry: registry,
      toolContext: vault.context,
      enableStreaming: false,
      maxSteps: 1,
      events: {
        onRunConfig: (event) => configs.push(event),
      },
    });

    return {
      config: configs[0],
      toolNames:
        requests[0]?.tools?.map((tool) => tool.function.name) ?? [],
      requestTools: requests.map((request) => ({
        phase: request.evidencePhase ?? null,
        tools: request.tools?.map((tool) => tool.function.name) ?? [],
      })),
    };
  };

  const bound = await run(true);
  assert.equal(bound.config.autonomyScope.write.currentNote, true);
  assert.equal(bound.config.writeAutonomy, true);
  assert.ok(bound.config.allowedToolNames.includes("web_search"));
  assert.ok(bound.config.allowedToolNames.includes("web_fetch"));
  assert.ok(bound.config.allowedToolNames.includes("append_to_current_file"));
  assert.ok(
    bound.config.allowedToolNames.includes("publish_research_to_linear"),
  );
  assert.ok(!bound.config.allowedToolNames.includes("replace_current_file"));
  assert.ok(
    !bound.config.allowedToolNames.some(
      (name) =>
        name === "publish_verified_code_to_github" ||
        name.startsWith("github_"),
    ),
  );

  const unbound = await run(false);
  assert.equal(unbound.config.autonomyScope.write.currentNote, false);
  assert.ok(!unbound.config.allowedToolNames.includes("append_to_current_file"));
  assert.ok(!unbound.config.allowedToolNames.includes("replace_current_file"));
  assert.ok(
    !unbound.config.allowedToolNames.includes("publish_research_to_linear"),
  );
  assert.ok(
    !unbound.toolNames.includes("append_to_current_file"),
    JSON.stringify(unbound.requestTools),
  );
  assert.ok(!unbound.toolNames.includes("replace_current_file"));
});

test("BYOK Phase A authority graph excludes future GitHub tools and redundant note writes", async () => {
  const prompt = buildByokPhaseAResearchPrompt({
    marker: "E2E_BYOK_AUTHORITY_UNIT",
    profileKey: "byok-autonomous-python",
    validationProfileKey: "byok-autonomous-python-validation",
  });
  assert.match(
    prompt,
    /Additional implementation files are allowed only when the accepted contract requires them\./u,
  );
  assert.doesNotMatch(prompt, /any additional files/iu);
  assert.equal(hasExplicitResearchPublicationIntent(prompt), true);
  assert.equal(hasExplicitCodeExecutionProhibition(prompt), true);
  assert.equal(hasCodeDeliverableIntent(prompt), false);
  assert.deepEqual(getRequiredCodeWorkflowToolNames(prompt), []);
  const forbiddenGitHubToolNames = new Set([
    "github_list_tags",
    "github_get_issue",
    "publish_verified_code_to_github",
  ]);
  const codeRegistry = createCodeV2RoutingRegistry();
  const codeToolNames = codeRegistry
    .getDefinitions()
    .map((definition) => definition.function.name);
  const forbiddenToolNames = new Set([
    ...forbiddenGitHubToolNames,
    ...codeToolNames,
  ]);
  const requests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const plannerCatalogs: MissionGraphHostCatalogNode[][] = [];
  const graphs: Array<{
    nodes: Record<string, { allowedTools: string[] }>;
  }> = [];
  const traces: string[] = [];
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.modelRouterMode = "authority";
  vault.context.settings.speechActSemanticRescueMode = "authority";
  vault.context.settings.workingMode = "automatic";
  vault.context.settings.linearEnabled = true;
  vault.context.settings.githubEnabled = true;
  const baseRegistry = createCollectingRegistry([]);
  const fixtureToolNames = [
    "publish_research_to_linear",
    ...forbiddenGitHubToolNames,
  ];
  const fixtureDescriptors = new Map<string, ToolDescriptor>(
    fixtureToolNames.map((name) => {
      const read = name === "github_list_tags" || name === "github_get_issue";
      return [
        name,
        {
          version: 1,
          name,
          capability: {
            system: name.startsWith("github_") ||
              name === "publish_verified_code_to_github"
              ? "github"
              : "linear",
            resourceType: read ? "catalog" : "publication",
            action: read ? "read" : "publish",
          },
          effect: read ? "read" : "publish",
          risk: read ? "low" : "critical",
          approval: {
            allowPromptGrant: read,
            allowPersistentGrant: false,
            fallback: read ? "none" : "exact",
          },
          execution: {
            preparation: read ? "none" : "required",
            cacheable: read,
            parallelSafe: read,
          },
          durability: {
            journal: !read,
            receipt: !read,
            readback: read ? "none" : "required",
            reconciliation: read ? "none" : "required",
          },
          allowedPrincipals: ["single_agent"],
          ...(read ? {} : { receiptKind: "external_action" as const }),
        },
      ];
    }),
  );
  const fixtureDefinitions = [
    {
      type: "function" as const,
      function: {
        name: "publish_research_to_linear",
        parameters: {
          type: "object" as const,
          properties: {},
          additionalProperties: false,
        },
      },
    },
    ...[...forbiddenGitHubToolNames].map((name) => ({
      type: "function" as const,
      function: {
        name,
        parameters: {
          type: "object" as const,
          properties: {},
          additionalProperties: false,
        },
      },
    })),
  ];
  const combinedDefinitions = [
    ...baseRegistry.getDefinitions(),
    ...codeRegistry.getDefinitions(),
    ...fixtureDefinitions,
  ];
  const uniqueDefinitions = [
    ...new Map(
      combinedDefinitions.map((definition) => [
        definition.function.name,
        definition,
      ]),
    ).values(),
  ];
  const registry: ToolRegistry = {
    ...baseRegistry,
    getDefinitions: () => uniqueDefinitions,
    getDescriptor: (name) =>
      fixtureDescriptors.get(name) ??
      codeRegistry.getDescriptor?.(name) ??
      baseRegistry.getDescriptor?.(name) ??
      null,
  };
  const respond = (request: ModelChatRequest): ModelChatResponse => {
    requests.push(cloneRequest(request));
    if (isMissionRouterFormat(request)) {
      return responseWithContent(
        JSON.stringify({
          mode: "code_workflow",
          writeScope: "none",
          needsWebEvidence: true,
          needsVaultContext: true,
          needsCodeExecution: true,
          wordTarget: null,
          confidence: 0.97,
          rationale:
            "The later executable outcome appears to require code immediately.",
        }),
      );
    }
    if (isMissionGraphPlannerFormat(request)) {
      const catalog = parseMissionGraphHostCatalog(request);
      plannerCatalogs.push(catalog);
      return responseWithContent(
        JSON.stringify({
          confidence: 0.96,
          nodes: catalog
            .filter((node) => node.id !== "final")
            .map((node) => ({
              id: node.id,
              objective: node.hostObjective,
              dependencyIds: [...node.hostDependencyIds],
            })),
        }),
      );
    }
    return responseWithContent("The bounded Phase A work remains in progress.");
  };
  const client: ModelClient = {
    chat: async (request) => respond(request),
    streamChat: async (request, events = {}) => {
      const response = respond(request);
      if (response.message.content) {
        events.onContentDelta?.(response.message.content);
      }
      return response;
    },
  };

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: true,
    maxSteps: 1,
    events: {
      onRunConfig: (event) => configs.push(event),
      onMissionGraphUpdate: (graph) => graphs.push(graph),
      onTrace: (event) => traces.push(event.message),
    },
  });

  assert.ok(
    plannerCatalogs.length > 0,
    `authority mode must invoke the graph planner; requests=${JSON.stringify(
      requests.map((request) => request.format?.required ?? null),
    )}; traces=${traces.join(" | ")}`,
  );
  assert.ok(
    traces.some((message) =>
      /Structured MissionGraphV3 accepted as authoritative/iu.test(message)
    ),
    traces.join(" | "),
  );
  const assertNoForbidden = (
    names: readonly string[],
    surface: string,
  ) => {
    assert.deepEqual(
      names.filter((name) => forbiddenToolNames.has(name)),
      [],
      `${surface}: ${names.join(", ")}`,
    );
  };
  for (const [index, config] of configs.entries()) {
    assertNoForbidden(config.allowedToolNames, `run config ${index}`);
  }
  for (const [index, catalog] of plannerCatalogs.entries()) {
    for (const node of catalog) {
      assertNoForbidden(node.allowedTools, `planner catalog ${index}/${node.id}`);
    }
  }
  for (const [index, request] of requests.entries()) {
    assertNoForbidden(
      request.tools?.map((tool) => tool.function.name) ?? [],
      `model request ${index}`,
    );
  }
  for (const [index, graph] of graphs.entries()) {
    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      assertNoForbidden(node.allowedTools, `graph ${index}/${nodeId}`);
    }
  }
  const catalogTools = plannerCatalogs.flatMap((catalog) =>
    catalog.flatMap((node) => node.allowedTools)
  );
  const graphTools = graphs.flatMap((graph) =>
    Object.values(graph.nodes).flatMap((node) => node.allowedTools)
  );
  assert.equal(
    catalogTools.includes("append_to_current_file"),
    false,
    `atomic publication must own note writeback; catalog=${catalogTools.join(",")}`,
  );
  assert.equal(
    graphTools.includes("append_to_current_file"),
    false,
    `atomic publication must not create an append node; graph=${graphTools.join(",")}`,
  );
  assert.equal(
    graphTools.filter((name) => name === "publish_research_to_linear").length,
    1,
  );
  assert.equal(
    catalogTools.includes("linear_create_issue"),
    false,
    `atomic publication must own issue creation; catalog=${catalogTools.join(",")}`,
  );
  assert.equal(
    graphTools.includes("linear_create_issue"),
    false,
    `atomic publication must not create a second issue node; graph=${graphTools.join(",")}`,
  );
  const runtimeSnapshot = [...vault.content.values()]
    .map((markdown) => parseMissionRuntimeSnapshotFromMarkdown(markdown))
    .find((snapshot) =>
      snapshot?.originalMission.includes("E2E_BYOK_AUTHORITY_UNIT")
    );
  assert.ok(runtimeSnapshot);
  assert.equal(
    runtimeSnapshot.operationGoals.current_note_content,
    "not_requested",
    "the atomic publication owns accepted-note writeback and must not create a second content debt",
  );
});

test("BYOK Phase A discards held terminal prose and accepts canonical receipt proof exactly once", async () => {
  const marker = "E2E_BYOK_RECEIPT_TERMINAL_UNIT";
  const prompt = buildByokPhaseAResearchPrompt({
    marker,
    profileKey: "byok-autonomous-python",
    validationProfileKey: "byok-autonomous-python-validation",
  });
  const strictPublication =
    completedResearchPublicationReceiptFixture("created");
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt(strictPublication),
    true,
    "the regression fixture must satisfy the production composite proof contract",
  );
  assert.equal(
    isCompletedAcceptedResearchPublicationReceipt({
      ...strictPublication,
      readback: { status: "not_verified" },
    }),
    false,
    "an unverified generic receipt must not satisfy terminal publication proof",
  );

  const sourceUrls = [
    "https://crdt-one.example.com/g-counter",
    "https://crdt-two.example.org/or-set",
    "https://crdt-three.example.net/convergence",
    "https://crdt-four.example.dev/validation",
  ];
  const requests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const assistantDeltas: string[] = [];
  const statuses: string[] = [];
  const traces: AgentTraceEvent[] = [];
  const graphUpdates: Array<{
    nodes: Record<string, { status: string; allowedTools: string[] }>;
  }> = [];
  const plannerCatalogs: MissionGraphHostCatalogNode[][] = [];
  const runReceipts: AgentRunReceipt[] = [];
  let terminalAgentRequestOrdinal: number | null = null;
  let terminalResponseReturned = false;
  let optionalLinearReadSelected = false;

  const vault = createRunnerVaultContext({
    prompt,
    content: `# Autonomous BYOK CRDT research ${marker}\n`,
  });
  vault.content.set(LINEAR_ISSUE_TEMPLATE_PATH, LINEAR_ISSUE_TEMPLATE_V1);
  vault.context.settings.modelRouterMode = "authority";
  vault.context.settings.speechActSemanticRescueMode = "authority";
  vault.context.settings.workingMode = "automatic";
  vault.context.settings.linearEnabled = true;
  vault.context.settings.githubEnabled = true;
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.settings.agenticReflexEnabled = true;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          query: "state-based G-Counter observed-remove set convergence",
          results: sourceUrls.map((url, index) => ({
            title: `Independent CRDT source ${index + 1}`,
            url,
            snippet:
              "State-based CRDT merge, observed-remove semantics, convergence, and validation guidance.",
          })),
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      const url = JSON.parse(
        typeof request.body === "string" ? request.body : "{}",
      )?.url;
      const sourceIndex = sourceUrls.indexOf(url);
      assert.notEqual(sourceIndex, -1, `unexpected source fetch: ${url}`);
      return {
        status: 200,
        headers: {},
        json: {
          title: `Independent CRDT source ${sourceIndex + 1}`,
          url,
          content: [
            "A state-based G-Counter stores replica-local non-negative components and computes value by summing them.",
            "Its merge is the pointwise maximum, which is associative, commutative, and idempotent, so replicas converge.",
            "An observed-remove set tracks unique add tags, removes only observed tags, preserves a concurrent unseen add, and converges under union-style merge.",
            "Validation should cover repeated merge, reordered delivery, concurrent add versus remove, and removal after every tag becomes observed.",
          ].join(" "),
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const publicationTool: AgentTool = {
    name: "publish_research_to_linear",
    description:
      "Test-only exact accepted-research note and Linear publication fixture.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    descriptor: {
      version: 1,
      name: "publish_research_to_linear",
      capability: {
        system: "linear",
        resourceType: "publication",
        action: "publish",
      },
      effect: "publish",
      risk: "high",
      approval: {
        allowPromptGrant: false,
        allowPersistentGrant: false,
        fallback: "exact",
      },
      execution: {
        preparation: "none",
        cacheable: false,
        parallelSafe: false,
      },
      durability: {
        journal: true,
        receipt: true,
        readback: "required",
        reconciliation: "required",
      },
      allowedPrincipals: ["single_agent"],
      receiptKind: "external_action",
    },
    async execute() {
      return structuredClone(strictPublication.output);
    },
    async executeResult() {
      const { output, ...receipt } = structuredClone(strictPublication);
      return {
        ok: true,
        toolName: "publish_research_to_linear",
        output,
        receipt,
        mutationState: "applied",
      };
    },
  };
  const unplannedLinearCommentsTool: AgentTool = {
    name: "linear_list_comments",
    description:
      "Test-only optional Linear read that must not enter the exact Phase A frontier.",
    parameters: {
      type: "object",
      properties: {
        issueId: { type: "string" },
      },
      required: ["issueId"],
      additionalProperties: false,
    },
    descriptor: {
      version: 1,
      name: "linear_list_comments",
      capability: {
        system: "linear",
        resourceType: "comment",
        action: "list",
      },
      effect: "read",
      risk: "low",
      approval: {
        allowPromptGrant: true,
        allowPersistentGrant: true,
        fallback: "none",
      },
      execution: {
        preparation: "none",
        cacheable: true,
        parallelSafe: true,
      },
      durability: {
        journal: false,
        receipt: false,
        readback: "none",
        reconciliation: "none",
      },
      allowedPrincipals: ["single_agent", "lead", "researcher"],
    },
    async execute() {
      throw new Error(
        "An unplanned Linear comments read must never execute in exact Phase A.",
      );
    },
  };
  const optionalLinearIssueReadTool: AgentTool = {
    name: "linear_get_issue",
    description:
      "Test-only optional Linear issue read selected by the planner but never required after publication.",
    parameters: {
      type: "object",
      properties: {
        issueId: { type: "string" },
      },
      required: ["issueId"],
      additionalProperties: false,
    },
    descriptor: {
      version: 1,
      name: "linear_get_issue",
      capability: {
        system: "linear",
        resourceType: "issue",
        action: "read",
      },
      effect: "read",
      risk: "low",
      approval: {
        allowPromptGrant: true,
        allowPersistentGrant: true,
        fallback: "none",
      },
      execution: {
        preparation: "none",
        cacheable: true,
        parallelSafe: true,
      },
      durability: {
        journal: false,
        receipt: false,
        readback: "none",
        reconciliation: "none",
      },
      allowedPrincipals: ["single_agent", "lead", "researcher"],
    },
    async execute() {
      throw new Error(
        "The optional Linear issue read must be cancelled after receipt-backed publication.",
      );
    },
  };
  const publicationRegistry = new DefaultToolRegistry([
    publicationTool,
    unplannedLinearCommentsTool,
    optionalLinearIssueReadTool,
  ]);
  const baseRegistry = createDefaultToolRegistry();
  const definitions = [
    ...new Map(
      [
        ...baseRegistry.getDefinitions(),
        ...publicationRegistry.getDefinitions(),
      ].map((definition) => [definition.function.name, definition]),
    ).values(),
  ];
  const registry: ToolRegistry = {
    getDefinitions: () => definitions,
    getDescriptor: (name) =>
      publicationRegistry.getDescriptor(name) ??
      baseRegistry.getDescriptor?.(name) ??
      null,
    execute: async (call, context) => {
      executedCalls.push(structuredClone(call));
      return publicationRegistry.getDescriptor(call.name)
        ? publicationRegistry.execute(call, context)
        : baseRegistry.execute(call, context);
    },
  };

  const respond = (request: ModelChatRequest): ModelChatResponse => {
    if (terminalResponseReturned) {
      throw new Error(
        "receipt-backed terminal completion must not retry the model",
      );
    }
    requests.push(cloneRequest(request));
    if (isMissionRouterFormat(request)) {
      return responseWithContent(
        JSON.stringify({
          mode: "deep_research",
          writeScope: "current_note_append",
          needsWebEvidence: true,
          needsVaultContext: true,
          needsCodeExecution: false,
          wordTarget: null,
          confidence: 0.99,
          rationale:
            "This phase gathers four web sources and atomically publishes accepted research to the initiating note and Linear.",
        }),
      );
    }
    if (isMissionGraphPlannerFormat(request)) {
      const catalog = parseMissionGraphHostCatalog(request);
      plannerCatalogs.push(catalog);
      const requiredNodes = catalog.filter(
        (node) => node.required && node.id !== "final",
      );
      const optionalLinearRead = catalog.find(
        (node) =>
          !node.required &&
          node.allowedTools.includes("linear_get_issue"),
      );
      assert.ok(
        optionalLinearRead,
        "Phase A planner catalog must expose the optional provider read used by the live regression",
      );
      optionalLinearReadSelected = true;
      return responseWithContent(
        JSON.stringify({
          confidence: 0.99,
          nodes: [...requiredNodes, optionalLinearRead].map((node) => ({
              id: node.id,
              objective: node.hostObjective,
              dependencyIds: [...node.hostDependencyIds],
            })),
        }),
      );
    }
    if (request.evidencePhase !== "agent_step") {
      return responseWithContent("");
    }

    const toolNames =
      request.tools?.map((tool) => tool.function.name) ?? [];
    if (
      toolNames.includes("web_search") &&
      !executedCalls.some((call) => call.name === "web_search")
    ) {
      return responseWithToolCall(
        "web_search",
        { query: "state-based G-Counter observed-remove set convergence" },
        "",
      );
    }
    if (
      toolNames.includes("web_fetch") &&
      executedCalls.filter((call) => call.name === "web_fetch").length <
        sourceUrls.length
    ) {
      const fetched = new Set(
        executedCalls
          .filter((call) => call.name === "web_fetch")
          .map((call) => String(call.arguments.url ?? "")),
      );
      const nextUrl = sourceUrls.find((url) => !fetched.has(url));
      assert.ok(nextUrl);
      return responseWithToolCall("web_fetch", { url: nextUrl }, "");
    }
    if (
      toolNames.includes("read_template") &&
      !executedCalls.some((call) => call.name === "read_template")
    ) {
      return responseWithToolCall(
        "read_template",
        { path: LINEAR_ISSUE_TEMPLATE_PATH },
        "",
      );
    }
    if (toolNames.includes(publicationTool.name)) {
      return responseWithToolCall(publicationTool.name, {}, "");
    }
    if (
      toolNames.includes("read_current_file") &&
      !executedCalls.some((call) => call.name === "read_current_file")
    ) {
      return responseWithToolCall("read_current_file", {}, "");
    }

    terminalAgentRequestOrdinal = requests.filter(
      (candidate) => candidate.evidencePhase === "agent_step",
    ).length;
    terminalResponseReturned = true;
    return responseWithContent(
      "UNVERIFIED TERMINAL PROSE MUST BE DISCARDED IN FAVOR OF THE CANONICAL RECEIPT.",
    );
  };
  const client: ModelClient = {
    chat: async (request) => respond(request),
    streamChat: async (request, events = {}) => {
      const response = respond(request);
      if (response.message.content) {
        events.onContentDelta?.(response.message.content);
      }
      return response;
    },
  };

  await runAgentMission({
    prompt,
    runId: "segment:run:42",
    modelClient: client,
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 12,
    events: {
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onMissionGraphUpdate: (graph) => graphUpdates.push(graph),
      onReceipt: (receipt) => runReceipts.push(receipt),
      onRunComplete: (event) => completions.push(event),
      onStatus: (message) => statuses.push(message),
      onTrace: (event) => traces.push(event),
    },
  });

  assert.equal(plannerCatalogs.length > 0, true);
  assert.equal(optionalLinearReadSelected, true);
  assert.equal(completions.length, 1);
  assert.equal(
    completions[0]?.stopReason,
    "write_completed",
    JSON.stringify({
      completion: completions[0],
      executed: executedCalls.map((call) => call.name),
      agentFrontiers: requests
        .filter((request) => request.evidencePhase === "agent_step")
        .map((request) =>
          request.tools?.map((tool) => tool.function.name) ?? []
        ),
      latestGraph: graphUpdates.at(-1)?.nodes,
      statuses,
      traceErrors: traces
        .filter((trace) => trace.kind === "error")
        .map((trace) => ({
          message: trace.message,
          code: trace.error?.code,
        })),
    }),
  );
  assert.deepEqual(assistantDeltas, []);
  assert.equal(
    executedCalls.filter(
      (call) => call.name === "publish_research_to_linear",
    ).length,
    1,
  );
  assert.equal(
    executedCalls.filter((call) => call.name === "web_search").length,
    1,
  );
  assert.equal(
    executedCalls.filter((call) => call.name === "web_fetch").length,
    4,
  );
  assert.equal(
    executedCalls.filter((call) => call.name === "linear_get_issue").length,
    0,
    "an unread optional provider check cannot become mandatory after publication",
  );
  assert.equal(
    runReceipts.some(isCompletedAcceptedResearchPublicationReceipt),
    true,
  );

  const agentRequests = requests.filter(
    (request) => request.evidencePhase === "agent_step",
  );
  assert.equal(
    agentRequests.some((request) =>
      request.tools?.some(
        (tool) => tool.function.name === "linear_list_comments",
      ),
    ),
    false,
    "proof-bound Phase A must not expose unrelated capability reads or mint dynamic retry debt",
  );
  assert.equal(terminalResponseReturned, true);
  assert.equal(
    terminalAgentRequestOrdinal,
    agentRequests.length,
    "the held terminal turn must be the final model request",
  );
  assert.deepEqual(
    agentRequests.at(-1)?.tools?.map((tool) => tool.function.name) ?? [],
    [],
    "the receipt-terminal turn must not expose an optional-only set-loose frontier",
  );
  const persistedLedger = [...vault.content.values()]
    .map((markdown) => parseMissionLedgerFromMarkdown(markdown))
    .find((ledger) => ledger?.mission.includes(marker));
  assert.ok(persistedLedger);
  assert.equal(persistedLedger.status, "complete");
  assert.equal(persistedLedger.acceptance?.status, "pass");

  const graphMarkdown = [...vault.content.entries()].find(([path]) =>
    path.startsWith("Agent Runs/Mission Graphs/")
  )?.[1];
  assert.ok(graphMarkdown);
  const graphRecord = await parseMissionGraphStoreRecordFromMarkdown(
    graphMarkdown,
  );
  assert.ok(graphRecord);
  assert.equal(graphRecord.graph.nodes.final?.status, "complete");
  const optionalLinearNode = Object.entries(graphRecord.graph.nodes).find(
    ([nodeId, node]) =>
      nodeId.startsWith("optional-") &&
      node.allowedTools.includes("linear_get_issue"),
  )?.[1];
  assert.ok(optionalLinearNode);
  assert.equal(optionalLinearNode.status, "cancelled");
  assert.equal(graphUpdates.at(-1)?.nodes.final?.status, "complete");
});

test("runner records tool evidence and receipts into the durable mission ledger", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt: "Search the web for MCP sources and cite one source.",
    content: "Initial note",
  });
  vault.context.settings.researchMemoryEnabled = false;
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/mcp" }),
      () => responseWithContent("Draft answer with https://example.com/mcp"),
      (request) =>
        responseWithContent(
          `Cited answer with https://example.com/mcp ${getPassageCitationIds(request)[0] ?? ""}`.trim(),
        ),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP sources and cite one source.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const ledgerEntry = [...vault.content.entries()].find(
    ([path, content]) =>
      /^Agent Runs\/.+\.md$/.test(path) && /## Mission Ledger/u.test(content),
  );
  assert.ok(ledgerEntry);
  assert.match(ledgerEntry[1], /"kind": "web_source"/);
  assert.match(ledgerEntry[1], /https:\/\/example\.com\/mcp/);
  assert.deepEqual(receipts, []);

  const appendVault = createRunnerVaultContext({
    prompt: "Append the result to the current note.",
    content: "Initial note",
  });
  const appendClient = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "Ledger receipt" }),
    ],
  });
  const appendReceipts: AgentRunReceipt[] = [];

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: appendClient,
    toolRegistry: createCollectingRegistry([]),
    toolContext: appendVault.context,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => appendReceipts.push(receipt),
    },
  });

  const appendLedgerEntry = [...appendVault.content.entries()].find(
    ([path, content]) =>
      /^Agent Runs\/.+\.md$/.test(path) && /## Mission Ledger/u.test(content),
  );
  assert.equal(appendReceipts.length, 1);
  assert.equal(appendReceipts[0].readback?.status, "verified");
  assert.match(
    appendReceipts[0].readback?.observedFingerprint ?? "",
    /^sha256:[a-f0-9]{64}$/u,
  );
  assert.ok(appendLedgerEntry);
  assert.match(appendLedgerEntry[1], /"kind": "receipt"/);
  assert.match(appendLedgerEntry[1], /"receipts": \[/);
});

test("tool-planning preambles stay out of streamed final output", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const planningDeltas: string[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const toolStarts: string[] = [];
  const toolDone: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall(
          "web_search",
          { query: "MCP servers" },
          "Hidden tool preamble",
        ),
      () =>
        responseWithToolCall(
          "web_fetch",
          { url: "https://example.com/source" },
          "Hidden fetch preamble",
        ),
      () =>
        responseWithContent(
          "Ready to answer. Source: https://example.com/source",
        ),
    ],
    streamResponders: [
      () => responseWithContent("Final cited answer"),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onPlanningDelta: (delta) => planningDeltas.push(delta),
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onToolStart: (event) => toolStarts.push(event.name),
      onToolDone: (event) => toolDone.push(`${event.name}:${event.ok}`),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(planningDeltas.length, 3);
  assert.ok(planningDeltas.every((delta) => delta.includes("route=grounded_workflow")));
  assert.ok(
    planningDeltas.slice(0, 2).every((delta) =>
      delta.includes("tools=web_search, web_fetch"),
    ),
  );
  assert.match(planningDeltas[2], /tools=none/);
  assert.deepEqual(finalDeltas, [
    "Ready to answer. Source: https://example.com/source",
  ]);
  assert.deepEqual(assistantDeltas, [
    "Ready to answer. Source: https://example.com/source",
  ]);
  assert.ok(!assistantDeltas.join("").includes("Hidden tool preamble"));
  assert.ok(!assistantDeltas.join("").includes("Hidden fetch preamble"));
  assert.deepEqual(toolStarts, ["web_search", "web_fetch"]);
  assert.deepEqual(toolDone, ["web_search:true", "web_fetch:true"]);
});

test("streamed final answers strip special tokens split across chunks", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "< | begin",
          "_of_sentence | ><|start_header",
          "_id|>assistant<|end_header",
          "_id|>\n\nMCP servers final answer. Source: https://example.com/source<|end",
          "_of_sentence|>",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(
    finalDeltas.join(""),
    "assistant\n\nMCP servers final answer. Source: https://example.com/source",
  );
  assert.equal(
    assistantDeltas.join(""),
    "assistant\n\nMCP servers final answer. Source: https://example.com/source",
  );
  assert.ok(!finalDeltas.join("").includes("<|"));
  assert.ok(!finalDeltas.join("").includes("< |"));
});

test("tool-result final prose skips redundant streaming synthesis", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () =>
        responseWithContent(
          "Ready to answer. Source: https://example.com/source",
        ),
    ],
    streamResponders: [
      () => responseWithContentDeltas(["Final ", "answer."]),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.deepEqual(finalDeltas, [
    "Ready to answer. Source: https://example.com/source",
  ]);
});

test("empty direct model content falls back to streamed final answer", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "The Grapes of Wrath" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/grapes-of-wrath",
        }),
      () => responseWithContent("", "thinking without final prose"),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "Grounded Grapes ",
          "of Wrath final answer. Source: https://example.com/grapes-of-wrath",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for The Grapes of Wrath and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(streamRequests[0].messages.at(-1)?.role, "user");
  assert.match(
    streamRequests[0].messages.at(-1)?.content ?? "",
    /Current user mission: "Search the web for The Grapes of Wrath and summarize what you find\."/,
  );
  assert.match(
    streamRequests[0].messages.at(-1)?.content ?? "",
    /ignore it and produce the requested answer/,
  );
  assert.equal(
    streamRequests[0].messages.some(
      (message) =>
        message.role === "assistant" &&
        !message.content.trim() &&
        !message.toolCalls?.length,
    ),
    false,
  );
  assert.deepEqual(finalDeltas, [
    "Grounded Grapes of Wrath final answer. Source: https://example.com/grapes-of-wrath",
  ]);
  assert.deepEqual(assistantDeltas, [
    "Grounded Grapes of Wrath final answer. Source: https://example.com/grapes-of-wrath",
  ]);
});

test("off-topic streamed final answer is stopped before display", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const statuses: string[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "The Grapes of Wrath" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/grapes-of-wrath",
        }),
      () => responseWithContent("", "thinking without final prose"),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Compound Interest Worksheet\n\n",
          "A quarterly compounding schedule starts with a principal balance, applies a fixed annual rate, ",
          "adds each period's accrued amount to the balance, and repeats the arithmetic for the next quarter. ",
          "The method is useful for amortization tables, savings projections, and classroom finance examples. ",
          "It does not require narrative interpretation, historical context, literary analysis, or outside evidence.",
        ]),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt: "Search the web for The Grapes of Wrath and summarize what you find.",
        modelClient: client,
        toolRegistry: createRegistry([]),
        toolContext: {} as ToolExecutionContext,
        enableStreaming: true,
        events: {
          onFinalDelta: (delta) => finalDeltas.push(delta),
          onAssistantDelta: (delta) => assistantDeltas.push(delta),
          onStatus: (message) => statuses.push(message),
        },
      }),
    /drifted off topic/,
  );

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(finalDeltas, []);
  assert.deepEqual(assistantDeltas, []);
  assert.ok(
    statuses.includes(
      "Stopped model output because it drifted off topic from the current mission.",
    ),
  );
});

test("checkers Python build stops before prose fallback when Code tools are unavailable", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const statuses: string[] = [];
  const prompt =
    "Build a simple American checkers game in Python for the workspace.";

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithContent("", "thinking without final prose"),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "```python\n",
          "class CheckersGame:\n",
          "    def __init__(self):\n",
          "        self.board = []\n",
          "    def legal_moves(self, color):\n",
          "        return []\n",
          "```\n",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 0);
  assert.match(
    finalDeltas.join(""),
    /Code tool catalog is not registered[\s\S]*No model call was made/iu,
  );
  assert.ok(
    statuses.some((message) =>
      /Blocked before model loop:[\s\S]*Code tool catalog is not registered/iu.test(
        message,
      ),
    ),
  );
});

test("research then code prompts expose web and code tools together", async () => {
  const prompt =
    "Research American checkers rules with two web sources, then implement the game in Python.";
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-20T12:30:00.000Z"),
  });
  const registry = createCodeV2RoutingRegistry();
  const webAndCodeRegistry: ToolRegistry = {
    getDefinitions: () => [
      ...["web_search", "web_fetch", "read_current_file"].map((name) => ({
        type: "function" as const,
        function: {
          name,
          parameters: { type: "object" as const, properties: {} },
        },
      })),
      ...registry.getDefinitions(),
    ],
    getDescriptor: (name) => registry.getDescriptor?.(name) ?? null,
    execute: async (call) => registry.execute(call, vault.context),
  };

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("Planning research then code.")],
    }),
    toolRegistry: webAndCodeRegistry,
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 1,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  const allowed = new Set(configs[0]?.allowedToolNames ?? []);
  assert.ok(
    allowed.has("web_search"),
    `missing web_search; exposed: ${[...allowed].join(", ")}`,
  );
  assert.ok(
    allowed.has("web_fetch"),
    `missing web_fetch; exposed: ${[...allowed].join(", ")}`,
  );
  assert.ok(
    allowed.has("code_workspace_create"),
    `missing code_workspace_create; exposed: ${[...allowed].join(", ")}`,
  );
  assert.ok(
    allowed.has("code_sandbox_status"),
    `missing code_sandbox_status; exposed: ${[...allowed].join(", ")}`,
  );
  assert.deepEqual(
    getCompoundLifecycleResearchGraphToolNames(prompt),
    ["web_search", "web_fetch", "web_fetch"],
  );
});

test("checkers and end-to-end prompts expose code workspace tools", async () => {
  const scenarios = [
    "Build a simple American checkers game in Python for the workspace.",
    "I want to create the game of checkers in Python end to end following the full workflow",
  ];
  for (const prompt of scenarios) {
    const chatRequests: ModelChatRequest[] = [];
    const configs: AgentRunConfigEvent[] = [];
    const vault = createRunnerVaultContext({
      prompt,
      now: new Date("2026-07-20T12:00:00.000Z"),
    });
    await runAgentMission({
      prompt,
      modelClient: createClient({
        chatRequests,
        chatResponders: [() => responseWithContent("Planning code work.")],
      }),
      toolRegistry: createCodeV2RoutingRegistry(),
      toolContext: vault.context,
      enableStreaming: false,
      maxSteps: 1,
      events: {
        onRunConfig: (event) => configs.push(event),
      },
    });
    const allowed = new Set(configs[0]?.allowedToolNames ?? []);
    const stepTools = new Set(
      chatRequests[0]?.tools?.map((tool) => tool.function.name) ?? [],
    );
    // Catalog must admit the implementation ladder even when the first ready
    // MissionGraph slot is only code_sandbox_status (+ capability reads).
    assert.ok(
      allowed.has("code_workspace_create"),
      `${prompt} missing code_workspace_create in allowed catalog; exposed: ${[...allowed].join(", ")}`,
    );
    assert.ok(
      allowed.has("code_workspace_create_file"),
      `${prompt} missing code_workspace_create_file in allowed catalog; exposed: ${[...allowed].join(", ")}`,
    );
    assert.ok(
      stepTools.has("code_sandbox_status"),
      `${prompt} missing ready code_sandbox_status frontier; step tools: ${[...stepTools].join(", ")}`,
    );
  }
});

test("router code authority is default-off and seeds only the bounded code ladder when enabled", async () => {
  const prompt = "Use tools to handle the little project we discussed.";
  const runScenario = async (
    speechActSemanticRescueMode: "off" | "authority",
  ) => {
    const chatRequests: ModelChatRequest[] = [];
    const configs: AgentRunConfigEvent[] = [];
    const vault = createRunnerVaultContext({
      prompt,
      now: new Date("2026-07-25T12:00:00.000Z"),
    });
    vault.context.settings.modelRouterMode = "authority";
    vault.context.settings.speechActSemanticRescueMode =
      speechActSemanticRescueMode;
    const client: ModelClient = {
      chat: async (request) => {
        chatRequests.push(cloneRequest(request));
        if (isMissionRouterFormat(request)) {
          return responseWithContent(
            JSON.stringify({
              mode: "code_workflow",
              writeScope: "none",
              needsWebEvidence: false,
              needsVaultContext: false,
              needsCodeExecution: true,
              wordTarget: null,
              confidence: 0.96,
              rationale: "The bounded tool request refers to an implementation project.",
            }),
          );
        }
        // Exercise the deterministic host-graph fallback; the router proposal
        // must still seed a real exact frontier without model-planner help.
        if (isMissionGraphPlannerFormat(request)) {
          return responseWithContent("planner unavailable");
        }
        return responseWithContent("Ready.");
      },
      streamChat: async () => {
        throw new Error("Router authority regression uses non-streaming calls only.");
      },
    };

    await runAgentMission({
      prompt,
      modelClient: client,
      toolRegistry: createCodeV2RoutingRegistry(),
      toolContext: vault.context,
      enableStreaming: false,
      maxSteps: 1,
      events: {
        onRunConfig: (event) => configs.push(event),
      },
    });

    const agentRequest = chatRequests.find(
      (request) =>
        !isMissionRouterFormat(request) &&
        !isMissionGraphPlannerFormat(request),
    );
    return {
      allowedToolNames: new Set(configs[0]?.allowedToolNames ?? []),
      frontierToolNames: new Set(
        agentRequest?.tools?.map((tool) => tool.function.name) ?? [],
      ),
      routerCalls: chatRequests.filter(isMissionRouterFormat).length,
    };
  };

  const disabled = await runScenario("off");
  assert.equal(disabled.routerCalls, 1);
  assert.equal(disabled.allowedToolNames.has("code_sandbox_status"), false);
  assert.equal(disabled.allowedToolNames.has("code_workspace_create_file"), false);
  assert.equal(disabled.frontierToolNames.has("code_sandbox_status"), false);

  const enabled = await runScenario("authority");
  assert.equal(enabled.routerCalls, 1);
  assert.ok(enabled.allowedToolNames.has("code_sandbox_status"));
  assert.ok(enabled.allowedToolNames.has("code_workspace_create"));
  assert.ok(enabled.allowedToolNames.has("code_workspace_create_file"));
  assert.ok(enabled.allowedToolNames.has("code_validate_full"));
  assert.equal(enabled.allowedToolNames.has("code_commit_verified"), false);
  assert.equal(enabled.allowedToolNames.has("install_code_dependency"), false);
  assert.equal(enabled.allowedToolNames.has("code_workspace_trash"), false);
  assert.ok(enabled.frontierToolNames.has("code_sandbox_status"));
  assert.equal(enabled.frontierToolNames.has("code_workspace_create"), false);
});

test("set-loose empty Soft-union intersection preserves code tools when graph has unpaid code work", () => {
  const graph = {
    nodes: {
      code: {
        id: "code",
        status: "ready",
        allowedTools: [
          "code_workspace_create",
          "code_workspace_patch",
          "code_validate_fast",
        ],
        inputs: {},
        outputs: {},
      },
    },
    capabilityEnvelope: { tools: {} },
  } as any;
  const definitions = [
    "code_workspace_patch",
    "code_validate_fast",
    "web_search",
    "read_current_file",
  ].map((name) => ({
    type: "function" as const,
    function: {
      name,
      parameters: { type: "object" as const, properties: {} },
    },
  }));
  // Soft-union names miss the catalog entirely; must not Soft-fallback alone.
  const constrained = constrainToolsToMissionGraphFrontier(definitions, graph, {
    setLooseOfferedToolNames: ["totally_missing_soft_union_tool"],
  });
  const names = constrained.map((tool) => tool.function.name);
  assert.ok(
    names.includes("code_workspace_patch"),
    `expected code_workspace_patch in code fallback; got ${names.join(", ")}`,
  );
  assert.ok(
    names.includes("code_validate_fast"),
    `expected code_validate_fast in code fallback; got ${names.join(", ")}`,
  );
  assert.equal(
    names.includes("web_search"),
    false,
    "must not Soft-fallback to companions-only while unpaid code work remains",
  );
});

test("set-loose Soft-union unions ready MissionGraph tools including read_template", () => {
  const graph = {
    nodes: {
      "tool-01-read_template": {
        id: "tool-01-read_template",
        status: "ready",
        allowedTools: ["read_template"],
        inputs: {},
        outputs: {},
      },
      "tool-02-linear_create_issue": {
        id: "tool-02-linear_create_issue",
        status: "queued",
        allowedTools: ["linear_create_issue"],
        inputs: {},
        outputs: {},
      },
    },
    capabilityEnvelope: { tools: {} },
  } as any;
  const definitions = [
    "read_current_file",
    "list_markdown_files",
    "append_to_current_file",
    "linear_create_issue",
    "code_workspace_patch",
    "read_template",
    "list_templates",
  ].map((name) => ({
    type: "function" as const,
    function: {
      name,
      parameters: { type: "object" as const, properties: {} },
    },
  }));
  // Soft-union intentionally omits read_template (pre-fix catalog shape).
  // Ready MissionGraph node must still appear in offered schemas.
  const constrained = constrainToolsToMissionGraphFrontier(definitions, graph, {
    setLooseOfferedToolNames: [
      "read_current_file",
      "list_markdown_files",
      "append_to_current_file",
      "linear_create_issue",
      "code_workspace_patch",
    ],
  });
  const names = constrained.map((tool) => tool.function.name);
  assert.ok(
    names.includes("read_template"),
    `expected ready read_template node in set-loose offered schemas; got ${names.join(", ")}`,
  );
  assert.ok(names.includes("read_current_file"));
  assert.equal(
    names.includes("linear_create_issue"),
    false,
    "queued Linear mutation must stay hidden until its graph dependency promotes it",
  );
  assert.equal(
    names.includes("list_templates"),
    false,
    "queued-only / non-offered list_templates must not appear without Soft-union or ready node",
  );
});

test("set-loose schema and execution authority preserve MissionGraph dependency order", () => {
  const graph = {
    nodes: {
      sandbox: {
        id: "sandbox",
        status: "ready",
        allowedTools: ["code_sandbox_status"],
        inputs: {},
        outputs: {},
      },
      workspace: {
        id: "workspace",
        status: "queued",
        allowedTools: ["code_workspace_create"],
        inputs: {},
        outputs: {},
      },
      createFile: {
        id: "createFile",
        status: "queued",
        allowedTools: ["code_workspace_create_file"],
        inputs: {},
        outputs: {},
      },
      validate: {
        id: "validate",
        status: "queued",
        allowedTools: ["code_validate_fast"],
        inputs: {},
        outputs: {},
      },
    },
    capabilityEnvelope: { tools: {} },
  } as any;
  const offered = [
    "code_sandbox_status",
    "code_workspace_create",
    "code_workspace_status",
    "code_workspace_read",
    "code_workspace_create_file",
    "code_validate_fast",
    "web_search",
    "read_current_file",
  ];
  const definitions = offered.map((name) => ({
    type: "function" as const,
    function: {
      name,
      parameters: { type: "object" as const, properties: {} },
    },
  }));

  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(definitions, graph, {
      setLooseOfferedToolNames: offered,
    }).map((tool) => tool.function.name),
    ["code_sandbox_status", "web_search", "read_current_file"],
    "only the ready sandbox node and true unplanned Soft companions are callable",
  );
  assert.deepEqual(
    filterSetLooseToolNamesByMissionGraphAuthority(offered, graph),
    ["code_sandbox_status", "web_search", "read_current_file"],
  );
  assert.equal(
    mayBypassMissionGraphStartForSetLooseSoftCompanion(
      "code_workspace_create",
      new Set(offered),
      graph,
    ),
    false,
    "Bound workspace creation can never bypass a graph-start rejection",
  );
  assert.equal(
    mayBypassMissionGraphStartForSetLooseSoftCompanion(
      "web_search",
      new Set(offered),
      graph,
    ),
    true,
    "a genuinely unplanned Soft companion remains available",
  );

  graph.nodes.sandbox.status = "complete";
  graph.nodes.workspace.status = "ready";
  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(definitions, graph, {
      setLooseOfferedToolNames: offered,
    }).map((tool) => tool.function.name),
    [
      "code_sandbox_status",
      "code_workspace_create",
      "web_search",
      "read_current_file",
    ],
    "workspace creation appears only after sandbox proof promotes it",
  );

  graph.nodes.workspace.status = "complete";
  graph.nodes.createFile.status = "ready";
  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(definitions, graph, {
      setLooseOfferedToolNames: offered,
    }).map((tool) => tool.function.name),
    [
      "code_sandbox_status",
      "code_workspace_status",
      "code_workspace_read",
      "code_workspace_create_file",
      "web_search",
      "read_current_file",
    ],
    "the one-shot workspace bootstrap disappears while the next ready node appears",
  );
});

test("set-loose permits bounded repository edits discovered after workspace creation", () => {
  const action = (
    id: string,
    toolName: string,
    effect: "read" | "mutation" | "execution",
  ) => ({
    id,
    toolName,
    effect,
    bindingId: toolName === "code_sandbox_status" ? null : "binding-workspace",
    selector: null,
    objective: `${toolName} objective`,
    minimumEvidence: 1,
    requiredEvidenceKinds: ["tool-result"],
    minimumReceipts: effect === "read" ? 0 : 1,
    requiredReceiptKinds: effect === "read" ? [] : ["code_change"],
  });
  const graph = {
    nodes: {
      code: {
        id: "lifecycle-code_execution",
        status: "ready",
        allowedTools: [
          "code_workspace_create",
          "code_workspace_create_file",
          "code_validate_fast",
          "code_commit_verified",
        ],
        inputs: {
          lifecycle: {
            kind: "literal",
            value: {
              version: 1,
              composite: true,
              intentFingerprint: `sha256:${"b".repeat(64)}`,
              stage: "code_execution",
              actions: [
                action(
                  "action-001-code_workspace_create",
                  "code_workspace_create",
                  "mutation",
                ),
                action(
                  "action-002-code_workspace_create_file",
                  "code_workspace_create_file",
                  "mutation",
                ),
                action(
                  "action-003-code_validate_fast",
                  "code_validate_fast",
                  "execution",
                ),
                action(
                  "action-004-code_repair_record_cycle",
                  "code_repair_record_cycle",
                  "mutation",
                ),
                action(
                  "action-005-code_commit_verified",
                  "code_commit_verified",
                  "mutation",
                ),
              ],
            },
          },
        },
        outputs: {
          lifecycleActionCursor: 2,
          lifecycleCompletedActionIds: [
            "action-001-code_workspace_create",
            "action-002-code_workspace_create_file",
          ],
          lifecycleActionAttemptCounts: {
            "action-001-code_workspace_create": 1,
            "action-002-code_workspace_create_file": 1,
          },
        },
      },
    },
  } as any;
  const offered = [
    "code_workspace_create_file",
    "code_workspace_mkdir",
    "code_workspace_write_expected",
    "code_validate_fast",
    "code_repair_record_cycle",
    "code_commit_verified",
  ];

  assert.deepEqual(
    filterSetLooseToolNamesByMissionGraphAuthority(offered, graph),
    [
      "code_workspace_create_file",
      "code_workspace_mkdir",
      "code_workspace_write_expected",
      "code_validate_fast",
    ],
    "additional scoped file edits are callable, but the queued commit remains closed",
  );
  assert.equal(
    mayBypassMissionGraphStartForSetLooseSoftCompanion(
      "code_workspace_create_file",
      new Set(offered),
      graph,
    ),
    true,
    "an issue-discovered additional file may use the existing code-stage grant",
  );
  assert.equal(
    mayBypassMissionGraphStartForSetLooseSoftCompanion(
      "code_workspace_write_expected",
      new Set(offered),
      graph,
    ),
    true,
    "a hash-bound edit of an issue-discovered existing file may run as a companion",
  );
  assert.equal(
    mayBypassMissionGraphStartForSetLooseSoftCompanion(
      "code_validate_fast",
      new Set(offered),
      graph,
    ),
    false,
    "the current planned validator still begins and finishes its graph action",
  );
  assert.equal(
    mayBypassMissionGraphStartForSetLooseSoftCompanion(
      "code_commit_verified",
      new Set(offered),
      graph,
    ),
    false,
    "a queued proof action never bypasses graph order",
  );

  graph.nodes.code.outputs.lifecycleActionCursor = 3;
  graph.nodes.code.outputs.lifecycleCompletedActionIds.push(
    "action-003-code_validate_fast",
  );
  graph.nodes.code.outputs.lifecycleActionAttemptCounts[
    "action-003-code_validate_fast"
  ] = 1;
  assert.deepEqual(
    filterSetLooseToolNamesByMissionGraphAuthority(offered, graph),
    ["code_repair_record_cycle"],
    "the composite lifecycle also pauses adaptive edits at its repair-cycle cursor",
  );
  assert.equal(
    mayBypassMissionGraphStartForSetLooseSoftCompanion(
      "code_workspace_create_file",
      new Set(offered),
      graph,
    ),
    false,
  );
});

test("set-loose pauses adaptive edits while an exact validation receipt is being recorded", () => {
  const graph = {
    nodes: {
      workspace: {
        id: "workspace",
        status: "complete",
        allowedTools: ["code_workspace_create"],
        inputs: {},
        outputs: {},
      },
      fast: {
        id: "fast",
        status: "complete",
        allowedTools: ["code_validate_fast"],
        inputs: {},
        outputs: {},
      },
      repair: {
        id: "repair",
        status: "ready",
        allowedTools: ["code_repair_record_cycle"],
        inputs: {},
        outputs: {},
      },
      targeted: {
        id: "targeted",
        status: "queued",
        allowedTools: ["code_validate_targeted"],
        inputs: {},
        outputs: {},
      },
    },
  } as any;
  const offered = [
    "code_workspace_create_file",
    "code_workspace_write_expected",
    "code_repair_record_cycle",
    "code_validate_targeted",
  ];
  const repairFrontierOffered = [
    ...offered,
    "code_workspace_status",
    "code_workspace_stat",
    "code_workspace_list",
    "code_workspace_read",
    "code_workspace_search",
    "code_sandbox_status",
    "code_repair_status",
    "web_search",
    "web_fetch",
  ];

  assert.deepEqual(
    filterSetLooseToolNamesByMissionGraphAuthority(
      repairFrontierOffered,
      graph,
    ),
    ["code_repair_record_cycle"],
    "the exact fast-validation receipt is recorded before any later edit can change workspace hashes",
  );
  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(
      repairFrontierOffered.map((name) => ({
        type: "function" as const,
        function: {
          name,
          parameters: { type: "object", properties: {} },
        },
      })),
      graph,
      { setLooseOfferedToolNames: repairFrontierOffered },
    ).map((tool) => tool.function.name),
    ["code_repair_record_cycle"],
    "the actual set-loose schema frontier cannot distract the model with status, read, search, or web tools",
  );
  for (const mutation of [
    "code_workspace_create_file",
    "code_workspace_write_expected",
  ]) {
    assert.equal(
      mayBypassMissionGraphStartForSetLooseSoftCompanion(
        mutation,
        new Set(offered),
        graph,
      ),
      false,
      `${mutation} cannot bypass the active repair-cycle frontier`,
    );
  }

  graph.nodes.repair.status = "complete";
  graph.nodes.targeted.status = "ready";
  assert.deepEqual(
    filterSetLooseToolNamesByMissionGraphAuthority(offered, graph),
    [
      "code_workspace_create_file",
      "code_workspace_write_expected",
      "code_validate_targeted",
    ],
    "adaptive edits resume before the next fresh targeted validation",
  );
  assert.equal(
    mayBypassMissionGraphStartForSetLooseSoftCompanion(
      "code_workspace_create_file",
      new Set(offered),
      graph,
    ),
    true,
  );
});

test("red targeted validation requires a correction receipt before fresh fast validation", () => {
  const graph = {
    nodes: {
      workspace: {
        id: "workspace",
        status: "complete",
        allowedTools: ["code_workspace_create"],
        inputs: {},
        outputs: {},
      },
      "validation-recovery-fast-targeted": {
        id: "validation-recovery-fast-targeted",
        status: "queued",
        allowedTools: ["code_validate_fast"],
        inputs: {},
        outputs: {},
      },
      "validation-recovery-record-targeted": {
        id: "validation-recovery-record-targeted",
        status: "queued",
        allowedTools: ["code_repair_record_cycle"],
        inputs: {},
        outputs: {},
      },
      targeted: {
        id: "targeted",
        status: "queued",
        allowedTools: ["code_validate_targeted"],
        inputs: {},
        outputs: {
          validationRecovery: {
            version: 1,
            status: "awaiting_correction",
            fastNodeId: "validation-recovery-fast-targeted",
            repairNodeId: "validation-recovery-record-targeted",
          },
        },
      },
    },
  } as any;
  const offered = [
    "code_workspace_status",
    "code_workspace_read",
    "code_workspace_stat",
    "code_workspace_list",
    "code_workspace_search",
    "code_workspace_create_file",
    "code_workspace_append",
    "code_workspace_patch",
    "code_workspace_write_expected",
    "code_validate_fast",
    "code_repair_status",
    "web_search",
  ];

  assert.deepEqual(getActiveValidationRecoveryFrontierV1(graph), {
    validationNodeId: "targeted",
    fastNodeId: "validation-recovery-fast-targeted",
    repairNodeId: "validation-recovery-record-targeted",
    status: "awaiting_correction",
  });
  assert.deepEqual(
    filterSetLooseToolNamesByMissionGraphAuthority(offered, graph),
    [
      "code_workspace_read",
      "code_workspace_stat",
      "code_workspace_list",
      "code_workspace_search",
      "code_workspace_create_file",
      "code_workspace_append",
      "code_workspace_patch",
      "code_workspace_write_expected",
    ],
    "unchanged validators and unrelated status/web tools stay hidden until a real correction receipt exists",
  );

  graph.nodes.targeted.outputs.validationRecovery.status =
    "correction_recorded";
  graph.nodes["validation-recovery-fast-targeted"].status = "ready";
  assert.deepEqual(
    filterSetLooseToolNamesByMissionGraphAuthority(offered, graph),
    ["code_validate_fast"],
    "after the correction receipt, the exact fresh fast validator is the only callable frontier",
  );
});

test("planned queued Soft companions cannot swallow MissionGraph start rejection", () => {
  const graph = {
    nodes: {
      reflection: {
        id: "reflection",
        status: "queued",
        allowedTools: ["append_to_current_file"],
        inputs: {},
        outputs: {},
      },
    },
  } as any;
  assert.equal(
    mayBypassMissionGraphStartForSetLooseSoftCompanion(
      "append_to_current_file",
      new Set(["append_to_current_file"]),
      graph,
    ),
    false,
  );
  assert.deepEqual(
    filterSetLooseToolNamesByMissionGraphAuthority(
      ["append_to_current_file", "web_search"],
      graph,
    ),
    ["web_search"],
  );
});

test("atomic research publication suppresses generic note writers until an explicit reflection node", () => {
  const graph = {
    nodes: {
      publisher: {
        id: "publisher",
        status: "blocked",
        allowedTools: ["publish_research_to_linear"],
        inputs: {},
        outputs: {},
      },
    },
  } as any;
  const offered = [
    "publish_research_to_linear",
    "append_to_current_file",
    "read_current_file",
  ];

  assert.deepEqual(
    filterSetLooseToolNamesByMissionGraphAuthority(offered, graph),
    ["read_current_file"],
    "the composite owns accepted-note writeback even while its publisher is blocked",
  );
  assert.equal(
    mayBypassMissionGraphStartForSetLooseSoftCompanion(
      "append_to_current_file",
      new Set(offered),
      graph,
    ),
    false,
    "a generic append cannot recover off-graph from a blocked atomic publisher",
  );

  graph.nodes.reflection = {
    id: "reflection",
    status: "ready",
    allowedTools: ["append_to_current_file"],
    inputs: {},
    outputs: {},
  };
  assert.deepEqual(
    filterSetLooseToolNamesByMissionGraphAuthority(offered, graph),
    ["append_to_current_file", "read_current_file"],
    "an independently planned reflection append remains callable",
  );
  assert.equal(
    mayBypassMissionGraphStartForSetLooseSoftCompanion(
      "append_to_current_file",
      new Set(offered),
      graph,
    ),
    false,
    "the planned reflection follows graph authority rather than Soft bypass",
  );
});

test("completed Bound publisher never re-enters the set-loose model catalog", () => {
  const graph = {
    nodes: {
      publisher: {
        id: "publisher",
        status: "complete",
        effect: "publish",
        allowedTools: ["publish_research_to_linear"],
        inputs: {},
        outputs: {},
      },
      final: {
        id: "final",
        status: "queued",
        effect: "read",
        allowedTools: [],
        inputs: {},
        outputs: {},
      },
    },
    capabilityEnvelope: { tools: {} },
  } as any;

  assert.deepEqual(
    filterSetLooseToolNamesByMissionGraphAuthority(
      ["publish_research_to_linear", "read_current_file"],
      graph,
    ),
    ["read_current_file"],
  );
});

test("set-loose Linear publication cannot enumerate templates without template intent", () => {
  const offered = [
    "publish_research_to_linear",
    "read_template",
    "list_templates",
    "read_current_file",
  ];
  assert.deepEqual(
    constrainSetLooseTemplateDiscoveryToMissionIntent(
      offered,
      "Deeply research CRDTs, write accepted research into this note, then publish it to one Linear implementation issue.",
    ),
    [
      "publish_research_to_linear",
      "read_template",
      "read_current_file",
    ],
  );
  assert.deepEqual(
    constrainSetLooseTemplateDiscoveryToMissionIntent(
      offered,
      "List my templates, then fill the selected template.",
    ),
    offered,
  );
});

test("exact frontier still offers the tool for an orphaned running create_file node", () => {
  const graph = {
    nodes: {
      "tool-07-code_workspace_create_file": {
        id: "tool-07-code_workspace_create_file",
        status: "running",
        allowedTools: ["code_workspace_create_file"],
        inputs: {},
        outputs: {},
        destination: { selector: "checkers/game.py" },
      },
      "tool-11-code_workspace_read": {
        id: "tool-11-code_workspace_read",
        status: "queued",
        allowedTools: ["code_workspace_read"],
        inputs: {},
        outputs: {},
      },
    },
    capabilityEnvelope: { tools: {} },
  } as any;
  const definitions = [
    "code_workspace_create_file",
    "code_workspace_read",
  ].map((name) => ({
    type: "function" as const,
    function: {
      name,
      parameters: { type: "object" as const, properties: {} },
    },
  }));
  const frontier = constrainToolsToMissionGraphFrontier(definitions, graph);
  assert.deepEqual(
    frontier.map((tool) => tool.function.name),
    ["code_workspace_create_file"],
  );
});

test("empty tool-result final content falls back to streamed synthesis", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "MCP servers ",
          "fallback answer. Source: https://example.com/source",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].think, undefined);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.deepEqual(finalDeltas, [
    "MCP servers fallback answer. Source: https://example.com/source",
  ]);
});

test("metrics are emitted for model, tool, stream fallback, and run timing", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const metrics: AgentRunMetricEvent[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () =>
        responseWithContent(
          "MCP servers fallback answer. Source: https://example.com/source",
        ),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onMetric: (event) => metrics.push(event),
    },
  });

  // Tool-bearing agent steps may emit model_stream (stream+tools) instead of
  // model_chat; count both as agent model turns.
  assert.equal(
    metrics.filter(
      (event) =>
        event.name === "agent_step" &&
        (event.kind === "model_chat" || event.kind === "model_stream"),
    ).length,
    3,
  );
  assert.equal(metrics.some((event) => event.kind === "tool" && event.name === "web_search"), true);
  assert.equal(metrics.some((event) => event.kind === "tool" && event.name === "web_fetch"), true);
  assert.equal(metrics.some((event) => event.kind === "model_stream"), true);
  assert.equal(metrics.some((event) => event.kind === "run"), true);

  for (const metric of metrics) {
    assert.ok(metric.durationMs >= 0);
  }

  const firstModelMetric = metrics.find((event) => event.kind === "model_chat");
  assert.ok((firstModelMetric?.requestChars ?? 0) > 0);
  assert.ok((firstModelMetric?.responseChars ?? 0) > 0);
});

test("model requests include configured options and metrics include token counts", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const metrics: AgentRunMetricEvent[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent("Coral fact", undefined, {
          message: { role: "assistant", content: "Coral fact" },
          prompt_eval_count: 12,
          eval_count: 4,
        }),
    ],
  });

  await runAgentMission({
    prompt: "What is one fact about coral reefs?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {
      settings: createRunnerSettings({
        temperature: 0.2,
        topK: 40,
        topP: 0.8,
        numCtx: 4096,
      }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onMetric: (event) => metrics.push(event),
    },
  });

  assert.deepEqual(chatRequests[0].options, {
    temperature: 0.2,
    top_k: 40,
    top_p: 0.8,
    num_ctx: 4096,
  });
  const modelMetric = metrics.find((event) => event.kind === "model_chat");
  assert.equal(modelMetric?.promptTokens, 12);
  assert.equal(modelMetric?.completionTokens, 4);
  assert.equal(modelMetric?.totalTokens, 16);
});

test("stream metrics include token counts from the final raw chunk", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const metrics: AgentRunMetricEvent[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas(["Streamed fact"], "Streamed fact", [], {
          raw: [{}, { prompt_eval_count: 8, eval_count: 3 }],
        }),
    ],
  });

  await runAgentMission({
    prompt: "What is one fact about coral reefs?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {
      settings: createRunnerSettings({ outputProfile: "chat_first" }),
    } as ToolExecutionContext,
    enableStreaming: true,
    forceChatOnly: true,
    events: {
      onMetric: (event) => metrics.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  const streamMetric = metrics.find((event) => event.kind === "model_stream");
  assert.equal(streamMetric?.promptTokens, 8);
  assert.equal(streamMetric?.completionTokens, 3);
  assert.equal(streamMetric?.totalTokens, 11);
});

test("unavailable tool calls are rejected before execution", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "percentage change" }),
      () => responseWithContent("Final direct answer"),
    ],
  });

  await runAgentMission({
    prompt: "What is the percentage change from 10 to 12?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [],
  );
  assert.ok(statuses.includes("Rejected unavailable tool: web_search"));
  assert.deepEqual(deltas, ["Final direct answer"]);
});

test("duplicate read-only tool calls hit the run-local cache", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const metrics: AgentRunMetricEvent[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("search_markdown_files", { query: "local AI" }),
      () => responseWithToolCall("search_markdown_files", { query: "local AI" }),
      () => responseWithContent("Found local AI notes."),
    ],
  });

  await runAgentMission({
    prompt: "Search my notes for local AI tools.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onMetric: (event) => metrics.push(event),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["search_markdown_files"],
  );
  assert.ok(
    metrics.some(
      (event) =>
        event.kind === "tool" &&
        event.name === "search_markdown_files" &&
        event.cached === true,
    ),
  );
});

test("duplicate semantic search tool calls hit the run-local cache", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const metrics: AgentRunMetricEvent[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("semantic_search_notes", {
          query: "local AI concepts",
        }),
      () =>
        responseWithToolCall("semantic_search_notes", {
          query: "local AI concepts",
        }),
      () => responseWithContent("Found local AI notes."),
    ],
  });

  await runAgentMission({
    prompt: "What do my notes say about local AI concepts?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onMetric: (event) => metrics.push(event),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["semantic_search_notes"],
  );
  assert.ok(
    metrics.some(
      (event) =>
        event.kind === "tool" &&
        event.name === "semantic_search_notes" &&
        event.cached === true,
    ),
  );
});

test("append prompts require a write tool and do not implicitly append", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I will append this in chat only."),
      () => responseWithToolCall("append_to_current_file", { text: "## Result" }),
    ],
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: append_to_current_file/,
  );
  assert.deepEqual(deltas, ["Done. append Current.md."]);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["append_to_current_file"],
  );
  assert.ok(statuses.includes("Write required; asking model to use a write tool..."));
  assert.ok(statuses.includes("Appended result to Current.md."));
  assert.ok(statuses.includes("Write complete."));
});

test("successful write tools stop the loop without an extra final answer", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "## Result" }),
      () => responseWithContent("should not run"),
    ],
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.deepEqual(deltas, ["Done. append Current.md."]);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["append_to_current_file"],
  );
  assert.ok(statuses.includes("Appending to note..."));
  assert.ok(statuses.includes("Appended result to Current.md."));
});

test("write missions emit receipts and a local final answer", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const receipts: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "## Result",
        }),
    ],
    streamResponders: [
      () => responseWithContent("Appended the result to the current note."),
    ],
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["append_to_current_file"],
  );
  assert.deepEqual(finalDeltas, ["Done. append Current.md."]);
  assert.deepEqual(receipts, ["append Current.md"]);
});

test("replace prompts expose replace but not append unless append intent exists", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("replace_current_file", { text: "# Brief" }),
    ],
  });

  await runAgentMission({
    prompt: "Replace this note with a clean project brief.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("replace_current_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "replace_current_file"],
  );
});

test("whole-note replace wins over broad content edit wording", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("list_markdown_files", {}),
      () => responseWithToolCall("replace_current_file", { text: "# Brief" }),
    ],
  });

  await runAgentMission({
    prompt:
      "Look at the markdown file names in this vault, then replace the current file content with a clean project brief.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstStepToolNames.includes("list_markdown_files"));
  assert.ok(firstStepToolNames.includes("replace_current_file"));
  assert.ok(!firstStepToolNames.includes("edit_current_section"));
  assert.ok(
    chatRequests[0].messages.some((message) => /Tools:/.test(message.content)),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "list_markdown_files", "replace_current_file"],
  );
  assert.ok(!statuses.includes("Rejected unavailable tool: replace_current_file"));
  assert.ok(statuses.includes("Replaced Current.md; backup saved to .agent-backups/1-Current.md."));
});

test("visible title prompts expose rename_current_file and suppress accidental append", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("rename_current_file", {
          title: "Native Obsidian Agentic Research",
        }),
    ],
  });

  await runAgentMission({
    prompt:
      "Rename the current note to Native Obsidian Agentic Research, then confirm the visible title.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("rename_current_file"));
  assert.ok(!toolNames.includes("move_path"));
  assert.ok(!toolNames.includes("retitle_current_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "rename_current_file"],
  );
  assert.ok(statuses.includes("Renaming current note file..."));
  assert.ok(statuses.includes("Renamed current note from Current.md to Renamed.md."));
});

test("compound long research continues after its current-note rename receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("rename_current_file", {
          title: "Durable Research Target",
        }),
      () =>
        responseWithToolCall("get_note_graph_context", {
          path: "Research Context 1.md",
        }),
      () =>
        responseWithToolCall("get_note_graph_context", {
          path: "Research Context 2.md",
        }),
      ...Array.from({ length: 4 }, () => () =>
        responseWithContent(
          "Research remains incomplete; continue gathering evidence.",
        ),
      ),
    ],
  });

  await runAgentMission({
    prompt:
      "Perform long-running research. Rename the current note to Durable Research Target, then inspect the current note graph until the segment budget requires continuation.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({ maxAgentSteps: 7 }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  const executedNames = executedCalls.map((call) => call.name);
  assert.deepEqual(executedNames.slice(0, 3), [
    "read_current_file",
    "rename_current_file",
    "get_note_graph_context",
  ]);
  assert.ok(chatRequests.length > 1);
});

test("current-note rename before long research does not require generic move_path", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("rename_current_file", {
          title: "Long Research Target",
        }),
    ],
  });

  await runAgentMission({
    prompt:
      'Perform long-running research for E2E_AUTO_SEGMENT_CONTINUATION. Rename the current note to "Long Research Target", then inspect the current note graph and keep reading graph context until the segment budget requires durable continuation.',
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("rename_current_file"));
  assert.ok(!toolNames.includes("move_path"));
  const modelToolNames = chatRequests.flatMap(
    (request) => request.tools?.map((tool) => tool.function.name) ?? [],
  );
  assert.ok(modelToolNames.includes("get_note_graph_context"));
  assert.ok(modelToolNames.includes("web_search"));
  assert.ok(modelToolNames.includes("web_fetch"));
});

test("titled generated writing uses append without requiring rename tool", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt: "Create a 50 word piece of text with the title Purple Horizon on this page.",
    path: "Untitled.md",
    content: "",
    streamWritebackMode: "off",
  });

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "# Purple Horizon\n\nPurple Horizon body text.",
        }),
      () => responseWithContent("Done."),
    ],
  });

  await runAgentMission({
    prompt: "Create a 50 word piece of text with the title Purple Horizon on this page.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {},
  });

  const firstToolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstToolNames.includes("append_to_current_file"));
  assert.ok(!firstToolNames.includes("rename_current_file"));
  assert.ok(!firstToolNames.includes("retitle_current_file"));
  assert.ok(
    executedCalls.some((call) => call.name === "append_to_current_file"),
  );
  assert.ok(
    !executedCalls.some((call) => call.name === "rename_current_file"),
  );
});

test("explicit rename prompts still expose rename_current_file", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt: "Rename the current note to Purple Horizon.",
    path: "Untitled.md",
    content: "",
    streamWritebackMode: "off",
  });

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("rename_current_file", {
          title: "Purple Horizon",
        }),
      () => responseWithContent("Renamed."),
    ],
  });

  await runAgentMission({
    prompt: "Rename the current note to Purple Horizon.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {},
  });

  const firstToolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstToolNames.includes("rename_current_file"));
  assert.ok(!firstToolNames.includes("retitle_current_file"));
});

test("explicit H1 title prompts keep retitle_current_file", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("retitle_current_file", {
          title: "Native Obsidian Agentic Research",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Change the H1 heading title in this note around native Obsidian agentic research.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("retitle_current_file"));
  assert.ok(!toolNames.includes("rename_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "retitle_current_file"],
  );
});

test("highlight prompts expose highlight_current_file_phrase without replacement tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("highlight_current_file_phrase", {
          phrase: "silver lantern",
        }),
      () => responseWithContent("Highlighted silver lantern."),
    ],
  });

  await runAgentMission({
    prompt: "Find and highlight silver lantern in the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("highlight_current_file_phrase"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["highlight_current_file_phrase"],
  );
});

test("restore prompts expose restore_current_file_from_backup without append or replace tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("restore_current_file_from_backup", {}),
      () => responseWithContent("Restored from backup."),
    ],
  });

  await runAgentMission({
    prompt: "Undo the last agent edit in the current note from backup.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("restore_current_file_from_backup"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["restore_current_file_from_backup"],
  );
});

test("edit prompts expose section edit and suppress other mutation tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I edited it in chat only."),
      () =>
        responseWithToolCall("edit_current_section", {
          heading: "Goals",
          level: 2,
          content: "New goals.",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Edit the Goals section in this note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("edit_current_section"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("retitle_current_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.ok(!toolNames.includes("delete_current_file"));
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: edit_current_section/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "edit_current_section"],
  );
  assert.ok(statuses.includes("Editing current note section with backup..."));
  assert.ok(
    statuses.includes(
      "Edited section in Current.md; backup saved to .agent-backups/1-Current.md.",
    ),
  );
});

test("delete prompts expose delete and suppress other mutation tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithToolCall("delete_current_file", {})],
  });

  await runAgentMission({
    prompt: "Delete the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("delete_current_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("retitle_current_file"));
  assert.ok(!toolNames.includes("edit_current_section"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "delete_current_file"],
  );
  assert.ok(statuses.includes("Deleting current note with backup..."));
  assert.ok(
    statuses.includes(
      "Deleted Current.md; backup saved to .agent-backups/1-Current.md.",
    ),
  );
});

test("budget stop uses adaptive web budget and does not synthesize", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const toolStarts: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const chatResponders: ChatResponder[] = Array.from(
    { length: MAX_AGENT_STEPS },
    (_, index) => () =>
      responseWithToolCall("web_search", { query: `q${index + 1}` }),
  );

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders,
  });

  await runAgentMission({
    prompt: "Search the web forever.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
      onToolStart: (event) => toolStarts.push(event.name),
    },
  });

  assert.ok(chatRequests.length < MAX_AGENT_STEPS);
  assert.equal(chatRequests.length, 5);
  assert.equal(streamRequests.length, 0);
  assert.equal(
    executedCalls.filter((call) => call.name === "web_search").length,
    5,
  );
  assert.equal(toolStarts.length, 5);
  assert.ok(statuses.includes("Stopped at safety limit. Review partial results."));
  assert.deepEqual(deltas, []);
});

test("configured max agent steps caps grounded research loops", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const executedCalls: ModelToolCall[] = [];
  const configuredMax = 3;
  const chatResponders: ChatResponder[] = Array.from(
    { length: MAX_AGENT_STEPS },
    (_, index) => () =>
      responseWithToolCall("web_search", { query: `deep-${index + 1}` }),
  );

  const client = createClient({
    chatRequests,
    chatResponders,
  });

  await runAgentMission({
    prompt: "Do deep research on Obsidian plugins.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({
        model: "gpt-oss:120b",
        maxAgentSteps: configuredMax,
      }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].route, "grounded_workflow");
  assert.equal(configs[0].maxSteps, configuredMax);
  assert.equal(configs[0].maxStepsForRun, configuredMax);
  assert.equal(configs[0].resolvedThink, "medium");
  assert.equal(chatRequests.length, configuredMax);
  assert.equal(chatRequests[0].think, "medium");
  assert.equal(
    executedCalls.filter((call) => call.name === "web_search").length,
    2,
  );
  assert.ok(statuses.includes("Stopped at safety limit. Review partial results."));
});

test("explicit model-step prompts set the visible run step cap", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const executedCalls: ModelToolCall[] = [];
  const targetSteps = 10;
  const prompt = `Inspect the current note graph for E2E_LOOP_STEPS_${targetSteps} and complete exactly ${targetSteps} model steps before the final answer.`;
  const client = createClient({
    chatRequests,
    chatResponders: [
      ...Array.from({ length: targetSteps - 1 }, (_, index) => () =>
        responseWithToolCall("get_note_graph_context", {
          path: `Loop Context ${index + 1}.md`,
        }),
      ),
      () => responseWithContent(`E2E_LOOP_DONE_${targetSteps}`),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({
        maxAgentSteps: 30,
      }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].route, "grounded_workflow");
  assert.equal(configs[0].maxSteps, 30);
  assert.equal(configs[0].maxStepsForRun, targetSteps);
  assert.ok(statuses.includes(`Agent step 1 of max ${targetSteps}...`));
  assert.ok(statuses.includes(`Agent step ${targetSteps} of max ${targetSteps}...`));
  assert.equal(chatRequests.length, targetSteps);
  assert.equal(
    executedCalls.filter((call) => call.name === "get_note_graph_context").length,
    6,
  );
});

test("aborted runs stop before the next model loop step", async () => {
  const controller = new AbortController();
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const completions: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "first query" }),
      () => {
        throw new Error("stop should prevent a second model call");
      },
    ],
  });

  await runAgentMission({
    prompt: "Search the web and keep investigating.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    abortSignal: controller.signal,
    events: {
      onStatus: (message) => statuses.push(message),
      onToolDone: () => controller.abort(),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search"],
  );
  assert.deepEqual(completions, ["user_stopped"]);
  assert.ok(statuses.includes("Stopped by user."));
});

test("aborted runs refresh the continuation handoff after same-note evidence changes", async () => {
  const prompt = "Read the current note twice, compare both observations, and then summarize.";
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.modelRouterMode = "off";
  const controller = new AbortController();
  const executedCalls: ModelToolCall[] = [];
  const baseRegistry = createRegistry(executedCalls);
  let readCount = 0;
  const registry: ToolRegistry = {
    getDefinitions: () => baseRegistry.getDefinitions(),
    execute: async (call, context) => {
      if (call.name === "read_current_file") {
        executedCalls.push(call);
        readCount += 1;
        return {
          ok: true,
          toolName: call.name,
          output: {
            path: "Current.md",
            content:
              readCount === 1
                ? "# Checkers\n\nInitial research evidence."
                : "# Checkers\n\nUpdated research evidence with Linear traceability.",
          },
        };
      }
      return baseRegistry.execute(call, context);
    },
  };

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests: [],
      chatResponders: [
        () => responseWithToolCall("read_current_file", {}),
        () => {
          throw new Error("stop should prevent another model call");
        },
      ],
    }),
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    abortSignal: controller.signal,
    events: {
      onToolDone: () => controller.abort(),
    },
  });

  assert.equal(readCount, 2);
  let persistedLedger = [...vault.content.values()]
    .map((markdown) => parseMissionLedgerFromMarkdown(markdown))
    .find((ledger) => ledger?.status === "stopped") ?? null;
  for (let attempt = 0; !persistedLedger && attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    persistedLedger = [...vault.content.values()]
      .map((markdown) => parseMissionLedgerFromMarkdown(markdown))
      .find((ledger) => ledger?.status === "stopped") ?? null;
  }
  assert.ok(persistedLedger?.continuationHandoff);
  const graphMarkdown = [...vault.content.entries()].find(([path]) =>
    path.startsWith("Agent Runs/Mission Graphs/"),
  )?.[1];
  assert.ok(graphMarkdown);
  const graphRecord = await parseMissionGraphStoreRecordFromMarkdown(graphMarkdown);
  assert.ok(graphRecord);
  const validation = validateContinuationHandoffV1(
    persistedLedger.continuationHandoff,
    {
      ledger: persistedLedger,
      graph: graphRecord.graph,
      lineageFingerprints: [],
    },
  );
  assert.equal(validation.ok, true);
});

test("an enabled structured router relays a user stop before agent planning", async () => {
  const controller = new AbortController();
  const completions: string[] = [];
  let chatCalls = 0;
  let routerSignal: AbortSignal | undefined;
  let markRouterStarted!: () => void;
  const routerStarted = new Promise<void>((resolve) => {
    markRouterStarted = resolve;
  });
  const client: ModelClient = {
    chat: async (request) => {
      chatCalls += 1;
      assert.equal(isMissionRouterFormat(request), true);
      routerSignal = request.abortSignal;
      markRouterStarted();
      return await new Promise<ModelChatResponse>((_resolve, reject) => {
        const rejectAborted = () =>
          reject(request.abortSignal?.reason ?? new Error("router aborted"));
        if (request.abortSignal?.aborted) {
          rejectAborted();
          return;
        }
        request.abortSignal?.addEventListener("abort", rejectAborted, {
          once: true,
        });
      });
    },
    streamChat: async () => {
      throw new Error("streamChat must not run after router cancellation");
    },
  };
  const { context } = createRunnerVaultContext({
    prompt: "Research the current note and append a short sourced finding.",
  });
  context.settings = createRunnerSettings({
    modelRouterEnabled: true,
    modelRouterMode: "authority",
  });

  const mission = runAgentMission({
    prompt: "Research the current note and append a short sourced finding.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: context,
    enableStreaming: false,
    abortSignal: controller.signal,
    events: {
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });
  await routerStarted;
  controller.abort("user_requested");
  await mission;

  assert.equal(routerSignal?.aborted, true);
  assert.equal(chatCalls, 1);
  assert.deepEqual(completions, ["user_stopped"]);
});

test("a direct-chat stop joins an already-invoked shadow router before closing usage evidence", async () => {
  const controller = new AbortController();
  const completions: string[] = [];
  const evidence: Array<{ clientInvoked: boolean; outcome: string }> = [];
  let releaseShadow!: () => void;
  let markShadowStarted!: () => void;
  const shadowStarted = new Promise<void>((resolve) => {
    markShadowStarted = resolve;
  });
  const shadowFinished = new Promise<ModelChatResponse>((_resolve, reject) => {
    releaseShadow = () => reject(new Error("shadow router released"));
  });
  const client: ModelClient = {
    chat: async (request) => {
      assert.equal(isMissionRouterFormat(request), true);
      markShadowStarted();
      // Deliberately ignore the abort signal. The runner must still join this
      // already-invoked client before it closes the coordinator generation.
      return shadowFinished;
    },
    streamChat: async () => {
      throw new Error("primary direct chat must not start after user stop");
    },
  };
  const { context } = createRunnerVaultContext({
    prompt: "What is two plus two? Answer in chat only.",
  });
  context.settings = createRunnerSettings({
    modelRouterEnabled: true,
    modelRouterMode: "shadow",
    speechActSemanticRescueMode: "shadow",
  });

  let settled = false;
  const mission = runAgentMission({
    prompt: "What is two plus two? Answer in chat only.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: context,
    enableStreaming: false,
    abortSignal: controller.signal,
    events: {
      onModelCallEvidence: (event) =>
        evidence.push({
          clientInvoked: event.clientInvoked,
          outcome: event.outcome,
        }),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  }).then(() => {
    settled = true;
  });

  await shadowStarted;
  controller.abort("user_requested");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    false,
    "the run closed while an invoked shadow client still owned evidence",
  );
  releaseShadow();
  await mission;

  assert.deepEqual(evidence, [{ clientInvoked: true, outcome: "error" }]);
  assert.deepEqual(completions, ["user_stopped"]);
});

test("mission wall-clock deadline aborts an in-flight provider request", async () => {
  const completions: string[] = [];
  const statuses: string[] = [];
  const traceMessages: string[] = [];
  const waitForAbort = (request: ModelChatRequest): Promise<ModelChatResponse> =>
    new Promise((_resolve, reject) => {
      const signal = request.abortSignal;
      const rejectAborted = () => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) {
        rejectAborted();
        return;
      }
      signal?.addEventListener("abort", rejectAborted, { once: true });
    });
  const client: ModelClient = {
    chat: waitForAbort,
    streamChat: waitForAbort,
  };
  const { context } = createRunnerVaultContext({
    prompt: "Explain local-first research in chat only.",
  });
  context.settings = createRunnerSettings({
    maxRunMinutes: 0.001,
    requestTimeoutMs: 10_000,
    modelRouterEnabled: false,
  });

  const startedAt = Date.now();
  await runAgentMission({
    prompt: "Explain local-first research in chat only.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: context,
    enableStreaming: false,
    events: {
      onRunComplete: (event) => completions.push(event.stopReason),
      onStatus: (message) => statuses.push(message),
      onTrace: (event) => traceMessages.push(event.message),
    },
  });

  assert.ok(Date.now() - startedAt < 2_000);
  assert.deepEqual(completions, ["budget"]);
  assert.ok(statuses.includes("Wall-clock run budget expired. The ledger was saved and this run can be continued."));
  assert.ok(traceMessages.includes("Wall-clock run budget expired. The ledger was saved and this run can be continued."));
});

test("a host-linked wall-clock abort remains a budget rather than a user stop", async () => {
  const controller = new AbortController();
  const completions: string[] = [];
  const client: ModelClient = {
    chat: async (request) => {
      controller.abort(new Error("Orchestrator root wall-clock budget exhausted."));
      await new Promise<void>((resolve, reject) => {
        const signal = request.abortSignal;
        const rejectAborted = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) {
          rejectAborted();
          return;
        }
        signal?.addEventListener("abort", rejectAborted, { once: true });
      });
      throw new Error("unreachable");
    },
    streamChat: async () => {
      throw new Error("streamChat is not used by this non-streaming test");
    },
  };
  const { context } = createRunnerVaultContext({
    prompt: "Explain local-first research in chat only.",
  });
  context.settings = createRunnerSettings({ modelRouterEnabled: false });

  await runAgentMission({
    prompt: "Explain local-first research in chat only.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: context,
    enableStreaming: false,
    abortSignal: controller.signal,
    events: {
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.deepEqual(completions, ["budget"]);
});

test("write-required no-tool answers stop after two unchanged-frontier responses", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const chatResponders: ChatResponder[] = Array.from(
    { length: 8 },
    () => () => responseWithContent("chat-only answer"),
  );

  const client = createClient({
    chatRequests,
    chatResponders,
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.ok(
    statuses.some((message) => /twice returned no tool call/iu.test(message)),
  );
  assert.match(deltas.join(""), /twice returned no tool call/iu);
});

test("web research can search then fetch a source before answering", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/mcp" }),
      (request) =>
        responseWithContent(
          `Cited answer with https://example.com/mcp ${getPassageCitationIds(request)[0] ?? ""}`.trim(),
        ),
    ],
  });

  await runAgentMission({
    prompt: "Research MCP servers and give me cited sources.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstStepToolNames.includes("web_search"));
  assert.ok(firstStepToolNames.includes("web_fetch"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(deltas.length, 1);
  assert.match(deltas[0], /Cited answer with https:\/\/example\.com\/mcp/);
  assert.match(deltas[0], /source:[a-z0-9]+:passage:\d+-\d+/i);
});

test("low-cap sourced generated essay finalizes with note writeback", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const finalDeltas: string[] = [];
  const grapesEvidenceText =
    'The Grapes of Wrath source says Steinbeck frames "solidarity through the Joad family" as quoted textual pressure.';
  const vault = createRunnerVaultContext({
    prompt:
      "Write me a 1000 word essay on Grapes of Wrath. Use text level quotation and citations.",
    content: "Essay prompt",
  });
  vault.context.settings = createRunnerSettings({
    maxAgentSteps: 5,
    streamWritebackMode: "all_current_note_content_writes",
  });
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "Grapes source",
              url: "https://example.com/grapes",
              snippet: "Steinbeck quotation context.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "Grapes source",
          url: "https://example.com/grapes",
          content: grapesEvidenceText,
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };
  const essayDraft = grapesEvidenceText;
  let verifiedEssayDraft = "";

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("web_search", {
          query: "Grapes of Wrath quotations citations",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/grapes",
        }),
      (request) => {
        const passageId = getPassageCitationIds(request)[0];
        const citedSentence =
          `${essayDraft} Source: https://example.com/grapes Evidence: ${passageId ?? ""}`.trim();
        verifiedEssayDraft = Array.from({ length: 40 }, () => citedSentence).join(
          " ",
        );
        return responseWithContent(verifiedEssayDraft);
      },
    ],
    streamResponders: [
      (request) => {
        const passageId = getPassageCitationIds(request)[0];
        const citedSentence =
          `${essayDraft} Source: https://example.com/grapes Evidence: ${passageId ?? ""}`.trim();
        verifiedEssayDraft = Array.from({ length: 40 }, () => citedSentence).join(
          " ",
        );
        return responseWithContentDeltas([verifiedEssayDraft]);
      },
    ],
  });

  await runAgentMission({
    prompt:
      "Write me a 1000 word essay on Grapes of Wrath. Use text level quotation and citations.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch", "append_to_current_file"],
  );
  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 0);
  assert.ok(
    statuses.some((message) =>
      /(?:Tool context is sufficient; drafting final output|Verified final output; committing)/.test(
        message,
      ),
    ),
  );
  assert.ok(!statuses.includes("Stopped at safety limit. Review partial results."));
  assert.ok(finalDeltas.length >= 1);
  assert.ok(finalDeltas.every((delta) => !/<tool_call>|<\/tool_call>/.test(delta)));
  assert.equal(
    vault.content.get("Current.md"),
    `Essay prompt\n${verifiedEssayDraft}`,
  );
});

test("explicit stream-to-page essay uses live writeback instead of append tool", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const statuses: string[] = [];
  const prompt =
    "Write me a 1000 word essay on grapes of wrath and stream it to the page.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const essayBody = [
    "# The Harvest of Injustice: Grapes of Wrath",
    "",
    "The Grapes of Wrath argues that dignity survives displacement.",
    ...Array.from({ length: 950 }, (_, index) => `solidarity${index}`),
  ].join(" ");
  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# The Harvest of Injustice: Grapes of Wrath\n\n",
          essayBody.replace(/^# The Harvest of Injustice: Grapes of Wrath\s*/, ""),
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: (message) => statuses.push(message),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(executedCalls, []);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].toolName, "append_to_current_file");
  assert.equal((receipts[0].output as { streamed?: boolean }).streamed, true);
  const note = vault.content.get("Current.md") ?? "";
  assert.match(note, /The Grapes of Wrath argues that dignity survives displacement/);
  assert.doesNotMatch(note, /^# The Harvest of Injustice: Grapes of Wrath/m);
  assert.doesNotMatch(note, /^# Untitled/m);
  assert.equal(
    completions.at(-1)?.stopReason,
    "write_completed",
    statuses.join("\n"),
  );
  assert.ok(!statuses.includes("Stopped at safety limit. Review partial results."));
  assert.ok(!statuses.some((message) => /Completion held for verification/.test(message)));
});

test("streaming writeback prompt includes Grok title output contract", () => {
  const prompt = buildStreamingWritebackPromptForTests("append", {
    missionPrompt: "Write Hello World in TypeScript on this page.",
    activeBasename: "Untitled 1",
  });
  assert.match(prompt, /OUTPUT CONTRACT/);
  assert.match(prompt, /PLUGIN BEHAVIOR/);
  assert.match(prompt, /ACTIVE NOTE: Untitled 1/);
  assert.match(prompt, /# Hello World in TypeScript/);
  assert.match(prompt, /Do not call rename_current_file/);
  assert.match(prompt, /leading H1 is title metadata/);
  assert.match(prompt, /removes it from the note body/);

  const retryPrompt = buildStreamingWritebackPromptForTests("append", {
    retry: true,
    activeBasename: "Untitled",
  });
  assert.match(retryPrompt, /First character must be #/);

  const namedPrompt = buildStreamingWritebackPromptForTests("append", {
    activeBasename: "Existing Note",
  });
  assert.match(namedPrompt, /Do not rename the file; the note already has a real title/);
});

test("word-count correction prefers expand-in-place edit into soft ±5% band", () => {
  const soft = softWordCountCorrectionBand(5000);
  assert.equal(soft.min, 4750);
  assert.equal(soft.max, 5250);

  const under = buildWordCountCorrectionPromptForTests(
    { target: 5000, min: 5000, max: 5500 },
    4600,
  );
  assert.match(under, /soft ±5% band of 4750–5250 words \(target 5000\)/i);
  assert.match(under, /about 4600 words/i);
  assert.match(under, /Prefer expand-in-place/i);
  assert.match(under, /adding sentences, examples, analysis, or transitions/i);
  assert.match(under, /Do not discard the draft and rewrite from scratch/i);
  assert.doesNotMatch(under, /Replace the previous draft entirely/i);

  const over = buildWordCountCorrectionPromptForTests(
    { target: 5000, min: 5000, max: 5500 },
    5600,
  );
  assert.match(over, /Prefer edit-in-place: trim redundancy/i);
});

test("streamed append onto Untitled 1 auto-renames visible title from leading H1", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const statuses: string[] = [];
  const prompt =
    "Write Hello World in TypeScript on this page and stream it to the note.";
  const vault = createRunnerVaultContext({
    prompt,
    path: "Untitled 1.md",
    content: "",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Hello World in TypeScript\n\n",
          '```ts\nconsole.log("Hello, world!");\n```\n',
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry([]),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].messages.at(-1)?.role, "user");
  assert.match(
    streamRequests[0].messages.at(-1)?.content ?? "",
    /OUTPUT CONTRACT/,
  );
  assert.ok(
    receipts.some((receipt) => receipt.toolName === "append_to_current_file"),
  );
  const renameReceipt = receipts.find(
    (receipt) => receipt.toolName === "rename_current_file",
  );
  assert.ok(renameReceipt, statuses.join("\n"));
  assert.equal(renameReceipt?.path, "Untitled 1.md");
  assert.equal(renameReceipt?.toPath, "Hello World in TypeScript.md");
  assert.equal(vault.content.has("Untitled 1.md"), false);
  assert.match(
    vault.content.get("Hello World in TypeScript.md") ?? "",
    /Hello, world!/,
  );
  assert.doesNotMatch(
    vault.content.get("Hello World in TypeScript.md") ?? "",
    /^#\s+Hello World in TypeScript\b/m,
  );
  const appendReceipt = receipts.find(
    (receipt) => receipt.toolName === "append_to_current_file",
  );
  assert.equal(
    (appendReceipt?.output as { leadingTitle?: string } | undefined)?.leadingTitle,
    "Hello World in TypeScript",
  );
  assert.ok(
    statuses.some((message) =>
      /Renamed placeholder note to Hello World in TypeScript/i.test(message),
    ),
  );
});

test("streamed append onto named notes does not auto-rename", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const prompt = "Write a short note about grapes and stream it to the page.";
  const vault = createRunnerVaultContext({
    prompt,
    path: "Research.md",
    content: "# Research\n\n",
  });
  const client = createClient({
    chatRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Grapes Notes\n\n",
          "Grapes grow on vines.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.ok(
    receipts.some((receipt) => receipt.toolName === "append_to_current_file"),
  );
  assert.ok(
    !receipts.some((receipt) => receipt.toolName === "rename_current_file"),
  );
  assert.ok(vault.content.has("Research.md"));
  assert.equal(vault.content.has("Grapes Notes.md"), false);
  const note = vault.content.get("Research.md") ?? "";
  assert.equal((note.match(/^# Research$/gm) ?? []).length, 1);
  assert.doesNotMatch(note, /^# Grapes Notes$/m);
  assert.match(note, /Grapes grow on vines/);
});

test("tool-path append onto Untitled auto-renames without model rename call", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const statuses: string[] = [];
  const prompt = "Append a titled hello world note to this page.";
  const vault = createRunnerVaultContext({
    prompt,
    path: "Untitled.md",
    content: "",
    streamWritebackMode: "off",
  });
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "# Hello World in TypeScript\n\nconsole.log('hi');\n",
        }),
      () => responseWithContent("Appended the titled note."),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.ok(
    executedCalls.some((call) => call.name === "append_to_current_file"),
    statuses.join("\n"),
  );
  assert.ok(
    !executedCalls.some((call) => call.name === "rename_current_file"),
  );
  const renameReceipt = receipts.find(
    (receipt) => receipt.toolName === "rename_current_file",
  );
  assert.ok(renameReceipt, `receipts=${JSON.stringify(receipts)}\n${statuses.join("\n")}`);
  assert.equal(renameReceipt?.toPath, "Hello World in TypeScript.md");
  assert.equal(vault.content.has("Untitled.md"), false);
  assert.ok(vault.content.has("Hello World in TypeScript.md"));
  const appendCall = executedCalls.find(
    (call) => call.name === "append_to_current_file",
  );
  assert.equal(appendCall?.arguments.text, "console.log('hi');\n");
  assert.doesNotMatch(
    vault.content.get("Hello World in TypeScript.md") ?? "",
    /^#\s+Hello World in TypeScript\b/m,
  );
});

test("exact-markdown replacement binds user bytes instead of lossy model arguments", async () => {
  const prompt =
    "Replace the entire current note with exactly this markdown:\n# Approved Replacement\n\nBOUND_MARKER";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({ prompt, content: "# Original" });
  vault.context.settings.modelRouterMode = "off";
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("replace_current_file", { text: "BOUND_MARKER" }),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {},
  });

  assert.equal(
    extractExactMarkdownReplacementPayload(prompt),
    "# Approved Replacement\n\nBOUND_MARKER",
  );
  assert.equal(
    executedCalls.find((call) => call.name === "replace_current_file")?.arguments
      .text,
    "# Approved Replacement\n\nBOUND_MARKER",
  );
});

test("tool-path append onto a named note consumes the generated title H1", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const prompt = "Append a titled grape-growing note to this page.";
  const vault = createRunnerVaultContext({
    prompt,
    path: "Research.md",
    content: "# Research\n\nExisting context.\n",
    streamWritebackMode: "off",
  });
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "# Grapes Notes\n\nGrapes grow on vines.\n",
        }),
      () => responseWithContent("Appended the grape-growing note."),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const appendCall = executedCalls.find(
    (call) => call.name === "append_to_current_file",
  );
  assert.equal(appendCall?.arguments.text, "Grapes grow on vines.\n");
  assert.ok(!receipts.some((receipt) => receipt.toolName === "rename_current_file"));
  assert.equal(vault.content.has("Research.md"), true);
  const note = vault.content.get("Research.md") ?? "";
  assert.equal((note.match(/^# Research$/gm) ?? []).length, 1);
  assert.doesNotMatch(note, /^# Grapes Notes$/m);
  assert.match(note, /Grapes grow on vines/);
});

test("placeholder auto-rename uses numeric suffix on collision", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const prompt = "Write Hello World in TypeScript on this page.";
  const vault = createRunnerVaultContext({
    prompt,
    path: "Untitled.md",
    content: "",
  });
  vault.content.set("Hello World in TypeScript.md", "existing\n");
  const client = createClient({
    chatRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Hello World in TypeScript\n\n",
          "body text",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const renameReceipt = receipts.find(
    (receipt) => receipt.toolName === "rename_current_file",
  );
  assert.equal(renameReceipt?.toPath, "Hello World in TypeScript 2.md");
  assert.ok(vault.content.has("Hello World in TypeScript 2.md"));
  assert.ok(vault.content.has("Hello World in TypeScript.md"));
});

test("streamed writeback does not reuse an older generated word target", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const prompt =
    "Write me a short essay on Grapes of Wrath and stream it to the page.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Harvest of Injustice\n\n",
          "The Grapes of Wrath follows the Joad family through migration, hunger, and labor exploitation.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    conversationHistory: [
      {
        role: "user",
        content: "Generate me a 1000 word essay on Grapes of Wrath.",
      },
      {
        role: "assistant",
        content: "Earlier short draft.",
      },
    ],
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.ok(
    streamRequests[0].messages.some((message) =>
      /Generate me a 1000 word essay on Grapes of Wrath/i.test(message.content),
    ),
    "the regression must include the older numeric request in prompt history",
  );
  assert.ok(!statuses.some((message) => /1000|correction pass/i.test(message)));
  assert.equal(
    vault.content.get("Current.md"),
    "The Grapes of Wrath follows the Joad family through migration, hunger, and labor exploitation.",
  );
});

test("current-note writeback flushes token-sized chunks before completion", async () => {
  const prompt = "In this note, write a short project update.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const chunks = Array.from(
    { length: 14 },
    (_, index) => `Project update ${index}. `,
  );
  const client: ModelClient = {
    chat: async () => {
      throw new Error("chat should not be called for direct writeback");
    },
    streamChat: async (_request, events = {}) => {
      for (const chunk of chunks) {
        events.onContentDelta?.(chunk);
      }
      await Promise.resolve();
      await Promise.resolve();
      assert.match(vault.content.get("Current.md") ?? "", /Project update 0/);
      return responseWithContent(chunks.join(""));
    },
  };

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {},
  });

  assert.equal(vault.content.get("Current.md"), `Initial note\n${chunks.join("")}`);
});

test("generated leading H1 is consumed instead of duplicating the Obsidian title", async () => {
  const prompt = "Write a short essay on Grapes of Wrath and stream it to the page.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const client = createClient({
    chatRequests: [],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "   # The Harvest",
          " of Injustice #\n\n",
          "The Grapes of Wrath follows families facing dispossession.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {},
  });

  const note = vault.content.get("Current.md") ?? "";
  assert.equal(
    note,
    "The Grapes of Wrath follows families facing dispossession.",
  );
  assert.equal((note.match(/^# /gm) ?? []).length, 0);
});

test("generated leading H1 is consumed against the latest current-note body", async () => {
  const prompt = "Write a short essay on Grapes of Wrath and stream it to the page.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const client = createClient({
    chatRequests: [],
    streamResponders: [
      () => {
        vault.content.set(
          "Current.md",
          "# Untitled\n\nPrompt text that arrived after writer setup.\n",
        );
        return responseWithContentDeltas([
          "# The Harvest of Injustice\n\n",
          "The Grapes of Wrath follows families facing dispossession.",
        ]);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {},
  });

  assert.equal(
    vault.content.get("Current.md"),
    [
      "Prompt text that arrived after writer setup.",
      "The Grapes of Wrath follows families facing dispossession.",
    ].join("\n"),
  );
});

test("compound title and essay prompt retitles then streams essay content", async () => {
  const prompt =
    "Write an essay on Grapes of Wrath on this note and change the title as well.";
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithContent("I will retitle the note before writing."),
      () =>
        responseWithToolCall("rename_current_file", {
          title: "The Harvest of Injustice",
        }),
      () => responseWithContent("Ready to write the essay."),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "The Grapes of Wrath presents survival as a collective duty.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "rename_current_file"],
  );
  assert.equal(chatRequests.length, 2);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].think, false);
  assert.ok(
    streamRequests[0].messages.some(
      (message) =>
        message.role === "user" &&
        message.content.includes("requested title change is complete"),
    ),
  );
  assert.ok(
    statuses.includes(
      "Title update complete; starting content-only streamed writeback...",
    ),
  );
  assert.equal(
    vault.content.get("The Harvest of Injustice.md"),
    "# Untitled\n\nThe Grapes of Wrath presents survival as a collective duty.",
  );
});

test("citation writeback gathers required web tools then commits the verified candidate without a duplicate stream", async () => {
  const prompt =
    "Write me a 300 word argumentative essay on Grapes of Wrath. Use text level quotation and citations.";
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const verificationTraces: Array<{ message: string; outputPreview?: unknown }> = [];
  const vault = createRunnerVaultContext({ prompt, content: "Prompt" });
  let fetchedUrl = "";
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "Unrelated gardening result",
              url: "https://example.com/gardening",
              snippet: "Tomato planting calendar",
            },
            {
              title: "Grapes source",
              url: "https://example.com/grapes",
              snippet: "Steinbeck source",
            },
          ],
        },
      };
    }

    if (request.url.endsWith("/web_fetch")) {
      fetchedUrl = JSON.parse(
        typeof request.body === "string" ? request.body : "{}",
      )?.url ?? "";
      return {
        status: 200,
        headers: {},
        json: {
          title: "Fetched Grapes source",
          content:
            'The Grapes of Wrath source says "collective survival" names hardship as a public failure.',
          links: [],
        },
      };
    }

    throw new Error(`Unexpected request: ${request.url}`);
  };
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithContent("I can answer without tools."),
      () => responseWithContent("Still answering without tools."),
      () => responseWithContent("Ready to write from sources."),
      (request) => {
        const passageId = getPassageCitationIds(request)[0] ?? "";
        const citedSentence =
          `The Grapes of Wrath source says "collective survival" names hardship as a public failure. ` +
          `Source: https://example.com/grapes [${passageId}]`;
        return responseWithContent(
          Array.from({ length: 17 }, () => citedSentence).join(" "),
        );
      },
    ],
    streamResponders: [
      (request) => {
        const citedSentence =
          `The Grapes of Wrath source says "collective survival" documents public hardship. Source: https://example.com/grapes ${getPassageCitationIds(request)[0] ?? ""}`.trim();
        return responseWithContentDeltas([
          Array.from({ length: 15 }, () => citedSentence).join(" "),
        ]);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onRunComplete: (event) => completions.push(event),
      onTrace: (event) => {
        if (event.kind === "verification") {
          verificationTraces.push({
            message: event.message,
            outputPreview: event.outputPreview,
          });
        }
      },
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch", "append_to_current_file"],
  );
  assert.equal(fetchedUrl, "https://example.com/grapes");
  assert.equal(streamRequests.length, 0);
  assert.equal(
    vault.operations.filter((item) => item === "modify:Current.md").length,
    1,
    JSON.stringify({ statuses, completions, verificationTraces }, null, 2),
  );
  assert.match(vault.content.get("Current.md") ?? "", /collective survival/);
});

test("a queued write does not mask actionable web-evidence recovery", async () => {
  const prompt =
    "Research the official source and append one passage-cited finding to this note.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const vault = createRunnerVaultContext({ prompt, content: "Original note" });
  vault.context.settings = createRunnerSettings({
    enableStreaming: false,
    streamWritebackMode: "off",
    modelRouterEnabled: false,
    modelRouterMode: "off",
    researchMemoryEnabled: false,
  });
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [{
            title: "Official source",
            url: "https://example.com/official",
            snippet: "The official source supports the bounded finding.",
          }],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "Official source",
          url: "https://example.com/official",
          content: "The official source supports the bounded finding with direct evidence.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "Premature unverified mutation.",
        }),
      () => responseWithContent("I am done before gathering the required evidence."),
      () =>
        responseWithToolCall("web_search", {
          query: "official bounded finding",
          max_results: 1,
        }),
      (request) => {
        const citation = getPassageCitationIds(request)[0] ?? "";
        return responseWithContent([
          `The official source supports the bounded finding [${citation}].`,
          "",
          `Source: https://example.com/official [${citation}]`,
          "",
          "Limitations: one bounded official source.",
          "Confidence: high for the quoted passage.",
          "Unanswered questions: none for this bounded finding.",
        ].join("\n"));
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: { onReceipt: (receipt) => receipts.push(receipt) },
  });

  assert.ok(chatRequests.length >= 3);
  assert.ok(executedCalls.some((call) => call.name === "web_search"));
  assert.ok(executedCalls.some((call) => call.name === "web_fetch"));
  assert.equal(receipts.filter((receipt) => receipt.operation === "append").length, 1);
});

test("proof-gated cited writeback stages progressive corrections before one note commit", async () => {
  const prompt =
    "Research MCP servers on the web and append a concise summary with passage citations to this note.";
  const originalNote = "Original note must remain byte-identical while drafts are checked.";
  const currentNotePassageId = extractEvidencePassages(originalNote, {
    sourceLocator: "Current.md",
  }).passages[0]!.id;
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const statuses: string[] = [];
  const verificationTraces: Array<{ message: string; outputPreview?: unknown }> = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: originalNote,
  });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          query: "MCP servers",
          results: [
            {
              title: "MCP overview",
              snippet: "MCP servers expose tools and resources.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "MCP overview",
          url: "https://example.com/mcp",
          content:
            "MCP servers expose tools and resources through a standard protocol.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const invalidDraft =
    "INVALID UNVERIFIED WRITEBACK: MCP servers expose tools, but this draft has no bound citation.";
  let partiallyCorrectedDraft = "";
  let correctedDraft = "";
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/mcp",
        }),
      () => responseWithContent(invalidDraft),
      (request) => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        const correction = [...request.messages].reverse().find(
          (message) =>
            message.role === "system" &&
            message.content.includes("The complete accepted passage-id set is:"),
        );
        assert.ok(correction, "expected a scoped final-output correction prompt");
        const correctionIds = [
          ...new Set(
            correction.content.match(/source:[a-z0-9]+:passage:\d+-\d+/giu) ?? [],
          ),
        ];
        assert.equal(
          correctionIds.length,
          1,
          `correction must offer only the fetched web passage, got ${correctionIds.join(", ")}`,
        );
        const passageId = correctionIds[0];
        assert.ok(passageId, "the correction must retain the fetched passage id");
        partiallyCorrectedDraft =
          `Bananas orbit distant planets in this deliberately ungrounded intermediate draft [${passageId}].`;
        return responseWithContent(partiallyCorrectedDraft);
      },
      (request) => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        const correction = [...request.messages].reverse().find(
          (message) =>
            message.role === "system" &&
            message.content.includes("The complete accepted passage-id set is:"),
        );
        assert.ok(correction, "expected a second scoped correction prompt");
        const correctionIds = [
          ...new Set(
            correction.content.match(/source:[a-z0-9]+:passage:\d+-\d+/giu) ?? [],
          ),
        ];
        assert.equal(correctionIds.length, 1);
        const passageId = correctionIds[0];
        assert.ok(passageId);
        correctedDraft =
          "MCP servers expose tools and resources through a standard protocol. " +
          `Source: https://example.com/mcp Passage evidence: [${passageId}]`;
        return responseWithContent(`${correctedDraft} [${currentNotePassageId}]`);
      },
    ],
    streamResponders: [
      () => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        assert.equal(
          vault.operations.filter((item) => item === "modify:Current.md").length,
          0,
        );
        return responseWithContentDeltas([invalidDraft]);
      },
      (request) => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        assert.equal(
          vault.operations.filter((item) => item === "modify:Current.md").length,
          0,
        );
        const passageId = getPassageCitationIds(request)[0];
        assert.ok(passageId, "the correction must retain the fetched passage id");
        correctedDraft =
          "MCP servers expose tools and resources through a standard protocol. " +
          `Source: https://example.com/mcp Passage evidence: [${passageId}]`;
        return responseWithContentDeltas([correctedDraft]);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onRunComplete: (event) => completions.push(event),
      onStatus: (message) => statuses.push(message),
      onTrace: (event) => {
        if (event.kind === "verification") {
          verificationTraces.push({
            message: event.message ?? "",
            outputPreview: event.outputPreview,
          });
        }
      },
    },
  });

  assert.equal(executedCalls[0]?.name, "web_search");
  assert.ok(
    executedCalls.slice(1, -1).every((call) => call.name === "web_fetch"),
  );
  assert.ok(
    executedCalls.filter((call) => call.name === "web_fetch").length >= 1,
  );
  assert.equal(
    executedCalls.at(-1)?.name,
    "append_to_current_file",
    JSON.stringify({
      statuses,
      verificationTraces,
      executed: executedCalls.map((call) => call.name),
      completions,
    }),
  );
  assert.equal(streamRequests.length, 0);
  assert.ok(
    statuses.some((message) =>
      /(?:Writeback draft held for verification|Verified append candidate held for correction)/i.test(
        message,
      ),
    ),
    JSON.stringify(statuses),
  );
  assert.ok(
    verificationTraces.some((trace) =>
      /claim_grounding/i.test(trace.message),
    ),
    JSON.stringify(verificationTraces.map((trace) => trace.message)),
  );
  assert.ok(
    statuses.some((message) => /claim_grounding/i.test(message)) ||
      verificationTraces.some((trace) => {
        const preview =
          trace.outputPreview &&
          typeof trace.outputPreview === "object" &&
          trace.outputPreview !== null
            ? (trace.outputPreview as { missing?: string[] }).missing
            : undefined;
        return Array.isArray(preview)
          ? preview.some((item) => item.includes("claim_grounding"))
          : false;
      }) ||
      statuses.some((message) =>
        /Writeback draft held for verification/i.test(message),
      ),
    "expected claim grounding or citation hold before correction",
  );
  assert.equal(receipts.length, 1);
  assert.equal(completions.at(-1)?.stopReason, "write_completed");
  assert.equal(receipts[0].toolName, "append_to_current_file");
  assert.equal(
    vault.operations.filter((item) => item === "modify:Current.md").length,
    1,
  );
  assert.equal(
    vault.content.get("Current.md"),
    `${originalNote}\n${correctedDraft}`,
  );
  assert.equal(
    statuses.filter((message) =>
      /(?:Writeback draft held for verification|Verified append candidate held for correction)/i.test(
        message,
      ),
    ).length,
    2,
    JSON.stringify(statuses),
  );
  assert.doesNotMatch(vault.content.get("Current.md") ?? "", /INVALID UNVERIFIED/);
  assert.doesNotMatch(
    vault.content.get("Current.md") ?? "",
    new RegExp(currentNotePassageId, "u"),
  );
  assert.ok(
    verificationTraces.some((trace) =>
      /outside the accepted fetched-source set/iu.test(trace.message),
    ),
    JSON.stringify(verificationTraces.map((trace) => trace.message)),
  );
});

test("named vault reads use exact ordered path frontiers before current-note append", async () => {
  const sourceA = "E2E Agent Tests/Source A.md";
  const sourceB = "E2E Agent Tests/Source B.md";
  const prompt =
    `Read the two named vault notes ${sourceA} and ${sourceB}. ` +
    "Synthesize exactly two findings and append them to the current note.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Current\n",
    streamWritebackMode: "off",
  });
  vault.context.settings.modelRouterMode = "off";
  vault.content.set(sourceA, "Finding Alpha");
  vault.content.set(sourceB, "Finding Beta");
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const graphs: Array<{
    nodes: Record<string, {
      allowedTools: string[];
      status: string;
      inputs?: { resource?: { selector?: string | null } };
    }>;
  }> = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      // The host binds this transcription to the exact first graph selector.
      () => responseWithToolCall("read_file", { path: "Other/Wrong.md" }),
      () => responseWithToolCall("read_file", { path: sourceB }),
    ],
    streamResponders: [
      () =>
        responseWithContent(
          "Finding Alpha from the named vault note. Finding Beta from the named vault note.",
        ),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 3,
    events: {
      onMissionGraphUpdate: (graph) => graphs.push(graph),
    },
  });

  const agentRequests = chatRequests.filter(
    (request) => request.evidencePhase === "agent_step",
  );
  assert.ok(agentRequests.length > 0);
  assert.equal(
    agentRequests.every((request) =>
      (request.tools ?? []).every((tool) =>
        ["read_file", "append_to_current_file"].includes(tool.function.name),
      ),
    ),
    true,
  );
  assert.deepEqual(
    agentRequests.at(-1)?.tools?.map((tool) => tool.function.name) ?? [],
    ["append_to_current_file"],
  );
  assert.equal(
    Object.keys(graphs.at(-1)?.nodes ?? {}).some((id) => id.startsWith("retry-")),
    false,
  );
  assert.match(vault.content.get("Current.md") ?? "", /Finding Alpha/u);
  assert.match(vault.content.get("Current.md") ?? "", /Finding Beta/u);
});

test("compound adaptive research uses persisted lifecycle graph stage before in-memory fallback", () => {
  const stages = [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "private_github_publication",
  ] as const;
  const graph = {
    nodes: {
      "lifecycle-accepted_research": { status: "complete" },
      "lifecycle-linear_hierarchy": { status: "complete" },
      "lifecycle-code_execution": { status: "ready" },
      "lifecycle-private_github_publication": { status: "queued" },
    },
  } as any;

  assert.equal(
    resolveActiveCompoundLifecycleStageV1(
      graph,
      stages,
      "accepted_research",
    ),
    "code_execution",
  );
  assert.equal(
    resolveActiveCompoundLifecycleStageV1(null, stages, "linear_hierarchy"),
    "linear_hierarchy",
  );
});

test("compound adaptive research closes quick tier without capping later stages", () => {
  const quickPlan = {
    effort: {
      tier: "quick",
      budget: {
        maxModelStepsPerSegment: 8,
        maxToolCallsPerSegment: 4,
        maxSegments: 1,
        maxTotalModelSteps: 8,
        maxTotalToolCalls: 4,
        maxDurationMs: null,
      },
      reasons: [],
      constrained: false,
    },
    effortUsage: {
      modelSteps: 8,
      toolCalls: 3,
      segmentsStarted: 1,
      modelStepsInCurrentSegment: 8,
      elapsedMs: 1_000,
    },
  } as any;

  assert.deepEqual(
    evaluateCompoundResearchBudgetGateV1(quickPlan, "accepted_research"),
    {
      action: "close",
      reason: "model_step_cap_reached",
      closureAttempts: 0,
    },
  );
  assert.deepEqual(
    evaluateCompoundResearchBudgetGateV1(quickPlan, "code_execution"),
    { action: "inactive" },
  );

  const deepPlan = {
    ...quickPlan,
    effort: {
      ...quickPlan.effort,
      tier: "deep",
      budget: {
        maxModelStepsPerSegment: 60,
        maxToolCallsPerSegment: 30,
        maxSegments: 1,
        maxTotalModelSteps: 60,
        maxTotalToolCalls: 30,
        maxDurationMs: null,
      },
    },
    effortUsage: {
      modelSteps: 20,
      toolCalls: 30,
      segmentsStarted: 1,
      modelStepsInCurrentSegment: 20,
      toolCallsInCurrentSegment: 30,
      elapsedMs: 2_000,
    },
  } as any;
  assert.deepEqual(
    evaluateCompoundResearchBudgetGateV1(deepPlan, "accepted_research"),
    {
      action: "close",
      reason: "tool_call_cap_reached",
      closureAttempts: 0,
    },
  );
});

test("compound extended research rolls segments then reserves one durable closure turn", () => {
  const extendedPlan = {
    effort: {
      tier: "extended",
      budget: {
        maxModelStepsPerSegment: 100,
        maxToolCallsPerSegment: 50,
        maxSegments: 4,
        maxTotalModelSteps: 400,
        maxTotalToolCalls: 200,
        maxDurationMs: 8 * 60 * 60_000,
      },
      reasons: [],
      constrained: false,
    },
    effortUsage: {
      modelSteps: 100,
      toolCalls: 45,
      segmentsStarted: 1,
      modelStepsInCurrentSegment: 100,
      toolCallsInCurrentSegment: 45,
      elapsedMs: 60_000,
    },
  } as any;

  assert.deepEqual(
    evaluateCompoundResearchBudgetGateV1(
      extendedPlan,
      "accepted_research",
    ),
    {
      action: "start_next_segment",
      reason: "research_segment_cap_reached",
    },
  );

  extendedPlan.effortUsage = {
    modelSteps: 400,
    toolCalls: 180,
    segmentsStarted: 4,
    modelStepsInCurrentSegment: 100,
    toolCallsInCurrentSegment: 45,
    elapsedMs: 240_000,
  };
  assert.deepEqual(
    evaluateCompoundResearchBudgetGateV1(
      extendedPlan,
      "accepted_research",
    ),
    {
      action: "close",
      reason: "model_step_cap_reached",
      closureAttempts: 0,
    },
  );

  extendedPlan.effortClosure = {
    requested: true,
    attempts: 1,
    reason: "model_step_cap_reached",
  };
  assert.deepEqual(
    evaluateCompoundResearchBudgetGateV1(
      extendedPlan,
      "accepted_research",
    ),
    {
      action: "close",
      reason: "model_step_cap_reached",
      closureAttempts: 1,
    },
  );
});

test("compound research host segments are a bounded reserve outside later pipeline segments", () => {
  const plan = {
    effort: {
      tier: "extended",
      budget: {
        maxModelStepsPerSegment: 100,
        maxToolCallsPerSegment: 50,
        maxSegments: 4,
        maxTotalModelSteps: 400,
        maxTotalToolCalls: 200,
        maxDurationMs: 8 * 60 * 60_000,
      },
      reasons: [],
      constrained: false,
    },
    effortUsage: {
      modelSteps: 400,
      toolCalls: 180,
      segmentsStarted: 4,
      modelStepsInCurrentSegment: 100,
      toolCallsInCurrentSegment: 45,
      completionSegmentsStarted: 99,
      elapsedMs: 240_000,
    },
  } as any;

  assert.deepEqual(
    resolveCompoundCompletionSegmentBudgetV1({
      completionSegmentIndex: 4,
      maxCompletionSegments: 4,
      compoundLifecycleDetected: true,
      researchPlan: plan,
    }),
    {
      segmentsUsed: 0,
      maxSegments: 4,
      reservedResearchSegments: 5,
    },
  );
  assert.deepEqual(
    resolveCompoundCompletionSegmentBudgetV1({
      completionSegmentIndex: 8,
      maxCompletionSegments: 4,
      compoundLifecycleDetected: true,
      researchPlan: plan,
    }),
    {
      segmentsUsed: 4,
      maxSegments: 4,
      reservedResearchSegments: 5,
    },
  );
});

test("compound research checks every counted tool and closure exposes only publication", () => {
  const quickPlan = {
    effort: {
      tier: "quick",
      budget: {
        maxModelStepsPerSegment: 8,
        maxToolCallsPerSegment: 4,
        maxSegments: 1,
        maxTotalModelSteps: 8,
        maxTotalToolCalls: 4,
        maxDurationMs: null,
      },
      reasons: [],
      constrained: false,
    },
    effortUsage: {
      modelSteps: 3,
      toolCalls: 3,
      segmentsStarted: 1,
      modelStepsInCurrentSegment: 3,
      toolCallsInCurrentSegment: 3,
      completionSegmentsStarted: 1,
      elapsedMs: 1_000,
    },
  } as any;

  assert.deepEqual(
    evaluateCompoundResearchToolCallGateV1({
      plan: quickPlan,
      activeStage: "accepted_research",
      toolName: "web_fetch",
    }),
    { allowed: true, counted: true },
  );
  quickPlan.effortUsage.toolCalls = 4;
  quickPlan.effortUsage.toolCallsInCurrentSegment = 4;
  assert.deepEqual(
    evaluateCompoundResearchToolCallGateV1({
      plan: quickPlan,
      activeStage: "accepted_research",
      toolName: "web_fetch",
    }),
    {
      allowed: false,
      counted: true,
      reason: "research_budget_reached",
    },
  );
  assert.deepEqual(
    evaluateCompoundResearchToolCallGateV1({
      plan: quickPlan,
      activeStage: "accepted_research",
      toolName: "linear_create_issue",
      closureOnly: true,
    }),
    { allowed: false, counted: false, reason: "publication_only" },
  );
  assert.deepEqual(
    evaluateCompoundResearchToolCallGateV1({
      plan: quickPlan,
      activeStage: "accepted_research",
      toolName: "publish_research_to_linear",
      closureOnly: true,
    }),
    { allowed: true, counted: false },
  );

  const schemas = [
    "web_fetch",
    "publish_research_to_linear",
    "linear_create_issue",
  ].map((name) => ({ function: { name } }));
  assert.deepEqual(
    restrictCompoundResearchClosureToolsV1(schemas, true).map(
      (tool) => tool.function.name,
    ),
    ["publish_research_to_linear"],
  );
});

test("a phase-deferred conflicting-source append recovers and commits exactly once", async () => {
  const marker = "E2E_MARKER_CONFLICT_REPAIR_01";
  const prompt =
    `Search the web for exactly two sources about controlled onboarding validation, fetch and verify both, compare their conflicting conclusions, then append a short synthesis with exact passage citations and an explicit Limitations section to this note. Include the marker ${marker}.`;
  const originalNote = "Original note remains unchanged until verification passes.";
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const verificationTraces: string[] = [];
  const verificationPreviews: unknown[] = [];
  const vault = createRunnerVaultContext({ prompt, content: originalNote });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "MCP tools",
              url: "https://example.com/mcp-tools",
              snippet: "MCP servers expose tools through a standard protocol.",
            },
            {
              title: "MCP resources",
              url: "https://example.org/mcp-resources",
              snippet: "MCP servers can expose resources to clients.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      const url = JSON.parse(
        typeof request.body === "string" ? request.body : "{}",
      )?.url;
      return {
        status: 200,
        headers: {},
        json:
          url === "https://example.org/mcp-resources"
            ? {
                title: "MCP resources",
                url,
                content:
                  "The controlled onboarding validation evidence does not show improved user retention rate or reduced errors. The alternate study reports no reliable benefit.",
                links: [],
              }
            : {
                title: "MCP tools",
                url: "https://example.com/mcp-tools",
                content:
                  "The controlled onboarding validation evidence shows improved user retention rate and reduced errors. The primary study reports a reliable benefit.",
                links: [],
              },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP evidence" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/mcp-tools",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.org/mcp-resources",
        }),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "This premature draft must be phase-deferred without failing the write goal.",
        }),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "A repeated phase-deferred draft must not consume a durable graph attempt.",
        }),
      (request) => {
        const passages = getPassageCitationIds(request);
        assert.ok(passages.length >= 2, JSON.stringify(passages));
        return responseWithContent(
          `The primary source reports improved retention and reduced errors [${passages[0]}].\n\n` +
            `The alternate source reports no reliable benefit [${passages[1]}].`,
        );
      },
      (request) => {
        const passages = getPassageCitationIds(request);
        assert.ok(passages.length >= 2, JSON.stringify(passages));
        assert.ok(
          request.messages.some(
            (message) =>
              message.role === "system" &&
              message.content.includes(
                "Include an explicit ## Limitations section that says the sources conflict",
              ),
          ),
          "expected a repair prompt for the unresolved analyze-phase conflict",
        );
        assert.ok(
          request.messages.some(
            (message) =>
              message.role === "system" &&
              message.content.includes("Passage-grounded writeback contract"),
          ),
          "expected a one-time passage-grounded writeback contract before the first draft",
        );
        assert.ok(
          request.messages.some(
            (message) =>
              message.role === "system" &&
              message.content.includes(
                `Preserve every exact user-required literal marker in the final answer: ${marker}`,
              ),
          ),
          "expected the repair prompt to name the missing exact literal marker",
        );
        return responseWithContent(
          `${marker}\n\nOne source reports that controlled onboarding validation improves retention and reduces errors [${passages[0]}].\n\n` +
            "The other reports no reliable retention or error benefit.\n\n" +
            "## Limitations\n\nThe two sources conflict, so the comparison does not resolve the disagreement.\n\n" +
            "## Confidence\n\nMedium.\n\n" +
            "Sources: https://example.com/mcp-tools and https://example.org/mcp-resources",
        );
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onRunComplete: (event) => completions.push(event),
      onTrace: (event) => {
        if (event.id.includes("verified-final-append")) {
          verificationTraces.push(event.message ?? "");
          verificationPreviews.push(event.outputPreview);
        }
      },
    },
  });

  const executedNames = executedCalls.map((call) => call.name);
  assert.equal(
    executedNames.filter((name) => name === "append_to_current_file").length,
    1,
    JSON.stringify({
      executedNames,
      verificationTraces,
      verificationPreviews,
      completions,
    }),
  );
  assert.ok(
    executedNames.lastIndexOf("web_fetch") <
      executedNames.indexOf("append_to_current_file"),
    JSON.stringify(executedNames),
  );
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0].readback);
  assert.equal(
    vault.operations.filter((item) => item === "modify:Current.md").length,
    1,
  );
  assert.match(
    vault.content.get("Current.md") ?? "",
    /source:[a-z0-9-]+:passage:\d+-\d+/u,
  );
  const committedPassageIds = new Set(
    (vault.content.get("Current.md") ?? "").match(
      /source:[a-z0-9-]+:passage:\d+-\d+/gu,
    ) ?? [],
  );
  assert.ok(committedPassageIds.size >= 2, JSON.stringify([...committedPassageIds]));
  assert.ok(
    verificationTraces.some((message) =>
      /Deterministically attached .* accepted passage citation/iu.test(message),
    ),
    JSON.stringify(verificationTraces),
  );
  assert.ok(verificationTraces.some((message) => /candidate.*pass/iu.test(message)));
  assert.equal(completions.at(-1)?.stopReason, "write_completed");
  const persistedLedger = [...vault.content.entries()].find(
    ([path, content]) =>
      /^Agent Runs\/.+\.md$/u.test(path) && content.includes("## Mission Ledger"),
  )?.[1];
  assert.ok(persistedLedger, "expected the completed mission ledger to remain readable");
  assert.match(persistedLedger, /"claimPassages"\s*:\s*\[/u);
  assert.match(persistedLedger, /"evidenceConflicts"\s*:\s*\[/u);
  assert.match(persistedLedger, /"status"\s*:\s*"acknowledged_limitation"/u);
});

test("a verified direct conflicting-source append carries its acknowledgement through the receipt", async () => {
  const marker = "E2E_MARKER_DIRECT_CONFLICT_ACK_01";
  const prompt =
    `Search the web for exactly two sources about controlled onboarding validation, fetch and verify both, compare their conflicting conclusions, then append a short synthesis with exact passage citations and an explicit Limitations section to this note. Include the marker ${marker}.`;
  const originalNote = "Original note remains unchanged until a valid direct candidate is committed.";
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const traceSummary: Array<{ id: string; message: string; errorCode?: string }> = [];
  let directCandidate = "";
  const vault = createRunnerVaultContext({ prompt, content: originalNote });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "Primary onboarding evidence",
              url: "https://example.com/primary-onboarding",
              snippet: "Controlled onboarding validation improved retention and reduced errors.",
            },
            {
              title: "Alternate onboarding evidence",
              url: "https://example.org/alternate-onboarding",
              snippet: "Controlled onboarding validation did not show reliable benefits.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      const url = JSON.parse(
        typeof request.body === "string" ? request.body : "{}",
      )?.url;
      return {
        status: 200,
        headers: {},
        json:
          url === "https://example.org/alternate-onboarding"
            ? {
                title: "Alternate onboarding evidence",
                url,
                content:
                  "The controlled onboarding validation evidence does not show improved user retention rate or reduced errors. The alternate study reports no reliable benefit.",
                links: [],
              }
            : {
                title: "Primary onboarding evidence",
                url,
                content:
                  "The controlled onboarding validation evidence shows improved user retention rate and reduced errors. The primary study reports a reliable benefit.",
                links: [],
              },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "controlled onboarding evidence" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/primary-onboarding",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.org/alternate-onboarding",
        }),
      (request) => {
        const passages = getPassageCitationIds(request);
        assert.ok(passages.length >= 2, JSON.stringify(passages));
        directCandidate = [
          marker,
          "",
          "## Findings",
          "",
          `For controlled onboarding validation, the primary source concludes that retention improved and errors were reduced [${passages[0]}].`,
          "",
          `For controlled onboarding validation, the alternate source concludes that there was no reliable benefit [${passages[1]}].`,
          "",
          "## Limitations",
          "",
          "The two sources have conflicting conclusions, so this cited comparison does not resolve the disagreement.",
          "",
          "## Confidence",
          "",
          "Moderate confidence: both fetched passages are cited, but their conclusions conflict.",
        ].join("\n");
        return responseWithToolCall("append_to_current_file", {
          text: directCandidate,
        });
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onRunComplete: (event) => completions.push(event),
      onTrace: (event) => {
        if (event.kind === "tool_rejected" || event.kind === "verification") {
          traceSummary.push({
            id: event.id,
            message: event.message ?? "",
            errorCode: event.error?.code,
          });
        }
      },
    },
  });

  assert.equal(
    executedCalls.filter((call) => call.name === "append_to_current_file").length,
    1,
    JSON.stringify({ executedCalls, receipts, completions, traceSummary }),
  );
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0]?.readback);
  assert.equal(
    vault.operations.filter((item) => item === "modify:Current.md").length,
    1,
  );
  assert.match(vault.content.get("Current.md") ?? "", new RegExp(marker));
  assert.equal(
    completions.at(-1)?.stopReason,
    "write_completed",
    JSON.stringify({ executedCalls, receipts, completions, traceSummary }),
  );
  const persistedLedger = [...vault.content.entries()].find(
    ([path, content]) =>
      /^Agent Runs\/.+\.md$/u.test(path) && content.includes("## Mission Ledger"),
  )?.[1];
  assert.ok(persistedLedger, "expected the completed mission ledger to remain readable");
  assert.match(persistedLedger, /"status"\s*:\s*"acknowledged_limitation"/u);
});

test("closed fetched-source writeback repairs URL-only candidates before commit", async () => {
  const marker = "E2E_MARKER_PASSAGE_SCOPE_REPAIR_01";
  const prompt =
    `Read the current note as vault context. Search the web for owned alpha and beta evidence, fetch both sources, compare their conflicting conclusions about controlled onboarding validation, then append exactly two cited finding sentences and a Limitations section. End each finding sentence with the exact source:<id>:passage:<start>-<end> identifier returned by the fetch result that supports it. Include ${marker}.`;
  const originalNote = "Original note remains unchanged until citation proof passes.";
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const statuses: string[] = [];
  const correctionPrompts: string[] = [];
  const vault = createRunnerVaultContext({ prompt, content: originalNote });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "Owned alpha evidence",
              url: "https://primary.owned.example/evidence/passages",
              snippet:
                "Controlled onboarding validation improved retention and reduced errors.",
            },
            {
              title: "Owned beta evidence",
              url: "https://secondary.owned.example/evidence/passages",
              snippet:
                "Controlled onboarding validation showed no reliable benefit.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      const url = JSON.parse(
        typeof request.body === "string" ? request.body : "{}",
      )?.url;
      return {
        status: 200,
        headers: {},
        json:
          url === "https://secondary.owned.example/evidence/passages"
            ? {
                title: "Owned beta evidence",
                url,
                content:
                  "Controlled onboarding validation showed no reliable benefit for retention and no reduction in errors.",
                links: [],
              }
            : {
                title: "Owned alpha evidence",
                url: "https://primary.owned.example/evidence/passages",
                content:
                  "Controlled onboarding validation improved retention and reduced errors in the primary evidence.",
                links: [],
              },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithToolCall("read_current_file", {}),
      () => responseWithToolCall("web_search", { query: "owned onboarding evidence" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://primary.owned.example/evidence/passages",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://secondary.owned.example/evidence/passages",
        }),
      () =>
        responseWithContent([
          marker,
          "",
          "## Findings",
          "",
          "Controlled onboarding validation improved retention and reduced errors according to the primary owned source.",
          "Controlled onboarding validation showed no reliable benefit according to the secondary owned source.",
          "",
          "## Limitations",
          "",
          "The two sources conflict about whether controlled onboarding validation helped.",
          "",
          "## Confidence",
          "",
          "Medium, because the fetched owned sources disagree.",
          "",
          "Sources: https://primary.owned.example/evidence/passages and https://secondary.owned.example/evidence/passages",
        ].join("\n")),
      (request) => {
        const correction = [...request.messages].reverse().find(
          (message) =>
            message.role === "system" &&
            message.content.includes("passage_citation_coverage:"),
        );
        assert.ok(correction, "expected missing passage coverage correction prompt");
        correctionPrompts.push(correction.content);
        const passageIds = [
          ...new Set(
            correction.content.match(/source:[a-z0-9-]+:passage:\d+-\d+/giu) ?? [],
          ),
        ];
        assert.equal(passageIds.length, 2, JSON.stringify(passageIds));
        return responseWithContent([
          marker,
          "",
          "## Findings",
          "",
          `Controlled onboarding validation improved retention and reduced errors according to the primary owned source [${passageIds[0]}].`,
          `Controlled onboarding validation showed no reliable benefit according to the secondary owned source [${passageIds[1]}].`,
          "",
          "## Limitations",
          "",
          "The two sources conflict about whether controlled onboarding validation helped.",
          "",
          "## Confidence",
          "",
          "Medium, because the fetched owned sources disagree.",
        ].join("\n"));
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: (message) => statuses.push(message),
    },
  });

  const written = vault.content.get("Current.md") ?? "";
  const writtenPassageIds = [
    ...new Set(written.match(/source:[a-z0-9-]+:passage:\d+-\d+/giu) ?? []),
  ];
  assert.equal(
    receipts.filter((receipt) => receipt.operation === "append").length,
    1,
    JSON.stringify({
      statuses,
      executed: executedCalls.map((call) => call.name),
      written,
      correctionPrompts,
    }),
  );
  assert.equal(
    vault.operations.filter((item) => item === "modify:Current.md").length,
    1,
    JSON.stringify({
      statuses,
      executed: executedCalls.map((call) => call.name),
      written,
      correctionPrompts,
    }),
  );
  assert.equal(writtenPassageIds.length, 2, JSON.stringify({ written, statuses }));
  assert.ok(correctionPrompts.length >= 1);
  assert.ok(
    statuses.some((message) =>
      /Verified append candidate held for correction|Writeback draft held for verification/iu.test(
        message,
      ),
    ),
    JSON.stringify(statuses),
  );
});

test("generic commit marker cannot add prepared background Code authority to a research graph", async () => {
  const prompt =
    "E2E_PROOF_GATED_COMMIT_MARKER: Research MCP servers on the web and append a cited summary to this note.";
  const vault = createRunnerVaultContext({ prompt, content: "Original research note." });
  vault.context.settings.researchMemoryEnabled = false;
  const baseRegistry = createDefaultToolRegistry();
  const descriptor = backgroundCodeValidationDescriptor();
  let preparedCodeExecutions = 0;
  const basePrepare = baseRegistry.prepare?.bind(baseRegistry);
  const baseExecutePrepared = baseRegistry.executePrepared?.bind(baseRegistry);
  const registry: ToolRegistry = {
    getDefinitions: () => [
      ...baseRegistry.getDefinitions(),
      {
        type: "function" as const,
        function: {
          name: descriptor.name,
          description: "Execute one exact prepared background Code validation commit.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
    ],
    getDescriptor: (name) =>
      name === descriptor.name
        ? descriptor
        : (baseRegistry.getDescriptor?.(name) ?? null),
    prepare: basePrepare
      ? (call, context) => basePrepare(call, context)
      : undefined,
    executePrepared: baseExecutePrepared
      ? (action, context, authorization) =>
          baseExecutePrepared(action, context, authorization)
      : undefined,
    execute: async (call, context) => {
      if (call.name === descriptor.name) {
        preparedCodeExecutions += 1;
        return {
          ok: false,
          toolName: descriptor.name,
          error: { code: "unexpected_execution", message: "Unexpected execution." },
        };
      }
      return baseRegistry.execute(call, context);
    },
  };
  const configs: AgentRunConfigEvent[] = [];
  const graphs: Array<{ nodes: Record<string, { allowedTools: string[] }> }> = [];

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests: [],
      chatResponders: [() => responseWithContent("Research still requires its web evidence.")],
    }),
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 1,
    events: {
      onRunConfig: (event) => configs.push(event),
      onMissionGraphUpdate: (graph) => graphs.push(graph),
    },
  });

  assert.equal(
    configs[0]?.allowedToolNames.includes("code_validate_commit_prepared"),
    false,
  );
  assert.ok(graphs.length > 0);
  assert.equal(
    Object.values(graphs.at(-1)?.nodes ?? {}).some((node) =>
      node.allowedTools.includes("code_validate_commit_prepared"),
    ),
    false,
  );
  assert.equal(preparedCodeExecutions, 0);
});

test("proof-sensitive direct write tools are staged before the single verified mutation", async () => {
  const prompt =
    "Research MCP servers on the web and append a concise summary with passage citations to this note.";
  const originalNote = "Original note must not receive an unverified direct tool payload.";
  const directDraft = "DIRECT UNVERIFIED WRITE TOOL PAYLOAD";
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const rejectionCodes: string[] = [];
  const vault = createRunnerVaultContext({ prompt, content: originalNote });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "MCP overview",
              snippet: "MCP servers expose tools and resources.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "MCP overview",
          url: "https://example.com/mcp",
          content:
            "MCP servers expose tools and resources through a standard protocol.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  let correctedDraft = "";
  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/mcp",
        }),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: directDraft,
        }),
      (request) => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        const passageId = getPassageCitationIds(request)[0];
        assert.ok(passageId);
        correctedDraft =
          `MCP servers expose tools and resources through a standard protocol. Source: https://example.com/mcp [${passageId}]`;
        return responseWithContent(correctedDraft);
      },
    ],
    streamResponders: [
      (request) => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        const passageId = getPassageCitationIds(request)[0];
        assert.ok(passageId);
        correctedDraft =
          `MCP servers expose tools and resources through a standard protocol. Source: https://example.com/mcp [${passageId}]`;
        return responseWithContentDeltas([correctedDraft]);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onTrace: (event) => {
        if (event.error?.code) {
          rejectionCodes.push(event.error.code);
        }
      },
    },
  });

  assert.deepEqual(executedCalls.map((call) => call.name), [
    "web_search",
    "web_fetch",
    "append_to_current_file",
  ]);
  assert.ok(rejectionCodes.includes("proof_gated_writeback_required"));
  assert.equal(receipts.length, 1);
  assert.equal(
    vault.operations.filter((item) => item === "modify:Current.md").length,
    1,
  );
  assert.equal(vault.content.get("Current.md"), `${originalNote}\n${correctedDraft}`);
  assert.doesNotMatch(vault.content.get("Current.md") ?? "", /DIRECT UNVERIFIED/);
});

test("repeated invalid proof-gated writeback leaves the note byte-identical", async () => {
  const prompt =
    "Research MCP servers on the web and append a concise summary with citations to this note.";
  const originalNote = "Original note bytes must survive rejected research drafts.\n";
  const currentNotePassageId = extractEvidencePassages(originalNote, {
    sourceLocator: "Current.md",
  }).passages[0]!.id;
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const assistantDeltas: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const verificationTraces: string[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: originalNote,
  });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          query: "MCP servers",
          results: [
            {
              title: "MCP overview",
              snippet: "MCP servers expose tools and resources.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "MCP overview",
          url: "https://example.com/mcp",
          content:
            "MCP servers expose tools and resources through a standard protocol.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const invalidDraft = `INVALID UNVERIFIED WRITEBACK: relevant research prose citing only note context [${currentNotePassageId}].`;
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/mcp",
        }),
      () => responseWithContent(invalidDraft),
      () =>
        responseWithContent(
          `${invalidDraft} The single correction is still uncited.`,
        ),
    ],
    streamResponders: [
      () => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        return responseWithContentDeltas([invalidDraft]);
      },
      () => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        return responseWithContentDeltas([
          `${invalidDraft} The single correction is still uncited.`,
        ]);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onRunComplete: (event) => completions.push(event),
      onTrace: (event) => {
        if (event.kind === "verification") {
          verificationTraces.push(event.message ?? "");
        }
      },
    },
  });

  assert.deepEqual(executedCalls.slice(0, 2).map((call) => call.name), [
    "web_search",
    "web_fetch",
  ]);
  assert.ok(
    executedCalls.slice(1).every((call) => call.name === "web_fetch"),
    JSON.stringify(executedCalls.map((call) => call.name)),
  );
  assert.ok(streamRequests.length >= 1 && streamRequests.length <= 2);
  assert.deepEqual(receipts, []);
  assert.equal(vault.content.get("Current.md"), originalNote);
  assert.equal(
    vault.operations.filter((item) => item === "modify:Current.md").length,
    0,
  );
  assert.doesNotMatch(assistantDeltas.join(""), /INVALID UNVERIFIED/);
  assert.ok(
    verificationTraces.some((message) =>
      /outside the accepted fetched-source set/iu.test(message),
    ),
    JSON.stringify(verificationTraces),
  );
  assert.ok(
    verificationTraces.some((message) => /verification: fail/iu.test(message)),
    JSON.stringify(verificationTraces),
  );
  assert.match(
    assistantDeltas.join(""),
    /Note writeback was not applied because proof verification is incomplete/i,
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stopReason, "budget");
});

test("current market note writeback falls back to web tools before writing", async () => {
  const prompt = [
    "I want you to write on this note.",
    "",
    "Start by titling it Software project.",
    "",
    "I want you to find and organize information about the current online dating market and also the social media market.",
    "",
    "Write in a business type, market research format.",
  ].join("\n");
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const assistantDeltas: string[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const marketSources = [
    {
      title: "Dating market source",
      url: "https://example.com/dating-market",
      snippet: "Current online dating market data.",
    },
    {
      title: "Social media market source",
      url: "https://example.org/social-media-market",
      snippet: "Current social media market data.",
    },
    {
      title: "Consumer platform source",
      url: "https://example.net/platform-market",
      snippet: "Current consumer platform market data.",
    },
  ];
  let marketFetchIndex = 0;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: marketSources,
        },
      };
    }

    if (request.url.endsWith("/web_fetch")) {
      const source = marketSources[
        Math.min(marketFetchIndex, marketSources.length - 1)
      ];
      marketFetchIndex += 1;
      return {
        status: 200,
        headers: {},
        json: {
          title: source.title,
          url: source.url,
          content: `${source.snippet} Fetched current market source content with market sizing, retention, and monetization evidence.`,
          links: [],
        },
      };
    }

    throw new Error(`Unexpected request: ${request.url}`);
  };
  const buildVerifiedMarketDraft = (request: ModelChatRequest): string => {
    const passageIds = getPassageCitationIds(request).slice(0, 3);
    const cite = (index: number) =>
      passageIds[index] ? ` [${passageIds[index]}]` : "";
    return [
      "# Software project",
      "",
      "## Online Dating Market",
      `Current online dating market evidence shows retention and monetization pressure.${cite(0)} Source: ${marketSources[0].url}`,
      "",
      "## Social Media Market",
      `Current social media market evidence shows comparable consumer-platform retention pressure.${cite(1)} Source: ${marketSources[1].url}`,
      "",
      "## Consumer Platform Context",
      `The broader consumer platform evidence supports the cross-market comparison.${cite(2)} Source: ${marketSources[2].url}`,
      "",
      "## Limitations",
      "Evidence is limited to the three fetched market pages in this run.",
      "",
      "## Confidence",
      "Medium confidence based on three independently fetched sources.",
    ].join("\n");
  };
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithContent("I can draft this without tools."),
      () => responseWithContent("Still drafting without tools."),
      (request) => responseWithContent(buildVerifiedMarketDraft(request)),
    ],
    streamResponders: [
      (request) => responseWithContentDeltas([buildVerifiedMarketDraft(request)]),
      (request) => responseWithContentDeltas([buildVerifiedMarketDraft(request)]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
    },
  });

  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstStepToolNames.includes("web_search"));
  assert.ok(firstStepToolNames.includes("web_fetch"));
  assert.equal(executedCalls[0]?.name, "web_search");
  assert.ok(
    executedCalls.slice(1, -1).every((call) => call.name === "web_fetch"),
  );
  assert.ok(
    executedCalls.filter((call) => call.name === "web_fetch").length >= 1,
  );
  assert.equal(executedCalls.at(-1)?.name, "append_to_current_file");
  assert.equal(streamRequests.length, 0);
  assert.ok(
    statuses.some((message) =>
      /Model did not request required web tools; running read-only web fallback/.test(
        message,
      ),
    ),
  );
  assert.ok(
    !assistantDeltas.some((delta) =>
      /I could not get the model to request the required read tools/i.test(delta),
    ),
  );
  const note = vault.content.get("Current.md") ?? "";
  assert.doesNotMatch(note, /^# Software project/m);
  assert.match(note, /^# Untitled$/m);
  assert.match(note, /^## Online Dating Market/m);
  assert.match(note, /current online dating market/i);
  assert.match(note, /social media market/i);
});

test("model can return multiple tool calls in one step for compound create mission", async () => {
  const prompt =
    "Create folder Projects/New and create note Projects/New/Brief.md.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const vault = createRunnerVaultContext({ prompt });
  // This case isolates multi-call host execution. Structured routing and graph
  // planning have dedicated tests and would otherwise consume this fixture's
  // single agent-step response before the behavior under test.
  vault.context.settings.modelRouterMode = "off";
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCalls([
          { name: "create_folder", arguments: { path: "Projects/New" } },
          {
            name: "create_file",
            arguments: {
              path: "Projects/New/Brief.md",
              content: "# Brief",
            },
          },
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: { onStatus: (message) => statuses.push(message) },
  });

  assert.deepEqual(executedCalls.map((call) => call.name), [
    "create_folder",
    "create_file",
  ], JSON.stringify({
    exposed: chatRequests.at(-1)?.tools?.map((tool) => tool.function.name),
    statuses,
  }));
});

test("parallel same-name reads finish distinct graph nodes before follow-ups", async () => {
  const prompt =
    "Fetch the three exact source URLs https://alpha.example/one, https://beta.example/two, and https://gamma.example/three and compare them.";
  const executedCalls: ModelToolCall[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const statuses: string[] = [];
  const traceErrors: string[] = [];
  const graphs: Array<{ nodes: Record<string, { status: string; allowedTools: string[] }> }> = [];
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.modelRouterMode = "off";
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: { results: [] },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: 200,
        headers: {},
        json: {
          title: "Owned parallel source",
          url: "https://owned.example/evidence",
          content: "Owned evidence for a bounded parallel-read graph regression.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };
  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () =>
        responseWithToolCalls([
          { name: "web_fetch", arguments: { url: "https://alpha.example/one" } },
          { name: "web_fetch", arguments: { url: "https://beta.example/two" } },
          { name: "web_fetch", arguments: { url: "https://gamma.example/three" } },
        ]),
      () => responseWithContent("The three bounded source reads completed."),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 2,
    events: {
      onStatus: (message) => statuses.push(message),
      onTrace: (event) => {
        if (event.error?.message) traceErrors.push(event.error.message);
      },
      onRunComplete: (event) => completions.push(event),
      onMissionGraphUpdate: (graph) => graphs.push(graph),
    },
  });

  assert.equal(
    executedCalls.filter((call) => call.name === "web_fetch").length,
    3,
  );
  assert.notEqual(
    completions.at(-1)?.stopReason,
    "error",
    JSON.stringify({ completion: completions.at(-1), statuses, traceErrors }),
  );
  assert.doesNotMatch(
    completions.at(-1)?.stopDetail ?? "",
    /expected running before result/u,
  );
  const completedFetchNodes = Object.values(graphs.at(-1)?.nodes ?? {}).filter(
    (node) =>
      node.status === "complete" && node.allowedTools.includes("web_fetch"),
  );
  assert.equal(completedFetchNodes.length, 3);
});

test("multi-step CRUD mission continues after the first mutation", async () => {
  const prompt =
    "Create Projects/Temp.md, append to Projects/Temp.md, then delete Projects/Temp.md.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("create_file", {
          path: "Projects/Temp.md",
          content: "# Temp",
          createFolders: true,
        }),
      () =>
        responseWithToolCall("append_file", {
          path: "Projects/Temp.md",
          text: "\nMore",
        }),
      () =>
        responseWithToolCall("delete_path", {
          path: "Projects/Temp.md",
        }),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["create_file", "append_file", "delete_path"],
  );
});

test("delete then write replaces current note instead of trashing it", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const broker = new ApprovalBroker();
  const vault = createRunnerVaultContext({
    prompt:
      "Delete the current note. Ensure the space is empty. I want you to write now, a 1000 word essay on Grapes of Wrath.",
    content: "Old essay",
  });
  const essayDraft = [
    "New Grapes of Wrath essay.",
    ...Array.from({ length: 960 }, (_, index) => `migration${index}`),
  ].join(" ");

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to replace the note.")],
    streamResponders: [
      () => responseWithContentDeltas([essayDraft]),
    ],
  });

  await runAgentMission({
    prompt:
      "Delete the current note. Ensure the space is empty. I want you to write now, a 1000 word essay on Grapes of Wrath.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        assert.equal(vault.content.get("Current.md"), "Old essay");
        broker.resolve(request.id, "approved");
      },
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "replace_current_file"],
  );
  assert.equal(vault.content.get("Current.md"), essayDraft);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "replace");
  assert.ok(receipts[0].backupPath?.startsWith(".agent-backups/"));
  assert.equal(vault.content.has("Current.md"), true);
});

test("non-streaming delete-current-note then write accepts replace receipt as the content write", async () => {
  const prompt =
    "Delete the current note. Ensure that the space is empty. I want you to write now, a 300 word essay on Grapes of Wrath. Include E2E_DELETE_CURRENT_WRITE_UNIT.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Old E2E Page\n\nE2E_DELETE_CURRENT_OLD_UNIT\n",
  });
  const broker = new ApprovalBroker();
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("replace_current_file", {
          text: "# Grapes of Wrath\n\nE2E_DELETE_CURRENT_WRITE_UNIT\n",
        }),
      () =>
        responseWithContent(
          "Done. Replaced the current note with the requested Grapes of Wrath essay.",
        ),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    approvalBroker: broker,
    events: {
      onStatus: (message) => statuses.push(message),
      onRunComplete: (event) => completions.push(event),
      onApprovalRequest: (request) => {
        broker.resolve(request.id, "approved");
      },
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "replace_current_file"],
  );
  assert.equal(
    completions.at(-1)?.stopReason,
    "write_completed",
    statuses.join("\n"),
  );
  assert.ok(!statuses.includes("Stopped at safety limit. Review partial results."));
  assert.ok(!statuses.some((message) => /tool:append_to_current_file/.test(message)));
});

test("web append payload stays compact with capped note and source context", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const compactStatuses: string[] = [];
  const baseRegistry = createDefaultToolRegistry();
  const vault = createRunnerVaultContext({
    prompt: "Research MCP servers and append a concise cited summary to this note.",
    content: "n".repeat(12000),
  });
  const fetchedSourceContent =
    "MCP servers research cited summary explains MCP servers and source context. " +
    "f".repeat(6000);
  const compactPassageId = extractEvidencePassages(fetchedSourceContent, {
    sourceLocator: "https://example.com/1",
  }).passages[0]?.id;

  const registry: ToolRegistry = {
    getDefinitions: () => baseRegistry.getDefinitions(),
    execute: async (call): Promise<ToolExecutionResult> => {
      executedCalls.push(call);

      if (call.name === "read_current_file") {
        const maxChars =
          typeof call.arguments.maxChars === "number"
            ? call.arguments.maxChars
            : 12000;
        return {
          ok: true,
          toolName: call.name,
          output: {
            path: "Current.md",
            content: "n".repeat(maxChars),
          },
        };
      }

      if (call.name === "web_search") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            results: Array.from({ length: 3 }, (_, index) => ({
              title: `Result ${index + 1}`,
              url: `https://example.com/${index + 1}`,
              snippet: "s".repeat(800),
            })),
          },
        };
      }

      if (call.name === "web_fetch") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            title: "Fetched source",
            url: call.arguments.url,
            content: fetchedSourceContent,
            links: [],
          },
        };
      }

      if (call.name === "append_to_current_file") {
        const text = String(call.arguments.text ?? "");
        const previous = vault.content.get("Current.md") ?? "";
        vault.content.set("Current.md", `${previous}\n${text}`);
        vault.operations.push("modify:Current.md");
        return {
          ok: true,
          toolName: call.name,
          output: {
            path: "Current.md",
            operation: "append",
            bytesWritten: Buffer.byteLength(text, "utf8"),
          },
        };
      }

      return {
        ok: true,
        toolName: call.name,
        output: { path: "Current.md", bytesWritten: 20 },
      };
    },
  };

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/1" }),
      () => responseWithContent("MCP servers research cited summary."),
      (request) => {
        const evidence =
          getPassageCitationIds(request).join(" ") || compactPassageId || "";
        return responseWithContent(
          `MCP servers research cited summary. This concise summary covers MCP servers. Source: https://example.com/1 ${evidence}`.trim(),
        );
      },
    ],
    streamResponders: [
      () => responseWithContentDeltas(["MCP servers research cited summary."]),
      (request) => {
        const evidence = getPassageCitationIds(request).join(" ") || compactPassageId || "";
        return responseWithContentDeltas([
          `MCP servers research cited summary. This concise summary covers MCP servers. Source: https://example.com/1 ${evidence}`.trim(),
        ]);
      },
    ],
  });

  await runAgentMission({
    prompt: "Research MCP servers and append a concise cited summary to this note.",
    modelClient: client,
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => compactStatuses.push(message),
    },
  });

  assert.equal(executedCalls[0]?.name, "web_search");
  assert.ok(
    executedCalls.slice(1, -1).every((call) => call.name === "web_fetch"),
  );
  assert.ok(
    executedCalls.filter((call) => call.name === "web_fetch").length >= 1,
  );
  assert.equal(executedCalls.at(-1)?.name, "append_to_current_file");
  assert.equal(streamRequests.length, 0);
  const writtenNote = vault.content.get("Current.md") ?? "";
  assert.ok(writtenNote.startsWith("n".repeat(12000)));
  assert.match(
    writtenNote,
    /MCP servers research cited summary/,
    JSON.stringify(compactStatuses),
  );
  assert.match(writtenNote, /https:\/\/example\.com\/1/);
  assert.match(writtenNote, /source:[a-z0-9]+:passage:\d+-\d+/i);
  const maxRequestChars = Math.max(
    ...[...chatRequests, ...streamRequests].map((request) =>
      JSON.stringify(request).length,
    ),
  );
  assert.ok(
    maxRequestChars < 30000,
    `request was ${maxRequestChars} chars; chat=${chatRequests.map((request) => JSON.stringify(request).length).join(",")}; stream=${streamRequests.map((request) => JSON.stringify(request).length).join(",")}`,
  );
});

test("simple date prompts avoid vault and web tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Today is Friday.")],
  });

  await runAgentMission({
    prompt: "What is today's date?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      now: () => new Date("2026-07-04T12:34:56"),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.deepEqual(executedCalls, []);
  assert.match(deltas.join(""), /Today is Saturday, July 4, 2026\./);
});

test("ambiguous date math is marked as a clarification stop", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const completions: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("What year should I use for February 9?"),
    ],
  });

  await runAgentMission({
    prompt: "What is the date 2902 days from February 9?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(chatRequests[0].tools, undefined);
  assert.deepEqual(completions, ["clarifying_question"]);
});

test("concise assistant questions are marked as clarification stops", async () => {
  const completions: string[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithContent("Which note should I use as the source?"),
    ],
  });

  await runAgentMission({
    prompt: "Help me with this.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.deepEqual(deltas, ["Which note should I use as the source?"]);
  assert.deepEqual(completions, ["clarifying_question"]);
});

test("unavailable write tool requests trigger one corrective replan", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("replace_current_file", { text: "# Replacement" }),
      () => responseWithToolCall("append_to_current_file", { text: "Summary" }),
    ],
  });

  await runAgentMission({
    prompt: "Summarize this note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "append_to_current_file"],
  );
  assert.ok(statuses.includes("Rejected unavailable tool: replace_current_file"));
  assert.ok(
    statuses.includes(
      "Off-frontier tool requested; asking model to choose an authoritative graph action...",
    ),
  );
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /not available at the current authoritative MissionGraph frontier/,
  );
});

test("auto thinking resolves known model families and omits unknown models", () => {
  assert.equal(
    resolveThinkingMode(createRunnerSettings({ model: "gpt-oss:120b" })),
    "medium",
  );
  assert.equal(
    resolveThinkingMode(createRunnerSettings({ model: "qwen3:32b" })),
    true,
  );
  assert.equal(
    resolveThinkingMode(createRunnerSettings({ model: "deepseek-r1:8b" })),
    true,
  );
  assert.equal(
    resolveThinkingMode(createRunnerSettings({ model: "deepseek-v3.1:671b" })),
    true,
  );
  assert.equal(
    resolveThinkingMode(
      createRunnerSettings({ model: "kimi-k2.7-code:cloud" }),
    ),
    true,
  );
  assert.equal(
    resolveThinkingMode(createRunnerSettings({ model: "llama3.1:8b" })),
    undefined,
  );
  assert.equal(
    resolveThinkingMode(
      createRunnerSettings({ model: "llama3.1:8b", thinkingMode: "high" }),
    ),
    "high",
  );
  assert.equal(
    resolveThinkingMode(
      createRunnerSettings({ model: "gpt-oss:120b", thinkingMode: "off" }),
    ),
    "low",
  );
});

test("unsupported thinking retries once without think and completes", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => {
        throw new ModelClientError("api", "thinking is unsupported by this model");
      },
      () => responseWithToolCall("web_search", { query: "MCP servers status" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () =>
        responseWithContent(
          "Fallback answer. Source: https://example.com/source",
        ),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({ model: "gpt-oss:120b" }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 4);
  assert.equal(chatRequests[0].think, "medium");
  assert.equal(chatRequests[1].think, undefined);
  assert.equal(chatRequests[2].think, undefined);
  assert.equal(chatRequests[3].think, undefined);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.ok(statuses.includes("Thinking unsupported; using standard loop."));
  assert.deepEqual(deltas, [
    "Fallback answer. Source: https://example.com/source",
  ]);
});

test("transient model API errors retry before blocking", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => {
        const error = new Error("Internal Server Error (ref: retry-once)") as Error & {
          category?: string;
          status?: number;
        };
        error.name = "ModelClientError";
        error.category = "api";
        error.status = 500;
        throw error;
      },
      () => responseWithContent("Recovered answer"),
    ],
  });

  await runAgentMission({
    prompt: "Give me a concise answer about planning.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {
      settings: createRunnerSettings({ model: "llama3.1:8b" }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.equal(chatRequests[0].think, undefined);
  assert.equal(chatRequests[1].think, undefined);
  assert.ok(
    statuses.includes("Transient model provider error; retrying model step..."),
  );
  assert.deepEqual(deltas, ["Recovered answer"]);
});

test("repeated transient model API errors retry without thinking mode", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const transientError = () => {
    throw new ModelClientError(
      "api",
      "Internal Server Error (ref: retry-without-thinking)",
      { status: 500 },
    );
  };
  const client = createClient({
    chatRequests,
    chatResponders: [
      // Think-mode agent steps use maxAttempts=3 before the no-think fallback.
      transientError,
      transientError,
      transientError,
      () => responseWithToolCall("web_search", { query: "MCP servers status" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () =>
        responseWithContent(
          "Recovered web answer. Source: https://example.com/source",
        ),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({ model: "gpt-oss:120b" }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 6);
  assert.equal(chatRequests[0].think, "medium");
  assert.equal(chatRequests[1].think, "medium");
  assert.equal(chatRequests[2].think, "medium");
  assert.equal(chatRequests[3].think, undefined);
  assert.equal(chatRequests[4].think, undefined);
  assert.equal(chatRequests[5].think, undefined);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.ok(
    statuses.includes("Transient model provider error; retrying model step..."),
  );
  assert.ok(
    statuses.includes(
      "Transient model provider error persisted; retrying without thinking mode...",
    ),
  );
  assert.ok(statuses.includes("Thinking unsupported; using standard loop."));
  assert.deepEqual(deltas, [
    "Recovered web answer. Source: https://example.com/source",
  ]);
});

test("english-only direct answers repair CJK before display", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const deltas: string[] = [];
  const statuses: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("Coral reefs 珊瑚 support biodiversity."),
      () => responseWithContent("Coral reefs support biodiversity."),
    ],
  });

  await runAgentMission({
    prompt: "What is one fact about coral reefs?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Rewrite the previous answer in English only/,
  );
  assert.deepEqual(deltas, ["Coral reefs support biodiversity."]);
  assert.ok(
    statuses.includes(
      "Model produced non-English output; requesting English-only repair...",
    ),
  );
});

test("unknown auto thinking model omits think in runner requests", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Direct answer")],
  });

  await runAgentMission({
    prompt: "Write a short static answer.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {
      settings: createRunnerSettings({ model: "llama3.1:8b" }),
    } as ToolExecutionContext,
    enableStreaming: false,
  });

  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].think, undefined);
});

test("append writeback streams final markdown into the current note only", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const thinkingDeltas: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const metrics: AgentRunMetricEvent[] = [];
  const executedCalls: ModelToolCall[] = [];
  const prompt = "Append 2 action items to this note.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithContent("Ready to append.", "private planning"),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas(
          ["- First action\n", "- Second action\n"],
          "- First action\n- Second action\n",
          ["private thinking should stay out"],
        ),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt.output as Record<string, unknown>),
      onMetric: (event) => metrics.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].think, false);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [],
  );
  assert.equal(
    vault.content.get("Current.md"),
    "Initial note\n- First action\n- Second action\n",
  );
  assert.equal(finalDeltas.join(""), "- First action\n- Second action\n");
  assert.deepEqual(thinkingDeltas, ["private thinking should stay out"]);
  assert.ok(!vault.content.get("Current.md")?.includes("private thinking"));
  assert.equal(receipts[0].streamed, true);
  assert.equal(receipts[0].partial, false);
  assert.equal(receipts[0].operation, "append");
  assert.ok(
    metrics.some(
      (event) =>
        event.kind === "model_stream" &&
        event.name === "stream_writeback" &&
        (event.requestChars ?? 0) > 0,
    ),
  );
});

test("simple generated current-note writeback skips read and planner loops", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const statuses: string[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const executedCalls: ModelToolCall[] = [];
  const prompt = "In this note, can you write me a summary of the Vietnam war?";
  const vault = createRunnerVaultContext({
    prompt,
    content: "",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "The Vietnam War was a Cold War-era conflict involving Vietnam, the United States, and regional allies.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].writeAutonomy, true);
  assert.equal(configs[0].writebackMode, "streaming_current_note");
  assert.equal(configs[0].route, "direct_writeback");
  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [],
  );
  assert.ok(statuses.includes("Using direct note writeback; no tool loop needed..."));
  assert.ok(!statuses.includes("Reading current note..."));
  assert.ok(!statuses.includes("Planning..."));
  assert.ok(!statuses.some((message) => /Agent step/.test(message)));
  assert.equal(
    finalDeltas.join(""),
    "The Vietnam War was a Cold War-era conflict involving Vietnam, the United States, and regional allies.",
  );
  assert.equal(
    vault.content.get("Current.md"),
    "The Vietnam War was a Cold War-era conflict involving Vietnam, the United States, and regional allies.",
  );
});

test("current-note writeback prefers live editor updates when available", async () => {
  const prompt = "In this note, write a short project update.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
    liveEditorWrite: true,
  });
  const client = createClient({
    chatRequests: [],
    streamResponders: [
      () => responseWithContentDeltas(["Live editor chunk.\n"]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
  });

  assert.equal(vault.content.get("Current.md"), "Initial note\nLive editor chunk.\n");
  assert.ok(vault.operations.includes("setEditor:Current.md"));
  assert.ok(vault.operations.includes("modify:Current.md"));
  assert.ok(
    vault.operations.indexOf("setEditor:Current.md") <
      vault.operations.indexOf("modify:Current.md"),
  );
});

test("current-note writeback streams chunks live to chat and note", async () => {
  const finalDeltas: string[] = [];
  const prompt = "In this note, write a short project update.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const firstChunk = `${"A".repeat(801)}\n`;
  const secondChunk = "Second live chunk.\n";
  const client: ModelClient = {
    chat: async () => {
      throw new Error("chat should not be called for direct writeback");
    },
    streamChat: async (_request, events = {}) => {
      events.onContentDelta?.(firstChunk);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(finalDeltas.join(""), firstChunk);
      assert.equal(vault.content.get("Current.md"), `Initial note\n${firstChunk}`);

      events.onContentDelta?.(secondChunk);
      return responseWithContent(firstChunk + secondChunk);
    },
  };

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
    },
  });

  assert.equal(finalDeltas.join(""), firstChunk + secondChunk);
  assert.equal(
    vault.content.get("Current.md"),
    `Initial note\n${firstChunk}${secondChunk}`,
  );
});

test("streamed note writeback stops Chinese off-topic output before note mutation", async () => {
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const statuses: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "In this note, can you write me a summary of the Vietnam war?";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests: [],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# 1. 前言\n\n",
          "在上一篇文章中，我们分析了`axios`的请求配置，知道了在`axios`中，默认配置和用户配置可以合并，并且用户配置会优先于默认配置。",
          "接下来，我们就合并后的配置看看`axios`是如何来发请求的。\n\n",
          "在`/lib/core/Axios.js`文件中，我们可以看到，在`Axios`的原型上存在一个`request`方法。",
        ]),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onFinalDelta: (delta) => finalDeltas.push(delta),
          onAssistantDelta: (delta) => assistantDeltas.push(delta),
          onStatus: (message) => statuses.push(message),
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /drifted off topic/,
  );

  assert.deepEqual(finalDeltas, []);
  assert.deepEqual(assistantDeltas, []);
  assert.deepEqual(receipts, []);
  assert.equal(vault.content.get("Current.md"), "Initial note");
  assert.ok(
    statuses.includes(
      "Stopped model output because it drifted off topic from the current mission.",
    ),
  );
});

test("streamed note writeback retries CJK output before note mutation", async () => {
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const lifecycleMessages: string[] = [];
  const statuses: string[] = [];
  const prompt = "In this note, can you write me a summary of the Vietnam war?";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests: [],
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["Vietnam 战争 summary.\n"]),
      () => responseWithContentDeltas(["The Vietnam War summary.\n"]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
      onStreamLifecycle: (event) => lifecycleMessages.push(event.message),
    },
  });

  assert.equal(streamRequests.length, 2);
  assert.deepEqual(finalDeltas, ["The Vietnam War summary.\n"]);
  assert.equal(vault.content.get("Current.md"), "Initial note\nThe Vietnam War summary.\n");
  assert.ok(!vault.content.get("Current.md")?.includes("战争"));
  assert.ok(
    lifecycleMessages.includes("Language gate retrying English-only output..."),
  );
  assert.ok(
    statuses.includes(
      "Model produced non-English output; retrying English-only writeback...",
    ),
  );
});

test("thinking-only writeback retries once and fails without a receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const completions: AgentRunCompleteEvent[] = [];
  const prompt = "Append 2 action items to this note.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to append.")],
    streamResponders: [
      () => responseWithContentDeltas([], "", ["thinking only"]),
      () => responseWithContentDeltas([], "", ["still thinking only"]),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onStatus: (message) => statuses.push(message),
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
          onRunComplete: (event) => completions.push(event),
        },
      }),
    /The model returned no writable content\. Nothing was written\./,
  );

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 2);
  assert.equal(streamRequests[0].think, false);
  assert.equal(streamRequests[1].think, false);
  assert.equal(vault.content.get("Current.md"), "Initial note");
  assert.deepEqual(receipts, []);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stopReason, "error");
  const runMarkdown = [...vault.content.entries()].find(
    ([path]) => /^Agent Runs\/run-[^/]+\.md$/u.test(path),
  )?.[1];
  assert.ok(runMarkdown);
  assert.equal(parseMissionLedgerFromMarkdown(runMarkdown)?.status, "blocked");
  assert.equal(
    parseMissionRuntimeSnapshotFromMarkdown(runMarkdown)?.status,
    "blocked",
  );
  assert.ok(
    statuses.includes(
      "No writable content received; retrying content-only writeback...",
    ),
  );
  assert.ok(
    statuses.includes(
      "The model returned no writable content. Nothing was written.",
    ),
  );
});

test("streamed writeback suppresses requested tool markup and retries without writing it", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const statuses: string[] = [];
  const prompt = "Append 2 action items to this note.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to append.")],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "<requested_tool_call>",
          "<name>read_current_file</name>",
          "</requested_tool_call>",
        ]),
      () => responseWithContentDeltas(["- Real action\n"]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(streamRequests.length, 2);
  assert.deepEqual(finalDeltas, ["- Real action\n"]);
  assert.equal(vault.content.get("Current.md"), "Initial note\n- Real action\n");
  assert.ok(!vault.content.get("Current.md")?.includes("requested_tool_call"));
  assert.ok(
    statuses.includes(
      "Model requested a tool during writeback; retrying content-only output...",
    ),
  );
});

test("streamed writeback writes post-release python fence chunks", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const prompt = "Can you write the solution to two sum leetcode problem on the current page?";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "```",
          "python\n",
          "def two_sum(nums, target):\n",
          "    seen = {}\n",
          "    for index, num in enumerate(nums):\n",
          "        need = target - num\n",
          "        if need in seen:\n",
          "            return [seen[need], index]\n",
          "        seen[num] = index\n",
          "    return []\n",
          "```\n",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.match(finalDeltas.join(""), /def two_sum/);
  assert.match(vault.content.get("Current.md") ?? "", /return \[seen\[need\], index\]/);
  assert.match(vault.content.get("Current.md") ?? "", /```\n$/);
});

test("repeated streamed tool markup fails cleanly without note mutation", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Append 2 action items to this note.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const toolMarkup = [
    "<requested_tool_call>",
    "<name>read_current_file</name>",
    "</requested_tool_call>",
  ];
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to append.")],
    streamResponders: [
      () => responseWithContentDeltas(toolMarkup),
      () => responseWithContentDeltas(toolMarkup),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /requested a tool during streamed writeback/,
  );

  assert.equal(streamRequests.length, 2);
  assert.equal(vault.content.get("Current.md"), "Initial note");
  assert.deepEqual(receipts, []);
});

test("writeback retry writes content from the second stream", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const statuses: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Append 2 action items to this note.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to append.")],
    streamResponders: [
      () => responseWithContentDeltas([], "", ["thinking only"]),
      () => responseWithContentDeltas(["- First\n", "- Second\n"]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
      onReceipt: (receipt) =>
        receipts.push(receipt.output as Record<string, unknown>),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 2);
  assert.equal(streamRequests[0].think, false);
  assert.equal(streamRequests[1].think, false);
  assert.deepEqual(finalDeltas, ["- First\n", "- Second\n"]);
  assert.equal(vault.content.get("Current.md"), "Initial note\n- First\n- Second\n");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].bytesWritten, 17);
  assert.ok(
    statuses.includes(
      "No writable content received; retrying content-only writeback...",
    ),
  );
  assert.ok(statuses.includes("Streaming writeback complete."));
});

test("empty replace writeback does not erase the current note", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Replace this note with a clean project brief.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Original note",
    now: new Date(654),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to replace.")],
    streamResponders: [
      () => responseWithContentDeltas([], "", ["thinking only"]),
      () => responseWithContentDeltas([], ""),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /The model returned no writable content\. Nothing was written\./,
  );

  assert.equal(streamRequests.length, 1);
  assert.equal(vault.content.get("Current.md"), "Original note");
  assert.equal(vault.content.has(".agent-backups/654-Current.md"), false);
  assert.equal(vault.operations.includes("modify:Current.md"), false);
  assert.deepEqual(receipts, []);
});

test("replace writeback creates a backup before streaming replacement content", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const approvals: ApprovalRequest[] = [];
  const broker = new ApprovalBroker();
  const prompt = "Replace this note with a clean project brief.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Old note",
    now: new Date(456),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to replace.")],
    streamResponders: [
      () => responseWithContentDeltas(["# Brief\n", "\nReplacement body."]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        approvals.push(request);
        assert.equal(vault.content.get("Current.md"), "Old note");
        assert.equal(vault.content.has(".agent-backups/456-Current.md"), false);
        broker.resolve(request.id, "approved");
      },
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.equal(streamRequests.length, 1);
  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstStepToolNames.includes("read_current_file"));
  assert.ok(firstStepToolNames.includes("replace_current_file"));
  assert.equal(vault.content.get("Current.md"), "# Brief\n\nReplacement body.");
  assert.equal(vault.content.get(".agent-backups/456-Current.md"), "Old note");
  assert.ok(
    vault.operations.indexOf("create:.agent-backups/456-Current.md") <
      vault.operations.indexOf("modify:Current.md"),
  );
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, "replace_current_file");
  assert.equal(
    approvals[0].payloadFingerprint,
    approvals[0].preparedAction?.payloadFingerprint,
  );
  assert.equal(receipts[0].backupPath, ".agent-backups/456-Current.md");
  assert.equal(receipts[0].operation, "replace");
});

test("clarifying follow-up whole-note replace streams through mission graph", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const traces: string[] = [];
  const receipts: AgentRunReceipt[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const broker = new ApprovalBroker();
  const prompt =
    "I prefer that you replace the entire note with a revised version";
  const original =
    "# China: History and Government\n\n| Period | Events |\n|--------|--------|\n| Qing | Opium Wars |\n\nHistorical overview remains.\n";
  const vault = createRunnerVaultContext({
    prompt,
    content: original,
    now: new Date(789),
  });
  // Match Automatic profile: authority planning is what hung optional reads on
  // replace_current_file before the planner filter.
  vault.context.settings.modelRouterMode = "authority";
  vault.context.settings.workingMode = "automatic";
  let graphPlannerSawOptionalReads = false;
  let planningChats = 0;
  const client: ModelClient = {
    chat: async (request) => {
      chatRequests.push(cloneRequest(request));
      if (isMissionRouterFormat(request)) {
        return responseWithContent(
          JSON.stringify({
            mode: "vault_write",
            writeScope: "current_note_replace",
            needsWebEvidence: false,
            needsVaultContext: true,
            needsCodeExecution: false,
            wordTarget: null,
            confidence: 0.94,
            rationale: "User confirmed a whole-note replace after clarification.",
          }),
        );
      }
      if (isMissionGraphPlannerFormat(request)) {
        const catalog = parseMissionGraphHostCatalog(request);
        const optionalIds = catalog
          .filter((node) => !node.required && node.effect === "read")
          .map((node) => node.id);
        graphPlannerSawOptionalReads = optionalIds.length > 0;
        // Reproduce the pre-fix bug shape: optional reads as write deps.
        const nodes = catalog
          .filter((node) => node.required || optionalIds.includes(node.id))
          .filter((node) => node.id !== "final")
          .map((node) => ({
            id: node.id,
            objective: node.hostObjective,
            dependencyIds:
              node.required && node.effect !== "read"
                ? sortedUnique([...node.hostDependencyIds, ...optionalIds])
                : [...node.hostDependencyIds],
          }));
        return responseWithContent(
          JSON.stringify({ confidence: 0.93, nodes }),
        );
      }
      planningChats += 1;
      return responseWithContent("Ready to replace the note.");
    },
    streamChat: async (request, events = {}) => {
      // Stream+tools agent steps use streamChat while tools remain exposed.
      if (request.tools?.length) {
        chatRequests.push(cloneRequest(request));
        planningChats += 1;
        return responseWithContent("Ready to replace the note.");
      }
      streamRequests.push(cloneRequest(request));
      const response = responseWithContentDeltas([
        "# China: History and Government\n\n",
        "China’s trajectory over the past century has been shaped by imperial collapse and reform.\n",
      ]);
      for (const delta of response.contentDeltas ?? []) {
        events.onContentDelta?.(delta);
      }
      return response;
    },
  };

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    conversationHistory: [
      {
        role: "user",
        content: "Ok, remove the historical overview section then with the boxes",
      },
      {
        role: "assistant",
        content:
          "Do you want me to replace the entire note (removing the historical overview and tables) with a revised version, or would you prefer I add a new section summarizing the remaining content?",
      },
    ],
    approvalBroker: broker,
    events: {
      onStatus: (message) => statuses.push(message),
      onTrace: (event) => traces.push(event.message),
      onApprovalRequest: (request) => {
        broker.resolve(request.id, "approved");
      },
      onReceipt: (receipt) => receipts.push(receipt),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.ok(
    statuses.some((message) =>
      /Classifying mission with structured router/i.test(message),
    ),
    "authority mode should run the structured router before tool selection",
  );
  assert.ok(
    traces.some((message) =>
      /Structured MissionGraphV3 accepted as authoritative|Deterministic MissionGraphV3 is authoritative/i.test(
        message,
      ),
    ),
    traces.join(" | "),
  );
  assert.ok(
    !statuses.some((message) =>
      /replace_current_file is not ready in the authoritative mission graph/i.test(
        message,
      ),
    ),
    statuses.join(" | "),
  );
  assert.ok(
    !statuses.some((message) =>
      /Completion held for verification:.*mission_graph_incomplete/i.test(
        message,
      ),
    ),
    "successful replace must not downgrade to budget for unread optional sibling reads",
  );
  assert.ok(
    !statuses.some((message) =>
      /Wall-clock run budget expired|Repeated tool loop stopped before full safety limit/i.test(
        message,
      ),
    ),
    statuses.join(" | "),
  );
  assert.ok(
    planningChats >= 1,
    "authority replace should still reach a normal planning chat after graph selection",
  );
  assert.equal(streamRequests.length, 1);
  assert.match(
    vault.content.get("Current.md") ?? "",
    /imperial collapse and reform/i,
  );
  assert.ok(!(vault.content.get("Current.md") ?? "").includes("| Period |"));
  assert.equal(receipts[0]?.operation, "replace");
  assert.ok(receipts[0]?.backupPath);
  const recordedProviderCalls = Math.max(
    ...configs.map(
      (config) => config.missionLedger?.providerUsage.modelCallCount ?? 0,
    ),
  );
  assert.ok(recordedProviderCalls >= 2, "pre-ledger router/planner calls must be retained");
  assert.equal(recordedProviderCalls, chatRequests.length + streamRequests.length);
  if (graphPlannerSawOptionalReads) {
    assert.ok(
      traces.some((message) =>
        /Structured MissionGraphV3 accepted as authoritative/i.test(message),
      ),
      "optional catalog reads must not leave replace queued behind unread grounding",
    );
  }
});

test("correct entire page exposes replace and suppresses append", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const broker = new ApprovalBroker();
  const prompt =
    "This essay is a little over 1000 words. Please correct the entire page.";
  const original = "# Essay\n\nDraft with mistakes.\n";
  const vault = createRunnerVaultContext({
    prompt,
    content: original,
    now: new Date(4242),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to correct.")],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Essay\n",
          "\nCorrected page body with clearer prose.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        broker.resolve(request.id, "approved");
      },
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const firstStepToolNames =
    chatRequests[0]?.tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(
    firstStepToolNames.includes("replace_current_file") ||
      streamRequests.length === 1,
    "host-owned replace must be available via tool allowlist or streamed writeback",
  );
  assert.ok(!firstStepToolNames.includes("append_to_current_file"));
  assert.ok(!executedCalls.some((call) => call.name === "append_to_current_file"));
  assert.equal(receipts[0]?.operation, "replace");
  assert.equal(
    vault.content.get("Current.md"),
    "# Essay\n\nCorrected page body with clearer prose.",
  );
});

test("direct essay edit routes to whole-note replace instead of section edit", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const broker = new ApprovalBroker();
  const prompt = "Edit the essay and add more detail to the paragraphs.";
  const original = "# Essay\n\nThin original paragraph.\n";
  const vault = createRunnerVaultContext({
    prompt,
    content: original,
    now: new Date(321),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to revise.")],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Essay\n",
          "\nExpanded paragraph with additional textual detail.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        broker.resolve(request.id, "approved");
      },
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const firstStepToolNames =
    chatRequests[0]?.tools?.map((tool) => tool.function.name) ??
    executedCalls.map((call) => call.name);
  assert.ok(
    firstStepToolNames.includes("replace_current_file") ||
      streamRequests.length === 1,
    `expected replace tool or direct stream; tools=${firstStepToolNames.join(",")}; streams=${streamRequests.length}`,
  );
  assert.ok(!firstStepToolNames.includes("prepare_edit_current_section"));
  assert.ok(!firstStepToolNames.includes("edit_current_section"));
  assert.ok(
    executedCalls.some((call) => call.name === "replace_current_file") ||
      streamRequests.length === 1,
  );
  assert.equal(
    vault.content.get("Current.md"),
    "# Essay\n\nExpanded paragraph with additional textual detail.",
  );
  assert.equal(vault.content.get(".agent-backups/321-Current.md"), original);
  assert.equal(receipts[0].operation, "replace");
  assert.equal(receipts[0].backupPath, ".agent-backups/321-Current.md");
});

test("revision approval follow-up inherits prior assistant edit intent", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const approvals: ApprovalRequest[] = [];
  const broker = new ApprovalBroker();
  const prompt = "Go ahead and revise";
  const original = "# Essay\n\nThin original paragraph.\n";
  const vault = createRunnerVaultContext({
    prompt,
    content: original,
    now: new Date(322),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("replace_current_file", {
          text: "# Essay\n\nExpanded follow-up revision with additional detail.",
        }),
      () => responseWithContent("Ready to revise."),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Essay\n",
          "\nExpanded follow-up revision with additional detail.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    conversationHistory: [
      {
        role: "assistant",
        content:
          "I'll revise the essay to add more textual detail, historical context, and analytical depth. Let me update the current section with an expanded version.",
      },
    ],
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        approvals.push(request);
        assert.equal(vault.content.get("Current.md"), original);
        broker.resolve(request.id, "approved");
      },
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.ok(!executedCalls.some((call) => call.name === "edit_current_section"));
  assert.ok(!executedCalls.some((call) => call.name === "prepare_edit_current_section"));
  assert.ok(
    executedCalls.some((call) => call.name === "replace_current_file") ||
      streamRequests.length >= 1,
  );
  assert.ok(approvals.length >= 1);
  assert.match(
    approvals[0].toolName,
    /replace_current_file|streamed_replace|replace/i,
  );
  assert.equal(
    vault.content.get("Current.md"),
    "# Essay\n\nExpanded follow-up revision with additional detail.",
  );
  assert.equal(vault.content.get(".agent-backups/322-Current.md"), original);
  assert.equal(receipts[0].operation, "replace");
  assert.equal(receipts[0].backupPath, ".agent-backups/322-Current.md");
});

test("denied streamed replacement approval preserves exact note bytes and creates no backup", async () => {
  const prompt = "Replace this note with a clean project brief.";
  const original = "# Original\n\nDo not change before exact approval.\n";
  const executedCalls: ModelToolCall[] = [];
  const approvals: ApprovalRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const broker = new ApprovalBroker();
  const vault = createRunnerVaultContext({
    prompt,
    content: original,
    now: new Date(323),
  });
  const client = createClient({
    chatRequests: [],
    streamRequests: [],
    chatResponders: [() => responseWithContent("Ready to replace.")],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Clean Project Brief\n\nReplacement project brief body.\n",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        approvals.push(request);
        assert.equal(vault.content.get("Current.md"), original);
        assert.equal(vault.content.has(".agent-backups/323-Current.md"), false);
        broker.resolve(request.id, "denied");
      },
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, "replace_current_file");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.equal(vault.content.get("Current.md"), original);
  assert.equal(vault.content.has(".agent-backups/323-Current.md"), false);
  assert.equal(vault.operations.includes("modify:Current.md"), false);
  assert.deepEqual(receipts, []);
});

test("section edit writeback prepares heading and preserves surrounding content", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  const prompt = "Edit the Goals section in this note.";
  const original = [
    "# Project",
    "",
    "Intro.",
    "",
    "## Goals",
    "Old goals.",
    "",
    "## Scope",
    "Keep scope.",
  ].join("\n");
  const vault = createRunnerVaultContext({
    prompt,
    content: original,
    now: new Date(789),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("prepare_edit_current_section", {
          heading: "Goals",
          level: 2,
        }),
      () => responseWithContent("New goals.\n- Ship streaming edits"),
    ],
    streamResponders: [
      () => responseWithContentDeltas(["New goals.", "\n- Ship streaming edits"]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt.output as Record<string, unknown>),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.ok(chatRequests.length >= 2);
  assert.equal(streamRequests.length, 1);
  assert.ok(
    chatRequests[0].tools
      ?.map((tool) => tool.function.name)
      .includes("prepare_edit_current_section"),
  );
  assert.ok(
    !chatRequests[0].tools
      ?.map((tool) => tool.function.name)
      .includes("edit_current_section"),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "prepare_edit_current_section"],
  );
  assert.equal(
    vault.content.get("Current.md"),
    [
      "# Project",
      "",
      "Intro.",
      "",
      "## Goals",
      "New goals.",
      "- Ship streaming edits",
      "## Scope",
      "Keep scope.",
    ].join("\n"),
    JSON.stringify({
      statuses,
      chatRequests: chatRequests.map((request) => request.messages.at(-1)?.content),
      tools: executedCalls.map((call) => call.name),
      receipts,
    }),
  );
  assert.equal(vault.content.get(".agent-backups/789-Current.md"), original);
  assert.equal(receipts[0].streamed, true);
  assert.equal(receipts[0].operation, "edit");
  assert.equal(receipts[0].heading, "Goals");
});

test("interrupted replacement candidate stream preserves the current note before approval", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Replace this note with a clean project brief.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Original note",
    now: new Date(987),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready.")],
    streamResponders: [
      () =>
        responseWithContentDeltas(["# Partial brief"], "# Partial brief", [], {
          streamError: new Error("stream interrupted"),
        }),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /stream interrupted/,
  );

  assert.equal(streamRequests.length, 1);
  assert.equal(vault.content.has(".agent-backups/987-Current.md"), false);
  assert.equal(vault.content.get("Current.md"), "Original note");
  assert.equal(vault.operations.includes("modify:Current.md"), false);
  assert.deepEqual(receipts, []);
});

test("interrupted streamed replace before content preserves the current note", async () => {
  const streamRequests: ModelChatRequest[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Replace this note with a clean project brief.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Original note",
    now: new Date(988),
  });
  const client = createClient({
    chatRequests: [],
    streamRequests,
    chatResponders: [() => responseWithContent("Ready.")],
    streamResponders: [
      () =>
        responseWithContentDeltas([], "", [], {
          streamError: new Error("stream failed before content"),
        }),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /stream failed before content/,
  );

  assert.equal(streamRequests.length, 1);
  assert.equal(vault.content.has(".agent-backups/988-Current.md"), false);
  assert.equal(vault.content.get("Current.md"), "Original note");
  assert.equal(vault.operations.includes("modify:Current.md"), false);
  assert.deepEqual(receipts, []);
});

test("assistant sanitizer strips malformed special tokens", () => {
  assert.equal(
    sanitizeAssistantContent(
      "< | begin_of__sentence | >Final answer< | end_of_sentence | >",
    ),
    "Final answer",
  );
  assert.equal(
    sanitizeAssistantContent("<｜begin▁of▁sentence｜># 1. 两数之和"),
    "# 1. 两数之和",
  );
});

type TestModelChatResponse = ModelChatResponse & {
  contentDeltas?: string[];
  thinkingDeltas?: string[];
  streamError?: unknown;
};

type ChatResponder = (request: ModelChatRequest) => TestModelChatResponse;

function createClient({
  chatRequests,
  streamRequests = [],
  streamToolRequests = [],
  chatResponders = [],
  streamResponders,
}: {
  chatRequests: ModelChatRequest[];
  streamRequests?: ModelChatRequest[];
  /** Agent-step streamChat calls that still expose tools (stream+tools path). */
  streamToolRequests?: ModelChatRequest[];
  chatResponders?: ChatResponder[];
  streamResponders?: ChatResponder[];
}): ModelClient {
  return {
    chat: async (request) => {
      chatRequests.push(cloneRequest(request));
      const responder = chatResponders[chatRequests.length - 1];

      if (!responder) {
        throw new Error(`No chat responder for request ${chatRequests.length}`);
      }

      return responder(request);
    },
    streamChat: async (request, events: ModelChatStreamEvents = {}) => {
      const hasTools = Boolean(request.tools?.length);
      // Agent-step stream+tools share the chat responder queue so existing
      // enableStreaming+tools tests keep chatResponders for tool turns and
      // streamResponders / streamRequests for writeback-only (tool-less) streams.
      let response: TestModelChatResponse;
      if (hasTools) {
        const cloned = cloneRequest(request);
        chatRequests.push(cloned);
        streamToolRequests.push(cloned);
        const responder = chatResponders[chatRequests.length - 1];
        if (!responder) {
          throw new Error(
            `No chat responder for streamed tool request ${chatRequests.length}`,
          );
        }
        response = responder(request);
      } else {
        streamRequests.push(cloneRequest(request));
        const responders = streamResponders ?? chatResponders;
        const responder = responders[streamRequests.length - 1];
        if (!responder) {
          throw new Error(
            `No stream responder for request ${streamRequests.length}`,
          );
        }
        response = responder(request);
      }

      const thinkingDeltas =
        response.thinkingDeltas ??
        (response.message.thinking ? [response.message.thinking] : []);
      const contentDeltas =
        response.contentDeltas ??
        (response.message.content ? [response.message.content] : []);

      for (const delta of thinkingDeltas) {
        events.onThinkingDelta?.(delta);
      }

      for (const delta of contentDeltas) {
        events.onContentDelta?.(delta);
      }

      if (response.streamError) {
        throw response.streamError;
      }

      return response;
    },
  };
}

function getPassageCitationIds(request: ModelChatRequest): string[] {
  const matches = request.messages
    .flatMap((message) =>
      message.content.match(/source:[a-z0-9]+:passage:\d+-\d+/giu) ?? [],
    );
  return [...new Set(matches)];
}

function cloneRequest(request: ModelChatRequest): ModelChatRequest {
  return {
    ...request,
    messages: [...request.messages],
    tools: request.tools ? [...request.tools] : undefined,
  };
}

function isMissionRouterFormat(request: ModelChatRequest): boolean {
  const required = request.format?.required;
  return Array.isArray(required) && required.includes("writeScope");
}

function isMissionGraphPlannerFormat(request: ModelChatRequest): boolean {
  const required = request.format?.required;
  return (
    Array.isArray(required) &&
    required.includes("confidence") &&
    required.includes("nodes")
  );
}

type MissionGraphHostCatalogNode = {
  id: string;
  required: boolean;
  effect: string;
  allowedTools: string[];
  hostObjective: string;
  hostDependencyIds: string[];
};

function parseMissionGraphHostCatalog(
  request: ModelChatRequest,
): MissionGraphHostCatalogNode[] {
  const system = request.messages.find((message) => message.role === "system");
  const match = /Host node catalog:\s*(\[[\s\S]*\])\s*$/u.exec(
    system?.content ?? "",
  );
  if (!match) {
    return [];
  }
  const parsed = JSON.parse(match[1]) as MissionGraphHostCatalogNode[];
  return Array.isArray(parsed) ? parsed : [];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function createRunnerSettings(
  overrides: Partial<AgentSettings> = {},
): AgentSettings {
  return {
    settingsSchemaVersion: 2,
    autonomyProfile: "automatic",
    outputProfile: "active_or_new_note",
    modelProvider: "ollama",
    ollamaApiKey: "test-key",
    ollamaBaseUrl: "https://ollama.com/api",
    openAiCompatibleApiKey: "",
    openAiCompatibleBaseUrl: "https://api.openai.com/v1",
    model: "gpt-oss:120b",
    enableStreaming: true,
    thinkingMode: "auto",
    streamWritebackMode: "all_current_note_content_writes",
    autoTitleOnWrite: true,
    maxAgentSteps: MAX_AGENT_STEPS,
    companionBaseUrl: "http://127.0.0.1:8765",
    browserToolsEnabled: false,
    experienceMemoryEnabled: false,
    defaultBrowserMissionMode: "supervised",
    agenticReflexEnabled: false,
    agenticReflexDiagnosticsEnabled: true,
    templateFolder: "Templates",
    templateOutputFolder: "",
    researchMemoryEnabled: true,
    researchMemoryFolder: "Agent Research Memory",
    semanticSearchEnabled: true,
    semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
    semanticEmbeddingDim: 512,
    semanticChunkMinTokens: 300,
    semanticChunkTargetTokens: 500,
    semanticChunkMaxTokens: 700,
    semanticChunkOverlapTokens: 80,
    semanticPythonCommand: "",
    semanticModelCacheDir: "",
    semanticIndexEnabled: true,
    semanticIndexFolder: "Agent Memory",
    semanticIndexDebounceMs: 3000,
    semanticIndexMaxFiles: 1000,
    semanticIndexPersistVectors: true,
    requestTimeoutMs: 60000,
    temperature: null,
    topK: null,
    topP: null,
    numCtx: null,
    ...overrides,
  };
}

function createReflexSemanticEmbeddingProvider(): SemanticEmbeddingProvider {
  return {
    async embed(request) {
      const semanticVector = [1, 0];
      const otherVector = [0, 1];
      const classify = (text: string) =>
        /notes say|related ideas|conceptually|ritual kingship|archive entries/i.test(
          text,
        )
          ? semanticVector
          : otherVector;
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map(classify),
        queries: request.queries.map(classify),
      };
    },
  };
}

function githubRunnerFixtureTool(
  name: string,
  executedCalls: ModelToolCall[] = [],
): AgentTool {
  return {
    name,
    description: `Test-only bounded GitHub catalog fixture for ${name}.`,
    parameters: {
      type: "object",
      properties: {
        profileKey: { type: "string" },
        number: { type: "integer" },
        reference: { type: "string" },
      },
      required: ["profileKey"],
      additionalProperties: false,
    },
    descriptor: {
      version: 1,
      name,
      capability: { system: "github", resourceType: "fixture", action: "read" },
      effect: "read",
      risk: "low",
      approval: {
        allowPromptGrant: true,
        allowPersistentGrant: false,
        fallback: "none",
      },
      execution: { preparation: "none", cacheable: false, parallelSafe: false },
      durability: {
        journal: false,
        receipt: false,
        readback: "none",
        reconciliation: "none",
      },
      allowedPrincipals: ["single_agent"],
    },
    async execute(args) {
      executedCalls.push({ id: `${name}-fixture`, name, arguments: args });
      return { source: "github_provider_untrusted", authority: false, ok: true };
    },
  };
}

function createRunnerVaultContext(options: {
  prompt?: string;
  content?: string;
  path?: string;
  now?: Date;
  model?: string;
  thinkingMode?: ThinkingMode;
  streamWritebackMode?: StreamWritebackMode;
  liveEditorWrite?: boolean;
} = {}) {
  const notePath = options.path ?? "Current.md";
  const noteName = notePath.split("/").pop() ?? notePath;
  const noteBasename = noteName.replace(/\.[^.]+$/i, "");
  const content = new Map<string, string>([
    [notePath, options.content ?? "Initial note"],
  ]);
  const folders = new Set<string>();
  const operations: string[] = [];
  const activeFile = {
    path: notePath,
    name: noteName,
    basename: noteBasename,
    extension: "md",
  };

  const getFile = (path: string) => {
    if (!content.has(path)) {
      return null;
    }

    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.[^.]+$/i, ""),
      extension: name.includes(".")
        ? name.split(".").pop()?.toLowerCase() ?? ""
        : "",
    };
  };

  const getFolder = (path: string) => {
    if (!path || !folders.has(path)) {
      return null;
    }

    return {
      path,
      name: path.split("/").pop() ?? path,
    };
  };

  const app = {
    workspace: {
      getActiveFile: () => activeFile,
    },
    vault: {
      getFiles: () =>
        [...content.keys()]
          .map((path) => getFile(path))
          .filter((file): file is NonNullable<typeof file> => Boolean(file)),
      getAllLoadedFiles: () => [
        ...[...folders].map((path) => ({
          path,
          name: path.split("/").pop() ?? path,
        })),
        ...[...content.keys()]
          .map((path) => getFile(path))
          .filter((file): file is NonNullable<typeof file> => Boolean(file)),
      ],
      cachedRead: async (file: { path: string }) => content.get(file.path) ?? "",
      read: async (file: { path: string }) => content.get(file.path) ?? "",
      modify: async (file: { path: string }, data: string) => {
        operations.push(`modify:${file.path}`);
        content.set(file.path, data);
      },
      getFileByPath: getFile,
      getFolderByPath: getFolder,
      getAbstractFileByPath: (path: string) => getFile(path) ?? getFolder(path),
      createFolder: async (path: string) => {
        operations.push(`createFolder:${path}`);
        folders.add(path);
      },
      create: async (path: string, data: string) => {
        operations.push(`create:${path}`);
        content.set(path, data);
        return getFile(path);
      },
      rename: async (file: { path: string; name?: string; basename?: string }, newPath: string) => {
        operations.push(`rename:${file.path}:${newPath}`);
        const value = content.get(file.path) ?? "";
        content.delete(file.path);
        content.set(newPath, value);
        file.path = newPath;
        file.name = newPath.split("/").pop() ?? newPath;
        file.basename = file.name.replace(/\.[^.]+$/i, "");
      },
    },
  };

  const context: ToolExecutionContext = {
    app: app as never,
    settings: createRunnerSettings({
      model: options.model ?? "gpt-oss:120b",
      thinkingMode: options.thinkingMode ?? "auto",
      streamWritebackMode:
        options.streamWritebackMode ?? "all_current_note_content_writes",
    }),
    originalPrompt: options.prompt ?? "Append to this note.",
    httpTransport: async () => ({
      status: 500,
      headers: {},
      json: { error: "not mocked" },
    }),
    now: () => options.now ?? new Date(123),
    getCurrentMarkdownFile: () => activeFile as never,
    getCurrentMarkdownContent: (file) => content.get(file.path) ?? null,
    setCurrentMarkdownContent: options.liveEditorWrite
      ? (file, data) => {
          operations.push(`setEditor:${file.path}`);
          content.set(file.path, data);
          return true;
        }
      : undefined,
  };

  return { context, content, folders, operations };
}

function createCollectingRegistry(executedCalls: ModelToolCall[]): ToolRegistry {
  const baseRegistry = createDefaultToolRegistry();
  const prepare = baseRegistry.prepare?.bind(baseRegistry);
  const executePrepared = baseRegistry.executePrepared?.bind(baseRegistry);
  const getDescriptor = baseRegistry.getDescriptor?.bind(baseRegistry);
  return {
    getDefinitions: () => baseRegistry.getDefinitions(),
    getDescriptor: getDescriptor
      ? (toolName) => getDescriptor(toolName)
      : undefined,
    prepare: prepare
      ? (call, context) => prepare(call, context)
      : undefined,
    executePrepared: executePrepared
      ? async (action, context, authorization) => {
          executedCalls.push({
            name: action.toolName,
            arguments:
              action.normalizedArgs && typeof action.normalizedArgs === "object"
                ? (action.normalizedArgs as Record<string, unknown>)
                : {},
          });
          return executePrepared(action, context, authorization);
        }
      : undefined,
    execute: async (call, context) => {
      executedCalls.push(call);
      return baseRegistry.execute(call, context);
    },
  };
}

function createRegistry(
  executedCalls: ModelToolCall[],
  options: {
    readCurrentError?: string;
    inspectVaultError?: string;
  } = {},
): ToolRegistry {
  return {
    getDefinitions: () => [
      {
        type: "function",
        function: {
          name: "read_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "list_current_folder",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "list_markdown_files",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_markdown_files",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "inspect_semantic_index",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "semantic_search_notes",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "rebuild_semantic_index",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "read_markdown_files",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "inspect_vault_context",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "count_words",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "get_note_graph_context",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "find_related_notes",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "suggest_note_links",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "list_folder",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "get_path_info",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_research_memory",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "read_research_memory",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "append_research_memory",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "list_templates",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "read_template",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "seed_default_templates",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_template",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "fill_template",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_research_pack",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_folder",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "append_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "replace_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "move_path",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "delete_path",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "web_search",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "web_fetch",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "append_to_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "append_to_current_section",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "rename_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "retitle_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "highlight_current_file_phrase",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "restore_current_file_from_backup",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "prepare_edit_current_section",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "edit_current_section",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "replace_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "delete_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "link_related_notes_in_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_design_canvas",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_design_package",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "read_design_canvas",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "update_design_canvas",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_svg_design",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "read_svg_design",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "update_svg_design",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "read_mermaid_block",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "upsert_mermaid_block",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    execute: async (call): Promise<ToolExecutionResult> => {
      executedCalls.push(call);

      if (call.name === "read_current_file" && options.readCurrentError) {
        return {
          ok: false,
          toolName: call.name,
          error: {
            code: "execution_failed",
            message: options.readCurrentError,
          },
        };
      }

      if (call.name === "inspect_vault_context" && options.inspectVaultError) {
        return {
          ok: false,
          toolName: call.name,
          error: {
            code: "execution_failed",
            message: options.inspectVaultError,
          },
        };
      }

      return {
        ok: true,
        toolName: call.name,
        output:
          call.name === "read_current_file"
            ? { path: "Current.md", content: "Initial note" }
            : call.name === "list_current_folder"
              ? {
                  activeFile: { path: "Current.md", basename: "Current" },
                  currentFolder: { path: "", name: "" },
                  parentFolder: null,
                  entries: [],
                }
            : call.name === "list_markdown_files"
              ? [
                  { path: "People/Untitled.md", basename: "Untitled" },
                  { path: "Projects/Untitled.md", basename: "Untitled" },
                  { path: "Archive/Untitled.md", basename: "Untitled" },
                ]
            : call.name === "search_markdown_files"
              ? {
                  query: call.arguments.query,
                  limit: call.arguments.limit ?? 30,
                  results: [
                    {
                      path: "People/Untitled.md",
                      basename: "Untitled",
                      matchCount: 1,
                      snippet: "Alex likes local AI tools.",
                    },
                  ],
                  truncated: false,
                }
            : call.name === "semantic_search_notes"
              ? {
                  operation: "semantic_search_notes",
                  mode: "hybrid_semantic",
                  indexUsed: false,
                  indexFresh: false,
                  model: "nomic-ai/nomic-embed-text-v1.5-Q",
                  dim: 512,
                  fallbackUsed: false,
                  results: [
                    {
                      path: "People/Untitled.md",
                      title: "Untitled",
                      score: 0.84,
                      semanticScore: 0.79,
                      lexicalScore: 0.22,
                      reasons: ["semantic_similarity"],
                      heading: null,
                      snippet: "Alex likes local AI tools.",
                    },
                  ],
                }
            : call.name === "inspect_semantic_index"
              ? {
                  operation: "inspect_semantic_index",
                  indexAvailable: true,
                  indexFresh: true,
                  indexedAt: "2026-07-05T00:00:00.000Z",
                  model: "nomic-ai/nomic-embed-text-v1.5-Q",
                  dim: 512,
                  concepts: [{ term: "local", count: 1, paths: ["People/Untitled.md"] }],
                  results: [
                    {
                      path: "People/Untitled.md",
                      title: "Untitled",
                      snippet: "Alex likes local AI tools.",
                    },
                  ],
                }
            : call.name === "rebuild_semantic_index"
              ? {
                  ok: true,
                  operation: "semantic_index_rebuild",
                  markdownPath: "Agent Memory/Semantic Vault Index.md",
                  jsonPath: "Agent Memory/semantic-vault-index.json",
                  indexedAt: "2026-07-05T00:00:00.000Z",
                  noteCount: 1,
                  chunkCount: 1,
                  updatedPaths: ["People/Untitled.md"],
                  removedPaths: [],
                  skippedPaths: [],
                }
            : call.name === "read_markdown_files"
              ? {
                  requestedCount: (call.arguments.paths as unknown[] | undefined)
                    ?.length ?? 0,
                  returnedCount: 3,
                  files: [
                    {
                      path: "People/Untitled.md",
                      basename: "Untitled",
                      content: "Alex likes local AI tools.",
                      truncated: false,
                    },
                    {
                      path: "Projects/Untitled.md",
                      basename: "Untitled",
                      content: "Alex is building an Obsidian research agent.",
                      truncated: false,
                    },
                    {
                      path: "Archive/Untitled.md",
                      basename: "Untitled",
                      content: "Alex prefers traceable agent actions.",
                      truncated: false,
                    },
                  ],
                  skipped: [],
                }
            : call.name === "inspect_vault_context"
              ? {
                  activeFile: {
                    path: "Current.md",
                    folder: "",
                    basename: "Current",
                  },
                  scope: call.arguments.scope ?? "other_folders",
                  folders: [
                    { path: "People", name: "People", markdownCount: 1 },
                    { path: "Projects", name: "Projects", markdownCount: 1 },
                    { path: "Archive", name: "Archive", markdownCount: 1 },
                  ],
                  selectedFiles: [
                    {
                      path: "People/Untitled.md",
                      folder: "People",
                      basename: "Untitled",
                    },
                    {
                      path: "Projects/Untitled.md",
                      folder: "Projects",
                      basename: "Untitled",
                    },
                    {
                      path: "Archive/Untitled.md",
                      folder: "Archive",
                      basename: "Untitled",
                    },
                  ],
                  files: [
                    {
                      path: "People/Untitled.md",
                      folder: "People",
                      basename: "Untitled",
                      content: "Alex likes local AI tools.",
                      truncated: false,
                    },
                    {
                      path: "Projects/Untitled.md",
                      folder: "Projects",
                      basename: "Untitled",
                      content: "Alex is building an Obsidian research agent.",
                      truncated: false,
                    },
                    {
                      path: "Archive/Untitled.md",
                      folder: "Archive",
                      basename: "Untitled",
                      content: "Alex prefers traceable agent actions.",
                      truncated: false,
                    },
                  ],
                  skipped: [],
                  truncated: false,
                }
            : call.name === "list_folder"
              ? { path: call.arguments.path ?? "", entries: [] }
            : call.name === "get_path_info"
              ? { path: call.arguments.path ?? "", exists: true, type: "folder" }
            : call.name === "list_templates"
              ? {
                  templateFolder: "Templates",
                  templates: [
                    {
                      path: "Templates/Meeting.md",
                      basename: "Meeting",
                    },
                  ],
                  truncated: false,
                }
            : call.name === "read_template"
              ? {
                  path: call.arguments.path ?? "Templates/Meeting.md",
                  content: "# {{title}}\n\nDate: {{date}}",
                  placeholders: ["title", "date"],
                  truncated: false,
                }
            : call.name === "seed_default_templates"
              ? {
                  path: "Templates",
                  operation: "create",
                  createdTemplates: [
                    { path: "Templates/Research brief.md" },
                    { path: "Templates/Research note.md" },
                    { path: "Templates/Linear issue.md" },
                    { path: "Templates/Linear ticket.md" },
                    { path: "Templates/Experiment log.md" },
                    { path: "Templates/Essay section.md" },
                    { path: "Templates/Design brief.md" },
                  ],
                  skippedExisting: [],
                  affectedCount: 7,
                }
            : call.name === "create_template"
              ? {
                  path: call.arguments.path,
                  operation: "create",
                  templateFolder: "Templates",
                  placeholders: ["title"],
                  bytesWritten: 12,
                }
            : call.name === "fill_template"
              ? {
                  path: call.arguments.targetPath ?? "Meeting.md",
                  operation: "create",
                  templateSource: call.arguments.templatePath
                    ? "saved_template"
                    : "ad_hoc_template",
                  templatePath: call.arguments.templatePath,
                  placeholders: ["title"],
                  valuesApplied: ["title"],
                  bytesWritten: 12,
                }
            : call.name === "create_research_pack"
              ? {
                  path: call.arguments.baseFolder ?? "Research/Pack",
                  operation: "create_research_pack",
                  createdPaths: ["Brief.md", "Sources.md", "Synthesis.md", "Index.md"],
                  bytesWritten: 48,
                }
            : call.name === "create_folder"
              ? { path: call.arguments.path, operation: "create_folder" }
            : call.name === "create_file"
              ? {
                  path: call.arguments.path,
                  operation: "create",
                  bytesWritten: 12,
                }
            : call.name === "append_file"
              ? {
                  path: call.arguments.path,
                  operation: "append",
                  bytesWritten: 9,
                }
            : call.name === "replace_file"
              ? {
                  path: call.arguments.path,
                  operation: "replace",
                  backupPath: ".agent-backups/1-Target.md",
                  bytesWritten: 9,
                }
            : call.name === "move_path"
              ? {
                  path: call.arguments.fromPath,
                  toPath: call.arguments.toPath,
                  operation: "move",
                }
            : call.name === "delete_path"
              ? {
                  path: call.arguments.path,
                  operation: "trash",
                  affectedCount: 1,
                }
            : call.name === "append_to_current_file"
              ? { path: "Current.md", bytesWritten: 9 }
            : call.name === "rename_current_file"
              ? {
                  path: "Current.md",
                  toPath: "Renamed.md",
                  title: call.arguments.title,
                  changed: true,
                  operation: "rename_current_file",
                  bytesWritten: 0,
                }
            : call.name === "retitle_current_file"
              ? {
                  path: "Current.md",
                  title: call.arguments.title,
                  changed: true,
                  suggestedFileRename: {
                    from: "Current.md",
                    to: "Native Obsidian Agentic Research.md",
                  },
                }
            : call.name === "highlight_current_file_phrase"
              ? {
                  path: "Current.md",
                  operation: "highlight",
                  phrase: call.arguments.phrase,
                  matchCount: 1,
                  backupPath: ".agent-backups/1-Current.md",
                  changed: true,
                  bytesWritten: 24,
                }
            : call.name === "restore_current_file_from_backup"
              ? {
                  path: "Current.md",
                  operation: "restore",
                  restoredFromBackupPath: ".agent-backups/1-Current.md",
                  backupPath: ".agent-backups/2-Current.md",
                  bytesWritten: 24,
                }
            : call.name === "edit_current_section"
              ? {
                  path: "Current.md",
                  backupPath: ".agent-backups/1-Current.md",
                  heading: call.arguments.heading,
                  level: call.arguments.level ?? 2,
                  bytesWritten: 20,
                  replacedChars: 9,
                }
            : call.name === "prepare_edit_current_section"
              ? {
                  path: "Current.md",
                  backupPath: ".agent-backups/1-Current.md",
                  heading: call.arguments.heading,
                  level: call.arguments.level ?? 2,
                  prefix: "## Goals\n",
                  suffix: "\n## Scope\nKeep scope.",
                  replacedChars: 11,
                }
            : call.name === "replace_current_file"
              ? {
                  path: "Current.md",
                  backupPath: ".agent-backups/1-Current.md",
                  bytesWritten: 9,
                }
            : call.name === "delete_current_file"
              ? {
                  path: "Current.md",
                  backupPath: ".agent-backups/1-Current.md",
                  bytesDeleted: 12,
                }
            : call.name === "link_related_notes_in_current_file"
              ? {
                  path: "Current.md",
                  operation: "link_related_notes",
                  backupPath: ".agent-backups/1-Current.md",
                  insertedLinks: [],
                  skipped: [],
                  bytesWritten: 12,
                }
            : call.name === "web_fetch"
              ? {
                  title: "Fetched source",
                  url: call.arguments.url,
                  content: "Fetched content",
                  links: [],
                }
            : call.name === "create_design_canvas"
              ? {
                  path: "Designs/Product Flow.canvas",
                  operation: "create",
                  nodeCount: 2,
                  edgeCount: 1,
                  canvas: {
                    nodes: [{ id: "start" }, { id: "end" }],
                    edges: [{ id: "edge" }],
                  },
                }
            : call.name === "create_design_package"
              ? {
                  path: "Design Packages/System Architecture.md",
                  operation: "create",
                  canvasPath: "Design Packages/System Architecture.canvas",
                  svgPath: "Design Packages/System Architecture.svg",
                  briefPath: "Design Packages/System Architecture.md",
                  itemCount: 5,
                  edgeCount: 4,
                  assessment: {
                    version: 1,
                    profile: "distributed_system",
                    coveredConcerns: ["capacity and scaling"],
                    warnings: [],
                  },
                }
            : call.name === "read_design_canvas"
              ? {
                  path: call.arguments.path,
                  sha256: `sha256:${"a".repeat(64)}`,
                  bytes: 256,
                  nodeCount: 2,
                  edgeCount: 1,
                  canvas: {
                    nodes: [
                      { id: "canvas-title", type: "text", text: "Original" },
                      { id: "sentinel", type: "text", text: "Preserve me" },
                    ],
                    edges: [{ id: "edge" }],
                  },
                }
            : call.name === "update_design_canvas"
              ? {
                  path: call.arguments.path,
                  operation: "update",
                  beforeSha256: call.arguments.baseHash,
                  afterSha256: `sha256:${"b".repeat(64)}`,
                  backupPath: ".agent-backups/1-Product Flow.canvas",
                  backupSha256: call.arguments.baseHash,
                  changedNodeIds: ["canvas-title"],
                  changedEdgeIds: [],
                  preservedNodeIds: ["sentinel"],
                  preservedEdgeIds: ["edge"],
                  rollbackStatus: "not_needed",
                }
            : call.name === "create_svg_design"
              ? {
                  path: "Designs/settings-wireframe.svg",
                  operation: "create",
                  shapeCount: 3,
                  svg: "<svg><rect/><text>Settings</text></svg>",
                }
            : call.name === "read_svg_design"
              ? {
                  path: call.arguments.path,
                  operation: "read",
                  sha256: `sha256:${"c".repeat(64)}`,
                  bytes: 180,
                  elementCount: 3,
                  stableIds: ["root", "title", "sentinel"],
                }
            : call.name === "update_svg_design"
              ? {
                  path: call.arguments.path,
                  operation: "update",
                  beforeSha256: call.arguments.baseHash,
                  afterSha256: `sha256:${"d".repeat(64)}`,
                  backupPath: ".agent-backups/diagrams/Settings.svg",
                  backupSha256: call.arguments.baseHash,
                  rollbackStatus: "not_required",
                }
            : call.name === "read_mermaid_block"
              ? {
                  path: call.arguments.path,
                  operation: "read",
                  sha256: `sha256:${"e".repeat(64)}`,
                  bytes: 220,
                  selector: call.arguments.selector,
                  matched: true,
                  mermaid: "flowchart LR\n  A --> B",
                  metadata: { heading: "Architecture" },
                }
            : call.name === "upsert_mermaid_block"
              ? {
                  path: call.arguments.path,
                  operation: "update",
                  beforeSha256: call.arguments.baseHash,
                  afterSha256: `sha256:${"f".repeat(64)}`,
                  backupPath: ".agent-backups/diagrams/System.md",
                  backupSha256: call.arguments.baseHash,
                  selector: call.arguments.selector,
                  rollbackStatus: "not_required",
                }
              : { value: call.name, args: call.arguments },
      };
    },
  };
}

function responseWithToolCall(
  name: string,
  args: Record<string, unknown>,
  content = "Hidden tool preamble",
): ModelChatResponse {
  const toolCall = { name, arguments: args };
  return {
    message: {
      role: "assistant",
      content,
      toolCalls: [toolCall],
    },
    toolCalls: [toolCall],
  };
}

function responseWithToolCalls(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  content = "Hidden tool preamble",
): ModelChatResponse {
  return {
    message: {
      role: "assistant",
      content,
      toolCalls: calls,
    },
    toolCalls: calls,
  };
}

function backgroundCodeValidationDescriptor(): ToolDescriptor {
  return {
    version: 1,
    name: "code_validate_commit_prepared",
    capability: {
      system: "git",
      resourceType: "prepared_validation_commit",
      action: "commit",
    },
    effect: "execution",
    risk: "high",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
      fallback: "exact",
    },
    execution: {
      preparation: "required",
      desktopOnly: true,
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["host", "single_agent", "lead", "code_worker"],
    receiptKind: "code_change",
  };
}

function testFingerprint(character: string): string {
  return `sha256:${character.repeat(64).slice(0, 64)}`;
}

function companionRemoteJobFromPrepared(
  job: CompanionJobV1,
): CompanionRemoteJobV1 {
  return {
    id: job.id,
    missionId: job.missionId,
    nodeId: job.nodeId,
    executionHost: job.domain,
    state: "queued",
    payload: {
      version: job.version,
      graphRevision: job.graphRevision,
      executionHost: job.executionHost,
      objective: job.objective,
      inputs: job.inputs,
      allowedTools: job.allowedTools,
      requiredCapabilities: job.requiredCapabilities,
      bindings: job.bindings,
      authorization: job.authorization,
      preparedExternalActionHandoff:
        job.preparedExternalActionHandoff ?? null,
      preparedBackgroundCodeAction:
        job.preparedBackgroundCodeAction ?? null,
      preparedBackgroundCodePackage:
        job.preparedBackgroundCodePackage ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    } as never,
    capabilityEnvelope: {
      fingerprint: job.capabilityEnvelopeFingerprint,
      authorizationFingerprint: job.authorization.fingerprint,
    },
    idempotencyKey: job.idempotencyKey,
    ownerCoordinatorId: null,
    leaseExpiresAt: null,
    attempts: 0,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function responseWithContent(
  content: string,
  thinking?: string,
  raw?: unknown,
): TestModelChatResponse {
  return {
    message: {
      role: "assistant",
      content,
      thinking,
    },
    toolCalls: [],
    raw,
  };
}

function responseWithContentDeltas(
  contentDeltas: string[],
  content = contentDeltas.join(""),
  thinkingDeltas: string[] = [],
  options: {
    streamError?: unknown;
    raw?: unknown;
  } = {},
): TestModelChatResponse {
  return {
    ...responseWithContent(content),
    contentDeltas,
    thinkingDeltas,
    raw: options.raw,
    streamError: options.streamError,
  };
}

function createCodeToolsRegistry(
  executedCalls: ModelToolCall[],
  executedContexts: ToolExecutionContext[] = [],
): ToolRegistry {
  const toolNames = [
    "read_current_file",
    "run_code_block",
    "install_code_dependency",
    "write_workspace_file",
  ];
  return {
    getDefinitions: () =>
      toolNames.map((name) => ({
        type: "function" as const,
        function: {
          name,
          parameters: { type: "object" as const, properties: {} },
        },
      })),
    execute: async (call, context): Promise<ToolExecutionResult> => {
      executedCalls.push(call);
      executedContexts.push(context);
      if (call.name === "read_current_file") {
        return {
          ok: true,
          toolName: call.name,
          output: { path: "Current.md", content: "Initial note" },
        };
      }
      if (call.name === "run_code_block") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            language: "python",
            operation: "run",
            result: { exitCode: 0, stdout: "ok", stderr: "", timedOut: false },
          },
        };
      }
      return {
        ok: true,
        toolName: call.name,
        output: { ok: true, toolName: call.name },
      };
    },
  };
}

test("repository read intent exposes only safe workspace bootstrap and inspection capabilities", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const prompt = "Inspect repository: C:/trusted/project and summarize the codebase.";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-12T12:00:00.000Z"),
  });
  const registry = createCodeV2RoutingRegistry();
  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("Repository inspection is pending.")],
    }),
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 1,
  });

  const names = new Set(
    chatRequests[0]?.tools?.map((tool) => tool.function.name) ?? [],
  );
  const safeInspectionTools = new Set([
    "code_workspace_create",
    "code_workspace_status",
    "code_workspace_stat",
    "code_workspace_list",
    "code_workspace_read",
    "code_workspace_search",
    "code_repository_detect_profile",
    "code_sandbox_status",
    "code_repair_status",
  ]);
  assert.ok(names.size > 0);
  assert.deepEqual(
    [...names].filter((name) => !safeInspectionTools.has(name)),
    [],
  );
  assert.ok(names.has("code_workspace_read"));
  assert.ok(names.has("code_repository_detect_profile"));
  assert.equal(names.has("code_workspace_patch"), false);
  assert.equal(names.has("code_validate_full"), false);
  assert.equal(names.has("code_commit_verified"), false);
});

test("missing required literal rejects a write before mutation and accepts one corrected payload", async () => {
  const marker = "E2E_MARKER_1784066436149_631764";
  const prompt = `Append two findings to the current note. Include the marker ${marker}.`;
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Existing\n",
  });
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "- Finding Alpha\n- Finding Beta\n",
        }),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: `- Finding Alpha\n- Finding Beta\n- ${marker}\n`,
        }),
      () => responseWithContent(`Appended both findings with ${marker}.`),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.ok(chatRequests.length >= 2);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["append_to_current_file"],
    statuses.join("\n"),
  );
  assert.equal(
    vault.content.get("Current.md"),
    `# Existing\n- Finding Alpha\n- Finding Beta\n- ${marker}\n`,
  );
  assert.ok(
    statuses.some((message) =>
      /missing 1 literal value\(s\) explicitly required by the mission/iu.test(
        message,
      ),
    ),
  );
  assert.ok(
    chatRequests.some((request) =>
      /Tool-call schema correction: append_to_current_file rejected the supplied arguments/iu.test(
        request.messages.at(-1)?.content ?? "",
      ),
    ),
  );
});

test("namespaced invalid-argument errors receive one schema-qualified correction", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const registry: ToolRegistry = {
    getDefinitions: () => [{
      type: "function",
      function: {
        name: "append_to_current_file",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    }],
    execute: async (call) => {
      executedCalls.push(call);
      if (executedCalls.length === 1) {
        return {
          ok: false,
          toolName: call.name,
          mutationState: "not_applied",
          error: {
            code: "vault_append_invalid_arguments",
            message: "The append payload must use the current schema.",
          },
        };
      }
      return {
        ok: true,
        toolName: call.name,
        output: {
          path: "Current.md",
          operation: "append",
          bytesWritten: 20,
          readback: {
            status: "verified",
            checkedAt: "2026-07-18T00:00:00.000Z",
            observedFingerprint: `sha256:${"a".repeat(64)}`,
          },
        },
      };
    },
  };

  await runAgentMission({
    prompt: "Append the bounded result to the current note.",
    modelClient: createClient({
      chatRequests,
      chatResponders: [
        () => responseWithToolCall("append_to_current_file", { text: "first" }),
        () => responseWithToolCall("append_to_current_file", { text: "corrected" }),
        () => responseWithContent("The bounded append is complete."),
      ],
    }),
    toolRegistry: registry,
    toolContext: createRunnerVaultContext({
      prompt: "Append the bounded result to the current note.",
    }).context,
    enableStreaming: false,
  });

  assert.equal(executedCalls.length, 2);
  assert.ok(
    chatRequests.some((request) =>
      /Tool-call schema correction: append_to_current_file rejected the supplied arguments/iu.test(
        request.messages.at(-1)?.content ?? "",
      ),
    ),
  );
});

test("repository implementation exposes only read-only status tools at the initial graph frontier", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const prompt = "Fix the bug in repository: C:/trusted/project, validate it, and commit the verified change.";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-12T12:05:00.000Z"),
  });
  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("Implementation is pending.")],
    }),
    toolRegistry: createCodeV2RoutingRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 1,
  });

  const names = new Set(
    chatRequests[0]?.tools?.map((tool) => tool.function.name) ?? [],
  );
  const safeInspectionTools = new Set([
    "code_workspace_create",
    "code_workspace_status",
    "code_workspace_stat",
    "code_workspace_list",
    "code_workspace_read",
    "code_workspace_search",
    "code_repository_detect_profile",
    "code_sandbox_status",
    "code_repair_status",
  ]);
  assert.ok(names.has("code_sandbox_status"));
  assert.deepEqual(
    [...names].filter((name) => !safeInspectionTools.has(name)),
    [],
  );
  assert.equal(names.has("code_workspace_patch"), false);
  assert.equal(names.has("code_validate_targeted"), false);
  assert.equal(names.has("code_validate_full"), false);
  assert.equal(names.has("code_commit_verified"), false);
  assert.equal(names.has("install_code_dependency"), false);
});

test("explicit scratch workspace workflow stays out of note-output routing", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const prompt = [
    "Create the isolated scratch workspace phase4-crud.",
    "Use exactly code_workspace_create, code_workspace_mkdir, and code_workspace_create_file.",
    "Create src/durable-value.txt containing before:phase4 and report receipts.",
  ].join(" ");
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-12T12:10:00.000Z"),
  });

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("Workspace execution is pending.")],
    }),
    toolRegistry: createCodeV2RoutingRegistry(),
    toolContext: {
      ...vault.context,
      settings: { ...vault.context.settings, maxAgentSteps: 40 },
    },
    enableStreaming: false,
    maxSteps: 1,
    events: { onRunConfig: (event) => configs.push(event) },
  });

  assert.equal(configs[0]?.missionMode, "explicit_file_mutation");
  assert.equal(configs[0]?.writebackMode, "tool_write");
  assert.equal(configs[0]?.route, "grounded_workflow");
  assert.ok((configs[0]?.maxStepsForRun ?? 0) >= 8);
  assert.equal(configs[0]?.allowedToolNames.includes("append_to_current_file"), false);
  for (const required of [
    "code_workspace_create",
    "code_workspace_mkdir",
    "code_workspace_create_file",
  ]) {
    assert.ok(configs[0]?.allowedToolNames.includes(required), `missing ${required}`);
  }
});

test("bare Python Desktop delivery plans only the scratch validation and export ladder", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const graphs: Array<{
    nodes: Record<string, { allowedTools: string[] }>;
  }> = [];
  const prompt = "write a number guessing game in Python on my desktop";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-25T12:10:00.000Z"),
  });

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("Workspace execution is pending.")],
    }),
    toolRegistry: createCodeV2RoutingRegistry(),
    toolContext: {
      ...vault.context,
      settings: {
        ...vault.context.settings,
        maxAgentSteps: 40,
        streamWritebackMode: "all_current_note_content_writes",
      },
    },
    enableStreaming: true,
    maxSteps: 1,
    events: {
      onRunConfig: (event) => configs.push(event),
      onMissionGraphUpdate: (graph) => graphs.push(graph),
    },
  });

  const allowed = new Set(configs[0]?.allowedToolNames ?? []);
  for (const required of getRequiredCodeWorkflowToolNames(prompt)) {
    assert.ok(allowed.has(required), `missing ${required}`);
  }
  assert.equal(allowed.has("append_to_current_file"), false);
  const graphTools = Object.values(graphs.at(-1)?.nodes ?? {}).flatMap(
    (node) => node.allowedTools,
  );
  assert.equal(graphTools.includes("code_commit_verified"), false);
  assert.equal(graphTools.includes("append_to_current_file"), false);
  assert.deepEqual(
    chatRequests[0]?.tools?.map((tool) => tool.function.name),
    ["code_sandbox_status"],
  );
  assert.match(
    chatRequests[0]?.messages
      .map((message) => String(message.content ?? ""))
      .join("\n"),
    /CAPABILITY_SNAPSHOT_V1[\s\S]*installed:[\s\S]*offered_now:/u,
  );
});

test("bare Python Desktop delivery corrects a prose-only exact frontier inside the same segment", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const traces: AgentTraceEvent[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const statuses: string[] = [];
  const prompt = "write a number guessing game in Python on my desktop";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-25T12:10:30.000Z"),
  });
  const baseRegistry = createCodeV2RoutingRegistry();
  const registry: ToolRegistry = {
    ...baseRegistry,
    execute: async (call, context) => {
      executedCalls.push(call);
      return baseRegistry.execute(call, context);
    },
  };

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [
        () => responseWithContent(
          "I created the game and it is ready, so no further action is needed.",
        ),
        () => responseWithToolCall("code_sandbox_status", {}),
      ],
    }),
    toolRegistry: registry,
    toolContext: {
      ...vault.context,
      settings: {
        ...vault.context.settings,
        maxAgentSteps: 40,
        streamWritebackMode: "all_current_note_content_writes",
      },
    },
    enableStreaming: true,
    maxSteps: 2,
    events: {
      onTrace: (event) => traces.push(event),
      onRunComplete: (event) => completions.push(event),
      onStatus: (message) => statuses.push(message),
    },
  });

  const diagnostic = JSON.stringify({
    traces: traces.map((event) => event.message),
    completions,
    statuses,
  });
  assert.equal(chatRequests.length, 2, diagnostic);
  assert.deepEqual(
    chatRequests[1]?.tools?.map((tool) => tool.function.name),
    ["code_sandbox_status"],
  );
  assert.equal(chatRequests[1]?.toolChoice, "required");
  assert.equal(chatRequests[1]?.think, false);
  assert.match(
    chatRequests[1]?.messages
      .map((message) => String(message.content ?? ""))
      .join("\n"),
    /prior response contained prose but no tool call[\s\S]*Call code_sandbox_status now[\s\S]*Return the tool call only/iu,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["code_sandbox_status"],
  );
});

test("bare Python Desktop delivery stops before the model when the Code catalog is missing", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const finalChunks: string[] = [];
  const traces: AgentTraceEvent[] = [];
  const prompt = "write a number guessing game in Python on my desktop";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-25T12:11:00.000Z"),
  });

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("This must not run.")],
    }),
    toolRegistry: createRegistry([]),
    toolContext: {
      ...vault.context,
      getCapabilityReadiness: () => [{
        version: 2,
        id: "code",
        name: "Code",
        status: "Blocked",
        reason: "The Code runtime is not registered.",
        evidenceAt: null,
        nextAction: "Reload Code capability",
        setupTarget: "code",
      }],
    },
    enableStreaming: false,
    maxSteps: 1,
    events: {
      onFinalDelta: (chunk) => finalChunks.push(chunk),
      onTrace: (event) => traces.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.match(finalChunks.join(""), /Code tool catalog is not registered/iu);
  assert.match(finalChunks.join(""), /Reload Code capability/iu);
  assert.ok(
    traces.some(
      (event) =>
        event.error?.code === "code_capability_tools_unavailable",
    ),
  );
});

test("generic repository implementation does not expose unrequested path relocation or cleanup", async () => {
  const configs: AgentRunConfigEvent[] = [];
  const prompt = [
    "Implement the Python checkers files in the trusted repository and validate the code.",
    "Do not move, copy, trash, restore, or delete any file or provider resource.",
  ].join(" ");
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-17T16:00:00.000Z"),
  });

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests: [],
      chatResponders: [() => responseWithContent("Repository execution is pending.")],
    }),
    toolRegistry: createCodeV2RoutingRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 1,
    events: { onRunConfig: (event) => configs.push(event) },
  });

  const allowed = new Set(configs[0]?.allowedToolNames ?? []);
  assert.equal(allowed.has("code_workspace_patch"), true);
  assert.equal(allowed.has("code_workspace_move"), false);
  assert.equal(allowed.has("code_workspace_copy"), false);
  assert.equal(allowed.has("code_workspace_trash"), false);
  assert.equal(allowed.has("code_workspace_restore"), false);
});

test("explicit add-only filename lists route to no-overwrite workspace creation", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const traces: string[] = [];
  const graphs: Array<{
    nodes: Record<
      string,
      {
        allowedTools: string[];
        destination?: { selector?: string | null } | null;
      }
    >;
  }> = [];
  const prompt = [
    "Implement the Python checkers game in the trusted repository.",
    "Add only README.md, checkers/__init__.py, checkers/cli.py, checkers/game.py, and tests/test_checkers.py.",
    "Leave the protected scripts directory unchanged, then validate and commit the code.",
  ].join(" ");
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-18T16:00:00.000Z"),
  });

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("Repository execution is pending.")],
    }),
    toolRegistry: createCodeV2RoutingRegistry(),
    toolContext: {
      ...vault.context,
      settings: { ...vault.context.settings, maxAgentSteps: 80 },
    },
    enableStreaming: false,
    maxSteps: 1,
    events: {
      onRunConfig: (event) => configs.push(event),
      onMissionGraphUpdate: (graph) => graphs.push(graph),
      onTrace: (event) => traces.push(event.message),
    },
  });

  const allowed = new Set(configs[0]?.allowedToolNames ?? []);
  assert.equal(allowed.has("code_workspace_create_file"), true);
  const graphNodes = Object.values(graphs.at(-1)?.nodes ?? {});
  const graphTools = graphNodes.flatMap(
    (node) => node.allowedTools,
  );
  assert.equal(graphTools.includes("append_file"), false);
  assert.equal(graphTools.includes("create_file"), false);
  assert.equal(
    graphNodes.find((node) => node.allowedTools.length > 0)?.allowedTools[0],
    "code_sandbox_status",
    traces.join(" | "),
  );
  assert.deepEqual(
    chatRequests[0]?.tools?.map((tool) => tool.function.name),
    ["code_sandbox_status"],
  );
  assert.equal(
    graphTools.filter((name) => name === "code_workspace_create_file").length,
    5,
  );
  assert.deepEqual(
    graphNodes
      .filter((node) => node.allowedTools[0] === "code_workspace_create_file")
      .map((node) => node.destination?.selector),
    [
      "README.md",
      "checkers/__init__.py",
      "checkers/cli.py",
      "checkers/game.py",
      "tests/test_checkers.py",
    ],
  );
  assert.equal(
    graphTools.filter((name) => name === "code_workspace_read").length,
    10,
  );
  assert.equal(
    graphTools.filter((name) => name === "code_workspace_write_expected").length,
    10,
  );
  assert.equal(
    graphTools.filter((name) => name === "code_validate_fast").length,
    3,
  );
  assert.equal(
    graphTools.filter((name) => name === "code_repair_record_cycle").length,
    3,
  );
  assert.equal(graphTools.includes("code_workspace_patch"), false);
});

test("explicit workspace CRUD lifecycle is planned once and reaches the model", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const traceMessages: string[] = [];
  const prompt = [
    "Create isolated scratch workspace phase4-crud.",
    "Use exactly code_workspace_create, code_workspace_mkdir,",
    "code_workspace_create_file, code_workspace_read,",
    "code_workspace_write_expected, code_workspace_move,",
    "code_workspace_trash, and code_workspace_restore.",
    "Create src/durable-value.txt, read its hash, replace it, move it, trash it, and restore it.",
  ].join(" ");
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-12T12:12:00.000Z"),
  });

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("Workspace execution is pending.")],
    }),
    toolRegistry: createCodeV2RoutingRegistry(),
    toolContext: {
      ...vault.context,
      settings: { ...vault.context.settings, maxAgentSteps: 40 },
    },
    enableStreaming: false,
    maxSteps: 1,
    events: {
      onTrace: (event) => traceMessages.push(event.message),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.equal(
    traceMessages.some((message) => /mission graph initialization failed/iu.test(message)),
    false,
  );
  const firstFrontier = new Set(
    chatRequests[0]?.tools?.map((tool) => tool.function.name) ?? [],
  );
  assert.ok(firstFrontier.has("code_workspace_create"));
  assert.equal(firstFrontier.has("code_workspace_write_expected"), false);
  assert.equal(firstFrontier.has("code_workspace_restore"), false);
});

test("explicit workspace lifecycle keeps its leading read in the mission graph", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const prompt = [
    "Operate on the durable workspace phase4-crud as a new mission.",
    "Use code_workspace_read, code_workspace_write_expected, code_workspace_move,",
    "code_workspace_trash, code_workspace_restore, then code_workspace_read.",
    "Replace src/value.txt, move it, trash it, restore it, and verify final bytes.",
  ].join(" ");
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-12T12:15:00.000Z"),
  });

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("Workspace lifecycle is pending.")],
    }),
    toolRegistry: createCodeV2RoutingRegistry(),
    toolContext: {
      ...vault.context,
      settings: { ...vault.context.settings, maxAgentSteps: 40 },
    },
    enableStreaming: false,
    maxSteps: 1,
    events: { onRunConfig: (event) => configs.push(event) },
  });

  assert.equal(configs[0]?.missionMode, "explicit_file_mutation");
  assert.equal(configs[0]?.allowedToolNames.includes("delete_path"), false);
  const firstTools = new Set(
    chatRequests[0]?.tools?.map((tool) => tool.function.name) ?? [],
  );
  assert.ok(firstTools.has("code_workspace_read"));
  assert.equal(firstTools.has("code_workspace_write_expected"), false);
  assert.equal(firstTools.has("code_workspace_restore"), false);
  assert.equal(firstTools.has("web_search"), false);
  assert.equal(firstTools.has("web_fetch"), false);
  assert.equal(firstTools.has("code_sandbox_status"), false);
  assert.equal(firstTools.has("code_workspace_create"), false);
  assert.equal(firstTools.has("code_commit_verified"), false);
  assert.equal(configs[0]?.allowedToolNames.includes("web_search"), false);
});

function createCodeV2RoutingRegistry(): ToolRegistry {
  const readNames = new Set([
    "code_workspace_status",
    "code_workspace_stat",
    "code_workspace_list",
    "code_workspace_read",
    "code_workspace_search",
    "code_repository_detect_profile",
    "code_sandbox_status",
    "code_repair_status",
  ]);
  const names = [
    "code_workspace_create",
    ...readNames,
    "code_workspace_mkdir",
    "code_workspace_create_file",
    "code_workspace_export_directory",
    "code_workspace_append",
    "code_workspace_write_expected",
    "code_workspace_patch",
    "code_workspace_move",
    "code_workspace_copy",
    "code_workspace_trash",
    "code_workspace_restore",
    "code_validate_fast",
    "code_validate_targeted",
    "code_validate_full",
    "code_repair_record_cycle",
    "code_commit_verified",
    "install_code_dependency",
  ];
  const descriptors = new Map<string, ToolDescriptor>(
    names.map((name) => {
      const read = readNames.has(name);
      const action = name.startsWith("code_validate_")
        ? "validate"
        : name === "code_commit_verified"
          ? "commit"
          : name === "install_code_dependency"
            ? "install"
            : name === "code_workspace_trash"
              ? "trash"
              : read
                ? "read"
                : "update";
      return [
        name,
        {
          version: 1,
          name,
          capability: {
            system: name === "code_commit_verified" ? "git" : "workspace",
            resourceType: "code_workspace",
            action,
          },
          effect: read
            ? "read"
            : name.startsWith("code_validate_") ||
                name === "code_commit_verified" ||
                name === "install_code_dependency"
              ? "execution"
              : name === "code_workspace_trash"
                ? "destructive_mutation"
                : "reversible_mutation",
          risk: read ? "low" : "high",
          approval: {
            allowPromptGrant: true,
            allowPersistentGrant: read,
            fallback: read ? "none" : "exact",
          },
          execution: {
            preparation: read ? "none" : "required",
            desktopOnly: true,
            cacheable: read,
            parallelSafe: read,
          },
          durability: {
            journal: !read,
            receipt: !read,
            readback: read ? "none" : "required",
            reconciliation: read ? "none" : "required",
          },
          allowedPrincipals: ["host", "single_agent", "lead"],
          ...(read ? {} : { receiptKind: "code_change" as const }),
        },
      ];
    }),
  );
  return {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: {
          name,
          parameters: { type: "object" as const, properties: {} },
        },
      })),
    getDescriptor: (name) => descriptors.get(name) ?? null,
    execute: async (call) => ({
      ok: true,
      toolName: call.name,
      output: { status: "ok" },
    }),
  };
}

test("accepted web research runs auto-save durable research memory", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const prompt =
    "Search the web for the Ollama structured outputs documentation and summarize it.";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-07T12:00:00.000Z"),
  });

  const registry: ToolRegistry = {
    getDefinitions: () =>
      ["read_current_file", "web_search", "web_fetch", "append_research_memory"].map(
        (name) => ({
          type: "function" as const,
          function: {
            name,
            parameters: { type: "object" as const, properties: {} },
          },
        }),
      ),
    execute: async (call): Promise<ToolExecutionResult> => {
      executedCalls.push(call);
      if (call.name === "web_search") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            results: [
              {
                title: "Router roundup",
                url: "https://example.com/routers",
                snippet: "Local LLM routers compared.",
              },
            ],
          },
        };
      }
      if (call.name === "web_fetch") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            title: "Router roundup",
            url: "https://example.com/routers",
            content: "Detailed comparison of local LLM routers.",
            links: [],
          },
        };
      }
      if (call.name === "append_research_memory") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            path: "Agent Research Memory/latest-local-llm-routers.md",
            operation: "create",
            topic: call.arguments.topic,
            bytesWritten: 256,
          },
        };
      }
      return {
        ok: true,
        toolName: call.name,
        output: { path: "Current.md", content: "Initial note" },
      };
    },
  };

  const finalAnswer =
    "Ollama structured outputs constrain responses to a JSON schema. Source: https://example.com/routers";
  const citedFinalAnswer = (request: ModelChatRequest) => {
    const passageId = getPassageCitationIds(request)[0];
    assert.ok(passageId, "fetched passage id must be visible to final synthesis");
    return responseWithContent(`${finalAnswer}\nPassage evidence: [${passageId}]`);
  };
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("web_search", {
          query: "Ollama structured outputs documentation",
        }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/routers" }),
      citedFinalAnswer,
      citedFinalAnswer,
      citedFinalAnswer,
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const memoryCall = executedCalls.find(
    (call) => call.name === "append_research_memory",
  );
  assert.ok(memoryCall, "accepted research run must auto-save research memory");
  assert.ok(String(memoryCall.arguments.topic).length > 0);
  assert.match(String(memoryCall.arguments.text), /Mission:/);
  assert.match(String(memoryCall.arguments.text), /https:\/\/example\.com\/routers/);
  assert.deepEqual(memoryCall.arguments.sourceUrls, [
    "https://example.com/routers",
  ]);
  assert.ok(
    statuses.some((message) => /Saved research memory:/.test(message)),
    JSON.stringify(statuses),
  );
});

test("proof-sensitive streamed final holds the invalid draft and emits the exact sanitized correction", async () => {
  const prompt =
    "Search the web for Ollama structured outputs documentation and summarize it with citations.";
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const citationScopeTraces: string[] = [];
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "Ollama structured outputs",
              url: "https://example.com/ollama-structured-outputs",
              snippet: "Ollama can constrain generated output with a JSON schema.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "Ollama structured outputs",
          content:
            "Ollama structured outputs accept a JSON schema and constrain model responses to that schema.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  let correctedCandidate = "";
  const outOfScopeContextPassageId =
    "source:current-note-context:passage:0-120";
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("web_search", {
          query: "Ollama structured outputs documentation",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/ollama-structured-outputs",
        }),
      () => responseWithContent(""),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas(
          [
            "<|begin_of_sentence|>INVALID UNVERIFIED DRAFT: Ollama structured outputs constrain JSON, but this draft cites no bound passage.<|end_of_sentence|>",
          ],
          "RAW FIRST PROVIDER CONTENT MUST NOT LEAK",
        ),
      (request) => {
        const passageId = getPassageCitationIds(request)[0];
        assert.ok(
          passageId,
          "the correction request must retain the fetched passage identifier",
        );
        correctedCandidate =
          "Ollama structured outputs constrain responses with a JSON schema. " +
          `Source: https://example.com/ollama-structured-outputs Passage evidence: [${passageId}]`;
        return responseWithContentDeltas(
          [
            `<|begin_of_sentence|>${correctedCandidate} [${outOfScopeContextPassageId}]<|end_of_sentence|>`,
          ],
          "RAW SECOND PROVIDER CONTENT MUST NOT LEAK",
        );
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onRunComplete: (event) => completions.push(event),
      onTrace: (event) => {
        if (event.id.includes("citation-scope-narrowed")) {
          citationScopeTraces.push(event.message ?? "");
        }
      },
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(streamRequests.length, 2);
  assert.ok(
    [...chatRequests, ...streamRequests].some((request) =>
      request.messages.some((message) =>
        /draft failed final-output verification/i.test(message.content),
      ),
    ),
    "the second candidate must be prompted by the proof correction gate",
  );
  assert.ok(
    statuses.some((message) => /(?:Draft|Writeback draft) held for verification/.test(message)),
    JSON.stringify(statuses),
  );
  assert.equal(finalDeltas.join(""), correctedCandidate);
  assert.equal(assistantDeltas.join(""), correctedCandidate);
  assert.doesNotMatch(finalDeltas.join(""), /INVALID UNVERIFIED DRAFT/);
  assert.doesNotMatch(finalDeltas.join(""), /RAW (?:FIRST|SECOND) PROVIDER/);
  assert.doesNotMatch(finalDeltas.join(""), /current-note-context/u);
  assert.ok(
    citationScopeTraces.some((message) =>
      /outside the accepted fetched-source set/iu.test(message),
    ),
    JSON.stringify(citationScopeTraces),
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stopReason, "write_completed");
});

test("repeated proof-sensitive candidate failures emit only a resumable blocker", async () => {
  const prompt =
    "Search the web for Ollama structured outputs documentation and summarize it with citations.";
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const assistantDeltas: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.settings.maxAgentSteps = 4;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "Ollama structured outputs",
              url: "https://example.com/ollama-structured-outputs",
              snippet: "Ollama can constrain generated output with a JSON schema.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "Ollama structured outputs",
          content:
            "Ollama structured outputs accept a JSON schema and constrain model responses to that schema.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const invalidCandidate =
    "INVALID UNVERIFIED DRAFT: Ollama structured outputs constrain JSON without citing the bound passage.";
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("web_search", {
          query: "Ollama structured outputs documentation",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/ollama-structured-outputs",
        }),
      () => responseWithContent(""),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () => responseWithContentDeltas([invalidCandidate]),
      () =>
        responseWithContentDeltas(
          [`${invalidCandidate} This second attempt is still uncited.`],
          "RAW REPEATED FAILURE MUST NOT LEAK",
        ),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(streamRequests.length, 2);
  assert.doesNotMatch(assistantDeltas.join(""), /INVALID UNVERIFIED DRAFT/);
  assert.doesNotMatch(assistantDeltas.join(""), /RAW REPEATED FAILURE/);
  assert.match(
    assistantDeltas.join(""),
    /Note writeback was not applied because proof verification is incomplete/i,
  );
  assert.ok(
    statuses.some((message) =>
      /Note writeback was not applied because proof verification is incomplete/i.test(
        message,
      ),
    ),
    JSON.stringify(statuses),
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stopReason, "budget");
});

test("policy engine requires approval before install_code_dependency executes", async () => {
  __setCodeToolsDesktopAppForTests(true);
  try {
    const chatRequests: ModelChatRequest[] = [];
    const executedCalls: ModelToolCall[] = [];
    const approvalRequests: ApprovalRequest[] = [];
    const resolvedDecisions: string[] = [];
    const broker = new ApprovalBroker();

    const client = createClient({
      chatRequests,
      chatResponders: [
        () =>
          responseWithToolCall("install_code_dependency", {
            manager: "pip",
            packageName: "requests",
          }),
        () => responseWithContent("Stopped: the dependency install was denied."),
        () => responseWithContent("Stopped: the dependency install was denied."),
        () => responseWithContent("Stopped: the dependency install was denied."),
      ],
    });

    await runAgentMission({
      prompt: "Run the python code snippet after installing the requests package.",
      modelClient: client,
      toolRegistry: createCodeToolsRegistry(executedCalls),
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
      approvalBroker: broker,
      events: {
        onApprovalRequest: (request) => {
          approvalRequests.push(request);
          broker.resolve(request.id, "denied");
        },
        onApprovalResolved: ({ decision }) => {
          resolvedDecisions.push(decision);
        },
      },
    });

    assert.equal(approvalRequests.length, 1);
    assert.equal(approvalRequests[0].toolName, "install_code_dependency");
    assert.ok(approvalRequests[0].policyTags.includes("dependency_install"));
    assert.deepEqual(resolvedDecisions, ["denied"]);
    assert.ok(
      !executedCalls.some((call) => call.name === "install_code_dependency"),
      "denied install must never reach the tool registry",
    );
  } finally {
    __setCodeToolsDesktopAppForTests(null);
  }
});

test("composite tools route nested exact approval through the real broker and UI events", async () => {
  const prompt = "Publish this accepted research report to Linear.";
  const broker = new ApprovalBroker();
  const approvalRequests: ApprovalRequest[] = [];
  const approvalDecisions: string[] = [];
  const nestedDecisions: unknown[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const vault = createRunnerVaultContext({ prompt, content: "# Research\n" });
  vault.context.settings.linearEnabled = true;
  const carrier = await withPreparedActionFingerprint({
    version: 1 as const,
    id: "research-publication-preview-1",
    runId: "nested-approval-run",
    toolCallId: "nested-call-1",
    toolName: "publish_research_to_linear",
    target: { system: "linear" as const, resourceType: "issue", id: "pending-issue" },
    relatedResources: [],
    normalizedArgs: {},
    preview: {
      summary: "Create Linear issue: Accepted research",
      destination: "Linear team=team-1 project=project-1",
      outboundPayload: { title: "Accepted research" },
      warnings: [],
      outboundBytes: 100,
    },
    preparedAt: "2026-07-12T20:00:00.000Z",
    expiresAt: "2026-07-12T20:05:00.000Z",
  });
  const tool: AgentTool = {
    name: "publish_research_to_linear",
    description: "Test nested publication approval.",
    parameters: { type: "object", additionalProperties: false },
    descriptor: {
      version: 1,
      name: "publish_research_to_linear",
      capability: { system: "linear", resourceType: "issue", action: "publish" },
      effect: "publish",
      risk: "high",
      approval: { allowPromptGrant: false, allowPersistentGrant: false, fallback: "exact" },
      execution: { preparation: "none", cacheable: false, parallelSafe: false },
      durability: { journal: true, receipt: true, readback: "required", reconciliation: "required" },
      allowedPrincipals: ["single_agent"],
      receiptKind: "external_action",
    },
    execute: async (_args, context) => {
      assert.ok(context.requestNestedApproval);
      const decision = await context.requestNestedApproval!({
        toolName: "publish_research_to_linear",
        action: "Create exact Linear issue",
        reason: "Approve exact research publication preview.",
        policyTags: ["linear_research_publication", "exact_preview"],
        preparedAction: carrier,
      });
      nestedDecisions.push(decision);
      return { status: decision.approved ? "complete" : "denied" };
    },
  };
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("publish_research_to_linear", {}),
      () => responseWithContent("Published the accepted research to Linear."),
    ],
  });

  await runAgentMission({
    prompt,
    runId: "nested-approval-run",
    modelClient: client,
    toolRegistry: new DefaultToolRegistry([tool]),
    toolContext: vault.context,
    enableStreaming: false,
    approvalBroker: broker,
    events: {
      onStatus: (message) => statuses.push(message),
      onApprovalRequest: (request) => {
        approvalRequests.push(request);
        broker.resolve(request.id, "approved");
      },
      onApprovalResolved: ({ decision }) => {
        approvalDecisions.push(decision);
      },
    },
  });

  assert.equal(
    approvalRequests.length,
    1,
    `tools=${chatRequests[0]?.tools?.map((item) => item.function.name).join(",")}; statuses=${statuses.join(" | ")}`,
  );
  assert.equal(approvalRequests[0].preparedAction?.preview.outboundPayload?.title, "Accepted research");
  assert.equal(approvalRequests[0].payloadFingerprint, carrier.payloadFingerprint);
  assert.deepEqual(approvalDecisions, ["approved"]);
  assert.deepEqual(nestedDecisions, [{
    approved: true,
    approvalId: approvalRequests[0].id,
    approvalFingerprint: carrier.payloadFingerprint,
  }]);
});

test("composite GitHub merge routes two distinct nested approvals through the real broker", async () => {
  const prompt = "Merge the verified GitHub pull request after fresh checks pass.";
  const broker = new ApprovalBroker();
  const approvalRequests: ApprovalRequest[] = [];
  const vault = createRunnerVaultContext({ prompt, content: "# Code publication\n" });
  vault.context.settings.githubEnabled = true;
  const carrier = await withPreparedActionFingerprint({
    version: 1 as const,
    id: "github-merge-preview-1",
    runId: "nested-github-merge-run",
    toolCallId: "nested-github-merge-call",
    toolName: "publish_verified_code_to_github",
    target: {
      system: "github" as const,
      resourceType: "pull_request",
      id: "acme/research-agent#12",
    },
    relatedResources: [],
    normalizedArgs: { action: "merge", profileKey: "fixture" },
    preview: {
      summary: "Merge pull request #12 at the verified head",
      destination: "GitHub acme/research-agent PR #12",
      outboundPayload: {
        pullRequestNumber: 12,
        sha: "b".repeat(40),
        mergeMethod: "squash",
      },
      warnings: ["Any head or check drift invalidates approval."],
      outboundBytes: 100,
    },
    preparedAt: "2026-07-13T20:00:00.000Z",
    expiresAt: "2026-07-13T20:05:00.000Z",
    requiredConfirmations: 2,
  });
  const descriptor: ToolDescriptor = {
    version: 1,
    name: "publish_verified_code_to_github",
    capability: {
      system: "github",
      resourceType: "pull_request",
      action: "merge",
    },
    effect: "publish",
    risk: "critical",
    approval: {
      allowPromptGrant: false,
      allowPersistentGrant: false,
      fallback: "double_exact",
    },
    execution: { preparation: "none", cacheable: false, parallelSafe: false },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["single_agent"],
    receiptKind: "external_action",
  };
  const tool: AgentTool = {
    name: descriptor.name,
    description: "Test composite double-exact GitHub merge approval.",
    parameters: { type: "object", additionalProperties: false },
    descriptor,
    execute: async (_args, context) => {
      assert.ok(context.requestNestedApproval);
      for (const confirmationIndex of [1, 2] as const) {
        const decision = await context.requestNestedApproval!({
          toolName: descriptor.name,
          action: carrier.preview.summary,
          reason: "Approve the exact fresh PR head and check snapshot.",
          policyTags: ["github_publication", "merge", "double_exact"],
          preparedAction: carrier,
          confirmationIndex,
          requiredConfirmations: 2,
        });
        assert.equal(decision.approved, true);
      }
      return { status: "complete" };
    },
  };
  await runAgentMission({
    prompt,
    runId: "nested-github-merge-run",
    modelClient: createClient({
      chatRequests: [],
      chatResponders: [
        () => responseWithToolCall(descriptor.name, {}),
        () => responseWithContent("The exact GitHub merge was approved."),
      ],
    }),
    toolRegistry: new DefaultToolRegistry([tool]),
    toolContext: vault.context,
    enableStreaming: false,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        approvalRequests.push(request);
        broker.resolve(request.id, "approved");
      },
    },
  });

  assert.deepEqual(
    approvalRequests.map((request) => request.confirmationIndex),
    [1, 2],
  );
  assert.equal(
    new Set(approvalRequests.map((request) => request.id)).size,
    2,
  );
  assert.equal(
    approvalRequests.every(
      (request) =>
        request.requiredConfirmations === 2 &&
        request.payloadFingerprint === carrier.payloadFingerprint,
    ),
    true,
  );
});

test("explicit verified-code GitHub publication intent exposes and requires the bounded publication tool", async () => {
  const prompt =
    "Push the latest verified local commit for profile trusted-repository to GitHub and open a draft PR.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const publicationToolName = "publish_verified_code_to_github";
  const publicationTool: AgentTool = {
    name: publicationToolName,
    description: "Test-only host-resolved verified code publication bridge.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["publish_draft"] },
        profileKey: { type: "string" },
      },
      required: ["action", "profileKey"],
      additionalProperties: false,
    },
    descriptor: {
      version: 1,
      name: publicationToolName,
      capability: { system: "github", resourceType: "pull_request", action: "read" },
      effect: "read",
      risk: "low",
      approval: {
        allowPromptGrant: true,
        allowPersistentGrant: false,
        fallback: "none",
      },
      execution: { preparation: "none", cacheable: false, parallelSafe: false },
      durability: {
        journal: false,
        receipt: false,
        readback: "none",
        reconciliation: "none",
      },
      allowedPrincipals: ["single_agent"],
    },
    execute: async (args) => {
      executedCalls.push({ id: "github-publication-fixture", name: publicationToolName, arguments: args });
      return { status: "draft_pr_verified" };
    },
  };
  const registry = createDefaultToolRegistry({
    githubPublicationTool: publicationTool,
    optionalCapabilities: { code: false, integrations: true, companion: false },
    isOptionalCapabilityAvailable: (capability) => capability === "integrations",
    legacyCompatibility: { code: false, companion: false },
  });
  const vault = createRunnerVaultContext({ prompt });

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [
        () => responseWithContent("The draft pull request is ready."),
        () =>
          responseWithToolCall(publicationToolName, {
            action: "publish_draft",
            profileKey: "trusted-repository",
          }),
        () => responseWithContent("The verified commit was published as a draft pull request."),
      ],
    }),
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
  });

  const firstToolNames =
    chatRequests.find((request) => (request.tools?.length ?? 0) > 0)?.tools?.map(
      (tool) => tool.function.name,
    ) ?? [];
  assert.ok(firstToolNames.includes(publicationToolName));
  assert.match(
    chatRequests[1]?.messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: publish_verified_code_to_github/u,
  );
  assert.deepEqual(executedCalls.map((call) => call.name), [publicationToolName]);
});

test("ordinary GitHub read prompts do not expose the verified-code publication tool", async () => {
  const prompt = "Read the GitHub pull request status and summarize the checks without changing anything.";
  const chatRequests: ModelChatRequest[] = [];
  const publicationTool: AgentTool = {
    name: "publish_verified_code_to_github",
    description: "Test-only publication bridge.",
    parameters: { type: "object", additionalProperties: false },
    descriptor: {
      version: 1,
      name: "publish_verified_code_to_github",
      capability: { system: "github", resourceType: "pull_request", action: "publish" },
      effect: "publish",
      risk: "critical",
      approval: {
        allowPromptGrant: false,
        allowPersistentGrant: false,
        fallback: "exact",
      },
      execution: { preparation: "required", cacheable: false, parallelSafe: false },
      durability: {
        journal: true,
        receipt: true,
        readback: "required",
        reconciliation: "required",
      },
      allowedPrincipals: ["single_agent"],
      receiptKind: "external_action",
    },
    execute: async () => {
      assert.fail("ordinary GitHub reads must not execute the publication tool");
    },
  };
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.githubEnabled = true;
  const catalogReads: AgentTool[] = [
    githubRunnerFixtureTool("github_get_pull_request"),
    githubRunnerFixtureTool("github_list_check_runs"),
    githubRunnerFixtureTool("github_get_combined_status"),
    githubRunnerFixtureTool("github_get_issue"),
  ];

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("No GitHub mutation was requested.")],
    }),
    toolRegistry: createDefaultToolRegistry({
      githubPublicationTool: publicationTool,
      githubCatalogTools: catalogReads,
      optionalCapabilities: { code: false, integrations: true, companion: false },
      isOptionalCapabilityAvailable: (capability) => capability === "integrations",
      legacyCompatibility: { code: false, companion: false },
    }),
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 1,
  });

  const firstToolNames = [
    ...new Set(
      chatRequests.flatMap(
        (request) => request.tools?.map((tool) => tool.function.name) ?? [],
      ),
    ),
  ];
  assert.equal(firstToolNames.includes("publish_verified_code_to_github"), false);
  assert.deepEqual(
    firstToolNames.filter((name) => name.startsWith("github_")),
    [
      "github_get_pull_request",
      "github_list_check_runs",
      "github_get_combined_status",
    ],
    JSON.stringify(chatRequests.map((request) => request.tools?.map((tool) => tool.function.name) ?? [])),
  );
});

test("compound natural-language GitHub intent selects the exact catalog read without an internal tool name", async () => {
  const prompt = [
    "Research checkers from public web sources and accept the research note.",
    "Turn the accepted research into one Linear initiative, one project, and one issue.",
    "Implement and validate the issue, publish the result to GitHub, then read GitHub issue 12.",
    "Finish with a reflection in the current note.",
  ].join(" ");
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.githubEnabled = true;
  vault.context.settings.linearEnabled = true;

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [() => responseWithContent("The lifecycle is pending.")],
    }),
    toolRegistry: createDefaultToolRegistry({
      githubCatalogTools: [
        githubRunnerFixtureTool("github_get_issue"),
        githubRunnerFixtureTool("github_get_repository"),
      ],
      optionalCapabilities: { code: false, integrations: true, companion: false },
      isOptionalCapabilityAvailable: (capability) => capability === "integrations",
      legacyCompatibility: { code: false, companion: false },
    }),
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 1,
    events: {
      onRunConfig: (config) => configs.push(config),
    },
  });

  assert.equal(prompt.includes("github_get_issue"), false);
  assert.ok(
    configs[0]?.allowedToolNames.includes("github_get_issue"),
    `selected tools: ${configs[0]?.allowedToolNames.join(", ") ?? "none"}`,
  );
  assert.equal(configs[0]?.allowedToolNames.includes("github_get_repository"), false);
});

test("set-loose compound GitHub catalog mutation still binds explicit approval before execution", async () => {
  const prompt = [
    "Research checkers using public web sources.",
    "Then update GitHub issue 12 in repository profile trusted-repository with title Checkers implementation.",
    "Finish with a reflection in the current note.",
  ].join(" ");
  const fixedNow = new Date("2026-07-22T12:00:00.000Z");
  const vault = createRunnerVaultContext({ prompt, now: fixedNow });
  vault.context.settings.githubEnabled = true;
  vault.context.settings.autonomyProfile = "automatic";
  vault.context.settings.workingMode = "automatic";
  vault.context.settings.modelRouterMode = "off";
  const broker = new ApprovalBroker();
  const approvalRequests: ApprovalRequest[] = [];
  const statuses: string[] = [];
  const executedGrantIds: string[] = [];
  let preparedExecutions = 0;
  const descriptor: ToolDescriptor = {
    version: 1,
    name: "github_update_issue",
    capability: { system: "github", resourceType: "issue", action: "update" },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "exact",
    },
    execution: { preparation: "required", cacheable: false, parallelSafe: false },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["single_agent", "lead"],
    receiptKind: "external_action",
  };
  const tool: AgentTool = {
    name: descriptor.name,
    description: "Update one GitHub issue through exact prepared authority.",
    parameters: {
      type: "object",
      properties: {
        profileKey: { type: "string" },
        number: { type: "integer" },
        title: { type: "string" },
      },
      required: ["profileKey", "number", "title"],
      additionalProperties: false,
    },
    descriptor,
    execute: async () => assert.fail("prepared GitHub mutation must not use legacy execute"),
    prepare: async (args, context) => ({
      ok: true,
      action: await withPreparedActionFingerprint({
        version: 1,
        id: "github-update-issue-action-1",
        runId: context.runId!,
        toolCallId: "github-update-issue-call-1",
        toolName: descriptor.name,
        target: {
          system: "github",
          resourceType: "issue",
          id: "trusted-repository:12",
          identifier: "#12",
        },
        relatedResources: [],
        normalizedArgs: {
          profileKey: String(args.profileKey ?? ""),
          number: Number(args.number),
          title: String(args.title ?? ""),
        },
        preview: {
          summary: "Update GitHub issue #12 title",
          destination: "GitHub trusted-repository issue #12",
          outboundPayload: { title: String(args.title ?? "") },
          warnings: [],
          outboundBytes: 23,
        },
        idempotencyKey: `${context.runId}:github-update-issue-call-1`,
        preparedAt: "2026-07-22T12:00:00.000Z",
        expiresAt: "2026-07-22T12:05:00.000Z",
      }),
    }),
    executePrepared: async (action, context) => {
      preparedExecutions += 1;
      executedGrantIds.push(context.authorizedAction?.grantId ?? "");
      return {
        mutationState: "applied",
        output: { number: 12, title: "Checkers implementation" },
        receipt: {
          version: 1,
          id: "github-update-issue-receipt-1",
          runId: action.runId,
          actionId: action.id,
          toolName: action.toolName,
          operation: "update",
          resource: {
            system: "github",
            resourceType: "issue",
            id: "trusted-repository:12",
            identifier: "#12",
          },
          message: "Updated GitHub issue #12",
          payloadFingerprint: action.payloadFingerprint,
          grantId: context.authorizedAction!.grantId,
          idempotencyKey: action.idempotencyKey,
          startedAt: "2026-07-22T12:00:01.000Z",
          committedAt: "2026-07-22T12:00:03.000Z",
          commitKind: "committed",
          readback: {
            status: "verified",
            checkedAt: "2026-07-22T12:00:02.000Z",
            observedRevision: "issue-updated-at-1",
          },
          effects: { affectedCount: 1, changedFields: ["title"] },
        },
      };
    },
  };

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests: [],
      chatResponders: [
        () =>
          responseWithToolCall("github_update_issue", {
            profileKey: "trusted-repository",
            number: 12,
            title: "Checkers implementation",
          }),
        () => responseWithContent("Updated GitHub issue 12."),
      ],
    }),
    toolRegistry: new DefaultToolRegistry([tool]),
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 2,
    approvalBroker: broker,
    events: {
      onStatus: (message) => statuses.push(message),
      onApprovalRequest: (request) => {
        approvalRequests.push(request);
        broker.resolve(request.id, "approved");
      },
    },
  });

  assert.equal(preparedExecutions, 1);
  assert.equal(approvalRequests.length, 1);
  assert.match(executedGrantIds[0] ?? "", /^grant:approval-/u);
  assert.notEqual(executedGrantIds[0], "policy:scoped-read");
  assert.equal(
    statuses.some((message) =>
      /Set-loose Bound auto(?: grant)?; running tool: github_update_issue/u.test(
        message,
      ),
    ),
    false,
  );

  const blockedVault = createRunnerVaultContext({ prompt, now: fixedNow });
  blockedVault.context.settings.githubEnabled = true;
  blockedVault.context.settings.autonomyProfile = "automatic";
  blockedVault.context.settings.workingMode = "automatic";
  blockedVault.context.settings.modelRouterMode = "off";
  const blockedStatuses: string[] = [];
  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests: [],
      chatResponders: [
        () =>
          responseWithToolCall("github_update_issue", {
            profileKey: "trusted-repository",
            number: 12,
            title: "Checkers implementation",
          }),
      ],
    }),
    toolRegistry: new DefaultToolRegistry([tool]),
    toolContext: blockedVault.context,
    enableStreaming: false,
    maxSteps: 1,
    interactiveApprovals: false,
    events: {
      onStatus: (message) => blockedStatuses.push(message),
    },
  });

  assert.equal(
    preparedExecutions,
    1,
    "set-loose must not execute a GitHub catalog mutation without exact authority",
  );
  assert.equal(
    blockedStatuses.some((message) =>
      /Set-loose Bound auto(?: grant)?; running tool: github_update_issue/u.test(
        message,
      ),
    ),
    false,
  );
});

test("explicit GitHub issue mutation exposes and requires only the requested catalog mutation", async () => {
  const prompt = "Close GitHub issue 12 in repository profile trusted-repository.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const closeTool = githubRunnerFixtureTool("github_close_issue", executedCalls);
  const unrelatedTool = githubRunnerFixtureTool("github_create_issue", executedCalls);
  const readTool = githubRunnerFixtureTool("github_get_issue", executedCalls);
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.githubEnabled = true;

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [
        () => responseWithContent("The issue is closed."),
        () => responseWithToolCall("github_close_issue", {
          profileKey: "trusted-repository",
          number: 12,
        }),
        () => responseWithContent("Closed GitHub issue 12."),
      ],
    }),
    toolRegistry: createDefaultToolRegistry({
      githubCatalogTools: [closeTool, unrelatedTool, readTool],
      optionalCapabilities: { code: false, integrations: true, companion: false },
      isOptionalCapabilityAvailable: (capability) => capability === "integrations",
      legacyCompatibility: { code: false, companion: false },
    }),
    toolContext: vault.context,
    enableStreaming: false,
  });

  const firstToolNames = chatRequests[0]?.tools?.map((tool) => tool.function.name) ?? [];
  assert.deepEqual(firstToolNames.filter((name) => name.startsWith("github_")), ["github_close_issue"]);
  assert.match(
    chatRequests[1]?.messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: github_close_issue/u,
  );
  assert.deepEqual(executedCalls.map((call) => call.name), ["github_close_issue"]);
});

test("policy engine approval allows install_code_dependency with granted context", async () => {
  __setCodeToolsDesktopAppForTests(true);
  try {
    const chatRequests: ModelChatRequest[] = [];
    const executedCalls: ModelToolCall[] = [];
    const executedContexts: ToolExecutionContext[] = [];
    const statuses: string[] = [];
    const broker = new ApprovalBroker();
    let requestCheckpointPersisted = false;
    let resolutionCheckpointPersisted = false;
    const baseRegistry = createCodeToolsRegistry(executedCalls, executedContexts);
    const orderedRegistry: ToolRegistry = {
      getDefinitions: () => baseRegistry.getDefinitions(),
      execute: async (call, context) => {
        if (call.name === "install_code_dependency") {
          assert.equal(requestCheckpointPersisted, true);
          assert.equal(resolutionCheckpointPersisted, true);
        }
        return baseRegistry.execute(call, context);
      },
    };

    const client = createClient({
      chatRequests,
      chatResponders: [
        () =>
          responseWithToolCall("install_code_dependency", {
            manager: "pip",
            packageName: "requests",
          }),
        () =>
          responseWithToolCall("run_code_block", {
            language: "python",
            code: "print('ok')",
          }),
        () => responseWithContent("Installed requests and ran the snippet."),
        () => responseWithContent("Installed requests and ran the snippet."),
      ],
    });

    await runAgentMission({
      prompt: "Run the python code snippet after installing the requests package.",
      modelClient: client,
      toolRegistry: orderedRegistry,
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
      approvalBroker: broker,
      events: {
        onStatus: (message) => statuses.push(message),
        onApprovalRequest: async (request) => {
          await Promise.resolve();
          requestCheckpointPersisted = true;
          broker.resolve(request.id, "approved");
        },
        onApprovalResolved: async () => {
          assert.equal(requestCheckpointPersisted, true);
          await Promise.resolve();
          resolutionCheckpointPersisted = true;
        },
      },
    });

    const installIndex = executedCalls.findIndex(
      (call) => call.name === "install_code_dependency",
    );
    assert.ok(
      installIndex >= 0,
      `approved install must execute; offered=${chatRequests[0]?.tools?.map((tool) => tool.function.name).join(",") ?? "none"}; ${statuses.join(" | ")}`,
    );
    assert.equal(
      executedContexts[installIndex]?.userApprovalGranted,
      true,
      "approved install runs with approval-granted context",
    );
    assert.ok(executedCalls.some((call) => call.name === "run_code_block"));
  } finally {
    __setCodeToolsDesktopAppForTests(null);
  }
});

test("required prepared actions bind double approval before one external execution", async () => {
  const prompt = "Create a Linear issue titled Research follow-up.";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-11T12:00:00.000Z"),
  });
  vault.context.settings.linearEnabled = true;
  const broker = new ApprovalBroker();
  const approvalRequests: ApprovalRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  let prepareCalls = 0;
  let legacyExecutions = 0;
  let preparedExecutions = 0;
  const descriptor: ToolDescriptor = {
    version: 1,
    name: "linear_create_issue",
    capability: { system: "linear", resourceType: "issue", action: "create" },
    effect: "reversible_mutation",
    risk: "high",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "double_exact",
    },
    execution: {
      preparation: "required",
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["single_agent", "lead"],
    receiptKind: "external_action",
  };
  const tool: AgentTool = {
    name: descriptor.name,
    description: "Create one Linear issue.",
    parameters: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    descriptor,
    execute: async () => {
      legacyExecutions += 1;
      return { bypassed: true };
    },
    prepare: async (args, context) => {
      prepareCalls += 1;
      return {
        ok: true,
        action: await withPreparedActionFingerprint({
          version: 1,
          id: "linear-action-1",
          runId: context.runId!,
          toolCallId: "linear-call-1",
          toolName: descriptor.name,
          target: {
            system: "linear",
            resourceType: "issue",
            id: "new:linear-call-1",
            teamId: "team-1",
          },
          relatedResources: [],
          normalizedArgs: { title: String(args.title ?? "") },
          preview: {
            summary: "Create Linear issue Research follow-up",
            destination: "Linear team team-1",
            outboundPayload: { title: String(args.title ?? "") },
            warnings: [],
            outboundBytes: 18,
          },
          idempotencyKey: `${context.runId}:linear-call-1`,
          preparedAt: "2026-07-11T12:00:00.000Z",
          expiresAt: "2026-07-11T12:05:00.000Z",
        }),
      };
    },
    executePrepared: async (action, context) => {
      preparedExecutions += 1;
      const authorized = context.authorizedAction!;
      return {
        mutationState: "applied",
        output: { identifier: "RES-123" },
        receipt: {
          version: 1,
          id: "linear-receipt-1",
          runId: action.runId,
          actionId: action.id,
          toolName: action.toolName,
          operation: "create",
          resource: {
            system: "linear",
            resourceType: "issue",
            id: "issue-123",
            identifier: "RES-123",
            teamId: "team-1",
          },
          message: "Created Linear issue RES-123",
          payloadFingerprint: action.payloadFingerprint,
          grantId: authorized.grantId,
          idempotencyKey: action.idempotencyKey,
          startedAt: "2026-07-11T12:00:01.000Z",
          committedAt: "2026-07-11T12:00:03.000Z",
          commitKind: "committed",
          readback: {
            status: "verified",
            checkedAt: "2026-07-11T12:00:02.000Z",
            observedRevision: "updated-at-1",
          },
          effects: { affectedCount: 1, changedFields: ["title"] },
        },
      };
    },
  };
  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () =>
        responseWithToolCall("linear_create_issue", {
          title: "Research follow-up",
        }),
      () => responseWithContent("Created Linear issue RES-123."),
      () => responseWithContent("Created Linear issue RES-123."),
    ],
  });

  await runAgentMission({
    prompt,
    runId: "prepared-linear-run",
    modelClient: client,
    toolRegistry: new DefaultToolRegistry([tool]),
    toolContext: vault.context,
    enableStreaming: false,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        approvalRequests.push(request);
        broker.resolve(request.id, "approved");
      },
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.equal(prepareCalls, 1);
  assert.equal(legacyExecutions, 0);
  assert.equal(preparedExecutions, 1);
  assert.deepEqual(
    approvalRequests.map((request) => request.confirmationIndex),
    [1, 2],
  );
  assert.ok(
    approvalRequests.every(
      (request) =>
        request.requiredConfirmations === 2 &&
        request.payloadFingerprint ===
          approvalRequests[0].payloadFingerprint &&
        request.preparedAction?.id === "linear-action-1",
    ),
  );
  assert.equal(receipts[0]?.resource?.system, "linear");
  assert.equal(receipts[0]?.path, undefined);
  assert.equal(receipts[0]?.runId, "prepared-linear-run");
  assert.match(receipts[0]?.grantId ?? "", /^grant:approval-/);
  const graphMarkdown = [...vault.content.entries()].find(([path]) =>
    path.startsWith("Agent Runs/Mission Graphs/"),
  )?.[1];
  assert.ok(graphMarkdown, "canonical mission graph should be persisted");
  const graphRecord = await parseMissionGraphStoreRecordFromMarkdown(graphMarkdown);
  assert.ok(graphRecord);
  const completedMutationNode = Object.values(graphRecord.graph.nodes).find(
    (node) => node.allowedTools.includes("linear_create_issue"),
  );
  assert.ok(completedMutationNode);
  assert.equal(completedMutationNode.status, "complete");
  assert.deepEqual(
    completedMutationNode.receipts.map((receipt) => receipt.id),
    ["linear-receipt-1"],
    "the completed mutation node must retain the exact canonical action receipt id",
  );
  const graphStatusOperations = graphRecord.journal.flatMap(
    (entry) => entry.patch.operations,
  );
  assert.equal(
    graphStatusOperations.filter(
      (operation) =>
        operation.op === "set_status" &&
        operation.status === "waiting_approval",
    ).length,
    2,
    "each exact confirmation must be persisted before its approval UI opens",
  );
  assert.equal(
    graphStatusOperations.filter(
      (operation) =>
        operation.op === "set_status" &&
        operation.expectedStatus === "waiting_approval" &&
        operation.status === "running",
    ).length,
    2,
    "approved confirmations must durably resume the same prepared execution",
  );
  const runtimeSnapshot = [...vault.content.values()]
    .map((markdown) => parseMissionRuntimeSnapshotFromMarkdown(markdown))
    .find((snapshot) => snapshot?.operationJournal.some(
      (record) => record.toolName === "linear_create_issue",
    ));
  const actionRecord = runtimeSnapshot?.operationJournal.find(
    (record) => record.toolName === "linear_create_issue",
  );
  assert.equal(actionRecord?.version, 2);
  assert.equal(actionRecord?.state, "committed");
  assert.equal(
    actionRecord?.preparedAction?.payloadFingerprint,
    approvalRequests[0].payloadFingerprint,
  );
  assert.match(actionRecord?.authorization?.grantId ?? "", /^grant:approval-/);
  assert.equal(actionRecord?.receipt?.resource?.system, "linear");
});

test("background Linear submission short-circuits foreground prepared execution", async () => {
  const prompt =
    "Continue in the background while Obsidian is closed: update Linear issue issue-42 to state state-done.";
  const runId = "background-linear-short-circuit-1";
  const now = new Date("2026-07-13T12:00:00.000Z");
  const vault = createRunnerVaultContext({ prompt, now });
  vault.context.settings.linearEnabled = true;
  vault.context.settings.modelRouterMode = "off";
  const descriptor: ToolDescriptor = {
    version: 1,
    name: "linear_update_issue",
    capability: { system: "linear", resourceType: "issue", action: "update" },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "exact",
    },
    execution: {
      preparation: "required",
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["single_agent", "lead", "researcher"],
    receiptKind: "external_action",
  };
  let legacyExecutions = 0;
  let preparedExecutions = 0;
  let submissions = 0;
  let beforeSubmitCalls = 0;
  const submittedJobs: string[] = [];
  const tool: AgentTool = {
    name: descriptor.name,
    description: "Update one exact Linear issue.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        stateId: { type: "string" },
      },
      required: ["id", "stateId"],
      additionalProperties: false,
    },
    descriptor,
    execute: async () => {
      legacyExecutions += 1;
      return { bypassed: true };
    },
    prepare: async (_args, context) => ({
      ok: true,
      action: await withPreparedActionFingerprint({
        version: 1,
        id: "linear-action-background-42",
        runId: context.runId!,
        toolCallId: "linear-call-background-42",
        toolName: descriptor.name,
        target: {
          system: "linear",
          resourceType: "issue",
          id: "issue-42",
          identifier: "PLAT-42",
          teamId: "team-platform",
          projectId: "project-platform",
        },
        relatedResources: [
          { system: "linear", resourceType: "state", id: "state-done" },
        ],
        normalizedArgs: {
          operationKey: "issues.update",
          readbackOperationKey: "issues.get",
          mutationKind: "issue_update",
          variables: { id: "issue-42", input: { stateId: "state-done" } },
          preconditionHash: `sha256:${"a".repeat(64)}`,
          expectedAbsent: false,
          changedFields: ["stateId"],
        },
        preview: {
          summary: "Move PLAT-42 to Done",
          destination: "Linear issue PLAT-42",
          before: { stateId: "state-started" },
          after: { stateId: "state-done" },
          outboundPayload: {
            id: "issue-42",
            input: { stateId: "state-done" },
          },
          warnings: [],
          outboundBytes: 58,
        },
        expectedTargetRevision: `sha256:${"a".repeat(64)}`,
        idempotencyKey: `${context.runId}:linear-state-update:issue-42`,
        reconciliationKey: `${context.runId}:linear-state-update:issue-42`,
        preparedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      }),
    }),
    executePrepared: async () => {
      preparedExecutions += 1;
      throw new Error("Foreground executePrepared must be short-circuited.");
    },
  };
  const backgroundContinuation: BackgroundMissionDispatchPortV1 = {
    readCapabilities: async () => ({
      configured: true,
      backgroundEnabled: true,
      installedDomains: ["linear"],
      blocker: null,
    }),
    resolveCredentialReferenceId: async () => "credential_linear1234",
    submitAuthorizedNode: async (input) => {
      submissions += 1;
      const prepared = await prepareCompanionJobV1({
        graph: input.graph,
        nodeId: input.nodeId,
        authorization: input.authorization,
        preparedExternalActionHandoff: input.preparedExternalActionHandoff,
        now: input.now,
      });
      assert.equal(prepared.status, "ready");
      if (prepared.status !== "ready") throw new Error("Job preparation failed.");
      await input.beforeSubmit?.(prepared.job);
      beforeSubmitCalls += 1;
      submittedJobs.push(prepared.job.id);
      return {
        status: "submitted",
        job: {
          id: prepared.job.id,
          missionId: prepared.job.missionId,
          nodeId: prepared.job.nodeId,
          executionHost: prepared.job.domain,
          state: "queued",
          payload: {
            version: prepared.job.version,
            graphRevision: prepared.job.graphRevision,
            executionHost: prepared.job.executionHost,
            objective: prepared.job.objective,
            inputs: prepared.job.inputs,
            allowedTools: prepared.job.allowedTools,
            requiredCapabilities: prepared.job.requiredCapabilities,
            bindings: prepared.job.bindings,
            authorization: prepared.job.authorization,
            preparedExternalActionHandoff:
              prepared.job.preparedExternalActionHandoff ?? null,
            createdAt: prepared.job.createdAt,
            updatedAt: prepared.job.updatedAt,
          } as never,
          capabilityEnvelope: {
            fingerprint: prepared.job.capabilityEnvelopeFingerprint,
            authorizationFingerprint: prepared.job.authorization.fingerprint,
          },
          idempotencyKey: prepared.job.idempotencyKey,
          ownerCoordinatorId: null,
          leaseExpiresAt: null,
          attempts: 0,
          createdAt: prepared.job.createdAt,
          updatedAt: prepared.job.updatedAt,
        },
      };
    },
  };
  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () =>
        responseWithToolCall(descriptor.name, {
          id: "issue-42",
          stateId: "state-done",
        }),
      () => responseWithContent("The approved background update is pending readback."),
      () => responseWithContent("The approved background update is pending readback."),
    ],
  });
  const broker = new ApprovalBroker();
  const statuses: string[] = [];
  let approvalRequests = 0;

  await runAgentMission({
    prompt,
    runId,
    modelClient: client,
    toolRegistry: new DefaultToolRegistry([tool]),
    toolContext: vault.context,
    enableStreaming: false,
    approvalBroker: broker,
    backgroundContinuation,
    maxSteps: 2,
    events: {
      onStatus: (message) => statuses.push(message),
      onApprovalRequest: (request) => {
        approvalRequests += 1;
        broker.resolve(request.id, "approved");
      },
    },
  });

  assert.equal(approvalRequests, 1, statuses.join(" | "));
  assert.equal(submissions, 1);
  assert.equal(beforeSubmitCalls, 1);
  assert.equal(submittedJobs.length, 1);
  assert.equal(legacyExecutions, 0);
  assert.equal(
    preparedExecutions,
    0,
    "companion submission must short-circuit the foreground executePrepared path",
  );
  assert.equal(
    statuses.some((message) => /mutation tool failed/iu.test(message)),
    false,
    statuses.join(" | "),
  );
  assert.equal(
    statuses.some((message) => /reconciliation is pending/iu.test(message)),
    true,
    statuses.join(" | "),
  );

  const runtimeSnapshot = [...vault.content.values()]
    .map((markdown) => parseMissionRuntimeSnapshotFromMarkdown(markdown))
    .find((snapshot) =>
      snapshot?.operationJournal.some(
        (record) => record.toolName === descriptor.name,
      ),
    );
  const journal = runtimeSnapshot?.operationJournal.find(
    (record) => record.toolName === descriptor.name,
  );
  assert.ok(journal);
  assert.equal(journal.state, "applying");
  assert.equal(journal.mutationMayHaveApplied, true);
  assert.equal(journal.externalActionDispatchAttempt?.status, "job_submitted");
  assert.equal(journal.externalActionDispatchAttempt?.jobId, submittedJobs[0]);
  assert.equal(
    journal.transitions.some(
      (transition) =>
        transition.state === "failed" || transition.state === "reconcile_required",
    ),
    false,
  );
  assert.equal(
    buildOperationReconciliationInputs([journal])[0]?.recommendedAction,
    "provider_reconcile",
  );

  const graphMarkdown = [...vault.content.entries()].find(([path]) =>
    path.startsWith("Agent Runs/Mission Graphs/"),
  )?.[1];
  assert.ok(graphMarkdown);
  const graphRecord = await parseMissionGraphStoreRecordFromMarkdown(graphMarkdown);
  const graphNode = Object.values(graphRecord?.graph.nodes ?? {}).find(
    (node) => node.allowedTools.includes(descriptor.name),
  );
  assert.ok(graphNode);
  assert.equal(graphNode.executionHost, "headless_runtime");
  assert.equal(graphNode.effect, "external_action");
  assert.equal(graphNode.status, "running");
});

test("background Code sealing journals the exact package before POST and never executes in foreground", async (t) => {
  __setCodeToolsDesktopAppForTests(true);
  t.after(() => __setCodeToolsDesktopAppForTests(null));
  const prompt =
    "Invoke only code_validate_commit_prepared for repairCheckpointId code-checkpoint-1 and continue this exact prepared Code validation and local commit in the background while Obsidian is closed.";
  const runId = "background-code-production-dispatch-1";
  const now = new Date("2026-07-13T12:00:00.000Z");
  const vault = createRunnerVaultContext({ prompt, now });
  vault.context.settings.modelRouterMode = "off";
  const descriptor = backgroundCodeValidationDescriptor();
  let foregroundExecutions = 0;
  let sealCalls = 0;
  let postCalls = 0;
  let approvalRequests = 0;
  const submittedJobs: string[] = [];
  const tool: AgentTool = {
    name: descriptor.name,
    description: "Seal one trusted prepared Code validation and commit package.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    descriptor,
    execute: async () => {
      foregroundExecutions += 1;
      throw new Error("Legacy foreground execution must not run.");
    },
    prepare: async (_args, context) => ({
      ok: true,
      action: await withPreparedActionFingerprint({
        version: 1,
        id: "prepared-background-code-production-1",
        runId: context.runId!,
        toolCallId: "background-code-call-1",
        toolName: descriptor.name,
        target: {
          system: "git",
          resourceType: "prepared_validation_commit",
          id: "workspace-background-code-production-1",
          workspaceId: "workspace-background-code-production-1",
          repositoryProfileId: "profile-1",
        },
        relatedResources: [],
        normalizedArgs: {
          repairCheckpointId: "code-checkpoint-1",
          diffFingerprint: testFingerprint("1"),
          fastValidationFingerprint: testFingerprint("2"),
        },
        preview: {
          summary: "Validate the exact approved diff and create one local commit",
          destination: "Trusted Code workspace",
          before: { baseSha: "a".repeat(40) },
          after: { diffFingerprint: testFingerprint("1") },
          warnings: ["Sandbox-only execution."],
          outboundBytes: 0,
        },
        idempotencyKey: `${context.runId}:background-code:checkpoint-1`,
        reconciliationKey: `${context.runId}:background-code:checkpoint-1`,
        preparedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      }),
    }),
    executePrepared: async () => {
      foregroundExecutions += 1;
      throw new Error("Foreground executePrepared must be short-circuited.");
    },
  };
  const backgroundContinuation: BackgroundMissionDispatchPortV1 = {
    readCapabilities: async () => ({
      configured: true,
      backgroundEnabled: true,
      installedDomains: ["code"],
      blocker: null,
    }),
    resolveMissionBindingOverrides: async (input) => {
      assert.equal(input.objective, prompt);
      assert.equal(input.toolNames.includes(descriptor.name), true);
      return {
        [descriptor.name]: {
          id: "workspace-background-code-production-1",
          kind: "prepared_validation_commit",
          destinationFingerprint: testFingerprint("5"),
          allowedEffects: ["read", "execution"],
        },
      };
    },
    sealBackgroundValidationCommitPackage: async (input) => {
      sealCalls += 1;
      assert.equal(input.preparedAction.toolName, descriptor.name);
      assert.equal(
        input.authority.actionFingerprint,
        input.preparedAction.payloadFingerprint,
      );
      const node = input.graph.nodes[
        Object.keys(input.graph.nodes).find(
          (id) => input.graph.nodes[id].allowedTools[0] === descriptor.name,
        )!
      ];
      assert.equal(node.status, "running");
      const binding = input.graph.capabilityEnvelope.bindings[
        node.destination!.bindingId
      ];
      assert.equal(binding.id, "workspace-background-code-production-1");
      assert.equal(binding.destinationFingerprint, testFingerprint("5"));
      const preparedAt = input.authority.consumedAt;
      const handoff = createPreparedBackgroundCodeActionV1({
        id: "background-code-handoff-production-1",
        missionId: input.graph.missionId,
        graphRevision: input.graph.revision,
        capabilityEnvelopeFingerprint:
          input.graph.capabilityEnvelope.fingerprint,
        nodeId: node.id,
        nodeFingerprint: testFingerprint("3"),
        executionHost: "headless_runtime",
        descriptorFingerprint: await sha256Fingerprint(descriptor),
        preparedActionId: input.preparedAction.id,
        preparedActionFingerprint: input.preparedAction.payloadFingerprint,
        binding: {
          workspaceId: binding.id,
          repositoryProfileKey: "profile-1",
          destinationFingerprint: binding.destinationFingerprint,
        },
        authority: input.authority,
        payload: {
          repairCheckpointId: "code-checkpoint-1",
          repairRequestFingerprint: testFingerprint("4"),
          preparedCheckpointSequence: 5,
          workspaceBindingFingerprint: testFingerprint("5"),
          repositoryProfileFingerprint: testFingerprint("6"),
          sandboxCapabilityFingerprint: testFingerprint("7"),
        },
        idempotencyKey: `${runId}:background-code:checkpoint-1`,
        reconciliationKey: `${runId}:background-code:checkpoint-1`,
        preparedAt,
        expiresAt: input.authority.expiresAt,
      });
      const packageIdentity = createPreparedBackgroundCodePackageIdentityV1({
        packageId: "background-code-package-production-1",
        packageFingerprint: testFingerprint("8"),
        executionPlanFingerprint: testFingerprint("9"),
        handoffFingerprint: handoff.fingerprint,
        workspaceId: handoff.binding.workspaceId,
        workspaceBindingFingerprint:
          handoff.payload.workspaceBindingFingerprint,
        repositoryProfileKey: handoff.binding.repositoryProfileKey,
        repositoryProfileFingerprint:
          handoff.payload.repositoryProfileFingerprint,
        consumedActionAuthorityFingerprint:
          handoff.authority.authorityFingerprint,
        backgroundAuthorizationFingerprint: input.authorization.fingerprint,
        preparedAt: handoff.preparedAt,
        expiresAt: handoff.expiresAt,
      });
      return {
        status: "ready",
        handoff,
        packageIdentity,
        packagePersistenceReceipt: {
          fingerprint: testFingerprint("a"),
          readbackVerified: true,
        },
      };
    },
    submitAuthorizedNode: async (input) => {
      const prepared = await prepareCompanionJobV1(input);
      assert.equal(prepared.status, "ready");
      if (prepared.status !== "ready") throw new Error("Expected Code job.");
      await input.beforeSubmit?.(prepared.job);
      const snapshotBeforePost = [...vault.content.values()]
        .map((markdown) => parseMissionRuntimeSnapshotFromMarkdown(markdown))
        .find((snapshot) => snapshot?.operationJournal.some(
          (record) => record.toolName === descriptor.name,
        ));
      const wal = snapshotBeforePost?.operationJournal.find(
        (record) => record.toolName === descriptor.name,
      );
      assert.equal(wal?.state, "applying");
      assert.equal(wal?.mutationMayHaveApplied, false);
      assert.equal(
        wal?.preparedBackgroundCodeAction?.fingerprint,
        prepared.job.preparedBackgroundCodeAction?.fingerprint,
      );
      assert.equal(
        wal?.preparedBackgroundCodePackage?.fingerprint,
        prepared.job.preparedBackgroundCodePackage?.fingerprint,
      );
      assert.equal(wal?.backgroundCodeDispatchAttempt?.jobId, prepared.job.id);
      assert.equal(wal?.backgroundCodeDispatchAttempt?.status, "prepared");
      postCalls += 1;
      submittedJobs.push(prepared.job.id);
      return {
        status: "submitted",
        job: companionRemoteJobFromPrepared(prepared.job),
      };
    },
  };
  const broker = new ApprovalBroker();
  const statuses: string[] = [];
  await runAgentMission({
    prompt,
    runId,
    modelClient: createClient({
      chatRequests: [],
      chatResponders: [
        () => responseWithToolCall(descriptor.name, {}),
        () => responseWithContent("The prepared Code package is pending verified readback."),
      ],
    }),
    toolRegistry: new DefaultToolRegistry([tool]),
    toolContext: vault.context,
    enableStreaming: false,
    approvalBroker: broker,
    backgroundContinuation,
    maxSteps: 2,
    events: {
      onStatus: (message) => statuses.push(message),
      onApprovalRequest: (request) => {
        approvalRequests += 1;
        broker.resolve(request.id, "approved");
      },
    },
  });

  assert.equal(approvalRequests, 1, statuses.join(" | "));
  assert.equal(sealCalls, 1);
  assert.equal(postCalls, 1);
  assert.equal(foregroundExecutions, 0);
  assert.equal(submittedJobs.length, 1);
  assert.equal(
    statuses.some((message) => /Background code job submitted/iu.test(message)),
    true,
    statuses.join(" | "),
  );
  const committedWal = [...vault.content.values()]
    .map((markdown) => parseMissionRuntimeSnapshotFromMarkdown(markdown))
    .find((snapshot) => snapshot?.operationJournal.some(
      (record) => record.toolName === descriptor.name,
    ))?.operationJournal.find((record) => record.toolName === descriptor.name);
  assert.equal(committedWal?.backgroundCodeDispatchAttempt?.status, "job_submitted");
  assert.equal(committedWal?.mutationMayHaveApplied, true);
  assert.equal(
    buildOperationReconciliationInputs([committedWal!])[0]?.recommendedAction,
    "provider_reconcile",
  );

  await runAgentMission({
    prompt: `continue run ${runId} and continue the exact background Code validation commit`,
    modelClient: createClient({
      chatRequests: [],
      chatResponders: [
        () => responseWithToolCall(descriptor.name, {}),
        () => responseWithContent("The existing Code job is still pending readback."),
      ],
    }),
    toolRegistry: new DefaultToolRegistry([tool]),
    toolContext: vault.context,
    enableStreaming: false,
    approvalBroker: broker,
    backgroundContinuation,
    maxSteps: 2,
  });
  assert.equal(postCalls, 1, "restart must not submit a second companion job");
  assert.equal(sealCalls, 1, "restart must not reseal an already-running node");
});

test("background Code unbound, denial, and package blocker paths fail closed before companion submission", async (t) => {
  __setCodeToolsDesktopAppForTests(true);
  t.after(() => __setCodeToolsDesktopAppForTests(null));
  for (const outcome of ["unbound", "denied", "blocked"] as const) {
    const prompt = `Continue the exact prepared Code validation commit in the background (${outcome}).`;
    const runId = `background-code-${outcome}-1`;
    const now = new Date("2026-07-13T13:00:00.000Z");
    const vault = createRunnerVaultContext({ prompt, now });
    vault.context.settings.modelRouterMode = "off";
    const descriptor = backgroundCodeValidationDescriptor();
    let sealCalls = 0;
    let submitCalls = 0;
    let foregroundExecutions = 0;
    let approvalRequests = 0;
    const toolErrorCodes: string[] = [];
    const tool: AgentTool = {
      name: descriptor.name,
      description: "Seal one trusted prepared Code validation and commit package.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      descriptor,
      execute: async () => {
        foregroundExecutions += 1;
        return {};
      },
      prepare: async (_args, context) => ({
        ok: true,
        action: await withPreparedActionFingerprint({
          version: 1,
          id: `prepared-code-${outcome}`,
          runId: context.runId!,
          toolCallId: `call-code-${outcome}`,
          toolName: descriptor.name,
          target: {
            system: "git",
            resourceType: "prepared_validation_commit",
            id: `checkpoint-${outcome}`,
            workspaceId: "binding-git-prepared-validation-commit",
          },
          relatedResources: [],
          normalizedArgs: { checkpointId: `checkpoint-${outcome}` },
          preview: {
            summary: `Validate exact diff for ${outcome}`,
            destination: "Trusted Code workspace",
            warnings: [],
            outboundBytes: 0,
          },
          idempotencyKey: `${runId}:code`,
          reconciliationKey: `${runId}:code`,
          preparedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
        }),
      }),
      executePrepared: async () => {
        foregroundExecutions += 1;
        throw new Error("Foreground Code execution must remain unreachable.");
      },
    };
    const backgroundContinuation: BackgroundMissionDispatchPortV1 = {
      readCapabilities: async () => ({
        configured: true,
        backgroundEnabled: true,
        installedDomains: ["code"],
        blocker: null,
      }),
      resolveMissionBindingOverrides: async () => outcome === "unbound"
        ? {}
        : {
            [descriptor.name]: {
              id: "binding-git-prepared-validation-commit",
              kind: "prepared_validation_commit",
              destinationFingerprint: testFingerprint("5"),
              allowedEffects: ["read", "execution"],
            },
          },
      sealBackgroundValidationCommitPackage: async () => {
        sealCalls += 1;
        return {
          status: "blocked",
          code: "background_code_package_resolution_not_wired",
          message: "Trusted Code package resolution is not wired.",
          requiredAction: "Complete the commit in foreground.",
        };
      },
      submitAuthorizedNode: async () => {
        submitCalls += 1;
        throw new Error("Blocked or denied Code work must never submit.");
      },
    };
    const broker = new ApprovalBroker();
    await runAgentMission({
      prompt,
      runId,
      modelClient: createClient({
        chatRequests: [],
        chatResponders: [
          () => responseWithToolCall(descriptor.name, {}),
          () => responseWithContent("The Code action remains blocked."),
        ],
      }),
      toolRegistry: new DefaultToolRegistry([tool]),
      toolContext: vault.context,
      enableStreaming: false,
      approvalBroker: broker,
      backgroundContinuation,
      maxSteps: 2,
      events: {
        onApprovalRequest: (request) => {
          approvalRequests += 1;
          broker.resolve(
            request.id,
            outcome === "denied" ? "denied" : "approved",
          );
        },
        onToolDone: (event) => {
          if (event.error?.code) toolErrorCodes.push(event.error.code);
        },
      },
    });
    assert.equal(submitCalls, 0, `${outcome} must not submit`);
    assert.equal(foregroundExecutions, 0);
    assert.equal(sealCalls, outcome === "blocked" ? 1 : 0);
    assert.equal(approvalRequests, outcome === "unbound" ? 0 : 1);
    if (outcome === "unbound") {
      assert.equal(
        toolErrorCodes.includes("background_code_trusted_binding_required"),
        true,
      );
    }
    const wal = [...vault.content.values()]
      .map((markdown) => parseMissionRuntimeSnapshotFromMarkdown(markdown))
      .find((snapshot) => snapshot?.operationJournal.some(
        (record) => record.toolName === descriptor.name,
      ))?.operationJournal.find((record) => record.toolName === descriptor.name);
    if (outcome === "blocked") {
      assert.equal(wal?.state, "failed");
      assert.equal(wal?.mutationMayHaveApplied, false);
      assert.equal(wal?.backgroundCodeDispatchAttempt, undefined);
    } else {
      assert.equal(
        wal,
        undefined,
        `${outcome} occurs before mutation WAL execution starts`,
      );
    }
  }
});

test("local reversible prepared actions mint a one-shot write-autonomy grant", async () => {
  const prompt =
    "Create the trusted repository workspace with code_workspace_create.";
  const now = new Date("2026-07-22T12:00:00.000Z");
  const vault = createRunnerVaultContext({ prompt, now });
  vault.context.settings.autonomyProfile = "automatic";
  vault.context.settings.workingMode = "automatic";
  vault.context.settings.modelRouterMode = "off";
  const descriptor: ToolDescriptor = {
    version: 1,
    name: "code_workspace_create",
    capability: {
      system: "workspace",
      resourceType: "code_workspace",
      action: "create",
    },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "exact",
    },
    execution: {
      preparation: "required",
      desktopOnly: true,
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["single_agent"],
    receiptKind: "code_change",
  };
  const executedGrantIds: string[] = [];
  let approvalRequests = 0;
  const tool: AgentTool = {
    name: descriptor.name,
    description: "Create one exact trusted repository workspace.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    descriptor,
    execute: async () => assert.fail("prepared mutation must not use legacy execute"),
    prepare: async (_args, context) => ({
      ok: true,
      action: await withPreparedActionFingerprint({
        version: 1,
        id: "write-autonomy-workspace-action",
        runId: context.runId!,
        toolCallId: "write-autonomy-workspace-call",
        toolName: descriptor.name,
        target: {
          system: "workspace",
          resourceType: "code_workspace",
          id: "workspace-automatic",
          workspaceId: "workspace-automatic",
          repositoryProfileId: "repository-automatic",
        },
        relatedResources: [],
        normalizedArgs: {
          workspaceId: "workspace-automatic",
          profileKey: "repository-automatic",
        },
        preview: {
          summary: "Create exact automatic workspace.",
          destination: "workspace-automatic",
          warnings: [],
          outboundBytes: 0,
        },
        idempotencyKey: "write-autonomy-workspace-action",
        preparedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      }),
    }),
    executePrepared: async (action, context) => {
      const grantId = context.authorizedAction?.grantId ?? "";
      executedGrantIds.push(grantId);
      return {
        mutationState: "applied",
        output: { workspaceId: "workspace-automatic" },
        receipt: {
          version: 1,
          id: "write-autonomy-workspace-receipt",
          runId: action.runId,
          actionId: action.id,
          toolName: action.toolName,
          operation: "create",
          resource: action.target,
          message: "Created exact automatic workspace.",
          payloadFingerprint: action.payloadFingerprint,
          grantId,
          idempotencyKey: action.idempotencyKey,
          startedAt: now.toISOString(),
          committedAt: new Date(now.getTime() + 1_000).toISOString(),
          commitKind: "committed",
          readback: {
            status: "verified",
            checkedAt: new Date(now.getTime() + 1_000).toISOString(),
          },
          effects: { affectedCount: 1 },
        },
      };
    },
  };
  const statuses: string[] = [];

  __setCodeToolsDesktopAppForTests(true);
  try {
    await runAgentMission({
      prompt,
      runId: "write-autonomy-workspace-run",
      modelClient: createClient({
        chatRequests: [],
        chatResponders: [
          () => responseWithToolCall(descriptor.name, {}),
          () => responseWithContent("Created the trusted repository workspace."),
        ],
      }),
      toolRegistry: new DefaultToolRegistry([tool]),
      toolContext: vault.context,
      enableStreaming: false,
      maxSteps: 2,
      interactiveApprovals: false,
      events: {
        onStatus: (message) => statuses.push(message),
        onApprovalRequest: () => {
          approvalRequests += 1;
        },
      },
    });
  } finally {
    __setCodeToolsDesktopAppForTests(null);
  }

  assert.equal(executedGrantIds.length, 1, statuses.join(" | "));
  assert.match(
    executedGrantIds[0] ?? "",
    /^grant:write-autonomy:write-autonomy-workspace-action$/u,
  );
  assert.notEqual(executedGrantIds[0], "policy:scoped-read");
  assert.equal(approvalRequests, 0);
  assert.ok(
    statuses.includes(
      "Write-autonomy one-shot grant; running tool: code_workspace_create",
    ),
  );
});

test("prepared actions consume a persisted schedule grant without opening interactive approval", async () => {
  const prompt = "Create the trusted repository workspace for this approved queue task.";
  const now = new Date("2026-07-11T12:00:00.000Z");
  const vault = createRunnerVaultContext({ prompt, now });
  const subject = { type: "schedule" as const, id: "linear-queue-project:project-1" };
  const descriptor: ToolDescriptor = {
    version: 1,
    name: "code_workspace_create",
    capability: { system: "workspace", resourceType: "code_workspace", action: "create" },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "exact",
    },
    execution: {
      preparation: "required",
      desktopOnly: true,
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["single_agent"],
    receiptKind: "code_change",
  };
  let preparedExecutions = 0;
  let approvalRequests = 0;
  let consumedActions = 0;
  const statuses: string[] = [];
  const tool: AgentTool = {
    name: descriptor.name,
    description: "Create one trusted repository workspace.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    descriptor,
    execute: async () => ({ status: "blocked" }),
    prepare: async (_args, context) => ({
      ok: true,
      action: await withPreparedActionFingerprint({
        version: 1,
        id: "queue-workspace-action",
        runId: context.runId!,
        toolCallId: "queue-workspace-call",
        toolName: descriptor.name,
        target: {
          system: "workspace",
          resourceType: "code_workspace",
          id: "workspace-1",
          workspaceId: "workspace-1",
          repositoryProfileId: "repository-1",
        },
        relatedResources: [],
        normalizedArgs: { workspaceId: "workspace-1", profileKey: "repository-1" },
        preview: {
          summary: "Create trusted workspace workspace-1.",
          destination: "workspace-1",
          warnings: [],
          outboundBytes: 0,
        },
        idempotencyKey: "queue-workspace-action",
        requiredConfirmations: 1,
        preparedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      }),
    }),
    executePrepared: async (action, context) => {
      preparedExecutions += 1;
      return {
        mutationState: "applied",
        output: { workspaceId: "workspace-1" },
        receipt: {
          version: 1,
          id: "queue-workspace-receipt",
          runId: action.runId,
          actionId: action.id,
          toolName: action.toolName,
          operation: "create",
          resource: action.target,
          message: "Created trusted queue workspace.",
          payloadFingerprint: action.payloadFingerprint,
          grantId: context.authorizedAction!.grantId,
          idempotencyKey: action.idempotencyKey,
          startedAt: now.toISOString(),
          committedAt: new Date(now.getTime() + 1_000).toISOString(),
          commitKind: "committed",
          readback: {
            status: "verified",
            checkedAt: new Date(now.getTime() + 1_000).toISOString(),
          },
          effects: { affectedCount: 1 },
        },
      };
    },
  };
  let grant = await createBoundedGrant({
    id: "queue-grant-1",
    kind: "scheduled_bounded",
    subject,
    rules: [{
      system: "workspace",
      resourceTypes: ["code_workspace"],
      actions: ["create"],
      selector: { repositoryProfileIds: ["repository-1"] },
    }],
    limits: {
      maxActions: 4,
      maxExternalMutations: 0,
      maxCreates: 4,
      maxDeletes: 0,
      maxOutboundBytes: 1_000,
    },
    issuer: "user_approval",
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60_000),
  });
  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithToolCall(descriptor.name, {}),
      () => responseWithContent("Trusted queue workspace created."),
    ],
  });

  __setCodeToolsDesktopAppForTests(true);
  try {
    await runAgentMission({
      prompt,
      runId: "queue-run-1",
      modelClient: client,
      toolRegistry: new DefaultToolRegistry([tool]),
      toolContext: vault.context,
      enableStreaming: false,
      preparedActionAuthority: {
        subject,
        resolve: async () => grant,
        consume: async ({ action }) => {
          const result = await consumeAuthorityGrant({
            grant,
            action,
            descriptor,
            subject,
            now,
          });
          if (!result.allowed) throw new Error("Fixture schedule grant did not authorize the prepared action.");
          grant = result.grant;
          consumedActions += 1;
          return grant;
        },
      },
      interactiveApprovals: false,
      events: {
        onStatus: (message) => statuses.push(message),
        onApprovalRequest: () => {
          approvalRequests += 1;
        },
      },
    });
  } finally {
    __setCodeToolsDesktopAppForTests(null);
  }

  assert.equal(preparedExecutions, 1, statuses.join(" | "));
  assert.equal(consumedActions, 1);
  assert.equal(approvalRequests, 0);
  assert.equal(grant.usage.actions, 1);
});

test("optional legacy tools keep execution policy while descriptors drive WAL classification", async () => {
  const prompt = "Promote workspace item item-1.";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-11T12:00:00.000Z"),
  });
  let executions = 0;
  const descriptor: ToolDescriptor = {
    version: 1,
    name: "promote_workspace_item",
    capability: {
      system: "workspace",
      resourceType: "work_item",
      action: "promote",
    },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "exact",
    },
    execution: {
      preparation: "optional",
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "optional",
      reconciliation: "optional",
    },
    allowedPrincipals: ["single_agent"],
  };
  const registry = new DefaultToolRegistry([
    {
      name: descriptor.name,
      description: "Promote a workspace item.",
      parameters: { type: "object", properties: {} },
      descriptor,
      execute: async () => {
        executions += 1;
        return { status: "ok", id: "item-1", affectedCount: 1 };
      },
    },
  ]);
  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithToolCall(descriptor.name, {}),
      () => responseWithContent("Promoted workspace item item-1."),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    events: {},
  });

  assert.equal(executions, 1);
  const runtimeSnapshot = [...vault.content.values()]
    .map((markdown) => parseMissionRuntimeSnapshotFromMarkdown(markdown))
    .find((snapshot) => snapshot?.operationJournal.some(
      (record) => record.toolName === descriptor.name,
    ));
  const journal = runtimeSnapshot?.operationJournal.find(
    (record) => record.toolName === descriptor.name,
  );
  assert.equal(journal?.version, 2);
  assert.equal(journal?.state, "committed");
  assert.equal(journal?.descriptor?.capability.action, "promote");
  assert.equal(journal?.preparedAction, undefined);
  assert.equal(journal?.receipt?.resource?.system, "workspace");
});

test("ambiguous WAL snapshot persistence keeps a racing stop fail-closed", async () => {
  const prompt = "Promote workspace item item-1.";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-11T12:00:00.000Z"),
  });
  const descriptor: ToolDescriptor = {
    version: 1,
    name: "promote_workspace_item",
    capability: {
      system: "workspace",
      resourceType: "work_item",
      action: "promote",
    },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "exact",
    },
    execution: {
      preparation: "optional",
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "optional",
      reconciliation: "optional",
    },
    allowedPrincipals: ["single_agent"],
  };
  let executions = 0;
  const registry = new DefaultToolRegistry([
    {
      name: descriptor.name,
      description: "Promote a workspace item.",
      parameters: { type: "object", properties: {} },
      descriptor,
      execute: async () => {
        executions += 1;
        return { status: "ok", id: "item-1", affectedCount: 1 };
      },
    },
  ]);
  const originalModify = vault.context.app.vault.modify.bind(
    vault.context.app.vault,
  );
  const abortController = new AbortController();
  let injectedAmbiguousWrite = false;
  let runArtifactWritesAfterAmbiguity = 0;
  vault.context.app.vault.modify = (async (file, data, options) => {
    const isDirectRunArtifact =
      file.path.startsWith("Agent Runs/") &&
      !file.path.startsWith("Agent Runs/Mission Graphs/");
    if (
      !injectedAmbiguousWrite &&
      isDirectRunArtifact &&
      data.includes('"toolName": "promote_workspace_item"') &&
      data.includes('"state": "applying"')
    ) {
      injectedAmbiguousWrite = true;
      abortController.abort(new Error("stop raced ambiguous WAL persistence"));
      throw new Error("injected vault acknowledgement failure");
    }
    if (injectedAmbiguousWrite && isDirectRunArtifact) {
      runArtifactWritesAfterAmbiguity += 1;
    }
    return originalModify(file, data, options);
  }) as typeof vault.context.app.vault.modify;

  const traces: AgentTraceEvent[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests: [],
      chatResponders: [
        () => responseWithToolCall(descriptor.name, {}),
        () => responseWithContent("Promoted workspace item item-1."),
      ],
    }),
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    abortSignal: abortController.signal,
    events: {
      onTrace: (event) => traces.push(event),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.equal(injectedAmbiguousWrite, true);
  assert.equal(executions, 0, "the tool must not run without durable applying WAL");
  assert.equal(
    runArtifactWritesAfterAmbiguity,
    0,
    "terminal error handling must not retry the ambiguous Agent Runs write",
  );
  assert.ok(
    traces.some(
      (event) => event.error?.code === "runtime_snapshot_write_ambiguous",
    ),
  );
  assert.equal(completions.at(-1)?.stopReason, "user_stopped");
});

test("mock AI generates project code then creates the private GitHub repository", async () => {
  const AI_PROJECT_MARKER = "AI_GENERATED_PROJECT_CODE_MARKER_7f3a";
  const AI_REPO_DESCRIPTION = `Private repo for AI-generated hello project ${AI_PROJECT_MARKER}`;
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const workspaceFiles = new Map<string, string>();
  let privateRepositoryExists = false;
  let privateRepositoryCreates = 0;
  let createDescription: string | undefined;
  let privateCheckpointStatus: string | null = null;
  let privateReceiptReadback: string | null = null;
  let privateCheckpointStore: unknown = null;
  const broker = new ApprovalBroker();
  const prompt = [
    "Implement a tiny hello project in the code workspace.",
    `Write hello.py containing ${AI_PROJECT_MARKER}.`,
    "Then create the exact private GitHub repository for this verified project.",
  ].join(" ");
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Project\n",
    streamWritebackMode: "off",
  });
  vault.context.settings.githubEnabled = true;
  vault.context.settings.maxAgentSteps = 12;
  vault.context.settings.modelRouterMode = "off";
  // Set-loose Soft-union withholds GitHub until verified commit after a passed
  // fast repair cycle — exercise the full ladder in this unit mock.
  vault.context.settings.autonomyProfile = "automatic";
  vault.context.settings.workingMode = "automatic";

  const codeDescriptor: ToolDescriptor = {
    version: 1,
    name: "code_workspace_create_file",
    capability: {
      system: "workspace",
      resourceType: "file",
      action: "create",
    },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
      fallback: "none",
    },
    execution: { preparation: "none", cacheable: false, parallelSafe: false },
    durability: {
      journal: true,
      receipt: true,
      readback: "optional",
      reconciliation: "optional",
    },
    allowedPrincipals: ["single_agent"],
  };
  const codeCreateFile: AgentTool = {
    name: "code_workspace_create_file",
    description: "Create a workspace file with model-authored content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    descriptor: codeDescriptor,
    async execute(args) {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      workspaceFiles.set(path, content);
      return {
        ok: true,
        path,
        bytes: content.length,
        markerPresent: content.includes(AI_PROJECT_MARKER),
      };
    },
  };
  const codeValidateFast: AgentTool = {
    name: "code_validate_fast",
    description: "Bounded fast sandbox validation.",
    parameters: {
      type: "object",
      properties: {
        requestId: { type: "string" },
      },
      additionalProperties: true,
    },
    descriptor: {
      ...codeDescriptor,
      name: "code_validate_fast",
      capability: {
        system: "workspace",
        resourceType: "validation",
        action: "validate",
      },
      effect: "read",
      risk: "low",
    },
    async execute() {
      // DefaultToolRegistry wraps execute() return value as result.output.
      return {
        status: "passed",
        validationReceiptId: "val-fast-ai-hello",
      };
    },
  };
  const codeRepairRecordCycle: AgentTool = {
    name: "code_repair_record_cycle",
    description: "Record a repair-cycle outcome for the ladder.",
    parameters: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        outcome: { type: "string" },
      },
      additionalProperties: true,
    },
    descriptor: {
      ...codeDescriptor,
      name: "code_repair_record_cycle",
      capability: {
        system: "workspace",
        resourceType: "repair_cycle",
        action: "update",
      },
      effect: "read",
      risk: "low",
    },
    async execute(args) {
      return {
        outcome: String(args.outcome ?? "passed"),
        requestId: String(args.requestId ?? "repair-ai-hello"),
      };
    },
  };
  const codeCommitVerified: AgentTool = {
    name: "code_commit_verified",
    description: "Verified local commit after validation.",
    parameters: {
      type: "object",
      properties: {
        commitMessage: { type: "string" },
      },
      additionalProperties: true,
    },
    descriptor: {
      ...codeDescriptor,
      name: "code_commit_verified",
      capability: {
        system: "git",
        resourceType: "commit",
        action: "create",
      },
      effect: "reversible_mutation",
      risk: "high",
    },
    async execute() {
      return {
        commitSha: "a".repeat(40),
        operation: "commit",
        resource: {
          system: "git",
          resourceType: "commit",
          id: "a".repeat(40),
        },
      };
    },
  };
  const privateRepository = () => ({
    id: 909,
    fullName: "agentic-fixture/ai-generated-hello",
    htmlUrl: "https://github.com/agentic-fixture/ai-generated-hello",
    defaultBranch: "main",
    private: true,
    archived: false,
  });
  const privateTool = createGitHubPrivateRepositoryTool({
    resolveDestination: async () => ({
      ownerKind: "organization",
      owner: "agentic-fixture",
      repository: "ai-generated-hello",
      profile: detectRepositoryProfileV2({
        key: "ai-generated-hello",
        displayName: "AI generated hello",
        repositoryRoot: "C:\\fixtures\\ai-generated-hello",
        defaultBranch: "main",
        files: ["package.json", "hello.py"],
        requiredGitHubChecks: ["ci"],
      }),
      accountId: 909,
      accountLogin: "phase7-agent",
      trustedAt: "2026-07-21T00:00:00.000Z",
    }),
    readRepository: async () =>
      privateRepositoryExists ? privateRepository() : null,
    createPrivateRepository: async (_destination, description) => {
      privateRepositoryCreates += 1;
      createDescription = description;
      privateRepositoryExists = true;
      return privateRepository();
    },
    getCheckpoint: async () =>
      privateCheckpointStore as Awaited<
        ReturnType<
          NonNullable<
            Parameters<typeof createGitHubPrivateRepositoryTool>[0]["getCheckpoint"]
          >
        >
      > | null,
    persistCheckpoint: async (checkpoint) => {
      privateCheckpointStore = structuredClone(checkpoint);
      privateCheckpointStatus = checkpoint.status;
    },
    persistBinding: async () => undefined,
    persistExternalReceipt: async (receipt: ActionReceipt) => {
      privateReceiptReadback = receipt.readback.status;
    },
    now: () => new Date("2026-07-21T00:00:00.000Z"),
  });

  await runAgentMission({
    prompt,
    modelClient: createClient({
      chatRequests,
      chatResponders: [
        () =>
          responseWithToolCall("code_workspace_create_file", {
            path: "hello.py",
            content: `# ${AI_PROJECT_MARKER}\nprint("hello from ai-generated project")\n`,
          }),
        () =>
          responseWithToolCall("code_validate_fast", {
            requestId: "repair-ai-hello",
          }),
        () =>
          responseWithToolCall("code_repair_record_cycle", {
            requestId: "repair-ai-hello",
            outcome: "passed",
          }),
        () =>
          responseWithToolCall("code_commit_verified", {
            commitMessage: `commit ${AI_PROJECT_MARKER}`,
          }),
        () =>
          responseWithToolCall(CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME, {
            profileKey: "ai-generated-hello",
            description: AI_REPO_DESCRIPTION,
          }),
        () =>
          responseWithContent(
            `Created the private repository for the AI-authored project containing ${AI_PROJECT_MARKER}.`,
          ),
      ],
    }),
    toolRegistry: new DefaultToolRegistry([
      codeCreateFile,
      codeValidateFast,
      codeRepairRecordCycle,
      codeCommitVerified,
      privateTool,
    ]),
    toolContext: vault.context,
    enableStreaming: false,
    approvalBroker: broker,
    events: {
      onStatus: (message) => statuses.push(message),
      onRunComplete: (event) => completions.push(event),
      onApprovalRequest: (request) => {
        broker.resolve(request.id, "approved");
      },
    },
  });

  const offered = new Set(
    chatRequests.flatMap(
      (request) => request.tools?.map((tool) => tool.function.name) ?? [],
    ),
  );
  assert.ok(
    chatRequests.length > 0,
    `model never called; statuses=${statuses.join(" | ")}; stop=${completions.at(-1)?.stopReason}`,
  );
  assert.ok(
    offered.has("code_workspace_create_file"),
    `code tool missing; offered=${[...offered].join(", ") || "(none)"}`,
  );
  assert.ok(
    offered.has(CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME),
    `github create missing; offered=${[...offered].join(", ") || "(none)"}`,
  );
  assert.equal(
    workspaceFiles.get("hello.py")?.includes(AI_PROJECT_MARKER),
    true,
    `workspace missing AI code; files=${JSON.stringify([...workspaceFiles.keys()])}; statuses=${statuses.join(" | ")}`,
  );
  assert.equal(
    privateRepositoryCreates,
    1,
    `private create not dispatched; checkpoint=${privateCheckpointStatus ?? "none"}; statuses=${statuses.join(" | ")}; stop=${completions.at(-1)?.stopReason}`,
  );
  assert.equal(createDescription, AI_REPO_DESCRIPTION);
  assert.match(createDescription ?? "", new RegExp(AI_PROJECT_MARKER));
  assert.equal(privateCheckpointStatus, "verified");
  assert.equal(privateReceiptReadback, "verified");
});

test("Soft→Bound replace budget stop is effect_class_blocked without grant", async () => {
  const prompt =
    "Read the current note first. Then replace the entire current note with exactly this markdown:\n# Soft Bound Blocked\n\nE2E_SOFT_BOUND_NO_GRANT_UNIT";
  const completions: AgentRunCompleteEvent[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Original Soft Bound Note\n\nKeep until replace.\n",
    streamWritebackMode: "off",
  });
  vault.context.settings.maxAgentSteps = 1;
  vault.context.settings.completionDrivenLoops = true;
  vault.context.settings.autonomyProfile = "automatic";
  const client = createClient({
    chatRequests: [],
    chatResponders: [() => responseWithToolCall("read_current_file", {})],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    completionSegmentIndex: 0,
    maxCompletionSegments: 4,
    events: {
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.ok(
    executedCalls.some((call) => call.name === "read_current_file"),
    JSON.stringify(executedCalls.map((call) => call.name)),
  );
  assert.equal(vault.content.get("Current.md"), "# Original Soft Bound Note\n\nKeep until replace.\n");
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.stopReason, "budget");
  assert.equal(completions[0]?.autoContinueRecommended, false);
  assert.equal(completions[0]?.autoContinueReason, "effect_class_blocked");
});

test("Soft→Bound replace budget stop continues under unused Bound grant peek", async () => {
  const prompt =
    "Read the current note first. Then replace the entire current note with exactly this markdown:\n# Soft Bound Granted\n\nE2E_SOFT_BOUND_GRANT_UNIT";
  const completions: AgentRunCompleteEvent[] = [];
  const executedCalls: ModelToolCall[] = [];
  const grantPeeks: string[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Original Soft Bound Note\n\nKeep until replace.\n",
    streamWritebackMode: "off",
  });
  vault.context.settings.maxAgentSteps = 1;
  vault.context.settings.completionDrivenLoops = true;
  vault.context.settings.autonomyProfile = "automatic";
  const client = createClient({
    chatRequests: [],
    chatResponders: [() => responseWithToolCall("read_current_file", {})],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    completionSegmentIndex: 0,
    maxCompletionSegments: 4,
    preparedActionAuthority: {
      subject: { type: "run", id: "run-soft-bound-grant" },
      resolve: async () => null,
      consume: async () => {
        throw new Error("consume must not run during Soft→Bound grant peek");
      },
      hasUnusedGrantForTool: (toolName) => {
        grantPeeks.push(toolName);
        return toolName === "replace_current_file";
      },
    },
    events: {
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.ok(
    executedCalls.some((call) => call.name === "read_current_file"),
    JSON.stringify(executedCalls.map((call) => call.name)),
  );
  assert.equal(vault.content.get("Current.md"), "# Original Soft Bound Note\n\nKeep until replace.\n");
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.stopReason, "budget");
  assert.equal(completions[0]?.autoContinueRecommended, true);
  assert.equal(completions[0]?.autoContinueReason, "budget_exhausted");
  assert.ok(
    grantPeeks.includes("replace_current_file"),
    JSON.stringify(grantPeeks),
  );
});

test("resolveHasMatchingGrantForAutoContinuation requires unused Bound grant", async () => {
  assert.equal(
    await resolveHasMatchingGrantForAutoContinuation({
      pendingToolNames: ["replace_current_file"],
    }),
    false,
  );
  assert.equal(
    await resolveHasMatchingGrantForAutoContinuation({
      pendingToolNames: ["web_search"],
    }),
    false,
    "Soft pending tools do not invent a grant match",
  );
  assert.equal(
    await resolveHasMatchingGrantForAutoContinuation({
      pendingToolNames: ["delete_current_file"],
      approvals: [
        {
          id: "approval-hard-1",
          toolName: "delete_current_file",
          decision: "approved",
        },
      ],
    }),
    false,
    "Hard tools must not match even with unused approvals",
  );
  assert.equal(
    await resolveHasMatchingGrantForAutoContinuation({
      pendingToolNames: ["replace_current_file"],
      approvals: [
        {
          id: "approval-bound-1",
          toolName: "replace_current_file",
          decision: "approved",
        },
      ],
      receipts: [],
    }),
    true,
  );
  assert.equal(
    await resolveHasMatchingGrantForAutoContinuation({
      pendingToolNames: ["replace_current_file"],
      approvals: [
        {
          id: "approval-bound-1",
          toolName: "replace_current_file",
          decision: "approved",
        },
      ],
      receipts: [{ toolName: "replace_current_file", grantId: "grant:approval-bound-1" }],
    }),
    false,
    "Consumed ledger grants must not count as matching",
  );
  assert.equal(
    await resolveHasMatchingGrantForAutoContinuation({
      pendingToolNames: ["replace_current_file"],
      preparedActionAuthority: {
        subject: { type: "run", id: "run-1" },
        resolve: async () => null,
        consume: async () => {
          throw new Error("consume must not run during grant peek");
        },
        hasUnusedGrantForTool: (toolName) => toolName === "replace_current_file",
      },
    }),
    true,
  );
});
