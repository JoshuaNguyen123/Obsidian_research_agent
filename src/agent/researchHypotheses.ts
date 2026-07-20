import type { MissionEvidence } from "./missionLedger";
import type { ResearchMemoryIndexEntry } from "../tools/types";

export const MAX_WORKING_HYPOTHESES = 5;
export const MAX_HYPOTHESIS_CHARS = 200;

export interface ResearchHypothesis {
  text: string;
  topic?: string;
  sourcePath?: string;
}

/**
 * Bounded search-hit shape from `search_research_memory` (or index-only
 * ranking). Content is treated as unverified prior memory, never as proof.
 */
export interface ResearchMemorySearchHit {
  recordId?: string;
  sourceCategories?: Array<"note" | "public_url" | "receipt">;
  topic?: string;
  path?: string;
  content?: string;
  keywords?: string[];
  found?: boolean;
  sourceUrls?: string[];
  sourcePaths?: string[];
}

export interface BuildWorkingHypothesesOptions {
  maxCount?: number;
  maxChars?: number;
}

/**
 * Build capped working hypotheses from research-memory search results.
 * Hypotheses are prompt hints only; they must be re-fetched/re-read before citing.
 */
export function buildWorkingHypotheses(
  hits: ResearchMemorySearchHit[],
  options: BuildWorkingHypothesesOptions = {},
): ResearchHypothesis[] {
  const maxCount = Math.max(1, options.maxCount ?? MAX_WORKING_HYPOTHESES);
  const maxChars = Math.max(40, options.maxChars ?? MAX_HYPOTHESIS_CHARS);
  const hypotheses: ResearchHypothesis[] = [];

  for (const hit of hits) {
    if (hypotheses.length >= maxCount) {
      break;
    }
    if (hit.found === false) {
      continue;
    }
    const text = hypothesisTextFromHit(hit, maxChars);
    if (!text) {
      continue;
    }
    hypotheses.push({
      text,
      topic: hit.topic?.trim() || undefined,
      sourcePath: hit.path?.trim() || undefined,
    });
  }

  return hypotheses;
}

/**
 * Rank index entries against a mission query without vault I/O, then map to
 * hypothesis hits (topic/keywords only). Prefer full search hits when available.
 */
export function selectHypothesisHitsFromIndex(
  entries: ResearchMemoryIndexEntry[],
  query: string,
  limit = MAX_WORKING_HYPOTHESES,
): ResearchMemorySearchHit[] {
  return rankResearchMemoryEntries(entries, query)
    .slice(0, Math.max(1, limit))
    .map((entry) => ({
      recordId: entry.id,
      sourceCategories: [...new Set(
        (entry.sourceLabels ?? []).map((label) => label.kind),
      )],
      topic: entry.topic,
      path: entry.path,
      keywords: entry.keywords,
      sourceUrls: entry.sourceUrls,
      sourcePaths: entry.sourcePaths,
      found: true,
      content: [
        entry.topic,
        entry.keywords.length > 0 ? `Keywords: ${entry.keywords.join(", ")}` : "",
        entry.sourceUrls?.length
          ? `Prior sources (unverified): ${entry.sourceUrls.slice(0, 3).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join(". "),
    }));
}

export interface ResearchMemoryUseReceiptV1 {
  version: 1;
  domain: "research";
  recordIds: string[];
  recordCount: number;
  sourceCategories: Array<"note" | "public_url" | "receipt">;
  relevance: "keyword_match_to_current_mission";
  verification: "unverified_prior_context";
}

export function buildResearchMemoryUseReceiptV1(
  entries: ResearchMemoryIndexEntry[],
  query: string,
  limit = MAX_WORKING_HYPOTHESES,
): ResearchMemoryUseReceiptV1 | null {
  const hits = selectHypothesisHitsFromIndex(entries, query, limit);
  if (hits.length === 0) return null;
  return {
    version: 1,
    domain: "research",
    recordIds: hits
      .map((hit) => hit.recordId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort(),
    recordCount: hits.length,
    sourceCategories: [...new Set(
      hits.flatMap((hit) => hit.sourceCategories ?? []),
    )].sort(),
    relevance: "keyword_match_to_current_mission",
    verification: "unverified_prior_context",
  };
}

export function buildHypothesisSystemHint(
  hypotheses: ResearchHypothesis[],
): string | null {
  if (hypotheses.length === 0) {
    return null;
  }
  const lines = hypotheses.map((item, index) => {
    const locator = item.sourcePath ? ` [${item.sourcePath}]` : "";
    return `${index + 1}. ${item.text}${locator}`;
  });
  return [
    "Working hypotheses (unverified):",
    ...lines,
    "These are prior research-memory hints only. Re-fetch or re-read sources before citing them. They do not satisfy web_evidence or vault_evidence proof by themselves.",
  ].join("\n");
}

export function buildHypothesisSystemHintFromHits(
  hits: ResearchMemorySearchHit[],
  options?: BuildWorkingHypothesesOptions,
): string | null {
  return buildHypothesisSystemHint(buildWorkingHypotheses(hits, options));
}

export function buildHypothesisSystemHintFromIndex(
  entries: ResearchMemoryIndexEntry[],
  query: string,
  options?: BuildWorkingHypothesesOptions,
): string | null {
  const hits = selectHypothesisHitsFromIndex(
    entries,
    query,
    options?.maxCount ?? MAX_WORKING_HYPOTHESES,
  );
  return buildHypothesisSystemHintFromHits(hits, options);
}

/**
 * Hypotheses never satisfy web_evidence / vault_evidence alone.
 * Callers must still require fetched/read MissionEvidence.
 */
export function hypothesesSatisfyEvidenceProof(
  _proof: "web_evidence" | "vault_evidence",
  _hypotheses: ResearchHypothesis[],
): false {
  return false;
}

/**
 * Memory-only evidence (research-memory paths / hypothesis text) does not
 * count as web or vault proof. Real web_source URLs and vault note reads do.
 */
export function evidenceSatisfiesProofWithoutHypotheses(
  proof: "web_evidence" | "vault_evidence",
  evidence: MissionEvidence[],
  hypotheses: ResearchHypothesis[] = [],
): boolean {
  if (hypothesesSatisfyEvidenceProof(proof, hypotheses)) {
    return true;
  }
  if (proof === "web_evidence") {
    return evidence.some(
      (item) =>
        !isResearchMemoryEvidence(item) &&
        (item.kind === "web_source" || Boolean(item.url)),
    );
  }
  return evidence.some(
    (item) =>
      !isResearchMemoryEvidence(item) &&
      (item.kind === "vault_note" ||
        (item.kind === "tool_result" && Boolean(item.path))),
  );
}

export function isResearchMemoryEvidence(item: MissionEvidence): boolean {
  const path = (item.path ?? "").replace(/\\/g, "/").toLowerCase();
  if (
    path.includes("agent research memory") ||
    path.includes("/research/") ||
    /research-memory/i.test(path)
  ) {
    return true;
  }
  return /research\s*memory|memory_search|search_research_memory|read_research_memory/i.test(
    item.title,
  );
}

function hypothesisTextFromHit(
  hit: ResearchMemorySearchHit,
  maxChars: number,
): string {
  const raw =
    hit.content?.replace(/\s+/g, " ").trim() ||
    hit.topic?.replace(/\s+/g, " ").trim() ||
    "";
  if (!raw) {
    return "";
  }
  if (raw.length <= maxChars) {
    return raw;
  }
  const cut = raw.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > maxChars * 0.6 ? lastSpace : maxChars)}...`;
}

function rankResearchMemoryEntries(
  entries: ResearchMemoryIndexEntry[],
  query: string,
): ResearchMemoryIndexEntry[] {
  const queryTokens = new Set(extractKeywords(query));
  if (queryTokens.size === 0) {
    return [...entries];
  }
  return entries
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, queryTokens),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) =>
      right.score === left.score
        ? right.entry.lastUpdated.localeCompare(left.entry.lastUpdated)
        : right.score - left.score,
    )
    .map((item) => item.entry);
}

function scoreEntry(
  entry: ResearchMemoryIndexEntry,
  queryTokens: Set<string>,
): number {
  const haystack = new Set([
    ...extractKeywords(entry.topic),
    ...entry.keywords.flatMap(extractKeywords),
  ]);
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) {
      score += 1;
    }
  }
  return score;
}

function extractKeywords(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter(
        (token) =>
          !new Set([
            "the",
            "and",
            "for",
            "this",
            "that",
            "with",
            "memory",
            "research",
            "topic",
            "continue",
          ]).has(token),
      ),
    ),
  ];
}
