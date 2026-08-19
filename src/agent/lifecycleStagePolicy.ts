import {
  PROJECT_LIFECYCLE_STAGES,
  type ProjectLifecycleStageV1,
} from "./projectLifecycle";
import { PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME } from "../tools/researchPublicationTool";
import { CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME } from "../tools/projectIdeaBriefTool";
import { APPEND_JUPYTER_REFLECTION_TOOL_NAME } from "../tools/jupyterReflectionTool";
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

const LINEAR_HANDOFF_PRODUCER_TOOL_NAMES = [
  PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
  PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
  "linear_create_issue",
] as const;

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
  APPEND_JUPYTER_REFLECTION_TOOL_NAME,
  "write_project_results",
]);

/**
 * Canonical code_execution tool allowlist shared by lifecycle Soft-union,
 * MissionGraph frontier fallbacks, and route-base schema shrink. Envelope
 * layers may add note companions on top; do not diverge the code_* core.
 */
export const CODE_IMPLEMENTATION_TOOL_ALLOW = [
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
] as const;

export const CODE_VALIDATION_TOOL_ALLOW = [
  "code_sandbox_status",
  "code_validate_fast",
  "code_validate_targeted",
  "code_validate_full",
  "code_repair_record_cycle",
  "code_repair_status",
  "code_commit_verified",
] as const;

/** Backward-compatible union for code routes that are not lifecycle staged. */
export const CODE_EXECUTION_TOOL_ALLOW = [
  ...CODE_IMPLEMENTATION_TOOL_ALLOW,
  ...CODE_VALIDATION_TOOL_ALLOW,
] as const;

const LINEAR_HANDOFF_CONSUMER_TOOL_NAMES = new Set<string>([
  ...CODE_EXECUTION_TOOL_ALLOW,
  CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
  DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  ...GITHUB_CATALOG_READ_TOOL_NAMES,
  ...GITHUB_CATALOG_MUTATION_TOOL_NAMES,
]);

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
    CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME,
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
  code_execution: [...CODE_IMPLEMENTATION_TOOL_ALLOW],
  code_validation: [...CODE_VALIDATION_TOOL_ALLOW],
  private_github_publication: [
    CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
    ...GITHUB_STAGE_READ_TOOL_ALLOW,
    ...GITHUB_STAGE_SAFE_MUTATION_TOOL_ALLOW,
  ],
  reflection: [
    APPEND_JUPYTER_REFLECTION_TOOL_NAME,
    "write_project_results",
    "append_to_current_file",
    "read_current_file",
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
  const reads = [...new Set(linearReadToolNames)];
  const readSet = new Set(reads);
  const lifecycle = [
    ...new Set(lifecycleToolNames.filter((name) => !readSet.has(name))),
  ];
  if (reads.length === 0) {
    return lifecycle;
  }

  const firstConsumerIndex = lifecycle.findIndex((name) =>
    LINEAR_HANDOFF_CONSUMER_TOOL_NAMES.has(name),
  );
  const predecessorLimit =
    firstConsumerIndex >= 0 ? firstConsumerIndex : lifecycle.length;
  let producerIndex = -1;

  for (const producerName of LINEAR_HANDOFF_PRODUCER_TOOL_NAMES) {
    for (let index = predecessorLimit - 1; index >= 0; index -= 1) {
      if (lifecycle[index] === producerName) {
        producerIndex = index;
        break;
      }
    }
    if (producerIndex >= 0) {
      break;
    }
  }

  const insertionIndex =
    producerIndex >= 0
      ? producerIndex + 1
      : firstConsumerIndex >= 0
        ? firstConsumerIndex
        : lifecycle.length;
  return [
    ...lifecycle.slice(0, insertionIndex),
    ...reads,
    ...lifecycle.slice(insertionIndex),
  ];
}
