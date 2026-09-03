import {
  canonicalizeKeywordTypos,
  ROUTING_FUZZY_VOCABULARY_V1,
} from "./promptNormalization";

export type CurrentNoteResetAction =
  | { kind: "none" }
  | { kind: "replace_current_note"; reason: "clear_then_write" }
  | { kind: "delete_current_note"; reason: "delete_only" }
  | {
      kind: "ask_for_new_note_path";
      reason: "delete_then_create_without_target";
    };

const PAGE_CLEAR_VOCABULARY = [...ROUTING_FUZZY_VOCABULARY_V1, "delete"] as const;

/**
 * Wipe the body of the active note and keep the file. "Delete all the notes
 * on the page" is this, not `delete_current_file`. "Delate" is rescued as
 * delete via the shared fuzzy vocabulary (distance 1).
 */
const PAGE_CONTENT_CLEAR_PATTERN =
  /\b(delete|remove|clear|empty|emptying)\s+all\s+(?:of\s+)?(?:the\s+)?(?:notes?|contents?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)?\s*(?:page|note|document|file)\b|\b(delete|remove|clear|empty|emptying)\s+(?:the\s+)?(?:notes?|contents?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b|\b(clear|empty|emptying)\s+(?:(?:the|this|active|current|whole|entire)\s+)?(?:page|contents?|body|text|writing)\b|\bkeep\s+(?:the\s+)?(?:note|page|document|file)\b[\s\S]{0,180}\b(delete|remove|clear|empty|emptying)\b[\s\S]{0,120}\b(?:contents?|text|writing)\b/i;

export function normalizePageClearPrompt(prompt: string): string {
  return canonicalizeKeywordTypos(prompt, PAGE_CLEAR_VOCABULARY).text.replace(
    /\bre-write\b/gi,
    "rewrite",
  );
}

export function hasPageContentClearIntent(prompt: string): boolean {
  return PAGE_CONTENT_CLEAR_PATTERN.test(normalizePageClearPrompt(prompt));
}

export function allowsDestructiveShortCurrentNoteReplace(prompt: string): boolean {
  return (
    hasPageContentClearIntent(prompt) ||
    /\b(clear|delete|remove|empty|reset|start\s+fresh)\b/i.test(
      normalizePageClearPrompt(prompt),
    )
  );
}

export function analyzeCurrentNoteResetPrompt(
  prompt: string,
): CurrentNoteResetAction {
  if (hasPageContentClearIntent(prompt)) {
    if (hasCreateAnotherNoteIntent(prompt) && !hasExplicitMarkdownTarget(prompt)) {
      return {
        kind: "ask_for_new_note_path",
        reason: "delete_then_create_without_target",
      };
    }
    return { kind: "replace_current_note", reason: "clear_then_write" };
  }

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
    normalizePageClearPrompt(prompt),
  );
}

function hasWriteAfterResetIntent(prompt: string): boolean {
  return /\b(delete|remove|trash|clear|empty|emptying|start\s+(?:fresh|cleanly))\b[\s\S]{0,260}\b(write|rewrite|generate|draft|compose|create|replace)\b|\b(write|rewrite|generate|draft|compose|create|replace)\b[\s\S]{0,260}\b(delete|remove|trash|clear|empty|emptying|start\s+(?:fresh|cleanly))\b/i.test(
    normalizePageClearPrompt(prompt),
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
