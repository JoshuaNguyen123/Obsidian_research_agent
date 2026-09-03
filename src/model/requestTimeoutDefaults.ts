/**
 * Timeout defaults used by settings and createModelClient.
 * Kept out of settings.ts so unit tests can import them without loading
 * the Obsidian settings tab module.
 */
export const DEFAULT_STREAM_REQUEST_TIMEOUT_MS = 180_000;
export const DEFAULT_PLANNER_REQUEST_TIMEOUT_MS = 75_000;
