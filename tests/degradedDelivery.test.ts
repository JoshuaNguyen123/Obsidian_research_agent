import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDegradedDeliveryV1,
  buildDegradedVerificationSectionV1,
  decideDegradedDeliveryV1,
  summarizeOpenEvidenceConflictsV1,
  UNVERIFIED_CLAIM_MARKER_V1,
} from "../src/agent/degradedDelivery";
import { projectEvidenceConflictAcknowledgements } from "../src/agent/evidenceConflicts";
import type { ClaimLedger } from "../src/agent/claimLedger";

function ledger(patch: Partial<ClaimLedger> = {}): ClaimLedger {
  return {
    version: 1,
    status: "needs_more_work",
    claims: [],
    knownPassageIds: [],
    missing: [],
    reasons: [],
    requireQuoteSpans: false,
    ...patch,
  };
}

test("only unverified claims and open conflicts may ship marked", () => {
  assert.equal(
    decideDegradedDeliveryV1([
      "claim_grounding:ungrounded_claim:c1",
      "open_evidence_conflicts:conflict-2",
    ]).eligible,
    true,
  );

  // Structural and authority proofs keep the fail-closed path.
  for (const blocking of [
    "citation_url_coverage",
    "passage_citation_coverage:q1",
    "limitations_section",
    "verifier:final_relevance",
    "final_output",
  ]) {
    const decision = decideDegradedDeliveryV1([
      "claim_grounding:ungrounded_claim:c1",
      blocking,
    ]);
    assert.equal(decision.eligible, false, blocking);
    assert.deepEqual(decision.blocking, [blocking]);
  }

  // Nothing missing is not a degraded delivery.
  assert.equal(decideDegradedDeliveryV1([]).eligible, false);
});

test("a mission that forbids note mutation is never eligible, even for markable-only gaps", () => {
  // DU-02: a cache follow-up said "do not write or edit any note"; the only
  // outstanding proof was claim_grounding:ungrounded — markable for an
  // ordinary write mission — and a provisional draft replaced the note
  // anyway. Mission authority outranks the proof taxonomy.
  const decision = decideDegradedDeliveryV1(
    ["claim_grounding:ungrounded_claim:c1"],
    { missionForbidsNoteMutation: true },
  );
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /existing note stays unchanged/i);
  // Diagnostics still name the gaps for Run Details.
  assert.deepEqual(decision.markable, ["claim_grounding:ungrounded_claim:c1"]);
  assert.deepEqual(decision.blocking, []);

  // Both markable families together change nothing.
  assert.equal(
    decideDegradedDeliveryV1(
      [
        "claim_grounding:ungrounded_claim:c1",
        "open_evidence_conflicts:conflict-2",
      ],
      { missionForbidsNoteMutation: true },
    ).eligible,
    false,
  );

  // Even the degenerate empty case stays ineligible under the mission guard.
  assert.equal(
    decideDegradedDeliveryV1([], { missionForbidsNoteMutation: true }).eligible,
    false,
  );
});

test("an ordinary write mission keeps its markable-only eligibility", () => {
  for (const mission of [
    undefined,
    {},
    { missionForbidsNoteMutation: false },
  ]) {
    const decision = decideDegradedDeliveryV1(
      ["claim_grounding:ungrounded_claim:c1"],
      mission,
    );
    assert.equal(decision.eligible, true, JSON.stringify(mission));
  }
});

test("blocking proofs stay ineligible regardless of mission context", () => {
  for (const mission of [undefined, { missionForbidsNoteMutation: true }]) {
    const decision = decideDegradedDeliveryV1(
      ["claim_grounding:ungrounded_claim:c1", "final_output"],
      mission,
    );
    assert.equal(decision.eligible, false, JSON.stringify(mission));
    assert.deepEqual(decision.blocking, ["final_output"]);
  }
});

test("an unverifiable quotation is removed, never delivered with a caveat", () => {
  const quoted = "The council affirmed the clause in exactly these words.";
  const result = buildDegradedDeliveryV1({
    content: `Opening context.\n\n${quoted}\n\nClosing context.`,
    missing: ["claim_grounding:quote_mismatch:c1"],
    ledger: ledger({
      claims: [
        {
          id: "c1",
          text: quoted,
          status: "grounded",
          passageIds: ["p1"],
          quoteSpans: [{ passageId: "p1", quote: "exactly these words" }],
        },
      ],
      quoteCorrections: [
        {
          claimId: "c1",
          passageId: "p1",
          attempted: "exactly these words",
          passageExcerpt: "in these very words",
        },
      ],
    }),
  });

  assert.deepEqual(result.removedQuoteClaimIds, ["c1"]);
  assert.ok(!result.content.includes(quoted));
  assert.ok(!result.content.includes(UNVERIFIED_CLAIM_MARKER_V1));
  assert.match(result.content, /Removed: 1 quotation/i);
  assert.match(result.content, /Opening context/);
});

test("an unsupported non-quote claim ships marked inline, beside the verified ones", () => {
  const unsupported = "Adoption tripled in the following quarter.";
  const supported = "The specification was ratified in 2019.";
  const result = buildDegradedDeliveryV1({
    content: `${supported}\n\n${unsupported}`,
    missing: ["claim_grounding:ungrounded_claim:c2"],
    ledger: ledger({
      claims: [
        { id: "c1", text: supported, status: "grounded", passageIds: ["p1"] },
        { id: "c2", text: unsupported, status: "ungrounded", passageIds: [] },
      ],
    }),
  });

  assert.deepEqual(result.markedClaimIds, ["c2"]);
  assert.equal(result.verifiedClaimCount, 1);
  assert.match(
    result.content,
    new RegExp(
      `${unsupported.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\[unverified`,
    ),
  );
  // The verified claim is delivered untouched.
  assert.ok(result.content.includes(supported));
  assert.ok(!result.content.includes(`${supported} ${UNVERIFIED_CLAIM_MARKER_V1}`));
  assert.match(result.content, /Confirmed against a cited source passage: 1/);
});

test("a claim citing a passage that does not exist is marked, not left bare", () => {
  // invalid_citation is the shape most likely to be trusted on sight: it comes
  // with a citation attached. Shipping it unmarked would be the worst outcome
  // of the whole degraded path.
  const fabricated = "The registry recorded 4,812 filings that year [p-99].";
  const result = buildDegradedDeliveryV1({
    content: `Opening.\n\n${fabricated}`,
    missing: ["claim_grounding:invalid_citation:c7"],
    ledger: ledger({
      claims: [
        {
          id: "c7",
          text: fabricated,
          status: "invalid_citation",
          passageIds: ["p-99"],
        },
      ],
    }),
  });
  assert.deepEqual(result.markedClaimIds, ["c7"]);
  assert.equal(result.verifiedClaimCount, 0);
  assert.ok(result.content.includes(UNVERIFIED_CLAIM_MARKER_V1));
});

test("a claim appearing more than once is left alone rather than mismarked", () => {
  const repeated = "The result held.";
  const result = buildDegradedDeliveryV1({
    content: `${repeated} Later, again: ${repeated}`,
    missing: ["claim_grounding:ungrounded_claim:c1"],
    ledger: ledger({
      claims: [
        { id: "c1", text: repeated, status: "ungrounded", passageIds: [] },
      ],
    }),
  });
  assert.deepEqual(result.markedClaimIds, []);
});

test("the status section satisfies the acknowledged-limitation contract", () => {
  // The conflict verifier accepts a limitation only with an explicit
  // limitations-style heading AND explicit disagreement language. A banner
  // that fails either would ship while still counting the conflict as unmet.
  const section = buildDegradedVerificationSectionV1({
    missing: ["open_evidence_conflicts:conflict-1"],
    markedClaimCount: 0,
    removedQuoteCount: 0,
    verifiedClaimCount: 3,
    conflictSummaries: ["conflict-1: passages p1 vs p2"],
  });

  const acknowledged = projectEvidenceConflictAcknowledgements(
    [
      {
        id: "conflict-1",
        claimIds: ["c1"],
        passageIds: ["p1", "p2"],
        status: "open",
      },
    ],
    `Body text.\n\n${section}`,
  );
  assert.equal(acknowledged[0]?.status, "acknowledged_limitation");
});

test("open conflicts are summarized by the passages that disagree", () => {
  assert.deepEqual(
    summarizeOpenEvidenceConflictsV1([
      { id: "conflict-1", claimIds: [], passageIds: ["p1", "p2"], status: "open" },
      {
        id: "conflict-2",
        claimIds: [],
        passageIds: ["p3"],
        status: "acknowledged_limitation",
      },
    ]),
    ["conflict-1: passages p1 vs p2"],
  );
  assert.deepEqual(summarizeOpenEvidenceConflictsV1(null), []);
});

test("the outstanding proofs stay named in the delivered note", () => {
  const result = buildDegradedDeliveryV1({
    content: "Body.",
    missing: ["claim_grounding:ungrounded_claim:c9"],
    ledger: ledger(),
  });
  assert.match(result.content, /## Verification status/);
  assert.match(result.content, /provisional/i);
  assert.match(result.content, /claim_grounding:ungrounded_claim:c9/);
});
