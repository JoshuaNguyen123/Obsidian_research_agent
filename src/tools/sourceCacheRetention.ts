/**
 * Expiry for the fetched-source cache under `Agent Sources/`.
 *
 * `SOURCE_CACHE_MAX_AGE_MS` has always been a *read* rule: a copy older than
 * thirty days is never served again. Nothing ever removed one, so the cached
 * page, its manifest entry and its vault file stayed forever — permanently
 * unusable, permanently synced, permanently in the user's file explorer, and
 * rewritten into the manifest on every subsequent fetch.
 *
 * The sweep removes exactly what the read rule already refuses to use, which
 * is why it cannot cost a mission anything: an entry it deletes is one that
 * `findFreshCachedSource` would have skipped and re-fetched.
 *
 * Two deliberate limits. A note under `Agent Sources/` that no manifest entry
 * names is left alone — it may be a file the user put there, and a cache sweep
 * is not a licence to delete unknown notes. And everything goes to Obsidian's
 * trash, never a hard delete.
 */

import {
  SOURCE_CACHE_FOLDER,
  SOURCE_CACHE_MANIFEST_PATH,
  SOURCE_CACHE_MAX_AGE_MS,
  type CachedSource,
  type SourceCacheManifest,
} from "./sourceCache";

/** Cache notes trashed in one session, so a huge folder drains over several. */
export const MAX_SOURCE_CACHE_TRASHES_PER_SESSION = 200;

/**
 * Entries past the age at which a cached copy stops being served. An entry
 * with an unreadable timestamp is treated as expired: it can never satisfy a
 * freshness check either.
 */
export function selectExpiredSourceCacheEntriesV1(
  entries: readonly CachedSource[],
  now: Date,
  maxAgeMs: number = SOURCE_CACHE_MAX_AGE_MS,
): CachedSource[] {
  const cutoffMs = now.getTime() - maxAgeMs;
  return entries.filter((entry) => {
    const fetchedAtMs = Date.parse(entry.fetchedAt ?? "");
    if (!Number.isFinite(fetchedAtMs)) return true;
    return fetchedAtMs < cutoffMs;
  });
}

export interface SourceCacheRetentionVaultV1 {
  getFileByPath(path: string): unknown;
  read(file: unknown): Promise<string>;
  modify(file: unknown, data: string): Promise<void>;
  trash?(file: unknown, system: boolean): Promise<void>;
}

/**
 * Trash expired cache notes and drop their manifest entries. Best effort: a
 * failure leaves the cache exactly as it was.
 */
export async function sweepExpiredSourceCacheBestEffortV1(input: {
  vault: SourceCacheRetentionVaultV1;
  now?: Date;
  maxAgeMs?: number;
  maxTrashes?: number;
}): Promise<{ trashed: string[] }> {
  const trashed: string[] = [];
  try {
    if (typeof input.vault.trash !== "function") return { trashed };
    const manifestFile = input.vault.getFileByPath(SOURCE_CACHE_MANIFEST_PATH);
    if (!manifestFile) return { trashed };
    let manifest: SourceCacheManifest;
    try {
      manifest = JSON.parse(await input.vault.read(manifestFile)) as SourceCacheManifest;
    } catch {
      return { trashed };
    }
    if (!manifest || !Array.isArray(manifest.entries)) return { trashed };

    const expired = selectExpiredSourceCacheEntriesV1(
      manifest.entries,
      input.now ?? new Date(),
      input.maxAgeMs,
    ).slice(
      0,
      Math.max(
        0,
        Math.min(
          input.maxTrashes ?? MAX_SOURCE_CACHE_TRASHES_PER_SESSION,
          MAX_SOURCE_CACHE_TRASHES_PER_SESSION,
        ),
      ),
    );
    if (expired.length === 0) return { trashed };

    const removed = new Set<string>();
    for (const entry of expired) {
      const path = entry.vaultPath ?? "";
      // Never follow a manifest entry out of the cache folder.
      if (!path.startsWith(`${SOURCE_CACHE_FOLDER}/`)) continue;
      if (path === SOURCE_CACHE_MANIFEST_PATH) continue;
      try {
        const file = input.vault.getFileByPath(path);
        if (file) {
          await input.vault.trash(file, false);
          trashed.push(path);
        }
        // A manifest entry whose note is already gone is still stale bookkeeping.
        removed.add(entry.normalizedUrl);
      } catch {
        // Leave this entry in the manifest so the next sweep retries it.
      }
    }
    if (removed.size === 0) return { trashed };

    const next: SourceCacheManifest = {
      version: 1,
      updatedAt: (input.now ?? new Date()).toISOString(),
      entries: manifest.entries.filter(
        (entry) => !removed.has(entry.normalizedUrl),
      ),
    };
    await input.vault.modify(
      manifestFile,
      `${JSON.stringify(next, null, 2)}\n`,
    );
  } catch {
    return { trashed };
  }
  return { trashed };
}
