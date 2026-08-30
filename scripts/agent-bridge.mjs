import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export function createAgentBridgeServer({
  token,
  backend,
  logger = () => undefined,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("Agent bridge requires an ephemeral bearer token of at least 16 characters.");
  }
  if (!backend || typeof backend.complete !== "function") {
    throw new Error("Agent bridge requires an AgentBackend.complete adapter.");
  }

  return createServer(async (request, response) => {
    const requestId = createRequestId();
    response.setHeader("x-agent-bridge-request-id", requestId);
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      return sendJson(response, 404, errorBody("not_found", "Route not found."));
    }
    if (!authorized(request.headers.authorization, token)) {
      logger({ event: "request_rejected", requestId, code: "unauthorized" });
      return sendJson(response, 401, errorBody("unauthorized", "Bearer authentication is required."));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), requestTimeoutMs);
    const abortOnClose = () => controller.abort("client_disconnected");
    request.once("aborted", abortOnClose);
    response.once("close", () => {
      if (!response.writableEnded) abortOnClose();
    });

    try {
      const body = await readJsonBody(request, controller.signal);
      validateChatRequest(body);
      logger({
        event: "request_started",
        requestId,
        streaming: body.stream === true,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        structuredOutput: Boolean(body.response_format),
      });

      if (body.stream === true) {
        await streamCompletion({ response, backend, body, requestId, signal: controller.signal });
      } else {
        const result = normalizeAssistantResult(
          await backend.complete(body, { signal: controller.signal, requestId }),
        );
        sendJson(response, 200, openAIResponse(result, requestId, body.model));
      }
      logger({ event: "request_completed", requestId });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const code = aborted
        ? controller.signal.reason === "timeout" ? "timeout" : "cancelled"
        : bridgeErrorCode(error);
      logger({ event: "request_failed", requestId, code });
      if (!response.headersSent) {
        sendJson(
          response,
          aborted ? (code === "timeout" ? 504 : 499) : bridgeErrorStatus(error),
          errorBody(code, safeErrorMessage(error, aborted)),
        );
      } else if (!response.writableEnded) {
        response.end();
      }
    } finally {
      clearTimeout(timeout);
      request.off("aborted", abortOnClose);
    }
  });
}

export function normalizeAssistantResult(value) {
  if (!value || typeof value !== "object") {
    throw bridgeError("malformed_backend_response", "Agent backend returned an invalid response.", 502);
  }
  const content = value.content == null ? "" : value.content;
  if (typeof content !== "string") {
    throw bridgeError("malformed_backend_response", "Agent backend returned invalid assistant content.", 502);
  }
  const rawCalls = value.toolCalls ?? value.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) {
    throw bridgeError("malformed_backend_response", "Agent backend returned invalid tool calls.", 502);
  }
  const toolCalls = rawCalls.map((call, index) => normalizeToolCall(call, index));
  return {
    content,
    toolCalls,
    finishReason: typeof value.finishReason === "string"
      ? value.finishReason
      : toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

async function streamCompletion({ response, backend, body, requestId, signal }) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const source = typeof backend.stream === "function"
    ? backend.stream(body, { signal, requestId })
    : singleResultStream(await backend.complete(body, { signal, requestId }));
  let index = 0;
  for await (const event of source) {
    if (signal.aborted) throw new Error("Request aborted.");
    const normalized = normalizeStreamEvent(event, index++);
    await writeWithBackpressure(
      response,
      `data: ${JSON.stringify(openAIStreamChunk(normalized, requestId, body.model))}\n\n`,
      signal,
    );
  }
  await writeWithBackpressure(response, "data: [DONE]\n\n", signal);
  response.end();
}

async function* singleResultStream(result) {
  const normalized = normalizeAssistantResult(result);
  if (normalized.content) yield { content: normalized.content };
  if (normalized.toolCalls.length) yield { toolCalls: normalized.toolCalls };
  yield { finishReason: normalized.finishReason };
}

function normalizeStreamEvent(value, eventIndex) {
  if (!value || typeof value !== "object") {
    throw bridgeError("malformed_backend_response", "Agent backend returned an invalid stream event.", 502);
  }
  const content = value.content ?? value.contentDelta ?? "";
  if (typeof content !== "string") {
    throw bridgeError("malformed_backend_response", "Agent backend returned invalid stream content.", 502);
  }
  const rawCalls = value.toolCalls ?? value.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) {
    throw bridgeError("malformed_backend_response", "Agent backend returned invalid stream tool calls.", 502);
  }
  return {
    content,
    toolCalls: rawCalls.map((call, index) => normalizeToolCall(call, eventIndex * 1000 + index)),
    finishReason: typeof value.finishReason === "string" ? value.finishReason : null,
  };
}

function normalizeToolCall(call, index) {
  if (!call || typeof call !== "object") {
    throw bridgeError("malformed_backend_response", "Agent backend returned an invalid tool call.", 502);
  }
  const fn = call.function && typeof call.function === "object" ? call.function : null;
  const name = call.name ?? fn?.name;
  const rawArguments = call.arguments ?? fn?.arguments ?? {};
  if (typeof name !== "string" || !name.trim()) {
    throw bridgeError("malformed_backend_response", "Agent backend tool call has no name.", 502);
  }
  let argumentsText;
  if (typeof rawArguments === "string") {
    try {
      JSON.parse(rawArguments);
    } catch {
      throw bridgeError("malformed_backend_response", "Agent backend tool arguments are not valid JSON.", 502);
    }
    argumentsText = rawArguments;
  } else {
    argumentsText = JSON.stringify(rawArguments);
  }
  const id = typeof call.id === "string" && call.id.trim()
    ? call.id
    : stableToolCallId(name, argumentsText, index);
  return { id, name, argumentsText, index };
}

function openAIResponse(result, requestId, model) {
  return {
    id: `chatcmpl_${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof model === "string" ? model : "agent-backend",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: result.content || null,
        ...(result.toolCalls.length
          ? { tool_calls: result.toolCalls.map(toOpenAIToolCall) }
          : {}),
      },
      finish_reason: result.finishReason,
    }],
  };
}

function openAIStreamChunk(event, requestId, model) {
  return {
    id: `chatcmpl_${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: typeof model === "string" ? model : "agent-backend",
    choices: [{
      index: 0,
      delta: {
        ...(event.content ? { content: event.content } : {}),
        ...(event.toolCalls.length
          ? { tool_calls: event.toolCalls.map((call) => ({
              index: call.index,
              ...toOpenAIToolCall(call),
            })) }
          : {}),
      },
      finish_reason: event.finishReason,
    }],
  };
}

function toOpenAIToolCall(call) {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.argumentsText },
  };
}

function validateChatRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw bridgeError("invalid_request", "Request body must be a JSON object.", 400);
  }
  if (!Array.isArray(body.messages)) {
    throw bridgeError("invalid_request", "messages must be an array.", 400);
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw bridgeError("invalid_request", "tools must be an array when provided.", 400);
  }
}

async function readJsonBody(request, signal) {
  let text = "";
  for await (const chunk of request) {
    if (signal.aborted) throw new Error("Request aborted.");
    text += chunk;
    if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) {
      throw bridgeError("request_too_large", "Request body exceeds the bridge limit.", 413);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw bridgeError("invalid_json", "Request body is not valid JSON.", 400);
  }
}

async function writeWithBackpressure(response, chunk, signal) {
  if (response.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const onDrain = () => finish(resolve);
    const onAbort = () => finish(() => reject(new Error("Request aborted.")));
    const finish = (next) => {
      response.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
      typeof next === "function" ? next() : undefined;
    };
    response.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function authorized(header, token) {
  const supplied = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function stableToolCallId(name, argumentsText, index) {
  return `call_${createHash("sha256")
    .update(`${index}\0${name}\0${argumentsText}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function createRequestId() {
  return createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 24);
}

function bridgeError(code, message, status) {
  const error = new Error(message);
  error.bridgeCode = code;
  error.status = status;
  return error;
}

function bridgeErrorCode(error) {
  return typeof error?.bridgeCode === "string" ? error.bridgeCode : "backend_failure";
}

function bridgeErrorStatus(error) {
  return Number.isSafeInteger(error?.status) ? error.status : 502;
}

function safeErrorMessage(error, aborted) {
  if (aborted) return "The agent backend request did not complete.";
  return typeof error?.bridgeCode === "string"
    ? error.message
    : "The agent backend request failed.";
}

function errorBody(code, message) {
  return { error: { type: "agent_bridge_error", code, message } };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export async function startAgentBridgeFromEnvironment(env = process.env) {
  const token = env.AGENT_BRIDGE_TOKEN?.trim() ?? "";
  const modulePath = env.AGENT_BRIDGE_BACKEND_MODULE?.trim() ?? "";
  if (!modulePath) throw new Error("Set AGENT_BRIDGE_BACKEND_MODULE to an AgentBackend adapter module.");
  const imported = await import(pathToFileURL(path.resolve(modulePath)).href);
  const backend = typeof imported.createAgentBackend === "function"
    ? await imported.createAgentBackend({ env })
    : imported.default;
  const server = createAgentBridgeServer({ token, backend });
  const port = Number.parseInt(env.AGENT_BRIDGE_PORT ?? "7331", 10);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`Agent bridge listening at http://127.0.0.1:${actualPort}/v1 (request bodies are not logged).\n`);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startAgentBridgeFromEnvironment().catch((error) => {
    process.stderr.write(`Agent bridge failed to start: ${safeErrorMessage(error, false)}\n`);
    process.exitCode = 1;
  });
}
