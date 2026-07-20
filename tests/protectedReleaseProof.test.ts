import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// @ts-ignore The executable MJS wrapper intentionally has no production declaration surface.
import { containsSensitiveProofText, projectAllowlistedProofArtifact, projectDailyUseSummaryForPublicProof, proofArtifactNamesForLane, proofDirectoryForSha, validateDailyUseSummaryForLane } from "../scripts/run-targeted-protected-release.mjs";

const SHA = "a".repeat(40);
const definition = {
  projects: ["daily-use-compound"],
  files: ["e2e/daily-use-compound.spec.ts"],
  grep: "DU-06 checkers exact-SHA lifecycle",
  expectedRecords: 1,
};

test("protected proof root is exact-SHA-owned outside Playwright output", () => {
  const root = proofDirectoryForSha(SHA).replace(/\\/gu, "/");
  assert.match(root, new RegExp(`/\\.agentic-proof/${SHA}$`, "u"));
  assert.doesNotMatch(root, /test-results/u);
  assert.throws(() => proofDirectoryForSha("main"), /full lowercase Git commit SHA/u);
});

test("protected summary accepts only records owned by the selected lane", () => {
  const valid = {
    version: 1,
    status: "passed",
    records: [{
      project: "daily-use-compound",
      file: "e2e\\daily-use-compound.spec.ts",
      title: "DU-06 checkers exact-SHA lifecycle restarts safely",
      scenarioId: "DU-06",
      acceptanceStatus: "pass",
      missingAcceptanceCriteria: [],
      status: "passed",
    }],
  };
  assert.equal(
    validateDailyUseSummaryForLane(valid, "compound", definition),
    true,
  );
  assert.throws(
    () => validateDailyUseSummaryForLane(
      { ...valid, records: [{ ...valid.records[0], project: "real-ai-soak" }] },
      "compound",
      definition,
    ),
    /includes project/u,
  );
  assert.throws(
    () => validateDailyUseSummaryForLane(
      { ...valid, records: [{ ...valid.records[0], title: "unselected test" }] },
      "compound",
      definition,
    ),
    /unselected test title/u,
  );
  assert.throws(
    () => validateDailyUseSummaryForLane({ version: 1, records: [] }, "compound", definition),
    /no daily-use records/u,
  );
  assert.throws(
    () => validateDailyUseSummaryForLane({ ...valid, status: "failed" }, "compound", definition),
    /summary did not pass/u,
  );
  assert.throws(
    () => validateDailyUseSummaryForLane(
      { ...valid, records: [{ ...valid.records[0], status: "skipped" }] },
      "compound",
      definition,
    ),
    /non-passed test record/u,
  );
  assert.throws(
    () => validateDailyUseSummaryForLane(
      {
        ...valid,
        records: [{
          ...valid.records[0],
          acceptanceStatus: "needs_more_work",
          missingAcceptanceCriteria: ["proof:cleanup"],
        }],
      },
      "compound",
      definition,
    ),
    /unmet daily-use acceptance criteria/u,
  );
});

test("protected proof reruns replace only the selected lane artifacts", () => {
  const deterministicNames: string[] = proofArtifactNamesForLane("deterministic");
  const compoundNames: string[] = proofArtifactNamesForLane("compound");
  assert.ok(deterministicNames.every((name) => name.startsWith("deterministic")));
  assert.ok(compoundNames.every((name) => name.startsWith("compound")));
  assert.equal(
    compoundNames.includes("compound--daily-use-du06-retained-linear-evidence.json"),
    true,
  );
  assert.deepEqual(
    deterministicNames.filter((name) => compoundNames.includes(name)),
    [],
  );
});

test("protected proof rejects credentials, private keys, and local paths", () => {
  for (const value of [
    `github_pat_${"x".repeat(40)}`,
    `lin_api_${"x".repeat(40)}`,
    "-----BEGIN PRIVATE KEY-----",
    "C:\\Users\\person\\vault\\data.json",
    "\\\\server\\share\\payload.json",
    "https://example.test/?token=secret-value",
    "https://linear.app/private-workspace/issue/APP-42/private-title",
    "person@example.test",
    '"issueId":"private-provider-id"',
    "550e8400-e29b-41d4-a716-446655440000",
  ]) {
    assert.equal(containsSensitiveProofText(value), true, value);
  }
  assert.equal(
    containsSensitiveProofText(
      JSON.stringify({ status: "verified", token: "[REDACTED]" }),
    ),
    false,
  );
});

test("allowlisted diagnostics project only bounded metadata and never raw output", () => {
  const stdout = "private notebook prose that matches no credential regex";
  const stderr = "private generated source fragment";
  const projected = projectAllowlistedProofArtifact(
    "daily-use-du03-checkers-fast-validation-diagnostic.json",
    {
      version: 1,
      scenarioId: "DU-03",
      trust: "untrusted_redacted_test_diagnostic",
      stdout,
      stderr,
      truncated: true,
      redactedLines: 2,
      unexpectedProviderPayload: "must not survive",
    },
  ) as any;
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(
    serialized,
    /private notebook|generated source|unexpectedProviderPayload/u,
  );
  assert.deepEqual(projected, {
    version: 1,
    scenarioId: "DU-03",
    status: "captured",
    stdoutPresent: true,
    stderrPresent: true,
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
    truncated: true,
    redactedLines: 2,
  });
});

test("allowlisted cleanup projection drops private error prose", () => {
  const projected = projectAllowlistedProofArtifact(
    "daily-use-du06-cleanup-proof.json",
    {
      version: 1,
      scenarioId: "DU-06",
      releaseSha: SHA,
      status: "incomplete",
      linear: {
        disposableResourceCount: 2,
        independentAbsenceReadback: false,
        retainedEvidencePreserved: true,
      },
      github: {
        privateRepositoryAbsenceReadback: true,
        branchAbsenceReadback: true,
        pullRequestClosedUnmergedReadback: true,
      },
      local: {
        worktreeCapturedAfterCreation: true,
        worktreeAbsenceReadback: true,
        vaultBackupsRemoved: 1,
        vaultBackupAbsenceReadback: true,
        fixtureRemoved: true,
      },
      credentials: { nativeSecureStateVerified: true },
      errors: ["private vault sentence without a token marker"],
    },
  ) as any;
  assert.equal(projected.errorCount, 1);
  assert.doesNotMatch(JSON.stringify(projected), /private vault sentence/u);
});

test("protected summary projection drops observations and provider metadata", () => {
  const rawRecord = {
    version: 1,
    scenarioId: "DU-06",
    taskFamily: "compound",
    project: "daily-use-compound",
    file: "e2e/daily-use-compound.spec.ts",
    title: "DU-06 checkers exact-SHA lifecycle restarts safely",
    status: "passed",
    durationMs: 10,
    retry: 0,
    failureCategory: null,
    acceptanceStatus: "pass",
    missingAcceptanceCriteria: [],
    fingerprint: `sha256:${"a".repeat(64)}`,
    modelCalls: 2,
    toolCalls: 3,
    continuations: 1,
    approvals: 1,
    artifactProofCount: 4,
    cleanupProofCount: 2,
    observed: {
      artifacts: ["https://linear.app/private-workspace/issue/APP-42"],
      proofs: ["provider response body"],
      bindings: ["private vault note"],
    },
    issueId: "private-provider-id",
  };
  const projected = projectDailyUseSummaryForPublicProof({
    version: 1,
    status: "passed",
    records: [rawRecord],
  });
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /linear\.app|provider response|private vault|issueId/u);
  assert.equal(containsSensitiveProofText(serialized), false);
  assert.equal((projected as any).records[0].toolCalls, 3);
});

test("protected proof preserves bounded failed-run metrics without accepting the lane", () => {
  const failed = {
    version: 1,
    status: "failed",
    records: [{
      project: "daily-use-compound",
      file: "e2e/daily-use-compound.spec.ts",
      title: "DU-06 checkers exact-SHA lifecycle restarts safely",
      scenarioId: "DU-06",
      acceptanceStatus: "needs_more_work",
      missingAcceptanceCriteria: ["github:draft_pr_readback"],
      failureCategory: "product_failure",
      status: "failed",
      taskFamily: "compound",
      durationMs: 12,
      retry: 0,
      modelCalls: 4,
      toolCalls: 8,
      continuations: 1,
      approvals: 2,
      artifactProofCount: 3,
      cleanupProofCount: 1,
      fingerprint: `sha256:${"b".repeat(64)}`,
    }],
  };
  assert.equal(
    validateDailyUseSummaryForLane(failed, "compound", definition, {
      requirePassed: false,
    }),
    true,
  );
  assert.throws(
    () => validateDailyUseSummaryForLane(failed, "compound", definition),
    /summary did not pass/u,
  );
  const projected = projectDailyUseSummaryForPublicProof(failed) as any;
  assert.equal(projected.status, "failed");
  assert.equal(projected.records[0].status, "failed");
  assert.equal(projected.records[0].modelCalls, 4);
  assert.deepEqual(projected.records[0].missingAcceptanceCriteria, [
    "github:draft_pr_readback",
  ]);
  assert.equal(containsSensitiveProofText(JSON.stringify(projected)), false);
});

test("protected proof rejects an invalid metrics fingerprint instead of substituting one", () => {
  assert.throws(
    () => projectDailyUseSummaryForPublicProof({
      version: 1,
      status: "passed",
      records: [{
        scenarioId: "DU-06",
        taskFamily: "compound",
        project: "daily-use-compound",
        file: "e2e/daily-use-compound.spec.ts",
        title: "DU-06 checkers exact-SHA lifecycle restarts safely",
        status: "passed",
        fingerprint: "invalid",
      }],
    }),
    /invalid fingerprint/u,
  );
});

test("protected wrapper preserves current-lane proof in finally after clearing stale output", () => {
  const source = readFileSync(
    path.resolve("scripts/run-targeted-protected-release.mjs"),
    "utf8",
  );
  const reset = source.indexOf("resetOwnedDirectory(testResultsRoot");
  const invocation = source.indexOf("[playwrightCli, \"test\"");
  const finallyBlock = source.indexOf("} finally {");
  const preservation = source.indexOf("proofResult = await preserveLaneProof");
  assert.ok(reset >= 0 && reset < invocation);
  assert.ok(finallyBlock >= 0 && preservation > finallyBlock);
  assert.match(source, /daily-use-du06-stage-entry-proof\.json/u);
  assert.match(source, /daily-use-du06-cleanup-proof\.json/u);
  assert.match(source, /daily-use-du06-retained-linear-evidence\.json/u);
  assert.doesNotMatch(source, /daily-use-du03-checkers-generated-source\.json/u);
  assert.doesNotMatch(source, /test-results["'], "protected-targeted/u);
});

test("protected runner never streams raw child output or Playwright failure media", () => {
  const runner = readFileSync(
    path.resolve("scripts/run-targeted-protected-release.mjs"),
    "utf8",
  );
  const config = readFileSync(path.resolve("playwright.config.ts"), "utf8");
  assert.match(runner, /E2E_PROTECTED_LOG_MODE: "1"/u);
  assert.match(runner, /stdio: protectedLogMode[\s\S]{0,120}\["ignore", "pipe", "pipe"\]/u);
  assert.match(runner, /Protected command exited with code/u);
  assert.doesNotMatch(runner, /protectedLogMode[\s\S]{0,300}stdout \+=/u);
  assert.match(config, /protectedLogMode[\s\S]{0,160}dailyUseReporter/u);
  assert.match(config, /screenshot: protectedLogMode \? "off"/u);
  assert.match(config, /trace: protectedLogMode \? "off"/u);
  assert.match(config, /video: protectedLogMode \? "off"/u);
});
