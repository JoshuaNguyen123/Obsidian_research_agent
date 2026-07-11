import type { LoopBudgetPlan } from "./loopPlanner";
import type {
  ResearchPhaseDescriptor,
  ResearchRunPhase,
} from "./researchPhaseController";

export interface LoopLedger {
  successfulTools: string[];
  failedTools: string[];
  repeatedToolCalls: number;
  requiredToolsSatisfied: boolean;
  finalizationReserved: boolean;
  writeCompleted: boolean;
  wallClockExpired?: boolean;
  planComplete?: boolean;
  planNeedsVerification?: boolean;
  planHasBlocker?: boolean;
  shouldReplan?: boolean;
  /** Optional research phase gate signal from researchPhaseController. */
  researchPhase?: ResearchRunPhase;
  researchWriteToolsBlocked?: boolean;
}

export type LoopDecision =
  | { action: "continue_tools"; reason: string }
  | { action: "continue_planned_action"; reason: string }
  | { action: "verify_active_task"; reason: string }
  | { action: "reflect_and_replan"; reason: string }
  | { action: "force_final_no_tools"; reason: string }
  | { action: "stream_note_writeback"; reason: string }
  | { action: "stop_resumable_blocker"; reason: string }
  | { action: "stop_verified_complete"; reason: string }
  | { action: "stop_budget"; reason: string };

export function decideNextLoopAction(
  ledger: LoopLedger,
  budget: LoopBudgetPlan,
): LoopDecision {
  if (ledger.writeCompleted) {
    return { action: "stop_budget", reason: "write_completed" };
  }

  if (ledger.wallClockExpired) {
    return { action: "stop_budget", reason: "wall_clock_budget" };
  }

  if (ledger.planComplete) {
    return { action: "stop_verified_complete", reason: "mission_plan_complete" };
  }

  if (ledger.planHasBlocker) {
    return { action: "stop_resumable_blocker", reason: "mission_plan_blocked" };
  }

  if (ledger.shouldReplan) {
    return { action: "reflect_and_replan", reason: "mission_plan_stalled" };
  }

  if (ledger.planNeedsVerification) {
    return { action: "verify_active_task", reason: "mission_plan_needs_verification" };
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
    budget.toolStepBudget > 0 &&
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

  if (ledger.successfulTools.length > 0 || ledger.failedTools.length > 0) {
    return {
      action: "continue_planned_action",
      reason: "mission_plan_action_available",
    };
  }

  return { action: "continue_tools", reason: "tool_budget_available" };
}

/**
 * Soft gate: when research phase still blocks writes, divert streamed
 * writeback decisions back into tool gathering/analysis.
 */
export function applyResearchPhaseToLoopDecision(
  decision: LoopDecision,
  phase: ResearchPhaseDescriptor | null | undefined,
): LoopDecision {
  if (!phase?.researchBearing || phase.writeToolsAllowed) {
    return decision;
  }
  if (decision.action === "stream_note_writeback") {
    return {
      action: "continue_tools",
      reason: `research_phase_${phase.phase}_blocks_write`,
    };
  }
  return decision;
}
