import { UNVERIFIED_CLAIM_MARKER_V1 } from "./degradedDelivery";
import {
  extractVaultSearchResultPathsV1,
  isVaultSearchToolNameV1,
  normalizeVaultPathV1,
} from "./researchRetrievalGate";

/**
 * One cap for every host-planned follow-up: the in-run read-only planner and
 * the post-run chip planner both stop at this many.
 */
export const MAX_AUTO_FOLLOWUPS = 3;

export type CompletionFollowupIdV1 =
  | "cite_unverified_claims"
  | "link_related_notes"
  | "draft_linear_issue";

export interface CompletionFollowupV1 {
  id: CompletionFollowupIdV1;
  /** Chip label, sentence case, no trailing period. */
  label: string;
  /** The exact mission a click submits through the normal composer path. */
  prompt: string;
}

export interface CompletionFollowupInputV1 {
  /** The mission the user just ran; used only to avoid offering what it already did. */
  mission: string;
  receipts: readonly {
    toolName: string;
    operation: string;
    path?: string;
    toPath?: string;
  }[];
  /** The final assistant text; counted for unverified-claim markers. */
  finalOutput?: string;
  linearEnabled: boolean;
  /** Only a finished mission earns next steps; a blocked one owes a Continue instead. */
  missionComplete: boolean;
}

/**
 * Host-templated next steps offered as chips after a mission finishes. They
 * are proposals only: nothing here executes, grants authority, or carries
 * model prose — each prompt is a fixed string the user can read before
 * clicking, and a click goes through the same policy and approval path as a
 * typed mission.
 */
export function planCompletionFollowupsV1(
  input: CompletionFollowupInputV1,
): CompletionFollowupV1[] {
  if (!input.missionComplete) return [];
  const mission = input.mission.toLowerCase();
  const notePath = firstWrittenMarkdownPathV1(input.receipts);
  const noteRef = notePath ?? "the current note";
  const followups: CompletionFollowupV1[] = [];

  const unverified = countUnverifiedClaimMarkersV1(input.finalOutput ?? "");
  if (unverified > 0) {
    followups.push({
      id: "cite_unverified_claims",
      label: `Cite ${unverified} unverified ${unverified === 1 ? "claim" : "claims"}`,
      prompt:
        `Find sources for the ${unverified} ${unverified === 1 ? "claim" : "claims"} marked "${UNVERIFIED_CLAIM_MARKER_V1}" in ${noteRef}, verify each against a cited passage, and replace each marker with its citation. Do not change any other content.`,
    });
  }

  if (
    notePath &&
    !/\b(?:link|links|linking|linked|connect|related notes?|backlinks?)\b/.test(
      mission,
    )
  ) {
    followups.push({
      id: "link_related_notes",
      label: "Link this note to related notes",
      prompt:
        `Find the notes in my vault most related to ${notePath} and append wiki-links to the best ones at the end of that note. Append only; do not rewrite existing content.`,
    });
  }

  if (notePath && input.linearEnabled && !/\blinear\b/.test(mission)) {
    followups.push({
      id: "draft_linear_issue",
      label: "Draft a Linear issue from this note",
      prompt:
        `Draft a Linear issue from the note ${notePath} using the Linear issue template, and show me the exact issue for approval before publishing.`,
    });
  }

  return followups.slice(0, MAX_AUTO_FOLLOWUPS);
}

export function countUnverifiedClaimMarkersV1(text: string): number {
  if (!text) return 0;
  return text.split(UNVERIFIED_CLAIM_MARKER_V1).length - 1;
}

function firstWrittenMarkdownPathV1(
  receipts: CompletionFollowupInputV1["receipts"],
): string | null {
  for (const receipt of receipts) {
    if (!/^(?:append|create|replace|edit|retitle|move)$/.test(receipt.operation)) {
      continue;
    }
    const path = (receipt.toPath ?? receipt.path ?? "").trim();
    if (path.toLowerCase().endsWith(".md")) return path;
  }
  return null;
}

export interface AutoFollowupInput {
  mission: string;
  lastToolName: string;
  lastToolResult: unknown;
  acceptanceNeeds: string[];
  alreadyFetchedUrls: string[];
  alreadyReadPaths: string[];
  maxFollowups: number;
  /**
   * The query the last vault search ran. Used verbatim for corroboration
   * because the model already distilled the mission into it, and a
   * re-derived query would search for something the user never asked.
   */
  lastToolQuery?: string;
  /**
   * True when the last semantic retrieval did not score by meaning, so its
   * ranking must not be the only thing an answer rests on. The caller owns
   * firing this at most once per mission.
   */
  requiresKeywordCorroboration?: boolean;
}

export interface AutoFollowupRequest {
  toolName:
    | "web_fetch"
    | "read_file"
    | "read_source_section"
    | "search_markdown_files";
  args: Record<string, unknown>;
  reason: string;
}

export function planReadOnlyFollowups(input: AutoFollowupInput): AutoFollowupRequest[] {
  const maxFollowups = Math.max(
    0,
    Math.min(MAX_AUTO_FOLLOWUPS, Math.trunc(input.maxFollowups)),
  );
  if (maxFollowups === 0) {
    return [];
  }
  if (input.lastToolName === "web_fetch") {
    const sectionFollowup = planNextSourceSection(input);
    return sectionFollowup ? [sectionFollowup] : [];
  }
  if (input.lastToolName === "web_search" && needsSourceFetch(input)) {
    return extractSearchUrls(input.lastToolResult, input.mission)
      .filter((url) => isSafeHttpUrl(url) && !input.alreadyFetchedUrls.includes(url))
      .slice(0, maxFollowups)
      .map((url) => ({
        toolName: "web_fetch",
        args: { url },
        reason: "auto_fetch_search_result_for_source_proof",
      }));
  }
  /*
   * Reading a vault search's own results is unconditional, not a courtesy.
   *
   * This used to require either acceptance already naming vault evidence or the
   * mission literally saying "my notes" / "vault" / "related notes", so an
   * ordinary "what did I conclude about onboarding?" surfaced paths and then
   * answered from snippets -- and `search_markdown_files` was never covered at
   * all. The search having run is itself the signal: if the agent went to the
   * vault, the host opens what it found. These reads are read-only, deduplicated
   * against what was already read, and bounded by `maxFollowups`.
   */
  if (isVaultSearchToolNameV1(input.lastToolName)) {
    const alreadyRead = new Set(
      input.alreadyReadPaths.map((path) => normalizeVaultPathV1(path)),
    );
    const followups: AutoFollowupRequest[] = [];
    const corroborationQuery = input.requiresKeywordCorroboration
      ? (input.lastToolQuery ?? "").trim()
      : "";
    // Corroboration is scheduled before the reads because it can outrank them.
    // A degraded `semantic_search_notes` scores chunks from at most the first
    // MAX_LISTED_FILES notes and never matches the exact phrase;
    // `search_markdown_files` reads every note in the vault and does. When
    // embeddings are down that difference is the whole retrieval, not a
    // second opinion on it.
    if (corroborationQuery && input.lastToolName !== "search_markdown_files") {
      followups.push({
        toolName: "search_markdown_files",
        args: { query: corroborationQuery },
        reason: "auto_keyword_corroboration_for_degraded_semantic_search",
      });
    }
    for (const path of extractVaultSearchResultPathsV1(input.lastToolResult)) {
      if (followups.length >= maxFollowups) break;
      // Compared through the same normalizer the proof gate uses, so a path
      // that differs only by separator or case is not re-read.
      if (alreadyRead.has(normalizeVaultPathV1(path))) continue;
      followups.push({
        toolName: "read_file",
        args: { path, maxChars: 6000 },
        reason: "auto_read_vault_search_result_for_body_proof",
      });
    }
    return followups;
  }
  return [];
}

function planNextSourceSection(input: AutoFollowupInput): AutoFollowupRequest | null {
  const stillNeedsSourceCoverage = input.acceptanceNeeds.some((need) =>
    /web_evidence|fetched_sources|distinct_domains|source|citation|passage/i.test(
      need,
    ),
  );
  if (!stillNeedsSourceCoverage) {
    return null;
  }
  const output = getOutput(input.lastToolResult);
  if (!isRecord(output)) {
    return null;
  }
  const path = typeof output.cachedPath === "string" ? output.cachedPath : "";
  const section = typeof output.section === "number" ? output.section : 1;
  const sectionCount = typeof output.sectionCount === "number" ? output.sectionCount : 1;
  // Cap section thrash: at most one auto section advance per fetch.
  if (!path || section >= sectionCount || section >= 2) {
    return null;
  }
  return {
    toolName: "read_source_section",
    args: { path, section: section + 1 },
    reason: "auto_read_next_cached_source_section",
  };
}

function needsSourceFetch(input: AutoFollowupInput): boolean {
  return (
    input.acceptanceNeeds.some((need) =>
      /web_evidence|fetched_sources|distinct_domains|source|citation/i.test(need),
    ) || /\b(cite|citation|source|sources|verify|current|latest|web)\b/i.test(input.mission)
  );
}

function extractSearchUrls(value: unknown, mission: string): string[] {
  const output = getOutput(value);
  if (!isRecord(output) || !Array.isArray(output.results)) {
    return [];
  }
  const missionTerms = getRankingTerms(mission);
  return output.results
    .map((item, index) => {
      if (!isRecord(item) || typeof item.url !== "string") {
        return null;
      }
      const title = typeof item.title === "string" ? item.title : "";
      const snippet =
        typeof item.snippet === "string"
          ? item.snippet
          : typeof item.content === "string"
            ? item.content
            : "";
      const titleTerms = new Set(getRankingTerms(title));
      const snippetTerms = new Set(getRankingTerms(snippet));
      const urlTerms = new Set(getRankingTerms(item.url));
      const score = missionTerms.reduce(
        (total, term) =>
          total +
          (titleTerms.has(term) ? 4 : 0) +
          (snippetTerms.has(term) ? 2 : 0) +
          (urlTerms.has(term) ? 1 : 0),
        0,
      );
      return { url: item.url, index, score };
    })
    .filter(
      (candidate): candidate is { url: string; index: number; score: number } =>
        candidate !== null,
    )
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((candidate) => candidate.url);
}

const RANKING_STOP_WORDS = new Set([
  "about",
  "after",
  "answer",
  "cite",
  "citation",
  "current",
  "exact",
  "from",
  "into",
  "latest",
  "mission",
  "phrase",
  "source",
  "sources",
  "text",
  "that",
  "this",
  "verify",
  "web",
  "with",
]);

function getRankingTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.filter((term) => term.length >= 3 && !RANKING_STOP_WORDS.has(term)) ?? [],
    ),
  ];
}

function getOutput(value: unknown): unknown {
  return isRecord(value) && "output" in value ? value.output : value;
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
