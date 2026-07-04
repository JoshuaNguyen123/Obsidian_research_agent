import { requestUrl } from "obsidian";
import type { AgentSettings } from "../settings";
import { OllamaClient } from "./OllamaClient";
import type {
  HttpRequest,
  HttpResponse,
  ModelClient,
  StreamingHttpResponse,
} from "./types";
import { ModelClientError as ModelClientErrorClass } from "./types";

type NodeHttpModule = typeof import("http");

export function createConfiguredModelClient(settings: AgentSettings): ModelClient {
  return new OllamaClient({
    baseUrl: settings.ollamaBaseUrl,
    apiKey: settings.ollamaApiKey,
    model: settings.model,
    transport: requestUrlTransport,
    streamingTransport: hybridStreamingTransport,
    requestTimeoutMs: settings.requestTimeoutMs,
  });
}

export async function requestUrlTransport(
  request: HttpRequest,
): Promise<HttpResponse> {
  const response = await withTimeout(
    requestUrl(request),
    request.timeoutMs,
    `Request timed out after ${request.timeoutMs}ms.`,
  );

  return {
    status: response.status,
    headers: response.headers,
    json: response.json,
    text: response.text,
    arrayBuffer: response.arrayBuffer,
  };
}

async function hybridStreamingTransport(
  request: HttpRequest,
): Promise<StreamingHttpResponse> {
  try {
    return await fetchStreamingTransport(request);
  } catch (fetchError) {
    try {
      return await nodeStreamingTransport(request);
    } catch (nodeError) {
      throw new Error(
        `Fetch streaming failed: ${getErrorMessage(fetchError)}. Desktop streaming fallback failed: ${getErrorMessage(nodeError)}.`,
      );
    }
  }
}

async function fetchStreamingTransport(
  request: HttpRequest,
): Promise<StreamingHttpResponse> {
  const headers = new Headers(request.headers ?? {});
  if (request.contentType && !headers.has("Content-Type")) {
    headers.set("Content-Type", request.contentType);
  }

  const controller = new AbortController();
  const timeout = startAbortTimeout(controller, request.timeoutMs);

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers,
      body: request.body,
      signal: controller.signal,
    });
  } catch (error) {
    clearAbortTimeout(timeout);
    if (controller.signal.aborted) {
      throw new ModelClientErrorClass(
        "network",
        `Request timed out after ${request.timeoutMs}ms.`,
        { originalError: error },
      );
    }

    throw error;
  }

  if (!response.body) {
    clearAbortTimeout(timeout);
    throw new Error("Streaming response body is unavailable.");
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    status: response.status,
    headers: responseHeaders,
    body: decodeStream(response.body, () => clearAbortTimeout(timeout)),
  };
}

async function* decodeStream(
  stream: ReadableStream<Uint8Array>,
  onDone?: () => void,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      yield decoder.decode(value, { stream: true });
    }

    const final = decoder.decode();
    if (final) {
      yield final;
    }
  } finally {
    onDone?.();
    reader.releaseLock();
  }
}

async function nodeStreamingTransport(
  request: HttpRequest,
): Promise<StreamingHttpResponse> {
  const url = new URL(request.url);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported streaming protocol: ${url.protocol}`);
  }

  const httpModule = getNodeHttpModule(url.protocol);
  const headers = buildNodeHeaders(request);
  const body = getRequestBodyBuffer(request.body);

  if (body && headers["Content-Length"] === undefined) {
    headers["Content-Length"] = String(body.byteLength);
  }

  return new Promise((resolve, reject) => {
    const req = httpModule.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method ?? "GET",
        headers,
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: normalizeNodeHeaders(response.headers),
          body: decodeNodeStream(response),
        });
      },
    );

    req.on("error", reject);
    if (request.timeoutMs && request.timeoutMs > 0) {
      req.setTimeout(request.timeoutMs, () => {
        req.destroy(
          new ModelClientErrorClass(
            "network",
            `Request timed out after ${request.timeoutMs}ms.`,
          ),
        );
      });
    }

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

function getNodeHttpModule(protocol: string): NodeHttpModule {
  const nodeRequire =
    typeof require === "function"
      ? require
      : typeof window !== "undefined" &&
          typeof (window as Window & { require?: NodeRequire }).require ===
            "function"
        ? (window as Window & { require: NodeRequire }).require
        : null;

  if (!nodeRequire) {
    throw new Error("Node require is unavailable for desktop streaming fallback.");
  }

  return protocol === "https:" ? nodeRequire("https") : nodeRequire("http");
}

function buildNodeHeaders(request: HttpRequest): Record<string, string> {
  const headers: Record<string, string> = { ...(request.headers ?? {}) };

  if (request.contentType && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = request.contentType;
  }

  return headers;
}

function getRequestBodyBuffer(body: HttpRequest["body"]): Buffer | null {
  if (body === undefined) {
    return null;
  }

  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }

  return Buffer.from(body);
}

function normalizeNodeHeaders(
  headers: import("http").IncomingHttpHeaders,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      normalized[key] = value.join(", ");
    } else if (value !== undefined) {
      normalized[key] = String(value);
    }
  }

  return normalized;
}

async function* decodeNodeStream(
  stream: AsyncIterable<Buffer | string>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      yield chunk;
    } else {
      yield decoder.decode(chunk, { stream: true });
    }
  }

  const final = decoder.decode();
  if (final) {
    yield final;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  message: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ModelClientErrorClass("network", message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

function startAbortTimeout(
  controller: AbortController,
  timeoutMs: number | undefined,
): ReturnType<typeof setTimeout> | undefined {
  if (!timeoutMs || timeoutMs <= 0) {
    return undefined;
  }

  return setTimeout(() => controller.abort(), timeoutMs);
}

function clearAbortTimeout(timeout: ReturnType<typeof setTimeout> | undefined) {
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
}
