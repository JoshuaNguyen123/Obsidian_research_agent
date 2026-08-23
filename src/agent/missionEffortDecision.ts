import { MAX_AGENT_STEPS } from "../tools/constants";
import type { NoteOutputDestination } from "./noteOutputPolicy";

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

const EXPLICIT_GROUNDING_PATTERN =
  /\b(?:sources?|citations?|cited|cite|references?|bibliograph\w*|verify|verification|fact[-\s]?check|evidence|current|latest|recent|as\s+of|up[-\s]?to[-\s]?date|online|internet|web|urls?|compare\s+(?:sources?|evidence))\b|https?:\/\//iu;

const EXPLICIT_EXTENDED_PATTERN =
  /\b(?:deep\s+research|long\s+research|in[-\s]?depth\s+research|exhaustive\s+research|systematic\s+review|all\s+available\s+sources|overnight\s+research|multi[-\s]?source\s+(?:research|review|comparison)|evidence\s+ledger|long[-\s]?running\s+research)\b/iu;

const SIMPLE_DIRECT_PATTERN =
  /^(?:\s*(?:hi|hello|hey|thanks|thank\s+you|ok|okay|yes|no|sure)\s*[.!?…]*)+$/iu;

export function hasExplicitGroundingIntentV1(prompt: string): boolean {
  return EXPLICIT_GROUNDING_PATTERN.test(prompt);
}

export function hasExplicitExtendedResearchIntentV1(prompt: string): boolean {
  return EXPLICIT_EXTENDED_PATTERN.test(prompt);
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
      ceiling.maxWallClockMs,
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
