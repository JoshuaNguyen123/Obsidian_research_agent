import { prefersStreamedReplaceForEditOrganize } from "./editOrganizeIntent";
import { hasWordCountShortfallFollowUp } from "./generatedOutputPolicy";

/**
 * Classic user language that authorizes whole-note replace/rewrite.
 * Includes "existing note" so edit/trim follow-ups match the same gate the
 * host uses when offering replace_current_file.
 */
export const CLASSIC_REPLACE_INTENT_PATTERN =
  /\b(rewrite|replace|reset|overwrite)\b|\bclean\s+up\b|\bstart\s+(?:fresh|cleanly)\b|\bedit\s+over\s+(?:it|this|the\s+(?:note|page|document|file|contents?))\b|\b(edit(?:ing)?|revise|revising|revised|revision|rewrite|rewriting|improve|improving|expand|expanding|iterate|iterating|flesh\s+out|develop|add(?:ing)?\s+(?:more\s+)?detail|correct(?:ing)?|fix(?:ing)?|proofread(?:ing)?|polish(?:ing)?)\b[\s\S]{0,120}\b(essay|draft|article|paragraphs?|body|content|document|version|(?:whole|entire|current|this|active|existing)\s+(?:note|page|file|markdown))\b|\b(essay|draft|article|paragraphs?|body|content|document|version|(?:whole|entire|current|this|active|existing)\s+(?:note|page|file|markdown))\b[\s\S]{0,120}\b(edit(?:ing)?|revise|revising|revised|revision|rewrite|rewriting|improve|improving|expand|expanding|iterate|iterating|flesh\s+out|develop|add(?:ing)?\s+(?:more\s+)?detail|correct(?:ing)?|fix(?:ing)?|proofread(?:ing)?|polish(?:ing)?)\b|\b(correct(?:ing)?|fix(?:ing)?|proofread(?:ing)?|polish(?:ing)?)\b[\s\S]{0,80}\b(?:entire|whole)\s+(?:page|note|file|document|essay|draft|article|content|body)\b|\b(update|updating)\b[\s\S]{0,120}\b(essay|draft|article|paragraphs?|body|content|document|(?:whole|entire|existing)\s+(?:note|page|file|markdown))\b|\b(essay|draft|article|paragraphs?|body|content|document|(?:whole|entire|existing)\s+(?:note|page|file|markdown))\b[\s\S]{0,120}\b(update|updating)\b|\b(clear|delete|remove|empty)\s+all\s+(?:of\s+)?(?:the\s+)?(?:notes?|contents?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active|existing)?\s*(?:page|note|document|file)?\b[\s\S]{0,180}\b(write|draft|compose|generate|create)\b|\b(clear|delete|remove|empty)\b[\s\S]{0,80}\b(?:current|this|active|whole|entire|existing)\s+(?:note|page|document|file)\b[\s\S]{0,180}\b(write|draft|compose|generate|create)\b|\bkeep\s+(?:the\s+)?(?:note|page|document|file)\b[\s\S]{0,180}\b(delete|remove|clear|empty)\b[\s\S]{0,120}\b(?:contents?|text|writing)\b/i;

// A compound mission can explicitly forbid changing a code artifact while
// separately asking to append to the current note. That negative command is
// not authority to replace the active note, even though the classic detector
// intentionally recognizes the same bare verbs as positive note requests.
const NEGATED_CLASSIC_REPLACE_CLAUSE_PATTERN =
  /\b(?:do\s+not|don't|never|avoid)\s+(?:rewrite|replace|reset|overwrite|revise|expand|improve|polish)\b[^.!?\n]*/giu;

/**
 * A revision verb pointed at a pronoun — "revise it", "expand this".
 *
 * Natural revision follow-ups name no noun: the referent is the note the agent
 * just wrote. Without this, "rewrite it with some more details" authorized
 * nothing and the run had no way to write the note at all. Callers still gate on
 * the trusted `hasActiveMarkdownNote` fact, so a pronoun alone never grants
 * replace authority to a mission with no note in front of it.
 */
const PRONOUN_REVISION_INTENT_PATTERN =
  /\b(rewrite|revise|expand|improve|polish|proofread|iterate|flesh\s+out)\b\s+(?:on\s+)?(?:it|this|that)\b/i;

/**
 * True when replace_current_file (and host-owned streamed replace) is allowed.
 * Must stay aligned with AgentRunner preferHostOwnedReplace / streaming replace
 * so the vault gate never rejects a tool the host already offered.
 */
/**
 * Remove "do not rewrite …" style clauses so a refusal is never read as
 * authority. Exported because every gate that decides whole-note replace must
 * strip the same clauses — a gate that skips this treats an explicit refusal as
 * permission.
 */
export function stripNegatedReplaceClauses(prompt: string): string {
  return prompt.replace(NEGATED_CLASSIC_REPLACE_CLAUSE_PATTERN, " ");
}

export function hasAuthorizedCurrentNoteReplaceIntent(prompt: string): boolean {
  const promptWithoutNegatedClassicReplaceClauses =
    stripNegatedReplaceClauses(prompt);
  return (
    CLASSIC_REPLACE_INTENT_PATTERN.test(
      promptWithoutNegatedClassicReplaceClauses,
    ) ||
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
