import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  degenerateStreamVerdictFromError,
  formatDegenerateStreamMessage,
  retryRequestAfterDegenerateStreamV1,
} from "../src/model/degenerateStreamGuard";
import { ModelClientError } from "../src/model/types";
import type { ModelChatRequest } from "../src/model/types";

/**
 * Reliability cohort 12 (2026-09-07, compound-linear-github#003): the final
 * synthesis collapsed into repeating "\\nak" after thirty minutes, the client
 * retried the IDENTICAL request 750 ms later, and that reply collapsed into
 * ".3" within seconds. The retry after a degenerate verdict must be a
 * different request.
 */

const VERDICT = { unit: ".3", windowChars: 3000 };

function baseRequest(): ModelChatRequest {
  return {
    messages: [
      { role: "system", content: "You are the finalizer." },
      { role: "user", content: "Write the note reflection." },
      { role: "tool", content: '{"receipt":"r1"}' },
    ],
    tools: [{ type: "function", function: { name: "read_current_file", parameters: {} } }] as never,
    think: "medium",
    options: { temperature: 0.4, num_ctx: 65_536 },
    evidencePhase: "agent_step",
  } as ModelChatRequest;
}

test("the verdict is read structurally from the thrown error, and only from a degenerate one", () => {
  const thrown = new ModelClientError("invalid_response", formatDegenerateStreamMessage(VERDICT), {
    details: { unit: VERDICT.unit, windowChars: VERDICT.windowChars },
  });
  assert.deepEqual(degenerateStreamVerdictFromError(thrown), VERDICT);
  // The bundle can hold two copies of the class; a duck-typed error still reads.
  assert.deepEqual(
    degenerateStreamVerdictFromError({ name: "ModelClientError", category: "invalid_response", details: VERDICT }),
    VERDICT,
  );
  // POSITIVE PROOF the reader discriminates: other invalid responses, other
  // categories, and malformed details are not verdicts.
  assert.equal(degenerateStreamVerdictFromError(new ModelClientError("invalid_response", "Provider returned malformed JSON.")), null);
  assert.equal(degenerateStreamVerdictFromError(new ModelClientError("network", "socket hang up", { details: VERDICT })), null);
  assert.equal(degenerateStreamVerdictFromError({ name: "ModelClientError", category: "invalid_response", details: { unit: "" } }), null);
  assert.equal(degenerateStreamVerdictFromError(new Error("degenerate stream")), null);
  assert.equal(degenerateStreamVerdictFromError(null), null);
});

test("the retry request differs in every way the provider can see and leaves the original untouched", () => {
  const original = baseRequest();
  const snapshot = JSON.stringify(original);
  const retry = retryRequestAfterDegenerateStreamV1(original, VERDICT, 12345);

  assert.equal(JSON.stringify(original), snapshot, "the failed request object is not mutated");
  assert.equal(retry.messages.length, original.messages.length + 1);
  const nudge = retry.messages[retry.messages.length - 1]!;
  assert.equal(nudge.role, "system");
  assert.match(nudge.content, /collapsed into repeating ".3"/u);
  assert.match(nudge.content, /3000 characters/u);
  assert.match(nudge.content, /without repeated lines/u);
  assert.deepEqual(retry.messages.slice(0, -1), original.messages, "the conversation itself is preserved");
  assert.equal(retry.think, undefined, "thinking is off on the retry");
  assert.deepEqual(retry.options, { temperature: 0.4, num_ctx: 65_536, repeat_penalty: 1.15, seed: 12345 });
  assert.equal(retry.evidencePhase, "retry");
  assert.deepEqual(retry.tools, original.tools, "tools are preserved so the step can still act");

  // A long unit is shown truncated, never dumped whole into the prompt.
  const long = retryRequestAfterDegenerateStreamV1(original, { unit: "let me look at this ", windowChars: 3000 }, 1);
  assert.match(long.messages[long.messages.length - 1]!.content, /"let me look at t…"/u);

  // Without an explicit seed each retry is a different draw.
  const a = retryRequestAfterDegenerateStreamV1(original, VERDICT);
  const b = retryRequestAfterDegenerateStreamV1(original, VERDICT);
  assert.ok(Number.isInteger(a.options?.seed) && Number.isInteger(b.options?.seed));
});

test("both agent-step wrappers send the rewritten request on the retry, not the failed one", async () => {
  const source = await readFile(path.join(__dirname, "..", "src", "AgentRunner.ts"), "utf8");
  const streaming = source.indexOf("async function streamChatWithThinkingFallback");
  const nonStreaming = source.indexOf("async function chatForAgentStep(");
  assert.ok(streaming > 0 && nonStreaming > 0);
  for (const [label, start] of [["streaming", streaming], ["non-streaming", nonStreaming]] as const) {
    const body = source.slice(start, start + 4_000);
    assert.match(body, /let attemptRequest = request;/u, `${label}: a per-attempt request binding`);
    assert.match(body, /modelClient\.(streamChat|chat)\(attemptRequest/u, `${label}: the attempt sends the binding`);
    assert.match(body, /attemptRequest = retryRequestAfterDegenerateStreamV1\(request, verdict\)/u, `${label}: the hook rewrites it on a degenerate verdict`);
  }
});
