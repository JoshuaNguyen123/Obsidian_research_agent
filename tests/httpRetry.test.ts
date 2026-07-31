import assert from "node:assert/strict";
import test from "node:test";
import type { HttpResponse, HttpTransport } from "../src/model/types";
import { requestWithRetry } from "../src/tools/httpRetry";

function sequenceTransport(statuses: number[]): {
  transport: HttpTransport;
  calls: () => number;
} {
  let index = 0;
  return {
    transport: async (): Promise<HttpResponse> => {
      const status = statuses[Math.min(index, statuses.length - 1)]!;
      index += 1;
      return { status, headers: {}, json: { attempt: index } };
    },
    calls: () => index,
  };
}

test("requestWithRetry retries a 429 then returns the recovered response", async () => {
  const seq = sequenceTransport([429, 429, 200]);
  const response = await requestWithRetry(
    seq.transport,
    { url: "https://example.test" },
    { retryDelaysMs: [1, 1] },
  );
  assert.equal(response.status, 200);
  assert.equal(seq.calls(), 3);
});

test("requestWithRetry does not retry a plain 4xx caller error", async () => {
  const seq = sequenceTransport([404, 200]);
  const response = await requestWithRetry(
    seq.transport,
    { url: "https://example.test" },
    { retryDelaysMs: [1, 1] },
  );
  assert.equal(response.status, 404);
  assert.equal(seq.calls(), 1);
});

test("requestWithRetry gives up after exhausting the delay budget", async () => {
  const seq = sequenceTransport([503, 503, 503, 503]);
  const response = await requestWithRetry(
    seq.transport,
    { url: "https://example.test" },
    { retryDelaysMs: [1, 1] },
  );
  assert.equal(response.status, 503);
  // Initial attempt plus two retries = three calls.
  assert.equal(seq.calls(), 3);
});
