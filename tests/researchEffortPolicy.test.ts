import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_EFFORT_BUDGETS,
  decideResearchProgress,
  resolveResearchEffortBudget,
  selectInitialResearchEffort,
  type DecideResearchProgressInput,
} from "../src/agent/researchEffortPolicy";

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;

test("research effort tiers expose the accepted bounded budgets", () => {
  assert.deepEqual(RESEARCH_EFFORT_BUDGETS.quick, {
    maxModelStepsPerSegment: 8,
    maxToolCallsPerSegment: 4,
    maxSegments: 1,
    maxTotalModelSteps: 8,
    maxTotalToolCalls: 4,
    maxDurationMs: null,
  });
  assert.deepEqual(RESEARCH_EFFORT_BUDGETS.standard, {
    maxModelStepsPerSegment: 24,
    maxToolCallsPerSegment: 12,
    maxSegments: 1,
    maxTotalModelSteps: 24,
    maxTotalToolCalls: 12,
    maxDurationMs: null,
  });
  assert.deepEqual(RESEARCH_EFFORT_BUDGETS.deep, {
    maxModelStepsPerSegment: 60,
    maxToolCallsPerSegment: 30,
    maxSegments: 1,
    maxTotalModelSteps: 60,
    maxTotalToolCalls: 30,
    maxDurationMs: null,
  });
  assert.deepEqual(RESEARCH_EFFORT_BUDGETS.extended, {
    maxModelStepsPerSegment: 100,
    maxToolCallsPerSegment: 50,
    maxSegments: 4,
    maxTotalModelSteps: 400,
    maxTotalToolCalls: 200,
    maxDurationMs: EIGHT_HOURS_MS,
  });
});

test("initial selection scales focused, normal, deep, and durable research deterministically", () => {
  assert.equal(
    selectInitialResearchEffort({
      prompt: "Find the current stable Obsidian version.",
      subquestions: 1,
      freshness: "required",
      risk: "low",
    }).tier,
    "quick",
  );
  assert.equal(
    selectInitialResearchEffort({
      prompt: "Research the product need and implementation constraints.",
      route: "grounded_workflow",
      subquestions: 2,
      freshness: "helpful",
      risk: "low",
    }).tier,
    "standard",
  );
  assert.equal(
    selectInitialResearchEffort({
      prompt: "Compare architectures, alternatives, and implementation trade-offs.",
      route: "deep_hybrid",
      subquestions: 5,
      freshness: "required",
      risk: "medium",
    }).tier,
    "deep",
  );
  assert.equal(
    selectInitialResearchEffort({
      prompt: "Run an exhaustive systematic review before implementation.",
      route: "long_research",
      subquestions: 6,
      freshness: "required",
      risk: "high",
    }).tier,
    "extended",
  );
});

test("one-source grounded lookups stay quick unless breadth or risk requires more", () => {
  const base = {
    route: "grounded_workflow needs_web_sources",
    subquestions: 2,
    requiredSources: 1,
    freshness: "required" as const,
  };
  assert.equal(
    selectInitialResearchEffort({
      ...base,
      prompt: "Find the current stable Obsidian version using one focused source.",
      risk: "low",
    }).tier,
    "quick",
  );
  assert.equal(
    selectInitialResearchEffort({
      ...base,
      requiredSources: 2,
      prompt: "Research the current stable Obsidian version using two sources.",
      risk: "low",
    }).tier,
    "standard",
  );
  assert.equal(
    selectInitialResearchEffort({
      ...base,
      prompt: "Do deep research using one source about the stable Obsidian version.",
      risk: "low",
    }).tier,
    "deep",
  );
  assert.notEqual(
    selectInitialResearchEffort({
      ...base,
      prompt: "Research one current source for a security-critical decision.",
      risk: "high",
    }).tier,
    "quick",
  );
});

test("requested tiers and user ceilings are applied as hard constraints", () => {
  const selection = selectInitialResearchEffort({
    prompt: "Exhaustively investigate every alternative.",
    subquestions: 10,
    risk: "critical",
    constraints: {
      requestedTier: "extended",
      maxTier: "standard",
      maxModelSteps: 10,
      maxToolCalls: 5,
    },
  });

  assert.equal(selection.tier, "standard");
  assert.equal(selection.constrained, true);
  assert.equal(selection.budget.maxTotalModelSteps, 10);
  assert.equal(selection.budget.maxTotalToolCalls, 5);
  assert.match(selection.reasons.join(" "), /capped at standard/);
});

test("budget resolution scales extended segments and never mutates defaults", () => {
  const constrained = resolveResearchEffortBudget("extended", {
    maxSegments: 2,
    maxModelSteps: 180,
    maxToolCalls: 70,
    maxDurationMs: 60_000,
  });
  assert.deepEqual(constrained, {
    maxModelStepsPerSegment: 100,
    maxToolCallsPerSegment: 50,
    maxSegments: 2,
    maxTotalModelSteps: 180,
    maxTotalToolCalls: 70,
    maxDurationMs: 60_000,
  });
  assert.equal(RESEARCH_EFFORT_BUDGETS.extended.maxSegments, 4);
});

test("progress stops only after acceptance and two consecutive low-yield batches", () => {
  const firstLowYield = decideResearchProgress(progressInput({
    acceptanceGaps: [],
    remainingQuestions: 0,
    conflicts: 0,
    evidenceYield: 0,
    consecutiveLowYieldBatches: 1,
  }));
  assert.equal(firstLowYield.action, "continue");
  assert.equal(firstLowYield.reason, "confirming_saturation");

  const saturated = decideResearchProgress(progressInput({
    acceptanceGaps: [],
    remainingQuestions: 0,
    conflicts: 0,
    evidenceYield: 0,
    consecutiveLowYieldBatches: 2,
  }));
  assert.equal(saturated.action, "stop");
  assert.equal(saturated.reason, "acceptance_saturated");
});

test("unpaid proof continues despite low yield while budget remains", () => {
  const decision = decideResearchProgress(progressInput({
    acceptanceGaps: ["fetched_sources"],
    remainingQuestions: ["Which implementation is supported?"],
    conflicts: ["Source A conflicts with source B"],
    evidenceYield: 0,
    consecutiveLowYieldBatches: 4,
  }));

  assert.equal(decision.action, "continue");
  assert.equal(decision.reason, "unresolved_proof");
  assert.deepEqual(decision.unresolved, {
    acceptanceGaps: 1,
    remainingQuestions: 1,
    conflicts: 1,
  });
});

test("useful unresolved work escalates exactly one tier at 75 percent utilization", () => {
  const quickToStandard = decideResearchProgress(progressInput({
    tier: "quick",
    usage: {
      modelSteps: 6,
      toolCalls: 2,
      segmentsStarted: 1,
      elapsedMs: 2_000,
    },
    acceptanceGaps: ["web_evidence"],
    remainingQuestions: 1,
    evidenceYield: 0.5,
  }));
  assert.equal(quickToStandard.action, "escalate");
  assert.equal(quickToStandard.tier, "quick");
  assert.equal(quickToStandard.nextTier, "standard");
  assert.equal(quickToStandard.budget.maxTotalModelSteps, 24);

  const deepToExtended = decideResearchProgress(progressInput({
    tier: "deep",
    usage: {
      modelSteps: 45,
      toolCalls: 10,
      segmentsStarted: 1,
      elapsedMs: 20_000,
    },
    acceptanceGaps: ["distinct_domains"],
    remainingQuestions: 2,
    evidenceYield: 0.2,
  }));
  assert.equal(deepToExtended.action, "escalate");
  assert.equal(deepToExtended.nextTier, "extended");
});

test("max tier blocks escalation and the tier cap eventually stops work", () => {
  const constrained = { maxTier: "quick" as const };
  const beforeCap = decideResearchProgress(progressInput({
    tier: "quick",
    usage: {
      modelSteps: 6,
      toolCalls: 2,
      segmentsStarted: 1,
      elapsedMs: 2_000,
    },
    acceptanceGaps: ["web_evidence"],
    remainingQuestions: 1,
    evidenceYield: 0.5,
    constraints: constrained,
  }));
  assert.equal(beforeCap.action, "continue");

  const atCap = decideResearchProgress(progressInput({
    tier: "quick",
    usage: {
      modelSteps: 8,
      toolCalls: 3,
      segmentsStarted: 1,
      elapsedMs: 3_000,
    },
    acceptanceGaps: ["web_evidence"],
    remainingQuestions: 1,
    evidenceYield: 0.5,
    constraints: constrained,
  }));
  assert.equal(atCap.action, "stop");
  assert.equal(atCap.reason, "model_step_cap_reached");
});

test("explicit user limits stop before any otherwise valid escalation", () => {
  const modelCap = decideResearchProgress(progressInput({
    tier: "standard",
    usage: {
      modelSteps: 6,
      toolCalls: 2,
      segmentsStarted: 1,
      elapsedMs: 1_000,
    },
    acceptanceGaps: ["web_evidence"],
    remainingQuestions: 2,
    evidenceYield: 0.8,
    constraints: { maxModelSteps: 6 },
  }));
  assert.equal(modelCap.action, "stop");
  assert.equal(modelCap.reason, "model_step_cap_reached");

  const durationCap = decideResearchProgress(progressInput({
    usage: {
      modelSteps: 1,
      toolCalls: 1,
      segmentsStarted: 1,
      elapsedMs: 5_000,
    },
    acceptanceGaps: ["web_evidence"],
    remainingQuestions: 1,
    evidenceYield: 0.5,
    constraints: { maxDurationMs: 5_000 },
  }));
  assert.equal(durationCap.action, "stop");
  assert.equal(durationCap.reason, "duration_cap_reached");
});

test("extended work rolls into a bounded new segment then stops at four", () => {
  const nextSegment = decideResearchProgress(progressInput({
    tier: "extended",
    usage: {
      modelSteps: 100,
      toolCalls: 30,
      segmentsStarted: 1,
      modelStepsInCurrentSegment: 100,
      elapsedMs: 60_000,
    },
    acceptanceGaps: ["web_evidence"],
    remainingQuestions: 2,
    evidenceYield: 0.05,
  }));
  assert.equal(nextSegment.action, "continue");
  assert.equal(nextSegment.reason, "start_next_segment");
  assert.equal(nextSegment.startNewSegment, true);

  const inferredBoundary = decideResearchProgress(progressInput({
    tier: "extended",
    usage: {
      modelSteps: 100,
      toolCalls: 30,
      segmentsStarted: 1,
      elapsedMs: 60_000,
    },
    acceptanceGaps: ["web_evidence"],
    remainingQuestions: 2,
    evidenceYield: 0.05,
  }));
  assert.equal(inferredBoundary.reason, "start_next_segment");

  const finalSegment = decideResearchProgress(progressInput({
    tier: "extended",
    usage: {
      modelSteps: 400,
      toolCalls: 120,
      segmentsStarted: 4,
      modelStepsInCurrentSegment: 100,
      elapsedMs: 2 * 60 * 60 * 1_000,
    },
    acceptanceGaps: ["web_evidence"],
    remainingQuestions: 1,
    evidenceYield: 0.05,
  }));
  assert.equal(finalSegment.action, "stop");
  assert.equal(finalSegment.reason, "model_step_cap_reached");

  const overSegmentCap = decideResearchProgress(progressInput({
    tier: "extended",
    usage: {
      modelSteps: 101,
      toolCalls: 31,
      segmentsStarted: 2,
      modelStepsInCurrentSegment: 1,
      elapsedMs: 60_000,
    },
    acceptanceGaps: ["web_evidence"],
    remainingQuestions: 1,
    evidenceYield: 0.2,
    constraints: { maxSegments: 1 },
  }));
  assert.equal(overSegmentCap.action, "stop");
  assert.equal(overSegmentCap.reason, "segment_cap_reached");
});

function progressInput(
  patch: Partial<DecideResearchProgressInput>,
): DecideResearchProgressInput {
  return {
    tier: "standard",
    usage: {
      modelSteps: 2,
      toolCalls: 1,
      segmentsStarted: 1,
      elapsedMs: 1_000,
    },
    acceptanceGaps: [],
    remainingQuestions: 0,
    conflicts: 0,
    evidenceYield: 0,
    consecutiveLowYieldBatches: 0,
    ...patch,
  };
}
