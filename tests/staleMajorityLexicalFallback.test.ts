import assert from "node:assert/strict";
import test from "node:test";
import { semanticSearchNotesTool } from "../src/tools/semanticSearchTools";
import type { ToolExecutionContext } from "../src/tools/types";
import type {
  SemanticEmbeddingProvider,
  SemanticEmbeddingRequest,
} from "../src/embeddings/types";

/*
 * Metric C.
 *
 * On old main, a majority-stale or missing index made searchSemanticIndexFirst
 * return null. semantic_search_notes then embedded the first 300 notes and
 * returned mode:"hybrid_semantic" with coverage.mode:"sampled" — an unsorted
 * sample advertised as semantic search. After this change those codes fail
 * closed into real BM25 (mode:"lexical_fallback", coverage.mode:"fallback").
 *
 * stale_majority_reports_sampled_semantic is 1 on old main and 0 here.
 */

const DIM = 8;

function fakeEmbedder(): SemanticEmbeddingProvider {
  return {
    id: "flat-live-embedder",
    async embed(request: SemanticEmbeddingRequest) {
      const vector = Array.from({ length: request.dim }, () => 0.1);
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map(() => vector),
        queries: request.queries.map(() => vector),
      };
    },
  };
}

function contextWithClosedIndex(code: "stale_index_majority" | "missing_index"): ToolExecutionContext {
  const notes = Array.from({ length: 12 }, (_unused, index) => ({
    path: `Notes/note-${String(index).padStart(2, "0")}.md`,
    body: `# note ${index}\n\nThe orchard harvest is recorded in note ${index}.`,
  }));
  const files = notes.map((note) => ({
    path: note.path,
    basename: note.path.replace(/^.*\//u, "").replace(/\.md$/u, ""),
    extension: "md",
    stat: { mtime: 1_000, size: note.body.length },
  }));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const bodies = new Map(notes.map((note) => [note.path, note.body]));

  return {
    app: {
      vault: {
        getFiles: () => files,
        getFileByPath: (path: string) => byPath.get(path) ?? null,
        cachedRead: async (file: { path: string }) => bodies.get(file.path) ?? "",
        read: async (file: { path: string }) => bodies.get(file.path) ?? "",
      },
      workspace: { getActiveFile: () => null },
    },
    runtimeCache: {},
    settings: {
      semanticIndexEnabled: true,
      semanticSearchEnabled: true,
      semanticEmbeddingModel: "jinaai/jina-embeddings-v2-small-en",
      semanticEmbeddingDim: DIM,
      semanticChunkMinTokens: 50,
      semanticChunkTargetTokens: 80,
      semanticChunkMaxTokens: 120,
      semanticChunkOverlapTokens: 8,
      autonomyProfile: "automatic",
    },
    semanticEmbeddingProvider: fakeEmbedder(),
    semanticIndexService: {
      search: async () => ({
        ok: false,
        code,
        message: `${code} for test`,
        indexFresh: false,
        results: [],
      }),
    },
  } as unknown as ToolExecutionContext;
}

function sampledSemanticFlag(payload: {
  mode?: string;
  coverage?: { mode?: string };
}): number {
  const mode = payload.mode ?? "";
  const coverageMode = payload.coverage?.mode ?? "";
  const advertisesSemantic = /semantic|hybrid/i.test(mode);
  return coverageMode === "sampled" && advertisesSemantic ? 1 : 0;
}

test("Metric C: majority-stale and missing indexes do not advertise sampled semantic search", async () => {
  const stale = (await semanticSearchNotesTool.execute(
    { query: "orchard harvest", limit: 5 },
    contextWithClosedIndex("stale_index_majority"),
  )) as {
    mode: string;
    fallbackUsed: boolean;
    fallbackReason: string | null;
    coverage: { mode: string };
    results: Array<{ path: string }>;
  };
  const missing = (await semanticSearchNotesTool.execute(
    { query: "orchard harvest", limit: 5 },
    contextWithClosedIndex("missing_index"),
  )) as {
    mode: string;
    fallbackUsed: boolean;
    coverage: { mode: string };
  };

  const staleMajorityReportsSampledSemantic = sampledSemanticFlag(stale);
  assert.equal(
    staleMajorityReportsSampledSemantic,
    0,
    `stale_majority_reports_sampled_semantic must be 0, got mode=${stale.mode} coverage=${stale.coverage.mode}`,
  );
  assert.equal(stale.mode, "lexical_fallback");
  assert.equal(stale.coverage.mode, "fallback");
  assert.equal(stale.fallbackUsed, true);
  assert.equal(stale.fallbackReason, "stale_index_majority");
  assert.ok(stale.results.length > 0, "BM25 fallback must still return current notes");

  assert.equal(sampledSemanticFlag(missing), 0);
  assert.equal(missing.mode, "lexical_fallback");
  assert.equal(missing.coverage.mode, "fallback");
});
