import {
  LOW_YIELD_THRESHOLD,
  decideResearchProgress,
  resolveResearchEffortBudget,
  type ResearchEffortBudget,
  type ResearchEffortConstraints,
  type ResearchEffortTier,
  type ResearchEffortUsage,
  type ResearchProgressDecision,
} from "./researchEffortPolicy";

/**
 * Live driver for the adaptive research loop.
 *
 * `decideResearchProgress` in `researchEffortPolicy.ts` is a pure verdict
 * function: given cumulative usage plus the current unresolved/evidence signals
 * it returns continue / stop / escalate. This controller is the thin stateful
 * shell that makes it usable inside a running loop — it accumulates usage across
 * batches, derives the per-batch evidence-yield signal the verdict needs, and
 * applies the tier-escalation and segment-rollover transitions the verdict
 * requests so the caller only has to honour a single boolean: keep going or stop.
 *
 * It owns no timers and does no I/O, so it stays fully deterministic and its
 * snapshot round-trips through `researchPlan.effortUsage` for durable resumes.
 */

/** One unit of observed work between two progress decisions. */
export interface ResearchBatchObservation {
  /** Model turns consumed by this batch. Defaults to 1. */
  modelSteps?: number;
  /** Tool calls executed in this batch. A synthesis-only turn passes 0. */
  toolCalls: number;
  /** Count of *new, distinct* evidence records this batch produced. */
  newEvidenceCount: number;
  /** Active execution time consumed by this batch, in milliseconds. */
  elapsedMs?: number;
}

/** The still-open work the loop must clear before it can finalize. */
export interface ResearchUnresolvedObservation {
  acceptanceGaps: readonly string[];
  remainingQuestions: number | readonly unknown[];
  conflicts: number | readonly unknown[];
}

export interface ResearchProgressSnapshot {
  tier: ResearchEffortTier;
  usage: ResearchEffortUsage;
  consecutiveLowYieldBatches: number;
  /** Evidence yield of the most recent evidence-bearing batch (0..1). */
  lastEvidenceYield: number;
}

export interface ResearchProgressController {
  /**
   * Fold one batch of observed work into cumulative usage, then ask the policy
   * whether to continue. Applies any escalate / start-next-segment transition
   * the policy returns before handing the decision back.
   */
  evaluateBatch(
    observation: ResearchBatchObservation,
    unresolved: ResearchUnresolvedObservation,
  ): ResearchProgressDecision;
  /** The tier currently in force (rises as the loop escalates). */
  getTier(): ResearchEffortTier;
  /** The resolved budget for the current tier under the active constraints. */
  getBudget(): ResearchEffortBudget;
  /** Cumulative usage — a live view suitable for status readouts. */
  getUsage(): ResearchEffortUsage;
  /** Serializable state for durable persistence / resume. */
  snapshot(): ResearchProgressSnapshot;
}

export interface CreateResearchProgressControllerInput {
  tier: ResearchEffortTier;
  /** Explicit user/host ceilings — the generous safety backstop lives here. */
  constraints?: ResearchEffortConstraints;
  /** Restore prior usage when resuming a durable run. */
  usage?: Partial<ResearchEffortUsage>;
  consecutiveLowYieldBatches?: number;
  lastEvidenceYield?: number;
}

export function createResearchProgressController(
  input: CreateResearchProgressControllerInput,
): ResearchProgressController {
  const constraints = input.constraints ?? {};
  let tier = input.tier;
  const usage = normalizeStartingUsage(input.usage);
  let consecutiveLowYieldBatches = nonNegativeInteger(
    input.consecutiveLowYieldBatches ?? 0,
  );
  let lastEvidenceYield = clampUnit(input.lastEvidenceYield ?? 0);

  return {
    evaluateBatch(observation, unresolved) {
      accumulate(usage, observation);

      const batchYield = computeBatchEvidenceYield(observation);
      if (batchYield !== null) {
        lastEvidenceYield = batchYield;
        consecutiveLowYieldBatches =
          batchYield < LOW_YIELD_THRESHOLD
            ? consecutiveLowYieldBatches + 1
            : 0;
      }

      const decision = decideResearchProgress({
        tier,
        usage,
        acceptanceGaps: unresolved.acceptanceGaps,
        remainingQuestions: unresolved.remainingQuestions,
        conflicts: unresolved.conflicts,
        evidenceYield: lastEvidenceYield,
        consecutiveLowYieldBatches,
        constraints,
      });

      if (decision.action === "escalate" && decision.nextTier) {
        tier = decision.nextTier;
      } else if (decision.startNewSegment) {
        usage.segmentsStarted += 1;
        usage.modelStepsInCurrentSegment = 0;
        usage.toolCallsInCurrentSegment = 0;
      }

      return decision;
    },
    getTier() {
      return tier;
    },
    getBudget() {
      return resolveResearchEffortBudget(tier, constraints);
    },
    getUsage() {
      return { ...usage };
    },
    snapshot() {
      return {
        tier,
        usage: { ...usage },
        consecutiveLowYieldBatches,
        lastEvidenceYield,
      };
    },
  };
}

/**
 * Normalized material-new-evidence rate for one batch, or `null` for a
 * synthesis-only turn (no tool calls) which must not move the saturation
 * counter — a run that has simply paused to write should never be mistaken for
 * one that has run dry.
 */
export function computeBatchEvidenceYield(
  observation: ResearchBatchObservation,
): number | null {
  const toolCalls = nonNegativeInteger(observation.toolCalls);
  if (toolCalls <= 0) return null;
  return clampUnit(nonNegativeInteger(observation.newEvidenceCount) / toolCalls);
}

function accumulate(
  usage: ResearchEffortUsage,
  observation: ResearchBatchObservation,
): void {
  const modelSteps = Math.max(1, nonNegativeInteger(observation.modelSteps ?? 1));
  const toolCalls = nonNegativeInteger(observation.toolCalls);
  usage.modelSteps += modelSteps;
  usage.toolCalls += toolCalls;
  usage.modelStepsInCurrentSegment =
    (usage.modelStepsInCurrentSegment ?? 0) + modelSteps;
  usage.toolCallsInCurrentSegment =
    (usage.toolCallsInCurrentSegment ?? 0) + toolCalls;
  usage.elapsedMs += nonNegativeFinite(observation.elapsedMs ?? 0);
}

function normalizeStartingUsage(
  usage: Partial<ResearchEffortUsage> | undefined,
): ResearchEffortUsage {
  return {
    modelSteps: nonNegativeInteger(usage?.modelSteps ?? 0),
    toolCalls: nonNegativeInteger(usage?.toolCalls ?? 0),
    // A live controller is always inside at least its first segment.
    segmentsStarted: Math.max(1, nonNegativeInteger(usage?.segmentsStarted ?? 1)),
    modelStepsInCurrentSegment: nonNegativeInteger(
      usage?.modelStepsInCurrentSegment ?? 0,
    ),
    toolCallsInCurrentSegment: nonNegativeInteger(
      usage?.toolCallsInCurrentSegment ?? 0,
    ),
    ...(usage?.completionSegmentsStarted === undefined
      ? {}
      : {
          completionSegmentsStarted: nonNegativeInteger(
            usage.completionSegmentsStarted,
          ),
        }),
    elapsedMs: nonNegativeFinite(usage?.elapsedMs ?? 0),
  };
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function nonNegativeFinite(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}
