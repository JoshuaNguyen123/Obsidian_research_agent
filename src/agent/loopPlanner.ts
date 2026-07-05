import { MAX_AGENT_STEPS } from "../tools/constants";
import type { RunBudgetRoute } from "./runBudget";
import { resolveConfiguredMaxAgentSteps } from "./runBudget";
import type { GeneratedOutputPolicy } from "./generatedOutputPolicy";

export interface LoopBudgetPlan {
  hardCap: number;
  toolStepBudget: number;
  finalizationReserve: 1;
  expectedTools: string[];
  stopWhenSatisfied: boolean;
}

export function planLoopBudget(input: {
  prompt: string;
  route: RunBudgetRoute;
  generated: GeneratedOutputPolicy;
  configuredMaxSteps?: number | null;
}): LoopBudgetPlan {
  const hardCap = resolveConfiguredMaxAgentSteps(input.configuredMaxSteps);
  const expectedTools = getExpectedTools(input.prompt, input.generated);
  const finalizationReserve = 1 as const;
  const requestedToolBudget = getRequestedToolBudget({
    route: input.route,
    generated: input.generated,
    expectedTools,
  });
  const toolStepBudget = Math.max(
    0,
    Math.min(requestedToolBudget, Math.max(0, hardCap - finalizationReserve)),
  );

  return {
    hardCap: Math.min(MAX_AGENT_STEPS, hardCap),
    toolStepBudget,
    finalizationReserve,
    expectedTools,
    stopWhenSatisfied:
      input.generated.kind !== "general" || input.generated.requiresGrounding,
  };
}

function getExpectedTools(
  prompt: string,
  generated: GeneratedOutputPolicy,
): string[] {
  if (generated.kind === "diagram") {
    return ["create_design_canvas"];
  }

  if (generated.requiresGrounding || /\b(web|online|sources?|citations?)\b/i.test(prompt)) {
    return ["web_search", "web_fetch"];
  }

  return [];
}

function getRequestedToolBudget({
  route,
  generated,
  expectedTools,
}: {
  route: RunBudgetRoute;
  generated: GeneratedOutputPolicy;
  expectedTools: string[];
}): number {
  if (
    route === "instant_local" ||
    route === "direct_writeback" ||
    route === "prefetched_vault_answer" ||
    route === "prefetched_vault_writeback"
  ) {
    return 0;
  }

  if (generated.kind === "diagram") {
    return 3;
  }

  if (generated.requiresTextQuotes) {
    return 7;
  }

  if (generated.requiresGrounding || expectedTools.length > 0) {
    return 5;
  }

  if (generated.wordTarget && generated.wordTarget.target >= 1000) {
    return 2;
  }

  return route === "grounded_workflow" ? 4 : 2;
}
