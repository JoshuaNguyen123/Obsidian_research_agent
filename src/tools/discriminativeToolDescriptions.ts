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
    "Purpose: Create a new file in a real directory on the user's local filesystem. Use when: adding a new workspace path for a code deliverable. Do not use when: writing Obsidian note content — use append_to_current_file. Required: path + content. Next: code_validate_fast, then code_workspace_export_directory for standalone-project delivery. Side effects: bound local write.",
  code_workspace_export_directory:
    "Purpose: Deliver a verified workspace directory to the user's real local filesystem. Use when: a standalone project is complete; default destinationRoot to vault_sibling_projects, or use Desktop, Documents, or Downloads only when the foreground mission names one. Do not use when: the destination already exists. Required: workspaceId, destinationRoot, destinationPath. Next: report the absolute verified export path. Side effects: exact approval-gated host write with no overwrite.",
  code_workspace_write_expected:
    "Purpose: Hash-bound full-file correction in a real directory on the user's local filesystem. Use when: repairing after code_workspace_read with expectedSha256. Do not use when: first create (use code_workspace_create_file) or inventing a patch tool. Required: path, content, expectedSha256. Next: validate/repair, then code_workspace_export_directory for standalone-project delivery. Side effects: bound local write.",
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
  report_progress_to_linear:
    "Purpose: Report progress on this run's Linear issue and optionally set its level. " +
    "Use when: finishing a mission that created or read back a Linear issue. " +
    "Do not use when: creating an issue, or reporting on an issue this run did not touch. " +
    "Required: issueId, comment. Next: none. Side effects: one comment, optional state change.",
  publish_research_to_linear:
    "Purpose: Publish accepted research to Linear. Use when: research acceptance → Linear. Do not use when: note-only reflection without Linear intent. Required: research artifact binding. Next: hierarchy or code. Side effects: bound.",
  github_create_repository:
    "Purpose: Create the exact GitHub repository after the user explicitly chooses public or private. Use when: a bound remote is needed and visibility is answered. Do not use when: visibility is unanswered, or for push/PR — use publish_verified_code_to_github. Required: repo binding + explicit visibility. Next: publish_draft. Side effects: bound; public is internet-visible.",
  github_create_private_repository:
    "Purpose: V1 alias for github_create_repository. Use only for a persisted V1 route. Do not infer private visibility from this legacy name; the current user must still explicitly choose public or private. Required: repo binding + explicit visibility. Next: publish_draft. Side effects: bound; public is internet-visible.",
  publish_verified_code_to_github:
    "Purpose: Push verified branch and create draft PR (or Bound merge when mission asks). Use when: after code_commit_verified + private repo. Do not use when: before commit; do not invent git_push. Required: action publish_draft|merge + bindings. Next: note reflection. Side effects: bound/hard for merge.",
  replace_current_file:
    "Purpose: Replace the entire active Obsidian note after backup. Use when: the user explicitly asks to rewrite, replace, overwrite, reset, or start the whole note fresh. Do not use when: appending, editing one heading (use edit_current_section), or writing code (use code_workspace_*). Required: text. Next: stop or verify. Side effects: write with backup.",
  edit_current_section:
    "Purpose: Replace one heading section body in the active note after backup; keep the heading line. Use when: the user names a heading to edit, revise, update, or rewrite. Do not use when: whole-note rewrite (replace_current_file) or append-only (append_to_current_file / append_to_current_section). Required: heading + content. Next: stop or read. Side effects: write with backup.",
  code_workspace_create:
    "Purpose: Bootstrap a durable code workspace (scratch or trusted repository). Use when: starting code work; this is the first callable Code tool. Do not use when: a durable workspaceId already exists, or writing Obsidian notes. Required: kind/workspace binding. Next: mkdir/create_file/read. Side effects: bound workspace create.",
  code_workspace_append:
    "Purpose: Append to a workspace file, creating it if missing. Use when: adding to a planned implementation file after read. Do not use when: writing Obsidian notes or creating a full new file (use code_workspace_create_file). Required: path + content. Next: code_validate_fast. Side effects: bound local write.",
  code_sandbox_status:
    "Purpose: Read cached sandbox provider status without probing or starting a process. Use when: before validate/commit to confirm a verified sandbox. Do not use when: running tests (use code_validate_*) or creating a workspace. Required: none. Next: code_validate_fast if Ready. Side effects: read.",
  code_workspace_init_repository:
    "Purpose: git-init a scratch workspace so commit and GitHub become available. Use when: files are validated and the mission asks for commit/repo/GitHub, and no repository is bound. Do not use when: the workspace was created from an existing repo. Required: workspace. Next: code_commit_verified. Side effects: approval-gated git init.",
  web_fetch:
    "Purpose: Fetch one public http(s) page and cache bounded sections. Use when: after web_search, to read a specific source URL. Do not use when: searching (use web_search) or reading vault notes. Required: url. Next: cite or read_source_section. Side effects: read.",
  read_source_section:
    "Purpose: Read one numbered section from a cached web_fetch source. Use when: the fetch was truncated and a later section is needed. Do not use when: the page is not yet fetched (use web_fetch). Required: section plus url or path. Next: cite or synthesize. Side effects: read.",
  resolve_citation:
    "Purpose: Resolve a DOI, arXiv id, or title into one bibliographic record. Use when: a stable citation record/sourceId is needed. Do not use when: fetching page text (use web_fetch) or verifying a quote (use verify_citation). Required: identifier. Next: cite or export_bibtex. Side effects: read.",
  verify_citation:
    "Purpose: Check a claimed quote against a cached web_fetch source. Use when: verifying a quotation. Do not use when: the URL was not fetched yet. Required: quote plus url or path. Next: keep, drop, or re-fetch. Side effects: read.",
  export_bibtex:
    "Purpose: Format resolve_citation records as BibTeX. Use when: the user asked for BibTeX. Do not use when: writing the file yourself — pass records, then create_file. Required: records. Next: create_file. Side effects: none.",
  extract_document:
    "Purpose: Extract page-marked text from a PDF or document via the companion. Use when: the user names a PDF or asks to extract document text. Do not use when: HTML pages (use web_fetch) or no companion session. Required: url. Next: cite pages or verify_citation. Side effects: read.",
  semantic_search_notes:
    "Purpose: Conceptual vault search by idea or topic when filenames may differ. Use when: asking what notes say about a concept. Do not use when: an exact path/title/heading is known (use read_file) or mutating notes. Required: query. Next: read_file on ranked paths. Side effects: read.",
  inspect_semantic_index:
    "Purpose: Inspect the semantic vault index for concepts and freshness. Use when: checking index coverage before search. Do not use when: treating index summaries as citable evidence. Required: none. Next: semantic_search_notes or read_file. Side effects: read.",
  rebuild_semantic_index:
    "Purpose: Rebuild derived semantic index files. Use when: the user explicitly asks for index maintenance. Do not use when: ordinary search or note writes. Required: none. Next: semantic_search_notes. Side effects: index rewrite.",
  recall_tool_result:
    "Purpose: Re-read the full output of an earlier tool call that was shortened to save space. Use when: a tool result shows truncated:true and a recallKey, and you need detail it dropped. Do not use when: you have not seen a recallKey (nothing was set aside), or the tool can simply be run again more cheaply. Required: key. Next: continue the step that needed the detail. Side effects: read.",
  list_markdown_files:
    "Purpose: List vault markdown paths. Use when: candidate note paths are needed and no exact path is known. Do not use when: reading content (use read_file) or conceptual search (use semantic_search_notes). Required: none. Next: read_file. Side effects: read.",
  get_note_graph_context:
    "Purpose: Inspect explicit Obsidian links and backlinks for a note. Use when: graph or backlink questions. Do not use when: inferred relatedness (use find_related_notes) or writing links. Required: optional path. Next: read or suggest_note_links. Side effects: read.",
  find_related_notes:
    "Purpose: Rank related notes via local graph and content heuristics. Use when: related-note questions. Do not use when: only explicit backlinks (use get_note_graph_context) or writing links. Required: optional path/query. Next: read_file. Side effects: read.",
  suggest_note_links:
    "Purpose: Suggest wiki links to related notes without modifying the note. Use when: the user asks for link suggestions. Do not use when: inserting links (use link_related_notes_in_current_file). Required: optional path. Next: user or link tool. Side effects: read.",
};

const DESCRIPTION_FIELDS = [
  "Purpose:",
  "Use when:",
  "Do not use when:",
  "Required:",
  "Next:",
  "Side effects:",
] as const;

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

export function applyDiscriminativeToolDefinition<
  T extends { function: { name: string; description?: string } },
>(tool: T): T {
  const description = withDiscriminativeDescription(
    tool.function.name,
    tool.function.description ?? "",
  );
  if (description === (tool.function.description ?? "")) return tool;
  return {
    ...tool,
    function: { ...tool.function, description },
  };
}

export function descriptionHasRequiredFields(text: string): boolean {
  return DESCRIPTION_FIELDS.every((field) => text.includes(field));
}
