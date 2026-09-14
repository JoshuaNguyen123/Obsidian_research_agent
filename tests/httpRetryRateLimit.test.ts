import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TOOL_RETRY_AFTER_MS,
  requestWithRetry,
  resolveRetryDelayMs,
} from "../src/tools/httpRetry";
import type { HttpRequest, HttpResponse } from "../src/model/types";

function response(
  status: number,
  headers: Record<string, string> = {},
): HttpResponse {
  return { status, headers, text: "", json: undefined } as unknown as HttpResponse;
}

const request: HttpRequest = {
  url: "https://api.crossref.org/works/10.1000/x",
  method: "GET",
  headers: {},
  throw: false,
} as unknown as HttpRequest;

test("a rate limit waits as long as the server asked, not the default backoff", () => {
  // 400 ms of backoff against a server asking for two seconds used to mean the
  // retry landed inside the same window and failed again.
  assert.equal(
    resolveRetryDelayMs(400, response(429, { "Retry-After": "2" }), MAX_TOOL_RETRY_AFTER_MS),
    2_000,
  );
  // Header casing is the server's choice.
  assert.equal(
    resolveRetryDelayMs(400, response(429, { "retry-after": "1" }), MAX_TOOL_RETRY_AFTER_MS),
    1_000,
  );
  // A shorter Retry-After never shortens the backoff.
  assert.equal(
    resolveRetryDelayMs(1_200, response(429, { "Retry-After": "0" }), MAX_TOOL_RETRY_AFTER_MS),
    1_200,
  );
  // No header: unchanged behavior.
  assert.equal(resolveRetryDelayMs(400, response(503), MAX_TOOL_RETRY_AFTER_MS), 400);
});

test("a wait longer than the cap ends the retries instead of stalling the step", () => {
  assert.equal(
    resolveRetryDelayMs(400, response(429, { "Retry-After": "3600" }), MAX_TOOL_RETRY_AFTER_MS),
    null,
  );
});

test("an HTTP-date Retry-After is honored as an interval", () => {
  const at = new Date(Date.now() + 3_000).toUTCString();
  const waitMs = resolveRetryDelayMs(
    400,
    response(429, { "Retry-After": at }),
    MAX_TOOL_RETRY_AFTER_MS,
  );
  assert.ok(waitMs !== null && waitMs >= 1_500 && waitMs <= 3_500, String(waitMs));
});

test("the retried request succeeds after honoring the server's wait", async () => {
  const waits: number[] = [];
  let calls = 0;
  const started = Date.now();
  const result = await requestWithRetry(
    async () => {
      calls += 1;
      waits.push(Date.now() - started);
      return calls === 1 ? response(429, { "Retry-After": "0.05" }) : response(200);
    },
    request,
    { retryDelaysMs: [10], maxRetryAfterMs: 1_000 },
  );
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.ok(waits[1]! >= 45, `second attempt waited ${waits[1]}ms`);
});

test("a rate limit past the cap is returned without another attempt", async () => {
  let calls = 0;
  const result = await requestWithRetry(
    async () => {
      calls += 1;
      return response(429, { "Retry-After": "600" });
    },
    request,
    { retryDelaysMs: [10, 20], maxRetryAfterMs: 1_000 },
  );
  assert.equal(result.status, 429);
  assert.equal(calls, 1);
});

test("an aborted request is never retried", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await requestWithRetry(
    async () => {
      calls += 1;
      return response(503);
    },
    { ...request, abortSignal: controller.signal } as HttpRequest,
    { retryDelaysMs: [10] },
  );
  assert.equal(result.status, 503);
  assert.equal(calls, 1);
});
