import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyEditOrganizeRoute,
  isCurrentNoteEditOrganizeIntent,
  isNamedSectionEditIntent,
  isVaultWideOrganizeIntent,
  isWholeNoteEditIntent,
  missingIncludesWriteReceipt,
  prefersStreamedReplaceForEditOrganize,
  receiptsSatisfyWriteProof,
  WRITE_RECEIPT_MISSING,
} from "../src/agent/editOrganizeIntent";
import { createRunPlan } from "../src/agent/runPlan";
import { evaluateCompletion } from "../src/agent/reflex/completionEvaluator";
import type { MissionIntent } from "../src/tools/types";
import type { ModelToolDefinition } from "../src/model/types";

const baseIntent: MissionIntent = {
  mode: "chat_only",
  vaultContext: false,
  noteOutput: false,
  explicitPersistence: false,
  explicitMutation: false,
  explicitDelete: false,
  allowAutonomousWrite: false,
  requireWriteCompletion: false,
  autonomyScope: {
    read: { currentNote: false, vault: false, folders: [], files: [], web: false },
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

function tool(name: string): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    },
  };
}

test("edit/organize intent matrix routes current note, vault clarify, whole note, and section", () => {
  const cases: Array<{
    prompt: string;
    route: ReturnType<typeof classifyEditOrganizeRoute>;
    currentNote: boolean;
    vaultWide: boolean;
    wholeNote: boolean;
    namedSection: boolean;
  }> = [
    {
      prompt: "Edit this page",
      route: "current_note_organize",
      currentNote: true,
      vaultWide: false,
      wholeNote: true,
      namedSection: false,
    },
    {
      prompt: "Organize the current note",
      route: "current_note_organize",
      currentNote: true,
      vaultWide: false,
      wholeNote: false,
      namedSection: false,
    },
    {
      prompt: "Clean up this page",
      route: "current_note_organize",
      currentNote: true,
      vaultWide: false,
      wholeNote: false,
      namedSection: false,
    },
    {
      prompt: "Organize my vault",
      route: "vault_organize_clarify",
      currentNote: false,
      vaultWide: true,
      wholeNote: false,
      namedSection: false,
    },
    {
      prompt: "Organize notes across folders",
      route: "vault_organize_clarify",
      currentNote: false,
      vaultWide: true,
      wholeNote: false,
      namedSection: false,
    },
    {
      prompt: "Edit the essay and add more detail",
      route: "whole_note_edit",
      currentNote: false,
      vaultWide: false,
      wholeNote: true,
      namedSection: false,
    },
    {
      prompt: "Revise the draft",
      route: "whole_note_edit",
      currentNote: false,
      vaultWide: false,
      wholeNote: true,
      namedSection: false,
    },
    {
      prompt: "Edit the Introduction section",
      route: "named_section_edit",
      currentNote: false,
      vaultWide: false,
      wholeNote: false,
      namedSection: true,
    },
    {
      prompt: 'Revise the "Goals" heading',
      route: "named_section_edit",
      currentNote: false,
      vaultWide: false,
      wholeNote: false,
      namedSection: true,
    },
    {
      prompt: "What time is it?",
      route: "other",
      currentNote: false,
      vaultWide: false,
      wholeNote: false,
      namedSection: false,
    },
  ];

  for (const item of cases) {
    assert.equal(
      classifyEditOrganizeRoute(item.prompt),
      item.route,
      item.prompt,
    );
    assert.equal(
      isCurrentNoteEditOrganizeIntent(item.prompt),
      item.currentNote,
      `currentNote: ${item.prompt}`,
    );
    assert.equal(
      isVaultWideOrganizeIntent(item.prompt),
      item.vaultWide,
      `vaultWide: ${item.prompt}`,
    );
    assert.equal(
      isWholeNoteEditIntent(item.prompt),
      item.wholeNote,
      `wholeNote: ${item.prompt}`,
    );
    assert.equal(
      isNamedSectionEditIntent(item.prompt),
      item.namedSection,
      `namedSection: ${item.prompt}`,
    );
  }
});

test("current-note edit/organize prefers streamed replace; vault-wide does not", () => {
  assert.equal(prefersStreamedReplaceForEditOrganize("Edit this page"), true);
  assert.equal(prefersStreamedReplaceForEditOrganize("Organize my vault"), false);
  assert.equal(prefersStreamedReplaceForEditOrganize("Edit the essay"), true);
});

test("receiptsSatisfyWriteProof and write_receipt missing helpers", () => {
  assert.equal(receiptsSatisfyWriteProof([]), false);
  assert.equal(
    receiptsSatisfyWriteProof([
      { toolName: "replace_current_file", operation: "replace", path: "Note.md" },
    ]),
    true,
  );
  assert.equal(
    receiptsSatisfyWriteProof([
      { toolName: "linear_create_issue", operation: "create", message: "Created ENG-1" },
    ]),
    false,
  );
  assert.equal(
    receiptsSatisfyWriteProof([
      {
        toolName: "linear_create_issue",
        operation: "create",
        path: "Current.md",
        resource: { system: "linear" },
      },
    ]),
    false,
  );
  assert.equal(missingIncludesWriteReceipt([WRITE_RECEIPT_MISSING]), true);
  assert.equal(missingIncludesWriteReceipt(["vault_evidence"]), false);
});

test("runPlan routes current-note organize to writeback and vault organize to clarify", () => {
  const tools = [
    tool("replace_current_file"),
    tool("append_to_current_file"),
    tool("search_markdown_files"),
  ];

  const currentNote = createRunPlan({
    prompt: "Organize this note",
    missionIntent: {
      ...baseIntent,
      mode: "explicit_file_mutation",
      noteOutput: true,
      explicitMutation: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    },
    tools,
    streamingWritebackKind: "replace",
    directCurrentNoteWritebackKind: null,
  });
  assert.equal(currentNote.route, "single_model_writeback");
  assert.ok(
    currentNote.traceReasons.some((reason) =>
      reason.includes("streaming_writeback:replace"),
    ),
  );

  const vaultOrganize = createRunPlan({
    prompt: "Organize my vault",
    missionIntent: {
      ...baseIntent,
      mode: "vault_context_answer",
      vaultContext: true,
      requireWriteCompletion: false,
    },
    tools,
    streamingWritebackKind: null,
    directCurrentNoteWritebackKind: null,
  });
  assert.equal(vaultOrganize.route, "grounded_workflow");
  assert.ok(
    vaultOrganize.traceReasons.includes("vault_wide_organize_clarify"),
  );

  const sectionEdit = createRunPlan({
    prompt: "Edit the Introduction section",
    missionIntent: {
      ...baseIntent,
      mode: "explicit_file_mutation",
      explicitMutation: true,
      requireWriteCompletion: true,
    },
    tools: [...tools, tool("edit_current_section")],
    streamingWritebackKind: null,
    directCurrentNoteWritebackKind: null,
  });
  assert.equal(sectionEdit.route, "tool_required");
  assert.ok(sectionEdit.traceReasons.includes("named_section_edit"));
});

test("completion evaluator prefers write tools when write_receipt is missing", () => {
  const completion = evaluateCompletion({
    prompt: "Edit this page",
    missionIntent: {
      ...baseIntent,
      mode: "explicit_file_mutation",
      requireWriteCompletion: true,
      noteOutput: true,
      allowAutonomousWrite: true,
      explicitMutation: true,
    },
    allowedToolNames: new Set([
      "append_to_current_file",
      "replace_current_file",
      "semantic_search_notes",
    ]),
    recentActions: [],
    evidence: [],
    receipts: [],
  });

  assert.equal(completion.complete, false);
  assert.ok(completion.missing.includes(WRITE_RECEIPT_MISSING));
  assert.equal(completion.recommendedNextTool, "replace_current_file");
  assert.equal(completion.mustContinue, true);
});

test("stream receipt satisfies write_receipt completion", () => {
  const completion = evaluateCompletion({
    prompt: "Edit this page",
    missionIntent: {
      ...baseIntent,
      mode: "note_output",
      noteOutput: true,
      requireWriteCompletion: true,
    },
    allowedToolNames: new Set(["replace_current_file"]),
    recentActions: [],
    evidence: [],
    receipts: [
      {
        toolName: "replace_current_file",
        operation: "replace",
        path: "Current.md",
      },
    ],
  });

  assert.equal(completion.complete, true);
  assert.ok(!completion.missing.includes(WRITE_RECEIPT_MISSING));
});
