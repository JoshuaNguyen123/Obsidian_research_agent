import { MAX_AGENT_STEPS } from "../tools/constants";

export type RunBudgetRoute =
  | "instant_local"
  | "direct_writeback"
  | "prefetched_vault_answer"
  | "prefetched_vault_writeback"
  | "single_model_answer"
  | "single_model_writeback"
  | "tool_required"
  | "grounded_workflow";

export type RunBudgetSlowPathReason =
  | "none"
  | "needs_current_note"
  | "needs_web_sources"
  | "needs_vault_context"
  | "needs_graph_context"
  | "needs_word_count"
  | "needs_edit_or_replace"
  | "needs_model_planning";

export interface EstimateLoopBudgetInput {
  route: RunBudgetRoute;
  configuredMaxSteps?: number | null;
  expectedTimeClass?: "quick" | "normal" | "long";
  slowPathReason?: RunBudgetSlowPathReason;
  requestedSteps?: number;
  artifactLike?: boolean;
}

export function estimateLoopBudget({
  route,
  configuredMaxSteps,
  expectedTimeClass = "normal",
  slowPathReason = "none",
  requestedSteps,
  artifactLike = false,
}: EstimateLoopBudgetInput): number {
  const cap = resolveConfiguredMaxAgentSteps(configuredMaxSteps);
  const estimated = estimateUncappedLoopBudget({
    route,
    expectedTimeClass,
    slowPathReason,
    requestedSteps,
    artifactLike,
  });

  return estimated <= 0 ? 0 : Math.min(estimated, cap);
}

export function resolveConfiguredMaxAgentSteps(
  rawMaxSteps?: number | null,
): number {
  if (
    typeof rawMaxSteps !== "number" ||
    !Number.isFinite(rawMaxSteps) ||
    rawMaxSteps <= 0
  ) {
    return MAX_AGENT_STEPS;
  }

  return Math.min(MAX_AGENT_STEPS, Math.max(1, Math.trunc(rawMaxSteps)));
}

function estimateUncappedLoopBudget({
  route,
  expectedTimeClass,
  slowPathReason,
  requestedSteps,
  artifactLike,
}: {
  route: RunBudgetRoute;
  expectedTimeClass: "quick" | "normal" | "long";
  slowPathReason: RunBudgetSlowPathReason;
  requestedSteps?: number;
  artifactLike: boolean;
}): number {
  if (requestedSteps !== undefined) {
    return Math.max(0, Math.trunc(requestedSteps));
  }

  if (route === "instant_local") {
    return 0;
  }

  if (
    route === "direct_writeback" ||
    route === "prefetched_vault_answer" ||
    route === "prefetched_vault_writeback"
  ) {
    return 1;
  }

  if (route === "grounded_workflow" || artifactLike) {
    return MAX_AGENT_STEPS;
  }

  if (slowPathReason === "needs_edit_or_replace") {
    return 3;
  }

  if (slowPathReason === "needs_word_count") {
    return 2;
  }

  if (expectedTimeClass === "long") {
    return MAX_AGENT_STEPS;
  }

  if (expectedTimeClass === "normal") {
    return 3;
  }

  return 2;
}
