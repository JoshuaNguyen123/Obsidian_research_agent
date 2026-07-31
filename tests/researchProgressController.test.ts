import test from "node:test";
import assert from "node:assert/strict";
import {
  computeBatchEvidenceYield,
  createResearchProgressController,
} from "../src/agent/researchProgressController";

const NO_UNRESOLVED = {
  acceptanceGaps: [] as string[],
  remainingQuestions: 0,
  conflicts: 0,
};

const OPEN_QUESTION = {
  acceptanceGaps: [] as string[],
  remainingQuestions: 1,
  conflicts: 0,
};

test("computeBatchEvidenceYield normalizes and skips synthesis-only turns", () => {
  assert.equal(computeBatchEvidenceYield({ toolCalls: 0, newEvidenceCount: 3 }), null);
  assert.equal(computeBatchEvidenceYield({ toolCalls: 4, newEvidenceCount: 2 }), 0.5);
  assert.equal(computeBatchEvidenceYield({ toolCalls: 2, newEvidenceCount: 10 }), 1);
  assert.equal(computeBatchEvidenceYield({ toolCalls: 3, newEvidenceCount: 0 }), 0);
});

test("saturation stops the loop after two low-yield batches with nothing unresolved", () => {
  const controller = createResearchProgressController({ tier: "quick" });

  const first = controller.evaluateBatch(
    { toolCalls: 1, newEvidenceCount: 0 },
    NO_UNRESOLVED,
  );
  assert.equal(first.action, "continue");

  const second = controller.evaluateBatch(
    { toolCalls: 1, newEvidenceCount: 0 },
    NO_UNRESOLVED,
  );
  assert.equal(second.action, "stop");
  assert.equal(second.reason, "acceptance_saturated");
});

test("useful evidence with open work keeps the loop running", () => {
  const controller = createResearchProgressController({ tier: "standard" });
  const decision = controller.evaluateBatch(
    { toolCalls: 2, newEvidenceCount: 2 },
    OPEN_QUESTION,
  );
  assert.equal(decision.action, "continue");
  assert.equal(decision.reason, "unresolved_proof");
});

test("a nearly-spent tier escalates one step while evidence still arrives", () => {
  const controller = createResearchProgressController({ tier: "deep" });
  // Drive utilization to the 0.75 escalation line in a single batch.
  const decision = controller.evaluateBatch(
    { modelSteps: 45, toolCalls: 1, newEvidenceCount: 1 },
    OPEN_QUESTION,
  );
  assert.equal(decision.action, "escalate");
  assert.equal(decision.nextTier, "extended");
  assert.equal(controller.getTier(), "extended");
});

test("extended work rolls into its next durable segment", () => {
  const controller = createResearchProgressController({ tier: "extended" });
  const decision = controller.evaluateBatch(
    { modelSteps: 100, toolCalls: 1, newEvidenceCount: 1 },
    OPEN_QUESTION,
  );
  assert.equal(decision.action, "continue");
  assert.equal(decision.reason, "start_next_segment");
  assert.equal(decision.startNewSegment, true);
  assert.equal(controller.snapshot().usage.segmentsStarted, 2);
  assert.equal(controller.snapshot().usage.modelStepsInCurrentSegment, 0);
});

test("an explicit ceiling halts the loop even while evidence is still yielding", () => {
  // The generous safety backstop: a hard cap the user set must win over yield.
  const controller = createResearchProgressController({
    tier: "deep",
    constraints: { maxModelSteps: 5 },
  });
  const decision = controller.evaluateBatch(
    { modelSteps: 5, toolCalls: 1, newEvidenceCount: 1 },
    OPEN_QUESTION,
  );
  assert.equal(decision.action, "stop");
  assert.equal(decision.reason, "model_step_cap_reached");
});

test("a synthesis-only turn does not advance the saturation counter", () => {
  const controller = createResearchProgressController({ tier: "deep" });
  controller.evaluateBatch({ toolCalls: 1, newEvidenceCount: 0 }, NO_UNRESOLVED);
  const synthesis = controller.evaluateBatch(
    { toolCalls: 0, newEvidenceCount: 0 },
    NO_UNRESOLVED,
  );
  assert.equal(synthesis.action, "continue");
  assert.equal(controller.snapshot().consecutiveLowYieldBatches, 1);
});

test("prior usage restores on resume so durable runs continue where they stopped", () => {
  const controller = createResearchProgressController({
    tier: "extended",
    usage: { modelSteps: 120, toolCalls: 60, segmentsStarted: 2, elapsedMs: 1_000 },
    consecutiveLowYieldBatches: 1,
  });
  const snapshot = controller.snapshot();
  assert.equal(snapshot.usage.modelSteps, 120);
  assert.equal(snapshot.usage.segmentsStarted, 2);
  assert.equal(snapshot.consecutiveLowYieldBatches, 1);
});
