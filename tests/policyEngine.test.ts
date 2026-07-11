import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveRoutedIntentFallback,
  evaluateToolPolicy,
  isMutatingToolName,
  resolvePolicyRoutedIntent,
  type ToolPolicyContext,
} from "../src/agent/policyEngine";
import type { RoutedMissionIntent } from "../src/agent/missionRouter";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import type { MissionIntent } from "../src/tools/types";
import { MAX_CODE_RUNS_PER_MISSION } from "../src/tools/constants";

function intentFixture(
  prompt: string,
  overrides: Partial<MissionIntent> = {},
): MissionIntent {
  const flags = {
    vaultContext: overrides.vaultContext ?? false,
    noteOutput: overrides.noteOutput ?? false,
    explicitPersistence: overrides.explicitPersistence ?? false,
    explicitMutation: overrides.explicitMutation ?? false,
    explicitDelete: overrides.explicitDelete ?? false,
  };
  return {
    mode: overrides.mode ?? "chat_only",
    ...flags,
    allowAutonomousWrite: overrides.allowAutonomousWrite ?? false,
    requireWriteCompletion: overrides.requireWriteCompletion ?? false,
    autonomyScope: overrides.autonomyScope ?? deriveAutonomyScope(prompt, flags),
  };
}

function routedIntent(
  overrides: Partial<RoutedMissionIntent> = {},
): RoutedMissionIntent {
  return {
    mode: "chat_answer",
    writeScope: "none",
    needsWebEvidence: false,
    needsVaultContext: false,
    needsCodeExecution: false,
    wordTarget: null,
    confidence: 1,
    rationale: "test",
    ...overrides,
  };
}

function policyContext(
  overrides: Partial<ToolPolicyContext> = {},
): ToolPolicyContext {
  return {
    toolName: "read_current_file",
    args: {},
    intent: routedIntent(),
    approvalGranted: false,
    isDesktop: true,
    writeAutonomy: false,
    ...overrides,
  };
}

test("policy blocks code tools off desktop and allows them on desktop", () => {
  for (const toolName of [
    "run_code_block",
    "write_workspace_file",
    "export_workspace_artifact",
    "install_code_dependency",
  ]) {
    const blocked = evaluateToolPolicy(
      policyContext({ toolName, isDesktop: false }),
    );
    assert.equal(blocked.action, "block", toolName);
    assert.ok(blocked.tags.includes("desktop_required"), toolName);
  }
  const allowed = evaluateToolPolicy(
    policyContext({
      toolName: "run_code_block",
      isDesktop: true,
      intent: routedIntent({ mode: "code_workflow", needsCodeExecution: true }),
    }),
  );
  assert.equal(allowed.action, "allow");
});

test("policy requires approval for dependency install until granted", () => {
  const pending = evaluateToolPolicy(
    policyContext({ toolName: "install_code_dependency" }),
  );
  assert.equal(pending.action, "require_approval");
  assert.ok(pending.tags.includes("dependency_install"));

  const granted = evaluateToolPolicy(
    policyContext({ toolName: "install_code_dependency", approvalGranted: true }),
  );
  assert.equal(granted.action, "allow");
});

test("policy requires approval for long code timeouts and allows short runs", () => {
  const longRun = evaluateToolPolicy(
    policyContext({
      toolName: "run_code_block",
      args: { language: "python", code: "print(1)", timeoutMs: 45000 },
    }),
  );
  assert.equal(longRun.action, "require_approval");
  assert.ok(longRun.tags.includes("long_code_timeout"));

  const approvedLongRun = evaluateToolPolicy(
    policyContext({
      toolName: "run_code_block",
      args: { language: "python", code: "print(1)", timeoutMs: 45000 },
      approvalGranted: true,
    }),
  );
  assert.equal(approvedLongRun.action, "allow");

  const shortRun = evaluateToolPolicy(
    policyContext({
      toolName: "run_code_block",
      args: { language: "python", code: "print(1)", timeoutMs: 5000 },
    }),
  );
  assert.equal(shortRun.action, "allow");
});

test("policy enforces the per-mission code run budget", () => {
  const withinBudget = evaluateToolPolicy(
    policyContext({
      toolName: "run_code_block",
      args: { language: "javascript", code: "console.log(1)" },
      codeRunCount: MAX_CODE_RUNS_PER_MISSION - 1,
    }),
  );
  assert.equal(withinBudget.action, "allow");

  const overBudget = evaluateToolPolicy(
    policyContext({
      toolName: "run_code_block",
      args: { language: "javascript", code: "console.log(1)" },
      codeRunCount: MAX_CODE_RUNS_PER_MISSION,
    }),
  );
  assert.equal(overBudget.action, "block");
  assert.ok(overBudget.tags.includes("code_run_budget"));

  const customCap = evaluateToolPolicy(
    policyContext({
      toolName: "run_code_block",
      args: { language: "javascript", code: "console.log(1)" },
      codeRunCount: 3,
      maxCodeRunsPerMission: 3,
    }),
  );
  assert.equal(customCap.action, "block");
  assert.match(customCap.reason, /3/);
});

test("policy blocks vault mutation tools when nothing authorizes writes", () => {
  const decision = evaluateToolPolicy(
    policyContext({
      toolName: "append_to_current_file",
      intent: routedIntent({ writeScope: "none" }),
    }),
  );
  assert.equal(decision.action, "block");
  assert.ok(decision.tags.includes("mutation_scope"));

  const memoryException = evaluateToolPolicy(
    policyContext({
      toolName: "append_research_memory",
      intent: routedIntent({ writeScope: "none" }),
    }),
  );
  assert.equal(memoryException.action, "allow");

  const autonomyOverride = evaluateToolPolicy(
    policyContext({
      toolName: "append_to_current_file",
      intent: routedIntent({ writeScope: "none" }),
      writeAutonomy: true,
    }),
  );
  assert.equal(autonomyOverride.action, "allow");
});

test("mutating tool detection covers write tools and skips read tools", () => {
  for (const name of [
    "append_to_current_file",
    "replace_current_file",
    "delete_path",
    "rename_current_file",
    "highlight_current_file_phrase",
    "create_design_canvas",
    "fill_template",
    "link_related_notes_in_current_file",
    "install_code_dependency",
    "export_workspace_artifact",
  ]) {
    assert.equal(isMutatingToolName(name), true, name);
  }
  for (const name of [
    "read_current_file",
    "web_search",
    "web_fetch",
    "semantic_search_notes",
    "count_words",
    "run_code_block",
  ]) {
    assert.equal(isMutatingToolName(name), false, name);
  }
});

test("routed intent fallback maps regex mission modes", () => {
  const chat = deriveRoutedIntentFallback({
    missionIntent: intentFixture("hello"),
    writeAutonomy: false,
    writeToolExposed: false,
  });
  assert.equal(chat.mode, "chat_answer");
  assert.equal(chat.writeScope, "none");

  const vaultRead = deriveRoutedIntentFallback({
    missionIntent: intentFixture("what do my notes say about running?", {
      mode: "vault_context_answer",
      vaultContext: true,
    }),
    writeAutonomy: false,
    writeToolExposed: false,
  });
  assert.equal(vaultRead.mode, "vault_read");
  assert.equal(vaultRead.needsVaultContext, true);
  assert.equal(vaultRead.writeScope, "none");

  const noteOutput = deriveRoutedIntentFallback({
    missionIntent: intentFixture("write a 300 word essay on this page", {
      mode: "note_output",
      noteOutput: true,
    }),
    writeAutonomy: false,
    writeToolExposed: true,
  });
  assert.equal(noteOutput.mode, "vault_write");
  assert.equal(noteOutput.writeScope, "current_note_append");

  const deleteIntent = deriveRoutedIntentFallback({
    missionIntent: intentFixture("delete this note", {
      mode: "explicit_delete",
      explicitDelete: true,
      explicitMutation: true,
    }),
    writeAutonomy: false,
    writeToolExposed: true,
  });
  assert.equal(deleteIntent.writeScope, "current_note_replace");

  const exposedOnly = deriveRoutedIntentFallback({
    missionIntent: intentFixture("hello"),
    writeAutonomy: false,
    writeToolExposed: true,
  });
  assert.equal(exposedOnly.writeScope, "vault_files");
});

interface WordingParityCase {
  name: string;
  prompt: string;
  intent: Partial<MissionIntent>;
  writeToolExposed: boolean;
  toolName: string;
  expected: "allow" | "block";
}

// Wording-parity table sourced from docs/MISTAKES.md regressions: the policy
// layer must never block the tool each documented mission legitimately needs,
// and must keep blocking mutations that nothing authorized.
const WORDING_PARITY_CASES: WordingParityCase[] = [
  {
    name: "delete-then-write reset uses replace_current_file",
    prompt:
      "Delete all the notes on this page. After that write a 300 word essay on the history of AI onto this page.",
    intent: {
      mode: "explicit_file_mutation",
      noteOutput: true,
      explicitMutation: true,
    },
    writeToolExposed: true,
    toolName: "replace_current_file",
    expected: "allow",
  },
  {
    name: "highlight mission uses highlight_current_file_phrase",
    prompt:
      "Find where 'the general problem solver' is mentioned in this note and highlight it.",
    intent: { mode: "explicit_file_mutation", explicitMutation: true },
    writeToolExposed: true,
    toolName: "highlight_current_file_phrase",
    expected: "allow",
  },
  {
    name: "visible title rename uses rename_current_file",
    prompt: "Rename this note so the visible page title says Research Log.",
    intent: { mode: "explicit_file_mutation", explicitMutation: true },
    writeToolExposed: true,
    toolName: "rename_current_file",
    expected: "allow",
  },
  {
    name: "backup restore uses restore_current_file_from_backup",
    prompt: "Undo the last change and restore this note from backup.",
    intent: { mode: "explicit_file_mutation", explicitMutation: true },
    writeToolExposed: true,
    toolName: "restore_current_file_from_backup",
    expected: "allow",
  },
  {
    name: "current market writeback appends to the current note",
    prompt:
      "Write onto this page a 300 word brief about the current online dating market.",
    intent: {
      mode: "note_output",
      noteOutput: true,
      explicitMutation: true,
    },
    writeToolExposed: true,
    toolName: "append_to_current_file",
    expected: "allow",
  },
  {
    name: "vault question must not mutate notes",
    prompt: "What did you learn about me from my notes?",
    intent: { mode: "vault_context_answer", vaultContext: true },
    writeToolExposed: false,
    toolName: "append_to_current_file",
    expected: "block",
  },
  {
    name: "chat answer must not delete paths",
    prompt: "Explain the difference between TCP and UDP.",
    intent: { mode: "chat_only" },
    writeToolExposed: false,
    toolName: "delete_path",
    expected: "block",
  },
  {
    name: "read-only research memory exception stays writable",
    prompt: "Continue the research on local LLM routers.",
    intent: { mode: "vault_context_answer", vaultContext: true },
    writeToolExposed: false,
    toolName: "append_research_memory",
    expected: "allow",
  },
];

test("MISTAKES.md wording-parity table keeps policy behavior-identical", () => {
  for (const parityCase of WORDING_PARITY_CASES) {
    const missionIntent = intentFixture(parityCase.prompt, parityCase.intent);
    const decision = evaluateToolPolicy(
      policyContext({
        toolName: parityCase.toolName,
        intent: deriveRoutedIntentFallback({
          missionIntent,
          writeAutonomy: missionIntent.allowAutonomousWrite,
          writeToolExposed: parityCase.writeToolExposed,
        }),
      }),
    );
    assert.equal(decision.action, parityCase.expected, parityCase.name);
  }
});

test("read tools always pass policy regardless of intent", () => {
  for (const toolName of [
    "read_current_file",
    "list_markdown_files",
    "web_search",
    "web_fetch",
    "semantic_search_notes",
    "count_words",
    "get_note_graph_context",
  ]) {
    const decision = evaluateToolPolicy(
      policyContext({
        toolName,
        intent: routedIntent({ writeScope: "none" }),
      }),
    );
    assert.equal(decision.action, "allow", toolName);
  }
});

test("authority-resolved intent still cannot enable replace when regex is append-only", () => {
  const regexIntent = deriveRoutedIntentFallback({
    missionIntent: intentFixture("append findings to this note", {
      mode: "note_output",
      noteOutput: true,
    }),
    writeAutonomy: false,
    writeToolExposed: true,
  });
  assert.equal(regexIntent.writeScope, "current_note_append");

  const resolved = resolvePolicyRoutedIntent({
    mode: "authority",
    modelIntent: routedIntent({
      writeScope: "current_note_replace",
      confidence: 0.98,
      mode: "vault_write",
    }),
    missionIntent: intentFixture("append findings to this note", {
      mode: "note_output",
      noteOutput: true,
    }),
    writeAutonomy: false,
    writeToolExposed: true,
  });
  assert.equal(resolved.source, "model");
  assert.equal(resolved.intent.writeScope, "current_note_append");

  // Policy still allows append under the clamped scope.
  const appendAllowed = evaluateToolPolicy(
    policyContext({
      toolName: "append_to_current_file",
      intent: resolved.intent,
    }),
  );
  assert.equal(appendAllowed.action, "allow");
});

test("research gather phase blocks write tools even when write scope allows them", () => {
  const decision = evaluateToolPolicy(
    policyContext({
      toolName: "replace_current_file",
      intent: routedIntent({ writeScope: "current_note_replace" }),
      researchPhase: {
        phase: "gather",
        reason: "gathering",
        researchBearing: true,
        writeToolsAllowed: false,
        acceptanceAllowed: false,
        gatherComplete: false,
        analyzeComplete: false,
      },
    }),
  );
  assert.equal(decision.action, "block");
  assert.ok(decision.tags.includes("research_phase_gate"));
});

test("research gather phase still allows title rename setup mutations", () => {
  const phase = {
    phase: "gather" as const,
    reason: "gathering",
    researchBearing: true,
    writeToolsAllowed: false,
    acceptanceAllowed: false,
    gatherComplete: false,
    analyzeComplete: false,
  };
  for (const toolName of ["rename_current_file", "retitle_current_file"]) {
    const decision = evaluateToolPolicy(
      policyContext({
        toolName,
        intent: routedIntent({ writeScope: "current_note_append" }),
        writeAutonomy: true,
        researchPhase: phase,
      }),
    );
    assert.equal(decision.action, "allow", toolName);
  }
});
