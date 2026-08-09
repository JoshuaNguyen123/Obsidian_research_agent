import { execFile } from "node:child_process";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import {
  exportedDirectoryPath,
  graphFrontiers,
  listFilesBounded,
  readRawRunSnapshot,
  requireExportReceipt,
  resolveScratchWorkspaceContainer,
} from "./fixtures/desktopDelivery";
import {
  assertProductionAdoptedSandboxV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";
import { laneSelectedV1 } from "./fixtures/laneSelection";

const LANE = "vault-sibling-code-delivery-real-live";
const EXACT_PROMPT = [
  "Build a working Python calculator project with calculator.py and test_calculator.py using unittest.",
  "Create both source and test files, validate the full test suite, and clearly report where the project was created.",
].join(" ");
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

test("VAULT-SIBLING-CODE-REAL delivers a tested standalone project beside the active vault", async (
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
  let harness: RealAiHarness | null = null;
  let rawSnapshot: any = null;
  let exportPath: string | null = null;
  let workspaceContainer: string | null = null;
  let siblingContainer = "";
  let siblingContainerExisted = false;
  let siblingEntriesBefore = new Set<string>();
  let primaryError: unknown = null;
  const cleanupErrors: unknown[] = [];

  try {
    harness = await startRealAiHarness(
      `vault-sibling-code-real-${startedAt}`,
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

    const canonicalVault = await realpath(harness.vaultRoot);
    siblingContainer = path.join(
      path.dirname(canonicalVault),
      `${path.basename(canonicalVault)} Agent Projects`,
    );
    const siblingInfo = await lstat(siblingContainer).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (siblingInfo) {
      if (!siblingInfo.isDirectory() || siblingInfo.isSymbolicLink()) {
        throw new Error("The vault-sibling project container is not a safe directory.");
      }
      siblingContainerExisted = true;
      siblingEntriesBefore = new Set(await readdir(siblingContainer));
    }

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

    const exportReceipt = requireExportReceipt(snapshot);
    expect(exportReceipt.readback?.status).toBe("verified");
    expect(exportReceipt.effects?.bytesWritten).toBeGreaterThan(0);
    if (!exportPath) {
      throw new Error("The verified vault-sibling export receipt had no absolute path.");
    }
    const canonicalExport = await assertOwnedVaultSiblingExport({
      siblingContainer,
      exportPath,
      siblingEntriesBefore,
      startedAt,
    });
    expect(path.dirname(canonicalExport).toLowerCase()).toBe(
      (await realpath(siblingContainer)).toLowerCase(),
    );

    const pythonFiles = await listFilesBounded(canonicalExport, ".py");
    expect(pythonFiles.length).toBeGreaterThanOrEqual(2);
    const sourcePath = pythonFiles.find(
      (candidate) => path.basename(candidate).toLowerCase() === "calculator.py",
    );
    const testPath = pythonFiles.find(
      (candidate) => path.basename(candidate).toLowerCase() === "test_calculator.py",
    );
    expect(sourcePath).toBeTruthy();
    expect(testPath).toBeTruthy();
    expect(await readFile(sourcePath!, "utf8")).toMatch(
      /\b(?:add|subtract|multiply|divide)\b/iu,
    );
    expect(await readFile(testPath!, "utf8")).toMatch(/\bunittest\b/iu);
    await execFileAsync(
      "python",
      ["-m", "unittest", "discover", "-s", canonicalExport, "-p", "test*.py"],
      {
        cwd: canonicalExport,
        timeout: 30_000,
        windowsHide: true,
        encoding: "utf8",
      },
    );

    const assistantReply =
      (await harness.page
        .locator(
          ".agentic-researcher-log-assistant .agentic-researcher-log-message",
        )
        .last()
        .textContent()) ?? "";
    expect(assistantReply).toContain(canonicalExport);
    // The test vault itself may live below Desktop (as it does in the default
    // Windows setup), so the absolute sibling path can legitimately contain
    // that directory name. The canonical direct-child assertion above proves
    // the actual destination boundary without confusing an ancestor's label
    // with an explicit Desktop/Documents/Downloads export.
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
    if (exportPath && siblingContainer) {
      try {
        await cleanupOwnedVaultSiblingExport({
          siblingContainer,
          exportPath,
          siblingContainerExisted,
          siblingEntriesBefore,
        });
        await assertPathAbsent(exportPath);
      } catch (error) {
        cleanupErrors.push(error);
        testInfo.annotations.push({
          type: "cleanup-error",
          description: `Vault-sibling export cleanup failed: ${String(error)}`,
        });
      }
    }
    if (harness) {
      try {
        await harness.close();
      } catch (error) {
        cleanupErrors.push(error);
        testInfo.annotations.push({
          type: "cleanup-error",
          description: `Obsidian harness cleanup failed: ${String(error)}`,
        });
      }
    }
    if (workspaceContainer) {
      try {
        await rm(workspaceContainer, { recursive: true, force: false });
        await assertPathAbsent(workspaceContainer);
      } catch (error) {
        cleanupErrors.push(error);
        testInfo.annotations.push({
          type: "cleanup-error",
          description: `Scratch workspace cleanup failed: ${String(error)}`,
        });
      }
    }
  }

  if (cleanupErrors.length > 0) {
    throw combinedCleanupFailure(
      "Vault-sibling",
      primaryError,
      cleanupErrors,
    );
  }
  if (primaryError) throw primaryError;
});

async function assertOwnedVaultSiblingExport(input: {
  siblingContainer: string;
  exportPath: string;
  siblingEntriesBefore: ReadonlySet<string>;
  startedAt: number;
}): Promise<string> {
  const canonicalContainer = await realpath(input.siblingContainer);
  const candidate = path.resolve(input.exportPath);
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("The vault-sibling export receipt did not name a normal directory.");
  }
  const canonicalExport = await realpath(candidate);
  const relative = path.relative(canonicalContainer, canonicalExport);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new Error(`Refusing an export outside the direct vault-sibling container: ${candidate}`);
  }
  if (input.siblingEntriesBefore.has(relative)) {
    throw new Error(`The export reused a pre-existing vault-sibling project: ${relative}`);
  }
  if (info.birthtimeMs + 5_000 < input.startedAt && info.ctimeMs + 5_000 < input.startedAt) {
    throw new Error("The vault-sibling export directory predates this live mission.");
  }
  return canonicalExport;
}

async function cleanupOwnedVaultSiblingExport(input: {
  siblingContainer: string;
  exportPath: string;
  siblingContainerExisted: boolean;
  siblingEntriesBefore: ReadonlySet<string>;
}): Promise<void> {
  const canonicalContainer = await realpath(input.siblingContainer);
  const candidate = path.resolve(input.exportPath);
  const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Refusing to clean a linked vault-sibling target: ${candidate}`);
  }
  const canonicalExport = await realpath(candidate);
  const relative = path.relative(canonicalContainer, canonicalExport);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep) ||
    input.siblingEntriesBefore.has(relative)
  ) {
    throw new Error(`Refusing unsafe vault-sibling cleanup: ${candidate}`);
  }
  await rm(canonicalExport, { recursive: true, force: false });
  if (!input.siblingContainerExisted && (await readdir(canonicalContainer)).length === 0) {
    await rmdir(canonicalContainer);
  }
}

async function assertPathAbsent(target: string): Promise<void> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info) throw new Error(`Owned cleanup target still exists: ${target}`);
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
