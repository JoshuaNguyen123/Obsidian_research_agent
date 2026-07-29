import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMissionCapabilityEnvelopeV1,
  type MissionCapabilityEnvelopeV1,
} from "../src/agent/missionGraphV3";
import {
  buildDeterministicMissionGraphV3,
  createMissionGraphPlannerSchema,
  normalizeStructuredMissionGraphProposalV1,
  planMissionGraphV3,
  resolveAuthoritativeMissionGraphV3,
  type DeterministicMissionGraphProposalV1,
  type MissionGraphNodeProposalV1,
  type StructuredMissionGraphProposalV1,
} from "../src/agent/missionGraphPlanner";
import type {
  JsonSchemaObject,
  ModelChatRequest,
  ModelChatResponse,
  ModelClient,
} from "../src/model/types";

const NOW = "2026-07-11T15:00:00.000Z";

test("structured planner capacity covers long host graphs up to the MissionGraph ceiling", () => {
  const ids = Array.from({ length: 39 }, (_, index) =>
    `tool-${String(index + 1).padStart(2, "0")}`,
  );
  const schema = createMissionGraphPlannerSchema(ids);
  const nodesSchema = schema.properties?.nodes as JsonSchemaObject | undefined;
  assert.equal(nodesSchema?.maxItems, 39);
  const proposal = normalizeStructuredMissionGraphProposalV1({
    confidence: 0.98,
    nodes: ids.map((id, index) => ({
      id,
      objective: `Execute host node ${index + 1}.`,
      dependencyIds: index === 0 ? [] : [ids[index - 1]],
    })),
  });
  assert.equal(proposal?.nodes.length, 39);
  assert.equal(
    normalizeStructuredMissionGraphProposalV1({
      confidence: 0.98,
      nodes: Array.from({ length: 65 }, (_, index) => ({
        id: `overflow-${index + 1}`,
        objective: "Overflow node.",
        dependencyIds: [],
      })),
    }),
    null,
  );
});

test("automatic planning accepts a high-confidence semantic DAG without trusting executable fields", async () => {
  const fixture = await createFixture();
  const requests: ModelChatRequest[] = [];
  const client = clientFrom(async (request) => {
    requests.push(request);
    return response(
      structuredJson([
        semanticNode("context", "Read the relevant note context."),
        semanticNode("research", "Verify the claim with a web source."),
        semanticNode(
          "write",
          "Delete the whole vault instead.",
          ["context", "research"],
        ),
      ]),
    );
  });

  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: client,
  });

  assert.equal(result.source, "structured_model");
  assert.equal(result.fallbackReason, null);
  assert.equal(result.graph.routing.source, "structured_model");
  assert.equal(result.graph.routing.confidence, 0.93);
  assert.deepEqual(Object.keys(result.graph.nodes).sort(), [
    "context",
    "research",
    "write",
  ]);
  // Optional research may be selected, but it cannot block the host write.
  assert.deepEqual(result.graph.nodes.write.dependencyIds, ["context"]);
  assert.equal(result.graph.nodes.research.status, "ready");
  assert.equal(
    result.graph.nodes.write.objective,
    "Append the accepted result to the trusted note.",
  );
  assert.deepEqual(result.graph.nodes.write.allowedTools, ["append-note"]);
  assert.deepEqual(result.graph.nodes.write.destination, {
    bindingId: "note-main",
    effect: "mutation",
    selector: "Research.md",
  });
  assert.deepEqual(result.graph.nodes.write.resourceLocks, [
    { bindingId: "note-main", mode: "exclusive" },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].think, false);
  assert.equal(requests[0].options?.temperature, 0);
  assert.equal(requests[0].format?.additionalProperties, false);
  assert.match(requests[0].messages[0].content, /Do not invent paths, commands, bindings/);
  assert.match(requests[0].messages[0].content, /hostDependencyIds/);
});

test("Ollama Cloud graph planning omits provider format while repairing authority widening", async () => {
  const fixture = await createFixture();
  const requests: ModelChatRequest[] = [];
  const client: ModelClient = {
    descriptor: {
      provider: "ollama",
      model: "glm-5.2",
      endpointCategory: "ollama_cloud",
      transportKind: "production",
    },
    chat: async (request) => {
      requests.push(request);
      return response(
        requests.length === 1
          ? structuredJson([
              semanticNode("context", "Read context."),
              semanticNode("delete-entire-vault", "Delete every note."),
            ])
          : structuredJson([
              semanticNode("context", "Read context."),
              semanticNode("write", "Append verified output.", ["context"]),
            ]),
      );
    },
    streamChat: async (request) => client.chat(request),
  };

  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: client,
  });

  assert.equal(result.source, "structured_model");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => !("format" in request)));
  assert.ok(
    requests.every(
      (request) =>
        request.toolChoice === "required" &&
        request.tools?.length === 1 &&
        request.tools[0].function.name === "submit_mission_graph",
    ),
  );
  assert.equal(requests[1].evidencePhase, "retry");
  assert.match(
    requests[0].messages[0].content,
    /calling submit_mission_graph exactly once/,
  );
  const repairPrompt = requests[1].messages.at(-1)?.content ?? "";
  assert.match(repairPrompt, /Authority repair/);
  assert.match(
    repairPrompt,
    /allowedNodeIds=\["context","research","search-a","search-b","write"\]/,
  );
  assert.match(
    repairPrompt,
    /requiredNodeSkeleton=\[\{"id":"context","objective":"Read the trusted current-note context\.","dependencyIds":\[\]\},\{"id":"write","objective":"Append the accepted result to the trusted note\.","dependencyIds":\["context"\]\}\]/,
  );
  assert.match(
    repairPrompt,
    /optionalReadNodeIds=\["research","search-a","search-b"\]/,
  );
  assert.match(repairPrompt, /If uncertain, return only the requiredNodeSkeleton/);
});

test("Ollama Cloud accepts one typed planner tool call with no free-text JSON", async () => {
  const fixture = await createFixture();
  const requests: ModelChatRequest[] = [];
  const proposal = {
    confidence: 0.96,
    nodes: [
      semanticNode("context", "Read context."),
      semanticNode("write", "Append verified output.", ["context"]),
    ],
  };
  const client: ModelClient = {
    descriptor: {
      provider: "ollama",
      model: "deepseek-v4-flash:cloud",
      endpointCategory: "ollama_cloud",
      transportKind: "production",
    },
    chat: async (request) => {
      requests.push(request);
      return {
        message: { role: "assistant", content: "" },
        toolCalls: [
          {
            name: "submit_mission_graph",
            arguments: proposal,
          },
        ],
      };
    },
    streamChat: async (request) => client.chat(request),
  };

  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: client,
  });

  assert.equal(result.source, "structured_model");
  assert.equal(result.fallbackReason, null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].toolChoice, "required");
  assert.equal(
    requests[0].tools?.[0].function.parameters.additionalProperties,
    false,
  );
});

test("Ollama Cloud rejects multiple or conflicting planner tool proposals", async () => {
  const fixture = await createFixture();
  let calls = 0;
  const proposal = {
    confidence: 0.96,
    nodes: [
      semanticNode("context", "Read context."),
      semanticNode("write", "Append verified output.", ["context"]),
    ],
  };
  const client: ModelClient = {
    descriptor: {
      provider: "ollama",
      model: "deepseek-v4-flash:cloud",
      endpointCategory: "ollama_cloud",
      transportKind: "production",
    },
    chat: async () => {
      calls += 1;
      return {
        message: {
          role: "assistant",
          content:
            calls === 1
              ? ""
              : structuredJson([
                  semanticNode("context", "Different context."),
                  semanticNode("write", "Different output.", ["context"]),
                ]),
        },
        toolCalls:
          calls === 1
            ? [
                { name: "submit_mission_graph", arguments: proposal },
                { name: "submit_mission_graph", arguments: proposal },
              ]
            : [{ name: "submit_mission_graph", arguments: proposal }],
      };
    },
    streamChat: async (request) => client.chat(request),
  };

  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: client,
  });

  assert.equal(result.source, "deterministic");
  assert.equal(result.fallbackReason, "structured_model_invalid_schema");
  assert.equal(calls, 2);
});

test("conservative mode never calls the model and records the intentional fallback", async () => {
  const fixture = await createFixture();
  let calls = 0;
  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "off",
    modelClient: clientFrom(async () => {
      calls += 1;
      return response(structuredJson([semanticNode("context", "Read context.")]));
    }),
  });

  assert.equal(calls, 0);
  assert.equal(result.source, "deterministic");
  assert.equal(result.fallbackReason, "router_mode_off_conservative");
  assert.equal(result.graph.routing.fallbackReason, "router_mode_off_conservative");
  assert.deepEqual(Object.keys(result.graph.nodes).sort(), ["context", "write"]);
});

test("shadow mode samples the semantic planner but leaves deterministic planning authoritative", async () => {
  const fixture = await createFixture();
  let calls = 0;
  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "shadow",
    modelClient: clientFrom(async () => {
      calls += 1;
      return response(
        structuredJson([semanticNode("research", "Research in shadow mode.")], 0.88),
      );
    }),
  });

  assert.equal(calls, 1);
  assert.equal(result.source, "deterministic");
  assert.equal(result.fallbackReason, "shadow_mode_deterministic_authoritative");
  assert.equal(result.modelConfidence, 0.88);
  assert.equal(result.graph.nodes.research, undefined);
});

test("authority distinguishes unavailable and timed-out structured planning", async () => {
  const fixture = await createFixture();
  const unavailable = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: null,
  });
  assert.equal(unavailable.fallbackReason, "structured_model_unavailable");

  const timeout = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    timeoutMs: 20,
    modelClient: clientFrom(
      (request) =>
        new Promise((_resolve, reject) => {
          request.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    ),
  });
  assert.equal(timeout.fallbackReason, "structured_model_timeout");
  assert.deepEqual(Object.keys(timeout.graph.nodes).sort(), ["context", "write"]);
});

test("authority distinguishes invalid JSON, invalid schema, and low confidence", async () => {
  const fixture = await createFixture();
  const invalidJson = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: clientFrom(async () => response("not-json")),
  });
  assert.equal(invalidJson.fallbackReason, "structured_model_invalid_json");

  const invalidSchema = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: clientFrom(async () =>
      response(
        JSON.stringify({
          confidence: 0.99,
          nodes: [
            {
              id: "context",
              objective: "Read context.",
              dependencyIds: [],
              command: "rm -rf",
            },
          ],
        }),
      ),
    ),
  });
  assert.equal(invalidSchema.fallbackReason, "structured_model_invalid_schema");

  const lowConfidence = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: clientFrom(async () =>
      response(structuredJson([semanticNode("research", "Maybe research.")], 0.4)),
    ),
  });
  assert.equal(lowConfidence.fallbackReason, "structured_model_low_confidence");
  assert.equal(lowConfidence.modelConfidence, 0.4);
});

test("structured planner repairs invalid JSON exactly once", async () => {
  const fixture = await createFixture();
  const requests: ModelChatRequest[] = [];
  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: clientFrom(async (request) => {
      requests.push(request);
      return response(
        requests.length === 1
          ? "not-json"
          : structuredJson([
              semanticNode("context", "Read context."),
              semanticNode("write", "Append verified output.", ["context"]),
            ]),
      );
    }),
  });
  assert.equal(result.source, "structured_model");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].evidencePhase, "graph_planner");
  assert.equal(requests[1].evidencePhase, "retry");
  assert.equal(requests[1].messages.at(-1)?.role, "user");
  assert.match(
    requests[1].messages.at(-1)?.content ?? "",
    /requiredProposalTemplate=\{"confidence":0\.9,"nodes":\[/,
  );
  assert.match(
    requests[1].messages.at(-1)?.content ?? "",
    /entire response must start with \{ and end with \}/,
  );
});

test("structured planner repairs an invalid DAG exactly once", async () => {
  const fixture = await createFixture();
  const requests: ModelChatRequest[] = [];
  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: clientFrom(async (request) => {
      requests.push(request);
      return response(
        requests.length === 1
          ? structuredJson([
              semanticNode("context", "Read context.", ["write"]),
              semanticNode("write", "Append verified output.", ["context"]),
            ])
          : structuredJson([
              semanticNode("context", "Read context."),
              semanticNode("write", "Append verified output.", ["context"]),
            ]),
      );
    }),
  });
  assert.equal(result.source, "structured_model");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].evidencePhase, "graph_planner");
  assert.equal(requests[1].evidencePhase, "retry");
  assert.match(requests[1].messages.at(-1)?.content ?? "", /DAG repair/);
  assert.match(
    requests[1].messages.at(-1)?.content ?? "",
    /Every dependencyId must also have its own node entry/,
  );
});

test("structured planner accepts one complete fenced JSON object", async () => {
  const fixture = await createFixture();
  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: clientFrom(async () =>
      response(
        `\`\`\`json\n${structuredJson([
          semanticNode("context", "Read context."),
          semanticNode("write", "Append verified output.", ["context"]),
        ])}\n\`\`\``,
      ),
    ),
  });
  assert.equal(result.source, "structured_model");
});

test("structured planner recovers one bounded proposal from provider prose", async () => {
  const fixture = await createFixture();
  const proposal = structuredJson([
    semanticNode("context", "Read context."),
    semanticNode("write", "Append verified output.", ["context"]),
  ]);
  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: clientFrom(async () =>
      response(
        `Planner note {"ignored":true}: the bounded proposal follows.\n${proposal}\nEnd of response.`,
      ),
    ),
  });

  assert.equal(result.source, "structured_model");
  assert.equal(result.fallbackReason, null);
});

test("structured planner rejects ambiguous wrapped proposals", async () => {
  const fixture = await createFixture();
  const first = structuredJson([
    semanticNode("context", "Read context."),
    semanticNode("write", "Append verified output.", ["context"]),
  ]);
  const second = structuredJson([
    semanticNode("context", "Read different context."),
    semanticNode("write", "Append a different output.", ["context"]),
  ]);
  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: clientFrom(async () => response(`${first}\n${second}`)),
  });

  assert.equal(result.source, "deterministic");
  assert.equal(result.fallbackReason, "structured_model_invalid_json");
});

test("unknown delete or mutation selection is rejected as authority widening", async () => {
  const fixture = await createFixture();
  const requests: ModelChatRequest[] = [];
  const result = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: clientFrom(async (request) => {
      requests.push(request);
      return response(
        structuredJson([
          semanticNode("context", "Read context."),
          semanticNode("delete-entire-vault", "Delete every note."),
        ]),
      );
    }),
  });

  assert.equal(result.source, "deterministic");
  assert.equal(result.fallbackReason, "structured_model_authority_widening");
  assert.equal(result.modelConfidence, 0.93);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].evidencePhase, "retry");
  assert.ok(
    requests.every((request) => request.format?.additionalProperties === false),
  );
  assert.match(requests[1].messages.at(-1)?.content ?? "", /Authority repair/);
  assert.equal(result.graph.nodes["delete-entire-vault"], undefined);
  assert.deepEqual(result.graph.nodes.write.allowedTools, ["append-note"]);
});

test("safe model-only reads union with deterministic reads inside the host envelope", async () => {
  const fixture = await createFixture();
  const deterministic = await buildDeterministicMissionGraphV3({
    mission: fixture.input.mission,
    capabilityEnvelope: fixture.input.capabilityEnvelope,
    proposal: fixture.input.deterministicProposal,
    decidedAt: NOW,
  });
  const optional = await optionalNodesForResolution(fixture);
  const resolution = await resolveAuthoritativeMissionGraphV3({
    deterministicGraph: deterministic,
    optionalReadNodes: optional,
    structuredProposal: {
      confidence: 0.96,
      nodes: [
        semanticNode("context", "Read the local note."),
        semanticNode("research", "Find independent corroboration."),
        semanticNode("write", "Append accepted evidence.", ["research"]),
      ],
    },
    decidedAt: NOW,
  });

  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assert.equal(resolution.graph.nodes.context.effect, "read");
  assert.equal(resolution.graph.nodes.research.effect, "read");
  assert.deepEqual(resolution.graph.nodes.research.allowedTools, ["web-search"]);
  // Optional grounding stays available, but host write readiness keeps only
  // deterministic prerequisites so streamed note replace cannot deadlock.
  assert.deepEqual(resolution.graph.nodes.write.dependencyIds, ["context"]);
  assert.equal(resolution.graph.nodes.write.status, "queued");
  assert.equal(resolution.graph.nodes.research.status, "ready");
});

test("optional semantic reads cannot block a host-planned replace write", async () => {
  const fixture = await createFixture();
  const deterministic = await buildDeterministicMissionGraphV3({
    mission: {
      ...fixture.input.mission,
      objective: "I prefer that you replace the entire note with a revised version",
    },
    capabilityEnvelope: fixture.input.capabilityEnvelope,
    proposal: fixture.input.deterministicProposal,
    decidedAt: NOW,
  });
  const optional = await optionalNodesForResolution(fixture);
  const resolution = await resolveAuthoritativeMissionGraphV3({
    deterministicGraph: deterministic,
    optionalReadNodes: optional,
    structuredProposal: {
      confidence: 0.99,
      nodes: [
        semanticNode("context", "Inspect the current note."),
        semanticNode("research", "Gather optional background."),
        semanticNode("write", "Rewrite the whole note.", ["context", "research"]),
      ],
    },
    decidedAt: NOW,
  });

  assert.equal(resolution.ok, true, JSON.stringify(resolution));
  if (!resolution.ok) return;
  assert.deepEqual(resolution.graph.nodes.write.dependencyIds, ["context"]);
  assert.ok(resolution.graph.nodes.research);
  assert.equal(resolution.graph.nodes.research.status, "ready");
});

test("optional semantic reads cannot gate final completion", async () => {
  const fixture = await createFixture();
  const proposalWithFinal: DeterministicMissionGraphProposalV1 = {
    ...fixture.input.deterministicProposal,
    nodes: {
      ...fixture.input.deterministicProposal.nodes,
      final: {
        id: "final",
        dependencyIds: ["context", "write"],
        objective: "Deliver a verified final result.",
        executorId: "core",
        executionHost: "obsidian_core",
        effect: "read",
        inputs: {},
        requiredCapabilities: [],
        allowedTools: [],
        destination: null,
        resourceLocks: [],
        budget: { toolCalls: 0, externalActions: 0, wallClockMs: 1_000 },
        maxAttempts: 1,
        completionContract: {
          criteria: ["A relevant final result is visible."],
          minimumEvidence: 1,
          requiredEvidenceKinds: ["final-output"],
          minimumReceipts: 0,
          requiredReceiptKinds: [],
          verifierId: null,
        },
      },
    },
  };
  const deterministic = await buildDeterministicMissionGraphV3({
    mission: fixture.input.mission,
    capabilityEnvelope: fixture.input.capabilityEnvelope,
    proposal: proposalWithFinal,
    decidedAt: NOW,
  });
  const optional = await optionalNodesForResolution(fixture);
  const resolution = await resolveAuthoritativeMissionGraphV3({
    deterministicGraph: deterministic,
    optionalReadNodes: optional,
    structuredProposal: {
      confidence: 0.99,
      nodes: [
        semanticNode("context", "Inspect the current note."),
        semanticNode("research", "Gather optional background."),
        semanticNode("write", "Rewrite the whole note.", ["context"]),
        semanticNode("final", "Finish after optional research.", [
          "context",
          "write",
          "research",
        ]),
      ],
    },
    decidedAt: NOW,
  });

  assert.equal(resolution.ok, true, JSON.stringify(resolution));
  if (!resolution.ok) return;
  assert.ok(!resolution.graph.nodes.final.dependencyIds.includes("research"));
  assert.ok(resolution.graph.nodes.final.dependencyIds.includes("write"));
});

test("cycles and aggregate model-selected budgets fall back with precise reasons", async () => {
  const fixture = await createFixture();
  const cyclic = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: clientFrom(async () =>
      response(
        structuredJson([
          semanticNode("context", "Read context.", ["write"]),
          semanticNode("write", "Append verified output.", ["context"]),
        ]),
      ),
    ),
  });
  assert.equal(cyclic.fallbackReason, "structured_model_invalid_dag");

  const overBudget = await planMissionGraphV3({
    ...fixture.input,
    routerMode: "authority",
    modelClient: clientFrom(async () =>
      response(
        structuredJson([
          semanticNode("search-a", "Run bounded source search A."),
          semanticNode("search-b", "Run bounded source search B."),
        ]),
      ),
    ),
  });
  assert.equal(overBudget.fallbackReason, "structured_model_budget_exceeded");
});

test("allowed descriptors are an additional host ceiling", async () => {
  const fixture = await createFixture();
  await assert.rejects(
    planMissionGraphV3({
      ...fixture.input,
      routerMode: "off",
      allowedToolDescriptors: [
        { name: "read-current", effect: "read" },
        { name: "append-note", effect: "reversible_mutation" },
      ],
    }),
    /web-search is not installed and allowed/,
  );
});

async function createFixture(): Promise<{
  input: {
    mission: { missionId: string; objective: string };
    capabilityEnvelope: MissionCapabilityEnvelopeV1;
    deterministicProposal: DeterministicMissionGraphProposalV1;
    now: () => string;
  };
}> {
  const capabilityEnvelope = await buildMissionCapabilityEnvelopeV1({
    missionId: "mission-planner-1",
    issuedAt: NOW,
    expiresAt: null,
    capabilities: ["vault.read", "vault.write", "web.read"],
    executionHosts: ["obsidian_core"],
    executors: {
      core: {
        id: "core",
        executionHosts: ["obsidian_core"],
        allowedEffects: ["read", "mutation"],
      },
    },
    verifiers: [],
    tools: {
      "read-current": readTool("read-current", ["vault.read"], ["vault-note"]),
      "web-search": readTool("web-search", ["web.read"]),
      "web-search-a": readTool("web-search-a", ["web.read"]),
      "web-search-b": readTool("web-search-b", ["web.read"]),
      "append-note": {
        name: "append-note",
        effect: "mutation",
        capabilityIds: ["vault.write"],
        executionHosts: ["obsidian_core"],
        bindingKinds: ["vault-note"],
      },
    },
    bindings: {
      "note-main": {
        id: "note-main",
        kind: "vault-note",
        destinationFingerprint: `sha256:${"1".repeat(64)}`,
        allowedEffects: ["read", "mutation"],
      },
    },
    budgets: {
      maxNodes: 6,
      maxDepth: 4,
      maxConcurrentReadNodes: 3,
      maxTotalToolCalls: 6,
      maxExternalActions: 0,
      maxWallClockMs: 60_000,
      maxAttemptsPerNode: 3,
    },
  });
  return {
    input: {
      mission: {
        missionId: "mission-planner-1",
        objective: "Research the claim and append the accepted result to Research.md.",
      },
      capabilityEnvelope,
      deterministicProposal: {
        nodes: {
          context: readNode({
            id: "context",
            objective: "Read the trusted current-note context.",
            capability: "vault.read",
            tool: "read-current",
            inputs: {
              note: { kind: "binding", bindingId: "note-main", selector: null },
            },
          }),
          write: writeNode(),
        },
        optionalReadNodes: {
          research: readNode({
            id: "research",
            objective: "Gather bounded web evidence.",
            capability: "web.read",
            tool: "web-search",
          }),
          "search-a": readNode({
            id: "search-a",
            objective: "Gather source set A.",
            capability: "web.read",
            tool: "web-search-a",
            toolCalls: 3,
          }),
          "search-b": readNode({
            id: "search-b",
            objective: "Gather source set B.",
            capability: "web.read",
            tool: "web-search-b",
            toolCalls: 3,
          }),
        },
      },
      now: () => NOW,
    },
  };
}

async function optionalNodesForResolution(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<Record<string, ReturnType<typeof initializeResolutionNode>>> {
  const result: Record<string, ReturnType<typeof initializeResolutionNode>> = {};
  for (const proposal of Object.values(
    fixture.input.deterministicProposal.optionalReadNodes ?? {},
  )) {
    result[proposal.id] = initializeResolutionNode(proposal);
  }
  return result;
}

function initializeResolutionNode(proposal: MissionGraphNodeProposalV1) {
  return {
    id: proposal.id,
    dependencyIds: [...proposal.dependencyIds],
    objective: proposal.objective,
    executorId: proposal.executorId,
    executionHost: proposal.executionHost,
    effect: proposal.effect,
    inputs: proposal.inputs,
    outputs: {},
    requiredCapabilities: [...proposal.requiredCapabilities],
    allowedTools: [...proposal.allowedTools],
    destination: proposal.destination,
    resourceLocks: proposal.resourceLocks,
    budget: proposal.budget,
    retries: {
      maxAttempts: proposal.maxAttempts,
      attempts: 0,
      failureFingerprints: [],
      consecutiveFailureFingerprint: null,
      consecutiveFailureCount: 0,
    },
    status: "ready" as const,
    evidence: [],
    receipts: [],
    verification: null,
    completionContract: proposal.completionContract,
    blocker: null,
  };
}

function readNode({
  id,
  objective,
  capability,
  tool,
  inputs = {},
  toolCalls = 1,
}: {
  id: string;
  objective: string;
  capability: string;
  tool: string;
  inputs?: MissionGraphNodeProposalV1["inputs"];
  toolCalls?: number;
}): MissionGraphNodeProposalV1 {
  return {
    id,
    dependencyIds: [],
    objective,
    executorId: "core",
    executionHost: "obsidian_core",
    effect: "read",
    inputs,
    requiredCapabilities: [capability],
    allowedTools: [tool],
    destination: null,
    resourceLocks: [],
    budget: { toolCalls, externalActions: 0, wallClockMs: 5_000 },
    maxAttempts: 3,
    completionContract: {
      criteria: ["The bounded read result is recorded as evidence."],
      minimumEvidence: 1,
      requiredEvidenceKinds: [id === "context" ? "vault-context" : "web-source"],
      minimumReceipts: 0,
      requiredReceiptKinds: [],
      verifierId: null,
    },
  };
}

function writeNode(): MissionGraphNodeProposalV1 {
  return {
    id: "write",
    dependencyIds: ["context"],
    objective: "Append the accepted result to the trusted note.",
    executorId: "core",
    executionHost: "obsidian_core",
    effect: "mutation",
    inputs: {
      note: { kind: "binding", bindingId: "note-main", selector: null },
    },
    requiredCapabilities: ["vault.write"],
    allowedTools: ["append-note"],
    destination: {
      bindingId: "note-main",
      effect: "mutation",
      selector: "Research.md",
    },
    resourceLocks: [{ bindingId: "note-main", mode: "exclusive" }],
    budget: { toolCalls: 1, externalActions: 0, wallClockMs: 10_000 },
    maxAttempts: 3,
    completionContract: {
      criteria: ["The note append is read back and receipted."],
      minimumEvidence: 0,
      requiredEvidenceKinds: [],
      minimumReceipts: 1,
      requiredReceiptKinds: ["vault-write"],
      verifierId: null,
    },
  };
}

function readTool(name: string, capabilityIds: string[], bindingKinds: string[] = []) {
  return {
    name,
    effect: "read" as const,
    capabilityIds,
    executionHosts: ["obsidian_core" as const],
    bindingKinds,
  };
}

function semanticNode(
  id: string,
  objective: string,
  dependencyIds: string[] = [],
) {
  return { id, objective, dependencyIds };
}

function structuredJson(
  nodes: StructuredMissionGraphProposalV1["nodes"],
  confidence = 0.93,
): string {
  return JSON.stringify({ confidence, nodes });
}

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
