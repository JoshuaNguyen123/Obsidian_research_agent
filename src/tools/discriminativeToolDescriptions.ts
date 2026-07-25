/**
 * Discriminative tool description prefixes (Purpose / Use when / Do not use when).
 * Applied at the start of model-facing tool descriptions for confused pairs.
 */

export const DISCRIMINATIVE_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  append_to_current_file:
    "Purpose: Append markdown to the open Obsidian note. Use when: the mission asks to add note content or reflection. Do not use when: implementing code in a git sandbox — use code_workspace_* instead. Required: text. Next: continue mission or reflect URLs. Side effects: write.",
  read_current_file:
    "Purpose: Read the active Obsidian note. Use when: vault/note context is needed. Do not use when: reading sandbox/repo files — use code_workspace_read. Required: none. Next: act on note content. Side effects: read.",
  read_file:
    "Purpose: Read a vault markdown path. Use when: a specific note path is known. Do not use when: reading workspace/repo files — use code_workspace_read. Required: path. Next: use note content. Side effects: read.",
  web_search:
    "Purpose: Search the public web. Use when: external facts or sources are required. Do not use when: pure vault/note organize questions. Required: query. Next: web_fetch or synthesize. Side effects: read.",
  code_workspace_create_file:
    "Purpose: Create a new file in a real directory on the user's local filesystem. Use when: adding a new workspace path for a code deliverable. Do not use when: writing Obsidian note content — use append_to_current_file. Required: path + content. Next: code_validate_fast, then code_workspace_export_directory for Desktop/Documents/Downloads delivery. Side effects: bound local write.",
  code_workspace_export_directory:
    "Purpose: Deliver a verified workspace directory to Desktop, Documents, or Downloads on the user's real local filesystem. Use when: the foreground mission explicitly requests one of those destinations. Do not use when: no known host folder was requested or the destination already exists. Required: workspaceId, destinationRoot, destinationPath. Next: report the absolute verified export path. Side effects: exact approval-gated host write with no overwrite.",
  code_workspace_write_expected:
    "Purpose: Hash-bound full-file correction in a real directory on the user's local filesystem. Use when: repairing after code_workspace_read with expectedSha256. Do not use when: first create (use code_workspace_create_file) or inventing a patch tool. Required: path, content, expectedSha256. Next: validate/repair, then code_workspace_export_directory for Desktop/Documents/Downloads delivery. Side effects: bound local write.",
  code_workspace_patch:
    "Purpose: Exact text replacements in an existing workspace file. Use when: small edits after read+SHA. Do not use when: creating a new file. Required: path, replacements. Next: validate. Side effects: bound write.",
  code_validate_fast:
    "Purpose: Sandbox smoke validation. Use when: after workspace edits. Do not use when: calling verify_all or repo scripts as tools. Required: workspace scope. Next: code_repair_record_cycle if red, else targeted/full. Side effects: read/execute sandbox.",
  code_repair_record_cycle:
    "Purpose: Open the next repair cycle after red validation. Use when: validate_fast failed. Do not use when: re-validating or writing before the cycle opens. Required: request/workspace ids. Next: hash-bound write then re-validate. Side effects: bound.",
  code_commit_verified:
    "Purpose: Host git add of changed paths + verified commit + handoff SHA. Use when: fast (+ ladder) validation passed. Do not use when: before passed fast; do not invent git_commit/git_add. Required: commit message + validation receipt ids. Next: GitHub publish_draft. Side effects: bound.",
  linear_create_issue:
    "Purpose: Create a Linear issue with provider readback. Use when: explicit Linear create intent. Do not use when: math 'linear' or note-only URL writeback. Required: title/team fields. Next: linear_get_issue or code stage. Side effects: bound.",
  linear_get_issue:
    "Purpose: Read a verified Linear issue. Use when: need title/description/AC readback. Do not use when: creating issues. Required: issue id. Next: implement against description. Side effects: read.",
  publish_research_to_linear:
    "Purpose: Publish accepted research to Linear. Use when: research acceptance → Linear. Do not use when: note-only reflection without Linear intent. Required: research artifact binding. Next: hierarchy or code. Side effects: bound.",
  github_create_private_repository:
    "Purpose: Create a private GitHub repository after verified commit. Use when: private remote is needed. Do not use when: push/PR — use publish_verified_code_to_github. Required: repo name binding. Next: publish_draft. Side effects: bound.",
  publish_verified_code_to_github:
    "Purpose: Push verified branch and create draft PR (or Bound merge when mission asks). Use when: after code_commit_verified + private repo. Do not use when: before commit; do not invent git_push. Required: action publish_draft|merge + bindings. Next: note reflection. Side effects: bound/hard for merge.",
};

export function withDiscriminativeDescription(
  toolName: string,
  baseDescription: string,
): string {
  const prefix = DISCRIMINATIVE_TOOL_DESCRIPTIONS[toolName];
  if (!prefix) return baseDescription;
  const base = String(baseDescription ?? "").trim();
  if (!base) return prefix;
  if (base.startsWith("Purpose:")) return base;
  return `${prefix} ${base}`;
}
