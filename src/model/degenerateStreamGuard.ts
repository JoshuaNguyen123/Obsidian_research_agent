/**
 * ONE authority for "the model's output is not real work", in the two shapes
 * that have actually burned budget in this product.
 *
 * 1. DEGENERATE STREAM (repetitive). The tail of the output is one short unit
 *    repeated without interruption for thousands of characters. Observed live
 *    (2026-08-25, deepseek-v4-pro): mid-mission the model fell into an
 *    unbounded "000000..." emission. Nothing stopped it — the stream burned
 *    provider budget and wall clock until the reader killed the run by hand.
 *    A stream whose last ~3k characters are a pure cycle of length <= 24 is
 *    never a real answer, a real tool call, or real markdown; cutting it off
 *    converts an unbounded hang into an ordinary retryable model error.
 *
 *    That detector is deliberately conservative and cheap: it keeps only a
 *    bounded tail, re-checks at most once per CHECK_STRIDE new characters, and
 *    trips only when the ENTIRE window is periodic — long runs embedded in
 *    otherwise-progressing output never fire, because fresh non-cyclic text
 *    keeps entering the window.
 *
 * 2. UNPRODUCTIVE RESPONSE (empty). The provider call SUCCEEDS and returns a
 *    well-formed response that carries nothing the mission can use: no tool
 *    call, no prose. Observed live (proof-matrix interrupted-continuation,
 *    2026-08-26): `tool_calls=none; content_chars=0` repeated to the step cap,
 *    providerUsage 11/11 successful, run ended `stopReason: "error"` with the
 *    owed write unpaid. The host kept paying for steps because nothing counted
 *    "the model produced no work" as a fact.
 *
 * These are opposite symptoms (too much vs nothing) of the same question, and
 * this repo's recurring deadlock bugs all come from two subsystems answering
 * one question separately. So they answer it here, together, in one
 * vocabulary. They differ only in WHERE the verdict is consumed, and that
 * difference is forced by the failure, not by taste:
 *
 * - The repetition verdict is a STREAM property, so `parseOllamaChatStream`
 *   consumes it mid-stream and throws — that is the only place that can stop
 *   an unbounded emission before it finishes.
 * - The emptiness verdict is a WHOLE-RESPONSE property, and one empty reply is
 *   not a failure (the step loop already grants an empty forced final exactly
 *   one reserved retry). Only a RUN of them is. It is therefore returned as
 *   data — never thrown — and the agent loop, which is the only seat that can
 *   see consecutive steps and the remaining budget, decides what to do.
 */

import type { ModelChatMessage, ModelChatRequest } from "./types";
import { measureAssistantPayloadChars } from "./modelCallEvidence";

/** The window that must be wholly periodic before the stream is condemned. */
const DEGENERATE_WINDOW_CHARS = 3_000;
/** Longest repeating unit considered degenerate ("0", " .", "let me look"…). */
const MAX_CYCLE_CHARS = 24;
/** Re-check cadence: at most one periodicity scan per this many new chars. */
const CHECK_STRIDE_CHARS = 256;
/** Bounded tail retention (>= window; extra slack avoids resize churn). */
const TAIL_RETAIN_CHARS = 4_096;

export interface DegenerateStreamVerdict {
  unit: string;
  windowChars: number;
}

export interface DegenerateStreamDetector {
  /** Feed one streamed delta (thinking or content); returns a verdict once
   * the tail window degenerates, and keeps returning it thereafter. */
  feed(delta: string): DegenerateStreamVerdict | null;
}

export function createDegenerateStreamDetector(): DegenerateStreamDetector {
  let tail = "";
  let sinceLastCheck = 0;
  let verdict: DegenerateStreamVerdict | null = null;
  return {
    feed(delta: string): DegenerateStreamVerdict | null {
      if (verdict) return verdict;
      if (!delta) return null;
      tail += delta;
      if (tail.length > TAIL_RETAIN_CHARS) {
        tail = tail.slice(tail.length - TAIL_RETAIN_CHARS);
      }
      sinceLastCheck += delta.length;
      if (sinceLastCheck < CHECK_STRIDE_CHARS || tail.length < DEGENERATE_WINDOW_CHARS) {
        return null;
      }
      sinceLastCheck = 0;
      const window = tail.slice(tail.length - DEGENERATE_WINDOW_CHARS);
      const unit = findFullWindowCycle(window);
      if (unit !== null) {
        verdict = { unit, windowChars: DEGENERATE_WINDOW_CHARS };
      }
      return verdict;
    },
  };
}

/**
 * The verdict carried by a thrown degenerate-stream error, or null. Read
 * structurally (an instance check would tie the runner to one bundle copy of
 * the error class): category invalid_response with the detector's details.
 */
export function degenerateStreamVerdictFromError(
  error: unknown,
): DegenerateStreamVerdict | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { name?: unknown; category?: unknown; details?: unknown };
  if (record.name !== "ModelClientError" || record.category !== "invalid_response") {
    return null;
  }
  const details = record.details;
  if (!details || typeof details !== "object") return null;
  const { unit, windowChars } = details as { unit?: unknown; windowChars?: unknown };
  if (typeof unit !== "string" || unit.length === 0) return null;
  if (typeof windowChars !== "number" || !Number.isFinite(windowChars)) return null;
  return { unit, windowChars };
}

/**
 * The request to send INSTEAD of repeating one whose reply collapsed. A
 * degenerate stream is an `invalid_response`, which the retry policy treats as
 * a malformed provider body and retries once, and until reliability cohort 12
 * (2026-09-07) that retry was the identical request: the final synthesis of a
 * compound mission collapsed into "\\nak" after thirty minutes, the identical
 * retry collapsed into ".3" within seconds, and the mission stopped. The retry
 * now differs in every way the provider can see: a system nudge naming the
 * collapse, thinking off (a long reasoning stream is where a loop starts), a
 * repetition penalty, and a fresh sampling seed. The original request object
 * is never mutated.
 */
export function retryRequestAfterDegenerateStreamV1(
  request: ModelChatRequest,
  verdict: DegenerateStreamVerdict,
  seed: number = freshSeed(),
): ModelChatRequest {
  const shown = verdict.unit.length > 16 ? `${verdict.unit.slice(0, 16)}…` : verdict.unit;
  const nudge: ModelChatMessage = {
    role: "system",
    content:
      `Your previous reply to this exact request collapsed into repeating ${JSON.stringify(shown)} ` +
      `for ${verdict.windowChars} characters and was discarded before anything was saved. ` +
      "Write the reply once, in plain prose, without repeated lines, characters, or list markers, " +
      "and stop as soon as it is complete.",
  };
  return {
    ...request,
    messages: [...request.messages, nudge],
    think: undefined,
    options: { ...(request.options ?? {}), repeat_penalty: 1.15, seed },
    evidencePhase: "retry",
  };
}

function freshSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** Human-readable message for the thrown ModelClientError; the runner's
 * message-based sub-classification (cf. isOffTopicModelOutputError) can key
 * on "degenerate stream". */
export function formatDegenerateStreamMessage(
  verdict: DegenerateStreamVerdict,
): string {
  const shown = verdict.unit.length > 16 ? `${verdict.unit.slice(0, 16)}…` : verdict.unit;
  return (
    `Model output collapsed into a degenerate stream: the last ${verdict.windowChars} ` +
    `characters repeat the unit ${JSON.stringify(shown)} without interruption. ` +
    "The stream was cut off instead of letting it run unbounded."
  );
}

/**
 * Returns the smallest repeating unit (length <= MAX_CYCLE_CHARS) that the
 * whole window consists of, or null. The final repetition may be partial
 * (the stream was cut mid-unit).
 */
function findFullWindowCycle(window: string): string | null {
  for (let period = 1; period <= MAX_CYCLE_CHARS; period += 1) {
    let periodic = true;
    for (let i = period; i < window.length; i += 1) {
      if (window[i] !== window[i - period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) {
      return window.slice(0, period);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shape 2: the unproductive (empty) response
// ---------------------------------------------------------------------------

/**
 * How a response failed to carry work.
 *
 * `empty_response`   — the provider returned literally nothing usable:
 *                      no tool call, no renderable prose, no thinking.
 * `thinking_only`    — the model deliberated and delivered nothing: thinking
 *                      chars exist, but no tool call and no renderable prose.
 *                      Still zero work for the mission, and it costs a full
 *                      step, so it counts — but it is recorded under its own
 *                      name because the remedy differs (a thinking model that
 *                      never emits is a `think` / tool_choice problem, not a
 *                      dead provider).
 */
export type UnproductiveModelResponseKindV1 =
  | "empty_response"
  | "thinking_only";

export interface UnproductiveModelResponseVerdictV1 {
  kind: UnproductiveModelResponseKindV1;
  /** `measureAssistantPayloadChars` for this response (content+thinking+tool calls). */
  payloadChars: number;
  contentChars: number;
  thinkingChars: number;
  toolCallCount: number;
}

/**
 * Returns a verdict when this ONE response carried no work, else null.
 *
 * EMPTINESS IS NOT `content.length === 0`. A pure tool-call reply has an empty
 * `content` and is the single most productive thing the model can do; the
 * `measureAssistantPayloadChars` helper exists precisely because measuring raw
 * content length recorded those successes as 0 chars. This predicate therefore
 * checks tool calls FIRST and returns null unconditionally when any are
 * present, before it looks at a single character. Callers must pass the tool
 * calls the host will actually execute — including any recovered from text —
 * or the guarantee does not hold.
 */
export function classifyUnproductiveModelResponseV1(response: {
  message: { content: string; thinking?: string; role?: string };
  toolCalls?: readonly unknown[];
}): UnproductiveModelResponseVerdictV1 | null {
  const toolCallCount = response.toolCalls?.length ?? 0;
  // Hard guarantee: a tool-call-carrying reply is real work, full stop.
  if (toolCallCount > 0) return null;
  const content = response.message.content ?? "";
  // Prose the reader can see is real work even without a tool call; whether it
  // ADVANCES the mission is the loop's separate question, already answered by
  // the no-tool ladder. Whitespace is not prose.
  if (content.trim().length > 0) return null;
  const thinkingChars = response.message.thinking?.length ?? 0;
  return {
    kind: thinkingChars > 0 ? "thinking_only" : "empty_response",
    payloadChars: measureAssistantPayloadChars(response),
    contentChars: content.length,
    thinkingChars,
    toolCallCount: 0,
  };
}

/**
 * Consecutive unproductive responses tolerated before the run stops.
 *
 * Three, not two. One empty reply is provider noise. Two is still inside an
 * existing, deliberate seat: the step loop grants an empty forced final answer
 * exactly one reserved corrective retry, so a legitimate recovery attempt
 * spends the second. The third consecutive nothing is the first one that
 * carries no host hypothesis at all, and every step after it is pure burn.
 */
export const UNPRODUCTIVE_MODEL_RESPONSE_STOP_THRESHOLD_V1 = 3;

/**
 * `AgentRunMetricEvent.name` for the per-step streak metric, so the emitter
 * and any gate that reads it share one string. The event carries the streak
 * on `AgentRunMetricEvent.unproductiveStreak`; `durationMs` is 0 because this
 * is a count, not a timing.
 */
export const UNPRODUCTIVE_MODEL_RESPONSE_METRIC_NAME_V1 =
  "unproductive_model_responses";

/**
 * The emitted metric behind the stop. Shipped as a typed record rather than a
 * prose trace line so a gate can consume the number without parsing English.
 */
export interface UnproductiveModelResponseMetricV1 {
  schemaVersion: 1;
  metric: "consecutive_unproductive_model_responses";
  kind: UnproductiveModelResponseKindV1;
  /** Consecutive unproductive responses ending at this step. The gated value. */
  consecutive: number;
  /** Unproductive responses so far in this run segment. */
  total: number;
  /** Model responses observed so far in this run segment (the denominator). */
  observed: number;
  /** `measureAssistantPayloadChars` for the response that tripped this record. */
  payloadChars: number;
  /** 1-based step index this response answered. */
  step: number;
  /** Steps still budgeted after this one — the burn a stop prevents. */
  remainingSteps: number;
  /** True once `consecutive` reached the stop threshold. */
  atStopThreshold: boolean;
}

export function buildUnproductiveModelResponseMetricV1(input: {
  verdict: UnproductiveModelResponseVerdictV1;
  consecutive: number;
  total: number;
  observed: number;
  step: number;
  stepLimit: number;
}): UnproductiveModelResponseMetricV1 {
  return {
    schemaVersion: 1,
    metric: "consecutive_unproductive_model_responses",
    kind: input.verdict.kind,
    consecutive: input.consecutive,
    total: input.total,
    observed: input.observed,
    payloadChars: input.verdict.payloadChars,
    step: input.step,
    remainingSteps: Math.max(0, input.stepLimit - input.step),
    atStopThreshold:
      input.consecutive >= UNPRODUCTIVE_MODEL_RESPONSE_STOP_THRESHOLD_V1,
  };
}

/**
 * The terminal the reader gets instead of a silent burn to the step cap. It
 * says what happened, that nothing was written, and that the run is resumable
 * — an honest terminal, not a diagnosis of the model's intent.
 */
export function formatUnproductiveModelResponseMessage(
  metric: UnproductiveModelResponseMetricV1,
): string {
  const shape =
    metric.kind === "thinking_only"
      ? "produced only internal reasoning and delivered no tool call or answer"
      : "returned nothing at all — no tool call and no answer text";
  return (
    `Stopped: the model ${shape} on ${metric.consecutive} consecutive steps ` +
    `(step ${metric.step}). Continuing would have spent ${metric.remainingSteps} ` +
    "more budgeted step(s) re-asking a model that is not answering. " +
    "Nothing was written. Retry, or continue the mission with a different model."
  );
}
