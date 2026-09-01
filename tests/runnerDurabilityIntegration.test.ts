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
  createPrePlanningAnchorLedger,
  getMissionLedgerPath,
  isPrePlanningAnchorLedger,
  parseMissionLedgerFromMarkdown,
  removePrePlanningAnchorArtifact,
  setLedgerMissionPlan,
  summarizeMissionLedger,
  writeMissionLedger,
  type MissionEvidence,
} from "../src/agent/missionLedger";
import {
  buildMissionResumePlan,
  formatLedgerForModel,
} from "../src/agent/missionResume";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildContinuationHandoffV1 } from "../src/agent/continuationMemory";
import {
  createProjectLineageV1,
  createResearcherHandoffV1,
} from "../src/agent/projectLifecycle";
import { createAcceptedResearchArtifactV1 } from "../src/integrations/linear/AcceptedResearchArtifactV1";
import { appendAgentRunCheckpoint } from "../src/agent/checkpoints";
import { seedDurableChildRun } from "../src/agent/durableChildSeed";
import {
  buildMissionCapabilityEnvelopeV1,
  type MissionGraphV3,
} from "../packages/headless-runtime/src/missionGraphV3";
import {
  persistInitialMissionGraph,
  readMissionGraphStoreRecord,
  type MissionGraphStoreWriteResult,
} from "../src/agent/missionGraphStore";
import { canonicalMissionGraphId } from "../src/agent/missionGraphIds";
import type { OrchestratorSnapshotV1 } from "../src/orchestrator/types";
import {
  flattenMissionPlanTasks,
  type MissionPlan,
} from "../src/agent/missionPlan";
import type { ResearchEvidence, ResearchPlan } from "../src/agent/researchPlan";
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
import { ScopedToolRegistry } from "../src/tools/ScopedToolRegistry";
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
import { createAdaptiveTeamScaffoldV2 } from "../src/orchestrator/adaptiveTeam";
import {
  createSpecialistHandoffV2,
  isSpecialistHandoffV2,
} from "../src/orchestrator/specialistHandoff";
import { OrchestratorRuntime } from "../src/orchestrator/orchestratorRuntime";

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
      // Stream+tools planning turns must not emit note writeback deltas.
      if (request.tools?.length) {
        return responseWithContent(
          "The durable source proof is ready for writeback.",
        );
      }
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

  const planningStreamTurns = streamRequests.filter(
    (request) => Boolean(request.tools?.length),
  );
  const writebackStreams = streamRequests.filter(
    (request) => !request.tools?.length,
  );
  const planningTurns = chatRequests.length + planningStreamTurns.length;
  assert.ok(
    planningTurns >= 1 && planningTurns <= 3,
    `the resumed writeback may perform bounded planning but must not replay completed tools (planningTurns=${planningTurns}, chat=${chatRequests.length}, streamTools=${planningStreamTurns.length})`,
  );
  assert.equal(
    writebackStreams.length,
    1,
    JSON.stringify({ statuses, completions, receipts, toolStarts, streamRequests: streamRequests.length }),
  );
  assert.ok(
    writebackStreams[0].messages.some((message) =>
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
  assert.ok(
    resumedToolStarts.includes("append_to_current_file"),
    JSON.stringify(resumedRequests.map((request) => ({
      phase: request.evidencePhase,
      tools: request.tools?.map((tool) => tool.function.name) ?? [],
    }))),
  );
  assert.doesNotMatch(resumedAssistant.join(""), /active note is/i);
  assert.equal(
    vault.files.get("Moved.md"),
    "Initial note\ncontinuation proof",
  );
});

test("continue run of an interrupted streamed append requires append_to_current_file", async () => {
  const vault = createVaultHarness();
  vault.context.settings.streamWritebackMode = "all_current_note_content_writes";
  vault.context.settings.enableStreaming = true;
  const seedRunId = "run-interrupted-stream-append";
  const originalMission =
    "Perform exactly two ordered durable appends to the current note, then finish. " +
    "First append exactly one line containing MARKER_A1. " +
    "Then append exactly one separate line containing MARKER_B2. " +
    "Two appends total, in that order.";
  const ledger = createMissionLedger({
    runId: seedRunId,
    mission: originalMission,
    route: "single_model_writeback",
    loopBudget: {
      hardCap: 9,
      toolStepBudget: 6,
      finalizationReserve: 2,
      expectedTools: [],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-08-25T13:00:00.000Z"),
  });
  ledger.status = "blocked";
  ledger.continuationCommand = `continue run ${seedRunId}`;
  await writeMissionLedger(vault.context, ledger);
  await writeMissionRuntimeSnapshot(
    vault.context,
    createMissionRuntimeSnapshot({
      runId: seedRunId,
      originalMission,
      currentNotePath: "Current.md",
      status: "paused",
      // The interrupted segment ran under mission-graph authority. The store
      // itself did not survive this crash variant, so resume must fail
      // toward REQUIRING the append tool rather than blindly re-streaming
      // the original two-append prompt.
      missionGraphRef: {
        version: 1,
        missionId: canonicalMissionGraphId(seedRunId),
        path: `Agent Runs/Mission Graphs/${canonicalMissionGraphId(seedRunId)}.md`,
        storeRevision: 1,
        graphRevision: 0,
        recordFingerprint: `sha256:${"a".repeat(64)}`,
        journalHeadFingerprint: null,
      },
      operationGoals: { current_note_content: "pending" },
      lastSafeStep: 1,
      createdAt: new Date("2026-08-25T13:00:00.000Z"),
      updatedAt: new Date("2026-08-25T13:01:00.000Z"),
    }),
  );

  const requests: ModelChatRequest[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const assistant: string[] = [];
  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: createModelClient(
      [
        responseWithToolCall("append_to_current_file", {
          text: "MARKER_A1",
        }),
        responseWithToolCall("append_to_current_file", {
          text: "MARKER_B2",
        }),
      ],
      requests,
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onRunComplete: (event) => completions.push(event),
      onAssistantDelta: (content) => assistant.push(content),
    },
  });

  const firstTools = requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(
    requests.length > 0,
    JSON.stringify({
      files: [...vault.files.keys()],
      completions,
      assistant: assistant.join("").slice(0, 400),
    }),
  );
  assert.ok(
    firstTools.includes("append_to_current_file"),
    JSON.stringify(
      requests.map((request) => ({
        tools: request.tools?.map((tool) => tool.function.name) ?? [],
        last: String(request.messages?.at(-1)?.content ?? "").slice(0, 120),
      })),
    ),
  );
  // The resumed segment must PAY the appends it owes, one marker per call.
  // This assertion previously read "the run ends still owing
  // append_to_current_file", which the mission-scoped literal checker
  // satisfied for the wrong reason: it rejected every single-marker append
  // for "missing" the other step's marker, so the owed write could never be
  // paid at all. With the checker step-scoped, both ordered appends land.
  const note = vault.files.get("Current.md") ?? "";
  assert.equal(
    note.split("MARKER_A1").length - 1,
    1,
    JSON.stringify({ note, completion: completions.at(-1) }),
  );
  // This segment's budget ends after the first ordered append; the remaining
  // marker is owed to the next segment, and the run must say so rather than
  // reporting completion.
  assert.equal(completions.at(-1)?.stopReason, "budget");
  assert.equal(completions.at(-1)?.autoContinueRecommended, true);
});

test("continue of a crash-restored tool-less final stub splices the owed write and pays it", async () => {
  const vault = createVaultHarness();
  vault.context.settings.streamWritebackMode = "all_current_note_content_writes";
  vault.context.settings.enableStreaming = true;
  const originalMission =
    "Write a concise paragraph about durable autonomous writeback on the current note.";

  // Segment 1: the streamed current-note write dies before the first byte.
  // This is the crash shape from the proof matrix: the mission graph store
  // already persisted the ready, tool-less `final` stub, while the promised
  // append paid nothing (no evidence, no receipts, no journal ambiguity).
  const configs: AgentRunConfigEvent[] = [];
  const interruptedClient: ModelClient = {
    async chat() {
      throw new Error("Unexpected buffered chat call.");
    },
    async streamChat() {
      throw new Error("Simulated crash before the first streamed byte.");
    },
  };
  await assert.rejects(
    () =>
      runAgentMission({
        prompt: originalMission,
        modelClient: interruptedClient,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: { onRunConfig: (event) => configs.push(event) },
      }),
    /Simulated crash before the first streamed byte/,
  );
  const interruptedRunId = configs.at(-1)?.runId;
  assert.ok(interruptedRunId);
  const interruptedStore = await readMissionGraphStoreRecord(
    vault.context,
    canonicalMissionGraphId(interruptedRunId),
  );
  assert.ok(
    interruptedStore,
    "Segment 1 must persist the mission graph store; without it this fixture no longer reproduces the crash-restored stub.",
  );
  // Rebuild the exact crash artifact the proof matrix observed: the store
  // holds ONLY the ready, tool-less `final` stub (evidenceCount=0,
  // receiptCount=0) under the product's own host-built envelope. The
  // envelope is reused verbatim so the continuation's envelope-fingerprint
  // gate exercises the same check the live resume passed.
  const interruptedGraph = interruptedStore.record.graph;
  const finalNode = interruptedGraph.nodes.final;
  assert.ok(finalNode);
  const graphStorePath = [...vault.files.keys()].find((path) =>
    path.startsWith("Agent Runs/Mission Graphs/"),
  );
  assert.ok(graphStorePath);
  vault.files.delete(graphStorePath);
  await persistInitialMissionGraph(vault.context, {
    ...interruptedGraph,
    revision: 0,
    journalHeadFingerprint: null,
    continuationCheckpoint: null,
    nodes: {
      final: {
        ...finalNode,
        dependencyIds: [],
        status: "ready",
        allowedTools: [],
        evidence: [],
        receipts: [],
      },
    },
  });
  const storedStub = await readMissionGraphStoreRecord(
    vault.context,
    canonicalMissionGraphId(interruptedRunId),
  );
  assert.ok(storedStub);
  assert.deepEqual(
    Object.keys(storedStub.record.graph.nodes),
    ["final"],
    "The crash-restored store must hold only the tool-less final stub, or the resume splice has nothing to heal.",
  );
  assert.deepEqual(storedStub.record.graph.nodes.final.allowedTools, []);
  // The crash also predates the error-path continuation handoff, so the run
  // note holds only the safe-boundary ledger and snapshot: current-note work
  // still pending, no handoff, no ambiguous operations.
  const stubLedger = createMissionLedger({
    runId: interruptedRunId,
    mission: originalMission,
    route: "single_model_writeback",
    loopBudget: {
      hardCap: 9,
      toolStepBudget: 6,
      finalizationReserve: 2,
      expectedTools: [],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-08-25T13:00:00.000Z"),
  });
  stubLedger.status = "blocked";
  stubLedger.continuationCommand = `continue run ${interruptedRunId}`;
  await writeMissionLedger(vault.context, stubLedger);
  await writeMissionRuntimeSnapshot(
    vault.context,
    createMissionRuntimeSnapshot({
      runId: interruptedRunId,
      originalMission,
      currentNotePath: "Current.md",
      status: "paused",
      missionGraphRef: {
        version: 1,
        missionId: storedStub.record.missionId,
        path: graphStorePath,
        storeRevision: storedStub.record.storeRevision,
        graphRevision: storedStub.record.graph.revision,
        recordFingerprint: storedStub.record.recordFingerprint,
        journalHeadFingerprint: storedStub.record.graph.journalHeadFingerprint,
      },
      operationGoals: { current_note_content: "pending" },
      lastSafeStep: 1,
      createdAt: new Date("2026-08-25T13:00:00.000Z"),
      updatedAt: new Date("2026-08-25T13:01:00.000Z"),
    }),
  );

  // Segment 2: continue must heal the restored graph BEFORE the loop starts —
  // splice the owed write node — so the loop decision, the frontier, and the
  // graph authority all answer "the write is still owed" identically.
  const resumeRequests: ModelChatRequest[] = [];
  const toolStarts: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const traces: AgentTraceEvent[] = [];
  await runAgentMission({
    prompt: `continue run ${interruptedRunId}`,
    modelClient: createModelClient(
      [
        responseWithToolCall("append_to_current_file", {
          text: "MARKER_HEALED_APPEND: durable autonomous writeback keeps every promised note mutation receipt-backed.",
        }),
        {
          message: {
            role: "assistant",
            content:
              "The owed current-note paragraph is durably recorded via the spliced write node.",
            toolCalls: [],
          },
          toolCalls: [],
        },
      ],
      resumeRequests,
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onToolStart: (event) => toolStarts.push(event.name),
      onRunComplete: (event) => completions.push(event),
      onTrace: (event) => traces.push(event),
    },
  });

  assert.ok(
    traces.some((event) => event.id === "mission-graph-resume-writeback-splice"),
    JSON.stringify({
      rule: "Resume of a tool-less final stub that still owes its current-note mutation must splice the write node into the authoritative graph before the loop starts.",
      traceIds: traces.map((event) => event.id).slice(0, 60),
      failures: traces
        .filter((event) => /failed|error/iu.test(event.id))
        .map((event) => event.message)
        .slice(0, 5),
    }),
  );
  const healedRecord = await readMissionGraphStoreRecord(
    vault.context,
    canonicalMissionGraphId(interruptedRunId),
  );
  assert.ok(healedRecord);
  assert.ok(
    healedRecord.record.journal.some((entry) =>
      entry.patch.operations.some(
        (operation) =>
          operation.op === "add_node" &&
          operation.node.id === "resume-current-note-write",
      ),
    ),
    "The splice must be journaled like any other authority patch; persisted graphs resume verbatim, so an unjournaled heal would vanish on the next crash.",
  );
  // Seat 1 must not force a tool-less final: the model was actually asked
  // with the write tool offered.
  const firstTools =
    resumeRequests[0]?.tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(
    firstTools.includes("append_to_current_file"),
    JSON.stringify({
      rule: "The healed graph must expose append_to_current_file through the normal frontier on the very first resumed step.",
      requests: resumeRequests.map(
        (request) => request.tools?.map((tool) => tool.function.name) ?? [],
      ),
    }),
  );
  // Seat 3 must authorize the call: the owed append executes and lands.
  assert.ok(
    toolStarts.includes("append_to_current_file"),
    JSON.stringify({
      rule: "The graph session must authorize the spliced tool instead of refusing its own required write.",
      toolStarts,
      completions,
    }),
  );
  const noteContent = vault.files.get("Current.md") ?? "";
  assert.match(noteContent, /MARKER_HEALED_APPEND/u);
});

test("a restored stub whose envelope cannot grant the required write is abandoned for a fresh plan", async () => {
  // Proof-matrix interrupted-continuation run 7 (2026-08-26 07:55Z): the
  // heal refused three times with the named guard envelope_grant_missing.
  // A crash can persist a tool-less `final` stub whose capability envelope
  // never granted append_to_current_file — the segment that planted it
  // planned no write node, so no grant was ever minted. Adopting that
  // record makes the mission's required write STRUCTURALLY impossible: the
  // heal cannot splice a node the envelope does not authorize, the frontier
  // fallback still offers the tool, and the authority refuses every call
  // until the budget dies. The continuation must refuse the adoption and
  // replan, which mints a real append node and a matching grant.
  const vault = createVaultHarness();
  vault.context.settings.semanticSearchEnabled = true;
  const originalMission =
    "Perform exactly two ordered durable appends to the current note, then finish. " +
    "First append exactly one line containing MARKER_A1 and verify that write. " +
    "Then append exactly one separate line containing MARKER_B2 and verify that write. " +
    "Two appends total, in that order. This task needs no web, memory, or vault research.";
  const interruptedRunId = "run-stub-envelope-unusable";
  const missionId = canonicalMissionGraphId(interruptedRunId);

  // A stub graph whose envelope grants only a READ tool: exactly the shape
  // whose heal refusal named envelope_grant_missing.
  const createdAt = "2026-08-26T07:50:00.000Z";
  const capabilityEnvelope = await buildMissionCapabilityEnvelopeV1({
    missionId,
    issuedAt: createdAt,
    expiresAt: null,
    capabilities: ["vault.read"],
    executionHosts: ["obsidian_core"],
    executors: {
      core: {
        id: "core",
        executionHosts: ["obsidian_core"],
        allowedEffects: ["read"],
      },
    },
    verifiers: ["artifact-verifier"],
    tools: {
      read_current_file: {
        name: "read_current_file",
        effect: "read",
        capabilityIds: ["vault.read"],
        executionHosts: ["obsidian_core"],
        bindingKinds: [],
      },
    },
    bindings: {},
    budgets: {
      maxNodes: 8,
      maxDepth: 1,
      maxConcurrentReadNodes: 2,
      maxTotalToolCalls: 8,
      maxExternalActions: 0,
      maxWallClockMs: 120_000,
      maxAttemptsPerNode: 2,
    },
  });
  await persistInitialMissionGraph(vault.context, {
    schemaVersion: 3,
    missionId,
    objective: originalMission,
    revision: 0,
    journalHeadFingerprint: null,
    createdAt,
    updatedAt: createdAt,
    routing: {
      source: "deterministic",
      fallbackFrom: null,
      fallbackReason: null,
      confidence: 1,
      decidedAt: createdAt,
      decisionFingerprint: `sha256:${"2".repeat(64)}`,
    },
    continuationCheckpoint: null,
    capabilityEnvelope,
    nodes: {
      final: {
        id: "final",
        dependencyIds: [],
        objective: "Deliver a verified final result.",
        executorId: "core",
        executionHost: "obsidian_core",
        effect: "read",
        inputs: {},
        outputs: {},
        requiredCapabilities: [],
        allowedTools: [],
        destination: null,
        resourceLocks: [],
        budget: { toolCalls: 0, externalActions: 0, wallClockMs: 30_000 },
        retries: {
          maxAttempts: 2,
          attempts: 0,
          failureFingerprints: [],
          consecutiveFailureFingerprint: null,
          consecutiveFailureCount: 0,
        },
        status: "ready",
        evidence: [],
        receipts: [],
        verification: null,
        completionContract: {
          criteria: ["A final answer is delivered."],
          minimumEvidence: 1,
          requiredEvidenceKinds: ["final-output"],
          minimumReceipts: 0,
          requiredReceiptKinds: [],
          verifierId: null,
        },
        blocker: null,
      },
    },
  });
  await writeMissionLedger(
    vault.context,
    createPrePlanningAnchorLedger({
      runId: interruptedRunId,
      mission: originalMission,
      targetNotePath: "Current.md",
      now: new Date("2026-08-26T07:50:30.000Z"),
    }),
  );

  const traces: AgentTraceEvent[] = [];
  const toolStarts: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  await runAgentMission({
    prompt: `continue run ${interruptedRunId}`,
    modelClient: createModelClient([
      responseWithToolCall("append_to_current_file", { text: "MARKER_A1" }),
      responseWithToolCall("append_to_current_file", { text: "MARKER_B2" }),
      {
        message: {
          role: "assistant",
          content: "Both ordered appends are durably recorded.",
          toolCalls: [],
        },
        toolCalls: [],
      },
    ]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onTrace: (event) => traces.push(event),
      onToolStart: (event) => toolStarts.push(event.name),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.ok(
    traces.some(
      (event) => event.id === "mission-graph-resume-stub-envelope-unusable",
    ),
    JSON.stringify({
      rule: "An unpaid final-only stub whose envelope cannot grant the required write must be refused, not adopted.",
      traceIds: traces.map((event) => event.id).slice(0, 40),
    }),
  );
  // The replan must produce a real, authorized write — no heal refusal, no
  // authority rejection, and the owed marker actually lands.
  assert.deepEqual(
    traces
      .filter((event) => /graph-rejected|splice-refused/u.test(event.id))
      .map((event) => event.id),
    [],
    JSON.stringify({
      rule: "After refusing the unusable stub the replanned graph must authorize the write outright.",
      completion: completions.at(-1),
    }),
  );
  assert.ok(
    toolStarts.includes("append_to_current_file"),
    JSON.stringify({ toolStarts, completion: completions.at(-1) }),
  );
  const note = vault.files.get("Current.md") ?? "";
  assert.equal(
    note.split("MARKER_A1").length - 1,
    1,
    JSON.stringify({ note, completion: completions.at(-1) }),
  );
});

test("continue of a stub graph with streaming off and only the durable anchor heals and pays the append", async () => {
  // Proof-matrix interrupted-continuation, 2026-08-25 22:41Z: the lane runs
  // with streamWritebackMode "off" and the kill predates the first runtime
  // checkpoint, so the continuation resumes from the pre-planning anchor
  // alone — no snapshot, no missionGraphRef — while the graph store still
  // holds the crash-persisted tool-less `final` stub under the run's
  // canonical mission id. The streamed-append resume flag can never be set
  // on this path, so the splice heal must key on the graph's own state plus
  // the restored mission's write contract. Unhealed, every continuation
  // segment burned its budget: the loop forced tool-less synthesis
  // (graph_final_only=true with zero receipts) while the frontier fallback
  // offered append_to_current_file and the graph authority rejected all
  // seven attempts as category=unknown_tool.
  const vault = createVaultHarness();
  // The lane's mission verbatim, steer sentence included: it is what keeps
  // the deterministic research classifiers from planting web-evidence
  // pre-write debt on the continuation. The word "memory" also routes the
  // structured-intent preflight through semantic search, which the live
  // lane enables — mirror that here.
  vault.context.settings.semanticSearchEnabled = true;
  const originalMission =
    "Perform exactly two ordered durable appends to the current note, then finish. " +
    "First append exactly one line containing MARKER_A1 and verify that write. " +
    "Then append exactly one separate line containing MARKER_B2 and verify that write. " +
    "Two appends total, in that order. This task needs no web, memory, or vault research.";

  // Segment 1: the buffered two-append mission dies at its first model call.
  // The graph store has already persisted the product's own planned graph and
  // envelope; reuse that envelope verbatim when rebuilding the crash stub so
  // the continuation exercises the same envelope-fingerprint gate as the
  // live resume.
  const configs: AgentRunConfigEvent[] = [];
  const interruptedClient: ModelClient = {
    async chat() {
      throw new Error("Simulated kill before the first buffered model reply.");
    },
    async streamChat() {
      throw new Error("Simulated kill before the first streamed byte.");
    },
  };
  await runAgentMission({
    prompt: originalMission,
    modelClient: interruptedClient,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: { onRunConfig: (event) => configs.push(event) },
  }).catch(() => {
    // The simulated kill may surface as a rejected run or a completed error
    // run depending on the terminal path; only the durable artifacts matter.
  });
  const interruptedRunId = configs.at(-1)?.runId;
  assert.ok(interruptedRunId);
  const interruptedStore = await readMissionGraphStoreRecord(
    vault.context,
    canonicalMissionGraphId(interruptedRunId),
  );
  assert.ok(
    interruptedStore,
    "Segment 1 must persist the mission graph store; without it this fixture no longer reproduces the crash-restored stub.",
  );
  const interruptedGraph = interruptedStore.record.graph;
  const finalNode = interruptedGraph.nodes.final;
  assert.ok(finalNode);
  const graphStorePath = [...vault.files.keys()].find((path) =>
    path.startsWith("Agent Runs/Mission Graphs/"),
  );
  assert.ok(graphStorePath);
  vault.files.delete(graphStorePath);
  await persistInitialMissionGraph(vault.context, {
    ...interruptedGraph,
    revision: 0,
    journalHeadFingerprint: null,
    continuationCheckpoint: null,
    nodes: {
      final: {
        ...finalNode,
        dependencyIds: [],
        status: "ready",
        allowedTools: [],
        evidence: [],
        receipts: [],
      },
    },
  });
  // The kill predates mission-ledger-start AND the first checkpoint: replace
  // the run note with ONLY the pre-planning anchor, exactly what the durable
  // anchor seam had persisted, and leave no runtime snapshot at all.
  vault.files.delete(`Agent Runs/${interruptedRunId}.md`);
  await writeMissionLedger(
    vault.context,
    createPrePlanningAnchorLedger({
      runId: interruptedRunId,
      mission: originalMission,
      targetNotePath: "Current.md",
      now: new Date("2026-08-25T22:41:00.000Z"),
    }),
  );

  // Segment 2: `continue run <id>` must heal the restored stub before the
  // loop starts even though no streamed-writeback context exists. Match the
  // live proof lane's authority router and automatic profile: the router gets
  // its own structured response, while every actual agent step follows the
  // one tool the host offered. This catches a menu/authority disagreement
  // without hard-coding the tool name the mock is supposed to choose.
  vault.context.settings.modelRouterEnabled = true;
  vault.context.settings.modelRouterMode = "authority";
  vault.context.settings.workingMode = "automatic";
  vault.context.settings.agenticReflexEnabled = true;
  vault.context.settings.maxAgentSteps = 24;
  const resumeRequests: ModelChatRequest[] = [];
  const toolStarts: string[] = [];
  const appendToolStartIds: string[] = [];
  const appendReceipts: AgentRunReceipt[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const traces: AgentTraceEvent[] = [];
  const seg2Configs: AgentRunConfigEvent[] = [];
  const orderedAgentResponses = [
    // Live GLM Flash ignored the one-tool append schema and emitted four
    // copies of read_current_file. The host already knows the only legal
    // action and both exact user literals, so the response must be projected
    // onto the two unpaid append slots instead of recording four refusals.
    responseWithToolCalls(
      Array.from({ length: 4 }, () => ({
        name: "read_current_file",
        arguments: {},
      })),
    ),
    {
      message: {
        role: "assistant" as const,
        content:
          "Both ordered appends are durably recorded with verified receipts.",
        toolCalls: [],
      },
      toolCalls: [],
    },
  ];
  let orderedAgentResponseIndex = 0;
  const respondToAuthorityOrAgentStep = (
    request: ModelChatRequest,
  ): ModelChatResponse => {
    resumeRequests.push(cloneRequest(request));
    if (request.evidencePhase === "router") {
      return responseWithContent(
        JSON.stringify({
          mode: "vault_write",
          writeScope: "current_note_append",
          needsWebEvidence: false,
          needsVaultContext: false,
          needsCodeExecution: false,
          wordTarget: null,
          confidence: 0.99,
          rationale: "Two exact target-only current-note appends are required.",
        }),
      );
    }
    if (request.evidencePhase === "graph_planner") {
      const system = request.messages.find((message) => message.role === "system");
      const template = /requiredProposalTemplate=(\{[^\n]+\})/u.exec(
        system?.content ?? "",
      )?.[1];
      return responseWithContent(
        template ?? JSON.stringify({ confidence: 0.99, nodes: [] }),
      );
    }
    const offered = request.tools?.map((tool) => tool.function.name) ?? [];
    if (offered.length > 0) {
      assert.deepEqual(
        offered,
        ["append_to_current_file"],
        JSON.stringify({
          rule: "Every resumed tool step must expose the one exact owed append and no redundant read.",
          offered,
          evidencePhase: request.evidencePhase ?? null,
        }),
      );
    }
    const response =
      orderedAgentResponses[
        Math.min(orderedAgentResponseIndex, orderedAgentResponses.length - 1)
      ];
    orderedAgentResponseIndex += 1;
    return response!;
  };
  const resumedClient: ModelClient = {
    chat: async (request) => respondToAuthorityOrAgentStep(request),
    streamChat: async (request, events = {}) => {
      const response = respondToAuthorityOrAgentStep(request);
      if (response.message.content) {
        events.onContentDelta?.(response.message.content);
      }
      return response;
    },
  };
  const scopedResumeRegistry = new ScopedToolRegistry(
    createDefaultToolRegistry(),
    (toolName) => toolName === "append_to_current_file",
  );
  // Native target-only writes can have no active editor cache after a plugin
  // restart even though the current TFile is still readable. The production
  // projector must use that durable vault read instead of refusing GLM's safe
  // read-name drift and losing the ordered append frontier.
  vault.context.getCurrentMarkdownContent = undefined;
  assert.equal(
    scopedResumeRegistry.getDescriptor("read_current_file"),
    null,
    "The production-shaped scope must hide the drifted read descriptor so the test cannot pass through registry metadata.",
  );
  await runAgentMission({
    prompt: `continue run ${interruptedRunId}`,
    modelClient: resumedClient,
    toolRegistry: scopedResumeRegistry,
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => seg2Configs.push(event),
      onToolStart: (event) => {
        toolStarts.push(event.name);
        if (event.name === "append_to_current_file") {
          appendToolStartIds.push(event.id);
        }
      },
      onReceipt: (receipt) => {
        if (receipt.operation === "append") appendReceipts.push(receipt);
      },
      onRunComplete: (event) => completions.push(event),
      onTrace: (event) => traces.push(event),
    },
  });

  assert.ok(
    traces.some((event) => event.id === "mission-graph-resume-writeback-splice"),
    JSON.stringify({
      rule: "The splice heal must fire from the graph's own owes-work state; the streamed-append resume flag cannot exist on a streaming-off anchor-only continuation.",
      traceIds: traces.map((event) => event.id).slice(0, 60),
      failures: traces
        .filter((event) => /failed|error/iu.test(event.id))
        .map((event) => event.message)
        .slice(0, 5),
    }),
  );
  // The frontier and the authority must agree: the offered append is the one
  // the graph session admits, so no call may be rejected as an unknown or
  // not-ready graph tool.
  const graphRejections = traces.filter((event) =>
    /graph-rejected/u.test(event.id),
  );
  assert.deepEqual(
    graphRejections.map((event) => event.message),
    [],
    "The graph authority rejected a tool the offered frontier advertised — the two subsystems disagree again.",
  );
  assert.deepEqual(
    traces
      .filter((event) => event.kind === "tool_rejected")
      .map((event) => ({ id: event.id, message: event.message })),
    [],
    "Safe read-name drift on a fully bound append frontier must not manufacture failed tool events.",
  );
  const orderedProjection = traces.find(
    (event) =>
      event.id === "ordered-current-note-append-frontier-projection-1",
  );
  assert.ok(
    orderedProjection,
    JSON.stringify({
      rule: "The live four-read provider deviation must be visibly projected onto exact append debt.",
      traceIds: traces.map((event) => event.id),
    }),
  );
  assert.deepEqual(
    (orderedProjection.outputPreview as {
      remappedFrom?: string[];
      droppedToolNames?: string[];
      remainingLiteralSlots?: number;
    })?.remappedFrom,
    ["read_current_file", "read_current_file"],
  );
  assert.deepEqual(
    (orderedProjection.outputPreview as { droppedToolNames?: string[] })
      ?.droppedToolNames,
    ["read_current_file", "read_current_file"],
  );
  const firstAgentRequest = resumeRequests.find(
    (request) => request.evidencePhase === "agent_step",
  );
  const firstTools =
    firstAgentRequest?.tools?.map((tool) => tool.function.name) ?? [];
  assert.deepEqual(
    firstTools,
    ["append_to_current_file"],
    JSON.stringify({
      rule: "An ordered same-note write continuation must expose only its exact ready append; capability reads must not distract the model from unpaid write debt.",
      requests: resumeRequests.map(
        (request) => request.tools?.map((tool) => tool.function.name) ?? [],
      ),
    }),
  );
  assert.ok(
    toolStarts.includes("append_to_current_file"),
    JSON.stringify({
      rule: "The graph session must authorize the spliced tool instead of refusing its own required write.",
      toolStarts,
      completions,
    }),
  );
  // The continuation with ZERO paid receipts must never be steered into
  // tool-less final synthesis by the final-only stub.
  const forcedFinalBeforeAnyReceipt = traces.find(
    (event) =>
      event.id.startsWith("loop-decision-") &&
      /action=force_final_no_tools/u.test(event.message ?? "") &&
      /graph_stub_owes_work=true/u.test(event.message ?? ""),
  );
  assert.equal(
    forcedFinalBeforeAnyReceipt,
    undefined,
    JSON.stringify({
      rule: "A final-only graph counts as satisfied only when its completed nodes carry real receipts/evidence.",
      decision: forcedFinalBeforeAnyReceipt?.message,
    }),
  );
  // The heal splices ONE owed node PER still-missing required marker (a
  // node's completion contract closes at its first satisfied receipt, so a
  // single node cannot carry the second append across segments).
  const healedStub = await readMissionGraphStoreRecord(
    vault.context,
    canonicalMissionGraphId(interruptedRunId),
  );
  assert.ok(healedStub);
  assert.ok(
    healedStub.record.graph.nodes["resume-current-note-write-2"],
    JSON.stringify({
      rule: "A two-marker mission with neither marker landed owes TWO spliced write nodes.",
      nodeIds: Object.keys(healedStub.record.graph.nodes),
    }),
  );
  // The owed work actually lands: the first ordered append is paid exactly
  // once in this segment (the second may fall to a later segment when the
  // spliced budget ends the loop first, and the run must say so).
  const note = vault.files.get("Current.md") ?? "";
  assert.equal(
    note.split("MARKER_A1").length - 1,
    1,
    JSON.stringify({ note, completion: completions.at(-1) }),
  );
  const lastCompletion = completions.at(-1);
  assert.ok(lastCompletion);
  if (!note.includes("MARKER_B2")) {
    assert.equal(
      lastCompletion.stopReason,
      "budget",
      JSON.stringify({
        completion: lastCompletion,
        trace: traces.slice(-40).map((event) => ({
          id: event.id,
          message: event.message,
          error: event.error,
        })),
      }),
    );
    assert.equal(lastCompletion.autoContinueRecommended, true);
    // Segment 3 — the lane's next explicit continuation. The restored graph
    // now holds a PAID spliced node (complete, receipt-backed) beside the
    // still-owed second node: the "graph outranks segment accounting"
    // shortcut must not read the paid node as "all satisfied", and the
    // second owed append must be offered, authorized, and land.
    const seg2RunId = seg2Configs.at(-1)?.runId;
    assert.ok(seg2RunId, "segment 2 must publish its run id for continuation");
    const seg3Traces: AgentTraceEvent[] = [];
    const seg3Completions: AgentRunCompleteEvent[] = [];
    await runAgentMission({
      prompt: `continue run ${seg2RunId}`,
      modelClient: createModelClient([
        responseWithToolCall("append_to_current_file", {
          text: "MARKER_B2",
        }),
        {
          message: {
            role: "assistant",
            content:
              "Both ordered appends are durably recorded with verified receipts.",
            toolCalls: [],
          },
          toolCalls: [],
        },
      ]),
      toolRegistry: createDefaultToolRegistry(),
      toolContext: vault.context,
      enableStreaming: false,
      events: {
        onTrace: (event) => seg3Traces.push(event),
        onToolStart: (event) => {
          toolStarts.push(event.name);
          if (event.name === "append_to_current_file") {
            appendToolStartIds.push(event.id);
          }
        },
        onReceipt: (receipt) => {
          if (receipt.operation === "append") appendReceipts.push(receipt);
        },
        onRunComplete: (event) => seg3Completions.push(event),
      },
    });
    assert.deepEqual(
      seg3Traces
        .filter((event) => /graph-rejected/u.test(event.id))
        .map((event) => event.message),
      [],
      "Segment 3 must not have the authority refuse the second owed append.",
    );
    const seg3Note = vault.files.get("Current.md") ?? "";
    assert.equal(
      seg3Note.split("MARKER_B2").length - 1,
      1,
      JSON.stringify({
        note: seg3Note,
        completion: seg3Completions.at(-1),
        traceIds: seg3Traces.map((event) => event.id).slice(0, 60),
      }),
    );
    assert.equal(seg3Note.split("MARKER_A1").length - 1, 1, seg3Note);
  } else {
    assert.equal(note.split("MARKER_B2").length - 1, 1, note);
  }
  assert.equal(
    toolStarts.filter((name) => name === "append_to_current_file").length,
    2,
    JSON.stringify({
      rule: "Two ordered durable appends require two executed append calls, even when one model response carries both literals.",
      toolStarts,
      note: vault.files.get("Current.md") ?? "",
    }),
  );
  assert.equal(
    new Set(appendToolStartIds).size,
    2,
    JSON.stringify({
      rule: "Distinct tool executions across continuation segments require distinct observable call identities.",
      appendToolStartIds,
    }),
  );
  assert.ok(
    appendToolStartIds.every(
      (id) => id.startsWith("run-") && id.endsWith(":append_to_current_file"),
    ),
    JSON.stringify({
      rule: "Tool-call identity must carry the owning run scope so two coordinator starts in one observer segment cannot collide.",
      appendToolStartIds,
    }),
  );
  assert.equal(appendReceipts.length, 2, JSON.stringify(appendReceipts));
  assert.ok(
    appendReceipts.every(
      (receipt) =>
        (typeof receipt.bytesWritten === "number" && receipt.bytesWritten > 0) ||
        receipt.effects?.changed === true,
    ),
    JSON.stringify({
      rule: "Each ordered append needs its own work-producing receipt; an idempotent second call cannot retroactively split the first mutation.",
      appendReceipts,
    }),
  );
});

test("a between-writes continuation splices only the remaining owed append and never duplicates the landed one", async () => {
  // The lane's OTHER interrupt branch: marker A landed with a receipt-backed
  // graph node before the kill, marker B is still owed. The restored graph
  // shows PROVEN completed work, so the bare-stub heal must not be the gate:
  // the owed count is content-checked against the live note — one missing
  // marker, one spliced node — and re-appending the landed marker is
  // redirected by the literal write contract instead of duplicating it.
  const vault = createVaultHarness();
  vault.context.settings.semanticSearchEnabled = true;
  const originalMission =
    "Perform exactly two ordered durable appends to the current note, then finish. " +
    "First append exactly one line containing MARKER_A1 and verify that write. " +
    "Then append exactly one separate line containing MARKER_B2 and verify that write. " +
    "Two appends total, in that order. This task needs no web, memory, or vault research.";

  const configs: AgentRunConfigEvent[] = [];
  await runAgentMission({
    prompt: originalMission,
    modelClient: {
      async chat() {
        throw new Error("Simulated kill after the first append committed.");
      },
      async streamChat() {
        throw new Error("Simulated kill after the first append committed.");
      },
    },
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: { onRunConfig: (event) => configs.push(event) },
  }).catch(() => {});
  const interruptedRunId = configs.at(-1)?.runId;
  assert.ok(interruptedRunId);
  const interruptedStore = await readMissionGraphStoreRecord(
    vault.context,
    canonicalMissionGraphId(interruptedRunId),
  );
  assert.ok(interruptedStore);
  const interruptedGraph = interruptedStore.record.graph;
  const appendNodeEntry = Object.values(interruptedGraph.nodes).find((node) =>
    node.allowedTools.includes("append_to_current_file"),
  );
  const finalNode = interruptedGraph.nodes.final;
  assert.ok(appendNodeEntry && finalNode);
  const graphStorePath = [...vault.files.keys()].find((path) =>
    path.startsWith("Agent Runs/Mission Graphs/"),
  );
  assert.ok(graphStorePath);
  vault.files.delete(graphStorePath);
  // Rebuild the between-writes artifact: the append node completed WITH its
  // receipt (marker A landed), `final` is ready, and the note carries A.
  await persistInitialMissionGraph(vault.context, {
    ...interruptedGraph,
    revision: 0,
    journalHeadFingerprint: null,
    continuationCheckpoint: null,
    nodes: {
      [appendNodeEntry.id]: {
        ...appendNodeEntry,
        status: "complete",
        evidence: [
          {
            id: "evidence-append-a",
            kind:
              appendNodeEntry.completionContract.requiredEvidenceKinds[0] ??
              "tool-result",
            fingerprint: `sha256:${"c".repeat(64)}`,
            observedAt: "2026-08-25T22:41:00.000Z",
          },
        ],
        receipts: [
          {
            id: "receipt-append-a",
            kind:
              appendNodeEntry.completionContract.requiredReceiptKinds[0] ??
              "action-receipt",
            fingerprint: `sha256:${"d".repeat(64)}`,
            committedAt: "2026-08-25T22:41:00.000Z",
          },
        ],
      },
      final: {
        ...finalNode,
        dependencyIds: [],
        status: "ready",
        allowedTools: [],
        evidence: [],
        receipts: [],
      },
    },
  });
  vault.files.set("Current.md", "Initial note\nMARKER_A1");
  vault.files.delete(`Agent Runs/${interruptedRunId}.md`);
  await writeMissionLedger(
    vault.context,
    createPrePlanningAnchorLedger({
      runId: interruptedRunId,
      mission: originalMission,
      targetNotePath: "Current.md",
      now: new Date("2026-08-25T22:41:00.000Z"),
    }),
  );

  const traces: AgentTraceEvent[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  await runAgentMission({
    prompt: `continue run ${interruptedRunId}`,
    modelClient: createModelClient([
      // A confused model first re-carries the landed marker; the literal
      // contract must redirect (not execute) it, then the corrected append
      // pays exactly the missing marker.
      responseWithToolCall("append_to_current_file", { text: "MARKER_A1" }),
      responseWithToolCall("append_to_current_file", { text: "MARKER_B2" }),
      {
        message: {
          role: "assistant",
          content:
            "Both ordered appends are durably recorded with verified receipts.",
          toolCalls: [],
        },
        toolCalls: [],
      },
    ]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onTrace: (event) => traces.push(event),
      onRunComplete: (event) => completions.push(event),
    },
  });

  const splice = traces.find(
    (event) => event.id === "mission-graph-resume-writeback-splice",
  );
  assert.ok(
    splice,
    JSON.stringify({
      rule: "A proven-but-incomplete final-only graph still owes the note-checked missing marker.",
      traceIds: traces.map((event) => event.id).slice(0, 60),
    }),
  );
  assert.equal(
    (splice.outputPreview as { owedWriteCount?: number })?.owedWriteCount,
    1,
    "only the marker missing from the live note is owed",
  );
  assert.deepEqual(
    traces
      .filter((event) => /graph-rejected/u.test(event.id))
      .map((event) => event.message),
    [],
  );
  const note = vault.files.get("Current.md") ?? "";
  assert.equal(
    note.split("MARKER_A1").length - 1,
    1,
    JSON.stringify({
      rule: "The landed marker must never be re-appended.",
      note,
      completion: completions.at(-1),
    }),
  );
  assert.equal(
    note.split("MARKER_B2").length - 1,
    1,
    JSON.stringify({ note, completion: completions.at(-1) }),
  );
});

test("a continuation of a killed run whose graph already completed everything terminates promptly", async () => {
  // Proof-matrix interrupted-continuation, 2026-08-26 02:16Z: the kill can
  // land AFTER the graph finished everything (append paid with a receipt,
  // `final` complete) but before the run's terminal persist. The restored
  // segment had nothing left to do — acceptance PASSED on the restored
  // receipts — yet it burned ELEVEN tool-less model calls and ended
  // classified "error": the REFLEX completion gate (enabled in the live
  // lane harness) kept demanding research evidence the mission's own prompt
  // forswears, pushed a correction on every step, and at the step cap
  // terminal-failed the acceptance-passing run. The reflex heuristic must
  // defer to mission acceptance, and the loop's final-synthesis shortcut
  // must also arm on a fully-terminal restored graph (final complete is not
  // the final-only-remains ready/queued shape).
  const vault = createVaultHarness();
  vault.context.settings.semanticSearchEnabled = true;
  vault.context.settings.agenticReflexEnabled = true;
  const originalMission =
    "Perform exactly two ordered durable appends to the current note, then finish. " +
    "First append exactly one line containing MARKER_A1 and verify that write. " +
    "Then append exactly one separate line containing MARKER_B2 and verify that write. " +
    "Two appends total, in that order. This task needs no web, memory, or vault research.";

  const configs: AgentRunConfigEvent[] = [];
  await runAgentMission({
    prompt: originalMission,
    modelClient: {
      async chat() {
        throw new Error("Simulated kill.");
      },
      async streamChat() {
        throw new Error("Simulated kill.");
      },
    },
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: { onRunConfig: (event) => configs.push(event) },
  }).catch(() => {});
  const interruptedRunId = configs.at(-1)?.runId;
  assert.ok(interruptedRunId);
  const interruptedStore = await readMissionGraphStoreRecord(
    vault.context,
    canonicalMissionGraphId(interruptedRunId),
  );
  assert.ok(interruptedStore);
  const interruptedGraph = interruptedStore.record.graph;
  const appendNodeEntry = Object.values(interruptedGraph.nodes).find((node) =>
    node.allowedTools.includes("append_to_current_file"),
  );
  const finalNode = interruptedGraph.nodes.final;
  assert.ok(appendNodeEntry && finalNode);
  const graphStorePath = [...vault.files.keys()].find((path) =>
    path.startsWith("Agent Runs/Mission Graphs/"),
  );
  assert.ok(graphStorePath);
  vault.files.delete(graphStorePath);
  await persistInitialMissionGraph(vault.context, {
    ...interruptedGraph,
    revision: 0,
    journalHeadFingerprint: null,
    continuationCheckpoint: null,
    nodes: {
      [appendNodeEntry.id]: {
        ...appendNodeEntry,
        status: "complete",
        evidence: [
          {
            id: "evidence-append",
            kind:
              appendNodeEntry.completionContract.requiredEvidenceKinds[0] ??
              "tool-result",
            fingerprint: `sha256:${"c".repeat(64)}`,
            observedAt: "2026-08-26T02:15:00.000Z",
          },
        ],
        receipts: [
          {
            id: "receipt-append",
            kind:
              appendNodeEntry.completionContract.requiredReceiptKinds[0] ??
              "action-receipt",
            fingerprint: `sha256:${"d".repeat(64)}`,
            committedAt: "2026-08-26T02:15:00.000Z",
          },
        ],
      },
      final: {
        ...finalNode,
        dependencyIds: [appendNodeEntry.id],
        status: "complete",
        allowedTools: [],
        evidence: [
          {
            id: "evidence-final",
            kind:
              finalNode.completionContract.requiredEvidenceKinds[0] ??
              "final-output",
            fingerprint: `sha256:${"e".repeat(64)}`,
            observedAt: "2026-08-26T02:15:30.000Z",
          },
        ],
        receipts: [],
        verification: finalNode.completionContract.verifierId
          ? {
              verifierId: finalNode.completionContract.verifierId,
              status: "passed",
              fingerprint: `sha256:${"e".repeat(64)}`,
              verifiedAt: "2026-08-26T02:15:30.000Z",
            }
          : null,
      },
    },
  });
  vault.files.set("Current.md", "Initial note\nMARKER_A1\nMARKER_B2");
  vault.files.delete(`Agent Runs/${interruptedRunId}.md`);
  await writeMissionLedger(
    vault.context,
    createPrePlanningAnchorLedger({
      runId: interruptedRunId,
      mission: originalMission,
      targetNotePath: "Current.md",
      now: new Date("2026-08-26T02:15:40.000Z"),
    }),
  );
  // The lane's interrupted segment got far enough for checkpoints: the
  // runtime snapshot carries the paid, readback-verified append receipt and
  // the done note-content goal — which is exactly what let the live
  // continuation's ACCEPTANCE pass while the reflex gate still failed it.
  await writeMissionRuntimeSnapshot(
    vault.context,
    createMissionRuntimeSnapshot({
      runId: interruptedRunId,
      originalMission,
      currentNotePath: "Current.md",
      status: "paused",
      missionGraphRef: {
        version: 1,
        missionId: canonicalMissionGraphId(interruptedRunId),
        path: `Agent Runs/Mission Graphs/${canonicalMissionGraphId(interruptedRunId)}.md`,
        storeRevision: 1,
        graphRevision: 0,
        recordFingerprint: `sha256:${"a".repeat(64)}`,
        journalHeadFingerprint: null,
      },
      operationGoals: { current_note_content: "done" },
      receipts: [
        {
          id: "receipt-append-paid",
          runId: interruptedRunId,
          toolName: "append_to_current_file",
          operation: "append",
          message: "Appended result to Current.md.",
          path: "Current.md",
          createdAt: "2026-08-26T02:15:10.000Z",
          readback: {
            status: "verified",
            checkedAt: "2026-08-26T02:15:10.000Z",
            observedRevision: "fnv1a32:01234567",
            observedFingerprint: "fnv1a32:89abcdef",
          },
        },
      ],
      lastSafeStep: 3,
      createdAt: new Date("2026-08-26T02:15:00.000Z"),
      updatedAt: new Date("2026-08-26T02:15:30.000Z"),
    }),
  );

  const completions: AgentRunCompleteEvent[] = [];
  let modelCalls = 0;
  const thinThenRealFinal = () => {
    modelCalls += 1;
    return {
      message: {
        role: "assistant" as const,
        content:
          modelCalls < 3
            ? "The mission is already complete."
            : "Both ordered durable appends are recorded: MARKER_A1 and MARKER_B2 landed with verified receipts. The mission is complete.",
        toolCalls: [],
      },
      toolCalls: [],
    };
  };
  await runAgentMission({
    prompt: `continue run ${interruptedRunId}`,
    modelClient: {
      async chat() {
        return thinThenRealFinal() as never;
      },
      async streamChat() {
        throw new Error("buffered-only fixture");
      },
    },
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onRunComplete: (event) => completions.push(event),
    },
  });

  const completion = completions.at(-1);
  assert.ok(completion);
  // The reflex gate must defer to passing acceptance before invoking the
  // provider at all. The graph, receipts, goals, and acceptance already prove
  // the terminal state; another model turn can only introduce regressions.
  assert.equal(
    modelCalls,
    0,
    JSON.stringify({
      rule: "A restored acceptance-passing mission must terminate from durable proof without another provider call.",
      modelCalls,
      completion,
    }),
  );
  assert.notEqual(
    completion.stopReason,
    "error",
    JSON.stringify({
      rule: "The reflex heuristic may not terminal-fail an acceptance-passing run; acceptance owns the hard stop.",
      completion,
    }),
  );
  // Exactly-once holds: the continuation adds nothing to the note.
  assert.equal(
    vault.files.get("Current.md"),
    "Initial note\nMARKER_A1\nMARKER_B2",
    "the completed mission's note must not gain another append",
  );
});

test("a live mission publishes its run identity before the pre-config router call", async () => {
  // Regression: proof-matrix lane interrupted-continuation-live, phase 1.
  // RunCoordinator.start() reports `running` synchronously, but the run id
  // only reached the snapshot with the first `onRunConfig` — which sits behind
  // the structured router (capped at 120s), the reflex pass, and the planner.
  // On a slow model the host therefore showed a live mission that nothing
  // could address by id for minutes, and `continue run <id>` had no id to use.
  const vault = createVaultHarness();
  vault.context.settings.modelRouterEnabled = true;
  vault.context.settings.modelRouterMode = "authority";
  const coordinator = new RunCoordinator();
  const runIdsAtModelCall: Array<string | null> = [];
  let configRunId: string | null = null;
  coordinator.subscribe({
    onRunConfig: (event: AgentRunConfigEvent) => {
      configRunId = event.runId;
    },
  });

  await coordinator.start((abortSignal, events) =>
    runAgentMission({
      prompt: "Append exactly this text to the current note: run identity proof",
      modelClient: createModelClient(
        [
          responseWithToolCall("append_to_current_file", {
            text: "run identity proof",
          }),
        ],
        [],
        () => {
          runIdsAtModelCall.push(coordinator.getSnapshot().runId);
        },
      ),
      toolRegistry: createDefaultToolRegistry(),
      toolContext: vault.context,
      enableStreaming: false,
      abortSignal,
      events,
    }),
  );

  assert.ok(
    runIdsAtModelCall.length > 0,
    "The mission must reach the model for this pin to mean anything.",
  );
  assert.match(
    String(runIdsAtModelCall[0]),
    /^run-/u,
    JSON.stringify({
      rule: "The coordinator must already carry the run identity at the very first model call — every pre-config stage is model work the identity must not wait behind.",
      runIdsAtModelCall,
      configRunId,
    }),
  );
  assert.equal(
    runIdsAtModelCall[0],
    configRunId,
    "The early identity must be the same run id the config event later publishes, not a second identity.",
  );
});

test("an early run identity never replaces an identity the coordinator already holds", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_abortSignal, events) => {
    (events as { onRunIdentity?: (event: { runId: string }) => void })
      .onRunIdentity?.({ runId: "run-first" });
    assert.equal(coordinator.getSnapshot().runId, "run-first");
    // A child seat, a retry, or a nested runner announcing its own identity
    // must never re-point a mission the host is already showing by id.
    (events as { onRunIdentity?: (event: { runId: string }) => void })
      .onRunIdentity?.({ runId: "run-second" });
    assert.equal(coordinator.getSnapshot().runId, "run-first");
    events.onRunComplete?.({ step: 0, maxSteps: 1, stopReason: "final" });
  });
  assert.equal(coordinator.getSnapshot().runId, "run-first");
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

test("coordinator-backed runner retains the accepted adaptive Specialist handoff", async () => {
  const vault = createVaultHarness();
  const coordinator = new RunCoordinator();
  const parentRunId = "mission-adaptive-parent";
  const runtime = new OrchestratorRuntime({
    runId: parentRunId,
    mode: "adaptive_team",
  });
  const scaffold = createAdaptiveTeamScaffoldV2({
    runId: parentRunId,
    mission: "Gather bounded evidence, then let the Lead append verified proof.",
    specialistModes: ["researcher"],
    specialistMaxSteps: 4,
    specialistMaxToolCalls: 4,
    specialistMaxMinutes: 1,
    leadMaxSteps: 8,
    leadMaxToolCalls: 8,
    leadMaxMinutes: 2,
  });
  await runtime.start(scaffold);
  const handoff = createSpecialistHandoffV2({
    handoff: {
      id: "handoff-adaptive-parent",
      fromParticipantId: "specialist",
      toParticipantId: "lead",
      taskId: scaffold.nodeIds.specialist,
      status: "ready",
      summary: "Host-observed evidence is ready for Lead verification.",
      sourceIds: ["source-adaptive-parent"],
      evidenceIds: ["evidence-adaptive-parent"],
      unresolvedQuestions: [],
      confidence: "high",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    },
    missionGraphId: parentRunId,
    specialistMode: "researcher",
    missionInput: {
      prompt: "Gather bounded evidence, then let the Lead append verified proof.",
    },
    acceptanceCriteria: ["The referenced evidence resolves in host-observed state."],
    recommendedNextAction: "Lead verifies the handoff and appends the result.",
  });
  await runtime.specialistHandoffReady(handoff, {
    missionGraphId: parentRunId,
    evidenceIds: new Set(["evidence-adaptive-parent"]),
    receiptIds: new Set(),
    artifactIds: new Set(),
    validationIds: new Set(),
  });
  await runtime.updateHandoff(handoff.id, "accepted", handoff.summary);

  await coordinator.start((abortSignal, events) =>
    runAgentMission({
      prompt: "Append exactly this text to the current note: adaptive coordinator proof",
      modelClient: createModelClient([
        responseWithToolCall("append_to_current_file", {
          text: "adaptive coordinator proof",
        }),
      ]),
      toolRegistry: createDefaultToolRegistry(),
      toolContext: vault.context,
      enableStreaming: false,
      abortSignal,
      events,
      orchestratorSnapshot: runtime.getSnapshot() ?? undefined,
      getOrchestratorSnapshot: () => runtime.getSnapshot(),
    }),
  );

  const snapshot = coordinator.getSnapshot();
  assert.ok(
    snapshot.lastMissionGraph,
    "the Lead's local MissionGraph should coexist with the parent runtime projection",
  );
  const retained = snapshot.lastMissionLedger?.orchestrator;
  assert.ok(retained, "the coordinator should retain the parent runtime projection");
  assert.equal(retained.mode, "adaptive_team");
  assert.deepEqual(Object.keys(retained.participants).sort(), [
    "lead",
    "specialist",
  ]);
  assert.equal(retained.participants.lead?.role, "lead");
  assert.equal(retained.participants.specialist?.role, "specialist");
  assert.equal(retained.handoffs.length, 1);
  const retainedHandoff = retained.handoffs[0];
  assert.ok(retainedHandoff && isSpecialistHandoffV2(retainedHandoff));
  assert.equal(retainedHandoff.status, "accepted");
  assert.equal(retainedHandoff.inputFingerprint, handoff.inputFingerprint);
  assert.equal(retainedHandoff.progressFingerprint, handoff.progressFingerprint);
  assert.match(retainedHandoff.inputFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.match(retainedHandoff.progressFingerprint, /^sha256:[a-f0-9]{64}$/u);

  const ledgerRunId = snapshot.lastMissionLedger?.runId;
  assert.ok(ledgerRunId);
  const runMarkdown = vault.files.get(getMissionLedgerPath(ledgerRunId)) ?? "";
  assert.ok(runMarkdown, "the Agent Runs markdown should be persisted");
  const persistedLedger = parseMissionLedgerFromMarkdown(runMarkdown);
  const persistedRuntime = parseMissionRuntimeSnapshotFromMarkdown(runMarkdown);
  assert.deepEqual(persistedLedger?.orchestrator, retained);
  assert.deepEqual(persistedRuntime?.orchestrator, retained);
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
  const fingerprint = (character: string) =>
    `sha256:${character.repeat(64)}`;
  const acceptedArtifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-root-lineage",
    originRunId: rootRunId,
    vaultBindingKey: "current-vault",
    notePath: "Research/Durable execution.md",
    noteSha256: fingerprint("1"),
    noteReceiptId: "receipt-root-lineage",
    evidence: [{
      id: "source-root-lineage",
      kind: "web",
      reference: "https://example.com/prior",
      contentSha256: fingerprint("2"),
    }],
    acceptanceCriteria: [{
      id: "AC-1",
      text: "The resumed segment retains the original project lineage.",
    }],
    riskClass: "medium",
    acceptedAt: "2026-07-10T12:04:00.000Z",
    acceptedBy: "host",
  });
  const researcherHandoff = createResearcherHandoffV1({
    artifact: acceptedArtifact,
    runId: rootRunId,
    taskId: "research-root-lineage",
    evidenceIds: ["source-root-lineage"],
    summary: "Accepted root-bound research survives segmented continuation.",
    unresolvedQuestions: [],
    acceptedAt: "2026-07-10T12:04:00.000Z",
  });
  const projectLineage = createProjectLineageV1({
    lineageId: "project-root-lineage",
    runId: rootRunId,
    vaultBindingKey: "current-vault",
    handoff: researcherHandoff,
    updatedAt: "2026-07-10T12:04:00.000Z",
  });
  vault.context.getProjectLineages = () => [projectLineage];
  ledger.continuationHandoff = buildContinuationHandoffV1({
    ledger,
    lineageFingerprints: [projectLineage.fingerprint],
    now: new Date("2026-07-10T12:05:00.000Z"),
  });
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

test("a restored researcher handoff with a zero-minimum research plan never fakes web retrieval", async () => {
  // Regression: the PRO-14 research-team handoff deadlock. A continuation Lead
  // segment restored a research plan whose sourceRequirements.minFetchedSources
  // was 0, so with an orchestrator handoff context present the handoff check
  // "fetched sources >= requirement" was vacuously true at zero. The runner
  // marked web_search/web_fetch as executed and done, pinned the planned
  // frontier, and the proof-gated append blocked forever on research_plan_items
  // and subquestion_evidence it was no longer allowed to gather. The handoff
  // requirement is now floored at one real fetched source.
  const vault = createVaultHarness();
  const seedRunId = "run-handoff-zero-floor";
  const originalMission =
    "Search the web for the PRO-14 research team deadlock report and append the verified finding to the current note.";
  await writeResumableResearchSeed({
    context: vault.context,
    runId: seedRunId,
    mission: originalMission,
    researchPlan: pendingWebResearchPlan(0),
    evidence: [
      {
        id: "vault:prior-notes",
        kind: "vault_note",
        title: "Prior local notes",
        path: "Research/Prior notes.md",
        summary: "Lead-produced local context; not a fetched web source.",
        confidence: "medium",
      },
    ],
  });

  const configs: AgentRunConfigEvent[] = [];
  let hydratedAtModelStart: MissionRuntimeSnapshotV2 | null = null;
  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: createModelClient(
      [
        responseWithContent(
          "The deadlock report finding is ready to append once sources exist.",
        ),
      ],
      [],
      () => {
        hydratedAtModelStart ??= parseResumedRuntimeSnapshot(
          vault.files,
          seedRunId,
        );
      },
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 4,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
    orchestratorContext: acceptedResearcherHandoffContext(),
  });

  const hydrated = hydratedAtModelStart as MissionRuntimeSnapshotV2 | null;
  assert.ok(
    hydrated,
    "the resumed segment should persist a runtime snapshot before its first model call",
  );
  assert.equal(
    hydrated.operationGoals.web_search,
    "pending",
    "zero fetched web sources must not mark web_search done under a zero-minimum plan",
  );
  assert.equal(
    hydrated.operationGoals.web_fetch,
    "pending",
    "zero fetched web sources must not mark web_fetch done under a zero-minimum plan",
  );
  assert.ok(
    hydrated.evidence.every((item) => !item.url),
    "no fetched web source exists that could satisfy the handoff floor",
  );
  assert.deepEqual(hydrated.researchPlan?.subquestions[0]?.evidenceIds, []);

  // The mock provider never requests a web tool and the fallback transport
  // fails, so no later step may legitimately settle retrieval either.
  const resumedRunId = configs.at(-1)?.runId;
  assert.ok(resumedRunId);
  const finalSnapshot = parseMissionRuntimeSnapshotFromMarkdown(
    vault.files.get(`Agent Runs/${resumedRunId}.md`) ?? "",
  );
  assert.ok(finalSnapshot);
  assert.notEqual(finalSnapshot.operationGoals.web_search, "done");
  assert.notEqual(finalSnapshot.operationGoals.web_fetch, "done");
});

test("a restored researcher handoff with one real fetched source satisfies the floored requirement", async () => {
  // Reachability control for the zero-floor test above: the same zero-minimum
  // plan accepts the handoff once one genuine fetched source exists, both at
  // the pre-restore seed check and at the post-restore compatibility binding.
  const vault = createVaultHarness();
  const seedRunId = "run-handoff-one-source";
  const originalMission =
    "Search the web for the PRO-14 research team deadlock report and append the verified finding to the current note.";
  await writeResumableResearchSeed({
    context: vault.context,
    runId: seedRunId,
    mission: originalMission,
    researchPlan: pendingWebResearchPlan(0),
  });

  const specialist = specialistWebEvidence();
  let hydratedAtModelStart: MissionRuntimeSnapshotV2 | null = null;
  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: createModelClient(
      [
        responseWithContent(
          "The verified handoff finding is supported by https://example.com/pro-14-deadlock.",
        ),
      ],
      [],
      () => {
        hydratedAtModelStart ??= parseResumedRuntimeSnapshot(
          vault.files,
          seedRunId,
        );
      },
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 4,
    seedMissionEvidence: [specialist],
    orchestratorContext: acceptedResearcherHandoffContext(),
  });

  const hydrated = hydratedAtModelStart as MissionRuntimeSnapshotV2 | null;
  assert.ok(hydrated);
  assert.equal(
    hydrated.operationGoals.web_search,
    "done",
    "one provider-observed fetched source must satisfy the floored handoff requirement",
  );
  assert.equal(hydrated.operationGoals.web_fetch, "done");
  assert.ok(
    hydrated.evidence.some((item) => item.url === specialist.url),
    "the handoff evidence backing the accepted retrieval must be present",
  );
});

test("a continuation lead segment keeps re-seeded specialist evidence the snapshot never persisted", async () => {
  // The host lead-segment loop passes seedMissionEvidence/seedClaimPassages on
  // every segment, not only segment 0: the resume snapshot persists only what
  // the Lead itself produced, so a continuation would otherwise lose the
  // Specialist's provider-observed evidence and deadlock the proof-gated
  // writeback. This pins the runner contract that per-segment re-seeding
  // relies on: seeds survive the resume merge and credit the web subquestion.
  const vault = createVaultHarness();
  const seedRunId = "run-lead-segment-reseed";
  const originalMission =
    "Research the PRO-14 deadlock retrospective on the web and append the verified finding to the current note.";
  await writeResumableResearchSeed({
    context: vault.context,
    runId: seedRunId,
    mission: originalMission,
    researchPlan: pendingWebResearchPlan(1),
  });

  const specialist = specialistWebEvidence();
  let hydratedAtModelStart: MissionRuntimeSnapshotV2 | null = null;
  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: createModelClient(
      [
        responseWithContent(
          "The retrospective finding is supported by https://example.com/pro-14-deadlock.",
        ),
      ],
      [],
      () => {
        hydratedAtModelStart ??= parseResumedRuntimeSnapshot(
          vault.files,
          seedRunId,
        );
      },
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 4,
    seedMissionEvidence: [specialist],
    seedClaimPassages: [
      {
        id: specialist.passageId!,
        text: "The retrospective documents the researcher handoff deadlock.",
        evidenceId: specialist.id,
        subquestionId: "rq-web",
      },
    ],
    orchestratorContext: acceptedResearcherHandoffContext(),
  });

  const hydrated = hydratedAtModelStart as MissionRuntimeSnapshotV2 | null;
  assert.ok(hydrated);
  const retained = hydrated.evidence.find((item) => item.id === specialist.id);
  assert.ok(
    retained,
    "the Specialist's web evidence must survive the continuation resume merge",
  );
  assert.equal(retained.url, specialist.url);
  assert.deepEqual(retained.passageIds, specialist.passageIds);
  const webSubquestion = hydrated.researchPlan?.subquestions.find(
    (item) => item.id === "rq-web",
  );
  assert.ok(webSubquestion);
  assert.deepEqual(
    webSubquestion.evidenceIds,
    [specialist.id],
    "applyResearchEvidence must credit the web subquestion from the seeded evidence",
  );
  assert.equal(webSubquestion.status, "complete");
  assert.ok(
    hydrated.claimPassages?.some(
      (passage) => passage.id === specialist.passageId,
    ),
    "the Specialist's claim passages must survive the continuation resume merge",
  );
  assert.equal(hydrated.operationGoals.web_search, "done");
  assert.equal(hydrated.operationGoals.web_fetch, "done");
});

test("a continuation lead segment without re-seeding loses the specialist evidence", async () => {
  // Documents the failure mode the per-segment re-seeding exists for: the
  // resume snapshot alone cannot restore worker-produced proof. If this test
  // starts failing because the runner resurrects Specialist evidence by
  // itself, the host loop's per-segment re-seeding may have become redundant.
  const vault = createVaultHarness();
  const seedRunId = "run-lead-segment-unseeded";
  const originalMission =
    "Research the PRO-14 deadlock retrospective on the web and append the verified finding to the current note.";
  await writeResumableResearchSeed({
    context: vault.context,
    runId: seedRunId,
    mission: originalMission,
    researchPlan: pendingWebResearchPlan(1),
  });

  const specialist = specialistWebEvidence();
  let hydratedAtModelStart: MissionRuntimeSnapshotV2 | null = null;
  await runAgentMission({
    prompt: `continue run ${seedRunId}`,
    modelClient: createModelClient(
      [
        responseWithContent(
          "Continuing the retrospective mission without restored worker proof.",
        ),
      ],
      [],
      () => {
        hydratedAtModelStart ??= parseResumedRuntimeSnapshot(
          vault.files,
          seedRunId,
        );
      },
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    maxSteps: 4,
    orchestratorContext: acceptedResearcherHandoffContext(),
  });

  const hydrated = hydratedAtModelStart as MissionRuntimeSnapshotV2 | null;
  assert.ok(hydrated);
  assert.ok(
    hydrated.evidence.every((item) => item.id !== specialist.id && !item.url),
    "the snapshot alone must not resurrect the Specialist's web evidence",
  );
  assert.deepEqual(hydrated.researchPlan?.subquestions[0]?.evidenceIds, []);
  assert.equal(hydrated.operationGoals.web_search, "pending");
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
          runId: seedRunId,
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
  assert.ok(
    toolStarts.includes("append_to_current_file"),
    JSON.stringify(requests.map((request) => ({
      phase: request.evidencePhase,
      tools: request.tools?.map((tool) => tool.function.name) ?? [],
    }))),
  );
  assert.deepEqual(
    receipts.map((receipt) => receipt.id),
    ["receipt-prior", receipts.at(-1)?.id],
  );
  assert.equal(receipts[0].runId, seedRunId);
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
  const vault = createVaultHarness({
    beforeModify: (path) => {
      if (path === "Current.md") {
        throw new Error("Injected current-note write failure.");
      }
    },
  });
  vault.context.settings.maxAgentSteps = 1;
  const completions: AgentRunCompleteEvent[] = [];

  await runAgentMission({
    prompt: "Append required failure proof to the current note.",
    modelClient: createModelClient([
      responseWithToolCall("append_to_current_file", {
        text: "required failure proof",
      }),
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

test("durable run anchor exists before the first model call and evolves into the run's single ledger", async () => {
  const vault = createVaultHarness();
  const prompt = "Append anchored mutation proof to the current note.";
  let identityRunId: string | null = null;
  let anchorMarkdownAtPersist: string | undefined;
  let sequence = 0;
  let anchorPersistedAtSequence = -1;
  let firstModelCallAtSequence = -1;
  let durableStateAtFirstModelCall: string | undefined;
  const completions: AgentRunCompleteEvent[] = [];

  await runAgentMission({
    prompt,
    modelClient: createModelClient(
      [
        responseWithToolCall("append_to_current_file", {
          text: "Anchored mutation proof",
        }),
      ],
      [],
      () => {
        if (firstModelCallAtSequence !== -1) {
          return;
        }
        sequence += 1;
        firstModelCallAtSequence = sequence;
        // A hard kill at ANY point up to and including the first model call
        // must leave durable state: snapshot the vault the moment the model
        // is first consulted.
        durableStateAtFirstModelCall = identityRunId
          ? vault.files.get(`Agent Runs/${identityRunId}.md`)
          : undefined;
      },
    ),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onRunIdentity: (event) => {
        identityRunId = event.runId;
      },
      onTrace: (event) => {
        if (event.id === "durable-run-anchor" && identityRunId) {
          sequence += 1;
          anchorPersistedAtSequence = sequence;
          anchorMarkdownAtPersist = vault.files.get(
            `Agent Runs/${identityRunId}.md`,
          );
        }
      },
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.ok(identityRunId, "run identity must be published at run start");
  assert.ok(
    firstModelCallAtSequence !== -1,
    "the mission must reach the model",
  );
  assert.ok(
    anchorPersistedAtSequence !== -1 &&
      anchorPersistedAtSequence < firstModelCallAtSequence,
    "the durable run anchor must be persisted before the first model call",
  );
  assert.ok(
    durableStateAtFirstModelCall,
    "durable run state must exist on disk at the first model call",
  );
  const anchor = parseMissionLedgerFromMarkdown(anchorMarkdownAtPersist ?? "");
  assert.ok(anchor, "the anchor must round-trip through the ledger parser");
  assert.equal(anchor.runId, identityRunId);
  assert.equal(isPrePlanningAnchorLedger(anchor), true);
  assert.equal(anchor.mission, prompt);
  assert.equal(anchor.status, "running");
  // The SAME record the resume gate consumes says the run is resumable.
  assert.equal(summarizeMissionLedger(anchor).canResume, true);
  const anchorPlan = buildMissionResumePlan(anchor);
  assert.equal(anchorPlan.canResume, true);
  assert.equal(anchorPlan.reason, "pre_planning_anchor_restart");
  assert.match(
    formatLedgerForModel(anchor),
    /interrupted before planning began/i,
  );

  // mission-ledger-start evolved the anchor IN PLACE: one artifact, one
  // ledger block, a real run route, and a strictly higher revision.
  assert.equal(completions.length, 1);
  const finalMarkdown = vault.files.get(`Agent Runs/${identityRunId}.md`);
  assert.ok(finalMarkdown);
  const finalLedger = parseMissionLedgerFromMarkdown(finalMarkdown);
  assert.ok(finalLedger);
  assert.equal(finalLedger.runId, identityRunId);
  assert.equal(
    isPrePlanningAnchorLedger(finalLedger),
    false,
    "the full mission ledger must supersede the pre-planning anchor route",
  );
  assert.ok(finalLedger.revision > anchor.revision);
  const runArtifacts = [...vault.files.keys()].filter(
    (path) => path.startsWith("Agent Runs/") && path.includes(identityRunId!),
  );
  assert.equal(
    runArtifacts.length,
    1,
    `expected one Agent Runs artifact, got: ${runArtifacts.join(", ")}`,
  );
  assert.equal(finalMarkdown.match(/## Mission Ledger/g)?.length, 1);
});

test("continue run of an anchor-only interrupted run restarts the mission from its recorded prompt", async () => {
  const vault = createVaultHarness();
  const interruptedRunId = "run-anchor-preplanning-kill";
  const recordedMission =
    "Append the anchored haiku about rivers to the current note.";
  // A mission killed before planning leaves ONLY the durable run anchor: no
  // checkpoint, no runtime snapshot, no mission graph store.
  await writeMissionLedger(
    vault.context,
    createPrePlanningAnchorLedger({
      runId: interruptedRunId,
      mission: recordedMission,
      targetNotePath: "Current.md",
      now: new Date("2026-07-10T12:10:00.000Z"),
    }),
  );

  let modelCalls = 0;
  const assistant: string[] = [];
  const traces: AgentTraceEvent[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const configs: AgentRunConfigEvent[] = [];

  await runAgentMission({
    prompt: `continue run ${interruptedRunId}`,
    modelClient: createModelClient(
      [
        responseWithToolCall("append_to_current_file", {
          text: "Anchored haiku restart",
        }),
      ],
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
      onTrace: (event) => traces.push(event),
      onRunComplete: (event) => completions.push(event),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.doesNotMatch(
    assistant.join(""),
    /exact durable checkpoint is unavailable/i,
  );
  assert.ok(modelCalls >= 1, "the anchor-only continuation must run");
  assert.ok(
    traces.some((event) => event.id === "mission-ledger-resume"),
    "the primary mission-ledger resume path must own the continuation",
  );
  assert.ok(
    traces.some(
      (event) => event.id === "mission-ledger-resume:pre-planning-anchor",
    ),
    "the shared anchor predicate must drive restart-from-prompt semantics",
  );
  // The restarted segment did the recorded mission's real work.
  assert.equal(
    vault.files.get("Current.md"),
    "Initial note\nAnchored haiku restart",
  );
  assert.equal(completions.length, 1);
  assert.notEqual(completions[0].stopReason, "error");
  assert.equal(
    configs.at(-1)?.rootRunId,
    interruptedRunId,
    "the segment config must attest the exact durable root it resumed",
  );
});

test("a graceful pre-planning abort keeps the anchor and continue completes the mission", async () => {
  const vault = createVaultHarness();
  const prompt = "Append the abort survivor line to the current note.";
  const controller = new AbortController();
  let identityRunId: string | null = null;
  const completions: AgentRunCompleteEvent[] = [];

  await runAgentMission({
    prompt,
    modelClient: createModelClient([
      responseWithToolCall("append_to_current_file", {
        text: "Abort survivor",
      }),
    ]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    abortSignal: controller.signal,
    events: {
      onRunIdentity: (event) => {
        identityRunId = event.runId;
      },
      onTrace: (event) => {
        if (event.id === "durable-run-anchor") {
          // A plugin-disable "kill" reaches the runner as a graceful abort
          // (RunCoordinator.shutdown -> requestStop). Fire it the moment the
          // anchor is durable, before planning produced anything.
          controller.abort("coordinator_shutdown");
        }
      },
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.ok(identityRunId, "run identity must be published at run start");
  assert.equal(
    completions.length,
    1,
    "the aborted run must complete gracefully through onRunComplete",
  );
  assert.equal(vault.files.get("Current.md"), "Initial note");
  const survivingMarkdown = vault.files.get(`Agent Runs/${identityRunId}.md`);
  assert.ok(
    survivingMarkdown,
    "the durable anchor must SURVIVE a graceful pre-planning abort — " +
      "deleting it would re-open the exact interrupted-continuation hole",
  );
  const survivingAnchor = parseMissionLedgerFromMarkdown(survivingMarkdown);
  assert.ok(survivingAnchor);
  assert.equal(isPrePlanningAnchorLedger(survivingAnchor), true);
  assert.equal(survivingAnchor.mission, prompt);

  // The real interrupted-continuation shape end-to-end: the same vault,
  // `continue run <id>`, and the recorded mission finishes its work.
  const traces: AgentTraceEvent[] = [];
  await runAgentMission({
    prompt: `continue run ${identityRunId}`,
    modelClient: createModelClient([
      responseWithToolCall("append_to_current_file", {
        text: "Abort survivor",
      }),
    ]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onTrace: (event) => traces.push(event),
    },
  });
  assert.ok(
    traces.some(
      (event) => event.id === "mission-ledger-resume:pre-planning-anchor",
    ),
  );
  assert.equal(
    vault.files.get("Current.md"),
    "Initial note\nAbort survivor",
  );
});

test("anchor artifact removal deletes only a pre-planning anchor, never an evolved ledger", async () => {
  const vault = createVaultHarness();
  const anchorRunId = "run-anchor-cleanup";
  await writeMissionLedger(
    vault.context,
    createPrePlanningAnchorLedger({
      runId: anchorRunId,
      mission: "Anchored mission that terminated gracefully pre-planning.",
      now: new Date("2026-07-10T12:11:00.000Z"),
    }),
  );
  assert.ok(vault.files.has(`Agent Runs/${anchorRunId}.md`));
  assert.equal(
    await removePrePlanningAnchorArtifact(vault.context, anchorRunId),
    true,
  );
  assert.equal(vault.files.has(`Agent Runs/${anchorRunId}.md`), false);

  const evolvedRunId = "run-anchor-evolved";
  const evolved = createMissionLedger({
    runId: evolvedRunId,
    mission: "Mission whose ledger already superseded its anchor.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 8,
      toolStepBudget: 6,
      finalizationReserve: 2,
      expectedTools: ["web_search"],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-07-10T12:12:00.000Z"),
  });
  await writeMissionLedger(vault.context, evolved);
  assert.equal(
    await removePrePlanningAnchorArtifact(vault.context, evolvedRunId),
    false,
    "an evolved ledger must never be removable as an anchor",
  );
  assert.ok(vault.files.has(`Agent Runs/${evolvedRunId}.md`));
});

/**
 * The writer ("what makes a run resumable from its first moment") and the
 * resume gate ("what do I accept, and how do I continue it") must consume ONE
 * predicate. A second private copy of the anchor marker is a second authority
 * that will drift — the exact two-subsystems failure the anchor exists to
 * close. Source-level on purpose: drift is only observable once the copies
 * disagree, which is exactly too late.
 */
test("the pre-planning anchor marker has a single authority consumed by writer and resume gate", () => {
  const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!/\.tsx?$/u.test(entry.name)) {
        continue;
      }
      if (readFileSync(absolute, "utf8").includes("accepted_pre_planning")) {
        offenders.push(
          absolute.slice(srcRoot.length).replace(/\\/g, "/"),
        );
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(
    offenders,
    ["agent/missionLedger.ts"],
    "the anchor route literal must exist only in missionLedger.ts; " +
      "every other module must consume isPrePlanningAnchorLedger",
  );
  const runnerSource = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  const resumeSource = readFileSync(
    new URL("../src/agent/missionResume.ts", import.meta.url),
    "utf8",
  );
  assert.match(runnerSource, /isPrePlanningAnchorLedger/);
  assert.match(resumeSource, /isPrePlanningAnchorLedger/);
});

test("crash orphan with only durable graph and worker records resumes with crash_recovered provenance", async () => {
  const vault = createVaultHarness();
  const rootRunId = "run-crash-orphan-root";
  const leadRunId = "run-crash-orphan-root-lead";
  // A hard renderer crash before the root run's Agent Runs note exists: only
  // the orchestrator-linked worker note and the canonical mission graph store
  // are durable. No checkpoint, ledger, or handoff exists for the root id.
  const graph = await seedCrashOrphanMissionGraph(vault.context, leadRunId);
  const leadLedger = createMissionLedger({
    runId: leadRunId,
    mission: "Research the crashed overnight topic.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 12,
      toolStepBudget: 8,
      finalizationReserve: 4,
      expectedTools: ["web_search"],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
  leadLedger.status = "running";
  leadLedger.orchestrator = {
    runId: rootRunId,
  } as unknown as OrchestratorSnapshotV1;
  await writeMissionLedger(vault.context, leadLedger);
  await writeMissionRuntimeSnapshot(
    vault.context,
    createMissionRuntimeSnapshot({
      runId: leadRunId,
      originalMission: leadLedger.mission,
      currentNotePath: "Current.md",
      missionGraphRef: {
        version: 1,
        missionId: graph.record.missionId,
        path: graph.path,
        storeRevision: graph.record.storeRevision,
        graphRevision: graph.record.graph.revision,
        recordFingerprint: graph.record.recordFingerprint,
        journalHeadFingerprint: graph.record.graph.journalHeadFingerprint,
      },
      createdAt: new Date("2026-07-10T12:00:01.000Z"),
      updatedAt: new Date("2026-07-10T12:00:02.000Z"),
    }),
  );

  let modelCalls = 0;
  const assistant: string[] = [];
  const traces: AgentTraceEvent[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const missionGraphIds: string[] = [];

  await runAgentMission({
    prompt: `continue run ${rootRunId}`,
    modelClient: createModelClient(
      [responseWithContent("The crash-recovered segment is complete.")],
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
      onTrace: (event) => traces.push(event),
      onRunComplete: (event) => completions.push(event),
      onMissionGraphUpdate: (missionGraph) => {
        missionGraphIds.push(missionGraph.missionId);
      },
    },
  });

  const refusalTraces = traces.filter((event) =>
    event.id.startsWith("checkpoint-resume:"),
  );
  assert.doesNotMatch(
    assistant.join(""),
    /exact durable checkpoint is unavailable/i,
    JSON.stringify(refusalTraces, null, 2),
  );
  assert.ok(modelCalls >= 1, "the crash-recovered continuation must run");
  const crashTrace = traces.find(
    (event) => event.id === "checkpoint-resume:crash-recovered",
  );
  assert.ok(crashTrace, "expected a crash-recovered continuation trace");
  const preview = crashTrace.outputPreview as {
    provenance: string;
    resume: { runId: string; viaOrchestratorLink: boolean };
    graph: { missionId: string };
  };
  assert.equal(preview.provenance, "crash_recovered");
  assert.equal(preview.resume.runId, leadRunId);
  assert.equal(preview.resume.viaOrchestratorLink, true);
  assert.equal(preview.graph.missionId, leadRunId);
  // The persisted graph resumed verbatim under its original mission identity
  // instead of a freshly planned graph for the new segment run id.
  assert.equal(missionGraphIds[0], leadRunId);
  assert.equal(completions.length, 1);
});

test("crash recovery stays fail-closed when the only durable graph store is tampered", async () => {
  const vault = createVaultHarness();
  const runId = "run-crash-orphan-tampered";
  const graph = await seedCrashOrphanMissionGraph(vault.context, runId);
  vault.files.set(
    graph.path,
    (vault.files.get(graph.path) ?? "").replace(
      '"objective": "Read the trusted source."',
      '"objective": "Tampered objective."',
    ),
  );

  let modelCalls = 0;
  const assistant: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];

  await runAgentMission({
    prompt: `continue run ${runId}`,
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
      delete: async (file: { path: string }) => {
        if (!files.has(file.path)) {
          throw new Error(`Path not found: ${file.path}`);
        }
        files.delete(file.path);
        mtimes.delete(file.path);
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

/** Only the canonical mission graph store survives a crash-orphaned mission. */
async function seedCrashOrphanMissionGraph(
  context: ToolExecutionContext,
  missionId: string,
): Promise<MissionGraphStoreWriteResult> {
  const createdAt = "2026-07-10T12:00:00.000Z";
  const capabilityEnvelope = await buildMissionCapabilityEnvelopeV1({
    missionId,
    issuedAt: createdAt,
    expiresAt: null,
    capabilities: ["web.read"],
    executionHosts: ["obsidian_core"],
    executors: {
      core: {
        id: "core",
        executionHosts: ["obsidian_core"],
        allowedEffects: ["read"],
      },
    },
    verifiers: ["artifact-verifier"],
    tools: {
      web_search: {
        name: "web_search",
        effect: "read",
        capabilityIds: ["web.read"],
        executionHosts: ["obsidian_core"],
        bindingKinds: [],
      },
    },
    bindings: {},
    budgets: {
      maxNodes: 16,
      maxDepth: 4,
      maxConcurrentReadNodes: 3,
      maxTotalToolCalls: 24,
      maxExternalActions: 0,
      maxWallClockMs: 120_000,
      maxAttemptsPerNode: 3,
    },
  });
  const graph: MissionGraphV3 = {
    schemaVersion: 3,
    missionId,
    objective: "Read the trusted source.",
    revision: 0,
    journalHeadFingerprint: null,
    createdAt,
    updatedAt: createdAt,
    routing: {
      source: "deterministic",
      fallbackFrom: null,
      fallbackReason: null,
      confidence: 1,
      decidedAt: createdAt,
      decisionFingerprint: `sha256:${"1".repeat(64)}`,
    },
    continuationCheckpoint: null,
    capabilityEnvelope,
    nodes: {
      read: {
        id: "read",
        dependencyIds: [],
        objective: "Read one trusted source.",
        executorId: "core",
        executionHost: "obsidian_core",
        effect: "read",
        inputs: {},
        outputs: {},
        requiredCapabilities: ["web.read"],
        allowedTools: ["web_search"],
        destination: null,
        resourceLocks: [],
        budget: { toolCalls: 1, externalActions: 0, wallClockMs: 5_000 },
        retries: {
          maxAttempts: 3,
          attempts: 0,
          failureFingerprints: [],
          consecutiveFailureFingerprint: null,
          consecutiveFailureCount: 0,
        },
        status: "ready",
        evidence: [],
        receipts: [],
        verification: null,
        completionContract: {
          criteria: ["One source is recorded."],
          minimumEvidence: 1,
          requiredEvidenceKinds: ["web-source"],
          minimumReceipts: 0,
          requiredReceiptKinds: [],
          verifierId: "artifact-verifier",
        },
        blocker: null,
      },
    },
  };
  return persistInitialMissionGraph(context, graph);
}

/** A paused web-research run whose next segment must resume via `continue run`. */
async function writeResumableResearchSeed(input: {
  context: ToolExecutionContext;
  runId: string;
  mission: string;
  researchPlan: ResearchPlan;
  evidence?: MissionEvidence[];
}): Promise<void> {
  const ledger = createMissionLedger({
    runId: input.runId,
    mission: input.mission,
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 12,
      toolStepBudget: 8,
      finalizationReserve: 4,
      expectedTools: ["web_search", "web_fetch", "append_to_current_file"],
      stopWhenSatisfied: true,
    },
    researchPlan: input.researchPlan,
    now: new Date("2026-08-19T12:00:00.000Z"),
  });
  ledger.status = "budget";
  ledger.evidence = input.evidence ?? [];
  await writeMissionLedger(input.context, ledger);
  await writeMissionRuntimeSnapshot(
    input.context,
    createMissionRuntimeSnapshot({
      runId: input.runId,
      originalMission: input.mission,
      currentNotePath: "Current.md",
      status: "paused",
      researchPlan: input.researchPlan,
      evidence: input.evidence ?? [],
      operationGoals: { web_search: "pending", web_fetch: "pending" },
      lastSafeStep: 6,
      createdAt: new Date("2026-08-19T12:00:00.000Z"),
      updatedAt: new Date("2026-08-19T12:05:00.000Z"),
    }),
  );
}

function pendingWebResearchPlan(minFetchedSources: number): ResearchPlan {
  return {
    version: 1,
    mode: "deep_web",
    sourceRequirements: {
      minFetchedSources,
      minDistinctDomains: Math.min(1, minFetchedSources),
    },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "rq-web",
        question: "What does the PRO-14 deadlock retrospective report?",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "pending",
        evidenceIds: [],
      },
    ],
    evidenceIds: [],
    status: "in_progress",
  };
}

/** Provider-observed Specialist retrieval, as the host seeds it into the Lead. */
function specialistWebEvidence(): ResearchEvidence {
  return {
    id: "web_fetch:https://example.com/pro-14-deadlock",
    kind: "web_source",
    title: "PRO-14 deadlock retrospective",
    url: "https://example.com/pro-14-deadlock",
    passageId: "source:pro14:passage:0-120",
    passageIds: ["source:pro14:passage:0-120"],
    usableSource: true,
    parserStatus: "parsed",
    subquestionId: "rq-web",
    summary: "The retrospective documents the researcher handoff deadlock.",
    confidence: "high",
  };
}

function acceptedResearcherHandoffContext(): string {
  return [
    "Adaptive Specialist handoff (accepted): bounded web retrieval reported complete.",
    "- The Lead must verify the referenced evidence before any mutation.",
  ].join("\n");
}

function parseResumedRuntimeSnapshot(
  files: Map<string, string>,
  seedRunId: string,
): MissionRuntimeSnapshotV2 | null {
  const resumedMarkdown = [...files.entries()].find(
    ([path]) =>
      /^Agent Runs\/[^/]+\.md$/u.test(path) &&
      path !== `Agent Runs/${seedRunId}.md`,
  )?.[1];
  return resumedMarkdown
    ? parseMissionRuntimeSnapshotFromMarkdown(resumedMarkdown)
    : null;
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

test("a two-marker write contract is not discharged by one receipt", async () => {
  // Proof-matrix interrupted-continuation at fully-merged main, 2026-08-26:
  // the lane was killed pre-first-write (BOTH markers owed), the resumed
  // segment paid exactly ONE append, and acceptance returned
  // status "pass" / reasons ["required_evidence_and_receipts_present",
  // "mission_plan_contracts_satisfied"] while the second marker had never
  // been written. `requiredTools` is a SET (append_to_current_file appears
  // once however many appends were ordered) and write_receipt is satisfied
  // by the PRESENCE of a receipt, so nothing in acceptance counted the work.
  // The artifact is the only count-aware evidence.
  const vault = createVaultHarness();
  vault.context.settings.semanticSearchEnabled = true;
  const mission =
    "Perform exactly two ordered durable appends to the current note, then finish. " +
    "First append exactly one line containing MARKER_A1 and verify that write. " +
    "Then append exactly one separate line containing MARKER_B2 and verify that write. " +
    "Two appends total, in that order. This task needs no web, memory, or vault research.";

  const completions: AgentRunCompleteEvent[] = [];
  const traces: AgentTraceEvent[] = [];
  await runAgentMission({
    prompt: mission,
    // The model pays ONLY the first marker, then declares completion — the
    // exact live shape.
    modelClient: createModelClient([
      responseWithToolCall("append_to_current_file", { text: "MARKER_A1" }),
      {
        message: {
          role: "assistant",
          content: "The first ordered append is durably recorded. Mission complete.",
          toolCalls: [],
        },
        toolCalls: [],
      },
      {
        message: {
          role: "assistant",
          content: "The first ordered append is durably recorded. Mission complete.",
          toolCalls: [],
        },
        toolCalls: [],
      },
    ]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onRunComplete: (event) => completions.push(event),
      onTrace: (event) => traces.push(event),
    },
  });

  const note = vault.files.get("Current.md") ?? "";
  assert.equal(note.split("MARKER_A1").length - 1, 1, note);
  assert.equal(
    note.includes("MARKER_B2"),
    false,
    "fixture guard: this test is about the SECOND marker never landing",
  );
  const acceptanceTrace = traces
    .filter((event) => event.id.startsWith("mission-acceptance-"))
    .at(-1);
  assert.ok(acceptanceTrace);
  const acceptanceMissing = Array.isArray(
    (acceptanceTrace.outputPreview as { missing?: unknown })?.missing,
  )
    ? ((acceptanceTrace.outputPreview as { missing: string[] }).missing)
    : [];
  assert.ok(
    acceptanceMissing.includes("literal:MARKER_B2"),
    JSON.stringify({
      rule: "Acceptance must name the required literal that was never written; one receipt does not discharge a two-marker contract.",
      note,
      missing: acceptanceMissing,
      acceptance: acceptanceTrace.message,
    }),
  );
  assert.doesNotMatch(
    String(acceptanceTrace.message),
    /Mission acceptance: pass/u,
    JSON.stringify({ note, acceptance: acceptanceTrace.message }),
  );
  const completion = completions.at(-1);
  assert.ok(completion);
  assert.notEqual(
    completion.stopReason,
    "write_completed",
    JSON.stringify({ rule: "half-paid literal contract must not close as a completed write", completion }),
  );
});
