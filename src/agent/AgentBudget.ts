export const MAX_AGENT_STEPS = 60;
export const DEFAULT_AGENT_STEPS = 30;
export const FINALIZATION_RESERVE_STEPS = 4;
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

  const defaultByRoute: Record<AgentRoute, number> = {
    simple_answer: 6,
    vault_write: 14,
    source_research: 26,
    long_research: 52,
    browser_learning: 44,
    design_package: 36,
  };

  const computed = explicit ?? defaultByRoute[request.route];
  const maxSteps = clamp(computed, FINALIZATION_RESERVE_STEPS + 1, MAX_AGENT_STEPS);

  return {
    route: request.route,
    maxSteps,
    finalizationReserve: FINALIZATION_RESERVE_STEPS,
    workingSteps: Math.max(1, maxSteps - FINALIZATION_RESERVE_STEPS),
    reason: explicit
      ? `Explicit step request normalized to ${maxSteps}.`
      : `Default budget for route ${request.route}.`,
  };
}

function normalizeExplicitSteps(value?: number): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.floor(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
