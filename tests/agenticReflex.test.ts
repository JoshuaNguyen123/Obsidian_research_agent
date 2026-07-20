import test from "node:test";
import assert from "node:assert/strict";
import { AgenticReflexController } from "../src/agent/reflex/AgenticReflexController";
import { evaluateCompletion } from "../src/agent/reflex/completionEvaluator";
import { evaluateProgress } from "../src/agent/reflex/progressMonitor";
import { buildReflexCheckpointReceiptV1 } from "../src/agent/reflex/checkpointReceipt";
import type { AgenticReflexInput } from "../src/agent/reflex/types";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import {
  createMissionLedger,
  formatMissionLedgerBlock,
  parseMissionLedgerFromMarkdown,
} from "../src/agent/missionLedger";
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
  assert.equal(output.intent.version, 2);
  assert.ok(output.intent.winningMargin >= 0.08);
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
  assert.equal(progress.correction, "block");
});

test("reflex controller fails closed when the embedding provider throws", async () => {
  const output = await new AgenticReflexController().evaluate(
    input({
      embeddingProvider: {
        async embed() {
          throw new Error("helper unavailable at C:\\private\\semantic with lin_api_secret");
        },
      },
    }),
  );
  assert.equal(output.intent.label, "unknown");
  assert.equal(output.intent.reason, "embedding_provider_failed");
  assert.equal(output.intent.reasonCode, "embedding_provider_unavailable");
  assert.equal(JSON.stringify(output).includes("private"), false);
});

test("progress monitor corrects once then blocks an unchanged frontier even with old evidence", () => {
  const priorEvidence = [{
    id: "old",
    kind: "tool_result" as const,
    title: "Old evidence",
    summary: "Predates this loop.",
    confidence: "high" as const,
  }];
  const two = evaluateProgress(input({
    evidence: priorEvidence,
    recentActions: [
      { kind: "tool", signature: "same", stateFingerprint: "frontier-a" },
      { kind: "tool", signature: "same", stateFingerprint: "frontier-a" },
    ],
  }));
  assert.equal(two.shouldReflect, true);
  assert.equal(two.shouldStop, false);
  assert.equal(two.correction, "reflect_once");
  const three = evaluateProgress(input({
    evidence: priorEvidence,
    recentActions: [
      { kind: "tool", signature: "same", stateFingerprint: "frontier-a" },
      { kind: "tool", signature: "same", stateFingerprint: "frontier-a" },
      { kind: "tool", signature: "same", stateFingerprint: "frontier-a" },
    ],
  }));
  assert.equal(three.shouldStop, true);
});

test("explicit negation and deterministic mutation authority override semantic routing", async () => {
  const negated = await new AgenticReflexController().evaluate(input({
    prompt: "Do not search my vault; answer only from this prompt.",
  }));
  assert.equal(negated.intent.label, "unknown");
  assert.equal(negated.intent.reasonCode, "negated_intent");

  const mutation = await new AgenticReflexController().evaluate(input({
    missionIntent: {
      ...missionIntent,
      mode: "explicit_file_mutation",
      explicitMutation: true,
    },
  }));
  assert.equal(mutation.intent.reasonCode, "deterministic_authority");
});

test("reflex checkpoint receipts contain only redacted metadata and stable counters", async () => {
  const output = await new AgenticReflexController().evaluate(input());
  const receipt = buildReflexCheckpointReceiptV1({
    runId: "run-reflex",
    checkpoint: "initial_routing",
    decision: output.intent,
    actionCount: 2,
    evidenceCount: 1,
    receiptCount: 0,
    readinessSummary: {
      total: 99,
      ok: 2,
      degraded: 1,
      blocked: 0,
      unknown: 1,
    },
    progressScore: 0.75,
    loopRiskScore: 0.25,
    completionMissing: ["vault_evidence", "private path C:\\Users\\secret"],
    proofDebt: ["mission_plan:semantic_search_notes"],
    recoveryOutcome: "replan_scheduled",
    frontierFingerprint: `sha256:${"a".repeat(64)}`,
    observedAt: "2026-07-16T00:00:00.000Z",
  });
  const serialized = JSON.stringify(receipt);
  assert.match(receipt.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(serialized.includes("What do my notes say"), false);
  assert.equal(serialized.includes("Users"), false);
  assert.equal(receipt.actionCount, 2);
  assert.equal(receipt.confidence, output.intent.confidence);
  assert.equal(receipt.winningMargin, output.intent.winningMargin);
  assert.equal(receipt.suggestedAction, "semantic_search_notes");
  assert.equal(receipt.allowedAction, "semantic_search_notes");
  assert.deepEqual(receipt.readinessSummary, {
    total: 4,
    ok: 2,
    degraded: 1,
    blocked: 0,
    unknown: 1,
  });
  assert.equal(receipt.progressScore, 0.75);
  assert.equal(receipt.loopRiskScore, 0.25);
  assert.deepEqual(receipt.completionMissing, ["redacted", "vault_evidence"]);
  assert.deepEqual(receipt.proofDebt, ["mission_plan:semantic_search_notes"]);
  assert.equal(receipt.recoveryOutcome, "replan_scheduled");

  const laterReceipt = buildReflexCheckpointReceiptV1({
    runId: "run-reflex",
    checkpoint: "initial_routing",
    decision: output.intent,
    actionCount: 2,
    evidenceCount: 1,
    receiptCount: 0,
    readinessSummary: receipt.readinessSummary,
    progressScore: 0.75,
    loopRiskScore: 0.25,
    completionMissing: ["vault_evidence", "private path C:\\Users\\secret"],
    proofDebt: ["mission_plan:semantic_search_notes"],
    recoveryOutcome: "replan_scheduled",
    frontierFingerprint: `sha256:${"a".repeat(64)}`,
    observedAt: "2026-07-17T00:00:00.000Z",
  });
  assert.equal(laterReceipt.fingerprint, receipt.fingerprint);
});

test("legacy reflex checkpoint receipts remain readable without new diagnostics", async () => {
  const output = await new AgenticReflexController().evaluate(input());
  const current = buildReflexCheckpointReceiptV1({
    runId: "run-reflex-legacy",
    checkpoint: "initial_routing",
    decision: output.intent,
    actionCount: 1,
    evidenceCount: 0,
    receiptCount: 0,
    observedAt: "2026-07-16T00:00:00.000Z",
  });
  const {
    confidence: _confidence,
    winningMargin: _winningMargin,
    suggestedAction: _suggestedAction,
    allowedAction: _allowedAction,
    readinessSummary: _readinessSummary,
    progressScore: _progressScore,
    loopRiskScore: _loopRiskScore,
    completionMissing: _completionMissing,
    proofDebt: _proofDebt,
    recoveryOutcome: _recoveryOutcome,
    ...legacy
  } = current;
  const ledger = createMissionLedger({
    runId: "run-reflex-legacy",
    mission: "Legacy checkpoint normalization",
    route: "direct",
    loopBudget: {
      hardCap: 4,
      toolStepBudget: 3,
      finalizationReserve: 1,
      expectedTools: [],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-07-16T00:00:00.000Z"),
  });
  ledger.reflexCheckpoints = [legacy];
  const restored = parseMissionLedgerFromMarkdown(formatMissionLedgerBlock(ledger));
  assert.equal(restored?.reflexCheckpoints?.length, 1);
  assert.equal(restored?.reflexCheckpoints?.[0]?.fingerprint, legacy.fingerprint);
  assert.equal(restored?.reflexCheckpoints?.[0]?.confidence, undefined);
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
