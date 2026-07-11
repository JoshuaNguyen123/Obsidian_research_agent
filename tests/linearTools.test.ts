import test from "node:test";
import assert from "node:assert/strict";
import { verifyPreparedActionFingerprint } from "../src/agent/actions";
import {
  consumeAuthorityGrant,
  createBoundedGrant,
  evaluateAuthorityGrant,
} from "../src/agent/authority";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import type {
  AgentTool,
  ToolExecutionContext,
} from "../src/tools/types";
import {
  LINEAR_TOOL_OPERATION_MAP,
  LinearClientError,
  createLinearTools,
  getLinearOperationDefinition,
  listLinearOperationDefinitions,
  type LinearCommentRecord,
  type LinearBaseRecord,
  type LinearIssueRecord,
  type LinearOperationResult,
  type LinearRequestOptions,
  type LinearResourceType,
  type LinearToolClient,
} from "../src/integrations/linear";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

test("public Linear tools have explicit fixed mappings and gate bounds", () => {
  const gateZero = createLinearTools({ client: inertClient(), gate: 0 });
  const gateFive = createLinearTools({ client: inertClient(), gate: 5 });

  assert.ok(gateZero.length > 0);
  assert.ok(
    gateZero.every(
      (tool) =>
        tool.name.startsWith("linear_") &&
        tool.descriptor?.effect === "read" &&
        tool.descriptor.execution.preparation === "none",
    ),
  );
  assert.deepEqual(
    new Set(gateFive.map((tool) => tool.name)),
    new Set(Object.keys(LINEAR_TOOL_OPERATION_MAP)),
  );
  for (const gate of [0, 1, 2, 3, 4, 5] as const) {
    const tools = createLinearTools({ client: inertClient(), gate });
    assert.ok(
      tools.every((tool) => {
        const operationKey = LINEAR_TOOL_OPERATION_MAP[tool.name];
        return (getLinearOperationDefinition(operationKey)?.gate ?? 99) <= gate;
      }),
    );
  }
  for (const tool of gateFive) {
    const operationKey = LINEAR_TOOL_OPERATION_MAP[tool.name];
    assert.ok(operationKey, `Missing fixed operation for ${tool.name}`);
    assert.ok(getLinearOperationDefinition(operationKey));
    assert.doesNotMatch(tool.name, /graphql|generic|arbitrary/i);
  }
  assert.equal(gateFive.some((tool) => tool.name === "linear_create_project"), true);
  const mappedOperations = new Set(Object.values(LINEAR_TOOL_OPERATION_MAP));
  assert.equal(
    mappedOperations.size,
    Object.keys(LINEAR_TOOL_OPERATION_MAP).length,
    "Each public tool must map to a distinct fixed operation.",
  );
  for (const definition of listLinearOperationDefinitions()) {
    assert.ok(
      mappedOperations.has(definition.key),
      `Missing model-facing tool for catalog operation ${definition.key}`,
    );
  }
  for (const definition of listLinearOperationDefinitions({ access: "write" })) {
    assert.ok(
      mappedOperations.has(definition.key),
      `Missing model-facing tool for ${definition.key}`,
    );
    const toolName = Object.entries(LINEAR_TOOL_OPERATION_MAP)
      .find(([, operationKey]) => operationKey === definition.key)?.[0];
    const tool = gateFive.find((candidate) => candidate.name === toolName);
    assert.equal(tool?.descriptor?.execution.preparation, "required");
    assert.equal(tool?.descriptor?.durability.readback, "required");
    assert.equal(tool?.descriptor?.durability.reconciliation, "required");
  }
});

test("read tools directly execute only their mapped catalog operation", async () => {
  const calls: Array<{
    key: string;
    variables: Record<string, unknown>;
    options?: LinearRequestOptions;
  }> = [];
  const client: LinearToolClient = {
    execute: async (key, variables = {}, options) => {
      calls.push({ key, variables, options });
      return {
        items: [],
        pageInfo: { hasNextPage: false },
        fetchedAt: "2026-07-11T12:00:00.000Z",
      };
    },
  };
  const tool = requireTool(
    createLinearTools({ client, gate: 1 }),
    "linear_list_issues",
  );

  const result = await tool.execute(
    { first: 5, includeArchived: true },
    contextFixture({ deadlineAt: 2_000_000_000_000 }),
  );

  assert.deepEqual(result, {
    items: [],
    pageInfo: { hasNextPage: false },
    fetchedAt: "2026-07-11T12:00:00.000Z",
  });
  assert.deepEqual(calls, [
    {
      key: "issues.list",
      variables: { first: 5, includeArchived: true },
      options: { deadlineAt: 2_000_000_000_000 },
    },
  ]);
});

test("issue creation prepares a canonical action without dispatching a mutation", async () => {
  const calls: string[] = [];
  const client: LinearToolClient = {
    execute: async (key) => {
      calls.push(key);
      if (key === "issues.get") throw notFound(key);
      throw new Error(`Unexpected operation ${key}`);
    },
  };
  const tool = requireTool(
    createLinearTools({ client, gate: 1 }),
    "linear_create_issue",
  );
  const context = contextFixture();

  await assert.rejects(
    tool.execute({ teamId: "team-1", title: "Ticket" }, context),
    (error: unknown) =>
      error instanceof Error && error.message.includes("prepared and authorized"),
  );
  const prepared = await tool.prepare!(
    { teamId: "team-1", title: "Research ticket", priority: 2 },
    context,
  );

  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const variables = prepared.action.normalizedArgs.variables as {
    input: Record<string, unknown>;
  };
  assert.match(String(variables.input.id), /^[0-9a-f-]{36}$/);
  assert.equal(prepared.action.target.id, variables.input.id);
  assert.equal(prepared.action.target.teamId, "team-1");
  assert.equal(prepared.action.preview.outboundPayload?.input instanceof Object, true);
  assert.equal(prepared.action.idempotencyKey, prepared.action.reconciliationKey);
  assert.equal(await verifyPreparedActionFingerprint(prepared.action), true);
  assert.equal(tool.descriptor?.execution.preparation, "required");
  assert.equal(tool.descriptor?.durability.readback, "required");
  assert.deepEqual(calls, ["issues.get"]);
});

test("issue creation resolves an omitted team only from the trusted host setting", async () => {
  const client: LinearToolClient = {
    execute: async (key) => {
      if (key === "issues.get") throw notFound(key);
      throw new Error(`Unexpected operation ${key}`);
    },
  };
  const tool = requireTool(
    createLinearTools({ client, gate: 1 }),
    "linear_create_issue",
  );
  const prepared = await tool.prepare!(
    { title: "Use pinned team" },
    contextFixture({
      settings: { linearDefaultTeamId: "team-default" } as never,
    }),
  );

  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const variables = prepared.action.normalizedArgs.variables as {
    input: Record<string, unknown>;
  };
  assert.equal(variables.input.teamId, "team-default");
  assert.equal(prepared.action.target.teamId, "team-default");
});

test("prepared issue creation verifies readback and returns a valid receipt", async () => {
  let created = false;
  let createdInput: Record<string, unknown> | undefined;
  const calls: string[] = [];
  const client: LinearToolClient = {
    execute: async (key, variables = {}) => {
      calls.push(key);
      if (key === "issues.get" && !created) throw notFound(key);
      if (key === "issues.create") {
        createdInput = variables.input as Record<string, unknown>;
        created = true;
        return mutationAck(key, "issue");
      }
      if (key === "issues.get" && createdInput) {
        return issueRecord({
          id: String(createdInput.id),
          title: String(createdInput.title),
          teamId: String(createdInput.teamId),
          priority: Number(createdInput.priority ?? 0),
          snapshotHash: HASH_B,
        });
      }
      throw new Error(`Unexpected operation ${key}`);
    },
  };
  const registry = new DefaultToolRegistry(createLinearTools({ client, gate: 1 }));
  const context = contextFixture();
  const prepared = await registry.prepare(
    {
      name: "linear_create_issue",
      arguments: { teamId: "team-1", title: "Research ticket", priority: 2 },
    },
    context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const result = await registry.executePrepared(prepared.action, context, {
    preparedActionId: prepared.action.id,
    payloadFingerprint: prepared.action.payloadFingerprint,
    grantId: "grant-linear-1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.mutationState, "applied");
  assert.equal(result.receipt?.grantId, "grant-linear-1");
  assert.equal(result.receipt?.readback.status, "verified");
  assert.equal(result.receipt?.readback.observedRevision, HASH_B);
  assert.equal(result.receipt?.commitKind, "committed");
  assert.deepEqual(calls, [
    "issues.get",
    "issues.get",
    "issues.create",
    "issues.get",
  ]);
});

test("comment preparation inherits issue project scope for bounded authority", async () => {
  const scopedIssue = issueRecord({
    id: "issue-queue-1",
    teamId: "team-queue",
    projectId: "project-queue",
  });
  const client: LinearToolClient = {
    execute: async (key) => {
      if (key === "issues.get") return scopedIssue;
      if (key === "comments.get") throw notFound(key);
      throw new Error(`Unexpected operation ${key}`);
    },
  };
  const tool = requireTool(
    createLinearTools({ client, gate: 1 }),
    "linear_create_comment",
  );
  const context = contextFixture();
  const prepared = await tool.prepare!(
    { issueId: "PLAT-42", body: "Queue claim started." },
    context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  assert.equal(prepared.action.target.teamId, "team-queue");
  assert.equal(prepared.action.target.projectId, "project-queue");
  assert.deepEqual(
    prepared.action.relatedResources.find(
      (resource) => resource.resourceType === "issue",
    ),
    {
      system: "linear",
      resourceType: "issue",
      id: "issue-queue-1",
      identifier: "PLAT-42",
      url: "https://linear.app/acme/issue/PLAT-42",
      teamId: "team-queue",
      projectId: "project-queue",
    },
  );
  const normalized = prepared.action.normalizedArgs.variables as {
    input: { issueId: string };
  };
  assert.equal(normalized.input.issueId, "issue-queue-1");

  const grant = await createBoundedGrant({
    id: "grant-project-comments",
    kind: "run_bounded",
    subject: { type: "run", id: context.runId! },
    rules: [
      {
        system: "linear",
        resourceTypes: ["comment"],
        actions: ["create"],
        selector: { projectIds: ["project-queue"] },
      },
    ],
    limits: {
      maxActions: 2,
      maxExternalMutations: 2,
      maxCreates: 2,
      maxDeletes: 0,
      maxOutboundBytes: 100_000,
    },
    issuedAt: new Date("2026-07-11T11:59:00.000Z"),
    expiresAt: new Date("2026-07-11T13:00:00.000Z"),
  });
  const descriptor = tool.descriptor!;
  const evaluation = await evaluateAuthorityGrant({
    grant,
    action: prepared.action,
    descriptor,
    now: new Date("2026-07-11T12:00:00.000Z"),
  });
  assert.equal(evaluation.allowed, true);
  const consumed = await consumeAuthorityGrant({
    grant,
    action: prepared.action,
    descriptor,
    now: new Date("2026-07-11T12:00:00.000Z"),
  });
  assert.equal(consumed.allowed, true);
  if (consumed.allowed) {
    assert.equal(consumed.grant.usage.actions, 1);
    assert.equal(consumed.grant.usage.externalMutations, 1);
    assert.equal(consumed.grant.usage.creates, 1);
  }
});

test("prepared update refuses target drift before provider dispatch", async () => {
  let reads = 0;
  let mutations = 0;
  const client: LinearToolClient = {
    execute: async (key) => {
      if (key === "issues.get") {
        reads += 1;
        return issueRecord({
          title: reads === 1 ? "Before" : "Changed elsewhere",
          snapshotHash: reads === 1 ? HASH_A : HASH_B,
          projectId: "project-queue",
        });
      }
      if (key === "issues.update") {
        mutations += 1;
        return mutationAck(key, "issue");
      }
      throw new Error(`Unexpected operation ${key}`);
    },
  };
  const registry = new DefaultToolRegistry(createLinearTools({ client, gate: 1 }));
  const context = contextFixture();
  const prepared = await registry.prepare(
    {
      name: "linear_update_issue",
      arguments: { id: "PLAT-42", title: "Approved title" },
    },
    context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.action.target.projectId, "project-queue");

  const result = await registry.executePrepared(prepared.action, context, {
    preparedActionId: prepared.action.id,
    payloadFingerprint: prepared.action.payloadFingerprint,
    grantId: "grant-linear-2",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "linear_precondition_changed");
  assert.equal(result.mutationState, "not_applied");
  assert.equal(mutations, 0);
});

test("uncertain creation reconciles only after matching independent readback", async () => {
  let phase: "prepare" | "execute" | "reconcile" = "prepare";
  let resourceId = "";
  const client: LinearToolClient = {
    execute: async (key, variables = {}) => {
      if (key === "issues.get") {
        if (phase !== "reconcile") throw notFound(key);
        return issueRecord({
          id: resourceId,
          title: "Research ticket",
          teamId: "team-1",
          snapshotHash: HASH_B,
        });
      }
      if (key === "issues.create") {
        resourceId = String((variables.input as Record<string, unknown>).id);
        phase = "reconcile";
        throw new LinearClientError(
          "linear_timeout",
          "Linear request timed out.",
          { operationKey: key },
        );
      }
      throw new Error(`Unexpected operation ${key}`);
    },
  };
  const registry = new DefaultToolRegistry(createLinearTools({ client, gate: 1 }));
  const context = contextFixture();
  const prepared = await registry.prepare(
    {
      name: "linear_create_issue",
      arguments: { teamId: "team-1", title: "Research ticket" },
    },
    context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  phase = "execute";
  const execution = await registry.executePrepared(prepared.action, context, {
    preparedActionId: prepared.action.id,
    payloadFingerprint: prepared.action.payloadFingerprint,
    grantId: "grant-linear-3",
  });
  assert.equal(execution.ok, false);
  assert.equal(execution.error?.code, "linear_mutation_uncertain");
  assert.equal(execution.mutationState, "may_have_applied");

  const reconciled = await registry.reconcile(prepared.action, context);
  assert.equal(reconciled.outcome, "committed");
  assert.equal(reconciled.receipt?.commitKind, "reconciled");
  assert.equal(reconciled.receipt?.readback.observedRevision, HASH_B);
});

test("comment deletion succeeds only after absence readback", async () => {
  let deleted = false;
  const client: LinearToolClient = {
    execute: async (key) => {
      if (key === "comments.get" && deleted) throw notFound(key);
      if (key === "comments.get") return commentRecord();
      if (key === "comments.delete") {
        deleted = true;
        return mutationAck(key, "comment");
      }
      throw new Error(`Unexpected operation ${key}`);
    },
  };
  const registry = new DefaultToolRegistry(createLinearTools({ client, gate: 1 }));
  const context = contextFixture();
  const prepared = await registry.prepare(
    { name: "linear_delete_comment", arguments: { id: "comment-1" } },
    context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const result = await registry.executePrepared(prepared.action, context, {
    preparedActionId: prepared.action.id,
    payloadFingerprint: prepared.action.payloadFingerprint,
    grantId: "grant-linear-delete",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    success: true,
    deleted: true,
    id: "comment-1",
  });
  assert.equal(result.receipt?.readback.status, "verified");
  assert.equal(result.receipt?.effects?.changedFields?.[0], "deleted");
});

test("gate-two project creation uses generic prepared input and exact readback", async () => {
  let createdInput: Record<string, unknown> | undefined;
  const client: LinearToolClient = {
    execute: async (key, variables = {}) => {
      if (key === "projects.get" && !createdInput) throw notFound(key);
      if (key === "projects.create") {
        createdInput = variables.input as Record<string, unknown>;
        return mutationAck(key, "project");
      }
      if (key === "projects.get" && createdInput) {
        return genericRecord("project", String(createdInput.id), {
          name: String(createdInput.name),
        });
      }
      throw new Error(`Unexpected operation ${key}`);
    },
  };
  const registry = new DefaultToolRegistry(createLinearTools({ client, gate: 2 }));
  const context = contextFixture();
  const prepared = await registry.prepare(
    {
      name: "linear_create_project",
      arguments: { input: { name: "Research roadmap" } },
    },
    context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const result = await registry.executePrepared(prepared.action, context, {
    preparedActionId: prepared.action.id,
    payloadFingerprint: prepared.action.payloadFingerprint,
    grantId: "grant-project-create",
  });

  assert.equal(result.ok, true);
  assert.equal((result.output as LinearBaseRecord).name, "Research roadmap");
  assert.equal(result.receipt?.resource.resourceType, "project");
});

test("gate-four label binding verifies the project label set", async () => {
  let linked = false;
  const client: LinearToolClient = {
    execute: async (key) => {
      if (key === "projects.get") {
        return {
          ...genericRecord("project", "project-1", { name: "Roadmap" }),
          labels: linked ? [{ id: "label-1", name: "agent" }] : [],
          snapshotHash: linked ? HASH_B : HASH_A,
        };
      }
      if (key === "projects.add_label") {
        linked = true;
        return mutationAck(key, "project");
      }
      throw new Error(`Unexpected operation ${key}`);
    },
  };
  const registry = new DefaultToolRegistry(createLinearTools({ client, gate: 4 }));
  const context = contextFixture();
  const prepared = await registry.prepare(
    {
      name: "linear_add_label_to_project",
      arguments: { id: "project-1", labelId: "label-1" },
    },
    context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const result = await registry.executePrepared(prepared.action, context, {
    preparedActionId: prepared.action.id,
    payloadFingerprint: prepared.action.payloadFingerprint,
    grantId: "grant-project-label",
  });

  assert.equal(result.ok, true);
  assert.equal(result.receipt?.effects?.changedFields?.[0], "labels");
  assert.equal(result.receipt?.relatedResources?.[0].resourceType, "project_label");
});

test("generic mutations fail closed when readback cannot prove every input field", async () => {
  let updated = false;
  const before = genericRecord("customer", "customer-1", { name: "Before" });
  const client: LinearToolClient = {
    execute: async (key) => {
      if (key === "customers.get") {
        return updated
          ? genericRecord("customer", "customer-1", { name: "After" }, HASH_B)
          : before;
      }
      if (key === "customers.update") {
        updated = true;
        return mutationAck(key, "customer");
      }
      throw new Error(`Unexpected operation ${key}`);
    },
  };
  const registry = new DefaultToolRegistry(createLinearTools({ client, gate: 5 }));
  const context = contextFixture();
  const prepared = await registry.prepare(
    {
      name: "linear_update_customer",
      arguments: {
        id: "customer-1",
        input: { name: "After", domains: ["example.com"] },
      },
    },
    context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const result = await registry.executePrepared(prepared.action, context, {
    preparedActionId: prepared.action.id,
    payloadFingerprint: prepared.action.payloadFingerprint,
    grantId: "grant-customer-update",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "linear_readback_failed");
  assert.equal(result.mutationState, "may_have_applied");
  assert.equal(result.receipt, undefined);
});

function requireTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing tool ${name}`);
  return tool;
}

function inertClient(): LinearToolClient {
  return {
    execute: async () => {
      throw new Error("not executed");
    },
  };
}

function contextFixture(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    runId: "run-linear-1",
    operationId: "call-linear-1",
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    httpTransport: async () => ({ status: 500, headers: {} }),
    ...overrides,
  } as unknown as ToolExecutionContext;
}

function notFound(operationKey: string): LinearClientError {
  return new LinearClientError(
    "linear_not_found",
    "Linear resource was not found.",
    { operationKey },
  );
}

function mutationAck(
  operationKey: string,
  resourceType: LinearResourceType,
): LinearOperationResult {
  return {
    success: true,
    operationKey,
    operationName: "LinearMutation",
    resourceType,
    acknowledgedAt: "2026-07-11T12:00:00.000Z",
  };
}

function genericRecord(
  resourceType: LinearResourceType,
  id: string,
  attributes: Record<string, string | number | boolean | null | string[]>,
  snapshotHash = HASH_A,
): LinearBaseRecord {
  return {
    resourceType,
    id,
    ...(typeof attributes.name === "string" ? { name: attributes.name } : {}),
    attributes,
    snapshotHash,
  };
}

function issueRecord(
  overrides: {
    id?: string;
    title?: string;
    teamId?: string;
    priority?: number;
    projectId?: string;
    snapshotHash?: string;
  } = {},
): LinearIssueRecord {
  return {
    resourceType: "issue",
    id: overrides.id ?? "issue-1",
    identifier: "PLAT-42",
    url: "https://linear.app/acme/issue/PLAT-42",
    title: overrides.title ?? "Before",
    priority: overrides.priority ?? 0,
    trashed: false,
    team: { id: overrides.teamId ?? "team-1", name: "Platform", key: "PLAT" },
    ...(overrides.projectId
      ? { project: { id: overrides.projectId, name: "Queue project" } }
      : {}),
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    labels: [],
    snapshotHash: overrides.snapshotHash ?? HASH_A,
  };
}

function commentRecord(): LinearCommentRecord {
  return {
    resourceType: "comment",
    id: "comment-1",
    url: "https://linear.app/comment/comment-1",
    body: "Remove me",
    issue: { id: "issue-1", identifier: "PLAT-42" },
    snapshotHash: HASH_A,
  };
}
