import type { Server } from "node:http";

export interface AgentBackendContext {
  signal: AbortSignal;
  requestId: string;
}

export interface AgentBackendResult {
  content?: string;
  toolCalls?: Array<{
    id?: string;
    name: string;
    arguments: unknown;
  }>;
  finishReason?: string;
}

export interface AgentBackend {
  complete(request: Record<string, unknown>, context: AgentBackendContext): Promise<AgentBackendResult>;
  stream?(
    request: Record<string, unknown>,
    context: AgentBackendContext,
  ): AsyncIterable<AgentBackendResult>;
}

export function createAgentBridgeServer(options: {
  token: string;
  backend: AgentBackend;
  logger?: (event: Record<string, unknown>) => void;
  requestTimeoutMs?: number;
}): Server;

export function normalizeAssistantResult(value: unknown): {
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    argumentsText: string;
    index: number;
  }>;
  finishReason: string;
};

export function startAgentBridgeFromEnvironment(
  env?: NodeJS.ProcessEnv,
): Promise<Server>;
