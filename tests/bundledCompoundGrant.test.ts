import test from "node:test";
import assert from "node:assert/strict";
import {
  withPreparedActionFingerprint,
  type PreparedAction,
  type ToolDescriptor,
} from "../src/agent/actions";
import {
  BUNDLED_COMPOUND_AUTHORITY_GRANT_LIMITS,
  createBundledCompoundAuthorityGrant,
  evaluateAuthorityGrant,
  revokeAuthorityGrant,
} from "../src/agent/authority";
import type { BundledApprovalPreviewV1 } from "../src/agent/bundledApprovalPreview";

test("mints a run_bounded grant covering approved families with concrete selectors", async () => {
  const grant = await createBundledCompoundAuthorityGrant({
    id: "grant-bundle-1",
    preview: previewFixture(["linear_publish", "github_publish", "vault_replace"]),
    userApproved: true,
    teamId: "team-1",
    repositoryProfileId: "profile-1",
    trustedVaultPathPrefixes: ["Notes/Research"],
    issuedAt: new Date("2026-07-11T12:00:00.000Z"),
  });
  assert.ok(grant);
  assert.equal(grant.kind, "run_bounded");
  assert.equal(grant.issuer, "user_approval");
  assert.deepEqual(grant.subject, { type: "run", id: "run-1" });
  assert.equal(grant.expiresAt, previewFixture([]).expiresAt);
  assert.equal(grant.rules.length, 3);
  // Hard / delete actions are never included in bundled rules, and the
  // default limits refuse deletes outright even if a rule ever carried one.
  for (const rule of grant.rules) {
    assert.ok(!rule.actions.includes("delete"), `${rule.system} rule must not carry delete`);
  }
  assert.equal(grant.limits.maxDeletes, 0);
  assert.deepEqual(grant.limits, { ...BUNDLED_COMPOUND_AUTHORITY_GRANT_LIMITS });
});

test("returns null while no concrete external selector is available yet", async () => {
  // Families approved but the host has not resolved a team, repository
  // profile, or trusted prefix: the caller keeps BundledStageGrantV1 only.
  const withoutSelectors = await createBundledCompoundAuthorityGrant({
    id: "grant-bundle-2",
    preview: previewFixture(["linear_publish", "github_publish", "vault_replace"]),
    userApproved: true,
  });
  assert.equal(withoutSelectors, null);

  // Selectors resolved but none of their families were approved: the
  // selector alone must never manufacture a rule.
  const withoutFamilies = await createBundledCompoundAuthorityGrant({
    id: "grant-bundle-3",
    preview: previewFixture(["code_workspace", "code_validate"]),
    userApproved: true,
    teamId: "team-1",
    repositoryProfileId: "profile-1",
    trustedVaultPathPrefixes: ["Notes/Research"],
  });
  assert.equal(withoutFamilies, null);
});

test("requires the literal user approval flag at runtime", async () => {
  await assert.rejects(
    createBundledCompoundAuthorityGrant({
      id: "grant-bundle-4",
      preview: previewFixture(["linear_publish"]),
      userApproved: false as unknown as true,
      teamId: "team-1",
    }),
    /explicit user approval/,
  );
});

test("vault path prefixes are normalized, deduplicated, and enforced at evaluation", async () => {
  const grant = await createBundledCompoundAuthorityGrant({
    id: "grant-bundle-5",
    preview: previewFixture(["vault_replace"]),
    userApproved: true,
    // Backslashes, trailing separators, and duplicates must collapse to one
    // canonical prefix; evaluation normalizes the action path the same way.
    trustedVaultPathPrefixes: ["Notes\\Research\\", "Notes/Research", "  "],
    issuedAt: new Date("2026-07-11T12:00:00.000Z"),
  });
  assert.ok(grant);
  const vaultRule = grant.rules.find((rule) => rule.system === "vault");
  assert.ok(vaultRule);
  assert.deepEqual(vaultRule.selector.pathPrefixes, ["Notes/Research"]);

  const descriptor = vaultDescriptorFixture();
  const inside = await evaluateAuthorityGrant({
    grant,
    action: await vaultActionFixture("Notes\\Research\\sub\\note.md"),
    descriptor,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(inside.allowed, true);

  const outside = await evaluateAuthorityGrant({
    grant,
    action: await vaultActionFixture("Other/note.md"),
    descriptor,
    now: new Date("2026-07-11T12:01:00.000Z"),
  });
  assert.equal(outside.allowed, false);
  if (!outside.allowed) assert.match(outside.reason, /outside the authority grant scope/);
});

test("revoked grants deny evaluation with the revoked state named", async () => {
  const grant = await createBundledCompoundAuthorityGrant({
    id: "grant-bundle-6",
    preview: previewFixture(["vault_replace"]),
    userApproved: true,
    trustedVaultPathPrefixes: ["Notes/Research"],
    issuedAt: new Date("2026-07-11T12:00:00.000Z"),
  });
  assert.ok(grant);
  const revoked = revokeAuthorityGrant(grant, new Date("2026-07-11T12:02:00.000Z"));
  assert.equal(revoked.state, "revoked");
  assert.equal(revoked.revokedAt, "2026-07-11T12:02:00.000Z");

  const evaluation = await evaluateAuthorityGrant({
    grant: revoked,
    action: await vaultActionFixture("Notes/Research/note.md"),
    descriptor: vaultDescriptorFixture(),
    now: new Date("2026-07-11T12:03:00.000Z"),
  });
  assert.equal(evaluation.allowed, false);
  if (!evaluation.allowed) assert.match(evaluation.reason, /revoked/);
});

function previewFixture(
  familyIds: Array<
    | "linear_publish"
    | "linear_issues"
    | "code_workspace"
    | "code_validate"
    | "code_commit"
    | "github_publish"
    | "vault_replace"
  >,
): BundledApprovalPreviewV1 {
  return {
    version: 1,
    runId: "run-1",
    bundleFingerprint: "bundle-fp",
    items: familyIds.map((familyId, index) => ({
      toolName: `tool-${familyId}`,
      stage: "accepted_research",
      effectClass: "bound",
      familyId,
      familyFingerprint: `family-fp-${index}`,
      system: familyId.startsWith("linear")
        ? "linear"
        : familyId.startsWith("github")
          ? "github"
          : familyId.startsWith("code")
            ? "workspace"
            : "vault",
      summary: `Bound ${familyId} step`,
    })),
    familyFingerprints: familyIds.map((_, index) => `family-fp-${index}`),
    stages: ["accepted_research"],
    hardExcluded: [],
    createdAt: "2026-07-11T11:59:00.000Z",
    expiresAt: "2026-07-11T12:30:00.000Z",
  };
}

async function vaultActionFixture(path: string): Promise<PreparedAction> {
  return withPreparedActionFingerprint({
    version: 1,
    id: `action-${path}`,
    runId: "run-1",
    toolCallId: `call-${path}`,
    toolName: "replace_current_file",
    target: {
      system: "vault",
      resourceType: "markdown_file",
      id: path,
      path,
    },
    relatedResources: [],
    normalizedArgs: { path },
    preview: {
      summary: "Replace note",
      destination: path,
      outboundPayload: { path },
      warnings: [],
      outboundBytes: 12,
    },
    idempotencyKey: `run-1:${path}`,
    preparedAt: "2026-07-11T12:00:00.000Z",
    expiresAt: "2026-07-11T12:05:00.000Z",
  });
}

function vaultDescriptorFixture(): ToolDescriptor {
  return {
    version: 1,
    name: "replace_current_file",
    capability: { system: "vault", resourceType: "markdown_file", action: "replace" },
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
