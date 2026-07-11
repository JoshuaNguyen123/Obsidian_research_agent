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
import {
  ToolExecutionError,
  type AgentTool,
  type ToolExecutionContext,
} from "./types";
import {
  getOptionalBoolean,
  getOptionalInteger,
  getOptionalString,
  getRequiredString,
  isRecord,
  truncateText,
} from "./validation";
import {
  SOURCE_CACHE_FRESH_MS,
  SOURCE_CACHE_MAX_AGE_MS,
  findFreshCachedSource,
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

export function createWebTools(): AgentTool[] {
  return [webSearchTool, webFetchTool, readSourceSectionTool];
}

export const webSearchTool: AgentTool = {
  name: "web_search",
  description: "Search the web through the configured Ollama-compatible endpoint.",
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

    const response = await context.httpTransport(request);
    if (response.status >= 400) {
      throw new Error(getHttpErrorMessage(response));
    }

    return normalizeWebSearchResponse(response.json ?? parseJsonText(response.text));
  },
};

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
          "Bypass cached content. Use for current/latest claims; freshness-sensitive missions default to true when no cache policy is supplied.",
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
    const requestedMaxAgeMs = getOptionalInteger(args, "max_age_ms");
    const maxAgeMs = getCacheMaxAgeMs(requestedMaxAgeMs);
    const requestedRefresh = getOptionalBoolean(args, "refresh");
    const refresh = requestedRefresh ?? (
      requestedMaxAgeMs === undefined &&
      isFreshnessSensitivePrompt(context.originalPrompt)
    );
    const query = getEvidenceQuery(args, context.originalPrompt);
    const cached = await findFreshCachedSource(context, url, {
      maxAgeMs,
      refresh,
    });
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

    if (isOllamaCloudBaseUrl(baseUrl) && !context.settings.ollamaApiKey.trim()) {
      throw new Error(
        "Ollama web_fetch requires an API key. Add one in Agentic Researcher settings.",
      );
    }

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

    const response = await context.httpTransport(request);
    if (response.status >= 400) {
      throw new Error(getHttpErrorMessage(response, "web_fetch"));
    }

    const normalized = normalizeWebFetchResponse(
      response.json ?? parseJsonText(response.text),
      url,
    );
    const sourceUsability = evaluateSourceUsability({
      content: normalized.fullContent,
      sourceLocator: url,
      query,
      parserStatus: normalized.parserStatus,
    });
    if (!sourceUsability.usable) {
      const alternateUrls = await resolveFallbackUrls(args, context, query, url);
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
        providers: createRuntimeResearchProviders(context),
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
          "source_unusable",
          `web_fetch could not extract usable source passages from ${url} (${sourceUsability.reason}).${attempted ? ` Fallbacks: ${attempted}.` : ""}`,
        );
      }
      const effectiveUrl = normalizeWebFetchUrl(fallback.output.url || url);
      const fallbackCache = await writeSourceCacheNote(context, {
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
        fromCache: false,
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
): ResearchRetrievalProvider[] {
  const alternateProvider: ResearchRetrievalProvider = {
    id: "ollama-web-fetch",
    strategies: ["alternate_result"],
    async retrieve(candidate) {
      assertOperationActive(context);
      const normalizedUrl = normalizeWebFetchUrl(candidate.url);
      const baseUrl = normalizeOllamaBaseUrl(context.settings.ollamaBaseUrl);
      const response = await context.httpTransport({
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
    strategies: ["browser_extract", "document_extract", "alternate_result"],
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
  return [alternateProvider, browserProvider];
}

async function resolveFallbackUrls(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  query: string | undefined,
  primaryUrl: string,
): Promise<string[]> {
  const values = readAlternateUrlArgs(args.alternate_urls);
  if (query && values.length < 5) {
    try {
      const output = await webSearchTool.execute(
        { query, max_results: 5 },
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

function getCacheMaxAgeMs(value: number | undefined): number {
  if (value === undefined) {
    return SOURCE_CACHE_FRESH_MS;
  }
  if (value < 0 || value > SOURCE_CACHE_MAX_AGE_MS) {
    throw new Error(
      `web_fetch max_age_ms must be between 0 and ${SOURCE_CACHE_MAX_AGE_MS}.`,
    );
  }
  return value;
}

function getEvidenceQuery(
  args: Record<string, unknown>,
  originalPrompt: string,
): string | undefined {
  const explicit = getOptionalString(args, "query")?.trim();
  const value = explicit || originalPrompt.trim();
  return value ? value.replace(/\s+/g, " ").slice(0, 500) : undefined;
}

function isFreshnessSensitivePrompt(prompt: string): boolean {
  return /\b(current(?:ly)?|latest|today|now|recent|newest|up[- ]to[- ]date|as of)\b/i.test(
    prompt,
  );
}

function normalizeWebFetchUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("web_fetch URL cannot be empty.");
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;

  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("web_fetch URL is invalid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch only supports HTTP and HTTPS URLs.");
  }

  if (url.username || url.password) {
    throw new Error("web_fetch URLs with credentials are not allowed.");
  }

  if (isUnsafeHost(url.hostname)) {
    throw new Error("web_fetch cannot fetch local or private network URLs.");
  }

  url.hash = "";
  return url.toString();
}

function isUnsafeHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }

  if (
    normalized.includes(":") &&
    (/^(fc|fd)/.test(normalized) || normalized.startsWith("fe80:"))
  ) {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!ipv4) {
    return false;
  }

  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return true;
  }

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first === 169 && second === 254 ||
    first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168
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
