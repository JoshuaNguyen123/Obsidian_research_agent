import test from "node:test";
import assert from "node:assert/strict";
import {
  withPreparedActionFingerprint,
  type PreparedAction,
  type ToolDescriptor,
} from "../src/agent/actions";
import {
  consumeAuthorityGrant,
  createBoundedGrant,
  createOneShotGrant,
  evaluateAuthorityGrant,
} from "../src/agent/authority";

test("one-shot grants bind to one exact action and exhaust on consumption", async () => {
  const descriptor = descriptorFixture();
  const action = await actionFixture();
  const grant = await createOneShotGrant({
    id: "grant-one-shot",
    action,
    descriptor,
    issuedAt: new Date("2026-07-11T12:00:00.000Z"),
  });

  const allowed = await evaluateAuthorityGrant({
    grant,
    action,
    descriptor,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(allowed.allowed, true);

  const consumed = await consumeAuthorityGrant({
    grant,
    action,
    descriptor,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(consumed.allowed, true);
  if (!consumed.allowed) return;
  assert.equal(consumed.grant.usage.actions, 1);
  assert.equal(consumed.grant.usage.externalMutations, 1);
  assert.equal(consumed.grant.usage.creates, 1);
  assert.equal(consumed.grant.state, "exhausted");

  const reused = await evaluateAuthorityGrant({
    grant: consumed.grant,
    action,
    descriptor,
    now: new Date("2026-07-11T12:01:01.000Z"),
  });
  assert.equal(reused.allowed, false);
  if (!reused.allowed) assert.match(reused.reason, /exhausted/);
});

test("bounded grants enforce selectors and cumulative limits", async () => {
  const descriptor = descriptorFixture();
  const firstAction = await actionFixture({ id: "action-1", teamId: "team-1" });
  const grant = await createBoundedGrant({
    id: "grant-run",
    kind: "run_bounded",
    subject: { type: "run", id: "run-1" },
    rules: [
      {
        system: "linear",
        resourceTypes: ["issue"],
        actions: ["create"],
        selector: { teamIds: ["team-1"] },
      },
    ],
    limits: {
      maxActions: 2,
      maxExternalMutations: 2,
      maxCreates: 2,
      maxDeletes: 0,
      maxOutboundBytes: 12,
    },
    issuedAt: new Date("2026-07-11T12:00:00.000Z"),
    expiresAt: new Date("2026-07-11T12:10:00.000Z"),
  });
  const consumed = await consumeAuthorityGrant({
    grant,
    action: firstAction,
    descriptor,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(consumed.allowed, true);
  if (!consumed.allowed) return;

  const outsideTeam = await actionFixture({ id: "action-2", teamId: "team-2" });
  const outside = await evaluateAuthorityGrant({
    grant: consumed.grant,
    action: outsideTeam,
    descriptor,
    now: new Date("2026-07-11T12:02:00.000Z"),
  });
  assert.equal(outside.allowed, false);
  if (!outside.allowed) assert.match(outside.reason, /outside/);

  const tooLarge = await actionFixture({
    id: "action-3",
    teamId: "team-1",
    outboundBytes: 7,
  });
  const overLimit = await evaluateAuthorityGrant({
    grant: consumed.grant,
    action: tooLarge,
    descriptor,
    now: new Date("2026-07-11T12:02:00.000Z"),
  });
  assert.equal(overLimit.allowed, false);
  if (!overLimit.allowed) assert.match(overLimit.reason, /maxOutboundBytes/);
});

test("authority evaluation rejects expired and tampered grants", async () => {
  const descriptor = descriptorFixture();
  const action = await actionFixture();
  const grant = await createBoundedGrant({
    id: "grant-run",
    kind: "run_bounded",
    subject: { type: "run", id: "run-1" },
    rules: [
      {
        system: "linear",
        resourceTypes: ["issue"],
        actions: ["create"],
        selector: { teamIds: ["team-1"] },
      },
    ],
    limits: {
      maxActions: 3,
      maxExternalMutations: 3,
      maxCreates: 3,
      maxDeletes: 0,
      maxOutboundBytes: 100,
    },
    issuedAt: new Date("2026-07-11T12:00:00.000Z"),
    expiresAt: new Date("2026-07-11T12:02:00.000Z"),
  });

  const expired = await evaluateAuthorityGrant({
    grant,
    action,
    descriptor,
    now: new Date("2026-07-11T12:03:00.000Z"),
  });
  assert.equal(expired.allowed, false);
  if (!expired.allowed) assert.match(expired.reason, /expired/);

  const tampered = structuredClone(grant);
  tampered.rules[0].selector.teamIds = ["team-2"];
  const invalid = await evaluateAuthorityGrant({
    grant: tampered,
    action,
    descriptor,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(invalid.allowed, false);
  if (!invalid.allowed) assert.match(invalid.reason, /fingerprint/);
});

test("broad external mutation grants are rejected at creation", async () => {
  await assert.rejects(
    createBoundedGrant({
      id: "grant-too-broad",
      kind: "run_bounded",
      subject: { type: "run", id: "run-1" },
      rules: [
        {
          system: "linear",
          resourceTypes: ["issue"],
          actions: ["create"],
          selector: {},
        },
      ],
      limits: {
        maxActions: 10,
        maxExternalMutations: 10,
        maxCreates: 10,
        maxDeletes: 0,
        maxOutboundBytes: 10_000,
      },
    }),
    /bounded selector/,
  );
});

test("one-shot grants respect the tool descriptor approval contract", async () => {
  const descriptor = descriptorFixture();
  descriptor.approval.allowPromptGrant = false;
  await assert.rejects(
    createOneShotGrant({
      id: "grant-disallowed",
      action: await actionFixture(),
      descriptor,
    }),
    /does not permit one-shot/,
  );
});

async function actionFixture(
  options: { id?: string; teamId?: string; outboundBytes?: number } = {},
): Promise<PreparedAction> {
  const id = options.id ?? "action-1";
  return withPreparedActionFingerprint({
    version: 1,
    id,
    runId: "run-1",
    toolCallId: `call-${id}`,
    toolName: "linear_create_issue",
    target: {
      system: "linear",
      resourceType: "issue",
      id: `new:${id}`,
      teamId: options.teamId ?? "team-1",
    },
    relatedResources: [],
    normalizedArgs: { title: `Ticket ${id}` },
    preview: {
      summary: "Create issue",
      destination: `Linear team ${options.teamId ?? "team-1"}`,
      outboundPayload: { title: `Ticket ${id}` },
      warnings: [],
      outboundBytes: options.outboundBytes ?? 6,
    },
    idempotencyKey: `run-1:${id}`,
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
