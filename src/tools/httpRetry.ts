import { parseRetryAfterMs } from "../model/retry";
import type { HttpRequest, HttpResponse, HttpTransport } from "../model/types";

/**
 * Retry a transient HTTP failure with bounded exponential backoff. Rate-limit
 * and server-side statuses are retried (a 4xx that is not a rate limit is a
 * caller error and returned immediately). The wait is abort-aware so a
 * cancelled run never blocks. Retry delays are injectable so tests stay fast.
 *
 * 500/502/504 join 503 here because a bare provider hiccup used to get zero
 * retries and end whole missions on the first blip; they are as transient as
 * the "temporarily unavailable" status they sit beside, and every caller is a
 * read. Thrown transport failures (DNS, reset, hang-up) use the same
 * `[400, 1200]` budget. AbortError is never retried.
 *
 * `Retry-After` is obeyed when the server sends it. The tool layer talks to
 * Crossref, OpenAlex, arXiv, PubMed and the Ollama retrieval endpoints, all of
 * which answer a burst with 429 and a wait — and every one of those 429s used
 * to consume the 400 ms and 1.2 s delays and then surface as a failed search,
 * because the waits were shorter than the wait the server asked for. The model
 * layer has honored the header since rate-limit budgets landed there
 * (`DEFAULT_MODEL_RETRY_POLICY`); this is the same rule at the other seat,
 * reading through the same parser rather than a second copy of it.
 */
export const MAX_TOOL_RETRY_AFTER_MS = 15_000;

export async function requestWithRetry(
  transport: HttpTransport,
  request: HttpRequest,
  options?: {
    retryDelaysMs?: number[];
    retryStatuses?: number[];
    maxRetryAfterMs?: number;
  },
): Promise<HttpResponse> {
  const delays = options?.retryDelaysMs ?? [400, 1200];
  const retryStatuses = new Set(
    options?.retryStatuses ?? [429, 500, 502, 503, 504],
  );
  const maxRetryAfterMs = options?.maxRetryAfterMs ?? MAX_TOOL_RETRY_AFTER_MS;
  let attempt = 0;
  for (;;) {
    try {
      const response = await transport(request);
      if (!retryStatuses.has(response.status) || attempt >= delays.length) {
        return response;
      }
      if (request.abortSignal?.aborted) {
        return response;
      }
      const waitMs = resolveRetryDelayMs(
        delays[attempt]!,
        response,
        maxRetryAfterMs,
      );
      if (waitMs === null) {
        // The server asked for longer than this seat is willing to hold a
        // mission step. Returning its answer now beats sleeping past the
        // caller's own deadline and then retrying anyway.
        return response;
      }
      await sleep(waitMs, request.abortSignal);
      attempt += 1;
    } catch (error) {
      // Cancellation is sacred: never convert a user abort into a retry.
      if (isAbortError(error)) {
        throw error;
      }
      if (request.abortSignal?.aborted || attempt >= delays.length) {
        throw error;
      }
      await sleep(delays[attempt]!, request.abortSignal);
      if (request.abortSignal?.aborted) {
        throw createAbortError();
      }
      attempt += 1;
    }
  }
}

/**
 * How long to wait before the next attempt: the backoff delay, or the server's
 * own `Retry-After` when that is longer. Null means "do not retry" — the
 * server named a wait past the cap.
 */
export function resolveRetryDelayMs(
  backoffMs: number,
  response: Pick<HttpResponse, "headers">,
  maxRetryAfterMs: number,
): number | null {
  const retryAfterMs = parseRetryAfterMs(response.headers);
  if (retryAfterMs === undefined) return backoffMs;
  if (retryAfterMs > maxRetryAfterMs) return null;
  return Math.max(backoffMs, retryAfterMs);
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener?.(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
