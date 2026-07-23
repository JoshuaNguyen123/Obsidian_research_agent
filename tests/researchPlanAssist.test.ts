import assert from "node:assert/strict";
import test from "node:test";

import {
  applyResearchEvidence,
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
  assert.equal(
    assisted!.subquestions.reduce((sum, item) => sum + item.minEvidence, 0),
    base.subquestions.reduce((sum, item) => sum + item.minEvidence, 0),
  );
  assert.ok(
    assisted!.subquestions
      .filter((item) => /retention|validation gates/i.test(item.question))
      .every((item) => item.minEvidence === 0 && item.status === "complete"),
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

test("createResearchPlanWithAssist preserves an explicit closed source set", async () => {
  let called = false;
  const assisted = await createResearchPlanWithAssist({
    prompt:
      "Search the web, fetch both returned sources, compare their conflicting conclusions, and append exactly two cited findings.",
    missionIntent: researchIntent(),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_web_sources",
    },
    utilityModelConfigured: true,
    assist: async () => {
      called = true;
      return [
        "Invent an extra research question that would require another source.",
        "Invent another research question beyond the closed evidence set.",
      ];
    },
  });

  assert.equal(called, false);
  assert.ok(assisted);
  assert.equal(assisted!.sourceRequirements.minFetchedSources, 2);
  assert.equal(
    assisted!.subquestions
      .filter((item) => item.requiredEvidenceType === "web_source")
      .reduce((sum, item) => sum + item.minEvidence, 0),
    2,
  );
  const completed = applyResearchEvidence(assisted!, [
    {
      id: "vault:du02",
      kind: "vault_note",
      title: "Current note",
      summary: "Owned current-note context.",
      confidence: "high",
      path: "Current.md",
      passageIds: ["source:vault:passage:0-20"],
    },
    {
      id: "web:du02-alpha",
      kind: "web_source",
      title: "Alpha evidence",
      summary: "Alpha supports the controlled validation conclusion.",
      confidence: "high",
      url: "https://alpha.example/evidence",
      usableSource: true,
      parserStatus: "parsed",
      passageIds: ["source:alpha:passage:0-20"],
    },
    {
      id: "web:du02-beta",
      kind: "web_source",
      title: "Beta evidence",
      summary: "Beta conflicts with the controlled validation conclusion.",
      confidence: "high",
      url: "https://beta.example/evidence",
      usableSource: true,
      parserStatus: "parsed",
      passageIds: ["source:beta:passage:0-20"],
    },
  ]);
  assert.equal(completed.status, "complete");
});
