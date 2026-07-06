import type { App, TFile } from "obsidian";
import type { AgentSettings } from "../settings";
import {
  chunkMarkdownForSemanticSearch,
  type SemanticChunkingOptions,
} from "../tools/semanticSearchTools";
import { normalizeVaultPath } from "../tools/validation";
import type { SemanticEmbeddingProvider } from "./types";
import type {
  SemanticIndexBuildResult,
  SemanticIndexChunk,
  SemanticIndexNote,
  SemanticIndexSearchHit,
  SemanticIndexSearchRequest,
  SemanticIndexSearchResult,
  SemanticIndexService,
  SemanticVaultIndex,
} from "./semanticIndexTypes";

const DEFAULT_INDEX_FOLDER = "Agent Memory";
const DEFAULT_INDEX_MAX_FILES = 1000;
const INDEX_MARKDOWN_NAME = "Semantic Vault Index.md";
const INDEX_JSON_NAME = "semantic-vault-index.json";
const INDEX_VERSION = 1;
const MAX_INDEX_SNIPPET_CHARS = 360;
const SYSTEM_PATH_PATTERN =
  /^(?:\.agent-backups|\.obsidian|\.trash|trash|Agent Runs)(?:\/|$)/i;
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

interface Freshness {
  fresh: boolean;
  reason?: string;
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
  const { markdownPath, jsonPath } = getSemanticIndexPaths(settings);
  return (
    normalized !== markdownPath &&
    normalized !== jsonPath &&
    !SYSTEM_PATH_PATTERN.test(normalized)
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
    const result = await this.buildIndexFromFiles(files);
    if (!result.ok || !result.index) {
      return makeBuildResult({
        operation: "semantic_index_rebuild",
        paths,
        ok: false,
        code: result.code ?? "semantic_index_build_failed",
        message: result.message ?? "Unable to build semantic index.",
      });
    }

    await this.writeIndex(result.index);
    return makeBuildResult({
      operation: "semantic_index_rebuild",
      paths,
      ok: true,
      index: result.index,
      updatedPaths: result.index.notes.map((note) => note.path),
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

    const result = await this.buildIndexFromFiles(files);
    if (!result.ok || !result.index) {
      return makeBuildResult({
        operation: "semantic_index_update",
        paths: indexPaths,
        ok: false,
        code: result.code ?? "semantic_index_update_failed",
        message: result.message ?? "Unable to update semantic index.",
      });
    }

    const replacements = new Map(
      result.index.notes.map((note) => [note.path, note]),
    );
    const removeSet = new Set([...normalizedPaths, ...removedPaths]);
    const notes = existing.notes
      .filter((note) => !removeSet.has(note.path))
      .concat([...replacements.values()])
      .sort((left, right) => left.path.localeCompare(right.path));
    const nextIndex: SemanticVaultIndex = {
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

    const removeSet = new Set(
      paths
        .map(normalizeQueuedPath)
        .filter((path): path is string => Boolean(path)),
    );
    const nextIndex: SemanticVaultIndex = {
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

    const hits = searchIndexChunks({
      index,
      queryVector: response.queries[0],
      queryTerms: tokenize(query),
      folder: request.folder ?? null,
      limit: request.limit,
      maxSnippetChars: request.maxSnippetChars ?? MAX_INDEX_SNIPPET_CHARS,
    });

    return {
      ok: true,
      operation: "semantic_index_search",
      mode: "indexed_semantic",
      indexUsed: true,
      indexFresh: true,
      model: index.model,
      dim: index.dim,
      indexedAt: index.indexedAt,
      resultCount: hits.length,
      results: hits,
    };
  }

  private checkFreshness(index: SemanticVaultIndex): Freshness {
    return getSemanticIndexFreshness(this.app, this.getSettings(), index);
  }

  private async buildIndexFromFiles(files: TFile[]): Promise<{
    ok: boolean;
    index?: SemanticVaultIndex;
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
      index: {
        version: INDEX_VERSION,
        model: getSemanticModel(settings),
        dim: getSemanticDim(settings),
        chunking,
        indexedAt: this.now().toISOString(),
        notes,
      },
    };
  }

  private async writeIndex(index: SemanticVaultIndex) {
    const settings = this.getSettings();
    const paths = getSemanticIndexPaths(settings);
    await ensureFolderPath(this.app, paths.folder);
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
}: {
  index: SemanticVaultIndex;
  queryVector: number[];
  queryTerms: Set<string>;
  folder: string | null;
  limit: number;
  maxSnippetChars: number;
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
      scored.push({
        path: note.path,
        title: note.title,
        score: roundScore(score),
        semanticScore: roundScore(semanticScore),
        lexicalScore: roundScore(lexicalScore.score),
        reasons: dedupeStrings(reasons),
        heading: chunk.heading,
        snippet: boundedSnippet(chunk.snippet, maxSnippetChars),
        sortPath: note.path,
      });
    }
  }

  const byPath = new Map<string, SemanticIndexSearchHit & { sortPath: string }>();
  for (const hit of scored.sort(compareHits)) {
    if (!byPath.has(hit.path)) {
      byPath.set(hit.path, hit);
    }
  }

  return [...byPath.values()].sort(compareHits).slice(0, limit).map(({ sortPath, ...hit }) => hit);
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

function renderSemanticIndexMarkdown(index: SemanticVaultIndex): string {
  const concepts = collectConcepts(index).slice(0, 40);
  const lines = [
    "# Semantic Vault Index",
    "",
    `Indexed at: ${index.indexedAt}`,
    `Model: ${index.model}`,
    `Dimension: ${index.dim}`,
    `Notes: ${index.notes.length}`,
    `Chunks: ${index.notes.reduce((sum, note) => sum + note.chunks.length, 0)}`,
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
      `- Chunks: ${note.chunks.length}`,
      `- Snippet: ${note.chunks[0]?.snippet ?? ""}`,
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
      [note.title, note.tags.join(" "), note.headings.join(" "), note.chunks[0]?.snippet ?? ""].join(" "),
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
    if (
      note.chunks.length === 0 ||
      note.chunks.some((chunk) => chunk.vector.length !== index.dim)
    ) {
      return { fresh: false, reason: "missing_vectors" };
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
    index.version === INDEX_VERSION &&
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
    value.version === INDEX_VERSION &&
    typeof value.model === "string" &&
    (value.dim === 256 || value.dim === 512) &&
    isRecord(value.chunking) &&
    typeof value.indexedAt === "string" &&
    Array.isArray(value.notes)
  );
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
    chunkCount: index?.notes.reduce((sum, note) => sum + note.chunks.length, 0) ?? 0,
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
      await app.vault.createFolder(current);
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
