import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelClient,
  ModelToolCall,
} from "../src/model/types";
import {
  createReadOnlyWorkerRegistry,
  runResearchWorker,
} from "../src/orchestrator/researchWorker";
import type {
  ToolExecutionContext,
  ToolRegistry,
} from "../src/tools/types";

test("research worker leases and deduplicates source candidates before fetch", async () => {
  const url = "https://example.com/primary";
  const model = sequenceModel([
    toolResponse("web_search", { query: "primary evidence" }),
    toolResponse("web_fetch", { url }),
    toolResponse("web_fetch", { url }),
    finalResponse("Primary evidence was fetched and passed to the Lead."),
  ]);
  const executed: string[] = [];
  const registry: ToolRegistry = {
    getDefinitions: () => ["web_search", "web_fetch"].map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" } },
    })),
    async execute(call) {
      executed.push(call.name);
      if (call.name === "web_search") {
        return {
          ok: true,
          toolName: call.name,
          output: { results: [{ title: "Primary source", url, snippet: "Result" }] },
        };
      }
      return {
        ok: true,
        toolName: call.name,
        output: {
          title: "Primary source",
          url,
          content:
            "This primary source provides a detailed, passage-backed explanation of the researched claim, including enough specific context for verification and citation by the Lead agent.",
          parserStatus: "parsed",
        },
      };
    },
  };

  const result = await runResearchWorker({
    runId: "run-ledger",
    participantId: "researcher",
    leadParticipantId: "lead",
    taskId: "research",
    assignment: "Find primary evidence for the claim.",
    originalMission: "Research and cite the claim.",
    modelClient: model,
    toolRegistry: registry,
    toolContext: {} as ToolExecutionContext,
    maxSteps: 6,
  });

  assert.deepEqual(executed, ["web_search", "web_fetch"]);
  assert.equal(result.toolCalls, 3);
  assert.equal(
    result.evidence.filter(
      (item) => item.kind === "web_source" && (item.passageIds?.length ?? 0) > 0,
    ).length,
    1,
  );
  assert.equal(result.handoff.status, "ready");
  assert.ok(result.sourceLedger.duplicateCount >= 2);
  assert.equal(
    Object.values(result.sourceLedger.candidates).filter(
      (candidate) => candidate.status === "usable",
    ).length,
    1,
  );
});

test("read-only worker registry blocks mutation tools without delegation", async () => {
  let delegated = false;
  const registry: ToolRegistry = {
    getDefinitions: () => [
      {
        type: "function",
        function: { name: "replace_file", parameters: { type: "object" } },
      },
    ],
    async execute(call) {
      delegated = true;
      return { ok: true, toolName: call.name, output: {} };
    },
  };
  const readOnly = createReadOnlyWorkerRegistry(registry);
  const result = await readOnly.execute(
    { name: "replace_file", arguments: { path: "Current.md", text: "bad" } },
    {} as ToolExecutionContext,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "orchestrator_worker_policy_blocked");
  assert.equal(delegated, false);
});

function sequenceModel(responses: ModelChatResponse[]): ModelClient {
  let index = 0;
  return {
    async chat(_request: ModelChatRequest) {
      return responses[Math.min(index++, responses.length - 1)];
    },
    async streamChat(_request: ModelChatRequest) {
      return responses[Math.min(index++, responses.length - 1)];
    },
  };
}

function toolResponse(
  name: string,
  args: Record<string, unknown>,
): ModelChatResponse {
  const call: ModelToolCall = { name, arguments: args, id: `call-${name}` };
  return {
    message: { role: "assistant", content: "", toolCalls: [call] },
    toolCalls: [call],
  };
}

function finalResponse(content: string): ModelChatResponse {
  return { message: { role: "assistant", content }, toolCalls: [] };
}
