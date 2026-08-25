/**
 * Off-frontier near-miss teaching, reject categories, and eval records.
 */

export type ToolRejectCategoryV1 =
  | "unknown_tool"
  | "missing_argument"
  | "invalid_argument"
  | "extra_argument"
  | "unauthorized"
  | "invalid_state"
  | "ambiguous_target"
  | "policy_rejection"
  | "rate_limit_or_transient"
  | "other";

export type ToolRejectEvalV1 = {
  userIntentExcerpt: string;
  selectedTool: string;
  argumentsSummary?: string;
  expectedPrerequisite?: string | null;
  result: "rejected";
  errorCategory: ToolRejectCategoryV1 | string;
  retryCount: number;
  readyFrontier: string[];
};

export function mapToolRejectCategory(input: {
  toolName: string;
  message?: string | null;
  code?: string | null;
  pendingGraphNodeId?: string | null;
}): ToolRejectCategoryV1 {
  const message = String(input.message ?? "").toLowerCase();
  const code = String(input.code ?? "").toLowerCase();
  const blob = `${message} ${code}`;

  if (
    /unknown tool|not available for this prompt|off-frontier|tool_not_allowed/i.test(
      blob,
    ) ||
    input.pendingGraphNodeId
  ) {
    return "unknown_tool";
  }
  if (/missing.*argument|required.*(field|literal)|omitted/i.test(blob)) {
    return "missing_argument";
  }
  if (/invalid.*argument|wrong type|enum|schema correction|literal/i.test(blob)) {
    return "invalid_argument";
  }
  if (/extra argument|unsupported field|additional propert/i.test(blob)) {
    return "extra_argument";
  }
  if (
    /approval|unauthorized|preauthorized_authority|denied|expired/i.test(blob)
  ) {
    return "unauthorized";
  }
  if (
    /ambiguous|multi-?match|reconcile.*ambigu/i.test(blob)
  ) {
    return "ambiguous_target";
  }
  if (
    /plan_dependency|envelope|passing_fast|code_spec_binding|not ready|invalid state|workflow/i.test(
      blob,
    )
  ) {
    return "invalid_state";
  }
  if (/policy|safety|blocked|disallowed/i.test(blob)) {
    return "policy_rejection";
  }
  if (/rate.?limit|transient|timeout|econnreset|503|429/i.test(blob)) {
    return "rate_limit_or_transient";
  }
  return "other";
}

export function describeOffFrontierToolNearMiss(
  toolName: string,
  readyFrontierToolNames: readonly string[] = [],
): string | null {
  const name = toolName.trim().toLowerCase();
  if (!name) return null;
  const ready = new Set(
    readyFrontierToolNames.map((entry) => entry.trim()).filter(Boolean),
  );
  const listedAmong = (...candidates: string[]): string[] =>
    candidates.filter((candidate) => ready.has(candidate));

  if (
    name === "verify_all" ||
    name === "verify_project" ||
    name === "validate" ||
    name === "validate_all" ||
    name.endsWith("verify_all") ||
    name.endsWith("verify_project")
  ) {
    const listed = listedAmong(
      "code_validate_fast",
      "code_validate_targeted",
      "code_validate_full",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now (repo scripts/verify_*.py are not tools).`;
    }
    return "Near-miss: use code_validate_fast, code_validate_targeted, or code_validate_full when listed on the frontier (repo scripts/verify_*.py are not tools).";
  }

  if (
    name === "patch" ||
    name === "replace" ||
    name === "replace_workspace_text" ||
    name === "write_workspace_file"
  ) {
    const listed = listedAmong(
      "code_workspace_write_expected",
      "code_workspace_patch",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now; do not invent patch/replace tool names.`;
    }
    return "Near-miss: use code_workspace_patch or code_workspace_write_expected when listed on the frontier.";
  }

  if (
    name === "commit" ||
    name === "git_commit" ||
    name === "git_add" ||
    name === "git commit"
  ) {
    const listed = listedAmong("code_commit_verified");
    if (listed.length > 0) {
      return "Near-miss: call code_commit_verified now (host runs git add + commit; do not invent git_* tools).";
    }
    return "Near-miss: use code_commit_verified when listed on the frontier (host git add+commit).";
  }

  if (
    name === "create_repo" ||
    name === "create_repository" ||
    name === "github_create_repo"
  ) {
    const listed = listedAmong(
      "github_create_repository",
      "github_create_private_repository",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed[0]} now; repository visibility must come from the user's explicit public/private choice.`;
    }
    return "Near-miss: use github_create_repository when listed on the frontier; never infer public or private visibility.";
  }

  if (
    name === "publish" ||
    name === "push" ||
    name === "git_push" ||
    name === "create_pr" ||
    name === "draft_pr" ||
    name === "create_pull_request"
  ) {
    const listed = listedAmong(
      "publish_verified_code_to_github",
      "github_publish_verified_branch",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now for publish_draft.`;
    }
    return "Near-miss: use publish_verified_code_to_github when listed on the frontier.";
  }

  if (
    name === "linear_create" ||
    name === "create_issue" ||
    name === "create_linear_issue"
  ) {
    const listed = listedAmong(
      "linear_create_issue",
      "publish_research_to_linear",
      "publish_research_project_to_linear",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now.`;
    }
    return "Near-miss: use linear_create_issue or publish_research_to_linear when listed on the frontier.";
  }

  if (name === "search" || name === "search_notes" || name === "search_vault") {
    const listed = listedAmong(
      "semantic_search_notes",
      "search_markdown_files",
      "web_search",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now.`;
    }
    return "Near-miss: use semantic_search_notes or search_markdown_files when listed on the frontier.";
  }

  if (
    name === "code_workspace_write_expected" &&
    ready.has("code_repair_record_cycle")
  ) {
    return "Near-miss: call code_repair_record_cycle now to open the next correction cycle before writing.";
  }
  if (
    (name === "code_validate_fast" ||
      name === "code_validate_targeted" ||
      name === "code_validate_full") &&
    ready.has("code_repair_record_cycle")
  ) {
    return "Near-miss: call code_repair_record_cycle now; do not re-validate until the repair cycle opens corrections.";
  }
  if (name === "read_file" || name === "read" || name === "read_markdown_files") {
    if (ready.has("code_workspace_read")) {
      return "Near-miss: call code_workspace_read now for workspace or protected scripts.";
    }
    return "Near-miss: for workspace or protected scripts, use code_workspace_read when listed on the frontier.";
  }
  if (name === "create_file" || name === "write_file" || name === "mkdir") {
    const listed = listedAmong(
      "code_workspace_create_file",
      "code_workspace_mkdir",
    );
    if (listed.length > 0) {
      return `Near-miss: call ${listed.join(" or ")} now.`;
    }
    return "Near-miss: use code_workspace_create_file or code_workspace_mkdir when listed on the frontier.";
  }
  return null;
}

export function buildOffFrontierToolRejectionMessage(input: {
  toolName: string;
  pendingGraphNodeId?: string | null;
  readyFrontierToolNames: readonly string[];
  preferredNextTool?: string | null;
  category?: ToolRejectCategoryV1 | string | null;
  /**
   * Write tools currently held by proof verification. A held tool may sit on
   * the ready frontier (the graph considers it ready), but the proof gate
   * will hold it again on the very next call -- so this message must never
   * advise it, or the rejection commands the call another subsystem forbids.
   */
  heldWriteToolNames?: readonly string[];
}): string {
  const frontier =
    input.readyFrontierToolNames.length > 0
      ? input.readyFrontierToolNames.join(", ")
      : "none";
  const nearMiss = describeOffFrontierToolNearMiss(
    input.toolName,
    input.readyFrontierToolNames,
  );
  const category =
    input.category ??
    mapToolRejectCategory({
      toolName: input.toolName,
      pendingGraphNodeId: input.pendingGraphNodeId,
      message: input.pendingGraphNodeId
        ? "off-frontier"
        : "not available for this prompt",
    });
  const heldWriteTools = new Set(
    (input.heldWriteToolNames ?? []).filter(Boolean),
  );
  const preferred =
    input.preferredNextTool?.trim() ||
    input.readyFrontierToolNames
      .filter((name) => !heldWriteTools.has(name))
      .slice(0, 3)
      .filter(Boolean)
      .join(", ") ||
    "none";
  const base = input.pendingGraphNodeId
    ? `Deferred ${input.toolName}: authoritative mission node ${input.pendingGraphNodeId} is not on the ready frontier.`
    : `Tool is not available for this prompt: ${input.toolName}`;
  // "Preferred next" is ordering, not dependency reasoning: pickPreferredNextTool
  // returns the first unpaid delivery tool that happens to be ready, otherwise
  // the first ready name. It has never known what unblocks the deferred node.
  // Read as "call this and the deferred tool opens", it produces a loop -- call
  // the hint, retry the deferred tool, get the identical refusal. Say what is
  // actually true so the model stops re-attempting the deferred call.
  const deferredNote = input.pendingGraphNodeId
    ? `${input.toolName} stays refused until its own node is ready; calling the preferred tool does not by itself open it.`
    : "";
  // A verification hold has already told the model to return the corrected
  // content as its final answer; "call that exact name" for the held tool
  // would command the very call the gate holds again, and the model burns
  // turns reconciling the two. When the frontier offers nothing but held
  // tools, the frontier listing stays (it is factual) but no call directive
  // may appear -- there is nothing safe to call.
  const heldFrontierTools = input.readyFrontierToolNames.filter((name) =>
    heldWriteTools.has(name),
  );
  const heldPreferred = heldWriteTools.has(preferred)
    ? preferred
    : preferred === "none" && heldFrontierTools.length > 0
      ? heldFrontierTools.join(", ")
      : null;
  const preferredLine = heldPreferred
    ? `${heldPreferred} is currently held by proof verification — return the corrected note content as your final answer instead of calling it.`
    : preferred === "none"
      ? // "Preferred next: none. Call that exact name." literally instructs the
        // model to call a tool named "none". When nothing is callable, say so.
        "No tool is ready to call; return your best final answer instead."
      : `Preferred next: ${preferred}. Call that exact name.`;
  return [
    base,
    `category=${category}`,
    `Ready frontier tool(s) now: ${frontier}.`,
    preferredLine,
    deferredNote,
    nearMiss ?? "",
    "Correct only that issue; do not repeat this exact call.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildToolRejectEvalV1(input: {
  userIntentExcerpt: string;
  selectedTool: string;
  argumentsSummary?: string;
  expectedPrerequisite?: string | null;
  errorCategory: ToolRejectCategoryV1 | string;
  retryCount?: number;
  readyFrontier: readonly string[];
}): ToolRejectEvalV1 {
  return {
    userIntentExcerpt: String(input.userIntentExcerpt ?? "").slice(0, 400),
    selectedTool: input.selectedTool,
    argumentsSummary: input.argumentsSummary
      ? String(input.argumentsSummary).slice(0, 400)
      : undefined,
    expectedPrerequisite: input.expectedPrerequisite ?? null,
    result: "rejected",
    errorCategory: input.errorCategory,
    retryCount: input.retryCount ?? 0,
    readyFrontier: [...input.readyFrontier].slice(0, 24),
  };
}
