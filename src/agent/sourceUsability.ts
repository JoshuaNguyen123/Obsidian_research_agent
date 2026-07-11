import { extractEvidencePassages } from "./researchDossier";

export type SourceParserStatus =
  | "parsed"
  | "empty"
  | "missing_content"
  | "legacy_unknown";

export interface SourceUsabilityResult {
  usable: boolean;
  reason:
    | "usable"
    | "parser_failed"
    | "empty_content"
    | "no_evidence_passages";
  passageIds: string[];
}

/**
 * A fetched source is proof only when it contains model-visible, persistable
 * passages. Search results and a URL alone are navigation, not evidence.
 */
export function evaluateSourceUsability(input: {
  content: string;
  sourceLocator: string;
  query?: string;
  parserStatus?: string;
  baseOffset?: number;
}): SourceUsabilityResult {
  const parserStatus = normalizeSourceParserStatus(input.parserStatus);
  if (parserStatus === "empty" || parserStatus === "missing_content") {
    return { usable: false, reason: "parser_failed", passageIds: [] };
  }

  const content = input.content;
  if (!content.trim()) {
    return { usable: false, reason: "empty_content", passageIds: [] };
  }

  const passages = extractEvidencePassages(content, {
    query: input.query,
    sourceLocator: input.sourceLocator,
    baseOffset: input.baseOffset,
  }).passages.filter((passage) => passage.text.trim().length > 0);
  if (passages.length === 0) {
    return { usable: false, reason: "no_evidence_passages", passageIds: [] };
  }

  return {
    usable: true,
    reason: "usable",
    passageIds: passages.map((passage) => passage.id),
  };
}

export function selectNextUsableSourceCandidate<T extends {
  url?: string;
  attempted?: boolean;
  blocked?: boolean;
  parserStatus?: string;
}>(candidates: T[]): T | undefined {
  return candidates.find(
    (candidate) =>
      Boolean(candidate.url?.trim()) &&
      candidate.attempted !== true &&
      candidate.blocked !== true &&
      candidate.parserStatus !== "empty" &&
      candidate.parserStatus !== "missing_content",
  );
}

export function normalizeSourceParserStatus(
  value: string | undefined,
): SourceParserStatus {
  return value === "parsed" ||
    value === "empty" ||
    value === "missing_content" ||
    value === "legacy_unknown"
    ? value
    : "legacy_unknown";
}
