import test from "node:test";
import assert from "node:assert/strict";
import type { ModelChatRequest, ModelChatResponse } from "../src/model/types";
import { probeToolCallBehavior } from "../src/model/toolCallBehavioralProbe";

function response(partial: Partial<ModelChatResponse["message"]>, toolCalls: ModelChatResponse["toolCalls"] = []): ModelChatResponse {
  return {
    message: { role: "assistant", content: "", ...partial },
    toolCalls,
  } as ModelChatResponse;
}

test("native structured tool call classifies as native_tool_call", async () => {
  const result = await probeToolCallBehavior(async (request: ModelChatRequest) => {
    assert.equal(request.toolChoice, "required");
    assert.equal(request.tools?.[0]?.function.name, "probe_echo");
    return response({}, [
      { name: "probe_echo", arguments: { value: "ready" }, index: 0, raw: {} },
    ]);
  });
  assert.equal(result.outcome, "native_tool_call");
});

test("text-form tool call classifies as recovered_text_call", async () => {
  const result = await probeToolCallBehavior(async () =>
    response({
      content:
        '<tool_call>{"name":"probe_echo","arguments":{"value":"ready"}}</tool_call>',
    }),
  );
  assert.equal(result.outcome, "recovered_text_call");
});

test("prose-only and request failure classify as no_call", async () => {
  const prose = await probeToolCallBehavior(async () =>
    response({ content: "I would call the tool if I could." }),
  );
  assert.equal(prose.outcome, "no_call");
  const failed = await probeToolCallBehavior(async () => {
    throw new Error("boom");
  });
  assert.equal(failed.outcome, "no_call");
  assert.match(failed.detail, /boom/u);
});

test("a provider that ignores abort still resolves at the probe timeout", async () => {
  const startedAt = Date.now();
  const result = await probeToolCallBehavior(
    async () => new Promise<ModelChatResponse>(() => undefined),
    { timeoutMs: 5 },
  );
  assert.equal(result.outcome, "no_call");
  assert.match(result.detail, /timed out after 5ms/u);
  assert.ok(Date.now() - startedAt < 1_000);
});
