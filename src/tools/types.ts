import type { App, TFile } from "obsidian";
import type { AgentSettings } from "../settings";
import type {
  HttpTransport,
  JsonSchemaObject,
  ModelToolCall,
  ModelToolDefinition,
} from "../model/types";

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
}

export interface ToolExecutionContext {
  app: App;
  settings: AgentSettings;
  originalPrompt: string;
  httpTransport: HttpTransport;
  writeAutonomy?: boolean;
  missionIntent?: MissionIntent;
  now?: () => Date;
  getCurrentMarkdownFile?: () => TFile | null;
  getCurrentMarkdownContent?: (file: TFile) => string | null;
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
