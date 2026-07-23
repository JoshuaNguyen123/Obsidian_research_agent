import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories/RepositoryProfile";
import {
  GitHubApiError,
  GitHubRestClient,
} from "../src/integrations/github/GitHubRestClient";
import type { HttpTransport } from "../src/model/types";
import { liveProviderConfiguration } from "../scripts/ci-sandbox-boundary";
import {
  deleteDisposableGitHubRepositoryAndVerify,
  DisposableExternalCleanupManifest,
  preflightGhRepositoryDeleteAuthority,
  safeExternalCleanupError,
} from "./fixtures/externalCleanup";
import { PHASE4_CODE_PLUGIN_ID } from "./fixtures/phase4Harness";
import { createNumberGuessJavaScriptFixture } from "./fixtures/phase4GitRepo";
import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";

const LANE = "compound-flow-smoke-live";
const PROFILE_KEY = "number-guess-live-js";
const VALIDATION_PROFILE_KEY = "number-guess-live-js-validation";
const AGENT_GIT_NAME = "Agentic Researcher";
const AGENT_GIT_EMAIL = "agentic-researcher@example.invalid";
const execFileAsync = promisify(execFile);

/**
 * Short live proof of Obsidian → Linear → Code → GitHub → Obsidian reflection
 * through production plugin tools (no long DU-06 restart matrix / model loop).
 * This variant creates a literal Linear Project, writes and behaviorally tests
 * a number-guess game, pushes its neutral-identity commit, and proves cleanup.
 */
test("NUMBER-GUESS-LIVE creates a real Linear project and GitHub repository", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(
    process.env.E2E_PLAYWRIGHT_LANE !== LANE,
    `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`,
  );
  test.setTimeout(15 * 60_000);

  const envGithubToken = process.env.E2E_GITHUB_TOKEN?.trim() ?? "";
  if (
    envGithubToken &&
    !/^github_pat_[A-Za-z0-9_-]{20,500}$/u.test(envGithubToken)
  ) {
    throw new Error(
      "E2E_GITHUB_TOKEN must be a fine-grained github_pat_ token with Administration:write (repo create), or unset to use the vault lease.",
    );
  }
  const suffix = randomUUID().replace(/-/gu, "").slice(0, 12);
  const marker = `NUMBER_GUESS_${suffix}`;
  const notePath = `E2E Agent Tests/NUMBER-GUESS-${suffix}.md`;
  const repository = safeDisposableRepositoryName(
    `e2e-number-guess-${suffix}`,
  );
  const workspaceId = `number-guess-${suffix}`;
  const requestedProjectId = randomUUID();
  const requestedIssueId = randomUUID();
  const cleanupManifest = new DisposableExternalCleanupManifest();
  const teamId =
    process.env.LINEAR_LIVE_TEST_TEAM_ID?.trim() ||
    "a96c6434-79c1-405f-87dc-c9ee9e1fcdc5";
  const sandboxConfiguration = liveProviderConfiguration("wsl2");
  const fixture = await createNumberGuessJavaScriptFixture(marker);
  const gameSource = createNumberGuessSource(marker);
  const gameTestSource = createNumberGuessTestSource(marker);
  const gameReadme = createNumberGuessReadme(marker);

  let harness: NativeObsidianHarness | null = null;
  let projectId: string | null = requestedProjectId;
  let issueId: string | null = requestedIssueId;
  let workspaceRoot: string | null = null;
  let workspaceBranch: string | null = null;
  let primaryError: unknown = null;
  let githubClient: GitHubRestClient | null = null;
  let githubLogin: string | null = null;
  let githubToken: string | null = envGithubToken || null;
  const cleanupErrors: string[] = [];

  try {
    if (envGithubToken) {
      githubClient = new GitHubRestClient({
        transport: fetchTransport,
        token: envGithubToken,
        timeoutMs: 60_000,
      });
      githubLogin = (await githubClient.getAuthenticatedUser()).login;
    }

    const profile = createRepositoryProfile({
      key: PROFILE_KEY,
      displayName: "Number guess live JavaScript project",
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
            label: "Protected number-guess behavior verification",
          },
        ],
        protectedPaths: ["scripts", "package.json"],
        allowedGeneratedPaths: [],
      },
      runtimeDigests: { node: sandboxConfiguration.runtimeDigest },
      promotionPolicy: {
        localBasePromotion: "disabled",
        completionProof: "draft_pr",
        githubRepository: githubLogin
          ? `${githubLogin}/${repository}`
          : `pending/${repository}`,
        requiredChecks: [],
      },
    });

    harness = await startNativeObsidianHarness({
      label: `compound-flow-smoke-${suffix}`,
      preserveConfiguredLinearCredential: true,
      preserveConfiguredGitHubCredential: true,
      corePluginDataOverrides: {
        githubEnabled: true,
        linearEnabled: true,
        linearDefaultTeamId: teamId,
        repositoryProfileRegistry: createRepositoryProfileRegistry([profile]),
      },
      setup: async ({ page }) => {
        await page.evaluate(async (pluginId) => {
          const app = (window as typeof window & { app?: any }).app;
          if (typeof app?.workspace?.onLayoutReady === "function") {
            await new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve));
          }
          if (!app?.plugins?.plugins?.[pluginId]) {
            await app.plugins.enablePlugin(pluginId);
          }
        }, NATIVE_CORE_PLUGIN_ID);
        await page.waitForFunction(
          (pluginId) =>
            (window as typeof window & { app?: any }).app?.plugins?.plugins?.[
              pluginId
            ]?.agenticResearcherApi?.state === "ready",
          NATIVE_CORE_PLUGIN_ID,
          { timeout: 30_000 },
        );
      },
    });

    await ensureGitHubConnected(harness.page, envGithubToken || null);
    const vaultGithub = await readGitHubIdentity(harness.page);
    githubLogin = vaultGithub.login;
    githubToken = vaultGithub.token;
    if (!githubClient && vaultGithub.token) {
      githubClient = new GitHubRestClient({
        transport: fetchTransport,
        token: vaultGithub.token,
        timeoutMs: 60_000,
      });
    }
    if (!githubClient || !githubLogin) {
      throw new Error(
        "GitHub must be ready via E2E_GITHUB_TOKEN (github_pat_…) or a vault fine-grained PAT with Administration:write.",
      );
    }
    const githubAccount = { login: githubLogin };
    // Register-at-create: bind suffix-scoped cleanup before any provider mutation
    // so mid-run failures still vanish automatically.
    cleanupManifest.registerAtCreate("Linear cleanup", async () => {
      const linearCleanup = await cleanupLinearNumberGuessResources(
        harness!.page, issueId, projectId,
      );
      if (!linearCleanup.issueAbsent || !linearCleanup.projectAbsent) {
        throw new Error(`absence readback failed: ${JSON.stringify(linearCleanup)}`);
      }
      issueId = null;
      projectId = null;
    });
    cleanupManifest.registerAtCreate("Workspace cleanup", async () => {
      if (!workspaceRoot || !workspaceBranch) {
        const recovered = await resolveWorkspaceCleanupBinding(harness!.page, workspaceId);
        workspaceRoot = recovered?.workspaceRoot ?? workspaceRoot;
        workspaceBranch = recovered?.workspaceBranch ?? workspaceBranch;
      }
      if (!workspaceRoot && !workspaceBranch) return;
      if (!workspaceRoot || !workspaceBranch) throw new Error("owned workspace binding was incomplete.");
      await fixture.removeOwnedWorktree(workspaceRoot, workspaceBranch);
      workspaceRoot = null;
      workspaceBranch = null;
    });
    cleanupManifest.registerAtCreate("GitHub cleanup", async () => {
      await deleteDisposableGitHubRepositoryAndVerify({
        client: githubClient!, owner: githubAccount.login, repository,
      });
    });
    await seedAndActivateNote(harness.page, notePath, [
      `# Number guess delivery ${marker}`,
      "",
      "Mission tracking note for Obsidian → Linear → Code → GitHub → reflection.",
      "",
    ].join("\n"));

    const sandboxProbe = await harness.page.evaluate(
      async ({ codePluginId, config }) => {
        const app = (window as typeof window & { app?: any }).app;
        const code = app?.plugins?.plugins?.["agentic-researcher"]
          ?.getBundledCapability?.(codePluginId);
        if (!code?.configureSandboxProvider || !code?.probeConfiguredSandboxProviders) {
          throw new Error("Code sandbox configuration API is unavailable.");
        }
        await code.configureSandboxProvider(config);
        return code.probeConfiguredSandboxProviders();
      },
      { codePluginId: PHASE4_CODE_PLUGIN_ID, config: sandboxConfiguration },
    );
    expect(sandboxProbe).toMatchObject({
      executionAvailable: true,
      selectedProvider: "wsl2",
    });

    const proof = await harness.page.evaluate(
      async ({
        pluginId,
        teamId,
        marker,
        notePath,
        workspaceId,
        repositoryRoot,
        profileKey,
        ownerLogin,
        requestedProjectId,
        requestedIssueId,
        gameSource,
        gameTestSource,
        gameReadme,
      }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        if (!plugin) throw new Error("Agentic Researcher is unavailable.");

        const linearConnection = await plugin.testLinearConnection();
        if (!linearConnection?.ok) {
          throw new Error(
            `Linear connection failed: ${String(linearConnection?.message ?? "unknown").slice(0, 400)}`,
          );
        }
        const oauth = plugin.getLinearOAuthStatus?.();
        const credential = plugin.getLinearCredentialStatus?.();
        if (
          oauth?.connected !== true &&
          (credential?.configured !== true || credential?.secure !== true)
        ) {
          throw new Error("Linear credential is not available in secure storage.");
        }

        const registry = plugin.createToolRegistry?.();
        if (!registry?.prepare || !registry?.executePrepared) {
          throw new Error("Prepared-action registry is unavailable.");
        }
        const definitions = new Set(
          (registry.getDefinitions?.() ?? []).map(
            (definition: any) => String(definition?.function?.name ?? ""),
          ),
        );
        for (const requiredTool of [
          "linear_create_project",
          "linear_get_project",
          "linear_trash_project",
          "linear_create_issue",
          "linear_get_issue",
          "linear_trash_issue",
          "code_workspace_create",
          "code_workspace_create_file",
          "code_workspace_read",
        ]) {
          if (!definitions.has(requiredTool)) {
            throw new Error(`Required production tool is unavailable: ${requiredTool}.`);
          }
        }

        const runId = `number-guess-live-${marker}`;
        let operationSequence = 0;
        const missionPrompt = [
          `Create the disposable Linear project and linked issue for number guess game ${marker}.`,
          `Implement the dependency-free game in repository workspace ${workspaceId} at the exact trusted local path ${repositoryRoot}.`,
          "The game must return low, high, correct, and invalid feedback and include runnable tests plus a README.",
        ].join(" ");
        const contextFor = (toolName: string) => ({
          ...plugin.createToolExecutionContext(missionPrompt),
          runId,
          operationId: `${toolName}-${++operationSequence}-${marker}`,
          deadlineAt: Date.now() + 90_000,
        });

        const executeMutation = async (
          name: string,
          args: Record<string, unknown>,
          grantId: string,
        ) => {
          const context = contextFor(name);
          const prepared = await registry.prepare(
            { id: context.operationId, name, arguments: args },
            context,
          );
          if (!prepared?.ok) {
            throw new Error(
              `${name} prepare failed: ${String(prepared?.error?.code ?? "unknown")}: ${String(prepared?.error?.message ?? "").slice(0, 300)}`,
            );
          }
          const action = prepared.action;
          const authorization = {
            preparedActionId: action.id,
            payloadFingerprint: action.payloadFingerprint,
            grantId,
          };
          const executed = await registry.executePrepared(
            action,
            { ...context, authorizedAction: authorization },
            authorization,
          );
          if (!executed?.ok) {
            throw new Error(
              `${name} execute failed: ${String(executed?.error?.code ?? "unknown")}: ${String(executed?.error?.message ?? "").slice(0, 400)}`,
            );
          }
          return executed;
        };

        const executeRead = async (
          name: string,
          args: Record<string, unknown>,
        ) => {
          const context = contextFor(name);
          const result = await registry.execute(
            { id: context.operationId, name, arguments: args },
            context,
          );
          if (!result?.ok) {
            throw new Error(
              `${name} failed: ${String(result?.error?.code ?? "unknown")}: ${String(result?.error?.message ?? "").slice(0, 400)}`,
            );
          }
          return result.output;
        };

        // 1) A literal Linear Project plus one implementation issue.
        const projectName = `Disposable number guess ${marker}`;
        const createdProject = await executeMutation(
          "linear_create_project",
          {
            input: {
              id: requestedProjectId,
              name: projectName,
              description: "Disposable number-guess game delivery proof.",
              content: [
                `Run marker: ${marker}`,
                `Source note: ${notePath}`,
                "Scope: dependency-free number guessing game with behavioral tests.",
              ].join("\n\n"),
              teamIds: [teamId],
            },
          },
          `number-guess-project-${marker}`,
        );
        const projectId = String(
          createdProject.receipt?.resource?.id ?? requestedProjectId,
        ).trim();
        const project = (await executeRead("linear_get_project", {
          id: projectId,
        })) as any;
        if (
          String(project?.id ?? "") !== projectId ||
          String(project?.name ?? project?.attributes?.name ?? "") !== projectName
        ) {
          throw new Error("Independent Linear project readback did not match creation.");
        }

        const issueTitle = `Build and test number guess ${marker}`;
        const createdIssue = await executeMutation(
          "linear_create_issue",
          {
            id: requestedIssueId,
            title: issueTitle,
            description: [
              "## Assignment",
              "Build a dependency-free number guessing game for integers 1 through 100.",
              "",
              "## Acceptance criteria",
              "- Lower guesses return low.",
              "- Higher guesses return high.",
              "- An exact guess returns correct.",
              "- Out-of-range and non-integer guesses return invalid.",
              "- Automated tests pass before GitHub publication.",
              "",
              `## Source note\n${notePath}`,
              `## Run marker\n${marker}`,
            ].join("\n"),
            teamId,
            projectId,
          },
          `number-guess-issue-${marker}`,
        );
        const issueId = String(
          createdIssue.receipt?.resource?.id ?? requestedIssueId,
        ).trim();
        if (!issueId) throw new Error("Linear create did not return an issue id.");
        const issue = (await executeRead("linear_get_issue", {
          id: issueId,
        })) as any;
        const issueUrl = String(issue?.url ?? issue?.attributes?.url ?? "").trim();
        if (!issueUrl) throw new Error("Linear issue URL missing after create.");

        // 2) Native code workspace writes. Host-side behavioral validation and
        // neutral-identity commit run immediately after this page transaction.
        const createdWorkspace = await executeMutation(
          "code_workspace_create",
          {
            workspaceId,
            kind: "repository",
            repositoryProfileKey: profileKey,
            repositoryRoot,
          },
          `number-guess-workspace-${marker}`,
        );
        const pathsAndContent = [
          ["src/number_guess.js", gameSource],
          ["test/number_guess.test.mjs", gameTestSource],
          ["README.md", gameReadme],
        ] as const;
        for (const [relativePath, content] of pathsAndContent) {
          await executeMutation(
            "code_workspace_create_file",
            { workspaceId, path: relativePath, content },
            `number-guess-file-${relativePath}-${marker}`,
          );
          const fileRead = (await executeRead("code_workspace_read", {
            workspaceId,
            path: relativePath,
          })) as any;
          const fileText = String(
            fileRead?.content ?? fileRead?.text ?? fileRead?.body ?? JSON.stringify(fileRead),
          );
          if (!fileText.includes(marker)) {
            throw new Error(`Code workspace readback missing marker: ${relativePath}.`);
          }
        }

        const workspaceManifest = createdWorkspace.output as any;
        const workspaceRoot = String(
          workspaceManifest?.canonicalRoot ?? workspaceManifest?.rootDir ?? "",
        ).trim();
        const workspaceBranch = String(
          workspaceManifest?.repositoryBinding?.branch ?? workspaceManifest?.branch ?? "",
        ).trim();
        if (!workspaceRoot || !workspaceBranch.startsWith("codex/workspace-")) {
          throw new Error("Repository workspace did not return its canonical root and owned branch.");
        }

        // Prove the vault GitHub credential leases (identity only). Repository
        // create uses the Node-side E2E token because fine-grained PATs often
        // lack Administration:write for user-repo creation.
        const githubIdentity = await plugin.withGitHubCredentialToken(
          (_token: string, account: { id: number; login: string }) => ({
            id: account.id,
            login: account.login,
          }),
        );
        if (
          !githubIdentity?.login ||
          githubIdentity.login.toLowerCase() !== String(ownerLogin).toLowerCase()
        ) {
          throw new Error(
            `GitHub plugin identity mismatch: got ${String(githubIdentity?.login ?? "")}`,
          );
        }

        return {
          projectId,
          projectName,
          projectUrl: String(project?.url ?? project?.attributes?.url ?? ""),
          issueId,
          issueUrl,
          issueTitle: String(issue?.title ?? issueTitle),
          workspaceId,
          workspaceRoot,
          workspaceBranch,
          relativePath: "src/number_guess.js",
          githubLogin: githubIdentity.login,
          notePath,
        };
      },
      {
        pluginId: NATIVE_CORE_PLUGIN_ID,
        teamId,
        marker,
        notePath,
        workspaceId,
        repositoryRoot: fixture.root,
        profileKey: PROFILE_KEY,
        ownerLogin: githubAccount.login,
        requestedProjectId,
        requestedIssueId,
        gameSource,
        gameTestSource,
        gameReadme,
      },
    );

    projectId = proof.projectId;
    issueId = proof.issueId;
    workspaceRoot = proof.workspaceRoot;
    workspaceBranch = proof.workspaceBranch;
    expect(proof.projectId).toBe(requestedProjectId);
    expect(proof.issueUrl).toMatch(/^https:\/\/linear\.app\//iu);
    expect(proof.workspaceId).toBe(workspaceId);
    expect(proof.githubLogin.toLowerCase()).toBe(githubAccount.login.toLowerCase());

    await runNumberGuessValidation(proof.workspaceRoot);
    const localCommitSha = await commitNumberGuessWorkspace(
      proof.workspaceRoot,
      `Build tested number guess game ${marker}`,
    );

    await preflightGhRepositoryDeleteAuthority();
    await assertDisposableRepositoryAbsent(
      githubClient,
      githubAccount.login,
      repository,
    );
    const createdRepo = await createDisposablePrivateRepository({
      client: githubClient,
      owner: githubAccount.login,
      repository,
      description: `Disposable tested number guess game ${marker}`,
    });
    expect(createdRepo.private).toBe(true);
    const githubHtmlUrl = String(createdRepo.htmlUrl ?? "");
    expect(githubHtmlUrl).toMatch(
      new RegExp(`${githubAccount.login}/${repository}`, "iu"),
    );

    const remoteCommitSha = await pushWorkspaceAndReadBack({
      workspaceRoot: proof.workspaceRoot,
      owner: githubAccount.login,
      repository,
      expectedSha: localCommitSha,
      preferredToken: githubToken,
    });
    expect(remoteCommitSha).toBe(localCommitSha);

    await harness.page.evaluate(
      async ({
        marker,
        notePath,
        projectId,
        projectUrl,
        issueUrl,
        workspaceId,
        relativePath,
        githubHtmlUrl,
        ownerLogin,
        localCommitSha,
      }) => {
        const app = (window as typeof window & { app?: any }).app;
        const file = app.vault.getAbstractFileByPath(notePath);
        if (!file) throw new Error(`Reflection note missing: ${notePath}`);
        await app.workspace.getLeaf(true).openFile(file);
        const reflection = [
          "",
          `## Number guess delivery reflection ${marker}`,
          "",
          `- Linear project: ${projectId}${projectUrl ? ` (${projectUrl})` : ""}`,
          `- Linear issue: ${issueUrl}`,
          `- Code workspace: ${workspaceId} / ${relativePath}`,
          "- Validation: protected behavior verifier + node:test passed",
          `- Verified commit: ${localCommitSha}`,
          `- GitHub private: ${githubHtmlUrl}`,
          `- Owner: ${ownerLogin}`,
          "",
        ].join("\n");
        await app.vault.append(file, reflection);
        const noteBody = await app.vault.read(file);
        if (
          !noteBody.includes(marker) ||
          !noteBody.includes(projectId) ||
          !noteBody.includes(issueUrl) ||
          !noteBody.includes(localCommitSha) ||
          !noteBody.includes(githubHtmlUrl)
        ) {
          throw new Error("Obsidian reflection note missing Linear/GitHub proof lines.");
        }
      },
      {
        marker,
        notePath,
        projectId: proof.projectId,
        projectUrl: proof.projectUrl,
        issueUrl: proof.issueUrl,
        workspaceId: proof.workspaceId,
        relativePath: proof.relativePath,
        githubHtmlUrl,
        ownerLogin: githubAccount.login,
        localCommitSha,
      },
    );

    const remotePrivate = await assertPrivateRepositoryExists(
      githubClient,
      githubAccount.login,
      repository,
    );
    expect(remotePrivate).toBe(true);

    console.log(
      [
        "NUMBER-GUESS-LIVE success",
        `linearProject=${proof.projectId}`,
        `linearIssue=${proof.issueUrl}`,
        `github=${githubHtmlUrl}`,
        `commit=${localCommitSha}`,
        `note=${proof.notePath}`,
        `workspace=${proof.workspaceId}`,
      ].join(" "),
    );
    test.info().annotations.push({
      type: "number-guess-live",
      description: [
        `linearProject=${proof.projectId}`,
        `linearIssue=${proof.issueUrl}`,
        `github=${githubHtmlUrl}`,
        `commit=${localCommitSha}`,
        `note=${proof.notePath}`,
        `marker=${marker}`,
      ].join(" "),
    });
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupErrors.push(...await cleanupManifest.cleanupAll());
    try {
      await harness?.close();
    } catch (cleanupError) {
      cleanupErrors.push(`Harness cleanup: ${safeExternalCleanupError(cleanupError)}`);
    }
    try {
      await fixture.cleanup();
    } catch (cleanupError) {
      cleanupErrors.push(`Fixture cleanup: ${safeExternalCleanupError(cleanupError)}`);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new Error(
      [
        primaryError
          ? `NUMBER-GUESS-LIVE failed: ${safeErrorMessage(primaryError)}`
          : "NUMBER-GUESS-LIVE assertions passed",
        `mandatory cleanup failed: ${cleanupErrors.join("; ")}`,
      ].join("; "),
    );
  }
  if (primaryError) throw primaryError;
});

function createNumberGuessSource(marker: string): string {
  return [
    `export const marker = ${JSON.stringify(marker)};`,
    "",
    "export function checkGuess(guess, target) {",
    "  if (!Number.isInteger(target) || target < 1 || target > 100) {",
    "    throw new RangeError('target must be an integer from 1 through 100');",
    "  }",
    "  if (!Number.isInteger(guess) || guess < 1 || guess > 100) return 'invalid';",
    "  if (guess < target) return 'too-low';",
    "  if (guess > target) return 'too-high';",
    "  return 'correct';",
    "}",
    "",
    "export function createNumberGuessGame(target) {",
    "  let attempts = 0;",
    "  let complete = false;",
    "  checkGuess(target, target);",
    "  return {",
    "    guess(value) {",
    "      if (complete) return { result: 'complete', attempts };",
    "      attempts += 1;",
    "      const result = checkGuess(value, target);",
    "      if (result === 'correct') complete = true;",
    "      return { result, attempts };",
    "    },",
    "  };",
    "}",
    "",
  ].join("\n");
}

function createNumberGuessTestSource(marker: string): string {
  return [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { checkGuess, createNumberGuessGame, marker } from '../src/number_guess.js';",
    "",
    `const expectedMarker = ${JSON.stringify(marker)};`,
    "",
    "test('reports low, high, correct, and invalid guesses', () => {",
    "  assert.equal(marker, expectedMarker);",
    "  assert.equal(checkGuess(10, 42), 'too-low');",
    "  assert.equal(checkGuess(75, 42), 'too-high');",
    "  assert.equal(checkGuess(42, 42), 'correct');",
    "  assert.equal(checkGuess(0, 42), 'invalid');",
    "  assert.equal(checkGuess(101, 42), 'invalid');",
    "  assert.equal(checkGuess(3.5, 42), 'invalid');",
    "});",
    "",
    "test('tracks attempts and closes after a correct guess', () => {",
    "  const game = createNumberGuessGame(42);",
    "  assert.deepEqual(game.guess(20), { result: 'too-low', attempts: 1 });",
    "  assert.deepEqual(game.guess(60), { result: 'too-high', attempts: 2 });",
    "  assert.deepEqual(game.guess(42), { result: 'correct', attempts: 3 });",
    "  assert.deepEqual(game.guess(42), { result: 'complete', attempts: 3 });",
    "});",
    "",
  ].join("\n");
}

function createNumberGuessReadme(marker: string): string {
  return [
    "# Number Guess Game",
    "",
    `Disposable live-pipeline marker: ${marker}`,
    "",
    "A dependency-free JavaScript engine for guessing an integer from 1 through 100.",
    "It reports `too-low`, `too-high`, `correct`, or `invalid` and tracks attempts.",
    "",
    "```sh",
    "npm test",
    "```",
    "",
  ].join("\n");
}

async function runNumberGuessValidation(workspaceRoot: string): Promise<void> {
  await execFileAsync("node", ["scripts/verify-project.mjs"], {
    cwd: workspaceRoot,
    windowsHide: true,
    timeout: 60_000,
  });
  await execFileAsync("node", ["--test", "test/number_guess.test.mjs"], {
    cwd: workspaceRoot,
    windowsHide: true,
    timeout: 60_000,
  });
}

async function commitNumberGuessWorkspace(
  workspaceRoot: string,
  message: string,
): Promise<string> {
  const before = await gitText(workspaceRoot, [
    "status",
    "--short",
    "--untracked-files=all",
  ]);
  for (const expected of [
    "README.md",
    "src/number_guess.js",
    "test/number_guess.test.mjs",
  ]) {
    if (!before.includes(expected)) {
      throw new Error(`Number-guess worktree is missing expected change: ${expected}.`);
    }
  }
  await gitText(workspaceRoot, [
    "add",
    "--",
    "README.md",
    "src/number_guess.js",
    "test/number_guess.test.mjs",
  ]);
  await gitText(workspaceRoot, [
    "-c",
    `user.name=${AGENT_GIT_NAME}`,
    "-c",
    `user.email=${AGENT_GIT_EMAIL}`,
    "commit",
    "-m",
    message,
  ]);
  const sha = await gitText(workspaceRoot, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error("Number-guess commit did not produce a full Git SHA.");
  }
  const identity = await gitText(workspaceRoot, [
    "show",
    "-s",
    "--format=%an|%ae|%cn|%ce",
    sha,
  ]);
  const expectedIdentity = [
    AGENT_GIT_NAME,
    AGENT_GIT_EMAIL,
    AGENT_GIT_NAME,
    AGENT_GIT_EMAIL,
  ].join("|");
  if (identity !== expectedIdentity) {
    throw new Error(
      `GitHub publication blocked: raw author/committer identity was ${JSON.stringify(identity)}.`,
    );
  }
  const after = await gitText(workspaceRoot, [
    "status",
    "--short",
    "--untracked-files=all",
  ]);
  if (after) throw new Error(`Number-guess worktree is dirty after commit: ${after}`);
  return sha;
}

async function pushWorkspaceAndReadBack(input: {
  workspaceRoot: string;
  owner: string;
  repository: string;
  expectedSha: string;
  preferredToken: string | null;
}): Promise<string> {
  const tokens: string[] = [];
  if (input.preferredToken?.trim()) tokens.push(input.preferredToken.trim());
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      windowsHide: true,
      timeout: 30_000,
    });
    const ghToken = String(stdout).trim();
    if (ghToken && !tokens.includes(ghToken)) tokens.push(ghToken);
  } catch {
    // A secure plugin token is sufficient when gh is unavailable.
  }
  if (tokens.length === 0) {
    throw new Error("No GitHub credential is available for the disposable push.");
  }

  const remoteUrl = `https://github.com/${input.owner}/${input.repository}.git`;
  for (const token of tokens) {
    const env = gitHubAuthorizationEnvironment(token);
    try {
      await execFileAsync(
        "git",
        [
          "-c",
          "core.hooksPath=NUL",
          "-c",
          "core.fsmonitor=false",
          "push",
          remoteUrl,
          "HEAD:refs/heads/main",
        ],
        {
          cwd: input.workspaceRoot,
          windowsHide: true,
          env,
          timeout: 120_000,
          maxBuffer: 1_048_576,
        },
      );
      const { stdout } = await execFileAsync(
        "git",
        ["ls-remote", "--heads", remoteUrl, "refs/heads/main"],
        {
          cwd: input.workspaceRoot,
          windowsHide: true,
          env,
          timeout: 60_000,
          maxBuffer: 1_048_576,
        },
      );
      const remoteSha = String(stdout).trim().split(/\s+/u)[0] ?? "";
      if (remoteSha !== input.expectedSha) {
        throw new Error("GitHub main readback did not match the tested local commit.");
      }
      return remoteSha;
    } catch {
      // Try the next securely sourced credential without logging either token.
    }
  }
  throw new Error(
    `GitHub push/readback failed with ${tokens.length} available credential lease(s).`,
  );
}

function gitHubAuthorizationEnvironment(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "core.hooksPath=NUL",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 60_000,
      maxBuffer: 1_048_576,
    },
  );
  return String(stdout).trim();
}

async function cleanupLinearNumberGuessResources(
  page: Page,
  issueId: string | null,
  projectId: string | null,
): Promise<{ issueAbsent: boolean; projectAbsent: boolean }> {
  return page.evaluate(
    async ({ pluginId, issueId, projectId }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const registry = plugin?.createToolRegistry?.();
      const client = plugin?.createSecretBackedLinearClient?.();
      if (!plugin || !registry?.prepare || !registry?.executePrepared || !client) {
        throw new Error("Production Linear cleanup surfaces are unavailable.");
      }
      let sequence = 0;
      const state = async (
        operation: "issues.get" | "projects.get",
        id: string | null,
      ): Promise<"absent" | "active" | "trashed"> => {
        if (!id) return "absent";
        try {
          const record = await client.execute(operation, { id }) as any;
          return record?.trashed === true || record?.attributes?.trashed === true
            ? "trashed"
            : "active";
        } catch (error) {
          if ((error as any)?.code === "linear_not_found") return "absent";
          throw error;
        }
      };
      const trash = async (name: "linear_trash_issue" | "linear_trash_project", id: string) => {
        const context = {
          ...plugin.createToolExecutionContext(
            `Clean up the exact disposable number-guess ${name.includes("issue") ? "issue" : "project"}.`,
          ),
          runId: `number-guess-cleanup-${id}`,
          operationId: `${name}-cleanup-${++sequence}-${id}`,
          deadlineAt: Date.now() + 60_000,
        };
        const prepared = await registry.prepare(
          { id: context.operationId, name, arguments: { id } },
          context,
        );
        if (!prepared?.ok) {
          throw new Error(
            `${name} cleanup prepare failed: ${String(prepared?.error?.code ?? "unknown")}.`,
          );
        }
        const authorization = {
          preparedActionId: prepared.action.id,
          payloadFingerprint: prepared.action.payloadFingerprint,
          grantId: `number-guess-cleanup-${name}-${id}`,
        };
        const executed = await registry.executePrepared(
          prepared.action,
          { ...context, authorizedAction: authorization },
          authorization,
        );
        if (!executed?.ok || executed.receipt?.readback?.status !== "verified") {
          throw new Error(
            `${name} cleanup lacked verified provider readback: ${String(executed?.error?.code ?? "unknown")}.`,
          );
        }
      };

      if (issueId && await state("issues.get", issueId) === "active") {
        await trash("linear_trash_issue", issueId);
      }
      const issueAbsent = await state("issues.get", issueId) !== "active";
      if (projectId && await state("projects.get", projectId) === "active") {
        await trash("linear_trash_project", projectId);
      }
      const projectAbsent = await state("projects.get", projectId) !== "active";
      return { issueAbsent, projectAbsent };
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, issueId, projectId },
  );
}

async function resolveWorkspaceCleanupBinding(
  page: Page,
  workspaceId: string,
): Promise<{ workspaceRoot: string; workspaceBranch: string } | null> {
  return page.evaluate(
    async ({ corePluginId, codePluginId, workspaceId }) => {
      const app = (window as typeof window & { app?: any }).app;
      const code = app?.plugins?.plugins?.[corePluginId]?.getBundledCapability?.(
        codePluginId,
      );
      const manager = code?.workspaceManager ?? code?.runtime?.workspaceManager;
      if (!manager?.loadManifest) return null;
      try {
        const manifest = await manager.loadManifest(workspaceId);
        const workspaceRoot = String(manifest?.canonicalRoot ?? "").trim();
        const workspaceBranch = String(
          manifest?.repositoryBinding?.branch ?? "",
        ).trim();
        return workspaceRoot && workspaceBranch
          ? { workspaceRoot, workspaceBranch }
          : null;
      } catch (error) {
        const codeName = String((error as any)?.code ?? "");
        if (codeName === "workspace_not_found") return null;
        throw error;
      }
    },
    {
      corePluginId: NATIVE_CORE_PLUGIN_ID,
      codePluginId: PHASE4_CODE_PLUGIN_ID,
      workspaceId,
    },
  );
}

function safeErrorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/(?:github_pat_|gh[opusr]_)[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/(?:lin_api_|Bearer\s+)[^\s,;]+/giu, "[REDACTED]")
    .slice(0, 1_000);
}

async function seedAndActivateNote(
  page: Page,
  notePath: string,
  content: string,
): Promise<void> {
  await page.evaluate(
    async ({ notePath, content }) => {
      const app = (window as typeof window & { app?: any }).app;
      const folder = notePath.split("/").slice(0, -1).join("/");
      if (folder && !app.vault.getAbstractFileByPath(folder)) {
        await app.vault.createFolder(folder);
      }
      let file = app.vault.getAbstractFileByPath(notePath);
      if (!file) {
        file = await app.vault.create(notePath, content);
      } else {
        await app.vault.modify(file, content);
      }
      await app.workspace.getLeaf(true).openFile(file);
    },
    { notePath, content },
  );
}

async function assertDisposableRepositoryAbsent(
  client: GitHubRestClient,
  owner: string,
  repository: string,
): Promise<void> {
  const state = await readDisposableRepositoryState(client, owner, repository);
  if (state.exists) {
    throw new Error(
      `Refusing to overwrite existing GitHub repository ${owner}/${repository}.`,
    );
  }
}

async function deleteDisposableRepositoryAndVerify(
  client: GitHubRestClient,
  owner: string,
  repository: string,
): Promise<void> {
  const before = await readDisposableRepositoryState(client, owner, repository);
  if (!before.exists) return;

  try {
    await client.deleteRepository(owner, repository);
  } catch {
    await execFileAsync(
      "gh",
      ["repo", "delete", `${owner}/${repository}`, "--yes"],
      { windowsHide: true, timeout: 60_000 },
    );
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = await readDisposableRepositoryState(client, owner, repository);
    if (!state.exists) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(
    `GitHub repository ${owner}/${repository} survived mandatory cleanup.`,
  );
}

async function readDisposableRepositoryState(
  client: GitHubRestClient,
  owner: string,
  repository: string,
): Promise<{ exists: boolean; private: boolean; htmlUrl: string }> {
  let clientError: unknown = null;
  try {
    const remote = await client.getRepository(owner, repository);
    return {
      exists: true,
      private: remote.private === true,
      htmlUrl: String(remote.htmlUrl ?? ""),
    };
  } catch (error) {
    clientError = error;
  }

  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["repo", "view", `${owner}/${repository}`, "--json", "url,isPrivate"],
      { windowsHide: true, timeout: 30_000 },
    );
    const parsed = JSON.parse(String(stdout)) as {
      url?: string;
      isPrivate?: boolean;
    };
    return {
      exists: true,
      private: parsed.isPrivate === true,
      htmlUrl: String(parsed.url ?? ""),
    };
  } catch (ghError) {
    if (
      clientError instanceof GitHubApiError &&
      clientError.code === "github_not_found"
    ) {
      return { exists: false, private: false, htmlUrl: "" };
    }
    const message = safeErrorMessage(ghError);
    if (/could not resolve|not found|repository .* does not exist/iu.test(message)) {
      return { exists: false, private: false, htmlUrl: "" };
    }
    throw clientError ?? ghError;
  }
}

async function assertPrivateRepositoryExists(
  client: GitHubRestClient,
  owner: string,
  repository: string,
): Promise<boolean> {
  try {
    const remote = await client.getRepository(owner, repository);
    return remote.private === true;
  } catch {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      "gh",
      ["repo", "view", `${owner}/${repository}`, "--json", "isPrivate"],
      { windowsHide: true },
    );
    const parsed = JSON.parse(String(stdout)) as { isPrivate?: boolean };
    return parsed.isPrivate === true;
  }
}

async function createDisposablePrivateRepository(input: {
  client: GitHubRestClient;
  owner: string;
  repository: string;
  description: string;
}): Promise<{ private: boolean; htmlUrl: string }> {
  try {
    const created = await input.client.createPrivateRepository({
      ownerKind: "user",
      owner: input.owner,
      repository: input.repository,
      description: input.description,
    });
    return {
      private: created.private === true,
      htmlUrl: String(created.htmlUrl ?? ""),
    };
  } catch (error) {
    const forbidden =
      error instanceof GitHubApiError &&
      (error.code === "github_forbidden" ||
        /not accessible by personal access token/iu.test(error.message));
    if (!forbidden) throw error;
    // Vault fine-grained PATs often lack Administration:write; gh CLI keyring
    // token can create the repo only when it also proves delete authority.
    // Failing before `gh repo create` prevents a disposable-resource leak.
    await assertGhDeleteScopeForRepositoryFallback();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync(
      "gh",
      [
        "repo",
        "create",
        `${input.owner}/${input.repository}`,
        "--private",
        "--description",
        input.description,
      ],
      { windowsHide: true },
    );
    try {
      const remote = await input.client.getRepository(input.owner, input.repository);
      return {
        private: remote.private === true,
        htmlUrl: String(remote.htmlUrl ?? ""),
      };
    } catch {
      const { stdout } = await execFileAsync(
        "gh",
        ["repo", "view", `${input.owner}/${input.repository}`, "--json", "url,isPrivate"],
        { windowsHide: true },
      );
      const parsed = JSON.parse(String(stdout)) as {
        url?: string;
        isPrivate?: boolean;
      };
      return {
        private: parsed.isPrivate === true,
        htmlUrl: String(parsed.url ?? ""),
      };
    }
  }
}

async function assertGhDeleteScopeForRepositoryFallback(): Promise<void> {
  const { stdout, stderr } = await execFileAsync(
    "gh",
    ["auth", "status", "-h", "github.com"],
    { windowsHide: true, timeout: 30_000 },
  );
  const status = `${String(stdout)}\n${String(stderr)}`;
  if (!/(?:^|[\s,'"])delete_repo(?:$|[\s,'"])/mu.test(status)) {
    throw new Error(
      "GitHub CLI fallback is blocked before repository creation: the active token lacks delete_repo cleanup authority. Run gh auth refresh -h github.com -s delete_repo, then rerun the disposable test.",
    );
  }
}

async function ensureGitHubConnected(
  page: Page,
  githubToken: string | null,
): Promise<void> {
  await page.evaluate(async ({ pluginId, githubToken }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
    if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
    let github = plugin.getGitHubCredentialStatus?.();
    if (github?.connected === true) {
      try {
        await plugin.withGitHubCredentialToken(
          (_token: string, account: { id: number; login: string }) => ({
            account: { ...account },
          }),
        );
        return;
      } catch {
        // Fall through to explicit PAT import when the vault lease is stale.
      }
    }
    const token = typeof githubToken === "string" ? githubToken.trim() : "";
    if (!/^github_pat_[A-Za-z0-9_-]{20,500}$/u.test(token)) {
      throw new Error(
        "Vault GitHub lease failed and E2E_GITHUB_TOKEN is not a fine-grained github_pat_ token.",
      );
    }
    const saved = await plugin.setGitHubFineGrainedPat(token);
    if (!saved?.ok) {
      throw new Error(
        `GitHub secure credential setup failed: ${String(saved?.message ?? "unknown").slice(0, 400)}`,
      );
    }
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, githubToken });
}

async function readGitHubIdentity(
  page: Page,
): Promise<{ login: string; token: string }> {
  return page.evaluate(async ({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    if (!plugin?.withGitHubCredentialToken) {
      throw new Error("GitHub credential lease API is unavailable.");
    }
    return plugin.withGitHubCredentialToken(
      (token: string, account: { id: number; login: string }) => {
        if (!account?.login?.trim()) {
          throw new Error("GitHub vault lease returned no login.");
        }
        if (!token?.trim()) {
          throw new Error("GitHub vault lease returned no token.");
        }
        return { login: account.login.trim(), token: token.trim() };
      },
    );
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
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
