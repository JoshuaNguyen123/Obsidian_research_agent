import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaimLedger,
  normalizeClaimLedger,
  serializeClaimLedger,
  shouldRequireClaimGrounding,
  shouldRequireQuoteSpans,
} from "../src/agent/claimLedger";
import { mergeClaimGroundingIntoAcceptance } from "../src/agent/missionAcceptance";
import { quoteAppearsVerbatim } from "../src/agent/quoteMatch";
import {
  claimPassagesFromToolResult,
  evidenceFromToolResult,
} from "../src/agent/missionEvidence";
import { runMissionVerifiers } from "../src/agent/verifiers";
import { createMissionPlan } from "../src/agent/missionPlan";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import type { MissionIntent, ToolExecutionResult } from "../src/tools/types";

const PASSAGE_TEXT =
  "Quantum battery evidence compares independent laboratory sources and documents current device limitations.";

test("shouldRequireClaimGrounding skips chat answers and ordinary summaries", () => {
  assert.equal(shouldRequireClaimGrounding("chat_answer"), false);
  assert.equal(
    shouldRequireClaimGrounding(
      "Search the web for API documentation and summarize it with source URLs.",
    ),
    false,
  );
  assert.equal(shouldRequireClaimGrounding("deep_web"), true);
  assert.equal(
    shouldRequireClaimGrounding(
      "Do deep research on quantum batteries and cite passages.",
    ),
    true,
  );
  assert.equal(
    shouldRequireClaimGrounding(
      "I want you to find and organize information about the current online dating market and also the social media market.",
    ),
    false,
  );
  assert.equal(
    shouldRequireQuoteSpans("Verify and quote the source text for this claim."),
    true,
  );
  assert.equal(
    shouldRequireQuoteSpans("Verify two claims against fetched passages."),
    false,
  );
});

test("uncited deep-research draft fails claim grounding", () => {
  const source = fetchedSource();
  const ledger = buildClaimLedger({
    draft:
      "Quantum battery evidence shows rapid charge retention across independent laboratory trials.",
    evidence: [source],
    passages: [
      {
        id: source.passageId!,
        text: PASSAGE_TEXT,
      },
    ],
    prompt: "Do deep research on quantum batteries and cite passages.",
    mode: "deep_web",
  });

  assert.equal(ledger.status, "needs_more_work");
  assert.ok(
    ledger.missing.some((item) => item.includes("ungrounded")),
    `expected ungrounded missing, got ${ledger.missing.join(",")}`,
  );
  assert.ok(ledger.claims.some((claim) => claim.status === "ungrounded"));
});

test("passage-cited draft with matching claim text passes", () => {
  const source = fetchedSource();
  const draft =
    `Quantum battery evidence compares independent laboratory sources [${source.passageId}].`;
  const ledger = buildClaimLedger({
    draft,
    evidence: [source],
    passages: [
      {
        id: source.passageId!,
        text: PASSAGE_TEXT,
      },
    ],
    prompt: "Do deep research on quantum batteries and cite passages.",
    mode: "deep_web",
  });

  assert.equal(ledger.status, "pass", ledger.missing.join(", "));
  assert.equal(ledger.claims.length, 1);
  assert.equal(ledger.claims[0].status, "grounded");
  assert.deepEqual(ledger.claims[0].passageIds, [source.passageId]);
});

test("fabricated passage id fails claim grounding", () => {
  const source = fetchedSource();
  const fakeId = "source:notreal:passage:0-40";
  const ledger = buildClaimLedger({
    draft:
      `Quantum battery evidence compares independent laboratory sources [${fakeId}].`,
    evidence: [source],
    passages: [
      {
        id: source.passageId!,
        text: PASSAGE_TEXT,
      },
    ],
    prompt: "Do deep research on quantum batteries and cite passages.",
  });

  assert.equal(ledger.status, "needs_more_work");
  assert.ok(
    ledger.missing.some((item) => item.includes("fabricated")),
    `expected fabricated missing, got ${ledger.missing.join(",")}`,
  );
  assert.ok(
    ledger.claims.some((claim) => claim.status === "invalid_citation") ||
      ledger.reasons.includes("fabricated_passage_id"),
  );
});

test("limitation sentences are exempt from material claim grounding", () => {
  const source = fetchedSource();
  const ledger = buildClaimLedger({
    draft: [
      `Quantum battery evidence compares independent laboratory sources [${source.passageId}].`,
      "Confidence is limited and further research is needed.",
    ].join(" "),
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Deep research with citations.",
  });

  assert.equal(ledger.status, "pass", ledger.missing.join(", "));
  assert.ok(ledger.claims.some((claim) => claim.status === "exempt"));
});

test("standalone required literal markers are metadata rather than material claims", () => {
  const source = fetchedSource();
  const ledger = buildClaimLedger({
    draft: [
      "E2E_MARKER_CONFLICT_REPAIR_01",
      `Quantum battery evidence compares independent laboratory sources [${source.passageId}].`,
    ].join("\n\n"),
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Deep research with citations. Include E2E_MARKER_CONFLICT_REPAIR_01.",
  });

  assert.equal(ledger.status, "pass", ledger.missing.join(", "));
  assert.equal(ledger.claims.length, 1);
  assert.doesNotMatch(ledger.claims[0]?.text ?? "", /E2E_MARKER/iu);
});

test("word-count verification does not manufacture passage grounding debt", () => {
  assert.equal(
    shouldRequireClaimGrounding(
      "Write approximately 180 words about local-first workflows, then use count_words to verify the generated note length.",
    ),
    false,
  );
});

test("epistemic section bodies remain exempt when the heading carries the label", () => {
  const source = fetchedSource();
  const ledger = buildClaimLedger({
    draft: [
      "## Findings",
      `Quantum battery evidence compares independent laboratory sources [${source.passageId}].`,
      "## Confidence",
      "High because both bounded checks point in the same direction.",
      "## Unanswered Questions",
      "None remain within this deliberately narrow comparison.",
    ].join("\n\n"),
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Deep research with citations.",
  });

  assert.equal(ledger.status, "pass", ledger.missing.join(", "));
  assert.ok(
    ledger.claims
      .filter((claim) => /High because|None remain/u.test(claim.text))
      .every((claim) => claim.status === "exempt"),
  );
});

test("quote/verify missions require quote spans inside passage text", () => {
  const source = fetchedSource();
  const missingQuote = buildClaimLedger({
    draft:
      `Quantum battery evidence compares independent laboratory sources [${source.passageId}].`,
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Verify and quote the source text for quantum battery claims.",
    requireQuoteSpans: true,
  });
  assert.equal(missingQuote.status, "needs_more_work");
  assert.ok(
    missingQuote.missing.some((item) => item.includes("missing_quote")),
  );

  const withQuote = buildClaimLedger({
    draft:
      `Lab reports state "Quantum battery evidence compares independent laboratory sources" [${source.passageId}].`,
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Verify and quote the source text for quantum battery claims.",
    requireQuoteSpans: true,
  });
  assert.equal(withQuote.status, "pass", withQuote.missing.join(", "));
  assert.ok((withQuote.claims[0].quoteSpans?.length ?? 0) > 0);
});

test("a quote differing only in smart quotes or spacing still verifies", () => {
  // The ledger and the verify_citation tool must agree on what "verbatim"
  // means. Passage text extracted from HTML routinely carries curly
  // apostrophes and doubled spaces, so a raw substring comparison rejected
  // quotes the model had copied honestly.
  const source = fetchedSource();
  // Curly apostrophe and a doubled space, exactly as an HTML extractor emits.
  const passageText =
    "Quantum battery evidence compares the laboratory’s  independent sources.";
  const ledger = buildClaimLedger({
    draft:
      `Lab reports state "Quantum battery evidence compares the laboratory's independent sources." [${source.passageId}].`,
    evidence: [source],
    passages: [{ id: source.passageId!, text: passageText }],
    prompt: "Verify and quote the source text for quantum battery claims.",
    requireQuoteSpans: true,
  });
  assert.equal(ledger.status, "pass", ledger.missing.join(", "));
});

test("claim ids are content-derived: stable across regeneration, changed only by edits", () => {
  const source = fetchedSource();
  const draftA =
    `Quantum battery evidence compares independent laboratory sources [${source.passageId}]. ` +
    `The follow-up study replicates the measurement protocol [${source.passageId}].`;
  const first = buildClaimLedger({
    draft: draftA,
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Research quantum batteries with cited passages.",
  });
  const second = buildClaimLedger({
    draft: draftA,
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Research quantum batteries with cited passages.",
  });
  assert.ok(first.claims.length >= 2);
  assert.deepEqual(
    first.claims.map((claim) => claim.id),
    second.claims.map((claim) => claim.id),
  );
  assert.ok(first.claims.every((claim) => /^claim:s-[0-9a-f]{10}(-\d+)?$/u.test(claim.id)));

  // Editing one sentence changes only that sentence's id.
  const draftB = draftA.replace(
    "replicates the measurement protocol",
    "replicates the calibration protocol",
  );
  const third = buildClaimLedger({
    draft: draftB,
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Research quantum batteries with cited passages.",
  });
  assert.equal(third.claims[0].id, first.claims[0].id);
  assert.notEqual(third.claims[1].id, first.claims[1].id);

  // Duplicate sentences stay distinguishable via occurrence suffixes.
  const duplicated = buildClaimLedger({
    draft:
      `Quantum battery evidence compares independent laboratory sources [${source.passageId}]. ` +
      `Quantum battery evidence compares independent laboratory sources [${source.passageId}].`,
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Research quantum batteries with cited passages.",
  });
  const ids = duplicated.claims.map((claim) => claim.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids[1].endsWith("-2"));
});

test("a quote from the second cited passage pins to that passage, not passageIds[0]", () => {
  // Every quote used to be pinned to the claim's FIRST bound passage, so a
  // correct verbatim quote drawn from the second cited passage failed as
  // quote_mismatch. The pin must follow containment; the verbatim standard
  // itself is unchanged.
  const source = fetchedSource();
  const betaId = "source:beta99:passage:0-80";
  const betaText =
    "The beta passage carries the decisive phrasing for the follow-up study.";
  const ledger = buildClaimLedger({
    draft:
      `Quantum battery lab reports state "beta passage carries the decisive phrasing for the follow-up" ` +
      `[${source.passageId}] [${betaId}].`,
    evidence: [source],
    passages: [
      { id: source.passageId!, text: PASSAGE_TEXT },
      { id: betaId, text: betaText },
    ],
    prompt: "Verify and quote the source text for quantum battery claims.",
    requireQuoteSpans: true,
  });
  assert.equal(ledger.status, "pass", ledger.missing.join(", "));
  const spans = ledger.claims[0].quoteSpans ?? [];
  assert.equal(spans.length, 1);
  assert.equal(spans[0].passageId, betaId);
  assert.equal(typeof spans[0].startChar, "number");
  assert.equal(typeof spans[0].endChar, "number");
  assert.ok(
    quoteAppearsVerbatim(
      spans[0].quote,
      betaText.slice(spans[0].startChar, spans[0].endChar),
    ),
    "recovered raw span must contain the quote verbatim",
  );
});

test("a nowhere-verbatim quote still reports against the cited primary passage", () => {
  const source = fetchedSource();
  const betaId = "source:beta99:passage:0-80";
  const ledger = buildClaimLedger({
    draft:
      `Quantum battery lab reports state "phrasing that appears in neither cited window" ` +
      `[${source.passageId}] [${betaId}].`,
    evidence: [source],
    passages: [
      { id: source.passageId!, text: PASSAGE_TEXT },
      {
        id: betaId,
        text: "Quantum battery reporting in the beta window carries different phrasing entirely.",
      },
    ],
    prompt: "Verify and quote the source text for quantum battery claims.",
    requireQuoteSpans: true,
  });
  assert.equal(ledger.status, "needs_more_work");
  assert.ok(
    ledger.missing.some((item) => item.includes("quote_mismatch")),
    ledger.missing.join(", "),
  );
  const spans = ledger.claims[0].quoteSpans ?? [];
  assert.equal(spans[0]?.passageId, source.passageId);
});

test("a paraphrase presented as a quote is still rejected", () => {
  // Normalization folds only case, smart quotes, and whitespace. Anything that
  // changes a word must still fail, or the check stops catching invention.
  const source = fetchedSource();
  const ledger = buildClaimLedger({
    draft:
      `Lab reports state "Quantum battery findings contrast several independent laboratories" [${source.passageId}].`,
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Verify and quote the source text for quantum battery claims.",
    requireQuoteSpans: true,
  });
  assert.equal(ledger.status, "needs_more_work");
  assert.ok(
    ledger.missing.some((item) => item.includes("quote_mismatch")) ||
      ledger.missing.some((item) => item.includes("missing_quote")),
    ledger.missing.join(", "),
  );
});

test("quote missions allow grounded paraphrases once one exact quote is verified", () => {
  const source = fetchedSource();
  const ledger = buildClaimLedger({
    draft: [
      `Lab reports state "Quantum battery evidence compares independent laboratory sources" [${source.passageId}].`,
      `Independent laboratory evidence compares current quantum battery devices [${source.passageId}].`,
    ].join(" "),
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Verify the evidence with text-level quotation and cited paraphrases.",
    requireQuoteSpans: true,
  });

  assert.equal(ledger.status, "pass", ledger.missing.join(", "));
  assert.equal(ledger.claims.length, 2);
  assert.ok(ledger.claims.every((claim) => claim.status === "grounded"));
  assert.equal(
    ledger.claims.reduce((count, claim) => count + (claim.quoteSpans?.length ?? 0), 0),
    1,
  );
});

test("serialize and normalize claim ledger round-trip", () => {
  const source = fetchedSource();
  const ledger = buildClaimLedger({
    draft:
      `Quantum battery evidence compares independent laboratory sources [${source.passageId}].`,
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Deep research with passage citations.",
  });
  const normalized = normalizeClaimLedger(serializeClaimLedger(ledger));
  assert.ok(normalized);
  assert.equal(normalized.status, ledger.status);
  assert.equal(normalized.claims.length, ledger.claims.length);
  assert.deepEqual(normalized.knownPassageIds, ledger.knownPassageIds);
});

test("verifyQuoteSpans and quoteCorrections survive the ledger round-trip", () => {
  const source = fetchedSource();
  // A quote-verify mission whose quote mismatches produces corrections
  // carrying the passage bytes — exactly what a post-resume correction prompt
  // needs and what the old serializer silently dropped.
  const ledger = buildClaimLedger({
    draft:
      `Lab reports state "Quantum battery findings contrast several independent laboratories" [${source.passageId}].`,
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Verify and quote the source text for quantum battery claims.",
    requireQuoteSpans: true,
  });
  assert.equal(ledger.status, "needs_more_work");
  assert.ok((ledger.quoteCorrections?.length ?? 0) > 0, "fixture must produce corrections");
  const normalized = normalizeClaimLedger(serializeClaimLedger(ledger));
  assert.ok(normalized);
  assert.equal(normalized.verifyQuoteSpans, ledger.verifyQuoteSpans);
  assert.deepEqual(normalized.quoteCorrections, ledger.quoteCorrections);
});

test("legacy ledger records without the verification fields still normalize", () => {
  const legacy = {
    version: 1,
    status: "pass",
    claims: [
      {
        id: "claim:1",
        text: "Legacy ordinal-id claim persisted before the content-hash scheme.",
        status: "grounded",
        passageIds: ["source:abc:passage:0-40"],
      },
    ],
    knownPassageIds: ["source:abc:passage:0-40"],
    missing: [],
    reasons: [],
    requireQuoteSpans: false,
  };
  const normalized = normalizeClaimLedger(legacy);
  assert.ok(normalized);
  assert.equal(normalized.claims[0].id, "claim:1");
  assert.equal(normalized.verifyQuoteSpans, undefined);
  assert.equal(normalized.quoteCorrections, undefined);
});

test("claim_grounding verifier integrates with runMissionVerifiers", () => {
  const source = fetchedSource();
  const plan = createMissionPlan({
    runId: "run:claim-ledger",
    prompt: "Do deep research on quantum batteries and cite passages.",
    missionIntent: intent(false),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_model_planning",
      allowedToolNames: ["web_search", "web_fetch"],
    },
    requiredTools: ["web_search", "web_fetch"],
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
  plan.tasks[0].evidenceIds = [source.id];
  plan.tasks[0].status = "complete";

  const uncited = runMissionVerifiers({
    plan,
    evidence: [source],
    receipts: [],
    finalOutput:
      "Quantum battery evidence shows rapid charge retention across independent laboratory trials.",
    prompt: "Do deep research on quantum batteries and cite passages.",
    researchMode: "deep_web",
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
  });
  assert.ok(
    uncited.missing.some((item) => item.includes("claim_grounding")),
    uncited.missing.join(", "),
  );
  assert.equal(uncited.claimLedger?.status, "needs_more_work");

  const cited = runMissionVerifiers({
    plan,
    evidence: [source],
    receipts: [],
    finalOutput:
      `Quantum battery evidence compares independent laboratory sources [${source.passageId}].`,
    prompt: "Do deep research on quantum batteries and cite passages.",
    researchMode: "deep_web",
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
  });
  assert.ok(
    !cited.missing.some((item) => item.includes("claim_grounding")),
    cited.missing.join(", "),
  );
  assert.equal(cited.claimLedger?.status, "pass");
});

test("mergeClaimGroundingIntoAcceptance is ready for S5 wiring", () => {
  const source = fetchedSource();
  const ledger = buildClaimLedger({
    draft: "Quantum battery evidence shows rapid charge retention.",
    evidence: [source],
    passages: [{ id: source.passageId!, text: PASSAGE_TEXT }],
    prompt: "Deep research with citations.",
  });
  const merged = mergeClaimGroundingIntoAcceptance(
    {
      status: "pass",
      confidence: 0.92,
      missing: [],
      reasons: ["required_evidence_and_receipts_present"],
    },
    ledger,
  );
  assert.equal(merged.status, "needs_more_work");
  assert.ok(merged.missing.some((item) => item.includes("claim_grounding")));
});

test("claimPassagesFromToolResult prefers dossier passage texts", () => {
  const passages = claimPassagesFromToolResult(
    "web_fetch",
    okResult("web_fetch", {
      title: "Quantum battery research",
      url: "https://research.example.com/quantum-battery",
      normalizedUrl: "https://research.example.com/quantum-battery",
      query: "quantum battery evidence",
      content: PASSAGE_TEXT,
    }),
  );
  assert.ok(passages.length > 0);
  assert.ok(passages[0].id.includes("passage"));
  assert.match(passages[0].text, /Quantum battery evidence/);
});

function fetchedSource() {
  const source = evidenceFromToolResult(
    "web_fetch",
    okResult("web_fetch", {
      title: "Quantum battery research",
      url: "https://research.example.com/quantum-battery",
      normalizedUrl: "https://research.example.com/quantum-battery",
      query: "quantum battery evidence",
      content: PASSAGE_TEXT,
    }),
  );
  assert.ok(source?.passageId);
  return source;
}

function intent(requireWriteCompletion: boolean): MissionIntent {
  return {
    mode: requireWriteCompletion ? "note_output" : "vault_context_answer",
    vaultContext: !requireWriteCompletion,
    noteOutput: requireWriteCompletion,
    explicitPersistence: requireWriteCompletion,
    explicitMutation: requireWriteCompletion,
    explicitDelete: false,
    allowAutonomousWrite: requireWriteCompletion,
    requireWriteCompletion,
    autonomyScope: deriveAutonomyScope("current note", {
      noteOutput: requireWriteCompletion,
      explicitPersistence: requireWriteCompletion,
      explicitMutation: requireWriteCompletion,
    }),
  };
}

function okResult(toolName: string, output: unknown): ToolExecutionResult {
  return { ok: true, toolName, output };
}

test("a quote mismatch carries the passage's actual bytes for the correction", () => {
  // The verifier holds the true source text at the moment it refuses; a bare
  // mismatch flag sent the model back to guess or re-fetch sources it could
  // only see truncated. The correction must let it copy instead.
  const source = fetchedSource();
  const passageText =
    "And in the Holy Ghost, the Lord and Giver-of-Life, who proceedeth from the Father, who spake by the prophets.";
  const draft = [
    "The creed's clause reads:",
    `> "And in the Holy Ghost, the Lord and Giver-of-Life, who proceeds from the Father, who spoke by the prophets." [${source.passageId}]`,
  ].join("\n");
  const ledger = buildClaimLedger({
    draft,
    evidence: [source],
    passages: [{ id: source.passageId!, text: passageText }],
    prompt: "Research the creed and quote the clause exactly. Cite passages.",
    mode: "deep_web",
  });

  assert.ok(
    ledger.missing.some((item) => item.includes("quote_mismatch")),
    ledger.missing.join(", "),
  );
  const corrections = ledger.quoteCorrections ?? [];
  assert.ok(corrections.length > 0, "mismatch produced no correction bytes");
  assert.equal(corrections[0].passageId, source.passageId);
  assert.ok(
    corrections[0].passageExcerpt.includes("proceedeth from the Father"),
    corrections[0].passageExcerpt,
  );
  assert.ok(corrections[0].attempted.includes("who proceeds from the Father"));
});

test("a verbatim quote produces no correction payload", () => {
  const source = fetchedSource();
  const passageText =
    "And in the Holy Ghost, the Lord and Giver-of-Life, who proceedeth from the Father, who spake by the prophets.";
  const draft = [
    "The creed's clause reads:",
    `> "the Lord and Giver-of-Life, who proceedeth from the Father" [${source.passageId}]`,
  ].join("\n");
  const ledger = buildClaimLedger({
    draft,
    evidence: [source],
    passages: [{ id: source.passageId!, text: passageText }],
    prompt: "Research the creed and quote the clause exactly. Cite passages.",
    mode: "deep_web",
  });

  assert.equal(ledger.quoteCorrections, undefined, JSON.stringify(ledger.quoteCorrections));
});

test("negated quote phrases do not arm the quote-span requirement", () => {
  // "no verbatim quotations" simultaneously armed requireQuoteSpans via the
  // keyword and forbade quoting — a guaranteed missing_quote_span refusal,
  // live-reproduced four times before this guard existed.
  assert.equal(
    shouldRequireQuoteSpans(
      "Write a short note in your own words (paraphrase, no verbatim quotations). Use current sources and citations.",
    ),
    false,
  );
  assert.equal(
    shouldRequireQuoteSpans("Summarize this without quoting anything."),
    false,
  );
  // An affirmative request still arms it.
  assert.equal(
    shouldRequireQuoteSpans("Quote the relevant clause exactly as it appears."),
    true,
  );
  // Mixed: the positive request survives the negated-phrase strip.
  assert.equal(
    shouldRequireQuoteSpans(
      "Quote the relevant clause exactly, and do not quote anything else.",
    ),
    true,
  );
});
