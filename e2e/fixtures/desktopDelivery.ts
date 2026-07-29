import {
  lstat,
  readdir,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Page } from "@playwright/test";

import { NATIVE_CORE_PLUGIN_ID } from "./nativeObsidianHarness";

const execFileAsync = promisify(execFile);

/**
 * Shared Desktop-delivery assertions for the real-model lanes. Every helper
 * inspects artifacts that exist on the real filesystem after a real mission;
 * none of them simulate a receipt, a path, or an export.
 */

/**
 * Count printed lines that read as one row of an 8x8 board.
 *
 * Deliberately style-agnostic: the model picks its own rendering, and both
 * common shapes must count — a pipe-delimited grid whose empty squares are
 * blank (`8 |   | b |   | b | …`) and a plain token row (`8  . b . b . b . b`).
 * Splitting only on whitespace silently drops blank squares, which made a
 * perfectly good board score zero.
 */
export function renderedBoardRowCount(stdout: string): number {
  const plainStdout = stdout.replace(
    /\u001B\[[0-?]*[ -/]*[@-~]/gu,
    "",
  );
  const glyph =
    /^[.\u00B7_oOxXbBwWrRnNsS\u25CF\u25CB\u2B24\u25A1\u25A0\u25A2\u25AA+-]$/u;
  const isCell = (value: string): boolean =>
    value.length === 0 || (value.length <= 2 && glyph.test(value[0]!));
  return plainStdout.split(/\r?\n/u).filter((line) => {
    const rowLabel = line.match(/^\s*([1-8])(?=\s|\|)/u);
    if (!rowLabel) return false;
    const afterLeadingLabel = line.slice(rowLabel[0].length);
    const trailingLabel = afterLeadingLabel.match(/([1-8])\s*$/u);
    const mirroredLabel =
      trailingLabel?.[1] === rowLabel[1] &&
      typeof trailingLabel.index === "number" &&
      trailingLabel.index > 0 &&
      /\s/u.test(afterLeadingLabel[trailingLabel.index - 1]!);
    // Preserve the whitespace before a mirrored right-side label. A greedy
    // `\s+[1-8]$` strip collapses an empty row (`5          5`) to zero width
    // and rejects a real board even though the two labels bound all 8 cells.
    const body = mirroredLabel
      ? afterLeadingLabel.slice(0, trailingLabel!.index)
      : afterLeadingLabel.replace(/^\s{0,2}/u, "");
    let fixedWidthBody = body;
    let outerFrame = false;
    if (body.includes("|")) {
      const segments = body.split("|");
      // Drop the fragments outside the first and last separator.
      const rawCells = segments.slice(1, -1);
      const cells = rawCells.map((segment) => segment.trim());
      if (cells.length >= 8) return cells.every(isCell);
      // Some CLIs use one outer `| ... |` frame around a fixed-width row
      // rather than a separator around every cell. Keep evaluating its sole
      // interior segment under the same bounded glyph/width rule below.
      if (cells.length !== 1) return false;
      fixedWidthBody = rawCells[0]!;
      outerFrame = true;
    }
    const tokens = fixedWidthBody
      .split(/\s+/u)
      .filter((token) => token.length > 0);
    if (tokens.length >= 8 && tokens.every(isCell)) return true;
    // Some valid CLIs render blank cells as fixed-width spaces rather than
    // pipes or explicit "." tokens. Keep the numbered-row requirement above,
    // then accept only a board-width body made entirely of whitespace and
    // recognized one-character piece/cell glyphs.
    const visibleGlyphs = [...fixedWidthBody].filter(
      (char) => !/\s/u.test(char),
    );
    return (
      fixedWidthBody.length >= (mirroredLabel || outerFrame ? 16 : 24) &&
      visibleGlyphs.length <= 8 &&
      visibleGlyphs.every((char) => glyph.test(char))
    );
  }).length;
}

export async function readRawRunSnapshot(page: Page): Promise<any> {
  return page.evaluate(({ pluginId }) => {
    const app = (window as typeof window & { app?: any }).app;
    return app?.plugins?.plugins?.[pluginId]?.getMissionRunSnapshot?.() ?? null;
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

/**
 * The interpreter's own module list, so "did the model import something the
 * user has not installed?" is answered exactly instead of by a hand-curated
 * allowlist that fails an honest `import copy`. Cached per process.
 */
let cachedStandardLibraryModuleNames: Promise<ReadonlySet<string>> | null = null;

export function pythonStandardLibraryModuleNames(): Promise<ReadonlySet<string>> {
  cachedStandardLibraryModuleNames ??= execFileAsync(
    "python",
    [
      "-c",
      "import sys, json; print(json.dumps(sorted(getattr(sys, 'stdlib_module_names', ()))))",
    ],
    { timeout: 30_000, windowsHide: true, encoding: "utf8" },
  ).then(({ stdout }) => {
    const names = JSON.parse(stdout) as string[];
    if (!Array.isArray(names) || names.length === 0) {
      throw new Error("Python reported no standard-library module names.");
    }
    return new Set([...names, "__future__"]);
  });
  return cachedStandardLibraryModuleNames;
}

export function unresolvedScratchPythonImports(
  source: string,
  pythonFiles: readonly string[],
  exportRoot: string,
  standardLibraryModuleNames: ReadonlySet<string>,
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
  const allowedStandardLibraryRoots = standardLibraryModuleNames;
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

export async function captureCatalogAndFrontierTrace(page: Page): Promise<string[]> {
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

export function graphFrontiers(snapshot: any): Array<{
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

export function requireExportReceipt(snapshot: any): any {
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

export function exportedDirectoryPath(snapshot: any): string | null {
  const receipt = (snapshot?.lastReceipts ?? []).find(
    (candidate: any) =>
      candidate?.toolName === "code_workspace_export_directory" &&
      candidate?.operation === "create",
  );
  const value = receipt?.resource?.path ?? receipt?.path;
  return typeof value === "string" && path.isAbsolute(value) ? value : null;
}

export async function resolveDesktopRoot(): Promise<string> {
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

export async function assertOwnedExportDirectory(
  desktopRoot: string,
  exportPath: string,
  startedAt: number,
): Promise<string> {
  const canonicalDesktop = await realpath(desktopRoot);
  const candidate = path.resolve(exportPath);
  const rawInfo = await lstat(candidate);
  if (!rawInfo.isDirectory() || rawInfo.isSymbolicLink()) {
    throw new Error("The Desktop export receipt did not name a normal directory.");
  }
  const rawRelative = path.relative(canonicalDesktop, candidate);
  if (
    !rawRelative ||
    rawRelative === ".." ||
    rawRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rawRelative)
  ) {
    throw new Error(`Refusing an export path outside the Desktop: ${candidate}`);
  }
  const canonicalExport = await realpath(candidate);
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
  if (
    rawInfo.birthtimeMs + 5_000 < startedAt &&
    rawInfo.ctimeMs + 5_000 < startedAt
  ) {
    throw new Error("The Desktop export directory predates this live mission.");
  }
  return canonicalExport;
}

export async function listFilesBounded(
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

export async function resolveScratchWorkspaceContainer(
  page: Page,
  snapshot: any,
  originalPrompt: string,
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
      prompt: originalPrompt,
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

export async function cleanupOwnedExportDirectory(input: {
  desktopRoot: string;
  exportPath: string;
  desktopEntriesBefore: ReadonlySet<string>;
}): Promise<void> {
  const canonicalDesktop = await realpath(input.desktopRoot);
  const candidate = path.resolve(input.exportPath);
  const rawInfo = await lstat(candidate).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!rawInfo) return;
  if (!rawInfo.isDirectory() || rawInfo.isSymbolicLink()) {
    throw new Error(`Refusing to clean a linked export target: ${candidate}`);
  }
  const rawRelative = path.relative(canonicalDesktop, candidate);
  if (
    !rawRelative ||
    rawRelative === ".." ||
    rawRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rawRelative)
  ) {
    throw new Error(`Refusing to clean outside Desktop: ${candidate}`);
  }
  const canonicalExport = await realpath(candidate);
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
  if (input.desktopEntriesBefore.has(topLevelName)) {
    throw new Error(
      `Refusing to clean a pre-existing Desktop entry: ${topLevelName}`,
    );
  }
  await rm(candidate, { recursive: true, force: false });

  let cursor = path.dirname(candidate);
  while (cursor.toLowerCase() !== canonicalDesktop.toLowerCase()) {
    if ((await readdir(cursor)).length > 0) break;
    const parent = path.dirname(cursor);
    await rmdir(cursor);
    cursor = parent;
  }
}
