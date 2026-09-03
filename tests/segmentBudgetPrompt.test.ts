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

test("budget line is a per-step card before the tail, never inside the system prompt", () => {
  const systemPrompt = "You are the researcher.";
  const tail =
    "Request one of these allowed write tools now: append_to_current_file";
  const attached = attachSegmentBudgetToMessages(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Write the note." },
      { role: "assistant", content: "Reading first." },
      { role: "user", content: tail },
    ],
    "- Budget: 4 tool calls and 6 model turns remain in this segment.",
  );
  assert.equal(attached.length, 5);
  // The stable prefix providers cache byte-for-byte is untouched.
  assert.equal(attached[0]?.content, systemPrompt);
  assert.equal(attached[1]?.content, "Write the note.");
  assert.equal(attached[2]?.content, "Reading first.");
  // The budget rides as its own system card immediately before the tail.
  assert.deepEqual(attached[3], {
    role: "system",
    content: "- Budget: 4 tool calls and 6 model turns remain in this segment.",
  });
  assert.equal(
    attached.at(-1)?.content,
    tail,
    "last-message allowlist/correction contracts must stay last",
  );
  assert.equal(
    attached.filter((message) => /^- Budget:/.test(message.content ?? "")).length,
    1,
  );
});

test("two consecutive steps keep every history message byte-identical", () => {
  const history = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "mission" },
  ];
  const step1 = attachSegmentBudgetToMessages(
    history,
    "- Budget: 4 tool calls and 6 model turns remain in this segment.",
  );
  const step2 = attachSegmentBudgetToMessages(
    [
      ...history,
      { role: "assistant", content: "calling read_current_file" },
      { role: "tool", content: "{\"ok\":true}" },
    ],
    "- Budget: 3 tool calls and 5 model turns remain in this segment.",
  );
  // Everything the provider saw at step 1 before its card is still there,
  // unchanged, at step 2 -- the only differences are the appended turns and
  // the new card. A decrementing counter inside messages[0] would break this.
  const isCard = (message: { content?: string }) =>
    /^- Budget:/.test(message.content ?? "");
  const step1History = step1.filter((message) => !isCard(message));
  const step2History = step2.filter((message) => !isCard(message));
  assert.deepEqual(step1History, history);
  assert.deepEqual(step2History.slice(0, history.length), history);
  assert.equal(step1.findIndex(isCard), step1.length - 2);
  assert.equal(step2.findIndex(isCard), step2.length - 2);
  assert.equal(step2[0]?.content, "SYSTEM PROMPT");
});

test("a budget card never becomes the only or the first message", () => {
  const single = attachSegmentBudgetToMessages(
    [{ role: "system", content: "SYSTEM PROMPT" }],
    "- Budget: 1 tool calls and 1 model turns remain in this segment.",
  );
  assert.equal(single[0]?.content, "SYSTEM PROMPT");
  assert.equal(single.length, 2);
  const empty = attachSegmentBudgetToMessages([], "- Budget: 0 tool calls and 0 model turns remain in this segment.");
  assert.equal(empty.length, 1);
  const untouched = attachSegmentBudgetToMessages(
    [{ role: "system", content: "SYSTEM PROMPT" }, { role: "user", content: "hi" }],
    "   ",
  );
  assert.equal(untouched.length, 2);
});
