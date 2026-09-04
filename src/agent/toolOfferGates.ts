/**
 * Mission tool-offer predicates. Other agents should import this module
 * instead of reaching into AgentRunner.
 *
 * Extracted from AgentRunner.isAllowedForMission, then widened for research
 * tools: citation verify/resolve on fetched-web language, Mermaid create,
 * sidecar create_file, dataset path mentions, narrowed Linear, and GitHub
 * PR/issue #N catalog reads.
 */

import { hasCodeDeliverableIntent } from "./codeDeliverableIntent";
import {
  hasExplicitCanvasDestinationIntent,
  hasReviseDesignIntent,
} from "./codeDesignIntent";
import { hasJupyterReflectionIntentV1 } from "./jupyterReflectionIntent";
import {
  detectLinearIntent,
  hasExplicitPermanentLinearDeleteIntent,
} from "./linearIntent";
import {
  currentNoteAppendCatalogEligible,
  currentNoteReplaceCatalogEligible,
  isBroadUnscopedVaultMutation,
} from "./missionScope";
import { hasMissionResumeIntent } from "./missionResume";
import { detectProjectLifecycleStagesV1 } from "./projectLifecycle";
import {
  getNamedLinearDeepNouns,
  hasAffirmativeCodePathAction,
  hasBrowserAutomationIntent,
  hasCheckpointResumeIntent,
  hasCitationVerifyResolveOfferIntent,
  hasCitationWorkIntent,
  hasCodeExecutionIntent,
  hasCodeWorkspaceReadIntent,
  hasCreateFileIntent,
  hasCurrentNoteReadIntent,
  hasDatasetAnalysisIntent,
  hasDesignIntent,
  hasDocumentExtractIntent,
  hasExperienceMemoryIntent,
  hasGitHubPrOrIssueRefIntent,
  hasGraphConnectionIntent,
  hasHtmlPreviewIntent,
  hasMermaidCreateIntent,
  hasMermaidDesignIntent,
  hasOpenWebSourceIntent,
  hasPreparedBackgroundCodeValidationCommitIntent,
  hasResearchMemoryCompactIntent,
  hasResearchMemoryIntent,
  hasResearchMemoryWriteIntent,
  hasRepositoryCodeMutationIntent,
  hasSidecarCreateFileIntent,
  hasSpecificFileReadIntent,
  hasStandaloneCodeExecutionIntent,
  hasTemplateIntent,
  hasVaultBrowseIntent,
  hasVaultIndexIntent,
  hasWebSearchIntent,
  hasWordCountIntent,
} from "./promptIntentClassifiers";
import type { ReflexDecision } from "./reflex/types";
import { ASK_USER_TOOL_NAME } from "../tools/clarificationTools";
import { EXTRACT_DOCUMENT_TOOL_NAME } from "../tools/documentExtract";
import { DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME } from "../tools/githubPrivateRepositoryCleanupTool";
import { CREATE_GITHUB_REPOSITORY_TOOL_NAME } from "../tools/githubPrivateRepositoryTool";
import { PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME } from "../tools/githubPublicationTool";
import {
  GITHUB_CATALOG_DESTRUCTIVE_TOOL_NAMES,
  GITHUB_CATALOG_MUTATION_TOOL_NAMES,
  GITHUB_CATALOG_READ_TOOL_NAMES,
  getExplicitGitHubCatalogMutationToolNames,
  getGitHubCatalogReadToolNames,
  hasExplicitGitHubCatalogIntent,
  isGitHubCatalogToolName,
  type GitHubCatalogToolName,
} from "../tools/githubCatalogTools";
import { APPEND_JUPYTER_REFLECTION_TOOL_NAME } from "../tools/jupyterReflectionTool";
import { WRITE_PROJECT_RESULTS_TOOL_NAME } from "../tools/projectResultsTool";
import { PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME } from "../tools/researchProjectHierarchyTool";
import { PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME } from "../tools/researchPublicationTool";
import type { MissionIntent } from "../tools/types";

export { EXTRACT_DOCUMENT_TOOL_NAME };

const READ_NAV_TOOL_NAMES = new Set([
  ...GITHUB_CATALOG_READ_TOOL_NAMES,
  "read_current_file",
  "inspect_vault_context",
  "inspect_vault_index",
  "list_current_folder",
  "list_markdown_files",
  "read_markdown_files",
  "search_markdown_files",
  "inspect_semantic_index",
  "semantic_search_notes",
  "read_file",
  "count_words",
  "get_note_graph_context",
  "find_related_notes",
  "suggest_note_links",
  "list_folder",
  "get_path_info",
  "search_research_memory",
  "read_research_memory",
  "review_research_memory",
  "memory_search",
  "list_templates",
  "read_template",
  "read_design_canvas",
  "read_svg_design",
  "read_mermaid_block",
  "analyze_dataset",
  "resolve_citation",
  "verify_citation",
  "export_bibtex",
  EXTRACT_DOCUMENT_TOOL_NAME,
  "browser_observe",
  "browser_screenshot",
  "browser_extract_markdown",
]);

const WRITE_TOOL_NAMES = new Set([
  ...GITHUB_CATALOG_MUTATION_TOOL_NAMES.filter(
    (name) =>
      !GITHUB_CATALOG_DESTRUCTIVE_TOOL_NAMES.includes(
        name as (typeof GITHUB_CATALOG_DESTRUCTIVE_TOOL_NAMES)[number],
      ),
  ),
  PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
  PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
  CREATE_GITHUB_REPOSITORY_TOOL_NAME,
  PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
  APPEND_JUPYTER_REFLECTION_TOOL_NAME,
  WRITE_PROJECT_RESULTS_TOOL_NAME,
  "open_web_source",
  "create_design_canvas",
  "update_design_canvas",
  "create_svg_design",
  "update_svg_design",
  "upsert_mermaid_block",
  "create_design_package",
  "export_workspace_artifact",
  "code_workspace_export_directory",
  "memory_write_observation",
  "memory_write_task_summary",
  "memory_write_procedural",
  "memory_write_source",
  "seed_default_templates",
  "create_template",
  "fill_template",
  "create_research_pack",
  "create_folder",
  "create_file",
  "append_file",
  "replace_file",
  "move_path",
  "append_to_current_file",
  "append_to_current_section",
  "highlight_current_file_phrase",
  "restore_current_file_from_backup",
  "append_research_memory",
  "compact_research_memory",
  "rename_current_file",
  "retitle_current_file",
  "prepare_edit_current_section",
  "edit_current_section",
  "replace_current_file",
  "link_related_notes_in_current_file",
  "rebuild_semantic_index",
]);

const DELETE_TOOL_NAMES = new Set([
  ...GITHUB_CATALOG_DESTRUCTIVE_TOOL_NAMES,
  DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  "delete_path",
  "delete_current_file",
  "delete_research_memory_entry",
  "memory_forget",
  "memory_clear_experience",
]);

const CODE_TOOL_NAMES = new Set([
  "code_workspace_create",
  "code_workspace_init_repository",
  "code_workspace_status",
  "code_workspace_stat",
  "code_workspace_list",
  "code_workspace_read",
  "code_workspace_search",
  "code_workspace_mkdir",
  "code_workspace_create_file",
  "code_workspace_export_directory",
  "code_workspace_append",
  "code_workspace_write_expected",
  "code_workspace_patch",
  "code_workspace_move",
  "code_workspace_copy",
  "code_workspace_trash",
  "code_workspace_restore",
  "code_repository_detect_profile",
  "code_sandbox_status",
  "code_validate_fast",
  "code_validate_targeted",
  "code_validate_full",
  "code_repair_status",
  "code_repair_record_cycle",
  "code_commit_verified",
  "code_validate_commit_prepared",
  "run_code_block",
  "render_html_preview",
  "write_workspace_file",
  "read_workspace_file",
  "list_workspace_files",
  "replace_workspace_text",
  "preview_workspace_html",
  "export_workspace_artifact",
  "install_code_dependency",
]);

const CODE_READ_ONLY_TOOL_NAMES = new Set([
  "code_workspace_create",
  "code_workspace_status",
  "code_workspace_stat",
  "code_workspace_list",
  "code_workspace_read",
  "code_workspace_search",
  "code_repository_detect_profile",
  "code_sandbox_status",
  "read_workspace_file",
  "list_workspace_files",
  "preview_workspace_html",
  "export_workspace_artifact",
  "render_html_preview",
  "code_repair_status",
]);

const BROWSER_TOOL_NAMES = new Set([
  "browser_open_page",
  "browser_observe",
  "browser_click",
  "browser_type",
  "browser_keypress",
  "browser_scroll",
  "browser_screenshot",
  "browser_extract_markdown",
]);

const MEMORY_TOOL_NAMES = new Set([
  "memory_search",
  "memory_write_observation",
  "memory_write_task_summary",
  "memory_write_procedural",
  "memory_write_source",
  "memory_forget",
  "memory_clear_experience",
]);

const LINEAR_DEFAULT_OFFER_NAMES = new Set([
  "linear_get_connection_context",
  "linear_list_teams",
  "linear_list_users",
  "linear_list_workflow_states",
  "linear_get_issue",
  "linear_list_issues",
  "linear_search_issues",
  "linear_create_issue",
  "linear_update_issue",
  "linear_archive_issue",
  "linear_unarchive_issue",
  "linear_trash_issue",
  "linear_list_projects",
  "linear_list_project_statuses",
  "linear_get_project",
  "linear_create_project",
  "linear_update_project",
  "linear_archive_project",
  "linear_unarchive_project",
  "linear_trash_project",
  "linear_create_project_update",
  "linear_update_project_update",
  "linear_archive_project_update",
  "linear_unarchive_project_update",
  "linear_delete_project_update",
  "linear_get_project_update",
  "linear_list_project_updates",
]);

const LINEAR_NOUN_TOOL_FRAGMENTS: Record<string, string[]> = {
  cycle: ["cycle"],
  comment: ["comment"],
  document: ["document"],
  initiative: ["initiative"],
  customer: ["customer"],
  label: ["label"],
  relation: ["relation"],
  milestone: ["milestone"],
};

export interface ToolOfferGateInput {
  name: string;
  prompt: string;
  intent: MissionIntent;
  reflex?: ReflexDecision | null;
  routedCodeToolNames?: ReadonlySet<string>;
}

export function hasSafeReflexLabel(
  reflex: ReflexDecision | null | undefined,
  labels: ReflexDecision["label"][],
): boolean {
  return Boolean(
    reflex &&
      reflex.confidence >= 0.72 &&
      labels.includes(reflex.label) &&
      !reflex.safetyNotes.includes("unsafe"),
  );
}

export function shouldOfferMermaidBlock(prompt: string): boolean {
  return (
    hasMermaidDesignIntent(prompt) &&
    !hasExplicitCanvasDestinationIntent(prompt) &&
    (hasReviseDesignIntent(prompt) || hasMermaidCreateIntent(prompt))
  );
}

export function shouldOfferCreateFile(prompt: string): boolean {
  if (!hasCreateFileIntent(prompt)) {
    return false;
  }
  if (!hasTemplateIntent(prompt)) {
    return true;
  }
  return hasSidecarCreateFileIntent(prompt);
}

export function isLinearToolOfferedForMission(
  name: string,
  prompt: string,
): boolean {
  if (!name.startsWith("linear_")) {
    return false;
  }
  if (!detectLinearIntent(prompt).explicit) {
    return false;
  }
  if (name === "linear_delete_issue_permanently") {
    return hasExplicitPermanentLinearDeleteIntent(prompt);
  }
  if (new RegExp(`\\b${name}\\b`, "iu").test(prompt)) {
    return true;
  }
  if (LINEAR_DEFAULT_OFFER_NAMES.has(name)) {
    return true;
  }
  const nouns = getNamedLinearDeepNouns(prompt);
  return nouns.some((noun) =>
    (LINEAR_NOUN_TOOL_FRAGMENTS[noun] ?? []).some((fragment) =>
      name.includes(fragment),
    ),
  );
}

export function getOfferedGitHubCatalogReadToolNames(
  prompt: string,
): GitHubCatalogToolName[] {
  const existing = getGitHubCatalogReadToolNames(prompt);
  if (existing.length > 0) {
    return existing;
  }
  if (!hasGitHubPrOrIssueRefIntent(prompt)) {
    return [];
  }
  const names = new Set<GitHubCatalogToolName>();
  if (/\b(?:pull\s+requests?|prs?)\b/i.test(prompt)) {
    names.add("github_get_pull_request");
  }
  if (/\bissues?\b/i.test(prompt)) {
    names.add("github_get_issue");
  }
  return [...names];
}

export function hasGitHubCatalogOfferIntent(prompt: string): boolean {
  return (
    hasExplicitGitHubCatalogIntent(prompt) ||
    getOfferedGitHubCatalogReadToolNames(prompt).length > 0
  );
}

export function isGitHubCatalogToolOfferedForMission(
  name: string,
  prompt: string,
): boolean {
  if (!isGitHubCatalogToolName(name)) {
    return false;
  }
  const mutationNames = new Set(
    getExplicitGitHubCatalogMutationToolNames(prompt),
  );
  if (mutationNames.size > 0) {
    return mutationNames.has(name);
  }
  return getOfferedGitHubCatalogReadToolNames(prompt).includes(name);
}

function isCodeToolAllowedForPrompt(
  toolName: string,
  prompt: string,
  routedCodeToolNames: ReadonlySet<string> = new Set(),
): boolean {
  if (
    /\b(install(?:ing|ed)?|dependency|dependencies|lockfile|bootstrap|restore)\b/i.test(
      prompt,
    ) === false &&
    toolName === "install_code_dependency"
  ) {
    return false;
  }
  if (toolName === "code_workspace_move") {
    return hasAffirmativeCodePathAction(prompt, /\b(?:rename|move)\b/iu);
  }
  if (toolName === "code_workspace_copy") {
    return hasAffirmativeCodePathAction(prompt, /\b(?:copy|duplicate)\b/iu);
  }
  if (toolName === "code_workspace_trash") {
    return hasAffirmativeCodePathAction(prompt, /\b(?:remove|delete|trash)\b/iu);
  }
  if (toolName === "code_workspace_restore") {
    return hasAffirmativeCodePathAction(prompt, /\brestore\b/iu);
  }
  if (routedCodeToolNames.has(toolName)) {
    return true;
  }
  if (
    hasRepositoryCodeMutationIntent(prompt) ||
    hasStandaloneCodeExecutionIntent(prompt) ||
    hasCodeDeliverableIntent(prompt) ||
    detectProjectLifecycleStagesV1(prompt).includes("code_execution")
  ) {
    return true;
  }
  const explicit = getExplicitCodeToolNamesSafe(prompt);
  if (explicit.length > 0) {
    return explicit.includes(toolName);
  }
  return CODE_READ_ONLY_TOOL_NAMES.has(toolName);
}

function getExplicitCodeToolNamesSafe(prompt: string): string[] {
  const normalized = prompt.toLowerCase();
  const matches: Array<{ name: string; index: number }> = [];
  const seen = new Set<string>();
  for (const match of normalized.matchAll(/[a-z][a-z0-9_]*/gu)) {
    const name = match[0];
    if (!CODE_TOOL_NAMES.has(name) || seen.has(name)) continue;
    seen.add(name);
    matches.push({ name, index: match.index ?? 0 });
  }
  return matches
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.name);
}

function isToolWithinAutonomyScope(
  name: string,
  prompt: string,
  intent: MissionIntent,
  reflex: ReflexDecision | null = null,
): boolean {
  const scope = intent.autonomyScope;
  if (intent.explicitMutation && isBroadUnscopedVaultMutation(scope)) {
    return !WRITE_TOOL_NAMES.has(name) && !DELETE_TOOL_NAMES.has(name);
  }

  if (
    name === "web_search" ||
    name === "web_fetch" ||
    name === "read_source_section"
  ) {
    return (
      scope.read.web ||
      hasCheckpointResumeIntent(prompt) ||
      hasMissionResumeIntent(prompt) ||
      hasSafeReflexLabel(reflex, ["web_research"])
    );
  }

  if (name === APPEND_JUPYTER_REFLECTION_TOOL_NAME) {
    return hasJupyterReflectionIntentV1(prompt);
  }

  if (name === WRITE_PROJECT_RESULTS_TOOL_NAME) {
    return (
      detectProjectLifecycleStagesV1(prompt).includes("reflection") &&
      !hasJupyterReflectionIntentV1(prompt)
    );
  }

  if (name === "append_research_memory" || name === "compact_research_memory") {
    return scope.write.researchMemory;
  }

  if (name === "delete_research_memory_entry") {
    return scope.write.researchMemory && intent.explicitDelete;
  }

  if (
    name === "open_web_source" ||
    name === "create_design_canvas" ||
    name === "update_design_canvas" ||
    name === "create_svg_design" ||
    name === "update_svg_design" ||
    name === "upsert_mermaid_block" ||
    name === "create_design_package"
  ) {
    return scope.write.artifacts;
  }

  if (name === "export_workspace_artifact") {
    return scope.write.artifacts || hasCodeExecutionIntent(prompt);
  }

  if (BROWSER_TOOL_NAMES.has(name)) {
    return scope.read.web;
  }

  if (MEMORY_TOOL_NAMES.has(name)) {
    return name === "memory_search"
      ? true
      : scope.write.researchMemory &&
          (!DELETE_TOOL_NAMES.has(name) || intent.explicitDelete);
  }

  if (name === "replace_current_file") {
    return currentNoteReplaceCatalogEligible(scope);
  }

  if (name === "delete_current_file") {
    return scope.destructive.deleteCurrentNote;
  }

  if (name === "delete_path") {
    return scope.destructive.deletePaths;
  }

  if (
    name === "append_to_current_file" ||
    name === "append_to_current_section" ||
    name === "highlight_current_file_phrase" ||
    name === "restore_current_file_from_backup" ||
    name === "prepare_edit_current_section" ||
    name === "edit_current_section" ||
    name === "rename_current_file" ||
    name === "retitle_current_file" ||
    name === "link_related_notes_in_current_file"
  ) {
    return currentNoteAppendCatalogEligible(scope);
  }

  return true;
}

export function isAllowedForMission(
  name: string,
  prompt: string,
  intent: MissionIntent,
  reflex: ReflexDecision | null = null,
  routedCodeToolNames: ReadonlySet<string> = new Set(),
): boolean {
  if (!isToolWithinAutonomyScope(name, prompt, intent, reflex)) {
    return false;
  }

  if (name === ASK_USER_TOOL_NAME) {
    return false;
  }

  if (name === "analyze_dataset") {
    return hasDatasetAnalysisIntent(prompt);
  }
  if (name === "verify_citation" || name === "resolve_citation") {
    return hasCitationVerifyResolveOfferIntent(prompt);
  }
  if (name === "export_bibtex") {
    return hasCitationWorkIntent(prompt);
  }
  if (name === EXTRACT_DOCUMENT_TOOL_NAME) {
    return hasDocumentExtractIntent(prompt);
  }
  if (name === "read_mermaid_block" || name === "upsert_mermaid_block") {
    return shouldOfferMermaidBlock(prompt);
  }
  if (name === "create_file") {
    return (
      shouldOfferCreateFile(prompt) &&
      (intent.noteOutput ||
        intent.explicitMutation ||
        hasResearchMemoryWriteIntent(prompt))
    );
  }
  if (name.startsWith("linear_")) {
    return isLinearToolOfferedForMission(name, prompt);
  }
  if (isGitHubCatalogToolName(name)) {
    return isGitHubCatalogToolOfferedForMission(name, prompt);
  }

  if (READ_NAV_TOOL_NAMES.has(name)) {
    return (
      intent.vaultContext ||
      hasVaultBrowseIntent(prompt) ||
      hasParallelVaultReadIntentSafe(prompt) ||
      hasSpecificFileReadIntent(prompt) ||
      hasCurrentNoteReadIntent(prompt) ||
      hasWordCountIntent(prompt) ||
      hasGraphConnectionIntent(prompt) ||
      hasConceptualVaultSearchIntentSafe(prompt) ||
      hasTemplateIntent(prompt) ||
      hasResearchMemoryIntent(prompt) ||
      hasExperienceMemoryIntent(prompt) ||
      hasVaultIndexIntent(prompt) ||
      hasDesignIntent(prompt) ||
      hasBrowserAutomationIntent(prompt) ||
      hasCheckpointResumeIntent(prompt) ||
      hasMissionResumeIntent(prompt) ||
      hasSafeReflexLabel(reflex, [
        "vault_search",
        "semantic_vault_search",
        "graph_context",
        "word_count",
      ]) ||
      intent.noteOutput ||
      intent.explicitMutation
    );
  }

  if (DELETE_TOOL_NAMES.has(name)) {
    return intent.explicitDelete;
  }

  if (WRITE_TOOL_NAMES.has(name)) {
    if (name === APPEND_JUPYTER_REFLECTION_TOOL_NAME) {
      return hasJupyterReflectionIntentV1(prompt);
    }

    if (name === "rebuild_semantic_index") {
      return hasSemanticIndexMaintenanceIntentSafe(prompt);
    }

    if (name === "open_web_source") {
      return hasOpenWebSourceIntent(prompt);
    }

    if (
      name === "create_design_canvas" ||
      name === "create_svg_design" ||
      name === "create_design_package"
    ) {
      return hasDesignIntent(prompt);
    }

    if (name === "update_design_canvas" || name === "update_svg_design") {
      return hasReviseDesignIntent(prompt);
    }

    if (name === "export_workspace_artifact") {
      return hasCodeExecutionIntent(prompt) || hasHtmlPreviewIntent(prompt);
    }

    if (MEMORY_TOOL_NAMES.has(name)) {
      return (
        hasExperienceMemoryIntent(prompt) || hasResearchMemoryWriteIntent(prompt)
      );
    }

    if (name === "compact_research_memory") {
      return hasResearchMemoryCompactIntent(prompt);
    }

    return (
      intent.noteOutput ||
      intent.explicitMutation ||
      hasResearchMemoryWriteIntent(prompt)
    );
  }

  if (
    name === "web_search" ||
    name === "web_fetch" ||
    name === "read_source_section"
  ) {
    return (
      hasWebSearchIntent(prompt) ||
      hasCheckpointResumeIntent(prompt) ||
      hasMissionResumeIntent(prompt) ||
      hasSafeReflexLabel(reflex, ["web_research"])
    );
  }

  if (BROWSER_TOOL_NAMES.has(name)) {
    return hasBrowserAutomationIntent(prompt);
  }

  if (CODE_TOOL_NAMES.has(name)) {
    if (name === "code_validate_commit_prepared") {
      return hasPreparedBackgroundCodeValidationCommitIntent(prompt);
    }
    return (
      (hasCodeExecutionIntent(prompt) ||
        detectProjectLifecycleStagesV1(prompt).includes("code_execution") ||
        hasCodeWorkspaceReadIntent(prompt) ||
        getExplicitCodeToolNamesSafe(prompt).length > 0 ||
        routedCodeToolNames.size > 0 ||
        hasHtmlPreviewIntent(prompt)) &&
      isCodeToolAllowedForPrompt(name, prompt, routedCodeToolNames)
    );
  }

  return true;
}

function hasParallelVaultReadIntentSafe(prompt: string): boolean {
  return (
    /\bparallel\b[\s\S]{0,100}\b(?:vault\s+)?reads?\b/i.test(prompt) ||
    /\b(?:vault\s+)?reads?\b[\s\S]{0,100}\bparallel\b/i.test(prompt) ||
    /\bparallel\s+(?:read[-\s]?only\s+)?tools?\b/i.test(prompt)
  );
}

function hasConceptualVaultSearchIntentSafe(prompt: string): boolean {
  if (
    hasSpecificFileReadIntent(prompt)
  ) {
    return false;
  }
  return (
    /\b(what|where|find|search|show|list)\b[\s\S]{0,80}\b(my\s+)?notes?\b[\s\S]{0,80}\b(about|mention|mentions|reference|references|related\s+to)\b/i.test(
      prompt,
    ) ||
    hasGraphConnectionIntent(prompt) ||
    /\b(my\s+)?notes?\b[\s\S]{0,120}\b(idea|ideas|concepts?|themes?|topics?|memory|memories|relationships?|connections?|similar|related|about)\b/i.test(
      prompt,
    ) ||
    /\b(find|search|show|surface|retrieve)\b[\s\S]{0,120}\b(idea|ideas|concepts?|themes?|topics?|memory|memories|relationships?|connections?|similar|related)\b/i.test(
      prompt,
    )
  );
}

function hasSemanticIndexMaintenanceIntentSafe(prompt: string): boolean {
  return /\b(rebuild|refresh|update|regenerate|repair|create)\b[\s\S]{0,120}\bsemantic\s+(vault\s+)?index\b|\bsemantic\s+(vault\s+)?index\b[\s\S]{0,120}\b(rebuild|refresh|update|regenerate|repair|create)\b/i.test(
    prompt,
  );
}

export function measureCitationVerifyResolveOfferRate(
  prompts: readonly string[],
  intent: MissionIntent,
): { offered: number; total: number; pct: number } {
  let offered = 0;
  for (const prompt of prompts) {
    if (
      isAllowedForMission("verify_citation", prompt, intent) ||
      isAllowedForMission("resolve_citation", prompt, intent)
    ) {
      offered += 1;
    }
  }
  const total = prompts.length;
  return {
    offered,
    total,
    pct: total === 0 ? 0 : (offered / total) * 100,
  };
}
