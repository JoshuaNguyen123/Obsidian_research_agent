import { MAX_AGENT_STEPS } from "../tools/constants";
import type { NoteOutputDestination } from "./noteOutputPolicy";
import { stripNegatedResearchDepthClausesV1 } from "./researchDepthIntent";
import {
  matchesFetchedWebSourceLanguageV1,
  matchesSourcesOrWebLanguageV1,
} from "./sourceIntent";

export type MissionEffortProfileV1 =
  | "direct"
  | "compose"
  | "grounded_research"
  | "extended_team";

export type MissionOutputDepthV1 = "compact" | "standard" | "in_depth";
export type MissionResearchDepthV1 = "none" | "grounded" | "extended";

export interface MissionFinalizationReserveV1 {
  modelCalls: number;
  toolCalls: number;
  requiredActions: readonly string[];
}

/**
 * One pre-execution decision separates how much to write from how much to
 * research. An explicitly configured value overrides the profile default in
 * either direction; the profile default is used when no configured value is
 * provided, or when the configured value is merely the system-wide hard cap
 * (see `perMissionCountBudget`).
 */
export interface MissionEffortDecisionV1 {
  version: 1;
  profile: MissionEffortProfileV1;
  route: string;
  outputDepth: MissionOutputDepthV1;
  researchDepth: MissionResearchDepthV1;
  outputTarget: NoteOutputDestination;
  maxModelCalls: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxSegments: number;
  finalizationReserve: MissionFinalizationReserveV1;
  escalationReasons: readonly string[];
  stopConditions: readonly string[];
}

export interface ResolveMissionEffortDecisionV1Input {
  prompt: string;
  route: string;
  outputTarget: NoteOutputDestination;
  /**
   * The user's own step budget, or null when they never set one. These are
   * genuinely different: `resolveConfiguredMaxAgentSteps` used to materialize
   * the hard cap for "unset", which made the two indistinguishable and forced
   * this module to guess the difference back out.
   */
  configuredMaxModelCalls?: number | null;
  configuredMaxToolCalls?: number | null;
  configuredMaxRunMinutes?: number | null;
  /**
   * Tool calls the mission's committed ladder requires, from
   * `missionCommittedWorkV1`. The profile still comes from prompt shape; the
   * budget comes from here.
   */
  committedToolCalls?: number | null;
  committedWorkReasons?: readonly string[];
  forceExtendedTeam?: boolean;
}

const OUTPUT_DEPTH_PATTERN =
  /\b(?:in[-\s]?depth|comprehensive|detailed|thorough|extensive|long[-\s]?form|full\s+(?:guide|report|analysis))\b/iu;

const EXPLICIT_GROUNDING_RESIDUAL_PATTERN =
  /\b(?:references?|bibliograph\w*|verify|verification|evidence|current|latest|recent|as\s+of|up[-\s]?to[-\s]?date|compare\s+(?:sources?|evidence))\b/iu;

const EXPLICIT_EXTENDED_PATTERN =
  /\b(?:deep\s+research|long\s+research|in[-\s]?depth\s+research|exhaustive\s+research|systematic\s+review|all\s+available\s+sources|overnight\s+research|multi[-\s]?source\s+(?:research|review|comparison)|evidence\s+ledger|long[-\s]?running\s+research)\b/iu;

const SIMPLE_DIRECT_PATTERN =
  /^(?:\s*(?:hi|hello|hey|thanks|thank\s+you|ok|okay|yes|no|sure)\s*[.!?…]*)+$/iu;

export function hasExplicitGroundingIntentV1(prompt: string): boolean {
  return (
    matchesFetchedWebSourceLanguageV1(prompt) ||
    matchesSourcesOrWebLanguageV1(prompt) ||
    EXPLICIT_GROUNDING_RESIDUAL_PATTERN.test(prompt)
  );
}

/**
 * STRIP-THEN-TEST. This predicate gates extended-team COST, so reading "do not
 * do deep research" or "without a multi-source review" as a request FOR the
 * extended team buys the mission the exact budget the sentence forbids -- the
 * repo's most-repeated regression shape, and the reason `researchDepthIntent`
 * exports its stripper rather than keeping it private.
 *
 * Only the strip is shared. The trigger stays this module's own and stays
 * NARROW: `hasDeepResearchIntent` fires on bare `deep dive`/`thorough
 * research` and `hasLongResearchIntent` on bare `investigate`/`strategy`,
 * which are the right answers to *their* questions ("is this a deep research
 * mission?", "does this need a long budget?") and the wrong answer to this one
 * ("did the user explicitly ask to pay for an extended team?"). Same-shaped
 * names, different questions.
 */
export function hasExplicitExtendedResearchIntentV1(prompt: string): boolean {
  return EXPLICIT_EXTENDED_PATTERN.test(
    stripNegatedResearchDepthClausesV1(prompt),
  );
}

/**
 * Budget floor implied by the tool ladder a mission has committed to.
 *
 * Every number below is derived from one committed ladder step, never from
 * prompt shape:
 *
 * - Tool calls: one call per step plus a bounded repair allowance, so a step
 *   that fails validation can be corrected rather than ending the run.
 * - Model calls: the ladder's own calls plus the turns that reason between
 *   them.
 * - Wall clock: a per-step allowance. This is what actually killed the code
 *   lane -- applyEffortRunDeadline takes min(configuredMaxRunMs,
 *   effortMaxWallClockMs), so a lane asking for 35 minutes was silently cut to
 *   the profile's three.
 * - Segments: a ladder long enough to cross a segment boundary needs the turns
 *   to do it.
 *
 * The floor can never exceed `extended_team`, the largest sanctioned profile,
 * so naming more stages cannot buy an unbounded budget. It only ever raises;
 * configured settings still clamp afterwards.
 */
const LADDER_TOOL_CALL_ATTEMPTS_PER_STEP_V1 = 6;
const LADDER_MODEL_CALLS_PER_TOOL_CALL_V1 = 1.5;
const LADDER_WALL_CLOCK_MS_PER_STEP_V1 = 3 * 60_000;
const LADDER_SEGMENT_TURNOVER_STEPS_V1 = 5;
/**
 * Wall-clock ceiling for a detected ladder, above `extended_team`'s flat 20
 * minutes.
 *
 * Measured on the floor function itself: tool calls scale with the ladder
 * until 40 steps, but wall clock stopped scaling at 7. A 14-step
 * build-validate-commit-publish ladder therefore drew 86 tool calls and the
 * same 20 minutes as a 7-step single-file build — twice the work in the same
 * time. The profile is internally inconsistent in the same way: it grants 200
 * tool calls and 20 minutes, which is six seconds per call, and one
 * `code_validate_fast` in a fresh container is not six seconds.
 *
 * 45 minutes is `extended_team`'s 200 tool calls at a rounded-down 13 seconds
 * each — enough that the time can cover the work the same profile already
 * permits, and no more. A ladder still has to be long enough to ask for it
 * (15 steps at 3 minutes), it applies only when a ladder was detected at all,
 * and a configured run time still clamps afterwards, so nobody who set a
 * limit loses it.
 */
const LADDER_MAX_WALL_CLOCK_MS_V1 = 45 * 60_000;

export interface MissionEffortLadderFloorV1 {
  maxModelCalls: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxSegments: number;
}

export function missionEffortFloorForCommittedToolCallsV1(
  committedToolCalls: number | null | undefined,
): MissionEffortLadderFloorV1 | null {
  if (
    typeof committedToolCalls !== "number" ||
    !Number.isFinite(committedToolCalls) ||
    committedToolCalls <= 0
  ) {
    return null;
  }
  const steps = Math.trunc(committedToolCalls);
  const ceiling = profileDefaults("extended_team");
  const toolCalls = Math.min(
    ceiling.maxToolCalls,
    steps * LADDER_TOOL_CALL_ATTEMPTS_PER_STEP_V1 +
      ceiling.finalizationToolCalls,
  );
  return {
    maxToolCalls: toolCalls,
    maxModelCalls: Math.min(
      Math.min(ceiling.maxModelCalls, MAX_AGENT_STEPS),
      Math.ceil(toolCalls * LADDER_MODEL_CALLS_PER_TOOL_CALL_V1),
    ),
    maxWallClockMs: Math.min(
      // Deliberately NOT ceiling.maxWallClockMs: that flat 20 minutes is what
      // stopped this dimension scaling with the ladder while every other one
      // did. See LADDER_MAX_WALL_CLOCK_MS_V1.
      Math.max(ceiling.maxWallClockMs, LADDER_MAX_WALL_CLOCK_MS_V1),
      steps * LADDER_WALL_CLOCK_MS_PER_STEP_V1,
    ),
    maxSegments:
      steps >= LADDER_SEGMENT_TURNOVER_STEPS_V1 ? ceiling.maxSegments : 1,
  };
}

export function resolveMissionEffortDecisionV1(
  input: ResolveMissionEffortDecisionV1Input,
): MissionEffortDecisionV1 {
  const prompt = input.prompt.trim();
  const outputDepth: MissionOutputDepthV1 = OUTPUT_DEPTH_PATTERN.test(prompt)
    ? "in_depth"
    : prompt.length >= 180
      ? "standard"
      : "compact";
  const extended =
    input.forceExtendedTeam === true ||
    hasExplicitExtendedResearchIntentV1(prompt);
  const grounded = !extended && hasExplicitGroundingIntentV1(prompt);
  const direct =
    !extended &&
    !grounded &&
    input.route === "single_model_answer" &&
    outputDepth === "compact" &&
    (SIMPLE_DIRECT_PATTERN.test(prompt) ||
      (input.outputTarget === "chat" && prompt.length < 80));

  const profile: MissionEffortProfileV1 = extended
    ? "extended_team"
    : grounded
      ? "grounded_research"
      : direct
        ? "direct"
        : "compose";
  const defaults = profileDefaults(profile);
  // The ladder floor raises a prompt-shaped default to what the mission has
  // actually committed to doing. It never lowers, and it is bounded by
  // `extended_team`. The `direct` profile keeps its 1/0/1min default when
  // nothing is committed and nothing is configured -- which, now that "unset"
  // is a real null rather than the materialized hard cap, needs no exception.
  const floor = missionEffortFloorForCommittedToolCallsV1(
    input.committedToolCalls,
  );
  // When the committed ladder is known it governs the counts. `extended_team`
  // is selected because a mission is a multi-stage pipeline, but its 100/200
  // are then a ceiling rather than a floor: granting a seven-tool code ladder
  // 200 tool calls and three twenty-minute segments is precisely the runaway
  // the handoff recorded, where a lane ground into Playwright's 45-minute
  // ceiling under a provider slowdown instead of finishing or failing. A
  // ladder-sized budget never drops below `grounded_research`, so a mission
  // that needs to gather before it writes is still funded to do so.
  const ladderCeilingProfile = profile === "extended_team" && floor
    ? profileDefaults("grounded_research")
    : defaults;
  const flooredModelCalls = Math.max(
    ladderCeilingProfile.maxModelCalls,
    floor?.maxModelCalls ?? 0,
  );
  const flooredToolCalls = Math.max(
    ladderCeilingProfile.maxToolCalls,
    floor?.maxToolCalls ?? 0,
  );
  const maxModelCalls = applyPositiveCeiling(
    flooredModelCalls,
    input.configuredMaxModelCalls,
  );
  const maxToolCalls = applyNonNegativeCeiling(
    flooredToolCalls,
    input.configuredMaxToolCalls,
  );
  const configuredWallClockMs =
    typeof input.configuredMaxRunMinutes === "number" &&
    Number.isFinite(input.configuredMaxRunMinutes) &&
    input.configuredMaxRunMinutes > 0
      ? Math.floor(input.configuredMaxRunMinutes * 60_000)
      : null;
  const flooredWallClockMs = Math.max(
    defaults.maxWallClockMs,
    floor?.maxWallClockMs ?? 0,
  );

  return {
    version: 1,
    profile,
    route: input.route,
    outputDepth,
    researchDepth: extended ? "extended" : grounded ? "grounded" : "none",
    outputTarget: input.outputTarget,
    maxModelCalls,
    maxToolCalls,
    maxWallClockMs:
      // A direct mission is one model call, and its one-minute deadline is
      // part of that contract rather than a budget: a mission-level run cap
      // must not turn a hung single call into an hour of waiting. Every other
      // profile takes the configured value, floored by the committed ladder.
      profile === "direct" || configuredWallClockMs === null
        ? flooredWallClockMs
        : Math.max(configuredWallClockMs, floor?.maxWallClockMs ?? 0),
    maxSegments: Math.max(defaults.maxSegments, floor?.maxSegments ?? 0),
    finalizationReserve: {
      modelCalls: Math.min(defaults.finalizationModelCalls, maxModelCalls),
      toolCalls: Math.min(defaults.finalizationToolCalls, maxToolCalls),
      requiredActions:
        input.outputTarget === "chat"
          ? ["render_result"]
          : ["write_output", "read_back_output", "render_result"],
    },
    escalationReasons: [
      ...(extended ? ["explicit_extended_research"] : []),
      ...(grounded ? ["explicit_grounding_required"] : []),
      ...(outputDepth === "in_depth" ? ["in_depth_output_requested"] : []),
      ...(floor
        ? [
            `committed_tool_ladder:${Math.trunc(input.committedToolCalls ?? 0)}`,
            ...(input.committedWorkReasons ?? []),
          ]
        : []),
    ],
    stopConditions: [
      "acceptance_passed",
      "two_evidence_batches_without_relevant_information",
      "proof_fingerprint_unchanged_after_continuation",
      "same_blocker_repeated",
      "finalization_reserve_reached",
    ],
  };
}

export interface MissionEffortResearchEscalationInputV1 {
  /**
   * True when planning attached a research contract the mission must satisfy
   * before acceptance (a fetched-source floor and/or an adaptive research
   * effort tier).
   */
  researchContractAttached: boolean;
  configuredMaxModelCalls?: number | null;
  configuredMaxToolCalls?: number | null;
  configuredMaxRunMinutes?: number | null;
}

/**
 * Reconcile a pre-execution effort decision with what planning actually
 * attached to the mission. The profile above is decided by prompt regexes, but
 * the research contract can be attached later by a model-based classifier the
 * regexes cannot see — leaving a compose-sized budget (6 calls / 4 tools /
 * 3 min) responsible for a grounded-research contract (fetch N sources before
 * any write tool unlocks). That mismatch exhausted the provider budget before
 * acceptance on plain prompts like "write me a brief with diagrams".
 *
 * Floors the budget up to the grounded_research profile; never lowers an
 * already-larger decision, and still respects configured settings ceilings.
 */
export function escalateMissionEffortDecisionForResearchV1(
  decision: MissionEffortDecisionV1,
  input: MissionEffortResearchEscalationInputV1,
): MissionEffortDecisionV1 {
  if (!input.researchContractAttached) {
    return decision;
  }
  if (
    decision.profile === "grounded_research" ||
    decision.profile === "extended_team"
  ) {
    return decision;
  }
  const grounded = profileDefaults("grounded_research");
  const flooredModelCalls = Math.max(
    decision.maxModelCalls,
    applyPositiveCeiling(grounded.maxModelCalls, input.configuredMaxModelCalls),
  );
  const flooredToolCalls = Math.max(
    decision.maxToolCalls,
    applyNonNegativeCeiling(grounded.maxToolCalls, input.configuredMaxToolCalls),
  );
  const configuredWallClockMs =
    typeof input.configuredMaxRunMinutes === "number" &&
    Number.isFinite(input.configuredMaxRunMinutes) &&
    input.configuredMaxRunMinutes > 0
      ? Math.floor(input.configuredMaxRunMinutes * 60_000)
      : null;
  const flooredWallClockMs = Math.max(
    decision.maxWallClockMs,
    configuredWallClockMs === null
      ? grounded.maxWallClockMs
      : configuredWallClockMs,
  );

  return {
    ...decision,
    profile: "grounded_research",
    researchDepth:
      decision.researchDepth === "none" ? "grounded" : decision.researchDepth,
    maxModelCalls: flooredModelCalls,
    maxToolCalls: flooredToolCalls,
    maxWallClockMs: flooredWallClockMs,
    maxSegments: Math.max(decision.maxSegments, grounded.maxSegments),
    finalizationReserve: {
      ...decision.finalizationReserve,
      modelCalls: Math.min(
        Math.max(
          decision.finalizationReserve.modelCalls,
          grounded.finalizationModelCalls,
        ),
        flooredModelCalls,
      ),
      toolCalls: Math.min(
        Math.max(
          decision.finalizationReserve.toolCalls,
          grounded.finalizationToolCalls,
        ),
        flooredToolCalls,
      ),
    },
    escalationReasons: [
      ...decision.escalationReasons,
      "research_contract_attached_after_planning",
    ],
  };
}

function profileDefaults(profile: MissionEffortProfileV1): {
  maxModelCalls: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxSegments: number;
  finalizationModelCalls: number;
  finalizationToolCalls: number;
} {
  switch (profile) {
    case "direct":
      return {
        maxModelCalls: 1,
        maxToolCalls: 0,
        maxWallClockMs: 60_000,
        maxSegments: 1,
        finalizationModelCalls: 1,
        finalizationToolCalls: 0,
      };
    case "compose":
      return {
        maxModelCalls: 6,
        maxToolCalls: 4,
        maxWallClockMs: 3 * 60_000,
        maxSegments: 2,
        finalizationModelCalls: 2,
        finalizationToolCalls: 2,
      };
    case "grounded_research":
      return {
        maxModelCalls: 16,
        maxToolCalls: 12,
        maxWallClockMs: 10 * 60_000,
        maxSegments: 2,
        finalizationModelCalls: 2,
        finalizationToolCalls: 2,
      };
    case "extended_team":
      return {
        maxModelCalls: 100,
        maxToolCalls: 200,
        maxWallClockMs: 20 * 60_000,
        maxSegments: 3,
        finalizationModelCalls: 4,
        finalizationToolCalls: 2,
      };
  }
}

function applyPositiveCeiling(defaultValue: number, ceiling: number | null | undefined): number {
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling <= 0) {
    return defaultValue;
  }
  return Math.max(1, Math.trunc(ceiling));
}

function applyNonNegativeCeiling(
  defaultValue: number,
  ceiling: number | null | undefined,
): number {
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 0) {
    return defaultValue;
  }
  return Math.max(0, Math.trunc(ceiling));
}
