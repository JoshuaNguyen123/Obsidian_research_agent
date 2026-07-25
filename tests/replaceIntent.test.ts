import assert from "node:assert/strict";
import test from "node:test";
import { hasAuthorizedCurrentNoteReplaceIntent } from "../src/agent/replaceIntent";

test("edit existing note to trim length authorizes replace_current_file", () => {
  const prompt =
    "It is slightly over 3000 words. Could you edit some sections of the existing note to get it closer to 3000 words?";
  assert.equal(hasAuthorizedCurrentNoteReplaceIntent(prompt), true);
});

test("word-count shortfall follow-ups authorize replace without classic rewrite words", () => {
  assert.equal(
    hasAuthorizedCurrentNoteReplaceIntent("The essay still isn't 3000 words."),
    true,
  );
  assert.equal(
    hasAuthorizedCurrentNoteReplaceIntent("make it 3000 words"),
    true,
  );
});

test("expand resume prompt authorizes replace", () => {
  const prompt = [
    "Write a 3000 word essay on catcher in the rye.",
    "",
    "The current note already has a partial draft under 3000 words.",
    "Expand that draft in place by editing and adding detail into the existing corpus until it reaches the soft ±5% band (2850–3150 words; target 3000).",
    "Prefer deepening thin sections over rewriting from scratch. Replace the note with one full expanded essay; do not append a second essay.",
  ].join("\n");
  assert.equal(hasAuthorizedCurrentNoteReplaceIntent(prompt), true);
});

test("plain write essay does not authorize replace", () => {
  assert.equal(
    hasAuthorizedCurrentNoteReplaceIntent(
      "Write a 3000 word essay on catcher in the rye and it's meaning. Write at a collegiant level.",
    ),
    false,
  );
});

test("negative non-note rewrite clause does not authorize current-note replacement", () => {
  const prompt = [
    "Create a repository workspace and append the verified reflection to the current note.",
    "Do not rewrite package.json or scripts.",
  ].join(" ");

  assert.equal(hasAuthorizedCurrentNoteReplaceIntent(prompt), false);
});
