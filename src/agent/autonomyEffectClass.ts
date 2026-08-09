/**
 * Soft / Bound / Hard effect classes for autonomy gating.
 *
 * // INTEGRATOR: In AgentRunner.constrainToolsToMissionGraphFrontier / schemasForStep
 * // call sites, filter offered tools with filterToolNamesByMaxEffectClass(
 * // plan.maxEffectClassWithoutGrant). Pass pendingEffectClass into
 * // decideAutoContinuation from proof-debt next tools.
 */

import { descriptorFor } from "../tools/toolDescriptors";
import { GITHUB_CATALOG_READ_TOOL_NAMES } from "../tools/githubCatalogTools";
import type { ProofDebt } from "./proofDebt";

export type AutonomyEffectClass = "soft" | "bound" | "hard";
export type AutonomyProfile = "automatic" | "conservative" | "custom";

const SOFT_FORCE = new Set([
  // Asking the user a question mutates nothing and must never be gated behind
  // an approval — that would make the agent ask permission to ask.
  "ask_user",
  "web_search",
  "web_fetch",
  "read_current_file",
  "read_file",
  "read_source_section",
  "list_markdown_files",
  "list_folder",
  "search_markdown_files",
  "count_words",
  "append_to_current_file",
  "get_note_graph_context",
  "find_related_notes",
  "suggest_note_links",
  "read_template",
  "list_templates",
  "browser_observe",
  "browser_extract",
  "research_memory_search",
  "research_memory_get",
  "open_web_source",
  "read_source_cache",
  "analyze_dataset",
  "resolve_citation",
  "verify_citation",
  "export_bibtex",
]);

/**
 * Read-only GitHub catalog operations are safe observation tools. Keep this
 * list explicit so a future mutation cannot become Soft merely because its
 * name happens to use a read-looking prefix.
 */
const GITHUB_CATALOG_READ_FORCE = new Set<string>(
  GITHUB_CATALOG_READ_TOOL_NAMES,
);

const HARD_FORCE_PATTERNS = [
  /trash/i,
  /delete/i,
  /merge/i,
  /cleanup/i,
  /destroy/i,
];

const HARD_FORCE_EXACT = new Set([
  "github_merge_pull_request",
  "github_rerun_failed_workflow_jobs",
  "github_delete_private_repository",
  "linear_trash_issue",
  "linear_trash_project",
  "linear_trash_initiative",
]);

/** Whole-note replace is Bound (approval/grant), not Hard/destructive. */
const BOUND_FORCE = new Set([
  "replace_current_file",
  "publish_research_to_linear",
  "publish_research_project_to_linear",
  // Bound, not Soft: it comments on and re-states a real ticket. Bound is also
  // what makes set-loose auto-approve it while interactive runs still prompt.
  "report_progress_to_linear",
  "github_publish_verified_branch",
  "github_create_repository",
  // Persisted V1 plans may still address the legacy alias. It has the same
  // explicit visibility gate as the canonical tool.
  "github_create_private_repository",
  "code_commit_verified",
]);

const EFFECT_RANK: Record<AutonomyEffectClass, number> = {
  soft: 0,
  bound: 1,
  hard: 2,
};

export function effectClassForTool(toolName: string): AutonomyEffectClass {
  const name = toolName.trim();
  if (!name) return "bound";
  if (SOFT_FORCE.has(name)) return "soft";
  if (GITHUB_CATALOG_READ_FORCE.has(name)) return "soft";
  if (HARD_FORCE_EXACT.has(name)) return "hard";
  if (HARD_FORCE_PATTERNS.some((pattern) => pattern.test(name))) return "hard";
  if (BOUND_FORCE.has(name)) return "bound";
  // Bound defaults for publish / Linear / GitHub mutation-shaped names.
  if (/^(publish_|linear_|github_|code_)/i.test(name)) return "bound";
  let risk: "low" | "medium" | "high" | "critical" | undefined;
  try {
    risk = descriptorFor(name)?.risk;
  } catch {
    risk = undefined;
  }
  if (risk === "low") return "soft";
  if (risk === "medium") return "bound";
  if (risk === "high" || risk === "critical") return "hard";
  return "bound";
}

export function effectClassForTools(
  names: readonly string[],
): AutonomyEffectClass {
  let max: AutonomyEffectClass = "soft";
  for (const name of names) {
    const next = effectClassForTool(name);
    if (EFFECT_RANK[next] > EFFECT_RANK[max]) {
      max = next;
    }
  }
  return max;
}

export function mayAutoExecute(input: {
  effectClass: AutonomyEffectClass;
  autonomyProfile: AutonomyProfile;
  hasMatchingGrant: boolean;
  /**
   * When true (set-loose compound Bound tools), Bound may auto without a Chat
   * grant under automatic. Hard still never auto-executes; conservative ignores.
   */
  setLooseBoundWithoutGrant?: boolean;
}): boolean {
  if (input.effectClass === "soft") {
    return (
      input.autonomyProfile === "automatic" ||
      input.autonomyProfile === "custom"
    );
  }
  if (input.effectClass === "hard") {
    return false;
  }
  // bound
  if (input.autonomyProfile === "conservative") {
    return false;
  }
  if (input.setLooseBoundWithoutGrant === true) {
    return true;
  }
  return input.hasMatchingGrant;
}

export function mayAutoContinue(input: {
  pendingToolNames: readonly string[];
  autonomyProfile: AutonomyProfile;
  hasMatchingGrant: boolean;
  proofDebt: ProofDebt;
  setLooseBoundWithoutGrant?: boolean;
}): boolean {
  if (input.proofDebt.blocked || input.proofDebt.resumeBlocked) {
    return false;
  }
  if (input.proofDebt.empty && !input.pendingToolNames.length) {
    return false;
  }
  const pendingClass = effectClassForTools(input.pendingToolNames);
  return mayAutoExecute({
    effectClass: pendingClass,
    autonomyProfile: input.autonomyProfile,
    hasMatchingGrant: input.hasMatchingGrant,
    setLooseBoundWithoutGrant: input.setLooseBoundWithoutGrant,
  });
}

export function filterToolNamesByMaxEffectClass(
  names: readonly string[],
  max: AutonomyEffectClass,
): string[] {
  const maxRank = EFFECT_RANK[max];
  return names.filter(
    (name) => EFFECT_RANK[effectClassForTool(name)] <= maxRank,
  );
}

export function compareEffectClass(
  left: AutonomyEffectClass,
  right: AutonomyEffectClass,
): number {
  return EFFECT_RANK[left] - EFFECT_RANK[right];
}
