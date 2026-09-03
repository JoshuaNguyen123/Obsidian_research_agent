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
 */
export async function requestWithRetry(
  transport: HttpTransport,
  request: HttpRequest,
  options?: { retryDelaysMs?: number[]; retryStatuses?: number[] },
): Promise<HttpResponse> {
  const delays = options?.retryDelaysMs ?? [400, 1200];
  const retryStatuses = new Set(
    options?.retryStatuses ?? [429, 500, 502, 503, 504],
  );
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
      await sleep(delays[attempt]!, request.abortSignal);
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
