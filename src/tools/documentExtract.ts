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
import { requestWithRetry } from "./httpRetry";
import {
  ToolExecutionError,
  type AgentTool,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "./types";
import { getRequiredString, isRecord } from "./validation";

export const EXTRACT_DOCUMENT_TOOL_NAME = "extract_document";

/** Pages read out of one document before the rest is reported as truncated. */
export const DEFAULT_DOCUMENT_EXTRACT_PAGES = 100;

/** Characters returned for one document; the cache note sections the rest. */
export const DEFAULT_DOCUMENT_EXTRACT_CHARS = 60_000;

/**
 * The largest document the companion route can be handed in one request.
 *
 * The binding constraint is the companion boundary's `max_body_bytes` (1 MiB by
 * default), and base64 inflates the payload by a third. Refusing early with a
 * named reason beats a bare 413 from the middleware.
 */
export const MAX_DOCUMENT_BYTES = 720_000;

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
      const url = normalizeDocumentUrl(candidate.url);
      const document = await fetchDocument(url, abortSignal);
      assertDocumentOperationActive(context, abortSignal);

      const extracted = await requestDocumentExtract(context, {
        url,
        title: candidate.title,
        document,
        signal: abortSignal,
      });
      const content = extracted.status === "parsed" ? extracted.text : "";
      return {
        title: candidate.title?.trim() || documentNameFromUrl(url),
        url,
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
    url: string;
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

/**
 * The same public-HTTP(S) shape `web_fetch` requires of a source URL. It is
 * restated here rather than imported because `webTools.ts` keeps its
 * normalizer module-private.
 */
function normalizeDocumentUrl(rawUrl: string): string {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "document_extract URL cannot be empty.",
    );
  }
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
  } catch {
    throw new ToolExecutionError(
      "invalid_arguments",
      "document_extract URL is invalid.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolExecutionError(
      "invalid_arguments",
      "document_extract only supports HTTP and HTTPS URLs.",
    );
  }
  if (url.username || url.password) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "document_extract URLs with credentials are not allowed.",
    );
  }
  if (isUnsafeDocumentHost(url.hostname)) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "document_extract cannot fetch local or private network URLs.",
    );
  }
  url.hash = "";
  return url.toString();
}

function isUnsafeDocumentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  if (
    normalized.includes(":") &&
    (/^(fc|fd)/u.test(normalized) || normalized.startsWith("fe80:"))
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
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
    "Extract page-marked text from a public PDF or document URL through the companion document_extract route. Requires an authenticated companion session; returns a receipt if the session is absent.",
  descriptor: EXTRACT_DOCUMENT_DESCRIPTOR,
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        description: "Public HTTP(S) URL of the PDF or document to extract.",
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
    const url = getRequiredString(args, "url").trim();
    const companion = resolveDocumentExtractCompanion(context);
    if ("error" in companion) {
      return companionAbsentReceipt(context, url, companion.error);
    }
    const title =
      typeof args.title === "string" ? args.title.trim() : undefined;
    const provider = createDocumentExtractProvider(context);
    const retrieved = await provider.retrieve(
      {
        id: EXTRACT_DOCUMENT_TOOL_NAME,
        url,
        title,
        strategy: "document_extract",
      },
      context.abortSignal,
    );
    const now = new Date().toISOString();
    const output = retrieved ?? {
      title: title || url,
      url,
      content: "",
      parserStatus: "empty" as const,
    };
    return {
      ok: true,
      toolName: EXTRACT_DOCUMENT_TOOL_NAME,
      output,
      mutationState: "not_applied",
      receipt: {
        version: 1,
        id: "extract-document-ok",
        runId: context.runId?.trim() || "extract-document",
        actionId: context.operationId?.trim() || "extract-document",
        toolName: EXTRACT_DOCUMENT_TOOL_NAME,
        operation: "read",
        resource: {
          system: "web",
          resourceType: "document",
          id: url,
          url,
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
