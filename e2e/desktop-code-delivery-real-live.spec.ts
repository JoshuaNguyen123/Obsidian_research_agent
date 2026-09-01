import { execFile, spawn } from "node:child_process";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";
import {
  assertOwnedExportDirectory,
  captureCatalogAndFrontierTrace,
  cleanupOwnedExportDirectory,
  exportedDirectoryPath,
  extractWorkspaceIdFromSnapshot,
  graphFrontiers,
  listFilesBounded,
  readRawRunSnapshot,
  requireExportReceipt,
  resolveDesktopRoot,
  resolveOwnedWorkspaceContainerById,
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
import {
  peekToolCallCollector,
  peekToolCallCollectorDiagnosticsV1,
  recordToolCallOutcomesAfterEach,
} from "./fixtures/toolCallCollector";

recordToolCallOutcomesAfterEach();

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

test("CODE-DELIVERY-01 bare prompt authors and delivers a runnable Python game", async (
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
  // Eagerly-captured workspaceId: set as soon as the code_workspace_create
  // receipt appears in any mid-run snapshot, then kept even if lastReceipts is
  // cleared by a blocked-resume or failure before the finally block runs.
  let capturedWorkspaceId: string | null = null;
  let workspaceContainer: string | null = null;
  let approvalCount = 0;
  let primaryError: unknown = null;
  const cleanupErrors: string[] = [];
  const observed = {
    artifacts: new Set<string>(),
    proofs: new Set<string>(),
    approvals: new Set<string>(),
    bindings: new Set<string>(),
    cleanup: new Set<string>(),
  };

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
    const adoptedSandbox = await assertProductionAdoptedSandboxV1(harness.page);
    expect(adoptedSandbox.selectedProvider).toBe("wsl2");
    observed.proofs.add("sandbox:host_adopted");

    let missionFailure: unknown = null;
    try {
      await harness.submitMission(EXACT_PROMPT, {
        waitForCompletion: false,
        timeoutMs: 35 * 60_000,
      });
      // onProgress fires on every approval/continuation tick; capture the
      // workspaceId as soon as the create receipt appears.  Fire-and-forget is
      // intentional: onProgress is a void callback and reads are idempotent.
      approvalCount = await harness.approveUntilMissionComplete(35 * 60_000, {
        onProgress: () => {
          if (capturedWorkspaceId) return;
          readRawRunSnapshot(harness!.page)
            .then((snap) => {
              const id = extractWorkspaceIdFromSnapshot(snap);
              if (id && !capturedWorkspaceId) capturedWorkspaceId = id;
            })
            .catch(() => {});
        },
      });
    } catch (error) {
      missionFailure = error;
    }

    rawSnapshot = await readRawRunSnapshot(harness.page);
    // Keep first capture: if onProgress already set it, this is a no-op.
    capturedWorkspaceId ??= extractWorkspaceIdFromSnapshot(rawSnapshot);
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
    capturedWorkspaceId ??= extractWorkspaceIdFromSnapshot(snapshot);
    exportPath = exportedDirectoryPath(snapshot);
    workspaceContainer ??= await resolveScratchWorkspaceContainer(
      harness.page,
      snapshot,
      EXACT_PROMPT,
    ).catch(() => null);

    expect(snapshot.modelCallEvidence.length).toBeGreaterThan(0);
    observed.proofs.add("model:production_call");
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
    const completedGraph = graphFrontiers(snapshot);
    for (const toolName of REQUIRED_CODE_LADDER) {
      expect(
        completedGraph.some(
          (node) =>
            node.status === "complete" && node.allowedTools.includes(toolName),
        ),
        `${toolName} was planned but did not complete`,
      ).toBe(true);
    }
    observed.proofs.add("graph:required_code_ladder_complete");
    observed.approvals.add("authorization:sandbox_execution");

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
    observed.artifacts.add("code:desktop_export");
    observed.proofs.add("receipt:verified_desktop_export");
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
    observed.artifacts.add("code:python_source");
    await execFileAsync("python", ["-m", "py_compile", pythonFiles[0]!], {
      timeout: 30_000,
      windowsHide: true,
      encoding: "utf8",
    });
    observed.proofs.add("validation:python_compile");

    const runtime = await runNumberGuessingGame(pythonFiles[0]!, canonicalExport);
    await testInfo.attach("number-guessing-runtime", {
      body: JSON.stringify(runtime, null, 2),
      contentType: "application/json",
    });
    expect(runtime.timedOut, `number game timed out: ${runtime.stderr}`).toBe(false);
    expect(runtime.exitCode, `number game exited red: ${runtime.stderr}`).toBe(0);
    expect(runtime.stderr).not.toMatch(/Traceback \(most recent call last\):/u);
    expect(runtime.stdout).toMatch(/guess|number|correct|won|congrat/iu);
    observed.artifacts.add("code:runnable_cli");
    observed.proofs.add("runtime:number_game_completed");

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
    observed.proofs.add("ui:verified_export_path");
    observed.bindings.add("binding:assistant_absolute_export_path");
  } catch (error) {
    primaryError = error;
  } finally {
    if (rawSnapshot) {
      exportPath ??= exportedDirectoryPath(rawSnapshot);
      // Keep first capture: receipt may already be cleared in rawSnapshot.
      capturedWorkspaceId ??= extractWorkspaceIdFromSnapshot(rawSnapshot);
      if (harness && !workspaceContainer) {
        workspaceContainer = await resolveScratchWorkspaceContainer(
          harness.page,
          rawSnapshot,
          EXACT_PROMPT,
        ).catch(() => null);
      }
    }
    // Fall back to the filesystem-only resolver when resolveScratchWorkspaceContainer
    // returned null because lastReceipts was cleared (blocked-resume scenario).
    if (!workspaceContainer && capturedWorkspaceId) {
      workspaceContainer = await resolveOwnedWorkspaceContainerById(
        capturedWorkspaceId,
      ).catch(() => null);
    }
    if (exportPath) {
      try {
        await cleanupOwnedExportDirectory({
          desktopRoot,
          exportPath,
          desktopEntriesBefore,
        });
        await assertPathAbsent(exportPath);
        observed.cleanup.add("cleanup:desktop_export");
      } catch (error) {
        const detail = `Desktop export cleanup failed: ${String(error)}`;
        cleanupErrors.push(detail);
        testInfo.annotations.push({
          type: "cleanup-error",
          description: detail,
        });
      }
    }
    if (harness) {
      try {
        const [toolCounts, toolDiagnostics] = await Promise.all([
          peekToolCallCollector(harness.page),
          peekToolCallCollectorDiagnosticsV1(harness.page),
        ]);
        await testInfo.attach("desktop-code-tool-call-diagnostics", {
          body: JSON.stringify(
            {
              counts: toolCounts,
              events: toolDiagnostics,
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
      } catch (error) {
        testInfo.annotations.push({
          type: "tool-diagnostics-error",
          description: String(error).slice(0, 500),
        });
      }
    }
    await harness?.close().catch((error) => {
      const detail = `Harness cleanup failed: ${String(error)}`;
      cleanupErrors.push(detail);
      testInfo.annotations.push({ type: "cleanup-error", description: detail });
    });
    if (workspaceContainer) {
      try {
        await rm(workspaceContainer, { recursive: true, force: true });
        await assertPathAbsent(workspaceContainer);
        observed.cleanup.add("cleanup:scratch_workspace");
      } catch (error) {
          const detail = `Scratch workspace cleanup failed: ${String(error)}`;
          cleanupErrors.push(detail);
          testInfo.annotations.push({
            type: "cleanup-error",
            description: detail,
          });
      }
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

  const missionScorecard = rawSnapshot?.lastMissionScorecard ?? null;
  if (!primaryError && cleanupErrors.length === 0) {
    expect(missionScorecard, "the completed code-delivery mission did not emit a scorecard").toBeTruthy();
    expect(missionScorecard?.acceptancePassed).toBe(true);
  }
  await recordDailyUseAcceptance(
    testInfo,
    "CODE-DELIVERY-01",
    {
      artifacts: [...observed.artifacts],
      proofs: [...observed.proofs],
      approvals: [...observed.approvals],
      bindings: [...observed.bindings],
      cleanup: [...observed.cleanup],
    },
    {
      modelCalls: safeCounter(
        rawSnapshot?.providerUsage?.modelCallCount ??
          rawSnapshot?.modelCallEvidence?.length,
      ),
      toolCalls: safeCounter(
        rawSnapshot?.redactedResearchEffort?.usage?.toolCalls ??
          rawSnapshot?.lastReceipts?.length,
      ),
      continuations: safeCounter(rawSnapshot?.attestedRunLineage?.segmentIndex),
      approvals: approvalCount,
      missionScorecard,
    },
    { requireComplete: !primaryError && cleanupErrors.length === 0 },
  );
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("\n"));
});

function safeCounter(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : 0;
}

async function assertPathAbsent(target: string): Promise<void> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info) throw new Error(`Owned cleanup target still exists: ${target}`);
}

async function runNumberGuessingGame(
  entryPoint: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const scriptedInput = [
    ...Array.from({ length: 1000 }, (_, index) => String(index + 1)),
    "n",
    "quit",
    "exit",
    "",
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn("python", ["-X", "utf8", entryPoint], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 500_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 100_000) child.kill("SIGKILL");
    });
    child.on("error", (error) => {
      clearTimeout(deadline);
      resolve({
        stdout,
        stderr: `${stderr}\n${String(error)}`,
        exitCode: null,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
    child.stdin.write(scriptedInput);
    child.stdin.end();
  });
}
