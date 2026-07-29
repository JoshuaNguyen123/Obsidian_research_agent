import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories/RepositoryProfile";
import { laneSelectedV1 } from "./fixtures/laneSelection";
import { createFlowRealTypeScriptFixture } from "./fixtures/phase4GitRepo";
import { NATIVE_CORE_PLUGIN_ID } from "./fixtures/nativeObsidianHarness";
import {
  assertProductionAdoptedSandboxV1,
  hostProvisionedSandboxRuntimeDigestV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";

/**
 * JOURNEY DEMO RECORDING DRIVER — not a proof lane.
 *
 * Films one real compound mission phrased as a question a person would
 * actually ask, so website footage can trace the whole flow — research with
 * sources, a brief written into the note, a Linear issue created, code
 * implemented and validated in a trusted repository, a draft GitHub PR, and a
 * closing reflection that links every artifact. `retained-journey` stays the
 * proof; this exists to be watched. Artifacts are deliberately kept so the
 * published page can link them as receipts.
 *
 * Everything mechanical mirrors the proven retained-journey recipe (trusted
 * repository binding, plain linear_create_issue routing, exact-path
 * write_expected, named repository key) because each of those phrasings paid
 * for itself across seventeen recorded attempts at that lane.
 */

const LANE = "demo-journey-recording";
const LINEAR_CONTAINER_NAME = "Application_testing_dumping_grounds";

async function boundedRead<T>(
  read: Promise<T>,
  fallback: T,
  deadlineMs = 30_000,
): Promise<T> {
  void Promise.resolve(read).catch(() => undefined);
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      read.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("DEMO journey films a genuine research-to-PR mission with retained artifacts", async (
  {},
  testInfo,
) => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(!laneSelectedV1(LANE), `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`);
  test.skip(
    process.env.E2E_AI_MODE !== "real" || process.env.E2E_REAL_AI !== "1",
    "Requires E2E_REAL_AI=1 and E2E_AI_MODE=real.",
  );
  test.setTimeout(120 * 60_000);

  const startedAt = Date.now();
  const marker = "note_search_v1";
  const notePath = "Instant note search research.md";
  const workspaceId = "note-search";
  const relativeCodePath = "src/flow_real.ts";
  const repositoryName = `note-search-prototype-${startedAt}`;
  let harness: RealAiHarness | null = null;

  const fixture = await createFlowRealTypeScriptFixture(marker);
  const profile = createRepositoryProfile({
    key: "demo-note-search",
    displayName: "Instant note search prototype",
    repositoryRoot: fixture.root,
    defaultBranch: "main",
    allowedPathPrefixes: ["src"],
    validationProfile: {
      id: "demo-note-search-validation",
      bootstrapCommands: [],
      validationCommands: [
        {
          command: "python3",
          args: ["scripts/verify_project.py"],
          label: "Prototype contract verification",
        },
      ],
      protectedPaths: ["scripts", "package.json"],
      allowedGeneratedPaths: [],
    },
    runtimeDigests: { python: hostProvisionedSandboxRuntimeDigestV1() },
    promotionPolicy: {
      localBasePromotion: "disabled",
      completionProof: "draft_pr",
      githubRepository: `JoshuaNguyen123/${repositoryName}`,
      requiredChecks: [],
    },
  });

  try {
    harness = await startRealAiHarness(
      `demo-journey-${startedAt}`,
      {
        missionTimeoutMs: 110 * 60_000,
        completionTimeoutMs: 110 * 60_000,
      },
      {
        maxAgentSteps: 240,
        maxRunMinutes: 110,
        requestTimeoutMs: 10 * 60_000,
        completionDrivenLoops: true,
        autoContinueLongRuns: true,
        workingMode: "automatic",
        autonomyProfile: "automatic",
        thinkingMode: "medium",
        orchestratorEnabled: false,
        githubEnabled: true,
        linearEnabled: true,
        numCtx: 100_000,
        repositoryProfileRegistry: createRepositoryProfileRegistry([profile]),
      },
      {
        preserveConfiguredLinearCredential: true,
        preserveConfiguredGitHubCredential: true,
        retainVaultPaths: [notePath],
      },
    );

    await assertProductionAdoptedSandboxV1(harness.page, startedAt);

    const linearReady = await harness.page.evaluate(async (pluginId) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const connection = await plugin?.testLinearConnection?.();
      return {
        ok: connection?.ok === true,
        message: String(connection?.message ?? "").slice(0, 200),
      };
    }, NATIVE_CORE_PLUGIN_ID);
    expect(
      linearReady.ok,
      `Linear must be connected for the journey demo: ${linearReady.message}`,
    ).toBe(true);

    // The note is on camera: title and body must read like a person's real
    // working note, because in the published demo it is one.
    await harness.seedNote(
      notePath,
      [
        "# Instant note search",
        "",
        "My vault is past 4,000 notes and search is starting to feel slow.",
        "How do serious editors make full-text search feel instant?",
        "",
        "- What indexing approach do they use?",
        "- Could we prototype it for the vault?",
        "",
      ].join("\n"),
      true,
    );

    const mission = [
      "How should a notes app search thousands of files instantly? Run the full pipeline: web research, Linear issue, repository workspace, private GitHub, and note reflection.",
      `First research trigram-index text search using exactly two public web sources and fetch both sources before accepting findings. Write the accepted findings into the current note ${notePath} using the canonical headings ## Problem and impact, ## Evidence and source links, and ## Proposed work, citing both fetched source URLs and passages.`,
      `Then create a Linear issue with linear_create_issue in the configured team ${LINEAR_CONTAINER_NAME}, titled Prototype instant note search, whose description summarizes the accepted findings, and read it back with linear_get_issue to confirm it is assigned to the current Linear viewer.`,
      "The trusted repository key for this mission is demo-note-search.",
      `Then create repository workspace ${workspaceId} with code_workspace_create in the trusted local repository ${fixture.root} before reading or writing any workspace file.`,
      `Read the exact existing workspace file ${relativeCodePath} via code_workspace_read path ${relativeCodePath}, then code_workspace_write_expected path ${relativeCodePath} with a small TypeScript search implementation: an exported TrigramIndex class with add and search methods, an exported highlightMatch function, and the exact line export const marker = "${marker}"; (double quotes only).`,
      "Run targeted validation, then a distinct fresh full validation, then create one local commit with message feat: add trigram note search prototype.",
      `Then create a new private GitHub repository named ${repositoryName} and publish the verified commit to it as a draft pull request.`,
      `Finally append a reflection to the current note via append_to_current_file containing the Linear issue URL, the private GitHub repository URL, and the draft pull request URL.`,
    ].join(" ");

    await harness.submitMission(mission, {
      waitForCompletion: false,
      timeoutMs: 110 * 60_000,
    });
    // Fail fast if a readiness gate blocked at submit: an idle UI four
    // minutes in means the run never began and footage would be worthless.
    await harness.page.waitForFunction(
      (pluginId) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        return plugin?.isMissionRunning?.() === true;
      },
      NATIVE_CORE_PLUGIN_ID,
      { timeout: 4 * 60_000, polling: 2_000 },
    );
    await harness.approveUntilMissionComplete(100 * 60_000, {
      maxContinuations: 24,
    });

    const noteBody = await boundedRead(harness.readNote(), "");
    const urls = {
      linearIssueUrl: /https:\/\/linear\.app\/[^\s)>\]"']+/u.exec(noteBody)?.[0] ?? null,
      githubRepositoryUrl:
        new RegExp(
          `https://github\\.com/JoshuaNguyen123/${repositoryName}(?![\\w-])[^\\s)>\\]"']*`,
          "u",
        ).exec(noteBody)?.[0] ?? null,
      pullRequestUrl:
        /https:\/\/github\.com\/[^\s)>\]"']+\/pull\/\d+/u.exec(noteBody)?.[0] ?? null,
    };
    await writeFile(
      path.join(process.cwd(), "test-results", "demo-journey-artifacts.json"),
      `${JSON.stringify(
        {
          version: 1,
          startedAt,
          notePath,
          repositoryName,
          marker,
          ...urls,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await testInfo.attach("demo-journey-artifacts", {
      body: JSON.stringify(urls, null, 2),
      contentType: "application/json",
    });

    expect(urls.linearIssueUrl, "reflection must cite the Linear issue URL").not.toBeNull();
    expect(
      urls.githubRepositoryUrl,
      "reflection must cite the GitHub repository URL",
    ).not.toBeNull();
    expect(urls.pullRequestUrl, "reflection must cite the draft PR URL").not.toBeNull();
  } finally {
    await harness?.close().catch(() => undefined);
  }
});
