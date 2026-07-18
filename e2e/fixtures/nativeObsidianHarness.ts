import { chromium, type Browser, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  terminateControlledObsidian,
  waitForWindowsProcessExit,
} from "../../scripts/obsidian-process-lifecycle";
import {
  restoreOwnedE2EArtifacts,
  snapshotOwnedE2EArtifacts,
} from "./ownedE2EArtifacts";
import {
  createPluginDataBackup,
  recoverStalePluginDataBackup,
  restorePluginDataSnapshot,
} from "./pluginDataBackup";
import { fingerprintCanonicalJson } from "../../src/agent/queue/fingerprint";
import { parseRepositoryProfileRegistry } from "../../src/agent/repositories/RepositoryProfile";
import {
  parseCodeRuntimeStateV2,
} from "../../extensions/code/CodeExtensionRuntimeV2";
import { migrateRepositoryProfileV1 } from "../../extensions/code/repositories";

const execFileAsync = promisify(execFile);
const DEFAULT_CDP_PORT = 11223;

export const NATIVE_CORE_PLUGIN_ID = "agentic-researcher";

export interface NativeObsidianSetupContext {
  page: Page;
  marker: string;
  notePath: string;
  vaultRoot: string;
}

export interface NativeObsidianHarness {
  page: Page;
  marker: string;
  notePath: string;
  noteFilePath: string;
  vaultRoot: string;
  close(): Promise<void>;
}

export interface StartNativeObsidianHarnessOptions {
  label: string;
  pluginIds?: readonly string[];
  /** Node-side settings seed; useful for credentials that must never enter traces. */
  corePluginDataOverrides?: Readonly<Record<string, unknown>>;
  /**
   * Preserve an existing opaque Linear personal-key reference or secret-free
   * OAuth runtime state while sanitizing plaintext and provider result state.
   * Reserved for explicitly routed configured-Linear live proof.
   */
  preserveConfiguredLinearCredential?: boolean;
  /** Preserve only the existing opaque GitHub credential metadata. */
  preserveConfiguredGitHubCredential?: boolean;
  setup(context: NativeObsidianSetupContext): Promise<void>;
  beforeClose?(context: NativeObsidianSetupContext): Promise<void>;
}

/**
 * Starts one controlled Obsidian process against the isolated test vault.
 *
 * The fixture snapshots and restores the unified Agentic Researcher plugin's
 * data.json, Obsidian's open-vault state, community plugin enablement,
 * and bounded test-owned artifacts. Phase fixtures own only page setup and
 * scenario cleanup; they never need to duplicate the native lifecycle.
 */
export async function startNativeObsidianHarness(
  options: StartNativeObsidianHarnessOptions,
): Promise<NativeObsidianHarness> {
  if (process.platform !== "win32") {
    throw new Error("Native Obsidian desktop e2e is Windows-only.");
  }

  const vaultRoot = process.env.OBSIDIAN_VAULT ?? defaultVaultRoot();
  const obsidianExe = process.env.OBSIDIAN_EXE ?? defaultObsidianExe();
  const cdpPort = Number.parseInt(
    process.env.OBSIDIAN_CDP_PORT ?? String(DEFAULT_CDP_PORT),
    10,
  );
  if (!Number.isInteger(cdpPort) || cdpPort <= 0) {
    throw new Error(
      `Invalid OBSIDIAN_CDP_PORT: ${String(process.env.OBSIDIAN_CDP_PORT)}`,
    );
  }

  const requestedPluginIds = uniqueStrings(
    options.pluginIds ?? [NATIVE_CORE_PLUGIN_ID],
  );
  if (!requestedPluginIds.includes(NATIVE_CORE_PLUGIN_ID)) {
    throw new Error("The native Obsidian harness requires the core plugin.");
  }
  const pluginIds = [
    NATIVE_CORE_PLUGIN_ID,
    ...requestedPluginIds.filter((pluginId) => pluginId !== NATIVE_CORE_PLUGIN_ID),
  ];

  const obsidianStatePath = obsidianAppStatePath();
  const communityPluginsPath = path.join(
    vaultRoot,
    ".obsidian",
    "community-plugins.json",
  );
  const pluginDataPaths = pluginIds.map((pluginId) =>
    path.join(vaultRoot, ".obsidian", "plugins", pluginId, "data.json"),
  );
  // Recover a prior hard-killed harness before reading the next baseline. The
  // backup stays beside data.json, never enters Playwright, and is removed only
  // after an exact restore succeeds.
  for (const pluginDataPath of pluginDataPaths) {
    await recoverStalePluginDataBackup(pluginDataPath);
  }
  const [obsidianStateBefore, communityPluginsBefore, ...pluginDataBefore] =
    await Promise.all([
      readOptionalText(obsidianStatePath),
      readOptionalText(communityPluginsPath),
      ...pluginDataPaths.map(readOptionalText),
    ]);
  const ownedArtifactsBefore = await snapshotOwnedE2EArtifacts(vaultRoot);
  const id = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const marker = `E2E_MARKER_${id}`;
  const notePath = `E2E Agent Tests/${options.label}-${id}.md`;
  const noteFilePath = path.join(vaultRoot, ...notePath.split("/"));
  const setupContext: NativeObsidianSetupContext = {
    page: null as unknown as Page,
    marker,
    notePath,
    vaultRoot,
  };
  let processHandle: ChildProcessWithoutNullStreams | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  let closed = false;

  await assertNoRunningObsidian();
  await assertPortFree(cdpPort);

  try {
    await forceOnlyVaultOpen(obsidianStatePath, obsidianStateBefore, vaultRoot);
    await createPluginDataBackup(pluginDataPaths[0], pluginDataBefore[0] ?? null);
    await seedCorePluginData(
      pluginDataPaths[0],
      pluginDataBefore[0],
      options.corePluginDataOverrides,
      options.preserveConfiguredLinearCredential === true,
      options.preserveConfiguredGitHubCredential === true,
    );
    for (const pluginId of pluginIds) {
      await ensureCommunityPluginEnabled(communityPluginsPath, pluginId);
    }

    processHandle = spawn(
      obsidianExe,
      [
        `--remote-debugging-port=${cdpPort}`,
        "--disable-gpu",
        "--no-first-run",
        vaultRoot,
      ],
      { windowsHide: true },
    );
    await waitForCdp(cdpPort, processHandle, 45_000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    page = await findOnlyVaultPage(browser, vaultRoot);
    await trustDisposableVaultIfPrompted(page);
    await ensurePluginRuntimesLoaded(page, pluginIds);
    setupContext.page = page;
    await withTimeout(
      options.setup(setupContext),
      60_000,
      `Native Obsidian scenario setup (${options.label})`,
    );

    const activePage = page;
    return {
      page: activePage,
      marker,
      notePath,
      noteFilePath,
      vaultRoot,
      async close() {
        if (closed) return;
        closed = true;
        let teardownError: unknown = null;
        if (options.beforeClose && !activePage.isClosed()) {
          await withTimeout(
            options.beforeClose({ ...setupContext, page: activePage }),
            5_000,
            "Native Obsidian beforeClose hook",
          ).catch(
            (error) => {
              teardownError = error;
            },
          );
        }
        await terminateObsidian(processHandle, cdpPort).catch((error) => {
          teardownError ??= error;
        });
        if (browser) {
          await withTimeout(browser.close(), 5_000, "Playwright CDP close")
            .catch(() => undefined);
        }
        await restoreOwnedE2EArtifacts(ownedArtifactsBefore).catch((error) => {
          teardownError ??= error;
        });
        await restoreOptionalText(obsidianStatePath, obsidianStateBefore).catch(
          (error) => {
            teardownError ??= error;
          },
        );
        for (const [index, pluginDataPath] of pluginDataPaths.entries()) {
          await restorePluginDataSnapshot(
            pluginDataPath,
            pluginDataBefore[index] ?? null,
          ).catch((error) => {
            teardownError ??= error;
          });
        }
        await restoreOptionalText(
          communityPluginsPath,
          communityPluginsBefore,
        ).catch((error) => {
          teardownError ??= error;
        });
        if (teardownError) throw teardownError;
      },
    };
  } catch (error) {
    if (page && options.beforeClose && !page.isClosed()) {
      await withTimeout(
        options.beforeClose({ ...setupContext, page }),
        5_000,
        "Native Obsidian failed-start beforeClose hook",
      ).catch(() => undefined);
    }
    await terminateObsidian(processHandle, cdpPort).catch(() => undefined);
    if (browser) {
      await withTimeout(browser.close(), 5_000, "Playwright failed-start CDP close")
        .catch(() => undefined);
    }
    await restoreOwnedE2EArtifacts(ownedArtifactsBefore).catch(() => undefined);
    await restoreOptionalText(obsidianStatePath, obsidianStateBefore).catch(
      () => undefined,
    );
    for (const [index, pluginDataPath] of pluginDataPaths.entries()) {
      await restorePluginDataSnapshot(
        pluginDataPath,
        pluginDataBefore[index] ?? null,
      ).catch(() => undefined);
    }
    await restoreOptionalText(
      communityPluginsPath,
      communityPluginsBefore,
    ).catch(() => undefined);
    throw error;
  }
}

export async function readOptionalText(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function restoreOptionalText(
  filePath: string,
  content: string | null,
): Promise<void> {
  if (content === null) {
    await rm(filePath, { force: true });
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

async function seedCorePluginData(
  filePath: string,
  existingContent: string | null,
  overrides: Readonly<Record<string, unknown>> = {},
  preserveConfiguredLinearCredential = false,
  preserveConfiguredGitHubCredential = false,
): Promise<void> {
  const parsed = parseObject(existingContent) ?? {};
  const preservedLinearCredentialReference =
    preserveConfiguredLinearCredential &&
    isRecord(parsed.linearCredentialReference)
      ? parsed.linearCredentialReference
      : null;
  const preservedLinearOAuthRuntimeState =
    preserveConfiguredLinearCredential &&
    isRecord(parsed.linearOAuthRuntimeState)
      ? parsed.linearOAuthRuntimeState
      : null;
  const hasPreservedLinearCredential = Boolean(
    preservedLinearCredentialReference || preservedLinearOAuthRuntimeState,
  );
  const preservedGitHubCredential =
    preserveConfiguredGitHubCredential && isRecord(parsed.githubCredential)
      ? parsed.githubCredential
      : null;
  const codeRuntimeState = overrides.repositoryProfileRegistry === undefined
    ? parsed.codeRuntimeState
    : seedCodeRuntimeRepositoryProfiles(
        parsed.codeRuntimeState,
        overrides.repositoryProfileRegistry,
      );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        ...parsed,
        ...(codeRuntimeState === undefined ? {} : { codeRuntimeState }),
        enableStreaming: false,
        thinkingMode: "off",
        model: "playwright-phase6-linear-mock",
        maxAgentSteps: 100,
        streamWritebackMode: "off",
        scheduledMissions: [],
        autoResumeOvernightRuns: false,
        linearEnabled: hasPreservedLinearCredential,
        linearCapabilityGate: 0,
        linearQueueEnabled: false,
        linearApiKey: "",
        linearCredentialReference: preservedLinearCredentialReference,
        linearOAuthRuntimeState: preservedLinearOAuthRuntimeState,
        linearCapabilitySnapshot: null,
        authorityGrants: [],
        authorityGrantUsage: {},
        authorityGrantStoreState: null,
        linearIntegrationState: null,
        linearQueueState: null,
        pendingLinearReconciliationState: null,
        queueResourceLockState: null,
        queueDailyStartBudgetState: null,
        githubApiToken: "",
        githubCredential: preservedGitHubCredential,
        conversationHistory: [],
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function seedCodeRuntimeRepositoryProfiles(
  runtimeValue: unknown,
  registryValue: unknown,
): unknown {
  const runtime = parseCodeRuntimeStateV2(runtimeValue);
  const registry = parseRepositoryProfileRegistry(registryValue);
  const repositoryProfiles = { ...runtime.repositoryProfiles };
  const now = new Date().toISOString();
  for (const [key, source] of Object.entries(registry.profiles)) {
    repositoryProfiles[key] = {
      version: 2,
      source: "migrated_repository_profile_v1",
      sourceFingerprint: fingerprintCanonicalJson(source),
      trustedAt: repositoryProfiles[key]?.trustedAt ?? now,
      profile: migrateRepositoryProfileV1(source),
    };
  }
  return parseCodeRuntimeStateV2({
    ...runtime,
    repositoryProfiles,
    updatedAt: now,
  });
}

async function ensureCommunityPluginEnabled(
  filePath: string,
  pluginId: string,
): Promise<void> {
  const existing = await readOptionalText(filePath);
  let pluginIds: string[] = [];
  if (existing?.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (Array.isArray(parsed)) {
        pluginIds = parsed.filter(
          (value): value is string => typeof value === "string",
        );
      }
    } catch {
      pluginIds = [];
    }
  }
  if (!pluginIds.includes(pluginId)) pluginIds.push(pluginId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(pluginIds, null, 2)}\n`, "utf8");
}

async function ensurePluginRuntimesLoaded(
  page: Page,
  pluginIds: readonly string[],
): Promise<void> {
  await page.evaluate(async ({ requiredPluginIds, corePluginId }) => {
    const app = (window as typeof window & { app?: any }).app;
    if (!app?.workspace || !app?.plugins) {
      throw new Error("Obsidian app services are unavailable.");
    }
    const delayInPage = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    if (typeof app.workspace.onLayoutReady === "function") {
      await new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve));
    }
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const rootReady =
        app.workspace.rootSplit?.containerEl?.isConnected ||
        Boolean(document.querySelector(".workspace-split.mod-root"));
      if (rootReady) break;
      if (attempt === 79) {
        throw new Error("Obsidian workspace layout was not ready.");
      }
      await delayInPage(250);
    }

    for (const pluginId of requiredPluginIds) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (app.plugins.manifests?.[pluginId]) break;
        if (typeof app.plugins.loadManifests === "function") {
          await app.plugins.loadManifests();
        }
        if (app.plugins.manifests?.[pluginId]) break;
        await delayInPage(250);
      }
      if (!app.plugins.manifests?.[pluginId]) {
        throw new Error(`Plugin manifest is not installed: ${pluginId}`);
      }
      let plugin = app.plugins.plugins?.[pluginId];
      let loadAttempts = 0;
      let lastLoadErrorKind: string | null = null;
      // On a cold disposable vault Obsidian can persist the enabled id before
      // its community-plugin manager has installed the runtime instance. A
      // completed enable/load call is therefore not sufficient readback.
      // Retry only the same fixed plugin id and require the runtime registry.
      for (let attempt = 0; attempt < 3 && !plugin; attempt += 1) {
        loadAttempts += 1;
        try {
          const enabled =
            app.plugins.enabledPlugins?.has?.(pluginId) ??
            app.plugins.enabledPlugins?.includes?.(pluginId) ??
            false;
          if (!enabled) {
            await app.plugins.enablePlugin(pluginId);
          }
          if (
            !app.plugins.plugins?.[pluginId] &&
            typeof app.plugins.loadPlugin === "function"
          ) {
            await app.plugins.loadPlugin(pluginId);
          }
          lastLoadErrorKind = null;
        } catch (error) {
          lastLoadErrorKind =
            error instanceof Error ? error.name : typeof error;
        }
        for (
          let readbackAttempt = 0;
          readbackAttempt < 20;
          readbackAttempt += 1
        ) {
          plugin = app.plugins.plugins?.[pluginId];
          if (plugin) break;
          await delayInPage(250);
        }
      }
      if (!plugin) {
        throw new Error(
          `Plugin did not load after enabling: ${pluginId}; ${JSON.stringify({
            manifestPresent: Boolean(app.plugins.manifests?.[pluginId]),
            enabled:
              app.plugins.enabledPlugins?.has?.(pluginId) ??
              app.plugins.enabledPlugins?.includes?.(pluginId) ??
              null,
            safeMode: app.plugins.safeMode ?? null,
            restrictedMode: app.plugins.restrictedMode ?? null,
            loadAttempts,
            lastLoadErrorKind,
          })}`,
        );
      }
      if (pluginId === corePluginId) {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const candidate = app.plugins.plugins?.[pluginId] ?? plugin;
          if (candidate?.agenticResearcherApi?.state === "ready") break;
          if (candidate?.agenticResearcherApi?.state === "unloading") {
            throw new Error(
              "Agentic Researcher core began unloading during startup.",
            );
          }
          if (attempt === 119) {
            throw new Error(
              `Agentic Researcher core did not become ready: ${JSON.stringify({
                apiState: candidate?.agenticResearcherApi?.state ?? "missing",
                startupPhase: candidate?.startupPhase ?? "missing",
                startupFailure: candidate?.startupFailure ?? "missing",
                settingsSchemaVersion:
                  candidate?.settings?.settingsSchemaVersion ?? "missing",
              })}`,
            );
          }
          await delayInPage(100);
        }
      }
    }
  }, { requiredPluginIds: [...pluginIds], corePluginId: NATIVE_CORE_PLUGIN_ID });
}

async function trustDisposableVaultIfPrompted(page: Page): Promise<void> {
  const trustVaultButton = page.getByRole("button", {
    name: "Trust author and enable plugins",
  });
  if (!(await trustVaultButton.isVisible().catch(() => false))) return;
  if (process.env.E2E_TRUST_DISPOSABLE_VAULT !== "1") {
    throw new Error(
      "Obsidian opened this vault in Restricted Mode. Set E2E_TRUST_DISPOSABLE_VAULT=1 only for a controlled disposable vault containing trusted local plugin artifacts.",
    );
  }
  await trustVaultButton.click();
  await trustVaultButton.waitFor({ state: "hidden", timeout: 30_000 });
}

async function forceOnlyVaultOpen(
  filePath: string,
  existingContent: string | null,
  targetVaultPath: string,
): Promise<void> {
  const state = parseObject(existingContent) ?? {};
  const existingVaults = isRecord(state.vaults) ? state.vaults : {};
  const normalizedTarget = normalizePath(targetVaultPath);
  let targetVaultId: string | null = null;
  const nextVaults: Record<string, Record<string, unknown>> = {};
  for (const [vaultId, rawVault] of Object.entries(existingVaults)) {
    if (!isRecord(rawVault)) continue;
    const candidatePath = typeof rawVault.path === "string" ? rawVault.path : "";
    const isTarget = normalizePath(candidatePath) === normalizedTarget;
    if (isTarget) targetVaultId = vaultId;
    nextVaults[vaultId] = { ...rawVault, open: isTarget };
  }
  targetVaultId ??= createHash("sha256")
    .update(normalizedTarget)
    .digest("hex")
    .slice(0, 16);
  nextVaults[targetVaultId] = {
    ...(nextVaults[targetVaultId] ?? {}),
    path: targetVaultPath,
    ts: Date.now(),
    open: true,
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({ ...state, vaults: nextVaults, cli: true }),
    "utf8",
  );
}

async function findOnlyVaultPage(
  browser: Browser,
  expectedVaultRoot: string,
): Promise<Page> {
  const deadline = Date.now() + 60_000;
  const expected = normalizePath(expectedVaultRoot);
  while (Date.now() < deadline) {
    const loaded: Array<{ page: Page; basePath: string }> = [];
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        const basePath = await page
          .evaluate(() => {
            const app = (window as typeof window & { app?: any }).app;
            return app?.vault?.adapter?.basePath ?? null;
          })
          .catch(() => null);
        if (typeof basePath === "string") loaded.push({ page, basePath });
      }
    }
    const unexpected = loaded.filter(
      ({ basePath }) => normalizePath(basePath) !== expected,
    );
    if (unexpected.length > 0) {
      throw new Error(
        `Obsidian opened an unexpected vault: ${unexpected
          .map(({ basePath }) => basePath)
          .join(", ")}`,
      );
    }
    const matches = loaded.filter(
      ({ basePath }) => normalizePath(basePath) === expected,
    );
    if (matches.length === 1) return matches[0].page;
    if (matches.length > 1) {
      throw new Error(
        `Obsidian opened ${matches.length} windows for ${expectedVaultRoot}.`,
      );
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Obsidian vault ${expectedVaultRoot}.`);
}

async function waitForCdp(
  port: number,
  processHandle: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(
        `Obsidian exited before CDP became available: ${processHandle.exitCode}.`,
      );
    }
    if (await cdpAvailable(port)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for Obsidian CDP on port ${port}.`);
}

async function terminateObsidian(
  processHandle: ChildProcessWithoutNullStreams | null,
  cdpPort: number,
): Promise<void> {
  if (!processHandle?.pid) return;
  await terminateControlledObsidian(processHandle, {
    terminateOwnedTree: async (pid) => {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(
        () => processHandle.kill(),
      );
    },
    waitForOwnedExit: () =>
      waitForWindowsProcessExit(processHandle.pid!, 30_000),
    waitForNoRunningProcess: () => waitForNoObsidian(30_000),
    waitForCdpClose: () => waitForCdpClose(cdpPort, 10_000),
  });
}

async function assertNoRunningObsidian(): Promise<void> {
  if (await waitForNoObsidian(8_000)) return;
  throw new Error(
    "Obsidian is already running. Close it before native desktop e2e.",
  );
}

async function waitForNoObsidian(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await obsidianRunning())) return true;
    await delay(250);
  }
  return !(await obsidianRunning());
}

async function obsidianRunning(): Promise<boolean> {
  const { stdout } = await execFileAsync("tasklist", [
    "/FI",
    "IMAGENAME eq Obsidian.exe",
    "/FO",
    "CSV",
    "/NH",
  ]);
  return /^"Obsidian\.exe"/imu.test(stdout);
}

async function assertPortFree(port: number): Promise<void> {
  if (await cdpAvailable(port)) {
    throw new Error(`OBSIDIAN_CDP_PORT ${port} is already in use.`);
  }
}

async function waitForCdpClose(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await cdpAvailable(port))) return true;
    await delay(250);
  }
  return !(await cdpAvailable(port));
}

async function cdpAvailable(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function parseObject(content: string | null): Record<string, unknown> | null {
  if (!content?.trim()) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function defaultObsidianExe(): string {
  if (!process.env.LOCALAPPDATA) {
    throw new Error("Set OBSIDIAN_EXE to the Obsidian executable path.");
  }
  return path.join(
    process.env.LOCALAPPDATA,
    "Programs",
    "Obsidian",
    "Obsidian.exe",
  );
}

function obsidianAppStatePath(): string {
  if (!process.env.APPDATA) {
    throw new Error("Set APPDATA so e2e can isolate Obsidian's vault state.");
  }
  return path.join(process.env.APPDATA, "Obsidian", "obsidian.json");
}

function defaultVaultRoot(): string {
  if (!process.env.USERPROFILE) {
    throw new Error("Set OBSIDIAN_VAULT to the live test vault path.");
  }
  return path.join(
    process.env.USERPROFILE,
    "OneDrive",
    "Desktop",
    "test_vault_obsidian_ai",
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
