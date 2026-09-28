import test from "node:test";
import assert from "node:assert/strict";
import type { ClaimLedger, ClaimPassageRef, ResearchClaim } from "../src/agent/claimLedger";
import {
  claimsForCandidateV1,
  describeClaimSupportAssessmentV1,
  evaluateStagedClaimSupportV1,
  shadowStagedClaimSupportV1,
  standingClaimSupportHoldV1,
} from "../src/decisions/claimSupportGate";
import {
  CLAIM_SUPPORT_TEMPLATE_VERSION_V1,
  normalizeClaimSupportLedgerV1,
} from "../src/decisions/claimSupportAssessment";
import type { DecisionRequestV1, DecisionResultV1 } from "../src/decisions/decisionClient";
import type { DecisionRuntimeV1 } from "../src/decisions/decisionRuntime";

const NOW = () => new Date("2026-09-28T12:00:00.000Z");

const PASSAGES: ClaimPassageRef[] = [
  { id: "p1", text: "The Western Roman Empire ended in 476 when Odoacer deposed Romulus Augustulus." },
  { id: "p2", text: "Economic strain from debasement of the currency weakened the late empire." },
];

/** Build a draft and its claim ledger with real offsets, as the verifier does. */
function draftWith(sentences: Array<{ id: string; text: string; passageIds: string[] }>): {
  candidate: string;
  ledger: ClaimLedger;
} {
  let candidate = "# Why Rome fell\n\n";
  const claims: ResearchClaim[] = [];
  for (const sentence of sentences) {
    const start = candidate.length;
    candidate += `${sentence.text} `;
    claims.push({
      id: sentence.id,
      text: sentence.text,
      status: "grounded",
      passageIds: sentence.passageIds,
      draftStart: start,
      draftEnd: start + sentence.text.length,
    });
  }
  return {
    candidate,
    ledger: {
      version: 1,
      status: "pass",
      claims,
      knownPassageIds: PASSAGES.map((passage) => passage.id),
      missing: [],
      reasons: [],
      requireQuoteSpans: false,
    },
  };
}

type Judge = (claimText: string) => { verdict: string; p: number };

function runtimeJudging(judge: Judge | "outage"): DecisionRuntimeV1 & { asked: DecisionRequestV1[] } {
  const asked: DecisionRequestV1[] = [];
  return {
    asked,
    configuredMode: "enabled",
    model: "typesafe/jev-1.13",
    componentMode: (component) => ({
      component,
      configured: "enabled",
      effective: "enabled",
      heldInShadowBecause: null,
    }),
    async decide(_component, request): Promise<DecisionResultV1> {
      asked.push(request);
      if (judge === "outage") {
        return {
          status: "unavailable",
          purpose: request.purpose,
          templateVersion: request.templateVersion,
          inputFingerprint: "sha256:x",
          requestedModel: "typesafe/jev-1.13",
          reason: "timeout",
          httpStatus: null,
          detail: "timed out",
          durationMs: 5000,
        };
      }
      const state = request.state as { claims: Array<{ key: string; text: string }> };
      const answers: Record<string, unknown> = {};
      for (const claim of state.claims) {
        const { verdict, p } = judge(claim.text);
        const rest = (1 - p) / 2;
        answers[claim.key] = {
          type: "choice",
          choice: verdict,
          confidence: p,
          probabilities: {
            supported: verdict === "supported" ? p : rest,
            contradicted: verdict === "contradicted" ? p : rest,
            insufficient: verdict === "insufficient" ? p : rest,
          },
        };
      }
      return {
        status: "answered",
        purpose: "claim_support",
        templateVersion: CLAIM_SUPPORT_TEMPLATE_VERSION_V1,
        inputFingerprint: `sha256:${asked.length}`,
        requestedModel: "typesafe/jev-1.13",
        reportedModel: "typesafe/jev-1.13",
        responseId: null,
        answers,
        invalidAnswers: [],
        usage: null,
        durationMs: 80,
      } as DecisionResultV1;
    },
    records: () => [],
  };
}

const RIGHT = "The Western Roman Empire ended in 476 [p1].";
const WRONG = "The Western Roman Empire ended in 1453 [p1].";
const judgeByYear: Judge = (text) =>
  text.includes("1453") ? { verdict: "contradicted", p: 0.96 } : { verdict: "supported", p: 0.95 };

test("only claims whose offsets still slice this candidate are checked", () => {
  const { candidate, ledger } = draftWith([{ id: "c1", text: RIGHT, passageIds: ["p1"] }]);
  assert.equal(claimsForCandidateV1(ledger, candidate).length, 1);
  assert.equal(claimsForCandidateV1(ledger, `${candidate.slice(0, 20)}changed ${candidate.slice(20)}`).length, 0);
  assert.equal(claimsForCandidateV1(null, candidate).length, 0);
});

test("a supported draft is accepted with whole-draft coverage recorded", async () => {
  const { candidate, ledger } = draftWith([
    { id: "c1", text: RIGHT, passageIds: ["p1"] },
    { id: "c2", text: "Currency debasement weakened the late empire [p2].", passageIds: ["p2"] },
  ]);
  const outcome = await evaluateStagedClaimSupportV1({
    runtime: runtimeJudging(judgeByYear),
    ledger: null,
    candidate,
    claimLedger: ledger,
    passages: PASSAGES,
    repairAvailable: true,
    now: NOW,
  });
  assert.equal(outcome.action, "accept");
  assert.equal(outcome.action === "accept" && outcome.reason, "supported");
  assert.equal(outcome.ledger.lastAssessment?.coverage.wholeDraft, true);
  assert.equal(outcome.ledger.rejections.length, 0);
});

test("a confident contradiction asks for a claim-scoped repair while the allowance lasts", async () => {
  const { candidate, ledger } = draftWith([
    { id: "c1", text: WRONG, passageIds: ["p1"] },
    { id: "c2", text: "Currency debasement weakened the late empire [p2].", passageIds: ["p2"] },
  ]);
  const outcome = await evaluateStagedClaimSupportV1({
    runtime: runtimeJudging(judgeByYear),
    ledger: null,
    candidate,
    claimLedger: ledger,
    passages: PASSAGES,
    repairAvailable: true,
    now: NOW,
  });
  assert.equal(outcome.action, "repair");
  assert.deepEqual(outcome.action === "repair" && outcome.tokens, ["claim_support:contradicted:c1"]);
  assert.equal(outcome.ledger.rejections.length, 1);
  assert.equal(outcome.ledger.rejections[0]?.claimExcerpt, WRONG);
});

test("with the repair spent, a remaining failure holds the draft with an actionable blocker", async () => {
  const { candidate, ledger } = draftWith([{ id: "c1", text: WRONG, passageIds: ["p1"] }]);
  const outcome = await evaluateStagedClaimSupportV1({
    runtime: runtimeJudging(judgeByYear),
    ledger: null,
    candidate,
    claimLedger: ledger,
    passages: PASSAGES,
    repairAvailable: false,
    now: NOW,
  });
  assert.equal(outcome.action, "hold");
  if (outcome.action !== "hold") return;
  assert.match(outcome.blocker, /Held the draft: 1 claim contradicts its cited source/u);
  assert.match(outcome.blocker, /The note is unchanged/u);
  assert.equal(outcome.ledger.heldCandidate?.text, candidate);
});

test("abstentions are unassessed, never failures", async () => {
  const { candidate, ledger } = draftWith([{ id: "c1", text: WRONG, passageIds: ["p1"] }]);
  const outcome = await evaluateStagedClaimSupportV1({
    runtime: runtimeJudging(() => ({ verdict: "contradicted", p: 0.6 })),
    ledger: null,
    candidate,
    claimLedger: ledger,
    passages: PASSAGES,
    repairAvailable: false,
    now: NOW,
  });
  assert.equal(outcome.action, "accept");
  assert.equal(outcome.action === "accept" && outcome.reason, "unassessed");
  assert.equal(outcome.ledger.lastAssessment?.coverage.wholeDraft, false);
});

test("an outage with nothing on record is a skipped check, not a hold", async () => {
  const { candidate, ledger } = draftWith([{ id: "c1", text: WRONG, passageIds: ["p1"] }]);
  const outcome = await evaluateStagedClaimSupportV1({
    runtime: runtimeJudging("outage"),
    ledger: null,
    candidate,
    claimLedger: ledger,
    passages: PASSAGES,
    repairAvailable: false,
    now: NOW,
  });
  assert.equal(outcome.action, "accept");
  assert.equal(outcome.action === "accept" && outcome.reason, "unavailable");
  assert.equal(outcome.ledger.skipped.length, 1);
  assert.equal(outcome.ledger.skipped[0]?.reason, "timeout");
});

test("an outage after a recorded rejection cannot clear it, across a persisted Continue", async () => {
  const { candidate, ledger } = draftWith([{ id: "c1", text: WRONG, passageIds: ["p1"] }]);
  const first = await evaluateStagedClaimSupportV1({
    runtime: runtimeJudging(judgeByYear),
    ledger: null,
    candidate,
    claimLedger: ledger,
    passages: PASSAGES,
    repairAvailable: true,
    now: NOW,
  });
  assert.equal(first.action, "repair");
  // The repair allowance is spent and the ledger round-trips the run record.
  const persisted = normalizeClaimSupportLedgerV1(
    JSON.parse(JSON.stringify({ ...first.ledger, repairsUsed: 1 })),
  );
  assert.equal(persisted?.repairsUsed, 1);
  assert.equal(persisted?.rejections.length, 1);

  // Continue: the same sentence (a new draft with new offsets and a new id)
  // meets an unreachable decision model.
  const again = draftWith([
    { id: "c9", text: "Rome had many emperors [p2].", passageIds: ["p2"] },
    { id: "c7", text: WRONG, passageIds: ["p1"] },
  ]);
  const outcome = await evaluateStagedClaimSupportV1({
    runtime: runtimeJudging("outage"),
    ledger: persisted,
    candidate: again.candidate,
    claimLedger: again.ledger,
    passages: PASSAGES,
    repairAvailable: (persisted?.repairsUsed ?? 0) < (persisted?.repairAllowance ?? 0),
    now: NOW,
  });
  assert.equal(outcome.action, "hold");
  assert.deepEqual(standingClaimSupportHoldV1({
    ledger: outcome.ledger,
    candidate: again.candidate,
    claimLedger: again.ledger,
  }).map((rejection) => rejection.claimExcerpt), [WRONG]);
});

test("a repaired sentence is a different claim and is judged afresh", async () => {
  const { candidate, ledger } = draftWith([{ id: "c1", text: WRONG, passageIds: ["p1"] }]);
  const runtime = runtimeJudging(judgeByYear);
  const first = await evaluateStagedClaimSupportV1({
    runtime,
    ledger: null,
    candidate,
    claimLedger: ledger,
    passages: PASSAGES,
    repairAvailable: true,
    now: NOW,
  });
  const repaired = draftWith([{ id: "c1", text: RIGHT, passageIds: ["p1"] }]);
  const second = await evaluateStagedClaimSupportV1({
    runtime,
    ledger: { ...first.ledger, repairsUsed: 1 },
    candidate: repaired.candidate,
    claimLedger: repaired.ledger,
    passages: PASSAGES,
    repairAvailable: false,
    now: NOW,
  });
  assert.equal(second.action, "accept");
  assert.equal(second.ledger.rejections.length, 1, "the old finding stays on record");
  assert.equal(
    standingClaimSupportHoldV1({ ledger: second.ledger, candidate: repaired.candidate, claimLedger: repaired.ledger }).length,
    0,
  );
});

test("shadow records what it found and changes nothing", async () => {
  const { candidate, ledger } = draftWith([{ id: "c1", text: WRONG, passageIds: ["p1"] }]);
  const shadow = await shadowStagedClaimSupportV1({
    runtime: runtimeJudging(judgeByYear),
    ledger: null,
    candidate,
    claimLedger: ledger,
    passages: PASSAGES,
    now: NOW,
  });
  assert.equal(shadow?.ledger.mode, "shadow");
  assert.equal(shadow?.ledger.rejections.length, 1);
  assert.equal(shadow?.ledger.heldCandidate, null);
  // A shadow finding never holds a later draft.
  assert.equal(
    standingClaimSupportHoldV1({ ledger: shadow!.ledger, candidate, claimLedger: ledger }).length,
    0,
  );
  assert.equal(
    describeClaimSupportAssessmentV1(shadow!.assessment, "shadow"),
    "Jev claim check (shadow, writeback unchanged): all 1 claim decided; 1 contradicted.",
  );
});

test("claims over the per-candidate cap are reported unassessed, never assumed checked", async () => {
  const sentences = Array.from({ length: 26 }, (_, index) => ({
    id: `c${index + 1}`,
    text: `Claim number ${index + 1} about Rome [p1].`,
    passageIds: ["p1"],
  }));
  const { candidate, ledger } = draftWith(sentences);
  const runtime = runtimeJudging(() => ({ verdict: "supported", p: 0.95 }));
  const outcome = await evaluateStagedClaimSupportV1({
    runtime,
    ledger: null,
    candidate,
    claimLedger: ledger,
    passages: PASSAGES,
    repairAvailable: true,
    now: NOW,
  });
  assert.equal(runtime.asked.length, 3, "24 claims in batches of 8");
  assert.equal(outcome.assessment?.coverage.eligible, 26);
  assert.equal(outcome.assessment?.coverage.excluded, 2);
  assert.equal(outcome.assessment?.coverage.wholeDraft, false);
  assert.equal(outcome.action === "accept" && outcome.reason, "unassessed");
});
