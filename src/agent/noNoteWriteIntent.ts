/**
 * Explicit user refusals of note writeback.
 *
 * One shared predicate so chat-only, replace, append, speech-act, and
 * generated-output seats cannot disagree about "do not write or edit any
 * note". A sequencing constraint such as "Do not write before fetch" is
 * not a write refusal and must not match.
 */

const CHAT_ONLY_SURFACE_PATTERN =
  /\b(?:chat\s+only|only\s+in\s+chat|answer\s+in\s+chat|respond\s+in\s+chat)\b/iu;

/**
 * `do not write` / `do not edit` only when the next object is a note/page/
 * document/file/vault. Optional extra verbs (`or edit`, `, append, or save`)
 * and determiners (`any` / `the` / `this`) are allowed. `before fetch` is
 * not a note object.
 */
const NO_NOTE_WRITE_PATTERN =
  /\b(?:do\s+not|don'?t|never|without)\s+(?:write|writing|append|appending|save|saving|edit|editing|persist|persisting)(?:\s*,?\s*(?:or\s+)?(?:write|writing|append|appending|save|saving|edit|editing|persist|persisting))*\s+(?:(?:to|in|into)\s+)?(?:(?:any|the|this|current|active|other)\s+)?(?:notes?|pages?|documents?|files?|vault)\b/iu;

export function hasExplicitNoNoteWriteIntent(prompt: string): boolean {
  return (
    CHAT_ONLY_SURFACE_PATTERN.test(prompt) || NO_NOTE_WRITE_PATTERN.test(prompt)
  );
}
