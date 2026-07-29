import assert from "node:assert/strict";
import test from "node:test";

import {
  CRITIC_ALLOWED_TOOLS,
  createCriticRegistry,
  runCriticWorker,
} from "../src/orchestrator/criticWorker";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelClient,
  ModelToolDefinition,
} from "../src/model/types";
import type { ModelCallEvidenceV1 } from "../src/model/modelCallEvidence";
import type { MissionEvidence } from "../src/agent/missionLedger";
import type { ToolExecutionContext, ToolRegistry } from "../src/tools/types";

function modelClient(
  turns: Array<(request: ModelChatRequest) => ModelChatResponse>,
): ModelClient & { requests: ModelChatRequest[] } {
  const requests: ModelChatRequest[] = [];
  return {
    requests,
    async chat(request) {
      requests.push(request);
      const turn = turns[Math.min(requests.length - 1, turns.length - 1)]!;
      return turn(request);
    },
    async streamChat(request) {
      return this.chat(request);
    },
  };
}

function reply(content: string, toolCalls: ModelChatResponse["toolCalls"] = []): ModelChatResponse {
  return { message: { role: "assistant", content }, toolCalls };
}

function fakeRegistry(): ToolRegistry & { executed: string[] } {
  const executed: string[] = [];
  const definitions: ModelToolDefinition[] = [
    ...[...CRITIC_ALLOWED_TOOLS].map((name) => ({
      type: "function" as const,
      function: { name, description: name, parameters: { type: "object" as const, properties: {} } },
    })),
    {
      type: "function" as const,
      function: {
        name: "replace_file",
        description: "a write tool that must never be offered",
        parameters: { type: "object" as const, properties: {} },
      },
    },
  ];
  return {
    executed,
    getDefinitions: () => definitions,
    async execute(call) {
      executed.push(call.name);
      return { ok: true, toolName: call.name, output: { checked: true } };
    },
  };
}

const context = {
  settings: { requestTimeoutMs: 30_000 },
  reportProgress: () => {},
} as unknown as ToolExecutionContext;

const evidence: MissionEvidence[] = [
  {
    id: "web:1",
    kind: "web_source",
    title: "Primary source",
    url: "https://example.com/paper",
    sourceId: "src-1",
    summary: "The main source backing the result.",
    confidence: "high",
  },
];

test("critic seeds only objective, final output, evidence, and receipts — never a Lead transcript", async () => {
  const client = modelClient([
    () => reply('{"verdict":"pass","missing":[],"summary":"Result is grounded."}'),
  ]);
  const modelEvidence: ModelCallEvidenceV1[] = [];
  const result = await runCriticWorker({
    runId: "run-1",
    objective: "Summarize the topic with sources.",
    finalOutput: "The topic is summarized with citations.",
    evidence,
    receiptIds: ["note_create:create:Research/topic.md"],
    modelClient: client,
    toolRegistry: fakeRegistry(),
    toolContext: context,
    onModelCallEvidence: (event) => modelEvidence.push(event),
  });
  assert.equal(modelEvidence.length, 1);
  assert.equal(modelEvidence[0]?.phase, "worker");
  assert.equal(modelEvidence[0]?.clientInvoked, true);
  assert.equal(result.status, "pass");
  assert.equal(result.check.kind, "critic");
  const seeded = JSON.stringify(client.requests[0]!.messages);
  assert.match(seeded, /Summarize the topic with sources/u);
  assert.match(seeded, /The topic is summarized/u);
  assert.match(seeded, /Primary source/u);
  assert.doesNotMatch(seeded, /Lead reasoning|transcript/u);
  // Only the read-only critic subset is offered to the model.
  const offered = client.requests[0]!.tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(offered.every((name) => CRITIC_ALLOWED_TOOLS.has(name)), offered.join(","));
  assert.ok(!offered.includes("replace_file"));
});

test("critic can spot-check with read tools and then deliver a needs_more_work verdict", async () => {
  const registry = fakeRegistry();
  const client = modelClient([
    () =>
      reply("", [
        { id: "call-1", name: "verify_citation", arguments: { quote: "a".repeat(20), url: "https://x" } },
      ]),
    () =>
      reply(
        'Checked. {"verdict":"needs_more_work","missing":["The second claim cites nothing"],"summary":"One claim unsupported."}',
      ),
  ]);
  const result = await runCriticWorker({
    runId: "run-2",
    objective: "objective",
    finalOutput: "final output",
    evidence,
    receiptIds: [],
    modelClient: client,
    toolRegistry: registry,
    toolContext: context,
  });
  assert.equal(result.status, "needs_more_work");
  assert.deepEqual(result.check.missing, ["The second claim cites nothing"]);
  assert.deepEqual(registry.executed, ["verify_citation"]);
  assert.equal(result.toolCalls, 1);
});

test("write tool calls are structurally rejected by the critic registry", async () => {
  const registry = fakeRegistry();
  const critic = createCriticRegistry(registry);
  const blocked = await critic.execute(
    { id: "call-1", name: "replace_file", arguments: {} },
    context,
  );
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.error?.code, "critic_policy_blocked");
  }
  assert.deepEqual(registry.executed, [], "the underlying registry must never run it");
  // Allowed reads pass through with write authority stripped.
  const allowed = await critic.execute(
    { id: "call-2", name: "read_file", arguments: { path: "a.md" } },
    { ...context, writeAutonomy: true, userApprovalGranted: true } as never,
  );
  assert.equal(allowed.ok, true);
});

test("an unparseable verdict degrades to advisory pass and a throwing model blocks", async () => {
  const vague = await runCriticWorker({
    runId: "run-3",
    objective: "objective",
    finalOutput: "final output",
    evidence: [],
    receiptIds: [],
    modelClient: modelClient([() => reply("Looks fine to me, generally speaking.")]),
    toolRegistry: fakeRegistry(),
    toolContext: context,
  });
  assert.equal(vague.status, "pass");
  assert.match(vague.check.message, /advisory pass/u);

  const throwing = await runCriticWorker({
    runId: "run-4",
    objective: "objective",
    finalOutput: "final output",
    evidence: [],
    receiptIds: [],
    modelClient: {
      async chat() {
        throw new Error("model offline");
      },
      async streamChat() {
        throw new Error("model offline");
      },
    },
    toolRegistry: fakeRegistry(),
    toolContext: context,
  });
  assert.equal(throwing.status, "blocked");
  assert.match(throwing.check.message, /model offline/u);
});
