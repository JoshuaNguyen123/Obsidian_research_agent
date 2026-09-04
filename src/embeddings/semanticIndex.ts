import { raceAbort } from "../utils/raceAbort";
import type { App, TFile } from "obsidian";
import { cosineSimilarity, normalizeCosine, cosineSimilarityAt, vectorNorm } from "../utils/vectorMath";
import type { AgentSettings } from "../settings";
import {
  embeddingPrefixFingerprintV1,
  resolveEmbeddingPrefixesV1,
} from "./embeddingPrefixes";
import { resolveEffectiveEmbeddingDimV1 } from "./embeddingModelCatalogV1";
import {
  rerankSemanticHitsV1,
  resolveSemanticRerankSettingsV1,
} from "./semanticRerank";
import { PYTHON_FASTEMBED_PROVIDER_ID } from "./pythonFastEmbedProvider";
import { NEW_INSTALL_SEMANTIC_EMBEDDING_MODEL } from "../agent/semanticProfile";
import { COSINE_TIEBREAK_MARGIN_V1, scoreHybridCandidatesV1 } from "./hybridRank";
import {
  chunkMarkdownForSemanticSearch,
  type SemanticChunkingOptions,
} from "../tools/semanticSearchTools";
import { normalizeVaultPath } from "../tools/validation";
import { isPathUnderVaultFolder, isVaultPathExcluded } from "../tools/vaultExclusions";
import { mapWithBoundedConcurrency } from "../utils/boundedConcurrency";
import type { SemanticEmbeddingPriority, SemanticEmbeddingProvider } from "./types";
import {
  buildSemanticGraphPrior,
  type SemanticGraphPrior,
} from "./semanticGraphPrior";
import type {
  SemanticIndexBuildResult,
  SemanticIndexLexicalStatsV1,
  SemanticIndexChunk,
  SemanticIndexNote,
  SemanticIndexNoteMeta,
  SemanticIndexRowMeta,
  SemanticIndexShardV2,
  SemanticIndexSearchHit,
  SemanticIndexStaleReportV1,
  SemanticIndexSearchTimingsV1,
  SemanticIndexSearchRequest,
  SemanticIndexSearchResult,
  SemanticIndexService,
  SemanticVaultIndex,
  SemanticVaultIndexV1,
  SemanticVaultIndexV2,
} from "./semanticIndexTypes";

const DEFAULT_INDEX_FOLDER = "Agent Memory";
const DEFAULT_INDEX_MAX_FILES = 1000;
const INDEX_MARKDOWN_NAME = "Semantic Vault Index.md";
const INDEX_JSON_NAME = "semantic-vault-index.json";
const INDEX_VERSION = 2;
const LEGACY_INDEX_VERSION = 1;
const INDEX_SHARD_ROW_LIMIT = 2048;
const INDEX_SHARD_NAME_PREFIX = "semantic-vault-index-shard-";
const MAX_INDEX_SNIPPET_CHARS = 360;
/**
 * How many changed notes one search embeds live so the note being edited is
 * still searchable before the debounced reindex lands. Bounded because each is
 * a full chunk-and-embed of that note on the helper's serial queue.
 */
export const MAX_LIVE_STALE_NOTES_PER_SEARCH = 3;
/**
 * Beyond this share of the index (or this many notes) the stale set is no
 * longer a few edits but a different vault. Search fails closed with
 * `stale_index_majority`; `semantic_search_notes` then runs real BM25 over
 * the current vault instead of advertising hybrid over a 300-note sample.
 */
export const STALE_MAJORITY_NOTE_FLOOR = 50;
export const STALE_MAJORITY_RATIO = 0.2;
/** Paths named per category in a stale report; counts stay exact beyond it. */
export const MAX_STALE_REPORT_PATHS = 25;
export const SEMANTIC_INDEX_READ_CONCURRENCY = 8;
const STOP_TERMS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "what",
  "where",
  "when",
  "about",
  "notes",
  "note",
  "file",
  "files",
  "says",
  "search",
  "related",
  "semantic",
  "index",
]);

interface SemanticIndexServiceOptions {
  app: App;
  getSettings: () => AgentSettings;
  getEmbeddingProvider: () => SemanticEmbeddingProvider;
  now?: () => Date;
}

interface PendingNoteBuild {
  note: Omit<SemanticIndexNote, "chunks">;
  chunkInputs: Array<{
    id: string;
    path: string;
    title: string;
    heading: string | null;
    text: string;
    tokenCount: number;
    textHash: string;
    snippet: string;
    embeddingText: string;
  }>;
}

interface SemanticIndexBuildPayload {
  index: SemanticVaultIndex;
  shards: SemanticIndexShardV2[];
}

interface Freshness {
  fresh: boolean;
  reason?: string;
}

/**
 * The full picture behind {@link Freshness}: which notes drifted, not just
 * that one did. `incompatibleReason` names the defects that no partial search
 * can work around (settings changed, vectors disabled, shards missing).
 */
export interface SemanticIndexStalenessV1 {
  incompatibleReason: string | null;
  changedPaths: string[];
  missingPaths: string[];
  unindexedPaths: string[];
}

const semanticManifestReadCache = new Map<
  string,
  { mtime: number; size: number; index: SemanticVaultIndex }
>();

/** Test hook; the production caches are keyed by file (mtime, size). */
export function clearSemanticManifestReadCache(): void {
  semanticManifestReadCache.clear();
}

interface CachedSemanticShard {
  mtime: number;
  size: number;
  shard: SemanticIndexShardV2;
  /**
   * The shard's vectors decoded once per (mtime, size). The base64 payload
   * used to be decoded on EVERY query for EVERY shard into boxed number[]
   * (eight bytes per element plus a full spread); the typed array is decoded
   * lazily on the first search that touches the shard and reused until the
   * file changes.
   */
  vectors?: Float32Array;
}

const semanticShardReadCache = new Map<string, CachedSemanticShard>();

/** Drop every cached shard (called on plugin unload and after a rebuild). */
export function clearSemanticShardReadCache(): void {
  semanticShardReadCache.clear();
}

function resolveShardVectors(path: string, shard: SemanticIndexShardV2): Float32Array {
  const cached = semanticShardReadCache.get(path);
  if (cached && cached.shard === shard && cached.vectors) {
    return cached.vectors;
  }
  const vectors = decodeFloat32Base64Typed(shard.vectorsBase64);
  if (cached && cached.shard === shard) {
    cached.vectors = vectors;
  }
  return vectors;
}

export function createSemanticIndexService(
  options: SemanticIndexServiceOptions,
): SemanticIndexService {
  return new DefaultSemanticIndexService(options);
}

export function getSemanticIndexPaths(settings: AgentSettings): {
  folder: string;
  markdownPath: string;
  jsonPath: string;
} {
  const folder =
    typeof settings.semanticIndexFolder === "string" &&
    settings.semanticIndexFolder.trim()
      ? normalizeVaultPath(settings.semanticIndexFolder)
      : DEFAULT_INDEX_FOLDER;
  return {
    folder,
    markdownPath: joinVaultPath(folder, INDEX_MARKDOWN_NAME),
    jsonPath: joinVaultPath(folder, INDEX_JSON_NAME),
  };
}

export function shouldSemanticIndexTrackPath(
  path: string,
  settings: AgentSettings,
): boolean {
  const normalized = normalizeTrackableMarkdownPath(path);
  if (!normalized) {
    return false;
  }
  const { folder, markdownPath, jsonPath } = getSemanticIndexPaths(settings);
  return (
    normalized !== markdownPath &&
    normalized !== jsonPath &&
    !isVaultPathExcluded(normalized) &&
    !isPathUnderVaultFolder(normalized, folder)
  );
}

class DefaultSemanticIndexService implements SemanticIndexService {
  private readonly app: App;
  private readonly getSettings: () => AgentSettings;
  private readonly getEmbeddingProvider: () => SemanticEmbeddingProvider;
  private readonly now: () => Date;
  // Content hash (indexedAt excluded) of the last version written per shard
  // path. Incremental updates re-shard the whole row set, so without this
  // every debounced single-note save rewrote every multi-MB shard file and
  // kept Obsidian's own indexer permanently busy.
  private readonly lastWrittenShardHashes = new Map<string, string>();

  constructor(options: SemanticIndexServiceOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    this.getEmbeddingProvider = options.getEmbeddingProvider;
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<SemanticVaultIndex | null> {
    const { jsonPath } = getSemanticIndexPaths(this.getSettings());
    const file = this.app.vault.getFileByPath(jsonPath);
    if (!file) {
      semanticManifestReadCache.delete(jsonPath);
      return null;
    }

    // The manifest (every note's metadata) used to be re-parsed on every
    // search; the shards already had a (mtime, size) cache and the manifest
    // is the same shape of file.
    const stat = file.stat ?? { mtime: 0, size: 0 };
    const cached = semanticManifestReadCache.get(jsonPath);
    if (cached && cached.mtime === stat.mtime && cached.size === stat.size) {
      return cached.index;
    }
    try {
      const parsed = JSON.parse(await this.app.vault.cachedRead(file));
      if (!isSemanticVaultIndex(parsed)) {
        semanticManifestReadCache.delete(jsonPath);
        return null;
      }
      semanticManifestReadCache.set(jsonPath, {
        mtime: stat.mtime,
        size: stat.size,
        index: parsed,
      });
      return parsed;
    } catch {
      semanticManifestReadCache.delete(jsonPath);
      return null;
    }
  }

  async rebuild(): Promise<SemanticIndexBuildResult> {
    const settings = this.getSettings();
    const paths = getSemanticIndexPaths(settings);
    const files = getIndexableFiles(this.app, settings).slice(
      0,
      getIndexMaxFiles(settings),
    );
    const result = await this.buildIndexFromFiles(files, INDEX_VERSION);
    if (!result.ok || !result.payload) {
      return makeBuildResult({
        operation: "semantic_index_rebuild",
        paths,
        ok: false,
        code: result.code ?? "semantic_index_build_failed",
        message: result.message ?? "Unable to build semantic index.",
      });
    }

    await this.writeIndex(result.payload.index, result.payload.shards);
    return makeBuildResult({
      operation: "semantic_index_rebuild",
      paths,
      ok: true,
      index: result.payload.index,
      updatedPaths: result.payload.index.notes.map((note) => note.path),
    });
  }

  async updatePaths(paths: string[]): Promise<SemanticIndexBuildResult> {
    const settings = this.getSettings();
    const indexPaths = getSemanticIndexPaths(settings);
    const existing = await this.load();
    if (!existing || !isIndexCompatible(existing, settings)) {
      return this.rebuild();
    }

    const normalizedPaths = dedupeStrings(
      paths
        .map(normalizeQueuedPath)
        .filter((path): path is string => Boolean(path)),
    );
    const removedPaths: string[] = [];
    const skippedPaths: string[] = [];
    const files: TFile[] = [];

    for (const path of normalizedPaths) {
      if (!shouldSemanticIndexTrackPath(path, settings)) {
        skippedPaths.push(path);
        continue;
      }
      const file = this.app.vault.getFileByPath(path);
      if (!file) {
        removedPaths.push(path);
        continue;
      }
      files.push(file);
    }

    if (existing.version === 2) {
      return this.updateV2Index({
        existing,
        normalizedPaths,
        files,
        removedPaths,
        skippedPaths,
        indexPaths,
      });
    }

    const result = await this.buildIndexFromFiles(files, LEGACY_INDEX_VERSION);
    if (!result.ok || !result.payload) {
      return makeBuildResult({
        operation: "semantic_index_update",
        paths: indexPaths,
        ok: false,
        code: result.code ?? "semantic_index_update_failed",
        message: result.message ?? "Unable to update semantic index.",
      });
    }

    const replacements = new Map(
      (result.payload.index as SemanticVaultIndexV1).notes.map((note) => [note.path, note]),
    );
    const removeSet = new Set([...normalizedPaths, ...removedPaths]);
    const notes = existing.notes
      .filter((note) => !removeSet.has(note.path))
      .concat([...replacements.values()])
      .sort((left, right) => left.path.localeCompare(right.path));
    const nextIndex: SemanticVaultIndexV1 = {
      ...existing,
      indexedAt: this.now().toISOString(),
      notes,
    };

    await this.writeIndex(nextIndex);
    return makeBuildResult({
      operation: "semantic_index_update",
      paths: indexPaths,
      ok: true,
      index: nextIndex,
      updatedPaths: [...replacements.keys()],
      removedPaths,
      skippedPaths,
    });
  }

  async removePaths(paths: string[]): Promise<void> {
    const existing = await this.load();
    if (!existing) {
      return;
    }
    const normalizedPaths = dedupeStrings(
      paths
        .map(normalizeQueuedPath)
        .filter((path): path is string => Boolean(path)),
    );
    if (existing.version === 2) {
      await this.updateV2Index({
        existing,
        normalizedPaths,
        files: [],
        removedPaths: normalizedPaths,
        skippedPaths: [],
        indexPaths: getSemanticIndexPaths(this.getSettings()),
      });
      return;
    }

    const removeSet = new Set(normalizedPaths);
    const nextIndex: SemanticVaultIndexV1 = {
      ...existing,
      indexedAt: this.now().toISOString(),
      notes: existing.notes.filter((note) => !removeSet.has(note.path)),
    };
    await this.writeIndex(nextIndex);
  }

  async search(
    request: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult> {
    const settings = this.getSettings();
    const index = await this.load();
    const model = getSemanticModel(settings);
    const dim = getSemanticDim(settings);
    if (!index) {
      return makeSearchFailure(model, dim, "missing_index", "No semantic index exists.");
    }

    const staleness = assessSemanticIndexStalenessV1(
      this.app,
      settings,
      index,
      this.getEmbeddingProviderId(),
    );
    if (staleness.incompatibleReason) {
      return makeSearchFailure(
        model,
        dim,
        staleness.incompatibleReason,
        `Semantic index is stale: ${staleness.incompatibleReason}.`,
        index.indexedAt,
      );
    }
    const staleNoteCount = staleness.changedPaths.length + staleness.missingPaths.length;
    if (
      staleNoteCount > 0 &&
      staleNoteCount >= Math.max(STALE_MAJORITY_NOTE_FLOOR, index.notes.length * STALE_MAJORITY_RATIO)
    ) {
      return makeSearchFailure(
        model,
        dim,
        "stale_index_majority",
        `Semantic index is stale: ${staleNoteCount} of ${index.notes.length} indexed notes changed or vanished since it was built.`,
        index.indexedAt,
      );
    }
    const excludePaths = new Set([...staleness.changedPaths, ...staleness.missingPaths]);
    const indexFresh = excludePaths.size === 0 && staleness.unindexedPaths.length === 0;

    const query = request.query.trim();
    if (!query) {
      return makeSearchFailure(model, dim, "empty_query", "Query is required.", index.indexedAt);
    }

    const prefixes = resolveEmbeddingPrefixesV1(model);
    // The helper cannot cancel an in-flight request (a Python subprocess
    // with a 3-minute timeout); racing the run's signal lets a stopped run
    // reach its stop boundary instead of waiting out the helper.
    const embedded = await raceAbort(
      this.getEmbeddingProvider().embed({
        model,
        dim,
        matryoshka: getSemanticMatryoshka(settings),
        documents: [],
        queries: [query],
        queryPrefix: prefixes.query,
        documentPrefix: prefixes.document,
        signal: request.signal,
      }),
      request.signal,
    ).catch((error: unknown) => {
      if (request.signal?.aborted) return null;
      throw error;
    });
    if (embedded === null) {
      return makeSearchFailure(
        model,
        dim,
        "aborted",
        "The run was stopped before the embedding helper answered.",
      );
    }
    const response = embedded;
    if (!response.ok || response.queries?.length !== 1) {
      return makeSearchFailure(
        model,
        dim,
        response.code ?? "query_embedding_failed",
        response.message ?? "Unable to embed semantic index query.",
        index.indexedAt,
      );
    }

    // Absent seedPaths this is an empty map, and scoring stays byte-identical.
    const graphPrior = buildSemanticGraphPrior(index.notes, request.seedPaths ?? []);

    const rerankSettings = resolveSemanticRerankSettingsV1(settings);
    const rerankWanted = request.rerank ?? rerankSettings.enabled;
    const searchResult = index.version === 2
      ? await searchIndexShards({
          app: this.app,
          index,
          queryVector: response.queries[0],
          queryTerms: tokenize(query),
          folder: request.folder ?? null,
          limit: request.limit,
          maxSnippetChars: request.maxSnippetChars ?? MAX_INDEX_SNIPPET_CHARS,
          candidateLimit: getCandidateLimit(request),
          minScore: request.minScore,
          cursor: request.cursor ?? null,
          graphPrior,
          excludePaths,
          liveHits: await this.scoreStaleNotesLive({
            settings,
            index,
            queryVector: response.queries[0],
            queryTerms: tokenize(query),
            folder: request.folder ?? null,
            maxSnippetChars: request.maxSnippetChars ?? MAX_INDEX_SNIPPET_CHARS,
            graphPrior,
            candidatePaths: staleness.changedPaths,
            maxNotes: request.maxLiveStaleNotes ?? MAX_LIVE_STALE_NOTES_PER_SEARCH,
            signal: request.signal,
          }),
          rerankHead: rerankWanted
            ? (hits) =>
                this.rerankWithChunkText({
                  hits,
                  query,
                  settings,
                  chunking: index.chunking,
                  rerank: rerankSettings,
                  signal: request.signal,
                })
            : undefined,
        })
      : {
          hits: searchIndexChunks({
            index,
            queryVector: response.queries[0],
            queryTerms: tokenize(query),
            folder: request.folder ?? null,
            limit: request.limit,
            maxSnippetChars: request.maxSnippetChars ?? MAX_INDEX_SNIPPET_CHARS,
            minScore: request.minScore,
            cursor: request.cursor ?? null,
            graphPrior,
            excludePaths,
          }),
          candidateCount: index.notes.reduce((sum, note) => sum + note.chunks.length, 0),
          nextCursor: null,
        };

    const liveMergedPaths =
      "liveMergedPaths" in searchResult ? searchResult.liveMergedPaths : [];
    return {
      ok: true,
      operation: "semantic_index_search",
      mode: "indexed_semantic",
      indexUsed: true,
      indexFresh,
      ...(indexFresh
        ? {}
        : {
            stale: {
              changedPaths: staleness.changedPaths.slice(0, MAX_STALE_REPORT_PATHS),
              missingPaths: staleness.missingPaths.slice(0, MAX_STALE_REPORT_PATHS),
              unindexedPaths: staleness.unindexedPaths.slice(0, MAX_STALE_REPORT_PATHS),
              changedCount: staleness.changedPaths.length,
              missingCount: staleness.missingPaths.length,
              unindexedCount: staleness.unindexedPaths.length,
              liveMergedPaths,
            } satisfies SemanticIndexStaleReportV1,
          }),
      model: index.model,
      dim: index.dim,
      indexedAt: index.indexedAt,
      candidateCount: searchResult.candidateCount,
      nextCursor: searchResult.nextCursor,
      resultCount: searchResult.hits.length,
      results: searchResult.hits,
      ...("reranked" in searchResult
        ? {
            reranked: searchResult.reranked,
            ...(searchResult.rerankReason
              ? { rerankReason: searchResult.rerankReason }
              : {}),
          }
        : {}),
      // Absent on the v1 path, which scores in memory and has no decode step.
      ...("timings" in searchResult && searchResult.timings
        ? { timings: searchResult.timings }
        : {}),
    };
  }

  /**
   * Rescore the head of a ranking with the cross-encoder.
   *
   * The shards store a 360-character snippet, which is not what the model
   * should read: a cross-encoder is only as good as the passage it is given.
   * The full chunk is recovered by re-chunking the note with the index's own
   * chunking parameters and matching on the row's text hash -- so no offsets
   * enter the shard format, and a note that changed since it was indexed
   * simply fails to match and keeps its first-stage place.
   */
  private async rerankWithChunkText({
    hits,
    query,
    settings,
    chunking,
    rerank,
    signal,
  }: {
    hits: ScoredIndexHitV1[];
    query: string;
    settings: AgentSettings;
    chunking: SemanticChunkingOptions;
    rerank: { model: string; topK: number };
    signal?: AbortSignal;
  }): Promise<{
    hits: ScoredIndexHitV1[];
    applied: boolean;
    reason: string;
    ms: number;
    candidateCount: number;
  }> {
    const shortlist = hits.slice(0, rerank.topK);
    const wantedPaths = new Set(
      shortlist.filter((hit) => hit.rowTextHash).map((hit) => hit.path),
    );
    const textByHash = new Map<string, string>();
    for (const path of wantedPaths) {
      if (signal?.aborted) break;
      const file = this.app.vault.getFileByPath(path);
      if (!file) continue;
      const built = await buildPendingNote(this.app, file, chunking);
      if (!built) continue;
      for (const chunk of built.chunkInputs) {
        textByHash.set(chunk.textHash, chunk.embeddingText);
      }
    }
    return rerankSemanticHitsV1({
      hits,
      query,
      textFor: (hit) =>
        (hit.rowTextHash ? textByHash.get(hit.rowTextHash) : null) ?? hit.snippet,
      provider: this.getEmbeddingProvider(),
      model: rerank.model,
      cacheDir: settings.semanticModelCacheDir || undefined,
      topK: rerank.topK,
      priority: "interactive",
      signal,
    });
  }

  /**
   * Embed a handful of changed notes on the spot and score them the way the
   * shard scan would, so the note the user is editing still turns up. Any
   * failure (helper down, run stopped) degrades to "excluded", never to an
   * error: the indexed hits are still right for every other note.
   */
  private async scoreStaleNotesLive({
    settings,
    index,
    queryVector,
    queryTerms,
    folder,
    maxSnippetChars,
    graphPrior,
    candidatePaths,
    maxNotes,
    signal,
  }: {
    settings: AgentSettings;
    index: SemanticVaultIndexV2;
    queryVector: number[];
    queryTerms: Set<string>;
    folder: string | null;
    maxSnippetChars: number;
    graphPrior: SemanticGraphPrior | null;
    candidatePaths: string[];
    maxNotes: number;
    signal?: AbortSignal;
  }): Promise<{ hits: Array<ScoredIndexHitV1>; paths: string[] }> {
    const empty = { hits: [], paths: [] };
    const scoped = candidatePaths.filter(
      (path) => !folder || path.startsWith(`${folder}/`),
    );
    if (maxNotes <= 0 || scoped.length === 0 || scoped.length > maxNotes) {
      return empty;
    }
    const chunking = getChunking(settings);
    const pending: Array<{
      note: SemanticIndexNoteMeta;
      row: SemanticIndexRowMeta;
      embeddingText: string;
    }> = [];
    for (const path of scoped) {
      const file = this.app.vault.getFileByPath(path);
      if (!file) {
        continue;
      }
      const built = await buildPendingNote(this.app, file, chunking);
      if (!built) {
        continue;
      }
      const noteMeta: SemanticIndexNoteMeta = {
        ...built.note,
        chunkCount: built.chunkInputs.length,
        firstSnippet: built.chunkInputs[0]?.snippet ?? "",
      };
      for (const chunk of built.chunkInputs) {
        pending.push({
          note: noteMeta,
          row: {
            id: chunk.id,
            notePath: chunk.path,
            title: chunk.title,
            heading: chunk.heading,
            textHash: chunk.textHash,
            tokenCount: chunk.tokenCount,
            snippet: chunk.snippet,
            text: chunk.text,
          },
          embeddingText: chunk.embeddingText,
        });
      }
    }
    if (pending.length === 0 || signal?.aborted) {
      return empty;
    }
    const embedded = await embedIndexDocuments({
      provider: this.getEmbeddingProvider(),
      settings,
      documents: pending.map((item) => item.embeddingText),
      signal,
      priority: "interactive",
    });
    if (!embedded.ok || embedded.vectors.length !== pending.length) {
      return empty;
    }
    const ready = pending
      .map((item, position) => {
        const vector = embedded.vectors[position];
        if (!vector || vector.length !== index.dim) {
          return null;
        }
        return {
          item,
          cosine: normalizeCosine(cosineSimilarity(queryVector, vector)),
          graph: graphScoreFor(graphPrior, item.row.notePath),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const hybrid = scoreHybridCandidatesV1(
      ready.map((entry) => ({
        cosine: entry.cosine,
        lexicalText: hybridLexicalTextForRow(entry.item.note, entry.item.row),
        graph: entry.graph,
      })),
      [...queryTerms],
    );
    const hits: Array<ScoredIndexHitV1> = [];
    const paths = new Set<string>();
    ready.forEach((entry, index) => {
      const fused = hybrid[index]!;
      if (entry.cosine <= 0.1 && fused.bm25 <= 0) {
        return;
      }
      paths.add(entry.item.row.notePath);
      hits.push({
        path: entry.item.row.notePath,
        title: entry.item.row.title,
        score: roundScore(fused.score),
        semanticScore: roundScore(entry.cosine),
        lexicalScore: roundScore(fused.lexicalScore),
        reasons: dedupeStrings([
          "live_reembedded_changed_note",
          ...(entry.cosine > 0.55 ? ["indexed_semantic_similarity"] : []),
          ...fused.reasons.filter((reason) => reason !== "semantic_similarity"),
        ]),
        heading: entry.item.row.heading,
        snippet: boundedSnippet(entry.item.row.snippet, maxSnippetChars),
        sortPath: entry.item.row.notePath,
        rowTextHash: entry.item.row.textHash,
      });
    });
    return { hits, paths: [...paths] };
  }

  private checkFreshness(index: SemanticVaultIndex): Freshness {
    return getSemanticIndexFreshness(
      this.app,
      this.getSettings(),
      index,
      this.getEmbeddingProviderId(),
    );
  }

  /** Identity recorded in the index; a provider without one is the Python helper. */
  private getEmbeddingProviderId(): string {
    return this.getEmbeddingProvider().id ?? PYTHON_FASTEMBED_PROVIDER_ID;
  }

  private async updateV2Index({
    existing,
    normalizedPaths,
    files,
    removedPaths,
    skippedPaths,
    indexPaths,
  }: {
    existing: SemanticVaultIndexV2;
    normalizedPaths: string[];
    files: TFile[];
    removedPaths: string[];
    skippedPaths: string[];
    indexPaths: ReturnType<typeof getSemanticIndexPaths>;
  }): Promise<SemanticIndexBuildResult> {
    const replacement = files.length > 0
      ? await this.buildIndexFromFiles(files, INDEX_VERSION)
      : {
          ok: true,
          payload: {
            index: {
              ...existing,
              notes: [],
              shards: [],
              totalRows: 0,
            } satisfies SemanticVaultIndexV2,
            shards: [],
          } satisfies SemanticIndexBuildPayload,
        };
    if (!replacement.ok || !replacement.payload) {
      return makeBuildResult({
        operation: "semantic_index_update",
        paths: indexPaths,
        ok: false,
        code: replacement.code ?? "semantic_index_update_failed",
        message: replacement.message ?? "Unable to update semantic index.",
      });
    }

    const currentRows = await readAllIndexRowsAndVectors(this.app, existing);
    if (!currentRows) {
      return this.rebuild();
    }
    const replacementIndex = replacement.payload.index as SemanticVaultIndexV2;
    const replacementRows = rowsAndVectorsFromShards(
      replacement.payload.shards,
      existing.dim,
    );
    if (!replacementRows) {
      return this.rebuild();
    }

    const replaceSet = new Set(normalizedPaths);
    const combined = currentRows.rows
      .map((row, index) => ({ row, vector: currentRows.vectors[index] }))
      .filter(({ row }) => !replaceSet.has(row.notePath))
      .concat(
        replacementRows.rows.map((row, index) => ({
          row,
          vector: replacementRows.vectors[index],
        })),
      )
      .sort((left, right) =>
        left.row.notePath.localeCompare(right.row.notePath) ||
        left.row.id.localeCompare(right.row.id),
      );
    const indexedAt = this.now().toISOString();
    const nextShards = buildIndexShards({
      rows: combined.map((item) => item.row),
      rowVectors: combined.map((item) => item.vector),
      folder: indexPaths.folder,
      model: existing.model,
      dim: existing.dim,
      indexedAt,
    });
    const nextNotes = existing.notes
      .filter((note) => !replaceSet.has(note.path))
      .concat(replacementIndex.notes)
      .sort((left, right) => left.path.localeCompare(right.path));
    const nextIndex: SemanticVaultIndexV2 = {
      ...existing,
      indexedAt,
      notes: nextNotes,
      shards: nextShards.map((shard) => ({
        id: shard.id,
        path: getShardPath(indexPaths.folder, shard.id),
        rowCount: shard.rows.length,
        vectorEncoding: "float32-base64",
      })),
      totalRows: combined.length,
      // Recomputed over every row the update assembled, not patched: a
      // frequency table that describes the previous vault is worse than none.
      lexicalStats: buildLexicalStatsForRowsV1(
        combined.map(({ row }) => row),
        nextNotes,
      ),
    };

    await this.writeIndex(nextIndex, nextShards);
    await removeObsoleteShardFiles(this.app, existing, nextIndex);
    return makeBuildResult({
      operation: "semantic_index_update",
      paths: indexPaths,
      ok: true,
      index: nextIndex,
      updatedPaths: replacementIndex.notes.map((note) => note.path),
      removedPaths,
      skippedPaths,
    });
  }

  private async buildIndexFromFiles(files: TFile[], version: 1 | 2): Promise<{
    ok: boolean;
    payload?: SemanticIndexBuildPayload;
    code?: string;
    message?: string;
  }> {
    const settings = this.getSettings();
    const chunking = getChunking(settings);
    const pending: PendingNoteBuild[] = [];
    const documents: string[] = [];

    const builtNotes = await mapWithBoundedConcurrency(
      files,
      SEMANTIC_INDEX_READ_CONCURRENCY,
      (file) => buildPendingNote(this.app, file, chunking),
    );
    for (const note of builtNotes) {
      if (!note) {
        continue;
      }
      pending.push(note);
      documents.push(...note.chunkInputs.map((chunk) => chunk.embeddingText));
    }

    const vectors = await embedIndexDocuments({
      provider: this.getEmbeddingProvider(),
      settings,
      documents,
    });
    if (!vectors.ok) {
      return vectors;
    }

    if (version === LEGACY_INDEX_VERSION) {
      let vectorIndex = 0;
      const notes = pending.map((entry) => ({
        ...entry.note,
        chunks: entry.chunkInputs.map((chunk): SemanticIndexChunk => ({
          id: chunk.id,
          path: chunk.path,
          title: chunk.title,
          heading: chunk.heading,
          textHash: chunk.textHash,
          tokenCount: chunk.tokenCount,
          snippet: chunk.snippet,
          text: chunk.text,
          vector: settings.semanticIndexPersistVectors
            ? vectors.vectors[vectorIndex++] ?? []
            : [],
        })),
      }));

      return {
        ok: true,
        payload: {
          index: {
            version: LEGACY_INDEX_VERSION,
            model: getSemanticModel(settings),
            dim: getSemanticDim(settings),
            promptPrefixes: embeddingPrefixFingerprintV1(getSemanticModel(settings)),
            providerId: this.getEmbeddingProviderId(),
            chunking,
            indexedAt: this.now().toISOString(),
            notes,
          },
          shards: [],
        },
      };
    }

    const indexedAt = this.now().toISOString();
    const dim = getSemanticDim(settings);
    const rows: SemanticIndexRowMeta[] = [];
    const rowVectors: number[][] = [];
    let vectorIndex = 0;
    const notes: SemanticIndexNoteMeta[] = pending.map((entry) => {
      const firstSnippet = entry.chunkInputs[0]?.snippet ?? "";
      for (const chunk of entry.chunkInputs) {
        rows.push({
          id: chunk.id,
          notePath: chunk.path,
          title: chunk.title,
          heading: chunk.heading,
          textHash: chunk.textHash,
          tokenCount: chunk.tokenCount,
          snippet: chunk.snippet,
          text: chunk.text,
        });
        rowVectors.push(
          settings.semanticIndexPersistVectors
            ? vectors.vectors[vectorIndex++] ?? []
            : [],
        );
      }
      return {
        ...entry.note,
        chunkCount: entry.chunkInputs.length,
        firstSnippet,
      };
    });

    const paths = getSemanticIndexPaths(settings);
    const shards = buildIndexShards({
      rows,
      rowVectors,
      folder: paths.folder,
      model: getSemanticModel(settings),
      dim,
      indexedAt,
    });

    return {
      ok: true,
      payload: {
        index: {
        version: INDEX_VERSION,
        model: getSemanticModel(settings),
        dim,
        promptPrefixes: embeddingPrefixFingerprintV1(getSemanticModel(settings)),
        providerId: this.getEmbeddingProviderId(),
        chunking,
        indexedAt,
        notes,
        shards: shards.map((shard) => ({
          id: shard.id,
          path: getShardPath(paths.folder, shard.id),
          rowCount: shard.rows.length,
          vectorEncoding: "float32-base64" as const,
        })),
        totalRows: rows.length,
        lexicalStats: buildLexicalStatsForRowsV1(rows, notes),
      },
        shards,
      },
    };
  }

  private async writeIndex(
    index: SemanticVaultIndex,
    shards: SemanticIndexShardV2[] = [],
  ) {
    const settings = this.getSettings();
    const paths = getSemanticIndexPaths(settings);
    await ensureFolderPath(this.app, paths.folder);
    for (const shard of shards) {
      const shardPath = getShardPath(paths.folder, shard.id);
      const contentHash = hashText(
        JSON.stringify({ ...shard, indexedAt: "" }),
      );
      if (
        this.lastWrittenShardHashes.get(shardPath) === contentHash &&
        this.app.vault.getFileByPath(shardPath)
      ) {
        continue;
      }
      await writeVaultText(this.app, shardPath, `${JSON.stringify(shard)}\n`);
      this.lastWrittenShardHashes.set(shardPath, contentHash);
    }
    await writeVaultText(
      this.app,
      paths.jsonPath,
      `${JSON.stringify(index, null, 2)}\n`,
    );
    await writeVaultText(this.app, paths.markdownPath, renderSemanticIndexMarkdown(index));
  }
}

async function buildPendingNote(
  app: App,
  file: TFile,
  chunking: SemanticChunkingOptions,
): Promise<PendingNoteBuild | null> {
  const content = await app.vault.cachedRead(file);
  const contentHash = hashText(content);
  const metadata = readMetadata(content, file);
  const chunks = chunkMarkdownForSemanticSearch(content, chunking).slice(0, 40);
  if (chunks.length === 0) {
    return null;
  }

  return {
    note: {
      path: file.path,
      title: metadata.title,
      mtime: file.stat?.mtime ?? 0,
      size: file.stat?.size ?? content.length,
      contentHash,
      tags: metadata.tags,
      links: metadata.links,
      headings: metadata.headings,
    },
    chunkInputs: chunks.map((chunk, index) => {
      const textHash = hashText(chunk.text);
      const snippet = boundedSnippet(chunk.text, MAX_INDEX_SNIPPET_CHARS);
      return {
        id: `${file.path}#${index}`,
        path: file.path,
        title: metadata.title,
        heading: chunk.heading,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        textHash,
        snippet,
        embeddingText: [
          metadata.title,
          chunk.heading ?? "",
          metadata.tags.join(" "),
          chunk.text,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }),
  };
}

function buildIndexShards({
  rows,
  rowVectors,
  folder,
  model,
  dim,
  indexedAt,
}: {
  rows: SemanticIndexRowMeta[];
  rowVectors: number[][];
  folder: string;
  model: string;
  dim: number;
  indexedAt: string;
}): SemanticIndexShardV2[] {
  const shards: SemanticIndexShardV2[] = [];
  for (let start = 0; start < rows.length; start += INDEX_SHARD_ROW_LIMIT) {
    const shardRows = rows.slice(start, start + INDEX_SHARD_ROW_LIMIT);
    const shardVectors = rowVectors.slice(start, start + INDEX_SHARD_ROW_LIMIT);
    const id = `shard-${String(shards.length + 1).padStart(4, "0")}`;
    void folder;
    shards.push({
      version: INDEX_VERSION,
      id,
      model,
      dim,
      indexedAt,
      rows: shardRows,
      vectorsBase64: encodeFloat32Base64(flattenVectors(shardVectors, dim)),
    });
  }
  return shards;
}

function flattenVectors(vectors: number[][], dim: number): number[] {
  const output: number[] = [];
  for (const vector of vectors) {
    for (let index = 0; index < dim; index += 1) {
      output.push(Number.isFinite(vector[index]) ? vector[index] : 0);
    }
  }
  return output;
}

function encodeFloat32Base64(values: number[]): string {
  const array = new Float32Array(values);
  const bytes = new Uint8Array(array.buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  const buffer = (globalThis as unknown as {
    Buffer?: { from: (value: Uint8Array) => { toString: (encoding: string) => string } };
  }).Buffer;
  return buffer ? buffer.from(bytes).toString("base64") : "";
}

/** Typed decode: the row-major matrix as one Float32Array, no boxing. */
export function decodeFloat32Base64Typed(value: string): Float32Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
  }
  const buffer = (globalThis as unknown as {
    Buffer?: { from: (value: string, encoding: string) => Uint8Array };
  }).Buffer;
  if (!buffer) {
    return new Float32Array(0);
  }
  const bytes = buffer.from(value, "base64");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

function decodeFloat32Base64(value: string): number[] {
  let binary = "";
  if (typeof atob === "function") {
    binary = atob(value);
  } else {
    const buffer = (globalThis as unknown as {
      Buffer?: { from: (value: string, encoding: string) => Uint8Array };
    }).Buffer;
    if (!buffer) {
      return [];
    }
    const bytes = buffer.from(value, "base64");
    return [...new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))];
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return [...new Float32Array(bytes.buffer)];
}

/**
 * Documents per embed request. A vault rebuild used to send every chunk in one
 * request — up to maxFiles(10000) x 40 chunks — which made the Python helper
 * hold the inputs, the vector lists, and the serialized JSON response
 * simultaneously (observed >13 GB RSS) while the response line blew past the
 * helper transport's output cap and could never be parsed. Batches keep each
 * response around 1-2 MB and helper memory flat.
 */
export const SEMANTIC_EMBED_BATCH_SIZE = 128;

export async function embedIndexDocuments({
  provider,
  settings,
  documents,
  batchSize = SEMANTIC_EMBED_BATCH_SIZE,
  signal,
  priority = "background",
}: {
  provider: SemanticEmbeddingProvider;
  settings: AgentSettings;
  documents: string[];
  batchSize?: number;
  /** A stopped run skips batches still waiting in the provider queue. */
  signal?: AbortSignal;
  /** Index builds queue behind any interactive search; the live merge of a few changed notes is interactive. */
  priority?: SemanticEmbeddingPriority;
}): Promise<{ ok: true; vectors: number[][] } | { ok: false; code: string; message: string }> {
  if (documents.length === 0) {
    return { ok: true, vectors: [] };
  }

  const boundedBatchSize = Math.max(1, Math.trunc(batchSize));
  const vectors: number[][] = [];
  for (let start = 0; start < documents.length; start += boundedBatchSize) {
    const batch = documents.slice(start, start + boundedBatchSize);
    const indexPrefixes = resolveEmbeddingPrefixesV1(getSemanticModel(settings));
    const response = await provider.embed({
      model: getSemanticModel(settings),
      dim: getSemanticDim(settings),
      matryoshka: getSemanticMatryoshka(settings),
      cacheDir: settings.semanticModelCacheDir || undefined,
      documents: batch,
      queries: [],
      queryPrefix: indexPrefixes.query,
      documentPrefix: indexPrefixes.document,
      signal,
      priority,
    });
    if (!response.ok || response.documents?.length !== batch.length) {
      return {
        ok: false,
        code: response.code ?? "document_embedding_failed",
        message: response.message ?? "Unable to embed semantic index documents.",
      };
    }
    vectors.push(...response.documents);
  }

  return { ok: true, vectors };
}

/**
 * A hit while it is still inside the ranker: the public fields plus the note
 * path it sorts by and, when the row came from a shard, the hash of the chunk
 * text. The hash is what lets the rerank stage find the chunk again in the note
 * without storing offsets in the shard format.
 */
type ScoredIndexHitV1 = SemanticIndexSearchHit & {
  sortPath: string;
  rowTextHash?: string;
};

function hybridLexicalTextForRow(
  note: { title: string; tags: string[] },
  row: { heading: string | null; snippet: string; text?: string },
): string {
  return rowLexicalTextV1(note, row);
}

function graphScoreFor(
  prior: SemanticGraphPrior | null,
  path: string,
): number | null {
  if (!prior || prior.size === 0) return null;
  return prior.get(path) ?? 0;
}

function searchIndexChunks({
  index,
  queryVector,
  queryTerms,
  folder,
  limit,
  maxSnippetChars,
  minScore,
  cursor,
  graphPrior,
}: {
  index: SemanticVaultIndexV1;
  queryVector: number[];
  queryTerms: Set<string>;
  folder: string | null;
  limit: number;
  graphPrior?: SemanticGraphPrior | null;
  maxSnippetChars: number;
  minScore?: number;
  excludePaths?: Set<string>;
  cursor?: string | null;
}): SemanticIndexSearchHit[] {
  const pending: Array<{
    note: SemanticIndexNote;
    chunk: SemanticIndexChunk;
    cosine: number;
    graph: number | null;
  }> = [];

  for (const note of index.notes) {
    if (folder && !note.path.startsWith(`${folder}/`)) {
      continue;
    }
    for (const chunk of note.chunks) {
      const cosine = normalizeCosine(cosineSimilarity(queryVector, chunk.vector));
      const graph = graphScoreFor(graphPrior ?? null, note.path);
      pending.push({ note, chunk, cosine, graph });
    }
  }

  const hybrid = scoreHybridCandidatesV1(
    pending.map((item) => ({
      cosine: item.cosine,
      lexicalText: hybridLexicalTextForRow(item.note, {
        heading: item.chunk.heading,
        snippet: item.chunk.snippet,
        text: item.chunk.text,
      }),
      graph: item.graph,
    })),
    [...queryTerms],
  );

  const scored: Array<ScoredIndexHitV1> = [];
  pending.forEach((item, index) => {
    const fused = hybrid[index]!;
    if (item.cosine <= 0.1 && fused.bm25 <= 0) {
      return;
    }
    const hit = {
      path: item.note.path,
      title: item.note.title,
      score: roundScore(fused.score),
      semanticScore: roundScore(item.cosine),
      lexicalScore: roundScore(fused.lexicalScore),
      reasons: dedupeStrings([
        ...(item.cosine > 0.55 ? ["indexed_semantic_similarity"] : []),
        ...fused.reasons.filter((reason) => reason !== "semantic_similarity"),
      ]),
      heading: item.chunk.heading,
      snippet: boundedSnippet(item.chunk.snippet, maxSnippetChars),
      sortPath: item.note.path,
    };
    if (minScore === undefined || hit.score >= minScore) {
      scored.push(hit);
    }
  });

  const byPath = new Map<string, ScoredIndexHitV1>();
  for (const hit of scored.sort(compareHits)) {
    if (!byPath.has(hit.path)) {
      byPath.set(hit.path, hit);
    }
  }

  const offset = parseCursorOffset(cursor);
  return [...byPath.values()]
    .sort(compareHits)
    .slice(offset, offset + limit)
    .map(({ sortPath, rowTextHash, ...hit }) => hit);
}

async function searchIndexShards({
  app,
  index,
  queryVector,
  queryTerms,
  folder,
  limit,
  maxSnippetChars,
  candidateLimit,
  minScore,
  cursor,
  graphPrior,
  excludePaths,
  liveHits,
  rerankHead,
}: {
  graphPrior?: SemanticGraphPrior | null;
  app: App;
  index: SemanticVaultIndexV2;
  queryVector: number[];
  queryTerms: Set<string>;
  folder: string | null;
  limit: number;
  maxSnippetChars: number;
  candidateLimit: number;
  minScore?: number;
  cursor: string | null;
  /** Notes the index no longer describes; their rows are skipped. */
  excludePaths?: Set<string>;
  /** Freshly embedded rows for a few excluded notes, merged into the ranking. */
  liveHits?: { hits: Array<ScoredIndexHitV1>; paths: string[] };
  /**
   * Optional second stage: rescore the head of the ranking with a
   * cross-encoder. It runs on the full ranking before paging, so page two
   * reflects the same order, and it may only reorder -- a hit it dislikes
   * sinks, it never disappears.
   */
  rerankHead?: (hits: Array<ScoredIndexHitV1>) => Promise<{
    hits: Array<ScoredIndexHitV1>;
    applied: boolean;
    reason: string;
    ms: number;
    candidateCount: number;
  }>;
}): Promise<{
  hits: SemanticIndexSearchHit[];
  candidateCount: number;
  nextCursor: string | null;
  timings: SemanticIndexSearchTimingsV1;
  liveMergedPaths: string[];
  reranked: boolean;
  rerankReason: string | null;
}> {
  const scored: Array<ScoredIndexHitV1> = [];
  let candidateCount = 0;
  let decodeMs = 0;
  let scoreMs = 0;
  const noteByPath = new Map(index.notes.map((note) => [note.path, note]));
  const queryTyped = Float32Array.from(queryVector);
  const queryNorm = vectorNorm(queryTyped);
  const pending: Array<{
    row: SemanticIndexRowMeta;
    note: SemanticIndexNoteMeta;
    cosine: number;
    graph: number | null;
    live?: boolean;
  }> = [];

  for (const ref of index.shards) {
    const shard = await readIndexShard(app, ref.path);
    if (!shard || shard.dim !== index.dim) {
      continue;
    }
    const decodeStartedAt = Date.now();
    // Decoded once per shard file version and reused across queries.
    const vectors = resolveShardVectors(ref.path, shard);
    decodeMs += Math.max(0, Date.now() - decodeStartedAt);
    const scoreStartedAt = Date.now();
    for (let rowIndex = 0; rowIndex < shard.rows.length; rowIndex += 1) {
      const row = shard.rows[rowIndex];
      if (folder && !row.notePath.startsWith(`${folder}/`)) {
        continue;
      }
      if (excludePaths?.has(row.notePath)) {
        continue;
      }
      const note = noteByPath.get(row.notePath);
      if (!note) {
        continue;
      }
      candidateCount += 1;
      pending.push({
        row,
        note,
        cosine: normalizeCosine(
          cosineSimilarityAt(vectors, rowIndex * index.dim, index.dim, queryTyped, queryNorm),
        ),
        graph: graphScoreFor(graphPrior ?? null, row.notePath),
      });
    }
    scoreMs += Math.max(0, Date.now() - scoreStartedAt);
  }

  const fuseStartedAt = Date.now();
  const hybrid = scoreHybridCandidatesV1(
    pending.map((item) => ({
      cosine: item.cosine,
      lexicalText: hybridLexicalTextForRow(item.note, item.row),
      graph: item.graph,
    })),
    [...queryTerms],
  );
  pending.forEach((item, index) => {
    const fused = hybrid[index]!;
    if (item.cosine <= 0.1 && fused.bm25 <= 0) {
      return;
    }
    const hit = {
      path: item.row.notePath,
      title: item.row.title,
      score: roundScore(fused.score),
      semanticScore: roundScore(item.cosine),
      lexicalScore: roundScore(fused.lexicalScore),
      reasons: dedupeStrings([
        ...(item.cosine > 0.55 ? ["indexed_semantic_similarity"] : []),
        ...fused.reasons.filter((reason) => reason !== "semantic_similarity"),
      ]),
      heading: item.row.heading,
      snippet: boundedSnippet(item.row.snippet, maxSnippetChars),
      sortPath: item.row.notePath,
      rowTextHash: item.row.textHash,
    };
    if (minScore !== undefined && hit.score < minScore) {
      return;
    }
    pushBoundedHit(scored, hit, candidateLimit);
  });
  scoreMs += Math.max(0, Date.now() - fuseStartedAt);

  for (const hit of liveHits?.hits ?? []) {
    if (minScore !== undefined && hit.score < minScore) {
      continue;
    }
    candidateCount += 1;
    pushBoundedHit(scored, hit, candidateLimit);
  }

  const byPath = new Map<string, ScoredIndexHitV1>();
  for (const hit of scored.sort(compareHits)) {
    if (!byPath.has(hit.path)) {
      byPath.set(hit.path, hit);
    }
  }
  const ranked = [...byPath.values()].sort(compareHits);
  const reranked = rerankHead ? await rerankHead(ranked) : null;
  const allHits = reranked?.hits ?? ranked;
  const offset = parseCursorOffset(cursor);
  const page = allHits.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    hits: page.map(({ sortPath, rowTextHash, ...hit }) => hit),
    candidateCount,
    nextCursor: nextOffset < allHits.length ? String(nextOffset) : null,
    timings: {
      decodeMs,
      scoreMs,
      rowsScored: candidateCount,
      ...(reranked ? { rerankMs: reranked.ms } : {}),
    },
    liveMergedPaths: liveHits?.paths ?? [],
    reranked: reranked?.applied ?? false,
    rerankReason: reranked?.reason ?? null,
  };
}

async function readIndexShard(
  app: App,
  path: string,
): Promise<SemanticIndexShardV2 | null> {
  const file = app.vault.getFileByPath(path);
  if (!file) {
    semanticShardReadCache.delete(path);
    return null;
  }
  const stat = file.stat ?? { mtime: 0, size: 0 };
  const cached = semanticShardReadCache.get(path);
  if (cached && cached.mtime === stat.mtime && cached.size === stat.size) {
    return cached.shard;
  }
  try {
    const parsed = JSON.parse(await app.vault.cachedRead(file));
    if (!isSemanticIndexShardV2(parsed)) {
      semanticShardReadCache.delete(path);
      return null;
    }
    semanticShardReadCache.set(path, {
      mtime: stat.mtime,
      size: stat.size,
      shard: parsed,
    });
    return parsed;
  } catch {
    semanticShardReadCache.delete(path);
    return null;
  }
}

async function readAllIndexRowsAndVectors(
  app: App,
  index: SemanticVaultIndexV2,
): Promise<{ rows: SemanticIndexRowMeta[]; vectors: number[][] } | null> {
  const rows: SemanticIndexRowMeta[] = [];
  const vectors: number[][] = [];
  for (const ref of index.shards) {
    const shard = await readIndexShard(app, ref.path);
    if (!shard || shard.dim !== index.dim) {
      return null;
    }
    const decoded = decodeFloat32Base64(shard.vectorsBase64);
    if (decoded.length < shard.rows.length * index.dim) {
      return null;
    }
    for (let rowIndex = 0; rowIndex < shard.rows.length; rowIndex += 1) {
      rows.push(shard.rows[rowIndex]);
      vectors.push(
        decoded.slice(rowIndex * index.dim, (rowIndex + 1) * index.dim),
      );
    }
  }
  return { rows, vectors };
}

function rowsAndVectorsFromShards(
  shards: SemanticIndexShardV2[],
  dim: number,
): { rows: SemanticIndexRowMeta[]; vectors: number[][] } | null {
  const rows: SemanticIndexRowMeta[] = [];
  const vectors: number[][] = [];
  for (const shard of shards) {
    const decoded = decodeFloat32Base64(shard.vectorsBase64);
    if (decoded.length < shard.rows.length * dim) {
      return null;
    }
    for (let rowIndex = 0; rowIndex < shard.rows.length; rowIndex += 1) {
      rows.push(shard.rows[rowIndex]);
      vectors.push(decoded.slice(rowIndex * dim, (rowIndex + 1) * dim));
    }
  }
  return { rows, vectors };
}

async function removeObsoleteShardFiles(
  app: App,
  previous: SemanticVaultIndexV2,
  next: SemanticVaultIndexV2,
): Promise<void> {
  const retained = new Set(next.shards.map((shard) => shard.path));
  for (const shard of previous.shards) {
    if (retained.has(shard.path)) {
      continue;
    }
    const file = app.vault.getFileByPath(shard.path);
    if (!file) {
      continue;
    }
    await app.vault.delete(file);
    semanticShardReadCache.delete(shard.path);
  }
}

function lexicalScoreForChunk(
  note: SemanticIndexNote,
  chunk: SemanticIndexChunk,
  queryTerms: Set<string>,
): { score: number; reasons: string[] } {
  if (queryTerms.size === 0) {
    return { score: 0, reasons: [] };
  }

  const reasons: string[] = [];
  let score = 0;
  const title = overlapRatio(queryTerms, tokenize(note.title));
  if (title > 0) {
    score += title * 0.25;
    reasons.push("title_match");
  }
  const heading = overlapRatio(queryTerms, tokenize(chunk.heading ?? ""));
  if (heading > 0) {
    score += heading * 0.2;
    reasons.push("heading_match");
  }
  const tags = overlapRatio(queryTerms, tokenize(note.tags.join(" ")));
  if (tags > 0) {
    score += tags * 0.15;
    reasons.push("tag_match");
  }
  const snippet = overlapRatio(queryTerms, tokenize(chunk.snippet));
  if (snippet > 0) {
    score += snippet * 0.55;
    reasons.push("snippet_match");
  }
  return { score: Math.min(1, score), reasons };
}

function lexicalScoreForRow(
  note: SemanticIndexNoteMeta,
  row: SemanticIndexRowMeta,
  queryTerms: Set<string>,
  stats?: SemanticIndexLexicalStatsV1 | null,
): { score: number; reasons: string[] } {
  if (queryTerms.size === 0) {
    return { score: 0, reasons: [] };
  }

  // With corpus statistics the four components weigh matched *information*;
  // without them (an index built before they were recorded) they weigh matched
  // words, exactly as before.
  const share = (text: string): number =>
    stats
      ? idfWeightedOverlapV1(queryTerms, tokenize(text), stats)
      : overlapRatio(queryTerms, tokenize(text));

  const reasons: string[] = [];
  let score = 0;
  const title = share(note.title);
  if (title > 0) {
    score += title * 0.25;
    reasons.push("title_match");
  }
  const heading = share(row.heading ?? "");
  if (heading > 0) {
    score += heading * 0.2;
    reasons.push("heading_match");
  }
  const tags = share(note.tags.join(" "));
  if (tags > 0) {
    score += tags * 0.15;
    reasons.push("tag_match");
  }
  const snippet = share(row.snippet);
  if (snippet > 0) {
    score += snippet * 0.55;
    reasons.push("snippet_match");
  }
  return { score: Math.min(1, score), reasons };
}

function pushBoundedHit<T extends ScoredIndexHitV1>(
  hits: T[],
  hit: T,
  limit: number,
) {
  hits.push(hit);
  hits.sort(compareHits);
  if (hits.length > limit) {
    hits.length = limit;
  }
}

function parseCursorOffset(cursor?: string | null): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getCandidateLimit(request: SemanticIndexSearchRequest): number {
  const requested = request.candidateLimit ?? (request.mode === "deep" ? 128 : request.limit * 8);
  return clampInteger(requested, request.limit, 500);
}

function renderSemanticIndexMarkdown(index: SemanticVaultIndex): string {
  const concepts = collectConcepts(index).slice(0, 40);
  const lines = [
    "# Semantic Vault Index",
    "",
    `Indexed at: ${index.indexedAt}`,
    `Model: ${index.model}`,
    `Dimension: ${index.dim}`,
    `Notes: ${index.notes.length}`,
    `Chunks: ${getIndexChunkCount(index)}`,
    `Index version: ${index.version}`,
    index.version === 2 ? `Shards: ${index.shards.length}` : "Shards: none",
    "",
    "## Concepts",
    "",
    ...(concepts.length
      ? concepts.map(
          (concept) =>
            `- **${concept.term}**: ${concept.paths.slice(0, 6).join(", ")}`,
        )
      : ["- No concepts indexed yet."]),
    "",
    "## Indexed Notes",
    "",
    ...index.notes.flatMap((note) => [
      `### ${note.title}`,
      "",
      `- Path: ${note.path}`,
      `- Tags: ${note.tags.length ? note.tags.join(", ") : "none"}`,
      `- Headings: ${note.headings.slice(0, 8).join("; ") || "none"}`,
      `- Chunks: ${getNoteChunkCount(note)}`,
      `- Snippet: ${getNoteFirstSnippet(note)}`,
      "",
    ]),
  ];

  return `${lines.join("\n").trim()}\n`;
}

function collectConcepts(index: SemanticVaultIndex): Array<{
  term: string;
  count: number;
  paths: string[];
}> {
  const byTerm = new Map<string, { count: number; paths: Set<string> }>();
  for (const note of index.notes) {
    const terms = tokenize(
      [note.title, note.tags.join(" "), note.headings.join(" "), getNoteFirstSnippet(note)].join(" "),
    );
    for (const term of terms) {
      const existing = byTerm.get(term) ?? { count: 0, paths: new Set<string>() };
      existing.count += 1;
      existing.paths.add(note.path);
      byTerm.set(term, existing);
    }
  }

  return [...byTerm.entries()]
    .map(([term, value]) => ({
      term,
      count: value.count,
      paths: [...value.paths],
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.term.localeCompare(right.term),
    );
}

function readMetadata(content: string, file: TFile) {
  const headings =
    content
      .match(/^#{1,6}\s+(.+)$/gm)
      ?.map((heading) => heading.replace(/^#{1,6}\s+/, "").trim())
      .filter(Boolean) ?? [];
  const title = headings[0] ?? file.basename;
  const tags = dedupeStrings(
    content.match(/#[A-Za-z0-9/_-]+/g)?.map((tag) => tag.slice(1)) ?? [],
  );
  const links = dedupeStrings(
    [...content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
      .map((match) => match[1]?.trim())
      .filter(Boolean),
  );
  return { title, tags, links, headings };
}

function getIndexableFiles(app: App, settings: AgentSettings): TFile[] {
  return app.vault
    .getFiles()
    .filter((file) => shouldSemanticIndexTrackPath(file.path, settings))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function getSemanticIndexFreshness(
  app: App,
  settings: AgentSettings,
  index: SemanticVaultIndex,
  providerId: string = PYTHON_FASTEMBED_PROVIDER_ID,
): Freshness {
  const staleness = assessSemanticIndexStalenessV1(app, settings, index, providerId);
  if (staleness.incompatibleReason) {
    return { fresh: false, reason: staleness.incompatibleReason };
  }
  if (staleness.missingPaths.length > 0) {
    return { fresh: false, reason: "indexed_file_missing" };
  }
  if (staleness.changedPaths.length > 0) {
    return { fresh: false, reason: "indexed_file_changed" };
  }
  if (staleness.unindexedPaths.length > 0) {
    return { fresh: false, reason: "new_file_not_indexed" };
  }
  return { fresh: true };
}

/**
 * Every way the index can disagree with the vault, in one pass. Reindex
 * decisions read the first defect through {@link getSemanticIndexFreshness};
 * search reads the whole list so it can work around drift instead of
 * refusing.
 */
export function assessSemanticIndexStalenessV1(
  app: App,
  settings: AgentSettings,
  index: SemanticVaultIndex,
  providerId: string = PYTHON_FASTEMBED_PROVIDER_ID,
): SemanticIndexStalenessV1 {
  const none: SemanticIndexStalenessV1 = {
    incompatibleReason: null,
    changedPaths: [],
    missingPaths: [],
    unindexedPaths: [],
  };
  if (!isIndexCompatible(index, settings, providerId)) {
    return { ...none, incompatibleReason: "settings_changed" };
  }
  if (!settings.semanticIndexPersistVectors) {
    return { ...none, incompatibleReason: "vectors_disabled" };
  }
  const structural = structuralIndexDefect(app, index);
  if (structural) {
    return { ...none, incompatibleReason: structural };
  }

  const indexedByPath = new Map(index.notes.map((note) => [note.path, note]));
  const changedPaths: string[] = [];
  const missingPaths: string[] = [];
  for (const note of index.notes) {
    const file = app.vault.getFileByPath(note.path);
    if (!file) {
      missingPaths.push(note.path);
      continue;
    }
    if (file.stat?.mtime !== note.mtime || file.stat?.size !== note.size) {
      changedPaths.push(note.path);
    }
  }
  const unindexedPaths: string[] = [];
  for (const file of getIndexableFiles(app, settings).slice(
    0,
    getIndexMaxFiles(settings),
  )) {
    if (!indexedByPath.has(file.path)) {
      unindexedPaths.push(file.path);
    }
  }
  return { incompatibleReason: null, changedPaths, missingPaths, unindexedPaths };
}

/** Defects in the stored vectors themselves; no per-note workaround exists. */
function structuralIndexDefect(app: App, index: SemanticVaultIndex): string | null {

  if (index.version === 1) {
    for (const note of index.notes) {
    if (
      (note.chunks.length === 0 ||
        note.chunks.some((chunk) => chunk.vector.length !== index.dim))
    ) {
      return "missing_vectors";
    }
    }
  }

  if (index.version === 2) {
    for (const note of index.notes) {
      if (note.chunkCount === 0) {
      return "missing_rows";
    }
  }

    if (index.shards.length === 0 && index.totalRows > 0) {
      return "missing_shards";
    }
    for (const shard of index.shards) {
      if (shard.rowCount <= 0 || !app.vault.getFileByPath(shard.path)) {
        return "missing_shards";
      }
    }
  }

  return null;
}

/**
 * Effective prefixes of an index written before prefixes were per-model.
 *
 * Every embedding produced by the old provider carried nomic's pair, whatever
 * the configured model was, because the helper hardcoded it. Treating a stored
 * index as having been built that way is what makes the invalidation below
 * exact: an index for a nomic model stays valid, and one for any other model --
 * whose documents really were embedded with the wrong prefix -- rebuilds once.
 */
const LEGACY_HARDCODED_PREFIX_FINGERPRINT = "search_query: |search_document: ";

function isIndexCompatible(
  index: SemanticVaultIndex,
  settings: AgentSettings,
  providerId: string = PYTHON_FASTEMBED_PROVIDER_ID,
): boolean {
  const chunking = getChunking(settings);
  const storedPrefixes =
    index.promptPrefixes ?? LEGACY_HARDCODED_PREFIX_FINGERPRINT;
  // Every index written before providers carried an id came from the Python
  // helper, so a missing id is that helper, not a wildcard.
  const storedProvider = index.providerId ?? PYTHON_FASTEMBED_PROVIDER_ID;
  return (
    (index.version === INDEX_VERSION || index.version === LEGACY_INDEX_VERSION) &&
    storedProvider === providerId &&
    // Embeddings built under one prefix pair are not comparable with those
    // built under another, so this invalidates a stored index exactly the way a
    // model change does.
    storedPrefixes === embeddingPrefixFingerprintV1(getSemanticModel(settings)) &&
    index.model === getSemanticModel(settings) &&
    index.dim === getSemanticDim(settings) &&
    index.chunking.minTokens === chunking.minTokens &&
    index.chunking.targetTokens === chunking.targetTokens &&
    index.chunking.maxTokens === chunking.maxTokens &&
    index.chunking.overlapTokens === chunking.overlapTokens
  );
}

/** Any width a catalogued or probed model actually produces; 256/512 was nomic's. */
function isPositiveIntegerDim(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isSemanticVaultIndex(value: unknown): value is SemanticVaultIndex {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.version === INDEX_VERSION || value.version === LEGACY_INDEX_VERSION) &&
    typeof value.model === "string" &&
    isPositiveIntegerDim(value.dim) &&
    isRecord(value.chunking) &&
    typeof value.indexedAt === "string" &&
    Array.isArray(value.notes)
  );
}

function isSemanticIndexShardV2(value: unknown): value is SemanticIndexShardV2 {
  return (
    isRecord(value) &&
    value.version === INDEX_VERSION &&
    typeof value.id === "string" &&
    typeof value.model === "string" &&
    isPositiveIntegerDim(value.dim) &&
    typeof value.indexedAt === "string" &&
    Array.isArray(value.rows) &&
    typeof value.vectorsBase64 === "string"
  );
}

function getIndexChunkCount(index: SemanticVaultIndex): number {
  if (index.version === 2) {
    return index.totalRows;
  }
  return index.notes.reduce((sum, note) => sum + note.chunks.length, 0);
}

function getNoteChunkCount(
  note: SemanticIndexNote | SemanticIndexNoteMeta,
): number {
  return "chunkCount" in note ? note.chunkCount : note.chunks.length;
}

function getNoteFirstSnippet(
  note: SemanticIndexNote | SemanticIndexNoteMeta,
): string {
  return "firstSnippet" in note ? note.firstSnippet : note.chunks[0]?.snippet ?? "";
}

function makeBuildResult({
  operation,
  paths,
  ok,
  index,
  updatedPaths = [],
  removedPaths = [],
  skippedPaths = [],
  code,
  message,
}: {
  operation: "semantic_index_rebuild" | "semantic_index_update";
  paths: { markdownPath: string; jsonPath: string };
  ok: boolean;
  index?: SemanticVaultIndex;
  updatedPaths?: string[];
  removedPaths?: string[];
  skippedPaths?: string[];
  code?: string;
  message?: string;
}): SemanticIndexBuildResult {
  return {
    ok,
    operation,
    markdownPath: paths.markdownPath,
    jsonPath: paths.jsonPath,
    indexedAt: index?.indexedAt,
    noteCount: index?.notes.length ?? 0,
    chunkCount: index ? getIndexChunkCount(index) : 0,
    updatedPaths,
    removedPaths,
    skippedPaths,
    code,
    message,
  };
}

function makeSearchFailure(
  model: string,
  dim: number,
  code: string,
  message: string,
  indexedAt?: string,
): SemanticIndexSearchResult {
  return {
    ok: false,
    operation: "semantic_index_search",
    mode: "indexed_semantic",
    indexUsed: false,
    indexFresh: false,
    model,
    dim,
    indexedAt,
    resultCount: 0,
    results: [],
    code,
    message,
  };
}

async function writeVaultText(app: App, path: string, text: string) {
  const existing = app.vault.getFileByPath(path);
  if (existing) {
    await app.vault.modify(existing, text);
    return;
  }
  await app.vault.create(path, text);
}

async function ensureFolderPath(app: App, folder: string) {
  if (!folder) {
    return;
  }

  const resolveExistingFolder = (path: string) => {
    const direct = app.vault.getFolderByPath(path);
    if (direct) {
      return direct;
    }
    const abstract = app.vault.getAbstractFileByPath(path);
    return abstract &&
      typeof abstract === "object" &&
      "children" in abstract
      ? abstract
      : null;
  };
  const parts = folder.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!resolveExistingFolder(current)) {
      try {
        await app.vault.createFolder(current);
      } catch (error) {
        // File watchers and an explicit updatePaths() call may race while
        // creating a fresh per-run index folder. Obsidian's metadata view can
        // briefly lag the adapter after the competing create resolves, so
        // allow a short bounded postcondition check. All other failures remain
        // fatal and a file at the folder path is never accepted.
        let confirmed = Boolean(resolveExistingFolder(current));
        for (let attempt = 0; !confirmed && attempt < 20; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          confirmed = Boolean(resolveExistingFolder(current));
        }
        if (!confirmed) {
          throw error;
        }
      }
    }
  }
}

function getChunking(settings: AgentSettings): SemanticChunkingOptions {
  return {
    minTokens: settings.semanticChunkMinTokens,
    targetTokens: settings.semanticChunkTargetTokens,
    maxTokens: settings.semanticChunkMaxTokens,
    overlapTokens: settings.semanticChunkOverlapTokens,
  };
}

function getSemanticModel(settings: AgentSettings): string {
  return settings.semanticEmbeddingModel.trim() || NEW_INSTALL_SEMANTIC_EMBEDDING_MODEL;
}

function getSemanticDim(settings: AgentSettings): number {
  return resolveEffectiveEmbeddingDimV1(
    getSemanticModel(settings),
    settings.semanticEmbeddingDim,
  ).dim;
}

function getSemanticMatryoshka(settings: AgentSettings): boolean {
  return resolveEffectiveEmbeddingDimV1(
    getSemanticModel(settings),
    settings.semanticEmbeddingDim,
  ).matryoshka;
}

function getIndexMaxFiles(settings: AgentSettings): number {
  return clampInteger(settings.semanticIndexMaxFiles, 1, 10000);
}

function normalizePathParts(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function normalizeTrackableMarkdownPath(path: string): string | null {
  try {
    return normalizeVaultPath(path, { requireMarkdown: true });
  } catch {
    return null;
  }
}

function normalizeQueuedPath(path: string): string | null {
  try {
    return normalizeVaultPath(path);
  } catch {
    return null;
  }
}

function joinVaultPath(...parts: string[]): string {
  return parts.map(normalizePathParts).filter(Boolean).join("/");
}

function getShardPath(folder: string, shardId: string): string {
  return joinVaultPath(folder, `${INDEX_SHARD_NAME_PREFIX}${shardId}.json`);
}

function boundedSnippet(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars).trim()} ...`;
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function tokenize(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) ?? [])
      .map((term) => term.replace(/^['-]+|['-]+$/g, ""))
      .filter((term) => term.length > 2 && !STOP_TERMS.has(term)),
  );
}

/**
 * The text the lexical half of the blend actually reads for one row. Kept in
 * one function so the statistics are counted over exactly what is later scored;
 * counting one text and scoring another is how a corpus statistic silently
 * stops describing its corpus.
 */
function rowLexicalTextV1(
  note: { title: string; tags: string[] },
  row: { heading: string | null; snippet: string; text?: string },
): string {
  return [note.title, row.heading ?? "", note.tags.join(" "), row.text ?? row.snippet].join(" ");
}

/** Terms kept in the manifest's frequency table; the rest count as rare. */
export const MAX_LEXICAL_STAT_TERMS = 2000;

/**
 * Statistics for a whole index. Indexed by path rather than searched per row:
 * a vault of two thousand notes and twenty thousand rows would otherwise turn
 * the build's last step into forty million string comparisons.
 */
function buildLexicalStatsForRowsV1(
  rows: readonly SemanticIndexRowMeta[],
  notes: readonly SemanticIndexNoteMeta[],
): SemanticIndexLexicalStatsV1 {
  const notesByPath = new Map(notes.map((note) => [note.path, note]));
  return buildSemanticLexicalStatsV1(
    rows.map((row) => ({
      note: notesByPath.get(row.notePath) ?? { title: row.title, tags: [] },
      row,
    })),
  );
}

export function buildSemanticLexicalStatsV1(
  entries: ReadonlyArray<{
    note: { title: string; tags: string[] };
    row: { heading: string | null; snippet: string; text?: string };
  }>,
): SemanticIndexLexicalStatsV1 {
  const frequencies = new Map<string, number>();
  let totalLength = 0;
  for (const entry of entries) {
    const text = rowLexicalTextV1(entry.note, entry.row);
    totalLength += text.length;
    for (const term of tokenize(text)) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  const kept = [...frequencies.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_LEXICAL_STAT_TERMS);
  return {
    documentCount: entries.length,
    averageLength: entries.length > 0 ? totalLength / entries.length : 0,
    documentFrequencies: Object.fromEntries(kept),
  };
}

/**
 * Share of the query's *information* that a piece of text carries, rather than
 * share of its words. With a query like "semantic index rebuild", "index" may
 * sit in half the vault while "rebuild" sits in three notes; counting them
 * equally is what let a keyword-dense note outrank the note that answers.
 * Terms absent from the capped table are treated as maximally rare.
 */
function idfWeightedOverlapV1(
  queryTerms: Set<string>,
  text: Set<string>,
  stats: SemanticIndexLexicalStatsV1,
): number {
  if (queryTerms.size === 0 || text.size === 0) return 0;
  const documentCount = Math.max(1, stats.documentCount);
  const weightOf = (term: string): number => {
    const documentFrequency = stats.documentFrequencies[term] ?? 0;
    return Math.log(
      1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
  };
  let matched = 0;
  let total = 0;
  for (const term of queryTerms) {
    const weight = weightOf(term);
    total += weight;
    if (text.has(term)) matched += weight;
  }
  return total > 0 ? matched / total : 0;
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const term of left) {
    if (right.has(term)) {
      overlap += 1;
    }
  }
  return overlap / left.size;
}


function compareHits(
  left: ScoredIndexHitV1,
  right: ScoredIndexHitV1,
): number {
  const rrf = right.score - left.score;
  if (rrf !== 0) return rrf;
  const cosineGap = right.semanticScore - left.semanticScore;
  if (Math.abs(cosineGap) > COSINE_TIEBREAK_MARGIN_V1) return cosineGap;
  return (
    right.lexicalScore - left.lexicalScore ||
    cosineGap ||
    left.sortPath.localeCompare(right.sortPath)
  );
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
