/**
 * Code workspace edit-tool selection constrained by lifecycle allowlists.
 * Prefer create_file/patch over copy/move/trash unless allowlisted.
 */

const RELOCATION_TOOLS = new Set([
  "code_workspace_copy",
  "code_workspace_move",
  "code_workspace_trash",
]);

/**
 * Choose the workspace mutation tool for an implementation prompt.
 * Never returns copy/move/trash unless present in allowlist.
 */
export function selectCodeWorkspaceEditToolName(
  prompt: string,
  allowlist: ReadonlySet<string>,
): string {
  const text = String(prompt ?? "");

  if (
    /\b(create|add|new)\b[\s\S]{0,80}\b(folder|directory)\b/i.test(text) &&
    allowlist.has("code_workspace_mkdir")
  ) {
    return "code_workspace_mkdir";
  }

  if (
    /\b(copy|duplicate)\b[\s\S]{0,80}\b(file|folder|directory|path)\b/i.test(text) &&
    allowlist.has("code_workspace_copy")
  ) {
    return "code_workspace_copy";
  }

  if (
    /\b(rename|move)\b[\s\S]{0,80}\b(file|folder|directory|path)\b/i.test(text) &&
    allowlist.has("code_workspace_move")
  ) {
    return "code_workspace_move";
  }

  if (
    /\b(remove|delete|trash)\b[\s\S]{0,80}\b(file|folder|directory|path)\b/i.test(
      text,
    ) &&
    allowlist.has("code_workspace_trash")
  ) {
    return "code_workspace_trash";
  }

  if (/\bappend\b/i.test(text) && allowlist.has("code_workspace_append")) {
    return "code_workspace_append";
  }

  if (
    /\b(patch|edit|modify|update|fix)\b/i.test(text) &&
    allowlist.has("code_workspace_patch") &&
    !/\b(create|add|new)\b[\s\S]{0,40}\b(file|module|script|class)\b/i.test(text)
  ) {
    return "code_workspace_patch";
  }

  if (allowlist.has("code_workspace_create_file")) {
    return "code_workspace_create_file";
  }
  if (allowlist.has("code_workspace_patch")) {
    return "code_workspace_patch";
  }
  if (allowlist.has("code_workspace_append")) {
    return "code_workspace_append";
  }
  return "code_workspace_create_file";
}

/** True when a planned edit tool is a relocation/cleanup tool. */
export function isCodeWorkspaceRelocationTool(toolName: string): boolean {
  return RELOCATION_TOOLS.has(toolName.trim());
}

/**
 * Filter planned code workflow tools so non-allowlisted relocation tools drop.
 */
export function filterCodeWorkflowToolsToAllowlist(
  toolNames: readonly string[],
  allowlist: ReadonlySet<string>,
): string[] {
  return toolNames.filter((name) => {
    if (isCodeWorkspaceRelocationTool(name) && !allowlist.has(name)) {
      return false;
    }
    return true;
  });
}
