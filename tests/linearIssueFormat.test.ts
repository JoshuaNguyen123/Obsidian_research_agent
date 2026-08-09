import assert from "node:assert/strict";
import test from "node:test";

import {
  createResearchProjectPlanV1,
  parseResearchProjectPlanV1,
} from "../src/agent/projectLifecycle";
import { getModelLinearIssueTemplateStructureProblem } from "../src/agent/promptIntentClassifiers";
import {
  assertLinearIssueBodyV1,
  buildLinearIssueTemplateV1,
  getLinearIssueTitleProblemV1,
  LINEAR_ISSUE_SECTION_HEADINGS_V1,
  LINEAR_ISSUE_SECTIONS_V1,
  normalizeLinearIssueTitleV1,
  renderLinearIssueBodyV1,
} from "../src/integrations/linear/LinearIssueFormatV1";
import { normalizeComparableTicketText } from "../src/integrations/linear/ResearchTicketPublisher";
import { renderHumanCompatibleWorkItemSpec } from "../src/integrations/linear/WorkItemRenderer";
import {
  createWorkItemSpecV1,
  type WorkItemSpecV1Unsigned,
} from "../src/integrations/linear/WorkItemSpecV1";
import { LINEAR_ISSUE_TEMPLATE_V1 } from "../src/tools/agentTemplateLibrary";

const SHA = (character: string) => `sha256:${character.repeat(64)}`;

const WORK_ITEM: WorkItemSpecV1Unsigned = {
  schemaVersion: 1,
  ready: true,
  executionClass: "code",
  objective: "Add a resumable Linear execution queue.",
  repositoryKey: "research-agent",
  acceptanceCriteria: [
    { id: "AC-1", text: "Queue state survives a plugin restart." },
    { id: "AC-2", text: "Expired leases can be recovered without double execution." },
  ],
  validationRequirements: ["npm test", "npm run build"],
  evidenceRefs: ["https://linear.app/acme/issue/ENG-42"],
  riskClass: "medium",
  originRunId: "run-2026-07-11",
  generation: 0,
};

const COMPLETE_FIELDS = {
  problemImpact: "Duplicate execution corrupts an autonomous run.",
  evidence: ["https://example.test/evidence"],
  confidenceLimitations: "Webhook delivery is out of scope.",
  proposedWork: ["Persist a revisioned queue."],
  nonGoals: ["Automatic merging."],
  scope: ["Queue ingestion and state."],
  dependencies: ["A configured Linear workspace."],
  acceptanceCriteria: [{ id: "AC-1", text: "State survives a restart." }],
  validation: ["profile:node-npm"],
};

test("the managed template is generated from the section contract", () => {
  assert.equal(LINEAR_ISSUE_TEMPLATE_V1, buildLinearIssueTemplateV1());
  // The template library never overwrites an existing file, so a byte change
  // here would silently split old and new vaults.
  assert.match(LINEAR_ISSUE_TEMPLATE_V1, /^# \{\{title\}\}\n\n## Problem \/ impact\n/u);
  assert.ok(LINEAR_ISSUE_TEMPLATE_V1.endsWith("## Validation\n\n{{validation}}\n"));

  const templateHeadings = [
    ...LINEAR_ISSUE_TEMPLATE_V1.matchAll(/^## (.+)$/gmu),
  ].map((match) => match[1]);
  assert.deepEqual(templateHeadings, [...LINEAR_ISSUE_SECTION_HEADINGS_V1]);

  for (const section of LINEAR_ISSUE_SECTIONS_V1) {
    assert.ok(
      LINEAR_ISSUE_TEMPLATE_V1.includes(`{{${section.placeholder}}}`),
      `template is missing {{${section.placeholder}}}`,
    );
  }
});

test("a rendered body satisfies the contract it was rendered from", () => {
  const body = renderLinearIssueBodyV1(COMPLETE_FIELDS);
  assert.doesNotThrow(() => assertLinearIssueBodyV1(body, "body"));
  assert.deepEqual(
    [...body.matchAll(/^## (.+)$/gmu)].map((match) => match[1]),
    [...LINEAR_ISSUE_SECTION_HEADINGS_V1],
  );
  assert.match(body, /- \*\*AC-1\*\* - State survives a restart\./u);
  // Linear rewrites task-list checkboxes on round-trip, breaking exact readback.
  assert.doesNotMatch(body, /- \[[ xX]\]/u);
});

test("every section renders, with an explicit empty state for the ones not supplied", () => {
  const body = renderLinearIssueBodyV1({
    problemImpact: "Only the required prose was supplied.",
    acceptanceCriteria: [{ text: "The ticket is actionable." }],
  });
  assert.doesNotThrow(() => assertLinearIssueBodyV1(body, "body"));
  assert.match(body, /## Non-goals\n\n_No non-goals recorded\._/u);
  assert.match(body, /## Validation\n\n_No validation requirements recorded\._/u);
  // A criterion without an id renders as a plain bullet, not "**undefined**".
  assert.match(body, /## Acceptance criteria\n\n- The ticket is actionable\./u);
});

test("the structural validator names what is wrong", () => {
  const body = renderLinearIssueBodyV1(COMPLETE_FIELDS);

  assert.throws(
    () => assertLinearIssueBodyV1(body.replace("## Non-goals", "## Nongoals"), "body"),
    /missing required section: ## Non-goals/u,
  );
  assert.throws(
    () => assertLinearIssueBodyV1(`${body}\n\n## Extra thoughts\n\nMore.`, "body"),
    /unsupported section: ## Extra thoughts/u,
  );
  assert.throws(
    () =>
      assertLinearIssueBodyV1(
        [
          "## Evidence / source links",
          "- a",
          "## Problem / impact",
          "b",
          ...LINEAR_ISSUE_SECTION_HEADINGS_V1.slice(2).map((heading) => `## ${heading}`),
        ].join("\n\n"),
        "body",
      ),
    /out of order/u,
  );
  assert.throws(
    () =>
      assertLinearIssueBodyV1(
        body.replace("- **AC-1**", "- [ ] **AC-1**"),
        "body",
      ),
    /task-list checkboxes/u,
  );
  assert.throws(
    () => assertLinearIssueBodyV1(body.replace("Webhook delivery", "{{confidence}}"), "body"),
    /unresolved template placeholder/u,
  );
});

test("issue titles normalize to a stable dedupe key without rewriting clean titles", () => {
  for (const clean of [
    "CRDT implementation abc123",
    "Fix onboarding for invited users",
    "Add a resumable Linear execution queue",
  ]) {
    assert.equal(normalizeLinearIssueTitleV1(clean), clean);
    assert.equal(getLinearIssueTitleProblemV1(clean), null);
  }

  assert.equal(normalizeLinearIssueTitleV1("  Fix   the   queue.  "), "Fix the queue");
  assert.throws(() => normalizeLinearIssueTitleV1("   "), /empty/u);
  assert.throws(() => normalizeLinearIssueTitleV1("x".repeat(241)), /240 characters/u);
  assert.match(getLinearIssueTitleProblemV1("# Fix onboarding") ?? "", /markdown heading/u);
  assert.match(getLinearIssueTitleProblemV1("Fix\nonboarding") ?? "", /single line/u);
});

test("model-authored issue bodies are held to the template on ticket-shaped missions", () => {
  const call = (description: string) => ({
    name: "linear_create_issue",
    arguments: { teamId: "TEAM", title: "Fix onboarding", description },
  });

  assert.equal(
    getModelLinearIssueTemplateStructureProblem(
      call(renderLinearIssueBodyV1(COMPLETE_FIELDS)),
    ),
    null,
  );
  assert.match(
    getModelLinearIssueTemplateStructureProblem(
      call("Onboarding is broken. Please fix it."),
    ) ?? "",
    /missing required sections: ## Problem \/ impact/u,
  );
  assert.match(
    getModelLinearIssueTemplateStructureProblem({
      name: "linear_create_issue",
      arguments: { teamId: "TEAM", title: "Fix onboarding" },
    }) ?? "",
    /description is required/iu,
  );
  // A different tool is never this function's business.
  assert.equal(
    getModelLinearIssueTemplateStructureProblem({
      name: "linear_update_issue",
      arguments: { id: "issue-1", description: "anything" },
    }),
    null,
  );
});

test("the research publication renderer emits the shared contract", () => {
  const spec = createWorkItemSpecV1(WORK_ITEM);
  const description = renderHumanCompatibleWorkItemSpec(spec, {
    problemImpact: "Duplicate execution could corrupt an autonomous coding run.",
    proposedWork: ["Persist a revisioned queue and expiring leases."],
  });
  assert.doesNotThrow(() => assertLinearIssueBodyV1(description, "published ticket"));
  assert.doesNotMatch(description, /- \[[ xX]\]/u);
  assert.match(description, /## Evidence \/ source links\n\n- https:\/\/linear\.app/u);
});

test("issues published before the plain-bullet switch still deduplicate", () => {
  // Dedupe and readback compare through normalizeComparableTicketText. It
  // folds `- [ ]` to `- `, so an issue created under the old checkbox render
  // still matches its new-render counterpart and is reused, not duplicated.
  const current = renderLinearIssueBodyV1(COMPLETE_FIELDS);
  const legacy = current.replace(/^- \*\*(AC-\d+)\*\*/gmu, "- [ ] **$1**");
  assert.notEqual(legacy, current);
  assert.equal(
    normalizeComparableTicketText(legacy),
    normalizeComparableTicketText(current),
  );
  // A real content change must still fail closed.
  assert.notEqual(
    normalizeComparableTicketText(current.replace("State survives", "State is lost")),
    normalizeComparableTicketText(current),
  );
});

test("readback comparison absorbs the rewrites Linear actually performs", () => {
  // Observed live via the configured-linear-live lane: Linear's markdown
  // serializer returns `- ` bullets as `* ` and autolinks bare URLs as
  // `[url](<url>)`. Byte-exact description readback is therefore impossible,
  // and normalizeComparableTicketText is load-bearing rather than lenient.
  // Do not "simplify" it without re-running that lane.
  const sent = renderLinearIssueBodyV1(COMPLETE_FIELDS);
  const asLinearReturnsIt = sent
    .replace(/^- /gmu, "* ")
    .replace(
      /^\* (https?:\/\/\S+)$/gmu,
      (_match, url: string) => `* [${url}](<${url}>)`,
    );
  assert.notEqual(asLinearReturnsIt, sent);
  assert.equal(
    normalizeComparableTicketText(asLinearReturnsIt),
    normalizeComparableTicketText(sent),
  );
});

test("a hierarchy plan carries the optional sections without disturbing older plans", () => {
  const base = {
    planId: "research-plan-1",
    runId: "run-project-1",
    acceptedResearchArtifactFingerprint: SHA("1"),
    sourceNotePath: "Research/Accepted project.md",
    destination: { workspaceId: "workspace-1", teamId: "team-1" },
    initiative: {
      key: "initiative-product",
      title: "Product initiative",
      description: "Deliver the accepted research outcome.",
    },
    project: {
      key: "project-product",
      title: "Product project",
      description: "Execute the bounded dependency-aware implementation.",
    },
    issues: [
      {
        key: "issue-a",
        title: "Create the foundation",
        description: "Build and verify the trusted foundation.",
        dependencyKeys: [],
        acceptanceCriteria: ["The focused validation is green."],
        workItemFingerprint: SHA("2"),
      },
    ],
    createdAt: "2026-07-16T12:00:00.000Z",
  };

  const withoutSections = createResearchProjectPlanV1(base);
  assert.deepEqual(parseResearchProjectPlanV1(withoutSections), withoutSections);
  assert.equal(withoutSections.issues[0].problemImpact, undefined);

  const withSections = createResearchProjectPlanV1({
    ...base,
    issues: [
      {
        ...base.issues[0],
        problemImpact: "The foundation is missing, so nothing downstream can land.",
        confidenceLimitations: "Sandbox availability is assumed.",
        proposedWork: ["Create the module.", "Cover it with focused tests."],
        nonGoals: ["Refactoring unrelated modules."],
        scope: ["The foundation module only."],
        validation: ["profile:node-npm"],
      },
    ],
  });
  assert.deepEqual(parseResearchProjectPlanV1(withSections), withSections);
  assert.deepEqual(withSections.issues[0].proposedWork, [
    "Create the module.",
    "Cover it with focused tests.",
  ]);
  // Optional prose must not change the plan identity contract's issue binding.
  assert.equal(
    withSections.issues[0].idempotencyKey,
    withoutSections.issues[0].idempotencyKey,
  );
});
