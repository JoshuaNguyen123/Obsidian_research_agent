export type SemanticEmbeddingDim = 256 | 512;

export interface SemanticEmbeddingRequest {
  model: string;
  dim: SemanticEmbeddingDim;
  cacheDir?: string;
  documents: string[];
  queries: string[];
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
