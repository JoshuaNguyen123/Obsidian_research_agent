import {
  isCurrentNoteEditOrganizeIntent,
  isNamedSectionEditIntent,
  isWholeNoteEditIntent,
  prefersStreamedReplaceForEditOrganize,
} from "./editOrganizeIntent";
import { hasExplicitNoNoteWriteIntent } from "./noNoteWriteIntent";
import {
  canonicalizeKeywordTypos,
  ROUTING_FUZZY_VOCABULARY_V1,
} from "./promptNormalization";
import { hasWordCountShortfallFollowUp } from "./wordCountShortfallIntent";

export type CurrentNoteResetAction =
  | { kind: "none" }
  | { kind: "replace_current_note"; reason: "clear_then_write" }
  | { kind: "delete_current_note"; reason: "delete_only" }
  | {
      kind: "ask_for_new_note_path";
      reason: "delete_then_create_without_target";
    };

/**
 * Classic user language that authorizes whole-note replace/rewrite.
 * Includes "existing note" so edit/trim follow-ups match the same gate the
 * host uses when offering replace_current_file.
 */
export const CLASSIC_REPLACE_INTENT_PATTERN =
  /\b(rewrite|replace|reset|overwrite)\b|\bclean\s+up\b|\bstart\s+(?:fresh|cleanly|over)\b|\bedit\s+over\s+(?:it|this|the\s+(?:note|page|document|file|contents?))\b|\b(edit(?:ing)?|revise|revising|revised|revision|rewrite|rewriting|improve|improving|expand|expanding|iterate|iterating|flesh\s+out|develop|add(?:ing)?\s+(?:more\s+)?detail|correct(?:ing)?|fix(?:ing)?|proofread(?:ing)?|polish(?:ing)?)\b[\s\S]{0,120}\b(essay|draft|article|paragraphs?|body|content|document|version|(?:whole|entire|current|this|active|existing)\s+(?:note|page|file|markdown))\b|\b(essay|draft|article|paragraphs?|body|content|document|version|(?:whole|entire|current|this|active|existing)\s+(?:note|page|file|markdown))\b[\s\S]{0,120}\b(edit(?:ing)?|revise|revising|revised|revision|rewrite|rewriting|improve|improving|expand|expanding|iterate|iterating|flesh\s+out|develop|add(?:ing)?\s+(?:more\s+)?detail|correct(?:ing)?|fix(?:ing)?|proofread(?:ing)?|polish(?:ing)?)\b|\b(correct(?:ing)?|fix(?:ing)?|proofread(?:ing)?|polish(?:ing)?)\b[\s\S]{0,80}\b(?:entire|whole)\s+(?:page|note|file|document|essay|draft|article|content|body)\b|\b(update|updating)\b[\s\S]{0,120}\b(essay|draft|article|paragraphs?|body|content|document|(?:whole|entire|existing)\s+(?:note|page|file|markdown))\b|\b(essay|draft|article|paragraphs?|body|content|document|(?:whole|entire|existing)\s+(?:note|page|file|markdown))\b[\s\S]{0,120}\b(update|updating)\b|\b(clear|delete|remove|empty|wipe)\s+all\s+(?:of\s+)?(?:the\s+)?(?:notes?|contents?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active|existing)?\s*(?:page|note|document|file)?\b[\s\S]{0,180}\b(write|draft|compose|generate|create)\b|\b(clear|delete|remove|empty|wipe)\b[\s\S]{0,80}\b(?:current|this|active|whole|entire|existing)\s+(?:note|page|document|file)\b[\s\S]{0,180}\b(write|draft|compose|generate|create)\b|\bkeep\s+(?:the\s+)?(?:note|page|document|file)\b[\s\S]{0,180}\b(delete|remove|clear|empty|wipe)\b[\s\S]{0,120}\b(?:contents?|text|writing)\b/i;

const NEGATED_CLASSIC_REPLACE_CLAUSE_PATTERN =
  /\b(?:do\s+not|don't|never|avoid)\s+(?:rewrite|replace|reset|overwrite|revise|expand|improve|polish)\b[^.!?\n]*/giu;

const PRONOUN_REVISION_INTENT_PATTERN =
  /\b(rewrite|revise|expand|improve|polish|proofread|iterate|flesh\s+out)\b\s+(?:on\s+)?(?:it|this|that)\b/i;

const PAGE_CLEAR_VOCABULARY = [...ROUTING_FUZZY_VOCABULARY_V1, "delete"] as const;

/**
 * Wipe the body of the active note and keep the file. "Delete all the notes
 * on the page" is this, not `delete_current_file`. Also covers colloquial
 * reset language: "wipe this", "start over", "scratch that".
 */
const PAGE_CONTENT_CLEAR_PATTERN =
  /\b(delete|remove|clear|empty|emptying|wipe)\s+all\s+(?:of\s+)?(?:the\s+)?(?:notes?|contents?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)?\s*(?:page|note|document|file)\b|\b(delete|remove|clear|empty|emptying|wipe)\s+(?:the\s+)?(?:notes?|contents?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b|\b(clear|empty|emptying|wipe)\s+(?:(?:the|this|active|current|whole|entire)\s+)?(?:page|contents?|body|text|writing|slate)\b|\b(?:wipe|scratch)\s+(?:this|that|it)\b|\bstart\s+over\b|\bkeep\s+(?:the\s+)?(?:note|page|document|file)\b[\s\S]{0,180}\b(delete|remove|clear|empty|emptying|wipe)\b[\s\S]{0,120}\b(?:contents?|text|writing)\b/i;

const EXPLICIT_REPLACE_PATTERN =
  /\b(replace|re-?write|overwrite|start\s+(?:fresh|over)|reset|clear\s+(?:and\s+)?write|delete\s+(?:the\s+)?(?:content|body)\s+and\s+write|correct(?:ing)?|fix(?:ing)?|proofread(?:ing)?|polish(?:ing)?)\b[\s\S]{0,120}\b(?:entire|whole)\s+(?:page|note|file|document|essay|draft|article|content|body)\b|\b(replace|re-?write|overwrite|start\s+(?:fresh|over)|reset|clear\s+(?:and\s+)?write|delete\s+(?:the\s+)?(?:content|body)\s+and\s+write)\b/i;

const NARROW_REPLACE_PATTERN =
  /\b(re-?write|replace|reset|overwrite)\b|\bclean\s+up\b|\bstart\s+(?:fresh|cleanly|over)\b|\bedit\s+over\s+(?:it|this|the\s+(?:note|page|document|file|contents?))\b|\breplace\s+(?:the\s+)?existing\s+contents?\b/i;

const CLEAR_THEN_WRITE_PATTERN =
  /\b(clear|delete|remove|wipe|scratch)\s+all\s+(?:the\s+)?(?:notes?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b[\s\S]{0,180}\b(write|draft|compose|generate|create|re-?write)\b|\b(write|draft|compose|generate|create|re-?write)\b[\s\S]{0,180}\b(?:after|then)\b[\s\S]{0,120}\b(clear|delete|remove|wipe|scratch)\s+all\s+(?:the\s+)?(?:notes?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b/i;

export function stripNegatedReplaceClauses(prompt: string): string {
  return prompt.replace(NEGATED_CLASSIC_REPLACE_CLAUSE_PATTERN, " ");
}

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
    /\b(clear|delete|remove|empty|reset|wipe|scratch|start\s+(?:fresh|over))\b/i.test(
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

export function detectExplicitReplaceIntent(prompt: string): boolean {
  return (
    EXPLICIT_REPLACE_PATTERN.test(prompt) || hasPageContentClearIntent(prompt)
  );
}

export function hasReplaceIntent(prompt: string): boolean {
  if (hasExplicitNoNoteWriteIntent(prompt)) {
    return false;
  }
  const positivePrompt = stripNegatedReplaceClauses(prompt)
    .replace(
      /\bwithout\s+(?:rewriting|replacing|resetting|overwriting)\b[^.;\n]*/giu,
      " ",
    );
  return (
    isCurrentNoteReplaceResetPrompt(positivePrompt) ||
    hasPageContentClearIntent(positivePrompt) ||
    matchesWholeNoteRevisionForReplace(positivePrompt) ||
    NARROW_REPLACE_PATTERN.test(positivePrompt) ||
    CLEAR_THEN_WRITE_PATTERN.test(positivePrompt)
  );
}

export function hasAuthorizedCurrentNoteReplaceIntent(prompt: string): boolean {
  if (hasExplicitNoNoteWriteIntent(prompt)) {
    return false;
  }
  const promptWithoutNegatedClassicReplaceClauses =
    stripNegatedReplaceClauses(prompt);
  return (
    CLASSIC_REPLACE_INTENT_PATTERN.test(
      promptWithoutNegatedClassicReplaceClauses,
    ) ||
    hasPageContentClearIntent(promptWithoutNegatedClassicReplaceClauses) ||
    PRONOUN_REVISION_INTENT_PATTERN.test(
      promptWithoutNegatedClassicReplaceClauses,
    ) ||
    hasWordCountShortfallFollowUp(
      promptWithoutNegatedClassicReplaceClauses,
    ) ||
    prefersStreamedReplaceForEditOrganize(
      promptWithoutNegatedClassicReplaceClauses,
    )
  );
}

function matchesWholeNoteRevisionForReplace(prompt: string): boolean {
  if (isNamedSectionEditIntent(prompt)) {
    return false;
  }
  if (isWholeNoteEditIntent(prompt) || isCurrentNoteEditOrganizeIntent(prompt)) {
    return true;
  }
  const sectionTarget =
    /\b(section|heading)\b/i.test(prompt) &&
    !/\b(essay|draft|article|paragraphs?|body|content|document)\b/i.test(prompt);
  if (sectionTarget) {
    return false;
  }
  if (
    /\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,80}\b(note|file|markdown|vault|page|document)\b|\b(note|file|markdown|vault|page|document)\b[\s\S]{0,80}\b(append|save|write|update|add|insert|copy|paste|put)\b|\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,120}\.md\b/i.test(
      prompt,
    ) &&
    !/\b(?:re-?write|replace|reset|overwrite|whole|entire)\b/iu.test(prompt)
  ) {
    return false;
  }
  const revisionVerb =
    /\b(edit(?:ing)?|revise|revising|revised|revision|re-?write|rewriting|improve|improving|expand|expanding|iterate|iterating|flesh\s+out|develop|add(?:ing)?\s+(?:more\s+)?detail|correct(?:ing)?|fix(?:ing)?|proofread(?:ing)?|polish(?:ing)?)\b/i;
  const wholeTextTarget =
    /\b(essay|draft|article|paragraphs?|body|content|document|version)\b|\b(?:whole|entire|current|this|active)\s+(?:note|page|file|markdown)\b|\b(?:note|page|file|markdown)\b[\s\S]{0,40}\b(?:whole|entire|current|this|active)\b/i;
  const updateVerb = /\b(update|updating)\b/i;
  return (
    (revisionVerb.test(prompt) && wholeTextTarget.test(prompt)) ||
    (updateVerb.test(prompt) &&
      /\b(essay|draft|article|paragraphs?|body|content|document)\b|\b(?:whole|entire)\s+(?:note|page|file|markdown)\b/i.test(
        prompt,
      ))
  );
}

function hasCurrentNoteDeleteIntent(prompt: string): boolean {
  return /\b(delete|remove|trash|clear|empty|emptying|wipe)\b[\s\S]{0,160}\b(?:current|this|active|the)\s+(?:note|page|document|file|space|contents?|text|writing)\b|\b(?:current|this|active|the)\s+(?:note|page|document|file|space|contents?|text|writing)\b[\s\S]{0,160}\b(delete|remove|trash|clear|empty|emptying|wipe)\b|\b(delete|remove|clear|empty|emptying|wipe)\s+all\s+(?:of\s+)?(?:the\s+)?(?:contents?|text|writing)\b[\s\S]{0,120}\b(?:note|page|document|file)\b|\bkeep\s+(?:the\s+)?(?:note|page|document|file)\b[\s\S]{0,180}\b(delete|remove|clear|empty|emptying|wipe)\b[\s\S]{0,120}\b(?:contents?|text|writing)\b/i.test(
    normalizePageClearPrompt(prompt),
  );
}

function hasWriteAfterResetIntent(prompt: string): boolean {
  return /\b(delete|remove|trash|clear|empty|emptying|wipe|scratch|start\s+(?:fresh|cleanly|over))\b[\s\S]{0,260}\b(write|rewrite|generate|draft|compose|create|replace)\b|\b(write|rewrite|generate|draft|compose|create|replace)\b[\s\S]{0,260}\b(delete|remove|trash|clear|empty|emptying|wipe|scratch|start\s+(?:fresh|cleanly|over))\b/i.test(
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
