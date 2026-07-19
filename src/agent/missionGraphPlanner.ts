import type { ToolDescriptor } from "./actions";
import type {
  JsonSchemaObject,
  ModelChatMessage,
  ModelChatRequest,
  ModelClient,
} from "../model/types";
import { ModelClientError } from "../model/types";
import { withModelRetry } from "../model/retry";
import {
  MissionGraphValidationError,
  parseMissionCapabilityEnvelopeV1,
  parseMissionGraphV3,
  type MissionAuthorityEffectV1,
  type MissionCapabilityEnvelopeV1,
  type MissionGraphV3,
  type MissionNodeV3,
  type MissionRoutingDecisionV1,
} from "./missionGraphV3";
import { sha256Fingerprint } from "../../packages/headless-runtime/src/canonicalize";
import type { ModelRouterMode } from "./missionRouter";

export const MISSION_GRAPH_PLANNER_CONFIDENCE_THRESHOLD = 0.75;
export const MISSION_GRAPH_PLANNER_DEFAULT_TIMEOUT_MS = 10_000;

export type MissionGraphPlannerFallbackReason =
  | "router_mode_off_conservative"
  | "shadow_mode_deterministic_authoritative"
  | "structured_model_unavailable"
  | "structured_model_timeout"
  | "structured_model_invalid_json"
  | "structured_model_invalid_schema"
  | "structured_model_invalid_dag"
  | "structured_model_low_confidence"
  | "structured_model_authority_widening"
  | "structured_model_budget_exceeded";

export interface ExplicitMissionV1 {
  /** Stable ID allocated by the host, not generated from model text. */
  missionId: string;
  objective: string;
}

/**
 * Host-owned executable node template. Mutable runtime state is deliberately
 * absent: the planner initializes it and never accepts it from model output.
 */
export type MissionGraphNodeProposalV1 = Omit<
  MissionNodeV3,
  | "outputs"
  | "retries"
  | "status"
  | "evidence"
  | "receipts"
  | "verification"
  | "blocker"
> & {
  maxAttempts: number;
};

export interface DeterministicMissionGraphProposalV1 {
  /** Nodes selected by deterministic explicit-intent classification. */
  nodes: Record<string, MissionGraphNodeProposalV1>;
  /**
   * Host-built read-only alternatives the semantic planner may union into the
   * deterministic plan. These templates must have no dependencies; the model
   * may propose bounded edges between selected trusted templates.
   */
  optionalReadNodes?: Record<string, MissionGraphNodeProposalV1>;
}

export interface StructuredMissionGraphNodeV1 {
  id: string;
  objective: string;
  dependencyIds: string[];
}

export interface StructuredMissionGraphProposalV1 {
  confidence: number;
  nodes: StructuredMissionGraphNodeV1[];
}

export interface MissionGraphPlannerInputV1 {
  mission: ExplicitMissionV1;
  routerMode: ModelRouterMode;
  capabilityEnvelope: MissionCapabilityEnvelopeV1;
  deterministicProposal: DeterministicMissionGraphProposalV1;
  /**
   * Optional live registry projection. When supplied, every host proposal tool
   * must be installed and its descriptor effect must agree with the envelope.
   */
  allowedToolDescriptors?: readonly (Pick<ToolDescriptor, "name" | "effect"> & {
    authorityEffect?: MissionAuthorityEffectV1;
  })[];
  modelClient?: ModelClient | null;
  timeoutMs?: number;
  confidenceThreshold?: number;
  now?: () => string;
}

export interface MissionGraphPlanningResultV1 {
  graph: MissionGraphV3;
  source: MissionGraphV3["routing"]["source"];
  fallbackReason: MissionGraphPlannerFallbackReason | null;
  modelConfidence: number | null;
}

export type AuthoritativeMissionGraphResolutionV1 =
  | { ok: true; graph: MissionGraphV3 }
  | { ok: false; reason: Exclude<
      MissionGraphPlannerFallbackReason,
      | "router_mode_off_conservative"
      | "shadow_mode_deterministic_authoritative"
      | "structured_model_unavailable"
      | "structured_model_timeout"
      | "structured_model_invalid_json"
      | "structured_model_low_confidence"
    > };

interface PreparedPlanningContextV1 {
  deterministicGraph: MissionGraphV3;
  optionalReadNodes: Record<string, MissionNodeV3>;
  catalogNodeIds: string[];
}

type StructuredModelCallResult =
  | { kind: "ok"; proposal: StructuredMissionGraphProposalV1 }
  | { kind: "timeout" }
  | { kind: "unavailable" }
  | { kind: "invalid_json" }
  | { kind: "invalid_schema" }
  | { kind: "invalid_dag" };

/**
 * Plans a fresh MissionGraphV3 without persisting or dispatching it. Host code
 * must persist the returned graph before the first tool call.
 */
export async function planMissionGraphV3(
  input: MissionGraphPlannerInputV1,
): Promise<MissionGraphPlanningResultV1> {
  const decidedAt = normalizeTimestamp((input.now ?? (() => new Date().toISOString()))());
  const context = await preparePlanningContext(input, decidedAt);

  if (input.routerMode === "off") {
    return deterministicResult(
      context.deterministicGraph,
      "router_mode_off_conservative",
      null,
      decidedAt,
    );
  }

  const modelResult = input.modelClient
    ? await requestStructuredMissionGraph({
        client: input.modelClient,
        mission: input.mission,
        context,
        timeoutMs: input.timeoutMs ?? MISSION_GRAPH_PLANNER_DEFAULT_TIMEOUT_MS,
        validateDag: async (proposal) => {
          const candidate = await resolveAuthoritativeMissionGraphV3({
            deterministicGraph: context.deterministicGraph,
            optionalReadNodes: context.optionalReadNodes,
            structuredProposal: proposal,
            decidedAt,
          });
          return candidate.ok || candidate.reason !== "structured_model_invalid_dag";
        },
      })
    : ({ kind: "unavailable" } as const);

  if (input.routerMode === "shadow") {
    return deterministicResult(
      context.deterministicGraph,
      "shadow_mode_deterministic_authoritative",
      modelResult.kind === "ok" ? modelResult.proposal.confidence : null,
      decidedAt,
    );
  }

  if (modelResult.kind !== "ok") {
    return deterministicResult(
      context.deterministicGraph,
      modelCallFallbackReason(modelResult.kind),
      null,
      decidedAt,
    );
  }

  const confidenceThreshold = normalizeConfidenceThreshold(
    input.confidenceThreshold ?? MISSION_GRAPH_PLANNER_CONFIDENCE_THRESHOLD,
  );
  if (modelResult.proposal.confidence < confidenceThreshold) {
    return deterministicResult(
      context.deterministicGraph,
      "structured_model_low_confidence",
      modelResult.proposal.confidence,
      decidedAt,
    );
  }

  const resolved = await resolveAuthoritativeMissionGraphV3({
    deterministicGraph: context.deterministicGraph,
    optionalReadNodes: context.optionalReadNodes,
    structuredProposal: modelResult.proposal,
    decidedAt,
  });
  if (!resolved.ok) {
    return deterministicResult(
      context.deterministicGraph,
      resolved.reason,
      modelResult.proposal.confidence,
      decidedAt,
    );
  }
  return {
    graph: resolved.graph,
    source: "structured_model",
    fallbackReason: null,
    modelConfidence: modelResult.proposal.confidence,
  };
}

/** Builds the host-authoritative fallback graph and validates its full shape. */
export async function buildDeterministicMissionGraphV3({
  mission,
  capabilityEnvelope,
  proposal,
  decidedAt,
  fallbackReason = null,
}: {
  mission: ExplicitMissionV1;
  capabilityEnvelope: MissionCapabilityEnvelopeV1;
  proposal: Pick<DeterministicMissionGraphProposalV1, "nodes">;
  decidedAt: string;
  fallbackReason?: MissionGraphPlannerFallbackReason | null;
}): Promise<MissionGraphV3> {
  const envelope = await parseMissionCapabilityEnvelopeV1(capabilityEnvelope);
  if (mission.missionId !== envelope.missionId) {
    throw new Error("Explicit mission ID must match the host capability envelope.");
  }
  const timestamp = normalizeTimestamp(decidedAt);
  assertEnvelopeActive(envelope, timestamp);
  const routing = await createRoutingDecision({
    source: "deterministic",
    fallbackReason,
    confidence: null,
    decidedAt: timestamp,
  });
  return buildGraphFromProposalNodes({
    mission,
    envelope,
    proposalNodes: proposal.nodes,
    routing,
    createdAt: timestamp,
  });
}

/**
 * Applies the authority rule independently of model transport. Reads are the
 * deterministic/model union. Effectful nodes remain byte-for-byte host
 * templates for authority fields; only extra prerequisites may narrow them.
 */
export async function resolveAuthoritativeMissionGraphV3({
  deterministicGraph,
  optionalReadNodes,
  structuredProposal,
  decidedAt,
}: {
  deterministicGraph: MissionGraphV3;
  optionalReadNodes: Record<string, MissionNodeV3>;
  structuredProposal: StructuredMissionGraphProposalV1;
  decidedAt: string;
}): Promise<AuthoritativeMissionGraphResolutionV1> {
  const normalizedProposal = normalizeStructuredMissionGraphProposalV1(
    structuredProposal,
  );
  if (!normalizedProposal) {
    return { ok: false, reason: "structured_model_invalid_schema" };
  }
  const semanticById = new Map(
    normalizedProposal.nodes.map((node) => [node.id, node] as const),
  );
  const deterministicIds = new Set(Object.keys(deterministicGraph.nodes));
  const optionalIds = new Set(Object.keys(optionalReadNodes));

  for (const node of normalizedProposal.nodes) {
    if (!deterministicIds.has(node.id) && !optionalIds.has(node.id)) {
      return { ok: false, reason: "structured_model_authority_widening" };
    }
  }

  const selectedIds = new Set(deterministicIds);
  for (const node of normalizedProposal.nodes) {
    if (optionalIds.has(node.id)) selectedIds.add(node.id);
  }
  for (const node of normalizedProposal.nodes) {
    for (const dependencyId of node.dependencyIds) {
      if (!deterministicIds.has(dependencyId) && !optionalIds.has(dependencyId)) {
        return { ok: false, reason: "structured_model_authority_widening" };
      }
      if (!selectedIds.has(dependencyId)) {
        return { ok: false, reason: "structured_model_invalid_dag" };
      }
    }
  }

  const nodes: Record<string, MissionNodeV3> = {};
  for (const id of [...selectedIds].sort()) {
    const hostNode = deterministicGraph.nodes[id] ?? optionalReadNodes[id];
    const semantic = semanticById.get(id);
    if (!hostNode) {
      return { ok: false, reason: "structured_model_authority_widening" };
    }
    if (!deterministicIds.has(id) && hostNode.effect !== "read") {
      return { ok: false, reason: "structured_model_authority_widening" };
    }
    const dependencyIds = sortedUnique([
      ...hostNode.dependencyIds,
      ...(semantic?.dependencyIds ?? []),
    ]);
    nodes[id] = initializeNodeFromHostTemplate(
      hostNode,
      dependencyIds,
      semantic && hostNode.effect === "read" ? semantic.objective : hostNode.objective,
    );
  }

  try {
    const routing = await createRoutingDecision({
      source: "structured_model",
      fallbackReason: null,
      confidence: normalizedProposal.confidence,
      decidedAt,
    });
    const graph = await parseMissionGraphV3({
      ...deterministicGraph,
      updatedAt: normalizeTimestamp(decidedAt),
      routing,
      nodes,
    });
    return { ok: true, graph };
  } catch (error) {
    return { ok: false, reason: classifyModelGraphError(error) };
  }
}

export function createMissionGraphPlannerSchema(
  catalogNodeIds: readonly string[],
): JsonSchemaObject {
  const ids = sortedUnique([...catalogNodeIds]);
  return {
    type: "object",
    required: ["confidence", "nodes"],
    additionalProperties: false,
    properties: {
      confidence: { type: "number", minimum: 0, maximum: 1 },
      nodes: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        items: {
          type: "object",
          required: ["id", "objective", "dependencyIds"],
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: ids },
            objective: { type: "string", minLength: 1, maxLength: 4_000 },
            dependencyIds: {
              type: "array",
              maxItems: 15,
              uniqueItems: true,
              items: { type: "string", enum: ids },
            },
          },
        },
      },
    },
  };
}

export function normalizeStructuredMissionGraphProposalV1(
  value: unknown,
): StructuredMissionGraphProposalV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["confidence", "nodes"])) return null;
  if (
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    !Array.isArray(value.nodes) ||
    value.nodes.length < 1 ||
    value.nodes.length > 16
  ) {
    return null;
  }
  const nodes: StructuredMissionGraphNodeV1[] = [];
  const seen = new Set<string>();
  for (const entry of value.nodes) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["id", "objective", "dependencyIds"])) {
      return null;
    }
    if (
      typeof entry.id !== "string" ||
      !isStableId(entry.id) ||
      seen.has(entry.id) ||
      typeof entry.objective !== "string" ||
      entry.objective.trim().length < 1 ||
      entry.objective.length > 4_000 ||
      !Array.isArray(entry.dependencyIds) ||
      entry.dependencyIds.length > 15
    ) {
      return null;
    }
    const dependencies: string[] = [];
    const dependencySet = new Set<string>();
    for (const dependencyId of entry.dependencyIds) {
      if (
        typeof dependencyId !== "string" ||
        !isStableId(dependencyId) ||
        dependencySet.has(dependencyId)
      ) {
        return null;
      }
      dependencySet.add(dependencyId);
      dependencies.push(dependencyId);
    }
    seen.add(entry.id);
    nodes.push({
      id: entry.id,
      objective: entry.objective,
      dependencyIds: dependencies.sort(),
    });
  }
  return { confidence: value.confidence, nodes };
}

async function preparePlanningContext(
  input: MissionGraphPlannerInputV1,
  decidedAt: string,
): Promise<PreparedPlanningContextV1> {
  const deterministicGraph = await buildDeterministicMissionGraphV3({
    mission: input.mission,
    capabilityEnvelope: input.capabilityEnvelope,
    proposal: input.deterministicProposal,
    decidedAt,
  });
  validateAllowedToolDescriptors(
    input.capabilityEnvelope,
    input.deterministicProposal,
    input.allowedToolDescriptors,
  );
  const optionalReadNodes: Record<string, MissionNodeV3> = {};
  const optional = input.deterministicProposal.optionalReadNodes ?? {};
  for (const [id, proposal] of Object.entries(optional)) {
    if (input.deterministicProposal.nodes[id]) {
      throw new Error(`Optional read node ${id} duplicates a deterministic node ID.`);
    }
    if (proposal.id !== id || proposal.effect !== "read") {
      throw new Error(`Optional planner node ${id} must be a host-built read-only template.`);
    }
    if (proposal.dependencyIds.length > 0) {
      throw new Error(`Optional planner node ${id} must leave semantic dependencies to the model.`);
    }
    const candidate = await buildGraphFromProposalNodes({
      mission: input.mission,
      envelope: deterministicGraph.capabilityEnvelope,
      proposalNodes: { ...input.deterministicProposal.nodes, [id]: proposal },
      routing: deterministicGraph.routing,
      createdAt: deterministicGraph.createdAt,
    });
    optionalReadNodes[id] = candidate.nodes[id];
  }
  return {
    deterministicGraph,
    optionalReadNodes,
    catalogNodeIds: sortedUnique([
      ...Object.keys(deterministicGraph.nodes),
      ...Object.keys(optionalReadNodes),
    ]),
  };
}

async function requestStructuredMissionGraph({
  client,
  mission,
  context,
  timeoutMs,
  validateDag,
}: {
  client: ModelClient;
  mission: ExplicitMissionV1;
  context: PreparedPlanningContextV1;
  timeoutMs: number;
  validateDag?: (proposal: StructuredMissionGraphProposalV1) => Promise<boolean>;
}): Promise<StructuredModelCallResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("Mission graph planner timeout must be between 1 and 120000 ms.");
  }
  const catalog = context.catalogNodeIds.map((id) => {
    const node = context.deterministicGraph.nodes[id] ?? context.optionalReadNodes[id];
    return {
      id,
      required: Boolean(context.deterministicGraph.nodes[id]),
      effect: node.effect,
      hostObjective: node.objective,
      allowedTools: node.allowedTools,
      hostDependencyIds: node.dependencyIds,
    };
  });
  const messages: ModelChatMessage[] = [
    {
      role: "system",
      content: [
        "Propose only the semantic DAG for this mission and return exactly one JSON object with keys confidence and nodes.",
        'Use this exact shape: {"confidence":0.9,"nodes":[{"id":"catalog-node-id","objective":"semantic objective","dependencyIds":[]}]}',
        "confidence must be a JSON number from 0 through 1. nodes must be a JSON array. Every node must contain exactly id, objective, and dependencyIds; dependencyIds must be an array of catalog node ID strings.",
        "Use only host-catalogued node IDs. Required nodes remain in the graph even if omitted.",
        "Include every required=true catalog node exactly once. If dependencyIds references an optional node, include that optional node exactly once too.",
        "hostDependencyIds are immutable prerequisite edges. Never add an edge that reverses or cycles through those host edges; no node may depend on final.",
        "You may add optional read-only nodes when they improve grounding.",
        "Do not invent paths, commands, bindings, tools, destinations, capabilities, hosts, budgets, or authority.",
        "Dependencies express semantic prerequisites. Keep graph depth within the supplied route-derived envelope.",
        "Return JSON only: no markdown fence, prose, authority fields, or alternate property names.",
        `Host node catalog: ${JSON.stringify(catalog)}`,
      ].join("\n"),
    },
    { role: "user", content: mission.objective },
  ];
  const controller = new AbortController();
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let lastInvalidKind: "invalid_json" | "invalid_schema" | "invalid_dag" = "invalid_json";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const request: ModelChatRequest = {
        messages,
        format: createMissionGraphPlannerSchema(context.catalogNodeIds),
        abortSignal: controller.signal,
        evidencePhase: attempt === 1 ? "graph_planner" : "retry",
        think: false,
        options: { temperature: 0 },
      };
      const response = await withModelRetry(() => client.chat(request), {
        policy: { maxAttempts: 2 },
        abortSignal: controller.signal,
      });
      const parsed = parseStructuredJson(response.message.content);
      if (parsed === null) lastInvalidKind = "invalid_json";
      const proposal = normalizeStructuredMissionGraphProposalV1(parsed);
      if (proposal && (!validateDag || await validateDag(proposal))) {
        return { kind: "ok", proposal };
      }
      if (proposal) {
        lastInvalidKind = "invalid_dag";
      } else if (parsed !== null) {
        lastInvalidKind = "invalid_schema";
      }
      if (attempt === 1) {
        messages.push(
          { role: "assistant", content: response.message.content.slice(0, 8_000) },
          {
            role: "system",
            content:
              lastInvalidKind === "invalid_dag"
                ? "DAG repair: return the same exact JSON schema using only catalog node IDs. Include every required=true node exactly once. Every dependencyId must also have its own node entry. Preserve the direction of hostDependencyIds, remove self/cyclic/reversed/unknown dependencies, never make a node depend on final, and keep dependency depth at four or less. Return JSON only."
                : "Schema repair: return only a valid JSON object matching the supplied schema. Use only catalog node IDs, include all required fields, and produce an acyclic dependency graph.",
          },
        );
      }
    }
    return { kind: lastInvalidKind };
  } catch (error) {
    if (
      error instanceof ModelClientError &&
      error.category === "provider_budget_exhausted"
    ) {
      throw error;
    }
    return timedOut ? { kind: "timeout" } : { kind: "unavailable" };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function parseStructuredJson(value: string): unknown | null {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
    if (!fenced) return null;
    try {
      return JSON.parse(fenced[1].trim()) as unknown;
    } catch {
      return null;
    }
  }
}

async function buildGraphFromProposalNodes({
  mission,
  envelope,
  proposalNodes,
  routing,
  createdAt,
}: {
  mission: ExplicitMissionV1;
  envelope: MissionCapabilityEnvelopeV1;
  proposalNodes: Record<string, MissionGraphNodeProposalV1>;
  routing: MissionRoutingDecisionV1;
  createdAt: string;
}): Promise<MissionGraphV3> {
  const nodes: Record<string, MissionNodeV3> = {};
  for (const [id, proposal] of Object.entries(proposalNodes)) {
    if (proposal.id !== id) {
      throw new Error(`Mission node proposal key ${id} must match its stable node ID.`);
    }
    nodes[id] = initializeNodeProposal(proposal);
  }
  return parseMissionGraphV3({
    schemaVersion: 3,
    missionId: mission.missionId,
    objective: mission.objective,
    revision: 0,
    journalHeadFingerprint: null,
    createdAt,
    updatedAt: createdAt,
    routing,
    continuationCheckpoint: null,
    capabilityEnvelope: envelope,
    nodes,
  });
}

function initializeNodeProposal(
  proposal: MissionGraphNodeProposalV1,
): MissionNodeV3 {
  return {
    id: proposal.id,
    dependencyIds: [...proposal.dependencyIds],
    objective: proposal.objective,
    executorId: proposal.executorId,
    executionHost: proposal.executionHost,
    effect: proposal.effect,
    inputs: cloneJson(proposal.inputs),
    outputs: {},
    requiredCapabilities: [...proposal.requiredCapabilities],
    allowedTools: [...proposal.allowedTools],
    destination: cloneJson(proposal.destination),
    resourceLocks: cloneJson(proposal.resourceLocks),
    budget: { ...proposal.budget },
    retries: {
      maxAttempts: proposal.maxAttempts,
      attempts: 0,
      failureFingerprints: [],
      consecutiveFailureFingerprint: null,
      consecutiveFailureCount: 0,
    },
    status: proposal.dependencyIds.length === 0 ? "ready" : "queued",
    evidence: [],
    receipts: [],
    verification: null,
    completionContract: cloneJson(proposal.completionContract),
    blocker: null,
  };
}

function initializeNodeFromHostTemplate(
  hostNode: MissionNodeV3,
  dependencyIds: string[],
  objective: string,
): MissionNodeV3 {
  return {
    ...cloneJson(hostNode),
    dependencyIds,
    objective,
    outputs: {},
    retries: {
      maxAttempts: hostNode.retries.maxAttempts,
      attempts: 0,
      failureFingerprints: [],
      consecutiveFailureFingerprint: null,
      consecutiveFailureCount: 0,
    },
    status: dependencyIds.length === 0 ? "ready" : "queued",
    evidence: [],
    receipts: [],
    verification: null,
    blocker: null,
  };
}

async function deterministicResult(
  graph: MissionGraphV3,
  fallbackReason: MissionGraphPlannerFallbackReason,
  confidence: number | null,
  decidedAt: string,
): Promise<MissionGraphPlanningResultV1> {
  const routing = await createRoutingDecision({
    source: "deterministic",
    fallbackReason,
    confidence,
    decidedAt,
  });
  const normalized = await parseMissionGraphV3({
    ...graph,
    updatedAt: decidedAt,
    routing,
  });
  return {
    graph: normalized,
    source: "deterministic",
    fallbackReason,
    modelConfidence: confidence,
  };
}

async function createRoutingDecision({
  source,
  fallbackReason,
  confidence,
  decidedAt,
}: {
  source: MissionRoutingDecisionV1["source"];
  fallbackReason: MissionGraphPlannerFallbackReason | null;
  confidence: number | null;
  decidedAt: string;
}): Promise<MissionRoutingDecisionV1> {
  const payload = {
    source,
    fallbackFrom: fallbackReason ? ("structured_model" as const) : null,
    fallbackReason,
    confidence,
    decidedAt: normalizeTimestamp(decidedAt),
  };
  return {
    ...payload,
    decisionFingerprint: await sha256Fingerprint(payload),
  };
}

function validateAllowedToolDescriptors(
  envelope: MissionCapabilityEnvelopeV1,
  proposal: DeterministicMissionGraphProposalV1,
  descriptors:
    | readonly (Pick<ToolDescriptor, "name" | "effect"> & {
        authorityEffect?: MissionAuthorityEffectV1;
      })[]
    | undefined,
): void {
  if (!descriptors) return;
  const byName = new Map<
    string,
    Pick<ToolDescriptor, "name" | "effect"> & {
      authorityEffect?: MissionAuthorityEffectV1;
    }
  >();
  for (const descriptor of descriptors) {
    if (byName.has(descriptor.name)) {
      throw new Error(`Allowed tool descriptor ${descriptor.name} is duplicated.`);
    }
    byName.set(descriptor.name, descriptor);
  }
  const proposals = [
    ...Object.values(proposal.nodes),
    ...Object.values(proposal.optionalReadNodes ?? {}),
  ];
  for (const node of proposals) {
    for (const toolName of node.allowedTools) {
      const descriptor = byName.get(toolName);
      const grant = envelope.tools[toolName];
      if (!descriptor || !grant) {
        throw new Error(`Mission graph proposal tool ${toolName} is not installed and allowed.`);
      }
      if (
        (descriptor.authorityEffect ?? descriptorEffect(descriptor.effect)) !==
        grant.effect
      ) {
        throw new Error(`Tool descriptor ${toolName} disagrees with its capability envelope effect.`);
      }
    }
  }
}

function descriptorEffect(effect: ToolDescriptor["effect"]): MissionAuthorityEffectV1 {
  switch (effect) {
    case "read":
      return "read";
    case "reversible_mutation":
    case "destructive_mutation":
      return "mutation";
    case "execution":
      return "execution";
    case "publish":
      return "external_action";
  }
}

function modelCallFallbackReason(
  kind: Exclude<StructuredModelCallResult["kind"], "ok">,
): MissionGraphPlannerFallbackReason {
  switch (kind) {
    case "timeout":
      return "structured_model_timeout";
    case "invalid_json":
      return "structured_model_invalid_json";
    case "invalid_schema":
      return "structured_model_invalid_schema";
    case "invalid_dag":
      return "structured_model_invalid_dag";
    case "unavailable":
      return "structured_model_unavailable";
  }
}

function classifyModelGraphError(
  error: unknown,
): Extract<AuthoritativeMissionGraphResolutionV1, { ok: false }>["reason"] {
  if (!(error instanceof MissionGraphValidationError)) {
    return "structured_model_invalid_schema";
  }
  switch (error.code) {
    case "cycle":
    case "depth_limit":
    case "unknown_dependency":
      return "structured_model_invalid_dag";
    case "node_limit":
    case "budget_exceeded":
      return "structured_model_budget_exceeded";
    case "authority_widening":
    case "unknown_binding":
    case "unknown_capability":
    case "unknown_executor":
    case "unknown_tool":
    case "capability_envelope_tampered":
    case "destination_changed":
      return "structured_model_authority_widening";
    default:
      return "structured_model_invalid_schema";
  }
}

function normalizeTimestamp(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Mission graph planner requires a valid ISO timestamp.");
  }
  return new Date(value).toISOString();
}

function assertEnvelopeActive(
  envelope: MissionCapabilityEnvelopeV1,
  at: string,
): void {
  if (envelope.expiresAt && Date.parse(at) >= Date.parse(envelope.expiresAt)) {
    throw new Error("Mission capability envelope has expired.");
  }
}

function normalizeConfidenceThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Mission graph confidence threshold must be between 0 and 1.");
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function isStableId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
