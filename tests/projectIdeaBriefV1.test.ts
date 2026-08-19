import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectIdeaBriefV1,
  deriveAcceptedResearchSeedFromProjectIdeaBriefV1,
  parseProjectIdeaAcceptedResearchSeedV1,
  parseProjectIdeaBriefV1,
  ProjectIdeaBriefErrorV1,
  type ProjectIdeaBriefUnsignedV1,
} from "../packages/core-api/src";
import { createAcceptedResearchArtifactV1 } from "../src/integrations/linear/AcceptedResearchArtifactV1";

const CONTENT_SHA = `sha256:${"a".repeat(64)}`;

test("ProjectIdeaBriefV1 is an independently callable deterministic closed contract", () => {
  const input = groundedIdea();
  const first = createProjectIdeaBriefV1(input);
  const second = createProjectIdeaBriefV1(structuredClone(input));

  assert.match(first.fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(parseProjectIdeaBriefV1(structuredClone(first)), first);
  assert.equal(first.kind, "project_idea_brief");
  assert.equal(first.version, 1);
});

test("unverified ideation stands alone but cannot masquerade as accepted research", () => {
  const brief = createProjectIdeaBriefV1({
    ...groundedIdea(),
    selectedOptionId: null,
    evidenceStatus: "unverified",
    evidence: [],
    limitations: ["No source or vault evidence has been gathered yet."],
  });

  assert.equal(parseProjectIdeaBriefV1(brief).evidenceStatus, "unverified");
  assert.throws(
    () => deriveAcceptedResearchSeedFromProjectIdeaBriefV1(brief),
    (error: unknown) =>
      error instanceof ProjectIdeaBriefErrorV1 &&
      /cannot seed accepted research/iu.test(error.message),
  );
});

test("grounded selected ideation feeds accepted research without inventing evidence", () => {
  const brief = createProjectIdeaBriefV1(groundedIdea());
  const seed = deriveAcceptedResearchSeedFromProjectIdeaBriefV1(brief);

  assert.equal(seed.projectIdeaFingerprint, brief.fingerprint);
  assert.equal(seed.selectedDirection.id, "option-a");
  assert.equal(seed.selectedOptionId, "option-a");
  assert.equal(seed.hypothesis, brief.hypothesis);
  assert.deepEqual(seed.options, brief.options);
  assert.deepEqual(seed.constraints, brief.constraints);
  assert.deepEqual(seed.limitations, brief.limitations);
  assert.deepEqual(seed.evidence, brief.evidence);
  assert.deepEqual(seed.acceptanceCriteria, brief.acceptanceCriteria);
  assert.notEqual(seed.evidence, brief.evidence);
  assert.notEqual(seed.acceptanceCriteria, brief.acceptanceCriteria);
  assert.equal(seed.kind, "project_idea_accepted_research_seed");
  assert.equal("noteSha256" in seed, false);
  assert.equal("noteReceiptId" in seed, false);
  assert.deepEqual(parseProjectIdeaAcceptedResearchSeedV1(seed), seed);
});

test("the exact ideation seed fits the existing accepted-research gate that feeds Linear", () => {
  const brief = createProjectIdeaBriefV1(groundedIdea());
  const seed = deriveAcceptedResearchSeedFromProjectIdeaBriefV1(brief);
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-idea-checkers-accessibility",
    originRunId: "run-idea-1",
    vaultBindingKey: "vault-fixture",
    notePath: "Projects/Checkers/Research.md",
    noteSha256: `sha256:${"b".repeat(64)}`,
    noteReceiptId: "receipt-note-1",
    evidence: seed.evidence,
    acceptanceCriteria: seed.acceptanceCriteria,
    riskClass: seed.riskClass,
    acceptedAt: "2026-08-19T12:05:00.000Z",
    acceptedBy: "host",
    projectIdeaSeed: seed,
  });

  assert.deepEqual(artifact.evidence, brief.evidence);
  assert.deepEqual(artifact.acceptanceCriteria, brief.acceptanceCriteria);
  assert.equal(artifact.riskClass, brief.riskClass);
  assert.notEqual(artifact.artifactFingerprint, brief.fingerprint);
  assert.equal(
    artifact.projectIdeaSeed?.projectIdeaFingerprint,
    brief.fingerprint,
  );
});

test("durable ideation seed rejects selection and source-brief tampering after restart", () => {
  const seed = deriveAcceptedResearchSeedFromProjectIdeaBriefV1(
    createProjectIdeaBriefV1(groundedIdea()),
  );
  assert.throws(
    () => parseProjectIdeaAcceptedResearchSeedV1({
      ...seed,
      hypothesis: "A restarted provider changed the hypothesis.",
    }),
    /fingerprint|source brief/iu,
  );
  assert.throws(
    () => parseProjectIdeaAcceptedResearchSeedV1({
      ...seed,
      selectedDirection: seed.options[1],
    }),
    /does not match/iu,
  );
});

test("promotion requires a selected evaluated option", () => {
  const brief = createProjectIdeaBriefV1({
    ...groundedIdea(),
    selectedOptionId: null,
  });
  assert.throws(
    () => deriveAcceptedResearchSeedFromProjectIdeaBriefV1(brief),
    /select one evaluated option/iu,
  );
});

test("ProjectIdeaBriefV1 rejects tampering, unknown fields, and false evidence claims", () => {
  const brief = createProjectIdeaBriefV1(groundedIdea());
  assert.throws(
    () => parseProjectIdeaBriefV1({ ...brief, problem: "Changed after signing." }),
    /fingerprint does not match/iu,
  );
  assert.throws(
    () => parseProjectIdeaBriefV1({ ...brief, providerAuthority: "none" }),
    /closed contract/iu,
  );
  assert.throws(
    () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        evidenceStatus: "grounded",
        evidence: [],
      }),
    /require exact evidence/iu,
  );
  assert.throws(
    () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        selectedOptionId: "missing-option",
      }),
    /must reference/iu,
  );
});

test("ProjectIdeaBriefV1 rejects unsafe evidence references and leaked credentials", () => {
  assert.throws(
    () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        evidence: [
          {
            id: "vault-1",
            kind: "vault",
            reference: "../Secrets.md",
            contentSha256: CONTENT_SHA,
          },
        ],
      }),
    /safe vault-relative Markdown path/iu,
  );
  assert.throws(
    () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        hypothesis: "Use api_key=super-secret-value to query the provider.",
      }),
    /secret-free/iu,
  );
});

function groundedIdea(): ProjectIdeaBriefUnsignedV1 {
  return {
    ideaId: "idea-checkers-accessibility",
    title: "Accessible checkers move guidance",
    problem:
      "New players cannot tell why a candidate move is legal or useful, which makes early sessions frustrating.",
    hypothesis:
      "Concise move explanations will help new players complete a game with fewer abandoned turns.",
    options: [
      {
        id: "option-a",
        title: "Explain the selected move",
        summary:
          "Show one short legality and strategy explanation after a player selects a piece.",
      },
      {
        id: "option-b",
        title: "Show every legal move",
        summary:
          "Highlight all legal moves without explaining their strategic consequence.",
      },
    ],
    selectedOptionId: "option-a",
    proposedWork: [
      "Calculate legal destinations for the selected piece.",
      "Render one concise explanation for each displayed destination.",
    ],
    nonGoals: ["Do not add an automated opponent in this iteration."],
    constraints: ["Keep the rules engine deterministic and locally testable."],
    risks: ["Explanations may obscure the board on small screens."],
    acceptanceCriteria: [
      {
        id: "AC-1",
        text: "Every displayed destination is legal under the existing rules.",
      },
      {
        id: "AC-2",
        text: "Each destination includes one concise human-readable explanation.",
      },
    ],
    evidenceStatus: "grounded",
    evidence: [
      {
        id: "web-1",
        kind: "web",
        reference: "https://example.com/research/checkers-learning",
        contentSha256: CONTENT_SHA,
      },
    ],
    riskClass: "low",
    limitations: ["The source does not measure long-term player retention."],
    createdAt: "2026-08-19T12:00:00.000Z",
  };
}
