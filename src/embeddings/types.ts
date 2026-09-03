export type SemanticEmbeddingDim = 256 | 512;

export interface SemanticEmbeddingRequest {
  model: string;
  dim: SemanticEmbeddingDim;
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
  embed(request: SemanticEmbeddingRequest): Promise<SemanticEmbeddingResponse>;
  dispose?(): void;
}
