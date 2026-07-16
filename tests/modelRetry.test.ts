import test from "node:test";
import assert from "node:assert/strict";
import { ModelClientError } from "../src/model/types";
import {
  isTransientModelError,
  parseRetryAfterMs,
  withModelRetry,
} from "../src/model/retry";

test("model retry retries only transient provider failures", async () => {
  assert.equal(isTransientModelError(new ModelClientError("network", "offline")), true);
  assert.equal(
    isTransientModelError(new ModelClientError("rate_limit", "slow down")),
    true,
  );
  assert.equal(
    isTransientModelError(new ModelClientError("api", "server", { status: 503 })),
    true,
  );
  assert.equal(
    isTransientModelError(new ModelClientError("auth", "bad key")),
    false,
  );
  assert.equal(
    isTransientModelError(new ModelClientError("invalid_response", "bad json")),
    false,
  );
});

test("Retry-After parsing supports seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterMs({ "Retry-After": "2" }, 0), 2_000);
  assert.equal(
    parseRetryAfterMs({ "retry-after": "Thu, 01 Jan 1970 00:00:03 GMT" }, 1_000),
    2_000,
  );
});

test("withModelRetry honors bounded provider Retry-After", async () => {
  let attempts = 0;
  let observedDelay = 0;
  await withModelRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ModelClientError("rate_limit", "slow down", {
          status: 429,
          details: { retryAfterMs: 5 },
        });
      }
      return "ok";
    },
    {
      policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 },
      onRetry: (_attempt, _error, delayMs) => { observedDelay = delayMs; },
    },
  );
  assert.equal(observedDelay, 5);
});

test("withModelRetry backs off then succeeds", async () => {
  let attempts = 0;
  const retryAttempts: number[] = [];
  const result = await withModelRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new ModelClientError("api", "temporary", { status: 500 });
      }
      return "ok";
    },
    {
      policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      onRetry: (attempt) => retryAttempts.push(attempt),
    },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(retryAttempts, [2, 3]);
});

test("withModelRetry does not retry auth failures", async () => {
  let attempts = 0;
  await assert.rejects(
    withModelRetry(
      async () => {
        attempts += 1;
        throw new ModelClientError("auth", "bad key");
      },
      { policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } },
    ),
    /bad key/,
  );
  assert.equal(attempts, 1);
});
