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
  ],
  vault: [
    "read_current_file",
    "list_markdown_files",
    "read_file",
    "search_markdown_files",
    "get_note_graph_context",
    "find_related_notes",
    "suggest_note_links",
  ],
  code: [
    "code_workspace_list",
    "code_workspace_read",
    "code_workspace_search",
  ],
  default: ["read_current_file", "list_markdown_files", "read_file"],
};

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
  return input.allSchemas.filter((schema) => allow.has(schema.function.name));
}
