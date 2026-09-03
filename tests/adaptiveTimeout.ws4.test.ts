import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelRequestTimeoutMs } from "../src/model/createModelClient";
import {
  DEFAULT_PLANNER_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_REQUEST_TIMEOUT_MS,
} from "../src/model/requestTimeoutDefaults";

test("implicit default splits planner and streamed synthesis ceilings", () => {
  assert.equal(DEFAULT_STREAM_REQUEST_TIMEOUT_MS, 180_000);
  assert.equal(DEFAULT_PLANNER_REQUEST_TIMEOUT_MS, 75_000);
  assert.equal(
    resolveModelRequestTimeoutMs({
      requestTimeoutMs: DEFAULT_STREAM_REQUEST_TIMEOUT_MS,
      streaming: false,
    }),
    DEFAULT_PLANNER_REQUEST_TIMEOUT_MS,
  );
  assert.equal(
    resolveModelRequestTimeoutMs({
      requestTimeoutMs: DEFAULT_STREAM_REQUEST_TIMEOUT_MS,
      streaming: true,
    }),
    DEFAULT_STREAM_REQUEST_TIMEOUT_MS,
  );
});

test("explicit user timeout wins for planner and stream alike", () => {
  for (const timeoutMs of [30_000, 90_000, 150_000, 600_000]) {
    assert.equal(
      resolveModelRequestTimeoutMs({ requestTimeoutMs: timeoutMs, streaming: false }),
      timeoutMs,
    );
    assert.equal(
      resolveModelRequestTimeoutMs({ requestTimeoutMs: timeoutMs, streaming: true }),
      timeoutMs,
    );
  }
});

test("invalid configured timeouts fall back to the implicit split", () => {
  assert.equal(
    resolveModelRequestTimeoutMs({ requestTimeoutMs: 0, streaming: false }),
    DEFAULT_PLANNER_REQUEST_TIMEOUT_MS,
  );
  assert.equal(
    resolveModelRequestTimeoutMs({ requestTimeoutMs: Number.NaN, streaming: true }),
    DEFAULT_STREAM_REQUEST_TIMEOUT_MS,
  );
  assert.equal(
    resolveModelRequestTimeoutMs({ requestTimeoutMs: -1, streaming: false }),
    DEFAULT_PLANNER_REQUEST_TIMEOUT_MS,
  );
});
