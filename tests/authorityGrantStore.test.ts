import assert from "node:assert/strict";
import test from "node:test";
import {
  createBoundedGrant,
  createOneShotGrant,
  AuthorityGrantStore,
  createAuthorityGrantStoreState,
} from "../src/agent/authority";
import {
  withPreparedActionFingerprint,
  type ToolDescriptor,
} from "../src/agent/actions";

const descriptor: ToolDescriptor = {
  version: 1,
  name: "linear_create_issue",
  capability: { system: "linear", resourceType: "issue", action: "create" },
  effect: "reversible_mutation",
  risk: "medium",
  approval: {
    allowPromptGrant: true,
    allowPersistentGrant: true,
    fallback: "exact",
  },
  execution: {
    preparation: "required",
    cacheable: false,
    parallelSafe: false,
  },
  durability: {
    journal: true,
    receipt: true,
    readback: "required",
    reconciliation: "required",
  },
  allowedPrincipals: ["lead"],
  receiptKind: "external_action",
};

test("AuthorityGrantStore persists consumption before returning authority", async () => {
  const action = await withPreparedActionFingerprint({
    version: 1,
    id: "action-1",
    runId: "run-1",
    toolCallId: "call-1",
    toolName: descriptor.name,
    target: {
      system: "linear",
      resourceType: "issue",
      id: "client-issue-1",
      workspaceId: "workspace-1",
    },
    relatedResources: [],
    normalizedArgs: { title: "Issue" },
    preview: {
      summary: "Create issue",
      destination: "Linear",
      warnings: [],
      outboundBytes: 5,
    },
    idempotencyKey: "linear:create:1",
    reconciliationKey: "client-issue-1",
    preparedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
  });
  const grant = await createOneShotGrant({
    id: "grant-1",
    action,
    descriptor,
    issuedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const persisted: number[] = [];
  const store = new AuthorityGrantStore(
    createAuthorityGrantStoreState(new Date("2026-01-01T00:00:00.000Z")),
    async (state) => {
      persisted.push(state.grants[0]?.usage.actions ?? -1);
    },
  );
  await store.upsert(grant, new Date("2026-01-01T00:00:01.000Z"));
  const consumed = await store.authorizeAndConsume({
    grantId: grant.id,
    action,
    descriptor,
    now: new Date("2026-01-01T00:00:02.000Z"),
  });
  assert.equal(consumed.usage.actions, 1);
  assert.equal(consumed.state, "exhausted");
  assert.deepEqual(persisted, [0, 1]);
});

test("AuthorityGrantStore can consume a scheduled queue grant for an explicit subject", async () => {
  const action = await withPreparedActionFingerprint({
    version: 1,
    id: "action-scheduled-1",
    runId: "ticket-run-1",
    toolCallId: "call-scheduled-1",
    toolName: descriptor.name,
    target: {
      system: "linear",
      resourceType: "issue",
      id: "client-issue-2",
      workspaceId: "workspace-1",
      projectId: "project-1",
    },
    relatedResources: [],
    normalizedArgs: { title: "Scheduled issue" },
    preview: {
      summary: "Create scheduled issue",
      destination: "Linear",
      warnings: [],
      outboundBytes: 10,
    },
    preparedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
  });
  const subject = { type: "schedule" as const, id: "linear-queue-project-1" };
  const grant = await createBoundedGrant({
    id: "grant-scheduled-1",
    kind: "scheduled_bounded",
    subject,
    rules: [
      {
        system: "linear",
        resourceTypes: ["issue"],
        actions: ["create"],
        selector: {
          workspaceIds: ["workspace-1"],
          projectIds: ["project-1"],
        },
      },
    ],
    limits: {
      maxActions: 5,
      maxExternalMutations: 5,
      maxCreates: 5,
      maxDeletes: 0,
      maxOutboundBytes: 1_000,
    },
    issuedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2026-01-01T04:00:00.000Z"),
  });
  const store = new AuthorityGrantStore(
    createAuthorityGrantStoreState(new Date("2026-01-01T00:00:00.000Z")),
    async () => undefined,
  );
  await store.upsert(grant, new Date("2026-01-01T00:00:01.000Z"));

  const consumed = await store.authorizeAndConsume({
    grantId: grant.id,
    action,
    descriptor,
    subject,
    now: new Date("2026-01-01T00:00:02.000Z"),
  });

  assert.equal(consumed.usage.actions, 1);
  assert.equal(consumed.state, "active");
});
