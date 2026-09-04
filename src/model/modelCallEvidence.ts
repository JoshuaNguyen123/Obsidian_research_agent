import {
  ModelClientError,
  type ModelCallPhase,
  type ModelChatRequest,
  type ModelChatResponse,
  type ModelClient,
  type ModelClientDescriptor,
  type ModelEndpointCategory,
} from "./types";

export interface ModelCallEvidenceV1 {
  schemaVersion: 1;
  callId: string;
  phase: ModelCallPhase;
  provider: ModelClientDescriptor["provider"];
  model: string;
  endpointCategory: ModelEndpointCategory;
  transportKind: ModelClientDescriptor["transportKind"];
  attempt: number;
  durationMs: number;
  /** True after the request crossed the observer's local budget gate and invoked the client. */
  clientInvoked: boolean;
  outcome: "success" | "error" | "budget_exhausted";
  responseChars: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens the provider served from its own cache, and whether it said
   * anything at all. Both optional: this is a v1 record and evidence persisted
   * before caching was measured genuinely lacks them, so absent means "never
   * reported" rather than "measured zero". A silent provider and a real cache
   * miss are different facts and must not collapse into the same number.
   */
  cachedPromptTokens?: number;
  cachedTokensReported?: boolean;
  tokenUsageReported: boolean;
  errorCategory?: string;
}

export interface ModelExecutionBudgetV1 {
  schemaVersion: 1;
  maxCalls: number;
  maxTokens: number;
  maxWallClockMs: number;
}

export interface ModelUsageAggregateV1 {
  schemaVersion: 1;
  modelCallCount: number;
  successfulCallCount: number;
  failedCallCount: number;
  reportedTokens: number;
  estimatedTokens: number;
  retries: number;
  wallClockMs: number;
  /**
   * Prompt tokens the provider reported serving from its cache, summed over
   * the calls that reported it. Optional and additive: absent means no call
   * ever reported caching (a silent provider), which is a different fact from
   * a measured zero. Persisted ledgers written before this field simply lack
   * it and normalize to absent.
   */
  cachedPromptTokens?: number;
  /**
   * Prompt-prefix reuse measured by the runner: how many agent steps were
   * compared against their previous step, and the sum of their reuse ratios
   * (0..1 each). Both absent means no step was ever measured (a single-call
   * mission, or a ledger written before the instrument existed), which is a
   * different fact from a measured zero. Read through
   * `promptPrefixReuseAverageV1`; never divide by hand.
   */
  promptPrefixReuseSamples?: number;
  promptPrefixReuseRatioTotal?: number;
}

export interface ObservableModelClient {
  client: ModelClient;
  getUsage(): ModelUsageAggregateV1;
  updateBudget(budget: ModelExecutionBudgetV1): void;
}

/**
 * Add disjoint provider-usage segments without losing the schema shape.
 * Continuations use this to carry the interrupted segment's durable totals
 * forward while the fresh observable client measures only the new segment.
 */
export function mergeModelUsageAggregatesV1(
  ...segments: ReadonlyArray<ModelUsageAggregateV1 | null | undefined>
): ModelUsageAggregateV1 {
  const merged: ModelUsageAggregateV1 = {
    schemaVersion: 1,
    modelCallCount: 0,
    successfulCallCount: 0,
    failedCallCount: 0,
    reportedTokens: 0,
    estimatedTokens: 0,
    retries: 0,
    wallClockMs: 0,
  };
  for (const segment of segments) {
    if (!segment) continue;
    merged.modelCallCount += segment.modelCallCount;
    merged.successfulCallCount += segment.successfulCallCount;
    merged.failedCallCount += segment.failedCallCount;
    merged.reportedTokens += segment.reportedTokens;
    merged.estimatedTokens += segment.estimatedTokens;
    merged.retries += segment.retries;
    merged.wallClockMs += segment.wallClockMs;
    if (typeof segment.cachedPromptTokens === "number") {
      merged.cachedPromptTokens =
        (merged.cachedPromptTokens ?? 0) + segment.cachedPromptTokens;
    }
    if (
      typeof segment.promptPrefixReuseSamples === "number" &&
      typeof segment.promptPrefixReuseRatioTotal === "number"
    ) {
      merged.promptPrefixReuseSamples =
        (merged.promptPrefixReuseSamples ?? 0) + segment.promptPrefixReuseSamples;
      merged.promptPrefixReuseRatioTotal =
        (merged.promptPrefixReuseRatioTotal ?? 0) +
        segment.promptPrefixReuseRatioTotal;
    }
  }
  return merged;
}

/**
 * Provider usage a run segment inherited from earlier segments of the same
 * durable run, declared once by the runner before the segment measures any
 * calls of its own.
 *
 * The mission ledger merges this exact aggregate with the segment's live
 * totals, so its `providerUsage` spans the whole resume chain. RunCoordinator
 * measures only the evidence its own scope observes. Without the declaration
 * the two surfaces silently span different parts of the same run, and the
 * coordinator's whole-team aggregate reads *smaller* than the ledger segment
 * it publishes — an aggregate below one of its own parts.
 */
export interface ProviderUsageInheritanceV1 {
  schemaVersion: 1;
  /** The segment declaring what it inherited. */
  runId: string;
  /** The durable run whose ledger supplied it; null for a fresh mission. */
  resumedFromRunId: string | null;
  usage: ModelUsageAggregateV1;
}

/**
 * Coerce a persisted or cross-process usage aggregate into the current shape.
 * The mission ledger's readback and RunCoordinator's event intake share this
 * one normalizer so a legacy record cannot mean two different things to the
 * two subsystems that must agree about it.
 */
export function normalizeModelUsageAggregateV1(
  value: unknown,
): ModelUsageAggregateV1 {
  const record = isRecord(value) ? value : {};
  return {
    schemaVersion: 1,
    modelCallCount: wholeUsageCount(record.modelCallCount),
    successfulCallCount: wholeUsageCount(record.successfulCallCount),
    failedCallCount: wholeUsageCount(record.failedCallCount),
    reportedTokens: wholeUsageCount(record.reportedTokens),
    estimatedTokens: wholeUsageCount(record.estimatedTokens),
    retries: wholeUsageCount(record.retries),
    wallClockMs: wholeUsageCount(record.wallClockMs),
    ...(usageNumber(record.cachedPromptTokens) !== undefined
      ? { cachedPromptTokens: wholeUsageCount(record.cachedPromptTokens) }
      : {}),
    // Prefix-reuse totals travel as a pair; one without the other is
    // unreadable and normalizes to absent (unknown), never to a zero average.
    ...(usageNumber(record.promptPrefixReuseSamples) !== undefined &&
    usageNumber(record.promptPrefixReuseRatioTotal) !== undefined
      ? {
          promptPrefixReuseSamples: wholeUsageCount(
            record.promptPrefixReuseSamples,
          ),
          promptPrefixReuseRatioTotal: Math.max(
            0,
            usageNumber(record.promptPrefixReuseRatioTotal) ?? 0,
          ),
        }
      : {}),
  };
}

function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function wholeUsageCount(value: unknown): number {
  return Math.max(0, Math.floor(usageNumber(value) ?? 0));
}

/**
 * Mean per-step prompt-prefix reuse ratio (0..1) carried by a usage
 * aggregate, or null when no step was measured. The runner measures a step
 * only against a previous step, so a single-call mission has no sample and
 * must read as unknown rather than as 0% reuse.
 */
export function promptPrefixReuseAverageV1(
  usage:
    | Pick<
        ModelUsageAggregateV1,
        "promptPrefixReuseSamples" | "promptPrefixReuseRatioTotal"
      >
    | null
    | undefined,
): number | null {
  const samples = usage?.promptPrefixReuseSamples;
  const total = usage?.promptPrefixReuseRatioTotal;
  if (
    typeof samples !== "number" ||
    typeof total !== "number" ||
    !Number.isFinite(samples) ||
    !Number.isFinite(total) ||
    samples <= 0
  ) {
    return null;
  }
  return Math.min(1, Math.max(0, total / samples));
}

const UNKNOWN_DESCRIPTOR: ModelClientDescriptor = {
  provider: "ollama",
  model: "unknown",
  endpointCategory: "custom",
  transportKind: "test_mock",
};

export function categorizeModelEndpoint(baseUrl: string): ModelEndpointCategory {
  try {
    const hostname = new URL(baseUrl.trim()).hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    ) {
      return "local";
    }
    if (hostname === "ollama.com" || hostname.endsWith(".ollama.com")) {
      return "ollama_cloud";
    }
  } catch {
    // Invalid URLs remain a redacted custom endpoint; the client validates them.
  }
  return "custom";
}

export function extractProviderTokenUsage(raw: unknown): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  cachedReported: boolean;
  reported: boolean;
} {
  const records = Array.isArray(raw) ? raw : [raw];
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let totalTokens: number | undefined;
  let cachedPromptTokens: number | undefined;
  for (const value of records) {
    if (!isRecord(value)) continue;
    const usage = isRecord(value.usage) ? value.usage : value;
    promptTokens ??= finiteNumber(usage.prompt_tokens ?? usage.prompt_eval_count);
    completionTokens ??= finiteNumber(
      usage.completion_tokens ?? usage.eval_count,
    );
    totalTokens ??= finiteNumber(usage.total_tokens);
    // Cached prompt tokens are reported in three shapes across the providers
    // this plugin talks to: nested under prompt_tokens_details (OpenAI), flat
    // as cached_tokens, or as Anthropic's separate cache-read counter. An agent
    // loop resends a byte-identical prefix every step, so this is the number
    // that says whether that prefix is being re-billed.
    const details = isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : null;
    cachedPromptTokens ??= finiteNumber(
      details?.cached_tokens ??
        usage.cached_tokens ??
        usage.cache_read_input_tokens,
    );
  }
  const reported =
    promptTokens !== undefined ||
    completionTokens !== undefined ||
    totalTokens !== undefined;
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
    cachedPromptTokens: cachedPromptTokens ?? 0,
    cachedReported: cachedPromptTokens !== undefined,
    reported,
  };
}

/**
 * Share of the prompt the provider served from cache, or null when it never
 * said. Null and 0 mean different things: null is "unknown", 0 is a measured
 * miss, and reporting a silent provider as 0% would make an unmeasurable
 * setup look like a broken one.
 */
export function cachedPromptTokenRatio(record: {
  promptTokens: number;
  cachedPromptTokens?: number;
  cachedTokensReported?: boolean;
}): number | null {
  if (!record.cachedTokensReported || record.promptTokens <= 0) return null;
  return Math.min(
    1,
    Math.max(0, (record.cachedPromptTokens ?? 0) / record.promptTokens),
  );
}

/**
 * Redacted size of everything the model produced in one response: prose,
 * thinking, and tool calls. A pure tool-call reply (empty `content`, payload
 * in the arguments) is real model output — measuring only `content.length`
 * recorded such successes as 0 chars, which both understated estimated tokens
 * and made harness attestation treat a healthy tool-calling model as silent.
 */
export function measureAssistantPayloadChars(response: {
  message: { content: string; thinking?: string; role?: string };
  toolCalls?: readonly unknown[];
}): number {
  const toolCallChars =
    response.toolCalls && response.toolCalls.length > 0
      ? JSON.stringify(response.toolCalls).length
      : 0;
  return (
    response.message.content.length +
    (response.message.thinking?.length ?? 0) +
    toolCallChars
  );
}

export function createObservableModelClient({
  client,
  budget,
  onEvidence,
  now = () => Date.now(),
}: {
  client: ModelClient;
  budget: ModelExecutionBudgetV1;
  onEvidence?: (evidence: ModelCallEvidenceV1) => void;
  now?: () => number;
}): ObservableModelClient {
  let activeBudget = normalizeBudget(budget);
  const startedAt = now();
  let sequence = 0;
  const requestAttempts = new WeakMap<ModelChatRequest, number>();
  const usage: ModelUsageAggregateV1 = {
    schemaVersion: 1,
    modelCallCount: 0,
    successfulCallCount: 0,
    failedCallCount: 0,
    reportedTokens: 0,
    estimatedTokens: 0,
    retries: 0,
    wallClockMs: 0,
  };
  const descriptor = client.descriptor ?? UNKNOWN_DESCRIPTOR;

  const call = async (
    request: ModelChatRequest,
    stream: boolean,
    events?: Parameters<ModelClient["streamChat"]>[1],
  ): Promise<ModelChatResponse> => {
    const callStartedAt = now();
    const callId = `model-call-${++sequence}`;
    const requestModel = request.model?.trim() || descriptor.model;
    const attempt = (requestAttempts.get(request) ?? 0) + 1;
    requestAttempts.set(request, attempt);
    const phase = attempt > 1
      ? "retry"
      : request.evidencePhase ?? (stream ? "streaming" : "agent_step");
    if (attempt > 1) usage.retries += 1;
    const elapsedBeforeCall = Math.max(0, callStartedAt - startedAt);
    if (
      usage.modelCallCount >= activeBudget.maxCalls ||
      usage.reportedTokens + usage.estimatedTokens >= activeBudget.maxTokens ||
      elapsedBeforeCall >= activeBudget.maxWallClockMs
    ) {
      const evidence = buildEvidence({
        callId,
        phase,
        descriptor,
        model: requestModel,
        durationMs: 0,
        clientInvoked: false,
        outcome: "budget_exhausted",
        attempt,
        errorCategory: "provider_budget_exhausted",
      });
      onEvidence?.(evidence);
      throw new ModelClientError(
        "provider_budget_exhausted",
        "Provider execution budget exhausted; the mission can be resumed with a fresh budget.",
      );
    }

    usage.modelCallCount += 1;
    try {
      const response = stream
        ? await client.streamChat(request, events)
        : await client.chat(request);
      const tokenUsage = extractProviderTokenUsage(response.raw);
      const responseChars = measureAssistantPayloadChars(response);
      const estimatedTokens = tokenUsage.reported
        ? 0
        : Math.max(1, Math.ceil((serializedChars(request) + responseChars) / 4));
      usage.successfulCallCount += 1;
      usage.reportedTokens += tokenUsage.totalTokens;
      usage.estimatedTokens += estimatedTokens;
      if (tokenUsage.cachedReported) {
        usage.cachedPromptTokens =
          (usage.cachedPromptTokens ?? 0) + tokenUsage.cachedPromptTokens;
      }
      usage.wallClockMs = Math.max(usage.wallClockMs, now() - startedAt);
      onEvidence?.(
        buildEvidence({
          callId,
          phase,
          descriptor,
          model: requestModel,
          durationMs: Math.max(0, now() - callStartedAt),
          clientInvoked: true,
          outcome: "success",
          attempt,
          responseChars,
          ...tokenUsage,
        }),
      );
      return response;
    } catch (error) {
      usage.failedCallCount += 1;
      usage.wallClockMs = Math.max(usage.wallClockMs, now() - startedAt);
      onEvidence?.(
        buildEvidence({
          callId,
          phase,
          descriptor,
          model: requestModel,
          durationMs: Math.max(0, now() - callStartedAt),
          clientInvoked: true,
          outcome:
            error instanceof ModelClientError &&
            error.category === "provider_budget_exhausted"
              ? "budget_exhausted"
              : "error",
          errorCategory:
            error instanceof ModelClientError ? error.category : "unknown",
          attempt,
        }),
      );
      throw error;
    }
  };

  return {
    client: {
      descriptor,
      chat: (request) => call(request, false),
      streamChat: (request, events) => call(request, true, events),
    },
    getUsage: () => ({
      ...usage,
      wallClockMs: Math.max(usage.wallClockMs, now() - startedAt),
    }),
    updateBudget: (next) => {
      activeBudget = normalizeBudget(next);
    },
  };
}

function buildEvidence({
  callId,
  phase,
  descriptor,
  model,
  durationMs,
  clientInvoked,
  outcome,
  responseChars = 0,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  cachedPromptTokens = 0,
  cachedReported = false,
  reported = false,
  errorCategory,
  attempt = 1,
}: {
  callId: string;
  phase: ModelCallPhase;
  descriptor: ModelClientDescriptor;
  model: string;
  durationMs: number;
  clientInvoked: boolean;
  outcome: ModelCallEvidenceV1["outcome"];
  responseChars?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
  cachedReported?: boolean;
  reported?: boolean;
  errorCategory?: string;
  attempt?: number;
}): ModelCallEvidenceV1 {
  return {
    schemaVersion: 1,
    callId,
    phase,
    provider: descriptor.provider,
    model,
    endpointCategory: descriptor.endpointCategory,
    transportKind: descriptor.transportKind,
    attempt,
    durationMs,
    clientInvoked,
    outcome,
    responseChars,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens,
    cachedTokensReported: cachedReported,
    tokenUsageReported: reported,
    ...(errorCategory ? { errorCategory } : {}),
  };
}

function normalizeBudget(value: ModelExecutionBudgetV1): ModelExecutionBudgetV1 {
  for (const [name, amount] of Object.entries(value)) {
    if (name === "schemaVersion") continue;
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error(`Model execution budget ${name} must be a positive integer.`);
    }
  }
  return { ...value, schemaVersion: 1 };
}

function serializedChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
