import { missionLifecycleCommitsToolLadderV1 } from "./projectLifecycle";
import { hasExplicitResearchPublicationIntent } from "../tools/researchPublicationTool";

/**
 * Whether a prompt commits work the prompt-shaped effort profiles under-budget.
 *
 * The effort profile is picked from research-intent heuristics alone, and a
 * configured ceiling can only lower the result it produces — never raise it.
 * So a mission whose plan commits a long tool ladder silently inherits a
 * budget sized for a chat answer, and dies partway with a ledger that says it
 * could have continued.
 *
 * Two prompt shapes commit such a ladder:
 *
 * - A code lifecycle stage. See missionLifecycleCommitsToolLadderV1.
 * - Explicit research-publication intent. Publishing accepted research is
 *   strictly more than researching it: the evidence fetches come first, then
 *   the publication, its backlink, and its readback. The BYOK journey drew
 *   grounded_research (12 tool calls), spent nine of them gathering evidence,
 *   and then could not add publish_research_to_linear at all — "the host
 *   envelope is exhausted and its nonterminal continuation node lacks enough
 *   reserved budget". Its lane asked for maxAgentSteps 160 and still got 12.
 *
 * Escalation only raises the floor. Configured ceilings still clamp the
 * result, so no user-facing cap is removed by widening this predicate.
 */
export function missionRequiresExtendedEffortBudgetV1(prompt: string): boolean {
  return (
    missionLifecycleCommitsToolLadderV1(prompt) ||
    hasExplicitResearchPublicationIntent(prompt)
  );
}
