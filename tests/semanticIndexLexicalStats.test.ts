import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import {
  buildSemanticLexicalStatsV1,
  clearSemanticManifestReadCache,
  clearSemanticShardReadCache,
  createSemanticIndexService,
  MAX_LEXICAL_STAT_TERMS,
} from "../src/embeddings/semanticIndex";
import type { AgentSettings } from "../src/settings";
import type { SemanticEmbeddingProvider } from "../src/embeddings/types";

/*
 * The lexical half of the indexed blend used to count matched *words*: a query
 * term sitting in every note in the vault weighed exactly as much as one
 * sitting in three. That is what let a note whose title, heading and tags all
 * repeat a common word outrank the note that actually contains the rare term
 * the user typed. The index now records how common each term is across its own
 * rows and weighs matches by how much information they carry.
 */

const SETTINGS = {
  semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
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

/**
 * Every vector identical, so the semantic half cannot break any tie and the
 * ranking under test is purely the lexical one.
 */
const FLAT_VECTOR = [1, ...new Array(31).fill(0)];
const provider: SemanticEmbeddingProvider = {
  id: "flat-embedder",
  async embed(request) {
    return {
      ok: true,
      model: request.model,
      dim: request.dim,
      documents: request.documents.map(() => FLAT_VECTOR),
      queries: request.queries.map(() => FLAT_VECTOR),
    };
  },
};

test("term frequencies are counted over the rows and capped", () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    note: { title: `note ${index}`, tags: ["shared"] },
    row: { heading: null, snippet: `body ${index} shared shared` },
  }));
  const stats = buildSemanticLexicalStatsV1(entries);
  assert.equal(stats.documentCount, 5);
  assert.ok(stats.averageLength > 0);
  // "shared" and "body" are in all five rows. ("note" is a stop term and the
  // per-row number is too short to tokenize, which is the tokenizer's business,
  // not this table's.)
  assert.equal(stats.documentFrequencies.shared, 5);
  assert.equal(stats.documentFrequencies.body, 5);
  assert.equal(stats.documentFrequencies.note, undefined);

  const wide = Array.from({ length: 3 }, (_, row) => ({
    note: { title: "t", tags: [] },
    row: {
      heading: null,
      snippet: Array.from({ length: MAX_LEXICAL_STAT_TERMS + 500 }, (_, term) => `w${term}`).join(
        " ",
      ),
    },
  }));
  const capped = buildSemanticLexicalStatsV1(wide);
  assert.equal(
    Object.keys(capped.documentFrequencies).length,
    MAX_LEXICAL_STAT_TERMS,
    "a whole vault vocabulary must not land in the manifest",
  );
});

test("a rare term outweighs a common one repeated in every field", async () => {
  clearSemanticManifestReadCache();
  clearSemanticShardReadCache();
  const vault = new FakeVault();
  // "ledger" is everywhere in this vault; "kryptonite" is in one note.
  for (let index = 0; index < 12; index += 1) {
    vault.put(
      `Notes/ledger-${index}.md`,
      `# ledger ${index}\n\nThe ledger records ledger entries for ledger week ${index}.\n`,
    );
  }
  // The hub note every vault grows: the common word in its title, its heading
  // and its body, and an answer to nothing.
  vault.put(
    "Notes/ledger-overview.md",
    "# ledger ledger ledger\n\n## ledger ledger\n\nThe ledger ledger ledger overview page.\n",
  );
  // Contains the rare term the user is actually looking for, and only that one.
  vault.put(
    "Notes/incident.md",
    "# incident report\n\nThe kryptonite sample was logged on Tuesday.\n",
  );
  const app = { vault } as unknown as App;
  const service = createSemanticIndexService({
    app,
    getSettings: () => SETTINGS,
    getEmbeddingProvider: () => provider,
    now: () => new Date("2026-09-04T00:00:00Z"),
  });
  const built = await service.rebuild();
  assert.equal(built.ok, true, built.message);

  const index = await service.load();
  assert.ok(index && index.version === 2 && index.lexicalStats, "stats must be persisted");
  assert.ok(
    (index.lexicalStats!.documentFrequencies.ledger ?? 0) >
      (index.lexicalStats!.documentFrequencies.kryptonite ?? 0),
    "the common term must be recorded as common",
  );

  const result = await service.search({ query: "ledger kryptonite", limit: 5 });
  assert.equal(result.ok, true, result.message);
  assert.equal(
    result.results[0]?.path,
    "Notes/incident.md",
    `expected the rare-term note first, got ${result.results
      .map((hit) => hit.path)
      .join(", ")}`,
  );

  // And the same corpus without the statistics gets it wrong, which is what
  // makes the assertion above a measurement of this change rather than of the
  // fixture: strip the table, search again, watch the keyword-dense note win.
  const manifestPath = [...vault.files.keys()].find((path) =>
    path.endsWith("semantic-vault-index.json"),
  );
  assert.ok(manifestPath, "manifest must exist");
  const manifest = JSON.parse(vault.files.get(manifestPath!)!.content) as Record<
    string,
    unknown
  >;
  delete manifest.lexicalStats;
  vault.put(manifestPath!, JSON.stringify(manifest));
  clearSemanticManifestReadCache();
  clearSemanticShardReadCache();

  const unweighted = await service.search({ query: "ledger kryptonite", limit: 5 });
  assert.equal(unweighted.ok, true, unweighted.message);
  // Query-time BM25 over full chunk text builds its own corpus from the
  // candidates, so stripping persisted lexicalStats must not resurrect the
  // keyword-dense hub note.
  assert.equal(
    unweighted.results[0]?.path,
    "Notes/incident.md",
    `query-time BM25 should still prefer the rare term, got ${unweighted.results
      .map((hit) => hit.path)
      .join(", ")}`,
  );
});

test("an index built before the statistics existed still scores", async () => {
  // Older vaults must not have to rebuild to keep searching: with no stats the
  // lexical half weighs matched words, exactly as it always did.
  clearSemanticManifestReadCache();
  clearSemanticShardReadCache();
  const vault = new FakeVault();
  vault.put("Notes/alpha.md", "# alpha\n\nThe alpha note mentions kryptonite once.\n");
  vault.put("Notes/beta.md", "# beta\n\nThe beta note mentions nothing of interest.\n");
  const app = { vault } as unknown as App;
  const service = createSemanticIndexService({
    app,
    getSettings: () => SETTINGS,
    getEmbeddingProvider: () => provider,
    now: () => new Date("2026-09-04T00:00:00Z"),
  });
  assert.equal((await service.rebuild()).ok, true);

  // Strip the statistics from the persisted manifest, the way an index written
  // by an older build would look.
  const manifestPath = [...vault.files.keys()].find((path) =>
    path.endsWith("semantic-vault-index.json"),
  );
  assert.ok(manifestPath, "manifest must exist");
  const manifest = JSON.parse(vault.files.get(manifestPath!)!.content) as Record<
    string,
    unknown
  >;
  delete manifest.lexicalStats;
  vault.put(manifestPath!, JSON.stringify(manifest));
  clearSemanticManifestReadCache();
  clearSemanticShardReadCache();

  const result = await service.search({ query: "kryptonite", limit: 3 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.results[0]?.path, "Notes/alpha.md");
});
