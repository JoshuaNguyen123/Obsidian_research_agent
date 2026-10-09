import assert from "node:assert/strict";
import test from "node:test";
import { decideNextLoopAction } from "../src/agent/loopDecision";
import * as selectors from "../src/agent/missionGraphSelectors";
import type { MissionGraphV3 } from "../packages/headless-runtime/src/missionGraphV3";

const budget = { hardCap: 8, toolStepBudget: 7, finalizationReserve: 1, expectedTools: ["read_file"], stopWhenSatisfied: true };
const ledger = { successfulTools: ["read_file"], failedTools: [], repeatedToolCalls: 0, requiredToolsSatisfied: true, finalizationReserved: true, writeCompleted: false };
test("one successful source read cannot force final while a second required read remains", () => {
  assert.equal(decideNextLoopAction({ ...ledger, ...{ planHasPendingTool: true } }, budget).action, "continue_planned_action");
});
test("tool-slot reserve cannot force final over unpaid graph proof", () => {
  assert.equal(decideNextLoopAction({ ...ledger, requiredToolsSatisfied: false, successfulTools: Array(7).fill("read_file"), ...{ planHasPendingTool: true } }, budget).action, "continue_planned_action");
});
test("paid source nodes still reserve the final synthesis", () => {
  assert.equal(decideNextLoopAction({ ...ledger, ...{ planHasPendingTool: false } }, budget).action, "force_final_no_tools");
});
function graph(firstStatus = "complete", secondStatus = "queued"): MissionGraphV3 {
  return { nodes: {
    trial: { id: "trial", status: firstStatus, dependencyIds: [], allowedTools: ["read_file"] },
    notice: { id: "notice", status: secondStatus, dependencyIds: ["trial"], allowedTools: ["read_file"] },
    final: { id: "final", status: "queued", dependencyIds: ["trial", "notice"], allowedTools: [], completionContract: { requiredEvidenceKinds: ["final-output"] } },
    "optional-extra": { id: "optional-extra", status: "queued", dependencyIds: [], allowedTools: ["read_file"] },
  } } as unknown as MissionGraphV3;
}
// Baseline has no debt selector: the runner's existing name-only accounting
// treats the first successful read as satisfying read_file. Keep that exact
// baseline behavior visible while the same assertions exercise the correction.
const newSelectors = selectors as typeof selectors & {
  missionGraphHasRequiredToolDebtV1?: (graph: MissionGraphV3 | null) => boolean;
  missionGraphHasQueuedToolDependencyV1?: (graph: MissionGraphV3, name: string) => boolean;
};
test("required source debt follows final dependencies, excluding optional enrichment", () => {
  assert.equal(newSelectors.missionGraphHasRequiredToolDebtV1?.(graph()) ?? false, true);
  assert.equal(newSelectors.missionGraphHasRequiredToolDebtV1?.(graph("complete", "complete")) ?? false, false);
  assert.equal(newSelectors.missionGraphHasRequiredToolDebtV1?.(null) ?? false, false);
});
test("failed and running required reads cannot be treated as paid", () => {
  for (const status of ["running", "blocked", "cancelled", "ready"]) assert.equal(newSelectors.missionGraphHasRequiredToolDebtV1?.(graph("complete", status)) ?? false, true);
});
test("dependent reads bind batch preparation to the current ready slots", () => {
  const value = graph("ready", "queued");
  delete value.nodes["optional-extra"];
  assert.equal(newSelectors.missionGraphHasQueuedToolDependencyV1?.(value, "read_file") ?? false, true);
  assert.equal(selectors.countReadyMissionGraphToolSlots(value, "read_file"), 1);
  value.nodes.notice.status = "ready";
  assert.equal(newSelectors.missionGraphHasQueuedToolDependencyV1?.(value, "read_file") ?? false, false);
  assert.equal(selectors.countReadyMissionGraphToolSlots(value, "read_file"), 2);
});

test("independent web source gathering keeps its existing parallel continuation", () => {
  const value = graph("ready", "queued");
  value.nodes.trial.allowedTools = ["web_fetch"];
  value.nodes.notice.allowedTools = ["web_fetch"];
  assert.equal(newSelectors.missionGraphHasQueuedToolDependencyV1?.(value, "web_fetch") ?? false, false);
});
