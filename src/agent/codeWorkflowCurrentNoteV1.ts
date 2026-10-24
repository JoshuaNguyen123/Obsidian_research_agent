/**
 * Whether a code workflow mission should leave the open note alone.
 *
 * The current-note intent classifiers read a prompt's words: "replace",
 * "edit", "page", "this file". A coding brief is full of them ("never replace
 * newer values", "use zero-based pages rather than page length") and none of
 * them is about the open note. A code workflow therefore neither prefetches
 * the current note nor plans a current-note route, unless its prompt names the
 * note itself: a current-note tool, or the current, active or open note.
 * "This file", "this page" and "this document" do not count: in a coding brief
 * they are the code being worked on.
 *
 * The baseline coding passes that broke this (agentic-coding pilot,
 * javascript-3 and python-2) failed before any tool call with "An active
 * markdown file is required", because a coding pass has no note open.
 */

/** read_current_file, append_to_current_section, highlight_current_file_phrase, … */
const CURRENT_NOTE_TOOL = /\b[a-z_]*_current_(?:file|section)[a-z_]*\b/iu;
const CURRENT_NOTE_WORDS =
  /\b(?:current|active|open|opened|focused)\s+(?:obsidian\s+)?(?:note|markdown(?:\s+(?:note|file))?)\b|\bthis\s+(?:obsidian\s+)?note\b|\bthe\s+note\s+(?:i\s+have\s+)?open\b/iu;

/** Does the prompt name the open note itself, as opposed to code words? */
export function namesCurrentNoteExplicitlyV1(prompt: string): boolean {
  return CURRENT_NOTE_TOOL.test(prompt) || CURRENT_NOTE_WORDS.test(prompt);
}

/** True for a code workflow whose prompt does not name the open note. */
export function codeWorkflowLeavesCurrentNoteAloneV1(
  prompt: string,
  codeWorkflowMission: boolean,
): boolean {
  return codeWorkflowMission && !namesCurrentNoteExplicitlyV1(prompt);
}
