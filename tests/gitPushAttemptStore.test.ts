import assert from "node:assert/strict";
import test from "node:test";

import {
  commitGitPushAttemptNamespaceAfterVerifiedWriteV1,
  DurableGitPushAttemptStoreV1,
  parseGitPushAttemptNamespaceV1,
  type GitPushAttemptNamespaceV1,
} from "../src/integrations/github/GitPushAttemptStore";
import type {
  GitPushAttemptRecordV1,
  VerifiedGitPushReceiptV1,
} from "../src/integrations/github/VerifiedGitPushGateway";
import { fingerprintContract } from "../src/integrations/linear/LinearContractSupport";

const FP = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;

test("durable Git push attempts use CAS and retain ambiguous dispatch for readback", async () => {
  let namespace: GitPushAttemptNamespaceV1 | null = null;
  const store = new DurableGitPushAttemptStoreV1({
    async read() { return clone(namespace); },
    async write(next, expectedRevision) {
      assert.equal(expectedRevision, namespace?.revision ?? 0);
      namespace = clone(next);
      return true;
    },
  });
  const first = attempt();
  assert.equal(await store.save(first, null), true);
  assert.equal(await store.save({
    ...first,
    revision: 1,
    status: "reconcile_required",
    updatedAt: "2026-07-12T12:00:01.000Z",
    diagnostic: "Remote readback was unavailable.",
  }, 0), true);
  assert.equal((await store.load(first.id))?.status, "reconcile_required");
});

test("durable Git push attempts reject credentials and immutable binding drift", async () => {
  let namespace: GitPushAttemptNamespaceV1 | null = null;
  const store = new DurableGitPushAttemptStoreV1({
    async read() { return clone(namespace); },
    async write(next) { namespace = clone(next); return true; },
  });
  const first = attempt();
  await store.save(first, null);
  await assert.rejects(store.save({
    ...first,
    revision: 1,
    diagnostic: `Bearer ${"x".repeat(32)}`,
    updatedAt: "2026-07-12T12:00:01.000Z",
  }, 0), /credential material/i);
  await assert.rejects(store.save({
    ...first,
    revision: 1,
    bindingFingerprint: `sha256:${"b".repeat(64)}`,
    updatedAt: "2026-07-12T12:00:01.000Z",
  }, 0), /immutable/i);
});

test("failed durable save does not advance the cache and the same write may retry", async () => {
  let cached = parseGitPushAttemptNamespaceV1(null);
  let durable: GitPushAttemptNamespaceV1 | null = null;
  let failSave = true;
  const persistence = {
    async read() { return clone(durable); },
    async write(next: GitPushAttemptNamespaceV1, expectedRevision: number) {
      return commitGitPushAttemptNamespaceAfterVerifiedWriteV1({
        readCached: () => cached,
        async writeAndReadback(candidate, expected) {
          assert.equal(expected, expectedRevision);
          assert.equal(durable?.revision ?? 0, expected);
          if (failSave) throw new Error("simulated saveData failure");
          durable = clone(candidate);
          return clone(durable);
        },
        commitCached(namespace) { cached = clone(namespace); },
      }, next, expectedRevision);
    },
  };
  const store = new DurableGitPushAttemptStoreV1(persistence);
  const first = attempt();

  await assert.rejects(store.save(first, null), /simulated saveData failure/);
  assert.equal(cached.revision, 0);
  assert.equal(durable, null);

  failSave = false;
  assert.equal(await store.save(first, null), true);
  assert.equal(cached.revision, 1);
  assert.equal((await store.load(first.id))?.status, "dispatching");
});

test("durable attempt save rejects a success boolean without exact persisted readback", async () => {
  const store = new DurableGitPushAttemptStoreV1({
    async read() { return null; },
    async write() { return true; },
  });
  await assert.rejects(
    store.save(attempt(), null),
    /exact written namespace/i,
  );
  assert.equal(await store.load(attempt().id), null);
});

test("verified receipts are closed and cannot be swapped between attempts", () => {
  const first = verifiedAttempt({
    id: "git-push-attempt-a",
    handoffFingerprint: FP,
    bindingFingerprint: FP,
    visibilityBindingFingerprint: FP,
    visibilityAttestationFingerprint: FP,
    repositoryReadbackFingerprint: FP,
    branch: "codex/eng-12",
    expectedCommitSha: "a".repeat(40),
  });
  const second = verifiedAttempt({
    id: "git-push-attempt-b",
    handoffFingerprint: FP_B,
    bindingFingerprint: FP_B,
    visibilityBindingFingerprint: FP_B,
    visibilityAttestationFingerprint: FP_B,
    repositoryReadbackFingerprint: FP_B,
    branch: "codex/eng-13",
    expectedCommitSha: "b".repeat(40),
  });
  assert.throws(
    () => parseGitPushAttemptNamespaceV1({
      version: 1,
      revision: 2,
      attempts: {
        [first.id]: { ...first, receipt: second.receipt },
        [second.id]: second,
      },
    }),
    /does not match its containing attempt/i,
  );
  assert.throws(
    () => parseGitPushAttemptNamespaceV1({
      version: 1,
      revision: 1,
      attempts: {
        [first.id]: {
          ...first,
          receipt: { ...first.receipt, unexpected: true },
        },
      },
    }),
    /receipt keys are invalid/i,
  );
});

function attempt(): GitPushAttemptRecordV1 {
  return {
    version: 1,
    id: "git-push-attempt-1",
    revision: 0,
    handoffFingerprint: FP,
    bindingFingerprint: FP,
    visibilityBindingFingerprint: FP,
    visibilityAttestationFingerprint: FP,
    repositoryReadbackFingerprint: FP,
    expectedVisibility: "private",
    retryHistory: [],
    branch: "codex/eng-12",
    remoteUrl: "https://github.com/acme/research-agent.git",
    beforeRemoteSha: null,
    expectedCommitSha: "a".repeat(40),
    status: "dispatching",
    dispatchCount: 1,
    reconciliationKey: "github-ref:acme/research-agent:refs/heads/codex/eng-12",
    startedAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:00:00.000Z",
    receipt: null,
    diagnostic: null,
  };
}

function verifiedAttempt(
  identity: Pick<
    GitPushAttemptRecordV1,
    | "id"
    | "handoffFingerprint"
    | "bindingFingerprint"
    | "visibilityBindingFingerprint"
    | "visibilityAttestationFingerprint"
    | "repositoryReadbackFingerprint"
    | "branch"
    | "expectedCommitSha"
  >,
): GitPushAttemptRecordV1 {
  const base: GitPushAttemptRecordV1 = {
    ...attempt(),
    ...identity,
    revision: 1,
    status: "verified",
    updatedAt: "2026-07-12T12:00:01.000Z",
  };
  const evidence: Omit<VerifiedGitPushReceiptV1, "fingerprint"> = {
    version: 1,
    kind: "verified_git_push",
    id: `github-push-${fingerprintContract({
      handoff: base.handoffFingerprint,
      visibilityBinding: base.visibilityBindingFingerprint,
      expectedVisibility: base.expectedVisibility,
    }).slice("sha256:".length, "sha256:".length + 32)}`,
    status: "verified",
    commitKind: "committed",
    handoffId: `handoff-${base.id.slice(-1)}`,
    handoffFingerprint: base.handoffFingerprint,
    repositoryBindingKey: "github:acme/research-agent",
    repositoryBindingFingerprint: base.bindingFingerprint,
    repositoryVisibility: base.expectedVisibility,
    repositoryVisibilityBindingFingerprint:
      base.visibilityBindingFingerprint,
    repositoryVisibilityAttestationFingerprint:
      base.visibilityAttestationFingerprint,
    repositoryReadbackFingerprint: base.repositoryReadbackFingerprint,
    repositoryProfileKey: "repository-profile:research-agent",
    repositoryProfileFingerprint: FP,
    canonicalWorktreeRoot: "C:\\work\\research-agent",
    canonicalWorktreeFingerprint: FP,
    remoteUrl: base.remoteUrl,
    branch: base.branch,
    baseBranch: "main",
    beforeRemoteSha: base.beforeRemoteSha,
    remoteSha: base.expectedCommitSha,
    baseSha: "c".repeat(40),
    parentSha: "c".repeat(40),
    commitSha: base.expectedCommitSha,
    treeSha: "d".repeat(40),
    diffFingerprint: FP,
    artifactFingerprint: FP,
    localCommitReceiptId: "local-commit-receipt-1",
    localCommitReceiptFingerprint: FP,
    targetedValidationReceiptId: "targeted-validation-1",
    fullValidationReceiptId: "full-validation-1",
    targetedValidationFingerprint: FP,
    fullValidationFingerprint: FP,
    pushedAt: "2026-07-12T12:00:00.500Z",
    verifiedAt: base.updatedAt,
  };
  return {
    ...base,
    receipt: { ...evidence, fingerprint: fingerprintContract(evidence) },
  };
}

function clone<T>(value: T): T {
  return value === null ? value : JSON.parse(JSON.stringify(value)) as T;
}
