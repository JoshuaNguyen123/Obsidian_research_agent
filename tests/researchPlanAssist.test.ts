import assert from "node:assert/strict";
import test from "node:test";

import {
  applyResearchEvidence,
  allowsResearchModeAssistActivation,
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

test("semantic mode assist refines an explicit source request", async () => {
  const prompt = "Write an essay on the causes of World War I using four sources.";
  const runPlan = {
    route: "grounded_workflow",
    slowPathReason: "needs_web_sources",
  } as const;

  // The keyword floor alone finds no research intent here.
  assert.equal(
    createResearchPlan({ prompt, missionIntent: researchIntent(), runPlan }),
    null,
  );

  // The model recognizes it warrants grounding and how many sources.
  const upgraded = await createResearchPlanWithAssist({
    prompt,
    missionIntent: researchIntent(),
    runPlan,
    utilityModelConfigured: true,
    modeAssist: async () => ({
      mode: "deep_web",
      sourceFloor: 4,
      rationale: "Historical claims should be grounded in sources.",
    }),
  });
  assert.ok(upgraded);
  assert.equal(upgraded!.mode, "deep_web");
  assert.equal(upgraded!.sourceRequirements.minFetchedSources, 4);
});

test("semantic mode assist cannot turn a stable composition request into web research", async () => {
  const prompt =
    "Can you write me a brief including diagrams, explaining in depth the transformer architecture and its importance?";
  const runPlan = {
    route: "grounded_workflow",
    slowPathReason: "needs_web_sources",
  } as const;
  const missionIntent = researchIntent();
  let modeAssistCalled = false;

  assert.equal(allowsResearchModeAssistActivation(prompt, missionIntent), false);
  const plan = await createResearchPlanWithAssist({
    prompt,
    missionIntent,
    runPlan,
    utilityModelConfigured: true,
    modeAssist: async () => {
      modeAssistCalled = true;
      return {
        mode: "deep_web",
        sourceFloor: 4,
        rationale: "Factual prose could be cited.",
      };
    },
  });

  assert.equal(plan, null);
  assert.equal(modeAssistCalled, false);
});

test("keyword floor still wins and the mode assist only fills silence", async () => {
  const prompt = "Do deep research and compare sources on renewable subsidies.";
  const runPlan = {
    route: "grounded_workflow",
    slowPathReason: "needs_web_sources",
  } as const;

  let modeAssistCalled = false;
  const plan = await createResearchPlanWithAssist({
    prompt,
    missionIntent: researchIntent(),
    runPlan,
    utilityModelConfigured: true,
    // Even a contrarian model cannot downgrade an explicit keyword signal,
    // because the assist is only consulted when the floor found nothing.
    modeAssist: async () => {
      modeAssistCalled = true;
      return { mode: "none" };
    },
  });
  assert.ok(plan);
  assert.notEqual(plan!.mode, "none");
  assert.equal(modeAssistCalled, false);
});

test("semantic activation is gated on a utility model and a non-none verdict", async () => {
  const prompt = "Write an essay on the causes of World War I.";
  const runPlan = {
    route: "grounded_workflow",
    slowPathReason: "needs_web_sources",
  } as const;

  let called = false;
  const notConfigured = await createResearchPlanWithAssist({
    prompt,
    missionIntent: researchIntent(),
    runPlan,
    utilityModelConfigured: false,
    modeAssist: async () => {
      called = true;
      return { mode: "deep_web" };
    },
  });
  assert.equal(called, false);
  assert.equal(notConfigured, null);

  // Model agrees no grounding is needed → stays a plain composition.
  const declined = await createResearchPlanWithAssist({
    prompt,
    missionIntent: researchIntent(),
    runPlan,
    utilityModelConfigured: true,
    modeAssist: async () => ({ mode: "none" }),
  });
  assert.equal(declined, null);

  // A malformed verdict is discarded (no upgrade).
  const garbage = await createResearchPlanWithAssist({
    prompt,
    missionIntent: researchIntent(),
    runPlan,
    utilityModelConfigured: true,
    modeAssist: async () => ({ mode: "turbo" } as never),
  });
  assert.equal(garbage, null);
});

test("semantic activation never upgrades a structurally non-research command", async () => {
  let called = false;
  const plan = await createResearchPlanWithAssist({
    prompt: "Delete my draft note.",
    missionIntent: { ...researchIntent(), explicitDelete: true },
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_web_sources",
    },
    utilityModelConfigured: true,
    // Even if the model over-eagerly wants to research, a delete command must
    // never become a grounded run.
    modeAssist: async () => {
      called = true;
      return { mode: "deep_web", sourceFloor: 3 };
    },
  });
  assert.equal(plan, null);
  assert.equal(called, false);
});

test("createResearchPlanWithAssist lets the model set the starting research depth", async () => {
  const prompt = "Investigate onboarding validation briefly";
  const runPlan = {
    route: "grounded_workflow",
    slowPathReason: "needs_web_sources",
  } as const;

  const deterministic = await createResearchPlanWithAssist({
    prompt,
    missionIntent: researchIntent(),
    runPlan,
    utilityModelConfigured: true,
    assist: async () => null,
  });
  assert.ok(deterministic);
  assert.notEqual(deterministic!.effort?.tier, "extended");

  const modelDeep = await createResearchPlanWithAssist({
    prompt,
    missionIntent: researchIntent(),
    runPlan,
    utilityModelConfigured: true,
    assist: async () => null,
    effortAssist: async () => ({
      tier: "extended",
      risk: "high",
      freshness: "required",
      rationale: "Broad, high-stakes investigation.",
    }),
  });
  assert.ok(modelDeep);
  assert.equal(modelDeep!.effort?.tier, "extended");
});

test("model effort assist is ignored without a utility model and validates its output", async () => {
  const prompt = "Investigate onboarding validation briefly";
  const runPlan = {
    route: "grounded_workflow",
    slowPathReason: "needs_web_sources",
  } as const;

  let called = false;
  const notConfigured = await createResearchPlanWithAssist({
    prompt,
    missionIntent: researchIntent(),
    runPlan,
    utilityModelConfigured: false,
    effortAssist: async () => {
      called = true;
      return { tier: "extended" };
    },
  });
  assert.equal(called, false);
  assert.ok(notConfigured);
  assert.notEqual(notConfigured!.effort?.tier, "extended");

  // A malformed assessment is discarded; the deterministic tier stands.
  const garbage = await createResearchPlanWithAssist({
    prompt,
    missionIntent: researchIntent(),
    runPlan,
    utilityModelConfigured: true,
    effortAssist: async () => ({ tier: "turbo" } as never),
  });
  assert.ok(garbage);
  assert.notEqual(garbage!.effort?.tier, "extended");
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
