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
import { getProjectMemoryLocation } from "../src/agent/projectMemory";

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
