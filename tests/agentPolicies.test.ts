import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeGeneratedOutputPrompt,
} from "../src/agent/generatedOutputPolicy";
import {
  analyzeCurrentNoteResetPrompt,
} from "../src/agent/currentNoteResetPolicy";
import { planLoopBudget } from "../src/agent/loopPlanner";
import { decideNextLoopAction } from "../src/agent/loopDecision";
import {
  canApplyProjectMemoryLoad,
  getProjectMemoryLocation,
} from "../src/agent/projectMemory";
import {
  deriveAutonomyScope,
  extractExplicitNewWorkspaceFilePaths,
  extractExplicitWorkspaceReadFilePaths,
  extractMarkdownPathMentions,
  hasExplicitCurrentNoteMutationIntent,
} from "../src/agent/missionScope";

test("explicit repository file sets are extracted without adjacent mission paths", () => {
  const prompt = [
    "Write accepted research to Projects/Checkers/Research.md.",
    "Add only README.md, checkers/__init__.py, checkers/cli.py, checkers/game.py, and tests/test_checkers.py.",
    "Leave scripts/verify_project.py unchanged and then validate.",
  ].join(" ");
  assert.deepEqual(extractExplicitNewWorkspaceFilePaths(prompt), [
    "README.md",
    "checkers/__init__.py",
    "checkers/cli.py",
    "checkers/game.py",
    "tests/test_checkers.py",
  ]);
  assert.deepEqual(
    extractExplicitNewWorkspaceFilePaths(
      "Do not create exactly safe.py, ../escape.py, or C:/private.py.",
    ),
    [],
  );
});

test("explicit workspace reads recognize affirmative protected contracts only", () => {
  assert.deepEqual(
    extractExplicitWorkspaceReadFilePaths(
      "Read the protected scripts/verify_project.py contract before implementation. Add only checkers/game.py. Leave scripts/verify_project.py unchanged.",
    ),
    ["scripts/verify_project.py"],
  );
  assert.deepEqual(
    extractExplicitWorkspaceReadFilePaths(
      "Do not read secrets/token.txt. Leave scripts/verify_project.py unchanged.",
    ),
    [],
  );
  assert.deepEqual(
    extractExplicitWorkspaceReadFilePaths(
      "Inspect ../escape.py and open C:/private.py.",
    ),
    [],
  );
});
import {
  hasExplicitNoWebIntent,
  hasExplicitPublicWebSignal,
  requiresWebEvidenceProof,
} from "../src/agent/evidenceIntent";
import type { MissionIntent } from "../src/tools/types";

test("generated output policy classifies prompt matrix targets", () => {
  const revolutionary = analyzeGeneratedOutputPrompt(
    "Generate me a 100 word essay on the history of the revolutionary war.",
  );
  assert.equal(revolutionary.kind, "essay");
  assert.equal(revolutionary.target, "current_note_append");
  assert.deepEqual(revolutionary.wordTarget, {
    target: 100,
    exact: false,
    tolerancePct: 10,
  });

  const steak = analyzeGeneratedOutputPrompt(
    "Tell me about how to cook the best steak, with a cast iron.",
  );
  assert.equal(steak.kind, "how_to");
  assert.equal(steak.target, "current_note_append");
  assert.equal(steak.requiresGrounding, false);

  const diagonalization = analyzeGeneratedOutputPrompt(
    "Walk me through how diagonalization works in Linear Algebra with grounded examples.",
  );
  assert.equal(diagonalization.kind, "explanation");
  assert.equal(diagonalization.target, "current_note_append");

  const diagram = analyzeGeneratedOutputPrompt(
    "Draw me a simple 3 block diagram that shows house, transportation, and workplace.",
  );
  assert.equal(diagram.kind, "diagram");
  assert.equal(diagram.target, "design_canvas");

  const userFlow = analyzeGeneratedOutputPrompt(
    "Create a user flow for onboarding and checkout.",
  );
  assert.equal(userFlow.kind, "diagram");
  assert.equal(userFlow.target, "design_canvas");

  const architecture = analyzeGeneratedOutputPrompt(
    "Draw a software architecture diagram for the Obsidian agent.",
  );
  assert.equal(architecture.kind, "diagram");
  assert.equal(architecture.target, "design_canvas");
});

test("generated output policy detects grounded quote prompts", () => {
  const policy = analyzeGeneratedOutputPrompt(
    "Write me a 300 word argumentative essay on Grapes of Wrath. Use text level quotation and citations.",
  );

  assert.equal(policy.kind, "essay");
  assert.equal(policy.requiresGrounding, true);
  assert.equal(policy.requiresTextQuotes, true);
  assert.deepEqual(policy.wordTarget, {
    target: 300,
    exact: false,
    tolerancePct: 10,
  });
});

test("current note reset policy separates delete-only from delete-then-write", () => {
  assert.deepEqual(
    analyzeCurrentNoteResetPrompt("Delete the current note."),
    { kind: "delete_current_note", reason: "delete_only" },
  );
  assert.deepEqual(
    analyzeCurrentNoteResetPrompt(
      "Delete the current note. Ensure the space is empty. I want you to write now, a 1000 word essay.",
    ),
    { kind: "replace_current_note", reason: "clear_then_write" },
  );
  assert.deepEqual(
    analyzeCurrentNoteResetPrompt(
      "Delete the current note, then create a new note for the essay.",
    ),
    {
      kind: "ask_for_new_note_path",
      reason: "delete_then_create_without_target",
    },
  );
});

test("current note reset policy treats keep-note clear wording as replace", () => {
  for (const prompt of [
    "Keep the note, but delete all the contents on the note. Start cleanly. Then write the essay again.",
    "Clear all contents on this page and write a new Grapes of Wrath essay.",
    "Start cleanly by emptying the current note, then draft the report.",
  ]) {
    assert.deepEqual(
      analyzeCurrentNoteResetPrompt(prompt),
      { kind: "replace_current_note", reason: "clear_then_write" },
      prompt,
    );
  }
});

test("loop planner reserves finalization for grounded generated writing", () => {
  const generated = analyzeGeneratedOutputPrompt(
    "Generate me a 1000 word essay on Grapes of Wrath with citations.",
  );
  const budget = planLoopBudget({
    prompt: "Generate me a 1000 word essay on Grapes of Wrath with citations.",
    route: "grounded_workflow",
    generated,
    configuredMaxSteps: 5,
  });

  assert.equal(budget.hardCap, 5);
  assert.equal(budget.finalizationReserve, 4);
  assert.equal(budget.toolStepBudget, 1);
  assert.deepEqual(budget.expectedTools, ["web_search", "web_fetch"]);
});

test("loop planner keeps vault-only evidence research off the web", () => {
  const prompt =
    "Do deep research across my notes about local retrieval coverage and synthesize the relevant evidence.";
  const budget = planLoopBudget({
    prompt,
    route: "grounded_workflow",
    generated: analyzeGeneratedOutputPrompt(prompt),
    configuredMaxSteps: 12,
  });

  assert.deepEqual(budget.expectedTools, [
    "semantic_search_notes",
    "read_markdown_files",
  ]);
});

test("explicit web research stays ahead of later repository validation", () => {
  const prompt = [
    "Research American checkers using exactly two public web sources and fetch both sources.",
    "Write the accepted research to the Obsidian notebook and create the Linear hierarchy.",
    "Implement the Python game in the trusted repository, run targeted validation, and commit it.",
    "Publish the verified commit to a private GitHub repository.",
  ].join(" ");
  const budget = planLoopBudget({
    prompt,
    route: "grounded_workflow",
    generated: analyzeGeneratedOutputPrompt(prompt),
    configuredMaxSteps: 100,
  });

  assert.deepEqual(budget.expectedTools, ["web_search", "web_fetch"]);
});

test("loop planner uses exact file reads for explicitly named markdown sources", () => {
  const prompt =
    "Read Sources/Alpha.md and Sources/Beta.md, then append two findings to the current note without replacing it.";
  const budget = planLoopBudget({
    prompt,
    route: "grounded_workflow",
    generated: analyzeGeneratedOutputPrompt(prompt),
    configuredMaxSteps: 12,
  });

  assert.deepEqual(budget.expectedTools, ["read_file", "read_file"]);
});

test("loop planner does not treat a markdown creation target as a read source", () => {
  const prompt =
    "Create folder Projects/New and create note Projects/New/Brief.md.";
  const budget = planLoopBudget({
    prompt,
    route: "tool_required",
    generated: analyzeGeneratedOutputPrompt(prompt),
    configuredMaxSteps: 12,
  });

  assert.deepEqual(budget.expectedTools, []);
});

test("generated count_words verification is local metadata proof, not web proof", () => {
  const prompt =
    "Write approximately 180 words to this note, then use count_words to verify the generated note length.";
  const budget = planLoopBudget({
    prompt,
    route: "tool_required",
    generated: analyzeGeneratedOutputPrompt(prompt),
    configuredMaxSteps: 12,
  });

  assert.deepEqual(budget.expectedTools, ["count_words"]);
  assert.equal(
    requiresWebEvidenceProof(prompt, {
      explicitMutation: true,
      requireWriteCompletion: true,
    } as MissionIntent),
    false,
  );
});

test("explicit vault-only scope outranks incidental negated web language", () => {
  const prompt =
    "Investigate my vault with semantic retrieval and batch reads. Do not use web or memory tools.";
  const intent = {
    explicitMutation: true,
    requireWriteCompletion: true,
  } as MissionIntent;

  assert.equal(hasExplicitNoWebIntent(prompt), true);
  assert.equal(hasExplicitPublicWebSignal(prompt), false);
  assert.equal(requiresWebEvidenceProof(prompt, intent), false);
});

test("vault paths containing source do not manufacture public-web intent", () => {
  const prompt =
    "Create E2E Agent Tests/crud-source-marker.md, read it back, then move it to E2E Agent Tests/crud-moved-marker.md.";
  const intent = {
    explicitMutation: true,
    requireWriteCompletion: true,
  } as MissionIntent;
  assert.equal(hasExplicitPublicWebSignal(prompt), false);
  assert.equal(requiresWebEvidenceProof(prompt, intent), false);
  assert.equal(
    hasExplicitPublicWebSignal(`${prompt} Then verify claims on the web.`),
    true,
  );
});

test("autonomy scope extracts a labeled spaced markdown path without preceding prose", () => {
  const target =
    "E2E Agent Tests/Mission Graph Guard/restart-complete-marker.md";
  const prompt = [
    "Append this exact marker to the current note: CURRENT_MARKER.",
    `Then append it to the existing markdown file ${target}: COMPLETE_MARKER.`,
  ].join(" ");
  const scope = deriveAutonomyScope(prompt, {
    noteOutput: true,
    explicitMutation: true,
    explicitPersistence: true,
  });

  assert.deepEqual(scope.read.files, [target]);
  assert.deepEqual(scope.write.files, [target]);
  assert.deepEqual(scope.write.folders, [
    "E2E Agent Tests/Mission Graph Guard",
  ]);
});

test("markdown path extraction preserves a spaced destination after into", () => {
  assert.deepEqual(
    extractMarkdownPathMentions(
      "Write the accepted research into E2E Agent Tests/DU06-checkers.md with citations.",
    ),
    ["E2E Agent Tests/DU06-checkers.md"],
  );
});

test("markdown path extraction does not absorb an earlier provider destination", () => {
  assert.deepEqual(
    extractMarkdownPathMentions(
      "Publish this accepted research package to Linear as an issue and save the accepted note at E2E Agent Tests/Accepted Research marker.md.",
    ),
    ["E2E Agent Tests/Accepted Research marker.md"],
  );
});

test("autonomy scope binds mutation-led spaced paths without widening current-note writes", () => {
  const allowedPath =
    "E2E Agent Tests/Mission Graph Guard/allowed-marker.md";
  const movedPath =
    "E2E Agent Tests/Mission Graph Guard/moved-marker.md";
  const prompt = [
    "Read the current note,",
    `create ${allowedPath} with an exact marker,`,
    `move it to ${movedPath}, then trash ${movedPath}.`,
  ].join(" ");

  assert.deepEqual(extractMarkdownPathMentions(prompt), [allowedPath, movedPath]);
  const scope = deriveAutonomyScope(prompt, {
    noteOutput: true,
    explicitMutation: true,
    explicitPersistence: true,
    explicitDelete: true,
  });
  assert.equal(scope.write.currentNote, false);
  assert.deepEqual(scope.write.files, [allowedPath, movedPath]);
});

test("delete-then-write keeps explicit current-note replacement authority", () => {
  const prompt =
    "Delete the current note. Ensure that the space is empty. Write a replacement essay now.";

  assert.equal(hasExplicitCurrentNoteMutationIntent(prompt), true);
  const scope = deriveAutonomyScope(prompt, {
    noteOutput: true,
    explicitMutation: true,
    explicitPersistence: true,
    explicitDelete: true,
  });
  assert.equal(scope.write.currentNote, true);
});

test("loop decision forces final answer after required tools are satisfied", () => {
  const decision = decideNextLoopAction(
    {
      successfulTools: ["web_search", "web_fetch"],
      failedTools: [],
      repeatedToolCalls: 0,
      requiredToolsSatisfied: true,
      finalizationReserved: true,
      writeCompleted: false,
    },
    {
      hardCap: 5,
      toolStepBudget: 4,
      finalizationReserve: 1,
      expectedTools: ["web_search", "web_fetch"],
      stopWhenSatisfied: true,
    },
  );

  assert.deepEqual(decision, {
    action: "force_final_no_tools",
    reason: "required_tools_satisfied",
  });
});

test("project memory paths live under the active note folder", () => {
  assert.deepEqual(getProjectMemoryLocation("Projects/Grapes.md"), {
    memoryFolder: "Projects/Agent Memory",
    conversationPath: "Projects/Agent Memory/conversation-history.json",
    researchIndexPath: "Projects/Agent Memory/research-memory-index.json",
    researchNotesFolder: "Projects/Agent Memory/Research",
  });

  assert.deepEqual(getProjectMemoryLocation("Root.md"), {
    memoryFolder: "Agent Memory",
    conversationPath: "Agent Memory/conversation-history.json",
    researchIndexPath: "Agent Memory/research-memory-index.json",
    researchNotesFolder: "Agent Memory/Research",
  });
});

test("project memory hydration is latest-request-wins and project-bound", () => {
  const firstProject = getProjectMemoryLocation("Projects/Alpha/Note.md");
  const secondProject = getProjectMemoryLocation("Projects/Beta/Note.md");
  const firstLoad = { generation: 1, location: firstProject };
  const secondLoad = { generation: 2, location: secondProject };

  assert.equal(
    canApplyProjectMemoryLoad(firstLoad, 2, secondProject),
    false,
    "an older read must not overwrite the latest project hydration",
  );
  assert.equal(
    canApplyProjectMemoryLoad(secondLoad, 2, firstProject),
    false,
    "a completed read must not cross the captured project boundary",
  );
  assert.equal(canApplyProjectMemoryLoad(secondLoad, 2, secondProject), true);
  assert.equal(
    canApplyProjectMemoryLoad(secondLoad, 3, secondProject),
    false,
    "a newer in-memory mutation invalidates an in-flight hydration",
  );
});
