import test from "node:test";
import assert from "node:assert/strict";
import { AgenticReflexController } from "../src/agent/reflex/AgenticReflexController";
import { evaluateCompletion } from "../src/agent/reflex/completionEvaluator";
import { evaluateProgress } from "../src/agent/reflex/progressMonitor";
import type { AgenticReflexInput } from "../src/agent/reflex/types";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import type { SemanticEmbeddingProvider } from "../src/embeddings/types";
import type { MissionIntent } from "../src/tools/types";
import type { AgentSettings } from "../src/settings";

const missionIntent: MissionIntent = {
  mode: "chat_only",
  vaultContext: false,
  noteOutput: false,
  explicitPersistence: false,
  explicitMutation: false,
  explicitDelete: false,
  allowAutonomousWrite: false,
  requireWriteCompletion: false,
  autonomyScope: {
    read: { currentNote: false, vault: false, folders: [], files: [], web: false },
    write: { currentNote: false, folders: [], files: [], artifacts: false, researchMemory: false },
    destructive: { replaceCurrentNote: false, deleteCurrentNote: false, deletePaths: false },
  },
};

const embeddingProvider: SemanticEmbeddingProvider = {
  async embed(request) {
    const semanticVector = [1, 0];
    const otherVector = [0, 1];
    return {
      ok: true,
      model: request.model,
      dim: request.dim,
      documents: request.documents.map((text) =>
        /notes say|related ideas|conceptually/i.test(text)
          ? semanticVector
          : otherVector,
      ),
      queries: request.queries.map((text) =>
        /notes say|related ideas|conceptually/i.test(text)
          ? semanticVector
          : otherVector,
      ),
    };
  },
};

const reflexSettings: AgentSettings = {
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
  agenticReflexDiagnosticsEnabled: true,
  semanticSearchEnabled: true,
  semanticEmbeddingModel: "nomic-embed-text",
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
};

function input(overrides: Partial<AgenticReflexInput> = {}): AgenticReflexInput {
  return {
    prompt: "What do my notes say about agent autonomy?",
    missionIntent,
    allowedToolNames: new Set(["semantic_search_notes", "search_markdown_files"]),
    recentActions: [],
    evidence: [],
    receipts: [],
    settings: reflexSettings,
    embeddingProvider,
    ...overrides,
  };
}

test("reflex controller classifies semantic vault intent and scores semantic action", async () => {
  const output = await new AgenticReflexController().evaluate(input());
  assert.equal(output.intent.label, "semantic_vault_search");
  assert.equal(output.intent.reason, "embedding_prototype_match");
  assert.equal(output.actionScores[0].action.toolName, "semantic_search_notes");
});

test("reflex controller falls back when disabled", async () => {
  const output = await new AgenticReflexController().evaluate(
    input({
      settings: { ...reflexSettings, agenticReflexEnabled: false },
      embeddingProvider,
    }),
  );
  assert.equal(output.intent.label, "unknown");
  assert.equal(output.intent.reason, "disabled");
});

test("progress monitor flags repeated no-evidence tool calls", () => {
  const progress = evaluateProgress(
    input({
      recentActions: [
        { kind: "tool", name: "search_markdown_files", signature: "s:1", ok: true },
        { kind: "tool", name: "search_markdown_files", signature: "s:1", ok: true },
        { kind: "tool", name: "search_markdown_files", signature: "s:1", ok: true },
      ],
    }),
  );
  assert.equal(progress.shouldStop, true);
  assert.equal(progress.reason, "repeated_tool_calls_without_new_evidence");
});

test("completion evaluator requires vault evidence and write receipts", () => {
  const completion = evaluateCompletion(
    input({
      missionIntent: {
        ...missionIntent,
        mode: "note_output",
        noteOutput: true,
        allowAutonomousWrite: true,
        requireWriteCompletion: true,
      },
      prompt: "Search my notes and write the answer to the note.",
    }),
  );
  assert.deepEqual(completion.missing.sort(), ["vault_evidence", "write_receipt"]);
  assert.equal(completion.mustContinue, true);
  assert.equal(completion.recommendedNextTool, "semantic_search_notes");
});

test("completion evaluator recommends available recovery tools before final answer", () => {
  const completion = evaluateCompletion(
    input({
      prompt: "Verify this with web sources before answering.",
      allowedToolNames: new Set(["web_search", "web_fetch"]),
    }),
  );

  assert.equal(completion.complete, false);
  assert.equal(completion.mustContinue, true);
  assert.equal(completion.recommendedNextTool, "web_fetch");
});

test("completion evaluator accepts broad unscoped mutation as a safety blocker", () => {
  const prompt = "Update my whole vault with this project summary.";
  const completion = evaluateCompletion(
    input({
      prompt,
      missionIntent: {
        ...missionIntent,
        mode: "explicit_file_mutation",
        vaultContext: true,
        explicitMutation: true,
        allowAutonomousWrite: false,
        requireWriteCompletion: false,
        autonomyScope: deriveAutonomyScope(prompt, {
          noteOutput: true,
          explicitMutation: true,
          explicitPersistence: true,
        }),
      },
      allowedToolNames: new Set(["list_markdown_files", "read_file"]),
    }),
  );

  assert.equal(completion.complete, true);
  assert.deepEqual(completion.missing, []);
  assert.equal(completion.mustContinue, false);
  assert.equal(
    completion.reason,
    "broad_unscoped_mutation_requires_explicit_scope",
  );
});
