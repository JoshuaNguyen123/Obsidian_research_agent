import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import {
  clearSemanticManifestReadCache,
  clearSemanticShardReadCache,
  createSemanticIndexService,
} from "../src/embeddings/semanticIndex";
import type { AgentSettings } from "../src/settings";
import type { SemanticEmbeddingProvider } from "../src/embeddings/types";
import { isEvidenceShapedMissionV1 } from "../src/tools/semanticSearchTools";
import type { ToolExecutionContext } from "../src/tools/types";

/*
 * The shipped default spends the cross-encoder on research searches and
 * nothing else. `resolveSemanticRerankSettingsV1` is unit-tested on its own,
 * but the property that matters is whether the mode reaches the search: the
 * request carries `mode: "deep" | "standard"` and the reranker has to be
 * driven from it. These tests run a real index service so a wiring change
 * that stops passing the mode through fails here rather than in a mission.
 */

const BASE = {
  semanticEmbeddingModel: "jinaai/jina-embeddings-v2-small-en",
  semanticEmbeddingDim: 32,
  semanticChunkMinTokens: 8,
  semanticChunkTargetTokens: 24,
  semanticChunkMaxTokens: 48,
  semanticChunkOverlapTokens: 2,
  semanticModelCacheDir: "",
  semanticIndexEnabled: true,
  semanticIndexFolder: "Agent Memory",
  semanticIndexMaxFiles: 1000,
  semanticIndexPersistVectors: true,
  semanticIndexDebounceMs: 3000,
  semanticRerankModel: "jinaai/jina-reranker-v1-turbo-en",
  semanticRerankTopK: 10,
} as unknown as AgentSettings;

interface Stored {
  path: string;
  basename: string;
  extension: string;
  stat: { mtime: number; size: number; ctime: number };
  content: string;
}

class FakeVault {
  files = new Map<string, Stored>();
  folders = new Set<string>();
  private clock = 1000;
  put(path: string, content: string) {
    this.clock += 1;
    const file: Stored = {
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
  async cachedRead(file: Stored) {
    return this.files.get(file.path)?.content ?? file.content;
  }
  async read(file: Stored) {
    return this.cachedRead(file);
  }
  async create(path: string, content: string) {
    return this.put(path, content);
  }
  async modify(file: Stored, content: string) {
    this.put(file.path, content);
  }
  async createFolder(path: string) {
    this.folders.add(path);
  }
  async delete(file: Stored) {
    this.files.delete(file.path);
  }
}

const FLAT_VECTOR = [1, ...new Array(31).fill(0)];

function countingProvider() {
  let rerankCalls = 0;
  const provider: SemanticEmbeddingProvider = {
    id: "counting-embedder",
    async embed(request) {
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map(() => FLAT_VECTOR),
        queries: request.queries.map(() => FLAT_VECTOR),
      };
    },
    async rerank(request) {
      rerankCalls += 1;
      // Reverse the shortlist so an applied rerank is visible in the order.
      return {
        ok: true,
        model: request.model,
        scores: request.documents.map((_, index) => index),
      };
    },
  };
  return { provider, calls: () => rerankCalls };
}

async function serviceWith(mode: "off" | "research" | "cross_encoder") {
  clearSemanticManifestReadCache();
  clearSemanticShardReadCache();
  const vault = new FakeVault();
  for (let index = 0; index < 4; index += 1) {
    vault.put(
      `Notes/topic-${index}.md`,
      `# topic ${index}\n\nThe ledger records entries for week ${index} in the archive.\n`,
    );
  }
  const counting = countingProvider();
  const service = createSemanticIndexService({
    app: { vault } as unknown as App,
    getSettings: () => ({ ...BASE, semanticRerankMode: mode }) as AgentSettings,
    getEmbeddingProvider: () => counting.provider,
    now: () => new Date("2026-09-04T04:00:00Z"),
  });
  assert.equal((await service.rebuild()).ok, true);
  return { service, counting };
}

test("research mode reranks a deep search", async () => {
  const { service, counting } = await serviceWith("research");
  const deep = await service.search({ query: "ledger archive", limit: 3, mode: "deep" });
  assert.equal(deep.ok, true, deep.message);
  assert.equal(counting.calls(), 1, "the deep search must reach the cross-encoder");
  assert.equal(deep.reranked, true);
});

test("research mode leaves an ordinary search first-stage only", async () => {
  const { service, counting } = await serviceWith("research");
  const standard = await service.search({ query: "ledger archive", limit: 3, mode: "standard" });
  assert.equal(standard.ok, true, standard.message);
  assert.equal(counting.calls(), 0, "a standard search must not pay for the cross-encoder");
  assert.equal(standard.reranked, false);

  // A search that states no mode is not a research search.
  const unstated = await service.search({ query: "ledger archive", limit: 3 });
  assert.equal(unstated.ok, true, unstated.message);
  assert.equal(counting.calls(), 0);
});

test("off never reranks and cross_encoder always does, whatever the mode", async () => {
  const off = await serviceWith("off");
  await off.service.search({ query: "ledger archive", limit: 3, mode: "deep" });
  assert.equal(off.counting.calls(), 0, "an explicit off is not overridden by a deep search");

  const always = await serviceWith("cross_encoder");
  await always.service.search({ query: "ledger archive", limit: 3, mode: "standard" });
  assert.equal(always.counting.calls(), 1, "cross_encoder does not wait for a deep search");
});

test("a per-search rerank argument still overrides the mode in both directions", async () => {
  const research = await serviceWith("research");
  await research.service.search({
    query: "ledger archive",
    limit: 3,
    mode: "standard",
    rerank: true,
  });
  assert.equal(research.counting.calls(), 1, "an explicit request wins over the mode");

  const always = await serviceWith("cross_encoder");
  await always.service.search({
    query: "ledger archive",
    limit: 3,
    mode: "deep",
    rerank: false,
  });
  assert.equal(always.counting.calls(), 0, "an explicit refusal wins over the mode");
});

test("only missions whose result becomes an answer search deep", () => {
  // Deep mode buys a wider shortlist and, under the shipped rerank default,
  // the cross-encoder. A chat turn does not get to spend a second of the
  // user's CPU on ordering it will not cite.
  const evidence = ["note_output", "vault_context_answer", "explicit_file_mutation"] as const;
  for (const mode of evidence) {
    assert.equal(
      isEvidenceShapedMissionV1({ missionIntent: { mode } } as unknown as ToolExecutionContext),
      true,
      mode,
    );
  }
  for (const mode of ["chat_only", "explicit_delete"] as const) {
    assert.equal(
      isEvidenceShapedMissionV1({ missionIntent: { mode } } as unknown as ToolExecutionContext),
      false,
      mode,
    );
  }
  // No classification at all is not an invitation to spend the time.
  assert.equal(isEvidenceShapedMissionV1({} as ToolExecutionContext), false);
});
