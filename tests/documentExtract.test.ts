import assert from "node:assert/strict";
import test from "node:test";

import {
  clearCompanionBootstrapSessionV1,
  createSessionBootstrapTokenLeaseV1,
  installCompanionBootstrapSessionV1,
} from "../packages/headless-runtime/src";
import {
  EXTRACT_DOCUMENT_TOOL_NAME,
  createDocumentExtractProvider,
  createDocumentExtractTools,
  MAX_DOCUMENT_BYTES,
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
