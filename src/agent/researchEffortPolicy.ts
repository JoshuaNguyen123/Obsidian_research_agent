export const RESEARCH_EFFORT_TIER_ORDER = [
  "quick",
  "standard",
  "deep",
  "extended",
] as const;

export type ResearchEffortTier = (typeof RESEARCH_EFFORT_TIER_ORDER)[number];

export type ResearchFreshnessRequirement = "none" | "helpful" | "required";
export type ResearchRisk = "low" | "medium" | "high" | "critical";

export interface ResearchEffortBudget {
  /** Model steps available to one segment. */
  maxModelStepsPerSegment: number;
  /** Tool calls available to one segment. */
  maxToolCallsPerSegment: number;
  /** Durable segments available to the tier. */
  maxSegments: number;
  /** Cumulative model-step ceiling across all segments. */
  maxTotalModelSteps: number;
  /** Cumulative tool-call ceiling across all segments. */
  maxTotalToolCalls: number;
  /** Active execution-time ceiling. User idle time between resumes is excluded. */
  maxDurationMs: number | null;
}

const HOUR_MS = 60 * 60 * 1_000;

/**
 * Host-owned defaults from the adaptive-research contract. Extended work uses
 * four durable 100-step segments inside an eight-hour active-execution ceiling.
 * Its tool budget preserves the 1:2 tool-to-step ratio used by the three
 * shorter tiers.
 */
export const RESEARCH_EFFORT_BUDGETS: Readonly<
  Record<ResearchEffortTier, Readonly<ResearchEffortBudget>>
> = Object.freeze({
  quick: Object.freeze({
    maxModelStepsPerSegment: 8,
    maxToolCallsPerSegment: 4,
    maxSegments: 1,
    maxTotalModelSteps: 8,
    maxTotalToolCalls: 4,
    maxDurationMs: null,
  }),
  standard: Object.freeze({
    maxModelStepsPerSegment: 24,
    maxToolCallsPerSegment: 12,
    maxSegments: 1,
    maxTotalModelSteps: 24,
    maxTotalToolCalls: 12,
    maxDurationMs: null,
  }),
  deep: Object.freeze({
    maxModelStepsPerSegment: 60,
    maxToolCallsPerSegment: 30,
    maxSegments: 1,
    maxTotalModelSteps: 60,
    maxTotalToolCalls: 30,
    maxDurationMs: null,
  }),
  extended: Object.freeze({
    maxModelStepsPerSegment: 100,
    maxToolCallsPerSegment: 50,
    maxSegments: 4,
    maxTotalModelSteps: 400,
    maxTotalToolCalls: 200,
    maxDurationMs: 8 * HOUR_MS,
  }),
});

/** Explicit user and host ceilings. Every supplied value is a hard limit. */
export interface ResearchEffortConstraints {
  /** Select this starting tier before hard ceilings are applied. */
  requestedTier?: ResearchEffortTier;
  /** Do not automatically select or escalate above this tier. */
  maxTier?: ResearchEffortTier;
  maxModelSteps?: number;
  maxToolCalls?: number;
  maxSegments?: number;
  maxDurationMs?: number;
}

export interface SelectInitialResearchEffortInput {
  prompt: string;
  /** Loose route label so the policy does not depend on a runner type. */
  route?: string;
  subquestions?: number | readonly unknown[];
  /** Host-required fetched sources after parsing any explicit user limit. */
  requiredSources?: number;
  freshness?: ResearchFreshnessRequirement;
  risk?: ResearchRisk;
  constraints?: ResearchEffortConstraints;
}

export interface ResearchEffortSelection {
  tier: ResearchEffortTier;
  budget: ResearchEffortBudget;
  /** Stable, user-visible facts that caused the selection. */
  reasons: string[];
  constrained: boolean;
}

export interface ResearchEffortUsage {
  /** Cumulative across every segment in this research mission. */
  modelSteps: number;
  /** Cumulative across every segment in this research mission. */
  toolCalls: number;
  /** Includes the currently active segment. */
  segmentsStarted: number;
  /** Needed to roll an extended tier into its next 100-step segment. */
  modelStepsInCurrentSegment?: number;
  /** Exact per-segment tool usage; optional for legacy persisted plans. */
  toolCallsInCurrentSegment?: number;
  /**
   * Host completion segments that began while accepted research was active.
   * This lets compound runs reserve a bounded research allowance without
   * consuming the later pipeline's configured completion-segment allowance.
   */
  completionSegmentsStarted?: number;
  /** Active execution time only; user idle time between resumes is excluded. */
  elapsedMs: number;
}

export interface DecideResearchProgressInput {
  tier: ResearchEffortTier;
  usage: ResearchEffortUsage;
  acceptanceGaps: readonly string[];
  remainingQuestions: number | readonly unknown[];
  conflicts: number | readonly unknown[];
  /** Normalized material-new-evidence rate from the latest batch (0..1). */
  evidenceYield: number;
  consecutiveLowYieldBatches: number;
  constraints?: ResearchEffortConstraints;
}

export type ResearchProgressStopReason =
  | "acceptance_saturated"
  | "duration_cap_reached"
  | "model_step_cap_reached"
  | "tool_call_cap_reached"
  | "segment_cap_reached";

export interface ResearchProgressDecision {
  action: "continue" | "stop" | "escalate";
  tier: ResearchEffortTier;
  nextTier?: ResearchEffortTier;
  budget: ResearchEffortBudget;
  reason:
    | ResearchProgressStopReason
    | "unresolved_proof"
    | "useful_evidence_arriving"
    | "confirming_saturation"
    | "start_next_segment"
    | "tier_budget_nearly_spent";
  startNewSegment: boolean;
  unresolved: {
    acceptanceGaps: number;
    remainingQuestions: number;
    conflicts: number;
  };
}

/**
 * A batch whose normalized material-new-evidence rate falls below this value is
 * "low yield". Exported so the live loop controller increments its
 * consecutive-low-yield counter against the exact same boundary the stop/escalate
 * decision uses — the two must never drift.
 */
export const LOW_YIELD_THRESHOLD = 0.1;
const ESCALATION_UTILIZATION = 0.75;

/** Deterministically select the smallest tier justified by observable inputs. */
export function selectInitialResearchEffort(
  input: SelectInitialResearchEffortInput,
): ResearchEffortSelection {
  const constraints = input.constraints ?? {};
  const reasons: string[] = [];
  const requestedTier = constraints.requestedTier;
  let tier: ResearchEffortTier;

  if (requestedTier) {
    tier = requestedTier;
    reasons.push(`User requested the ${requestedTier} research tier.`);
  } else {
    const classified = classifyTier(input);
    tier = classified.tier;
    reasons.push(...classified.reasons);
  }

  const constrainedTier = clampTier(tier, constraints.maxTier);
  const constrained =
    constrainedTier !== tier || hasNumericConstraint(constraints);
  if (constrainedTier !== tier) {
    reasons.push(`Research tier was capped at ${constrainedTier}.`);
  }

  return {
    tier: constrainedTier,
    budget: resolveResearchEffortBudget(constrainedTier, constraints),
    reasons,
    constrained,
  };
}

/** Apply explicit ceilings without mutating the shared tier defaults. */
export function resolveResearchEffortBudget(
  tier: ResearchEffortTier,
  constraints: ResearchEffortConstraints = {},
): ResearchEffortBudget {
  const base = RESEARCH_EFFORT_BUDGETS[tier];
  const maxSegments = capNonNegativeInteger(
    base.maxSegments,
    constraints.maxSegments,
  );
  const segmentScale = base.maxSegments === 0
    ? 0
    : maxSegments / base.maxSegments;
  const segmentLimitedModelSteps = Math.floor(
    base.maxTotalModelSteps * segmentScale,
  );
  const segmentLimitedToolCalls = Math.floor(
    base.maxTotalToolCalls * segmentScale,
  );
  const maxTotalModelSteps = capNonNegativeInteger(
    segmentLimitedModelSteps,
    constraints.maxModelSteps,
  );
  const maxTotalToolCalls = capNonNegativeInteger(
    segmentLimitedToolCalls,
    constraints.maxToolCalls,
  );

  return {
    maxModelStepsPerSegment: Math.min(
      base.maxModelStepsPerSegment,
      maxTotalModelSteps,
    ),
    maxToolCallsPerSegment: Math.min(
      base.maxToolCallsPerSegment,
      maxTotalToolCalls,
    ),
    maxSegments,
    maxTotalModelSteps,
    maxTotalToolCalls,
    maxDurationMs: capNullableDuration(
      base.maxDurationMs,
      constraints.maxDurationMs,
    ),
  };
}

/**
 * Decide one bounded transition. Escalation always moves exactly one tier and
 * only while unresolved work is still producing material evidence.
 */
export function decideResearchProgress(
  input: DecideResearchProgressInput,
): ResearchProgressDecision {
  const constraints = input.constraints ?? {};
  const budget = resolveResearchEffortBudget(input.tier, constraints);
  const usage = normalizeUsage(input.usage);
  const unresolved = {
    acceptanceGaps: count(input.acceptanceGaps),
    remainingQuestions: count(input.remainingQuestions),
    conflicts: count(input.conflicts),
  };
  const hasUnresolved =
    unresolved.acceptanceGaps > 0 ||
    unresolved.remainingQuestions > 0 ||
    unresolved.conflicts > 0;
  const usefulEvidence = clampUnit(input.evidenceYield) >= LOW_YIELD_THRESHOLD;
  const lowYieldBatches = nonNegativeInteger(input.consecutiveLowYieldBatches);

  const explicitCap = findReachedExplicitCap(usage, constraints);
  if (explicitCap) {
    return stopDecision(input.tier, budget, explicitCap, unresolved);
  }
  if (budget.maxSegments === 0) {
    return stopDecision(
      input.tier,
      budget,
      "segment_cap_reached",
      unresolved,
    );
  }
  if (usage.segmentsStarted > budget.maxSegments) {
    return stopDecision(
      input.tier,
      budget,
      "segment_cap_reached",
      unresolved,
    );
  }
  if (budget.maxDurationMs !== null && usage.elapsedMs >= budget.maxDurationMs) {
    return stopDecision(
      input.tier,
      budget,
      "duration_cap_reached",
      unresolved,
    );
  }

  const nextTier = nextAllowedTier(input.tier, constraints.maxTier);
  const atModelCap = usage.modelSteps >= budget.maxTotalModelSteps;
  const atToolCap = usage.toolCalls >= budget.maxTotalToolCalls;

  if (atModelCap || atToolCap) {
    if (hasUnresolved && usefulEvidence && nextTier) {
      return escalationDecision(input.tier, nextTier, constraints, unresolved);
    }
    return stopDecision(
      input.tier,
      budget,
      atModelCap ? "model_step_cap_reached" : "tool_call_cap_reached",
      unresolved,
    );
  }

  if (
    !hasUnresolved &&
    !usefulEvidence &&
    lowYieldBatches >= 2
  ) {
    return stopDecision(
      input.tier,
      budget,
      "acceptance_saturated",
      unresolved,
    );
  }

  const utilization = Math.max(
    fraction(usage.modelSteps, budget.maxTotalModelSteps),
    fraction(usage.toolCalls, budget.maxTotalToolCalls),
  );
  if (
    hasUnresolved &&
    usefulEvidence &&
    utilization >= ESCALATION_UTILIZATION &&
    nextTier
  ) {
    return escalationDecision(input.tier, nextTier, constraints, unresolved);
  }

  const currentSegmentSpent =
    usage.modelStepsInCurrentSegment ??
    (input.tier === "extended"
      ? Math.max(
          0,
          usage.modelSteps -
            Math.max(0, usage.segmentsStarted - 1) *
              budget.maxModelStepsPerSegment,
        )
      : usage.modelSteps);
  if (
    input.tier === "extended" &&
    currentSegmentSpent >= budget.maxModelStepsPerSegment
  ) {
    if (usage.segmentsStarted >= budget.maxSegments) {
      return stopDecision(
        input.tier,
        budget,
        "segment_cap_reached",
        unresolved,
      );
    }
    return {
      action: "continue",
      tier: input.tier,
      budget,
      reason: "start_next_segment",
      startNewSegment: true,
      unresolved,
    };
  }

  return {
    action: "continue",
    tier: input.tier,
    budget,
    reason: hasUnresolved
      ? "unresolved_proof"
      : usefulEvidence
        ? "useful_evidence_arriving"
        : "confirming_saturation",
    startNewSegment: false,
    unresolved,
  };
}

function classifyTier(
  input: SelectInitialResearchEffortInput,
): { tier: ResearchEffortTier; reasons: string[] } {
  const prompt = input.prompt.replace(/\s+/gu, " ").trim().toLowerCase();
  const route = (input.route ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/gu, " ");
  const subquestions = count(input.subquestions ?? 0);
  const freshness = input.freshness ?? "none";
  const risk = input.risk ?? "low";
  const reasons: string[] = [];

  const requiredSources = nonNegativeInteger(input.requiredSources ?? 0);
  const explicitlyDeep =
    /\b(?:deep|long research|deep web|deep vault|deep hybrid|extended|overnight)\b/u.test(
      route,
    ) ||
    /\b(?:deep research|in[- ]depth research|overnight|exhaustive|systematic review|all available sources)\b/u.test(
      prompt,
    );
  const broadOrComparative =
    /\b(?:compare|comparison|trade-?offs?|alternatives?|comprehensive|landscape|end[- ]to[- ]end|architecture)\b/u.test(
      prompt,
    );
  const wordCount = prompt ? prompt.split(" ").length : 0;

  if (
    requiredSources >= 1 &&
    requiredSources <= 2 &&
    subquestions <= 2 &&
    risk === "low" &&
    !explicitlyDeep &&
    !broadOrComparative &&
    wordCount < 80
  ) {
    const focusedTier: ResearchEffortTier =
      requiredSources === 1 ? "quick" : "standard";
    reasons.push(
      requiredSources === 1
        ? "One focused source and at most one evidence question require only a quick research pass."
        : "Two focused sources require a standard research pass.",
    );
    return { tier: focusedTier, reasons };
  }

  if (
    /\b(?:extended|overnight)\b/u.test(route) ||
    /\b(?:overnight|exhaustive|systematic review|all available sources)\b/u.test(
      prompt,
    ) ||
    subquestions >= 8 ||
    risk === "critical"
  ) {
    if (subquestions >= 8) reasons.push(`${subquestions} research subquestions require durable work.`);
    if (risk === "critical") reasons.push("Critical-risk research requires the durable tier.");
    if (/\b(?:extended|overnight)\b/u.test(route)) reasons.push(`Route ${route} requires durable research.`);
    if (/\b(?:overnight|exhaustive|systematic review|all available sources)\b/u.test(prompt)) {
      reasons.push("The mission explicitly requests exhaustive or durable research.");
    }
    return { tier: "extended", reasons };
  }

  let score = 0;
  if (subquestions >= 4) {
    score += 4;
    reasons.push(`${subquestions} research subquestions require broad coverage.`);
  } else if (subquestions >= 2) {
    score += 2;
    reasons.push(`${subquestions} research subquestions require normal coverage.`);
  } else {
    reasons.push("The mission has at most one focused research question.");
  }

  if (/\b(?:deep|long research|deep web|deep vault|deep hybrid)\b/u.test(route)) {
    score += 2;
    reasons.push(`Route ${route} requests deep research.`);
  } else if (/\b(?:research|grounded)\b/u.test(route)) {
    score += 1;
    reasons.push(`Route ${route} requires grounded research.`);
  }
  if (/\b(?:deep research|in[- ]depth research)\b/u.test(prompt)) {
    score += 2;
    reasons.push("The mission explicitly requests deep research.");
  }

  if (freshness === "required") {
    score += 1;
    reasons.push("Current evidence is required.");
  } else if (freshness === "helpful") {
    reasons.push("Fresh evidence is helpful but not mandatory.");
  }

  if (risk === "high") {
    score += 3;
    reasons.push("High-risk conclusions require deeper verification.");
  } else if (risk === "medium") {
    score += 1;
    reasons.push("Medium-risk conclusions require additional verification.");
  }

  if (/\b(?:compare|comparison|trade-?offs?|alternatives?)\b/u.test(prompt)) {
    score += 1;
    reasons.push("The prompt requires comparative synthesis.");
  }
  if (/\b(?:comprehensive|landscape|end[- ]to[- ]end|architecture)\b/u.test(prompt)) {
    score += 2;
    reasons.push("The prompt requests broad or end-to-end coverage.");
  }
  if (
    freshness === "none" &&
    /\b(?:latest|current|recent|today|as of)\b/u.test(prompt)
  ) {
    score += 1;
    reasons.push("The prompt itself requires current evidence.");
  }
  if (wordCount >= 250) {
    score += 2;
    reasons.push("The prompt contains a large multi-part specification.");
  } else if (wordCount >= 80) {
    score += 1;
    reasons.push("The prompt contains a multi-part specification.");
  }
  if (/\b(?:quick|quickly|brief|briefly|one focused source)\b/u.test(prompt)) {
    score = Math.max(0, score - 1);
    reasons.push("The user requested a concise research pass.");
  }

  return {
    tier: score >= 4 ? "deep" : score >= 2 ? "standard" : "quick",
    reasons,
  };
}

function escalationDecision(
  tier: ResearchEffortTier,
  nextTier: ResearchEffortTier,
  constraints: ResearchEffortConstraints,
  unresolved: ResearchProgressDecision["unresolved"],
): ResearchProgressDecision {
  return {
    action: "escalate",
    tier,
    nextTier,
    budget: resolveResearchEffortBudget(nextTier, constraints),
    reason: "tier_budget_nearly_spent",
    startNewSegment: false,
    unresolved,
  };
}

function stopDecision(
  tier: ResearchEffortTier,
  budget: ResearchEffortBudget,
  reason: ResearchProgressStopReason,
  unresolved: ResearchProgressDecision["unresolved"],
): ResearchProgressDecision {
  return {
    action: "stop",
    tier,
    budget,
    reason,
    startNewSegment: false,
    unresolved,
  };
}

function findReachedExplicitCap(
  usage: ResearchEffortUsage,
  constraints: ResearchEffortConstraints,
): ResearchProgressStopReason | undefined {
  if (
    constraints.maxDurationMs !== undefined &&
    usage.elapsedMs >= nonNegativeFinite(constraints.maxDurationMs)
  ) {
    return "duration_cap_reached";
  }
  if (
    constraints.maxModelSteps !== undefined &&
    usage.modelSteps >= nonNegativeInteger(constraints.maxModelSteps)
  ) {
    return "model_step_cap_reached";
  }
  if (
    constraints.maxToolCalls !== undefined &&
    usage.toolCalls >= nonNegativeInteger(constraints.maxToolCalls)
  ) {
    return "tool_call_cap_reached";
  }
  if (
    constraints.maxSegments !== undefined &&
    nonNegativeInteger(constraints.maxSegments) === 0
  ) {
    return "segment_cap_reached";
  }
  return undefined;
}

function nextAllowedTier(
  tier: ResearchEffortTier,
  maxTier: ResearchEffortTier | undefined,
): ResearchEffortTier | undefined {
  const index = RESEARCH_EFFORT_TIER_ORDER.indexOf(tier);
  const next = RESEARCH_EFFORT_TIER_ORDER[index + 1];
  if (!next) return undefined;
  return maxTier && tierIndex(next) > tierIndex(maxTier) ? undefined : next;
}

function clampTier(
  tier: ResearchEffortTier,
  maxTier: ResearchEffortTier | undefined,
): ResearchEffortTier {
  if (!maxTier || tierIndex(tier) <= tierIndex(maxTier)) return tier;
  return maxTier;
}

function tierIndex(tier: ResearchEffortTier): number {
  return RESEARCH_EFFORT_TIER_ORDER.indexOf(tier);
}

function normalizeUsage(usage: ResearchEffortUsage): ResearchEffortUsage {
  return {
    modelSteps: nonNegativeInteger(usage.modelSteps),
    toolCalls: nonNegativeInteger(usage.toolCalls),
    segmentsStarted: nonNegativeInteger(usage.segmentsStarted),
    ...(usage.modelStepsInCurrentSegment === undefined
      ? {}
      : {
          modelStepsInCurrentSegment: nonNegativeInteger(
            usage.modelStepsInCurrentSegment,
          ),
        }),
    ...(usage.toolCallsInCurrentSegment === undefined
      ? {}
      : {
          toolCallsInCurrentSegment: nonNegativeInteger(
            usage.toolCallsInCurrentSegment,
          ),
        }),
    ...(usage.completionSegmentsStarted === undefined
      ? {}
      : {
          completionSegmentsStarted: nonNegativeInteger(
            usage.completionSegmentsStarted,
          ),
        }),
    elapsedMs: nonNegativeFinite(usage.elapsedMs),
  };
}

function count(value: number | readonly unknown[]): number {
  return Array.isArray(value)
    ? value.length
    : nonNegativeInteger(value as number);
}

function fraction(used: number, limit: number): number {
  if (limit <= 0) return 1;
  return used / limit;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function capNonNegativeInteger(base: number, cap: number | undefined): number {
  if (cap === undefined) return base;
  return Math.min(base, nonNegativeInteger(cap));
}

function capNullableDuration(
  base: number | null,
  cap: number | undefined,
): number | null {
  if (cap === undefined) return base;
  const normalized = nonNegativeFinite(cap);
  return base === null ? normalized : Math.min(base, normalized);
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function nonNegativeFinite(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function hasNumericConstraint(constraints: ResearchEffortConstraints): boolean {
  return (
    constraints.maxModelSteps !== undefined ||
    constraints.maxToolCalls !== undefined ||
    constraints.maxSegments !== undefined ||
    constraints.maxDurationMs !== undefined
  );
}
