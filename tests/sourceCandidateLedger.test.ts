import assert from "node:assert/strict";
import test from "node:test";
import {
  DUPLICATE_CONTENT_FAILURE,
  addSourceCandidate,
  claimSourceCandidate,
  computeSourceProofDebt,
  createSourceCandidateLedger,
  recordSourceCandidateOutcome,
  type SourceCandidateLedgerV1,
} from "../src/orchestrator/sourceCandidateLedger";

const NOW = new Date("2026-07-31T00:00:00Z");
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function ledgerRequiringTwoSources(): SourceCandidateLedgerV1 {
  return createSourceCandidateLedger({
    runId: "run-1",
    query: "onboarding retention",
    now: NOW,
    proofRequirements: [
      {
        claimId: "mission",
        description: "Two independent sources.",
        minUsableSources: 2,
      },
    ],
  });
}

/** Register, claim, and resolve one candidate; returns the updated ledger. */
function resolveCandidate(
  ledger: SourceCandidateLedgerV1,
  url: string,
  outcome: { evidenceId: string; contentHash?: string },
): { ledger: SourceCandidateLedgerV1; id: string } {
  const registered = addSourceCandidate(
    ledger,
    {
      query: "onboarding retention",
      title: url,
      url,
      provider: "web_search",
      sourceType: "web",
      signals: { quality: 0.5, freshness: 0.65, fetchability: 0.75 },
      claimIds: ["mission"],
    },
    NOW,
  );
  const claimed = claimSourceCandidate(
    registered.ledger,
    registered.candidate.id,
    "worker-1",
    { now: NOW },
  );
  return {
    ledger: recordSourceCandidateOutcome(
      claimed.ledger,
      registered.candidate.id,
      {
        status: "usable",
        evidenceIds: [outcome.evidenceId],
        contentHash: outcome.contentHash,
      },
      NOW,
    ),
    id: registered.candidate.id,
  };
}

test("a second source serving identical text is rejected as duplicate content", () => {
  let ledger = ledgerRequiringTwoSources();
  const first = resolveCandidate(ledger, "https://origin.example/report", {
    evidenceId: "web:1",
    contentHash: HASH_A,
  });
  ledger = first.ledger;
  const second = resolveCandidate(ledger, "https://mirror.example/report", {
    evidenceId: "web:2",
    contentHash: HASH_A,
  });
  ledger = second.ledger;

  assert.equal(ledger.candidates[first.id].status, "usable");
  assert.equal(ledger.candidates[second.id].status, "rejected");
  assert.equal(ledger.candidates[second.id].failure, DUPLICATE_CONTENT_FAILURE);
  // A rejected duplicate contributes no evidence to the proof contract.
  assert.deepEqual(ledger.candidates[second.id].evidenceIds, []);

  // computeSourceProofDebt already filters on status === "usable", so the
  // duplicate stops counting toward the floor with no change downstream.
  const debt = computeSourceProofDebt(ledger);
  assert.equal(debt.length, 1);
  assert.equal(debt[0].accepted, 1);
  assert.equal(debt[0].missing, 1);
});

test("two genuinely distinct sources both stay usable and clear the proof debt", () => {
  let ledger = ledgerRequiringTwoSources();
  ledger = resolveCandidate(ledger, "https://origin.example/report", {
    evidenceId: "web:1",
    contentHash: HASH_A,
  }).ledger;
  ledger = resolveCandidate(ledger, "https://other.example/study", {
    evidenceId: "web:2",
    contentHash: HASH_B,
  }).ledger;

  assert.deepEqual(computeSourceProofDebt(ledger), []);
});

test("the duplicate does not overwrite the index entry that rejected it", () => {
  let ledger = ledgerRequiringTwoSources();
  const first = resolveCandidate(ledger, "https://origin.example/report", {
    evidenceId: "web:1",
    contentHash: HASH_A,
  });
  ledger = first.ledger;
  ledger = resolveCandidate(ledger, "https://mirror.example/report", {
    evidenceId: "web:2",
    contentHash: HASH_A,
  }).ledger;
  // A third mirror must still be rejected against the original, not against a
  // rejected candidate that had claimed the hash on its way out.
  const third = resolveCandidate(ledger, "https://third.example/report", {
    evidenceId: "web:3",
    contentHash: HASH_A,
  });
  ledger = third.ledger;

  assert.equal(ledger.contentHashCandidateIds?.[HASH_A], first.id);
  assert.equal(ledger.candidates[third.id].status, "rejected");
  assert.equal(computeSourceProofDebt(ledger)[0].accepted, 1);
});

test("a candidate with no content hash is never collapsed into another", () => {
  let ledger = ledgerRequiringTwoSources();
  ledger = resolveCandidate(ledger, "https://origin.example/report", {
    evidenceId: "web:1",
  }).ledger;
  ledger = resolveCandidate(ledger, "https://other.example/report", {
    evidenceId: "web:2",
  }).ledger;

  assert.deepEqual(computeSourceProofDebt(ledger), []);
});

test("a malformed content hash is ignored rather than used as a match key", () => {
  let ledger = ledgerRequiringTwoSources();
  ledger = resolveCandidate(ledger, "https://origin.example/report", {
    evidenceId: "web:1",
    contentHash: "sha256:short",
  }).ledger;
  ledger = resolveCandidate(ledger, "https://other.example/report", {
    evidenceId: "web:2",
    contentHash: "sha256:short",
  }).ledger;

  // Two sources the fetch path could not honestly hash must both stand.
  assert.deepEqual(computeSourceProofDebt(ledger), []);
});

test("an unusable outcome never claims a content hash", () => {
  let ledger = ledgerRequiringTwoSources();
  const registered = addSourceCandidate(
    ledger,
    {
      query: "q",
      title: "https://origin.example/report",
      url: "https://origin.example/report",
      provider: "web_search",
      sourceType: "web",
      signals: { quality: 0.5, freshness: 0.65, fetchability: 0.75 },
      claimIds: ["mission"],
    },
    NOW,
  );
  ledger = recordSourceCandidateOutcome(
    registered.ledger,
    registered.candidate.id,
    { status: "unusable", failure: "no passages", contentHash: HASH_A },
    NOW,
  );
  assert.equal(ledger.contentHashCandidateIds?.[HASH_A], undefined);

  // A later source with the same hash is therefore still accepted on its own.
  const second = resolveCandidate(ledger, "https://other.example/report", {
    evidenceId: "web:2",
    contentHash: HASH_A,
  });
  assert.equal(second.ledger.candidates[second.id].status, "usable");
});

test("a ledger persisted before the content-hash index still resolves outcomes", () => {
  // The field is additive within ledger version 1; a ledger written by an
  // earlier build has no index and must not throw on read.
  const legacy = ledgerRequiringTwoSources();
  delete (legacy as { contentHashCandidateIds?: unknown }).contentHashCandidateIds;

  const resolved = resolveCandidate(legacy, "https://origin.example/report", {
    evidenceId: "web:1",
    contentHash: HASH_A,
  });
  assert.equal(resolved.ledger.candidates[resolved.id].status, "usable");
  assert.equal(resolved.ledger.contentHashCandidateIds?.[HASH_A], resolved.id);
});
