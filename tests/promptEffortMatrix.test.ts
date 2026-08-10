import assert from "node:assert/strict";
import test from "node:test";
import {
  escalateMissionEffortDecisionForResearchV1,
  resolveMissionEffortDecisionV1,
  type MissionEffortDecisionV1,
} from "../src/agent/missionEffortDecision";

/**
 * Wide prompt matrix for the pre-execution effort decision.
 *
 * The decision is pure regex over the prompt, which makes it cheap to assert
 * one structural invariant across the whole space of realistic missions: no
 * prompt may end up with a budget that cannot possibly satisfy the contract
 * planning attaches to it. The 2026-08 "Provider execution budget exhausted
 * before mission acceptance" failures were exactly that shape — a compose
 * budget (6 calls / 4 tools / 3 min) carrying a grounded-research contract.
 */

interface MatrixCase {
  label: string;
  prompt: string;
  route: string;
  outputTarget: "chat" | "new_note" | "active_note";
}

const WRITE_BRIEF_PROMPTS: MatrixCase[] = [
  {
    label: "transformer brief with diagrams",
    prompt:
      "Can you write me a brief including diagrams, explaining in depth the transformer architecture and its importance?",
    route: "single_model_writeback",
    outputTarget: "new_note",
  },
  {
    label: "explainer note",
    prompt: "Write an explainer on how HTTP caching works, with examples.",
    route: "single_model_writeback",
    outputTarget: "new_note",
  },
  {
    label: "comparison table",
    prompt:
      "Create a note comparing REST and GraphQL trade-offs in a table with a recommendation.",
    route: "single_model_writeback",
    outputTarget: "new_note",
  },
  {
    label: "summary of current note",
    prompt: "Summarize this note into five bullet points.",
    route: "vault_context_answer",
    outputTarget: "active_note",
  },
  {
    label: "diagram request",
    prompt:
      "Draw a canvas diagram of our deployment pipeline and describe each stage.",
    route: "single_model_writeback",
    outputTarget: "new_note",
  },
];

const RESEARCH_PROMPTS: MatrixCase[] = [
  {
    label: "grounded market scan",
    prompt:
      "Research the current state of on-device LLMs using web sources and citations, then write a note.",
    route: "grounded_workflow",
    outputTarget: "new_note",
  },
  {
    label: "latest developments",
    prompt:
      "What are the latest developments in battery chemistry? Cite your sources.",
    route: "grounded_workflow",
    outputTarget: "new_note",
  },
  {
    label: "verify a claim",
    prompt:
      "Fact-check whether quantum supremacy has been independently verified; include evidence.",
    route: "grounded_workflow",
    outputTarget: "chat",
  },
  {
    label: "deep research",
    prompt:
      "Perform deep research into European energy policy since 2020 and produce an evidence ledger.",
    route: "grounded_workflow",
    outputTarget: "new_note",
  },
  {
    label: "systematic review",
    prompt:
      "Run a systematic review of retrieval-augmented generation evaluation methods.",
    route: "grounded_workflow",
    outputTarget: "new_note",
  },
];

const PIPELINE_PROMPTS: MatrixCase[] = [
  {
    label: "research into Linear issues",
    prompt:
      "Research competitor onboarding flows and turn the findings into Linear issues for the growth team.",
    route: "grounded_workflow",
    outputTarget: "new_note",
  },
  {
    label: "plan a Linear project",
    prompt:
      "Create a Linear project for the Q4 migration with milestones and a kickoff issue.",
    route: "single_model_writeback",
    outputTarget: "chat",
  },
  {
    label: "build a CLI tool",
    prompt:
      "Create a working Python CLI that converts CSV files to JSON, with tests.",
    route: "code_workflow",
    outputTarget: "chat",
  },
  {
    label: "code plus tests plus GitHub",
    prompt:
      "Write a TypeScript rate limiter, test it, and push the verified code to GitHub.",
    route: "code_workflow",
    outputTarget: "chat",
  },
  {
    label: "full loop",
    prompt:
      "Research CRDT libraries, file a Linear issue with the plan, implement a prototype, run its tests, publish it to GitHub, and reflect on the outcome.",
    route: "code_workflow",
    outputTarget: "new_note",
  },
  {
    label: "reflection request",
    prompt:
      "Review yesterday's mission receipts and write a reflection on what to improve.",
    route: "vault_context_answer",
    outputTarget: "new_note",
  },
];

const CONVERSATIONAL_PROMPTS: MatrixCase[] = [
  {
    label: "greeting",
    prompt: "hi",
    route: "single_model_answer",
    outputTarget: "chat",
  },
  {
    label: "thanks",
    prompt: "thanks!",
    route: "single_model_answer",
    outputTarget: "chat",
  },
  {
    label: "tiny question",
    prompt: "What is a monad?",
    route: "single_model_answer",
    outputTarget: "chat",
  },
];

const ALL_CASES: MatrixCase[] = [
  ...WRITE_BRIEF_PROMPTS,
  ...RESEARCH_PROMPTS,
  ...PIPELINE_PROMPTS,
  ...CONVERSATIONAL_PROMPTS,
];

function resolveCase(matrixCase: MatrixCase): MissionEffortDecisionV1 {
  return resolveMissionEffortDecisionV1({
    prompt: matrixCase.prompt,
    route: matrixCase.route,
    outputTarget: matrixCase.outputTarget,
  });
}

test("every prompt in the matrix gets a structurally viable budget", () => {
  for (const matrixCase of ALL_CASES) {
    const decision = resolveCase(matrixCase);
    assert.ok(
      decision.maxModelCalls >= 1,
      `${matrixCase.label}: model calls must be positive`,
    );
    assert.ok(
      decision.maxModelCalls >= decision.finalizationReserve.modelCalls,
      `${matrixCase.label}: finalization reserve cannot exceed the budget`,
    );
    assert.ok(
      decision.maxWallClockMs >= 60_000,
      `${matrixCase.label}: wall clock below one minute is unusable`,
    );
    if (matrixCase.outputTarget !== "chat") {
      assert.ok(
        decision.maxToolCalls >= 2,
        `${matrixCase.label}: note-writing missions need at least write + readback tools`,
      );
    }
  }
});

test("explicit grounding or extended-research prompts never get the compose budget", () => {
  for (const matrixCase of RESEARCH_PROMPTS) {
    const decision = resolveCase(matrixCase);
    assert.ok(
      decision.profile === "grounded_research" ||
        decision.profile === "extended_team",
      `${matrixCase.label}: expected research profile, got ${decision.profile}`,
    );
    assert.ok(
      decision.maxModelCalls >= 16,
      `${matrixCase.label}: research budget too small (${decision.maxModelCalls})`,
    );
    assert.ok(
      decision.maxToolCalls >= 12,
      `${matrixCase.label}: research tool budget too small (${decision.maxToolCalls})`,
    );
  }
});

test("a late-attached research contract escalates every prompt out of starvation", () => {
  // Planning can attach a fetched-source contract via a model-based assist
  // regardless of what the prompt regexes saw. Whatever profile a prompt
  // starts with, escalation must leave it able to fetch sources AND write —
  // at least the grounded_research floor.
  for (const matrixCase of ALL_CASES) {
    const decision = resolveCase(matrixCase);
    const escalated = escalateMissionEffortDecisionForResearchV1(decision, {
      researchContractAttached: true,
    });
    assert.ok(
      escalated.maxModelCalls >= 16,
      `${matrixCase.label}: escalated model budget ${escalated.maxModelCalls} < 16`,
    );
    assert.ok(
      escalated.maxToolCalls >= 12,
      `${matrixCase.label}: escalated tool budget ${escalated.maxToolCalls} < 12`,
    );
    assert.ok(
      escalated.maxWallClockMs >= 10 * 60_000,
      `${matrixCase.label}: escalated wall clock ${escalated.maxWallClockMs} < 10 minutes`,
    );
    assert.ok(
      escalated.maxModelCalls >= decision.maxModelCalls,
      `${matrixCase.label}: escalation must never lower the model budget`,
    );
    assert.ok(
      escalated.maxToolCalls >= decision.maxToolCalls,
      `${matrixCase.label}: escalation must never lower the tool budget`,
    );
  }
});

test("conversational prompts stay cheap", () => {
  for (const matrixCase of CONVERSATIONAL_PROMPTS) {
    const decision = resolveCase(matrixCase);
    assert.ok(
      decision.profile === "direct" || decision.profile === "compose",
      `${matrixCase.label}: conversational prompt should not buy a research budget (got ${decision.profile})`,
    );
    assert.ok(
      decision.maxModelCalls <= 6,
      `${matrixCase.label}: conversational budget should stay small (got ${decision.maxModelCalls})`,
    );
  }
});
