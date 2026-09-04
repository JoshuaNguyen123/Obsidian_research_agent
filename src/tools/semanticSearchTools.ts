import type { SemanticEmbeddingResponse } from "../embeddings/types";
import { raceAbort } from "../utils/raceAbort";
import type { TFile } from "obsidian";
import { cosineSimilarity, normalizeCosine } from "../utils/vectorMath";
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
import { resolveEmbeddingPrefixesV1 } from "../embeddings/embeddingPrefixes";
import { resolveEffectiveEmbeddingDimV1 } from "../embeddings/embeddingModelCatalogV1";
import { buildRetrievalCoverage } from "../agent/retrievalCoverage";
import { isVaultPathExcluded } from "./vaultExclusions";
import { resolveSemanticSearchCapsForCompoundRun } from "../agent/setLooseCompoundAutonomy";
import type { AutonomyProfile } from "../agent/autonomyEffectClass";
import { NEW_INSTALL_SEMANTIC_EMBEDDING_MODEL } from "../agent/semanticProfile";
import {
  COSINE_TIEBREAK_MARGIN_V1,
  scoreHybridCandidatesV1,
} from "../embeddings/hybridRank";
import {
  bm25ContentScoreV1,
  buildLexicalCorpusStatsV1,
  buildLexicalDocumentTermStatsV1,
} from "./lexicalRanking";

const DEFAULT_SEMANTIC_LIMIT = 8;
const MAX_SEMANTIC_LIMIT = 20;
const DEFAULT_MAX_SNIPPET_CHARS = 360;
const MAX_SNIPPET_CHARS = 800;
const DEFAULT_SEMANTIC_MODEL = NEW_INSTALL_SEMANTIC_EMBEDDING_MODEL;
const DEFAULT_SEMANTIC_DIM = 512;
const DEFAULT_CHUNK_MIN_TOKENS = 150;
const DEFAULT_CHUNK_TARGET_TOKENS = 256;
const DEFAULT_CHUNK_MAX_TOKENS = 360;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 40;
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

/**
 * Is this search going to be read as evidence?
 *
 * Deep mode costs a wider first-stage shortlist and, under the shipped rerank
 * default, about a second of local cross-encoder time. That is the right trade
 * when the mission will write a note, edit a file, or answer a question from
 * the vault -- the result is about to become part of an answer someone relies
 * on. It is the wrong trade for a chat turn, where a first-stage ordering is
 * already good enough and latency is what the user feels.
 *
 * Keyed on the mission the host already classified, so no new signal has to be
 * threaded through the runner, and an explicit `mode` argument still wins.
 */
export function isEvidenceShapedMissionV1(context: ToolExecutionContext): boolean {
  const mode = context.missionIntent?.mode;
  return (
    mode === "note_output" ||
    mode === "vault_context_answer" ||
    mode === "explicit_file_mutation"
  );
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

    const caps = resolveSemanticSearchCapsForCompoundRun({
      autonomyProfile:
        context.settings.autonomyProfile === "conservative" ||
        context.settings.autonomyProfile === "custom"
          ? (context.settings.autonomyProfile as AutonomyProfile)
          : "automatic",
      compoundLifecycleDetected:
        context.runFlags?.compoundLifecycleDetected === true,
      semanticSearchEnabled: context.settings.semanticSearchEnabled,
    });
    const limit = clampInteger(
      getOptionalInteger(args, "limit") ?? caps.defaultLimit,
      1,
      caps.maxLimit,
    );
    const maxSnippetChars = clampInteger(
      getOptionalInteger(args, "maxSnippetChars") ?? caps.defaultSnippetChars,
      80,
      caps.maxSnippetChars,
    );
    const folder = normalizeOptionalFolder(getOptionalString(args, "folder"));
    const modeArg = getOptionalString(args, "mode");
    const mode =
      modeArg === "deep" || modeArg === "standard"
        ? modeArg
        : caps.preferDeepMode || isEvidenceShapedMissionV1(context)
          ? "deep"
          : "standard";
    const candidateLimit = clampInteger(
      getOptionalInteger(args, "candidateLimit") ??
        (mode === "deep"
          ? Math.max(caps.deepCandidateFloor, limit * 8)
          : limit * 4),
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
    if (indexed.kind === "indexed") {
      return indexed.payload;
    }
    if (indexed.kind === "closed") {
      return searchVaultBm25Fallback({
        context,
        query,
        limit,
        folder,
        maxSnippetChars,
        minScore,
        cursor,
        chunking,
        fallbackReason: indexed.code,
      });
    }

    const chunks = await buildSemanticChunkProfiles(context, folder, chunking);
    const queryTerms = tokenizeConceptText(query);
    let fallbackUsed = !context.semanticEmbeddingProvider;
    let fallbackReason = context.semanticEmbeddingProvider
      ? null
      : "semantic_embedding_provider_unavailable";
    let scored: ScoredChunk[] = [];

    if (context.semanticEmbeddingProvider && chunks.length > 0) {
      const embedded = await embedLiveChunks({
        context,
        query,
        documents: chunks.map((chunk) => chunk.embeddingText),
      });
      if (embedded.ok) {
        scored = scoreSemanticChunks({
          chunks,
          queryVector: embedded.queryVector,
          documentVectors: embedded.documentVectors,
          queryTerms,
        });
      } else {
        fallbackUsed = true;
        fallbackReason = embedded.code;
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
        signal: context.abortSignal,
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

type IndexFirstResult =
  | { kind: "indexed"; payload: Record<string, unknown> }
  | { kind: "closed"; code: string }
  | { kind: "skip" };

const INDEX_CLOSED_CODES = new Set(["stale_index_majority", "missing_index"]);

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
}): Promise<IndexFirstResult> {
  if (!context.settings.semanticIndexEnabled || !context.semanticIndexService) {
    return { kind: "skip" };
  }

  // Seed the graph prior with the note the user is working in, so notes the
  // author already linked into this neighbourhood break ties among comparably
  // relevant hits. With no active note the prior is empty and scoring is
  // unchanged.
  const activePath = context.app?.workspace?.getActiveFile?.()?.path;

  const search = await context.semanticIndexService.search({
    query,
    limit,
    folder,
    signal: context.abortSignal,
    maxSnippetChars,
    mode,
    candidateLimit,
    minScore,
    cursor,
    ...(activePath ? { seedPaths: [activePath] } : {}),
  });

  if (!search.ok) {
    if (search.code && INDEX_CLOSED_CODES.has(search.code)) {
      return { kind: "closed", code: search.code };
    }
    return { kind: "skip" };
  }

  return {
    kind: "indexed",
    payload: {
    operation: "semantic_search_notes",
    mode: "indexed_semantic",
    indexUsed: true,
    indexFresh: search.indexFresh,
    ...(search.stale ? { stale: search.stale } : {}),
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
      // Editing a note used to fail the whole indexed search and route the
      // tool to the 300-note live path; now drifted notes are excluded (or
      // re-embedded live) and the coverage record says exactly which.
      reasons: [
        ...(search.stale
          ? [
              "persisted_semantic_index_with_stale_notes",
              `changed_notes_excluded:${search.stale.changedCount - search.stale.liveMergedPaths.length}`,
              `changed_notes_live_merged:${search.stale.liveMergedPaths.length}`,
              `missing_notes_excluded:${search.stale.missingCount}`,
              `unindexed_notes:${search.stale.unindexedCount}`,
            ]
          : ["fresh_persisted_semantic_index"]),
        // A ranking that was asked for a cross-encoder pass and did not get
        // one looks exactly like a first-stage ranking. Saying so here is what
        // keeps a reader from trusting an accuracy stage that never ran.
        ...(search.rerankReason ? [search.rerankReason] : []),
      ],
    }),
    // Where this search's wall clock actually went. The tool metric records a
    // single duration; only this split says whether it was shard decode or
    // scoring, which is what decides whether optimising the scan is worth
    // building. Absent on the in-memory v1 index, which has no decode step.
    ...(search.timings ? { timings: search.timings } : {}),
    },
  };
}

/**
 * Real BM25 over the excluded-filtered vault. Used when the semantic index is
 * missing or majority-stale so we never advertise hybrid/semantic over a
 * 300-note live sample.
 */
async function searchVaultBm25Fallback({
  context,
  query,
  limit,
  folder,
  maxSnippetChars,
  minScore,
  cursor,
  chunking,
  fallbackReason,
}: {
  context: ToolExecutionContext;
  query: string;
  limit: number;
  folder: string | null;
  maxSnippetChars: number;
  minScore?: number;
  cursor: string | null;
  chunking: SemanticChunkingOptions;
  fallbackReason: string;
}) {
  const queryTerms = tokenizeConceptText(query);
  const chunks = await buildSemanticChunkProfiles(context, folder, chunking, {
    cap: Number.POSITIVE_INFINITY,
  });
  const scored = scoreLexicalChunks(chunks, queryTerms);
  const collapsed = collapseChunksToNotes(scored, queryTerms, maxSnippetChars).filter(
    (result) => minScore === undefined || result.score >= minScore,
  );
  const offset = parseCursorOffset(cursor);
  const results = collapsed.slice(offset, offset + limit);
  const nextCursor =
    offset + results.length < collapsed.length ? String(offset + results.length) : null;
  return {
    operation: "semantic_search_notes",
    mode: "lexical_fallback",
    indexUsed: false,
    indexFresh: false,
    model: getSemanticModel(context),
    dim: getSemanticDim(context),
    chunking,
    fallbackUsed: true,
    fallbackReason,
    candidateLimit: chunks.length,
    nextCursor,
    resultCount: results.length,
    results,
    coverage: buildRetrievalCoverage({
      mode: "fallback",
      considered: chunks.length,
      read: results.length,
      skipped: Math.max(0, chunks.length - results.length),
      truncated: nextCursor !== null,
      fallbackUsed: true,
      reasons: [fallbackReason, "bm25_full_vault_fallback"],
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
  options: { cap?: number } = {},
): Promise<SemanticChunkProfile[]> {
  const cap = options.cap ?? MAX_LISTED_FILES;
  const files = context.app.vault
    .getFiles()
    .filter((file) => file.extension === "md")
    .filter((file) => !isVaultPathExcluded(file.path))
    .filter((file) => isFileInFolder(file.path, folder))
    .slice(0, Number.isFinite(cap) ? cap : undefined);
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
  const terms = [...queryTerms];
  const scored = scoreHybridCandidatesV1(
    chunks.map((chunk, index) => ({
      cosine: normalizeCosine(cosineSimilarity(queryVector, documentVectors[index])),
      lexicalText: hybridLexicalText(chunk),
    })),
    terms,
  );
  return chunks
    .map((chunk, index) => {
      const hybrid = scored[index]!;
      return {
        chunk,
        score: hybrid.score,
        semanticScore: hybrid.semanticScore,
        lexicalScore: hybrid.lexicalScore,
        reasons: dedupeStrings(hybrid.reasons),
      };
    })
    .filter((item) => item.semanticScore > 0.1 || item.lexicalScore > 0)
    .sort(compareScoredChunks);
}

function scoreLexicalChunks(
  chunks: SemanticChunkProfile[],
  queryTerms: Set<string>,
): ScoredChunk[] {
  const terms = [...queryTerms];
  if (terms.length === 0 || chunks.length === 0) {
    return [];
  }
  const documents = chunks.map((chunk) =>
    buildLexicalDocumentTermStatsV1(hybridLexicalText(chunk).toLowerCase(), terms),
  );
  const corpus = buildLexicalCorpusStatsV1(documents);
  return chunks
    .map((chunk, index) => {
      const lexicalScore = bm25ContentScoreV1(documents[index]!, corpus);
      return {
        chunk,
        score: lexicalScore,
        semanticScore: 0,
        lexicalScore,
        reasons: lexicalScore > 0 ? ["bm25_content"] : [],
      };
    })
    .filter((item) => item.lexicalScore > 0)
    .sort(compareScoredChunks);
}

function hybridLexicalText(chunk: SemanticChunkProfile): string {
  return [chunk.title, chunk.heading ?? "", chunk.tags.join(" "), chunk.text]
    .filter(Boolean)
    .join("\n");
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

/**
 * The live path used to send every chunk of up to 300 notes in ONE request:
 * exactly the shape that produced `output_too_large` and 180 s helper
 * timeouts, and which the index path already avoided with bounded batches.
 * Documents now go in batches of `LIVE_EMBED_BATCH_SIZE`, the query in its
 * own request, all marked interactive so a rebuild in progress cannot delay
 * them. A stopped run falls through to lexical scoring instead of waiting
 * out the helper (which cannot cancel an in-flight request).
 */
export const LIVE_EMBED_BATCH_SIZE = 64;

async function embedLiveChunks({
  context,
  query,
  documents,
}: {
  context: ToolExecutionContext;
  query: string;
  documents: string[];
}): Promise<
  | { ok: true; queryVector: number[]; documentVectors: number[][] }
  | { ok: false; code: string }
> {
  const provider = context.semanticEmbeddingProvider;
  if (!provider) {
    return { ok: false, code: "semantic_embedding_provider_unavailable" };
  }
  const model = getSemanticModel(context);
  const dim = getSemanticDim(context);
  const matryoshka = getSemanticMatryoshka(context);
  const prefixes = resolveEmbeddingPrefixesV1(model);
  const send = (input: { documents: string[]; queries: string[] }) =>
    raceAbort(
      provider.embed({
        model,
        dim,
        matryoshka,
        cacheDir: context.settings.semanticModelCacheDir || undefined,
        documents: input.documents,
        queries: input.queries,
        queryPrefix: prefixes.query,
        documentPrefix: prefixes.document,
        signal: context.abortSignal,
        priority: "interactive",
      }),
      context.abortSignal,
    ).catch((error: unknown): SemanticEmbeddingResponse => {
      if (context.abortSignal?.aborted) {
        return {
          ok: false,
          model,
          dim,
          code: "aborted",
          message: "The run was stopped before the embedding helper answered.",
        };
      }
      throw error;
    });

  const queryResponse = await send({ documents: [], queries: [query] });
  if (!queryResponse.ok || queryResponse.queries?.length !== 1) {
    return { ok: false, code: queryResponse.code ?? "semantic_embedding_failed" };
  }
  const documentVectors: number[][] = [];
  for (let start = 0; start < documents.length; start += LIVE_EMBED_BATCH_SIZE) {
    const batch = documents.slice(start, start + LIVE_EMBED_BATCH_SIZE);
    const response = await send({ documents: batch, queries: [] });
    if (!response.ok || response.documents?.length !== batch.length) {
      return { ok: false, code: response.code ?? "semantic_embedding_failed" };
    }
    documentVectors.push(...response.documents);
  }
  return { ok: true, queryVector: queryResponse.queries[0], documentVectors };
}

function getSemanticModel(context: ToolExecutionContext): string {
  return (
    context.settings.semanticEmbeddingModel?.trim() ||
    DEFAULT_SEMANTIC_MODEL
  );
}

function getSemanticDim(context: ToolExecutionContext): number {
  return resolveEffectiveEmbeddingDimV1(
    getSemanticModel(context),
    context.settings.semanticEmbeddingDim ?? DEFAULT_SEMANTIC_DIM,
  ).dim;
}

function getSemanticMatryoshka(context: ToolExecutionContext): boolean {
  return resolveEffectiveEmbeddingDimV1(
    getSemanticModel(context),
    context.settings.semanticEmbeddingDim ?? DEFAULT_SEMANTIC_DIM,
  ).matryoshka;
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

function compareScoredChunks(left: ScoredChunk, right: ScoredChunk): number {
  const rrf = right.score - left.score;
  if (rrf !== 0) return rrf;
  const cosineGap = right.semanticScore - left.semanticScore;
  if (Math.abs(cosineGap) > COSINE_TIEBREAK_MARGIN_V1) return cosineGap;
  return (
    right.lexicalScore - left.lexicalScore ||
    cosineGap ||
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
