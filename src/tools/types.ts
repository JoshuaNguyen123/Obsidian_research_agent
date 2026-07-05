import type { App, TFile } from "obsidian";
import type { AgentSettings } from "../settings";
import type {
  HttpTransport,
  JsonSchemaObject,
  ModelToolCall,
  ModelToolDefinition,
} from "../model/types";
import type { AutonomyScope } from "../agent/missionScope";
import type { SemanticEmbeddingProvider } from "../embeddings/types";

export type AgentMissionMode =
  | "chat_only"
  | "vault_context_answer"
  | "note_output"
  | "explicit_file_mutation"
  | "explicit_delete";

export interface MissionIntent {
  mode: AgentMissionMode;
  vaultContext: boolean;
  noteOutput: boolean;
  explicitPersistence: boolean;
  explicitMutation: boolean;
  explicitDelete: boolean;
  allowAutonomousWrite: boolean;
  requireWriteCompletion: boolean;
  autonomyScope: AutonomyScope;
}

export interface ResearchMemoryIndexEntry {
  topic: string;
  path: string;
  keywords: string[];
  lastUpdated: string;
}

export interface ToolExecutionContext {
  app: App;
  settings: AgentSettings;
  originalPrompt: string;
  httpTransport: HttpTransport;
  runtimeCache?: AgentRuntimeCache;
  writeAutonomy?: boolean;
  missionIntent?: MissionIntent;
  now?: () => Date;
  getCurrentMarkdownFile?: () => TFile | null;
  getCurrentMarkdownContent?: (file: TFile) => string | null;
  setCurrentMarkdownContent?: (file: TFile, content: string) => boolean;
  getResearchMemoryIndex?: () => ResearchMemoryIndexEntry[];
  setResearchMemoryIndex?: (
    entries: ResearchMemoryIndexEntry[],
  ) => Promise<void> | void;
  semanticEmbeddingProvider?: SemanticEmbeddingProvider;
}

export interface ToolExecutionResult {
  ok: boolean;
  toolName: string;
  output?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface AgentRuntimeCache {
  toolResults: Map<string, ToolExecutionResult>;
  semanticProfiles?: Map<string, unknown>;
  graphProfiles?: Map<string, unknown>;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown>;
}

export class ToolExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
  }
}

export interface ToolRegistry {
  getDefinitions(): ModelToolDefinition[];
  execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
