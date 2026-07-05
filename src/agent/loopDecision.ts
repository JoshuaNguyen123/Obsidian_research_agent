import type { LoopBudgetPlan } from "./loopPlanner";

export interface LoopLedger {
  successfulTools: string[];
  failedTools: string[];
  repeatedToolCalls: number;
  requiredToolsSatisfied: boolean;
  finalizationReserved: boolean;
  writeCompleted: boolean;
}

export type LoopDecision =
  | { action: "continue_tools"; reason: string }
  | { action: "force_final_no_tools"; reason: string }
  | { action: "stream_note_writeback"; reason: string }
  | { action: "stop_budget"; reason: string };

export function decideNextLoopAction(
  ledger: LoopLedger,
  budget: LoopBudgetPlan,
): LoopDecision {
  if (ledger.writeCompleted) {
    return { action: "stop_budget", reason: "write_completed" };
  }

  if (ledger.repeatedToolCalls > 1) {
    return {
      action: "stop_budget",
      reason: "repeated_tool_call_without_progress",
    };
  }

  if (ledger.requiredToolsSatisfied) {
    return {
      action: "force_final_no_tools",
      reason: "required_tools_satisfied",
    };
  }

  if (
    ledger.finalizationReserved &&
    ledger.successfulTools.length >= budget.toolStepBudget &&
    ledger.successfulTools.length > 0
  ) {
    return {
      action: "force_final_no_tools",
      reason: "tool_budget_spent_with_context",
    };
  }

  if (ledger.failedTools.length > 0 && ledger.successfulTools.length === 0) {
    return { action: "stop_budget", reason: "required_tools_failed" };
  }

  return { action: "continue_tools", reason: "tool_budget_available" };
}
