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
    const url = requestedUrl(request);
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
