import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";
import {
  createPhase4TypeScriptProjectFixture,
  type Phase4TypeScriptProjectFixture,
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
const PROFILE_KEY = "du06-project";
const VALIDATION_PROFILE_KEY = "du06-node-validation";
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

test("DU-06 exact-SHA compound lifecycle restarts at every stage and independently cleans providers", async ({}, testInfo) => {
  test.setTimeout(120 * 60_000);
  const releaseSha = requiredEnvironment("E2E_RELEASE_COMMIT_SHA");
  const linearToken = requiredEnvironment("E2E_LINEAR_API_KEY");
  const githubToken = requiredEnvironment("E2E_GITHUB_TOKEN");
  const linearTeamId = requiredEnvironment("LINEAR_LIVE_TEST_TEAM_ID");
  const linearProjectId = requiredEnvironment("E2E_RELEASE_LINEAR_PROJECT_ID");
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
  if (process.env.GITHUB_SHA?.trim()) {
    expect(process.env.GITHUB_SHA.trim().toLowerCase()).toBe(releaseSha);
  }

  const githubClient = new GitHubRestClient({
    transport: fetchTransport,
    token: githubToken,
    timeoutMs: 60_000,
  });
  const linearClient = new LinearGraphqlClient({
    transport: fetchTransport,
    apiKey: linearToken,
    timeoutMs: 60_000,
  });
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
  const fixture = await createPhase4TypeScriptProjectFixture(marker);
  const profile = createRepositoryProfile({
    key: PROFILE_KEY,
    displayName: "Protected DU-06 disposable project",
    repositoryRoot: fixture.root,
    defaultBranch: "main",
    allowedPathPrefixes: ["README.md", "src", "test"],
    validationProfile: {
      id: VALIDATION_PROFILE_KEY,
      bootstrapCommands: [],
      validationCommands: [
        { command: "npm", args: ["test"], label: "npm test" },
        { command: "npm", args: ["run", "build"], label: "npm run build" },
      ],
      protectedPaths: ["package.json", "scripts"],
      allowedGeneratedPaths: [],
    },
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
  let pullRequestNumber: number | null = null;
  let publishedBranch: string | null = null;
  let publishedSha: string | null = null;
  let cleanupVerified = false;
  const cleanupErrors: string[] = [];
  const restartedStages: ProjectLifecycleStageName[] = [];
  let approvalCount = 0;
  let modelCallCount = 0;
  let toolCallCount = 0;

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
        orchestratorEnabled: false,
        linearEnabled: true,
        linearDefaultTeamId: linearTeamId,
        linearQueueProjectId: linearProjectId,
        githubEnabled: true,
        repositoryProfileRegistry: createRepositoryProfileRegistry([profile]),
      },
    );
    const connection = await configureProtectedConnections(
      harness.page,
      linearTeamId,
      linearProjectId,
    );
    expect(connection).toMatchObject({
      linearConnected: true,
      linearCredentialSecure: true,
      linearTeamId,
      linearProjectId,
      githubConnected: true,
      githubLogin: githubAccount.login,
    });

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
        config: liveProviderConfiguration("wsl2"),
      },
    );
    expect(sandboxProbe.status).toMatchObject({
      executionAvailable: true,
      selectedProvider: "wsl2",
    });
    expect(Date.parse(String(sandboxProbe.persisted?.observedAt ?? "")))
      .toBeGreaterThanOrEqual(startedAt);
    await harness.installOwnedWebBackend({ sourceCount: 2 });

    const mission = [
      `Use the exact vault destination ${notePath} for the accepted research package.`,
      `Research the product problem marked ${marker} using exactly two public web sources and fetch both sources before accepting findings.`,
      `Publish the accepted research note to Linear in the configured destination. The package is code work for repository key ${PROFILE_KEY} and validation requirement ${VALIDATION_PROFILE_KEY}.`,
      `Turn that accepted research into one Linear initiative, one project, and exactly one implementation issue. Use logical keys du06-initiative-${suffix}, du06-project-${suffix}, and du06-issue-${suffix}; the issue has no dependencies, has explicit acceptance criteria, and uses work-item fingerprint ${issueFingerprint}. Reuse the returned accepted artifact fingerprint and exact source note path.`,
      `Implement the accepted work in the exact trusted repository ${fixture.root}, using durable workspace ${workspaceId} and repair request ${requestId}. Add only src/math.ts, src/index.ts, test/math.test.mjs, and README.md. Export a working add function and marker ${marker}; re-export the API; test both values; document npm test and the marker. Leave package.json and scripts unchanged.`,
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
          const state = await readSafeLifecycleState(harness!.page, PROFILE_KEY);
          const lineage = requireOne(state.lineages, "project lineage after restart");
          const stageIndex = MAIN_STAGES.indexOf(stage);
          expect(lineage.commits.slice(0, stageIndex + 1).map((item: any) => item.stage))
            .toEqual(MAIN_STAGES.slice(0, stageIndex + 1));
          await attestIndependentStageEntry({
            stage,
            state,
            fixture,
            githubClient,
            linearClient,
            expectedOwner: githubAccount.login,
            expectedRepository: repository,
          });
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
    const codeHandoff = state.codeHandoff;
    expect(codeHandoff?.status).toBe("verified");
    expect(codeHandoff?.commitSha).toMatch(FULL_SHA);
    expect(codeHandoff?.parentSha).toBe(fixture.baseSha);
    expect(codeHandoff?.targetedValidationReceiptId).not.toBe(
      codeHandoff?.fullValidationReceiptId,
    );
    expect([...codeHandoff.changedPaths].sort()).toEqual([
      "README.md",
      "src/index.ts",
      "src/math.ts",
      "test/math.test.mjs",
    ]);
    verifiedWorktree = {
      root: codeHandoff.canonicalWorktreeRoot,
      branch: codeHandoff.branch,
    };
    const verifiedCode = await fixture.inspectWorktree(verifiedWorktree.root);
    expect(verifiedCode.head).toBe(codeHandoff.commitSha);
    expect(verifiedCode.status).toBe("");
    expect(verifiedCode.files["src/math.ts"]).toContain(marker);
    expect(verifiedCode.files["README.md"]).toContain(marker);
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
    expect(note).toMatch(/linear\.app/iu);
    expect(note).toMatch(/github\.com/iu);

    linearResources = resourcesFromState(state);
    await independentlyReadLinearResources(linearClient, linearResources);

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
    await expectGitHubBranchAbsent(
      githubClient,
      githubAccount.login,
      repository,
      exactPublishedBranch,
    );

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
    await independentlyVerifyLinearCleanup(linearClient, linearResources);

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
      },
    });
    expect(restartedStages).toEqual(ALL_STAGES);
    await expectGitHubRepositoryAbsent(
      githubClient,
      githubAccount.login,
      repository,
    );
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

    await recordDailyUseAcceptance(
      testInfo,
      "DU-06",
      {
        artifacts: [
          "vault:research_note",
          "linear:initiative",
          "linear:project",
          "linear:issue",
          "git:local_commit",
          "github:private_repository",
          "github:draft_pr",
        ],
        proofs: [
          "graph:authoritative",
          "research:accepted",
          "linear:hierarchy_readback",
          "linear:provider_readback",
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
          "binding:note_commit_pr",
          "binding:linear_commit_pr",
          "binding:project_lineage",
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
  } finally {
    if (harness && !cleanupVerified) {
      try {
        const recovered = await readSafeLifecycleState(harness.page, PROFILE_KEY);
        linearResources ??= resourcesFromStateOrNull(recovered);
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
      if (linearResources) {
        cleanupErrors.push(
          ...(await bestEffortLinearCleanup(linearClient, linearResources)),
        );
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
    if (harness) {
      await clearProtectedConnections(harness.page).catch((error) => {
        cleanupErrors.push(`credential cleanup: ${safeError(error)}`);
      });
    }
    if (verifiedWorktree) {
      await fixture
        .removeOwnedWorktree(verifiedWorktree.root, verifiedWorktree.branch)
        .catch((error) => cleanupErrors.push(`worktree cleanup: ${safeError(error)}`));
    }
    await harness?.close().catch((error) => {
      cleanupErrors.push(`harness cleanup: ${safeError(error)}`);
    });
    await fixture.cleanup().catch((error) => {
      cleanupErrors.push(`fixture cleanup: ${safeError(error)}`);
    });
    if (cleanupErrors.length > 0) {
      throw new Error(`DU-06 cleanup failures: ${cleanupErrors.join("; ")}`);
    }
  }
});

async function configureProtectedConnections(
  page: Page,
  linearTeamId: string,
  linearProjectId: string,
) {
  return page.evaluate(async ({ pluginId, linearTeamId, linearProjectId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
    const environment = (globalThis as any).process?.env ?? {};
    const linearToken = String(environment.E2E_LINEAR_API_KEY ?? "").trim();
    const githubToken = String(environment.E2E_GITHUB_TOKEN ?? "").trim();
    if (!plugin || !linearToken || !githubToken) {
      throw new Error("Protected provider credentials are unavailable in the native runner.");
    }
    const linearSaved = await plugin.setLinearApiKey(linearToken);
    if (!linearSaved?.ok) throw new Error("Linear secure credential setup failed.");
    plugin.settings.linearDefaultTeamId = linearTeamId;
    plugin.settings.linearQueueProjectId = linearProjectId;
    await plugin.saveSettings();
    const linearConnection = await plugin.testLinearConnection();
    if (!linearConnection?.ok) throw new Error("Linear capability discovery failed.");
    const linearCredential = plugin.getLinearCredentialStatus?.();
    if (linearCredential?.configured !== true || linearCredential?.secure !== true) {
      throw new Error("Linear credential did not land in native secure storage.");
    }
    if (
      plugin.settings.linearDefaultTeamId !== linearTeamId ||
      plugin.settings.linearQueueProjectId !== linearProjectId
    ) {
      throw new Error("Linear discovery drifted from the exact disposable destination.");
    }
    const githubSaved = await plugin.setGitHubFineGrainedPat(githubToken);
    if (!githubSaved?.ok) throw new Error("GitHub secure credential setup failed.");
    const github = plugin.getGitHubCredentialStatus?.();
    if (!github?.connected || !github?.account?.login) {
      throw new Error("GitHub verified identity is unavailable.");
    }
    return {
      linearConnected: true,
      linearCredentialSecure: true,
      linearTeamId: plugin.settings.linearDefaultTeamId,
      linearProjectId: plugin.settings.linearQueueProjectId,
      githubConnected: true,
      githubLogin: github.account.login,
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, linearTeamId, linearProjectId });
}

async function clearProtectedConnections(page: Page): Promise<void> {
  const result = await page.evaluate(async ({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
    if (!plugin) return { linear: true, github: true };
    const linear = await plugin.clearLinearApiKey();
    const github = await plugin.disconnectGitHub();
    return { linear: linear?.ok === true, github: github?.ok === true };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
  if (!result.linear || !result.github) {
    throw new Error("Native secure-store credential cleanup was not verified.");
  }
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

async function attestIndependentStageEntry(input: {
  stage: ProjectLifecycleStageName;
  state: SafeLifecycleState;
  fixture: Phase4TypeScriptProjectFixture;
  githubClient: GitHubRestClient;
  linearClient: LinearGraphqlClient;
  expectedOwner: string;
  expectedRepository: string;
}): Promise<void> {
  const lineage = requireOne(input.state.lineages, "stage-entry project lineage");
  const commit = lineage.commits.find((item: any) => item.stage === input.stage);
  expect(commit?.proofFingerprint).toMatch(SHA256);
  if (input.stage === "accepted_research") {
    expect(commit.proof.notePath).toMatch(/\.md$/u);
    expect(commit.proof.noteSha256).toMatch(SHA256);
    return;
  }
  if (input.stage === "linear_hierarchy") {
    await expectLinearResource(input.linearClient, "initiatives.get", commit.proof.initiativeId);
    await expectLinearResource(input.linearClient, "projects.get", commit.proof.projectId);
    for (const issueId of commit.proof.issueIds) {
      await expectLinearResource(input.linearClient, "issues.get", issueId);
    }
    return;
  }
  if (input.stage === "code_execution") {
    expect(input.state.codeHandoff?.status).toBe("verified");
    expect(input.state.codeHandoff?.commitSha).toBe(commit.proof.commitSha);
    const worktree = await input.fixture.inspectWorktree(
      input.state.codeHandoff.canonicalWorktreeRoot,
    );
    expect(worktree.head).toBe(commit.proof.commitSha);
    expect(worktree.status).toBe("");
    return;
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
  }
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

async function independentlyReadLinearResources(
  client: LinearGraphqlClient,
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
  client: LinearGraphqlClient,
  resources: LinearCleanupResources,
): Promise<void> {
  for (const id of resources.initiativeProjectLinkIds) {
    await expectLinearRemoved(client, "initiative_project_links.get", id);
  }
  for (const id of [...resources.publicationIssueIds, ...resources.hierarchyIssueIds]) {
    await expectLinearRemoved(client, "issues.get", id);
  }
  await expectLinearRemoved(client, "projects.get", resources.projectId);
  await expectLinearRemoved(client, "initiatives.get", resources.initiativeId);
}

async function expectLinearResource(
  client: LinearGraphqlClient,
  operation: string,
  id: string,
): Promise<void> {
  const record = await client.execute(operation as any, { id }) as any;
  expect(record?.id).toBe(id);
}

async function expectLinearRemoved(
  client: LinearGraphqlClient,
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
  client: LinearGraphqlClient,
  resources: LinearCleanupResources,
): Promise<string[]> {
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
  await execute("projects.trash", resources.projectId);
  await execute("initiatives.trash", resources.initiativeId);
  return errors;
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

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Protected DU-06 is missing required environment ${name}.`);
  return value;
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
  return String(error instanceof Error ? error.message : error).slice(0, 500);
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
