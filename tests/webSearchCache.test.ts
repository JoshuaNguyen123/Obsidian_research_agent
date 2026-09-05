import { processTestVaultFile } from "./helpers/atomicTestVault";
import assert from "node:assert/strict";
import test from "node:test";
import type { HttpResponse, HttpTransport } from "../src/model/types";
import {
  SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_PATH,
  findFreshCachedSearch,
  normalizeSearchQuery,
  readSearchCacheManifest,
  searchCacheKey,
  writeSearchCacheEntry,
} from "../src/tools/searchCache";
import { SOURCE_CACHE_FOLDER } from "../src/tools/sourceCache";
import type { ToolExecutionContext } from "../src/tools/types";
import { isGeneratedOrCachePath, isSourceCachePath } from "../src/tools/vaultExclusions";
import { webSearchTool } from "../src/tools/webTools";

/**
 * The search-result cache must serve an identical follow-up search with zero
 * transport calls, honour the same bypasses as web_fetch (refresh, a
 * freshness-sensitive prompt, expiry), stay bounded, and live under the
 * source-cache folder so its writes are cache maintenance rather than note
 * writes.
 */

const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, json });

test("search refresh reuses root-mission results but zero age and new missions transport", async () => {
  const harness = createVaultHarness({ now: () => new Date("2026-09-04T12:00:00Z") });
  const ctx = harness.context;
  ctx.rootMissionId = "root-a";
  const search = (args: Record<string, unknown> = {}) => webSearchTool.execute({ query: "CRDT", refresh: true, ...args }, ctx) as Promise<Record<string, unknown>>;
  assert.equal((await search()).fromCache, false);
  ctx.runId = "continuation-b";
  assert.equal((await search()).fromCache, true);
  assert.equal((await search({ max_age_ms: 0 })).fromCache, false);
  ctx.rootMissionId = "root-b";
  assert.equal((await search()).fromCache, false);
});

function createVaultHarness(input: { now: () => Date; prompt?: string; results?: unknown[] }) {
  const content = new Map<string, string>();
  const folders = new Set<string>();
  const revisions = new Map<string, number>();
  let searchTransportCalls = 0;

  const getFile = (path: string) =>
    content.has(path)
      ? {
          path,
          basename: path.split("/").pop()?.replace(/\.[^.]+$/i, "") ?? path,
          extension: path.split(".").pop()?.toLowerCase() ?? "",
          stat: { mtime: revisions.get(path) ?? 0, size: content.get(path)?.length ?? 0 },
        }
      : null;

  const app = {
    vault: {
      getFileByPath: getFile,
      getFolderByPath: (path: string) =>
        folders.has(path) ? { path, name: path.split("/").pop() ?? path } : null,
      createFolder: async (path: string) => {
        folders.add(path);
      },
      create: async (path: string, data: string) => {
        content.set(path, data);
        revisions.set(path, (revisions.get(path) ?? 0) + 1);
        return getFile(path);
      },
      process: function (file: any, transform: (content: string) => string): Promise<string> {
        return processTestVaultFile(this, file, transform);
      },
      modify: async (file: { path: string }, data: string) => {
        content.set(file.path, data);
        revisions.set(file.path, (revisions.get(file.path) ?? 0) + 1);
      },
      read: async (file: { path: string }) => {
        const value = content.get(file.path);
        if (value === undefined) throw new Error(`File not found: ${file.path}`);
        return value;
      },
      getFiles: () =>
        [...content.keys()]
          .map((path) => getFile(path))
          .filter((file): file is NonNullable<typeof file> => Boolean(file)),
    },
  };

  const httpTransport: HttpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      searchTransportCalls += 1;
      return ok({
        results: input.results ?? [
          { title: "Primary", url: "https://primary.example/a", content: "Alpha passage." },
          { title: "Secondary", url: "https://secondary.example/b", content: "Beta passage." },
        ],
      });
    }
    return { status: 404, headers: {} };
  };

  const context = {
    app: app as never,
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "k",
      requestTimeoutMs: 30_000,
      freeSearchFallbackEnabled: false,
    } as never,
    originalPrompt: input.prompt ?? "Summarize solid-state battery progress with sources.",
    httpTransport,
    now: input.now,
  } as unknown as ToolExecutionContext;

  return {
    context,
    content,
    folders,
    get searchTransportCalls() {
      return searchTransportCalls;
    },
  };
}

type SearchOutput = {
  results: Array<{ url: string }>;
  fromCache: boolean;
  cachedPath?: string;
  searchedAt?: string;
};

test("normalizeSearchQuery lowercases, collapses whitespace, and strips trailing punctuation", () => {
  assert.equal(normalizeSearchQuery("  Solid-State   Batteries?! "), "solid-state batteries");
  assert.equal(normalizeSearchQuery("CRISPR base editing..."), "crispr base editing");
  assert.equal(
    searchCacheKey({ query: "Solid-state batteries.", index: "PubMed, arxiv", maxResults: 5 }),
    "pubmed,arxiv|5|solid-state batteries",
  );
});

test("the cache file lives under the source-cache folder and is exempt like a fetched source", () => {
  assert.equal(SEARCH_CACHE_PATH, `${SOURCE_CACHE_FOLDER}/search-cache.json`);
  assert.equal(isSourceCachePath(SEARCH_CACHE_PATH), true);
  assert.equal(isGeneratedOrCachePath(SEARCH_CACHE_PATH), true);
});

test("a second identical web_search is served from the cache with zero transport calls", async () => {
  let clock = Date.parse("2026-09-03T10:00:00Z");
  const vault = createVaultHarness({ now: () => new Date(clock) });

  const first = (await webSearchTool.execute(
    { query: "Solid-state batteries." },
    vault.context,
  )) as SearchOutput;
  assert.equal(first.fromCache, false);
  assert.equal(vault.searchTransportCalls, 1);
  assert.ok(vault.content.has(SEARCH_CACHE_PATH), "the search cache file was written");

  clock += 60_000;
  const second = (await webSearchTool.execute(
    { query: "  solid-state   BATTERIES" },
    vault.context,
  )) as SearchOutput;
  assert.equal(second.fromCache, true);
  assert.equal(second.cachedPath, SEARCH_CACHE_PATH);
  assert.equal(second.searchedAt, new Date(Date.parse("2026-09-03T10:00:00Z")).toISOString());
  assert.deepEqual(
    second.results.map((item) => item.url),
    first.results.map((item) => item.url),
  );
  assert.equal(vault.searchTransportCalls, 1, "the follow-up search made no transport call");

  // Only the cache file and its folder exist; no note was created.
  assert.deepEqual([...vault.content.keys()], [SEARCH_CACHE_PATH]);
  assert.equal(vault.folders.has(SOURCE_CACHE_FOLDER), true);
});

test("a different result count or index is a different cache entry", async () => {
  const vault = createVaultHarness({ now: () => new Date("2026-09-03T10:00:00Z") });
  await webSearchTool.execute({ query: "graphene" }, vault.context);
  assert.equal(vault.searchTransportCalls, 1);
  const wider = (await webSearchTool.execute(
    { query: "graphene", max_results: 8 },
    vault.context,
  )) as SearchOutput;
  assert.equal(wider.fromCache, false);
  assert.equal(vault.searchTransportCalls, 2);
  const manifest = await readSearchCacheManifest(vault.context);
  assert.deepEqual(
    manifest.entries.map((entry) => entry.key).sort(),
    ["|3|graphene", "|8|graphene"],
  );
});

test("refresh=true bypasses the cache and rewrites the entry", async () => {
  let clock = Date.parse("2026-09-03T10:00:00Z");
  const vault = createVaultHarness({ now: () => new Date(clock) });
  await webSearchTool.execute({ query: "perovskite" }, vault.context);
  clock += 5_000;
  const refreshed = (await webSearchTool.execute(
    { query: "perovskite", refresh: true },
    vault.context,
  )) as SearchOutput;
  assert.equal(refreshed.fromCache, false);
  assert.equal(vault.searchTransportCalls, 2);
  const manifest = await readSearchCacheManifest(vault.context);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0]?.searchedAt, new Date(clock).toISOString());
});

test("a freshness-sensitive mission never reads cached results unless refresh=false is explicit", async () => {
  const vault = createVaultHarness({
    now: () => new Date("2026-09-03T10:00:00Z"),
    prompt: "What is the latest stable Obsidian release? Cite sources.",
  });
  await webSearchTool.execute({ query: "obsidian release" }, vault.context);
  const again = (await webSearchTool.execute(
    { query: "obsidian release" },
    vault.context,
  )) as SearchOutput;
  assert.equal(again.fromCache, false);
  assert.equal(vault.searchTransportCalls, 2);
  const explicit = (await webSearchTool.execute(
    { query: "obsidian release", refresh: false },
    vault.context,
  )) as SearchOutput;
  assert.equal(explicit.fromCache, true);
  assert.equal(vault.searchTransportCalls, 2);
});

test("an entry older than 24 hours expires and is replaced by a fresh search", async () => {
  let clock = Date.parse("2026-09-03T10:00:00Z");
  const vault = createVaultHarness({ now: () => new Date(clock) });
  await webSearchTool.execute({ query: "sodium-ion cells" }, vault.context);
  clock += 23 * 60 * 60 * 1000;
  const stillFresh = (await webSearchTool.execute(
    { query: "sodium-ion cells" },
    vault.context,
  )) as SearchOutput;
  assert.equal(stillFresh.fromCache, true);
  clock += 2 * 60 * 60 * 1000;
  assert.equal(
    await findFreshCachedSearch(vault.context, { query: "sodium-ion cells", maxResults: 3 }),
    null,
  );
  const expired = (await webSearchTool.execute(
    { query: "sodium-ion cells" },
    vault.context,
  )) as SearchOutput;
  assert.equal(expired.fromCache, false);
  assert.equal(vault.searchTransportCalls, 2);
  const manifest = await readSearchCacheManifest(vault.context);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0]?.searchedAt, new Date(clock).toISOString());
});

test("empty result sets are not cached", async () => {
  const vault = createVaultHarness({
    now: () => new Date("2026-09-03T10:00:00Z"),
    results: [],
  });
  const empty = (await webSearchTool.execute({ query: "nothing here" }, vault.context)) as SearchOutput;
  assert.equal(empty.fromCache, false);
  assert.deepEqual(empty.results, []);
  assert.equal(vault.content.has(SEARCH_CACHE_PATH), false);
  await webSearchTool.execute({ query: "nothing here" }, vault.context);
  assert.equal(vault.searchTransportCalls, 2);
});

test("the cache keeps the newest entries and drops the oldest past the bound", async () => {
  let clock = Date.parse("2026-09-01T00:00:00Z");
  const vault = createVaultHarness({ now: () => new Date(clock) });
  for (let index = 0; index < SEARCH_CACHE_MAX_ENTRIES + 5; index += 1) {
    clock += 1_000;
    await writeSearchCacheEntry(vault.context, {
      query: `query ${index}`,
      maxResults: 5,
      results: [{ title: `r${index}`, url: `https://example.test/${index}`, snippet: "" }],
    });
  }
  const manifest = await readSearchCacheManifest(vault.context);
  assert.equal(manifest.entries.length, SEARCH_CACHE_MAX_ENTRIES);
  assert.equal(manifest.entries[0]?.query, `query ${SEARCH_CACHE_MAX_ENTRIES + 4}`);
  assert.equal(
    manifest.entries.some((entry) => entry.query === "query 0"),
    false,
    "the oldest entry was evicted",
  );
});

test("concurrent searches do not lose each other's cache entries", async () => {
  const vault = createVaultHarness({ now: () => new Date("2026-09-03T10:00:00Z") });
  await Promise.all([
    webSearchTool.execute({ query: "alpha topic" }, vault.context),
    webSearchTool.execute({ query: "beta topic" }, vault.context),
    webSearchTool.execute({ query: "gamma topic" }, vault.context),
  ]);
  const manifest = await readSearchCacheManifest(vault.context);
  assert.deepEqual(
    manifest.entries.map((entry) => entry.query).sort(),
    ["alpha topic", "beta topic", "gamma topic"],
  );
});

test("a context without a vault searches normally and never caches", async () => {
  let calls = 0;
  const context = {
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "k",
      requestTimeoutMs: 30_000,
      freeSearchFallbackEnabled: false,
    },
    httpTransport: (async () => {
      calls += 1;
      return ok({ results: [{ title: "T", url: "https://t.example/1", content: "x" }] });
    }) as HttpTransport,
  } as unknown as ToolExecutionContext;
  const first = (await webSearchTool.execute({ query: "vaultless" }, context)) as SearchOutput;
  const second = (await webSearchTool.execute({ query: "vaultless" }, context)) as SearchOutput;
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, false);
  assert.equal(calls, 2);
});
