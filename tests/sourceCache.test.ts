import test from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_CACHE_FOLDER,
  SOURCE_CACHE_FRESH_MS,
  SOURCE_CACHE_MANIFEST_PATH,
  SOURCE_CACHE_MAX_CHARS,
  SOURCE_CACHE_SECTION_CHARS,
  findFreshCachedSource,
  readSourceCacheManifest,
  readSourceSection,
  writeSourceCacheNote,
} from "../src/tools/sourceCache";
import type { ToolExecutionContext } from "../src/tools/types";

function createCacheContext(now: Date) {
  const content = new Map<string, string>();
  const folders = new Set<string>();

  const getFile = (path: string) =>
    content.has(path)
      ? {
          path,
          basename: path.split("/").pop()?.replace(/\.[^.]+$/i, "") ?? path,
          extension: path.split(".").pop()?.toLowerCase() ?? "",
        }
      : null;

  const app = {
    vault: {
      getFileByPath: getFile,
      getFolderByPath: (path: string) =>
        folders.has(path) ? { path, name: path.split("/").pop() ?? path } : null,
      createFolder: async (path: string) => {
        folders.add(path);
      },
      create: async (path: string, data: string) => {
        content.set(path, data);
        return getFile(path);
      },
      modify: async (file: { path: string }, data: string) => {
        content.set(file.path, data);
      },
      read: async (file: { path: string }) => {
        const value = content.get(file.path);
        if (value === undefined) {
          throw new Error(`File not found: ${file.path}`);
        }
        return value;
      },
      getFiles: () =>
        [...content.keys()]
          .map((path) => getFile(path))
          .filter((file): file is NonNullable<typeof file> => Boolean(file)),
    },
  };

  const context = {
    app: app as never,
    settings: {} as never,
    originalPrompt: "cache the fetched source",
    httpTransport: (async () => {
      throw new Error("network is not used in source cache tests");
    }) as never,
    now: () => now,
  } as unknown as ToolExecutionContext;

  return { context, content, folders };
}

test("writeSourceCacheNote writes a sectioned frontmatter note under Agent Sources", async () => {
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context, content, folders } = createCacheContext(now);
  const body = "A".repeat(SOURCE_CACHE_SECTION_CHARS * 2 + 100);

  const cached = await writeSourceCacheNote(context, {
    url: "https://example.com/articles/local-agents?ref=42",
    title: "Local Agents: A Field Guide",
    content: body,
  });

  assert.equal(
    cached.vaultPath.startsWith(
      `${SOURCE_CACHE_FOLDER}/example.com/Local-Agents-A-Field-Guide-`,
    ),
    true,
  );
  assert.match(cached.vaultPath, /-[a-f0-9]{16}\.md$/);
  assert.equal(cached.sectionCount, 3);
  assert.equal(cached.sourceChars, body.length);
  assert.equal(cached.totalChars, body.length);
  assert.equal(cached.truncated, false);
  assert.equal(cached.parserStatus, "parsed");
  assert.match(cached.contentHash, /^fnv1a32x2:[a-f0-9]{16}$/);
  assert.equal(cached.fetchedAt, now.toISOString());
  assert.ok(folders.has(SOURCE_CACHE_FOLDER));
  assert.ok(folders.has(`${SOURCE_CACHE_FOLDER}/example.com`));

  const note = content.get(cached.vaultPath);
  assert.ok(note);
  assert.match(note, /^---\n/);
  assert.match(note, /url: "https:\/\/example\.com\/articles\/local-agents\?ref=42"/);
  assert.match(note, /title: "Local Agents: A Field Guide"/);
  assert.match(note, /fetchedAt: "2026-07-07T12:00:00\.000Z"/);
  assert.match(note, /contentHash: "fnv1a32x2:[a-f0-9]{16}"/);
  assert.match(note, /truncated: false/);
  assert.match(note, /parserStatus: "parsed"/);
  assert.match(note, /sectionCount: 3/);
  assert.match(note, /# Local Agents: A Field Guide/);
});

test("writeSourceCacheNote records truncation provenance and overwrites the same URL", async () => {
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context, content } = createCacheContext(now);
  const oversized = "B".repeat(SOURCE_CACHE_MAX_CHARS + 5000);

  const first = await writeSourceCacheNote(context, {
    url: "https://news.example.org/post",
    title: "Big Post",
    content: oversized,
  });
  assert.ok(first.totalChars <= SOURCE_CACHE_MAX_CHARS + 200);
  assert.equal(first.sourceChars, oversized.length);
  assert.equal(first.truncated, true);
  assert.equal(first.parserStatus, "parsed");

  const second = await writeSourceCacheNote(context, {
    url: "https://news.example.org/post",
    title: "Big Post",
    content: "fresh body",
  });
  assert.equal(second.vaultPath, first.vaultPath);
  assert.equal(
    [...content.keys()].filter(
      (path) => path.startsWith(SOURCE_CACHE_FOLDER) && path.endsWith(".md"),
    ).length,
    1,
  );
  assert.match(content.get(second.vaultPath) ?? "", /fresh body/);
});

test("same-domain sources with the same title use distinct normalized URL hashes", async () => {
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context, content } = createCacheContext(now);

  const first = await writeSourceCacheNote(context, {
    url: "https://example.com/articles/one#overview",
    title: "Shared title",
    content: "first body",
  });
  const second = await writeSourceCacheNote(context, {
    url: "https://example.com/articles/two",
    title: "Shared title",
    content: "second body",
  });

  assert.notEqual(first.urlHash, second.urlHash);
  assert.notEqual(first.vaultPath, second.vaultPath);
  assert.equal(first.normalizedUrl, "https://example.com/articles/one");
  assert.equal(
    [...content.keys()].filter((path) => path.endsWith(".md")).length,
    2,
  );
  const manifest = await readSourceCacheManifest(context);
  assert.deepEqual(
    new Set(manifest.entries.map((entry) => entry.normalizedUrl)),
    new Set([
      "https://example.com/articles/one",
      "https://example.com/articles/two",
    ]),
  );
});

test("concurrent source writes serialize manifest updates without dropping entries", async () => {
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context } = createCacheContext(now);
  const urls = Array.from(
    { length: 16 },
    (_, index) => `https://example.com/concurrent/${index}`,
  );

  await Promise.all(urls.map((url, index) => writeSourceCacheNote(context, {
    url,
    title: `Concurrent ${index}`,
    content: `body ${index}`,
  })));

  const manifest = await readSourceCacheManifest(context);
  assert.equal(manifest.entries.length, urls.length);
  assert.deepEqual(
    new Set(manifest.entries.map((entry) => entry.normalizedUrl)),
    new Set(urls),
  );
});

test("source cache maintains a manifest for fast URL lookup", async () => {
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context, content } = createCacheContext(now);

  const cached = await writeSourceCacheNote(context, {
    url: "https://example.com/manifest",
    title: "Manifest Entry",
    content: "manifest body",
  });

  assert.ok(content.has(SOURCE_CACHE_MANIFEST_PATH));
  const manifest = await readSourceCacheManifest(context);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.updatedAt, now.toISOString());
  assert.deepEqual(manifest.entries, [cached]);

  const fresh = await findFreshCachedSource(context, "https://example.com/manifest");
  assert.deepEqual(fresh, cached);
});

test("findFreshCachedSource honors the freshness window per url", async () => {
  const fetchedAt = new Date("2026-07-07T12:00:00.000Z");
  const { context } = createCacheContext(fetchedAt);
  await writeSourceCacheNote(context, {
    url: "https://example.com/fresh",
    title: "Fresh Source",
    content: "cached content",
  });

  const justFresh = {
    ...context,
    now: () => new Date(fetchedAt.getTime() + SOURCE_CACHE_FRESH_MS - 1000),
  } as ToolExecutionContext;
  const fresh = await findFreshCachedSource(justFresh, "https://example.com/fresh");
  assert.ok(fresh);
  assert.equal(fresh.url, "https://example.com/fresh");

  const expired = {
    ...context,
    now: () => new Date(fetchedAt.getTime() + SOURCE_CACHE_FRESH_MS + 1000),
  } as ToolExecutionContext;
  assert.equal(
    await findFreshCachedSource(expired, "https://example.com/fresh"),
    null,
  );
  assert.equal(
    await findFreshCachedSource(justFresh, "https://example.com/other"),
    null,
  );

  const fiveSecondsLater = {
    ...context,
    now: () => new Date(fetchedAt.getTime() + 5000),
  } as ToolExecutionContext;
  assert.ok(
    await findFreshCachedSource(
      fiveSecondsLater,
      "https://example.com/fresh",
      { maxAgeMs: 6000 },
    ),
  );
  assert.equal(
    await findFreshCachedSource(
      fiveSecondsLater,
      "https://example.com/fresh",
      { maxAgeMs: 1000 },
    ),
    null,
  );
  assert.equal(
    await findFreshCachedSource(
      justFresh,
      "https://example.com/fresh",
      { refresh: true },
    ),
    null,
  );
  assert.equal(
    await findFreshCachedSource(
      justFresh,
      "https://example.com/fresh",
      { maxAgeMs: 0 },
    ),
    null,
  );
});

test("readSourceSection returns 1-based clamped sections without frontmatter", async () => {
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context } = createCacheContext(now);
  const sectionOne = "1".repeat(SOURCE_CACHE_SECTION_CHARS);
  const sectionTwo = "2".repeat(500);
  await writeSourceCacheNote(context, {
    url: "https://example.com/sections",
    title: "Sectioned",
    content: sectionOne + sectionTwo,
  });

  const first = await readSourceSection(
    context,
    { url: "https://example.com/sections" },
    1,
  );
  assert.equal(first.section, 1);
  assert.equal(first.sectionCount, 2);
  assert.equal(first.parserStatus, "parsed");
  assert.match(first.contentHash, /^fnv1a32x2:/);
  assert.ok(!first.content.includes("fetchedAt:"));
  assert.equal(first.sourceStartChar, 0);
  assert.equal(first.content, sectionOne);
  assert.ok(!first.content.includes("# Sectioned"));

  const second = await readSourceSection(
    context,
    { url: "https://example.com/sections" },
    2,
  );
  assert.equal(second.section, 2);
  assert.equal(second.sourceStartChar, SOURCE_CACHE_SECTION_CHARS);
  assert.equal(second.content, sectionTwo);

  const clamped = await readSourceSection(
    context,
    { url: "https://example.com/sections" },
    99,
  );
  assert.equal(clamped.section, 2);
  assert.equal(clamped.sourceStartChar, SOURCE_CACHE_SECTION_CHARS);

  await assert.rejects(
    () => readSourceSection(context, { url: "https://missing.example.com" }, 1),
    /Cached source was not found/,
  );
});

test("readSourceSection strips generated H1 chrome from legacy cache notes", async () => {
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context, content } = createCacheContext(now);
  const body = "L".repeat(SOURCE_CACHE_SECTION_CHARS);
  const cached = await writeSourceCacheNote(context, {
    url: "https://example.com/legacy-section",
    title: "Legacy Section",
    content: body,
  });
  const note = content.get(cached.vaultPath);
  assert.ok(note);
  // Older cache notes counted the generated H1 toward section boundaries,
  // which could inflate this exact-length source to two sections.
  content.set(cached.vaultPath, note.replace("sectionCount: 1", "sectionCount: 2"));

  const legacy = await readSourceSection(context, { path: cached.vaultPath }, 99);
  assert.equal(legacy.sectionCount, 1);
  assert.equal(legacy.section, 1);
  assert.equal(legacy.sourceStartChar, 0);
  assert.equal(legacy.content, body);
  assert.ok(!legacy.content.includes("# Legacy Section"));
});

test("source cache sanitizes hostile titles and urls into safe vault paths", async () => {
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context } = createCacheContext(now);

  const cached = await writeSourceCacheNote(context, {
    url: "https://weird.example.com/a?b=c&d=../..\\evil",
    title: "  ../..\\評価 <Weird> Title!!  ",
    content: "body",
  });

  assert.ok(cached.vaultPath.startsWith(`${SOURCE_CACHE_FOLDER}/weird.example.com/`));
  assert.ok(!cached.vaultPath.includes(".."));
  assert.ok(!cached.vaultPath.includes("\\"));
  assert.match(cached.vaultPath, /\.md$/);
});
