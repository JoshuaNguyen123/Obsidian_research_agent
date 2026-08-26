import assert from "node:assert/strict";
import test from "node:test";
import {
  compactLoopMessages,
  measurePromptPrefixReuseV1,
} from "../src/agent/runContext";
import type { ModelChatMessage } from "../src/model/types";
import type { MissionLedger } from "../src/agent/missionLedger";

const system = (content: string): ModelChatMessage => ({ role: "system", content });
const user = (content: string): ModelChatMessage => ({ role: "user", content });
const assistant = (content: string): ModelChatMessage => ({
  role: "assistant",
  content,
});
const tool = (content: string): ModelChatMessage => ({ role: "tool", content });

test("appending a turn leaves the whole earlier prompt byte-identical", () => {
  const before = [system("SYSTEM"), user("do the thing")];
  const after = [...before, assistant("working"), tool("{}")];

  const reuse = measurePromptPrefixReuseV1(before, after);

  assert.equal(reuse.stableChars, "SYSTEM".length + "do the thing".length);
  assert.equal(reuse.firstDivergentIndex, 2);
  // This is the shape a provider with automatic prefix caching rewards, and it
  // is what the loop does on every ordinary step.
  assert.ok(reuse.reuseRatio > 0.5);
});

test("one changed character at the top costs the entire prefix", () => {
  const before = [system("SYSTEM v1"), user("prompt"), assistant("reply")];
  const after = [system("SYSTEM v2"), user("prompt"), assistant("reply")];

  const reuse = measurePromptPrefixReuseV1(before, after);

  assert.equal(reuse.stableChars, 0);
  assert.equal(reuse.firstDivergentIndex, 0);
  // Nothing after a divergence can be reused, however identical it is.
  assert.equal(reuse.reuseRatio, 0);
});

test("compaction shortens the cacheable prefix mid-run", () => {
  // A long loop: a stable system prefix, then many oversized tool turns.
  const messages: ModelChatMessage[] = [system("SYSTEM PROMPT")];
  for (let index = 0; index < 12; index += 1) {
    messages.push(assistant(`step ${index}`));
    messages.push(tool(JSON.stringify({ ok: true, filler: "x".repeat(4000) })));
  }

  const ledger = {
    runId: "run-1",
    steps: [],
    evidence: [],
score: undefined,
  } as unknown as MissionLedger;

  const compacted = compactLoopMessages({
    messages,
    ledger,
    keepRecentSteps: 2,
    maxPromptChars: 8_000,
  });
  assert.equal(compacted.applied, true);

  const reuse = measurePromptPrefixReuseV1(messages, compacted.messages);

  // Measured, not assumed. Compaction took the payload-first path: it kept all
  // 25 messages and rewrote oversized tool bodies in place. But it rewrites the
  // OLDEST tool payload first, which is the worst possible order for a provider
  // that matches on an exact byte prefix -- divergence lands at index 2 and
  // roughly 95% of the prompt becomes uncacheable.
  assert.equal(compacted.messages.length, messages.length);
  assert.equal(compacted.messages[0]?.content, 'SYSTEM PROMPT');
  assert.equal(reuse.firstDivergentIndex, 2);
  assert.ok(reuse.reuseRatio < 0.1);

  // The tension this pins, for whoever picks up prefix caching: shrinking
  // oldest-first is right for relevance (recent detail is worth more) and wrong
  // for cache reuse (the prefix is what gets reused). Flipping it is a real
  // trade-off, not an oversight, so this test documents the cost rather than
  // asserting a preferred direction.
});
