import assert from "node:assert/strict";
import test from "node:test";
import {
  SEGMENT_BUDGET_PROFILE_DEFAULTS,
  attachSegmentBudgetToMessages,
  formatSegmentBudgetExhaustedCopy,
  formatSegmentBudgetPrompt,
} from "../src/agent/segmentBudgetPrompt";

test("segment budget prompt covers each profile remaining count", () => {
  assert.equal(
    formatSegmentBudgetPrompt(SEGMENT_BUDGET_PROFILE_DEFAULTS.direct),
    "- Budget: 0 tool calls and 1 model turns remain in this segment. Finalize now: deliver your best final answer this turn; a continuation segment will preserve progress if you cannot finish.",
  );
  assert.equal(
    formatSegmentBudgetPrompt(SEGMENT_BUDGET_PROFILE_DEFAULTS.compose),
    "- Budget: 4 tool calls and 6 model turns remain in this segment.",
  );
  assert.equal(
    formatSegmentBudgetPrompt(SEGMENT_BUDGET_PROFILE_DEFAULTS.grounded_research),
    "- Budget: 12 tool calls and 16 model turns remain in this segment.",
  );
  assert.equal(
    formatSegmentBudgetPrompt(SEGMENT_BUDGET_PROFILE_DEFAULTS.extended_team),
    "- Budget: 200 tool calls and 100 model turns remain in this segment.",
  );
});

test("segment budget prompt warns at remaining tool or model thresholds", () => {
  const toolWarn = formatSegmentBudgetPrompt({
    remainingToolCalls: 2,
    remainingModelCalls: 6,
  });
  assert.match(toolWarn, /^- Budget: 2 tool calls and 6 model turns remain in this segment\./);
  assert.match(toolWarn, /Finalize now:/);

  const modelWarn = formatSegmentBudgetPrompt({
    remainingToolCalls: 4,
    remainingModelCalls: 1,
  });
  assert.match(modelWarn, /^- Budget: 4 tool calls and 1 model turns remain in this segment\./);
  assert.match(modelWarn, /Finalize now:/);

  const bothWarn = formatSegmentBudgetPrompt({
    remainingToolCalls: 0,
    remainingModelCalls: 0,
  });
  assert.match(bothWarn, /Finalize now:/);

  const justAbove = formatSegmentBudgetPrompt({
    remainingToolCalls: 3,
    remainingModelCalls: 2,
  });
  assert.equal(
    justAbove,
    "- Budget: 3 tool calls and 2 model turns remain in this segment.",
  );
  assert.doesNotMatch(justAbove, /Finalize now:/);
});

test("segment budget exhaustion copy tells the model the segment is saved", () => {
  const copy = formatSegmentBudgetExhaustedCopy();
  assert.match(copy, /^What: Per-segment tool-call budget exhausted\./);
  assert.match(copy, /Why: This segment used every allowed tool call\./);
  assert.match(copy, /Next: The segment is saved for continuation/);
});

test("budget line folds into the existing system prompt instead of replacing the last message", () => {
  const attached = attachSegmentBudgetToMessages(
    [
      { role: "system", content: "You are the researcher." },
      {
        role: "user",
        content: "Request one of these allowed write tools now: append_to_current_file",
      },
    ],
    "- Budget: 4 tool calls and 6 model turns remain in this segment.",
  );
  assert.equal(attached.length, 2);
  assert.match(
    attached[0]?.content ?? "",
    /You are the researcher\.\n- Budget: 4 tool calls and 6 model turns remain in this segment\./,
  );
  assert.equal(
    attached.at(-1)?.content,
    "Request one of these allowed write tools now: append_to_current_file",
    "last-message allowlist/correction contracts must stay last",
  );
});
