import test from "node:test";
import assert from "node:assert/strict";
import { ModelClientError } from "../src/model/types";
import {
  classifyModelFallback,
  createModelFallbackEvidence,
  isEligibleModelFallbackFailure,
  isModelFallbackEnabled,
  runModelFallbackOnce,
  specialistIsDistinctFromPrimary,
} from "../src/model/modelFallback";

const primary = {
  model: "deepseek-v4-pro",
  provider: "ollama" as const,
  baseUrl: "https://ollama.com/api",
};
const specialist = {
  model: "minimax-m3:cloud",
  provider: "ollama" as const,
  baseUrl: "https://ollama.com/api",
};

function eligibleInput(
  error: unknown,
  overrides: Partial<Parameters<typeof classifyModelFallback>[0]> = {},
) {
  return {
    enabled: true,
    alreadyUsed: false,
    specialistAvailable: true,
    primary,
    specialist,
    error,
    ...overrides,
  };
}

test("modelFallbackEnabled is off unless the untyped flag is true", () => {
  assert.equal(isModelFallbackEnabled(undefined), false);
  assert.equal(isModelFallbackEnabled({}), false);
  assert.equal(isModelFallbackEnabled({ modelFallbackEnabled: false }), false);
  assert.equal(isModelFallbackEnabled({ modelFallbackEnabled: true }), true);
});

test("specialist must be distinct from the primary slot", () => {
  assert.equal(specialistIsDistinctFromPrimary(primary, specialist), true);
  assert.equal(specialistIsDistinctFromPrimary(primary, primary), false);
  assert.equal(
    specialistIsDistinctFromPrimary(primary, {
      ...primary,
      baseUrl: "https://other.example/api",
    }),
    true,
  );
});

test("fallback classifier allows 5xx, network, and provider timeout only", () => {
  assert.equal(
    isEligibleModelFallbackFailure(
      new ModelClientError("api", "server", { status: 500 }),
    ),
    true,
  );
  assert.equal(
    isEligibleModelFallbackFailure(
      new ModelClientError("api", "server", { status: 503 }),
    ),
    true,
  );
  assert.equal(
    isEligibleModelFallbackFailure(new ModelClientError("network", "offline")),
    true,
  );
  assert.equal(
    isEligibleModelFallbackFailure(
      new ModelClientError("network", "Request timed out after 60000ms"),
    ),
    true,
  );
});

test("fallback classifier refuses auth, missing key, 401/403, and budget exhaustion", () => {
  assert.equal(
    isEligibleModelFallbackFailure(new ModelClientError("auth", "bad key")),
    false,
  );
  assert.equal(
    isEligibleModelFallbackFailure(
      new ModelClientError("missing_api_key", "no key"),
    ),
    false,
  );
  assert.equal(
    isEligibleModelFallbackFailure(
      new ModelClientError("api", "unauthorized", { status: 401 }),
    ),
    false,
  );
  assert.equal(
    isEligibleModelFallbackFailure(
      new ModelClientError("api", "forbidden", { status: 403 }),
    ),
    false,
  );
  assert.equal(
    isEligibleModelFallbackFailure(
      new ModelClientError("provider_budget_exhausted", "quota"),
    ),
    false,
  );
  assert.equal(
    isEligibleModelFallbackFailure(
      new ModelClientError("rate_limit", "slow down", { status: 429 }),
    ),
    false,
  );
  assert.equal(
    classifyModelFallback(
      eligibleInput(new ModelClientError("auth", "bad key")),
    ).reason,
    "ineligible_failure",
  );
});

test("fallback classifier skips when flag is off or specialist is not ready", () => {
  const error = new ModelClientError("api", "server", { status: 500 });
  assert.equal(
    classifyModelFallback(eligibleInput(error, { enabled: false })).reason,
    "flag_off",
  );
  assert.equal(
    classifyModelFallback(eligibleInput(error, { alreadyUsed: true })).reason,
    "already_used",
  );
  assert.equal(
    classifyModelFallback(
      eligibleInput(error, { specialistAvailable: false }),
    ).reason,
    "specialist_unavailable",
  );
  assert.equal(
    classifyModelFallback(
      eligibleInput(error, { specialist: primary }),
    ).reason,
    "specialist_not_distinct",
  );
});

test("runModelFallbackOnce reissues once and records both model ids", async () => {
  const error = new ModelClientError("api", "server", { status: 500 });
  let calls = 0;
  const first = await runModelFallbackOnce({
    ...eligibleInput(error),
    reissue: async () => {
      calls += 1;
      return "ok";
    },
  });
  assert.equal(first.status, "used");
  if (first.status === "used") {
    assert.equal(first.value, "ok");
    assert.equal(first.evidence.kind, "tool_result");
    assert.equal(first.evidence.title, "model_fallback_used");
    assert.match(first.evidence.summary, /deepseek-v4-pro/);
    assert.match(first.evidence.summary, /minimax-m3:cloud/);
  }
  assert.equal(calls, 1);

  const second = await runModelFallbackOnce({
    ...eligibleInput(error, { alreadyUsed: true }),
    reissue: async () => {
      calls += 1;
      return "again";
    },
  });
  assert.equal(second.status, "skipped");
  if (second.status === "skipped") {
    assert.equal(second.reason, "already_used");
  }
  assert.equal(calls, 1);
});

test("flag off does not make an extra model call", async () => {
  let calls = 0;
  const result = await runModelFallbackOnce({
    ...eligibleInput(new ModelClientError("network", "offline"), {
      enabled: false,
    }),
    reissue: async () => {
      calls += 1;
      return "should-not-run";
    },
  });
  assert.equal(result.status, "skipped");
  if (result.status === "skipped") {
    assert.equal(result.reason, "flag_off");
  }
  assert.equal(calls, 0);
});

test("createModelFallbackEvidence is a tool_result titled model_fallback_used", () => {
  const evidence = createModelFallbackEvidence({
    primaryModel: "lead-model",
    specialistModel: "specialist-model",
  });
  assert.equal(evidence.kind, "tool_result");
  assert.equal(evidence.title, "model_fallback_used");
  assert.equal(
    evidence.summary,
    "Fell back from lead-model to specialist-model.",
  );
});
