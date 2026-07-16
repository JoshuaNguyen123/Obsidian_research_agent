import test from "node:test";
import assert from "node:assert/strict";
import {
  runAgentMission,
  type AgentRunCompleteEvent,
  type AgentRunConfigEvent,
  type AgentRunReceipt,
  type AgentTraceEvent,
} from "../src/AgentRunner";
import {
  createMissionLedger,
  parseMissionLedgerFromMarkdown,
  setLedgerMissionPlan,
  writeMissionLedger,
  type MissionEvidence,
} from "../src/agent/missionLedger";
import { appendAgentRunCheckpoint } from "../src/agent/checkpoints";
import { seedDurableChildRun } from "../src/agent/durableChildSeed";
import {
  flattenMissionPlanTasks,
  type MissionPlan,
} from "../src/agent/missionPlan";
import type { ResearchPlan } from "../src/agent/researchPlan";
import {
  createMissionRuntimeSnapshot,
  createOperationJournalRecord,
  parseMissionRuntimeSnapshotFromMarkdown,
  transitionOperationJournalRecord,
  writeMissionRuntimeSnapshot,
  type MissionRuntimeSnapshotV2,
} from "../src/agent/runStore";
import { RunCoordinator } from "../src/agent/runCoordinator";
import type { AgentSettings } from "../src/settings";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "../src/tools/types";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
  ModelToolCall,
} from "../src/model/types";

test("write mission persists WAL intent before mutation and commits the receipt afterward", async () => {
  let snapshotAtMutation: MissionRuntimeSnapshotV2 | null = null;
  const vault = createVaultHarness({
    beforeModify(path, files) {
      if (path !== "Current.md") {
        return;
      }
      const runMarkdown = [...files.entries()].find(([candidate]) =>
        /^Agent Runs\/[^/]+\.md$/u.test(candidate),
      )?.[1];
      snapshotAtMutation = runMarkdown
        ? parseMissionRuntimeSnapshotFromMarkdown(runMarkdown)
        : null;
    },
  });
  const configs: AgentRunConfigEvent[] = [];
  const receipts: AgentRunReceipt[] = [];
  const client = createModelClient([
    responseWithToolCall("append_to_current_file", {
      text: "Durable mutation proof",
    }),
  ]);

  await runAgentMission({
    prompt: "Append durable mutation proof to the current note.",
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const mutationSnapshot = snapshotAtMutation as MissionRuntimeSnapshotV2 | null;
  assert.ok(mutationSnapshot, "a runtime snapshot should exist before note mutation");
  assert.equal(mutationSnapshot.currentNotePath, "Current.md");
  assert.equal(mutationSnapshot.operationJournal.length, 1);
  assert.equal(mutationSnapshot.operationJournal[0].state, "applying");
  assert.deepEqual(
    mutationSnapshot.operationJournal[0].transitions.map((item) => item.state),
    ["intent_recorded", "applying"],
  );
  assert.equal(vault.files.get("Current.md"), "Initial note\nDurable mutation proof");

  const runId = configs.at(-1)?.runId;
  assert.ok(runId);
  const finalSnapshot = parseMissionRuntimeSnapshotFromMarkdown(
    vault.files.get(`Agent Runs/${runId}.md`) ?? "",
  );
  assert.ok(finalSnapshot);
  assert.equal(finalSnapshot.operationJournal.length, 1);
  assert.equal(finalSnapshot.operationJournal[0].state, "committed");
  assert.deepEqual(
    finalSnapshot.operationJournal[0].transitions.map((item) => item.state),
    ["intent_recorded", "applying", "applied", "verified", "committed"],
  );
  assert.equal(
    finalSnapshot.operationJournal[0].receipt?.toolName,
    "append_to_current_file",
  );
  assert.equal(finalSnapshot.operationJournal[0].receipt?.path, "Current.md");
});

test("accepted web research auto-memory uses observed tool events and commits WAL", async () => {
  const vault = createVaultHarness();
  const prompt =
    "Search the web for Ollama structured outputs documentation and summarize it.";
  const configs: AgentRunConfigEvent[] = [];
  const receipts: AgentRunReceipt[] = [];
  const toolEvents: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  let snapshotAtMemoryMutation: MissionRuntimeSnapshotV2 | null = null;
  const memoryPath = "Agent Research Memory/ollama-structured-outputs.md";
  const definitionNames = new Set([
    "read_current_file",
    "web_search",
    "web_fetch",
    "append_research_memory",
  ]);
  const defaultRegistry = createDefaultToolRegistry();
  const registry: ToolRegistry = {
    getDefinitions: () =>
      defaultRegistry
        .getDefinitions()
        .filter((definition) => definitionNames.has(definition.function.name)),
    execute: async (call): Promise<ToolExecutionResult> => {
      executedCalls.push(call);
      if (call.name === "web_search") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            results: [
              {
                title: "Ollama structured outputs",
                url: "https://example.com/ollama-structured-outputs",
                snippet: "Structured outputs constrain model responses to a schema.",
              },
            ],
          },
        };
      }
      if (call.name === "web_fetch") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            title: "Ollama structured outputs",
            url: "https://example.com/ollama-structured-outputs",
            content:
              "Ollama structured outputs constrain model responses to a supplied JSON schema and make typed application integration more reliable.",
            links: [],
          },
        };
      }
      if (call.name === "append_research_memory") {
        const runMarkdown = [...vault.files.entries()].find(([path]) =>
          /^Agent Runs\/[^/]+\.md$/u.test(path),
        )?.[1];
        snapshotAtMemoryMutation = runMarkdown
          ? parseMissionRuntimeSnapshotFromMarkdown(runMarkdown)
          : null;
        vault.files.set(memoryPath, String(call.arguments.text ?? ""));
        return {
          ok: true,
          toolName: call.name,
          output: {
            path: memoryPath,
            operation: "create",
            topic: call.arguments.topic,
            bytesWritten: String(call.arguments.text ?? "").length,
          },
        };
      }
      return {
        ok: true,
        toolName: call.name,
        output: { path: "Current.md", content: "Initial note" },
      };
    },
  };
  let modelStep = 0;
  const client: ModelClient = {
    async chat(request) {
      if (modelStep === 0) {
        modelStep += 1;
        return responseWithToolCall("web_search", {
          query: "Ollama structured outputs documentation",
        });
      }
      if (modelStep === 1) {
        modelStep += 1;
        return responseWithToolCall("web_fetch", {
          url: "https://example.com/ollama-structured-outputs",
        });
      }
      modelStep += 1;
      const passageId = getPassageCitationIds(request)[0];
      assert.ok(passageId, "fetched passage id must reach final synthesis");
      return responseWithContent(
        [
          "Ollama structured outputs constrain responses to a JSON schema.",
          "Source: https://example.com/ollama-structured-outputs",
          `Passage evidence: [${passageId}]`,
          "Limitations: this focused source does not compare every provider.",
          "Confidence: high.",
        ].join("\n"),
      );
    },
    async streamChat(request, events: ModelChatStreamEvents = {}) {
      const response = await this.chat(request);
      events.onContentDelta?.(response.message.content);
      return response;
    },
  };

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
      onToolStart: (event) => toolEvents.push(`start:${event.name}`),
      onToolDone: (event) => toolEvents.push(`done:${event.name}:${event.ok}`),
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const applyingSnapshot =
    snapshotAtMemoryMutation as MissionRuntimeSnapshotV2 | null;
  assert.ok(
    applyingSnapshot,
    "auto-memory mutation must observe a durable applying WAL snapshot",
  );
  assert.equal(applyingSnapshot.operationJournal.length, 1);
  assert.equal(
    applyingSnapshot.operationJournal[0].toolName,
    "append_research_memory",
  );
  assert.equal(applyingSnapshot.operationJournal[0].state, "applying");
  assert.deepEqual(
    applyingSnapshot.operationJournal[0].transitions.map((item) => item.state),
    ["intent_recorded", "applying"],
  );
  assert.equal(
    toolEvents.filter((event) => event === "start:append_research_memory").length,
    1,
  );
  assert.equal(
    toolEvents.filter((event) => event === "done:append_research_memory:true").length,
    1,
  );
  assert.ok(
    executedCalls.some((call) => call.name === "append_research_memory"),
  );
  assert.ok(vault.files.has(memoryPath));

  const runId = configs.at(-1)?.runId;
  assert.ok(runId);
  const finalSnapshot = parseMissionRuntimeSnapshotFromMarkdown(
    vault.files.get(`Agent Runs/${runId}.md`) ?? "",
  );
  assert.ok(finalSnapshot);
  assert.equal(finalSnapshot.operationJournal.length, 1);
  assert.equal(finalSnapshot.operationJournal[0].state, "committed");
  assert.equal(
    finalSnapshot.operationJournal[0].receipt?.toolName,
    "append_research_memory",
  );
  assert.equal(finalSnapshot.operationJournal[0].receipt?.path, memoryPath);
  assert.deepEqual(
    finalSnapshot.operationJournal[0].transitions.map((item) => item.state),
    ["intent_recorded", "applying", "applied", "verified", "committed"],
  );
  assert.equal(
    receipts.filter((receipt) => receipt.toolName === "append_research_memory")
      .length,
    1,
  );
});

test("required WAL persistence failure stops before mutation with a resumable error", async () => {
  let blockedWalWrite = false;
  let runArtifactWritesAfterAmbiguity = 0;
  const vault = createVaultHarness({
    beforeModify(path, _files, nextContent) {
      const isDirectRunArtifact = /^Agent Runs\/[^/]+\.md$/u.test(path);
      if (
        !blockedWalWrite &&
        isDirectRunArtifact &&
        /"state": "intent_recorded"/u.test(nextContent)
      ) {
        blockedWalWrite = true;
        throw new Error("Simulated required WAL snapshot persistence failure.");
      }
      if (blockedWalWrite && isDirectRunArtifact) {
        runArtifactWritesAfterAmbiguity += 1;
      }
    },
  });
  const executedCalls: ModelToolCall[] = [];
  const traces: AgentTraceEvent[] = [];
  const assistant: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const defaultRegistry = createDefaultToolRegistry();
  const registry: ToolRegistry = {
    getDefinitions: () => defaultRegistry.getDefinitions(),
    execute: async (call, context) => {
      executedCalls.push(call);
      return defaultRegistry.execute(call, context);
    },
  };

  await runAgentMission({
    prompt: "Append WAL failure proof to the current note.",
    modelClient: createModelClient([
      responseWithToolCall("append_to_current_file", {
        text: "WAL failure proof",
      }),
    ]),
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onTrace: (event) => traces.push(event),
      onAssistantDelta: (content) => assistant.push(content),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.equal(blockedWalWrite, true);
  assert.deepEqual(executedCalls, []);
  assert.equal(vault.files.get("Current.md"), "Initial note");
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stopReason, "error");
  assert.equal(
    runArtifactWritesAfterAmbiguity,
    0,
    "error finalization must not enqueue another direct run-artifact write",
  );
  assert.match(assistant.join(""), /Tool execution failed:/i);
  assert.match(assistant.join(""), /continue run/i);
  assert.ok(
    traces.some(
      (trace) =>
        trace.kind === "error" &&
        trace.error?.code === "runtime_snapshot_write_ambiguous" &&
        /reconcile the run artifact before resuming/i.test(
          trace.error.message,
        ),
    ),
    JSON.stringify(traces),
  );
  const resumableSnapshot = [...vault.files.entries()]
    .filter(([path]) => /^Agent Runs\/[^/]+\.md$/u.test(path))
    .map(([, markdown]) => parseMissionRuntimeSnapshotFromMarkdown(markdown))
    .find((snapshot) => snapshot !== null);
  assert.ok(resumableSnapshot);
  assert.equal(
    resumableSnapshot.status,
    "running",
    "the last acknowledged snapshot remains authoritative after an ambiguous write",
  );
  assert.equal(
    resumableSnapshot.originalMission,
    "Append WAL failure proof to the current note.",
  );
  assert.equal(
    resumableSnapshot.operationJournal.length,
    0,
    "terminal error handling must not overwrite the last acknowledged snapshot",
  );
});

test("streamed current-note writeback persists applying WAL before mutation and commits afterward", async () => {
  let snapshotAtMutation: MissionRuntimeSnapshotV2 | null = null;
  const vault = createVaultHarness({
    beforeModify(path, files) {
      if (path !== "Current.md") {
        return;
      }
      const runMarkdown = [...files.entries()].find(([candidate]) =>
        /^Agent Runs\/[^/]+\.md$/u.test(candidate),
      )?.[1];
      snapshotAtMutation = runMarkdown
        ? parseMissionRuntimeSnapshotFromMarkdown(runMarkdown)
        : null;
    },
  });
  vault.context.settings.enableStreaming = true;
  vault.context.settings.streamWritebackMode =
    "all_current_note_content_writes";
  const configs: AgentRunConfigEvent[] = [];
  const receipts: AgentRunReceipt[] = [];
  const streamedContent =
    "Durable autonomous agents preserve mutation intent before writing and retain a committed receipt afterward.";

  await runAgentMission({
    prompt:
      "Write a concise paragraph about durable autonomous agents on the current note.",
    modelClient: createModelClient([responseWithContent(streamedContent)]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onRunConfig: (event) => configs.push(event),
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const mutationSnapshot = snapshotAtMutation as MissionRuntimeSnapshotV2 | null;
  assert.ok(
    mutationSnapshot,
    "the streamed note mutation must observe a durable runtime snapshot",
  );
  assert.equal(mutationSnapshot.currentNotePath, "Current.md");
  assert.equal(mutationSnapshot.operationJournal.length, 1);
  assert.equal(mutationSnapshot.operationJournal[0].state, "applying");
  assert.deepEqual(
    mutationSnapshot.operationJournal[0].transitions.map((item) => item.state),
    ["intent_recorded", "applying"],
  );
  assert.equal(vault.files.get("Current.md"), `Initial note\n${streamedContent}`);

  const runId = configs.at(-1)?.runId;
  assert.ok(runId);
  const finalSnapshot = parseMissionRuntimeSnapshotFromMarkdown(
    vault.files.get(`Agent Runs/${runId}.md`) ?? "",
  );
  assert.ok(finalSnapshot);
  assert.equal(finalSnapshot.operationJournal.length, 1);
  assert.equal(finalSnapshot.operationJournal[0].state, "committed");
  assert.deepEqual(
    finalSnapshot.operationJournal[0].transitions.map((item) => item.state),
    ["intent_recorded", "applying", "applied", "verified", "committed"],
  );
  assert.equal(
    finalSnapshot.operationJournal[0].receipt?.toolName,
    "append_to_current_file",
  );
  assert.equal(finalSnapshot.operationJournal[0].receipt?.path, "Current.md");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].readback?.status, "verified");
  assert.match(
    receipts[0].readback?.observedFingerprint ?? "",
    /^fnv1a32:[a-f0-9]{8}$/u,
  );
  assert.deepEqual(
    finalSnapshot.operationJournal[0].receipt?.readback,
    receipts[0].readback,
  );
});

test("resumed sourced writeback uses durable read proof and commits exactly once", async () => {
  const vault = createVaultHarness();
  vault.context.settings.enableStreaming = true;
  vault.context.settings.streamWritebackMode =
    "all_current_note_content_writes";
  const seedRunId = "run-sourced-writeback-seed";
  const originalMission =
    "Research MCP server transports on the web and append a concise cited summary to the current note.";
  const passageId = "source:resumeproof:passage:0-88";
  const evidence: MissionEvidence = {
    id: "web:resumeproof",
    kind: "web_source",
    title: "MCP transport source",
    url: "https://example.com/mcp-transport",
    sourceId: "source:resumeproof",
    passageId,
    passageIds: [passageId],
    summary:
      "MCP servers expose tools and resources over transports defined by the protocol.",
    confidence: "high",
  };
  const priorPlan: MissionPlan = {
    version: 1,
    runId: seedRunId,
    status: "in_progress",
    activeTaskId: "task-act",
    tasks: [
      {
        id: "task-research-web",
        title: "Gather fetched MCP transport sources",
        status: "complete",
        allowedTools: ["web_search", "web_fetch"],
        dependencies: [],
        evidenceIds: [evidence.id],
        receiptIds: [],
        completionContract: {
          requiredProof: ["web_evidence"],
          citationMode: "passage",
          minEvidenceCount: 1,
          minDistinctDomains: 1,
        },
      },
      {
        id: "task-act",
        title: "Append the cited MCP transport summary",
        status: "in_progress",
        allowedTools: ["append_to_current_file"],
        dependencies: ["task-research-web"],
        evidenceIds: [],
        receiptIds: [],
        completionContract: { requiredProof: ["write_receipt"] },
      },
      {
        id: "task-verify",
        title: "Verify the final MCP transport summary",
        status: "pending",
        allowedTools: [],
        dependencies: ["task-act"],
        evidenceIds: [],
        receiptIds: [],
        completionContract: {
          requiredProof: ["final_relevance"],
          relevanceTerms: ["mcp", "server", "transport"],
        },
      },
    ],
    progress: {
      score: 0.333,
      completedTasks: 1,
      totalTasks: 3,
      remainingTasks: 2,
      stalledCount: 0,
      lastMeaningfulAction: "tool:web_fetch",
    },
    nextAction: {
      kind: "write",
      summary: "Append the cited MCP transport summary.",
      toolName: "append_to_current_file",
      taskId: "task-act",
    },
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:05:00.000Z",
  };
  const ledger = createMissionLedger({
    runId: seedRunId,
    mission: originalMission,
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 12,
      toolStepBudget: 8,
      finalizationReserve: 4,
      expectedTools: ["web_search", "web_fetch"],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
  ledger.status = "blocked";
  ledger.evidence = [evidence];
  setLedgerMissionPlan(
    ledger,
    priorPlan,
    new Date("2026-07-10T12:05:00.000Z"),
  );
  await writeMissionLedger(vault.context, ledger);
  await writeMissionRuntimeSnapshot(
    vault.context,
    createMissionRuntimeSnapshot({
      runId: seedRunId,
      originalMission,
      currentNotePath: "Current.md",
      status: "paused",
      missionPlan: priorPlan,
      evidence: [evidence],
      operationGoals: {
        web_search: "done",
        web_fetch: "done",
        current_note_content: "pending",
      },
      lastSafeStep: 6,
      createdAt: new Date("2026-07-10T12:00:00.000Z"),
      updatedAt: new Date("2026-07-10T12:05:00.000Z"),
    }),
  );

  const configs: AgentRunConfigEvent[] = [];
  const receipts: AgentRunReceipt[] = [];
  const toolStarts: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const statuses: string[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const candidate =
    "MCP servers expose tools and resources over protocol-defined transports. " +
    `Source: https://example.com/mcp-transport Passage evidence: [${passageId}]`;
  const client: ModelClient = {
    async chat(request) {
      chatRequests.push(cloneRequest(request));
      return responseWithContent("The durable source proof is ready for writeback.");
    },
    async streamChat(request, events = {}) {
      streamRequests.push(cloneRequest(request));
      events.onContentDelta?.(candidate);
      return responseWithContent(candidate);
    },
  };

  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onRunConfig: (event) => configs.push(event),
      onReceipt: (receipt) => receipts.push(receipt),
      onToolStart: (event) => toolStarts.push(event.name),
      onRunComplete: (event) => completions.push(event),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.ok(
    chatRequests.length >= 1 && chatRequests.length <= 2,
    "the resumed writeback may perform bounded planning but must not replay completed tools",
  );
  assert.equal(
    streamRequests.length,
    1,
    JSON.stringify({ statuses, completions, receipts, toolStarts }),
  );
  assert.ok(
    streamRequests[0].messages.some((message) =>
      message.content.includes(passageId),
    ),
    "the resumed draft must retain the durable passage proof",
  );
  assert.deepEqual(toolStarts, [], "completed read tools must not replay");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].toolName, "append_to_current_file");
  assert.equal(vault.files.get("Current.md"), `Initial note\n${candidate}`);
  assert.deepEqual(completions.map((event) => event.stopReason), [
    "write_completed",
  ]);

  const resumedRunId = configs.at(-1)?.runId;
  assert.ok(resumedRunId);
  const finalSnapshot = parseMissionRuntimeSnapshotFromMarkdown(
    vault.files.get(`Agent Runs/${resumedRunId}.md`) ?? "",
  );
  assert.ok(finalSnapshot);
  assert.equal(finalSnapshot.operationJournal.length, 1);
  assert.equal(finalSnapshot.operationJournal[0].state, "committed");
  assert.deepEqual(
    finalSnapshot.operationJournal[0].transitions.map((item) => item.state),
    ["intent_recorded", "applying", "applied", "verified", "committed"],
  );
  assert.equal(
    finalSnapshot.operationJournal[0].receipt?.toolName,
    "append_to_current_file",
  );
});

test("interrupted streamed writeback persists partial receipt and blocks unsafe continuation replay", async () => {
  const vault = createVaultHarness();
  vault.context.settings.enableStreaming = true;
  vault.context.settings.streamWritebackMode =
    "all_current_note_content_writes";
  const configs: AgentRunConfigEvent[] = [];
  const partialReceipts: Array<Record<string, unknown>> = [];
  const partialContent = Array.from(
    { length: 10 },
    () =>
      "Durable autonomous writeback keeps enough topical content to cross the live safety buffer. ",
  ).join("");
  const interruptedClient: ModelClient = {
    async chat() {
      throw new Error("Unexpected buffered chat call.");
    },
    async streamChat(_request, events: ModelChatStreamEvents = {}) {
      events.onContentDelta?.(partialContent);
      throw new Error("Simulated provider disconnect after streamed mutation.");
    },
  };

  await assert.rejects(
    () =>
      runAgentMission({
        prompt:
          "Write a concise paragraph about durable autonomous writeback on the current note.",
        modelClient: interruptedClient,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onRunConfig: (event) => configs.push(event),
          onReceipt: (receipt) =>
            partialReceipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /Simulated provider disconnect after streamed mutation/,
  );

  assert.equal(vault.files.get("Current.md"), `Initial note\n${partialContent}`);
  assert.equal(partialReceipts.length, 1);
  assert.equal(partialReceipts[0].partial, true);
  assert.equal(partialReceipts[0].operation, "append");

  const interruptedRunId = configs.at(-1)?.runId;
  assert.ok(interruptedRunId);
  const interruptedSnapshot = parseMissionRuntimeSnapshotFromMarkdown(
    vault.files.get(`Agent Runs/${interruptedRunId}.md`) ?? "",
  );
  assert.ok(interruptedSnapshot);
  assert.equal(interruptedSnapshot.operationJournal.length, 1);
  assert.equal(
    interruptedSnapshot.operationJournal[0].state,
    "reconcile_required",
  );
  assert.equal(
    interruptedSnapshot.operationJournal[0].mutationMayHaveApplied,
    true,
  );
  assert.equal(interruptedSnapshot.operationJournal[0].receipt?.path, "Current.md");
  assert.equal(
    (interruptedSnapshot.operationJournal[0].receipt?.output as
      | Record<string, unknown>
      | undefined)?.partial,
    true,
  );

  const resumeRequests: ModelChatRequest[] = [];
  const replayedTools: string[] = [];
  const assistant: string[] = [];
  const completions: string[] = [];
  await runAgentMission({
    prompt: `continue run ${interruptedRunId}`,
    modelClient: createModelClient([], resumeRequests),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onAssistantDelta: (content) => assistant.push(content),
      onToolStart: (event) => replayedTools.push(event.name),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(resumeRequests.length, 0);
  assert.deepEqual(replayedTools, []);
  assert.equal(vault.files.get("Current.md"), `Initial note\n${partialContent}`);
  assert.match(assistant.join(""), /unresolved mutation/i);
  assert.deepEqual(completions, ["error"]);
});

test("current-note rename and move receipts repin continuation to the relocated note", async () => {
  const vault = createVaultHarness();
  const configs: AgentRunConfigEvent[] = [];
  const firstRequests: ModelChatRequest[] = [];
  const firstToolResults: Array<{
    name: string;
    ok?: boolean;
    message?: string;
  }> = [];
  const relocationCalls: ModelToolCall[] = [
    {
      name: "rename_current_file",
      arguments: { title: "Durable Renamed" },
    },
    {
      name: "move_path",
      arguments: {
        fromPath: "Durable Renamed.md",
        toPath: "Moved.md",
      },
    },
  ];

  await runAgentMission({
    prompt:
      "Rename the current note to Durable Renamed, move Durable Renamed.md to Moved.md, then append the exact words continuation proof to the current note.",
    modelClient: createModelClientThenFail(
      [responseWithToolCalls(relocationCalls)],
      firstRequests,
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
      onToolDone: (event) => firstToolResults.push(event),
    },
  });

  const interruptedRunId = configs.at(-1)?.runId;
  assert.ok(interruptedRunId);
  assert.ok(
    firstRequests.length >= 2,
    "the interrupted run should reach a second model step",
  );
  assert.equal(
    firstToolResults[0]?.ok,
    true,
    JSON.stringify(firstToolResults),
  );
  assert.equal(
    firstToolResults[1]?.ok,
    true,
    JSON.stringify(firstToolResults),
  );
  assert.equal(vault.files.has("Current.md"), false);
  assert.equal(vault.files.has("Durable Renamed.md"), false);
  assert.equal(vault.files.get("Moved.md"), "Initial note");
  const interruptedSnapshot = parseMissionRuntimeSnapshotFromMarkdown(
    vault.files.get(`Agent Runs/${interruptedRunId}.md`) ?? "",
  );
  assert.ok(interruptedSnapshot);
  assert.equal(interruptedSnapshot.currentNotePath, "Moved.md");
  assert.equal(interruptedSnapshot.status, "blocked");

  const resumedRequests: ModelChatRequest[] = [];
  const resumedToolStarts: string[] = [];
  const resumedAssistant: string[] = [];
  await runAgentMission({
    prompt: `continue run ${interruptedRunId}`,
    modelClient: createModelClient(
      [
        responseWithToolCall("append_to_current_file", {
          text: "continuation proof",
        }),
        responseWithContent(
          "The continuation proof was appended to the relocated note.",
        ),
      ],
      resumedRequests,
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onAssistantDelta: (content) => resumedAssistant.push(content),
      onToolStart: (event) => resumedToolStarts.push(event.name),
    },
  });

  assert.ok(resumedRequests.length >= 1);
  assert.ok(resumedToolStarts.includes("append_to_current_file"));
  assert.doesNotMatch(resumedAssistant.join(""), /active note is/i);
  assert.equal(
    vault.files.get("Moved.md"),
    "Initial note\ncontinuation proof",
  );
});

test("coordinator-backed runner preserves config tool and completion events", async () => {
  const vault = createVaultHarness();
  const coordinator = new RunCoordinator();
  const observed: string[] = [];
  coordinator.subscribe({
    onRunConfig: () => observed.push("config"),
    onToolStart: (event) => observed.push(`start:${event.name}`),
    onToolDone: (event) => observed.push(`done:${event.name}`),
    onRunComplete: (event) => observed.push(`complete:${event.stopReason}`),
  });

  await coordinator.start((abortSignal, events) =>
    runAgentMission({
      prompt: "Append coordinator event proof to the current note.",
      modelClient: createModelClient([
        responseWithToolCall("append_to_current_file", {
          text: "Coordinator event proof",
        }),
      ]),
      toolRegistry: createDefaultToolRegistry(),
      toolContext: vault.context,
      enableStreaming: false,
      abortSignal,
      events,
    }),
  );

  assert.ok(observed.includes("config"));
  assert.ok(observed.includes("start:append_to_current_file"));
  assert.ok(observed.includes("done:append_to_current_file"));
  assert.ok(observed.includes("complete:write_completed"));
});

test("continue run hydrates plan, evidence, goals, and lineage into a new segment", async () => {
  const vault = createVaultHarness();
  const seedRunId = "run-resume-seed";
  const rootRunId = "run-root";
  const originalMission =
    "Research durable autonomous execution and preserve the cited findings.";
  const evidence: MissionEvidence = {
    id: "web_fetch:https://example.com/prior",
    kind: "web_source",
    title: "Prior durable-runtime source",
    url: "https://example.com/prior",
    summary: "Prior evidence retained across a run boundary.",
    confidence: "high",
  };
  const researchPlan: ResearchPlan = {
    version: 1,
    mode: "deep_web",
    sourceRequirements: {
      minFetchedSources: 1,
      minDistinctDomains: 1,
    },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "research-prior",
        question: "What makes autonomous execution durable?",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "complete",
        evidenceIds: [evidence.id],
      },
    ],
    evidenceIds: [evidence.id],
    status: "complete",
  };
  const priorPlan: MissionPlan = {
    version: 1,
    runId: seedRunId,
    status: "complete",
    activeTaskId: null,
    tasks: [
      {
        id: "task-prior",
        title: "Preserve the prior durable-runtime finding",
        status: "complete",
        allowedTools: ["web_search", "web_fetch"],
        dependencies: [],
        evidenceIds: [evidence.id],
        receiptIds: [],
        completionContract: {
          requiredProof: ["web_evidence"],
          minEvidenceCount: 1,
          minDistinctDomains: 1,
        },
      },
    ],
    progress: {
      score: 1,
      completedTasks: 1,
      totalTasks: 1,
      remainingTasks: 0,
      stalledCount: 0,
      lastMeaningfulAction: "Captured prior evidence.",
    },
    nextAction: {
      kind: "final",
      summary: "Report the preserved finding.",
    },
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:05:00.000Z",
  };
  const ledger = createMissionLedger({
    runId: seedRunId,
    mission: originalMission,
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 12,
      toolStepBudget: 8,
      finalizationReserve: 4,
      expectedTools: ["web_search", "web_fetch"],
      stopWhenSatisfied: true,
    },
    researchPlan,
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
  ledger.status = "budget";
  ledger.evidence = [evidence];
  ledger.nextActions = ["Report the preserved finding."];
  setLedgerMissionPlan(
    ledger,
    priorPlan,
    new Date("2026-07-10T12:05:00.000Z"),
  );
  await writeMissionLedger(vault.context, ledger);
  await writeMissionRuntimeSnapshot(
    vault.context,
    createMissionRuntimeSnapshot({
      runId: seedRunId,
      originalMission,
      rootRunId,
      segmentId: seedRunId,
      segmentIndex: 2,
      parentSegmentId: "run-segment-1",
      priorSegmentIds: [rootRunId, "run-segment-1"],
      status: "paused",
      missionPlan: priorPlan,
      researchPlan,
      evidence: [evidence],
      operationGoals: {
        web_search: "done",
        web_fetch: "done",
        current_note_content: "done",
      },
      lastSafeStep: 9,
      createdAt: new Date("2026-07-10T12:00:00.000Z"),
      updatedAt: new Date("2026-07-10T12:05:00.000Z"),
    }),
  );

  const configs: AgentRunConfigEvent[] = [];
  const chatRequests: ModelChatRequest[] = [];
  let hydratedAtModelStart: MissionRuntimeSnapshotV2 | null = null;
  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: createModelClient(
      [
        responseWithContent(
          `Continuing run ${seedRunId}: the restored durable-runtime finding is supported by https://example.com/prior.`,
        ),
      ],
      chatRequests,
      () => {
        if (hydratedAtModelStart) {
          return;
        }
        const resumedMarkdown = [...vault.files.entries()].find(
          ([path]) =>
            /^Agent Runs\/[^/]+\.md$/u.test(path) &&
            path !== `Agent Runs/${seedRunId}.md`,
        )?.[1];
        hydratedAtModelStart = resumedMarkdown
          ? parseMissionRuntimeSnapshotFromMarkdown(resumedMarkdown)
          : null;
      },
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  const resumedRunId = configs.at(-1)?.runId;
  assert.ok(resumedRunId);
  assert.notEqual(resumedRunId, seedRunId);
  const resumedConfig = configs.at(-1);
  assert.equal(resumedConfig?.route, "grounded_workflow");
  assert.equal(resumedConfig?.maxStepsForRun, 12);
  assert.equal(resumedConfig?.budgetProfile?.toolSteps, 8);
  assert.ok(
    resumedConfig?.routeTraceReasons.includes("resume_inherited_segment_budget"),
  );
  const resumedSnapshot = parseMissionRuntimeSnapshotFromMarkdown(
    vault.files.get(`Agent Runs/${resumedRunId}.md`) ?? "",
  );
  assert.ok(resumedSnapshot);
  assert.equal(resumedSnapshot.originalMission, originalMission);
  assert.equal(resumedSnapshot.lineage.rootRunId, rootRunId);
  assert.equal(resumedSnapshot.lineage.segmentIndex, 3);
  assert.equal(resumedSnapshot.lineage.parentSegmentId, seedRunId);
  assert.deepEqual(resumedSnapshot.lineage.priorSegmentIds, [
    rootRunId,
    "run-segment-1",
    seedRunId,
  ]);
  const hydratedSnapshot = hydratedAtModelStart as MissionRuntimeSnapshotV2 | null;
  assert.ok(hydratedSnapshot);
  assert.equal(hydratedSnapshot.evidence[0]?.id, evidence.id);
  assert.equal(hydratedSnapshot.operationGoals.web_search, "done");
  assert.equal(hydratedSnapshot.operationGoals.web_fetch, "done");
  assert.equal(hydratedSnapshot.operationGoals.current_note_content, "done");
  assert.ok(hydratedSnapshot.missionPlan);
  assert.ok(
    flattenMissionPlanTasks(hydratedSnapshot.missionPlan).some(
      (task) =>
        task.id === "task-prior" &&
        task.evidenceIds.includes(evidence.id),
    ),
  );
  assert.ok(
    chatRequests[0]?.messages.some((message) =>
      message.content.includes("https://example.com/prior"),
    ),
    "the hydrated evidence should also be visible to the resumed model segment",
  );
});

test("continue run restores receipt-backed completed title work", async () => {
  const vault = createVaultHarness();
  const seedRunId = "run-resume-completed-title";
  const originalMission =
    "Retitle the current note to Durable Title, then list the markdown files.";
  const ledger = createMissionLedger({
    runId: seedRunId,
    mission: originalMission,
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 8,
      toolStepBudget: 4,
      finalizationReserve: 4,
      expectedTools: ["retitle_current_file", "list_markdown_files"],
      stopWhenSatisfied: true,
    },
  });
  ledger.status = "budget";
  await writeMissionLedger(vault.context, ledger);
  await writeMissionRuntimeSnapshot(
    vault.context,
    createMissionRuntimeSnapshot({
      runId: seedRunId,
      originalMission,
      currentNotePath: "Current.md",
      status: "paused",
      operationGoals: { current_note_title: "done" },
      receipts: [
        {
          id: "receipt-completed-title",
          toolName: "retitle_current_file",
          operation: "retitle",
          message: "Visible note title updated.",
          path: "Current.md",
          createdAt: "2026-07-10T12:00:00.000Z",
        },
      ],
    }),
  );

  const traces: AgentTraceEvent[] = [];
  const toolStarts: string[] = [];
  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: createModelClient([
      responseWithToolCall("list_markdown_files", {}),
      responseWithContent("The completed title was preserved and the files were listed."),
    ]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onToolStart: (event) => toolStarts.push(event.name),
      onTrace: (event) => traces.push(event),
    },
  });

  assert.deepEqual(
    toolStarts,
    ["list_markdown_files"],
    JSON.stringify(traces.map((event) => ({ id: event.id, message: event.message }))),
  );
  const goalTrace = traces.find((event) => event.id.startsWith("operation-goals:"));
  assert.ok(goalTrace);
  const goalState = goalTrace.outputPreview as {
    goals?: Record<string, string>;
    completedTools?: string[];
  };
  assert.equal(goalState.goals?.current_note_title, "done");
  assert.ok(goalState.completedTools?.includes("retitle_current_file"));
});

test("continue run refuses an already accepted terminal mutation mission", async () => {
  const vault = createVaultHarness();
  const seedRunId = "run-terminal-write";
  const originalMission = "Append the terminal result to the current note.";
  const ledger = createMissionLedger({
    runId: seedRunId,
    mission: originalMission,
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 8,
      toolStepBudget: 4,
      finalizationReserve: 4,
      expectedTools: ["append_to_current_file"],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
  ledger.status = "complete";
  ledger.acceptance = {
    status: "pass",
    confidence: 0.95,
    missing: [],
    reasons: ["accepted"],
    checkedAt: "2026-07-10T12:01:00.000Z",
  };
  await writeMissionLedger(vault.context, ledger);
  await writeMissionRuntimeSnapshot(
    vault.context,
    createMissionRuntimeSnapshot({
      runId: seedRunId,
      originalMission,
      status: "complete",
      operationGoals: { current_note_content: "done" },
      acceptance: {
        status: "pass",
        confidence: 0.95,
        missing: [],
        reasons: ["accepted"],
      },
    }),
  );

  const requests: ModelChatRequest[] = [];
  const assistant: string[] = [];
  const completions: string[] = [];
  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: createModelClient([], requests),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onAssistantDelta: (content) => assistant.push(content),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(requests.length, 0);
  assert.equal(vault.files.get("Current.md"), "Initial note");
  assert.match(assistant.join(""), /already complete and accepted/i);
  assert.deepEqual(completions, ["final"]);
  assert.equal(
    [...vault.files.keys()].filter((path) => /^Agent Runs\/[^/]+\.md$/u.test(path))
      .length,
    1,
  );
});

test("continue run blocks an ambiguous applying mutation before model or tool replay", async () => {
  const vault = createVaultHarness();
  const seedRunId = "run-ambiguous-write";
  const originalMission = "Append the crash-sensitive result to the current note.";
  const ledger = createMissionLedger({
    runId: seedRunId,
    mission: originalMission,
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 8,
      toolStepBudget: 4,
      finalizationReserve: 4,
      expectedTools: ["append_to_current_file"],
      stopWhenSatisfied: true,
    },
  });
  ledger.status = "blocked";
  await writeMissionLedger(vault.context, ledger);
  const intent = createOperationJournalRecord({
    operationId: "op-ambiguous-append",
    rootRunId: seedRunId,
    segmentId: seedRunId,
    toolName: "append_to_current_file",
    operation: "append",
    targetPath: "Current.md",
  });
  const applying = transitionOperationJournalRecord(intent, "applying", {
    mutationMayHaveApplied: true,
    message: "Process stopped after mutation dispatch.",
  });
  await writeMissionRuntimeSnapshot(
    vault.context,
    createMissionRuntimeSnapshot({
      runId: seedRunId,
      originalMission,
      status: "paused",
      operationGoals: { current_note_content: "pending" },
      operationJournal: [applying],
    }),
  );

  const requests: ModelChatRequest[] = [];
  const assistant: string[] = [];
  const toolStarts: string[] = [];
  const completions: string[] = [];
  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: createModelClient([], requests),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onAssistantDelta: (content) => assistant.push(content),
      onToolStart: (event) => toolStarts.push(event.name),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(requests.length, 0);
  assert.deepEqual(toolStarts, []);
  assert.equal(vault.files.get("Current.md"), "Initial note");
  assert.match(assistant.join(""), /unresolved mutation/i);
  assert.deepEqual(completions, ["error"]);
});

test("continue run pauses current-note work when the active note changed", async () => {
  const vault = createVaultHarness();
  const seedRunId = "run-note-target-mismatch";
  const originalMission = "Append the pending result to the current note.";
  const ledger = createMissionLedger({
    runId: seedRunId,
    mission: originalMission,
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 8,
      toolStepBudget: 4,
      finalizationReserve: 4,
      expectedTools: ["append_to_current_file"],
      stopWhenSatisfied: true,
    },
  });
  ledger.status = "blocked";
  await writeMissionLedger(vault.context, ledger);
  await writeMissionRuntimeSnapshot(
    vault.context,
    createMissionRuntimeSnapshot({
      runId: seedRunId,
      originalMission,
      currentNotePath: "Research/Original.md",
      status: "paused",
      operationGoals: { current_note_content: "pending" },
    }),
  );

  const requests: ModelChatRequest[] = [];
  const assistant: string[] = [];
  const toolStarts: string[] = [];
  const completions: string[] = [];
  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: createModelClient([], requests),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onAssistantDelta: (content) => assistant.push(content),
      onToolStart: (event) => toolStarts.push(event.name),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(requests.length, 0);
  assert.deepEqual(toolStarts, []);
  assert.equal(vault.files.get("Current.md"), "Initial note");
  assert.match(assistant.join(""), /started on Research\/Original\.md/i);
  assert.match(assistant.join(""), /active note is Current\.md/i);
  assert.deepEqual(completions, ["clarifying_question"]);
});

test("resumed receipts do not spend the child segment tool budget or erase new goals", async () => {
  const vault = createVaultHarness();
  const seedRunId = "run-prior-receipt-budget";
  const originalMission =
    "Append the exact words child segment proof to the current note.";
  const ledger = createMissionLedger({
    runId: seedRunId,
    mission: originalMission,
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 6,
      toolStepBudget: 1,
      finalizationReserve: 4,
      expectedTools: ["append_to_current_file"],
      stopWhenSatisfied: true,
    },
  });
  ledger.status = "blocked";
  await writeMissionLedger(vault.context, ledger);
  await writeMissionRuntimeSnapshot(
    vault.context,
    createMissionRuntimeSnapshot({
      runId: seedRunId,
      originalMission,
      currentNotePath: "Current.md",
      status: "paused",
      receipts: [
        {
          id: "receipt-prior",
          toolName: "append_research_memory",
          operation: "append",
          message: "Prior segment receipt.",
          path: "Agent Research Memory/prior.md",
          createdAt: "2026-07-10T12:00:00.000Z",
          readback: {
            status: "verified",
            checkedAt: "2026-07-10T12:00:00.000Z",
            observedRevision: "fnv1a32:01234567",
            observedFingerprint: "fnv1a32:89abcdef",
          },
        },
      ],
      operationGoals: { current_note_content: "not_requested" },
    }),
  );

  const requests: ModelChatRequest[] = [];
  const toolStarts: string[] = [];
  const receipts: AgentRunReceipt[] = [];
  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: createModelClient(
      [
        responseWithToolCall("append_to_current_file", {
          text: "child segment proof",
        }),
        responseWithContent("The child segment append is complete."),
      ],
      requests,
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onToolStart: (event) => toolStarts.push(event.name),
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.ok(requests.length >= 1);
  assert.ok(toolStarts.includes("append_to_current_file"));
  assert.deepEqual(
    receipts.map((receipt) => receipt.id),
    ["receipt-prior", receipts.at(-1)?.id],
  );
  assert.deepEqual(receipts[0].readback, {
    status: "verified",
    checkedAt: "2026-07-10T12:00:00.000Z",
    observedRevision: "fnv1a32:01234567",
    observedFingerprint: "fnv1a32:89abcdef",
  });
  assert.equal(receipts.at(-1)?.toolName, "append_to_current_file");
  assert.equal(receipts.at(-1)?.readback?.status, "verified");
  assert.match(
    receipts.at(-1)?.readback?.observedFingerprint ?? "",
    /^(?:fnv1a32:[a-f0-9]{8}|sha256:[a-f0-9]{64})$/u,
  );
  assert.equal(vault.files.get("Current.md"), "Initial note\nchild segment proof");
  const childMarkdown = [...vault.files.entries()].find(
    ([path]) =>
      /^Agent Runs\/[^/]+\.md$/u.test(path) &&
      path !== `Agent Runs/${seedRunId}.md`,
  )?.[1];
  const childSnapshot = childMarkdown
    ? parseMissionRuntimeSnapshotFromMarkdown(childMarkdown)
    : null;
  assert.ok(childSnapshot);
  assert.equal(childSnapshot.operationGoals.current_note_content, "done");
});

test("required tool failure marks a budget outcome as ineligible for automatic continuation", async () => {
  const vault = createVaultHarness();
  vault.context.settings.maxAgentSteps = 4;
  const completions: AgentRunCompleteEvent[] = [];

  await runAgentMission({
    prompt: "Append required failure proof to the current note.",
    modelClient: createModelClient([
      responseWithToolCall("append_to_current_file", {}),
    ]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.equal(vault.files.get("Current.md"), "Initial note");
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stopReason, "budget");
  assert.equal(completions[0].autoContinueRecommended, false);
  assert.equal(completions[0].autoContinueReason, "required_tool_failure");
});

test("explicit missing run id fails closed instead of loading the latest unrelated checkpoint", async () => {
  const vault = createVaultHarness();
  await appendAgentRunCheckpoint(vault.context, {
    runId: "run-unrelated-newest",
    step: 2,
    maxSteps: 10,
    status: "running",
    message: "This unrelated checkpoint must never be loaded.",
  });
  let modelCalls = 0;
  const assistant: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];

  await runAgentMission({
    prompt: "continue run run-explicitly-missing",
    modelClient: createModelClient(
      [responseWithContent("MODEL MUST NOT RUN")],
      [],
      () => {
        modelCalls += 1;
      },
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => assistant.push(delta),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.equal(modelCalls, 0);
  assert.equal(completions.at(-1)?.stopReason, "error");
  assert.match(assistant.join(""), /exact durable checkpoint is unavailable/i);
  assert.doesNotMatch(assistant.join(""), /unrelated checkpoint/i);
});

test("durable child is seeded with an exact ledger and runtime snapshot before activation", async () => {
  const vault = createVaultHarness();
  await seedDurableChildRun(vault.context, {
    childRunId: "run-seeded-child",
    rootMissionId: "overnight-root",
    mission: "Research the exact overnight topic.",
    currentNotePath: "Current.md",
    segmentIndex: 0,
    priorSegmentIds: [],
    remainingModelSteps: 100,
    remainingToolCalls: 200,
  });

  const markdown = vault.files.get("Agent Runs/run-seeded-child.md") ?? "";
  const ledger = parseMissionLedgerFromMarkdown(markdown);
  const snapshot = parseMissionRuntimeSnapshotFromMarkdown(markdown);
  assert.equal(ledger?.runId, "run-seeded-child");
  assert.equal(ledger?.mission, "Research the exact overnight topic.");
  assert.equal(snapshot?.runId, "run-seeded-child");
  assert.equal(snapshot?.lineage.rootRunId, "overnight-root");
  assert.equal(snapshot?.currentNotePath, "Current.md");
});

test("per-invocation tool-call cap stops a parallel batch without overshoot", async () => {
  const vault = createVaultHarness();
  vault.context.settings.maxAgentSteps = 8;
  const executed: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const registry = createDefaultToolRegistry();

  await runAgentMission({
    prompt:
      "Append first cap proof and then append second cap proof to the current note.",
    modelClient: createModelClient([
      responseWithToolCalls([
        { name: "append_to_current_file", arguments: { text: "first cap proof" } },
        { name: "append_to_current_file", arguments: { text: "second cap proof" } },
      ]),
    ]),
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    maxToolCalls: 1,
    events: {
      onToolStart: (event) => executed.push(event.name),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.equal(executed.length, 1);
  assert.equal(completions.at(-1)?.stopReason, "budget");
  assert.match(vault.files.get("Current.md") ?? "", /first cap proof/);
  assert.doesNotMatch(vault.files.get("Current.md") ?? "", /second cap proof/);
});

test("the last permitted tool can satisfy acceptance exactly at the cap", async () => {
  const vault = createVaultHarness();
  const completions: AgentRunCompleteEvent[] = [];

  await runAgentMission({
    prompt: "Append exactly this text to the current note: cap acceptance proof",
    modelClient: createModelClient([
      responseWithToolCall("append_to_current_file", {
        text: "cap acceptance proof",
      }),
    ]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    maxToolCalls: 1,
    events: {
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.equal(vault.files.get("Current.md"), "Initial note\ncap acceptance proof");
  assert.equal(completions.at(-1)?.stopReason, "write_completed");
});

function createModelClient(
  responses: ModelChatResponse[],
  requests: ModelChatRequest[] = [],
  onChat?: () => void,
): ModelClient {
  let index = 0;
  return {
    async chat(request) {
      requests.push(cloneRequest(request));
      onChat?.();
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!response) {
        throw new Error("No model response configured.");
      }
      return response;
    },
    async streamChat(
      request: ModelChatRequest,
      events: ModelChatStreamEvents = {},
    ) {
      requests.push(cloneRequest(request));
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!response) {
        throw new Error("No model response configured.");
      }
      if (response.message.content) {
        events.onContentDelta?.(response.message.content);
      }
      return response;
    },
  };
}

function responseWithToolCall(
  name: string,
  args: Record<string, unknown>,
): ModelChatResponse {
  const toolCall: ModelToolCall = { name, arguments: args };
  return responseWithToolCalls([toolCall]);
}

function responseWithToolCalls(toolCalls: ModelToolCall[]): ModelChatResponse {
  return {
    message: {
      role: "assistant",
      content: "Executing the requested durable mutation.",
      toolCalls,
    },
    toolCalls,
  };
}

function createModelClientThenFail(
  responses: ModelChatResponse[],
  requests: ModelChatRequest[] = [],
): ModelClient {
  let index = 0;
  return {
    async chat(request) {
      requests.push(cloneRequest(request));
      const response = responses[index];
      index += 1;
      if (!response) {
        throw new Error("Simulated model interruption after durable mutation.");
      }
      return response;
    },
    async streamChat(request: ModelChatRequest) {
      requests.push(cloneRequest(request));
      const response = responses[index];
      index += 1;
      if (!response) {
        throw new Error("Simulated model interruption after durable mutation.");
      }
      return response;
    },
  };
}

function responseWithContent(content: string): ModelChatResponse {
  return {
    message: { role: "assistant", content },
    toolCalls: [],
  };
}

function getPassageCitationIds(request: ModelChatRequest): string[] {
  const matches = request.messages.flatMap((message) =>
    message.content.match(/source:[a-z0-9]+:passage:\d+-\d+/giu) ?? [],
  );
  return [...new Set(matches)];
}

function cloneRequest(request: ModelChatRequest): ModelChatRequest {
  return {
    ...request,
    messages: request.messages.map((message) => ({ ...message })),
    tools: request.tools ? [...request.tools] : undefined,
  };
}

function createVaultHarness(options: {
  beforeModify?: (
    path: string,
    files: Map<string, string>,
    nextContent: string,
  ) => void;
} = {}) {
  const files = new Map<string, string>([["Current.md", "Initial note"]]);
  const folders = new Set<string>();
  let clock = Date.parse("2026-07-10T12:30:00.000Z");
  const mtimes = new Map<string, number>([["Current.md", clock]]);
  let activeFile = createFile("Current.md");

  function createFile(path: string) {
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.[^.]+$/u, ""),
      extension: name.includes(".")
        ? name.split(".").pop()?.toLowerCase() ?? ""
        : "",
      stat: {
        mtime: mtimes.get(path) ?? clock,
        ctime: mtimes.get(path) ?? clock,
        size: files.get(path)?.length ?? 0,
      },
    };
  }

  function getFile(path: string) {
    return files.has(path) ? createFile(path) : null;
  }

  function getFolder(path: string) {
    return folders.has(path)
      ? { path, name: path.split("/").pop() ?? path, children: [] }
      : null;
  }

  const app = {
    workspace: {
      getActiveFile: () => activeFile,
    },
    vault: {
      getFiles: () => [...files.keys()].map(createFile),
      getAllLoadedFiles: () => [
        ...[...folders].map((path) => getFolder(path)),
        ...[...files.keys()].map(createFile),
      ].filter(Boolean),
      getFileByPath: getFile,
      getFolderByPath: getFolder,
      getAbstractFileByPath: (path: string) => getFile(path) ?? getFolder(path),
      read: async (file: { path: string }) => files.get(file.path) ?? "",
      cachedRead: async (file: { path: string }) => files.get(file.path) ?? "",
      createFolder: async (path: string) => {
        folders.add(path);
      },
      create: async (path: string, content: string) => {
        clock += 1;
        files.set(path, content);
        mtimes.set(path, clock);
        return createFile(path);
      },
      modify: async (file: { path: string }, content: string) => {
        options.beforeModify?.(file.path, files, content);
        clock += 1;
        files.set(file.path, content);
        mtimes.set(file.path, clock);
      },
      rename: async (file: { path: string }, toPath: string) => {
        const content = files.get(file.path);
        if (content === undefined) {
          throw new Error(`Path not found: ${file.path}`);
        }
        clock += 1;
        files.delete(file.path);
        mtimes.delete(file.path);
        files.set(toPath, content);
        mtimes.set(toPath, clock);
        if (activeFile.path === file.path) {
          activeFile = createFile(toPath);
        }
      },
    },
  };
  const context: ToolExecutionContext = {
    app: app as never,
    settings: createSettings(),
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
    getCurrentMarkdownContent: (file) => files.get(file.path) ?? null,
  };

  return { context, files };
}

function createSettings(): AgentSettings {
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
    maxAgentSteps: 12,
    maxRunMinutes: null,
    thinkingMode: "off",
    streamWritebackMode: "off",
    templateFolder: "Templates",
    templateOutputFolder: "",
    researchMemoryEnabled: true,
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
