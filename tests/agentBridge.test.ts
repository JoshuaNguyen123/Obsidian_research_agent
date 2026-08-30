import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";

import {
  createAgentBridgeServer,
  type AgentBackend,
} from "../scripts/agent-bridge.mjs";
import { OpenAICompatibleClient } from "../src/model/OpenAICompatibleClient";
import { withModelRetry } from "../src/model/retry";
import type { HttpRequest, HttpResponse } from "../src/model/types";

const TOKEN = "ephemeral-test-token-123456789";

async function withBridge(
  backend: AgentBackend,
  run: (baseUrl: string) => Promise<void>,
  options: { requestTimeoutMs?: number; logger?: (event: Record<string, unknown>) => void } = {},
) {
  const server = createAgentBridgeServer({ token: TOKEN, backend, ...options });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

function request(baseUrl: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    body: JSON.stringify(body),
    ...init,
  });
}

test("bridge requires bearer authentication before the backend can observe a request", async () => {
  let calls = 0;
  await withBridge({
    complete: async () => {
      calls += 1;
      return { content: "unreachable" };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  });
});

test("non-streaming requests preserve model fields and return stable parallel tool-call ids", async () => {
  const observed: Array<Record<string, unknown>> = [];
  const backend: AgentBackend = {
    complete: async (body) => {
      observed.push(structuredClone(body));
      return {
        content: "",
        toolCalls: [
          { name: "read_file", arguments: { path: "A.md" } },
          { name: "count_words", arguments: { path: "B.md" } },
        ],
      };
    },
  };
  await withBridge(backend, async (baseUrl) => {
    const body = {
      model: "external-agent",
      messages: [{ role: "user", content: "Use both tools." }],
      tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      tool_choice: "required",
      response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" } } },
      temperature: 0.2,
      stream: false,
    };
    const first = await (await request(baseUrl, body)).json() as any;
    const second = await (await request(baseUrl, body)).json() as any;
    const firstCalls = first.choices[0].message.tool_calls;
    const secondCalls = second.choices[0].message.tool_calls;
    assert.equal(firstCalls.length, 2);
    assert.deepEqual(firstCalls.map((call: any) => call.id), secondCalls.map((call: any) => call.id));
    assert.notEqual(firstCalls[0].id, firstCalls[1].id);
    assert.equal(firstCalls[0].function.name, "read_file");
    assert.equal(observed[0]?.tool_choice, "required");
    assert.deepEqual(observed[0]?.response_format, body.response_format);
    assert.equal(observed[0]?.temperature, 0.2);
  });
});

test("SSE streams content, tool calls, finish reason, and DONE through backpressure-aware writes", async () => {
  const backend: AgentBackend = {
    complete: async () => ({ content: "unused" }),
    stream: async function* () {
      for (let index = 0; index < 80; index += 1) {
        yield { content: `${index}:`.padEnd(2048, "x") };
      }
      yield { toolCalls: [{ name: "read_file", arguments: { path: "Note.md" } }] };
      yield { finishReason: "tool_calls" };
    },
  };
  await withBridge(backend, async (baseUrl) => {
    const response = await request(baseUrl, { model: "agent", messages: [], stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
    const text = await response.text();
    assert.match(text, /"content":"0:/u);
    assert.match(text, /"name":"read_file"/u);
    assert.match(text, /"finish_reason":"tool_calls"/u);
    assert.match(text, /data: \[DONE\]/u);
  });
});

test("malformed backend responses and invalid JSON return secret-free diagnostics", async () => {
  const diagnostics: Array<Record<string, unknown>> = [];
  const secret = "vault-note-secret-that-must-not-escape";
  await withBridge({
    complete: async () => ({ content: 42 } as never),
  }, async (baseUrl) => {
    const malformed = await request(baseUrl, {
      messages: [{ role: "user", content: secret }],
    });
    assert.equal(malformed.status, 502);
    const responseText = await malformed.text();
    assert.doesNotMatch(responseText, new RegExp(secret, "u"));

    const invalid = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "{not-json",
    });
    assert.equal(invalid.status, 400);
    assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(secret, "u"));
    assert.ok(diagnostics.every((event) => !("messages" in event) && !("body" in event)));
  }, { logger: (event) => diagnostics.push(event) });
});

test("timeout aborts the backend and returns a bounded sanitized failure", async () => {
  let aborted = false;
  await withBridge({
    complete: async (_body, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("backend-secret-detail"));
      }, { once: true });
    }),
  }, async (baseUrl) => {
    const response = await request(baseUrl, { messages: [] });
    assert.equal(response.status, 504);
    assert.equal(aborted, true);
    assert.doesNotMatch(await response.text(), /backend-secret-detail/u);
  }, { requestTimeoutMs: 20 });
});

test("production OpenAI-compatible client recovers from one loopback 504 in 3 of 3 attempts", async () => {
  const callsByMarker = new Map<string, number>();
  await withBridge({
    complete: async (body) => {
      const marker = JSON.stringify(body).match(/OFFLINE_RETRY_[A-Z0-9_]+/u)?.[0];
      assert.ok(marker);
      const calls = (callsByMarker.get(marker) ?? 0) + 1;
      callsByMarker.set(marker, calls);
      if (calls === 1) {
        throw Object.assign(new Error("Injected loopback timeout."), {
          bridgeCode: "timeout",
          status: 504,
        });
      }
      return { content: marker };
    },
  }, async (baseUrl) => {
    const transport = createLoopbackFetchTransport(baseUrl);
    const client = new OpenAICompatibleClient({
      baseUrl: `${baseUrl}/v1`,
      apiKey: TOKEN,
      model: "offline-scripted-v1",
      transport,
      requestTimeoutMs: 5_000,
    });
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const marker = `OFFLINE_RETRY_${repetition}`;
      let retries = 0;
      const response = await withModelRetry(
        () => client.chat({
          messages: [{ role: "user", content: marker }],
        }),
        {
          policy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
          onRetry: () => {
            retries += 1;
          },
        },
      );
      assert.equal(response.message.content, marker);
      assert.equal(callsByMarker.get(marker), 2);
      assert.equal(retries, 1);
    }
  });
});

test("client cancellation reaches the backend AbortSignal", async () => {
  let aborted = false;
  await withBridge({
    complete: async (_body, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("cancelled"));
      }, { once: true });
    }),
  }, async (baseUrl) => {
    const controller = new AbortController();
    const pending = request(baseUrl, { messages: [] }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, /abort/iu);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(aborted, true);
  });
});

function createLoopbackFetchTransport(baseUrl: string) {
  return async (input: HttpRequest): Promise<HttpResponse> => {
    assert.ok(input.url.startsWith(`${baseUrl}/`));
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: typeof input.body === "string" ? input.body : undefined,
      signal: input.abortSignal,
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return {
      status: response.status,
      headers,
      text,
      ...(json === undefined ? {} : { json }),
    };
  };
}
