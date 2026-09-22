import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ENDPOINT_BREAKER_FAILURE_THRESHOLD,
  isCircuitOpenError,
  isEndpointBreakerCountedFailure,
  longestModelEndpointBreakerRetryAfterMs,
  ModelEndpointBreaker,
  resetModelEndpointBreakersForTests,
  resolveModelEndpointBreaker,
  wrapModelClientWithEndpointBreaker,
} from "../src/model/endpointBreaker";
import { isTransientModelError, withModelRetry } from "../src/model/retry";
import { isEligibleModelFallbackFailure } from "../src/model/modelFallback";
import {
  ModelClientError,
  type ModelChatResponse,
  type ModelClient,
} from "../src/model/types";

/*
 * Model-endpoint circuit breaker.
 *
 * Per-call retries already exist; this pins the cross-call memory: a dead
 * endpoint stops being re-dialled at full timeout cost on every step, while
 * failures that say nothing about the endpoint (auth, rate limits, our own
 * policy refusals, cancellations) never trip it.
 */

const outage = () =>
  new ModelClientError("network", "request to https://x timed out after 75000ms");
const serverError = () => new ModelClientError("api", "Internal Server Error", { status: 503 });

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function reply(): ModelChatResponse {
  return {
    message: { role: "assistant", content: "ok" },
    toolCalls: [],
    raw: {},
  } as unknown as ModelChatResponse;
}

test("only endpoint-health failures count", () => {
  assert.equal(isEndpointBreakerCountedFailure(outage()), true);
  assert.equal(isEndpointBreakerCountedFailure(serverError()), true);
  assert.equal(
    isEndpointBreakerCountedFailure(
      new ModelClientError("invalid_response", "OpenAI-compatible API returned invalid streaming JSON."),
    ),
    true,
    "a malformed provider body is the endpoint misbehaving",
  );
  assert.equal(
    isEndpointBreakerCountedFailure(new ModelClientError("auth", "401", { status: 401 })),
    false,
  );
  assert.equal(
    isEndpointBreakerCountedFailure(new ModelClientError("rate_limit", "429", { status: 429 })),
    false,
    "a rate limit is the provider asking for patience, not a dead endpoint",
  );
  assert.equal(
    isEndpointBreakerCountedFailure(new ModelClientError("provider_budget_exhausted", "quota")),
    false,
  );
  assert.equal(
    isEndpointBreakerCountedFailure(
      new ModelClientError("invalid_response", "Model produced non-English output."),
    ),
    false,
    "host-policy refusals are our verdicts, not the provider's",
  );
  assert.equal(
    isEndpointBreakerCountedFailure(new ModelClientError("network", "Request cancelled.")),
    false,
  );
  assert.equal(
    isEndpointBreakerCountedFailure(Object.assign(new Error("aborted"), { name: "AbortError" })),
    false,
  );
});

test("opens after the threshold, fails fast, then admits exactly one probe after the cooldown", () => {
  const time = clock();
  const breaker = new ModelEndpointBreaker("ollama|https://ollama.com/api|m", {
    cooldownMs: 30_000,
    maxCooldownMs: 120_000,
    now: time.now,
  });
  for (let index = 0; index < DEFAULT_ENDPOINT_BREAKER_FAILURE_THRESHOLD - 1; index += 1) {
    breaker.admit();
    breaker.recordFailure(outage());
    assert.equal(breaker.snapshot().state, "closed");
  }
  breaker.admit();
  breaker.recordFailure(serverError());
  assert.equal(breaker.snapshot().state, "open");

  assert.throws(
    () => breaker.admit(),
    (error: unknown) => {
      assert.ok(error instanceof ModelClientError);
      assert.equal(error.category, "network");
      assert.equal(isCircuitOpenError(error), true);
      // The fail-fast error must not be retried by the per-call ladder ...
      assert.equal(isTransientModelError(error), false);
      // ... but the specialist fallback may still try ITS endpoint.
      assert.equal(isEligibleModelFallbackFailure(error), true);
      assert.match(error.message, /paused after 5 consecutive provider failures/);
      return true;
    },
  );
  assert.equal(breaker.snapshot().retryAfterMs, 30_000);

  time.advance(29_999);
  assert.throws(() => breaker.admit(), (error: unknown) => isCircuitOpenError(error));
  time.advance(1);
  // Half-open: the first caller is the probe, the second waits for it.
  breaker.admit();
  assert.equal(breaker.snapshot().state, "half_open");
  assert.throws(() => breaker.admit(), (error: unknown) => isCircuitOpenError(error));

  // A failed probe re-opens with a doubled cooldown.
  breaker.recordFailure(outage());
  assert.equal(breaker.snapshot().state, "open");
  assert.equal(breaker.snapshot().cooldownMs, 60_000);
  time.advance(60_000);
  breaker.admit();
  breaker.recordSuccess();
  assert.equal(breaker.snapshot().state, "closed");
  assert.equal(breaker.snapshot().consecutiveFailures, 0);
  assert.equal(breaker.snapshot().cooldownMs, 30_000, "success restores the base cooldown");
});

test("a non-endpoint failure neither counts nor resets, and a rate limit mid-streak is neutral", () => {
  const breaker = new ModelEndpointBreaker("k", { failureThreshold: 3, now: clock().now });
  breaker.admit();
  breaker.recordFailure(outage());
  breaker.admit();
  breaker.recordFailure(new ModelClientError("rate_limit", "429", { status: 429 }));
  breaker.admit();
  breaker.recordFailure(new ModelClientError("auth", "401", { status: 401 }));
  assert.equal(breaker.snapshot().consecutiveFailures, 1);
  breaker.admit();
  breaker.recordFailure(outage());
  breaker.admit();
  breaker.recordFailure(outage());
  assert.equal(breaker.snapshot().state, "open");
});

test("the wrapped client passes every chat and stream call through the breaker", async () => {
  const time = clock();
  const breaker = new ModelEndpointBreaker("k", {
    failureThreshold: 2,
    cooldownMs: 10_000,
    now: time.now,
  });
  let calls = 0;
  const inner: ModelClient = {
    descriptor: {
      provider: "ollama",
      model: "m",
      endpointCategory: "ollama_cloud",
      transportKind: "test_mock",
    } as ModelClient["descriptor"],
    chat: async () => {
      calls += 1;
      throw outage();
    },
    streamChat: async () => {
      calls += 1;
      throw serverError();
    },
  };
  const wrapped = wrapModelClientWithEndpointBreaker(inner, breaker);
  assert.equal(wrapped.descriptor?.model, "m");
  await assert.rejects(() => wrapped.chat({ messages: [] }));
  await assert.rejects(() => wrapped.streamChat({ messages: [] }));
  assert.equal(calls, 2);
  // Open now: the inner client is never dialled while the breaker is open.
  await assert.rejects(
    () => wrapped.chat({ messages: [] }),
    (error: unknown) => isCircuitOpenError(error),
  );
  assert.equal(calls, 2);

  // withModelRetry makes exactly one attempt on a circuit-open error.
  let attempts = 0;
  await assert.rejects(
    () =>
      withModelRetry(async () => {
        attempts += 1;
        return wrapped.chat({ messages: [] });
      }),
    (error: unknown) => isCircuitOpenError(error),
  );
  assert.equal(attempts, 1);

  // After the cooldown one probe reaches the endpoint and a success closes it.
  time.advance(10_000);
  inner.chat = async () => {
    calls += 1;
    return reply();
  };
  const response = await wrapped.chat({ messages: [] });
  assert.equal(response.message.content, "ok");
  assert.equal(breaker.snapshot().state, "closed");
});

test("the registry hands out one breaker per endpoint identity", () => {
  resetModelEndpointBreakersForTests();
  const first = resolveModelEndpointBreaker("ollama|https://ollama.com/api|glm");
  const same = resolveModelEndpointBreaker("ollama|https://ollama.com/api|glm");
  const other = resolveModelEndpointBreaker("ollama|https://ollama.com/api|deepseek");
  assert.equal(first, same);
  assert.notEqual(first, other);
  resetModelEndpointBreakersForTests();
  assert.notEqual(resolveModelEndpointBreaker("ollama|https://ollama.com/api|glm"), first);
});

test("the registry reports the longest wait any open endpoint still demands", () => {
  // A host that continues a mission on its own after an outage reads this
  // before it continues; a continuation started inside the cooldown fails
  // fast on the same breaker without reaching the provider.
  resetModelEndpointBreakersForTests();
  assert.equal(longestModelEndpointBreakerRetryAfterMs(), 0);
  let now = 1_000;
  const lead = resolveModelEndpointBreaker("lead", {
    failureThreshold: 2,
    cooldownMs: 30_000,
    now: () => now,
  });
  const specialist = resolveModelEndpointBreaker("specialist", {
    failureThreshold: 2,
    cooldownMs: 30_000,
    now: () => now,
  });
  lead.recordFailure(outage());
  lead.recordFailure(outage());
  assert.equal(lead.snapshot().state, "open");
  assert.equal(specialist.snapshot().state, "closed");
  assert.equal(longestModelEndpointBreakerRetryAfterMs(), 30_000);
  now += 10_000;
  assert.equal(longestModelEndpointBreakerRetryAfterMs(), 20_000);
  now += 30_000;
  assert.equal(longestModelEndpointBreakerRetryAfterMs(), 0);
  resetModelEndpointBreakersForTests();
});
