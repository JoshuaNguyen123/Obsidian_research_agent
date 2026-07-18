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
import {
  LINEAR_RESEARCH_PROJECT_HIERARCHY_RECEIPT_TOOL_NAME,
  ResearchProjectHierarchyWorkflowV1,
  providerSummary,
  type ResearchProjectHierarchyCheckpointV1,
  type ResearchProjectHierarchyCheckpointPortV1,
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
  deriveResearchProjectWorkItemFingerprint,
  deriveResearchProjectPlanIdForAcceptedArtifact,
  hasExplicitResearchProjectHierarchyIntent,
  resolveCanonicalAcceptedResearchFingerprint,
  resolveCanonicalAcceptedResearchNotePath,
  sanitizeHierarchyNarrative,
  selectAcceptedResearchBindingForCurrentMission,
} from "../src/tools/researchProjectHierarchyTool";
import type { ToolExecutionContext } from "../src/tools/types";

const NOW = "2026-07-16T15:00:00.000Z";
const HASH = (character: string) => `sha256:${character.repeat(64)}`;

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
    },
    {
      runId: "run-other",
      artifactFingerprint: HASH("b"),
      notePath: "Projects/Chess/Research.md",
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
  assert.equal(initiativeInput.description, fixture.plan.initiative.description);
  assert.match(String(initiativeInput.content), /agentic-idempotency:/u);
  assert.equal(projectInput.description, fixture.plan.project.description);
  assert.match(String(projectInput.content), /agentic-idempotency:/u);
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

test("hierarchy deduplicates an exact idempotency marker before preparing mutations", async () => {
  const plan = planFixture();
  const existing: LinearBaseRecord = {
    id: "initiative-existing",
    resourceType: "initiative",
    name: plan.initiative.title,
    content: `${plan.initiative.description}\n\n<!-- agentic-idempotency:${plan.initiative.idempotencyKey} -->`,
    snapshotHash: HASH("e"),
  };
  const fixture = await hierarchyFixture({ plan, seed: [existing] });
  const result = await fixture.workflow.execute(fixture.request());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const initiative = result.checkpoint.items.find((item) => item.kind === "initiative");
  assert.equal(initiative?.status, "deduplicated");
  assert.equal(initiative?.resourceId, "initiative-existing");
  assert.equal(fixture.mutations.length, 5);
});

async function hierarchyFixture(options: {
  failOnceAtMutation?: number;
  failOnceAtExternalReceipt?: number;
  plan?: ReturnType<typeof planFixture>;
  seed?: LinearBaseRecord[];
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
  let firstMutationSawPreparedCheckpoint = false;
  let failOnceAtMutation = options.failOnceAtMutation ?? -1;
  let failOnceAtExternalReceipt = options.failOnceAtExternalReceipt ?? -1;
  let externalReceiptAttempts = 0;
  const externalReceipts = new Map<string, ActionReceipt>();
  const grant = await hierarchyGrant();

  const client: LinearToolClient = {
    async execute(operationKey, variables = {}): Promise<LinearOperationResult> {
      if (operationKey.endsWith(".list")) {
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
    get approvals() { return approvals; },
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
