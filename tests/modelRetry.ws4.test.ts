import assert from "node:assert/strict";
import test from "node:test";
import { ModelClientError } from "../src/model/types";
import {
  MAX_INVALID_RESPONSE_RETRIES,
  MAX_MODEL_REQUEST_TIMEOUT_RETRIES,
  isInvalidResponseModelError,
  isMalformedProviderBodyError,
  isTransientModelError,
  withModelRetry,
} from "../src/model/retry";

test("invalid_response stays non-transient for fallback classifiers", () => {
  const error = new ModelClientError("invalid_response", "truncated SSE");
  assert.equal(isTransientModelError(error), false);
  assert.equal(isInvalidResponseModelError(error), true);
  assert.equal(
    isInvalidResponseModelError({
      name: "ModelClientError",
      category: "invalid_response",
    }),
    true,
  );
});

test("withModelRetry re-requests a malformed provider body exactly once", async () => {
  let attempts = 0;
  const retries: number[] = [];
  const result = await withModelRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ModelClientError("invalid_response", "Unexpected end of JSON");
      }
      return "recovered";
    },
    {
      policy: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 },
      onRetry: (attempt) => retries.push(attempt),
    },
  );
  assert.equal(result, "recovered");
  assert.equal(attempts, 1 + MAX_INVALID_RESPONSE_RETRIES);
  assert.deepEqual(retries, [2]);
});

test("withModelRetry fails fast when every provider body is malformed", async () => {
  let attempts = 0;
  await assert.rejects(
    withModelRetry(
      async () => {
        attempts += 1;
        throw new ModelClientError("invalid_response", "truncated SSE");
      },
      { policy: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 } },
    ),
    /truncated SSE/u,
  );
  assert.equal(attempts, 1 + MAX_INVALID_RESPONSE_RETRIES);
});

test("host policy invalid_response is not a provider-body retry", async () => {
  const offTopic = new ModelClientError(
    "invalid_response",
    "Stopped model output because it drifted off topic from the current mission.",
  );
  const nonEnglish = new ModelClientError(
    "invalid_response",
    "Model produced non-English output.",
  );
  assert.equal(isMalformedProviderBodyError(offTopic), false);
  assert.equal(isMalformedProviderBodyError(nonEnglish), false);
  assert.equal(
    isMalformedProviderBodyError(
      new ModelClientError("invalid_response", "Unexpected end of JSON"),
    ),
    true,
  );

  let attempts = 0;
  await assert.rejects(
    withModelRetry(
      async () => {
        attempts += 1;
        throw offTopic;
      },
      { policy: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 } },
    ),
    /drifted off topic/u,
  );
  assert.equal(attempts, 1);
});

test("timeout retry bound is unchanged next to invalid_response", async () => {
  let attempts = 0;
  await assert.rejects(
    withModelRetry(
      async () => {
        attempts += 1;
        throw new ModelClientError("network", "Request timed out after 75000ms.");
      },
      { policy: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 } },
    ),
  );
  assert.equal(attempts, 1 + MAX_MODEL_REQUEST_TIMEOUT_RETRIES);
});
