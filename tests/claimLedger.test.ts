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
