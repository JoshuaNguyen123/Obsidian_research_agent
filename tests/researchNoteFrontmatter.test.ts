import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResearchNoteFrontmatter,
  toResearchTag,
  withResearchNoteFrontmatter,
} from "../src/agent/researchNoteFrontmatter";
import { buildTransactionalResearchPackPlan } from "../src/orchestrator/researchTemplateWorkflow";
import { isResearchPackEligibleV1 } from "../src/AgentRunner";
import type { ResearchPlan } from "../src/agent/researchPlan";
import type { MissionEvidence } from "../src/agent/missionLedger";

const CREATED = "2026-07-31T12:00:00.000Z";

test("frontmatter carries title, date, tags, and provenance", () => {
  const block = buildResearchNoteFrontmatter({
    title: "Onboarding retention",
    created: CREATED,
    tags: ["Onboarding retention", "brief"],
    sourceCount: 3,
    confidence: "medium",
    runId: "run-123",
  });
  assert.match(block, /^---\n/);
  assert.match(block, /\ntitle: Onboarding retention\n/);
  assert.match(block, /\ncreated: "2026-07-31T12:00:00.000Z"\n/);
  assert.match(block, /\ntags: \[research, onboarding-retention, brief\]\n/);
  assert.match(block, /\nsources: 3\n/);
  assert.match(block, /\nconfidence: medium\n/);
  assert.match(block, /\nagent-run-id: "run-123"\n/);
  assert.match(block, /\n---\n$/);
});

test("a title containing YAML control characters is quoted, not left to corrupt the block", () => {
  // "Study: a review" unquoted turns one property into a nested map.
  for (const title of [
    "Study: a review",
    "Cost #1",
    "- leading dash",
    'He said "hi"',
    "true",
    "2024",
  ]) {
    const block = buildResearchNoteFrontmatter({ title, created: CREATED });
    const titleLine = block.split("\n").find((line) => line.startsWith("title:"));
    assert.ok(titleLine, `no title line for ${JSON.stringify(title)}`);
    assert.match(
      titleLine,
      /^title: ".*"$/u,
      `expected a quoted scalar for ${JSON.stringify(title)}, got ${titleLine}`,
    );
  }
});

test("a multi-line title collapses to one line and cannot split the block", () => {
  // Injecting "---" or a second property via a newline is the attack this
  // guards; collapsing to a single safe scalar is enough, quoting is not.
  const block = buildResearchNoteFrontmatter({
    title: "a\n---\nmalicious: true\nb",
    created: CREATED,
  });
  assert.equal(block.split("\n").filter((line) => line === "---").length, 2);
  assert.doesNotMatch(block, /^malicious:/mu);
  assert.match(block, /^title: "a --- malicious: true b"$/mu);
});

test("optional properties are omitted rather than emitted empty", () => {
  const block = buildResearchNoteFrontmatter({ title: "T", created: CREATED });
  assert.doesNotMatch(block, /sources:/);
  assert.doesNotMatch(block, /confidence:/);
  assert.doesNotMatch(block, /agent-run-id:/);
  assert.match(block, /tags: \[research\]/);
});

test("tag slugs drop unusable titles instead of emitting empty tags", () => {
  assert.equal(toResearchTag("Onboarding Retention!"), "onboarding-retention");
  assert.equal(toResearchTag("???"), null);
  assert.equal(toResearchTag(""), null);
  // A tag starting with a digit is not a valid Obsidian tag on its own.
  assert.equal(toResearchTag("2024 review"), null);
});

test("existing frontmatter is never stacked with a second block", () => {
  const body = "---\ntitle: mine\n---\n\n# Note";
  assert.equal(withResearchNoteFrontmatter(body, { title: "T", created: CREATED }), body);
});

test("the research pack applies frontmatter to all four notes", () => {
  const plan = buildTransactionalResearchPackPlan({
    transactionId: "tx-1",
    baseFolder: "Research",
    title: "Onboarding retention",
    brief: "# Brief\n\nBody.",
    sources: [{ id: "s1", title: "A", url: "https://a.example" }],
    synthesis: "Synthesis body.",
    createdAt: CREATED,
    runId: "run-9",
  });
  assert.equal(plan.artifacts.length, 4);
  for (const artifact of plan.artifacts) {
    assert.match(
      artifact.content,
      /^---\ntitle: /u,
      `${artifact.path} is missing frontmatter`,
    );
    assert.match(artifact.content, /tags: \[research, onboarding-retention/u);
  }
});

test("a pack built without a timestamp keeps exactly its original content", () => {
  // Frontmatter is opt-in on the builder so existing callers and fixtures are
  // byte-for-byte unaffected.
  const plan = buildTransactionalResearchPackPlan({
    transactionId: "tx-1",
    baseFolder: "Research",
    title: "T",
    brief: "# Brief\n\nBody.",
    sources: [],
    synthesis: "Synthesis body.",
  });
  const brief = plan.artifacts.find((artifact) => artifact.id === "brief");
  assert.doesNotMatch(brief?.content ?? "", /^---/u);
  assert.match(brief?.content ?? "", /^# Brief\n\nBody\./u);
});

test("a hub note is linked only when one is configured", () => {
  const withHub = buildTransactionalResearchPackPlan({
    transactionId: "tx-1",
    baseFolder: "Research",
    title: "T",
    brief: "b",
    sources: [],
    synthesis: "s",
    createdAt: CREATED,
    hubNote: "Research/Index.md",
  });
  const index = withHub.artifacts.find((artifact) => artifact.id === "index");
  assert.match(index?.content ?? "", /\[\[Research\/Index\]\]/u);

  const withoutHub = buildTransactionalResearchPackPlan({
    transactionId: "tx-1",
    baseFolder: "Research",
    title: "T",
    brief: "b",
    sources: [],
    synthesis: "s",
    createdAt: CREATED,
  });
  const plainIndex = withoutHub.artifacts.find((artifact) => artifact.id === "index");
  assert.doesNotMatch(plainIndex?.content ?? "", /Related:/u);
});

function webPlan(minFetchedSources: number): ResearchPlan {
  return {
    version: 1,
    mode: "deep_web",
    sourceRequirements: { minFetchedSources, minDistinctDomains: 1 },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [],
    evidenceIds: [],
    status: "in_progress",
  } as ResearchPlan;
}

function verifiedSource(id: string, url: string): MissionEvidence {
  return {
    id,
    kind: "web_source",
    title: id,
    url,
    summary: "s",
    confidence: "high",
    usableSource: true,
    contentHash: `sha256:${id.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/gu, "0")}`,
  } as MissionEvidence;
}

test("the research pack is certified only once the source floor is actually met", () => {
  const plan = webPlan(2);
  assert.equal(
    isResearchPackEligibleV1({ plan, evidence: [verifiedSource("a", "https://a.example/1")] }),
    false,
  );
  assert.equal(
    isResearchPackEligibleV1({
      plan,
      evidence: [
        verifiedSource("a", "https://a.example/1"),
        verifiedSource("b", "https://b.example/1"),
      ],
    }),
    true,
  );
});

test("no plan, a chat plan, or a vault-only plan never certifies the pack", () => {
  // A plan alone would let a mission that fetched nothing emit four notes of
  // unsourced prose, which is worse than a plain append.
  const evidence = [verifiedSource("a", "https://a.example/1")];
  assert.equal(isResearchPackEligibleV1({ plan: null, evidence }), false);
  assert.equal(
    isResearchPackEligibleV1({ plan: { ...webPlan(1), mode: "none" } as ResearchPlan, evidence }),
    false,
  );
  // Vault-only research has no source floor to clear, so it stays phrase-gated.
  assert.equal(isResearchPackEligibleV1({ plan: webPlan(0), evidence }), false);
});
