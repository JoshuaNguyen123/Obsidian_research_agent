export type ModelRole = "system" | "user" | "assistant" | "tool";
export type ModelThink = boolean | "low" | "medium" | "high" | "max";

export type ModelClientErrorCategory =
  | "missing_api_key"
  | "auth"
  | "rate_limit"
  | "api"
  | "network"
  | "invalid_response";

export interface JsonSchemaObject {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  items?: JsonSchemaObject;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchemaObject;
  [key: string]: unknown;
}

export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: JsonSchemaObject;
  };
}

export interface ModelToolCall {
  name: string;
  arguments: Record<string, unknown>;
  index?: number;
  id?: string;
  raw?: unknown;
}

export interface ModelChatMessage {
  role: ModelRole;
  content: string;
  thinking?: string;
  toolName?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelChatRequest {
  model?: string;
  messages: ModelChatMessage[];
  tools?: ModelToolDefinition[];
  think?: ModelThink;
  options?: ModelRequestOptions;
  abortSignal?: AbortSignal;
}

export interface ModelRequestOptions {
  temperature?: number;
  top_k?: number;
  top_p?: number;
  num_ctx?: number;
}

export interface ModelChatResponse {
  message: ModelChatMessage;
  toolCalls: ModelToolCall[];
  doneReason?: string;
  raw?: unknown;
}

export interface ModelChatStreamEvents {
  onRawChunk?: (chunk: string) => void;
  onContentDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
}

export interface ModelClient {
  chat(request: ModelChatRequest): Promise<ModelChatResponse>;
  streamChat(
    request: ModelChatRequest,
    events?: ModelChatStreamEvents,
  ): Promise<ModelChatResponse>;
}

export interface HttpRequest {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export interface StreamingHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<string>;
}

export type StreamingHttpTransport = (
  request: HttpRequest,
) => Promise<StreamingHttpResponse>;

export class ModelClientError extends Error {
  readonly category: ModelClientErrorCategory;
  readonly status?: number;
  readonly details?: unknown;
  readonly originalError?: unknown;

  constructor(
    category: ModelClientErrorCategory,
    message: string,
    options: {
      status?: number;
      details?: unknown;
      originalError?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ModelClientError";
    this.category = category;
    this.status = options.status;
    this.details = options.details;
    this.originalError = options.originalError;
  }
}

export function formatModelClientError(error: unknown): string {
  if (error instanceof ModelClientError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
