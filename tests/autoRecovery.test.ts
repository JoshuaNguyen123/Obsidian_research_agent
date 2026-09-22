import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_RECOVERY_BASE_DELAY_MS,
  decideAutoRecovery,
  describeAutoRecoveryReasonV1,
  MAX_AUTO_RECOVERIES_PER_MISSION,
  MAX_AUTO_RECOVERY_WAIT_MS,
  planAutoRecoveryWaitMsV1,
  type AutoRecoveryReason,
} from "../src/agent/autoRecovery";

const transient = { code: "provider_http_503", message: "HTTP 503 from the provider." };

function base(overrides: Partial<Parameters<typeof decideAutoRecovery>[0]> = {}) {
  return {
    stopReason: "error" as const,
    stopDetail: "unreported_terminal_error",
    lastError: transient,
    recoveriesUsed: 0,
    abortRequested: false,
    runId: "run-1",
    ...overrides,
  };
}

test("a transient provider error recommends one recovery segment", () => {
  assert.deepEqual(decideAutoRecovery(base()), {
    recommended: true,
    reason: "transient_provider_error",
  });
  // A rate limit and a timeout are transient by the same shared predicate.
  assert.equal(
    decideAutoRecovery(base({ lastError: { code: "rate_limited", message: "429 too many requests" } })).recommended,
    true,
  );
  assert.equal(
    decideAutoRecovery(base({ lastError: { code: "model_timeout", message: "The request timed out." } })).recommended,
    true,
  );
});

test("the cap holds at two recoveries per mission", () => {
  assert.equal(MAX_AUTO_RECOVERIES_PER_MISSION, 2);
  assert.equal(decideAutoRecovery(base({ recoveriesUsed: 1 })).recommended, true);
  assert.deepEqual(decideAutoRecovery(base({ recoveriesUsed: 2 })), {
    recommended: false,
    reason: "recovery_cap",
  });
  assert.equal(
    decideAutoRecovery(base({ recoveriesUsed: 0, maxRecoveries: 0 })).reason,
    "recovery_cap",
  );
});

test("credentials, approvals, and unsafe requests are never auto-recovered", () => {
  for (const error of [
    { code: "missing_api_key", message: "Set an API key in settings." },
    { code: "provider_auth", message: "401 unauthorized from provider" },
    { code: "approval_denied", message: "Tool was not run because approval was denied." },
    { code: "unsafe_path", message: "Refused unsafe path." },
  ]) {
    assert.deepEqual(
      decideAutoRecovery(base({ lastError: error })),
      { recommended: false, reason: "not_transient" },
      error.code,
    );
  }
  // No error trace at all is not evidence of a transient cause.
  assert.equal(decideAutoRecovery(base({ lastError: null })).reason, "not_transient");
});

test("graph blockers and non-error stops keep their operator-driven Continue", () => {
  assert.deepEqual(
    decideAutoRecovery(
      base({ stopDetail: "Mission graph stopped at tool-03: mission_graph_authority_blocked" }),
    ),
    { recommended: false, reason: "not_provider_error" },
  );
  assert.deepEqual(
    decideAutoRecovery(base({ stopDetail: "orchestration_deadlock" })),
    { recommended: false, reason: "not_provider_error" },
  );
  for (const stopReason of ["budget", "final", "write_completed", "user_stopped", "clarifying_question"] as const) {
    assert.deepEqual(decideAutoRecovery(base({ stopReason })), {
      recommended: false,
      reason: "not_error",
    });
  }
});

test("an aborted mission or one without a run id is never continued", () => {
  assert.deepEqual(decideAutoRecovery(base({ abortRequested: true })), {
    recommended: false,
    reason: "aborted",
  });
  assert.deepEqual(decideAutoRecovery(base({ runId: null })), {
    recommended: false,
    reason: "no_run_id",
  });
});

test("a paused endpoint is waited for, unless the pause outlasts the recovery wait", () => {
  // Inside the wait: recover, and the wait covers the breaker's own clock.
  assert.deepEqual(
    decideAutoRecovery(base({ providerRetryAfterMs: 29_000 })),
    { recommended: true, reason: "transient_provider_error" },
  );
  assert.equal(
    planAutoRecoveryWaitMsV1({ recovery: 1, providerRetryAfterMs: 29_000 }),
    29_250,
  );
  // No breaker open: a small doubling backoff, never zero.
  assert.equal(planAutoRecoveryWaitMsV1({ recovery: 1, providerRetryAfterMs: 0 }), AUTO_RECOVERY_BASE_DELAY_MS);
  assert.equal(planAutoRecoveryWaitMsV1({ recovery: 2, providerRetryAfterMs: 0 }), AUTO_RECOVERY_BASE_DELAY_MS * 2);
  // The wait never exceeds the cap, and a pause past the cap refuses instead
  // of starting a continuation that would fail fast on the breaker.
  assert.equal(
    planAutoRecoveryWaitMsV1({ recovery: 1, providerRetryAfterMs: MAX_AUTO_RECOVERY_WAIT_MS }),
    MAX_AUTO_RECOVERY_WAIT_MS,
  );
  assert.deepEqual(
    decideAutoRecovery(base({ providerRetryAfterMs: MAX_AUTO_RECOVERY_WAIT_MS })),
    { recommended: false, reason: "provider_paused" },
  );
  // The pause refusal comes after the cap refusal: a mission out of
  // recoveries says so, whatever the breaker is doing.
  assert.equal(
    decideAutoRecovery(base({ recoveriesUsed: MAX_AUTO_RECOVERIES_PER_MISSION, providerRetryAfterMs: 999_999 })).reason,
    "recovery_cap",
  );
});

test("every recovery reason has one plain sentence for Run Details", () => {
  const reasons: AutoRecoveryReason[] = [
    "transient_provider_error",
    "aborted",
    "no_run_id",
    "not_error",
    "not_provider_error",
    "not_transient",
    "provider_paused",
    "recovery_cap",
  ];
  const sentences = new Set<string>();
  for (const reason of reasons) {
    const sentence = describeAutoRecoveryReasonV1(reason);
    assert.match(sentence, /^[a-z]/, `${reason} reads as a clause after "No automatic recovery:"`);
    assert.doesNotMatch(sentence, /_/, `${reason} carries no identifier`);
    sentences.add(sentence);
  }
  assert.equal(sentences.size, reasons.length, "each reason is distinguishable");
  assert.match(
    describeAutoRecoveryReasonV1("recovery_cap"),
    new RegExp(String(MAX_AUTO_RECOVERIES_PER_MISSION)),
  );
});
