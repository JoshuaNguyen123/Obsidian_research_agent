import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import {
  blendRerankScoreV1,
  DEFAULT_SEMANTIC_RERANK_MODEL,
  DEFAULT_SEMANTIC_RERANK_TOP_K,
  MAX_SEMANTIC_RERANK_TOP_K,
  normalizeSemanticRerankTopKV1,
  rerankSemanticHitsV1,
  resolveSemanticRerankSettingsV1,
  SEMANTIC_RERANK_MODEL_CATALOG_V1,
} from "../src/embeddings/semanticRerank";
import {
  clearSemanticManifestReadCache,
  clearSemanticShardReadCache,
  createSemanticIndexService,
} from "../src/embeddings/semanticIndex";
import type { AgentSettings } from "../src/settings";
import type {
  SemanticEmbeddingProvider,
  SemanticRerankRequest,
} from "../src/embeddings/types";

/*
 * Two-stage retrieval. The bi-encoder index says which chunks are in the
 * neighbourhood; a cross-encoder reads query and chunk together and says which
 * one actually answers. The stage is optional and best-effort by contract:
 * every way it can be unavailable has to leave the first-stage ranking intact
 * and say why, because a search that fails when its accuracy stage is missing
 * is worse than one that never had the stage.
 */

interface Hit {
  path: string;
  score: number;
  reasons: string[];
  rerankScore?: number;
  text: string | null;
}

function hit(path: string, score: number, text: string | null = `text for ${path}`): Hit {
  return { path, score, reasons: ["indexed_semantic_similarity"], text };
}

function rerankerReturning(
  scoresFor: (documents: string[]) => number[] | null,
  seen?: SemanticRerankRequest[],
): SemanticEmbeddingProvider {
  return {
    id: "fake",
    async embed() {
      throw new Error("not used");
    },
    async rerank(request) {
      seen?.push(request);
      const scores = scoresFor(request.documents);
      return scores
        ? { ok: true, model: request.model, scores }
        : { ok: false, model: request.model, code: "missing_reranker" };
    },
  };
}

test("top-k normalizes to a bounded positive integer", () => {
  assert.equal(normalizeSemanticRerankTopKV1(undefined), DEFAULT_SEMANTIC_RERANK_TOP_K);
  assert.equal(normalizeSemanticRerankTopKV1("banana"), DEFAULT_SEMANTIC_RERANK_TOP_K);
  assert.equal(normalizeSemanticRerankTopKV1(0), 1);
  assert.equal(normalizeSemanticRerankTopKV1(-4), 1);
  assert.equal(normalizeSemanticRerankTopKV1(7.9), 7);
  assert.equal(normalizeSemanticRerankTopKV1("12"), 12);
  // The cap exists because every candidate is a forward pass of a transformer
  // on this user's CPU: an unbounded setting is an unbounded search.
  assert.equal(normalizeSemanticRerankTopKV1(5000), MAX_SEMANTIC_RERANK_TOP_K);
});

test("the stage is off unless it was explicitly chosen", () => {
  assert.deepEqual(resolveSemanticRerankSettingsV1({}), {
    enabled: false,
    model: DEFAULT_SEMANTIC_RERANK_MODEL,
    topK: DEFAULT_SEMANTIC_RERANK_TOP_K,
  });
  assert.equal(
    resolveSemanticRerankSettingsV1({ semanticRerankMode: "cross_encoder" }).enabled,
    true,
  );
  assert.equal(
    resolveSemanticRerankSettingsV1({
      semanticRerankMode: "cross_encoder",
      semanticRerankModel: "  ",
    }).model,
    DEFAULT_SEMANTIC_RERANK_MODEL,
  );
});

test("research mode spends the cross-encoder on deep searches and nothing else", () => {
  // The shipped default. A reflex intent check and a background index probe
  // must not each pay a second of CPU; the search a mission runs to decide
  // what to cite must.
  const settings = { semanticRerankMode: "research" } as const;
  assert.equal(resolveSemanticRerankSettingsV1(settings, { deepSearch: true }).enabled, true);
  assert.equal(resolveSemanticRerankSettingsV1(settings, { deepSearch: false }).enabled, false);
  // No opinion supplied is not a deep search: the caller has to say so.
  assert.equal(resolveSemanticRerankSettingsV1(settings).enabled, false);

  // The unconditional ends of the range ignore the search entirely.
  for (const deepSearch of [true, false]) {
    assert.equal(
      resolveSemanticRerankSettingsV1({ semanticRerankMode: "cross_encoder" }, { deepSearch })
        .enabled,
      true,
    );
    assert.equal(
      resolveSemanticRerankSettingsV1({ semanticRerankMode: "off" }, { deepSearch }).enabled,
      false,
    );
  }
});

test("every catalogued reranker carries the numbers a user needs to choose", () => {
  assert.ok(SEMANTIC_RERANK_MODEL_CATALOG_V1.length >= 5);
  for (const spec of SEMANTIC_RERANK_MODEL_CATALOG_V1) {
    assert.ok(spec.id.includes("/"), spec.id);
    assert.ok(spec.pairsPerSecond > 0, spec.id);
    assert.ok(spec.sizeMb > 0, spec.id);
    assert.ok(spec.maxTokens >= 512, spec.id);
    assert.ok(spec.summary.length > 20, spec.id);
  }
  for (const spec of SEMANTIC_RERANK_MODEL_CATALOG_V1) {
    assert.ok(spec.measured.paraphraseMrr > 0.6, spec.id);
    assert.ok(spec.measured.searchMs > 0, spec.id);
  }
  // The default is chosen by measurement, not by size or speed: the most
  // accurate model that still keeps a search under three seconds. Ranking by
  // download size would pick the 1 GB model, which is both the slowest and not
  // the most accurate.
  const usable = SEMANTIC_RERANK_MODEL_CATALOG_V1.filter(
    (spec) => spec.measured.searchMs < 3000,
  );
  const best = [...usable].sort(
    (left, right) => right.measured.paraphraseMrr - left.measured.paraphraseMrr,
  )[0];
  assert.equal(best.id, DEFAULT_SEMANTIC_RERANK_MODEL);
});

test("a cross-encoder promotes the chunk that answers over the one that merely matches words", async () => {
  const seen: SemanticRerankRequest[] = [];
  const hits = [hit("Notes/vocabulary-match.md", 0.81), hit("Notes/real-answer.md", 0.74)];
  const provider = rerankerReturning(
    (documents) => documents.map((doc) => (doc.includes("real-answer") ? 4 : -4)),
    seen,
  );

  const outcome = await rerankSemanticHitsV1({
    hits,
    query: "what actually answers this",
    textFor: (item) => item.text,
    provider,
    model: DEFAULT_SEMANTIC_RERANK_MODEL,
    topK: 10,
  });

  assert.equal(outcome.applied, true);
  assert.equal(outcome.reason, "cross_encoder_reranked");
  assert.equal(outcome.candidateCount, 2);
  assert.equal(outcome.hits[0]?.path, "Notes/real-answer.md");
  assert.ok(outcome.hits[0].reasons.includes("cross_encoder_reranked"));
  assert.ok((outcome.hits[0].rerankScore ?? 0) > 0.9);
  // Reordering, not filtering: the demoted hit is still there.
  assert.equal(outcome.hits.length, 2);
  assert.equal(outcome.hits[1]?.path, "Notes/vocabulary-match.md");
  assert.ok((outcome.hits[1].score ?? 1) > 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.documents.length, 2);
});

test("only the head is rescored; the tail keeps its order behind it", async () => {
  const hits = [hit("a.md", 0.9), hit("b.md", 0.8), hit("c.md", 0.7), hit("d.md", 0.6)];
  const provider = rerankerReturning((documents) =>
    documents.map((doc) => (doc.includes("b.md") ? 5 : -5)),
  );

  const outcome = await rerankSemanticHitsV1({
    hits,
    query: "q",
    textFor: (item) => item.text,
    provider,
    model: DEFAULT_SEMANTIC_RERANK_MODEL,
    topK: 2,
  });

  assert.equal(outcome.applied, true);
  assert.deepEqual(
    outcome.hits.map((item) => item.path),
    ["b.md", "a.md", "c.md", "d.md"],
  );
  // Untouched hits carry no rerank score, so a reader can tell which ranking
  // each result came from.
  assert.equal(outcome.hits[2]?.rerankScore, undefined);
});

test("a provider with no reranker leaves the ranking exactly as it was", async () => {
  const hits = [hit("a.md", 0.9), hit("b.md", 0.8)];
  const provider: SemanticEmbeddingProvider = {
    id: "no-rerank",
    async embed() {
      throw new Error("not used");
    },
  };

  const outcome = await rerankSemanticHitsV1({
    hits,
    query: "q",
    textFor: (item) => item.text,
    provider,
    model: DEFAULT_SEMANTIC_RERANK_MODEL,
    topK: 10,
  });

  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "rerank_unavailable:provider_has_no_reranker");
  assert.deepEqual(
    outcome.hits.map((item) => item.score),
    [0.9, 0.8],
  );
  assert.equal(outcome.hits[0]?.reasons.includes("cross_encoder_reranked"), false);
});

test("a failing reranker names its cause and never fails the ranking", async () => {
  const hits = [hit("a.md", 0.9), hit("b.md", 0.8)];
  const outcome = await rerankSemanticHitsV1({
    hits,
    query: "q",
    textFor: (item) => item.text,
    provider: rerankerReturning(() => null),
    model: DEFAULT_SEMANTIC_RERANK_MODEL,
    topK: 10,
  });
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "rerank_unavailable:missing_reranker");
  assert.deepEqual(
    outcome.hits.map((item) => item.path),
    ["a.md", "b.md"],
  );
});

test("a reranker that returns the wrong number of scores is refused", async () => {
  const outcome = await rerankSemanticHitsV1({
    hits: [hit("a.md", 0.9), hit("b.md", 0.8)],
    query: "q",
    textFor: (item) => item.text,
    provider: rerankerReturning(() => [1]),
    model: DEFAULT_SEMANTIC_RERANK_MODEL,
    topK: 10,
  });
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "rerank_unavailable:rerank_failed");
});

test("a stopped run does not start a rerank pass", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const outcome = await rerankSemanticHitsV1({
    hits: [hit("a.md", 0.9)],
    query: "q",
    textFor: (item) => item.text,
    provider: rerankerReturning(() => {
      called = true;
      return [1];
    }),
    model: DEFAULT_SEMANTIC_RERANK_MODEL,
    topK: 10,
    signal: controller.signal,
  });
  assert.equal(called, false);
  assert.equal(outcome.reason, "rerank_skipped:aborted");
});

test("a hit whose chunk text cannot be recovered keeps its place behind the scored ones", async () => {
  const hits = [hit("gone.md", 0.95, null), hit("kept.md", 0.5)];
  const outcome = await rerankSemanticHitsV1({
    hits,
    query: "q",
    textFor: (item) => item.text,
    provider: rerankerReturning((documents) => documents.map(() => 3)),
    model: DEFAULT_SEMANTIC_RERANK_MODEL,
    topK: 10,
  });
  assert.equal(outcome.applied, true);
  assert.equal(outcome.candidateCount, 1);
  assert.deepEqual(
    outcome.hits.map((item) => item.path),
    ["kept.md", "gone.md"],
  );
});

test("the blend keeps a quarter of the first-stage score so one reranker mistake cannot bury a hit", () => {
  // A confident rejection still leaves a positive score derived from the
  // retrieval stage; a confident acceptance cannot exceed 1.
  const buried = blendRerankScoreV1(-8, 0.9);
  assert.ok(buried > 0.2 && buried < 0.3, String(buried));
  const promoted = blendRerankScoreV1(8, 0.1);
  assert.ok(promoted > 0.7 && promoted <= 1, String(promoted));
  // Monotone in both inputs.
  assert.ok(blendRerankScoreV1(1, 0.5) > blendRerankScoreV1(0, 0.5));
  assert.ok(blendRerankScoreV1(0, 0.6) > blendRerankScoreV1(0, 0.5));
});

/* ------------------------------------------------------------------ *
 * Through the real index: the stage has to receive the whole chunk.   *
 * ------------------------------------------------------------------ */

const SETTINGS = {
  semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
  semanticEmbeddingDim: 32,
  semanticChunkMinTokens: 8,
  semanticChunkTargetTokens: 16,
  semanticChunkMaxTokens: 32,
  semanticChunkOverlapTokens: 2,
  semanticModelCacheDir: "",
  semanticIndexEnabled: true,
  semanticIndexFolder: "Agent Memory",
  semanticIndexMaxFiles: 1000,
  semanticIndexPersistVectors: true,
  semanticIndexDebounceMs: 3000,
  semanticRerankMode: "cross_encoder",
  semanticRerankModel: DEFAULT_SEMANTIC_RERANK_MODEL,
  semanticRerankTopK: 10,
} as unknown as AgentSettings;

class FakeVault {
  files = new Map<
    string,
    {
      path: string;
      basename: string;
      extension: string;
      stat: { mtime: number; size: number; ctime: number };
      content: string;
    }
  >();
  folders = new Set<string>();
  private clock = 1000;

  put(path: string, content: string) {
    this.clock += 1;
    const file = {
      path,
      basename: path.split("/").pop()?.replace(/\.[^.]+$/u, "") ?? path,
      extension: path.split(".").pop() ?? "",
      stat: { mtime: this.clock, size: content.length, ctime: this.clock },
      content,
    };
    this.files.set(path, file);
    return file;
  }
  getFileByPath(path: string) {
    return this.files.get(path) ?? null;
  }
  getAbstractFileByPath(path: string) {
    if (this.files.has(path)) return this.files.get(path)!;
    if (this.folders.has(path)) return { path, children: [] };
    return null;
  }
  getFolderByPath(path: string) {
    return this.folders.has(path) ? { path, children: [] } : null;
  }
  getFiles() {
    return [...this.files.values()];
  }
  getMarkdownFiles() {
    return [...this.files.values()].filter((file) => file.extension === "md");
  }
  async cachedRead(file: { path: string; content: string }) {
    return this.files.get(file.path)?.content ?? file.content;
  }
  async read(file: { path: string; content: string }) {
    return this.cachedRead(file);
  }
  async create(path: string, content: string) {
    return this.put(path, content);
  }
  async modify(file: { path: string }, content: string) {
    this.put(file.path, content);
  }
  async createFolder(path: string) {
    this.folders.add(path);
  }
  async delete(file: { path: string }) {
    this.files.delete(file.path);
  }
}

const TOPICS = ["orchard", "harbour", "glacier", "library"];
function vectorFor(text: string): number[] {
  const lower = text.toLowerCase();
  const raw = TOPICS.map((topic) => (lower.includes(topic) ? 1 : 0.05));
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return [...raw.map((value) => value / norm), ...new Array(32 - TOPICS.length).fill(0)];
}

test("an indexed search sends the whole chunk to the reranker and reorders by its verdict", async () => {
  clearSemanticManifestReadCache();
  clearSemanticShardReadCache();
  const vault = new FakeVault();
  // The distinguishing sentence sits past the 360-character snippet the shard
  // stores, which is exactly the case a snippet-only rerank would get wrong.
  const filler = "The orchard is described at length in this note. ".repeat(9);
  vault.put("Notes/orchard-a.md", `# Orchard A\n\n${filler}Nothing conclusive here.\n`);
  vault.put(
    "Notes/orchard-b.md",
    `# Orchard B\n\n${filler}The apples are picked in September.\n`,
  );
  const app = { vault } as unknown as App;
  const rerankRequests: SemanticRerankRequest[] = [];
  const provider: SemanticEmbeddingProvider = {
    id: "fake-bag-embedder",
    async embed(request) {
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map(vectorFor),
        queries: request.queries.map(vectorFor),
      };
    },
    async rerank(request) {
      rerankRequests.push(request);
      return {
        ok: true,
        model: request.model,
        scores: request.documents.map((doc) =>
          doc.includes("picked in September") ? 6 : -6,
        ),
      };
    },
  };
  const service = createSemanticIndexService({
    app,
    getSettings: () => SETTINGS,
    getEmbeddingProvider: () => provider,
    now: () => new Date("2026-09-04T00:00:00Z"),
  });
  assert.ok((await service.rebuild()).ok);

  const result = await service.search({ query: "when are orchard apples picked", limit: 5 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.reranked, true);
  assert.equal(result.rerankReason, "cross_encoder_reranked");
  assert.equal(typeof result.timings?.rerankMs, "number");
  assert.equal(result.results[0]?.path, "Notes/orchard-b.md");
  assert.ok(result.results[0]?.reasons.includes("cross_encoder_reranked"));
  assert.equal(rerankRequests.length, 1);
  // The reranker read the chunk, not the stored 360-character snippet: the
  // deciding sentence is past that boundary and it still arrived.
  assert.ok(
    rerankRequests[0]?.documents.some((doc) => doc.includes("picked in September")),
    "reranker must receive the full chunk text",
  );
});

test("one search can opt out of the configured rerank stage", async () => {
  clearSemanticManifestReadCache();
  clearSemanticShardReadCache();
  const vault = new FakeVault();
  vault.put("Notes/orchard.md", "# Orchard\n\nThe orchard orchard orchard note.\n");
  const app = { vault } as unknown as App;
  let rerankCalls = 0;
  const provider: SemanticEmbeddingProvider = {
    id: "fake-bag-embedder",
    async embed(request) {
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map(vectorFor),
        queries: request.queries.map(vectorFor),
      };
    },
    async rerank(request) {
      rerankCalls += 1;
      return { ok: true, model: request.model, scores: request.documents.map(() => 1) };
    },
  };
  const service = createSemanticIndexService({
    app,
    getSettings: () => SETTINGS,
    getEmbeddingProvider: () => provider,
    now: () => new Date("2026-09-04T00:00:00Z"),
  });
  assert.ok((await service.rebuild()).ok);

  const result = await service.search({ query: "orchard", limit: 3, rerank: false });
  assert.equal(result.ok, true, result.message);
  assert.equal(rerankCalls, 0);
  assert.equal(result.reranked, false);
});
