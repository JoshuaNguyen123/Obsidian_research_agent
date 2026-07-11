import test from "node:test";
import assert from "node:assert/strict";
import {
  approvalDeniedFailureCopy,
  blockedDomainFailureCopy,
  claimGroundingFailureCopy,
  formatAcceptanceFailureCopy,
  formatFailureCopy,
  formatModelFailureCopy,
  formatWebFetchToolFailureCopy,
  keepAwakeFailureCopy,
  leaseWaitFailureCopy,
  listReconcileActions,
  modelRetryExhaustedFailureCopy,
  modelTimeoutFailureCopy,
  openConflictFailureCopy,
  overnightBackoffFailureCopy,
  phaseGateFailureCopy,
  policyBlockFailureCopy,
  providerAuthFailureCopy,
  semanticCoverageSecondPassCopy,
  walReconcileFailureCopy,
  webFetchFailureCopy,
  writeReceiptMissingFailureCopy,
} from "../src/agent/failureCopy";

test("failure copy always includes what why and next", () => {
  const samples = [
    providerAuthFailureCopy("missing key"),
    modelTimeoutFailureCopy("aborted"),
    modelRetryExhaustedFailureCopy("rate limited"),
    policyBlockFailureCopy("run_code_block", "unsafe"),
    approvalDeniedFailureCopy("run_code_block", "denied"),
    approvalDeniedFailureCopy("run_code_block", "expired"),
    walReconcileFailureCopy("commit missing"),
    writeReceiptMissingFailureCopy("write_receipt"),
    leaseWaitFailureCopy("2026-07-10T20:00:00.000Z"),
    overnightBackoffFailureCopy("transient", "2026-07-10T20:05:00.000Z"),
    webFetchFailureCopy("404"),
    blockedDomainFailureCopy("localhost"),
    keepAwakeFailureCopy("powerSaveBlocker unavailable"),
    claimGroundingFailureCopy("ungrounded claim"),
    openConflictFailureCopy("open_evidence_conflicts:c1"),
    phaseGateFailureCopy("gather", "Write tools are blocked"),
    semanticCoverageSecondPassCopy("mode=sampled"),
  ];

  for (const sample of samples) {
    const text = formatFailureCopy(sample);
    assert.match(text, /^What: /);
    assert.match(text, / Why: /);
    assert.match(text, / Next: /);
    assert.ok(sample.what.length > 0);
    assert.ok(sample.why.length > 0);
    assert.ok(sample.next.length > 0);
    assert.equal(sample.next.includes("."), true);
    assert.ok(!sample.next.includes("\n"));
  }
});

test("wal reconcile copy lists concrete repair actions and a single next CTA", () => {
  const actions = listReconcileActions({
    path: "Notes/Draft.md",
    backupPath: ".agent-backups/Draft.md.bak",
    operationId: "op-42",
  });
  assert.ok(actions.length >= 3);
  assert.match(actions[0]!, /Inspect note Notes\/Draft\.md/);
  assert.match(actions[1]!, /\.agent-backups/);
  assert.match(actions.join(" "), /op-42/);

  const copy = walReconcileFailureCopy("commit missing");
  assert.match(copy.next, /Inspect the target note and the Agent Runs ledger/);
  assert.match(copy.next, /clear reconcile_required/);
  assert.equal(copy.next.split(".").filter(Boolean).length, 1);
});

test("writeReceiptMissingFailureCopy has imperative next CTA", () => {
  const copy = writeReceiptMissingFailureCopy();
  assert.match(copy.what, /write receipt/i);
  assert.match(copy.next, /^Append or replace/);
});

test("formatModelFailureCopy maps auth timeout and retry categories", () => {
  assert.match(
    formatModelFailureCopy({
      category: "missing_api_key",
      message: "Ollama cloud API key is required.",
    }),
    /What: Model provider authentication failed/,
  );
  assert.match(
    formatModelFailureCopy({
      category: "network",
      message: "Request timed out after 30000ms.",
    }),
    /What: The model request timed out/,
  );
  assert.match(
    formatModelFailureCopy({
      category: "rate_limit",
      message: "Too many requests",
    }),
    /What: Model retries were exhausted/,
  );
});

test("formatWebFetchToolFailureCopy distinguishes blocked domains", () => {
  assert.match(
    formatWebFetchToolFailureCopy(
      "web_fetch cannot fetch local or private network URLs.",
    ),
    /What: Web fetch blocked an unsafe or private domain/,
  );
  assert.match(
    formatWebFetchToolFailureCopy("Ollama web_fetch returned an invalid response."),
    /What: Web fetch failed/,
  );
});

test("formatAcceptanceFailureCopy maps claim conflict and phase gates", () => {
  assert.match(
    formatAcceptanceFailureCopy(["claim_grounding:ungrounded:c1"]),
    /What: Claim grounding blocked acceptance/,
  );
  assert.match(
    formatAcceptanceFailureCopy(["open_evidence_conflicts:c1,c2"]),
    /What: Open evidence conflicts block completion/,
  );
  assert.match(
    formatAcceptanceFailureCopy(["research_phase_gate:gather"]),
    /What: Research phase gate blocked a write during/,
  );
  assert.match(
    formatAcceptanceFailureCopy(["web_evidence"]),
    /Mission acceptance missing: web_evidence/,
  );
});
