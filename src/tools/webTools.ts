import {
  isOllamaCloudBaseUrl,
  normalizeOllamaBaseUrl,
} from "../model/OllamaClient";
import type { HttpRequest } from "../model/types";
import {
  DEFAULT_WEB_RESULTS,
  MAX_WEB_FETCH_CHARS,
  MAX_WEB_RESULTS,
  MAX_WEB_SEARCH_SNIPPET_CHARS,
} from "./constants";
import { withDiscriminativeDescription } from "./discriminativeToolDescriptions";
import {
  ToolExecutionError,
  type AgentTool,
  type ToolExecutionContext,
} from "./types";
import {
  getOptionalInteger,
  getOptionalString,
  getRequiredString,
  isRecord,
  truncateText,
} from "./validation";
import {
  SOURCE_CACHE_MAX_AGE_MS,
  findFreshCachedSource,
  readCachedSourceContent,
  readSourceSection,
  writeSourceCacheNote,
} from "./sourceCache";
import type { SourceParserStatus } from "./sourceCache";
import { evaluateSourceUsability } from "../agent/sourceUsability";
import {
  buildResearchFallbackCandidates,
  retrieveUsableResearchSource,
  type ResearchRetrievalProvider,
} from "../orchestrator/researchProvider";
import {
  browserExtractMarkdownTool,
  browserOpenPageTool,
} from "./companionTools";
import {
  FREE_SEARCH_PROVIDER_GROUPS,
  FREE_SEARCH_PROVIDER_IDS,
  resolveFreeSearchProviders,
  resolveOpenAccessEditions,
  runFreeSearchProvidersDetailed,
  type FreeSearchProviderFailure,
} from "./freeSearchProviders";
import {
  SEARCH_CACHE_PATH,
  findFreshCachedSearch,
  writeSearchCacheEntry,
  type SearchCacheLookup,
} from "./searchCache";
import { createDocumentExtractProvider } from "./documentExtract";
import { inferSourceSignals } from "../agent/sourceSignals";
import { scoreSourceCandidate } from "../orchestrator/sourceCandidateLedger";
import { normalizePublicFetchUrlV1 } from "./fetchHostPolicy";
import { requestWithRetry } from "./httpRetry";
import {
  htmlToReadableTextV1,
  isReadableTextContentTypeV1,
} from "./htmlReadableText";
import { resolveRetrievalCachePolicy, type ResolvedRetrievalCachePolicy } from "./retrievalCachePolicy";

export function createWebTools(): AgentTool[] {
  return [webSearchTool, webFetchTool, readSourceSectionTool];
}

export const webSearchTool: AgentTool = {
  name: "web_search",
  description: withDiscriminativeDescription(
    "web_search",
    "Search the web through the configured Ollama-compatible endpoint.",
  ),
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "Search query.",
      },
      max_results: {
        type: "integer",
        description: "Maximum results to return. Defaults to 5, maximum 10.",
      },
      index: {
        type: "string",
        // Deliberately terse and deliberately not exhaustive: every tool
        // description rides on every request and a compactness test pins the
        // total at 30k chars. A wrong value is refused with the complete list
        // of valid names, so the full set stays discoverable in one turn.
        description: "Optional index: pubmed|arxiv|courtlistener|scholar|law.",
      },
      refresh: {
        type: "boolean",
        description: "Require results fetched for this mission; reuse them within the accepted age. Defaults from the user mission unless max_age_ms is supplied.",
      },
      max_age_ms: {
        type: "integer", minimum: 0, maximum: SOURCE_CACHE_MAX_AGE_MS,
        description: "Accepted cache age (default 24 h); 0 always bypasses cache.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertOperationActive(context);
    const query = getRequiredString(args, "query").trim();
    if (!query) {
      throw new Error("web_search query cannot be empty.");
    }

    const maxResults = clampMaxResults(getOptionalInteger(args, "max_results"));
    const requestedIndex = getOptionalString(args, "index");
    const requestedProviders = resolveFreeSearchProviders(requestedIndex);
    if (requestedIndex?.trim() && !requestedProviders && !isGeneralWebIndex(requestedIndex)) {
      throw new ToolExecutionError(
        "invalid_arguments",
        `web_search index "${requestedIndex}" is not available. Use one of: ` +
          `${FREE_SEARCH_PROVIDER_IDS.join(", ")}, ` +
          `${Object.keys(FREE_SEARCH_PROVIDER_GROUPS).join(", ")}, or omit it for the general web.`,
      );
    }

    const cachePolicy = resolveRetrievalCachePolicy(args, context);
    const cacheLookup: SearchCacheLookup = {
      query,
      index: requestedProviders ? requestedProviders.join(",") : "",
      maxResults,
    };
    const cached = await findFreshCachedSearch(context, cacheLookup, cachePolicy);
    if (cached) {
      return {
        ...(cached.index ? { index: cached.index } : {}),
        results: cached.results,
        fromCache: true,
        cachedPath: SEARCH_CACHE_PATH,
        searchedAt: cached.searchedAt,
        searchedForMission: cached.searchedForMission,
        cacheMaxAgeMs: cachePolicy.maxAgeMs,
      };
    }

    // A named index is an instruction, not a preference: falling through to the
    // general web would answer a question about PubMed with something else and
    // give the reader no way to tell.
    if (requestedProviders) {
      const targeted = await runFreeSearchProvidersDetailed({
        transport: context.httpTransport,
        query,
        maxResults,
        timeoutMs: getOperationTimeoutMs(context),
        signal: context.abortSignal,
        providers: requestedProviders,
      });
      const results = rankWebSearchResults(
        targeted.results.map(toWebSearchResult),
        context,
      );
      await rememberWebSearchResults(context, cacheLookup, results);
      return {
        index: requestedProviders.join(","),
        results,
        fromCache: false,
        ...providerFailuresField(targeted.providerFailures),
      };
    }

    let primaryError: unknown = null;
    try {
      const primary = await runOllamaWebSearch(query, maxResults, context);
      if (primary.results.some((result) => result.url)) {
        const results = rankWebSearchResults(primary.results, context);
        await rememberWebSearchResults(context, cacheLookup, results);
        return { results, fromCache: false };
      }
    } catch (error) {
      primaryError = error;
    }

    // Primary provider failed or returned nothing usable: fall back to keyless
    // official public APIs so research is never blocked by a single provider.
    if (context.settings.freeSearchFallbackEnabled !== false) {
      const fallback = await runFreeSearchProvidersDetailed({
        transport: context.httpTransport,
        query,
        maxResults,
        timeoutMs: getOperationTimeoutMs(context),
        signal: context.abortSignal,
      });
      if (fallback.results.length > 0) {
        const results = rankWebSearchResults(
          fallback.results.map(toWebSearchResult),
          context,
        );
        await rememberWebSearchResults(context, cacheLookup, results);
        return {
          results,
          fromCache: false,
          ...providerFailuresField(fallback.providerFailures),
        };
      }
    }

    if (primaryError) {
      throw primaryError;
    }
    return { results: [], fromCache: false };
  },
};

/**
 * Cache maintenance must never fail a search that already succeeded: the
 * cache module swallows its own errors, and this keeps the write off the
 * result's critical path in spirit while still awaiting it so a follow-up
 * search in the same run sees the entry.
 */
async function rememberWebSearchResults(
  context: ToolExecutionContext,
  lookup: SearchCacheLookup,
  results: readonly WebSearchResultV1[],
): Promise<void> {
  if (results.length === 0) return;
  await writeSearchCacheEntry(context, { ...lookup, results });
}

function providerFailuresField(
  failures: readonly FreeSearchProviderFailure[],
): { providerFailures?: FreeSearchProviderFailure[] } {
  return failures.length > 0 ? { providerFailures: [...failures] } : {};
}

function isGeneralWebIndex(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "auto" || normalized === "web";
}

function toWebSearchResult(result: {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}): WebSearchResultV1 {
  return {
    title: result.title,
    url: result.url,
    snippet: truncateText(result.snippet, MAX_WEB_SEARCH_SNIPPET_CHARS),
    // Only the scholarly providers know a publication date. Passing it through
    // lets candidate ranking score freshness for real instead of assuming a
    // constant, and lets the model reason about recency.
    ...(result.publishedAt ? { published_at: result.publishedAt } : {}),
  };
}

interface WebSearchResultV1 {
  title: string;
  url: string;
  snippet: string;
  published_at?: string;
}

/**
 * Order results by the weighted credibility score the source-candidate ledger
 * already computes.
 *
 * `inferSourceSignals` + `scoreSourceCandidate` were real and tested, but only
 * `researchWorker` ever called them — ordinary single-agent research got the
 * provider's own ordering and no ranking at all. Ranking here serves both
 * paths, and the worker re-ranking a ranked list is harmless.
 *
 * Ties keep the provider's order: the score only reorders when the signals
 * genuinely differ, so a provider that already ranked well is not shuffled by
 * rounding noise.
 */
function rankWebSearchResults<T extends WebSearchResultV1>(
  results: readonly T[],
  context: ToolExecutionContext,
): T[] {
  if (results.length < 2) return [...results];
  const now = context.now?.() ?? new Date();
  const scored = results.map((result, index) => {
    const signals = inferSourceSignals({
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      publishedAt: result.published_at,
      now,
    });
    return {
      result,
      index,
      score: scoreSourceCandidate({
        signals: {
          quality: signals.quality,
          freshness: signals.freshness,
          fetchability: signals.fetchability,
        },
        sourceType: signals.sourceType,
      }),
    };
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored.map((entry) => entry.result);
}

async function runOllamaWebSearch(
  query: string,
  maxResults: number,
  context: ToolExecutionContext,
): Promise<{ results: Array<{ title: string; url: string; snippet: string }> }> {
  const baseUrl = normalizeOllamaBaseUrl(context.settings.ollamaBaseUrl);

  if (isOllamaCloudBaseUrl(baseUrl) && !context.settings.ollamaApiKey.trim()) {
    throw new Error(
      "Ollama web_search requires an API key. Add one in Agentic Researcher settings.",
    );
  }

  const request: HttpRequest = {
    url: `${baseUrl}/web_search`,
    method: "POST",
    contentType: "application/json",
    headers: buildHeaders(context),
    throw: false,
    timeoutMs: getOperationTimeoutMs(context),
    abortSignal: context.abortSignal,
    body: JSON.stringify({
      query,
      max_results: maxResults,
    }),
  };

  const response = await requestWithRetry(context.httpTransport, request);
  if (response.status >= 400) {
    throw new Error(getHttpErrorMessage(response));
  }

  return normalizeWebSearchResponse(response.json ?? parseJsonText(response.text));
}

export const webFetchTool: AgentTool = {
  name: "web_fetch",
  description:
    "Fetch one web page by URL through the configured Ollama-compatible endpoint. Full text is cached in bounded sections with provenance. For current/latest facts, set refresh=true.",
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        description: "HTTP or HTTPS URL to fetch.",
      },
      query: {
        type: "string",
        description:
          "Optional research question or claim used to select model-facing evidence passages.",
      },
      max_age_ms: {
        type: "integer",
        minimum: 0,
        maximum: SOURCE_CACHE_MAX_AGE_MS,
        description:
          "Maximum accepted cache age in milliseconds. Defaults to 24 hours. Use 0 to bypass cache.",
      },
      refresh: {
        type: "boolean",
        description:
          "Require a source fetched for this mission; reuse it within the accepted age. Defaults from the user mission unless max_age_ms is supplied.",
      },
      alternate_urls: {
        type: "array",
        items: { type: "string" },
        maxItems: 5,
        description:
          "Optional alternate result URLs to try when the primary page cannot yield usable passages.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertOperationActive(context);
    const url = normalizeWebFetchUrl(getRequiredString(args, "url"));
    const cachePolicy = resolveRetrievalCachePolicy(args, context);
    const { maxAgeMs } = cachePolicy;
    const query = getEvidenceQuery(args, context.originalPrompt);
    const cached = await findFreshCachedSource(context, url, cachePolicy);
    if (cached) {
      const section = await readSourceSection(
        context,
        { path: cached.vaultPath },
        1,
      );
      const cachedUsability = evaluateSourceUsability({
        content: section.content,
        sourceLocator: cached.normalizedUrl || url,
        query,
        parserStatus: cached.parserStatus,
      });
      if (cachedUsability.usable) return {
        title: cached.title,
        url,
        normalizedUrl: cached.normalizedUrl,
        urlHash: cached.urlHash,
        query,
        content: truncateText(section.content, MAX_WEB_FETCH_CHARS),
        links: [],
        fromCache: true,
        sourceTransport: "cache",
        fetchedForMission: cached.fetchedForMission,
        cachedPath: cached.vaultPath,
        fetchedAt: cached.fetchedAt,
        sourceChars: cached.sourceChars,
        totalChars: cached.totalChars,
        contentHash: cached.contentHash,
        truncated: cached.truncated,
        parserStatus: cached.parserStatus,
        cacheMaxAgeMs: maxAgeMs,
        section: section.section,
        sectionCount: cached.sectionCount,
      };
    }

    const baseUrl = normalizeOllamaBaseUrl(context.settings.ollamaBaseUrl);
    // The retrieval endpoint belongs to Ollama Cloud. A cloud base URL with no
    // key cannot be called at all, and a local Ollama does not serve
    // /web_fetch — both used to end the fetch outright, which left BYOK and
    // local-model users with search (it already falls back to the keyless
    // providers) and no way to read any page: no quotes, no verification, no
    // citations.
    //
    // Only the first case is decidable in advance. Any other configured base
    // URL may be a proxy that does serve the route, so it is still tried
    // first and the direct read is the fallback when it fails.
    const canUseOllamaFetch = !(
      isOllamaCloudBaseUrl(baseUrl) && !context.settings.ollamaApiKey.trim()
    );

    let normalized: NormalizedWebFetchV1 | null = null;
    if (canUseOllamaFetch) {
      const request: HttpRequest = {
        url: `${baseUrl}/web_fetch`,
        method: "POST",
        contentType: "application/json",
        headers: buildHeaders(context),
        throw: false,
        timeoutMs: getOperationTimeoutMs(context),
        abortSignal: context.abortSignal,
        body: JSON.stringify({ url }),
      };
      const response = await requestWithRetry(context.httpTransport, request);
      if (response.status < 400) {
        normalized = normalizeWebFetchResponse(
          response.json ?? parseJsonText(response.text),
          url,
        );
      } else {
        // A failing retrieval endpoint is not a failing page. Read it
        // directly before giving up on this URL and looking for another.
        normalized = await directFetchReadableSourceV1(context, url);
        if (!normalized) {
          return await retrieveWebFetchSubstituteV1({
            args,
            context,
            query,
            url,
            maxAgeMs,
            cachePolicy,
            failureCode: "source_http_error",
            failureSummary: `web_fetch could not retrieve ${url} (${getHttpErrorMessage(response, "web_fetch")})`,
          });
        }
      }
    } else {
      normalized = await directFetchReadableSourceV1(context, url);
      if (!normalized) {
        return await retrieveWebFetchSubstituteV1({
          args,
          context,
          query,
          url,
          maxAgeMs,
          cachePolicy,
          failureCode: "source_http_error",
          failureSummary: `web_fetch could not retrieve ${url} directly.`,
        });
      }
    }
    const sourceUsability = evaluateSourceUsability({
      content: normalized.fullContent,
      sourceLocator: url,
      query,
      parserStatus: normalized.parserStatus,
    });
    if (!sourceUsability.usable) {
      return await retrieveWebFetchSubstituteV1({
        args,
        context,
        query,
        url,
        maxAgeMs,
        cachePolicy,
        failureCode: "source_unusable",
        failureSummary: `web_fetch could not extract usable source passages from ${url} (${sourceUsability.reason})`,
      });
    }
    const cache = await writeSourceCacheNote(context, {
      url,
      title: normalized.title,
      content: normalized.fullContent,
      parserStatus: normalized.parserStatus,
    });
    return {
      title: normalized.title,
      url,
      normalizedUrl: cache.normalizedUrl,
      urlHash: cache.urlHash,
      query,
      content: normalized.content,
      links: normalized.links,
      fromCache: false,
      cachedPath: cache.vaultPath,
      sourceTransport: "network",
      fetchedForMission: cache.fetchedForMission,
      fetchedAt: cache.fetchedAt,
      sourceChars: cache.sourceChars,
      totalChars: cache.totalChars,
      contentHash: cache.contentHash,
      truncated: cache.truncated,
      parserStatus: cache.parserStatus,
      cacheMaxAgeMs: maxAgeMs,
      section: 1,
      sectionCount: cache.sectionCount,
    };
  },
};

/**
 * Retrieve a substitute source after the primary web_fetch failed to yield
 * usable passages.
 *
 * A transport-level HTTP failure and a 2xx body with nothing extractable are
 * the same problem from the mission's point of view: the cited URL cannot
 * supply evidence. Only the second used to reach this ladder, so a single
 * model-chosen URL returning 404 ended the whole run while a working mirror,
 * an open-access edition, or the next search result sat unused. Both paths
 * enter here now; the caller supplies the failure code so the classifier
 * downstream can still tell a dead endpoint from an unreadable page.
 */
async function retrieveWebFetchSubstituteV1(input: {
  args: Record<string, unknown>;
  context: ToolExecutionContext;
  query: string | undefined;
  url: string;
  maxAgeMs: number;
  cachePolicy: ResolvedRetrievalCachePolicy;
  failureCode: "source_unusable" | "source_http_error";
  failureSummary: string;
}) {
  const { args, context, query, url, maxAgeMs } = input;
  assertOperationActive(context);
  const alternateUrls = await resolveFallbackUrls(args, context, query, url, input.cachePolicy);
  const fallback = await retrieveUsableResearchSource({
    candidates: buildResearchFallbackCandidates({
      url,
      alternateUrls,
      query,
      documentLike: isDocumentLikeUrl(url),
    }).filter(
      (candidate) =>
        candidate.strategy === "browser_extract" ||
        candidate.strategy === "document_extract" ||
        candidate.strategy === "alternate_result",
    ),
    providers: createRuntimeResearchProviders(context, input.cachePolicy),
    signal: context.abortSignal,
    maxAttempts: 12,
  });
  if (!fallback.output) {
    const attempted = fallback.attempts
      .filter((attempt) => attempt.status !== "unsupported")
      .map(
        (attempt) =>
          `${attempt.strategy}:${attempt.status}${attempt.reason ? `(${attempt.reason})` : ""}`,
      )
      .join(", ");
    throw new ToolExecutionError(
      input.failureCode,
      `${input.failureSummary}.${attempted ? ` Fallbacks: ${attempted}.` : ""}`,
    );
  }
  const effectiveUrl = normalizeWebFetchUrl(fallback.output.url || url);
  const fallbackCache = fallback.output.cachedSource ?? await writeSourceCacheNote(context, {
    url: effectiveUrl,
    title: fallback.output.title,
    content: fallback.output.content,
    parserStatus: normalizeParserStatus(fallback.output.parserStatus),
  });
  const usableAttempt = fallback.attempts.find(
    (attempt) => attempt.status === "usable",
  );
  return {
    title: fallback.output.title,
    url: effectiveUrl,
    normalizedUrl: fallbackCache.normalizedUrl,
    urlHash: fallbackCache.urlHash,
    query,
    content: truncateText(fallback.output.content, MAX_WEB_FETCH_CHARS),
    links: getProviderLinks(fallback.output.providerMetadata),
    fromCache: Boolean(fallback.output.cachedSource),
    sourceTransport: fallback.output.cachedSource ? "cache" : "network",
    fetchedForMission: fallbackCache.fetchedForMission,
    cachedPath: fallbackCache.vaultPath,
    fetchedAt: fallbackCache.fetchedAt,
    sourceChars: fallbackCache.sourceChars,
    totalChars: fallbackCache.totalChars,
    contentHash: fallbackCache.contentHash,
    truncated: fallbackCache.truncated,
    parserStatus: fallbackCache.parserStatus,
    cacheMaxAgeMs: maxAgeMs,
    section: 1,
    sectionCount: fallbackCache.sectionCount,
    fallbackUsed: true,
    retrievalStrategy: usableAttempt?.strategy,
    retrievalAttempts: fallback.attempts,
  };
}

export const readSourceSectionTool: AgentTool = {
  name: "read_source_section",
  description:
    "Read a numbered section from a cached full-text web source note by URL or cached vault path.",
  parameters: {
    type: "object",
    required: ["section"],
    properties: {
      url: { type: "string" },
      path: { type: "string" },
      section: {
        type: "integer",
        description: "One-based section number.",
      },
      query: {
        type: "string",
        description:
          "Optional research question or claim used to select model-facing evidence passages.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertOperationActive(context);
    const url = getOptionalString(args, "url");
    const path = getOptionalString(args, "path");
    if (!url && !path) {
      throw new Error("read_source_section requires url or path.");
    }
    const section = Math.max(1, getOptionalInteger(args, "section") ?? 1);
    const query = getEvidenceQuery(args, context.originalPrompt);
    const result = await readSourceSection(context, { url, path }, section);
    return {
      status: "ok",
      path,
      ...result,
      query,
    };
  },
};

function clampMaxResults(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_WEB_RESULTS;
  }

  return Math.min(Math.max(value, 1), MAX_WEB_RESULTS);
}

function buildHeaders(context: ToolExecutionContext): Record<string, string> {
  const apiKey = context.settings.ollamaApiKey.trim();
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function normalizeWebSearchResponse(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new Error("Ollama web_search returned an invalid response.");
  }

  return {
    results: body.results.slice(0, MAX_WEB_RESULTS).map((result) => {
      if (!isRecord(result)) {
        return emptySearchResult();
      }

      const content =
        typeof result.content === "string"
          ? result.content
          : typeof result.snippet === "string"
            ? result.snippet
            : "";
      const snippet =
        typeof result.snippet === "string"
          ? result.snippet
          : content;

      const normalizedSnippet = truncateText(snippet, MAX_WEB_SEARCH_SNIPPET_CHARS);
      const normalizedContent = truncateText(content, MAX_WEB_SEARCH_SNIPPET_CHARS);
      const normalized = {
        title: typeof result.title === "string" ? result.title : "",
        url: typeof result.url === "string" ? result.url : "",
        snippet: normalizedSnippet,
      };

      return content && content !== snippet
        ? { ...normalized, content: normalizedContent }
        : normalized;
    }),
  };
}

function emptySearchResult() {
  return {
    title: "",
    url: "",
    snippet: "",
  };
}

/**
 * Identify the client honestly when reading a page directly. Several of the
 * scholarly APIs this project already talks to ask for exactly that, and a
 * site that wants to refuse an agent should be able to.
 */
const DIRECT_FETCH_USER_AGENT_V1 =
  "AgenticResearcher/0.4 (+https://github.com/JoshuaNguyen123/Obsidian_research_agent)";

export interface NormalizedWebFetchV1 {
  title: string;
  url: string;
  content: string;
  fullContent: string;
  parserStatus: Exclude<SourceParserStatus, "legacy_unknown">;
  links: string[];
}

/**
 * Read a page with the plugin's own transport and turn it into source text.
 *
 * The URL has already been through the shared host policy, so this cannot be
 * pointed at the loopback interface or a private range. Non-text responses are
 * refused rather than stringified: a PDF belongs to `extract_document`, which
 * has a parser for it.
 *
 * Returns null when the page could not be read at all, which is the caller's
 * signal to look for a substitute source instead.
 */
async function directFetchReadableSourceV1(
  context: ToolExecutionContext,
  url: string,
): Promise<NormalizedWebFetchV1 | null> {
  let response;
  try {
    response = await requestWithRetry(context.httpTransport, {
      url,
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "User-Agent": DIRECT_FETCH_USER_AGENT_V1,
      },
      throw: false,
      timeoutMs: getOperationTimeoutMs(context),
      abortSignal: context.abortSignal,
    });
  } catch {
    return null;
  }
  if (response.status >= 400) return null;
  if (!isReadableTextContentTypeV1(response.headers?.["content-type"] ?? response.headers?.["Content-Type"])) {
    return null;
  }
  const body = typeof response.text === "string" && response.text
    ? response.text
    : response.json !== undefined
      ? JSON.stringify(response.json, null, 2)
      : "";
  if (!body.trim()) return null;
  const readable = /<\s*(?:html|body|div|p|article|main)\b/iu.test(body)
    ? htmlToReadableTextV1(body, { baseUrl: url })
    : { title: "", text: body, links: [] as string[] };
  const fullContent = readable.text.trim();
  return {
    title: readable.title || documentTitleFromUrlV1(url),
    url,
    content: truncateText(fullContent, MAX_WEB_FETCH_CHARS),
    fullContent,
    parserStatus: fullContent ? "parsed" : "empty",
    links: readable.links,
  };
}

/** A last-resort title so a cached source note is never nameless. */
function documentTitleFromUrlV1(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(last ?? parsed.hostname).replace(/[-_]+/gu, " ").trim() ||
      parsed.hostname;
  } catch {
    return url;
  }
}

function normalizeWebFetchResponse(body: unknown, url: string) {
  if (!isRecord(body)) {
    throw new Error("Ollama web_fetch returned an invalid response.");
  }

  const hasContentField = typeof body.content === "string";
  const fullContent = hasContentField ? body.content as string : "";
  const parserStatus: Exclude<SourceParserStatus, "legacy_unknown"> = !hasContentField
    ? "missing_content"
    : fullContent.trim()
      ? "parsed"
      : "empty";
  return {
    title: typeof body.title === "string" ? body.title : "",
    url,
    content: truncateText(fullContent, MAX_WEB_FETCH_CHARS),
    fullContent,
    parserStatus,
    links: Array.isArray(body.links)
      ? body.links.filter((link): link is string => typeof link === "string")
      : [],
  };
}

function createRuntimeResearchProviders(
  context: ToolExecutionContext,
  cachePolicy: ResolvedRetrievalCachePolicy,
): ResearchRetrievalProvider[] {
  const alternateProvider: ResearchRetrievalProvider = {
    id: "ollama-web-fetch",
    strategies: ["alternate_result"],
    async retrieve(candidate) {
      assertOperationActive(context);
      const normalizedUrl = normalizeWebFetchUrl(candidate.url);
      // The ladder is a last resort, and it used to reach it over the wire even
      // for a URL this run had already stored: this provider is a second
      // transport site that never consulted the source cache, so a primary
      // failure re-pulled bytes the vault already held and the owned-source
      // backend counted the hit twice. A stored copy answers the same
      // candidate; only a cache miss now costs a request.
      const substitute = await findFreshCachedSource(context, normalizedUrl, cachePolicy);
      if (substitute) {
        const storedContent = await readCachedSourceContent(
          context,
          substitute.vaultPath,
        );
        if (storedContent?.trim()) {
          return {
            title: substitute.title,
            url: normalizedUrl,
            content: storedContent,
            parserStatus: substitute.parserStatus,
            cachedSource: substitute,
            providerMetadata: { links: [] },
          };
        }
      }
      const baseUrl = normalizeOllamaBaseUrl(context.settings.ollamaBaseUrl);
      const response = await requestWithRetry(context.httpTransport, {
        url: `${baseUrl}/web_fetch`,
        method: "POST",
        contentType: "application/json",
        headers: buildHeaders(context),
        throw: false,
        timeoutMs: getOperationTimeoutMs(context),
        abortSignal: context.abortSignal,
        body: JSON.stringify({ url: normalizedUrl }),
      });
      if (response.status >= 400) {
        throw new Error(getHttpErrorMessage(response, "web_fetch"));
      }
      const normalized = normalizeWebFetchResponse(
        response.json ?? parseJsonText(response.text),
        normalizedUrl,
      );
      return {
        title: normalized.title,
        url: normalizedUrl,
        content: normalized.fullContent,
        parserStatus: normalized.parserStatus,
        providerMetadata: { links: normalized.links },
      };
    },
  };
  const browserProvider: ResearchRetrievalProvider = {
    id: "safe-companion-browser",
    // `document_extract` is no longer served here: rendering a PDF viewer's
    // HTML answers that strategy with junk or nothing. The document provider
    // parses the bytes instead, and the browser stays the general-page
    // extractor it actually is.
    strategies: ["browser_extract", "alternate_result"],
    async retrieve(candidate) {
      assertOperationActive(context);
      const normalizedUrl = normalizeWebFetchUrl(candidate.url);
      const opened = await browserOpenPageTool.execute(
        { url: normalizedUrl, missionMode: "extract_only" },
        context,
      );
      if (!isRecord(opened) || opened.status !== "ok") {
        throw new Error(getBrowserFallbackFailure(opened, "open"));
      }
      assertOperationActive(context);
      const extracted = await browserExtractMarkdownTool.execute(
        { includeLinks: true, maxChars: MAX_WEB_FETCH_CHARS },
        context,
      );
      if (!isRecord(extracted) || extracted.status !== "ok") {
        throw new Error(getBrowserFallbackFailure(extracted, "extract"));
      }
      const markdown =
        typeof extracted.markdown === "string" ? extracted.markdown : "";
      return {
        title:
          typeof extracted.title === "string"
            ? extracted.title
            : candidate.title ?? "",
        url:
          typeof extracted.url === "string" && extracted.url.trim()
            ? extracted.url
            : normalizedUrl,
        content: markdown,
        parserStatus: markdown.trim() ? "parsed" : "empty",
        providerMetadata: { browser: true },
      };
    },
  };
  // Tried in this order by `retrieveUsableResearchSource`: the document parser
  // sits ahead of the browser so a PDF is read as a document rather than as a
  // rendered viewer page.
  return [
    alternateProvider,
    createDocumentExtractProvider(context),
    browserProvider,
  ];
}

async function resolveFallbackUrls(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  query: string | undefined,
  primaryUrl: string,
  cachePolicy: ResolvedRetrievalCachePolicy,
): Promise<string[]> {
  const values = readAlternateUrlArgs(args.alternate_urls);
  // An open-access edition of the same work comes first: it is the same
  // source, readable, rather than a different source that happens to match the
  // query. Without it a paywalled DOI is simply a dead end.
  try {
    const openAccess = await resolveOpenAccessEditions({
      transport: context.httpTransport,
      url: primaryUrl,
      timeoutMs: getOperationTimeoutMs(context),
      signal: context.abortSignal,
    });
    values.unshift(...openAccess);
  } catch {
    // The resolver is an optimization; its failure must not cost the fallback.
  }
  if (query && values.length < 5) {
    try {
      const output = await webSearchTool.execute(
        { query, max_results: 5, refresh: cachePolicy.refresh, max_age_ms: cachePolicy.maxAgeMs },
        context,
      );
      if (isRecord(output) && Array.isArray(output.results)) {
        for (const result of output.results) {
          if (isRecord(result) && typeof result.url === "string") {
            values.push(result.url);
          }
        }
      }
    } catch {
      // Browser/document fallback can still run without alternate search results.
    }
  }
  const normalizedPrimary = normalizeWebFetchUrl(primaryUrl);
  const unique = new Set<string>();
  for (const raw of values) {
    try {
      const normalized = normalizeWebFetchUrl(raw);
      if (normalized !== normalizedPrimary) unique.add(normalized);
    } catch {
      // Search providers can return non-fetchable or unsafe URLs; skip them.
    }
  }
  return [...unique].slice(0, 5);
}

function readAlternateUrlArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "web_fetch alternate_urls must be an array of at most five URLs.",
    );
  }
  if (value.some((item) => typeof item !== "string")) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "web_fetch alternate_urls must contain only strings.",
    );
  }
  return value as string[];
}

function isDocumentLikeUrl(value: string): boolean {
  try {
    return /\.(?:pdf|docx?|pptx?|xlsx?)(?:$|[?#])/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function normalizeParserStatus(
  value: string | undefined,
): Exclude<SourceParserStatus, "legacy_unknown"> {
  return value === "parsed" ||
    value === "empty" ||
    value === "missing_content"
    ? value
    : "parsed";
}

function getProviderLinks(metadata: Record<string, unknown> | undefined): string[] {
  return Array.isArray(metadata?.links)
    ? metadata.links.filter((value): value is string => typeof value === "string")
    : [];
}

function getBrowserFallbackFailure(value: unknown, operation: string): string {
  if (isRecord(value)) {
    if (typeof value.reason === "string" && value.reason.trim()) return value.reason;
    if (typeof value.message === "string" && value.message.trim()) return value.message;
    if (isRecord(value.safetyDecision) && typeof value.safetyDecision.reason === "string") {
      return value.safetyDecision.reason;
    }
  }
  return `Companion browser could not ${operation} the source.`;
}

function getEvidenceQuery(
  args: Record<string, unknown>,
  originalPrompt: string,
): string | undefined {
  const explicit = getOptionalString(args, "query")?.trim();
  const value = explicit || originalPrompt.trim();
  return value ? value.replace(/\s+/g, " ").slice(0, 500) : undefined;
}

function normalizeWebFetchUrl(rawUrl: string): string {
  if (!rawUrl.trim()) {
    throw new Error("web_fetch URL cannot be empty.");
  }
  return normalizePublicFetchUrlV1(
    rawUrl,
    {
      invalid: "web_fetch URL is invalid.",
      scheme: "web_fetch only supports HTTP and HTTPS URLs.",
      credentials: "web_fetch URLs with credentials are not allowed.",
      privateHost: "web_fetch cannot fetch local or private network URLs.",
    },
    (message) => {
      throw new Error(message);
    },
  );
}

function parseJsonText(text: string | undefined): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getHttpErrorMessage(
  response: { status: number; json?: unknown; text?: string },
  toolName = "web_search",
) {
  const body = response.json ?? parseJsonText(response.text);

  if (isRecord(body) && typeof body.error === "string") {
    return body.error;
  }

  if (typeof body === "string" && body.trim()) {
    return body;
  }

  return `Ollama ${toolName} failed with status ${response.status}.`;
}

function assertOperationActive(context: ToolExecutionContext): void {
  if (context.abortSignal?.aborted) {
    throw new ToolExecutionError(
      "operation_cancelled",
      "Web operation cancelled before it started.",
    );
  }
  if (
    typeof context.deadlineAt === "number" &&
    Number.isFinite(context.deadlineAt) &&
    Date.now() >= context.deadlineAt
  ) {
    throw new ToolExecutionError(
      "operation_deadline_exceeded",
      "Web operation skipped because the run deadline expired.",
    );
  }
}

function getOperationTimeoutMs(context: ToolExecutionContext): number {
  const configured = Math.max(1, context.settings.requestTimeoutMs);
  if (
    typeof context.deadlineAt !== "number" ||
    !Number.isFinite(context.deadlineAt)
  ) {
    return configured;
  }
  return Math.max(1, Math.min(configured, context.deadlineAt - Date.now()));
}
