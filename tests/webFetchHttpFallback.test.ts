import { createHash } from "node:crypto";
import { createEvidenceSourceId } from "../src/agent/researchDossier";
import { SOURCE_CACHE_MANIFEST_PATH, writeSourceCacheNote } from "../src/tools/sourceCache";
import { processTestVaultFile } from "./helpers/atomicTestVault";
import test from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse } from "../src/model/types";
import type { ToolExecutionContext } from "../src/tools/types";
import { webFetchTool } from "../src/tools/webTools";

/**
 * A dead primary URL used to end the run: web_fetch threw on any status at or
 * above 400 before the substitution ladder it already owned could reach a
 * mirror. These lanes pin that a 404 and a 500 now spend the ladder, and that
 * an unusable 2xx body still behaves exactly as it did.
 */

const USABLE_BODY = [
  "Introduction to the mirrored study. ".repeat(20),
  "The mirror edition states that the electrolyte remained stable for 2,000 cycles.",
  "Method notes and appendix material. ".repeat(20),
].join("\n");

function createWebContext(
  httpTransport: (request: HttpRequest) => Promise<HttpResponse>,
) {
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
      process: function (file: any, transform: (content: string) => string): Promise<string> {
        return processTestVaultFile(this, file, transform);
      },
      modify: async (file: { path: string }, data: string) => {
        content.set(file.path, data);
      },
      read: async (file: { path: string }) => {
        const value = content.get(file.path);
        if (value === undefined) throw new Error(`File not found: ${file.path}`);
        return value;
      },
      getFiles: () =>
        [...content.keys()]
          .map((path) => getFile(path))
          .filter((file): file is NonNullable<typeof file> => Boolean(file)),
    },
  };
  return {
    app: app as never,
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "test-key",
      requestTimeoutMs: 60_000,
    } as never,
    originalPrompt: "Check the electrolyte stability claim.",
    httpTransport,
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  } as unknown as ToolExecutionContext;
}

function requestedUrl(request: HttpRequest): string {
  try {
    const body = JSON.parse(String(request.body ?? "{}")) as { url?: unknown };
    return typeof body.url === "string" ? body.url : "";
  } catch {
    return "";
  }
}

/** Answers fetches per-URL and refuses every search, isolating the ladder. */
function createFetchTransport(
  statusFor: (url: string) => number,
  bodyFor: (url: string) => Record<string, unknown>,
) {
  const fetched: string[] = [];
  const transport = async (request: HttpRequest): Promise<HttpResponse> => {
    if (request.url.endsWith("/web_search")) {
      return { status: 404, headers: {}, json: { error: "no search" } };
    }
    // Two shapes reach this stub: the retrieval endpoint, which names its
    // target in the POST body, and the direct read, which is a GET of the page
    // itself. Reading only the body made every direct read look like a request
    // for the empty URL, so a page this fixture calls dead answered 200.
    const url = requestedUrl(request) || request.url;
    fetched.push(url);
    const status = statusFor(url);
    return status >= 400
      ? { status, headers: {}, json: { error: `status ${status}` } }
      : { status, headers: {}, json: bodyFor(url) };
  };
  return { transport, fetched };
}

test("web_fetch substitutes a working mirror when the primary URL 404s", async () => {
  const primary = "https://example.com/dead-study";
  const mirror = "https://mirror.example.org/study";
  const { transport, fetched } = createFetchTransport(
    (url) => (url.includes("dead-study") ? 404 : 200),
    () => ({ title: "Mirror edition", content: USABLE_BODY, links: [] }),
  );

  const output = (await webFetchTool.execute(
    {
      url: primary,
      alternate_urls: [mirror],
      query: "electrolyte stability cycles",
      refresh: true,
    },
    createWebContext(transport),
  )) as { url: string; content: string; fallbackUsed?: boolean };

  assert.equal(output.url, mirror);
  assert.equal(output.fallbackUsed, true);
  assert.ok(output.content.includes("remained stable for 2,000 cycles"));
  assert.ok(
    fetched.some((url) => url.includes("dead-study")),
    "the primary URL should still be attempted first",
  );
});

test("web_fetch spends the ladder on a provider 500 before giving up", async () => {
  const primary = "https://example.com/flaky-study";
  const mirror = "https://mirror.example.org/flaky-study";
  const { transport, fetched } = createFetchTransport(
    (url) => (url.includes("mirror") ? 200 : 500),
    () => ({ title: "Mirror edition", content: USABLE_BODY, links: [] }),
  );

  const output = (await webFetchTool.execute(
    {
      url: primary,
      alternate_urls: [mirror],
      query: "electrolyte stability cycles",
      refresh: true,
    },
    createWebContext(transport),
  )) as { url: string; fallbackUsed?: boolean };

  assert.equal(output.url, mirror);
  assert.equal(output.fallbackUsed, true);
  // 500 is transient, so the primary is retried by requestWithRetry before the
  // ladder takes over.
  assert.ok(
    fetched.filter((url) => url.includes("flaky-study") && !url.includes("mirror"))
      .length > 1,
    "a 500 should be retried before substitution",
  );
});

test("web_fetch reports an exhausted ladder as source_http_error, not a bare throw", async () => {
  const { transport } = createFetchTransport(
    () => 404,
    () => ({}),
  );

  await assert.rejects(
    webFetchTool.execute(
      {
        url: "https://example.com/dead-study",
        alternate_urls: ["https://mirror.example.org/also-dead"],
        query: "electrolyte stability cycles",
        refresh: true,
      },
      createWebContext(transport),
    ),
    (error: unknown) => {
      const code = (error as { code?: string }).code;
      assert.equal(code, "source_http_error");
      assert.match(String((error as Error).message), /could not retrieve/i);
      return true;
    },
  );
});

test("web_fetch still classifies an unusable 2xx body as source_unusable", async () => {
  const { transport } = createFetchTransport(
    () => 200,
    () => ({ title: "Empty page", content: "", links: [] }),
  );

  await assert.rejects(
    webFetchTool.execute(
      {
        url: "https://example.com/empty-study",
        query: "electrolyte stability cycles",
        refresh: true,
      },
      createWebContext(transport),
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "source_unusable");
      return true;
    },
  );
});

// Same actual web_fetch entry and mocked transport used by the existing suite.
function snapshotFallbackFixture() {
  const { transport, fetched } = createFetchTransport(() => 404, () => ({}));
  const context = createWebContext(transport);
  type Snapshot = Awaited<ReturnType<NonNullable<ToolExecutionContext["readSourceSnapshot"]>>>;
  const snapshots = new Map<string, Snapshot>();
  context.captureSourceSnapshot = async (source) => {
    const snapshotSha256 = createHash("sha256").update(source.content).digest("hex");
    snapshots.set(snapshotSha256, { snapshotSha256, sourceId: createEvidenceSourceId(source.url),
      locator: source.url, title: source.title, content: source.content, capturedAt: "2026-08-27T12:00:00.000Z" });
    return { snapshotSha256 };
  };
  context.readSourceSnapshot = async (version) => {
    const snapshot = snapshots.get(version); if (!snapshot) throw new Error("missing snapshot"); return snapshot;
  };
  return { context, snapshots, fetched };
}

const SNAPSHOT_MIRROR = "https://mirror.example.org/captured-study";
const SNAPSHOT_PRIMARY = "https://example.com/missing-study";

async function fetchSnapshotMirror(context: ToolExecutionContext) {
  return await webFetchTool.execute({ url: SNAPSHOT_PRIMARY, alternate_urls: [SNAPSHOT_MIRROR],
    query: "electrolyte stability cycles" }, context) as {
    content: string; snapshotSha256?: string; contentHash: string; fromCache: boolean;
    truncated: boolean; sourceChars: number; totalChars: number;
  };
}

test("whole-note fallback returns an unchanged selected snapshot through real web_fetch", async () => {
  const { context, fetched } = snapshotFallbackFixture();
  const cached = await writeSourceCacheNote(context, { url: SNAPSHOT_MIRROR, title: "Mirror study", content: USABLE_BODY });
  const output = await fetchSnapshotMirror(context);
  assert.equal(output.content, USABLE_BODY);
  assert.equal(output.snapshotSha256, cached.snapshotSha256);
  assert.equal(output.contentHash, cached.contentHash);
  assert.equal(output.fromCache, true);
  assert.ok(fetched.some(url => url.includes("missing-study")), "genuine primary failure enters the ladder");
});

test("whole-note fallback never advertises an edited note body under its captured version", async () => {
  const { context } = snapshotFallbackFixture();
  const cached = await writeSourceCacheNote(context, { url: SNAPSHOT_MIRROR, title: "Mirror study", content: USABLE_BODY });
  const file = context.app.vault.getFileByPath(cached.vaultPath); assert.ok(file);
  const changed = USABLE_BODY.replace("2,000 cycles", "9,000 cycles");
  assert.equal(changed.length, USABLE_BODY.length);
  await context.app.vault.modify(file, (await context.app.vault.read(file)).replace(USABLE_BODY, changed));
  const output = await fetchSnapshotMirror(context);
  assert.equal(output.content, USABLE_BODY);
  assert.equal(output.snapshotSha256, cached.snapshotSha256);
  assert.ok((await context.app.vault.read(file)).includes("9,000 cycles"), "the editable mirror is preserved");
});

test("whole-note fallback binds the selected manifest version when note version changes", async () => {
  const { context } = snapshotFallbackFixture();
  const old = await writeSourceCacheNote(context, { url: SNAPSHOT_MIRROR, title: "Mirror study", content: USABLE_BODY });
  const manifest = context.app.vault.getFileByPath(SOURCE_CACHE_MANIFEST_PATH); assert.ok(manifest);
  const selectedGeneration = await context.app.vault.read(manifest);
  const newer = await writeSourceCacheNote(context, { url: SNAPSHOT_MIRROR, title: "Mirror study", content: USABLE_BODY.replace("2,000 cycles", "9,000 cycles") });
  assert.notEqual(old.snapshotSha256, newer.snapshotSha256);
  // Represents a committed older selection with a newer prepared note at the same path.
  await context.app.vault.modify(manifest, selectedGeneration);
  const output = await fetchSnapshotMirror(context);
  assert.equal(output.content, USABLE_BODY);
  assert.equal(output.snapshotSha256, old.snapshotSha256);
  assert.equal(output.contentHash, old.contentHash);
});

test("missing selected snapshot cannot make whole-note fallback accept mutable text", async () => {
  const { context, snapshots } = snapshotFallbackFixture();
  await writeSourceCacheNote(context, { url: SNAPSHOT_MIRROR, title: "Mirror study", content: USABLE_BODY });
  snapshots.clear();
  await assert.rejects(fetchSnapshotMirror(context));
});

test("ordinary legacy whole-note fallback still reads editable Markdown without a version", async () => {
  const { context } = snapshotFallbackFixture();
  context.captureSourceSnapshot = undefined;
  const cached = await writeSourceCacheNote(context, { url: SNAPSHOT_MIRROR, title: "Mirror study", content: USABLE_BODY });
  const file = context.app.vault.getFileByPath(cached.vaultPath); assert.ok(file);
  const changed = USABLE_BODY.replace("2,000 cycles", "9,000 cycles");
  await context.app.vault.modify(file, (await context.app.vault.read(file)).replace(USABLE_BODY, changed));
  const output = await fetchSnapshotMirror(context);
  assert.equal(output.content, changed);
  assert.equal(output.snapshotSha256, undefined);
});

test("whole-note fallback cannot accept snapshot text after cancellation or mount change", async () => {
  for (const change of ["cancel", "mount"] as const) {
    const { context, snapshots } = snapshotFallbackFixture();
    await writeSourceCacheNote(context, { url: SNAPSHOT_MIRROR, title: "Mirror study", content: USABLE_BODY });
    const abort = new AbortController(); context.abortSignal = abort.signal;
    context.readSourceSnapshot = async version => {
      if (change === "cancel") abort.abort(new Error("fallback cancelled"));
      else context.app = createWebContext(context.httpTransport).app;
      return snapshots.get(version)!;
    };
    await assert.rejects(fetchSnapshotMirror(context));
  }
});

test("whole-note fallback cannot accept a selected version without its immutable callback", async () => {
  const { context } = snapshotFallbackFixture();
  await writeSourceCacheNote(context, { url: SNAPSHOT_MIRROR, title: "Mirror study", content: USABLE_BODY });
  context.readSourceSnapshot = undefined;
  await assert.rejects(fetchSnapshotMirror(context));
});

test("whole-note fallback retains the writer's clipped snapshot and original coverage", async () => {
  const { context } = snapshotFallbackFixture();
  const long = USABLE_BODY.repeat(Math.ceil(60000 / USABLE_BODY.length) + 2);
  const cached = await writeSourceCacheNote(context, { url: SNAPSHOT_MIRROR, title: "Mirror study", content: long });
  const output = await fetchSnapshotMirror(context);
  assert.equal(output.fromCache, true);
  assert.equal(output.snapshotSha256, cached.snapshotSha256);
  assert.equal(output.contentHash, cached.contentHash);
  assert.equal(output.truncated, true);
  assert.equal(output.sourceChars, long.length);
  assert.equal(output.totalChars, cached.totalChars);
  assert.ok(output.content.startsWith(USABLE_BODY));
});
test("whole-note fallback refuses a clipped snapshot selected as complete", async () => {
  const { context } = snapshotFallbackFixture();
  const long = USABLE_BODY.repeat(Math.ceil(60000 / USABLE_BODY.length) + 2);
  await writeSourceCacheNote(context, { url: SNAPSHOT_MIRROR, title: "Mirror study", content: long });
  const file = context.app.vault.getFileByPath(SOURCE_CACHE_MANIFEST_PATH); assert.ok(file);
  const manifest = JSON.parse(await context.app.vault.read(file));
  manifest.entries[0].truncated = false;
  await context.app.vault.modify(file, JSON.stringify(manifest));
  await assert.rejects(fetchSnapshotMirror(context));
});
