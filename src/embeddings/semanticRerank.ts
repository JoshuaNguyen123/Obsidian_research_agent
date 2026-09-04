import type {
  SemanticEmbeddingPriority,
  SemanticEmbeddingProvider,
} from "./types";

/**
 * Cross-encoder reranking: the accuracy half of a two-stage retrieval.
 *
 * The bi-encoder index answers "which fifty chunks are in the neighbourhood"
 * over the whole vault, cheaply, because every chunk was embedded once at index
 * time. It cannot see the query and the chunk together, so it mixes up chunks
 * that share vocabulary with the question but do not answer it. A cross-encoder
 * reads the pair and scores it directly; it is far more accurate and far too
 * expensive to run over a vault, so it runs over the shortlist only. Measured
 * on this project's reference CPU (i7-1165G7, 2026-09-04): `jina-reranker-v1-tiny-en`
 * scores about 16 pairs a second at 256-token chunks and 7 at 500-token chunks,
 * so a twenty-candidate rerank costs a bit over a second and never touches the
 * per-note indexing cost at all.
 *
 * Two rules hold everywhere in this module:
 *
 * - Reranking **reorders, never removes**. `minScore` stays a first-stage gate;
 *   a candidate that survived retrieval stays in the results even if the
 *   cross-encoder dislikes it, it just sinks.
 * - Reranking is **best-effort**. A missing model, an old FastEmbed without the
 *   reranking extra, a stopped run: every one of those leaves the first-stage
 *   ranking exactly as it was and reports why. A search must never fail because
 *   the optional accuracy stage was unavailable.
 */

export interface SemanticRerankModelSpecV1 {
  id: string;
  /** Download size of the ONNX weights, for the settings row. */
  sizeMb: number;
  /** Longest input the model accepts, in tokens. */
  maxTokens: number;
  /**
   * Pairs scored per second on the reference CPU at a 256-token chunk, from
   * `scripts/benchmark-embedders.ts --rerank`. The number a user needs to
   * predict what turning this on costs them per search.
   */
  pairsPerSecond: number;
  /**
   * What the model actually bought on the project's retrieval fixture
   * (paraphrase set, 20-candidate shortlist, 2026-09-04): mean reciprocal rank
   * against 0.61 with no reranking at all, and the whole search's wall clock.
   * Ranking models by size gets this wrong -- the 1 GB one is the slowest and
   * not the most accurate -- so the measured pair is carried here and shown in
   * settings rather than left to intuition.
   */
  measured: { paraphraseMrr: number; searchMs: number };
  tier: "fast" | "balanced" | "accurate";
  summary: string;
}

/**
 * The cross-encoders FastEmbed 0.8.0 can run locally. Every row's throughput
 * was measured here rather than copied from a model card.
 */
export const SEMANTIC_RERANK_MODEL_CATALOG_V1: readonly SemanticRerankModelSpecV1[] =
  Object.freeze([
    Object.freeze({
      id: "jinaai/jina-reranker-v1-tiny-en",
      sizeMb: 130,
      maxTokens: 8192,
      pairsPerSecond: 16.6,
      measured: { paraphraseMrr: 0.73, searchMs: 1478 },
      tier: "fast",
      summary:
        "Fastest of the local rerankers, with an 8k window so a long chunk is scored whole rather than truncated. Least accurate of the four usable ones.",
    }),
    Object.freeze({
      id: "Xenova/ms-marco-MiniLM-L-6-v2",
      sizeMb: 80,
      maxTokens: 512,
      pairsPerSecond: 15.6,
      measured: { paraphraseMrr: 0.78, searchMs: 1717 },
      tier: "fast",
      summary:
        "The classic MS MARCO reranker: smallest download, nearly as quick as the tiny one and more accurate. 512-token window.",
    }),
    Object.freeze({
      id: "jinaai/jina-reranker-v1-turbo-en",
      sizeMb: 150,
      maxTokens: 8192,
      pairsPerSecond: 12.3,
      measured: { paraphraseMrr: 0.84, searchMs: 2292 },
      tier: "accurate",
      summary:
        "Most accurate of the local rerankers on this project's fixture and still about two seconds a search: the default. 8k window.",
    }),
    Object.freeze({
      id: "Xenova/ms-marco-MiniLM-L-12-v2",
      sizeMb: 120,
      maxTokens: 512,
      pairsPerSecond: 8.0,
      measured: { paraphraseMrr: 0.82, searchMs: 3819 },
      tier: "balanced",
      summary:
        "Twelve layers instead of six: more accurate than its six-layer sibling, and slower than the Jina model that beats it.",
    }),
    Object.freeze({
      id: "BAAI/bge-reranker-base",
      sizeMb: 1040,
      maxTokens: 512,
      pairsPerSecond: 2.1,
      measured: { paraphraseMrr: 0.88, searchMs: 10447 },
      tier: "accurate",
      summary:
        "The most accurate local reranker and the only one that ever promotes an answer over a note restating the question -- at about ten seconds a search on a laptop CPU. For patience, not for daily use.",
    }),
  ]);

/**
 * Chosen by measurement, not by size or speed: highest fixture MRR among the
 * models that keep a search under three seconds (2026-09-04 sweep).
 */
export const DEFAULT_SEMANTIC_RERANK_MODEL = "jinaai/jina-reranker-v1-turbo-en";

/** Never score more pairs than this in one search, whatever the setting says. */
export const MAX_SEMANTIC_RERANK_TOP_K = 50;
/**
 * Ten, because accuracy is flat in this number and cost is linear in it. On the
 * project's fixture (2026-09-04) a shortlist of 5, 10, 15 and 20 all scored MRR
 * 0.84 while the search cost 0.36 s, 0.65 s, 1.39 s and 2.29 s -- the fixture's
 * answers are always inside the first stage's top 5, so anything deeper is pure
 * overhead there. Ten rather than five is insurance for a real vault, where the
 * first stage can put the right chunk at rank 8 and a five-deep shortlist would
 * never show it to the reranker.
 */
export const DEFAULT_SEMANTIC_RERANK_TOP_K = 10;

export interface ResolvedSemanticRerankV1 {
  enabled: boolean;
  model: string;
  topK: number;
}

/**
 * When the cross-encoder runs.
 *
 * The stage costs about a second of local CPU per search, which is worth
 * paying when a research mission is deciding what to cite and is not worth
 * paying when a reflex classifier is checking an intent. `research` splits
 * those two cases on the `deep` search mode the caller already declares --
 * that is where the shortlist is being read for evidence -- so the accuracy is
 * spent where it changes an answer. `off` and `cross_encoder` remain the
 * unconditional ends of the range.
 */
export type SemanticRerankModeV1 = "off" | "research" | "cross_encoder";

/**
 * Read the three settings as one decision. Anything unreadable resolves to
 * "off": the accuracy stage costs CPU on every search, so it is never inferred.
 */
export function resolveSemanticRerankSettingsV1(
  settings: {
    semanticRerankMode?: SemanticRerankModeV1;
    semanticRerankModel?: string;
    semanticRerankTopK?: number;
  },
  options: { deepSearch?: boolean } = {},
): ResolvedSemanticRerankV1 {
  const model = settings.semanticRerankModel?.trim() || DEFAULT_SEMANTIC_RERANK_MODEL;
  const mode = settings.semanticRerankMode;
  return {
    enabled:
      mode === "cross_encoder" ||
      (mode === "research" && options.deepSearch === true),
    model,
    topK: normalizeSemanticRerankTopKV1(settings.semanticRerankTopK),
  };
}

export function findSemanticRerankModelSpecV1(
  model: string,
): SemanticRerankModelSpecV1 | null {
  const wanted = model.trim().toLowerCase();
  if (!wanted) return null;
  return (
    SEMANTIC_RERANK_MODEL_CATALOG_V1.find(
      (spec) => spec.id.toLowerCase() === wanted,
    ) ?? null
  );
}

export function normalizeSemanticRerankTopKV1(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SEMANTIC_RERANK_TOP_K;
  }
  return Math.min(MAX_SEMANTIC_RERANK_TOP_K, Math.max(1, Math.trunc(parsed)));
}

/**
 * Cross-encoder outputs are unbounded logits; the retrieval score is a 0..1
 * blend. Squashing through a logistic curve puts them on one scale, and keeping
 * a quarter of the first-stage score means a single confident reranker mistake
 * cannot bury a chunk that both the embedding and the lexical half liked.
 */
export const RERANK_WEIGHT_V1 = 0.75;

export function blendRerankScoreV1(logit: number, baseScore: number): number {
  const squashed = 1 / (1 + Math.exp(-logit));
  return RERANK_WEIGHT_V1 * squashed + (1 - RERANK_WEIGHT_V1) * baseScore;
}

export interface RerankableHitV1 {
  score: number;
  reasons: string[];
  /** Set on hits the cross-encoder actually scored: its squashed 0..1 score. */
  rerankScore?: number;
}

export interface SemanticRerankOutcomeV1<T extends RerankableHitV1> {
  /** The full ranking: reranked head first, untouched tail in its old order. */
  hits: T[];
  applied: boolean;
  /**
   * Why the ranking looks the way it does: `cross_encoder_reranked`, or a
   * `rerank_skipped:*` / `rerank_unavailable:*` reason naming the cause.
   */
  reason: string;
  /** Wall clock spent in the rerank stage, including model load on first use. */
  ms: number;
  candidateCount: number;
}

/**
 * Rescore the head of a ranking with a cross-encoder.
 *
 * `textFor` hands back the text that was indexed for a hit — the caller owns
 * that, because only it knows how to turn a hit back into its chunk. A hit with
 * no text (its note changed since the index was built, say) is left out of the
 * rerank and keeps its place behind the ones that were scored.
 */
export async function rerankSemanticHitsV1<T extends RerankableHitV1>({
  hits,
  query,
  textFor,
  provider,
  model,
  cacheDir,
  topK,
  priority = "interactive",
  signal,
  now = () => Date.now(),
}: {
  hits: T[];
  query: string;
  textFor: (hit: T) => string | null;
  provider: SemanticEmbeddingProvider;
  model: string;
  cacheDir?: string;
  topK: number;
  priority?: SemanticEmbeddingPriority;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<SemanticRerankOutcomeV1<T>> {
  const startedAt = now();
  const unavailable = (reason: string): SemanticRerankOutcomeV1<T> => ({
    hits,
    applied: false,
    reason,
    ms: Math.max(0, now() - startedAt),
    candidateCount: 0,
  });

  if (!provider.rerank) {
    return unavailable("rerank_unavailable:provider_has_no_reranker");
  }
  if (!query.trim() || hits.length === 0) {
    return unavailable("rerank_skipped:nothing_to_rank");
  }
  if (signal?.aborted) {
    return unavailable("rerank_skipped:aborted");
  }

  const bounded = Math.min(normalizeSemanticRerankTopKV1(topK), hits.length);
  const head: Array<{ hit: T; text: string }> = [];
  const skipped: T[] = [];
  for (const hit of hits.slice(0, bounded)) {
    const text = textFor(hit)?.trim();
    if (text) {
      head.push({ hit, text });
    } else {
      skipped.push(hit);
    }
  }
  const tail = hits.slice(bounded);
  if (head.length === 0) {
    return unavailable("rerank_skipped:no_chunk_text");
  }

  let response;
  try {
    response = await provider.rerank({
      model,
      cacheDir,
      query,
      documents: head.map((item) => item.text),
      priority,
      signal,
    });
  } catch (error) {
    return unavailable(
      `rerank_unavailable:${error instanceof Error ? error.name : "error"}`,
    );
  }
  if (!response.ok || !response.scores || response.scores.length !== head.length) {
    return unavailable(`rerank_unavailable:${response.code ?? "rerank_failed"}`);
  }

  const scored = head.map((item, index) => {
    const logit = response.scores![index];
    const squashed = 1 / (1 + Math.exp(-logit));
    item.hit.rerankScore = Number(squashed.toFixed(4));
    item.hit.score = Number(blendRerankScoreV1(logit, item.hit.score).toFixed(4));
    if (!item.hit.reasons.includes("cross_encoder_reranked")) {
      item.hit.reasons = [...item.hit.reasons, "cross_encoder_reranked"];
    }
    return item.hit;
  });
  scored.sort((left, right) => right.score - left.score);

  return {
    hits: [...scored, ...skipped, ...tail],
    applied: true,
    reason: "cross_encoder_reranked",
    ms: Math.max(0, now() - startedAt),
    candidateCount: scored.length,
  };
}
