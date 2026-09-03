import assert from "node:assert/strict";
import test from "node:test";

import {
  createResearchPlan,
  minDistinctDomainsForEffort,
  minEvidenceForSubquestion,
  normalizeResearchPlan,
  type ResearchPlan,
} from "../src/agent/researchPlan";
import { RESEARCH_EFFORT_TIER_ORDER } from "../src/agent/researchEffortPolicy";

/**
 * Per-sub-question evidence minima follow the effort tier the plan carries:
 * one usable source per evidence-bearing web question at quick/standard, two
 * at deep/extended, zero for the host-appended limitations/confidence
 * question (identified by its structural role, not its text), one for every
 * vault-side question at every tier. The distinct-domain floor rises to
 * three at deep/extended, bounded by the fetched-source count.
 */

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

const groundedRunPlan = {
  route: "grounded_workflow",
  slowPathReason: "needs_web_sources",
} as const;

function webMinima(plan: ResearchPlan): number[] {
  return plan.subquestions
    .filter((item) => item.requiredEvidenceType === "web_source" && item.minEvidence > 0)
    .map((item) => item.minEvidence);
}

test("minEvidenceForSubquestion pins the tier table", () => {
  const table: Record<(typeof RESEARCH_EFFORT_TIER_ORDER)[number], number> = {
    quick: 1,
    standard: 1,
    deep: 2,
    extended: 2,
  };
  for (const tier of RESEARCH_EFFORT_TIER_ORDER) {
    assert.equal(
      minEvidenceForSubquestion({ tier, requiredEvidenceType: "web_source" }),
      table[tier],
      `${tier} web question`,
    );
    assert.equal(
      minEvidenceForSubquestion({
        tier,
        requiredEvidenceType: "web_source",
        role: "limitations_confidence",
      }),
      0,
      `${tier} limitations question`,
    );
    assert.equal(
      minEvidenceForSubquestion({
        tier,
        requiredEvidenceType: "either",
        role: "limitations_confidence",
      }),
      0,
      `${tier} hybrid limitations question`,
    );
    // Vault-side questions keep the deep_vault rationale: two semantic
    // searches plus one content read must complete a gather at any tier.
    assert.equal(
      minEvidenceForSubquestion({ tier, requiredEvidenceType: "vault_note" }),
      1,
      `${tier} vault question`,
    );
  }
  // A legacy plan with no recorded tier reads as the quick/standard floor.
  assert.equal(minEvidenceForSubquestion({ requiredEvidenceType: "web_source" }), 1);
});

test("minDistinctDomainsForEffort raises the floor to three only at deep/extended", () => {
  for (const tier of ["quick", "standard"] as const) {
    assert.equal(minDistinctDomainsForEffort({ mode: "deep_web", tier, minFetchedSources: 4 }), 2);
    assert.equal(minDistinctDomainsForEffort({ mode: "deep_web", tier, minFetchedSources: 1 }), 1);
  }
  for (const tier of ["deep", "extended"] as const) {
    assert.equal(minDistinctDomainsForEffort({ mode: "deep_web", tier, minFetchedSources: 4 }), 3);
    assert.equal(minDistinctDomainsForEffort({ mode: "deep_hybrid", tier, minFetchedSources: 3 }), 3);
    // Still bounded by the fetched-source contract.
    assert.equal(minDistinctDomainsForEffort({ mode: "deep_web", tier, minFetchedSources: 2 }), 2);
    assert.equal(minDistinctDomainsForEffort({ mode: "deep_vault", tier, minFetchedSources: 0 }), 0);
  }
});

test("a deep plan reserves two sources per web question when the contract can fund it", () => {
  const plan = createResearchPlan({
    prompt:
      "Do deep research comparing solid-state and sodium-ion batteries using four sources; list the trade-offs.",
    missionIntent: researchIntent(),
    runPlan: groundedRunPlan,
  });
  assert.ok(plan);
  assert.equal(plan.effort?.tier, "deep");
  assert.equal(plan.sourceRequirements.minFetchedSources, 4);
  assert.equal(plan.sourceRequirements.minDistinctDomains, 3);
  const minima = webMinima(plan);
  assert.ok(minima.length >= 2, `expected at least two web questions, got ${minima.length}`);
  assert.ok(
    minima.every((value) => value >= 2),
    `every deep web question needs two sources: ${minima.join(",")}`,
  );
  assert.equal(
    minima.reduce((sum, value) => sum + value, 0),
    plan.sourceRequirements.minFetchedSources,
    "the sum of minima stays inside the fetched-source contract",
  );
});

test("the deep floor never inflates a closed source contract past what the ladder owes", () => {
  // Explicit two sources, comparative prompt -> deep tier, but the closed
  // contract funds one source per question; the sum must stay at two.
  const plan = createResearchPlan({
    prompt:
      "Do deep research comparing A and B using exactly two sources and list the risks.",
    missionIntent: researchIntent(),
    runPlan: groundedRunPlan,
  });
  assert.ok(plan);
  assert.equal(plan.effort?.tier, "deep");
  assert.equal(plan.sourceRequirements.minFetchedSources, 2);
  assert.equal(plan.sourceRequirements.minDistinctDomains, 2);
  const minima = webMinima(plan);
  assert.equal(minima.reduce((sum, value) => sum + value, 0), 2);
  assert.ok(minima.every((value) => value >= 1));
});

test("a standard plan keeps one source per question and the two-domain floor", () => {
  // No deep/current/comparative signal: the keyword floor finds no research
  // mode, so this rides the semantic-upgrade path the utility model uses.
  const plan = createResearchPlan({
    prompt: "Research sodium-ion battery progress with three sources.",
    missionIntent: researchIntent(),
    runPlan: groundedRunPlan,
    modeOverride: "deep_web",
  });
  assert.ok(plan);
  assert.equal(plan.effort?.tier, "standard");
  assert.equal(plan.sourceRequirements.minFetchedSources, 3);
  assert.equal(plan.sourceRequirements.minDistinctDomains, 2);
  const minima = webMinima(plan);
  assert.equal(minima.reduce((sum, value) => sum + value, 0), 3);
  // Front-loaded exactly as before the tier floor existed.
  assert.equal(minima[minima.length - 1], 1);
});

test("an effort ceiling of quick lowers the minima with the tier", () => {
  const plan = createResearchPlan({
    prompt:
      "Do deep research comparing solid-state and sodium-ion batteries using four sources; list the trade-offs.",
    missionIntent: researchIntent(),
    runPlan: groundedRunPlan,
    researchEffortCeiling: "quick",
  });
  assert.ok(plan);
  assert.equal(plan.effort?.tier, "quick");
  assert.equal(plan.sourceRequirements.minDistinctDomains, 2);
  const minima = webMinima(plan);
  assert.equal(minima.reduce((sum, value) => sum + value, 0), 4);
  assert.equal(minima[minima.length - 1], 1);
});

test("the host-appended limitations question is flagged structurally and exempt at every tier", () => {
  for (const [prompt, mode] of [
    ["Do deep research comparing A and B using four sources; list the trade-offs.", "deep_web"],
    [
      "Read the current note as vault context and do deep research comparing A and B with four web sources.",
      "deep_hybrid",
    ],
  ] as const) {
    const plan = createResearchPlan({
      prompt,
      missionIntent: researchIntent(),
      runPlan: groundedRunPlan,
    });
    assert.ok(plan);
    assert.equal(plan.mode, mode);
    assert.equal(plan.effort?.tier, "deep");
    const limitations = plan.subquestions.filter(
      (item) => item.role === "limitations_confidence",
    );
    assert.equal(limitations.length, 1, `${mode} carries exactly one flagged question`);
    assert.equal(limitations[0]?.minEvidence, 0);
    assert.equal(limitations[0]?.status, "complete");
    assert.equal(limitations[0], plan.subquestions[plan.subquestions.length - 1]);
  }
});

test("deep_vault minima stay at one so a search+read gather can complete", () => {
  const plan = createResearchPlan({
    prompt:
      "Do deep research across my vault about onboarding. Use semantic retrieval and read the returned notes. Do not use web or memory tools.",
    missionIntent: researchIntent(),
    runPlan: { route: "grounded_workflow", slowPathReason: "needs_vault_context" },
  });
  assert.ok(plan);
  assert.equal(plan.mode, "deep_vault");
  assert.equal(plan.effort?.tier, "deep");
  assert.equal(plan.sourceRequirements.minDistinctDomains, 0);
  for (const item of plan.subquestions) {
    assert.equal(item.requiredEvidenceType, "vault_note");
    assert.ok(item.minEvidence <= 1, `${item.id} minimum ${item.minEvidence}`);
  }
});

test("the DU-02 owned-source prompt stays within what its synthetic backend serves", () => {
  // e2e/daily-use-research.spec.ts DU-02: installOwnedWebBackend serves two
  // sources (alpha on primary.owned.example, beta on alternate-owned.example)
  // and the prompt closes the contract at "both returned sources". The tier
  // is deep (comparative, multi-part, current-evidence prompt), so this pins
  // that the deep minima demand exactly what the backend can satisfy: two
  // fetched sources across two domains, one vault read, no more.
  const prompt =
    "Read the current note as vault context. Search the web for the owned alpha and beta evidence, fetch both returned sources, and compare their deliberately conflicting conclusions about controlled onboarding validation. Append a ## Findings section with exactly two cited finding sentences, a ## Limitations section that explicitly says the two sources conflict, and a ## Confidence section that briefly calibrates confidence in light of that conflict to the current note. End each finding sentence with the exact source:<id>:passage:<start>-<end> identifier returned by the fetch result that supports it, and use both fetched passage identifiers. Include e2e-marker. Do not write before fetch, comparison, and verification.";
  const plan = createResearchPlan({
    prompt,
    missionIntent: { ...researchIntent(), explicitMutation: true, requireWriteCompletion: true },
    runPlan: groundedRunPlan,
    defaultMinFetchedSources: 3,
  });
  assert.ok(plan);
  assert.equal(plan.mode, "deep_hybrid");
  assert.equal(plan.effort?.tier, "deep");
  assert.deepEqual(plan.sourceRequirements, { minFetchedSources: 2, minDistinctDomains: 2 });
  assert.deepEqual(
    plan.subquestions.map((item) => [item.requiredEvidenceType, item.minEvidence]),
    [
      ["web_source", 2],
      ["vault_note", 1],
      ["either", 0],
    ],
  );
  assert.equal(plan.subquestions[2]?.role, "limitations_confidence");
});

test("normalizeResearchPlan carries the limitations role and never re-derives persisted minima", () => {
  const plan = createResearchPlan({
    prompt: "Do deep research comparing A and B using four sources; list the trade-offs.",
    missionIntent: researchIntent(),
    runPlan: groundedRunPlan,
  });
  assert.ok(plan);
  const persisted = JSON.parse(JSON.stringify(plan));
  // A persisted graph resumes verbatim: hand-edited minima survive a reload.
  persisted.subquestions[0].minEvidence = 7;
  const restored = normalizeResearchPlan(persisted);
  assert.ok(restored);
  assert.equal(restored.subquestions[0]?.minEvidence, 7);
  assert.equal(
    restored.subquestions[restored.subquestions.length - 1]?.role,
    "limitations_confidence",
  );
  assert.equal(
    restored.subquestions.filter((item) => item.role === "limitations_confidence").length,
    1,
  );
});
