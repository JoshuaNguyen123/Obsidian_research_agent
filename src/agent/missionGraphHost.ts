import type { ToolRegistry } from "../tools/types";
import type { ToolDescriptor } from "./actions";
import { descriptorFor } from "../tools/toolDescriptors";
import {
  buildMissionCapabilityEnvelopeV1,
  MISSION_GRAPH_MAX_DEPTH,
  type MissionAuthorityEffectV1,
  type MissionBindingGrantV1,
  type MissionCapabilityEnvelopeV1,
  type MissionCompositeLifecycleActionV1,
  type MissionJsonValueV1,
  type MissionToolGrantV1,
} from "./missionGraphV3";
import type {
  DeterministicMissionGraphProposalV1,
  MissionGraphNodeProposalV1,
} from "./missionGraphPlanner";
import { sha256Fingerprint } from "../../packages/headless-runtime/src/canonicalize";
import {
  INSTALLED_HEADLESS_EXECUTOR_IDS_V1,
  INSTALLED_HEADLESS_TOOL_BY_DOMAIN_V1,
  type BackgroundExecutionDomainV1,
} from "../../packages/headless-runtime/src";
import {
  extractExplicitNewWorkspaceFilePaths,
  extractExplicitWorkspaceReadFilePaths,
  extractMarkdownPathMentions,
} from "./missionScope";
import {
  buildProjectLifecycleStageNodesV1,
  createProjectLifecycleIntentV1,
  detectProjectLifecycleStagesV1,
  type ProjectLifecycleIntentV1,
  type ProjectLifecycleStageV1,
} from "./projectLifecycle";

interface PlannedToolStepV1 {
  name: string;
  selector?: string;
  objective?: string;
}

interface CompositeLifecyclePlanV1 {
  intent: ProjectLifecycleIntentV1;
  stepsByStage: Map<ProjectLifecycleStageV1, PlannedToolStepV1[]>;
}

// Composite lifecycle stages deliberately collapse many exact actions into a
// small durable graph. Keep a separate, bounded node/call reserve for host-safe
// reads that are discovered after planning (for example the initial active-note
// observation). This reserve never adds a tool grant or an effectful action.
const COMPOSITE_SAFE_READ_CONTINUATION_RESERVE = 8;

export interface BuildHostMissionGraphPlanInput {
  missionId: string;
  objective: string;
  toolRegistry: ToolRegistry;
  allowedToolNames: Iterable<string>;
  /** Read tools actually exposed to the model on the current route. */
  modelVisibleToolNames?: Iterable<string>;
  plannedToolNames: Iterable<string>;
  /** Host-owned actions that may run only after result acceptance. */
  postAcceptanceToolNames?: Iterable<string>;
  currentNotePath?: string | null;
  maxToolCalls: number;
  maxWallClockMs: number;
  /** Bounded depth already required by a trusted persisted legacy plan. */
  minimumGraphDepth?: number;
  maxAttemptsPerNode?: number;
  now?: Date;
  background?: {
    installedDomains: BackgroundExecutionDomainV1[];
    preferBackground: boolean;
  };
  /** Exact host/extension readbacks applied before graph immutability begins. */
  bindingOverrides?: Readonly<Record<string, MissionBindingGrantV1>>;
}

export interface HostMissionGraphPlanV1 {
  capabilityEnvelope: MissionCapabilityEnvelopeV1;
  deterministicProposal: DeterministicMissionGraphProposalV1;
  projectLifecycleIntent: ProjectLifecycleIntentV1 | null;
  allowedToolDescriptors: Array<
    ToolDescriptor & { authorityEffect: MissionAuthorityEffectV1 }
  >;
}

/**
 * Converts the already-filtered host tool catalog into exact graph templates.
 * It never derives tools, paths, bindings, or authority from model content.
 */
export async function buildHostMissionGraphPlanV1(
  input: BuildHostMissionGraphPlanInput,
): Promise<HostMissionGraphPlanV1> {
  const issuedAt = (input.now ?? new Date()).toISOString();
  const allowedNames = sortedUnique([...input.allowedToolNames]);
  const descriptors = allowedNames.map((name) =>
    input.toolRegistry.getDescriptor?.(name) ?? descriptorFor(name),
  );
  const descriptorByName = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor] as const),
  );
  const modelVisibleNames = new Set(
    input.modelVisibleToolNames === undefined
      ? allowedNames
      : [...input.modelVisibleToolNames].filter((name) =>
          descriptorByName.has(name),
        ),
  );
  const explicitNewWorkspaceFilePaths =
    extractExplicitNewWorkspaceFilePaths(input.objective);
  const explicitWorkspaceReadFilePaths =
    extractExplicitWorkspaceReadFilePaths(input.objective);
  // Preserve deliberate read multiplicity: two bounded source fetches are two
  // separately budgeted graph nodes even though they use the same descriptor.
  // Effectful tools remain deduplicated except for the explicit Mermaid
  // upsert -> readback -> upsert revision lifecycle. The intervening readback
  // makes the second mutation a distinct, observable action rather than an
  // accidental duplicate introduced by overlapping host/router requirements.
  const seenEffectfulPlannedNames = new Set<string>();
  const basePlannedSteps: PlannedToolStepV1[] = [];
  for (const name of input.plannedToolNames) {
    const descriptor = descriptorByName.get(name);
    if (!descriptor) continue;
    if (descriptor.effect === "read") {
      basePlannedSteps.push({ name });
      continue;
    }
    const isVerifiedMermaidRevision =
      name === "upsert_mermaid_block" &&
      basePlannedSteps.at(-1)?.name === "read_mermaid_block";
    if (
      name === "code_workspace_create_file" &&
      explicitNewWorkspaceFilePaths.length > 0 &&
      !seenEffectfulPlannedNames.has(name)
    ) {
      seenEffectfulPlannedNames.add(name);
      basePlannedSteps.push(
        ...explicitNewWorkspaceFilePaths.map((path) => ({
          name,
          selector: path,
          objective: `Create the exact new workspace file ${path} without overwrite.`,
        })),
      );
      continue;
    }
    if (seenEffectfulPlannedNames.has(name) && !isVerifiedMermaidRevision) {
      continue;
    }
    seenEffectfulPlannedNames.add(name);
    basePlannedSteps.push({ name });
  }
  const plannedSteps = expandBoundedWorkspaceRepairReview({
    steps: basePlannedSteps,
    explicitNewWorkspaceFilePaths,
    explicitWorkspaceReadFilePaths,
    descriptorByName,
  });
  const compositeLifecyclePlan = buildCompositeLifecyclePlanV1({
    missionId: input.missionId,
    exactUserCommand: input.objective,
    requestedAt: issuedAt,
    steps: plannedSteps,
    descriptorByName,
  });
  const plannedSet = new Set(plannedSteps.map((step) => step.name));
  const maxToolNodes = MISSION_GRAPH_MAX_DEPTH - 1;
  if (!compositeLifecyclePlan && plannedSteps.length > maxToolNodes) {
    throw new Error(
      `The explicit code lifecycle requires ${plannedSteps.length} tool nodes, exceeding the bounded mission graph capacity of ${maxToolNodes}. Split it into smaller approved stages.`,
    );
  }
  const selectedPlanned = compositeLifecyclePlan
    ? plannedSteps
    : plannedSteps.slice(0, maxToolNodes);
  const maximumToolCallCapacity = compositeLifecyclePlan ? 10_000 : maxToolNodes;
  const maximumPostAcceptanceNodes = compositeLifecyclePlan
    ? Math.max(0, maxToolNodes - compositeLifecyclePlan.intent.stages.length)
    : Math.max(0, maxToolNodes - selectedPlanned.length);
  const postAcceptanceNames = unique([
    ...(input.postAcceptanceToolNames ?? []),
  ])
    .filter((name) => descriptorByName.has(name) && !plannedSet.has(name))
    .filter((name) => descriptorByName.get(name)?.effect !== "read")
    .slice(0, maximumPostAcceptanceNodes);
  const lifecycleStageCount = compositeLifecyclePlan?.intent.stages.length ?? 0;
  const mandatoryToolCallCount =
    selectedPlanned.length + postAcceptanceNames.length;
  const compositeBaseNodeCount = compositeLifecyclePlan
    ? lifecycleStageCount + postAcceptanceNames.length + 1
    : 0;
  const compositeSafeReadNodeReserveLimit = compositeLifecyclePlan
    ? Math.min(
        COMPOSITE_SAFE_READ_CONTINUATION_RESERVE,
        Math.max(0, MISSION_GRAPH_MAX_DEPTH - compositeBaseNodeCount),
      )
    : 0;
  const requestedToolCallCapacity = Number.isFinite(input.maxToolCalls)
    ? Math.max(0, Math.floor(input.maxToolCalls))
    : compositeLifecyclePlan
      ? mandatoryToolCallCount + compositeSafeReadNodeReserveLimit
      : maxToolNodes;
  const toolCallCapacity = Math.min(
    maximumToolCallCapacity,
    Math.max(
      selectedPlanned.length + postAcceptanceNames.length,
      requestedToolCallCapacity,
    ),
  );
  const compositeSafeReadContinuationReserve = compositeLifecyclePlan
    ? Math.min(
        compositeSafeReadNodeReserveLimit,
        Math.max(0, toolCallCapacity - mandatoryToolCallCount),
      )
    : 0;
  const optionalReadNames = allowedNames
    .filter((name) => !plannedSet.has(name) && !postAcceptanceNames.includes(name))
    // The capability envelope deliberately contains every host-safe read so a
    // later, journaled recovery/reclassification node can use it. Do not let
    // the structured planner select one of those dormant grants unless the
    // current route actually exposes the corresponding model tool.
    .filter((name) => modelVisibleNames.has(name))
    .filter((name) => descriptorByName.get(name)?.effect === "read")
    .filter(() => compositeLifecyclePlan === null)
    .slice(0, Math.max(0, toolCallCapacity - selectedPlanned.length));

  const capabilities = sortedUnique(
    descriptors.map((descriptor) => capabilityId(descriptor)),
  );
  const tools: Record<string, MissionToolGrantV1> = {};
  const bindings: Record<string, MissionBindingGrantV1> = {};
  const bindingIdByTool = new Map<string, string | null>();
  const effects = new Set<MissionAuthorityEffectV1>(["read"]);
  const backgroundDomains = new Set(input.background?.installedDomains ?? []);
  const headlessToolNames = new Set(
    descriptors
      .filter(
        (descriptor) =>
          backgroundDomainForTool(descriptor.name) !== null &&
          backgroundDomains.has(backgroundDomainForTool(descriptor.name)!) &&
          (graphEffect(descriptor) === "read" ||
            isExactBackgroundLinearStateUpdateDescriptor(descriptor) ||
            (isExactBackgroundCodeValidationCommitDescriptor(descriptor) &&
              Boolean(input.bindingOverrides?.[descriptor.name])) ||
            (isExactBackgroundGitHubPreparedDescriptor(descriptor) &&
              Boolean(input.bindingOverrides?.[descriptor.name]))),
      )
      .map((descriptor) => descriptor.name),
  );
  for (const descriptor of descriptors) {
    const effect = graphEffect(descriptor);
    effects.add(effect);
    const binding = await bindingForDescriptor(
      input.missionId,
      descriptor,
      input.bindingOverrides?.[descriptor.name],
    );
    if (binding) {
      const existing = bindings[binding.id];
      bindings[binding.id] = existing
        ? {
            ...existing,
            allowedEffects: sortedUnique([
              ...existing.allowedEffects,
              ...binding.allowedEffects,
            ]) as MissionAuthorityEffectV1[],
          }
          : binding;
    }
    bindingIdByTool.set(descriptor.name, binding?.id ?? null);
    tools[descriptor.name] = {
      name: descriptor.name,
      effect,
      capabilityIds: [capabilityId(descriptor)],
      executionHosts: headlessToolNames.has(descriptor.name)
        ? ["obsidian_core", "headless_runtime"]
        : ["obsidian_core"],
      bindingKinds: binding ? [binding.kind] : [],
    };
  }

  // Reserve bounded graph and wall-clock capacity for repeated approved reads
  // (for example, fetching multiple sources with the same descriptor). A
  // completed node remains immutable, so each repeat receives its own node.
  const maxNodes = compositeLifecyclePlan
    ? compositeBaseNodeCount + compositeSafeReadContinuationReserve
    : toolCallCapacity + 1;
  const totalCatalogToolCalls = toolCallCapacity;
  const budgetNodeCount = toolCallCapacity + 1;
  const graphWallClockMs = Math.max(
    Math.round(input.maxWallClockMs),
    budgetNodeCount * 1_000,
  );
  const toolNodeWallClockMs = missionGraphToolNodeWallClockMs(
    graphWallClockMs,
    toolCallCapacity,
  );
  const capabilityEnvelope = await buildMissionCapabilityEnvelopeV1({
    missionId: input.missionId,
    issuedAt,
    expiresAt: null,
    capabilities,
    executionHosts:
      headlessToolNames.size > 0
        ? ["obsidian_core", "headless_runtime"]
        : ["obsidian_core"],
    executors: {
      "single-agent": {
        id: "single-agent",
        executionHosts: ["obsidian_core"],
        allowedEffects: [...effects].sort(),
      },
      ...Object.fromEntries(
        [...backgroundDomains]
          .filter((domain) =>
            [...headlessToolNames].some(
              (name) => backgroundDomainForTool(name) === domain,
            ),
          )
          .map((domain) => [
            INSTALLED_HEADLESS_EXECUTOR_IDS_V1[domain],
            {
              id: INSTALLED_HEADLESS_EXECUTOR_IDS_V1[domain],
              executionHosts: ["headless_runtime" as const],
              allowedEffects: sortedUnique(
                descriptors
                  .filter(
                    (descriptor) =>
                      headlessToolNames.has(descriptor.name) &&
                      backgroundDomainForTool(descriptor.name) === domain,
                  )
                  .map((descriptor) => graphEffect(descriptor)),
              ) as MissionAuthorityEffectV1[],
            },
          ]),
      ),
    },
    verifiers: sortedUnique([
      "host-acceptance-v1",
      ...(descriptors.some(
        (descriptor) =>
          headlessToolNames.has(descriptor.name) &&
          (isExactBackgroundLinearStateUpdateDescriptor(descriptor) ||
            isExactBackgroundCodeValidationCommitDescriptor(descriptor) ||
            isExactBackgroundGitHubPreparedDescriptor(descriptor)),
      )
        ? ["companion-external-result-v1"]
        : []),
    ]),
    tools,
    bindings,
    budgets: {
      maxNodes,
      // Depth is route-derived rather than a permissive global constant. A
      // linear lifecycle may use one layer per planned tool plus finalization,
      // but can never exceed the immutable graph node ceiling.
      maxDepth: Math.min(
        MISSION_GRAPH_MAX_DEPTH,
        Math.max(
          compositeLifecyclePlan
            ? lifecycleStageCount + 1
            : selectedPlanned.length + 1,
          input.minimumGraphDepth ?? 1,
        ),
      ),
      maxConcurrentReadNodes: 3,
      maxTotalToolCalls: totalCatalogToolCalls,
      maxExternalActions: [
        ...selectedPlanned.map((step) => descriptorByName.get(step.name)!),
        ...postAcceptanceNames.map((name) => descriptorByName.get(name)!),
      ].filter((descriptor) => graphEffect(descriptor) === "external_action")
        .length,
      maxWallClockMs: graphWallClockMs,
      maxAttemptsPerNode: Math.max(
        1,
        Math.min(3, input.maxAttemptsPerNode ?? 3),
      ),
    },
  });

  const deterministicNodes = compositeLifecyclePlan
    ? buildCompositeLifecycleNodeProposalsV1({
        plan: compositeLifecyclePlan,
        missionObjective: input.objective,
        descriptorByName,
        currentNotePath: input.currentNotePath ?? null,
        maxAttempts: capabilityEnvelope.budgets.maxAttemptsPerNode,
        wallClockMsPerAction: toolNodeWallClockMs,
        bindingIdByTool,
      })
    : buildToolNodeProposals({
        steps: selectedPlanned,
        objective: input.objective,
        descriptorByName,
        currentNotePath: input.currentNotePath ?? null,
        maxAttempts: capabilityEnvelope.budgets.maxAttemptsPerNode,
        wallClockMs: toolNodeWallClockMs,
        headlessToolNames,
        preferBackground: input.background?.preferBackground === true,
        bindingIdByTool,
      });
  const optionalReadNodes = buildOptionalReadNodeProposals({
    names: optionalReadNames,
    descriptorByName,
    currentNotePath: input.currentNotePath ?? null,
    maxAttempts: capabilityEnvelope.budgets.maxAttemptsPerNode,
    wallClockMs: toolNodeWallClockMs,
    headlessToolNames,
    preferBackground: input.background?.preferBackground === true,
    bindingIdByTool,
  });
  addFinalNode(deterministicNodes, input.objective);
  addPostAcceptanceNodes({
    nodes: deterministicNodes,
    names: postAcceptanceNames,
    descriptorByName,
    currentNotePath: input.currentNotePath ?? null,
    maxAttempts: capabilityEnvelope.budgets.maxAttemptsPerNode,
    wallClockMs: toolNodeWallClockMs,
    headlessToolNames,
    preferBackground: input.background?.preferBackground === true,
    bindingIdByTool,
  });

  return {
    capabilityEnvelope,
    deterministicProposal: {
      nodes: deterministicNodes,
      ...(Object.keys(optionalReadNodes).length > 0
        ? { optionalReadNodes }
        : {}),
    },
    projectLifecycleIntent: compositeLifecyclePlan?.intent ?? null,
    allowedToolDescriptors: descriptors.map((descriptor) => ({
      ...descriptor,
      authorityEffect: graphEffect(descriptor),
    })),
  };
}

function addPostAcceptanceNodes(input: {
  nodes: Record<string, MissionGraphNodeProposalV1>;
  names: string[];
  descriptorByName: ReadonlyMap<string, ToolDescriptor>;
  currentNotePath: string | null;
  maxAttempts: number;
  wallClockMs: number;
  headlessToolNames: ReadonlySet<string>;
  preferBackground: boolean;
  bindingIdByTool: ReadonlyMap<string, string | null>;
}): void {
  const finalDependencies = [...(input.nodes.final?.dependencyIds ?? [])];
  input.names.forEach((name, index) => {
    const descriptor = input.descriptorByName.get(name)!;
    const node = proposalForTool({
      nodeId: `post-acceptance-${toolNodeId(index, name)}`,
      descriptor,
      dependencies: finalDependencies,
      currentNotePath: input.currentNotePath,
      maxAttempts: input.maxAttempts,
      wallClockMs: input.wallClockMs,
      headlessToolNames: input.headlessToolNames,
      preferBackground: input.preferBackground,
      bindingId: input.bindingIdByTool.get(name) ?? null,
    });
    input.nodes[node.id] = {
      ...node,
      objective: `After result acceptance, run host-authorized ${name}.`,
      completionContract: {
        criteria: [`${name} is reconciled through the action journal.`],
        minimumEvidence: 1,
        requiredEvidenceKinds: ["tool-result"],
        minimumReceipts: 0,
        requiredReceiptKinds: [],
        verifierId: null,
      },
    };
  });
}

function expandBoundedWorkspaceRepairReview(input: {
  steps: readonly PlannedToolStepV1[];
  explicitNewWorkspaceFilePaths: readonly string[];
  explicitWorkspaceReadFilePaths: readonly string[];
  descriptorByName: ReadonlyMap<string, ToolDescriptor>;
}): PlannedToolStepV1[] {
  const created = new Set(input.explicitNewWorkspaceFilePaths);
  const protectedReadPaths = input.explicitWorkspaceReadFilePaths.filter(
    (path) => !created.has(path),
  );
  const names = new Set(input.steps.map((step) => step.name));
  const requiredBaseNames = [
    "code_workspace_create",
    "code_workspace_create_file",
    "code_validate_fast",
    "code_repair_record_cycle",
    "code_validate_targeted",
    "code_validate_full",
    "code_commit_verified",
  ];
  const supportsBoundedReview =
    input.explicitNewWorkspaceFilePaths.length > 0 &&
    requiredBaseNames.every((name) => names.has(name)) &&
    input.descriptorByName.has("code_workspace_read") &&
    input.descriptorByName.has("code_workspace_write_expected");
  if (!supportsBoundedReview) return [...input.steps];

  const expanded: PlannedToolStepV1[] = [];
  let protectedReadsInserted = false;
  let correctionPassesInserted = false;
  const boundedCorrectionPass = (
    ordinal: "first" | "second",
    cycle: 2 | 3,
  ): PlannedToolStepV1[] => [
    ...input.explicitNewWorkspaceFilePaths.map((path) => ({
      name: "code_workspace_read",
      selector: path,
      objective: `Read the exact created workspace file ${path} for the ${ordinal} bounded correction pass.`,
    })),
    ...input.explicitNewWorkspaceFilePaths.map((path) => ({
      name: "code_workspace_write_expected",
      selector: path,
      objective: `Reconcile the exact workspace file ${path} against the accepted requirements, protected contract, and fast-validation evidence using its observed hash during the ${ordinal} bounded correction pass.`,
    })),
    {
      name: "code_validate_fast",
      objective: `Run bounded fast validation again after the ${ordinal} correction pass.`,
    },
    {
      name: "code_repair_record_cycle",
      objective: `Record repair-cycle checkpoint ${cycle} from the ${ordinal} corrected fast-validation evidence.`,
    },
  ];
  for (const step of input.steps) {
    expanded.push(step);
    if (step.name === "code_workspace_create" && !protectedReadsInserted) {
      protectedReadsInserted = true;
      expanded.push(
        ...protectedReadPaths.map((path) => ({
          name: "code_workspace_read",
          selector: path,
          objective: `Read the exact protected workspace contract ${path} before implementation.`,
        })),
      );
    }
    if (
      step.name === "code_repair_record_cycle" &&
      !correctionPassesInserted
    ) {
      correctionPassesInserted = true;
      expanded.push(
        ...boundedCorrectionPass("first", 2),
        ...boundedCorrectionPass("second", 3),
      );
    }
  }
  return expanded;
}

function buildCompositeLifecyclePlanV1(input: {
  missionId: string;
  exactUserCommand: string;
  requestedAt: string;
  steps: readonly PlannedToolStepV1[];
  descriptorByName: ReadonlyMap<string, ToolDescriptor>;
}): CompositeLifecyclePlanV1 | null {
  const stages = detectProjectLifecycleStagesV1(input.exactUserCommand);
  if (stages.length < 2 || input.steps.length === 0) return null;
  const stepsByStage = new Map<ProjectLifecycleStageV1, PlannedToolStepV1[]>(
    stages.map((stage) => [stage, []]),
  );
  for (const step of input.steps) {
    const descriptor = input.descriptorByName.get(step.name);
    const stage = descriptor
      ? projectLifecycleStageForToolV1(step.name, descriptor)
      : null;
    const stageSteps = stage ? stepsByStage.get(stage) : null;
    if (!stageSteps || stageSteps.length >= 128) return null;
    stageSteps.push(step);
  }
  if ([...stepsByStage.values()].some((steps) => steps.length === 0)) {
    return null;
  }
  return {
    intent: createProjectLifecycleIntentV1({
      runId: input.missionId,
      exactUserCommand: input.exactUserCommand,
      stages,
      requestedAt: input.requestedAt,
    }),
    stepsByStage,
  };
}

function projectLifecycleStageForToolV1(
  toolName: string,
  descriptor: ToolDescriptor,
): ProjectLifecycleStageV1 | null {
  const name = toolName.toLowerCase();
  if (
    /(?:cleanup|clean_up|delete|trash|archive|close|backlink|reconcile)/u.test(name)
  ) {
    return "reconciliation_cleanup";
  }
  if (name === "publish_research_to_linear") {
    return "accepted_research";
  }
  if (
    name === "publish_research_project_to_linear" ||
    name.startsWith("linear_") ||
    descriptor.capability.system === "linear"
  ) {
    return "linear_hierarchy";
  }
  if (
    name.startsWith("github_") ||
    descriptor.capability.system === "github"
  ) {
    return "private_github_publication";
  }
  if (
    name.startsWith("code_") ||
    [
      "workspace",
      "git",
    ].includes(descriptor.capability.system) ||
    [
      "run_code_block",
      "render_html_preview",
      "write_workspace_file",
      "read_workspace_file",
      "list_workspace_files",
      "replace_workspace_text",
      "preview_workspace_html",
      "export_workspace_artifact",
      "install_code_dependency",
    ].includes(name)
  ) {
    return "code_execution";
  }
  if (
    name.startsWith("web_") ||
    name.startsWith("browser_") ||
    ["browser", "web", "research"].includes(descriptor.capability.system)
  ) {
    return "accepted_research";
  }
  return null;
}

function buildCompositeLifecycleNodeProposalsV1(input: {
  plan: CompositeLifecyclePlanV1;
  missionObjective: string;
  descriptorByName: ReadonlyMap<string, ToolDescriptor>;
  currentNotePath: string | null;
  maxAttempts: number;
  wallClockMsPerAction: number;
  bindingIdByTool: ReadonlyMap<string, string | null>;
}): Record<string, MissionGraphNodeProposalV1> {
  const stageTemplates = buildProjectLifecycleStageNodesV1(input.plan.intent);
  const result: Record<string, MissionGraphNodeProposalV1> = {};
  for (const stageTemplate of stageTemplates) {
    const steps = input.plan.stepsByStage.get(stageTemplate.stage) ?? [];
    const actions: MissionCompositeLifecycleActionV1[] = steps.map(
      (step, index) => {
        const descriptor = input.descriptorByName.get(step.name)!;
        // A composite stage is resumed by the Obsidian host one action at a
        // time. Background dispatch remains available to conventional
        // single-action nodes and never widens this mixed-authority stage.
        const proposal = proposalForTool({
          nodeId: `action-template-${index + 1}-${stableToken(step.name)}`,
          descriptor,
          dependencies: [],
          currentNotePath: input.currentNotePath,
          maxAttempts: input.maxAttempts,
          wallClockMs: input.wallClockMsPerAction,
          headlessToolNames: new Set<string>(),
          preferBackground: false,
          bindingId: input.bindingIdByTool.get(step.name) ?? null,
          selector:
            step.selector ??
            explicitVaultSelector({
              toolName: step.name,
              objective: input.missionObjective,
              currentNotePath: input.currentNotePath,
            }),
          objective: step.objective,
        });
        const resourceInput = proposal.inputs.resource;
        return {
          id: `action-${String(index + 1).padStart(3, "0")}-${stableToken(step.name)}`,
          toolName: step.name,
          effect: proposal.effect,
          bindingId:
            proposal.destination?.bindingId ??
            (resourceInput?.kind === "binding"
              ? resourceInput.bindingId
              : null),
          selector:
            proposal.destination?.selector ??
            (resourceInput?.kind === "binding"
              ? resourceInput.selector
              : null),
          objective: proposal.objective,
          minimumEvidence: proposal.completionContract.minimumEvidence,
          requiredEvidenceKinds: [
            ...proposal.completionContract.requiredEvidenceKinds,
          ],
          minimumReceipts: proposal.completionContract.minimumReceipts,
          requiredReceiptKinds: [
            ...proposal.completionContract.requiredReceiptKinds,
          ],
        };
      },
    );
    const effect = strongestGraphEffectV1(actions.map((action) => action.effect));
    const effectfulBindingIds = sortedUnique(
      actions.flatMap((action) =>
        action.effect !== "read" && action.bindingId ? [action.bindingId] : [],
      ),
    );
    result[stageTemplate.id] = {
      id: stageTemplate.id,
      dependencyIds: [...stageTemplate.dependencyIds],
      objective: stageTemplate.objective,
      executorId: "single-agent",
      executionHost: "obsidian_core",
      effect,
      inputs: {
        lifecycle: {
          kind: "literal",
          value: {
            version: 1,
            composite: true,
            intentFingerprint: input.plan.intent.fingerprint,
            stage: stageTemplate.stage,
            actions: actions.map(
              (action): Record<string, MissionJsonValueV1> => ({
                id: action.id,
                toolName: action.toolName,
                effect: action.effect,
                bindingId: action.bindingId,
                selector: action.selector,
                objective: action.objective,
                minimumEvidence: action.minimumEvidence,
                requiredEvidenceKinds: [...action.requiredEvidenceKinds],
                minimumReceipts: action.minimumReceipts,
                requiredReceiptKinds: [...action.requiredReceiptKinds],
              }),
            ),
          },
        },
      },
      requiredCapabilities: sortedUnique(
        actions.flatMap((action) =>
          input.descriptorByName.get(action.toolName)
            ? [capabilityId(input.descriptorByName.get(action.toolName)!)]
            : [],
        ),
      ),
      allowedTools: sortedUnique(actions.map((action) => action.toolName)),
      destination: null,
      resourceLocks: effectfulBindingIds.map((bindingId) => ({
        bindingId,
        mode: "exclusive" as const,
      })),
      budget: {
        toolCalls: actions.length,
        externalActions: actions.filter(
          (action) => action.effect === "external_action",
        ).length,
        wallClockMs: Math.max(
          1_000,
          input.wallClockMsPerAction * actions.length,
        ),
      },
      maxAttempts: input.maxAttempts,
      completionContract: {
        criteria: [
          `Every ordered ${stageTemplate.stage} lifecycle action produced its required durable proof.`,
        ],
        minimumEvidence: actions.reduce(
          (total, action) => total + action.minimumEvidence,
          0,
        ),
        requiredEvidenceKinds: sortedUnique(
          actions.flatMap((action) => action.requiredEvidenceKinds),
        ),
        minimumReceipts: actions.reduce(
          (total, action) => total + action.minimumReceipts,
          0,
        ),
        requiredReceiptKinds: sortedUnique(
          actions.flatMap((action) => action.requiredReceiptKinds),
        ),
        verifierId: null,
      },
    };
  }
  return result;
}

function strongestGraphEffectV1(
  effects: readonly MissionAuthorityEffectV1[],
): MissionAuthorityEffectV1 {
  const rank: Record<MissionAuthorityEffectV1, number> = {
    read: 0,
    mutation: 1,
    execution: 2,
    external_action: 3,
  };
  return effects.reduce(
    (strongest, effect) => rank[effect] > rank[strongest] ? effect : strongest,
    "read" as MissionAuthorityEffectV1,
  );
}

function buildToolNodeProposals(input: {
  steps: PlannedToolStepV1[];
  objective: string;
  descriptorByName: ReadonlyMap<string, ToolDescriptor>;
  currentNotePath: string | null;
  maxAttempts: number;
  wallClockMs: number;
  headlessToolNames: ReadonlySet<string>;
  preferBackground: boolean;
  bindingIdByTool: ReadonlyMap<string, string | null>;
}): Record<string, MissionGraphNodeProposalV1> {
  const result: Record<string, MissionGraphNodeProposalV1> = {};
  const readNodeIds: string[] = [];
  const plannedReadNodes: Array<{ id: string; name: string }> = [];
  const effectfulNodeIds: string[] = [];
  const githubEffectfulNodeIds: string[] = [];
  input.steps.forEach((step, index) => {
    const name = step.name;
    const descriptor = input.descriptorByName.get(name)!;
    const effect = graphEffect(descriptor);
    const nodeId = toolNodeId(index, name);
    const dependencies =
      effect === "read"
        ? sortedUnique([
            ...(effectfulNodeIds.length > 0
              ? [effectfulNodeIds.at(-1)!]
              : []),
            ...plannedReadPrerequisiteIds(name, plannedReadNodes),
          ])
        : sortedUnique([
            ...readNodeIds,
            ...(effectfulNodeIds.length > 0
              ? [effectfulNodeIds.at(-1)!]
              : []),
            ...(isExactBackgroundGitHubPreparedDescriptor(descriptor) &&
            githubEffectfulNodeIds.length > 0
              ? [githubEffectfulNodeIds.at(-1)!]
              : []),
          ]);
    result[nodeId] = proposalForTool({
      nodeId,
      descriptor,
      dependencies,
      currentNotePath: input.currentNotePath,
      maxAttempts: input.maxAttempts,
      wallClockMs: input.wallClockMs,
      headlessToolNames: input.headlessToolNames,
      preferBackground: input.preferBackground,
      bindingId: input.bindingIdByTool.get(name) ?? null,
      selector:
        step.selector ??
        explicitVaultSelector({
          toolName: name,
          objective: input.objective,
          currentNotePath: input.currentNotePath,
        }),
      objective: step.objective,
    });
    if (effect === "read") {
      readNodeIds.push(nodeId);
      plannedReadNodes.push({ id: nodeId, name });
    }
    else {
      effectfulNodeIds.push(nodeId);
      if (isExactBackgroundGitHubPreparedDescriptor(descriptor)) {
        githubEffectfulNodeIds.push(nodeId);
      }
    }
  });
  return result;
}

function plannedReadPrerequisiteIds(
  toolName: string,
  priorReads: ReadonlyArray<{ id: string; name: string }>,
): string[] {
  const prerequisiteNames =
    toolName === "read_markdown_files"
      ? new Set(["semantic_search_notes"])
      : toolName === "web_fetch"
        ? new Set(["web_search"])
      : new Set<string>();
  // Repeated exact workspace reads must be serialized so a same-name frontier
  // always resolves to one graph selector. Other read lifecycles retain their
  // established parallelism and explicit prerequisite rules above.
  if (toolName === "code_workspace_read") prerequisiteNames.add(toolName);
  return priorReads
    .filter((candidate) => prerequisiteNames.has(candidate.name))
    .map((candidate) => candidate.id);
}

function buildOptionalReadNodeProposals(input: {
  names: string[];
  descriptorByName: ReadonlyMap<string, ToolDescriptor>;
  currentNotePath: string | null;
  maxAttempts: number;
  wallClockMs: number;
  headlessToolNames: ReadonlySet<string>;
  preferBackground: boolean;
  bindingIdByTool: ReadonlyMap<string, string | null>;
}): Record<string, MissionGraphNodeProposalV1> {
  return Object.fromEntries(
    input.names.map((name, index) => {
      const descriptor = input.descriptorByName.get(name)!;
      const nodeId = `optional-${toolNodeId(index, name)}`;
      return [
        nodeId,
        proposalForTool({
          nodeId,
          descriptor,
          dependencies: [],
          currentNotePath: input.currentNotePath,
          maxAttempts: input.maxAttempts,
          wallClockMs: input.wallClockMs,
          headlessToolNames: input.headlessToolNames,
          preferBackground: input.preferBackground,
          bindingId: input.bindingIdByTool.get(name) ?? null,
        }),
      ];
    }),
  );
}

function proposalForTool(input: {
  nodeId: string;
  descriptor: ToolDescriptor;
  dependencies: string[];
  currentNotePath: string | null;
  maxAttempts: number;
  wallClockMs: number;
  headlessToolNames: ReadonlySet<string>;
  preferBackground: boolean;
  bindingId: string | null;
  selector?: string | null;
  objective?: string;
}): MissionGraphNodeProposalV1 {
  const effect = graphEffect(input.descriptor);
  const bindingId = input.bindingId;
  const selector = input.selector ??
    (input.descriptor.capability.system === "vault"
      ? input.currentNotePath ?? "prompt-scoped-vault-target"
      : `prompt-scoped-${input.descriptor.capability.system}-target`);
  const needsDestination = effect !== "read";
  const backgroundDomain = backgroundDomainForTool(input.descriptor.name);
  const runHeadless =
    input.preferBackground &&
    input.headlessToolNames.has(input.descriptor.name) &&
    backgroundDomain !== null;
  const exactBackgroundLinearStateUpdate =
    runHeadless && isExactBackgroundLinearStateUpdateDescriptor(input.descriptor);
  const exactBackgroundCodeValidationCommit =
    runHeadless &&
    isExactBackgroundCodeValidationCommitDescriptor(input.descriptor);
  const exactBackgroundGitHubPrepared =
    runHeadless && isExactBackgroundGitHubPreparedDescriptor(input.descriptor);
  const destinationSelector =
    exactBackgroundLinearStateUpdate || exactBackgroundGitHubPrepared
      ? null
      : selector;
  return {
    id: input.nodeId,
    dependencyIds: input.dependencies,
    objective: input.objective ?? objectiveForDescriptor(input.descriptor),
    executorId: runHeadless
      ? INSTALLED_HEADLESS_EXECUTOR_IDS_V1[backgroundDomain!]
      : "single-agent",
    executionHost: runHeadless ? "headless_runtime" : "obsidian_core",
    effect,
    inputs: bindingId
      ? {
          resource: {
            kind: "binding",
            bindingId,
            selector: effect === "read" ? selector : null,
          },
        }
      : {},
    requiredCapabilities: [capabilityId(input.descriptor)],
    allowedTools: [input.descriptor.name],
    destination:
      needsDestination && bindingId
        ? { bindingId, effect, selector: destinationSelector }
        : null,
    resourceLocks:
      needsDestination && bindingId
        ? [{ bindingId, mode: "exclusive" }]
        : [],
    budget: {
      toolCalls: 1,
      externalActions: effect === "external_action" ? 1 : 0,
      wallClockMs: input.wallClockMs,
    },
    maxAttempts: input.maxAttempts,
    completionContract: exactBackgroundLinearStateUpdate
      ? {
          criteria: [
            "Independent Linear readback verifies the exact approved target state.",
          ],
          minimumEvidence: 1,
          requiredEvidenceKinds: ["linear_readback"],
          minimumReceipts: 1,
          requiredReceiptKinds: [
            "external:linear:linear_issue_state_update_v1",
          ],
          verifierId: "companion-external-result-v1",
        }
      : exactBackgroundCodeValidationCommit
        ? {
            criteria: [
              "Fresh sandbox validation, diff readback, and Git object readback verify one exact local commit.",
            ],
            minimumEvidence: 1,
            requiredEvidenceKinds: ["verified_local_commit"],
            minimumReceipts: 1,
            requiredReceiptKinds: [
              "external:code:prepared_code_validation_commit_v1",
            ],
            verifierId: "companion-external-result-v1",
          }
        : exactBackgroundGitHubPrepared
          ? {
              criteria: [
                "Independent GitHub provider readback verifies the exact prepared repository transition.",
              ],
              minimumEvidence: 1,
              requiredEvidenceKinds: ["github_background_readback"],
              minimumReceipts: 1,
              requiredReceiptKinds: [
                `external:github:${backgroundGitHubOperationForTool(input.descriptor.name)}`,
              ],
              verifierId: "companion-external-result-v1",
            }
      : {
          criteria: [
            `${input.descriptor.name} produced an observable accepted result.`,
          ],
          minimumEvidence: 1,
          requiredEvidenceKinds: ["tool-result"],
          minimumReceipts:
            input.descriptor.durability.receipt && effect !== "read" ? 1 : 0,
          requiredReceiptKinds:
            input.descriptor.durability.receipt && effect !== "read"
              ? [input.descriptor.receiptKind ?? "action-receipt"]
              : [],
          verifierId: null,
        },
  };
}

function explicitVaultSelector(input: {
  toolName: string;
  objective: string;
  currentNotePath: string | null;
}): string | null {
  const paths = extractMarkdownPathMentions(input.objective);
  if (paths.length === 0) return input.currentNotePath;
  if (input.toolName === "delete_path") return paths.at(-1)!;
  if (
    input.toolName === "create_file" ||
    input.toolName === "read_file" ||
    input.toolName === "append_file" ||
    input.toolName === "replace_file" ||
    input.toolName === "move_path"
  ) {
    return paths[0]!;
  }
  return input.currentNotePath;
}

function addFinalNode(
  nodes: Record<string, MissionGraphNodeProposalV1>,
  missionObjective: string,
): void {
  const dependencyIds = Object.keys(nodes).sort();
  nodes.final = {
    id: "final",
    dependencyIds,
    objective: `Deliver a verified final result for: ${missionObjective}`.slice(
      0,
      4_000,
    ),
    executorId: "single-agent",
    executionHost: "obsidian_core",
    effect: "read",
    inputs: {},
    requiredCapabilities: [],
    allowedTools: [],
    destination: null,
    resourceLocks: [],
    budget: { toolCalls: 0, externalActions: 0, wallClockMs: 1_000 },
    maxAttempts: 1,
    completionContract: {
      criteria: ["A relevant final result is visible and acceptance checks pass."],
      minimumEvidence: 1,
      requiredEvidenceKinds: ["final-output"],
      minimumReceipts: 0,
      requiredReceiptKinds: [],
      verifierId: "host-acceptance-v1",
    },
  };
}

async function bindingForDescriptor(
  missionId: string,
  descriptor: ToolDescriptor,
  override?: MissionBindingGrantV1,
): Promise<MissionBindingGrantV1 | null> {
  if (override) {
    const effect = graphEffect(descriptor);
    const allowed = new Set(override.allowedEffects);
    if (
      override.kind !== bindingKind(descriptor) ||
      !allowed.has(effect) ||
      [...allowed].some((candidate) => candidate !== "read" && candidate !== effect)
    ) {
      throw new Error(
        `Trusted binding override for ${descriptor.name} exceeds its descriptor authority.`,
      );
    }
    return {
      id: override.id,
      kind: override.kind,
      destinationFingerprint: override.destinationFingerprint,
      allowedEffects: [...override.allowedEffects],
    };
  }
  const bindingId = bindingIdForDescriptor(descriptor);
  if (!bindingId) return null;
  const effect = graphEffect(descriptor);
  return {
    id: bindingId,
    kind: bindingKind(descriptor),
    destinationFingerprint: await sha256Fingerprint({
      missionId,
      system: descriptor.capability.system,
      resourceType: descriptor.capability.resourceType,
      scope: "host-trusted-logical-binding",
    }),
    allowedEffects: effect === "read" ? ["read"] : ["read", effect],
  };
}

function bindingIdForDescriptor(descriptor: ToolDescriptor): string | null {
  return ["vault", "browser", "workspace", "git", "linear", "github"].includes(
    descriptor.capability.system,
  )
    ? stableToken(
        `binding-${descriptor.capability.system}-${descriptor.capability.resourceType}`,
      )
    : null;
}

function bindingKind(descriptor: ToolDescriptor): string {
  return stableToken(descriptor.capability.resourceType);
}

function capabilityId(descriptor: ToolDescriptor): string {
  return stableToken(
    `${descriptor.capability.system}.${descriptor.capability.resourceType}.${descriptor.capability.action}`,
  );
}

function graphEffect(descriptor: ToolDescriptor): MissionAuthorityEffectV1 {
  if (descriptor.effect === "read") return "read";
  if (descriptor.effect === "execution") return "execution";
  if (
    descriptor.effect === "publish" ||
    descriptor.capability.system === "linear" ||
    descriptor.capability.system === "github"
  ) {
    return "external_action";
  }
  return "mutation";
}

function objectiveForDescriptor(descriptor: ToolDescriptor): string {
  const action = descriptor.capability.action.replace(/_/g, " ");
  const resource = descriptor.capability.resourceType.replace(/_/g, " ");
  return `${capitalize(action)} the bounded ${resource} resource using ${descriptor.name}.`;
}

function toolNodeId(index: number, toolName: string): string {
  return `tool-${String(index + 1).padStart(2, "0")}-${stableToken(toolName)}`.slice(
    0,
    128,
  );
}

function stableToken(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return normalized.slice(0, 128) || "resource";
}

/**
 * Returns the host-owned wall-clock allocation for one bounded tool node.
 * The extra slot preserves the final-result node's budget and keeps dynamic
 * read nodes on the same allocation schedule as nodes planned up front.
 */
export function missionGraphToolNodeWallClockMs(
  totalWallClockMs: number,
  maxTotalToolCalls: number,
): number {
  const toolCallCapacity = Number.isFinite(maxTotalToolCalls)
    ? Math.max(0, Math.floor(maxTotalToolCalls))
    : 0;
  const budgetNodeCount = toolCallCapacity + 1;
  return Math.max(
    1_000,
    Math.floor(
      Math.max(1_000, Math.round(totalWallClockMs) - 1_000) /
        budgetNodeCount,
    ),
  );
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

export function backgroundDomainForTool(
  toolName: string,
): BackgroundExecutionDomainV1 | null {
  if (toolName === "linear_update_issue") return "linear";
  if (toolName === "code_validate_commit_prepared") return "code";
  if (isPreparedBackgroundGitHubToolName(toolName)) return "github";
  for (const domain of ["research", "code", "linear", "github"] as const) {
    if (INSTALLED_HEADLESS_TOOL_BY_DOMAIN_V1[domain] === toolName) return domain;
  }
  return null;
}

const PREPARED_BACKGROUND_GITHUB_TOOL_NAMES = [
  "github_publish_verified_branch",
  "github_create_draft_pull_request",
  "github_update_owned_branch",
  "github_merge_pull_request",
  "github_enable_auto_merge",
] as const;

function isPreparedBackgroundGitHubToolName(
  value: string,
): value is (typeof PREPARED_BACKGROUND_GITHUB_TOOL_NAMES)[number] {
  return PREPARED_BACKGROUND_GITHUB_TOOL_NAMES.includes(
    value as (typeof PREPARED_BACKGROUND_GITHUB_TOOL_NAMES)[number],
  );
}

/** Name equality never grants headless GitHub authority. Every descriptor
 * field must retain the exact integrations-owned preparation, approval,
 * durability, and readback boundary. */
export function isExactBackgroundGitHubPreparedDescriptor(
  descriptor: ToolDescriptor,
): boolean {
  if (!isPreparedBackgroundGitHubToolName(descriptor.name)) return false;
  const merge =
    descriptor.name === "github_merge_pull_request" ||
    descriptor.name === "github_enable_auto_merge";
  const expectedAction =
    descriptor.name === "github_publish_verified_branch"
      ? "publish"
      : descriptor.name === "github_create_draft_pull_request"
        ? "create"
        : descriptor.name === "github_update_owned_branch"
          ? "update"
          : "merge";
  return (
    descriptor.capability.system === "github" &&
    descriptor.capability.resourceType === "trusted_repository_publication" &&
    descriptor.capability.action === expectedAction &&
    descriptor.effect === "publish" &&
    descriptor.risk === "critical" &&
    descriptor.approval.allowPromptGrant === true &&
    descriptor.approval.allowPersistentGrant === false &&
    descriptor.approval.fallback === (merge ? "double_exact" : "exact") &&
    descriptor.execution.preparation === "required" &&
    descriptor.execution.desktopOnly === true &&
    descriptor.execution.cacheable === false &&
    descriptor.execution.parallelSafe === false &&
    descriptor.durability.journal === true &&
    descriptor.durability.receipt === true &&
    descriptor.durability.readback === "required" &&
    descriptor.durability.reconciliation === "required" &&
    descriptor.receiptKind === "external_action"
  );
}

function backgroundGitHubOperationForTool(toolName: string): string {
  const operations: Record<
    (typeof PREPARED_BACKGROUND_GITHUB_TOOL_NAMES)[number],
    string
  > = {
    github_publish_verified_branch: "github_verified_branch_push_v1",
    github_create_draft_pull_request: "github_draft_pull_request_v1",
    github_update_owned_branch: "github_review_repair_fast_forward_v1",
    github_merge_pull_request: "github_pull_request_merge_v1",
    github_enable_auto_merge: "github_pull_request_auto_merge_v1",
  };
  if (!isPreparedBackgroundGitHubToolName(toolName)) {
    throw new Error("Prepared background GitHub tool is outside the fixed catalog.");
  }
  return operations[toolName];
}

/** Same-name tools do not gain effectful headless Code authority unless every
 * host-visible safety and durability field matches the installed contract. */
export function isExactBackgroundCodeValidationCommitDescriptor(
  descriptor: ToolDescriptor,
): boolean {
  return (
    descriptor.name === "code_validate_commit_prepared" &&
    descriptor.capability.system === "git" &&
    descriptor.capability.resourceType === "prepared_validation_commit" &&
    descriptor.capability.action === "commit" &&
    descriptor.effect === "execution" &&
    descriptor.risk === "high" &&
    descriptor.approval.allowPromptGrant === true &&
    descriptor.approval.allowPersistentGrant === false &&
    descriptor.approval.fallback === "exact" &&
    descriptor.execution.preparation === "required" &&
    descriptor.execution.desktopOnly === true &&
    descriptor.execution.cacheable === false &&
    descriptor.execution.parallelSafe === false &&
    descriptor.durability.journal === true &&
    descriptor.durability.receipt === true &&
    descriptor.durability.readback === "required" &&
    descriptor.durability.reconciliation === "required" &&
    descriptor.receiptKind === "code_change"
  );
}

/**
 * The only effectful operation the installed companion can execute. Name
 * equality alone is insufficient: the descriptor must retain the complete
 * prepared-action, receipt, readback, and reconciliation boundary.
 */
function isExactBackgroundLinearStateUpdateDescriptor(
  descriptor: ToolDescriptor,
): boolean {
  return (
    descriptor.name === "linear_update_issue" &&
    descriptor.capability.system === "linear" &&
    descriptor.capability.resourceType === "issue" &&
    descriptor.capability.action === "update" &&
    descriptor.effect === "reversible_mutation" &&
    descriptor.execution.preparation === "required" &&
    descriptor.durability.journal === true &&
    descriptor.durability.receipt === true &&
    descriptor.durability.readback === "required" &&
    descriptor.durability.reconciliation === "required"
  );
}
