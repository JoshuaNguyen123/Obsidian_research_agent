import assert from "node:assert/strict";
import test from "node:test";

import {
  RESEARCH_TEAM_KEYWORD_FLOOR,
  resolveResearchTeamDispatchV1,
  type ResearchTeamDispatchInputV1,
} from "../src/agent/researchTeamDispatch";
import { shouldUseResearchTeam } from "../src/orchestrator/orchestratorRuntime";
import type { SemanticEmbeddingProvider } from "../src/embeddings/types";
import type { AgentSettings } from "../src/settings";

function dispatchInput(
  prompt: string,
  overrides: Partial<ResearchTeamDispatchInputV1> = {},
): ResearchTeamDispatchInputV1 {
  return {
    prompt,
    orchestratorEnabled: true,
    forceChatOnly: false,
    ...overrides,
  };
}

test("hard negatives veto every other layer", async () => {
  const disabled = await resolveResearchTeamDispatchV1(
    dispatchInput("Deep research the latest sources on WASM GC", {
      orchestratorEnabled: false,
    }),
  );
  assert.equal(disabled.useTeam, false);
  assert.deepEqual(disabled.signals, ["orchestrator_disabled"]);

  const chatOnly = await resolveResearchTeamDispatchV1(
    dispatchInput("Verify sources for this claim", { forceChatOnly: true }),
  );
  assert.equal(chatOnly.useTeam, false);
  assert.deepEqual(chatOnly.signals, ["chat_only"]);

  const literary = await resolveResearchTeamDispatchV1(
    dispatchInput(
      "Write an essay on The Catcher in the Rye with citations from the text",
    ),
  );
  assert.equal(literary.useTeam, false);
  assert.deepEqual(literary.signals, ["literary_primary_text"]);
});

test("the deterministic keyword floor accepts everything the old regex accepted", async () => {
  const floorPositives = [
    "Do deep research on quantum error correction",
    "Investigate the incident timeline",
    "Find sources for this claim",
    "Add citations for every claim",
    "Verify this statement",
    "Fact-check the announcement",
    "Collect evidence about the outage",
    "Compare sources on this topic",
    "Summarize current events in AI regulation",
    "What are the latest sources on battery chemistry?",
    "Run web research on this",
    "Do vault research about my meeting notes",
  ];
  for (const prompt of floorPositives) {
    assert.equal(
      RESEARCH_TEAM_KEYWORD_FLOOR.test(prompt),
      true,
      `floor should match: ${prompt}`,
    );
    const decision = await resolveResearchTeamDispatchV1(dispatchInput(prompt));
    assert.equal(decision.useTeam, true, prompt);
    assert.deepEqual(decision.signals, ["keyword_floor"], prompt);
    // The deprecated sync wrapper must agree on layers 1-2.
    assert.equal(shouldUseResearchTeam(prompt, true), true, prompt);
  }
});

test("deliberate negatives stay single-agent", async () => {
  const negatives = [
    "Research this topic",
    "Research my garden layout",
    "Write a note about my day",
    "Summarize the meeting transcript below",
    "Draft an outline for my talk",
    "Rename the current file to Weekly Plan",
  ];
  for (const prompt of negatives) {
    const decision = await resolveResearchTeamDispatchV1(dispatchInput(prompt));
    assert.equal(decision.useTeam, false, prompt);
    assert.equal(shouldUseResearchTeam(prompt, true), false, prompt);
  }
});

test("structural signals widen deterministically without floor keywords", async () => {
  const multiUrl = await resolveResearchTeamDispatchV1(
    dispatchInput(
      "Reconcile https://example.com/a-report and https://example.org/b-analysis into one note",
    ),
  );
  assert.equal(multiUrl.useTeam, true);
  assert.ok(multiUrl.signals.includes("multiple_urls"));

  const singleUrl = await resolveResearchTeamDispatchV1(
    dispatchInput("Summarize https://example.com/a-report into one note"),
  );
  assert.equal(singleUrl.useTeam, false, "one URL alone is not multi-source research");

  const duplicateUrl = await resolveResearchTeamDispatchV1(
    dispatchInput(
      "Summarize https://example.com/a and https://example.com/a again",
    ),
  );
  assert.equal(duplicateUrl.useTeam, false, "duplicate URLs count once");

  const deep = await resolveResearchTeamDispatchV1(
    dispatchInput("I need an exhaustive systematic review of sleep studies"),
  );
  assert.equal(deep.useTeam, true);
  assert.ok(deep.signals.includes("explicitly_deep"));

  const comparative = await resolveResearchTeamDispatchV1(
    dispatchInput("Which is better for embedded work: Rust vs. Zig as of 2026?"),
  );
  assert.equal(comparative.useTeam, true);
  assert.ok(comparative.signals.includes("comparative_or_temporal"));
});

test("the embedding widener is inert without settings or a provider and cannot veto", async () => {
  // No settings/provider: prompts without deterministic signals stay single-agent.
  const bare = await resolveResearchTeamDispatchV1(
    dispatchInput("Tell me about the history of tea"),
  );
  assert.equal(bare.useTeam, false);
  assert.deepEqual(bare.signals, ["no_signal"]);

  // Reflex disabled: layer stays inert even with a provider present.
  const disabled = await resolveResearchTeamDispatchV1(
    dispatchInput("Tell me about the history of tea", {
      settings: dispatchSettings({ agenticReflexEnabled: false }),
      embeddingProvider: webResearchProvider(),
    }),
  );
  assert.equal(disabled.useTeam, false);

  // A provider that would classify chat_answer can never veto the floor.
  const floorWins = await resolveResearchTeamDispatchV1(
    dispatchInput("Verify sources for this claim", {
      settings: dispatchSettings(),
      embeddingProvider: chatAnswerProvider(),
    }),
  );
  assert.equal(floorWins.useTeam, true);
  assert.deepEqual(floorWins.signals, ["keyword_floor"]);

  // A throwing provider fails closed to the deterministic outcome.
  const throwing = await resolveResearchTeamDispatchV1(
    dispatchInput("Tell me about the history of tea", {
      settings: dispatchSettings(),
      embeddingProvider: {
        async embed() {
          throw new Error("embedding backend offline");
        },
      },
    }),
  );
  assert.equal(throwing.useTeam, false);
});

test("the embedding widener opens the team for high-confidence web research", async () => {
  const decision = await resolveResearchTeamDispatchV1(
    dispatchInput("Find current information and citations for this topic online", {
      settings: dispatchSettings(),
      embeddingProvider: webResearchProvider(),
    }),
  );
  // This prompt also hits the keyword floor ("citations"); use one that does not.
  assert.equal(decision.useTeam, true);

  const widened = await resolveResearchTeamDispatchV1(
    dispatchInput("What changed online about this topic recently?", {
      settings: dispatchSettings(),
      embeddingProvider: webResearchProvider(),
    }),
  );
  assert.equal(widened.useTeam, true, widened.reason);
  assert.equal(widened.signals[0], "embedding_web_research");
});

/**
 * Vector stub aligned with the web_research prototypes ("Research this online
 * with sources." / "Find current information and citations." / "Verify this
 * using web sources.") so any query scores 1.0 against web_research and 0
 * against everything else.
 */
function webResearchProvider(): SemanticEmbeddingProvider {
  const webVector = [1, 0];
  const otherVector = [0, 1];
  const isWebPrototype = (text: string) =>
    /online with sources|current information|web sources/i.test(text);
  return {
    async embed(request) {
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map((text) =>
          isWebPrototype(text) ? webVector : otherVector,
        ),
        queries: request.queries.map(() => webVector),
      };
    },
  };
}

/** Every query aligns with chat_answer prototypes instead. */
function chatAnswerProvider(): SemanticEmbeddingProvider {
  const chatVector = [1, 0];
  const otherVector = [0, 1];
  const isChatPrototype = (text: string) =>
    /answer this question|explain this concept|concise answer/i.test(text);
  return {
    async embed(request) {
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map((text) =>
          isChatPrototype(text) ? chatVector : otherVector,
        ),
        queries: request.queries.map(() => chatVector),
      };
    },
  };
}

function dispatchSettings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    modelProvider: "ollama",
    ollamaApiKey: "",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    openAiCompatibleApiKey: "",
    openAiCompatibleBaseUrl: "https://api.openai.com/v1",
    model: "test-model",
    enableStreaming: true,
    requestTimeoutMs: 120000,
    maxAgentSteps: 10,
    thinkingMode: "auto",
    streamWritebackMode: "all_current_note_content_writes",
    templateFolder: "Templates",
    templateOutputFolder: "",
    researchMemoryEnabled: true,
    researchMemoryFolder: "Agent Research Memory",
    companionBaseUrl: "http://127.0.0.1:8765",
    browserToolsEnabled: false,
    experienceMemoryEnabled: false,
    defaultBrowserMissionMode: "supervised",
    agenticReflexEnabled: true,
    agenticReflexDiagnosticsEnabled: false,
    semanticSearchEnabled: true,
    semanticEmbeddingModel: "research-team-dispatch-test-model",
    semanticEmbeddingDim: 512,
    semanticChunkMinTokens: 300,
    semanticChunkTargetTokens: 500,
    semanticChunkMaxTokens: 700,
    semanticChunkOverlapTokens: 80,
    semanticPythonCommand: "",
    semanticModelCacheDir: "",
    semanticIndexEnabled: false,
    semanticIndexFolder: "Agent Memory",
    semanticIndexDebounceMs: 3000,
    semanticIndexMaxFiles: 1000,
    semanticIndexPersistVectors: true,
    temperature: null,
    topK: null,
    topP: null,
    numCtx: null,
    ...overrides,
  } as AgentSettings;
}
