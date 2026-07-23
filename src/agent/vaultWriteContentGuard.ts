/**
 * Fail-closed guards for current-note append/replace payloads.
 * Blocks process narration and catastrophic short replacements that wipe drafts.
 */

const PROCESS_NARRATION_PATTERNS: RegExp[] = [
  /\bI\s+only\s+have\s+`?append_to_current_file`?\b/i,
  /\bI\s+only\s+have\s+`?append_to_current\b/i,
  /\bI\s+don'?t\s+have\s+access\s+to\s+`?replace_current_file`?\b/i,
  /\bI\s+don'?t\s+have\s+access\s+to\s+`?replace_current\b/i,
  /\bnot\s+available\s+in\s+this\s+session\b/i,
  /\bplease\s+note\s+the\s+previous\s+draft\s+will\s+still\s+be\s+above\b/i,
  /\byou\s+may\s+want\s+to\s+manually\s+delete\s+the\s+earlier\s+version\b/i,
  /\bI\s+need\s+to\s+replace\s+the\s+current\s+note\s+content\s+entirely\b/i,
  /\blet\s+me\s+write\s+the\s+revised\b[\s\S]{0,80}\band\s+append\s+it\s*:?\s*$/i,
  /\bI\s+(?:will|I'll|'ll)\s+append\s+the\s+revised\b[\s\S]{0,120}\b(previous|earlier)\s+(draft|version)\b/i,
];

const TOOL_NAME_LEAK =
  /\b(?:append_to_current_file|replace_current_file|edit_current_section|read_current_file)\b/;

/** First-person lead-ins that must not live-flush into a replace stream. */
export function looksLikeProcessNarrationLead(text: string): boolean {
  const trimmed = String(text ?? "").trimStart();
  return /^(?:I\s+(?:need|only|don'?t|do\s+not|will|I'll|'ll)|Let\s+me\s+(?:write|append|replace))\b/i.test(
    trimmed,
  );
}

/** True when the payload is host/model process talk, not note body content. */
export function isVaultWriteProcessNarration(text: string): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return false;
  }
  if (PROCESS_NARRATION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true;
  }
  // Short tool-availability asides that leak snake_case tool names into the note.
  if (
    trimmed.length < 900 &&
    TOOL_NAME_LEAK.test(trimmed) &&
    /\b(available|access|session|tool|append|replace)\b/i.test(trimmed) &&
    !/^#{1,6}\s+/m.test(trimmed)
  ) {
    return true;
  }
  return false;
}

export type VaultWriteSafetyKind = "append" | "replace" | "edit";

export function assertSafeCurrentNoteWritePayload(input: {
  kind: VaultWriteSafetyKind;
  text: string;
  currentContent?: string | null;
  /** When true, allow intentional short clear/reset missions. */
  allowDestructiveShortReplace?: boolean;
}): void {
  const text = String(input.text ?? "");
  if (isVaultWriteProcessNarration(text)) {
    throw new Error(
      "Refused to write model process narration into the note. Request the authorized write tool with the real note body only — never explain missing tools inside the note.",
    );
  }

  if (input.kind !== "replace") {
    return;
  }

  if (input.allowDestructiveShortReplace) {
    return;
  }

  const current = String(input.currentContent ?? "");
  const currentChars = current.trim().length;
  const nextChars = text.trim().length;
  // Block catastrophic wipes: replacing a long draft with a tiny stub.
  if (currentChars >= 1200 && nextChars > 0 && nextChars < 500) {
    throw new Error(
      "Refused replace_current_file: replacement is far shorter than the existing note and would wipe the draft. Produce the full revised note body, or ask the user to confirm a destructive clear.",
    );
  }
  if (
    currentChars >= 2000 &&
    nextChars > 0 &&
    nextChars < Math.floor(currentChars * 0.12)
  ) {
    throw new Error(
      "Refused replace_current_file: replacement would discard most of the existing note. Return the complete revised markdown body.",
    );
  }
}
