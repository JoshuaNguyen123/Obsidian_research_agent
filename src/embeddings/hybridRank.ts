/**
 * Hybrid vault ranking: BM25 on full chunk text fused with cosine via RRF.
 *
 * The previous indexed lexical half scored a 360-character snippet with
 * overlap (or IDF-weighted overlap). A term past that window was invisible,
 * and the fusion `0.85 * cosine + 0.15 * snippet` let a slightly stronger
 * cosine drown a much better lexical match. Reciprocal Rank Fusion (k = 60)
 * treats the two lists as ranks, which is the standard way to combine a
 * bi-encoder and a lexical retriever without inventing a new weight.
 *
 * When the two RRF totals tie — the common case when cosine ranks a
 * question-shaped near-miss first and BM25 ranks the answering note first —
 * the BM25 score breaks the tie so the body that actually states the fact
 * wins, unless the cosine gap is larger than COSINE_TIEBREAK_MARGIN_V1
 * (a true semantic hit versus a keyword-stuffed distractor). That tie-break
 * is part of this fusion, not a second scorer.
 *
 * Graph proximity, when present, is a third RRF list (a document only
 * receives that term if it has a positive prior). That replaces the old 5%
 * additive blend and keeps the prior strictly opt-in.
 */
import {
  MAX_CONTENT_TERM_SCORE,
  bm25ContentScoreV1,
  buildLexicalCorpusStatsV1,
  buildLexicalDocumentTermStatsV1,
  type LexicalCorpusStatsV1,
} from "../tools/lexicalRanking";

/** Standard RRF damping constant (Cormack, Clarke, Buettcher). */
export const RRF_K_V1 = 60;

/** The linear blend this fusion replaces. Kept so tests can measure the delta. */
export const LEGACY_COSINE_WEIGHT_V1 = 0.85;
export const LEGACY_SNIPPET_WEIGHT_V1 = 0.15;

export function reciprocalRankScoreV1(rank: number, k: number = RRF_K_V1): number {
  return 1 / (k + rank);
}

/**
 * 1-based ranks from scores. Higher score is rank 1. Ties share the minimum
 * rank so two equal cosines do not invent an order.
 */
export function ranksFromScoresV1(scores: readonly number[]): number[] {
  const indexed = scores.map((score, index) => ({ score, index }));
  indexed.sort((left, right) => right.score - left.score || left.index - right.index);
  const ranks = new Array<number>(scores.length);
  let currentRank = 1;
  for (let position = 0; position < indexed.length; position += 1) {
    if (position > 0 && indexed[position]!.score < indexed[position - 1]!.score) {
      currentRank = position + 1;
    }
    ranks[indexed[position]!.index] = currentRank;
  }
  return ranks;
}

export function fuseBm25CosineRrfV1(input: {
  cosineScores: readonly number[];
  bm25Scores: readonly number[];
  graphScores?: ReadonlyArray<number | null>;
}): number[] {
  const cosineRanks = ranksFromScoresV1(input.cosineScores);
  const bm25Ranks = ranksFromScoresV1(input.bm25Scores);
  const graphRanks = input.graphScores
    ? ranksFromScoresV1(input.graphScores.map((score) => score ?? 0))
    : null;
  return input.cosineScores.map((_, index) => {
    let fused =
      reciprocalRankScoreV1(cosineRanks[index]!) +
      reciprocalRankScoreV1(bm25Ranks[index]!);
    if (
      graphRanks &&
      input.graphScores &&
      (input.graphScores[index] ?? 0) > 0
    ) {
      fused += reciprocalRankScoreV1(graphRanks[index]!);
    }
    return fused;
  });
}

export function legacyCosineSnippetBlendV1(
  cosine: number,
  snippetLexical: number,
): number {
  return cosine * LEGACY_COSINE_WEIGHT_V1 + snippetLexical * LEGACY_SNIPPET_WEIGHT_V1;
}

export function snippetOverlapLexicalScoreV1(
  queryTerms: ReadonlySet<string>,
  snippet: string,
): number {
  if (queryTerms.size === 0) return 0;
  const snippetTerms = new Set(
    (snippet.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) ?? [])
      .map((term) => term.replace(/^['-]+|['-]+$/g, ""))
      .filter((term) => term.length > 2),
  );
  if (snippetTerms.size === 0) return 0;
  let overlap = 0;
  for (const term of queryTerms) {
    if (snippetTerms.has(term)) overlap += 1;
  }
  return overlap / queryTerms.size;
}

export interface HybridCandidateV1 {
  cosine: number;
  /** Full chunk text (plus title/heading/tags). Never a 360-char snippet. */
  lexicalText: string;
  graph?: number | null;
}

export interface HybridScoredV1 {
  /** RRF fusion of cosine and BM25 ranks (plus graph when present). */
  score: number;
  semanticScore: number;
  /** BM25 content score mapped onto 0..1 for the public hit field. */
  lexicalScore: number;
  bm25: number;
  reasons: string[];
}

export function scoreHybridCandidatesV1(
  candidates: readonly HybridCandidateV1[],
  queryTerms: readonly string[],
): HybridScoredV1[] {
  if (candidates.length === 0) return [];
  const documents = candidates.map((candidate) =>
    buildLexicalDocumentTermStatsV1(candidate.lexicalText.toLowerCase(), queryTerms),
  );
  const corpus: LexicalCorpusStatsV1 = buildLexicalCorpusStatsV1(documents);
  const bm25Scores = documents.map((document) =>
    bm25ContentScoreV1(document, corpus),
  );
  const fused = fuseBm25CosineRrfV1({
    cosineScores: candidates.map((candidate) => candidate.cosine),
    bm25Scores,
    graphScores: candidates.map((candidate) => candidate.graph ?? null),
  });
  return candidates.map((candidate, index) => {
    const bm25 = bm25Scores[index] ?? 0;
    const cosine = candidate.cosine;
    const reasons: string[] = [];
    if (cosine > 0.55) reasons.push("semantic_similarity");
    if (bm25 > 0) reasons.push("bm25_content");
    if ((candidate.graph ?? 0) > 0) reasons.push("graph_proximity");
    return {
      score: fused[index] ?? 0,
      semanticScore: cosine,
      lexicalScore: Math.min(1, bm25 / MAX_CONTENT_TERM_SCORE),
      bm25,
      reasons,
    };
  });
}

/**
 * When RRF ties, a large cosine gap (a true semantic hit vs a keyword
 * distractor) still wins. A smaller gap is the question-shaped near-miss
 * case: BM25 on full chunk text decides.
 */
export const COSINE_TIEBREAK_MARGIN_V1 = 0.3;

export function compareHybridScoredV1(
  left: HybridScoredV1,
  right: HybridScoredV1,
): number {
  const rrf = right.score - left.score;
  if (rrf !== 0) return rrf;
  const cosineGap = right.semanticScore - left.semanticScore;
  if (Math.abs(cosineGap) > COSINE_TIEBREAK_MARGIN_V1) return cosineGap;
  return right.bm25 - left.bm25 || cosineGap;
}
