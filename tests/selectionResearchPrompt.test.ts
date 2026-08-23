import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSelectionResearchPrompt,
  getSelectionResearchAction,
  isUsableContinuationLeadIn,
  isUsableEditorSelection,
  quickActionContractMarker,
  SELECTION_RESEARCH_ACTIONS,
  SELECTION_RESEARCH_MAX_CHARS,
  selectionResearchModeIsChatOnly,
  selectionResearchModeScope,
  type SelectionResearchMode,
} from "../src/agent/selectionResearchPrompt";
import { resolveNoteOutputPlan } from "../src/agent/noteOutputPolicy";
import { detectSectionTargetFromHeadingsV1 } from "../src/agent/sectionTarget";
import {
  hasCitationWorkIntent,
  hasCurrentPageWritebackIntent,
  hasVaultContextQuestionIntent,
} from "../src/agent/promptIntentClassifiers";
import { hasExplicitResearchPublicationIntent } from "../src/tools/researchPublicationTool";

/** Realistic research note headings, so section detection has something to match. */
const NOTE_HEADINGS = [
  { text: "Battery density review", level: 1 },
  { text: "Background", level: 2 },
  { text: "Open questions", level: 2 },
] as const;

function planFor(prompt: string, forceChatOnly = false) {
  return resolveNoteOutputPlan({
    prompt,
    forceChatOnly,
    hasActiveMarkdownNote: true,
    outputProfile: "active_or_new_note",
    enableStreaming: true,
    streamWritebackMode: "all_current_note_content_writes",
    autoTitleOnWrite: true,
  });
}

describe("selectionResearchPrompt", () => {
  it("builds stream-to-page prompts that request append writeback", () => {
    const result = buildSelectionResearchPrompt({
      selection: "  quantum battery density  ",
      notePath: "Notes/Research.md",
      mode: "stream_page",
    });
    assert.equal(result.mode, "stream_page");
    assert.equal(result.truncated, false);
    assert.match(result.prompt, /Notes\/Research\.md/);
    assert.match(result.prompt, /quantum battery density/);
    assert.match(result.prompt, /\[agentic-daily-use:DU-02\]/);
    assert.equal(result.dailyUseId, "DU-02");
    assert.match(result.prompt, /append a single cited findings section/);
    assert.match(result.prompt, /stream writeback onto the page/);
    assert.match(result.prompt, /web_search then web_fetch/);
    assert.doesNotMatch(result.prompt, /\bDo not replace\b/i);
    assert.doesNotMatch(result.prompt, /\ba clear\b/i);
    assert.doesNotMatch(result.prompt, /chat only/i);
  });

  it("builds chat-only prompts that forbid note writes", () => {
    const result = buildSelectionResearchPrompt({
      selection: "selected claim",
      notePath: "Inbox.md",
      mode: "chat_only",
    });
    assert.equal(result.mode, "chat_only");
    assert.match(result.prompt, /Keep the answer in chat only/);
    assert.match(result.prompt, /Do not write, append, or save/);
  });

  it("truncates long selections with a marker", () => {
    const selection = "x".repeat(SELECTION_RESEARCH_MAX_CHARS + 50);
    const result = buildSelectionResearchPrompt({
      selection,
      notePath: "Long.md",
      mode: "stream_page",
      maxChars: 500,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.selectionChars, selection.length);
    assert.match(result.prompt, /selection truncated/);
    assert.ok(result.prompt.length < selection.length);
  });

  it("rejects empty selections", () => {
    assert.equal(isUsableEditorSelection("   \n\t  "), false);
    assert.equal(isUsableEditorSelection("usable"), true);
  });

  it("stream-page selection prompt resolves to active note append stream", () => {
    const built = buildSelectionResearchPrompt({
      selection: "photosynthesis efficiency",
      notePath: "Science.md",
      mode: "stream_page",
    });
    const plan = planFor(built.prompt);
    assert.equal(plan.destination, "active_note");
    assert.equal(plan.mutation, "append");
    assert.equal(plan.delivery, "stream");
  });

  it("chat-only selection prompt stays in chat", () => {
    const built = buildSelectionResearchPrompt({
      selection: "photosynthesis efficiency",
      notePath: "Science.md",
      mode: "chat_only",
    });
    const plan = planFor(built.prompt, true);
    assert.equal(plan.destination, "chat");
    assert.equal(plan.reason, "force_chat_only");
  });
});

describe("selectionResearchPrompt quick action table", () => {
  it("gives every mode exactly one action with a unique command id", () => {
    const modes = SELECTION_RESEARCH_ACTIONS.map((action) => action.mode);
    assert.equal(new Set(modes).size, modes.length);
    const ids = SELECTION_RESEARCH_ACTIONS.map((action) => action.commandId);
    assert.equal(new Set(ids).size, ids.length);
    const labels = SELECTION_RESEARCH_ACTIONS.map((action) => action.label);
    assert.equal(new Set(labels).size, labels.length);
  });

  it("keeps the two shipped research command ids and labels byte-stable", () => {
    // Renaming either orphans a user hotkey and breaks e2e selectors.
    const web = getSelectionResearchAction("stream_page");
    assert.equal(web.commandId, "research-selection-web");
    assert.equal(web.label, "Research selection (web)");
    const chat = getSelectionResearchAction("chat_only");
    assert.equal(chat.commandId, "research-selection-chat-only");
    assert.equal(chat.label, "Research selection (chat only)");
  });

  it("routes every action into at least one context menu", () => {
    // Command-palette registration is unconditional; a mode that reaches
    // neither menu would be palette-only and break the stated symmetry.
    for (const action of SELECTION_RESEARCH_ACTIONS) {
      assert.ok(
        action.inEditorMenu || action.inFileMenu,
        `${action.commandId} reaches no context menu`,
      );
    }
  });

  it("puts selection actions in the editor menu and note actions in the file menu", () => {
    for (const action of SELECTION_RESEARCH_ACTIONS) {
      if (action.scope === "note") {
        assert.equal(action.inEditorMenu, false, action.commandId);
        assert.equal(action.inFileMenu, true, action.commandId);
      } else {
        assert.equal(action.inEditorMenu, true, action.commandId);
        assert.equal(action.inFileMenu, false, action.commandId);
      }
    }
  });

  it("keeps each context menu short enough to stay usable", () => {
    const editorItems = SELECTION_RESEARCH_ACTIONS.filter(
      (action) => action.inEditorMenu && action.scope === "selection",
    );
    const fileItems = SELECTION_RESEARCH_ACTIONS.filter(
      (action) => action.inFileMenu,
    );
    assert.ok(editorItems.length <= 4, `editor menu has ${editorItems.length} items`);
    assert.ok(fileItems.length <= 4, `file menu has ${fileItems.length} items`);
  });

  it("reports scope and chat-only from the same table the host registers from", () => {
    assert.equal(selectionResearchModeScope("continue_writing"), "cursor");
    assert.equal(selectionResearchModeScope("cite_selection"), "selection");
    assert.equal(selectionResearchModeScope("audit_note_citations"), "note");
    assert.equal(selectionResearchModeIsChatOnly("ask_vault"), true);
    assert.equal(selectionResearchModeIsChatOnly("cite_selection"), false);
  });

  it("gates only the Linear action on a Linear credential", () => {
    const gated = SELECTION_RESEARCH_ACTIONS.filter(
      (action) => action.requiresLinear === true,
    ).map((action) => action.mode);
    assert.deepEqual(gated, ["publish_note_to_linear"]);
  });

  it("marks non-DU-02 quick actions with their own contract marker", () => {
    for (const action of SELECTION_RESEARCH_ACTIONS) {
      const built = buildSelectionResearchPrompt({
        selection: "a".repeat(80),
        notePath: "Notes/Topic.md",
        mode: action.mode,
      });
      if (action.mode === "stream_page" || action.mode === "chat_only") {
        assert.equal(built.dailyUseId, "DU-02");
        continue;
      }
      assert.equal(built.dailyUseId, null);
      assert.ok(
        built.prompt.includes(quickActionContractMarker(action.mode)),
        `${action.mode} is missing its quick-action marker`,
      );
    }
  });

  it("names the target note in every quick action prompt", () => {
    for (const action of SELECTION_RESEARCH_ACTIONS) {
      const built = buildSelectionResearchPrompt({
        selection: "a".repeat(80),
        notePath: "Projects/Solid state.md",
        mode: action.mode,
      });
      assert.ok(
        built.prompt.includes("Projects/Solid state.md"),
        `${action.mode} prompt does not name the note`,
      );
    }
  });
});

describe("selectionResearchPrompt note-output routing", () => {
  /**
   * The failure this guards against is silent: a note-targeted prompt that
   * trips sectionTarget's ambiguity branch is answered in chat and writes
   * nothing, with no error anywhere.
   */
  function assertNotSectionAmbiguous(mode: SelectionResearchMode) {
    const built = buildSelectionResearchPrompt({
      selection: "a".repeat(80),
      notePath: "Notes/Topic.md",
      mode,
    });
    const target = detectSectionTargetFromHeadingsV1({
      prompt: built.prompt,
      headings: [...NOTE_HEADINGS],
    });
    assert.equal(
      target.ambiguous,
      false,
      `${mode} prompt reads as an unresolved section reference`,
    );
  }

  it("continue writing streams onto the active note and preserves the title", () => {
    const built = buildSelectionResearchPrompt({
      selection:
        "Solid-state cells trade ionic conductivity for stability, and the 2024 pouch results show",
      notePath: "Notes/Batteries.md",
      mode: "continue_writing",
    });
    const plan = planFor(built.prompt);
    assert.equal(plan.destination, "active_note");
    assert.equal(plan.mutation, "append");
    assert.equal(plan.delivery, "stream");
    assert.equal(plan.title, "preserve");
    assert.ok(hasCurrentPageWritebackIntent(built.prompt));
    assertNotSectionAmbiguous("continue_writing");
  });

  it("continue writing keeps the tail of a long lead-in, not its head", () => {
    const leadIn = `${"o".repeat(900)} THE JOIN POINT IS HERE`;
    const built = buildSelectionResearchPrompt({
      selection: leadIn,
      notePath: "Notes/Batteries.md",
      mode: "continue_writing",
      maxChars: 200,
    });
    assert.equal(built.truncated, true);
    assert.match(built.prompt, /THE JOIN POINT IS HERE/);
    assert.match(built.prompt, /earlier text omitted/);
  });

  it("cite this selection appends a Sources section and asks for real verification", () => {
    const built = buildSelectionResearchPrompt({
      selection: "Lithium metal anodes reach 400 Wh/kg in production cells.",
      notePath: "Notes/Batteries.md",
      mode: "cite_selection",
    });
    const plan = planFor(built.prompt);
    assert.equal(plan.destination, "active_note");
    assert.equal(plan.delivery, "stream");
    assert.match(built.prompt, /verify_citation/);
    assert.match(built.prompt, /resolve_citation/);
    assert.ok(hasCitationWorkIntent(built.prompt));
    assertNotSectionAmbiguous("cite_selection");
  });

  it("citation audit stays in chat and drives the citation tools", () => {
    const built = buildSelectionResearchPrompt({
      selection: "",
      notePath: "Notes/Batteries.md",
      mode: "audit_note_citations",
    });
    assert.equal(built.chatOnly, true);
    const plan = planFor(built.prompt, true);
    assert.equal(plan.destination, "chat");
    // Chat-only must hold even without the host's forceChatOnly flag, so a
    // resumed or replayed prompt cannot start writing into the note.
    assert.equal(planFor(built.prompt).destination, "chat");
    assert.ok(hasCitationWorkIntent(built.prompt));
    assert.match(built.prompt, /verified, unreachable, or not supported/);
  });

  it("key-point extraction appends a named section to the current note", () => {
    const built = buildSelectionResearchPrompt({
      selection: "",
      notePath: "Notes/Batteries.md",
      mode: "extract_note_structure",
    });
    const plan = planFor(built.prompt);
    assert.equal(plan.destination, "active_note");
    assert.equal(plan.title, "preserve");
    assert.match(built.prompt, /Append a Key points section/);
    assert.match(built.prompt, /read_file/);
    assertNotSectionAmbiguous("extract_note_structure");
  });

  it("ask my vault searches notes, cites paths, and never writes", () => {
    const built = buildSelectionResearchPrompt({
      selection: "What did I conclude about dendrite suppression?",
      notePath: "Notes/Batteries.md",
      mode: "ask_vault",
    });
    assert.equal(built.chatOnly, true);
    assert.equal(planFor(built.prompt).destination, "chat");
    assert.ok(hasVaultContextQuestionIntent(built.prompt));
    assert.match(built.prompt, /semantic_search_notes/);
    assert.match(built.prompt, /read_markdown_files/);
    assert.match(built.prompt, /not from the open web/);
  });

  it("Linear publication reads as an explicit research publication", () => {
    const built = buildSelectionResearchPrompt({
      selection: "",
      notePath: "Notes/Batteries.md",
      mode: "publish_note_to_linear",
    });
    assert.ok(
      hasExplicitResearchPublicationIntent(built.prompt),
      "publish prompt does not read as a research publication",
    );
    assert.match(built.prompt, /publish_research_to_linear/);
    // The publication tool re-derives the note path from the user mission, so
    // the exact path has to survive in the prompt text.
    assert.match(built.prompt, /Notes\/Batteries\.md/);
    assertNotSectionAmbiguous("publish_note_to_linear");
  });

  it("does not let a note-targeted quick action read as a whole-note replace", () => {
    for (const action of SELECTION_RESEARCH_ACTIONS) {
      if (action.chatOnly) continue;
      const built = buildSelectionResearchPrompt({
        selection: "a".repeat(80),
        notePath: "Notes/Topic.md",
        mode: action.mode,
      });
      const plan = planFor(built.prompt);
      assert.notEqual(
        plan.mutation,
        "replace",
        `${action.mode} would overwrite the note`,
      );
      assert.notEqual(
        plan.destination,
        "new_note",
        `${action.mode} would write to a different note than the one it names`,
      );
    }
  });
});

describe("continuation lead-in", () => {
  it("requires enough preceding prose to imitate", () => {
    assert.equal(isUsableContinuationLeadIn("too short"), false);
    assert.equal(isUsableContinuationLeadIn("   \n  "), false);
    assert.equal(
      isUsableContinuationLeadIn(
        "The 2024 pouch-cell results changed how the field reads cycle life.",
      ),
      true,
    );
  });
});
