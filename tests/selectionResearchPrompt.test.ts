import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSelectionResearchPrompt,
  isUsableEditorSelection,
  SELECTION_RESEARCH_MAX_CHARS,
} from "../src/agent/selectionResearchPrompt";
import { resolveNoteOutputPlan } from "../src/agent/noteOutputPolicy";

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
    assert.match(result.prompt, /Write and append a cited findings section/);
    assert.match(result.prompt, /stream writeback onto the page/);
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
    const plan = resolveNoteOutputPlan({
      prompt: built.prompt,
      hasActiveMarkdownNote: true,
      outputProfile: "active_or_new_note",
      enableStreaming: true,
      streamWritebackMode: "all_current_note_content_writes",
      autoTitleOnWrite: true,
    });
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
    const plan = resolveNoteOutputPlan({
      prompt: built.prompt,
      forceChatOnly: true,
      hasActiveMarkdownNote: true,
      outputProfile: "active_or_new_note",
      enableStreaming: true,
      streamWritebackMode: "all_current_note_content_writes",
      autoTitleOnWrite: true,
    });
    assert.equal(plan.destination, "chat");
    assert.equal(plan.reason, "force_chat_only");
  });
});
