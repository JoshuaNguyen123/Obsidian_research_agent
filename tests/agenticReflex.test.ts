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
import {
  createToolOutcomeMemory,
  recordToolOutcome,
} from "../src/agent/outcomeMemory";
import { completedResearchPublicationReceiptFixture } from "./fixtures/completedResearchPublicationReceipt";

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

test("reflex action scoring preserves the pre-memory scores when history is absent", async () => {
  const output = await new AgenticReflexController().evaluate(input());
  const semantic = output.actionScores.find(
    (item) => item.action.toolName === "semantic_search_notes",
  );
  assert.ok(semantic);
  assert.equal(semantic.baseScore, semantic.score);
  assert.equal(semantic.outcomePenalty, 0);
});

test("repeated matching failures down-rank a tool without removing it", async () => {
  let memory = createToolOutcomeMemory();
  for (let index = 0; index < 5; index += 1) {
    memory = recordToolOutcome(memory, {
      toolName: "semantic_search_notes",
      ok: false,
      errorCode: "semantic_helper_unavailable",
      targetKind: "vault_note",
      observedAt: `2026-07-24T00:00:0${index}.000Z`,
    });
  }

  const output = await new AgenticReflexController().evaluate(
    // Outcome history is recency-weighted, so the read instant is pinned next to
    // the fixture rather than left to drift with the wall clock.
    input({
      outcomeMemory: {
        memory,
        now: new Date("2026-07-24T01:00:00.000Z"),
      },
    }),
  );
  const semantic = output.actionScores.find(
    (item) => item.action.toolName === "semantic_search_notes",
  );
  assert.ok(semantic);
  assert.ok(semantic.outcomePenalty > 0);
  assert.ok(semantic.score < semantic.baseScore);
  assert.match(semantic.reason, /Learned outcome penalty=/u);
  assert.notEqual(
    output.actionScores[0]?.action.toolName,
    "semantic_search_notes",
  );
  assert.ok(
    output.actionScores.some(
      (item) => item.action.toolName === "semantic_search_notes",
    ),
    "learned history must never remove an authorized tool",
  );
});

test("generic graph candidates use their tool-derived target kind for learned ranking", async () => {
  let memory = createToolOutcomeMemory();
  for (let index = 0; index < 3; index += 1) {
    memory = recordToolOutcome(memory, {
      toolName: "get_note_graph_context",
      ok: false,
      errorCode: "mission_graph_authority_blocked",
      targetKind: "vault_note",
      observedAt: `2026-07-24T00:01:0${index}.000Z`,
    });
  }

  const output = await new AgenticReflexController().evaluate(
    input({
      allowedToolNames: new Set([
        "get_note_graph_context",
        "list_markdown_files",
      ]),
      outcomeMemory: {
        memory,
        now: new Date("2026-07-24T01:00:00.000Z"),
      },
    }),
  );
  const graph = output.actionScores.find(
    (item) => item.action.toolName === "get_note_graph_context",
  );
  assert.ok(graph);
  assert.equal(graph.action.kind, "use_tool");
  assert.ok(graph.outcomePenalty > 0);
  assert.ok(graph.score < graph.baseScore);
});

test("learned ranking reads the instant it is given, never the wall clock", async () => {
  let memory = createToolOutcomeMemory();
  for (let index = 0; index < 3; index += 1) {
    memory = recordToolOutcome(memory, {
      toolName: "semantic_search_notes",
      ok: false,
      errorCode: "semantic_helper_unavailable",
      targetKind: "vault_note",
      observedAt: `2026-07-24T00:00:0${index}.000Z`,
    });
  }
  const penaltyAt = async (now: Date): Promise<number> => {
    const output = await new AgenticReflexController().evaluate(
      input({ outcomeMemory: { memory, now } }),
    );
    const semantic = output.actionScores.find(
      (item) => item.action.toolName === "semantic_search_notes",
    );
    assert.ok(semantic);
    return semantic.outcomePenalty;
  };

  // Same ledger, two supplied instants: the penalty must follow the argument.
  // Five half-lives on, the failures are noise and the penalty is gone. Before
  // the instant travelled with the history, this fixture read `new Date()` and
  // its verdict changed with the date the suite happened to run on.
  assert.ok((await penaltyAt(new Date("2026-07-24T01:00:00.000Z"))) > 0);
  assert.equal(await penaltyAt(new Date("2026-12-20T00:00:00.000Z")), 0);
});

test("one failure is noise and a different target kind does not affect ranking", async () => {
  const once = recordToolOutcome(createToolOutcomeMemory(), {
    toolName: "semantic_search_notes",
    ok: false,
    errorCode: "temporary",
    targetKind: "vault_note",
    observedAt: "2026-07-24T00:00:00.000Z",
  });
  let differentTarget = createToolOutcomeMemory();
  for (let index = 0; index < 5; index += 1) {
    differentTarget = recordToolOutcome(differentTarget, {
      toolName: "semantic_search_notes",
      ok: false,
      errorCode: "workspace_only",
      targetKind: "code_workspace",
      observedAt: `2026-07-24T00:00:1${index}.000Z`,
    });
  }

  for (const memory of [once, differentTarget]) {
    const output = await new AgenticReflexController().evaluate(
      input({
        outcomeMemory: {
          memory,
          now: new Date("2026-07-24T01:00:00.000Z"),
        },
      }),
    );
    const semantic = output.actionScores.find(
      (item) => item.action.toolName === "semantic_search_notes",
    );
    assert.ok(semantic);
    assert.equal(semantic.outcomePenalty, 0);
    assert.equal(semantic.score, semantic.baseScore);
  }
});

test("every allowed tool receives exactly one score including compound tools", async () => {
  const allowedToolNames = new Set([
    "semantic_search_notes",
    "code_workspace_create",
    "github_create_private_repository",
  ]);
  const output = await new AgenticReflexController().evaluate(
    input({ allowedToolNames }),
  );
  for (const toolName of allowedToolNames) {
    assert.equal(
      output.actionScores.filter((item) => item.action.toolName === toolName)
        .length,
      1,
    );
  }
  assert.equal(
    output.actionScores.find(
      (item) => item.action.toolName === "code_workspace_create",
    )?.action.kind,
    "use_tool",
  );
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

test("completion evaluator accepts only a canonical completed research publication as composite note-write proof", () => {
  const publication = completedResearchPublicationReceiptFixture();
  const publicationMissionIntent: MissionIntent = {
    ...missionIntent,
    mode: "note_output",
    noteOutput: true,
    allowAutonomousWrite: true,
    requireWriteCompletion: true,
  };

  const completed = evaluateCompletion(
    input({
      prompt: "Publish the accepted research note to exactly one Linear issue.",
      missionIntent: publicationMissionIntent,
      allowedToolNames: new Set(),
      receipts: [publication],
    }),
  );
  assert.equal(completed.complete, true);
  assert.deepEqual(completed.missing, []);

  const unverified = evaluateCompletion(
    input({
      prompt: "Publish the accepted research note to exactly one Linear issue.",
      missionIntent: publicationMissionIntent,
      allowedToolNames: new Set(),
      receipts: [
        {
          ...publication,
          readback: {
            ...publication.readback,
            status: "unverified",
          },
        },
      ],
    }),
  );
  assert.equal(unverified.complete, false);
  assert.deepEqual(unverified.missing, ["write_receipt"]);
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

test("completion evaluator does not demand research a mission explicitly forswears", () => {
  // Proof-matrix interrupted-continuation, 2026-08-26 02:16Z: the lane
  // mission ends with "This task needs no web, memory, or vault research."
  // — a sentence whose own tokens match \bweb\b and \bvault\b (and its
  // ordered write contract's "verify that write" matches \bverify\b). The
  // negation-blind triggers demanded web_evidence + vault_evidence forever,
  // burning every continuation step in completion corrections and then
  // terminal-failing an acceptance-passing run.
  const forswearing = evaluateCompletion(
    input({
      prompt:
        "Perform exactly two ordered durable appends to the current note, then finish. " +
        "First append exactly one line containing MARKER_A1 and verify that write. " +
        "Then append exactly one separate line containing MARKER_B2 and verify that write. " +
        "Two appends total, in that order. This task needs no web, memory, or vault research.",
    }),
  );
  assert.equal(
    forswearing.missing.includes("web_evidence"),
    false,
    JSON.stringify(forswearing),
  );
  assert.equal(
    forswearing.missing.includes("vault_evidence"),
    false,
    JSON.stringify(forswearing),
  );

  // Without the forswearing clause the triggers keep their teeth.
  const demanding = evaluateCompletion(
    input({
      prompt: "Verify this with web sources and check my vault notes.",
      allowedToolNames: new Set(["web_search", "web_fetch"]),
    }),
  );
  assert.equal(demanding.missing.includes("web_evidence"), true);
  assert.equal(demanding.missing.includes("vault_evidence"), true);
});

test("reflex classification yields the aborted fallback while the embedder is still pending", async () => {
  // The interrupted-continuation lane died seven times in a row because the
  // runner awaited an embedding helper that cannot be cancelled: after
  // disablePlugin the old coordinator could not reach its stop boundary. The
  // classification must race the run's abort signal instead.
  let embedCalls = 0;
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = new AgenticReflexController().evaluate(
    input({
      embeddingProvider: {
        embed() {
          embedCalls += 1;
          return new Promise(() => undefined);
        },
      },
      abortSignal: controller.signal,
    }),
  );
  setTimeout(() => controller.abort(new Error("Mission was stopped.")), 20);
  const output = await pending;
  assert.ok(Date.now() - startedAt < 2_000, "the aborted run did not wait for the helper");
  assert.equal(embedCalls, 1);
  assert.equal(output.intent.label, "unknown");
  assert.equal(output.intent.reason, "run_aborted");
  assert.equal(output.intent.reasonCode, "embedding_provider_unavailable");
  assert.equal(output.intent.applied, false);

  // An already-stopped run never asks the helper at all.
  let lateCalls = 0;
  const stopped = new AbortController();
  stopped.abort(new Error("Mission was stopped."));
  const late = await new AgenticReflexController().evaluate(
    input({
      embeddingProvider: {
        async embed() {
          lateCalls += 1;
          throw new Error("must not be called");
        },
      },
      abortSignal: stopped.signal,
    }),
  );
  assert.equal(lateCalls, 0);
  assert.equal(late.intent.reason, "run_aborted");
});

test("reflex embeds prototypes and the prompt with the index's prefixes and effective dimension", async () => {
  // The prototypes used to be embedded bare while every document in the vault
  // index carried the model's prefix; on nomic that is two input conventions
  // compared against each other. Both calls must carry what the index carries.
  const requests: Array<{
    dim: number;
    matryoshka?: boolean;
    queryPrefix?: string;
    documentPrefix?: string;
  }> = [];
  const recordingProvider: SemanticEmbeddingProvider = {
    async embed(request) {
      requests.push({
        dim: request.dim,
        matryoshka: request.matryoshka,
        queryPrefix: request.queryPrefix,
        documentPrefix: request.documentPrefix,
      });
      return embeddingProvider.embed(request);
    },
  };
  const output = await new AgenticReflexController().evaluate(
    input({
      embeddingProvider: recordingProvider,
      settings: {
        ...reflexSettings,
        semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
        semanticEmbeddingDim: 256,
      },
    }),
  );
  assert.equal(output.intent.label, "semantic_vault_search");
  assert.ok(requests.length >= 1);
  for (const request of requests) {
    assert.equal(request.queryPrefix, "search_query: ");
    assert.equal(request.documentPrefix, "search_document: ");
    assert.equal(request.dim, 256);
    assert.equal(request.matryoshka, true);
  }
});

test("reflex asks a non-Matryoshka model for its native width whatever the setting says", async () => {
  const dims: number[] = [];
  const flags: Array<boolean | undefined> = [];
  const recordingProvider: SemanticEmbeddingProvider = {
    async embed(request) {
      dims.push(request.dim);
      flags.push(request.matryoshka);
      return embeddingProvider.embed(request);
    },
  };
  await new AgenticReflexController().evaluate(
    input({
      embeddingProvider: recordingProvider,
      settings: {
        ...reflexSettings,
        semanticEmbeddingModel: "BAAI/bge-small-en-v1.5",
        semanticEmbeddingDim: 512,
      },
    }),
  );
  assert.ok(dims.length >= 1);
  assert.ok(dims.every((dim) => dim === 384), JSON.stringify(dims));
  assert.ok(flags.every((flag) => flag === false));
});
