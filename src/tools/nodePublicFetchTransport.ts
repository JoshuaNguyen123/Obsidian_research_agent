import type { IncomingMessage } from "http";

import { isUnsafeFetchHostV1 } from "./fetchHostPolicy";
import {
  PublicFetchErrorV1,
  type PublicFetchHopRequestV1,
  type PublicFetchHopResponseV1,
  type PublicFetchHopTransportV1,
} from "./publicFetch";

/**
 * The desktop hop transport for `fetchPublicUrlV1`: Node's `http`/`https`,
 * which never follows a redirect on its own, with the connection's own DNS
 * resolution routed through the host policy.
 *
 * Why Node rather than `requestUrl`: `requestUrl` follows redirects and hides
 * the final URL, so a redirect to a private address cannot be refused (see
 * `publicFetch.ts`). Renderer `fetch` would be subject to CORS for almost every
 * page. The plugin is desktop-only (`manifest.json`), so Node is always there.
 *
 * The one behaviour this gives up: Node does not read the system proxy the
 * way Chromium's network stack does, so a machine that can reach the web only
 * through a proxy loses the direct read. The retrieval endpoint path is
 * unaffected (it still goes through `requestUrl`).
 */

type LookupAddress = { address: string; family: number };
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
export type NodeLookupV1 = (
  hostname: string,
  options: { all?: boolean; family?: number } & Record<string, unknown>,
  callback: LookupCallback,
) => void;

export interface NodePublicFetchTransportDepsV1 {
  /** Injected for tests; defaults to `dns.lookup`. */
  lookup?: NodeLookupV1;
  /** Injected for tests; defaults to Node's `require`. */
  requireModule?: (id: string) => unknown;
}

export function createNodePublicFetchTransportV1(
  deps: NodePublicFetchTransportDepsV1 = {},
): PublicFetchHopTransportV1 {
  const load = deps.requireModule ?? resolveNodeRequire();
  return (request) => nodeHop(request, load, deps.lookup);
}

/**
 * Wrap a resolver so the connection can only reach addresses the host policy
 * accepts. The check runs on the answer the socket will connect to, so there
 * is no window for a second, different answer (DNS rebinding).
 */
export function guardedLookupV1(base: NodeLookupV1): NodeLookupV1 {
  return (hostname, options, callback) => {
    base(hostname, options, (error, address, family) => {
      if (error) {
        callback(error, address, family);
        return;
      }
      const answers: LookupAddress[] = Array.isArray(address)
        ? address
        : [{ address, family: family ?? 0 }];
      const unsafe = answers.find((answer) => isUnsafeFetchHostV1(answer.address));
      if (unsafe || answers.length === 0) {
        callback(
          new PublicFetchErrorV1(
            "resolved_private_address",
            `${hostname} resolves to ${unsafe?.address ?? "no address"}, which is not public`,
          ) as unknown as NodeJS.ErrnoException,
          address,
          family,
        );
        return;
      }
      callback(null, address, family);
    });
  };
}

function nodeHop(
  request: PublicFetchHopRequestV1,
  load: (id: string) => unknown,
  lookupOverride: NodeLookupV1 | undefined,
): Promise<PublicFetchHopResponseV1> {
  const url = new URL(request.url);
  const httpModule = load(url.protocol === "https:" ? "https" : "http") as typeof import("http");
  const baseLookup = lookupOverride ?? ((load("dns") as typeof import("dns")).lookup as unknown as NodeLookupV1);
  const zlib = load("zlib") as typeof import("zlib");

  return new Promise<PublicFetchHopResponseV1>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: PublicFetchHopResponseV1) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      unlinkAbort();
      if (error) reject(error);
      else resolve(value!);
    };

    const req = httpModule.request(
      {
        protocol: url.protocol,
        // Node wants an IPv6 literal without its brackets.
        hostname: url.hostname.replace(/^\[|\]$/gu, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { "Accept-Encoding": "gzip, deflate, br", ...request.headers },
        lookup: guardedLookupV1(baseLookup) as never,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const headers = normalizeHeaders(response.headers);
        if (status >= 300 && status < 400) {
          // A redirect's body is never read; the caller judges Location.
          response.resume();
          finish(null, { status, headers, bytes: new Uint8Array(0), truncated: false });
          return;
        }
        readCappedBody(response, headers["content-encoding"], zlib, request.maxBytes)
          .then(({ bytes, truncated }) => {
            if (truncated) req.destroy();
            finish(null, { status, headers, bytes, truncated });
          })
          .catch((error) => finish(error));
      },
    );

    const deadline = setTimeout(() => {
      const error = new Error(`Request timed out after ${request.timeoutMs}ms.`);
      req.destroy(error);
      finish(error);
    }, Math.max(1, request.timeoutMs));
    const unlinkAbort = linkAbort(request.abortSignal, () => {
      const error = new DOMException("The operation was aborted.", "AbortError");
      req.destroy(error);
      finish(error);
    });
    req.on("error", (error) => finish(error));
    req.end();
  });
}

/**
 * Read at most `maxBytes` of the DECODED body. The cap applies after
 * decompression so a small gzip bomb cannot expand past it.
 */
function readCappedBody(
  response: IncomingMessage,
  encoding: string | undefined,
  zlib: typeof import("zlib"),
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const kind = (encoding ?? "").trim().toLowerCase();
  const stream: NodeJS.ReadableStream =
    kind === "gzip" || kind === "x-gzip"
      ? response.pipe(zlib.createGunzip())
      : kind === "deflate"
        ? response.pipe(zlib.createInflate())
        : kind === "br"
          ? response.pipe(zlib.createBrotliDecompress())
          : response;
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const complete = (truncated: boolean) => {
      if (done) return;
      done = true;
      const bytes = new Uint8Array(Math.min(total, maxBytes));
      let offset = 0;
      for (const chunk of chunks) {
        const take = Math.min(chunk.byteLength, bytes.byteLength - offset);
        if (take <= 0) break;
        bytes.set(chunk.subarray(0, take), offset);
        offset += take;
      }
      resolve({ bytes, truncated });
    };
    stream.on("data", (chunk: Buffer | string) => {
      if (done) return;
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      chunks.push(data);
      total += data.byteLength;
      if (total > maxBytes) {
        complete(true);
        response.destroy();
      }
    });
    stream.on("end", () => complete(false));
    stream.on("error", (error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    });
  });
}

function normalizeHeaders(
  headers: import("http").IncomingHttpHeaders,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) normalized[key.toLowerCase()] = value.join(", ");
    else if (value !== undefined) normalized[key.toLowerCase()] = String(value);
  }
  return normalized;
}

function linkAbort(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    queueMicrotask(onAbort);
    return () => undefined;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function resolveNodeRequire(): (id: string) => unknown {
  const nodeRequire =
    typeof require === "function"
      ? require
      : typeof window !== "undefined" &&
          typeof (window as Window & { require?: NodeRequire }).require === "function"
        ? (window as Window & { require: NodeRequire }).require
        : null;
  if (!nodeRequire) {
    return () => {
      throw new Error("Node modules are unavailable; the direct read needs the desktop app.");
    };
  }
  return nodeRequire;
}
