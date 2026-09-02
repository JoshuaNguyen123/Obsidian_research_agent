import assert from "node:assert/strict";
import test from "node:test";

import { hasExplicitNoNoteWriteIntent } from "../src/agent/noNoteWriteIntent";
import {
  detectChatOnlyIntent,
  resolveNoteOutputPlan,
} from "../src/agent/noteOutputPolicy";
import { analyzeGeneratedOutputPrompt } from "../src/agent/generatedOutputPolicy";
import { classifyMissionSpeechAct } from "../src/agent/missionSpeechAct";
import {
  isWholeNoteEditIntent,
  prefersStreamedReplaceForEditOrganize,
} from "../src/agent/editOrganizeIntent";
import { hasAuthorizedCurrentNoteReplaceIntent } from "../src/agent/replaceIntent";
import {
  hasAppendIntent,
  hasChatOnlyResponseIntent,
  hasExplicitWritePersistenceIntent,
  hasReplaceIntent,
  hasWholeNoteRevisionIntent,
} from "../src/agent/promptIntentClassifiers";

const DU02_CACHE_READ =
  "Call web_fetch once for the exact already-fetched URL https://primary.owned.example/evidence/marker with refresh=false. Verify the cached passage is readable, do not search, and do not write or edit any note.";

const DU02_SOURCED_APPEND =
  "Search the web for the owned alpha and beta evidence, fetch both returned sources, and append a ## Findings section to the current note. Do not write before fetch, comparison, and verification.";

test("DU-02 cache read is an explicit no-note-write, not replace authority", () => {
  assert.equal(hasExplicitNoNoteWriteIntent(DU02_CACHE_READ), true);
  assert.equal(hasChatOnlyResponseIntent(DU02_CACHE_READ), true);
  assert.equal(detectChatOnlyIntent(DU02_CACHE_READ), true);
  assert.equal(isWholeNoteEditIntent(DU02_CACHE_READ), false);
  assert.equal(prefersStreamedReplaceForEditOrganize(DU02_CACHE_READ), false);
  assert.equal(hasAuthorizedCurrentNoteReplaceIntent(DU02_CACHE_READ), false);
  assert.equal(hasReplaceIntent(DU02_CACHE_READ), false);
  assert.equal(hasWholeNoteRevisionIntent(DU02_CACHE_READ), false);
  assert.equal(hasAppendIntent(DU02_CACHE_READ), false);
  assert.equal(hasExplicitWritePersistenceIntent(DU02_CACHE_READ), false);
  assert.equal(analyzeGeneratedOutputPrompt(DU02_CACHE_READ).target, "chat_only");
  const speech = classifyMissionSpeechAct(DU02_CACHE_READ);
  assert.equal(speech.explicitChatOnly, true);
  assert.equal(speech.speechAct, "execute");
  assert.equal(speech.executionTier, "bounded_tool");
  assert.equal(
    resolveNoteOutputPlan({
      prompt: DU02_CACHE_READ,
      hasActiveMarkdownNote: true,
      outputProfile: "active_or_new_note",
      enableStreaming: true,
      streamWritebackMode: "all_current_note_content_writes",
      autoTitleOnWrite: true,
    }).destination,
    "chat",
  );
});

test("sequencing 'do not write before fetch' does not forbid the sourced append", () => {
  assert.equal(hasExplicitNoNoteWriteIntent(DU02_SOURCED_APPEND), false);
  assert.equal(hasChatOnlyResponseIntent(DU02_SOURCED_APPEND), false);
  assert.equal(isWholeNoteEditIntent(DU02_SOURCED_APPEND), false);
  assert.equal(hasAppendIntent(DU02_SOURCED_APPEND), true);
  assert.equal(
    analyzeGeneratedOutputPrompt(DU02_SOURCED_APPEND).target,
    "current_note_append",
  );
});

test("legacy chat-only and selection-research phrasings still refuse writes", () => {
  for (const prompt of [
    "What is 2+2? Answer in chat only; do not write to the note.",
    "Keep the answer in chat only. Do not write, append, or save into the note unless I explicitly ask.",
    "Respond in chat please",
  ]) {
    assert.equal(hasExplicitNoNoteWriteIntent(prompt), true, prompt);
    assert.equal(detectChatOnlyIntent(prompt), true, prompt);
  }
});

test("affirmative edit/replace prompts stay authorized", () => {
  assert.equal(isWholeNoteEditIntent("Edit this page"), true);
  assert.equal(prefersStreamedReplaceForEditOrganize("Edit this page"), true);
  assert.equal(
    hasAuthorizedCurrentNoteReplaceIntent("Replace this note with a cleaner draft."),
    true,
  );
});
