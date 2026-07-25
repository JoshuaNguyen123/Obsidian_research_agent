import assert from "node:assert/strict";
import test from "node:test";
import { shouldContinueResearchLead } from "../src/orchestrator/leadContinuation";

const base = {
  stopReason: "budget",
  autoContinueRecommended: false,
  autoContinueReason: "acceptance_failed",
  usedModelSteps: 6,
  maxModelSteps: 24,
  usedToolCalls: 3,
  maxToolCalls: 32,
  segmentIndex: 0,
  maxSegments: 4,
  aborted: false,
};

test("orchestrated Lead may spend its existing reserve on acceptance proof repair", () => {
  assert.equal(shouldContinueResearchLead(base), true);
});

test("orchestrated Lead does not continue hard non-budget terminals", () => {
  assert.equal(
    shouldContinueResearchLead({
      ...base,
      stopReason: "error",
      autoContinueReason: "required_tool_failure",
    }),
    false,
  );
});

test("orchestrated Lead never exceeds model, tool, segment, or abort bounds", () => {
  assert.equal(
    shouldContinueResearchLead({ ...base, usedModelSteps: 24 }),
    false,
  );
  assert.equal(
    shouldContinueResearchLead({ ...base, usedToolCalls: 32 }),
    false,
  );
  assert.equal(
    shouldContinueResearchLead({ ...base, segmentIndex: 3 }),
    false,
  );
  assert.equal(
    shouldContinueResearchLead({ ...base, aborted: true }),
    false,
  );
});
