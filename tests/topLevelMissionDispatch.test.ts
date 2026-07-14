import assert from "node:assert/strict";
import test from "node:test";
import {
  planTopLevelDirectMissionGraphV1,
  resolveTopLevelMissionDispatchV1,
  topLevelDispatchExecutorId,
} from "../src/agent/topLevelMissionDispatch";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelClient,
} from "../src/model/types";

const NOW = new Date("2026-07-11T18:00:00.000Z");

test("host dispatch preserves force-chat and extension gates before direct executors", () => {
  const base = {
    codeTeamRequest: {
      repositoryPath: "C:/trusted/repository",
      assignment: "Repair the repository",
    },
    codeTeamBridgeIntent: true,
    researchTeamRequested: true,
    orchestratorEnabled: true,
    forceChatOnly: false,
    codeExtensionAvailable: true,
    codeClarificationMessage: "Provide repository: <path>.",
  };

  assert.deepEqual(
    resolveTopLevelMissionDispatchV1({ ...base, forceChatOnly: true }),
    { kind: "single_agent" },
  );
  assert.deepEqual(
    resolveTopLevelMissionDispatchV1({
      ...base,
      codeExtensionAvailable: false,
    }).kind,
    "blocked",
  );
  const code = resolveTopLevelMissionDispatchV1(base);
  assert.equal(code.kind, "single_agent");

  const repositoryIntent = resolveTopLevelMissionDispatchV1({
    ...base,
    codeTeamRequest: null,
  });
  assert.equal(repositoryIntent.kind, "single_agent");

  const research = resolveTopLevelMissionDispatchV1({
    ...base,
    codeTeamRequest: null,
    codeTeamBridgeIntent: false,
  });
  assert.deepEqual(research, { kind: "research_team" });
});

test("explicit code dispatch persists an exact executor and hashed repository binding", async () => {
  const result = await planTopLevelDirectMissionGraphV1({
    missionId: "run-direct-code",
    objective: "Repair the selected repository and validate it.",
    decision: {
      kind: "code_team",
      request: {
        repositoryPath: "C:/trusted/private-repository",
        assignment: "Repair and validate",
      },
    },
    routerMode: "off",
    now: NOW,
  });

  assert.equal(result.source, "deterministic");
  assert.equal(topLevelDispatchExecutorId(result.graph), "code-team");
  assert.equal(result.graph.nodes.dispatch.effect, "execution");
  assert.deepEqual(result.graph.nodes.dispatch.destination, {
    bindingId: "trusted-code-repository",
    effect: "execution",
    selector: null,
  });
  assert.deepEqual(result.graph.nodes.dispatch.resourceLocks, [
    { bindingId: "trusted-code-repository", mode: "exclusive" },
  ]);
  assert.equal(result.graph.nodes.dispatch.status, "ready");
  assert.equal(result.graph.nodes.final.status, "queued");
  assert.ok(
    !JSON.stringify(result.graph.capabilityEnvelope).includes(
      "private-repository",
    ),
    "the capability envelope stores only the binding fingerprint",
  );
});

test("structured routing cannot replace research dispatch with an unknown executor node", async () => {
  const client = clientFrom(async () =>
    response(
      JSON.stringify({
        confidence: 0.99,
        nodes: [
          {
            id: "malicious-code-executor",
            objective: "Run an unapproved command",
            dependencyIds: [],
          },
        ],
      }),
    ),
  );
  const result = await planTopLevelDirectMissionGraphV1({
    missionId: "run-direct-research",
    objective: "Compare current sources.",
    decision: { kind: "research_team" },
    routerMode: "authority",
    modelClient: client,
    now: NOW,
  });

  assert.equal(result.source, "deterministic");
  assert.equal(result.fallbackReason, "structured_model_authority_widening");
  assert.equal(topLevelDispatchExecutorId(result.graph), "research-team");
  assert.deepEqual(Object.keys(result.graph.nodes).sort(), ["dispatch", "final"]);
});

test("missing code capability persists only a host guard and no execution authority", async () => {
  const result = await planTopLevelDirectMissionGraphV1({
    missionId: "run-code-extension-blocked",
    objective: "Run the code team.",
    decision: {
      kind: "blocked",
      blockerCode: "code_extension_unavailable",
      message: "The code extension is unavailable.",
      requiredAction: "Enable the code extension.",
    },
    routerMode: "off",
    now: NOW,
  });

  assert.equal(topLevelDispatchExecutorId(result.graph), "host-dispatch-guard");
  assert.equal(result.graph.nodes.dispatch.effect, "read");
  assert.equal(result.graph.nodes.dispatch.destination, null);
  assert.deepEqual(result.graph.capabilityEnvelope.bindings, {});
  assert.ok(!result.graph.capabilityEnvelope.executors["code-team"]);
});

function response(content: string): ModelChatResponse {
  return { message: { role: "assistant", content }, toolCalls: [] };
}

function clientFrom(
  handler: (request: ModelChatRequest) => Promise<ModelChatResponse>,
): ModelClient {
  return {
    chat: handler,
    streamChat: (request) => handler(request),
  };
}
