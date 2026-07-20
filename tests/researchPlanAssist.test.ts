import assert from "node:assert/strict";
import test from "node:test";

import {
  createResearchPlan,
  createResearchPlanWithAssist,
  estimateDeterministicResearchConfidence,
  maybeAssistResearchSubquestions,
} from "../src/agent/researchPlan";

function researchIntent() {
  return {
    mode: "vault_context_answer" as const,
    vaultContext: true,
    noteOutput: false,
    explicitPersistence: false,
    explicitMutation: false,
    explicitDelete: false,
    allowAutonomousWrite: false,
    requireWriteCompletion: false,
    autonomyScope: {
      read: { currentNote: false, vault: false, folders: [], files: [], web: true },
      write: {
        currentNote: false,
        folders: [],
        files: [],
        artifacts: false,
        researchMemory: false,
      },
      destructive: {
        replaceCurrentNote: false,
        deleteCurrentNote: false,
        deletePaths: false,
      },
    },
  };
}

test("maybeAssistResearchSubquestions stays deterministic when confidence is high", async () => {
  const prompt = "Compare A vs B and list risks? What are the limitations and confidence?";
  const deterministicQuestions = [
    "Compare A versus B across the main criteria.",
    "List the primary risks for adopting A or B.",
    "Summarize limitations and confidence for the comparison.",
  ];
  assert.ok(
    estimateDeterministicResearchConfidence(prompt, deterministicQuestions) >= 0.55,
  );
  const result = await maybeAssistResearchSubquestions({
    prompt,
    mode: "deep_web",
    deterministicQuestions,
    utilityModelConfigured: true,
    assist: async () => ["Should not be used because confidence is high"],
  });
  assert.equal(result.source, "deterministic");
  assert.equal(result.questions.length, 3);
});

test("createResearchPlanWithAssist merges utility questions when confidence is low", async () => {
  const prompt = "Investigate onboarding validation briefly";
  const base = createResearchPlan({
    prompt,
    missionIntent: researchIntent(),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_web_sources",
    },
  });
  assert.ok(base);

  const assisted = await createResearchPlanWithAssist({
    prompt,
    missionIntent: researchIntent(),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_web_sources",
    },
    utilityModelConfigured: true,
    assist: async () => [
      "What retention effects follow shorter onboarding?",
      "Which validation gates catch write errors earliest?",
    ],
  });
  assert.ok(assisted);
  assert.ok(
    assisted!.subquestions.some((item) =>
      /retention|validation gates/i.test(item.question),
    ),
  );
});

test("createResearchPlanWithAssist ignores assist when utility model is not configured", async () => {
  let called = false;
  const assisted = await createResearchPlanWithAssist({
    prompt: "Investigate onboarding validation briefly",
    missionIntent: researchIntent(),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_web_sources",
    },
    utilityModelConfigured: false,
    assist: async () => {
      called = true;
      return ["Should not run"];
    },
  });
  assert.equal(called, false);
  assert.ok(assisted);
});
