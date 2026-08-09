import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import {
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories/RepositoryProfile";
import {
  GitHubApiError,
  GitHubRestClient,
} from "../src/integrations/github/GitHubRestClient";
import type { HttpTransport } from "../src/model/types";
import { PHASE4_CODE_PLUGIN_ID } from "./fixtures/phase4Harness";
import { createPhase4TypeScriptProjectFixture } from "./fixtures/phase4GitRepo";
import {
  NATIVE_CORE_PLUGIN_ID,
} from "./fixtures/nativeObsidianHarness";
import {
  assertProductionAdoptedSandboxV1,
  hostProvisionedSandboxRuntimeDigestV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";
import { laneSelectedV1 } from "./fixtures/laneSelection";

const PROFILE_KEY = "obs-hello-github-ts";
const VALIDATION_PROFILE_KEY = "obs-hello-github-ts-validation";

/**
 * Drive the Obsidian Agentic Researcher UI in two long-running missions:
 * 1) author + validate + commit a tiny TypeScript app (DU-03 shape)
 * 2) create the exact private GitHub repository and open a draft PR
 *
 * Requires vault/plugin secrets for Ollama + GitHub (or E2E_* overrides).
 */
test("OBS-HELLO Obsidian prompt creates TypeScript app and private GitHub draft PR", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  // This lane creates a real private repository and a draft PR, and retains
  // both unless OBS_HELLO_CLEANUP=1. Without a lane guard it ran in any
  // multi-project selection.
  test.skip(
    !laneSelectedV1("obsidian-hello-github-live"),
    "Run only with E2E_PLAYWRIGHT_LANE=obsidian-hello-github-live.",
  );
  test.skip(
    process.env.E2E_AI_MODE !== "real" || process.env.E2E_REAL_AI !== "1",
    "Set E2E_REAL_AI=1 and E2E_AI_MODE=real to run through the live Obsidian plugin.",
  );
  test.setTimeout(90 * 60_000);

  const githubToken = requiredEnvironment("E2E_GITHUB_TOKEN");
  const githubClient = new GitHubRestClient({
    transport: fetchTransport,
    token: githubToken,
    timeoutMs: 60_000,
  });
  const githubAccount = await githubClient.getAuthenticatedUser();
  const suffix = randomUUID().replace(/-/gu, "").slice(0, 12);
  const repository = safeDisposableRepositoryName(
    `disposable-obs-hello-${suffix}`,
  );
  const marker = `OBS_HELLO_${suffix}`;
  const workspaceId = `obs-hello-${suffix}`;
  const requestId = `obs-hello-request-${suffix}`;
  const fixture = await createPhase4TypeScriptProjectFixture(marker);
  const profile = createRepositoryProfile({
    key: PROFILE_KEY,
    displayName: "Obsidian hello TypeScript GitHub project",
    repositoryRoot: fixture.root,
    defaultBranch: "main",
    allowedPathPrefixes: ["README.md", "src", "test"],
    validationProfile: {
      id: VALIDATION_PROFILE_KEY,
      bootstrapCommands: [],
      validationCommands: [
        {
          command: "node",
          args: ["scripts/verify-project.mjs"],
          label: "Protected TypeScript contract verification",
        },
        {
          command: "npm",
          args: ["test"],
          label: "Protected TypeScript npm test",
        },
      ],
      protectedPaths: ["scripts", "package.json"],
      allowedGeneratedPaths: [],
    },
    runtimeDigests: { node: hostProvisionedSandboxRuntimeDigestV1() },
    promotionPolicy: {
      localBasePromotion: "disabled",
      completionProof: "draft_pr",
      githubRepository: `${githubAccount.login}/${repository}`,
      requiredChecks: [],
    },
  });

  let harness: RealAiHarness | null = null;
  let githubOwned = false;
  let repositoryCreated = false;
  let pullRequestNumber: number | null = null;
  let missionError: unknown = null;

  try {
    harness = await startRealAiHarness(
      `obs-hello-github-${suffix}`,
      {
        missionTimeoutMs: 45 * 60_000,
        completionTimeoutMs: 45 * 60_000,
      },
      {
        maxAgentSteps: 100,
        maxRunMinutes: 45,
        completionDrivenLoops: true,
        thinkingMode: "medium",
        orchestratorEnabled: false,
        githubEnabled: true,
        repositoryProfileRegistry: createRepositoryProfileRegistry([profile]),
      },
      {
        preserveConfiguredGitHubCredential: true,
      },
    );

    githubOwned = await ensureGitHubConnected(harness.page, githubToken);
    const startedAt = Date.now();
    // No injected provider configuration: the plugin must adopt the
    // host-provisioned binding and pass its own boundary probe.
    const adoptedSandbox = await assertProductionAdoptedSandboxV1(
      harness.page,
      startedAt,
    );
    expect(adoptedSandbox.selectedProvider).toBe("wsl2");
    await expectTrustedRepositoryProfile(harness.page, PROFILE_KEY, fixture.root);

    // Phase 1: code only (mirrors protected DU-03). Avoid research-trigger
    // wording such as "long-running" — that arms the gather-phase web gate.
    const codeMission = [
      `Implement a complete TypeScript math package in the exact trusted local repository ${fixture.root}.`,
      `Create repository workspace ${workspaceId} and use one repair request id ${requestId} for every validation and commit call.`,
      "First read the exact protected package.json, scripts/import-simple-typescript.mjs, and scripts/verify-project.mjs contracts.",
      "Create exactly src/math.ts, src/index.ts, test/math.test.mjs, and README.md; do not change package.json, either protected script, workflows, hooks, or any other path.",
      `src/math.ts must export a working add(left, right) function and an exported marker equal to ${marker}. src/index.ts must re-export the public API from ./math.js, ./math.ts, or the extensionless ./math specifier.`,
      `The dependency-free Node 18 test must import node:test, node:assert/strict, and importSimpleTypeScript from ../scripts/import-simple-typescript.mjs; call that loader exactly as importSimpleTypeScript("src/math.ts") because it resolves from the repository working directory, test the add behavior, and verify marker ${marker}. Do not use Jest or any third-party package. README.md must document npm test and include ${marker}.`,
      `The package is code work for repository key ${PROFILE_KEY} and validation requirement ${VALIDATION_PROFILE_KEY}.`,
      "Required tools in order: code_sandbox_status, code_workspace_create, code_workspace_create_file, code_validate_fast, code_repair_record_cycle, code_validate_targeted, code_validate_full, code_commit_verified.",
      "Detect the repository profile, read back every created file, run targeted validation, then run a distinct fresh full validation, create one local commit with message feat: add protected TypeScript math package, and independently read the exact commit SHA back.",
      "Use the visible exact approval surface whenever required. Stop only after a verified_code_publication_handoff proves the four changed paths, targeted and fresh-full validation, clean worktree, and commit readback.",
    ].join(" ");

    await harness.submitMission(codeMission, {
      waitForCompletion: false,
      timeoutMs: 45 * 60_000,
    });
    await harness.approveUntilMissionComplete(45 * 60_000, {
      maxContinuations: 8,
    });
    await harness.attestProductionRun({ requireStructuredRouting: true });

    const handoff = await harness.page.evaluate(
      async ({ codePluginId, profileKey }) => {
        const app = (window as typeof window & { app?: any }).app;
        const code = app?.plugins?.plugins?.["agentic-researcher"]
          ?.getBundledCapability?.(codePluginId);
        return code?.resolveVerifiedCodePublicationHandoff?.(profileKey) ?? null;
      },
      { codePluginId: PHASE4_CODE_PLUGIN_ID, profileKey: PROFILE_KEY },
    );
    expect(handoff?.status, "phase-1 code handoff").toBe("verified");
    expect(handoff?.workspaceId).toBe(workspaceId);
    expect(handoff?.commitSha).toMatch(/^[a-f0-9]{40}$/u);

    // Phase 2: publish only — private repo + draft PR from the verified handoff.
    const publishMission = [
      `Using trusted repository key ${PROFILE_KEY}, create the exact host-bound private GitHub repository ${githubAccount.login}/${repository}.`,
      "Call github_create_repository with visibility private, then publish_verified_code_to_github for the existing verified_code_publication_handoff.",
      "Publish the verified commit to its agent-owned branch and open one draft pull request.",
      "Do not merge. Do not clean up or delete any provider resource.",
      "Use the visible exact approval surface whenever required.",
    ].join(" ");

    await harness.submitMission(publishMission, {
      waitForCompletion: false,
      timeoutMs: 30 * 60_000,
    });
    await harness.approveUntilMissionComplete(30 * 60_000, {
      maxContinuations: 6,
    });
    await harness.attestProductionRun({ requireStructuredRouting: true });

    const remote = await githubClient.getRepository(
      githubAccount.login,
      repository,
    );
    repositoryCreated = true;
    expect(remote.private).toBe(true);
    expect(remote.htmlUrl).toMatch(
      new RegExp(`${githubAccount.login}/${repository}`, "iu"),
    );

    const openPulls = await listOpenPullRequests(
      githubToken,
      githubAccount.login,
      repository,
    );
    expect(openPulls.length).toBeGreaterThanOrEqual(1);
    const draft = openPulls.find((item) => item.draft) ?? openPulls[0]!;
    pullRequestNumber = draft.number;
    expect(draft.html_url).toContain("/pull/");
    expect(draft.head.ref).toMatch(/^codex\//u);

    const providerPullRequest = await githubClient.getPullRequest(
      githubAccount.login,
      repository,
      draft.number,
    );
    expect(providerPullRequest).toMatchObject({
      draft: true,
      state: "open",
      merged: false,
      head: { ref: draft.head.ref },
    });

    test.info().annotations.push({
      type: "obsidian-hello-github",
      description: [
        `repository=${remote.htmlUrl}`,
        `pullRequest=${providerPullRequest.htmlUrl}`,
        `marker=${marker}`,
      ].join(" "),
    });
    console.log(
      `OBS-HELLO success repository=${remote.htmlUrl} pullRequest=${providerPullRequest.htmlUrl}`,
    );

    if (process.env.OBS_HELLO_CLEANUP === "1") {
      await githubClient.closePullRequest({
        owner: githubAccount.login,
        repository,
        number: draft.number,
      }).catch(() => undefined);
      await githubClient.deleteRepository(githubAccount.login, repository);
      repositoryCreated = false;
      pullRequestNumber = null;
    }
  } catch (error) {
    missionError = error;
    throw error;
  } finally {
    const shouldCleanup =
      process.env.OBS_HELLO_CLEANUP === "1" ||
      (missionError !== null && repositoryCreated);
    if (shouldCleanup && (repositoryCreated || pullRequestNumber !== null)) {
      try {
        if (pullRequestNumber !== null) {
          await githubClient.closePullRequest({
            owner: githubAccount.login,
            repository,
            number: pullRequestNumber,
          }).catch(() => undefined);
        }
        await githubClient.deleteRepository(githubAccount.login, repository);
      } catch (cleanupError) {
        if (!(cleanupError instanceof GitHubApiError && cleanupError.code === "github_not_found")) {
          console.error("OBS-HELLO cleanup failed:", cleanupError);
        }
      }
    }
    if (harness && githubOwned) {
      await harness.page.evaluate(async ({ pluginId }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        await plugin?.disconnectGitHub?.();
      }, { pluginId: NATIVE_CORE_PLUGIN_ID }).catch(() => undefined);
    }
    await harness?.close().catch(() => undefined);
    await fixture.cleanup().catch(() => undefined);
  }
});

async function ensureGitHubConnected(page: Page, githubToken: string): Promise<boolean> {
  return page.evaluate(async ({ pluginId, githubToken }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
    if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
    let github = plugin.getGitHubCredentialStatus?.();
    let owned = false;
    if (github?.connected !== true) {
      const saved = await plugin.setGitHubFineGrainedPat(githubToken);
      if (!saved?.ok) {
        throw new Error(
          `GitHub secure credential setup failed: ${String(saved?.message ?? "unknown").slice(0, 400)}`,
        );
      }
      owned = true;
      github = plugin.getGitHubCredentialStatus?.();
    }
    if (!github?.connected) {
      throw new Error("GitHub verified identity is unavailable in Obsidian.");
    }
    return owned;
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, githubToken });
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
  expect(observed).toEqual({ key: profileKey, repositoryRoot });
}

async function listOpenPullRequests(
  token: string,
  owner: string,
  repository: string,
): Promise<Array<{
  number: number;
  draft: boolean;
  html_url: string;
  head: { ref: string };
}>> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repository}/pulls?state=open&per_page=10`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub pull list failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("GitHub pull list returned a non-array payload.");
  }
  return payload.map((item) => ({
    number: Number(item?.number),
    draft: item?.draft === true,
    html_url: String(item?.html_url ?? ""),
    head: { ref: String(item?.head?.ref ?? "") },
  }));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`OBS-HELLO requires ${name}.`);
  return value;
}

function safeDisposableRepositoryName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
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
