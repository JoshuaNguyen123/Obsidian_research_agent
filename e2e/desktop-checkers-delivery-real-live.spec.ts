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
  graphFrontiers,
  listFilesBounded,
  readRawRunSnapshot,
  renderedBoardRowCount,
  requireExportReceipt,
  resolveDesktopRoot,
  pythonStandardLibraryModuleNames,
  resolveScratchWorkspaceContainer,
  unresolvedScratchPythonImports,
} from "./fixtures/desktopDelivery";
import { assertMissionUiSurfacesV1 } from "./fixtures/uiSurfaceAssertions";
import {
  assertProductionAdoptedSandboxV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";
import { laneSelectedV1 } from "./fixtures/laneSelection";

const LANE = "desktop-checkers-delivery-real-live";

/**
 * The exact prompt a user typed into Mission console, verbatim. It stopped at
 * `tool-04-code_validate_fast` with "No sandbox provider has passed its
 * boundary probe" on a machine whose WSL2 sandbox was fully provisioned: the
 * plugin held `providerConfigs: []` because only the settings modal could ever
 * populate them, and every live lane hid this by injecting the provider
 * configuration itself. This lane injects nothing.
 */
const EXACT_PROMPT = "Can you create a cli checkers game in Python on my desktop?";

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

const CODE_CAPABILITY_ID = "agentic-researcher-code";
const execFileAsync = promisify(execFile);

test("DESKTOP-01 a bare desktop prompt adopts the host sandbox and delivers a playable Python game", async (
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
      `desktop-checkers-real-${startedAt}`,
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

    // Reproduce the reported starting state exactly: a plugin holding no
    // sandbox provider at all, on a host that has one provisioned.
    const clearedState = await harness.page.evaluate(async (codePluginId) => {
      const app = (window as typeof window & { app?: any }).app;
      const code = app?.plugins?.plugins?.["agentic-researcher"]
        ?.getBundledCapability?.(codePluginId);
      if (!code?.removeSandboxProvider || !code?.readState) {
        throw new Error("The built-in Code capability is unavailable.");
      }
      for (const kind of ["docker", "podman", "wsl2", "bubblewrap"]) {
        await code.removeSandboxProvider(kind).catch(() => undefined);
      }
      const status = code.getSandboxCapabilityStatus?.() ?? null;
      return {
        providerConfigCount: code.readState().sandbox.providerConfigs.length,
        executionAvailable: status?.executionAvailable ?? null,
        blockerCode: status?.blocker?.code ?? null,
      };
    }, CODE_CAPABILITY_ID);
    expect(clearedState.providerConfigCount).toBe(0);
    expect(clearedState.executionAvailable).toBe(false);
    expect(clearedState.blockerCode).toBe("sandbox_provider_unavailable");
    await testInfo.attach("checkers-reported-starting-state", {
      body: JSON.stringify(clearedState, null, 2),
      contentType: "application/json",
    });

    // The product must recover from that state on its own, with no test-built
    // provider configuration and no operator visiting the settings modal.
    const adoptedSandbox = await assertProductionAdoptedSandboxV1(
      harness.page,
      startedAt,
    );
    expect(adoptedSandbox.selectedProvider).toBe("wsl2");
    observed.proofs.add("sandbox:host_adopted");
    await testInfo.attach("checkers-adopted-sandbox", {
      body: JSON.stringify(adoptedSandbox, null, 2),
      contentType: "application/json",
    });

    let missionFailure: unknown = null;
    try {
      await harness.submitMission(EXACT_PROMPT, {
        waitForCompletion: false,
        timeoutMs: 35 * 60_000,
      });
      approvalCount = await harness.approveUntilMissionComplete(35 * 60_000);
    } catch (error) {
      missionFailure = error;
    }

    rawSnapshot = await readRawRunSnapshot(harness.page);
    const traceCapture = await captureCatalogAndFrontierTrace(harness.page);
    await testInfo.attach("checkers-offered-catalog", {
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
    observed.proofs.add("model:production_call");
    const completedGraph = graphFrontiers(snapshot);
    const plannedGraphTools = completedGraph.flatMap(
      (frontier) => frontier.allowedTools,
    );
    expect(plannedGraphTools).toEqual(
      expect.arrayContaining([...REQUIRED_CODE_LADDER]),
    );

    // A scratch delivery must never plan a repository-only node: both of these
    // fail closed with trusted_repository_required and strand the mission
    // after the files exist but before they reach the Desktop.
    expect(plannedGraphTools).not.toContain("code_repair_record_cycle");
    expect(plannedGraphTools).not.toContain("code_commit_verified");

    // The reported blocker: no planned node may end blocked.
    expect(
      graphFrontiers(snapshot).filter((node) => node.status === "blocked"),
      "no mission-graph node may end blocked once the host sandbox is adopted",
    ).toEqual([]);
    for (const toolName of REQUIRED_CODE_LADDER) {
      expect(
        completedGraph.some(
          (node) =>
            node.status === "complete" &&
            node.allowedTools.includes(toolName),
        ),
        `${toolName} was planned but did not complete`,
      ).toBe(true);
    }
    observed.proofs.add("graph:required_code_ladder_complete");
    observed.approvals.add("authorization:sandbox_execution");

    const exportReceipt = requireExportReceipt(snapshot);
    expect(exportReceipt.readback?.status).toBe("verified");
    expect(exportReceipt.effects?.bytesWritten).toBeGreaterThan(0);
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
    expect(pythonFiles.length).toBeGreaterThan(0);

    const entryPoint = resolveCheckersEntryPoint(pythonFiles);
    const authoredSource = await readFile(entryPoint, "utf8");
    expect(authoredSource.length).toBeGreaterThan(400);
    expect(authoredSource).toMatch(/\binput\s*\(/u);
    expect(authoredSource).toMatch(/\bprint\s*\(/u);
    expect(authoredSource).toMatch(/if\s+__name__\s*==\s*["']__main__["']\s*:/u);
    expect(
      unresolvedScratchPythonImports(
        authoredSource,
        pythonFiles,
        canonicalExport,
        await pythonStandardLibraryModuleNames(),
      ),
      "the delivered game must not import anything the user has not installed",
    ).toEqual([]);
    observed.artifacts.add("code:python_source");

    // Checkers, not some other game: an 8x8 board, two sides, and captures.
    const combinedSource = (
      await Promise.all(pythonFiles.map((file) => readFile(file, "utf8")))
    ).join("\n");
    expect(combinedSource).toMatch(/\b8\b/u);
    expect(combinedSource).toMatch(/\b(?:king|crown|promot)/iu);
    expect(combinedSource).toMatch(/\b(?:captur|jump|take)/iu);

    for (const file of pythonFiles) {
      await execFileAsync("python", ["-m", "py_compile", file], {
        timeout: 30_000,
        windowsHide: true,
        encoding: "utf8",
      });
    }
    observed.proofs.add("validation:python_compile");

    // Real item, really run: start the delivered game and drive it from stdin.
    const session = await playDeliveredGame(entryPoint, canonicalExport);
    await testInfo.attach("checkers-play-session", {
      body: JSON.stringify(session, null, 2),
      contentType: "application/json",
    });
    expect(
      session.stdout.length,
      "the delivered game printed nothing when run",
    ).toBeGreaterThan(40);
    expect(
      renderedBoardRowCount(session.stdout),
      `the delivered game did not render an 8-row board:\n${session.stdout.slice(0, 2000)}`,
    ).toBeGreaterThanOrEqual(8);
    observed.proofs.add("runtime:board_rendered");
    expect(
      crashTracebacks(session.stderr),
      `The delivered game crashed: ${session.stderr}`,
    ).toEqual([]);
    observed.proofs.add("runtime:no_crash");
    observed.artifacts.add("code:playable_cli");

    // Assert the UI surfaces the mission passed through, not just its output.
    const uiSurfaces = await assertMissionUiSurfacesV1(harness.page);
    await testInfo.attach("checkers-ui-surfaces", {
      body: JSON.stringify(
        {
          transcript: uiSurfaces.transcript,
          acceptance: uiSurfaces.acceptance,
          runDetailsChars: uiSurfaces.runDetails.length,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    const assistantReply = uiSurfaces.assistantReply;
    const acceptanceByKey = new Map(
      uiSurfaces.acceptance.map(({ key, value }) => [key, value]),
    );
    expect(acceptanceByKey.get("status") ?? "").toMatch(/^pass\b/iu);
    expect(acceptanceByKey.get("missing")).toBe("none");
    expect(
      assistantReply ?? "",
      "chat must report the real absolute Desktop path it wrote",
    ).toContain(canonicalExport);
    expect(assistantReply ?? "").not.toMatch(/~[\\/]Desktop/iu);
    observed.proofs.add("ui:mission_surfaces_visible");
    observed.bindings.add("binding:assistant_absolute_export_path");
  } catch (error) {
    primaryError = error;
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
    await harness?.close().catch(() => undefined);
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
  }

  const missionScorecard = rawSnapshot?.lastMissionScorecard ?? null;
  if (!primaryError && cleanupErrors.length === 0) {
    expect(
      missionScorecard,
      "the completed production mission did not emit a scorecard",
    ).toBeTruthy();
    expect(missionScorecard?.acceptancePassed).toBe(true);
  }
  await recordDailyUseAcceptance(
    testInfo,
    "DESKTOP-01",
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
      continuations: safeCounter(
        rawSnapshot?.attestedRunLineage?.segmentIndex,
      ),
      approvals: approvalCount,
      missionScorecard,
    },
    {
      requireComplete: !primaryError && cleanupErrors.length === 0,
    },
  );
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.join("\n"));
  }
});

/** The file a user would run: an explicit entry name, else the only module. */
function resolveCheckersEntryPoint(pythonFiles: readonly string[]): string {
  const preferred = pythonFiles.find((file) =>
    /(?:^|[\\/])(?:main|__main__|checkers|game|play|cli)\.py$/iu.test(file),
  );
  if (preferred) return preferred;
  if (pythonFiles.length === 1) return pythonFiles[0]!;
  throw new Error(
    `The Desktop export had no recognizable entry point: ${pythonFiles.join(", ")}`,
  );
}

/**
 * Tracebacks that mean the delivered game is broken.
 *
 * A closed stdin pipe legitimately ends an interactive CLI with EOFError at an
 * `input()` call — that is this harness running out of scripted answers, not a
 * defect, and it still proves the game was reading input. Every other
 * traceback is a real crash.
 */
function crashTracebacks(stderr: string): string[] {
  return stderr
    .split(/(?=Traceback \(most recent call last\):)/u)
    .filter((block) => block.includes("Traceback (most recent call last):"))
    .filter((block) => !/\bEOFError\b/u.test(block))
    .map((block) => block.trim());
}

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
  if (info) {
    throw new Error(`Owned cleanup target still exists: ${target}`);
  }
}

/**
 * Launch the delivered game exactly as a user would and feed it a bounded
 * scripted session. The point is to prove the artifact starts, prints a board,
 * and survives real input — not to win a game of checkers, so the script
 * cycles plausible menu answers, move syntaxes, and quit words, and the
 * process is killed at the deadline.
 */
async function playDeliveredGame(
  entryPoint: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  // A prompt that re-asks on invalid input can eat a short script before the
  // board is ever drawn, so cycle a generous number of plausible answers.
  const answers = ["1", "", "y", "b3-c4", "b3 c4", "2 1 3 2", "help", "n"];
  const scriptedInput = [
    ...Array.from({ length: 120 }, (_, index) => answers[index % answers.length]!),
    "quit",
    "q",
    "exit",
    "n",
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
    }, 25_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 200_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 200_000) child.kill("SIGKILL");
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
