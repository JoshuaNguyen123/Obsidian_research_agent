/**
 * Session-scoped observed model latency, folded into a wall-clock scale factor.
 *
 * The mission wall-clock budgets (orchestrator lead/worker deadlines, effort
 * tiers) were sized for a fast model. A slow provider does the same amount of
 * work in more wall-clock time, so a fixed deadline demotes otherwise healthy
 * runs to budget terminals. This tracker turns per-call `durationMs` evidence
 * into a bounded multiplier for those budgets:
 *
 * - EWMA over successful, non-empty calls only — a timed-out or failed call
 *   measures the timeout configuration, not the model.
 * - Scale is 1 until `LATENCY_MIN_SAMPLES` calls are observed, and clamped to
 *   [1, MAX_LATENCY_SCALE]: fast models never shrink a budget, slow models
 *   never more than double one.
 *
 * Mirrors the closed-loop shape of `src/agent/contextCalibration.ts` (EWMA,
 * smoothing 0.3, min-sample gate). Nothing here performs I/O.
 */

/** Accepted samples required before the measured scale displaces 1. */
export const LATENCY_MIN_SAMPLES = 3;
/** Weight given to the newest sample; one outlier cannot swing a session. */
export const LATENCY_SMOOTHING = 0.3;
/**
 * The per-call latency the existing wall-clock budgets were sized around.
 * Observed averages at or below this leave every deadline unchanged.
 */
export const DEFAULT_EXPECTED_CALL_MS = 15_000;
/** Ceiling so user-configured budgets are never more than doubled. */
export const MAX_LATENCY_SCALE = 2;
/**
 * A failed call that ran at least this long before dying (transport timeout,
 * deadline abort) is itself latency evidence. Success-only observation is
 * timeout-censored: the slowest calls are precisely the ones that never
 * succeed, so a slow model could keep every deadline unscaled forever.
 */
export const LATENCY_FAILURE_FLOOR_MS = 20_000;

export interface ModelLatencySnapshotV1 {
  samples: number;
  /** Exponentially smoothed successful-call duration; null until sampled. */
  ewmaMs: number | null;
  /** The clamped multiplier currently applied to wall-clock budgets. */
  scale: number;
}

export interface ModelLatencyTracker {
  /** Fold one successful-call duration into the average. */
  observe(durationMs: number): void;
  /** Fold a `ModelCallEvidenceV1`-shaped record; rejects failures and empties. */
  observeEvidence(evidence: {
    durationMs: number;
    outcome: string;
    responseChars: number;
  }): void;
  /** Wall-clock multiplier in [1, MAX_LATENCY_SCALE]; 1 until calibrated. */
  getScale(): number;
  snapshot(): ModelLatencySnapshotV1;
}

/** Sanitize a host-supplied scale: non-finite or absent values mean 1. */
export function clampLatencyScale(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_LATENCY_SCALE, Math.max(1, value));
}

export function createModelLatencyTracker(
  options: { expectedCallMs?: number } = {},
): ModelLatencyTracker {
  const expectedCallMs = Math.max(
    1,
    options.expectedCallMs ?? DEFAULT_EXPECTED_CALL_MS,
  );
  let samples = 0;
  let ewmaMs: number | null = null;

  const observe = (durationMs: number): void => {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }
    samples += 1;
    // The first accepted sample seeds the average outright; smoothing against
    // an assumed placeholder would bias every later reading toward it.
    ewmaMs =
      ewmaMs === null
        ? durationMs
        : ewmaMs + LATENCY_SMOOTHING * (durationMs - ewmaMs);
  };

  const getScale = (): number => {
    if (ewmaMs === null || samples < LATENCY_MIN_SAMPLES) {
      return 1;
    }
    return Math.min(MAX_LATENCY_SCALE, Math.max(1, ewmaMs / expectedCallMs));
  };

  return {
    observe,
    observeEvidence: (evidence) => {
      if (evidence.outcome === "success" && evidence.responseChars > 0) {
        observe(evidence.durationMs);
        return;
      }
      // Fast failures (connection refused, auth) say nothing about model
      // speed, but a call that ran a long time before dying does — count it
      // so timeout-censoring cannot keep the scale pinned at 1.
      if (
        evidence.outcome === "error" &&
        evidence.durationMs >= LATENCY_FAILURE_FLOOR_MS
      ) {
        observe(evidence.durationMs);
      }
    },
    getScale,
    snapshot: () => ({ samples, ewmaMs, scale: getScale() }),
  };
}
