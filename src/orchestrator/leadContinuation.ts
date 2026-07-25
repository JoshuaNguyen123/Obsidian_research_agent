export interface LeadContinuationDecisionInput {
  stopReason: string;
  autoContinueRecommended?: boolean;
  autoContinueReason?: string;
  usedModelSteps: number;
  maxModelSteps: number;
  usedToolCalls: number;
  maxToolCalls: number;
  segmentIndex: number;
  maxSegments: number;
  aborted: boolean;
}

/**
 * An orchestrated Lead owns a bounded proof-repair reserve after handoff.
 * Generic missions intentionally do not auto-continue acceptance failures, but
 * the Lead may spend its existing reserve to correct citations or final proof.
 * This decision never increases model, tool, segment, or wall-clock authority.
 */
export function shouldContinueResearchLead(
  input: LeadContinuationDecisionInput,
): boolean {
  if (
    input.stopReason !== "budget" ||
    input.usedModelSteps >= input.maxModelSteps ||
    input.usedToolCalls >= input.maxToolCalls ||
    input.segmentIndex + 1 >= input.maxSegments ||
    input.aborted
  ) {
    return false;
  }
  return (
    input.autoContinueRecommended === true ||
    input.autoContinueReason === "acceptance_failed"
  );
}
