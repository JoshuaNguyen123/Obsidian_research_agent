/**
 * Closed-loop context-budget calibration (G1 scaffolding).
 *
 * Today the run context budget is derived once from a fixed assumption:
 * `createRunContextBudget` in runContext.ts multiplies the model's context
 * window by CHARS_PER_TOKEN_ESTIMATE (4) and never revisits it, while
 * `shouldCompactLoopMessages` triggers compaction off raw character counts.
 *
 * Meanwhile `createObservableModelClient` already extracts ground-truth token
 * counts from every provider response (Ollama `prompt_eval_count`,
 * OpenAI-compatible `usage.prompt_tokens`) and stores them on
 * `missionLedger.providerUsage`, where nothing reads them. This module closes
 * that loop: it turns the measured (chars, tokens) pairs into a calibrated
 * chars-per-token ratio and re-derives the character ceiling from it.
 *
 * Why it matters: chars-per-token is not a constant. Dense JSON tool payloads
 * and source code run roughly 2.2-2.8 chars/token; English prose runs 4.5-6.
 * A tool-result-heavy run therefore under-estimates its real token usage under
 * the fixed 4.0 assumption, so compaction fires too late and the provider
 * truncates mid-run. A prose-heavy run over-estimates and compacts early,
 * discarding evidence the mission still needs. Both failures are silent today.
 *
 * Safety posture: this can only ever be as aggressive as the evidence. Until
 * MIN_SAMPLES_FOR_CALIBRATION reported samples arrive the default 4.0 holds
 * exactly, unreported usage contributes no sample at all, and the learned ratio
 * is clamped to [MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN]. A provider that
 * never reports usage keeps today's behavior byte for byte.
 *
 * ## Public API (wire-up seam, not yet called from AgentRunner)
 *
 * 1. Create `createContextCalibration()` alongside the run's `RunContextBudget`
 *    (AgentRunner.ts, near the `createRunContextBudget` call site).
 * 2. In the `onEvidence` callback already passed to
 *    `createObservableModelClient`, fold each `ModelCallEvidenceV1` in with
 *    `observeModelCallEvidence(state, evidence, promptChars)`, where
 *    `promptChars` is the `estimatePromptChars(messages)` value for the request
 *    that produced it.
 * 3. Replace `budget.maxPromptChars` reads in the compaction check with
 *    `calibratedMaxPromptChars(budget, state)`.
 *
 * Nothing here performs I/O; the state is a plain serializable record so it can
 * ride along in the durable ledger without a schema migration.
 */

import type { RunContextBudget } from "./runContext";
import { CHARS_PER_TOKEN_ESTIMATE } from "./runContext";

/** Reported samples required before a measured ratio may displace the default. */
export const MIN_SAMPLES_FOR_CALIBRATION = 3;
/** Observed floor: dense JSON/base64 payloads. Below this we distrust the sample. */
export const MIN_CHARS_PER_TOKEN = 2;
/** Observed ceiling: whitespace-heavy prose and CJK-free markdown. */
export const MAX_CHARS_PER_TOKEN = 6;
/** Weight given to the newest sample. Low enough that one outlier cannot swing a run. */
export const CALIBRATION_SMOOTHING = 0.3;

export interface ContextCalibrationV1 {
  schemaVersion: 1;
  /** Count of accepted (reported, non-degenerate) samples. */
  samples: number;
  /** Exponentially smoothed chars-per-token, clamped to the observed band. */
  charsPerToken: number;
  /** False until `samples >= MIN_SAMPLES_FOR_CALIBRATION`. */
  calibrated: boolean;
}

/** One measured prompt: characters we sent, tokens the provider counted. */
export interface ContextCalibrationSample {
  promptChars: number;
  promptTokens: number;
  tokenUsageReported: boolean;
}

export interface CalibratedPromptBudget {
  maxPromptChars: number;
  /** Where the ceiling came from, for Run Details parity with `budgetSource`. */
  source: "assumed_ratio" | "calibrated_ratio";
  charsPerToken: number;
  /** maxPromptChars − the uncalibrated ceiling. Negative means we tightened. */
  deltaChars: number;
}

export function createContextCalibration(): ContextCalibrationV1 {
  return {
    schemaVersion: 1,
    samples: 0,
    charsPerToken: CHARS_PER_TOKEN_ESTIMATE,
    calibrated: false,
  };
}

/**
 * Fold one measurement into the calibration state.
 *
 * Samples are rejected — leaving the state byte-identical — when the provider
 * did not report usage, when either side is not a positive finite number, or
 * when the implied ratio lands outside the plausible band. A rejected sample is
 * not an error: it is the fail-safe that preserves today's behavior.
 */
export function observeModelCall(
  state: ContextCalibrationV1,
  sample: ContextCalibrationSample,
): ContextCalibrationV1 {
  if (!sample.tokenUsageReported) {
    return state;
  }
  if (!isPositiveFinite(sample.promptChars) || !isPositiveFinite(sample.promptTokens)) {
    return state;
  }

  const observedRatio = sample.promptChars / sample.promptTokens;
  if (
    !Number.isFinite(observedRatio) ||
    observedRatio < MIN_CHARS_PER_TOKEN ||
    observedRatio > MAX_CHARS_PER_TOKEN
  ) {
    // Out-of-band ratios mean the char count and the token count describe
    // different payloads (a mismatched pairing, or a provider counting images).
    // Dropping them is safer than smoothing a wrong number into the budget.
    return state;
  }

  const samples = state.samples + 1;
  // The first accepted sample seeds the average outright; smoothing an EWMA
  // against the 4.0 placeholder would bias every later reading toward it.
  const blended =
    state.samples === 0
      ? observedRatio
      : state.charsPerToken +
        CALIBRATION_SMOOTHING * (observedRatio - state.charsPerToken);

  return {
    schemaVersion: 1,
    samples,
    charsPerToken: clampRatio(blended),
    calibrated: samples >= MIN_SAMPLES_FOR_CALIBRATION,
  };
}

/**
 * Fold in a `ModelCallEvidenceV1`-shaped record. The evidence already carries
 * `promptTokens` and `tokenUsageReported`; only the character count of the
 * request that produced it has to be supplied by the caller.
 */
export function observeModelCallEvidence(
  state: ContextCalibrationV1,
  evidence: {
    promptTokens: number;
    tokenUsageReported: boolean;
    outcome: "success" | "error" | "budget_exhausted";
  },
  promptChars: number,
): ContextCalibrationV1 {
  // A failed call's token count describes a prompt the provider may have
  // rejected before fully reading. It is not evidence about our encoding.
  if (evidence.outcome !== "success") {
    return state;
  }
  return observeModelCall(state, {
    promptChars,
    promptTokens: evidence.promptTokens,
    tokenUsageReported: evidence.tokenUsageReported,
  });
}

/**
 * Re-derive the prompt character ceiling from measured evidence.
 *
 * Returns the untouched `budget.maxPromptChars` until the state is calibrated,
 * so callers can adopt this unconditionally without changing behavior on the
 * first calls of a run or against providers that never report usage.
 */
export function calibratedMaxPromptChars(
  budget: RunContextBudget,
  state: ContextCalibrationV1,
): CalibratedPromptBudget {
  const assumed = Math.max(0, Math.floor(budget.maxPromptChars));
  if (!state.calibrated) {
    return {
      maxPromptChars: assumed,
      source: "assumed_ratio",
      charsPerToken: CHARS_PER_TOKEN_ESTIMATE,
      deltaChars: 0,
    };
  }

  // maxPromptChars was built as usableTokens * 4. Recover the token figure the
  // budget was actually reasoning about, then re-price it at the measured rate
  // rather than re-deriving from numCtx, which may be null.
  const usableTokens = assumed / CHARS_PER_TOKEN_ESTIMATE;
  const maxPromptChars = Math.max(
    0,
    Math.floor(usableTokens * state.charsPerToken),
  );

  return {
    maxPromptChars,
    source: "calibrated_ratio",
    charsPerToken: state.charsPerToken,
    deltaChars: maxPromptChars - assumed,
  };
}

/** One-line Run Details projection. Never includes prompt content. */
export function formatContextCalibrationForRunDetails(
  state: ContextCalibrationV1,
  budget: RunContextBudget,
): string {
  const resolved = calibratedMaxPromptChars(budget, state);
  if (!state.calibrated) {
    return `context_calibration=pending samples=${state.samples}/${MIN_SAMPLES_FOR_CALIBRATION} chars_per_token=${CHARS_PER_TOKEN_ESTIMATE.toFixed(2)} (assumed)`;
  }
  const direction = resolved.deltaChars < 0 ? "tightened" : "widened";
  return `context_calibration=active samples=${state.samples} chars_per_token=${state.charsPerToken.toFixed(2)} max_prompt_chars=${resolved.maxPromptChars} (${direction} ${Math.abs(resolved.deltaChars)})`;
}

function clampRatio(value: number): number {
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, value));
}

function isPositiveFinite(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
