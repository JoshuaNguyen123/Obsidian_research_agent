import assert from "node:assert/strict";
import test from "node:test";
import { buildHostMissionGraphPlanV1 } from "../src/agent/missionGraphHost";
import { constrainToolsToMissionGraphFrontier } from "../src/agent/missionGraphFrontier";
import { planMissionGraphV3 } from "../src/agent/missionGraphPlanner";
import {
  MissionGraphSession,
  resolveMissionGraphEvidenceKind,
  type MissionGraphToolExecution,
  type MissionGraphToolStartResult,
} from "../src/agent/missionGraphSession";
import {
  reconcileCompositeOwnedCurrentNoteGraphOnResume,
  type ResearchPublicationResumeReceiptV1,
} from "../src/agent/researchPublicationGraphReconciliation";
import {
  getMissionGraphStorePath,
  persistPreparedMissionGraphPatch,
  readMissionGraphStoreRecord,
} from "../src/agent/missionGraphStore";
import type { ToolDescriptor } from "../src/agent/actions";
import { sha256DiagramContent } from "../src/design/diagramArtifactStore";
import {
  appendWorkItemLineageTransitionV1,
  createAcceptedResearchArtifactV1,
  createExternalWorkItemBindingV1,
  createWorkItemLineageV1,
  createWorkItemSpecV2,
  renderQueueExecutableHumanWorkItemSpecV2,
} from "../src/integrations/linear";
import {
  getCurrentMissionCompositeLifecycleActionV1,
  getMissionCompositeLifecycleStateV1,
  validateMissionGraphV3,
  type MissionEvidenceRefV1,
  type MissionGraphPatchV1,
  type MissionGraphV3,
  type MissionNodeV3,
  type MissionReceiptRefV1,
} from "../src/agent/missionGraphV3";
import { descriptorFor } from "../src/tools/toolDescriptors";
import type { ToolExecutionContext, ToolRegistry } from "../src/tools/types";

const GRAPH_TIME = new Date("2026-07-11T18:00:00.000Z");

test("beginToolExecution recovers an orphaned running node back to ready", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-orphan-running-recover",
    allowedTools: ["replace_current_file"],
    plannedTools: ["replace_current_file"],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const first = requireExecution(
    await session.beginToolExecution("replace_current_file"),
  );
  assert.equal(session.graph.nodes[first.nodeId]?.status, "running");
  // Simulate a host early-return that forgot finishToolExecution: node stays
  // running with no in-flight lease. The next begin must heal and restart.
  const recovered = requireExecution(
    await session.beginToolExecution("replace_current_file"),
  );
  assert.equal(recovered.nodeId, first.nodeId);
  assert.equal(session.graph.nodes[recovered.nodeId]?.status, "running");
  await session.finishToolExecution(recovered, {
    ok: false,
    failureFingerprint: fp("f"),
    failureMessage: "path mismatch",
  });
  assert.equal(session.graph.nodes[recovered.nodeId]?.status, "ready");
});

test("parallel same-name reads never recover an intentionally running node", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-parallel-same-name-reads",
    allowedTools: ["web_fetch"],
    // Only one planned slot: the other deliberately concurrent reads must
    // receive distinct bounded retry nodes instead of recovering each other.
    plannedTools: ["web_fetch"],
    maxToolCalls: 6,
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });

  const executions: MissionGraphToolExecution[] = [];
  for (let index = 0; index < 3; index += 1) {
    executions.push(
      requireExecution(
        await session.beginToolExecution("web_fetch", {
          recoverOrphanedRunning: false,
        }),
      ),
    );
  }

  assert.equal(new Set(executions.map((item) => item.nodeId)).size, 3);
  assert.equal(
    executions.filter((item) => /^retry-/u.test(item.nodeId)).length,
    2,
  );
  for (const execution of executions) {
    assert.equal(session.graph.nodes[execution.nodeId]?.status, "running");
  }

  for (let index = 0; index < executions.length; index += 1) {
    const execution = executions[index]!;
    const node = session.graph.nodes[execution.nodeId]!;
    await session.finishToolExecution(execution, {
      ok: true,
      evidence: evidenceFor(
        node,
        String(index + 1),
        harness.nextTimestamp(),
      ),
    });
  }
  for (const execution of executions) {
    assert.equal(session.graph.nodes[execution.nodeId]?.status, "complete");
  }
});

test("final output cancels every non-terminal node outside the required closure", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-terminalizes-off-path-nodes",
    allowedTools: ["read_file", "replace_current_file"],
    plannedTools: ["read_file", "replace_current_file"],
  });
  const readNode = toolNode(graph, "read_file");
  const writeNode = toolNode(graph, "replace_current_file");
  const originalReadId = readNode.id;
  const optionalReadId = "optional-stale-read";
  delete graph.nodes[originalReadId];
  readNode.id = optionalReadId;
  readNode.status = "blocked";
  readNode.blocker = {
    code: "tool_failure_terminal",
    message: "Optional read failed before the required write completed.",
    requiredAction: "Skip this off-path enrichment.",
  };
  graph.nodes[optionalReadId] = readNode;
  for (const candidate of Object.values(graph.nodes)) {
    candidate.dependencyIds = candidate.dependencyIds.flatMap((dependencyId) =>
      dependencyId === originalReadId ? readNode.dependencyIds : [dependencyId],
    );
  }
  writeNode.status = "ready";

  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const execution = requireExecution(
    await session.beginToolExecution("replace_current_file"),
  );
  const executingNode = session.graph.nodes[execution.nodeId]!;
  await session.finishToolExecution(execution, {
    ok: true,
    evidence: evidenceFor(
      executingNode,
      "7",
      harness.nextTimestamp(),
    ),
    receipt: receiptFor(
      executingNode,
      "8",
      harness.nextTimestamp(),
    ),
  });
  assert.equal(session.graph.nodes.final.status, "ready");

  const terminal = await session.completeFinalOutput({
    outputFingerprint: fp("9"),
    observedAt: harness.nextTimestamp(),
  });
  assert.equal(terminal.nodes.final.status, "complete");
  assert.equal(terminal.nodes[optionalReadId]?.status, "cancelled");
  assert.equal(terminal.nodes[optionalReadId]?.blocker, null);
  assert.ok(
    Object.values(terminal.nodes).every((node) =>
      ["complete", "cancelled"].includes(node.status),
    ),
  );
});

test("final output preserves the canonical host post-acceptance action until it runs", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-preserves-host-post-acceptance",
    allowedTools: ["replace_current_file", "append_research_memory"],
    plannedTools: ["replace_current_file"],
    postAcceptanceTools: ["append_research_memory"],
  });
  const postAcceptanceNode = toolNode(graph, "append_research_memory");
  assert.match(
    postAcceptanceNode.id,
    /^post-acceptance-tool-\d{2}-append_research_memory$/u,
  );

  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const writeExecution = requireExecution(
    await session.beginToolExecution("replace_current_file"),
  );
  const writeNode = session.graph.nodes[writeExecution.nodeId]!;
  await session.finishToolExecution(writeExecution, {
    ok: true,
    evidence: evidenceFor(writeNode, "a", harness.nextTimestamp()),
    receipt: receiptFor(writeNode, "b", harness.nextTimestamp()),
  });
  assert.equal(session.graph.nodes.final.status, "ready");
  assert.equal(
    session.graph.nodes[postAcceptanceNode.id]?.status,
    "ready",
  );

  const accepted = await session.completeFinalOutput({
    outputFingerprint: fp("c"),
    observedAt: harness.nextTimestamp(),
  });
  assert.equal(accepted.nodes.final.status, "complete");
  assert.equal(
    accepted.nodes[postAcceptanceNode.id]?.status,
    "ready",
    "the host-owned post-acceptance action must remain callable after final proof",
  );

  const memoryExecution = requireExecution(
    await session.beginToolExecution("append_research_memory"),
  );
  const memoryNode = session.graph.nodes[memoryExecution.nodeId]!;
  const terminal = await session.finishToolExecution(memoryExecution, {
    ok: true,
    evidence: evidenceFor(memoryNode, "d", harness.nextTimestamp()),
  });
  assert.equal(terminal.nodes[postAcceptanceNode.id]?.status, "complete");
  assert.ok(
    Object.values(terminal.nodes).every((node) =>
      ["complete", "cancelled"].includes(node.status),
    ),
  );
});

test("canonical evidence kinds satisfy the exact graph contract without weakening generic nodes", () => {
  assert.equal(
    resolveMissionGraphEvidenceKind("vault_note", ["vault-note"]),
    "vault-note",
  );
  assert.equal(
    resolveMissionGraphEvidenceKind("web_source", ["web-source"]),
    "web-source",
  );
  assert.equal(
    resolveMissionGraphEvidenceKind("vault_note", ["tool-result"]),
    "tool-result",
  );
  assert.equal(
    resolveMissionGraphEvidenceKind("vault_note", ["signed-evidence"]),
    "vault-note",
  );
});

test("semantic vault evidence completes a vault-note graph node", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-semantic-vault-evidence",
    allowedTools: ["semantic_search_notes"],
    plannedTools: ["semantic_search_notes"],
  });
  const plannedNode = toolNode(graph, "semantic_search_notes");
  plannedNode.completionContract = {
    ...plannedNode.completionContract,
    minimumEvidence: 1,
    requiredEvidenceKinds: ["vault-note"],
  };
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const execution = requireExecution(
    await session.beginToolExecution("semantic_search_notes"),
  );
  const node = session.graph.nodes[execution.nodeId];

  const completed = await session.finishToolExecution(execution, {
    ok: true,
    evidence: {
      id: "vault_search:semantic-local-retrieval",
      kind: resolveMissionGraphEvidenceKind(
        "vault_note",
        node.completionContract.requiredEvidenceKinds,
      ),
      fingerprint: fp("a"),
      observedAt: harness.nextTimestamp(),
    },
  });

  assert.equal(completed.nodes[execution.nodeId].status, "complete");
  assert.equal(completed.nodes[execution.nodeId].evidence[0]?.kind, "vault-note");
  assert.equal(completed.nodes[execution.nodeId].blocker, null);
});

test("open persists the authoritative graph before any tool can start", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-persist-first",
    allowedTools: ["read_current_file"],
    plannedTools: ["read_current_file"],
  });

  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });

  const path = getMissionGraphStorePath(graph.missionId);
  assert.ok(harness.files.has(path));
  assert.equal(
    harness.writes.find((entry) => entry.startsWith("create:")),
    `create:${path}`,
  );
  const beforeStart = await requireStored(harness.context, graph.missionId);
  assert.equal(toolNode(beforeStart.record.graph, "read_current_file").status, "ready");

  const execution = requireExecution(
    await session.beginToolExecution("read_current_file"),
  );
  assert.equal(execution.toolName, "read_current_file");
  const afterStart = await requireStored(harness.context, graph.missionId);
  assert.equal(afterStart.record.graph.nodes[execution.nodeId].status, "running");
  assert.ok(afterStart.record.storeRevision > beforeStart.record.storeRevision);
});

test("successful proof completes a node, promotes dependencies, and persists approval state", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-proof-promotion",
    allowedTools: ["read_current_file", "append_to_current_file"],
    plannedTools: ["read_current_file", "append_to_current_file"],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });

  const readExecution = requireExecution(
    await session.beginToolExecution("read_current_file"),
  );
  const readNode = session.graph.nodes[readExecution.nodeId];
  const afterRead = await session.finishToolExecution(readExecution, {
    ok: true,
    evidence: evidenceFor(readNode, "1", harness.nextTimestamp()),
  });
  assert.equal(afterRead.nodes[readExecution.nodeId].status, "complete");
  assert.equal(toolNode(afterRead, "append_to_current_file").status, "ready");

  const writeExecution = requireExecution(
    await session.beginToolExecution("append_to_current_file"),
  );
  await session.waitForToolApproval(writeExecution);
  assert.equal(session.graph.nodes[writeExecution.nodeId].status, "waiting_approval");
  await session.resolveToolApproval(writeExecution, true);
  assert.equal(session.graph.nodes[writeExecution.nodeId].status, "running");

  const writeNode = session.graph.nodes[writeExecution.nodeId];
  const afterWrite = await session.finishToolExecution(writeExecution, {
    ok: true,
    evidence: evidenceFor(writeNode, "2", harness.nextTimestamp()),
    receipt: receiptFor(writeNode, "3", harness.nextTimestamp()),
  });
  assert.equal(afterWrite.nodes[writeExecution.nodeId].status, "complete");
  assert.equal(afterWrite.nodes.final.status, "ready");
  const stored = await requireStored(harness.context, graph.missionId);
  assert.deepEqual(stored.record.resourceLocks.locks, {});
});

test("composite lifecycle advances one durable action at a time and rejects wrong or replayed tools", async () => {
  const harness = createVaultHarness();
  const graph = await compositeLifecycleGraphFor(
    "session-composite-lifecycle-cursor",
  );
  let session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const acceptedNodeId = "lifecycle-accepted_research";
  const linearNodeId = "lifecycle-linear_hierarchy";

  const prematurePublish = await session.beginToolExecution(
    "publish_research_to_linear",
  );
  assert.equal(prematurePublish.ok, false);
  if (!prematurePublish.ok) {
    assert.match(prematurePublish.reason, /expected web_search/u);
  }

  const search = requireExecution(
    await session.beginToolExecution("web_search"),
  );
  assert.match(search.lifecycleActionId ?? "", /web_search/u);
  const afterSearch = await session.finishToolExecution(search, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[acceptedNodeId],
      "1",
      harness.nextTimestamp(),
    ),
  });
  assert.equal(afterSearch.nodes[acceptedNodeId].status, "ready");
  assert.equal(afterSearch.nodes[acceptedNodeId].retries.attempts, 0);
  assert.deepEqual(
    getMissionCompositeLifecycleStateV1(afterSearch.nodes[acceptedNodeId]),
    {
      actionCursor: 1,
      completedActionIds: ["action-001-web_search"],
      skippedActionIds: [],
      actionAttemptCounts: { "action-001-web_search": 1 },
    },
  );

  session = await MissionGraphSession.resume({
    context: harness.context,
    missionId: graph.missionId,
  });
  const replay = await session.beginToolExecution("web_search");
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.match(replay.reason, /already completed/u);

  const publication = requireExecution(
    await session.beginToolExecution("publish_research_to_linear"),
  );
  const accepted = session.graph.nodes[acceptedNodeId];
  const afterAccepted = await session.finishToolExecution(publication, {
    ok: true,
    evidence: evidenceFor(accepted, "2", harness.nextTimestamp()),
    receipt: receiptFor(accepted, "3", harness.nextTimestamp()),
  });
  assert.equal(afterAccepted.nodes[acceptedNodeId].status, "complete");
  assert.equal(afterAccepted.nodes[linearNodeId].status, "ready");

  const wrongLinearRead = await session.beginToolExecution("linear_get_issue");
  assert.equal(wrongLinearRead.ok, false);
  if (!wrongLinearRead.ok) {
    assert.match(wrongLinearRead.reason, /publish_research_project_to_linear/u);
  }

  const hierarchyFirst = requireExecution(
    await session.beginToolExecution("publish_research_project_to_linear"),
  );
  const failureFingerprint = fp("9");
  const afterFailure = await session.finishToolExecution(hierarchyFirst, {
    ok: false,
    failureFingerprint,
    failureMessage: "Transient prepared hierarchy failure.",
  });
  assert.equal(afterFailure.nodes[linearNodeId].status, "ready");
  assert.equal(afterFailure.nodes[linearNodeId].retries.attempts, 1);

  const hierarchyRetry = requireExecution(
    await session.beginToolExecution("publish_research_project_to_linear"),
  );
  const linearNode = session.graph.nodes[linearNodeId];
  const afterHierarchy = await session.finishToolExecution(hierarchyRetry, {
    ok: true,
    evidence: evidenceFor(linearNode, "4", harness.nextTimestamp()),
    receipt: receiptFor(linearNode, "5", harness.nextTimestamp()),
  });
  assert.equal(afterHierarchy.nodes[linearNodeId].status, "ready");
  assert.equal(afterHierarchy.nodes[linearNodeId].retries.attempts, 0);

  const readback = requireExecution(
    await session.beginToolExecution("linear_get_issue"),
  );
  const completed = await session.finishToolExecution(readback, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[linearNodeId],
      "6",
      harness.nextTimestamp(),
    ),
  });
  assert.equal(completed.nodes[linearNodeId].status, "complete");
  assert.equal(completed.nodes.final.status, "ready");
  assert.deepEqual(
    getMissionCompositeLifecycleStateV1(completed.nodes[linearNodeId])
      ?.actionAttemptCounts,
    {
      "action-001-publish_research_project_to_linear": 2,
      "action-002-linear_get_issue": 1,
    },
  );
});

test("composite lifecycle rejects a persisted cursor without completed-prefix proof", async () => {
  const graph = await compositeLifecycleGraphFor(
    "session-composite-lifecycle-proof-bound-cursor",
  );
  const tampered = JSON.parse(JSON.stringify(graph)) as MissionGraphV3;
  tampered.nodes["lifecycle-accepted_research"].outputs = {
    lifecycleActionCursor: 1,
    lifecycleCompletedActionIds: ["action-001-web_search"],
    lifecycleActionAttemptCounts: { "action-001-web_search": 1 },
  };

  assert.throws(
    () => validateMissionGraphV3(tampered),
    /cursor exceeds its durable action proof/u,
  );
});

test("green fast validation skips the conditional repair checkpoint", async () => {
  const harness = createVaultHarness();
  const graph = await conditionalCodeLifecycleGraphFor(
    "session-conditional-code-repair",
  );
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const research = requireExecution(
    await session.beginToolExecution("web_search"),
  );
  await session.finishToolExecution(research, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[research.nodeId],
      "1",
      harness.nextTimestamp(),
    ),
  });
  const create = requireExecution(
    await session.beginToolExecution("code_workspace_create"),
  );
  await session.finishToolExecution(create, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[create.nodeId],
      "2",
      harness.nextTimestamp(),
    ),
  });
  const fast = requireExecution(
    await session.beginToolExecution("code_validate_fast"),
  );
  const afterFast = await session.finishToolExecution(fast, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[fast.nodeId],
      "3",
      harness.nextTimestamp(),
    ),
    skipNextToolNames: ["code_repair_record_cycle"],
  });
  assert.deepEqual(
    getMissionCompositeLifecycleStateV1(afterFast.nodes[fast.nodeId]),
    {
      actionCursor: 2,
      completedActionIds: ["action-001-code_validate_fast"],
      skippedActionIds: ["action-002-code_repair_record_cycle"],
      actionAttemptCounts: {
        "action-001-code_validate_fast": 1,
      },
    },
  );
  const repair = await session.beginToolExecution(
    "code_repair_record_cycle",
  );
  assert.equal(repair.ok, false);
  if (!repair.ok) assert.match(repair.reason, /expected code_validate_targeted/u);
  assert.equal(
    (await session.beginToolExecution("code_validate_targeted")).ok,
    true,
  );
});

test("consecutive repaired conventional checkpoints each insert a fresh receipt-bound fast cycle before targeted validation", async () => {
  const harness = createVaultHarness();
  const missionId = "session-conventional-conditional-code-repair";
  const names = [
    "code_validate_fast",
    "code_repair_record_cycle",
    "code_validate_targeted",
  ];
  const descriptors = [
    sessionLifecycleDescriptor(
      "code_validate_fast",
      "workspace",
      "reversible_mutation",
    ),
    sessionLifecycleDescriptor(
      "code_repair_record_cycle",
      "workspace",
      "reversible_mutation",
    ),
    sessionLifecycleDescriptor(
      "code_validate_targeted",
      "workspace",
      "reversible_mutation",
    ),
  ];
  const byName = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor] as const),
  );
  const registry: ToolRegistry = {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    getDescriptor: (name) => byName.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
  const host = await buildHostMissionGraphPlanV1({
    missionId,
    objective: "Execute the bounded session fixture mission.",
    toolRegistry: registry,
    allowedToolNames: names,
    plannedToolNames: names,
    maxToolCalls: 12,
    maxWallClockMs: 120_000,
    now: GRAPH_TIME,
  });
  const graph = (
    await planMissionGraphV3({
      mission: {
        missionId,
        objective: "Execute the bounded session fixture mission.",
      },
      routerMode: "off",
      capabilityEnvelope: host.capabilityEnvelope,
      deterministicProposal: host.deterministicProposal,
      allowedToolDescriptors: host.allowedToolDescriptors,
      now: () => GRAPH_TIME.toISOString(),
    })
  ).graph;
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const fast = requireExecution(
    await session.beginToolExecution("code_validate_fast"),
  );
  const fastEvidence = evidenceFor(
    session.graph.nodes[fast.nodeId],
    "4",
    harness.nextTimestamp(),
  );
  const afterFast = await session.finishToolExecution(fast, {
    ok: true,
    evidence: fastEvidence,
    receipt: receiptFor(
      session.graph.nodes[fast.nodeId],
      "5",
      harness.nextTimestamp(),
    ),
    skipNextToolNames: ["code_repair_record_cycle"],
  });
  const repair = toolNode(afterFast, "code_repair_record_cycle");
  assert.equal(repair.status, "ready");
  assert.equal(repair.retries.attempts, 0);
  assert.equal(repair.evidence.length, 0);
  assert.equal(repair.receipts.length, 0);
  assert.equal(
    toolNode(afterFast, "code_validate_targeted").status,
    "queued",
  );
  const repairExecution = requireExecution(
    await session.beginToolExecution("code_repair_record_cycle", {
      allowDynamicReadContinuation: false,
    }),
  );
  const envelopeFingerprint =
    session.graph.capabilityEnvelope.fingerprint;
  const beforeScheduleNodeCount = Object.keys(session.graph.nodes).length;
  const scheduled = await session.scheduleRepairedFastValidationCycle(
    repairExecution,
  );
  assert.equal(Object.keys(scheduled.nodes).length, beforeScheduleNodeCount + 2);
  const repeatedFast = Object.values(scheduled.nodes).find(
    (candidate) =>
      candidate.id !== fast.nodeId &&
      candidate.allowedTools.includes("code_validate_fast"),
  );
  const repeatedRepair = Object.values(scheduled.nodes).find(
    (candidate) =>
      candidate.id !== repairExecution.nodeId &&
      candidate.allowedTools.includes("code_repair_record_cycle"),
  );
  assert.ok(repeatedFast);
  assert.ok(repeatedRepair);
  assert.equal(repeatedFast.status, "queued");
  assert.deepEqual(
    repeatedFast.dependencyIds,
    session.graph.nodes[fast.nodeId]?.dependencyIds,
  );
  assert.equal(repeatedRepair.status, "queued");
  assert.deepEqual(
    repeatedRepair.dependencyIds,
    [...new Set([
      ...session.graph.nodes[repairExecution.nodeId]!.dependencyIds,
      repeatedFast.id,
    ])].sort(),
  );
  assert.ok(
    toolNode(scheduled, "code_validate_targeted").dependencyIds.includes(
      repeatedRepair.id,
    ),
  );
  assert.ok(
    graphBudget(scheduled).toolCalls <=
      scheduled.capabilityEnvelope.budgets.maxTotalToolCalls,
  );
  assert.equal(
    scheduled.capabilityEnvelope.fingerprint,
    envelopeFingerprint,
  );
  const idempotent = await session.scheduleRepairedFastValidationCycle(
    repairExecution,
  );
  assert.equal(Object.keys(idempotent.nodes).length, beforeScheduleNodeCount + 2);

  const afterRepair = await session.finishToolExecution(repairExecution, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[repairExecution.nodeId],
      "6",
      harness.nextTimestamp(),
    ),
    receipt: receiptFor(
      session.graph.nodes[repairExecution.nodeId],
      "7",
      harness.nextTimestamp(),
    ),
  });
  assert.equal(
    afterRepair.nodes[repairExecution.nodeId]?.status,
    "complete",
  );
  assert.equal(
    toolNode(afterRepair, "code_validate_targeted").status,
    "queued",
  );
  assert.equal(afterRepair.nodes[repeatedFast.id]?.status, "queued");
  assert.equal(
    (await session.beginToolExecution("code_validate_fast")).ok,
    false,
    "the repeated fast node stays unavailable until a successful mutation receipt is recorded",
  );
  const afterPrematurePromotion = await session.promoteReadyNodes();
  assert.equal(
    afterPrematurePromotion.nodes[repeatedFast.id]?.status,
    "queued",
    "generic readiness promotion cannot bypass the correction receipt gate",
  );
  const unrelatedCorrection =
    await session.recordValidationRecoveryCorrection({
      toolName: "code_workspace_create_file",
      path: "src/run_marker.py",
      eligiblePaths: ["src/game.ts"],
      receiptId: "receipt-unrelated-fast-correction",
      receiptFingerprint: fp("7"),
      observedAt: harness.nextTimestamp(),
    });
  assert.equal(unrelatedCorrection.recorded, false);
  assert.equal(
    unrelatedCorrection.graph.nodes[repeatedFast.id]?.status,
    "queued",
    "a changed but ineligible helper path cannot unlock fresh validation",
  );
  const firstCorrection = await session.recordValidationRecoveryCorrection({
    toolName: "code_workspace_patch",
    path: "src/game.ts",
    eligiblePaths: ["src/game.ts"],
    receiptId: "receipt-first-fast-correction",
    receiptFingerprint: fp("8"),
    observedAt: harness.nextTimestamp(),
  });
  assert.equal(firstCorrection.recorded, true);
  assert.deepEqual(
    Object.values(firstCorrection.graph.nodes)
      .filter(
        (candidate) =>
          candidate.status === "ready" &&
          afterPrematurePromotion.nodes[candidate.id]?.status !== "ready",
      )
      .map((candidate) => candidate.id),
    [repeatedFast.id],
    "the correction receipt unlocks exactly its bound fast-validation node",
  );
  assert.equal(
    (
      firstCorrection.graph.nodes[repeatedRepair.id]?.outputs
        .validationRecovery as { status?: unknown }
    )?.status,
    "correction_recorded",
  );

  const repeatedFastExecution = requireExecution(
    await session.beginToolExecution("code_validate_fast"),
  );
  assert.equal(repeatedFastExecution.nodeId, repeatedFast.id);
  const afterRepeatedFast = await session.finishToolExecution(
    repeatedFastExecution,
    {
      ok: true,
      evidence: evidenceFor(
        session.graph.nodes[repeatedFastExecution.nodeId],
        "8",
        harness.nextTimestamp(),
      ),
      receipt: receiptFor(
        session.graph.nodes[repeatedFastExecution.nodeId],
        "9",
        harness.nextTimestamp(),
      ),
    },
  );
  assert.equal(afterRepeatedFast.nodes[repeatedRepair.id]?.status, "ready");
  assert.equal(
    toolNode(afterRepeatedFast, "code_validate_targeted").status,
    "queued",
  );

  const repeatedRepairExecution = requireExecution(
    await session.beginToolExecution("code_repair_record_cycle"),
  );
  assert.equal(repeatedRepairExecution.nodeId, repeatedRepair.id);
  const beforeSecondScheduleNodeIds = new Set(
    Object.keys(session.graph.nodes),
  );
  const secondScheduled = await session.scheduleRepairedFastValidationCycle(
    repeatedRepairExecution,
  );
  assert.equal(
    Object.keys(secondScheduled.nodes).length,
    beforeSecondScheduleNodeIds.size + 2,
  );
  const secondRepeatedFast = Object.values(secondScheduled.nodes).find(
    (candidate) =>
      !beforeSecondScheduleNodeIds.has(candidate.id) &&
      candidate.allowedTools.includes("code_validate_fast"),
  );
  const secondRepeatedRepair = Object.values(secondScheduled.nodes).find(
    (candidate) =>
      !beforeSecondScheduleNodeIds.has(candidate.id) &&
      candidate.allowedTools.includes("code_repair_record_cycle"),
  );
  assert.ok(secondRepeatedFast);
  assert.ok(secondRepeatedRepair);
  assert.equal(secondRepeatedFast.status, "queued");
  assert.equal(secondRepeatedRepair.status, "queued");
  assert.ok(
    toolNode(secondScheduled, "code_validate_targeted").dependencyIds.includes(
      secondRepeatedRepair.id,
    ),
  );
  assert.equal(
    toolNode(secondScheduled, "code_validate_targeted").status,
    "queued",
  );

  const afterRepeatedRepair = await session.finishToolExecution(
    repeatedRepairExecution,
    {
      ok: true,
      evidence: evidenceFor(
        session.graph.nodes[repeatedRepairExecution.nodeId],
        "a",
        harness.nextTimestamp(),
      ),
      receipt: receiptFor(
        session.graph.nodes[repeatedRepairExecution.nodeId],
        "b",
        harness.nextTimestamp(),
      ),
    },
  );
  assert.equal(
    toolNode(afterRepeatedRepair, "code_validate_targeted").status,
    "queued",
  );
  assert.equal(
    afterRepeatedRepair.nodes[secondRepeatedFast.id]?.status,
    "queued",
  );
  const secondCorrection = await session.recordValidationRecoveryCorrection({
    toolName: "code_workspace_write_expected",
    path: "src/game.ts",
    eligiblePaths: ["src/game.ts"],
    receiptId: "receipt-second-fast-correction",
    receiptFingerprint: fp("c"),
    observedAt: harness.nextTimestamp(),
  });
  assert.equal(secondCorrection.recorded, true);
  assert.deepEqual(
    Object.values(secondCorrection.graph.nodes)
      .filter(
        (candidate) =>
          candidate.status === "ready" &&
          afterRepeatedRepair.nodes[candidate.id]?.status !== "ready",
      )
      .map((candidate) => candidate.id),
    [secondRepeatedFast.id],
    "each correction receipt unlocks only the fresh fast node from its own cycle",
  );

  const secondRepeatedFastExecution = requireExecution(
    await session.beginToolExecution("code_validate_fast"),
  );
  assert.equal(secondRepeatedFastExecution.nodeId, secondRepeatedFast.id);
  const afterSecondRepeatedFast = await session.finishToolExecution(
    secondRepeatedFastExecution,
    {
      ok: true,
      evidence: evidenceFor(
        session.graph.nodes[secondRepeatedFastExecution.nodeId],
        "c",
        harness.nextTimestamp(),
      ),
      receipt: receiptFor(
        session.graph.nodes[secondRepeatedFastExecution.nodeId],
        "d",
        harness.nextTimestamp(),
      ),
    },
  );
  assert.equal(
    afterSecondRepeatedFast.nodes[secondRepeatedRepair.id]?.status,
    "ready",
  );
  assert.equal(
    toolNode(afterSecondRepeatedFast, "code_validate_targeted").status,
    "queued",
  );

  const secondRepeatedRepairExecution = requireExecution(
    await session.beginToolExecution("code_repair_record_cycle"),
  );
  assert.equal(secondRepeatedRepairExecution.nodeId, secondRepeatedRepair.id);
  const afterSecondRepeatedRepair = await session.finishToolExecution(
    secondRepeatedRepairExecution,
    {
      ok: true,
      evidence: evidenceFor(
        session.graph.nodes[secondRepeatedRepairExecution.nodeId],
        "e",
        harness.nextTimestamp(),
      ),
      receipt: receiptFor(
        session.graph.nodes[secondRepeatedRepairExecution.nodeId],
        "f",
        harness.nextTimestamp(),
      ),
    },
  );
  assert.equal(
    toolNode(afterSecondRepeatedRepair, "code_validate_targeted").status,
    "ready",
  );
  assert.doesNotThrow(() =>
    validateMissionGraphV3(afterSecondRepeatedRepair),
  );

  const targetedExecution = requireExecution(
    await session.beginToolExecution("code_validate_targeted"),
  );
  const targetedFailure = await session.finishFailedValidationWithRecovery(
    targetedExecution,
    {
      evidence: evidenceFor(
        session.graph.nodes[targetedExecution.nodeId],
        "c",
        harness.nextTimestamp(),
      ),
      receipt: receiptFor(
        session.graph.nodes[targetedExecution.nodeId],
        "d",
        harness.nextTimestamp(),
      ),
      failureFingerprint: fp("e"),
      failureMessage: "Protected targeted validation completed red.",
    },
  );
  assert.equal(targetedFailure.scheduled, true);
  const requeuedTargeted =
    targetedFailure.graph.nodes[targetedExecution.nodeId];
  assert.equal(requeuedTargeted?.status, "queued");
  assert.equal(requeuedTargeted?.retries.attempts, 1);
  const recoveryFast = Object.values(targetedFailure.graph.nodes).find(
    (candidate) => candidate.id.startsWith("validation-recovery-fast-"),
  );
  const recoveryRepair = Object.values(targetedFailure.graph.nodes).find(
    (candidate) => candidate.id.startsWith("validation-recovery-record-"),
  );
  assert.ok(recoveryFast);
  assert.ok(recoveryRepair);
  assert.equal(recoveryFast.status, "queued");
  assert.equal(recoveryRepair.status, "queued");
  assert.ok(requeuedTargeted?.dependencyIds.includes(recoveryRepair.id));
  assert.equal(
    (await session.beginToolExecution("code_validate_fast")).ok,
    false,
    "fresh validation is not callable until a correction receipt is recorded",
  );
  const correction = await session.recordValidationRecoveryCorrection({
    toolName: "code_workspace_write_expected",
    path: "src/game.ts",
    eligiblePaths: ["src/game.ts"],
    receiptId: "receipt-targeted-correction",
    receiptFingerprint: fp("f"),
    observedAt: harness.nextTimestamp(),
  });
  assert.equal(correction.recorded, true);
  assert.equal(correction.graph.nodes[recoveryFast.id]?.status, "ready");
  assert.equal(
    (
      correction.graph.nodes[targetedExecution.nodeId]?.outputs
        .validationRecovery as { status?: unknown }
    )?.status,
    "correction_recorded",
  );

  const recoveryFastExecution = requireExecution(
    await session.beginToolExecution("code_validate_fast"),
  );
  assert.equal(recoveryFastExecution.nodeId, recoveryFast.id);
  await session.finishToolExecution(recoveryFastExecution, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[recoveryFastExecution.nodeId],
      "0",
      harness.nextTimestamp(),
    ),
    receipt: receiptFor(
      session.graph.nodes[recoveryFastExecution.nodeId],
      "1",
      harness.nextTimestamp(),
    ),
  });
  const recoveryRepairExecution = requireExecution(
    await session.beginToolExecution("code_repair_record_cycle"),
  );
  assert.equal(recoveryRepairExecution.nodeId, recoveryRepair.id);
  const afterRecoveryRepair = await session.finishToolExecution(
    recoveryRepairExecution,
    {
      ok: true,
      evidence: evidenceFor(
        session.graph.nodes[recoveryRepairExecution.nodeId],
        "2",
        harness.nextTimestamp(),
      ),
      receipt: receiptFor(
        session.graph.nodes[recoveryRepairExecution.nodeId],
        "3",
        harness.nextTimestamp(),
      ),
    },
  );
  assert.equal(
    afterRecoveryRepair.nodes[targetedExecution.nodeId]?.status,
    "ready",
  );
  assert.ok(
    graphBudget(afterRecoveryRepair).toolCalls <=
      afterRecoveryRepair.capabilityEnvelope.budgets.maxTotalToolCalls,
  );
  assert.equal(
    afterRecoveryRepair.capabilityEnvelope.fingerprint,
    envelopeFingerprint,
  );
  assert.doesNotThrow(() => validateMissionGraphV3(afterRecoveryRepair));
});

test("red full validation recovery repeats targeted validation after a correction", async () => {
  const harness = createVaultHarness();
  const missionId = "session-full-validation-recovery";
  const names = [
    "code_validate_fast",
    "code_repair_record_cycle",
    "code_validate_targeted",
    "code_validate_full",
  ];
  const descriptors = names.map((name) =>
    sessionLifecycleDescriptor(name, "workspace", "reversible_mutation"),
  );
  const byName = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor] as const),
  );
  const registry: ToolRegistry = {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    getDescriptor: (name) => byName.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
  const host = await buildHostMissionGraphPlanV1({
    missionId,
    objective: "Execute the bounded full-validation recovery mission.",
    toolRegistry: registry,
    allowedToolNames: names,
    plannedToolNames: names,
    maxToolCalls: 10,
    maxWallClockMs: 180_000,
    now: GRAPH_TIME,
  });
  const graph = (
    await planMissionGraphV3({
      mission: {
        missionId,
        objective: "Execute the bounded full-validation recovery mission.",
      },
      routerMode: "off",
      capabilityEnvelope: host.capabilityEnvelope,
      deterministicProposal: host.deterministicProposal,
      allowedToolDescriptors: host.allowedToolDescriptors,
      now: () => GRAPH_TIME.toISOString(),
    })
  ).graph;
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const complete = async (toolName: string, character: string) => {
    const execution = requireExecution(
      await session.beginToolExecution(toolName),
    );
    return session.finishToolExecution(execution, {
      ok: true,
      evidence: evidenceFor(
        session.graph.nodes[execution.nodeId],
        character,
        harness.nextTimestamp(),
      ),
      receipt: receiptFor(
        session.graph.nodes[execution.nodeId],
        character,
        harness.nextTimestamp(),
      ),
    });
  };
  await complete("code_validate_fast", "4");
  await complete("code_repair_record_cycle", "5");
  await complete("code_validate_targeted", "6");
  const fullExecution = requireExecution(
    await session.beginToolExecution("code_validate_full"),
  );
  const envelopeFingerprint = session.graph.capabilityEnvelope.fingerprint;
  const recovery = await session.finishFailedValidationWithRecovery(
    fullExecution,
    {
      evidence: evidenceFor(
        session.graph.nodes[fullExecution.nodeId],
        "7",
        harness.nextTimestamp(),
      ),
      receipt: receiptFor(
        session.graph.nodes[fullExecution.nodeId],
        "8",
        harness.nextTimestamp(),
      ),
      failureFingerprint: fp("9"),
      failureMessage: "Fresh full validation completed red.",
    },
  );
  assert.equal(recovery.scheduled, true);
  const recoveryStage = Object.values(recovery.graph.nodes).find(
    (candidate) => candidate.id.startsWith("validation-recovery-stage-"),
  );
  assert.ok(recoveryStage);
  assert.equal(recoveryStage.status, "queued");
  assert.equal(
    getCurrentMissionCompositeLifecycleActionV1(recoveryStage)?.toolName,
    "code_validate_fast",
  );
  assert.equal(
    recovery.graph.nodes[fullExecution.nodeId]?.status,
    "blocked",
  );
  assert.equal(
    (await session.beginToolExecution("code_validate_fast")).ok,
    false,
    "the repeated closed validation stage stays gated on a correction receipt",
  );
  const correction = await session.recordValidationRecoveryCorrection({
    toolName: "code_workspace_patch",
    path: "src/game.ts",
    eligiblePaths: ["src/game.ts"],
    receiptId: "receipt-full-correction",
    receiptFingerprint: fp("a"),
    observedAt: harness.nextTimestamp(),
  });
  assert.equal(correction.recorded, true);
  assert.equal(correction.graph.nodes[recoveryStage.id]?.status, "ready");
  assert.equal(
    correction.graph.capabilityEnvelope.fingerprint,
    envelopeFingerprint,
  );
  assert.doesNotThrow(() => validateMissionGraphV3(correction.graph));

  for (const [toolName, character] of [
    ["code_validate_fast", "a"],
    ["code_repair_record_cycle", "b"],
    ["code_validate_targeted", "c"],
    ["code_validate_full", "d"],
  ] as const) {
    await complete(toolName, character);
  }
  assert.equal(session.graph.nodes[recoveryStage.id]?.status, "complete");
  assert.equal(session.graph.nodes[fullExecution.nodeId]?.status, "complete");
  assert.equal(session.graph.nodes.final?.status, "ready");
  assert.equal(
    getMissionCompositeLifecycleStateV1(
      session.graph.nodes[fullExecution.nodeId]!,
    )?.actionCursor,
    4,
  );
  assert.equal(
    session.graph.capabilityEnvelope.fingerprint,
    envelopeFingerprint,
  );
  assert.doesNotThrow(() => validateMissionGraphV3(session.graph));
});

test("concurrent mutation starts serialize through the graph frontier and one exclusive lock", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-concurrent-mutations",
    allowedTools: ["append_to_current_file", "replace_current_file"],
    plannedTools: ["append_to_current_file", "replace_current_file"],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });

  const [appendStart, replaceStart] = await Promise.all([
    session.beginToolExecution("append_to_current_file"),
    session.beginToolExecution("replace_current_file"),
  ]);
  const appendExecution = requireExecution(appendStart);
  assert.equal(replaceStart.ok, false);
  if (!replaceStart.ok) assert.match(replaceStart.reason, /not ready/i);

  const locked = await requireStored(harness.context, graph.missionId);
  const activeLocks = Object.values(locked.record.resourceLocks.locks);
  assert.equal(activeLocks.length, 1);
  assert.equal(
    Date.parse(activeLocks[0].expiresAt) - Date.parse(activeLocks[0].acquiredAt),
    180_000,
  );

  const appendNode = session.graph.nodes[appendExecution.nodeId];
  await session.finishToolExecution(appendExecution, {
    ok: true,
    evidence: evidenceFor(appendNode, "4", harness.nextTimestamp()),
    receipt: receiptFor(appendNode, "5", harness.nextTimestamp()),
  });
  const unlocked = await requireStored(harness.context, graph.missionId);
  assert.deepEqual(unlocked.record.resourceLocks.locks, {});

  const replacement = requireExecution(
    await session.beginToolExecution("replace_current_file"),
  );
  assert.equal(replacement.toolName, "replace_current_file");
});

test("resume reconciles a legacy composite-owned append from exact note proof without replaying the write", async () => {
  const fixture = await publicationReconciliationFixture(
    "session-research-publication-legacy-append",
  );
  const { append, harness, receipt, session } = fixture;
  assert.equal(append.status, "ready");
  assert.equal(harness.files.get(fixture.notePath), fixture.noteContent);
  assert.deepEqual(
    harness.writes.filter((entry) => entry.endsWith(fixture.notePath)),
    [],
  );

  const result = await reconcileCompositeOwnedCurrentNoteGraphOnResume({
    session,
    rootRunId: session.graph.missionId,
    receipts: [receipt],
    toolContext: harness.context,
  });

  assert.deepEqual(result, {
    reconciled: true,
    nodeId: append.id,
    receiptId: receipt.id,
    notePath: fixture.notePath,
    reason: "reconciled",
  });
  const reconciled = session.graph.nodes[append.id]!;
  assert.equal(reconciled.status, "complete");
  assert.equal(
    reconciled.retries.attempts,
    0,
    "proof reconciliation must not fabricate an append tool attempt",
  );
  assert.deepEqual(
    reconciled.evidence.map(({ kind, fingerprint }) => ({
      kind,
      fingerprint,
    })),
    [
      {
        kind: "tool-result",
        fingerprint: fixture.artifactFingerprint,
      },
    ],
  );
  assert.deepEqual(
    reconciled.receipts.map(({ id, kind, fingerprint }) => ({
      id,
      kind,
      fingerprint,
    })),
    [
      {
        id: fixture.noteReceiptId,
        kind: "vault_write",
        fingerprint: fixture.artifactNoteSha256,
      },
    ],
  );
  assert.equal(session.graph.nodes.final.status, "ready");
  assert.equal(harness.files.get(fixture.notePath), fixture.noteContent);
  assert.deepEqual(
    harness.writes.filter((entry) => entry.endsWith(fixture.notePath)),
    [],
  );
  assert.equal(
    reconciled.receipts[0]?.committedAt,
    GRAPH_TIME.toISOString(),
    "the graph note proof retains the artifact acceptance time",
  );
});

test("resume refuses publication graph closure when the current note is missing or drifted", async () => {
  for (const state of ["missing", "drifted"] as const) {
    const fixture = await publicationReconciliationFixture(
      `session-research-publication-note-${state}`,
    );
    if (state === "missing") {
      fixture.harness.files.delete(fixture.notePath);
    } else {
      fixture.harness.files.set(
        fixture.notePath,
        `${fixture.noteContent}\nUnverified drift.\n`,
      );
    }
    const result = await reconcileCompositeOwnedCurrentNoteGraphOnResume({
      session: fixture.session,
      rootRunId: fixture.session.graph.missionId,
      receipts: [fixture.receipt],
      toolContext: fixture.harness.context,
    });
    assert.equal(result.reconciled, false);
    assert.equal(result.reason, "publication_note_state_mismatch");
    assert.equal(
      fixture.session.graph.nodes[fixture.append.id]?.status,
      "ready",
    );
    assert.deepEqual(
      fixture.session.graph.nodes[fixture.append.id]?.receipts,
      [],
    );
  }
});

test("resume refuses append-only and reflection graph nodes without exact publisher ancestry", async () => {
  const appendOnlyHarness = createVaultHarness();
  const appendOnlyGraph = await graphFor({
    missionId: "session-research-publication-append-only",
    allowedTools: ["append_to_current_file"],
    plannedTools: ["append_to_current_file"],
  });
  const appendOnlySession = await MissionGraphSession.open({
    context: appendOnlyHarness.context,
    initialGraph: appendOnlyGraph,
  });
  const appendOnlyProof = await deduplicatedPublicationReceiptFor({
    rootRunId: appendOnlyGraph.missionId,
    noteContent: "# Accepted research\n\nVerified final note.\n",
  });
  appendOnlyHarness.files.set(
    appendOnlyProof.notePath,
    appendOnlyProof.noteContent,
  );
  const appendOnlyResult =
    await reconcileCompositeOwnedCurrentNoteGraphOnResume({
      session: appendOnlySession,
      rootRunId: appendOnlyGraph.missionId,
      receipts: [appendOnlyProof.receipt],
      toolContext: appendOnlyHarness.context,
    });
  assert.equal(appendOnlyResult.reason, "legacy_append_not_ready");

  const reflection = await publicationReconciliationFixture(
    "session-research-publication-reflection",
    "Write a concise reflection about the completed workflow.",
  );
  const reflectionResult =
    await reconcileCompositeOwnedCurrentNoteGraphOnResume({
      session: reflection.session,
      rootRunId: reflection.session.graph.missionId,
      receipts: [reflection.receipt],
      toolContext: reflection.harness.context,
    });
  assert.equal(reflectionResult.reason, "legacy_append_not_ready");
  assert.equal(
    reflection.session.graph.nodes[reflection.append.id]?.status,
    "ready",
  );
});

test("resume fails closed on a same-id publication receipt conflict", async () => {
  const fixture = await publicationReconciliationFixture(
    "session-research-publication-receipt-conflict",
  );
  const result = await reconcileCompositeOwnedCurrentNoteGraphOnResume({
    session: fixture.session,
    rootRunId: fixture.session.graph.missionId,
    receipts: [
      fixture.receipt,
      {
        ...fixture.receipt,
        message: `${fixture.receipt.message} conflicting replay`,
      },
    ],
    toolContext: fixture.harness.context,
  });
  assert.equal(result.reconciled, false);
  assert.equal(result.reason, "publication_receipt_conflict");
  assert.equal(
    fixture.session.graph.nodes[fixture.append.id]?.status,
    "ready",
  );
});

test("two identical failures stop retrying and persist a resumable blocker", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-repeat-failure",
    allowedTools: ["read_current_file"],
    plannedTools: ["read_current_file"],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const failure = fp("a");

  const first = requireExecution(
    await session.beginToolExecution("read_current_file"),
  );
  const afterFirst = await session.finishToolExecution(first, {
    ok: false,
    failureFingerprint: failure,
    failureMessage: "The same read failed.",
  });
  assert.equal(afterFirst.nodes[first.nodeId].status, "ready");

  const second = requireExecution(
    await session.beginToolExecution("read_current_file"),
  );
  const afterSecond = await session.finishToolExecution(second, {
    ok: false,
    failureFingerprint: failure,
    failureMessage: "The same read failed.",
  });
  const node = afterSecond.nodes[second.nodeId];
  assert.equal(node.status, "blocked");
  assert.equal(node.retries.attempts, 2);
  assert.equal(node.retries.consecutiveFailureCount, 2);
  assert.equal(node.blocker?.code, "tool_failure_repeated");
  assert.equal((await session.beginToolExecution("read_current_file")).ok, false);
});

test("a repeated host-policy deferral becomes a durable orchestration blocker", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-repeated-policy-deferral",
    allowedTools: ["create_design_canvas"],
    plannedTools: ["create_design_canvas"],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });

  const first = requireExecution(
    await session.beginToolExecution("create_design_canvas"),
  );
  const afterFirst = await session.deferToolExecution(
    first,
    "Research prerequisites are incomplete.",
  );
  assert.equal(afterFirst.nodes[first.nodeId]?.status, "ready");
  assert.equal(afterFirst.nodes[first.nodeId]?.retries.attempts, 1);

  const second = requireExecution(
    await session.beginToolExecution("create_design_canvas"),
  );
  const afterSecond = await session.deferToolExecution(
    second,
    "Research prerequisites are incomplete.",
  );
  assert.equal(afterSecond.nodes[second.nodeId]?.status, "blocked");
  assert.equal(afterSecond.nodes[second.nodeId]?.retries.attempts, 2);
  assert.equal(
    afterSecond.nodes[second.nodeId]?.blocker?.code,
    "policy_deferral_repeated",
  );
  assert.match(
    afterSecond.nodes[second.nodeId]?.blocker?.message ?? "",
    /internal orchestration repeatedly deferred/iu,
  );
  assert.equal(
    (await session.beginToolExecution("create_design_canvas")).ok,
    false,
  );
});

test("a create collision replans the same node into read then hash-bound write", async () => {
  const harness = createVaultHarness();
  const graph = await workspaceCollisionGraphFor(
    "session-create-file-collision-repair",
  );
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const create = requireExecution(
    await session.beginToolExecution("code_workspace_create_file"),
  );
  const afterCollision = await session.finishToolExecution(create, {
    ok: false,
    failureFingerprint: fp("c"),
    failureMessage: "path_exists",
  });
  assert.equal(afterCollision.nodes[create.nodeId]?.status, "ready");

  const repaired = await session.scheduleCreateFileCollisionRepair(
    create,
    "app.py",
  );
  assert.equal(repaired.nodes[create.nodeId]?.status, "blocked");
  assert.equal(
    repaired.nodes[create.nodeId]?.blocker?.code,
    "create_file_path_exists",
  );
  const repairReadNode = toolNode(repaired, "code_workspace_read");
  const repairWriteNode = toolNode(repaired, "code_workspace_write_expected");
  assert.equal(repairReadNode.status, "ready");
  assert.equal(repairWriteNode.status, "queued");
  assert.equal(repairReadNode.inputs.resource?.kind, "binding");
  assert.equal(repairReadNode.inputs.resource?.selector, "app.py");
  assert.equal(repairWriteNode.destination?.selector, "app.py");
  const repairSchemas = [
    "code_workspace_create_file",
    "code_workspace_read",
    "code_workspace_write_expected",
  ].map((name) => ({
    type: "function" as const,
    function: { name, parameters: { type: "object" } },
  }));
  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(repairSchemas, repaired).map(
      (schema) => schema.function.name,
    ),
    ["code_workspace_read"],
  );
  assert.equal(
    (await session.beginToolExecution("code_workspace_write_expected")).ok,
    false,
  );

  const read = requireExecution(
    await session.beginToolExecution("code_workspace_read"),
  );
  const afterRead = await session.finishToolExecution(read, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[read.nodeId]!,
      "d",
      harness.nextTimestamp(),
    ),
  });
  assert.equal(afterRead.nodes[read.nodeId]?.status, "complete");
  assert.equal(afterRead.nodes[repairWriteNode.id]?.status, "ready");
  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(repairSchemas, afterRead).map(
      (schema) => schema.function.name,
    ),
    ["code_workspace_write_expected"],
  );

  const write = requireExecution(
    await session.beginToolExecution("code_workspace_write_expected"),
  );
  const writeNode = session.graph.nodes[write.nodeId]!;
  const completed = await session.finishToolExecution(write, {
    ok: true,
    evidence: evidenceFor(writeNode, "e", harness.nextTimestamp()),
    receipt: receiptFor(writeNode, "f", harness.nextTimestamp()),
  });
  assert.equal(completed.nodes[write.nodeId]?.status, "complete");
  assert.equal(completed.nodes[create.nodeId]?.status, "complete");
  assert.doesNotThrow(() => validateMissionGraphV3(completed));
});

test("a composite code lifecycle resumes after bounded create collision repair", async () => {
  const harness = createVaultHarness();
  const graph = await compositeCodeCollisionGraphFor(
    "session-composite-create-file-collision-repair",
  );
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  for (const toolName of ["code_sandbox_status", "code_workspace_create"]) {
    const execution = requireExecution(
      await session.beginToolExecution(toolName),
    );
    const node = session.graph.nodes[execution.nodeId]!;
    await session.finishToolExecution(
      execution,
      lifecycleProofFor(
        node,
        toolName === "code_sandbox_status" ? "0" : "1",
        harness.nextTimestamp(),
      ),
    );
  }

  const create = requireExecution(
    await session.beginToolExecution("code_workspace_create_file"),
  );
  await session.finishToolExecution(create, {
    ok: false,
    failureFingerprint: fp("2"),
    failureMessage: "path_exists",
  });
  await session.scheduleCreateFileCollisionRepair(create, "main.py");

  const read = requireExecution(
    await session.beginToolExecution("code_workspace_read"),
  );
  await session.finishToolExecution(read, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[read.nodeId]!,
      "3",
      harness.nextTimestamp(),
    ),
  });
  const write = requireExecution(
    await session.beginToolExecution("code_workspace_write_expected"),
  );
  const writeNode = session.graph.nodes[write.nodeId]!;
  const repaired = await session.finishToolExecution(write, {
    ok: true,
    evidence: evidenceFor(writeNode, "4", harness.nextTimestamp()),
    receipt: receiptFor(writeNode, "5", harness.nextTimestamp()),
  });

  const lifecycleNode = repaired.nodes[create.nodeId]!;
  assert.equal(lifecycleNode.status, "ready");
  assert.equal(
    getMissionCompositeLifecycleStateV1(lifecycleNode)?.actionCursor,
    3,
  );
  assert.equal(
    getCurrentMissionCompositeLifecycleActionV1(lifecycleNode)?.toolName,
    "code_workspace_export_directory",
  );
  assert.doesNotThrow(() => validateMissionGraphV3(repaired));
});

test("a host-verified terminal domain outcome blocks on its first attempt", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-terminal-domain-outcome",
    allowedTools: ["read_current_file"],
    plannedTools: ["read_current_file"],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const execution = requireExecution(
    await session.beginToolExecution("read_current_file"),
  );

  const after = await session.finishToolExecution(execution, {
    ok: false,
    failureFingerprint: fp("b"),
    failureMessage: "The domain checkpoint is terminal.",
    terminalFailure: true,
  });

  const node = after.nodes[execution.nodeId];
  assert.equal(node.status, "blocked");
  assert.equal(node.retries.attempts, 1);
  assert.equal(node.blocker?.code, "tool_failure_terminal");
  assert.equal(node.blocker?.message, "The domain checkpoint is terminal.");
  const nodeIds = Object.keys(session.graph.nodes);
  const replay = await session.beginToolExecution("read_current_file", {
    allowDynamicReadContinuation: true,
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.match(replay.reason, /blocked/iu);
  assert.deepEqual(Object.keys(session.graph.nodes), nodeIds);
});

test("ungranted mutation is rejected while a bounded envelope-approved read is added", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-bounded-read",
    allowedTools: ["append_to_current_file", "web_search"],
    plannedTools: ["append_to_current_file"],
    maxToolCalls: 4,
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });

  const denied = await session.beginToolExecution("replace_current_file");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.reason, /not ready/i);

  const beforeIds = new Set(Object.keys(session.graph.nodes));
  const read = requireExecution(await session.beginToolExecution("web_search"));
  assert.equal(beforeIds.has(read.nodeId), false);
  const dynamicNode = session.graph.nodes[read.nodeId];
  assert.equal(dynamicNode.effect, "read");
  assert.deepEqual(dynamicNode.allowedTools, ["web_search"]);
  assert.deepEqual(dynamicNode.resourceLocks, []);
  assert.ok(session.graph.nodes.final.dependencyIds.includes(read.nodeId));
  assert.ok(Object.keys(session.graph.nodes).length <= graph.capabilityEnvelope.budgets.maxNodes);

  const completed = await session.finishToolExecution(read, {
    ok: true,
    evidence: evidenceFor(dynamicNode, "6", harness.nextTimestamp()),
  });
  assert.equal(completed.nodes[read.nodeId].status, "complete");
});

test("failed optional dynamic reads are cancelled by final output while default retries still gate", async () => {
  const openCompletedWriteSession = async (missionId: string) => {
    const harness = createVaultHarness();
    const graph = await graphFor({
      missionId,
      allowedTools: ["append_to_current_file", "web_search"],
      plannedTools: ["append_to_current_file"],
      maxToolCalls: 4,
    });
    const session = await MissionGraphSession.open({
      context: harness.context,
      initialGraph: graph,
    });
    const write = requireExecution(
      await session.beginToolExecution("append_to_current_file"),
    );
    const writeNode = session.graph.nodes[write.nodeId]!;
    await session.finishToolExecution(write, {
      ok: true,
      evidence: evidenceFor(writeNode, "1", harness.nextTimestamp()),
      receipt: receiptFor(writeNode, "2", harness.nextTimestamp()),
    });
    assert.equal(session.graph.nodes.final.status, "ready");
    return { harness, session };
  };

  const required = await openCompletedWriteSession(
    "session-required-dynamic-read",
  );
  const requiredRead = requireExecution(
    await required.session.beginToolExecution("web_search"),
  );
  assert.match(requiredRead.nodeId, /^retry-/u);
  await required.session.finishToolExecution(requiredRead, {
    ok: false,
    failureFingerprint: fp("3"),
    failureMessage: "The required dynamic read failed once.",
  });
  const requiredTerminal = await required.session.completeFinalOutput({
    outputFingerprint: fp("4"),
    observedAt: required.harness.nextTimestamp(),
  });
  assert.equal(requiredTerminal.nodes[requiredRead.nodeId]?.status, "ready");
  assert.equal(requiredTerminal.nodes.final.status, "queued");
  assert.ok(
    requiredTerminal.nodes.final.dependencyIds.includes(requiredRead.nodeId),
  );

  const optional = await openCompletedWriteSession(
    "session-optional-dynamic-read",
  );
  const optionalRead = requireExecution(
    await optional.session.beginToolExecution("web_search", {
      optionalDynamicContinuation: true,
    }),
  );
  assert.match(optionalRead.nodeId, /^optional-retry-/u);
  assert.equal(optional.session.graph.nodes.final.status, "ready");
  assert.equal(
    optional.session.graph.nodes.final.dependencyIds.includes(
      optionalRead.nodeId,
    ),
    false,
  );
  await optional.session.finishToolExecution(optionalRead, {
    ok: false,
    failureFingerprint: fp("5"),
    failureMessage: "The optional companion read failed once.",
  });
  const optionalTerminal = await optional.session.completeFinalOutput({
    outputFingerprint: fp("6"),
    observedAt: optional.harness.nextTimestamp(),
  });
  assert.equal(optionalTerminal.nodes.final.status, "complete");
  assert.equal(optionalTerminal.nodes[optionalRead.nodeId]?.status, "cancelled");
  assert.equal(optionalTerminal.nodes[optionalRead.nodeId]?.blocker, null);
});

test("composite lifecycle reserves bounded capacity for an initial host-safe note read", async () => {
  const harness = createVaultHarness();
  const graph = await compositeLifecycleGraphFor(
    "session-composite-initial-safe-read",
    {
      includeUnplannedCurrentRead: true,
      maxToolCalls: Number.POSITIVE_INFINITY,
    },
  );
  const initialNodeCount = Object.keys(graph.nodes).length;
  const plannedToolCalls = Object.values(graph.nodes).reduce(
    (total, node) => total + node.budget.toolCalls,
    0,
  );
  assert.ok(
    graph.capabilityEnvelope.budgets.maxTotalToolCalls > plannedToolCalls,
  );
  assert.ok(graph.capabilityEnvelope.budgets.maxNodes > initialNodeCount);

  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const read = requireExecution(
    await session.beginToolExecution("read_current_file"),
  );
  assert.match(read.nodeId, /^retry-/u);
  assert.equal(session.graph.nodes[read.nodeId].effect, "read");
  assert.equal(
    session.graph.nodes["lifecycle-accepted_research"].status,
    "ready",
  );
  assert.ok(session.graph.nodes.final.dependencyIds.includes(read.nodeId));

  const completed = await session.finishToolExecution(read, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[read.nodeId],
      "7",
      harness.nextTimestamp(),
    ),
  });
  assert.equal(completed.nodes[read.nodeId].status, "complete");
  assert.equal(
    completed.nodes["lifecycle-accepted_research"].status,
    "ready",
  );
});

test("sequential unplanned reads retain per-node wall-clock capacity across resume", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-dynamic-read-wall-clock",
    allowedTools: ["append_to_current_file", "web_search", "web_fetch"],
    plannedTools: ["append_to_current_file"],
    maxToolCalls: 15,
    maxWallClockMs: 16_000,
  });
  const envelopeFingerprint = graph.capabilityEnvelope.fingerprint;
  const initialBudget = graphBudget(graph);
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });

  const search = requireExecution(await session.beginToolExecution("web_search"));
  const searchNode = session.graph.nodes[search.nodeId];
  assert.equal(searchNode.budget.wallClockMs, 1_000);
  await session.finishToolExecution(search, {
    ok: true,
    evidence: evidenceFor(searchNode, "a", harness.nextTimestamp()),
  });

  const resumed = await MissionGraphSession.resume({
    context: harness.context,
    missionId: graph.missionId,
  });
  const fetch = requireExecution(await resumed.beginToolExecution("web_fetch"));
  const fetchNode = resumed.graph.nodes[fetch.nodeId];
  const afterBudget = graphBudget(resumed.graph);

  assert.equal(fetchNode.budget.wallClockMs, 1_000);
  assert.equal(afterBudget.wallClockMs, initialBudget.wallClockMs + 2_000);
  assert.ok(
    afterBudget.wallClockMs <=
      resumed.graph.capabilityEnvelope.budgets.maxWallClockMs,
  );
  assert.equal(
    resumed.graph.capabilityEnvelope.fingerprint,
    envelopeFingerprint,
  );
});

test("resumed read continuation transfers final-node reserve without widening a full envelope", async () => {
  const harness = createVaultHarness();
  const graph = saturateContinuationReserve(
    await graphFor({
      missionId: "session-resumed-read-budget-transfer",
      allowedTools: ["read_current_file"],
      plannedTools: ["read_current_file"],
      maxToolCalls: 2,
    }),
  );
  assert.deepEqual(graphBudget(graph), {
    toolCalls: graph.capabilityEnvelope.budgets.maxTotalToolCalls,
    externalActions: graph.capabilityEnvelope.budgets.maxExternalActions,
    wallClockMs: graph.capabilityEnvelope.budgets.maxWallClockMs,
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const first = requireExecution(
    await session.beginToolExecution("read_current_file"),
  );
  const firstNode = session.graph.nodes[first.nodeId];
  await session.finishToolExecution(first, {
    ok: true,
    evidence: evidenceFor(firstNode, "e", harness.nextTimestamp()),
  });

  const resumed = await MissionGraphSession.resume({
    context: harness.context,
    missionId: graph.missionId,
  });
  const reserveBefore = resumed.graph.nodes.final.budget;
  const aggregateBefore = graphBudget(resumed.graph);
  const second = requireExecution(
    await resumed.beginToolExecution("read_current_file"),
  );
  const after = resumed.graph;
  const continuation = after.nodes[second.nodeId];

  assert.equal(continuation.status, "running");
  assert.equal(after.nodes.final.status, "queued");
  assert.ok(after.nodes.final.dependencyIds.includes(second.nodeId));
  assert.equal(
    after.nodes.final.budget.toolCalls,
    reserveBefore.toolCalls - continuation.budget.toolCalls,
  );
  assert.equal(
    after.nodes.final.budget.wallClockMs,
    reserveBefore.wallClockMs - continuation.budget.wallClockMs,
  );
  assert.deepEqual(graphBudget(after), aggregateBefore);
  assert.equal(
    after.capabilityEnvelope.fingerprint,
    graph.capabilityEnvelope.fingerprint,
  );
  const stored = await requireStored(harness.context, graph.missionId);
  assert.deepEqual(stored.record.graph.nodes.final.budget, after.nodes.final.budget);
  assert.deepEqual(graphBudget(stored.record.graph), aggregateBefore);

  const completed = await resumed.finishToolExecution(second, {
    ok: true,
    evidence: evidenceFor(continuation, "f", harness.nextTimestamp()),
  });
  assert.equal(completed.nodes[second.nodeId].status, "complete");
  assert.equal(completed.nodes.final.status, "ready");
});

test("read continuation fails closed when a full envelope has no mutable reserve", async () => {
  const harness = createVaultHarness();
  const graph = saturateContinuationReserve(
    await graphFor({
      missionId: "session-read-budget-reserve-exhausted",
      allowedTools: ["read_current_file"],
      plannedTools: ["read_current_file"],
      maxToolCalls: 1,
    }),
  );
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const first = requireExecution(
    await session.beginToolExecution("read_current_file"),
  );
  await session.finishToolExecution(first, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[first.nodeId],
      "a",
      harness.nextTimestamp(),
    ),
  });
  const before = session.graph;

  const denied = await session.beginToolExecution("read_current_file");

  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.reason, /lacks enough reserved budget/iu);
  assert.deepEqual(session.graph, before);
  assert.equal(
    session.graph.capabilityEnvelope.fingerprint,
    graph.capabilityEnvelope.fingerprint,
  );
});

test("exact workflow authority refuses to mint a dynamic read continuation", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-exact-read-frontier",
    allowedTools: ["read_current_file"],
    plannedTools: ["read_current_file"],
    maxToolCalls: 3,
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const first = requireExecution(
    await session.beginToolExecution("read_current_file", {
      allowDynamicReadContinuation: false,
    }),
  );
  await session.finishToolExecution(first, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[first.nodeId],
      "a",
      harness.nextTimestamp(),
    ),
  });
  const before = session.graph;

  const denied = await session.beginToolExecution("read_current_file", {
    allowDynamicReadContinuation: false,
  });

  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.reason, /exact authoritative mission graph/iu);
  assert.deepEqual(session.graph, before);
  assert.equal(
    Object.keys(session.graph.nodes).some((id) => id.startsWith("retry-")),
    false,
  );
});

test("a completed effectful template permits a bounded same-authority continuation", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-bounded-effectful-continuation",
    allowedTools: ["append_to_current_file"],
    plannedTools: ["append_to_current_file"],
    maxToolCalls: 4,
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });

  const first = requireExecution(
    await session.beginToolExecution("append_to_current_file"),
  );
  await session.waitForToolApproval(first);
  await session.resolveToolApproval(first, true);
  const firstNode = session.graph.nodes[first.nodeId];
  await session.finishToolExecution(first, {
    ok: true,
    evidence: evidenceFor(firstNode, "a", harness.nextTimestamp()),
    receipt: receiptFor(firstNode, "b", harness.nextTimestamp()),
  });

  const beforeIds = new Set(Object.keys(session.graph.nodes));
  const second = requireExecution(
    await session.beginToolExecution("append_to_current_file"),
  );
  assert.equal(beforeIds.has(second.nodeId), false);
  assert.match(second.nodeId, /^retry-/u);
  const secondNode = session.graph.nodes[second.nodeId];
  assert.equal(secondNode.effect, firstNode.effect);
  assert.deepEqual(secondNode.destination, firstNode.destination);
  assert.deepEqual(secondNode.resourceLocks, firstNode.resourceLocks);
  assert.ok(session.graph.nodes.final.dependencyIds.includes(second.nodeId));
  assert.ok(
    Object.keys(session.graph.nodes).length <=
      graph.capabilityEnvelope.budgets.maxNodes,
  );

  await session.waitForToolApproval(second);
  await session.resolveToolApproval(second, true);
  const completed = await session.finishToolExecution(second, {
    ok: true,
    evidence: evidenceFor(secondNode, "c", harness.nextTimestamp()),
    receipt: receiptFor(secondNode, "d", harness.nextTimestamp()),
  });
  assert.equal(completed.nodes[second.nodeId].status, "complete");
  assert.equal(completed.nodes.final.status, "ready");
});

test("failed optional effectful continuations do not strand final proof", async () => {
  const harness = createVaultHarness();
  const graph = await workspaceCollisionGraphFor(
    "session-optional-effectful-continuation",
  );
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const first = requireExecution(
    await session.beginToolExecution("code_workspace_create_file"),
  );
  const firstNode = session.graph.nodes[first.nodeId]!;
  await session.finishToolExecution(first, {
    ok: true,
    evidence: evidenceFor(firstNode, "1", harness.nextTimestamp()),
    receipt: receiptFor(firstNode, "2", harness.nextTimestamp()),
  });
  assert.equal(session.graph.nodes.final.status, "ready");

  const optional = requireExecution(
    await session.beginToolExecution("code_workspace_create_file", {
      optionalDynamicContinuation: true,
    }),
  );
  assert.match(optional.nodeId, /^optional-retry-/u);
  assert.equal(session.graph.nodes.final.status, "ready");
  assert.equal(
    session.graph.nodes.final.dependencyIds.includes(optional.nodeId),
    false,
  );
  await session.finishToolExecution(optional, {
    ok: false,
    failureFingerprint: fp("3"),
    failureMessage: "repository_path_out_of_scope for first candidate",
  });
  const retry = requireExecution(
    await session.beginToolExecution("code_workspace_create_file", {
      optionalDynamicContinuation: true,
    }),
  );
  assert.equal(retry.nodeId, optional.nodeId);
  const afterSecondFailure = await session.finishToolExecution(retry, {
    ok: false,
    failureFingerprint: fp("4"),
    failureMessage: "repository_path_out_of_scope for second candidate",
  });
  assert.equal(afterSecondFailure.nodes[optional.nodeId]?.status, "ready");
  assert.equal(afterSecondFailure.nodes[optional.nodeId]?.retries.attempts, 2);
  assert.equal(afterSecondFailure.nodes[optional.nodeId]?.blocker, null);

  const terminal = await session.completeFinalOutput({
    outputFingerprint: fp("5"),
    observedAt: harness.nextTimestamp(),
  });
  assert.equal(terminal.nodes.final.status, "complete");
  assert.equal(terminal.nodes[optional.nodeId]?.status, "cancelled");
  assert.equal(terminal.nodes[optional.nodeId]?.blocker, null);
});

test("a full-envelope effectful continuation transfers reserve without widening authority", async () => {
  const harness = createVaultHarness();
  const graph = saturateContinuationReserve(
    await graphFor({
      missionId: "session-bounded-effectful-budget-transfer",
      allowedTools: ["append_to_current_file"],
      plannedTools: ["append_to_current_file"],
      maxToolCalls: 2,
    }),
  );
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const first = requireExecution(
    await session.beginToolExecution("append_to_current_file"),
  );
  await session.waitForToolApproval(first);
  await session.resolveToolApproval(first, true);
  await session.finishToolExecution(first, {
    ok: true,
    evidence: evidenceFor(
      session.graph.nodes[first.nodeId],
      "e",
      harness.nextTimestamp(),
    ),
    receipt: receiptFor(
      session.graph.nodes[first.nodeId],
      "f",
      harness.nextTimestamp(),
    ),
  });

  const second = requireExecution(
    await session.beginToolExecution("append_to_current_file"),
  );
  assert.equal(session.graph.nodes[second.nodeId].effect, "mutation");
  assert.deepEqual(graphBudget(session.graph), {
    toolCalls: graph.capabilityEnvelope.budgets.maxTotalToolCalls,
    externalActions: graph.capabilityEnvelope.budgets.maxExternalActions,
    wallClockMs: graph.capabilityEnvelope.budgets.maxWallClockMs,
  });
  assert.equal(
    session.graph.capabilityEnvelope.fingerprint,
    graph.capabilityEnvelope.fingerprint,
  );
});

test("resume applies a final prepared patch once and never replays it", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-crash-recovery",
    allowedTools: ["read_current_file"],
    plannedTools: ["read_current_file"],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const node = toolNode(session.graph, "read_current_file");
  const proposedAt = harness.nextTimestamp();
  const patch: MissionGraphPatchV1 = {
    version: 1,
    patchId: "prepared-session-recovery",
    missionId: graph.missionId,
    baseRevision: session.graph.revision,
    baseJournalFingerprint: session.graph.journalHeadFingerprint,
    proposedAt,
    reason: "Simulate a crash after the prepared write.",
    operations: [
      {
        op: "set_status",
        nodeId: node.id,
        expectedStatus: "ready",
        status: "running",
        blocker: null,
      },
    ],
  };
  await persistPreparedMissionGraphPatch(harness.context, graph.missionId, patch, {
    expectedStoreRevision: session.storeRevision,
    preparedAt: proposedAt,
    appliedAt: proposedAt,
  });

  const recovered = await MissionGraphSession.resume({
    context: harness.context,
    missionId: graph.missionId,
  });
  assert.equal(recovered.graph.nodes[node.id].status, "running");
  const once = await requireStored(harness.context, graph.missionId);
  assert.equal(once.record.journal.at(-1)?.state, "applied");
  const writesAfterRecovery = harness.writes.length;

  const resumedAgain = await MissionGraphSession.resume({
    context: harness.context,
    missionId: graph.missionId,
  });
  assert.equal(resumedAgain.graph.revision, recovered.graph.revision);
  assert.equal(resumedAgain.storeRevision, recovered.storeRevision);
  assert.equal(harness.writes.length, writesAfterRecovery);
});

test("approval denial blocks the node and releases its prepared-action lock", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-approval-denial",
    allowedTools: ["replace_current_file"],
    plannedTools: ["replace_current_file"],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const execution = requireExecution(
    await session.beginToolExecution("replace_current_file"),
  );
  await session.waitForToolApproval(execution);
  const denied = await session.resolveToolApproval(execution, false);
  assert.equal(denied.nodes[execution.nodeId].status, "blocked");
  assert.equal(denied.nodes[execution.nodeId].blocker?.code, "approval_denied");
  const stored = await requireStored(harness.context, graph.missionId);
  assert.deepEqual(stored.record.resourceLocks.locks, {});
});

test("approval expiry is not misreported as a user denial", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-approval-expiry",
    allowedTools: ["replace_current_file"],
    plannedTools: ["replace_current_file"],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const execution = requireExecution(
    await session.beginToolExecution("replace_current_file"),
  );
  await session.waitForToolApproval(execution);
  const expired = await session.resolveToolApproval(execution, "expired");
  // Undecided approvals are not denials: the node reopens so a continuation
  // can prepare the action and ask again, and no blocker carries "denied".
  assert.equal(expired.nodes[execution.nodeId].status, "ready");
  assert.equal(expired.nodes[execution.nodeId].blocker, null);
  const stored = await requireStored(harness.context, graph.missionId);
  assert.deepEqual(stored.record.resourceLocks.locks, {});
});

test("an approval aborted by a run deadline reopens the node for continuation", async () => {
  // Regression: the effort wall-clock budget expired while code_validate_full
  // was waiting for its card; the node was blocked as approval_aborted, so
  // Continue could never pick it up even though the ledger said it could.
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "session-approval-aborted",
    allowedTools: ["replace_current_file"],
    plannedTools: ["replace_current_file"],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const execution = requireExecution(
    await session.beginToolExecution("replace_current_file"),
  );
  await session.waitForToolApproval(execution);
  const aborted = await session.resolveToolApproval(execution, "aborted");
  assert.equal(aborted.nodes[execution.nodeId].status, "ready");
  assert.equal(aborted.nodes[execution.nodeId].blocker, null);
  const stored = await requireStored(harness.context, graph.missionId);
  assert.deepEqual(stored.record.resourceLocks.locks, {});
  // The reopened node accepts a fresh execution and a real denial still blocks.
  const again = requireExecution(
    await session.beginToolExecution("replace_current_file"),
  );
  await session.waitForToolApproval(again);
  const denied = await session.resolveToolApproval(again, "denied");
  assert.equal(denied.nodes[again.nodeId].status, "blocked");
  assert.equal(denied.nodes[again.nodeId].blocker?.code, "approval_denied");
});

async function publicationReconciliationFixture(
  missionId: string,
  appendObjective?: string,
) {
  const harness = createVaultHarness();
  const graph = await publicationAppendGraphFor(missionId);
  if (appendObjective) {
    toolNode(graph, "append_to_current_file").objective = appendObjective;
  }
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const publisher = toolNode(session.graph, "publish_research_to_linear");
  const publicationExecution = requireExecution(
    await session.beginToolExecution("publish_research_to_linear"),
  );
  await session.finishToolExecution(publicationExecution, {
    ok: true,
    evidence: evidenceFor(
      publisher,
      "1",
      harness.nextTimestamp(),
    ),
    receipt: receiptFor(
      publisher,
      "2",
      harness.nextTimestamp(),
    ),
  });
  const append = toolNode(session.graph, "append_to_current_file");
  const proof = await deduplicatedPublicationReceiptFor({
    rootRunId: missionId,
    noteContent: "# Accepted research\n\nVerified final note and Linear backlink.\n",
  });
  harness.files.set(proof.notePath, proof.noteContent);
  return {
    append,
    artifactFingerprint: proof.artifactFingerprint,
    artifactNoteSha256: proof.artifactNoteSha256,
    harness,
    noteContent: proof.noteContent,
    notePath: proof.notePath,
    noteReceiptId: proof.noteReceiptId,
    receipt: proof.receipt,
    session,
  };
}

async function publicationAppendGraphFor(
  missionId: string,
): Promise<MissionGraphV3> {
  const descriptors = [
    sessionLifecycleDescriptor(
      "publish_research_to_linear",
      "linear",
      "publish",
    ),
    descriptorFor("append_to_current_file"),
  ];
  const names = descriptors.map((descriptor) => descriptor.name);
  const byName = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor] as const),
  );
  const registry: ToolRegistry = {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    getDescriptor: (name) => byName.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
  const objective = "Execute the bounded compatibility fixture.";
  const host = await buildHostMissionGraphPlanV1({
    missionId,
    objective,
    toolRegistry: registry,
    allowedToolNames: names,
    modelVisibleToolNames: names,
    plannedToolNames: names,
    currentNotePath: "Research/Brief.md",
    maxToolCalls: 4,
    maxWallClockMs: 120_000,
    now: GRAPH_TIME,
  });
  return (
    await planMissionGraphV3({
      mission: { missionId, objective },
      routerMode: "off",
      capabilityEnvelope: host.capabilityEnvelope,
      deterministicProposal: host.deterministicProposal,
      allowedToolDescriptors: host.allowedToolDescriptors,
      now: () => GRAPH_TIME.toISOString(),
    })
  ).graph;
}

async function deduplicatedPublicationReceiptFor(input: {
  rootRunId: string;
  noteContent: string;
}) {
  const notePath = "Research/Brief.md";
  const noteReceiptId = `research-note-${input.rootRunId}`.slice(0, 120);
  const artifactNoteSha256 = fp("d");
  const currentNoteSha256 = await sha256DiagramContent(input.noteContent);
  const acceptedAt = GRAPH_TIME.toISOString();
  const verifiedAt = new Date(
    GRAPH_TIME.getTime() + 60_000,
  ).toISOString();
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: `accepted-${input.rootRunId}`.slice(0, 150),
    originRunId: input.rootRunId,
    vaultBindingKey: "vault-test",
    notePath,
    noteSha256: artifactNoteSha256,
    noteReceiptId,
    evidence: [
      {
        id: "source-1",
        kind: "web",
        reference: "https://example.com/research-source",
        contentSha256: fp("a"),
      },
    ],
    acceptanceCriteria: [
      {
        id: "AC-1",
        text: "The accepted research remains linked to the verified issue.",
      },
    ],
    riskClass: "medium",
    acceptedAt,
    acceptedBy: "host",
  });
  const workItem = createWorkItemSpecV2({
    schemaVersion: 2,
    ready: true,
    executionClass: "research",
    objective: "Preserve the accepted research publication proof.",
    acceptanceCriteria: [...artifact.acceptanceCriteria],
    validationRequirementKeys: ["publication-proof"],
    evidenceRefs: ["https://example.com/research-source"],
    riskClass: artifact.riskClass,
    originRunId: input.rootRunId,
    acceptedResearchArtifactFingerprint: artifact.artifactFingerprint,
    generation: 0,
  });
  const issueId = "issue-publication-1";
  const issueIdentifier = "APP-1";
  const issueUrl = "https://linear.app/team/issue/APP-1";
  const issueSnapshotHash = fp("e");
  const binding = createExternalWorkItemBindingV1({
    schemaVersion: 1,
    bindingId: `linear-${artifact.artifactId}`.slice(0, 150),
    provider: "linear",
    originRunId: input.rootRunId,
    workspaceId: "workspace-1",
    teamId: "team-1",
    issueId,
    issueIdentifier,
    issueUrl,
    issueUpdatedAt: verifiedAt,
    workItemFingerprint: workItem.fingerprint,
    acceptedResearchArtifactFingerprint: artifact.artifactFingerprint,
    verifiedAt,
  });
  let lineage = createWorkItemLineageV1({
    schemaVersion: 1,
    lineageId: `publication-${artifact.artifactId}`.slice(0, 150),
    originRunId: input.rootRunId,
    executionClass: "research",
    workItemFingerprint: workItem.fingerprint,
    researchArtifactFingerprint: artifact.artifactFingerprint,
    events: [
      {
        sequence: 1,
        state: "accepted_research",
        domain: "research",
        occurredAt: acceptedAt,
        receiptId: `accepted-${artifact.artifactId}`.slice(0, 120),
        evidenceFingerprint: artifact.artifactFingerprint,
      },
    ],
  });
  lineage = appendWorkItemLineageTransitionV1(lineage, {
    state: "note_verified",
    occurredAt: acceptedAt,
    receiptId: artifact.noteReceiptId,
    evidenceFingerprint: artifact.noteSha256,
  });
  const publicationReceiptId =
    `linear-research-readback-${input.rootRunId}`.slice(0, 120);
  lineage = appendWorkItemLineageTransitionV1(lineage, {
    state: "linear_verified",
    occurredAt: verifiedAt,
    receiptId: `linear-readback-${issueId}`,
    evidenceFingerprint: binding.bindingFingerprint,
    externalWorkItemBindingFingerprint: binding.bindingFingerprint,
  });
  const issue = {
    resourceType: "issue" as const,
    id: issueId,
    identifier: issueIdentifier,
    url: issueUrl,
    title: "Accepted research",
    description: renderQueueExecutableHumanWorkItemSpecV2(workItem),
    priority: 0,
    trashed: false,
    team: { id: "team-1" },
    project: { id: "project-1" },
    state: { id: "state-1" },
    labels: [],
    createdAt: verifiedAt,
    updatedAt: verifiedAt,
    snapshotHash: issueSnapshotHash,
  };
  const approvalFingerprint = fp("f");
  const receipt = {
    version: 1,
    id: publicationReceiptId,
    runId: `${input.rootRunId}-segment`,
    actionId: "linear-readback-call-1",
    toolName: "linear_read_issue",
    operation: "read",
    resource: {
      system: "linear",
      resourceType: "issue",
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      teamId: issue.team.id,
      projectId: issue.project.id,
      revision: issue.updatedAt,
    },
    message:
      "Verified exact duplicate Linear issue APP-1; no mutation grant was created or consumed.",
    payloadFingerprint: approvalFingerprint,
    grantId: "linear-deduplicated-readback",
    idempotencyKey: `research-publication:${workItem.fingerprint}`,
    startedAt: verifiedAt,
    committedAt: verifiedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: verifiedAt,
      observedRevision: issue.updatedAt,
      observedFingerprint: issue.snapshotHash,
    },
    output: {
      ok: true,
      status: "complete",
      publication: "deduplicated",
      note: {
        path: notePath,
        operation: "no_op",
        beforeSha256: currentNoteSha256,
        afterSha256: currentNoteSha256,
        noteReceiptId,
        artifact,
        transaction: null,
      },
      artifact,
      lineage,
      approvalFingerprint,
      binding,
      issue,
      backlink: {
        path: notePath,
        operation: "append",
        beforeSha256: artifactNoteSha256,
        afterSha256: currentNoteSha256,
        issueUrl,
        transaction: null,
      },
      receipt: null,
    },
  } as ResearchPublicationResumeReceiptV1;
  return {
    artifactFingerprint: artifact.artifactFingerprint,
    artifactNoteSha256,
    noteContent: input.noteContent,
    notePath,
    noteReceiptId,
    receipt,
  };
}

async function graphFor(input: {
  missionId: string;
  allowedTools: string[];
  plannedTools: string[];
  postAcceptanceTools?: string[];
  maxToolCalls?: number;
  maxWallClockMs?: number;
}): Promise<MissionGraphV3> {
  const registry = registryFor(input.allowedTools);
  const host = await buildHostMissionGraphPlanV1({
    missionId: input.missionId,
    objective: "Execute the bounded session fixture mission.",
    toolRegistry: registry,
    allowedToolNames: input.allowedTools,
    plannedToolNames: input.plannedTools,
    postAcceptanceToolNames: input.postAcceptanceTools,
    currentNotePath: "Research/Brief.md",
    maxToolCalls: input.maxToolCalls ?? 8,
    maxWallClockMs: input.maxWallClockMs ?? 120_000,
    now: GRAPH_TIME,
  });
  return (
    await planMissionGraphV3({
      mission: {
        missionId: input.missionId,
        objective: "Execute the bounded session fixture mission.",
      },
      routerMode: "off",
      capabilityEnvelope: host.capabilityEnvelope,
      deterministicProposal: host.deterministicProposal,
      allowedToolDescriptors: host.allowedToolDescriptors,
      now: () => GRAPH_TIME.toISOString(),
    })
  ).graph;
}

async function workspaceCollisionGraphFor(
  missionId: string,
): Promise<MissionGraphV3> {
  const descriptors = [
    workspaceFileDescriptor("code_workspace_create_file"),
    workspaceFileDescriptor("code_workspace_read"),
    workspaceFileDescriptor("code_workspace_write_expected"),
  ];
  const names = descriptors.map((descriptor) => descriptor.name);
  const byName = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor] as const),
  );
  const registry: ToolRegistry = {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    getDescriptor: (name) => byName.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
  const objective = "Create app.py in the current code workspace.";
  const host = await buildHostMissionGraphPlanV1({
    missionId,
    objective,
    toolRegistry: registry,
    allowedToolNames: names,
    modelVisibleToolNames: names,
    plannedToolNames: ["code_workspace_create_file"],
    maxToolCalls: 4,
    maxWallClockMs: 120_000,
    now: GRAPH_TIME,
  });
  return (
    await planMissionGraphV3({
      mission: { missionId, objective },
      routerMode: "off",
      capabilityEnvelope: host.capabilityEnvelope,
      deterministicProposal: host.deterministicProposal,
      allowedToolDescriptors: host.allowedToolDescriptors,
      now: () => GRAPH_TIME.toISOString(),
    })
  ).graph;
}

async function compositeCodeCollisionGraphFor(
  missionId: string,
): Promise<MissionGraphV3> {
  const planned = [
    "code_sandbox_status",
    "code_workspace_create",
    "code_workspace_create_file",
    "code_validate_fast",
    "code_repair_record_cycle",
    "code_validate_targeted",
    "code_validate_full",
    "code_workspace_export_directory",
  ];
  const allowed = [
    ...planned,
    "code_workspace_read",
    "code_workspace_write_expected",
  ];
  const descriptors = allowed.map(workspaceFileDescriptor);
  const byName = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor] as const),
  );
  const registry: ToolRegistry = {
    getDefinitions: () =>
      allowed.map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    getDescriptor: (name) => byName.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
  const objective = "write a number guessing game in Python on my desktop";
  const host = await buildHostMissionGraphPlanV1({
    missionId,
    objective,
    toolRegistry: registry,
    allowedToolNames: allowed,
    modelVisibleToolNames: allowed,
    plannedToolNames: planned,
    maxToolCalls: 30,
    maxWallClockMs: 600_000,
    now: GRAPH_TIME,
  });
  return (
    await planMissionGraphV3({
      mission: { missionId, objective },
      routerMode: "off",
      capabilityEnvelope: host.capabilityEnvelope,
      deterministicProposal: host.deterministicProposal,
      allowedToolDescriptors: host.allowedToolDescriptors,
      now: () => GRAPH_TIME.toISOString(),
    })
  ).graph;
}

async function compositeLifecycleGraphFor(
  missionId: string,
  options: {
    includeUnplannedCurrentRead?: boolean;
    maxToolCalls?: number;
  } = {},
): Promise<MissionGraphV3> {
  const descriptors = [
    sessionLifecycleDescriptor("web_search", "browser", "read"),
    sessionLifecycleDescriptor(
      "publish_research_to_linear",
      "linear",
      "publish",
    ),
    sessionLifecycleDescriptor(
      "publish_research_project_to_linear",
      "linear",
      "publish",
    ),
    sessionLifecycleDescriptor("linear_get_issue", "linear", "read"),
    ...(options.includeUnplannedCurrentRead
      ? [sessionLifecycleDescriptor("read_current_file", "vault", "read")]
      : []),
  ];
  const names = descriptors.map((descriptor) => descriptor.name);
  const byName = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor] as const),
  );
  const registry: ToolRegistry = {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    getDescriptor: (name) => byName.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
  const objective = [
    "Research checkers rules using public web sources.",
    "Shape the accepted research into a Linear project and issues.",
  ].join(" ");
  const host = await buildHostMissionGraphPlanV1({
    missionId,
    objective,
    toolRegistry: registry,
    allowedToolNames: names,
    modelVisibleToolNames: names,
    plannedToolNames: [
      "web_search",
      "publish_research_to_linear",
      "publish_research_project_to_linear",
      "linear_get_issue",
    ],
    maxToolCalls: options.maxToolCalls ?? 4,
    maxWallClockMs: 120_000,
    now: GRAPH_TIME,
  });
  assert.ok(host.projectLifecycleIntent);
  return (
    await planMissionGraphV3({
      mission: { missionId, objective },
      routerMode: "off",
      capabilityEnvelope: host.capabilityEnvelope,
      deterministicProposal: host.deterministicProposal,
      allowedToolDescriptors: host.allowedToolDescriptors,
      now: () => GRAPH_TIME.toISOString(),
    })
  ).graph;
}

async function conditionalCodeLifecycleGraphFor(
  missionId: string,
): Promise<MissionGraphV3> {
  const names = [
    "web_search",
    "code_workspace_create",
    "code_validate_fast",
    "code_repair_record_cycle",
    "code_validate_targeted",
  ];
  const descriptors = names.map((name) =>
    sessionLifecycleDescriptor(
      name,
      name === "web_search" ? "browser" : "workspace",
      "read",
    ),
  );
  const byName = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor] as const),
  );
  const registry: ToolRegistry = {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    getDescriptor: (name) => byName.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
  const objective =
    "Research the requirements, then implement and validate the code workspace.";
  const host = await buildHostMissionGraphPlanV1({
    missionId,
    objective,
    toolRegistry: registry,
    allowedToolNames: names,
    modelVisibleToolNames: names,
    plannedToolNames: names,
    maxToolCalls: names.length,
    maxWallClockMs: 120_000,
    now: GRAPH_TIME,
  });
  assert.ok(host.projectLifecycleIntent);
  return (
    await planMissionGraphV3({
      mission: { missionId, objective },
      routerMode: "off",
      capabilityEnvelope: host.capabilityEnvelope,
      deterministicProposal: host.deterministicProposal,
      allowedToolDescriptors: host.allowedToolDescriptors,
      now: () => GRAPH_TIME.toISOString(),
    })
  ).graph;
}

function sessionLifecycleDescriptor(
  name: string,
  system: ToolDescriptor["capability"]["system"],
  effect: ToolDescriptor["effect"],
): ToolDescriptor {
  const readOnly = effect === "read";
  return {
    version: 1,
    name,
    capability: {
      system,
      resourceType: `${system}_lifecycle_resource`,
      action: readOnly ? "read" : "publish",
    },
    effect,
    risk: readOnly ? "low" : "high",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: readOnly,
      fallback: readOnly ? "none" : "exact",
    },
    execution: {
      preparation: readOnly ? "none" : "required",
      cacheable: readOnly,
      parallelSafe: readOnly,
    },
    durability: {
      journal: !readOnly,
      receipt: !readOnly,
      readback: readOnly ? "none" : "required",
      reconciliation: readOnly ? "none" : "required",
    },
    allowedPrincipals: ["single_agent", "lead"],
    ...(readOnly ? {} : { receiptKind: "external_action" as const }),
  };
}

function workspaceFileDescriptor(name: string): ToolDescriptor {
  const readOnly =
    name === "code_workspace_read" || name === "code_sandbox_status";
  return {
    version: 1,
    name,
    capability: {
      system: "workspace",
      resourceType: "workspace_file",
      action: readOnly ? "read" : "update",
    },
    effect: readOnly ? "read" : "reversible_mutation",
    risk: readOnly ? "low" : "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: readOnly,
      fallback: readOnly ? "none" : "exact",
    },
    execution: {
      preparation: readOnly ? "none" : "required",
      cacheable: readOnly,
      parallelSafe: readOnly,
    },
    durability: {
      journal: !readOnly,
      receipt: !readOnly,
      readback: readOnly ? "none" : "required",
      reconciliation: readOnly ? "none" : "required",
    },
    allowedPrincipals: ["single_agent", "lead"],
    ...(readOnly ? {} : { receiptKind: "code_change" as const }),
  };
}

function registryFor(names: string[]): ToolRegistry {
  const descriptors = new Map(
    names.map((name) => [name, descriptorFor(name)] as const),
  );
  return {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    getDescriptor: (name) => descriptors.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
}

function saturateContinuationReserve(graph: MissionGraphV3): MissionGraphV3 {
  const result = JSON.parse(JSON.stringify(graph)) as MissionGraphV3;
  const aggregate = graphBudget(result);
  result.nodes.final.budget = {
    toolCalls:
      result.nodes.final.budget.toolCalls +
      result.capabilityEnvelope.budgets.maxTotalToolCalls -
      aggregate.toolCalls,
    externalActions:
      result.nodes.final.budget.externalActions +
      result.capabilityEnvelope.budgets.maxExternalActions -
      aggregate.externalActions,
    wallClockMs:
      result.nodes.final.budget.wallClockMs +
      result.capabilityEnvelope.budgets.maxWallClockMs -
      aggregate.wallClockMs,
  };
  return result;
}

function graphBudget(graph: MissionGraphV3): {
  toolCalls: number;
  externalActions: number;
  wallClockMs: number;
} {
  return Object.values(graph.nodes).reduce(
    (total, node) => ({
      toolCalls: total.toolCalls + node.budget.toolCalls,
      externalActions: total.externalActions + node.budget.externalActions,
      wallClockMs: total.wallClockMs + node.budget.wallClockMs,
    }),
    { toolCalls: 0, externalActions: 0, wallClockMs: 0 },
  );
}

function requireExecution(result: MissionGraphToolStartResult): MissionGraphToolExecution {
  if (!result.ok) throw new Error(result.reason);
  return result.execution;
}

function toolNode(graph: MissionGraphV3, toolName: string): MissionNodeV3 {
  const node = Object.values(graph.nodes).find((candidate) =>
    candidate.allowedTools.includes(toolName),
  );
  if (!node) throw new Error(`Missing graph node for ${toolName}.`);
  return node;
}

function evidenceFor(
  node: MissionNodeV3,
  character: string,
  observedAt: string,
): MissionEvidenceRefV1 {
  return {
    id: `evidence-${node.id}-${character}`.slice(0, 128),
    kind: node.completionContract.requiredEvidenceKinds[0] ?? "tool-result",
    fingerprint: fp(character),
    observedAt,
  };
}

function lifecycleProofFor(
  node: MissionNodeV3,
  character: string,
  observedAt: string,
): {
  ok: true;
  evidence: MissionEvidenceRefV1;
  receipt?: MissionReceiptRefV1;
} {
  const action = getCurrentMissionCompositeLifecycleActionV1(node);
  if (!action) throw new Error(`Missing lifecycle action for ${node.id}.`);
  return {
    ok: true,
    evidence: {
      id: `evidence-${node.id}-${character}`.slice(0, 128),
      kind: action.requiredEvidenceKinds[0] ?? "tool-result",
      fingerprint: fp(character),
      observedAt,
    },
    ...(action.minimumReceipts > 0
      ? {
          receipt: {
            id: `receipt-${node.id}-${character}`.slice(0, 128),
            kind: action.requiredReceiptKinds[0] ?? "action-receipt",
            fingerprint: fp(character),
            committedAt: observedAt,
          },
        }
      : {}),
  };
}

function receiptFor(
  node: MissionNodeV3,
  character: string,
  committedAt: string,
): MissionReceiptRefV1 {
  return {
    id: `receipt-${node.id}-${character}`.slice(0, 128),
    kind: node.completionContract.requiredReceiptKinds[0] ?? "action-receipt",
    fingerprint: fp(character),
    committedAt,
  };
}

async function requireStored(context: ToolExecutionContext, missionId: string) {
  const stored = await readMissionGraphStoreRecord(context, missionId);
  if (!stored) throw new Error(`Missing stored graph ${missionId}.`);
  return stored;
}

function createVaultHarness(): {
  context: ToolExecutionContext;
  files: Map<string, string>;
  writes: string[];
  nextTimestamp: () => string;
} {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const writes: string[] = [];
  let nowMs = Date.parse("2026-07-11T19:00:00.000Z");
  const nextDate = () => {
    const now = new Date(nowMs);
    nowMs += 1_000;
    return now;
  };
  const getFile = (path: string) =>
    files.has(path) ? { path, name: path.split("/").at(-1) ?? path } : null;
  const vault = {
    getFileByPath: getFile,
    getFolderByPath: (path: string) =>
      folders.has(path) ? { path, name: path.split("/").at(-1) ?? path } : null,
    createFolder: async (path: string) => {
      folders.add(path);
      writes.push(`folder:${path}`);
    },
    create: async (path: string, content: string) => {
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      files.set(path, content);
      writes.push(`create:${path}`);
      return getFile(path);
    },
    read: async (file: { path: string }) => files.get(file.path) ?? "",
    modify: async (file: { path: string }, content: string) => {
      if (!files.has(file.path)) throw new Error(`Missing file: ${file.path}`);
      files.set(file.path, content);
      writes.push(`modify:${file.path}`);
    },
  };
  return {
    files,
    writes,
    nextTimestamp: () => nextDate().toISOString(),
    context: {
      app: { vault },
      settings: {},
      originalPrompt: "mission graph session fixture",
      httpTransport: {},
      now: nextDate,
    } as unknown as ToolExecutionContext,
  };
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
