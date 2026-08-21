import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createVerifiedCodePublicationHandoffV1,
  createVerifiedCodeReflectionExamplesV1,
  parseVerifiedCodePublicationHandoffV1,
  parseVerifiedCodeReflectionExamplesV1,
  VerifiedCodePublicationHandoffErrorV1,
} from "../packages/core-api/src/verifiedCodePublicationHandoffV1";
import type { VerifiedLocalCommitReceiptV1 } from "../extensions/code/repair/types";
import {
  AGENT_GIT_COMMIT_EMAIL_V1,
  AGENT_GIT_COMMIT_NAME_V1,
} from "../packages/core-api/src/agentGitCommitIdentityV1";
import {
  VERIFIED_REFLECTION_CODE,
  verifiedCodeReflectionFixture,
} from "./fixtures/verifiedCodeReflection";

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
  assert.equal(handoff.identity.authorEmail, AGENT_GIT_COMMIT_EMAIL_V1);
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
  const wrongIdentity = {
    ...receipt,
    identity: { ...receipt.identity, authorEmail: "someone@example.com" },
  };
  assert.throws(
    () => createVerifiedCodePublicationHandoffV1({
      id: "handoff-wrong-identity",
      repositoryProfileKey: "fixture",
      repositoryProfileFingerprint: FP_A,
      canonicalWorktreeRoot: "C:\\agent-worktrees\\repair-1",
      baseBranch: "main",
      localCommit: {
        ...wrongIdentity,
        fingerprint: receiptFingerprint(wrongIdentity),
      },
      preparedAt: "2026-07-12T12:01:00.000Z",
    }),
    /host-pinned neutral Agentic Researcher identity/iu,
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

test("verified reflection examples are exact commit excerpts bound to artifact hashes", () => {
  const { handoff, examples } = verifiedCodeReflectionFixture();
  assert.equal(examples.commitSha, handoff.commitSha);
  assert.equal(examples.handoffFingerprint, handoff.fingerprint);
  assert.equal(examples.examples.length, 1);
  assert.deepEqual(
    {
      path: examples.examples[0]?.path,
      language: examples.examples[0]?.language,
      startLine: examples.examples[0]?.startLine,
      endLine: examples.examples[0]?.endLine,
      code: examples.examples[0]?.code,
    },
    {
      path: "src/add.ts",
      language: "typescript",
      startLine: 1,
      endLine: 3,
      code: VERIFIED_REFLECTION_CODE.split("\n").slice(0, 3).join("\n"),
    },
  );
  assert.deepEqual(parseVerifiedCodeReflectionExamplesV1(examples, handoff), examples);
});

test("verified reflection examples reject stale source, oversized excerpts, and tampering", () => {
  const { handoff, examples } = verifiedCodeReflectionFixture();
  assert.throws(
    () => createVerifiedCodeReflectionExamplesV1({
      handoff,
      sources: [{ path: "src/add.ts", content: `${VERIFIED_REFLECTION_CODE}\n// stale` }],
      selections: [{ path: "src/add.ts", startLine: 1, endLine: 3 }],
    }),
    /does not match its artifact hash readback/iu,
  );
  assert.throws(
    () => createVerifiedCodeReflectionExamplesV1({
      handoff,
      sources: [{ path: "src/add.ts", content: VERIFIED_REFLECTION_CODE }],
      selections: [{ path: "src/add.ts", startLine: 1, endLine: 21 }],
    }),
    /endLine|20 lines/iu,
  );
  assert.throws(
    () => parseVerifiedCodeReflectionExamplesV1({
      ...examples,
      examples: [{ ...examples.examples[0], code: "model\ninvented\nthis" }],
    }),
    /example hash|fingerprint/iu,
  );
});

function localCommitReceipt(): VerifiedLocalCommitReceiptV1 {
  const evidence = {
    requestId: "request-2026-08-21T04:15:11.456Z-EfGh5678",
    runId: "run-2026-08-21T04:15:10.123Z-AbCd1234",
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
    identity: {
      authorName: AGENT_GIT_COMMIT_NAME_V1,
      authorEmail: AGENT_GIT_COMMIT_EMAIL_V1,
      committerName: AGENT_GIT_COMMIT_NAME_V1,
      committerEmail: AGENT_GIT_COMMIT_EMAIL_V1,
    },
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
