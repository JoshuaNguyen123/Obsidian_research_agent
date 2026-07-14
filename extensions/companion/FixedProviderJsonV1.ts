import https from "node:https";
import { Readable } from "node:stream";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 128 * 1024;

export interface FixedProviderJsonRequesterOptionsV1 {
  request?: typeof https.request;
  timeoutMs?: number;
  maximumResponseBytes?: number;
}

export interface FixedProviderJsonRequestInitV1 {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

/** Authenticated fixed-host JSON transport used by the standalone worker. */
export function createFixedProviderJsonRequesterV1(
  options: FixedProviderJsonRequesterOptionsV1 = {},
) {
  const requestHttps = options.request ?? https.request;
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    10,
    60_000,
    "provider timeout",
  );
  const maximumResponseBytes = boundedInteger(
    options.maximumResponseBytes ?? DEFAULT_RESPONSE_BYTES,
    1_024,
    4 * 1_048_576,
    "provider response limit",
  );
  return async function requestFixedProviderJsonV1(
    url: URL,
    init: FixedProviderJsonRequestInitV1,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) {
      throw new Error("Provider readback was aborted before dispatch.");
    }
    if (
      url.protocol !== "https:" ||
      !["api.linear.app", "api.github.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    ) {
      throw new Error("Provider request escaped the fixed HTTPS catalog.");
    }
    const bodyBytes = init.body ? Buffer.byteLength(init.body, "utf8") : 0;
    if (bodyBytes > MAX_REQUEST_BYTES) {
      throw new Error("Provider request exceeded its fixed body limit.");
    }
    let request: ReturnType<typeof https.request> | null = null;
    let incoming: import("node:http").IncomingMessage | null = null;
    const abort = () => {
      const error = new Error("Provider readback was aborted.");
      incoming?.destroy(error);
      request?.destroy(error);
    };
    const timeout = globalThis.setTimeout(() => {
      const error = new Error("Provider readback exceeded its bounded timeout.");
      incoming?.destroy(error);
      request?.destroy(error);
    }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    try {
      incoming = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        request = requestHttps(
          {
            protocol: "https:",
            hostname: url.hostname,
            port: 443,
            method: init.method,
            path: `${url.pathname}${url.search}`,
            headers: {
              ...init.headers,
              ...(init.body ? { "Content-Length": String(bodyBytes) } : {}),
            },
          },
          resolve,
        );
        request.once("error", reject);
        if (init.body) request.write(init.body);
        request.end();
      });
      const status = incoming.statusCode ?? 500;
      if ([301, 302, 303, 307, 308].includes(status)) {
        incoming.resume();
        throw new Error("Provider readback rejected an HTTP redirect.");
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
        else if (value !== undefined) headers.set(key, String(value));
      }
      const response = new Response(Readable.toWeb(incoming) as ReadableStream, {
        status,
        statusText: incoming.statusMessage,
        headers,
      });
      const text = await readProviderTextBoundedV1(response, maximumResponseBytes);
      if (!response.ok) {
        throw new Error(`Provider readback failed with HTTP ${response.status}.`);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("Provider readback returned invalid JSON.");
      }
    } finally {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  };
}

export const requestFixedProviderJsonV1 = createFixedProviderJsonRequesterV1();

async function readProviderTextBoundedV1(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Provider readback exceeded its fixed response limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside its fixed bounds.`);
  }
  return value;
}
