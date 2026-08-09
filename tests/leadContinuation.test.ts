import assert from "node:assert/strict";
import test from "node:test";
import {
  createLeadProgressFingerprintV1,
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
