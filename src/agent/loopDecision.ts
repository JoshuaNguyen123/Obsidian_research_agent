import type { LoopBudgetPlan } from "./loopPlanner";
import type {
  ResearchPhaseDescriptor,
  ResearchRunPhase,
} from "./researchPhaseController";

export interface LoopLedger {
  successfulTools: string[];
  failedTools: string[];
  /**
   * Host-owned successes that never entered the segment's model-driven
   * tool slots (automatic `read_current_file`, restored parent-segment
   * proof). They must not consume the finalization budget, but they do
   * count as successes for the first-failure kill.
   */
  hostPrefetchedSuccesses?: string[];
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
  /**
   * Sealed-frontier citation gather is still offered because claim-grounding /
   * quote-span debt is unpaid. Required graph tools may already be paid; forcing
   * a tool-less final here is what killed live BYOK after verify_citation:
   * the menu stayed executable and the model wrote prose twice. The same flag
   * must keep the no-tool breaker from treating that prose as a legitimate
   * finish — after Linear/brief are paid, successfulToolCount > 0 would
   * otherwise skip steering and die on two empty replies.
   */
  citationGatherStillUnpaid?: boolean;
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

/**
 * Acceptance's resolved-failure filter: a tool that later succeeded is not
 * still failed. Host-prefetched successes belong in `successfulTools` here.
 */
export function unresolvedFailedTools(
  failedTools: readonly string[],
  successfulTools: readonly string[],
): string[] {
  return [...new Set(failedTools.filter((name) => !successfulTools.includes(name)))];
}

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

  if (ledger.requiredToolsSatisfied && !ledger.citationGatherStillUnpaid) {
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
    ledger.successfulTools.length > 0 &&
    !ledger.citationGatherStillUnpaid
  ) {
    return {
      action: "force_final_no_tools",
      reason: "tool_budget_spent_with_context",
    };
  }

  const successesForSurvival = [
    ...ledger.successfulTools,
    ...(ledger.hostPrefetchedSuccesses ?? []),
  ];
  const unresolvedFailures = unresolvedFailedTools(
    ledger.failedTools,
    successesForSurvival,
  );
  if (unresolvedFailures.length > 0 && successesForSurvival.length === 0) {
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

/**
 * Whether a prose-only model reply may terminate the run, or must still be
 * steered back to tools. Citation-gather companions are required work even
 * after the planned graph tools have succeeded: claim_grounding is scored
 * against the draft, not against web_search having run once.
 */
export function proseAnswerCannotFinishMissionV1(input: {
  route: string;
  successfulToolCount: number;
  codeExactFrontier: boolean;
  pendingRequiredWriteCount: number;
  missingRequiredWebToolCount: number;
  requiredVaultTraversalStillMissing: boolean;
  citationGatherStillUnpaid?: boolean;
}): boolean {
  return (
    ((input.route === "tool_required" || input.route === "grounded_workflow") &&
      input.successfulToolCount === 0) ||
    input.codeExactFrontier ||
    input.pendingRequiredWriteCount > 0 ||
    input.missingRequiredWebToolCount > 0 ||
    input.requiredVaultTraversalStillMissing ||
    Boolean(input.citationGatherStillUnpaid)
  );
}

/**
 * After first-strike + bounded prose steering are spent, do not fire
 * `model_tool_noncompliance` while citation gather is still executable.
 * Live BYOK 2026-09-04 died there with Linear already published and
 * `autoContinueRecommended: false`.
 */
export function shouldKeepLoopOpenForCitationGatherStallV1(input: {
  citationGatherStillUnpaid: boolean;
  executableFrontier: boolean;
  stepBelowLimit: boolean;
}): boolean {
  return (
    input.citationGatherStillUnpaid &&
    input.executableFrontier &&
    input.stepBelowLimit
  );
}
