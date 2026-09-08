import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createDefaultToolRegistry,
  getCoreToolNameReservations,
} from "../src/tools/createToolRegistry";
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
  hasAffirmativeProjectIdeationIntentV1,
  PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
} from "../src/tools/researchPublicationTool";
import { getRequiredWriteToolNamesForTests } from "../src/AgentRunner";
import { hasProjectIdeationIntent } from "../src/agent/promptIntentClassifiers";
import { projectLifecycleStageForToolV1 } from "../src/agent/missionGraphHost";
import { evidenceFromToolResult } from "../src/agent/missionEvidence";
import { ROUTE_BASE_TOOLS } from "../src/agent/toolSchemaPolicy";
import {
  parseAcceptedResearchNotePackageV1,
  type AcceptedResearchNotePackageV1,
} from "../src/integrations/linear";

const WEB_SHA = `sha256:${"a".repeat(64)}`;

test("project idea schema publishes the same limitation cap the core enforces", () => {
  const parameters = createProjectIdeaBriefTool().parameters as {
    properties?: Record<string, { maxItems?: number; description?: string }>;
  };
  assert.equal(parameters.properties?.limitations?.maxItems, 10);
  assert.match(
    parameters.properties?.limitations?.description ?? "",
    /at most 10/iu,
  );
});

test("native project ideation works independently without claiming evidence", async () => {
  const cache = runtimeCache();
  const output = (await createProjectIdeaBriefTool().execute(
    ideaArgs(),
    context(cache),
  )) as ProjectIdeaBriefToolOutputV1;

  assert.equal(output.brief.evidenceStatus, "unverified");
  assert.deepEqual(output.brief.evidence, []);
  assert.equal(output.brief.createdAt, "2026-08-19T12:00:00.000Z");
  assert.match(output.brief.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(cache.projectIdeaBrief, output.brief);
  assert.equal(cache.projectIdeaAcceptedResearchSeed, undefined);
  assert.deepEqual(output.promotion, { eligible: false, seed: null });
  assert.deepEqual(output.durability, {
    scope: "run_local",
    restartRequiresBriefRecreation: true,
  });
});

test("native project ideation resolves only exact host-observed web, vault, and user proof", async () => {
  const cache = runtimeCache();
  cache.trustedWebFetchResults = new Map([
    [
      "web",
      {
        ok: true,
        toolName: "web_fetch",
        output: {
          normalizedUrl: "https://example.com/research",
          contentHash: WEB_SHA,
          urlHash: "0123456789abcdef",
        },
      },
    ],
  ]);
  cache.toolResults.set("read_current_file:{}", {
    ok: true,
    toolName: "read_current_file",
    output: {
      path: "Projects/Idea.md",
      content: "Verified local observation.",
      truncated: false,
    },
  });
  const output = (await createProjectIdeaBriefTool().execute(
    {
      ...ideaArgs(),
      selectedOptionId: "option-a",
      groundingReferences: [
        { kind: "web", reference: "https://example.com/research#ignored" },
        { kind: "vault", reference: "Projects/Idea.md" },
        { kind: "user", reference: "original_mission" },
      ],
    },
    context(cache),
  )) as ProjectIdeaBriefToolOutputV1;

  assert.equal(output.brief.evidenceStatus, "grounded");
  assert.deepEqual(
    output.brief.evidence.map(({ kind, reference }) => ({ kind, reference })),
    [
      { kind: "vault", reference: "Projects/Idea.md" },
      { kind: "user", reference: "original_mission" },
      { kind: "web", reference: "https://example.com/research" },
    ],
  );
  assert.equal(
    output.brief.evidence.at(-1)?.id,
    `evidence-${"a".repeat(48)}-0123456789abcdef`,
  );
  assert.equal(
    output.brief.evidence.find((item) => item.kind === "vault")?.contentSha256,
    rawUtf8Sha256("Verified local observation."),
  );
  assert.equal(
    output.brief.evidence.find((item) => item.kind === "user")?.contentSha256,
    rawUtf8Sha256("Build concise checkers guidance from this user request."),
  );
  assert.equal(output.promotion.eligible, true);
  assert.equal(
    output.promotion.seed?.projectIdeaFingerprint,
    output.brief.fingerprint,
  );
  assert.deepEqual(cache.projectIdeaAcceptedResearchSeed, output.promotion.seed);
  const attested = evidenceFromToolResult(CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME, {
    ok: true,
    toolName: CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME,
    output,
  });
  assert.equal(
    attested?.id,
    `project_idea:${output.brief.fingerprint}:grounded:selected:promoted`,
  );
});

test("native project ideation rejects provider-authored authority and unresolved proof", async () => {
  const tool = createProjectIdeaBriefTool();
  await assert.rejects(
    () =>
      tool.execute(
        {
          ...ideaArgs(),
          evidenceStatus: "grounded",
          createdAt: "2020-01-01T00:00:00.000Z",
          evidence: [{ contentSha256: WEB_SHA }],
        },
        context(runtimeCache()),
      ),
    /closed native tool contract/iu,
  );
  await assert.rejects(
    () =>
      tool.execute(
        {
          ...ideaArgs(),
          groundingReferences: [
            { kind: "web", reference: "https://missing.example/research" },
          ],
        },
        context(runtimeCache()),
      ),
    /No host-verified web evidence/iu,
  );
});

test("publication binds every shared accepted-research field to the exact cached seed", async () => {
  const cache = runtimeCache();
  cache.trustedWebFetchResults = new Map([
    [
      "web",
      {
        ok: true,
        toolName: "web_fetch",
        output: {
          normalizedUrl: "https://example.com/research",
          contentHash: WEB_SHA,
        },
      },
    ],
  ]);
  await createProjectIdeaBriefTool().execute(
    {
      ...ideaArgs(),
      selectedOptionId: "option-a",
      groundingReferences: [
        { kind: "web", reference: "https://example.com/research" },
      ],
    },
    context(cache),
  );
  const seed = cache.projectIdeaAcceptedResearchSeed!;
  const package_ = acceptedPackage(seed);
  assert.doesNotThrow(() =>
    assertProjectIdeaSeedPublicationBindingV1(package_, cache),
  );
  assert.throws(
    () =>
      assertProjectIdeaSeedPublicationBindingV1(
        { ...package_, proposedWork: ["Drifted provider work."] },
        cache,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("drifted from the exact durable project idea seed"),
  );
});

test("accepted research retains verifiable ideation lineage after cache loss", async () => {
  const cache = runtimeCache();
  cache.trustedWebFetchResults = new Map([[
    "web",
    {
      ok: true,
      toolName: "web_fetch",
      output: {
        normalizedUrl: "https://example.com/research",
        contentHash: WEB_SHA,
      },
    },
  ]]);
  await createProjectIdeaBriefTool().execute({
    ...ideaArgs(),
    selectedOptionId: "option-a",
    groundingReferences: [
      { kind: "web", reference: "https://example.com/research" },
    ],
  }, context(cache));
  const durable = parseAcceptedResearchNotePackageV1(
    acceptedPackage(cache.projectIdeaAcceptedResearchSeed!),
  );

  assert.equal(
    durable.projectIdeaSeed?.projectIdeaFingerprint,
    cache.projectIdeaBrief?.fingerprint,
  );
  assert.doesNotThrow(() =>
    assertProjectIdeaSeedPublicationBindingV1(
      structuredClone(durable),
      undefined,
      "Brainstorm and select a project idea, then publish the accepted research to Linear.",
    ),
  );
  assert.throws(
    () => parseAcceptedResearchNotePackageV1({
      ...durable,
      projectIdeaSeed: {
        ...durable.projectIdeaSeed!,
        constraints: ["A restarted provider changed the constraint."],
      },
    }),
    /fingerprint|source brief/iu,
  );

  const { projectIdeaSeed: _omitted, ...independent } = durable;
  assert.equal(
    parseAcceptedResearchNotePackageV1(independent).projectIdeaSeed,
    undefined,
  );
  assert.throws(
    () => assertProjectIdeaSeedPublicationBindingV1(
      independent,
      undefined,
      "Brainstorm and select a project idea, then publish the accepted research to Linear.",
    ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "research_publication_project_idea_seed_required",
  );
  assert.doesNotThrow(() => assertProjectIdeaSeedPublicationBindingV1(
    independent,
    undefined,
    "Publish this independently researched report to Linear.",
  ));
  assert.equal(
    hasAffirmativeProjectIdeationIntentV1(
      "Do not brainstorm project ideas; publish the existing independent research.",
    ),
    false,
  );
});

test("native ideation is core-owned and ordered before accepted research publication", () => {
  const registry = createDefaultToolRegistry();
  assert.ok(
    registry
      .getDefinitions()
      .some(
        (definition) =>
          definition.function.name === CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME,
      ),
  );
  assert.equal(
    getCoreToolNameReservations().find(
      (reservation) => reservation.name === CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME,
    )?.ownerExtensionId,
    null,
  );
  assert.equal(
    projectLifecycleStageForToolV1(
      CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME,
      registry.getDescriptor!(CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME)!,
    ),
    "accepted_research",
  );
  assert.equal(hasProjectIdeationIntent("Explain a completed project."), false);
  assert.ok(
    ROUTE_BASE_TOOLS.research.includes(CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME),
  );
  const prompt =
    "Brainstorm, evaluate, and select a project idea, then publish the accepted research to Linear, build and test the code, and push it to a private GitHub repository.";
  assert.equal(hasProjectIdeationIntent(prompt), true);
  const required = getRequiredWriteToolNamesForTests(prompt, [
    CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME,
    PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
    "code_workspace_create",
    "code_validate_fast",
    "code_validate_targeted",
    "code_validate_full",
    "code_commit_verified",
  ]);
  assert.equal(required[0], CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME);
  assert.ok(required.indexOf(PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME) > 0);
});

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

function runtimeCache(): AgentRuntimeCache {
  return { toolResults: new Map(), trustedWebFetchResults: new Map() };
}

function context(cache: AgentRuntimeCache): ToolExecutionContext {
  return {
    originalPrompt: "Build concise checkers guidance from this user request.",
    runtimeCache: cache,
    now: () => new Date("2026-08-19T12:00:00.000Z"),
  } as ToolExecutionContext;
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

function rawUtf8Sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

test("explicitly refused project ideation does not claim ideation intent", () => {
  // Strip-then-test, the repo's most-repeated regression family. The negation
  // vocabulary knew only do not|don't|never|skip|without, so these all claimed
  // ideation on a prompt that forbade it -- which then DEMANDS a signed
  // promotion seed the mission never owed, and blocks publish.
  for (const prompt of [
    "no project ideation",
    "avoid project ideation entirely",
    "rather than brainstorming project ideas, just summarize",
    "instead of project ideation, write the note",
    "refrain from brainstorming project ideas",
    "no need for project ideation",
    "do not brainstorm project ideas",
    "don't do project ideation",
    "skip the project ideation step",
    "without any project ideation, publish the research",
  ]) {
    assert.equal(
      hasAffirmativeProjectIdeationIntentV1(prompt),
      false,
      `must not claim ideation: ${prompt}`,
    );
  }
});

test("affirmative ideation requests still route", () => {
  // The other half: stripping negations must not cost a real request. Firing
  // less on a negated prompt is strictly more correct; firing less on an
  // affirmative one would strand the mission.
  for (const prompt of [
    "call create_project_idea_brief exactly once",
    "brainstorm project ideas for the vault",
    "do project ideation and pick the best direction",
    "generate three project concepts and select one",
  ]) {
    assert.equal(
      hasAffirmativeProjectIdeationIntentV1(prompt),
      true,
      `must claim ideation: ${prompt}`,
    );
  }
});

/*
 * ---------------------------------------------------------------------------
 * Published-contract proofs.
 *
 * A 504-run qualification cohort died on this tool: the model called it, the
 * call came back project_idea_brief_invalid, and every rule it broke was a
 * rule the schema never stated. Nothing in this repository validates arguments
 * against the schema, so the schema is advisory -- but it is advisory
 * INSTRUCTION, and together with the one-line description it is the entire
 * body of guidance the model gets. An unpublished rule is therefore a trap,
 * and a published example the validator rejects is worse than no example,
 * because a caller that copies it verbatim spends a retry and still fails.
 *
 * So these tests run every value the schema advertises THROUGH the real
 * validator, and measure the real validator's bounds rather than reading them
 * from a second copy. A guard written against a copy of the rule passes
 * exactly when both copies are wrong together, which is the failure this
 * repository keeps re-buying.
 * ---------------------------------------------------------------------------
 */

type SchemaNode = {
  type?: string | string[];
  description?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  enum?: unknown[];
  examples?: unknown[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
};

const PUBLISHED_SCHEMA = createProjectIdeaBriefTool()
  .parameters as unknown as SchemaNode;

/** Resolve a published node. `options[].id` is one option's id; `""` is the root. */
function published(path: string): SchemaNode {
  if (path === "") return PUBLISHED_SCHEMA;
  let current = PUBLISHED_SCHEMA;
  for (const segment of path.split(".")) {
    const key = segment.endsWith("[]") ? segment.slice(0, -2) : segment;
    const next = current.properties?.[key];
    assert.ok(next, `the schema publishes no property for ${path}`);
    if (segment.endsWith("[]")) {
      assert.ok(next.items, `the schema publishes no items for ${path}`);
      current = next.items;
    } else {
      current = next;
    }
  }
  return current;
}

async function submit(
  args: Record<string, unknown>,
  cache: AgentRuntimeCache = runtimeCache(),
): Promise<{ ok: boolean; message: string }> {
  try {
    await createProjectIdeaBriefTool().execute(args, context(cache));
    return { ok: true, message: "" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function acceptsBrief(
  args: Record<string, unknown>,
  label: string,
  cache?: AgentRuntimeCache,
): Promise<void> {
  const verdict = await submit(args, cache);
  assert.ok(
    verdict.ok,
    `${label} is advertised as valid, but the validator rejected it: ${verdict.message}`,
  );
}

async function rejectsBrief(
  args: Record<string, unknown>,
  label: string,
  cache?: AgentRuntimeCache,
): Promise<string> {
  const verdict = await submit(args, cache);
  assert.equal(
    verdict.ok,
    false,
    `${label} was accepted, so the schema states a rule the validator does not enforce`,
  );
  return verdict.message;
}

function optionsOf(args: Record<string, unknown>): Array<Record<string, unknown>> {
  return args.options as Array<Record<string, unknown>>;
}

function criteriaOf(args: Record<string, unknown>): Array<Record<string, unknown>> {
  return args.acceptanceCriteria as Array<Record<string, unknown>>;
}

function distinctEntries(count: number, label: string): string[] {
  return Array.from({ length: count }, (_, index) => `${label} ${index + 1}`);
}

/** Every free-text seat: where the schema states a length, and where the value goes. */
const TEXT_SEATS: ReadonlyArray<{
  path: string;
  singleLine: boolean;
  apply: (args: Record<string, unknown>, value: string) => void;
}> = [
  {
    path: "title",
    singleLine: true,
    apply: (args, value) => {
      args.title = value;
    },
  },
  {
    path: "problem",
    singleLine: false,
    apply: (args, value) => {
      args.problem = value;
    },
  },
  {
    path: "hypothesis",
    singleLine: false,
    apply: (args, value) => {
      args.hypothesis = value;
    },
  },
  {
    path: "options[].title",
    singleLine: true,
    apply: (args, value) => {
      optionsOf(args)[0].title = value;
    },
  },
  {
    path: "options[].summary",
    singleLine: false,
    apply: (args, value) => {
      optionsOf(args)[0].summary = value;
    },
  },
  {
    path: "acceptanceCriteria[].text",
    singleLine: false,
    apply: (args, value) => {
      criteriaOf(args)[0].text = value;
    },
  },
  {
    path: "proposedWork[]",
    singleLine: false,
    apply: (args, value) => {
      args.proposedWork = [value];
    },
  },
  {
    path: "nonGoals[]",
    singleLine: false,
    apply: (args, value) => {
      args.nonGoals = [value];
    },
  },
  {
    path: "constraints[]",
    singleLine: false,
    apply: (args, value) => {
      args.constraints = [value];
    },
  },
  {
    path: "risks[]",
    singleLine: false,
    apply: (args, value) => {
      args.risks = [value];
    },
  },
  {
    path: "limitations[]",
    singleLine: false,
    apply: (args, value) => {
      args.limitations = [value];
    },
  },
];

/** Every list seat: where the schema states an item count, and how to fill it. */
const LIST_SEATS: ReadonlyArray<{
  path: string;
  apply: (args: Record<string, unknown>, count: number) => void;
}> = [
  {
    path: "proposedWork",
    apply: (args, count) => {
      args.proposedWork = distinctEntries(count, "Proposed work");
    },
  },
  {
    path: "nonGoals",
    apply: (args, count) => {
      args.nonGoals = distinctEntries(count, "Non-goal");
    },
  },
  {
    path: "constraints",
    apply: (args, count) => {
      args.constraints = distinctEntries(count, "Constraint");
    },
  },
  {
    path: "risks",
    apply: (args, count) => {
      args.risks = distinctEntries(count, "Risk");
    },
  },
  {
    path: "limitations",
    apply: (args, count) => {
      args.limitations = distinctEntries(count, "Limitation");
    },
  },
  {
    path: "options",
    apply: (args, count) => {
      args.options = Array.from({ length: count }, (_, index) => ({
        id: `option-${index + 1}`,
        title: `Option ${index + 1}`,
        summary: `Summary ${index + 1}`,
      }));
      args.selectedOptionId = null;
    },
  },
  {
    path: "acceptanceCriteria",
    apply: (args, count) => {
      args.acceptanceCriteria = Array.from({ length: count }, (_, index) => ({
        id: `AC-${index + 1}`,
        text: `Criterion ${index + 1}`,
      }));
    },
  },
];

/**
 * The candidates a model actually produces for an id, plus the boundary cases.
 * "Option A" and "Direction 1" are the two spellings that killed the cohort:
 * both are the obvious thing to write when the schema says only "string".
 */
const LOGICAL_ID_CANDIDATES = [
  "option-a",
  "idea-1",
  "A",
  "9",
  "a.b",
  "a_b",
  "a:b",
  "x".repeat(160),
  "x".repeat(161),
  "",
  "Option A",
  "Direction 1",
  "option a",
  " option-a",
  "option-a ",
  "-leading",
  ".leading",
  "_leading",
  "opt/a",
  "opt#a",
  "opt+a",
  "café",
  "opt\tb",
  "opt\nb",
];

test("the published logical-id pattern accepts exactly what the validator accepts", async () => {
  const pattern = published("ideaId").pattern;
  assert.equal(typeof pattern, "string", "ideaId publishes no id pattern");
  assert.equal(published("options[].id").pattern, pattern);
  assert.equal(published("selectedOptionId").pattern, pattern);
  const advertised = new RegExp(pattern as string, "u");

  for (const candidate of LOGICAL_ID_CANDIDATES) {
    const advertisedVerdict = advertised.test(candidate);
    const printable = JSON.stringify(candidate);

    const asIdeaId = ideaArgs();
    asIdeaId.ideaId = candidate;
    assert.equal(
      (await submit(asIdeaId)).ok,
      advertisedVerdict,
      `ideaId ${printable}: the published pattern and the real validator disagree`,
    );

    // The option id and selectedOptionId carry the same candidate, so the
    // cross-reference rule is satisfied for every candidate the id rule allows
    // and the two seats are exercised together.
    const asOptionId = ideaArgs();
    optionsOf(asOptionId)[0].id = candidate;
    asOptionId.selectedOptionId = candidate;
    assert.equal(
      (await submit(asOptionId)).ok,
      advertisedVerdict,
      `options[].id/selectedOptionId ${printable}: the published pattern and the real validator disagree`,
    );
  }

  // selectedOptionId is the one id that may be absent, and null has to stay
  // legal or an unselected brief becomes impossible to express.
  const unselected = ideaArgs();
  unselected.selectedOptionId = null;
  await acceptsBrief(unselected, "a null selectedOptionId");
});

test("published text lengths are the lengths the real validator measures", async () => {
  for (const seat of TEXT_SEATS) {
    const node = published(seat.path);
    assert.equal(
      typeof node.maxLength,
      "number",
      `${seat.path} publishes no maxLength`,
    );
    assert.equal(node.minLength, 1, `${seat.path} publishes no minLength`);
    const maximum = node.maxLength as number;

    // The length rule is monotone, so probing either side of the published
    // bound pins it exactly: nothing shorter than an accepted value fails.
    const atMaximum = ideaArgs();
    seat.apply(atMaximum, "x".repeat(maximum));
    await acceptsBrief(atMaximum, `${seat.path} at its published maxLength of ${maximum}`);

    const overMaximum = ideaArgs();
    seat.apply(overMaximum, "x".repeat(maximum + 1));
    await rejectsBrief(
      overMaximum,
      `${seat.path} at ${maximum + 1} characters while the schema publishes ${maximum}`,
    );

    const atMinimum = ideaArgs();
    seat.apply(atMinimum, "x");
    await acceptsBrief(atMinimum, `${seat.path} at its published minLength of 1`);

    const empty = ideaArgs();
    seat.apply(empty, "");
    await rejectsBrief(empty, `${seat.path} as an empty string`);
  }
});

test("published item counts are the counts the real validator measures", async () => {
  for (const seat of LIST_SEATS) {
    const node = published(seat.path);
    assert.equal(
      typeof node.maxItems,
      "number",
      `${seat.path} publishes no maxItems`,
    );
    const maximum = node.maxItems as number;
    const minimum = node.minItems ?? 0;

    const atMaximum = ideaArgs();
    seat.apply(atMaximum, maximum);
    await acceptsBrief(atMaximum, `${seat.path} at its published maxItems of ${maximum}`);

    const overMaximum = ideaArgs();
    seat.apply(overMaximum, maximum + 1);
    await rejectsBrief(
      overMaximum,
      `${seat.path} with ${maximum + 1} entries while the schema publishes ${maximum}`,
    );

    const atMinimum = ideaArgs();
    seat.apply(atMinimum, minimum);
    await acceptsBrief(atMinimum, `${seat.path} at its published minItems of ${minimum}`);

    if (minimum > 0) {
      const underMinimum = ideaArgs();
      seat.apply(underMinimum, minimum - 1);
      await rejectsBrief(
        underMinimum,
        `${seat.path} with ${minimum - 1} entries while the schema publishes a minimum of ${minimum}`,
      );
    }
  }
});

/**
 * Where each advertised example is proven. An example the validator rejects is
 * the worst thing this schema can contain, so every `examples` entry has to be
 * fed through the boundary -- and a new one added without a proof fails here
 * rather than in a run.
 */
const EXAMPLE_SEATS: Record<
  string,
  (args: Record<string, unknown>, value: unknown) => void
> = {
  ideaId: (args, value) => {
    args.ideaId = value;
  },
  "options[].id": (args, value) => {
    optionsOf(args)[0].id = value;
    args.selectedOptionId = value;
  },
  selectedOptionId: (args, value) => {
    args.selectedOptionId = value;
  },
  "acceptanceCriteria[].id": (args, value) => {
    criteriaOf(args)[0].id = value;
  },
};

/** Proven in the grounding test below, which has to wire host state first. */
const EXAMPLES_PROVEN_ELSEWHERE = ["groundingReferences[].reference"];

function examplePaths(node: SchemaNode, prefix = ""): string[] {
  const found: string[] = [];
  if (node.examples && prefix) found.push(prefix);
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    found.push(...examplePaths(child, prefix ? `${prefix}.${key}` : key));
  }
  if (node.items) found.push(...examplePaths(node.items, `${prefix}[]`));
  return found;
}

test("every example the schema advertises is accepted by the real validator", async () => {
  assert.deepEqual(
    examplePaths(PUBLISHED_SCHEMA).sort(),
    [...Object.keys(EXAMPLE_SEATS), ...EXAMPLES_PROVEN_ELSEWHERE].sort(),
    "an advertised example has no proof that the validator accepts it",
  );

  for (const [path, apply] of Object.entries(EXAMPLE_SEATS)) {
    const examples = published(path).examples ?? [];
    assert.ok(examples.length > 0, `${path} advertises no example`);
    for (const example of examples) {
      const args = ideaArgs();
      apply(args, example);
      await acceptsBrief(args, `the ${path} example ${JSON.stringify(example)}`);
    }
  }

  for (const value of published("riskClass").enum ?? []) {
    const args = ideaArgs();
    args.riskClass = value;
    await acceptsBrief(args, `the riskClass value ${JSON.stringify(value)}`);
  }
});

test("narrative lists publish uniqueItems, and object lists publish id uniqueness in words", async () => {
  for (const path of ["proposedWork", "nonGoals", "constraints", "risks", "limitations"]) {
    assert.equal(
      published(path).uniqueItems,
      true,
      `${path} does not publish uniqueItems, and the validator rejects duplicates`,
    );
    const args = ideaArgs();
    args[path] = ["One repeated entry.", "One repeated entry."];
    await rejectsBrief(args, `${path} with a duplicated entry`);
  }

  // uniqueItems cannot express the object lists' rule: two options that differ
  // only in title are distinct objects and still a duplicated id, so the rule
  // is published in words on the id and the list.
  assert.match(published("options").description ?? "", /distinct/iu);
  assert.match(published("options[].id").description ?? "", /unique/iu);
  assert.match(published("acceptanceCriteria").description ?? "", /distinct/iu);
  assert.match(published("acceptanceCriteria[].id").description ?? "", /unique/iu);

  const duplicateOptionIds = ideaArgs();
  optionsOf(duplicateOptionIds)[1].id = optionsOf(duplicateOptionIds)[0].id;
  await rejectsBrief(duplicateOptionIds, "two options sharing one id");

  const duplicateCriterionIds = ideaArgs();
  duplicateCriterionIds.acceptanceCriteria = [
    { id: "AC-1", text: "First criterion." },
    { id: "AC-1", text: "Second criterion." },
  ];
  await rejectsBrief(duplicateCriterionIds, "two acceptance criteria sharing one id");
});

test("every free-text field publishes the canonical-form rules the validator enforces", async () => {
  for (const seat of TEXT_SEATS) {
    const description = published(seat.path).description ?? "";
    assert.match(
      description,
      /no leading or trailing whitespace/iu,
      `${seat.path} does not publish the trim-canonical rule the validator enforces`,
    );
    assert.match(
      description,
      /credentials/iu,
      `${seat.path} does not publish the secret-free rule the validator enforces`,
    );

    const padded = ideaArgs();
    seat.apply(padded, " Leading space.");
    await rejectsBrief(padded, `${seat.path} with leading whitespace`);

    const credential = ideaArgs();
    seat.apply(credential, "api_key: sk-live-0123456789");
    await rejectsBrief(credential, `${seat.path} carrying a credential`);

    // The rule the two seats used to answer differently. U+000B cleared the
    // narrative validator and died at the accepted-research note writer, so
    // both the refusal and the sentence that publishes it are checked here.
    assert.match(
      description,
      /control characters/iu,
      `${seat.path} does not publish the control-character rule the validator enforces`,
    );
    const control = ideaArgs();
    seat.apply(control, `Interrupted${String.fromCodePoint(0x0b)}text.`);
    await rejectsBrief(control, `${seat.path} carrying a control character`);

    // Tab is the one control character that stays legal, on every seat,
    // because the note writer downstream accepts it.
    const tabbed = ideaArgs();
    seat.apply(tabbed, `Indented${String.fromCodePoint(0x09)}detail.`);
    await acceptsBrief(tabbed, `${seat.path} carrying a tab`);

    const wrapped = ideaArgs();
    seat.apply(wrapped, "First line\nSecond line");
    if (seat.singleLine) {
      assert.match(
        description,
        /line breaks are rejected/iu,
        `${seat.path} does not publish the single-line rule the validator enforces`,
      );
      await rejectsBrief(wrapped, `${seat.path} with a line break`);
    } else {
      // The multi-line fields really do accept newlines. Publishing a
      // one-line rule on them would cost the caller structure it is allowed,
      // which is the same defect in the opposite direction.
      assert.doesNotMatch(
        description,
        /line breaks are rejected/iu,
        `${seat.path} publishes a single-line rule the validator does not enforce`,
      );
      await acceptsBrief(wrapped, `${seat.path} with a line break`);
    }
  }
});

test("the published limitation minimum is accepted whether or not grounding resolves", async () => {
  assert.equal(published("limitations").minItems, 1);

  const unverified = ideaArgs();
  unverified.limitations = ["One stated limitation."];
  await acceptsBrief(unverified, "one limitation on an unverified brief");

  const grounded = ideaArgs();
  grounded.limitations = ["One stated limitation."];
  grounded.selectedOptionId = "option-a";
  grounded.groundingReferences = [{ kind: "user", reference: "original_mission" }];
  await acceptsBrief(grounded, "one limitation on a grounded brief");

  // Why the published minimum is 1 and not the grounded rule of 0: the caller
  // cannot see which minimum it is held to, because the host decides
  // grounded/unverified after resolving groundingReferences. An empty list is
  // a coin flip, and this is the coin flip that lost a cohort.
  const empty = ideaArgs();
  empty.limitations = [];
  assert.match(
    await rejectsBrief(empty, "an empty limitation list without grounding"),
    /limitation list requires 1-10 entries/iu,
  );
});

test("the grounding shape the schema advertises is the shape the host resolves", async () => {
  const list = published("groundingReferences");
  assert.match(
    list.description ?? "",
    /objects/iu,
    "the grounding description still reads as a bare list of URLs",
  );
  assert.deepEqual(list.items?.required, ["kind", "reference"]);
  assert.deepEqual(published("groundingReferences[].kind").enum, [
    "web",
    "vault",
    "user",
  ]);

  const [webReference, vaultReference, userReference] = (published(
    "groundingReferences[].reference",
  ).examples ?? []) as string[];

  const cache = runtimeCache();
  cache.trustedWebFetchResults = new Map([
    [
      "web",
      {
        ok: true,
        toolName: "web_fetch",
        output: {
          normalizedUrl: webReference,
          contentHash: WEB_SHA,
          urlHash: "0123456789abcdef",
        },
      },
    ],
  ]);
  cache.toolResults.set(`read_file:${vaultReference}`, {
    ok: true,
    toolName: "read_file",
    output: {
      path: vaultReference,
      content: "Verified local observation.",
      truncated: false,
    },
  });

  for (const [kind, reference] of [
    ["web", webReference],
    ["vault", vaultReference],
    ["user", userReference],
  ] as const) {
    const args = ideaArgs();
    args.selectedOptionId = "option-a";
    args.groundingReferences = [{ kind, reference }];
    await acceptsBrief(
      args,
      `the published ${kind} reference example ${JSON.stringify(reference)}`,
      cache,
    );
  }

  // The old description read naturally as "an array of URLs". A caller that
  // believed it sent bare strings and was rejected for breaking a closed
  // contract it had only ever seen an ambiguous summary of.
  const bareStrings = ideaArgs();
  bareStrings.groundingReferences = [webReference];
  await rejectsBrief(
    bareStrings,
    "a bare URL string where the contract requires an object",
    cache,
  );
});

function leafStringNodes(
  node: SchemaNode,
  prefix = "",
): Array<[string, SchemaNode]> {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  const found: Array<[string, SchemaNode]> = [];
  if (prefix && types.includes("string") && !node.properties && !node.items) {
    found.push([prefix, node]);
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    found.push(...leafStringNodes(child, prefix ? `${prefix}.${key}` : key));
  }
  if (node.items) found.push(...leafStringNodes(node.items, `${prefix}[]`));
  return found;
}

test("the schema publishes every property the tool accepts, and no bare strings", async () => {
  const properties = Object.keys(PUBLISHED_SCHEMA.properties ?? {});
  const required = PUBLISHED_SCHEMA.required ?? [];
  assert.deepEqual(
    [...properties].sort(),
    [...required, "groundingReferences"].sort(),
    "the published property set no longer matches the closed tool contract",
  );

  for (const key of required) {
    const missing = ideaArgs();
    delete missing[key];
    await rejectsBrief(missing, `a call omitting the required property ${key}`);
  }
  await acceptsBrief(ideaArgs(), "a call omitting the optional groundingReferences");

  const unpublishedProperty = ideaArgs();
  unpublishedProperty.owner = "someone";
  await rejectsBrief(
    unpublishedProperty,
    "a call carrying a property the schema never published",
  );

  // The anti-bare-string guard. `ideaId`, `options[].id` and
  // `selectedOptionId` were each `{ type: "string" }` and nothing else, which
  // is how a thirty-rule contract came to publish a single pattern. A new leaf
  // that states no rule at all now fails here instead of in a cohort.
  for (const [path, node] of leafStringNodes(PUBLISHED_SCHEMA)) {
    assert.ok(
      (node.description ?? "").length > 0,
      `${path} publishes no description`,
    );
    assert.ok(
      node.pattern !== undefined ||
        node.enum !== undefined ||
        node.maxLength !== undefined ||
        node.minLength !== undefined,
      `${path} publishes a bare string: no pattern, enum or length`,
    );
  }
});

/**
 * Every rule `createProjectIdeaBriefV1` can reject on, and where the caller is
 * told about it. This is the second direction of the proof: the tests above
 * show that everything the schema advertises is accepted, and this one shows
 * that nothing the validator enforces is left unadvertised.
 *
 * The direction cannot be fully derived -- a hand-written validator publishes
 * no machine-readable list of its rules -- so the tripwire is the validator's
 * own rejection text, reduced to its leading clause so that appending an
 * explanation does not churn this table but changing a RULE does. A rule that
 * is added, removed or restated lands here as a failure, and whoever moved it
 * has to say whether a caller can reach it.
 *
 * The second element names one representative schema node that publishes the
 * rule; `null` marks a rule the caller cannot reach at all, because it guards
 * a field the HOST mints -- evidence and its hashes, evidenceStatus, createdAt,
 * the fingerprint, the promotion seed -- which the tool's closed argument
 * contract refuses to accept from the model in the first place.
 */
const VALIDATOR_RULES_V1: ReadonlyArray<
  readonly [rule: string, publishedAt: string | null, note: string]
> = [
  // Caller-reachable rules, each published in the schema above.
  [
    "{} must be a logical id",
    "ideaId",
    "The logical-id rule, published as pattern + description + example on ideaId, options[].id and selectedOptionId. This entry only records that the rule exists; that the published pattern IS the enforced rule is proven by running a candidate corpus through the real validator above.",
  ],
  ["{} must be a string", "title", "type on every published leaf."],
  ["{} must be {}-{} characters", "title", "minLength/maxLength on every free-text field."],
  [
    "{} must not begin or end with whitespace",
    "title",
    "The canonical-text sentence carried by every free-text description.",
  ],
  [
    "{} must not contain a control character",
    "title",
    "Same canonical-text sentence. It used to read 'no NUL characters', which is what the validator enforced on narrative text and is NOT what the accepted-research note writer enforces downstream; both seats now refuse every C0 control and DEL except tab, line feed and carriage return, and the sentence says so.",
  ],
  ["{} must be secret-free text", "title", "Same canonical-text sentence."],
  [
    "{} must be a single line",
    "title",
    "Published only on the two one-line fields, title and options[].title, and deliberately not on the fields that accept newlines.",
  ],
  ["{} must be a JSON object", "options[]", "type:object on every object item."],
  [
    "{} does not match its closed contract",
    "options[]",
    "required plus additionalProperties:false on the root and on every object item.",
  ],
  ["{} list must be an array of {}-{} strings", "proposedWork", "type:array of string items."],
  ["{} list requires {}-{} entries", "proposedWork", "minItems/maxItems on every narrative list."],
  ["{} list entry {} repeats an earlier entry", "proposedWork", "uniqueItems on every narrative list."],
  ["Project idea options must be an array of 1-5 option objects", "options", "type/minItems/maxItems."],
  ["Project idea options require 1-5 entries", "options", "minItems/maxItems."],
  [
    "Project idea option {} repeats the id of an earlier option",
    "options[].id",
    "Published in words, because uniqueItems cannot express uniqueness of one key across objects.",
  ],
  [
    "Selected option id must reference one of the project idea options",
    "selectedOptionId",
    "Published in words: the value is copied character-for-character from one options[].id, or is null.",
  ],
  [
    "Project idea acceptance criteria must be an array of 1-20 criterion objects",
    "acceptanceCriteria",
    "type/minItems/maxItems.",
  ],
  ["Project idea acceptance criteria require 1-20 entries", "acceptanceCriteria", "minItems/maxItems."],
  [
    "Project idea acceptance criterion {} id must match {}",
    "acceptanceCriteria[].id",
    "The shared acceptance-criterion pattern and description, published at 9e9049b.",
  ],
  [
    "Project idea acceptance criterion id {} is duplicated",
    "acceptanceCriteria[].id",
    "Stated in the shared acceptance-criterion description.",
  ],
  ["{} must be exactly one of the fixed catalog", "riskClass", "enum on riskClass and on groundingReferences[].kind."],
  [
    "Project idea evidence must be an array of 0-50 evidence objects",
    "groundingReferences",
    "type:array with maxItems:50 on the only lever the caller has over evidence.",
  ],
  ["Project idea evidence requires 0-50 entries", "groundingReferences", "maxItems:50."],
  [
    "{} must be an absolute HTTP(S) URL such as https://example.com/page",
    "groundingReferences[].reference",
    'Published per kind: for "web", the absolute http(s) URL exactly as fetched.',
  ],
  ["{} must use the http", "groundingReferences[].reference", "Same seat: the http(s) scheme rule."],
  [
    "{} must be an absolute HTTP(S) URL without credentials",
    "groundingReferences[].reference",
    "Same seat; the tool applies the credential-free rule to the requested reference too.",
  ],
  [
    "{} must be a safe vault-relative Markdown path",
    "groundingReferences[].reference",
    'Published per kind: for "vault", the vault-relative path exactly as read, ending in .md.',
  ],

  // Rules on host-minted fields. The tool's closed argument contract rejects
  // evidence, evidenceStatus, createdAt and the fingerprint as provider-
  // authored authority, so no argument the model can write reaches these.
  ["Grounded project ideas require exact evidence", null, "evidenceStatus and evidence are host-minted."],
  ["An unverified project idea must claim no evidence", null, "Same host-minted pair."],
  [
    "Project idea evidence {} repeats the id of an earlier entry",
    null,
    "Evidence ids are minted and de-duplicated by the host from what this run observed.",
  ],
  [
    "{} must be a single-line locator",
    null,
    "The control-character rule for evidence references, which are host-minted: `resolveGroundingReferences` stores the matched HOST candidate's reference, never the string the model requested, and the requested one is separately normalized by `normalizeRequestedReference` (WHATWG URL parsing strips tabs and line breaks outright). The rule exists because `createProjectIdeaBriefV1` is independently callable and briefs are re-parsed from persistence, where `parseHttpUrl` downstream admits no control character at all.",
  ],
  ["{} must be a SHA-256 fingerprint matching {}", null, "Content hashes are computed by the host."],
  ["{} must be a canonical ISO timestamp", null, "createdAt comes from the host clock."],
  [
    "{} must be an ISO-8601 timestamp such as 2026-08-19T12:00:00.000Z",
    null,
    "Same host clock.",
  ],
  ["Unsupported project idea brief contract", null, "version and kind are stamped by the host."],
  [
    "Project idea brief fingerprint does not match its canonical payload",
    null,
    "The fingerprint is minted by the host.",
  ],
  [
    "Project idea fingerprint evidence contains an unsafe number",
    null,
    "Canonical-JSON guards over a payload whose every caller-supplied field is an already-validated string.",
  ],
  ["Project idea fingerprint evidence contains an unsupported value", null, "Same canonical-JSON guard."],

  // Promotion and seed parsing, which run after a brief has already validated.
  [
    "An unverified project idea cannot seed accepted research",
    null,
    "The tool checks grounded-and-selected before it promotes.",
  ],
  [
    "A project idea must select one evaluated option before it can seed accepted research",
    null,
    "Promotion, as above.",
  ],
  ["The selected project idea option is missing", null, "Promotion, as above."],
  ["Only grounded, selected project ideas can produce a promotion seed", null, "Promotion, as above."],
  ["Unsupported project idea accepted research seed contract", null, "Seed parsing, which never sees tool arguments."],
  ["The durable project idea selected direction is missing", null, "Seed parsing, as above."],
  [
    "Project idea accepted research seed does not match its fingerprinted source brief",
    null,
    "Seed parsing, as above.",
  ],
];

/**
 * Read one string or template literal out of the validator source. Template
 * expressions collapse to `{}`, except where the expression is a bare
 * reference to a message constant in the same file, which is substituted --
 * that is what keeps the id rule's own pattern inside its key.
 */
function readSourceLiteral(
  text: string,
  start: number,
  constants: ReadonlyMap<string, string>,
): { value: string; end: number } | null {
  const quote = text[start];
  let index = start + 1;
  let out = "";
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      out += text[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === quote) return { value: out, end: index + 1 };
    if (quote === "`" && char === "$" && text[index + 1] === "{") {
      let depth = 1;
      let cursor = index + 2;
      const from = cursor;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === "{") depth += 1;
        else if (text[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      out += constants.get(text.slice(from, cursor - 1).trim()) ?? "{}";
      index = cursor;
      continue;
    }
    out += char;
    index += 1;
  }
  return null;
}

/** A rule's identity: its leading clause, before any appended explanation. */
function ruleClause(message: string): string {
  const flat = message.replace(/\s+/gu, " ").trim();
  const cut = flat.search(/[:;.]\s/u);
  return (cut === -1 ? flat : flat.slice(0, cut)).replace(/\.$/u, "").trim();
}

test("every rule the validator can reject on is published or provably host-owned", () => {
  const source = readFileSync(
    new URL("../packages/core-api/src/projectIdeaBriefV1.ts", import.meta.url),
    "utf8",
  );

  const constants = new Map<string, string>();
  const constantDeclaration = /^const ([A-Za-z0-9_]+) =\s*(?:\r?\n\s*)?(['"`])/gmu;
  for (const match of source.matchAll(constantDeclaration)) {
    const literal = readSourceLiteral(
      source,
      (match.index ?? 0) + match[0].length - 1,
      new Map(),
    );
    if (literal) constants.set(match[1], literal.value);
  }

  const literalsInHelper = (name: string): string[] => {
    const start = source.indexOf(`function ${name}(`);
    if (start === -1) return [];
    const body = source.slice(start, source.indexOf("\n}", start));
    const found: string[] = [];
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index];
      if (char !== '"' && char !== "'" && char !== "`") continue;
      const literal = readSourceLiteral(body, index, constants);
      if (!literal) break;
      found.push(literal.value);
      index = literal.end - 1;
    }
    return found;
  };

  const observed = new Set<string>();
  let sites = 0;
  let resolved = 0;
  for (const match of source.matchAll(/(?<!function )\bfail\(\s*/gu)) {
    // Prose mentions of `fail(...)` live in this validator's comments, and
    // counting one as an unreadable rejection site would fail the accounting
    // guard below for no reason. A comment is not a rule.
    const lineStart = source.lastIndexOf("\n", match.index ?? 0) + 1;
    const prefix = source.slice(lineStart, match.index);
    if (/^\s*(?:\*|\/\/|\/\*)/u.test(prefix) || prefix.includes("//")) continue;

    sites += 1;
    const start = (match.index ?? 0) + match[0].length;
    const char = source[start];
    if (char === '"' || char === "'" || char === "`") {
      const literal = readSourceLiteral(source, start, constants);
      if (!literal) continue;
      observed.add(ruleClause(literal.value));
      resolved += 1;
      continue;
    }
    // A rejection built by a helper -- `fail(secretShapedFailure(label))` --
    // is still a rule, and reading only the inline literals would drop it
    // silently while reporting a perfectly published contract.
    const helper = /^([A-Za-z0-9_]+)\(/u.exec(source.slice(start));
    const messages = helper ? literalsInHelper(helper[1]) : [];
    if (messages.length === 0) continue;
    for (const message of messages) observed.add(ruleClause(message));
    resolved += 1;
  }

  // Vacuous-input insurance, the failure family this repository logs most: an
  // extractor that stopped matching would otherwise certify a fully published
  // contract over an empty set of rules. Both halves are positive proofs --
  // the inventory is non-trivial, and every rejection site was accounted for.
  assert.ok(
    observed.size >= 40,
    `only ${observed.size} validator rules parsed; the extractor is reading the wrong file or shape`,
  );
  assert.equal(
    resolved,
    sites,
    `${sites - resolved} of ${sites} rejection sites could not be read, so the inventory below is incomplete`,
  );

  assert.deepEqual(
    [...observed].sort(),
    VALIDATOR_RULES_V1.map(([rule]) => rule).sort(),
    "a validator rule was added, removed or restated: publish it in the tool schema, or record here why no caller-supplied argument can reach it",
  );

  for (const [rule, publishedAt] of VALIDATOR_RULES_V1) {
    if (publishedAt === null) continue;
    const node = published(publishedAt);
    assert.ok(
      node.description !== undefined ||
        node.enum !== undefined ||
        node.required !== undefined ||
        node.pattern !== undefined ||
        node.type !== undefined,
      `"${rule}" claims to be published at ${publishedAt}, which states nothing`,
    );
  }
});
