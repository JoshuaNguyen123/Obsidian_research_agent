import type { HttpTransport } from "../model/types";
import type { ObservableModelClient } from "../model/modelCallEvidence";
import {
  createOpenRouterDecisionClientV1,
  decisionInputFingerprintV1,
  isDecisionAbortError,
  type DecisionCallOptionsV1,
  type DecisionClient,
  type DecisionPurposeV1,
  type DecisionRequestV1,
  type DecisionResultV1,
  type DecisionUnavailableReasonV1,
  type DecisionUnavailableResultV1,
} from "./decisionClient";
import {
  normalizeDecisionModelModeV1,
  promotionManifestForSettingsV1,
  resolveDecisionComponentModeV1,
  resolveDecisionEndpointV1,
  type DecisionComponentResolutionV1,
  type DecisionComponentV1,
  type DecisionModelModeV1,
  type DecisionPromotionManifestV1,
} from "./decisionSettings";

/**
 * One decision call as Run Details and the run record see it. Carries no
 * prompt, draft, passage, or credential text: only identities, timings,
 * provider-reported usage, and the outcome.
 */
export interface DecisionCallRecordV1 {
  version: 1;
  id: string;
  component: DecisionComponentV1;
  purpose: DecisionPurposeV1;
  /** The component's effective mode when the call was made. */
  mode: DecisionModelModeV1;
  model: string;
  reportedModel: string | null;
  templateVersion: string;
  inputFingerprint: string;
  outcome: "answered" | "unavailable" | "cache_hit" | "cancelled";
  /** The unavailable reason, when the call did not answer. */
  fallbackReason: DecisionUnavailableReasonV1 | null;
  durationMs: number;
  /** Provider-reported USD cost; null when not reported (never estimated). */
  cost: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  httpStatus: number | null;
  at: string;
}

export interface DecisionRuntimeSettingsV1 {
  decisionModelMode?: unknown;
  decisionApiKey?: string;
  decisionEndpointOverride?: string;
  e2eHarnessAttestationEnabled?: boolean;
  decisionE2EHarnessPromotion?: boolean;
}

export interface DecisionRuntimeV1 {
  readonly configuredMode: DecisionModelModeV1;
  readonly model: string;
  componentMode(component: DecisionComponentV1): DecisionComponentResolutionV1;
  /**
   * Ask once. Null when the component is off. Cached within the run by the
   * exact input fingerprint, so an unchanged prompt/draft/passage set is never
   * asked twice and any change asks again. Throws only an AbortError.
   */
  decide(
    component: DecisionComponentV1,
    request: DecisionRequestV1,
    options: DecisionCallOptionsV1,
  ): Promise<DecisionResultV1 | null>;
  records(): readonly DecisionCallRecordV1[];
}

/** Failures that say the provider is unusable for the rest of this run. */
const RUN_FATAL_REASONS: ReadonlySet<DecisionUnavailableReasonV1> = new Set([
  "missing_credential",
  "auth",
  "insufficient_credits",
  "model_mismatch",
]);
/** Failures that are transient once, but twice in a row stop further calls. */
const TRANSIENT_REASONS: ReadonlySet<DecisionUnavailableReasonV1> = new Set([
  "timeout",
  "network",
  "rate_limited",
  "provider_unavailable",
]);
const MAX_CONSECUTIVE_TRANSIENT_FAILURES = 2;
const MAX_RECORDS_IN_MEMORY = 64;

export function createDecisionRuntimeV1(input: {
  settings: DecisionRuntimeSettingsV1 | null | undefined;
  transport: HttpTransport;
  budget?: Pick<ObservableModelClient, "reserveExternalCall"> | null;
  onRecord?: (record: DecisionCallRecordV1) => void;
  now?: () => Date;
  manifest?: DecisionPromotionManifestV1;
  /** Test seam; production builds the OpenRouter client from settings. */
  client?: DecisionClient;
}): DecisionRuntimeV1 | null {
  const configuredMode = normalizeDecisionModelModeV1(input.settings?.decisionModelMode);
  // Off constructs nothing, so it cannot send anything.
  if (configuredMode === "off") return null;
  const now = input.now ?? (() => new Date());
  const manifest = input.manifest ?? promotionManifestForSettingsV1(input.settings);
  const client =
    input.client ??
    createOpenRouterDecisionClientV1({
      apiKey: input.settings?.decisionApiKey ?? "",
      transport: input.transport,
      endpoint: resolveDecisionEndpointV1(input.settings?.decisionEndpointOverride),
    });
  const cache = new Map<string, Promise<DecisionResultV1>>();
  const records: DecisionCallRecordV1[] = [];
  let sequence = 0;
  // Ids stay unique across the segments of one continued mission, whose
  // records share a run record.
  const segmentTag = now().getTime().toString(36);
  let consecutiveTransientFailures = 0;
  let fatalReason: DecisionUnavailableReasonV1 | null = null;

  const record = (
    component: DecisionComponentV1,
    mode: DecisionModelModeV1,
    request: DecisionRequestV1,
    inputFingerprint: string,
    outcome: DecisionCallRecordV1["outcome"],
    result: DecisionResultV1 | null,
  ) => {
    // A cache hit paid nothing: it carries the answer's identity, not its cost.
    const paid = outcome !== "cache_hit" && result?.status === "answered" ? result : null;
    const entry: DecisionCallRecordV1 = {
      version: 1,
      id: `decision-${segmentTag}-${++sequence}`,
      component,
      purpose: request.purpose,
      mode,
      model: client.model,
      reportedModel: result?.status === "answered" ? result.reportedModel : null,
      templateVersion: request.templateVersion,
      inputFingerprint,
      outcome,
      fallbackReason: result?.status === "unavailable" ? result.reason : null,
      durationMs: outcome === "cache_hit" ? 0 : (result?.durationMs ?? 0),
      cost: paid?.usage?.cost ?? null,
      inputTokens: paid?.usage?.inputTokens ?? null,
      outputTokens: paid?.usage?.outputTokens ?? null,
      httpStatus: result?.status === "unavailable" ? result.httpStatus : null,
      at: now().toISOString(),
    };
    records.push(entry);
    if (records.length > MAX_RECORDS_IN_MEMORY) records.shift();
    try {
      input.onRecord?.(entry);
    } catch {
      // Diagnostics must never change a decision's outcome.
    }
  };

  const skipped = (
    request: DecisionRequestV1,
    inputFingerprint: string,
    reason: DecisionUnavailableReasonV1,
    detail: string,
  ): DecisionUnavailableResultV1 => ({
    status: "unavailable",
    purpose: request.purpose,
    templateVersion: request.templateVersion,
    inputFingerprint,
    requestedModel: client.model,
    reason,
    httpStatus: null,
    detail,
    durationMs: 0,
  });

  return {
    configuredMode,
    model: client.model,
    componentMode: (component) =>
      resolveDecisionComponentModeV1(configuredMode, component, manifest),
    async decide(component, request, options) {
      const resolution = resolveDecisionComponentModeV1(configuredMode, component, manifest);
      if (resolution.effective === "off") return null;
      const mode = resolution.effective;
      const inputFingerprint = decisionInputFingerprintV1(request, {
        endpoint: client.endpoint,
        model: client.model,
      });
      const cached = cache.get(inputFingerprint);
      if (cached) {
        const result = await cached;
        record(component, mode, request, inputFingerprint, "cache_hit", result);
        return result;
      }
      if (fatalReason) {
        const result = skipped(
          request,
          inputFingerprint,
          "skipped_after_failure",
          `Not asked: an earlier decision call in this run failed with ${fatalReason}.`,
        );
        record(component, mode, request, inputFingerprint, "unavailable", result);
        return result;
      }
      const ticket = input.budget?.reserveExternalCall
        ? input.budget.reserveExternalCall({
            phase: "decision",
            model: client.model,
            provider: "openai_compatible",
          })
        : undefined;
      if (ticket === null) {
        const result = skipped(
          request,
          inputFingerprint,
          "budget_exhausted",
          "Not asked: the mission's model-call budget has no room.",
        );
        record(component, mode, request, inputFingerprint, "unavailable", result);
        return result;
      }
      const pending = client.decide(request, options);
      // In-flight dedupe: a second identical ask while the first is pending
      // waits for it instead of paying twice.
      cache.set(inputFingerprint, pending);
      let result: DecisionResultV1;
      try {
        result = await pending;
      } catch (error) {
        cache.delete(inputFingerprint);
        ticket?.settle({
          success: false,
          durationMs: 0,
          promptTokens: null,
          completionTokens: null,
          payloadChars: 0,
          errorCategory: isDecisionAbortError(error) ? "cancelled" : "unknown",
        });
        if (isDecisionAbortError(error)) {
          record(component, mode, request, inputFingerprint, "cancelled", null);
        }
        throw error;
      }
      ticket?.settle({
        success: result.status === "answered",
        durationMs: result.durationMs,
        promptTokens: result.status === "answered" ? (result.usage?.inputTokens ?? null) : null,
        completionTokens:
          result.status === "answered" ? (result.usage?.outputTokens ?? null) : null,
        payloadChars: approximatePayloadChars(request),
        ...(result.status === "unavailable" ? { errorCategory: result.reason } : {}),
      });
      if (result.status === "unavailable") {
        if (TRANSIENT_REASONS.has(result.reason)) {
          // A transient failure is not cached: an identical later ask may
          // succeed. Two in a row stop asking for the rest of the run.
          cache.delete(inputFingerprint);
          consecutiveTransientFailures += 1;
          if (consecutiveTransientFailures >= MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
            fatalReason = result.reason;
          }
        } else if (RUN_FATAL_REASONS.has(result.reason)) {
          fatalReason = result.reason;
        }
      } else {
        consecutiveTransientFailures = 0;
      }
      record(
        component,
        mode,
        request,
        inputFingerprint,
        result.status === "answered" ? "answered" : "unavailable",
        result,
      );
      return result;
    },
    records: () => [...records],
  };
}

function approximatePayloadChars(request: DecisionRequestV1): number {
  try {
    return JSON.stringify({ state: request.state, questions: request.questions }).length;
  } catch {
    return 0;
  }
}

/** Bounded, credential-free projection of the records for the run record. */
export function persistableDecisionRecordsV1(
  records: readonly DecisionCallRecordV1[],
  limit = 32,
): DecisionCallRecordV1[] {
  return records.slice(-limit).map((entry) => ({ ...entry }));
}

export function normalizeDecisionCallRecordsV1(value: unknown): DecisionCallRecordV1[] {
  if (!Array.isArray(value)) return [];
  const out: DecisionCallRecordV1[] = [];
  for (const item of value.slice(-32)) {
    if (!isRecord(item) || item.version !== 1) continue;
    if (typeof item.id !== "string" || typeof item.inputFingerprint !== "string") continue;
    if (item.component !== "mission_routing" && item.component !== "claim_support") continue;
    if (item.purpose !== "mission_assessment" && item.purpose !== "claim_support") continue;
    const outcome = item.outcome;
    if (
      outcome !== "answered" &&
      outcome !== "unavailable" &&
      outcome !== "cache_hit" &&
      outcome !== "cancelled"
    ) {
      continue;
    }
    out.push({
      version: 1,
      id: item.id.slice(0, 64),
      component: item.component,
      purpose: item.purpose,
      mode: normalizeDecisionModelModeV1(item.mode),
      model: typeof item.model === "string" ? item.model.slice(0, 128) : "",
      reportedModel: typeof item.reportedModel === "string" ? item.reportedModel.slice(0, 128) : null,
      templateVersion:
        typeof item.templateVersion === "string" ? item.templateVersion.slice(0, 64) : "",
      inputFingerprint: item.inputFingerprint.slice(0, 80),
      outcome,
      fallbackReason:
        typeof item.fallbackReason === "string"
          ? (item.fallbackReason.slice(0, 48) as DecisionUnavailableReasonV1)
          : null,
      durationMs: nonNegative(item.durationMs) ?? 0,
      cost: nonNegative(item.cost),
      inputTokens: nonNegative(item.inputTokens),
      outputTokens: nonNegative(item.outputTokens),
      httpStatus: nonNegative(item.httpStatus),
      at: typeof item.at === "string" ? item.at.slice(0, 40) : "",
    });
  }
  return out;
}

/** One Run Details line per call, from record fields only. */
export function describeDecisionCallRecordV1(record: DecisionCallRecordV1): string {
  const what = record.purpose === "claim_support" ? "claim check" : "mission assessment";
  const cost = record.cost === null ? "" : `, $${record.cost.toFixed(6)}`;
  switch (record.outcome) {
    case "answered":
      return `Jev ${what} answered in ${record.durationMs} ms (${record.mode}${cost}).`;
    case "cache_hit":
      return `Jev ${what} reused from this run (${record.mode}).`;
    case "cancelled":
      return `Jev ${what} cancelled with the mission.`;
    default:
      return `Jev ${what} unavailable: ${record.fallbackReason ?? "unknown"}; the existing checks decide (${record.mode}).`;
  }
}

/** Totals for the one-line Run Details summary. */
export function summarizeDecisionRecordsV1(records: readonly DecisionCallRecordV1[]): {
  calls: number;
  answered: number;
  unavailable: number;
  cacheHits: number;
  totalDurationMs: number;
  reportedCost: number | null;
} {
  let answered = 0;
  let unavailable = 0;
  let cacheHits = 0;
  let totalDurationMs = 0;
  let reportedCost: number | null = null;
  for (const entry of records) {
    if (entry.outcome === "answered") answered += 1;
    if (entry.outcome === "unavailable") unavailable += 1;
    if (entry.outcome === "cache_hit") cacheHits += 1;
    totalDurationMs += entry.durationMs;
    if (entry.cost !== null) reportedCost = (reportedCost ?? 0) + entry.cost;
  }
  return {
    calls: records.length - cacheHits,
    answered,
    unavailable,
    cacheHits,
    totalDurationMs,
    reportedCost,
  };
}

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
