export interface AutoFollowupInput {
  mission: string;
  lastToolName: string;
  lastToolResult: unknown;
  acceptanceNeeds: string[];
  alreadyFetchedUrls: string[];
  alreadyReadPaths: string[];
  maxFollowups: number;
}

export interface AutoFollowupRequest {
  toolName: "web_fetch" | "read_file" | "read_source_section";
  args: Record<string, unknown>;
  reason: string;
}

export function planReadOnlyFollowups(input: AutoFollowupInput): AutoFollowupRequest[] {
  const maxFollowups = Math.max(0, Math.min(3, Math.trunc(input.maxFollowups)));
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
  if (input.lastToolName === "semantic_search_notes" && needsVaultRead(input)) {
    return extractResultPaths(input.lastToolResult)
      .filter((path) => !input.alreadyReadPaths.includes(path))
      .slice(0, maxFollowups)
      .map((path) => ({
        toolName: "read_file",
        args: { path, maxChars: 6000 },
        reason: "auto_read_semantic_result_for_vault_proof",
      }));
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

function needsVaultRead(input: AutoFollowupInput): boolean {
  return (
    input.acceptanceNeeds.some((need) => /vault_evidence|research_plan_items/i.test(need)) ||
    /\b(my notes|vault|across notes|semantic|related notes)\b/i.test(input.mission)
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

function extractResultPaths(value: unknown): string[] {
  const output = getOutput(value);
  if (!isRecord(output) || !Array.isArray(output.results)) {
    return [];
  }
  return output.results
    .map((item) => (isRecord(item) && typeof item.path === "string" ? item.path : ""))
    .filter((path) => path.endsWith(".md"));
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
