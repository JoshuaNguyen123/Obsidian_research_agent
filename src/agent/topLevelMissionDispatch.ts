import type { ModelClient } from "../model/types";
import {
  buildMissionCapabilityEnvelopeV1,
  type MissionAuthorityEffectV1,
  type MissionBindingGrantV1,
  type MissionCapabilityEnvelopeV1,
  type MissionNodeV3,
} from "./missionGraphV3";
import {
  planMissionGraphV3,
  type MissionGraphNodeProposalV1,
  type MissionGraphPlanningResultV1,
} from "./missionGraphPlanner";
import { sha256Fingerprint } from "../../packages/headless-runtime/src/canonicalize";
import type { ModelRouterMode } from "./missionRouter";

export interface ExplicitCodeTeamDispatchRequestV1 {
  repositoryPath: string;
  assignment: string;
}

export type TopLevelMissionDispatchDecisionV1 =
  | { kind: "single_agent" }
  | {
      kind: "code_team";
      request: ExplicitCodeTeamDispatchRequestV1;
    }
  | { kind: "research_team" }
  | {
      kind: "blocked";
      blockerCode: "code_extension_unavailable";
      message: string;
      requiredAction: string;
    }
  | {
      kind: "clarification";
      blockerCode: "code_repository_binding_required";
      message: string;
      requiredAction: string;
    };

export interface ResolveTopLevelMissionDispatchInputV1 {
  codeTeamRequest: ExplicitCodeTeamDispatchRequestV1 | null;
  codeTeamBridgeIntent: boolean;
  researchTeamRequested: boolean;
  orchestratorEnabled: boolean;
  forceChatOnly: boolean;
  codeExtensionAvailable: boolean;
  codeClarificationMessage: string;
}

/**
 * Host-owned top-level dispatch classification. Model output never creates a
 * code executor, repository binding, or extension capability. The resulting
 * direct dispatch is persisted as MissionGraphV3 before the executor starts.
 */
export function resolveTopLevelMissionDispatchV1(
  input: ResolveTopLevelMissionDispatchInputV1,
): TopLevelMissionDispatchDecisionV1 {
  if (!input.orchestratorEnabled || input.forceChatOnly) {
    return { kind: "single_agent" };
  }

  const hasCodeIntent = Boolean(input.codeTeamRequest) || input.codeTeamBridgeIntent;
  if (hasCodeIntent && !input.codeExtensionAvailable) {
    return {
      kind: "blocked",
      blockerCode: "code_extension_unavailable",
      message:
        "Code work is unavailable because Agentic Researcher Code is not registered. Enable the code extension, verify its migration status in Run Details, and retry this mission.",
      requiredAction:
        "Enable a compatible Agentic Researcher Code extension and retry the explicit mission.",
    };
  }
  if (hasCodeIntent) {
    // Code missions deliberately stay in the core-owned single-agent loop.
    // The code extension contributes the only workspace and execution tools,
    // and its prepared-action boundary obtains exact approval for repository
    // bindings. The legacy direct code-team executor must not run.
    return { kind: "single_agent" };
  }
  if (input.researchTeamRequested) {
    return { kind: "research_team" };
  }
  return { kind: "single_agent" };
}

export interface PlanTopLevelDirectMissionGraphInputV1 {
  missionId: string;
  objective: string;
  decision: Exclude<
    TopLevelMissionDispatchDecisionV1,
    { kind: "single_agent" }
  >;
  routerMode: ModelRouterMode;
  modelClient?: ModelClient | null;
  now?: Date;
}

/**
 * Builds the exact host authority ceiling for a direct top-level executor.
 * Structured routing may refine read-node semantics, but deterministic nodes
 * are mandatory and effectful executor/binding authority cannot widen.
 */
export async function planTopLevelDirectMissionGraphV1(
  input: PlanTopLevelDirectMissionGraphInputV1,
): Promise<MissionGraphPlanningResultV1> {
  const now = input.now ?? new Date();
  const route = await buildRouteAuthority(input);
  const finalNode = finalProposal(input.objective);
  const capabilityEnvelope = await buildEnvelope({
    missionId: input.missionId,
    now,
    route,
  });

  return planMissionGraphV3({
    mission: {
      missionId: input.missionId,
      objective: input.objective,
    },
    routerMode: input.routerMode,
    capabilityEnvelope,
    deterministicProposal: {
      nodes: {
        dispatch: route.node,
        final: finalNode,
      },
    },
    allowedToolDescriptors: [],
    modelClient: input.modelClient ?? null,
    now: () => now.toISOString(),
  });
}

interface RouteAuthorityV1 {
  node: MissionGraphNodeProposalV1;
  executorId: string;
  effect: MissionAuthorityEffectV1;
  capabilityId: string;
  binding: MissionBindingGrantV1 | null;
}

async function buildRouteAuthority(
  input: PlanTopLevelDirectMissionGraphInputV1,
): Promise<RouteAuthorityV1> {
  const common = {
    id: "dispatch",
    dependencyIds: [],
    executionHost: "obsidian_core" as const,
    inputs: {},
    allowedTools: [],
    budget: {
      toolCalls: 0,
      externalActions: 0,
      wallClockMs: 30 * 60_000,
    },
    maxAttempts: 1,
    completionContract: {
      criteria: ["The selected host executor finishes with readback evidence."],
      minimumEvidence: 1,
      requiredEvidenceKinds: ["orchestrator-result"],
      minimumReceipts: 0,
      requiredReceiptKinds: [],
      verifierId: null,
    },
  };

  if (input.decision.kind === "code_team") {
    const binding: MissionBindingGrantV1 = {
      id: "trusted-code-repository",
      kind: "git-repository",
      destinationFingerprint: await sha256Fingerprint({
        missionId: input.missionId,
        repositoryPath: input.decision.request.repositoryPath,
        scope: "explicit-user-repository-binding",
      }),
      allowedEffects: ["read", "execution"],
    };
    return {
      executorId: "code-team",
      effect: "execution",
      capabilityId: "orchestrator.code.execute",
      binding,
      node: {
        ...common,
        objective: `Execute the explicitly requested isolated code mission: ${input.objective}`.slice(
          0,
          4_000,
        ),
        executorId: "code-team",
        effect: "execution",
        inputs: {
          repository: {
            kind: "binding",
            bindingId: binding.id,
            selector: null,
          },
        },
        requiredCapabilities: ["orchestrator.code.execute"],
        destination: {
          bindingId: binding.id,
          effect: "execution",
          selector: null,
        },
        resourceLocks: [{ bindingId: binding.id, mode: "exclusive" }],
      },
    };
  }

  const isResearch = input.decision.kind === "research_team";
  const capabilityId = isResearch
    ? "orchestrator.research.read"
    : "orchestrator.dispatch.guard";
  const executorId = isResearch ? "research-team" : "host-dispatch-guard";
  const objective =
    input.decision.kind === "research_team"
      ? `Run bounded multi-agent research for: ${input.objective}`
      : input.decision.message;
  return {
    executorId,
    effect: "read",
    capabilityId,
    binding: null,
    node: {
      ...common,
      objective: objective.slice(0, 4_000),
      executorId,
      effect: "read",
      requiredCapabilities: [capabilityId],
      destination: null,
      resourceLocks: [],
    },
  };
}

async function buildEnvelope(input: {
  missionId: string;
  now: Date;
  route: RouteAuthorityV1;
}): Promise<MissionCapabilityEnvelopeV1> {
  return buildMissionCapabilityEnvelopeV1({
    missionId: input.missionId,
    issuedAt: input.now.toISOString(),
    expiresAt: null,
    capabilities: [input.route.capabilityId],
    executionHosts: ["obsidian_core"],
    executors: {
      [input.route.executorId]: {
        id: input.route.executorId,
        executionHosts: ["obsidian_core"],
        allowedEffects: [input.route.effect],
      },
      "single-agent": {
        id: "single-agent",
        executionHosts: ["obsidian_core"],
        allowedEffects: ["read"],
      },
    },
    verifiers: [],
    tools: {},
    bindings: input.route.binding
      ? { [input.route.binding.id]: input.route.binding }
      : {},
    budgets: {
      maxNodes: 2,
      maxDepth: 2,
      maxConcurrentReadNodes: 1,
      maxTotalToolCalls: 0,
      maxExternalActions: 0,
      maxWallClockMs: 30 * 60_000 + 1_000,
      maxAttemptsPerNode: 1,
    },
  });
}

function finalProposal(objective: string): MissionGraphNodeProposalV1 {
  return {
    id: "final",
    dependencyIds: ["dispatch"],
    objective: `Deliver the verified host-executor result for: ${objective}`.slice(
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
      criteria: ["A relevant executor result is visible to the user."],
      minimumEvidence: 1,
      requiredEvidenceKinds: ["final-output"],
      minimumReceipts: 0,
      requiredReceiptKinds: [],
      verifierId: null,
    },
  };
}

export function topLevelDispatchExecutorId(
  graph: { nodes: Record<string, Pick<MissionNodeV3, "executorId">> },
): string | null {
  return graph.nodes.dispatch?.executorId ?? null;
}
