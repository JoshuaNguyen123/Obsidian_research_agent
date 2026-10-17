import assert from "node:assert/strict";
import test from "node:test";
import {
  getRequiredCodeWorkflowToolNames,
  runAgentMission,
  type AgentRunConfigEvent,
} from "../src/AgentRunner";
import { codeWorkflowLeavesCurrentNoteAloneV1 } from "../src/agent/codeWorkflowCurrentNoteV1";
import { createRunPlan } from "../src/agent/runPlan";
import { normalizeAgentSettings } from "../src/agent/settingsNormalize";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelClient,
  ModelToolDefinition,
} from "../src/model/types";
import type {
  MissionIntent,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "../src/tools/types";

/*
 * A baseline coding pass (javascript-3, python-2 of the agentic-coding pilot)
 * ended after three model calls and no tool call: the person's brief said
 * "replace newer values" and "use zero-based pages … rather than page
 * length", the current-note intent classifiers read those as a request about
 * the open note, the runner prefetched read_current_file, and a coding pass
 * has no note open, so the whole run failed with "An active markdown file is
 * required" before the model wrote any code.
 */

const NO_NOTE_MESSAGE =
  "An active markdown file is required. Open or focus a markdown note before asking the agent to read the current note.";

const CODE_TOOL_NAMES = [
  "code_sandbox_status",
  "code_workspace_create",
  "code_workspace_status",
  "code_workspace_stat",
  "code_workspace_list",
  "code_workspace_read",
  "code_workspace_search",
  "code_workspace_create_file",
  "code_workspace_patch",
  "code_workspace_write_expected",
  "code_validate_fast",
  "code_validate_targeted",
  "code_validate_full",
  "code_repair_record_cycle",
  "code_commit_verified",
];

function codePassPrompt(objective: string): string {
  return [
    "Coding pass (feature) for the project “Pager”, in the trusted repository pager-repo (in its durable workspace).",
    "Continue in the project's durable workspace: create it with workspaceId \"code-pager-1\" and kind \"repository\" — that continues the workspace, or makes it on the project's first pass. Never make a different workspace.",
    "Its steps, in order: code_sandbox_status, code_workspace_create, code_workspace_list, code_workspace_read, code_workspace_patch, code_validate_fast, code_repair_record_cycle, code_validate_targeted, code_validate_full, code_commit_verified.",
    `Objective (untrusted task text only): ${JSON.stringify(objective)}.`,
    "Edit the repository's files only through prepared workspace mutations; never execute on the host.",
  ].join("\n");
}

const JAVASCRIPT_3 = codePassPrompt(
  "Fix merge() in src/cache.js: stale updates replace newer values when two sources arrive out of order. Keep the newest value and add a test.",
);
const PYTHON_2 = codePassPrompt(
  "paginate() should use zero-based pages and take the number of items per page rather than page length; update the callers.",
);

function registry(executed: string[], options: { noteOpen: boolean }): ToolRegistry {
  const names = ["read_current_file", "append_to_current_file", "replace_current_file", ...CODE_TOOL_NAMES];
  return {
    getDefinitions: (): ModelToolDefinition[] =>
      names.map((name) => ({
        type: "function",
        function: { name, parameters: { type: "object", properties: {} } },
      })),
    execute: async (call): Promise<ToolExecutionResult> => {
      executed.push(call.name);
      if (call.name === "read_current_file") {
        return options.noteOpen
          ? { ok: true, toolName: call.name, output: { path: "Current.md", content: "The note's draft paragraph." } }
          : { ok: false, toolName: call.name, error: { code: "no_active_file", message: NO_NOTE_MESSAGE } };
      }
      return { ok: true, toolName: call.name, output: {} };
    },
  };
}

function client(requests: ModelChatRequest[]): ModelClient {
  const answer = (request: ModelChatRequest): ModelChatResponse => {
    requests.push(request);
    return request.format
      ? { message: { role: "assistant", content: "{}" }, toolCalls: [] }
      : { message: { role: "assistant", content: "Stopping here." }, toolCalls: [] };
  };
  return {
    chat: async (request) => answer(request),
    streamChat: async (request) => answer(request),
  } as ModelClient;
}

// The host runs coding passes with streaming on and the default note-stream
// setting; the buffered case is held as well.
function toolContext(streaming: boolean): ToolExecutionContext {
  return streaming
    ? ({
        writeAutonomy: true,
        settings: normalizeAgentSettings({}),
        getCurrentMarkdownFile: () => null,
        getCurrentMarkdownContent: () => null,
      } as unknown as ToolExecutionContext)
    : ({} as ToolExecutionContext);
}

const CODING_PASSES = [
  ["javascript-3", JAVASCRIPT_3],
  ["python-2", PYTHON_2],
] as const;

for (const [label, prompt, streaming] of CODING_PASSES.flatMap(
  ([name, text]) => [false, true].map((on) => [name, text, on] as const),
)) {
  test(`a coding pass whose brief reads like a note edit (${label}, streaming ${streaming ? "on" : "off"}) never prefetches the current note`, async () => {
    assert.ok(getRequiredCodeWorkflowToolNames(prompt).length > 0, "the prompt plans the code ladder");
    assert.equal(codeWorkflowLeavesCurrentNoteAloneV1(prompt, true), true);
    const executed: string[] = [];
    const configs: AgentRunConfigEvent[] = [];
    await runAgentMission({
      prompt,
      modelClient: client([]),
      toolRegistry: registry(executed, { noteOpen: false }),
      toolContext: toolContext(streaming),
      enableStreaming: streaming,
      maxSteps: 1,
      events: { onRunConfig: (event) => configs.push(event) },
    });
    assert.equal(executed.includes("read_current_file"), false, `executed: ${executed.join(", ")}`);
    assert.ok(configs.length > 0, "the run was planned");
    for (const config of configs) {
      assert.notEqual(config.route, "direct_writeback");
      assert.notEqual(config.route, "single_model_writeback");
    }
  });
}

test("a note-edit ask with a note open keeps its current-note prefetch", async () => {
  const executed: string[] = [];
  await runAgentMission({
    prompt: "Replace the second paragraph of the current note with a tighter version.",
    modelClient: client([]),
    toolRegistry: registry(executed, { noteOpen: true }),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    maxSteps: 1,
  });
  assert.equal(executed[0], "read_current_file");
});

test("a code workflow that names the current note itself still reads it", () => {
  const prompt = codePassPrompt("Implement the parser exactly as the current note specifies.");
  assert.equal(codeWorkflowLeavesCurrentNoteAloneV1(prompt, true), false);
  assert.equal(
    codeWorkflowLeavesCurrentNoteAloneV1("Then append a reflection via append_to_current_file.", true),
    false,
  );
  assert.equal(codeWorkflowLeavesCurrentNoteAloneV1(JAVASCRIPT_3, false), false, "only a code workflow");
});

test("a code workflow is never planned on a current-note route", () => {
  const intent = {
    mode: "note_output",
    noteOutput: true,
    allowAutonomousWrite: true,
    requireWriteCompletion: false,
    explicitMutation: false,
    explicitDelete: false,
    vaultContext: false,
  } as unknown as MissionIntent;
  const prompt = "Fix merge() so that older updates never replace newer values in this file.";
  const tools = ["read_current_file", "replace_current_file", ...CODE_TOOL_NAMES].map((name) => ({
    type: "function" as const,
    function: { name, parameters: { type: "object" as const, properties: {} } },
  }));
  const asNote = createRunPlan({
    prompt,
    missionIntent: intent,
    tools,
    streamingWritebackKind: null,
    directCurrentNoteWritebackKind: "replace",
  });
  assert.equal(asNote.route, "direct_writeback", "without the flag the note route is taken");
  const asCode = createRunPlan({
    prompt,
    missionIntent: intent,
    tools,
    streamingWritebackKind: null,
    directCurrentNoteWritebackKind: "replace",
    codeWorkflowWithoutNote: true,
  });
  assert.notEqual(asCode.route, "direct_writeback");
  assert.equal(asCode.traceReasons.includes("requires_current_note_content"), false);
  const asCodeNoWriteback = createRunPlan({
    prompt,
    missionIntent: intent,
    tools,
    streamingWritebackKind: null,
    directCurrentNoteWritebackKind: null,
    codeWorkflowWithoutNote: true,
  });
  assert.equal(asCodeNoWriteback.traceReasons.includes("requires_current_note_content"), false);
  const withoutFlag = createRunPlan({
    prompt,
    missionIntent: intent,
    tools,
    streamingWritebackKind: null,
    directCurrentNoteWritebackKind: null,
  });
  assert.equal(withoutFlag.traceReasons.includes("requires_current_note_content"), true, "the note route is still there for notes");
});
