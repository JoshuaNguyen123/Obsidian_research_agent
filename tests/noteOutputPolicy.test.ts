import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectContentProducingIntent,
  detectChatOnlyIntent,
  resolveNoteOutputPlan,
  type NoteOutputPlan,
} from "../src/agent/noteOutputPolicy";

function plan(
  partial: Partial<Parameters<typeof resolveNoteOutputPlan>[0]> & {
    prompt: string;
  },
): NoteOutputPlan {
  return resolveNoteOutputPlan({
    hasActiveMarkdownNote: false,
    outputProfile: "active_or_new_note",
    enableStreaming: true,
    streamWritebackMode: "all_current_note_content_writes",
    autoTitleOnWrite: true,
    ...partial,
  });
}

describe("noteOutputPolicy decision table", () => {
  it("explicit chat only forbids vault writes", () => {
    const result = plan({
      prompt: "What is 2+2? Answer in chat only.",
      hasActiveMarkdownNote: true,
      contentProducing: true,
    });
    assert.equal(result.destination, "chat");
    assert.equal(result.reason, "explicit_chat_only");
  });

  it("forceChatOnly wins", () => {
    const result = plan({
      prompt: "Write a short summary of photosynthesis.",
      forceChatOnly: true,
      hasActiveMarkdownNote: true,
    });
    assert.equal(result.destination, "chat");
    assert.equal(result.reason, "force_chat_only");
  });

  it("trivial chat stays in chat", () => {
    const result = plan({ prompt: "hello" });
    assert.equal(result.destination, "chat");
    assert.equal(result.reason, "trivial_chat");
  });

  it("specialized routes are not coerced into default note stream", () => {
    const result = plan({
      prompt: "Run this python code and show stdout",
      specializedRoute: true,
      contentProducing: true,
    });
    assert.equal(result.destination, "chat");
    assert.equal(result.reason, "specialized_route");
  });

  it("content-producing with active note uses active_note append stream", () => {
    const result = plan({
      prompt: "Write a short explanation of gravity.",
      hasActiveMarkdownNote: true,
      activeNoteIsPlaceholder: false,
    });
    assert.equal(result.destination, "active_note");
    assert.equal(result.mutation, "append");
    assert.equal(result.delivery, "stream");
    assert.equal(result.title, "preserve");
    assert.equal(result.reason, "active_note_available");
  });

  it("placeholder active note allows automatic title", () => {
    const result = plan({
      prompt: "Draft a one-paragraph summary of the moon landing.",
      hasActiveMarkdownNote: true,
      activeNoteIsPlaceholder: true,
    });
    assert.equal(result.destination, "active_note");
    assert.equal(result.title, "automatic");
  });

  it("no active note with active_or_new_note creates a new note", () => {
    const result = plan({
      prompt: "Write a report on renewable energy trends.",
      hasActiveMarkdownNote: false,
      outputProfile: "active_or_new_note",
    });
    assert.equal(result.destination, "new_note");
    assert.equal(result.mutation, "create");
    assert.equal(result.delivery, "stream");
    assert.equal(result.title, "automatic");
    assert.equal(result.reason, "no_active_note_create");
  });

  it("no active note with chat_first stays in chat", () => {
    const result = plan({
      prompt: "Write a report on renewable energy trends.",
      hasActiveMarkdownNote: false,
      outputProfile: "chat_first",
    });
    assert.equal(result.destination, "chat");
    assert.equal(result.reason, "no_active_note_chat_first");
  });

  it("active_note_only without a file stays in chat", () => {
    const result = plan({
      prompt: "Explain photosynthesis in two paragraphs.",
      hasActiveMarkdownNote: false,
      outputProfile: "active_note_only",
    });
    assert.equal(result.destination, "chat");
    assert.equal(result.reason, "active_note_only_no_file");
  });

  it("explicit replace uses replace mutation on active note", () => {
    const result = plan({
      prompt: "Replace this note with a cleaner draft about bees.",
      hasActiveMarkdownNote: true,
    });
    assert.equal(result.destination, "active_note");
    assert.equal(result.mutation, "replace");
    assert.equal(result.reason, "replace_explicit");
  });

  it("preserve title wording suppresses automatic title", () => {
    const result = plan({
      prompt: "Write an essay about forests. Keep the title unchanged.",
      hasActiveMarkdownNote: true,
      activeNoteIsPlaceholder: true,
    });
    assert.equal(result.title, "preserve");
  });

  it("detect helpers match expected intents", () => {
    assert.equal(detectChatOnlyIntent("respond in chat please"), true);
    assert.equal(detectContentProducingIntent("hi"), false);
    assert.equal(
      detectContentProducingIntent("Write a summary of the Vietnam War"),
      true,
    );
  });
});
