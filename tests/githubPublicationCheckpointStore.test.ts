import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubPublicationCheckpointStoreV1,
  parseGitHubPublicationCheckpointV1,
  type GitHubPublicationCheckpointNamespaceV1,
} from "../src/integrations/github/GitHubPublicationCheckpointStore";
import type { GitHubPublicationCheckpointV1 } from "../src/integrations/github/GitHubPublicationWorkflow";

const FP = `sha256:${"a".repeat(64)}`;
const SHA = "a".repeat(40);

test("GitHub checkpoint store serializes CAS updates and preserves receipts", async () => {
  let namespace: GitHubPublicationCheckpointNamespaceV1 | null = null;
  const store = new GitHubPublicationCheckpointStoreV1({
    async read() {
      return clone(namespace);
    },
    async write(next, expectedRevision) {
      assert.equal(expectedRevision, namespace?.revision ?? 0);
      namespace = clone(next);
    },
  });
  const first = checkpoint();
  await store.persist(first);
  await store.persist({
    ...first,
    status: "push_prepared",
    updatedAt: "2026-07-12T12:00:01.000Z",
    publishApprovalFingerprint: FP,
  });

  assert.equal((await store.get(first.publicationId))?.status, "push_prepared");
  assert.equal(
    (namespace as unknown as GitHubPublicationCheckpointNamespaceV1).revision,
    2,
  );
});

test("GitHub checkpoint store rejects credential persistence and lineage regression", async () => {
  let namespace: GitHubPublicationCheckpointNamespaceV1 | null = null;
  const store = new GitHubPublicationCheckpointStoreV1({
    async read() {
      return clone(namespace);
    },
    async write(next) {
      namespace = clone(next);
    },
  });
  const first = checkpoint();
  await store.persist(first);
  await assert.rejects(
    store.persist({
      ...first,
      status: "blocked",
      updatedAt: "2026-07-12T12:00:01.000Z",
      blocker: { code: "blocked", message: `Bearer ${"x".repeat(32)}` },
    }),
    /credential|secret/i,
  );
  await store.persist({
    ...first,
    status: "pushed_verified",
    updatedAt: "2026-07-12T12:00:02.000Z",
    remoteSha: SHA,
    receiptIds: ["receipt-push"],
  });
  await assert.rejects(
    store.persist({
      ...first,
      status: "push_prepared",
      updatedAt: "2026-07-12T12:00:03.000Z",
    }),
    /append-only/i,
  );
});

test("pre-merge checkpoints migrate an absent merge SHA to explicit null", () => {
  const legacy = clone(checkpoint()) as unknown as Record<string, unknown>;
  delete legacy.mergeSha;
  assert.equal(parseGitHubPublicationCheckpointV1(legacy).mergeSha, null);
  assert.throws(
    () => parseGitHubPublicationCheckpointV1({
      ...legacy,
      status: "merged_verified",
    }),
    /merge SHA|post-merge/i,
  );
});

test("legacy combined Linear finalization checkpoint migrates to explicit idempotent substates", () => {
  const legacy = {
    ...checkpoint(),
    status: "waiting_obsidian",
    remoteSha: SHA,
    mergeSha: SHA,
    pullRequest: {
      number: 12,
      htmlUrl: "https://github.com/acme/research-agent/pull/12",
      state: "closed",
      draft: false,
      merged: true,
      head: { ref: "codex/eng-12", sha: SHA },
      base: { ref: "main", sha: SHA },
      updatedAt: "2026-07-12T12:00:01.000Z",
      mergeSha: SHA,
    },
    receiptIds: ["receipt-push", "receipt-linear-combined"],
  } as unknown as Record<string, unknown>;
  delete legacy.completionProof;
  delete legacy.linearLinkReceiptId;
  delete legacy.linearCompletionReceiptId;
  delete legacy.obsidianReceiptId;

  const migrated = parseGitHubPublicationCheckpointV1(legacy);
  assert.equal(migrated.completionProof, "merged_pr");
  assert.equal(migrated.linearLinkReceiptId, "receipt-linear-combined");
  assert.equal(migrated.linearCompletionReceiptId, "receipt-linear-combined");
  assert.equal(migrated.obsidianReceiptId, null);
});

function checkpoint(): GitHubPublicationCheckpointV1 {
  return {
    version: 1,
    publicationId: "github-publication-1",
    status: "local_verified",
    updatedAt: "2026-07-12T12:00:00.000Z",
    handoffFingerprint: FP,
    bindingFingerprint: FP,
    headSha: SHA,
    branch: "codex/eng-12",
    remoteSha: null,
    mergeSha: null,
    pullRequest: null,
    proofSnapshot: null,
    publishApprovalFingerprint: null,
    readyApprovalFingerprint: null,
    mergeApprovalFingerprint: null,
    completionProof: "merged_pr",
    linearLinkReceiptId: null,
    linearCompletionReceiptId: null,
    obsidianReceiptId: null,
    receiptIds: [],
    pendingAction: null,
    blocker: null,
  };
}

function clone<T>(value: T): T {
  return value === null ? value : JSON.parse(JSON.stringify(value)) as T;
}
