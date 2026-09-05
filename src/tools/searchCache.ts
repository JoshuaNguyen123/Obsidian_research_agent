import type { ToolExecutionContext } from "./types";
import {
  SOURCE_CACHE_FOLDER,
  SOURCE_CACHE_FRESH_MS,
  SOURCE_CACHE_MAX_AGE_MS,
  readSourceCacheJsonFile,
  updateSourceCacheJsonFile,
  resolveSourceCacheMissionId,
} from "./sourceCache";

/**
 * Durable cache of `web_search` results, stored beside the fetched-source
 * cache under `Agent Sources/`.
 *
 * Fetches have been cached for a long time; searches never were, so a
 * follow-up mission that re-asked the same question paid the provider again
 * for an answer the vault already held. The cache is keyed by the normalized
 * query, the index the search addressed, and the result count, and is
 * bounded: the newest {@link SEARCH_CACHE_MAX_ENTRIES} searches survive, an
 * entry is fresh for the same 24 hours a fetched source is, and freshness-
 * sensitive missions or an explicit `refresh` require current mission ownership
 * while allowing reuse within the age limit. `max_age_ms: 0` always bypasses.
 *
 * Writes go through the source cache's serialized write path, so a search
 * cache write is cache maintenance under the same folder — never a note
 * write, never a mutation receipt — and two concurrent searches cannot lose
 * each other's entry.
 *
 * The in-memory per-run tool-result cache (`AgentRuntimeCache.toolResults`)
 * is a different layer: it short-circuits a repeated call inside one run
 * before the tool executes. This cache serves the next run.
 */

export const SEARCH_CACHE_PATH = `${SOURCE_CACHE_FOLDER}/search-cache.json`;
export const SEARCH_CACHE_FRESH_MS = SOURCE_CACHE_FRESH_MS;
export const SEARCH_CACHE_MAX_AGE_MS = SOURCE_CACHE_MAX_AGE_MS;
export const SEARCH_CACHE_MAX_ENTRIES = 200;

export interface CachedWebSearchResult {
  title: string;
  url: string;
  snippet: string;
  published_at?: string;
}

export interface CachedWebSearch {
  /** `${index}|${maxResults}|${normalizedQuery}` — see {@link searchCacheKey}. */
  key: string;
  /** Normalized query text (lowercase, whitespace collapsed, trailing punctuation stripped). */
  query: string;
  /** Provider list the search addressed; empty for the general web. */
  index: string;
  maxResults: number;
  searchedAt: string;
  searchedForMission?: string;
  results: CachedWebSearchResult[];
}

export interface SearchCacheManifest {
  version: 1;
  updatedAt: string;
  entries: CachedWebSearch[];
}

export interface SearchCacheLookup {
  query: string;
  index?: string;
  maxResults: number;
}

export interface SearchCacheReadOptions {
  maxAgeMs?: number;
  refresh?: boolean;
  missionId?: string;
}

/**
 * Lowercase, collapse whitespace, strip trailing punctuation. "Solid-state
 * batteries." and "  solid-state   BATTERIES" are the same search.
 */
export function normalizeSearchQuery(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\s.,;:!?…]+$/u, "")
    .trim();
}

export function searchCacheKey(input: SearchCacheLookup): string {
  return `${normalizeIndex(input.index)}|${normalizeMaxResults(input.maxResults)}|${normalizeSearchQuery(input.query)}`;
}

/** Fresh cached results for this exact search, or null. Never throws. */
export async function findFreshCachedSearch(
  ctx: ToolExecutionContext,
  input: SearchCacheLookup,
  options: SearchCacheReadOptions = {},
): Promise<CachedWebSearch | null> {
  const maxAgeMs = normalizeMaxAgeMs(options.maxAgeMs);
  if (maxAgeMs <= 0 || !hasSearchCacheVault(ctx) || (options.refresh && !options.missionId?.trim())) {
    return null;
  }
  if (!normalizeSearchQuery(input.query)) {
    return null;
  }
  const key = searchCacheKey(input);
  try {
    const manifest = await readSearchCacheManifest(ctx);
    const entry = manifest.entries.find((candidate) => candidate.key === key);
    if (!entry || entry.results.length === 0) {
      return null;
    }
    if (options.refresh && entry.searchedForMission !== options.missionId?.trim()) return null;
    const age = nowMs(ctx) - Date.parse(entry.searchedAt);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/**
 * Remember a successful search. Empty result sets are not cached: a provider
 * that found nothing today may find something after the next crawl, and a
 * cached miss would silently pin that outage for a day. Returns the stored
 * entry, or null when the context has no vault to write to. Never throws.
 */
export async function writeSearchCacheEntry(
  ctx: ToolExecutionContext,
  input: SearchCacheLookup & { results: readonly CachedWebSearchResult[] },
): Promise<CachedWebSearch | null> {
  if (!hasSearchCacheVault(ctx)) {
    return null;
  }
  const results = input.results
    .filter((result) => typeof result.url === "string" && result.url.trim())
    .map(normalizeCachedResult);
  const query = normalizeSearchQuery(input.query);
  if (results.length === 0 || !query) {
    return null;
  }
  const searchedAt = new Date(nowMs(ctx)).toISOString();
  const entry: CachedWebSearch = {
    key: searchCacheKey(input),
    query,
    index: normalizeIndex(input.index),
    maxResults: normalizeMaxResults(input.maxResults),
    searchedAt,
    searchedForMission: resolveSourceCacheMissionId(ctx),
    results,
  };
  try {
    await updateSourceCacheJsonFile(ctx, SEARCH_CACHE_PATH, (current) => {
      const manifest = parseSearchCacheManifest(current);
      const entries = [
        entry,
        ...manifest.entries.filter((candidate) => candidate.key !== entry.key),
      ]
        .sort((left, right) => right.searchedAt.localeCompare(left.searchedAt))
        .slice(0, SEARCH_CACHE_MAX_ENTRIES);
      const next: SearchCacheManifest = { version: 1, updatedAt: searchedAt, entries };
      return `${JSON.stringify(next, null, 2)}\n`;
    });
  } catch {
    return null;
  }
  return entry;
}

export async function readSearchCacheManifest(
  ctx: ToolExecutionContext,
): Promise<SearchCacheManifest> {
  if (!hasSearchCacheVault(ctx)) {
    return emptyManifest();
  }
  return parseSearchCacheManifest(
    await readSourceCacheJsonFile(ctx, SEARCH_CACHE_PATH),
  );
}

function hasSearchCacheVault(ctx: ToolExecutionContext): boolean {
  const vault = (ctx as { app?: { vault?: unknown } }).app?.vault as
    | Record<string, unknown>
    | undefined;
  return (
    typeof vault === "object" &&
    vault !== null &&
    typeof vault.getFileByPath === "function" &&
    typeof vault.read === "function" &&
    typeof vault.create === "function" &&
    typeof vault.modify === "function"
  );
}

function parseSearchCacheManifest(text: string | null): SearchCacheManifest {
  if (!text) {
    return emptyManifest();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyManifest();
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    return emptyManifest();
  }
  const entries: CachedWebSearch[] = [];
  const seen = new Set<string>();
  for (const value of parsed.entries) {
    const entry = normalizeCachedSearch(value);
    if (!entry || seen.has(entry.key)) {
      continue;
    }
    seen.add(entry.key);
    entries.push(entry);
  }
  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    entries,
  };
}

function normalizeCachedSearch(value: unknown): CachedWebSearch | null {
  if (
    !isRecord(value) ||
    typeof value.query !== "string" ||
    typeof value.searchedAt !== "string" ||
    typeof value.maxResults !== "number" ||
    !Array.isArray(value.results)
  ) {
    return null;
  }
  const results = value.results
    .filter(
      (result): result is Record<string, unknown> =>
        isRecord(result) && typeof result.url === "string" && result.url.trim() !== "",
    )
    .map((result) =>
      normalizeCachedResult({
        title: typeof result.title === "string" ? result.title : "",
        url: result.url as string,
        snippet: typeof result.snippet === "string" ? result.snippet : "",
        ...(typeof result.published_at === "string"
          ? { published_at: result.published_at }
          : {}),
      }),
    );
  const index = normalizeIndex(
    typeof value.index === "string" ? value.index : undefined,
  );
  const maxResults = normalizeMaxResults(value.maxResults);
  const query = normalizeSearchQuery(value.query);
  if (!query) {
    return null;
  }
  return {
    key: `${index}|${maxResults}|${query}`,
    query,
    index,
    maxResults,
    searchedAt: value.searchedAt,
    ...(typeof value.searchedForMission === "string" && value.searchedForMission.trim()
      ? { searchedForMission: value.searchedForMission.trim() } : {}),
    results,
  };
}

function normalizeCachedResult(result: CachedWebSearchResult): CachedWebSearchResult {
  return {
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    ...(result.published_at ? { published_at: result.published_at } : {}),
  };
}

function normalizeIndex(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .split(/[,\s]+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(",");
}

function normalizeMaxResults(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

function normalizeMaxAgeMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return SEARCH_CACHE_FRESH_MS;
  }
  return Math.min(SEARCH_CACHE_MAX_AGE_MS, Math.max(0, Math.trunc(value)));
}

function nowMs(ctx: ToolExecutionContext): number {
  return ctx.now?.().getTime() ?? Date.now();
}

function emptyManifest(): SearchCacheManifest {
  return { version: 1, updatedAt: "", entries: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
