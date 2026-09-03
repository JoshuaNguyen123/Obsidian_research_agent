import { ModelClientError } from "./types";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Budget for provider rate limits (HTTP 429, "too many concurrent
   * requests"). A shared account can be busy for tens of seconds while
   * another process drains its concurrency allowance; the general budget
   * (3 attempts, delays capped at 8 s) let a mission die after ~16 s of
   * such contention. Rate-limit attempts get their own count and delay cap,
   * both taken as the larger of the general value and these; Retry-After is
   * still honored up to the cap. Auth, budget, and abort never retry.
   */
  rateLimitMaxAttempts?: number;
  rateLimitMaxDelayMs?: number;
}

export const DEFAULT_MODEL_RETRY_POLICY: Required<RetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: 750,
  maxDelayMs: 8000,
  // 750 → 1.5 s → 3 s → 6 s → 12 s → 24 s: about 47 s of waiting across
  // seven attempts before a rate limit is allowed to end a step.
  rateLimitMaxAttempts: 7,
  rateLimitMaxDelayMs: 30_000,
};

export function isTransientModelError(error: unknown): boolean {
  // The endpoint breaker's fail-fast error is shaped like a network failure
  // so the specialist fallback still runs, but retrying it per call would
  // just re-ask the breaker; it is never transient here.
  if (isCircuitOpenModelError(error)) {
    return false;
  }
  if (error instanceof ModelClientError) {
    return isTransientModelErrorShape(error.category, error.status);
  }

  if (!isRecord(error) || error.name !== "ModelClientError") {
    return false;
  }

  return isTransientModelErrorShape(error.category, error.status);
}

/**
 * Kept inline (not imported from endpointBreaker.ts, which imports this
 * module) so the two files cannot form an import cycle.
 */
function isCircuitOpenModelError(error: unknown): boolean {
  const record =
    error instanceof ModelClientError
      ? error
      : isRecord(error) && error.name === "ModelClientError"
        ? error
        : null;
  return Boolean(
    record && isRecord(record.details) && record.details.circuitOpen === true,
  );
}

/**
 * A request that consumed its whole `requestTimeoutMs` without a response is a
 * capacity signal, not a transient blip. It is still a `network` error (and so
 * transient by shape), but each retry costs another full timeout window with
 * no user-visible progress, so callers must bound it separately.
 */
export function isModelRequestTimeoutError(error: unknown): boolean {
  const record = error instanceof ModelClientError
    ? error
    : isRecord(error) && error.name === "ModelClientError"
      ? error
      : null;
  if (!record || record.category !== "network") {
    return false;
  }
  const message = typeof record.message === "string" ? record.message : "";
  return /\btimed out after \d+ms\b/iu.test(message);
}

/** HTTP 429 / provider concurrency refusals, in either error shape. */
export function isRateLimitModelError(error: unknown): boolean {
  if (error instanceof ModelClientError) {
    return error.category === "rate_limit";
  }
  return (
    isRecord(error) &&
    error.name === "ModelClientError" &&
    error.category === "rate_limit"
  );
}

/** Request timeouts are retried at most this many times in total. */
export const MAX_MODEL_REQUEST_TIMEOUT_RETRIES = 1;

/**
 * A truncated or malformed provider body is worth one re-request. A
 * consistently-broken provider must still fail fast — this is not the
 * general transient budget.
 */
export const MAX_INVALID_RESPONSE_RETRIES = 1;

export async function withModelRetry<T>(
  run: () => Promise<T>,
  options: {
    policy?: Partial<RetryPolicy>;
    abortSignal?: AbortSignal;
    onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
    /**
     * When false, do not retry even for transient errors. Used after streamed
     * writeback has already applied note bytes (re-stream would duplicate).
     */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    /**
     * Optional grace period for an already-invoked client to settle after the
     * host aborts. The default is zero so lifecycle authority is released
     * immediately. Observation-only calls may use a short bounded grace to
     * retain their final usage evidence without permitting an unbounded hang.
     */
    abortSettleGraceMs?: number;
  } = {},
): Promise<T> {
  const policy = normalizeRetryPolicy(options.policy);
  let attempt = 1;

  while (true) {
    throwIfAborted(options.abortSignal);
    try {
      // A transport is expected to honor the request signal, but the runner's
      // lifecycle cannot depend on that implementation detail. Electron fetch,
      // a provider SDK, or a test double can leave an in-flight promise pending
      // after cancellation. Race every attempt against the host signal so the
      // agent loop relinquishes mutation authority immediately; any late
      // transport result is ignored by the already-settled race.
      return await runAbortableAttempt(
        run,
        options.abortSignal,
        options.abortSettleGraceMs,
      );
    } catch (error) {
      // A rate limit is capacity contention, not a fault: it gets the
      // larger attempt count and delay cap so a busy shared account can
      // drain before the step gives up.
      const rateLimited = isRateLimitModelError(error);
      const attemptCap = rateLimited
        ? Math.max(policy.maxAttempts, policy.rateLimitMaxAttempts)
        : policy.maxAttempts;
      if (
        attempt >= attemptCap ||
        !isRetryableModelError(error, attempt) ||
        options.shouldRetry?.(error, attempt) === false
      ) {
        throw error;
      }

      const delayCap = rateLimited
        ? Math.max(policy.maxDelayMs, policy.rateLimitMaxDelayMs)
        : policy.maxDelayMs;
      const delayMs = Math.min(
        delayCap,
        Math.max(
          policy.baseDelayMs * 2 ** (attempt - 1),
          getRetryAfterMs(error) ?? 0,
        ),
      );
      options.onRetry?.(attempt + 1, error, delayMs);
      await abortableDelay(delayMs, options.abortSignal);
      attempt += 1;
    }
  }
}

function runAbortableAttempt<T>(
  run: () => Promise<T>,
  abortSignal: AbortSignal | undefined,
  abortSettleGraceMs = 0,
): Promise<T> {
  if (!abortSignal) {
    return run();
  }
  throwIfAborted(abortSignal);

  let removeAbortListener: (() => void) | undefined;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  const boundedAbortSettleGraceMs = Math.min(
    5_000,
    Math.max(0, Math.trunc(abortSettleGraceMs)),
  );
  const aborted = new Promise<T>((_resolve, reject) => {
    const rejectAbort = () => reject(createAbortError());
    const onAbort = () => {
      if (boundedAbortSettleGraceMs === 0) {
        rejectAbort();
        return;
      }
      abortTimer = setTimeout(rejectAbort, boundedAbortSettleGraceMs);
      (abortTimer as unknown as { unref?: () => void }).unref?.();
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () =>
      abortSignal.removeEventListener("abort", onAbort);
  });

  // Promise.resolve().then(run) also normalizes a synchronous throw from a
  // custom client into the same rejected-promise path as a transport failure.
  const operation = Promise.resolve().then(run);
  return Promise.race([operation, aborted]).finally(() => {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    removeAbortListener?.();
  });
}

export function parseRetryAfterMs(
  headers: Record<string, string> | undefined,
  now = Date.now(),
): number | undefined {
  const raw = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === "retry-after",
  )?.[1]?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof ModelClientError) || !isRecord(error.details)) {
    return undefined;
  }
  const value = error.details.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeRetryPolicy(
  policy: Partial<RetryPolicy> | undefined,
): Required<RetryPolicy> {
  return {
    maxAttempts: Math.max(
      1,
      Math.trunc(policy?.maxAttempts ?? DEFAULT_MODEL_RETRY_POLICY.maxAttempts),
    ),
    baseDelayMs: Math.max(
      0,
      Math.trunc(policy?.baseDelayMs ?? DEFAULT_MODEL_RETRY_POLICY.baseDelayMs),
    ),
    maxDelayMs: Math.max(
      0,
      Math.trunc(policy?.maxDelayMs ?? DEFAULT_MODEL_RETRY_POLICY.maxDelayMs),
    ),
    rateLimitMaxAttempts: Math.max(
      1,
      Math.trunc(
        policy?.rateLimitMaxAttempts ??
          DEFAULT_MODEL_RETRY_POLICY.rateLimitMaxAttempts,
      ),
    ),
    rateLimitMaxDelayMs: Math.max(
      0,
      Math.trunc(
        policy?.rateLimitMaxDelayMs ??
          DEFAULT_MODEL_RETRY_POLICY.rateLimitMaxDelayMs,
      ),
    ),
  };
}

/**
 * `invalid_response` stays non-transient for fallback and failure-class
 * callers. `withModelRetry` retries a malformed provider body once via
 * {@link MAX_INVALID_RESPONSE_RETRIES}. Host policy uses the same category
 * (off-topic and English-only gates) and must not consume that retry.
 */
export function isInvalidResponseModelError(error: unknown): boolean {
  if (error instanceof ModelClientError) {
    return error.category === "invalid_response";
  }
  return (
    isRecord(error) &&
    error.name === "ModelClientError" &&
    error.category === "invalid_response"
  );
}

export function isMalformedProviderBodyError(error: unknown): boolean {
  if (!isInvalidResponseModelError(error)) {
    return false;
  }
  const message =
    error instanceof Error
      ? error.message
      : isRecord(error) && typeof error.message === "string"
        ? error.message
        : "";
  return !HOST_POLICY_INVALID_RESPONSE_RE.test(message);
}

const HOST_POLICY_INVALID_RESPONSE_RE =
  /off topic|drifted off topic|relevance check|non-English output|English-only guard/iu;

function isRetryableModelError(error: unknown, attempt: number): boolean {
  if (isMalformedProviderBodyError(error)) {
    return attempt <= MAX_INVALID_RESPONSE_RETRIES;
  }
  if (!isTransientModelError(error)) {
    return false;
  }
  return !(
    isModelRequestTimeoutError(error) &&
    attempt > MAX_MODEL_REQUEST_TIMEOUT_RETRIES
  );
}

function isTransientModelErrorShape(
  category: unknown,
  status: unknown,
): boolean {
  if (category === "network" || category === "rate_limit") {
    return true;
  }

  return category === "api" && typeof status === "number" && status >= 500;
}

function abortableDelay(delayMs: number, abortSignal: AbortSignal | undefined) {
  if (delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const timeout = setTimeout(cleanupAndResolve, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const cleanup = () => {
      abortSignal?.removeEventListener("abort", onAbort);
    };
    function cleanupAndResolve() {
      cleanup();
      resolve();
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(abortSignal: AbortSignal | undefined) {
  if (abortSignal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
