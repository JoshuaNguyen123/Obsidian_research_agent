import assert from "node:assert/strict";
import test from "node:test";

import { processTestVaultFile } from "./helpers/atomicTestVault";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/model/types";
import type { ToolExecutionContext } from "../src/tools/types";
import { webFetchTool } from "../src/tools/webTools";
import type {
  PublicFetchHopRequestV1,
  PublicFetchHopResponseV1,
  PublicFetchHopTransportV1,
} from "../src/tools/publicFetch";

/**
 * `web_fetch` used to have exactly one transport: Ollama Cloud's `/web_fetch`.
 * A vault pointed at a local Ollama, or at the cloud with no API key, could
 * search (that path already falls back to the keyless scholarly providers) but
 * could not read a single page — so no quotes, no verification, no citations.
 */

const PAGE = `<!doctype html><html><head><title>Solid-state batteries</title></head>
<body><main>
<h1>Solid-state batteries</h1>
<p>Solid electrolytes replace the flammable liquid electrolyte used in
conventional lithium-ion cells, which raises the practical energy density and
removes the thermal-runaway path that dominates pack-level safety design.</p>
<p>Manufacturing remains the constraint: sheet handling, stack pressure and
interface stability at scale are each unsolved at automotive volumes.</p>
</main></body></html>`;

type FetchOutput = {
  title: string;
  url: string;
  content: string;
  sourceTransport?: string;
  fromCache: boolean;
  cachedPath?: string;
  parserStatus?: string;
};

test("a cloud vault with no key reads the page directly instead of failing", async () => {
  const harness = createHarness({ ollamaApiKey: "" });
  const result = (await webFetchTool.execute(
    { url: "https://batteries.example/solid-state", query: "solid-state batteries" },
    harness.context,
  )) as FetchOutput;

  assert.equal(result.title, "Solid-state batteries");
  assert.match(result.content, /Solid electrolytes replace the flammable liquid electrolyte/u);
  assert.ok(!result.content.includes("<"), "markup must not reach the model");
  assert.deepEqual(harness.requestedUrls, ["https://batteries.example/solid-state"]);
  assert.ok(
    harness.requestedUrls.every((url) => !url.includes("/web_fetch")),
    "the cloud retrieval endpoint must not be called without a key",
  );
  assert.ok(result.cachedPath, "the page is cached like any other source");
});

test("a local Ollama that does not serve the route falls back to reading the page", async () => {
  // A non-cloud base URL may be a proxy that does serve /web_fetch, so it is
  // still tried first; only its failure routes to the direct read.
  const harness = createHarness({
    ollamaApiKey: "",
    ollamaBaseUrl: "http://localhost:11434",
    endpointStatus: 404,
  });
  const result = (await webFetchTool.execute(
    { url: "https://batteries.example/solid-state", query: "solid-state batteries" },
    harness.context,
  )) as FetchOutput;
  assert.match(result.content, /Manufacturing remains the constraint/u);
  assert.deepEqual(harness.requestedUrls, [
    "http://localhost:11434/web_fetch",
    "https://batteries.example/solid-state",
  ]);
});

test("a configured proxy that does serve the route keeps its answer", async () => {
  const harness = createHarness({
    ollamaApiKey: "",
    ollamaBaseUrl: "https://proxy.internal.example/api",
  });
  const result = (await webFetchTool.execute(
    { url: "https://batteries.example/solid-state", query: "solid-state batteries" },
    harness.context,
  )) as FetchOutput;
  assert.match(result.content, /Endpoint passage about solid-state batteries/u);
  assert.deepEqual(harness.requestedUrls, [
    "https://proxy.internal.example/api/web_fetch",
  ]);
});

test("a configured cloud key still uses the retrieval endpoint", async () => {
  const harness = createHarness({ ollamaApiKey: "key" });
  const result = (await webFetchTool.execute(
    { url: "https://batteries.example/solid-state", query: "solid-state batteries" },
    harness.context,
  )) as FetchOutput;
  assert.match(result.content, /Endpoint passage about solid-state batteries/u);
  assert.deepEqual(harness.requestedUrls, ["https://ollama.com/api/web_fetch"]);
});

test("a failing retrieval endpoint falls back to reading the page directly", async () => {
  const harness = createHarness({ ollamaApiKey: "key", endpointStatus: 503 });
  const result = (await webFetchTool.execute(
    { url: "https://batteries.example/solid-state", query: "solid-state batteries" },
    harness.context,
  )) as FetchOutput;
  assert.match(result.content, /Solid electrolytes replace/u);
  assert.ok(harness.requestedUrls.includes("https://batteries.example/solid-state"));
});

test("a non-text response is not stringified into a source", async () => {
  const harness = createHarness({
    ollamaApiKey: "",
    pageContentType: "application/pdf",
  });
  // The reader refuses bytes it cannot read rather than stringifying them
  // into a citable source; extract_document is the seat with a PDF parser, and
  // the failure names the URL that could not be retrieved.
  await assert.rejects(
    () =>
      webFetchTool.execute(
        { url: "https://batteries.example/solid-state.pdf", query: "solid-state batteries" },
        harness.context,
      ),
    (error: unknown) =>
      error instanceof Error &&
      /could not retrieve/u.test(error.message) &&
      !/%PDF/u.test(error.message),
  );
  assert.deepEqual(
    [...harness.content.keys()].filter((path) => path.startsWith("Agent Sources/")),
    [],
    "nothing unreadable may be cached as a source",
  );
});

test("a page that redirects to a private address is refused and nothing is cached", async () => {
  // The direct read used requestUrl, which followed this redirect out of the
  // host policy's sight and cached the companion's response as a source.
  const hops: string[] = [];
  const hop: PublicFetchHopTransportV1 = async (request: PublicFetchHopRequestV1) => {
    hops.push(request.url);
    if (request.url === "https://batteries.example/solid-state") {
      return {
        status: 302,
        headers: { location: "http://127.0.0.1:8765/v1/health" },
        bytes: new Uint8Array(0),
        truncated: false,
      } satisfies PublicFetchHopResponseV1;
    }
    throw new Error(`the private hop must never be requested: ${request.url}`);
  };
  const harness = createHarness({ ollamaApiKey: "", publicFetchTransport: hop });
  await assert.rejects(
    () =>
      webFetchTool.execute(
        { url: "https://batteries.example/solid-state", query: "solid-state batteries" },
        harness.context,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(
        "could not retrieve https://batteries.example/solid-state directly: it redirected to a local or private network address",
      ),
  );
  assert.deepEqual(hops, ["https://batteries.example/solid-state"]);
  assert.deepEqual(
    [...harness.content.keys()].filter((path) => path.startsWith("Agent Sources/")),
    [],
  );
});

test("when the endpoint and the direct read both fail, the error names both", async () => {
  const hop: PublicFetchHopTransportV1 = async () => ({
    status: 404,
    headers: {},
    bytes: new Uint8Array(0),
    truncated: false,
  });
  const harness = createHarness({
    ollamaApiKey: "key",
    endpointStatus: 503,
    publicFetchTransport: hop,
  });
  await assert.rejects(
    () =>
      webFetchTool.execute(
        { url: "https://batteries.example/missing", query: "solid-state batteries" },
        harness.context,
      ),
    (error: unknown) =>
      error instanceof Error &&
      /web_fetch failed with status 503/u.test(error.message) &&
      /direct read failed: HTTP 404/u.test(error.message),
  );
});

test("the direct read goes through the hop transport when one is supplied", async () => {
  const hops: string[] = [];
  const hop: PublicFetchHopTransportV1 = async (request) => {
    hops.push(request.url);
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      bytes: new TextEncoder().encode(PAGE),
      truncated: false,
    };
  };
  const harness = createHarness({ ollamaApiKey: "", publicFetchTransport: hop });
  const result = (await webFetchTool.execute(
    { url: "https://batteries.example/solid-state", query: "solid-state batteries" },
    harness.context,
  )) as FetchOutput;
  assert.match(result.content, /Solid electrolytes replace/u);
  assert.deepEqual(hops, ["https://batteries.example/solid-state"]);
  assert.deepEqual(harness.requestedUrls, [], "requestUrl must not fetch the page");
});

function createHarness(options: {
  ollamaApiKey: string;
  ollamaBaseUrl?: string;
  endpointStatus?: number;
  pageContentType?: string;
  publicFetchTransport?: PublicFetchHopTransportV1;
}) {
  const content = new Map<string, string>();
  const folders = new Set<string>();
  const revisions = new Map<string, number>();
  const requestedUrls: string[] = [];

  const getFile = (path: string) =>
    content.has(path)
      ? {
          path,
          basename: path.split("/").pop()?.replace(/\.[^.]+$/iu, "") ?? path,
          extension: path.split(".").pop()?.toLowerCase() ?? "",
          stat: { mtime: revisions.get(path) ?? 0, size: content.get(path)?.length ?? 0 },
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
      process: function (file: never, transform: (current: string) => string) {
        return processTestVaultFile(this, file, transform);
      },
      modify: async (file: { path: string }, data: string) => {
        content.set(file.path, data);
        revisions.set(file.path, (revisions.get(file.path) ?? 0) + 1);
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

  const httpTransport: HttpTransport = async (request: HttpRequest) => {
    requestedUrls.push(request.url);
    if (request.url.endsWith("/web_fetch")) {
      if (options.endpointStatus && options.endpointStatus >= 400) {
        return { status: options.endpointStatus, headers: {} } as HttpResponse;
      }
      return {
        status: 200,
        headers: {},
        json: {
          title: "Solid-state batteries",
          content:
            "Endpoint passage about solid-state batteries and their manufacturing constraints at automotive volumes.",
          links: [],
        },
      } as HttpResponse;
    }
    return {
      status: 200,
      headers: { "content-type": options.pageContentType ?? "text/html; charset=utf-8" },
      text: options.pageContentType === "application/pdf" ? "%PDF-1.7 binary" : PAGE,
    } as HttpResponse;
  };

  const context = {
    app: app as never,
    settings: {
      ollamaBaseUrl: options.ollamaBaseUrl ?? "https://ollama.com/api",
      ollamaApiKey: options.ollamaApiKey,
      requestTimeoutMs: 30_000,
      freeSearchFallbackEnabled: false,
    } as never,
    originalPrompt: "Summarize solid-state battery progress with sources.",
    httpTransport,
    publicFetchTransport: options.publicFetchTransport,
    now: () => new Date("2026-09-14T10:00:00Z"),
  } as unknown as ToolExecutionContext;

  return { context, content, folders, requestedUrls };
}
