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
 * research. Settings remain ceilings: this object may narrow them, never raise
 * them.
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
  configuredMaxModelCalls?: number | null;
  configuredMaxToolCalls?: number | null;
  configuredMaxRunMinutes?: number | null;
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
  const maxModelCalls = applyPositiveCeiling(
    defaults.maxModelCalls,
    input.configuredMaxModelCalls,
  );
  const maxToolCalls = applyNonNegativeCeiling(
    defaults.maxToolCalls,
    input.configuredMaxToolCalls,
  );
  const configuredWallClockMs =
    typeof input.configuredMaxRunMinutes === "number" &&
    Number.isFinite(input.configuredMaxRunMinutes) &&
    input.configuredMaxRunMinutes > 0
      ? Math.floor(input.configuredMaxRunMinutes * 60_000)
      : null;

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
      configuredWallClockMs === null
        ? defaults.maxWallClockMs
        : Math.min(defaults.maxWallClockMs, configuredWallClockMs),
    maxSegments: defaults.maxSegments,
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
      : Math.min(grounded.maxWallClockMs, configuredWallClockMs),
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
  return Math.max(1, Math.min(defaultValue, Math.trunc(ceiling)));
}

function applyNonNegativeCeiling(
  defaultValue: number,
  ceiling: number | null | undefined,
): number {
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 0) {
    return defaultValue;
  }
  return Math.max(0, Math.min(defaultValue, Math.trunc(ceiling)));
}
