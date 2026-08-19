import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  withPreparedActionFingerprint,
  type ActionReceipt,
  type PreparedAction,
} from "../src/agent/actions";
import { createBoundedGrant, type AuthorityGrantV1 } from "../src/agent/authority";
import { createResearchProjectPlanV1 } from "../src/agent/projectLifecycle";
import { portableSha256Text } from "../packages/core-api/src/portableSha256";
import {
  LINEAR_RESEARCH_PROJECT_HIERARCHY_RECEIPT_TOOL_NAME,
  ResearchProjectHierarchyWorkflowV1,
  providerSummary,
  renderHierarchyIssueDescriptionV1,
  type ResearchProjectHierarchyCheckpointV1,
  type ResearchProjectHierarchyCheckpointPortV1,
  type ResearchProjectHierarchyApprovalRequestV1,
} from "../src/integrations/linear/ResearchProjectHierarchyWorkflowV1";
import type {
  HostLinearActionExecution,
  HostLinearActionPreparation,
} from "../src/integrations/linear/HostLinearActionExecutor";
import type { LinearToolClient } from "../src/integrations/linear/LinearTools";
import type { LinearBaseRecord, LinearOperationResult } from "../src/integrations/linear/types";
import {
  canonicalizeHierarchyAcceptanceCriteria,
  canonicalizeHierarchyDependencyKeys,
  canonicalizeHierarchyItemTitle,
  assertAcceptedResearchBindingMatchesBytes,
  assertExecutableDeveloperMissionUsesOneDeliveryIssue,
  assertResearchProjectPlanSemanticallyBoundToAcceptedNote,
  deriveResearchProjectWorkItemFingerprint,
  deriveResearchProjectPlanIdForAcceptedArtifact,
  hasExplicitResearchProjectHierarchyIntent,
  resolveCanonicalAcceptedResearchFingerprint,
  resolveCanonicalAcceptedResearchNotePath,
  sanitizeHierarchyNarrative,
  selectAcceptedResearchBindingForCurrentMission,
  buildGroupedApprovalAction,
} from "../src/tools/researchProjectHierarchyTool";
import type { ToolExecutionContext } from "../src/tools/types";

const NOW = "2026-07-16T15:00:00.000Z";
const HASH = (character: string) => `sha256:${character.repeat(64)}`;
const LINEAR_INTERNAL_METADATA =
  /sha256:[a-f0-9]{64}|<!--\s*agentic-|##\s*Machine contract|\bWork item:\s*sha256:/iu;
const ACCEPTED_NOTE_CONTENT = [
  "# Checkers delivery outcome",
  "The rules engine needs a stable foundation and a separate integration layer.",
  "Independent readback must verify every provider result.",
].join("\n");
const ACCEPTED_NOTE_SHA256 = `sha256:${portableSha256Text(ACCEPTED_NOTE_CONTENT)}`;

test("hierarchy intent does not capture single accepted-research issue publication", () => {
  assert.equal(
    hasExplicitResearchProjectHierarchyIntent(
      "Publish this accepted research package to Linear as an issue.",
    ),
    false,
  );
  assert.equal(
    hasExplicitResearchProjectHierarchyIntent(
      "Turn this accepted research into a Linear initiative, project, and dependency-aware issues.",
    ),
    true,
  );
  assert.equal(
    hasExplicitResearchProjectHierarchyIntent(
      "Investigate conflict-free counters and turn the findings into Linear work.",
    ),
    true,
  );
  assert.equal(
    hasExplicitResearchProjectHierarchyIntent(
      "Investigate conflict-free counters, but do not turn the findings into Linear work.",
    ),
    false,
  );
  assert.equal(
    hasExplicitResearchProjectHierarchyIntent(
      "Research a conflict-free counter and create measurable Linear work.",
    ),
    true,
  );
  assert.equal(
    hasExplicitResearchProjectHierarchyIntent(
      "Research a conflict-free counter, but do not create Linear work.",
    ),
    false,
  );
});

test("joined developer mission uses one truthfully attributable Linear delivery issue", () => {
  const mission = [
    "Research conflict-free counters and turn the findings into Linear work.",
    "Implement the library, test it, publish a private draft PR on GitHub, and write the final reflection.",
  ].join(" ");
  assert.doesNotThrow(() =>
    assertExecutableDeveloperMissionUsesOneDeliveryIssue(mission, 1),
  );
  assert.throws(
    () => assertExecutableDeveloperMissionUsesOneDeliveryIssue(mission, 2),
    /exactly one Linear delivery issue/u,
  );
  assert.doesNotThrow(() =>
    assertExecutableDeveloperMissionUsesOneDeliveryIssue(
      "Turn this accepted research into a Linear initiative, project, and three issues. Do not implement code.",
      3,
    ),
  );
});

test("hierarchy plan identity is host-derived from the accepted artifact", () => {
  assert.equal(
    deriveResearchProjectPlanIdForAcceptedArtifact(HASH("a")),
    `research-plan-${"a".repeat(32)}`,
  );
});

test("hierarchy work-item identity is host-derived from accepted research and canonical issue content", () => {
  const input = {
    acceptedResearchArtifactFingerprint: HASH("a"),
    key: "checkers-game",
    title: "Build checkers",
    description: "Implement the accepted rules as a Python game.",
    dependencyKeys: [],
    acceptanceCriteria: ["The targeted tests pass."],
  };
  const first = deriveResearchProjectWorkItemFingerprint(input);
  assert.match(first, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(deriveResearchProjectWorkItemFingerprint(input), first);
  assert.notEqual(
    deriveResearchProjectWorkItemFingerprint({
      ...input,
      acceptanceCriteria: ["The targeted tests and CLI smoke test pass."],
    }),
    first,
  );
});

test("hierarchy uses the durable accepted artifact and rejects a conflicting valid fingerprint", () => {
  assert.equal(
    resolveCanonicalAcceptedResearchFingerprint(null, HASH("a")),
    HASH("a"),
  );
  assert.throws(
    () => resolveCanonicalAcceptedResearchFingerprint(HASH("b"), HASH("a")),
    /conflicts with the durable note binding/u,
  );
});

test("hierarchy uses the durable note path and rejects a conflicting supplied path", () => {
  assert.equal(
    resolveCanonicalAcceptedResearchNotePath(null, "Projects/Checkers/Research.md"),
    "Projects/Checkers/Research.md",
  );
  assert.throws(
    () => resolveCanonicalAcceptedResearchNotePath(
      "Projects/Other.md",
      "Projects/Checkers/Research.md",
    ),
    /conflicts with the durable accepted-research binding/u,
  );
});

test("hierarchy resolves host lineage before checking a model path assertion", () => {
  const source = readFileSync(
    new URL("../src/tools/researchProjectHierarchyTool.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /resolveAcceptedResearchBinding\(\{[\s\S]*?runId,[\s\S]*?notePath: null,[\s\S]*?\}\)/u,
  );
  assert.match(
    source,
    /resolveCanonicalAcceptedResearchNotePath\([\s\S]*?planInput\.suppliedSourceNotePath/u,
  );
});

test("hierarchy selects root-run lineage or one note named by the canonical graph objective", () => {
  const candidates = [
    {
      runId: "run-root",
      artifactFingerprint: HASH("a"),
      notePath: "Projects/Checkers/Research.md",
      noteSha256: ACCEPTED_NOTE_SHA256,
      noteContent: ACCEPTED_NOTE_CONTENT,
    },
    {
      runId: "run-other",
      artifactFingerprint: HASH("b"),
      notePath: "Projects/Chess/Research.md",
      noteSha256: ACCEPTED_NOTE_SHA256,
      noteContent: ACCEPTED_NOTE_CONTENT,
    },
  ];
  assert.deepEqual(
    selectAcceptedResearchBindingForCurrentMission(candidates, {
      acceptedRunIds: new Set(["run-root"]),
      missionObjective: "Continue a child segment.",
    }),
    {
      artifactFingerprint: HASH("a"),
      notePath: "Projects/Checkers/Research.md",
      noteSha256: ACCEPTED_NOTE_SHA256,
      noteContent: ACCEPTED_NOTE_CONTENT,
    },
  );
  assert.deepEqual(
    selectAcceptedResearchBindingForCurrentMission(candidates, {
      acceptedRunIds: new Set(["run-child"]),
      missionObjective:
        "Write accepted research to Projects/Checkers/Research.md, then publish it.",
    }),
    {
      artifactFingerprint: HASH("a"),
      notePath: "Projects/Checkers/Research.md",
      noteSha256: ACCEPTED_NOTE_SHA256,
      noteContent: ACCEPTED_NOTE_CONTENT,
    },
  );
  assert.equal(
    selectAcceptedResearchBindingForCurrentMission(candidates, {
      acceptedRunIds: new Set(["run-child"]),
      missionObjective: "Publish accepted research without naming its note.",
    }),
    null,
  );
});

test("hierarchy verifies exact accepted-note bytes before semantic validation", () => {
  assert.doesNotThrow(() =>
    assertAcceptedResearchBindingMatchesBytes({
      artifactFingerprint: HASH("a"),
      notePath: "Projects/Checkers/Research.md",
      noteSha256: ACCEPTED_NOTE_SHA256,
      noteContent: ACCEPTED_NOTE_CONTENT,
    }),
  );
  assert.throws(
    () =>
      assertAcceptedResearchBindingMatchesBytes({
        artifactFingerprint: HASH("a"),
        notePath: "Projects/Checkers/Research.md",
        noteSha256: ACCEPTED_NOTE_SHA256,
        noteContent: `${ACCEPTED_NOTE_CONTENT}\nDrifted after acceptance.`,
      }),
    /changed after host acceptance/u,
  );
});

test("hierarchy content must retain accepted-research semantic anchors", () => {
  assert.doesNotThrow(() =>
    assertResearchProjectPlanSemanticallyBoundToAcceptedNote(
      planFixture(),
      ACCEPTED_NOTE_CONTENT,
    ),
  );
  const unrelated = planFixture();
  unrelated.initiative.title = "Vacation planning";
  unrelated.initiative.description = "Schedule a tropical holiday.";
  unrelated.project.title = "Travel reservations";
  unrelated.project.description = "Reserve flights and lodging.";
  for (const issue of unrelated.issues) {
    issue.title = "Book a vacation item";
    issue.description = "Compare prices and reserve travel.";
    issue.acceptanceCriteria = ["A reservation confirmation exists."];
  }
  assert.throws(
    () =>
      assertResearchProjectPlanSemanticallyBoundToAcceptedNote(
        unrelated,
        ACCEPTED_NOTE_CONTENT,
      ),
    /does not retain a distinctive anchor/u,
  );
});

test("hierarchy canonicalizes only bounded equivalent issue-list shorthand", () => {
  assert.deepEqual(canonicalizeHierarchyDependencyKeys(null), []);
  assert.deepEqual(canonicalizeHierarchyDependencyKeys("issue-a"), ["issue-a"]);
  assert.deepEqual(
    canonicalizeHierarchyAcceptanceCriteria("The CLI tests pass."),
    ["The CLI tests pass."],
  );
  assert.deepEqual(
    canonicalizeHierarchyAcceptanceCriteria({ id: "AC-1", text: "The board renders." }),
    ["The board renders."],
  );
  assert.throws(
    () => canonicalizeHierarchyAcceptanceCriteria({ text: "Valid", command: "hidden" }),
    /may contain only id and text/u,
  );
  assert.throws(
    () => canonicalizeHierarchyDependencyKeys({ key: "issue-a" }),
    /must be an array or one logical issue key/u,
  );
});

test("hierarchy canonicalizes only a non-conflicting Linear name alias to title", () => {
  assert.equal(
    canonicalizeHierarchyItemTitle(
      { name: "Checkers implementation" },
      "project",
    ),
    "Checkers implementation",
  );
  assert.equal(
    canonicalizeHierarchyItemTitle(
      { title: "Checkers implementation", name: "Checkers implementation" },
      "project",
    ),
    "Checkers implementation",
  );
  assert.throws(
    () =>
      canonicalizeHierarchyItemTitle(
        { title: "Checkers", name: "Chess" },
        "project",
      ),
    /conflicts with its compatible name alias/u,
  );
  assert.throws(
    () => canonicalizeHierarchyItemTitle({ name: "" }, "project"),
    /project title must contain/u,
  );
});

test("hierarchy keeps provider summaries bounded and preserves full markdown in content", () => {
  const source = `Long initiative context ${"detail ".repeat(60)}`.trim();
  const summary = providerSummary(source);
  assert.equal(summary.length, 240);
  assert.match(summary, /\.\.\.$/u);
  assert.equal(summary.includes("\n"), false);
  assert.equal(providerSummary("  Short\ncontext  "), "Short context");
});

test("hierarchy prose redacts raw host paths but retains inert implementation references", () => {
  assert.equal(
    sanitizeHierarchyNarrative(
      "Use C:\\Users\\person\\private repo, then document python -m unittest in Projects/Checkers/Research.md.",
    ),
    "Use [host-bound local path], then document python -m unittest in Projects/Checkers/Research.md.",
  );
  assert.equal(
    sanitizeHierarchyNarrative(
      "Implement checkers/game.py and validate with python -m unittest.",
    ),
    "Implement checkers/game.py and validate with python -m unittest.",
  );
});

test("hierarchy rejects a mismatched outer tool identity before preparation", async () => {
  const fixture = await hierarchyFixture();
  const request = fixture.request();
  request.context = { ...request.context, operationId: "different-outer-call" };
  const result = await fixture.workflow.execute(request);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "linear_hierarchy_identity_mismatch");
  assert.equal(fixture.mutations.length, 0);
});

test("Linear hierarchy checkpoints every prepared action before one grouped approval and independently reads back every resource", async () => {
  const fixture = await hierarchyFixture();
  const result = await fixture.workflow.execute(fixture.request());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(fixture.approvals, 1);
  assert.equal(fixture.firstMutationSawPreparedCheckpoint, true);
  assert.equal(result.issueIds.length, 2);
  assert.equal(result.checkpoint.items.length, 6);
  assert.equal(result.checkpoint.items.every((item) => item.readbackFingerprint), true);
  assert.equal(fixture.mutations.length, 6);
  assert.equal(new Set(fixture.mutations).size, 6);
  const initiativeInput = fixture.preparedArguments.find(
    (item) => item.toolName === "linear_create_initiative",
  )?.arguments.input as Record<string, unknown>;
  const projectInput = fixture.preparedArguments.find(
    (item) => item.toolName === "linear_create_project",
  )?.arguments.input as Record<string, unknown>;
  assert.equal(initiativeInput.description, providerSummary(fixture.plan.initiative.description));
  assert.equal(initiativeInput.content, fixture.plan.initiative.description);
  assert.equal(projectInput.description, providerSummary(fixture.plan.project.description));
  assert.equal(projectInput.content, fixture.plan.project.description);
  assert.doesNotMatch(
    JSON.stringify(fixture.preparedArguments.map((item) => item.arguments)),
    LINEAR_INTERNAL_METADATA,
  );
  assert.equal(
    result.receipt.toolName,
    LINEAR_RESEARCH_PROJECT_HIERARCHY_RECEIPT_TOOL_NAME,
  );
  assert.equal(result.receipt.readback.status, "verified");
});

test("partial hierarchy resume reuses verified items and never redispatches them", async () => {
  const fixture = await hierarchyFixture({ failOnceAtMutation: 3 });
  const first = await fixture.workflow.execute(fixture.request());
  assert.equal(first.ok, false);
  assert.equal(first.status, "not_applied");
  const committedBeforeResume = fixture.mutations.length;
  assert.equal(committedBeforeResume, 2);

  const resumed = await fixture.workflow.execute(fixture.request());
  assert.equal(resumed.ok, true);
  assert.equal(fixture.approvals, 1, "persisted grouped grant should avoid a second approval");
  assert.equal(fixture.mutations.length, 6);
  assert.equal(new Set(fixture.mutations).size, 6, "committed actions must not replay");
});

test("hierarchy resume rejects a re-fingerprinted child payload that is not in the persisted grouped approval", async () => {
  const fixture = await hierarchyFixture({ failOnceAtMutation: 1 });
  const first = await fixture.workflow.execute(fixture.request());
  assert.equal(first.ok, false);
  assert.equal(fixture.approvals, 1);
  assert.equal(fixture.mutations.length, 0);

  const checkpoint = fixture.checkpointStore.current!;
  const itemIndex = checkpoint.items.findIndex((item) => item.action !== null);
  assert.notEqual(itemIndex, -1);
  const item = checkpoint.items[itemIndex]!;
  const originalAction = item.action!;
  const normalizedArgs = structuredClone(originalAction.normalizedArgs);
  const input = normalizedArgs.input as Record<string, unknown>;
  input.name = "Unapproved replacement initiative";
  const { payloadFingerprint: _oldActionFingerprint, ...unsignedAction } =
    originalAction;
  const tamperedAction = await withPreparedActionFingerprint({
    ...unsignedAction,
    normalizedArgs,
    preview: {
      ...unsignedAction.preview,
      summary: "Create an unapproved replacement initiative",
      outboundPayload: structuredClone(normalizedArgs),
    },
  });
  assert.notEqual(
    tamperedAction.payloadFingerprint,
    originalAction.payloadFingerprint,
  );
  checkpoint.items[itemIndex] = { ...item, action: tamperedAction };
  const originalGroupedApprovalFingerprint = checkpoint.approvalFingerprint;

  const resumed = await fixture.workflow.execute(fixture.request());

  assert.equal(resumed.ok, false);
  if (resumed.ok) return;
  assert.equal(resumed.status, "reconcile_required");
  assert.equal(resumed.error.code, "linear_hierarchy_checkpoint_invalid");
  assert.match(resumed.error.message, /exact grouped approval fingerprint/iu);
  assert.equal(
    checkpoint.approvalFingerprint,
    originalGroupedApprovalFingerprint,
    "the tamper retained the old grouped approval and grant",
  );
  assert.equal(fixture.approvals, 1);
  assert.equal(fixture.mutations.length, 0);
});

test("partial hierarchy resume blocks provider drift before the next child mutation", async () => {
  const fixture = await hierarchyFixture({ failOnceAtMutation: 3 });
  const first = await fixture.workflow.execute(fixture.request());
  assert.equal(first.ok, false);
  assert.equal(fixture.mutations.length, 2);
  const committed = fixture.checkpointStore.current?.items.find(
    (item) => item.status === "committed",
  );
  assert.ok(committed);
  fixture.driftRecord(committed.resourceId, { snapshotHash: HASH("9") });

  const resumed = await fixture.workflow.execute(fixture.request());
  assert.equal(resumed.ok, false);
  if (resumed.ok) return;
  assert.equal(resumed.status, "reconcile_required");
  assert.equal(resumed.error.code, "linear_hierarchy_resume_drift");
  assert.equal(
    fixture.mutations.length,
    2,
    "provider drift must be detected before dispatching another child",
  );
});

test("hierarchy rechecks deduplicated dependencies after approval before mutation", async () => {
  const plan = planFixture();
  const fixture = await hierarchyFixture({
    plan,
    driftFirstDeduplicatedOnApproval: true,
    seed: [{
      id: "initiative-existing",
      resourceType: "initiative",
      name: plan.initiative.title,
      content: plan.initiative.description,
      snapshotHash: HASH("1"),
    }],
  });
  const result = await fixture.workflow.execute(fixture.request());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, "reconcile_required");
  assert.equal(result.error.code, "linear_hierarchy_resume_drift");
  assert.equal(fixture.approvals, 1);
  assert.equal(fixture.mutations.length, 0);
});

test("completed hierarchy resume fails closed when approved provider fields drift", async () => {
  const fixture = await hierarchyFixture();
  const completed = await fixture.workflow.execute(fixture.request());
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  const project = completed.checkpoint.items.find((item) => item.kind === "project")!;
  fixture.driftRecord(project.resourceId, {
    content: "Provider content changed after approval.",
    snapshotHash: HASH("9"),
  });

  const resumed = await fixture.workflow.execute(fixture.request());
  assert.equal(resumed.ok, false);
  if (resumed.ok) return;
  assert.equal(resumed.status, "reconcile_required");
  assert.equal(resumed.error.code, "linear_hierarchy_resume_drift");
  assert.match(resumed.error.message, /changed after its approved provider snapshot/u);
  assert.equal(fixture.mutations.length, 6, "drift detection must not replay mutations");
});

test("completed hierarchy resume fails closed when an approved relationship drifts", async () => {
  const fixture = await hierarchyFixture();
  const completed = await fixture.workflow.execute(fixture.request());
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  const relation = completed.checkpoint.items.find(
    (item) => item.kind === "issue_relation",
  )!;
  fixture.driftRecord(relation.resourceId, {
    attributes: { issue: "different-issue", relatedIssue: "different-target" },
    snapshotHash: HASH("8"),
  });

  const resumed = await fixture.workflow.execute(fixture.request());
  assert.equal(resumed.ok, false);
  if (resumed.ok) return;
  assert.equal(resumed.status, "reconcile_required");
  assert.equal(resumed.error.code, "linear_hierarchy_resume_drift");
  assert.match(resumed.error.message, /changed after its approved provider snapshot/u);
  assert.equal(fixture.mutations.length, 6);
});

test("receipt-ledger failure resumes from the committed provider checkpoint without replay", async () => {
  const fixture = await hierarchyFixture({ failOnceAtExternalReceipt: 1 });

  await assert.rejects(
    fixture.workflow.execute(fixture.request()),
    /fixture receipt ledger unavailable/u,
  );
  assert.equal(fixture.mutations.length, 1);
  assert.equal(fixture.checkpointStore.current?.items[0]?.status, "committed");
  assert.ok(fixture.checkpointStore.current?.items[0]?.receipt);

  const resumed = await fixture.workflow.execute(fixture.request());
  assert.equal(resumed.ok, true);
  assert.equal(fixture.mutations.length, 6);
  assert.equal(new Set(fixture.mutations).size, 6, "checkpointed provider actions must not replay");
  assert.equal(
    fixture.externalReceipts.has(fixture.checkpointStore.current!.items[0]!.receipt!.id),
    true,
    "resume must restore the child receipt that failed to reach the external ledger",
  );
  assert.equal(fixture.externalReceipts.has(resumed.ok ? resumed.receipt.id : ""), true);
});

test("hierarchy deduplicates exact clean human content before preparing mutations", async () => {
  const plan = planFixture();
  const existing: LinearBaseRecord = {
    id: "initiative-existing",
    resourceType: "initiative",
    name: plan.initiative.title,
    content: plan.initiative.description,
    snapshotHash: HASH("e"),
  };
  const fixture = await hierarchyFixture({ plan, seed: [existing] });
  const result = await fixture.workflow.execute(fixture.request());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const initiative = result.checkpoint.items.find((item) => item.kind === "initiative");
  assert.equal(initiative?.status, "deduplicated");
  assert.equal(initiative?.resourceId, "initiative-existing");
  assert.equal(
    fixture.lastApprovalDeduplicatedResources[0]?.snapshot.name,
    plan.initiative.title,
  );
  assert.equal(
    fixture.lastApprovalDeduplicatedResources[0]?.snapshot.description,
    plan.initiative.description,
  );
  assert.equal(fixture.mutations.length, 5);
});
test("hierarchy rejects ambiguous exact clean duplicates before any mutation", async () => {
  const plan = planFixture();
  const duplicate = (id: string): LinearBaseRecord => ({
    id,
    resourceType: "initiative",
    name: plan.initiative.title,
    content: plan.initiative.description,
    snapshotHash: HASH(id === "initiative-one" ? "1" : "2"),
  });
  const fixture = await hierarchyFixture({
    plan,
    seed: [duplicate("initiative-one"), duplicate("initiative-two")],
  });
  const result = await fixture.workflow.execute(fixture.request());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "linear_hierarchy_dedupe_failed");
  assert.match(result.error.message, /matches multiple resources/i);
  assert.equal(fixture.mutations.length, 0);
});


test("hierarchy deduplicates an existing initiative-project relation after parent recovery", async () => {
  const plan = planFixture();
  const initiative: LinearBaseRecord = {
    id: "initiative-existing",
    resourceType: "initiative",
    name: plan.initiative.title,
    content: plan.initiative.description,
    snapshotHash: HASH("e"),
  };
  const project: LinearBaseRecord = {
    id: "project-existing",
    resourceType: "project",
    name: plan.project.title,
    content: plan.project.description,
    attributes: { teams: [plan.destination.teamId] },
    snapshotHash: HASH("f"),
  };
  const link: LinearBaseRecord = {
    id: "initiative-project-link-existing",
    resourceType: "initiative_project_link",
    attributes: { initiative: initiative.id, project: project.id },
    snapshotHash: HASH("d"),
  };
  const fixture = await hierarchyFixture({ plan, seed: [initiative, project, link] });

  const result = await fixture.workflow.execute(fixture.request());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const relation = result.checkpoint.items.find(
    (item) => item.kind === "initiative_project_link",
  );
  assert.equal(relation?.status, "deduplicated");
  assert.equal(relation?.resourceId, link.id);
  assert.equal(
    fixture.mutations.length,
    3,
    "only the two issue creates and their dependency relation remain",
  );
});

test("hierarchy deduplicates an existing dependency relation after issue recovery", async () => {
  const plan = planFixture();
  const foundation = plan.issues[0]!;
  const integration = plan.issues[1]!;
  const records: LinearBaseRecord[] = [
    {
      id: "initiative-existing",
      resourceType: "initiative",
      name: plan.initiative.title,
      content: plan.initiative.description,
      snapshotHash: HASH("1"),
    },
    {
      id: "project-existing",
      resourceType: "project",
      name: plan.project.title,
      content: plan.project.description,
      attributes: { teams: [plan.destination.teamId] },
      snapshotHash: HASH("2"),
    },
    {
      id: "foundation-existing",
      resourceType: "issue",
      title: foundation.title,
      description: renderHierarchyIssueDescriptionV1(foundation, plan),
      attributes: { teamId: plan.destination.teamId, projectId: "project-existing" },
      snapshotHash: HASH("3"),
    },
    {
      id: "integration-existing",
      resourceType: "issue",
      title: integration.title,
      description: renderHierarchyIssueDescriptionV1(integration, plan),
      attributes: { teamId: plan.destination.teamId, projectId: "project-existing" },
      snapshotHash: HASH("4"),
    },
    {
      id: "link-existing",
      resourceType: "initiative_project_link",
      attributes: { initiative: "initiative-existing", project: "project-existing" },
      snapshotHash: HASH("5"),
    },
    {
      id: "relation-existing",
      resourceType: "issue_relation",
      type: "blocks",
      attributes: { issue: "foundation-existing", relatedIssue: "integration-existing" },
      snapshotHash: HASH("6"),
    },
  ];
  const fixture = await hierarchyFixture({ plan, seed: records });

  const result = await fixture.workflow.execute(fixture.request());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.checkpoint.items.every((item) => item.status === "deduplicated"), true);
  assert.equal(fixture.mutations.length, 0);
});

test("hierarchy does not reuse a title-only project outside the approved team", async () => {
  const plan = planFixture();
  const fixture = await hierarchyFixture({
    plan,
    seed: [{
      id: "same-title-wrong-team",
      resourceType: "project",
      name: plan.project.title,
      content: "Different provider content.",
      attributes: { teams: ["team-other"] },
      snapshotHash: HASH("7"),
    }],
  });
  const result = await fixture.workflow.execute(fixture.request());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const project = result.checkpoint.items.find((item) => item.kind === "project");
  assert.equal(project?.status, "committed");
  assert.notEqual(project?.resourceId, "same-title-wrong-team");
});

test("hierarchy rejects ambiguous title-associated projects on the approved team", async () => {
  const plan = planFixture();
  const project = (id: string): LinearBaseRecord => ({
    id,
    resourceType: "project",
    name: plan.project.title,
    content: `Different content for ${id}.`,
    attributes: { teams: [plan.destination.teamId] },
    snapshotHash: HASH(id.endsWith("1") ? "1" : "2"),
  });
  const fixture = await hierarchyFixture({
    plan,
    seed: [project("project-1"), project("project-2")],
  });
  const result = await fixture.workflow.execute(fixture.request());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "linear_hierarchy_dedupe_failed");
  assert.match(result.error.message, /matches multiple resources/iu);
  assert.equal(fixture.mutations.length, 0);
});

test("hierarchy issue dedupe requires the approved team and exact selected project", async () => {
  const plan = planFixture();
  const issue = plan.issues[0]!;
  const fixture = await hierarchyFixture({
    plan,
    seed: [
      {
        id: "project-existing",
        resourceType: "project",
        name: plan.project.title,
        content: plan.project.description,
        attributes: { teams: [plan.destination.teamId] },
        snapshotHash: HASH("2"),
      },
      {
        id: "issue-wrong-project",
        resourceType: "issue",
        title: issue.title,
        description: renderHierarchyIssueDescriptionV1(issue, plan),
        attributes: {
          teamId: plan.destination.teamId,
          projectId: "project-other",
        },
        snapshotHash: HASH("3"),
      },
    ],
  });
  const result = await fixture.workflow.execute(fixture.request());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const foundation = result.checkpoint.items.find(
    (item) => item.key === `issue:${issue.key}`,
  );
  assert.equal(foundation?.status, "committed");
  assert.notEqual(foundation?.resourceId, "issue-wrong-project");
});

test("hierarchy fails closed when bounded duplicate search is truncated", async () => {
  const fixture = await hierarchyFixture({ truncateListOperation: "projects.list" });
  const result = await fixture.workflow.execute(fixture.request());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "linear_hierarchy_dedupe_failed");
  assert.match(result.error.message, /absence cannot be verified safely/iu);
  assert.equal(fixture.mutations.length, 0);
  assert.equal(fixture.approvals, 0);
});

test("grouped approval preview exposes exact inspectable child payloads", async () => {
  const child = await withPreparedActionFingerprint({
    version: 1,
    id: "child-project",
    runId: "run-hierarchy-1",
    toolCallId: "child-call",
    toolName: "linear_create_project",
    target: { system: "linear", resourceType: "project", id: "project-pending" },
    relatedResources: [],
    normalizedArgs: {
      input: {
        name: "Inspectable project",
        description: "The exact approved child description.",
      },
    },
    preview: {
      summary: "Create project Inspectable project",
      destination: "workspace-1/team-1",
      outboundPayload: {
        input: {
          name: "Inspectable project",
          description: "The exact approved child description.",
        },
      },
      warnings: [],
      outboundBytes: 100,
    },
    idempotencyKey: "project:inspectable",
    reconciliationKey: "project:inspectable",
    preparedAt: NOW,
    expiresAt: "2026-07-16T16:00:00.000Z",
    requiredConfirmations: 1,
  });
  const grouped = await buildGroupedApprovalAction({
    kind: "linear_research_project_hierarchy",
    runId: "run-hierarchy-1",
    toolCallId: "hierarchy-call-1",
    planFingerprint: HASH("a"),
    approvalFingerprint: HASH("b"),
    workspaceId: "workspace-1",
    teamId: "team-1",
    preparedActions: [child],
    deduplicatedResources: [{
      key: "project:existing",
      kind: "project",
      resourceId: "project-existing",
      readbackFingerprint: HASH("c"),
      snapshot: {
        resourceType: "project",
        name: "Existing approved project",
        title: null,
        description: "Exact provider description.",
        relationType: null,
        teamIds: ["team-1"],
        projectIds: [],
        relationEndpoints: {},
      },
    }],
  }, () => new Date(NOW));
  const payload = grouped.preview.outboundPayload as {
    preparedActions?: Array<{ preview?: { outboundPayload?: unknown } }>;
  };
  assert.deepEqual(payload.preparedActions?.[0]?.preview?.outboundPayload, {
    input: {
      name: "Inspectable project",
      description: "The exact approved child description.",
    },
  });
  const exactPayload = grouped.preview.outboundPayload as {
    deduplicatedResources?: Array<{ snapshot?: unknown }>;
  };
  assert.deepEqual(exactPayload.deduplicatedResources?.[0]?.snapshot, {
    resourceType: "project",
    name: "Existing approved project",
    title: null,
    description: "Exact provider description.",
    relationType: null,
    teamIds: ["team-1"],
    projectIds: [],
    relationEndpoints: {},
  });
});

async function hierarchyFixture(options: {
  failOnceAtMutation?: number;
  failOnceAtExternalReceipt?: number;
  plan?: ReturnType<typeof planFixture>;
  seed?: LinearBaseRecord[];
  truncateListOperation?: string;
  driftFirstDeduplicatedOnApproval?: boolean;
} = {}) {
  const plan = options.plan ?? planFixture();
  const records = new Map((options.seed ?? []).map((record) => [record.id, record]));
  const checkpointStore = new MemoryCheckpointStore();
  const mutations: string[] = [];
  const preparedArguments: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }> = [];
  let approvals = 0;
  let lastApprovalDeduplicatedResources: ResearchProjectHierarchyApprovalRequestV1["deduplicatedResources"] = [];
  let firstMutationSawPreparedCheckpoint = false;
  let failOnceAtMutation = options.failOnceAtMutation ?? -1;
  let failOnceAtExternalReceipt = options.failOnceAtExternalReceipt ?? -1;
  let externalReceiptAttempts = 0;
  const externalReceipts = new Map<string, ActionReceipt>();
  const grant = await hierarchyGrant();

  const client: LinearToolClient = {
    async execute(operationKey, variables = {}): Promise<LinearOperationResult> {
      if (operationKey.endsWith(".list")) {
        if (operationKey === options.truncateListOperation) {
          const cursorIndex = typeof variables.after === "string"
            ? Number.parseInt(variables.after.replace("cursor-", ""), 10)
            : 0;
          return {
            items: [],
            pageInfo: {
              hasNextPage: true,
              endCursor: `cursor-${cursorIndex + 1}`,
            },
            fetchedAt: NOW,
          };
        }
        const resource = operationKey.split(".")[0].replace(/s$/u, "");
        return {
          items: [...records.values()].filter((record) =>
            record.resourceType === resource ||
            (resource === "initiative_project_link" && record.resourceType === "initiative_project_link") ||
            (resource === "issue_relation" && record.resourceType === "issue_relation"),
          ),
          pageInfo: { hasNextPage: false },
          fetchedAt: NOW,
        };
      }
      if (operationKey.endsWith(".get")) {
        const record = records.get(String(variables.id));
        if (!record) throw new Error("not found");
        return record;
      }
      throw new Error(`Unexpected direct client operation ${operationKey}`);
    },
  };

  const executor = {
    async prepare(input: {
      toolName: string;
      arguments: Record<string, unknown>;
      runId: string;
      toolCallId: string;
      context: ToolExecutionContext;
    }): Promise<HostLinearActionPreparation> {
      assert.equal(input.context.runId, input.runId);
      assert.equal(input.context.operationId, input.toolCallId);
      preparedArguments.push({
        toolName: input.toolName,
        arguments: JSON.parse(JSON.stringify(input.arguments)),
      });
      const resourceType = resourceTypeForTool(input.toolName);
      const id = `resource-${input.toolCallId}`.slice(0, 150);
      const action = await withPreparedActionFingerprint({
        version: 1,
        id: `action-${input.toolCallId}`.slice(0, 150),
        runId: input.runId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        target: { system: "linear", resourceType, id },
        relatedResources: [],
        normalizedArgs: JSON.parse(JSON.stringify(input.arguments)),
        preview: {
          summary: `Create ${resourceType}`,
          destination: `${plan.destination.workspaceId}/${plan.destination.teamId}`,
          outboundPayload: JSON.parse(JSON.stringify(input.arguments)),
          warnings: [],
          outboundBytes: 100,
        },
        idempotencyKey: `test:${input.toolCallId}`,
        reconciliationKey: `test:${input.toolCallId}`,
        preparedAt: NOW,
        expiresAt: "2026-07-16T16:00:00.000Z",
        requiredConfirmations: 1,
      });
      return {
        ok: true,
        status: "prepared",
        action,
        preview: action.preview,
        descriptor: descriptor(input.toolName, resourceType),
      };
    },
    async executePrepared(input: {
      action: PreparedAction;
      runId: string;
      toolCallId: string;
      context: ToolExecutionContext;
    }): Promise<HostLinearActionExecution> {
      assert.equal(input.context.runId, input.runId);
      assert.equal(input.context.operationId, input.toolCallId);
      assert.equal(input.action.toolCallId, input.toolCallId);
      const current = checkpointStore.current;
      if (mutations.length === 0) {
        firstMutationSawPreparedCheckpoint =
          current?.status === "approved" &&
          current.items.every((item) => item.status === "prepared" || item.status === "deduplicated");
      }
      if (mutations.length + 1 === failOnceAtMutation) {
        failOnceAtMutation = -1;
        return {
          ok: false,
          status: "not_applied",
          error: { code: "linear_fixture_not_applied", message: "Fixture rejected before dispatch." },
          action: input.action,
        };
      }
      if (records.has(input.action.target.id)) {
        throw new Error(`Duplicate mutation ${input.action.id}`);
      }
      mutations.push(input.action.id);
      const record = recordFromAction(input.action, mutations.length);
      records.set(record.id, record);
      return {
        ok: true,
        status: "committed",
        action: input.action,
        preview: input.action.preview,
        descriptor: descriptor(input.action.toolName, input.action.target.resourceType),
        grantId: grant.id,
        output: record,
        receipt: receipt(input.action, record, grant.id),
      };
    },
    async reconcile() {
      return { outcome: "still_uncertain" as const, message: "No uncertain fixture action." };
    },
  };

  const workflow = new ResearchProjectHierarchyWorkflowV1({
    readClient: client,
    actionExecutor: executor,
    checkpoints: checkpointStore,
    now: () => new Date(NOW),
    async persistExternalReceipt(receipt) {
      externalReceiptAttempts += 1;
      if (externalReceiptAttempts === failOnceAtExternalReceipt) {
        failOnceAtExternalReceipt = -1;
        throw new Error("fixture receipt ledger unavailable");
      }
      const existing = externalReceipts.get(receipt.id);
      if (existing) {
        assert.deepEqual(existing, receipt);
        return;
      }
      externalReceipts.set(receipt.id, JSON.parse(JSON.stringify(receipt)));
    },
    approval: {
      async requestExactGroupedApproval(request) {
        approvals += 1;
        lastApprovalDeduplicatedResources = structuredClone(
          request.deduplicatedResources,
        );
        if (options.driftFirstDeduplicatedOnApproval) {
          const dependency = checkpointStore.current?.items.find(
            (item) => item.status === "deduplicated",
          );
          if (dependency) {
            const current = records.get(dependency.resourceId);
            if (current) {
              records.set(dependency.resourceId, {
                ...current,
                snapshotHash: HASH("9"),
              });
            }
          }
        }
        return {
          approved: true,
          approvalId: "approval-hierarchy-1",
          approvalFingerprint: request.approvalFingerprint,
          grant,
        };
      },
      async resolvePersistedGrant(grantId) {
        return grantId === grant.id ? grant : null;
      },
    },
  });
  return {
    workflow,
    plan,
    mutations,
    preparedArguments,
    checkpointStore,
    externalReceipts,
    driftRecord(id: string, changes: Partial<LinearBaseRecord>) {
      const current = records.get(id);
      assert.ok(current, `Expected fixture record ${id}.`);
      records.set(id, { ...current, ...changes });
    },
    get approvals() { return approvals; },
    get lastApprovalDeduplicatedResources() {
      return lastApprovalDeduplicatedResources;
    },
    get firstMutationSawPreparedCheckpoint() { return firstMutationSawPreparedCheckpoint; },
    request: () => ({
      explicitUserMission: true,
      runId: plan.runId,
      toolCallId: "hierarchy-call-1",
      subject: { type: "run" as const, id: plan.runId },
      context: context(plan.runId),
      plan,
    }),
  };
}

class MemoryCheckpointStore implements ResearchProjectHierarchyCheckpointPortV1 {
  current: ResearchProjectHierarchyCheckpointV1 | null = null;

  async get(planFingerprint: string) {
    return this.current?.planFingerprint === planFingerprint
      ? JSON.parse(JSON.stringify(this.current))
      : null;
  }

  async persist(checkpoint: ResearchProjectHierarchyCheckpointV1) {
    this.current = JSON.parse(JSON.stringify(checkpoint));
  }
}

function planFixture() {
  return createResearchProjectPlanV1({
    planId: "plan-hierarchy-1",
    runId: "run-hierarchy-1",
    acceptedResearchArtifactFingerprint: HASH("a"),
    sourceNotePath: "Research/Accepted.md",
    destination: { workspaceId: "workspace-1", teamId: "team-1" },
    initiative: {
      key: "initiative-1",
      title: "Research initiative",
      description: "Deliver the accepted research outcome.",
    },
    project: {
      key: "project-1",
      title: "Research project",
      description: "Execute the accepted research plan.",
    },
    issues: [
      {
        key: "foundation",
        title: "Build the foundation",
        description: "Create the verified foundation.",
        dependencyKeys: [],
        acceptanceCriteria: ["Targeted validation passes."],
        workItemFingerprint: HASH("b"),
      },
      {
        key: "integration",
        title: "Integrate the result",
        description: "Integrate and read back the result.",
        dependencyKeys: ["foundation"],
        acceptanceCriteria: ["Independent readback verifies the result."],
        workItemFingerprint: HASH("c"),
      },
    ],
    createdAt: NOW,
  });
}


async function hierarchyGrant(): Promise<AuthorityGrantV1> {
  return createBoundedGrant({
    id: "grant-hierarchy-1",
    kind: "run_bounded",
    subject: { type: "run", id: "run-hierarchy-1" },
    issuer: "user_approval",
    rules: [{
      system: "linear",
      resourceTypes: ["initiative", "project", "initiative_project_link", "issue", "issue_relation"],
      actions: ["create"],
      selector: { teamIds: ["team-1"] },
    }],
    limits: {
      maxActions: 20,
      maxExternalMutations: 20,
      maxCreates: 20,
      maxDeletes: 0,
      maxOutboundBytes: 200_000,
    },
    issuedAt: new Date("2026-07-16T14:59:00.000Z"),
    expiresAt: new Date("2026-07-16T16:00:00.000Z"),
  });
}

function resourceTypeForTool(toolName: string) {
  if (toolName.includes("initiative_project_link")) return "initiative_project_link";
  if (toolName.includes("issue_relation")) return "issue_relation";
  if (toolName.includes("initiative")) return "initiative";
  if (toolName.includes("project")) return "project";
  return "issue";
}

function recordFromAction(action: PreparedAction, sequence: number): LinearBaseRecord {
  const args = action.normalizedArgs as Record<string, unknown>;
  const input = (args.input ?? args) as Record<string, unknown>;
  return {
    id: action.target.id,
    resourceType: action.target.resourceType as LinearBaseRecord["resourceType"],
    content: typeof input.content === "string" ? input.content : undefined,
    name: typeof input.name === "string" ? input.name : undefined,
    title: typeof args.title === "string" ? args.title : undefined,
    description:
      typeof input.description === "string"
        ? input.description
        : typeof args.description === "string"
          ? args.description
          : undefined,
    snapshotHash: HASH(String(sequence % 10)),
  };
}

function descriptor(name: string, resourceType: string) {
  return {
    version: 1 as const,
    name,
    capability: { system: "linear" as const, resourceType, action: "create" as const },
    effect: "reversible_mutation" as const,
    risk: "medium" as const,
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
      fallback: "exact" as const,
    },
    execution: {
      preparation: "required" as const,
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required" as const,
      reconciliation: "required" as const,
    },
    allowedPrincipals: ["host" as const],
    receiptKind: "external_action" as const,
  };
}

function receipt(action: PreparedAction, record: LinearBaseRecord, grantId: string): ActionReceipt {
  return {
    version: 1,
    id: `receipt-${action.id}`,
    runId: action.runId,
    actionId: action.id,
    toolName: action.toolName,
    operation: "create",
    resource: action.target,
    message: `Created ${record.resourceType}.`,
    payloadFingerprint: action.payloadFingerprint,
    grantId,
    idempotencyKey: action.idempotencyKey,
    startedAt: NOW,
    committedAt: NOW,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: NOW,
      observedFingerprint: record.snapshotHash,
    },
  };
}

function context(runId: string): ToolExecutionContext {
  return {
    app: {} as ToolExecutionContext["app"],
    settings: {} as ToolExecutionContext["settings"],
    originalPrompt: "Turn this accepted research into a Linear initiative, project, and dependency-aware issues.",
    runId,
    operationId: "hierarchy-call-1",
    httpTransport: async () => {
      throw new Error("not used");
    },
    now: () => new Date(NOW),
  };
}
