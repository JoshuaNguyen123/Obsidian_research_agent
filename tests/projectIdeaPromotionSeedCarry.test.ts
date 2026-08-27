import assert from "node:assert/strict";
import test from "node:test";

import {
  CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME,
  createProjectIdeaBriefTool,
  type ProjectIdeaBriefToolOutputV1,
} from "../src/tools/projectIdeaBriefTool";
import type {
  AgentRuntimeCache,
  ToolExecutionContext,
} from "../src/tools/types";
import {
  assertProjectIdeaSeedPublicationBindingV1,
  hasAffirmativeProjectIdeationIntentV1 as publicationSideIdeationIntent,
  PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
} from "../src/tools/researchPublicationTool";
import { hasProjectIdeationIntent } from "../src/agent/promptIntentClassifiers";
import { hasAffirmativeProjectIdeationIntentV1 as sharedIdeationIntent } from "../src/agent/projectIdeationIntent";
import {
  PROJECT_IDEA_PROMOTION_CARRY_OUTPUT_KEY,
  projectIdeaPromotionCarryOutputsV1,
  restoreProjectIdeaPromotionSeedFromMissionGraphV1,
} from "../src/agent/projectIdeaPromotionSeedCarry";
import type { AcceptedResearchNotePackageV1 } from "../src/integrations/linear";

const WEB_SHA = `sha256:${"a".repeat(64)}`;
const WEB_URL = "https://example.com/research";

/**
 * The measured compound red (main 0078d6c, proof-matrix attempt 9): the mission
 * created its grounded, selected project-idea brief in one segment and reached
 * `tool-06-publish_research_to_linear` in the NEXT segment, where the run-local
 * ideation bridge no longer existed. `runtimeCache` is rebuilt per
 * `runAgentMission` call and every continuation segment is a separate call, so
 * the seed the publish seat requires had been destroyed by a boundary the
 * mission did not choose. The producing node was already `complete` and the
 * graph refuses to rewrite completed nodes, so no further attempt could ever
 * recreate it: the node burned both attempts on the identical refusal and the
 * mission stopped with approved=0.
 *
 * These tests are written against the seam, not the symptom: whatever else
 * changes, a brief that completed in an earlier segment must still be able to
 * pay the publish seat's obligation.
 */

test("a grounded ideation brief carries its exact signed seed onto durable node outputs", async () => {
  const cache = groundedCache();
  const output = await produceGroundedBrief(cache);

  assert.equal(output.promotion.eligible, true);
  assert.notEqual(output.promotion.seed, null);
  // The producer's own durability contract states the bridge does not survive
  // a restart; the carry is what makes that survivable.
  assert.deepEqual(output.durability, {
    scope: "run_local",
    restartRequiresBriefRecreation: true,
  });

  const outputs = projectIdeaPromotionCarryOutputsV1(
    CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME,
    { ok: true, output },
  );
  assert.notEqual(outputs, null);
  const carry = outputs![PROJECT_IDEA_PROMOTION_CARRY_OUTPUT_KEY] as {
    version: number;
    brief: unknown;
    seed: unknown;
  };
  assert.equal(carry.version, 1);
  assert.deepEqual(carry.brief, output.brief);
  assert.deepEqual(carry.seed, output.promotion.seed);
});

test("only the promotable ideation tool result produces a carry", async () => {
  const cache = groundedCache();
  const grounded = await produceGroundedBrief(cache);

  // Wrong tool.
  assert.equal(
    projectIdeaPromotionCarryOutputsV1("web_fetch", { ok: true, output: grounded }),
    null,
  );
  // Failed call.
  assert.equal(
    projectIdeaPromotionCarryOutputsV1(CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME, {
      ok: false,
      output: grounded,
    }),
    null,
  );
  // An unselected/unverified brief is NOT promotable. Carrying it would turn a
  // recoverable "select an option" into the publish seat's hard
  // `project_idea_not_promotable` refusal on the far side of the boundary.
  const unpromotable = (await createProjectIdeaBriefTool().execute(
    ideaArgs(),
    contextFor(groundedCache()),
  )) as ProjectIdeaBriefToolOutputV1;
  assert.equal(unpromotable.promotion.eligible, false);
  assert.equal(
    projectIdeaPromotionCarryOutputsV1(CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME, {
      ok: true,
      output: unpromotable,
    }),
    null,
  );
});

test("a continuation segment rebinds the seed from the completed producer node and publishes", async () => {
  const firstSegmentCache = groundedCache();
  const output = await produceGroundedBrief(firstSegmentCache);
  const seed = firstSegmentCache.projectIdeaAcceptedResearchSeed!;
  const package_ = acceptedPackage(seed);

  // Same segment: the live cache satisfies the publish seat today.
  assert.doesNotThrow(() =>
    assertProjectIdeaSeedPublicationBindingV1(
      package_,
      firstSegmentCache,
      IDEATION_MISSION,
    ),
  );

  // The segment ends. `runAgentMission` returns and the next segment builds a
  // brand-new runtime cache (AgentRunner.ts:2287); nothing rehydrates the
  // ideation bridge. This is the exact production state.
  const secondSegmentCache: AgentRuntimeCache = {
    toolResults: new Map(),
    trustedWebFetchResults: new Map(),
  };
  const strandedPackage = withoutDurableSeed(package_);
  assert.throws(
    () =>
      assertProjectIdeaSeedPublicationBindingV1(
        strandedPackage,
        secondSegmentCache,
        IDEATION_MISSION,
      ),
    (error: unknown) =>
      (error as { code?: string }).code ===
        "research_publication_project_idea_seed_required",
    "unfixed tree: the second segment cannot pay the publish seat's obligation",
  );

  // The graph carries the producer's durable outputs across the boundary.
  const graph = graphWithCompletedBrief(
    projectIdeaPromotionCarryOutputsV1(CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME, {
      ok: true,
      output,
    })!,
  );
  const restored = restoreProjectIdeaPromotionSeedFromMissionGraphV1(
    secondSegmentCache,
    graph,
  );
  assert.equal(restored.restored, true);
  assert.equal(restored.reason, "restored");
  assert.equal(restored.nodeId, "tool-04-create_project_idea_brief");
  assert.deepEqual(secondSegmentCache.projectIdeaBrief, output.brief);
  assert.deepEqual(secondSegmentCache.projectIdeaAcceptedResearchSeed, seed);

  // And the publish seat is payable again — byte-for-byte, not approximately.
  assert.doesNotThrow(() =>
    assertProjectIdeaSeedPublicationBindingV1(
      package_,
      secondSegmentCache,
      IDEATION_MISSION,
    ),
  );
});

test("the carry fails closed and never invents ideation authority", async () => {
  const cache = groundedCache();
  const output = await produceGroundedBrief(cache);
  const outputs = projectIdeaPromotionCarryOutputsV1(
    CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME,
    { ok: true, output },
  )!;

  // No producer node at all.
  const empty: AgentRuntimeCache = { toolResults: new Map() };
  assert.deepEqual(
    restoreProjectIdeaPromotionSeedFromMissionGraphV1(empty, { nodes: {} }),
    { restored: false, reason: "no_carry_found" },
  );
  assert.equal(empty.projectIdeaBrief, undefined);

  // A live cache is never overwritten by durable state.
  const live = groundedCache();
  live.projectIdeaBrief = output.brief;
  live.projectIdeaAcceptedResearchSeed = cache.projectIdeaAcceptedResearchSeed;
  assert.equal(
    restoreProjectIdeaPromotionSeedFromMissionGraphV1(
      live,
      graphWithCompletedBrief(outputs),
    ).reason,
    "cache_already_bound",
  );

  // A tampered seed does not restore: the seed must be the exact derivation of
  // the brief it claims to come from, proved the same way the publish seat
  // proves it.
  const tampered = JSON.parse(JSON.stringify(outputs)) as Record<string, any>;
  tampered[PROJECT_IDEA_PROMOTION_CARRY_OUTPUT_KEY].seed.title =
    "Title the signed brief never authorized";
  const tamperedCache: AgentRuntimeCache = { toolResults: new Map() };
  const tamperedResult = restoreProjectIdeaPromotionSeedFromMissionGraphV1(
    tamperedCache,
    graphWithCompletedBrief(tampered),
  );
  assert.equal(tamperedResult.restored, false);
  assert.equal(tamperedResult.reason, "carry_unverifiable");
  assert.equal(tamperedCache.projectIdeaBrief, undefined);
  assert.equal(tamperedCache.projectIdeaAcceptedResearchSeed, undefined);

  // A truncated carry does not restore either.
  const truncatedCache: AgentRuntimeCache = { toolResults: new Map() };
  assert.equal(
    restoreProjectIdeaPromotionSeedFromMissionGraphV1(
      truncatedCache,
      graphWithCompletedBrief({
        [PROJECT_IDEA_PROMOTION_CARRY_OUTPUT_KEY]: { version: 1, brief: null, seed: null },
      }),
    ).reason,
    "carry_unverifiable",
  );
  assert.equal(truncatedCache.projectIdeaAcceptedResearchSeed, undefined);
});

/**
 * The seat that OFFERS and PLANS `create_project_idea_brief` and the seat that
 * REQUIRES its promotion seed must be one predicate, not two that agree today.
 * They were two byte-identical copies; this pins the collapse so a future edit
 * cannot reintroduce `offered ⊄ gate-accepted` — the shape that killed
 * `tool-10` in researchProjectHierarchyTool and `tool-01-create_file` in
 * missionRouter, both on `tool_failure_repeated`.
 */
test("offering and requiring ideation consult one shared predicate", () => {
  assert.equal(
    hasProjectIdeationIntent,
    publicationSideIdeationIntent,
    "the planner-side and publication-side ideation classifiers must be the same function object",
  );
  assert.equal(
    sharedIdeationIntent,
    publicationSideIdeationIntent,
    "both seats must resolve to agent/projectIdeationIntent",
  );
  // Behavior pins that must survive any future narrowing, checked through BOTH
  // entry points so they can never diverge silently.
  for (const resolve of [hasProjectIdeationIntent, publicationSideIdeationIntent]) {
    assert.equal(resolve(IDEATION_MISSION), true);
    assert.equal(
      resolve("Do not brainstorm project ideas; publish the existing independent research."),
      false,
    );
    assert.equal(resolve("Explain a completed project."), false);
  }
});

const IDEATION_MISSION =
  "First research the topic using exactly two public web sources. After both fetches, call create_project_idea_brief exactly once, evaluate at least two project directions and select one option. Publish the accepted research note to Linear.";

async function produceGroundedBrief(
  cache: AgentRuntimeCache,
): Promise<ProjectIdeaBriefToolOutputV1> {
  return (await createProjectIdeaBriefTool().execute(
    {
      ...ideaArgs(),
      selectedOptionId: "option-a",
      groundingReferences: [{ kind: "web", reference: WEB_URL }],
    },
    contextFor(cache),
  )) as ProjectIdeaBriefToolOutputV1;
}

function groundedCache(): AgentRuntimeCache {
  return {
    toolResults: new Map(),
    trustedWebFetchResults: new Map([
      [
        "web",
        {
          ok: true,
          toolName: "web_fetch",
          output: {
            normalizedUrl: WEB_URL,
            contentHash: WEB_SHA,
            urlHash: "0123456789abcdef",
          },
        },
      ],
    ]),
  };
}

function contextFor(cache: AgentRuntimeCache): ToolExecutionContext {
  return {
    originalPrompt: IDEATION_MISSION,
    runtimeCache: cache,
    now: () => new Date("2026-08-19T12:00:00.000Z"),
  } as ToolExecutionContext;
}

/**
 * A first publish in a later segment has no prior checkpoint, so the package
 * the tool builds carries no durable `projectIdeaSeed`: that field is hydrated
 * from the run-local cache and from nothing else.
 */
function withoutDurableSeed(
  package_: AcceptedResearchNotePackageV1,
): AcceptedResearchNotePackageV1 {
  const next = { ...package_ } as Record<string, unknown>;
  delete next.projectIdeaSeed;
  return next as unknown as AcceptedResearchNotePackageV1;
}

function graphWithCompletedBrief(outputs: Record<string, unknown>) {
  return {
    nodes: {
      "tool-02-web_fetch": {
        id: "tool-02-web_fetch",
        status: "complete",
        allowedTools: ["web_fetch"],
        outputs: {},
      },
      "tool-04-create_project_idea_brief": {
        id: "tool-04-create_project_idea_brief",
        status: "complete",
        allowedTools: [CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME],
        outputs,
      },
      "tool-06-publish_research_to_linear": {
        id: "tool-06-publish_research_to_linear",
        status: "ready",
        allowedTools: [PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME],
        outputs: {},
      },
    },
  } as never;
}

function ideaArgs(): Record<string, unknown> {
  return {
    ideaId: "idea-accessible-checkers",
    title: "Accessible checkers guidance",
    problem: "New players cannot tell why a candidate move is useful.",
    hypothesis: "Concise explanations will reduce abandoned turns.",
    options: [
      {
        id: "option-a",
        title: "Explain the selected move",
        summary: "Show one concise legality and strategy explanation.",
      },
      {
        id: "option-b",
        title: "Highlight legal moves",
        summary: "Show legal destinations without strategy text.",
      },
    ],
    selectedOptionId: null,
    proposedWork: ["Calculate and explain legal destinations."],
    nonGoals: ["Do not add a network opponent."],
    constraints: ["Keep the rules engine deterministic."],
    risks: ["Guidance could obscure the board."],
    acceptanceCriteria: [
      { id: "AC-1", text: "Every displayed destination is legal." },
    ],
    riskClass: "low",
    limitations: ["No retention study has been completed."],
  };
}

function acceptedPackage(
  seed: NonNullable<AgentRuntimeCache["projectIdeaAcceptedResearchSeed"]>,
): AcceptedResearchNotePackageV1 {
  return {
    schemaVersion: 1,
    title: seed.title,
    problemImpact: seed.problemImpact,
    evidence: seed.evidence.map((item) => ({
      ...item,
      label: "Verified project-idea evidence",
      summary: "Host-observed evidence used by the selected direction.",
    })),
    confidenceLimitations: seed.limitations.join("\n"),
    proposedWork: seed.proposedWork,
    nonGoals: seed.nonGoals,
    scope: seed.proposedWork,
    dependencies: seed.constraints,
    acceptanceCriteria: seed.acceptanceCriteria,
    validationRequirementKeys: ["tests.unit"],
    riskClass: seed.riskClass,
    executionClass: "research",
    objective: seed.selectedDirection.summary,
    vaultBindingKey: "vault-fixture",
    originRunId: "run-fixture",
    projectIdeaSeed: seed,
  };
}
