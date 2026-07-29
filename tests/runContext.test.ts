import test from "node:test";
import assert from "node:assert/strict";
import type { ModelChatMessage } from "../src/model/types";
import { createMissionLedger } from "../src/agent/missionLedger";
import {
  COMPACTION_THRESHOLD_RATIO,
  DEFAULT_ASSUMED_NUM_CTX,
  compactLoopMessages,
  createRunContextBudget,
  estimatePromptChars,
  resolveKeepRecentLoopSteps,
  resolveRunContextBudgetSource,
  shouldCompactLoopMessages,
} from "../src/agent/runContext";
import { resolveConversationPromptCharBudget } from "../src/memory/contextCompaction";
import {
  buildContinuationHandoffV1,
  continuationProgressFingerprintV1,
  validateContinuationHandoffV1,
  type ContinuationHandoffV1,
} from "../src/agent/continuationMemory";

test("blank numCtx budgets as 48k tokens with assumed_48k source", () => {
  const budget = createRunContextBudget(null);
  assert.equal(DEFAULT_ASSUMED_NUM_CTX, 49_152);
  assert.equal(budget.budgetSource, "assumed_48k");
  assert.equal(budget.numCtx, null);
  assert.equal(
    budget.maxPromptChars,
    (DEFAULT_ASSUMED_NUM_CTX - 1500) * 4,
  );
  assert.ok(budget.maxPromptChars > 180_000);

  const explicit = createRunContextBudget(131_072);
  assert.equal(explicit.budgetSource, "setting");
  assert.equal(explicit.numCtx, 131_072);
  assert.ok(explicit.maxPromptChars > budget.maxPromptChars);

  assert.equal(resolveKeepRecentLoopSteps(40_000), 6);
  assert.equal(resolveKeepRecentLoopSteps(190_000), 10);
  assert.equal(resolveKeepRecentLoopSteps(320_000), 16);
  assert.equal(
    resolveConversationPromptCharBudget(budget.maxPromptChars),
    Math.min(120_000, Math.max(48_000, Math.floor(budget.maxPromptChars * 0.2))),
  );
});

test("model-reported context length budgets with model_reported source", () => {
  const reported = createRunContextBudget(196_608, "model_reported");
  assert.equal(reported.budgetSource, "model_reported");
  assert.equal(reported.numCtx, 196_608);
  assert.equal(reported.maxPromptChars, (196_608 - 1500) * 4);

  assert.equal(
    resolveRunContextBudgetSource({
      settingsNumCtx: 32_768,
      modelReportedContextLength: 196_608,
      resolvedNumCtx: 32_768,
    }),
    "setting",
  );
  assert.equal(
    resolveRunContextBudgetSource({
      settingsNumCtx: null,
      modelReportedContextLength: 196_608,
      resolvedNumCtx: 196_608,
    }),
    "model_reported",
  );
  assert.equal(
    resolveRunContextBudgetSource({
      settingsNumCtx: null,
      modelReportedContextLength: null,
      resolvedNumCtx: null,
    }),
    "assumed_48k",
  );
  assert.equal(
    resolveRunContextBudgetSource({
      settingsNumCtx: null,
      modelReportedContextLength: null,
      resolvedNumCtx: 100_000,
    }),
    "setting",
  );
});

test("run context estimates prompt chars and compacts through ledger state", () => {
  const messages: ModelChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "system", content: "mission plan: keep me" },
    { role: "user", content: "latest user mission" },
  ];
  for (let index = 0; index < 10; index += 1) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ name: "read_file", arguments: { path: `${index}.md` } }],
    });
    messages.push({
      role: "tool",
      toolName: "read_file",
      content: "x".repeat(200),
    });
  }

  const estimated = estimatePromptChars(messages);
  assert.ok(estimated > 0);
  // Comfortably under 85% → do not compact.
  const underBudget = {
    numCtx: 1600,
    maxPromptChars: Math.ceil(estimated / 0.5),
    budgetSource: "setting" as const,
  };
  assert.equal(shouldCompactLoopMessages(messages, underBudget), false);
  const tinyBudget = { ...underBudget, maxPromptChars: 900 };
  assert.equal(shouldCompactLoopMessages(messages, tinyBudget), true);

  // Over 85% but under 100% → compact (AGENTS.md).
  const eightyFiveBudget = {
    numCtx: 1600,
    maxPromptChars: Math.floor(estimated / 0.9),
    budgetSource: "setting" as const,
  };
  assert.ok(estimated < eightyFiveBudget.maxPromptChars);
  assert.ok(
    estimated > eightyFiveBudget.maxPromptChars * COMPACTION_THRESHOLD_RATIO,
  );
  assert.equal(shouldCompactLoopMessages(messages, eightyFiveBudget), true);
  assert.equal(COMPACTION_THRESHOLD_RATIO, 0.85);

  const ledger = createMissionLedger({
    runId: "run-ctx",
    mission: "test compaction",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 100,
      toolStepBudget: 20,
      finalizationReserve: 4,
      expectedTools: ["read_file"],
      stopWhenSatisfied: true,
    },
  });
  ledger.evidence = [
    {
      id: "web:ctx",
      kind: "web_source",
      title: "Compacted source",
      url: "https://example.com/context",
      sourceId: "source:ctx",
      passageId: "source:ctx:passage:40-120",
      passageIds: ["source:ctx:passage:40-120"],
      summary: "Evidence that must remain citable after compaction.",
      confidence: "high",
    },
  ];
  const compacted = compactLoopMessages({ messages, ledger, keepRecentSteps: 3 });

  assert.equal(compacted.applied, true);
  assert.ok(compacted.estimatedCharsAfter < compacted.estimatedCharsBefore);
  assert.match(compacted.missionStateMessage ?? "", /Compacted mission state/);
  assert.match(
    compacted.missionStateMessage ?? "",
    /passage_citations=source:ctx:passage:40-120/,
  );
  assert.equal(compacted.messages[0].content, "system prompt");
  assert.ok(compacted.messages.some((message) => /mission plan/i.test(message.content)));
  assert.ok(compacted.messages.some((message) => message.content === "latest user mission"));
});

test("fingerprinted continuation handoff survives compaction and rejects tampering", () => {
  const ledger = createMissionLedger({
    runId: "run-handoff",
    mission: "Preserve durable proof",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 20,
      toolStepBudget: 16,
      finalizationReserve: 4,
      expectedTools: ["read_file"],
      stopWhenSatisfied: true,
    },
  });
  ledger.receipts = ["receipt-1"];
  ledger.approvals = [{
    id: "approval-1",
    toolName: "append_to_current_file",
    action: "append",
    decision: "approved",
    decidedAt: "2026-07-16T00:00:00.000Z",
  }];
  const handoff = buildContinuationHandoffV1({
    ledger,
    lineageFingerprints: [`sha256:${"b".repeat(64)}`],
    now: new Date("2026-07-16T00:00:00.000Z"),
  });
  assert.equal(validateContinuationHandoffV1(handoff).ok, true);
  const verifiedPrefixValidation = validateContinuationHandoffV1(handoff, {
    ledger,
    lineageFingerprints: [
      `sha256:${"b".repeat(64)}`,
      `sha256:${"c".repeat(64)}`,
    ],
  });
  assert.equal(verifiedPrefixValidation.ok, true);

  const messages: ModelChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "mission" },
  ];
  for (let index = 0; index < 8; index += 1) {
    messages.push({ role: "assistant", content: "", toolCalls: [{ name: "read_file", arguments: { path: `${index}.md` } }] });
    messages.push({ role: "tool", toolName: "read_file", content: "x".repeat(200) });
  }
  const compacted = compactLoopMessages({ messages, ledger, keepRecentSteps: 1, handoff });
  assert.equal(compacted.applied, true);
  assert.match(compacted.missionStateMessage ?? "", /Canonical continuation handoff/);
  assert.match(compacted.missionStateMessage ?? "", new RegExp(handoff.fingerprint));
  assert.match(compacted.missionStateMessage ?? "", /Authority counts:/);

  const tampered = { ...handoff, proofDebt: { ...handoff.proofDebt, blocked: !handoff.proofDebt.blocked } };
  assert.equal(validateContinuationHandoffV1(tampered).ok, false);
  const rejected = compactLoopMessages({ messages, ledger, handoff: tampered });
  assert.equal(rejected.applied, false);
  assert.equal(rejected.rejectionReason, "invalid_handoff");

  const malformedNested = {
    ...handoff,
    evidence: [{ id: "evidence-without-a-valid-fingerprint", fingerprint: "bad" }],
  };
  const malformedValidation = validateContinuationHandoffV1(malformedNested);
  assert.equal(malformedValidation.ok, false);
  if (!malformedValidation.ok) {
    assert.ok(malformedValidation.errors.includes("invalid_evidence_shape"));
  }

  const durableLedger = createMissionLedger({
    runId: "run-handoff",
    mission: "Preserve durable proof",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 20,
      toolStepBudget: 16,
      finalizationReserve: 4,
      expectedTools: ["read_file"],
      stopWhenSatisfied: true,
    },
  });
  const authorityValidation = validateContinuationHandoffV1(handoff, {
    ledger: durableLedger,
    lineageFingerprints: [`sha256:${"c".repeat(64)}`],
  });
  assert.equal(authorityValidation.ok, false);
  if (!authorityValidation.ok) {
    assert.ok(authorityValidation.errors.includes("authority_receipt_mismatch"));
    assert.ok(authorityValidation.errors.includes("authority_approval_mismatch"));
    assert.ok(authorityValidation.errors.includes("authority_lineage_mismatch"));
  }
});

test("continuation progress ignores segment churn but changes with executable proof state", () => {
  const ledger = createMissionLedger({
    runId: "run-progress-a",
    mission: "Prove durable progress",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 20,
      toolStepBudget: 16,
      finalizationReserve: 4,
      expectedTools: ["web_search"],
      stopWhenSatisfied: true,
    },
  });
  const built = buildContinuationHandoffV1({
    ledger,
    now: new Date("2026-07-16T00:00:00.000Z"),
  });
  const base: ContinuationHandoffV1 = {
    ...built,
    graphFrontier: {
      missionId: "mission-progress",
      revision: 1,
      graphFingerprint: `sha256:${"a".repeat(64)}`,
      activeNodeIds: [],
      readyNodeIds: ["research"],
    },
  };
  const baseline = continuationProgressFingerprintV1(base);
  const bookkeepingOnly: ContinuationHandoffV1 = {
    ...base,
    runId: "run-progress-b",
    createdAt: "2026-07-16T01:00:00.000Z",
    lineageFingerprints: [`sha256:${"b".repeat(64)}`],
    recovery: {
      stalledCount: 99,
      lastMeaningfulAction: "Narrative-only activity",
      remainingActions: ["Same durable work, phrased differently"],
    },
    graphFrontier: {
      ...base.graphFrontier!,
      revision: 42,
      graphFingerprint: `sha256:${"c".repeat(64)}`,
    },
  };
  assert.equal(
    continuationProgressFingerprintV1(bookkeepingOnly),
    baseline,
  );
  const repeatedEvidenceWithNewGraphIdentity: ContinuationHandoffV1 = {
    ...base,
    evidence: [
      { id: "graph-revision-1", fingerprint: `sha256:${"d".repeat(64)}` },
    ],
  };
  assert.equal(
    continuationProgressFingerprintV1({
      ...repeatedEvidenceWithNewGraphIdentity,
      evidence: [
        { id: "graph-revision-42", fingerprint: `sha256:${"d".repeat(64)}` },
      ],
    }),
    continuationProgressFingerprintV1(repeatedEvidenceWithNewGraphIdentity),
  );

  const stateChanges: ContinuationHandoffV1[] = [
    {
      ...base,
      graphFrontier: {
        ...base.graphFrontier!,
        readyNodeIds: ["research", "write"],
      },
    },
    {
      ...base,
      evidence: [
        { id: "source-1", fingerprint: `sha256:${"d".repeat(64)}` },
      ],
    },
    {
      ...base,
      receiptFingerprints: [`sha256:${"e".repeat(64)}`],
    },
    {
      ...base,
      proofDebt: {
        ...base.proofDebt,
        missing: [...base.proofDebt.missing, "tool:web_search"],
      },
    },
  ];
  for (const changed of stateChanges) {
    assert.notEqual(continuationProgressFingerprintV1(changed), baseline);
  }
});

test("compaction preserves red validation diagnostics and receipt fingerprints", () => {
  const messages: ModelChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "repair the failing validators" },
  ];
  for (let index = 0; index < 8; index += 1) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ name: "read_file", arguments: { path: `${index}.md` } }],
    });
    messages.push({
      role: "tool",
      toolName: "read_file",
      content: "x".repeat(200),
    });
  }
  const ledger = createMissionLedger({
    runId: "run-proof-compact",
    mission: "Preserve assertion text",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 20,
      toolStepBudget: 16,
      finalizationReserve: 4,
      expectedTools: ["code_validate_fast"],
      stopWhenSatisfied: true,
    },
  });
  ledger.receipts = ["receipt:validate:sha256:abc", "receipt:write:sha256:def"];

  const compacted = compactLoopMessages({
    messages,
    ledger,
    keepRecentSteps: 1,
    proofExcerpts: {
      validationDiagnostic: {
        stdout: "AssertionError: king backward movement must fail",
        stderr: "FAILED tests/test_checkers.py::test_king",
        truncated: false,
        redactedLines: 2,
      },
      receiptFingerprints: ["sha256:" + "f".repeat(64)],
    },
  });

  assert.equal(compacted.applied, true);
  assert.match(
    compacted.missionStateMessage ?? "",
    /Proof-critical excerpts retained across compaction/,
  );
  assert.match(
    compacted.missionStateMessage ?? "",
    /AssertionError: king backward movement must fail/,
  );
  assert.match(
    compacted.missionStateMessage ?? "",
    /FAILED tests\/test_checkers\.py::test_king/,
  );
  assert.match(
    compacted.missionStateMessage ?? "",
    new RegExp(`sha256:${"f".repeat(64)}`),
  );
  assert.match(compacted.missionStateMessage ?? "", /diagnostic_redacted_lines=2/);
});

test("payload-first compaction shrinks oversized tool JSON while keeping chaining fields", () => {
  const bulky = JSON.stringify({
    toolName: "read_file",
    status: "success",
    summary: "read note",
    path: "Notes/Keep.md",
    output: {
      path: "Notes/Keep.md",
      content: "y".repeat(4_000),
      baseHash: "sha256:abc",
    },
  });
  const messages: ModelChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "read then continue" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ name: "read_file", arguments: { path: "Notes/Keep.md" } }],
    },
    { role: "tool", toolName: "read_file", content: bulky },
  ];
  const ledger = createMissionLedger({
    runId: "run-payload-shrink",
    mission: "Shrink oversized tool bodies",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 20,
      toolStepBudget: 16,
      finalizationReserve: 4,
      expectedTools: ["read_file"],
      stopWhenSatisfied: true,
    },
  });

  const compacted = compactLoopMessages({
    messages,
    ledger,
    keepRecentSteps: 6,
    maxPromptChars: estimatePromptChars(messages) - 100,
  });
  assert.equal(compacted.applied, true);
  assert.ok(compacted.estimatedCharsAfter < compacted.estimatedCharsBefore);
  const toolMessage = compacted.messages.find((message) => message.role === "tool");
  assert.ok(toolMessage);
  assert.match(toolMessage.content, /Notes\/Keep\.md/);
  assert.match(toolMessage.content, /sha256:abc/);
  assert.ok(!toolMessage.content.includes("y".repeat(100)));
  assert.ok(
    compacted.messages.some((message) =>
      message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
    ),
  );
});

test("turn-drop compaction preserves the one-shot passage writeback contract", () => {
  const passageId = "source:compact-web:passage:0-120";
  const messages: ModelChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "research then append with citations" },
    {
      role: "system",
      content:
        `Passage-grounded writeback contract:\nAccepted passage identifiers: ${passageId}.`,
    },
  ];
  for (let index = 0; index < 8; index += 1) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ name: "read_file", arguments: { path: `${index}.md` } }],
    });
    messages.push({
      role: "tool",
      toolName: "read_file",
      content: "x".repeat(240),
    });
  }
  const ledger = createMissionLedger({
    runId: "run-passage-contract-compact",
    mission: "Preserve passage citation authority",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 20,
      toolStepBudget: 16,
      finalizationReserve: 4,
      expectedTools: ["web_fetch", "append_to_current_file"],
      stopWhenSatisfied: true,
    },
  });
  ledger.evidence = [{
    id: "web:compact",
    kind: "web_source",
    title: "Compacted fetched source",
    url: "https://example.com/compact",
    passageId,
    passageIds: [passageId],
    summary: "The cited passage must remain authorized after compaction.",
    confidence: "high",
  }];

  const compacted = compactLoopMessages({
    messages,
    ledger,
    keepRecentSteps: 1,
  });
  assert.equal(compacted.applied, true);
  const retainedContract = compacted.messages.find(
    (message) =>
      message.role === "system" &&
      message.content.includes("Passage-grounded writeback contract"),
  );
  assert.ok(retainedContract);
  assert.match(retainedContract.content, new RegExp(passageId, "u"));
});

test("payload-first compaction retains bounded nested content evidence", () => {
  const passageId = "source:oversized-fetch:passage:20-520";
  const bulky = JSON.stringify({
    toolName: "web_fetch",
    status: "success",
    output: {
      url: "https://example.com/oversized",
      contentEvidence: {
        passages: [{
          id: passageId,
          start: 20,
          end: 520,
          text:
            "The fetched source provides exact passage text for grounded citation. " +
            "e".repeat(900),
        }],
      },
      ignoredBody: "z".repeat(4_000),
    },
  });
  const messages: ModelChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "fetch and cite the source" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        name: "web_fetch",
        arguments: { url: "https://example.com/oversized" },
      }],
    },
    { role: "tool", toolName: "web_fetch", content: bulky },
  ];
  const ledger = createMissionLedger({
    runId: "run-content-evidence-compact",
    mission: "Preserve fetched passage proof",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 20,
      toolStepBudget: 16,
      finalizationReserve: 4,
      expectedTools: ["web_fetch"],
      stopWhenSatisfied: true,
    },
  });

  const compacted = compactLoopMessages({
    messages,
    ledger,
    keepRecentSteps: 6,
    maxPromptChars: estimatePromptChars(messages) - 100,
  });
  assert.equal(compacted.applied, true);
  const toolMessage = compacted.messages.find(
    (message) => message.role === "tool",
  );
  assert.ok(toolMessage);
  const parsed = JSON.parse(toolMessage.content) as {
    contentEvidence?: { passages?: Array<{ id?: string; text?: string }> };
  };
  assert.equal(parsed.contentEvidence?.passages?.[0]?.id, passageId);
  assert.match(
    parsed.contentEvidence?.passages?.[0]?.text ?? "",
    /exact passage text for grounded citation/,
  );
  assert.ok((parsed.contentEvidence?.passages?.[0]?.text?.length ?? 0) <= 300);
  assert.doesNotMatch(toolMessage.content, /ignoredBody/);
});

test("run context rejects a compaction candidate that would increase the estimate", () => {
  const messages: ModelChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "short mission" },
  ];
  const ledger = createMissionLedger({
    runId: "run-nonreducing-compaction",
    mission: "x".repeat(4000),
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 10,
      toolStepBudget: 6,
      finalizationReserve: 4,
      expectedTools: [],
      stopWhenSatisfied: true,
    },
  });

  const compacted = compactLoopMessages({ messages, ledger, keepRecentSteps: 0 });

  assert.equal(compacted.applied, false);
  assert.equal(compacted.estimatedCharsAfter, compacted.estimatedCharsBefore);
  assert.deepEqual(compacted.messages, messages);
  assert.equal(compacted.missionStateMessage, null);
});
