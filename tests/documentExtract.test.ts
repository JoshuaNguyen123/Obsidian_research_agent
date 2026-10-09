import { processTestVaultFile } from "./helpers/atomicTestVault";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readSourceSection, writeSourceCacheNote } from "../src/tools/sourceCache";

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

test("local root PDF identity cannot be mistaken for a bare web domain", async () => {
  const disconnect = connectCompanion(), recorded: Recorded = { requests: [] };
  try {
    const context = createExtractVaultContext(companionJson({ status: "parsed", text: "Exact local content.", pageCount: 1, pagesExtracted: 1, pagesSkipped: 0, truncated: false }), { vaultFiles: { "study.pdf": pdfBytes() } });
    const transport = context.httpTransport!;
    context.httpTransport = request => { recorded.requests.push(request); return transport(request); };
    const captures: string[] = [];
    context.captureSourceSnapshot = async source => { captures.push(source.url); return { snapshotSha256: "a".repeat(64) }; };
    const result = await createDocumentExtractTools()[0]!.executeResult!({ path: "study.pdf" }, context);
    assert.equal(result.ok, true);
    assert.equal((result.output as { url: string }).url, "vault://study.pdf");
    assert.equal((result.output as { title: string }).title, "study.pdf");
    assert.equal(result.receipt?.resource.id, "vault://study.pdf");
    assert.deepEqual(captures, ["vault://study.pdf"]);
    assert.equal(recorded.requests.length, 1, "local bytes must not trigger an external download");
    assert.equal(JSON.parse(String(recorded.requests[0]!.body)).sourceUrl, null);
  } finally { disconnect(); }
});

test("nested, spaced and Unicode vault paths retain their own identity and path guards", async () => {
  const disconnect = connectCompanion();
  try {
    for (const path of ["Papers/study.pdf", "Papers/My study.pdf", "ç ”ç©¶.pdf"]) {
      const context = createExtractVaultContext(companionJson({ status: "parsed", text: "Exact local content.", pageCount: 1, pagesExtracted: 1, pagesSkipped: 0, truncated: false }), { vaultFiles: { [path]: pdfBytes() } });
      const captures: string[] = [];
      context.captureSourceSnapshot = async source => { captures.push(source.url); return { snapshotSha256: "b".repeat(64) }; };
      const result = await createDocumentExtractTools()[0]!.executeResult!({ path }, context);
      assert.equal(result.ok, true);
      assert.equal((result.output as { url: string }).url, `vault://${path}`);
      assert.equal((result.output as { path: string }).path, path);
      assert.deepEqual(captures, [new URL(`vault://${path}`).toString()]);
    }
    const context = createExtractVaultContext(companionJson({ status: "parsed", text: "Never read." }));
    for (const path of ["../study.pdf", "/study.pdf", "C:/study.pdf", ".obsidian/study.pdf", "Papers\\study.pdf"]) {
      await assert.rejects(() => createDocumentExtractTools()[0]!.executeResult!({ path }, context), /Unsafe path/u);
    }
  } finally { disconnect(); }
});

test("explicit URL attribution with a vault path retains public URL policy and remote identity", async () => {
  const disconnect = connectCompanion(), recorded: Recorded = { requests: [] };
  try {
    const context = createExtractVaultContext(companionJson({ status: "parsed", text: "Attributed local bytes.", pageCount: 1, pagesExtracted: 1, pagesSkipped: 0, truncated: false }), { vaultFiles: { "study.pdf": pdfBytes() } });
    const transport = context.httpTransport!;
    context.httpTransport = request => { recorded.requests.push(request); return transport(request); };
    const result = await createDocumentExtractTools()[0]!.executeResult!({ path: "study.pdf", url: PDF_URL }, context);
    assert.equal((result.output as { url: string }).url, PDF_URL);
    assert.equal(result.receipt?.resource.id, PDF_URL);
    assert.equal(recorded.requests.length, 1);
    assert.equal(JSON.parse(String(recorded.requests[0]!.body)).sourceUrl, PDF_URL);
    await assert.rejects(() => createDocumentExtractTools()[0]!.executeResult!({ path: "study.pdf", url: "http://127.0.0.1/report.pdf" }, context), /local or private network/u);
  } finally { disconnect(); }
});

test("bare public document domains and explicit web URLs keep existing download behavior", async () => {
  const disconnect = connectCompanion();
  try {
    for (const input of ["reports.example/study.pdf", "https://reports.example/study.pdf"]) {
      const recorded: Recorded = { requests: [] };
      const context = createExtractVaultContext(companionJson({ status: "parsed", text: "Web content.", pageCount: 1, pagesExtracted: 1, pagesSkipped: 0, truncated: false }));
      const transport = context.httpTransport!;
      context.httpTransport = request => { recorded.requests.push(request); return transport(request); };
      const result = await createDocumentExtractTools()[0]!.executeResult!({ url: input }, context);
      assert.equal((result.output as { url: string }).url, "https://reports.example/study.pdf");
      assert.equal(recorded.requests.length, 2);
      assert.equal(recorded.requests[0]!.url, "https://reports.example/study.pdf");
      assert.equal(JSON.parse(String(recorded.requests[1]!.body)).sourceUrl, "https://reports.example/study.pdf");
    }
  } finally { disconnect(); }
});

test("canonical local extraction cannot rewrite legacy cache notes or old immutable versions", async () => {
  const disconnect = connectCompanion();
  try {
    const context = createExtractVaultContext(companionJson({ status: "parsed", text: "Current local value is 0.95 mg/L.", pageCount: 1, pagesExtracted: 1, pagesSkipped: 0, truncated: false }), { vaultFiles: { "study.pdf": pdfBytes() } });
    const oldVersion = "c".repeat(64);
    const old = { snapshotSha256: oldVersion, sourceId: "legacy-source-id", locator: "https://study.pdf/", title: "Legacy study", content: "Old value is 0.05 mg/L.", capturedAt: "2026-09-04T00:00:00Z" };
    const original = JSON.stringify(old), captures: string[] = [];
    context.readSourceSnapshot = async version => { assert.equal(version, oldVersion); return old; };
    context.captureSourceSnapshot = async source => { captures.push(source.url); return { snapshotSha256: createHash("sha256").update(source.url).update(source.content).digest("hex") }; };
    const cached = await writeSourceCacheNote(context, { url: old.locator, title: old.title, content: old.content });
    const legacyBytes = await context.app.vault.read(context.app.vault.getFileByPath(cached.vaultPath)!);
    const current = await createDocumentExtractTools()[0]!.executeResult!({ path: "study.pdf" }, context);
    assert.equal((current.output as { url: string }).url, "vault://study.pdf");
    assert.deepEqual(captures, ["https://study.pdf/", "vault://study.pdf"]);
    assert.equal(await context.app.vault.read(context.app.vault.getFileByPath(cached.vaultPath)!), legacyBytes);
    assert.equal((await readSourceSection(context, { url: old.locator, version: oldVersion }, 1)).content, old.content);
    assert.equal(JSON.stringify(old), original);
    await assert.rejects(readSourceSection(context, { url: "vault://study.pdf", version: oldVersion }, 1), /identity mismatch/u);
    const provider = createDocumentExtractProvider(context, { fetchDocument: async () => ({ bytes: pdfBytes(), contentType: "application/pdf" }) });
    assert.equal((await provider.retrieve({ id: "legacy", url: "Papers/legacy.pdf", strategy: "document_extract" }))?.url, "Papers/legacy.pdf");
  } finally { disconnect(); }
});

test("a document URL that redirects to the companion is refused before the redirect is followed", async () => {
  // document_extract downloads on the user's machine, where the companion
  // listens on loopback. requestUrl followed this redirect out of the host
  // policy's sight; the hop transport hands it back to be judged instead.
  const disconnect = connectCompanion();
  const hops: string[] = [];
  try {
    const context = {
      ...contextFor(companionJson({ ok: true, status: "parsed", text: "never" })),
      publicFetchTransport: async (request: { url: string }) => {
        hops.push(request.url);
        return {
          status: 302,
          headers: { location: `${BASE_URL}/v1/health` },
          bytes: new Uint8Array(0),
          truncated: false,
        };
      },
    } as unknown as ToolExecutionContext;
    const provider = createDocumentExtractProvider(context);
    await assert.rejects(
      () => provider.retrieve({ id: "primary-9", url: PDF_URL, strategy: "document_extract" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("redirected to a local or private network address"),
    );
    assert.deepEqual(hops, [PDF_URL]);
  } finally {
    disconnect();
  }
});

test("an oversized document is refused after one byte past the limit, not after the whole download", async () => {
  const disconnect = connectCompanion();
  let requestedCap = 0;
  try {
    const context = {
      ...contextFor(companionJson({ ok: true, status: "parsed", text: "never" })),
      publicFetchTransport: async (request: { maxBytes: number }) => {
        requestedCap = request.maxBytes;
        return {
          status: 200,
          headers: { "content-type": "application/pdf" },
          bytes: new Uint8Array(request.maxBytes),
          truncated: true,
        };
      },
    } as unknown as ToolExecutionContext;
    const provider = createDocumentExtractProvider(context);
    await assert.rejects(
      () => provider.retrieve({ id: "primary-10", url: PDF_URL, strategy: "document_extract" }),
      (error: unknown) =>
        error instanceof ToolExecutionError && /will not send a document over/u.test(error.message),
    );
    assert.equal(requestedCap, MAX_DOCUMENT_BYTES + 1);
  } finally {
    disconnect();
  }
});

const completeExtract = () => companionJson({ status: "parsed", text: "## Page 1\n\nExact measured value -0.05 mg/L.", pageCount: 1, pagesExtracted: 1, pagesSkipped: 0, truncated: false });

test("derived reuse skips a second parse across tools while preserving each locator title and capture", async () => {
  const disconnect = connectCompanion();
  try {
    const context = createExtractVaultContext(completeExtract(), { vaultFiles: { "one.pdf": pdfBytes(), "two.pdf": pdfBytes() } });
    let posts = 0, reads = 0; const transport = context.httpTransport!, read = context.app.vault.readBinary!;
    context.httpTransport = request => { posts++; return transport(request); };
    context.app.vault.readBinary = async file => { reads++; return read(file); };
    const captures: Array<{url: string; title: string}> = [];
    context.captureSourceSnapshot = async source => { captures.push({ url: source.url, title: source.title }); return { snapshotSha256: "a".repeat(64) }; };
    const first = await createDocumentExtractTools()[0]!.executeResult!({ path: "one.pdf", title: "First report" }, context);
    (first.output as { content: string }).content = "Caller mutation";
    const second = await createDocumentExtractTools()[0]!.executeResult!({ path: "two.pdf", title: "Second report" }, context);
    assert.equal(posts, 1); assert.equal(reads, 2, "current bytes still checked for replacement");
    assert.equal((second.output as { url: string }).url, "vault://two.pdf");
    assert.match((second.output as { content: string }).content, /-0\.05 mg\/L/u);
    assert.deepEqual(captures, [{ url: "vault://one.pdf", title: "First report" }, { url: "vault://two.pdf", title: "Second report" }]);
    const isolated = createExtractVaultContext(completeExtract(), { vaultFiles: { "one.pdf": pdfBytes() } });
    let isolatedPosts = 0; const otherTransport = isolated.httpTransport!;
    isolated.httpTransport = request => { isolatedPosts++; return otherTransport(request); };
    await createDocumentExtractTools()[0]!.executeResult!({ path: "one.pdf" }, isolated);
    assert.equal(isolatedPosts, 1, "no reuse across vault owners");
  } finally { disconnect(); }
});

test("derived reuse binds current bytes including equal-length replacement", async () => {
  const disconnect = connectCompanion();
  try {
    const context = createExtractVaultContext(completeExtract(), { vaultFiles: { "one.pdf": pdfBytes() } });
    let posts = 0; const transport = context.httpTransport!;
    context.httpTransport = request => { posts++; return transport(request); };
    let current = pdfBytes("%PDF-1.4 value -0.05"); context.app.vault.readBinary = async () => current;
    const tool = createDocumentExtractTools()[0]!;
    await tool.executeResult!({ path: "one.pdf" }, context); await tool.executeResult!({ path: "one.pdf" }, context);
    assert.equal(posts, 1);
    current = pdfBytes("%PDF-1.4 value -0.95"); await tool.executeResult!({ path: "one.pdf" }, context);
    assert.equal(posts, 2);
  } finally { disconnect(); }
});

test("derived reuse invalidates on timeout build or live session identity and refuses disposed authorization", async () => {
  let disconnect = connectCompanion();
  try {
    const context = createExtractVaultContext(completeExtract(), { vaultFiles: { "one.pdf": pdfBytes() } });
    let posts = 0; const transport = context.httpTransport!;
    context.httpTransport = request => { posts++; return transport(request); };
    const run = () => createDocumentExtractTools()[0]!.executeResult!({ path: "one.pdf" }, context);
    await run(); await run(); assert.equal(posts, 1);
    context.settings.requestTimeoutMs = 17_000; await run(); assert.equal(posts, 2);
    context.pluginVersion = "different-build"; await run(); assert.equal(posts, 3);
    disconnect(); disconnect = connectCompanion(); await run(); assert.equal(posts, 4);
    disconnect(); const absent = await run(); assert.equal(absent.ok, false); assert.equal(posts, 4);
  } finally { disconnect(); }
});

test("derived cache hits cannot bypass abort deadline unsafe URL or current body limits", async () => {
  const disconnect = connectCompanion();
  try {
    const context = createExtractVaultContext(completeExtract(), { vaultFiles: { "one.pdf": pdfBytes() } });
    let posts = 0; const transport = context.httpTransport!;
    context.httpTransport = request => { posts++; return transport(request); };
    const run = (args: Record<string, unknown> = { path: "one.pdf" }) => createDocumentExtractTools()[0]!.executeResult!(args, context);
    await run();
    const controller = new AbortController(); controller.abort(); context.abortSignal = controller.signal;
    await assert.rejects(run(), /cancel|abort/iu); context.abortSignal = undefined;
    context.deadlineAt = Date.now() - 1; await assert.rejects(run(), /deadline/iu); context.deadlineAt = undefined;
    await assert.rejects(run({ path: "one.pdf", url: "http://127.0.0.1/one.pdf" }), /private network/u);
    context.app.vault.readBinary = async () => new Uint8Array(MAX_DOCUMENT_BYTES + 1).buffer;
    await assert.rejects(run(), /limit/u); assert.equal(posts, 1);
  } finally { disconnect(); }
});

test("late extract responses after config session or cancellation changes never populate derived cache or capture", async () => {
  let disconnect = connectCompanion();
  try {
    for (const change of ["config", "session", "abort"] as const) {
      const context = createExtractVaultContext(completeExtract(), { vaultFiles: { "one.pdf": pdfBytes() } });
      let posts = 0, captures = 0, release: ((value: HttpResponse) => void) | undefined;
      context.captureSourceSnapshot = async () => { captures++; return { snapshotSha256: "a".repeat(64) }; };
      context.httpTransport = async () => { posts++; if (posts === 1) return new Promise<HttpResponse>(resolve => { release = resolve; }); return completeExtract(); };
      const controller = new AbortController(); context.abortSignal = controller.signal;
      const run = () => createDocumentExtractTools()[0]!.executeResult!({ path: "one.pdf" }, context);
      const pending = run(); while (!release) await new Promise(resolve => setTimeout(resolve, 0));
      if (change === "config") context.settings.requestTimeoutMs = 15_000;
      if (change === "session") { disconnect(); disconnect = connectCompanion(); }
      if (change === "abort") controller.abort();
      release(completeExtract()); await assert.rejects(pending, /changed|stale|cancel|abort/iu); assert.equal(captures, 0);
      context.abortSignal = undefined; await run(); await run(); assert.equal(posts, 2); assert.equal(captures, 2);
    }
  } finally { disconnect(); }
});

test("empty partial failed and over-budget extracts are retried instead of retained", async () => {
  const disconnect = connectCompanion();
  try {
    for (const response of [companionJson({ status: "empty", text: "", pageCount: 1, pagesExtracted: 0, pagesSkipped: 0, truncated: false }), companionJson({ status: "parsed", text: "Partial.", pageCount: 2, pagesExtracted: 1, pagesSkipped: 1, truncated: false }), { status: 400, headers: {} }, companionJson({ status: "parsed", text: "x".repeat(8 * 1024 * 1024 + 1), pageCount: 1, pagesExtracted: 1, pagesSkipped: 0, truncated: false })]) {
      const context = contextFor(response); let posts = 0;
      context.httpTransport = async () => { posts++; return response; };
      const provider = createDocumentExtractProvider(context, { fetchDocument: async () => ({ bytes: pdfBytes() }) });
      const run = () => provider.retrieve({ id: "one", url: PDF_URL, strategy: "document_extract" });
      for (let index = 0; index < 2; index++) { if (response.status >= 400) await assert.rejects(run()); else await run(); }
      assert.equal(posts, 2);
    }
  } finally { disconnect(); }
});


const malformedCoverageCases: Array<[string, Record<string, unknown>]> = [
  ...[1.5, "1", -1, Number.MAX_SAFE_INTEGER + 1, undefined, null].map((value, index) => [`pageCount-${index}`, { pageCount: value }] as [string, Record<string, unknown>]),
  ...[1.5, "1", -1, Number.MAX_SAFE_INTEGER + 1, undefined].map((value, index) => [`pagesExtracted-${index}`, { pagesExtracted: value }] as [string, Record<string, unknown>]),
  ...[0.5, "0", -1, Number.MAX_SAFE_INTEGER + 1, undefined].map((value, index) => [`pagesSkipped-${index}`, { pagesSkipped: value }] as [string, Record<string, unknown>]),
  ...["false", undefined, null].map((value, index) => [`truncated-${index}`, { truncated: value }] as [string, Record<string, unknown>]),
  ["extracted-exceeds-total", { pagesExtracted: 2 }],
  ["combined-counts-exceed-total", { pagesSkipped: 1 }],
];
for (const [name, changes] of malformedCoverageCases) {
  test(`malformed coverage ${name} is refused without capture or derived retention`, async () => {
    const disconnect = connectCompanion();
    try {
      const payload = { ...(completeExtract().json as Record<string, unknown>), ...changes };
      const response = { status: 200, headers: {}, json: payload };
      const context = createExtractVaultContext(response, { vaultFiles: { "one.pdf": pdfBytes() } });
      let posts = 0, captures = 0; context.httpTransport = async () => { posts++; return response; };
      context.captureSourceSnapshot = async () => { captures++; return { snapshotSha256: "a".repeat(64) }; };
      for (let index = 0; index < 2; index++) {
        await assert.rejects(createDocumentExtractTools()[0]!.executeResult!({ path: "one.pdf" }, context), (error: unknown) => error instanceof ToolExecutionError && error.code === "source_unusable");
      }
      assert.equal(posts, 2); assert.equal(captures, 0);
    } finally { disconnect(); }
  });
}
test("strict response coverage retains a valid zero-page empty result without caching it", async () => {
  const disconnect = connectCompanion();
  try {
    const response = companionJson({ status: "empty", text: "", reason: "unreadable", pageCount: 0, pagesExtracted: 0, pagesSkipped: 0, truncated: false });
    const context = createExtractVaultContext(response, { vaultFiles: { "one.pdf": pdfBytes() } });
    let posts = 0, captures = 0; context.httpTransport = async () => { posts++; return response; };
    context.captureSourceSnapshot = async () => { captures++; return { snapshotSha256: "a".repeat(64) }; };
    for (let index = 0; index < 2; index++) {
      const result = await createDocumentExtractTools()[0]!.executeResult!({ path: "one.pdf" }, context);
      assert.equal((result.output as {parserStatus: string}).parserStatus, "empty");
    }
    assert.equal(posts, 2); assert.equal(captures, 0);
  } finally { disconnect(); }
});
