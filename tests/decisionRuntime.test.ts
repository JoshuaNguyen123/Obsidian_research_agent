import test from "node:test";
import assert from "node:assert/strict";
import { createDecisionRuntimeV1, normalizeDecisionCallRecordsV1, summarizeDecisionRecordsV1 } from "../src/decisions/decisionRuntime";
import {
  DECISION_PROMOTION_MANIFEST_V1,
  normalizeDecisionModelModeV1,
  promotionManifestForSettingsV1,
  resolveDecisionComponentModeV1,
  resolveDecisionEndpointV1,
} from "../src/decisions/decisionSettings";
import {
  JEV_DECISION_ENDPOINT_V1,
  type DecisionClient,
  type DecisionRequestV1,
  type DecisionResultV1,
} from "../src/decisions/decisionClient";
import { createObservableModelClient, type ModelCallEvidenceV1 } from "../src/model/modelCallEvidence";
import type { HttpRequest, ModelClient } from "../src/model/types";

const REQUEST: DecisionRequestV1 = {
  purpose: "mission_assessment",
  templateVersion: "t-v1",
  state: { mission: "Write a brief on tides, and back it up with sources." },
  questions: {
    needs_web: {
      type: "noul",
      instructions: "Does the mission ask for web sources?",
      criteria: { true: "yes", false: "no" },
    },
  },
};

const PROMOTED = {
  mission_routing: { promoted: true, reason: "test" },
  claim_support: { promoted: true, reason: "test" },
} as const;

function answered(overrides: Partial<Extract<DecisionResultV1, { status: "answered" }>> = {}): DecisionResultV1 {
  return {
    status: "answered",
    purpose: "mission_assessment",
    templateVersion: "t-v1",
    inputFingerprint: "sha256:x",
    requestedModel: "typesafe/jev-1.13",
    reportedModel: "typesafe/jev-1.13-20260917",
    responseId: "gen-1",
    answers: { needs_web: { type: "noul", noul: 0.97 } },
    invalidAnswers: [],
    usage: { inputTokens: 120, outputTokens: 9, cost: 0.00001 },
    durationMs: 180,
    ...overrides,
  };
}

function unavailable(reason: Extract<DecisionResultV1, { status: "unavailable" }>["reason"]): DecisionResultV1 {
  return {
    status: "unavailable",
    purpose: "mission_assessment",
    templateVersion: "t-v1",
    inputFingerprint: "sha256:x",
    requestedModel: "typesafe/jev-1.13",
    reason,
    httpStatus: null,
    detail: reason,
    durationMs: 2_000,
  };
}

function scriptedClient(results: DecisionResultV1[], calls: DecisionRequestV1[] = []): DecisionClient {
  return {
    model: "typesafe/jev-1.13",
    endpoint: JEV_DECISION_ENDPOINT_V1,
    async decide(request) {
      calls.push(request);
      const next = results.shift();
      if (!next) throw new Error("unexpected decision call");
      return next;
    },
  };
}

const neverTransport = async (_request: HttpRequest) => {
  throw new Error("transport must not be used");
};

test("mode normalization defaults to off and rejects unknown values", () => {
  assert.equal(normalizeDecisionModelModeV1(undefined), "off");
  assert.equal(normalizeDecisionModelModeV1("authority"), "off");
  assert.equal(normalizeDecisionModelModeV1("shadow"), "shadow");
  assert.equal(normalizeDecisionModelModeV1("enabled"), "enabled");
});

test("Off constructs no runtime and so can make no request", async () => {
  let transportCalls = 0;
  const runtime = createDecisionRuntimeV1({
    settings: { decisionModelMode: "off", decisionApiKey: "sk-or-real-looking" },
    transport: async () => {
      transportCalls += 1;
      return { status: 200, headers: {}, json: {} };
    },
  });
  assert.equal(runtime, null);
  assert.equal(
    createDecisionRuntimeV1({ settings: {}, transport: neverTransport }),
    null,
    "a missing setting is Off",
  );
  assert.equal(transportCalls, 0);
});

test("an unpromoted component configured Enabled runs in Shadow and says why", () => {
  const routing = resolveDecisionComponentModeV1("enabled", "mission_routing");
  assert.equal(routing.effective, "shadow");
  assert.match(routing.heldInShadowBecause ?? "", /gates/u);
  assert.equal(DECISION_PROMOTION_MANIFEST_V1.mission_routing.promoted, false);
  // Claim support passed its held-out gates (2026-09-28) and acts when Enabled.
  assert.equal(DECISION_PROMOTION_MANIFEST_V1.claim_support.promoted, true);
  assert.equal(resolveDecisionComponentModeV1("enabled", "claim_support").effective, "enabled");
  assert.equal(resolveDecisionComponentModeV1("enabled", "claim_support", PROMOTED).effective, "enabled");
  assert.equal(resolveDecisionComponentModeV1("shadow", "claim_support", PROMOTED).effective, "shadow");
  assert.equal(resolveDecisionComponentModeV1("off", "claim_support", PROMOTED).effective, "off");
});

test("the e2e promotion override needs the hidden harness attestation flag", () => {
  assert.equal(
    promotionManifestForSettingsV1({ decisionE2EHarnessPromotion: true }),
    DECISION_PROMOTION_MANIFEST_V1,
  );
  assert.equal(
    promotionManifestForSettingsV1({
      decisionE2EHarnessPromotion: true,
      e2eHarnessAttestationEnabled: true,
    }).claim_support.promoted,
    true,
  );
});

test("an endpoint override is honored only for loopback", () => {
  assert.equal(resolveDecisionEndpointV1(undefined), JEV_DECISION_ENDPOINT_V1);
  assert.equal(resolveDecisionEndpointV1("http://127.0.0.1:4555/decide"), "http://127.0.0.1:4555/decide");
  assert.equal(resolveDecisionEndpointV1("http://localhost:4555/d"), "http://localhost:4555/d");
  assert.equal(resolveDecisionEndpointV1("https://evil.example/decide"), JEV_DECISION_ENDPOINT_V1);
  assert.equal(resolveDecisionEndpointV1("http://user:pw@127.0.0.1:1/d"), JEV_DECISION_ENDPOINT_V1);
  assert.equal(resolveDecisionEndpointV1("file:///etc/passwd"), JEV_DECISION_ENDPOINT_V1);
  assert.equal(resolveDecisionEndpointV1("not a url"), JEV_DECISION_ENDPOINT_V1);
});

test("identical asks are cached within the run and recorded as cache hits", async () => {
  const calls: DecisionRequestV1[] = [];
  const recorded: string[] = [];
  const runtime = createDecisionRuntimeV1({
    settings: { decisionModelMode: "shadow" },
    transport: neverTransport,
    client: scriptedClient([answered(), answered()], calls),
    onRecord: (record) => recorded.push(`${record.outcome}:${record.mode}`),
  })!;
  const first = await runtime.decide("mission_routing", REQUEST, { timeoutMs: 2_000 });
  const second = await runtime.decide("mission_routing", REQUEST, { timeoutMs: 2_000 });
  assert.equal(calls.length, 1);
  assert.deepEqual(first, second);
  const changed = await runtime.decide(
    "mission_routing",
    { ...REQUEST, state: { mission: "different" } },
    { timeoutMs: 2_000 },
  );
  assert.equal(changed?.status, "answered");
  assert.equal(calls.length, 2, "a changed input invalidates the cache");
  assert.deepEqual(recorded, ["answered:shadow", "cache_hit:shadow", "answered:shadow"]);
  const summary = summarizeDecisionRecordsV1(runtime.records());
  assert.equal(summary.calls, 2);
  assert.equal(summary.cacheHits, 1);
  assert.equal(summary.totalDurationMs, 360);
  assert.ok(Math.abs((summary.reportedCost ?? 0) - 0.00002) < 1e-12);
});

test("two transient failures in a row stop further calls for the run; one does not", async () => {
  const calls: DecisionRequestV1[] = [];
  const runtime = createDecisionRuntimeV1({
    settings: { decisionModelMode: "shadow" },
    transport: neverTransport,
    client: scriptedClient([unavailable("timeout"), answered(), unavailable("network"), unavailable("timeout")], calls),
  })!;
  const ask = (text: string) =>
    runtime.decide("mission_routing", { ...REQUEST, state: text }, { timeoutMs: 2_000 });
  assert.equal((await ask("a"))?.status, "unavailable");
  assert.equal((await ask("a"))?.status, "answered", "a transient failure is not cached");
  assert.equal((await ask("b"))?.status, "unavailable");
  assert.equal((await ask("c"))?.status, "unavailable");
  const skipped = await ask("d");
  assert.equal(skipped?.status === "unavailable" && skipped.reason, "skipped_after_failure");
  assert.equal(calls.length, 4);
});

test("an auth failure stops further calls immediately", async () => {
  const calls: DecisionRequestV1[] = [];
  const runtime = createDecisionRuntimeV1({
    settings: { decisionModelMode: "enabled" },
    manifest: PROMOTED,
    transport: neverTransport,
    client: scriptedClient([unavailable("auth")], calls),
  })!;
  await runtime.decide("mission_routing", REQUEST, { timeoutMs: 2_000 });
  const second = await runtime.decide("claim_support", { ...REQUEST, purpose: "claim_support" }, { timeoutMs: 5_000 });
  assert.equal(second?.status === "unavailable" && second.reason, "skipped_after_failure");
  assert.equal(calls.length, 1);
});

test("decision calls are charged to the mission's call budget and refused when it is spent", async () => {
  const evidence: ModelCallEvidenceV1[] = [];
  const chatClient: ModelClient = {
    chat: async () => ({ message: { role: "assistant", content: "ok" }, toolCalls: [] }),
    streamChat: async () => ({ message: { role: "assistant", content: "ok" }, toolCalls: [] }),
  };
  const observable = createObservableModelClient({
    client: chatClient,
    budget: { schemaVersion: 1, maxCalls: 2, maxTokens: 100_000, maxWallClockMs: 600_000 },
    onEvidence: (item) => evidence.push(item),
  });
  const calls: DecisionRequestV1[] = [];
  const runtime = createDecisionRuntimeV1({
    settings: { decisionModelMode: "shadow" },
    transport: neverTransport,
    budget: observable,
    client: scriptedClient([answered(), answered()], calls),
  })!;
  await runtime.decide("mission_routing", REQUEST, { timeoutMs: 2_000 });
  let usage = observable.getUsage();
  assert.equal(usage.modelCallCount, 1);
  assert.equal(usage.successfulCallCount, 1);
  assert.equal(usage.reportedTokens, 129);
  assert.equal(evidence.at(-1)?.phase, "decision");
  assert.equal(evidence.at(-1)?.model, "typesafe/jev-1.13");
  assert.equal(evidence.at(-1)?.outcome, "success");
  await observable.client.chat({ messages: [{ role: "user", content: "hi" }] });
  const refused = await runtime.decide("mission_routing", { ...REQUEST, state: "other" }, { timeoutMs: 2_000 });
  assert.equal(refused?.status === "unavailable" && refused.reason, "budget_exhausted");
  assert.equal(calls.length, 1, "a refused ask never reaches the provider");
  usage = observable.getUsage();
  assert.equal(usage.modelCallCount, 2);
  assert.equal(evidence.at(-1)?.outcome, "budget_exhausted");
});

test("a cancelled decision rethrows the AbortError and is recorded as cancelled", async () => {
  const records: string[] = [];
  const runtime = createDecisionRuntimeV1({
    settings: { decisionModelMode: "shadow" },
    transport: neverTransport,
    onRecord: (record) => records.push(record.outcome),
    client: {
      model: "typesafe/jev-1.13",
      endpoint: JEV_DECISION_ENDPOINT_V1,
      decide: async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    },
  })!;
  await assert.rejects(
    runtime.decide("mission_routing", REQUEST, { timeoutMs: 2_000 }),
    (error: unknown) => (error as { name?: string }).name === "AbortError",
  );
  assert.deepEqual(records, ["cancelled"]);
});

test("persisted records normalize defensively and older runs without them read as empty", () => {
  assert.deepEqual(normalizeDecisionCallRecordsV1(undefined), []);
  assert.deepEqual(normalizeDecisionCallRecordsV1({}), []);
  const normalized = normalizeDecisionCallRecordsV1([
    { version: 2, id: "x" },
    {
      version: 1,
      id: "decision-1",
      component: "mission_routing",
      purpose: "mission_assessment",
      mode: "shadow",
      model: "typesafe/jev-1.13",
      reportedModel: null,
      templateVersion: "t",
      inputFingerprint: "sha256:abc",
      outcome: "unavailable",
      fallbackReason: "timeout",
      durationMs: 2000,
      cost: null,
      inputTokens: null,
      outputTokens: null,
      httpStatus: null,
      at: "2026-09-28T00:00:00.000Z",
      secret: "must be dropped",
    },
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]!.fallbackReason, "timeout");
  assert.equal("secret" in normalized[0]!, false);
});
