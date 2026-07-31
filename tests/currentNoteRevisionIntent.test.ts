import assert from "node:assert/strict";
import test from "node:test";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import { hasAuthorizedCurrentNoteReplaceIntent } from "../src/agent/replaceIntent";

/**
 * Regression corpus for the revision dead-end.
 *
 * A user wrote an essay into the current note, then said "rewrite it with some
 * more details". Nothing was written: `hasAuthorizedCurrentNoteReplaceIntent`
 * (which the host uses to authorize its streamed replace) said yes on the bare
 * verb, while `scope.destructive.replaceCurrentNote` demanded a noun such as
 * "note"/"document" and said no — so `replace_current_file` was filtered out of
 * the catalog while streaming had already suppressed `append_to_current_file`.
 * Zero write paths remained.
 *
 * These two predicates gate the same capability and must never disagree.
 */

function scopeFor(prompt: string) {
  return deriveAutonomyScope(prompt, {
    noteOutput: true,
    vaultContext: true,
    hasActiveMarkdownNote: true,
  });
}

const REVISION_PROMPTS = [
  // The exact phrasing that shipped broken — bare verb, pronoun referent.
  "rewrite it with some more details",
  "rewrite it",
  "revise it and go deeper on the engineering side",
  "expand it with real examples",
  // Noun-bearing forms that already worked; they must keep working.
  "Edit the essay you gave me with more details.",
  "Rewrite this note from scratch.",
];

for (const prompt of REVISION_PROMPTS) {
  test(`revision authority agrees for: "${prompt}"`, () => {
    const authorized = hasAuthorizedCurrentNoteReplaceIntent(prompt);
    const scoped = scopeFor(prompt).destructive.replaceCurrentNote;
    assert.equal(
      scoped,
      authorized,
      `replaceCurrentNote=${scoped} but hasAuthorizedCurrentNoteReplaceIntent=${authorized}. ` +
        "These gate the same capability; disagreement leaves the run with no write path.",
    );
    assert.equal(
      authorized,
      true,
      "this phrasing should authorize a current-note revision",
    );
  });
}

test("a plain question never authorizes replacing the note", () => {
  for (const prompt of [
    "What is passive thread locking?",
    "Summarize the differences for me in chat.",
    "Append a short note about mutexes.",
  ]) {
    assert.equal(
      scopeFor(prompt).destructive.replaceCurrentNote,
      false,
      `"${prompt}" must not authorize a whole-note replace`,
    );
  }
});

test("an explicit refusal is not replace authority", () => {
  // The negated-clause guard in replaceIntent.ts must survive the alignment.
  const prompt = "Do not rewrite the note; just answer in chat.";
  assert.equal(hasAuthorizedCurrentNoteReplaceIntent(prompt), false);
  assert.equal(scopeFor(prompt).destructive.replaceCurrentNote, false);
});

test("revision authority requires an active markdown note", () => {
  const scope = deriveAutonomyScope("rewrite it with some more details", {
    noteOutput: false,
    vaultContext: false,
    hasActiveMarkdownNote: false,
  });
  assert.equal(
    scope.destructive.replaceCurrentNote,
    false,
    "with no active note there is nothing to replace",
  );
});
