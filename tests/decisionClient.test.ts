import test from "node:test";
import assert from "node:assert/strict";
import {
  DECISION_LIMITS_V1,
  JEV_DECISION_ENDPOINT_V1,
  JEV_DECISION_MODEL_V1,
  checkDecisionRequestBoundsV1,
  createOpenRouterDecisionClientV1,
  decisionInputFingerprintV1,
  isDecisionAbortError,
  parseDecisionResponseV1,
  reportedModelMatchesPinV1,
  type DecisionRequestV1,
} from "../src/decisions/decisionClient";
import type { HttpRequest, HttpResponse } from "../src/model/types";

const QUESTIONS: DecisionRequestV1["questions"] = {
  route: {
    type: "choice",
    instructions: "Which route fits the mission?",
    criteria: { chat: "Answer in chat", research: "Research with sources" },
  },
  needs_web: {
    type: "noul",
    instructions: "Does the mission ask for public web sources?",
    criteria: { true: "It asks for web sources", false: "It does not" },
  },
};

function request(overrides: Partial<DecisionRequestV1> = {}): DecisionRequestV1 {
  return {
    purpose: "mission_assessment",
    templateVersion: "test-v1",
    state: { mission: "Summarize the latest research on sleep, with sources." },
    questions: QUESTIONS,
    ...overrides,
  };
}

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "gen-dec-1",
    model: "typesafe/jev-1.13-20260917",
    provider: "TypeSafe",
    answers: {
      route: {
        type: "choice",
        choice: "research",
        confidence: 0.84,
        probabilities: { chat: 0.16, research: 0.84 },
      },
      needs_web: { type: "noul", noul: 0.93 },
    },
    usage: { input_tokens: 400, output_tokens: 40, cost: 0.00002 },
    ...overrides,
  };
}

function transportReturning(
  response: HttpResponse | (() => Promise<HttpResponse>),
  seen: HttpRequest[] = [],
) {
  return async (httpRequest: HttpRequest) => {
    seen.push(httpRequest);
    return typeof response === "function" ? response() : response;
  };
}

test("posts the pinned model, state and questions with a bearer credential", async () => {
  const seen: HttpRequest[] = [];
  const client = createOpenRouterDecisionClientV1({
    apiKey: "  sk-or-test-key  ",
    transport: transportReturning({ status: 200, headers: {}, json: okBody() }, seen),
  });
  const result = await client.decide(request(), { timeoutMs: 2_000 });
  assert.equal(result.status, "answered");
  assert.equal(seen.length, 1);
  const sent = seen[0]!;
  assert.equal(sent.url, JEV_DECISION_ENDPOINT_V1);
  assert.equal(sent.method, "POST");
  assert.equal(sent.throw, false);
  assert.equal(sent.timeoutMs, 2_000);
  assert.equal(sent.headers?.Authorization, "Bearer sk-or-test-key");
  const body = JSON.parse(String(sent.body));
  assert.equal(body.model, JEV_DECISION_MODEL_V1);
  assert.equal(body.model, "typesafe/jev-1.13");
  assert.deepEqual(body.questions, QUESTIONS);
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  if (result.status !== "answered") return;
  assert.equal(result.reportedModel, "typesafe/jev-1.13-20260917");
  assert.deepEqual(result.answers.route, {
    type: "choice",
    choice: "research",
    confidence: 0.84,
    probabilities: { chat: 0.16, research: 0.84 },
  });
  assert.deepEqual(result.answers.needs_web, { type: "noul", noul: 0.93 });
  assert.deepEqual(result.usage, { inputTokens: 400, outputTokens: 40, cost: 0.00002 });
  assert.equal(result.invalidAnswers.length, 0);
});

test("never sends a request without a credential", async () => {
  const seen: HttpRequest[] = [];
  const client = createOpenRouterDecisionClientV1({
    apiKey: "   ",
    transport: transportReturning({ status: 200, headers: {}, json: okBody() }, seen),
  });
  const result = await client.decide(request(), { timeoutMs: 2_000 });
  assert.equal(seen.length, 0);
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") assert.equal(result.reason, "missing_credential");
});

test("refuses an oversized state locally instead of truncating it", async () => {
  const seen: HttpRequest[] = [];
  const client = createOpenRouterDecisionClientV1({
    apiKey: "key",
    transport: transportReturning({ status: 200, headers: {}, json: okBody() }, seen),
  });
  const result = await client.decide(
    request({ state: "x".repeat(DECISION_LIMITS_V1.maxStateChars + 1) }),
    { timeoutMs: 2_000 },
  );
  assert.equal(seen.length, 0);
  assert.equal(result.status === "unavailable" && result.reason, "input_too_large");
});

test("bounds question count, names, criteria count and criterion size", () => {
  const many: DecisionRequestV1["questions"] = {};
  for (let index = 0; index <= DECISION_LIMITS_V1.maxQuestions; index += 1) {
    many[`q${index}`] = QUESTIONS.needs_web!;
  }
  assert.equal(checkDecisionRequestBoundsV1({ state: "s", questions: many }).ok, false);
  assert.equal(checkDecisionRequestBoundsV1({ state: "s", questions: {} }).ok, false);
  assert.equal(
    checkDecisionRequestBoundsV1({ state: "s", questions: { "Bad Name": QUESTIONS.needs_web! } }).ok,
    false,
  );
  assert.equal(
    checkDecisionRequestBoundsV1({
      state: "s",
      questions: { one: { type: "choice", instructions: "?", criteria: { only: "one" } } },
    }).ok,
    false,
  );
  assert.equal(
    checkDecisionRequestBoundsV1({
      state: "s",
      questions: {
        q: {
          type: "choice",
          instructions: "?",
          criteria: { a: "x".repeat(DECISION_LIMITS_V1.maxCriterionChars + 1), b: "b" },
        },
      },
    }).ok,
    false,
  );
  assert.equal(checkDecisionRequestBoundsV1({ state: "s", questions: QUESTIONS }).ok, true);
});

test("maps HTTP failures to explicit unavailable reasons without retrying", async () => {
  const cases: Array<[number, string]> = [
    [401, "auth"],
    [403, "auth"],
    [402, "insufficient_credits"],
    [429, "rate_limited"],
    [400, "request_rejected"],
    [413, "request_rejected"],
    [500, "provider_unavailable"],
    [502, "provider_unavailable"],
    [503, "provider_unavailable"],
    [524, "provider_unavailable"],
    [529, "provider_unavailable"],
  ];
  for (const [status, reason] of cases) {
    const seen: HttpRequest[] = [];
    const client = createOpenRouterDecisionClientV1({
      apiKey: "key",
      transport: transportReturning(
        { status, headers: {}, json: { error: { code: status, message: "no" } } },
        seen,
      ),
    });
    const result = await client.decide(request(), { timeoutMs: 2_000 });
    assert.equal(seen.length, 1, `status ${status} was retried`);
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert.equal(result.reason, reason, `status ${status}`);
      assert.equal(result.httpStatus, status);
      assert.doesNotMatch(result.detail, /key/iu);
    }
  }
});

test("a transport that never answers is cut at the timeout", async () => {
  const client = createOpenRouterDecisionClientV1({
    apiKey: "key",
    transport: () => new Promise<HttpResponse>(() => undefined),
  });
  const startedAt = Date.now();
  const result = await client.decide(request(), { timeoutMs: 30 });
  assert.equal(result.status === "unavailable" && result.reason, "timeout");
  assert.ok(Date.now() - startedAt < 1_000);
});

test("a transport timeout error is reported as a timeout, a socket failure as network", async () => {
  const timedOut = createOpenRouterDecisionClientV1({
    apiKey: "key",
    transport: async () => {
      throw new Error("Request timed out after 2000ms.");
    },
  });
  assert.equal(
    (await timedOut.decide(request(), { timeoutMs: 2_000 })).status === "unavailable" &&
      ((await timedOut.decide(request(), { timeoutMs: 2_000 })) as { reason: string }).reason,
    "timeout",
  );
  const dropped = createOpenRouterDecisionClientV1({
    apiKey: "key",
    transport: async () => {
      throw new Error("socket hang up");
    },
  });
  const result = await dropped.decide(request(), { timeoutMs: 2_000 });
  assert.equal(result.status === "unavailable" && result.reason, "network");
});

test("caller cancellation throws an AbortError before and during the request", async () => {
  const before = new AbortController();
  before.abort();
  const seen: HttpRequest[] = [];
  const client = createOpenRouterDecisionClientV1({
    apiKey: "key",
    transport: transportReturning({ status: 200, headers: {}, json: okBody() }, seen),
  });
  await assert.rejects(
    client.decide(request(), { timeoutMs: 2_000, abortSignal: before.signal }),
    (error) => isDecisionAbortError(error),
  );
  assert.equal(seen.length, 0);

  const during = new AbortController();
  const hanging = createOpenRouterDecisionClientV1({
    apiKey: "key",
    transport: () => new Promise<HttpResponse>(() => undefined),
  });
  const pending = hanging.decide(request(), { timeoutMs: 5_000, abortSignal: during.signal });
  setTimeout(() => during.abort(), 5);
  await assert.rejects(pending, (error) => isDecisionAbortError(error));
});

test("a malformed body is invalid_response, and a partial one keeps its valid answers", async () => {
  for (const body of [null, "text", { model: "typesafe/jev-1.13" }, { answers: {} }]) {
    const client = createOpenRouterDecisionClientV1({
      apiKey: "key",
      transport: transportReturning({ status: 200, headers: {}, json: body }),
    });
    const result = await client.decide(request(), { timeoutMs: 2_000 });
    assert.equal(result.status === "unavailable" && result.reason, "invalid_response");
  }
  const partial = okBody({
    answers: {
      route: { type: "choice", choice: "not-a-criterion", confidence: 0.9 },
      needs_web: { type: "noul", noul: 0.2 },
    },
  });
  const client = createOpenRouterDecisionClientV1({
    apiKey: "key",
    transport: transportReturning({ status: 200, headers: {}, text: JSON.stringify(partial) }),
  });
  const result = await client.decide(request(), { timeoutMs: 2_000 });
  assert.equal(result.status, "answered");
  if (result.status !== "answered") return;
  assert.equal(result.answers.route, null);
  assert.deepEqual(result.invalidAnswers, ["route"]);
  assert.deepEqual(result.answers.needs_web, { type: "noul", noul: 0.2 });
});

test("answer validation rejects out-of-range, mistyped and inconsistent distributions", () => {
  const parse = (answers: Record<string, unknown>) =>
    parseDecisionResponseV1({ model: "typesafe/jev-1.13", answers }, QUESTIONS);
  const noulOver = parse({ route: { type: "choice", choice: "chat" }, needs_web: { type: "noul", noul: 1.2 } });
  assert.equal(noulOver.ok && noulOver.answers.needs_web, null);
  const wrongType = parse({ route: { type: "noul", noul: 0.5 }, needs_web: { type: "noul", noul: 0.5 } });
  assert.equal(wrongType.ok && wrongType.answers.route, null);
  const badSum = parse({
    route: { type: "choice", choice: "chat", probabilities: { chat: 0.5, research: 0.2 } },
    needs_web: { type: "noul", noul: 0.5 },
  });
  assert.equal(badSum.ok && badSum.answers.route, null);
  const inconsistent = parse({
    route: { type: "choice", choice: "chat", probabilities: { chat: 0.2, research: 0.8 } },
    needs_web: { type: "noul", noul: 0.5 },
  });
  assert.equal(inconsistent.ok && inconsistent.answers.route, null);
  const unknownKey = parse({
    route: { type: "choice", choice: "chat", probabilities: { chat: 0.9, other: 0.1 } },
    needs_web: { type: "noul", noul: 0.5 },
  });
  assert.equal(unknownKey.ok && unknownKey.answers.route, null);
  const missingKeysAreZero = parse({
    route: { type: "choice", choice: "chat", probabilities: { chat: 1 } },
    needs_web: { type: "noul", noul: 0.5 },
  });
  assert.deepEqual(missingKeysAreZero.ok && missingKeysAreZero.answers.route, {
    type: "choice",
    choice: "chat",
    confidence: null,
    probabilities: { chat: 1, research: 0 },
  });
});

test("a response from a different model version than the pin is refused", async () => {
  const client = createOpenRouterDecisionClientV1({
    apiKey: "key",
    transport: transportReturning({
      status: 200,
      headers: {},
      json: okBody({ model: "typesafe/jev-1.14-20261001" }),
    }),
  });
  const result = await client.decide(request(), { timeoutMs: 2_000 });
  assert.equal(result.status === "unavailable" && result.reason, "model_mismatch");
  assert.equal(reportedModelMatchesPinV1("typesafe/jev-1.13", "typesafe/jev-1.13"), true);
  assert.equal(reportedModelMatchesPinV1("typesafe/jev-1.13-20260917", "typesafe/jev-1.13"), true);
  assert.equal(reportedModelMatchesPinV1("typesafe/jev-1.130", "typesafe/jev-1.13"), false);
  assert.equal(reportedModelMatchesPinV1("typesafe/jev-latest", "typesafe/jev-1.13"), false);
});

test("the input fingerprint changes with state, template, questions, model and endpoint", () => {
  const config = { endpoint: JEV_DECISION_ENDPOINT_V1, model: JEV_DECISION_MODEL_V1 };
  const base = decisionInputFingerprintV1(request(), config);
  assert.equal(base, decisionInputFingerprintV1(request(), config));
  assert.match(base, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(base, decisionInputFingerprintV1(request({ state: "other" }), config));
  assert.notEqual(base, decisionInputFingerprintV1(request({ templateVersion: "v2" }), config));
  assert.notEqual(
    base,
    decisionInputFingerprintV1(request({ questions: { needs_web: QUESTIONS.needs_web! } }), config),
  );
  assert.notEqual(base, decisionInputFingerprintV1(request(), { ...config, model: "x/y" }));
  assert.notEqual(base, decisionInputFingerprintV1(request(), { ...config, endpoint: "http://127.0.0.1:9/d" }));
});

test("durations come from the injected clock and usage without cost stays null-cost", async () => {
  let clock = 1_000;
  const client = createOpenRouterDecisionClientV1({
    apiKey: "key",
    now: () => clock,
    transport: async () => {
      clock += 250;
      return {
        status: 200,
        headers: {},
        json: okBody({ usage: { input_tokens: 10, output_tokens: 2 } }),
      };
    },
  });
  const result = await client.decide(request(), { timeoutMs: 2_000 });
  assert.equal(result.durationMs, 250);
  assert.deepEqual(result.status === "answered" && result.usage, {
    inputTokens: 10,
    outputTokens: 2,
    cost: null,
  });
});
