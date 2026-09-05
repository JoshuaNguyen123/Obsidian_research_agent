import { processTestVaultFile } from "./helpers/atomicTestVault";
import assert from "node:assert/strict";
import test from "node:test";

import {
  clearCompanionBootstrapSessionV1,
  createSessionBootstrapTokenLeaseV1,
  installCompanionBootstrapSessionV1,
} from "../packages/headless-runtime/src";
import { descriptorFor } from "../src/tools/toolDescriptors";
import { effectClassForTool } from "../src/agent/autonomyEffectClass";
import { RESEARCHER_SOFT_TOOL_NAMES } from "../src/orchestrator/researcherSoftCatalog";
import { createCitationTools } from "../src/tools/citationTools";
import {
  EXTRACT_DOCUMENT_TOOL_NAME,
  createDocumentExtractProvider,
  createDocumentExtractTools,
  COMPANION_DEFAULT_MAX_BODY_BYTES,
  MAX_DOCUMENT_BYTES,
  maxDocumentBytesForCompanionBody,
} from "../src/tools/documentExtract";
import { retrieveUsableResearchSource } from "../src/orchestrator/researchProvider";
import { ToolExecutionError, type ToolExecutionContext } from "../src/tools/types";
import type { HttpRequest, HttpResponse } from "../src/model/types";

const BASE_URL = "http://127.0.0.1:18791";
const BOOTSTRAP_TOKEN = "document-extract-bootstrap-token-0123456789ab";
const PDF_URL = "https://reports.example/opinions/2026-04.pdf";

interface Recorded {
  requests: HttpRequest[];
}

function connectCompanion(): () => void {
  clearCompanionBootstrapSessionV1(BASE_URL);
  return installCompanionBootstrapSessionV1({
    version: 1,
    baseUrl: BASE_URL,
    credential: createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN),
    connectedAt: "2026-08-23T00:00:00.000Z",
  });
}

function pdfBytes(body = "%PDF-1.4 opinion bytes"): ArrayBuffer {
  const bytes = new TextEncoder().encode(body);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function contextFor(
  companionResponse: HttpResponse,
  options: {
    download?: HttpResponse;
    recorded?: Recorded;
  } = {},
): ToolExecutionContext {
  const download: HttpResponse = options.download ?? {
    status: 200,
    headers: { "content-type": "application/pdf" },
    arrayBuffer: pdfBytes(),
  };
  return {
    settings: { companionBaseUrl: BASE_URL, requestTimeoutMs: 30_000 },
    httpTransport: async (request: HttpRequest) => {
      options.recorded?.requests.push(request);
      return request.url.startsWith(BASE_URL) ? companionResponse : download;
    },
  } as unknown as ToolExecutionContext;
}

function companionJson(payload: Record<string, unknown>): HttpResponse {
  return { status: 200, headers: {}, json: payload };
}

test("the document provider serves exactly the document_extract strategy", () => {
  const provider = createDocumentExtractProvider(contextFor(companionJson({})));
  assert.deepEqual(provider.strategies, ["document_extract"]);
  assert.equal(provider.id, "companion-document-extract");
});

test("a parsed pdf comes back as page-marked content posted as base64 under bearer auth", async () => {
  const disconnect = connectCompanion();
  const recorded: Recorded = { requests: [] };
  try {
    const provider = createDocumentExtractProvider(
      contextFor(
        companionJson({
          ok: true,
          status: "parsed",
          reason: null,
          url: PDF_URL,
          text: "## Page 1\n\nOpinion of the Court\n\n## Page 2\n\nDissent",
          pageCount: 2,
          pagesExtracted: 2,
          pagesSkipped: 0,
          truncated: false,
        }),
        { recorded },
      ),
    );

    const output = await provider.retrieve({
      id: "primary-4",
      url: PDF_URL,
      strategy: "document_extract",
    });

    assert.ok(output);
    assert.equal(output.url, PDF_URL);
    assert.equal(output.title, "2026-04.pdf");
    assert.equal(output.parserStatus, "parsed");
    assert.match(output.content, /^## Page 1\n\nOpinion of the Court/u);
    assert.deepEqual(output.providerMetadata, {
      document: true,
      reason: undefined,
      contentType: "application/pdf",
      pageCount: 2,
      pagesExtracted: 2,
      pagesSkipped: 0,
      truncated: false,
    });

    const [download, extract] = recorded.requests;
    assert.equal(download?.url, PDF_URL);
    assert.equal(download?.method, "GET");
    assert.equal(extract?.url, `${BASE_URL}/document/extract_text`);
    assert.equal(extract?.headers?.Authorization, `Bearer ${BOOTSTRAP_TOKEN}`);
    const body = JSON.parse(String(extract?.body)) as Record<string, unknown>;
    assert.equal(body.sourceUrl, PDF_URL);
    assert.equal(
      Buffer.from(String(body.contentBase64), "base64").toString("utf8"),
      "%PDF-1.4 opinion bytes",
    );
  } finally {
    disconnect();
  }
});

test("a pdf with no text layer is reported empty, never as a parsed source that said nothing", async () => {
  const disconnect = connectCompanion();
  try {
    const provider = createDocumentExtractProvider(
      contextFor(
        companionJson({
          ok: true,
          status: "empty",
          reason: "no_extractable_text",
          text: "",
          pageCount: 12,
          pagesExtracted: 0,
          pagesSkipped: 0,
          truncated: false,
        }),
      ),
    );

    const output = await provider.retrieve({
      id: "primary-4",
      url: PDF_URL,
      strategy: "document_extract",
    });

    assert.ok(output);
    assert.equal(output.content, "");
    assert.equal(output.parserStatus, "empty");
    assert.equal(
      (output.providerMetadata as { reason?: string }).reason,
      "no_extractable_text",
    );
  } finally {
    disconnect();
  }
});

test("an encrypted pdf never leaks companion text into a parsed status", async () => {
  const disconnect = connectCompanion();
  try {
    const provider = createDocumentExtractProvider(
      contextFor(
        companionJson({
          ok: true,
          // A defensive companion returns no text with this status; even if it
          // did, the provider must not promote it to a parsed source.
          status: "empty",
          reason: "encrypted",
          text: "leftover",
          pageCount: 0,
          pagesExtracted: 0,
          pagesSkipped: 0,
          truncated: false,
        }),
      ),
    );

    const output = await provider.retrieve({
      id: "primary-4",
      url: PDF_URL,
      strategy: "document_extract",
    });

    assert.equal(output?.content, "");
    assert.equal(output?.parserStatus, "empty");
    assert.equal(
      (output?.providerMetadata as { reason?: string }).reason,
      "encrypted",
    );
  } finally {
    disconnect();
  }
});

test("an empty document falls through the retrieval chain instead of being accepted", async () => {
  const disconnect = connectCompanion();
  try {
    const provider = createDocumentExtractProvider(
      contextFor(
        companionJson({
          ok: true,
          status: "empty",
          reason: "no_extractable_text",
          text: "",
          pageCount: 4,
          pagesExtracted: 0,
          pagesSkipped: 0,
          truncated: false,
        }),
      ),
    );

    const result = await retrieveUsableResearchSource({
      candidates: [{ id: "primary-4", url: PDF_URL, strategy: "document_extract" }],
      providers: [provider],
    });

    assert.equal(result.output, null);
    assert.equal(result.exhausted, true);
    // "empty" short-circuits usability as a parser failure, so the chain records
    // an unusable source rather than an empty one that merely lacked passages.
    assert.equal(result.attempts.at(-1)?.status, "unparsed");
    assert.equal(result.attempts.at(-1)?.reason, "parser_failed");
  } finally {
    disconnect();
  }
});

test("a companion failure surfaces as a source_unusable tool execution error", async () => {
  const disconnect = connectCompanion();
  try {
    const provider = createDocumentExtractProvider(
      contextFor({ status: 500, headers: {}, text: "boom" }),
    );

    await assert.rejects(
      provider.retrieve({ id: "primary-4", url: PDF_URL, strategy: "document_extract" }),
      (error: unknown) => {
        assert.ok(error instanceof ToolExecutionError);
        assert.equal(error.code, "source_unusable");
        assert.match(error.message, /companion \(HTTP 500\)/u);
        return true;
      },
    );
  } finally {
    disconnect();
  }
});

test("an unreadable companion payload is an error, not a silently parsed source", async () => {
  const disconnect = connectCompanion();
  try {
    const provider = createDocumentExtractProvider(
      contextFor({ status: 200, headers: {}, text: "not json" }),
    );

    await assert.rejects(
      provider.retrieve({ id: "primary-4", url: PDF_URL, strategy: "document_extract" }),
      (error: unknown) => {
        assert.ok(error instanceof ToolExecutionError);
        assert.equal(error.code, "source_unusable");
        return true;
      },
    );
  } finally {
    disconnect();
  }
});

test("a failed download is reported before anything reaches the companion", async () => {
  const disconnect = connectCompanion();
  const recorded: Recorded = { requests: [] };
  try {
    const provider = createDocumentExtractProvider(
      contextFor(companionJson({ status: "parsed", text: "unused" }), {
        download: { status: 404, headers: {} },
        recorded,
      }),
    );

    await assert.rejects(
      provider.retrieve({ id: "primary-4", url: PDF_URL, strategy: "document_extract" }),
      (error: unknown) => {
        assert.ok(error instanceof ToolExecutionError);
        assert.equal(error.code, "source_unusable");
        assert.match(error.message, /HTTP 404/u);
        return true;
      },
    );
    assert.equal(recorded.requests.length, 1);
  } finally {
    disconnect();
  }
});

test("a document larger than the companion body budget is refused by name", async () => {
  const disconnect = connectCompanion();
  try {
    const provider = createDocumentExtractProvider(
      contextFor(companionJson({ status: "parsed", text: "unused" }), {
        download: {
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(MAX_DOCUMENT_BYTES + 1),
        },
      }),
    );

    await assert.rejects(
      provider.retrieve({ id: "primary-4", url: PDF_URL, strategy: "document_extract" }),
      (error: unknown) => {
        assert.ok(error instanceof ToolExecutionError);
        assert.equal(error.code, "source_unusable");
        assert.match(error.message, new RegExp(`${MAX_DOCUMENT_BYTES}`, "u"));
        return true;
      },
    );
  } finally {
    disconnect();
  }
});

test("private and non-http document urls are rejected before any request", async () => {
  const disconnect = connectCompanion();
  const recorded: Recorded = { requests: [] };
  try {
    const provider = createDocumentExtractProvider(
      contextFor(companionJson({ status: "parsed", text: "unused" }), { recorded }),
    );

    for (const url of [
      "http://127.0.0.1/secret.pdf",
      "http://192.168.1.10/secret.pdf",
      "file:///etc/passwd",
      "",
    ]) {
      await assert.rejects(
        provider.retrieve({ id: "primary-4", url, strategy: "document_extract" }),
        (error: unknown) => {
          assert.ok(error instanceof ToolExecutionError, url);
          assert.equal(error.code, "invalid_arguments", url);
          return true;
        },
      );
    }
    assert.equal(recorded.requests.length, 0);
  } finally {
    disconnect();
  }
});

test("without a companion session nothing is downloaded or posted", async () => {
  clearCompanionBootstrapSessionV1(BASE_URL);
  const recorded: Recorded = { requests: [] };
  const provider = createDocumentExtractProvider(
    contextFor(companionJson({ status: "parsed", text: "unused" }), { recorded }),
  );

  await assert.rejects(
    provider.retrieve({ id: "primary-4", url: PDF_URL, strategy: "document_extract" }),
    (error: unknown) => {
      assert.ok(error instanceof ToolExecutionError);
      assert.equal(error.code, "invalid_state");
      return true;
    },
  );
  // The download still runs first; only the companion call is withheld.
  assert.deepEqual(
    recorded.requests.map((request) => request.url),
    [PDF_URL],
  );
});

test("an injected fetcher replaces the host-side download without touching the provider", async () => {
  const disconnect = connectCompanion();
  const recorded: Recorded = { requests: [] };
  try {
    const provider = createDocumentExtractProvider(
      contextFor(
        companionJson({
          ok: true,
          status: "parsed",
          reason: null,
          text: "## Page 1\n\nPinned bytes",
          pageCount: 1,
          pagesExtracted: 1,
          pagesSkipped: 0,
          truncated: false,
        }),
        { recorded },
      ),
      {
        fetchDocument: async () => ({
          bytes: pdfBytes("pinned"),
          contentType: "application/pdf",
        }),
      },
    );

    const output = await provider.retrieve({
      id: "primary-4",
      url: PDF_URL,
      title: "April 2026 opinion",
      strategy: "document_extract",
    });

    assert.equal(output?.title, "April 2026 opinion");
    assert.equal(output?.parserStatus, "parsed");
    assert.deepEqual(
      recorded.requests.map((request) => request.url),
      [`${BASE_URL}/document/extract_text`],
    );
  } finally {
    disconnect();
  }
});

test("extract_document is Soft, not Bound, and descriptorFor does not throw", () => {
  assert.doesNotThrow(() => descriptorFor(EXTRACT_DOCUMENT_TOOL_NAME));
  assert.equal(descriptorFor(EXTRACT_DOCUMENT_TOOL_NAME).risk, "low");
  assert.equal(descriptorFor(EXTRACT_DOCUMENT_TOOL_NAME).effect, "read");
  assert.equal(effectClassForTool(EXTRACT_DOCUMENT_TOOL_NAME), "soft");
  assert.notEqual(effectClassForTool(EXTRACT_DOCUMENT_TOOL_NAME), "bound");
  assert.ok(RESEARCHER_SOFT_TOOL_NAMES.includes(EXTRACT_DOCUMENT_TOOL_NAME));
  assert.ok(
    MAX_DOCUMENT_BYTES > 720_000,
    "companion-aligned document budget should be raised past the old 720k cap",
  );
  assert.equal(
    MAX_DOCUMENT_BYTES,
    maxDocumentBytesForCompanionBody(COMPANION_DEFAULT_MAX_BODY_BYTES),
  );
  assert.ok(MAX_DOCUMENT_BYTES * (4 / 3) + 2_048 <= COMPANION_DEFAULT_MAX_BODY_BYTES);
});

test("extract_document is a first-class tool that receipts a missing companion session", async () => {
  clearCompanionBootstrapSessionV1(BASE_URL);
  const [tool] = createDocumentExtractTools();
  assert.equal(tool.name, EXTRACT_DOCUMENT_TOOL_NAME);
  assert.ok(tool.descriptor);
  const recorded: Recorded = { requests: [] };
  const result = await tool.executeResult!(
    { url: PDF_URL },
    contextFor(companionJson({ status: "parsed", text: "unused" }), {
      recorded,
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.toolName, EXTRACT_DOCUMENT_TOOL_NAME);
  assert.equal(result.error?.code, "companion_session_required");
  assert.match(
    String(result.error?.message),
    /authenticated companion session/i,
  );
  assert.ok(result.receipt);
  assert.equal(result.receipt?.toolName, EXTRACT_DOCUMENT_TOOL_NAME);
  assert.match(result.receipt?.message ?? "", /companion session/i);
  assert.deepEqual(recorded.requests, []);
});

function createExtractVaultContext(
  companionResponse: HttpResponse,
  options: {
    download?: HttpResponse;
    vaultFiles?: Record<string, ArrayBuffer>;
  } = {},
): ToolExecutionContext {
  const content = new Map<string, string>();
  const folders = new Set<string>();
  const binaries = new Map<string, ArrayBuffer>(
    Object.entries(options.vaultFiles ?? {}),
  );
  const getFile = (path: string) =>
    content.has(path) || binaries.has(path)
      ? {
          path,
          basename: path.split("/").pop()?.replace(/\.[^.]+$/i, "") ?? path,
          extension: path.split(".").pop()?.toLowerCase() ?? "",
          stat: {
            mtime: 1,
            size:
              content.get(path)?.length ??
              binaries.get(path)?.byteLength ??
              0,
          },
        }
      : null;
  const base = contextFor(companionResponse, { download: options.download });
  return {
    ...base,
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    app: {
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
        readBinary: async (file: { path: string }) => {
          const value = binaries.get(file.path);
          if (!value) throw new Error(`Binary not found: ${file.path}`);
          return value;
        },
        getFiles: () =>
          [...new Set([...content.keys(), ...binaries.keys()])]
            .map((path) => getFile(path))
            .filter((file): file is NonNullable<typeof file> => Boolean(file)),
      },
    },
  } as unknown as ToolExecutionContext;
}

test("extract_document caches page text so verify_citation can support a PDF quote", async () => {
  const disconnect = connectCompanion();
  const quote = "Opinion of the Court holds the statute valid.";
  try {
    const [extract] = createDocumentExtractTools();
    const verify = createCitationTools().find((tool) => tool.name === "verify_citation")!;
    const context = createExtractVaultContext(
      companionJson({
        ok: true,
        status: "parsed",
        reason: null,
        text: `## Page 1\n\n${quote}\n`,
        pageCount: 1,
        pagesExtracted: 1,
        pagesSkipped: 0,
        truncated: false,
      }),
    );
    const extracted = await extract.executeResult!({ url: PDF_URL }, context);
    assert.equal(extracted.ok, true);
    assert.match(String((extracted.output as { content?: string }).content), /Opinion of the Court/u);

    const verified = (await verify.execute(
      { quote, url: PDF_URL },
      context,
    )) as Record<string, unknown>;
    assert.equal(verified.status, "supported");
    assert.equal(verified.sourceUrl, PDF_URL);
  } finally {
    disconnect();
  }
});

test("extract_document accepts a vault-relative .pdf path through normalizeVaultPath", async () => {
  const disconnect = connectCompanion();
  try {
    const [extract] = createDocumentExtractTools();
    const context = createExtractVaultContext(
      companionJson({
        ok: true,
        status: "parsed",
        reason: null,
        text: "## Page 1\n\nVault opinion text for citation checks.\n",
        pageCount: 1,
        pagesExtracted: 1,
        pagesSkipped: 0,
        truncated: false,
      }),
      { vaultFiles: { "Papers/opinion.pdf": pdfBytes() } },
    );
    const result = await extract.executeResult!(
      { path: "Papers/opinion.pdf" },
      context,
    );
    assert.equal(result.ok, true);
    assert.equal((result.output as { path?: string }).path, "Papers/opinion.pdf");
    assert.match(
      String((result.output as { content?: string }).content),
      /Vault opinion text/u,
    );

    await assert.rejects(
      () => extract.executeResult!({ path: "Papers/notes.md" }, context),
      /must be a \.pdf/u,
    );
    await assert.rejects(
      () => extract.executeResult!({ path: "../secret.pdf" }, context),
      /parent traversal/u,
    );
  } finally {
    disconnect();
  }
});
