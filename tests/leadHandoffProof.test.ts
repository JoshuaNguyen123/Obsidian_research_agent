import assert from "node:assert/strict";
import test from "node:test";
import { proofDebtSeedsFromOrchestratorHandoff } from "../src/agent/leadHandoffProof";

test("proofDebtSeedsFromOrchestratorHandoff maps ready handoff with sources", () => {
  const result = proofDebtSeedsFromOrchestratorHandoff({
    handoffReady: true,
    usableSourceCount: 2,
    unresolvedQuestions: [],
  });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.nextToolHints, []);
});

test("proofDebtSeedsFromOrchestratorHandoff flags missing sources and hints web tools", () => {
  const notReady = proofDebtSeedsFromOrchestratorHandoff({
    handoffReady: false,
    usableSourceCount: 0,
    unresolvedQuestions: [],
  });
  assert.deepEqual(notReady.missing, ["orchestrator_handoff:usable_sources"]);
  assert.deepEqual(notReady.nextToolHints, ["web_search", "web_fetch"]);

  const zeroSources = proofDebtSeedsFromOrchestratorHandoff({
    handoffReady: true,
    usableSourceCount: 0,
    unresolvedQuestions: [],
  });
  assert.deepEqual(zeroSources.missing, ["orchestrator_handoff:usable_sources"]);
  assert.deepEqual(zeroSources.nextToolHints, ["web_search", "web_fetch"]);
});

test("proofDebtSeedsFromOrchestratorHandoff maps unresolved questions into missing", () => {
  const result = proofDebtSeedsFromOrchestratorHandoff({
    handoffReady: true,
    usableSourceCount: 3,
    unresolvedQuestions: [" What is the latest policy? ", "", "Compare vendors"],
  });
  assert.deepEqual(result.missing, [
    "orchestrator_handoff:unresolved:What is the latest policy?",
    "orchestrator_handoff:unresolved:Compare vendors",
  ]);
  assert.deepEqual(result.nextToolHints, []);
});
