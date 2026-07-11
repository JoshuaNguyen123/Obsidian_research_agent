import test from "node:test";
import assert from "node:assert/strict";
import { withPreparedActionFingerprint, type ToolDescriptor } from "../src/agent/actions";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import type { AgentTool, ToolExecutionContext } from "../src/tools/types";

test("descriptor-aware tools cannot bypass required preparation", async () => {
  const fixture = createPreparedToolFixture();

  const legacy = await fixture.registry.execute(
    { name: fixture.tool.name, arguments: { title: "Ticket" } },
    fixture.context,
  );

  assert.equal(legacy.ok, false);
  assert.equal(legacy.error?.code, "prepared_action_required");
  assert.equal(legacy.mutationState, "not_applied");
  assert.equal(fixture.legacyExecutions, 0);
});

test("registry prepares, authorizes, executes, and validates a canonical receipt", async () => {
  const fixture = createPreparedToolFixture();
  const prepared = await fixture.registry.prepare(
    { name: fixture.tool.name, arguments: { title: "Ticket" } },
    fixture.context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const missing = await fixture.registry.executePrepared(
    prepared.action,
    fixture.context,
  );
  assert.equal(missing.error?.code, "authorization_required");
  assert.equal(missing.mutationState, "not_applied");

  const mismatched = await fixture.registry.executePrepared(
    prepared.action,
    fixture.context,
    {
      preparedActionId: prepared.action.id,
      payloadFingerprint: "sha256:not-the-action",
      grantId: "grant-1",
    },
  );
  assert.equal(mismatched.error?.code, "authorization_mismatch");
  assert.equal(fixture.preparedExecutions, 0);

  const executed = await fixture.registry.executePrepared(
    prepared.action,
    fixture.context,
    {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "grant-1",
    },
  );
  assert.equal(executed.ok, true);
  assert.equal(executed.mutationState, "applied");
  assert.equal(executed.receipt?.grantId, "grant-1");
  assert.equal(fixture.preparedExecutions, 1);
});

test("registry rejects tampered preparations before provider dispatch", async () => {
  const fixture = createPreparedToolFixture();
  const prepared = await fixture.registry.prepare(
    { name: fixture.tool.name, arguments: { title: "Ticket" } },
    fixture.context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const tampered = {
    ...prepared.action,
    normalizedArgs: { title: "Silently changed" },
  };
  const result = await fixture.registry.executePrepared(tampered, fixture.context, {
    preparedActionId: tampered.id,
    payloadFingerprint: tampered.payloadFingerprint,
    grantId: "grant-1",
  });

  assert.equal(result.error?.code, "fingerprint_mismatch");
  assert.equal(result.mutationState, "not_applied");
  assert.equal(fixture.preparedExecutions, 0);
});

test("invalid post-dispatch receipts surface possible application", async () => {
  const fixture = createPreparedToolFixture({ invalidReceipt: true });
  const prepared = await fixture.registry.prepare(
    { name: fixture.tool.name, arguments: { title: "Ticket" } },
    fixture.context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const result = await fixture.registry.executePrepared(prepared.action, fixture.context, {
    preparedActionId: prepared.action.id,
    payloadFingerprint: prepared.action.payloadFingerprint,
    grantId: "grant-1",
  });

  assert.equal(result.error?.code, "receipt_validation_failed");
  assert.equal(result.error?.details?.receiptCode, "receipt_grant");
  assert.equal(result.mutationState, "may_have_applied");
});

test("receipt readback must occur within the action commit interval", async () => {
  const fixture = createPreparedToolFixture({ lateReadback: true });
  const prepared = await fixture.registry.prepare(
    { name: fixture.tool.name, arguments: { title: "Ticket" } },
    fixture.context,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const result = await fixture.registry.executePrepared(prepared.action, fixture.context, {
    preparedActionId: prepared.action.id,
    payloadFingerprint: prepared.action.payloadFingerprint,
    grantId: "grant-1",
  });
  assert.equal(result.error?.code, "receipt_validation_failed");
  assert.equal(result.error?.details?.receiptCode, "receipt_timestamps");
  assert.equal(result.mutationState, "may_have_applied");
});

test("descriptorless tools retain legacy execution compatibility", async () => {
  const tool: AgentTool = {
    name: "legacy_read",
    description: "Legacy read",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ value: 1 }),
  };
  const registry = new DefaultToolRegistry([tool]);
  const context = contextFixture();

  const result = await registry.execute(
    { name: tool.name, arguments: {} },
    context,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { value: 1 });

  const prepared = await registry.prepare(
    { name: tool.name, arguments: {} },
    context,
  );
  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.equal(prepared.error.code, "descriptor_required");
});

function createPreparedToolFixture(
  options: { invalidReceipt?: boolean; lateReadback?: boolean } = {},
): {
  tool: AgentTool;
  registry: DefaultToolRegistry;
  context: ToolExecutionContext;
  readonly legacyExecutions: number;
  readonly preparedExecutions: number;
} {
  let legacyExecutions = 0;
  let preparedExecutions = 0;
  const descriptor = descriptorFixture();
  const tool: AgentTool = {
    name: descriptor.name,
    description: "Create a Linear issue",
    parameters: { type: "object", properties: { title: { type: "string" } } },
    descriptor,
    execute: async () => {
      legacyExecutions += 1;
      return { bypassed: true };
    },
    prepare: async (args) => ({
      ok: true,
      action: await withPreparedActionFingerprint({
        version: 1,
        id: "action-1",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: descriptor.name,
        target: {
          system: "linear",
          resourceType: "issue",
          id: "new:call-1",
          teamId: "team-1",
        },
        relatedResources: [],
        normalizedArgs: { title: String(args.title ?? "") },
        preview: {
          summary: "Create issue",
          destination: "Linear team team-1",
          outboundPayload: { title: String(args.title ?? "") },
          warnings: [],
          outboundBytes: 6,
        },
        idempotencyKey: "run-1:call-1",
        preparedAt: "2026-07-11T12:00:00.000Z",
        expiresAt: "2026-07-11T12:05:00.000Z",
      }),
    }),
    executePrepared: async (action, context) => {
      preparedExecutions += 1;
      const authorized = context.authorizedAction!;
      return {
        output: { identifier: "RES-123" },
        mutationState: "applied",
        receipt: {
          version: 1,
          id: "receipt-1",
          runId: action.runId,
          actionId: action.id,
          toolName: action.toolName,
          operation: "create",
          resource: {
            ...action.target,
            id: "issue-123",
            identifier: "RES-123",
          },
          message: "Created RES-123",
          payloadFingerprint: action.payloadFingerprint,
          grantId: options.invalidReceipt ? "wrong-grant" : authorized.grantId,
          idempotencyKey: action.idempotencyKey,
          startedAt: "2026-07-11T12:00:01.000Z",
          committedAt: "2026-07-11T12:00:02.000Z",
          commitKind: "committed",
          readback: {
            status: "verified",
            checkedAt: options.lateReadback
              ? "2026-07-11T12:00:03.000Z"
              : "2026-07-11T12:00:02.000Z",
            observedRevision: "updated-at-1",
          },
          effects: { affectedCount: 1, changedFields: ["title"] },
        },
      };
    },
  };
  const fixture = {
    tool,
    registry: new DefaultToolRegistry([tool]),
    context: contextFixture(),
    get legacyExecutions() {
      return legacyExecutions;
    },
    get preparedExecutions() {
      return preparedExecutions;
    },
  };
  return fixture;
}

function descriptorFixture(): ToolDescriptor {
  return {
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
    allowedPrincipals: ["single_agent", "lead", "researcher"],
    receiptKind: "external_action",
  };
}

function contextFixture(): ToolExecutionContext {
  return {
    runId: "run-1",
    now: () => new Date("2026-07-11T12:00:30.000Z"),
  } as unknown as ToolExecutionContext;
}
