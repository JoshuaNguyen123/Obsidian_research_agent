/**
 * Width of the vectors an index is built at. Any positive integer the model
 * can actually produce; `resolveEffectiveEmbeddingDimV1` in
 * `embeddingModelCatalogV1.ts` turns the user's setting into this, and the
 * provider rejects a response whose vectors are a different width.
 */
export type SemanticEmbeddingDim = number;

export interface SemanticEmbeddingRequest {
  model: string;
  dim: SemanticEmbeddingDim;
  /**
   * Whether the runtime may apply the Matryoshka recipe (layer-norm, truncate
   * to `dim`, L2-normalise). Only models trained with Matryoshka Representation
   * Learning survive truncation; for every other model the helper returns the
   * native vectors unchanged apart from L2 normalisation, and `dim` must equal
   * the native width. Omitted means true, which is what every request carried
   * before the flag existed.
   */
  matryoshka?: boolean;
  cacheDir?: string;
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

export interface SemanticEmbeddingResponse {
  ok: boolean;
  model: string;
  dim: number;
  documents?: number[][];
  queries?: number[][];
  downloadedOrVerified?: boolean;
  cacheDir?: string;
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
  dispose?(): void;
}
