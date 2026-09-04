import {
  bm25ContentScoreV1,
  buildLexicalCorpusStatsV1,
  buildLexicalDocumentTermStatsV1,
  type LexicalDocumentTermStatsV1,
} from "../tools/lexicalRanking";

// Keep each source compact enough that multi-source research can fit alongside
// the mission plan, tool schemas, and a correction pass in an 8k context.
// The complete source remains in the durable cache; these are the best
// query-aware windows exposed to the model on each loop step.
const DEFAULT_MAX_PASSAGES = 3;
const DEFAULT_MAX_PASSAGE_CHARS = 700;
const DEFAULT_MAX_TOTAL_CHARS = 2100;
const MAX_QUERY_TERMS = 12;

const QUERY_STOP_TERMS = new Set([
  "about",
  "after",
  "also",
  "been",
  "before",
  "being",
  "could",
  "from",
  "have",
  "into",
  "latest",
  "more",
  "most",
  "other",
  "research",
  "source",
  "sources",
  "that",
  "their",
  "there",
  "these",
  "this",
  "through",
  "using",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

export interface EvidencePassage {
  id: string;
  startChar: number;
  endChar: number;
  text: string;
  selection: "query_match" | "coverage";
  matchedTerms?: string[];
}

export interface EvidencePassageBundle {
  totalChars: number;
  includedChars: number;
  truncated: boolean;
  query?: string;
  passages: EvidencePassage[];
}

export interface EvidencePassageOptions {
  query?: string;
  /** Stable URL/path used to make passage ids source-scoped and citable. */
  sourceLocator?: string;
  /** Offset of this content window within the complete source. */
  baseOffset?: number;
  maxPassages?: number;
  maxPassageChars?: number;
  maxTotalChars?: number;
}

interface PassageCandidate {
  start: number;
  end: number;
  score: number;
  selection: EvidencePassage["selection"];
  matchedTerms: string[];
}

/**
 * Selects bounded, source-offset-addressable passages for model context.
 * Query matches are preferred. When no useful query is available, windows are
 * distributed across the document so later evidence is not lost to a prefix.
 */
export function extractEvidencePassages(
  content: string,
  options: EvidencePassageOptions = {},
): EvidencePassageBundle {
  const maxPassages = clampInteger(
    options.maxPassages ?? DEFAULT_MAX_PASSAGES,
    1,
    6,
  );
  const maxPassageChars = clampInteger(
    options.maxPassageChars ?? DEFAULT_MAX_PASSAGE_CHARS,
    240,
    1600,
  );
  const maxTotalChars = clampInteger(
    options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS,
    600,
    6000,
  );
  const baseOffset = clampInteger(
    options.baseOffset ?? 0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const query = options.query?.replace(/\s+/g, " ").trim().slice(0, 500) || undefined;

  if (!content) {
    return {
      totalChars: 0,
      includedChars: 0,
      truncated: false,
      ...(query ? { query } : {}),
      passages: [],
    };
  }

  const terms = tokenizeQuery(query ?? "");
  const candidates = terms.length > 0
    ? buildQueryCandidates(content, terms, maxPassageChars)
    : [];
  const selected = selectNonOverlapping(candidates, maxPassages);

  if (selected.length < maxPassages) {
    const coverage = buildCoverageCandidates(
      content.length,
      maxPassages,
      maxPassageChars,
    );
    for (const candidate of coverage) {
      if (selected.length >= maxPassages) {
        break;
      }
      if (!selected.some((existing) => overlapRatio(existing, candidate) > 0.65)) {
        selected.push(candidate);
      }
    }
  }

  selected.sort((left, right) => left.start - right.start);
  const passages: EvidencePassage[] = [];
  let remainingChars = maxTotalChars;

  for (const candidate of selected) {
    if (remainingChars < 80 || passages.length >= maxPassages) {
      break;
    }
    const end = Math.min(candidate.end, candidate.start + remainingChars);
    const trimmed = trimWindow(content, candidate.start, end);
    if (!trimmed.text) {
      continue;
    }
    const absoluteStart = baseOffset + trimmed.start;
    const absoluteEnd = baseOffset + trimmed.end;
    passages.push({
      id: options.sourceLocator
        ? createSourceScopedPassageId(
            options.sourceLocator,
            absoluteStart,
            absoluteEnd,
          )
        : `p${passages.length + 1}`,
      startChar: absoluteStart,
      endChar: absoluteEnd,
      text: trimmed.text,
      selection: candidate.selection,
      ...(candidate.matchedTerms.length > 0
        ? { matchedTerms: candidate.matchedTerms }
        : {}),
    });
    remainingChars -= trimmed.text.length;
  }

  const includedChars = passages.reduce(
    (total, passage) => total + passage.text.length,
    0,
  );
  return {
    totalChars: content.length,
    includedChars,
    truncated: includedChars < content.length,
    ...(query ? { query } : {}),
    passages,
  };
}

export function createEvidenceSourceId(sourceLocator: string): string {
  let normalized = sourceLocator.replace(/\s+/g, " ").trim();
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      url.hash = "";
      normalized = url.toString();
    } catch {
      // Hash the normalized legacy locator when URL parsing fails.
    }
  }
  return `source:${hashLocator(normalized || "unknown-source")}`;
}

export function createSourceScopedPassageId(
  sourceLocator: string,
  startChar: number,
  endChar: number,
): string {
  const sourceId = createEvidenceSourceId(sourceLocator);
  const range = `${Math.max(0, Math.trunc(startChar))}-${Math.max(
    0,
    Math.trunc(endChar),
  )}`;
  return `${sourceId}:passage:${range}`;
}

function hashLocator(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Windows built per query term, and in total, before ranking. */
const MAX_WINDOWS_PER_TERM = 8;
const MAX_QUERY_WINDOWS = 48;
/** How many occurrences of one term are worth locating before sampling. */
const MAX_SCANNED_OCCURRENCES = 512;

/**
 * Up to `MAX_WINDOWS_PER_TERM` occurrences of a term, spread across the whole
 * document rather than taken from its beginning.
 *
 * Taking the first eight is a prefix bias with teeth: a page whose navigation
 * or tag blocks repeat the query terms consumes every slot before the reader
 * ever reaches the paragraph that answers, and a window that was never built
 * cannot be ranked, selected, cited or quoted, however good the scoring is.
 * Sampling evenly across the occurrence list keeps the same budget and always
 * includes the first and the last.
 */
function spreadOccurrencesV1(lowerContent: string, term: string): number[] {
  const occurrences: number[] = [];
  let cursor = 0;
  while (occurrences.length < MAX_SCANNED_OCCURRENCES) {
    const index = lowerContent.indexOf(term, cursor);
    if (index < 0) break;
    occurrences.push(index);
    cursor = index + Math.max(1, term.length);
  }
  if (occurrences.length <= MAX_WINDOWS_PER_TERM) return occurrences;
  const picked: number[] = [];
  for (let slot = 0; slot < MAX_WINDOWS_PER_TERM; slot += 1) {
    const position = Math.round(
      (slot * (occurrences.length - 1)) / (MAX_WINDOWS_PER_TERM - 1),
    );
    const occurrence = occurrences[position];
    if (picked.at(-1) !== occurrence) picked.push(occurrence);
  }
  return picked;
}

/**
 * Windows around each query-term occurrence, ranked by how much of the query
 * they answer and then by BM25 within the page.
 *
 * Ranking used to be term coverage plus a raw occurrence count, which is the
 * scoring a keyword list wins: a navigation block or tag dump repeating the
 * query's words beat the paragraph that states the fact. The tiebreak is now
 * `bm25ContentScoreV1` over the page's own windows, so a term is weighed by how
 * rare it is *on this page*, repeats saturate instead of accumulating, longer
 * windows are normalised, and `informativeOccurrenceCountV1` discounts adjacent
 * repeats and keyword-dense lines outright. Coverage stays the primary key: a
 * window answering three of three terms should still precede one answering one.
 */
function buildQueryCandidates(
  content: string,
  terms: string[],
  maxPassageChars: number,
): PassageCandidate[] {
  const lowerContent = content.toLocaleLowerCase();
  const windows: Array<{
    start: number;
    end: number;
    matchedTerms: string[];
    stats: LexicalDocumentTermStatsV1;
  }> = [];
  const seenStarts = new Set<number>();

  for (const term of terms) {
    for (const index of spreadOccurrencesV1(lowerContent, term)) {
      if (windows.length >= MAX_QUERY_WINDOWS) break;
      const start = clampInteger(
        index - Math.floor(maxPassageChars * 0.35),
        0,
        Math.max(0, content.length - Math.min(maxPassageChars, content.length)),
      );
      if (seenStarts.has(start)) continue;
      const end = Math.min(content.length, start + maxPassageChars);
      const lowerWindow = lowerContent.slice(start, end);
      windows.push({
        start,
        end,
        matchedTerms: terms.filter((candidate) => lowerWindow.includes(candidate)),
        stats: buildLexicalDocumentTermStatsV1(lowerWindow, terms),
      });
      seenStarts.add(start);
    }
  }

  // The corpus is the page's paragraphs, not the candidate windows. Windows are
  // built *around* query terms, so scoring them against each other makes every
  // term appear everywhere, IDF collapse to zero, and the ranking fall back to
  // document order -- which hands first place to whatever block sits nearest
  // the top. Paragraphs are what the terms are actually rare or common in.
  const corpus = buildLexicalCorpusStatsV1(
    lowerContent
      .split(/\n\s*\n/u)
      .filter((block) => block.trim().length > 0)
      .map((block) => buildLexicalDocumentTermStatsV1(block, terms)),
  );
  const candidates: PassageCandidate[] = windows.map((window) => ({
    start: window.start,
    end: window.end,
    score:
      window.matchedTerms.length * 100 + bm25ContentScoreV1(window.stats, corpus),
    selection: "query_match",
    matchedTerms: window.matchedTerms,
  }));

  return candidates.sort(
    (left, right) => right.score - left.score || left.start - right.start,
  );
}

function buildCoverageCandidates(
  contentLength: number,
  maxPassages: number,
  maxPassageChars: number,
): PassageCandidate[] {
  if (contentLength <= maxPassageChars) {
    return [{
      start: 0,
      end: contentLength,
      score: 0,
      selection: "coverage",
      matchedTerms: [],
    }];
  }

  const lastStart = contentLength - maxPassageChars;
  const count = Math.min(
    maxPassages,
    Math.max(2, Math.ceil(contentLength / maxPassageChars)),
  );
  return Array.from({ length: count }, (_, index) => {
    const start = count === 1
      ? 0
      : Math.round((lastStart * index) / (count - 1));
    return {
      start,
      end: Math.min(contentLength, start + maxPassageChars),
      score: 0,
      selection: "coverage" as const,
      matchedTerms: [],
    };
  });
}

function selectNonOverlapping(
  candidates: PassageCandidate[],
  limit: number,
): PassageCandidate[] {
  const selected: PassageCandidate[] = [];
  for (const candidate of candidates) {
    if (selected.length >= limit) {
      break;
    }
    if (selected.some((existing) => overlapRatio(existing, candidate) > 0.65)) {
      continue;
    }
    selected.push(candidate);
  }
  return selected;
}

function overlapRatio(
  left: Pick<PassageCandidate, "start" | "end">,
  right: Pick<PassageCandidate, "start" | "end">,
): number {
  const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
  const shorterLength = Math.max(1, Math.min(left.end - left.start, right.end - right.start));
  return overlap / shorterLength;
}

function trimWindow(
  content: string,
  start: number,
  end: number,
): { start: number; end: number; text: string } {
  const raw = content.slice(start, end);
  const leadingWhitespace = raw.match(/^\s*/)?.[0].length ?? 0;
  const trailingWhitespace = raw.match(/\s*$/)?.[0].length ?? 0;
  const adjustedStart = start + leadingWhitespace;
  const adjustedEnd = Math.max(adjustedStart, end - trailingWhitespace);
  return {
    start: adjustedStart,
    end: adjustedEnd,
    text: content.slice(adjustedStart, adjustedEnd),
  };
}

function tokenizeQuery(query: string): string[] {
  const matches = query.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? [];
  return [...new Set(matches
    .map((term) => term.replace(/^['-]+|['-]+$/g, ""))
    .filter((term) => term.length > 2 && !QUERY_STOP_TERMS.has(term)))]
    .sort((left, right) => right.length - left.length)
    .slice(0, MAX_QUERY_TERMS);
}

function countOccurrences(content: string, term: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor < content.length && count < 20) {
    const index = content.indexOf(term, cursor);
    if (index < 0) {
      break;
    }
    count += 1;
    cursor = index + Math.max(1, term.length);
  }
  return count;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
