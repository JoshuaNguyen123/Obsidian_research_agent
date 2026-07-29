import type { ModelToolDefinition } from "../model/types";
import {
  getCurrentMissionCompositeLifecycleActionV1,
  getMissionCompositeLifecycleSpecV1,
  getMissionCompositeLifecycleStateV1,
  type MissionGraphV3,
} from "../../packages/headless-runtime/src/missionGraphV3";
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
} from "./missionGraphAuthority";

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

function getSafeMissionCompositeLifecycleSpecV1(
  node: MissionGraphV3["nodes"][string],
) {
  return isRecord(node.inputs) && node.inputs.lifecycle
    ? getMissionCompositeLifecycleSpecV1(node)
    : null;
}

function getSafeMissionCompositeLifecycleStateV1(
  node: MissionGraphV3["nodes"][string],
) {
  return getSafeMissionCompositeLifecycleSpecV1(node) && isRecord(node.outputs)
    ? getMissionCompositeLifecycleStateV1(node)
    : null;
}

function getSafeMissionCompositeLifecycleActionV1(
  node: MissionGraphV3["nodes"][string],
) {
  return getSafeMissionCompositeLifecycleSpecV1(node) && isRecord(node.outputs)
    ? getCurrentMissionCompositeLifecycleActionV1(node)
    : null;
}

function getMissionGraphNodeFrontierToolNames(
  node: MissionGraphV3["nodes"][string],
): string[] {
  const action = getSafeMissionCompositeLifecycleActionV1(node);
  return action ? [action.toolName] : [...node.allowedTools];
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
    if (
      effectClassForTool(toolName) === "soft" ||
      CODE_WORKFLOW_OBSERVATION_TOOL_NAMES.has(toolName)
    ) {
      return true;
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
    route?: string;
    maxEffectClassWithoutGrant?: AutonomyEffectClass;
    /**
     * Set-loose compound: expand offered tools to the stage Soft-union instead
     * of a single ready-node tool name.
     */
    setLooseOfferedToolNames?: readonly string[] | null;
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
    if (!max || !opts.respectMaxEffectClass) return schemas;
    const allowed = new Set(
      filterToolNamesByMaxEffectClass(
        schemas.map((schema) => schema.function.name),
        max,
      ),
    );
    return schemas.filter((schema) => allowed.has(schema.function.name));
  };

  let setLooseNames = (options.setLooseOfferedToolNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  const suppressOptionalFrontier =
    graph !== null &&
    graph !== undefined &&
    shouldSuppressOptionalMissionGraphFrontier(graph);
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
      filterSetLooseToolNamesByMissionGraphAuthority(setLooseNames, graph);
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

export function buildMissionGraphFrontierTurnContext(
  stepTools: readonly ModelToolDefinition[],
  observedBinding: string | null = null,
  options: {
    setLoose?: boolean;
    currentStage?: string | null;
    stageBudgetBlock?: string | null;
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
    }),
  );
  const codeCapabilityBoundary = names.some((name) => name.startsWith("code_"))
    ? [
        "This is one dependency-ready code-workflow frontier, not the full Code capability catalog.",
        "Code workspaces are real directories on the user's local filesystem. Later dependency-ready frontiers can open file creation, sandbox validation, and user-authorized export to Desktop, Documents, or Downloads.",
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
          "If the foreground mission requests Desktop, Documents, or Downloads delivery, keep working in the workspace; the approval-gated code_workspace_export_directory frontier opens after the project files and validation steps.",
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
          "Use only the known destinationRoot explicitly named by the foreground user: desktop, documents, or downloads. Choose a safe project-relative destinationPath; the exact destination is shown for approval and must remain absent.",
          "The export preserves nested directories and never overwrites existing files or folders.",
        ]
      : [];
  const toolContractLines = [
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
