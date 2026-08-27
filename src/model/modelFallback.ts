/**
 * Minimal primary→specialist model fallback after retries are exhausted.
 * Default ON. Distinct from per-phase specialist routing.
 *
 * Eligibility below is deliberately provider-side only — timeout, network
 * drop, or a 5xx — so the substitution can never be a quality decision. Auth,
 * rate limit, budget exhaustion, and anything the model merely did badly are
 * refused, because reissuing those on a second model would trade the answer
 * the user configured for a different one without asking.
 */

import type { MissionEvidence } from "../agent/missionLedger";
import { isModelRequestTimeoutError } from "./retry";
import { ModelClientError } from "./types";

export interface ModelFallbackSlotIdentity {
  model: string;
  provider: string;
  baseUrl: string;
}

export type ModelFallbackSkipReason =
  | "flag_off"
  | "already_used"
  | "specialist_unavailable"
  | "specialist_not_distinct"
  | "ineligible_failure";

export type ModelFallbackResult<T> =
  | { status: "skipped"; reason: ModelFallbackSkipReason }
  | { status: "used"; value: T; evidence: MissionEvidence }
  | { status: "failed"; error: unknown; evidence: MissionEvidence };

export function isModelFallbackEnabled(settings: unknown): boolean {
  return (
    (settings as { modelFallbackEnabled?: boolean } | null | undefined)
      ?.modelFallbackEnabled === true
  );
}

export function specialistIsDistinctFromPrimary(
  primary: ModelFallbackSlotIdentity,
  specialist: ModelFallbackSlotIdentity,
): boolean {
  const primaryModel = primary.model.trim();
  const specialistModel = specialist.model.trim();
  if (!primaryModel || !specialistModel) return false;
  return (
    primaryModel !== specialistModel ||
    primary.provider !== specialist.provider ||
    primary.baseUrl.trim() !== specialist.baseUrl.trim()
  );
}

export function isEligibleModelFallbackFailure(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const shape = readErrorShape(error);
  if (!shape) return false;
  if (
    shape.category === "auth" ||
    shape.category === "missing_api_key" ||
    shape.category === "provider_budget_exhausted" ||
    shape.category === "rate_limit"
  ) {
    return false;
  }
  if (shape.status === 401 || shape.status === 403) {
    return false;
  }
  if (isModelRequestTimeoutError(error)) {
    return true;
  }
  if (shape.category === "network") {
    return true;
  }
  return shape.category === "api" && (shape.status ?? 0) >= 500;
}

export function classifyModelFallback(input: {
  enabled: boolean;
  alreadyUsed: boolean;
  specialistAvailable: boolean;
  primary: ModelFallbackSlotIdentity;
  specialist: ModelFallbackSlotIdentity;
  error: unknown;
}):
  | { fallback: true; reason: "eligible" }
  | { fallback: false; reason: ModelFallbackSkipReason } {
  if (!input.enabled) return { fallback: false, reason: "flag_off" };
  if (input.alreadyUsed) return { fallback: false, reason: "already_used" };
  if (!input.specialistAvailable) {
    return { fallback: false, reason: "specialist_unavailable" };
  }
  if (!specialistIsDistinctFromPrimary(input.primary, input.specialist)) {
    return { fallback: false, reason: "specialist_not_distinct" };
  }
  if (!isEligibleModelFallbackFailure(input.error)) {
    return { fallback: false, reason: "ineligible_failure" };
  }
  return { fallback: true, reason: "eligible" };
}

export function createModelFallbackEvidence(input: {
  primaryModel: string;
  specialistModel: string;
}): MissionEvidence {
  const primaryModel = input.primaryModel.trim() || "unknown";
  const specialistModel = input.specialistModel.trim() || "unknown";
  return {
    id: "model_fallback_used",
    kind: "tool_result",
    title: "model_fallback_used",
    summary: `Fell back from ${primaryModel} to ${specialistModel}.`,
    confidence: "high",
  };
}

/**
 * Classify then reissue at most once. Callers must pass alreadyUsed=true after
 * a prior used/failed attempt for the same model call.
 */
export async function runModelFallbackOnce<T>(input: {
  enabled: boolean;
  alreadyUsed: boolean;
  specialistAvailable: boolean;
  primary: ModelFallbackSlotIdentity;
  specialist: ModelFallbackSlotIdentity;
  error: unknown;
  reissue: () => Promise<T>;
}): Promise<ModelFallbackResult<T>> {
  const decision = classifyModelFallback(input);
  if (!decision.fallback) {
    return { status: "skipped", reason: decision.reason };
  }
  const evidence = createModelFallbackEvidence({
    primaryModel: input.primary.model,
    specialistModel: input.specialist.model,
  });
  try {
    const value = await input.reissue();
    return { status: "used", value, evidence };
  } catch (error) {
    return { status: "failed", error, evidence };
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return error instanceof Error && error.name === "AbortError";
}

function readErrorShape(
  error: unknown,
): { category?: string; status?: number; message: string } | null {
  if (error instanceof ModelClientError) {
    return {
      category: error.category,
      status: error.status,
      message: error.message,
    };
  }
  if (!isRecord(error) || error.name !== "ModelClientError") {
    return null;
  }
  return {
    category: typeof error.category === "string" ? error.category : undefined,
    status: typeof error.status === "number" ? error.status : undefined,
    message: typeof error.message === "string" ? error.message : "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
