import test from "node:test";
import assert from "node:assert/strict";
import {
  filterMissionDesignCapabilityTools,
  hasDesignIntent,
  isResearchTopicDesignProse,
  missionGrantsDesignCapability,
} from "../src/agent/codeDesignIntent";
import {
  hasCanvasDesignIntent,
  hasDatasetPathMentionIntent,
  hasDesignPackageIntent,
  hasDocumentExtractIntent,
  hasGraphConnectionIntent,
  hasMermaidDesignIntent,
  hasResearchMemoryIntent,
  hasResearchMemoryReadIntent,
  hasSpecificFileReadIntent,
  hasVaultBrowseIntent,
  hasVaultContextQuestionIntent,
  hasWebSearchIntent,
} from "../src/agent/promptIntentClassifiers";
import { analyzeGeneratedOutputPrompt } from "../src/agent/generatedOutputPolicy";
import { planLoopBudget } from "../src/agent/loopPlanner";
import { getRequiredWriteToolNamesForTests } from "../src/AgentRunner";

// The two missions that terminally blocked live lead continuations on
// 2026-08-24: their topic prose ("transformer architecture", "distributed
// systems") sits within regex reach of the note-writing verb, so the broad
// design classifier fires even though the only requested deliverable is a
// note. Planting design capability for them schedules a write the research
// phase gate refuses, and the mission graph blocks on the deferred
// create_design_* node.
const TRANSFORMER_MISSION =
  "Research the attention mechanism of the transformer architecture as introduced in the paper Attention Is All You Need, and write a short note on how it works and why it displaced recurrence. Use current sources and citations.";
const CAP_MISSION =
  "Research what the CAP theorem states about distributed systems and write a short note on it in your own words (paraphrase, no verbatim quotations). Use current sources and citations.";

// A researcher handoff summary is design-flavored almost by definition for
// these topics. It must never reach the design classifiers: only the
// persisted original mission is authority for a continuation replan.
const DESIGN_FLAVORED_HANDOFF_SUMMARY = [
  "## Evidence Handoff: Transformer Attention Mechanism",
  "The transformer architecture eschews recurrence entirely.",
  "System design considerations: distributed systems built on attention",
  "layers can model the full dependency map in one parallel step.",
].join("\n");

const CANVAS_MISSION =
  "Research the CAP theorem and create a design canvas that maps its trade-offs. Use current sources and citations.";

const DESIGN_WRITE_TOOL_CANDIDATES = [
  "append_to_current_file",
  "create_design_canvas",
  "create_design_package",
  "create_svg_design",
];

test("research topic design prose is classified apart from design deliverables", () => {
  for (const mission of [TRANSFORMER_MISSION, CAP_MISSION]) {
    assert.equal(
      hasDesignIntent(mission),
      true,
      `broad design intent still fires on topic prose: ${mission}`,
    );
    assert.equal(
      isResearchTopicDesignProse(mission),
      true,
      `topic prose must be recognized: ${mission}`,
    );
  }
  // A mission that names a visual artifact is a design deliverable.
  assert.equal(isResearchTopicDesignProse(CANVAS_MISSION), false);
  // A design mission without the research-note shape keeps its capability.
  assert.equal(
    isResearchTopicDesignProse(
      "Architect a globally distributed system with failover and observability.",
    ),
    false,
  );
  // No design intent at all: the predicate stays quiet.
  assert.equal(
    isResearchTopicDesignProse(
      "Explain how distributed systems reach consensus.",
    ),
    false,
  );
});

test("architecture and distributed-systems subject matter do not need research|investigate", () => {
  const architectureNote =
    "Write a short note on transformer architecture and how self-attention works.";
  const distributedNote =
    "Draft an essay about distributed systems and the CAP trade-offs.";
  const workingMemoryNote =
    "Write a note about working memory and how it relates to attention.";
  for (const mission of [architectureNote, distributedNote, workingMemoryNote]) {
    assert.equal(
      isResearchTopicDesignProse(mission),
      true,
      `narrative note about a design-flavored topic must be topic prose: ${mission}`,
    );
    assert.equal(
      missionGrantsDesignCapability(mission),
      false,
      `must not grant design capability: ${mission}`,
    );
    assert.equal(hasCanvasDesignIntent(mission), false, mission);
    assert.equal(hasDesignPackageIntent(mission), false, mission);
  }
});

test("working memory and References as subject matter do not plant vault or graph nodes", () => {
  const workingMemory =
    "Write a note about working memory and how it relates to attention.";
  const referencesHeading =
    "Write a short note on attention. Include a References section.";
  assert.equal(hasResearchMemoryIntent(workingMemory), false);
  assert.equal(hasGraphConnectionIntent(workingMemory), false);
  assert.equal(hasVaultBrowseIntent(workingMemory), false);
  assert.equal(hasVaultContextQuestionIntent(workingMemory), false);
  assert.equal(hasGraphConnectionIntent(referencesHeading), false);
  assert.equal(hasVaultContextQuestionIntent(referencesHeading), false);
  assert.equal(
    hasGraphConnectionIntent("What notes is this note connected to?"),
    true,
  );
});

test("ROI WS1 classifier pins: web not vault-browse, memory, arxiv, dest helpers", () => {
  assert.equal(hasVaultBrowseIntent("include a list of sources"), false);
  assert.equal(hasWebSearchIntent("include a list of sources"), true);
  assert.equal(hasVaultBrowseIntent("career path"), false);
  assert.equal(
    hasVaultBrowseIntent("Write an essay about computer files."),
    false,
  );
  assert.equal(hasVaultBrowseIntent("list files"), true);
  assert.equal(hasVaultBrowseIntent("Inspect the vault structure with tools."), true);
  assert.equal(hasVaultBrowseIntent("browse my notes"), true);

  assert.equal(hasResearchMemoryReadIntent("human memory"), false);
  assert.equal(hasResearchMemoryReadIntent("transformer memory"), false);
  assert.equal(hasResearchMemoryReadIntent("memory hierarchy"), false);
  assert.equal(hasResearchMemoryReadIntent("working memory"), false);
  assert.equal(hasResearchMemoryReadIntent("read research memory"), true);
  assert.equal(
    hasResearchMemoryReadIntent("Recall the research on photosynthesis"),
    true,
  );

  assert.equal(
    hasSpecificFileReadIntent("https://arxiv.org/abs/1706.03762"),
    false,
  );
  assert.equal(
    hasWebSearchIntent("Research this paper: https://arxiv.org/abs/1706.03762"),
    true,
  );

  assert.equal(hasDatasetPathMentionIntent("Results.json"), true);
  assert.equal(hasMermaidDesignIntent("Add a flowchart to this note"), true);
  assert.equal(
    hasDocumentExtractIntent("https://www.nature.com/articles/s41586-023-example.pdf"),
    true,
  );
  assert.equal(hasDocumentExtractIntent("open this Nature paper"), true);
});

test("a research-note continuation with a design-flavored handoff plans no create_design_* node", () => {
  // The handoff prose itself would fire the design classifier — which is
  // exactly why a continuation must classify only the original mission.
  assert.equal(hasDesignIntent(DESIGN_FLAVORED_HANDOFF_SUMMARY), true);

  for (const mission of [TRANSFORMER_MISSION, CAP_MISSION]) {
    // Continuation replans recompute the loop budget from the restored
    // original mission; that recompute must not manufacture design debt.
    const generated = analyzeGeneratedOutputPrompt(mission);
    assert.notEqual(generated.kind, "diagram", mission);
    const budget = planLoopBudget({
      prompt: mission,
      route: "grounded_workflow",
      generated,
      configuredMaxSteps: 13,
    });
    assert.equal(
      budget.expectedTools.some((name) => name.startsWith("create_design")) ||
        budget.expectedTools.includes("create_svg_design"),
      false,
      `no design tool expected for ${mission}: ${budget.expectedTools.join(", ")}`,
    );
    // Research retrieval must still be planned.
    assert.deepEqual(budget.expectedTools, ["web_search", "web_fetch"]);

    // The narrative write requirement must survive; the design branch must
    // not steal it into a specialized design workflow.
    const required = getRequiredWriteToolNamesForTests(
      mission,
      DESIGN_WRITE_TOOL_CANDIDATES,
    );
    assert.ok(
      required.includes("append_to_current_file"),
      `note writeback stays required for ${mission}: ${required.join(", ")}`,
    );
    assert.equal(
      required.some(
        (name) =>
          name.startsWith("create_design") || name === "create_svg_design",
      ),
      false,
      `no design write required for ${mission}: ${required.join(", ")}`,
    );

    // A mis-planned prior segment persisted design capability into its loop
    // budget. The continuation merge must drop only that capability and keep
    // the mission's research and write tools.
    const inherited = filterMissionDesignCapabilityTools(
      [
        "create_design_canvas",
        "web_search",
        "web_fetch",
        "append_to_current_file",
      ],
      mission,
    );
    assert.deepEqual(inherited, [
      "web_search",
      "web_fetch",
      "append_to_current_file",
    ]);
  }
});

test("a mission that genuinely requests a design canvas keeps its design node on continuation", () => {
  assert.equal(isResearchTopicDesignProse(CANVAS_MISSION), false);
  const generated = analyzeGeneratedOutputPrompt(CANVAS_MISSION);
  assert.equal(generated.kind, "diagram");
  const budget = planLoopBudget({
    prompt: CANVAS_MISSION,
    route: "grounded_workflow",
    generated,
    configuredMaxSteps: 13,
  });
  assert.deepEqual(budget.expectedTools, ["create_design_canvas"]);

  const required = getRequiredWriteToolNamesForTests(
    CANVAS_MISSION,
    DESIGN_WRITE_TOOL_CANDIDATES,
  );
  assert.ok(
    required.includes("create_design_canvas"),
    `design write stays required: ${required.join(", ")}`,
  );

  // The continuation merge keeps the persisted design capability untouched.
  const inherited = filterMissionDesignCapabilityTools(
    ["create_design_canvas", "web_search", "web_fetch"],
    CANVAS_MISSION,
  );
  assert.deepEqual(inherited, [
    "create_design_canvas",
    "web_search",
    "web_fetch",
  ]);
});

// A research mission with NO design vocabulary at all. The design-prose
// predicate is false for it (it requires broad design intent), so a
// continuation filter keyed on that predicate alone is a no-op — and a
// mis-planned prior segment's persisted create_design_* expected tools sail
// through the continuation merges and replant the design node the research
// phase gate refuses (live lead continuations, 2026-08-24). Only the original
// mission's own design capability may admit design tools into a continuation
// replan.
const PLAIN_RESEARCH_MISSION =
  "Research the self-attention mechanism from the paper Attention Is All You Need and write a short note on how it works. Use current sources and citations.";

// Verbatim from the poisoned live lead ledger
// (run-2026-08-24t21-45-56.339z-8c700b473b14-lead loopBudget.expectedTools).
const POISONED_LEDGER_EXPECTED_TOOLS = [
  "create_design_canvas",
  "web_search",
  "web_fetch",
  "create_design_package",
  "append_to_current_file",
];

test("a lead continuation cannot re-acquire design tools its original mission never planned", () => {
  // The hole shape: no design vocabulary anywhere in the original mission.
  assert.equal(hasDesignIntent(PLAIN_RESEARCH_MISSION), false);
  assert.equal(isResearchTopicDesignProse(PLAIN_RESEARCH_MISSION), false);
  assert.equal(missionGrantsDesignCapability(PLAIN_RESEARCH_MISSION), false);

  // Every research-note mission — with or without design-flavored topic
  // nouns — must shed inherited design capability on the continuation merge.
  for (const mission of [
    PLAIN_RESEARCH_MISSION,
    TRANSFORMER_MISSION,
    CAP_MISSION,
  ]) {
    assert.equal(
      missionGrantsDesignCapability(mission),
      false,
      `research-note mission must not grant design capability: ${mission}`,
    );
    assert.deepEqual(
      filterMissionDesignCapabilityTools(
        POISONED_LEDGER_EXPECTED_TOOLS,
        mission,
      ),
      ["web_search", "web_fetch", "append_to_current_file"],
      `poisoned design tools must be dropped for ${mission}`,
    );
  }

  // Missions whose own prompt grants design capability keep it, fresh and on
  // continuation: an explicit visual deliverable and a design revision.
  assert.equal(missionGrantsDesignCapability(CANVAS_MISSION), true);
  const reviseMission =
    "Update the flowchart canvas to add a caching layer between the API and the database.";
  assert.equal(missionGrantsDesignCapability(reviseMission), true);
  assert.deepEqual(
    filterMissionDesignCapabilityTools(
      ["read_design_canvas", "update_design_canvas", "read_current_file"],
      reviseMission,
    ),
    ["read_design_canvas", "update_design_canvas", "read_current_file"],
  );
});
