import { execFile } from "node:child_process";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

import { liveProviderConfiguration } from "../scripts/ci-sandbox-boundary";
import { PHASE4_CODE_PLUGIN_ID } from "./fixtures/phase4Harness";
import {
  NATIVE_CORE_PLUGIN_ID,
} from "./fixtures/nativeObsidianHarness";
import {
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";

const LANE = "desktop-code-delivery-real-live";
const EXACT_PROMPT =
  "write a number guessing game in Python on my desktop";
const REQUIRED_CODE_LADDER = [
  "code_sandbox_status",
  "code_workspace_create",
  "code_workspace_create_file",
  "code_validate_fast",
  "code_repair_record_cycle",
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
    process.env.E2E_PLAYWRIGHT_LANE !== LANE,
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

    const sandboxConfig = liveProviderConfiguration("wsl2");
    const sandboxProbe = await harness.page.evaluate(
      async ({ corePluginId, codePluginId, config }) => {
        const app = (window as typeof window & { app?: any }).app;
        const code = app?.plugins?.plugins?.[corePluginId]
          ?.getBundledCapability?.(codePluginId);
        if (
          !code?.configureSandboxProvider ||
          !code?.probeConfiguredSandboxProviders
        ) {
          throw new Error(
            "The built-in Code sandbox configuration API is unavailable.",
          );
        }
        await code.configureSandboxProvider(config);
        return code.probeConfiguredSandboxProviders();
      },
      {
        corePluginId: NATIVE_CORE_PLUGIN_ID,
        codePluginId: PHASE4_CODE_PLUGIN_ID,
        config: sandboxConfig,
      },
    );
    expect(sandboxProbe).toMatchObject({
      editingAvailable: true,
      executionAvailable: true,
      selectedProvider: "wsl2",
    });

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
    ).catch(() => null);
    if (missionFailure) throw missionFailure;

    const snapshot = await harness.attestProductionRun();
    rawSnapshot = snapshot;
    exportPath = exportedDirectoryPath(snapshot);
    workspaceContainer ??= await resolveScratchWorkspaceContainer(
      harness.page,
      snapshot,
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
      ),
    ).toEqual([]);
    await execFileAsync("python", ["-m", "py_compile", pythonFiles[0]!], {
      timeout: 30_000,
      windowsHide: true,
      encoding: "utf8",
    });

    const assistantReply = await harness.page
      .locator(
        ".agentic-researcher-log-assistant .agentic-researcher-log-message",
      )
      .last()
      .textContent();
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
        ).catch(() => null);
      }
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

async function readRawRunSnapshot(page: Page): Promise<any> {
  return page.evaluate(({ pluginId }) => {
    const app = (window as typeof window & { app?: any }).app;
    return app?.plugins?.plugins?.[pluginId]?.getMissionRunSnapshot?.() ?? null;
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

function unresolvedScratchPythonImports(
  source: string,
  pythonFiles: readonly string[],
  exportRoot: string,
): string[] {
  const localRoots = new Set(
    pythonFiles.map((filePath) => {
      const relative = path.relative(exportRoot, filePath).replace(/\\/gu, "/");
      const [first = ""] = relative.split("/");
      return relative.includes("/")
        ? first
        : first.replace(/\.py$/iu, "");
    }),
  );
  const allowedStandardLibraryRoots = new Set([
    "__future__",
    "argparse",
    "collections",
    "dataclasses",
    "datetime",
    "enum",
    "functools",
    "itertools",
    "json",
    "math",
    "os",
    "pathlib",
    "random",
    "re",
    "statistics",
    "string",
    "sys",
    "time",
    "typing",
  ]);
  const unresolved = new Set<string>();
  for (const line of source.split(/\r?\n/gu)) {
    const fromMatch = line.match(
      /^\s*from\s+([.A-Za-z_][A-Za-z0-9_.]*)\s+import\b/u,
    );
    if (fromMatch) {
      const imported = fromMatch[1]!;
      const root = imported.split(".").filter(Boolean)[0] ?? imported;
      if (
        imported.startsWith(".") ||
        (!allowedStandardLibraryRoots.has(root) && !localRoots.has(root))
      ) {
        unresolved.add(imported);
      }
      continue;
    }
    const importMatch = line.match(/^\s*import\s+(.+)$/u);
    if (!importMatch) continue;
    for (const imported of importMatch[1]!.split(",")) {
      const moduleName = imported.trim().split(/\s+as\s+/u)[0] ?? "";
      const root = moduleName.split(".")[0] ?? "";
      if (
        root &&
        !allowedStandardLibraryRoots.has(root) &&
        !localRoots.has(root)
      ) {
        unresolved.add(moduleName);
      }
    }
  }
  return [...unresolved].sort();
}

async function captureCatalogAndFrontierTrace(page: Page): Promise<string[]> {
  await page.getByRole("tab", { name: "Run Details" }).click();
  const text =
    (await page
      .locator(".agentic-researcher-details-panel")
      .textContent()
      .catch(() => "")) ?? "";
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.includes("Allowed tools:") ||
        line.includes("MissionGraph frontier tools:"),
    )
    .slice(-32);
}

function graphFrontiers(snapshot: any): Array<{
  id: string;
  status: string;
  allowedTools: string[];
}> {
  return Object.values(snapshot?.lastMissionGraph?.nodes ?? {}).map(
    (node: any) => ({
      id: String(node?.id ?? ""),
      status: String(node?.status ?? ""),
      allowedTools: Array.isArray(node?.allowedTools)
        ? node.allowedTools.map(String)
        : [],
    }),
  );
}

function requireExportReceipt(snapshot: any): any {
  const receipt = (snapshot?.lastReceipts ?? []).find(
    (candidate: any) =>
      candidate?.toolName === "code_workspace_export_directory" &&
      candidate?.operation === "create",
  );
  if (!receipt) {
    throw new Error(
      `No Desktop export receipt was recorded. allowed=${JSON.stringify(
        snapshot?.lastConfig?.allowedToolNames ?? [],
      )} frontiers=${JSON.stringify(graphFrontiers(snapshot))}`,
    );
  }
  return receipt;
}

function exportedDirectoryPath(snapshot: any): string | null {
  const receipt = (snapshot?.lastReceipts ?? []).find(
    (candidate: any) =>
      candidate?.toolName === "code_workspace_export_directory" &&
      candidate?.operation === "create",
  );
  const value = receipt?.resource?.path ?? receipt?.path;
  return typeof value === "string" && path.isAbsolute(value) ? value : null;
}

async function resolveDesktopRoot(): Promise<string> {
  const candidates = [
    process.env.OneDrive?.trim()
      ? path.join(process.env.OneDrive.trim(), "Desktop")
      : "",
    path.join(homedir(), "Desktop"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const info = await lstat(candidate).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink()) {
      return realpath(candidate);
    }
  }
  throw new Error("The Windows Desktop directory could not be resolved safely.");
}

async function assertOwnedExportDirectory(
  desktopRoot: string,
  exportPath: string,
  startedAt: number,
): Promise<string> {
  const canonicalDesktop = await realpath(desktopRoot);
  const canonicalExport = await realpath(exportPath);
  const relative = path.relative(canonicalDesktop, canonicalExport);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Refusing an export path outside the Desktop: ${canonicalExport}`,
    );
  }
  const info = await lstat(canonicalExport);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("The Desktop export receipt did not resolve to a safe directory.");
  }
  if (info.birthtimeMs + 5_000 < startedAt && info.ctimeMs + 5_000 < startedAt) {
    throw new Error("The Desktop export directory predates this live mission.");
  }
  return canonicalExport;
}

async function listFilesBounded(
  root: string,
  extension: string,
): Promise<string[]> {
  const queue = [root];
  const matches: string[] = [];
  let entries = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      entries += 1;
      if (entries > 100) {
        throw new Error("Desktop export exceeded the bounded test inventory.");
      }
      const absolute = path.join(current, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error("Desktop export unexpectedly contains a symbolic link.");
      }
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.isFile() && absolute.toLowerCase().endsWith(extension)) {
        matches.push(absolute);
      }
    }
  }
  return matches.sort();
}

async function resolveScratchWorkspaceContainer(
  page: Page,
  snapshot: any,
): Promise<string | null> {
  const createReceipt = (snapshot?.lastReceipts ?? []).find(
    (candidate: any) =>
      candidate?.toolName === "code_workspace_create" &&
      candidate?.operation === "create",
  );
  const workspaceId = createReceipt?.resource?.workspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) return null;
  const result = await page.evaluate(
    async ({ pluginId, workspaceId, prompt }) => {
      const app = (window as typeof window & { app?: any }).app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      return plugin?.createToolRegistry?.().execute(
        {
          id: `desktop-code-cleanup-status-${Date.now()}`,
          name: "code_workspace_status",
          arguments: { workspaceId },
        },
        plugin.createToolExecutionContext(prompt),
      );
    },
    {
      pluginId: NATIVE_CORE_PLUGIN_ID,
      workspaceId,
      prompt: EXACT_PROMPT,
    },
  );
  const manifest = result?.ok === true ? result?.output?.manifest : null;
  if (
    manifest?.kind !== "scratch" ||
    manifest?.workspaceId !== workspaceId ||
    typeof manifest?.canonicalRoot !== "string"
  ) {
    return null;
  }
  const canonicalRoot = await realpath(manifest.canonicalRoot);
  if (path.basename(canonicalRoot).toLowerCase() !== "root") {
    throw new Error("Scratch workspace root did not end in the expected root folder.");
  }
  const container = await realpath(path.dirname(canonicalRoot));
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is required for cleanup.");
  const metadataRoot = await realpath(
    path.resolve(localAppData, "AgenticResearcher", "code", "workspaces-v2"),
  );
  if (
    path.dirname(container).toLowerCase() !== metadataRoot.toLowerCase() ||
    path.basename(container) !== workspaceId
  ) {
    throw new Error(`Refusing to clean unowned workspace metadata ${container}.`);
  }
  return container;
}

async function cleanupOwnedExportDirectory(input: {
  desktopRoot: string;
  exportPath: string;
  desktopEntriesBefore: ReadonlySet<string>;
}): Promise<void> {
  const canonicalDesktop = await realpath(input.desktopRoot);
  const canonicalExport = await realpath(input.exportPath).catch(() => null);
  if (!canonicalExport) return;
  const relative = path.relative(canonicalDesktop, canonicalExport);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to clean outside Desktop: ${canonicalExport}`);
  }
  const topLevelName = relative.split(path.sep)[0]!;
  await rm(canonicalExport, { recursive: true, force: false });

  let cursor = path.dirname(canonicalExport);
  while (cursor.toLowerCase() !== canonicalDesktop.toLowerCase()) {
    if (input.desktopEntriesBefore.has(topLevelName)) break;
    if ((await readdir(cursor)).length > 0) break;
    const parent = path.dirname(cursor);
    await rmdir(cursor);
    cursor = parent;
  }
}
