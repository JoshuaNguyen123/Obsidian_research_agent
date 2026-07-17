import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorityGrantStore,
  createAuthorityGrantStoreState,
  createBoundedGrant,
  type AuthorityGrantV1,
} from "../src/agent/authority";
import type { ToolExecutionContext } from "../src/tools/types";
import {
  HostLinearActionExecutor,
  LinearClientError,
  createPendingLinearReconciliationState,
  upsertUncertainLinearReconciliation,
  recordLinearReconciliationOutcome,
  type LinearAuthoritySubject,
  type LinearIssueRecord,
  type LinearOperationResult,
  type LinearResourceType,
  type LinearToolClient,
} from "../src/integrations/linear";

const NOW = new Date("2026-07-11T12:00:00.000Z");
const HASH = `sha256:${"b".repeat(64)}`;
const SUBJECT: LinearAuthoritySubject = {
  type: "schedule",
  id: "linear-queue-project-1",
};

test("host-owned hierarchy executor exposes its fixed gate-4 link child only at gate 4", async () => {
  const client: LinearToolClient = {
    async execute(operationKey) {
      if (operationKey === "initiative_project_links.get") {
        throw notFound(operationKey);
      }
      throw new Error(`Unexpected Linear operation ${operationKey}`);
    },
  };
  const createExecutor = (gate: 3 | 4) =>
    new HostLinearActionExecutor({
      client,
      gate,
      activeGrants: [],
      authorizeAndConsume: async () => {
        throw new Error("Preparation cannot consume authority.");
      },
    });
  const request = {
    toolName: "linear_create_initiative_project_link",
    arguments: {
      input: { initiativeId: "initiative-1", projectId: "project-1" },
    },
    runId: "run-hierarchy-link",
    toolCallId: "call-hierarchy-link",
    context: contextFixture("run-hierarchy-link", "call-hierarchy-link"),
  };

  const gateThree = await createExecutor(3).prepare(request);
  assert.equal(gateThree.ok, false);
  const gateFour = await createExecutor(4).prepare(request);
  assert.equal(gateFour.ok, true);
  if (!gateFour.ok) return;
  assert.equal(gateFour.action.toolName, request.toolName);
  assert.equal(gateFour.descriptor.capability.resourceType, "initiative_project_link");
});

test("host Linear executor persists authority consumption before dispatch and returns a canonical receipt", async () => {
  const events: string[] = [];
  const grant = await queueGrant(SUBJECT, "grant-success");
  const store = new AuthorityGrantStore(
    createAuthorityGrantStoreState(new Date("2026-07-11T11:00:00.000Z")),
    async (state) => {
      events.push(`persist:${state.grants[0]?.usage.actions ?? 0}`);
    },
  );
  await store.upsert(grant, new Date("2026-07-11T11:01:00.000Z"));
  events.length = 0;

  let createdInput: Record<string, unknown> | undefined;
  const client: LinearToolClient = {
    execute: async (operationKey, variables = {}) => {
      if (operationKey === "issues.get" && !createdInput) {
        events.push("read:absent");
        throw notFound(operationKey);
      }
      if (operationKey === "issues.create") {
        events.push("mutation:create");
        createdInput = variables.input as Record<string, unknown>;
        return mutationAck(operationKey, "issue");
      }
      if (operationKey === "issues.get" && createdInput) {
        events.push("read:created");
        return issueRecord({
          id: String(createdInput.id),
          title: String(createdInput.title),
          teamId: String(createdInput.teamId),
        });
      }
      throw new Error(`Unexpected Linear operation ${operationKey}`);
    },
  };
  const executor = new HostLinearActionExecutor({
    client,
    gate: 1,
    activeGrants: () => store.snapshot().grants,
    authorizeAndConsume: async (request) => {
      events.push("consume:start");
      const consumed = await store.authorizeAndConsume(request);
      events.push("consume:done");
      return consumed;
    },
  });

  const result = await executor.execute({
    toolName: "linear_create_issue",
    arguments: { teamId: "team-1", title: "Research ticket" },
    runId: "run-1",
    toolCallId: "call-1",
    subject: SUBJECT,
    context: contextFixture("run-1", "call-1"),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "committed");
  assert.equal(result.receipt.grantId, grant.id);
  assert.equal(result.receipt.resource.system, "linear");
  assert.equal(result.receipt.readback.status, "verified");
  assert.equal(store.get(grant.id)?.usage.actions, 1);
  assert.deepEqual(events, [
    "read:absent",
    "consume:start",
    "persist:1",
    "consume:done",
    "read:absent",
    "mutation:create",
    "read:created",
  ]);
  assert.ok(events.indexOf("persist:1") < events.indexOf("mutation:create"));
});

test("explicit authority subject mismatch returns the prepared preview without dispatch", async () => {
  const grant = await queueGrant(SUBJECT, "grant-wrong-subject");
  let mutationCount = 0;
  let consumptionCount = 0;
  const executor = new HostLinearActionExecutor({
    client: createAbsentIssueClient(() => {
      mutationCount += 1;
    }),
    gate: 1,
    activeGrants: [grant],
    authorizeAndConsume: async () => {
      consumptionCount += 1;
      return grant;
    },
  });

  const result = await executor.execute({
    toolName: "linear_create_issue",
    arguments: { teamId: "team-1", title: "Research ticket" },
    runId: "run-2",
    toolCallId: "call-2",
    subject: { type: "schedule", id: "different-queue" },
    context: contextFixture("run-2", "call-2"),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "linear_authority_denied");
  assert.match(result.preview?.summary ?? "", /create Linear issue/i);
  assert.equal(consumptionCount, 0);
  assert.equal(mutationCount, 0);
});

test("ambiguous Linear dispatch surfaces reconcile_required and never retries", async () => {
  const grant = await queueGrant(SUBJECT, "grant-uncertain");
  const store = new AuthorityGrantStore(
    createAuthorityGrantStoreState(new Date("2026-07-11T11:00:00.000Z")),
    async () => undefined,
  );
  await store.upsert(grant, new Date("2026-07-11T11:01:00.000Z"));
  let mutationCount = 0;
  let createdInput: Record<string, unknown> | undefined;
  let uncertain = false;
  const client: LinearToolClient = {
    execute: async (operationKey, variables = {}) => {
      if (operationKey === "issues.get" && !uncertain) {
        throw notFound(operationKey);
      }
      if (operationKey === "issues.create") {
        mutationCount += 1;
        createdInput = variables.input as Record<string, unknown>;
        uncertain = true;
        throw new LinearClientError(
          "linear_timeout",
          "Linear request timed out after dispatch.",
          { operationKey },
        );
      }
      if (operationKey === "issues.get" && uncertain && createdInput) {
        return issueRecord({
          id: String(createdInput.id),
          title: String(createdInput.title),
          teamId: String(createdInput.teamId),
        });
      }
      throw new Error(`Unexpected Linear operation ${operationKey}`);
    },
  };
  const executor = new HostLinearActionExecutor({
    client,
    gate: 1,
    activeGrants: () => store.snapshot().grants,
    authorizeAndConsume: (request) => store.authorizeAndConsume(request),
  });
  const context = contextFixture("run-3", "call-3");

  const result = await executor.execute({
    toolName: "linear_create_issue",
    arguments: { teamId: "team-1", title: "Research ticket" },
    runId: "run-3",
    toolCallId: "call-3",
    subject: SUBJECT,
    context,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, "reconcile_required");
  assert.equal(result.error.code, "linear_mutation_uncertain");
  assert.equal(mutationCount, 1);
  assert.ok(result.action);
  assert.equal(result.grantId, grant.id);

  const reconciled = await executor.reconcile({
    action: result.action!,
    runId: "run-3",
    toolCallId: "call-3",
    grantId: result.grantId!,
    context,
  });
  assert.equal(reconciled.outcome, "committed");
  assert.equal(reconciled.receipt?.commitKind, "reconciled");
  assert.equal(reconciled.receipt?.grantId, grant.id);
  assert.equal(mutationCount, 1);
});

test("finalization-style prepared action survives commit-then-transport-loss and reconciles after restart without duplicate create", async () => {
  const grant = await queueGrant(SUBJECT, "grant-finalization-crash");
  const store = new AuthorityGrantStore(
    createAuthorityGrantStoreState(new Date("2026-07-11T11:00:00.000Z")),
    async () => undefined,
  );
  await store.upsert(grant, new Date("2026-07-11T11:01:00.000Z"));
  let mutationCount = 0;
  let createdInput: Record<string, unknown> | undefined;
  const client: LinearToolClient = {
    execute: async (operationKey, variables = {}) => {
      if (operationKey === "issues.get" && !createdInput) throw notFound(operationKey);
      if (operationKey === "issues.create") {
        mutationCount += 1;
        createdInput = variables.input as Record<string, unknown>;
        throw new LinearClientError(
          "linear_timeout",
          "Provider committed before the transport was lost.",
          { operationKey },
        );
      }
      if (operationKey === "issues.get" && createdInput) {
        return issueRecord({
          id: String(createdInput.id),
          title: String(createdInput.title),
          teamId: String(createdInput.teamId),
        });
      }
      throw new Error(`Unexpected Linear operation ${operationKey}`);
    },
  };
  const executor = new HostLinearActionExecutor({
    client,
    gate: 1,
    activeGrants: () => store.snapshot().grants,
    authorizeAndConsume: (request) => store.authorizeAndConsume(request),
  });
  const context = contextFixture("run-finalization", "github-linear-link-publication-1");
  const prepared = await executor.prepare({
    toolName: "linear_create_issue",
    arguments: { teamId: "team-1", title: "Publication linkage fixture" },
    runId: "run-finalization",
    toolCallId: "github-linear-link-publication-1",
    context,
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  let pending = await upsertUncertainLinearReconciliation(
    createPendingLinearReconciliationState(new Date("2026-07-11T12:00:00.000Z")),
    {
      expectedRevision: 0,
      action: prepared.action,
      grantId: grant.id,
      issueId: "issue-origin",
      queueStage: "manual",
      authoritySubject: SUBJECT,
      at: "2026-07-11T12:01:00.000Z",
      error: {
        code: "linear_finalization_dispatch_prepared",
        message: "Prepared before provider dispatch.",
      },
    },
  );
  const executed = await executor.executePrepared({
    action: prepared.action,
    runId: "run-finalization",
    toolCallId: "github-linear-link-publication-1",
    context,
    subject: SUBJECT,
    preferredGrantId: grant.id,
  });
  assert.equal(executed.ok, false);
  if (executed.ok) return;
  assert.equal(executed.status, "reconcile_required");

  const persisted = pending.pendingByActionId[prepared.action.id]!;
  const reconciled = await executor.reconcile({
    action: persisted.action,
    runId: persisted.action.runId,
    toolCallId: persisted.action.toolCallId,
    grantId: persisted.grantId,
    context,
  });
  assert.equal(reconciled.outcome, "committed");
  assert.equal(reconciled.receipt?.commitKind, "reconciled");
  assert.equal(mutationCount, 1);
  pending = await recordLinearReconciliationOutcome(pending, {
    expectedRevision: pending.revision,
    actionId: prepared.action.id,
    outcome: "committed",
    at: "2026-07-11T12:02:00.000Z",
  });
  assert.equal(Object.keys(pending.pendingByActionId).length, 0);
});

test("fixed mutation boundary rejects reads, generic GraphQL names, and query arguments", async () => {
  let clientCalls = 0;
  const executor = new HostLinearActionExecutor({
    client: {
      execute: async () => {
        clientCalls += 1;
        throw new Error("Client should not be called.");
      },
    },
    gate: 1,
    activeGrants: [],
    authorizeAndConsume: async () => {
      throw new Error("Authority should not be consumed.");
    },
  });
  const context = contextFixture("run-4", "call-4");

  const generic = await executor.prepare({
    toolName: "linear_graphql",
    arguments: { query: "mutation { issueCreate }" },
    runId: "run-4",
    toolCallId: "call-4",
    context,
  });
  assert.equal(generic.ok, false);
  if (!generic.ok) assert.equal(generic.error.code, "linear_fixed_tool_required");

  const read = await executor.prepare({
    toolName: "linear_get_issue",
    arguments: { id: "PLAT-42" },
    runId: "run-4",
    toolCallId: "call-4",
    context,
  });
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error.code, "linear_mutation_required");

  const queryArgument = await executor.prepare({
    toolName: "linear_create_issue",
    arguments: {
      teamId: "team-1",
      title: "Research ticket",
      query: "mutation { issueCreate }",
    },
    runId: "run-4",
    toolCallId: "call-4",
    context,
  });
  assert.equal(queryArgument.ok, false);
  if (!queryArgument.ok) {
    assert.equal(queryArgument.error.code, "linear_invalid_arguments");
  }
  assert.equal(clientCalls, 0);
});

test("executor refuses a callback result that did not consume persisted usage", async () => {
  const grant = await queueGrant(SUBJECT, "grant-not-consumed");
  let mutationCount = 0;
  const executor = new HostLinearActionExecutor({
    client: createAbsentIssueClient(() => {
      mutationCount += 1;
    }),
    gate: 1,
    activeGrants: [grant],
    authorizeAndConsume: async () => grant,
  });

  const result = await executor.execute({
    toolName: "linear_create_issue",
    arguments: { teamId: "team-1", title: "Research ticket" },
    runId: "run-5",
    toolCallId: "call-5",
    subject: SUBJECT,
    context: contextFixture("run-5", "call-5"),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "authority_consumption_failed");
  assert.equal(mutationCount, 0);
});

async function queueGrant(
  subject: LinearAuthoritySubject,
  id: string,
): Promise<AuthorityGrantV1> {
  return createBoundedGrant({
    id,
    kind: "scheduled_bounded",
    subject,
    rules: [
      {
        system: "linear",
        resourceTypes: ["issue"],
        actions: ["create"],
        selector: { teamIds: ["team-1"] },
      },
    ],
    limits: {
      maxActions: 10,
      maxExternalMutations: 10,
      maxCreates: 10,
      maxDeletes: 0,
      maxOutboundBytes: 100_000,
    },
    issuedAt: new Date("2026-07-11T11:00:00.000Z"),
    expiresAt: new Date("2026-07-11T16:00:00.000Z"),
  });
}

function contextFixture(runId: string, operationId: string): ToolExecutionContext {
  return {
    runId,
    operationId,
    now: () => new Date(NOW),
    httpTransport: async () => ({ status: 500, headers: {} }),
  } as unknown as ToolExecutionContext;
}

function createAbsentIssueClient(onMutation: () => void): LinearToolClient {
  return {
    execute: async (operationKey) => {
      if (operationKey === "issues.get") throw notFound(operationKey);
      if (operationKey === "issues.create") {
        onMutation();
        return mutationAck(operationKey, "issue");
      }
      throw new Error(`Unexpected Linear operation ${operationKey}`);
    },
  };
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
    acknowledgedAt: NOW.toISOString(),
  };
}

function issueRecord(overrides: {
  id: string;
  title: string;
  teamId: string;
}): LinearIssueRecord {
  return {
    resourceType: "issue",
    id: overrides.id,
    identifier: "PLAT-42",
    url: "https://linear.app/acme/issue/PLAT-42",
    title: overrides.title,
    priority: 0,
    trashed: false,
    team: { id: overrides.teamId, name: "Platform", key: "PLAT" },
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    labels: [],
    snapshotHash: HASH,
  };
}
