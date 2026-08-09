import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import {
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories/RepositoryProfile";
import {
  GitHubApiError,
  GitHubRestClient,
} from "../src/integrations/github/GitHubRestClient";
import type { RepositoryVisibility } from "../src/integrations/github/RepositoryVisibility";
import type { HttpTransport } from "../src/model/types";
import {
  deleteDisposableGitHubRepositoryAndVerify,
  preflightGhRepositoryDeleteAuthority,
} from "./fixtures/externalCleanup";
import { laneSelectedV1 } from "./fixtures/laneSelection";
import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";
import { hostProvisionedSandboxRuntimeDigestV1 } from "./fixtures/realAiHarness";

const LANE = "configured-github-visibility-live";
const execFileAsync = promisify(execFile);

test.describe.serial("configured GitHub visibility proof", () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");

  test("uses the opaque credential, exact visibility, provider readback, and zero-residue cleanup", async () => {
    test.skip(
      !laneSelectedV1(LANE),
      `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`,
    );
    test.setTimeout(10 * 60_000);
    const visibility = requiredVisibility();
    const suffix = randomUUID().replace(/-/gu, "").slice(0, 12);
    const profileKey = `github-visibility-${suffix}`;
    const repository = `e2e-visibility-${visibility}-${suffix}`;
    const profile = createRepositoryProfile({
      key: profileKey,
      displayName: `Configured GitHub ${visibility} proof`,
      repositoryRoot: process.cwd(),
      defaultBranch: "main",
      allowedPathPrefixes: ["src"],
      validationProfile: {
        id: `github-visibility-validation-${suffix}`,
        bootstrapCommands: [],
        validationCommands: [
          {
            command: "python3",
            args: ["--version"],
            label: "Non-mutating runtime availability check",
          },
        ],
        protectedPaths: ["package.json", "scripts"],
        allowedGeneratedPaths: [],
      },
      runtimeDigests: { python: hostProvisionedSandboxRuntimeDigestV1() },
      promotionPolicy: {
        localBasePromotion: "disabled",
        completionProof: "draft_pr",
        githubRepository: `pending/${repository}`,
        requiredChecks: [],
      },
    });
    let harness: NativeObsidianHarness | null = null;
    let client: GitHubRestClient | null = null;
    let owner: string | null = null;
    let primaryError: unknown = null;
    let creationMayHaveDispatched = false;
    const cleanupErrors: unknown[] = [];
    try {
      // The cleanup actor must be proven before the production tool can create.
      await preflightGhRepositoryDeleteAuthority();
      const { stdout: tokenOutput } = await execFileAsync("gh", ["auth", "token"], {
        windowsHide: true,
        timeout: 30_000,
      });
      const cleanupToken = tokenOutput.trim();
      if (!/^gh[pousr]_[A-Za-z0-9]{20,500}$/u.test(cleanupToken)) {
        throw new Error("The active gh credential is not a classic/OAuth cleanup token.");
      }
      client = new GitHubRestClient({
        transport: fetchTransport,
        token: cleanupToken,
        timeoutMs: 60_000,
      });
      const cleanupActor = await client.getAuthenticatedUser();

      harness = await startNativeObsidianHarness({
        label: `configured-github-visibility-${suffix}`,
        corePluginDataOverrides: {
          githubEnabled: true,
          e2eHarnessAttestationEnabled: true,
          repositoryProfileRegistry: createRepositoryProfileRegistry([profile]),
        },
        setup: async ({ page }) => {
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
      const installedCredential = await harness.page.evaluate(
        async ({ pluginId, accessToken }) => {
          const plugin = (window as typeof window & { app?: any }).app?.plugins
            ?.plugins?.[pluginId];
          return plugin?.setGitHubHarnessAccessToken?.(accessToken);
        },
        { pluginId: NATIVE_CORE_PLUGIN_ID, accessToken: cleanupToken },
      );
      expect(
        installedCredential?.ok,
        installedCredential?.message ?? "GitHub credential install failed.",
      ).toBe(true);
      const pluginActor = await harness.page.evaluate(async (pluginId) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        const status = plugin?.getGitHubCredentialStatus?.();
        if (status?.connected !== true) {
          throw new Error("The configured opaque GitHub credential is not connected.");
        }
        return plugin.withGitHubCredentialToken(
          (_token: string, account: { id: number; login: string }) => ({
            id: account.id,
            login: account.login,
          }),
        );
      }, NATIVE_CORE_PLUGIN_ID);
      expect(pluginActor).toEqual({
        id: cleanupActor.id,
        login: cleanupActor.login,
      });
      const exactOwner = pluginActor.login;
      owner = exactOwner;

      await expectRepositoryAbsent(client, exactOwner, repository);
      await harness.page.evaluate(
        async ({ pluginId, profileKey, destination }) => {
          const plugin = (window as typeof window & { app?: any }).app?.plugins
            ?.plugins?.[pluginId];
          const runtimeProfile = plugin?.repositoryProfileRegistry?.profiles?.[profileKey];
          const settingsProfile =
            plugin?.settings?.repositoryProfileRegistry?.profiles?.[profileKey];
          if (!runtimeProfile?.promotionPolicy) {
            throw new Error("The disposable trusted repository profile is unavailable.");
          }
          runtimeProfile.promotionPolicy.githubRepository = destination;
          if (settingsProfile?.promotionPolicy) {
            settingsProfile.promotionPolicy.githubRepository = destination;
          }
          await plugin.saveSettings?.();
        },
        {
          pluginId: NATIVE_CORE_PLUGIN_ID,
          profileKey,
          destination: `${exactOwner}/${repository}`,
        },
      );

      creationMayHaveDispatched = true;
      const result = await harness.page.evaluate(
        async ({ pluginId, profileKey, visibility, owner, repository }) => {
          const app = (window as typeof window & { app?: any }).app;
          const plugin = app?.plugins?.plugins?.[pluginId];
          const tool = plugin?.createGitHubPrivateRepositoryAgentTool?.();
          if (!tool?.executeResult) {
            throw new Error("The production github_create_repository tool is unavailable.");
          }
          let approvalProof: any = null;
          const output = await tool.executeResult(
            {
              profileKey,
              visibility,
              description: `Disposable ${visibility} visibility proof; deleted by the same test.`,
            },
            {
              app,
              settings: plugin.settings,
              originalPrompt:
                `Create the exact ${visibility} GitHub repository ${owner}/${repository}. ` +
                `I explicitly choose ${visibility} visibility.`,
              runId: `run-github-visibility-${repository}`,
              operationId: `github-visibility-create-${repository}`,
              httpTransport: async () => {
                throw new Error("The production GitHub tool owns its transport.");
              },
              requestNestedApproval: async (request: any) => {
                approvalProof = {
                  policyTags: [...(request.policyTags ?? [])],
                  reason: String(request.reason ?? ""),
                  visibility: request.preparedAction?.normalizedArgs?.visibility ?? null,
                  private: request.preparedAction?.normalizedArgs?.private ?? null,
                };
                return {
                  approved: true,
                  approvalId: `approved-github-visibility-${repository}`,
                  approvalFingerprint: request.preparedAction.payloadFingerprint,
                };
              },
              now: () => new Date(),
            },
          );
          return {
            ok: output.ok,
            status: output.output?.status ?? null,
            receiptReadback: output.receipt?.readback?.status ?? null,
            resourceType: output.receipt?.resource?.resourceType ?? null,
            bindingVisibility: output.output?.binding?.visibility ?? null,
            checkpointStatus: output.output?.checkpoint?.status ?? null,
            approvalProof,
          };
        },
        {
          pluginId: NATIVE_CORE_PLUGIN_ID,
          profileKey,
          visibility,
          owner: exactOwner,
          repository,
        },
      );
      expect(result).toMatchObject({
        ok: true,
        status: "verified",
        receiptReadback: "verified",
        bindingVisibility: visibility,
        checkpointStatus: "verified",
        approvalProof: { visibility },
      });
      expect(result.resourceType).toBe(`${visibility}_repository`);
      expect(result.approvalProof.policyTags).toContain(`visibility_${visibility}`);
      if (visibility === "public") {
        expect(result.approvalProof.policyTags).toContain("internet_visible");
        expect(result.approvalProof.reason).toMatch(/visible on the internet/iu);
      } else {
        expect(result.approvalProof.policyTags).not.toContain("internet_visible");
      }

      const remote = await client.getRepository(exactOwner, repository);
      expect(remote.visibility).toBe(visibility);
      expect(remote.private).toBe(visibility === "private");
      expect(remote.fullName.toLowerCase()).toBe(
        `${exactOwner}/${repository}`.toLowerCase(),
      );
      test.info().annotations.push({
        type: "configured-github-visibility-proof",
        description: `created=${remote.fullName} visibility=${visibility} cleanup=required`,
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (client && owner && creationMayHaveDispatched) {
        try {
          await deleteDisposableGitHubRepositoryAndVerify({
            client,
            owner,
            repository,
          });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (harness) {
        try {
          const disconnected = await harness.page.evaluate(async (pluginId) => {
            const plugin = (window as typeof window & { app?: any }).app?.plugins
              ?.plugins?.[pluginId];
            const result = await plugin?.disconnectGitHub?.();
            return {
              result,
              status: plugin?.getGitHubCredentialStatus?.(),
            };
          }, NATIVE_CORE_PLUGIN_ID);
          if (
            disconnected.result?.ok !== true ||
            disconnected.status?.connected !== false ||
            disconnected.status?.waitingForUser !== false ||
            !/local credential was removed/iu.test(
              String(disconnected.result?.message ?? ""),
            )
          ) {
            throw new Error(
              `Configured GitHub credential cleanup was not verified: ${JSON.stringify(disconnected)}`,
            );
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          await harness.close();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw combinedCleanupFailure(
          "Configured GitHub",
          primaryError,
          cleanupErrors,
        );
      }
    }
  });
});

function requiredVisibility(): RepositoryVisibility {
  const value = process.env.E2E_GITHUB_VISIBILITY?.trim().toLowerCase();
  if (value !== undefined && value !== "" && value !== "private") {
    throw new Error(
      "Disposable GitHub live proof is private-only; set E2E_GITHUB_VISIBILITY=private.",
    );
  }
  return "private";
}

function combinedCleanupFailure(
  label: string,
  primaryError: unknown,
  cleanupErrors: readonly unknown[],
): Error {
  const primary = primaryError
    ? ` primary=${primaryError instanceof Error ? primaryError.message : String(primaryError)}`
    : "";
  const cleanup = cleanupErrors
    .map((error, index) =>
      ` cleanup[${index + 1}]=${error instanceof Error ? error.message : String(error)}`,
    )
    .join("");
  return new Error(
    `${label} zero-residue cleanup failed (${cleanupErrors.length} cleanup error${cleanupErrors.length === 1 ? "" : "s"}).${primary}${cleanup}`,
  );
}

async function expectRepositoryAbsent(
  client: GitHubRestClient,
  owner: string,
  repository: string,
): Promise<void> {
  try {
    await client.getRepository(owner, repository);
    throw new Error(`Disposable GitHub repository already exists: ${owner}/${repository}`);
  } catch (error) {
    if (error instanceof GitHubApiError && error.code === "github_not_found") return;
    throw error;
  }
}

const fetchTransport: HttpTransport = async (request) => {
  const timeout = AbortSignal.timeout(Math.max(1, request.timeoutMs ?? 30_000));
  const signal = request.abortSignal
    ? AbortSignal.any([request.abortSignal, timeout])
    : timeout;
  const response = await fetch(request.url, {
    method: request.method ?? "GET",
    headers: request.headers,
    body: typeof request.body === "string" ? request.body : undefined,
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
