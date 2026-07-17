import assert from "node:assert/strict";
import test from "node:test";

import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import { createTrustedGitHubRepositoryBindingV1 } from "../src/integrations/github/TrustedGitHubRepositoryBindingV1";
import {
  assertFreshPrivateGitHubRepositoryBindingV2,
  assertGitHubApprovalBindingFreshV2,
  createTrustedGitHubRepositoryBindingV2,
  parseTrustedGitHubRepositoryBindingV2,
  upgradeTrustedGitHubRepositoryBindingV1ToV2,
} from "../src/integrations/github/TrustedGitHubRepositoryBindingV2";

const OBSERVED_AT = "2026-07-16T15:00:00.000Z";

test("TrustedGitHubRepositoryBindingV2 binds exact private readback and excludes volatile observation time from identity", () => {
  const profile = profileFixture();
  const first = createTrustedGitHubRepositoryBindingV2({
    key: "github-fixture",
    profile,
    owner: "acme",
    repository: "private-agent",
    repositoryReadback: repositoryFixture(true),
    observedAt: OBSERVED_AT,
    verifiedAccountId: 202,
    verifiedAccountLogin: "agent-owner",
    trustedAt: "2026-07-16T14:00:00.000Z",
  });
  const later = createTrustedGitHubRepositoryBindingV2({
    key: "github-fixture",
    profile,
    owner: "acme",
    repository: "private-agent",
    repositoryReadback: repositoryFixture(true),
    observedAt: "2026-07-16T15:01:00.000Z",
    verifiedAccountId: 202,
    verifiedAccountLogin: "agent-owner",
    trustedAt: "2026-07-16T14:30:00.000Z",
  });
  assert.equal(first.visibility, "private");
  assert.equal(first.fingerprint, later.fingerprint);
  assert.deepEqual(parseTrustedGitHubRepositoryBindingV2(first), first);
  assert.throws(() => createTrustedGitHubRepositoryBindingV2({
    key: "github-fixture",
    profile,
    owner: "acme",
    repository: "private-agent",
    repositoryReadback: repositoryFixture(false),
    observedAt: OBSERVED_AT,
    verifiedAccountId: 202,
    verifiedAccountLogin: "agent-owner",
    trustedAt: "2026-07-16T14:00:00.000Z",
  }), /not the exact active private repository/u);
});

test("legacy binding upgrades only through a fresh exact private provider readback", () => {
  const profile = profileFixture();
  const legacy = createTrustedGitHubRepositoryBindingV1({
    key: "github-fixture",
    profile,
    owner: "acme",
    repository: "private-agent",
    repositoryId: 101,
    verifiedAccountId: 202,
    verifiedAccountLogin: "agent-owner",
    trustedAt: "2026-07-16T14:00:00.000Z",
  });
  const upgraded = upgradeTrustedGitHubRepositoryBindingV1ToV2({
    binding: legacy,
    repositoryReadback: repositoryFixture(true),
    observedAt: OBSERVED_AT,
  });
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.repositoryId, legacy.repositoryId);
  assert.throws(() => upgradeTrustedGitHubRepositoryBindingV1ToV2({
    binding: legacy,
    repositoryReadback: { ...repositoryFixture(true), id: 999 },
    observedAt: OBSERVED_AT,
  }), /ID does not match/u);
});

test("publication approval rejects stale visibility and legacy binding fingerprints", () => {
  const binding = createTrustedGitHubRepositoryBindingV2({
    key: "github-fixture",
    profile: profileFixture(),
    owner: "acme",
    repository: "private-agent",
    repositoryReadback: repositoryFixture(true),
    observedAt: OBSERVED_AT,
    verifiedAccountId: 202,
    verifiedAccountLogin: "agent-owner",
    trustedAt: "2026-07-16T14:00:00.000Z",
  });
  assert.equal(
    assertFreshPrivateGitHubRepositoryBindingV2(binding, {
      now: new Date("2026-07-16T15:04:00.000Z"),
    }).fingerprint,
    binding.fingerprint,
  );
  assert.throws(() => assertFreshPrivateGitHubRepositoryBindingV2(binding, {
    now: new Date("2026-07-16T15:06:00.000Z"),
  }), /stale/u);
  assert.throws(() => assertGitHubApprovalBindingFreshV2({
    binding,
    approvedBindingFingerprint: `sha256:${"f".repeat(64)}`,
    preparedAt: "2026-07-16T15:01:00.000Z",
    now: new Date("2026-07-16T15:02:00.000Z"),
  }), /different or legacy/u);
});

function profileFixture() {
  return detectRepositoryProfileV2({
    key: "fixture",
    displayName: "Fixture",
    repositoryRoot: "C:\\repos\\fixture",
    defaultBranch: "main",
    files: ["package.json", "package-lock.json"],
    requiredGitHubChecks: ["ci"],
  });
}

function repositoryFixture(privateVisibility: boolean) {
  return {
    id: 101,
    fullName: "acme/private-agent",
    htmlUrl: "https://github.com/acme/private-agent",
    defaultBranch: "main",
    private: privateVisibility,
    archived: false,
  };
}
