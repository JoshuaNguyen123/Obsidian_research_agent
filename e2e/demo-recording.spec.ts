import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import {
  assertOwnedExportDirectory,
  cleanupOwnedExportDirectory,
  exportedDirectoryPath,
  listFilesBounded,
  requireExportReceipt,
  resolveDesktopRoot,
  resolveScratchWorkspaceContainer,
} from "./fixtures/desktopDelivery";
import {
  assertProductionAdoptedSandboxV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";
import {
  assertDemoFrameCleanV1,
  assertDemoPresentationObserverSettlesV1,
  installDemoMissionBrokerV1,
  prepareDemoFinaleV1,
  prepareDemoPresentationV1,
  recordDemoMomentV1,
  waitForDemoMissionBrokerV1,
} from "./fixtures/demoPresentation";
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
const DEMO_NOTE_TITLE = "Text file organizer";
const DEMO_NOTE_PATH = `${DEMO_NOTE_TITLE}.md`;
const execFileAsync = promisify(execFile);
// Single-stage scratch-delivery shape ("write a X in Python on my Desktop").
// Keep the foreground mission self-contained: saying "in this note" can bind a
// current-note write goal ahead of the code workspace and deadlock the demo on
// an irrelevant note receipt. The open note remains the readable visual brief.
const DEMO_PROMPT =
  "Write a text file organizer in Python on my desktop.";

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
    await harness.seedNote(
      DEMO_NOTE_PATH,
      [
        "Turn a folder of plain-text notes into one navigable Markdown brief.",
        "",
        "## Inputs",
        "",
        "- A folder of `.txt` notes.",
        "- Input and output paths supplied at the command line.",
        "",
        "## Definition of done",
        "",
        "- Include only `.txt` files.",
        "- Preserve alphabetical source order.",
        "- Add a linked table of contents.",
        "- Validate the result with three sample notes.",
        "",
      ].join("\n"),
      true,
    );
    await harness.clearChat();
    await prepareDemoPresentationV1(harness.page, DEMO_NOTE_PATH);
    await assertDemoPresentationObserverSettlesV1(harness.page);
    await assertDemoFrameCleanV1(harness.page, DEMO_NOTE_TITLE, {
      requireSingleTitle: true,
    });
    await installDemoMissionBrokerV1(harness.page);
    await recordDemoMomentV1("builder-ready", { notePath: DEMO_NOTE_PATH });
    await harness.page.waitForTimeout(1_500);

    await recordDemoMomentV1("builder-submit", { prompt: DEMO_PROMPT });
    const brokerCompletion = waitForDemoMissionBrokerV1(
      harness.page,
      35 * 60_000,
    );
    void brokerCompletion.catch(() => undefined);
    await harness.submitMission(DEMO_PROMPT, {
      clearChatFirst: false,
      waitForCompletion: false,
      timeoutMs: 35 * 60_000,
    });
    const brokerResult = await brokerCompletion;
    expect(brokerResult.approvals).toBeGreaterThan(0);

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
    const canonicalExport = await assertOwnedExportDirectory(
      desktopRoot,
      exportPath!,
      startedAt,
    );
    const deliveredPythonFiles = await listFilesBounded(canonicalExport, ".py");
    expect(deliveredPythonFiles.length).toBeGreaterThan(0);
    for (const deliveredPythonFile of deliveredPythonFiles) {
      await execFileAsync("python", ["-m", "py_compile", deliveredPythonFile], {
        timeout: 30_000,
        windowsHide: true,
        encoding: "utf8",
      });
    }
    expect(
      snapshot.lastMissionLedger?.acceptance?.status === "pass" ||
        snapshot.lastMissionLedger?.status === "complete",
    ).toBe(true);
    const graphNodes = Object.values(
      snapshot.lastMissionGraph?.nodes ?? {},
    ) as any[];
    for (const validationTool of [
      "code_validate_fast",
      "code_validate_targeted",
      "code_validate_full",
    ]) {
      expect(
        graphNodes.some(
          (node: any) =>
            node.status === "complete" &&
            node.allowedTools?.includes(validationTool),
        ),
      ).toBe(true);
    }
    await assertDemoFrameCleanV1(harness.page, DEMO_NOTE_TITLE);
    await recordDemoMomentV1("builder-delivery-verified", {
      deliveredFiles: deliveredPythonFiles.length,
      readback: exportReceipt.readback?.status ?? "missing",
    });
    await prepareDemoFinaleV1(harness.page);
    await assertDemoFrameCleanV1(harness.page, DEMO_NOTE_TITLE);
    await recordDemoMomentV1("builder-finale", { view: "run-details" });
    await testInfo.attach("demo-recording-export", {
      body: JSON.stringify(
        {
          exportPath,
          deliveredPythonFiles,
          acceptance: snapshot.lastMissionLedger?.acceptance?.status ?? null,
          prompt: DEMO_PROMPT,
          approvals: brokerResult.approvals,
        },
        null,
        2,
      ),
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
