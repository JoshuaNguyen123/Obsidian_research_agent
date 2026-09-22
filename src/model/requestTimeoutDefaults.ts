/**
 * Timeout defaults used by settings and createModelClient.
 * Kept out of settings.ts so unit tests can import them without loading
 * the Obsidian settings tab module.
 */
export const DEFAULT_STREAM_REQUEST_TIMEOUT_MS = 180_000;
export const DEFAULT_PLANNER_REQUEST_TIMEOUT_MS = 75_000;

/**
 * How long an in-run approval card waits before it expires. An expiry parks
 * an interactive run as resumable rather than failing it, so this is a
 * pause length, not a deadline. Settings, the normalizer, the approval
 * broker, and the runner all read this one definition.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
export const MIN_APPROVAL_TIMEOUT_MS = 1_000;
export const MAX_APPROVAL_TIMEOUT_MS = 30 * 60_000;

export function clampApprovalTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
  return Math.min(
    MAX_APPROVAL_TIMEOUT_MS,
    Math.max(MIN_APPROVAL_TIMEOUT_MS, Math.trunc(value)),
  );
}
