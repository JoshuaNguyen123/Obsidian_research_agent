import { ModelClientError } from "./types";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_MODEL_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 750,
  maxDelayMs: 8000,
};

export function isTransientModelError(error: unknown): boolean {
  if (error instanceof ModelClientError) {
    return isTransientModelErrorShape(error.category, error.status);
  }

  if (!isRecord(error) || error.name !== "ModelClientError") {
    return false;
  }

  return isTransientModelErrorShape(error.category, error.status);
}

export async function withModelRetry<T>(
  run: () => Promise<T>,
  options: {
    policy?: Partial<RetryPolicy>;
    abortSignal?: AbortSignal;
    onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  } = {},
): Promise<T> {
  const policy = normalizeRetryPolicy(options.policy);
  let attempt = 1;

  while (true) {
    throwIfAborted(options.abortSignal);
    try {
      return await run();
    } catch (error) {
      if (attempt >= policy.maxAttempts || !isTransientModelError(error)) {
        throw error;
      }

      const delayMs = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * 2 ** (attempt - 1),
      );
      options.onRetry?.(attempt + 1, error, delayMs);
      await abortableDelay(delayMs, options.abortSignal);
      attempt += 1;
    }
  }
}

function normalizeRetryPolicy(policy: Partial<RetryPolicy> | undefined): RetryPolicy {
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
  };
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
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
