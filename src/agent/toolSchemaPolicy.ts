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
    "code_validate_fast",
    "code_validate_targeted",
    "code_validate_full",
    "code_repair_record_cycle",
    "code_repair_status",
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
  "publish_research_to_linear",
  "publish_research_project_to_linear",
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
