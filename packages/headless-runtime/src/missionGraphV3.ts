import { canonicalJson, sha256Fingerprint } from "./canonicalize";

export const MISSION_GRAPH_VERSION = 3 as const;
export const MISSION_CAPABILITY_ENVELOPE_VERSION = 1 as const;
export const MISSION_GRAPH_PATCH_VERSION = 1 as const;
export const MISSION_GRAPH_JOURNAL_VERSION = 1 as const;

// Compound daily-use lifecycles remain bounded while retaining their composite
// research, provider, Code, two correction passes, and finalizer nodes in one
// authoritative graph. Sixty-four admits the reviewed 45-tool protected
// lifecycle, finalization, and eighteen host-journaled safe-read/recovery
// nodes without turning the graph into an open-ended retry surface.
export const MISSION_GRAPH_MAX_NODES = 64 as const;
export const MISSION_GRAPH_MAX_DEPTH = 64 as const;
export const MISSION_GRAPH_MAX_CONCURRENT_READ_NODES = 3 as const;

export type MissionNodeStatusV3 =
  | "queued"
  | "ready"
  | "running"
  | "waiting_approval"
  | "waiting_obsidian"
  | "verifying"
  | "blocked"
  | "complete"
  | "cancelled";

export type MissionExecutionHostV1 =
  | "obsidian_core"
  | "headless_runtime"
  | "companion";

export type MissionAuthorityEffectV1 =
  | "read"
  | "mutation"
  | "execution"
  | "external_action";

export type MissionJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | MissionJsonValueV1[]
  | { [key: string]: MissionJsonValueV1 };

export interface MissionEnvelopeBudgetsV1 {
  maxNodes: number;
  maxDepth: number;
  maxConcurrentReadNodes: number;
  maxTotalToolCalls: number;
  maxExternalActions: number;
  maxWallClockMs: number;
  maxAttemptsPerNode: number;
}

export interface MissionExecutorGrantV1 {
  id: string;
  executionHosts: MissionExecutionHostV1[];
  allowedEffects: MissionAuthorityEffectV1[];
}

export interface MissionToolGrantV1 {
  name: string;
  effect: MissionAuthorityEffectV1;
  capabilityIds: string[];
  executionHosts: MissionExecutionHostV1[];
  bindingKinds: string[];
}

export interface MissionBindingGrantV1 {
  id: string;
  kind: string;
  destinationFingerprint: string;
  allowedEffects: MissionAuthorityEffectV1[];
}

/**
 * The capability ceiling is built and fingerprinted by the host. Model output
 * may reference it but cannot mint installed tools, trusted bindings, hosts,
 * executors, or authority.
 */
export interface MissionCapabilityEnvelopeV1 {
  version: typeof MISSION_CAPABILITY_ENVELOPE_VERSION;
  builtBy: "host";
  missionId: string;
  issuedAt: string;
  expiresAt: string | null;
  capabilities: string[];
  executionHosts: MissionExecutionHostV1[];
  executors: Record<string, MissionExecutorGrantV1>;
  verifiers: string[];
  tools: Record<string, MissionToolGrantV1>;
  bindings: Record<string, MissionBindingGrantV1>;
  budgets: MissionEnvelopeBudgetsV1;
  fingerprint: string;
}

export type MissionCapabilityEnvelopeBuildInputV1 = Omit<
  MissionCapabilityEnvelopeV1,
  "version" | "builtBy" | "fingerprint"
>;

export type MissionNodeInputV1 =
  | { kind: "literal"; value: MissionJsonValueV1 }
  | { kind: "binding"; bindingId: string; selector: string | null };

export interface MissionDestinationV1 {
  bindingId: string;
  effect: Exclude<MissionAuthorityEffectV1, "read">;
  selector: string | null;
}

export interface MissionNodeBudgetV1 {
  toolCalls: number;
  externalActions: number;
  wallClockMs: number;
}

export interface MissionNodeRetriesV1 {
  maxAttempts: number;
  attempts: number;
  failureFingerprints: MissionFailureFingerprintV1[];
  consecutiveFailureFingerprint: string | null;
  consecutiveFailureCount: number;
}

export interface MissionFailureFingerprintV1 {
  fingerprint: string;
  count: number;
  lastSeenAt: string;
}

export interface MissionEvidenceRefV1 {
  id: string;
  kind: string;
  fingerprint: string;
  observedAt: string;
}

export interface MissionReceiptRefV1 {
  id: string;
  kind: string;
  fingerprint: string;
  committedAt: string;
}

export interface MissionVerificationRefV1 {
  verifierId: string;
  status: "passed" | "failed";
  fingerprint: string;
  verifiedAt: string;
}

export interface MissionCompletionContractV3 {
  criteria: string[];
  minimumEvidence: number;
  requiredEvidenceKinds: string[];
  minimumReceipts: number;
  requiredReceiptKinds: string[];
  verifierId: string | null;
}

export interface MissionBlockerV1 {
  code: string;
  message: string;
  requiredAction: string | null;
}

export interface MissionResourceLockRequirementV1 {
  bindingId: string;
  mode: "shared" | "exclusive";
}

export interface MissionRoutingDecisionV1 {
  source: "structured_model" | "deterministic";
  fallbackFrom: "structured_model" | null;
  fallbackReason: string | null;
  confidence: number | null;
  decidedAt: string;
  decisionFingerprint: string;
}

export interface MissionContinuationCheckpointV1 {
  version: 1;
  graphRevision: number;
  activeNodeIds: string[];
  readyNodeIds: string[];
  persistedAt: string;
  fingerprint: string;
}

export interface MissionNodeV3 {
  id: string;
  dependencyIds: string[];
  objective: string;
  executorId: string;
  executionHost: MissionExecutionHostV1;
  effect: MissionAuthorityEffectV1;
  inputs: Record<string, MissionNodeInputV1>;
  outputs: Record<string, MissionJsonValueV1>;
  requiredCapabilities: string[];
  allowedTools: string[];
  destination: MissionDestinationV1 | null;
  resourceLocks: MissionResourceLockRequirementV1[];
  budget: MissionNodeBudgetV1;
  retries: MissionNodeRetriesV1;
  status: MissionNodeStatusV3;
  evidence: MissionEvidenceRefV1[];
  receipts: MissionReceiptRefV1[];
  verification: MissionVerificationRefV1 | null;
  completionContract: MissionCompletionContractV3;
  blocker: MissionBlockerV1 | null;
}

export interface MissionGraphV3 {
  schemaVersion: typeof MISSION_GRAPH_VERSION;
  missionId: string;
  objective: string;
  revision: number;
  journalHeadFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
  routing: MissionRoutingDecisionV1;
  continuationCheckpoint: MissionContinuationCheckpointV1 | null;
  capabilityEnvelope: MissionCapabilityEnvelopeV1;
  nodes: Record<string, MissionNodeV3>;
}

export interface MissionNodeChangesV1 {
  dependencyIds?: string[];
  objective?: string;
  executorId?: string;
  executionHost?: MissionExecutionHostV1;
  effect?: MissionAuthorityEffectV1;
  inputs?: Record<string, MissionNodeInputV1>;
  requiredCapabilities?: string[];
  allowedTools?: string[];
  destination?: MissionDestinationV1 | null;
  resourceLocks?: MissionResourceLockRequirementV1[];
  budget?: MissionNodeBudgetV1;
  retries?: MissionNodeRetriesV1;
  completionContract?: MissionCompletionContractV3;
}

export type MissionGraphPatchOperationV1 =
  | { op: "set_objective"; objective: string }
  | { op: "add_node"; node: MissionNodeV3 }
  | { op: "update_node"; nodeId: string; changes: MissionNodeChangesV1 }
  | { op: "remove_node"; nodeId: string }
  | {
      op: "set_status";
      nodeId: string;
      expectedStatus: MissionNodeStatusV3;
      status: MissionNodeStatusV3;
      blocker: MissionBlockerV1 | null;
    }
  | {
      op: "record_attempt";
      nodeId: string;
      failureFingerprint: string | null;
      observedAt: string;
    }
  | { op: "set_outputs"; nodeId: string; outputs: Record<string, MissionJsonValueV1> }
  | { op: "append_evidence"; nodeId: string; evidence: MissionEvidenceRefV1 }
  | { op: "append_receipt"; nodeId: string; receipt: MissionReceiptRefV1 }
  | {
      op: "record_verification";
      nodeId: string;
      verification: MissionVerificationRefV1;
    };

export interface MissionGraphPatchV1 {
  version: typeof MISSION_GRAPH_PATCH_VERSION;
  patchId: string;
  missionId: string;
  baseRevision: number;
  baseJournalFingerprint: string | null;
  proposedAt: string;
  reason: string;
  operations: MissionGraphPatchOperationV1[];
}

export interface MissionGraphJournalEntryV1 {
  version: typeof MISSION_GRAPH_JOURNAL_VERSION;
  patchId: string;
  missionId: string;
  previousRevision: number;
  nextRevision: number;
  previousJournalFingerprint: string | null;
  patchFingerprint: string;
  patch: MissionGraphPatchV1;
  beforeGraphFingerprint: string;
  afterGraphFingerprint: string;
  journalFingerprint: string;
  state: "prepared" | "applied";
  preparedAt: string;
  applyAt: string;
  appliedAt: string | null;
  recordFingerprint: string;
  operationCount: number;
}

export interface MissionGraphPatchResultV1 {
  graph: MissionGraphV3;
  preparedJournalEntry: MissionGraphJournalEntryV1;
  journalEntry: MissionGraphJournalEntryV1;
}

export type MissionGraphValidationCode =
  | "invalid_shape"
  | "invalid_id"
  | "invalid_status"
  | "invalid_transition"
  | "capability_envelope_tampered"
  | "node_limit"
  | "depth_limit"
  | "cycle"
  | "unknown_dependency"
  | "unknown_executor"
  | "unknown_tool"
  | "unknown_binding"
  | "unknown_capability"
  | "budget_exceeded"
  | "authority_widening"
  | "destination_changed"
  | "completed_node_immutable"
  | "proof_incomplete"
  | "stale_revision"
  | "stale_journal";

export class MissionGraphValidationError extends Error {
  constructor(
    readonly code: MissionGraphValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "MissionGraphValidationError";
  }
}

export async function buildMissionCapabilityEnvelopeV1(
  input: MissionCapabilityEnvelopeBuildInputV1,
): Promise<MissionCapabilityEnvelopeV1> {
  const payload = normalizeCapabilityEnvelopePayload({
    version: MISSION_CAPABILITY_ENVELOPE_VERSION,
    builtBy: "host",
    ...input,
  });
  return {
    ...payload,
    fingerprint: await sha256Fingerprint(payload),
  };
}

export async function parseMissionCapabilityEnvelopeV1(
  value: unknown,
): Promise<MissionCapabilityEnvelopeV1> {
  const source = record(value, "capabilityEnvelope");
  exactKeys(
    source,
    [
      "version",
      "builtBy",
      "missionId",
      "issuedAt",
      "expiresAt",
      "capabilities",
      "executionHosts",
      "executors",
      "verifiers",
      "tools",
      "bindings",
      "budgets",
      "fingerprint",
    ],
    "capabilityEnvelope",
  );
  const fingerprint = fingerprintValue(source.fingerprint, "capabilityEnvelope.fingerprint");
  const { fingerprint: _ignored, ...payloadSource } = source;
  const payload = normalizeCapabilityEnvelopePayload(payloadSource);
  const expected = await sha256Fingerprint(payload);
  if (fingerprint !== expected) {
    fail(
      "capability_envelope_tampered",
      "Mission capability envelope fingerprint does not match its canonical payload.",
    );
  }
  return { ...payload, fingerprint };
}

export async function parseMissionGraphV3(value: unknown): Promise<MissionGraphV3> {
  const source = record(value, "missionGraph");
  exactKeys(
    source,
    [
      "schemaVersion",
      "missionId",
      "objective",
      "revision",
      "journalHeadFingerprint",
      "createdAt",
      "updatedAt",
      "routing",
      "continuationCheckpoint",
      "capabilityEnvelope",
      "nodes",
    ],
    "missionGraph",
  );
  if (source.schemaVersion !== MISSION_GRAPH_VERSION) {
    fail("invalid_shape", "Mission graph schemaVersion must be 3.");
  }
  const missionId = stableId(source.missionId, "missionGraph.missionId");
  const capabilityEnvelope = await parseMissionCapabilityEnvelopeV1(
    source.capabilityEnvelope,
  );
  if (capabilityEnvelope.missionId !== missionId) {
    fail(
      "invalid_shape",
      "Mission graph and capability envelope mission IDs must match.",
    );
  }
  const nodes = normalizeNodes(source.nodes, capabilityEnvelope);
  const graph: MissionGraphV3 = {
    schemaVersion: MISSION_GRAPH_VERSION,
    missionId,
    objective: text(source.objective, "missionGraph.objective", 1, 8_000),
    revision: integer(source.revision, "missionGraph.revision", 0, Number.MAX_SAFE_INTEGER),
    journalHeadFingerprint:
      source.journalHeadFingerprint === null
        ? null
        : fingerprintValue(
            source.journalHeadFingerprint,
            "missionGraph.journalHeadFingerprint",
          ),
    createdAt: timestamp(source.createdAt, "missionGraph.createdAt"),
    updatedAt: timestamp(source.updatedAt, "missionGraph.updatedAt"),
    routing: normalizeRoutingDecision(source.routing, "missionGraph.routing"),
    continuationCheckpoint:
      source.continuationCheckpoint === null
        ? null
        : normalizeContinuationCheckpoint(
            source.continuationCheckpoint,
            "missionGraph.continuationCheckpoint",
          ),
    capabilityEnvelope,
    nodes,
  };
  if (Date.parse(graph.updatedAt) < Date.parse(graph.createdAt)) {
    fail("invalid_shape", "Mission graph updatedAt cannot precede createdAt.");
  }
  if (graph.continuationCheckpoint) {
    const { fingerprint, ...payload } = graph.continuationCheckpoint;
    if (fingerprint !== (await sha256Fingerprint(payload))) {
      fail(
        "invalid_shape",
        "Mission continuation checkpoint fingerprint does not match its canonical payload.",
      );
    }
  }
  validateMissionGraphV3(graph);
  return graph;
}

export function parseMissionGraphPatchV1(value: unknown): MissionGraphPatchV1 {
  const source = record(value, "patch");
  exactKeys(
    source,
    [
      "version",
      "patchId",
      "missionId",
      "baseRevision",
      "baseJournalFingerprint",
      "proposedAt",
      "reason",
      "operations",
    ],
    "patch",
  );
  if (source.version !== MISSION_GRAPH_PATCH_VERSION) {
    fail("invalid_shape", "Mission graph patch version must be 1.");
  }
  const operationsSource = array(source.operations, "patch.operations");
  if (operationsSource.length < 1 || operationsSource.length > 64) {
    fail("invalid_shape", "Mission graph patch requires 1-64 operations.");
  }
  return {
    version: MISSION_GRAPH_PATCH_VERSION,
    patchId: stableId(source.patchId, "patch.patchId"),
    missionId: stableId(source.missionId, "patch.missionId"),
    baseRevision: integer(
      source.baseRevision,
      "patch.baseRevision",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    baseJournalFingerprint:
      source.baseJournalFingerprint === null
        ? null
        : fingerprintValue(
            source.baseJournalFingerprint,
            "patch.baseJournalFingerprint",
          ),
    proposedAt: timestamp(source.proposedAt, "patch.proposedAt"),
    reason: text(source.reason, "patch.reason", 1, 2_000),
    operations: operationsSource.map((operation, index) =>
      normalizePatchOperation(operation, `patch.operations[${index}]`),
    ),
  };
}

/**
 * Applies a schema-constrained patch and returns both the next immutable graph
 * state and a hash-linked journal entry. Persistence remains a host concern:
 * callers journal the returned entry before committing the returned graph.
 */
export async function reduceMissionGraphPatchV1(
  graphValue: unknown,
  patchValue: unknown,
  options: { preparedAt?: string; appliedAt?: string } = {},
): Promise<MissionGraphPatchResultV1> {
  const graph = await parseMissionGraphV3(graphValue);
  const patch = parseMissionGraphPatchV1(patchValue);
  if (patch.missionId !== graph.missionId) {
    fail("invalid_shape", "Patch missionId does not match the mission graph.");
  }
  if (patch.baseRevision !== graph.revision) {
    fail(
      "stale_revision",
      `Patch base revision ${patch.baseRevision} does not match graph revision ${graph.revision}.`,
    );
  }
  if (patch.baseJournalFingerprint !== graph.journalHeadFingerprint) {
    fail("stale_journal", "Patch journal head does not match the graph journal head.");
  }

  const next = canonicalClone(graph);
  for (const operation of patch.operations) {
    applyPatchOperation(next, operation);
  }
  next.revision += 1;
  const preparedAt = timestamp(
    options.preparedAt ?? options.appliedAt ?? new Date().toISOString(),
    "preparedAt",
  );
  const applyAt = timestamp(
    options.appliedAt ?? preparedAt,
    "appliedAt",
  );
  if (Date.parse(applyAt) < Date.parse(preparedAt)) {
    fail("invalid_shape", "Patch apply time cannot precede its prepared time.");
  }
  next.updatedAt = timestamp(
    applyAt,
    "appliedAt",
  );
  if (Date.parse(next.updatedAt) < Date.parse(next.createdAt)) {
    fail("invalid_shape", "Patch appliedAt cannot precede graph creation.");
  }

  const patchFingerprint = await sha256Fingerprint(patch);
  const beforeGraphFingerprint = await sha256Fingerprint(graph);
  const transitionCore = {
    version: MISSION_GRAPH_JOURNAL_VERSION,
    patchId: patch.patchId,
    missionId: graph.missionId,
    previousRevision: graph.revision,
    nextRevision: next.revision,
    previousJournalFingerprint: graph.journalHeadFingerprint,
    patchFingerprint,
    patch,
    beforeGraphFingerprint,
    operationCount: patch.operations.length,
    preparedAt,
    applyAt,
  } as const;
  const journalFingerprint = await sha256Fingerprint(transitionCore);
  next.journalHeadFingerprint = journalFingerprint;
  next.continuationCheckpoint = await createContinuationCheckpoint(next);
  validateMissionGraphV3(next);
  const afterGraphFingerprint = await sha256Fingerprint(next);
  const preparedCore = {
    ...transitionCore,
    afterGraphFingerprint,
    journalFingerprint,
    state: "prepared" as const,
    appliedAt: null,
  };
  const preparedJournalEntry: MissionGraphJournalEntryV1 = {
    ...preparedCore,
    recordFingerprint: await sha256Fingerprint(preparedCore),
  };
  const journalEntry = await markMissionGraphJournalAppliedV1(
    preparedJournalEntry,
  );
  return {
    graph: canonicalClone(next),
    preparedJournalEntry: canonicalClone(preparedJournalEntry),
    journalEntry: canonicalClone(journalEntry),
  };
}

export async function parseMissionGraphJournalEntryV1(
  value: unknown,
): Promise<MissionGraphJournalEntryV1> {
  const source = record(value, "journalEntry");
  exactKeys(
    source,
    [
      "version",
      "patchId",
      "missionId",
      "previousRevision",
      "nextRevision",
      "previousJournalFingerprint",
      "patchFingerprint",
      "patch",
      "beforeGraphFingerprint",
      "afterGraphFingerprint",
      "journalFingerprint",
      "state",
      "preparedAt",
      "applyAt",
      "appliedAt",
      "recordFingerprint",
      "operationCount",
    ],
    "journalEntry",
  );
  if (source.version !== MISSION_GRAPH_JOURNAL_VERSION) {
    fail("invalid_shape", "Mission graph journal entry version must be 1.");
  }
  if (source.state !== "prepared" && source.state !== "applied") {
    fail("invalid_shape", "Mission graph journal state must be prepared or applied.");
  }
  const patch = parseMissionGraphPatchV1(source.patch);
  const entryWithoutRecordFingerprint = {
    version: MISSION_GRAPH_JOURNAL_VERSION,
    patchId: stableId(source.patchId, "journalEntry.patchId"),
    missionId: stableId(source.missionId, "journalEntry.missionId"),
    previousRevision: integer(
      source.previousRevision,
      "journalEntry.previousRevision",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    nextRevision: integer(
      source.nextRevision,
      "journalEntry.nextRevision",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    previousJournalFingerprint:
      source.previousJournalFingerprint === null
        ? null
        : fingerprintValue(
            source.previousJournalFingerprint,
            "journalEntry.previousJournalFingerprint",
          ),
    patchFingerprint: fingerprintValue(
      source.patchFingerprint,
      "journalEntry.patchFingerprint",
    ),
    patch,
    beforeGraphFingerprint: fingerprintValue(
      source.beforeGraphFingerprint,
      "journalEntry.beforeGraphFingerprint",
    ),
    afterGraphFingerprint: fingerprintValue(
      source.afterGraphFingerprint,
      "journalEntry.afterGraphFingerprint",
    ),
    journalFingerprint: fingerprintValue(
      source.journalFingerprint,
      "journalEntry.journalFingerprint",
    ),
    state: source.state,
    preparedAt: timestamp(source.preparedAt, "journalEntry.preparedAt"),
    applyAt: timestamp(source.applyAt, "journalEntry.applyAt"),
    appliedAt:
      source.appliedAt === null
        ? null
        : timestamp(source.appliedAt, "journalEntry.appliedAt"),
    operationCount: integer(
      source.operationCount,
      "journalEntry.operationCount",
      1,
      64,
    ),
  };
  const recordFingerprint = fingerprintValue(
    source.recordFingerprint,
    "journalEntry.recordFingerprint",
  );
  if (
    entryWithoutRecordFingerprint.patchId !== patch.patchId ||
    entryWithoutRecordFingerprint.missionId !== patch.missionId ||
    entryWithoutRecordFingerprint.previousRevision !== patch.baseRevision ||
    entryWithoutRecordFingerprint.nextRevision !== patch.baseRevision + 1 ||
    entryWithoutRecordFingerprint.previousJournalFingerprint !==
      patch.baseJournalFingerprint ||
    entryWithoutRecordFingerprint.operationCount !== patch.operations.length
  ) {
    fail("invalid_shape", "Mission graph journal metadata does not match its patch body.");
  }
  if (
    entryWithoutRecordFingerprint.patchFingerprint !==
    (await sha256Fingerprint(patch))
  ) {
    fail("invalid_shape", "Mission graph journal patch fingerprint is invalid.");
  }
  const transitionCore = {
    version: MISSION_GRAPH_JOURNAL_VERSION,
    patchId: entryWithoutRecordFingerprint.patchId,
    missionId: entryWithoutRecordFingerprint.missionId,
    previousRevision: entryWithoutRecordFingerprint.previousRevision,
    nextRevision: entryWithoutRecordFingerprint.nextRevision,
    previousJournalFingerprint:
      entryWithoutRecordFingerprint.previousJournalFingerprint,
    patchFingerprint: entryWithoutRecordFingerprint.patchFingerprint,
    patch,
    beforeGraphFingerprint: entryWithoutRecordFingerprint.beforeGraphFingerprint,
    operationCount: entryWithoutRecordFingerprint.operationCount,
    preparedAt: entryWithoutRecordFingerprint.preparedAt,
    applyAt: entryWithoutRecordFingerprint.applyAt,
  };
  if (
    entryWithoutRecordFingerprint.journalFingerprint !==
    (await sha256Fingerprint(transitionCore))
  ) {
    fail("invalid_shape", "Mission graph journal transition fingerprint is invalid.");
  }
  if (
    (entryWithoutRecordFingerprint.state === "prepared" &&
      entryWithoutRecordFingerprint.appliedAt !== null) ||
    (entryWithoutRecordFingerprint.state === "applied" &&
      entryWithoutRecordFingerprint.appliedAt !== entryWithoutRecordFingerprint.applyAt)
  ) {
    fail("invalid_shape", "Mission graph journal state and applied timestamp disagree.");
  }
  if (
    recordFingerprint !==
    (await sha256Fingerprint(entryWithoutRecordFingerprint))
  ) {
    fail("invalid_shape", "Mission graph journal record fingerprint is invalid.");
  }
  return canonicalClone({
    ...entryWithoutRecordFingerprint,
    recordFingerprint,
  }) as MissionGraphJournalEntryV1;
}

export async function markMissionGraphJournalAppliedV1(
  value: unknown,
): Promise<MissionGraphJournalEntryV1> {
  const prepared = await parseMissionGraphJournalEntryV1(value);
  if (prepared.state !== "prepared") {
    fail("invalid_shape", "Only a prepared mission journal entry may be marked applied.");
  }
  const { recordFingerprint: _ignored, ...preparedWithoutRecordFingerprint } = prepared;
  const appliedWithoutRecordFingerprint = {
    ...preparedWithoutRecordFingerprint,
    state: "applied" as const,
    appliedAt: prepared.applyAt,
  };
  return {
    ...appliedWithoutRecordFingerprint,
    recordFingerprint: await sha256Fingerprint(appliedWithoutRecordFingerprint),
  };
}

export async function replayPreparedMissionGraphPatchV1(
  graphValue: unknown,
  journalValue: unknown,
): Promise<MissionGraphPatchResultV1> {
  const graph = await parseMissionGraphV3(graphValue);
  const prepared = await parseMissionGraphJournalEntryV1(journalValue);
  if (prepared.state !== "prepared") {
    fail("invalid_shape", "Mission journal replay requires a prepared entry.");
  }
  const graphFingerprint = await sha256Fingerprint(graph);
  if (graphFingerprint === prepared.afterGraphFingerprint) {
    return {
      graph,
      preparedJournalEntry: prepared,
      journalEntry: await markMissionGraphJournalAppliedV1(prepared),
    };
  }
  if (graphFingerprint !== prepared.beforeGraphFingerprint) {
    fail("stale_journal", "Prepared mission journal does not match current graph state.");
  }
  const result = await reduceMissionGraphPatchV1(graph, prepared.patch, {
    preparedAt: prepared.preparedAt,
    appliedAt: prepared.applyAt,
  });
  if (
    result.preparedJournalEntry.recordFingerprint !== prepared.recordFingerprint ||
    result.journalEntry.afterGraphFingerprint !== prepared.afterGraphFingerprint
  ) {
    fail("stale_journal", "Prepared mission journal replay produced a different graph.");
  }
  return result;
}

export function validateMissionGraphV3(graph: MissionGraphV3): void {
  const envelope = graph.capabilityEnvelope;
  const nodes = graph.nodes;
  const nodeIds = Object.keys(nodes);
  if (nodeIds.length < 1 || nodeIds.length > envelope.budgets.maxNodes) {
    fail(
      "node_limit",
      `Mission graph requires 1-${envelope.budgets.maxNodes} nodes.`,
    );
  }

  for (const [key, node] of Object.entries(nodes)) {
    if (key !== node.id) {
      fail("invalid_id", `Mission node key ${key} must equal node id ${node.id}.`);
    }
    validateNodeAuthority(node, envelope);
    for (const dependencyId of node.dependencyIds) {
      if (!nodes[dependencyId]) {
        fail(
          "unknown_dependency",
          `Mission node ${node.id} references unknown dependency ${dependencyId}.`,
        );
      }
      if (dependencyId === node.id) {
        fail("cycle", `Mission node ${node.id} cannot depend on itself.`);
      }
    }
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (nodeId: string): number => {
    const known = depths.get(nodeId);
    if (known !== undefined) return known;
    if (visiting.has(nodeId)) {
      fail("cycle", `Mission graph contains a dependency cycle at ${nodeId}.`);
    }
    visiting.add(nodeId);
    const node = nodes[nodeId];
    const depth =
      node.dependencyIds.length === 0
        ? 1
        : 1 + Math.max(...node.dependencyIds.map(depthOf));
    visiting.delete(nodeId);
    depths.set(nodeId, depth);
    return depth;
  };
  for (const nodeId of nodeIds) {
    const depth = depthOf(nodeId);
    if (depth > envelope.budgets.maxDepth) {
      fail(
        "depth_limit",
        `Mission graph depth ${depth} exceeds limit ${envelope.budgets.maxDepth}.`,
      );
    }
  }

  const aggregate = nodeIds.reduce(
    (total, nodeId) => ({
      toolCalls: total.toolCalls + nodes[nodeId].budget.toolCalls,
      externalActions:
        total.externalActions + nodes[nodeId].budget.externalActions,
      wallClockMs: total.wallClockMs + nodes[nodeId].budget.wallClockMs,
    }),
    { toolCalls: 0, externalActions: 0, wallClockMs: 0 },
  );
  if (
    aggregate.toolCalls > envelope.budgets.maxTotalToolCalls ||
    aggregate.externalActions > envelope.budgets.maxExternalActions ||
    aggregate.wallClockMs > envelope.budgets.maxWallClockMs
  ) {
    fail("budget_exceeded", "Mission graph planned budget exceeds its host envelope.");
  }

  for (const node of Object.values(nodes)) {
    if (requiresCompletedDependencies(node.status)) {
      const pending = node.dependencyIds.find(
        (dependencyId) => nodes[dependencyId].status !== "complete",
      );
      if (pending) {
        fail(
          "invalid_status",
          `Mission node ${node.id} cannot be ${node.status} before dependency ${pending} completes.`,
        );
      }
    }
    if (node.status === "complete") {
      validateCompletionProof(node);
    }
    if (node.status === "blocked" && !node.blocker) {
      fail("invalid_status", `Blocked mission node ${node.id} requires a blocker.`);
    }
    if (node.status !== "blocked" && node.blocker) {
      fail(
        "invalid_status",
        `Mission node ${node.id} may only carry a blocker while blocked.`,
      );
    }
  }
  if (graph.continuationCheckpoint) {
    const checkpoint = graph.continuationCheckpoint;
    if (checkpoint.graphRevision !== graph.revision) {
      fail(
        "stale_revision",
        "Mission continuation checkpoint revision does not match the graph.",
      );
    }
    const expectedActive = Object.values(nodes)
      .filter((node) =>
        [
          "running",
          "waiting_approval",
          "waiting_obsidian",
          "verifying",
          "blocked",
        ].includes(node.status),
      )
      .map((node) => node.id)
      .sort();
    const expectedReady = Object.values(nodes)
      .filter((node) => node.status === "ready")
      .map((node) => node.id)
      .sort();
    if (
      !sameJson(checkpoint.activeNodeIds, expectedActive) ||
      !sameJson(checkpoint.readyNodeIds, expectedReady)
    ) {
      fail(
        "invalid_shape",
        "Mission continuation checkpoint does not match active and ready graph nodes.",
      );
    }
  }
}

function normalizeCapabilityEnvelopePayload(
  value: unknown,
): Omit<MissionCapabilityEnvelopeV1, "fingerprint"> {
  const source = record(value, "capabilityEnvelope");
  exactKeys(
    source,
    [
      "version",
      "builtBy",
      "missionId",
      "issuedAt",
      "expiresAt",
      "capabilities",
      "executionHosts",
      "executors",
      "verifiers",
      "tools",
      "bindings",
      "budgets",
    ],
    "capabilityEnvelope",
  );
  if (source.version !== MISSION_CAPABILITY_ENVELOPE_VERSION || source.builtBy !== "host") {
    fail("invalid_shape", "Mission capability envelope must be host-built version 1.");
  }
  const issuedAt = timestamp(source.issuedAt, "capabilityEnvelope.issuedAt");
  const expiresAt =
    source.expiresAt === null
      ? null
      : timestamp(source.expiresAt, "capabilityEnvelope.expiresAt");
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    fail("invalid_shape", "Capability envelope expiry must follow issuance.");
  }
  const capabilities = stableIdArray(
    source.capabilities,
    "capabilityEnvelope.capabilities",
    0,
    256,
  );
  const executionHosts = enumArray(
    source.executionHosts,
    "capabilityEnvelope.executionHosts",
    EXECUTION_HOSTS,
    1,
    EXECUTION_HOSTS.length,
  );
  const executors = normalizeRecord(
    source.executors,
    "capabilityEnvelope.executors",
    1,
    128,
    (entry, path, key) => {
      exactKeys(entry, ["id", "executionHosts", "allowedEffects"], path);
      const id = stableId(entry.id, `${path}.id`);
      if (id !== key) fail("invalid_id", `${path}.id must equal record key ${key}.`);
      const hosts = enumArray(
        entry.executionHosts,
        `${path}.executionHosts`,
        EXECUTION_HOSTS,
        1,
        EXECUTION_HOSTS.length,
      );
      ensureSubset(hosts, executionHosts, `${path}.executionHosts`, "invalid_shape");
      return {
        id,
        executionHosts: hosts,
        allowedEffects: enumArray(
          entry.allowedEffects,
          `${path}.allowedEffects`,
          AUTHORITY_EFFECTS,
          1,
          AUTHORITY_EFFECTS.length,
        ),
      };
    },
  );
  const verifiers = stableIdArray(
    source.verifiers,
    "capabilityEnvelope.verifiers",
    0,
    128,
  );
  const tools = normalizeRecord(
    source.tools,
    "capabilityEnvelope.tools",
    0,
    512,
    (entry, path, key) => {
      exactKeys(
        entry,
        ["name", "effect", "capabilityIds", "executionHosts", "bindingKinds"],
        path,
      );
      const name = stableId(entry.name, `${path}.name`);
      if (name !== key) fail("invalid_id", `${path}.name must equal record key ${key}.`);
      const capabilityIds = stableIdArray(
        entry.capabilityIds,
        `${path}.capabilityIds`,
        0,
        32,
      );
      ensureSubset(
        capabilityIds,
        capabilities,
        `${path}.capabilityIds`,
        "unknown_capability",
      );
      const hosts = enumArray(
        entry.executionHosts,
        `${path}.executionHosts`,
        EXECUTION_HOSTS,
        1,
        EXECUTION_HOSTS.length,
      );
      ensureSubset(hosts, executionHosts, `${path}.executionHosts`, "invalid_shape");
      return {
        name,
        effect: authorityEffect(entry.effect, `${path}.effect`),
        capabilityIds,
        executionHosts: hosts,
        bindingKinds: stableIdArray(
          entry.bindingKinds,
          `${path}.bindingKinds`,
          0,
          32,
        ),
      };
    },
  );
  const bindings = normalizeRecord(
    source.bindings,
    "capabilityEnvelope.bindings",
    0,
    256,
    (entry, path, key) => {
      exactKeys(
        entry,
        ["id", "kind", "destinationFingerprint", "allowedEffects"],
        path,
      );
      const id = stableId(entry.id, `${path}.id`);
      if (id !== key) fail("invalid_id", `${path}.id must equal record key ${key}.`);
      return {
        id,
        kind: stableId(entry.kind, `${path}.kind`),
        destinationFingerprint: fingerprintValue(
          entry.destinationFingerprint,
          `${path}.destinationFingerprint`,
        ),
        allowedEffects: enumArray(
          entry.allowedEffects,
          `${path}.allowedEffects`,
          AUTHORITY_EFFECTS,
          1,
          AUTHORITY_EFFECTS.length,
        ),
      };
    },
  );
  const budgetsSource = record(source.budgets, "capabilityEnvelope.budgets");
  exactKeys(
    budgetsSource,
    [
      "maxNodes",
      "maxDepth",
      "maxConcurrentReadNodes",
      "maxTotalToolCalls",
      "maxExternalActions",
      "maxWallClockMs",
      "maxAttemptsPerNode",
    ],
    "capabilityEnvelope.budgets",
  );
  const budgets: MissionEnvelopeBudgetsV1 = {
    maxNodes: integer(
      budgetsSource.maxNodes,
      "capabilityEnvelope.budgets.maxNodes",
      1,
      MISSION_GRAPH_MAX_NODES,
    ),
    maxDepth: integer(
      budgetsSource.maxDepth,
      "capabilityEnvelope.budgets.maxDepth",
      1,
      MISSION_GRAPH_MAX_DEPTH,
    ),
    maxConcurrentReadNodes: integer(
      budgetsSource.maxConcurrentReadNodes,
      "capabilityEnvelope.budgets.maxConcurrentReadNodes",
      1,
      MISSION_GRAPH_MAX_CONCURRENT_READ_NODES,
    ),
    maxTotalToolCalls: integer(
      budgetsSource.maxTotalToolCalls,
      "capabilityEnvelope.budgets.maxTotalToolCalls",
      0,
      10_000,
    ),
    maxExternalActions: integer(
      budgetsSource.maxExternalActions,
      "capabilityEnvelope.budgets.maxExternalActions",
      0,
      1_000,
    ),
    maxWallClockMs: integer(
      budgetsSource.maxWallClockMs,
      "capabilityEnvelope.budgets.maxWallClockMs",
      1,
      7 * 24 * 60 * 60 * 1_000,
    ),
    maxAttemptsPerNode: integer(
      budgetsSource.maxAttemptsPerNode,
      "capabilityEnvelope.budgets.maxAttemptsPerNode",
      1,
      10,
    ),
  };
  return {
    version: MISSION_CAPABILITY_ENVELOPE_VERSION,
    builtBy: "host",
    missionId: stableId(source.missionId, "capabilityEnvelope.missionId"),
    issuedAt,
    expiresAt,
    capabilities,
    executionHosts,
    executors,
    verifiers,
    tools,
    bindings,
    budgets,
  };
}

function normalizeNodes(
  value: unknown,
  envelope: MissionCapabilityEnvelopeV1,
): Record<string, MissionNodeV3> {
  const count = Object.keys(record(value, "missionGraph.nodes")).length;
  if (count < 1 || count > envelope.budgets.maxNodes) {
    fail(
      "node_limit",
      `Mission graph requires 1-${envelope.budgets.maxNodes} nodes.`,
    );
  }
  return normalizeRecord(value, "missionGraph.nodes", 1, envelope.budgets.maxNodes, (
    entry,
    path,
    key,
  ) => {
    const node = normalizeNode(entry, path, envelope);
    if (node.id !== key) fail("invalid_id", `${path}.id must equal record key ${key}.`);
    return node;
  });
}

function normalizeNode(
  value: unknown,
  path: string,
  envelope?: MissionCapabilityEnvelopeV1,
): MissionNodeV3 {
  const source = record(value, path);
  exactKeys(
    source,
    [
      "id",
      "dependencyIds",
      "objective",
      "executorId",
      "executionHost",
      "effect",
      "inputs",
      "outputs",
      "requiredCapabilities",
      "allowedTools",
      "destination",
      "resourceLocks",
      "budget",
      "retries",
      "status",
      "evidence",
      "receipts",
      "verification",
      "completionContract",
      "blocker",
    ],
    path,
  );
  const node: MissionNodeV3 = {
    id: stableId(source.id, `${path}.id`),
    dependencyIds: stableIdArray(
      source.dependencyIds,
      `${path}.dependencyIds`,
      0,
      MISSION_GRAPH_MAX_NODES - 1,
    ),
    objective: text(source.objective, `${path}.objective`, 1, 4_000),
    executorId: stableId(source.executorId, `${path}.executorId`),
    executionHost: executionHost(source.executionHost, `${path}.executionHost`),
    effect: authorityEffect(source.effect, `${path}.effect`),
    inputs: normalizeInputs(source.inputs, `${path}.inputs`),
    outputs: jsonRecord(source.outputs, `${path}.outputs`, 512_000),
    requiredCapabilities: stableIdArray(
      source.requiredCapabilities,
      `${path}.requiredCapabilities`,
      0,
      64,
    ),
    allowedTools: stableIdArray(source.allowedTools, `${path}.allowedTools`, 0, 128),
    destination:
      source.destination === null
        ? null
        : normalizeDestination(source.destination, `${path}.destination`),
    resourceLocks: normalizeResourceLocks(source.resourceLocks, `${path}.resourceLocks`),
    budget: normalizeNodeBudget(source.budget, `${path}.budget`),
    retries: normalizeNodeRetries(source.retries, `${path}.retries`, envelope),
    status: nodeStatus(source.status, `${path}.status`),
    evidence: normalizeEvidenceArray(source.evidence, `${path}.evidence`),
    receipts: normalizeReceiptArray(source.receipts, `${path}.receipts`),
    verification:
      source.verification === null
        ? null
        : normalizeVerification(source.verification, `${path}.verification`),
    completionContract: normalizeCompletionContract(
      source.completionContract,
      `${path}.completionContract`,
    ),
    blocker:
      source.blocker === null ? null : normalizeBlocker(source.blocker, `${path}.blocker`),
  };
  if (envelope) validateNodeAuthority(node, envelope);
  return node;
}

function validateNodeAuthority(
  node: MissionNodeV3,
  envelope: MissionCapabilityEnvelopeV1,
): void {
  const executor = envelope.executors[node.executorId];
  if (!executor) {
    fail("unknown_executor", `Mission node ${node.id} uses unknown executor ${node.executorId}.`);
  }
  if (!executor.executionHosts.includes(node.executionHost)) {
    fail(
      "unknown_executor",
      `Executor ${node.executorId} is not installed on host ${node.executionHost}.`,
    );
  }
  if (!envelope.executionHosts.includes(node.executionHost)) {
    fail("unknown_executor", `Execution host ${node.executionHost} is not available.`);
  }
  if (!executor.allowedEffects.includes(node.effect)) {
    fail(
      "authority_widening",
      `Executor ${node.executorId} is not granted ${node.effect} authority.`,
    );
  }
  ensureSubset(
    node.requiredCapabilities,
    envelope.capabilities,
    `node ${node.id} requiredCapabilities`,
    "unknown_capability",
  );

  const inputBindingIds = new Set<string>();
  for (const input of Object.values(node.inputs)) {
    if (input.kind === "binding") inputBindingIds.add(input.bindingId);
  }
  for (const bindingId of inputBindingIds) {
    if (!envelope.bindings[bindingId]) {
      fail("unknown_binding", `Mission node ${node.id} uses unknown binding ${bindingId}.`);
    }
  }
  for (const lock of node.resourceLocks) {
    if (!envelope.bindings[lock.bindingId]) {
      fail("unknown_binding", `Mission node ${node.id} locks unknown binding ${lock.bindingId}.`);
    }
  }

  const tools = node.allowedTools.map((toolName) => {
    const tool = envelope.tools[toolName];
    if (!tool) {
      fail("unknown_tool", `Mission node ${node.id} allows unknown tool ${toolName}.`);
    }
    if (!tool.executionHosts.includes(node.executionHost)) {
      fail(
        "unknown_tool",
        `Tool ${toolName} is unavailable on host ${node.executionHost}.`,
      );
    }
    ensureSubset(
      tool.capabilityIds,
      node.requiredCapabilities,
      `node ${node.id} tool ${toolName} capabilities`,
      "authority_widening",
    );
    return tool;
  });
  const effectfulTools = tools.filter((tool) => tool.effect !== "read");
  for (const tool of effectfulTools) {
    if (tool.effect !== node.effect) {
      fail(
        "authority_widening",
        `Tool ${tool.name} effect ${tool.effect} does not match node effect ${node.effect}.`,
      );
    }
  }
  if (node.effect === "read") {
    if (effectfulTools.length > 0) {
      fail("authority_widening", `Read-only mission node ${node.id} allows an effectful tool.`);
    }
    if (node.destination !== null) {
      fail(
        "authority_widening",
        `Read-only mission node ${node.id} cannot declare a mutation destination.`,
      );
    }
    if (node.budget.externalActions !== 0) {
      fail(
        "budget_exceeded",
        `Read-only mission node ${node.id} cannot reserve external actions.`,
      );
    }
  } else {
    if (!node.destination) {
      fail(
        "unknown_binding",
        `Effectful mission node ${node.id} requires a trusted destination binding.`,
      );
    }
    const destination = node.destination;
    const binding = envelope.bindings[destination.bindingId];
    if (!binding) {
      fail(
        "unknown_binding",
        `Mission node ${node.id} uses unknown destination binding ${destination.bindingId}.`,
      );
    }
    if (!binding.allowedEffects.includes(destination.effect)) {
      fail(
        "authority_widening",
        `Binding ${binding.id} does not allow ${destination.effect}.`,
      );
    }
    if (destination.effect !== node.effect) {
      fail(
        "authority_widening",
        `Mission node ${node.id} destination effect does not match its declared effect.`,
      );
    }
    if (
      !node.resourceLocks.some(
        (lock) => lock.bindingId === destination.bindingId && lock.mode === "exclusive",
      )
    ) {
      fail(
        "authority_widening",
        `Effectful mission node ${node.id} requires an exclusive destination lock.`,
      );
    }
    for (const tool of effectfulTools) {
      if (tool.bindingKinds.length > 0 && !tool.bindingKinds.includes(binding.kind)) {
        fail(
          "unknown_binding",
          `Tool ${tool.name} cannot use binding kind ${binding.kind}.`,
        );
      }
    }
    const hasExternalAction = node.effect === "external_action";
    if (hasExternalAction !== (node.budget.externalActions > 0)) {
      fail(
        "budget_exceeded",
        `Mission node ${node.id} external-action budget does not match its tool authority.`,
      );
    }
  }
  if (node.budget.toolCalls < node.allowedTools.length) {
    fail(
      "budget_exceeded",
      `Mission node ${node.id} tool-call budget is smaller than its allowed tool set.`,
    );
  }
  if (node.retries.maxAttempts > envelope.budgets.maxAttemptsPerNode) {
    fail(
      "budget_exceeded",
      `Mission node ${node.id} retry limit exceeds the host envelope.`,
    );
  }
  const verifierId = node.completionContract.verifierId;
  if (verifierId && !envelope.verifiers.includes(verifierId)) {
    fail("unknown_executor", `Mission node ${node.id} uses unknown verifier ${verifierId}.`);
  }
}

function normalizePatchOperation(
  value: unknown,
  path: string,
): MissionGraphPatchOperationV1 {
  const source = record(value, path);
  const op = source.op;
  switch (op) {
    case "set_objective":
      exactKeys(source, ["op", "objective"], path);
      return {
        op,
        objective: text(source.objective, `${path}.objective`, 1, 8_000),
      };
    case "add_node":
      exactKeys(source, ["op", "node"], path);
      return { op, node: normalizeNode(source.node, `${path}.node`) };
    case "update_node":
      exactKeys(source, ["op", "nodeId", "changes"], path);
      return {
        op,
        nodeId: stableId(source.nodeId, `${path}.nodeId`),
        changes: normalizeNodeChanges(source.changes, `${path}.changes`),
      };
    case "remove_node":
      exactKeys(source, ["op", "nodeId"], path);
      return { op, nodeId: stableId(source.nodeId, `${path}.nodeId`) };
    case "set_status":
      exactKeys(source, ["op", "nodeId", "expectedStatus", "status", "blocker"], path);
      return {
        op,
        nodeId: stableId(source.nodeId, `${path}.nodeId`),
        expectedStatus: nodeStatus(source.expectedStatus, `${path}.expectedStatus`),
        status: nodeStatus(source.status, `${path}.status`),
        blocker:
          source.blocker === null
            ? null
            : normalizeBlocker(source.blocker, `${path}.blocker`),
      };
    case "record_attempt":
      exactKeys(source, ["op", "nodeId", "failureFingerprint", "observedAt"], path);
      return {
        op,
        nodeId: stableId(source.nodeId, `${path}.nodeId`),
        failureFingerprint:
          source.failureFingerprint === null
            ? null
            : fingerprintValue(source.failureFingerprint, `${path}.failureFingerprint`),
        observedAt: timestamp(source.observedAt, `${path}.observedAt`),
      };
    case "set_outputs":
      exactKeys(source, ["op", "nodeId", "outputs"], path);
      return {
        op,
        nodeId: stableId(source.nodeId, `${path}.nodeId`),
        outputs: jsonRecord(source.outputs, `${path}.outputs`, 512_000),
      };
    case "append_evidence":
      exactKeys(source, ["op", "nodeId", "evidence"], path);
      return {
        op,
        nodeId: stableId(source.nodeId, `${path}.nodeId`),
        evidence: normalizeEvidence(source.evidence, `${path}.evidence`),
      };
    case "append_receipt":
      exactKeys(source, ["op", "nodeId", "receipt"], path);
      return {
        op,
        nodeId: stableId(source.nodeId, `${path}.nodeId`),
        receipt: normalizeReceipt(source.receipt, `${path}.receipt`),
      };
    case "record_verification":
      exactKeys(source, ["op", "nodeId", "verification"], path);
      return {
        op,
        nodeId: stableId(source.nodeId, `${path}.nodeId`),
        verification: normalizeVerification(
          source.verification,
          `${path}.verification`,
        ),
      };
    default:
      fail("invalid_shape", `${path}.op is not a supported graph patch operation.`);
  }
}

function normalizeNodeChanges(value: unknown, path: string): MissionNodeChangesV1 {
  const source = record(value, path);
  const allowed = [
    "dependencyIds",
    "objective",
    "executorId",
    "executionHost",
    "effect",
    "inputs",
    "requiredCapabilities",
    "allowedTools",
    "destination",
    "resourceLocks",
    "budget",
    "retries",
    "completionContract",
  ];
  exactKeys(source, allowed, path, true);
  if (Object.keys(source).length === 0) {
    fail("invalid_shape", `${path} must change at least one node field.`);
  }
  const changes: MissionNodeChangesV1 = {};
  if ("dependencyIds" in source) {
    changes.dependencyIds = stableIdArray(
      source.dependencyIds,
      `${path}.dependencyIds`,
      0,
      MISSION_GRAPH_MAX_NODES - 1,
    );
  }
  if ("objective" in source) {
    changes.objective = text(source.objective, `${path}.objective`, 1, 4_000);
  }
  if ("executorId" in source) {
    changes.executorId = stableId(source.executorId, `${path}.executorId`);
  }
  if ("executionHost" in source) {
    changes.executionHost = executionHost(source.executionHost, `${path}.executionHost`);
  }
  if ("effect" in source) {
    changes.effect = authorityEffect(source.effect, `${path}.effect`);
  }
  if ("inputs" in source) changes.inputs = normalizeInputs(source.inputs, `${path}.inputs`);
  if ("requiredCapabilities" in source) {
    changes.requiredCapabilities = stableIdArray(
      source.requiredCapabilities,
      `${path}.requiredCapabilities`,
      0,
      64,
    );
  }
  if ("allowedTools" in source) {
    changes.allowedTools = stableIdArray(source.allowedTools, `${path}.allowedTools`, 0, 128);
  }
  if ("destination" in source) {
    changes.destination =
      source.destination === null
        ? null
        : normalizeDestination(source.destination, `${path}.destination`);
  }
  if ("resourceLocks" in source) {
    changes.resourceLocks = normalizeResourceLocks(
      source.resourceLocks,
      `${path}.resourceLocks`,
    );
  }
  if ("budget" in source) changes.budget = normalizeNodeBudget(source.budget, `${path}.budget`);
  if ("retries" in source) {
    changes.retries = normalizeNodeRetries(source.retries, `${path}.retries`);
  }
  if ("completionContract" in source) {
    changes.completionContract = normalizeCompletionContract(
      source.completionContract,
      `${path}.completionContract`,
    );
  }
  return changes;
}

function applyPatchOperation(
  graph: MissionGraphV3,
  operation: MissionGraphPatchOperationV1,
): void {
  if (operation.op === "set_objective") {
    graph.objective = operation.objective;
    return;
  }
  if (operation.op === "add_node") {
    if (graph.nodes[operation.node.id]) {
      fail("invalid_id", `Mission node ${operation.node.id} already exists.`);
    }
    rejectNewMutationAuthority(graph, operation.node);
    graph.nodes[operation.node.id] = canonicalClone(operation.node);
    return;
  }
  const node = graph.nodes[operation.nodeId];
  if (!node) {
    fail("invalid_id", `Mission patch references unknown node ${operation.nodeId}.`);
  }
  if (node.status === "complete") {
    fail(
      "completed_node_immutable",
      `Completed mission node ${node.id} cannot be rewritten.`,
    );
  }
  switch (operation.op) {
    case "update_node": {
      const candidate = { ...node, ...canonicalClone(operation.changes) };
      assertNoAuthorityWidening(node, candidate);
      graph.nodes[node.id] = candidate;
      return;
    }
    case "remove_node":
      delete graph.nodes[node.id];
      return;
    case "set_status":
      if (node.status !== operation.expectedStatus) {
        fail(
          "stale_revision",
          `Mission node ${node.id} status changed from expected ${operation.expectedStatus}.`,
        );
      }
      if (!isStatusTransitionAllowed(node.status, operation.status)) {
        fail(
          "invalid_transition",
          `Mission node ${node.id} cannot transition from ${node.status} to ${operation.status}.`,
        );
      }
      node.status = operation.status;
      node.blocker = operation.blocker;
      return;
    case "record_attempt":
      if (node.retries.attempts >= node.retries.maxAttempts) {
        fail("budget_exceeded", `Mission node ${node.id} has exhausted its attempts.`);
      }
      node.retries.attempts += 1;
      if (operation.failureFingerprint) {
        const existing = node.retries.failureFingerprints.find(
          (failure) => failure.fingerprint === operation.failureFingerprint,
        );
        if (existing) {
          existing.count += 1;
          existing.lastSeenAt = operation.observedAt;
        } else {
          node.retries.failureFingerprints.push({
            fingerprint: operation.failureFingerprint,
            count: 1,
            lastSeenAt: operation.observedAt,
          });
        }
        if (
          node.retries.consecutiveFailureFingerprint === operation.failureFingerprint
        ) {
          node.retries.consecutiveFailureCount += 1;
        } else {
          node.retries.consecutiveFailureFingerprint = operation.failureFingerprint;
          node.retries.consecutiveFailureCount = 1;
        }
      } else {
        node.retries.consecutiveFailureFingerprint = null;
        node.retries.consecutiveFailureCount = 0;
      }
      return;
    case "set_outputs":
      node.outputs = canonicalClone(operation.outputs);
      return;
    case "append_evidence":
      if (node.evidence.some((item) => item.id === operation.evidence.id)) {
        fail("invalid_id", `Evidence ${operation.evidence.id} already exists on ${node.id}.`);
      }
      node.evidence.push(canonicalClone(operation.evidence));
      return;
    case "append_receipt":
      if (node.receipts.some((item) => item.id === operation.receipt.id)) {
        fail("invalid_id", `Receipt ${operation.receipt.id} already exists on ${node.id}.`);
      }
      node.receipts.push(canonicalClone(operation.receipt));
      return;
    case "record_verification":
      if (
        node.completionContract.verifierId !== operation.verification.verifierId
      ) {
        fail(
          "unknown_executor",
          `Verification does not match node ${node.id} completion contract.`,
        );
      }
      node.verification = canonicalClone(operation.verification);
      return;
  }
}

function rejectNewMutationAuthority(graph: MissionGraphV3, candidate: MissionNodeV3): void {
  const envelope = graph.capabilityEnvelope;
  validateNodeAuthority(candidate, envelope);
  const effectfulTools = candidate.allowedTools
    .map((name) => envelope.tools[name])
    .filter((tool) => tool.effect !== "read");
  if (
    candidate.effect === "read" &&
    candidate.destination === null &&
    effectfulTools.length === 0
  ) {
    return;
  }
  const signature = authoritySignature(candidate);
  const authorizedByExistingNode = Object.values(graph.nodes).some(
    (node) => authoritySignature(node) === signature,
  );
  if (!authorizedByExistingNode) {
    fail(
      "authority_widening",
      `Patch cannot add new mutation, execution, or external authority for node ${candidate.id}.`,
    );
  }
}

function authoritySignature(node: MissionNodeV3): string {
  return canonicalJson({
    executorId: node.executorId,
    executionHost: node.executionHost,
    effect: node.effect,
    requiredCapabilities: node.requiredCapabilities,
    allowedTools: node.allowedTools,
    destination: node.destination,
    resourceLocks: node.resourceLocks,
    inputBindingIds: getNodeBindingIds(node),
  });
}

function assertNoAuthorityWidening(oldNode: MissionNodeV3, nextNode: MissionNodeV3): void {
  if (!sameJson(oldNode.destination, nextNode.destination)) {
    fail("destination_changed", `Mission node ${oldNode.id} destination is immutable.`);
  }
  if (
    oldNode.executorId !== nextNode.executorId ||
    oldNode.executionHost !== nextNode.executionHost ||
    oldNode.effect !== nextNode.effect
  ) {
    fail(
      "authority_widening",
      `Mission node ${oldNode.id} executor and execution host are immutable.`,
    );
  }
  requireSubset(nextNode.requiredCapabilities, oldNode.requiredCapabilities, oldNode.id);
  requireSubset(nextNode.allowedTools, oldNode.allowedTools, oldNode.id);
  requireSubset(getNodeBindingIds(nextNode), getNodeBindingIds(oldNode), oldNode.id);
  requireSubset(oldNode.dependencyIds, nextNode.dependencyIds, oldNode.id);
  const previousLocks = oldNode.resourceLocks.map(lockKey);
  const nextLocks = nextNode.resourceLocks.map(lockKey);
  requireSubset(previousLocks, nextLocks, oldNode.id);
  if (
    nextNode.budget.toolCalls > oldNode.budget.toolCalls ||
    nextNode.budget.externalActions > oldNode.budget.externalActions ||
    nextNode.budget.wallClockMs > oldNode.budget.wallClockMs ||
    nextNode.retries.maxAttempts > oldNode.retries.maxAttempts
  ) {
    fail("authority_widening", `Mission node ${oldNode.id} cannot widen budgets or retries.`);
  }
  assertCompletionContractNotWeakened(
    oldNode.completionContract,
    nextNode.completionContract,
    oldNode.id,
  );
}

function assertCompletionContractNotWeakened(
  previous: MissionCompletionContractV3,
  next: MissionCompletionContractV3,
  nodeId: string,
): void {
  if (
    next.minimumEvidence < previous.minimumEvidence ||
    next.minimumReceipts < previous.minimumReceipts ||
    next.verifierId !== previous.verifierId ||
    !isSubset(previous.criteria, next.criteria) ||
    !isSubset(previous.requiredEvidenceKinds, next.requiredEvidenceKinds) ||
    !isSubset(previous.requiredReceiptKinds, next.requiredReceiptKinds)
  ) {
    fail(
      "authority_widening",
      `Mission node ${nodeId} completion contract cannot be weakened during replanning.`,
    );
  }
}

function validateCompletionProof(node: MissionNodeV3): void {
  const contract = node.completionContract;
  if (node.evidence.length < contract.minimumEvidence) {
    fail("proof_incomplete", `Mission node ${node.id} lacks required evidence.`);
  }
  if (node.receipts.length < contract.minimumReceipts) {
    fail("proof_incomplete", `Mission node ${node.id} lacks required receipts.`);
  }
  const evidenceKinds = new Set(node.evidence.map((item) => item.kind));
  const receiptKinds = new Set(node.receipts.map((item) => item.kind));
  if (contract.requiredEvidenceKinds.some((kind) => !evidenceKinds.has(kind))) {
    fail("proof_incomplete", `Mission node ${node.id} lacks a required evidence kind.`);
  }
  if (contract.requiredReceiptKinds.some((kind) => !receiptKinds.has(kind))) {
    fail("proof_incomplete", `Mission node ${node.id} lacks a required receipt kind.`);
  }
  if (
    contract.verifierId &&
    (node.verification?.verifierId !== contract.verifierId ||
      node.verification.status !== "passed")
  ) {
    fail("proof_incomplete", `Mission node ${node.id} lacks a passing verification.`);
  }
}

function normalizeInputs(value: unknown, path: string): Record<string, MissionNodeInputV1> {
  return normalizeRecord(value, path, 0, 128, (entry, entryPath) => {
    const kind = entry.kind;
    if (kind === "literal") {
      exactKeys(entry, ["kind", "value"], entryPath);
      return {
        kind,
        value: jsonValue(entry.value, `${entryPath}.value`, 100_000),
      };
    }
    if (kind === "binding") {
      exactKeys(entry, ["kind", "bindingId", "selector"], entryPath);
      return {
        kind,
        bindingId: stableId(entry.bindingId, `${entryPath}.bindingId`),
        selector:
          entry.selector === null
            ? null
            : text(entry.selector, `${entryPath}.selector`, 1, 1_000),
      };
    }
    fail("invalid_shape", `${entryPath}.kind must be literal or binding.`);
  });
}

function normalizeDestination(value: unknown, path: string): MissionDestinationV1 {
  const source = record(value, path);
  exactKeys(source, ["bindingId", "effect", "selector"], path);
  const effect = authorityEffect(source.effect, `${path}.effect`);
  if (effect === "read") {
    fail("invalid_shape", `${path}.effect must be mutation, execution, or external_action.`);
  }
  return {
    bindingId: stableId(source.bindingId, `${path}.bindingId`),
    effect,
    selector:
      source.selector === null
        ? null
        : text(source.selector, `${path}.selector`, 1, 1_000),
  };
}

function normalizeNodeBudget(value: unknown, path: string): MissionNodeBudgetV1 {
  const source = record(value, path);
  exactKeys(source, ["toolCalls", "externalActions", "wallClockMs"], path);
  return {
    toolCalls: integer(source.toolCalls, `${path}.toolCalls`, 0, 10_000),
    externalActions: integer(
      source.externalActions,
      `${path}.externalActions`,
      0,
      1_000,
    ),
    wallClockMs: integer(source.wallClockMs, `${path}.wallClockMs`, 1, 7 * 24 * 60 * 60 * 1_000),
  };
}

function normalizeNodeRetries(
  value: unknown,
  path: string,
  envelope?: MissionCapabilityEnvelopeV1,
): MissionNodeRetriesV1 {
  const source = record(value, path);
  exactKeys(
    source,
    [
      "maxAttempts",
      "attempts",
      "failureFingerprints",
      "consecutiveFailureFingerprint",
      "consecutiveFailureCount",
    ],
    path,
  );
  const maxAttempts = integer(
    source.maxAttempts,
    `${path}.maxAttempts`,
    1,
    envelope?.budgets.maxAttemptsPerNode ?? 10,
  );
  const attempts = integer(source.attempts, `${path}.attempts`, 0, maxAttempts);
  const failures = array(source.failureFingerprints, `${path}.failureFingerprints`).map(
    (item, index): MissionFailureFingerprintV1 => {
      const failure = record(item, `${path}.failureFingerprints[${index}]`);
      exactKeys(failure, ["fingerprint", "count", "lastSeenAt"], `${path}.failureFingerprints[${index}]`);
      return {
        fingerprint: fingerprintValue(
          failure.fingerprint,
          `${path}.failureFingerprints[${index}].fingerprint`,
        ),
        count: integer(failure.count, `${path}.failureFingerprints[${index}].count`, 1, maxAttempts),
        lastSeenAt: timestamp(
          failure.lastSeenAt,
          `${path}.failureFingerprints[${index}].lastSeenAt`,
        ),
      };
    },
  );
  const consecutiveFailureFingerprint =
    source.consecutiveFailureFingerprint === null
      ? null
      : fingerprintValue(
          source.consecutiveFailureFingerprint,
          `${path}.consecutiveFailureFingerprint`,
        );
  const consecutiveFailureCount = integer(
    source.consecutiveFailureCount,
    `${path}.consecutiveFailureCount`,
    0,
    maxAttempts,
  );
  const totalFailures = failures.reduce((total, failure) => total + failure.count, 0);
  if (
    new Set(failures.map((failure) => failure.fingerprint)).size !== failures.length ||
    totalFailures > attempts ||
    (consecutiveFailureFingerprint === null) !== (consecutiveFailureCount === 0) ||
    (consecutiveFailureFingerprint !== null &&
      !failures.some((failure) => failure.fingerprint === consecutiveFailureFingerprint)) ||
    consecutiveFailureCount >
      (failures.find((failure) => failure.fingerprint === consecutiveFailureFingerprint)?.count ?? 0)
  ) {
    fail(
      "invalid_shape",
      `${path} failure counts and consecutive fingerprint must agree with attempts.`,
    );
  }
  return {
    maxAttempts,
    attempts,
    failureFingerprints: failures,
    consecutiveFailureFingerprint,
    consecutiveFailureCount,
  };
}

function normalizeEvidenceArray(value: unknown, path: string): MissionEvidenceRefV1[] {
  const items = array(value, path);
  if (items.length > 512) fail("invalid_shape", `${path} exceeds 512 entries.`);
  const result = items.map((item, index) => normalizeEvidence(item, `${path}[${index}]`));
  uniqueById(result, path);
  return result;
}

function normalizeEvidence(value: unknown, path: string): MissionEvidenceRefV1 {
  const source = record(value, path);
  exactKeys(source, ["id", "kind", "fingerprint", "observedAt"], path);
  return {
    id: stableId(source.id, `${path}.id`),
    kind: stableId(source.kind, `${path}.kind`),
    fingerprint: fingerprintValue(source.fingerprint, `${path}.fingerprint`),
    observedAt: timestamp(source.observedAt, `${path}.observedAt`),
  };
}

function normalizeReceiptArray(value: unknown, path: string): MissionReceiptRefV1[] {
  const items = array(value, path);
  if (items.length > 512) fail("invalid_shape", `${path} exceeds 512 entries.`);
  const result = items.map((item, index) => normalizeReceipt(item, `${path}[${index}]`));
  uniqueById(result, path);
  return result;
}

function normalizeReceipt(value: unknown, path: string): MissionReceiptRefV1 {
  const source = record(value, path);
  exactKeys(source, ["id", "kind", "fingerprint", "committedAt"], path);
  return {
    id: stableId(source.id, `${path}.id`),
    kind: stableId(source.kind, `${path}.kind`),
    fingerprint: fingerprintValue(source.fingerprint, `${path}.fingerprint`),
    committedAt: timestamp(source.committedAt, `${path}.committedAt`),
  };
}

function normalizeVerification(value: unknown, path: string): MissionVerificationRefV1 {
  const source = record(value, path);
  exactKeys(source, ["verifierId", "status", "fingerprint", "verifiedAt"], path);
  if (source.status !== "passed" && source.status !== "failed") {
    fail("invalid_shape", `${path}.status must be passed or failed.`);
  }
  return {
    verifierId: stableId(source.verifierId, `${path}.verifierId`),
    status: source.status,
    fingerprint: fingerprintValue(source.fingerprint, `${path}.fingerprint`),
    verifiedAt: timestamp(source.verifiedAt, `${path}.verifiedAt`),
  };
}

function normalizeCompletionContract(
  value: unknown,
  path: string,
): MissionCompletionContractV3 {
  const source = record(value, path);
  exactKeys(
    source,
    [
      "criteria",
      "minimumEvidence",
      "requiredEvidenceKinds",
      "minimumReceipts",
      "requiredReceiptKinds",
      "verifierId",
    ],
    path,
  );
  const criteria = textArray(source.criteria, `${path}.criteria`, 1, 32, 1_000);
  const minimumEvidence = integer(
    source.minimumEvidence,
    `${path}.minimumEvidence`,
    0,
    512,
  );
  const minimumReceipts = integer(
    source.minimumReceipts,
    `${path}.minimumReceipts`,
    0,
    512,
  );
  const verifierId =
    source.verifierId === null
      ? null
      : stableId(source.verifierId, `${path}.verifierId`);
  if (minimumEvidence + minimumReceipts === 0 && verifierId === null) {
    fail(
      "invalid_shape",
      `${path} must require evidence, a receipt, or a host verifier.`,
    );
  }
  return {
    criteria,
    minimumEvidence,
    requiredEvidenceKinds: stableIdArray(
      source.requiredEvidenceKinds,
      `${path}.requiredEvidenceKinds`,
      0,
      64,
    ),
    minimumReceipts,
    requiredReceiptKinds: stableIdArray(
      source.requiredReceiptKinds,
      `${path}.requiredReceiptKinds`,
      0,
      64,
    ),
    verifierId,
  };
}

function normalizeBlocker(value: unknown, path: string): MissionBlockerV1 {
  const source = record(value, path);
  exactKeys(source, ["code", "message", "requiredAction"], path);
  return {
    code: stableId(source.code, `${path}.code`),
    message: text(source.message, `${path}.message`, 1, 4_000),
    requiredAction:
      source.requiredAction === null
        ? null
        : text(source.requiredAction, `${path}.requiredAction`, 1, 4_000),
  };
}

function normalizeResourceLocks(
  value: unknown,
  path: string,
): MissionResourceLockRequirementV1[] {
  const items = array(value, path);
  if (items.length > 64) fail("invalid_shape", `${path} exceeds 64 lock requirements.`);
  const locks = items.map((item, index): MissionResourceLockRequirementV1 => {
    const lock = record(item, `${path}[${index}]`);
    exactKeys(lock, ["bindingId", "mode"], `${path}[${index}]`);
    if (lock.mode !== "shared" && lock.mode !== "exclusive") {
      fail("invalid_shape", `${path}[${index}].mode must be shared or exclusive.`);
    }
    return {
      bindingId: stableId(lock.bindingId, `${path}[${index}].bindingId`),
      mode: lock.mode,
    };
  });
  if (new Set(locks.map(lockKey)).size !== locks.length) {
    fail("invalid_shape", `${path} cannot contain duplicate lock requirements.`);
  }
  return locks.sort((left, right) => lockKey(left).localeCompare(lockKey(right)));
}

function normalizeRoutingDecision(
  value: unknown,
  path: string,
): MissionRoutingDecisionV1 {
  const source = record(value, path);
  exactKeys(
    source,
    [
      "source",
      "fallbackFrom",
      "fallbackReason",
      "confidence",
      "decidedAt",
      "decisionFingerprint",
    ],
    path,
  );
  if (source.source !== "structured_model" && source.source !== "deterministic") {
    fail("invalid_shape", `${path}.source must be structured_model or deterministic.`);
  }
  if (source.fallbackFrom !== null && source.fallbackFrom !== "structured_model") {
    fail("invalid_shape", `${path}.fallbackFrom must be structured_model or null.`);
  }
  const fallbackReason =
    source.fallbackReason === null
      ? null
      : text(source.fallbackReason, `${path}.fallbackReason`, 1, 2_000);
  if ((source.fallbackFrom === null) !== (fallbackReason === null)) {
    fail("invalid_shape", `${path} fallback source and reason must appear together.`);
  }
  if (source.fallbackFrom && source.source !== "deterministic") {
    fail("invalid_shape", `${path} may only fall back to deterministic routing.`);
  }
  let confidence: number | null = null;
  if (source.confidence !== null) {
    if (
      typeof source.confidence !== "number" ||
      !Number.isFinite(source.confidence) ||
      source.confidence < 0 ||
      source.confidence > 1
    ) {
      fail("invalid_shape", `${path}.confidence must be null or a number from 0 to 1.`);
    }
    confidence = source.confidence;
  }
  return {
    source: source.source,
    fallbackFrom: source.fallbackFrom,
    fallbackReason,
    confidence,
    decidedAt: timestamp(source.decidedAt, `${path}.decidedAt`),
    decisionFingerprint: fingerprintValue(
      source.decisionFingerprint,
      `${path}.decisionFingerprint`,
    ),
  };
}

function normalizeContinuationCheckpoint(
  value: unknown,
  path: string,
): MissionContinuationCheckpointV1 {
  const source = record(value, path);
  exactKeys(
    source,
    [
      "version",
      "graphRevision",
      "activeNodeIds",
      "readyNodeIds",
      "persistedAt",
      "fingerprint",
    ],
    path,
  );
  if (source.version !== 1) fail("invalid_shape", `${path}.version must be 1.`);
  return {
    version: 1,
    graphRevision: integer(source.graphRevision, `${path}.graphRevision`, 0, Number.MAX_SAFE_INTEGER),
    activeNodeIds: stableIdArray(source.activeNodeIds, `${path}.activeNodeIds`, 0, 16),
    readyNodeIds: stableIdArray(source.readyNodeIds, `${path}.readyNodeIds`, 0, 16),
    persistedAt: timestamp(source.persistedAt, `${path}.persistedAt`),
    fingerprint: fingerprintValue(source.fingerprint, `${path}.fingerprint`),
  };
}

async function createContinuationCheckpoint(
  graph: MissionGraphV3,
): Promise<MissionContinuationCheckpointV1> {
  const payload = {
    version: 1 as const,
    graphRevision: graph.revision,
    activeNodeIds: Object.values(graph.nodes)
      .filter((node) =>
        [
          "running",
          "waiting_approval",
          "waiting_obsidian",
          "verifying",
          "blocked",
        ].includes(node.status),
      )
      .map((node) => node.id)
      .sort(),
    readyNodeIds: Object.values(graph.nodes)
      .filter((node) => node.status === "ready")
      .map((node) => node.id)
      .sort(),
    persistedAt: graph.updatedAt,
  };
  return {
    ...payload,
    fingerprint: await sha256Fingerprint(payload),
  };
}

function lockKey(lock: MissionResourceLockRequirementV1): string {
  return `${lock.bindingId}:${lock.mode}`;
}

function getNodeBindingIds(node: MissionNodeV3): string[] {
  const bindings = Object.values(node.inputs)
    .filter((input): input is Extract<MissionNodeInputV1, { kind: "binding" }> =>
      input.kind === "binding",
    )
    .map((input) => input.bindingId);
  if (node.destination) bindings.push(node.destination.bindingId);
  bindings.push(...node.resourceLocks.map((lock) => lock.bindingId));
  return [...new Set(bindings)].sort();
}

function requiresCompletedDependencies(status: MissionNodeStatusV3): boolean {
  return !["queued", "blocked", "cancelled"].includes(status);
}

function isStatusTransitionAllowed(
  from: MissionNodeStatusV3,
  to: MissionNodeStatusV3,
): boolean {
  if (from === to) return false;
  const transitions: Record<MissionNodeStatusV3, MissionNodeStatusV3[]> = {
    queued: ["ready", "blocked", "cancelled"],
    ready: ["running", "waiting_approval", "waiting_obsidian", "blocked", "cancelled"],
    running: [
      "ready",
      "waiting_approval",
      "waiting_obsidian",
      "verifying",
      "blocked",
      "cancelled",
    ],
    waiting_approval: ["ready", "running", "blocked", "cancelled"],
    waiting_obsidian: ["ready", "running", "blocked", "cancelled"],
    verifying: ["ready", "complete", "blocked", "cancelled"],
    blocked: ["ready", "cancelled"],
    complete: [],
    cancelled: [],
  };
  return transitions[from].includes(to);
}

const EXECUTION_HOSTS: readonly MissionExecutionHostV1[] = [
  "obsidian_core",
  "headless_runtime",
  "companion",
];
const AUTHORITY_EFFECTS: readonly MissionAuthorityEffectV1[] = [
  "read",
  "mutation",
  "execution",
  "external_action",
];
const NODE_STATUSES: readonly MissionNodeStatusV3[] = [
  "queued",
  "ready",
  "running",
  "waiting_approval",
  "waiting_obsidian",
  "verifying",
  "blocked",
  "complete",
  "cancelled",
];

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_shape", `${path} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_shape", `${path} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail("invalid_shape", `${path} must be an array.`);
  return value;
}

function exactKeys(
  source: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  allowMissing = false,
): void {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(source).find((key) => !expectedSet.has(key));
  if (unknown) fail("invalid_shape", `${path} contains unknown field ${unknown}.`);
  if (!allowMissing) {
    const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(source, key));
    if (missing) fail("invalid_shape", `${path} is missing required field ${missing}.`);
  }
}

function stableId(value: unknown, path: string): string {
  if (typeof value !== "string") fail("invalid_id", `${path} must be a stable ID.`);
  const normalized = value.trim();
  if (
    normalized !== value ||
    normalized.length < 1 ||
    normalized.length > 128 ||
    !/^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/.test(normalized)
  ) {
    fail(
      "invalid_id",
      `${path} must use 1-128 lowercase alphanumeric, dot, underscore, colon, or hyphen characters.`,
    );
  }
  return normalized;
}

function stableIdArray(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): string[] {
  const items = array(value, path);
  if (items.length < minimum || items.length > maximum) {
    fail("invalid_shape", `${path} requires ${minimum}-${maximum} values.`);
  }
  const normalized = items.map((item, index) => stableId(item, `${path}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail("invalid_id", `${path} cannot contain duplicate IDs.`);
  }
  return normalized.sort();
}

function enumArray<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  minimum: number,
  maximum: number,
): T[] {
  const items = array(value, path);
  if (items.length < minimum || items.length > maximum) {
    fail("invalid_shape", `${path} requires ${minimum}-${maximum} values.`);
  }
  const result = items.map((item, index) => {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      fail("invalid_shape", `${path}[${index}] is not an allowed value.`);
    }
    return item as T;
  });
  if (new Set(result).size !== result.length) {
    fail("invalid_shape", `${path} cannot contain duplicate values.`);
  }
  return result.sort();
}

function normalizeRecord<T>(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  normalize: (entry: Record<string, unknown>, path: string, key: string) => T,
): Record<string, T> {
  const source = record(value, path);
  const entries = Object.entries(source);
  if (entries.length < minimum || entries.length > maximum) {
    fail("invalid_shape", `${path} requires ${minimum}-${maximum} entries.`);
  }
  const result: Record<string, T> = {};
  for (const [rawKey, rawValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const key = stableId(rawKey, `${path} key`);
    result[key] = normalize(record(rawValue, `${path}.${key}`), `${path}.${key}`, key);
  }
  return result;
}

function text(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string") fail("invalid_shape", `${path} must be text.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    fail("invalid_shape", `${path} requires ${minimum}-${maximum} characters.`);
  }
  return normalized;
}

function textArray(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  maxItemLength: number,
): string[] {
  const items = array(value, path);
  if (items.length < minimum || items.length > maximum) {
    fail("invalid_shape", `${path} requires ${minimum}-${maximum} values.`);
  }
  const result = items.map((item, index) =>
    text(item, `${path}[${index}]`, 1, maxItemLength),
  );
  if (new Set(result).size !== result.length) {
    fail("invalid_shape", `${path} cannot contain duplicates.`);
  }
  return result;
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail("invalid_shape", `${path} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("invalid_shape", `${path} must be an ISO-8601 timestamp.`);
  }
  const normalized = new Date(value).toISOString();
  if (value !== normalized) {
    fail("invalid_shape", `${path} must use canonical UTC ISO-8601 form.`);
  }
  return normalized;
}

function fingerprintValue(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    fail("invalid_shape", `${path} must be a lowercase SHA-256 fingerprint.`);
  }
  return value;
}

function executionHost(value: unknown, path: string): MissionExecutionHostV1 {
  if (!EXECUTION_HOSTS.includes(value as MissionExecutionHostV1)) {
    fail("invalid_shape", `${path} is not a supported execution host.`);
  }
  return value as MissionExecutionHostV1;
}

function authorityEffect(value: unknown, path: string): MissionAuthorityEffectV1 {
  if (!AUTHORITY_EFFECTS.includes(value as MissionAuthorityEffectV1)) {
    fail("invalid_shape", `${path} is not a supported authority effect.`);
  }
  return value as MissionAuthorityEffectV1;
}

function nodeStatus(value: unknown, path: string): MissionNodeStatusV3 {
  if (!NODE_STATUSES.includes(value as MissionNodeStatusV3)) {
    fail("invalid_status", `${path} is not a MissionGraphV3 status.`);
  }
  return value as MissionNodeStatusV3;
}

function jsonRecord(
  value: unknown,
  path: string,
  maxCanonicalBytes: number,
): Record<string, MissionJsonValueV1> {
  const normalized = jsonValue(value, path, maxCanonicalBytes);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    fail("invalid_shape", `${path} must be a JSON object.`);
  }
  return normalized as Record<string, MissionJsonValueV1>;
}

function jsonValue(
  value: unknown,
  path: string,
  maxCanonicalBytes: number,
): MissionJsonValueV1 {
  let serialized: string;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    fail(
      "invalid_shape",
      `${path} is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (new TextEncoder().encode(serialized).byteLength > maxCanonicalBytes) {
    fail("invalid_shape", `${path} exceeds ${maxCanonicalBytes} canonical bytes.`);
  }
  return JSON.parse(serialized) as MissionJsonValueV1;
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function ensureSubset<T extends string>(
  values: readonly T[],
  ceiling: readonly T[],
  path: string,
  code: MissionGraphValidationCode,
): void {
  const allowed = new Set(ceiling);
  const unknown = values.find((value) => !allowed.has(value));
  if (unknown) fail(code, `${path} contains ungranted value ${unknown}.`);
}

function requireSubset(values: string[], ceiling: string[], nodeId: string): void {
  if (!isSubset(values, ceiling)) {
    fail("authority_widening", `Mission node ${nodeId} patch widens authority.`);
  }
}

function isSubset(values: readonly string[], ceiling: readonly string[]): boolean {
  const allowed = new Set(ceiling);
  return values.every((value) => allowed.has(value));
}

function uniqueById(values: Array<{ id: string }>, path: string): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) {
    fail("invalid_id", `${path} cannot contain duplicate IDs.`);
  }
}

function fail(code: MissionGraphValidationCode, message: string): never {
  throw new MissionGraphValidationError(code, message);
}
