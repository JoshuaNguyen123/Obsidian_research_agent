import {
  resolveCompanionBootstrapSessionV1,
  type CompanionBootstrapSessionV1,
} from "../../packages/headless-runtime/src/companionCredentialSession";
import type {
  ResearchRetrievalCandidate,
  ResearchRetrievalOutput,
  ResearchRetrievalProvider,
} from "../orchestrator/researchProvider";
import type { ActionReceipt, ToolDescriptor } from "../agent/actions";
import { normalizePublicFetchUrlV1 } from "./fetchHostPolicy";
import { requestWithRetry } from "./httpRetry";
import { writeSourceCacheNote } from "./sourceCache";
import {
  ToolExecutionError,
  type AgentTool,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "./types";
import {
  getOptionalString,
  isRecord,
  normalizeVaultPath,
} from "./validation";

export const EXTRACT_DOCUMENT_TOOL_NAME = "extract_document";

/** Pages read out of one document before the rest is reported as truncated. */
export const DEFAULT_DOCUMENT_EXTRACT_PAGES = 100;

/** Characters returned for one document; the cache note sections the rest. */
export const DEFAULT_DOCUMENT_EXTRACT_CHARS = 60_000;

/**
 * Companion `/document/extract_text` is gated by `max_body_bytes` (1 MiB by
 * default in `companion/auth.py`). The JSON envelope plus base64 inflation
 * (~4/3) is the binding constraint, not a second host-side guess.
 */
export const COMPANION_DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DOCUMENT_EXTRACT_JSON_ENVELOPE_BYTES = 2_048;

/** Largest raw document that still fits one companion POST after base64. */
export function maxDocumentBytesForCompanionBody(
  maxBodyBytes = COMPANION_DEFAULT_MAX_BODY_BYTES,
): number {
  return Math.max(
    1,
    Math.floor((maxBodyBytes - DOCUMENT_EXTRACT_JSON_ENVELOPE_BYTES) * 3 / 4),
  );
}

export const MAX_DOCUMENT_BYTES = maxDocumentBytesForCompanionBody();

export interface DocumentBytesV1 {
  bytes: ArrayBuffer;
  contentType?: string;
}

export interface DocumentExtractProviderOptionsV1 {
  /**
   * Overrides how the document bytes are obtained. The default reads the URL
   * through `context.httpTransport` behind the same public-host filter
   * `web_fetch` applies. It is injectable because the companion deliberately
   * does not fetch (see `companion/schemas.py:DocumentExtractRequest`), so the
   * download happens host-side and a caller with a stricter, address-pinned
   * fetcher should be able to supply it without touching this provider.
   */
  fetchDocument?: (
    url: string,
    signal: AbortSignal | undefined,
  ) => Promise<DocumentBytesV1>;
}

interface DocumentExtractResponseV1 {
  status: "parsed" | "empty";
  reason: string | null;
  text: string;
  pageCount: number;
  pagesExtracted: number;
  pagesSkipped: number;
  truncated: boolean;
}

/**
 * Retrieval provider for PDFs and other document-like sources.
 *
 * The generic browser provider answers `document_extract` today by handing back
 * a PDF viewer's rendered HTML, which is junk or nothing. This one downloads
 * the bytes and posts them to the companion's `/document/extract_text` route,
 * which returns page-marked text so a citation can name a page.
 *
 * A document that yields no text — encrypted, or scanned images with no text
 * layer — comes back with `parserStatus: "empty"`, never `"parsed"`, so the
 * ordinary fallback chain moves on to another source instead of treating an
 * unreadable PDF as a source that said nothing.
 */
export function createDocumentExtractProvider(
  context: ToolExecutionContext,
  options: DocumentExtractProviderOptionsV1 = {},
): ResearchRetrievalProvider {
  const fetchDocument =
    options.fetchDocument ??
    ((url: string, signal: AbortSignal | undefined) =>
      downloadDocument(context, url, signal));

  return {
    id: "companion-document-extract",
    strategies: ["document_extract"],
    async retrieve(
      candidate: ResearchRetrievalCandidate,
      signal?: AbortSignal,
    ): Promise<ResearchRetrievalOutput | null> {
      const abortSignal = signal ?? context.abortSignal;
      assertDocumentOperationActive(context, abortSignal);
      const locator = resolveDocumentLocator(candidate.url, Boolean(options.fetchDocument));
      const document = await fetchDocument(
        locator.fetchUrl ?? locator.cacheUrl,
        abortSignal,
      );
      assertDocumentOperationActive(context, abortSignal);

      const extracted = await requestDocumentExtract(context, {
        url: locator.fetchUrl,
        title: candidate.title,
        document,
        signal: abortSignal,
      });
      const content = extracted.status === "parsed" ? extracted.text : "";
      if (content.trim()) {
        await cacheExtractedSource(context, {
          url: locator.cacheUrl,
          title:
            candidate.title?.trim() ||
            documentNameFromUrl(locator.fetchUrl ?? locator.cacheUrl),
          content,
        });
      }
      return {
        title:
          candidate.title?.trim() ||
          documentNameFromUrl(locator.fetchUrl ?? locator.cacheUrl),
        url: locator.cacheUrl,
        content,
        // The empty/parsed split is the whole point: an unreadable PDF must not
        // look like a parsed source with nothing to say.
        parserStatus: content.trim() ? "parsed" : "empty",
        providerMetadata: {
          document: true,
          reason: extracted.reason ?? undefined,
          contentType: document.contentType,
          pageCount: extracted.pageCount,
          pagesExtracted: extracted.pagesExtracted,
          pagesSkipped: extracted.pagesSkipped,
          truncated: extracted.truncated,
        },
      };
    },
  };
}

async function downloadDocument(
  context: ToolExecutionContext,
  url: string,
  signal: AbortSignal | undefined,
): Promise<DocumentBytesV1> {
  const response = await requestWithRetry(context.httpTransport, {
    url,
    method: "GET",
    headers: { Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5" },
    throw: false,
    timeoutMs: getDocumentTimeoutMs(context),
    abortSignal: signal,
  });
  if (response.status >= 400) {
    throw new ToolExecutionError(
      "source_unusable",
      `document_extract could not download ${url} (HTTP ${response.status}).`,
    );
  }
  const bytes = response.arrayBuffer;
  if (!bytes || bytes.byteLength === 0) {
    throw new ToolExecutionError(
      "source_unusable",
      `document_extract received no document bytes from ${url}.`,
    );
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new ToolExecutionError(
      "source_unusable",
      `document_extract will not send a ${bytes.byteLength}-byte document to the companion; the limit is ${MAX_DOCUMENT_BYTES} bytes.`,
    );
  }
  return { bytes, contentType: response.headers?.["content-type"] };
}

async function requestDocumentExtract(
  context: ToolExecutionContext,
  input: {
    url: string | null;
    title?: string;
    document: DocumentBytesV1;
    signal: AbortSignal | undefined;
  },
): Promise<DocumentExtractResponseV1> {
  const baseUrl = context.settings.companionBaseUrl.trim().replace(/\/+$/u, "");
  if (!baseUrl) {
    throw new ToolExecutionError(
      "invalid_state",
      "document_extract requires a configured companion base URL.",
    );
  }
  // resolveCompanionBootstrapSessionV1 throws on a non-loopback origin rather
  // than returning null; either way the answer is "no usable session".
  let session: CompanionBootstrapSessionV1 | null = null;
  try {
    session = resolveCompanionBootstrapSessionV1(baseUrl);
  } catch {
    session = null;
  }
  const credential = session?.credential;
  if (!credential) {
    throw new ToolExecutionError(
      "invalid_state",
      "document_extract requires an authenticated companion session.",
    );
  }
  const body = JSON.stringify({
    contentBase64: encodeBase64(new Uint8Array(input.document.bytes)),
    sourceUrl: input.url,
    title: input.title?.trim() || null,
    maxPages: DEFAULT_DOCUMENT_EXTRACT_PAGES,
    maxChars: DEFAULT_DOCUMENT_EXTRACT_CHARS,
  });
  if (body.length > COMPANION_DEFAULT_MAX_BODY_BYTES) {
    throw new ToolExecutionError(
      "source_unusable",
      `document_extract companion body is ${body.length} bytes; the limit is ${COMPANION_DEFAULT_MAX_BODY_BYTES} bytes.`,
    );
  }
  const response = await credential.withToken((token) =>
    requestWithRetry(context.httpTransport, {
      url: `${baseUrl}/document/extract_text`,
      method: "POST",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${token}`,
        "Cache-Control": "no-store",
      },
      throw: false,
      timeoutMs: getDocumentTimeoutMs(context),
      abortSignal: input.signal,
      body,
    }),
  );
  if (response.status >= 400) {
    throw new ToolExecutionError(
      "source_unusable",
      `document_extract failed on the companion (HTTP ${response.status}).`,
    );
  }
  return readDocumentExtractResponse(response.json ?? parseJsonText(response.text));
}

function readDocumentExtractResponse(value: unknown): DocumentExtractResponseV1 {
  if (!isRecord(value) || (value.status !== "parsed" && value.status !== "empty")) {
    throw new ToolExecutionError(
      "source_unusable",
      "document_extract received an unreadable companion response.",
    );
  }
  return {
    status: value.status,
    reason: typeof value.reason === "string" ? value.reason : null,
    text: typeof value.text === "string" ? value.text : "",
    pageCount: readCount(value.pageCount),
    pagesExtracted: readCount(value.pagesExtracted),
    pagesSkipped: readCount(value.pagesSkipped),
    truncated: value.truncated === true,
  };
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function parseJsonText(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  // Chunked so a multi-hundred-kilobyte document does not blow the argument
  // limit of String.fromCharCode.
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function normalizeDocumentUrl(rawUrl: string): string {
  if (!(rawUrl ?? "").trim()) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "document_extract URL cannot be empty.",
    );
  }
  // The same shared host policy web_fetch applies. This seat fetches from the
  // user's own machine, so a private-network literal in any spelling is the
  // one that matters most here.
  return normalizePublicFetchUrlV1(
    rawUrl,
    {
      invalid: "document_extract URL is invalid.",
      scheme: "document_extract only supports HTTP and HTTPS URLs.",
      credentials: "document_extract URLs with credentials are not allowed.",
      privateHost: "document_extract cannot fetch local or private network URLs.",
    },
    (message) => {
      throw new ToolExecutionError("invalid_arguments", message);
    },
  );
}

function documentNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || url;
  } catch {
    return url;
  }
}

function assertDocumentOperationActive(
  context: ToolExecutionContext,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) {
    throw new ToolExecutionError(
      "operation_cancelled",
      "Document extraction cancelled before it started.",
    );
  }
  if (
    typeof context.deadlineAt === "number" &&
    Number.isFinite(context.deadlineAt) &&
    Date.now() >= context.deadlineAt
  ) {
    throw new ToolExecutionError(
      "operation_deadline_exceeded",
      "Document extraction skipped because the run deadline expired.",
    );
  }
}

function resolveDocumentLocator(
  rawUrl: string,
  allowVaultCacheKey: boolean,
): { cacheUrl: string; fetchUrl: string | null } {
  const trimmed = (rawUrl ?? "").trim();
  if (isHttpDocumentLocator(trimmed)) {
    const url = normalizeDocumentUrl(trimmed);
    return { cacheUrl: url, fetchUrl: url };
  }
  if (allowVaultCacheKey && trimmed) {
    return { cacheUrl: trimmed, fetchUrl: null };
  }
  return { cacheUrl: normalizeDocumentUrl(trimmed), fetchUrl: normalizeDocumentUrl(trimmed) };
}

function isHttpDocumentLocator(value: string): boolean {
  return (
    /^https?:\/\//iu.test(value) ||
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|$)/iu.test(value)
  );
}

async function resolveExtractDocumentSource(
  context: ToolExecutionContext,
  input: { url?: string; path?: string },
): Promise<{
  cacheUrl: string;
  title: string;
  document: DocumentBytesV1;
  vaultPath?: string;
}> {
  if (input.path) {
    const vaultPath = normalizeVaultPdfPath(input.path);
    const document = await readVaultPdf(context, vaultPath);
    const cacheUrl = input.url?.trim()
      ? normalizeDocumentUrl(input.url)
      : vaultPath;
    return {
      cacheUrl,
      title: documentNameFromUrl(cacheUrl),
      document,
      vaultPath,
    };
  }
  const url = normalizeDocumentUrl(input.url ?? "");
  return {
    cacheUrl: url,
    title: documentNameFromUrl(url),
    document: await downloadDocument(context, url, context.abortSignal),
  };
}

function normalizeVaultPdfPath(path: string): string {
  const normalized = normalizeVaultPath(path);
  if (!normalized.toLowerCase().endsWith(".pdf")) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "extract_document vault path must be a .pdf file.",
    );
  }
  return normalized;
}

async function readVaultPdf(
  context: ToolExecutionContext,
  path: string,
): Promise<DocumentBytesV1> {
  const file = context.app?.vault?.getFileByPath(path);
  if (!file) {
    throw new ToolExecutionError(
      "source_unusable",
      `extract_document could not find vault PDF ${path}.`,
    );
  }
  const readBinary = context.app.vault.readBinary?.bind(context.app.vault);
  if (typeof readBinary !== "function") {
    throw new ToolExecutionError(
      "invalid_state",
      "extract_document requires vault.readBinary for a local .pdf path.",
    );
  }
  const bytes = await readBinary(file);
  if (!bytes || bytes.byteLength === 0) {
    throw new ToolExecutionError(
      "source_unusable",
      `extract_document received no document bytes from vault path ${path}.`,
    );
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new ToolExecutionError(
      "source_unusable",
      `document_extract will not send a ${bytes.byteLength}-byte document to the companion; the limit is ${MAX_DOCUMENT_BYTES} bytes.`,
    );
  }
  return { bytes, contentType: "application/pdf" };
}

async function cacheExtractedSource(
  context: ToolExecutionContext,
  source: { url: string; title: string; content: string },
): Promise<void> {
  if (!context.app?.vault || !source.content.trim()) {
    return;
  }
  try {
    await writeSourceCacheNote(context, {
      url: source.url,
      title: source.title,
      content: source.content,
      parserStatus: "parsed",
    });
  } catch {
    // Cache is an accelerator for verify_citation, not a precondition of extract.
  }
}

function getDocumentTimeoutMs(context: ToolExecutionContext): number {
  const configured = Math.max(1, context.settings.requestTimeoutMs);
  if (
    typeof context.deadlineAt !== "number" ||
    !Number.isFinite(context.deadlineAt)
  ) {
    return configured;
  }
  return Math.max(1, Math.min(configured, context.deadlineAt - Date.now()));
}

function resolveDocumentExtractCompanion(
  context: ToolExecutionContext,
): { baseUrl: string; session: CompanionBootstrapSessionV1 } | { error: string } {
  const baseUrl = context.settings.companionBaseUrl.trim().replace(/\/+$/u, "");
  if (!baseUrl) {
    return { error: "extract_document requires a configured companion base URL." };
  }
  let session: CompanionBootstrapSessionV1 | null = null;
  try {
    session = resolveCompanionBootstrapSessionV1(baseUrl);
  } catch {
    session = null;
  }
  if (!session?.credential) {
    return { error: "extract_document requires an authenticated companion session." };
  }
  return { baseUrl, session };
}

function companionAbsentReceipt(
  context: ToolExecutionContext,
  url: string,
  message: string,
): ToolExecutionResult {
  const now = new Date().toISOString();
  const receipt: ActionReceipt = {
    version: 1,
    id: "extract-document-companion-session-required",
    runId: context.runId?.trim() || "extract-document",
    actionId: "not_applied",
    toolName: EXTRACT_DOCUMENT_TOOL_NAME,
    operation: "read",
    resource: {
      system: "web",
      resourceType: "document",
      id: url || "unresolved",
      ...(url ? { url } : {}),
    },
    message,
    payloadFingerprint: "companion_session_required",
    grantId: "none",
    startedAt: now,
    committedAt: now,
    commitKind: "no_op",
    readback: { status: "not_required", checkedAt: now },
  };
  return {
    ok: false,
    toolName: EXTRACT_DOCUMENT_TOOL_NAME,
    mutationState: "not_applied",
    error: {
      code: "companion_session_required",
      message,
    },
    receipt,
  };
}

const EXTRACT_DOCUMENT_DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: EXTRACT_DOCUMENT_TOOL_NAME,
  capability: { system: "web", resourceType: "document", action: "read" },
  effect: "read",
  risk: "low",
  approval: {
    allowPromptGrant: true,
    allowPersistentGrant: true,
    fallback: "none",
  },
  execution: {
    preparation: "none",
    cacheable: true,
    parallelSafe: true,
  },
  durability: {
    journal: false,
    receipt: true,
    readback: "none",
    reconciliation: "none",
  },
  allowedPrincipals: ["single_agent", "lead", "researcher"],
};

export function createDocumentExtractTools(): AgentTool[] {
  return [extractDocumentTool];
}

const extractDocumentTool: AgentTool = {
  name: EXTRACT_DOCUMENT_TOOL_NAME,
  description:
    "Extract page-marked text from a public PDF URL or a vault-relative .pdf path through the companion document_extract route. Writes the extract into the Agent Sources cache so verify_citation can check quotes. Requires an authenticated companion session; returns a receipt if the session is absent.",
  descriptor: EXTRACT_DOCUMENT_DESCRIPTOR,
  parameters: {
    type: "object",
    required: [],
    properties: {
      url: {
        type: "string",
        description: "Public HTTP(S) URL of the PDF or document to extract.",
      },
      path: {
        type: "string",
        description:
          "Optional vault-relative .pdf path, validated with normalizeVaultPath.",
      },
      title: {
        type: "string",
        description: "Optional document title for the extract request.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const result = await extractDocumentTool.executeResult!(args, context);
    if (!result.ok) {
      throw new ToolExecutionError(
        result.error?.code ?? "invalid_state",
        result.error?.message ?? "extract_document failed.",
        { mutationState: result.mutationState },
      );
    }
    return result.output;
  },
  async executeResult(args, context) {
    const urlArg = getOptionalString(args, "url")?.trim();
    const pathArg = getOptionalString(args, "path")?.trim();
    if (!urlArg && !pathArg) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "extract_document requires url or a vault-relative .pdf path.",
      );
    }
    const companion = resolveDocumentExtractCompanion(context);
    const locator = urlArg || pathArg || "";
    if ("error" in companion) {
      return companionAbsentReceipt(context, locator, companion.error);
    }
    const title =
      typeof args.title === "string" ? args.title.trim() : undefined;
    const source = await resolveExtractDocumentSource(context, {
      url: urlArg,
      path: pathArg,
    });
    const provider = createDocumentExtractProvider(context, {
      fetchDocument: async () => source.document,
    });
    const retrieved = await provider.retrieve(
      {
        id: EXTRACT_DOCUMENT_TOOL_NAME,
        url: source.cacheUrl,
        title: title || source.title,
        strategy: "document_extract",
      },
      context.abortSignal,
    );
    const now = new Date().toISOString();
    const output = retrieved ?? {
      title: title || source.title,
      url: source.cacheUrl,
      content: "",
      parserStatus: "empty" as const,
    };
    return {
      ok: true,
      toolName: EXTRACT_DOCUMENT_TOOL_NAME,
      output: {
        ...output,
        ...(source.vaultPath ? { path: source.vaultPath } : {}),
      },
      mutationState: "not_applied",
      receipt: {
        version: 1,
        id: "extract-document-ok",
        runId: context.runId?.trim() || "extract-document",
        actionId: context.operationId?.trim() || "extract-document",
        toolName: EXTRACT_DOCUMENT_TOOL_NAME,
        operation: "read",
        resource: {
          system: source.vaultPath ? "vault" : "web",
          resourceType: "document",
          id: source.cacheUrl,
          ...(source.vaultPath ? { path: source.vaultPath } : {}),
          ...(urlArg ? { url: urlArg } : {}),
        },
        message: "extract_document completed through the companion session.",
        payloadFingerprint: "extract_document",
        grantId: "none",
        startedAt: now,
        committedAt: now,
        commitKind: "committed",
        readback: { status: "not_required", checkedAt: now },
      },
    };
  },
};
