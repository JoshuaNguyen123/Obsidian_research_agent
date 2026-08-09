import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  readdir,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories/RepositoryProfile";
import {
  getMissionCompositeLifecycleSpecV1,
  getMissionCompositeLifecycleStateV1,
  parseMissionGraphV3,
  type MissionNodeV3,
} from "../src/agent/missionGraphV3";
import {
  BYOK_01_ACCEPTANCE_TOKENS,
  type ByokAcceptanceObservationCategory,
  type ByokAcceptanceObservationToken,
  type DailyUseObservedAcceptanceV1,
} from "../src/agent/dailyUseAcceptance";
import {
  GitHubRestClient,
} from "../src/integrations/github/GitHubRestClient";
import type { HttpTransport } from "../src/model/types";
import {
  cleanupExactOwnedLinearIssueToTrash,
  deleteDisposableGitHubRepositoryAndVerify,
  DisposableExternalCleanupManifest,
  filterActiveLinearIssueReadbacks,
  orderGitHubHarnessTokensForPush,
  preflightDisposableRepositoryDeleteAuthority,
  proveRestCreateAndDeleteProbe,
  retryTransientExternalCleanupRead,
  safeExternalCleanupError,
} from "./fixtures/externalCleanup";
import { createAutonomousJourneyPythonFixture } from "./fixtures/autonomousJourneyGitRepo";
import { buildByokPhaseAResearchPrompt } from "./fixtures/byokAutonomousJourneyPrompt";
import {
  assertOwnedVaultBackupCleanupReadback,
  selectPostBaselineOwnedVaultBackupPaths,
  validateOwnedVaultBackupDeletionPath,
} from "./fixtures/ownedVaultBackups";
import {
  inventoryRootLevelVaultBackupPaths,
  quarantinePostBaselineOwnedVaultBackups,
} from "./fixtures/offlineOwnedVaultBackups";
import {
  cleanupOwnedRepositoryWorkspaceMetadata,
  inventoryOwnedRepositoryWorkspaceMetadata,
  type OwnedRepositoryWorkspaceMetadataInventoryV1,
} from "./fixtures/ownedRepositoryWorkspaceMetadata";
import {
  recordDailyUseAcceptance,
} from "./fixtures/dailyUseAcceptance";
import type { MissionScorecardV1 } from "../src/agent/missionScorecard";
import { laneSelectedV1 } from "./fixtures/laneSelection";
import { PHASE4_CODE_PLUGIN_ID } from "./fixtures/phase4Harness";
import { NATIVE_CORE_PLUGIN_ID } from "./fixtures/nativeObsidianHarness";
import {
  assertProductionAdoptedSandboxV1,
  hostProvisionedSandboxRuntimeDigestV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";
import { hasExplicitResearchPublicationIntent } from "../src/tools/researchPublicationTool";

const LANE = "byok-autonomous-journey";
const PROFILE_KEY = "byok-autonomous-python";
const VALIDATION_PROFILE_KEY = "byok-autonomous-python-validation";
const PHASE_A_SCORECARD_ANNOTATION =
  "byok-phase-a-production-scorecard-v1";
const PHASE_B_SCORECARD_ANNOTATION =
  "byok-phase-b-production-scorecard-v1";
const PHASE_B_DIAGNOSTIC_ANNOTATION =
  "byok-phase-b-production-diagnostic-v1";
const MAX_PHASE_B_DIAGNOSTIC_ACCEPTANCE_MISSING = 16;
const MAX_PHASE_B_DIAGNOSTIC_GRAPH_BLOCKERS = 16;
const MAX_PHASE_B_DIAGNOSTIC_GRAPH_NONTERMINAL = 32;
const MAX_PHASE_B_DIAGNOSTIC_TOOLS = 32;
const MAX_PHASE_B_DIAGNOSTIC_RECEIPTS = 32;
const execFileAsync = promisify(execFile);

const CODE_MUTATION_TOOLS = new Set([
  "code_workspace_create",
  "code_workspace_mkdir",
  "code_workspace_create_file",
  "code_workspace_append",
  "code_workspace_patch",
  "code_workspace_write_expected",
  "code_workspace_move",
  "code_workspace_copy",
  "code_workspace_trash",
  "code_workspace_restore",
]);

const REPOSITORY_FILE_MUTATION_TOOLS = new Set([
  "code_workspace_mkdir",
  "code_workspace_create_file",
  "code_workspace_append",
  "code_workspace_patch",
  "code_workspace_write_expected",
  "code_workspace_move",
  "code_workspace_copy",
  "code_workspace_trash",
  "code_workspace_restore",
]);

const TRUSTED_REPOSITORY_WRITE_PATHS = [
  "README.md",
  "crdt_sync.py",
  "pyproject.toml",
  "src",
  "docs",
] as const;

type ByokRuntimeObservationSets = {
  [Category in ByokAcceptanceObservationCategory]: Set<string>;
};

class ByokRuntimeObservationLedger {
  private readonly observed: ByokRuntimeObservationSets = {
    artifacts: new Set(),
    proofs: new Set(),
    approvals: new Set(),
    bindings: new Set(),
    cleanup: new Set(),
  };

  observe<Category extends ByokAcceptanceObservationCategory>(
    category: Category,
    token: ByokAcceptanceObservationToken<Category>,
  ): void {
    const allowed = BYOK_01_ACCEPTANCE_TOKENS[category] as readonly string[];
    if (!allowed.includes(token)) {
      throw new Error(`Unknown BYOK-01 ${category} observation: ${token}`);
    }
    this.observed[category].add(token);
  }

  has<Category extends ByokAcceptanceObservationCategory>(
    category: Category,
    token: ByokAcceptanceObservationToken<Category>,
  ): boolean {
    return this.observed[category].has(token);
  }

  snapshot(): DailyUseObservedAcceptanceV1 {
    return {
      artifacts: [...this.observed.artifacts],
      proofs: [...this.observed.proofs],
      approvals: [...this.observed.approvals],
      bindings: [...this.observed.bindings],
      cleanup: [...this.observed.cleanup],
    };
  }
}

interface ByokPhaseScorecardAnnotationV1 {
  version: 1;
  phase: "A" | "B";
  runId: string;
  scope:
    | "accepted_research_to_linear"
    | "linear_to_tested_code_github_and_reflection";
  providerUsage: PhaseModelUsageProofV1;
  scorecard: MissionScorecardV1;
}

interface PhaseModelUsageProofV1 {
  version: 1;
  modelCallCount: number;
  usageScopes: Array<{
    usageScopeId: string;
    modelCalls: number;
  }>;
  terminalUsageScopeId: string;
  terminalCoordinatorModelCalls: number;
  finalSegmentModelCalls: number;
}

interface ByokPhaseBDiagnosticAnnotationV1 {
  version: 1;
  phase: "B";
  runId: string | null;
  scorecard: {
    present: boolean;
    version: number | null;
    acceptancePassed: boolean | null;
    total: number | null;
    dimensions: Array<{
      id: string;
      score: number | null;
      weight: number | null;
    }>;
  };
  providerUsage: {
    usageScopeId: string | null;
    aggregate: {
      modelCallCount: number | null;
      successfulCallCount: number | null;
      failedCallCount: number | null;
      reportedTokens: number | null;
      estimatedTokens: number | null;
      retries: number | null;
      wallClockMs: number | null;
    };
    finalLedgerModelCallCount: number | null;
  };
  completion: {
    coordinatorState: string | null;
    isRunning: boolean;
    stopReason: string | null;
    autoContinueReason: string | null;
    step: number | null;
    maxSteps: number | null;
    ledgerStatus: string | null;
    acceptanceStatus: string | null;
    acceptanceMissing: {
      count: number;
      entries: Array<{
        code: string;
        status: string | null;
      }>;
      truncated: boolean;
    };
    hasStopDetail: boolean;
  };
  graph: {
    missionId: string | null;
    revision: number | null;
    routingSource: string | null;
    nodeCount: number;
    statusCounts: Record<string, number>;
    blockers: Array<{
      id: string;
      status: string;
      allowedTools: string[];
      attempts: number | null;
      blockerCode: string | null;
    }>;
    blockersTruncated: boolean;
    nonTerminalCount: number;
    nonTerminal: Array<{
      id: string;
      status: string;
      allowedTools: string[];
      attempts: number | null;
      blockerCode: string | null;
    }>;
    nonTerminalTruncated: boolean;
  };
  tools: {
    count: number;
    entries: Array<{
      sequence: number;
      name: string;
      phase: string;
      ok: boolean;
      descriptorEffect: string | null;
      mutationState: string | null;
      hasReceipt: boolean;
      receiptReadbackStatus: string | null;
    }>;
    truncated: boolean;
  };
  receipts: {
    count: number;
    entries: Array<{
      toolName: string;
      operation: string | null;
      readbackStatus: string | null;
      resourceSystem: string | null;
      resourceType: string | null;
    }>;
    truncated: boolean;
  };
}

interface RegisteredGithubProbeV1 {
  client: GitHubRestClient;
  owner: string;
  repository: string;
}

interface ByokGithubCleanupAuthorityV1 {
  version: 1;
  actorId: number;
  actorLogin: string;
  repositoryId: number;
  repository: string;
  private: true;
  admin: true;
}

test("BYOK-01 proves research to Linear to tested IDE files to GitHub to reflection", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(
    !laneSelectedV1(LANE),
    `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`,
  );
  test.skip(
    process.env.E2E_AI_MODE !== "real" || process.env.E2E_REAL_AI !== "1",
    "Requires E2E_REAL_AI=1 and E2E_AI_MODE=real.",
  );
  test.setTimeout(120 * 60_000);

  const sandboxReadinessStartedAt = Date.now();
  const suffix = randomUUID().replace(/-/gu, "").slice(0, 12);
  const marker = `BYOK_AUTONOMOUS_${suffix}`;
  const notePath = `E2E Agent Tests/BYOK-AUTONOMOUS-${suffix}.md`;
  const repository = safeDisposableRepositoryName(
    `e2e-byok-autonomous-${suffix}`,
  );
  const expectedExportLabel = "merge-requested-python-library";
  const teamId = process.env.LINEAR_LIVE_TEST_TEAM_ID?.trim() ?? "";
  if (!teamId) {
    throw new Error(
      "BYOK-AUTONOMOUS requires explicit LINEAR_LIVE_TEST_TEAM_ID cleanup scope.",
    );
  }
  const envGithubToken = process.env.E2E_GITHUB_TOKEN?.trim() ?? "";
  requireValidOptionalGithubToken(envGithubToken);

  let fixture: Awaited<
    ReturnType<typeof createAutonomousJourneyPythonFixture>
  > | null = null;
  let githubClient: GitHubRestClient | null = null;
  let githubLogin: string | null = null;

  let harness: RealAiHarness | null = null;
  let issueId: string | null = null;
  const ownedLinearIssueIds = new Set<string>();
  let workspaceRoot: string | null = null;
  let workspaceBranch: string | null = null;
  let workspaceMetadataInventory:
    | OwnedRepositoryWorkspaceMetadataInventoryV1
    | null = null;
  let exportPath: string | null = null;
  let desktopRoot: string | null = null;
  let expectedExportDirectoryName: string | null = null;
  let exportVerified = false;
  const observedOwnedExportPaths = new Map<string, string>();
  const preexistingOwnedExportPaths = new Set<string>();
  let finalNewOwnedExportPaths: string[] = [];
  let primaryError: unknown = null;
  let finalMissionScorecard: MissionScorecardV1 | null = null;
  let phaseBSubmitted = false;
  let phaseBSequenceStart: number | null = null;
  let phaseBDiagnosticAnnotated = false;
  let phaseBRunId: string | null = null;
  let modelCallCount = 0;
  let toolCallCount = 0;
  let approvalCount = 0;
  let continuationCount = 0;
  let sourceBackendRestored = false;
  let sourceFixtureRemoved = false;
  let vaultBackupBaseline: string[] | null = null;
  let vaultBackupAbsenceVerified = false;
  const removedVaultBackupPaths = new Set<string>();
  let onlineVaultBackupCleanupError: string | null = null;
  const observedToolJournal: ObservedToolExecution[] = [];
  let githubCleanupAuthority: ByokGithubCleanupAuthorityV1 | null = null;
  const ownedGithubProbeRepositories =
    new Map<string, RegisteredGithubProbeV1>();
  const observations = new ByokRuntimeObservationLedger();
  const cleanup = new DisposableExternalCleanupManifest();
  const registerGithubProbe = (input: RegisteredGithubProbeV1): void => {
    if (!/^e2e-delete-probe-[a-f0-9]{12}$/u.test(input.repository)) {
      throw new Error(
        `Refusing to register an unscoped GitHub probe: ${input.repository}`,
      );
    }
    const owner = input.owner.trim();
    if (!owner) throw new Error("GitHub probe registration omitted its owner.");
    ownedGithubProbeRepositories.set(
      `${owner.toLowerCase()}/${input.repository}`,
      { ...input, owner },
    );
  };

  try {
    fixture = await createAutonomousJourneyPythonFixture(marker);
    const activeFixture = fixture;
    desktopRoot = await resolveDesktopRoot();
    for (const candidate of await listExistingOwnedExportCandidates(
      desktopRoot,
      expectedExportLabel,
    )) {
      preexistingOwnedExportPaths.add(normalizePathCase(candidate));
    }
    await expect(
      activeFixture.runAcceptance(),
      "the protected behavioral fixture must start red",
    ).rejects.toThrow(/crdt_sync|command failed|non-zero|no module named/iu);
    if (envGithubToken) {
      githubClient = githubClientForToken(envGithubToken);
      githubLogin = (await githubClient.getAuthenticatedUser()).login;
    }
    const profile = createRepositoryProfile({
      key: PROFILE_KEY,
      displayName: "Autonomous BYOK Python CRDT implementation",
      repositoryRoot: activeFixture.root,
      defaultBranch: "main",
      allowedPathPrefixes: [...TRUSTED_REPOSITORY_WRITE_PATHS],
      validationProfile: {
        id: VALIDATION_PROFILE_KEY,
        bootstrapCommands: [],
        validationCommands: [
          {
            command: "python3",
            args: ["scripts/verify_project.py"],
            label: "Protected CRDT behavioral acceptance",
          },
        ],
        protectedPaths: ["scripts", "tests"],
        allowedGeneratedPaths: [],
      },
      runtimeDigests: { python: hostProvisionedSandboxRuntimeDigestV1() },
      promotionPolicy: {
        localBasePromotion: "disabled",
        completionProof: "draft_pr",
        githubRepository: githubLogin
          ? `${githubLogin}/${repository}`
          : `pending/${repository}`,
        requiredChecks: [],
      },
    });
    harness = await startRealAiHarness(
      `byok-autonomous-${suffix}`,
      {
        missionTimeoutMs: 70 * 60_000,
        completionTimeoutMs: 70 * 60_000,
      },
      {
        maxAgentSteps: 160,
        maxRunMinutes: 90,
        requestTimeoutMs: 10 * 60_000,
        completionDrivenLoops: true,
        autoContinueLongRuns: true,
        workingMode: "automatic",
        autonomyProfile: "automatic",
        thinkingMode: "medium",
        orchestratorEnabled: false,
        githubEnabled: true,
        linearEnabled: true,
        linearDefaultTeamId: teamId,
        numCtx: 100_000,
        semanticSearchEnabled: true,
        repositoryProfileRegistry: createRepositoryProfileRegistry([profile]),
      },
      {
        preserveConfiguredLinearCredential: true,
        preserveConfiguredGitHubCredential: true,
      },
    );
    // Capture this hidden-folder baseline before the unique run-owned note can
    // be seeded or mutated. Cleanup later targets only exact post-baseline
    // backups for this note, preserving concurrent Claude/user backups.
    vaultBackupBaseline = await listVaultBackupPaths(harness.page);
    const adoptedSandbox = await assertProductionAdoptedSandboxV1(
      harness.page,
      sandboxReadinessStartedAt,
    );
    expect(adoptedSandbox.selectedProvider).toBe("wsl2");
    observations.observe("proofs", "sandbox:production_boundary");

    await assertLinearReady(harness.page, teamId);
    await ensureGitHubConnected(harness.page, envGithubToken || null);
    const vaultGithub = await readGitHubIdentity(harness.page);
    githubLogin = vaultGithub.login;
    githubClient = githubClientForToken(vaultGithub.token);
    cleanup.registerAtCreate("GitHub repository cleanup", async () => {
      const cleanupFailures: string[] = [];
      const targets = new Map<string, RegisteredGithubProbeV1>(
        ownedGithubProbeRepositories,
      );
      if (githubClient && githubLogin) {
        targets.set(`${githubLogin.toLowerCase()}/${repository}`, {
          client: githubClient,
          owner: githubLogin,
          repository,
        });
      }
      for (const target of [...targets.values()].sort((left, right) =>
        left.repository.localeCompare(right.repository),
      )) {
        try {
          await deleteDisposableGitHubRepositoryAndVerify(target);
        } catch (error) {
          cleanupFailures.push(
            `${target.owner}/${target.repository}: ${boundedCleanupError(error)}`,
          );
        }
      }
      if (cleanupFailures.length > 0) {
        throw new Error(
          `Disposable BYOK GitHub cleanup was incomplete: ${cleanupFailures.join(
            " | ",
          )}.`,
        );
      }
      observations.observe("cleanup", "cleanup:github_fixture");
    });
    githubClient = await ensureGitHubCreateCapableCredential({
      page: harness.page,
      client: githubClient,
      owner: githubLogin,
      preferredToken: envGithubToken || null,
      onProbeRegistered: registerGithubProbe,
    });
    await deleteRegisteredGithubProbesAndVerify(ownedGithubProbeRepositories);
    profile.promotionPolicy.githubRepository = `${githubLogin}/${repository}`;
    await bindGitHubRepositoryDestination(
      harness.page,
      PROFILE_KEY,
      `${githubLogin}/${repository}`,
    );
    await preflightDisposableRepositoryDeleteAuthority({
      client: githubClient,
      owner: githubLogin,
      onProbeRegistered: registerGithubProbe,
    });
    await deleteRegisteredGithubProbesAndVerify(ownedGithubProbeRepositories);

    cleanup.registerAtCreate("Linear issue cleanup", async () => {
      if (!harness) return;
      const cleanupFailures: string[] = [];
      if (issueId) ownedLinearIssueIds.add(issueId);
      try {
        const cleanupSnapshot = await readRawRunSnapshot(harness.page);
        addOwnedLinearIssueIdsFromReceipts(
          ownedLinearIssueIds,
          cleanupSnapshot?.lastReceipts,
        );
      } catch (error) {
        cleanupFailures.push(
          `receipt discovery failed: ${boundedCleanupError(error)}`,
        );
      }
      try {
        const observed = await readToolExecutionObserver(
          harness.page,
          observedToolJournal,
        );
        addOwnedLinearIssueIdsFromReceipts(
          ownedLinearIssueIds,
          observed.map((event) => event.receipt),
        );
      } catch (error) {
        cleanupFailures.push(
          `observer receipt discovery failed: ${boundedCleanupError(error)}`,
        );
      }
      try {
        for (const publication of await readCompleteResearchPublications(
          harness.page,
          notePath,
        )) {
          if (publication.issueId) {
            ownedLinearIssueIds.add(publication.issueId);
          }
        }
      } catch (error) {
        cleanupFailures.push(
          `checkpoint discovery failed: ${boundedCleanupError(error)}`,
        );
      }
      try {
        for (const issue of await retryTransientExternalCleanupRead(
          () => findLinearIssuesByMarker(harness!.page, marker, teamId),
          { maxAttempts: 3 },
        )) {
          if (issue.id) {
            ownedLinearIssueIds.add(issue.id);
          }
        }
      } catch (error) {
        cleanupFailures.push(
          `provider marker discovery failed: ${boundedCleanupError(error)}`,
        );
      }
      for (const ownedIssueId of [...ownedLinearIssueIds].sort()) {
        try {
          const cleanupProof = await cleanupLinearIssue(
            harness.page,
            ownedIssueId,
            marker,
            teamId,
          );
          test.info().annotations.push({
            type: "byok-linear-cleanup-v1",
            description: JSON.stringify(cleanupProof),
          });
        } catch (error) {
          cleanupFailures.push(
            `issue ${ownedIssueId} cleanup failed: ${boundedCleanupError(error)}`,
          );
        }
      }
      try {
        const survivors = await retryTransientExternalCleanupRead(
          () => findLinearIssuesByMarker(harness!.page, marker, teamId),
          { maxAttempts: 3 },
        );
        if (survivors.length > 0) {
          cleanupFailures.push(
            `survivors=${survivors.map((issue) => issue.id).join(", ")}`,
          );
        }
      } catch (error) {
        cleanupFailures.push(
          `zero-survivor readback failed: ${boundedCleanupError(error)}`,
        );
      }
      if (cleanupFailures.length > 0) {
        throw new Error(
          `Disposable BYOK Linear cleanup was incomplete: ${cleanupFailures.join(
            " | ",
          )}.`,
        );
      }
      ownedLinearIssueIds.clear();
      issueId = null;
      observations.observe("cleanup", "cleanup:linear_fixture");
    });
    cleanup.registerAtCreate("Workspace cleanup", async () => {
      if (!workspaceRoot || !workspaceBranch) return;
      await activeFixture.removeOwnedWorktree(workspaceRoot, workspaceBranch);
      workspaceRoot = null;
      workspaceBranch = null;
    });
    await expectTrustedRepositoryProfile(
      harness.page,
      PROFILE_KEY,
      activeFixture.root,
    );
    await harness.seedNote(
      notePath,
      [
        `# Autonomous BYOK CRDT research ${marker}`,
        "",
        "This initiating note is intentionally empty before the model researches.",
        "",
      ].join("\n"),
      true,
    );
    const sources = sourceUrls(marker);
    await installFourSourceResearchBackend(harness.page, marker);
    await installToolExecutionObserver(harness.page, observedToolJournal);
    const phaseAStartCounters = harness.readProgressCounters();

    // Phase A deliberately describes the outcome and behavioral problem, not a
    // tool sequence, filename, implementation, or source-by-source conclusion.
    const phaseAPrompt = buildByokPhaseAResearchPrompt({
      marker,
      profileKey: PROFILE_KEY,
      validationProfileKey: VALIDATION_PROFILE_KEY,
    });
    expect(
      hasExplicitResearchPublicationIntent(phaseAPrompt),
      "the exact live Phase A prompt must select atomic accepted-research publication",
    ).toBe(true);
    await harness.submitMission(phaseAPrompt, {
      waitForCompletion: false,
      timeoutMs: 70 * 60_000,
    });
    approvalCount += await harness.approveUntilMissionComplete(70 * 60_000, {
      maxContinuations: 4,
    });
    const phaseAProgressCounters = harness.readProgressCounters();
    expect(phaseAProgressCounters.approvals).toBe(approvalCount);
    continuationCount = phaseAProgressCounters.continuations;
    const phaseAModelCallDelta = requirePositiveCounterDelta(
      phaseAStartCounters.modelCalls,
      phaseAProgressCounters.modelCalls,
      "Phase A model calls",
    );
    modelCallCount += phaseAModelCallDelta;
    const phaseASnapshot = await harness.attestProductionRun({
      requireStructuredRouting: true,
    });
    const phaseAProviderUsage = assertPhaseModelCallAccounting(
      phaseAStartCounters,
      phaseAProgressCounters,
      phaseAModelCallDelta,
      phaseASnapshot,
      "Phase A",
    );
    expectSuccessfulProductionCalls(phaseASnapshot, harness.config.model);
    const phaseAScorecard = requirePassingMissionScorecard(
      phaseASnapshot.lastMissionScorecard,
      "Phase A",
    );
    assertAuthoritativeMissionGraph(phaseASnapshot, "Phase A");
    annotatePhaseScorecard(test.info(), {
      version: 1,
      phase: "A",
      runId: String(phaseASnapshot.runId ?? ""),
      scope: "accepted_research_to_linear",
      providerUsage: phaseAProviderUsage,
      scorecard: phaseAScorecard,
    });
    expect(phaseASnapshot.lastComplete?.stopReason).not.toBe("budget");
    expect(phaseASnapshot.lastComplete?.autoContinueReason).not.toBe(
      "no_progress",
    );
    expect(phaseASnapshot.lastComplete?.stopDetail ?? "").not.toMatch(
      /set_loose_delivery_unpaid|no_progress/iu,
    );

    const researchMetrics = await readResearchBackendMetrics(harness.page);
    expect(researchMetrics.searchCalls).toBeGreaterThanOrEqual(1);
    expect(new Set(researchMetrics.fetchedUrls)).toEqual(new Set(sources));
    expect(researchMetrics.fetchCalls).toBeGreaterThanOrEqual(4);
    const fetchedEvidence = phaseASnapshot.missionEvidence.filter(
      (item: any) =>
        item?.kind === "web_source" &&
        item?.usableSource === true &&
        item?.parserStatus === "parsed" &&
        Array.isArray(item?.passageIds) &&
        item.passageIds.length > 0,
    );
    expect(fetchedEvidence.length).toBeGreaterThanOrEqual(4);
    expect(
      new Set(fetchedEvidence.map((item: any) => String(item?.id ?? ""))).size,
      "Phase A must retain four distinct usable fetched-source evidence records",
    ).toBeGreaterThanOrEqual(4);
    observations.observe("proofs", "research:four_distinct_sources");

    const phaseAObservedTools = await readToolExecutionObserver(
      harness.page,
      observedToolJournal,
    );
    expect(
      phaseAObservedTools.some((event) => event.ok && event.name === "web_search"),
      JSON.stringify(phaseAObservedTools),
    ).toBe(true);
    expect(
      phaseAObservedTools.filter(
        (event) => event.ok && event.name === "web_fetch",
      ).length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      phaseAObservedTools.some(
        (event) =>
          event.ok && event.name === "publish_research_to_linear",
      ),
      JSON.stringify(phaseAObservedTools),
    ).toBe(true);
    expect(
      phaseAObservedTools.some(
        (event) => event.ok && CODE_MUTATION_TOOLS.has(event.name),
      ),
      "Phase A must not mutate code",
    ).toBe(false);
    expect(
      phaseAObservedTools.some(
        (event) =>
          event.ok &&
          [
            "linear_create_project",
            "linear_create_initiative",
            "publish_research_project_to_linear",
          ].includes(event.name),
      ),
      "Phase A must not create an unused Linear project or initiative",
    ).toBe(false);
    await assertGraphRuntimeLinkage(
      phaseASnapshot,
      phaseAObservedTools,
      [
        { toolName: "web_search", minimumEvents: 1 },
        { toolName: "web_fetch", minimumEvents: 4 },
        { toolName: "publish_research_to_linear", minimumEvents: 1 },
      ],
      "Phase A",
    );
    const phaseANote = await readVaultNote(harness.page, notePath);
    expect(phaseANote).not.toMatch(
      /^## (?:Mission completion reflection|Agent project reflection|Flow real reflection)\s*$/gimu,
    );
    for (const source of sources) {
      expect(phaseANote, `initiating note omitted ${source}`).toContain(source);
    }
    expect(phaseANote).toMatch(/pointwise(?: |-)?max|pointwise maximum/iu);
    expect(phaseANote).toMatch(/observed[- ]remove/iu);
    expect(phaseANote).toMatch(/concurrent add/iu);
    expect(phaseANote).toMatch(/idempotent|convergen/iu);

    const publications = await readCompleteResearchPublications(
      harness.page,
      notePath,
    );
    expect(
      publications,
      "the root mission must own exactly one completed research publication",
    ).toHaveLength(1);
    const publication = publications[0] ?? null;
    expect(publication, "accepted-research checkpoint must be complete").not.toBeNull();
    issueId = publication!.issueId;
    ownedLinearIssueIds.add(issueId);
    expect(issueId).toMatch(/^[A-Za-z0-9-]{8,}$/u);
    expect(publication!.backlinkVerified).toBe(true);
    expect(publication!.artifactFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(phaseASnapshot.attestedRunLineage?.segmentIds).toContain(
      publication!.originRunId,
    );
    expect(phaseASnapshot.attestedRunLineage?.rootRunId).toBe(
      publication!.originRunId,
    );
    expect(publication!.notePath).toBe(notePath);
    expect(publication!.evidenceReferences).toEqual(
      expect.arrayContaining(sources),
    );
    const phaseALinearCreateReceipts = phaseASnapshot.lastReceipts.filter(
      (receipt: any) =>
        receipt?.toolName === "linear_create_issue" &&
        receipt?.operation === "create" &&
        receipt?.resource?.system === "linear" &&
        receipt?.resource?.resourceType === "issue" &&
        receipt?.readback?.status === "verified",
    );
    addOwnedLinearIssueIdsFromReceipts(
      ownedLinearIssueIds,
      phaseALinearCreateReceipts,
    );
    expect(
      phaseALinearCreateReceipts,
      "Phase A must produce exactly one verified Linear issue creation receipt",
    ).toHaveLength(1);
    const publicationReceipts = phaseALinearCreateReceipts.filter(
      (receipt: any) => receipt?.resource?.id === issueId,
    );
    expect(publicationReceipts).toHaveLength(1);
    expect(phaseASnapshot.attestedRunLineage?.segmentIds).toContain(
      publicationReceipts[0]?.runId,
    );
    observations.observe("artifacts", "vault:accepted_research_note");
    observations.observe("proofs", "research:accepted_lineage");
    const activeMarkerIssues = await findLinearIssuesByMarker(
      harness.page,
      marker,
      teamId,
    );
    expect(
      activeMarkerIssues,
      "Phase A must create exactly one active marker-owned Linear issue",
    ).toHaveLength(1);
    expect(activeMarkerIssues[0]?.id).toBe(issueId);

    const phaseAIssue = await readLinearIssue(harness.page, issueId);
    expect(phaseAIssue.id).toBe(issueId);
    expect(phaseAIssue.url).toMatch(/^https:\/\/linear\.app\//iu);
    expect(phaseAIssue.trashed).toBe(false);
    expect(phaseAIssue.projectId).toBe("");
    for (const source of sources) {
      expect(phaseAIssue.description, `Linear issue omitted ${source}`).toContain(
        source,
      );
    }
    expect(phaseAIssue.description).toContain(PROFILE_KEY);
    expect(phaseAIssue.description).toContain(VALIDATION_PROFILE_KEY);
    expect(phaseAIssue.description).toContain(marker);
    expect(phaseAIssue.description).toMatch(/GCounter/iu);
    expect(phaseAIssue.description).toMatch(/ORSet/iu);
    expect(phaseAIssue.description).toMatch(/concurrent add/iu);
    expect(phaseAIssue.description).toContain("crdt_sync.py");
    expect(phaseAIssue.description).toContain("README.md");
    expect(phaseAIssue.description).toContain(publication!.artifactFingerprint);
    expect(phaseANote).toContain(phaseAIssue.url);
    observations.observe("artifacts", "linear:implementation_issue");
    observations.observe("proofs", "linear:provider_readback");
    observations.observe("bindings", "binding:note_linear_issue");

    // Phase A is a complete durable checkpoint. Restore its page-local
    // instrumentation, clear user/assistant and active-note context, then
    // restart the production plugin before Phase B. This bounds renderer/plugin
    // state across the two long live missions while proving that the accepted
    // note and Linear identity survive the same native lifecycle users rely on.
    const phaseASourceCleanup = await restoreToolExecutionObserver(harness.page);
    expect(phaseASourceCleanup.observerRestored).toBe(true);
    expect(phaseASourceCleanup.researchRestored).toBe(true);
    expect(phaseASourceCleanup.researchMetricsRemoved).toBe(true);
    sourceBackendRestored = true;
    await clearModelChatAndActiveNoteContext(harness);
    await harness.relaunch();
    await installToolExecutionObserver(harness.page, observedToolJournal);
    expect(await visibleChatText(harness.page)).not.toContain(marker);
    const beforePhaseBObservedTools = await readToolExecutionObserver(
      harness.page,
      observedToolJournal,
    );
    phaseBSequenceStart = Math.max(
      -1,
      ...beforePhaseBObservedTools.map((event) => event.sequence),
    );
    const phaseBStartCounters = harness.readProgressCounters();

    const phaseBPrompt = [
      `Review and implement Linear issue ${issueId}. Begin with an independent linear_get_issue read of that exact identity and treat its signed accepted-research contract as the sole product specification.`,
      "When the work is complete, write exactly one 35-100 word human reflection to the accepted research's initiating note through its durable lineage. Mention the research, Linear issue, code outcome, tests, draft pull request, and one honest remaining limitation without tool, receipt, run, or internal-path jargon.",
      "Publish the exact behaviorally tested commit to the issue-bound private GitHub destination as one open draft pull request; never merge it.",
      "Implement the requested Python library in its bound trusted repository and honor the issue-required public artifacts while choosing the internal design yourself. Create an additional implementation file only when the independently read issue contract or latest validator diagnostic requires it, only within repositoryWriteScope.allowedPaths, and never use a substitute helper or validator file as recovery. Inspect protected acceptance material as needed, validate against the issue contract before committing, and create one verified local commit.",
      "Deliver the final verified working directory to a new absolute Desktop folder that a normal IDE can open. Do not overwrite an existing folder.",
      "Do not ask me for a filename, workspace ID, repository key, validation command, marker, or GitHub repository name: obtain those only from the Linear issue and trusted host bindings.",
    ].join(" ");
    expect(
      phaseBPrompt,
      "Phase B must not smuggle Phase A implementation data besides issue identity",
    ).not.toMatch(new RegExp(`${PROFILE_KEY}|${VALIDATION_PROFILE_KEY}|${marker}|${repository}`, "u"));

    phaseBSubmitted = true;
    await harness.submitMission(phaseBPrompt, {
      waitForCompletion: false,
      timeoutMs: 70 * 60_000,
    });
    const phaseBSubmissionPage = harness.page;
    const capturedPhaseBRun = { id: "" };
    await expect
      .poll(
        async () => {
          const candidate = boundedDiagnosticString(
            (await readRawRunSnapshot(phaseBSubmissionPage))?.runId,
            240,
          );
          if (!candidate || candidate === phaseASnapshot.runId) return "";
          capturedPhaseBRun.id = candidate;
          return candidate;
        },
        {
          timeout: 30_000,
          message:
            "the production plugin must expose a new durable Phase B run after submission",
        },
      )
      .toMatch(/^run-/u);
    if (!/^run-/u.test(capturedPhaseBRun.id)) {
      throw new Error(
        "Phase B submission completed without exposing its durable run identity.",
      );
    }
    phaseBRunId = capturedPhaseBRun.id;
    expect(phaseBRunId).not.toBe(phaseASnapshot.runId);
    try {
      await harness.approveUntilMissionComplete(70 * 60_000, {
        maxContinuations: 18,
      });
    } catch (error) {
      if (!isOwnedObsidianPageClosure(error)) throw error;
      const usedContinuations = Math.max(
        0,
        harness.readProgressCounters().continuations -
          phaseBStartCounters.continuations,
      );
      const remainingContinuations = 18 - usedContinuations;
      if (remainingContinuations <= 0) {
        throw new Error(
          `Phase B exhausted its 18-continuation recovery bound before owned-process relaunch; used=${usedContinuations}.`,
        );
      }
      await harness.relaunch();
      await installToolExecutionObserver(harness.page, observedToolJournal);
      await expect
        .poll(
          async () =>
            boundedDiagnosticString(
              (await readRawRunSnapshot(harness!.page))?.runId,
              240,
            ),
          {
            timeout: 30_000,
            message:
              "the relaunched native host must hydrate the exact submitted Phase B run",
          },
        )
        .toBe(phaseBRunId);
      await harness.approveUntilMissionComplete(70 * 60_000, {
        maxContinuations: remainingContinuations,
      });
    }
    const progressCounters = harness.readProgressCounters();
    approvalCount = progressCounters.approvals;
    continuationCount = progressCounters.continuations;
    const phaseBModelCallDelta = requirePositiveCounterDelta(
      phaseBStartCounters.modelCalls,
      progressCounters.modelCalls,
      "Phase B model calls",
    );
    modelCallCount += phaseBModelCallDelta;
    expect(modelCallCount).toBe(progressCounters.modelCalls);
    const phaseBSnapshot = await harness.attestProductionRun({
      requireStructuredRouting: true,
    });
    phaseBRunId = boundedDiagnosticString(phaseBSnapshot.runId, 240);
    if (!isPassingMissionScorecardLike(phaseBSnapshot.lastMissionScorecard)) {
      const diagnosticObservedTools = await readToolExecutionObserver(
        harness.page,
        observedToolJournal,
      ).catch(() => [] as ObservedToolExecution[]);
      annotatePhaseBProductionDiagnostic(
        test.info(),
        phaseBSnapshot,
        diagnosticObservedTools,
        phaseBSequenceStart,
        phaseBRunId,
      );
      phaseBDiagnosticAnnotated = true;
    }
    const phaseBProviderUsage = assertPhaseModelCallAccounting(
      phaseBStartCounters,
      progressCounters,
      phaseBModelCallDelta,
      phaseBSnapshot,
      "Phase B",
    );
    expect(phaseBSnapshot.runId).not.toBe(phaseASnapshot.runId);
    expectSuccessfulProductionCalls(phaseBSnapshot, harness.config.model);
    const phaseBScorecard = requirePassingMissionScorecard(
      phaseBSnapshot.lastMissionScorecard,
      "Phase B",
    );
    assertAuthoritativeMissionGraph(phaseBSnapshot, "Phase B");
    annotatePhaseScorecard(test.info(), {
      version: 1,
      phase: "B",
      runId: String(phaseBSnapshot.runId ?? ""),
      scope: "linear_to_tested_code_github_and_reflection",
      providerUsage: phaseBProviderUsage,
      scorecard: phaseBScorecard,
    });
    finalMissionScorecard = phaseBScorecard;
    const observedTools = await readToolExecutionObserver(
      harness.page,
      observedToolJournal,
    );
    expect(
      observedTools.length,
      "the bounded Node-side tool journal must not truncate the live journey",
    ).toBeLessThan(MAX_OBSERVED_TOOL_JOURNAL_EVENTS);
    toolCallCount = observedTools.length;
    const phaseBObservedTools = observedTools.filter(
      (event) => event.sequence > (phaseBSequenceStart ?? -1),
    );
    const linearRead = phaseBObservedTools.find(
      (event) =>
        event.name === "linear_get_issue" &&
        event.ok &&
        event.linearIssueId === issueId,
    );
    const firstCodeMutation = phaseBObservedTools.find(
      (event) => event.ok && CODE_MUTATION_TOOLS.has(event.name),
    );
    expect(linearRead, JSON.stringify(observedTools)).toBeTruthy();
    expect(linearRead!.linearIssueId).toBe(issueId);
    expect(firstCodeMutation, JSON.stringify(observedTools)).toBeTruthy();
    expect(linearRead!.sequence).toBeLessThan(firstCodeMutation!.sequence);
    expect(Date.parse(linearRead!.completedAt)).toBeLessThanOrEqual(
      Date.parse(firstCodeMutation!.startedAt),
    );
    observations.observe("proofs", "linear:independent_phase_b_read");
    const successfulRepositoryMutations = phaseBObservedTools.filter(
      (event) =>
        event.ok && REPOSITORY_FILE_MUTATION_TOOLS.has(event.name),
    );
    const successfulCommitEvents = phaseBObservedTools.filter(
      (event) => event.ok && event.name === "code_commit_verified",
    );
    expect(
      successfulCommitEvents,
      "idempotency requires exactly one successful verified commit action",
    ).toHaveLength(1);
    const successfulExportEvents = phaseBObservedTools.filter(
      (event) =>
        event.ok && event.name === "code_workspace_export_directory",
    );
    expect(
      successfulExportEvents,
      "idempotency requires exactly one successful Desktop export action",
    ).toHaveLength(1);
    expect(successfulExportEvents[0]?.receipt?.readbackStatus).toBe("verified");
    expect(successfulExportEvents[0]?.receipt?.path).toBeTruthy();
    await assertGraphRuntimeLinkage(
      phaseBSnapshot,
      phaseBObservedTools,
      [
        { toolName: "linear_get_issue", minimumEvents: 1 },
        { toolName: "code_validate_targeted", minimumEvents: 1 },
        { toolName: "code_validate_full", minimumEvents: 1 },
        { toolName: "code_commit_verified", minimumEvents: 1 },
        {
          toolName: "code_workspace_export_directory",
          minimumEvents: 1,
        },
        {
          toolName: "publish_verified_code_to_github",
          minimumEvents: 1,
        },
      ],
      "Phase B",
    );
    observations.observe("proofs", "graph:authoritative");
    expect(successfulRepositoryMutations.length).toBeGreaterThan(0);
    for (const event of successfulRepositoryMutations) {
      expect(
        event.workspacePaths?.length,
        `repository mutation omitted its observed paths: ${JSON.stringify(event)}`,
      ).toBeGreaterThan(0);
      for (const candidate of event.workspacePaths ?? []) {
        expect(
          TRUSTED_REPOSITORY_WRITE_PATHS.some(
            (allowedPath) =>
              candidate === allowedPath ||
              candidate.startsWith(`${allowedPath}/`),
          ),
          `successful repository mutation escaped trusted scope: ${JSON.stringify(event)}`,
        ).toBe(true);
      }
    }
    const authorityEvidence =
      assertSuccessfulMutationAuthority(observedTools);
    expect(authorityEvidence.nestedApprovedTools).toContain(
      "publish_research_to_linear",
    );
    observations.observe("approvals", "approval:linear_issue_create");
    expect(authorityEvidence.preparedAuthorizedTools).toEqual(
      expect.arrayContaining([
        "code_validate_targeted",
        "code_validate_full",
      ]),
    );
    observations.observe("approvals", "authorization:sandbox_execution");
    expect(authorityEvidence.nestedApprovedTools).toContain(
      "github_create_repository",
    );
    observations.observe(
      "approvals",
      "approval:github_private_repository_create",
    );
    expect(authorityEvidence.nestedApprovedTools).toContain(
      "publish_verified_code_to_github",
    );
    observations.observe("approvals", "approval:github_publish");

    const handoff = await readVerifiedCodeHandoff(
      harness.page,
      PROFILE_KEY,
    );
    expect(handoff?.status).toBe("verified");
    expect(handoff?.commitSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(handoff?.targetedValidationReceiptId).toBeTruthy();
    expect(handoff?.fullValidationReceiptId).toBeTruthy();
    expect(handoff?.localCommitReceiptId).toBeTruthy();
    expect(handoff?.workspaceId).toBeTruthy();
    const successfulWorkspaceCreateEvents = phaseBObservedTools.filter(
      (event) =>
        event.ok &&
        event.name === "code_workspace_create" &&
        event.receipt?.readbackStatus === "verified",
    );
    expect(
      successfulWorkspaceCreateEvents,
      "Phase B must create exactly one receipt-backed durable workspace",
    ).toHaveLength(1);
    const workspaceCreateEvent = successfulWorkspaceCreateEvents[0]!;
    const createdWorkspaceId = workspaceCreateEvent.receipt?.workspaceId;
    expect(createdWorkspaceId).toBeTruthy();
    expect(workspaceCreateEvent.workspaceId).toBe(createdWorkspaceId);
    expect(workspaceCreateEvent.preparedAction?.workspaceId).toBe(
      createdWorkspaceId,
    );
    expect(
      workspaceCreateEvent.preparedAction?.normalizedWorkspaceId,
    ).toBe(createdWorkspaceId);
    expect(handoff?.workspaceId).toBe(createdWorkspaceId);
    const successfulCreateFileEvents = phaseBObservedTools.filter(
      (event) => event.ok && event.name === "code_workspace_create_file",
    );
    expect(successfulCreateFileEvents.length).toBeGreaterThan(0);
    for (const event of phaseBObservedTools.filter(
      (candidate) =>
        candidate.sequence > workspaceCreateEvent.sequence &&
        (/^code_workspace_/u.test(candidate.name) ||
          /^code_validate_/u.test(candidate.name) ||
          candidate.name === "code_repair_record_cycle" ||
          candidate.name === "code_repair_status" ||
          candidate.name === "code_commit_verified"),
    )) {
      const observedWorkspaceIds = [
        event.workspaceId,
        event.preparedAction?.workspaceId,
        event.preparedAction?.normalizedWorkspaceId,
        event.receipt?.workspaceId,
      ].filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      );
      if (observedWorkspaceIds.length === 0) continue;
      expect(
        [...new Set(observedWorkspaceIds)],
        `workspace identity drifted after creation: ${JSON.stringify(event)}`,
      ).toEqual([createdWorkspaceId]);
    }
    observations.observe("bindings", "binding:durable_workspace_identity");
    assertSandboxValidationReceipt(
      phaseBSnapshot,
      "code_validate_targeted",
      String(handoff!.targetedValidationReceiptId),
      String(handoff!.workspaceId),
    );
    assertSandboxValidationReceipt(
      phaseBSnapshot,
      "code_validate_full",
      String(handoff!.fullValidationReceiptId),
      String(handoff!.workspaceId),
    );
    observations.observe("proofs", "validation:targeted");
    observations.observe("proofs", "validation:fresh_full");
    const workspace = await resolveWorkspaceBinding(
      harness.page,
      String(handoff.workspaceId),
    );
    workspaceRoot = workspace.root;
    workspaceBranch = workspace.branch;
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (!localAppData) {
      throw new Error(
        "LOCALAPPDATA is required for exact BYOK workspace metadata cleanup.",
      );
    }
    workspaceMetadataInventory =
      await inventoryOwnedRepositoryWorkspaceMetadata({
        applicationDataRoot: path.join(localAppData, "AgenticResearcher"),
        repositoryRoot: activeFixture.root,
      });
    expect(
      workspaceMetadataInventory.selected.map(
        (selection) => selection.workspaceId,
      ),
      "the exact disposable repository must own one durable workspace metadata container",
    ).toEqual([createdWorkspaceId]);

    const worktree = await activeFixture.inspectWorktree(workspaceRoot);
    expect(worktree.head).toBe(handoff.commitSha);
    expect(worktree.head).not.toBe(activeFixture.baseSha);
    expect(worktree.commitCount, "the agent must create exactly one verified commit").toBe(1);
    expect(worktree.status).toBe("");
    expect(worktree.changedPaths).toEqual(
      expect.arrayContaining(["README.md", "crdt_sync.py"]),
    );
    expect(
      worktree.changedPaths.some(
        (candidate) =>
          candidate === "scripts" ||
          candidate.startsWith("scripts/") ||
          candidate === "tests" ||
          candidate.startsWith("tests/"),
      ),
      "protected acceptance material must remain untouched",
    ).toBe(false);
    expect(worktree.moduleSource).toContain(marker);
    expect(worktree.moduleSource).toMatch(/class\s+GCounter\b/u);
    expect(worktree.moduleSource).toMatch(/class\s+ORSet\b/u);
    expect(worktree.readme).toContain(marker);
    await activeFixture.assertProtectedContract(workspaceRoot);
    observations.observe("proofs", "code:protected_contract");
    const committedTreeSnapshot = await activeFixture.snapshotTree(workspaceRoot);

    const identity = await readLocalCommitIdentity(workspaceRoot);
    expect(identity.sha).toBe(handoff.commitSha);
    expect(identity.authorName).toBe("Agentic Researcher");
    expect(identity.authorEmail).toBe("agentic-researcher@example.invalid");
    expect(identity.committerName).toBe("Agentic Researcher");
    expect(identity.committerEmail).toBe("agentic-researcher@example.invalid");
    observations.observe("artifacts", "git:verified_commit");
    observations.observe("proofs", "git:neutral_identity");

    const exportReceipt = requireVerifiedExportReceipt(phaseBSnapshot);
    const ownedExport = ownedDesktopExportFromReceipt(
      exportReceipt,
      expectedExportLabel,
    );
    expect(phaseBSnapshot.attestedRunLineage?.segmentIds).toContain(
      ownedExport.runId,
    );
    expect(
      successfulExportEvents[0]?.preparedAction?.runId,
      "the prepared export action must retain its executing segment run id",
    ).toBe(exportReceipt.runId);
    expect(successfulExportEvents[0]?.receipt?.runId).toBe(ownedExport.runId);
    expect(
      path.resolve(String(successfulExportEvents[0]?.receipt?.path ?? "")),
    ).toBe(path.resolve(ownedExport.path));
    expect(successfulExportEvents[0]?.receipt).toMatchObject({
      id: exportReceipt.id,
      actionId: exportReceipt.actionId,
      payloadFingerprint: exportReceipt.payloadFingerprint,
      grantId: exportReceipt.grantId,
      readbackStatus: "verified",
      runId: exportReceipt.runId,
    });
    expect(exportReceipt.resource?.system).toBe("workspace");
    expect(exportReceipt.resource?.resourceType).toBe("host_directory");
    expect(exportReceipt.resource?.workspaceId).toBe(handoff.workspaceId);
    expect(exportReceipt.resource?.id).toBe(
      `host-directory:desktop:${ownedExport.directoryName}`,
    );
    exportPath = ownedExport.path;
    expectedExportDirectoryName = ownedExport.directoryName;
    registerObservedOwnedExport(
      observedOwnedExportPaths,
      preexistingOwnedExportPaths,
      ownedExport,
    );
    desktopRoot = await resolveDesktopRoot();
    const canonicalExport = await assertSafeDesktopExport(
      desktopRoot,
      exportPath,
      ownedExport.directoryName,
      sandboxReadinessStartedAt,
    );
    expect(path.resolve(String(successfulExportEvents[0]!.receipt!.path))).toBe(
      canonicalExport,
    );
    expect(exportReceipt.readback?.status).toBe("verified");
    expect(exportReceipt.effects?.bytesWritten).toBeGreaterThan(0);
    const exportedFiles = await listRelativeFiles(canonicalExport);
    expect(exportedFiles).toEqual(
      expect.arrayContaining([
        "README.md",
        "crdt_sync.py",
        "scripts/verify_project.py",
        "tests/test_crdt_contract.py",
      ]),
    );
    await activeFixture.assertProtectedContract(canonicalExport);
    expect(await activeFixture.snapshotTree(canonicalExport)).toEqual(
      committedTreeSnapshot,
    );
    exportVerified = true;
    observations.observe("artifacts", "code:ide_readable_export");
    observations.observe("bindings", "binding:desktop_commit_tree");

    const publicationProof = await readFinalizedGithubPublication(
      harness.page,
      repository,
    );
    expect(publicationProof.status).toBe("finalized");
    expect(publicationProof.headSha).toBe(handoff.commitSha);
    expect(publicationProof.remoteSha).toBe(handoff.commitSha);
    expect(publicationProof.pullRequest?.head?.sha).toBe(handoff.commitSha);
    expect(publicationProof.pullRequest?.draft).toBe(true);
    expect(publicationProof.linearLinkReceiptId).toBeTruthy();
    expect(publicationProof.obsidianReceiptId).toBeTruthy();
    expect(publicationProof.linearCompletionReceiptId).toBeTruthy();
    const linearLinkReceipt = await readExternalActionReceipt(
      harness.page,
      String(publicationProof.linearLinkReceiptId),
    );
    assertExternalReceiptMatchesNestedApproval(
      linearLinkReceipt,
      authorityEvidence.successfulMutationEvents,
      "linear_create_comment",
      "Linear publication link",
    );
    const linearCompletionReceipt = await readExternalActionReceipt(
      harness.page,
      String(publicationProof.linearCompletionReceiptId),
    );
    assertExternalReceiptMatchesNestedApproval(
      linearCompletionReceipt,
      authorityEvidence.successfulMutationEvents,
      "linear_update_issue",
      "Linear completion",
    );
    observations.observe("bindings", "binding:linear_commit");

    if (!githubClient || !githubLogin) {
      throw new Error("Verified GitHub identity was lost before readback.");
    }
    const remoteRepository = await githubClient.getRepository(
      githubLogin,
      repository,
    );
    expect(remoteRepository.private).toBe(true);
    expect(remoteRepository.permissions?.admin).toBe(true);
    const restGithubActor = await githubClient.getAuthenticatedUser();
    githubCleanupAuthority = await attestGhCleanupAuthority(
      restGithubActor,
      remoteRepository,
    );
    test.info().annotations.push({
      type: "byok-github-cleanup-authority-v1",
      description: JSON.stringify(githubCleanupAuthority),
    });
    observations.observe("artifacts", "github:private_repository");
    observations.observe("proofs", "github:private_visibility_readback");
    const remotePullRequest = await githubClient.getPullRequest(
      githubLogin,
      repository,
      publicationProof.pullRequest!.number,
    );
    expect(remotePullRequest.draft).toBe(true);
    expect(remotePullRequest.state).toBe("open");
    expect(remotePullRequest.merged).toBe(false);
    expect(remotePullRequest.head.sha).toBe(handoff.commitSha);
    const matchingPullRequests = await githubClient.listPullRequestsForHead(
      githubLogin,
      repository,
      remotePullRequest.head.ref,
      remotePullRequest.base.ref,
    );
    expect(matchingPullRequests).toHaveLength(1);
    expect(matchingPullRequests[0]?.number).toBe(remotePullRequest.number);
    observations.observe("artifacts", "github:draft_pull_request");
    observations.observe("proofs", "github:single_open_draft_readback");
    const remoteRef = await githubClient.getReference(
      githubLogin,
      repository,
      remotePullRequest.head.ref,
    );
    expect(remoteRef.sha).toBe(handoff.commitSha);
    expect((await githubClient.getCommit(
      githubLogin,
      repository,
      handoff.commitSha,
    )).sha).toBe(handoff.commitSha);
    observations.observe("proofs", "github:remote_sha_readback");
    observations.observe("bindings", "binding:commit_pr");

    const finalLinearIssue = await readLinearIssue(harness.page, issueId);
    expect(finalLinearIssue.description).toBe(phaseAIssue.description);
    expect(finalLinearIssue.stateType).toBe("completed");
    expect(finalLinearIssue.trashed).toBe(false);
    expect(finalLinearIssue.projectId).toBe("");

    const finalNoteViaProvider = await readVaultNote(harness.page, notePath);
    const finalNoteViaFilesystem = await readFile(
      path.join(harness.vaultRoot, ...notePath.split("/")),
      "utf8",
    );
    expect(finalNoteViaFilesystem).toBe(finalNoteViaProvider);
    const finalNoteSha256 = `sha256:${createHash("sha256")
      .update(finalNoteViaFilesystem, "utf8")
      .digest("hex")}`;
    expect(publicationProof.obsidianReceiptId).toBe(
      `github-note-reflection-${finalNoteSha256.slice(7, 39)}`,
    );
    const noteReflectionApproval = requireNestedApproval(
      authorityEvidence.successfulMutationEvents,
      "finalize_github_links_in_obsidian",
      "Obsidian completion reflection",
    );
    expect(noteReflectionApproval.preparedActionId).toBe(
      `github-obsidian-reflection-${String(publicationProof.publicationId)}`,
    );
    const reflection = extractVisibleCompletionReflection(finalNoteViaFilesystem);
    expect(reflection.count).toBe(1);
    expect(finalNoteViaFilesystem).not.toMatch(
      /^## Flow real reflection\s*$/gimu,
    );
    expect(reflection.wordCount).toBeGreaterThanOrEqual(35);
    expect(reflection.wordCount).toBeLessThanOrEqual(100);
    expect(reflection.visible).toContain(finalLinearIssue.url);
    expect(reflection.visible).toContain(remotePullRequest.htmlUrl);
    expect(reflection.visible).toMatch(/targeted and full validation passed/iu);
    expect(reflection.visible).toMatch(/GCounter|ORSet|CRDT/iu);
    expect(reflection.visible).toMatch(
      /published evidence stops at this draft|review.*merge.*deployment.*remain open|limitation|human review|merge remains|still open|follow-up/iu,
    );
    expect(reflection.visible).not.toMatch(
      /\breceipts?\b|\btool(?:ing|s)?\b|\brun(?: id)?\b|\bfingerprint\b|\bworkspace(?: id)?\b|\bhost[- ]verified\b/iu,
    );
    observations.observe("artifacts", "vault:completion_reflection");
    observations.observe("proofs", "reflection:human_35_100_words");
    observations.observe("bindings", "binding:note_pr");

    const finalPublications = await readCompleteResearchPublications(
      harness.page,
      notePath,
    );
    expect(
      finalPublications,
      "idempotency requires one durable research publication",
    ).toHaveLength(1);
    expect(finalPublications[0]?.issueId).toBe(issueId);
    const finalMarkerIssues = await findLinearIssuesByMarker(
      harness.page,
      marker,
      teamId,
    );
    expect(
      finalMarkerIssues,
      "idempotency requires one active provider issue",
    ).toHaveLength(1);
    expect(finalMarkerIssues[0]?.id).toBe(issueId);
    expect(
      matchingPullRequests,
      "idempotency requires one open draft pull request",
    ).toHaveLength(1);
    expect(
      reflection.count,
      "idempotency requires one visible completion reflection",
    ).toBe(1);
    observations.observe("proofs", "idempotency:no_duplicates");
    observations.observe("proofs", "authority:no_unapproved_mutations");

    expect(finalMissionScorecard).toBeTruthy();
    test.info().annotations.push({
      type: "byok-autonomous-journey",
      description: [
        `model=${harness.config.model}`,
        `linear=${finalLinearIssue.url}`,
        `repository=${remoteRepository.htmlUrl}`,
        `pullRequest=${remotePullRequest.htmlUrl}`,
        `commit=${handoff.commitSha}`,
        `export=${canonicalExport}`,
        `sources=${sources.length}`,
        "researchVia=owned-fixture",
        `reflectionWords=${reflection.wordCount}`,
      ].join(" "),
    });
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors: string[] = [];
    let preCleanupPage: Page | undefined;
    if (harness) {
      try {
        preCleanupPage = harness.page;
      } catch {
        preCleanupPage = undefined;
      }
    }
    // Any failed live assertion may leave the coordinator active. Relaunching
    // the same owned process first aborts that execution boundary, then hydrates
    // it idle/resumable so cleanup cannot race a still-running mutation.
    if (
      harness &&
      (primaryError !== null ||
        !preCleanupPage ||
        preCleanupPage.isClosed())
    ) {
      await harness
        .relaunch()
        .then(async () => {
          await installToolExecutionObserver(
            harness!.page,
            observedToolJournal,
          );
        })
        .catch((error) => {
          cleanupErrors.push(
            `Crash-safe harness relaunch: ${safeExternalCleanupError(error)}`,
          );
        });
    }
    let cleanupPage: Page | undefined;
    if (harness) {
      try {
        cleanupPage = harness.page;
      } catch (error) {
        cleanupErrors.push(
          `Cleanup page unavailable: ${safeExternalCleanupError(error)}`,
        );
      }
    }
    if (harness && cleanupPage) {
      const snapshot = await readRawRunSnapshot(cleanupPage).catch(() => null);
      if (!workspaceRoot || !workspaceBranch) {
        const workspaceId = snapshot
          ? String(
              snapshot.lastReceipts?.find(
                (receipt: any) => receipt?.toolName === "code_workspace_create",
              )?.resource?.workspaceId ?? "",
            )
          : "";
        if (workspaceId) {
          const binding = await resolveWorkspaceBinding(
            cleanupPage,
            workspaceId,
          ).catch(() => null);
          workspaceRoot = binding?.root ?? workspaceRoot;
          workspaceBranch = binding?.branch ?? workspaceBranch;
        }
      }
      const finalObservedTools = await readToolExecutionObserver(
        cleanupPage,
        observedToolJournal,
      ).catch((error) => {
        cleanupErrors.push(
          `Tool observer readback: ${safeExternalCleanupError(error)}`,
        );
        return [] as ObservedToolExecution[];
      });
      if (
        phaseBSubmitted &&
        primaryError !== null &&
        !phaseBDiagnosticAnnotated &&
        !isPassingMissionScorecardLike(snapshot?.lastMissionScorecard)
      ) {
        annotatePhaseBProductionDiagnostic(
          test.info(),
          snapshot,
          finalObservedTools,
          phaseBSequenceStart,
          phaseBRunId,
        );
        phaseBDiagnosticAnnotated = true;
      }
      for (const event of finalObservedTools) {
        if (
          event.name === "code_workspace_export_directory" &&
          event.preparedAction?.path &&
          event.preparedAction.runId
        ) {
          try {
            const owned = ownedDesktopExportFromReceipt(
              {
                path: event.preparedAction.path,
                runId: event.preparedAction.runId,
              },
              expectedExportLabel,
            );
            registerObservedOwnedExport(
              observedOwnedExportPaths,
              preexistingOwnedExportPaths,
              owned,
            );
            exportPath ??= owned.path;
            expectedExportDirectoryName ??= owned.directoryName;
          } catch (error) {
            cleanupErrors.push(
              `Prepared Desktop export target: ${safeExternalCleanupError(error)}`,
            );
          }
        }
        if (
          event.ok &&
          event.name === "code_workspace_export_directory" &&
          event.receipt?.path &&
          event.receipt.runId
        ) {
          try {
            const owned = ownedDesktopExportFromReceipt(
              event.receipt,
              expectedExportLabel,
            );
            registerObservedOwnedExport(
              observedOwnedExportPaths,
              preexistingOwnedExportPaths,
              owned,
            );
            exportPath ??= owned.path;
            expectedExportDirectoryName ??= owned.directoryName;
          } catch (error) {
            cleanupErrors.push(
              `Observed Desktop export: ${safeExternalCleanupError(error)}`,
            );
          }
        }
      }
      const exportReceipts = snapshot ? findExportReceipts(snapshot) : [];
      for (const receipt of exportReceipts) {
        try {
          const owned = ownedDesktopExportFromReceipt(
            receipt,
            expectedExportLabel,
          );
          registerObservedOwnedExport(
            observedOwnedExportPaths,
            preexistingOwnedExportPaths,
            owned,
          );
          exportPath ??= owned.path;
          expectedExportDirectoryName ??= owned.directoryName;
        } catch (error) {
          cleanupErrors.push(
            `Desktop export receipt: ${safeExternalCleanupError(error)}`,
          );
        }
      }
      exportVerified ||=
        exportReceipts.length === 1 &&
        exportReceipts[0]?.readback?.status === "verified";
    }
    if (desktopRoot) {
      try {
        finalNewOwnedExportPaths = await listNewOwnedExportCandidates(
          desktopRoot,
          expectedExportLabel,
          preexistingOwnedExportPaths,
        );
      } catch (error) {
        cleanupErrors.push(
          `Desktop export inventory: ${safeExternalCleanupError(error)}`,
        );
      }
    }
    if (!workspaceMetadataInventory && fixture && process.env.LOCALAPPDATA) {
      await inventoryOwnedRepositoryWorkspaceMetadata({
        applicationDataRoot: path.join(
          process.env.LOCALAPPDATA,
          "AgenticResearcher",
        ),
        repositoryRoot: fixture.root,
      })
        .then((inventory) => {
          workspaceMetadataInventory = inventory;
        })
        .catch((error) => {
          cleanupErrors.push(
            `Workspace metadata inventory: ${safeExternalCleanupError(error)}`,
          );
        });
    }
    cleanupErrors.push(...(await cleanup.cleanupAll()));
    const vaultNoteAbsolutePath = harness
      ? path.join(harness.vaultRoot, ...notePath.split("/"))
      : null;
    const sourceCleanup = await restoreToolExecutionObserver(
      cleanupPage,
    ).catch((error) => {
      cleanupErrors.push(`Observer cleanup: ${safeExternalCleanupError(error)}`);
      return null;
    });
    sourceBackendRestored ||=
      sourceCleanup?.researchRestored === true &&
      sourceCleanup.researchMetricsRemoved === true;
    if (harness && cleanupPage) {
      if (!vaultBackupBaseline) {
        cleanupErrors.push(
          "Vault backup cleanup: the pre-note .agent-backups baseline was not captured.",
        );
      } else {
        await deleteExactRunOwnedVaultBackups({
          page: cleanupPage,
          notePath,
          baselinePaths: vaultBackupBaseline,
        })
          .then((proof) => {
            for (const backupPath of proof.selectedPaths) {
              removedVaultBackupPaths.add(backupPath);
            }
          })
          .catch((error) => {
            onlineVaultBackupCleanupError = safeExternalCleanupError(error);
          });
      }
    }
    await harness?.close().catch((error) => {
      cleanupErrors.push(`Harness cleanup: ${safeExternalCleanupError(error)}`);
    });
    if (vaultBackupBaseline && vaultNoteAbsolutePath && harness) {
      const quarantineRoot = path.join(
        process.cwd(),
        "test-results",
        `byok-vault-backup-quarantine-${suffix}`,
      );
      try {
        const postClosePaths = await inventoryRootLevelVaultBackupPaths(
          harness.vaultRoot,
        );
        const postCloseSelection = selectPostBaselineOwnedVaultBackupPaths({
          notePath,
          baselinePaths: vaultBackupBaseline,
          currentPaths: postClosePaths,
        });
        if (postCloseSelection.paths.length > 0) {
          const proof = await quarantinePostBaselineOwnedVaultBackups({
            vaultRoot: harness.vaultRoot,
            notePath,
            baselinePaths: vaultBackupBaseline,
            quarantineRoot,
          });
          for (const backupPath of proof.selectedPaths) {
            removedVaultBackupPaths.add(backupPath);
          }
          await rm(quarantineRoot, { recursive: true, force: true });
        }
        const finalPaths = await inventoryRootLevelVaultBackupPaths(
          harness.vaultRoot,
        );
        const finalReadback = assertOwnedVaultBackupCleanupReadback({
          notePath,
          baselinePaths: vaultBackupBaseline,
          currentPaths: finalPaths,
        });
        vaultBackupAbsenceVerified = finalReadback.absenceVerified;
        test.info().annotations.push({
          type: "byok-vault-backup-cleanup-v1",
          description: JSON.stringify({
            version: 1,
            notePath,
            baselineCount: vaultBackupBaseline.length,
            selectedPaths: [...removedVaultBackupPaths].sort(),
            removed: removedVaultBackupPaths.size,
            survivors: finalReadback.survivors,
            absenceVerified: finalReadback.absenceVerified,
            finalReadback: "offline_after_process_close",
          }),
        });
      } catch (error) {
        cleanupErrors.push(
          `Offline vault backup cleanup: ${safeExternalCleanupError(error)}${
            onlineVaultBackupCleanupError
              ? `; online attempt: ${onlineVaultBackupCleanupError}`
              : ""
          }`,
        );
      }
    }
    if (vaultNoteAbsolutePath) {
      await Promise.all([
        assertPathAbsent(vaultNoteAbsolutePath),
        vaultBackupAbsenceVerified
          ? Promise.resolve()
          : Promise.reject(
              new Error(
                "Exact post-baseline vault backup absence was not verified.",
              ),
            ),
      ])
        .then(() => {
          observations.observe("cleanup", "cleanup:vault_fixture");
        })
        .catch((error) => {
          cleanupErrors.push(
            `Vault fixture cleanup: ${safeExternalCleanupError(error)}`,
          );
        });
    }
    if (fixture) {
      const fixtureRoot = fixture.root;
      let fixtureCleanupSucceeded = false;
      await fixture.cleanup()
        .then(() => {
          fixtureCleanupSucceeded = true;
        })
        .catch((error) => {
          cleanupErrors.push(
            `Fixture cleanup: ${safeExternalCleanupError(error)}`,
          );
        });
      if (fixtureCleanupSucceeded) {
        await assertPathAbsent(fixtureRoot)
          .then(() => {
            sourceFixtureRemoved = true;
          })
          .catch((error) => {
            cleanupErrors.push(
              `Source fixture readback: ${safeExternalCleanupError(error)}`,
            );
          });
      }
    }
    if (workspaceMetadataInventory) {
      await cleanupOwnedRepositoryWorkspaceMetadata(workspaceMetadataInventory)
        .then((proof) => {
          test.info().annotations.push({
            type: "byok-workspace-metadata-cleanup-v1",
            description: JSON.stringify(proof),
          });
          if (proof.selectedWorkspaceIds.length > 0) {
            observations.observe("cleanup", "cleanup:workspace_fixture");
          }
        })
        .catch((error) => {
          cleanupErrors.push(
            `Workspace metadata cleanup: ${safeExternalCleanupError(error)}`,
          );
        });
    }
    if (sourceBackendRestored && sourceFixtureRemoved) {
      observations.observe("cleanup", "cleanup:source_fixture");
    }
    let acceptanceRecorded = false;
    if (primaryError === null && cleanupErrors.length === 0) {
      try {
        if (!githubCleanupAuthority || !githubLogin) {
          throw new Error(
            "Authenticated GitHub cleanup authority was not attested before deletion.",
          );
        }
        const githubCleanupRepositories = [
          repository,
          ...[...ownedGithubProbeRepositories.values()].map(
            (probe) => probe.repository,
          ),
        ].sort();
        expect(new Set(githubCleanupRepositories).size).toBe(
          githubCleanupRepositories.length,
        );
        for (const candidate of githubCleanupRepositories) {
          expect(candidate).toMatch(
            candidate === repository
              ? /^e2e-byok-autonomous-[a-f0-9]{12}$/u
              : /^e2e-delete-probe-[a-f0-9]{12}$/u,
          );
        }
        await assertGhRepositoriesAbsentUnderActor(
          githubCleanupAuthority,
          githubLogin,
          githubCleanupRepositories,
        );
        test.info().annotations.push({
          type: "byok-github-cleanup-v1",
          description: JSON.stringify({
            version: 1,
            actorId: githubCleanupAuthority.actorId,
            actorLogin: githubCleanupAuthority.actorLogin,
            repositoryId: githubCleanupAuthority.repositoryId,
            repository: githubCleanupAuthority.repository,
            repositories: githubCleanupRepositories,
            state: "absent",
          }),
        });
        for (const token of [
          "cleanup:linear_fixture",
          "cleanup:github_fixture",
          "cleanup:vault_fixture",
          "cleanup:workspace_fixture",
          "cleanup:source_fixture",
        ] as const) {
          if (!observations.has("cleanup", token)) {
            throw new Error(
              `Independent cleanup readback is missing prerequisite ${token}.`,
            );
          }
        }
        observations.observe("cleanup", "cleanup:independent_readback");
        if (
          !desktopRoot ||
          !exportPath ||
          !expectedExportDirectoryName ||
          !exportVerified
        ) {
          throw new Error(
            "A verified Desktop export was unavailable at final acceptance.",
          );
        }
        const canonicalExport = await assertSafeDesktopExport(
          desktopRoot,
          exportPath,
          expectedExportDirectoryName,
          sandboxReadinessStartedAt,
        );
        if (
          finalNewOwnedExportPaths.length !== 1 ||
          normalizePathCase(finalNewOwnedExportPaths[0] ?? "") !==
            normalizePathCase(canonicalExport)
        ) {
          throw new Error(
            `Expected one exact new Desktop export after baseline reconciliation, found ${
              finalNewOwnedExportPaths.join(", ") || "none"
            }.`,
          );
        }
        if (
          observedOwnedExportPaths.size !== 1 ||
          normalizePathCase([...observedOwnedExportPaths.keys()][0] ?? "") !==
            normalizePathCase(canonicalExport)
        ) {
          throw new Error(
            `Expected one exact observed Desktop export, found ${[
              ...observedOwnedExportPaths.keys(),
            ].join(", ") || "none"}.`,
          );
        }
        observations.observe("cleanup", "cleanup:retained_export_verified");
        await recordDailyUseAcceptance(
          test.info(),
          "BYOK-01",
          observations.snapshot(),
          {
            modelCalls: modelCallCount,
            toolCalls: toolCallCount,
            continuations: continuationCount,
            approvals: approvalCount,
            missionScorecard: finalMissionScorecard,
          },
          { requireComplete: true },
        );
        acceptanceRecorded = true;
        exportPath = canonicalExport;
        test.info().annotations.push({
          type: "retained-desktop-export",
          description: canonicalExport,
        });
      } catch (error) {
        primaryError = error;
      }
    }
    if (!acceptanceRecorded && desktopRoot) {
      try {
        finalNewOwnedExportPaths = await listNewOwnedExportCandidates(
          desktopRoot,
          expectedExportLabel,
          preexistingOwnedExportPaths,
        );
      } catch (error) {
        cleanupErrors.push(
          `Desktop export failure inventory: ${safeExternalCleanupError(error)}`,
        );
      }
      for (const candidate of finalNewOwnedExportPaths) {
        const key = normalizePathCase(candidate);
        if (!observedOwnedExportPaths.has(key)) {
          cleanupErrors.push(
            `Unregistered new Desktop candidate was not deleted: ${candidate}`,
          );
        }
      }
      for (const [candidate, directoryName] of observedOwnedExportPaths) {
        await cleanupOwnedExportDirectory(
          desktopRoot,
          candidate,
          directoryName,
        ).catch((error) => {
          cleanupErrors.push(
            `Desktop export cleanup: ${safeExternalCleanupError(error)}`,
          );
        });
      }
      exportPath = null;
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        [
          primaryError
            ? `BYOK-AUTONOMOUS failed: ${safeExternalCleanupError(primaryError)}`
            : "BYOK-AUTONOMOUS assertions passed",
          `mandatory cleanup failed: ${cleanupErrors.join("; ")}`,
        ].join("; "),
      );
    }
  }
  if (primaryError) throw primaryError;
});

function sourceUrls(marker: string): string[] {
  const suffix = encodeURIComponent(marker);
  return [
    `https://gcounter-spec.owned.example/state-join/${suffix}`,
    `https://orset-paper.owned.example/observed-remove/${suffix}`,
    `https://crdt-testing.owned.example/convergence/${suffix}`,
    `https://distributed-systems.owned.example/implementation/${suffix}`,
  ];
}

async function installFourSourceResearchBackend(
  page: Page,
  marker: string,
): Promise<void> {
  const sources = sourceUrls(marker);
  const passages = [
    "A state-based grow-only counter stores one non-negative component per replica. Only the local replica component is incremented. Merge computes the pointwise maximum for every replica and value is the sum. The join is associative, commutative, and idempotent, so repeated or reordered delivery converges.",
    "An observed-remove set assigns each add a unique tag. Remove records every tag for the element that the replica has observed. Merge unions add tags and removed tags. A concurrent add with an unseen tag survives an earlier remove; a remove after observing every live tag makes the element absent after replicas merge.",
    "CRDT validation should exercise convergence from opposite merge orders, duplicate merges, monotonic counter growth, concurrent operations, and removal after complete observation. Behavioral tests should compare values after both replicas exchange state instead of checking one implementation's private representation.",
    "A bounded dependency-free Python CRDT package can expose replica identity, mutation methods, value views, and merge operations while keeping internal maps and tag sets private. Documentation should state non-negative increment rules, observed-remove semantics, and the limits of in-memory state such as persistence and unbounded tombstone growth.",
  ];
  await page.evaluate(
    ({ pluginId, sources, passages }) => {
      const w = window as typeof window & {
        app?: any;
        __byokResearchRestore?: () => void;
        __byokResearchMetrics?: {
          searchCalls: number;
          fetchCalls: number;
          fetchedUrls: string[];
        };
      };
      const plugin = w.app?.plugins?.plugins?.[pluginId];
      if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
      w.__byokResearchRestore?.();
      w.__byokResearchMetrics = {
        searchCalls: 0,
        fetchCalls: 0,
        fetchedUrls: [],
      };
      const original = plugin.createToolExecutionContext;
      plugin.createToolExecutionContext = function (prompt: string) {
        const context = original.call(this, prompt);
        const realTransport = context.httpTransport;
        context.httpTransport = async (request: any) => {
          if (String(request.url).endsWith("/web_search")) {
            w.__byokResearchMetrics!.searchCalls += 1;
            return {
              status: 200,
              headers: {},
              json: {
                results: sources.map((url: string, index: number) => ({
                  title: [
                    "Owned G-Counter join semantics",
                    "Owned OR-Set observed-remove semantics",
                    "Owned CRDT convergence testing",
                    "Owned bounded Python implementation guidance",
                  ][index],
                  url,
                  snippet: passages[index]!.slice(0, 190),
                })),
              },
            };
          }
          if (String(request.url).endsWith("/web_fetch")) {
            const body = JSON.parse(String(request.body ?? "{}"));
            const requestedUrl = String(body.url ?? "");
            const index = sources.indexOf(requestedUrl);
            if (index < 0) {
              return {
                status: 404,
                headers: {},
                json: { error: "source is outside the owned BYOK fixture" },
              };
            }
            w.__byokResearchMetrics!.fetchCalls += 1;
            w.__byokResearchMetrics!.fetchedUrls.push(requestedUrl);
            return {
              status: 200,
              headers: {},
              json: {
                title: `Owned CRDT source ${index + 1}`,
                content: passages[index],
                links: [],
              },
            };
          }
          return realTransport(request);
        };
        return context;
      };
      w.__byokResearchRestore = () => {
        plugin.createToolExecutionContext = original;
        delete w.__byokResearchRestore;
        delete w.__byokResearchMetrics;
      };
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, sources, passages },
  );
}

async function readResearchBackendMetrics(page: Page): Promise<{
  searchCalls: number;
  fetchCalls: number;
  fetchedUrls: string[];
}> {
  return page.evaluate(() => {
    const metrics = (window as typeof window & {
      __byokResearchMetrics?: {
        searchCalls: number;
        fetchCalls: number;
        fetchedUrls: string[];
      };
    }).__byokResearchMetrics;
    if (!metrics) throw new Error("BYOK research metrics are unavailable.");
    return { ...metrics, fetchedUrls: [...metrics.fetchedUrls] };
  });
}

function expectSuccessfulProductionCalls(snapshot: any, model: string): void {
  const calls = Array.isArray(snapshot?.modelCallEvidence)
    ? snapshot.modelCallEvidence
    : [];
  const successes = calls.filter(
    (item: any) =>
      item?.outcome === "success" &&
      item?.transportKind === "production" &&
      item?.model === model &&
      Number(item?.responseChars ?? 0) > 0,
  );
  expect(successes.length).toBeGreaterThan(0);
  expect(snapshot?.lastMissionGraph?.routing).toMatchObject({
    source: "structured_model",
    fallbackReason: null,
  });
}

function requirePositiveCounterDelta(
  before: number,
  after: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(before) ||
    before < 0 ||
    !Number.isSafeInteger(after) ||
    after < before
  ) {
    throw new Error(
      `${label} counters are invalid: before=${before} after=${after}.`,
    );
  }
  const delta = after - before;
  if (delta <= 0) {
    throw new Error(`${label} did not increase.`);
  }
  return delta;
}

function assertPhaseModelCallAccounting(
  before: ReturnType<RealAiHarness["readProgressCounters"]>,
  after: ReturnType<RealAiHarness["readProgressCounters"]>,
  phaseDelta: number,
  snapshot: any,
  phase: string,
): PhaseModelUsageProofV1 {
  const beforeByScope = new Map(
    before.modelCallScopes.map((item) => [item.usageScopeId, item.modelCalls]),
  );
  const usageScopes = after.modelCallScopes
    .map((item) => ({
      usageScopeId: item.usageScopeId,
      modelCalls:
        item.modelCalls - (beforeByScope.get(item.usageScopeId) ?? 0),
    }))
    .filter((item) => item.modelCalls > 0);
  expect(
    new Set(usageScopes.map((item) => item.usageScopeId)).size,
    `${phase} model-call scopes were not unique`,
  ).toBe(usageScopes.length);
  expect(
    usageScopes.reduce((total, item) => total + item.modelCalls, 0),
    `${phase} scope manifest did not reconcile to the harness delta`,
  ).toBe(phaseDelta);

  const terminalUsageScopeId = String(
    snapshot?.providerUsageScopeId ?? "",
  ).trim();
  const terminalCoordinatorModelCalls =
    snapshot?.providerUsage?.modelCallCount;
  expect(terminalUsageScopeId, `${phase} terminal usage scope`).toBeTruthy();
  expect(
    Number.isSafeInteger(terminalCoordinatorModelCalls) &&
      terminalCoordinatorModelCalls > 0,
    `${phase} coordinator did not attest a positive whole-team model-call count`,
  ).toBe(true);
  const terminalScope = usageScopes.find(
    (item) => item.usageScopeId === terminalUsageScopeId,
  );
  expect(
    terminalScope,
    `${phase} terminal coordinator scope was absent from the phase manifest`,
  ).toBeTruthy();
  expect(
    terminalScope?.modelCalls,
    `${phase} terminal scope count disagreed with RunCoordinator`,
  ).toBe(terminalCoordinatorModelCalls);

  const finalSegmentModelCalls =
    snapshot?.lastMissionLedger?.providerUsage?.modelCallCount;
  expect(
    Number.isSafeInteger(finalSegmentModelCalls) && finalSegmentModelCalls > 0,
    `${phase} final ledger segment did not attest a positive model-call count`,
  ).toBe(true);
  expect(
    terminalCoordinatorModelCalls,
    `${phase} coordinator aggregate omitted calls attested by its final ledger segment`,
  ).toBeGreaterThanOrEqual(finalSegmentModelCalls);
  return {
    version: 1,
    modelCallCount: phaseDelta,
    usageScopes,
    terminalUsageScopeId,
    terminalCoordinatorModelCalls,
    finalSegmentModelCalls,
  };
}

function requirePassingMissionScorecard(
  value: unknown,
  phase: string,
): MissionScorecardV1 {
  const scorecard = value as MissionScorecardV1 | null;
  if (
    scorecard?.version !== 1 ||
    scorecard.acceptancePassed !== true ||
    !Number.isFinite(scorecard.total) ||
    !Array.isArray(scorecard.dimensions)
  ) {
    throw new Error(`${phase} did not expose a passing production scorecard.`);
  }
  return scorecard;
}

function assertAuthoritativeMissionGraph(
  snapshot: any,
  phase: string,
): void {
  const graph = snapshot?.lastMissionGraph;
  const nodes = Object.values(graph?.nodes ?? {}) as any[];
  expect(graph?.schemaVersion, `${phase} graph version`).toBe(3);
  expect(String(graph?.missionId ?? ""), `${phase} graph mission id`).toBeTruthy();
  expect(nodes.length, `${phase} graph node count`).toBeGreaterThan(0);
  expect(
    nodes.some((node) => node?.status === "complete"),
    `${phase} graph has no completed node`,
  ).toBe(true);
  const nonTerminalNodes = nodes
    .filter(
      (node) =>
        !["complete", "cancelled"].includes(String(node?.status ?? "")),
    )
    .map((node) => ({
      id: String(node?.id ?? ""),
      status: String(node?.status ?? ""),
      allowedTools: Array.isArray(node?.allowedTools)
        ? node.allowedTools.map(String)
        : [],
      blockerCode: String(node?.blocker?.code ?? ""),
    }));
  expect(
    nonTerminalNodes,
    `${phase} graph retained non-terminal nodes: ${JSON.stringify(
      nonTerminalNodes,
    )}`,
  ).toEqual([]);
  expect(snapshot?.lastMissionLedger?.status, `${phase} ledger status`).toBe(
    "complete",
  );
  expect(snapshot?.lastMissionLedger?.acceptance?.status).toBe("pass");
}

interface GraphToolRequirementV1 {
  toolName: string;
  minimumEvents: number;
}

interface GraphToolWitnessV1 {
  toolName: string;
  actionId: string | null;
  node: MissionNodeV3;
}

async function assertGraphRuntimeLinkage(
  snapshot: any,
  observedEvents: readonly ObservedToolExecution[],
  requirements: readonly GraphToolRequirementV1[],
  phase: string,
): Promise<void> {
  const graph = await parseMissionGraphV3(snapshot?.lastMissionGraph);
  const wanted = new Set(requirements.map((item) => item.toolName));
  const witnesses: GraphToolWitnessV1[] = [];

  for (const node of Object.values(graph.nodes)) {
    if (node.status !== "complete") continue;
    const lifecycle = getMissionCompositeLifecycleSpecV1(node);
    if (lifecycle) {
      const state = getMissionCompositeLifecycleStateV1(node);
      expect(state, `${phase} lifecycle state for ${node.id}`).not.toBeNull();
      expect(state!.actionCursor, `${phase} lifecycle cursor for ${node.id}`).toBe(
        lifecycle.actions.length,
      );
      const completedIds = new Set(state!.completedActionIds);
      const completedActions = lifecycle.actions.filter((action) =>
        completedIds.has(action.id),
      );
      assertNodeProofPool(node, completedActions, phase);
      for (const action of completedActions) {
        if (!wanted.has(action.toolName)) continue;
        expect(
          state!.actionAttemptCounts[action.id],
          `${phase} lifecycle attempt count for ${action.id}`,
        ).toBeGreaterThanOrEqual(1);
        if (action.effect !== "read") {
          expect(
            action.minimumReceipts,
            `${phase} receipt contract for ${action.toolName}`,
          ).toBeGreaterThanOrEqual(1);
        }
        witnesses.push({
          toolName: action.toolName,
          actionId: action.id,
          node,
        });
      }
      continue;
    }

    if (node.allowedTools.length !== 1) continue;
    const toolName = node.allowedTools[0]!;
    if (!wanted.has(toolName)) continue;
    assertNodeProofPool(node, [node.completionContract], phase);
    if (node.effect !== "read") {
      expect(
        node.completionContract.minimumReceipts,
        `${phase} receipt contract for ${toolName}`,
      ).toBeGreaterThanOrEqual(1);
    }
    witnesses.push({ toolName, actionId: null, node });
  }

  for (const requirement of requirements) {
    const events = observedEvents.filter(
      (event) => event.ok && event.name === requirement.toolName,
    );
    expect(
      events.length,
      `${phase} observed executions for ${requirement.toolName}`,
    ).toBeGreaterThanOrEqual(requirement.minimumEvents);
    const matchingWitnesses = witnesses.filter(
      (witness) => witness.toolName === requirement.toolName,
    );
    expect(
      matchingWitnesses.length,
      `${phase} completed graph linkage for ${requirement.toolName}`,
    ).toBeGreaterThanOrEqual(1);
    if (requirement.minimumEvents > 1) {
      expect(
        new Set(events.map((event) => event.evidenceFingerprint)).size,
        `${phase} distinct observed evidence for ${requirement.toolName}`,
      ).toBeGreaterThanOrEqual(requirement.minimumEvents);
    }

    for (const event of events) {
      if (event.descriptorEffect === "read") {
        expect(
          event.evidenceFingerprint,
          `${phase} observed read fingerprint for ${requirement.toolName}`,
        ).toMatch(/^sha256:[a-f0-9]{64}$/u);
        expect(
          matchingWitnesses.some((witness) =>
            witness.node.evidence.some(
              (evidence) =>
                evidence.fingerprint === event.evidenceFingerprint &&
                (!event.evidenceId || evidence.id === event.evidenceId),
            ),
          ),
          `${phase} exact graph read evidence for ${requirement.toolName}`,
        ).toBe(true);
        continue;
      }
      expect(
        event.receipt?.id,
        `${phase} mutation receipt for ${requirement.toolName}`,
      ).toBeTruthy();
      expect(event.receipt?.readbackStatus).toBe("verified");
      expect(
        matchingWitnesses.some((witness) =>
          witness.node.receipts.some(
            (receipt) => receipt.id === event.receipt?.id,
          ),
        ),
        `${phase} graph receipt linkage for ${requirement.toolName}`,
      ).toBe(true);
    }
  }
}

function assertNodeProofPool(
  node: MissionNodeV3,
  demands: ReadonlyArray<{
    minimumEvidence: number;
    requiredEvidenceKinds: readonly string[];
    minimumReceipts: number;
    requiredReceiptKinds: readonly string[];
  }>,
  phase: string,
): void {
  const minimumEvidence = demands.reduce(
    (total, demand) => total + demand.minimumEvidence,
    0,
  );
  const minimumReceipts = demands.reduce(
    (total, demand) => total + demand.minimumReceipts,
    0,
  );
  expect(
    node.evidence.length,
    `${phase} graph evidence pool for ${node.id}`,
  ).toBeGreaterThanOrEqual(minimumEvidence);
  expect(
    node.receipts.length,
    `${phase} graph receipt pool for ${node.id}`,
  ).toBeGreaterThanOrEqual(minimumReceipts);
  const evidenceKinds = new Set(node.evidence.map((item) => item.kind));
  const receiptKinds = new Set(node.receipts.map((item) => item.kind));
  for (const kind of new Set(
    demands.flatMap((demand) => [...demand.requiredEvidenceKinds]),
  )) {
    expect(
      evidenceKinds.has(kind),
      `${phase} evidence kind ${kind} on ${node.id}`,
    ).toBe(true);
  }
  for (const kind of new Set(
    demands.flatMap((demand) => [...demand.requiredReceiptKinds]),
  )) {
    expect(
      receiptKinds.has(kind),
      `${phase} receipt kind ${kind} on ${node.id}`,
    ).toBe(true);
  }
}

function annotatePhaseScorecard(
  testInfo: TestInfo,
  annotation: ByokPhaseScorecardAnnotationV1,
): void {
  if (!annotation.runId.trim()) {
    throw new Error(`Phase ${annotation.phase} scorecard omitted its run id.`);
  }
  testInfo.annotations.push({
    type:
      annotation.phase === "A"
        ? PHASE_A_SCORECARD_ANNOTATION
        : PHASE_B_SCORECARD_ANNOTATION,
    description: JSON.stringify(annotation),
  });
}

function isPassingMissionScorecardLike(value: unknown): boolean {
  const scorecard = value as Partial<MissionScorecardV1> | null;
  return (
    scorecard?.version === 1 &&
    scorecard.acceptancePassed === true &&
    Number.isFinite(scorecard.total) &&
    Array.isArray(scorecard.dimensions)
  );
}

function annotatePhaseBProductionDiagnostic(
  testInfo: TestInfo,
  snapshot: any,
  observedTools: readonly ObservedToolExecution[],
  phaseSequenceStart: number | null,
  fallbackRunId: string | null,
): void {
  const rawScorecard =
    snapshot?.lastMissionScorecard &&
    typeof snapshot.lastMissionScorecard === "object"
      ? snapshot.lastMissionScorecard
      : null;
  const rawDimensions = Array.isArray(rawScorecard?.dimensions)
    ? rawScorecard.dimensions
    : [];
  const rawProviderUsage =
    snapshot?.providerUsage && typeof snapshot.providerUsage === "object"
      ? snapshot.providerUsage
      : null;
  const graph =
    snapshot?.lastMissionGraph &&
    typeof snapshot.lastMissionGraph === "object"
      ? snapshot.lastMissionGraph
      : null;
  const graphNodes = Object.values(graph?.nodes ?? {}) as any[];
  const statusCounts: Record<string, number> = {};
  for (const node of graphNodes) {
    const status = safeDiagnosticIdentifier(node?.status, 48) ?? "unknown";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  const rawBlockers = graphNodes.filter(
    (node) => node?.status === "blocked" || Boolean(node?.blocker),
  );
  const rawNonTerminal = graphNodes.filter(
    (node) =>
      !["complete", "cancelled"].includes(String(node?.status ?? "")),
  );
  const summarizeGraphNode = (node: any) => ({
    id: safeDiagnosticIdentifier(node?.id, 180) ?? "unknown",
    status: safeDiagnosticIdentifier(node?.status, 48) ?? "unknown",
    allowedTools: Array.isArray(node?.allowedTools)
      ? node.allowedTools
          .map((toolName: unknown) =>
            safeDiagnosticIdentifier(toolName, 120),
          )
          .filter((toolName: string | null): toolName is string =>
            Boolean(toolName),
          )
          .slice(0, 8)
      : [],
    attempts: finiteDiagnosticNumber(node?.retries?.attempts),
    blockerCode: safeDiagnosticIdentifier(node?.blocker?.code, 120),
  });
  const rawAcceptanceMissing: unknown[] = Array.isArray(
    snapshot?.lastMissionLedger?.acceptance?.missing,
  )
    ? [...snapshot.lastMissionLedger.acceptance.missing]
    : [];
  const acceptanceStatus = safeDiagnosticIdentifier(
    snapshot?.lastMissionLedger?.acceptance?.status,
    80,
  );
  const acceptanceMissingCodes: string[] = [
    ...new Set<string>(
      rawAcceptanceMissing.flatMap((entry) => {
        const code = safeAcceptanceMissingCode(entry);
        return code ? [code] : [];
      }),
    ),
  ];
  const phaseTools = observedTools.filter(
    (event) =>
      phaseSequenceStart === null || event.sequence > phaseSequenceStart,
  );
  const rawReceipts = Array.isArray(snapshot?.lastReceipts)
    ? snapshot.lastReceipts
    : [];

  // Deliberately exclude prompts, note bodies, acceptance prose, objectives,
  // tool arguments/results, paths, resource IDs, fingerprints, blocker text,
  // and provider credentials.
  const annotation: ByokPhaseBDiagnosticAnnotationV1 = {
    version: 1,
    phase: "B",
    runId:
      boundedDiagnosticString(snapshot?.runId, 240) ??
      boundedDiagnosticString(snapshot?.lastMissionLedger?.runId, 240) ??
      fallbackRunId,
    scorecard: {
      present: rawScorecard !== null,
      version: finiteDiagnosticNumber(rawScorecard?.version),
      acceptancePassed:
        typeof rawScorecard?.acceptancePassed === "boolean"
          ? rawScorecard.acceptancePassed
          : null,
      total: finiteDiagnosticNumber(rawScorecard?.total),
      dimensions: rawDimensions.slice(0, 12).map((dimension: any) => ({
        id: boundedDiagnosticString(dimension?.id, 80) ?? "unknown",
        score: finiteDiagnosticNumber(dimension?.score),
        weight: finiteDiagnosticNumber(dimension?.weight),
      })),
    },
    providerUsage: {
      usageScopeId: boundedDiagnosticString(
        snapshot?.providerUsageScopeId,
        240,
      ),
      aggregate: {
        modelCallCount: finiteDiagnosticNumber(
          rawProviderUsage?.modelCallCount,
        ),
        successfulCallCount: finiteDiagnosticNumber(
          rawProviderUsage?.successfulCallCount,
        ),
        failedCallCount: finiteDiagnosticNumber(
          rawProviderUsage?.failedCallCount,
        ),
        reportedTokens: finiteDiagnosticNumber(
          rawProviderUsage?.reportedTokens,
        ),
        estimatedTokens: finiteDiagnosticNumber(
          rawProviderUsage?.estimatedTokens,
        ),
        retries: finiteDiagnosticNumber(rawProviderUsage?.retries),
        wallClockMs: finiteDiagnosticNumber(rawProviderUsage?.wallClockMs),
      },
      finalLedgerModelCallCount: finiteDiagnosticNumber(
        snapshot?.lastMissionLedger?.providerUsage?.modelCallCount,
      ),
    },
    completion: {
      coordinatorState: boundedDiagnosticString(snapshot?.state, 80),
      isRunning: snapshot?.isRunning === true,
      stopReason: boundedDiagnosticString(
        snapshot?.lastComplete?.stopReason,
        80,
      ),
      autoContinueReason: boundedDiagnosticString(
        snapshot?.lastComplete?.autoContinueReason,
        120,
      ),
      step: finiteDiagnosticNumber(snapshot?.lastComplete?.step),
      maxSteps: finiteDiagnosticNumber(snapshot?.lastComplete?.maxSteps),
      ledgerStatus: boundedDiagnosticString(
        snapshot?.lastMissionLedger?.status,
        80,
      ),
      acceptanceStatus,
      acceptanceMissing: {
        count: rawAcceptanceMissing.length,
        entries: acceptanceMissingCodes
          .slice(0, MAX_PHASE_B_DIAGNOSTIC_ACCEPTANCE_MISSING)
          .map((code) => ({ code, status: acceptanceStatus })),
        truncated:
          acceptanceMissingCodes.length >
            MAX_PHASE_B_DIAGNOSTIC_ACCEPTANCE_MISSING ||
          acceptanceMissingCodes.length < rawAcceptanceMissing.length,
      },
      hasStopDetail:
        typeof snapshot?.lastComplete?.stopDetail === "string" &&
        snapshot.lastComplete.stopDetail.trim().length > 0,
    },
    graph: {
      missionId: boundedDiagnosticString(graph?.missionId, 240),
      revision: finiteDiagnosticNumber(graph?.revision),
      routingSource: boundedDiagnosticString(graph?.routing?.source, 80),
      nodeCount: graphNodes.length,
      statusCounts,
      blockers: rawBlockers
        .slice(0, MAX_PHASE_B_DIAGNOSTIC_GRAPH_BLOCKERS)
        .map(summarizeGraphNode),
      blockersTruncated:
        rawBlockers.length > MAX_PHASE_B_DIAGNOSTIC_GRAPH_BLOCKERS,
      nonTerminalCount: rawNonTerminal.length,
      nonTerminal: rawNonTerminal
        .slice(0, MAX_PHASE_B_DIAGNOSTIC_GRAPH_NONTERMINAL)
        .map(summarizeGraphNode),
      nonTerminalTruncated:
        rawNonTerminal.length > MAX_PHASE_B_DIAGNOSTIC_GRAPH_NONTERMINAL,
    },
    tools: {
      count: phaseTools.length,
      entries: phaseTools
        .slice(-MAX_PHASE_B_DIAGNOSTIC_TOOLS)
        .map((event) => ({
          sequence: event.sequence,
          name: boundedDiagnosticString(event.name, 120) ?? "unknown",
          phase: boundedDiagnosticString(event.phase, 48) ?? "unknown",
          ok: event.ok === true,
          descriptorEffect: boundedDiagnosticString(
            event.descriptorEffect,
            48,
          ),
          mutationState: boundedDiagnosticString(event.mutationState, 80),
          hasReceipt: Boolean(event.receipt),
          receiptReadbackStatus: boundedDiagnosticString(
            event.receipt?.readbackStatus,
            80,
          ),
        })),
      truncated: phaseTools.length > MAX_PHASE_B_DIAGNOSTIC_TOOLS,
    },
    receipts: {
      count: rawReceipts.length,
      entries: rawReceipts
        .slice(-MAX_PHASE_B_DIAGNOSTIC_RECEIPTS)
        .map((receipt: any) => ({
          toolName:
            boundedDiagnosticString(receipt?.toolName, 120) ?? "unknown",
          operation: boundedDiagnosticString(receipt?.operation, 80),
          readbackStatus: boundedDiagnosticString(
            receipt?.readback?.status,
            80,
          ),
          resourceSystem: boundedDiagnosticString(
            receipt?.resource?.system,
            80,
          ),
          resourceType: boundedDiagnosticString(
            receipt?.resource?.resourceType,
            80,
          ),
        })),
      truncated: rawReceipts.length > MAX_PHASE_B_DIAGNOSTIC_RECEIPTS,
    },
  };
  testInfo.annotations.push({
    type: PHASE_B_DIAGNOSTIC_ANNOTATION,
    description: JSON.stringify(annotation),
  });
}

function boundedDiagnosticString(
  value: unknown,
  maxChars: number,
): string | null {
  if (typeof value !== "string") return null;
  const bounded = value
    .replace(
      /(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{48,})/giu,
      "[REDACTED]",
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, Math.max(1, maxChars));
  return bounded || null;
}

function safeDiagnosticIdentifier(
  value: unknown,
  maxChars: number,
): string | null {
  const bounded = boundedDiagnosticString(value, maxChars);
  return bounded && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(bounded)
    ? bounded
    : null;
}

function safeAcceptanceMissingCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const segments = value.trim().split(":");
  const safeSegments: string[] = [];
  for (const segment of segments.slice(0, 2)) {
    const safe = safeDiagnosticIdentifier(segment, 80);
    if (!safe) break;
    safeSegments.push(safe);
  }
  return safeSegments.length > 0 ? safeSegments.join(":") : null;
}

function finiteDiagnosticNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface CompleteResearchPublicationV1 {
  issueId: string;
  backlinkVerified: boolean;
  artifactFingerprint: string;
  originRunId: string;
  notePath: string;
  evidenceReferences: string[];
}

function boundedCleanupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 500) || "unknown error";
}

function isOwnedObsidianPageClosure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Obsidian (?:page|page\/context|renderer).*closed/iu.test(message) ||
    /Target page, context or browser has been closed/iu.test(message) ||
    /Mission page closed during the running poll/iu.test(message) ||
    /Obsidian did not answer a state poll/iu.test(message)
  );
}

async function readCompleteResearchPublication(
  page: Page,
  notePath: string,
): Promise<CompleteResearchPublicationV1 | null> {
  return (await readCompleteResearchPublications(page, notePath))[0] ?? null;
}

async function readCompleteResearchPublications(
  page: Page,
  notePath: string,
): Promise<CompleteResearchPublicationV1[]> {
  return page.evaluate(
    ({ pluginId, notePath }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const checkpoints = Object.values(
        plugin?.researchPublicationCheckpointNamespace?.checkpoints ?? {},
      ) as any[];
      return checkpoints
        .filter(
          (candidate) =>
            candidate?.status === "complete" &&
            candidate?.artifact?.notePath === notePath,
        )
        .map((checkpoint) => ({
          issueId: String(checkpoint.issue?.id ?? ""),
          backlinkVerified:
            /^sha256:[a-f0-9]{64}$/u.test(
              String(checkpoint.backlink?.afterSha256 ?? ""),
            ),
          artifactFingerprint: String(
            checkpoint.artifact?.artifactFingerprint ?? "",
          ),
          originRunId: String(checkpoint.artifact?.originRunId ?? ""),
          notePath: String(checkpoint.artifact?.notePath ?? ""),
          evidenceReferences: Array.isArray(checkpoint.artifact?.evidence)
            ? checkpoint.artifact.evidence.map((item: any) =>
                String(item?.reference ?? ""),
              )
            : [],
        }))
        .sort((left, right) =>
          left.artifactFingerprint.localeCompare(right.artifactFingerprint),
        );
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, notePath },
  );
}

async function readLinearIssue(
  page: Page,
  issueId: string,
): Promise<{
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string;
  stateType: string;
  trashed: boolean;
  projectId: string;
}> {
  return page.evaluate(
    async ({ pluginId, issueId }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const client = plugin?.createSecretBackedLinearClient?.();
      if (!client) throw new Error("Production Linear client is unavailable.");
      const issue = (await client.execute("issues.get", { id: issueId })) as any;
      return {
        id: String(issue?.id ?? ""),
        identifier: String(issue?.identifier ?? ""),
        url: String(issue?.url ?? ""),
        title: String(issue?.title ?? ""),
        description: String(issue?.description ?? ""),
        stateType: String(issue?.state?.type ?? ""),
        trashed: issue?.trashed === true,
        projectId: String(
          issue?.project?.id ??
            issue?.attributes?.project?.id ??
            issue?.attributes?.project ??
            "",
        ),
      };
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, issueId },
  );
}

async function listVaultBackupPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const adapter = (window as typeof window & { app?: any }).app?.vault?.adapter;
    if (
      !adapter ||
      typeof adapter.exists !== "function" ||
      typeof adapter.list !== "function"
    ) {
      throw new Error(
        "Vault adapter inventory is unavailable for exact BYOK backup cleanup.",
      );
    }
    if (!(await adapter.exists(".agent-backups"))) return [];
    const files: string[] = [];
    const folders = [".agent-backups"];
    const visited = new Set<string>();
    while (folders.length > 0) {
      const folder = folders.pop()!;
      if (visited.has(folder)) continue;
      visited.add(folder);
      const listed = await adapter.list(folder);
      files.push(...(listed?.files ?? []));
      folders.push(...(listed?.folders ?? []));
      if (files.length + folders.length + visited.size > 10_000) {
        throw new Error(
          "Vault backup inventory exceeded the protected BYOK bound.",
        );
      }
    }
    return [...new Set(files)].sort();
  });
}

async function deleteExactRunOwnedVaultBackups(input: {
  page: Page;
  notePath: string;
  baselinePaths: readonly string[];
}): Promise<{
  version: 1;
  notePath: string;
  baselineCount: number;
  selectedPaths: string[];
  removed: number;
  survivors: string[];
  absenceVerified: true;
}> {
  const currentPaths = await listVaultBackupPaths(input.page);
  const selection = selectPostBaselineOwnedVaultBackupPaths({
    notePath: input.notePath,
    baselinePaths: input.baselinePaths,
    currentPaths,
  });
  if (selection.paths.length > 64) {
    throw new Error(
      "Exact BYOK vault backup cleanup exceeded its per-note deletion bound.",
    );
  }
  const selectedPaths = selection.paths.map((candidate) =>
    validateOwnedVaultBackupDeletionPath(input.notePath, candidate)
  );
  const removed = await input.page.evaluate(
    async ({ selectedPaths }) => {
      const app = (window as typeof window & { app?: any }).app;
      const adapter = app?.vault?.adapter;
      if (
        !adapter ||
        typeof adapter.exists !== "function" ||
        typeof adapter.remove !== "function"
      ) {
        throw new Error(
          "Vault adapter deletion is unavailable for exact BYOK backup cleanup.",
        );
      }
      let removedCount = 0;
      for (const backupPath of selectedPaths) {
        const parts = backupPath.split("/");
        if (
          parts.length !== 2 ||
          parts[0] !== ".agent-backups" ||
          !parts[1] ||
          backupPath.includes("\\") ||
          parts.some((part) => part === "." || part === "..")
        ) {
          throw new Error(
            "Browser-side BYOK backup deletion received an unsafe path.",
          );
        }
        const file = app?.vault?.getAbstractFileByPath?.(backupPath);
        if (file) {
          await app.vault.delete(file, true);
          removedCount += 1;
        } else if (await adapter.exists(backupPath)) {
          await adapter.remove(backupPath);
          removedCount += 1;
        }
      }
      return removedCount;
    },
    { selectedPaths },
  );
  const afterPaths = await listVaultBackupPaths(input.page);
  const readback = assertOwnedVaultBackupCleanupReadback({
    notePath: input.notePath,
    baselinePaths: input.baselinePaths,
    currentPaths: afterPaths,
  });
  return {
    version: 1,
    notePath: readback.notePath,
    baselineCount: input.baselinePaths.length,
    selectedPaths,
    removed,
    survivors: readback.survivors,
    absenceVerified: true,
  };
}

async function readVaultNote(page: Page, notePath: string): Promise<string> {
  return page.evaluate(async ({ notePath }) => {
    const app = (window as typeof window & { app?: any }).app;
    const file = app?.vault?.getAbstractFileByPath?.(notePath);
    if (!file) throw new Error(`Vault note is missing: ${notePath}`);
    return app.vault.read(file);
  }, { notePath });
}

async function clearModelChatAndActiveNoteContext(
  harness: RealAiHarness,
): Promise<void> {
  await harness.clearChat();
  await harness.page.evaluate(async ({ pluginId }) => {
    const app = (window as typeof window & { app?: any }).app;
    for (const leaf of app?.workspace?.getLeavesOfType?.("markdown") ?? []) {
      await leaf.detach?.();
    }
    await app?.plugins?.plugins?.[pluginId]?.activateView?.();
    if (app?.workspace?.getActiveFile?.()) {
      throw new Error("Active note context survived the Phase B isolation gate.");
    }
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

async function visibleChatText(page: Page): Promise<string> {
  const log = page.locator(".agentic-researcher-log");
  await expect(log).toBeVisible({ timeout: 5_000 });
  return (await log.textContent({ timeout: 5_000 })) ?? "";
}

interface ObservedPreparedAction {
  id: string;
  payloadFingerprint: string;
  path?: string;
  runId?: string;
  ownerRunId?: string;
  workspaceId?: string;
  normalizedWorkspaceId?: string;
}

interface ObservedAuthorization {
  preparedActionId: string;
  payloadFingerprint: string;
  grantId: string;
}

interface ObservedActionReceipt {
  id: string;
  toolName?: string;
  operation?: string;
  actionId: string;
  payloadFingerprint: string;
  idempotencyKey?: string;
  grantId: string;
  readbackStatus: string;
  resourceSystem?: string;
  resourceType?: string;
  resourceId?: string;
  path?: string;
  runId?: string;
  workspaceId?: string;
}

interface ObservedNestedApproval {
  toolName: string;
  preparedActionId: string;
  payloadFingerprint: string;
  preparedActionIdempotencyKey?: string;
  confirmationIndex: number;
  requiredConfirmations: number;
  approved: boolean;
  approvalId?: string;
  approvalFingerprint?: string;
}

interface ObservedToolExecution {
  sequence: number;
  name: string;
  phase: "execute" | "executePrepared";
  startedAt: string;
  completedAt: string;
  ok: boolean;
  descriptorEffect?: string;
  mutationState?: string;
  evidenceId?: string;
  evidenceFingerprint?: string;
  preparedAction?: ObservedPreparedAction;
  authorization?: ObservedAuthorization;
  receipt?: ObservedActionReceipt;
  nestedApprovals: ObservedNestedApproval[];
  linearIssueId?: string;
  workspaceId?: string;
  workspacePaths?: string[];
}

const MAX_OBSERVED_TOOL_JOURNAL_EVENTS = 2_048;

async function installToolExecutionObserver(
  page: Page,
  journal: ObservedToolExecution[],
): Promise<void> {
  await page.exposeBinding(
    "__byokToolEventSinkV1",
    (_source, event: ObservedToolExecution) => {
      if (
        !event ||
        typeof event !== "object" ||
        journal.length >= MAX_OBSERVED_TOOL_JOURNAL_EVENTS
      ) {
        return;
      }
      journal.push({
        ...event,
        sequence: journal.length,
        nestedApprovals: Array.isArray(event.nestedApprovals)
          ? event.nestedApprovals.map((approval) => ({ ...approval }))
          : [],
        ...(event.preparedAction
          ? { preparedAction: { ...event.preparedAction } }
          : {}),
        ...(event.authorization
          ? { authorization: { ...event.authorization } }
          : {}),
        ...(event.receipt ? { receipt: { ...event.receipt } } : {}),
        ...(event.workspacePaths
          ? { workspacePaths: [...event.workspacePaths] }
          : {}),
      });
    },
  );
  await page.evaluate(({ pluginId, repositoryFileMutationTools }) => {
    const w = window as typeof window & {
      app?: any;
      __byokToolObserverRestore?: () => void;
      __byokToolEvents?: ObservedToolExecution[];
      __byokToolEventSinkV1?: (
        event: ObservedToolExecution,
      ) => Promise<void>;
    };
    const plugin = w.app?.plugins?.plugins?.[pluginId];
    if (!plugin?.createToolRegistry) {
      throw new Error("Tool registry factory is unavailable.");
    }
    w.__byokToolObserverRestore?.();
    w.__byokToolEvents = [];
    const repositoryMutationToolNames = new Set(
      repositoryFileMutationTools,
    );
    let sequence = 0;
    const boundedIssueIdentity = (...candidates: unknown[]) => {
      for (const candidate of candidates) {
        if (
          typeof candidate === "string" &&
          candidate.trim().length > 0 &&
          candidate.trim().length <= 200
        ) {
          return candidate.trim();
        }
      }
      return undefined;
    };
    const boundedWorkspacePaths = (...candidates: unknown[]) => [
      ...new Set(
        candidates
          .filter(
            (candidate): candidate is string =>
              typeof candidate === "string" &&
              candidate.trim().length > 0 &&
              candidate.trim().length <= 500,
          )
          .map((candidate) => candidate.trim().replace(/\\/gu, "/")),
      ),
    ];
    const boundedString = (
      value: unknown,
      maxChars: number,
    ): string | undefined =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.trim().length <= maxChars
        ? value.trim()
        : undefined;
    const observePreparedAction = (action: any): ObservedPreparedAction => {
      const targetPath = boundedString(action?.target?.path, 1_000);
      const actionRunId = boundedString(action?.runId, 240);
      const ownerRunId = boundedString(action?.normalizedArgs?.ownerRunId, 240);
      const targetWorkspaceId = boundedString(
        action?.target?.workspaceId,
        240,
      );
      const normalizedWorkspaceId = boundedString(
        action?.normalizedArgs?.workspaceId,
        240,
      );
      return {
        id: String(action?.id ?? ""),
        payloadFingerprint: String(action?.payloadFingerprint ?? ""),
        ...(targetPath ? { path: targetPath } : {}),
        ...(actionRunId ? { runId: actionRunId } : {}),
        ...(ownerRunId ? { ownerRunId } : {}),
        ...(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {}),
        ...(normalizedWorkspaceId
          ? { normalizedWorkspaceId }
          : {}),
      };
    };
    const observeAuthorization = (
      context: any,
      authorization?: any,
    ): ObservedAuthorization | undefined => {
      const value = authorization ?? context?.authorizedAction;
      if (!value) return undefined;
      return {
        preparedActionId: String(value?.preparedActionId ?? ""),
        payloadFingerprint: String(value?.payloadFingerprint ?? ""),
        grantId: String(value?.grantId ?? ""),
      };
    };
    const observeReceipt = (
      result: any,
    ): ObservedActionReceipt | undefined => {
      const receipt = result?.receipt;
      if (!receipt) return undefined;
      const candidatePath = [
        receipt?.resource?.path,
        receipt?.path,
        receipt?.output?.destinationPath,
        result?.output?.destinationPath,
      ].find(
        (candidate) =>
          typeof candidate === "string" &&
          candidate.trim().length > 0 &&
          candidate.trim().length <= 1_000,
      );
      return {
        id: String(receipt?.id ?? ""),
        ...(boundedString(receipt?.toolName, 160)
          ? { toolName: boundedString(receipt?.toolName, 160) }
          : {}),
        ...(boundedString(receipt?.operation, 80)
          ? { operation: boundedString(receipt?.operation, 80) }
          : {}),
        actionId: String(receipt?.actionId ?? ""),
        payloadFingerprint: String(receipt?.payloadFingerprint ?? ""),
        ...(boundedString(receipt?.idempotencyKey, 500)
          ? { idempotencyKey: boundedString(receipt?.idempotencyKey, 500) }
          : {}),
        grantId: String(receipt?.grantId ?? ""),
        readbackStatus: String(receipt?.readback?.status ?? ""),
        ...(boundedString(receipt?.resource?.system, 80)
          ? { resourceSystem: boundedString(receipt?.resource?.system, 80) }
          : {}),
        ...(boundedString(receipt?.resource?.resourceType, 80)
          ? {
              resourceType: boundedString(
                receipt?.resource?.resourceType,
                80,
              ),
            }
          : {}),
        ...(boundedString(receipt?.resource?.id, 300)
          ? { resourceId: boundedString(receipt?.resource?.id, 300) }
          : {}),
        ...(candidatePath ? { path: candidatePath.trim() } : {}),
        ...(typeof receipt?.runId === "string" && receipt.runId.trim()
          ? { runId: receipt.runId.trim() }
          : {}),
        ...(boundedString(receipt?.resource?.workspaceId, 240)
          ? {
              workspaceId: boundedString(
                receipt?.resource?.workspaceId,
                240,
              ),
            }
          : {}),
      };
    };
    const contextWithNestedApprovalObserver = (
      context: any,
      event: ObservedToolExecution,
    ) => {
      if (typeof context?.requestNestedApproval !== "function") return context;
      const originalRequestNestedApproval =
        context.requestNestedApproval.bind(context);
      return {
        ...context,
        requestNestedApproval: async (request: any) => {
          const action = observePreparedAction(request?.preparedAction);
          const nested: ObservedNestedApproval = {
            toolName: String(request?.toolName ?? ""),
            preparedActionId: action.id,
            payloadFingerprint: action.payloadFingerprint,
            ...(boundedString(request?.preparedAction?.idempotencyKey, 500)
              ? {
                  preparedActionIdempotencyKey: boundedString(
                    request?.preparedAction?.idempotencyKey,
                    500,
                  ),
                }
              : {}),
            confirmationIndex: Number(request?.confirmationIndex ?? 1),
            requiredConfirmations: Number(
              request?.requiredConfirmations ?? 1,
            ),
            approved: false,
          };
          try {
            const decision = await originalRequestNestedApproval(request);
            nested.approved = decision?.approved === true;
            if (decision?.approved === true) {
              nested.approvalId = String(decision?.approvalId ?? "");
              nested.approvalFingerprint = String(
                decision?.approvalFingerprint ?? "",
              );
            }
            return decision;
          } finally {
            event.nestedApprovals.push(nested);
          }
        },
      };
    };
    const hashEvidenceKey = (value: string): string => {
      let hash = 0;
      for (const char of value) {
        hash = (hash * 31 + char.charCodeAt(0)) | 0;
      }
      return Math.abs(hash).toString(36) || "0";
    };
    const fingerprintObservedResult = async (
      toolName: string,
      result: any,
    ): Promise<string> => {
      const raw = JSON.stringify(result) ?? "";
      const outputRaw = JSON.stringify(result?.output ?? result?.error) ?? "";
      const output =
        outputRaw.length <= 8_000
          ? outputRaw
          : `${outputRaw.slice(0, 8_000)}\n\n[truncated]`;
      const serialized =
        raw.length <= 8_000
          ? raw
          : JSON.stringify({
              ok: result?.ok,
              toolName: result?.toolName,
              truncated: true,
              output,
            });
      const canonical = JSON.stringify({
        ok: result?.ok === true,
        output: serialized,
        toolName,
      });
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
      );
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return `sha256:${hex}`;
    };
    const observeResult = async (
      event: ObservedToolExecution,
      result: any,
    ): Promise<void> => {
      event.ok = result?.ok === true;
      event.mutationState = String(result?.mutationState ?? "");
      event.receipt = observeReceipt(result);
      if (event.ok && event.descriptorEffect === "read") {
        event.evidenceFingerprint = await fingerprintObservedResult(
          event.name,
          result,
        );
        if (event.name === "web_fetch") {
          const sourceLocator = boundedString(
            result?.output?.normalizedUrl ??
              result?.output?.url ??
              result?.output?.path ??
              result?.output?.title,
            2_000,
          );
          if (sourceLocator) {
            event.evidenceId = `web:${hashEvidenceKey(sourceLocator)}`;
          }
        }
      }
    };
    const originalFactory = plugin.createToolRegistry;
    plugin.createToolRegistry = function (...args: any[]) {
      const registry = originalFactory.apply(this, args);
      if (registry.__byokObserved === true) return registry;
      registry.__byokObserved = true;
      const originalExecute = registry.execute?.bind(registry);
      if (originalExecute) {
        registry.execute = async (call: any, context: any) => {
          const event: ObservedToolExecution = {
            sequence: sequence++,
            name: String(call?.name ?? ""),
            phase: "execute" as const,
            startedAt: new Date().toISOString(),
            completedAt: "",
            ok: false,
            descriptorEffect: String(
              registry.getDescriptor?.(String(call?.name ?? ""))?.effect ?? "",
            ),
            nestedApprovals: [],
            ...(boundedString(call?.arguments?.workspaceId, 240)
              ? {
                  workspaceId: boundedString(
                    call?.arguments?.workspaceId,
                    240,
                  ),
                }
              : {}),
          };
          try {
            const result = await originalExecute(
              call,
              contextWithNestedApprovalObserver(context, event),
            );
            await observeResult(event, result);
            if (event.name === "linear_get_issue") {
              event.linearIssueId = boundedIssueIdentity(
                result?.output?.id,
                result?.output?.issue?.id,
                call?.arguments?.id,
                call?.arguments?.issueId,
                call?.arguments?.identifier,
              );
            }
            if (repositoryMutationToolNames.has(event.name)) {
              event.workspacePaths = boundedWorkspacePaths(
                call?.arguments?.path,
                call?.arguments?.destinationPath,
                call?.arguments?.toPath,
              );
            }
            return result;
          } finally {
            event.completedAt = new Date().toISOString();
            w.__byokToolEvents!.push(event);
            try {
              await w.__byokToolEventSinkV1?.(event);
            } catch {
              // A disconnected proof sink must not alter product execution.
            }
          }
        };
      }
      const originalExecutePrepared =
        registry.executePrepared?.bind(registry);
      if (originalExecutePrepared) {
        registry.executePrepared = async (
          action: any,
          context: any,
          authorization: any,
        ) => {
          const event: ObservedToolExecution = {
            sequence: sequence++,
            name: String(action?.toolName ?? ""),
            phase: "executePrepared" as const,
            startedAt: new Date().toISOString(),
            completedAt: "",
            ok: false,
            descriptorEffect: String(
              registry.getDescriptor?.(String(action?.toolName ?? ""))?.effect ??
                "",
            ),
            preparedAction: observePreparedAction(action),
            authorization: observeAuthorization(context, authorization),
            nestedApprovals: [],
            ...(boundedString(
              action?.normalizedArgs?.workspaceId ??
                action?.target?.workspaceId,
              240,
            )
              ? {
                  workspaceId: boundedString(
                    action?.normalizedArgs?.workspaceId ??
                      action?.target?.workspaceId,
                    240,
                  ),
                }
              : {}),
          };
          try {
            const result = await originalExecutePrepared(
              action,
              contextWithNestedApprovalObserver(context, event),
              authorization,
            );
            await observeResult(event, result);
            if (event.name === "linear_get_issue") {
              event.linearIssueId = boundedIssueIdentity(
                result?.output?.id,
                result?.output?.issue?.id,
                action?.normalizedArgs?.id,
                action?.normalizedArgs?.issueId,
                action?.normalizedArgs?.identifier,
                action?.target?.id,
              );
            }
            if (repositoryMutationToolNames.has(event.name)) {
              event.workspacePaths = boundedWorkspacePaths(
                action?.target?.path,
                action?.normalizedArgs?.destinationPath,
                action?.normalizedArgs?.toPath,
              );
            }
            return result;
          } finally {
            event.completedAt = new Date().toISOString();
            w.__byokToolEvents!.push(event);
            try {
              await w.__byokToolEventSinkV1?.(event);
            } catch {
              // A disconnected proof sink must not alter product execution.
            }
          }
        };
      }
      return registry;
    };
    w.__byokToolObserverRestore = () => {
      plugin.createToolRegistry = originalFactory;
      delete w.__byokToolObserverRestore;
    };
  }, {
    pluginId: NATIVE_CORE_PLUGIN_ID,
    repositoryFileMutationTools: [...REPOSITORY_FILE_MUTATION_TOOLS],
  });
}

async function readToolExecutionObserver(
  page: Page,
  journal?: readonly ObservedToolExecution[],
): Promise<ObservedToolExecution[]> {
  const pageEvents = await page.evaluate(() =>
    [
      ...((window as typeof window & {
        __byokToolEvents?: ObservedToolExecution[];
      }).__byokToolEvents ?? []),
    ].sort((left, right) => left.sequence - right.sequence),
  );
  if (journal) {
    const journalCounts = new Map<string, number>();
    for (const event of journal) {
      const key = observedToolEventKey(event);
      journalCounts.set(key, (journalCounts.get(key) ?? 0) + 1);
    }
    for (const event of pageEvents) {
      const key = observedToolEventKey(event);
      const remaining = journalCounts.get(key) ?? 0;
      if (remaining <= 0) {
        throw new Error(
          `The Node-side BYOK tool journal missed a completed page event: ${event.name}.`,
        );
      }
      journalCounts.set(key, remaining - 1);
    }
    return journal
      .map((event) => ({
        ...event,
        nestedApprovals: event.nestedApprovals.map((approval) => ({
          ...approval,
        })),
        ...(event.preparedAction
          ? { preparedAction: { ...event.preparedAction } }
          : {}),
        ...(event.authorization
          ? { authorization: { ...event.authorization } }
          : {}),
        ...(event.receipt ? { receipt: { ...event.receipt } } : {}),
        ...(event.workspacePaths
          ? { workspacePaths: [...event.workspacePaths] }
          : {}),
      }))
      .sort((left, right) => left.sequence - right.sequence);
  }
  return pageEvents;
}

function observedToolEventKey(event: ObservedToolExecution): string {
  return [
    event.name,
    event.phase,
    event.startedAt,
    event.completedAt,
    event.ok ? "ok" : "error",
    event.receipt?.id ?? "",
    event.preparedAction?.id ?? "",
  ].join("\n");
}

function assertSuccessfulMutationAuthority(
  events: readonly ObservedToolExecution[],
): {
  preparedAuthorizedTools: string[];
  nestedApprovedTools: string[];
  successfulMutationEvents: ObservedToolExecution[];
} {
  const successfulMutations = events.filter(
    (event) =>
      event.ok &&
      event.descriptorEffect !== "read",
  );
  expect(
    successfulMutations.length,
    "the observer did not capture any successful receipted model mutation",
  ).toBeGreaterThan(0);
  const preparedAuthorizedTools = new Set<string>();
  const nestedApprovedTools = new Set<string>();

  for (const event of successfulMutations) {
    expect(
      event.mutationState,
      `${event.name} succeeded without an applied mutation state`,
    ).toBe("applied");
    expect(
      event.receipt,
      `${event.name} succeeded without a returned action receipt`,
    ).toBeTruthy();
    const receipt = event.receipt!;
    expect(event.descriptorEffect).not.toBe("read");
    expect(receipt.id, `${event.name} omitted its returned receipt id`).toBeTruthy();
    expect(receipt.actionId).toBeTruthy();
    expect(receipt.payloadFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(receipt.grantId).toBeTruthy();
    expect(receipt.grantId).not.toBe("policy:scoped-read");
    expect(receipt.readbackStatus).toBe("verified");
    expect(
      event.nestedApprovals.every((approval) => approval.approved),
      `${event.name} completed despite a denied nested mutation approval`,
    ).toBe(true);
    const approvalGroups = new Map<string, ObservedNestedApproval[]>();
    for (const approval of event.nestedApprovals) {
      expect(
        approval.preparedActionId,
        `${event.name} nested approval omitted its prepared action id`,
      ).toBeTruthy();
      expect(approval.payloadFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(approval.approvalId).toBeTruthy();
      expect(approval.approvalFingerprint).toBe(
        approval.payloadFingerprint,
      );
      const key = `${approval.preparedActionId}:${approval.payloadFingerprint}`;
      approvalGroups.set(key, [
        ...(approvalGroups.get(key) ?? []),
        approval,
      ]);
      nestedApprovedTools.add(approval.toolName);
    }
    for (const group of approvalGroups.values()) {
      const requiredConfirmations = Math.max(
        ...group.map((approval) => approval.requiredConfirmations),
      );
      expect(
        new Set(group.map((approval) => approval.confirmationIndex)),
        `${event.name} nested approval confirmations are incomplete`,
      ).toEqual(
        new Set(
          Array.from(
            { length: requiredConfirmations },
            (_unused, index) => index + 1,
          ),
        ),
      );
    }

    if (event.phase === "executePrepared") {
      expect(event.preparedAction, `${event.name} omitted its prepared action`).toBeTruthy();
      expect(event.authorization, `${event.name} omitted its authorization`).toBeTruthy();
      expect(event.preparedAction!.id).toBe(receipt.actionId);
      expect(event.preparedAction!.payloadFingerprint).toBe(
        receipt.payloadFingerprint,
      );
      expect(event.authorization!.preparedActionId).toBe(
        event.preparedAction!.id,
      );
      expect(event.authorization!.payloadFingerprint).toBe(
        event.preparedAction!.payloadFingerprint,
      );
      expect(event.authorization!.grantId).toBe(receipt.grantId);
      expect(event.authorization!.grantId).not.toBe("policy:scoped-read");
      preparedAuthorizedTools.add(event.name);
      continue;
    }

    // The receipt joins its authorizing approval through one of three exact
    // links, because composite publication deliberately splits authority:
    // 1. Single-action tools: the approved prepared action IS the executed
    //    action, so the fingerprints are identical.
    // 2. Composite create: the approval covers the preview action, whose
    //    decision mints the one-action grant `linear-publication-<approvalId>`
    //    that the inner create receipt records as its grantId.
    // 3. Idempotent replay/dedup: no new mutation to approve; the synthesized
    //    readback receipt shares the approval preview's content-bound
    //    idempotency key (research-publication:<workItemFingerprint>).
    // The approval may live on an earlier event (a durably completed
    // publication replayed after a step-boundary failure). A mutation nobody
    // approved anywhere in this phase still fails.
    const matchingNested = events
      .flatMap((candidate) =>
        candidate.sequence <= event.sequence ? candidate.nestedApprovals : [],
      )
      .filter(
        (approval) =>
          approval.approved &&
          approval.toolName === event.name &&
          ((approval.payloadFingerprint === receipt.payloadFingerprint &&
            approval.approvalFingerprint === receipt.payloadFingerprint) ||
            (Boolean(approval.approvalId) &&
              receipt.grantId === `linear-publication-${approval.approvalId}`) ||
            (Boolean(receipt.idempotencyKey) &&
              approval.preparedActionIdempotencyKey ===
                receipt.idempotencyKey)),
      );
    expect(
      matchingNested.length,
      [
        `${event.name} returned a mutation receipt without a matching nested exact approval anywhere in this phase.`,
        `receipt=${JSON.stringify({
          id: receipt.id,
          payloadFingerprint: receipt.payloadFingerprint,
          idempotencyKey: receipt.idempotencyKey ?? null,
          grantId: receipt.grantId,
          phase: event.phase,
          sequence: event.sequence,
        })}`,
        `observedApprovals=${JSON.stringify(
          events
            .flatMap((candidate) => candidate.nestedApprovals)
            .filter((approval) => approval.toolName === event.name)
            .map((approval) => ({
              approved: approval.approved,
              payloadFingerprint: approval.payloadFingerprint,
              approvalFingerprint: approval.approvalFingerprint ?? null,
              preparedActionIdempotencyKey:
                approval.preparedActionIdempotencyKey ?? null,
            })),
        )}`,
        `sameToolEvents=${JSON.stringify(
          events
            .filter((candidate) => candidate.name === event.name)
            .map((candidate) => ({
              sequence: candidate.sequence,
              phase: candidate.phase,
              ok: candidate.ok,
              approvals: candidate.nestedApprovals.length,
              receiptId: candidate.receipt?.id ?? null,
            })),
        )}`,
      ].join(" "),
    ).toBeGreaterThan(0);
  }

  return {
    preparedAuthorizedTools: [...preparedAuthorizedTools].sort(),
    nestedApprovedTools: [...nestedApprovedTools].sort(),
    successfulMutationEvents: [...successfulMutations],
  };
}

async function restoreToolExecutionObserver(
  page: Page | undefined,
): Promise<{
  observerRestored: boolean;
  researchRestored: boolean;
  researchMetricsRemoved: boolean;
}> {
  if (!page) {
    return {
      observerRestored: false,
      researchRestored: false,
      researchMetricsRemoved: false,
    };
  }
  return page.evaluate(() => {
    const w = window as typeof window & {
      __byokToolObserverRestore?: () => void;
      __byokResearchRestore?: () => void;
      __byokResearchMetrics?: unknown;
    };
    const hadObserver = typeof w.__byokToolObserverRestore === "function";
    const hadResearch = typeof w.__byokResearchRestore === "function";
    w.__byokToolObserverRestore?.();
    w.__byokResearchRestore?.();
    return {
      observerRestored:
        hadObserver && typeof w.__byokToolObserverRestore !== "function",
      researchRestored:
        hadResearch && typeof w.__byokResearchRestore !== "function",
      researchMetricsRemoved: !("__byokResearchMetrics" in w),
    };
  });
}

async function readVerifiedCodeHandoff(
  page: Page,
  profileKey: string,
): Promise<any> {
  return page.evaluate(
    async ({ pluginId, codePluginId, profileKey }) => {
      const app = (window as typeof window & { app?: any }).app;
      const code = app?.plugins?.plugins?.[pluginId]
        ?.getBundledCapability?.(codePluginId);
      return code?.resolveVerifiedCodePublicationHandoff?.(profileKey) ?? null;
    },
    {
      pluginId: NATIVE_CORE_PLUGIN_ID,
      codePluginId: PHASE4_CODE_PLUGIN_ID,
      profileKey,
    },
  );
}

async function resolveWorkspaceBinding(
  page: Page,
  workspaceId: string,
): Promise<{ root: string; branch: string }> {
  const binding = await page.evaluate(
    async ({ pluginId, codePluginId, workspaceId }) => {
      const app = (window as typeof window & { app?: any }).app;
      const code = app?.plugins?.plugins?.[pluginId]
        ?.getBundledCapability?.(codePluginId);
      const manager = code?.workspaceManager ?? code?.runtime?.workspaceManager;
      const manifest = await manager?.loadManifest?.(workspaceId);
      return {
        root: String(
          manifest?.repositoryBinding?.worktreeRoot ??
            manifest?.canonicalRoot ??
            "",
        ),
        branch: String(manifest?.repositoryBinding?.branch ?? ""),
      };
    },
    {
      pluginId: NATIVE_CORE_PLUGIN_ID,
      codePluginId: PHASE4_CODE_PLUGIN_ID,
      workspaceId,
    },
  );
  if (!binding.root || !binding.branch) {
    throw new Error(`Workspace ${workspaceId} has no durable repository binding.`);
  }
  return { root: await realpath(binding.root), branch: binding.branch };
}

async function readLocalCommitIdentity(root: string): Promise<{
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}> {
  const { stdout } = await execFileAsync(
    "git",
    ["show", "-s", "--format=%H%n%an%n%ae%n%cn%n%ce", "HEAD"],
    {
      cwd: root,
      timeout: 30_000,
      windowsHide: true,
      encoding: "utf8",
    },
  );
  const [sha, authorName, authorEmail, committerName, committerEmail] =
    stdout.trim().split(/\r?\n/u);
  return {
    sha: sha ?? "",
    authorName: authorName ?? "",
    authorEmail: authorEmail ?? "",
    committerName: committerName ?? "",
    committerEmail: committerEmail ?? "",
  };
}

function findExportReceipts(snapshot: any): any[] {
  return Array.isArray(snapshot?.lastReceipts)
    ? snapshot.lastReceipts.filter(
        (receipt: any) =>
          receipt?.toolName === "code_workspace_export_directory" &&
          receipt?.operation === "create",
      )
    : [];
}

function assertSandboxValidationReceipt(
  snapshot: any,
  toolName: "code_validate_targeted" | "code_validate_full",
  expectedReceiptId: string,
  expectedWorkspaceId: string,
): void {
  const receipt = snapshot?.lastReceipts?.find(
    (candidate: any) =>
      candidate?.id === expectedReceiptId &&
      candidate?.toolName === toolName,
  );
  expect(
    receipt,
    `${toolName} receipt ${expectedReceiptId} is missing from the production run`,
  ).toBeTruthy();
  expect(receipt.readback?.status).toBe("verified");
  expect(receipt.output?.status).toBe("verified");
  const durable = receipt.output?.validationReceipt;
  expect(durable?.id).toBe(expectedReceiptId);
  expect(durable?.kindName).toBe("code_validation");
  expect(durable?.status).toBe("passed");
  expect(durable?.freshSandbox).toBe(true);
  expect(durable?.binding?.workspaceId).toBe(expectedWorkspaceId);
  expect(durable?.binding?.profileKey).toBe(PROFILE_KEY);
  expect(durable?.binding?.stagedFiles?.length).toBeGreaterThan(0);
}

function requireVerifiedExportReceipt(snapshot: any): any {
  const receipts = findExportReceipts(snapshot);
  if (receipts.length !== 1) {
    throw new Error(
      `Expected exactly one Desktop export receipt, observed ${receipts.length}.`,
    );
  }
  const receipt = receipts[0];
  if (receipt?.readback?.status !== "verified") {
    throw new Error("Desktop export did not carry verified host readback.");
  }
  return receipt;
}

function exportedDirectoryPath(receipt: any): string {
  const candidates = [
    receipt?.resource?.path,
    receipt?.path,
    receipt?.output?.destinationPath,
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  if (candidates.length === 0) {
    throw new Error("Desktop export receipt has no absolute destination path.");
  }
  if (candidates.some((candidate) => !path.isAbsolute(candidate))) {
    throw new Error("Desktop export receipt contains a relative destination path.");
  }
  const resolved = new Map(
    candidates.map((candidate) => [
      normalizePathCase(path.resolve(candidate)),
      path.resolve(candidate),
    ]),
  );
  if (resolved.size !== 1) {
    throw new Error("Desktop export receipt destination paths disagree.");
  }
  return [...resolved.values()][0]!;
}

async function resolveDesktopRoot(): Promise<string> {
  const candidates = [
    process.env.OneDrive?.trim()
      ? path.join(process.env.OneDrive.trim(), "Desktop")
      : "",
    path.join(homedir(), "Desktop"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const info = await lstat(candidate).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink()) {
      return realpath(candidate);
    }
  }
  throw new Error("Windows Desktop could not be resolved safely.");
}

async function assertSafeDesktopExport(
  desktopRoot: string,
  exportPath: string,
  expectedDirectoryName: string,
  createdAfterMs: number,
): Promise<string> {
  const desktop = await realpath(desktopRoot);
  const expected = path.resolve(desktop, expectedDirectoryName);
  const candidate = path.resolve(exportPath);
  if (normalizePathCase(candidate) !== normalizePathCase(expected)) {
    throw new Error(
      `Export path was not the exact lane-owned Desktop target: ${candidate}`,
    );
  }
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Export is not a normal IDE-readable directory.");
  }
  if (
    Math.max(info.birthtimeMs, info.ctimeMs) <
    Math.max(0, createdAfterMs - 5_000)
  ) {
    throw new Error("Export predates the current BYOK journey.");
  }
  const exported = await realpath(candidate);
  if (normalizePathCase(exported) !== normalizePathCase(expected)) {
    throw new Error(`Export realpath drifted from its owned target: ${exported}`);
  }
  return exported;
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const queue = [root];
  const files: string[] = [];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      visited += 1;
      if (visited > 200) throw new Error("Export inventory exceeded 200 entries.");
      const absolute = path.join(current, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`Export contains symbolic link: ${absolute}`);
      }
      if (entry.isDirectory()) queue.push(absolute);
      if (entry.isFile()) {
        files.push(path.relative(root, absolute).replace(/\\/gu, "/"));
      }
    }
  }
  return files.sort();
}

async function cleanupOwnedExportDirectory(
  desktopRoot: string,
  exportPath: string,
  expectedDirectoryName: string,
): Promise<void> {
  const desktop = await realpath(desktopRoot);
  const expected = path.resolve(desktop, expectedDirectoryName);
  const candidate = path.resolve(exportPath);
  if (normalizePathCase(candidate) !== normalizePathCase(expected)) {
    throw new Error(`Refusing to clean a non-owned export path: ${candidate}`);
  }
  const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Refusing to clean a non-directory export: ${candidate}`);
  }
  const exported = await realpath(candidate);
  if (normalizePathCase(exported) !== normalizePathCase(expected)) {
    throw new Error(`Refusing to clean a redirected export path: ${exported}`);
  }
  await rm(candidate, { recursive: true, force: false });
  const survived = await lstat(candidate).then(
    () => true,
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? false : Promise.reject(error),
  );
  if (survived) {
    throw new Error(`Desktop export survived cleanup: ${exported}`);
  }
}

function ownedDesktopExportFromReceipt(
  receipt: any,
  expectedLabel: string,
): { path: string; directoryName: string; runId: string } {
  const runId = String(receipt?.runId ?? "").trim();
  if (!runId || runId.length > 240) {
    throw new Error("Desktop export receipt omitted its bounded run lineage.");
  }
  const normalizedRunId = runId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
  const runSuffix = normalizedRunId.slice(-12);
  if (!/^[a-z0-9]{1,12}$/u.test(runSuffix)) {
    throw new Error(`Desktop export receipt has an invalid run id: ${runId}`);
  }
  const directoryName = `${expectedLabel}-${runSuffix}`;
  const exportPath = exportedDirectoryPath(receipt);
  if (
    normalizePathCase(path.basename(path.resolve(exportPath))) !==
    normalizePathCase(directoryName)
  ) {
    throw new Error(
      `Desktop export path does not match its host-bound run lineage: ${exportPath}`,
    );
  }
  return { path: exportPath, directoryName, runId };
}

function registerObservedOwnedExport(
  observed: Map<string, string>,
  preexisting: ReadonlySet<string>,
  owned: { path: string; directoryName: string },
): void {
  const candidate = path.resolve(owned.path);
  const key = normalizePathCase(candidate);
  if (preexisting.has(key)) {
    throw new Error(
      `Desktop export target predated the current journey: ${candidate}`,
    );
  }
  const previous = observed.get(key);
  if (previous && previous !== owned.directoryName) {
    throw new Error(`Desktop export ownership drifted for ${candidate}.`);
  }
  observed.set(key, owned.directoryName);
}

async function listExistingOwnedExportCandidates(
  desktopRoot: string,
  expectedLabel: string,
): Promise<string[]> {
  const candidates: string[] = [];
  const pattern = new RegExp(
    `^${expectedLabel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-[a-z0-9]{1,12}$`,
    "u",
  );
  for (const entry of await readdir(desktopRoot, { withFileTypes: true })) {
    if (pattern.test(entry.name)) {
      candidates.push(path.resolve(desktopRoot, entry.name));
    }
  }
  return candidates.sort();
}

async function listNewOwnedExportCandidates(
  desktopRoot: string,
  expectedLabel: string,
  preexisting: ReadonlySet<string>,
): Promise<string[]> {
  return (await listExistingOwnedExportCandidates(desktopRoot, expectedLabel))
    .filter((candidate) => !preexisting.has(normalizePathCase(candidate)))
    .sort();
}

function normalizePathCase(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function assertPathAbsent(candidate: string): Promise<void> {
  const survived = await lstat(candidate).then(
    () => true,
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? false : Promise.reject(error),
  );
  if (survived) {
    throw new Error(`Owned fixture path survived cleanup: ${candidate}`);
  }
}

async function readFinalizedGithubPublication(
  page: Page,
  repository: string,
): Promise<any> {
  return page.evaluate(
    ({ pluginId, repository }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const checkpoints = Object.values(
        plugin?.githubPublicationCheckpointNamespace?.checkpoints ?? {},
      ) as any[];
      return (
        checkpoints.find(
          (checkpoint) =>
            checkpoint?.status === "finalized" &&
            String(checkpoint?.pullRequest?.htmlUrl ?? "").includes(
              `/${repository}/pull/`,
            ),
        ) ?? null
      );
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, repository },
  ).then((checkpoint) => {
    if (!checkpoint) {
      throw new Error("Finalized GitHub publication checkpoint is missing.");
    }
    return checkpoint;
  });
}

async function readExternalActionReceipt(
  page: Page,
  receiptId: string,
): Promise<any> {
  const receipt = await page.evaluate(
    ({ pluginId, receiptId }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const entry = plugin?.externalActionReceiptLedger?.entries?.find(
        (candidate: any) => candidate?.receipt?.id === receiptId,
      );
      return entry?.receipt ?? null;
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, receiptId },
  );
  if (!receipt) {
    throw new Error(`External action receipt is missing: ${receiptId}`);
  }
  return receipt;
}

function assertVerifiedExternalReceipt(
  receipt: any,
  toolName: string,
  label: string,
): void {
  expect(receipt?.toolName, `${label} tool`).toBe(toolName);
  expect(receipt?.actionId, `${label} action id`).toBeTruthy();
  expect(receipt?.payloadFingerprint, `${label} fingerprint`).toMatch(
    /^sha256:[a-f0-9]{64}$/u,
  );
  expect(receipt?.grantId, `${label} grant`).toBeTruthy();
  expect(receipt?.grantId, `${label} grant scope`).not.toBe(
    "policy:scoped-read",
  );
  expect(receipt?.readback?.status, `${label} readback`).toBe("verified");
}

function assertExternalReceiptMatchesNestedApproval(
  receipt: any,
  successfulMutationEvents: readonly ObservedToolExecution[],
  toolName: string,
  label: string,
): void {
  assertVerifiedExternalReceipt(receipt, toolName, label);
  const matching: Array<{
    event: ObservedToolExecution;
    approval: ObservedNestedApproval;
  }> = [];
  for (const event of successfulMutationEvents) {
    for (const approval of event.nestedApprovals) {
      if (
        approval.approved &&
        approval.toolName === toolName &&
        approval.preparedActionId === receipt.actionId &&
        approval.payloadFingerprint === receipt.payloadFingerprint &&
        approval.approvalFingerprint === receipt.payloadFingerprint
      ) {
        matching.push({ event, approval });
      }
    }
  }
  expect(
    matching,
    `${label} receipt is not bound to its nested prepared approval`,
  ).toHaveLength(1);
  expect(receipt.grantId).toBe(
    `linear-finalization-${matching[0]!.approval.approvalId}`,
  );
}

function requireNestedApproval(
  successfulMutationEvents: readonly ObservedToolExecution[],
  toolName: string,
  label: string,
): ObservedNestedApproval {
  const matching: ObservedNestedApproval[] = [];
  for (const event of successfulMutationEvents) {
    for (const approval of event.nestedApprovals) {
      if (approval.approved && approval.toolName === toolName) {
        matching.push(approval);
      }
    }
  }
  expect(matching, `${label} exact approval`).toHaveLength(1);
  const approval = matching[0]!;
  expect(approval.preparedActionId).toBeTruthy();
  expect(approval.payloadFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(approval.approvalId).toBeTruthy();
  expect(approval.approvalFingerprint).toBe(approval.payloadFingerprint);
  return approval;
}

function extractVisibleCompletionReflection(note: string): {
  count: number;
  visible: string;
  wordCount: number;
} {
  const heading =
    /^## (?:Mission completion reflection|Agent project reflection)\s*$/gimu;
  const starts = [...note.matchAll(heading)];
  const first = starts[0];
  const bodyStart =
    first?.index === undefined ? -1 : first.index + first[0].length;
  const nextHeading =
    bodyStart < 0
      ? null
      : /^##\s+/gmu.exec(note.slice(bodyStart));
  const bodyEnd =
    bodyStart < 0
      ? -1
      : nextHeading?.index === undefined
        ? note.length
        : bodyStart + nextHeading.index;
  const raw =
    bodyStart < 0 || bodyEnd < bodyStart
      ? ""
      : note.slice(bodyStart, bodyEnd);
  const visible = raw
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const countable = visible.replace(/https?:\/\/[^\s)]+/giu, " ");
  const words =
    countable.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? [];
  return { count: starts.length, visible, wordCount: words.length };
}

async function readRawRunSnapshot(page: Page): Promise<any> {
  return page.evaluate(({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    return plugin?.getMissionRunSnapshot?.() ?? null;
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

async function expectTrustedRepositoryProfile(
  page: Page,
  profileKey: string,
  repositoryRoot: string,
): Promise<void> {
  const observed = await page.evaluate(
    async ({ pluginId, codePluginId, profileKey }) => {
      const app = (window as typeof window & { app?: any }).app;
      const code = app?.plugins?.plugins?.[pluginId]
        ?.getBundledCapability?.(codePluginId);
      const profile = await code?.resolveTrustedRepositoryProfile?.(profileKey);
      return profile
        ? {
            key: profile.key,
            repositoryRoot: profile.repositoryRoot,
            projectAllowedPaths: profile.projects?.map(
              (project: { id: string; root: string; allowedPaths: string[] }) => ({
                id: project.id,
                root: project.root,
                allowedPaths: project.allowedPaths,
              }),
            ),
          }
        : null;
    },
    {
      pluginId: NATIVE_CORE_PLUGIN_ID,
      codePluginId: PHASE4_CODE_PLUGIN_ID,
      profileKey,
    },
  );
  expect(observed).toEqual({
    key: profileKey,
    repositoryRoot,
    projectAllowedPaths: [{
      id: "root",
      root: ".",
      allowedPaths: [...TRUSTED_REPOSITORY_WRITE_PATHS].sort(),
    }],
  });
}

async function assertLinearReady(page: Page, teamId: string): Promise<void> {
  const readiness = await page.evaluate(
    async ({ pluginId, teamId }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      if (!plugin) return { ok: false, message: "Linear client unavailable." };
      plugin.settings.linearEnabled = true;
      plugin.settings.linearDefaultTeamId = teamId;
      await plugin.saveSettings?.();
      const connection = await plugin.testLinearConnection?.();
      if (connection?.ok !== true) {
        const oauthStatus = plugin.getLinearOAuthStatus?.();
        return {
          ok: false,
          message: [
            String(
            connection?.message ?? connection?.error ?? "Linear discovery failed.",
            ),
            typeof oauthStatus?.message === "string"
              ? oauthStatus.message
              : "",
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 600),
        };
      }
      const snapshot = plugin.getLinearCapabilitySnapshot?.();
      const teamVisible = Array.isArray(snapshot?.teams) &&
        snapshot.teams.some((team: any) => team?.id === teamId);
      if (!teamVisible) {
        return {
          ok: false,
          message: "Configured Linear team was not returned by the provider.",
        };
      }
      if (!String(plugin.settings?.linearCompletedStateId ?? "").trim()) {
        const completedState = Array.isArray(snapshot?.workflowStates)
          ? snapshot.workflowStates.find(
              (state: any) =>
                state?.type === "completed" &&
                (state?.teamId === null || state?.teamId === teamId),
            )
          : null;
        if (completedState?.id) {
          plugin.settings.linearCompletedStateId = completedState.id;
          await plugin.saveSettings?.();
        }
      }
      if (!String(plugin.settings?.linearCompletedStateId ?? "").trim()) {
        return { ok: false, message: "Linear completed state is unresolved." };
      }
      return { ok: true, message: "ready" };
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, teamId },
  );
  if (!readiness.ok) throw new Error(`Linear is not ready: ${readiness.message}`);
}

async function findLinearIssuesByMarker(
  page: Page,
  marker: string,
  teamId: string,
): Promise<Array<{ id: string; url: string }>> {
  const providerMatches = await page.evaluate(
    async ({ pluginId, marker, teamId }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const registry = plugin?.createToolRegistry?.();
      if (!registry) {
        throw new Error("Production Linear marker cleanup surface is unavailable.");
      }
      const matches = new Map<
        string,
        { id: string; url: string; trashed: boolean }
      >();
      let completedReaders = 0;
      for (const [name, baseArgs] of [
        [
          "linear_search_issues",
          { query: marker, first: 50, includeArchived: true },
        ],
        [
          "linear_list_issues",
          {
            first: 50,
            includeArchived: true,
            filter: { team: { id: { eq: teamId } } },
          },
        ],
      ] as const) {
        if (!registry.getDescriptor?.(name)) continue;
        let after = "";
        const seenCursors = new Set<string>();
        let readerComplete = false;
        for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
          const result = await registry.execute(
            {
              id: `${name}-${Date.now()}-${pageIndex}`,
              name,
              arguments: {
                ...baseArgs,
                ...(after ? { after } : {}),
              },
            },
            plugin.createToolExecutionContext(
              `find disposable issue ${marker}`,
            ),
          );
          if (!result?.ok) break;
          const output = result?.output as any;
          if (
            !Array.isArray(output?.items) ||
            typeof output?.pageInfo?.hasNextPage !== "boolean"
          ) {
            break;
          }
          for (const issue of output.items) {
            if (
              String(issue?.team?.id ?? "") !== teamId ||
              !`${String(issue?.title ?? "")}\n${String(
                issue?.description ?? "",
              )}`.includes(marker) ||
              !String(issue?.id ?? "")
            ) {
              continue;
            }
            matches.set(String(issue.id), {
              id: String(issue.id),
              url: String(issue.url ?? ""),
              trashed:
                issue?.trashed === true ||
                issue?.attributes?.trashed === true,
            });
          }
          if (output.pageInfo.hasNextPage !== true) {
            readerComplete = true;
            break;
          }
          const nextCursor = String(output.pageInfo.endCursor ?? "");
          if (!nextCursor || seenCursors.has(nextCursor)) break;
          seenCursors.add(nextCursor);
          after = nextCursor;
        }
        if (readerComplete) completedReaders += 1;
      }
      if (completedReaders === 0) {
        throw new Error(
          "No Linear provider read completed pagination during marker cleanup.",
        );
      }
      return [...matches.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, marker, teamId },
  );
  return filterActiveLinearIssueReadbacks(providerMatches).map(
    ({ id, url }) => ({ id, url }),
  );
}

function addOwnedLinearIssueIdsFromReceipts(
  target: Set<string>,
  receipts: unknown,
): void {
  if (!Array.isArray(receipts)) return;
  for (const receipt of receipts) {
    const value = receipt as any;
    const toolName = String(value?.toolName ?? "");
    const operation = String(value?.operation ?? "");
    const resourceSystem = String(
      value?.resource?.system ?? value?.resourceSystem ?? "",
    );
    const resourceType = String(
      value?.resource?.resourceType ?? value?.resourceType ?? "",
    );
    const resourceId = String(
      value?.resource?.id ?? value?.resourceId ?? "",
    ).trim();
    if (
      toolName === "linear_create_issue" &&
      operation === "create" &&
      resourceSystem === "linear" &&
      resourceType === "issue" &&
      /^[A-Za-z0-9-]{8,300}$/u.test(resourceId)
    ) {
      target.add(resourceId);
    }
  }
}

async function cleanupLinearIssue(
  page: Page,
  issueId: string,
  marker: string,
  teamId: string,
): Promise<Awaited<ReturnType<typeof cleanupExactOwnedLinearIssueToTrash>>> {
  return cleanupExactOwnedLinearIssueToTrash({
    issueId,
    marker,
    teamId,
    readIssue: async (exactIssueId) =>
      page.evaluate(
        async ({ pluginId, exactIssueId }) => {
          const plugin = (window as typeof window & { app?: any }).app?.plugins
            ?.plugins?.[pluginId];
          const client = plugin?.createSecretBackedLinearClient?.();
          if (!client) {
            throw new Error("Production Linear cleanup client is unavailable.");
          }
          try {
            const issue = (await client.execute("issues.get", {
              id: exactIssueId,
            })) as any;
            return {
              id: String(issue?.id ?? ""),
              teamId: String(
                issue?.team?.id ??
                  issue?.attributes?.team?.id ??
                  issue?.attributes?.team ??
                  "",
              ),
              title: String(issue?.title ?? ""),
              description: String(issue?.description ?? ""),
              trashed:
                issue?.trashed === true ||
                issue?.attributes?.trashed === true,
            };
          } catch (error) {
            if (String((error as any)?.code ?? "") === "linear_not_found") {
              return null;
            }
            throw error;
          }
        },
        { pluginId: NATIVE_CORE_PLUGIN_ID, exactIssueId },
      ),
    trashIssue: async (exactIssueId) => {
      await executeLinearCleanupMutation(
        page,
        "linear_trash_issue",
        exactIssueId,
      );
    },
    findActiveMarkerSurvivors: () =>
      findLinearIssuesByMarker(page, marker, teamId),
  });
}

async function executeLinearCleanupMutation(
  page: Page,
  toolName: "linear_trash_issue",
  issueId: string,
): Promise<void> {
  await page.evaluate(
    async ({ pluginId, toolName, issueId }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const registry = plugin?.createToolRegistry?.();
      if (!registry?.prepare || !registry?.executePrepared) {
        throw new Error("Production Linear cleanup registry is unavailable.");
      }
      if (!registry.getDescriptor?.(toolName)) {
        throw new Error(`Production Linear cleanup tool is unavailable: ${toolName}.`);
      }
      const operationId = `byok-cleanup-${toolName}-${Date.now()}-${issueId}`;
      const context = {
        ...plugin.createToolExecutionContext(
          "Clean the exact marker-owned disposable BYOK proof issue.",
        ),
        runId: `byok-cleanup-${issueId}`,
        operationId,
        deadlineAt: Date.now() + 60_000,
      };
      const prepared = await registry.prepare(
        {
          id: operationId,
          name: toolName,
          arguments: { id: issueId },
        },
        context,
      );
      if (!prepared?.ok || prepared.action?.toolName !== toolName) {
        throw new Error(
          `Linear cleanup preparation failed (${String(
            prepared?.error?.code ?? "prepare_invalid",
          ).slice(0, 120)}).`,
        );
      }
      const authorization = {
        preparedActionId: prepared.action.id,
        payloadFingerprint: prepared.action.payloadFingerprint,
        grantId: `byok-cleanup-${toolName}-${issueId}`,
      };
      const executed = await registry.executePrepared(
        prepared.action,
        { ...context, authorizedAction: authorization },
        authorization,
      );
      if (
        executed?.ok !== true ||
        executed?.receipt?.toolName !== toolName ||
        executed?.receipt?.resource?.id !== issueId ||
        executed?.receipt?.readback?.status !== "verified"
      ) {
        throw new Error(
          `Linear cleanup mutation ${toolName} did not return the exact verified receipt (${String(
            executed?.error?.code ?? "receipt_invalid",
          ).slice(0, 120)}).`,
        );
      }
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, toolName, issueId },
  );
}

function requireValidOptionalGithubToken(token: string): void {
  if (
    token &&
    !/^github_pat_[A-Za-z0-9_-]{20,500}$/u.test(token) &&
    !/^gh[pousr]_[A-Za-z0-9]{20,500}$/u.test(token)
  ) {
    throw new Error("E2E_GITHUB_TOKEN has an unsupported token shape.");
  }
}

function githubClientForToken(token: string): GitHubRestClient {
  return new GitHubRestClient({
    transport: fetchTransport,
    token,
    timeoutMs: 60_000,
  });
}

async function ensureGitHubConnected(
  page: Page,
  preferredToken: string | null,
): Promise<void> {
  const leaseAvailable = await page.evaluate(async ({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    if (plugin?.getGitHubCredentialStatus?.()?.connected !== true) return false;
    try {
      await plugin.withGitHubCredentialToken(() => true);
      return true;
    } catch {
      return false;
    }
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
  if (leaseAvailable) return;

  const candidates = await collectGithubTokens(preferredToken);
  let lastError = "no candidate";
  for (const token of candidates) {
    const result = await page.evaluate(
      async ({ pluginId, token }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        if (plugin?.setGitHubHarnessAccessToken) {
          return plugin.setGitHubHarnessAccessToken(token);
        }
        if (/^github_pat_/u.test(token)) {
          return plugin?.setGitHubFineGrainedPat?.(token);
        }
        return { ok: false, message: "No compatible GitHub credential API." };
      },
      { pluginId: NATIVE_CORE_PLUGIN_ID, token },
    );
    if (result?.ok) return;
    lastError = String(result?.message ?? "unknown").slice(0, 300);
  }
  throw new Error(`GitHub credential setup failed: ${lastError}`);
}

async function readGitHubIdentity(
  page: Page,
): Promise<{ login: string; token: string }> {
  return page.evaluate(async ({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    return plugin.withGitHubCredentialToken(
      (token: string, account: { login: string }) => ({
        login: String(account?.login ?? "").trim(),
        token: String(token ?? "").trim(),
      }),
    );
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

async function collectGithubTokens(
  preferredToken: string | null,
): Promise<string[]> {
  const candidates: string[] = [];
  if (preferredToken?.trim()) candidates.push(preferredToken.trim());
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      windowsHide: true,
      timeout: 30_000,
      encoding: "utf8",
    });
    if (stdout.trim()) candidates.push(stdout.trim());
  } catch {
    // A configured vault or preferred token may still be sufficient.
  }
  return orderGitHubHarnessTokensForPush(candidates);
}

async function ensureGitHubCreateCapableCredential(input: {
  page: Page;
  client: GitHubRestClient;
  owner: string;
  preferredToken: string | null;
  onProbeRegistered?: (input: RegisteredGithubProbeV1) => void;
}): Promise<GitHubRestClient> {
  const candidates = await collectGithubTokens(input.preferredToken);
  let configuredClientProved = false;
  try {
    await proveRestCreateAndDeleteProbe(
      input.client,
      input.owner,
      input.onProbeRegistered,
    );
    configuredClientProved = true;
  } catch {
    // Try an explicitly installable harness credential below.
  }
  if (configuredClientProved) return input.client;
  let lastError = "no create-capable credential";
  for (const token of candidates) {
    const installed = await input.page.evaluate(
      async ({ pluginId, token }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        return plugin?.setGitHubHarnessAccessToken?.(token) ?? {
          ok: false,
          message: "Harness credential API unavailable.",
        };
      },
      { pluginId: NATIVE_CORE_PLUGIN_ID, token },
    );
    if (!installed?.ok) {
      lastError = String(installed?.message ?? "unknown");
      continue;
    }
    const identity = await readGitHubIdentity(input.page);
    if (identity.login.toLowerCase() !== input.owner.toLowerCase()) {
      lastError = `GitHub login drifted to ${identity.login}`;
      continue;
    }
    const client = githubClientForToken(identity.token);
    try {
      await proveRestCreateAndDeleteProbe(
        client,
        input.owner,
        input.onProbeRegistered,
      );
      return client;
    } catch (error) {
      lastError = safeExternalCleanupError(error);
    }
  }
  throw new Error(
    `No GitHub credential proved private repository create/delete and push authority: ${lastError}`,
  );
}

async function deleteRegisteredGithubProbesAndVerify(
  probes: ReadonlyMap<string, RegisteredGithubProbeV1>,
): Promise<void> {
  const failures: string[] = [];
  for (const probe of [...probes.values()].sort((left, right) =>
    left.repository.localeCompare(right.repository),
  )) {
    try {
      await deleteDisposableGitHubRepositoryAndVerify(probe);
    } catch (error) {
      failures.push(
        `${probe.owner}/${probe.repository}: ${boundedCleanupError(error)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Registered GitHub probe cleanup failed: ${failures.join(" | ")}.`,
    );
  }
}

async function attestGhCleanupAuthority(
  restActor: { id: number; login: string },
  restRepository: {
    id: number;
    fullName: string;
    private: boolean;
    permissions?: { admin: boolean };
  },
): Promise<ByokGithubCleanupAuthorityV1> {
  const actor = await readGhAuthenticatedActor();
  if (
    actor.id !== restActor.id ||
    actor.login.toLowerCase() !== restActor.login.trim().toLowerCase()
  ) {
    throw new Error(
      `Active gh actor ${actor.login} does not match REST actor ${restActor.login}.`,
    );
  }
  const { stdout } = await execFileAsync(
    "gh",
    ["api", `repos/${restRepository.fullName}`],
    {
      windowsHide: true,
      timeout: 60_000,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const remote = JSON.parse(stdout) as {
    id?: unknown;
    full_name?: unknown;
    private?: unknown;
    permissions?: { admin?: unknown };
  };
  if (
    Number(remote.id) !== restRepository.id ||
    String(remote.full_name ?? "").toLowerCase() !==
      restRepository.fullName.toLowerCase() ||
    remote.private !== true ||
    remote.permissions?.admin !== true ||
    restRepository.private !== true ||
    restRepository.permissions?.admin !== true
  ) {
    throw new Error(
      "The active gh actor could not attest the exact private disposable repository.",
    );
  }
  return {
    version: 1,
    actorId: actor.id,
    actorLogin: actor.login,
    repositoryId: restRepository.id,
    repository: restRepository.fullName,
    private: true,
    admin: true,
  };
}

async function readGhAuthenticatedActor(): Promise<{
  id: number;
  login: string;
}> {
  const { stdout } = await execFileAsync("gh", ["api", "user"], {
    windowsHide: true,
    timeout: 60_000,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const raw = JSON.parse(stdout) as { id?: unknown; login?: unknown };
  const actor = {
    id: Number(raw.id),
    login: String(raw.login ?? "").trim(),
  };
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || !actor.login) {
    throw new Error("The active gh credential returned no bounded actor.");
  }
  return actor;
}

async function assertGhRepositoriesAbsentUnderActor(
  expectedAuthority: ByokGithubCleanupAuthorityV1,
  owner: string,
  repositories: readonly string[],
): Promise<void> {
  const actor = await readGhAuthenticatedActor();
  if (
    actor.id !== expectedAuthority.actorId ||
    actor.login.toLowerCase() !==
      expectedAuthority.actorLogin.toLowerCase()
  ) {
    throw new Error(
      `Active gh actor drifted from ${expectedAuthority.actorLogin} to ${actor.login} before cleanup readback.`,
    );
  }
  if (actor.login.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `Cleanup actor ${actor.login} does not match repository owner ${owner}.`,
    );
  }
  for (const repository of repositories) {
    let absent = false;
    try {
      await execFileAsync("gh", ["api", `repos/${owner}/${repository}`], {
        windowsHide: true,
        timeout: 60_000,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      const output = [
        error instanceof Error ? error.message : String(error),
        (error as { stdout?: unknown })?.stdout,
        (error as { stderr?: unknown })?.stderr,
      ]
        .filter(Boolean)
        .join("\n");
      absent = /\bHTTP 404\b|\b404 Not Found\b/iu.test(output);
    }
    if (!absent) {
      throw new Error(
        `Repository ${owner}/${repository} still exists or was not proven absent under actor ${actor.login}.`,
      );
    }
  }
}

async function bindGitHubRepositoryDestination(
  page: Page,
  profileKey: string,
  githubRepository: string,
): Promise<void> {
  await page.evaluate(
    async ({ pluginId, profileKey, githubRepository }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const profile = plugin?.repositoryProfileRegistry?.profiles?.[profileKey];
      if (!profile?.promotionPolicy) {
        throw new Error(`Repository profile is missing: ${profileKey}`);
      }
      profile.promotionPolicy.githubRepository = githubRepository;
      const persisted =
        plugin.settings?.repositoryProfileRegistry?.profiles?.[profileKey];
      if (persisted?.promotionPolicy) {
        persisted.promotionPolicy.githubRepository = githubRepository;
      }
      await plugin.saveSettings?.();
      if (
        plugin.repositoryProfileRegistry.profiles[profileKey].promotionPolicy
          .githubRepository !== githubRepository
      ) {
        throw new Error("GitHub destination binding did not persist.");
      }
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, profileKey, githubRepository },
  );
}

function safeDisposableRepositoryName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
}

const fetchTransport: HttpTransport = async (request) => {
  const timeout = AbortSignal.timeout(Math.max(1, request.timeoutMs ?? 30_000));
  const signal = request.abortSignal
    ? AbortSignal.any([request.abortSignal, timeout])
    : timeout;
  const response = await fetch(request.url, {
    method: request.method ?? "GET",
    headers: request.headers,
    body:
      typeof request.body === "string"
        ? request.body
        : request.body instanceof ArrayBuffer
          ? request.body
          : undefined,
    signal,
    redirect: "error",
    credentials: "omit",
  });
  const text = await response.text();
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    status: response.status,
    headers,
    text,
    json,
  };
};
