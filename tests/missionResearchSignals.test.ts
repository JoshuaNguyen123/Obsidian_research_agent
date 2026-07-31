import assert from "node:assert/strict";
import test from "node:test";
import { buildMissionResearchSignalsV1 } from "../src/agent/missionResearchSignals";
import { scoreMissionV1 } from "../src/agent/missionScorecard";
import type { MissionEvidence } from "../src/agent/missionLedger";
import type { ResearchPlan } from "../src/agent/researchPlan";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function webPlan(minFetchedSources: number, minDistinctDomains = 2): ResearchPlan {
  return {
    version: 1,
    mode: "deep_web",
    sourceRequirements: { minFetchedSources, minDistinctDomains },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [],
    evidenceIds: [],
    status: "in_progress",
  } as ResearchPlan;
}

function source(id: string, url: string, contentHash?: string): MissionEvidence {
  return {
    id,
    kind: "web_source",
    title: id,
    url,
    summary: "s",
    confidence: "high",
    usableSource: true,
    ...(contentHash ? { contentHash } : {}),
  } as MissionEvidence;
}

const CLAIMS = {
  claims: [
    {
      id: "c1",
      text: "Finding one.",
      status: "grounded" as const,
      passageIds: ["source:a:passage:0-100", "source:b:passage:0-90"],
      quoteSpans: [{ passageId: "source:a:passage:0-100", quote: "exact words" }],
    },
    {
      id: "c2",
      text: "Finding two.",
      status: "grounded" as const,
      passageIds: ["source:b:passage:0-90"],
    },
    { id: "c3", text: "Limitations note.", status: "exempt" as const, passageIds: [] },
  ],
};

const FINAL_OUTPUT = [
  "# Findings",
  "body",
  "## Analysis",
  "body",
  "## Limitations",
  "body",
  "## Confidence",
  "Medium.",
].join("\n");

test("a web-bearing research mission produces real, non-vacuous signals", () => {
  const signals = buildMissionResearchSignalsV1({
    researchPlan: webPlan(2),
    evidence: [
      source("web:1", "https://a.example/1", HASH_A),
      source("web:2", "https://b.example/1", HASH_B),
    ],
    claimLedger: CLAIMS,
    finalOutput: FINAL_OUTPUT,
  });
  assert.ok(signals);
  assert.deepEqual(signals.usableSourceUrls, [
    "https://a.example/1",
    "https://b.example/1",
  ]);
  assert.equal(signals.requiredDistinctDomains, 2);
  // Exempt claims are not "claims requiring evidence".
  assert.equal(signals.claimsRequiringEvidence, 2);
  assert.equal(signals.citedPassageCount, 2);
  assert.equal(signals.quotedSpanCount, 1);
  assert.equal(signals.sectionCount, 4);
});

test("no plan, chat mode, and vault-only research all yield undefined", () => {
  // Undefined keeps the scorecard's empty-set convention: a mission with no
  // web-bearing research has nothing to be thin about, so both dimensions
  // score 1.0 by design rather than by accident.
  const evidence = [source("web:1", "https://a.example/1", HASH_A)];
  const rest = { evidence, claimLedger: CLAIMS, finalOutput: FINAL_OUTPUT };
  assert.equal(
    buildMissionResearchSignalsV1({ researchPlan: null, ...rest }),
    undefined,
  );
  assert.equal(
    buildMissionResearchSignalsV1({ researchPlan: undefined, ...rest }),
    undefined,
  );
  assert.equal(
    buildMissionResearchSignalsV1({
      researchPlan: { ...webPlan(1), mode: "none" } as ResearchPlan,
      ...rest,
    }),
    undefined,
  );
  assert.equal(
    buildMissionResearchSignalsV1({ researchPlan: webPlan(0), ...rest }),
    undefined,
  );
});

test("mirrors collapse and unusable or unhashed-duplicate sources behave correctly", () => {
  const signals = buildMissionResearchSignalsV1({
    researchPlan: webPlan(2),
    evidence: [
      source("web:1", "https://origin.example/report", HASH_A),
      // Same text served under a second hostname: one source of authority.
      source("web:2", "https://mirror.example/report", HASH_A),
      // No verifiable hash: keeps its own URL identity.
      source("web:3", "https://third.example/x"),
      // Unusable sources never count.
      { ...source("web:4", "https://bad.example/x"), usableSource: false } as MissionEvidence,
      // Duplicate URL is counted once.
      source("web:5", "https://third.example/x"),
    ],
    claimLedger: CLAIMS,
    finalOutput: FINAL_OUTPUT,
  });
  assert.ok(signals);
  assert.deepEqual(signals.usableSourceUrls, [
    "https://origin.example/report",
    "https://third.example/x",
  ]);
});

test("an absent claim ledger and empty output degrade to zeros, not throws", () => {
  const signals = buildMissionResearchSignalsV1({
    researchPlan: webPlan(1),
    evidence: [],
    claimLedger: null,
    finalOutput: "",
  });
  assert.ok(signals);
  assert.equal(signals.claimsRequiringEvidence, 0);
  assert.equal(signals.citedPassageCount, 0);
  assert.equal(signals.quotedSpanCount, 0);
  assert.equal(signals.sectionCount, 0);
  assert.deepEqual(signals.usableSourceUrls, []);
});

test("end to end: the signals make the research dimensions move", () => {
  // The regression this module exists to close: with no research block both
  // dimensions scored a constant 1.0, so a thin summary was invisible.
  const base = {
    acceptanceCriteriaTotal: 4,
    acceptanceCriteriaMissing: 0,
    acceptancePassed: true,
    claimsRequiringEvidence: 2,
    claimsWithEvidence: 2,
    mutationsPerformed: 1,
    mutationsWithReceipts: 1,
    recoveryAttempts: 0,
    modelCalls: 5,
    modelCallBudget: 50,
    wallClockMs: 1000,
    wallClockBudgetMs: 100_000,
  };
  const thin = scoreMissionV1({
    ...base,
    research: buildMissionResearchSignalsV1({
      researchPlan: webPlan(2),
      evidence: [source("web:1", "https://a.example/1", HASH_A)],
      claimLedger: { claims: [CLAIMS.claims[1]] },
      finalOutput: "One paragraph, no headings.",
    }),
  });
  const thorough = scoreMissionV1({
    ...base,
    research: buildMissionResearchSignalsV1({
      researchPlan: webPlan(2),
      evidence: [
        source("web:1", "https://a.example/1", HASH_A),
        source("web:2", "https://b.example/1", HASH_B),
      ],
      claimLedger: CLAIMS,
      finalOutput: FINAL_OUTPUT,
    }),
  });
  assert.ok(thin.total < thorough.total, `${thin.total} !< ${thorough.total}`);
});
