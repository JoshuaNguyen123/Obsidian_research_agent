import test from "node:test";
import assert from "node:assert/strict";
import { ModelClientError } from "../src/model/types";
import {
  isTransientModelError,
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
