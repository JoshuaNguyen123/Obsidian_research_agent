import { execFile } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import {
  assertOwnedExportDirectory,
  captureCatalogAndFrontierTrace,
  cleanupOwnedExportDirectory,
  exportedDirectoryPath,
  graphFrontiers,
  listFilesBounded,
  readRawRunSnapshot,
  requireExportReceipt,
  resolveDesktopRoot,
  pythonStandardLibraryModuleNames,
  resolveScratchWorkspaceContainer,
  unresolvedScratchPythonImports,
} from "./fixtures/desktopDelivery";
import {
  assertProductionAdoptedSandboxV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";
import { laneSelectedV1 } from "./fixtures/laneSelection";

const LANE = "desktop-code-delivery-real-live";
const EXACT_PROMPT =
  "write a number guessing game in Python on my desktop";
// Scratch delivery: no code_repair_record_cycle and no code_commit_verified,
// both of which require a trusted repository worktree.
const REQUIRED_CODE_LADDER = [
  "code_sandbox_status",
  "code_workspace_create",
  "code_workspace_create_file",
  "code_validate_fast",
  "code_validate_targeted",
  "code_validate_full",
  "code_workspace_export_directory",
] as const;
const execFileAsync = promisify(execFile);

test("DESKTOP-CODE-REAL bare prompt authors and delivers a runnable Python game", async (
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
  const cleanupErrors: string[] = [];

  try {
    harness = await startRealAiHarness(
      `desktop-code-real-${startedAt}`,
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
      },
    );

    // No injected provider configuration: the plugin must adopt the
    // host-provisioned binding and pass its own boundary probe, exactly as it
    // must for a user typing this prompt.
    const adoptedSandbox = await assertProductionAdoptedSandboxV1(
      harness.page,
      startedAt,
    );
    expect(adoptedSandbox.selectedProvider).toBe("wsl2");

    let missionFailure: unknown = null;
    try {
      await harness.submitMission(EXACT_PROMPT, {
        waitForCompletion: false,
        timeoutMs: 35 * 60_000,
      });
      await harness.approveUntilMissionComplete(35 * 60_000);
    } catch (error) {
      missionFailure = error;
    }

    rawSnapshot = await readRawRunSnapshot(harness.page);
    const traceCapture = await captureCatalogAndFrontierTrace(harness.page);
    await testInfo.attach("desktop-code-offered-catalog", {
      body: JSON.stringify(
        {
          allowedToolNames: rawSnapshot?.lastConfig?.allowedToolNames ?? [],
          graphFrontiers: graphFrontiers(rawSnapshot),
          visibleTraceRows: traceCapture,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    exportPath = exportedDirectoryPath(rawSnapshot);
    workspaceContainer = await resolveScratchWorkspaceContainer(
      harness.page,
      rawSnapshot,
      EXACT_PROMPT,
    ).catch(() => null);
    if (missionFailure) throw missionFailure;

    const snapshot = await harness.attestProductionRun();
    rawSnapshot = snapshot;
    exportPath = exportedDirectoryPath(snapshot);
    workspaceContainer ??= await resolveScratchWorkspaceContainer(
      harness.page,
      snapshot,
      EXACT_PROMPT,
    ).catch(() => null);

    expect(snapshot.modelCallEvidence.length).toBeGreaterThan(0);
    expect(snapshot.lastConfig?.allowedToolNames).toEqual(
      expect.arrayContaining([...REQUIRED_CODE_LADDER]),
    );
    const plannedGraphTools = graphFrontiers(snapshot).flatMap(
      (frontier) => frontier.allowedTools,
    );
    expect(plannedGraphTools).toEqual(
      expect.arrayContaining([...REQUIRED_CODE_LADDER]),
    );
    expect(plannedGraphTools).not.toContain("code_commit_verified");
    expect(plannedGraphTools).not.toContain("append_to_current_file");

    const exportReceipt = requireExportReceipt(snapshot);
    expect(exportReceipt.readback?.status).toBe("verified");
    expect(exportReceipt.effects?.bytesWritten).toBeGreaterThan(0);
    expect(exportPath).not.toBeNull();
    if (!exportPath) {
      throw new Error("The verified Desktop export receipt had no absolute path.");
    }

    const canonicalExport = await assertOwnedExportDirectory(
      desktopRoot,
      exportPath,
      startedAt,
    );
    const pythonFiles = await listFilesBounded(canonicalExport, ".py");
    expect(pythonFiles).toHaveLength(1);
    const authoredSource = await readFile(pythonFiles[0]!, "utf8");
    expect(authoredSource.length).toBeGreaterThan(120);
    expect(authoredSource).toMatch(/\binput\s*\(/u);
    expect(authoredSource).toMatch(/\b(?:random|randint|choice)\b/u);
    expect(authoredSource).toMatch(/\bprint\s*\(/u);
    expect(authoredSource).toMatch(
      /if\s+__name__\s*==\s*["']__main__["']\s*:/u,
    );
    expect(
      unresolvedScratchPythonImports(
        authoredSource,
        pythonFiles,
        canonicalExport,
        await pythonStandardLibraryModuleNames(),
      ),
    ).toEqual([]);
    await execFileAsync("python", ["-m", "py_compile", pythonFiles[0]!], {
      timeout: 30_000,
      windowsHide: true,
      encoding: "utf8",
    });

    const assistantMessage = harness.page
      .locator(
        ".agentic-researcher-log-assistant .agentic-researcher-log-message",
      )
      .last();
    await expect(assistantMessage).toHaveClass(/\bis-rendered\b/u);
    const assistantReply = await assistantMessage.textContent();
    const exportDiagnostic = {
      resource: exportReceipt.resource ?? null,
      path: exportReceipt.path ?? null,
      outputDestinationPath: exportReceipt.output?.destinationPath ?? null,
      commitKind: exportReceipt.commitKind ?? null,
      readbackStatus: exportReceipt.readback?.status ?? null,
    };
    await testInfo.attach("desktop-code-export-receipt", {
      body: JSON.stringify(exportDiagnostic, null, 2),
      contentType: "application/json",
    });
    expect(
      assistantReply ?? "",
      `Chat did not project the verified export receipt: ${JSON.stringify(exportDiagnostic)}`,
    ).toContain(canonicalExport);
    expect(assistantReply ?? "").not.toMatch(/~[\\/]Desktop/iu);
  } finally {
    if (rawSnapshot) {
      exportPath ??= exportedDirectoryPath(rawSnapshot);
      if (harness) {
        workspaceContainer ??= await resolveScratchWorkspaceContainer(
          harness.page,
          rawSnapshot,
          EXACT_PROMPT,
        ).catch(() => null);
      }
    }
    if (exportPath) {
      await cleanupOwnedExportDirectory({
        desktopRoot,
        exportPath,
        desktopEntriesBefore,
      }).catch((error) => {
        const detail = `Desktop export cleanup failed: ${String(error)}`;
        cleanupErrors.push(detail);
        testInfo.annotations.push({
          type: "cleanup-error",
          description: detail,
        });
      });
    }
    await harness?.close().catch((error) => {
      const detail = `Harness cleanup failed: ${String(error)}`;
      cleanupErrors.push(detail);
      testInfo.annotations.push({ type: "cleanup-error", description: detail });
    });
    if (workspaceContainer) {
      await rm(workspaceContainer, { recursive: true, force: true }).catch(
        (error) => {
          const detail = `Scratch workspace cleanup failed: ${String(error)}`;
          cleanupErrors.push(detail);
          testInfo.annotations.push({
            type: "cleanup-error",
            description: detail,
          });
        },
      );
    }
    const receipts = Array.isArray(rawSnapshot?.lastReceipts)
      ? rawSnapshot.lastReceipts
      : [];
    testInfo.annotations.push({
      type: "workflow-audit-runtime-evidence-v1",
      description: JSON.stringify({
        version: 1,
        modelCallCount:
          Number.isSafeInteger(rawSnapshot?.providerUsage?.modelCallCount)
            ? rawSnapshot.providerUsage.modelCallCount
            : Array.isArray(rawSnapshot?.modelCallEvidence)
              ? rawSnapshot.modelCallEvidence.length
              : 0,
        toolCallCount: Array.isArray(rawSnapshot?.missionEvidence)
          ? rawSnapshot.missionEvidence.length
          : 0,
        receiptCount: receipts.length,
        verifiedReceiptCount: receipts.filter(
          (receipt: any) => receipt?.readback?.status === "verified",
        ).length,
        cleanupStatus: cleanupErrors.length === 0 ? "verified" : "failed",
      }),
    });
  }
});
