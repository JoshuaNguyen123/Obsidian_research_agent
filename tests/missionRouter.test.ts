import test from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_ROUTER_SCHEMA,
  ROUTER_AUTHORITY_CONFIDENCE_THRESHOLD,
  classifyMissionWithModel,
  intersectAuthoritativeIntent,
  normalizeModelRouterMode,
  normalizeRoutedMissionIntent,
  resolveModelRouterMode,
  resolveRoutedMissionIntent,
  saferWriteScope,
} from "../src/agent/missionRouter";
import {
  deriveRoutedIntentFallback,
  resolvePolicyRoutedIntent,
} from "../src/agent/policyEngine";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import type { MissionIntent } from "../src/tools/types";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelClient,
} from "../src/model/types";

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
  assert.equal(requests[0].options?.temperature, 0);
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
