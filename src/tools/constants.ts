export const MAX_AGENT_STEPS = 100;
export const FINALIZATION_RESERVE_STEPS = 4;
export const CHECKPOINT_EVERY_STEPS = 5;
export const PROGRESS_REVIEW_EVERY_STEPS = 10;
export const MISSION_MILESTONE_STEPS = [25, 50, 75, 100] as const;
export const LONG_RUN_STEP_WARN_AT = 15;
export const MAX_FILE_READ_CHARS = 12000;
export const MAX_INITIAL_CURRENT_NOTE_CHARS = 6000;
export const MAX_TOOL_RESULT_CHARS = 8000;
export const MAX_LISTED_FILES = 300;
export const MAX_BATCH_READ_FILES = 20;
export const MAX_BATCH_READ_CHARS_PER_FILE = 6000;
export const MAX_SEARCH_RESULTS = 30;
export const MAX_SEARCH_SNIPPET_CHARS = 420;
export const MAX_WEB_RESULTS = 10;
export const MAX_WEB_SEARCH_SNIPPET_CHARS = 800;
export const MAX_WEB_FETCH_CHARS = 6000;
export const DEFAULT_WEB_RESULTS = 3;
export const MAX_CODE_RUNS_PER_MISSION = 16;
export const MAX_PARALLEL_TOOL_CALLS = 4;
export const READ_ONLY_TOOL_NAMES = new Set([
  "read_current_file",
  "inspect_vault_context",
  "inspect_vault_index",
  "list_markdown_files",
  "search_markdown_files",
  "read_markdown_files",
  "read_file",
  "count_words",
  "get_note_graph_context",
  "find_related_notes",
  "suggest_note_links",
  "web_search",
  "web_fetch",
  "read_source_section",
  "browser_observe",
  "browser_screenshot",
  "browser_extract_markdown",
  "inspect_semantic_index",
  "semantic_search_notes",
  "list_current_folder",
  "list_folder",
  "get_path_info",
  "list_templates",
  "read_template",
  "read_workspace_file",
  "list_workspace_files",
  "search_research_memory",
  "read_research_memory",
]) as ReadonlySet<string>;
export const BACKUP_FOLDER = ".agent-backups";
