import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySemanticRetrievalHealthV1,
  readSemanticRetrievalOutcomeV1,
  semanticModeSatisfiedV1,
  type SemanticRetrievalOutcomeV1,
} from "../src/agent/semanticRetrievalHealth";

/** The exact payload shape `semantic_search_notes` returns. */
function searchOutput(overrides: Record<string, unknown> = {}): unknown {
  return {
    operation: "semantic_search_notes",
    mode: "hybrid_semantic",
    fallbackUsed: false,
    fallbackReason: null,
    resultCount: 4,
    coverage: {
      mode: "sampled",
      considered: 40,
      read: 4,
      skipped: 36,
      truncated: false,
      fallbackUsed: false,
      confidence: "high",
      reasons: ["live_semantic_search"],
    },
    ...overrides,
  };
}

function outcome(
  overrides: Partial<SemanticRetrievalOutcomeV1> = {},
): SemanticRetrievalOutcomeV1 {
  return {
    mode: "hybrid_semantic",
    fallbackUsed: false,
    fallbackReason: null,
    resultCount: 4,
    coverageConfidence: "high",
    coverageTruncated: false,
    ...overrides,
  };
}

test("reads the fallback truth out of a real tool payload", () => {
  const parsed = readSemanticRetrievalOutcomeV1(
    searchOutput({
      mode: "lexical_fallback",
      fallbackUsed: true,
      fallbackReason: "missing_fastembed",
      coverage: { truncated: true, confidence: "low" },
    }),
  );
  assert.equal(parsed?.mode, "lexical_fallback");
  assert.equal(parsed?.fallbackUsed, true);
  assert.equal(parsed?.fallbackReason, "missing_fastembed");
  assert.equal(parsed?.coverageTruncated, true);
  assert.equal(parsed?.coverageConfidence, "low");
});

test("a non-record payload yields no outcome rather than a false healthy one", () => {
  assert.equal(readSemanticRetrievalOutcomeV1(null), null);
  assert.equal(readSemanticRetrievalOutcomeV1("lexical_fallback"), null);
  assert.equal(readSemanticRetrievalOutcomeV1([]), null);
});

test("missing FastEmbed is blocked, names the install, and demands corroboration", () => {
  const health = classifySemanticRetrievalHealthV1(
    outcome({
      mode: "lexical_fallback",
      fallbackUsed: true,
      fallbackReason: "missing_fastembed",
    }),
  );
  assert.equal(health.status, "blocked");
  assert.equal(health.cause, "embeddings_not_installed");
  assert.equal(health.setupAction, "Install FastEmbed with: python -m pip install fastembed");
  assert.equal(health.requiresKeywordCorroboration, true);
  assert.equal(health.semanticScoringUsed, false);
  assert.match(health.message, /keyword search/iu);
});

test("an absent Python runtime points at the setting, not at pip", () => {
  for (const reason of ["missing_python", "spawn_error", "node_runtime_unavailable"]) {
    const health = classifySemanticRetrievalHealthV1(
      outcome({ fallbackUsed: true, fallbackReason: reason }),
    );
    assert.equal(health.cause, "embedding_runtime_unavailable", reason);
    assert.equal(health.status, "blocked", reason);
    assert.match(health.setupAction ?? "", /Settings/u, reason);
  }
});

test("a transient embedding failure is degraded with no busywork setup action", () => {
  const health = classifySemanticRetrievalHealthV1(
    outcome({ fallbackUsed: true, fallbackReason: "timeout" }),
  );
  assert.equal(health.cause, "embedding_call_failed");
  assert.equal(health.status, "degraded");
  assert.equal(health.setupAction, null);
  // Still keyword results, so the answer still cannot rest on them alone.
  assert.equal(health.requiresKeywordCorroboration, true);
});

test("fallback outranks truncation: one cause, and it is the one worth fixing", () => {
  // The regression this pins: the old status line said "sampled, truncated,
  // fallback, or low confidence" in a single breath, so a user whose
  // embeddings were not installed was told their result set was truncated.
  const health = classifySemanticRetrievalHealthV1(
    outcome({
      mode: "lexical_fallback",
      fallbackUsed: true,
      fallbackReason: "missing_fastembed",
      coverageTruncated: true,
      coverageConfidence: "low",
    }),
  );
  assert.equal(health.cause, "embeddings_not_installed");
});

test("a fallback mode with no fallbackUsed flag is still a fallback", () => {
  const health = classifySemanticRetrievalHealthV1(
    outcome({ mode: "lexical_fallback", fallbackUsed: false }),
  );
  assert.equal(health.semanticScoringUsed, false);
  assert.equal(health.requiresKeywordCorroboration, true);
});

test("working semantic search separates truncated, sampled, empty, and healthy", () => {
  assert.equal(
    classifySemanticRetrievalHealthV1(outcome({ coverageTruncated: true })).cause,
    "results_truncated",
  );
  assert.equal(
    classifySemanticRetrievalHealthV1(outcome({ coverageConfidence: "low" })).cause,
    "results_sampled",
  );
  assert.equal(
    classifySemanticRetrievalHealthV1(outcome({ resultCount: 0 })).cause,
    "no_matches",
  );
  const healthy = classifySemanticRetrievalHealthV1(outcome());
  assert.equal(healthy.status, "ok");
  assert.equal(healthy.cause, "healthy");
  assert.equal(healthy.requiresKeywordCorroboration, false);
});

test("a truncated but genuinely semantic result does not owe corroboration", () => {
  // Semantic scoring happened; the fix is a narrower query, not another tool.
  const health = classifySemanticRetrievalHealthV1(
    outcome({ coverageTruncated: true }),
  );
  assert.equal(health.semanticScoringUsed, true);
  assert.equal(health.requiresKeywordCorroboration, false);
});

test("only real semantic modes satisfy a lane that asked for meaning", () => {
  assert.equal(semanticModeSatisfiedV1("hybrid_semantic"), true);
  assert.equal(semanticModeSatisfiedV1("indexed_semantic"), true);
  assert.equal(semanticModeSatisfiedV1("lexical_fallback"), false);
  assert.equal(semanticModeSatisfiedV1(null), false);
});

test("a payload that reports results without a resultCount is not read as empty", () => {
  // The defect this pins: `resultCount` is the tool's summary field, and a
  // payload carrying `results` without it scored zero and classified as
  // `no_matches`. A healthy search then demanded keyword corroboration it did
  // not need, and burned a follow-up slot doing it.
  const outcome = readSemanticRetrievalOutcomeV1({
    operation: "semantic_search_notes",
    mode: "hybrid_semantic",
    fallbackUsed: false,
    results: [{ path: "People/Untitled.md", score: 0.84 }],
  });
  assert.ok(outcome);
  assert.equal(outcome.resultCount, 1);

  const health = classifySemanticRetrievalHealthV1(outcome);
  assert.equal(health.status, "ok");
  assert.equal(health.cause, "healthy");
  assert.equal(health.requiresKeywordCorroboration, false);
});

test("an empty results array is still no_matches", () => {
  const health = classifySemanticRetrievalHealthV1(
    readSemanticRetrievalOutcomeV1({
      operation: "semantic_search_notes",
      mode: "hybrid_semantic",
      fallbackUsed: false,
      results: [],
    })!,
  );
  assert.equal(health.cause, "no_matches");
  assert.equal(health.requiresKeywordCorroboration, true);
});
