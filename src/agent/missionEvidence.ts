import type { ClaimPassageRef } from "./claimLedger";
import type { MissionEvidence } from "./missionLedger";
import type { ToolExecutionResult } from "../tools/types";
import {
  createEvidenceSourceId,
  extractEvidencePassages,
  type EvidencePassage,
} from "./researchDossier";
import {
  evaluateSourceUsability,
  normalizeSourceParserStatus,
} from "./sourceUsability";

const MAX_CLAIM_PASSAGES_PER_TOOL = 6;

export interface MissionReceiptLike {
  id?: string;
  version?: 1;
  toolName?: string;
  operation: string;
  message?: string;
  path?: string;
  toPath?: string;
  backupPath?: string;
  bytesWritten?: number;
  bytesDeleted?: number;
  affectedCount?: number;
  payloadFingerprint?: string;
  resource?: {
    system: string;
    resourceType?: string;
    id: string;
    path?: string;
    url?: string;
  };
}

export function evidenceFromToolResult(
  toolName: string,
  result: ToolExecutionResult,
): MissionEvidence | null {
  if (!result.ok) {
    return null;
  }

  if (
    (toolName === "web_fetch" || toolName === "read_source_section") &&
    isRecord(result.output)
  ) {
    const url =
      getString(result.output.url) ??
      getString(result.output.normalizedUrl) ??
      "";
    const title = getString(result.output.title) ?? (url || "Web source");
    const sourceLocator =
      getString(result.output.normalizedUrl) ||
      url ||
      getString(result.output.path) ||
      title;
    const content = getString(result.output.content) ?? "";
    const sourceUsability = evaluateSourceUsability({
      content,
      query: getString(result.output.query),
      sourceLocator,
      parserStatus: getString(result.output.parserStatus),
      baseOffset: getNumber(result.output.sourceStartChar),
    });
    if (!sourceUsability.usable) {
      return null;
    }
    const passageIds = sourceUsability.passageIds;
    return {
      id: `web:${hashEvidenceKey(sourceLocator)}`,
      kind: "web_source",
      title,
      ...(url ? { url } : {}),
      sourceId: createEvidenceSourceId(sourceLocator),
      ...(passageIds[0] ? { passageId: passageIds[0] } : {}),
      ...(passageIds.length > 0 ? { passageIds } : {}),
      summary: summarizeText(content),
      confidence: "high",
      usableSource: true,
      parserStatus: normalizeSourceParserStatus(
        getString(result.output.parserStatus),
      ),
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

  if (toolName === "browser_extract_markdown" && isRecord(result.output)) {
    const url = getString(result.output.url) ?? "";
    const title = getString(result.output.title) ?? (url || "Browser source");
    const content = getString(result.output.markdown) ?? "";
    const sourceUsability = evaluateSourceUsability({
      content,
      sourceLocator: url || title,
      parserStatus: content.trim() ? "parsed" : "empty",
    });
    if (!url || !sourceUsability.usable) {
      return null;
    }
    return {
      id: `web:${hashEvidenceKey(url)}`,
      kind: "web_source",
      title,
      url,
      sourceId: createEvidenceSourceId(url),
      passageId: sourceUsability.passageIds[0],
      passageIds: sourceUsability.passageIds,
      summary: summarizeText(content),
      confidence: "high",
      usableSource: true,
      parserStatus: "parsed",
    };
  }

  if (toolName === "read_file" && isRecord(result.output)) {
    const path = getString(result.output.path) ?? "";
    const content = getString(result.output.content) ?? "";
    const contentEvidence = extractEvidencePassages(content, {
      query: getString(result.output.query),
      sourceLocator: path || "vault_note",
    });
    const passageIds = contentEvidence.passages.map((passage) => passage.id);
    return {
      id: `vault:${hashEvidenceKey(path)}`,
      kind: "vault_note",
      title: path || "Vault note",
      ...(path ? { path } : {}),
      sourceId: createEvidenceSourceId(path || "vault_note"),
      ...(passageIds[0] ? { passageId: passageIds[0] } : {}),
      ...(passageIds.length > 0 ? { passageIds } : {}),
      summary: summarizeText(content),
      confidence: "high",
    };
  }

  if (toolName === "read_markdown_files" && isRecord(result.output)) {
    const files = Array.isArray(result.output.files) ? result.output.files : [];
    const output = result.output;
    const paths = files
      .filter(isRecord)
      .map((file) => getString(file.path))
      .filter((path): path is string => Boolean(path));
    if (paths.length === 0) {
      return null;
    }
    const passageIds: string[] = [];
    const summary = files
      .filter(isRecord)
      .map((file) => {
        const path = getString(file.path) ?? "note";
        const content = getString(file.content) ?? "";
        const contentEvidence = extractEvidencePassages(content, {
          query: getString(output.query),
          sourceLocator: path,
          maxPassages: 2,
          maxPassageChars: 320,
          maxTotalChars: 600,
        });
        for (const passage of contentEvidence.passages) {
          if (passage.id && !passageIds.includes(passage.id)) {
            passageIds.push(passage.id);
          }
        }
        return `${path}: ${summarizeText(content, 220)}`;
      })
      .join("\n");
    return {
      id: `vault_batch:${hashEvidenceKey(paths.join("|"))}`,
      kind: "vault_note",
      title: `${paths.length} vault notes read`,
      path: paths[0],
      sourceId: createEvidenceSourceId(paths[0] ?? "vault_batch"),
      ...(passageIds[0] ? { passageId: passageIds[0] } : {}),
      ...(passageIds.length > 0 ? { passageIds } : {}),
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

/**
 * Prefer dossier passage texts from tool output for claim grounding.
 * Re-extracts from content when contentEvidence is absent.
 */
export function claimPassagesFromToolResult(
  toolName: string,
  result: ToolExecutionResult,
): ClaimPassageRef[] {
  if (!result.ok || !isRecord(result.output)) {
    return [];
  }

  const output = result.output;
  const evidenceId = evidenceIdForClaimPassages(toolName, output);
  const fromBundle = passagesFromContentEvidence(
    output.contentEvidence,
    evidenceId,
  );
  if (fromBundle.length > 0) {
    return fromBundle.slice(0, MAX_CLAIM_PASSAGES_PER_TOOL);
  }

  if (
    toolName === "web_fetch" ||
    toolName === "read_source_section" ||
    toolName === "read_file" ||
    toolName === "browser_extract_markdown"
  ) {
    const content =
      getString(output.content) ?? getString(output.markdown) ?? "";
    if (!content.trim()) {
      return [];
    }
    const sourceLocator =
      getString(output.normalizedUrl) ||
      getString(output.url) ||
      getString(output.path) ||
      getString(output.title) ||
      toolName;
    if (
      (toolName === "web_fetch" ||
        toolName === "read_source_section" ||
        toolName === "browser_extract_markdown") &&
      !evaluateSourceUsability({
        content,
        query: getString(output.query),
        sourceLocator,
        parserStatus: getString(output.parserStatus),
        baseOffset: getNumber(output.sourceStartChar),
      }).usable
    ) {
      return [];
    }
    const bundle = extractEvidencePassages(content, {
      query: getString(output.query),
      sourceLocator,
      baseOffset: getNumber(output.sourceStartChar),
    });
    return claimPassageRefsFromEvidencePassages(
      bundle.passages,
      evidenceId,
    ).slice(0, MAX_CLAIM_PASSAGES_PER_TOOL);
  }

  if (toolName === "read_markdown_files" && Array.isArray(output.files)) {
    const passages: ClaimPassageRef[] = [];
    for (const file of output.files) {
      if (!isRecord(file) || typeof file.content !== "string") {
        continue;
      }
      const path = getString(file.path) ?? "note";
      const fileEvidenceId = `vault:${hashEvidenceKey(path)}`;
      const fromFile = passagesFromContentEvidence(
        file.contentEvidence,
        fileEvidenceId,
      );
      if (fromFile.length > 0) {
        passages.push(...fromFile);
      } else {
        const bundle = extractEvidencePassages(file.content, {
          query: getString(output.query),
          sourceLocator: path,
          maxPassages: 2,
          maxPassageChars: 320,
          maxTotalChars: 600,
        });
        passages.push(
          ...claimPassageRefsFromEvidencePassages(
            bundle.passages,
            fileEvidenceId,
          ),
        );
      }
      if (passages.length >= MAX_CLAIM_PASSAGES_PER_TOOL) {
        break;
      }
    }
    return passages.slice(0, MAX_CLAIM_PASSAGES_PER_TOOL);
  }

  return [];
}

export function upsertClaimPassageRefs(
  records: ClaimPassageRef[],
  passages: ClaimPassageRef[],
): void {
  for (const passage of passages) {
    if (!passage.id || passage.text === undefined) {
      continue;
    }
    const next: ClaimPassageRef = {
      id: passage.id,
      text: passage.text,
      ...(passage.evidenceId ? { evidenceId: passage.evidenceId } : {}),
      ...(passage.subquestionId
        ? { subquestionId: passage.subquestionId }
        : {}),
    };
    const index = records.findIndex((item) => item.id === next.id);
    if (index >= 0) {
      records[index] = next;
    } else {
      records.push(next);
    }
  }
}

function evidenceIdForClaimPassages(
  toolName: string,
  output: Record<string, unknown>,
): string | undefined {
  if (
    toolName === "web_fetch" ||
    toolName === "read_source_section" ||
    toolName === "browser_extract_markdown"
  ) {
    const sourceLocator =
      getString(output.normalizedUrl) ||
      getString(output.url) ||
      getString(output.path) ||
      getString(output.title);
    return sourceLocator
      ? `web:${hashEvidenceKey(sourceLocator)}`
      : undefined;
  }
  if (toolName === "read_file") {
    const path = getString(output.path);
    return path ? `vault:${hashEvidenceKey(path)}` : undefined;
  }
  return undefined;
}

function passagesFromContentEvidence(
  value: unknown,
  evidenceId?: string,
): ClaimPassageRef[] {
  if (!isRecord(value) || !Array.isArray(value.passages)) {
    return [];
  }
  const passages: EvidencePassage[] = [];
  for (const item of value.passages) {
    if (!isRecord(item)) {
      continue;
    }
    const id = getString(item.id);
    const text = getString(item.text);
    if (!id || text === undefined) {
      continue;
    }
    passages.push({
      id,
      text,
      startChar: getNumber(item.startChar) ?? 0,
      endChar: getNumber(item.endChar) ?? text.length,
      selection:
        item.selection === "query_match" || item.selection === "coverage"
          ? item.selection
          : "coverage",
    });
  }
  return claimPassageRefsFromEvidencePassages(passages, evidenceId);
}

function claimPassageRefsFromEvidencePassages(
  passages: EvidencePassage[],
  evidenceId?: string,
): ClaimPassageRef[] {
  return passages
    .filter((passage) => passage.id && passage.text !== undefined)
    .map((passage) => ({
      id: passage.id,
      text: passage.text,
      ...(evidenceId ? { evidenceId } : {}),
    }));
}

export function evidenceFromReceipt(receipt: MissionReceiptLike): MissionEvidence {
  const system = receipt.resource?.system ?? (receipt.path ? "vault" : "unknown");
  const domain =
    system === "linear" || system === "github"
      ? "external"
      : system === "vault"
        ? "vault"
        : "artifact";
  const receiptPath =
    system === "vault"
      ? receipt.path ?? receipt.resource?.path
      : undefined;
  const key = [
    system,
    receipt.operation,
    receipt.resource?.id ?? "",
    receiptPath ?? "",
    receipt.toPath ?? "",
    receipt.backupPath ?? "",
    receipt.payloadFingerprint ?? "",
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
    id: `receipt:${domain}:${hashEvidenceKey(key)}`,
    kind: "receipt",
    title: `${system} ${receipt.operation} ${receiptPath ?? receipt.resource?.id ?? ""}`.trim(),
    ...(receiptPath ? { path: receiptPath } : {}),
    ...(system !== "vault" && receipt.resource?.url
      ? { url: receipt.resource.url }
      : {}),
    summary:
      summaryParts.join("; ") || `${system} action receipt emitted.`,
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
