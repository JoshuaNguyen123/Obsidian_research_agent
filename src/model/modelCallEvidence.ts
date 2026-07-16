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
  outcome: "success" | "error" | "budget_exhausted";
  responseChars: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
}

export interface ObservableModelClient {
  client: ModelClient;
  getUsage(): ModelUsageAggregateV1;
  updateBudget(budget: ModelExecutionBudgetV1): void;
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
  reported: boolean;
} {
  const records = Array.isArray(raw) ? raw : [raw];
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let totalTokens: number | undefined;
  for (const value of records) {
    if (!isRecord(value)) continue;
    const usage = isRecord(value.usage) ? value.usage : value;
    promptTokens ??= finiteNumber(usage.prompt_tokens ?? usage.prompt_eval_count);
    completionTokens ??= finiteNumber(
      usage.completion_tokens ?? usage.eval_count,
    );
    totalTokens ??= finiteNumber(usage.total_tokens);
  }
  const reported =
    promptTokens !== undefined ||
    completionTokens !== undefined ||
    totalTokens !== undefined;
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
    reported,
  };
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
        durationMs: 0,
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
      const responseChars = response.message.content.length;
      const estimatedTokens = tokenUsage.reported
        ? 0
        : Math.max(1, Math.ceil((serializedChars(request) + responseChars) / 4));
      usage.successfulCallCount += 1;
      usage.reportedTokens += tokenUsage.totalTokens;
      usage.estimatedTokens += estimatedTokens;
      usage.wallClockMs = Math.max(usage.wallClockMs, now() - startedAt);
      onEvidence?.(
        buildEvidence({
          callId,
          phase,
          descriptor,
          durationMs: Math.max(0, now() - callStartedAt),
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
          durationMs: Math.max(0, now() - callStartedAt),
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
  durationMs,
  outcome,
  responseChars = 0,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  reported = false,
  errorCategory,
  attempt = 1,
}: {
  callId: string;
  phase: ModelCallPhase;
  descriptor: ModelClientDescriptor;
  durationMs: number;
  outcome: ModelCallEvidenceV1["outcome"];
  responseChars?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reported?: boolean;
  errorCategory?: string;
  attempt?: number;
}): ModelCallEvidenceV1 {
  return {
    schemaVersion: 1,
    callId,
    phase,
    provider: descriptor.provider,
    model: descriptor.model,
    endpointCategory: descriptor.endpointCategory,
    transportKind: descriptor.transportKind,
    attempt,
    durationMs,
    outcome,
    responseChars,
    promptTokens,
    completionTokens,
    totalTokens,
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
