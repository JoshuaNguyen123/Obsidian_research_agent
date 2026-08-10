import type { LoopDecision } from "./loopDecision";

/**
 * User-facing stop taxonomy. Maps overlapping runner exits
 * (budget / blocker / write complete) into one clear label for Chat.
 */
export type MissionStopReason =
  | "write_completed"
  | "verified_complete"
  | "clarifying_question"
  | "user_aborted"
  | "wall_clock"
  | "step_budget"
  | "model_budget"
  | "graph_blocked"
  | "approval_denied"
  | "relevance_rejected"
  | "provider_error"
  | "repeated_tool_no_progress"
  | "required_tools_failed"
  | "unknown";

/** Mirrors AgentRunStopReason without importing the runner monolith. */
export type AgentRunStopReasonLike =
  | "final"
  | "write_completed"
  | "clarifying_question"
  | "user_stopped"
  | "budget"
  | "error"
  | string;

export function fromAgentRunStopReason(
  stopReason: AgentRunStopReasonLike,
  detail?: string | null,
): MissionStopReason {
  switch (stopReason) {
    case "write_completed":
      return "write_completed";
    case "final":
      return "verified_complete";
    case "clarifying_question":
      return "clarifying_question";
    case "user_stopped":
      return "user_aborted";
    case "error":
      return classifyErrorDetail(detail);
    case "budget":
      return classifyBudgetDetail(detail);
    default:
      return "unknown";
  }
}

export function loopDecisionToStopReason(
  decision: LoopDecision,
): MissionStopReason | null {
  switch (decision.action) {
    case "stop_verified_complete":
      return decision.reason === "write_completed"
        ? "write_completed"
        : "verified_complete";
    case "stop_resumable_blocker":
      return "graph_blocked";
    case "stop_budget":
      return classifyBudgetDetail(decision.reason);
    default:
      return null;
  }
}

export function stopReasonChatLine(
  reason: MissionStopReason,
  detail?: string | null,
): string {
  const suffix = detail?.trim() ? ` ${detail.trim()}` : "";
  switch (reason) {
    case "write_completed":
      return `Write complete.${suffix}`;
    case "verified_complete":
      return `Done.${suffix}`;
    case "clarifying_question":
      return `Needs clarification.${suffix}`;
    case "user_aborted":
      return `Stopped by you. Any completed draft and receipts were preserved in Run Details.${suffix}`;
    case "wall_clock":
      return `Paused: wall-clock budget expired. Ask me to continue.${suffix}`;
    case "step_budget":
    case "model_budget":
      return `Paused at a safety limit. Ask me to continue.${suffix}`;
    case "graph_blocked":
      // Lead with the blocker when the caller has one. "Blocked — open Run
      // Details" made the user open a panel to learn anything, and that
      // useless line was what got saved into conversation history.
      return suffix
        ? `Blocked:${suffix} Send the next message to continue, or open Run Details.`
        : "Blocked — open Run Details for the blocker, or send the next message to continue.";
    case "approval_denied":
      return `Approval denied.${suffix}`;
    case "relevance_rejected":
      return `Stopped: output failed the relevance check.${suffix}`;
    case "provider_error":
      return `Could not finish that turn. Open Run Details for the error, then send the next message.${suffix}`;
    case "repeated_tool_no_progress":
      return `Paused: repeated tool calls without progress. Ask me to continue with a different approach.${suffix}`;
    case "required_tools_failed":
      return suffix
        ? `Blocked: a required tool failed.${suffix}`
        : "Blocked: a required tool failed. Open Run Details for details.";
    case "unknown":
    default:
      return `Run finished.${suffix}`;
  }
}

export function formatStopReasonLabel(reason: MissionStopReason): string {
  switch (reason) {
    case "write_completed":
      return "Write complete";
    case "verified_complete":
      return "Done";
    case "clarifying_question":
      return "Needs clarification";
    case "user_aborted":
      return "Stopped by user";
    case "wall_clock":
      return "Wall-clock budget";
    case "step_budget":
      return "Step budget";
    case "model_budget":
      return "Model budget";
    case "graph_blocked":
      return "Blocked";
    case "approval_denied":
      return "Approval denied";
    case "relevance_rejected":
      return "Relevance rejected";
    case "provider_error":
      return "Error";
    case "repeated_tool_no_progress":
      return "No progress";
    case "required_tools_failed":
      return "Required tool failed";
    case "unknown":
    default:
      return "Finished";
  }
}

function classifyErrorDetail(detail?: string | null): MissionStopReason {
  const text = (detail ?? "").toLowerCase();
  if (
    /authoritative mission graph|not ready in the (?:exact )?authoritative|off-frontier|mission_graph_authority|mission graph/i.test(
      text,
    )
  ) {
    return "graph_blocked";
  }
  return "provider_error";
}

function classifyBudgetDetail(detail?: string | null): MissionStopReason {
  const text = (detail ?? "").toLowerCase();
  if (/wall.?clock/.test(text)) return "wall_clock";
  if (/repeated_tool|no_progress/.test(text)) return "repeated_tool_no_progress";
  if (/required_tools_failed/.test(text)) return "required_tools_failed";
  // A provider-budget stop often rides along with acceptance keys and
  // "mission_graph_incomplete" in the same detail string; classify it before
  // the graph branch so Chat says "paused at a safety limit" instead of
  // presenting a resumable budget pause as an external blocker.
  if (/provider[\s_]?(?:execution[\s_]?)?budget[\s_]?exhausted/.test(text)) {
    return "model_budget";
  }
  if (/model|token/.test(text)) return "model_budget";
  if (/approval/.test(text)) return "approval_denied";
  // Unpaid compound delivery / graph blockers outrank verifier:final_relevance so
  // Chat does not say "relevance check" when Continue should keep running tools.
  if (
    /set_loose_delivery|missing_delivery_proofs|mission_graph_incomplete|graph_incomplete|passing fast|validation completed red|recovery attempts exhausted/i.test(
      text,
    )
  ) {
    return /mission_graph|graph_incomplete|passing fast|validation completed red|recovery attempts/i.test(
      text,
    )
      ? "graph_blocked"
      : "step_budget";
  }
  if (/relevance/.test(text)) return "relevance_rejected";
  if (/block|mission_graph_incomplete|graph_incomplete/.test(text)) {
    return "graph_blocked";
  }
  return "step_budget";
}
