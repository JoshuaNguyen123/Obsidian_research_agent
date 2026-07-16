import type { App, TFile } from "obsidian";
import type { AgentSettings } from "../settings";
import {
  chunkMarkdownForSemanticSearch,
  type SemanticChunkingOptions,
} from "../tools/semanticSearchTools";
import { normalizeVaultPath } from "../tools/validation";
import { isPathUnderVaultFolder, isVaultPathExcluded } from "../tools/vaultExclusions";
import type { SemanticEmbeddingProvider } from "./types";
import type {
  SemanticIndexBuildResult,
  SemanticIndexChunk,
  SemanticIndexNote,
  SemanticIndexNoteMeta,
  SemanticIndexRowMeta,
  SemanticIndexShardV2,
  SemanticIndexSearchHit,
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

interface CachedSemanticShard {
  mtime: number;
  size: number;
  shard: SemanticIndexShardV2;
}

const semanticShardReadCache = new Map<string, CachedSemanticShard>();

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
      return null;
    }

    try {
      const parsed = JSON.parse(await this.app.vault.cachedRead(file));
      return isSemanticVaultIndex(parsed) ? parsed : null;
    } catch {
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

    const freshness = this.checkFreshness(index);
    if (!freshness.fresh) {
      return makeSearchFailure(
        model,
        dim,
        freshness.reason ?? "stale_index",
        `Semantic index is stale: ${freshness.reason ?? "unknown"}.`,
        index.indexedAt,
      );
    }

    const query = request.query.trim();
    if (!query) {
      return makeSearchFailure(model, dim, "empty_query", "Query is required.", index.indexedAt);
    }

    const response = await this.getEmbeddingProvider().embed({
      model,
      dim,
      documents: [],
      queries: [query],
    });
    if (!response.ok || response.queries?.length !== 1) {
      return makeSearchFailure(
        model,
        dim,
        response.code ?? "query_embedding_failed",
        response.message ?? "Unable to embed semantic index query.",
        index.indexedAt,
      );
    }

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
          }),
          candidateCount: index.notes.reduce((sum, note) => sum + note.chunks.length, 0),
          nextCursor: null,
        };

    return {
      ok: true,
      operation: "semantic_index_search",
      mode: "indexed_semantic",
      indexUsed: true,
      indexFresh: true,
      model: index.model,
      dim: index.dim,
      indexedAt: index.indexedAt,
      candidateCount: searchResult.candidateCount,
      nextCursor: searchResult.nextCursor,
      resultCount: searchResult.hits.length,
      results: searchResult.hits,
    };
  }

  private checkFreshness(index: SemanticVaultIndex): Freshness {
    return getSemanticIndexFreshness(this.app, this.getSettings(), index);
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

    for (const file of files) {
      const note = await buildPendingNote(this.app, file, chunking);
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
      await writeVaultText(
        this.app,
        getShardPath(paths.folder, shard.id),
        `${JSON.stringify(shard)}\n`,
      );
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
  dim: 256 | 512;
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

async function embedIndexDocuments({
  provider,
  settings,
  documents,
}: {
  provider: SemanticEmbeddingProvider;
  settings: AgentSettings;
  documents: string[];
}): Promise<{ ok: true; vectors: number[][] } | { ok: false; code: string; message: string }> {
  if (documents.length === 0) {
    return { ok: true, vectors: [] };
  }

  const response = await provider.embed({
    model: getSemanticModel(settings),
    dim: getSemanticDim(settings),
    cacheDir: settings.semanticModelCacheDir || undefined,
    documents,
    queries: [],
  });
  if (!response.ok || response.documents?.length !== documents.length) {
    return {
      ok: false,
      code: response.code ?? "document_embedding_failed",
      message: response.message ?? "Unable to embed semantic index documents.",
    };
  }

  return { ok: true, vectors: response.documents };
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
}: {
  index: SemanticVaultIndexV1;
  queryVector: number[];
  queryTerms: Set<string>;
  folder: string | null;
  limit: number;
  maxSnippetChars: number;
  minScore?: number;
  cursor?: string | null;
}): SemanticIndexSearchHit[] {
  const scored: Array<SemanticIndexSearchHit & { sortPath: string }> = [];

  for (const note of index.notes) {
    if (folder && !note.path.startsWith(`${folder}/`)) {
      continue;
    }
    for (const chunk of note.chunks) {
      const semanticScore = normalizeCosine(cosineSimilarity(queryVector, chunk.vector));
      const lexicalScore = lexicalScoreForChunk(note, chunk, queryTerms);
      const score = semanticScore * 0.85 + lexicalScore.score * 0.15;
      const reasons =
        semanticScore > 0.55
          ? ["indexed_semantic_similarity", ...lexicalScore.reasons]
          : lexicalScore.reasons;
      if (semanticScore <= 0.1 && lexicalScore.score <= 0) {
        continue;
      }
      const hit = {
        path: note.path,
        title: note.title,
        score: roundScore(score),
        semanticScore: roundScore(semanticScore),
        lexicalScore: roundScore(lexicalScore.score),
        reasons: dedupeStrings(reasons),
        heading: chunk.heading,
        snippet: boundedSnippet(chunk.snippet, maxSnippetChars),
        sortPath: note.path,
      };
      if (minScore === undefined || hit.score >= minScore) {
        scored.push(hit);
      }
    }
  }

  const byPath = new Map<string, SemanticIndexSearchHit & { sortPath: string }>();
  for (const hit of scored.sort(compareHits)) {
    if (!byPath.has(hit.path)) {
      byPath.set(hit.path, hit);
    }
  }

  const offset = parseCursorOffset(cursor);
  return [...byPath.values()]
    .sort(compareHits)
    .slice(offset, offset + limit)
    .map(({ sortPath, ...hit }) => hit);
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
}: {
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
}): Promise<{
  hits: SemanticIndexSearchHit[];
  candidateCount: number;
  nextCursor: string | null;
}> {
  const scored: Array<SemanticIndexSearchHit & { sortPath: string }> = [];
  let candidateCount = 0;
  const noteByPath = new Map(index.notes.map((note) => [note.path, note]));

  for (const ref of index.shards) {
    const shard = await readIndexShard(app, ref.path);
    if (!shard || shard.dim !== index.dim) {
      continue;
    }
    const vectors = decodeFloat32Base64(shard.vectorsBase64);
    for (let rowIndex = 0; rowIndex < shard.rows.length; rowIndex += 1) {
      const row = shard.rows[rowIndex];
      if (folder && !row.notePath.startsWith(`${folder}/`)) {
        continue;
      }
      const vector = vectors.slice(rowIndex * index.dim, rowIndex * index.dim + index.dim);
      const note = noteByPath.get(row.notePath);
      if (!note) {
        continue;
      }
      candidateCount += 1;
      const semanticScore = normalizeCosine(cosineSimilarity(queryVector, vector));
      const lexicalScore = lexicalScoreForRow(note, row, queryTerms);
      const score = semanticScore * 0.85 + lexicalScore.score * 0.15;
      if (semanticScore <= 0.1 && lexicalScore.score <= 0) {
        continue;
      }
      const hit = {
        path: row.notePath,
        title: row.title,
        score: roundScore(score),
        semanticScore: roundScore(semanticScore),
        lexicalScore: roundScore(lexicalScore.score),
        reasons: dedupeStrings(
          semanticScore > 0.55
            ? ["indexed_semantic_similarity", ...lexicalScore.reasons]
            : lexicalScore.reasons,
        ),
        heading: row.heading,
        snippet: boundedSnippet(row.snippet, maxSnippetChars),
        sortPath: row.notePath,
      };
      if (minScore !== undefined && hit.score < minScore) {
        continue;
      }
      pushBoundedHit(scored, hit, candidateLimit);
    }
  }

  const byPath = new Map<string, SemanticIndexSearchHit & { sortPath: string }>();
  for (const hit of scored.sort(compareHits)) {
    if (!byPath.has(hit.path)) {
      byPath.set(hit.path, hit);
    }
  }
  const allHits = [...byPath.values()].sort(compareHits);
  const offset = parseCursorOffset(cursor);
  const page = allHits.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    hits: page.map(({ sortPath, ...hit }) => hit),
    candidateCount,
    nextCursor: nextOffset < allHits.length ? String(nextOffset) : null,
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
  const heading = overlapRatio(queryTerms, tokenize(row.heading ?? ""));
  if (heading > 0) {
    score += heading * 0.2;
    reasons.push("heading_match");
  }
  const tags = overlapRatio(queryTerms, tokenize(note.tags.join(" ")));
  if (tags > 0) {
    score += tags * 0.15;
    reasons.push("tag_match");
  }
  const snippet = overlapRatio(queryTerms, tokenize(row.snippet));
  if (snippet > 0) {
    score += snippet * 0.55;
    reasons.push("snippet_match");
  }
  return { score: Math.min(1, score), reasons };
}

function pushBoundedHit<T extends SemanticIndexSearchHit & { sortPath: string }>(
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
): Freshness {
  if (!isIndexCompatible(index, settings)) {
    return { fresh: false, reason: "settings_changed" };
  }
  if (!settings.semanticIndexPersistVectors) {
    return { fresh: false, reason: "vectors_disabled" };
  }

  const indexedByPath = new Map(index.notes.map((note) => [note.path, note]));
  for (const note of index.notes) {
    const file = app.vault.getFileByPath(note.path);
    if (!file) {
      return { fresh: false, reason: "indexed_file_missing" };
    }
    if (file.stat?.mtime !== note.mtime || file.stat?.size !== note.size) {
      return { fresh: false, reason: "indexed_file_changed" };
    }
  }

  if (index.version === 1) {
    for (const note of index.notes) {
    if (
      (note.chunks.length === 0 ||
        note.chunks.some((chunk) => chunk.vector.length !== index.dim))
    ) {
      return { fresh: false, reason: "missing_vectors" };
    }
    }
  }

  if (index.version === 2) {
    for (const note of index.notes) {
      if (note.chunkCount === 0) {
      return { fresh: false, reason: "missing_rows" };
    }
  }

    if (index.shards.length === 0 && index.totalRows > 0) {
      return { fresh: false, reason: "missing_shards" };
    }
    for (const shard of index.shards) {
      if (shard.rowCount <= 0 || !app.vault.getFileByPath(shard.path)) {
        return { fresh: false, reason: "missing_shards" };
      }
    }
  }

  for (const file of getIndexableFiles(app, settings).slice(
    0,
    getIndexMaxFiles(settings),
  )) {
    if (!indexedByPath.has(file.path)) {
      return { fresh: false, reason: "new_file_not_indexed" };
    }
  }

  return { fresh: true };
}

function isIndexCompatible(index: SemanticVaultIndex, settings: AgentSettings): boolean {
  const chunking = getChunking(settings);
  return (
    (index.version === INDEX_VERSION || index.version === LEGACY_INDEX_VERSION) &&
    index.model === getSemanticModel(settings) &&
    index.dim === getSemanticDim(settings) &&
    index.chunking.minTokens === chunking.minTokens &&
    index.chunking.targetTokens === chunking.targetTokens &&
    index.chunking.maxTokens === chunking.maxTokens &&
    index.chunking.overlapTokens === chunking.overlapTokens
  );
}

function isSemanticVaultIndex(value: unknown): value is SemanticVaultIndex {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.version === INDEX_VERSION || value.version === LEGACY_INDEX_VERSION) &&
    typeof value.model === "string" &&
    (value.dim === 256 || value.dim === 512) &&
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
    (value.dim === 256 || value.dim === 512) &&
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

  const parts = folder.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getFolderByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch (error) {
        // File watchers and an explicit updatePaths() call may race while
        // creating a fresh per-run index folder. Treat only the confirmed
        // postcondition as success; all other create failures remain fatal.
        if (!app.vault.getFolderByPath(current)) {
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
  return settings.semanticEmbeddingModel.trim() || "nomic-ai/nomic-embed-text-v1.5-Q";
}

function getSemanticDim(settings: AgentSettings): 256 | 512 {
  return settings.semanticEmbeddingDim === 256 ? 256 : 512;
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

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude <= 0 || rightMagnitude <= 0) {
    return 0;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function normalizeCosine(value: number): number {
  return Math.max(0, Math.min(1, (value + 1) / 2));
}

function compareHits(
  left: SemanticIndexSearchHit & { sortPath: string },
  right: SemanticIndexSearchHit & { sortPath: string },
): number {
  return (
    right.score - left.score ||
    right.semanticScore - left.semanticScore ||
    right.lexicalScore - left.lexicalScore ||
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
