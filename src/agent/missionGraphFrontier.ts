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
  filterToolNamesByMaxEffectClass,
  type AutonomyEffectClass,
} from "./autonomyEffectClass";
import { CODE_EXECUTION_TOOL_ALLOW } from "./lifecycleStagePolicy";
import {
  formatStagePromptProjection,
  projectStagePrompt,
} from "./stagePromptProjection";

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
]);

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

  const setLooseNames = (options.setLooseOfferedToolNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  if (setLooseNames.length > 0) {
    // Belt-and-suspenders: always union tools from ready/running MissionGraph
    // nodes into the set-loose callable set so Soft-union cannot strand a
    // required Soft gate (e.g. read_template before linear_create_issue).
    if (graph) {
      for (const node of Object.values(graph.nodes)) {
        if (node.status !== "ready" && node.status !== "running") continue;
        for (const toolName of getMissionGraphNodeFrontierToolNames(node)) {
          const trimmed = toolName.trim();
          if (trimmed) setLooseNames.push(trimmed);
        }
      }
    }
    const setLooseCallable = [...new Set(setLooseNames)];
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
    const codeAllow = new Set<string>(CODE_EXECUTION_TOOL_ALLOW);
    const codeFallback = tools.filter((tool) =>
      codeAllow.has(tool.function.name),
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
    const softFallback = tools.filter((tool) =>
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
    Object.values(graph.nodes)
      .filter(
        (node) => node.status === "ready" || node.status === "running",
      )
      .flatMap((node) => getMissionGraphNodeFrontierToolNames(node)),
  );
  if (options.includeCapabilityReads) {
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
  const graphRequired = Object.values(graph.nodes)
    .filter((node) => node.status === "ready" || node.status === "running")
    .flatMap((node) => node.allowedTools);
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
      Object.values(graph.nodes)
        .filter(
          (node) =>
            node.status !== "complete" && node.status !== "cancelled",
        )
        .flatMap((node) => getMissionGraphNodePendingWriteToolNames(node))
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
  if (options.setLoose === true) {
    // Durable set-loose turns stay stage-local: objective + evidence + tools.
    // Bulky routing/git/spec cards concatenated by the host are stripped inside
    // projectStagePrompt rather than re-emitted into the model context.
    return stageProjection;
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
  const toolContractLines = [
    ...acceptedResearchBoundary,
    ...researchHierarchyBoundary,
    ...linearIssueReadBoundary,
    ...writeExpectedBoundary,
    ...workspaceReadBoundary,
  ];
  // Exact frontiers keep one-tool contracts, but still use the stage projection
  // frame instead of echoing the full observed binding blob.
  return [stageProjection, ...toolContractLines].filter(Boolean).join("\n");
}
