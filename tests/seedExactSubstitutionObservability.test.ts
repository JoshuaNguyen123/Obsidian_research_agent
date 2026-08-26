import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canonicalizeProviderSafeAcceptedResearchTextV1,
  projectIdeaSeedBoundFieldProjectionsV1,
  PROJECT_IDEA_SEED_BOUND_FIELD_NAMES_V1,
} from "../src/integrations/linear";
import {
  createProjectIdeaBriefV1,
  deriveAcceptedResearchSeedFromProjectIdeaBriefV1,
} from "../packages/core-api/src";

const AGENT_RUNNER_SOURCE = readFileSync(
  new URL("../src/AgentRunner.ts", import.meta.url),
  "utf8",
);
const PUBLICATION_TOOL_SOURCE = readFileSync(
  new URL("../src/tools/researchPublicationTool.ts", import.meta.url),
  "utf8",
);
const NOTE_WRITER_SOURCE = readFileSync(
  new URL("../src/integrations/linear/AcceptedResearchNoteWriter.ts", import.meta.url),
  "utf8",
);

/**
 * The host's seed substitution is the only place a paraphrase-correction on a
 * seed-bound accepted-research field becomes measurable. It was computed and
 * discarded once before: `substitutedFields` had no consumer anywhere in src/,
 * so a live publish blocker could not be told apart from a substitution that
 * never fired, and the diagnosis stalled for a whole compound attempt.
 *
 * This is a source-level guard on purpose. A journalled trace only proves its
 * worth on the run that goes wrong, which is exactly the run nobody is
 * watching, so its absence has to fail here instead.
 */
test("the AgentRunner execution boundary journals which seed-bound fields it substituted", () => {
  assert.match(
    AGENT_RUNNER_SOURCE,
    /canonicalSeedExactAcceptedResearchPackageV1/u,
    "AgentRunner must consume the seed substitution predicate at its execution boundary, mirroring canonicalExactLinearIssueReadIdV1.",
  );
  const seat =
    /if \(toolCall\.name === PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME\) \{[\s\S]*?\n    \}/u.exec(
      AGENT_RUNNER_SOURCE,
    )?.[0] ?? "";
  assert.ok(seat, "expected a publish_research_to_linear execution-boundary seat");
  assert.match(
    seat,
    /canonicalSeedExactAcceptedResearchPackageV1\(\{/u,
    "the publish seat must call the shared substitution predicate",
  );
  assert.match(
    seat,
    /events\.onTrace\?\.\(\{/u,
    "the publish seat must journal its substitution on the trace",
  );
  assert.match(
    seat,
    /substitutedFields/u,
    "the journalled trace must name the substituted fields, not merely that something happened",
  );
  assert.match(
    seat,
    /outputPreview: \{\s*substitutedFields: seedExact\.substitutedFields,/u,
    "substitutedFields must reach the trace payload where a run note can read it back",
  );
});

/**
 * `substitutedFields` must have at least one real consumer in src/. The
 * regression that cost a compound attempt was not a wrong value; it was a
 * correct value nothing read.
 */
test("substitutedFields is consumed, not discarded", () => {
  const consumers = [AGENT_RUNNER_SOURCE, PUBLICATION_TOOL_SOURCE].filter(
    (source) => /substitutedFields/u.test(source),
  );
  assert.ok(
    consumers.length >= 2,
    "substitutedFields must be produced by the tool and consumed by the runner seat",
  );
});

/**
 * The host rewrite that strips raw filesystem paths and shell commands out of
 * accepted-research prose must exist exactly once. Two copies is how the
 * publish seat and the drift guard came to read the same bytes through
 * different lenses: the tool rewrote a seed-bound field, the guard compared
 * the rewrite against the raw seed, and every durable seed whose brief named a
 * repository path became permanently unpublishable.
 */
test("the provider-safe accepted-research rewrite is defined exactly once", () => {
  const declarations = [
    ...PUBLICATION_TOOL_SOURCE.matchAll(
      /^(?:export\s+)?function\s+(canonicalizeProviderSafe[A-Za-z0-9_]*)\s*\(/gmu,
    ),
    ...NOTE_WRITER_SOURCE.matchAll(
      /^(?:export\s+)?function\s+(canonicalizeProviderSafe[A-Za-z0-9_]*)\s*\(/gmu,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(
    declarations,
    [],
    `A private copy of the provider-safe rewrite was reintroduced: ${declarations.join(", ")}. ` +
      "Import canonicalizeProviderSafeAcceptedResearchTextV1 from LinearContractSupport so the " +
      "outgoing package and the seed projection are canonicalized by the same code.",
  );
  assert.match(
    PUBLICATION_TOOL_SOURCE,
    /canonicalizeProviderSafeAcceptedResearchTextV1\(packageRecord\)/u,
    "the publication tool must apply the shared rewrite to the outgoing package",
  );
  assert.match(
    NOTE_WRITER_SOURCE,
    /canonicalizeProviderSafeAcceptedResearchTextV1\(canonicalized\)/u,
    "the seed-bound projection must read both sides through the same rewrite",
  );
});

function seedFixture(overrides: {
  summary?: string;
  acceptanceCriteria?: { id: string; text: string }[];
  proposedWork?: string[];
}) {
  return deriveAcceptedResearchSeedFromProjectIdeaBriefV1(
    createProjectIdeaBriefV1({
      ideaId: "idea-lens",
      title: "Accepted research",
      problem: "The durable handoff is required.",
      hypothesis: "An exact signed handoff makes publication auditable.",
      options: [{
        id: "option-a",
        title: "Persist the exact handoff",
        summary: overrides.summary ?? "Implement the accepted work item.",
      }],
      selectedOptionId: "option-a",
      proposedWork: overrides.proposedWork ?? ["Implement the accepted work."],
      nonGoals: ["Automatic merge."],
      constraints: [],
      risks: [],
      acceptanceCriteria: overrides.acceptanceCriteria ??
        [{ id: "AC-1", text: "The handoff is verified." }],
      evidenceStatus: "grounded",
      evidence: [{
        id: `evidence-${"a".repeat(64)}`,
        kind: "web",
        reference: "https://example.test/evidence",
        contentSha256: `sha256:${"a".repeat(64)}`,
      }],
      riskClass: "medium",
      limitations: ["Provider smoke testing remains separate."],
      createdAt: "2026-07-12T20:00:00.000Z",
    }),
  );
}

function packageFrom(
  seed: ReturnType<typeof seedFixture>,
  overrides: Record<string, unknown> = {},
) {
  return {
    title: seed.title,
    problemImpact: seed.problemImpact,
    objective: seed.selectedDirection.summary,
    proposedWork: seed.proposedWork,
    nonGoals: seed.nonGoals,
    acceptanceCriteria: seed.acceptanceCriteria,
    evidence: seed.evidence,
    riskClass: seed.riskClass,
    validationRequirementKeys: ["trusted.validation"],
    repositoryKey: "trusted-repo",
    ...overrides,
  };
}

test("the seed projection compares both sides through the host rewrite", () => {
  // A brief written for a code mission names the file it pins, so its selected
  // direction carries a repository path the publication contract refuses.
  const seed = seedFixture({
    summary:
      "Minimal marker export: pin src/flow_real.ts to a single export const marker line.",
    acceptanceCriteria: [
      { id: "AC-1", text: "The exported marker in src/flow_real.ts matches the brief." },
    ],
  });
  // The package as the publication tool hands it to the guard: already
  // rewritten into host-owned language.
  const rewritten = packageFrom(seed);
  canonicalizeProviderSafeAcceptedResearchTextV1(
    rewritten as unknown as Record<string, unknown>,
  );
  assert.notEqual(rewritten.objective, seed.selectedDirection.summary);

  const { accepted, seeded } = projectIdeaSeedBoundFieldProjectionsV1({
    package_: rewritten,
    seed,
  });
  const drifted = PROJECT_IDEA_SEED_BOUND_FIELD_NAMES_V1.filter(
    (key) => JSON.stringify(accepted[key]) !== JSON.stringify(seeded[key]),
  );
  assert.deepEqual(
    drifted,
    [],
    "a package carrying the host's own rewrite of an unsafe seed must not read as drift",
  );

  // The lens never invents agreement. A paraphrase of a field whose seeded
  // value is safe still drifts, and the rewrite leaves safe text untouched.
  const paraphrased = projectIdeaSeedBoundFieldProjectionsV1({
    package_: packageFrom(seed, { nonGoals: ["Something the brief never said."] }),
    seed,
  });
  assert.deepEqual(paraphrased.seeded.nonGoals, ["Automatic merge."]);
  assert.notEqual(
    JSON.stringify(paraphrased.accepted.nonGoals),
    JSON.stringify(paraphrased.seeded.nonGoals),
  );

  // A wholly safe seed is projected verbatim on both sides: the guard keeps
  // its byte-for-byte teeth wherever exactness was reachable to begin with.
  const safeSeed = seedFixture({});
  const safe = projectIdeaSeedBoundFieldProjectionsV1({
    package_: packageFrom(safeSeed),
    seed: safeSeed,
  });
  assert.equal(safe.seeded.objective, safeSeed.selectedDirection.summary);
  assert.deepEqual(safe.seeded.acceptanceCriteria, safeSeed.acceptanceCriteria);
  const safeDrift = PROJECT_IDEA_SEED_BOUND_FIELD_NAMES_V1.filter(
    (key) => JSON.stringify(safe.accepted[key]) !== JSON.stringify(safe.seeded[key]),
  );
  assert.deepEqual(safeDrift, []);
  const safeParaphrase = projectIdeaSeedBoundFieldProjectionsV1({
    package_: packageFrom(safeSeed, {
      objective: "A paraphrase of the selected direction.",
    }),
    seed: safeSeed,
  });
  assert.notEqual(
    safeParaphrase.accepted.objective,
    safeParaphrase.seeded.objective,
  );
});

test("projecting a seed never mutates the durable seed or the caller's package", () => {
  const seed = seedFixture({
    summary: "Pin src/flow_real.ts to a single export const marker line.",
    acceptanceCriteria: [
      { id: "AC-1", text: "Run npm test and confirm src/flow_real.ts exports the marker." },
    ],
  });
  const seedBefore = JSON.stringify(seed);
  const package_ = packageFrom(seed);
  const packageBefore = JSON.stringify(package_);

  projectIdeaSeedBoundFieldProjectionsV1({ package_, seed });

  assert.equal(JSON.stringify(seed), seedBefore, "the durable seed must stay verbatim");
  assert.equal(
    JSON.stringify(package_),
    packageBefore,
    "projection is a read: it must not rewrite the caller's package",
  );
});

test("the host rewrite is idempotent, so projecting twice is projecting once", () => {
  const record: Record<string, unknown> = {
    objective: "Pin src/flow_real.ts to one export.",
    acceptanceCriteria: [
      { id: "AC-1", text: "Run npm test against src/flow_real.ts." },
    ],
    proposedWork: ["Edit src/flow_real.ts."],
    validationRequirementKeys: ["trusted.validation"],
    repositoryKey: "trusted-repo",
  };
  canonicalizeProviderSafeAcceptedResearchTextV1(record);
  const once = JSON.stringify(record);
  canonicalizeProviderSafeAcceptedResearchTextV1(record);
  assert.equal(JSON.stringify(record), once);
  // And what it produced is itself safe, which is what makes the lens stable.
  assert.doesNotMatch(once, /src\/flow_real\.ts/u);
  assert.doesNotMatch(once, /npm test/u);
});
