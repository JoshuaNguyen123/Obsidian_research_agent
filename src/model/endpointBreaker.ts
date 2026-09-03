/**
 * Session-scoped circuit breaker for one model endpoint.
 *
 * Every model call already retries transient failures up to three times with
 * backoff, and a request timeout is retried once more. What nothing did was
 * remember across calls: a dead or throttled endpoint was re-dialled at full
 * timeout cost by every subsequent call in the mission -- up to ~150 s per
 * non-streaming call site and ~360 s per streaming one -- so a 100-step loop
 * burned its whole budget discovering the same outage a hundred times.
 *
 * The breaker counts consecutive provider-health failures per endpoint. After
 * `failureThreshold` of them it opens and fails fast for a cooldown, then
 * admits exactly one probe (half-open): success closes it, failure re-opens it
 * with a doubled cooldown up to `maxCooldownMs`.
 *
 * What counts is deliberately the same set `withModelRetry` treats as
 * transient (network, api >= 500, request timeouts) plus a malformed provider
 * body -- never auth, missing key, provider budget, rate limits (the provider
 * asking for patience is not a dead endpoint), host-policy `invalid_response`
 * (off-topic / English-only refusals are our verdicts, not the provider's),
 * or cancellations. The fail-fast error is a `network` ModelClientError so the
 * specialist fallback still runs against its own endpoint, but it carries
 * `details.circuitOpen` so `isTransientModelError` refuses to retry it.
 */
import {
  ModelClientError,
  type ModelChatRequest,
  type ModelChatResponse,
  type ModelChatStreamEvents,
  type ModelClient,
} from "./types";
import { isMalformedProviderBodyError, isTransientModelError } from "./retry";

export const DEFAULT_ENDPOINT_BREAKER_FAILURE_THRESHOLD = 5;
export const DEFAULT_ENDPOINT_BREAKER_COOLDOWN_MS = 30_000;
export const DEFAULT_ENDPOINT_BREAKER_MAX_COOLDOWN_MS = 5 * 60_000;

export type EndpointBreakerState = "closed" | "open" | "half_open";

export interface EndpointBreakerSnapshot {
  key: string;
  state: EndpointBreakerState;
  consecutiveFailures: number;
  cooldownMs: number;
  /** Milliseconds until the next probe is admitted; 0 unless open. */
  retryAfterMs: number;
}

export interface EndpointBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readModelErrorShape(
  error: unknown,
): { category?: unknown; details?: unknown; name?: unknown } | null {
  if (error instanceof ModelClientError) return error;
  if (isRecord(error) && error.name === "ModelClientError") return error;
  return null;
}

function isCancellation(error: unknown): boolean {
  if (isRecord(error) && error.name === "AbortError") return true;
  const message =
    error instanceof Error
      ? error.message
      : isRecord(error) && typeof error.message === "string"
        ? error.message
        : "";
  return /\b(request )?cancell?ed\b|\baborted\b/iu.test(message);
}

/** True for the fail-fast error the breaker itself throws while open. */
export function isCircuitOpenError(error: unknown): boolean {
  const shape = readModelErrorShape(error);
  return Boolean(
    shape && isRecord(shape.details) && shape.details.circuitOpen === true,
  );
}

/**
 * Whether a failure says something about the ENDPOINT rather than about the
 * request, the credentials, or our own policy.
 */
export function isEndpointBreakerCountedFailure(error: unknown): boolean {
  if (isCancellation(error) || isCircuitOpenError(error)) return false;
  if (isMalformedProviderBodyError(error)) return true;
  if (!isTransientModelError(error)) return false;
  const shape = readModelErrorShape(error);
  return shape?.category !== "rate_limit";
}

export class ModelEndpointBreaker {
  private consecutiveFailures = 0;
  private state: EndpointBreakerState = "closed";
  private openedAt = 0;
  private cooldownMs: number;
  private probeInFlight = false;
  private readonly failureThreshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  constructor(
    readonly key: string,
    options: EndpointBreakerOptions = {},
  ) {
    this.failureThreshold = Math.max(
      1,
      Math.floor(options.failureThreshold ?? DEFAULT_ENDPOINT_BREAKER_FAILURE_THRESHOLD),
    );
    this.baseCooldownMs = Math.max(
      1,
      Math.floor(options.cooldownMs ?? DEFAULT_ENDPOINT_BREAKER_COOLDOWN_MS),
    );
    this.maxCooldownMs = Math.max(
      this.baseCooldownMs,
      Math.floor(options.maxCooldownMs ?? DEFAULT_ENDPOINT_BREAKER_MAX_COOLDOWN_MS),
    );
    this.cooldownMs = this.baseCooldownMs;
    this.now = options.now ?? (() => Date.now());
  }

  snapshot(): EndpointBreakerSnapshot {
    const retryAfterMs =
      this.state === "open"
        ? Math.max(0, this.openedAt + this.cooldownMs - this.now())
        : 0;
    return {
      key: this.key,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      cooldownMs: this.cooldownMs,
      retryAfterMs,
    };
  }

  /**
   * Admit one call or throw the fail-fast error. When the cooldown has
   * elapsed the breaker moves to half-open and admits exactly one probe;
   * further callers wait for that probe's verdict.
   */
  admit(): void {
    if (this.state === "closed") return;
    const elapsed = this.now() - this.openedAt;
    if (this.state === "open" && elapsed >= this.cooldownMs) {
      this.state = "half_open";
      this.probeInFlight = false;
    }
    if (this.state === "half_open" && !this.probeInFlight) {
      this.probeInFlight = true;
      return;
    }
    const retryAfterMs =
      this.state === "half_open"
        ? 0
        : Math.max(0, this.openedAt + this.cooldownMs - this.now());
    throw new ModelClientError(
      "network",
      `Model endpoint paused after ${this.consecutiveFailures} consecutive provider failures; ` +
        (this.state === "half_open"
          ? "a probe call is in flight."
          : `next probe in ${Math.ceil(retryAfterMs / 1000)}s.`),
      {
        details: {
          circuitOpen: true,
          endpointKey: this.key,
          retryAfterMs,
          consecutiveFailures: this.consecutiveFailures,
        },
      },
    );
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
    this.probeInFlight = false;
    this.cooldownMs = this.baseCooldownMs;
  }

  recordFailure(error: unknown): void {
    if (!isEndpointBreakerCountedFailure(error)) {
      // A non-endpoint failure neither counts nor resets: the endpoint's
      // health is simply unobserved by this call.
      if (this.state === "half_open") {
        this.probeInFlight = false;
      }
      return;
    }
    this.consecutiveFailures += 1;
    if (this.state === "half_open") {
      // The probe failed: stay open longer.
      this.cooldownMs = Math.min(this.maxCooldownMs, this.cooldownMs * 2);
      this.state = "open";
      this.openedAt = this.now();
      this.probeInFlight = false;
      return;
    }
    if (this.state === "closed" && this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}

/**
 * Wrap a client so every chat/stream call passes the breaker. The wrapper is
 * a Proxy over the real client rather than a new object: the descriptor,
 * prototype, and class identity (`instanceof OllamaClient`, `constructor.name`
 * in diagnostics and tests) stay those of the provider client, and only the
 * two call methods are intercepted.
 */
export function wrapModelClientWithEndpointBreaker(
  client: ModelClient,
  breaker: ModelEndpointBreaker,
): ModelClient {
  const run = async <T>(call: () => Promise<T>): Promise<T> => {
    breaker.admit();
    try {
      const result = await call();
      breaker.recordSuccess();
      return result;
    } catch (error) {
      breaker.recordFailure(error);
      throw error;
    }
  };
  const chat = (request: ModelChatRequest): Promise<ModelChatResponse> =>
    run(() => client.chat(request));
  const streamChat = (
    request: ModelChatRequest,
    events?: ModelChatStreamEvents,
  ): Promise<ModelChatResponse> => run(() => client.streamChat(request, events));
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "chat") return chat;
      if (property === "streamChat") return streamChat;
      return Reflect.get(target, property, receiver);
    },
  });
}

const registry = new Map<string, ModelEndpointBreaker>();

/** One breaker per endpoint identity for the life of the plugin module. */
export function resolveModelEndpointBreaker(
  key: string,
  options: EndpointBreakerOptions = {},
): ModelEndpointBreaker {
  const existing = registry.get(key);
  if (existing) return existing;
  const created = new ModelEndpointBreaker(key, options);
  registry.set(key, created);
  return created;
}

export function resetModelEndpointBreakersForTests(): void {
  registry.clear();
}
