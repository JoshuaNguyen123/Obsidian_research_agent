/**
 * Width of the vectors an index is built at. Any positive integer the model
 * can actually produce; `resolveEffectiveEmbeddingDimV1` in
 * `embeddingModelCatalogV1.ts` turns the user's setting into this, and the
 * provider rejects a response whose vectors are a different width.
 */
export type SemanticEmbeddingDim = number;

export type SemanticEmbeddingPriority = "interactive" | "background";

export interface SemanticEmbeddingRequest {
  /**
   * Which helper operation this is. Absent means "embed", the only op the
   * helper answered before cross-encoder reranking existed, so every stored
   * caller keeps working unchanged.
   */
  op?: "embed" | "rerank";
  model: string;
  dim: SemanticEmbeddingDim;
  /** Rerank op only: the query each document is scored against. */
  query?: string;
  /**
   * Whether the runtime may apply the Matryoshka recipe (layer-norm, truncate
   * to `dim`, L2-normalise). Only models trained with Matryoshka Representation
   * Learning survive truncation; for every other model the helper returns the
   * native vectors unchanged apart from L2 normalisation, and `dim` must equal
   * the native width. Omitted means true, which is what every request carried
   * before the flag existed.
   */
  matryoshka?: boolean;
  /**
   * Scheduling class on the provider's serial queue. A user-facing search or
   * reflex classification is `interactive` (the default) and runs before any
   * queued `background` work such as an index rebuild batch, so a rebuild in
   * progress cannot hold a search for minutes. Never preempts a request the
   * helper is already executing.
   */
  priority?: SemanticEmbeddingPriority;
  cacheDir?: string;
  /**
   * ONNX Runtime execution providers to try, most preferred first. The helper
   * falls back to the runtime's default when they are unavailable and names
   * what it actually used in `providersUsed`.
   */
  providers?: string[];
  documents: string[];
  queries: string[];
  /**
   * The run's abort signal. The helper cannot cancel an in-flight request,
   * but a request still waiting in the provider queue when the run stops
   * is skipped instead of starting a pointless (and blocking) helper call.
   */
  signal?: AbortSignal;
  /**
   * Instruction prefixes this model expects. Resolved by the caller from
   * embeddingPrefixes.ts rather than assumed by the provider, because the
   * convention is per model and applying the wrong one silently costs recall.
   * Omitted means no prefix.
   */
  queryPrefix?: string;
  documentPrefix?: string;
}

/**
 * One cross-encoder scoring pass: the query and each candidate passage go
 * through the model together, so the score reflects the pair rather than two
 * independently-embedded points. That is why it is accurate and why it is only
 * ever run over a shortlist -- cost is linear in candidates, not in vault size.
 */
export interface SemanticRerankRequest {
  model: string;
  cacheDir?: string;
  query: string;
  documents: string[];
  priority?: SemanticEmbeddingPriority;
  signal?: AbortSignal;
}

export interface SemanticRerankResponse {
  ok: boolean;
  model: string;
  /** One relevance logit per document, in the order they were sent. */
  scores?: number[];
  code?: string;
  message?: string;
}

export interface SemanticEmbeddingResponse {
  ok: boolean;
  model: string;
  dim: number;
  documents?: number[][];
  queries?: number[][];
  /** Rerank op only: one relevance logit per document sent. */
  scores?: number[];
  downloadedOrVerified?: boolean;
  cacheDir?: string;
  /** Execution providers the runtime actually loaded the model with. */
  providersUsed?: string[];
  code?: string;
  message?: string;
}

export interface SemanticEmbeddingProvider {
  /**
   * Stable identity of the transport and runtime that produced the vectors,
   * recorded in the index so switching providers rebuilds it exactly once.
   */
  readonly id?: string;
  embed(request: SemanticEmbeddingRequest): Promise<SemanticEmbeddingResponse>;
  /**
   * Optional cross-encoder rescoring of a shortlist. A provider that does not
   * implement it means "reranking is unavailable here", which callers must
   * treat as a ranking that stays as it was -- never as a search failure.
   */
  rerank?(request: SemanticRerankRequest): Promise<SemanticRerankResponse>;
  dispose?(): void;
}
