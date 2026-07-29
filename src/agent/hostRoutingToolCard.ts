/**
 * Per-turn host routing + offered-tool purposes so the model calls exact frontier names.
 */

export const HOST_ROUTING_TOOL_CARD_MAX_CHARS = 2200;
export const HOST_ROUTING_OFFERED_TOOL_MAX = 12;
export const HOST_ROUTING_PURPOSE_MAX_CHARS = 150;

export type HostRoutingToolCardV1 = {
  route: string;
  stages: readonly string[];
  currentStage: string | null;
  setLoose: boolean;
  unpaidDelivery: readonly string[];
  preferredNextTool: string | null;
  /** Offered tools this turn, max ~12 lines, purpose ≤80 chars each. */
  offeredToolLines: readonly string[];
};

/** Fixed short purposes for compound ladder names; fallback = truncated descriptor. */
export const COMPOUND_TOOL_PURPOSE: Readonly<Record<string, string>> = {
  code_sandbox_status: "verify sandbox Ready before validate/commit",
  code_workspace_create:
    "create a real local-filesystem workspace; export its finished tree to Desktop/Documents/Downloads with code_workspace_export_directory",
  code_workspace_status: "workspace binding and status",
  code_workspace_read: "read workspace/repo file (not vault)",
  code_workspace_create_file:
    "create a file in the real local-filesystem workspace; export via code_workspace_export_directory to Desktop/Documents/Downloads",
  code_workspace_export_directory:
    "deliver a verified workspace tree to an explicitly requested known folder",
  code_workspace_append: "append to workspace file",
  code_workspace_patch: "patch workspace file",
  code_workspace_write_expected:
    "hash-bound correction in the real local-filesystem workspace; export via code_workspace_export_directory to Desktop/Documents/Downloads",
  code_workspace_mkdir: "create workspace directory",
  code_validate_fast: "sandbox smoke tests",
  code_validate_targeted: "targeted sandbox validation",
  code_validate_full: "full sandbox validation",
  code_repair_record_cycle:
    "record fast-validation proof; open repair only when red",
  code_repair_status: "repair cycle status",
  code_commit_verified: "host git add + verified commit + handoff SHA",
  linear_create_issue: "create Linear issue with provider readback",
  linear_get_issue: "read verified Linear issue",
  publish_research_to_linear: "publish accepted research to Linear",
  publish_research_project_to_linear: "publish Linear hierarchy from research",
  github_create_private_repository: "create private GitHub repository",
  publish_verified_code_to_github: "push verified branch + draft PR (or merge)",
  github_publish_verified_branch: "alias publish verified branch/draft PR",
  github_get_pull_request: "readback pull request",
  append_to_current_file: "append to open Obsidian note",
  read_current_file: "read open Obsidian note",
  read_file: "read vault markdown path",
  web_search: "external web search",
  web_fetch: "fetch a URL",
};

export function pickPreferredNextTool(input: {
  unpaidDeliveryTools: readonly string[];
  readyFrontierToolNames: readonly string[];
}): string | null {
  const ready = new Set(
    input.readyFrontierToolNames.map((name) => name.trim()).filter(Boolean),
  );
  for (const tool of input.unpaidDeliveryTools) {
    const name = tool.trim();
    if (name && ready.has(name)) return name;
  }
  const firstReady = input.readyFrontierToolNames.find((name) => name.trim());
  return firstReady?.trim() || null;
}

export function purposeForOfferedTool(
  toolName: string,
  descriptorDescription?: string | null,
): string {
  const known = COMPOUND_TOOL_PURPOSE[toolName];
  if (known) return truncatePurpose(known);
  const fallback = String(descriptorDescription ?? "").replace(/\s+/g, " ").trim();
  return truncatePurpose(fallback || "listed frontier tool");
}

function truncatePurpose(text: string): string {
  if (text.length <= HOST_ROUTING_PURPOSE_MAX_CHARS) return text;
  return `${text.slice(0, HOST_ROUTING_PURPOSE_MAX_CHARS - 1).trimEnd()}…`;
}

export function buildOfferedToolLines(input: {
  readyFrontierToolNames: readonly string[];
  descriptorDescriptions?: Readonly<Record<string, string>>;
}): string[] {
  const lines: string[] = [];
  for (const name of input.readyFrontierToolNames) {
    const tool = name.trim();
    if (!tool) continue;
    lines.push(
      `- ${tool} — ${purposeForOfferedTool(tool, input.descriptorDescriptions?.[tool])}`,
    );
    if (lines.length >= HOST_ROUTING_OFFERED_TOOL_MAX) break;
  }
  return lines;
}

export function formatHostRoutingToolCard(card: HostRoutingToolCardV1): string {
  const stages =
    card.stages.length > 0 ? card.stages.join(",") : "none";
  const unpaid =
    card.unpaidDelivery.length > 0 ? card.unpaidDelivery.join(",") : "none";
  const offered =
    card.offeredToolLines.length > 0
      ? card.offeredToolLines.join("\n")
      : "- (none)";
  const text = [
    "HOST ROUTING CARD (authoritative; call only listed tools):",
    `route=${card.route || "unknown"} stages=${stages} currentStage=${card.currentStage ?? "none"} setLoose=${card.setLoose ? "true" : "false"}`,
    `unpaid=${unpaid} preferredNext=${card.preferredNextTool ?? "none"}`,
    "offered:",
    offered,
    "Do not invent git_*, verify_all, patch, or Linear tools unless listed.",
  ].join("\n");

  if (text.length <= HOST_ROUTING_TOOL_CARD_MAX_CHARS) return text;
  return `${text.slice(0, HOST_ROUTING_TOOL_CARD_MAX_CHARS - 1).trimEnd()}…`;
}
