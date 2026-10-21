import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaimLedger,
  extractClaimsFromDraft,
  isProcessStatementV1,
  type ClaimPassageRef,
  type ResearchClaim,
} from "../src/agent/claimLedger";
import { renderCitedNoteBodyV1 } from "../src/agent/citationBibliography";
import type { MissionEvidence } from "../src/agent/missionLedger";
import {
  CLAIM_SUPPORT_PLANNER_VERSION_V1,
  CLAIM_SUPPORT_TEMPLATE_VERSION_V1,
  CLAIM_SUPPORT_THRESHOLDS_V1,
  assessClaimSupportV1,
  claimCitedPassageIdsV1,
  claimFingerprintV1,
  emptyClaimSupportLedgerV1,
  footnotePassageIdsV1,
  interpretClaimSupportAnswersV1,
  planClaimSupportChecksV1,
  standingRejectionsV1,
  type ClaimSupportCheckV1,
} from "../src/decisions/claimSupportAssessment";
import { claimsForCandidateV1 } from "../src/decisions/claimSupportGate";
import type { DecisionResultV1 } from "../src/decisions/decisionClient";

const token = (source: string, start: number, end: number) => `source:${source}:passage:${start}-${end}`;

function answered(answers: Record<string, unknown>): DecisionResultV1 {
  return {
    status: "answered",
    purpose: "claim_support",
    templateVersion: CLAIM_SUPPORT_TEMPLATE_VERSION_V1,
    inputFingerprint: "sha256:t",
    requestedModel: "typesafe/jev-1.13",
    reportedModel: "typesafe/jev-1.13",
    responseId: null,
    answers: answers as never,
    invalidAnswers: [],
    usage: null,
    durationMs: 10,
  };
}

function choice(name: "supported" | "contradicted" | "insufficient", p: number) {
  const rest = (1 - p) / 2;
  return {
    type: "choice",
    choice: name,
    confidence: p,
    probabilities: {
      supported: name === "supported" ? p : rest,
      contradicted: name === "contradicted" ? p : rest,
      insufficient: name === "insufficient" ? p : rest,
    },
  };
}

test("process sentences are recognised by what they say about the research, not by keywords", () => {
  const process = [
    "Could not verify: the widely shared claim that 92% of employees wanted to keep the policy.",
    "Not independently verified: the manufacturer's figure of 40% lower bills.",
    "I searched for peer-reviewed follow-ups and found none published yet.",
    "This note relies only on the pilot's own report and one review.",
    "Whether naps produce the same benefit is unclear from the sources gathered.",
    "Uncertainty remains about installation quality, which the sources did not measure.",
    "The chart values were read from the figure's text layer, not measured from the image.",
  ];
  const claims = [
    // A subject of its own makes it a claim about that subject.
    "Two of the reviewed laboratories could not reproduce the procedural-skill effect.",
    "No significant difference was found between the groups.",
    "The review covered only European countries.",
    "The meta-analysis authors had high confidence in the pooled estimate.",
    // The host's own label glued to an unsupported sentence is not a disclaimer.
    "[unverified — no cited source passage confirms this] Every code validation passed and a release was published.",
  ];
  for (const sentence of process) assert.equal(isProcessStatementV1(sentence), true, sentence);
  for (const sentence of claims) assert.equal(isProcessStatementV1(sentence), false, sentence);
});

test("the ledger exempts a process sentence outside any Limitations heading", () => {
  const claims = extractClaimsFromDraft(
    "Could not verify: the figure of five grams of plastic swallowed per week that is often quoted online.",
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.status, "exempt");
});

const SOURCE = "a41d07";
const PILOT = [
  "The pilot ran for six months across 61 companies employing around 2,900 people in the United Kingdom.",
  "Of the participating companies, 56 said they would continue with the four-day week after the trial ended.",
  "Company revenue stayed broadly the same, rising 1.4% on average for the organisations that reported data.",
  "Staff sickness days fell by about two-thirds over the trial period.",
  "The number of staff leaving fell by 57% compared with the same period a year earlier.",
];
const OTHER = "b72e11";
const REVIEW = "Because companies opted in, the trials cannot show whether a firm chosen at random would see the same results.";

function pilotPassages(): ClaimPassageRef[] {
  let offset = 0;
  return [
    ...PILOT.map((text) => {
      const id = token(SOURCE, offset, offset + text.length);
      offset += text.length + 40;
      return { id, text };
    }),
    { id: token(OTHER, 0, REVIEW.length), text: REVIEW },
  ];
}

function evidence(passages: ClaimPassageRef[]): MissionEvidence[] {
  return [SOURCE, OTHER].map((source) => ({
    id: `evidence:${source}`,
    kind: "web_source",
    title: source === SOURCE ? "The UK four-day week pilot" : "A review",
    url: `https://example.org/${source}`,
    sourceId: `source:${source}`,
    passageIds: passages.filter((passage) => passage.id.includes(source)).map((passage) => passage.id),
    summary: "",
    confidence: "high",
  }));
}

function renderedDraft(body: string[], passages: ClaimPassageRef[]) {
  const draft = renderCitedNoteBodyV1({
    content: body.join("\n"),
    evidence: evidence(passages),
    now: () => new Date("2026-10-21T00:00:00Z"),
  }).content;
  const ledger = buildClaimLedger({ draft, passages, evidence: evidence(passages), forceRequire: true });
  return { draft, ledger, claims: claimsForCandidateV1(ledger, draft) };
}

test("a footnoted sentence is bound to its footnote's passages, sent whole within bounds", () => {
  const passages = pilotPassages();
  const { draft, claims } = renderedDraft(
    [
      "# Pilot",
      `Staff turnover dropped by 57% compared with the previous year [${passages[4]!.id}].`,
      `Most companies kept the policy afterwards, with 56 of 61 continuing [${passages[1]!.id}].`,
      `Every month the pilot ran, revenue doubled at the participating companies [${passages[2]!.id}].`,
      `The firms volunteered, so a random firm may differ [${passages[5]!.id}].`,
    ],
    passages,
  );
  const footnotes = footnotePassageIdsV1(draft);
  assert.equal(footnotes.size, 2, "one footnote per source");
  const planned = planClaimSupportChecksV1({ claims, passages, candidateText: draft });
  const turnover = planned.checks.find((check) => check.claimText.includes("57%"))!;
  assert.ok(turnover, "the footnoted claim is checked, not excluded");
  // Bound to the pilot's cited passages only, never the review it shares words with.
  assert.ok(turnover.passages.every((passage) => passage.id.includes(SOURCE)));
  assert.ok(turnover.passages.some((passage) => passage.id === passages[4]!.id));
  assert.equal(turnover.subsetOf, undefined, "within bounds the whole cited set is sent");
  assert.equal(planned.excluded.length, 0);
});

test("a cited claim under Limitations is checked; an uncited or process one is not", () => {
  const passages = pilotPassages();
  const draft = [
    "# Pilot",
    `The pilot ran for six months across 61 companies [${passages[0]!.id}].`,
    "",
    "## Limitations",
    "",
    `Every participating company was a manufacturing firm [${passages[5]!.id}].`,
    "Most results come from small firms in services.",
    "I searched for peer-reviewed follow-ups and found none published yet.",
  ].join("\n");
  const ledger = buildClaimLedger({ draft, passages, evidence: evidence(passages), forceRequire: true });
  const claims = claimsForCandidateV1(ledger, draft);
  const limitation = claims.find((claim) => claim.text.includes("manufacturing"))!;
  assert.equal(limitation.status, "exempt", "the deterministic ledger is unchanged: still exempt");
  const planned = planClaimSupportChecksV1({ claims, passages, candidateText: draft });
  assert.deepEqual(
    planned.checks.map((check) => check.claimId).sort(),
    [claims.find((claim) => claim.text.includes("six months"))!.id, limitation.id].sort(),
  );
  assert.equal(planned.citedExempt, 1);
  assert.equal(planned.processStatements, 1);
  assert.deepEqual(planned.checks.find((check) => check.claimId === limitation.id)!.passages.map((p) => p.id), [passages[5]!.id]);
});

test("past the whole-send bounds the closest passages are sent and 'insufficient' abstains", () => {
  const many: ClaimPassageRef[] = Array.from({ length: 8 }, (_, index) => ({
    id: token("c0ffee", index * 100, index * 100 + 90),
    text: index === 5 ? "Hybrid work cut quit rates by a third among employees." : `Unrelated passage number ${index} about weather patterns.`,
  }));
  const claim: ResearchClaim = {
    id: "claim:x",
    text: `Hybrid work cut quit rates by a third ${many.map((passage) => `[${passage.id}]`).join(" ")}.`,
    status: "grounded",
    passageIds: many.map((passage) => passage.id),
  };
  const planned = planClaimSupportChecksV1({ claims: [claim], passages: many });
  const check = planned.checks[0]!;
  assert.equal(check.passages.length, 3);
  assert.equal(check.subsetOf, 8);
  assert.ok(check.passages.some((passage) => passage.id === many[5]!.id), "the passage that shares most is sent");
  const questionFor = new Map<string, ClaimSupportCheckV1>([["claim_1", check]]);
  const insufficient = interpretClaimSupportAnswersV1(answered({ claim_1: choice("insufficient", 0.97) }), questionFor).get("claim:x")!;
  assert.equal(insufficient.status, "abstained");
  assert.equal(insufficient.fallbackReason, "partial_evidence");
  const contradicted = interpretClaimSupportAnswersV1(
    answered({ claim_1: choice("contradicted", CLAIM_SUPPORT_THRESHOLDS_V1.contradicted) }),
    questionFor,
  ).get("claim:x")!;
  assert.equal(contradicted.status, "decided");
  assert.equal(contradicted.verdict, "contradicted");
  assert.equal(contradicted.citedPassageIds?.length, 8);
});

test("the assessment records its planner and what it left out, and rejections stand by cited passages", async () => {
  const passages = pilotPassages();
  const { draft, claims } = renderedDraft(
    [
      "# Pilot",
      `Every month the pilot ran, revenue doubled at the participating companies [${passages[2]!.id}].`,
      "Could not verify: the widely shared claim that 92% of employees wanted to keep it.",
    ],
    passages,
  );
  const runtime = {
    async decide(_component: string, request: { state: { claims: Array<{ key: string }> } }) {
      return answered(Object.fromEntries(request.state.claims.map((entry) => [entry.key, choice("contradicted", 0.95)])));
    },
  };
  const assessment = await assessClaimSupportV1({ runtime: runtime as never, candidateText: draft, claims, passages });
  assert.equal(assessment.plannerVersion, CLAIM_SUPPORT_PLANNER_VERSION_V1);
  assert.equal(assessment.coverage.processStatements, 1);
  assert.equal(assessment.coverage.eligible, 1, "the process sentence is not counted as an eligible claim");
  const revenue = claims.find((claim) => claim.text.includes("doubled"))!;
  const cited = claimCitedPassageIdsV1(revenue, footnotePassageIdsV1(draft));
  const ledger = {
    ...emptyClaimSupportLedgerV1("enabled"),
    rejections: [
      {
        claimFingerprint: claimFingerprintV1(revenue.text, cited),
        claimId: revenue.id,
        verdict: "contradicted" as const,
        passageIds: cited,
        probability: 0.95,
        claimExcerpt: revenue.text,
        at: "",
      },
      // A rejection recorded on a process sentence before planner v2 never stands.
      ...claims
        .filter((claim) => claim.text.startsWith("Could not verify"))
        .map((claim) => ({
          claimFingerprint: claimFingerprintV1(claim.text, claim.passageIds),
          claimId: claim.id,
          verdict: "insufficient" as const,
          passageIds: claim.passageIds,
          probability: 0.95,
          claimExcerpt: claim.text,
          at: "",
        })),
    ],
  };
  const standing = standingRejectionsV1(ledger, claims, draft);
  assert.deepEqual(standing.map((rejection) => rejection.claimId), [revenue.id]);
});
