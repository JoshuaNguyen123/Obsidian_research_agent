import test from "node:test";
import assert from "node:assert/strict";
import type { ModelChatMessage } from "../src/model/types";
import { createMissionLedger } from "../src/agent/missionLedger";
import {
  compactLoopMessages,
  createRunContextBudget,
  estimatePromptChars,
  shouldCompactLoopMessages,
} from "../src/agent/runContext";
import {
  buildContinuationHandoffV1,
  validateContinuationHandoffV1,
} from "../src/agent/continuationMemory";

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

  const budget = createRunContextBudget(1600);
  assert.ok(estimatePromptChars(messages) > 0);
  assert.equal(shouldCompactLoopMessages(messages, budget), false);
  const tinyBudget = { ...budget, maxPromptChars: 900 };
  assert.equal(shouldCompactLoopMessages(messages, tinyBudget), true);

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
