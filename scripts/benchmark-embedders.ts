/**
 * Embedder benchmark: which local model, at which width and chunk size, the
 * plugin should ship by default — measured, not asserted.
 *
 * Builds the real semantic index (`createSemanticIndexService`) over the
 * retrieval fixture (`src/tools/retrievalFixture.ts`) through the real FastEmbed
 * helper for every candidate, then runs the fixture's graded queries through
 * the real `search()` and scores them. Reports, per candidate: chunks embedded
 * per second, index size, query latency, and recall@1/3/5 + MRR on the lexical
 * query set (exact vocabulary) and the semantic set (paraphrases with none of
 * the answer's words).
 *
 * Usage (from the repo root; downloads any model not yet in the FastEmbed
 * cache — several hundred MB for the larger ones):
 *
 *   npx tsx scripts/benchmark-embedders.ts
 *   npx tsx scripts/benchmark-embedders.ts --models BAAI/bge-small-en-v1.5@384,nomic-ai/nomic-embed-text-v1.5-Q@512
 *   npx tsx scripts/benchmark-embedders.ts --chunks 500,256 --out docs/eval/embedder-benchmark.md
 *   npx tsx scripts/benchmark-embedders.ts --skip-large     # leave out the >300 MB models
 *
 * Numbers depend on the machine; the report records CPU, thread count, and
 * the FastEmbed version so a row can be compared with a later run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { App } from "obsidian";
import {
  clearSemanticManifestReadCache,
  clearSemanticShardReadCache,
  createSemanticIndexService,
} from "../src/embeddings/semanticIndex";
import { createPythonFastEmbedProvider } from "../src/embeddings/pythonFastEmbedProvider";
import {
  findEmbeddingModelSpecV1,
  resolveEffectiveEmbeddingDimV1,
} from "../src/embeddings/embeddingModelCatalogV1";
import {
  buildRetrievalFixture,
  scoreRetrieval,
  type RetrievalFixtureQuery,
} from "../src/tools/retrievalFixture";
import type { AgentSettings } from "../src/settings";

interface Candidate {
  model: string;
  dim: number;
}

interface ChunkProfile {
  label: string;
  minTokens: number;
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

interface BenchmarkRow {
  model: string;
  dim: number;
  effectiveDim: number;
  chunkTarget: number;
  chunks: number;
  buildSeconds: number;
  chunksPerSecond: number;
  indexBytes: number;
  queryLatencyMs: { p50: number; max: number };
  lexical: ReturnType<typeof scoreRetrieval>;
  semantic: ReturnType<typeof scoreRetrieval>;
  error?: string;
}

const DEFAULT_CANDIDATES: Candidate[] = [
  { model: "nomic-ai/nomic-embed-text-v1.5-Q", dim: 512 },
  { model: "nomic-ai/nomic-embed-text-v1.5-Q", dim: 256 },
  { model: "BAAI/bge-small-en-v1.5", dim: 384 },
  { model: "snowflake/snowflake-arctic-embed-s", dim: 384 },
  { model: "jinaai/jina-embeddings-v2-small-en", dim: 512 },
  { model: "BAAI/bge-base-en-v1.5", dim: 768 },
  { model: "mixedbread-ai/mxbai-embed-large-v1", dim: 1024 },
];

const CHUNK_PROFILES: Record<string, ChunkProfile> = {
  "500": { label: "500 (shipped)", minTokens: 300, targetTokens: 500, maxTokens: 700, overlapTokens: 80 },
  "256": { label: "256", minTokens: 150, targetTokens: 256, maxTokens: 360, overlapTokens: 40 },
};

const LARGE_MODEL_MB = 300;

function parseArgs(argv: string[]) {
  const options = {
    models: DEFAULT_CANDIDATES,
    chunks: ["500", "256"],
    out: resolve(process.cwd(), "docs", "eval", "embedder-benchmark.md"),
    skipLarge: false,
    pythonCommand: "",
    listOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] ?? "";
    if (arg === "--models") {
      options.models = next()
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [model, dim] = entry.split("@");
          return { model, dim: Number(dim ?? resolveEffectiveEmbeddingDimV1(model, 512).dim) };
        });
    } else if (arg === "--chunks") {
      options.chunks = next().split(",").map((entry) => entry.trim()).filter(Boolean);
    } else if (arg === "--out") {
      options.out = resolve(process.cwd(), next());
    } else if (arg === "--skip-large") {
      options.skipLarge = true;
    } else if (arg === "--python") {
      options.pythonCommand = next();
    } else if (arg === "--list") {
      options.listOnly = true;
    }
  }
  return options;
}

interface FakeFile {
  path: string;
  basename: string;
  extension: string;
  stat: { mtime: number; size: number; ctime: number };
  content: string;
}

/** The same minimal vault the stale-search test uses: enough for the index store. */
class FakeVault {
  files = new Map<string, FakeFile>();
  folders = new Set<string>();
  private clock = 1000;

  put(path: string, content: string, mtime?: number): FakeFile {
    const existing = this.files.get(path);
    this.clock += 1;
    const file: FakeFile = {
      path,
      basename: path.split("/").pop()?.replace(/\.[^.]+$/u, "") ?? path,
      extension: path.split(".").pop() ?? "",
      stat: { mtime: mtime ?? this.clock, size: content.length, ctime: existing?.stat.ctime ?? this.clock },
      content,
    };
    this.files.set(path, file);
    return file;
  }
  getFileByPath(path: string) { return this.files.get(path) ?? null; }
  getAbstractFileByPath(path: string) {
    if (this.files.has(path)) return this.files.get(path)!;
    if (this.folders.has(path)) return { path, children: [] };
    return null;
  }
  getFolderByPath(path: string) { return this.folders.has(path) ? { path, children: [] } : null; }
  getFiles() { return [...this.files.values()]; }
  getMarkdownFiles() { return [...this.files.values()].filter((file) => file.extension === "md"); }
  async cachedRead(file: FakeFile) { return this.files.get(file.path)?.content ?? file.content; }
  async read(file: FakeFile) { return this.cachedRead(file); }
  async create(path: string, content: string) { return this.put(path, content); }
  async modify(file: FakeFile, content: string) { this.put(file.path, content); }
  async createFolder(path: string) { this.folders.add(path); }
  async delete(file: FakeFile) { this.files.delete(file.path); }
  bytesUnder(folder: string): number {
    let total = 0;
    for (const file of this.files.values()) {
      if (file.path.startsWith(`${folder}/`)) total += Buffer.byteLength(file.content, "utf8");
    }
    return total;
  }
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function benchmarkOne(
  candidate: Candidate,
  profile: ChunkProfile,
  pythonCommand: string,
): Promise<BenchmarkRow> {
  const { notes, queries, semanticQueries } = buildRetrievalFixture();
  const effective = resolveEffectiveEmbeddingDimV1(candidate.model, candidate.dim);
  const settings = {
    semanticSearchEnabled: true,
    semanticEmbeddingModel: candidate.model,
    semanticEmbeddingDim: candidate.dim,
    semanticChunkMinTokens: profile.minTokens,
    semanticChunkTargetTokens: profile.targetTokens,
    semanticChunkMaxTokens: profile.maxTokens,
    semanticChunkOverlapTokens: profile.overlapTokens,
    semanticPythonCommand: pythonCommand,
    semanticModelCacheDir: "",
    semanticIndexEnabled: true,
    semanticIndexFolder: "Agent Memory",
    semanticIndexDebounceMs: 3000,
    semanticIndexMaxFiles: 10000,
    semanticIndexPersistVectors: true,
  } as unknown as AgentSettings;

  clearSemanticManifestReadCache();
  clearSemanticShardReadCache();
  const vault = new FakeVault();
  for (const note of notes) vault.put(note.path, note.content, note.mtime);
  const app = { vault } as unknown as App;
  // Cold model downloads can take minutes; the plugin's 180 s request timeout
  // is for a warm helper.
  const provider = createPythonFastEmbedProvider(settings, { requestTimeoutMs: 30 * 60_000 });
  const service = createSemanticIndexService({
    app,
    getSettings: () => settings,
    getEmbeddingProvider: () => provider,
    now: () => new Date("2026-09-03T00:00:00Z"),
  });

  const base: BenchmarkRow = {
    model: candidate.model,
    dim: candidate.dim,
    effectiveDim: effective.dim,
    chunkTarget: profile.targetTokens,
    chunks: 0,
    buildSeconds: 0,
    chunksPerSecond: 0,
    indexBytes: 0,
    queryLatencyMs: { p50: 0, max: 0 },
    lexical: scoreRetrieval([]),
    semantic: scoreRetrieval([]),
  };

  try {
    // Warm the helper (model load / download) outside the timed build.
    const warm = await provider.embed({
      model: candidate.model,
      dim: effective.dim,
      matryoshka: effective.matryoshka,
      documents: ["warm up"],
      queries: [],
    });
    if (!warm.ok) {
      return { ...base, error: `${warm.code}: ${warm.message}` };
    }

    const startedAt = performance.now();
    const built = await service.rebuild();
    const buildSeconds = (performance.now() - startedAt) / 1000;
    if (!built.ok) {
      return { ...base, error: `${built.code}: ${built.message}` };
    }

    const rankSet = async (set: RetrievalFixtureQuery[], latencies: number[]) => {
      const ranked: Array<{ query: RetrievalFixtureQuery; paths: string[] }> = [];
      for (const query of set) {
        const queryStartedAt = performance.now();
        const result = await service.search({ query: query.text, limit: 10 });
        latencies.push(performance.now() - queryStartedAt);
        if (!result.ok) {
          throw new Error(`search failed: ${result.code}: ${result.message}`);
        }
        ranked.push({ query, paths: result.results.map((hit) => hit.path) });
      }
      return scoreRetrieval(ranked);
    };
    const latencies: number[] = [];
    const lexical = await rankSet(queries, latencies);
    const semantic = await rankSet(semanticQueries, latencies);

    return {
      ...base,
      chunks: built.chunkCount,
      buildSeconds: Number(buildSeconds.toFixed(1)),
      chunksPerSecond: Number((built.chunkCount / Math.max(0.001, buildSeconds)).toFixed(2)),
      indexBytes: vault.bytesUnder("Agent Memory"),
      queryLatencyMs: {
        p50: Math.round(percentile(latencies, 0.5)),
        max: Math.round(Math.max(...latencies)),
      },
      lexical,
      semantic,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  } finally {
    provider.dispose?.();
  }
}

function formatScore(score: ReturnType<typeof scoreRetrieval>): string {
  return `${score.recallAt1.toFixed(2)} / ${score.recallAt3.toFixed(2)} / ${score.meanReciprocalRank.toFixed(2)}`;
}

function renderReport(rows: BenchmarkRow[], meta: Record<string, string>): string {
  const lines: string[] = [];
  lines.push("# Embedder benchmark");
  lines.push("");
  for (const [key, value] of Object.entries(meta)) lines.push(`- ${key}: ${value}`);
  lines.push("");
  lines.push("Fixture: `src/tools/retrievalFixture.ts` — lexical set = exact-vocabulary queries, semantic set = paraphrases sharing no words with the answer. Scores are recall@1 / recall@3 / MRR.");
  lines.push("");
  lines.push("| model | dim | chunk target | chunks | build s | chunks/s | index MB | query p50 ms | lexical R@1/R@3/MRR | semantic R@1/R@3/MRR | note |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      `| ${row.model} | ${row.effectiveDim}${row.effectiveDim !== row.dim ? ` (asked ${row.dim})` : ""} | ${row.chunkTarget} | ${row.chunks} | ${row.buildSeconds} | ${row.chunksPerSecond} | ${(row.indexBytes / 1_000_000).toFixed(2)} | ${row.queryLatencyMs.p50} | ${formatScore(row.lexical)} | ${formatScore(row.semantic)} | ${row.error ? `FAILED: ${row.error}` : ""} |`,
    );
  }
  lines.push("");
  lines.push("Decision rule (plan A5): the shipped default is the highest semantic MRR among candidates with at least 3x the baseline's chunks/s at the chosen chunk target; if none clears 3x, keep nomic and ship only the chunk-size change.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const candidates = options.models.filter((candidate) => {
    if (!options.skipLarge) return true;
    const spec = findEmbeddingModelSpecV1(candidate.model);
    return !spec || spec.sizeMb <= LARGE_MODEL_MB;
  });
  const rows: BenchmarkRow[] = [];
  const cpu = cpus()[0]?.model ?? "unknown cpu";
  if (options.listOnly) {
    const { notes, queries, semanticQueries } = buildRetrievalFixture();
    console.log(`fixture: ${notes.length} notes, ${queries.length} lexical queries, ${semanticQueries.length} semantic queries`);
    for (const candidate of candidates) {
      const effective = resolveEffectiveEmbeddingDimV1(candidate.model, candidate.dim);
      console.log(`  ${candidate.model} -> dim ${effective.dim} (${effective.reason}) x chunk ${options.chunks.join("/")}`);
    }
    return;
  }
  console.log(`Benchmarking ${candidates.length} models x ${options.chunks.length} chunk profiles on ${cpu}`);
  for (const candidate of candidates) {
    for (const chunkKey of options.chunks) {
      const profile = CHUNK_PROFILES[chunkKey];
      if (!profile) {
        console.warn(`unknown chunk profile ${chunkKey}; known: ${Object.keys(CHUNK_PROFILES).join(", ")}`);
        continue;
      }
      process.stdout.write(`  ${candidate.model}@${candidate.dim} chunk ${profile.label} ... `);
      const row = await benchmarkOne(candidate, profile, options.pythonCommand);
      rows.push(row);
      console.log(
        row.error
          ? `FAILED ${row.error}`
          : `${row.chunksPerSecond} chunks/s, semantic ${formatScore(row.semantic)}, lexical ${formatScore(row.lexical)}`,
      );
      // Write after every row so a long run that dies still leaves a report.
      const report = renderReport(rows, {
        date: new Date().toISOString(),
        cpu,
        threads: String(cpus().length),
        memoryGb: (totalmem() / 1024 ** 3).toFixed(1),
        node: process.version,
      });
      mkdirSync(dirname(options.out), { recursive: true });
      writeFileSync(options.out, report, "utf8");
      writeFileSync(options.out.replace(/\.md$/u, ".json"), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    }
  }
  console.log(`Report: ${options.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
