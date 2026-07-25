import {
  PROJECT_LIFECYCLE_STAGES,
  type ProjectLifecycleStageV1,
} from "./projectLifecycle";
import { PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME } from "../tools/researchPublicationTool";
import { PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME } from "../tools/researchProjectHierarchyTool";
import {
  CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
} from "../tools/githubPrivateRepositoryTool";
import {
  DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
} from "../tools/githubPrivateRepositoryCleanupTool";
import {
  PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
} from "../tools/githubPublicationTool";
import {
  GITHUB_CATALOG_DESTRUCTIVE_TOOL_NAMES,
  GITHUB_CATALOG_MUTATION_TOOL_NAMES,
  GITHUB_CATALOG_READ_TOOL_NAMES,
} from "../tools/githubCatalogTools";

const GITHUB_CATALOG_DESTRUCTIVE_TOOL_SET = new Set<string>(
  GITHUB_CATALOG_DESTRUCTIVE_TOOL_NAMES,
);

/** Read-only GitHub catalog operations available in the GitHub lifecycle stage. */
export const GITHUB_STAGE_READ_TOOL_ALLOW: readonly string[] =
  GITHUB_CATALOG_READ_TOOL_NAMES;

/** Reversible/non-destructive GitHub catalog mutations; exact authority is still required. */
export const GITHUB_STAGE_SAFE_MUTATION_TOOL_ALLOW: readonly string[] =
  Object.freeze(
    GITHUB_CATALOG_MUTATION_TOOL_NAMES.filter(
      (name) => !GITHUB_CATALOG_DESTRUCTIVE_TOOL_SET.has(name),
    ),
  );

/** Destructive catalog operations are isolated to reconciliation cleanup. */
export const GITHUB_CLEANUP_DESTRUCTIVE_TOOL_ALLOW: readonly string[] =
  GITHUB_CATALOG_DESTRUCTIVE_TOOL_NAMES;

export const PROOF_BOUND_PROVIDER_LIFECYCLE_TOOL_NAMES = new Set<string>([
  PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
  PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
  CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
  DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
]);

export const PROJECT_LIFECYCLE_STAGE_MUTATION_TOOL_NAMES = new Set<string>([
  ...PROOF_BOUND_PROVIDER_LIFECYCLE_TOOL_NAMES,
  ...GITHUB_CATALOG_MUTATION_TOOL_NAMES,
  "code_commit_verified",
]);

/**
 * Canonical code_execution tool allowlist shared by lifecycle Soft-union,
 * MissionGraph frontier fallbacks, and route-base schema shrink. Envelope
 * layers may add note companions on top; do not diverge the code_* core.
 */
export const CODE_EXECUTION_TOOL_ALLOW = [
  "code_sandbox_status",
  "code_workspace_create",
  "code_workspace_status",
  "code_workspace_read",
  "code_workspace_stat",
  "code_workspace_list",
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
] as const;

/** Note companions allowed inside the Bound code_execution envelope only. */
export const CODE_EXECUTION_ENVELOPE_NOTE_COMPANIONS = [
  "append_to_current_file",
  "replace_current_file",
  "read_current_file",
] as const;

const LIFECYCLE_STAGE_TOOL_ALLOW: Record<
  ProjectLifecycleStageV1,
  readonly string[]
> = {
  accepted_research: [
    "web_search",
    "web_fetch",
    "read_current_file",
    "read_file",
    "read_markdown_files",
    "search_markdown_files",
    "list_markdown_files",
    "semantic_search_notes",
    "find_related_notes",
    "get_note_graph_context",
    "append_to_current_file",
    "replace_current_file",
    "count_words",
    PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
  ],
  linear_hierarchy: [
    PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
    PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
    "linear_get_connection_context",
    "linear_create_issue",
    "linear_get_issue",
    "linear_search_issues",
  ],
  code_execution: [...CODE_EXECUTION_TOOL_ALLOW],
  private_github_publication: [
    CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
    ...GITHUB_STAGE_READ_TOOL_ALLOW,
    ...GITHUB_STAGE_SAFE_MUTATION_TOOL_ALLOW,
  ],
  reconciliation_cleanup: [
    "linear_trash_issue",
    "linear_trash_project",
    "linear_trash_initiative",
    DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    ...GITHUB_CLEANUP_DESTRUCTIVE_TOOL_ALLOW,
  ],
};

export function toolsAllowedForLifecycleStage(
  stage: ProjectLifecycleStageV1,
): readonly string[] {
  return LIFECYCLE_STAGE_TOOL_ALLOW[stage] ?? [];
}

export function nextLifecycleStageAfter(
  stage: ProjectLifecycleStageV1,
  committed: boolean,
): ProjectLifecycleStageV1 | null {
  const index = PROJECT_LIFECYCLE_STAGES.indexOf(stage);
  if (index < 0) {
    return null;
  }
  if (!committed) {
    return stage;
  }
  if (index >= PROJECT_LIFECYCLE_STAGES.length - 1) {
    return null;
  }
  return PROJECT_LIFECYCLE_STAGES[index + 1] ?? null;
}

export function shouldDeferAdditionalProjectLifecycleMutation(
  toolName: string,
  lifecycleStageMutationAttemptedThisResponse: boolean,
): boolean {
  return (
    lifecycleStageMutationAttemptedThisResponse &&
    PROJECT_LIFECYCLE_STAGE_MUTATION_TOOL_NAMES.has(toolName)
  );
}

export function insertExplicitLinearReadbacksIntoLifecycleToolNames(
  lifecycleToolNames: readonly string[],
  linearReadToolNames: readonly string[],
): string[] {
  const ordered: string[] = [];
  for (const name of lifecycleToolNames) {
    ordered.push(name);
    if (name === PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME) {
      ordered.push(...linearReadToolNames);
    }
  }
  if (
    linearReadToolNames.length > 0 &&
    !lifecycleToolNames.includes(PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME)
  ) {
    ordered.push(...linearReadToolNames);
  }
  return [...new Set(ordered)];
}
