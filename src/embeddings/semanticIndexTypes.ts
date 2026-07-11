export interface SemanticIndexChunk {
  id: string;
  path: string;
  title: string;
  heading: string | null;
  textHash: string;
  tokenCount: number;
  snippet: string;
  vector: number[];
}

export interface SemanticIndexNote {
  path: string;
  title: string;
  mtime: number;
  size: number;
  contentHash: string;
  tags: string[];
  links: string[];
  headings: string[];
  chunks: SemanticIndexChunk[];
}

export interface SemanticVaultIndexV1 {
  version: 1;
  model: string;
  dim: 256 | 512;
  chunking: {
    minTokens: number;
    targetTokens: number;
    maxTokens: number;
    overlapTokens: number;
  };
  indexedAt: string;
  notes: SemanticIndexNote[];
}

export interface SemanticIndexRowMeta {
  id: string;
  notePath: string;
  title: string;
  heading: string | null;
  textHash: string;
  tokenCount: number;
  snippet: string;
}

export interface SemanticIndexNoteMeta {
  path: string;
  title: string;
  mtime: number;
  size: number;
  contentHash: string;
  tags: string[];
  links: string[];
  headings: string[];
  chunkCount: number;
  firstSnippet: string;
}

export interface SemanticIndexShardRef {
  id: string;
  path: string;
  rowCount: number;
  vectorEncoding: "float32-base64";
}

export interface SemanticIndexShardV2 {
  version: 2;
  id: string;
  model: string;
  dim: 256 | 512;
  indexedAt: string;
  rows: SemanticIndexRowMeta[];
  vectorsBase64: string;
}

export interface SemanticVaultIndexV2 {
  version: 2;
  model: string;
  dim: 256 | 512;
  chunking: {
    minTokens: number;
    targetTokens: number;
    maxTokens: number;
    overlapTokens: number;
  };
  indexedAt: string;
  notes: SemanticIndexNoteMeta[];
  shards: SemanticIndexShardRef[];
  totalRows: number;
}

export type SemanticVaultIndex = SemanticVaultIndexV1 | SemanticVaultIndexV2;

export interface SemanticIndexBuildResult {
  ok: boolean;
  operation: "semantic_index_rebuild" | "semantic_index_update";
  markdownPath: string;
  jsonPath: string;
  indexedAt?: string;
  noteCount: number;
  chunkCount: number;
  updatedPaths: string[];
  removedPaths: string[];
  skippedPaths: string[];
  code?: string;
  message?: string;
}

export interface SemanticIndexSearchRequest {
  query: string;
  limit: number;
  folder?: string | null;
  maxSnippetChars?: number;
  mode?: "standard" | "deep";
  candidateLimit?: number;
  minScore?: number;
  cursor?: string | null;
}

export interface SemanticIndexSearchResult {
  ok: boolean;
  operation: "semantic_index_search";
  mode: "indexed_semantic";
  indexUsed: boolean;
  indexFresh: boolean;
  model: string;
  dim: number;
  indexedAt?: string;
  candidateCount?: number;
  nextCursor?: string | null;
  resultCount: number;
  results: SemanticIndexSearchHit[];
  code?: string;
  message?: string;
}

export interface SemanticIndexSearchHit {
  path: string;
  title: string;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  reasons: string[];
  heading: string | null;
  snippet: string;
}

export interface SemanticIndexService {
  load(): Promise<SemanticVaultIndex | null>;
  rebuild(): Promise<SemanticIndexBuildResult>;
  updatePaths(paths: string[]): Promise<SemanticIndexBuildResult>;
  removePaths(paths: string[]): Promise<void>;
  search(
    request: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult>;
}
