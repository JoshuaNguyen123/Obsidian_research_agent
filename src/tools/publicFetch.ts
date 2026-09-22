import type { HttpTransport } from "../model/types";
import { isUnsafeFetchHostV1 } from "./fetchHostPolicy";
import { isAbortError, requestWithRetry } from "./httpRetry";

/**
 * Fetch a URL the model chose, one hop at a time, re-checking every hop.
 *
 * `web_fetch`'s direct read and `document_extract` used Obsidian's
 * `requestUrl`, which follows redirects itself and never reports where it
 * ended up. The host policy checked the URL the model asked for and nothing
 * after it, so a public page answering `302 Location: http://127.0.0.1:8765/`
 * (the companion) or `http://169.254.169.254/` (cloud metadata) was fetched,
 * and the body became a cited source.
 *
 * The rule here is that no request leaves for a host the policy has not
 * judged:
 *
 * - The transport performs exactly one request and never follows a redirect.
 *   This loop reads `Location`, resolves it against the current URL, and runs
 *   the same host policy on it before the next hop.
 * - The desktop transport (`nodePublicFetchTransport.ts`) also checks the
 *   addresses a name resolves to, inside the resolver hook the connection
 *   itself uses. That closes both a public name that points at a private
 *   address and DNS rebinding, because no second resolution happens between
 *   the check and the connect.
 * - A body is capped while it streams. The cap is a truncation, not a
 *   failure, for text, because the reader only keeps a bounded prefix anyway.
 *
 * When no hop transport is supplied (unit tests, a host without Node), the
 * loop runs over the plain `httpTransport`. That path cannot see redirects,
 * and the result says so in `redirectsChecked: false` rather than implying
 * a check that did not happen.
 */

export const MAX_PUBLIC_FETCH_REDIRECTS_V1 = 5;

export interface PublicFetchHopRequestV1 {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  /** Stop reading the body past this many bytes and report truncation. */
  maxBytes: number;
}

export interface PublicFetchHopResponseV1 {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
  truncated: boolean;
}

/** One request, no redirect following. Throws PublicFetchErrorV1 on refusal. */
export type PublicFetchHopTransportV1 = (
  request: PublicFetchHopRequestV1,
) => Promise<PublicFetchHopResponseV1>;

export type PublicFetchRefusalV1 =
  | "private_host"
  | "redirect_to_private_host"
  | "resolved_private_address"
  | "unsupported_redirect_scheme"
  | "too_many_redirects"
  | "redirect_without_location";

export class PublicFetchErrorV1 extends Error {
  readonly code: PublicFetchRefusalV1;
  constructor(code: PublicFetchRefusalV1, message: string) {
    super(message);
    this.name = "PublicFetchError";
    this.code = code;
  }
}

export interface PublicFetchResultV1 {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
  truncated: boolean;
  /** The URL whose response this is, after any redirects. */
  finalUrl: string;
  /** Every URL a redirect pointed at, in order. */
  redirects: string[];
  /** False when the transport followed redirects out of this loop's sight. */
  redirectsChecked: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchPublicUrlV1(input: {
  url: string;
  hopTransport?: PublicFetchHopTransportV1;
  httpTransport: HttpTransport;
  headers: Record<string, string>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  maxBytes: number;
  maxRedirects?: number;
  retryDelaysMs?: number[];
}): Promise<PublicFetchResultV1> {
  const maxRedirects = input.maxRedirects ?? MAX_PUBLIC_FETCH_REDIRECTS_V1;
  const hop = input.hopTransport ?? opaqueRedirectHopTransport(input.httpTransport);
  const redirectsChecked = Boolean(input.hopTransport);
  const redirects: string[] = [];
  let current = input.url;
  assertPublicHop(current, "private_host");
  for (;;) {
    const response = await retryingHop(hop, {
      url: current,
      headers: input.headers,
      timeoutMs: input.timeoutMs,
      abortSignal: input.abortSignal,
      maxBytes: input.maxBytes,
    }, input.retryDelaysMs);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return {
        ...response,
        finalUrl: current,
        redirects,
        redirectsChecked,
      };
    }
    const location = headerValue(response.headers, "location");
    if (!location) {
      throw new PublicFetchErrorV1(
        "redirect_without_location",
        `HTTP ${response.status} redirect carried no Location header`,
      );
    }
    if (redirects.length >= maxRedirects) {
      throw new PublicFetchErrorV1(
        "too_many_redirects",
        `more than ${maxRedirects} redirects`,
      );
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new PublicFetchErrorV1(
        "redirect_without_location",
        "redirect Location is not a valid URL",
      );
    }
    next.hash = "";
    current = next.toString();
    redirects.push(current);
    assertPublicHop(current, "redirect_to_private_host");
  }
}

/** Case-insensitive header read; Node lowercases, requestUrl may not. */
export function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Human-readable reason a fetch failed, for the error the model and user see. */
export function describePublicFetchFailureV1(error: unknown): string {
  if (error instanceof PublicFetchErrorV1) {
    switch (error.code) {
      case "redirect_to_private_host":
        return "it redirected to a local or private network address";
      case "resolved_private_address":
        return "its host name resolves to a local or private network address";
      case "private_host":
        return "it names a local or private network address";
      case "unsupported_redirect_scheme":
        return "it redirected to a non-HTTP address";
      default:
        return error.message;
    }
  }
  if (isAbortError(error)) return "the request was cancelled";
  if (error instanceof Error && error.message) return error.message;
  return "the request failed";
}

function assertPublicHop(url: string, code: PublicFetchRefusalV1): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PublicFetchErrorV1(code, `${url} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PublicFetchErrorV1(
      "unsupported_redirect_scheme",
      `${parsed.protocol} is not an HTTP scheme`,
    );
  }
  if (parsed.username || parsed.password || isUnsafeFetchHostV1(parsed.hostname)) {
    throw new PublicFetchErrorV1(code, `${parsed.hostname} is not a public host`);
  }
}

/**
 * Transient statuses are retried per hop through the shared tool retry policy
 * (429 and 5xx, `Retry-After` honoured), so moving off `requestUrl` does not
 * cost the retries the direct read already had.
 */
async function retryingHop(
  hop: PublicFetchHopTransportV1,
  request: PublicFetchHopRequestV1,
  retryDelaysMs: number[] | undefined,
): Promise<PublicFetchHopResponseV1> {
  let last: PublicFetchHopResponseV1 | null = null;
  let refusal: PublicFetchErrorV1 | null = null;
  await requestWithRetry(
    async () => {
      try {
        last = await hop(request);
      } catch (error) {
        // A refusal is a verdict, not a transient failure: a private address
        // does not become public on the next attempt. Status 0 is outside
        // the retry set, so the retry loop hands it straight back.
        if (error instanceof PublicFetchErrorV1) {
          refusal = error;
          return { status: 0, headers: {} };
        }
        throw error;
      }
      return { status: last.status, headers: last.headers };
    },
    {
      url: request.url,
      method: "GET",
      timeoutMs: request.timeoutMs,
      abortSignal: request.abortSignal,
    },
    retryDelaysMs ? { retryDelaysMs } : undefined,
  );
  if (refusal) throw refusal;
  return last!;
}

/**
 * The fallback hop over a transport that follows redirects itself. It still
 * enforces the byte cap after the fact, but it cannot re-check redirects,
 * which is why the loop reports `redirectsChecked: false` for it.
 */
function opaqueRedirectHopTransport(
  transport: HttpTransport,
): PublicFetchHopTransportV1 {
  return async (request) => {
    const response = await transport({
      url: request.url,
      method: "GET",
      headers: request.headers,
      throw: false,
      timeoutMs: request.timeoutMs,
      abortSignal: request.abortSignal,
    });
    let bytes: Uint8Array;
    if (response.arrayBuffer && response.arrayBuffer.byteLength > 0) {
      bytes = new Uint8Array(response.arrayBuffer);
    } else if (typeof response.text === "string") {
      bytes = new TextEncoder().encode(response.text);
    } else if (response.json !== undefined) {
      bytes = new TextEncoder().encode(JSON.stringify(response.json, null, 2));
    } else {
      bytes = new Uint8Array(0);
    }
    const truncated = bytes.byteLength > request.maxBytes;
    return {
      status: response.status,
      headers: response.headers ?? {},
      bytes: truncated ? bytes.subarray(0, request.maxBytes) : bytes,
      truncated,
    };
  };
}

/** Decode a text body using the charset the response declares, else UTF-8. */
export function decodePublicFetchText(
  bytes: Uint8Array,
  contentType: string | undefined,
): string {
  const charset = /charset\s*=\s*"?([^";\s]+)/iu.exec(contentType ?? "")?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      // Unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * True when an unlabelled body is evidently binary. A missing Content-Type
 * used to mean "read it as text", which turned an unlabelled PDF or image into
 * a garbage source. NUL bytes and the common magic numbers are enough to tell.
 */
export function looksBinaryV1(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  if (head.length >= 4) {
    const magic = String.fromCharCode(head[0]!, head[1]!, head[2]!, head[3]!);
    if (magic === "%PDF" || magic.startsWith("PK") || magic.startsWith("\x89PNG") || magic.startsWith("GIF8")) {
      return true;
    }
    if (head[0] === 0xff && head[1] === 0xd8) return true; // JPEG
  }
  for (const byte of head) {
    if (byte === 0) return true;
  }
  return false;
}
