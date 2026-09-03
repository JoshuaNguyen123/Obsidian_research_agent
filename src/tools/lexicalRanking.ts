/**
 * Corpus-aware lexical ranking for `search_markdown_files`.
 *
 * The previous scorer was additive term frequency: every extra occurrence of
 * a query term was worth the same as the first, no term was rarer than any
 * other, and a short note stuffed with the query word outranked the note that
 * actually answered it (`tests/retrievalQuality.test.ts` pinned recall@1 = 0
 * on a fixture built to show exactly that). Three changes, all pure:
 *
 * 1. Occurrences are counted INFORMATIVELY. A run of the same needle with
 *    nothing but whitespace or punctuation between repeats counts once, and a
 *    line that is mostly query vocabulary (a keyword list, not prose) has its
 *    matches discounted to a quarter. A term inside a sentence that says
 *    something is evidence; the same term repeated five times is not.
 * 2. Terms are weighted by corpus rarity (BM25 IDF over the notes the search
 *    actually scanned), so "study" in a vault full of studies counts less
 *    than a rare technical term.
 * 3. Term frequency saturates and is length-normalized (BM25 with k1 = 1.2,
 *    b = 0.75), so a tenth mention is worth almost nothing and a long note is
 *    not rewarded merely for being long.
 *
 * Title, path, and phrase bonuses keep their previous shape and range; only
 * the counting behind phrase matches and the content component changed. No
 * index is built or persisted: the corpus statistics are computed in the same
 * pass that already reads every note, and discarded with the call.
 */

export const BM25_K1 = 1.2;
/**
 * Length normalization. The web-search default (0.75) assumes a long document
 * is a verbose one; in a note vault a long note is often the one that holds
 * the buried answer, so length is discounted only half as hard.
 */
export const BM25_B = 0.5;
/** Bonus per additional distinct query term a note covers (multi-term queries). */
export const QUERY_COVERAGE_BONUS_PER_TERM = 15;
export const MAX_QUERY_COVERAGE_BONUS = 30;
/** Share of a line's tokens that must be query vocabulary to call it a keyword list. */
export const KEYWORD_LINE_DENSITY_THRESHOLD = 0.6;
/** Weight of a match that sits on a keyword-list line. */
export const KEYWORD_LINE_MATCH_WEIGHT = 0.25;
/** Scale that maps the BM25 content sum onto the scorer's 0..50 content band. */
export const BM25_CONTENT_SCALE = 8;
export const MAX_CONTENT_TERM_SCORE = 50;

const TOKEN_RE = /[a-z0-9][a-z0-9_-]+/g;

export interface LexicalDocumentTermStatsV1 {
  /** Informative occurrences of each query term (see module docs). */
  termFrequencies: ReadonlyMap<string, number>;
  /** Content length in characters; the BM25 length normalization unit. */
  length: number;
}

export interface LexicalCorpusStatsV1 {
  documentCount: number;
  averageLength: number;
  /** Documents containing each query term at least once. */
  documentFrequencies: ReadonlyMap<string, number>;
}

/**
 * Count occurrences of `needle` in `contentLower`, collapsing adjacent repeats
 * and discounting keyword-list lines. `queryTerms` is the full query
 * vocabulary, used to recognise a line that is mostly query words.
 */
export function informativeOccurrenceCountV1(
  contentLower: string,
  needle: string,
  queryTerms: readonly string[],
): number {
  if (!needle) return 0;
  const vocabulary = new Set<string>();
  for (const term of queryTerms) vocabulary.add(term);
  for (const token of needle.match(TOKEN_RE) ?? []) vocabulary.add(token);

  let total = 0;
  let searchFrom = 0;
  let previousEnd = -1;
  while (searchFrom <= contentLower.length) {
    const index = contentLower.indexOf(needle, searchFrom);
    if (index < 0) break;
    const end = index + needle.length;
    const gap = previousEnd < 0 ? null : contentLower.slice(previousEnd, index);
    // A repeat is "adjacent" when nothing but whitespace, punctuation, or
    // other query vocabulary separates it from the previous occurrence:
    // "quantitative easing quantitative easing" is one mention of
    // "quantitative", not two.
    const adjacentRepeat =
      gap !== null &&
      (gap.match(TOKEN_RE) ?? []).every((token) => vocabulary.has(token));
    if (!adjacentRepeat) {
      total += lineIsKeywordList(contentLower, index, vocabulary)
        ? KEYWORD_LINE_MATCH_WEIGHT
        : 1;
    }
    previousEnd = end;
    searchFrom = end;
  }
  return total;
}

function lineIsKeywordList(
  contentLower: string,
  index: number,
  vocabulary: ReadonlySet<string>,
): boolean {
  const lineStart = contentLower.lastIndexOf("\n", index) + 1;
  const lineEndIndex = contentLower.indexOf("\n", index);
  const line = contentLower.slice(
    lineStart,
    lineEndIndex < 0 ? contentLower.length : lineEndIndex,
  );
  const tokens = line.match(TOKEN_RE) ?? [];
  if (tokens.length < 3) return false;
  let queryTokens = 0;
  for (const token of tokens) {
    if (vocabulary.has(token)) queryTokens += 1;
  }
  return queryTokens / tokens.length >= KEYWORD_LINE_DENSITY_THRESHOLD;
}

export function buildLexicalDocumentTermStatsV1(
  contentLower: string,
  queryTerms: readonly string[],
): LexicalDocumentTermStatsV1 {
  const termFrequencies = new Map<string, number>();
  for (const term of queryTerms) {
    const count = informativeOccurrenceCountV1(contentLower, term, queryTerms);
    if (count > 0) termFrequencies.set(term, count);
  }
  return { termFrequencies, length: contentLower.length };
}

export function buildLexicalCorpusStatsV1(
  documents: readonly LexicalDocumentTermStatsV1[],
): LexicalCorpusStatsV1 {
  const documentFrequencies = new Map<string, number>();
  let totalLength = 0;
  for (const document of documents) {
    totalLength += document.length;
    for (const [term, count] of document.termFrequencies) {
      if (count > 0) {
        documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
      }
    }
  }
  return {
    documentCount: documents.length,
    averageLength: documents.length > 0 ? totalLength / documents.length : 0,
    documentFrequencies,
  };
}

/** BM25 inverse document frequency; always positive. */
export function inverseDocumentFrequencyV1(
  corpus: LexicalCorpusStatsV1,
  term: string,
): number {
  const documentFrequency = corpus.documentFrequencies.get(term) ?? 0;
  return Math.log(
    1 + (corpus.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
  );
}

/**
 * A note that mentions every term of a multi-term query answers it more
 * plausibly than a note that mentions one term often. Zero for single-term
 * queries and for notes covering at most one term.
 */
export function queryCoverageBonusV1(
  document: LexicalDocumentTermStatsV1,
  queryTermCount: number,
): number {
  if (queryTermCount <= 1) return 0;
  let covered = 0;
  for (const count of document.termFrequencies.values()) {
    if (count > 0) covered += 1;
  }
  return Math.min(
    MAX_QUERY_COVERAGE_BONUS,
    QUERY_COVERAGE_BONUS_PER_TERM * Math.max(0, covered - 1),
  );
}

/**
 * The BM25 content component for one document, on the scorer's 0..50 band.
 * Returns 0 when no query term occurs informatively.
 */
export function bm25ContentScoreV1(
  document: LexicalDocumentTermStatsV1,
  corpus: LexicalCorpusStatsV1,
): number {
  if (document.termFrequencies.size === 0) return 0;
  const lengthRatio =
    corpus.averageLength > 0 ? document.length / corpus.averageLength : 1;
  const normalizer = BM25_K1 * (1 - BM25_B + BM25_B * lengthRatio);
  let total = 0;
  for (const [term, frequency] of document.termFrequencies) {
    if (frequency <= 0) continue;
    const saturated = (frequency * (BM25_K1 + 1)) / (frequency + normalizer);
    total += inverseDocumentFrequencyV1(corpus, term) * saturated;
  }
  return Math.min(MAX_CONTENT_TERM_SCORE, total * BM25_CONTENT_SCALE);
}
