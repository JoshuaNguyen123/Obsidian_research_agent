import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

import { getE2EAiConfig } from "./aiHarness";
import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";
import {
  createPhase4PythonCheckersProjectFixture,
  type Phase4PythonCheckersProjectFixture,
} from "./fixtures/phase4GitRepo";
import { PHASE4_CODE_PLUGIN_ID } from "./fixtures/phase4Harness";
import {
  NATIVE_CORE_PLUGIN_ID,
} from "./fixtures/nativeObsidianHarness";
import {
  startRealAiHarness,
  type ProjectLifecycleStageName,
  type RealAiHarness,
} from "./fixtures/realAiHarness";
import {
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories/RepositoryProfile";
import {
  GitHubApiError,
  GitHubRestClient,
} from "../src/integrations/github/GitHubRestClient";
import { LinearGraphqlClient } from "../src/integrations/linear/client";
import type { HttpTransport } from "../src/model/types";
import { liveProviderConfiguration } from "../scripts/ci-sandbox-boundary";

const execFileAsync = promisify(execFile);
const FULL_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PROFILE_KEY = "du06-checkers-project";
const VALIDATION_PROFILE_KEY = "du06-python-checkers-validation";
const LINEAR_EVIDENCE_DESTINATION_NAME = "Application Testing Dumping Grounds";
const MAIN_STAGES: readonly ProjectLifecycleStageName[] = [
  "accepted_research",
  "linear_hierarchy",
  "code_execution",
  "private_github_publication",
];
const ALL_STAGES: readonly ProjectLifecycleStageName[] = [
  ...MAIN_STAGES,
  "reconciliation_cleanup",
];

interface LinearCleanupResources {
  publicationIssueIds: string[];
  hierarchyIssueIds: string[];
  initiativeProjectLinkIds: string[];
  initiativeId: string;
  projectId: string;
}

interface LinearCleanupInventory {
  publicationIssueIds: string[];
  hierarchyIssueIds: string[];
  initiativeProjectLinkIds: string[];
  initiativeIds: string[];
  projectIds: string[];
}

interface SafeLifecycleState {
  lineages: any[];
  researchPublications: any[];
  linearHierarchies: any[];
  privateRepositories: any[];
  githubPublications: any[];
  repositoryCleanups: any[];
  privateBindings: any[];
  codeHandoff: any | null;
}

interface LinearReadbackClient {
  execute(operation: any, variables: Record<string, unknown>): Promise<unknown>;
}

interface ProtectedCredentialOwnership {
  linear: boolean;
  github: boolean;
  verifyPreservedLinear: boolean;
}

interface IndependentStageEntryProbe {
  version: 1;
  stage: ProjectLifecycleStageName;
  proofFingerprint: string;
  durableResourceFingerprint: string;
  durableCommitOccurrenceCount: 1;
  providerResourceCardinality: number;
}

interface DailyUseDu06CleanupProofV1 {
  version: 1;
  scenarioId: "DU-06";
  releaseSha: string;
  status: "verified" | "incomplete";
  linear: {
    disposableResourceCount: number;
    independentAbsenceReadback: boolean;
    retainedEvidencePreserved: boolean;
  };
  github: {
    privateRepositoryAbsenceReadback: boolean;
    branchAbsenceReadback: boolean;
    pullRequestClosedUnmergedReadback: boolean;
  };
  local: {
    worktreeCapturedAfterCreation: boolean;
    worktreeAbsenceReadback: boolean;
    vaultBackupsRemoved: number;
    vaultBackupAbsenceReadback: boolean;
    fixtureRemoved: boolean;
  };
  credentials: {
    nativeSecureStateVerified: boolean;
  };
  errors: string[];
}

test("DU-06 checkers exact-SHA lifecycle restarts, cleans disposable providers, and retains redacted Linear proof", async ({}, testInfo) => {
  test.setTimeout(120 * 60_000);
  const protectedModel = getE2EAiConfig();
  expect(process.env.E2E_MODEL_PROVIDER?.trim() || "ollama").toBe("ollama");
  expect(normalizeEndpoint(protectedModel.baseUrl)).toBe("https://ollama.com/api");
  expect(protectedModel.model.trim()).not.toBe("");
  const releaseSha = requiredEnvironment("E2E_RELEASE_COMMIT_SHA");
  const linearToken = optionalEnvironment("E2E_LINEAR_API_KEY");
  const githubToken = requiredEnvironment("E2E_GITHUB_TOKEN");
  const requestedLinearTeamId = optionalEnvironment("LINEAR_LIVE_TEST_TEAM_ID");
  const requestedLinearProjectId = optionalEnvironment(
    "E2E_RELEASE_LINEAR_PROJECT_ID",
  );
  const repositoryPrefix = requiredEnvironment(
    "E2E_RELEASE_GITHUB_REPOSITORY_PREFIX",
  );
  expect(releaseSha).toMatch(FULL_SHA);
  expect(repositoryPrefix).toMatch(/(?:disposable|e2e|sandbox|test)/iu);
  expect(repositoryPrefix).not.toMatch(/(?:^|[-_.])(prod|production)(?:$|[-_.])/iu);

  const checkoutSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      windowsHide: true,
    })
  ).stdout.trim().toLowerCase();
  expect(checkoutSha).toBe(releaseSha);
  const checkoutStatus = (
    await execFileAsync("git", ["status", "--porcelain"], {
      cwd: process.cwd(),
      windowsHide: true,
    })
  ).stdout.trim();
  expect(checkoutStatus, "DU-06 exact-SHA proof requires a clean checkout").toBe("");
  if (process.env.GITHUB_SHA?.trim()) {
    expect(process.env.GITHUB_SHA.trim().toLowerCase()).toBe(releaseSha);
  }

  const githubClient = new GitHubRestClient({
    transport: fetchTransport,
    token: githubToken,
    timeoutMs: 60_000,
  });
  let linearClient: LinearReadbackClient | null = linearToken
    ? new LinearGraphqlClient({
        transport: fetchTransport,
        apiKey: linearToken,
        timeoutMs: 60_000,
      })
    : null;
  const githubAccount = await githubClient.getAuthenticatedUser();
  const suffix = randomUUID().replace(/-/gu, "").slice(0, 16);
  const repository = safeDisposableRepositoryName(
    `${repositoryPrefix}-${releaseSha.slice(0, 8)}-${suffix}`,
  );
  const marker = `DU06_${releaseSha.slice(0, 8)}_${suffix}`;
  const notePath = `E2E Agent Tests/DU06-${suffix}.md`;
  const workspaceId = `du06-${suffix}`;
  const requestId = `du06-request-${suffix}`;
  const issueFingerprint = contractFingerprint(`${marker}:implementation`);
  const sandboxConfiguration = liveProviderConfiguration("wsl2");
  const fixture = await createPhase4PythonCheckersProjectFixture(marker);
  const profile = createRepositoryProfile({
    key: PROFILE_KEY,
    displayName: "Protected DU-06 Python checkers project",
    repositoryRoot: fixture.root,
    defaultBranch: "main",
    allowedPathPrefixes: ["README.md", "checkers", "tests"],
    validationProfile: {
      id: VALIDATION_PROFILE_KEY,
      bootstrapCommands: [],
      validationCommands: [
        {
          command: "python3",
          args: ["-m", "unittest", "discover", "-s", "tests", "-p", "test_checkers.py"],
          label: "Python targeted checkers tests",
        },
        {
          command: "python3",
          args: ["-m", "scripts.verify_project"],
          label: "Python protected checkers contract",
        },
      ],
      protectedPaths: ["scripts"],
      allowedGeneratedPaths: [],
    },
    runtimeDigests: { python: sandboxConfiguration.runtimeDigest },
    promotionPolicy: {
      localBasePromotion: "disabled",
      completionProof: "draft_pr",
      githubRepository: `${githubAccount.login}/${repository}`,
      requiredChecks: [],
    },
  });

  let harness: RealAiHarness | null = null;
  let verifiedWorktree: { root: string; branch: string } | null = null;
  let linearResources: LinearCleanupResources | null = null;
  let linearCleanupInventory: LinearCleanupInventory = emptyLinearCleanupInventory();
  let pullRequestNumber: number | null = null;
  let publishedBranch: string | null = null;
  let publishedSha: string | null = null;
  let linearEvidenceTeamId: string | null = null;
  let retainedLinearEvidence:
    | { id: string; identifier: string; url: string }
    | null = null;
  let retainedLinearEvidencePreserved = false;
  let credentialOwnership: ProtectedCredentialOwnership = {
    linear: false,
    github: false,
    verifyPreservedLinear: false,
  };
  let missionError: unknown = null;
  let cleanupVerified = false;
  const cleanupErrors: string[] = [];
  const restartedStages: ProjectLifecycleStageName[] = [];
  const independentStageProbes = new Map<
    ProjectLifecycleStageName,
    IndependentStageEntryProbe
  >();
  let worktreeCaptureController: AbortController | null = null;
  let worktreeCapturePromise: Promise<void> | null = null;
  let worktreeCaptureError: unknown = null;
  let worktreeCapturedAfterCreation = false;
  let vaultBackupBaseline: string[] = [];
  let linearCleanupReadbackVerified = false;
  let githubRepositoryAbsenceVerified = false;
  let githubBranchAbsenceVerified = false;
  let githubPullRequestCleanupVerified = false;
  let worktreeAbsenceVerified = false;
  let vaultBackupAbsenceVerified = false;
  let vaultBackupsRemoved = 0;
  let credentialStateVerified = false;
  let fixtureRemoved = false;
  let approvalCount = 0;
  let modelCallCount = 0;
  let toolCallCount = 0;
  let acceptanceRecorded = false;

  try {
    harness = await startRealAiHarness(
      `du06-${suffix}`,
      {
        missionTimeoutMs: 110 * 60_000,
        completionTimeoutMs: 110 * 60_000,
      },
      {
        maxAgentSteps: 100,
        maxRunMinutes: 110,
        completionDrivenLoops: true,
        thinkingMode: "medium",
        orchestratorEnabled: false,
        linearEnabled: true,
        ...(requestedLinearTeamId
          ? { linearDefaultTeamId: requestedLinearTeamId }
          : {}),
        ...(requestedLinearProjectId
          ? { linearQueueProjectId: requestedLinearProjectId }
          : {}),
        githubEnabled: true,
        repositoryProfileRegistry: createRepositoryProfileRegistry([profile]),
      },
      {
        preserveConfiguredLinearCredential: !linearToken,
        preserveConfiguredGitHubCredential: true,
      },
    );
    const connection = await configureProtectedConnections(
      harness.page,
      requestedLinearTeamId,
      requestedLinearProjectId,
    );
    credentialOwnership = connection.credentialOwnership;
    expect(connection).toMatchObject({
      linearConnected: true,
      linearCredentialSecure: true,
      linearHierarchyAvailable: true,
      githubConnected: true,
      githubLogin: githubAccount.login,
    });
    expect(normalizeLinearDestinationName(connection.linearWorkspaceName)).toBe(
      normalizeLinearDestinationName(LINEAR_EVIDENCE_DESTINATION_NAME),
    );
    expect(normalizeLinearDestinationName(connection.linearTeamName)).toBe(
      normalizeLinearDestinationName(LINEAR_EVIDENCE_DESTINATION_NAME),
    );
    expect(connection.linearTeamId).toBeTruthy();
    linearEvidenceTeamId = connection.linearTeamId;
    if (requestedLinearTeamId) {
      expect(connection.linearTeamId).toBe(requestedLinearTeamId);
    }
    if (requestedLinearProjectId) {
      expect(connection.linearProjectId).toBe(requestedLinearProjectId);
    }
    linearClient ??= createPageBackedLinearReadbackClient(harness.page);
    const activeLinearClient = linearClient;

    const startedAt = Date.now();
    const sandboxProbe = await harness.page.evaluate(
      async ({ codePluginId, config }) => {
        const app = (window as typeof window & { app?: any }).app;
        const code = app?.plugins?.plugins?.["agentic-researcher"]
          ?.getBundledCapability?.(codePluginId);
        if (!code?.configureSandboxProvider || !code?.probeConfiguredSandboxProviders) {
          throw new Error("The built-in Code sandbox configuration API is unavailable.");
        }
        await code.configureSandboxProvider(config);
        const status = await code.probeConfiguredSandboxProviders();
        return { status, persisted: code.readState?.()?.sandbox?.lastProbe ?? null };
      },
      {
        codePluginId: PHASE4_CODE_PLUGIN_ID,
        config: sandboxConfiguration,
      },
    );
    expect(sandboxProbe.status).toMatchObject({
      executionAvailable: true,
      selectedProvider: "wsl2",
    });
    expect(Date.parse(String(sandboxProbe.persisted?.observedAt ?? "")))
      .toBeGreaterThanOrEqual(startedAt);
    await expectTrustedRepositoryProfile(
      harness.page,
      PROFILE_KEY,
      fixture.root,
    );
    await harness.installOwnedWebBackend({ sourceCount: 2, topic: "checkers" });
    vaultBackupBaseline = await listVaultBackupPaths(harness.page);
    worktreeCaptureController = new AbortController();
    worktreeCapturePromise = captureCreatedRepositoryWorktree({
      page: harness.page,
      workspaceId,
      expectedRepositoryRoot: fixture.root,
      signal: worktreeCaptureController.signal,
    })
      .then((captured) => {
        if (!captured) return;
        verifiedWorktree = captured;
        worktreeCapturedAfterCreation = true;
      })
      .catch((error) => {
        if (!worktreeCaptureController?.signal.aborted) {
          worktreeCaptureError = error;
        }
      });

    const mission = [
      `Build a simple American checkers game in Python and use the exact vault destination ${notePath} for its accepted research notebook.`,
      `Research American checkers rules marked ${marker} using exactly two public web sources and fetch both sources before accepting findings. The notebook must cite both fetched source URLs and passages and use the exact headings ## Board and setup, ## Movement and kings, ## Mandatory captures and multi-jumps, ## End conditions, and ## Implementation implications.`,
      `Publish the accepted checkers research note to Linear in the configured destination. The package is code work for repository key ${PROFILE_KEY} and validation requirement ${VALIDATION_PROFILE_KEY}.`,
      `Turn that accepted research into one Linear initiative, one project, and exactly one implementation issue titled Build a simple Python checkers game. Use logical keys du06-initiative-${suffix}, du06-project-${suffix}, and du06-issue-${suffix}; the issue has no dependencies, uses work-item fingerprint ${issueFingerprint}, and binds the accepted artifact fingerprint and exact source note path.`,
      "The implementation issue acceptance criteria must require an 8 by 8 board with twelve men per side; constants RED, BLACK, RED_KING, and BLACK_KING; CheckersGame(board, turn), CheckersGame.initial(), legal_moves(), apply_move(start, end), and winner(); red moving upward; mandatory captures; same-piece multi-jumps before the turn changes; capture removal; back-rank promotion; kings moving both directions; no-piece or no-legal-move wins; and a runnable CLI.",
      `After creating the hierarchy, explicitly call linear_get_issue for the returned implementation issue. Read back its title, description, acceptance criteria, and ${notePath} binding before opening the code workspace.`,
      `Reflect against both that Linear issue readback and the notebook while implementing the exact trusted repository ${fixture.root}, using durable workspace ${workspaceId} and repair request ${requestId}. Read the protected scripts/verify_project.py contract before implementation. Add only README.md, checkers/__init__.py, checkers/cli.py, checkers/game.py, and tests/test_checkers.py. Leave the protected scripts directory unchanged.`,
      `The README must include marker ${marker}, commands python -m checkers.cli and python -m unittest, the exact heading ## Research and Linear traceability, the exact Obsidian path ${notePath}, and the exact Linear issue identifier or URL returned by linear_get_issue.`,
      "Run targeted validation and then a distinct fresh full validation, create one local commit, and independently read back its exact SHA.",
      `Create the exact host-bound private GitHub repository ${githubAccount.login}/${repository}, publish that verified commit to its agent-owned branch, and open one draft pull request with the final Linear and Obsidian backlinks.`,
      "Do not merge. Do not clean up or delete any provider resource until a separate cleanup request.",
    ].join(" ");
    await harness.submitMission(mission, {
      waitForCompletion: false,
      timeoutMs: 110 * 60_000,
    });
    approvalCount += await harness.approveUntilMissionComplete(
      110 * 60_000,
      {
        maxContinuations: 10,
        restartAfterProjectStages: MAIN_STAGES,
        onStageRestarted: async (stage) => {
          restartedStages.push(stage);
          const stageIndex = MAIN_STAGES.indexOf(stage);
          expect(stageIndex).toBeGreaterThanOrEqual(0);
          expect(restartedStages).toEqual(MAIN_STAGES.slice(0, stageIndex + 1));
          await expectTrustedRepositoryProfile(
            harness!.page,
            PROFILE_KEY,
            fixture.root,
          );
          if (stage === "code_execution" && worktreeCapturePromise) {
            await waitForWorktreeCapture(worktreeCapturePromise);
            if (worktreeCaptureError) throw worktreeCaptureError;
            expect(
              worktreeCapturedAfterCreation,
              "DU-06 must capture its exact owned worktree as soon as the workspace manifest is created",
            ).toBe(true);
          }
          const state = await readSafeLifecycleState(harness!.page, PROFILE_KEY);
          const lineage = requireOne(state.lineages, "project lineage after restart");
          expect(lineage.commits.slice(0, stageIndex + 1).map((item: any) => item.stage))
            .toEqual(MAIN_STAGES.slice(0, stageIndex + 1));
          for (const priorStage of MAIN_STAGES.slice(0, stageIndex)) {
            const priorProbe = independentStageProbes.get(priorStage);
            if (!priorProbe) {
              throw new Error(
                `DU-06 lost the ${priorStage} probe before restart ${stageIndex + 1}.`,
              );
            }
            const observedPriorProbe = await test.step(
              `DU-06 restart ${stageIndex + 1} did not replay ${priorStage}`,
              () => attestIndependentStageEntry({
                stage: priorStage,
                state,
                fixture,
                githubClient,
                linearClient: activeLinearClient,
                expectedOwner: githubAccount.login,
                expectedRepository: repository,
              }),
            );
            expect(observedPriorProbe).toEqual(priorProbe);
          }
          const probe = await test.step(
            `DU-06 independent stage entry: ${stage}`,
            () => attestIndependentStageEntry({
              stage,
              state,
              fixture,
              githubClient,
              linearClient: activeLinearClient,
              expectedOwner: githubAccount.login,
              expectedRepository: repository,
            }),
          );
          expect(independentStageProbes.has(stage)).toBe(false);
          independentStageProbes.set(stage, probe);
        },
      },
    );
    expect(restartedStages).toEqual(MAIN_STAGES);

    const mainSnapshot = await harness.attestProductionRun({
      requireStructuredRouting: true,
    });
    modelCallCount += mainSnapshot.modelCallEvidence.length;
    toolCallCount += mainSnapshot.missionEvidence.length;
    expect(mainSnapshot.lastComplete.stopReason).not.toBe("error");
    expect(
      Object.values(mainSnapshot.lastMissionGraph?.nodes ?? {}).some(
        (node: any) => node?.status === "blocked" || Boolean(node?.blocker),
      ),
    ).toBe(false);
    expect(
      Object.values(mainSnapshot.lastMissionGraph?.nodes ?? {}).some(
        (node: any) =>
          node?.status === "complete" &&
          Array.isArray(node?.allowedTools) &&
          node.allowedTools.includes("linear_get_issue"),
      ),
      "the production graph must complete an explicit Linear issue read stage",
    ).toBe(true);

    const state = await readSafeLifecycleState(harness.page, PROFILE_KEY);
    const lineage = requireOne(state.lineages, "completed project lineage");
    expect(lineage.commits.map((item: any) => item.stage)).toEqual(MAIN_STAGES);
    const research = requireOne(
      state.researchPublications.filter((item) => item.status === "complete"),
      "accepted research publication",
    );
    expect(research.artifactFingerprint).toMatch(SHA256);
    expect(research.notePath).toBe(notePath);
    expect(research.issueId).toBeTruthy();
    expect(research.backlinkVerified).toBe(true);
    const hierarchy = requireOne(
      state.linearHierarchies.filter((item) => item.status === "complete"),
      "verified Linear hierarchy",
    );
    expect(hierarchy.items.every((item: any) => item.readbackFingerprint === null || SHA256.test(item.readbackFingerprint)))
      .toBe(true);
    expect(hierarchy.items.filter((item: any) => item.kind === "initiative")).toHaveLength(1);
    expect(hierarchy.items.filter((item: any) => item.kind === "project")).toHaveLength(1);
    expect(hierarchy.items.filter((item: any) => item.kind === "issue")).toHaveLength(1);
    const implementationIssueId = String(
      (requireOne(
        hierarchy.items.filter((item: any) => item.kind === "issue"),
        "checkers implementation issue",
      ) as any).resourceId,
    );
    const implementationIssue = await activeLinearClient.execute(
      "issues.get",
      { id: implementationIssueId },
    ) as any;
    expect(String(implementationIssue?.title ?? "")).toMatch(/python checkers/iu);
    const implementationIssueText = JSON.stringify(implementationIssue);
    expect(implementationIssueText).toContain(notePath);
    expect(implementationIssueText).toMatch(/mandatory capture/iu);
    expect(implementationIssueText).toMatch(/multi-jump/iu);
    expect(implementationIssueText).toMatch(/king/iu);
    expect(implementationIssueText).toMatch(/(?:command.line|\bcli\b)/iu);
    const codeHandoff = state.codeHandoff;
    expect(codeHandoff?.status).toBe("verified");
    expect(codeHandoff?.commitSha).toMatch(FULL_SHA);
    expect(codeHandoff?.parentSha).toBe(fixture.baseSha);
    expect(codeHandoff?.targetedValidationReceiptId).not.toBe(
      codeHandoff?.fullValidationReceiptId,
    );
    expect([...codeHandoff.changedPaths].sort()).toEqual([
      "README.md",
      "checkers/__init__.py",
      "checkers/cli.py",
      "checkers/game.py",
      "tests/test_checkers.py",
    ]);
    verifiedWorktree = {
      root: codeHandoff.canonicalWorktreeRoot,
      branch: codeHandoff.branch,
    };
    const verifiedCode = await fixture.inspectWorktree(verifiedWorktree.root);
    expect(verifiedCode.head).toBe(codeHandoff.commitSha);
    expect(verifiedCode.status).toBe("");
    expect(verifiedCode.files["checkers/game.py"]).toMatch(/class CheckersGame/iu);
    expect(verifiedCode.files["checkers/cli.py"]).toMatch(/def main/iu);
    expect(verifiedCode.files["README.md"]).toContain(marker);
    expect(verifiedCode.files["README.md"]).toContain(notePath);
    const implementationIssueReference = String(
      implementationIssue?.identifier ?? implementationIssue?.url ?? "",
    ).trim();
    expect(implementationIssueReference).not.toBe("");
    expect(verifiedCode.files["README.md"]).toContain(implementationIssueReference);
    expect(await fixture.head()).toBe(fixture.baseSha);
    expect(await fixture.status()).toBe("");

    const privateRepository = requireOne(
      state.privateRepositories.filter((item) => item.status === "verified"),
      "verified private repository",
    );
    expect(privateRepository.binding).toMatchObject({
      owner: githubAccount.login,
      repository,
      verifiedPrivate: true,
    });
    expect(privateRepository.binding.repositoryReadbackFingerprint).toMatch(SHA256);
    const publication = requireOne(
      state.githubPublications.filter((item) => item.status === "finalized"),
      "finalized draft publication",
    );
    expect(publication.pullRequest).toMatchObject({
      draft: true,
      state: "open",
      merged: false,
      head: { sha: codeHandoff.commitSha },
    });
    expect(publication.remoteSha).toBe(codeHandoff.commitSha);
    expect(publication.linearLinkReceiptId).toBeTruthy();
    expect(publication.obsidianReceiptId).toBeTruthy();
    const exactPullRequestNumber = Number(publication.pullRequest.number);
    const exactPublishedBranch = String(publication.branch ?? "");
    const exactPublishedSha = String(publication.remoteSha ?? "");
    if (!Number.isInteger(exactPullRequestNumber) || exactPullRequestNumber < 1) {
      throw new Error("Draft publication lost its exact pull-request number.");
    }
    if (!exactPublishedBranch.startsWith("codex/") || !FULL_SHA.test(exactPublishedSha)) {
      throw new Error("Draft publication lost its exact owned branch or commit SHA.");
    }
    pullRequestNumber = exactPullRequestNumber;
    publishedBranch = exactPublishedBranch;
    publishedSha = exactPublishedSha;
    const providerRepository = await githubClient.getRepository(
      githubAccount.login,
      repository,
    );
    expect(providerRepository.private).toBe(true);
    expect(providerRepository.archived).toBe(false);
    const providerPullRequest = await githubClient.getPullRequest(
      githubAccount.login,
      repository,
      exactPullRequestNumber,
    );
    expect(providerPullRequest).toMatchObject({
      draft: true,
      state: "open",
      merged: false,
      head: { ref: exactPublishedBranch, sha: exactPublishedSha },
    });
    expect(
      await githubClient.listPullRequestsForHead(
        githubAccount.login,
        repository,
        exactPublishedBranch,
        providerRepository.defaultBranch,
      ),
    ).toHaveLength(1);
    expect(
      (await githubClient.getReference(
        githubAccount.login,
        repository,
        exactPublishedBranch,
      )).sha,
    ).toBe(exactPublishedSha);
    const note = await readVaultNote(harness.page, notePath);
    expect(note).toContain(marker);
    expect(note).toMatch(/## Board and setup/iu);
    expect(note).toMatch(/## Movement and kings/iu);
    expect(note).toMatch(/## Mandatory captures and multi-jumps/iu);
    expect(note).toMatch(/## End conditions/iu);
    expect(note).toMatch(/## Implementation implications/iu);
    expect(note).toMatch(/8\s*(?:x|×|by)\s*8/iu);
    expect(note).toMatch(/mandatory capture/iu);
    expect(note).toMatch(/multi-jump/iu);
    expect(note).toMatch(/king/iu);
    expect(note).toMatch(/linear\.app/iu);
    expect(note).toMatch(/github\.com/iu);

    linearResources = resourcesFromState(state);
    const linearResourcesForCleanup = linearResources;
    linearCleanupInventory = inventoryFromExactLinearResources(linearResources);
    await independentlyReadLinearResources(activeLinearClient, linearResources);
    for (const stage of MAIN_STAGES) {
      const expectedProbe = independentStageProbes.get(stage);
      if (!expectedProbe) {
        throw new Error(`DU-06 lost its independent ${stage} stage-entry probe.`);
      }
      const observedProbe = await test.step(
        `DU-06 resume did not replay ${stage}`,
        () => attestIndependentStageEntry({
          stage,
          state,
          fixture,
          githubClient,
          linearClient: activeLinearClient,
          expectedOwner: githubAccount.login,
          expectedRepository: repository,
        }),
      );
      expect(observedProbe).toEqual(expectedProbe);
    }
    await testInfo.attach("daily-use-du06-stage-entry-proof.json", {
      body: Buffer.from(
        `${JSON.stringify({
          version: 1,
          scenarioId: "DU-06",
          releaseSha,
          replayDetected: false,
          stages: MAIN_STAGES.map((stage, index) => ({
            restartOrdinal: index + 1,
            priorStagesReverified: index,
            ...independentStageProbes.get(stage),
          })),
        }, null, 2)}\n`,
        "utf8",
      ),
      contentType: "application/json",
    });

    await harness.submitMission(
      [
        `Close GitHub pull request #${exactPullRequestNumber} without merging in trusted profile ${PROFILE_KEY}.`,
        `Then delete only the agent-owned branch ${exactPublishedBranch} at exact expected SHA ${exactPublishedSha}.`,
        "Do not delete the private repository in this step.",
      ].join(" "),
      { waitForCompletion: false, timeoutMs: 20 * 60_000 },
    );
    approvalCount += await harness.approveUntilMissionComplete(20 * 60_000, {
      maxContinuations: 4,
    });
    const closedPullRequest = await githubClient.getPullRequest(
      githubAccount.login,
      repository,
      exactPullRequestNumber,
    );
    expect(closedPullRequest.state).toBe("closed");
    expect(closedPullRequest.merged).toBe(false);
    githubPullRequestCleanupVerified = true;
    await expectGitHubBranchAbsent(
      githubClient,
      githubAccount.login,
      repository,
      exactPublishedBranch,
    );
    githubBranchAbsenceVerified = true;

    const linearCleanupPrompt = [
      ...linearResources.initiativeProjectLinkIds.map(
        (id) => `Use linear_delete_initiative_project_link for exact Linear link id ${id}.`,
      ),
      ...[...linearResources.hierarchyIssueIds, ...linearResources.publicationIssueIds]
        .map((id) => `Use linear_trash_issue for exact Linear issue id ${id}.`),
      `Use linear_trash_project for exact Linear project id ${linearResources.projectId}.`,
      `Use linear_trash_initiative for exact Linear initiative id ${linearResources.initiativeId}.`,
      "Perform these disposable Linear cleanup actions in the stated order and verify every provider readback.",
    ].join(" ");
    await harness.submitMission(linearCleanupPrompt, {
      waitForCompletion: false,
      timeoutMs: 25 * 60_000,
    });
    approvalCount += await harness.approveUntilMissionComplete(25 * 60_000, {
      maxContinuations: 5,
    });
    await independentlyVerifyLinearCleanup(activeLinearClient, linearResources);
    linearCleanupReadbackVerified = true;

    await harness.submitMission(
      `Reconcile and clean up this completed project by permanently deleting the exact private GitHub repository bound to trusted profile ${PROFILE_KEY}. Obtain the separate destructive approval and require independent absence readback.`,
      { waitForCompletion: false, timeoutMs: 20 * 60_000 },
    );
    approvalCount += await harness.approveUntilMissionComplete(20 * 60_000, {
      maxContinuations: 4,
      restartAfterProjectStages: ["reconciliation_cleanup"],
      onStageRestarted: async (stage) => {
        restartedStages.push(stage);
        const cleanupState = await readSafeLifecycleState(
          harness!.page,
          PROFILE_KEY,
        );
        const cleanupLineage = requireOne(
          cleanupState.lineages,
          "cleanup project lineage after restart",
        );
        expect(cleanupLineage.commits.map((item: any) => item.stage))
          .toEqual(ALL_STAGES);
        const cleanupProbe = await test.step(
          "DU-06 independent stage entry: reconciliation_cleanup",
          () => attestIndependentCleanupStageEntry({
            state: cleanupState,
            linearClient: activeLinearClient,
            linearResources: linearResourcesForCleanup,
            githubClient,
            expectedOwner: githubAccount.login,
            expectedRepository: repository,
          }),
        );
        expect(independentStageProbes.has(stage)).toBe(false);
        independentStageProbes.set(stage, cleanupProbe);
      },
    });
    expect(restartedStages).toEqual(ALL_STAGES);
    await expectGitHubRepositoryAbsent(
      githubClient,
      githubAccount.login,
      repository,
    );
    githubRepositoryAbsenceVerified = true;
    const cleanedState = await readSafeLifecycleState(harness.page, PROFILE_KEY);
    const cleanedLineage = requireOne(
      cleanedState.lineages,
      "fully reconciled project lineage",
    );
    expect(cleanedLineage.commits.map((item: any) => item.stage)).toEqual(ALL_STAGES);
    expect(cleanedLineage.commits.at(-1)?.proof).toMatchObject({
      stage: "reconciliation_cleanup",
      noUnapprovedMutations: true,
    });
    expect(cleanedLineage.commits.at(-1)?.proof.backlinkReceiptFingerprints.length)
      .toBeGreaterThan(0);
    expect(cleanedLineage.commits.at(-1)?.proof.cleanupReceiptFingerprints.length)
      .toBeGreaterThan(0);
    const repositoryCleanup = requireOne(
      cleanedState.repositoryCleanups.filter((item) => item.status === "verified"),
      "verified private repository cleanup",
    );
    expect(repositoryCleanup.receiptReadbackFingerprint).toMatch(SHA256);
    expect(cleanedState.privateBindings).toHaveLength(0);
    cleanupVerified = true;

    if (!linearEvidenceTeamId || !publishedSha) {
      throw new Error(
        "Retained Linear proof requires the verified dumping-grounds team and exact published SHA.",
      );
    }
    const evidenceTitle = `DU-06 protected checkers evidence ${releaseSha.slice(0, 8)} ${suffix}`;
    const evidenceDescription = [
      "Protected application evidence for the native Obsidian agent.",
      `Release SHA: ${releaseSha}`,
      `Accepted Obsidian note: ${notePath}`,
      `Verified implementation commit: ${publishedSha}`,
      "The disposable Linear hierarchy, draft PR branch, and private GitHub repository were independently cleaned after readback.",
      "This record intentionally contains no credentials, local filesystem paths, provider payloads, or private repository name.",
    ].join("\n\n");
    await harness.submitMission(
      [
        "Use exactly linear_create_issue and linear_get_issue.",
        `Create one retained evidence issue in the configured ${LINEAR_EVIDENCE_DESTINATION_NAME} team with exact teamId ${linearEvidenceTeamId}, exact title ${JSON.stringify(evidenceTitle)}, and exact Markdown description ${JSON.stringify(evidenceDescription)}.`,
        "Obtain the exact creation approval, then independently read the created issue back by its returned identifier.",
        "Do not archive, trash, delete, or clean up this retained evidence issue.",
      ].join(" "),
      { waitForCompletion: false, timeoutMs: 20 * 60_000 },
    );
    approvalCount += await harness.approveUntilMissionComplete(20 * 60_000, {
      maxContinuations: 3,
    });
    retainedLinearEvidence = await expectRetainedLinearEvidence({
      client: activeLinearClient,
      teamId: linearEvidenceTeamId,
      title: evidenceTitle,
      description: evidenceDescription,
    });
    expect(retainedLinearEvidence.url).toMatch(/^https:\/\//u);
    await testInfo.attach("daily-use-du06-retained-linear-evidence", {
      body: Buffer.from(
        `${JSON.stringify({
          releaseSha,
          identifier: retainedLinearEvidence.identifier,
          url: retainedLinearEvidence.url,
        }, null, 2)}\n`,
        "utf8",
      ),
      contentType: "application/json",
    });

    await recordDailyUseAcceptance(
      testInfo,
      "DU-06",
      {
        artifacts: [
          "vault:research_note",
          "vault:checkers_rules_notebook",
          "linear:initiative",
          "linear:project",
          "linear:issue",
          "linear:checkers_implementation_issue",
          "linear:issue_readback",
          "linear:retained_test_evidence",
          "code:python_checkers",
          "git:local_commit",
          "github:private_repository",
          "github:draft_pr",
        ],
        proofs: [
          "graph:authoritative",
          "research:accepted",
          "linear:hierarchy_readback",
          "linear:provider_readback",
          "linear:issue_read_before_code",
          "linear:retained_evidence_readback",
          "code:checkers_rules_contract",
          "code:workspace_validated",
          "validation:fresh_full",
          "git:exact_commit_sha",
          "git:commit_readback",
          "github:private_visibility_readback",
          "github:remote_sha_readback",
          "github:draft_pr_readback",
          "reconciliation:backlinks_and_status",
          "authority:no_unapproved_mutations",
          "resume:no_duplicates",
        ],
        approvals: [
          "approval:linear_issue_create",
          "approval:linear_hierarchy_group",
          "approval:sandbox_execution",
          "approval:github_private_repository_create",
          "approval:github_publish",
        ],
        bindings: [
          "binding:note_linear_issue",
          "binding:notebook_linear_code",
          "binding:note_commit_pr",
          "binding:linear_commit_pr",
          "binding:project_lineage",
          "binding:retained_linear_evidence",
        ],
        cleanup: [
          "cleanup:linear_fixture",
          "cleanup:github_fixture",
          "cleanup:independent_readback",
        ],
      },
      {
        modelCalls: modelCallCount,
        toolCalls: toolCallCount + hierarchy.items.length,
        continuations: restartedStages.length,
        approvals: approvalCount,
      },
      { requireComplete: true },
    );
    acceptanceRecorded = true;
  } catch (error) {
    missionError = error;
    const approved = /\bapproved=(\d+)\b/u.exec(safeError(error));
    if (approved) approvalCount += Number.parseInt(approved[1]!, 10);
  } finally {
    if (harness) {
      try {
        const counters = await readRedactedDailyUseCounters(harness.page);
        modelCallCount = Math.max(modelCallCount, counters.modelCalls);
        toolCallCount = Math.max(toolCallCount, counters.toolCalls);
      } catch (error) {
        cleanupErrors.push(`metrics recovery: ${safeError(error)}`);
      }
    }
    if (harness) {
      try {
        const recovered = await readSafeLifecycleState(harness.page, PROFILE_KEY);
        linearResources ??= resourcesFromStateOrNull(recovered);
        linearCleanupInventory = mergeLinearCleanupInventories(
          linearCleanupInventory,
          partialLinearCleanupInventoryFromState(recovered),
        );
        const publication = recovered.githubPublications.at(-1);
        pullRequestNumber ??= publication?.pullRequest?.number ?? null;
        publishedBranch ??= publication?.branch ?? null;
        publishedSha ??= publication?.remoteSha ?? null;
        if (!verifiedWorktree && recovered.codeHandoff?.canonicalWorktreeRoot) {
          verifiedWorktree = {
            root: recovered.codeHandoff.canonicalWorktreeRoot,
            branch: recovered.codeHandoff.branch,
          };
        }
      } catch (error) {
        cleanupErrors.push(`state recovery: ${safeError(error)}`);
      }
    }
    worktreeCaptureController?.abort();
    await worktreeCapturePromise;
    if (worktreeCaptureError) {
      cleanupErrors.push(`worktree capture: ${safeError(worktreeCaptureError)}`);
    }
    if (!cleanupVerified) {
      if (linearClient) {
        const linearFallback = await bestEffortLinearCleanup(
          linearClient,
          linearCleanupInventory,
        );
        linearCleanupReadbackVerified =
          linearFallback.independentAbsenceReadback;
        cleanupErrors.push(...linearFallback.errors);
      }
      cleanupErrors.push(
        ...(await bestEffortGitHubCleanup({
          client: githubClient,
          owner: githubAccount.login,
          repository,
          pullRequestNumber,
          branch: publishedBranch,
          expectedSha: publishedSha,
        })),
      );
    }
    if (linearClient) {
      try {
        await independentlyVerifyLinearInventoryCleanup(
          linearClient,
          linearCleanupInventory,
        );
        linearCleanupReadbackVerified = true;
      } catch (error) {
        cleanupErrors.push(`Linear cleanup readback: ${safeError(error)}`);
      }
      if (retainedLinearEvidence) {
        try {
          await expectRetainedLinearEvidenceStillPresent(
            linearClient,
            retainedLinearEvidence.id,
          );
          retainedLinearEvidencePreserved = true;
        } catch (error) {
          cleanupErrors.push(`retained Linear evidence readback: ${safeError(error)}`);
        }
      }
    }
    try {
      await expectGitHubRepositoryAbsent(
        githubClient,
        githubAccount.login,
        repository,
      );
      githubRepositoryAbsenceVerified = true;
      githubBranchAbsenceVerified = true;
      githubPullRequestCleanupVerified = true;
    } catch (error) {
      cleanupErrors.push(`GitHub cleanup readback: ${safeError(error)}`);
    }
    if (harness) {
      try {
        const backupCleanup = await deleteDu06OwnedVaultBackups({
          page: harness.page,
          notePath,
          baselinePaths: vaultBackupBaseline,
        });
        vaultBackupsRemoved = backupCleanup.removed;
        vaultBackupAbsenceVerified = backupCleanup.absenceVerified;
      } catch (error) {
        cleanupErrors.push(`vault backup cleanup: ${safeError(error)}`);
      }
      try {
        await clearProtectedConnections(harness.page, credentialOwnership);
        credentialStateVerified = true;
      } catch (error) {
        cleanupErrors.push(`credential cleanup: ${safeError(error)}`);
      }
    }
    try {
      await cleanupOwnedFixtureWorktrees(fixture, verifiedWorktree);
      worktreeAbsenceVerified = true;
    } catch (error) {
      cleanupErrors.push(`worktree cleanup: ${safeError(error)}`);
    }
    if (!acceptanceRecorded) {
      await recordDailyUseAcceptance(
        testInfo,
        "DU-06",
        {
          artifacts: [],
          proofs: [],
          approvals: [],
          bindings: [],
          cleanup: [],
        },
        {
          modelCalls: modelCallCount,
          toolCalls: toolCallCount,
          continuations: restartedStages.length,
          approvals: approvalCount,
        },
      ).catch((error) => {
        cleanupErrors.push(`metrics attachment: ${safeError(error)}`);
      });
    }
    await harness?.close().catch((error) => {
      cleanupErrors.push(`harness cleanup: ${safeError(error)}`);
    });
    try {
      await fixture.cleanup();
      fixtureRemoved = true;
    } catch (error) {
      cleanupErrors.push(`fixture cleanup: ${safeError(error)}`);
    }
    const disposableLinearResourceCount = linearCleanupInventory.publicationIssueIds.length +
      linearCleanupInventory.hierarchyIssueIds.length +
      linearCleanupInventory.initiativeProjectLinkIds.length +
      linearCleanupInventory.initiativeIds.length +
      linearCleanupInventory.projectIds.length;
    const cleanupStatus =
      cleanupErrors.length === 0 &&
      linearCleanupReadbackVerified &&
      githubRepositoryAbsenceVerified &&
      githubBranchAbsenceVerified &&
      githubPullRequestCleanupVerified &&
      worktreeAbsenceVerified &&
      vaultBackupAbsenceVerified &&
      credentialStateVerified &&
      fixtureRemoved &&
      (!retainedLinearEvidence || retainedLinearEvidencePreserved)
        ? "verified"
        : "incomplete";
    const cleanupProof: DailyUseDu06CleanupProofV1 = {
      version: 1,
      scenarioId: "DU-06",
      releaseSha,
      status: cleanupStatus,
      linear: {
        disposableResourceCount: disposableLinearResourceCount,
        independentAbsenceReadback: linearCleanupReadbackVerified,
        retainedEvidencePreserved: retainedLinearEvidencePreserved,
      },
      github: {
        privateRepositoryAbsenceReadback: githubRepositoryAbsenceVerified,
        branchAbsenceReadback: githubBranchAbsenceVerified,
        pullRequestClosedUnmergedReadback: githubPullRequestCleanupVerified,
      },
      local: {
        worktreeCapturedAfterCreation,
        worktreeAbsenceReadback: worktreeAbsenceVerified,
        vaultBackupsRemoved,
        vaultBackupAbsenceReadback: vaultBackupAbsenceVerified,
        fixtureRemoved,
      },
      credentials: {
        nativeSecureStateVerified: credentialStateVerified,
      },
      errors: cleanupErrors.map((error) => safeArtifactError(error, [
        repository,
        notePath,
        fixture.root,
        verifiedWorktree?.root ?? "",
        verifiedWorktree?.branch ?? "",
        publishedBranch ?? "",
        publishedSha ?? "",
        githubAccount.login,
        linearEvidenceTeamId ?? "",
        retainedLinearEvidence?.id ?? "",
        ...linearCleanupInventory.publicationIssueIds,
        ...linearCleanupInventory.hierarchyIssueIds,
        ...linearCleanupInventory.initiativeProjectLinkIds,
        ...linearCleanupInventory.initiativeIds,
        ...linearCleanupInventory.projectIds,
      ])),
    };
    await testInfo.attach("daily-use-du06-cleanup-proof.json", {
      body: Buffer.from(`${JSON.stringify(cleanupProof, null, 2)}\n`, "utf8"),
      contentType: "application/json",
    }).catch((error) => {
      cleanupErrors.push(`cleanup proof attachment: ${safeError(error)}`);
    });
    if (cleanupErrors.length > 0) {
      const primary = missionError
        ? `DU-06 failed: ${safeError(missionError)}; `
        : "";
      throw new Error(`${primary}cleanup failures: ${cleanupErrors.join("; ")}`);
    }
  }
  if (missionError) throw missionError;
});

async function configureProtectedConnections(
  page: Page,
  requestedLinearTeamId: string | null,
  requestedLinearProjectId: string | null,
) {
  return page.evaluate(async ({
    pluginId,
    linearEvidenceDestinationName,
    requestedLinearTeamId,
    requestedLinearProjectId,
  }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
    const environment = (globalThis as any).process?.env ?? {};
    const linearToken = String(environment.E2E_LINEAR_API_KEY ?? "").trim();
    const githubToken = String(environment.E2E_GITHUB_TOKEN ?? "").trim();
    if (!plugin || !githubToken) {
      throw new Error("Protected GitHub credentials are unavailable in the native runner.");
    }
    let linearOwned = false;
    let githubOwned = false;
    try {
      if (linearToken) {
        const linearSaved = await plugin.setLinearApiKey(linearToken);
        if (!linearSaved?.ok) throw new Error("Linear secure credential setup failed.");
        linearOwned = true;
      }
      const linearConnection = await plugin.testLinearConnection();
      if (!linearConnection?.ok) {
        const reason = String(
          linearConnection?.error ?? linearConnection?.message ?? "unknown",
        )
          .replace(/(?:lin_api_|Bearer\s+)[^\s,;]+/giu, "[REDACTED]")
          .replace(/[A-Za-z0-9_-]{48,}/gu, "[REDACTED]")
          .slice(0, 400);
        throw new Error(`Linear capability discovery failed: ${reason}`);
      }
      const linearCredential = plugin.getLinearCredentialStatus?.();
      const linearOAuth = plugin.getLinearOAuthStatus?.();
      if (
        linearOAuth?.connected !== true &&
        (linearCredential?.configured !== true || linearCredential?.secure !== true)
      ) {
        throw new Error("Linear credential did not land in native secure storage.");
      }
      const snapshot = plugin.getLinearCapabilitySnapshot?.();
      const normalizeDestinationName = (value: unknown) =>
        String(value ?? "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "");
      const expectedDestinationName = normalizeDestinationName(
        linearEvidenceDestinationName,
      );
      const workspaceName = String(snapshot?.workspace?.name ?? "").trim();
      const evidenceTeam = (snapshot?.teams ?? []).find(
        (team: any) =>
          normalizeDestinationName(team?.name) === expectedDestinationName,
      );
      if (
        normalizeDestinationName(workspaceName) !== expectedDestinationName ||
        !evidenceTeam
      ) {
        throw new Error(
          `Linear discovery did not verify the required ${linearEvidenceDestinationName} workspace and team.`,
        );
      }
      const requestedTeam = requestedLinearTeamId
        ? (snapshot?.teams ?? []).find(
            (team: any) => String(team?.id ?? "").trim() === requestedLinearTeamId,
          )
        : null;
      if (requestedLinearTeamId && !requestedTeam) {
        throw new Error(
          `E2E_RELEASE_LINEAR_TEAM_ID did not resolve to ${linearEvidenceDestinationName}.`,
        );
      }
      if (requestedTeam && requestedTeam?.id !== evidenceTeam?.id) {
        throw new Error(
          `E2E_RELEASE_LINEAR_TEAM_ID must identify ${linearEvidenceDestinationName}.`,
        );
      }
      const linearTeamId = String(evidenceTeam?.id ?? "").trim();
      const requestedProject = requestedLinearProjectId
        ? (snapshot?.projects ?? []).find(
            (project: any) =>
              String(project?.id ?? "").trim() === requestedLinearProjectId,
          )
        : null;
      if (requestedLinearProjectId && !requestedProject) {
        throw new Error(
          "E2E_RELEASE_LINEAR_PROJECT_ID did not resolve in the verified Linear workspace.",
        );
      }
      if (
        requestedProject &&
        Array.isArray(requestedProject?.teamIds) &&
        requestedProject.teamIds.length > 0 &&
        !requestedProject.teamIds.includes(linearTeamId)
      ) {
        throw new Error(
          `E2E_RELEASE_LINEAR_PROJECT_ID must belong to ${linearEvidenceDestinationName}.`,
        );
      }
      const linearProjectId = String(requestedProject?.id ?? "").trim();
      if (!linearTeamId) {
        throw new Error("Linear discovery did not provide a usable team destination.");
      }
      plugin.settings.linearDefaultTeamId = linearTeamId;
      plugin.settings.linearQueueProjectId = linearProjectId;
      await plugin.saveSettings();
      const registeredToolNames = new Set(
        plugin.createToolRegistry?.().getDefinitions?.().map(
          (definition: any) => String(definition?.function?.name ?? ""),
        ) ?? [],
      );

      let github = plugin.getGitHubCredentialStatus?.();
      if (github?.connected === true) {
        const leased = await plugin.withGitHubCredentialToken(
          (_token: string, account: { id: number; login: string }) => ({
            account: { ...account },
          }),
        );
        github = { ...github, account: leased.account };
      } else {
        const githubSaved = await plugin.setGitHubFineGrainedPat(githubToken);
        if (!githubSaved?.ok) {
          throw new Error(
            `GitHub secure credential setup failed: ${String(
              githubSaved?.message ?? "no provider message",
            ).slice(0, 500)}`,
          );
        }
        githubOwned = true;
        github = plugin.getGitHubCredentialStatus?.();
      }
      if (!github?.connected || !github?.account?.login) {
        throw new Error("GitHub verified identity is unavailable.");
      }
      return {
        linearConnected: true,
        linearCredentialSecure: true,
        linearTeamId,
        linearProjectId,
        linearWorkspaceName: workspaceName,
        linearTeamName: String(evidenceTeam?.name ?? "").trim(),
        linearProjectName: String(
          requestedProject?.name ?? "",
        ).trim(),
        linearHierarchyAvailable: registeredToolNames.has(
          "publish_research_project_to_linear",
        ),
        githubConnected: true,
        githubLogin: github.account.login,
        credentialOwnership: {
          linear: linearOwned,
          github: githubOwned,
          verifyPreservedLinear: !linearOwned,
        },
      };
    } catch (error) {
      if (githubOwned) await plugin.disconnectGitHub().catch(() => undefined);
      if (linearOwned) await plugin.clearLinearApiKey().catch(() => undefined);
      throw error;
    }
  }, {
    pluginId: NATIVE_CORE_PLUGIN_ID,
    linearEvidenceDestinationName: LINEAR_EVIDENCE_DESTINATION_NAME,
    requestedLinearTeamId,
    requestedLinearProjectId,
  });
}

function normalizeLinearDestinationName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

async function clearProtectedConnections(
  page: Page,
  ownership: ProtectedCredentialOwnership,
): Promise<void> {
  const result = await page.evaluate(async ({ pluginId, ownership }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
    if (!plugin) return { linear: true, github: true };
    const linear = ownership.linear
      ? await plugin.clearLinearApiKey()
      : {
          ok:
            !ownership.verifyPreservedLinear ||
            plugin.getLinearOAuthStatus?.()?.connected === true ||
            plugin.getLinearCredentialStatus?.()?.secure === true,
        };
    const github = ownership.github
      ? await plugin.disconnectGitHub()
      : { ok: true };
    return { linear: linear?.ok === true, github: github?.ok === true };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, ownership });
  if (!result.linear || !result.github) {
    throw new Error("Native secure-store credential cleanup was not verified.");
  }
}

function createPageBackedLinearReadbackClient(page: Page): LinearReadbackClient {
  return {
    async execute(operation, variables) {
      const result = await page.evaluate(async ({ pluginId, operation, variables }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
        if (!plugin?.createSecretBackedLinearClient) {
          throw new Error("The native secret-backed Linear client is unavailable.");
        }
        try {
          return {
            ok: true as const,
            value: await plugin.createSecretBackedLinearClient().execute(
              operation,
              variables,
            ),
          };
        } catch (error) {
          return {
            ok: false as const,
            error: {
              message: String((error as any)?.message ?? error).slice(0, 500),
              code: String((error as any)?.code ?? "linear_error").slice(0, 100),
            },
          };
        }
      }, { pluginId: NATIVE_CORE_PLUGIN_ID, operation, variables });
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), {
          code: result.error.code,
        });
      }
      return result.value;
    },
  };
}

async function readSafeLifecycleState(
  page: Page,
  profileKey: string,
): Promise<SafeLifecycleState> {
  return page.evaluate(async ({ pluginId, codePluginId, profileKey }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
    if (!plugin) throw new Error("Agentic Researcher is unavailable.");
    const values = (record: any) => Object.values(record ?? {});
    const researchPublications = values(
      plugin.researchPublicationCheckpointNamespace?.checkpoints,
    ).map((checkpoint: any) => ({
      publicationId: checkpoint.publicationId,
      status: checkpoint.status,
      artifactFingerprint: checkpoint.artifact?.artifactFingerprint ?? null,
      notePath: checkpoint.artifact?.notePath ?? null,
      issueId: checkpoint.issue?.id ?? null,
      backlinkVerified:
        typeof checkpoint.backlink?.afterSha256 === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(checkpoint.backlink.afterSha256),
    }));
    const linearHierarchies = values(
      plugin.researchProjectHierarchyCheckpointNamespace?.checkpoints,
    ).map((checkpoint: any) => ({
      planFingerprint: checkpoint.planFingerprint,
      status: checkpoint.status,
      approvalId: checkpoint.approvalId,
      grantId: checkpoint.grantId,
      items: (checkpoint.items ?? []).map((item: any) => ({
        key: item.key,
        kind: item.kind,
        status: item.status,
        resourceId: item.resourceId,
        readbackFingerprint: item.readbackFingerprint,
        receiptId: item.receipt?.id ?? null,
      })),
    }));
    const privateRepositories = values(plugin.githubPrivateRepositoryCheckpoints)
      .map((checkpoint: any) => ({
        creationId: checkpoint.creationId,
        status: checkpoint.status,
        receiptId: checkpoint.receipt?.id ?? null,
        binding: checkpoint.binding
          ? {
              owner: checkpoint.binding.owner,
              repository: checkpoint.binding.repository,
              verifiedPrivate: checkpoint.binding.verifiedPrivate,
              repositoryReadbackFingerprint:
                checkpoint.binding.repositoryReadbackFingerprint,
            }
          : null,
      }));
    const githubPublications = values(
      plugin.githubPublicationCheckpointNamespace?.checkpoints,
    ).map((checkpoint: any) => ({
      publicationId: checkpoint.publicationId,
      status: checkpoint.status,
      branch: checkpoint.branch,
      headSha: checkpoint.headSha,
      remoteSha: checkpoint.remoteSha,
      pullRequest: checkpoint.pullRequest,
      linearLinkReceiptId: checkpoint.linearLinkReceiptId,
      linearCompletionReceiptId: checkpoint.linearCompletionReceiptId,
      obsidianReceiptId: checkpoint.obsidianReceiptId,
    }));
    const repositoryCleanups = values(plugin.githubPrivateRepositoryCleanupCheckpoints)
      .map((checkpoint: any) => ({
        cleanupId: checkpoint.cleanupId,
        status: checkpoint.status,
        receiptId: checkpoint.receipt?.id ?? null,
        receiptReadbackFingerprint:
          checkpoint.receipt?.readback?.observedFingerprint ?? null,
      }));
    const privateBindings = values(plugin.trustedGitHubRepositoryBindingsV2)
      .map((binding: any) => ({
        profileKey: binding.repositoryProfileKey,
        owner: binding.owner,
        repository: binding.repository,
        verifiedPrivate: binding.verifiedPrivate,
        repositoryReadbackFingerprint: binding.repositoryReadbackFingerprint,
      }));
    const code = plugin.getBundledCapability?.(codePluginId);
    const codeHandoff = await code?.resolveVerifiedCodePublicationHandoff?.(profileKey) ?? null;
    return {
      lineages: plugin.getProjectLineages?.() ?? [],
      researchPublications,
      linearHierarchies,
      privateRepositories,
      githubPublications,
      repositoryCleanups,
      privateBindings,
      codeHandoff,
    };
  }, {
    pluginId: NATIVE_CORE_PLUGIN_ID,
    codePluginId: PHASE4_CODE_PLUGIN_ID,
    profileKey,
  });
}

async function expectTrustedRepositoryProfile(
  page: Page,
  profileKey: string,
  repositoryRoot: string,
): Promise<void> {
  const observed = await page.evaluate(
    async ({ corePluginId, codePluginId, expectedKey }) => {
      const app = (window as typeof window & { app?: any }).app;
      const code = app?.plugins?.plugins?.[corePluginId]
        ?.getBundledCapability?.(codePluginId);
      const profile = await code?.resolveTrustedRepositoryProfile?.(expectedKey);
      return profile
        ? {
            key: profile.key,
            repositoryRoot: profile.repositoryRoot,
          }
        : null;
    },
    {
      corePluginId: NATIVE_CORE_PLUGIN_ID,
      codePluginId: PHASE4_CODE_PLUGIN_ID,
      expectedKey: profileKey,
    },
  );
  expect(observed, "the built-in Code runtime must retain the disposable trusted profile")
    .toEqual({ key: profileKey, repositoryRoot });
}

async function captureCreatedRepositoryWorktree(input: {
  page: Page;
  workspaceId: string;
  expectedRepositoryRoot: string;
  signal: AbortSignal;
}): Promise<{ root: string; branch: string } | null> {
  while (!input.signal.aborted) {
    const observed = await input.page.evaluate(
      async ({ corePluginId, codePluginId, workspaceId }) => {
        const app = (window as typeof window & { app?: any }).app;
        const code = app?.plugins?.plugins?.[corePluginId]
          ?.getBundledCapability?.(codePluginId);
        if (!code?.workspaceManager?.loadManifest) {
          return { state: "waiting" as const };
        }
        try {
          const manifest = await code.workspaceManager.loadManifest(workspaceId);
          if (manifest?.kind !== "repository" || !manifest.repositoryBinding) {
            return { state: "waiting" as const };
          }
          return {
            state: "captured" as const,
            repositoryRoot: String(manifest.repositoryBinding.repositoryRoot ?? ""),
            worktreeRoot: String(
              manifest.repositoryBinding.worktreeRoot ?? manifest.canonicalRoot ?? "",
            ),
            branch: String(manifest.repositoryBinding.branch ?? ""),
          };
        } catch (error) {
          if ((error as any)?.code === "workspace_not_found") {
            return { state: "waiting" as const };
          }
          return { state: "error" as const };
        }
      },
      {
        corePluginId: NATIVE_CORE_PLUGIN_ID,
        codePluginId: PHASE4_CODE_PLUGIN_ID,
        workspaceId: input.workspaceId,
      },
    );
    if (observed.state === "error") {
      throw new Error("DU-06 workspace manifest readback failed during owned-worktree capture.");
    }
    if (observed.state === "captured") {
      if (
        observed.repositoryRoot !== input.expectedRepositoryRoot ||
        !observed.worktreeRoot ||
        observed.worktreeRoot === input.expectedRepositoryRoot ||
        !observed.branch.startsWith("codex/workspace-")
      ) {
        throw new Error("DU-06 workspace creation returned an unexpected repository binding.");
      }
      return { root: observed.worktreeRoot, branch: observed.branch };
    }
    await abortableDelay(100, input.signal);
  }
  return null;
}

async function waitForWorktreeCapture(capture: Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("DU-06 timed out capturing its created worktree.")),
      10_000,
    );
    capture.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function listVaultBackupPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const app = (window as typeof window & { app?: any }).app;
    const adapter = app?.vault?.adapter;
    if (!adapter?.list || !await adapter.exists?.(".agent-backups")) return [];
    const files: string[] = [];
    const folders = [".agent-backups"];
    while (folders.length > 0) {
      const folder = folders.pop()!;
      const listed = await adapter.list(folder);
      files.push(...(listed?.files ?? []));
      folders.push(...(listed?.folders ?? []));
      if (files.length + folders.length > 10_000) {
        throw new Error("Vault backup inventory exceeded the protected DU-06 bound.");
      }
    }
    return [...new Set(files)].sort();
  });
}

async function deleteDu06OwnedVaultBackups(input: {
  page: Page;
  notePath: string;
  baselinePaths: readonly string[];
}): Promise<{ removed: number; absenceVerified: true }> {
  return input.page.evaluate(
    async ({ pluginId, notePath, baselinePaths }) => {
      const app = (window as typeof window & { app?: any }).app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      if (!app?.vault?.adapter) {
        throw new Error("Vault adapter is unavailable for exact DU-06 backup cleanup.");
      }
      const baseline = new Set(baselinePaths);
      const ownedPaths = new Set<string>();
      const collectBackupPaths = (value: unknown, key = "") => {
        if (
          key === "backupPath" &&
          typeof value === "string" &&
          value.startsWith(".agent-backups/")
        ) {
          ownedPaths.add(value);
          return;
        }
        if (Array.isArray(value)) {
          for (const entry of value) collectBackupPaths(entry);
          return;
        }
        if (value && typeof value === "object") {
          for (const [childKey, child] of Object.entries(value)) {
            collectBackupPaths(child, childKey);
          }
        }
      };
      const checkpoints = await plugin?.researchPublicationCheckpointStore?.list?.();
      for (const checkpoint of Array.isArray(checkpoints) ? checkpoints : []) {
        if (checkpoint?.artifact?.notePath === notePath) {
          collectBackupPaths(checkpoint);
        }
      }
      const extension = notePath.match(/\.[^.\/]+$/u)?.[0] ?? "";
      const basename = notePath.split("/").pop()!.slice(0, -extension.length);
      const safeBasename = basename
        .replace(/[^A-Za-z0-9._-]+/gu, "-")
        .slice(0, 120) || "diagram";
      const adapter = app.vault.adapter;
      const folders = [".agent-backups"];
      if (await adapter.exists?.(".agent-backups")) {
        while (folders.length > 0) {
          const folder = folders.pop()!;
          const listed = await adapter.list(folder);
          folders.push(...(listed?.folders ?? []));
          for (const candidate of listed?.files ?? []) {
            const filename = candidate.split("/").pop() ?? "";
            if (
              !baseline.has(candidate) &&
              filename.startsWith(`${safeBasename}.`) &&
              filename.endsWith(`.backup${extension}`)
            ) {
              ownedPaths.add(candidate);
            }
          }
          if (ownedPaths.size + folders.length > 10_000) {
            throw new Error("DU-06 backup cleanup exceeded its protected bound.");
          }
        }
      }
      let removed = 0;
      for (const backupPath of [...ownedPaths].sort()) {
        const file = app.vault.getAbstractFileByPath?.(backupPath);
        if (file) {
          await app.vault.delete(file, true);
          removed += 1;
        } else if (await adapter.exists?.(backupPath)) {
          await adapter.remove(backupPath);
          removed += 1;
        }
      }
      for (const backupPath of ownedPaths) {
        if (
          app.vault.getAbstractFileByPath?.(backupPath) ||
          await adapter.exists?.(backupPath)
        ) {
          throw new Error("An exact DU-06 vault backup remained after cleanup.");
        }
      }
      return { removed, absenceVerified: true as const };
    },
    {
      pluginId: NATIVE_CORE_PLUGIN_ID,
      notePath: input.notePath,
      baselinePaths: [...input.baselinePaths],
    },
  );
}

async function cleanupOwnedFixtureWorktrees(
  fixture: Phase4PythonCheckersProjectFixture,
  captured: { root: string; branch: string } | null,
): Promise<void> {
  let worktrees = await listFixtureWorktrees(fixture.root);
  const capturedEntry = captured
    ? worktrees.find((entry) => sameFilesystemPath(entry.root, captured.root))
    : null;
  if (capturedEntry) {
    if (capturedEntry.branch !== captured!.branch) {
      throw new Error("The captured DU-06 worktree changed branches before cleanup.");
    }
    await fixture.removeOwnedWorktree(capturedEntry.root, capturedEntry.branch);
  }
  worktrees = await listFixtureWorktrees(fixture.root);
  for (const entry of worktrees) {
    if (sameFilesystemPath(entry.root, fixture.root)) continue;
    if (!entry.branch.startsWith("codex/workspace-")) {
      throw new Error("DU-06 found an unexpected branch in its disposable fixture.");
    }
    await fixture.removeOwnedWorktree(entry.root, entry.branch);
  }
  const remaining = (await listFixtureWorktrees(fixture.root)).filter(
    (entry) => !sameFilesystemPath(entry.root, fixture.root),
  );
  if (remaining.length > 0) {
    throw new Error(`DU-06 left ${remaining.length} disposable worktree(s).`);
  }
}

async function listFixtureWorktrees(
  repositoryRoot: string,
): Promise<Array<{ root: string; branch: string }>> {
  const output = (
    await execFileAsync(
      "git",
      ["-C", repositoryRoot, "worktree", "list", "--porcelain"],
      { windowsHide: true },
    )
  ).stdout;
  return output
    .split(/\r?\n\r?\n/gu)
    .map((block) => {
      const lines = block.split(/\r?\n/gu);
      const root = lines.find((line) => line.startsWith("worktree "))
        ?.slice("worktree ".length)
        .trim() ?? "";
      const branch = lines.find((line) => line.startsWith("branch refs/heads/"))
        ?.slice("branch refs/heads/".length)
        .trim() ?? "";
      return { root, branch };
    })
    .filter((entry) => entry.root.length > 0);
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string) => value
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
  return normalize(left) === normalize(right);
}

async function attestIndependentStageEntry(input: {
  stage: ProjectLifecycleStageName;
  state: SafeLifecycleState;
  fixture: Phase4PythonCheckersProjectFixture;
  githubClient: GitHubRestClient;
  linearClient: LinearReadbackClient;
  expectedOwner: string;
  expectedRepository: string;
}): Promise<IndependentStageEntryProbe> {
  const lineage = requireOne(input.state.lineages, "stage-entry project lineage");
  const matchingCommits = (Array.isArray(lineage.commits)
    ? lineage.commits
    : []).filter(
    (item: any) => item.stage === input.stage,
  ) as any[];
  const commit = requireOne<any>(
    matchingCommits,
    `${input.stage} durable stage commit`,
  );
  expect(commit?.proofFingerprint).toMatch(SHA256);
  if (input.stage === "accepted_research") {
    expect(commit.proof.notePath).toMatch(/\.md$/u);
    expect(commit.proof.noteSha256).toMatch(SHA256);
    const publication = requireOne(
      input.state.researchPublications.filter(
        (item) => item.artifactFingerprint === commit.proof.artifactFingerprint,
      ),
      "accepted-research stage publication",
    );
    expect(publication).toMatchObject({
      status: "complete",
      notePath: commit.proof.notePath,
      artifactFingerprint: commit.proof.artifactFingerprint,
    });
    await expectLinearResource(
      input.linearClient,
      "issues.get",
      String(publication.issueId),
    );
    return createIndependentStageEntryProbe(
      input.stage,
      commit.proofFingerprint,
      [
        publication.artifactFingerprint,
        publication.notePath,
        publication.issueId,
      ],
      1,
    );
  }
  if (input.stage === "linear_hierarchy") {
    const hierarchy = requireOne(
      input.state.linearHierarchies.filter((item) => item.status === "complete"),
      "Linear stage hierarchy",
    );
    await expectLinearResource(input.linearClient, "initiatives.get", commit.proof.initiativeId);
    await expectLinearResource(input.linearClient, "projects.get", commit.proof.projectId);
    for (const issueId of commit.proof.issueIds) {
      await expectLinearResource(input.linearClient, "issues.get", issueId);
    }
    const hierarchyIdentities = hierarchy.items
      .map((item: any) => `${item.kind}:${item.resourceId}`)
      .sort();
    expect(hierarchyIdentities.filter((item: string) => item.startsWith("initiative:")))
      .toHaveLength(1);
    expect(hierarchyIdentities.filter((item: string) => item.startsWith("project:")))
      .toHaveLength(1);
    expect(hierarchyIdentities.filter((item: string) => item.startsWith("issue:")))
      .toHaveLength(1);
    return createIndependentStageEntryProbe(
      input.stage,
      commit.proofFingerprint,
      hierarchyIdentities,
      hierarchyIdentities.length,
    );
  }
  if (input.stage === "code_execution") {
    expect(input.state.codeHandoff?.status).toBe("verified");
    expect(input.state.codeHandoff?.commitSha).toBe(commit.proof.commitSha);
    const worktree = await input.fixture.inspectWorktree(
      input.state.codeHandoff.canonicalWorktreeRoot,
    );
    expect(worktree.head).toBe(commit.proof.commitSha);
    expect(worktree.status).toBe("");
    expect(
      await countFixtureCommits(
        input.state.codeHandoff.canonicalWorktreeRoot,
        input.fixture.baseSha,
      ),
      "resuming DU-06 must not create a second implementation commit",
    ).toBe(1);
    return createIndependentStageEntryProbe(
      input.stage,
      commit.proofFingerprint,
      [
        input.state.codeHandoff.commitSha,
        input.state.codeHandoff.parentSha,
        ...[...input.state.codeHandoff.changedPaths].sort(),
      ],
      1,
    );
  }
  if (input.stage === "private_github_publication") {
    const repository = await input.githubClient.getRepository(
      input.expectedOwner,
      input.expectedRepository,
    );
    expect(repository.private).toBe(true);
    const pullRequest = await input.githubClient.getPullRequest(
      input.expectedOwner,
      input.expectedRepository,
      commit.proof.pullRequestNumber,
    );
    expect(pullRequest).toMatchObject({
      draft: true,
      state: "open",
      merged: false,
      head: { ref: commit.proof.branch, sha: commit.proof.remoteSha },
    });
    const matchingPullRequests = await input.githubClient.listPullRequestsForHead(
      input.expectedOwner,
      input.expectedRepository,
      commit.proof.branch,
      repository.defaultBranch,
    );
    expect(matchingPullRequests).toHaveLength(1);
    return createIndependentStageEntryProbe(
      input.stage,
      commit.proofFingerprint,
      [
        repository.id,
        commit.proof.branch,
        commit.proof.remoteSha,
        commit.proof.pullRequestNumber,
      ],
      3,
    );
  }
  throw new Error(`Use the dedicated cleanup stage probe for ${input.stage}.`);
}

function createIndependentStageEntryProbe(
  stage: ProjectLifecycleStageName,
  proofFingerprint: string,
  durableIdentities: readonly unknown[],
  providerResourceCardinality: number,
): IndependentStageEntryProbe {
  return {
    version: 1,
    stage,
    proofFingerprint,
    durableResourceFingerprint: contractFingerprint(
      JSON.stringify(durableIdentities),
    ),
    durableCommitOccurrenceCount: 1,
    providerResourceCardinality,
  };
}

async function attestIndependentCleanupStageEntry(input: {
  state: SafeLifecycleState;
  linearClient: LinearReadbackClient;
  linearResources: LinearCleanupResources;
  githubClient: GitHubRestClient;
  expectedOwner: string;
  expectedRepository: string;
}): Promise<IndependentStageEntryProbe> {
  const lineage = requireOne(input.state.lineages, "cleanup stage-entry project lineage");
  const commit = requireOne<any>(
    (Array.isArray(lineage.commits) ? lineage.commits : []).filter(
      (item: any) => item.stage === "reconciliation_cleanup",
    ) as any[],
    "reconciliation cleanup durable stage commit",
  );
  expect(commit?.proofFingerprint).toMatch(SHA256);
  await independentlyVerifyLinearCleanup(
    input.linearClient,
    input.linearResources,
  );
  await expectGitHubRepositoryAbsent(
    input.githubClient,
    input.expectedOwner,
    input.expectedRepository,
  );
  expect(input.state.privateBindings).toHaveLength(0);
  expect(
    input.state.repositoryCleanups.filter((item) => item.status === "verified"),
  ).toHaveLength(1);
  return createIndependentStageEntryProbe(
    "reconciliation_cleanup",
    commit.proofFingerprint,
    [
      commit.proof.cleanupReceiptFingerprints,
      commit.proof.backlinkReceiptFingerprints,
      "linear_absent",
      "github_absent",
    ],
    0,
  );
}

async function countFixtureCommits(
  worktreeRoot: string,
  baseSha: string,
): Promise<number> {
  const output = (
    await execFileAsync(
      "git",
      ["-C", worktreeRoot, "rev-list", "--count", `${baseSha}..HEAD`],
      { windowsHide: true },
    )
  ).stdout.trim();
  const count = Number.parseInt(output, 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("DU-06 could not read the exact disposable commit count.");
  }
  return count;
}

function resourcesFromState(state: SafeLifecycleState): LinearCleanupResources {
  const research = requireOne(
    state.researchPublications.filter((item) => item.status === "complete"),
    "research publication for cleanup",
  );
  const hierarchy = requireOne(
    state.linearHierarchies.filter((item) => item.status === "complete"),
    "Linear hierarchy for cleanup",
  );
  const ids = (kind: string) => hierarchy.items
    .filter((item: any) => item.kind === kind)
    .map((item: any) => String(item.resourceId));
  return {
    publicationIssueIds: [String(research.issueId)],
    hierarchyIssueIds: ids("issue"),
    initiativeProjectLinkIds: ids("initiative_project_link"),
    initiativeId: requireOne(ids("initiative"), "Linear initiative id"),
    projectId: requireOne(ids("project"), "Linear project id"),
  };
}

function resourcesFromStateOrNull(
  state: SafeLifecycleState,
): LinearCleanupResources | null {
  try {
    return resourcesFromState(state);
  } catch {
    return null;
  }
}

function emptyLinearCleanupInventory(): LinearCleanupInventory {
  return {
    publicationIssueIds: [],
    hierarchyIssueIds: [],
    initiativeProjectLinkIds: [],
    initiativeIds: [],
    projectIds: [],
  };
}

function inventoryFromExactLinearResources(
  resources: LinearCleanupResources,
): LinearCleanupInventory {
  return {
    publicationIssueIds: [...resources.publicationIssueIds],
    hierarchyIssueIds: [...resources.hierarchyIssueIds],
    initiativeProjectLinkIds: [...resources.initiativeProjectLinkIds],
    initiativeIds: [resources.initiativeId],
    projectIds: [resources.projectId],
  };
}

function partialLinearCleanupInventoryFromState(
  state: SafeLifecycleState,
): LinearCleanupInventory {
  const publicationIssueIds = state.researchPublications
    .map((publication) => String(publication.issueId ?? "").trim())
    .filter(Boolean);
  const hierarchyItems = state.linearHierarchies.flatMap(
    (hierarchy) => Array.isArray(hierarchy.items) ? hierarchy.items : [],
  );
  const ids = (kind: string) => hierarchyItems
    .filter((item: any) => item.kind === kind)
    .map((item: any) => String(item.resourceId ?? "").trim())
    .filter(Boolean);
  return normalizeLinearCleanupInventory({
    publicationIssueIds,
    hierarchyIssueIds: ids("issue"),
    initiativeProjectLinkIds: ids("initiative_project_link"),
    initiativeIds: ids("initiative"),
    projectIds: ids("project"),
  });
}

function mergeLinearCleanupInventories(
  left: LinearCleanupInventory,
  right: LinearCleanupInventory,
): LinearCleanupInventory {
  return normalizeLinearCleanupInventory({
    publicationIssueIds: [
      ...left.publicationIssueIds,
      ...right.publicationIssueIds,
    ],
    hierarchyIssueIds: [
      ...left.hierarchyIssueIds,
      ...right.hierarchyIssueIds,
    ],
    initiativeProjectLinkIds: [
      ...left.initiativeProjectLinkIds,
      ...right.initiativeProjectLinkIds,
    ],
    initiativeIds: [...left.initiativeIds, ...right.initiativeIds],
    projectIds: [...left.projectIds, ...right.projectIds],
  });
}

function normalizeLinearCleanupInventory(
  inventory: LinearCleanupInventory,
): LinearCleanupInventory {
  const unique = (values: readonly string[]) => [...new Set(
    values.map((value) => value.trim()).filter(Boolean),
  )].sort();
  return {
    publicationIssueIds: unique(inventory.publicationIssueIds),
    hierarchyIssueIds: unique(inventory.hierarchyIssueIds),
    initiativeProjectLinkIds: unique(inventory.initiativeProjectLinkIds),
    initiativeIds: unique(inventory.initiativeIds),
    projectIds: unique(inventory.projectIds),
  };
}

async function independentlyReadLinearResources(
  client: LinearReadbackClient,
  resources: LinearCleanupResources,
): Promise<void> {
  await expectLinearResource(client, "initiatives.get", resources.initiativeId);
  await expectLinearResource(client, "projects.get", resources.projectId);
  for (const id of [...resources.publicationIssueIds, ...resources.hierarchyIssueIds]) {
    await expectLinearResource(client, "issues.get", id);
  }
  for (const id of resources.initiativeProjectLinkIds) {
    await expectLinearResource(client, "initiative_project_links.get", id);
  }
}

async function independentlyVerifyLinearCleanup(
  client: LinearReadbackClient,
  resources: LinearCleanupResources,
): Promise<void> {
  await independentlyVerifyLinearInventoryCleanup(
    client,
    inventoryFromExactLinearResources(resources),
  );
}

async function independentlyVerifyLinearInventoryCleanup(
  client: LinearReadbackClient,
  resources: LinearCleanupInventory,
): Promise<void> {
  for (const id of resources.initiativeProjectLinkIds) {
    await expectLinearRemoved(client, "initiative_project_links.get", id);
  }
  for (const id of [...resources.publicationIssueIds, ...resources.hierarchyIssueIds]) {
    await expectLinearRemoved(client, "issues.get", id);
  }
  for (const id of resources.projectIds) {
    await expectLinearRemoved(client, "projects.get", id);
  }
  for (const id of resources.initiativeIds) {
    await expectLinearRemoved(client, "initiatives.get", id);
  }
}

async function expectLinearResource(
  client: LinearReadbackClient,
  operation: string,
  id: string,
): Promise<void> {
  const record = await client.execute(operation as any, { id }) as any;
  expect(record?.id).toBe(id);
}

async function expectRetainedLinearEvidence(input: {
  client: LinearReadbackClient;
  teamId: string;
  title: string;
  description: string;
}): Promise<{ id: string; identifier: string; url: string }> {
  const page = await input.client.execute("issues.search" as any, {
    query: input.title,
    filter: { team: { id: { eq: input.teamId } } },
    first: 20,
    includeArchived: false,
  }) as any;
  const matches = (Array.isArray(page?.items)
    ? page.items
    : []) as Array<Record<string, any>>;
  const exactMatches = matches.filter(
    (item: any) =>
      item?.title === input.title &&
      item?.team?.id === input.teamId &&
      item?.trashed !== true,
  );
  const match = requireOne(exactMatches, "retained Linear evidence issue");
  const readback = await input.client.execute("issues.get" as any, {
    id: match.id,
  }) as any;
  expect(readback).toMatchObject({
    id: match.id,
    identifier: match.identifier,
    title: input.title,
    description: input.description,
    trashed: false,
    team: { id: input.teamId },
  });
  expect(readback.url).toMatch(/^https:\/\//u);
  return {
    id: String(readback.id),
    identifier: String(readback.identifier),
    url: String(readback.url),
  };
}

async function expectRetainedLinearEvidenceStillPresent(
  client: LinearReadbackClient,
  id: string,
): Promise<void> {
  const readback = await client.execute("issues.get" as any, { id }) as any;
  expect(readback?.id).toBe(id);
  expect(readback?.trashed).not.toBe(true);
  expect(readback?.url).toMatch(/^https:\/\//u);
}

async function expectLinearRemoved(
  client: LinearReadbackClient,
  operation: string,
  id: string,
): Promise<void> {
  try {
    const record = await client.execute(operation as any, { id }) as any;
    expect(
      record?.trashed === true || typeof record?.archivedAt === "string",
      `${operation} ${id} should be trashed, archived, or absent`,
    ).toBe(true);
  } catch (error) {
    if ((error as any)?.code !== "linear_not_found") throw error;
  }
}

async function bestEffortLinearCleanup(
  client: LinearReadbackClient,
  resources: LinearCleanupInventory,
): Promise<{ errors: string[]; independentAbsenceReadback: boolean }> {
  const errors: string[] = [];
  const execute = async (operation: string, id: string) => {
    try {
      await client.execute(operation as any, { id });
    } catch (error) {
      if ((error as any)?.code !== "linear_not_found") {
        errors.push(`${operation} ${id}: ${safeError(error)}`);
      }
    }
  };
  for (const id of resources.initiativeProjectLinkIds) {
    await execute("initiative_project_links.delete", id);
  }
  for (const id of [...resources.publicationIssueIds, ...resources.hierarchyIssueIds]) {
    await execute("issues.trash", id);
  }
  for (const id of resources.projectIds) {
    await execute("projects.trash", id);
  }
  for (const id of resources.initiativeIds) {
    await execute("initiatives.trash", id);
  }
  let independentAbsenceReadback = false;
  try {
    // This readback is deliberately separate from every cleanup mutation so a
    // partially successful fallback cannot be reported as clean by dispatch
    // receipts alone.
    await independentlyVerifyLinearInventoryCleanup(client, resources);
    independentAbsenceReadback = true;
  } catch (error) {
    errors.push(`independent Linear absence readback: ${safeError(error)}`);
  }
  return { errors, independentAbsenceReadback };
}

async function bestEffortGitHubCleanup(input: {
  client: GitHubRestClient;
  owner: string;
  repository: string;
  pullRequestNumber: number | null;
  branch: string | null;
  expectedSha: string | null;
}): Promise<string[]> {
  const errors: string[] = [];
  try {
    const repository = await input.client.getRepository(input.owner, input.repository);
    if (!repository.private) {
      return ["refused fallback cleanup because the exact repository is not private"];
    }
  } catch (error) {
    if (error instanceof GitHubApiError && error.code === "github_not_found") {
      return [];
    }
    return [`repository readback: ${safeError(error)}`];
  }
  if (input.pullRequestNumber) {
    try {
      const pullRequest = await input.client.getPullRequest(
        input.owner,
        input.repository,
        input.pullRequestNumber,
      );
      if (pullRequest.state === "open") {
        await input.client.closePullRequest({
          owner: input.owner,
          repository: input.repository,
          number: input.pullRequestNumber,
        });
      }
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.code === "github_not_found")) {
        errors.push(`pull request cleanup: ${safeError(error)}`);
      }
    }
  }
  if (input.branch && input.expectedSha) {
    try {
      await input.client.deleteAgentBranch({
        owner: input.owner,
        repository: input.repository,
        branch: input.branch,
        expectedSha: input.expectedSha,
      });
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.code === "github_not_found")) {
        errors.push(`branch cleanup: ${safeError(error)}`);
      }
    }
  }
  try {
    await input.client.deleteRepository(input.owner, input.repository);
    await expectGitHubRepositoryAbsent(input.client, input.owner, input.repository);
  } catch (error) {
    errors.push(`repository cleanup: ${safeError(error)}`);
  }
  return errors;
}

async function expectGitHubBranchAbsent(
  client: GitHubRestClient,
  owner: string,
  repository: string,
  branch: string,
): Promise<void> {
  try {
    await client.getReference(owner, repository, branch);
    throw new Error(`GitHub branch ${branch} still exists.`);
  } catch (error) {
    if (error instanceof GitHubApiError && error.code === "github_not_found") return;
    throw error;
  }
}

async function expectGitHubRepositoryAbsent(
  client: GitHubRestClient,
  owner: string,
  repository: string,
): Promise<void> {
  try {
    await client.getRepository(owner, repository);
    throw new Error(`GitHub repository ${owner}/${repository} still exists.`);
  } catch (error) {
    if (error instanceof GitHubApiError && error.code === "github_not_found") return;
    throw error;
  }
}

async function readVaultNote(page: Page, path: string): Promise<string> {
  return page.evaluate(async ({ path }) => {
    const app = (window as typeof window & { app?: any }).app;
    const file = app?.vault?.getFileByPath?.(path);
    if (!file) throw new Error(`Expected lifecycle note is missing: ${path}.`);
    return app.vault.read(file);
  }, { path });
}

async function readRedactedDailyUseCounters(
  page: Page,
): Promise<{ modelCalls: number; toolCalls: number }> {
  return page.evaluate(({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[
      pluginId
    ];
    const snapshot = plugin?.getMissionRunSnapshot?.();
    const modelCalls = Array.isArray(snapshot?.modelCallEvidence)
      ? snapshot.modelCallEvidence.length
      : Number(snapshot?.providerUsage?.modelCallCount ?? 0);
    const toolCalls = Array.isArray(snapshot?.missionEvidence)
      ? snapshot.missionEvidence.length
      : 0;
    return {
      modelCalls: Number.isSafeInteger(modelCalls) && modelCalls >= 0
        ? modelCalls
        : 0,
      toolCalls: Number.isSafeInteger(toolCalls) && toolCalls >= 0
        ? toolCalls
        : 0,
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Protected DU-06 is missing required environment ${name}.`);
  return value;
}

function optionalEnvironment(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function safeDisposableRepositoryName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 90);
  if (
    !/^[a-z0-9][a-z0-9._-]{2,89}$/u.test(normalized) ||
    !/(?:disposable|e2e|sandbox|test)/u.test(normalized) ||
    /(?:^|[-_.])(prod|production)(?:$|[-_.])/u.test(normalized)
  ) {
    throw new Error("The protected repository prefix is not an exact disposable target.");
  }
  return normalized;
}

function contractFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function requireOne<T>(items: readonly T[], label: string): T {
  if (items.length !== 1) {
    throw new Error(`${label} expected exactly one item, received ${items.length}.`);
  }
  return items[0];
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(
      /(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{48,})/giu,
      "[REDACTED]",
    )
    .slice(0, 8_000);
}

function safeArtifactError(
  error: unknown,
  exactRedactions: readonly string[] = [],
): string {
  let value = safeError(error);
  for (const exact of [...new Set(exactRedactions)]
    .filter((entry) => entry.length > 0)
    .sort((left, right) => right.length - left.length)) {
    value = value.replace(
      new RegExp(exact.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu"),
      "[REDACTED_RESOURCE]",
    );
  }
  return value
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\)[^\r\n;]+/gu, "[LOCAL_PATH]")
    .replace(/\/(?:Users|home|tmp|private\/tmp|var\/tmp)\/[^\r\n;]+/gu, "[LOCAL_PATH]")
    .replace(/(?:\.agent-backups|E2E Agent Tests)\/[^\r\n;]+/giu, "[VAULT_PATH]")
    .slice(0, 1_000);
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
    ...(json === undefined ? {} : { json }),
  };
};
