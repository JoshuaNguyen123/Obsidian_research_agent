/**
 * Route-scoped tool schema shrink: only expose frontier ∪ route base tools
 * so cloud/local tool-calling models see fewer unavailable tools.
 *
 * Wire-up: `AgentRunner.constrainToolsToMissionGraphFrontier` passes
 * `runPlan.route` into `schemasForStep` on every tool step. `RunRoute` values
 * (e.g. `direct_writeback`) are mapped through `mapRunRouteToSchemaRoute`
 * onto schema-policy buckets (`current_note`, `research`, …). Without a
 * MissionGraph, note/research/vault-mapped routes still shrink (drop Linear/
 * GitHub noise); code/default keep the fuller catalog until frontier filters.
 *
 * Model capability context (thinking + tools catalogs used for operator docs):
 * - https://docs.ollama.com/capabilities/thinking
 * - https://docs.ollama.com/capabilities/tool-calling
 * - https://ollama.com/blog/streaming-tool
 * - https://ollama.com/search?c=thinking&c=tools
 */

export type ToolSchemaLike = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

/** Schema policy route keys (not raw RunRoute strings). */
export type SchemaPolicyRoute =
  | "current_note"
  | "research"
  | "vault"
  | "code"
  | "default";

/** Always-safe reads available on most note/research routes. */
export const ROUTE_BASE_TOOLS: Readonly<
  Record<SchemaPolicyRoute, readonly string[]>
> = {
  current_note: [
    "read_current_file",
    "count_words",
    "append_to_current_file",
    "replace_current_file",
  ],
  research: [
    "create_project_idea_brief",
    "read_current_file",
    "list_markdown_files",
    "read_file",
    "web_search",
    "web_fetch",
    "read_source_section",
    "count_words",
    "append_to_current_file",
    "replace_current_file",
    "list_templates",
    "read_template",
    "fill_template",
    "create_template",
    "seed_default_templates",
    "create_research_pack",
  ],
  vault: [
    "read_current_file",
    "list_markdown_files",
    "read_file",
    "search_markdown_files",
    "get_note_graph_context",
    "find_related_notes",
    "suggest_note_links",
    "list_templates",
    "read_template",
    "fill_template",
    "create_template",
    "seed_default_templates",
    "create_research_pack",
  ],
  code: [
    "code_sandbox_status",
    "code_workspace_create",
    "code_workspace_status",
    "code_workspace_stat",
    "code_workspace_list",
    "code_workspace_read",
    "code_workspace_search",
    "code_workspace_mkdir",
    "code_workspace_create_file",
    "code_workspace_export_directory",
    "code_workspace_append",
    "code_workspace_patch",
    "code_workspace_write_expected",
    "code_workspace_move",
    "code_workspace_copy",
    "code_workspace_trash",
    "code_workspace_restore",
    "code_validate_fast",
    "code_validate_targeted",
    "code_validate_full",
    "code_repair_record_cycle",
    "code_repair_status",
    "code_workspace_init_repository",
    "code_commit_verified",
  ],
  default: ["read_current_file", "list_markdown_files", "read_file"],
};

/**
 * Host lifecycle composites that must survive research-route shrink once
 * intent-allowed into allSchemas. Template/research-pack tools stay on the
 * research/vault route bases instead of this preserve set so note routes do
 * not re-expand them.
 */
const LIFECYCLE_WORKFLOW_TOOLS = new Set([
  "create_project_idea_brief",
  "append_jupyter_reflection",
  "write_project_results",
  "publish_research_to_linear",
  "publish_research_project_to_linear",
  // End-of-mission progress report. It must survive the note/research route
  // shrink, because reflection runs on exactly those routes.
  "report_progress_to_linear",
]);

/**
 * Map runner RunRoute values onto schema-policy buckets so
 * `schemasForStep` can shrink catalogs for cloud tool-calling models.
 *
 * Keep this mapper in sync with AgentRunner route names; tests cover the
 * common writeback / research / vault / answer routes.
 */
export function mapRunRouteToSchemaRoute(runRoute: string): SchemaPolicyRoute {
  switch (runRoute) {
    case "direct_writeback":
    case "single_model_writeback":
    case "instant_local":
      return "current_note";
    case "tool_required":
    case "grounded_workflow":
      return "research";
    case "prefetched_vault_answer":
    case "prefetched_vault_writeback":
      return "vault";
    case "single_model_answer":
      return "default";
    default:
      if (
        runRoute === "current_note" ||
        runRoute === "research" ||
        runRoute === "vault" ||
        runRoute === "code"
      ) {
        return runRoute;
      }
      return "default";
  }
}

export function schemasForStep(input: {
  route: string;
  frontier: readonly string[];
  graphRequired: readonly string[];
  allSchemas: readonly ToolSchemaLike[];
}): ToolSchemaLike[] {
  const schemaRoute = mapRunRouteToSchemaRoute(input.route);
  const base = ROUTE_BASE_TOOLS[schemaRoute] ?? ROUTE_BASE_TOOLS.default;
  const allow = new Set<string>([
    ...base,
    ...input.frontier,
    ...input.graphRequired,
  ]);
  // When the ready frontier is already code-shaped, keep the code base so the
  // model can take the next sandbox/workspace step without a route remap.
  if (
    [...input.frontier, ...input.graphRequired].some((name) =>
      name.startsWith("code_"),
    )
  ) {
    for (const name of ROUTE_BASE_TOOLS.code) {
      allow.add(name);
    }
  }
  return input.allSchemas.filter((schema) => {
    const name = schema.function.name;
    if (allow.has(name)) {
      return true;
    }
    // Drop Linear/GitHub catalog noise on note/research/vault routes unless the
    // frontier/graph already required that exact tool.
    if (/^(linear_|github_)/u.test(name)) {
      return false;
    }
    // Preserve intent-gated code and lifecycle composites that were already
    // admitted into allSchemas — shrink must not strand compound missions.
    if (name.startsWith("code_") || LIFECYCLE_WORKFLOW_TOOLS.has(name)) {
      return true;
    }
    return false;
  });
}

/**
 * Phase-scoped offered-menu ceilings (cheap-model WS3).
 *
 * Wide menus measurably degrade weak tool-calling models (observed live:
 * 20 wasted steps against an 18-tool menu while the right tool sat ready).
 * Gather/analyze keep a broader read menu; write/publish turns get a tight
 * action menu. `verify` and `publish` share the write ceiling.
 */
export type ToolMenuPhaseV1 = "gather" | "analyze" | "write" | "verify";

export const PHASE_TOOL_MENU_CEILINGS_V1: Readonly<
  Record<ToolMenuPhaseV1, number>
> = {
  gather: 10,
  analyze: 10,
  write: 6,
  verify: 6,
};

/** Accepts runner phase strings; unknown phases apply no ceiling (fail-open). */
export function normalizeToolMenuPhaseV1(
  phase: string | null | undefined,
): ToolMenuPhaseV1 | null {
  const key = String(phase ?? "").trim();
  if (key === "gather" || key === "analyze" || key === "write" || key === "verify") {
    return key;
  }
  // The plan speaks of "write/publish"; treat a publish-shaped phase as write.
  if (key === "publish") {
    return "write";
  }
  return null;
}

/**
 * Enforce the per-phase offered-tool-menu ceiling on an already-assembled
 * step menu. This is the ONE shared predicate for both the schema list and
 * the stage-prompt prose projection: cap the finalized `stepTools` before
 * either consumer reads it, and the two cannot disagree.
 *
 * Priority when the menu exceeds the ceiling (kept first, original order
 * preserved in the output):
 *   0. graph-required tools (ready/running MissionGraph node tools) — these
 *      are NEVER dropped, even when they alone exceed the ceiling;
 *   1. the plan's preferred next tool;
 *   2. route-base tools for the run's route bucket;
 *   3. everything else (dropped first).
 *
 * Menus at or under the ceiling — and turns with no recognizable phase —
 * pass through unchanged.
 */
export function enforcePhaseToolMenuCeilingV1<T extends ToolSchemaLike>(input: {
  phase: string | null | undefined;
  schemas: readonly T[];
  /** Ready/running MissionGraph node tool names. Never dropped. */
  graphRequired?: readonly string[];
  /** The plan's preferred next tool name, if the host computed one. */
  preferredNextTool?: string | null;
  /** Runner RunRoute; route-base tools outrank misc catalog extras. */
  route?: string | null;
  /**
   * Phase ceilings only apply to research-bearing runs — the WS3 evidence
   * base. Non-research runs derive phase "write" immediately, so a blanket
   * write ceiling would let route-base reads crowd out the very mutation or
   * inspection tools the mission exists for (observed: a CRUD mission lost
   * create_file; a repository-inspection turn lost
   * code_repository_detect_profile). Pass `false` to disable capping; omit
   * for pure/unit usage where the caller already knows the run qualifies.
   */
  researchBearing?: boolean;
  /**
   * Phase ceilings also require a governing MissionGraph. In graphless
   * intent-gated runs the assembled menu IS the intent gate's answer — every
   * name was individually admitted for this prompt — and re-ranking it by
   * route-base priority evicts deliberately admitted tools (observed:
   * get_note_graph_context dropped from an explicit "inspect the note graph"
   * mission). With a graph, protected names are precise and the extras are
   * catalog noise, so capping is safe. Pass `false` to disable capping; omit
   * for pure/unit usage.
   */
  graphGoverned?: boolean;
}): T[] {
  const phase = normalizeToolMenuPhaseV1(input.phase);
  if (
    !phase ||
    input.researchBearing === false ||
    input.graphGoverned === false
  ) {
    return [...input.schemas];
  }
  const ceiling = PHASE_TOOL_MENU_CEILINGS_V1[phase];
  if (input.schemas.length <= ceiling) {
    return [...input.schemas];
  }
  const graphRequired = new Set(
    (input.graphRequired ?? []).map((name) => name.trim()).filter(Boolean),
  );
  const preferredNextTool = input.preferredNextTool?.trim() || null;
  const routeBase = new Set<string>(
    input.route
      ? ROUTE_BASE_TOOLS[mapRunRouteToSchemaRoute(input.route)] ??
          ROUTE_BASE_TOOLS.default
      : [],
  );
  const priorityFor = (name: string): number => {
    if (graphRequired.has(name)) return 0;
    if (preferredNextTool !== null && name === preferredNextTool) return 1;
    if (routeBase.has(name)) return 2;
    return 3;
  };
  const ranked = input.schemas.map((schema, index) => ({
    schema,
    index,
    priority: priorityFor(schema.function.name),
  }));
  const keptIndexes = new Set<number>();
  // Graph-required tools are kept unconditionally, ceiling or not: dropping a
  // tool the current graph node requires would advertise an unfinishable step.
  for (const entry of ranked) {
    if (entry.priority === 0) {
      keptIndexes.add(entry.index);
    }
  }
  const byPriority = [...ranked].sort(
    (a, b) => a.priority - b.priority || a.index - b.index,
  );
  for (const entry of byPriority) {
    if (keptIndexes.size >= ceiling) break;
    keptIndexes.add(entry.index);
  }
  return ranked
    .filter((entry) => keptIndexes.has(entry.index))
    .map((entry) => entry.schema);
}

/**
 * Durable-stage schema shrink: keep only schemas whose names are in the
 * stage/callable allowlist. Used when a lifecycle stage already owns the
 * offered frontier so cloud catalogs do not re-expand unrelated tools.
 */
export function schemasForLifecycleStage(input: {
  callableToolNames: readonly string[];
  allSchemas: readonly ToolSchemaLike[];
}): ToolSchemaLike[] {
  const allow = new Set(
    input.callableToolNames.map((name) => name.trim()).filter(Boolean),
  );
  if (allow.size === 0) return [];
  return input.allSchemas.filter((schema) => allow.has(schema.function.name));
}
