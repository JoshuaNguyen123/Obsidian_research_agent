import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelClient,
  ModelToolCall,
} from "../../src/model/types";
import { ApprovalBroker } from "../../src/agent/approvalBroker";
import type { ApprovalRequest } from "../../src/agent/approvalBroker";
import type { AgentSettings } from "../../src/settings";
import type { ToolExecutionContext } from "../../src/tools/types";

/*
 * The pieces a runner test needs around a scripted coding pass: a vault the
 * run ledger can live in, settings, and a model whose agent turns are written
 * by the test (structured planner and classifier calls get "{}", a tool-less
 * synthesis gets prose).
 */

export function codePassPromptV1(objective: string, steps: readonly string[]): string {
  return [
    "Coding pass (feature) for the project “Pager”, in the trusted repository pager-repo (in its durable workspace).",
    "Continue in the project's durable workspace: create it with workspaceId \"code-pager-1\" and kind \"repository\" — that continues the workspace, or makes it on the project's first pass. Never make a different workspace.",
    ...(steps.length > 0 ? [`Its steps, in order: ${steps.join(", ")}.`] : []),
    `Objective (untrusted task text only): ${JSON.stringify(objective)}.`,
    "Edit the repository's files only through prepared workspace mutations; never execute on the host.",
  ].join("\n");
}

export const GUIDED_PASS_STEPS_V1 = [
  "code_sandbox_status",
  "code_workspace_create",
  "code_workspace_list",
  "code_workspace_read",
  "code_workspace_patch",
  "code_validate_fast",
  "code_repair_record_cycle",
  "code_validate_targeted",
  "code_validate_full",
  "code_commit_verified",
] as const;

export function scriptedRunSettings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    settingsSchemaVersion: 2,
    autonomyProfile: "automatic",
    outputProfile: "active_or_new_note",
    modelProvider: "ollama",
    ollamaApiKey: "test-key",
    ollamaBaseUrl: "https://ollama.com/api",
    openAiCompatibleApiKey: "",
    openAiCompatibleBaseUrl: "https://api.openai.com/v1",
    model: "gpt-oss:120b",
    enableStreaming: false,
    thinkingMode: "off",
    streamWritebackMode: "all_current_note_content_writes",
    autoTitleOnWrite: false,
    maxAgentSteps: 100,
    companionBaseUrl: "http://127.0.0.1:8765",
    browserToolsEnabled: false,
    experienceMemoryEnabled: false,
    defaultBrowserMissionMode: "supervised",
    agenticReflexEnabled: false,
    agenticReflexDiagnosticsEnabled: false,
    templateFolder: "Templates",
    templateOutputFolder: "",
    researchMemoryEnabled: false,
    researchMemoryFolder: "Agent Research Memory",
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
    semanticIndexDebounceMs: 3000,
    semanticIndexMaxFiles: 1000,
    semanticIndexPersistVectors: true,
    requestTimeoutMs: 60000,
    temperature: null,
    topK: null,
    topP: null,
    numCtx: null,
    ...overrides,
  } as AgentSettings;
}

/** A vault with no note open: a coding pass works in its workspace. */
export function scriptedRunContext(options: {
  prompt: string;
  now: () => Date;
  settings?: AgentSettings;
}): { context: ToolExecutionContext; content: Map<string, string> } {
  const content = new Map<string, string>();
  const folders = new Set<string>();
  const fileOf = (path: string) => {
    if (!content.has(path)) return null;
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.[^.]+$/u, ""),
      extension: name.includes(".") ? name.split(".").pop()!.toLowerCase() : "",
    };
  };
  const folderOf = (path: string) =>
    path && folders.has(path) ? { path, name: path.split("/").pop() ?? path } : null;
  const app = {
    workspace: { getActiveFile: () => null },
    vault: {
      getFiles: () => [...content.keys()].map(fileOf).filter(Boolean),
      getAllLoadedFiles: () => [
        ...[...folders].map((path) => ({ path, name: path.split("/").pop() ?? path })),
        ...[...content.keys()].map(fileOf).filter(Boolean),
      ],
      cachedRead: async (file: { path: string }) => content.get(file.path) ?? "",
      read: async (file: { path: string }) => content.get(file.path) ?? "",
      process: async (file: { path: string }, transform: (current: string) => string) => {
        const next = transform(content.get(file.path) ?? "");
        content.set(file.path, next);
        return next;
      },
      modify: async (file: { path: string }, data: string) => {
        content.set(file.path, data);
      },
      getFileByPath: fileOf,
      getFolderByPath: folderOf,
      getAbstractFileByPath: (path: string) => fileOf(path) ?? folderOf(path),
      createFolder: async (path: string) => {
        folders.add(path);
      },
      create: async (path: string, data: string) => {
        content.set(path, data);
        return fileOf(path);
      },
      rename: async (file: { path: string }, newPath: string) => {
        const value = content.get(file.path) ?? "";
        content.delete(file.path);
        content.set(newPath, value);
      },
      delete: async (file: { path: string }) => {
        content.delete(file.path);
      },
    },
  };
  const context: ToolExecutionContext = {
    app: app as never,
    settings: options.settings ?? scriptedRunSettings(),
    originalPrompt: options.prompt,
    writeAutonomy: true,
    httpTransport: async () => ({ status: 500, headers: {}, json: { error: "not mocked" } }),
    now: options.now,
    getCurrentMarkdownFile: () => null,
    getCurrentMarkdownContent: () => null,
  } as ToolExecutionContext;
  return { context, content };
}

export interface ScriptedTurn {
  /** The tools the model was offered on this agent turn. */
  offered: string[];
  calls: ModelToolCall[];
  content: string;
}

/**
 * A model whose agent turns come from `decide`, called with the request and
 * the tools it offers; it answers with tool calls or prose. Every agent turn
 * is recorded with what it was offered.
 */
export function scriptedCodeModel(
  decide: (input: { request: ModelChatRequest; offered: string[]; turn: number }) =>
    | { calls: Array<{ name: string; arguments: Record<string, unknown> }> }
    | { content: string },
  /** What a structured (planner or classifier) request is answered with; "{}" by default. */
  structured: (request: ModelChatRequest) => string = () => "{}",
): { client: ModelClient; turns: ScriptedTurn[]; requests: ModelChatRequest[] } {
  const turns: ScriptedTurn[] = [];
  const requests: ModelChatRequest[] = [];
  const answer = (request: ModelChatRequest): ModelChatResponse => {
    requests.push(request);
    if (request.format) {
      return { message: { role: "assistant", content: structured(request) }, toolCalls: [] };
    }
    const offered = (request.tools ?? []).map((tool) => tool.function.name);
    if (offered.length === 0) {
      return { message: { role: "assistant", content: "The coding pass is complete." }, toolCalls: [] };
    }
    const decision = decide({ request, offered, turn: turns.length });
    if ("content" in decision) {
      turns.push({ offered, calls: [], content: decision.content });
      return { message: { role: "assistant", content: decision.content }, toolCalls: [] };
    }
    const calls: ModelToolCall[] = decision.calls.map((call, index) => ({
      id: `call-${turns.length + 1}-${index + 1}`,
      name: call.name,
      arguments: call.arguments,
    }));
    turns.push({ offered, calls, content: "" });
    return {
      message: { role: "assistant", content: "", toolCalls: calls },
      toolCalls: calls,
    };
  };
  return {
    client: {
      chat: async (request) => answer(request),
      streamChat: async (request) => answer(request),
    } as ModelClient,
    turns,
    requests,
  };
}

/**
 * An approval broker that answers every request at once, recording each one,
 * so a test sees which actions asked. `deny` names tools to refuse instead.
 */
export function autoApprovals(options: { deny?: readonly string[] } = {}): {
  broker: ApprovalBroker;
  onApprovalRequest: (request: ApprovalRequest) => void;
  requests: ApprovalRequest[];
} {
  const broker = new ApprovalBroker();
  const requests: ApprovalRequest[] = [];
  return {
    broker,
    requests,
    onApprovalRequest: (request) => {
      requests.push(request);
      const decision = options.deny?.includes(request.toolName) ? "denied" : "approved";
      queueMicrotask(() => broker.resolve(request.id, decision));
    },
  };
}
