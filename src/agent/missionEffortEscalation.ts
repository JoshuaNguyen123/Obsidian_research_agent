import {
  committedToolCallsForLifecycleStagesV1,
  PROJECT_LIFECYCLE_STAGE_COMMITTED_TOOL_CALLS_V1,
} from "./lifecycleStagePolicy";
import {
  detectProjectLifecycleStagesV1,
  type ProjectLifecycleStageV1,
} from "./projectLifecycle";
import { hasExplicitResearchPublicationIntent } from "../tools/researchPublicationTool";

/**
 * What a mission has actually committed to do, sized in tool calls.
 *
 * The effort profile itself is still chosen from prompt shape, and that is
 * defensible — "write me a haiku" and "audit these sources" really are
 * different kinds of request. What was never defensible is deriving the
 * *budget* from prompt shape too. A prompt that commits a seven-step code
 * ladder drew `compose` (four tool calls) and died at step four; two shipped
 * fixes (`09760d4`, `60e5006`) were one-off predicates bolted onto the
 * classifier to force a jump straight to `extended_team`, and this module was
 * on its way to becoming a list of such special cases.
 *
 * So the ladder decides the numbers. `detectProjectLifecycleStagesV1` is the
 * same deterministic classification the graph planner seeds its node list
 * from, and each stage's committed ladder length lives beside the stage
 * allowlists it belongs to. Publication of accepted research adds its own
 * committed work on top when the stage detector has not already counted it:
 * publishing research is strictly more than researching it — the evidence
 * fetches come first, then the publication, its backlink, and its readback.
 *
 * This module only ever raises a floor. Configured settings still clamp, and
 * the floor is itself bounded by the largest sanctioned profile, so no
 * user-facing cap is removed and a runaway mission cannot buy itself an
 * unbounded budget by naming more stages.
 */
export interface MissionCommittedWorkV1 {
  stages: readonly ProjectLifecycleStageV1[];
  /** Tool calls the detected work commits before any repair allowance. */
  toolCalls: number;
  reasons: readonly string[];
}

/** Committed tool calls for publishing accepted research, beyond researching it. */
const RESEARCH_PUBLICATION_COMMITTED_TOOL_CALLS_V1 = 4;

export function missionCommittedWorkV1(prompt: string): MissionCommittedWorkV1 {
  const stages = detectProjectLifecycleStagesV1(prompt);
  let toolCalls = committedToolCallsForLifecycleStagesV1(stages);
  const reasons: string[] = [];
  if (stages.length > 0) {
    reasons.push(`lifecycle_stages:${stages.join("+")}`);
  }
  if (hasExplicitResearchPublicationIntent(prompt)) {
    // BYOK Phase A detects only accepted_research, so the publication half was
    // invisible: the mission spent its whole grounded budget on evidence and
    // then could not add publish_research_to_linear at all.
    if (!stages.includes("linear_hierarchy")) {
      toolCalls +=
        PROJECT_LIFECYCLE_STAGE_COMMITTED_TOOL_CALLS_V1.linear_hierarchy;
    }
    toolCalls += RESEARCH_PUBLICATION_COMMITTED_TOOL_CALLS_V1;
    reasons.push("research_publication_intent");
  }
  return { stages, toolCalls, reasons };
}

/**
 * Whether a prompt commits work the prompt-shaped effort profiles under-budget.
 *
 * Retained because the profile *selection* still needs a coarse signal for the
 * genuinely multi-stage pipelines that need `extended_team`'s segment count,
 * not only its numbers. The numbers themselves now come from
 * {@link missionCommittedWorkV1}.
 */
export function missionRequiresExtendedEffortBudgetV1(prompt: string): boolean {
  const committed = missionCommittedWorkV1(prompt);
  return (
    committed.stages.length > 1 ||
    committed.stages.includes("code_execution") ||
    committed.reasons.includes("research_publication_intent")
  );
}
