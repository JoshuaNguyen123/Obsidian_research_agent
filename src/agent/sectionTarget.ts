/**
 * Heading-aware section targeting for revision requests.
 *
 * A request like "add more detail under passive thread locking" names the
 * section by its *title*, not by saying "the ... section". The deterministic
 * intent patterns required the literal word `section` or `heading`, so such a
 * request read as chat-only, the model's correct `current_note_append` scope
 * was discarded by the safer-scope intersection, and the note-output plan fell
 * back to whole-note append + stream — dumping a fresh essay onto the end of
 * the note instead of revising the two named sections.
 *
 * Detection here is evidence-based rather than pattern-based: it reads the
 * headings the note actually has and matches the prompt against them. That is
 * strictly more accurate than loosening the regexes — it cannot fire on a note
 * that lacks the heading — so it narrows behaviour rather than widening write
 * authority.
 *
 * Pure and I/O-free so it can be asserted deterministically.
 */

export interface MarkdownHeadingV1 {
  /** Heading text without the leading hashes. */
  text: string;
  /** 1-6. */
  level: number;
}

export type SectionEditModeV1 = "append" | "replace";

export interface SectionTargetV1 {
  /** Headings the prompt names, in document order. Empty when none matched. */
  headings: MarkdownHeadingV1[];
  /** Which section tool the request's verb implies. */
  mode: SectionEditModeV1;
  /** True when at least one heading matched and the request reads as a revision. */
  confident: boolean;
  /**
   * True when the request clearly targets *a* section but no heading matched.
   * The caller should ask rather than silently rewriting the whole note.
   */
  ambiguous: boolean;
}

/** Verbs that rewrite existing prose. */
const REPLACE_VERB_PATTERN =
  /\b(revise|rewrite|replace|reword|rephrase|tighten|shorten|condense|clean\s+up|fix|correct|update|edit|improve|polish|restructure)\b/iu;

/** Verbs that add alongside existing prose. */
const APPEND_VERB_PATTERN =
  /\b(add|append|expand|extend|include|insert|more|further|additional|elaborate|flesh\s+out|build\s+on)\b/iu;

/**
 * Language that means "operate on part of this note" even when no heading name
 * is recognised. Used only to decide whether to ask; never to authorize a write.
 */
const SECTION_REFERENCE_PATTERN =
  /\b(section|heading|subsection|chapter|part|paragraph)\b|\b(?:under|below|beneath|inside|within|in)\s+(?:the\s+)?["'`“]?[A-Za-z][^,.?!\n]{2,60}["'`”]?\s*(?:section|heading)?\b/iu;

/**
 * Language that creates a new section as part of a whole-note append. This is
 * not an attempt to address an existing heading. Generated research prompts
 * commonly say "append a ## Findings section"; treating the word `section`
 * alone as an existing-heading selector strips a clearly scoped append.
 */
const NEW_SECTION_APPEND_PATTERN =
  /\b(?:append|add|insert|create|include)\s+(?:(?:a|an|new|another|the\s+following)\s+)?(?:#{1,6}\s*)?[A-Za-z][A-Za-z0-9 _/-]{0,60}\s+(?:section|heading)\b/iu;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "vs",
  "versus", "into", "from", "at", "by", "is", "are", "its",
]);

/** Parse ATX headings, ignoring fenced code blocks so `# comment` lines do not count. */
export function listMarkdownHeadingsV1(markdown: string): MarkdownHeadingV1[] {
  if (typeof markdown !== "string" || !markdown.trim()) return [];
  const headings: MarkdownHeadingV1[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (const rawLine of markdown.replace(/\r\n?/gu, "\n").split("\n")) {
    const fence = /^\s*(`{3,}|~{3,})/u.exec(rawLine);
    if (fence) {
      const marker = fence[1]!.slice(0, 3);
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(rawLine);
    if (!match) continue;
    const text = match[2]!.trim();
    if (text) headings.push({ text, level: match[1]!.length });
  }
  return headings;
}

/**
 * Detect which of the note's headings a revision request names.
 *
 * Matching is token-based and typo tolerant: a live request said "agressive"
 * where the heading read "Aggressive", and exact matching would have missed it.
 */
export function detectSectionTargetV1(input: {
  prompt: string;
  markdown: string;
}): SectionTargetV1 {
  return detectSectionTargetFromHeadingsV1({
    prompt: input.prompt,
    headings: listMarkdownHeadingsV1(input.markdown),
  });
}

/**
 * Same detection from already-parsed headings. The runner resolves the plan
 * synchronously, and Obsidian's metadata cache exposes headings without a file
 * read, so this avoids making the note-output decision async.
 */
export function detectSectionTargetFromHeadingsV1(input: {
  prompt: string;
  headings: readonly MarkdownHeadingV1[];
}): SectionTargetV1 {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const affirmativePrompt = stripNegatedSectionClauses(prompt);
  const headings = Array.isArray(input.headings) ? input.headings : [];
  const mode: SectionEditModeV1 = resolveEditMode(affirmativePrompt);
  const revisionLanguage =
    REPLACE_VERB_PATTERN.test(affirmativePrompt) ||
    APPEND_VERB_PATTERN.test(affirmativePrompt);

  if (!revisionLanguage || headings.length === 0) {
    return { headings: [], mode, confident: false, ambiguous: false };
  }

  const promptTokens = tokenize(affirmativePrompt);
  const matched = headings.filter(
    (heading) =>
      // Level 1 is the note title: its "section body" is the entire note, so
      // targeting it would be the whole-note rewrite this exists to avoid.
      // Rewriting everything is current_note_replace, a scope with its own gate.
      heading.level > 1 &&
      headingIsNamed(heading.text, promptTokens, affirmativePrompt),
  );
  if (matched.length > 0) {
    // Deduplicate repeated heading text (a note may reuse a title at another
    // level); the caller edits by name and would otherwise target it twice.
    const seen = new Set<string>();
    const unique = matched.filter((heading) => {
      const key = normalize(heading.text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { headings: unique, mode, confident: true, ambiguous: false };
  }

  return {
    headings: [],
    mode,
    confident: false,
    // Only ask when the request really does point at part of the note.
    // Creating a new named/Markdown section is a whole-note append, not an
    // unresolved reference to an existing heading.
    ambiguous:
      SECTION_REFERENCE_PATTERN.test(affirmativePrompt) &&
      !NEW_SECTION_APPEND_PATTERN.test(affirmativePrompt),
  };
}

function stripNegatedSectionClauses(prompt: string): string {
  return prompt
    .split(/(?:[,.;!?\r\n]+|\bbut\b)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .filter((clause) => {
      if (
        /\b(?:do\s+not|don't|never|without)\b[^,.;!?\r\n]{0,100}\b(?:revise|rewrite|replace|reword|rephrase|tighten|shorten|condense|clean\s+up|fix|correct|update|edit|improve|polish|restructure|add|append|expand|extend|include|insert|elaborate|touch|change|modify)\b/iu.test(
          clause,
        )
      ) {
        return false;
      }
      return !/\b(?:leave|keep)\b[^,.;!?\r\n]{0,100}\b(?:unchanged|as\s+is|intact)\b/iu.test(
        clause,
      );
    })
    .join(" ");
}

/**
 * True when the request both asks for a revision and names this exact heading.
 *
 * Section tools call this to authorize themselves. It is stricter than the
 * legacy word-pattern gate in one important way: the model cannot edit a
 * section the user never mentioned, because the heading it passed must appear
 * in the request.
 */
export function promptTargetsHeadingV1(prompt: string, heading: string): boolean {
  const text = typeof heading === "string" ? heading.trim() : "";
  if (!text) return false;
  return detectSectionTargetFromHeadingsV1({
    prompt,
    // Level 2 so the note-title exclusion does not reject a legitimate target.
    headings: [{ text, level: 2 }],
  }).confident;
}

/** Replace wins on a tie: "revise and expand X" is a rewrite that also grows. */
function resolveEditMode(prompt: string): SectionEditModeV1 {
  if (REPLACE_VERB_PATTERN.test(prompt)) return "replace";
  if (APPEND_VERB_PATTERN.test(prompt)) return "append";
  return "append";
}

function headingIsNamed(
  headingText: string,
  promptTokens: string[],
  prompt: string,
): boolean {
  const headingTokens = tokenize(headingText);
  if (headingTokens.length === 0) return false;
  const hits = headingTokens.filter((token) =>
    promptTokens.some((candidate) => tokensMatch(token, candidate)),
  ).length;
  if (headingTokens.length === 1) {
    // One shared word is far too weak on its own: a "Scope" heading would
    // match "the scope of this project". Require a positional cue that the
    // word is being used as a location in the note.
    return hits === 1 && hasPositionalCue(headingTokens[0]!, prompt);
  }
  return hits >= Math.max(2, Math.ceil(headingTokens.length * 0.7));
}

/** "under Scope", "in Scope", "the Scope section" — but not "the scope of the work". */
function hasPositionalCue(token: string, prompt: string): boolean {
  const normalized = normalize(prompt);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    new RegExp(
      `\\b(?:under|below|beneath|inside|within|in|to)\\s+(?:the\\s+)?${escaped}\\b`,
      "u",
    ).test(normalized) ||
    new RegExp(`\\b${escaped}\\s+(?:section|heading)\\b`, "u").test(normalized)
  );
}

function tokensMatch(left: string, right: string): boolean {
  if (left === right) return true;
  // Tolerate one typo in longer words: "agressive" vs "aggressive".
  if (left.length < 5 || right.length < 5) return false;
  if (Math.abs(left.length - right.length) > 1) return false;
  return editDistanceWithinOne(left, right);
}

function editDistanceWithinOne(left: string, right: string): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  let shortIndex = 0;
  let longIndex = 0;
  let edits = 0;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (shorter.length === longer.length) {
      shortIndex += 1;
      longIndex += 1;
    } else {
      longIndex += 1;
    }
  }
  return edits + (longer.length - longIndex) + (shorter.length - shortIndex) <= 1;
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_~[\]()#]/gu, " ")
    .replace(/[^a-z0-9\s/-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
