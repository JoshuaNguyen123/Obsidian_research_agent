import { MAX_AGENT_STEPS } from "../tools/constants";

export interface ResearchTeamBudget {
  rootModelSteps: number;
  rootToolCalls: number;
  researcherModelSteps: number;
  researcherToolCalls: number;
  leadModelSteps: number;
  leadToolCalls: number;
}

/**
 * Split one configured mission budget between Researcher and Lead.
 *
 * The worker settings are maxima, not an independent authority grant. The
 * Lead always retains a small finalization reserve, and neither participant
 * can make the combined team exceed the user's configured mission cap.
 */
export function resolveResearchTeamBudget(input: {
  configuredMaxAgentSteps?: number;
  requestedWorkerMaxSteps?: number;
  requestedWorkerMaxToolCalls?: number;
}): ResearchTeamBudget {
  const rootModelSteps = clampInteger(
    input.configuredMaxAgentSteps ?? MAX_AGENT_STEPS,
    2,
    MAX_AGENT_STEPS,
  );
  const rootToolCalls = rootModelSteps * 2;
  const leadStepReserve = Math.min(4, rootModelSteps - 1);
  const leadToolReserve = Math.min(16, rootToolCalls - 1);
  const researcherModelSteps = Math.min(
    clampInteger(input.requestedWorkerMaxSteps ?? 40, 1, MAX_AGENT_STEPS),
    rootModelSteps - leadStepReserve,
  );
  const researcherToolCalls = Math.min(
    clampInteger(input.requestedWorkerMaxToolCalls ?? 40, 1, MAX_AGENT_STEPS * 2),
    rootToolCalls - leadToolReserve,
  );

  return {
    rootModelSteps,
    rootToolCalls,
    researcherModelSteps,
    researcherToolCalls,
    leadModelSteps: rootModelSteps - researcherModelSteps,
    leadToolCalls: rootToolCalls - researcherToolCalls,
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
