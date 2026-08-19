import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
