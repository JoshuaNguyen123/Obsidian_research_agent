import { readdir, rm } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import {
  cleanupOwnedExportDirectory,
  exportedDirectoryPath,
  requireExportReceipt,
  resolveDesktopRoot,
  resolveScratchWorkspaceContainer,
} from "./fixtures/desktopDelivery";
import {
  assertProductionAdoptedSandboxV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";
import { laneSelectedV1 } from "./fixtures/laneSelection";

/**
 * DEMO RECORDING DRIVER — not a proof lane.
 *
 * Exists so website demo footage can show a genuinely useful, audience-facing
 * mission instead of a test fixture's canned prompt, while reusing the exact
 * production boot + prompt-submission machinery the proof lanes trust
 * (`scripts/record-e2e-demo.mjs` wraps it with ffmpeg from outside).
 *
 * It deliberately asserts only "the mission really completed with a verified
 * export": anything stronger belongs in the proof lanes, and anything weaker
 * would let broken footage look publishable. Artifacts are cleaned up; the
 * recording is the deliverable.
 */

const LANE = "demo-recording";
// Single-stage scratch-delivery shape ("write a X in Python on my desktop"):
// naming vault-flavored nouns (markdown notes) routes the mission into the
// compound classifier, whose code_execution readiness demands a bound
// repository, and the run blocks at Review Code setup before any footage.
const DEMO_PROMPT =
  "write a python script on my desktop that combines a folder of text files into one organized document with a table of contents";

test("DEMO recording mission completes with a verified Desktop export", async (
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
  test.setTimeout(45 * 60_000);

  const startedAt = Date.now();
  const desktopRoot = await resolveDesktopRoot();
  const desktopEntriesBefore = new Set(await readdir(desktopRoot));
  let harness: RealAiHarness | null = null;
  let rawSnapshot: any = null;
  let exportPath: string | null = null;
  let workspaceContainer: string | null = null;

  try {
    harness = await startRealAiHarness(
      `demo-recording-${startedAt}`,
      {
        missionTimeoutMs: 35 * 60_000,
        completionTimeoutMs: 35 * 60_000,
      },
      {
        maxAgentSteps: 64,
        maxRunMinutes: 35,
        requestTimeoutMs: 10 * 60_000,
        completionDrivenLoops: true,
        autoContinueLongRuns: true,
        workingMode: "automatic",
        autonomyProfile: "automatic",
        thinkingMode: "medium",
        orchestratorEnabled: false,
        // The harness seeds data.json by layering overrides over the CURRENT
        // vault file, so integration flags left behind by a crashed journey
        // lane leak in and reroute this bare code prompt into the compound
        // classifier (repository required -> blocked before any footage).
        // Pin the demo to the single-capability shape it films.
        githubEnabled: false,
        linearEnabled: false,
        linearCapabilityGate: 0,
      },
    );

    await assertProductionAdoptedSandboxV1(harness.page, startedAt);

    await harness.submitMission(DEMO_PROMPT, {
      waitForCompletion: false,
      timeoutMs: 35 * 60_000,
    });
    await harness.approveUntilMissionComplete(35 * 60_000);

    const snapshot = await harness.attestProductionRun();
    rawSnapshot = snapshot;
    exportPath = exportedDirectoryPath(snapshot);
    workspaceContainer = await resolveScratchWorkspaceContainer(
      harness.page,
      snapshot,
      DEMO_PROMPT,
    ).catch(() => null);

    const exportReceipt = requireExportReceipt(snapshot);
    expect(exportReceipt.readback?.status).toBe("verified");
    expect(exportPath).not.toBeNull();
    await testInfo.attach("demo-recording-export", {
      body: JSON.stringify({ exportPath, prompt: DEMO_PROMPT }, null, 2),
      contentType: "application/json",
    });
  } finally {
    if (rawSnapshot && !exportPath) {
      exportPath = exportedDirectoryPath(rawSnapshot);
    }
    if (exportPath) {
      await cleanupOwnedExportDirectory({
        desktopRoot,
        exportPath,
        desktopEntriesBefore,
      }).catch((error) => {
        testInfo.annotations.push({
          type: "cleanup-error",
          description: `Desktop export cleanup failed: ${String(error)}`,
        });
      });
    }
    await harness?.close().catch(() => undefined);
    if (workspaceContainer) {
      await rm(workspaceContainer, { recursive: true, force: true }).catch(
        (error) => {
          testInfo.annotations.push({
            type: "cleanup-error",
            description: `Scratch workspace cleanup failed: ${String(error)}`,
          });
        },
      );
    }
  }
});
