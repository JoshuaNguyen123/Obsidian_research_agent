import {
  HttpRequest,
  HttpTransport,
  ModelChatMessage,
  ModelChatRequest,
  ModelChatResponse,
  ModelClient,
  ModelClientError,
  ModelChatStreamEvents,
  ModelRole,
  ModelToolCall,
  StreamingHttpResponse,
  StreamingHttpTransport,
} from "./types";

interface OllamaClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  transport: HttpTransport;
  streamingTransport?: StreamingHttpTransport;
  requestTimeoutMs?: number;
}

interface OllamaMessage {
  role: ModelRole;
  content?: string;
  thinking?: string;
  tool_name?: string;
  tool_calls?: unknown[];
}

export class OllamaClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly transport: HttpTransport;
  private readonly streamingTransport?: StreamingHttpTransport;
  private readonly requestTimeoutMs?: number;

  constructor(options: OllamaClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.transport = options.transport;
    this.streamingTransport = options.streamingTransport;
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  async chat(request: ModelChatRequest): Promise<ModelChatResponse> {
    const model = request.model?.trim() || this.model.trim();
    const chatUrl = getOllamaChatUrl(this.baseUrl);

    if (!model) {
      throw new ModelClientError("api", "Model name is required.");
    }

    if (isOllamaCloudBaseUrl(this.baseUrl) && !this.apiKey.trim()) {
      throw new ModelClientError(
        "missing_api_key",
        "Ollama Cloud requires an API key. Add one in Agentic Researcher settings.",
      );
    }

    const httpRequest: HttpRequest = {
      url: chatUrl,
      method: "POST",
      contentType: "application/json",
      headers: this.buildHeaders(),
      throw: false,
      timeoutMs: this.requestTimeoutMs,
      body: JSON.stringify(buildOllamaChatBody(request, model, false)),
    };

    let response;
    try {
      response = await this.transport(httpRequest);
    } catch (error) {
      throw new ModelClientError(
        "network",
        `Network request to Ollama failed: ${getUnknownErrorMessage(error)}`,
        { originalError: error },
      );
    }

    if (response.status >= 400) {
      throw mapOllamaHttpError(response.status, getResponseBody(response));
    }

    return parseOllamaChatResponse(getResponseBody(response));
  }

  async streamChat(
    request: ModelChatRequest,
    events: ModelChatStreamEvents = {},
  ): Promise<ModelChatResponse> {
    if (!this.streamingTransport) {
      throw new ModelClientError(
        "network",
        "Streaming transport is not available.",
      );
    }

    const model = request.model?.trim() || this.model.trim();
    const chatUrl = getOllamaChatUrl(this.baseUrl);

    if (!model) {
      throw new ModelClientError("api", "Model name is required.");
    }

    if (isOllamaCloudBaseUrl(this.baseUrl) && !this.apiKey.trim()) {
      throw new ModelClientError(
        "missing_api_key",
        "Ollama Cloud requires an API key. Add one in Agentic Researcher settings.",
      );
    }

    const httpRequest: HttpRequest = {
      url: chatUrl,
      method: "POST",
      contentType: "application/json",
      headers: this.buildHeaders(),
      throw: false,
      timeoutMs: this.requestTimeoutMs,
      body: JSON.stringify(buildOllamaChatBody(request, model, true)),
    };

    let response: StreamingHttpResponse;
    try {
      response = await this.streamingTransport(httpRequest);
    } catch (error) {
      throw new ModelClientError(
        "network",
        `Streaming request to Ollama failed: ${getUnknownErrorMessage(error)}`,
        { originalError: error },
      );
    }

    if (response.status >= 400) {
      throw mapOllamaHttpError(response.status, await readStreamBody(response.body));
    }

    return parseOllamaChatStream(response.body, events);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const apiKey = this.apiKey.trim();

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    return headers;
  }
}

function buildOllamaChatBody(
  request: ModelChatRequest,
  model: string,
  stream: boolean,
) {
  const body: Record<string, unknown> = {
    model,
    messages: request.messages.map(toOllamaMessage),
    tools: request.tools,
    think: request.think,
    stream,
  };

  if (request.options && Object.keys(request.options).length > 0) {
    body.options = request.options;
  }

  return body;
}

export function normalizeOllamaBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");

  if (!trimmed) {
    throw new ModelClientError("api", "Ollama base URL is required.");
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ModelClientError(
      "api",
      "Ollama base URL must start with http:// or https://.",
    );
  }

  return trimmed;
}

export function getOllamaChatUrl(baseUrl: string): string {
  return `${normalizeOllamaBaseUrl(baseUrl)}/chat`;
}

export function isOllamaCloudBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(normalizeOllamaBaseUrl(baseUrl));
    return url.hostname === "ollama.com" || url.hostname.endsWith(".ollama.com");
  } catch {
    return false;
  }
}

export function parseOllamaChatResponse(body: unknown): ModelChatResponse {
  if (!isRecord(body)) {
    throw new ModelClientError(
      "invalid_response",
      "Ollama returned an invalid response body.",
      { details: body },
    );
  }

  const rawMessage = body.message;
  if (!isRecord(rawMessage)) {
    throw new ModelClientError(
      "invalid_response",
      "Ollama response did not include an assistant message.",
      { details: body },
    );
  }

  const role = parseModelRole(rawMessage.role);
  const toolCalls = parseOllamaToolCalls(rawMessage.tool_calls);
  const message: ModelChatMessage = {
    role,
    content: typeof rawMessage.content === "string" ? rawMessage.content : "",
    thinking:
      typeof rawMessage.thinking === "string" ? rawMessage.thinking : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };

  return {
    message,
    toolCalls,
    doneReason:
      typeof body.done_reason === "string" ? body.done_reason : undefined,
    raw: body,
  };
}

export async function parseOllamaChatStream(
  stream: AsyncIterable<string>,
  events: ModelChatStreamEvents = {},
): Promise<ModelChatResponse> {
  const chunks: unknown[] = [];
  const toolCalls: ModelToolCall[] = [];
  let buffer = "";
  let content = "";
  let thinking = "";
  let role: ModelRole = "assistant";
  let doneReason: string | undefined;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new ModelClientError(
        "invalid_response",
        "Ollama returned invalid streaming JSON.",
        { details: trimmed, originalError: error },
      );
    }

    if (isRecord(parsed) && typeof parsed.error === "string") {
      throw new ModelClientError("api", parsed.error, { details: parsed });
    }

    chunks.push(parsed);

    if (!isRecord(parsed)) {
      throw new ModelClientError(
        "invalid_response",
        "Ollama returned an invalid streaming chunk.",
        { details: parsed },
      );
    }

    const rawMessage = parsed.message;
    if (isRecord(rawMessage)) {
      role = parseModelRole(rawMessage.role ?? role);

      if (typeof rawMessage.thinking === "string" && rawMessage.thinking) {
        thinking += rawMessage.thinking;
        events.onThinkingDelta?.(rawMessage.thinking);
      }

      if (typeof rawMessage.content === "string" && rawMessage.content) {
        content += rawMessage.content;
        events.onContentDelta?.(rawMessage.content);
      }

      toolCalls.push(...parseOllamaToolCalls(rawMessage.tool_calls));
    }

    if (typeof parsed.done_reason === "string") {
      doneReason = parsed.done_reason;
    }
  };

  for await (const chunk of stream) {
    buffer += chunk;

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      processLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  processLine(buffer);

  const message: ModelChatMessage = {
    role,
    content,
    thinking: thinking || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };

  return {
    message,
    toolCalls,
    doneReason,
    raw: chunks,
  };
}

function toOllamaMessage(message: ModelChatMessage): OllamaMessage {
  const ollamaMessage: OllamaMessage = {
    role: message.role,
    content: message.content,
  };

  if (message.toolName) {
    ollamaMessage.tool_name = message.toolName;
  }

  if (message.toolCalls?.length) {
    ollamaMessage.tool_calls = message.toolCalls.map((toolCall) => ({
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
        index: toolCall.index,
      },
    }));
  }

  return ollamaMessage;
}

function parseModelRole(role: unknown): ModelRole {
  if (
    role === "system" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool"
  ) {
    return role;
  }

  throw new ModelClientError(
    "invalid_response",
    "Ollama returned a message with an unknown role.",
    { details: role },
  );
}

function parseOllamaToolCalls(toolCalls: unknown): ModelToolCall[] {
  if (toolCalls === undefined || toolCalls === null) {
    return [];
  }

  if (!Array.isArray(toolCalls)) {
    throw new ModelClientError(
      "invalid_response",
      "Ollama returned tool_calls in an unexpected format.",
      { details: toolCalls },
    );
  }

  return toolCalls.map((toolCall) => {
    if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
      throw new ModelClientError(
        "invalid_response",
        "Ollama returned an invalid tool call.",
        { details: toolCall },
      );
    }

    const fn = toolCall.function;
    if (typeof fn.name !== "string" || !fn.name) {
      throw new ModelClientError(
        "invalid_response",
        "Ollama returned a tool call without a function name.",
        { details: toolCall },
      );
    }

    return {
      name: fn.name,
      arguments: parseToolArguments(fn.arguments),
      index: typeof fn.index === "number" ? fn.index : undefined,
      id: typeof toolCall.id === "string" ? toolCall.id : undefined,
      raw: toolCall,
    };
  });
}

function parseToolArguments(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) {
    return {};
  }

  if (isRecord(args)) {
    return args;
  }

  if (typeof args === "string") {
    if (!args.trim()) {
      return {};
    }

    try {
      const parsed = JSON.parse(args);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Handled by the error below.
    }
  }

  throw new ModelClientError(
    "invalid_response",
    "Ollama returned tool arguments in an unexpected format.",
    { details: args },
  );
}

function mapOllamaHttpError(status: number, body: unknown): ModelClientError {
  const detail = getErrorDetail(body);

  if (status === 401 || status === 403) {
    return new ModelClientError(
      "auth",
      detail || "Ollama rejected the request. Check the API key.",
      { status, details: body },
    );
  }

  if (status === 429) {
    return new ModelClientError(
      "rate_limit",
      detail || "Ollama rate limit reached. Try again later.",
      { status, details: body },
    );
  }

  return new ModelClientError(
    "api",
    detail || `Ollama API request failed with status ${status}.`,
    { status, details: body },
  );
}

function getResponseBody(response: { json?: unknown; text?: string }): unknown {
  if (response.json !== undefined) {
    return response.json;
  }

  if (response.text) {
    try {
      return JSON.parse(response.text);
    } catch {
      return response.text;
    }
  }

  return undefined;
}

async function readStreamBody(stream: AsyncIterable<string>): Promise<unknown> {
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
  }

  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getErrorDetail(body: unknown): string | null {
  if (typeof body === "string") {
    return body;
  }

  if (!isRecord(body)) {
    return null;
  }

  if (typeof body.error === "string") {
    return body.error;
  }

  if (typeof body.message === "string") {
    return body.message;
  }

  return null;
}

function getUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
