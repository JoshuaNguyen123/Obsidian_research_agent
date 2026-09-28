import type { HttpRequest, HttpResponse, HttpTransport } from "../model/types";
import { fingerprintCanonicalJson } from "../agent/queue/fingerprint";

/**
 * A bounded judgment service, separate from chat generation.
 *
 * The decision model answers closed questions — a choice among named
 * criteria, or a yes/no ("noul") probability — about a piece of state. It never
 * plans, writes, or requests tools; the existing models keep doing that. Every
 * caller treats an answer as advisory evidence that the host may act on only
 * when it is clear, and falls back to its existing deterministic or
 * utility-model path otherwise.
 *
 * Contract: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request
 */

/** The pinned model. `latest` moves under calibrated thresholds; a pin does not. */
export const JEV_DECISION_MODEL_V1 = "typesafe/jev-1.13";
export const JEV_DECISION_ENDPOINT_V1 = "https://openrouter.ai/api/alpha/decisions";

/** Classification sits in front of planning, so it must be quick or absent. */
export const DECISION_CLASSIFICATION_TIMEOUT_MS_V1 = 2_000;
/** Claim verification runs once per staged draft batch. */
export const DECISION_VERIFICATION_TIMEOUT_MS_V1 = 5_000;

/** Bounded input: a request over any of these is refused locally, never sent. */
export const DECISION_LIMITS_V1 = Object.freeze({
  maxStateChars: 32_000,
  maxQuestions: 16,
  maxCriteriaPerQuestion: 8,
  maxInstructionChars: 2_000,
  maxCriterionChars: 400,
  maxQuestionNameChars: 64,
});

export type DecisionPurposeV1 =
  | "mission_assessment"
  | "claim_support";

export interface DecisionChoiceQuestionV1 {
  type: "choice";
  instructions: string;
  /** Criterion key -> description. Keys are the only valid answers. */
  criteria: Record<string, string>;
}

export interface DecisionNoulQuestionV1 {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export type DecisionQuestionV1 = DecisionChoiceQuestionV1 | DecisionNoulQuestionV1;

export interface DecisionRequestV1 {
  purpose: DecisionPurposeV1;
  /** Frozen template identity; part of the cache and audit fingerprint. */
  templateVersion: string;
  /** Untrusted data being judged. Plain text or a JSON object. */
  state: string | Record<string, unknown>;
  questions: Record<string, DecisionQuestionV1>;
}

export interface DecisionChoiceAnswerV1 {
  type: "choice";
  choice: string;
  /** Provider-reported confidence, when present. */
  confidence: number | null;
  /** Full distribution over the question's criteria (missing keys are 0). */
  probabilities: Record<string, number> | null;
}

export interface DecisionNoulAnswerV1 {
  type: "noul";
  /** Probability that the "true" criterion holds. */
  noul: number;
}

export type DecisionAnswerV1 = DecisionChoiceAnswerV1 | DecisionNoulAnswerV1;

export interface DecisionUsageV1 {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cost in USD, when reported. Never estimated. */
  cost: number | null;
}

export type DecisionUnavailableReasonV1 =
  | "missing_credential"
  | "input_too_large"
  | "budget_exhausted"
  | "timeout"
  | "network"
  | "auth"
  | "insufficient_credits"
  | "rate_limited"
  | "request_rejected"
  | "provider_unavailable"
  | "invalid_response"
  | "model_mismatch"
  /** Not sent: an earlier call in this run already found the provider unusable. */
  | "skipped_after_failure";

export interface DecisionAnsweredResultV1 {
  status: "answered";
  purpose: DecisionPurposeV1;
  templateVersion: string;
  inputFingerprint: string;
  requestedModel: string;
  /** The provider's versioned model name, e.g. typesafe/jev-1.13-20260917. */
  reportedModel: string;
  responseId: string | null;
  /** Null for a question whose answer was missing or malformed. */
  answers: Record<string, DecisionAnswerV1 | null>;
  /** Question names whose answers failed validation. */
  invalidAnswers: string[];
  usage: DecisionUsageV1 | null;
  durationMs: number;
}

export interface DecisionUnavailableResultV1 {
  status: "unavailable";
  purpose: DecisionPurposeV1;
  templateVersion: string;
  inputFingerprint: string;
  requestedModel: string;
  reason: DecisionUnavailableReasonV1;
  httpStatus: number | null;
  /** Short, credential-free description for Run Details. */
  detail: string;
  durationMs: number;
}

export type DecisionResultV1 = DecisionAnsweredResultV1 | DecisionUnavailableResultV1;

export interface DecisionCallOptionsV1 {
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

export interface DecisionClient {
  readonly model: string;
  readonly endpoint: string;
  /**
   * Submit one request. Never retries. Resolves `unavailable` for every
   * provider, transport, validation, or local-bound failure; throws only an
   * AbortError when the caller cancelled, because cancellation is lifecycle
   * authority rather than decision evidence.
   */
  decide(
    request: DecisionRequestV1,
    options: DecisionCallOptionsV1,
  ): Promise<DecisionResultV1>;
}

export interface OpenRouterDecisionClientOptionsV1 {
  apiKey: string;
  transport: HttpTransport;
  /** Defaults to the OpenRouter alpha endpoint; see {@link resolveDecisionEndpointV1}. */
  endpoint?: string;
  model?: string;
  now?: () => number;
}

export function createOpenRouterDecisionClientV1(
  options: OpenRouterDecisionClientOptionsV1,
): DecisionClient {
  const endpoint = options.endpoint ?? JEV_DECISION_ENDPOINT_V1;
  const model = options.model ?? JEV_DECISION_MODEL_V1;
  const now = options.now ?? (() => Date.now());
  const apiKey = options.apiKey.trim();
  return {
    model,
    endpoint,
    async decide(request, callOptions) {
      const startedAt = now();
      const inputFingerprint = decisionInputFingerprintV1(request, { endpoint, model });
      const unavailable = (
        reason: DecisionUnavailableReasonV1,
        detail: string,
        httpStatus: number | null = null,
      ): DecisionUnavailableResultV1 => ({
        status: "unavailable",
        purpose: request.purpose,
        templateVersion: request.templateVersion,
        inputFingerprint,
        requestedModel: model,
        reason,
        httpStatus,
        detail,
        durationMs: Math.max(0, now() - startedAt),
      });
      throwIfCallerAborted(callOptions.abortSignal);
      if (!apiKey) {
        return unavailable("missing_credential", "No decision-model credential is stored.");
      }
      const bound = checkDecisionRequestBoundsV1(request);
      if (!bound.ok) {
        return unavailable("input_too_large", bound.detail);
      }
      const body = JSON.stringify({
        model,
        state: request.state,
        questions: request.questions,
      });
      const httpRequest: HttpRequest = {
        url: endpoint,
        method: "POST",
        contentType: "application/json",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        throw: false,
        timeoutMs: callOptions.timeoutMs,
        abortSignal: callOptions.abortSignal,
      };
      let response: HttpResponse;
      try {
        response = await raceTimeout(
          options.transport(httpRequest),
          callOptions.timeoutMs,
          callOptions.abortSignal,
        );
      } catch (error) {
        throwIfCallerAborted(callOptions.abortSignal);
        if (error instanceof DecisionTimeoutError || isTimeoutMessage(error)) {
          return unavailable(
            "timeout",
            `No decision within ${callOptions.timeoutMs} ms.`,
          );
        }
        return unavailable("network", "The decision request did not reach the provider.");
      }
      throwIfCallerAborted(callOptions.abortSignal);
      if (response.status < 200 || response.status >= 300) {
        const reason = reasonForHttpStatus(response.status);
        return unavailable(
          reason,
          `The decision provider answered HTTP ${response.status}.`,
          response.status,
        );
      }
      const parsed = parseDecisionResponseV1(readJsonBody(response), request.questions);
      if (!parsed.ok) {
        return unavailable("invalid_response", parsed.detail, response.status);
      }
      if (!reportedModelMatchesPinV1(parsed.reportedModel, model)) {
        return unavailable(
          "model_mismatch",
          `The provider answered with ${parsed.reportedModel}, not the pinned ${model}.`,
          response.status,
        );
      }
      return {
        status: "answered",
        purpose: request.purpose,
        templateVersion: request.templateVersion,
        inputFingerprint,
        requestedModel: model,
        reportedModel: parsed.reportedModel,
        responseId: parsed.responseId,
        answers: parsed.answers,
        invalidAnswers: parsed.invalidAnswers,
        usage: parsed.usage,
        durationMs: Math.max(0, now() - startedAt),
      };
    },
  };
}

/**
 * Exact input + configuration identity. A changed prompt, draft, passage,
 * template, endpoint or model changes the fingerprint and so invalidates any
 * cached decision.
 */
export function decisionInputFingerprintV1(
  request: Pick<DecisionRequestV1, "purpose" | "templateVersion" | "state" | "questions">,
  config: { endpoint: string; model: string },
): string {
  return fingerprintCanonicalJson({
    purpose: request.purpose,
    templateVersion: request.templateVersion,
    state: request.state,
    questions: request.questions,
    endpoint: config.endpoint,
    model: config.model,
  });
}

export function checkDecisionRequestBoundsV1(
  request: Pick<DecisionRequestV1, "state" | "questions">,
): { ok: true } | { ok: false; detail: string } {
  const stateChars =
    typeof request.state === "string"
      ? request.state.length
      : JSON.stringify(request.state).length;
  if (stateChars > DECISION_LIMITS_V1.maxStateChars) {
    return {
      ok: false,
      detail: `State is ${stateChars} characters; the bound is ${DECISION_LIMITS_V1.maxStateChars}.`,
    };
  }
  const names = Object.keys(request.questions);
  if (names.length === 0) {
    return { ok: false, detail: "A decision request needs at least one question." };
  }
  if (names.length > DECISION_LIMITS_V1.maxQuestions) {
    return {
      ok: false,
      detail: `${names.length} questions; the bound is ${DECISION_LIMITS_V1.maxQuestions}.`,
    };
  }
  for (const name of names) {
    const question = request.questions[name]!;
    if (!/^[a-z][a-z0-9_]*$/u.test(name) || name.length > DECISION_LIMITS_V1.maxQuestionNameChars) {
      return { ok: false, detail: `Question name ${JSON.stringify(name)} is not a bounded identifier.` };
    }
    if (question.instructions.length > DECISION_LIMITS_V1.maxInstructionChars) {
      return { ok: false, detail: `Question ${name} instructions exceed the bound.` };
    }
    const criteria = Object.entries(question.criteria);
    if (question.type === "choice" && (criteria.length < 2 || criteria.length > DECISION_LIMITS_V1.maxCriteriaPerQuestion)) {
      return { ok: false, detail: `Question ${name} needs 2 to ${DECISION_LIMITS_V1.maxCriteriaPerQuestion} criteria.` };
    }
    for (const [, description] of criteria) {
      if (description.length > DECISION_LIMITS_V1.maxCriterionChars) {
        return { ok: false, detail: `A criterion of question ${name} exceeds the bound.` };
      }
    }
  }
  return { ok: true };
}

type ParsedDecisionResponseV1 =
  | {
      ok: true;
      reportedModel: string;
      responseId: string | null;
      answers: Record<string, DecisionAnswerV1 | null>;
      invalidAnswers: string[];
      usage: DecisionUsageV1 | null;
    }
  | { ok: false; detail: string };

/** Probabilities are provider-rounded; a distribution off by more is not one. */
const PROBABILITY_SUM_TOLERANCE = 0.05;

/**
 * Runtime validation of an untrusted provider body against the questions that
 * were asked. A malformed individual answer becomes null (unassessed) rather
 * than a guess; a body with no usable answer at all is invalid.
 */
export function parseDecisionResponseV1(
  body: unknown,
  questions: Record<string, DecisionQuestionV1>,
): ParsedDecisionResponseV1 {
  if (!isRecord(body)) {
    return { ok: false, detail: "The decision response is not a JSON object." };
  }
  if (!isRecord(body.answers)) {
    return { ok: false, detail: "The decision response has no answers object." };
  }
  const reportedModel = typeof body.model === "string" ? body.model.trim() : "";
  if (!reportedModel) {
    return { ok: false, detail: "The decision response does not name its model." };
  }
  const answers: Record<string, DecisionAnswerV1 | null> = {};
  const invalidAnswers: string[] = [];
  for (const [name, question] of Object.entries(questions)) {
    const answer = parseAnswer(body.answers[name], question);
    answers[name] = answer;
    if (!answer) invalidAnswers.push(name);
  }
  if (invalidAnswers.length === Object.keys(questions).length) {
    return { ok: false, detail: "No answer in the decision response matched its question." };
  }
  return {
    ok: true,
    reportedModel,
    responseId: typeof body.id === "string" ? body.id.slice(0, 200) : null,
    answers,
    invalidAnswers,
    usage: parseUsage(body.usage),
  };
}

function parseAnswer(value: unknown, question: DecisionQuestionV1): DecisionAnswerV1 | null {
  if (!isRecord(value) || value.type !== question.type) return null;
  if (question.type === "noul") {
    return isProbability(value.noul) ? { type: "noul", noul: value.noul } : null;
  }
  const keys = Object.keys(question.criteria);
  if (typeof value.choice !== "string" || !keys.includes(value.choice)) return null;
  let confidence: number | null = null;
  if (value.confidence !== undefined && value.confidence !== null) {
    if (!isProbability(value.confidence)) return null;
    confidence = value.confidence;
  }
  let probabilities: Record<string, number> | null = null;
  if (value.probabilities !== undefined && value.probabilities !== null) {
    if (!isRecord(value.probabilities)) return null;
    const distribution: Record<string, number> = {};
    let sum = 0;
    for (const key of keys) distribution[key] = 0;
    for (const [key, probability] of Object.entries(value.probabilities)) {
      if (!keys.includes(key) || !isProbability(probability)) return null;
      distribution[key] = probability;
      sum += probability;
    }
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return null;
    // The distribution must agree with the choice it came with; a choice that
    // is not the most probable criterion is an internally inconsistent answer.
    const top = Math.max(...Object.values(distribution));
    if (distribution[value.choice]! + 1e-9 < top) return null;
    probabilities = distribution;
  }
  return { type: "choice", choice: value.choice, confidence, probabilities };
}

function parseUsage(value: unknown): DecisionUsageV1 | null {
  if (!isRecord(value)) return null;
  const inputTokens = nonNegativeInteger(value.input_tokens);
  const outputTokens = nonNegativeInteger(value.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const cost =
    typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0
      ? value.cost
      : null;
  return { inputTokens, outputTokens, cost };
}

/** `typesafe/jev-1.13` accepts `typesafe/jev-1.13` and `typesafe/jev-1.13-20260917`. */
export function reportedModelMatchesPinV1(reported: string, pinned: string): boolean {
  if (reported === pinned) return true;
  return reported.startsWith(`${pinned}-`) && /^\d{6,8}$/u.test(reported.slice(pinned.length + 1));
}

function reasonForHttpStatus(status: number): DecisionUnavailableReasonV1 {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "insufficient_credits";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return "request_rejected";
  }
  return "provider_unavailable";
}

function readJsonBody(response: HttpResponse): unknown {
  try {
    if (response.json !== undefined) return response.json;
  } catch {
    // Obsidian's json getter throws on a non-JSON body; fall through to text.
  }
  if (typeof response.text !== "string") return null;
  try {
    return JSON.parse(response.text);
  } catch {
    return null;
  }
}

class DecisionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Decision request timed out after ${timeoutMs}ms.`);
    this.name = "DecisionTimeoutError";
  }
}

/**
 * The transport receives the timeout too, but a transport that ignores it
 * (Obsidian's requestUrl has no socket timeout) must not hold a mission: the
 * race is the bound the host actually enforces.
 */
function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new DecisionTimeoutError(timeoutMs))),
      Math.max(1, timeoutMs),
    );
    const onAbort = () => finish(() => reject(abortError()));
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function isDecisionAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function isTimeoutMessage(error: unknown): boolean {
  return error instanceof Error && /\btimed out after \d+\s*ms\b/iu.test(error.message);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
