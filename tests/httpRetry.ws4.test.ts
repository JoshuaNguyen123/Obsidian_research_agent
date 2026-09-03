import assert from "node:assert/strict";
import test from "node:test";
import type { HttpResponse, HttpTransport } from "../src/model/types";
import { isAbortError, requestWithRetry } from "../src/tools/httpRetry";

function throwingTransport(
  sequence: Array<Error | { status: number }>,
): { transport: HttpTransport; calls: () => number } {
  let index = 0;
  return {
    transport: async (): Promise<HttpResponse> => {
      const next = sequence[Math.min(index, sequence.length - 1)]!;
      index += 1;
      if (next instanceof Error) {
        throw next;
      }
      return { status: next.status, headers: {}, json: { attempt: index } };
    },
    calls: () => index,
  };
}

test("requestWithRetry retries a thrown network reset then recovers", async () => {
  const seq = throwingTransport([
    new Error("read ECONNRESET"),
    new Error("getaddrinfo ENOTFOUND example.test"),
    { status: 200 },
  ]);
  const response = await requestWithRetry(
    seq.transport,
    { url: "https://example.test" },
    { retryDelaysMs: [1, 1] },
  );
  assert.equal(response.status, 200);
  assert.equal(seq.calls(), 3);
});

test("requestWithRetry rethrows after the same two-retry budget", async () => {
  const persistent = new Error("socket hang up");
  const seq = throwingTransport([persistent, persistent, persistent, persistent]);
  await assert.rejects(
    requestWithRetry(
      seq.transport,
      { url: "https://example.test" },
      { retryDelaysMs: [1, 1] },
    ),
    /socket hang up/u,
  );
  assert.equal(seq.calls(), 3);
});

test("requestWithRetry never retries AbortError", async () => {
  const abort = new DOMException("The operation was aborted.", "AbortError");
  const seq = throwingTransport([abort, { status: 200 }]);
  await assert.rejects(
    requestWithRetry(
      seq.transport,
      { url: "https://example.test" },
      { retryDelaysMs: [1, 1] },
    ),
    (error: unknown) => isAbortError(error),
  );
  assert.equal(seq.calls(), 1);
});

test("requestWithRetry does not retry a thrown error after user cancel", async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport: HttpTransport = async () => {
    calls += 1;
    controller.abort();
    throw new Error("ECONNRESET");
  };
  await assert.rejects(
    requestWithRetry(
      transport,
      { url: "https://example.test", abortSignal: controller.signal },
      { retryDelaysMs: [1, 1] },
    ),
    /ECONNRESET/u,
  );
  assert.equal(calls, 1);
});

test("isAbortError recognizes DOMException and Error abort names", () => {
  assert.equal(
    isAbortError(new DOMException("The operation was aborted.", "AbortError")),
    true,
  );
  const named = new Error("cancelled");
  named.name = "AbortError";
  assert.equal(isAbortError(named), true);
  assert.equal(isAbortError(new Error("ECONNRESET")), false);
  assert.equal(isAbortError("AbortError"), false);
});
