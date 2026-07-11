import test from "node:test";
import assert from "node:assert/strict";

import {
  OrchestratorRuntime,
  createCodeTeamScaffold,
  createResearchTeamScaffold,
  shouldUseResearchTeam,
} from "../src/orchestrator/orchestratorRuntime";

test("research runtime projects progressive nodes and terminal state", async () => {
  const observed: number[] = [];
  const runtime = new OrchestratorRuntime({
    runId: "run-1",
    mode: "research_team",
    now: () => new Date("2026-07-10T00:00:00.000Z"),
    onEvent: (_event, snapshot) => {
      observed.push(snapshot.sequence);
    },
  });
  const scaffold = createResearchTeamScaffold({
    runId: "run-1",
    mission: "Research templates",
    workerMaxSteps: 20,
    workerMaxToolCalls: 24,
    workerMaxMinutes: 15,
  });
  runtime.registerParticipantBudget({ participantId: "lead", modelSteps: 80, toolCalls: 176, wallClockMs: 900_000, lead: true });
  runtime.registerParticipantBudget({ participantId: "researcher", modelSteps: 20, toolCalls: 24, wallClockMs: 900_000 });
  await runtime.start(scaffold);
  await runtime.progress("run-1:research", { status: "running", lastAction: "Searching" });
  await runtime.completeNode("run-1:research", "Evidence ready");
  const final = await runtime.finish("complete", "Done");
  assert.equal(final.status, "complete");
  assert.equal(final.nodes["run-1:research"].status, "complete");
  assert.deepEqual(observed, [1, 2, 3, 4]);
});

test("team routing remains conditional and prompt-first", () => {
  assert.equal(shouldUseResearchTeam("Deep research current sources", true), true);
  assert.equal(shouldUseResearchTeam("Verify these citations", true), true);
  assert.equal(shouldUseResearchTeam("Research this topic", true), false);
  assert.equal(shouldUseResearchTeam("Write a poem", true), false);
  assert.equal(shouldUseResearchTeam("Research sources", false), false);
  assert.equal(shouldUseResearchTeam("Verify sources", true, true), false);
});

test("budget rejection is terminal to callers instead of silently observational", async () => {
  const runtime = new OrchestratorRuntime({
    runId: "budget-run",
    mode: "research_team",
    rootModelSteps: 5,
    rootToolCalls: 5,
    rootWallClockMs: 1_000,
    finalizationReserveSteps: 0,
  });
  runtime.registerParticipantBudget({
    participantId: "researcher",
    modelSteps: 1,
    toolCalls: 1,
    wallClockMs: 100,
  });
  await runtime.start({
    participants: createResearchTeamScaffold({
      runId: "budget-run",
      mission: "Bounded research",
      workerMaxSteps: 1,
      workerMaxToolCalls: 1,
      workerMaxMinutes: 1,
    }).participants,
    nodes: [],
  });
  await assert.rejects(
    runtime.consumeOrThrow("researcher", "modelSteps", 2),
    /participant_limit/,
  );
  assert.equal(
    runtime.budget.toParticipantBudget("researcher")?.modelSteps.used,
    0,
  );
});

test("code team scaffold uses a real code-worker participant owner", () => {
  const scaffold = createCodeTeamScaffold({
    runId: "code-run",
    mission: "Implement the scoped change",
    workerMaxSteps: 20,
    workerMaxToolCalls: 24,
    workerMaxMinutes: 15,
  });
  assert.equal(scaffold.participants[1]?.id, "code_worker");
  assert.equal(scaffold.participants[1]?.role, "code_worker");
  assert.equal(scaffold.nodes.find((node) => node.kind === "code")?.ownerId, "code_worker");
});

test("Lead acceptance is projected onto the retained handoff", async () => {
  const runtime = new OrchestratorRuntime({
    runId: "handoff-run",
    mode: "research_team",
  });
  const scaffold = createResearchTeamScaffold({
    runId: "handoff-run",
    mission: "Research handoff",
    workerMaxSteps: 20,
    workerMaxToolCalls: 24,
    workerMaxMinutes: 15,
  });
  await runtime.start(scaffold);
  await runtime.handoffReady({
    id: "handoff-1",
    fromParticipantId: "researcher",
    toParticipantId: "lead",
    taskId: "handoff-run:research",
    status: "ready",
    summary: "Evidence ready",
    sourceIds: ["source-1"],
    evidenceIds: ["evidence-1"],
    unresolvedQuestions: [],
    confidence: "high",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  });
  const snapshot = await runtime.updateHandoff(
    "handoff-1",
    "accepted",
    "Lead accepted the evidence.",
  );
  assert.equal(snapshot.handoffs[0]?.status, "accepted");
  assert.equal(snapshot.handoffs[0]?.summary, "Lead accepted the evidence.");
});

test("blocked merge summaries remain blocked in replayed UI state", async () => {
  const runtime = new OrchestratorRuntime({
    runId: "blocked-merge-run",
    mode: "code_team",
  });
  await runtime.start({ participants: [], nodes: [] });
  const snapshot = await runtime.mergeCompleted({
    status: "blocked",
    evidenceReceived: 0,
    evidenceAccepted: 0,
    evidenceRejected: 0,
    evidenceDeduplicated: 0,
    conflicts: 1,
    commitShas: ["abc1234"],
    verificationStatus: "failed",
    integrationStatus: "failed",
    blocker: "integration_conflict",
  });
  assert.equal(snapshot.merge.status, "blocked");
  assert.equal(snapshot.merge.blocker, "integration_conflict");
});
