import type { ToolExecutionResult } from "../tools/types";
import { truncateText } from "../tools/validation";
import { extractEvidencePassages } from "../agent/researchDossier";

const MAX_SUMMARY_CHARS = 8000;
const MAX_SNIPPET_CHARS = 600;
const MAX_RESULT_ITEMS = 8;
const MAX_REF_COUNT = 20;

export interface ToolPayloadSummary {
  toolName: string;
  status: "success" | "error";
  summary: string;
  evidenceRefs?: string[];
  receiptRefs?: string[];
  coverage?: Record<string, unknown>;
  truncated?: boolean;
  output?: unknown;
}

export function serializeToolResultForModel(result: ToolExecutionResult): string {
  const summary = summarizeToolOutput(result.toolName, result);
  const serialized = JSON.stringify(summary, null, 2);
  if (serialized.length <= MAX_SUMMARY_CHARS) {
    return serialized;
  }

  const compact = compactOversizedSummary(summary);
  const compactSerialized = JSON.stringify(compact, null, 2);
  if (compactSerialized.length <= MAX_SUMMARY_CHARS) {
    return compactSerialized;
  }

  // Preserve valid JSON even when an unusual tool result still exceeds the
  // model payload budget. Invalid, character-truncated JSON is harder for the
  // model to recover from than an explicit metadata-only summary.
  return JSON.stringify({
    toolName: summary.toolName,
    status: summary.status,
    summary: summary.summary,
    evidenceRefs: summary.evidenceRefs?.slice(0, 8),
    receiptRefs: summary.receiptRefs?.slice(0, 8),
    coverage: summary.coverage,
    truncated: true,
  }, null, 2);
}

export function summarizeToolOutput(
  toolName: string,
  value: unknown,
): ToolPayloadSummary {
  const result = isToolResult(value)
    ? value
    : { ok: true, toolName, output: value } satisfies ToolExecutionResult;
  const output = result.output;
  const summary: ToolPayloadSummary = {
    toolName,
    status: result.ok ? "success" : "error",
    summary: result.ok
      ? summarizeOutput(toolName, output)
      : result.error?.message ?? "Tool returned an error.",
  };

  const refs = collectRefs(output);
  if (refs.evidenceRefs.length > 0) {
    summary.evidenceRefs = refs.evidenceRefs;
  }
  if (refs.receiptRefs.length > 0) {
    summary.receiptRefs = refs.receiptRefs;
  }
  const coverage = isRecord(output) && isRecord(output.coverage)
    ? output.coverage
    : undefined;
  if (coverage) {
    summary.coverage = coverage;
  }
  const slimOutput = slimOutputForModel(toolName, output);
  if (slimOutput !== undefined) {
    summary.output = slimOutput;
  }
  summary.truncated = JSON.stringify(value ?? "").length > JSON.stringify(summary).length;
  return summary;
}

function summarizeOutput(toolName: string, output: unknown): string {
  if (!isRecord(output)) {
    return `${toolName} completed.`;
  }
  if (typeof output.operation === "string") {
    const path = typeof output.path === "string" ? ` ${output.path}` : "";
    return `${output.operation}${path}`.trim();
  }
  if (Array.isArray(output.results)) {
    return `${toolName} returned ${output.results.length} result(s).`;
  }
  if (Array.isArray(output.files)) {
    return `${toolName} returned ${output.files.length} file(s).`;
  }
  if (typeof output.path === "string") {
    return `${toolName} returned ${output.path}.`;
  }
  if (typeof output.wordCount === "number") {
    return `${toolName} counted ${output.wordCount} words.`;
  }
  return `${toolName} completed.`;
}

function slimOutputForModel(toolName: string, output: unknown): unknown {
  if (Array.isArray(output)) {
    return output.slice(0, 40).map((item) => summarizeResultItem(item));
  }
  if (!isRecord(output)) {
    return output;
  }
  const keep: Record<string, unknown> = {};
  for (const key of [
    "operation",
    "path",
    "toPath",
    "backupPath",
    "restoredFromBackupPath",
    "bytesWritten",
    "bytesDeleted",
    "affectedCount",
    "wordCount",
    "title",
    "url",
    "normalizedUrl",
    "urlHash",
    "query",
    "fromCache",
    "cachedPath",
    "fetchedAt",
    "totalChars",
    "sourceChars",
    "contentHash",
    "sha256",
    "beforeSha256",
    "afterSha256",
    "relatedPath",
    "trashId",
    "manifestSha256",
    "parserStatus",
    "truncated",
    "section",
    "sectionCount",
    "sourceStartChar",
    "requestedCount",
    "returnedCount",
    "limit",
    "maxCharsPerFile",
    "cacheMaxAgeMs",
    "resultCount",
    "candidateLimit",
    "nextCursor",
    "fallbackUsed",
    "fallbackReason",
    "indexUsed",
    "indexFresh",
  ]) {
    if (output[key] !== undefined) {
      keep[key] = output[key];
    }
  }
  if (Array.isArray(output.results)) {
    keep.results = output.results
      .slice(0, MAX_RESULT_ITEMS)
      .map((item) => summarizeResultItem(item));
  }
  if (Array.isArray(output.files)) {
    const query = getEvidenceQuery(output);
    keep.files = output.files
      .slice(0, MAX_RESULT_ITEMS)
      .map((item) => summarizeFileItem(item, query));
  }
  if (isRecord(output.receipt)) {
    const receipt = slimReceiptForModel(output.receipt);
    if (Object.keys(receipt).length > 0) {
      keep.receipt = receipt;
    }
  }
  if (typeof output.content === "string" && toolName !== "count_words") {
    keep.contentEvidence = extractEvidencePassages(output.content, {
      query: getEvidenceQuery(output),
      sourceLocator: getEvidenceSourceLocator(output),
      baseOffset: getEvidenceBaseOffset(output),
    });
  }
  return Object.keys(keep).length > 0 ? keep : undefined;
}

function slimReceiptForModel(receipt: Record<string, unknown>): Record<string, unknown> {
  const keep: Record<string, unknown> = {};
  for (const key of [
    "id",
    "workspaceId",
    "operation",
    "path",
    "relatedPath",
    "beforeSha256",
    "afterSha256",
    "bytesWritten",
    "bytesDeleted",
    "affectedCount",
    "trashId",
    "committedAt",
    "manifestSha256",
    "fingerprint",
  ]) {
    if (receipt[key] !== undefined) {
      keep[key] = receipt[key];
    }
  }
  return keep;
}

function summarizeResultItem(item: unknown): unknown {
  if (!isRecord(item)) {
    return item;
  }
  const output: Record<string, unknown> = {};
  for (const key of ["title", "path", "url", "score", "heading", "reasons"]) {
    if (item[key] !== undefined) {
      output[key] = item[key];
    }
  }
  if (typeof item.snippet === "string") {
    output.snippet = truncateText(item.snippet, MAX_SNIPPET_CHARS);
  } else if (typeof item.content === "string") {
    output.snippet = truncateText(item.content, MAX_SNIPPET_CHARS);
  }
  return output;
}

function summarizeFileItem(item: unknown, query?: string): unknown {
  if (!isRecord(item)) {
    return item;
  }
  const output: Record<string, unknown> = {};
  for (const key of ["path", "basename", "title", "truncated", "error"]) {
    if (item[key] !== undefined) {
      output[key] = item[key];
    }
  }
  if (typeof item.content === "string") {
    output.contentEvidence = extractEvidencePassages(item.content, {
      query,
      sourceLocator: getEvidenceSourceLocator(item),
      baseOffset: getEvidenceBaseOffset(item),
      maxPassages: 2,
      maxPassageChars: 320,
      maxTotalChars: 600,
    });
  }
  return output;
}

function getEvidenceQuery(output: Record<string, unknown>): string | undefined {
  for (const key of ["query", "prompt", "term", "topic"]) {
    const value = output[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function getEvidenceSourceLocator(
  output: Record<string, unknown>,
): string | undefined {
  for (const key of ["normalizedUrl", "url", "path", "cachedPath", "title"]) {
    const value = output[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function getEvidenceBaseOffset(output: Record<string, unknown>): number {
  const value = output.sourceStartChar;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function compactOversizedSummary(summary: ToolPayloadSummary): ToolPayloadSummary {
  const compact: ToolPayloadSummary = {
    ...summary,
    truncated: true,
    evidenceRefs: summary.evidenceRefs?.slice(0, 10),
    receiptRefs: summary.receiptRefs?.slice(0, 10),
  };
  if (!isRecord(summary.output)) {
    return compact;
  }

  const output = { ...summary.output };
  if (Array.isArray(output.results)) {
    output.results = output.results.slice(0, 4);
  }
  if (Array.isArray(output.files)) {
    output.files = output.files.slice(0, 4);
  }
  if (isRecord(output.contentEvidence) && Array.isArray(output.contentEvidence.passages)) {
    output.contentEvidence = {
      ...output.contentEvidence,
      passages: output.contentEvidence.passages.slice(0, 2).map((passage) => {
        if (!isRecord(passage) || typeof passage.text !== "string") {
          return passage;
        }
        return {
          ...passage,
          text: truncateText(passage.text, 800),
        };
      }),
    };
  }
  compact.output = output;
  return compact;
}

function collectRefs(output: unknown): {
  evidenceRefs: string[];
  receiptRefs: string[];
} {
  const evidenceRefs = new Set<string>();
  const receiptRefs = new Set<string>();
  const visit = (value: unknown) => {
    if (!isRecord(value)) {
      return;
    }
    const path = typeof value.path === "string" ? value.path : undefined;
    const url = typeof value.url === "string" ? value.url : undefined;
    const operation = typeof value.operation === "string" ? value.operation : undefined;
    if (url) {
      evidenceRefs.add(url);
    }
    if (path) {
      evidenceRefs.add(path);
    }
    if (operation && path) {
      receiptRefs.add(`${operation}:${path}`);
    }
    for (const nested of Object.values(value)) {
      if (Array.isArray(nested)) {
        nested.slice(0, 20).forEach(visit);
      } else if (isRecord(nested)) {
        visit(nested);
      }
    }
  };
  visit(output);
  return {
    evidenceRefs: [...evidenceRefs].slice(0, MAX_REF_COUNT),
    receiptRefs: [...receiptRefs].slice(0, MAX_REF_COUNT),
  };
}

function isToolResult(value: unknown): value is ToolExecutionResult {
  return isRecord(value) && typeof value.toolName === "string" && typeof value.ok === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
