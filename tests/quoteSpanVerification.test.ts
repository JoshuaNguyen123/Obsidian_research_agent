import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaimLedger,
  shouldRequireQuoteSpans,
  shouldVerifyQuoteSpansV1,
} from "../src/agent/claimLedger";

/*
 * Verbatim quote checking, widened past the literal word "quote".
 *
 * The check itself was real and correct: `quoteAppearsVerbatim` matches after
 * normalizing case, smart quotes and whitespace runs, so a paraphrase fails
 * while an honestly copied quotation passes. It was simply unreachable —
 * `shouldRequireQuoteSpans` fires only when the prompt literally contains
 * quote/quoted/quotation, and "summarize the evidence with citations", the
 * actual shape of a research writeback, contains none of those.
 *
 * The widening is deliberately *verification*, not a requirement. A deep
 * sourced writeback that quotes nothing is a legitimate answer. What is never
 * legitimate is quotation marks around words the source does not contain.
 */

const PASSAGE = {
  id: "source:abc:passage:0-120",
  text:
    "Activation, not signup, is the metric that predicts retention. The cohort study followed twelve thousand accounts.",
};

const CITATION_PROMPT = "Summarize the evidence with citations.";

function ledgerFor(draft: string, options: { verifyQuoteSpans?: boolean } = {}) {
  return buildClaimLedger({
    draft,
    passages: [PASSAGE],
    prompt: CITATION_PROMPT,
    forceRequire: true,
    ...options,
  });
}

test("a citation prompt asks for no quote spans on its own", () => {
  // This is the hole: the prompt shape that most research missions actually
  // use matches none of the literal quote words.
  assert.equal(shouldRequireQuoteSpans(CITATION_PROMPT), false);
});

test("a deep sourced writeback verifies its quotations", () => {
  assert.equal(
    shouldVerifyQuoteSpansV1({ tier: "deep", sourcedWriteback: true }),
    true,
  );
  assert.equal(
    shouldVerifyQuoteSpansV1({ tier: "extended", sourcedWriteback: true }),
    true,
  );
  // Nothing to check against, and nothing claimed: a shallow or unsourced run
  // is not making the claim this verifies.
  assert.equal(
    shouldVerifyQuoteSpansV1({ tier: "deep", sourcedWriteback: false }),
    false,
  );
  assert.equal(
    shouldVerifyQuoteSpansV1({ tier: "standard", sourcedWriteback: true }),
    false,
  );
});

test("a fabricated quotation fails once verification is on", () => {
  const draft = `The study reported that "activation is irrelevant to retention" [${PASSAGE.id}].`;
  const before = ledgerFor(draft);
  const after = ledgerFor(draft, { verifyQuoteSpans: true });

  assert.ok(
    !before.missing.some((entry) => entry.startsWith("claim_grounding:quote_mismatch")),
    `unreachable before the widening: ${JSON.stringify(before.missing)}`,
  );
  assert.ok(
    after.missing.some((entry) => entry.startsWith("claim_grounding:quote_mismatch")),
    `quoted words the source does not contain must fail: ${JSON.stringify(after.missing)}`,
  );
  assert.ok(after.reasons.includes("quote_span_not_in_passage"));
});

test("an honestly copied quotation still passes", () => {
  // Normalization folds only case, smart quotes and whitespace runs, so a
  // faithful copy with different punctuation is accepted.
  const draft = `The study found that “Activation, not  signup, is the metric that predicts retention” [${PASSAGE.id}].`;
  const ledger = ledgerFor(draft, { verifyQuoteSpans: true });
  assert.ok(
    !ledger.missing.some((entry) => entry.startsWith("claim_grounding:quote")),
    JSON.stringify(ledger.missing),
  );
});

test("quoting nothing is not a failure under verification", () => {
  // The difference between verifying and requiring. `requireQuoteSpans` fails
  // an answer that quotes nothing; verification must not.
  const draft = `Activation, not signup, predicts retention [${PASSAGE.id}].`;
  const verified = ledgerFor(draft, { verifyQuoteSpans: true });
  assert.ok(
    !verified.missing.includes("claim_grounding:missing_quote_span"),
    JSON.stringify(verified.missing),
  );

  const required = buildClaimLedger({
    draft,
    passages: [PASSAGE],
    prompt: "Quote the passage.",
    forceRequire: true,
  });
  assert.ok(required.missing.includes("claim_grounding:missing_quote_span"));
});

test("the ledger reports which mode it ran in", () => {
  const verified = ledgerFor(`Activation predicts retention [${PASSAGE.id}].`, {
    verifyQuoteSpans: true,
  });
  assert.equal(verified.verifyQuoteSpans, true);
  assert.equal(verified.requireQuoteSpans, false);
});
