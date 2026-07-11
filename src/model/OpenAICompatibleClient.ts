import type {
  HttpRequest,
  HttpTransport,
  JsonSchemaObject,
  ModelChatMessage,
  ModelChatRequest,
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
  ModelRequestOptions,
  ModelRole,
  ModelToolCall,
  ModelToolDefinition,
  StreamingHttpResponse,
  StreamingHttpTransport,
} from "./types";
import { ModelClientError } from "./types";

interface OpenAICompatibleClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  transport: HttpTransport;
  streamingTransport?: StreamingHttpTransport;
  requestTimeoutMs?: number;
}

interface OpenAIToolCallAccumulator {
  id?: string;
  name?: string;
  argumentsText: string;
  raw?: unknown;
}

export class OpenAICompatibleClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly transport: HttpTransport;
  private readonly streamingTransport?: StreamingHttpTransport;
  private readonly requestTimeoutMs?: number;

  constructor(options: OpenAICompatibleClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.transport = options.transport;
    this.streamingTransport = options.streamingTransport;
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  async chat(request: ModelChatRequest): Promise<ModelChatResponse> {
    const model = request.model?.trim() || this.model.trim();
    if (!model) {
      throw new ModelClientError("api", "Model name is required.");
    }

    const httpRequest: HttpRequest = {
      url: getOpenAIChatCompletionsUrl(this.baseUrl),
      method: "POST",
      contentType: "application/json",
      headers: this.buildHeaders(),
      throw: false,
      timeoutMs: this.requestTimeoutMs,
      abortSignal: request.abortSignal,
      body: JSON.stringify(buildOpenAIChatBody(request, model, false)),
    };

    let response;
    try {
      response = await this.transport(httpRequest);
    } catch (error) {
      throw new ModelClientError(
        "network",
        `Network request to OpenAI-compatible API failed: ${getUnknownErrorMessage(error)}`,
        { originalError: error },
      );
    }

    if (response.status >= 400) {
      throw mapOpenAIHttpError(response.status, getResponseBody(response));
    }

    return parseOpenAIChatResponse(getResponseBody(response));
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
    if (!model) {
      throw new ModelClientError("api", "Model name is required.");
    }

    const httpRequest: HttpRequest = {
      url: getOpenAIChatCompletionsUrl(this.baseUrl),
      method: "POST",
      contentType: "application/json",
      headers: this.buildHeaders(),
      throw: false,
      timeoutMs: this.requestTimeoutMs,
      abortSignal: request.abortSignal,
      body: JSON.stringify(buildOpenAIChatBody(request, model, true)),
    };

    let response: StreamingHttpResponse;
    try {
      response = await this.streamingTransport(httpRequest);
    } catch (error) {
      throw new ModelClientError(
        "network",
        `Streaming request to OpenAI-compatible API failed: ${getUnknownErrorMessage(error)}`,
        { originalError: error },
      );
    }

    if (response.status >= 400) {
      throw mapOpenAIHttpError(response.status, await readStreamBody(response.body));
    }

    return parseOpenAIChatStream(response.body, events);
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

export function buildOpenAIChatBody(
  request: ModelChatRequest,
  model: string,
  stream: boolean,
) {
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(request.messages),
    tools: request.tools?.map(toOpenAITool),
    tool_choice: request.tools?.length ? "auto" : undefined,
    response_format: request.format
      ? {
          type: "json_schema",
          json_schema: {
            name: "agentic_researcher_schema",
            schema: request.format,
            strict: true,
          },
        }
      : undefined,
    stream,
  };
  addOpenAIOptions(body, request.options);
  return body;
}

export function toOpenAIMessages(messages: ModelChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? message.toolName ?? "call_unknown",
        content: message.content,
      };
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call, index) => ({
          id: call.id ?? `call_${index}`,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          },
        })),
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
}

export function parseOpenAIChatResponse(body: unknown): ModelChatResponse {
  const message = firstChoiceMessage(body);
  const toolCalls = parseOpenAIToolCalls(message.tool_calls);
  const content = readOpenAIContent(message.content);
  const chatMessage: ModelChatMessage = {
    role: "assistant",
    content,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };

  return {
    message: chatMessage,
    toolCalls,
    doneReason: getFirstChoiceFinishReason(body),
    raw: body,
  };
}

export async function parseOpenAIChatStream(
  stream: AsyncIterable<string>,
  events: ModelChatStreamEvents = {},
): Promise<ModelChatResponse> {
  const chunks: unknown[] = [];
  const toolCallAccumulators = new Map<number, OpenAIToolCallAccumulator>();
  let content = "";
  let doneReason: string | undefined;

  for await (const event of parseSseStream(stream)) {
    if (event === "[DONE]") {
      break;
    }
    const parsed = parseJsonEvent(event, "OpenAI-compatible API returned invalid streaming JSON.");
    chunks.push(parsed);
    if (!isRecord(parsed)) {
      throw new ModelClientError(
        "invalid_response",
        "OpenAI-compatible API returned an invalid streaming chunk.",
        { details: parsed },
      );
    }

    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) {
        continue;
      }
      if (typeof choice.finish_reason === "string") {
        doneReason = choice.finish_reason;
      }
      const delta = isRecord(choice.delta) ? choice.delta : {};
      const text = readOpenAIContent(delta.content);
      if (text) {
        content += text;
        events.onContentDelta?.(text);
      }
      accumulateOpenAIStreamToolCalls(delta.tool_calls, toolCallAccumulators);
    }
  }

  const toolCalls = finalizeOpenAIStreamToolCalls(toolCallAccumulators);
  const message: ModelChatMessage = {
    role: "assistant",
    content,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };

  return {
    message,
    toolCalls,
    doneReason,
    raw: chunks,
  };
}

function toOpenAITool(tool: ModelToolDefinition) {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}

function addOpenAIOptions(
  body: Record<string, unknown>,
  options: ModelRequestOptions | undefined,
) {
  if (!options) {
    return;
  }
  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  if (options.top_p !== undefined) {
    body.top_p = options.top_p;
  }
  if (options.num_ctx !== undefined) {
    body.max_tokens = options.num_ctx;
  }
}

function firstChoiceMessage(body: unknown): Record<string, unknown> {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    throw new ModelClientError(
      "invalid_response",
      "OpenAI-compatible API returned an invalid response body.",
      { details: body },
    );
  }
  const first = body.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new ModelClientError(
      "invalid_response",
      "OpenAI-compatible API response did not include an assistant message.",
      { details: body },
    );
  }
  return first.message;
}

function getFirstChoiceFinishReason(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    return undefined;
  }
  const first = body.choices[0];
  return isRecord(first) && typeof first.finish_reason === "string"
    ? first.finish_reason
    : undefined;
}

function readOpenAIContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (isRecord(part) && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function parseOpenAIToolCalls(toolCalls: unknown): ModelToolCall[] {
  if (toolCalls === undefined || toolCalls === null) {
    return [];
  }
  if (!Array.isArray(toolCalls)) {
    throw new ModelClientError(
      "invalid_response",
      "OpenAI-compatible API returned tool_calls in an unexpected format.",
      { details: toolCalls },
    );
  }
  return toolCalls.map((toolCall, index) => {
    if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
      throw new ModelClientError(
        "invalid_response",
        "OpenAI-compatible API returned an invalid tool call.",
        { details: toolCall },
      );
    }
    const fn = toolCall.function;
    if (typeof fn.name !== "string" || !fn.name) {
      throw new ModelClientError(
        "invalid_response",
        "OpenAI-compatible API returned a tool call without a function name.",
        { details: toolCall },
      );
    }
    return {
      id: typeof toolCall.id === "string" ? toolCall.id : `call_${index}`,
      name: fn.name,
      arguments: parseToolArguments(fn.arguments),
      index,
      raw: toolCall,
    };
  });
}

function accumulateOpenAIStreamToolCalls(
  rawToolCalls: unknown,
  accumulators: Map<number, OpenAIToolCallAccumulator>,
) {
  if (!Array.isArray(rawToolCalls)) {
    return;
  }
  for (const item of rawToolCalls) {
    if (!isRecord(item)) {
      continue;
    }
    const index = typeof item.index === "number" ? item.index : accumulators.size;
    const existing =
      accumulators.get(index) ?? { argumentsText: "", raw: item };
    if (typeof item.id === "string") {
      existing.id = item.id;
    }
    if (isRecord(item.function)) {
      if (typeof item.function.name === "string") {
        existing.name = item.function.name;
      }
      if (typeof item.function.arguments === "string") {
        existing.argumentsText += item.function.arguments;
      }
    }
    existing.raw = item;
    accumulators.set(index, existing);
  }
}

function finalizeOpenAIStreamToolCalls(
  accumulators: Map<number, OpenAIToolCallAccumulator>,
): ModelToolCall[] {
  return [...accumulators.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, item]) => {
      if (!item.name) {
        throw new ModelClientError(
          "invalid_response",
          "OpenAI-compatible streaming tool call did not include a function name.",
          { details: item },
        );
      }
      return {
        id: item.id ?? `call_${index}`,
        name: item.name,
        arguments: parseToolArguments(item.argumentsText),
        index,
        raw: item.raw,
      };
    });
}

async function* parseSseStream(stream: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    let separator = findSseSeparator(buffer);
    while (separator) {
      const { index, length } = separator;
      const rawEvent = buffer.slice(0, index);
      buffer = buffer.slice(index + length);
      const data = parseSseData(rawEvent);
      if (data) {
        yield data;
      }
      separator = findSseSeparator(buffer);
    }
  }
  const data = parseSseData(buffer);
  if (data) {
    yield data;
  }
}

function findSseSeparator(buffer: string): { index: number; length: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf < 0 && lf < 0) {
    return null;
  }
  if (crlf >= 0 && (lf < 0 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

function parseSseData(rawEvent: string): string {
  return rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
}

function parseJsonEvent(event: string, message: string): unknown {
  try {
    return JSON.parse(event);
  } catch (error) {
    throw new ModelClientError("invalid_response", message, {
      details: event,
      originalError: error,
    });
  }
}

function parseToolArguments(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null || args === "") {
    return {};
  }
  if (isRecord(args)) {
    return args;
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Report below.
    }
  }
  throw new ModelClientError(
    "invalid_response",
    "OpenAI-compatible API returned tool arguments in an unexpected format.",
    { details: args },
  );
}

function getOpenAIChatCompletionsUrl(baseUrl: string): string {
  return `${normalizeOpenAIBaseUrl(baseUrl)}/chat/completions`;
}

export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new ModelClientError("api", "OpenAI-compatible base URL is required.");
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ModelClientError(
      "api",
      "OpenAI-compatible base URL must start with http:// or https://.",
    );
  }
  return trimmed;
}

function mapOpenAIHttpError(status: number, body: unknown): ModelClientError {
  const detail = getErrorDetail(body);
  if (status === 401 || status === 403) {
    return new ModelClientError(
      "auth",
      detail || "OpenAI-compatible API rejected the request. Check the API key.",
      { status, details: body },
    );
  }
  if (status === 429) {
    return new ModelClientError(
      "rate_limit",
      detail || "OpenAI-compatible API rate limit reached. Try again later.",
      { status, details: body },
    );
  }
  return new ModelClientError(
    "api",
    detail || `OpenAI-compatible API request failed with status ${status}.`,
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
  const error = body.error;
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (typeof body.message === "string") {
    return body.message;
  }
  return null;
}

function getUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
