/**
 * Model-facing per-segment tool/model remaining budget.
 * Distinct from formatStageBudgetPromptBlock, which is set-loose TIME remaining.
 */

import { formatFailureCopy } from "./failureCopy";

export const SEGMENT_BUDGET_PROFILE_DEFAULTS = {
  direct: { remainingToolCalls: 0, remainingModelCalls: 1 },
  compose: { remainingToolCalls: 4, remainingModelCalls: 6 },
  grounded_research: { remainingToolCalls: 12, remainingModelCalls: 16 },
  extended_team: { remainingToolCalls: 200, remainingModelCalls: 100 },
} as const;

const FINALIZE_NOW =
  "Finalize now: deliver your best final answer this turn; a continuation segment will preserve progress if you cannot finish.";

function nonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function formatSegmentBudgetPrompt(input: {
  remainingToolCalls: number;
  remainingModelCalls: number;
}): string {
  const remainingToolCalls = nonNegativeInt(input.remainingToolCalls);
  const remainingModelCalls = nonNegativeInt(input.remainingModelCalls);
  const line = `- Budget: ${remainingToolCalls} tool calls and ${remainingModelCalls} model turns remain in this segment.`;
  if (remainingToolCalls <= 2 || remainingModelCalls <= 1) {
    return `${line} ${FINALIZE_NOW}`;
  }
  return line;
}

export function formatSegmentBudgetExhaustedCopy(): string {
  return formatFailureCopy({
    what: "Per-segment tool-call budget exhausted.",
    why: "This segment used every allowed tool call.",
    next: "The segment is saved for continuation; resume the run to keep that progress.",
  });
}
