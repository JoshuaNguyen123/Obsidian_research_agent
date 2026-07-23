import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGitHubPullRequestUrlV1,
  buildPipelineLineageV1,
  buildReflectionContextV1,
  extractPipelineCiteFactsV1,
  formatPipelineTimelineV1,
} from "../src/agent/pipelineLineage";
import type { ProjectLineageV1 } from "../src/agent/projectLifecycle";

const fp = (char: string) => `sha256:${char.repeat(64)}`;

function verifiedLineage(): ProjectLineageV1 {
  const commitSha = "a".repeat(40);
  return {
    schemaVersion: 1,
    kind: "project_lineage",
    lineageId: "lineage-1",
    runId: "run-1",
    vaultBindingKey: "vault",
    updatedAt: "2026-07-22T00:04:00.000Z",
    fingerprint: fp("9"),
    commits: [
      {
        stage: "accepted_research",
        committedAt: "2026-07-22T00:00:00.000Z",
        proofFingerprint: fp("1"),
        proof: {
          stage: "accepted_research",
          artifactFingerprint: fp("2"),
          notePath: "Research/Source.md",
          noteSha256: fp("3"),
          researcherHandoffFingerprint: fp("4"),
        },
      },
      {
        stage: "linear_hierarchy",
        committedAt: "2026-07-22T00:01:00.000Z",
        proofFingerprint: fp("5"),
        proof: {
          stage: "linear_hierarchy",
          planFingerprint: fp("6"),
          workspaceId: "linear-workspace",
          teamId: "team",
          initiativeId: "initiative",
          projectId: "project",
          issueIds: ["issue-1"],
          workItemFingerprints: [fp("7")],
          providerReadbackFingerprints: [fp("8")],
        },
      },
      {
        stage: "code_execution",
        committedAt: "2026-07-22T00:02:00.000Z",
        proofFingerprint: fp("a"),
        proof: {
          stage: "code_execution",
          repositoryProfileKey: "profile-safe",
          repositoryProfileFingerprint: fp("b"),
          workspaceId: "workspace-safe",
          validationReceiptFingerprints: [fp("c"), fp("d")],
          diffFingerprint: fp("e"),
          targetedValidationPassed: true,
          freshFullValidationPassed: true,
          commitSha,
          commitReadbackFingerprint: fp("f"),
        },
      },
      {
        stage: "private_github_publication",
        committedAt: "2026-07-22T00:03:00.000Z",
        proofFingerprint: fp("0"),
        proof: {
          stage: "private_github_publication",
          trustedBindingFingerprint: fp("1"),
          owner: "owner",
          repository: "repo",
          verifiedPrivate: true,
          branch: "codex/work",
          pullRequestNumber: 12,
          draft: true,
          remoteSha: commitSha,
          repositoryReadbackFingerprint: fp("2"),
          pullRequestReadbackFingerprint: fp("3"),
        },
      },
    ],
  };
}

test("pipeline lineage binds note, issue, diff, commit, PR head, and reflection", () => {
  const projected = buildPipelineLineageV1({
    lineage: verifiedLineage(),
    reflection: {
      state: "verified",
      path: "Research/Source.md",
      contentHash: fp("4"),
    },
  });
  assert.equal(projected.verified, true);
  assert.equal(projected.commit.sha, projected.github.headSha);
  assert.equal(projected.validation.diffFingerprint, fp("e"));
  assert.match(formatPipelineTimelineV1(projected), /Note: verified/u);

  const context = buildReflectionContextV1({
    runId: "run-1",
    ledger: null,
    pipeline: projected,
    persistence: "verified",
  });
  assert.deepEqual(context.interpretations, []);
  assert.deepEqual(context.unresolvedGaps, []);
});

test("pipeline cite facts exclude validation receipt fingerprints", () => {
  const projected = buildPipelineLineageV1({ lineage: verifiedLineage() });
  const cites = extractPipelineCiteFactsV1(projected);
  assert.equal(cites.commitSha, "a".repeat(40));
  assert.equal(cites.pullRequestNumber, 12);
  assert.deepEqual(cites.linearIssueIds, ["issue-1"]);
  assert.equal(
    buildGitHubPullRequestUrlV1("owner", "repo", 12),
    "https://github.com/owner/repo/pull/12",
  );
  assert.equal(cites.validation.targetedPassed, true);
  assert.equal(cites.validation.fullPassed, true);
  assert.ok(!("receiptFingerprints" in cites));
  assert.match(formatPipelineTimelineV1(projected), /Validation: verified \(targeted\+full\)/u);
  assert.ok(
    !formatPipelineTimelineV1(projected).includes(fp("c")),
    "timeline must not dump receipt fingerprints into the validation slot",
  );
});

test("pipeline lineage fails closed on missing diff or mismatched PR head", () => {
  const lineage = verifiedLineage();
  const code = lineage.commits.find(
    (item) => item.stage === "code_execution",
  )!;
  const github = lineage.commits.find(
    (item) => item.stage === "private_github_publication",
  )!;
  if (code.proof.stage !== "code_execution") throw new Error("bad fixture");
  if (github.proof.stage !== "private_github_publication") {
    throw new Error("bad fixture");
  }
  delete code.proof.diffFingerprint;
  github.proof.remoteSha = "b".repeat(40);

  const projected = buildPipelineLineageV1({ lineage });
  assert.equal(projected.verified, false);
  assert.ok(projected.gaps.includes("code_diff_fingerprint"));
  assert.ok(projected.gaps.includes("commit_pr_head_sha_mismatch"));
});
