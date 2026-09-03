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
  dim: number;
  /** Prefix-pair fingerprint the vectors were built under. Absent = legacy. */
  promptPrefixes?: string;
  /** Embedding provider that produced the vectors. Absent = the Python FastEmbed helper. */
  providerId?: string;
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
  dim: number;
  /** Prefix-pair fingerprint the vectors were built under. Absent = legacy. */
  promptPrefixes?: string;
  /** Embedding provider that produced the vectors. Absent = the Python FastEmbed helper. */
  providerId?: string;
  indexedAt: string;
  rows: SemanticIndexRowMeta[];
  vectorsBase64: string;
}

export interface SemanticVaultIndexV2 {
  version: 2;
  model: string;
  dim: number;
  /** Prefix-pair fingerprint the vectors were built under. Absent = legacy. */
  promptPrefixes?: string;
  /** Embedding provider that produced the vectors. Absent = the Python FastEmbed helper. */
  providerId?: string;
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
  /** The run's abort signal; a stopped run does not wait for the embedder. */
  signal?: AbortSignal;
  /**
   * Cap on how many changed-but-not-yet-reindexed notes a search will embed
   * live and merge into the indexed hits. Defaults to
   * `MAX_LIVE_STALE_NOTES_PER_SEARCH`; 0 disables the merge and simply
   * excludes stale notes.
   */
  maxLiveStaleNotes?: number;
  /**
   * Vault paths whose graph neighbourhood should receive a small ranking
   * boost — typically the note the user is working in. Omitting this (the
   * default) leaves scoring byte-identical to the pure semantic+lexical blend.
   */
  seedPaths?: string[];
}

export interface SemanticIndexSearchTimingsV1 {
  /** Base64 decode of shard vectors, excluding vault file reads. */
  decodeMs: number;
  /** Cosine scoring plus lexical blending over the decoded rows. */
  scoreMs: number;
  /** Rows actually scored, so a duration can be read per row. */
  rowsScored: number;
}

/**
 * What a search did about notes the index no longer describes. Editing one
 * note used to fail the whole search as `stale_index` and route the tool to the
 * unindexed live path; now the stale notes are excluded (or, for a handful,
 * embedded live and merged) and the search says so.
 */
export interface SemanticIndexStaleReportV1 {
  /** Indexed notes whose mtime or size no longer matches; excluded or merged. */
  changedPaths: string[];
  /** Indexed notes that no longer exist; excluded. */
  missingPaths: string[];
  /** Indexable notes the index has never seen; not searchable until reindexed. */
  unindexedPaths: string[];
  /** Subset of `changedPaths` that was embedded live and merged into the hits. */
  liveMergedPaths: string[];
}

export interface SemanticIndexSearchResult {
  ok: boolean;
  operation: "semantic_index_search";
  mode: "indexed_semantic";
  indexUsed: boolean;
  indexFresh: boolean;
  /** Present when `indexFresh` is false on a successful search. */
  stale?: SemanticIndexStaleReportV1;
  model: string;
  dim: number;
  indexedAt?: string;
  candidateCount?: number;
  nextCursor?: string | null;
  resultCount: number;
  results: SemanticIndexSearchHit[];
  /**
   * Where the wall clock of one indexed search actually went. A tool-level
   * duration says a search took 400ms; it cannot say whether that was base64
   * shard decode or vector scoring, which is exactly the split that decides
   * whether optimising the scan is worth doing.
   */
  timings?: SemanticIndexSearchTimingsV1;
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
