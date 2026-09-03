import type { ModelToolDefinition } from "../model/types";
import { type MissionGraphV3 } from "../../packages/headless-runtime/src/missionGraphV3";
import {
  mapRunRouteToSchemaRoute,
  schemasForLifecycleStage,
  schemasForStep,
} from "./toolSchemaPolicy";
import { PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME } from "../tools/researchPublicationTool";
import {
  effectClassForTool,
  filterToolNamesByMaxEffectClass,
  type AutonomyEffectClass,
} from "./autonomyEffectClass";
import { CODE_EXECUTION_TOOL_ALLOW } from "./lifecycleStagePolicy";
import {
  formatStagePromptProjection,
  projectStagePrompt,
} from "./stagePromptProjection";
import {
  findFinalMissionGraphNode,
  isOptionalMissionGraphNode,
  missionGraphNodeIsTerminalV1,
} from "./missionGraphAuthority";
// Shared selector authorities — these MUST come from missionGraphSelectors,
// never re-inlined here: private copies of the frontier-tool and lifecycle
// selectors are exactly the second-authority drift the shared-classifier
// convention exists to prevent.
import {
  authoritativeRefusalFrontierToolNamesV1,
  getMissionGraphNodeFrontierToolNames,
  getSafeMissionCompositeLifecycleSpecV1,
  getSafeMissionCompositeLifecycleStateV1,
  missionGraphOnlyFinalSynthesisRemainsV1,
  missionGraphPlannedSequenceAfterFrontierV1,
} from "./missionGraphSelectors";
import {
  flattenMissionPlanTasks,
  type MissionPlanLike,
} from "./missionPlan";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWriteToolName(toolName: string): boolean {
  return (
    isRequiredCodeWorkflowToolName(toolName) ||
    toolName === "create_folder" ||
    toolName === "open_web_source" ||
    toolName === "create_design_canvas" ||
    toolName === "update_design_canvas" ||
    toolName === "create_svg_design" ||
    toolName === "update_svg_design" ||
    toolName === "upsert_mermaid_block" ||
    toolName === "create_design_package" ||
    toolName === "export_workspace_artifact" ||
    toolName === "code_workspace_export_directory" ||
    toolName === "seed_default_templates" ||
    toolName === "create_template" ||
    toolName === "fill_template" ||
    toolName === "create_research_pack" ||
    toolName === "create_file" ||
    toolName === "append_file" ||
    toolName === "replace_file" ||
    toolName === "move_path" ||
    toolName === "delete_path" ||
    toolName === "append_to_current_file" ||
    toolName === "append_to_current_section" ||
    toolName === "highlight_current_file_phrase" ||
    toolName === "restore_current_file_from_backup" ||
    toolName === "append_research_memory" ||
    toolName === "compact_research_memory" ||
    toolName === "delete_research_memory_entry" ||
    toolName === "rename_current_file" ||
    toolName === "retitle_current_file" ||
    toolName === "edit_current_section" ||
    toolName === "replace_current_file" ||
    toolName === "delete_current_file" ||
    toolName === "link_related_notes_in_current_file"
  );
}

const CODE_WORKFLOW_OBSERVATION_TOOL_NAMES = new Set<string>([
  "code_sandbox_status",
  "code_workspace_status",
  "code_workspace_read",
  "code_workspace_stat",
  "code_workspace_list",
  "code_workspace_search",
  "code_repair_status",
  "read_workspace_file",
  "list_workspace_files",
  "preview_workspace_html",
]);

/**
 * A repository implementation can legitimately discover additional files
 * after the immutable graph is planned (most importantly after an independent
 * Linear issue read). These mutations remain inside the existing code-stage
 * capability envelope, prepared-action approval, durable workspace binding,
 * repository write scope, and run budgets.
 */
const CODE_WORKFLOW_ADAPTIVE_MUTATION_TOOL_NAMES = new Set<string>([
  "code_workspace_mkdir",
  "code_workspace_create_file",
  "code_workspace_append",
  "code_workspace_patch",
  "code_workspace_write_expected",
]);

const VALIDATION_RECOVERY_DIAGNOSTIC_TOOL_NAMES = new Set<string>([
  "code_workspace_read",
  "code_workspace_stat",
  "code_workspace_list",
  "code_workspace_search",
]);

const VALIDATION_RECOVERY_MUTATION_TOOL_NAMES = new Set<string>([
  "code_workspace_create_file",
  "code_workspace_append",
  "code_workspace_patch",
  "code_workspace_write_expected",
]);

export interface ActiveValidationRecoveryFrontierV1 {
  validationNodeId: string;
  fastNodeId: string;
  repairNodeId: string;
  status: "awaiting_correction" | "correction_recorded";
}

/**
 * A queued targeted/full validator may carry one host-authored recovery gate.
 * The gate stays active only until its referenced repair receipt completes;
 * later targeted/full graph nodes then resume ordinary dependency authority.
 */
export function getActiveValidationRecoveryFrontierV1(
  graph: MissionGraphV3 | null | undefined,
): ActiveValidationRecoveryFrontierV1 | null {
  if (!graph) return null;
  for (const node of Object.values(graph.nodes)) {
    if (node.status !== "queued") continue;
    const raw = node.outputs?.validationRecovery;
    if (!isRecord(raw)) continue;
    const status = raw.status;
    const fastNodeId = raw.fastNodeId;
    const repairNodeId = raw.repairNodeId;
    if (
      (status !== "awaiting_correction" &&
        status !== "correction_recorded") ||
      typeof fastNodeId !== "string" ||
      typeof repairNodeId !== "string" ||
      graph.nodes[repairNodeId]?.status === "complete"
    ) {
      continue;
    }
    return {
      validationNodeId: node.id,
      fastNodeId,
      repairNodeId,
      status,
    };
  }
  return null;
}

export function isAdaptiveCodeWorkspaceMutationToolNameV1(
  toolName: string,
): boolean {
  return CODE_WORKFLOW_ADAPTIVE_MUTATION_TOOL_NAMES.has(toolName);
}

/**
 * Structural slice of a durable run receipt sufficient to prove one verified
 * workspace creation. Declared structurally so the frontier does not import
 * the runner's receipt type (AgentRunner already imports this module).
 */
export interface WorkspaceCreateReceiptShapeV1 {
  toolName: string;
  commitKind?: string | null;
  readback?: { status?: string | null } | null;
  resource?: { system?: string | null } | null;
  output?: unknown;
}

/**
 * True when a durable receipt proves the mission's workspace was created over
 * an adopted repository — and therefore already contained seeded files at
 * creation time. The planner cannot know this (the graph is planned before
 * code_workspace_create runs), so the creation receipt's repositoryWriteScope
 * is the earliest host-verified proof that planned write targets may already
 * exist. A scratch workspace is empty at creation and never satisfies this.
 */
export function workspaceCreateReceiptProvesSeededFilesV1(
  receipt: WorkspaceCreateReceiptShapeV1,
): boolean {
  if (
    receipt.toolName !== "code_workspace_create" ||
    (receipt.commitKind !== "committed" &&
      receipt.commitKind !== "reconciled") ||
    receipt.readback?.status !== "verified" ||
    receipt.resource?.system !== "workspace"
  ) {
    return false;
  }
  const output = isRecord(receipt.output) ? receipt.output : null;
  const scope =
    output && isRecord(output.repositoryWriteScope)
      ? output.repositoryWriteScope
      : null;
  return Boolean(
    scope && Array.isArray(scope.projects) && scope.projects.length > 0,
  );
}

/**
 * Shared seeded-file widening predicate (production and tests must consume
 * this one function; never re-derive the expression). When the planned write
 * frontier pins code_workspace_append over a workspace that verifiably held
 * seeded files at creation time, code_workspace_patch must stay on the menu
 * alongside the append: replacing seeded placeholder content is not
 * expressible with append, and withholding patch sent a live model into a
 * thinking spiral over an unsatisfiable instruction. This widens only the
 * node-level menu — mirroring how the collision repair pair is offered — and
 * grants no new Bound/Hard authority (code_workspace_patch is already inside
 * CODE_IMPLEMENTATION_TOOL_ALLOW and the prepared-mutation path still governs
 * the call). A pinned write over a not-yet-existing file (scratch workspace,
 * no repository adoption) is unchanged.
 */
export function pinnedAppendFrontierRequiresSeededFilePatchV1(
  pinnedWriteToolNames: ReadonlySet<string>,
  durableReceipts: readonly WorkspaceCreateReceiptShapeV1[],
): boolean {
  return (
    pinnedWriteToolNames.has("code_workspace_append") &&
    !pinnedWriteToolNames.has("code_workspace_patch") &&
    durableReceipts.some(workspaceCreateReceiptProvesSeededFilesV1)
  );
}

/**
 * While a ready/running node pins one exact workspace mutation (a planned
 * code_workspace_append, for example), sibling adaptive mutations are noise
 * rather than freedom: a model that writes the same file through
 * code_workspace_create_file succeeds at the tool level but leaves the planned
 * node ready forever, and every validator gated behind it is deferred. Observed
 * live on deepseek-v4-pro: twenty steps of create_file / write_expected /
 * status calls against an 18-tool menu while tool-05-code_workspace_append
 * stayed ready, until the segment budget expired. Offer only the pinned
 * write(s) until that node completes; the adaptive companions return as soon
 * as no ready node names a specific workspace mutation.
 */
export function narrowAdaptiveCodeMutationsToPlannedWritesV1(
  tools: ModelToolDefinition[],
  graph:
    | Pick<MissionGraphV3, "nodes">
    | {
        nodes: Record<
          string,
          {
            status: string;
            allowedTools: readonly string[];
            attempts?: number;
            retries?: { attempts?: number };
          }
        >;
      }
    | null
    | undefined,
  durableReceipts: readonly WorkspaceCreateReceiptShapeV1[] = [],
): ModelToolDefinition[] {
  if (!graph) return tools;
  // A red validation deliberately opens the diagnostic + mutation recovery
  // set. Pinning inside that window would remove the correction tools the
  // repair cycle exists to offer.
  if (
    getActiveValidationRecoveryFrontierV1(
      graph as MissionGraphV3,
    ) !== null
  ) {
    return tools;
  }
  const pinned = new Set<string>();
  for (const node of Object.values(graph.nodes)) {
    if (node.status !== "ready" && node.status !== "running") continue;
    const names = getMissionGraphNodeFrontierToolNames(
      node as MissionGraphV3["nodes"][string],
    ).filter((toolName) =>
      CODE_WORKFLOW_ADAPTIVE_MUTATION_TOOL_NAMES.has(toolName),
    );
    if (names.length === 0) continue;
    // The real graph nests attempts under retries; UI/E2E projections flatten
    // it. A pinned tool that already failed must not stay pinned: its own
    // error names a sibling as the remedy (patch -> create_file,
    // create_file -> write_expected), and pinning that remedy out of the menu
    // is exactly how a recoverable step becomes a dead end.
    const attempts =
      (node as { retries?: { attempts?: number } }).retries?.attempts ??
      (node as { attempts?: number }).attempts ??
      0;
    if (attempts > 0) return tools;
    for (const toolName of names) pinned.add(toolName);
  }
  if (pinned.size === 0) return tools;
  // Seeded-file widening: a pinned append over a repository-seeded workspace
  // keeps patch as its companion (see the shared predicate's contract).
  if (pinnedAppendFrontierRequiresSeededFilePatchV1(pinned, durableReceipts)) {
    pinned.add("code_workspace_patch");
  }
  return tools.filter(
    (tool) =>
      !CODE_WORKFLOW_ADAPTIVE_MUTATION_TOOL_NAMES.has(tool.function.name) ||
      pinned.has(tool.function.name),
  );
}

function filterValidationRecoveryToolNamesV1(
  toolNames: readonly string[],
  graph: MissionGraphV3,
): string[] | null {
  const recovery = getActiveValidationRecoveryFrontierV1(graph);
  if (!recovery) return null;
  if (recovery.status === "correction_recorded") {
    const fastNode = graph.nodes[recovery.fastNodeId];
    return fastNode &&
      (fastNode.status === "ready" || fastNode.status === "running") &&
      toolNames.includes("code_validate_fast")
      ? ["code_validate_fast"]
      : [];
  }
  return toolNames.filter(
    (toolName) =>
      VALIDATION_RECOVERY_DIAGNOSTIC_TOOL_NAMES.has(toolName) ||
      VALIDATION_RECOVERY_MUTATION_TOOL_NAMES.has(toolName),
  );
}

const GENERIC_CURRENT_NOTE_WRITER_NAMES = new Set<string>([
  "append_to_current_file",
  "append_to_current_section",
  "replace_current_file",
  "edit_current_section",
]);

/**
 * The publication composite writes the accepted package and backlink itself.
 * Generic current-note writers remain valid only when the graph contains an
 * independently planned writer (for example, the later reflection node).
 */
export function missionGraphOwnsAcceptedResearchNoteWritebackV1(
  graph:
    | Pick<MissionGraphV3, "nodes">
    | {
        nodes: Record<string, { allowedTools: readonly string[] }>;
      }
    | null
    | undefined,
): boolean {
  if (!graph) return false;
  const toolNames = Object.values(graph.nodes).flatMap(
    (node) => node.allowedTools,
  );
  return (
    toolNames.includes(PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME) &&
    !toolNames.some(
      (toolName) =>
        toolName !== PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME &&
        GENERIC_CURRENT_NOTE_WRITER_NAMES.has(toolName),
    )
  );
}

/**
 * A code workspace is isolated from the base repository, but creating it,
 * editing it, validating it, recording a repair cycle, and committing it are
 * still required durable workflow actions. Keep those graph nodes in the
 * runner's required-operation set so a successful file write cannot end the
 * mission before validation and commit readback.
 */
function isRequiredCodeWorkflowToolName(toolName: string): boolean {
  return (
    (CODE_EXECUTION_TOOL_ALLOW as readonly string[]).includes(toolName) &&
    !CODE_WORKFLOW_OBSERVATION_TOOL_NAMES.has(toolName)
  );
}

function shouldSuppressOptionalMissionGraphFrontier(
  graph: MissionGraphV3,
): boolean {
  const final = findFinalMissionGraphNode(graph);
  if (
    !final ||
    (final.node.status !== "ready" &&
      final.node.status !== "running" &&
      final.node.status !== "complete")
  ) {
    return false;
  }
  return !Object.entries(graph.nodes).some(
    ([nodeId, node]) =>
      nodeId !== final.id &&
      !isOptionalMissionGraphNode(nodeId, node) &&
      (node.status === "ready" || node.status === "running") &&
      getMissionGraphNodeFrontierToolNames(node).length > 0,
  );
}

function getOptionalOnlyMissionGraphFrontierToolNames(
  graph: MissionGraphV3,
): Set<string> {
  if (!shouldSuppressOptionalMissionGraphFrontier(graph)) {
    return new Set();
  }
  const requiredNames = new Set<string>();
  const optionalNames = new Set<string>();
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node.status !== "ready" && node.status !== "running") continue;
    const target = isOptionalMissionGraphNode(nodeId, node)
      ? optionalNames
      : requiredNames;
    for (const toolName of getMissionGraphNodeFrontierToolNames(node)) {
      target.add(toolName);
    }
  }
  return new Set(
    [...optionalNames].filter((toolName) => !requiredNames.has(toolName)),
  );
}

function isNonterminalMissionGraphNode(
  node: MissionGraphV3["nodes"][string],
): boolean {
  return node.status !== "complete" && node.status !== "cancelled";
}

function getMissionGraphNodeRemainingToolNames(
  node: MissionGraphV3["nodes"][string],
): string[] {
  const lifecycle = getSafeMissionCompositeLifecycleSpecV1(node);
  if (!lifecycle) return [...node.allowedTools];
  const state = getSafeMissionCompositeLifecycleStateV1(node);
  return lifecycle.actions
    .slice(state?.actionCursor ?? 0)
    .map((action) => action.toolName);
}

const RESUME_EMPTY_FRONTIER_WRITE_TOOLS = new Set([
  "append_to_current_file",
  "replace_current_file",
  "edit_current_section",
  "append_to_current_section",
  "read_current_file",
  "count_words",
]);

export const PROOF_GATE_FORCED_GATHER_TOOL_NAMES = [
  "web_search",
  "web_fetch",
] as const;

/**
 * After a web/fetch-only proof-gated write hold, keep the held write visible
 * and add search/fetch from the catalog. Used by both the fresh frontier and
 * the Continue empty-frontier fallback so they cannot disagree.
 */
export function injectProofGateForcedGatherToolsV1<
  T extends { function: { name: string } },
>(
  offered: readonly T[],
  catalog: readonly T[],
  input: {
    injectWebTools?: boolean;
    heldWriteToolName?: string | null;
  } = {},
): T[] {
  if (!input.injectWebTools) return [...offered];
  const names = new Set(offered.map((tool) => tool.function.name));
  const extra: T[] = [];
  for (const name of PROOF_GATE_FORCED_GATHER_TOOL_NAMES) {
    if (names.has(name)) continue;
    const schema = catalog.find((tool) => tool.function.name === name);
    if (schema) extra.push(schema);
  }
  const held = input.heldWriteToolName?.trim();
  if (held && !names.has(held)) {
    const write = catalog.find((tool) => tool.function.name === held);
    if (write) extra.push(write);
  }
  return extra.length > 0 ? [...offered, ...extra] : [...offered];
}

/**
 * True when a required (non-optional, non-final) node already paid a tool.
 * A streaming writeback stub is only `final` (and maybe a tool-less dispatch),
 * so this stays false and resume can still offer current-note writes.
 * "Paid" demands proof, not just a status flip: a node marked complete with
 * neither evidence nor receipts proved nothing, so it cannot stand in for the
 * mission's required work.
 *
 * Exported as the ONE shared answer to "did the resumed graph already pay its
 * required work?": the empty-frontier fallback below and the resume splice
 * heal in AgentRunner must consult the same predicate, or the frontier and
 * the graph authority drift apart again (two-subsystems-disagree #14).
 */
export function graphHasCompletedRequiredMutation(
  graph: MissionGraphV3,
): boolean {
  return Object.entries(graph.nodes).some(([nodeId, node]) => {
    if (nodeId === "final" || isOptionalMissionGraphNode(nodeId, node)) {
      return false;
    }
    if (node.status !== "complete") {
      return false;
    }
    if (
      (node.evidence?.length ?? 0) === 0 &&
      (node.receipts?.length ?? 0) === 0
    ) {
      return false;
    }
    return (
      node.allowedTools.length > 0 ||
      getMissionGraphNodeFrontierToolNames(node).length > 0
    );
  });
}

/**
 * A proof-backed, tool-less final node is the terminal projection seat. Once
 * every required predecessor is terminal, neither optional graph nodes nor
 * unplanned set-loose Soft companions may reopen the model tool catalog.
 *
 * The completed-proof requirement preserves the interrupted streaming stub:
 * a bare final node still owes its write, so the empty-frontier write fallback
 * below remains reachable. This is the shared distinction between "finish the
 * answer" and "resume the missing mutation".
 */
export function missionGraphTerminalProjectionSealsToolFrontierV1(
  graph: MissionGraphV3 | null | undefined,
): boolean {
  if (!graph) return false;
  const final = findFinalMissionGraphNode(graph);
  if (
    !final ||
    final.node.allowedTools.length > 0 ||
    (final.node.status !== "ready" &&
      final.node.status !== "running" &&
      final.node.status !== "complete")
  ) {
    return false;
  }
  const requiredPredecessorStillOpen = Object.entries(graph.nodes).some(
    ([nodeId, node]) =>
      nodeId !== final.id &&
      !isOptionalMissionGraphNode(nodeId, node) &&
      !missionGraphNodeIsTerminalV1(node),
  );
  return (
    !requiredPredecessorStillOpen &&
    graphHasCompletedRequiredMutation(graph)
  );
}

/**
 * ONE shared answer to "may a final-only graph stand in for proven work?" —
 * inverted: true when it may NOT. A graph whose only open node is the
 * tool-less `final` while no completed required node carries real
 * receipts/evidence is a crash/stub shape that still OWES its mission's
 * work. Three seats must consult this same predicate or they deadlock each
 * other (two-subsystems-disagree #14/#16, proof-matrix
 * interrupted-continuation 2026-08-25):
 *  1. the loop decision must NOT treat the graph as "required tools
 *     satisfied" and force tool-less final synthesis;
 *  2. the resume splice heal must add the owed write node into the
 *     authority; and
 *  3. the empty-frontier fallback below may surface current-note writes
 *     ONLY in exactly this shape, so the offered menu never advertises a
 *     tool the graph authority would refuse.
 */
export function missionGraphFinalOnlyStubOwesRequiredWorkV1(
  graph: MissionGraphV3 | null | undefined,
): boolean {
  if (!graph) return false;
  return (
    missionGraphOnlyFinalSynthesisRemainsV1(graph) &&
    !graphHasCompletedRequiredMutation(graph)
  );
}

function graphHasCompletedCodeWorkspaceCreation(
  graph: MissionGraphV3 | null | undefined,
): boolean {
  if (!graph) return false;
  return Object.values(graph.nodes).some((node) => {
    const lifecycle = getSafeMissionCompositeLifecycleSpecV1(node);
    if (lifecycle) {
      const state = getSafeMissionCompositeLifecycleStateV1(node);
      const completed = new Set(state?.completedActionIds ?? []);
      return lifecycle.actions.some(
        (action) =>
          action.toolName === "code_workspace_create" &&
          completed.has(action.id),
      );
    }
    return (
      node.status === "complete" &&
      node.allowedTools.includes("code_workspace_create")
    );
  });
}

/**
 * A validation receipt proves one exact workspace hash index. Once the repair
 * cycle reaches the frontier, no adaptive mutation may race ahead of recording
 * that receipt: even a legitimate extra file would make the receipt stale.
 * After the cycle is recorded, adaptive edits may resume before the next fresh
 * validator.
 */
function graphHasActiveCodeRepairCycleFrontier(
  graph: MissionGraphV3 | null | undefined,
): boolean {
  if (!graph) return false;
  return Object.values(graph.nodes).some(
    (node) =>
      (node.status === "ready" || node.status === "running") &&
      getMissionGraphNodeFrontierToolNames(node).includes(
        "code_repair_record_cycle",
      ),
  );
}

function isAdaptiveCodeMutationCompanion(
  toolName: string,
  graph: MissionGraphV3 | null | undefined,
): boolean {
  return (
    CODE_WORKFLOW_ADAPTIVE_MUTATION_TOOL_NAMES.has(toolName) &&
    graphHasCompletedCodeWorkspaceCreation(graph) &&
    graphHasIncompleteCodeExecutionWork(graph) &&
    !graphHasActiveCodeRepairCycleFrontier(graph)
  );
}

function requiresCreatedCodeWorkspace(toolName: string): boolean {
  return (
    (toolName.startsWith("code_workspace_") &&
      toolName !== "code_workspace_create") ||
    toolName.startsWith("code_validate_") ||
    toolName.startsWith("code_repair_") ||
    toolName === "code_commit_verified" ||
    [
      "write_workspace_file",
      "read_workspace_file",
      "list_workspace_files",
      "replace_workspace_text",
      "preview_workspace_html",
      "export_workspace_artifact",
    ].includes(toolName)
  );
}

/**
 * Set-loose expands the stage catalog, but it must not turn that catalog into
 * execution authority. A queued/blocked graph node remains unavailable until
 * its dependencies promote it to ready. True unplanned Soft companions remain
 * available. Completed Bound/Hard nodes are one-shot proof and never re-enter
 * the model catalog; MissionGraphSession may still support a host-selected
 * continuation, but catalog projection must not invite one after completion.
 * The sole Bound exception is a bounded code-workspace edit discovered after
 * workspace creation (for example, a second artifact named by a verified
 * Linear issue). The exception pauses while a repair-cycle receipt is at the
 * frontier so that no edit can invalidate the exact validation it records.
 * The prepared mutation path and repository scope still govern that edit; this
 * function only makes the already-granted tool callable.
 */
export function filterSetLooseToolNamesByMissionGraphAuthority(
  toolNames: readonly string[],
  graph: MissionGraphV3 | null | undefined,
  options: { allowDynamicReadContinuation?: boolean } = {},
): string[] {
  const uniqueNames = [
    ...new Set(toolNames.map((name) => name.trim()).filter(Boolean)),
  ];
  if (!graph) return uniqueNames;
  if (graphHasActiveCodeRepairCycleFrontier(graph)) {
    return uniqueNames.includes("code_repair_record_cycle")
      ? ["code_repair_record_cycle"]
      : [];
  }
  const validationRecoveryNames = filterValidationRecoveryToolNamesV1(
    uniqueNames,
    graph,
  );
  if (validationRecoveryNames) return validationRecoveryNames;

  const nodes = Object.values(graph.nodes);
  const readyOrRunningNames = new Set(
    nodes
      .filter(
        (node) => node.status === "ready" || node.status === "running",
      )
      .flatMap((node) => getMissionGraphNodeFrontierToolNames(node)),
  );
  const pendingNames = new Set(
    nodes
      .filter(isNonterminalMissionGraphNode)
      .flatMap(getMissionGraphNodeRemainingToolNames),
  );
  const workspaceCreateIncomplete = pendingNames.has("code_workspace_create");
  const compositeOwnsCurrentNote =
    missionGraphOwnsAcceptedResearchNoteWritebackV1(graph);

  return uniqueNames.filter((toolName) => {
    if (
      compositeOwnsCurrentNote &&
      GENERIC_CURRENT_NOTE_WRITER_NAMES.has(toolName)
    ) {
      return false;
    }
    if (readyOrRunningNames.has(toolName)) return true;
    if (pendingNames.has(toolName)) return false;
    if (isAdaptiveCodeMutationCompanion(toolName, graph)) return true;
    if (
      workspaceCreateIncomplete &&
      requiresCreatedCodeWorkspace(toolName)
    ) {
      return false;
    }
    if (CODE_WORKFLOW_OBSERVATION_TOOL_NAMES.has(toolName)) {
      // These do not need a dynamic read node. They are named explicitly in
      // mayBypassMissionGraphStartForSetLooseSoftCompanion, which grants them
      // a graph-start bypass — but only when they are offered, so dropping
      // them from the menu silently disables their own authority path. They
      // are also the read half of every hash-bound mutation and the only
      // escape from a collision, so an implementation frontier without them
      // offers writes whose preconditions cannot be inspected.
      return true;
    }
    if (effectClassForTool(toolName) === "soft") {
      // A genuinely unplanned Soft companion is callable only because
      // MissionGraphSession will materialize a bounded dynamic read node for
      // it. On an exact planned frontier it will not: beginToolExecution
      // refuses with "not ready in the exact authoritative mission graph".
      // Offering it anyway advertises a menu on which nothing is callable, and
      // a model with no other way to discover that enumerates the whole list
      // one refused call at a time.
      return options.allowDynamicReadContinuation !== false;
    }
    return false;
  });
}

/**
 * The runner may continue after a graph-start rejection only for a genuinely
 * unplanned Soft companion. It also permits the same bounded adaptive
 * code-workspace mutations projected above after the workspace-create action
 * is durably complete. Planned nonterminal tools and every other Bound/Hard
 * tool still fail closed on the authoritative MissionGraph result.
 *
 * The exported name is retained for compatibility with persisted callers.
 */
export function mayBypassMissionGraphStartForSetLooseSoftCompanion(
  toolName: string,
  offeredToolNames: ReadonlySet<string> | readonly string[],
  graph: MissionGraphV3 | null | undefined,
): boolean {
  const normalized = toolName.trim();
  const offeredSet = offeredToolNames as ReadonlySet<string>;
  const offered =
    typeof offeredSet.has === "function"
      ? offeredSet.has(normalized)
      : (offeredToolNames as readonly string[]).includes(normalized);
  const adaptiveCodeMutation = isAdaptiveCodeMutationCompanion(
    normalized,
    graph,
  );
  if (
    !offered ||
    (effectClassForTool(normalized) !== "soft" &&
      !CODE_WORKFLOW_OBSERVATION_TOOL_NAMES.has(normalized) &&
      !adaptiveCodeMutation)
  ) {
    return false;
  }
  if (!graph) return true;
  if (
    missionGraphOwnsAcceptedResearchNoteWritebackV1(graph) &&
    GENERIC_CURRENT_NOTE_WRITER_NAMES.has(normalized)
  ) {
    return false;
  }
  return !Object.values(graph.nodes).some(
    (node) =>
      isNonterminalMissionGraphNode(node) &&
      getMissionGraphNodeRemainingToolNames(node).includes(normalized),
  );
}

/** True when the graph still has incomplete nodes that authorize code_* tools. */
function graphHasIncompleteCodeExecutionWork(
  graph: MissionGraphV3 | null | undefined,
): boolean {
  if (!graph) return false;
  return Object.values(graph.nodes).some((node) => {
    if (node.status === "complete" || node.status === "cancelled") {
      return false;
    }
    return node.allowedTools.some((toolName) => toolName.startsWith("code_"));
  });
}

function getMissionGraphNodePendingWriteToolNames(
  node: MissionGraphV3["nodes"][string],
): string[] {
  const lifecycle = getSafeMissionCompositeLifecycleSpecV1(node);
  if (!lifecycle) {
    return node.allowedTools.filter(isWriteToolName);
  }
  const state = getSafeMissionCompositeLifecycleStateV1(node);
  return lifecycle.actions
    .slice(state?.actionCursor ?? 0)
    .filter((action) => action.effect !== "read")
    .map((action) => action.toolName);
}

export function constrainToolsToMissionGraphFrontier(
  tools: ModelToolDefinition[],
  graph: MissionGraphV3 | null | undefined,
  options: {
    includeCapabilityReads?: boolean;
    /**
     * Mirrors AgentRunner's `beginMissionGraphTool` gate. The offered menu and
     * the authority that admits calls from it must read one answer, or the run
     * advertises tools every one of which is refused.
     */
    allowDynamicReadContinuation?: boolean;
    route?: string;
    maxEffectClassWithoutGrant?: AutonomyEffectClass;
    /**
     * Set-loose compound: expand offered tools to the stage Soft-union instead
     * of a single ready-node tool name.
     */
    setLooseOfferedToolNames?: readonly string[] | null;
    /**
     * After a web/fetch-only proof-gated write hold: keep the held write and
     * inject search/fetch on both the fresh frontier and the Continue
     * empty-frontier fallback.
     */
    proofGateForcedGather?: {
      injectWebTools?: boolean;
      heldWriteToolName?: string | null;
    };
  } = {},
): ModelToolDefinition[] {
  const applyEffectClass = (
    schemas: ModelToolDefinition[],
    opts: { respectMaxEffectClass: boolean } = { respectMaxEffectClass: true },
  ) => {
    const max = options.maxEffectClassWithoutGrant;
    // MissionGraph frontiers already authorize Bound/Hard tools (approval broker
    // still gates execution). Soft maxEffectClassWithoutGrant must not strip
    // linear_*/github_* nodes when the host authored a graph.
    let next = schemas;
    if (max && opts.respectMaxEffectClass) {
      const allowed = new Set(
        filterToolNamesByMaxEffectClass(
          schemas.map((schema) => schema.function.name),
          max,
        ),
      );
      next = schemas.filter((schema) => allowed.has(schema.function.name));
    }
    return injectProofGateForcedGatherToolsV1(
      next,
      tools,
      options.proofGateForcedGather ?? {},
    );
  };

  let setLooseNames = (options.setLooseOfferedToolNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  const suppressOptionalFrontier =
    graph !== null &&
    graph !== undefined &&
    shouldSuppressOptionalMissionGraphFrontier(graph);
  // Terminal projection is a closed frontier, not another set-loose phase.
  // Without this early seal the Soft-union branch below re-advertises reads
  // after the loop has already decided `force_final_no_tools`; each completed
  // read then materializes another dynamic retry node and the verified final
  // draft is never allowed to terminate the run.
  if (missionGraphTerminalProjectionSealsToolFrontierV1(graph)) {
    return [];
  }
  if (graph && suppressOptionalFrontier && setLooseNames.length > 0) {
    const optionalOnlyNames =
      getOptionalOnlyMissionGraphFrontierToolNames(graph);
    setLooseNames = setLooseNames.filter(
      (toolName) => !optionalOnlyNames.has(toolName),
    );
  }
  if (setLooseNames.length > 0) {
    // Belt-and-suspenders: always union tools from ready/running MissionGraph
    // nodes into the set-loose callable set so Soft-union cannot strand a
    // required Soft gate (e.g. read_template before linear_create_issue).
    if (graph) {
      for (const [nodeId, node] of Object.entries(graph.nodes)) {
        if (node.status !== "ready" && node.status !== "running") continue;
        if (
          suppressOptionalFrontier &&
          isOptionalMissionGraphNode(nodeId, node)
        ) {
          continue;
        }
        for (const toolName of getMissionGraphNodeFrontierToolNames(node)) {
          const trimmed = toolName.trim();
          if (trimmed) setLooseNames.push(trimmed);
        }
      }
    }
    const setLooseCallable =
      filterSetLooseToolNamesByMissionGraphAuthority(setLooseNames, graph, {
      allowDynamicReadContinuation: options.allowDynamicReadContinuation,
    });
    const setLooseConstrained = schemasForLifecycleStage({
      callableToolNames: setLooseCallable,
      allSchemas: tools,
    }) as ModelToolDefinition[];
    // Never fall through to exact MissionGraph frontier under set-loose.
    // An empty intersection means the catalog was over-shrunk; keep whatever
    // Soft companions remain in the catalog rather than trapping on one ready node.
    if (setLooseConstrained.length > 0) {
      return applyEffectClass(setLooseConstrained, {
        respectMaxEffectClass: false,
      });
    }
    // Prefer the canonical code allowlist over Soft companions alone when the
    // Soft-union intended code tools or the graph still has unpaid code work.
    const dependencySafeCodeFallback = new Set(
      filterSetLooseToolNamesByMissionGraphAuthority(
        CODE_EXECUTION_TOOL_ALLOW,
        graph,
      ),
    );
    const codeFallback = tools.filter((tool) =>
      dependencySafeCodeFallback.has(tool.function.name),
    );
    const setLooseWantedCode = setLooseNames.some((name) =>
      name.startsWith("code_"),
    );
    if (
      codeFallback.length > 0 &&
      (setLooseWantedCode || graphHasIncompleteCodeExecutionWork(graph))
    ) {
      return applyEffectClass(codeFallback, {
        respectMaxEffectClass: false,
      });
    }
    const dependencySafeSoftFallback = new Set(
      filterSetLooseToolNamesByMissionGraphAuthority(
        tools.map((tool) => tool.function.name),
        graph,
      ),
    );
    const softFallback = tools.filter(
      (tool) =>
        dependencySafeSoftFallback.has(tool.function.name) &&
        /^(web_|read_|list_|search_|semantic_|find_related|get_note_graph|append_to_current|replace_current|count_words)/u.test(
          tool.function.name,
        ),
    );
    if (softFallback.length > 0) {
      return applyEffectClass(softFallback, {
        respectMaxEffectClass: false,
      });
    }
  }

  if (graph) {
    const validationRecoveryNames = filterValidationRecoveryToolNamesV1(
      tools.map((tool) => tool.function.name),
      graph,
    );
    if (validationRecoveryNames) {
      const allowed = new Set(validationRecoveryNames);
      return applyEffectClass(
        tools.filter((tool) => allowed.has(tool.function.name)),
        { respectMaxEffectClass: false },
      );
    }
  }

  if (!graph) {
    // Without a MissionGraph frontier, drop Linear/GitHub catalog noise on
    // note/research/vault routes — but do not collapse the vault mutation
    // catalog through an empty-frontier schemasForStep whitelist (that would
    // strand create_file / append_file / delete_path / install_* missions).
    if (!options.route) {
      return applyEffectClass(tools);
    }
    const schemaRoute = mapRunRouteToSchemaRoute(options.route);
    if (
      schemaRoute !== "current_note" &&
      schemaRoute !== "research" &&
      schemaRoute !== "vault"
    ) {
      return applyEffectClass(tools);
    }
    return applyEffectClass(
      tools.filter((tool) => {
        const name = tool.function.name;
        return !/^(linear_|github_)/u.test(name);
      }),
    );
  }
  // Include running nodes so an orphaned begin (host returned without finish)
  // does not empty the offered frontier. beginToolExecution heals running→ready
  // before starting again.
  const frontierNames = new Set(
    Object.entries(graph.nodes)
      .filter(
        ([nodeId, node]) =>
          (node.status === "ready" || node.status === "running") &&
          !(
            suppressOptionalFrontier &&
            isOptionalMissionGraphNode(nodeId, node)
          ),
      )
      .flatMap(([, node]) => getMissionGraphNodeFrontierToolNames(node)),
  );
  if (
    options.includeCapabilityReads &&
    !suppressOptionalFrontier &&
    !graphHasActiveCodeRepairCycleFrontier(graph)
  ) {
    for (const [toolName, grant] of Object.entries(
      graph.capabilityEnvelope.tools,
    )) {
      if (grant.effect === "read") {
        frontierNames.add(toolName);
      }
    }
  }
  const frontierConstrained = tools.filter((tool) =>
    frontierNames.has(tool.function.name),
  );
  // A ready tool-less `final` node is the streaming-writeback stub. Resume
  // cannot re-stream blindly, and filtering the catalog down to that empty
  // frontier before schemasForStep makes route-base writes unreachable — the
  // model is offered nothing and the two-append continuation dies in two
  // empty turns (proof-matrix interrupted-continuation, 2026-08-25).
  // Gated on the SHARED stub-owes-work predicate: any other empty frontier
  // (for example a blocked write node) must stay empty here, because the
  // graph authority would refuse the resurrected tool and the offered menu
  // must never disagree with the authority's verdict.
  if (
    frontierConstrained.length === 0 &&
    missionGraphFinalOnlyStubOwesRequiredWorkV1(graph)
  ) {
    // The fallback exists ONLY to surface current-note writes on the resumed
    // streaming stub. schemasForStep can widen past its frontier input (route
    // bases, empty-menu safety), so the result must be re-intersected with
    // the write set — otherwise any empty frontier (for example a blocked
    // create-collision node) would resurrect the very tool the graph just
    // refused.
    const emptyFrontierNames = new Set(RESUME_EMPTY_FRONTIER_WRITE_TOOLS);
    if (options.proofGateForcedGather?.injectWebTools) {
      for (const name of PROOF_GATE_FORCED_GATHER_TOOL_NAMES) {
        emptyFrontierNames.add(name);
      }
    }
    const fallback = (
      schemasForStep({
        route: options.route ?? "single_model_writeback",
        frontier: tools
          .map((tool) => tool.function.name)
          .filter((name) => emptyFrontierNames.has(name)),
        graphRequired: [],
        allSchemas: tools,
      }) as ModelToolDefinition[]
    ).filter((tool) => emptyFrontierNames.has(tool.function.name));
    if (fallback.length > 0) {
      return applyEffectClass(fallback, { respectMaxEffectClass: false });
    }
  }
  if (!options.route) {
    return applyEffectClass(frontierConstrained, {
      respectMaxEffectClass: false,
    });
  }
  // Second pass: keep only route-base ∪ frontier ∪ graph-required names to
  // shrink cloud/local schema noise (drops Linear/GitHub on note routes).
  const graphRequired = Object.entries(graph.nodes)
    .filter(
      ([nodeId, node]) =>
        (node.status === "ready" || node.status === "running") &&
        !(
          suppressOptionalFrontier &&
          isOptionalMissionGraphNode(nodeId, node)
        ),
    )
    .flatMap(([, node]) => node.allowedTools);
  return applyEffectClass(
    schemasForStep({
      route: options.route,
      frontier: [...frontierNames],
      graphRequired,
      allSchemas: frontierConstrained,
    }) as ModelToolDefinition[],
    { respectMaxEffectClass: false },
  );
}

/**
 * Tool names the current mission still requires: allowedTools plus frontier
 * tool names of every ready/running MissionGraph node, plus the allowedTools
 * of every incomplete mission-plan task. Shared input for
 * `enforcePhaseToolMenuCeilingV1` — the phase menu ceiling must never drop
 * one of these, or the offered menu could not finish the mission's own next
 * step (observed: rename_current_file capped out of a rename-then-research
 * mission whose plan demanded it on turn one).
 */
export function getPhaseCeilingProtectedToolNamesV1(
  graph: MissionGraphV3 | null | undefined,
  missionPlan?: MissionPlanLike | null,
): string[] {
  const names = new Set<string>();
  const add = (toolName: string) => {
    const trimmed = toolName.trim();
    if (trimmed) names.add(trimmed);
  };
  if (graph) {
    for (const node of Object.values(graph.nodes)) {
      // Every incomplete node's tools are mission-authored requirements, not
      // catalog noise: pending read nodes (e.g. get_note_graph_context) enter
      // the offered menu through capability reads before their node is ready,
      // and the ceiling must not evict what the graph will demand next.
      if (node.status === "complete" || node.status === "cancelled") continue;
      for (const toolName of node.allowedTools) add(toolName);
      for (const toolName of getMissionGraphNodeFrontierToolNames(node)) {
        add(toolName);
      }
    }
  }
  if (missionPlan) {
    for (const task of flattenMissionPlanTasks(missionPlan)) {
      if (task.status === "complete" || task.status === "blocked") continue;
      for (const toolName of task.allowedTools) add(toolName);
    }
  }
  return [...names];
}

export function getPendingMissionGraphWriteToolNames(
  graph: MissionGraphV3 | null | undefined,
): string[] {
  if (!graph) return [];
  return [
    ...new Set(
      Object.entries(graph.nodes)
        .filter(
          ([nodeId, node]) =>
            !isOptionalMissionGraphNode(nodeId, node) &&
            node.status !== "complete" &&
            node.status !== "cancelled",
        )
        .flatMap(([, node]) => getMissionGraphNodePendingWriteToolNames(node))
        .filter((toolName) => toolName !== "append_research_memory"),
    ),
  ];
}

/**
 * Nonterminal owed-write nodes the resume heal spliced into the graph
 * (`resume-current-note-write`, `resume-current-note-write-N`). A healed
 * multi-append continuation carries one such node per still-missing required
 * marker; the write mission must not close while any remains open, or the
 * accepted final would cancel it over unpaid work. Deliberately narrower
 * than getPendingMissionGraphWriteToolNames: planned workflows keep their
 * historical completion semantics (a satisfied required write may close the
 * mission with optional steps unread), only the heal's exactly-once nodes
 * hold it open.
 */
export function getPendingResumeOwedWriteNodeIds(
  graph: MissionGraphV3 | null | undefined,
): string[] {
  if (!graph) return [];
  return Object.values(graph.nodes)
    .filter(
      (node) =>
        node.id.startsWith("resume-current-note-write") &&
        node.status !== "complete" &&
        node.status !== "cancelled",
    )
    .map((node) => node.id);
}

/**
 * The one line that tells a model on a one-tool frontier what the mission is
 * going to ask for after this call, so it stops reaching for step eleven on
 * step one.
 *
 * Hard rules, because a "what comes later" list on the same turn as a "call
 * this now" list is one careless sentence away from becoming instance #18 of
 * two-subsystems-disagree:
 *   - every name here is one the authority WILL refuse right now, guaranteed by
 *     `missionGraphPlannedSequenceAfterFrontierV1` excluding the ready/running
 *     frontier;
 *   - the prose says so in the same breath as the names, and repeats the one
 *     callable instruction afterwards, so the nearest imperative to the tool
 *     list is still "call the ready tool";
 *   - fail closed: no pending names, or no ready names to contrast them with,
 *     emits nothing.
 *
 * Capped, because the sequence is prompt context and a fifty-node repair graph
 * must not push the actual instruction out of the window.
 */
export const MISSION_GRAPH_PLANNED_SEQUENCE_MAX_NAMES_V1 = 10;

export function formatMissionGraphPlannedSequenceLineV1(input: {
  readyToolNames: readonly string[];
  laterToolNames: readonly string[];
}): string | null {
  const ready = input.readyToolNames.map((name) => name.trim()).filter(Boolean);
  const later = input.laterToolNames.map((name) => name.trim()).filter(Boolean);
  if (ready.length === 0 || later.length === 0) return null;
  const shown = later.slice(0, MISSION_GRAPH_PLANNED_SEQUENCE_MAX_NAMES_V1);
  const overflow = later.length - shown.length;
  return [
    `PLANNED SEQUENCE: this mission still owes ${later.length} later step(s), in this order: ${shown.join(" -> ")}${overflow > 0 ? ` -> (+${overflow} more)` : ""}.`,
    "None of those are callable yet; each one opens only after the step before it produces its receipt. Calling one now is refused and costs a step.",
    `Callable on this turn: ${ready.join(", ")}. Call one of those exact names now — the rest of the mission is planned and will be offered to you in turn.`,
  ].join("\n");
}

export function buildMissionGraphFrontierTurnContext(
  stepTools: readonly ModelToolDefinition[],
  observedBinding: string | null = null,
  options: {
    setLoose?: boolean;
    currentStage?: string | null;
    stageBudgetBlock?: string | null;
    resolvedRepositoryVisibility?: "public" | "private" | null;
    /**
     * The authoritative mission graph, used ONLY to derive the planned-sequence
     * steering line. It never widens, narrows, or reorders the offered menu:
     * `stepTools` remains the sole source of what the model may call.
     */
    graph?: MissionGraphV3 | null;
  } = {},
): string {
  const names = stepTools.map((tool) => tool.function.name);
  const stageProjection = formatStagePromptProjection(
    projectStagePrompt({
      stage: options.currentStage ?? null,
      setLoose: options.setLoose === true,
      callableTools: names,
      observedBinding,
      budgetLine: options.stageBudgetBlock ?? null,
      resolvedRepositoryVisibility:
        options.resolvedRepositoryVisibility ?? null,
    }),
  );
  const codeCapabilityBoundary = names.some((name) => name.startsWith("code_"))
    ? [
        "This is one dependency-ready code-workflow frontier, not the full Code capability catalog.",
        "Code workspaces are real directories on the user's local filesystem. Later dependency-ready frontiers can open file creation, sandbox validation, and approval-gated delivery beside the active vault by default or to an explicitly named Desktop, Documents, or Downloads folder.",
        "Do not claim filesystem access, file creation, validation, or export is unavailable merely because a later Code tool is not callable on this turn. Call only the Code tools listed in the current frontier.",
      ]
    : [];
  const setLooseAcceptedResearchBoundary =
    options.setLoose === true &&
    options.currentStage === "accepted_research" &&
    names.includes(PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME)
      ? [
          "For publish_research_to_linear, arguments.package must use the exact accepted-research fields from the tool schema.",
          "proposedWork, scope, acceptanceCriteria, and validationRequirementKeys are nonempty JSON arrays. Even one proposedWork item must be written as [\"...\"]; never send a bare string, object, null, or empty array.",
          "nonGoals and dependencies are JSON arrays and may be []. Use only the exact schema enum values and do not nest project or hierarchy fields.",
        ]
      : [];
  if (options.setLoose === true) {
    // Durable set-loose turns stay stage-local: objective + evidence + tools.
    // Bulky routing/git/spec cards concatenated by the host are stripped inside
    // projectStagePrompt rather than re-emitted into the model context.
    return [
      stageProjection,
      "Return exactly one tool call in this response. The host commits one lifecycle action and recalculates the frontier after every receipt, so batching a second call would use stale authority even when both names are listed now.",
      ...setLooseAcceptedResearchBoundary,
      ...codeCapabilityBoundary,
    ].join("\n");
  }
  const acceptedResearchBoundary =
    names.length === 1 && names[0] === PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME
      ? [
          "This frontier accepts only the accepted-research note package and its one Linear publication issue.",
          "Set arguments.mode to the exact JSON string \"create\" for a new note path requested by the mission and omit baseHash entirely. Use the exact string \"append\" only after reading an existing note and supplying its baseHash. Never send an empty baseHash placeholder, and never use write, overwrite, upsert, create_or_append, or any combined mode label.",
          "Inside arguments.package, place these fields directly: schemaVersion, title, problemImpact, evidence, confidenceLimitations, proposedWork, nonGoals, scope, dependencies, acceptanceCriteria, validationRequirementKeys, riskClass, executionClass, objective, and optional repositoryKey.",
          "proposedWork, scope, acceptanceCriteria, and validationRequirementKeys must each contain at least one item; nonGoals and dependencies may be empty arrays.",
          "Use only the exact riskClass values low, medium, or high. Use only the exact executionClass values research, vault, code, or human.",
          "Do not add research, initiativeKey, projectKey, issueKey, issueTitle, initiative, project, issues, or plan here; publish_research_project_to_linear is a separate later frontier.",
          "For repository-bound implementation research, use executionClass=code and the exact trusted repositoryKey from the mission.",
        ]
      : [];
  const researchHierarchyBoundary =
    names.length === 1 && names[0] === "publish_research_project_to_linear"
      ? [
          "This frontier accepts only the Linear initiative, project, and issue hierarchy for the already accepted research.",
          "initiative and project must each contain nonempty key, title, and description fields. Use title, not name; the host canonicalizes a lone compatible name alias only for provider compatibility.",
          "Do not copy the trusted local repository root into Linear prose; the host owns that binding. Relative Obsidian/repository paths and non-executed validation command names may appear in issue requirements.",
          "For every issue, dependencyKeys must be a JSON array of logical issue keys; use [] when it has no dependency. acceptanceCriteria must be a nonempty JSON array of plain strings.",
          "If the same mission continues through implementation, validation, GitHub publication, and Results reflection, create exactly one delivery issue and express its independently measurable units as acceptanceCriteria. Multi-issue hierarchies are supported only when each child will be executed and verified in a separate run.",
          "Omit workItemFingerprint; the host derives it from the accepted research binding and canonical issue content. Do not nest an accepted-research package here.",
        ]
      : [];
  const linearIssueReadBoundary =
    names.length === 1 && names[0] === "linear_get_issue"
      ? [
          "Use the exact implementation issue ID or identifier returned by the completed Linear hierarchy dependency.",
          "This is an independent provider readback. Do not substitute the initiative or project, and do not invent an ID from the mission text.",
        ]
      : [];
  const writeExpectedBoundary =
    names.length === 1 && names[0] === "code_workspace_write_expected"
      ? [
          "This frontier accepts only code_workspace_write_expected for the bound workspace path.",
          "Do not call code_workspace_patch, code_workspace_create_file, code_workspace_read, or code_validate_* until this correction completes.",
          "Use the exact path and expectedSha256 from the turn context when shown. Prefer lineReplacements or preserveCurrent when instructed; otherwise send one complete content replacement that fixes the latest validator failure.",
        ]
      : [];
  const workspaceReadBoundary =
    names.length === 1 && names[0] === "code_workspace_read"
      ? [
          "This frontier accepts only code_workspace_read for the bound path.",
          "Call it now. Do not invent patch, write_expected, validate, Linear, or GitHub tools while only a read is ready.",
          "Correction writes open only after the scheduled reads finish; then call code_workspace_write_expected when it appears.",
        ]
      : [];
  const sandboxStatusBoundary =
    names.length === 1 && names[0] === "code_sandbox_status"
      ? [
          "This is the first code-workflow checkpoint, not the full capability catalog.",
          "Call code_sandbox_status now. The next frontier will open code_workspace_create; later frontiers open nested file creation, validation, and any user-authorized directory export.",
          "Do not answer that file creation is unavailable merely because later tools are not callable on this turn.",
        ]
      : [];
  const workspaceCreateBoundary =
    names.length === 1 && names[0] === "code_workspace_create"
      ? [
          "This is the writable-workspace bootstrap frontier, not the final deliverable.",
          "Call code_workspace_create now. For a new standalone app or script, use kind=scratch and one stable workspaceId.",
          "After the creation receipt, code_workspace_mkdir and code_workspace_create_file become callable. create_file accepts a safe path at any depth and automatically creates missing parent directories.",
          "For every new standalone project, keep working in the workspace until the approval-gated code_workspace_export_directory frontier opens after the project files and validation steps. It defaults beside the active vault; an explicitly named Desktop, Documents, or Downloads folder overrides that default.",
          "Do not return code-only chat prose or claim filesystem tools are unavailable while this bootstrap action is ready.",
        ]
      : [];
  const workspaceCreateFileBoundary =
    names.length === 1 && names[0] === "code_workspace_create_file"
      ? [
          "Create the complete bound file now. A safe nested path such as src/game/ui/checkers.py is supported in one call; missing parent directories are created automatically.",
          "Do not substitute chat-only code for this receipt-backed workspace write.",
        ]
      : [];
  const workspaceExportBoundary =
    names.length === 1 && names[0] === "code_workspace_export_directory"
      ? [
          "This frontier performs the user-requested host delivery after workspace creation.",
          "Use destinationRoot vault_sibling_projects for the default standalone-project delivery beside the active vault. Use desktop, documents, or downloads only when the foreground user explicitly names that folder. Choose a safe project-relative destinationPath; the exact destination is shown for approval and must remain absent.",
          "The export preserves nested directories and never overwrites existing files or folders.",
        ]
      : [];
  // Steering only, and only on the exact planned frontier — the branch that is
  // one tool wide by construction and where `allowDynamicReadContinuation` is
  // false by definition (`missionGraphRunAdmitsDynamicReadContinuationV1`), so
  // the authority-admitted intersection below is exact rather than a
  // fail-closed under-report. The set-loose branch returned above keeps its
  // stage-local projection untouched.
  const plannedSequenceLine = formatMissionGraphPlannedSequenceLineV1({
    readyToolNames: authoritativeRefusalFrontierToolNamesV1({
      graph: options.graph ?? null,
      candidateToolNames: names,
      allowDynamicReadContinuation: false,
    }),
    laterToolNames: missionGraphPlannedSequenceAfterFrontierV1(
      options.graph ?? null,
    ),
  });
  const toolContractLines = [
    ...(plannedSequenceLine ? [plannedSequenceLine] : []),
    ...codeCapabilityBoundary,
    ...acceptedResearchBoundary,
    ...researchHierarchyBoundary,
    ...linearIssueReadBoundary,
    ...writeExpectedBoundary,
    ...workspaceReadBoundary,
    ...sandboxStatusBoundary,
    ...workspaceCreateBoundary,
    ...workspaceCreateFileBoundary,
    ...workspaceExportBoundary,
  ];
  // Exact frontiers keep one-tool contracts, but still use the stage projection
  // frame instead of echoing the full observed binding blob.
  return [stageProjection, ...toolContractLines].filter(Boolean).join("\n");
}
