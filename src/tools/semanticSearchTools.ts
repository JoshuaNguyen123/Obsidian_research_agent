import type { TFile } from "obsidian";
import { MAX_LISTED_FILES } from "./constants";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import {
  getOptionalInteger,
  getOptionalString,
  getRequiredString,
  normalizeVaultPath,
} from "./validation";
import type {
  SemanticIndexNote,
  SemanticIndexNoteMeta,
  SemanticVaultIndex,
} from "../embeddings/semanticIndexTypes";
import { getSemanticIndexFreshness } from "../embeddings/semanticIndex";
import { buildRetrievalCoverage } from "../agent/retrievalCoverage";
import { isVaultPathExcluded } from "./vaultExclusions";

const DEFAULT_SEMANTIC_LIMIT = 8;
const MAX_SEMANTIC_LIMIT = 20;
const DEFAULT_MAX_SNIPPET_CHARS = 360;
const MAX_SNIPPET_CHARS = 800;
const DEFAULT_SEMANTIC_MODEL = "nomic-ai/nomic-embed-text-v1.5-Q";
const DEFAULT_SEMANTIC_DIM = 512;
const DEFAULT_CHUNK_MIN_TOKENS = 300;
const DEFAULT_CHUNK_TARGET_TOKENS = 500;
const DEFAULT_CHUNK_MAX_TOKENS = 700;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 80;
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
  "say",
  "says",
  "show",
  "find",
  "search",
  "related",
]);

interface MetadataCacheLike {
  getFileCache?: (file: TFile) => MetadataFileCacheLike | null;
}

interface MetadataFileCacheLike {
  headings?: Array<{ heading: string; level: number }>;
  tags?: Array<{ tag: string }>;
  links?: Array<{ link: string; displayText?: string; original?: string }>;
  frontmatter?: Record<string, unknown>;
}

export interface SemanticChunkingOptions {
  minTokens: number;
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

interface NoteMetadata {
  title: string;
  tags: string[];
  links: string[];
}

interface SemanticChunkProfile {
  id: string;
  path: string;
  basename: string;
  title: string;
  heading: string | null;
  text: string;
  embeddingText: string;
  tokenCount: number;
  tags: string[];
  links: string[];
}

interface ScoredChunk {
  chunk: SemanticChunkProfile;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  reasons: string[];
}

export function createSemanticSearchTools(): AgentTool[] {
  return [
    semanticSearchNotesTool,
    inspectSemanticIndexTool,
    rebuildSemanticIndexTool,
  ];
}

export const semanticSearchNotesTool: AgentTool = {
  name: "semantic_search_notes",
  description:
    "Use for conceptual vault search when the user asks what notes say about an idea, topic, theme, memory, relationship, or concept and exact filenames or wording may differ. Returns vault-relative paths and short snippets. Read-only.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "Conceptual topic or question to search for in markdown notes.",
      },
      limit: {
        type: "integer",
        description: "Maximum matching notes to return. Defaults to 8, maximum 20.",
      },
      folder: {
        type: "string",
        description: "Optional vault-relative folder to search within.",
      },
      maxSnippetChars: {
        type: "integer",
        description: "Maximum snippet characters per result.",
      },
      mode: {
        type: "string",
        enum: ["standard", "deep"],
        description: "Use deep for larger internal candidate search while keeping returned results compact.",
      },
      candidateLimit: {
        type: "integer",
        description: "Internal candidate count for indexed semantic search. Deep mode defaults higher.",
      },
      minScore: {
        type: "number",
        description: "Optional minimum score threshold between 0 and 1.",
      },
      cursor: {
        type: "string",
        description: "Optional cursor from a previous semantic_search_notes result.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const query = getRequiredString(args, "query").trim();
    if (!query) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "semantic_search_notes requires a non-empty query.",
      );
    }

    const limit = clampInteger(
      getOptionalInteger(args, "limit") ?? DEFAULT_SEMANTIC_LIMIT,
      1,
      MAX_SEMANTIC_LIMIT,
    );
    const maxSnippetChars = clampInteger(
      getOptionalInteger(args, "maxSnippetChars") ?? DEFAULT_MAX_SNIPPET_CHARS,
      80,
      MAX_SNIPPET_CHARS,
    );
    const folder = normalizeOptionalFolder(getOptionalString(args, "folder"));
    const mode = getOptionalString(args, "mode") === "deep" ? "deep" : "standard";
    const candidateLimit = clampInteger(
      getOptionalInteger(args, "candidateLimit") ??
        (mode === "deep" ? Math.max(64, limit * 8) : limit * 4),
      limit,
      500,
    );
    const minScore = normalizeOptionalScore(args.minScore);
    const cursor = getOptionalString(args, "cursor")?.trim() || null;
    const chunking = getSemanticChunkingOptions(context);
    const indexed = await searchSemanticIndexFirst({
      context,
      query,
      limit,
      folder,
      maxSnippetChars,
      mode,
      candidateLimit,
      minScore,
      cursor,
    });
    if (indexed) {
      return indexed;
    }

    const chunks = await buildSemanticChunkProfiles(context, folder, chunking);
    const queryTerms = tokenizeConceptText(query);
    let fallbackUsed = !context.semanticEmbeddingProvider;
    let fallbackReason = context.semanticEmbeddingProvider
      ? null
      : "semantic_embedding_provider_unavailable";
    let scored: ScoredChunk[] = [];

    if (context.semanticEmbeddingProvider && chunks.length > 0) {
      const response = await context.semanticEmbeddingProvider.embed({
        model: getSemanticModel(context),
        dim: getSemanticDim(context),
        cacheDir: context.settings.semanticModelCacheDir || undefined,
        documents: chunks.map((chunk) => chunk.embeddingText),
        queries: [query],
      });

      if (
        response.ok &&
        response.documents?.length === chunks.length &&
        response.queries?.length === 1
      ) {
        scored = scoreSemanticChunks({
          chunks,
          queryVector: response.queries[0],
          documentVectors: response.documents,
          queryTerms,
        });
      } else {
        fallbackUsed = true;
        fallbackReason = response.code ?? "semantic_embedding_failed";
      }
    }

    if (scored.length === 0) {
      scored = scoreLexicalChunks(chunks, queryTerms);
    }

    const collapsed = collapseChunksToNotes(scored, queryTerms, maxSnippetChars)
      .filter((result) => minScore === undefined || result.score >= minScore);
    const offset = parseCursorOffset(cursor);
    const results = collapsed.slice(offset, offset + limit);
    const nextCursor = offset + results.length < collapsed.length
      ? String(offset + results.length)
      : null;

    return {
      operation: "semantic_search_notes",
      mode: fallbackUsed ? "lexical_fallback" : "hybrid_semantic",
      indexUsed: false,
      indexFresh: false,
      model: getSemanticModel(context),
      dim: getSemanticDim(context),
      chunking,
      fallbackUsed,
      fallbackReason,
      candidateLimit,
      nextCursor,
      resultCount: results.length,
      results,
      coverage: buildRetrievalCoverage({
        mode: fallbackUsed ? "fallback" : "sampled",
        considered: chunks.length,
        read: results.length,
        skipped: Math.max(0, chunks.length - results.length),
        truncated: nextCursor !== null || results.length < chunks.length,
        fallbackUsed,
        reasons: [
          fallbackUsed ? String(fallbackReason ?? "lexical_fallback") : "live_semantic_search",
          folder ? "folder_scope" : "vault_scope",
        ],
      }),
    };
  },
};

export const inspectSemanticIndexTool: AgentTool = {
  name: "inspect_semantic_index",
  description:
    "Inspect the semantic vault index for concepts, paths, freshness, and short evidence summaries. Read-only.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional concept query to inspect in the index.",
      },
      limit: {
        type: "integer",
        description: "Maximum concepts or notes to return. Defaults to 8, maximum 20.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    if (!context.semanticIndexService || !context.settings.semanticIndexEnabled) {
      return {
        operation: "inspect_semantic_index",
        indexAvailable: false,
        indexFresh: false,
        concepts: [],
        results: [],
        message: "Semantic index service is unavailable or disabled.",
      };
    }

    const limit = clampInteger(
      getOptionalInteger(args, "limit") ?? DEFAULT_SEMANTIC_LIMIT,
      1,
      MAX_SEMANTIC_LIMIT,
    );
    const query = getOptionalString(args, "query")?.trim() ?? "";
    if (query) {
      const search = await context.semanticIndexService.search({
        query,
        limit,
        maxSnippetChars: DEFAULT_MAX_SNIPPET_CHARS,
      });
      return {
        operation: "inspect_semantic_index",
        indexAvailable: search.ok || search.code !== "missing_index",
        indexFresh: search.indexFresh,
        indexedAt: search.indexedAt,
        model: search.model,
        dim: search.dim,
        concepts: [],
        results: search.results,
        fallbackReason: search.ok ? null : search.code,
        message: search.ok ? undefined : search.message,
      };
    }

    const index = await context.semanticIndexService.load();
    if (!index) {
      return {
        operation: "inspect_semantic_index",
        indexAvailable: false,
        indexFresh: false,
        concepts: [],
        results: [],
        message: "Semantic index has not been built.",
      };
    }

    const freshness = getSemanticIndexFreshness(context.app, context.settings, index);
    return {
      operation: "inspect_semantic_index",
      indexAvailable: true,
      indexFresh: freshness.fresh,
      staleReason: freshness.fresh ? null : freshness.reason,
      indexedAt: index.indexedAt,
      model: index.model,
      dim: index.dim,
      noteCount: index.notes.length,
      chunkCount: getIndexChunkCount(index),
      concepts: summarizeIndexConcepts(index, limit),
      results: summarizeIndexNotes(index.notes, limit),
    };
  },
};

export const rebuildSemanticIndexTool: AgentTool = {
  name: "rebuild_semantic_index",
  description:
    "Rebuild the derived semantic vault index files when the user explicitly asks for index maintenance.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(args, context) {
    const keys = Object.keys(args);
    if (keys.length > 0) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "rebuild_semantic_index does not accept arguments.",
      );
    }
    if (!context.semanticIndexService) {
      throw new ToolExecutionError(
        "semantic_index_unavailable",
        "Semantic index service is unavailable.",
      );
    }

    return context.semanticIndexService.rebuild();
  },
};

async function searchSemanticIndexFirst({
  context,
  query,
  limit,
  folder,
  maxSnippetChars,
  mode,
  candidateLimit,
  minScore,
  cursor,
}: {
  context: ToolExecutionContext;
  query: string;
  limit: number;
  folder: string | null;
  maxSnippetChars: number;
  mode: "standard" | "deep";
  candidateLimit: number;
  minScore?: number;
  cursor: string | null;
}) {
  if (!context.settings.semanticIndexEnabled || !context.semanticIndexService) {
    return null;
  }

  const search = await context.semanticIndexService.search({
    query,
    limit,
    folder,
    maxSnippetChars,
    mode,
    candidateLimit,
    minScore,
    cursor,
  });

  if (!search.ok) {
    return null;
  }

  return {
    operation: "semantic_search_notes",
    mode: "indexed_semantic",
    indexUsed: true,
    indexFresh: true,
    indexedAt: search.indexedAt,
    model: search.model,
    dim: search.dim,
    fallbackUsed: false,
    fallbackReason: null,
    candidateLimit,
    nextCursor: search.nextCursor ?? null,
    resultCount: search.results.length,
    results: search.results.map((result) => ({
      ...result,
      reasons: result.reasons.length
        ? result.reasons
        : ["indexed_semantic_similarity"],
    })),
    coverage: buildRetrievalCoverage({
      mode: "indexed",
      considered: search.candidateCount ?? search.results.length,
      read: search.results.length,
      skipped: Math.max(0, (search.candidateCount ?? search.results.length) - search.results.length),
      truncated: Boolean(search.nextCursor),
      fallbackUsed: false,
      reasons: ["fresh_persisted_semantic_index"],
    }),
  };
}

export function chunkMarkdownForSemanticSearch(
  markdown: string,
  options: SemanticChunkingOptions,
): Array<{ heading: string | null; text: string; tokenCount: number }> {
  const normalizedOptions = normalizeChunkingOptions(options);
  const blocks = splitMarkdownBlocks(markdown);
  const chunks: Array<{ heading: string | null; text: string; tokenCount: number }> = [];
  let currentHeading: string | null = null;
  let currentBlocks: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (currentBlocks.length === 0) {
      return;
    }
    const text = currentBlocks.join("\n\n").trim();
    if (!text) {
      currentBlocks = [];
      currentTokens = 0;
      return;
    }
    chunks.push({
      heading: currentHeading,
      text,
      tokenCount: countApproxTokens(text),
    });
    const overlapText = takeLastTokens(text, normalizedOptions.overlapTokens);
    currentBlocks = overlapText ? [overlapText] : [];
    currentTokens = overlapText ? countApproxTokens(overlapText) : 0;
  };

  for (const block of blocks) {
    const heading = parseHeading(block);
    if (heading) {
      currentHeading = heading;
    }

    const blockTokens = countApproxTokens(block);
    if (blockTokens > normalizedOptions.maxTokens) {
      flush();
      for (const piece of splitLongBlock(block, normalizedOptions)) {
        chunks.push({
          heading: currentHeading,
          text: piece,
          tokenCount: countApproxTokens(piece),
        });
      }
      currentBlocks = [];
      currentTokens = 0;
      continue;
    }

    if (
      currentBlocks.length > 0 &&
      currentTokens + blockTokens > normalizedOptions.maxTokens
    ) {
      flush();
    }

    currentBlocks.push(block);
    currentTokens += blockTokens;

    if (
      currentTokens >= normalizedOptions.targetTokens &&
      currentTokens >= normalizedOptions.minTokens
    ) {
      flush();
    }
  }

  if (currentBlocks.length > 0) {
    const text = currentBlocks.join("\n\n").trim();
    if (text && chunks.every((chunk) => chunk.text !== text)) {
      chunks.push({
        heading: currentHeading,
        text,
        tokenCount: countApproxTokens(text),
      });
    }
  }

  return chunks.filter((chunk) => chunk.text.trim());
}

async function buildSemanticChunkProfiles(
  context: ToolExecutionContext,
  folder: string | null,
  chunking: SemanticChunkingOptions,
): Promise<SemanticChunkProfile[]> {
  const files = context.app.vault
    .getFiles()
    .filter((file) => file.extension === "md")
    .filter((file) => !isVaultPathExcluded(file.path))
    .filter((file) => isFileInFolder(file.path, folder))
    .slice(0, MAX_LISTED_FILES);
  const chunks: SemanticChunkProfile[] = [];

  for (const file of files) {
    chunks.push(...(await getFileChunkProfiles(context, file, chunking)));
  }

  return chunks;
}

async function getFileChunkProfiles(
  context: ToolExecutionContext,
  file: TFile,
  chunking: SemanticChunkingOptions,
): Promise<SemanticChunkProfile[]> {
  const cacheKey = getSemanticProfileCacheKey(file, context, chunking);
  const cache =
    context.runtimeCache?.semanticProfiles ??
    (context.runtimeCache
      ? (context.runtimeCache.semanticProfiles = new Map<string, unknown>())
      : undefined);
  const cached = cache?.get(cacheKey);
  if (Array.isArray(cached)) {
    return cached as SemanticChunkProfile[];
  }

  const content = await context.app.vault.cachedRead(file);
  const metadata = readNoteMetadata(context, file, content);
  const chunks = chunkMarkdownForSemanticSearch(content, chunking).map(
    (chunk, index) => {
      const heading = chunk.heading;
      const embeddingText = [
        metadata.title,
        heading ?? "",
        metadata.tags.join(" "),
        chunk.text,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        id: `${file.path}#${index}`,
        path: file.path,
        basename: file.basename,
        title: metadata.title,
        heading,
        text: chunk.text,
        embeddingText,
        tokenCount: chunk.tokenCount,
        tags: metadata.tags,
        links: metadata.links,
      };
    },
  );

  cache?.set(cacheKey, chunks);
  return chunks;
}

function scoreSemanticChunks({
  chunks,
  queryVector,
  documentVectors,
  queryTerms,
}: {
  chunks: SemanticChunkProfile[];
  queryVector: number[];
  documentVectors: number[][];
  queryTerms: Set<string>;
}): ScoredChunk[] {
  return chunks
    .map((chunk, index) => {
      const semanticScore = normalizeCosine(cosineSimilarity(queryVector, documentVectors[index]));
      const lexical = scoreLexicalChunk(chunk, queryTerms);
      const score = semanticScore * 0.85 + lexical.score * 0.15;
      const reasons = semanticScore > 0.55
        ? ["semantic_similarity", ...lexical.reasons]
        : lexical.reasons;
      return {
        chunk,
        score,
        semanticScore,
        lexicalScore: lexical.score,
        reasons: dedupeStrings(reasons),
      };
    })
    .filter((item) => item.semanticScore > 0.1 || item.lexicalScore > 0)
    .sort(compareScoredChunks);
}

function scoreLexicalChunks(
  chunks: SemanticChunkProfile[],
  queryTerms: Set<string>,
): ScoredChunk[] {
  return chunks
    .map((chunk) => {
      const lexical = scoreLexicalChunk(chunk, queryTerms);
      return {
        chunk,
        score: lexical.score,
        semanticScore: 0,
        lexicalScore: lexical.score,
        reasons: lexical.reasons,
      };
    })
    .filter((item) => item.lexicalScore > 0)
    .sort(compareScoredChunks);
}

function scoreLexicalChunk(
  chunk: SemanticChunkProfile,
  queryTerms: Set<string>,
): { score: number; reasons: string[] } {
  if (queryTerms.size === 0) {
    return { score: 0, reasons: [] };
  }

  const textTerms = tokenizeConceptText(chunk.text);
  const titleTerms = tokenizeConceptText(chunk.title);
  const headingTerms = tokenizeConceptText(chunk.heading ?? "");
  const tagTerms = tokenizeConceptText(chunk.tags.join(" "));
  const pathTerms = tokenizeConceptText(chunk.path.replace(/[\/_.-]+/g, " "));
  const reasons: string[] = [];
  let score = 0;

  const contentOverlap = overlapRatio(queryTerms, textTerms);
  if (contentOverlap > 0) {
    score += contentOverlap * 0.55;
    reasons.push("content_match");
  }

  const titleOverlap = overlapRatio(queryTerms, titleTerms);
  if (titleOverlap > 0) {
    score += titleOverlap * 0.25;
    reasons.push("title_match");
  }

  const headingOverlap = overlapRatio(queryTerms, headingTerms);
  if (headingOverlap > 0) {
    score += headingOverlap * 0.2;
    reasons.push("heading_match");
  }

  const tagOverlap = overlapRatio(queryTerms, tagTerms);
  if (tagOverlap > 0) {
    score += tagOverlap * 0.15;
    reasons.push("tag_match");
  }

  const pathOverlap = overlapRatio(queryTerms, pathTerms);
  if (pathOverlap > 0) {
    score += pathOverlap * 0.1;
    reasons.push("path_match");
  }

  return {
    score: Math.min(score, 1),
    reasons,
  };
}

function collapseChunksToNotes(
  scored: ScoredChunk[],
  queryTerms: Set<string>,
  maxSnippetChars: number,
) {
  const byPath = new Map<string, ScoredChunk>();
  for (const item of scored) {
    const existing = byPath.get(item.chunk.path);
    if (!existing || compareScoredChunks(item, existing) < 0) {
      byPath.set(item.chunk.path, item);
    }
  }

  return [...byPath.values()]
    .sort(compareScoredChunks)
    .map((item) => ({
      path: item.chunk.path,
      title: item.chunk.title,
      score: roundScore(item.score),
      semanticScore: roundScore(item.semanticScore),
      lexicalScore: roundScore(item.lexicalScore),
      reasons: item.reasons,
      heading: item.chunk.heading,
      snippet: buildSnippet(item.chunk.text, queryTerms, maxSnippetChars),
    }));
}

function readNoteMetadata(
  context: ToolExecutionContext,
  file: TFile,
  content: string,
): NoteMetadata {
  const cache = getMetadataCache(context).getFileCache?.(file) ?? null;
  return {
    title: readTitle(cache, content, file),
    tags: readTags(cache),
    links: readLinks(cache),
  };
}

function readTitle(
  cache: MetadataFileCacheLike | null,
  content: string,
  file: TFile,
): string {
  const frontmatterTitle = cache?.frontmatter?.title;
  if (typeof frontmatterTitle === "string" && frontmatterTitle.trim()) {
    return frontmatterTitle.trim();
  }

  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || file.basename;
}

function readTags(cache: MetadataFileCacheLike | null): string[] {
  return dedupeStrings(
    [
      ...(cache?.tags ?? []).map((tag) => tag.tag),
      ...frontmatterValueToStrings(cache?.frontmatter?.tags),
      ...frontmatterValueToStrings(cache?.frontmatter?.tag),
    ]
      .map((tag) => tag.trim().replace(/^#+/, ""))
      .filter(Boolean),
  );
}

function readLinks(cache: MetadataFileCacheLike | null): string[] {
  return dedupeStrings(
    (cache?.links ?? [])
      .map((link) => link.link)
      .filter((link) => typeof link === "string" && link.trim()),
  );
}

function frontmatterValueToStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => frontmatterValueToStrings(item));
  }
  return [];
}

function splitMarkdownBlocks(markdown: string): string[] {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function splitLongBlock(
  block: string,
  options: SemanticChunkingOptions,
): string[] {
  const tokens = getApproxTokens(block);
  const pieces: string[] = [];
  const step = Math.max(1, options.maxTokens - options.overlapTokens);
  for (let start = 0; start < tokens.length; start += step) {
    const piece = tokens.slice(start, start + options.maxTokens).join(" ");
    if (piece.trim()) {
      pieces.push(piece);
    }
  }
  return pieces;
}

function parseHeading(block: string): string | null {
  const heading = block.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading || null;
}

function takeLastTokens(text: string, count: number): string {
  if (count <= 0) {
    return "";
  }
  return getApproxTokens(text).slice(-count).join(" ");
}

function buildSnippet(
  text: string,
  queryTerms: Set<string>,
  maxSnippetChars: number,
): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxSnippetChars) {
    return collapsed;
  }

  const lower = collapsed.toLowerCase();
  const firstMatch = [...queryTerms]
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const center = firstMatch ?? 0;
  const start = Math.max(0, center - Math.floor(maxSnippetChars / 3));
  const snippet = collapsed.slice(start, start + maxSnippetChars).trim();
  return `${start > 0 ? "... " : ""}${snippet}${start + maxSnippetChars < collapsed.length ? " ..." : ""}`;
}

function getSemanticChunkingOptions(
  context: ToolExecutionContext,
): SemanticChunkingOptions {
  return normalizeChunkingOptions({
    minTokens:
      context.settings.semanticChunkMinTokens ??
      DEFAULT_CHUNK_MIN_TOKENS,
    targetTokens:
      context.settings.semanticChunkTargetTokens ??
      DEFAULT_CHUNK_TARGET_TOKENS,
    maxTokens:
      context.settings.semanticChunkMaxTokens ??
      DEFAULT_CHUNK_MAX_TOKENS,
    overlapTokens:
      context.settings.semanticChunkOverlapTokens ??
      DEFAULT_CHUNK_OVERLAP_TOKENS,
  });
}

function normalizeChunkingOptions(
  options: SemanticChunkingOptions,
): SemanticChunkingOptions {
  const minTokens = clampInteger(options.minTokens, 50, 700);
  const targetTokens = clampInteger(options.targetTokens, minTokens, 700);
  const maxTokens = clampInteger(options.maxTokens, targetTokens, 1000);
  const overlapTokens = clampInteger(
    options.overlapTokens,
    0,
    Math.max(0, minTokens - 1),
  );
  return { minTokens, targetTokens, maxTokens, overlapTokens };
}

function getSemanticModel(context: ToolExecutionContext): string {
  return (
    context.settings.semanticEmbeddingModel?.trim() ||
    DEFAULT_SEMANTIC_MODEL
  );
}

function getSemanticDim(context: ToolExecutionContext): 256 | 512 {
  return context.settings.semanticEmbeddingDim === 256 ? 256 : DEFAULT_SEMANTIC_DIM;
}

function normalizeOptionalFolder(folder: string | undefined): string | null {
  if (folder === undefined || folder.trim() === "") {
    return null;
  }
  return normalizeVaultPath(folder, { allowRoot: true });
}

function isFileInFolder(path: string, folder: string | null): boolean {
  return folder === null || folder === "" || path.startsWith(`${folder}/`);
}

function getSemanticProfileCacheKey(
  file: TFile,
  context: ToolExecutionContext,
  chunking: SemanticChunkingOptions,
): string {
  const stat = file.stat ?? { mtime: 0, size: 0 };
  return [
    "semantic_chunks:v1",
    file.path,
    stat.mtime,
    stat.size,
    getSemanticModel(context),
    getSemanticDim(context),
    chunking.minTokens,
    chunking.targetTokens,
    chunking.maxTokens,
    chunking.overlapTokens,
  ].join(":");
}

function getMetadataCache(context: ToolExecutionContext): MetadataCacheLike {
  return (
    (context.app as unknown as { metadataCache?: MetadataCacheLike })
      .metadataCache ?? {}
  );
}

function tokenizeConceptText(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) ?? [])
      .map((term) => term.replace(/^['-]+|['-]+$/g, ""))
      .filter((term) => term.length > 2 && !STOP_TERMS.has(term)),
  );
}

function getApproxTokens(text: string): string[] {
  return text.match(/\S+/g) ?? [];
}

function countApproxTokens(text: string): number {
  return getApproxTokens(text).length;
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

function compareScoredChunks(left: ScoredChunk, right: ScoredChunk): number {
  return (
    right.score - left.score ||
    right.semanticScore - left.semanticScore ||
    right.lexicalScore - left.lexicalScore ||
    left.chunk.path.localeCompare(right.chunk.path)
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

function normalizeOptionalScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value));
}

function parseCursorOffset(cursor: string | null): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function summarizeIndexConcepts(index: SemanticVaultIndex, limit: number) {
  const byTerm = new Map<string, { count: number; paths: Set<string> }>();
  for (const note of index.notes) {
    const terms = tokenizeConceptText(
      [
        note.title,
        note.tags.join(" "),
        note.headings.join(" "),
        getNoteFirstSnippet(note),
      ].join(" "),
    );
    for (const term of terms) {
      const existing = byTerm.get(term) ?? {
        count: 0,
        paths: new Set<string>(),
      };
      existing.count += 1;
      existing.paths.add(note.path);
      byTerm.set(term, existing);
    }
  }

  return [...byTerm.entries()]
    .map(([term, value]) => ({
      term,
      count: value.count,
      paths: [...value.paths].slice(0, 6),
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.term.localeCompare(right.term),
    )
    .slice(0, limit);
}

function summarizeIndexNotes(
  notes: Array<SemanticIndexNote | SemanticIndexNoteMeta>,
  limit: number,
) {
  return notes.slice(0, limit).map((note) => ({
    path: note.path,
    title: note.title,
    tags: note.tags,
    headings: note.headings.slice(0, 6),
    snippet: getNoteFirstSnippet(note),
  }));
}

function getIndexChunkCount(index: SemanticVaultIndex): number {
  return index.version === 2
    ? index.totalRows
    : index.notes.reduce((sum, note) => sum + note.chunks.length, 0);
}

function getNoteFirstSnippet(
  note: SemanticIndexNote | SemanticIndexNoteMeta,
): string {
  return "firstSnippet" in note ? note.firstSnippet : note.chunks[0]?.snippet ?? "";
}
