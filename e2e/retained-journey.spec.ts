import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories/RepositoryProfile";
import { laneSelectedV1 } from "./fixtures/laneSelection";
import { createFlowRealTypeScriptFixture } from "./fixtures/phase4GitRepo";
import { PHASE4_CODE_PLUGIN_ID } from "./fixtures/phase4Harness";
import { NATIVE_CORE_PLUGIN_ID } from "./fixtures/nativeObsidianHarness";
import {
  assertProductionAdoptedSandboxV1,
  hostProvisionedSandboxRuntimeDigestV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";
import { DAILY_USE_SCORECARD_ANNOTATION } from "./fixtures/dailyUseAcceptance";
import { assertMissionUiSurfacesV1 } from "./fixtures/uiSurfaceAssertions";
import { assertVerifiedCommitBoundCodeExamplesV1 } from "./fixtures/reflectionAssertions";

const LANE = "retained-journey";
const LINEAR_CONTAINER_NAME = "Application_testing_dumping_grounds";

/**
 * The one lane that keeps what it makes.
 *
 * Every other lane disposes its Linear issue, worktree, and GitHub repository
 * — `compound-flow-real-live` does so even on mid-run failure. That is correct
 * for a test and useless for answering "does the product actually do its job",
 * because the evidence is destroyed before anyone can look at it.
 *
 * This driver runs ONE real compound mission and registers nothing for
 * cleanup. The artifacts are the deliverable: a research note, a Linear issue,
 * a private GitHub repository, a local code folder, and a reflection written
 * back onto the same note. It asserts the chain is *linked* — the note cites
 * the real issue and repository URLs — because six disconnected artifacts
 * would mean the flow does not work even though each piece exists.
 */
const TOPIC = "local-first sync algorithms (CRDTs)";

/**
 * A dead renderer whose CDP target stays registered makes page.evaluate hang
 * forever rather than reject, so `.catch()` alone cannot defend a post-run
 * read — attempt 4 failed its mission in 2 minutes and then burned the
 * remaining 58 waiting on exactly such a read. Every page access outside the
 * bounded approval loop goes through this instead.
 */
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

test("DU-06 RETAINED-JOURNEY research to Linear to code to private GitHub, with everything kept", async (
  {},
  testInfo,
) => {
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

  const startedAt = Date.now();
  const marker = `CRDT_${startedAt}`;
  const notePath = `CRDT Research ${startedAt}.md`;
  const workspaceId = `crdt-${startedAt}`;
  const relativeCodePath = "src/flow_real.ts";
  const repositoryName = `crdt-local-first-${startedAt}`;
  // The fixture's verifier greps for this exact token in the source file.
  const safeMarker = marker.replace(/[^A-Za-z0-9_]/gu, "_");
  let harness: RealAiHarness | null = null;

  try {
    // A trusted repository binding is mandatory: code_commit_verified resolves
    // a repository worktree and fails closed without one, and GitHub
    // publication requires that verified commit. The first attempt at this
    // lane omitted the fixture and the mission had nowhere to commit.
    const fixture = await createFlowRealTypeScriptFixture(marker);
    const profile = createRepositoryProfile({
      key: "retained-journey-crdt",
      displayName: "Retained journey CRDT project",
      repositoryRoot: fixture.root,
      defaultBranch: "main",
      allowedPathPrefixes: ["src"],
      validationProfile: {
        id: "retained-journey-crdt-validation",
        bootstrapCommands: [],
        validationCommands: [
          {
            command: "python3",
            args: ["scripts/verify_project.py"],
            label: "Retained journey marker contract verification",
          },
        ],
        protectedPaths: ["scripts", "package.json"],
        allowedGeneratedPaths: [],
      },
      runtimeDigests: { python: hostProvisionedSandboxRuntimeDigestV1() },
      promotionPolicy: {
        localBasePromotion: "disabled",
        completionProof: "draft_pr",
        // Must be the real owner/repo destination: the private-repository tool
        // resolves this against the configured credential's login and fail-
        // closes on anything else. A "pending/..." placeholder blocked the
        // whole GitHub stage on attempt 14.
        githubRepository: `JoshuaNguyen123/crdt-local-first-${startedAt}`,
        requiredChecks: [],
      },
    });

    harness = await startRealAiHarness(
      `retained-journey-${startedAt}`,
      {
        // Attempt 12: research + Linear alone took ~40 min of honest work on
        // minimax before the old 50-minute budget expired with approved=0.
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
        // The credentials the user configured in the app are the ones under
        // test. Nothing is injected.
        preserveConfiguredLinearCredential: true,
        preserveConfiguredGitHubCredential: true,
        // The ONE artifact this lane keeps in the vault. Run logs, sources,
        // and everything else the session generates are cleaned at close like
        // any other lane — residue in this vault once froze Obsidian outright.
        retainVaultPaths: [notePath],
      },
    );

    await assertProductionAdoptedSandboxV1(harness.page, startedAt);

    // The compound readiness gate requires a Linear snapshot younger than 15
    // minutes, and a fresh Obsidian start does not rediscover on its own.
    // This is the same refresh the user gets from "Test connection".
    const linearReady = await harness.page.evaluate(async (pluginId) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const connection = await plugin?.testLinearConnection?.();
      const snapshot = plugin?.getLinearCapabilitySnapshot?.();
      return {
        ok: connection?.ok === true,
        message: String(connection?.message ?? "").slice(0, 200),
        teamId: plugin?.settings?.linearDefaultTeamId ?? null,
        viewerId: snapshot?.viewer?.id ?? null,
      };
    }, NATIVE_CORE_PLUGIN_ID);
    expect(
      linearReady.ok,
      `Linear must be connected for the Linear deliverable: ${linearReady.message}`,
    ).toBe(true);
    expect(
      linearReady.viewerId,
      "Linear connection readback must identify the configured viewer",
    ).not.toBeNull();

    // One note. The mission writes findings, then a reflection, then the final
    // report onto this same file — no E2E Agent Tests folder churn.
    await harness.seedNote(
      notePath,
      [`# CRDT research ${marker}`, "", "Tracking note for the retained journey run.", ""].join("\n"),
      true,
    );
    await focusNote(harness.page, notePath);

    // Modelled on the proven compound-flow-real-live prompt shape: it must hit
    // compound lifecycle detection (research + Linear + repository + GitHub +
    // reflection) and must target the exact file the fixture's verifier reads.
    const mission = [
      `Run the full pipeline for ${marker}: web research, Linear issue, repository workspace, private GitHub, and note reflection.`,
      `First research ${TOPIC} using exactly two public web sources and fetch both sources before accepting findings. Write the accepted findings into the current note ${notePath} using the canonical headings ## Problem and impact, ## Evidence and source links, and ## Proposed work, citing both fetched source URLs and passages.`,
      // Deliberately phrased to route Linear work through plain
      // linear_create_issue. Naming "research ... to Linear" routes to the
      // composite publish_research_to_linear, whose package negotiation
      // (trusted repositoryKey + profile-catalog validation requirement keys)
      // fail-closed 3x on the cheap model in attempts 16-17; the plain-create
      // route completed the stage cleanly in attempts 12, 14, and 15.
      `Then create a Linear issue with linear_create_issue in the configured team ${LINEAR_CONTAINER_NAME}, titled CRDT implementation ${marker}, whose description summarizes the accepted findings, and read it back with linear_get_issue to confirm it is assigned to the current Linear viewer.`,
      // The composite Linear publication packages code lineage and fail-closes
      // unless the mission itself names the trusted repository key (attempt 16
      // blocked three times on exactly this).
      `The trusted repository key for this mission is retained-journey-crdt.`,
      `Then create repository workspace ${workspaceId} with code_workspace_create in the trusted local repository ${fixture.root} before reading or writing any workspace file.`,
      `Read the exact existing workspace file ${relativeCodePath} via code_workspace_read path ${relativeCodePath}, then code_workspace_write_expected path ${relativeCodePath} with a small TypeScript CRDT implementation: an exported GCounter class with increment and merge, an exported ORSet class with add, remove and merge, and the exact line export const marker = "${safeMarker}"; (double quotes only).`,
      "Run targeted validation, then a distinct fresh full validation, then create one local commit with message feat: add CRDT primitives.",
      `Then create a new private GitHub repository named ${repositoryName} and publish the verified commit to it as a draft pull request.`,
      `Finally append a reflection to the current note via append_to_current_file containing marker ${marker}, the Linear issue URL, the private GitHub repository URL, and the draft pull request URL.`,
    ].join(" ");

    let missionFailure: unknown = null;
    try {
      await harness.submitMission(mission, {
        waitForCompletion: false,
        timeoutMs: 110 * 60_000,
      });
      // Fail fast when the mission never starts. A readiness gate that blocks
      // at submit leaves the UI idle, and the first attempt at this lane spent
      // a full hour waiting for a run that had never begun.
      await assertMissionActuallyStartedV1(harness.page, 4 * 60_000);
      const progress = startProgressJournalV1(harness.page, testInfo);
      try {
        await harness.approveUntilMissionComplete(100 * 60_000, {
          maxContinuations: 24,
        });
      } finally {
        await progress.stop();
      }
    } catch (error) {
      missionFailure = error;
    }

    // Every post-run read must be defensive. Obsidian can be gone by now, and
    // an exception here would replace the real mission failure with a useless
    // "Target page has been closed" — which is exactly what happened on the
    // previous attempt and cost a full diagnostic cycle.
    const snapshot = await boundedRead(readRunSnapshot(harness.page), null);
    const artifacts = collectArtifacts(snapshot);
    const noteBody = await boundedRead(harness.readNote(), "");
    const linearIssueReadback = artifacts.linearIssueId
      ? await boundedRead(
          readLinearIssueThroughProductionTool(
            harness.page,
            artifacts.linearIssueId,
            marker,
          ),
          null,
        )
      : null;
    const githubPublicationReadback = await boundedRead(
      readGitHubPublicationCheckpoint(harness.page, repositoryName),
      null,
    );
    const workspaceBinding = artifacts.workspaceId
      ? await boundedRead(
          resolveRetainedWorkspaceBinding(harness.page, artifacts.workspaceId),
          null,
        )
      : null;
    const sourceUrls = externalSourceUrlsFromNote(noteBody);
    const completedGraphToolNames = completedMissionGraphToolNames(snapshot);
    const artifactRecord: Record<string, any> = {
      marker,
      notePath,
      missionFailed: Boolean(missionFailure),
      ...artifacts,
      linearViewerId: linearReady.viewerId,
      linearIssueReadback,
      githubPublicationReadback,
      workspaceRoot: workspaceBinding?.root ?? null,
      sourceUrls,
      completedGraphToolNames,
      providerUsage: snapshot?.providerUsage ?? null,
      missionScorecard: snapshot?.lastMissionScorecard ?? null,
      noteChars: noteBody.length,
      receiptToolNames: (snapshot?.lastReceipts ?? []).map(
        (receipt: any) => receipt?.toolName,
      ),
    };

    // Everything observed is attached before any assertion, so a partial run
    // still tells us exactly which links executed.
    await testInfo.attach("retained-journey-artifacts", {
      body: JSON.stringify(artifactRecord, null, 2),
      contentType: "application/json",
    });
    await writeFile(
      path.join(process.cwd(), "test-results", "retained-journey-artifacts.json"),
      JSON.stringify(artifactRecord, null, 2),
      "utf8",
    );

    // Surface the mission's own failure before anything else can mask it.
    if (missionFailure) {
      const detail = String(
        (missionFailure as Error)?.message ?? missionFailure,
      ).slice(0, 4000);
      throw new Error(
        `Mission failed. Note chars=${noteBody.length}. Artifacts=${JSON.stringify(artifacts)}. Cause: ${detail}`,
      );
    }

    const uiSurfaces = await assertMissionUiSurfacesV1(harness.page);
    expect(uiSurfaces.assistantReply).not.toBe("");
    artifactRecord.uiSurfaces = uiSurfaces;
    await writeFile(
      path.join(process.cwd(), "test-results", "retained-journey-artifacts.json"),
      JSON.stringify(artifactRecord, null, 2),
      "utf8",
    );

    // Deliverables must exist AND be linked. A set of six unrelated artifacts
    // satisfies "they were created" while meaning the flow does not work.
    expect(artifacts.linearIssueUrl, "no Linear issue was published").not.toBeNull();
    expect(artifacts.githubRepositoryUrl, "no private GitHub repository was created").not.toBeNull();
    expect(artifacts.commitSha, "no verified commit was produced").not.toBeNull();
    expect(
      linearIssueReadback,
      "the created Linear issue was not independently readable through linear_get_issue",
    ).not.toBeNull();
    expect(linearIssueReadback?.title).toBe(`CRDT implementation ${marker}`);
    expect(linearIssueReadback?.team?.name).toBe(LINEAR_CONTAINER_NAME);
    expect(linearIssueReadback?.assignee?.id).toBe(linearReady.viewerId);
    expect(
      githubPublicationReadback,
      "the GitHub publication checkpoint was not readable",
    ).not.toBeNull();
    expect(githubPublicationReadback?.pullRequest).toMatchObject({
      state: "open",
      draft: true,
      merged: false,
      head: { sha: artifacts.commitSha },
    });
    expect(githubPublicationReadback?.remoteSha).toBe(artifacts.commitSha);
    expect(
      workspaceBinding,
      "retained journey needs the exact committed workspace for reflection proof",
    ).not.toBeNull();

    for (const requiredTool of [
      "code_workspace_read",
      "code_workspace_write_expected",
      "code_validate_targeted",
      "code_validate_full",
      "code_commit_verified",
      "linear_create_issue",
      "linear_get_issue",
      "github_create_repository",
      "publish_verified_code_to_github",
    ]) {
      expect(
        completedGraphToolNames,
        `MissionGraph did not complete required tool ${requiredTool}`,
      ).toContain(requiredTool);
    }

    const finalNote = await harness.readNote();
    expect(finalNote, "the note must carry the run marker").toContain(marker);
    expect(
      finalNote,
      "the reflection must cite the real Linear issue URL, not an invented one",
    ).toContain(artifacts.linearIssueUrl!);
    expect(
      finalNote,
      "the reflection must cite the real GitHub repository URL",
    ).toContain(artifacts.githubRepositoryUrl!);
    expect(finalNote).toContain("## Problem and impact");
    expect(finalNote).toContain("## Evidence and source links");
    expect(finalNote).toContain("## Proposed work");
    expect(sourceUrls).toHaveLength(2);
    for (const sourceUrl of sourceUrls) {
      expect(finalNote).toContain(sourceUrl);
    }
    expect(
      githubPublicationReadback?.pullRequest?.htmlUrl,
      "draft pull request URL missing from publication checkpoint",
    ).toContain("/pull/");
    expect(finalNote).toContain(
      githubPublicationReadback!.pullRequest!.htmlUrl,
    );
    if (!workspaceBinding || !artifacts.commitSha) {
      throw new Error("Retained commit-bound reflection proof is unavailable.");
    }
    const reflectionCodeExamples =
      await assertVerifiedCommitBoundCodeExamplesV1({
        note: finalNote,
        repositoryRoot: workspaceBinding.root,
        expectedCommitSha: artifacts.commitSha,
      });
    expect(reflectionCodeExamples.length).toBeGreaterThanOrEqual(1);
    expect(reflectionCodeExamples.length).toBeLessThanOrEqual(2);
    expect(
      reflectionCodeExamples.some(
        (example) =>
          example.path === relativeCodePath && example.code.includes(safeMarker),
      ),
      "retained reflection must contain exact marker-bearing code from the published commit",
    ).toBe(true);

    if (!snapshot?.lastMissionScorecard) {
      throw new Error("The completed retained journey emitted no mission scorecard.");
    }
    testInfo.annotations.push({
      type: DAILY_USE_SCORECARD_ANNOTATION,
      description: JSON.stringify(snapshot.lastMissionScorecard),
    });
  } finally {
    // Deliberately no cleanup: the artifacts are the deliverable.
    await harness?.close().catch(() => undefined);
  }
});

/**
 * Prove the mission actually began.
 *
 * `submitMission` clicks Run Mission but a blocked readiness gate simply
 * returns without starting anything, leaving the view idle. Polling for
 * completion then waits out the entire budget and reports a bare Playwright
 * timeout with no diagnosis. This surfaces the blocker text instead.
 */
/**
 * Sample the run every 30s so a crashed or hung mission still leaves a trail.
 * Without this, a renderer that dies mid-run yields only "page has been
 * closed" and no indication of how far the chain got.
 */
function startProgressJournalV1(
  page: Page,
  testInfo: { attach(name: string, body: any): Promise<void> },
): { stop(): Promise<void> } {
  const samples: any[] = [];
  let active = true;
  const loop = (async () => {
    while (active) {
      try {
        const sample = await boundedRead(page.evaluate((pluginId) => {
          const plugin = (window as typeof window & { app?: any }).app?.plugins
            ?.plugins?.[pluginId];
          const snapshot = plugin?.getMissionRunSnapshot?.() ?? null;
          return {
            at: new Date().toISOString(),
            running: plugin?.isMissionRunning?.() === true,
            modelCalls: snapshot?.modelCallEvidence?.length ?? 0,
            toolCalls: snapshot?.missionEvidence?.length ?? 0,
            receipts: (snapshot?.lastReceipts ?? []).map(
              (receipt: any) => receipt?.toolName,
            ),
            stopReason: snapshot?.lastComplete?.stopReason ?? null,
            stopDetail: String(snapshot?.lastComplete?.stopDetail ?? "").slice(0, 300),
          };
        }, NATIVE_CORE_PLUGIN_ID), null);
        if (!sample) {
          samples.push({ at: new Date().toISOString(), unreachable: true });
          break;
        }
        samples.push(sample);
      } catch {
        samples.push({ at: new Date().toISOString(), unreachable: true });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  })();
  return {
    async stop() {
      active = false;
      await loop.catch(() => undefined);
      await testInfo
        .attach("retained-journey-progress", {
          body: JSON.stringify(samples, null, 2),
          contentType: "application/json",
        } as any)
        .catch(() => undefined);
      await writeFile(
        path.join(process.cwd(), "test-results", "retained-journey-progress.json"),
        JSON.stringify(samples, null, 2),
        "utf8",
      ).catch(() => undefined);
    },
  };
}

async function assertMissionActuallyStartedV1(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";
  while (Date.now() < deadline) {
    const state = await boundedRead(page.evaluate((pluginId) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const snapshot = plugin?.getMissionRunSnapshot?.() ?? null;
      const statusEl = document.querySelector(
        ".agentic-researcher-run-status-text",
      );
      const blocker = document.querySelector(
        ".agentic-researcher-chat-attention-body",
      );
      return {
        running: plugin?.isMissionRunning?.() === true,
        status: (statusEl?.textContent ?? "").trim(),
        blocker: (blocker?.textContent ?? "").trim(),
        evidence: Array.isArray(snapshot?.missionEvidence)
          ? snapshot.missionEvidence.length
          : 0,
        modelCalls: Array.isArray(snapshot?.modelCallEvidence)
          ? snapshot.modelCallEvidence.length
          : 0,
      };
    }, NATIVE_CORE_PLUGIN_ID), null);
    lastState = JSON.stringify(state);
    if (!state) continue;
    if (state.running || state.modelCalls > 0 || state.evidence > 0) return;
    if (state.blocker) {
      throw new Error(
        `The mission was blocked at submit and never started: ${state.blocker}`,
      );
    }
    await page.waitForTimeout(5_000);
  }
  throw new Error(
    `The mission did not start within ${Math.round(timeoutMs / 1000)}s. Last observed state: ${lastState}`,
  );
}

async function focusNote(page: Page, notePath: string): Promise<void> {
  await page.evaluate(
    async ({ pluginId, notePath }) => {
      const app = (window as typeof window & { app?: any }).app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      const file = app.vault.getAbstractFileByPath(notePath);
      if (!file) throw new Error(`Tracking note missing for focus: ${notePath}`);
      const leaf =
        app.workspace.getLeavesOfType("markdown")[0] ?? app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      await plugin?.activateView?.();
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, notePath },
  );
  await page.getByRole("tab", { name: "Chat" }).click().catch(() => undefined);
}

async function readRunSnapshot(page: Page): Promise<any> {
  return page.evaluate((pluginId) => {
    const app = (window as typeof window & { app?: any }).app;
    return app?.plugins?.plugins?.[pluginId]?.getMissionRunSnapshot?.() ?? null;
  }, NATIVE_CORE_PLUGIN_ID);
}

async function resolveRetainedWorkspaceBinding(
  page: Page,
  workspaceId: string,
): Promise<{ root: string; branch: string }> {
  return page.evaluate(
    async ({ corePluginId, codePluginId, workspaceId }) => {
      const app = (window as typeof window & { app?: any }).app;
      const code = app?.plugins?.plugins?.[corePluginId]?.getBundledCapability?.(
        codePluginId,
      );
      const manager = code?.workspaceManager ?? code?.runtime?.workspaceManager;
      const manifest = await manager?.loadManifest?.(workspaceId);
      const root = String(manifest?.canonicalRoot ?? "").trim();
      const branch = String(manifest?.repositoryBinding?.branch ?? "").trim();
      if (!root || !branch) {
        throw new Error("Retained workspace binding is incomplete.");
      }
      return { root, branch };
    },
    {
      corePluginId: NATIVE_CORE_PLUGIN_ID,
      codePluginId: PHASE4_CODE_PLUGIN_ID,
      workspaceId,
    },
  );
}

/** Pull the real artifact identities out of the run's own receipts. */
function collectArtifacts(snapshot: any): {
  linearIssueUrl: string | null;
  linearIssueId: string | null;
  githubRepositoryUrl: string | null;
  commitSha: string | null;
  workspaceId: string | null;
} {
  const receipts: any[] = snapshot?.lastReceipts ?? [];
  const find = (predicate: (receipt: any) => boolean): any =>
    [...receipts].reverse().find(predicate) ?? null;

  const issue = find(
    (receipt) =>
      receipt?.resource?.system === "linear" &&
      receipt?.resource?.resourceType === "issue",
  );
  const repository = find(
    (receipt) =>
      receipt?.resource?.system === "github" &&
      typeof receipt?.resource?.url === "string",
  );
  const commit = find(
    (receipt) =>
      typeof receipt?.output?.commitSha === "string" ||
      typeof receipt?.commitSha === "string",
  );
  const workspace = find(
    (receipt) => typeof receipt?.resource?.workspaceId === "string",
  );

  return {
    linearIssueUrl: issue?.resource?.url ?? null,
    linearIssueId: issue?.resource?.id ?? null,
    githubRepositoryUrl: repository?.resource?.url ?? null,
    commitSha: commit?.output?.commitSha ?? commit?.commitSha ?? null,
    workspaceId: workspace?.resource?.workspaceId ?? null,
  };
}

async function readLinearIssueThroughProductionTool(
  page: Page,
  issueId: string,
  marker: string,
): Promise<any> {
  return page.evaluate(
    async ({ pluginId, issueId, marker }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
      const registry = plugin.createToolRegistry?.();
      const context = plugin.createToolExecutionContext?.(
        `Read back retained journey issue ${marker}.`,
      );
      if (!registry || !context) {
        throw new Error("Production Linear readback boundary is unavailable.");
      }
      const result = await registry.execute(
        {
          id: `retained-linear-readback-${marker}`,
          name: "linear_get_issue",
          arguments: { id: issueId },
        },
        context,
      );
      if (!result?.ok) {
        throw new Error(
          `linear_get_issue readback failed: ${String(result?.error?.code ?? "unknown")} ${String(result?.error?.message ?? "")}`,
        );
      }
      return result.output ?? null;
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, issueId, marker },
  );
}

async function readGitHubPublicationCheckpoint(
  page: Page,
  repositoryName: string,
): Promise<any> {
  return page.evaluate(
    ({ pluginId, repositoryName }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
      const checkpoints = Object.values(
        plugin.githubPublicationCheckpointNamespace?.checkpoints ?? {},
      ) as any[];
      return (
        checkpoints.find((checkpoint) =>
          String(checkpoint?.pullRequest?.htmlUrl ?? "").includes(
            `/${repositoryName}/pull/`,
          ),
        ) ?? null
      );
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, repositoryName },
  );
}

function externalSourceUrlsFromNote(note: string): string[] {
  const urls = note.match(/https?:\/\/[^\s)\]]+/gu) ?? [];
  return [
    ...new Set(
      urls
        .map((url) => url.replace(/[.,;:]+$/u, ""))
        .filter((url) => !/linear\.app|github\.com/iu.test(url)),
    ),
  ];
}

function completedMissionGraphToolNames(snapshot: any): string[] {
  const nodes = Object.values(snapshot?.lastMissionGraph?.nodes ?? {}) as any[];
  return [
    ...new Set(
      nodes
        .filter((node) => node?.status === "complete")
        .flatMap((node) =>
          Array.isArray(node?.allowedTools) ? node.allowedTools : [],
        )
        .filter(
          (name): name is string =>
            typeof name === "string" && name.length > 0,
        ),
    ),
  ];
}
