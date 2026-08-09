import test from "node:test";
import assert from "node:assert/strict";
import {
  createSpecialistModelClient,
  createUtilitySlotClient,
  createModelClientForSlot,
  resolveAgentModelSlotV2,
} from "../src/model/createModelClient";
import { decideNextLoopAction, type LoopLedger } from "../src/agent/loopDecision";
import {
  parseWatchdogVerdict,
  summarizeTranscriptForWatchdog,
  watchdogAllowListIsReadOnly,
  WATCHDOG_ALLOWED_TOOLS,
} from "../src/orchestrator/watchdogWorker";
import type { AgentSettings } from "../src/settings";
import type { LoopBudgetPlan } from "../src/agent/loopPlanner";

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    modelProvider: "ollama",
    ollamaApiKey: "primary-key",
    ollamaBaseUrl: "https://ollama.com/api",
    openAiCompatibleApiKey: "openai-key",
    openAiCompatibleBaseUrl: "https://api.openai.com/v1",
    model: "primary-model",
    requestTimeoutMs: 180_000,
    ...overrides,
  } as AgentSettings;
}

// ---------------------------------------------------------------- slot client

test("Agent 2 can share the active Ollama connection with an independent client", () => {
  const configured = settings({
    specialistEnabled: true,
    specialistModel: "specialist-model",
    specialistConnectionMode: "shared_primary",
  });
  const client = createSpecialistModelClient(configured);
  const resolution = resolveAgentModelSlotV2(configured, "specialist");

  assert.ok(client);
  assert.equal(client.descriptor?.model, "specialist-model");
  assert.equal(resolution.slot.provider, "ollama");
  assert.equal(resolution.credentialSource, "lead");
  assert.equal(resolution.available, true);
});

test("a blank Specialist model deliberately falls back to the Lead model", () => {
  const client = createSpecialistModelClient(
    settings({
      specialistEnabled: true,
      specialistModel: "",
      specialistConnectionMode: "shared_primary",
    }),
  );
  assert.equal(client?.descriptor?.model, "primary-model");
});

test("disabled Agent 2 creates no Specialist client", () => {
  const client = createSpecialistModelClient(
    settings({ specialistEnabled: false }),
  );
  assert.equal(client, null);
});

test("an explicit second endpoint on a different provider gets its own client", () => {
  const client = createSpecialistModelClient(
    settings({
      specialistModel: "fast-model",
      specialistConnectionMode: "separate",
      specialistProvider: "openai_compatible",
      specialistBaseUrl: "https://second.example/v1",
      specialistApiKey: "specialist-key",
    }),
  );
  assert.ok(client, "a different provider was previously unreachable");
  assert.equal(client.descriptor?.model, "fast-model");
});

test("an explicit second endpoint on the same provider is still distinct", () => {
  const client = createSpecialistModelClient(
    settings({
      specialistModel: "fast-model",
      specialistConnectionMode: "separate",
      specialistProvider: "ollama",
      specialistBaseUrl: "https://second.example/api",
      specialistApiKey: "specialist-key",
    }),
  );
  assert.ok(client);
});

test("separate mode never inherits a Lead key", () => {
  const configured = settings({
    specialistModel: "fast-model",
    specialistConnectionMode: "separate",
    specialistProvider: "ollama",
    specialistBaseUrl: "https://second.example/api",
    specialistApiKey: "",
    ollamaApiKey: "lead-key-that-must-not-cross-slots",
  });
  const client = createSpecialistModelClient(configured);
  const resolution = resolveAgentModelSlotV2(configured, "specialist");
  assert.equal(client, null);
  assert.equal(resolution.credentialSource, "specialist");
  assert.equal(resolution.credentialPresent, false);
  assert.equal(resolution.unavailableReason, "missing_specialist_credential");
});

test("schema-4 utility fields remain a migration-only compatibility input", () => {
  const client = createUtilitySlotClient(
    settings({
      utilityModel: "fast-model",
      utilityModelProvider: "ollama",
      utilityBaseUrl: "https://second.example/api",
      utilityApiKey: "legacy-explicit-specialist-key",
      specialistConnectionMode: undefined,
      specialistModel: undefined,
    }),
  );
  assert.ok(client);
});

test("a schema-4 separate endpoint without its own key fails closed", () => {
  const client = createUtilitySlotClient(
    settings({
      utilityModel: "fast-model",
      utilityModelProvider: "ollama",
      utilityBaseUrl: "https://second.example/api",
      utilityApiKey: "",
      specialistConnectionMode: undefined,
      specialistModel: undefined,
    }),
  );
  assert.equal(client, null);
});

test("slot construction is provider-driven, not field-name-driven", () => {
  const ollama = createModelClientForSlot({
    provider: "ollama",
    model: "m1",
    baseUrl: "https://a.example",
    apiKey: "k",
    requestTimeoutMs: 1_000,
  });
  const openai = createModelClientForSlot({
    provider: "openai_compatible",
    model: "m2",
    baseUrl: "https://b.example",
    apiKey: "k",
    requestTimeoutMs: 1_000,
  });
  assert.equal(ollama.descriptor?.model, "m1");
  assert.equal(openai.descriptor?.model, "m2");
});

// ------------------------------------------------------------- loop escalation

const BUDGET: LoopBudgetPlan = { toolStepBudget: 10 } as LoopBudgetPlan;

function stuckLedger(overrides: Partial<LoopLedger> = {}): LoopLedger {
  return {
    successfulTools: [],
    failedTools: [],
    repeatedToolCalls: 2,
    requiredToolsSatisfied: false,
    finalizationReserved: false,
    writeCompleted: false,
    ...overrides,
  };
}

test("a stuck run with no second agent stops exactly as before", () => {
  const decision = decideNextLoopAction(stuckLedger(), BUDGET);
  assert.equal(decision.action, "stop_budget");
  assert.equal(decision.reason, "repeated_tool_call_without_progress");
});

test("a stuck run escalates when a second agent is available", () => {
  const decision = decideNextLoopAction(
    stuckLedger({ secondAgentAvailable: true }),
    BUDGET,
  );
  assert.equal(decision.action, "escalate_to_second_agent");
  assert.equal(decision.reason, "repeated_tool_call_without_progress");
});

test("the second agent is consulted at most once per run", () => {
  // Without this the two agents can hand a stuck run back and forth and burn
  // the whole budget looking busy — worse than stopping.
  const decision = decideNextLoopAction(
    stuckLedger({ secondAgentAvailable: true, secondAgentConsulted: true }),
    BUDGET,
  );
  assert.equal(decision.action, "stop_budget");
});

test("escalation never preempts a completed write", () => {
  const decision = decideNextLoopAction(
    stuckLedger({ secondAgentAvailable: true, writeCompleted: true }),
    BUDGET,
  );
  assert.equal(decision.action, "stop_verified_complete");
});

// ------------------------------------------------------------------- watchdog

test("the watchdog holds no mutating tool authority", () => {
  assert.equal(WATCHDOG_ALLOWED_TOOLS.size, 0, "the watchdog issues no tool calls at all");
  assert.equal(watchdogAllowListIsReadOnly(), true);
});

test("a well-formed verdict parses", () => {
  const verdict = parseWatchdogVerdict(
    '{"action":"replan","revisedApproach":"Read the note first","rationale":"It never read the target."}',
  );
  assert.equal(verdict?.action, "replan");
  assert.equal(verdict?.revisedApproach, "Read the note first");
});

test("a verdict wrapped in prose or fences still parses", () => {
  const verdict = parseWatchdogVerdict(
    'Here is my call:\n```json\n{"action":"stop","rationale":"Nothing left to try."}\n```',
  );
  assert.equal(verdict?.action, "stop");
});

test("replan without a concrete alternative degrades to answering", () => {
  // An unusable directive is worse than a safe one: it would send the run back
  // into the same loop with no new information.
  const verdict = parseWatchdogVerdict('{"action":"replan","rationale":"Try harder."}');
  assert.equal(verdict?.action, "force_final_no_tools");
});

test("ask_user without a question degrades to answering", () => {
  const verdict = parseWatchdogVerdict('{"action":"ask_user","rationale":"Unclear."}');
  assert.equal(verdict?.action, "force_final_no_tools");
});

test("an unknown or missing action is rejected rather than guessed", () => {
  assert.equal(parseWatchdogVerdict('{"action":"delete_everything"}'), null);
  assert.equal(parseWatchdogVerdict("not json at all"), null);
  assert.equal(parseWatchdogVerdict(""), null);
});

test("the transcript summary keeps the recent tail and clips runaway messages", () => {
  // One enormous tool result must not crowd out the repetition that reveals
  // the loop — that pattern is the entire input to the diagnosis.
  const messages = Array.from({ length: 30 }, (_, index) => ({
    role: "assistant" as const,
    content: index === 29 ? "x".repeat(5_000) : `step ${index}`,
  }));
  const summary = summarizeTranscriptForWatchdog(messages);

  assert.ok(summary.includes("step 29") === false);
  assert.ok(summary.includes("step 20"), "recent turns are retained");
  assert.ok(!summary.includes("step 5"), "distant turns are dropped");
  assert.ok(summary.length < 12_000, "a runaway message cannot dominate");
  assert.ok(summary.includes("…"), "the runaway message is clipped, not dropped");
});
