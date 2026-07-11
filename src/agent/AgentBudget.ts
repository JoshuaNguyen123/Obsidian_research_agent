import {
  estimateLoopBudget,
  type RunBudgetRoute,
  type RunBudgetSlowPathReason,
} from "./runBudget";
import { FINALIZATION_RESERVE_STEPS, MAX_AGENT_STEPS } from "../tools/constants";

export { FINALIZATION_RESERVE_STEPS, MAX_AGENT_STEPS } from "../tools/constants";
export const DEFAULT_AGENT_STEPS = MAX_AGENT_STEPS;
export const REFLECTION_INTERVAL_STEPS = 5;

export type AgentRoute =
  | "simple_answer"
  | "vault_write"
  | "source_research"
  | "long_research"
  | "browser_learning"
  | "design_package";

export interface BudgetRequest {
  route: AgentRoute;
  explicitStepRequest?: number;
  requiresBrowser?: boolean;
  requiresDesignPackage?: boolean;
  sourceCountHint?: number;
}

export interface AgentBudget {
  route: AgentRoute;
  maxSteps: number;
  finalizationReserve: number;
  workingSteps: number;
  reason: string;
}

export function createAgentBudget(request: BudgetRequest): AgentBudget {
  const explicit = normalizeExplicitSteps(request.explicitStepRequest);
  const runtimeBudget = toRuntimeBudgetRequest(request);
  const maxSteps = estimateLoopBudget({
    ...runtimeBudget,
    requestedSteps: explicit,
    configuredMaxSteps: MAX_AGENT_STEPS,
  });

  return {
    route: request.route,
    maxSteps,
    finalizationReserve: FINALIZATION_RESERVE_STEPS,
    workingSteps: Math.max(0, maxSteps - FINALIZATION_RESERVE_STEPS),
    reason: explicit
      ? `Explicit step request normalized to ${maxSteps}.`
      : `Runtime budget estimate for route ${request.route}.`,
  };
}

function toRuntimeBudgetRequest(request: BudgetRequest): {
  route: RunBudgetRoute;
  expectedTimeClass: "quick" | "normal" | "long";
  slowPathReason: RunBudgetSlowPathReason;
  artifactLike: boolean;
} {
  switch (request.route) {
    case "simple_answer":
      return {
        route: "single_model_answer",
        expectedTimeClass: "quick",
        slowPathReason: "none",
        artifactLike: false,
      };
    case "vault_write":
      return {
        route: "tool_required",
        expectedTimeClass: "normal",
        slowPathReason: "needs_current_note",
        artifactLike: false,
      };
    case "source_research":
      return {
        route: "grounded_workflow",
        expectedTimeClass: "long",
        slowPathReason: "needs_web_sources",
        artifactLike: false,
      };
    case "long_research":
      return {
        route: "grounded_workflow",
        expectedTimeClass: "long",
        slowPathReason: "needs_model_planning",
        artifactLike: false,
      };
    case "browser_learning":
      return {
        route: "grounded_workflow",
        expectedTimeClass: "long",
        slowPathReason: "needs_model_planning",
        artifactLike: true,
      };
    case "design_package":
      return {
        route: "grounded_workflow",
        expectedTimeClass: "normal",
        slowPathReason: "needs_model_planning",
        artifactLike: true,
      };
  }
}

function normalizeExplicitSteps(value?: number): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.floor(value);
}
