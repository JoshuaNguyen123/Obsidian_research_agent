import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelClient,
  ModelToolCall,
} from "../src/model/types";
import type { ModelCallEvidenceV1 } from "../src/model/modelCallEvidence";
import {
  createReadOnlyWorkerRegistry,
  isResearchWorkerParallelSafe,
  OLLAMA_CLOUD_DEEP_RESEARCH_MODEL,
  runResearchWorker,
} from "../src/orchestrator/researchWorker";
import type {
  ToolExecutionContext,
  ToolRegistry,
} from "../src/tools/types";

test("research worker leases and deduplicates source candidates before fetch", async () => {
  const url = "https://example.com/primary";
  const model = sequenceModel([
    toolResponse("web_search", { query: "primary evidence" }),
    toolResponse("web_fetch", { url }),
    toolResponse("web_fetch", { url }),
    finalResponse("Primary evidence was fetched and passed to the Lead."),
  ]);
  const executed: string[] = [];
  const modelEvidence: ModelCallEvidenceV1[] = [];
  const registry: ToolRegistry = {
    getDefinitions: () => ["web_search", "web_fetch"].map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" } },
    })),
    async execute(call) {
      executed.push(call.name);
      if (call.name === "web_search") {
        return {
          ok: true,
          toolName: call.name,
          output: { results: [{ title: "Primary source", url, snippet: "Result" }] },
        };
      }
      return {
        ok: true,
        toolName: call.name,
        output: {
          title: "Primary source",
          url,
          content:
            "This primary source provides a detailed, passage-backed explanation of the researched claim, including enough specific context for verification and citation by the Lead agent.",
          parserStatus: "parsed",
        },
      };
    },
  };

  const result = await runResearchWorker({
    runId: "run-ledger",
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Find primary evidence for the claim.",
    originalMission: "Research and cite the claim.",
    modelClient: model,
    toolRegistry: registry,
    toolContext: {} as ToolExecutionContext,
    maxSteps: 6,
    events: {
      onModelCallEvidence: (event) => modelEvidence.push(event),
    },
  });

  assert.equal(modelEvidence.length, 4);
  assert.ok(modelEvidence.every((event) => event.clientInvoked));
  assert.ok(modelEvidence.every((event) => event.phase === "worker"));
  assert.deepEqual(executed, ["web_search", "web_fetch"]);
  assert.equal(result.toolCalls, 3);
  assert.equal(
    result.evidence.filter(
      (item) => item.kind === "web_source" && (item.passageIds?.length ?? 0) > 0,
    ).length,
    1,
  );
  assert.equal(result.handoff.status, "ready");
  assert.ok(result.sourceLedger.duplicateCount >= 2);
  assert.equal(
    Object.values(result.sourceLedger.candidates).filter(
      (candidate) => candidate.status === "usable",
    ).length,
    1,
  );
});

test("deep-research worker rejects an early handoff until three sources are usable", async () => {
  const urls = [
    "https://alpha.example/evidence",
    "https://beta.example/evidence",
    "https://gamma.example/evidence",
  ];
  const model = sequenceModel([
    toolResponse("web_search", { query: "deep evidence" }),
    toolResponse("web_fetch", { url: urls[0] }),
    finalResponse("One source is enough."),
    toolResponse("web_fetch", { url: urls[1] }),
    toolResponse("web_fetch", { url: urls[2] }),
    finalResponse("Three distinct sources are ready for the Lead."),
  ]);
  const executed: string[] = [];
  const registry: ToolRegistry = {
    getDefinitions: () => ["web_search", "web_fetch"].map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" } },
    })),
    async execute(call) {
      executed.push(call.name);
      if (call.name === "web_search") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            results: urls.map((url, index) => ({
              title: index === 0 ? "Primary source" : `Source ${index + 1}`,
              url,
              snippet: `Navigation result ${index + 1}`,
            })),
          },
        };
      }
      const url = String(call.arguments.url);
      return {
        ok: true,
        toolName: call.name,
        output: {
          title: url,
          url,
          content:
            `This independently fetched passage from ${url} provides detailed evidence for the deep research mission and is long enough for durable passage extraction.`,
          parserStatus: "parsed",
        },
      };
    },
  };

  const result = await runResearchWorker({
    runId: "run-deep-ledger",
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Gather deep evidence.",
    originalMission: "Run deep research over the available sources.",
    modelClient: model,
    toolRegistry: registry,
    toolContext: {} as ToolExecutionContext,
    maxSteps: 6,
  });

  assert.deepEqual(executed, [
    "web_search",
    "web_fetch",
    "web_fetch",
    "web_fetch",
  ]);
  assert.equal(
    result.handoff.status,
    "ready",
    JSON.stringify({
      handoff: result.handoff,
      proofRequirements: result.sourceLedger.proofRequirements,
      candidates: result.sourceLedger.candidates,
    }),
  );
  assert.equal(
    Object.values(result.sourceLedger.candidates).filter(
      (candidate) => candidate.status === "usable",
    ).length,
    3,
  );
});

test("research worker performs one bounded alternative read and preserves prior accepted evidence", async () => {
  const accepted = "https://primary.example/accepted";
  const unusable = "https://blocked.example/unusable";
  const alternative = "https://official.example/alternative";
  const model = sequenceModel([
    toolResponse("web_search", { query: "bounded alternative evidence" }),
    toolResponse("web_fetch", { url: accepted }),
    toolResponse("web_fetch", { url: unusable }),
    finalResponse("The accepted and alternative sources are ready for the Lead."),
  ]);
  const fetched: string[] = [];
  const registry: ToolRegistry = {
    getDefinitions: () => ["web_search", "web_fetch"].map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" } },
    })),
    async execute(call) {
      if (call.name === "web_search") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            results: [accepted, unusable, alternative].map((url, index) => ({
              title: index === 0 ? "Primary source" : `Source ${index + 1}`,
              url,
              snippet: "Candidate",
            })),
          },
        };
      }
      const url = String(call.arguments.url);
      fetched.push(url);
      if (url === unusable) {
        return {
          ok: false,
          toolName: call.name,
          error: {
            code: "source_unusable",
            message: "No passage-backed content was extractable.",
          },
        };
      }
      return {
        ok: true,
        toolName: call.name,
        output: {
          title: url,
          url,
          content:
            `This fetched passage from ${url} contains detailed, independently verifiable evidence and enough concrete context for a durable research handoff.`,
          parserStatus: "parsed",
        },
      };
    },
  };

  const result = await runResearchWorker({
    runId: "run-alternative",
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Gather bounded alternative evidence.",
    originalMission: "Research this claim using two sources.",
    modelClient: model,
    toolRegistry: registry,
    toolContext: {} as ToolExecutionContext,
    maxSteps: 5,
  });

  assert.deepEqual(fetched, [accepted, unusable, alternative]);
  assert.equal(result.alternativeSourceReads, 1);
  assert.equal(result.handoff.status, "ready");
  assert.equal(
    result.evidence.filter(
      (item) =>
        item.kind === "web_source" &&
        (item.url === accepted || item.url === alternative),
    ).length,
    2,
  );
  assert.ok(result.evidence.some((item) => item.url === accepted));
  assert.ok(result.evidence.some((item) => item.url === alternative));
  assert.ok(!result.evidence.some((item) => item.url === unusable));
  assert.equal(
    Object.values(result.sourceLedger.candidates).filter(
      (candidate) => candidate.status === "unusable",
    ).length,
    1,
  );
});

test("adaptive worker stops early on saturation instead of grinding to the budget", async () => {
  const good = "https://primary.example/good";
  // After the one good source, the model keeps trying to fetch it again;
  // sequenceModel repeats the final duplicate-fetch response indefinitely.
  const responses = [
    toolResponse("web_search", { query: "saturating evidence" }),
    toolResponse("web_fetch", { url: good }),
    toolResponse("web_fetch", { url: good }),
    toolResponse("web_fetch", { url: good }),
  ];
  const makeRegistry = (): ToolRegistry => ({
    getDefinitions: () =>
      ["web_search", "web_fetch"].map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    async execute(call) {
      if (call.name === "web_search") {
        return {
          ok: true,
          toolName: call.name,
          output: { results: [{ title: "Primary source", url: good, snippet: "R" }] },
        };
      }
      return {
        ok: true,
        toolName: call.name,
        output: {
          title: good,
          url: good,
          content:
            "This primary source provides a detailed, passage-backed explanation with enough concrete context for verification and citation by the Lead agent.",
          parserStatus: "parsed",
        },
      };
    },
  });

  const baseInput = {
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Find one usable source for the claim.",
    originalMission: "Research the claim.",
    toolRegistry: makeRegistry(),
    maxSteps: 12,
  };

  const adaptive = await runResearchWorker({
    ...baseInput,
    runId: "run-saturate-adaptive",
    modelClient: sequenceModel(responses),
    toolContext: { settings: { adaptiveResearchProgress: true } } as ToolExecutionContext,
  });
  assert.equal(adaptive.handoff.status, "ready");
  assert.ok(
    adaptive.modelSteps < 12,
    `expected early stop on saturation, modelSteps=${adaptive.modelSteps}`,
  );

  const grinding = await runResearchWorker({
    ...baseInput,
    runId: "run-saturate-fixed",
    toolRegistry: makeRegistry(),
    modelClient: sequenceModel(responses),
    toolContext: { settings: { adaptiveResearchProgress: false } } as ToolExecutionContext,
  });
  // With the driver disabled the loop grinds all the way to the fixed budget.
  assert.equal(grinding.modelSteps, 12);
  assert.ok(
    adaptive.modelSteps < grinding.modelSteps,
    `adaptive should stop earlier: ${adaptive.modelSteps} vs ${grinding.modelSteps}`,
  );
});

test("adaptive worker escalates and grows its budget while research stays productive", async () => {
  // Force the smallest tier so the tier cap (8 model steps) is reached quickly.
  // Distinct web_search queries keep new evidence arriving (high yield) while no
  // fetch ever satisfies the source floor, so work stays unresolved — the exact
  // condition that escalates the tier and grows the worker's bounded budget.
  const searches = Array.from({ length: 14 }, (_, index) =>
    toolResponse("web_search", { query: `distinct query ${index + 1}` }),
  );
  const model = sequenceModel([
    ...searches,
    finalResponse("Only search navigation so far; no fetched sources yet."),
  ]);
  const registry: ToolRegistry = {
    getDefinitions: () =>
      ["web_search", "web_fetch"].map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    async execute(call) {
      const query = String(call.arguments.query ?? "");
      return {
        ok: true,
        toolName: call.name,
        output: {
          query,
          results: [
            { title: `Result for ${query}`, url: `https://ex.com/${encodeURIComponent(query)}`, snippet: query },
          ],
        },
      };
    },
  };

  const statuses: string[] = [];
  const result = await runResearchWorker({
    runId: "run-escalate",
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Investigate the topic.",
    originalMission: "Research the topic.",
    researchEffortTier: "quick",
    modelClient: model,
    toolRegistry: registry,
    toolContext: {} as ToolExecutionContext,
    maxSteps: 12,
    maxToolCalls: 40,
    events: {
      onStatus: (status) => {
        statuses.push(status);
      },
    },
  });

  // The loop grew past its 12-step starting budget once the quick tier's cap was
  // reached with evidence still arriving — proof the escalate path is consumed.
  assert.ok(
    result.modelSteps > 12,
    `expected the worker to extend past its starting budget, got ${result.modelSteps}`,
  );
  assert.ok(statuses.some((status) => /extending to/i.test(status)));
});

test("worker rechecks cited source liveness and flags a dead link in the handoff", async () => {
  const url = "https://primary.example/gone";
  const model = sequenceModel([
    toolResponse("web_search", { query: "liveness" }),
    toolResponse("web_fetch", { url }),
    finalResponse("Evidence gathered and handed to the Lead."),
  ]);
  const registry: ToolRegistry = {
    getDefinitions: () =>
      ["web_search", "web_fetch"].map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    async execute(call) {
      if (call.name === "web_search") {
        return {
          ok: true,
          toolName: call.name,
          output: { results: [{ title: "Primary", url, snippet: "R" }] },
        };
      }
      return {
        ok: true,
        toolName: call.name,
        output: {
          title: url,
          url,
          content:
            "This primary source was fetched successfully and provides passage-backed, verifiable evidence with enough concrete context for the Lead to cite.",
          parserStatus: "parsed",
        },
      };
    },
  };

  const result = await runResearchWorker({
    runId: "run-liveness",
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Find one usable source.",
    originalMission: "Research the claim.",
    modelClient: model,
    toolRegistry: registry,
    toolContext: {
      settings: { deadLinkRecheckEnabled: true, requestTimeoutMs: 5_000 },
      // The cited page is now gone, even though the fetch earlier succeeded.
      httpTransport: async () => ({ status: 404, headers: {} }),
    } as unknown as ToolExecutionContext,
    maxSteps: 5,
  });

  assert.match(result.finalSummary, /Liveness caveats/);
  assert.match(result.finalSummary, /primary\.example\/gone/);
});

test("read-only worker registry blocks mutation tools without delegation", async () => {
  let delegated = false;
  const registry: ToolRegistry = {
    getDefinitions: () => [
      {
        type: "function",
        function: { name: "replace_file", parameters: { type: "object" } },
      },
    ],
    async execute(call) {
      delegated = true;
      return { ok: true, toolName: call.name, output: {} };
    },
  };
  const readOnly = createReadOnlyWorkerRegistry(registry);
  const result = await readOnly.execute(
    { name: "replace_file", arguments: { path: "Current.md", text: "bad" } },
    {} as ToolExecutionContext,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "orchestrator_worker_policy_blocked");
  assert.equal(delegated, false);
});

test("researcher tool turns pass graded think and prefer streamChat", async () => {
  const requests: ModelChatRequest[] = [];
  let chatCalls = 0;
  let streamCalls = 0;
  const model: ModelClient = {
    descriptor: {
      provider: "ollama",
      model: "qwen3:32b",
      endpointCategory: "local",
      transportKind: "test_mock",
    },
    async chat(request) {
      chatCalls += 1;
      requests.push(request);
      return finalResponse("Handoff ready with one usable source.");
    },
    async streamChat(request) {
      streamCalls += 1;
      requests.push(request);
      return finalResponse("Handoff ready with one usable source.");
    },
  };
  const registry: ToolRegistry = {
    getDefinitions: () =>
      ["web_search", "web_fetch"].map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    async execute(call) {
      return { ok: true, toolName: call.name, output: {} };
    },
  };

  await runResearchWorker({
    runId: "run-think",
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Gather one usable source.",
    originalMission: "Research with one source.",
    modelClient: model,
    toolRegistry: registry,
    toolContext: {
      settings: {
        model: "qwen3:32b",
        thinkingMode: "auto",
        enableStreaming: true,
      },
    } as ToolExecutionContext,
    maxSteps: 1,
  });

  assert.equal(streamCalls, 1);
  assert.equal(chatCalls, 0);
  assert.equal(requests.length, 1);
  assert.ok((requests[0].tools?.length ?? 0) > 0);
  assert.equal(requests[0].think, "low");
});

test("deep and extended direct Ollama Cloud research use Nemotron with thinking", async () => {
  for (const researchEffortTier of ["deep", "extended"] as const) {
    const requests: ModelChatRequest[] = [];
    const model: ModelClient = {
      descriptor: {
        provider: "ollama",
        model: "configured-default",
        endpointCategory: "ollama_cloud",
        transportKind: "test_mock",
      },
      async chat(request) {
        requests.push(request);
        return finalResponse("Research handoff complete.");
      },
      async streamChat() {
        throw new Error("unused");
      },
    };

    await runResearchWorker({
      runId: `run-cloud-${researchEffortTier}`,
      participantId: "researcher",
      leadParticipantId: "lead",
      taskId: "research",
      assignment: "Gather bounded evidence.",
      originalMission: "Research the claim.",
      researchEffortTier,
      modelClient: model,
      toolRegistry: emptyRegistry(),
      toolContext: {
        settings: {
          model: "configured-default",
          thinkingMode: "auto",
          enableStreaming: false,
        },
      } as ToolExecutionContext,
      maxSteps: 1,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, OLLAMA_CLOUD_DEEP_RESEARCH_MODEL);
    assert.equal(requests[0].think, true);
    assert.equal(model.descriptor?.model, "configured-default");
  }
});

test("standard Ollama Cloud research retains the configured model and is not forced low", async () => {
  const requests: ModelChatRequest[] = [];
  const model: ModelClient = {
    descriptor: {
      provider: "ollama",
      model: "qwen3.5:cloud",
      endpointCategory: "ollama_cloud",
      transportKind: "test_mock",
    },
    async chat(request) {
      requests.push(request);
      return finalResponse("Research handoff complete.");
    },
    async streamChat() {
      throw new Error("unused");
    },
  };

  await runResearchWorker({
    runId: "run-cloud-standard",
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Gather bounded evidence.",
    originalMission: "Research the claim.",
    researchEffortTier: "standard",
    modelClient: model,
    toolRegistry: emptyRegistry(),
    toolContext: {
      settings: {
        model: "qwen3.5:cloud",
        thinkingMode: "auto",
        enableStreaming: false,
      },
    } as ToolExecutionContext,
    maxSteps: 1,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, undefined);
  assert.equal(requests[0].think, true);
});

test("deep Ollama Cloud research preserves an explicit thinking opt-out", async () => {
  const requests: ModelChatRequest[] = [];
  const model: ModelClient = {
    descriptor: {
      provider: "ollama",
      model: "configured-default",
      endpointCategory: "ollama_cloud",
      transportKind: "test_mock",
    },
    async chat(request) {
      requests.push(request);
      return finalResponse("Research handoff complete.");
    },
    async streamChat() {
      throw new Error("unused");
    },
  };

  await runResearchWorker({
    runId: "run-cloud-thinking-off",
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Gather bounded evidence.",
    originalMission: "Run deep research on the claim.",
    modelClient: model,
    toolRegistry: emptyRegistry(),
    toolContext: {
      settings: {
        model: "configured-default",
        thinkingMode: "off",
        enableStreaming: false,
      },
    } as ToolExecutionContext,
    maxSteps: 1,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, OLLAMA_CLOUD_DEEP_RESEARCH_MODEL);
  assert.equal(requests[0].think, false);
});

test("researcher falls back to chat when streaming is disabled", async () => {
  let chatCalls = 0;
  let streamCalls = 0;
  const model: ModelClient = {
    async chat() {
      chatCalls += 1;
      return finalResponse("Done.");
    },
    async streamChat() {
      streamCalls += 1;
      return finalResponse("Done.");
    },
  };
  const registry: ToolRegistry = {
    getDefinitions: () => [],
    async execute(call) {
      return { ok: true, toolName: call.name, output: {} };
    },
  };

  await runResearchWorker({
    runId: "run-no-stream",
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Summarize.",
    originalMission: "Research with one source.",
    modelClient: model,
    toolRegistry: registry,
    toolContext: {
      settings: { enableStreaming: false, model: "qwen3:32b" },
    } as ToolExecutionContext,
    maxSteps: 1,
  });

  assert.equal(chatCalls, 1);
  assert.equal(streamCalls, 0);
});

test("research worker parallel-safe classifier keeps web_fetch serial", () => {
  assert.equal(isResearchWorkerParallelSafe("read_file"), true);
  assert.equal(isResearchWorkerParallelSafe("web_search"), true);
  assert.equal(isResearchWorkerParallelSafe("web_fetch"), false);
  assert.equal(isResearchWorkerParallelSafe("browser_open_page"), false);
});

test("research worker runs parallel-safe reads concurrently", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const model = sequenceModel([
    {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "read_file", arguments: { path: "a.md" }, id: "1" },
          { name: "read_file", arguments: { path: "b.md" }, id: "2" },
        ],
      },
      toolCalls: [
        { name: "read_file", arguments: { path: "a.md" }, id: "1" },
        { name: "read_file", arguments: { path: "b.md" }, id: "2" },
      ],
    },
    finalResponse("Read both notes."),
  ]);
  const registry: ToolRegistry = {
    getDefinitions: () => [
      {
        type: "function",
        function: { name: "read_file", parameters: { type: "object" } },
      },
    ],
    async execute(call) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight -= 1;
      return {
        ok: true,
        toolName: call.name,
        output: { path: call.arguments.path, content: "note" },
      };
    },
  };
  const statuses: string[] = [];
  await runResearchWorker({
    runId: "run-parallel",
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Read a.md and b.md in parallel",
    originalMission: "Read vault notes in parallel.",
    modelClient: model,
    toolRegistry: registry,
    toolContext: {} as ToolExecutionContext,
    maxSteps: 3,
    maxToolCalls: 4,
    events: {
      onStatus: (status) => {
        statuses.push(status);
      },
    },
  });
  assert.ok(maxInFlight >= 2, `expected concurrent reads, maxInFlight=${maxInFlight}`);
  assert.ok(statuses.some((item) => /parallel/i.test(item)));
});

function sequenceModel(responses: ModelChatResponse[]): ModelClient {
  let index = 0;
  return {
    async chat(_request: ModelChatRequest) {
      return responses[Math.min(index++, responses.length - 1)];
    },
    async streamChat(_request: ModelChatRequest) {
      return responses[Math.min(index++, responses.length - 1)];
    },
  };
}

function emptyRegistry(): ToolRegistry {
  return {
    getDefinitions: () => [],
    async execute(call) {
      return { ok: true, toolName: call.name, output: {} };
    },
  };
}

function toolResponse(
  name: string,
  args: Record<string, unknown>,
): ModelChatResponse {
  const call: ModelToolCall = { name, arguments: args, id: `call-${name}` };
  return {
    message: { role: "assistant", content: "", toolCalls: [call] },
    toolCalls: [call],
  };
}

function finalResponse(content: string): ModelChatResponse {
  return { message: { role: "assistant", content }, toolCalls: [] };
}
