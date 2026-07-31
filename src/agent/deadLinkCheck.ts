/**
 * Pre-finalization liveness recheck for cited sources.
 *
 * A source's content hash attests what was fetched, not that the page is still
 * reachable now — a URL can 404 between the fetch and the moment a deliverable
 * is handed off (especially across durable, multi-segment runs). This module
 * probes cited URLs and reports the ones that are definitively gone.
 *
 * It is deliberately conservative: only an unambiguous 404/410 is treated as
 * dead. Bot-blocking 4xx and transient 5xx / network errors are "unknown" so a
 * flaky server hiccup never wrongly rejects a genuine source.
 */

export type LivenessStatus = "alive" | "dead" | "unknown";

/** Returns the HTTP status, or null on a network error / timeout. */
export type LivenessProbe = (
  url: string,
  signal?: AbortSignal,
) => Promise<number | null>;

export interface LinkLivenessResult {
  url: string;
  status: number | null;
  liveness: LivenessStatus;
}

/** Minimal transport shape this module needs; avoids importing the tool types. */
export type LivenessTransport = (request: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  throw?: boolean;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}) => Promise<{ status: number }>;

/**
 * Build a probe over an HTTP transport: HEAD first, falling back to a
 * single-byte ranged GET when the server rejects HEAD outright (405/501).
 *
 * Shared by the worker and single-agent paths so the two cannot drift into
 * disagreeing about whether a link is dead. Any thrown error becomes `null`,
 * which `classifyLiveness` reads as "unknown" rather than "dead".
 */
export function buildLivenessProbe(
  transport: LivenessTransport,
  options: { timeoutMs?: number } = {},
): LivenessProbe {
  const timeoutMs = Math.max(1_000, Math.min(10_000, options.timeoutMs ?? 8_000));
  return async (url, signal) => {
    try {
      const head = await transport({
        url,
        method: "HEAD",
        throw: false,
        timeoutMs,
        abortSignal: signal,
      });
      if (head.status === 405 || head.status === 501) {
        const ranged = await transport({
          url,
          method: "GET",
          headers: { Range: "bytes=0-0" },
          throw: false,
          timeoutMs,
          abortSignal: signal,
        });
        return ranged.status;
      }
      return head.status;
    } catch {
      return null;
    }
  };
}

export function classifyLiveness(status: number | null): LivenessStatus {
  if (status === null) return "unknown";
  if (status === 404 || status === 410) return "dead";
  if (status >= 200 && status < 400) return "alive";
  // 401/403/405/429 (bot walls, rate limits) and 5xx (transient) are not proof
  // that the resource is gone.
  return "unknown";
}

export async function recheckLinkLiveness(input: {
  urls: readonly string[];
  probe: LivenessProbe;
  maxChecks?: number;
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<LinkLivenessResult[]> {
  const candidates = dedupeHttpUrls(input.urls).slice(
    0,
    Math.max(0, input.maxChecks ?? 6),
  );
  const results: LinkLivenessResult[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      if (input.signal?.aborted) return;
      const url = candidates[cursor++]!;
      let status: number | null;
      try {
        status = await input.probe(url, input.signal);
      } catch {
        status = null;
      }
      results.push({ url, status, liveness: classifyLiveness(status) });
    }
  };
  const lanes = Math.max(
    1,
    Math.min(input.concurrency ?? 3, candidates.length),
  );
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}

export function deadLinks(
  results: readonly LinkLivenessResult[],
): LinkLivenessResult[] {
  return results.filter((result) => result.liveness === "dead");
}

function dedupeHttpUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of urls) {
    const trimmed = (value ?? "").trim();
    if (!/^https?:\/\//i.test(trimmed)) continue;
    const key = trimmed.split("#")[0]!.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
