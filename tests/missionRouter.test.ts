import test from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_ROUTER_SCHEMA,
  MISSION_ROUTER_SYSTEM_PROMPT,
  ROUTER_AUTHORITY_CONFIDENCE_THRESHOLD,
  classifyMissionWithModel,
  classifyMissionWithModelDetailed,
  intersectAuthoritativeIntent,
  normalizeModelRouterMode,
  normalizeRoutedMissionIntent,
  resolveAuthoritativeWriteScopeV1,
  resolveModelRouterMode,
  resolveRoutedMissionIntent,
  saferWriteScope,
} from "../src/agent/missionRouter";
import {
  deriveRoutedIntentFallback,
  evaluateToolPolicy,
  resolvePolicyRoutedIntent,
} from "../src/agent/policyEngine";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import type { MissionIntent } from "../src/tools/types";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelClient,
} from "../src/model/types";
import { ModelClientError } from "../src/model/types";

function routedJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: "web_research",
    writeScope: "current_note_append",
    needsWebEvidence: true,
    needsVaultContext: false,
    needsCodeExecution: false,
    wordTarget: 300,
    confidence: 0.86,
    rationale: "User asked for current market data written to the note.",
    ...overrides,
  });
}

function clientFromResponse(
  respond: (request: ModelChatRequest) => Promise<ModelChatResponse>,
): ModelClient {
  return {
    chat: respond,
    streamChat: async () => {
      throw new Error("streamChat is not used by the router");
    },
  };
}

function intentFixture(
  prompt: string,
  overrides: Partial<MissionIntent> = {},
): MissionIntent {
  const flags = {
    vaultContext: overrides.vaultContext ?? false,
    noteOutput: overrides.noteOutput ?? false,
    explicitPersistence: overrides.explicitPersistence ?? false,
    explicitMutation: overrides.explicitMutation ?? false,
    explicitDelete: overrides.explicitDelete ?? false,
  };
  return {
    mode: overrides.mode ?? "chat_only",
    ...flags,
    allowAutonomousWrite: overrides.allowAutonomousWrite ?? false,
    requireWriteCompletion: overrides.requireWriteCompletion ?? false,
    autonomyScope: overrides.autonomyScope ?? deriveAutonomyScope(prompt, flags),
  };
}

test("normalizeRoutedMissionIntent parses valid router JSON", () => {
  const intent = normalizeRoutedMissionIntent(routedJson());
  assert.ok(intent);
  assert.equal(intent.mode, "web_research");
  assert.equal(intent.writeScope, "current_note_append");
  assert.equal(intent.needsWebEvidence, true);
  assert.equal(intent.wordTarget, 300);
  assert.equal(intent.confidence, 0.86);
});

test("normalizeRoutedMissionIntent rejects invalid modes, scopes, and confidence", () => {
  assert.equal(normalizeRoutedMissionIntent("not json"), null);
  assert.equal(normalizeRoutedMissionIntent(routedJson({ mode: "hack_vault" })), null);
  assert.equal(
    normalizeRoutedMissionIntent(routedJson({ writeScope: "everything" })),
    null,
  );
  assert.equal(
    normalizeRoutedMissionIntent(routedJson({ confidence: "high" })),
    null,
  );
  assert.equal(normalizeRoutedMissionIntent(null), null);
  assert.equal(normalizeRoutedMissionIntent(42), null);
  assert.equal(
    normalizeRoutedMissionIntent(`Here is the route:\n\n\`\`\`json\n${routedJson()}\n\`\`\``),
    null,
  );
});

test("normalizeRoutedMissionIntent accepts one complete fenced JSON object", () => {
  const intent = normalizeRoutedMissionIntent(
    `\`\`\`json\n${routedJson()}\n\`\`\``,
  );
  assert.ok(intent);
  assert.equal(intent.mode, "web_research");
});

test("normalizeRoutedMissionIntent clamps confidence and truncates rationale", () => {
  const overconfident = normalizeRoutedMissionIntent(
    routedJson({ confidence: 7, rationale: "x".repeat(1000) }),
  );
  assert.ok(overconfident);
  assert.equal(overconfident.confidence, 1);
  assert.equal(overconfident.rationale.length, 240);

  const negative = normalizeRoutedMissionIntent(routedJson({ confidence: -3 }));
  assert.ok(negative);
  assert.equal(negative.confidence, 0);

  const badWordTarget = normalizeRoutedMissionIntent(
    routedJson({ wordTarget: "many" }),
  );
  assert.ok(badWordTarget);
  assert.equal(badWordTarget.wordTarget, null);
});

test("classifyMissionWithModel sends schema-constrained request and parses reply", async () => {
  const requests: ModelChatRequest[] = [];
  const client = clientFromResponse(async (request) => {
    requests.push(request);
    return {
      message: { role: "assistant", content: routedJson() },
      toolCalls: [],
    };
  });

  const intent = await classifyMissionWithModel({
    client,
    prompt: "Write a 300 word brief on the current dating market to this note.",
    recentAssistant: "Earlier I summarized the note.",
  });

  assert.ok(intent);
  assert.equal(intent.mode, "web_research");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].format, MISSION_ROUTER_SCHEMA);
  assert.equal(requests[0].think, false);
  assert.equal(requests[0].options?.temperature, 0);
  assert.equal(requests[0].messages[0].content, MISSION_ROUTER_SYSTEM_PROMPT);
  assert.ok(
    requests[0].messages.some((message) =>
      /Recent assistant context/.test(message.content),
    ),
  );
  assert.equal(
    requests[0].messages.at(-1)?.content,
    "Write a 300 word brief on the current dating market to this note.",
  );
});

test("Ollama Cloud router omits provider format but keeps host schema repair", async () => {
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
      return {
        message: {
          role: "assistant",
          content: requests.length === 1 ? "not json" : routedJson(),
        },
        toolCalls: [],
      };
    },
    streamChat: async () => {
      throw new Error("streamChat is not used by the router");
    },
  };

  const intent = await classifyMissionWithModel({ client, prompt: "research this" });

  assert.equal(intent?.mode, "web_research");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => !("format" in request)));
  assert.equal(requests[0].messages[0].content, MISSION_ROUTER_SYSTEM_PROMPT);
  assert.match(requests[1].messages.at(-1)?.content ?? "", /Schema repair/);
});

test("classifyMissionWithModel returns null on model errors", async () => {
  const client = clientFromResponse(async () => {
    throw new Error("boom");
  });
  const intent = await classifyMissionWithModel({
    client,
    prompt: "anything",
  });
  assert.equal(intent, null);
});

test("classifyMissionWithModel returns null when the router times out", async () => {
  const client = clientFromResponse(
    (request) =>
      new Promise((resolve, reject) => {
        request.abortSignal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
  );

  const startedAt = Date.now();
  const intent = await classifyMissionWithModel({
    client,
    prompt: "anything",
    timeoutMs: 25,
  });
  assert.equal(intent, null);
  assert.ok(Date.now() - startedAt < 5000);
});

test("classifyMissionWithModel propagates caller abort without retrying", async () => {
  const outerController = new AbortController();
  let calls = 0;
  let innerAbortSignal: AbortSignal | undefined;
  let markRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  const client = clientFromResponse(
    (request) =>
      new Promise((resolve, reject) => {
        calls += 1;
        innerAbortSignal = request.abortSignal;
        markRequestStarted();
        request.abortSignal?.addEventListener(
          "abort",
          () => reject(new ModelClientError("network", "caller aborted")),
          { once: true },
        );
      }),
  );

  const intentPromise = classifyMissionWithModel({
    client,
    prompt: "anything",
    timeoutMs: 10_000,
    abortSignal: outerController.signal,
  });
  await requestStarted;
  assert.ok(innerAbortSignal);
  outerController.abort();

  await assert.rejects(
    intentPromise,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(innerAbortSignal.aborted, true);
  assert.equal(calls, 1);
});

test("classifyMissionWithModel returns null for unparseable router output", async () => {
  const client = clientFromResponse(async () => ({
    message: { role: "assistant", content: "I think this is a web mission." },
    toolCalls: [],
  }));
  const intent = await classifyMissionWithModel({
    client,
    prompt: "anything",
  });
  assert.equal(intent, null);
});

test("classifyMissionWithModel performs one bounded schema repair", async () => {
  const requests: ModelChatRequest[] = [];
  const client = clientFromResponse(async (request) => {
    requests.push(request);
    return {
      message: {
        role: "assistant",
        content: requests.length === 1 ? "not json" : routedJson(),
      },
      toolCalls: [],
    };
  });
  const intent = await classifyMissionWithModel({ client, prompt: "research this" });
  assert.equal(intent?.mode, "web_research");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].evidencePhase, "router");
  assert.equal(requests[1].evidencePhase, "retry");
  assert.match(requests[1].messages.at(-1)?.content ?? "", /Schema repair/);
});

test("router exposes auth failure and never schema-retries it", async () => {
  let calls = 0;
  const result = await classifyMissionWithModelDetailed({
    client: clientFromResponse(async () => {
      calls += 1;
      throw new ModelClientError("auth", "unauthorized");
    }),
    prompt: "research this",
  });
  assert.equal(result.intent, null);
  assert.equal(result.failureReason, "router_auth");
  assert.equal(calls, 1);
});

test("resolveModelRouterMode maps legacy boolean and normalizes modes", () => {
  assert.equal(resolveModelRouterMode({}), "off");
  assert.equal(resolveModelRouterMode({ modelRouterEnabled: true }), "shadow");
  assert.equal(
    resolveModelRouterMode({
      modelRouterMode: "authority",
      modelRouterEnabled: false,
    }),
    "authority",
  );
  assert.equal(normalizeModelRouterMode("shadow"), "shadow");
  assert.equal(normalizeModelRouterMode(undefined, true), "shadow");
  assert.equal(normalizeModelRouterMode("nope", false), "off");
});

test("authority uses high-confidence valid model fields", () => {
  const modelIntent = normalizeRoutedMissionIntent(
    routedJson({
      mode: "deep_research",
      writeScope: "current_note_append",
      confidence: 0.91,
      needsWebEvidence: true,
    }),
  );
  assert.ok(modelIntent);
  const regexIntent = deriveRoutedIntentFallback({
    missionIntent: intentFixture(
      "Write onto this page a 300 word brief about the current online dating market.",
      { mode: "note_output", noteOutput: true },
    ),
    writeAutonomy: false,
    writeToolExposed: true,
  });
  const resolved = resolveRoutedMissionIntent({
    mode: "authority",
    modelIntent,
    regexIntent,
  });
  assert.equal(resolved.source, "model");
  assert.equal(resolved.intent.mode, "deep_research");
  assert.equal(resolved.intent.needsWebEvidence, true);
  assert.equal(resolved.intent.writeScope, "current_note_append");
  assert.ok(modelIntent.confidence >= ROUTER_AUTHORITY_CONFIDENCE_THRESHOLD);
});

test("authority falls back to regex on low confidence, timeout/null, or invalid", () => {
  const regexIntent = deriveRoutedIntentFallback({
    missionIntent: intentFixture("hello"),
    writeAutonomy: false,
    writeToolExposed: false,
  });

  const low = resolveRoutedMissionIntent({
    mode: "authority",
    modelIntent: normalizeRoutedMissionIntent(
      routedJson({ confidence: 0.4, mode: "web_research" }),
    ),
    regexIntent,
  });
  assert.equal(low.source, "regex");
  assert.match(low.fallbackReason ?? "", /authority_low_confidence/);
  assert.equal(low.intent.writeScope, "none");

  const missing = resolveRoutedMissionIntent({
    mode: "authority",
    modelIntent: null,
    regexIntent,
  });
  assert.equal(missing.source, "regex");
  assert.equal(missing.fallbackReason, "authority_model_unavailable");

  const shadow = resolvePolicyRoutedIntent({
    mode: "shadow",
    modelIntent: normalizeRoutedMissionIntent(routedJson()),
    missionIntent: intentFixture("hello"),
    writeAutonomy: false,
    writeToolExposed: false,
  });
  assert.equal(shadow.source, "regex");
  assert.equal(shadow.fallbackReason, "shadow_mode_regex_authoritative");
});

test("authority cannot widen replace/delete beyond regex append-only scope", () => {
  const regexAppend = deriveRoutedIntentFallback({
    missionIntent: intentFixture("append a short update to this note", {
      mode: "note_output",
      noteOutput: true,
    }),
    writeAutonomy: false,
    writeToolExposed: true,
  });
  assert.equal(regexAppend.writeScope, "current_note_append");

  const modelReplace = normalizeRoutedMissionIntent(
    routedJson({
      writeScope: "current_note_replace",
      confidence: 0.99,
      mode: "vault_write",
    }),
  );
  assert.ok(modelReplace);

  const resolved = resolveRoutedMissionIntent({
    mode: "authority",
    modelIntent: modelReplace,
    regexIntent: regexAppend,
  });
  assert.equal(resolved.source, "model");
  assert.equal(resolved.intent.writeScope, "current_note_append");
  assert.equal(saferWriteScope("current_note_replace", "none"), "none");
  assert.equal(
    intersectAuthoritativeIntent(modelReplace, regexAppend).writeScope,
    "current_note_append",
  );

  const regexNone = deriveRoutedIntentFallback({
    missionIntent: intentFixture("what is TCP?"),
    writeAutonomy: false,
    writeToolExposed: false,
  });
  const destructiveModel = normalizeRoutedMissionIntent(
    routedJson({
      writeScope: "vault_files",
      confidence: 0.95,
      mode: "vault_write",
    }),
  );
  assert.ok(destructiveModel);
  const clamped = resolveRoutedMissionIntent({
    mode: "authority",
    modelIntent: destructiveModel,
    regexIntent: regexNone,
  });
  assert.equal(clamped.intent.writeScope, "none");
});

test("authority unions read needs but intersects generated-code execution", () => {
  const model = normalizeRoutedMissionIntent(routedJson({
    mode: "deep_research",
    needsWebEvidence: true,
    needsVaultContext: false,
    needsCodeExecution: true,
  }));
  const deterministic = normalizeRoutedMissionIntent(routedJson({
    mode: "vault_read",
    needsWebEvidence: false,
    needsVaultContext: true,
    needsCodeExecution: false,
  }));
  assert.ok(model);
  assert.ok(deterministic);

  const resolved = resolveRoutedMissionIntent({
    mode: "authority",
    modelIntent: model,
    regexIntent: deterministic,
  });

  assert.equal(resolved.intent.needsWebEvidence, true);
  assert.equal(resolved.intent.needsVaultContext, true);
  assert.equal(resolved.intent.needsCodeExecution, false);
});

/**
 * REGRESSION GUARD — real-ai-soak "approved vault CRUD chain preserves backups
 * and receipts".
 *
 * The mission graph planned tool-01-create_file … tool-04-delete_path and the
 * frontier offered create_file, so the run's write-tool exposure made the regex
 * safety net say `vault_files`. A high-confidence authority route answering
 * `writeScope: "none"` used to win the intersection, and evaluateToolPolicy
 * then blocked the mission's own first planned node with `mutation_scope`.
 * That is `offered ⊄ gate-accepted`: the host refused a call it was actively
 * offering, and the node died on `tool_failure_repeated` after two attempts.
 */
test("an authority route may not revoke mutation authority the host is offering", () => {
  const missionIntent = intentFixture(
    'Create the exact markdown file "E2E Agent Tests/crud-source.md", replace its content, move it, then trash it.',
    { explicitMutation: true },
  );
  const regexIntent = deriveRoutedIntentFallback({
    missionIntent,
    writeAutonomy: false,
    // The frontier is offering create_file for the mission's own planned node.
    writeToolExposed: true,
    prompt: "vault crud chain",
  });
  assert.notEqual(regexIntent.writeScope, "none");

  const modelIntent = normalizeRoutedMissionIntent(
    routedJson({ writeScope: "none", confidence: 0.9 }),
  );
  assert.ok(modelIntent);

  const resolved = resolveRoutedMissionIntent({
    mode: "authority",
    modelIntent,
    regexIntent,
  });
  assert.equal(resolved.source, "model");
  assert.notEqual(resolved.intent.writeScope, "none");

  const decision = evaluateToolPolicy({
    toolName: "create_file",
    args: {},
    intent: resolved.intent,
    approvalGranted: false,
    isDesktop: true,
    writeAutonomy: false,
  });
  assert.equal(decision.action, "allow");
  assert.ok(!decision.tags.includes("mutation_scope"));
});

/**
 * The ceiling half of the same seat must survive: a read-only mission exposes
 * no write tool, so the regex scope is already "none" and the mutation-scope
 * block keeps its full force. This is the half that made the min-intersection
 * look correct, and removing it would trade one defect for a worse one.
 */
test("mutation scope still blocks when the host exposes no write tool", () => {
  const missionIntent = intentFixture("Summarize what my notes say about X.");
  const regexIntent = deriveRoutedIntentFallback({
    missionIntent,
    writeAutonomy: false,
    writeToolExposed: false,
    prompt: "summarize my notes",
  });
  assert.equal(regexIntent.writeScope, "none");

  const modelIntent = normalizeRoutedMissionIntent(
    routedJson({ writeScope: "vault_files", confidence: 0.9 }),
  );
  assert.ok(modelIntent);

  const resolved = resolveRoutedMissionIntent({
    mode: "authority",
    modelIntent,
    regexIntent,
  });
  assert.equal(resolved.intent.writeScope, "none");

  const decision = evaluateToolPolicy({
    toolName: "create_file",
    args: {},
    intent: resolved.intent,
    approvalGranted: false,
    isDesktop: true,
    writeAutonomy: false,
  });
  assert.equal(decision.action, "block");
  assert.ok(decision.tags.includes("mutation_scope"));
});

test("resolveAuthoritativeWriteScopeV1 is a ceiling, never a floor", () => {
  // Authority can still never widen past the regex safety net.
  assert.equal(
    resolveAuthoritativeWriteScopeV1("vault_files", "current_note_append"),
    "current_note_append",
  );
  // Narrowing among write scopes is still allowed.
  assert.equal(
    resolveAuthoritativeWriteScopeV1("current_note_append", "vault_files"),
    "current_note_append",
  );
  // Revoking an offered mutation is not.
  assert.equal(resolveAuthoritativeWriteScopeV1("none", "vault_files"), "vault_files");
  // With nothing offered, "none" stands.
  assert.equal(resolveAuthoritativeWriteScopeV1("none", "none"), "none");
});
