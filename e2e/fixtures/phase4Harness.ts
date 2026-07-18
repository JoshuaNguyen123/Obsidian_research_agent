import { chromium, expect, type Browser, type Page } from "@playwright/test";
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
  removeNewPhase4OwnedWorkspaces,
  snapshotPhase4OwnedWorkspaces,
} from "./phase4OwnedWorkspaces";
import {
  createPluginDataBackup,
  recoverStalePluginDataBackup,
  restorePluginDataSnapshot,
} from "./pluginDataBackup";

const execFileAsync = promisify(execFile);

export const PHASE4_CORE_PLUGIN_ID = "agentic-researcher";
export const PHASE4_CODE_PLUGIN_ID = "agentic-researcher-code";
export const PHASE4_REQUIRED_CRUD_TOOLS = [
  "code_workspace_create",
  "code_workspace_status",
  "code_workspace_read",
  "code_workspace_mkdir",
  "code_workspace_create_file",
  "code_workspace_write_expected",
  "code_workspace_move",
  "code_workspace_trash",
  "code_workspace_restore",
] as const;
export const PHASE4_REQUIRED_SANDBOX_TOOLS = [
  "code_sandbox_status",
  "run_code_block",
] as const;
export const PHASE4_REQUIRED_REPAIR_TOOLS = [
  "code_workspace_create",
  "code_workspace_read",
  "code_workspace_write_expected",
  "code_repository_detect_profile",
  "code_validate_fast",
  "code_validate_targeted",
  "code_validate_full",
  "code_repair_status",
  "code_repair_record_cycle",
  "code_commit_verified",
] as const;

const DEFAULT_CDP_PORT = 11223;
const PHASE4_MISSION_STOP_TIMEOUT_MS = 10_000;

export interface Phase4ToolCatalogEntry {
  name: string;
  descriptor: Record<string, unknown> | null;
}

export interface Phase4Harness {
  page: Page;
  marker: string;
  startedAtMs: number;
  notePath: string;
  noteFilePath: string;
  vaultRoot: string;
  configureScenario(
    name:
      | "core-health"
      | "crud-stage-1"
      | "crud-stage-2"
      | "repository-create"
      | "language-create",
    data?: Record<string, unknown>,
  ): Promise<void>;
  readToolCatalog(): Promise<Phase4ToolCatalogEntry[]>;
  executeTool(
    name: string,
    args: Record<string, unknown>,
    prompt: string,
  ): Promise<any>;
  submitMissionWithApprovals(
    prompt: string,
    options?: { timeoutMs?: number },
  ): Promise<string[]>;
  runSandboxBoundaryProbe(): Promise<Record<string, unknown> | null>;
  runPublicRepairWithApprovals(
    request: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<{
    available: boolean;
    approvals: string[];
    result?: unknown;
    error?: { code: string; message: string };
  }>;
  probeTrustedQueueCodeBridge(input: Record<string, unknown>): Promise<{
    available: boolean;
    prompt?: string;
    error?: string;
  }>;
  restartUnifiedPlugin(): Promise<void>;
  setUnifiedPluginEnabled(enabled: boolean): Promise<void>;
  stopActiveMission(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export async function startPhase4Harness(label: string): Promise<Phase4Harness> {
  if (process.platform !== "win32") {
    throw new Error("Phase 4 Obsidian desktop e2e is Windows-only.");
  }
  const vaultRoot = process.env.OBSIDIAN_VAULT ?? defaultVaultRoot();
  const cdpPort = Number.parseInt(
    process.env.OBSIDIAN_CDP_PORT ?? String(DEFAULT_CDP_PORT),
    10,
  );
  const obsidianExe = process.env.OBSIDIAN_EXE ?? defaultObsidianExe();
  const obsidianStatePath = obsidianAppStatePath();
  const startedAtMs = Date.now();
  const ownedArtifactsBefore = await snapshotOwnedE2EArtifacts(vaultRoot);
  const ownedWorkspacesBefore = await snapshotPhase4OwnedWorkspaces(
    getPhase4WorkspaceRoot(),
  );
  const communityPluginsPath = path.join(vaultRoot, ".obsidian", "community-plugins.json");
  const pluginDataPaths = [PHASE4_CORE_PLUGIN_ID].map(
    (pluginId) => path.join(vaultRoot, ".obsidian", "plugins", pluginId, "data.json"),
  );
  for (const pluginDataPath of pluginDataPaths) {
    await recoverStalePluginDataBackup(pluginDataPath);
  }
  const [obsidianStateBefore, communityPluginsBefore, ...pluginDataBefore] =
    await Promise.all([
      readOptionalFile(obsidianStatePath),
      readOptionalFile(communityPluginsPath),
      ...pluginDataPaths.map(readOptionalFile),
    ]);
  const id = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const marker = `E2E_PHASE4_${id}`;
  const notePath = `E2E Agent Tests/Phase 4/${label}-${id}.md`;
  const noteFilePath = path.join(vaultRoot, ...notePath.split("/"));
  let processHandle: ChildProcessWithoutNullStreams | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  let closed = false;

  await assertNoObsidianProcess();
  await assertPortFree(cdpPort);
  try {
    await forceOnlyVaultOpen(obsidianStatePath, obsidianStateBefore, vaultRoot);
    for (const [index, pluginDataPath] of pluginDataPaths.entries()) {
      await createPluginDataBackup(pluginDataPath, pluginDataBefore[index] ?? null);
    }
    // The test owns this launch and restores the exact prior bytes on close.
    // Keep the verified capability-migration readback while clearing only the
    // host-specific sandbox binding. Core deliberately rejects an already-
    // verified capability whose migration receipt disappears.
    await writeCodeCapabilitySandboxReset(pluginDataPaths[0], pluginDataBefore[0]);
    await ensureCommunityPluginEnabled(communityPluginsPath, PHASE4_CORE_PLUGIN_ID);
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
    page = await findVaultPage(browser, vaultRoot);
    await installPhase4PageHarness(page, {
      marker,
      notePath,
      corePluginId: PHASE4_CORE_PLUGIN_ID,
      codePluginId: PHASE4_CODE_PLUGIN_ID,
    });
    await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(page.getByRole("tab", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Run Details" })).toBeVisible();
    await expect(page.locator("textarea.agentic-researcher-prompt")).toBeVisible();
    const requiredCodeTools = [
      ...PHASE4_REQUIRED_CRUD_TOOLS,
      ...PHASE4_REQUIRED_SANDBOX_TOOLS,
      ...PHASE4_REQUIRED_REPAIR_TOOLS,
    ];
    await expect
      .poll(
        async () => {
          const names = new Set((await readToolCatalog(page!)).map((entry) => entry.name));
          return requiredCodeTools.filter((name) => !names.has(name));
        },
        {
          timeout: 30_000,
          message: "The built-in Code capability did not register its production tools.",
        },
      )
      .toEqual([]);

    const activePage = page;
    const harness: Phase4Harness = {
      page: activePage,
      marker,
      startedAtMs,
      notePath,
      noteFilePath,
      vaultRoot,
      configureScenario: (name, data = {}) =>
        activePage.evaluate(
          ({ scenarioName, scenarioData }) => {
            const phase4Window = window as typeof window & {
              __phase4ConfigureScenario?: (
                scenario: string,
                input: Record<string, unknown>,
              ) => void;
            };
            if (typeof phase4Window.__phase4ConfigureScenario !== "function") {
              throw new Error("Phase 4 deterministic model configuration is unavailable.");
            }
            phase4Window.__phase4ConfigureScenario(scenarioName, scenarioData);
          },
          { scenarioName: name, scenarioData: data },
        ),
      readToolCatalog: () => readToolCatalog(activePage),
      executeTool: (name, args, prompt) =>
        executeRegisteredTool(activePage, name, args, prompt),
      submitMissionWithApprovals: (prompt, options = {}) =>
        submitMissionWithApprovals(
          activePage,
          prompt,
          options.timeoutMs ?? 180_000,
        ),
      runSandboxBoundaryProbe: () =>
        runSandboxBoundaryProbe(activePage, PHASE4_CODE_PLUGIN_ID),
      runPublicRepairWithApprovals: (request, options = {}) =>
        runPublicRepairWithApprovals(
          activePage,
          PHASE4_CODE_PLUGIN_ID,
          request,
          options.timeoutMs ?? 300_000,
        ),
      probeTrustedQueueCodeBridge: (input) =>
        probeTrustedQueueCodeBridge(activePage, PHASE4_CODE_PLUGIN_ID, input),
      restartUnifiedPlugin: () =>
        restartUnifiedPlugin(activePage, PHASE4_CORE_PLUGIN_ID, PHASE4_CODE_PLUGIN_ID),
      setUnifiedPluginEnabled: (enabled) =>
        enabled
          ? restartUnifiedPlugin(
              activePage,
              PHASE4_CORE_PLUGIN_ID,
              PHASE4_CODE_PLUGIN_ID,
            )
          : setPluginEnabled(activePage, PHASE4_CORE_PLUGIN_ID, false),
      stopActiveMission: (timeoutMs = PHASE4_MISSION_STOP_TIMEOUT_MS) =>
        stopActiveMissionForTeardown(
          activePage,
          PHASE4_CORE_PLUGIN_ID,
          timeoutMs,
        ),
      async close() {
        if (closed) return;
        closed = true;
        let teardownError: unknown = null;
        if (page && !page.isClosed()) {
          // Give the runner a bounded chance to finish its current durable
          // checkpoint before the owned Obsidian process is terminated. A
          // wedged vault write must not wedge suite teardown too.
          await stopActiveMissionForTeardown(
            page,
            PHASE4_CORE_PLUGIN_ID,
            PHASE4_MISSION_STOP_TIMEOUT_MS,
          ).catch(() => false);
        }
        try {
          await terminateObsidian(processHandle, cdpPort);
        } catch (error) {
          teardownError ??= error;
        }
        await browser?.close().catch(() => undefined);
        try {
          // Restore from the pre-launch path baseline after Obsidian exits.
          // This enumerates Agent Runs directories but reads only files that
          // were created by this harness and carry an E2E ownership marker.
          await restoreOwnedE2EArtifacts(ownedArtifactsBefore);
          await removeNewPhase4OwnedWorkspaces(ownedWorkspacesBefore, marker);
          await restoreOptionalFile(obsidianStatePath, obsidianStateBefore);
          await restoreOptionalFile(communityPluginsPath, communityPluginsBefore);
          for (let index = 0; index < pluginDataPaths.length; index += 1) {
            await restorePluginDataSnapshot(
              pluginDataPaths[index],
              pluginDataBefore[index] ?? null,
            );
          }
        } catch (error) {
          teardownError ??= error;
        }
        if (teardownError) throw teardownError;
      },
    };
    return harness;
  } catch (error) {
    await terminateObsidian(processHandle, cdpPort).catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await restoreOwnedE2EArtifacts(ownedArtifactsBefore).catch(() => undefined);
    await removeNewPhase4OwnedWorkspaces(ownedWorkspacesBefore, marker).catch(
      () => undefined,
    );
    await restoreOptionalFile(obsidianStatePath, obsidianStateBefore).catch(() => undefined);
    await restoreOptionalFile(communityPluginsPath, communityPluginsBefore).catch(
      () => undefined,
    );
    for (let index = 0; index < pluginDataPaths.length; index += 1) {
      await restorePluginDataSnapshot(
        pluginDataPaths[index],
        pluginDataBefore[index] ?? null,
      ).catch(() => undefined);
    }
    throw error;
  }
}

async function probeTrustedQueueCodeBridge(
  page: Page,
  codePluginId: string,
  input: Record<string, unknown>,
): Promise<{ available: boolean; prompt?: string; error?: string }> {
  return page.evaluate(async ({ codePluginId, input }) => {
    const app = (window as typeof window & { app?: any }).app;
    const plugin = app?.plugins?.plugins?.["agentic-researcher"]
      ?.getBundledCapability?.(codePluginId);
    if (typeof plugin?.createTrustedQueueCodeMissionPrompt !== "function") {
      return { available: false };
    }
    try {
      const prompt = await plugin.createTrustedQueueCodeMissionPrompt(input);
      return { available: true, prompt: String(prompt) };
    } catch (error) {
      return {
        available: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, { codePluginId, input });
}

async function runSandboxBoundaryProbe(
  page: Page,
  codePluginId: string,
): Promise<Record<string, unknown> | null> {
  return page.evaluate(async ({ codePluginId }) => {
    const app = (window as typeof window & { app?: any }).app;
    const plugin = app?.plugins?.plugins?.["agentic-researcher"]
      ?.getBundledCapability?.(codePluginId);
    if (typeof plugin?.probeConfiguredSandboxProviders !== "function") return null;
    const beforeProbe = plugin.readState?.()?.sandbox?.lastProbe ?? null;
    const beforeJson = JSON.stringify(beforeProbe);
    const status = await plugin.probeConfiguredSandboxProviders();
    const probe = plugin.readState?.()?.sandbox?.lastProbe ?? null;
    if (!probe || JSON.stringify(probe) === beforeJson) {
      throw new Error("Sandbox boundary probe did not persist a fresh result.");
    }
    return JSON.parse(JSON.stringify(probe ?? status));
  }, { codePluginId });
}

async function installPhase4PageHarness(
  page: Page,
  input: {
    marker: string;
    notePath: string;
    corePluginId: string;
    codePluginId: string;
  },
): Promise<void> {
  await page.evaluate(async ({ marker, notePath, corePluginId, codePluginId }) => {
    const phase4Window = window as typeof window & {
      app?: any;
      __phase4ConfigureScenario?: (
        scenario: string,
        data: Record<string, unknown>,
      ) => void;
      __phase4InstallMock?: () => void;
    };
    const app = phase4Window.app;
    if (!app?.plugins || !app?.vault || !app?.workspace) {
      throw new Error("Obsidian app APIs are unavailable.");
    }
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
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const ensurePlugin = async (pluginId: string) => {
      if (!app.plugins.plugins?.[pluginId]) {
        await app.plugins.enablePlugin(pluginId);
      }
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const plugin = app.plugins.plugins?.[pluginId];
        if (plugin) return plugin;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Plugin did not load: ${pluginId}`);
    };
    const core = await ensurePlugin(corePluginId);
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (core.getBundledCapability?.(codePluginId)) break;
      if (attempt === 159) {
        throw new Error(`Built-in capability did not load: ${codePluginId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const ensureFolder = async (folderPath: string) => {
      let current = "";
      for (const part of folderPath.split("/").filter(Boolean)) {
        current = current ? `${current}/${part}` : part;
        if (!app.vault.getAbstractFileByPath(current)) {
          try {
            await app.vault.createFolder(current);
          } catch (error) {
            if (!/already exists/iu.test(String(error))) throw error;
          }
        }
      }
    };
    await ensureFolder(notePath.split("/").slice(0, -1).join("/"));
    const existing = app.vault.getAbstractFileByPath(notePath);
    if (existing) await app.vault.delete(existing, true);
    const note = await app.vault.create(
      notePath,
      `# Phase 4 Playwright\n\nFixture ${marker}.\n`,
    );
    const markdownLeaves = app.workspace.getLeavesOfType?.("markdown") ?? [];
    const emptyLeaves = app.workspace.getLeavesOfType?.("empty") ?? [];
    const leaf = markdownLeaves[0] ?? emptyLeaves[0] ?? app.workspace.getLeaf("tab");
    await leaf.openFile(note);
    app.workspace.setActiveLeaf(leaf, { focus: true });

    const scenarioState: {
      name: string;
      data: Record<string, unknown>;
      step: number;
    } = { name: "core-health", data: {}, step: 0 };
    phase4Window.__phase4ConfigureScenario = (scenario, data) => {
      scenarioState.name = scenario;
      scenarioState.data = { ...data };
      scenarioState.step = 0;
    };
    const toolCall = (name: string, args: Record<string, unknown>) => {
      const call = {
        id: `phase4-${scenarioState.name}-${scenarioState.step}-${name}`,
        index: 0,
        name,
        arguments: args,
      };
      scenarioState.step += 1;
      return {
        message: { role: "assistant", content: "", toolCalls: [call] },
        toolCalls: [call],
        raw: { playwrightPhase4: true },
      };
    };
    const final = (content: string) => ({
      message: { role: "assistant", content },
      toolCalls: [],
      raw: { playwrightPhase4: true },
    });
    const createModelClient = () => ({
      playwrightPhase4Mock: true,
      async chat(request: {
        messages?: Array<{ role?: string; content?: string }>;
        tools?: Array<{ function?: { name?: string } }>;
        format?: unknown;
      }) {
        const text = (request.messages ?? [])
          .map((message) => message.content ?? "")
          .join("\n");
        const toolNames = new Set(
          (request.tools ?? [])
            .map((tool) => tool.function?.name)
            .filter((name): name is string => Boolean(name)),
        );
        if (request.format !== undefined) {
          return final("{}");
        }
        const required = (name: string) => {
          if (!toolNames.has(name)) {
            throw new Error(
              `Phase 4 scenario ${scenarioState.name} requires registered tool ${name}.`,
            );
          }
          return name;
        };
        const requireLatestFileSha256 = () => {
          const matches = [
            ...text.matchAll(
              /"(?:sha256|afterSha256)"\s*:\s*"(sha256:[a-f0-9]{64})"/giu,
            ),
          ];
          const latest = matches.at(-1)?.[1];
          if (!latest) {
            throw new Error(
              `Phase 4 scenario ${scenarioState.name} requires a prior file SHA-256 readback.`,
            );
          }
          return latest;
        };
        const workspaceId = String(scenarioState.data.workspaceId ?? "phase4-workspace");
        const originalPath = String(
          scenarioState.data.originalPath ?? "src/phase4-value.txt",
        );
        const movedPath = String(
          scenarioState.data.movedPath ?? "src/phase4-value-restored.txt",
        );
        const languageFiles = Array.isArray(scenarioState.data.files)
          ? scenarioState.data.files.filter(
              (entry): entry is { path: string; content: string } =>
                Boolean(entry) &&
                typeof entry === "object" &&
                typeof (entry as any).path === "string" &&
                typeof (entry as any).content === "string",
            )
          : [];
        if (scenarioState.name === "core-health") {
          return final(`PHASE4_CORE_HEALTH_OK ${marker}`);
        }
        if (scenarioState.name === "repository-create") {
          if (scenarioState.step === 0) {
            return toolCall(required("code_workspace_create"), {
              workspaceId,
              kind: "repository",
              repositoryRoot: String(scenarioState.data.repositoryRoot ?? ""),
            });
          }
          return final(
            `Created repository workspace ${workspaceId} from the trusted fixture root with a verified worktree receipt. PHASE4_REPOSITORY_WORKSPACE_READY ${marker}`,
          );
        }
        if (scenarioState.name === "language-create") {
          if (scenarioState.step === 0) {
            return toolCall(required("code_workspace_create"), {
              workspaceId,
              kind: "scratch",
            });
          }
          const file = languageFiles[0];
          if (scenarioState.step === 1 && file) {
            return toolCall(required("code_workspace_create_file"), {
              workspaceId,
              path: file.path,
              content: file.content,
            });
          }
          return final(
            `Created ${file?.path ?? "the requested source file"} in ${workspaceId} with a prepared receipt. PHASE4_LANGUAGE_FILE_DONE ${marker}`,
          );
        }
        if (scenarioState.name === "crud-stage-1") {
          switch (scenarioState.step) {
            case 0:
              return toolCall(required("code_workspace_create"), {
                workspaceId,
                kind: "scratch",
              });
            case 1:
              return toolCall(required("code_workspace_mkdir"), {
                workspaceId,
                path: "src",
              });
            case 2:
              return toolCall(required("code_workspace_create_file"), {
                workspaceId,
                path: originalPath,
                content: `before:${marker}\n`,
              });
            case 3:
              return toolCall(required("code_workspace_read"), {
                workspaceId,
                path: originalPath,
              });
            case 4:
              return toolCall(required("code_workspace_write_expected"), {
                workspaceId,
                path: originalPath,
                content: `after:${marker}\n`,
                expectedSha256: requireLatestFileSha256(),
              });
            case 5:
              return toolCall(required("code_workspace_move"), {
                workspaceId,
                path: originalPath,
                destinationPath: movedPath,
                expectedSha256: requireLatestFileSha256(),
              });
            case 6:
              return toolCall(required("code_workspace_trash"), {
                workspaceId,
                path: movedPath,
                expectedSha256: requireLatestFileSha256(),
              });
            case 7: {
              const trashId =
                /"trashId"\s*:\s*"([A-Za-z0-9._:-]+)"/u.exec(text)?.[1] ?? "";
              if (!trashId) {
                throw new Error("Phase 4 trash result did not expose a durable trashId.");
              }
              return toolCall(required("code_workspace_restore"), {
                workspaceId,
                trashId,
              });
            }
            default:
              return final(
                `Created scratch code workspace ${workspaceId}, created ${originalPath} containing before:${marker}, updated it to after:${marker} with its expected hash, moved it to ${movedPath}, trashed and restored it, and captured the mutation receipts. PHASE4_CRUD_STAGE_1_DONE ${marker}`,
              );
          }
        }
        if (scenarioState.name === "crud-stage-2") {
          switch (scenarioState.step) {
            case 0:
              return toolCall(required("code_workspace_read"), {
                workspaceId,
                path: originalPath,
              });
            case 1:
              return toolCall(required("code_workspace_write_expected"), {
                workspaceId,
                path: originalPath,
                content: `after:${marker}\n`,
                expectedSha256: requireLatestFileSha256(),
              });
            case 2:
              return toolCall(required("code_workspace_move"), {
                workspaceId,
                path: originalPath,
                destinationPath: movedPath,
                expectedSha256: requireLatestFileSha256(),
              });
            case 3:
              return toolCall(required("code_workspace_trash"), {
                workspaceId,
                path: movedPath,
                expectedSha256: requireLatestFileSha256(),
              });
            case 4: {
              const trashId =
                /"trashId"\s*:\s*"([A-Za-z0-9._:-]+)"/u.exec(text)?.[1] ?? "";
              if (!trashId) {
                throw new Error("Phase 4 trash result did not expose a durable trashId.");
              }
              return toolCall(required("code_workspace_restore"), {
                workspaceId,
                trashId,
              });
            }
            case 5:
              return toolCall(required("code_workspace_read"), {
                workspaceId,
                path: movedPath,
              });
            default:
              return final(
                `Updated ${originalPath}, moved it to ${movedPath}, trashed and restored it, then read the final bytes with verified hashes and receipts. PHASE4_CRUD_STAGE_2_DONE ${marker}`,
              );
          }
        }
        return final(`PHASE4_UNCONFIGURED_SCENARIO ${scenarioState.name}`);
      },
      async streamChat() {
        throw new Error("Phase 4 deterministic tests disable streaming.");
      },
    });
    const install = (target: any) => {
      if (!target) return;
      target.settings = {
        ...target.settings,
        enableStreaming: false,
        streamWritebackMode: "off",
        orchestratorEnabled: false,
        orchestratorPreviewEnabled: false,
        agenticReflexEnabled: false,
        semanticIndexEnabled: false,
        completionDrivenLoops: false,
        maxAgentSteps: 40,
        model: "playwright-phase4-mock",
      };
      target.saveSettings = async () => undefined;
      target.appendConversationMessage = async function (message: unknown) {
        this.conversationHistory = [...(this.conversationHistory ?? []), message];
      };
      target.createModelClient = createModelClient;
      target.__playwrightPhase4MockInstalled = true;
      const prototype = Object.getPrototypeOf(target);
      if (prototype) prototype.createModelClient = createModelClient;
    };
    phase4Window.__phase4InstallMock = () => {
      const activeCore = app.plugins.plugins?.[corePluginId];
      install(activeCore);
      for (const agentLeaf of app.workspace.getLeavesOfType?.(
        "agentic-researcher-view",
      ) ?? []) {
        install(agentLeaf.view?.plugin);
      }
    };
    phase4Window.__phase4InstallMock();
    await core.activateView?.();
    phase4Window.__phase4InstallMock();
  }, input);
}

async function runPublicRepairWithApprovals(
  page: Page,
  codePluginId: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<{
  available: boolean;
  approvals: string[];
  result?: unknown;
  error?: { code: string; message: string };
}> {
  const available = await page.evaluate(
    ({ codePluginId, request }) => {
      const phase4Window = window as typeof window & {
        app?: any;
        __phase4RepairOperation?: {
          status: "running" | "completed" | "failed";
          result?: unknown;
          error?: { code: string; message: string };
        };
      };
      const plugin = phase4Window.app?.plugins?.plugins?.["agentic-researcher"]
        ?.getBundledCapability?.(codePluginId);
      const candidates: Array<{ owner: any; method: unknown }> = [
        { owner: plugin, method: plugin?.runCodeRepair },
        { owner: plugin, method: plugin?.executeCodeRepair },
        { owner: plugin?.runtime, method: plugin?.runtime?.runCodeRepair },
        { owner: plugin?.runtime, method: plugin?.runtime?.executeCodeRepair },
        { owner: plugin?.codeRepairCoordinator, method: plugin?.codeRepairCoordinator?.execute },
      ];
      const selected = candidates.find((candidate) => typeof candidate.method === "function");
      if (!selected) return false;
      phase4Window.__phase4RepairOperation = { status: "running" };
      void Promise.resolve(
        (selected.method as (input: Record<string, unknown>) => unknown).call(
          selected.owner,
          request,
        ),
      ).then(
        (result) => {
          phase4Window.__phase4RepairOperation = { status: "completed", result };
        },
        (error) => {
          phase4Window.__phase4RepairOperation = {
            status: "failed",
            error: {
              code:
                error && typeof error === "object" && typeof error.code === "string"
                  ? error.code
                  : "repair_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          };
        },
      );
      return true;
    },
    { codePluginId, request },
  );
  if (!available) return { available: false, approvals: [] };

  const approvals: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await page.evaluate(() => {
      const phase4Window = window as typeof window & {
        __phase4RepairOperation?: {
          status: "running" | "completed" | "failed";
          result?: unknown;
          error?: { code: string; message: string };
        };
      };
      return phase4Window.__phase4RepairOperation ?? null;
    });
    if (operation?.status === "completed") {
      return { available: true, approvals, result: operation.result };
    }
    if (operation?.status === "failed") {
      return { available: true, approvals, error: operation.error };
    }
    await page.getByRole("tab", { name: "Run Details" }).click();
    const approvalCard = page
      .locator(".agentic-researcher-approval-card")
      .filter({
        has: page.locator("button.agentic-researcher-approval-approve:enabled"),
      })
      .last();
    const approve = approvalCard.locator(
      "button.agentic-researcher-approval-approve:enabled",
    );
    if (await approve.isVisible().catch(() => false)) {
      const approvalText = (await approvalCard.textContent()) ?? "";
      const approvalFingerprint = approvalText.match(
        /fingerprint=(sha256:[a-f0-9]{17})/u,
      )?.[1];
      if (!approvalFingerprint) {
        throw new Error("Prepared repair approval did not expose its fingerprint.");
      }
      const resolvedCards = page
        .locator(".agentic-researcher-approval-card")
        .filter({ hasText: approvalFingerprint })
        .filter({ hasText: "decision=approved" });
      const resolvedCountBefore = await resolvedCards.count();
      approvals.push(approvalText);
      await approve.click();
      await expect
        .poll(() => resolvedCards.count(), { timeout: 5_000 })
        .toBeGreaterThan(resolvedCountBefore);
    }
    await page.waitForTimeout(150);
  }
  throw new Error("Timed out waiting for the public Phase 4 repair operation.");
}

async function readToolCatalog(page: Page): Promise<Phase4ToolCatalogEntry[]> {
  return page.evaluate(({ corePluginId }) => {
    const app = (window as typeof window & { app?: any }).app;
    const core = app?.plugins?.plugins?.[corePluginId];
    if (!core?.createToolRegistry) throw new Error("Core tool registry is unavailable.");
    const registry = core.createToolRegistry();
    return registry.getDefinitions().map((definition: any) => {
      const name = definition.function.name;
      let descriptor: Record<string, unknown> | null = null;
      try {
        descriptor = registry.getDescriptor?.(name) ?? null;
      } catch {
        descriptor = null;
      }
      return { name, descriptor };
    });
  }, { corePluginId: PHASE4_CORE_PLUGIN_ID });
}

async function executeRegisteredTool(
  page: Page,
  name: string,
  args: Record<string, unknown>,
  prompt: string,
): Promise<any> {
  return page.evaluate(
    async ({ corePluginId, toolName, toolArgs, originalPrompt }) => {
      const app = (window as typeof window & { app?: any }).app;
      const core = app?.plugins?.plugins?.[corePluginId];
      if (!core?.createToolRegistry || !core?.createToolExecutionContext) {
        throw new Error("Core tool execution API is unavailable.");
      }
      return core.createToolRegistry().execute(
        {
          id: `phase4-direct-${toolName}-${Date.now()}`,
          name: toolName,
          arguments: toolArgs,
        },
        core.createToolExecutionContext(originalPrompt),
      );
    },
    {
      corePluginId: PHASE4_CORE_PLUGIN_ID,
      toolName: name,
      toolArgs: args,
      originalPrompt: prompt,
    },
  );
}

async function submitMissionWithApprovals(
  page: Page,
  prompt: string,
  timeoutMs: number,
): Promise<string[]> {
  await page.getByRole("tab", { name: "Chat" }).click();
  const input = page.locator("textarea.agentic-researcher-prompt");
  const runButton = page.locator("button.agentic-researcher-run");
  const dismissResume = page
    .locator(".agentic-researcher-resume-banner")
    .getByRole("button", { name: "Dismiss" });
  if (await dismissResume.isVisible().catch(() => false)) {
    await dismissResume.click();
  }
  await expect(input).toBeEnabled({ timeout: 10_000 });
  const assistantMessages = page.locator(
    ".agentic-researcher-log-assistant .agentic-researcher-log-message",
  );
  const assistantCountBefore = await assistantMessages.count();
  const runIdLine = page
    .locator(".agentic-researcher-config-line")
    .filter({ hasText: "run_id=" })
    // Run Details retains prior config rows across missions. The first row is
    // therefore stale after another Phase 4 scenario; the newest rendered row
    // is the public UI attestation for the mission just submitted.
    .last();
  const readRunId = async () => {
    const snapshotRunId = await page.evaluate(({ corePluginId }) => {
      const app = (window as typeof window & { app?: any }).app;
      const snapshot = app?.plugins?.plugins?.[corePluginId]
        ?.getMissionRunSnapshot?.();
      const runId = snapshot?.lastConfig?.runId ?? snapshot?.runId;
      return typeof runId === "string" ? runId.trim() : "";
    }, { corePluginId: PHASE4_CORE_PLUGIN_ID });
    if (snapshotRunId) return snapshotRunId;
    if ((await runIdLine.count()) === 0) return "";
    return (
      (await runIdLine.textContent({ timeout: 1_000 }).catch(() => null))
        ?.trim()
        .replace(/^run_id=/u, "") ?? ""
    );
  };
  const previousRunId = await readRunId();
  await input.fill(prompt);
  await runButton.click();
  const approvals: string[] = [];
  await expect
    .poll(readRunId, { timeout: 10_000 })
    .not.toBe(previousRunId);
  const currentRunId = await readRunId();
  let observedMissionStart = true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.getByRole("tab", { name: "Run Details" }).click();
    const approve = page
      .locator(".agentic-researcher-approval-card")
      .filter({
        has: page.locator("button.agentic-researcher-approval-approve:enabled"),
      })
      .last();
    const button = approve.locator(
      "button.agentic-researcher-approval-approve:enabled",
    );
    if (await button.isVisible().catch(() => false)) {
      const approvalText = (await approve.textContent()) ?? "";
      const approvalFingerprint = approvalText.match(
        /fingerprint=(sha256:[a-f0-9]{17})/u,
      )?.[1];
      if (!approvalFingerprint) {
        throw new Error("Prepared approval card did not expose its fingerprint.");
      }
      const resolvedCards = page
        .locator(".agentic-researcher-approval-card")
        .filter({ hasText: approvalFingerprint })
        .filter({ hasText: "decision=approved" });
      const resolvedCountBefore = await resolvedCards.count();
      approvals.push(approvalText);
      await button.click();
      await expect
        .poll(() => resolvedCards.count(), { timeout: 5_000 })
        .toBeGreaterThan(resolvedCountBefore);
      continue;
    }
    await page.getByRole("tab", { name: "Chat" }).click();
    const buttonText = (await runButton.textContent())?.trim() ?? "";
    const buttonEnabled = await runButton.isEnabled();
    if (buttonText !== "Run Mission" || !buttonEnabled) {
      observedMissionStart = true;
    }
    if ((await assistantMessages.count()) > assistantCountBefore) {
      observedMissionStart = true;
    }
    if (observedMissionStart && buttonText === "Run Mission" && buttonEnabled) {
      await page.getByRole("tab", { name: "Run Details" }).click();
      const currentRunContinuation = page
        .locator(".agentic-researcher-continuation-action")
        .filter({ hasText: currentRunId });
      if (await currentRunContinuation.isVisible().catch(() => false)) {
        const diagnostic = await page.evaluate(({ corePluginId }) => {
          const app = (window as typeof window & { app?: any }).app;
          const snapshot = app?.plugins?.plugins?.[corePluginId]
            ?.getMissionRunSnapshot?.();
          return snapshot
            ? {
                lastComplete: snapshot.lastComplete,
                providerUsage: snapshot.providerUsage,
                missionLedger: snapshot.lastMissionLedger,
                missionGraph: snapshot.lastMissionGraph
                  ? {
                      revision: snapshot.lastMissionGraph.revision,
                      routing: snapshot.lastMissionGraph.routing,
                      nodes: Object.values(
                        snapshot.lastMissionGraph.nodes ?? {},
                      ).map((node: any) => ({
                        id: node.id,
                        status: node.status,
                        attempts: node.retries?.attempts,
                        allowedTools: node.allowedTools,
                        evidenceCount: node.evidence?.length ?? 0,
                        receiptCount: node.receipts?.length ?? 0,
                      })),
                    }
                  : null,
                modelCallEvidence: (snapshot.modelCallEvidence ?? []).map(
                  (item: any) => ({
                    phase: item.phase,
                    outcome: item.outcome,
                    responseChars: item.responseChars,
                    errorCategory: item.errorCategory,
                  }),
                ),
                diagnosticAttestations: (
                  snapshot.diagnosticAttestations ?? []
                ).filter((item: any) =>
                  /mission-acceptance|terminal-acceptance|proof-gated/u.test(
                    item.id ?? "",
                  ),
                ),
              }
            : null;
        }, { corePluginId: PHASE4_CORE_PLUGIN_ID });
        throw new Error(
          `Phase 4 mission ${currentRunId} became idle but remained resumable. Diagnostic: ${JSON.stringify(diagnostic)}`,
        );
      }
      return approvals;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`Timed out waiting for Phase 4 mission: ${prompt}`);
}

async function restartUnifiedPlugin(
  page: Page,
  corePluginId: string,
  codePluginId: string,
): Promise<void> {
  await page.evaluate(async ({ corePluginId, codePluginId }) => {
    const phase4Window = window as typeof window & {
      app?: any;
      __phase4InstallMock?: () => void;
    };
    const app = phase4Window.app;
    if (!app?.plugins?.disablePlugin || !app?.plugins?.enablePlugin) {
      throw new Error("Obsidian plugin restart APIs are unavailable.");
    }
    await app.plugins.disablePlugin(corePluginId);
    await app.plugins.enablePlugin(corePluginId);
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (app.plugins.plugins?.[corePluginId]?.agenticResearcherApi?.state === "ready") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    phase4Window.__phase4InstallMock?.();
    await app.plugins.plugins?.[corePluginId]?.activateView?.();
    phase4Window.__phase4InstallMock?.();
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const core = app.plugins.plugins?.[corePluginId];
      if (
        core?.getBundledCapability?.(codePluginId) &&
        core?.getRegisteredCapabilityIds?.().includes(codePluginId)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, { corePluginId, codePluginId });
  await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
    timeout: 30_000,
  });
}

async function setPluginEnabled(
  page: Page,
  pluginId: string,
  enabled: boolean,
): Promise<void> {
  await page.evaluate(
    async ({ pluginId, enabled }) => {
      const app = (window as typeof window & { app?: any }).app;
      if (!app?.plugins) throw new Error("Obsidian plugin manager is unavailable.");
      if (enabled) await app.plugins.enablePlugin(pluginId);
      else await app.plugins.disablePlugin(pluginId);
    },
    { pluginId, enabled },
  );
}

async function stopActiveMissionForTeardown(
  page: Page,
  corePluginId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (page.isClosed()) return true;
  const readRunningState = () =>
    page.evaluate(({ corePluginId }) => {
      const core = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[
        corePluginId
      ];
      return core?.isMissionRunning?.() === true;
    }, { corePluginId });
  if (!(await readRunningState().catch(() => false))) return true;

  await page
    .evaluate(({ corePluginId }) => {
      const core = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[
        corePluginId
      ];
      core?.requestMissionStop?.();
    }, { corePluginId })
    .catch(() => undefined);

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline && !page.isClosed()) {
    if (!(await readRunningState().catch(() => false))) return true;
    await delay(100);
  }
  return page.isClosed() || !(await readRunningState().catch(() => false));
}

async function findVaultPage(browser: Browser, expectedVaultRoot: string): Promise<Page> {
  const deadline = Date.now() + 60_000;
  const normalized = normalizePath(expectedVaultRoot);
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        const basePath = await page
          .evaluate(() => {
            const app = (window as typeof window & { app?: any }).app;
            return app?.vault?.adapter?.basePath ?? null;
          })
          .catch(() => null);
        if (typeof basePath === "string" && normalizePath(basePath) === normalized) {
          return page;
        }
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Obsidian vault ${expectedVaultRoot}.`);
}

async function terminateObsidian(
  processHandle: ChildProcessWithoutNullStreams | null,
  cdpPort: number,
): Promise<void> {
  if (!processHandle?.pid) return;
  await terminateControlledObsidian(processHandle, {
    terminateOwnedTree: async (pid) => {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {
        processHandle.kill();
      });
    },
    waitForOwnedExit: () =>
      waitForWindowsProcessExit(processHandle.pid!, 30_000),
    waitForNoRunningProcess: () => waitForNoObsidian(30_000),
    waitForCdpClose: () => waitForCdpClose(cdpPort, 10_000),
  });
}

async function waitForCdp(
  port: number,
  processHandle: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Obsidian exited before CDP opened: ${processHandle.exitCode}.`);
    }
    if (await cdpAvailable(port)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for Obsidian CDP on ${port}.`);
}

async function waitForCdpClose(port: number, timeoutMs: number): Promise<boolean> {
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

async function assertPortFree(port: number): Promise<void> {
  if (await cdpAvailable(port)) {
    throw new Error(`OBSIDIAN_CDP_PORT ${port} is already in use.`);
  }
}

async function assertNoObsidianProcess(): Promise<void> {
  if (!(await waitForNoObsidian(8_000))) {
    throw new Error("Obsidian is already running; close it before Phase 4 e2e.");
  }
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

async function forceOnlyVaultOpen(
  statePath: string,
  existing: string | null,
  vaultRoot: string,
): Promise<void> {
  const state = parseObject(existing) ?? {};
  const currentVaults = isRecord(state.vaults) ? state.vaults : {};
  const normalized = normalizePath(vaultRoot);
  const vaults: Record<string, Record<string, unknown>> = {};
  let targetId: string | null = null;
  for (const [id, value] of Object.entries(currentVaults)) {
    if (!isRecord(value)) continue;
    const target = normalizePath(String(value.path ?? "")) === normalized;
    if (target) targetId = id;
    vaults[id] = { ...value, open: target };
  }
  targetId ??= createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  vaults[targetId] = { ...(vaults[targetId] ?? {}), path: vaultRoot, open: true, ts: Date.now() };
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ ...state, vaults, cli: true }), "utf8");
}

async function ensureCommunityPluginEnabled(
  filePath: string,
  pluginId: string,
): Promise<void> {
  const current = await readOptionalFile(filePath);
  let plugins: string[] = [];
  try {
    const parsed = current ? JSON.parse(current) : [];
    plugins = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    plugins = [];
  }
  if (!plugins.includes(pluginId)) plugins.push(pluginId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(plugins, null, 2)}\n`, "utf8");
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function writeCodeCapabilitySandboxReset(
  filePath: string,
  content: string | null,
): Promise<void> {
  let data: Record<string, unknown> = {};
  if (content !== null) {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("Unified plugin data.json must contain a JSON object.");
    }
    data = parsed;
  }
  const bundledData = data.bundledCapabilityData;
  const modules = isRecord(bundledData) && isRecord(bundledData.modules)
    ? bundledData.modules
    : null;
  const codeModule = modules && isRecord(modules.code) ? modules.code : null;
  const codeState = codeModule && isRecord(codeModule.state) ? codeModule.state : null;
  const runtime = codeState?.codeRuntimeState;
  if (runtime !== undefined) {
    if (!isRecord(runtime) || !isRecord(runtime.sandbox)) {
      throw new Error("Built-in Code runtime sandbox state is invalid.");
    }
    data = {
      ...data,
      bundledCapabilityData: {
        ...(isRecord(bundledData) ? bundledData : {}),
        modules: {
          ...modules,
          code: {
            ...codeModule,
            state: {
              ...codeState,
              codeRuntimeState: {
                ...runtime,
                sandbox: {
                  ...runtime.sandbox,
                  providerConfigs: [],
                  lastProbe: null,
                },
              },
            },
          },
        },
      },
    };
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function restoreOptionalFile(
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

function parseObject(content: string | null): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+$/gu, "").toLowerCase();
}

function defaultObsidianExe(): string {
  if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is unavailable.");
  return path.join(process.env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.exe");
}

function defaultVaultRoot(): string {
  if (!process.env.USERPROFILE) throw new Error("USERPROFILE is unavailable.");
  return path.join(
    process.env.USERPROFILE,
    "OneDrive",
    "Desktop",
    "test_vault_obsidian_ai",
  );
}

function getPhase4WorkspaceRoot(): string {
  if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is unavailable.");
  return path.join(
    process.env.LOCALAPPDATA,
    "AgenticResearcher",
    "code",
    "workspaces-v2",
  );
}

function obsidianAppStatePath(): string {
  if (!process.env.APPDATA) throw new Error("APPDATA is unavailable.");
  return path.join(process.env.APPDATA, "Obsidian", "obsidian.json");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
