import type { MissionEvidence } from "./missionLedger";
import type { ToolExecutionResult } from "../tools/types";

export interface MissionReceiptLike {
  toolName?: string;
  operation: string;
  message?: string;
  path?: string;
  toPath?: string;
  backupPath?: string;
  bytesWritten?: number;
  bytesDeleted?: number;
  affectedCount?: number;
}

export function evidenceFromToolResult(
  toolName: string,
  result: ToolExecutionResult,
): MissionEvidence | null {
  if (!result.ok) {
    return null;
  }

  if (toolName === "web_fetch" && isRecord(result.output)) {
    const url = getString(result.output.url) ?? "";
    const title = getString(result.output.title) ?? (url || "Web source");
    return {
      id: `web:${hashEvidenceKey(url || title)}`,
      kind: "web_source",
      title,
      ...(url ? { url } : {}),
      summary: summarizeText(getString(result.output.content) ?? ""),
      confidence: "high",
    };
  }

  if (toolName === "web_search" && isRecord(result.output)) {
    const query = getString(result.output.query) ?? "web search";
    const results = Array.isArray(result.output.results)
      ? result.output.results
      : [];
    const summary =
      results.length > 0
        ? summarizeText(JSON.stringify(results.slice(0, 5)))
        : summarizeText(JSON.stringify(result.output));
    return {
      id: `web_search:${hashEvidenceKey(`${query}:${summary}`)}`,
      kind: "web_source",
      title: `Web search: ${query}`,
      summary,
      confidence: "medium",
    };
  }

  if (toolName === "read_file" && isRecord(result.output)) {
    const path = getString(result.output.path) ?? "";
    return {
      id: `vault:${hashEvidenceKey(path)}`,
      kind: "vault_note",
      title: path || "Vault note",
      ...(path ? { path } : {}),
      summary: summarizeText(getString(result.output.content) ?? ""),
      confidence: "high",
    };
  }

  if (toolName === "read_markdown_files" && isRecord(result.output)) {
    const files = Array.isArray(result.output.files) ? result.output.files : [];
    const paths = files
      .filter(isRecord)
      .map((file) => getString(file.path))
      .filter((path): path is string => Boolean(path));
    if (paths.length === 0) {
      return null;
    }
    const summary = files
      .filter(isRecord)
      .map((file) => {
        const path = getString(file.path) ?? "note";
        const content = summarizeText(getString(file.content) ?? "", 220);
        return `${path}: ${content}`;
      })
      .join("\n");
    return {
      id: `vault_batch:${hashEvidenceKey(paths.join("|"))}`,
      kind: "vault_note",
      title: `${paths.length} vault notes read`,
      path: paths[0],
      summary: summarizeText(summary),
      confidence: "high",
    };
  }

  if (
    (toolName === "semantic_search_notes" ||
      toolName === "search_markdown_files" ||
      toolName === "inspect_vault_context" ||
      toolName === "list_markdown_files") &&
    isRecord(result.output)
  ) {
    return vaultSearchEvidenceFromToolResult(toolName, result.output);
  }

  if (
    toolName === "get_note_graph_context" ||
    toolName === "find_related_notes" ||
    toolName === "suggest_note_links"
  ) {
    return graphEvidenceFromToolResult(toolName, result.output);
  }

  if (
    toolName === "create_design_canvas" ||
    toolName === "create_svg_design" ||
    toolName === "create_design_package" ||
    toolName === "open_web_source"
  ) {
    return artifactEvidenceFromToolResult(toolName, result.output);
  }

  return null;
}

export function evidenceFromReceipt(receipt: MissionReceiptLike): MissionEvidence {
  const key = [
    receipt.operation,
    receipt.path ?? "",
    receipt.toPath ?? "",
    receipt.backupPath ?? "",
  ].join(":");
  const summaryParts = [
    receipt.message,
    receipt.backupPath ? `backup=${receipt.backupPath}` : null,
    receipt.bytesWritten !== undefined
      ? `bytesWritten=${receipt.bytesWritten}`
      : null,
    receipt.bytesDeleted !== undefined
      ? `bytesDeleted=${receipt.bytesDeleted}`
      : null,
    receipt.affectedCount !== undefined
      ? `affected=${receipt.affectedCount}`
      : null,
  ].filter((part): part is string => Boolean(part));

  return {
    id: `receipt:${hashEvidenceKey(key)}`,
    kind: "receipt",
    title: `${receipt.operation} ${receipt.path ?? ""}`.trim(),
    ...(receipt.path ? { path: receipt.path } : {}),
    summary: summaryParts.join("; ") || "Vault write receipt emitted.",
    confidence: "high",
  };
}

export function hashEvidenceKey(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36) || "0";
}

function vaultSearchEvidenceFromToolResult(
  toolName: string,
  output: Record<string, unknown>,
): MissionEvidence | null {
  const candidateArrays = [
    output.results,
    output.matches,
    output.files,
    output.notes,
  ];
  const rows = candidateArrays.find(Array.isArray) ?? [];
  const paths = rows
    .filter(isRecord)
    .map((row) => getString(row.path) ?? getString(row.filePath))
    .filter((path): path is string => Boolean(path));
  const query =
    getString(output.query) ??
    getString(output.prompt) ??
    getString(output.term) ??
    toolName;

  if (paths.length === 0 && rows.length === 0) {
    return null;
  }

  const summary = rows
    .filter(isRecord)
    .slice(0, 8)
    .map((row, index) => {
      const path = getString(row.path) ?? getString(row.filePath) ?? `result ${index + 1}`;
      const heading = getString(row.heading) ?? getString(row.title);
      const snippet =
        getString(row.snippet) ??
        getString(row.summary) ??
        getString(row.content) ??
        "";
      return summarizeText(
        [path, heading, snippet].filter(Boolean).join(": "),
        220,
      );
    })
    .join("\n");
  const coverageSummary = summarizeCoverage(output.coverage);

  return {
    id: `vault_search:${hashEvidenceKey(`${toolName}:${query}:${paths.join("|")}`)}`,
    kind: "vault_note",
    title:
      paths.length > 0
        ? `${paths.length} vault search result${paths.length === 1 ? "" : "s"}`
        : `${rows.length} vault search result${rows.length === 1 ? "" : "s"}`,
    ...(paths[0] ? { path: paths[0] } : {}),
    summary: [coverageSummary, summary || summarizeText(JSON.stringify(output))]
      .filter(Boolean)
      .join("\n"),
    confidence:
      getCoverageConfidence(output.coverage) ??
      (toolName === "semantic_search_notes" ? "medium" : "high"),
  };
}

function graphEvidenceFromToolResult(
  toolName: string,
  output: unknown,
): MissionEvidence | null {
  if (!isRecord(output)) {
    return null;
  }

  const source = isRecord(output.source) ? output.source : null;
  const sourcePath = getString(source?.path);
  const results = Array.isArray(output.results) ? output.results : [];
  const title =
    toolName === "find_related_notes"
      ? `Related notes${sourcePath ? ` for ${sourcePath}` : ""}`
      : `Graph context${sourcePath ? ` for ${sourcePath}` : ""}`;
  const summary =
    results.length > 0
      ? summarizeText(JSON.stringify(results.slice(0, 8)))
      : summarizeText(JSON.stringify(output));

  return {
    id: `graph:${hashEvidenceKey(`${toolName}:${sourcePath ?? summary}`)}`,
    kind: "tool_result",
    title,
    ...(sourcePath ? { path: sourcePath } : {}),
    summary,
    confidence: "medium",
  };
}

function artifactEvidenceFromToolResult(
  toolName: string,
  output: unknown,
): MissionEvidence | null {
  if (!isRecord(output)) {
    return null;
  }

  const path = getString(output.path) ?? getString(output.briefPath) ?? getString(output.canvasPath);
  const url = getString(output.url);
  const title = path ?? url ?? toolName;
  const summary = [
    `${toolName} completed.`,
    getNumber(output.nodeCount) !== undefined ? `nodes=${output.nodeCount}` : null,
    getNumber(output.edgeCount) !== undefined ? `edges=${output.edgeCount}` : null,
    getNumber(output.shapeCount) !== undefined ? `shapes=${output.shapeCount}` : null,
    getNumber(output.itemCount) !== undefined ? `items=${output.itemCount}` : null,
    getNumber(output.bytesWritten) !== undefined
      ? `bytesWritten=${output.bytesWritten}`
      : null,
  ].filter((part): part is string => Boolean(part)).join(" ");

  return {
    id: `artifact:${hashEvidenceKey(`${toolName}:${title}`)}`,
    kind: "artifact",
    title,
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    summary,
    confidence: "high",
  };
}

function summarizeText(text: string, maxChars = 800): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No content summary available.";
  }
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars)}...`;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeCoverage(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }

  return `Coverage: mode=${String(value.mode ?? "unknown")}; confidence=${String(
    value.confidence ?? "unknown",
  )}; considered=${String(value.considered ?? "unknown")}; read=${String(
    value.read ?? "unknown",
  )}; skipped=${String(value.skipped ?? "unknown")}; truncated=${String(
    value.truncated ?? "unknown",
  )}.`;
}

function getCoverageConfidence(
  value: unknown,
): MissionEvidence["confidence"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const confidence = value.confidence;
  return confidence === "low" || confidence === "medium" || confidence === "high"
    ? confidence
    : undefined;
}
