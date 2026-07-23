import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSettings } from "../src/settings";
import {
  createRunPlan,
  resolveThinkingMode,
  type RunRoute,
  type StreamingWritebackKind,
} from "../src/agent/runPlan";
import type { ModelToolDefinition } from "../src/model/types";
import type { MissionIntent } from "../src/tools/types";

const allTools = [
  "append_to_current_file",
  "replace_current_file",
  "rename_current_file",
  "search_markdown_files",
  "web_search",
  "web_fetch",
  "browser_open_page",
  "browser_observe",
  "count_words",
  "get_note_graph_context",
].map((name) => tool(name));

test("named linear_create_issue stays tool_required even with append writeback", () => {
  const plan = createRunPlan({
    prompt:
      "Call linear_create_issue exactly once, then call append_to_current_file. Append markdown with the issue URL.",
    missionIntent: missionIntent({
      mode: "note_output",
      noteOutput: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    }),
    tools: [
      ...allTools,
      tool("linear_create_issue"),
      tool("linear_get_issue"),
    ],
    streamingWritebackKind: "append",
    directCurrentNoteWritebackKind: null,
  });
  assert.equal(plan.route, "tool_required");
  assert.ok(plan.maxStepsForRun >= 8);
  assert.ok(plan.traceReasons.includes("explicit_external_mutation_tool_mission"));
  assert.equal(plan.maxEffectClassWithoutGrant, "hard");
  assert.equal(plan.executionTier, "durable_mission");
});

test("compound Linear+code+GitHub uses grounded workflow step budget not the Bound-mutation 24 cap", () => {
  const plan = createRunPlan({
    prompt: [
      "Run the full pipeline for Flow real: Linear issue, repository workspace, private GitHub, and note reflection.",
      "Call linear_create_issue then linear_get_issue.",
      "Call code_sandbox_status, code_workspace_create, code_workspace_create_file, code_validate_fast, code_repair_record_cycle, code_validate_targeted, code_validate_full, and code_commit_verified.",
      "Create the exact private GitHub repository via github_create_private_repository.",
      "Append a Flow real reflection via append_to_current_file.",
    ].join(" "),
    missionIntent: missionIntent({
      mode: "note_output",
      noteOutput: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    }),
    tools: [
      ...allTools,
      tool("linear_create_issue"),
      tool("linear_get_issue"),
      tool("code_sandbox_status"),
      tool("code_workspace_create"),
      tool("code_workspace_create_file"),
      tool("code_validate_fast"),
      tool("code_repair_record_cycle"),
      tool("code_validate_targeted"),
      tool("code_validate_full"),
      tool("code_commit_verified"),
      tool("github_create_private_repository"),
    ],
    settings: { maxAgentSteps: 128 } as AgentSettings,
    streamingWritebackKind: null,
    directCurrentNoteWritebackKind: null,
  });
  assert.equal(plan.route, "grounded_workflow");
  assert.ok(
    plan.maxStepsForRun > 24,
    `expected compound step budget > 24, got ${plan.maxStepsForRun}`,
  );
  assert.ok(
    !plan.traceReasons.includes("explicit_external_mutation_tool_mission"),
  );
});

test("run plan carries direct-chat classification for analytical prompt", () => {
  const plan = createRunPlan({
    prompt: "Is the red list the complete current set of fully-agentic gaps?",
    missionIntent: missionIntent(),
    tools: [],
    streamingWritebackKind: null,
    directCurrentNoteWritebackKind: null,
  });
  assert.ok(["explain", "evaluate"].includes(plan.speechAct));
  assert.equal(plan.executionTier, "direct_chat");
  assert.equal(plan.route, "single_model_answer");
  assert.equal(plan.maxStepsForRun, 1);
  assert.deepEqual(plan.allowedToolNames, []);
  assert.ok(plan.traceReasons.includes("speech_act_direct_chat"));
});

test("exact pipeline-difficulty question cannot fabricate a durable workflow", () => {
  const plan = createRunPlan({
    prompt:
      "From your perspective, what is hard about doing research in obsidian, agentically, converting the notebook into Linear issues, Linear issues to real code project code files, github and fianlly a reflection ?",
    missionIntent: missionIntent({
      mode: "note_output",
      noteOutput: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    }),
    tools: allTools,
    streamingWritebackKind: "append",
    directCurrentNoteWritebackKind: "append",
  });
  assert.equal(plan.speechAct, "explain");
  assert.equal(plan.executionTier, "direct_chat");
  assert.equal(plan.route, "single_model_answer");
  assert.equal(plan.maxStepsForRun, 1);
  assert.deepEqual(plan.allowedToolNames, []);
});

test("essay then turn into linear issues stays tool_required (not single-step writeback)", () => {
  const plan = createRunPlan({
    prompt:
      "Could you write me a 1000 word essay on china's government? Then turn the essay into linear issues?",
    missionIntent: missionIntent({
      mode: "note_output",
      noteOutput: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    }),
    tools: [...allTools, tool("linear_create_issue"), tool("read_template")],
    streamingWritebackKind: "append",
    directCurrentNoteWritebackKind: null,
  });
  assert.equal(plan.route, "tool_required");
  assert.ok(plan.maxStepsForRun >= 8);
  assert.ok(plan.traceReasons.includes("explicit_external_mutation_tool_mission"));
});

test("run planner exposes route decisions, allowed tool names, and trace reasons", () => {
  const cases: Array<{
    prompt: string;
    route: RunRoute;
    expectedTools: string[];
    intent?: Partial<MissionIntent>;
    streamingWritebackKind?: StreamingWritebackKind | null;
  }> = [
    {
      prompt: "What time is it?",
      route: "instant_local",
      expectedTools: [],
    },
    {
      prompt: "Append a 200 word essay to this note.",
      route: "single_model_writeback",
      expectedTools: ["append_to_current_file"],
      intent: {
        mode: "note_output",
        noteOutput: true,
        allowAutonomousWrite: true,
        requireWriteCompletion: true,
      },
      streamingWritebackKind: "append",
    },
    {
      prompt: "Replace this note with a fresh brief.",
      route: "tool_required",
      expectedTools: ["replace_current_file"],
      intent: {
        mode: "explicit_file_mutation",
        noteOutput: true,
        explicitMutation: true,
        allowAutonomousWrite: true,
        requireWriteCompletion: true,
      },
    },
    {
      prompt: "Search my vault for related notes.",
      route: "grounded_workflow",
      expectedTools: ["search_markdown_files"],
      intent: {
        mode: "vault_context_answer",
        vaultContext: true,
      },
    },
    {
      prompt: "Find latest sources and cite them.",
      route: "grounded_workflow",
      expectedTools: ["web_search", "web_fetch"],
    },
    {
      prompt:
        'Rename the current note to "Durable Target", then research with deep web sources.',
      route: "grounded_workflow",
      expectedTools: ["rename_current_file", "web_search", "web_fetch"],
      intent: {
        mode: "explicit_file_mutation",
        noteOutput: true,
        explicitMutation: true,
        allowAutonomousWrite: true,
        requireWriteCompletion: true,
      },
    },
    {
      prompt: "Open https://example.com in the browser and observe it.",
      route: "grounded_workflow",
      expectedTools: ["browser_open_page", "browser_observe"],
    },
  ];

  for (const item of cases) {
    const tools = allTools.filter(
      (candidate) =>
        item.expectedTools.length === 0 ||
        item.expectedTools.includes(candidate.function.name),
    );
    const plan = createRunPlan({
      prompt: item.prompt,
      missionIntent: missionIntent(item.intent),
      tools,
      settings: settings(),
      streamingWritebackKind: item.streamingWritebackKind ?? null,
      directCurrentNoteWritebackKind: null,
    });

    assert.equal(plan.route, item.route, item.prompt);
    assert.deepEqual(plan.allowedToolNames, item.expectedTools, item.prompt);
    assert.ok(plan.traceReasons.length > 0, item.prompt);
  }
});

test("run planner keeps thinking mode resolution with planner boundary", () => {
  assert.equal(resolveThinkingMode(settings({ model: "gpt-oss:120b" })), "medium");
  assert.equal(resolveThinkingMode(settings({ model: "qwen3:32b" })), true);
  assert.equal(resolveThinkingMode(settings({ model: "llama3.1:8b" })), undefined);
  assert.equal(
    resolveThinkingMode(settings({ model: "llama3.1:8b", thinkingMode: "high" })),
    "high",
  );
});

test("provider backlink preservation does not trigger vault graph retrieval", () => {
  const prompt = [
    "Turn this accepted research into a Linear initiative, project, and dependency-aware issues.",
    "Use one exact grouped approval, independently read every object back, and preserve the note backlink.",
  ].join(" ");
  const plan = createRunPlan({
    prompt,
    missionIntent: missionIntent({
      mode: "explicit_file_mutation",
      explicitMutation: true,
      requireWriteCompletion: true,
    }),
    tools: [
      "get_note_graph_context",
      "publish_research_project_to_linear",
    ].map((name) => tool(name)),
    settings: settings(),
    streamingWritebackKind: null,
    directCurrentNoteWritebackKind: null,
  });

  assert.equal(plan.traceReasons.includes("graph_connection_intent"), false);
  assert.notEqual(plan.slowPathReason, "needs_graph_context");
});

test("compound title and current-note content reserves rename, writeback, and correction steps", () => {
  const plan = createRunPlan({
    prompt:
      "Write a concise summary of the first five laws of power, retitle this document, and generate it onto the page.",
    missionIntent: missionIntent({
      mode: "explicit_file_mutation",
      noteOutput: true,
      explicitMutation: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    }),
    tools: ["read_current_file", "rename_current_file"].map((name) => tool(name)),
    settings: settings({ maxAgentSteps: 100 }),
    streamingWritebackKind: "append",
    directCurrentNoteWritebackKind: null,
  });

  assert.equal(plan.route, "tool_required");
  assert.equal(plan.maxStepsForRun, 4);
  assert.ok(plan.traceReasons.includes("compound_title_writeback"));
});

test("explicit code workspace tools receive a grounded multi-step budget", () => {
  const codeTools = [
    "code_workspace_create",
    "code_workspace_mkdir",
    "code_workspace_create_file",
  ].map((name) => tool(name));
  const plan = createRunPlan({
    prompt: [
      "Create the isolated scratch workspace phase4-crud.",
      "Use exactly code_workspace_create, code_workspace_mkdir, and code_workspace_create_file.",
      "Create src/durable-value.txt containing before:phase4.",
    ].join(" "),
    missionIntent: missionIntent({
      mode: "explicit_file_mutation",
      explicitMutation: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    }),
    tools: codeTools,
    settings: settings({ maxAgentSteps: 40 }),
    streamingWritebackKind: null,
    directCurrentNoteWritebackKind: null,
  });

  assert.equal(plan.route, "grounded_workflow");
  assert.ok(plan.maxStepsForRun >= 8);
  assert.deepEqual(plan.allowedToolNames, codeTools.map((item) => item.function.name));
  assert.ok(plan.traceReasons.includes("code_execution_intent"));
});

test("explicit code workspace lifecycle budget covers every named tool", () => {
  const prompt = [
    "Use code_workspace_create, code_workspace_mkdir, code_workspace_create_file,",
    "code_workspace_read, code_workspace_write_expected, code_workspace_move,",
    "code_workspace_trash, and code_workspace_restore.",
  ].join(" ");
  const plan = createRunPlan({
    prompt,
    missionIntent: missionIntent({
      mode: "explicit_file_mutation",
      explicitMutation: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    }),
    tools: [
      "code_workspace_create",
      "code_workspace_mkdir",
      "code_workspace_create_file",
      "code_workspace_read",
      "code_workspace_write_expected",
      "code_workspace_move",
      "code_workspace_trash",
      "code_workspace_restore",
    ].map((name) => tool(name)),
    settings: settings({ maxAgentSteps: 40 }),
    streamingWritebackKind: null,
    directCurrentNoteWritebackKind: null,
  });

  assert.equal(plan.route, "grounded_workflow");
  assert.ok(plan.maxStepsForRun >= 12);
});

function tool(name: string): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: name,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  };
}

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    modelProvider: "ollama",
    ollamaApiKey: "test-key",
    ollamaBaseUrl: "https://ollama.com/api",
    openAiCompatibleApiKey: "",
    openAiCompatibleBaseUrl: "https://api.openai.com/v1",
    model: "gpt-oss:120b",
    enableStreaming: true,
    thinkingMode: "auto",
    streamWritebackMode: "all_current_note_content_writes",
    maxAgentSteps: 100,
    companionBaseUrl: "http://127.0.0.1:8765",
    browserToolsEnabled: false,
    experienceMemoryEnabled: false,
    defaultBrowserMissionMode: "supervised",
    agenticReflexEnabled: false,
    agenticReflexDiagnosticsEnabled: true,
    templateFolder: "Templates",
    templateOutputFolder: "",
    researchMemoryEnabled: true,
    researchMemoryFolder: "Agent Research Memory",
    semanticSearchEnabled: true,
    semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
    semanticEmbeddingDim: 512,
    semanticChunkMinTokens: 300,
    semanticChunkTargetTokens: 500,
    semanticChunkMaxTokens: 700,
    semanticChunkOverlapTokens: 80,
    semanticPythonCommand: "",
    semanticModelCacheDir: "",
    semanticIndexEnabled: true,
    semanticIndexFolder: "Agent Memory",
    semanticIndexDebounceMs: 3000,
    semanticIndexMaxFiles: 1000,
    semanticIndexPersistVectors: true,
    requestTimeoutMs: 60000,
    temperature: null,
    topK: null,
    topP: null,
    numCtx: null,
    ...overrides,
  };
}

function missionIntent(overrides: Partial<MissionIntent> = {}): MissionIntent {
  return {
    mode: "chat_only",
    vaultContext: false,
    noteOutput: false,
    explicitPersistence: false,
    explicitMutation: false,
    explicitDelete: false,
    allowAutonomousWrite: false,
    requireWriteCompletion: false,
    autonomyScope: {
      read: {
        currentNote: false,
        vault: false,
        folders: [],
        files: [],
        web: false,
      },
      write: {
        currentNote: false,
        folders: [],
        files: [],
        artifacts: false,
        researchMemory: false,
      },
      destructive: {
        replaceCurrentNote: false,
        deleteCurrentNote: false,
        deletePaths: false,
      },
    },
    ...overrides,
  };
}
