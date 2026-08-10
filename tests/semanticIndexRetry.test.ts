import assert from "node:assert/strict";
import test from "node:test";
import {
  computeSemanticIndexRetryDelayMs,
  SEMANTIC_INDEX_MAX_AUTO_RETRIES,
  SEMANTIC_INDEX_RETRY_BASE_MS,
  SEMANTIC_INDEX_RETRY_MAX_DELAY_MS,
} from "../src/embeddings/semanticIndexRetry";

test("retry delay doubles per consecutive failure from the 30s base", () => {
  assert.equal(computeSemanticIndexRetryDelayMs(1), 30_000);
  assert.equal(computeSemanticIndexRetryDelayMs(2), 60_000);
  assert.equal(computeSemanticIndexRetryDelayMs(3), 120_000);
  assert.equal(computeSemanticIndexRetryDelayMs(4), 240_000);
});

test("retry delay is capped at 30 minutes and never overflows", () => {
  assert.equal(
    computeSemanticIndexRetryDelayMs(7),
    SEMANTIC_INDEX_RETRY_MAX_DELAY_MS,
  );
  assert.equal(
    computeSemanticIndexRetryDelayMs(500),
    SEMANTIC_INDEX_RETRY_MAX_DELAY_MS,
  );
  assert.equal(
    computeSemanticIndexRetryDelayMs(Number.MAX_SAFE_INTEGER),
    SEMANTIC_INDEX_RETRY_MAX_DELAY_MS,
  );
});

test("non-positive failure counts behave like the first failure", () => {
  assert.equal(computeSemanticIndexRetryDelayMs(0), SEMANTIC_INDEX_RETRY_BASE_MS);
  assert.equal(computeSemanticIndexRetryDelayMs(-3), SEMANTIC_INDEX_RETRY_BASE_MS);
});

test("the auto-retry allowance is small enough to stop a runaway rebuild quickly", () => {
  // Five attempts at exponential backoff means a persistently failing rebuild
  // runs at most 5 whole-vault embeds before suspending — not one every ~3.5
  // minutes for the lifetime of the session.
  assert.ok(SEMANTIC_INDEX_MAX_AUTO_RETRIES <= 8);
  assert.ok(SEMANTIC_INDEX_MAX_AUTO_RETRIES >= 3);
});
