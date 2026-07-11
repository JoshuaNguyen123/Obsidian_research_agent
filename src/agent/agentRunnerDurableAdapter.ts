import type {
  AgentRunCompleteEvent,
  AgentTraceEvent,
} from "../AgentRunner";
import type { DurableMissionRuntimeSegmentOutcome } from "./durableMissionRuntime";

export interface AgentRunnerSegmentObservation {
  segmentId?: string;
  complete?: AgentRunCompleteEvent;
  toolCalls: number;
  lastError?: AgentTraceEvent["error"];
  checkpointAt?: string;
  pendingApproval?: { id: string; summary: string };
  unsafeWalIds?: string[];
  unsafeWalMessage?: string;
}

export function buildDurableOutcomeFromAgentRunner(
  observation: AgentRunnerSegmentObservation,
): DurableMissionRuntimeSegmentOutcome {
  const base = {
    segmentId: observation.segmentId,
    segmentCompleted: Boolean(observation.complete),
    modelSteps: observation.complete?.step ?? 0,
    toolCalls: Math.max(0, Math.floor(observation.toolCalls)),
    checkpointAt: observation.checkpointAt,
  };
  const complete = observation.complete;
  const unsafeWalIds = [
    ...new Set(
      (observation.unsafeWalIds ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (unsafeWalIds.length > 0 || observation.unsafeWalMessage?.trim()) {
    return {
      ...base,
      productive: false,
      unsafeWal: {
        operationIds: unsafeWalIds,
        message:
          observation.unsafeWalMessage ??
          "Mutation reconciliation is required before execution can resume.",
      },
    };
  }
  if (observation.pendingApproval) {
    return {
      ...base,
      productive: false,
      approval: { ...observation.pendingApproval },
    };
  }
  if (!complete) {
    return {
      ...base,
      productive: false,
      safetyPause: {
        code: "missing_segment_completion",
        message: "The bounded runner ended without a completion event.",
      },
    };
  }

  if (complete.stopReason === "final" || complete.stopReason === "write_completed") {
    return { ...base, accepted: true, productive: true };
  }
  if (complete.stopReason === "budget") {
    return {
      ...base,
      productive: complete.autoContinueRecommended === true,
      continuation: {
        recommended: complete.autoContinueRecommended === true,
        stopReason: "budget",
        reason: complete.autoContinueReason,
      },
    };
  }
  if (complete.stopReason === "clarifying_question") {
    return {
      ...base,
      productive: false,
      safetyPause: {
        code: "clarification_required",
        message: "The overnight mission paused for user clarification.",
      },
    };
  }
  if (complete.stopReason === "user_stopped") {
    return {
      ...base,
      productive: false,
      safetyPause: {
        code: "segment_stopped",
        message: "The bounded segment stopped before durable completion.",
      },
    };
  }

  const error = observation.lastError;
  if (isTransientAgentRunError(error)) {
    return {
      ...base,
      productive: false,
      transientFailure: {
        code: error?.code ?? "transient_provider_error",
        message: error?.message ?? "Transient provider failure.",
      },
    };
  }
  return {
    ...base,
    productive: false,
    safetyPause: {
      code: error?.code ?? "segment_execution_error",
      message: error?.message ?? "The bounded segment failed.",
    },
  };
}

export function isTransientAgentRunError(
  error: AgentTraceEvent["error"] | undefined,
): boolean {
  if (!error) {
    return false;
  }
  const text = `${error.code} ${error.message}`.toLowerCase();
  if (
    /\b(?:auth|credential|api[_ -]?key|permission|approval|unsafe|reconcile|invalid[_ -]?(?:path|request|response)|not[_ -]?found)\b/.test(
      text,
    )
  ) {
    return false;
  }
  return /\b(?:network|timeout|timed out|rate[_ -]?limit|429|5\d\d|connection|temporar|unavailable|econn|socket|provider)\b/.test(
    text,
  );
}
