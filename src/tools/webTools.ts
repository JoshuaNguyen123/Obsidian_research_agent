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
import type { AgentTool, ToolExecutionContext } from "./types";
import {
  getOptionalInteger,
  getRequiredString,
  isRecord,
  truncateText,
} from "./validation";

export function createWebTools(): AgentTool[] {
  return [webSearchTool, webFetchTool];
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
      timeoutMs: context.settings.requestTimeoutMs,
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
    "Fetch one web page by URL through the configured Ollama-compatible endpoint.",
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        description: "HTTP or HTTPS URL to fetch.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const url = normalizeWebFetchUrl(getRequiredString(args, "url"));
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
      timeoutMs: context.settings.requestTimeoutMs,
      body: JSON.stringify({ url }),
    };

    const response = await context.httpTransport(request);
    if (response.status >= 400) {
      throw new Error(getHttpErrorMessage(response, "web_fetch"));
    }

    return normalizeWebFetchResponse(
      response.json ?? parseJsonText(response.text),
      url,
    );
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

  return {
    title: typeof body.title === "string" ? body.title : "",
    url,
    content: truncateText(
      typeof body.content === "string" ? body.content : "",
      MAX_WEB_FETCH_CHARS,
    ),
    links: Array.isArray(body.links)
      ? body.links.filter((link): link is string => typeof link === "string")
      : [],
  };
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
