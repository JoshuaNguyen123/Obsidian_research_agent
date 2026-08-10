/**
 * Retry policy for the background semantic-index flush loop.
 *
 * A failing vault rebuild used to reschedule itself every 30 seconds forever
 * (the bootstrap flag only cleared on success), so one persistent failure —
 * e.g. an oversized embed response — re-ran a full vault embed roughly every
 * 3.5 minutes for as long as Obsidian stayed open. Failures now back off
 * exponentially and suspend after a bounded number of consecutive attempts.
 */
export const SEMANTIC_INDEX_RETRY_BASE_MS = 30_000;
export const SEMANTIC_INDEX_RETRY_MAX_DELAY_MS = 30 * 60_000;
export const SEMANTIC_INDEX_MAX_AUTO_RETRIES = 5;

/**
 * Delay before retry N (1-based consecutive failure count): 30s, 60s, 120s,
 * 240s, ... capped at 30 minutes. Non-positive counts behave like the first
 * failure.
 */
export function computeSemanticIndexRetryDelayMs(
  consecutiveFailures: number,
): number {
  const attempt = Math.max(1, Math.trunc(consecutiveFailures));
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(
    SEMANTIC_INDEX_RETRY_BASE_MS * 2 ** exponent,
    SEMANTIC_INDEX_RETRY_MAX_DELAY_MS,
  );
}
