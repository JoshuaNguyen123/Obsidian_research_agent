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
  return /\b(delete|remove|trash|clear|empty|emptying)\b[\s\S]{0,160}\b(?:current|this|active|the)\s+(?:note|page|document|file|space|contents?|text|writing)\b|\b(?:current|this|active|the)\s+(?:note|page|document|file|space|contents?|text|writing)\b[\s\S]{0,160}\b(delete|remove|trash|clear|empty|emptying)\b|\b(delete|remove|clear|empty|emptying)\s+all\s+(?:of\s+)?(?:the\s+)?(?:contents?|text|writing)\b[\s\S]{0,120}\b(?:note|page|document|file)\b|\bkeep\s+(?:the\s+)?(?:note|page|document|file)\b[\s\S]{0,180}\b(delete|remove|clear|empty|emptying)\b[\s\S]{0,120}\b(?:contents?|text|writing)\b/i.test(
    prompt,
  );
}

function hasWriteAfterResetIntent(prompt: string): boolean {
  return /\b(delete|remove|trash|clear|empty|emptying|start\s+(?:fresh|cleanly))\b[\s\S]{0,260}\b(write|generate|draft|compose|create|replace)\b|\b(write|generate|draft|compose|create|replace)\b[\s\S]{0,260}\b(delete|remove|trash|clear|empty|emptying|start\s+(?:fresh|cleanly))\b/i.test(
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
