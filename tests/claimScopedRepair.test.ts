import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaimScopedRepairPrompt,
  collectClaimScopedRepairPlan,
  formatRejectedDraftForCorrection,
  spliceClaimRepairs,
} from "../src/AgentRunner";
import type { ClaimLedger, ResearchClaim } from "../src/agent/claimLedger";

const ALPHA_ID = "source:alpha1:passage:0-80";
const BETA_ID = "source:beta22:passage:0-90";
const ALPHA_TEXT =
  "The alpha passage confirms the retention window spans twelve hours in trial one.";
const BETA_TEXT =
  "The beta passage reports the calibration series was repeated across four laboratories.";

const SENTENCE_A = `The retention window spans ten hours [${ALPHA_ID}].`;
const SENTENCE_B = `The calibration series ran once [${BETA_ID}].`;
const CANDIDATE = `# Findings\n${SENTENCE_A}\n${SENTENCE_B}\n`;

function claim(
  id: string,
  text: string,
  passageIds: string[],
  draftStart: number,
  draftEnd: number,
): ResearchClaim {
  return { id, text, status: "grounded", passageIds, draftStart, draftEnd };
}

function ledgerWith(claims: ResearchClaim[]): ClaimLedger {
  return {
    version: 1,
    status: "needs_more_work",
    claims,
    knownPassageIds: [ALPHA_ID, BETA_ID],
    missing: [],
    reasons: [],
    requireQuoteSpans: true,
  };
}

const START_A = CANDIDATE.indexOf(SENTENCE_A);
const START_B = CANDIDATE.indexOf(SENTENCE_B);
const CLAIM_A = claim(
  "claim:s-aaaaaaaaaa",
  SENTENCE_A,
  [ALPHA_ID],
  START_A,
  START_A + SENTENCE_A.length,
);
const CLAIM_B = claim(
  "claim:s-bbbbbbbbbb",
  SENTENCE_B,
  [BETA_ID],
  START_B,
  START_B + SENTENCE_B.length,
);

test("collect: fully claim-scoped failures with live offsets build a descending plan", () => {
  const plan = collectClaimScopedRepairPlan(
    [
      `claim_grounding:quote_mismatch:${CLAIM_A.id}`,
      `claim_grounding:ungrounded:${CLAIM_B.id}`,
    ],
    ledgerWith([CLAIM_A, CLAIM_B]),
    CANDIDATE,
  );
  assert.ok(plan);
  assert.equal(plan.repairs.length, 2);
  assert.equal(plan.repairs[0].claim.id, CLAIM_B.id, "descending draftStart order");
  assert.equal(plan.repairs[0].currentText, SENTENCE_B);
});

test("collect: any document-scoped token or stale offsets fall back to null", () => {
  const ledger = ledgerWith([CLAIM_A]);
  assert.equal(
    collectClaimScopedRepairPlan(
      [`claim_grounding:quote_mismatch:${CLAIM_A.id}`, "limitations_section"],
      ledger,
      CANDIDATE,
    ),
    null,
  );
  // Offsets that no longer slice this candidate (mutated draft) disqualify.
  assert.equal(
    collectClaimScopedRepairPlan(
      [`claim_grounding:quote_mismatch:${CLAIM_A.id}`],
      ledger,
      CANDIDATE.replace("ten hours", "eleven hours"),
    ),
    null,
  );
  // A failing claim missing offsets disqualifies.
  const noOffsets = { ...CLAIM_A };
  delete noOffsets.draftStart;
  delete noOffsets.draftEnd;
  assert.equal(
    collectClaimScopedRepairPlan(
      [`claim_grounding:quote_mismatch:${CLAIM_A.id}`],
      ledgerWith([noOffsets]),
      CANDIDATE,
    ),
    null,
  );
});

test("prompt carries the verbatim sentence, tokens, and correction bytes", () => {
  const plan = collectClaimScopedRepairPlan(
    [`claim_grounding:quote_mismatch:${CLAIM_A.id}`],
    ledgerWith([CLAIM_A]),
    CANDIDATE,
  );
  assert.ok(plan);
  const prompt = buildClaimScopedRepairPrompt(plan, [
    {
      claimId: CLAIM_A.id,
      passageId: ALPHA_ID,
      attempted: "spans ten hours",
      passageExcerpt: "spans twelve hours in trial one",
    },
  ]);
  assert.match(prompt, /Repair ONLY the failing claim sentences/u);
  assert.ok(prompt.includes(`Current sentence: ${SENTENCE_A}`));
  assert.ok(prompt.includes(`claim_grounding:quote_mismatch:${CLAIM_A.id}`));
  assert.ok(prompt.includes("spans twelve hours in trial one"));
  assert.match(prompt, /one line per claim id/u);
});

test("splice applies verified lines and leaves every other byte identical", () => {
  const plan = collectClaimScopedRepairPlan(
    [
      `claim_grounding:quote_mismatch:${CLAIM_A.id}`,
      `claim_grounding:ungrounded:${CLAIM_B.id}`,
    ],
    ledgerWith([CLAIM_A, CLAIM_B]),
    CANDIDATE,
  );
  assert.ok(plan);
  const replacementA = `The source states "retention window spans twelve hours" [${ALPHA_ID}].`;
  const replacementB = `The calibration series was repeated across four laboratories [${BETA_ID}].`;
  const result = spliceClaimRepairs({
    candidate: CANDIDATE,
    plan,
    responseText: [
      `${CLAIM_A.id}: ${replacementA}`,
      `${CLAIM_B.id}: ${replacementB}`,
    ].join("\n"),
    passages: [
      { id: ALPHA_ID, text: ALPHA_TEXT },
      { id: BETA_ID, text: BETA_TEXT },
    ],
    knownPassageIds: [ALPHA_ID, BETA_ID],
  });
  assert.deepEqual(result.dropped, []);
  assert.equal(result.applied.length, 2);
  assert.equal(
    result.text,
    `# Findings\n${replacementA}\n${replacementB}\n`,
  );
  assert.ok(result.text.startsWith("# Findings\n"), "untouched prefix survives");
});

test("splice drops unverifiable lines: unknown citation, bad quote, missing line", () => {
  const plan = collectClaimScopedRepairPlan(
    [
      `claim_grounding:quote_mismatch:${CLAIM_A.id}`,
      `claim_grounding:ungrounded:${CLAIM_B.id}`,
    ],
    ledgerWith([CLAIM_A, CLAIM_B]),
    CANDIDATE,
  );
  assert.ok(plan);
  const result = spliceClaimRepairs({
    candidate: CANDIDATE,
    plan,
    // A cites an unknown passage id; B's line is absent entirely.
    responseText: `${CLAIM_A.id}: New sentence [source:nope99:passage:0-10].`,
    passages: [
      { id: ALPHA_ID, text: ALPHA_TEXT },
      { id: BETA_ID, text: BETA_TEXT },
    ],
    knownPassageIds: [ALPHA_ID, BETA_ID],
  });
  assert.deepEqual(result.applied, []);
  assert.equal(result.dropped.length, 2);
  assert.equal(result.text, CANDIDATE, "nothing spliced");

  const badQuote = spliceClaimRepairs({
    candidate: CANDIDATE,
    plan,
    responseText: [
      `${CLAIM_A.id}: The source states "a fabricated span nowhere in the passage" [${ALPHA_ID}].`,
      `${CLAIM_B.id}: The calibration series was repeated across four laboratories [${BETA_ID}].`,
    ].join("\n"),
    passages: [
      { id: ALPHA_ID, text: ALPHA_TEXT },
      { id: BETA_ID, text: BETA_TEXT },
    ],
    knownPassageIds: [ALPHA_ID, BETA_ID],
  });
  assert.deepEqual(badQuote.dropped, [CLAIM_A.id]);
  assert.deepEqual(badQuote.applied, [CLAIM_B.id]);
  assert.ok(badQuote.text.includes(SENTENCE_A), "dropped claim's sentence unchanged");
});

test("formatRejectedDraftForCorrection keeps the tail above the cap", () => {
  const short = "A short draft.";
  assert.equal(formatRejectedDraftForCorrection(short, 6000), short);
  const head = "H".repeat(4000);
  const tail = "## Limitations\nThe tail section under repair.";
  const long = head + "M".repeat(4000) + tail;
  const bounded = formatRejectedDraftForCorrection(long, 6000);
  assert.ok(bounded.length < long.length);
  assert.match(bounded, /characters elided/u);
  assert.ok(bounded.endsWith(tail), "tail sections survive the cap");
  assert.ok(bounded.startsWith("H".repeat(100)), "head survives too");
});
