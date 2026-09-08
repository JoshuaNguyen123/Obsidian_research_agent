import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMissionRetryVariationPlanV1,
  missionRetryVariationKeyV1,
  shouldRefuseUnchangedRetryV1,
  type MissionRetryVariationInputV1,
} from "../src/agent/missionRetryVariation";
import {
  classifyMissionFailureV1,
  type MissionFailureClassV1,
} from "../src/agent/missionFailureClass";

function retriedNode(
  patch: {
    attempts?: number;
    maxAttempts?: number;
    status?: "ready" | "running" | "blocked" | "complete";
    allowedTools?: string[];
  } = {},
): MissionRetryVariationInputV1["node"] {
  return {
    id: "tool-03-web_fetch",
    objective: "Fetch the primary source for the liability clause.",
    allowedTools: patch.allowedTools ?? ["web_fetch"],
    status: patch.status ?? "ready",
    retries: {
      maxAttempts: patch.maxAttempts ?? 3,
      attempts: patch.attempts ?? 1,
      failureFingerprints: [],
      consecutiveFailureFingerprint: null,
      consecutiveFailureCount: 0,
    },
  } as MissionRetryVariationInputV1["node"];
}

test("a node on its first attempt has nothing to vary", () => {
  assert.equal(
    buildMissionRetryVariationPlanV1({
      node: retriedNode({ attempts: 0 }),
      failureClass: "external",
    }),
    null,
  );
  assert.equal(
    buildMissionRetryVariationPlanV1({
      node: retriedNode({ status: "running" }),
      failureClass: "external",
    }),
    null,
  );
});

test("a retried node is told what failed, whose fault it was, and what it may call", () => {
  const plan = buildMissionRetryVariationPlanV1({
    node: retriedNode({ attempts: 1, maxAttempts: 3 }),
    failureClass: "external",
    failureMessage:
      "web_fetch could not retrieve https://example.com/x (status 404).",
  });
  assert.ok(plan);
  assert.equal(plan.attempt, 2);
  assert.equal(plan.failureClass, "external");
  assert.match(plan.guidance, /attempt 2 of 3/i);
  assert.match(plan.guidance, /status 404/);
  assert.match(plan.guidance, /different source, mirror, or edition/i);
  assert.match(plan.guidance, /Tools available for this attempt: web_fetch/);
});

test("only failures a repeat cannot fix demand a different approach", () => {
  const expectations: Array<[MissionFailureClassV1, boolean]> = [
    ["external", false],
    ["model_transient", false],
    ["model_content", true],
    ["product", true],
    ["unknown", true],
  ];
  for (const [failureClass, requiresChange] of expectations) {
    const plan = buildMissionRetryVariationPlanV1({
      node: retriedNode(),
      failureClass,
    });
    assert.equal(plan?.requireDifferentApproach, requiresChange, failureClass);
  }
});

test("an identical retry is refused only when repeating it cannot work", () => {
  const args = JSON.stringify({ path: "Notes/report.md", section: 2 });
  const rejectedArguments = buildMissionRetryVariationPlanV1({
    node: retriedNode(),
    failureClass: "model_content",
  });
  assert.equal(
    shouldRefuseUnchangedRetryV1({
      plan: rejectedArguments,
      previousArguments: args,
      nextArguments: args,
    }),
    true,
  );

  // A flaky endpoint is a legitimate thing to hit again with the same call.
  const flakySource = buildMissionRetryVariationPlanV1({
    node: retriedNode(),
    failureClass: "external",
  });
  assert.equal(
    shouldRefuseUnchangedRetryV1({
      plan: flakySource,
      previousArguments: args,
      nextArguments: args,
    }),
    false,
  );

  // Nothing recorded from the previous attempt means nothing to compare.
  assert.equal(
    shouldRefuseUnchangedRetryV1({
      plan: rejectedArguments,
      previousArguments: undefined,
      nextArguments: args,
    }),
    false,
  );

  // No plan at all (first attempt) never refuses.
  assert.equal(
    shouldRefuseUnchangedRetryV1({
      plan: null,
      previousArguments: args,
      nextArguments: args,
    }),
    false,
  );
});

test("a genuinely changed call passes, however few words it carries", () => {
  const plan = buildMissionRetryVariationPlanV1({
    node: retriedNode(),
    failureClass: "product",
  });

  // Long-form change: a different path is a different approach.
  assert.equal(
    shouldRefuseUnchangedRetryV1({
      plan,
      previousArguments: JSON.stringify({
        path: "Research/sources/first-edition-transcript.md",
        section: 2,
      }),
      nextArguments: JSON.stringify({
        path: "Research/sources/critical-edition-appendix.md",
        section: 5,
      }),
    }),
    false,
  );

  // Short-form change: one numeral is the whole correction. The orchestrator's
  // Jaccard predicate drops tokens under three characters and would read this
  // as a repeat, which is exactly why this gate does not use it.
  assert.equal(
    shouldRefuseUnchangedRetryV1({
      plan,
      previousArguments: JSON.stringify({ section: 2 }),
      nextArguments: JSON.stringify({ section: 3 }),
    }),
    false,
  );

  // Whitespace and key order are not an approach change.
  assert.equal(
    shouldRefuseUnchangedRetryV1({
      plan,
      previousArguments: '{"section": 2,  "path": "a.md"}',
      nextArguments: '{"section": 2, "path": "a.md"}',
    }),
    true,
  );
});

test("a refused payload earns the corrective guidance, not the shrug", () => {
  // Drive the real chain: classify the live failure, then build the guidance
  // the model would actually be handed. The reference strings are produced by
  // the same builder from codes whose classes have never been in doubt, so
  // this asserts the product agrees with itself rather than with a copy of
  // its own copy that would keep passing if the wording changed.
  const guidanceFor = (failureClass: MissionFailureClassV1): string => {
    const plan = buildMissionRetryVariationPlanV1({
      node: retriedNode({ allowedTools: ["create_project_idea_brief"] }),
      failureClass,
      failureMessage: "Grounding reference 2 does not match its closed contract.",
    });
    assert.ok(plan, `no plan for ${failureClass}`);
    return plan.guidance;
  };

  const observed = classifyMissionFailureV1({
    toolName: "create_project_idea_brief",
    errorCode: "project_idea_brief_invalid",
    errorMessage: "Grounding reference 2 does not match its closed contract.",
  });
  const argumentGuidance = guidanceFor(
    classifyMissionFailureV1({ errorCode: "invalid_arguments" }),
  );
  const unattributableGuidance = guidanceFor("unknown");

  assert.equal(guidanceFor(observed), argumentGuidance);
  assert.notEqual(guidanceFor(observed), unattributableGuidance);
  // And the refusal it must not be confused with keeps its own guidance.
  assert.notEqual(
    guidanceFor(observed),
    guidanceFor(classifyMissionFailureV1({ errorCode: "authority_grant_invalid" })),
  );

  // A corrected payload is a materially different attempt, so the node must
  // still be allowed to make it — the plan only refuses a byte-identical one.
  const plan = buildMissionRetryVariationPlanV1({
    node: retriedNode({ allowedTools: ["create_project_idea_brief"] }),
    failureClass: observed,
    failureMessage: "Grounding reference 2 does not match its closed contract.",
  });
  assert.equal(plan?.requireDifferentApproach, true);
  assert.equal(
    shouldRefuseUnchangedRetryV1({
      plan,
      previousArguments: JSON.stringify({ ideaId: "idea-1", title: "A" }),
      nextArguments: JSON.stringify({ ideaId: "idea-1", title: "B" }),
    }),
    false,
  );
});

test("the injection key is stable per node and attempt", () => {
  assert.equal(missionRetryVariationKeyV1("tool-03-web_fetch", 2), "tool-03-web_fetch:2");
  assert.notEqual(
    missionRetryVariationKeyV1("tool-03-web_fetch", 2),
    missionRetryVariationKeyV1("tool-03-web_fetch", 3),
  );
});
