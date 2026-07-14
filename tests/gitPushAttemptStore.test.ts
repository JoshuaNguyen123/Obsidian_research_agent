import assert from "node:assert/strict";
import test from "node:test";

import {
  DurableGitPushAttemptStoreV1,
  type GitPushAttemptNamespaceV1,
} from "../src/integrations/github/GitPushAttemptStore";
import type { GitPushAttemptRecordV1 } from "../src/integrations/github/VerifiedGitPushGateway";

const FP = `sha256:${"a".repeat(64)}`;

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

function attempt(): GitPushAttemptRecordV1 {
  return {
    version: 1,
    id: "git-push-attempt-1",
    revision: 0,
    handoffFingerprint: FP,
    bindingFingerprint: FP,
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

function clone<T>(value: T): T {
  return value === null ? value : JSON.parse(JSON.stringify(value)) as T;
}
