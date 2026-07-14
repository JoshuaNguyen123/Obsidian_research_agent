import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createVerifiedCodePublicationHandoffV1,
  parseVerifiedCodePublicationHandoffV1,
  VerifiedCodePublicationHandoffErrorV1,
} from "../packages/core-api/src/verifiedCodePublicationHandoffV1";
import type { VerifiedLocalCommitReceiptV1 } from "../extensions/code/repair/types";

const GIT_A = "a".repeat(40);
const GIT_B = "b".repeat(40);
const GIT_C = "c".repeat(40);
const FP_A = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;

test("VerifiedCodePublicationHandoffV1 accepts the real verified local commit receipt shape", () => {
  const receipt = localCommitReceipt();
  const handoff = createVerifiedCodePublicationHandoffV1({
    id: "handoff-1",
    repositoryProfileKey: "fixture",
    repositoryProfileFingerprint: FP_A,
    canonicalWorktreeRoot: "C:\\agent-worktrees\\repair-1",
    baseBranch: "main",
    localCommit: receipt,
    preparedAt: "2026-07-12T12:01:00.000Z",
  });

  assert.equal(handoff.commitSha, GIT_B);
  assert.equal(handoff.treeSha, GIT_C);
  assert.equal(handoff.diffFingerprint, FP_A);
  assert.equal(handoff.targetedValidationFingerprint, FP_A);
  assert.equal(handoff.fullValidationFingerprint, FP_B);
  assert.equal(handoff.localCommitReceiptFingerprint, receipt.fingerprint);
  assert.match(handoff.canonicalWorktreeFingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.match(handoff.artifactFingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(parseVerifiedCodePublicationHandoffV1(handoff), handoff);
});

test("VerifiedCodePublicationHandoffV1 rejects tampered local and handoff proof", () => {
  const receipt = localCommitReceipt();
  assert.throws(
    () => createVerifiedCodePublicationHandoffV1({
      id: "handoff-1",
      repositoryProfileKey: "fixture",
      repositoryProfileFingerprint: FP_A,
      canonicalWorktreeRoot: "C:\\agent-worktrees\\repair-1",
      baseBranch: "main",
      localCommit: { ...receipt, treeSha: "d".repeat(40) },
      preparedAt: "2026-07-12T12:01:00.000Z",
    }),
    (error: unknown) => error instanceof VerifiedCodePublicationHandoffErrorV1 && /local commit receipt fingerprint/iu.test(error.message),
  );

  const handoff = createVerifiedCodePublicationHandoffV1({
    id: "handoff-1",
    repositoryProfileKey: "fixture",
    repositoryProfileFingerprint: FP_A,
    canonicalWorktreeRoot: "C:\\agent-worktrees\\repair-1",
    baseBranch: "main",
    localCommit: receipt,
    preparedAt: "2026-07-12T12:01:00.000Z",
  });
  assert.throws(
    () => parseVerifiedCodePublicationHandoffV1({ ...handoff, fullValidationFingerprint: FP_A }),
    /handoff fingerprint does not match/iu,
  );
  assert.throws(
    () => parseVerifiedCodePublicationHandoffV1({ ...handoff, unexpected: true }),
    /closed contract/iu,
  );
});

test("VerifiedCodePublicationHandoffV1 requires an agent branch and canonical absolute worktree", () => {
  const receipt = localCommitReceipt();
  assert.throws(
    () => createVerifiedCodePublicationHandoffV1({
      id: "handoff-1",
      repositoryProfileKey: "fixture",
      repositoryProfileFingerprint: FP_A,
      canonicalWorktreeRoot: "relative/worktree",
      baseBranch: "main",
      localCommit: receipt,
      preparedAt: "2026-07-12T12:01:00.000Z",
    }),
    /absolute canonical host path/iu,
  );
  assert.throws(
    () => createVerifiedCodePublicationHandoffV1({
      id: "handoff-1",
      repositoryProfileKey: "fixture",
      repositoryProfileFingerprint: FP_A,
      canonicalWorktreeRoot: "C:\\agent-worktrees\\repair-1",
      baseBranch: "main",
      localCommit: { ...receipt, branch: "feature/user-owned", fingerprint: receiptFingerprint({ ...receipt, branch: "feature/user-owned" }) },
      preparedAt: "2026-07-12T12:01:00.000Z",
    }),
    /codex\/ branches/iu,
  );
});

function localCommitReceipt(): VerifiedLocalCommitReceiptV1 {
  const evidence = {
    requestId: "repair-1",
    runId: "run-1",
    worktreeId: "worktree-1",
    workspaceId: "workspace-1",
    branch: "codex/repair-1",
    baseSha: GIT_A,
    commitSha: GIT_B,
    parentSha: GIT_A,
    treeSha: GIT_C,
    diffFingerprint: FP_A,
    changedPaths: ["src/fix.ts"],
    artifactHashes: [{ path: "src/fix.ts", sha256: FP_A, bytes: 42 }],
    changedArtifacts: [{ path: "src/fix.ts", sha256: FP_A }],
    targetedValidationReceiptId: "targeted-1",
    fullValidationReceiptId: "full-1",
    targetedValidationFingerprint: FP_A,
    fullValidationFingerprint: FP_B,
    committedAt: "2026-07-12T12:00:00.000Z",
  };
  return {
    version: 1,
    kind: "verified_local_commit",
    id: "verified-commit-1",
    status: "verified",
    ...evidence,
    fingerprint: hash(evidence),
  };
}

function receiptFingerprint(receipt: VerifiedLocalCommitReceiptV1): string {
  const { version: _version, kind: _kind, id: _id, status: _status, fingerprint: _fingerprint, ...evidence } = receipt;
  return hash(evidence);
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
