/**
 * Soft-only Researcher catalog helpers for the Lead + Researcher team.
 *
 * // INTEGRATOR: researchWorker / runResearchTeamMission — apply
 * // filterResearcherToolNames to worker tool schemas; use
 * // buildResearcherAssignment for worker assignment text.
 * // INTEGRATOR: dedupe RESEARCHER_SOFT_TOOL_NAMES with RESEARCH_WORKER_ALLOWED_TOOLS.
 */

import { effectClassForTool } from "../agent/autonomyEffectClass";

/** Mirrors RESEARCH_WORKER_ALLOWED_TOOLS for Wave-0 ownership isolation. */
export const RESEARCHER_SOFT_TOOL_NAMES: readonly string[] = [
  "read_current_file",
  "list_current_folder",
  "list_markdown_files",
  "search_markdown_files",
  "read_markdown_files",
  "read_file",
  "inspect_vault_context",
  "list_folder",
  "get_path_info",
  "inspect_vault_index",
  "inspect_semantic_index",
  "semantic_search_notes",
  "get_note_graph_context",
  "find_related_notes",
  "suggest_note_links",
  "web_search",
  "web_fetch",
  "read_source_section",
  "browser_open_page",
  "browser_observe",
  "browser_extract_markdown",
  "search_research_memory",
  "read_research_memory",
];

const RESEARCHER_ALLOW = new Set(RESEARCHER_SOFT_TOOL_NAMES);

export function filterResearcherToolNames(
  names: readonly string[],
): string[] {
  // Researcher allowlist is already Soft/read-only. Intersect first, then drop
  // any Hard-classified names that might have leaked into a caller list.
  return names.filter((name) => {
    if (!RESEARCHER_ALLOW.has(name)) return false;
    try {
      return effectClassForTool(name) !== "hard";
    } catch {
      return true;
    }
  });
}

export function buildResearcherAssignment(input: {
  prompt: string;
  explicitSourceCount?: number | null;
  deep?: boolean;
}): string {
  const prompt = input.prompt.trim();
  const sourceCount =
    typeof input.explicitSourceCount === "number" &&
    Number.isFinite(input.explicitSourceCount) &&
    input.explicitSourceCount > 0
      ? Math.min(5, Math.floor(input.explicitSourceCount))
      : null;
  const deep = input.deep === true;
  const sourceClause = sourceCount
    ? `Gather at least ${sourceCount} usable public source(s) with fetchable passages.`
    : deep
      ? "Gather multiple usable public sources with fetchable passages before synthesizing."
      : "Gather usable public or vault evidence with fetchable passages before synthesizing.";
  const topic = prompt.length > 280 ? `${prompt.slice(0, 277)}...` : prompt;
  return [
    "You are the read-only Researcher. Do not write notes or call mutation tools.",
    sourceClause,
    "Return structured evidence and unresolved questions for the Lead.",
    `Mission: ${topic}`,
  ].join(" ");
}
