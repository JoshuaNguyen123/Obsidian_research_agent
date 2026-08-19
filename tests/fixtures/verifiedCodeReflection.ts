import { canonicalJson } from "../../packages/headless-runtime/src/canonicalize";
import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
import {
  AGENT_GIT_COMMIT_EMAIL_V1,
  AGENT_GIT_COMMIT_NAME_V1,
} from "../../packages/core-api/src/agentGitCommitIdentityV1";
import {
  createVerifiedCodePublicationHandoffV1,
  createVerifiedCodeReflectionExamplesV1,
  type VerifiedCodePublicationHandoffV1,
  type VerifiedCodeReflectionExamplesV1,
  type VerifiedLocalCommitForPublicationV1,
} from "../../packages/core-api/src/verifiedCodePublicationHandoffV1";

export const VERIFIED_REFLECTION_CODE = [
  "export function add(left: number, right: number): number {",
  "  return left + right;",
  "}",
  "",
  "console.log(add(20, 22));",
].join("\n");

export function verifiedCodeReflectionFixture(
  commitSha = "b".repeat(40),
): {
  handoff: VerifiedCodePublicationHandoffV1;
  examples: VerifiedCodeReflectionExamplesV1;
} {
  const artifactSha256 = textHash(VERIFIED_REFLECTION_CODE);
  const evidence = {
    requestId: "reflection-request-1",
    runId: "reflection-run-1",
    worktreeId: "reflection-worktree-1",
    workspaceId: "reflection-workspace-1",
    branch: "codex/reflection-example",
    baseSha: "a".repeat(40),
    commitSha,
    parentSha: "a".repeat(40),
    treeSha: "c".repeat(40),
    diffFingerprint: textHash("diff"),
    changedPaths: ["src/add.ts"],
    artifactHashes: [{
      path: "src/add.ts",
      sha256: artifactSha256,
      bytes: new TextEncoder().encode(VERIFIED_REFLECTION_CODE).byteLength,
    }],
    changedArtifacts: [{ path: "src/add.ts", sha256: artifactSha256 }],
    identity: {
      authorName: AGENT_GIT_COMMIT_NAME_V1,
      authorEmail: AGENT_GIT_COMMIT_EMAIL_V1,
      committerName: AGENT_GIT_COMMIT_NAME_V1,
      committerEmail: AGENT_GIT_COMMIT_EMAIL_V1,
    },
    targetedValidationReceiptId: "reflection-targeted-1",
    fullValidationReceiptId: "reflection-full-1",
    targetedValidationFingerprint: textHash("targeted"),
    fullValidationFingerprint: textHash("full"),
    committedAt: "2026-08-19T12:00:00.000Z",
  };
  const localCommit: VerifiedLocalCommitForPublicationV1 = {
    version: 1,
    kind: "verified_local_commit",
    id: "reflection-commit-1",
    status: "verified",
    ...evidence,
    fingerprint: contractHash(evidence),
  };
  const handoff = createVerifiedCodePublicationHandoffV1({
    id: "reflection-handoff-1",
    repositoryProfileKey: "reflection-fixture",
    repositoryProfileFingerprint: textHash("profile"),
    canonicalWorktreeRoot: "C:\\agent-worktrees\\reflection-1",
    baseBranch: "main",
    localCommit,
    preparedAt: "2026-08-19T12:01:00.000Z",
  });
  const examples = createVerifiedCodeReflectionExamplesV1({
    handoff,
    sources: [{ path: "src/add.ts", content: VERIFIED_REFLECTION_CODE }],
    selections: [{ path: "src/add.ts", startLine: 1, endLine: 3 }],
  });
  return { handoff, examples };
}

function textHash(value: string): string {
  return `sha256:${portableSha256Text(value)}`;
}

function contractHash(value: unknown): string {
  return textHash(canonicalJson(value));
}
