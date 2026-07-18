import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMissionCapabilityEnvelopeV1,
  markMissionGraphJournalAppliedV1,
  MissionGraphValidationError,
  parseMissionCapabilityEnvelopeV1,
  parseMissionGraphJournalEntryV1,
  parseMissionGraphV3,
  reduceMissionGraphPatchV1,
  replayPreparedMissionGraphPatchV1,
  type MissionCapabilityEnvelopeV1,
  type MissionGraphPatchOperationV1,
  type MissionGraphPatchV1,
  type MissionGraphV3,
  type MissionNodeV3,
} from "../packages/headless-runtime/src/missionGraphV3";

const CREATED_AT = "2026-07-11T12:00:00.000Z";
const PATCHED_AT = "2026-07-11T12:01:00.000Z";

test("host-built capability envelopes normalize authority and reject tampering", async () => {
  const envelope = await createEnvelope();

  assert.equal(envelope.version, 1);
  assert.equal(envelope.builtBy, "host");
  assert.match(envelope.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(envelope.capabilities, [
    "linear.write",
    "vault.read",
    "vault.write",
    "web.read",
    "workspace.execute",
  ]);
  assert.deepEqual(await parseMissionCapabilityEnvelopeV1(envelope), envelope);

  const tampered = clone(envelope);
  tampered.capabilities.push("github.merge");
  await rejectsCode(
    parseMissionCapabilityEnvelopeV1(tampered),
    "capability_envelope_tampered",
  );
});

test("MissionGraphV3 preserves routing fallback, resource locks, and strict shape", async () => {
  const graph = await createGraph();

  assert.equal(graph.schemaVersion, 3);
  assert.equal(graph.routing.source, "deterministic");
  assert.equal(graph.routing.fallbackFrom, "structured_model");
  assert.equal(graph.nodes.write.effect, "mutation");
  assert.deepEqual(graph.nodes.write.resourceLocks, [
    { bindingId: "note-main", mode: "exclusive" },
  ]);

  const unknownField = clone(graph) as MissionGraphV3 & { hiddenAuthority?: boolean };
  unknownField.hiddenAuthority = true;
  await rejectsCode(parseMissionGraphV3(unknownField), "invalid_shape");

  const invalidStatus = clone(graph) as unknown as {
    nodes: Record<string, { status: string }>;
  };
  invalidStatus.nodes.research.status = "waiting";
  await rejectsCode(parseMissionGraphV3(invalidStatus), "invalid_status");
});

test("MissionGraphV3 rejects cycles, envelope depth overflow, and more than 40 nodes", async () => {
  const cyclic = await createRawGraph();
  cyclic.nodes.research.dependencyIds = ["write"];
  await rejectsCode(parseMissionGraphV3(cyclic), "cycle");

  const tooDeep = await createRawGraph();
  tooDeep.nodes = {};
  for (let index = 1; index <= 5; index += 1) {
    const id = `node-${index}`;
    tooDeep.nodes[id] = createNode({
      id,
      dependencyIds: index === 1 ? [] : [`node-${index - 1}`],
      status: index === 1 ? "ready" : "queued",
    });
  }
  await rejectsCode(parseMissionGraphV3(tooDeep), "depth_limit");

  const tooMany = await createRawGraph();
  tooMany.nodes = {};
  for (let index = 1; index <= 41; index += 1) {
    const id = `node-${index}`;
    tooMany.nodes[id] = createNode({ id, status: index === 1 ? "ready" : "queued" });
  }
  await rejectsCode(parseMissionGraphV3(tooMany), "node_limit");
});

test("MissionGraphV3 rejects unknown executors, tools, capabilities, and bindings", async () => {
  const unknownExecutor = await createRawGraph();
  unknownExecutor.nodes.research.executorId = "invented-executor";
  await rejectsCode(parseMissionGraphV3(unknownExecutor), "unknown_executor");

  const unknownTool = await createRawGraph();
  unknownTool.nodes.research.allowedTools = ["arbitrary-shell"];
  await rejectsCode(parseMissionGraphV3(unknownTool), "unknown_tool");

  const unknownCapability = await createRawGraph();
  unknownCapability.nodes.research.requiredCapabilities = ["github.admin"];
  await rejectsCode(parseMissionGraphV3(unknownCapability), "unknown_capability");

  const unknownBinding = await createRawGraph();
  unknownBinding.nodes.write.destination = {
    bindingId: "note-attacker",
    effect: "mutation",
    selector: null,
  };
  await rejectsCode(parseMissionGraphV3(unknownBinding), "unknown_binding");

  const unknownLock = await createRawGraph();
  unknownLock.nodes.write.resourceLocks = [
    { bindingId: "note-attacker", mode: "exclusive" },
  ];
  await rejectsCode(parseMissionGraphV3(unknownLock), "unknown_binding");
});

test("MissionGraphV3 enforces aggregate and per-node budgets", async () => {
  const aggregate = await createRawGraph();
  aggregate.nodes.research.budget.toolCalls = 20;
  aggregate.nodes.write.budget.toolCalls = 20;
  await rejectsCode(parseMissionGraphV3(aggregate), "budget_exceeded");

  const retries = await createRawGraph();
  retries.nodes.research.retries.maxAttempts = 4;
  await rejectsCode(parseMissionGraphV3(retries), "invalid_shape");

  const external = await createRawGraph();
  external.nodes.research.budget.externalActions = 1;
  await rejectsCode(parseMissionGraphV3(external), "budget_exceeded");
});

test("patch reduction produces replayable prepared/applied WAL records and a checkpoint", async () => {
  const graph = await createGraph();
  const patch = createPatch(graph, "patch-complete-research", [
    statusOperation("research", "ready", "running"),
    {
      op: "append_evidence",
      nodeId: "research",
      evidence: {
        id: "evidence-web-1",
        kind: "web-source",
        fingerprint: fp("6"),
        observedAt: PATCHED_AT,
      },
    },
    {
      op: "record_verification",
      nodeId: "research",
      verification: {
        verifierId: "artifact-verifier",
        status: "passed",
        fingerprint: fp("7"),
        verifiedAt: PATCHED_AT,
      },
    },
    statusOperation("research", "running", "verifying"),
    statusOperation("research", "verifying", "complete"),
  ]);

  const result = await reduceMissionGraphPatchV1(graph, patch, {
    preparedAt: PATCHED_AT,
    appliedAt: PATCHED_AT,
  });

  assert.equal(result.graph.revision, 1);
  assert.equal(result.graph.nodes.research.status, "complete");
  assert.equal(result.graph.continuationCheckpoint?.graphRevision, 1);
  assert.deepEqual(result.graph.continuationCheckpoint?.activeNodeIds, []);
  assert.equal(result.preparedJournalEntry.state, "prepared");
  assert.equal(result.preparedJournalEntry.appliedAt, null);
  assert.deepEqual(result.preparedJournalEntry.patch, patch);
  assert.equal(result.journalEntry.state, "applied");
  assert.equal(result.journalEntry.appliedAt, PATCHED_AT);
  assert.equal(
    (await parseMissionGraphJournalEntryV1(result.preparedJournalEntry)).recordFingerprint,
    result.preparedJournalEntry.recordFingerprint,
  );

  const replayedBefore = await replayPreparedMissionGraphPatchV1(
    graph,
    result.preparedJournalEntry,
  );
  assert.deepEqual(replayedBefore.graph, result.graph);
  const replayedAfter = await replayPreparedMissionGraphPatchV1(
    result.graph,
    result.preparedJournalEntry,
  );
  assert.deepEqual(replayedAfter.graph, result.graph);
  assert.equal(replayedAfter.journalEntry.state, "applied");
});

test("journal parsing rejects a modified canonical patch body", async () => {
  const graph = await createGraph();
  const result = await reduceMissionGraphPatchV1(
    graph,
    createPatch(graph, "patch-output", [
      { op: "set_outputs", nodeId: "research", outputs: { summary: "Verified" } },
    ]),
    { appliedAt: PATCHED_AT },
  );
  const tampered = clone(result.preparedJournalEntry);
  const operation = tampered.patch.operations[0];
  if (operation.op !== "set_outputs") throw new Error("Unexpected fixture operation.");
  operation.outputs = { summary: "Tampered" };

  await rejectsCode(parseMissionGraphJournalEntryV1(tampered), "invalid_shape");
  await assert.rejects(markMissionGraphJournalAppliedV1(result.journalEntry), /Only a prepared/);
});

test("failure fingerprints retain total and consecutive unchanged-failure counts", async () => {
  const graph = await createGraph();
  const failure = fp("8");
  const first = await reduceMissionGraphPatchV1(
    graph,
    createPatch(graph, "patch-failures", [
      {
        op: "record_attempt",
        nodeId: "research",
        failureFingerprint: failure,
        observedAt: "2026-07-11T12:01:00.000Z",
      },
      {
        op: "record_attempt",
        nodeId: "research",
        failureFingerprint: failure,
        observedAt: "2026-07-11T12:01:30.000Z",
      },
    ]),
    { appliedAt: "2026-07-11T12:02:00.000Z" },
  );
  const retries = first.graph.nodes.research.retries;
  assert.equal(retries.failureFingerprints[0].count, 2);
  assert.equal(retries.consecutiveFailureFingerprint, failure);
  assert.equal(retries.consecutiveFailureCount, 2);

  const reset = await reduceMissionGraphPatchV1(
    first.graph,
    createPatch(first.graph, "patch-success-attempt", [
      {
        op: "record_attempt",
        nodeId: "research",
        failureFingerprint: null,
        observedAt: "2026-07-11T12:03:00.000Z",
      },
    ]),
    { appliedAt: "2026-07-11T12:03:00.000Z" },
  );
  assert.equal(reset.graph.nodes.research.retries.consecutiveFailureFingerprint, null);
  assert.equal(reset.graph.nodes.research.retries.consecutiveFailureCount, 0);
});

test("patches cannot change destinations, remove prerequisites, or widen tools and retries", async () => {
  const graph = await createGraph();
  await rejectsCode(
    reduceMissionGraphPatchV1(
      graph,
      createPatch(graph, "patch-destination", [
        {
          op: "update_node",
          nodeId: "write",
          changes: {
            destination: {
              bindingId: "note-main",
              effect: "mutation",
              selector: "other.md",
            },
          },
        },
      ]),
      { appliedAt: PATCHED_AT },
    ),
    "destination_changed",
  );

  await rejectsCode(
    reduceMissionGraphPatchV1(
      graph,
      createPatch(graph, "patch-tools", [
        {
          op: "update_node",
          nodeId: "research",
          changes: {
            requiredCapabilities: ["web.read", "vault.write"],
            allowedTools: ["web-search", "append-note"],
          },
        },
      ]),
      { appliedAt: PATCHED_AT },
    ),
    "authority_widening",
  );

  await rejectsCode(
    reduceMissionGraphPatchV1(
      graph,
      createPatch(graph, "patch-dependency", [
        {
          op: "update_node",
          nodeId: "write",
          changes: { dependencyIds: [] },
        },
      ]),
      { appliedAt: PATCHED_AT },
    ),
    "authority_widening",
  );

  await rejectsCode(
    reduceMissionGraphPatchV1(
      graph,
      createPatch(graph, "patch-retries", [
        {
          op: "update_node",
          nodeId: "research",
          changes: {
            retries: {
              ...graph.nodes.research.retries,
              maxAttempts: 4,
            },
          },
        },
      ]),
      { appliedAt: PATCHED_AT },
    ),
    "authority_widening",
  );
});

test("replanning rejects a new effectful executor node even when it names no effectful tool", async () => {
  const graph = await createGraph();
  const malicious = createNode({
    id: "extra-mutation",
    executorId: "core",
    effect: "mutation",
    requiredCapabilities: ["vault.write"],
    allowedTools: [],
    inputs: {
      note: { kind: "binding", bindingId: "note-main", selector: null },
    },
    destination: {
      bindingId: "note-main",
      effect: "mutation",
      selector: "unapproved.md",
    },
    resourceLocks: [{ bindingId: "note-main", mode: "exclusive" }],
    budget: { toolCalls: 0, externalActions: 0, wallClockMs: 1_000 },
    completionContract: {
      criteria: ["Mutation receipt exists."],
      minimumEvidence: 0,
      requiredEvidenceKinds: [],
      minimumReceipts: 1,
      requiredReceiptKinds: ["vault-write"],
      verifierId: null,
    },
  });

  await rejectsCode(
    reduceMissionGraphPatchV1(
      graph,
      createPatch(graph, "patch-malicious-mutation", [
        { op: "add_node", node: malicious },
      ]),
      { appliedAt: PATCHED_AT },
    ),
    "authority_widening",
  );
});

test("completion is proof-gated and completed nodes cannot be rewritten", async () => {
  const graph = await createGraph();
  const noProof = createPatch(graph, "patch-no-proof", [
    statusOperation("research", "ready", "running"),
    statusOperation("research", "running", "verifying"),
    statusOperation("research", "verifying", "complete"),
  ]);
  await rejectsCode(
    reduceMissionGraphPatchV1(graph, noProof, { appliedAt: PATCHED_AT }),
    "proof_incomplete",
  );

  const complete = await completeResearch(graph);
  await rejectsCode(
    reduceMissionGraphPatchV1(
      complete.graph,
      createPatch(complete.graph, "patch-rewrite-complete", [
        {
          op: "update_node",
          nodeId: "research",
          changes: { objective: "Rewrite completed work." },
        },
      ]),
      { appliedAt: "2026-07-11T12:02:00.000Z" },
    ),
    "completed_node_immutable",
  );
});

test("stale graph revisions and journal heads fail closed", async () => {
  const graph = await createGraph();
  const staleRevision = createPatch(graph, "patch-stale-revision", [
    { op: "set_outputs", nodeId: "research", outputs: { value: true } },
  ]);
  staleRevision.baseRevision = 99;
  await rejectsCode(
    reduceMissionGraphPatchV1(graph, staleRevision, { appliedAt: PATCHED_AT }),
    "stale_revision",
  );

  const staleJournal = createPatch(graph, "patch-stale-journal", [
    { op: "set_outputs", nodeId: "research", outputs: { value: true } },
  ]);
  staleJournal.baseJournalFingerprint = fp("9");
  await rejectsCode(
    reduceMissionGraphPatchV1(graph, staleJournal, { appliedAt: PATCHED_AT }),
    "stale_journal",
  );
});

async function createEnvelope(): Promise<MissionCapabilityEnvelopeV1> {
  return buildMissionCapabilityEnvelopeV1({
    missionId: "mission-1",
    issuedAt: CREATED_AT,
    expiresAt: null,
    capabilities: [
      "vault.read",
      "vault.write",
      "web.read",
      "workspace.execute",
      "linear.write",
    ],
    executionHosts: ["obsidian_core", "headless_runtime"],
    executors: {
      core: {
        id: "core",
        executionHosts: ["obsidian_core"],
        allowedEffects: ["read", "mutation", "external_action"],
      },
      worker: {
        id: "worker",
        executionHosts: ["headless_runtime"],
        allowedEffects: ["read", "execution"],
      },
    },
    verifiers: ["artifact-verifier"],
    tools: {
      "web-search": {
        name: "web-search",
        effect: "read",
        capabilityIds: ["web.read"],
        executionHosts: ["obsidian_core", "headless_runtime"],
        bindingKinds: [],
      },
      "append-note": {
        name: "append-note",
        effect: "mutation",
        capabilityIds: ["vault.write"],
        executionHosts: ["obsidian_core"],
        bindingKinds: ["vault-note"],
      },
      "run-tests": {
        name: "run-tests",
        effect: "execution",
        capabilityIds: ["workspace.execute"],
        executionHosts: ["headless_runtime"],
        bindingKinds: ["repository"],
      },
      "linear-create": {
        name: "linear-create",
        effect: "external_action",
        capabilityIds: ["linear.write"],
        executionHosts: ["obsidian_core"],
        bindingKinds: ["linear-team"],
      },
    },
    bindings: {
      "note-main": {
        id: "note-main",
        kind: "vault-note",
        destinationFingerprint: fp("1"),
        allowedEffects: ["read", "mutation"],
      },
      "repo-main": {
        id: "repo-main",
        kind: "repository",
        destinationFingerprint: fp("2"),
        allowedEffects: ["read", "mutation", "execution"],
      },
      "linear-team": {
        id: "linear-team",
        kind: "linear-team",
        destinationFingerprint: fp("3"),
        allowedEffects: ["read", "external_action"],
      },
    },
    budgets: {
      maxNodes: 24,
      maxDepth: 4,
      maxConcurrentReadNodes: 3,
      maxTotalToolCalls: 24,
      maxExternalActions: 4,
      maxWallClockMs: 120_000,
      maxAttemptsPerNode: 3,
    },
  });
}

async function createRawGraph(): Promise<MissionGraphV3> {
  const envelope = await createEnvelope();
  return {
    schemaVersion: 3,
    missionId: "mission-1",
    objective: "Research a claim and write the accepted result.",
    revision: 0,
    journalHeadFingerprint: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    routing: {
      source: "deterministic",
      fallbackFrom: "structured_model",
      fallbackReason: "Structured router timed out.",
      confidence: 0.7,
      decidedAt: CREATED_AT,
      decisionFingerprint: fp("4"),
    },
    continuationCheckpoint: null,
    capabilityEnvelope: envelope,
    nodes: {
      research: createNode({
        id: "research",
        objective: "Research the requested claim with verifiable sources.",
        requiredCapabilities: ["web.read"],
        allowedTools: ["web-search"],
        status: "ready",
        completionContract: {
          criteria: ["At least one verified web source supports the result."],
          minimumEvidence: 1,
          requiredEvidenceKinds: ["web-source"],
          minimumReceipts: 0,
          requiredReceiptKinds: [],
          verifierId: "artifact-verifier",
        },
      }),
      write: createNode({
        id: "write",
        dependencyIds: ["research"],
        objective: "Append the accepted research to the trusted note.",
        effect: "mutation",
        requiredCapabilities: ["vault.write"],
        allowedTools: ["append-note"],
        inputs: {
          note: { kind: "binding", bindingId: "note-main", selector: null },
        },
        destination: {
          bindingId: "note-main",
          effect: "mutation",
          selector: "Research.md",
        },
        resourceLocks: [{ bindingId: "note-main", mode: "exclusive" }],
        budget: { toolCalls: 1, externalActions: 0, wallClockMs: 10_000 },
        completionContract: {
          criteria: ["The note write is read back and receipted."],
          minimumEvidence: 0,
          requiredEvidenceKinds: [],
          minimumReceipts: 1,
          requiredReceiptKinds: ["vault-write"],
          verifierId: null,
        },
      }),
    },
  };
}

async function createGraph(): Promise<MissionGraphV3> {
  return parseMissionGraphV3(await createRawGraph());
}

function createNode(overrides: Partial<MissionNodeV3>): MissionNodeV3 {
  return {
    id: "node",
    dependencyIds: [],
    objective: "Perform one bounded read-only mission step.",
    executorId: "core",
    executionHost: "obsidian_core",
    effect: "read",
    inputs: {},
    outputs: {},
    requiredCapabilities: ["web.read"],
    allowedTools: ["web-search"],
    destination: null,
    resourceLocks: [],
    budget: { toolCalls: 1, externalActions: 0, wallClockMs: 5_000 },
    retries: {
      maxAttempts: 3,
      attempts: 0,
      failureFingerprints: [],
      consecutiveFailureFingerprint: null,
      consecutiveFailureCount: 0,
    },
    status: "queued",
    evidence: [],
    receipts: [],
    verification: null,
    completionContract: {
      criteria: ["A verified source is recorded."],
      minimumEvidence: 1,
      requiredEvidenceKinds: ["web-source"],
      minimumReceipts: 0,
      requiredReceiptKinds: [],
      verifierId: "artifact-verifier",
    },
    blocker: null,
    ...overrides,
  };
}

function createPatch(
  graph: MissionGraphV3,
  patchId: string,
  operations: MissionGraphPatchOperationV1[],
): MissionGraphPatchV1 {
  return {
    version: 1,
    patchId,
    missionId: graph.missionId,
    baseRevision: graph.revision,
    baseJournalFingerprint: graph.journalHeadFingerprint,
    proposedAt: PATCHED_AT,
    reason: "Advance the bounded mission using observed evidence.",
    operations,
  };
}

function statusOperation(
  nodeId: string,
  expectedStatus: MissionNodeV3["status"],
  status: MissionNodeV3["status"],
): MissionGraphPatchOperationV1 {
  return {
    op: "set_status",
    nodeId,
    expectedStatus,
    status,
    blocker: null,
  };
}

async function completeResearch(graph: MissionGraphV3) {
  return reduceMissionGraphPatchV1(
    graph,
    createPatch(graph, "patch-complete-for-immutability", [
      statusOperation("research", "ready", "running"),
      {
        op: "append_evidence",
        nodeId: "research",
        evidence: {
          id: "evidence-complete",
          kind: "web-source",
          fingerprint: fp("a"),
          observedAt: PATCHED_AT,
        },
      },
      {
        op: "record_verification",
        nodeId: "research",
        verification: {
          verifierId: "artifact-verifier",
          status: "passed",
          fingerprint: fp("b"),
          verifiedAt: PATCHED_AT,
        },
      },
      statusOperation("research", "running", "verifying"),
      statusOperation("research", "verifying", "complete"),
    ]),
    { appliedAt: PATCHED_AT },
  );
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function rejectsCode(
  promise: Promise<unknown>,
  code: MissionGraphValidationError["code"],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MissionGraphValidationError);
    assert.equal(error.code, code);
    return true;
  });
}
