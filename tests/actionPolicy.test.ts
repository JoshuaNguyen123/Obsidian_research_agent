import test from "node:test";
import assert from "node:assert/strict";
import {
  withPreparedActionFingerprint,
  type PreparedAction,
  type ToolDescriptor,
} from "../src/agent/actions";
import { createOneShotGrant } from "../src/agent/authority";
import {
  evaluateActionPolicy,
  evaluateToolPolicy,
} from "../src/agent/policyEngine";

test("descriptor-aware policy fails closed on missing context", async () => {
  const descriptor = descriptorFixture();
  const action = await actionFixture();

  const missingDescriptor = evaluateToolPolicy({
    toolName: descriptor.name,
    args: {},
    intent: {
      mode: "browser_mission",
      writeScope: "none",
      needsWebEvidence: false,
      needsVaultContext: false,
      needsCodeExecution: false,
      wordTarget: null,
      confidence: 1,
      rationale: "test",
    },
    approvalGranted: true,
    isDesktop: true,
    writeAutonomy: true,
    descriptor: null,
    preparedAction: action,
    principal: "single_agent",
    scopeAllowed: true,
  });
  assert.equal(missingDescriptor.action, "block");
  assert.ok(missingDescriptor.tags.includes("fail_closed"));

  const missingScope = evaluateActionPolicy({
    toolName: descriptor.name,
    descriptor,
    preparedAction: action,
    principal: "single_agent",
    isDesktop: true,
  });
  assert.equal(missingScope.action, "block");
  assert.ok(missingScope.tags.includes("resource_scope"));
});

test("mutation policy binds approval and grants to the prepared fingerprint", async () => {
  const descriptor = descriptorFixture();
  const action = await actionFixture();
  const approval = evaluateActionPolicy({
    toolName: descriptor.name,
    descriptor,
    preparedAction: action,
    principal: "researcher",
    scopeAllowed: true,
    isDesktop: true,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(approval.action, "require_approval");
  assert.equal(approval.payloadFingerprint, action.payloadFingerprint);
  assert.equal(approval.requiredConfirmations, 1);

  const grant = await createOneShotGrant({
    id: "grant-1",
    action,
    descriptor,
    issuedAt: new Date("2026-07-11T12:00:30.000Z"),
  });
  const allowed = evaluateActionPolicy({
    toolName: descriptor.name,
    descriptor,
    preparedAction: action,
    principal: "researcher",
    scopeAllowed: true,
    matchingGrant: grant,
    isDesktop: true,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(allowed.action, "allow");
  assert.equal(allowed.grantId, grant.id);
  assert.equal(allowed.payloadFingerprint, action.payloadFingerprint);
});

test("double-exact fallback requires two confirmations", async () => {
  const descriptor = descriptorFixture();
  descriptor.approval.fallback = "double_exact";
  const action = await actionFixture();
  const decision = evaluateActionPolicy({
    toolName: descriptor.name,
    descriptor,
    preparedAction: action,
    principal: "single_agent",
    scopeAllowed: true,
    isDesktop: true,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });

  assert.equal(decision.action, "require_approval");
  assert.equal(decision.requiredConfirmations, 2);
});

test("a fingerprinted prepared action can escalate exact approval to double exact", async () => {
  const descriptor = descriptorFixture();
  const action = await actionFixture(2);
  const decision = evaluateActionPolicy({
    toolName: descriptor.name,
    descriptor,
    preparedAction: action,
    principal: "single_agent",
    scopeAllowed: true,
    isDesktop: true,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });

  assert.equal(decision.action, "require_approval");
  assert.equal(decision.requiredConfirmations, 2);
  assert.equal(decision.payloadFingerprint, action.payloadFingerprint);
});

test("high-risk reversible mutations still require exact approval under write autonomy", async () => {
  const descriptor = descriptorFixture();
  descriptor.risk = "high";
  const action = await actionFixture();
  const decision = evaluateActionPolicy({
    toolName: descriptor.name,
    descriptor,
    preparedAction: action,
    principal: "single_agent",
    scopeAllowed: true,
    writeAutonomy: true,
    isDesktop: true,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(decision.action, "require_approval");
  assert.equal(decision.requiredConfirmations, 1);
  assert.equal(decision.payloadFingerprint, action.payloadFingerprint);
});

test("write autonomy cannot authorize external provider mutations", async () => {
  for (const system of ["github", "linear", "browser"] as const) {
    const descriptor: ToolDescriptor = {
      ...descriptorFixture(),
      name: `${system}_create_external_resource`,
      capability: { system, resourceType: "external_resource", action: "create" },
      approval: {
        allowPromptGrant: true,
        allowPersistentGrant: false,
        fallback: "exact",
      },
    };
    const action = await actionForDescriptor(descriptor);
    const decision = evaluateActionPolicy({
      toolName: descriptor.name,
      descriptor,
      preparedAction: action,
      principal: "single_agent",
      scopeAllowed: true,
      writeAutonomy: true,
      isDesktop: true,
      now: new Date("2026-07-11T12:01:00.000Z"),
    });

    assert.equal(decision.action, "require_approval", system);
    assert.equal(decision.requiredConfirmations, 1, system);
  }
});

test("write autonomy still permits a scoped local reversible mutation", async () => {
  const descriptor: ToolDescriptor = {
    ...descriptorFixture(),
    name: "vault_create_note",
    capability: { system: "vault", resourceType: "markdown", action: "create" },
  };
  const action = await actionForDescriptor(descriptor);
  const decision = evaluateActionPolicy({
    toolName: descriptor.name,
    descriptor,
    preparedAction: action,
    principal: "single_agent",
    scopeAllowed: true,
    writeAutonomy: true,
    isDesktop: true,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });

  assert.equal(decision.action, "allow");
  assert.ok(decision.tags.includes("write_autonomy"));
});

test("in-scope descriptor reads do not require a mutation grant", () => {
  const descriptor: ToolDescriptor = {
    ...descriptorFixture(),
    name: "linear_read_issue",
    capability: { system: "linear", resourceType: "issue", action: "read" },
    effect: "read",
    approval: {
      allowPromptGrant: false,
      allowPersistentGrant: false,
      fallback: "none",
    },
    execution: {
      preparation: "none",
      cacheable: true,
      parallelSafe: true,
    },
    durability: {
      journal: false,
      receipt: false,
      readback: "none",
      reconciliation: "none",
    },
  };
  const decision = evaluateActionPolicy({
    toolName: descriptor.name,
    descriptor,
    principal: "researcher",
    scopeAllowed: true,
    isDesktop: true,
  });
  assert.equal(decision.action, "allow");
  assert.ok(decision.tags.includes("read_only"));
});

async function actionFixture(
  requiredConfirmations?: 1 | 2,
): Promise<PreparedAction> {
  return withPreparedActionFingerprint({
    version: 1,
    id: "action-1",
    runId: "run-1",
    toolCallId: "call-1",
    toolName: "linear_create_issue",
    target: {
      system: "linear",
      resourceType: "issue",
      id: "new:call-1",
      teamId: "team-1",
    },
    relatedResources: [],
    normalizedArgs: { title: "Ticket" },
    preview: {
      summary: "Create issue",
      destination: "Linear team team-1",
      outboundPayload: { title: "Ticket" },
      warnings: [],
      outboundBytes: 6,
    },
    ...(requiredConfirmations ? { requiredConfirmations } : {}),
    preparedAt: "2026-07-11T12:00:00.000Z",
    expiresAt: "2026-07-11T12:05:00.000Z",
  });
}

async function actionForDescriptor(
  descriptor: ToolDescriptor,
): Promise<PreparedAction> {
  return withPreparedActionFingerprint({
    version: 1,
    id: `action-${descriptor.capability.system}`,
    runId: "run-1",
    toolCallId: `call-${descriptor.capability.system}`,
    toolName: descriptor.name,
    target: {
      system: descriptor.capability.system,
      resourceType: descriptor.capability.resourceType,
      id: `new:${descriptor.capability.system}`,
    },
    relatedResources: [],
    normalizedArgs: { title: "Resource" },
    preview: {
      summary: "Create resource",
      destination: descriptor.capability.system,
      outboundPayload: { title: "Resource" },
      warnings: [],
      outboundBytes: 8,
    },
    preparedAt: "2026-07-11T12:00:00.000Z",
    expiresAt: "2026-07-11T12:05:00.000Z",
  });
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
  };
}
