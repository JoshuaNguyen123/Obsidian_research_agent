import { processTestVaultFile } from "./helpers/atomicTestVault";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildUnproductiveModelResponseMetricV1,
  classifyUnproductiveModelResponseV1,
  formatUnproductiveModelResponseMessage,
  UNPRODUCTIVE_MODEL_RESPONSE_METRIC_NAME_V1,
  UNPRODUCTIVE_MODEL_RESPONSE_STOP_THRESHOLD_V1,
} from "../src/model/degenerateStreamGuard";
import {
  runAgentMission,
  type AgentRunCompleteEvent,
  type AgentRunMetricEvent,
} from "../src/AgentRunner";
import { evaluatePerformanceGates } from "../src/agent/performanceGates";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import type { AgentSettings } from "../src/settings";
import type { ToolExecutionContext } from "../src/tools/types";
import type {
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
} from "../src/model/types";
import { measureAssistantPayloadChars } from "../src/model/modelCallEvidence";
import {
  createAutonomyRunStats,
  finalizeAutonomyRunStats,
  recordUnproductiveModelResponse,
} from "../src/agent/autonomyRunStats";

// ---------------------------------------------------------------------------
// The false positive that must never happen
// ---------------------------------------------------------------------------

test("a tool-call-only reply is real work, never silence", () => {
  // This is THE trap. A pure tool-call reply carries an empty `content`, and it
  // is the most productive thing the model can do. `measureAssistantPayloadChars`
  // exists because measuring content.length alone recorded these successes as
  // 0 chars; a detector that repeated that mistake would flag every healthy
  // tool-calling step and stop good runs.
  const toolCallOnly = {
    message: { role: "assistant", content: "" },
    toolCalls: [{ name: "web_search", arguments: { query: "gut microbiome" } }],
  };
  assert.equal(classifyUnproductiveModelResponseV1(toolCallOnly), null);
  assert.ok(measureAssistantPayloadChars(toolCallOnly) > 0);

  // Same for a reply whose only payload is a tool call plus thinking.
  assert.equal(
    classifyUnproductiveModelResponseV1({
      message: { role: "assistant", content: "", thinking: "I should search." },
      toolCalls: [{ name: "web_search", arguments: {} }],
    }),
    null,
  );

  // And for many calls in one response.
  assert.equal(
    classifyUnproductiveModelResponseV1({
      message: { role: "assistant", content: "   " },
      toolCalls: [{ name: "a" }, { name: "b" }, { name: "c" }],
    }),
    null,
  );
});

test("prose without a tool call is not silence either", () => {
  // Whether prose ADVANCES the mission is a separate question that the no-tool
  // ladder already owns. This guard only answers "did the model produce
  // anything at all"; claiming a prose answer is silence would hand that
  // ladder a contradicting second opinion.
  assert.equal(
    classifyUnproductiveModelResponseV1({
      message: { role: "assistant", content: "Here is the summary you asked for." },
    }),
    null,
  );
  assert.equal(
    classifyUnproductiveModelResponseV1({
      message: { role: "assistant", content: "ok" },
      toolCalls: [],
    }),
    null,
  );
});

// ---------------------------------------------------------------------------
// The failure it must catch
// ---------------------------------------------------------------------------

test("a response with no tool call and no prose is unproductive", () => {
  const verdict = classifyUnproductiveModelResponseV1({
    message: { role: "assistant", content: "" },
    toolCalls: [],
  });
  assert.ok(verdict);
  assert.equal(verdict.kind, "empty_response");
  assert.equal(verdict.payloadChars, 0);
  assert.equal(verdict.toolCallCount, 0);

  // Whitespace is not prose: a reply of blank lines bought nothing.
  const whitespace = classifyUnproductiveModelResponseV1({
    message: { role: "assistant", content: "\n\n   \t" },
  });
  assert.ok(whitespace);
  assert.equal(whitespace.kind, "empty_response");
});

test("thinking with nothing delivered is counted under its own name", () => {
  // Zero work for the mission and a full step spent, so it counts — but the
  // remedy differs (a thinking model that never emits is a think/tool_choice
  // problem, not a dead provider), so it must stay separable in the record.
  const verdict = classifyUnproductiveModelResponseV1({
    message: { role: "assistant", content: "", thinking: "Let me consider..." },
    toolCalls: [],
  });
  assert.ok(verdict);
  assert.equal(verdict.kind, "thinking_only");
  assert.equal(verdict.thinkingChars, "Let me consider...".length);
  // Payload comes from the shared helper, so thinking chars are payload.
  assert.equal(verdict.payloadChars, "Let me consider...".length);
});

// ---------------------------------------------------------------------------
// The metric and the threshold
// ---------------------------------------------------------------------------

test("the emitted metric carries the number a gate would read", () => {
  const verdict = classifyUnproductiveModelResponseV1({
    message: { role: "assistant", content: "" },
  });
  assert.ok(verdict);
  const metric = buildUnproductiveModelResponseMetricV1({
    verdict,
    consecutive: 2,
    total: 2,
    observed: 5,
    step: 4,
    stepLimit: 11,
  });
  assert.equal(metric.schemaVersion, 1);
  assert.equal(metric.metric, "consecutive_unproductive_model_responses");
  assert.equal(metric.consecutive, 2);
  assert.equal(metric.total, 2);
  assert.equal(metric.observed, 5);
  assert.equal(metric.payloadChars, 0);
  // Remaining budget is the point of the metric: it is what a stop saves.
  assert.equal(metric.remainingSteps, 7);
  assert.equal(metric.atStopThreshold, false);
});

test("the stop threshold is three and the flag flips exactly there", () => {
  // One empty reply is provider noise. Two is still inside the existing
  // reserved-retry seat for an empty forced final. The third is the first one
  // with no host hypothesis behind it.
  assert.equal(UNPRODUCTIVE_MODEL_RESPONSE_STOP_THRESHOLD_V1, 3);
  const verdict = classifyUnproductiveModelResponseV1({
    message: { role: "assistant", content: "" },
  });
  assert.ok(verdict);
  const at = (consecutive: number) =>
    buildUnproductiveModelResponseMetricV1({
      verdict,
      consecutive,
      total: consecutive,
      observed: consecutive,
      step: consecutive,
      stepLimit: 11,
    }).atStopThreshold;
  assert.equal(at(1), false);
  assert.equal(at(2), false);
  assert.equal(at(3), true);
  assert.equal(at(4), true);
});

test("the stop message says what happened and what it saved", () => {
  const verdict = classifyUnproductiveModelResponseV1({
    message: { role: "assistant", content: "" },
  });
  assert.ok(verdict);
  const message = formatUnproductiveModelResponseMessage(
    buildUnproductiveModelResponseMetricV1({
      verdict,
      consecutive: 3,
      total: 3,
      observed: 3,
      step: 3,
      stepLimit: 11,
    }),
  );
  assert.match(message, /3 consecutive steps/u);
  assert.match(message, /8 more budgeted step\(s\)/u);
  assert.match(message, /Nothing was written/u);
});

test("last-step exhaustion never reports negative remaining budget", () => {
  const verdict = classifyUnproductiveModelResponseV1({
    message: { role: "assistant", content: "" },
  });
  assert.ok(verdict);
  assert.equal(
    buildUnproductiveModelResponseMetricV1({
      verdict,
      consecutive: 3,
      total: 3,
      observed: 11,
      step: 12,
      stepLimit: 11,
    }).remainingSteps,
    0,
  );
});

// ---------------------------------------------------------------------------
// The run record
// ---------------------------------------------------------------------------

test("run stats keep the total and the PEAK streak, not a sum of streaks", () => {
  const stats = createAutonomyRunStats();
  assert.equal(stats.unproductive_model_responses, 0);
  assert.equal(stats.max_consecutive_unproductive_model_responses, 0);
  // Streak of 2, recovery, then a streak of 1.
  recordUnproductiveModelResponse(stats, 1);
  recordUnproductiveModelResponse(stats, 2);
  recordUnproductiveModelResponse(stats, 1);
  const final = finalizeAutonomyRunStats(stats);
  assert.equal(final.unproductive_model_responses, 3);
  assert.equal(final.max_consecutive_unproductive_model_responses, 2);
});

test("the recorder tolerates stats restored without the fields", () => {
  const restored = {
    ...createAutonomyRunStats(),
    unproductive_model_responses: undefined,
    max_consecutive_unproductive_model_responses: undefined,
  };
  recordUnproductiveModelResponse(restored, 4);
  assert.equal(restored.unproductive_model_responses, 1);
  assert.equal(restored.max_consecutive_unproductive_model_responses, 4);
});

// ---------------------------------------------------------------------------
// One authority, consumed — not a second detector
// ---------------------------------------------------------------------------

test("the step loop consumes the shared guard and never measures content.length", () => {
  // This repo's recurring deadlock shape is two subsystems answering one
  // question separately. "Is this model output real work?" is answered in
  // degenerateStreamGuard for both of its shapes; the runner must consume that
  // verdict rather than re-deriving emptiness from raw content length.
  const runnerSource = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  const detectAt = runnerSource.indexOf(
    "const unproductiveResponse = classifyUnproductiveModelResponseV1({",
  );
  assert.ok(detectAt > 0, "unproductive-response detection not found");
  const window = runnerSource.slice(detectAt, detectAt + 3600);
  // The tool calls handed to the guard must be the ones the host will actually
  // execute -- `responseToolCalls` includes calls recovered from text, while
  // `response.toolCalls` does not. Passing the raw provider list would read a
  // recovered tool-call step as silence.
  assert.match(window, /toolCalls: responseToolCalls,/u);
  assert.doesNotMatch(window, /toolCalls: response\.toolCalls/u);
  // The stop is gated on the shared threshold and the shared metric flag.
  assert.match(window, /unproductiveMetric\.atStopThreshold/u);
  assert.match(window, /UNPRODUCTIVE_MODEL_RESPONSE_STOP_THRESHOLD_V1/u);
  // The metric reaches the trace structurally, not only inside prose.
  assert.match(window, /outputPreview: unproductiveMetric,/u);
  // An honest terminal, and a blocker the resume path can read.
  assert.match(window, /model_returned_no_output/u);
  assert.match(window, /await finishRun\("error", step, stepLimit,/u);
  // No private emptiness predicate anywhere in the block.
  assert.doesNotMatch(window, /content\.length === 0/u);
  assert.doesNotMatch(window, /content_chars === 0/u);
});

test("the guard module owns both shapes of unreal model output", () => {
  // If a future change forks the emptiness verdict into its own module, this
  // fails -- which is the point. The degenerate-stream verdict and the
  // unproductive-response verdict answer one question and stay together.
  const guardSource = readFileSync(
    new URL("../src/model/degenerateStreamGuard.ts", import.meta.url),
    "utf8",
  );
  assert.match(guardSource, /createDegenerateStreamDetector/u);
  assert.match(guardSource, /classifyUnproductiveModelResponseV1/u);
  // Emptiness is measured through the shared payload helper, not by hand.
  assert.match(
    guardSource,
    /import \{ measureAssistantPayloadChars \} from "\.\/modelCallEvidence";/u,
  );
});

// ---------------------------------------------------------------------------
// Transport: the streak has to reach `AgentRunMetricEvent[]`, or no gate can
// read it. `AutonomyRunStatsV1` is the run record; the metric array is what
// `evaluatePerformanceGates` consumes, and they are different arrays.
// ---------------------------------------------------------------------------

test("per-step streak values through Math.max ARE the peak streak", () => {
  // This is the whole contract behind the transport. Each unproductive step
  // emits its own running streak, so `Math.max` over the run reproduces the
  // peak without anyone tracking a peak in the emitter. Two streaks separated
  // by a recovery must not add up.
  const perStep = [1, 2, 1, 2, 3, 1];
  const events: AgentRunMetricEvent[] = perStep.map((streak, index) => ({
    kind: "run",
    name: UNPRODUCTIVE_MODEL_RESPONSE_METRIC_NAME_V1,
    step: index + 1,
    durationMs: 0,
    unproductiveStreak: streak,
  }));
  const observed = Math.max(
    0,
    ...events.map((event) => event.unproductiveStreak ?? 0),
  );
  assert.equal(observed, 3);

  // The run record is fed from the SAME per-step values and must land on the
  // same number. Two numbers for one question is the drift shape this repo
  // keeps paying for, so this is asserted, not assumed.
  const stats = createAutonomyRunStats();
  for (const streak of perStep) recordUnproductiveModelResponse(stats, streak);
  assert.equal(
    finalizeAutonomyRunStats(stats).max_consecutive_unproductive_model_responses,
    observed,
  );
  // Total and peak answer different questions and must not be confused.
  assert.equal(stats.unproductive_model_responses, 6);
});

test("streak events do not disturb the gates that already exist", () => {
  // `evaluatePerformanceGates` computes `Math.max(0, ...)`, so ABSENCE already
  // reads as 0 — emitting a 0-valued event on every productive step would be
  // noise for an identical result. And on unproductive steps the event carries
  // durationMs 0 and no char field, so every existing gate still reads 0.
  const events: AgentRunMetricEvent[] = [
    {
      kind: "run",
      name: UNPRODUCTIVE_MODEL_RESPONSE_METRIC_NAME_V1,
      step: 1,
      durationMs: 0,
      unproductiveStreak: 1,
    },
  ];
  for (const gate of evaluatePerformanceGates(events)) {
    assert.equal(gate.observed, 0, gate.name);
    assert.equal(gate.status, "pass", gate.name);
  }
  assert.deepEqual(
    evaluatePerformanceGates([]).map((gate) => gate.status),
    evaluatePerformanceGates(events).map((gate) => gate.status),
  );
});

test("a run of empty replies emits the streak and stops at the threshold", async () => {
  // End to end through the real loop, with the observed failure's own step
  // budget. The stop must fire at the threshold, and the emitted events must
  // carry 1, 2, 3 — so a gate reading Math.max observes EXACTLY the threshold
  // on a run where the guard did its job.
  const harness = createRunHarness();
  const metrics: AgentRunMetricEvent[] = [];
  let complete: AgentRunCompleteEvent | undefined;
  await runAgentMission({
    prompt: "Append a two-sentence summary to the current note.",
    modelClient: alwaysEmptyModelClient(),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: harness.context,
    enableStreaming: false,
    events: {
      onMetric: (event) => metrics.push(event),
      onRunComplete: (event) => {
        complete = event;
      },
    },
  });

  const streakEvents = metrics.filter(
    (event) => event.name === UNPRODUCTIVE_MODEL_RESPONSE_METRIC_NAME_V1,
  );
  assert.deepEqual(
    streakEvents.map((event) => event.unproductiveStreak),
    [1, 2, 3],
  );
  assert.ok(streakEvents.every((event) => event.kind === "run"));
  // A count, never a timing.
  assert.ok(streakEvents.every((event) => event.durationMs === 0));

  const observed = Math.max(
    0,
    ...metrics.map((event) => event.unproductiveStreak ?? 0),
  );
  assert.equal(observed, UNPRODUCTIVE_MODEL_RESPONSE_STOP_THRESHOLD_V1);
  // A gate must therefore compare STRICTLY GREATER than the threshold: this
  // run is the guard working correctly and must not read as a failure.
  assert.equal(observed > UNPRODUCTIVE_MODEL_RESPONSE_STOP_THRESHOLD_V1, false);

  // The metric array and the run record agree on the peak.
  assert.equal(
    complete?.autonomyStats?.max_consecutive_unproductive_model_responses,
    observed,
  );
  assert.equal(complete?.autonomyStats?.unproductive_model_responses, 3);

  // The stop is real: it fires at the threshold, not at the step cap.
  assert.equal(complete?.step, UNPRODUCTIVE_MODEL_RESPONSE_STOP_THRESHOLD_V1);
  assert.ok((complete?.maxSteps ?? 0) > (complete?.step ?? 0));
  assert.equal(complete?.stopReason, "error");
  assert.match(String(complete?.stopDetail), /no tool call and no answer text/u);
  // Nothing was written.
  assert.equal(harness.files.get("Current.md"), SEED_NOTE);
});

test("a productive run emits no streak events at all", async () => {
  // The false positive that would matter most in production: a healthy
  // tool-calling run must carry zero of these events, so the gate observes 0.
  const appendCall = {
    name: "append_to_current_file",
    arguments: { text: "Activation predicts retention." },
  };
  const harness = createRunHarness();
  const metrics: AgentRunMetricEvent[] = [];
  let complete: AgentRunCompleteEvent | undefined;
  await runAgentMission({
    prompt: "Append a two-sentence summary to the current note.",
    modelClient: scriptedModelClient([
      // A pure tool-call reply: empty content, payload in the arguments. This
      // is the exact shape a content.length detector would misread as silence.
      {
        message: { role: "assistant", content: "", toolCalls: [appendCall] },
        toolCalls: [appendCall],
      },
      {
        message: { role: "assistant", content: "Activation predicts retention." },
        toolCalls: [],
      },
    ]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: harness.context,
    enableStreaming: false,
    events: {
      onMetric: (event) => metrics.push(event),
      onRunComplete: (event) => {
        complete = event;
      },
    },
  });

  assert.equal(
    metrics.filter(
      (event) => event.name === UNPRODUCTIVE_MODEL_RESPONSE_METRIC_NAME_V1,
    ).length,
    0,
  );
  assert.equal(
    Math.max(0, ...metrics.map((event) => event.unproductiveStreak ?? 0)),
    0,
  );
  assert.equal(complete?.autonomyStats?.unproductive_model_responses, 0);
  assert.equal(
    complete?.autonomyStats?.max_consecutive_unproductive_model_responses,
    0,
  );
  assert.notEqual(complete?.stopReason, "error");
  // The tool-call-only step really did the work.
  assert.match(
    String(harness.files.get("Current.md")),
    /Activation predicts retention/u,
  );
});

// --- run harness -----------------------------------------------------------

const SEED_NOTE = "# Current\n\nSeed.\n";

function alwaysEmptyModelClient(): ModelClient {
  const empty: ModelChatResponse = {
    message: { role: "assistant", content: "" },
    toolCalls: [],
  };
  return {
    async chat() {
      return empty;
    },
    async streamChat() {
      return empty;
    },
  };
}

function scriptedModelClient(responses: ModelChatResponse[]): ModelClient {
  let index = 0;
  const next = () => responses[Math.min(index++, responses.length - 1)];
  return {
    async chat() {
      return next();
    },
    async streamChat(_request, events: ModelChatStreamEvents = {}) {
      const response = next();
      if (response.message.content) {
        events.onContentDelta?.(response.message.content);
      }
      return response;
    },
  };
}

function createRunHarness() {
  const files = new Map<string, string>([["Current.md", SEED_NOTE]]);
  let clock = Date.parse("2026-08-26T09:00:00.000Z");
  const createFile = (path: string) => ({
    path,
    name: path,
    basename: path.replace(/\.[^.]+$/u, ""),
    extension: "md",
    stat: { mtime: clock, ctime: clock, size: files.get(path)?.length ?? 0 },
  });
  const activeFile = createFile("Current.md");
  const app = {
    workspace: { getActiveFile: () => activeFile },
    vault: {
      getFiles: () => [...files.keys()].map(createFile),
      getAllLoadedFiles: () => [...files.keys()].map(createFile),
      getFileByPath: (path: string) =>
        files.has(path) ? createFile(path) : null,
      getFolderByPath: () => null,
      getAbstractFileByPath: (path: string) =>
        files.has(path) ? createFile(path) : null,
      read: async (file: { path: string }) => files.get(file.path) ?? "",
      cachedRead: async (file: { path: string }) => files.get(file.path) ?? "",
      createFolder: async () => undefined,
      create: async (path: string, content: string) => {
        files.set(path, content);
        return createFile(path);
      },
      process: function (file: any, transform: (content: string) => string): Promise<string> {
        return processTestVaultFile(this, file, transform);
      },
      modify: async (file: { path: string }, content: string) => {
        files.set(file.path, content);
      },
    },
  };
  const context: ToolExecutionContext = {
    app: app as never,
    settings: createRunSettings(),
    originalPrompt: "",
    httpTransport: async () => ({
      status: 500,
      headers: {},
      text: "not mocked",
    }),
    now: () => {
      clock += 1;
      return new Date(clock);
    },
    getCurrentMarkdownFile: () => activeFile as never,
    getCurrentMarkdownContent: (file: { path: string }) =>
      files.get(file.path) ?? null,
  };
  return { context, files };
}

/** The observed failure's own step budget, so the early stop is visible. */
function createRunSettings(): AgentSettings {
  return {
    modelProvider: "ollama",
    ollamaApiKey: "test-key",
    ollamaBaseUrl: "https://ollama.test/api",
    openAiCompatibleApiKey: "",
    openAiCompatibleBaseUrl: "https://openai.test/v1",
    model: "test-model",
    utilityModel: "",
    utilityModelProvider: "ollama",
    modelRouterEnabled: false,
    enableStreaming: false,
    requestTimeoutMs: 60_000,
    maxAgentSteps: 11,
    maxRunMinutes: null,
    thinkingMode: "off",
    streamWritebackMode: "off",
    templateFolder: "Templates",
    templateOutputFolder: "",
    researchMemoryEnabled: false,
    researchMemoryFolder: "Agent Research Memory",
    companionBaseUrl: "http://127.0.0.1:8765",
    browserToolsEnabled: false,
    experienceMemoryEnabled: false,
    defaultBrowserMissionMode: "supervised",
    agenticReflexEnabled: false,
    agenticReflexDiagnosticsEnabled: true,
    semanticSearchEnabled: false,
    semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
    semanticEmbeddingDim: 512,
    semanticChunkMinTokens: 300,
    semanticChunkTargetTokens: 500,
    semanticChunkMaxTokens: 700,
    semanticChunkOverlapTokens: 80,
    semanticPythonCommand: "",
    semanticModelCacheDir: "",
    semanticIndexEnabled: false,
    semanticIndexFolder: "Agent Memory",
    semanticIndexDebounceMs: 3_000,
    semanticIndexMaxFiles: 1_000,
    semanticIndexPersistVectors: true,
    temperature: null,
    topK: null,
    topP: null,
    numCtx: null,
    scheduledMissions: [],
  };
}
