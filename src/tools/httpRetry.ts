import type { HttpRequest, HttpResponse, HttpTransport } from "../model/types";

/**
 * Retry a transient HTTP failure with bounded exponential backoff. Only
 * rate-limit / temporary-unavailable statuses are retried (a 4xx that is not a
 * rate limit is a caller error and returned immediately). The wait is
 * abort-aware so a cancelled run never blocks. Retry delays are injectable so
 * tests stay fast.
 */
export async function requestWithRetry(
  transport: HttpTransport,
  request: HttpRequest,
  options?: { retryDelaysMs?: number[]; retryStatuses?: number[] },
): Promise<HttpResponse> {
  const delays = options?.retryDelaysMs ?? [400, 1200];
  const retryStatuses = new Set(options?.retryStatuses ?? [429, 503]);
  let attempt = 0;
  for (;;) {
    const response = await transport(request);
    if (!retryStatuses.has(response.status) || attempt >= delays.length) {
      return response;
    }
    if (request.abortSignal?.aborted) {
      return response;
    }
    await sleep(delays[attempt]!, request.abortSignal);
    attempt += 1;
  }
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
