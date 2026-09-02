/**
 * Isolated no-write mission guard for proof-gated writeback and degraded
 * delivery routing. Fail-closed when the user forbids note mutation, especially
 * on exact cache-read follow-ups (refresh=false, do not search).
 *
 * Explicit chat-only / "do not write or edit any note" wording is owned by
 * `hasExplicitNoNoteWriteIntent`. This module only adds cache-read heuristics
 * on top of that shared detector.
 */

import { hasExplicitNoNoteWriteIntent } from "./noNoteWriteIntent";

/** Shorter prohibitions that only bind when cache-read context is present. */
const BARE_NO_WRITE_PATTERN =
  /\b(?:do\s+not|don'?t|never)\s+(?:write|edit)(?:\s+or\s+(?:write|edit(?:\s+any\s+note)?))*\b/iu;

const SEQUENCING_BEFORE_PATTERN =
  /\b(?:do\s+not|don'?t|never)\s+(?:write|writing|append|appending|save|saving|edit|editing)(?:\s*,?\s*(?:or\s+)?(?:write|writing|append|appending|save|saving|edit|editing))*\s+before\b/iu;

const AFFIRMATIVE_NOTE_WRITE_PATTERN =
  /\b(?:append|add|insert|write|save|persist|replace|rewrite|draft|compose|generate|update)\b[\s\S]{0,160}\b(?:to|into|in)\s+(?:the\s+)?(?:current\s+)?(?:note|page|file|vault)\b/iu;

const APPEND_SECTION_PATTERN =
  /\bappend\s+(?:a\s+)?(?:##\s+)?[\w\s-]+\s+section\s+to\s+(?:the\s+)?(?:current\s+)?note\b/iu;

const CACHE_READ_REFRESH_FALSE = /\brefresh\s*=\s*false\b/iu;

const CACHE_READ_NO_SEARCH =
  /\b(?:do\s+not|don't|never)\s+(?:(?:use|call|run|perform)\s+)?(?:web_)?search(?:ing)?\b|\bwithout\s+(?:(?:using|calling|running|performing)\s+)?(?:web_)?search(?:ing)?\b|\bno\s+(?:web_)?search(?:ing)?\b/iu;

const CACHE_READ_EXACT_FETCH =
  /\b(?:web_fetch\b[\s\S]{0,40}\bonce\b|\b(?:once|single|exactly\s+(?:one|1))\b[\s\S]{0,40}\bweb_fetch\b|\balready[-\s]fetched\b|\bexact\s+(?:already[-\s]fetched\s+)?url\b|\bcached\s+passage\b)/iu;

const NOTE_WRITE_TOOL_NAMES = new Set([
  "append_to_current_file",
  "replace_current_file",
  "create_file",
  "rename_current_file",
  "retitle_current_file",
  "append_file",
  "replace_file",
  "move_file",
  "delete_file",
  "trash_file",
]);

function hasAffirmativeNoteWriteIntent(prompt: string): boolean {
  return (
    AFFIRMATIVE_NOTE_WRITE_PATTERN.test(prompt) ||
    APPEND_SECTION_PATTERN.test(prompt)
  );
}

function hasSequencingOnlyNoWrite(prompt: string): boolean {
  return SEQUENCING_BEFORE_PATTERN.test(prompt);
}

function hasExplicitNoteMutationForbidden(prompt: string): boolean {
  return hasExplicitNoNoteWriteIntent(prompt);
}

function cacheReadSignalCount(prompt: string): number {
  let count = 0;
  if (CACHE_READ_REFRESH_FALSE.test(prompt)) count += 1;
  if (CACHE_READ_NO_SEARCH.test(prompt)) count += 1;
  if (CACHE_READ_EXACT_FETCH.test(prompt)) count += 1;
  return count;
}

function hasCacheReadNoWriteMission(prompt: string): boolean {
  const signals = cacheReadSignalCount(prompt);
  if (signals < 2) return false;
  return (
    BARE_NO_WRITE_PATTERN.test(prompt) ||
    hasExplicitNoNoteWriteIntent(prompt) ||
    /\b(?:verify|confirm|check)\b[\s\S]{0,80}\bcached\b/iu.test(prompt)
  );
}

function isReadOnlyToolCatalogue(allowedToolNames: string[]): boolean {
  if (allowedToolNames.length === 0) return false;
  return !allowedToolNames.some((name) => NOTE_WRITE_TOOL_NAMES.has(name));
}

/**
 * Returns true when the mission forbids writing or editing vault notes.
 * Fail-closed for exact cache-read follow-ups that pair refresh=false and
 * search prohibitions with an explicit no-write instruction.
 */
export function missionForbidsNoteMutationV1(input: {
  userPrompt: string;
  allowedToolNames?: string[];
}): boolean {
  const prompt = input.userPrompt.trim();
  if (!prompt) return false;

  if (hasSequencingOnlyNoWrite(prompt) && hasAffirmativeNoteWriteIntent(prompt)) {
    return false;
  }

  if (hasExplicitNoteMutationForbidden(prompt)) {
    return true;
  }

  if (hasCacheReadNoWriteMission(prompt)) {
    return true;
  }

  if (
    input.allowedToolNames &&
    isReadOnlyToolCatalogue(input.allowedToolNames) &&
    cacheReadSignalCount(prompt) >= 2 &&
    (BARE_NO_WRITE_PATTERN.test(prompt) || CACHE_READ_NO_SEARCH.test(prompt))
  ) {
    return true;
  }

  return false;
}
