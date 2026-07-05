export type CurrentNoteResetAction =
  | { kind: "none" }
  | { kind: "replace_current_note"; reason: "clear_then_write" }
  | { kind: "delete_current_note"; reason: "delete_only" }
  | {
      kind: "ask_for_new_note_path";
      reason: "delete_then_create_without_target";
    };

export function analyzeCurrentNoteResetPrompt(
  prompt: string,
): CurrentNoteResetAction {
  const destructiveCurrentNote = hasCurrentNoteDeleteIntent(prompt);
  if (!destructiveCurrentNote) {
    return { kind: "none" };
  }

  if (hasCreateAnotherNoteIntent(prompt) && !hasExplicitMarkdownTarget(prompt)) {
    return {
      kind: "ask_for_new_note_path",
      reason: "delete_then_create_without_target",
    };
  }

  if (hasWriteAfterResetIntent(prompt)) {
    return { kind: "replace_current_note", reason: "clear_then_write" };
  }

  return { kind: "delete_current_note", reason: "delete_only" };
}

export function isCurrentNoteReplaceResetPrompt(prompt: string): boolean {
  return analyzeCurrentNoteResetPrompt(prompt).kind === "replace_current_note";
}

function hasCurrentNoteDeleteIntent(prompt: string): boolean {
  return /\b(delete|remove|trash|clear|empty)\b[\s\S]{0,120}\b(?:current|this|active|the)\s+(?:note|page|document|file|space)\b|\b(?:current|this|active|the)\s+(?:note|page|document|file|space)\b[\s\S]{0,120}\b(delete|remove|trash|clear|empty)\b/i.test(
    prompt,
  );
}

function hasWriteAfterResetIntent(prompt: string): boolean {
  return /\b(delete|remove|trash|clear|empty)\b[\s\S]{0,240}\b(write|generate|draft|compose|create|replace)\b|\b(write|generate|draft|compose|create|replace)\b[\s\S]{0,240}\b(delete|remove|trash|clear|empty)\b/i.test(
    prompt,
  );
}

function hasCreateAnotherNoteIntent(prompt: string): boolean {
  return /\b(create|make|new)\b[\s\S]{0,120}\b(note|file|markdown|document)\b/i.test(
    prompt,
  );
}

function hasExplicitMarkdownTarget(prompt: string): boolean {
  return /\.md\b|(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+/i.test(prompt);
}
