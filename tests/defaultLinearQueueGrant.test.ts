import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LINEAR_QUEUE_GRANT_LIMITS,
  DEFAULT_LINEAR_QUEUE_GRANT_TTL_MS,
  createBoundedGrant,
  createDefaultLinearQueueGrant,
  linearQueueGrantSubjectId,
  matchDefaultLinearQueueGrant,
} from "../src/agent/authority";

const ISSUED_AT = new Date("2026-07-11T12:00:00.000Z");
const PROJECT_ID = "project-queue";

test("default queue grant is explicit, project-scoped, four-hour, and class-bounded", async () => {
  await assert.rejects(
    createDefaultLinearQueueGrant({
      id: "grant-queue",
      queueProjectId: PROJECT_ID,
      userApproved: false as true,
      issuedAt: ISSUED_AT,
    }),
    /explicit user approval/,
  );

  const grant = await queueGrant();
  assert.equal(grant.kind, "scheduled_bounded");
  assert.equal(grant.issuer, "user_approval");
  assert.deepEqual(grant.subject, {
    type: "schedule",
    id: linearQueueGrantSubjectId(PROJECT_ID),
  });
  assert.equal(
    Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt),
    DEFAULT_LINEAR_QUEUE_GRANT_TTL_MS,
  );
  assert.deepEqual(grant.limits, DEFAULT_LINEAR_QUEUE_GRANT_LIMITS);
  assert.equal(grant.limits.maxDeletes, 0);
  assert.deepEqual(grant.rules, [
    {
      system: "linear",
      resourceTypes: ["issue"],
      actions: ["update"],
      selector: { projectIds: [PROJECT_ID] },
    },
    {
      system: "linear",
      resourceTypes: ["comment"],
      actions: ["create"],
      selector: { projectIds: [PROJECT_ID] },
    },
    {
      system: "vault",
      resourceTypes: ["markdown"],
      actions: ["create", "append"],
      selector: { pathPrefixes: ["Research/Queue", "Projects/Linear"] },
    },
    {
      system: "git",
      resourceTypes: ["repository"],
      actions: ["validate", "commit", "integrate", "promote"],
      selector: { repositoryProfileIds: ["research-agent", "companion"] },
    },
  ]);

  const research = await matchDefaultLinearQueueGrant({
    grant,
    queueProjectId: PROJECT_ID,
    executionClass: "research",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(research.matched, true);

  const vault = await matchDefaultLinearQueueGrant({
    grant,
    queueProjectId: PROJECT_ID,
    executionClass: "vault",
    trustedVaultPath: "Research/Queue/result.md",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(vault.matched, true);

  const code = await matchDefaultLinearQueueGrant({
    grant,
    queueProjectId: PROJECT_ID,
    executionClass: "code",
    repositoryProfileId: "research-agent",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(code.matched, true);
});

test("queue grant matcher rejects expiry and non-active state", async () => {
  const grant = await queueGrant();
  const expired = await matchDefaultLinearQueueGrant({
    grant,
    queueProjectId: PROJECT_ID,
    executionClass: "research",
    now: new Date(grant.expiresAt),
  });
  assert.equal(expired.matched, false);
  if (!expired.matched) assert.equal(expired.reason, "expired");

  const exhausted = structuredClone(grant);
  exhausted.state = "exhausted";
  const inactive = await matchDefaultLinearQueueGrant({
    grant: exhausted,
    queueProjectId: PROJECT_ID,
    executionClass: "research",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(inactive.matched, false);
  if (!inactive.matched) assert.equal(inactive.reason, "inactive");
});

test("queue grant matcher rejects fingerprint tampering", async () => {
  const grant = await queueGrant();
  const tampered = structuredClone(grant);
  tampered.rules[0].selector.projectIds = ["project-other"];

  const result = await matchDefaultLinearQueueGrant({
    grant: tampered,
    queueProjectId: PROJECT_ID,
    executionClass: "research",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(result.matched, false);
  if (!result.matched) assert.equal(result.reason, "invalid_fingerprint");
});

test("queue grant matcher rejects exhausted or invalid operation budgets", async () => {
  const grant = await queueGrant();
  const exhausted = structuredClone(grant);
  exhausted.usage.externalMutations = exhausted.limits.maxExternalMutations;

  const result = await matchDefaultLinearQueueGrant({
    grant: exhausted,
    queueProjectId: PROJECT_ID,
    executionClass: "research",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(result.matched, false);
  if (!result.matched) {
    assert.equal(result.reason, "budget_exhausted");
    assert.match(result.detail, /maxExternalMutations/);
  }

  const invalid = structuredClone(grant);
  invalid.usage.deletes = 1;
  const invalidResult = await matchDefaultLinearQueueGrant({
    grant: invalid,
    queueProjectId: PROJECT_ID,
    executionClass: "research",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(invalidResult.matched, false);
  if (!invalidResult.matched) assert.equal(invalidResult.reason, "invalid_budget");
});

test("queue grant matcher requires all four Linear lifecycle mutations", async () => {
  const grant = await queueGrant();
  const onlyThreeExternalMutationsRemain = structuredClone(grant);
  onlyThreeExternalMutationsRemain.usage.externalMutations =
    onlyThreeExternalMutationsRemain.limits.maxExternalMutations - 3;

  const result = await matchDefaultLinearQueueGrant({
    grant: onlyThreeExternalMutationsRemain,
    queueProjectId: PROJECT_ID,
    executionClass: "research",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(result.matched, false);
  if (!result.matched) {
    assert.equal(result.reason, "budget_exhausted");
    assert.match(result.detail, /maxExternalMutations/);
  }
});

test("queue grant matcher fails closed on class and trusted resource mismatch", async () => {
  const grant = await queueGrant();

  const outsideVault = await matchDefaultLinearQueueGrant({
    grant,
    queueProjectId: PROJECT_ID,
    executionClass: "vault",
    trustedVaultPath: "Research/Queue2/result.md",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(outsideVault.matched, false);
  if (!outsideVault.matched) {
    assert.equal(outsideVault.reason, "vault_scope_not_covered");
  }

  const unknownRepository = await matchDefaultLinearQueueGrant({
    grant,
    queueProjectId: PROJECT_ID,
    executionClass: "code",
    repositoryProfileId: "other-repository",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(unknownRepository.matched, false);
  if (!unknownRepository.matched) {
    assert.equal(unknownRepository.reason, "repository_scope_not_covered");
  }

  const otherProject = await matchDefaultLinearQueueGrant({
    grant,
    queueProjectId: "project-other",
    executionClass: "research",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(otherProject.matched, false);
  if (!otherProject.matched) assert.equal(otherProject.reason, "subject_mismatch");

  const human = await matchDefaultLinearQueueGrant({
    grant,
    queueProjectId: PROJECT_ID,
    executionClass: "human",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(human.matched, false);
  if (!human.matched) assert.equal(human.reason, "human_execution");
});

test("default grant excludes destructive Linear operations and rejects signed expansion", async () => {
  const grant = await queueGrant();
  const actions = grant.rules.flatMap((rule) => rule.actions);
  for (const forbidden of ["archive", "trash", "delete"] as const) {
    assert.equal(actions.includes(forbidden), false);
  }

  const overbroad = await createBoundedGrant({
    id: "grant-overbroad",
    kind: "scheduled_bounded",
    subject: {
      type: "schedule",
      id: linearQueueGrantSubjectId(PROJECT_ID),
    },
    issuer: "user_approval",
    rules: [
      ...grant.rules,
      {
        system: "linear",
        resourceTypes: ["issue"],
        actions: ["delete"],
        selector: { projectIds: [PROJECT_ID] },
      },
    ],
    limits: { ...DEFAULT_LINEAR_QUEUE_GRANT_LIMITS },
    issuedAt: ISSUED_AT,
    expiresAt: new Date(ISSUED_AT.getTime() + DEFAULT_LINEAR_QUEUE_GRANT_TTL_MS),
  });
  const result = await matchDefaultLinearQueueGrant({
    grant: overbroad,
    queueProjectId: PROJECT_ID,
    executionClass: "research",
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(result.matched, false);
  if (!result.matched) assert.equal(result.reason, "unsafe_rule");
});

async function queueGrant() {
  return createDefaultLinearQueueGrant({
    id: "grant-queue",
    queueProjectId: PROJECT_ID,
    userApproved: true,
    trustedVaultPathPrefixes: ["Research/Queue", "Projects/Linear"],
    repositoryProfileIds: ["research-agent", "companion"],
    issuedAt: ISSUED_AT,
  });
}
