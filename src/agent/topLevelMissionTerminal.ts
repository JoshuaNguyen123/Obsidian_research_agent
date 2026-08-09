import type { OrchestratorRunStatus } from "../orchestrator/types";

export type TopLevelMissionTerminalKindV1 =
  | "complete"
  | "blocked"
  | "cancelled"
  | "failed";

export interface TopLevelMissionTerminalDecisionV1 {
  version: 1;
  kind: TopLevelMissionTerminalKindV1;
  code: string;
  message: string;
  requiredAction: string | null;
}

/**
 * Central child-to-parent terminal mapping. It is intentionally pure so live
 * completion and startup reconciliation can share the same taxonomy.
 */
export function resolveTopLevelMissionTerminalV1(input: {
  childStatus?: OrchestratorRunStatus | null;
  userStopped?: boolean;
  failureMessage?: string | null;
}): TopLevelMissionTerminalDecisionV1 {
  if (input.userStopped || input.childStatus === "cancelled") {
    return {
      version: 1,
      kind: "cancelled",
      code: "direct_executor_cancelled",
      message: input.failureMessage?.trim() || "User stopped the orchestrated run.",
      requiredAction: null,
    };
  }
  if (input.failureMessage?.trim() || input.childStatus === "failed") {
    return {
      version: 1,
      kind: "failed",
      code: "direct_executor_failed",
      message:
        input.failureMessage?.trim() || "The direct executor failed before completion.",
      requiredAction:
        "Inspect executor diagnostics and retry only after correcting the failure.",
    };
  }
  if (input.childStatus === "complete") {
    return {
      version: 1,
      kind: "complete",
      code: "direct_executor_complete",
      message: "The direct executor completed with verified output.",
      requiredAction: null,
    };
  }
  if (input.childStatus === "blocked") {
    return {
      version: 1,
      kind: "blocked",
      code: "direct_executor_blocked",
      message: "The direct executor is blocked by an unmet proof requirement.",
      requiredAction:
        "Open Run Details, resolve the named requirement, and continue the persisted run.",
    };
  }
  return {
    version: 1,
    kind: "blocked",
    code: "direct_executor_incomplete",
    message: input.childStatus
      ? `Direct executor stopped with ${input.childStatus}.`
      : "Direct executor did not return a readback snapshot.",
    requiredAction:
      "Inspect executor evidence and resume from the persisted mission graph.",
  };
}
