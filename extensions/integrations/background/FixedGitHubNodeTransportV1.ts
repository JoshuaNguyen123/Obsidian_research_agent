import https from "node:https";

import type { HttpRequest, HttpResponse, HttpTransport } from "../../../src/model/types";

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface FixedGitHubNodeTransportOptionsV1 {
  request?: typeof https.request;
}

/** Closed HTTPS transport accepted by GitHubRestClient in the companion. */
export function createFixedGitHubNodeTransportV1(
  options: FixedGitHubNodeTransportOptionsV1 = {},
): HttpTransport {
  const requestHttps = options.request ?? https.request;
  return async (input) => requestFixedGitHub(input, requestHttps);
}

async function requestFixedGitHub(
  input: HttpRequest,
  requestHttps: typeof https.request,
): Promise<HttpResponse> {
  if (input.abortSignal?.aborted) {
    throw new Error("GitHub provider request was cancelled before dispatch.");
  }
  const url = new URL(input.url);
  const method = String(input.method ?? "GET").toUpperCase();
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !isCatalogRequest(method, url)
  ) {
    throw new Error("GitHub request escaped the fixed provider catalog.");
  }
  const body = input.body === undefined
    ? null
    : typeof input.body === "string"
      ? Buffer.from(input.body, "utf8")
      : Buffer.from(input.body);
  if (body && body.byteLength > MAX_REQUEST_BYTES) {
    throw new Error("GitHub request exceeded the fixed body limit.");
  }
  const timeoutMs = Math.max(1_000, Math.min(60_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const authorization = input.headers?.Authorization;
  if (!authorization || !/^Bearer [\x21-\x7e]{1,4096}$/u.test(authorization)) {
    throw new Error("GitHub request is missing its action-scoped bearer credential.");
  }
  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof https.request> | null = null;
    const abort = () => request?.destroy(new Error("GitHub provider request was cancelled."));
    const finish = (error: Error | null, response?: HttpResponse) => {
      if (settled) return;
      settled = true;
      input.abortSignal?.removeEventListener("abort", abort);
      error ? reject(redactedTransportError(error)) : resolve(response!);
    };
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    if (input.abortSignal?.aborted) {
      finish(new Error("GitHub provider request was cancelled before dispatch."));
      return;
    }
    request = requestHttps({
      protocol: "https:",
      hostname: "api.github.com",
      port: 443,
      method,
      path: `${url.pathname}${url.search}`,
      headers: {
        Accept: input.headers?.Accept ?? "application/vnd.github+json",
        Authorization: authorization,
        "Content-Type": input.contentType ?? "application/json",
        "User-Agent": "AgenticResearcherCompanion/0.3",
        "X-GitHub-Api-Version": input.headers?.["X-GitHub-Api-Version"] ?? "2022-11-28",
        ...(body ? { "Content-Length": String(body.byteLength) } : {}),
      },
      timeout: timeoutMs,
    }, (incoming) => {
      const status = incoming.statusCode ?? 500;
      if ([301, 302, 303, 307, 308].includes(status)) {
        incoming.resume();
        finish(new Error("GitHub provider redirect was rejected."));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          request?.destroy(new Error("GitHub response exceeded its fixed byte limit."));
          return;
        }
        chunks.push(chunk);
      });
      incoming.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown = undefined;
        if (text.length > 0) {
          try { json = JSON.parse(text); } catch { /* GitHubRestClient validates the response. */ }
        }
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
        }
        finish(null, { status, headers, text, ...(json === undefined ? {} : { json }) });
      });
    });
    if (input.abortSignal?.aborted) {
      request.destroy(new Error("GitHub provider request was cancelled before dispatch."));
    }
    request.once("timeout", () => request?.destroy(new Error("GitHub provider request timed out.")));
    request.once("error", (error) => finish(error));
    if (body) request.write(body);
    request.end();
  });
}

function isCatalogRequest(method: string, url: URL): boolean {
  const path = url.pathname;
  if (method === "GET" && path === "/user" && url.search === "") return true;
  if (method === "POST" && path === "/graphql" && url.search === "") return true;
  if (!/^\/repos\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(?:\/.*)?$/u.test(path)) return false;
  const allowed = [
    ["GET", /^\/repos\/[^/]+\/[^/]+$/u, new Set<string>()],
    ["GET", /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/.+$/u, new Set<string>()],
    ["GET", /^\/repos\/[^/]+\/[^/]+\/pulls$/u, new Set(["state", "head", "base", "per_page"])],
    ["POST", /^\/repos\/[^/]+\/[^/]+\/pulls$/u, new Set<string>()],
    ["GET", /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/u, new Set<string>()],
    ["GET", /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/u, new Set(["per_page"])],
    ["GET", /^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs$/u, new Set(["per_page"])],
    ["GET", /^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/status$/u, new Set(["per_page"])],
    ["PUT", /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/u, new Set<string>()],
  ] as const;
  const match = allowed.find(([candidate, pattern]) => candidate === method && pattern.test(path));
  if (!match) return false;
  return [...url.searchParams.keys()].every((key) => match[2].has(key));
}

function redactedTransportError(error: Error): Error {
  const safe = error.message.slice(0, 500).replace(/(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu, "[REDACTED]");
  return new Error(safe || "GitHub provider transport failed.");
}
