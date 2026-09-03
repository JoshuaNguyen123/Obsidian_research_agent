import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCurrentNoteResetPrompt,
  hasPageContentClearIntent,
} from "../src/agent/currentNoteResetPolicy";
import { analyzeGeneratedOutputPrompt } from "../src/agent/generatedOutputPolicy";
import { detectExplicitReplaceIntent } from "../src/agent/noteOutputPolicy";
import {
  hasDeleteIntent,
  hasReplaceIntent,
  hasWholeNoteReplaceIntent,
  isRecentAssistantWritebackFollowup,
} from "../src/agent/promptIntentClassifiers";
import { hasAuthorizedCurrentNoteReplaceIntent } from "../src/agent/replaceIntent";

const DELETE_THEN_REWRITE =
  "Delete all the notes on the page, and re-write your essay from a more informative perspective. Tell me what is Genesis, what is it about, what is the lesson?";
const DELETE_FIRST = "Delete all the notes on the page first.";
const DELATE_FIRST = "Delate all the notes on the page first.";
const COPY_LAST_ESSAY = "Can you write this essay onto the page?";
const TRASH_CURRENT_NOTE = "Delete the current note.";

test("page-content clear is replace, not copy-last-reply or trash-file", () => {
  for (const prompt of [DELETE_THEN_REWRITE, DELETE_FIRST, DELATE_FIRST]) {
    assert.equal(hasPageContentClearIntent(prompt), true, prompt);
    assert.equal(isRecentAssistantWritebackFollowup(prompt), false, prompt);
    assert.equal(hasDeleteIntent(prompt), false, prompt);
    assert.equal(hasReplaceIntent(prompt), true, prompt);
    assert.equal(hasWholeNoteReplaceIntent(prompt), true, prompt);
    assert.equal(hasAuthorizedCurrentNoteReplaceIntent(prompt), true, prompt);
    assert.equal(detectExplicitReplaceIntent(prompt), true, prompt);
    assert.equal(
      analyzeGeneratedOutputPrompt(prompt).target,
      "current_note_replace",
      prompt,
    );
    assert.deepEqual(
      analyzeCurrentNoteResetPrompt(prompt),
      { kind: "replace_current_note", reason: "clear_then_write" },
      prompt,
    );
  }
});

test("copy-last-assistant-essay onto the page stays an append follow-up", () => {
  assert.equal(isRecentAssistantWritebackFollowup(COPY_LAST_ESSAY), true);
  assert.equal(hasPageContentClearIntent(COPY_LAST_ESSAY), false);
});

test("delete the current note still means trash the file", () => {
  assert.equal(hasPageContentClearIntent(TRASH_CURRENT_NOTE), false);
  assert.deepEqual(analyzeCurrentNoteResetPrompt(TRASH_CURRENT_NOTE), {
    kind: "delete_current_note",
    reason: "delete_only",
  });
});
