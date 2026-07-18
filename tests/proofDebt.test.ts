import test from "node:test";
import assert from "node:assert/strict";
import {
  computeProofDebt,
  formatProofDebtForPrompt,
  type ProofDebtSnapshot,
} from "../src/agent/proofDebt";
import { decideAutoContinuation } from "../src/agent/autoContinuation";
import {
  buildHypothesisSystemHint,
  buildWorkingHypotheses,
  evidenceSatisfiesProofWithoutHypotheses,
  hypothesesSatisfyEvidenceProof,
} from "../src/agent/researchHypotheses";
import type { ResearchPlan } from "../src/agent/researchPlan";

function researchPlanNeedingFetch(): ResearchPlan {
  return {
    version: 1,
    mode: "deep_web",
    sourceRequirements: { minFetchedSources: 3, minDistinctDomains: 2 },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "rq-1",
        question: "What is the latest solid-state battery finding?",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "in_progress",
        evidenceIds: [],
      },
    ],
    evidenceIds: ["web_search:1"],
    status: "in_progress",
  };
}

test("computeProofDebt maps missing fetch to web_fetch nextAction", () => {
  const snapshot: ProofDebtSnapshot = {
    status: "budget",
    researchPlan: researchPlanNeedingFetch(),
    acceptance: {
      status: "needs_more_work",
      missing: ["web_evidence", "fetched_sources"],
    },
    storedNextAction: "stale narrative that must be ignored",
  };

  const debt = computeProofDebt(snapshot);
  assert.equal(debt.empty, false);
  assert.equal(debt.blocked, false);
  assert.equal(debt.nextAction.kind, "tool");
  assert.equal(debt.nextAction.toolName, "web_fetch");
  assert.match(formatProofDebtForPrompt(debt), /web_fetch/);
  assert.doesNotMatch(formatProofDebtForPrompt(debt), /stale narrative/);
});

test("computeProofDebt keeps active unfinished ledgers non-empty for resume", () => {
  const running = computeProofDebt({
    status: "running",
    acceptance: undefined,
    storedNextAction: "Continue stale banner mission.",
  });
  assert.equal(running.empty, false);
  assert.equal(running.blocked, false);
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: { status: "needs_more_work", reasons: [], missing: [] },
      proofDebtSnapshot: {
        status: "budget",
        acceptance: { status: "needs_more_work", missing: [] },
      },
    }),
    { recommended: true, reason: "budget_exhausted" },
  );
});

test("computeProofDebt empties accepted snapshots and auto-continue refuses", () => {
  const snapshot: ProofDebtSnapshot = {
    status: "complete",
    acceptance: {
      status: "pass",
      missing: [],
      nextAction: "ignore me",
    },
  };
  const debt = computeProofDebt(snapshot);
  assert.equal(debt.empty, true);
  assert.equal(debt.blocked, false);
  assert.equal(debt.nextAction.kind, "none");
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: { status: "pass", reasons: [] },
      proofDebt: debt,
    }),
    { recommended: false, reason: "proof_satisfied" },
  );
});

test("computeProofDebt blocks on WAL reconcile_required and auto-continue refuses", () => {
  const debt = computeProofDebt({
    status: "blocked",
    acceptance: {
      status: "needs_more_work",
      missing: ["web_evidence"],
    },
    operationJournal: [
      {
        state: "reconcile_required",
        operationId: "op-1",
        toolName: "append_to_current_file",
      },
    ],
  });
  assert.equal(debt.blocked, true);
  assert.equal(debt.empty, false);
  assert.equal(debt.nextAction.kind, "blocked");
  assert.match(debt.nextAction.reason, /WAL reconcile/);
  assert.match(debt.nextAction.summary, /append_to_current_file/);
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: { status: "needs_more_work", reasons: [] },
      proofDebtSnapshot: {
        acceptance: { status: "needs_more_work", missing: ["web_evidence"] },
        operationJournal: [{ state: "reconcile_required", operationId: "op-1" }],
      },
    }),
    { recommended: false, reason: "blocked" },
  );
});

test("computeProofDebt includes open conflicts from ledger snapshot helpers", () => {
  const debt = computeProofDebt({
    status: "paused",
    acceptance: { status: "needs_more_work", missing: [] },
    openConflicts: [
      {
        id: "conflict:abc",
        status: "open",
        summary: "Open conflict conflict:abc between p1 vs p2",
      },
    ],
  });
  assert.equal(debt.empty, false);
  assert.equal(debt.openConflicts.length, 1);
  assert.ok(debt.missing.some((item) => item.includes("conflict:abc")));
  assert.match(debt.nextAction.summary, /Resolve conflict/);
});

test("working hypotheses inject and never satisfy evidence proof alone", () => {
  const hypotheses = buildWorkingHypotheses([
    {
      topic: "Solid-state batteries",
      path: "Agent Research Memory/Research/solid-state.md",
      found: true,
      content:
        "Prior note claimed electrolyte stability for 2000 cycles from an older crawl.",
    },
    {
      topic: "Other",
      path: "Agent Research Memory/Research/other.md",
      found: true,
      content: "Second prior finding about cathode materials.",
    },
  ]);
  assert.equal(hypotheses.length, 2);
  assert.ok(hypotheses.every((item) => item.text.length <= 200));

  const hint = buildHypothesisSystemHint(hypotheses);
  assert.match(hint ?? "", /Working hypotheses \(unverified\):/);
  assert.match(hint ?? "", /Re-fetch or re-read/);

  assert.equal(
    hypothesesSatisfyEvidenceProof("web_evidence", hypotheses),
    false,
  );
  assert.equal(
    hypothesesSatisfyEvidenceProof("vault_evidence", hypotheses),
    false,
  );
  assert.equal(
    evidenceSatisfiesProofWithoutHypotheses("web_evidence", [], hypotheses),
    false,
  );
  assert.equal(
    evidenceSatisfiesProofWithoutHypotheses(
      "web_evidence",
      [
        {
          id: "mem:1",
          kind: "vault_note",
          title: "research memory",
          path: "Agent Research Memory/Research/solid-state.md",
          summary: "memory only",
          confidence: "low",
        },
      ],
      hypotheses,
    ),
    false,
  );
  assert.equal(
    evidenceSatisfiesProofWithoutHypotheses(
      "web_evidence",
      [
        {
          id: "web:1",
          kind: "web_source",
          title: "Study",
          url: "https://example.com/study",
          summary: "Fetched page",
          confidence: "high",
        },
      ],
      hypotheses,
    ),
    true,
  );
});
