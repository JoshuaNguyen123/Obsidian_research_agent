import assert from "node:assert/strict";
import test from "node:test";
import { buildHostMissionGraphPlanV1 } from "../src/agent/missionGraphHost";
import { planMissionGraphV3 } from "../src/agent/missionGraphPlanner";
import {
  MissionGraphSession,
  resolveMissionGraphEvidenceKind,
  type MissionGraphToolExecution,
  type MissionGraphToolStartResult,
} from "../src/agent/missionGraphSession";
import {
  getMissionGraphStorePath,
  persistPreparedMissionGraphPatch,
  readMissionGraphStoreRecord,
} from "../src/agent/missionGraphStore";
import type { ToolDescriptor } from "../src/agent/actions";
import {
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
  assert.equal(expired.nodes[execution.nodeId].status, "blocked");
  assert.equal(expired.nodes[execution.nodeId].blocker?.code, "approval_expired");
  assert.doesNotMatch(
    expired.nodes[execution.nodeId].blocker?.message ?? "",
    /User denied/u,
  );
  const stored = await requireStored(harness.context, graph.missionId);
  assert.deepEqual(stored.record.resourceLocks.locks, {});
});

async function graphFor(input: {
  missionId: string;
  allowedTools: string[];
  plannedTools: string[];
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
