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
  /** A distinct second-agent slot is configured and reachable this run. */
  secondAgentAvailable?: boolean;
  /**
   * Already escalated once this run. Without this the two agents can hand a
   * stuck run back and forth and spend the whole budget looking busy, which is
   * worse than stopping.
   */
  secondAgentConsulted?: boolean;
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
  | { action: "stop_budget"; reason: string }
  | { action: "escalate_to_second_agent"; reason: string };

export function decideNextLoopAction(
  ledger: LoopLedger,
  budget: LoopBudgetPlan,
): LoopDecision {
  if (ledger.writeCompleted) {
    // Distinct from step/model budget so Chat and finishRun can label
    // successful writeback as write_completed instead of a safety-limit stop.
    return { action: "stop_verified_complete", reason: "write_completed" };
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

  if (ledger.requiredToolsSatisfied) {
    // Every required proof already exists, so repetition is wandering, not
    // missing progress: steer to the final answer instead of dying on the
    // repeat counter with a complete graph and an unwritten synthesis.
    return {
      action: "force_final_no_tools",
      reason: "required_tools_satisfied",
    };
  }

  if (ledger.repeatedToolCalls > 1) {
    // Repeating a tool without progress is the clearest "stuck" signal we have.
    // Giving up was the only option before a second agent existed; when one is
    // configured, ask it once before spending the stop.
    if (ledger.secondAgentAvailable && !ledger.secondAgentConsulted) {
      return {
        action: "escalate_to_second_agent",
        reason: "repeated_tool_call_without_progress",
      };
    }
    return {
      action: "stop_budget",
      reason: "repeated_tool_call_without_progress",
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
 * writeback away from the blocked mutation.
 *
 * The destination depends on the phase, and must match what
 * `phaseGateFailureCopy` tells the model to do — otherwise the run is steered
 * into the one action the gate will reject again:
 *
 * - gather  → "finish required search/fetch/read proof first". More tools is
 *             genuinely the way forward, so continue_tools is correct.
 * - analyze → "return the complete cited synthesis as the final answer without
 *             a tool call; the host will verify it before one write". Sending
 *             this phase back to continue_tools instead produced an
 *             unrecoverable loop: the model retried the write, the gate blocked
 *             it, the resume re-entered analyze under a fresh run id, forever.
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
      action:
        phase.phase === "analyze" ? "force_final_no_tools" : "continue_tools",
      reason: `research_phase_${phase.phase}_blocks_write`,
    };
  }
  return decision;
}
