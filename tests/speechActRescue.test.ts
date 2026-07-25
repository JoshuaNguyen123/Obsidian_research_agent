import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSettings } from "../src/settings";
import type { SemanticEmbeddingProvider } from "../src/embeddings/types";
import { classifyMissionSpeechAct } from "../src/agent/missionSpeechAct";
import {
  isSpeechActRescueMissCandidate,
  proposeSpeechActRescueV1,
} from "../src/agent/speechActRescue";

/**
 * 2-dim orthogonal stub keyed by exemplar text (house pattern from
 * tests/researchTeamDispatch.test.ts): documents matching the
 * execute_code_deliverable exemplars embed as [1,0]; everything else [0,1].
 * Queries embed as [1,0] so execute_code_deliverable wins at score 1.
 */
function executeDeliverableProvider(): SemanticEmbeddingProvider {
  return {
    async embed(request) {
      return {
        ok: true,
        documents: request.documents.map((document) =>
          /desktop|downloads folder|documents folder/iu.test(document)
            ? [1, 0]
            : [0, 1],
        ),
        queries: request.queries.map(() => [1, 0]),
      };
    },
  } as SemanticEmbeddingProvider;
}

function throwingProvider(): SemanticEmbeddingProvider {
  return {
    async embed() {
      throw new Error("embedding backend unavailable");
    },
  } as SemanticEmbeddingProvider;
}

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    speechActSemanticRescueMode: "shadow",
    semanticEmbeddingModel: "stub-model",
    semanticEmbeddingDim: 512,
    semanticModelCacheDir: "",
    ...overrides,
  } as AgentSettings;
}

const MISS_PROMPT = "any chance you could get that little game thing onto my machine";

test("rescue is disabled entirely in off mode and when the field is absent", async () => {
  const deterministic = classifyMissionSpeechAct(MISS_PROMPT);
  assert.equal(
    await proposeSpeechActRescueV1({
      prompt: MISS_PROMPT,
      deterministic,
      settings: settings({ speechActSemanticRescueMode: "off" }),
      embeddingProvider: executeDeliverableProvider(),
    }),
    null,
  );
  assert.equal(
    await proposeSpeechActRescueV1({
      prompt: MISS_PROMPT,
      deterministic,
      settings: settings({ speechActSemanticRescueMode: undefined }),
      embeddingProvider: executeDeliverableProvider(),
    }),
    null,
  );
});

test("rescue never re-scores a deterministic execute/persist decision", async () => {
  const executeClassification = classifyMissionSpeechAct(
    "create a number guessing game in Python on my desktop",
  );
  assert.equal(executeClassification.speechAct, "execute");
  assert.equal(isSpeechActRescueMissCandidate(executeClassification), false);
  assert.equal(
    await proposeSpeechActRescueV1({
      prompt: "create a number guessing game in Python on my desktop",
      deterministic: executeClassification,
      settings: settings(),
      embeddingProvider: executeDeliverableProvider(),
    }),
    null,
  );
});

test("explicit chat-only stays a hard deterministic veto", async () => {
  const chatOnly = classifyMissionSpeechAct(
    "Chat-only: what would a desktop delivery involve?",
  );
  assert.equal(chatOnly.explicitChatOnly, true);
  assert.equal(isSpeechActRescueMissCandidate(chatOnly), false);
});

test("a confident aligned exemplar produces an auditable execute proposal", async () => {
  const deterministic = classifyMissionSpeechAct(MISS_PROMPT);
  assert.equal(deterministic.reasons[0], "ordinary_answer");
  const proposal = await proposeSpeechActRescueV1({
    prompt: MISS_PROMPT,
    deterministic,
    settings: settings(),
    embeddingProvider: executeDeliverableProvider(),
  });
  assert.ok(proposal);
  assert.equal(proposal.speechAct, "execute");
  assert.equal(proposal.executionTier, "bounded_tool");
  assert.equal(proposal.label, "execute_code_deliverable");
  assert.ok(proposal.score >= 0.72);
  assert.ok(proposal.margin >= 0.08);
  assert.ok(
    proposal.reasons.includes("semantic_rescue:execute_code_deliverable"),
  );
});

test("embedding failure and missing provider fail closed", async () => {
  const deterministic = classifyMissionSpeechAct(MISS_PROMPT);
  assert.equal(
    await proposeSpeechActRescueV1({
      prompt: MISS_PROMPT,
      deterministic,
      settings: settings({ semanticEmbeddingModel: "stub-model-throwing" }),
      embeddingProvider: throwingProvider(),
    }),
    null,
  );
  assert.equal(
    await proposeSpeechActRescueV1({
      prompt: MISS_PROMPT,
      deterministic,
      settings: settings(),
      embeddingProvider: undefined,
    }),
    null,
  );
});

test("a provider that never settles fails closed at the bounded timeout", async () => {
  const deterministic = classifyMissionSpeechAct(MISS_PROMPT);
  const neverSettles: SemanticEmbeddingProvider = {
    async embed() {
      return new Promise(() => undefined);
    },
  } as SemanticEmbeddingProvider;
  const startedAt = Date.now();
  const proposal = await proposeSpeechActRescueV1({
    prompt: MISS_PROMPT,
    deterministic,
    settings: settings({ semanticEmbeddingModel: "stub-model-timeout" }),
    embeddingProvider: neverSettles,
    timeoutMs: 5,
  });
  assert.equal(proposal, null);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("an ambiguous margin yields no proposal", async () => {
  const ambiguousProvider: SemanticEmbeddingProvider = {
    async embed(request) {
      return {
        ok: true,
        documents: request.documents.map(() => [1, 0]),
        queries: request.queries.map(() => [1, 0]),
      };
    },
  } as SemanticEmbeddingProvider;
  const deterministic = classifyMissionSpeechAct(MISS_PROMPT);
  assert.equal(
    await proposeSpeechActRescueV1({
      prompt: MISS_PROMPT,
      deterministic,
      settings: settings({ semanticEmbeddingModel: "stub-model-ambiguous" }),
      embeddingProvider: ambiguousProvider,
    }),
    null,
  );
});
