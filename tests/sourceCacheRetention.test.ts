import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_CACHE_MANIFEST_PATH,
  SOURCE_CACHE_MAX_AGE_MS,
  type CachedSource,
} from "../src/tools/sourceCache";
import {
  selectExpiredSourceCacheEntriesV1,
  sweepExpiredSourceCacheBestEffortV1,
} from "../src/tools/sourceCacheRetention";

const NOW = new Date("2026-09-14T00:00:00.000Z");

function entry(overrides: Partial<CachedSource> & { normalizedUrl: string }): CachedSource {
  return {
    vaultPath: `Agent Sources/${overrides.normalizedUrl.replace(/\W+/gu, "-")}.md`,
    url: `https://${overrides.normalizedUrl}`,
    normalizedUrl: overrides.normalizedUrl,
    urlHash: "sha256:abc",
    title: "Cached source",
    fetchedAt: new Date(NOW.getTime() - 1_000).toISOString(),
    sourceChars: 100,
    totalChars: 100,
    contentHash: "sha256:def",
    truncated: false,
    parserStatus: "parsed",
    sectionCount: 1,
    ...overrides,
  };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

test("only copies the cache would already refuse to serve are expired", () => {
  const fresh = entry({ normalizedUrl: "fresh.example/a", fetchedAt: daysAgo(2) });
  const stale = entry({ normalizedUrl: "stale.example/b", fetchedAt: daysAgo(45) });
  const edge = entry({
    normalizedUrl: "edge.example/c",
    fetchedAt: new Date(NOW.getTime() - SOURCE_CACHE_MAX_AGE_MS + 60_000).toISOString(),
  });
  const expired = selectExpiredSourceCacheEntriesV1([fresh, stale, edge], NOW);
  assert.deepEqual(
    expired.map((item) => item.normalizedUrl),
    ["stale.example/b"],
  );
});

test("an unreadable timestamp counts as expired", () => {
  const broken = entry({ normalizedUrl: "broken.example/d", fetchedAt: "not a date" });
  assert.equal(selectExpiredSourceCacheEntriesV1([broken], NOW).length, 1);
});

test("the sweep trashes expired notes and drops their manifest entries", async () => {
  const stale = entry({ normalizedUrl: "stale.example/b", fetchedAt: daysAgo(45) });
  const fresh = entry({ normalizedUrl: "fresh.example/a", fetchedAt: daysAgo(1) });
  const vault = createVault([stale, fresh]);

  const result = await sweepExpiredSourceCacheBestEffortV1({
    vault: vault.api,
    now: NOW,
  });

  assert.deepEqual(result.trashed, [stale.vaultPath]);
  assert.ok(!vault.files.has(stale.vaultPath));
  assert.ok(vault.files.has(fresh.vaultPath), "a fresh copy is untouched");
  const manifest = JSON.parse(vault.files.get(SOURCE_CACHE_MANIFEST_PATH)!);
  assert.deepEqual(
    manifest.entries.map((item: CachedSource) => item.normalizedUrl),
    ["fresh.example/a"],
  );
});

test("a manifest entry pointing outside the cache folder is never followed", async () => {
  const escaping = entry({
    normalizedUrl: "escape.example/x",
    fetchedAt: daysAgo(90),
    vaultPath: "Notes/Important.md",
  });
  const vault = createVault([escaping]);
  const result = await sweepExpiredSourceCacheBestEffortV1({
    vault: vault.api,
    now: NOW,
  });
  assert.deepEqual(result.trashed, []);
  assert.ok(vault.files.has("Notes/Important.md"));
});

test("a cache note no manifest entry names is left alone", async () => {
  const stale = entry({ normalizedUrl: "stale.example/b", fetchedAt: daysAgo(45) });
  const vault = createVault([stale]);
  vault.files.set("Agent Sources/Hand written note.md", "mine");
  await sweepExpiredSourceCacheBestEffortV1({ vault: vault.api, now: NOW });
  assert.ok(vault.files.has("Agent Sources/Hand written note.md"));
});

test("nothing happens without a manifest, or without trash support", async () => {
  const empty = createVault([]);
  empty.files.delete(SOURCE_CACHE_MANIFEST_PATH);
  assert.deepEqual(
    (await sweepExpiredSourceCacheBestEffortV1({ vault: empty.api, now: NOW })).trashed,
    [],
  );

  const stale = entry({ normalizedUrl: "stale.example/b", fetchedAt: daysAgo(45) });
  const noTrash = createVault([stale]);
  const api = { ...noTrash.api, trash: undefined };
  assert.deepEqual(
    (await sweepExpiredSourceCacheBestEffortV1({ vault: api, now: NOW })).trashed,
    [],
  );
  assert.ok(noTrash.files.has(stale.vaultPath));
});

function createVault(entries: CachedSource[]) {
  const files = new Map<string, string>();
  files.set(
    SOURCE_CACHE_MANIFEST_PATH,
    `${JSON.stringify({ version: 1, updatedAt: NOW.toISOString(), entries }, null, 2)}\n`,
  );
  for (const item of entries) files.set(item.vaultPath, `# ${item.title}`);

  const api = {
    getFileByPath: (path: string) => (files.has(path) ? { path } : null),
    read: async (file: unknown) => files.get((file as { path: string }).path) ?? "",
    modify: async (file: unknown, data: string) => {
      files.set((file as { path: string }).path, data);
    },
    trash: async (file: unknown) => {
      files.delete((file as { path: string }).path);
    },
  };
  return { files, api };
}
