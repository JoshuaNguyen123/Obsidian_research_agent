/**
 * Shared deterministic prompt-normalization substrate for routing gates.
 *
 * Fuzzy keyword correction is rescue-positioned by design: callers consult it
 * only after their exact regex gates miss, so it can widen a classification
 * toward what the deterministic gates would have produced for the corrected
 * spelling, and can never veto or narrow a deterministic positive. Every
 * correction is reported so callers can emit auditable
 * `fuzzy_keyword:<keyword>~<token>` reasons.
 */

export interface FuzzyKeywordCorrectionV1 {
  keyword: string;
  token: string;
  distance: number;
}

export interface NormalizedPromptTokenV1 {
  /** Lowercase NFKC token used by deterministic routing. */
  value: string;
  /** NFKC token before lowercasing, useful for diagnostics. */
  raw: string;
  /** UTF-16 offset in `canonicalText`, inclusive. */
  start: number;
  /** UTF-16 offset in `canonicalText`, exclusive. */
  end: number;
}

export interface NormalizedPromptV1 {
  originalText: string;
  /** NFKC text with original casing, used for offset-safe reconstruction. */
  canonicalText: string;
  /** NFKC + lowercase routing surface. */
  text: string;
  tokens: readonly NormalizedPromptTokenV1[];
}

export interface CanonicalizedPromptV1 {
  text: string;
  corrections: readonly FuzzyKeywordCorrectionV1[];
}

/**
 * Canonical keywords the routing gates depend on. Deliberately small: verbs
 * that confer deliverable intent, known host directories, and language names.
 * Short words (≤4 chars) are never fuzzy-matched at all via the length guard.
 */
export const ROUTING_FUZZY_VOCABULARY_V1: readonly string[] = [
  "create",
  "write",
  "build",
  "implement",
  "generate",
  "program",
  "script",
  "desktop",
  "computer",
  "folder",
  "directory",
  "documents",
  "downloads",
  "python",
  "javascript",
  "typescript",
];

/**
 * Real English words that sit within edit distance of a vocabulary keyword but
 * carry a different meaning. Correcting these would flip descriptive or
 * hypothetical prose into imperatives ("wrote" → "write") or ordinary nouns
 * into host-directory authority ("document" → "documents"), so they are never
 * treated as typos.
 */
const FUZZY_CORRECTION_DENYLIST = new Set([
  "white",
  "whites",
  "wrote",
  "writes",
  "written",
  "writing",
  "creates",
  "created",
  "builds",
  "built",
  "implements",
  "implemented",
  "generates",
  "generated",
  "document",
  "documented",
  "documenting",
  "download",
  "downloaded",
  "downloading",
]);

/**
 * Normalize once for all deterministic routing checks. Offsets refer to the
 * NFKC canonical surface, so fuzzy corrections can reconstruct text without
 * rescanning or relying on regex replacement side effects.
 */
export function normalizePromptV1(prompt: string): NormalizedPromptV1 {
  const canonicalText = prompt.normalize("NFKC");
  const tokens: NormalizedPromptTokenV1[] = [];
  const tokenPattern = /[A-Za-z][A-Za-z'-]*/gu;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(canonicalText)) !== null) {
    const raw = match[0];
    tokens.push({
      value: raw.toLowerCase(),
      raw,
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return {
    originalText: prompt,
    canonicalText,
    text: canonicalText.toLowerCase(),
    tokens,
  };
}

function maxDistanceForLength(length: number): number {
  if (length <= 4) return 0;
  if (length <= 7) return 1;
  return 2;
}

/**
 * Bounded Damerau-Levenshtein (optimal string alignment). Returns null when
 * the distance exceeds `max`, so callers pay nothing for distant tokens.
 */
export function boundedDamerauLevenshtein(
  left: string,
  right: string,
  max: number,
): number | null {
  if (left === right) return 0;
  if (max <= 0) return null;
  const lengthDelta = Math.abs(left.length - right.length);
  if (lengthDelta > max) return null;
  const rows = left.length + 1;
  const columns = right.length + 1;
  let previousPrevious: number[] | null = null;
  let previous = Array.from({ length: columns }, (_, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = [row, ...new Array<number>(columns - 1).fill(0)];
    for (let column = 1; column < columns; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + substitutionCost,
      );
      if (
        previousPrevious &&
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        best = Math.min(best, previousPrevious[column - 2]! + 1);
      }
      current[column] = best;
    }
    if (Math.min(...current) > max) return null;
    previousPrevious = previous;
    previous = current;
  }
  const distance = previous[columns - 1]!;
  return distance <= max ? distance : null;
}

/**
 * Match one lowercase token against one canonical keyword under the length
 * guards: exact always wins; fuzzy distance is bounded by the SHORTER of the
 * two words' budgets (≤4 chars exact-only, 5-7 chars distance ≤1, ≥8 chars
 * distance ≤2), which also blocks any short-token/long-keyword pairing such
 * as "desk" ↔ "desktop".
 */
export function matchKeyword(
  token: string,
  keyword: string,
): FuzzyKeywordCorrectionV1 | null {
  if (token === keyword) return { keyword, token, distance: 0 };
  const allowed = Math.min(
    maxDistanceForLength(token.length),
    maxDistanceForLength(keyword.length),
  );
  if (allowed === 0) return null;
  if (FUZZY_CORRECTION_DENYLIST.has(token)) return null;
  const distance = boundedDamerauLevenshtein(token, keyword, allowed);
  return distance === null || distance === 0
    ? null
    : { keyword, token, distance };
}

export function matchAnyKeyword(
  token: string,
  vocabulary: readonly string[],
): FuzzyKeywordCorrectionV1 | null {
  let best: FuzzyKeywordCorrectionV1 | null = null;
  for (const keyword of vocabulary) {
    const match = matchKeyword(token, keyword);
    if (match && (best === null || match.distance < best.distance)) {
      best = match;
      if (best.distance === 0) break;
    }
  }
  return best;
}

/**
 * Replace whole-word near-miss tokens with their canonical vocabulary
 * spelling, preserving everything else byte-for-byte. Tokens that already ARE
 * vocabulary words are left untouched and reported as no correction.
 */
export function canonicalizeKeywordTypos(
  prompt: string,
  vocabulary: readonly string[] = ROUTING_FUZZY_VOCABULARY_V1,
): CanonicalizedPromptV1 {
  const vocabularySet = new Set(vocabulary);
  const corrections: FuzzyKeywordCorrectionV1[] = [];
  const normalized = normalizePromptV1(prompt);
  let cursor = 0;
  let text = "";
  for (const token of normalized.tokens) {
    text += normalized.canonicalText.slice(cursor, token.start);
    if (vocabularySet.has(token.value)) {
      text += token.raw;
      cursor = token.end;
      continue;
    }
    const match = matchAnyKeyword(token.value, vocabulary);
    if (!match || match.distance === 0) {
      text += token.raw;
      cursor = token.end;
      continue;
    }
    corrections.push(match);
    text += match.keyword;
    cursor = token.end;
  }
  text += normalized.canonicalText.slice(cursor);
  return corrections.length > 0
    ? { text, corrections }
    : { text: normalized.canonicalText, corrections };
}

/** Auditable trace-reason token for one fuzzy correction. */
export function fuzzyCorrectionReason(
  correction: FuzzyKeywordCorrectionV1,
): string {
  return `fuzzy_keyword:${correction.keyword}~${correction.token}`;
}
