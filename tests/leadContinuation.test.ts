import assert from "node:assert/strict";
import test from "node:test";
import {
  createLeadProgressFingerprintV1,
  isDemotingZeroStepLeadCompletion,
  shouldContinueResearchLead,
} from "../src/orchestrator/leadContinuation";

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

test("a later Lead segment must demonstrate measurable progress", () => {
  assert.equal(
    shouldContinueResearchLead({
      ...base,
      segmentIndex: 1,
      previousProgressFingerprint: "draft:1|receipts:0|missing:write",
      currentProgressFingerprint: "draft:1|receipts:0|missing:write",
      previousAcceptanceMissing: ["write_receipt", "readback"],
      currentAcceptanceMissing: ["write_receipt", "readback"],
    }),
    false,
  );
  assert.equal(
    shouldContinueResearchLead({
      ...base,
      segmentIndex: 1,
      previousProgressFingerprint: "draft:1|receipts:0|missing:write",
      currentProgressFingerprint: "draft:2|receipts:1|missing:readback",
      previousAcceptanceMissing: ["write_receipt", "readback"],
      currentAcceptanceMissing: ["readback"],
    }),
    true,
  );
});

test("Lead cannot continue when no available repair action can close the gap", () => {
  assert.equal(
    shouldContinueResearchLead({ ...base, availableRepairAction: false }),
    false,
  );
});

test("progress fingerprints change with material draft or receipt progress", () => {
  const first = createLeadProgressFingerprintV1({
    finalOutput: "Draft one",
    receiptIds: [],
  });
  const same = createLeadProgressFingerprintV1({
    finalOutput: "Draft   one",
    receiptIds: [],
  });
  const advanced = createLeadProgressFingerprintV1({
    finalOutput: "Draft one",
    receiptIds: ["append:Guide.md"],
  });
  assert.equal(first, same);
  assert.notEqual(first, advanced);
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

test("a zero-step budget segment never demotes an applied Lead completion", () => {
  const applied = { step: 4, stopReason: "write_completed" };
  assert.equal(
    isDemotingZeroStepLeadCompletion(applied, {
      step: 0,
      stopReason: "budget",
    }),
    true,
  );
  assert.equal(
    isDemotingZeroStepLeadCompletion(applied, {
      step: 0,
      stopReason: "user_stopped",
    }),
    true,
  );
  assert.equal(
    isDemotingZeroStepLeadCompletion(
      { step: 6, stopReason: "final" },
      { step: 0, stopReason: "budget" },
    ),
    true,
  );
});

test("real terminal events are never treated as demoting artifacts", () => {
  // No prior applied completion: the budget terminal is the true outcome.
  assert.equal(
    isDemotingZeroStepLeadCompletion(null, { step: 0, stopReason: "budget" }),
    false,
  );
  // A prior non-success completion is not an applied result worth preserving.
  assert.equal(
    isDemotingZeroStepLeadCompletion(
      { step: 3, stopReason: "budget" },
      { step: 0, stopReason: "budget" },
    ),
    false,
  );
  // A segment that performed work owns its terminal state.
  assert.equal(
    isDemotingZeroStepLeadCompletion(
      { step: 4, stopReason: "write_completed" },
      { step: 2, stopReason: "budget" },
    ),
    false,
  );
  // A later genuine success supersedes the earlier one.
  assert.equal(
    isDemotingZeroStepLeadCompletion(
      { step: 4, stopReason: "write_completed" },
      { step: 0, stopReason: "write_completed" },
    ),
    false,
  );
});

test("a saturated research segment never spends another Lead continuation", () => {
  assert.equal(
    shouldContinueResearchLead({ ...base, evidenceSaturated: true }),
    false,
  );
  // The field is optional: absent means the cap-only semantics are unchanged.
  assert.equal(
    shouldContinueResearchLead({ ...base, evidenceSaturated: false }),
    true,
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
