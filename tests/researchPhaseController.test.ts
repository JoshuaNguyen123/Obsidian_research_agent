import test from "node:test";
import assert from "node:assert/strict";
import {
  buildResearchPhaseTransition,
  deriveResearchPhase,
  gateAcceptanceByResearchPhase,
  type ClaimConflictState,
} from "../src/agent/researchPhaseController";
import { evaluateToolPolicy } from "../src/agent/policyEngine";
import type { ResearchPlan } from "../src/agent/researchPlan";
import type { RoutedMissionIntent } from "../src/agent/missionRouter";
import { applyResearchPhaseToLoopDecision } from "../src/agent/loopDecision";
import type { MissionPlan } from "../src/agent/missionPlan";

function researchPlanFixture(
  overrides: Partial<ResearchPlan> = {},
): ResearchPlan {
  return {
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
        question: "Find sources",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "in_progress",
        evidenceIds: [],
      },
      {
        id: "rq-2",
        question: "Compare",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "pending",
        evidenceIds: [],
      },
      {
        id: "rq-3",
        question: "Synthesize",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "pending",
        evidenceIds: [],
      },
    ],
    evidenceIds: [],
    status: "in_progress",
    ...overrides,
  };
}

function routedIntent(
  overrides: Partial<RoutedMissionIntent> = {},
): RoutedMissionIntent {
  return {
    mode: "web_research",
    writeScope: "current_note_append",
    needsWebEvidence: true,
    needsVaultContext: false,
    needsCodeExecution: false,
    wordTarget: 300,
    confidence: 0.9,
    rationale: "test",
    ...overrides,
  };
}

test("non-research missions skip gather/analyze and allow writes", () => {
  const phase = deriveResearchPhase({ researchPlan: null });
  assert.equal(phase.researchBearing, false);
  assert.equal(phase.phase, "write");
  assert.equal(phase.writeToolsAllowed, true);
  assert.equal(phase.acceptanceAllowed, false);

  const afterWrite = deriveResearchPhase({
    researchPlan: null,
    writeReceiptPresent: true,
  });
  assert.equal(afterWrite.phase, "verify");
  assert.equal(afterWrite.writeToolsAllowed, true);
});

test("research-bearing missions start in gather and block write tools", () => {
  const phase = deriveResearchPhase({
    researchPlan: researchPlanFixture(),
  });
  assert.equal(phase.researchBearing, true);
  assert.equal(phase.phase, "gather");
  assert.equal(phase.writeToolsAllowed, false);
  assert.equal(phase.gatherComplete, false);

  const blocked = evaluateToolPolicy({
    toolName: "append_to_current_file",
    args: { content: "draft" },
    intent: routedIntent(),
    approvalGranted: false,
    isDesktop: true,
    writeAutonomy: true,
    researchPhase: phase,
  });
  assert.equal(blocked.action, "block");
  assert.ok(blocked.tags.includes("research_phase_gate"));
  assert.ok(blocked.tags.includes("gather"));

  const memoryAllowed = evaluateToolPolicy({
    toolName: "append_research_memory",
    args: {},
    intent: routedIntent({ writeScope: "none" }),
    approvalGranted: false,
    isDesktop: true,
    writeAutonomy: false,
    researchPhase: phase,
  });
  assert.equal(memoryAllowed.action, "allow");
});

test("phase advances only on observable evidence and receipts", () => {
  const gathering = deriveResearchPhase({
    researchPlan: researchPlanFixture(),
  });
  assert.equal(gathering.phase, "gather");

  const gatheredPlan = researchPlanFixture({
    status: "complete",
    subquestions: [
      {
        id: "rq-1",
        question: "Find sources",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "complete",
        evidenceIds: ["web_fetch:1"],
      },
      {
        id: "rq-2",
        question: "Compare",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "complete",
        evidenceIds: ["web_fetch:2"],
      },
      {
        id: "rq-3",
        question: "Synthesize",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "complete",
        evidenceIds: ["web_fetch:3"],
      },
    ],
    evidenceIds: ["web_fetch:1", "web_fetch:2", "web_fetch:3"],
  });

  // Without claim/conflict state, analyze completes immediately after gather.
  const readyToWrite = deriveResearchPhase({ researchPlan: gatheredPlan });
  assert.equal(readyToWrite.phase, "write");
  assert.equal(readyToWrite.gatherComplete, true);
  assert.equal(readyToWrite.analyzeComplete, true);
  assert.equal(readyToWrite.writeToolsAllowed, true);

  const claimConflict: ClaimConflictState = {
    openConflictCount: 2,
    claimsGrounded: false,
  };
  const analyzing = deriveResearchPhase({
    researchPlan: gatheredPlan,
    claimConflict,
  });
  assert.equal(analyzing.phase, "analyze");
  assert.equal(analyzing.writeToolsAllowed, false);

  const analyzeDone = deriveResearchPhase({
    researchPlan: gatheredPlan,
    claimConflict: { openConflictCount: 0, claimsGrounded: true },
  });
  assert.equal(analyzeDone.phase, "write");

  const verifying = deriveResearchPhase({
    researchPlan: gatheredPlan,
    writeReceiptPresent: true,
  });
  assert.equal(verifying.phase, "verify");
  assert.equal(verifying.acceptanceAllowed, false);

  const verified = deriveResearchPhase({
    researchPlan: gatheredPlan,
    writeReceiptPresent: true,
    verifyComplete: true,
  });
  assert.equal(verified.phase, "verify");
  assert.equal(verified.acceptanceAllowed, true);
});

test("external action receipts advance only external-action research plans", () => {
  const gatheredPlan = researchPlanFixture({
    status: "complete",
    subquestions: researchPlanFixture().subquestions.map((item) => ({
      ...item,
      status: "complete" as const,
      evidenceIds: [`web:${item.id}`],
    })),
    evidenceIds: ["web:rq-1", "web:rq-2", "web:rq-3"],
  });
  const externalMission = missionPlanFixture("external_action_receipt", [
    "linear_create_issue",
  ]);
  const externalWriting = deriveResearchPhase({
    researchPlan: gatheredPlan,
    missionPlan: externalMission,
  });
  assert.equal(externalWriting.phase, "write");
  assert.match(externalWriting.reason, /action tools are unlocked/);

  const externalVerifying = deriveResearchPhase({
    researchPlan: gatheredPlan,
    missionPlan: externalMission,
    externalActionReceiptPresent: true,
  });
  assert.equal(externalVerifying.phase, "verify");

  const vaultMission = missionPlanFixture("write_receipt", [
    "append_to_current_file",
  ]);
  const vaultStillWriting = deriveResearchPhase({
    researchPlan: gatheredPlan,
    missionPlan: vaultMission,
    externalActionReceiptPresent: true,
  });
  assert.equal(vaultStillWriting.phase, "write");
});

test("acceptance is blocked in gather and analyze phases", () => {
  const gathering = deriveResearchPhase({
    researchPlan: researchPlanFixture(),
  });
  assert.equal(gathering.phase, "gather");
  assert.equal(gathering.acceptanceAllowed, false);
  const gatedGather = gateAcceptanceByResearchPhase(
    {
      status: "pass",
      missing: [] as string[],
      reasons: ["would_pass"],
    },
    gathering,
  );
  assert.equal(gatedGather.status, "needs_more_work");
  assert.ok(
    gatedGather.missing.includes("research_phase_acceptance:gather"),
  );

  const gatheredPlan = researchPlanFixture({
    status: "complete",
    subquestions: researchPlanFixture().subquestions.map((item) => ({
      ...item,
      status: "complete" as const,
      evidenceIds: ["web_fetch:x"],
    })),
    evidenceIds: ["web_fetch:x"],
  });
  const analyzing = deriveResearchPhase({
    researchPlan: gatheredPlan,
    claimConflict: { openConflictCount: 1, claimsGrounded: false },
  });
  assert.equal(analyzing.phase, "analyze");
  assert.equal(analyzing.acceptanceAllowed, false);
  const gatedAnalyze = gateAcceptanceByResearchPhase(
    {
      status: "pass",
      missing: [] as string[],
      reasons: ["would_pass"],
    },
    analyzing,
  );
  assert.equal(gatedAnalyze.status, "needs_more_work");
  assert.ok(
    gatedAnalyze.missing.includes("research_phase_acceptance:analyze"),
  );

  // Write-phase candidate checks remain ungated so proof-gated writeback works.
  const writing = deriveResearchPhase({ researchPlan: gatheredPlan });
  assert.equal(writing.phase, "write");
  const writeCandidate = gateAcceptanceByResearchPhase(
    { status: "pass", missing: [], reasons: ["candidate"] },
    writing,
  );
  assert.equal(writeCandidate.status, "pass");
});

test("phase transition descriptors emit only on change", () => {
  const first = deriveResearchPhase({ researchPlan: researchPlanFixture() });
  const transition = buildResearchPhaseTransition(null, first);
  assert.ok(transition);
  assert.equal(transition.from, null);
  assert.equal(transition.to, "gather");

  const same = buildResearchPhaseTransition("gather", first);
  assert.equal(same, null);
});

test("loopDecision soft-gates streamed writeback during gather", () => {
  const phase = deriveResearchPhase({
    researchPlan: researchPlanFixture(),
  });
  const diverted = applyResearchPhaseToLoopDecision(
    { action: "stream_note_writeback", reason: "ready" },
    phase,
  );
  assert.equal(diverted.action, "continue_tools");
  assert.match(diverted.reason, /research_phase_gather_blocks_write/);

  const writePhase = deriveResearchPhase({
    researchPlan: researchPlanFixture({
      status: "complete",
      subquestions: researchPlanFixture().subquestions.map((item) => ({
        ...item,
        status: "complete" as const,
        evidenceIds: ["web_fetch:x"],
      })),
      evidenceIds: ["web_fetch:x"],
    }),
  });
  const allowed = applyResearchPhaseToLoopDecision(
    { action: "stream_note_writeback", reason: "ready" },
    writePhase,
  );
  assert.equal(allowed.action, "stream_note_writeback");
});

function missionPlanFixture(
  proof: "write_receipt" | "external_action_receipt",
  allowedTools: string[],
): MissionPlan {
  return {
    version: 1,
    runId: "run-phase",
    status: "in_progress",
    activeTaskId: "task-action",
    tasks: [
      {
        id: "task-action",
        title: "Complete action",
        status: "in_progress",
        allowedTools,
        dependencies: [],
        evidenceIds: [],
        receiptIds: [],
        completionContract: { requiredProof: [proof] },
      },
    ],
    progress: {
      score: 0,
      completedTasks: 0,
      totalTasks: 1,
      remainingTasks: 1,
      stalledCount: 0,
    },
    createdAt: "2026-07-11T12:00:00.000Z",
    updatedAt: "2026-07-11T12:00:00.000Z",
  };
}

test("write tools are allowed once research reaches write phase", () => {
  const phase = deriveResearchPhase({
    researchPlan: researchPlanFixture({
      status: "complete",
      subquestions: researchPlanFixture().subquestions.map((item) => ({
        ...item,
        status: "complete" as const,
        evidenceIds: ["web_fetch:x"],
      })),
      evidenceIds: ["web_fetch:x"],
    }),
  });
  assert.equal(phase.phase, "write");
  const allowed = evaluateToolPolicy({
    toolName: "append_to_current_file",
    args: { content: "draft" },
    intent: routedIntent(),
    approvalGranted: false,
    isDesktop: true,
    writeAutonomy: false,
    researchPhase: phase,
  });
  assert.equal(allowed.action, "allow");
});
