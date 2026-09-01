import { lstat, readdir, readFile, rm } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";
import {
  assertOwnedExportDirectory,
  cleanupOwnedExportDirectory,
  exportedDirectoryPath,
  extractWorkspaceIdFromSnapshot,
  listFilesBounded,
  readRawRunSnapshot,
  requireExportReceipt,
  resolveDesktopRoot,
  resolveOwnedWorkspaceContainerById,
} from "./fixtures/desktopDelivery";
import {
  assertProductionAdoptedSandboxV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";
import { laneSelectedV1 } from "./fixtures/laneSelection";
import { recordToolCallOutcomesAfterEach } from "./fixtures/toolCallCollector";

recordToolCallOutcomesAfterEach();

const LANE = "notebook-execution-live";
// A bare user-shaped prompt: notebook deliverable, executed outputs, desktop
// destination. Cell execution is not a separate tool — it happens inside
// scratch sandbox validation when the staged workspace holds an .ipynb
// (CodeExtensionRuntimeV2 attaches the notebook runtime to the scratch
// profile), so the ordinary validate ladder is the execution proof.
// The seed convention is pinned ("starting from 0 and 1") because the
// assertions are deterministic: the first live run (2026-08-25) delivered a
// fully executed notebook answering [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
// — a correct reading of the bare prompt — and failed only a hardcoded "144"
// that assumed the 1,1-start convention. Deterministic assertions need
// deterministic prompts. This exact string is pinned by the routing unit
// tests (tests/fixtures/routingGoldenCorpus.ts, tests/AgentRunner.test.ts,
// tests/jupyterReflectionIntent.test.ts, tests/projectLifecycle.test.ts);
// change them together.
const EXACT_PROMPT =
  "create a Jupyter notebook on my desktop that computes the first 12 Fibonacci numbers starting from 0 and 1, " +
  "run its cells so the saved notebook contains the printed sequence as real outputs, and deliver it";

test("NOTEBOOK-01 a notebook mission executes cells inside the real sandbox and delivers outputs", async (
  {},
  testInfo,
) => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(!laneSelectedV1(LANE), `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`);
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
  let capturedWorkspaceId: string | null = null;
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
      `notebook-exec-real-${startedAt}`,
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

    // The plugin must adopt the host-provisioned sandbox and pass its own
    // boundary probe — this lane is the live proof that notebook cells execute
    // inside the actual WSL boundary, not a mocked runtime.
    const adoptedSandbox = await assertProductionAdoptedSandboxV1(harness.page);
    expect(adoptedSandbox.selectedProvider).toBe("wsl2");
    observed.proofs.add("sandbox:host_adopted");

    let missionFailure: unknown = null;
    try {
      await harness.submitMission(EXACT_PROMPT, {
        waitForCompletion: false,
        timeoutMs: 35 * 60_000,
      });
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
    capturedWorkspaceId ??= extractWorkspaceIdFromSnapshot(rawSnapshot);
    const safeState = JSON.stringify({
      complete: rawSnapshot?.lastComplete ?? null,
      acceptance: rawSnapshot?.lastMissionLedger?.acceptance ?? null,
      receipts: (rawSnapshot?.lastReceipts ?? []).map((receipt: any) => ({
        operation: receipt.operation,
        toolName: receipt.toolName,
      })),
      providerUsage: rawSnapshot?.providerUsage ?? null,
    });
    if (missionFailure) {
      throw new Error(`mission did not complete: ${String(missionFailure)}\n${safeState}`);
    }

    const snapshot = await harness.attestProductionRun();
    rawSnapshot = snapshot;
    capturedWorkspaceId ??= extractWorkspaceIdFromSnapshot(snapshot);
    expect(snapshot.modelCallEvidence.length, safeState).toBeGreaterThan(0);
    observed.proofs.add("model:production_call");
    expect(snapshot.lastMissionLedger?.status, safeState).toBe("complete");
    expect(snapshot.lastMissionLedger?.acceptance?.status, safeState).toBe("pass");
    observed.proofs.add("graph:terminal");
    observed.approvals.add("authorization:sandbox_execution");

    // Delivered artifact: the export receipt names the real Desktop directory.
    const exportReceipt = requireExportReceipt(snapshot);
    expect(exportReceipt.readback?.status, safeState).toBe("verified");
    exportPath = exportedDirectoryPath(snapshot);
    expect(exportPath, safeState).toBeTruthy();
    const ownedExportRoot = await assertOwnedExportDirectory(
      desktopRoot,
      exportPath!,
      startedAt,
    );
    observed.artifacts.add("code:desktop_export");
    observed.proofs.add("receipt:verified_desktop_export");

    // The exported notebook itself carries the execution evidence: nbformat 4
    // JSON whose code cells have real execution counts and outputs, including
    // the 12th Fibonacci number in a stream/result payload.
    const notebooks = await listFilesBounded(ownedExportRoot, ".ipynb");
    expect(notebooks.length, safeState).toBeGreaterThanOrEqual(1);
    const notebookRaw = await readFile(notebooks[0], "utf8");
    const notebook = JSON.parse(notebookRaw);
    expect(notebook.nbformat, safeState).toBe(4);
    const codeCells = (notebook.cells ?? []).filter(
      (cell: any) => cell?.cell_type === "code",
    );
    expect(codeCells.length, safeState).toBeGreaterThanOrEqual(1);
    const executedCells = codeCells.filter(
      (cell: any) => typeof cell?.execution_count === "number" && cell.execution_count >= 1,
    );
    expect(executedCells.length, safeState).toBe(codeCells.length);
    observed.proofs.add("validation:all_cells_executed");
    const cellsWithOutputs = codeCells.filter(
      (cell: any) => Array.isArray(cell?.outputs) && cell.outputs.length > 0,
    );
    expect(cellsWithOutputs.length, safeState).toBeGreaterThanOrEqual(1);
    const errorOutputs = codeCells.flatMap((cell: any) =>
      (cell?.outputs ?? []).filter((output: any) => output?.output_type === "error"),
    );
    expect(errorOutputs, safeState).toHaveLength(0);
    observed.proofs.add("validation:no_cell_errors");
    // The prompt pins the seed convention (starting from 0 and 1), so the
    // first 12 numbers are F(0)..F(11) and the sequence ends at 89. The
    // computed tail — and specifically that pinned last term — must appear in
    // real output payloads, not just in source. Assert the contract the
    // prompt states, not one implementation of it.
    const outputsJson = JSON.stringify(codeCells.map((cell: any) => cell.outputs));
    for (const term of [13, 21, 34, 55]) {
      expect(outputsJson, safeState).toMatch(new RegExp(`\\b${term}\\b`));
    }
    expect(outputsJson, safeState).toMatch(/\b89\b/);
    observed.proofs.add("output:fibonacci_sequence");
    observed.artifacts.add("code:executed_notebook");
    observed.bindings.add("binding:notebook_outputs_export");
  } catch (error) {
    primaryError = error;
  } finally {
    if (harness) {
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
          cleanupErrors.push(`export: ${String(error)}`);
        }
      }
      if (capturedWorkspaceId) {
        const container = await resolveOwnedWorkspaceContainerById(
          capturedWorkspaceId,
        ).catch(() => null);
        if (container) {
          try {
            await rm(container, { recursive: true, force: true });
            await assertPathAbsent(container);
            observed.cleanup.add("cleanup:scratch_workspace");
          } catch (error) {
            cleanupErrors.push(`workspace: ${String(error)}`);
          }
        }
      }
      await harness.close().catch((error) =>
        cleanupErrors.push(`harness: ${String(error)}`),
      );
    }
    if (cleanupErrors.length > 0) {
      await testInfo.attach("notebook-exec-cleanup-errors", {
        body: cleanupErrors.join("\n"),
        contentType: "text/plain",
      });
    }
  }

  const missionScorecard = rawSnapshot?.lastMissionScorecard ?? null;
  if (!primaryError && cleanupErrors.length === 0) {
    expect(missionScorecard, "the completed notebook mission did not emit a scorecard").toBeTruthy();
    expect(missionScorecard?.acceptancePassed).toBe(true);
  }
  await recordDailyUseAcceptance(
    testInfo,
    "NOTEBOOK-01",
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
