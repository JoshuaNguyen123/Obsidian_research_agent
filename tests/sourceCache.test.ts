import { processTestVaultFile } from "./helpers/atomicTestVault";
import test from "node:test";
import { createHash } from "node:crypto";
import { createEvidenceSourceId, extractEvidencePassages } from "../src/agent/researchDossier";
import assert from "node:assert/strict";
import {
  SOURCE_CACHE_FOLDER,
  SOURCE_CACHE_FRESH_MS,
  SOURCE_CACHE_MANIFEST_PATH,
  SOURCE_CACHE_MAX_CHARS,
  SOURCE_CACHE_SECTION_CHARS,
  findFreshCachedSource,
  readSourceCacheManifest,
  readCachedSourceContent,
  readSourceSection,
  writeSourceCacheNote,
} from "../src/tools/sourceCache";
import type { ToolExecutionContext } from "../src/tools/types";

function createCacheContext(now: Date) {
  const content = new Map<string, string>();
  const folders = new Set<string>();
  const revisions = new Map<string, number>();
  const readCounts = new Map<string, number>();

  const getFile = (path: string) =>
    content.has(path)
      ? {
          path,
          basename: path.split("/").pop()?.replace(/\.[^.]+$/i, "") ?? path,
          extension: path.split(".").pop()?.toLowerCase() ?? "",
          stat: {
            mtime: revisions.get(path) ?? 0,
            size: content.get(path)?.length ?? 0,
          },
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
        revisions.set(path, (revisions.get(path) ?? 0) + 1);
        return getFile(path);
      },
      process: function (file: any, transform: (content: string) => string): Promise<string> {
        return processTestVaultFile(this, file, transform);
      },
      modify: async (file: { path: string }, data: string) => {
        content.set(file.path, data);
        revisions.set(file.path, (revisions.get(file.path) ?? 0) + 1);
      },
      read: async (file: { path: string }) => {
        readCounts.set(file.path, (readCounts.get(file.path) ?? 0) + 1);
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

  return { context, content, folders, readCounts };
}

test("optional snapshots bind passages to exact persisted content through equal-length refresh", async () => {
  const { context } = createCacheContext(new Date("2026-10-08T00:00:00Z"));
  const snapshots = new Map<string, any>();
  context.captureSourceSnapshot = async (source) => {
    const snapshotSha256 = createHash("sha256").update(source.content).digest("hex");
    snapshots.set(snapshotSha256, { ...source, sourceId: createEvidenceSourceId(source.url), locator: source.url,
      capturedAt: "2026-10-08T00:00:00Z", snapshotSha256 });
    return { snapshotSha256 };
  };
  context.readSourceSnapshot = async (version) => { const snapshot = snapshots.get(version); if (!snapshot) throw new Error("missing snapshot"); return snapshot; };
  const url = "https://example.com/report", a = await writeSourceCacheNote(context, { url, title: "Dose", content: "Dose A is 0.05 mg/L." });
  const b = await writeSourceCacheNote(context, { url, title: "Dose", content: "Dose B is 0.05 mg/L." });
  assert.notEqual(a.snapshotSha256, b.snapshotSha256);
  const old = await readSourceSection(context, { url, version: a.snapshotSha256 }, 1);
  assert.equal(old.content, "Dose A is 0.05 mg/L.");
  const bundle = extractEvidencePassages(old.content, { sourceLocator: url, sourceVersion: old.snapshotSha256 });
  assert.ok(bundle.passages.every((passage) => passage.id.includes(`:version:${a.snapshotSha256}:passage:`)));
  await assert.rejects(readSourceSection(context, { url, version: a.snapshotSha256 }, 2), /out of range/);
  await assert.rejects(readSourceSection(context, { url: "https://example.com/other", version: a.snapshotSha256 }, 1), /identity mismatch/);
  snapshots.delete(a.snapshotSha256!);
  await assert.rejects(readSourceSection(context, { url, version: a.snapshotSha256 }, 1), /missing snapshot/);
  assert.throws(() => extractEvidencePassages(old.content, { sourceLocator: url, sourceVersion: "bad" }), /Malformed/);
});

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
  assert.match(cached.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(cached.fetchedAt, now.toISOString());
  assert.ok(folders.has(SOURCE_CACHE_FOLDER));
  assert.ok(folders.has(`${SOURCE_CACHE_FOLDER}/example.com`));

  const note = content.get(cached.vaultPath);
  assert.ok(note);
  assert.match(note, /^---\n/);
  assert.match(note, /url: "https:\/\/example\.com\/articles\/local-agents\?ref=42"/);
  assert.match(note, /title: "Local Agents: A Field Guide"/);
  assert.match(note, /fetchedAt: "2026-07-07T12:00:00\.000Z"/);
  assert.match(note, /contentHash: "sha256:[a-f0-9]{64}"/);
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
  assert.match(first.contentHash, /^sha256:[a-f0-9]{64}$/);
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

test("URL section reads use the manifest directly and reuse parsed source content", async () => {
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context, readCounts } = createCacheContext(now);
  const distractor = await writeSourceCacheNote(context, {
    url: "https://example.com/distractor",
    title: "Distractor",
    content: "This note must not be scanned for the target URL.",
  });
  const target = await writeSourceCacheNote(context, {
    url: "https://example.com/target",
    title: "Target",
    content: "T".repeat(SOURCE_CACHE_SECTION_CHARS + 50),
  });
  readCounts.clear();

  const first = await readSourceSection(
    context,
    { url: "https://example.com/target" },
    1,
  );
  const second = await readSourceSection(
    context,
    { url: "https://example.com/target" },
    2,
  );

  assert.equal(first.content.length, SOURCE_CACHE_SECTION_CHARS);
  assert.equal(second.content.length, 50);
  assert.equal(readCounts.get(distractor.vaultPath) ?? 0, 0);
  assert.equal(readCounts.get(target.vaultPath), 1);
  assert.equal(readCounts.get(SOURCE_CACHE_MANIFEST_PATH), 2);
});

test("manifest-directed section reads reject a cached note whose URL drifted", async () => {
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context, content } = createCacheContext(now);
  const cached = await writeSourceCacheNote(context, {
    url: "https://example.com/expected",
    title: "Expected",
    content: "Expected source body.",
  });
  const file = context.app.vault.getFileByPath(cached.vaultPath);
  assert.ok(file);
  await context.app.vault.modify(
    file,
    String(content.get(cached.vaultPath)).replace(
      /https:\/\/example\.com\/expected/g,
      "https://example.com/drifted",
    ),
  );

  await assert.rejects(
    () =>
      readSourceSection(
        context,
        { url: "https://example.com/expected" },
        1,
      ),
    /Cached source was not found/,
  );
});

test("fresh lookup invalidates legacy weak content hashes for refetch", async () => {
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context, content } = createCacheContext(now);
  const cached = await writeSourceCacheNote(context, {
    url: "https://example.com/legacy-weak-hash",
    title: "Legacy weak hash",
    content: "Legacy content that must be fetched again.",
  });
  const weakHash = "fnv1a32x2:0123456789abcdef";
  content.set(
    cached.vaultPath,
    String(content.get(cached.vaultPath)).replace(cached.contentHash, weakHash),
  );
  content.set(
    SOURCE_CACHE_MANIFEST_PATH,
    String(content.get(SOURCE_CACHE_MANIFEST_PATH)).replace(
      cached.contentHash,
      weakHash,
    ),
  );

  assert.equal(
    await findFreshCachedSource(
      context,
      "https://example.com/legacy-weak-hash",
      { maxAgeMs: SOURCE_CACHE_FRESH_MS },
    ),
    null,
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

test("a section read waits for a queued rewrite of the same source instead of reading it torn", async () => {
  // A desktop vault.modify truncates then writes. The writers were queued per
  // path but the readers were not, so a section read that overlapped a refresh
  // of the same source parsed a half-written note and threw "Cached source
  // note is invalid." — which, on a required tool, suppressed auto-continue.
  const now = new Date("2026-07-07T12:00:00.000Z");
  const { context, content } = createCacheContext(now);
  const url = "https://example.com/torn-read";
  const first = await writeSourceCacheNote(context, {
    url,
    title: "Torn read",
    content: "Original body about solid electrolytes and interface stability.",
  });

  const vault = (context.app as unknown as { vault: Record<string, unknown> }).vault;
  const settledModify = vault.modify as (file: { path: string }, data: string) => Promise<void>;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  vault.modify = async (file: { path: string }, data: string) => {
    content.set(file.path, "");
    signalStarted();
    await gate;
    await settledModify(file, data);
  };

  const rewrite = writeSourceCacheNote(context, {
    url,
    title: "Torn read",
    content: "Refreshed body about solid electrolytes and manufacturing at scale.",
  });
  await started;
  const reading = readSourceSection(context, { path: first.vaultPath }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  release();

  const section = await reading;
  await rewrite;
  assert.match(section.content, /Refreshed body about solid electrolytes/u);
});

test("cancellation during source-folder creation prevents note and manifest publication", async () => {
  const { context, content } = createCacheContext(new Date("2026-10-10T00:00:00Z"));
  const controller = new AbortController();
  context.abortSignal = controller.signal;
  const createFolder = context.app.vault.createFolder.bind(context.app.vault);
  context.app.vault.createFolder = async path => {
    const folder = await createFolder(path);
    controller.abort(new DOMException("Cancelled during folder creation", "AbortError"));
    return folder;
  };
  await assert.rejects(writeSourceCacheNote(context, {
    url: "https://example.com/cancel-at-folder", title: "Cancelled source", content: "A complete passage.",
  }), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(controller.signal.aborted, true);
  assert.equal(content.size, 0, "Neither a source note nor a manifest may be published after cancellation.");
});

// Prepared controls: run unchanged against baseline and candidate, never here.
function snapshotReaderContext() {
  const setup = createCacheContext(new Date("2026-10-08T00:00:00Z"));
  type Snapshot = Awaited<ReturnType<NonNullable<ToolExecutionContext["readSourceSnapshot"]>>>;
  const snapshots = new Map<string, Snapshot>();
  setup.context.captureSourceSnapshot = async (source) => {
    const snapshotSha256 = createHash("sha256").update(source.content).digest("hex");
    snapshots.set(snapshotSha256, { snapshotSha256, sourceId: createEvidenceSourceId(source.url),
      locator: source.url, title: source.title, content: source.content, capturedAt: "2026-10-08T00:00:00Z" });
    return { snapshotSha256 };
  };
  setup.context.readSourceSnapshot = async (version) => {
    const snapshot = snapshots.get(version);
    if (!snapshot) throw new Error("missing snapshot");
    return snapshot;
  };
  return { ...setup, snapshots };
}

const READER_TEXT = "Dose A is 0.05 mg/L. This is captured original evidence.";
const READER_EDIT = "Dose B is 0.95 mg/L. This is captured original evidence.";

test("snapshot-bearing unchanged section and whole-content readers agree", async () => {
  const { context } = snapshotReaderContext();
  const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
  const section = await readSourceSection(context, { path: source.vaultPath }, 1);
  assert.equal(section.content, READER_TEXT);
  assert.equal(section.snapshotSha256, source.snapshotSha256);
  assert.equal(section.contentHash, source.contentHash);
  assert.equal(await readCachedSourceContent(context, source.vaultPath), READER_TEXT);
});

test("same-length editable body cannot replace snapshot-selected section or whole content", async () => {
  const { context } = snapshotReaderContext();
  assert.equal(READER_TEXT.length, READER_EDIT.length);
  const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
  const file = context.app.vault.getFileByPath(source.vaultPath); assert.ok(file);
  const markdown = await context.app.vault.read(file);
  await context.app.vault.modify(file, markdown.replace(READER_TEXT, READER_EDIT));
  const section = await readSourceSection(context, { path: source.vaultPath }, 1);
  assert.equal(section.content, READER_TEXT);
  assert.equal(section.snapshotSha256, source.snapshotSha256);
  assert.equal(await readCachedSourceContent(context, source.vaultPath), READER_TEXT);
  assert.ok((await context.app.vault.read(file)).includes(READER_EDIT), "editing remains intact on disk");
});

test("presentation heading and frontmatter title edits do not falsely reject original evidence", async () => {
  const { context } = snapshotReaderContext();
  const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
  const file = context.app.vault.getFileByPath(source.vaultPath); assert.ok(file);
  await context.app.vault.modify(file, (await context.app.vault.read(file)).replace('title: "Dose"', 'title: "My annotation"').replace("# Dose", "# My annotation"));
  assert.equal((await readSourceSection(context, { path: source.vaultPath }, 1)).content, READER_TEXT);
  assert.equal(await readCachedSourceContent(context, source.vaultPath), READER_TEXT);
});

test("explicit old version survives refresh and missing explicit version never falls back", async () => {
  const { context, snapshots } = snapshotReaderContext();
  const old = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
  await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_EDIT });
  assert.equal((await readSourceSection(context, { path: old.vaultPath, version: old.snapshotSha256 }, 1)).content, READER_TEXT);
  snapshots.delete(old.snapshotSha256!);
  await assert.rejects(readSourceSection(context, { path: old.vaultPath, version: old.snapshotSha256 }, 1), /missing snapshot/);
});

test("missing snapshot refuses section and declines whole-note reuse without adopting edits", async () => {
  const { context, snapshots } = snapshotReaderContext();
  const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
  snapshots.clear();
  await assert.rejects(readSourceSection(context, { path: source.vaultPath }, 1), /missing snapshot/);
  assert.equal(await readCachedSourceContent(context, source.vaultPath), null);
});

test("missing immutable callback cannot coerce a snapshot-bearing note into a versioned success", async () => {
  const { context } = snapshotReaderContext();
  const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
  context.readSourceSnapshot = undefined;
  await assert.rejects(readSourceSection(context, { path: source.vaultPath }, 1), /unavailable/);
  assert.equal(await readCachedSourceContent(context, source.vaultPath), null);
});

test("hand-written unmanifested legacy note stays editable and unbound", async () => {
  const { context } = snapshotReaderContext();
  const body = "My deliberately edited ordinary source note.";
  const path = "Agent Sources/manual.example.org/hand-note.md";
  await context.app.vault.create(path, ["---", 'url: "https://manual.example.org/page"', 'normalizedUrl: "https://manual.example.org/page"',
    'urlHash: "0123456789abcdef"', 'title: "Hand note"', 'fetchedAt: "2026-10-08T00:00:00Z"',
    `sourceChars: ${body.length}`, `totalChars: ${body.length}`, `contentHash: "sha256:${"ab".repeat(32)}"`,
    "truncated: false", 'parserStatus: "parsed"', "sectionCount: 1", "---", "", "# Hand note", "", body].join("\n"));
  const section = await readSourceSection(context, { path }, 1);
  assert.equal(section.content, body);
  assert.equal(section.snapshotSha256, undefined);
  assert.equal(await readCachedSourceContent(context, path), body);
  assert.equal(context.app.vault.getFileByPath(SOURCE_CACHE_MANIFEST_PATH), null);
});

test("edited asserted digest cannot falsely bind captured text", async () => {
  const { context } = snapshotReaderContext();
  const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
  const file = context.app.vault.getFileByPath(source.vaultPath); assert.ok(file);
  await context.app.vault.modify(file, (await context.app.vault.read(file)).replace(source.contentHash, `sha256:${"cd".repeat(32)}`));
  await assert.rejects(readSourceSection(context, { path: source.vaultPath }, 1), /identity mismatch/);
  assert.equal(await readCachedSourceContent(context, source.vaultPath), null);
});

test("late immutable reader result after cancellation is not an accepted section or whole-content return", async () => {
  for (const whole of [false, true]) {
    const { context, snapshots } = snapshotReaderContext();
    const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
    const abort = new AbortController(); context.abortSignal = abort.signal;
    context.readSourceSnapshot = async (version) => { abort.abort(new Error("reader cancelled")); return snapshots.get(version)!; };
    await assert.rejects(whole ? readCachedSourceContent(context, source.vaultPath) : readSourceSection(context, { path: source.vaultPath }, 1), /reader cancelled/);
  }
});

test("mount identity changed during immutable read cannot return a late accepted section", async () => {
  const { context, snapshots } = snapshotReaderContext();
  const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
  context.readSourceSnapshot = async (version) => { context.app = createCacheContext(new Date()).context.app; return snapshots.get(version)!; };
  await assert.rejects(readSourceSection(context, { path: source.vaultPath }, 1), /mount changed/);
});

test("captured bounded text does not erase original truncation and source-size metadata", async () => {
  const { context } = snapshotReaderContext();
  const long = READER_TEXT.repeat(Math.ceil(SOURCE_CACHE_MAX_CHARS / READER_TEXT.length) + 2);
  const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: long });
  const section = await readSourceSection(context, { path: source.vaultPath }, 1);
  assert.equal(section.truncated, true);
  assert.equal(section.sourceChars, long.length);
  assert.equal(section.totalChars, source.totalChars);
  assert.equal(section.parserStatus, source.parserStatus);
  assert.equal((await readCachedSourceContent(context, source.vaultPath))?.length, source.totalChars);
});

test("foreign immutable locator, source id or returned version refuses selected evidence", async () => {
  for (const mismatch of ["locator", "sourceId", "snapshotSha256"] as const) {
    const { context, snapshots } = snapshotReaderContext();
    const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
    context.readSourceSnapshot = async version => ({ ...snapshots.get(version)!, [mismatch]: mismatch === "snapshotSha256" ? "de".repeat(32) : "https://foreign.example/report" });
    await assert.rejects(readSourceSection(context, { path: source.vaultPath }, 1), /identity mismatch/);
    assert.equal(await readCachedSourceContent(context, source.vaultPath), null);
  }
});

test("oversize immutable callback cannot widen the existing source-cache clipping budget", async () => {
  const { context, snapshots } = snapshotReaderContext();
  const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
  context.readSourceSnapshot = async version => ({ ...snapshots.get(version)!, content: "x".repeat(SOURCE_CACHE_MAX_CHARS + 1) });
  await assert.rejects(readSourceSection(context, { path: source.vaultPath }, 1), /identity mismatch/);
  assert.equal(await readCachedSourceContent(context, source.vaultPath), null);
});

test("deadline expiring during awaited snapshot read refuses late text", async () => {
  const { context, snapshots } = snapshotReaderContext();
  const source = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: READER_TEXT });
  context.readSourceSnapshot = async version => { context.deadlineAt = 1; return snapshots.get(version)!; };
  await assert.rejects(readSourceSection(context, { path: source.vaultPath }, 1), /deadline expired/);
});

test("clipped immutable section refuses falsely complete note metadata", async () => {
  const { context } = snapshotReaderContext();
  const long = READER_TEXT.repeat(Math.ceil(SOURCE_CACHE_MAX_CHARS / READER_TEXT.length) + 2);
  const cached = await writeSourceCacheNote(context, { url: "https://example.com/reader", title: "Dose", content: long });
  const file = context.app.vault.getFileByPath(cached.vaultPath); assert.ok(file);
  await context.app.vault.modify(file, (await context.app.vault.read(file)).replace("truncated: true", "truncated: false"));
  await assert.rejects(readSourceSection(context, { path: cached.vaultPath }, 1), /identity mismatch/);
  assert.equal(await readCachedSourceContent(context, cached.vaultPath), null);
});
