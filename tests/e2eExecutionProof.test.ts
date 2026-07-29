import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// @ts-ignore The production runner is an intentionally unbundled Node ESM script.
import { assertProjectsExecuted } from "../scripts/run-e2e-exclusive.mjs";
// @ts-ignore The production gate is an intentionally unbundled Node ESM script.
import { MISSION_SCORECARD_EXEMPT_PROJECTS, assertMissionScorecardSummaryFile } from "../scripts/mission-scorecard-regression.mjs";
import { BYOK_01_ACCEPTANCE_TOKENS } from "../src/agent/dailyUseAcceptance";

function reportWith(
  tests: Array<{ project: string; status: string }>,
): unknown {
  return {
    suites: [
      {
        specs: tests.map((entry, index) => ({
          title: `spec-${index}`,
          tests: [
            {
              projectName: entry.project,
              results: [{ status: entry.status }],
            },
          ],
        })),
        suites: [],
      },
    ],
  };
}

test("a project whose tests all skipped fails the run", () => {
  // The exact shape that let test:e2e:journeys report success: the lane guard
  // could not match, every test skipped, Playwright still exited 0.
  assert.throws(
    () =>
      assertProjectsExecuted(
        reportWith([{ project: "desktop-checkers-delivery-real-live", status: "skipped" }]),
        ["desktop-checkers-delivery-real-live"],
      ),
    /executed no test/u,
  );
});

test("a project missing from the report entirely fails the run", () => {
  assert.throws(
    () => assertProjectsExecuted(reportWith([]), ["compound-flow-real-live"]),
    /compound-flow-real-live/u,
  );
});

test("mixed results still fail when any selected project ran nothing", () => {
  assert.throws(
    () =>
      assertProjectsExecuted(
        reportWith([
          { project: "daily-use-research", status: "passed" },
          { project: "compound-flow-real-live", status: "skipped" },
        ]),
        ["daily-use-research", "compound-flow-real-live"],
      ),
    /compound-flow-real-live/u,
  );
});

test("an executed project passes and is counted", () => {
  const summary = assertProjectsExecuted(
    reportWith([
      { project: "daily-use-research", status: "passed" },
      { project: "daily-use-research", status: "failed" },
    ]),
    ["daily-use-research"],
  );
  assert.equal(summary.checked, 1);
  assert.equal(summary.executed["daily-use-research"], 2);
});

test("nested suites are traversed", () => {
  const nested = {
    suites: [
      {
        specs: [],
        suites: [
          {
            specs: [
              {
                tests: [
                  { projectName: "daily-use-code-live", results: [{ status: "passed" }] },
                ],
              },
            ],
            suites: [],
          },
        ],
      },
    ],
  };
  assert.doesNotThrow(() =>
    assertProjectsExecuted(nested, ["daily-use-code-live"]),
  );
});

test("selecting no project is a no-op rather than a false failure", () => {
  assert.deepEqual(assertProjectsExecuted(reportWith([]), []), {
    checked: 0,
    executed: {},
  });
});

test("a lane with no scorecard baseline is proof debt, not a silent pass", async () => {
  // Previously this returned {skipped:true} before even reading the summary,
  // which disabled the gate for every lane once the only baseline record
  // referenced a deleted project.
  await assert.rejects(
    () =>
      assertMissionScorecardSummaryFile({
        selectedProjects: ["daily-use-research"],
      }),
    /No mission-scorecard baseline exists for: daily-use-research/u,
  );
});

test("model-free lanes are explicitly exempt, with the set stated in code", () => {
  for (const lane of [
    "configured-linear-live",
    "github-askpass-runtime-live",
    "disposable-live-external",
    "provider-canary",
  ]) {
    assert.equal(
      MISSION_SCORECARD_EXEMPT_PROJECTS.has(lane),
      true,
      `${lane} makes no model calls and cannot emit a mission scorecard`,
    );
  }
  // A journey lane must never be quietly exempted.
  for (const lane of [
    "byok-autonomous-journey",
    "desktop-checkers-delivery-real-live",
    "daily-use-research",
    "daily-use-compound",
    "compound-flow-real-live",
    "retained-journey",
  ]) {
    assert.equal(MISSION_SCORECARD_EXEMPT_PROJECTS.has(lane), false, lane);
  }
});

test("the BYOK autonomous journey proves every handoff through production boundaries", () => {
  const spec = readFileText("../e2e/byok-autonomous-journey.spec.ts");
  for (const required of [
    "assertProductionAdoptedSandboxV1",
    "ByokRuntimeObservationLedger",
    "BYOK_01_ACCEPTANCE_TOKENS",
    "linearIssueId",
    "assertSandboxValidationReceipt",
    "activeFixture.snapshotTree(canonicalExport)",
    "listPullRequestsForHead",
    "researchVia=owned-fixture",
    "recordDailyUseAcceptance",
    "observations.snapshot()",
    "phaseAObservedTools",
    "phaseBSequenceStart",
    "requirePositiveCounterDelta",
    "phaseAStartCounters.modelCalls",
    "phaseBStartCounters.modelCalls",
    "phaseAModelCallDelta",
    "phaseBModelCallDelta",
    "assertPhaseModelCallAccounting",
    "providerUsageScopeId",
    "usageScopes",
    "terminalCoordinatorModelCalls",
    "providerUsage: phaseAProviderUsage",
    "providerUsage: phaseBProviderUsage",
    "lastMissionLedger?.providerUsage?.modelCallCount",
    "assertSuccessfulMutationAuthority",
    "successfulMutationEvents",
    "assertExternalReceiptMatchesNestedApproval",
    "finalize_github_links_in_obsidian",
    "preparedActionId",
    "payloadFingerprint",
    "policy:scoped-read",
    "readbackStatus",
    "nestedApprovals",
    "byok-phase-a-production-scorecard-v1",
    "byok-phase-b-production-scorecard-v1",
    "idempotency:no_duplicates",
    "continuations: continuationCount",
    '["complete", "cancelled"]',
    "lastMissionLedger?.status",
    "researchMetricsRemoved",
    "testLinearConnection",
    "assertGraphRuntimeLinkage",
    "parseMissionGraphV3",
    "evidenceFingerprint",
    "evidence.fingerprint === event.evidenceFingerprint",
    "cleanupExactOwnedLinearIssueToTrash",
    "byok-linear-cleanup-v1",
    "addOwnedLinearIssueIdsFromReceipts",
    "includeArchived: true",
    "commitCount",
    "listNewOwnedExportCandidates",
    "finalNewOwnedExportPaths",
    "Unregistered new Desktop candidate was not deleted",
    "event.preparedAction?.path",
    "if (configuredClientProved) return input.client",
    "byok-github-cleanup-authority-v1",
    "byok-github-cleanup-v1",
    "selectPostBaselineOwnedVaultBackupPaths",
    "validateOwnedVaultBackupDeletionPath",
    "assertOwnedVaultBackupCleanupReadback",
    "byok-vault-backup-cleanup-v1",
    "vaultBackupBaseline = await listVaultBackupPaths",
    "vaultBackupAbsenceVerified",
    "quarantinePostBaselineOwnedVaultBackups",
    "inventoryOwnedRepositoryWorkspaceMetadata",
    "cleanupOwnedRepositoryWorkspaceMetadata",
    "byok-workspace-metadata-cleanup-v1",
    "observedToolJournal",
    "await harness.relaunch()",
    "the production plugin must expose a new durable Phase B run after submission",
    "candidate === phaseASnapshot.runId",
    "acceptanceRecorded",
  ]) {
    assert.match(spec, new RegExp(escapeRegExp(required), "u"), required);
  }
  assert.doesNotMatch(spec, /completeObservedAcceptance/u);
  assert.doesNotMatch(
    readFileText("../e2e/fixtures/dailyUseAcceptance.ts"),
    /completeObservedAcceptance/u,
  );
  assert.doesNotMatch(spec, /resume:no_duplicates/u);
  assert.doesNotMatch(
    spec,
    /modelCallCount\s*\+=\s*Array\.isArray\([^)]*modelCallEvidence/gu,
  );
  assert.doesNotMatch(spec, /teams\.get/u);
  assert.doesNotMatch(spec, /runAcceptance\(workspaceRoot/u);
  assert.doesNotMatch(spec, /runAcceptance\(canonicalExport/u);
  const runner = readFileText("../src/AgentRunner.ts");
  assert.match(
    runner,
    /id: isSafeMissionGraphReferenceId\(receipt\.id\)[\s\S]*\? receipt\.id[\s\S]*: missionGraphReferenceId/u,
  );
  for (const token of Object.values(BYOK_01_ACCEPTANCE_TOKENS).flat()) {
    assert.match(spec, new RegExp(escapeRegExp(token), "u"), token);
  }
});

test("the real AI harness counts whole-team model calls by coordinator usage scope", () => {
  const harness = readFileText("../e2e/fixtures/realAiHarness.ts");
  for (const required of [
    "modelCallsByUsageScopeId",
    "snapshot?.providerUsage?.modelCallCount",
    "providerUsageScopeId",
    "recordedModelCallsByUsageScopeId",
    "totalRecordedModelCalls",
    "onUsageScopeModelCalls",
    "modelCalls: totalRecordedModelCalls()",
  ]) {
    assert.match(harness, new RegExp(escapeRegExp(required), "u"), required);
  }
  assert.match(
    harness,
    /const maximum = Math\.max\([\s\S]*modelCallsByUsageScopeId\.get\(usageScopeId\)[\s\S]*modelCallsByUsageScopeId\.set\(usageScopeId, maximum\);[\s\S]*options\.onUsageScopeModelCalls\?\.\(usageScopeId, maximum\);/u,
  );
  assert.match(
    harness,
    /recordedModelCallsByUsageScopeId\.set\([\s\S]*Math\.max\([\s\S]*recordedModelCallsByUsageScopeId\.get\(usageScopeId\)[\s\S]*modelCalls/u,
  );
});

test("the exclusive runner preserves both execution JSON and scorecard reports", () => {
  const runner = readFileText("../scripts/run-e2e-exclusive.mjs");
  assert.match(
    runner,
    /--reporter=json,\.\/e2e\/reporters\/dailyUseReporter\.ts/u,
  );
});

test("the BYOK post-run verifier checks retained code and disposable GitHub cleanup", () => {
  const verifier = readFileText(
    "../scripts/verify-byok-autonomous-journey.mjs",
  );
  for (const required of [
    "retained-desktop-export",
    "scripts/verify_project.py",
    "tests/test_crdt_contract.py",
    "githubCleanup=verified",
    "repos/${owner}/${repository}",
    "byok-phase-a-production-scorecard-v1",
    "byok-phase-b-production-scorecard-v1",
    "daily-use-observed-v1",
    "idempotency:no_duplicates",
    "authority:no_unapproved_mutations",
    "phaseAScorecard.runId !== phaseBScorecard.runId",
    "JSON.stringify(scorecard) === JSON.stringify(phaseBScorecard.scorecard)",
    "approvalBoundaryProofCount === 4",
    "validatePhaseProviderUsage",
    "terminalUsageScopeId",
    "metrics.modelCalls",
    "providerUsage.modelCallCount",
    "evidence.sources >= 4",
    "Conflicting ${type} annotations",
    "byok-github-cleanup-authority-v1",
    "byok-github-cleanup-v1",
    "byok-vault-backup-cleanup-v1",
    "byok-workspace-metadata-cleanup-v1",
    "workspaceMetadataCleanup.absenceVerified === true",
    "vaultBackupCleanup=verified",
    "workspaceMetadataCleanup=verified",
    "vaultBackupCleanup.selectedPaths",
    "vaultBackupCleanup.notePath === expectedNotePath",
    "HTTP 404",
  ]) {
    assert.match(verifier, new RegExp(escapeRegExp(required), "u"), required);
  }
  for (const token of Object.values(BYOK_01_ACCEPTANCE_TOKENS).flat()) {
    assert.match(verifier, new RegExp(escapeRegExp(token), "u"), token);
  }
  assert.doesNotMatch(verifier, /completeObservedAcceptance/u);
});

test("the retained journey closes its provider, graph, note, UI, and clone proof gaps", () => {
  const spec = readFileText("../e2e/retained-journey.spec.ts");
  for (const required of [
    "readLinearIssueThroughProductionTool",
    "Application_testing_dumping_grounds",
    "linearIssueReadback?.assignee?.id",
    "readGitHubPublicationCheckpoint",
    "code_workspace_write_expected",
    "code_validate_targeted",
    "code_validate_full",
    "assertMissionUiSurfacesV1",
    "DAILY_USE_SCORECARD_ANNOTATION",
  ]) {
    assert.match(spec, new RegExp(escapeRegExp(required), "u"), required);
  }

  const verifier = readFileText("../scripts/verify-retained-journey.mjs");
  for (const required of [
    "pulls?state=open&per_page=20",
    "Linear issue assignee is the configured viewer",
    "Research cites the exact retained source URLs",
    "MissionGraph completed the retained lifecycle tools",
    "clonedHead === artifacts.commitSha",
  ]) {
    assert.match(verifier, new RegExp(escapeRegExp(required), "u"), required);
  }
});

function readFileText(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
