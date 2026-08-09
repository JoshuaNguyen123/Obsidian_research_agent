import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdaptiveTeamScaffoldV2,
  isAdaptiveTeamParticipantSet,
} from "../src/orchestrator/adaptiveTeam";
import {
  createMissionLedger,
  summarizeMissionLedger,
} from "../src/agent/missionLedger";
import {
  createSpecialistAuthorityV2,
  decideSpecialistToolAuthorityV2,
} from "../src/orchestrator/specialistAuthority";
import {
  createSpecialistHandoffV2,
  fingerprintSpecialistInput,
  fingerprintSpecialistWorkspaceDiff,
  isSpecialistHandoffV2,
  validateSpecialistHandoffV2,
} from "../src/orchestrator/specialistHandoff";
import {
  authorizeSpecialistRepairV2,
  createSpecialistRepairStateV2,
} from "../src/orchestrator/specialistRecovery";
import { normalizeOrchestratorSnapshot } from "../src/orchestrator/orchestratorStore";
import { OrchestratorRuntime } from "../src/orchestrator/orchestratorRuntime";
import type { WorkerHandoff } from "../src/orchestrator/types";

const NOW = "2026-08-08T12:00:00.000Z";

test("adaptive scaffold contains exactly Lead and one mode-changing Specialist", () => {
  const scaffold = createAdaptiveTeamScaffoldV2({
    runId: "mission-1",
    mission: "Research, plan Linear work, then build code",
    specialistModes: ["researcher", "linear_planner", "code_builder", "code_reviewer"],
    specialistMaxSteps: 24,
    specialistMaxToolCalls: 40,
    specialistMaxMinutes: 15,
    leadMaxSteps: 30,
    leadMaxToolCalls: 60,
    leadMaxMinutes: 20,
    now: new Date(NOW),
  });
  assert.equal(scaffold.participants.length, 2);
  assert.deepEqual(scaffold.participants.map((item) => item.id), [
    "lead",
    "specialist",
  ]);
  assert.equal(
    isAdaptiveTeamParticipantSet(
      Object.fromEntries(scaffold.participants.map((item) => [item.id, item])),
    ),
    true,
  );
  assert.equal(scaffold.participants[1].role, "specialist");
  assert.equal(scaffold.participants[1].specialistMode, "researcher");
  assert.deepEqual(scaffold.specialistModes, [
    "researcher",
    "linear_planner",
    "code_builder",
    "code_reviewer",
  ]);
});

test("Specialist handoff binds input/progress and fails closed on stale proof", () => {
  const handoff = createSpecialistHandoffV2({
    handoff: workerHandoff(),
    missionGraphId: "mission-1",
    specialistMode: "researcher",
    missionInput: { prompt: "Verify distributed systems sources" },
    acceptanceCriteria: ["Two fetched passages are independently verified."],
    receiptIds: ["receipt-1"],
    artifactIds: ["artifact-1"],
    validationIds: ["validation-1"],
    recommendedNextAction: "Lead verifies and synthesizes.",
  });
  assert.match(handoff.inputFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.match(handoff.progressFingerprint, /^sha256:[a-f0-9]{64}$/u);
  const expectedInput = fingerprintSpecialistInput({
    missionGraphId: "mission-1",
    specialistMode: "researcher",
    missionInput: { prompt: "Verify distributed systems sources" },
    acceptanceCriteria: ["Two fetched passages are independently verified."],
  });
  const valid = validateSpecialistHandoffV2(handoff, {
    missionGraphId: "mission-1",
    inputFingerprint: expectedInput,
    evidenceIds: new Set(["evidence-1"]),
    receiptIds: new Set(["receipt-1"]),
    artifactIds: new Set(["artifact-1"]),
    validationIds: new Set(["validation-1"]),
  });
  assert.deepEqual(valid, { ok: true, missing: [], stale: [] });
  const stale = validateSpecialistHandoffV2(handoff, {
    missionGraphId: "different-mission",
    evidenceIds: new Set(),
    receiptIds: new Set(),
    artifactIds: new Set(),
    validationIds: new Set(),
  });
  assert.equal(stale.ok, false);
  assert.ok(stale.stale.includes("mission_graph"));
  assert.ok(stale.missing.includes("evidence:evidence-1"));
});

test("code authority is workspace-only and never grants external mutation", () => {
  const authority = createSpecialistAuthorityV2({
    mode: "code_builder",
    workspaceLease: {
      schemaVersion: 2,
      leaseId: "lease-1",
      missionGraphId: "mission-1",
      rootPath: "C:\\approved\\worktree",
      expiresAt: "2026-08-08T13:00:00.000Z",
    },
  });
  const inside = decideSpecialistToolAuthorityV2({
    authority,
    toolName: "code_write_file",
    effect: "workspace_write",
    workspacePath: "src/index.ts",
    now: new Date(NOW),
  });
  assert.equal(inside.allowed, true);
  assert.match(inside.resolvedWorkspacePath ?? "", /approved[\\/]worktree[\\/]src[\\/]index\.ts$/u);
  assert.deepEqual(
    decideSpecialistToolAuthorityV2({
      authority,
      toolName: "code_write_file",
      effect: "workspace_write",
      workspacePath: "../outside.ts",
      now: new Date(NOW),
    }),
    { allowed: false, reason: "workspace_path_escape" },
  );
  assert.deepEqual(
    decideSpecialistToolAuthorityV2({
      authority,
      toolName: "github_create_repository",
      effect: "external_write",
      now: new Date(NOW),
    }),
    { allowed: false, reason: "external_mutation_lead_only" },
  );
});

test("only one materially different peer repair cycle can be authorized", () => {
  const progress = fingerprintSpecialistWorkspaceDiff(["src/index.ts"]);
  const same = authorizeSpecialistRepairV2({
    state: createSpecialistRepairStateV2(),
    failedProgressFingerprint: progress,
    previousApproach: "Retry the same web search query",
    revisedApproach: "Retry the same web search query again",
  });
  assert.equal(same.authorized, false);
  assert.equal(same.reason, "revised_approach_not_materially_different");

  const first = authorizeSpecialistRepairV2({
    state: createSpecialistRepairStateV2(),
    failedProgressFingerprint: progress,
    previousApproach: "Retry the same web search query",
    revisedApproach: "Inspect the vault source ledger and fetch primary documents",
  });
  assert.equal(first.authorized, true);
  assert.equal(first.state.cyclesUsed, 1);
  const second = authorizeSpecialistRepairV2({
    state: first.state,
    failedProgressFingerprint: progress,
    previousApproach: "Inspect the vault source ledger and fetch primary documents",
    revisedApproach: "Ask a different provider to diagnose the blocker",
  });
  assert.equal(second.authorized, false);
  assert.equal(second.reason, "repair_cycle_exhausted");
});

test("persisted V1 researcher/code-worker snapshots migrate to the V2 pair", () => {
  const migrated = normalizeOrchestratorSnapshot({
    version: 1,
    runId: "legacy-team",
    mode: "code_team",
    status: "running",
    participants: {
      lead: participant("lead", "lead"),
      worker: participant("worker", "code_worker"),
    },
    nodes: {
      code: {
        id: "code",
        parentId: null,
        childIds: [],
        kind: "code",
        title: "Build code",
        status: "running",
        ownerId: "worker",
        dependencyIds: [],
        evidenceIds: [],
        receiptIds: [],
        artifactIds: [],
      },
    },
    handoffs: [],
    worktrees: {},
    rootNodeIds: ["code"],
    merge: {},
    sequence: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(migrated?.mode, "adaptive_team");
  assert.deepEqual(Object.keys(migrated?.participants ?? {}).sort(), [
    "lead",
    "specialist",
  ]);
  assert.equal(migrated?.participants.specialist.role, "specialist");
  assert.equal(migrated?.participants.specialist.specialistMode, "code_builder");
  assert.equal(migrated?.nodes.code.ownerId, "specialist");
});

test("runtime persists V2 handoff acceptance and repair accounting", async () => {
  const runtime = new OrchestratorRuntime({
    runId: "mission-runtime",
    mode: "adaptive_team",
  });
  const scaffold = createAdaptiveTeamScaffoldV2({
    runId: "mission-runtime",
    mission: "Verify sources",
    specialistModes: ["researcher"],
    specialistMaxSteps: 8,
    specialistMaxToolCalls: 12,
    specialistMaxMinutes: 5,
  });
  await runtime.start(scaffold);
  const handoff = createSpecialistHandoffV2({
    handoff: { ...workerHandoff(), taskId: scaffold.nodeIds.specialist },
    missionGraphId: "mission-runtime",
    specialistMode: "researcher",
    missionInput: "Verify sources",
    acceptanceCriteria: ["Evidence resolves."],
    recommendedNextAction: "Lead verifies.",
  });
  await runtime.specialistHandoffReady(handoff, {
    missionGraphId: "mission-runtime",
    evidenceIds: new Set(["evidence-1"]),
    receiptIds: new Set(),
    artifactIds: new Set(),
    validationIds: new Set(),
  });
  assert.equal(runtime.getSnapshot()?.handoffs[0]?.fromParticipantId, "specialist");
  const repair = await runtime.authorizeSpecialistRepair({
    failedProgressFingerprint: handoff.progressFingerprint,
    previousApproach: "Repeat the failed query against the same endpoint",
    revisedApproach: "Read local notes and fetch the primary specification",
  });
  assert.equal(repair.authorized, true);
  assert.equal(repair.snapshot.participants.specialist.specialistMode, "recovery_verifier");
  const exhausted = await runtime.authorizeSpecialistRepair({
    failedProgressFingerprint: handoff.progressFingerprint,
    previousApproach: "Read local notes and fetch the primary specification",
    revisedApproach: "Inspect a second source and compare contradictions",
  });
  assert.equal(exhausted.authorized, false);
  assert.equal(exhausted.snapshot.participants.specialist.repairState?.status, "exhausted");
});

test("runtime rejects a proof-resolved V2 handoff whose worker status is rejected", async () => {
  const runtime = new OrchestratorRuntime({
    runId: "mission-rejected-status",
    mode: "adaptive_team",
  });
  const scaffold = createAdaptiveTeamScaffoldV2({
    runId: "mission-rejected-status",
    mission: "Verify sources",
    specialistModes: ["researcher"],
    specialistMaxSteps: 6,
    specialistMaxToolCalls: 6,
    specialistMaxMinutes: 2,
  });
  await runtime.start(scaffold);
  const handoff = createSpecialistHandoffV2({
    handoff: {
      ...workerHandoff(),
      taskId: scaffold.nodeIds.specialist,
      status: "rejected",
    },
    missionGraphId: "mission-rejected-status",
    specialistMode: "researcher",
    missionInput: "Verify sources",
    acceptanceCriteria: ["Evidence resolves."],
    recommendedNextAction: "Lead recovers missing proof.",
  });

  await assert.rejects(
    runtime.specialistHandoffReady(handoff, {
      missionGraphId: "mission-rejected-status",
      evidenceIds: new Set(["evidence-1"]),
      receiptIds: new Set(),
      artifactIds: new Set(),
      validationIds: new Set(),
    }),
    /status:rejected/iu,
  );
  assert.equal(runtime.getSnapshot()?.handoffs.length, 0);
});

test("ledger summary retains the accepted adaptive handoff independently of the canonical graph projection", async () => {
  const runtime = new OrchestratorRuntime({
    runId: "mission-projection",
    mode: "adaptive_team",
  });
  const scaffold = createAdaptiveTeamScaffoldV2({
    runId: "mission-projection",
    mission: "Research then write",
    specialistModes: ["researcher"],
    specialistMaxSteps: 6,
    specialistMaxToolCalls: 6,
    specialistMaxMinutes: 2,
  });
  await runtime.start(scaffold);
  const handoff = createSpecialistHandoffV2({
    handoff: {
      ...workerHandoff(),
      taskId: scaffold.nodeIds.specialist,
      status: "accepted",
    },
    missionGraphId: "mission-projection",
    specialistMode: "researcher",
    missionInput: "Research then write",
    acceptanceCriteria: ["Evidence resolves."],
    recommendedNextAction: "Lead writes the verified result.",
  });
  await runtime.specialistHandoffReady(handoff, {
    missionGraphId: "mission-projection",
    evidenceIds: new Set(["evidence-1"]),
    receiptIds: new Set(),
    artifactIds: new Set(),
    validationIds: new Set(),
  });
  await runtime.updateHandoff(handoff.id, "accepted", handoff.summary);
  const adaptive = runtime.getSnapshot();
  assert.ok(adaptive);
  assert.equal(adaptive.mode, "adaptive_team");
  assert.deepEqual(Object.keys(adaptive.participants).sort(), [
    "lead",
    "specialist",
  ]);
  assert.equal(adaptive.handoffs.length, 1);
  const adaptiveHandoff = adaptive.handoffs[0];
  assert.ok(adaptiveHandoff && isSpecialistHandoffV2(adaptiveHandoff));
  assert.equal(adaptiveHandoff.status, "accepted");
  assert.match(adaptiveHandoff.progressFingerprint, /^sha256:[a-f0-9]{64}$/u);

  const ledger = createMissionLedger({
    runId: "mission-projection",
    mission: "Research then write",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 12,
      toolStepBudget: 8,
      finalizationReserve: 4,
      expectedTools: ["append_to_current_file"],
      stopWhenSatisfied: true,
    },
    now: new Date(NOW),
  });
  // MissionGraph remains the canonical task authority. The Lead ledger owns
  // the subordinate adaptive runtime because it contains the Specialist task
  // node that validates this proof-bearing handoff's taskId.
  ledger.orchestrator = adaptive;
  const summary = summarizeMissionLedger(ledger);
  assert.equal(summary.orchestrator?.mode, "adaptive_team");
  assert.equal(summary.orchestrator?.handoffs[0]?.status, "accepted");
});

function workerHandoff(): WorkerHandoff {
  return {
    id: "handoff-1",
    fromParticipantId: "researcher",
    toParticipantId: "lead",
    taskId: "mission-1:specialist",
    status: "ready",
    summary: "Grounded findings ready.",
    sourceIds: ["source-1"],
    evidenceIds: ["evidence-1"],
    unresolvedQuestions: [],
    confidence: "high",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function participant(id: string, role: "lead" | "code_worker") {
  return {
    id,
    role,
    displayName: role === "lead" ? "Lead" : "Code Worker",
    status: role === "lead" ? "planning" : "coding",
    currentNodeId: role === "lead" ? null : "code",
    budget: {
      modelSteps: { used: 0, limit: 10 },
      toolCalls: { used: 0, limit: 20 },
      wallClockMs: { used: 0, limit: 60_000 },
    },
    handoffStatus: "none",
    updatedAt: NOW,
  };
}
