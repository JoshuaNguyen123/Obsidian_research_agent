import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import {
  assessSemanticIndexStalenessV1,
  clearSemanticManifestReadCache,
  clearSemanticShardReadCache,
  createSemanticIndexService,
  getSemanticIndexFreshness,
  MAX_LIVE_STALE_NOTES_PER_SEARCH,
  MAX_STALE_REPORT_PATHS,
} from "../src/embeddings/semanticIndex";
import type { AgentSettings } from "../src/settings";
import type {
  SemanticEmbeddingProvider,
  SemanticEmbeddingRequest,
} from "../src/embeddings/types";

/*
 * One edited note used to make the whole semantic index "stale": search()
 * returned !ok, and semantic_search_notes silently fell through to the live
 * path, which caps at 300 notes and embeds every chunk in one request. Since
 * the user is always editing a note during a mission (and the agent appends
 * to one), the index was effectively unusable mid-run. Staleness is now
 * per-note: drifted notes are excluded, a handful are embedded live and
 * merged, and the result says which.
 */

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
} as unknown as AgentSettings;

interface FakeFile {
  path: string;
  basename: string;
  extension: string;
  stat: { mtime: number; size: number; ctime: number };
  content: string;
}

class FakeVault {
  files = new Map<string, FakeFile>();
  folders = new Set<string>();
  private clock = 1000;

  put(path: string, content: string): FakeFile {
    const existing = this.files.get(path);
    this.clock += 1;
    const file: FakeFile = {
      path,
      basename: path.split("/").pop()?.replace(/\.[^.]+$/u, "") ?? path,
      extension: path.split(".").pop() ?? "",
      stat: { mtime: this.clock, size: content.length, ctime: existing?.stat.ctime ?? this.clock },
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
  async cachedRead(file: FakeFile) {
    return this.files.get(file.path)?.content ?? file.content;
  }
  async read(file: FakeFile) {
    return this.cachedRead(file);
  }
  async create(path: string, content: string) {
    return this.put(path, content);
  }
  async modify(file: FakeFile, content: string) {
    this.put(file.path, content);
  }
  async createFolder(path: string) {
    this.folders.add(path);
  }
  async delete(file: FakeFile) {
    this.files.delete(file.path);
  }
}

/**
 * Deterministic "embeddings": a bag over four topic words padded to the
 * smallest width the dimension setting accepts, so a query about one topic
 * lands on the notes about it. Good enough to prove routing and merging;
 * retrieval quality has its own fixture.
 */
const TOPICS = ["orchard", "harbour", "glacier", "library"];
const FAKE_DIM = 32;
function vectorFor(text: string): number[] {
  const lower = text.toLowerCase();
  const raw = TOPICS.map((topic) => (lower.includes(topic) ? 1 : 0.05));
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return [...raw.map((value) => value / norm), ...new Array(FAKE_DIM - TOPICS.length).fill(0)];
}

function createProvider(): { provider: SemanticEmbeddingProvider; requests: SemanticEmbeddingRequest[] } {
  const requests: SemanticEmbeddingRequest[] = [];
  const provider: SemanticEmbeddingProvider = {
    id: "fake-bag-embedder",
    async embed(request) {
      requests.push(request);
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map(vectorFor),
        queries: request.queries.map(vectorFor),
      };
    },
  };
  return { provider, requests };
}

function noteBody(topic: string, extra = ""): string {
  return `# ${topic} note\n\nThe ${topic} ${topic} ${topic} is described here in some detail. ${extra}\n`;
}

async function buildFixture() {
  clearSemanticManifestReadCache();
  clearSemanticShardReadCache();
  const vault = new FakeVault();
  vault.put("Notes/orchard.md", noteBody("orchard"));
  vault.put("Notes/harbour.md", noteBody("harbour"));
  vault.put("Notes/glacier.md", noteBody("glacier"));
  vault.put("Notes/library.md", noteBody("library"));
  const app = { vault } as unknown as App;
  const { provider, requests } = createProvider();
  const service = createSemanticIndexService({
    app,
    getSettings: () => SETTINGS,
    getEmbeddingProvider: () => provider,
    now: () => new Date("2026-09-03T00:00:00Z"),
  });
  const built = await service.rebuild();
  assert.ok(built.ok, built.message);
  return { vault, app, provider, requests, service };
}

test("a fresh index searches normally and reports itself fresh", async () => {
  const { service } = await buildFixture();
  const result = await service.search({ query: "tell me about the harbour", limit: 3 });
  assert.equal(result.ok, true, `${result.code}: ${result.message}`);
  assert.equal(result.indexFresh, true);
  assert.equal(result.stale, undefined);
  assert.equal(result.results[0]?.path, "Notes/harbour.md");
});

test("editing one note no longer fails the whole search; the note is re-embedded live and still found", async () => {
  const { vault, service, requests } = await buildFixture();
  // The user edits the harbour note (mtime and size change) before the
  // debounced reindex has run.
  vault.put("Notes/harbour.md", noteBody("harbour", "Now with an extra sentence about boats."));
  const before = requests.length;

  const result = await service.search({ query: "tell me about the harbour", limit: 3 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.indexFresh, false);
  assert.deepEqual(result.stale?.changedPaths, ["Notes/harbour.md"]);
  assert.deepEqual(result.stale?.missingPaths, []);
  assert.deepEqual(result.stale?.liveMergedPaths, ["Notes/harbour.md"]);
  // Still the top hit, from the live embedding, not from the stale rows.
  assert.equal(result.results[0]?.path, "Notes/harbour.md");
  assert.ok(result.results[0]?.reasons.includes("live_reembedded_changed_note"));
  // Exactly one query embed plus one document embed for the changed note.
  const newRequests = requests.slice(before);
  assert.equal(newRequests.filter((request) => request.documents.length > 0).length, 1);
});

test("a deleted note is excluded and named, and the other notes still rank", async () => {
  const { vault, service } = await buildFixture();
  vault.files.delete("Notes/glacier.md");

  const result = await service.search({ query: "glacier ice", limit: 4 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.indexFresh, false);
  assert.deepEqual(result.stale?.missingPaths, ["Notes/glacier.md"]);
  assert.ok(!result.results.some((hit) => hit.path === "Notes/glacier.md"));
  assert.ok(result.results.length > 0);
});

test("stale notes beyond the live-merge cap are excluded rather than embedded", async () => {
  const { vault, service, requests } = await buildFixture();
  for (const topic of ["orchard", "harbour", "glacier", "library"]) {
    vault.put(`Notes/${topic}.md`, noteBody(topic, "edited"));
  }
  assert.ok(4 > MAX_LIVE_STALE_NOTES_PER_SEARCH);
  const before = requests.length;
  const result = await service.search({ query: "orchard apples", limit: 4 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.indexFresh, false);
  assert.equal(result.stale?.changedPaths.length, 4);
  assert.deepEqual(result.stale?.liveMergedPaths, []);
  assert.equal(result.results.length, 0);
  // Only the query was embedded; no document batch was sent.
  assert.equal(requests.slice(before).filter((request) => request.documents.length > 0).length, 0);
});

test("a majority-stale index still fails closed so the tool takes the live path", async () => {
  const { vault, app, service } = await buildFixture();
  // Fewer notes than the absolute floor cannot trip the majority rule...
  vault.put("Notes/orchard.md", noteBody("orchard", "edited"));
  const small = await service.search({ query: "orchard", limit: 2, maxLiveStaleNotes: 0 });
  assert.equal(small.ok, true);
  // ...but the freshness verdict other callers read is still "not fresh".
  const index = await service.load();
  assert.ok(index);
  assert.equal(getSemanticIndexFreshness(app, SETTINGS, index, "fake-bag-embedder").fresh, false);
  const staleness = assessSemanticIndexStalenessV1(app, SETTINGS, index, "fake-bag-embedder");
  assert.deepEqual(staleness.changedPaths, ["Notes/orchard.md"]);
  assert.equal(staleness.incompatibleReason, null);
});

test("a provider change is incompatible, never a partial search", async () => {
  const { app, service } = await buildFixture();
  const index = await service.load();
  assert.ok(index);
  const staleness = assessSemanticIndexStalenessV1(app, SETTINGS, index, "some-other-provider");
  assert.equal(staleness.incompatibleReason, "settings_changed");
});

test("the manifest is parsed once per file version, not once per search", async () => {
  const { vault, service } = await buildFixture();
  const manifest = vault.files.get("Agent Memory/semantic-vault-index.json");
  assert.ok(manifest);
  let reads = 0;
  const originalCachedRead = vault.cachedRead.bind(vault);
  vault.cachedRead = async (file: FakeFile) => {
    if (file.path === manifest.path) reads += 1;
    return originalCachedRead(file);
  };
  await service.search({ query: "library", limit: 2 });
  await service.search({ query: "orchard", limit: 2 });
  await service.search({ query: "glacier", limit: 2 });
  assert.equal(reads, 1, "one parse for the first search; the next two reuse it");
});

test("a stale report names a bounded number of paths but counts every one", async () => {
  // A vault past the index's file ceiling, or a big import before the next
  // reindex, must not push thousands of paths into every search result.
  const { vault, service } = await buildFixture();
  for (let index = 0; index < MAX_STALE_REPORT_PATHS + 30; index += 1) {
    vault.put(`Imported/new-${index}.md`, noteBody("orchard", `import ${index}`));
  }
  const result = await service.search({ query: "orchard apples", limit: 3 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.indexFresh, false);
  assert.equal(result.stale?.unindexedCount, MAX_STALE_REPORT_PATHS + 30);
  assert.equal(result.stale?.unindexedPaths.length, MAX_STALE_REPORT_PATHS);
  assert.equal(result.stale?.changedCount, 0);
  // Indexed notes still rank; the unindexed ones simply are not there yet.
  assert.equal(result.results[0]?.path, "Notes/orchard.md");
});
