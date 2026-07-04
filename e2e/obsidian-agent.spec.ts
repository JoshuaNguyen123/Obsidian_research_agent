import { expect, test, chromium, type Browser, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PLUGIN_ID = "agentic-researcher";
const DEFAULT_CDP_PORT = 11223;

const obsidianExe = process.env.OBSIDIAN_EXE ?? getDefaultObsidianExe();
const vaultRoot = process.env.OBSIDIAN_VAULT ?? getDefaultVaultRoot();
const cdpPort = Number.parseInt(
  process.env.OBSIDIAN_CDP_PORT ?? String(DEFAULT_CDP_PORT),
  10,
);
const pluginDataPath = path.join(
  vaultRoot,
  ".obsidian",
  "plugins",
  PLUGIN_ID,
  "data.json",
);
const communityPluginsPath = path.join(vaultRoot, ".obsidian", "community-plugins.json");

test.describe.configure({ mode: "serial" });

test("runs an append mission in the live Obsidian vault", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e is Windows-only.");

  if (!Number.isInteger(cdpPort) || cdpPort <= 0) {
    throw new Error(`Invalid OBSIDIAN_CDP_PORT: ${String(process.env.OBSIDIAN_CDP_PORT)}`);
  }

  const dataBefore = await readOptionalFile(pluginDataPath);
  const communityPluginsBefore = await readOptionalFile(communityPluginsPath);
  const notePath = `E2E Agent Tests/playwright-${Date.now()}.md`;
  const noteFilePath = path.join(vaultRoot, ...notePath.split("/"));
  const marker = `E2E_MARKER_${Date.now()}`;
  const prompt = `Append this exact E2E marker to the current note: ${marker}`;
  let browser: Browser | null = null;
  let obsidianProcess: ChildProcessWithoutNullStreams | null = null;

  await expectPortFree(cdpPort);

  try {
    await expectNoRunningObsidian();
    await ensureCommunityPluginEnabled(communityPluginsPath, PLUGIN_ID);
    obsidianProcess = await launchObsidian();
    await waitForCdp(cdpPort, obsidianProcess, 45_000);
    await openVaultViaProtocol(vaultRoot);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await getObsidianVaultPage(browser, vaultRoot);

    const setupResult = await setupVaultNoteAndMockModel(page, {
      marker,
      notePath,
    });
    expect(setupResult.activeFilePath).toBe(notePath);
    expect(setupResult.pluginId).toBe(PLUGIN_ID);

    const view = page.locator(".agentic-researcher-view");
    await expect(view).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tab", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Run Details" })).toBeVisible();

    const promptInput = page.locator("textarea.agentic-researcher-prompt");
    await expect(promptInput).toBeVisible();
    await promptInput.fill(prompt);

    await expect(page.getByRole("button", { name: "Run Mission" })).toBeVisible();
    const runButton = page.locator("button.agentic-researcher-run");
    await runButton.click();

    await expect(runButton).toHaveText("Stop Mission", { timeout: 5_000 });
    await expect(runButton).toBeEnabled();
    await expect(runButton).toHaveText("Run Mission", { timeout: 45_000 });
    await expect(runButton).toBeEnabled();
    await expect(page.locator(".agentic-researcher-run-status-text")).toHaveText(
      "Idle",
    );

    await expect
      .poll(async () => readFile(noteFilePath, "utf8"), {
        message: "seeded e2e note should contain the appended marker",
        timeout: 15_000,
      })
      .toContain(marker);

    await page.getByRole("tab", { name: "Run Details" }).click();
    await expect(
      page.locator(".agentic-researcher-tool-item", {
        hasText: "append_to_current_file",
      }),
    ).toBeVisible();
    await expect(
      page.locator(".agentic-researcher-receipt", { hasText: "append" }),
    ).toBeVisible();
    await expect(
      page.locator(".agentic-researcher-receipt", { hasText: notePath }),
    ).toBeVisible();
    await expect(page.locator(".agentic-researcher-trace-row").first()).toBeVisible();

    const dataAfter = await readOptionalFile(pluginDataPath);
    expect(dataAfter).toBe(dataBefore);
  } finally {
    await browser?.close().catch(() => undefined);
    await terminateObsidian(obsidianProcess);
    await restoreOptionalFile(communityPluginsPath, communityPluginsBefore);
  }
});

async function setupVaultNoteAndMockModel(
  page: Page,
  input: { marker: string; notePath: string },
): Promise<{ activeFilePath: string; pluginId: string }> {
  return page.evaluate(async ({ marker, notePath, pluginId }) => {
    const obsidianWindow = window as typeof window & { app?: any };
    const app = obsidianWindow.app;
    if (!app?.vault || !app?.workspace || !app?.plugins) {
      throw new Error("Obsidian app API is unavailable.");
    }

    const plugin = await ensurePluginLoaded(app, pluginId);

    const folderPath = "E2E Agent Tests";
    if (!app.vault.getAbstractFileByPath(folderPath)) {
      try {
        await app.vault.createFolder(folderPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists/i.test(message)) {
          throw error;
        }
      }
    }

    const seedContent = `# Playwright Agent E2E\n\nSeed note for ${marker}.\n\n`;
    let file = app.vault.getAbstractFileByPath(notePath);
    if (file) {
      await app.vault.modify(file, seedContent);
    } else {
      file = await app.vault.create(notePath, seedContent);
    }

    await waitForWorkspaceReady(app);
    const markdownLeaves =
      typeof app.workspace.getLeavesOfType === "function"
        ? app.workspace.getLeavesOfType("markdown")
        : [];
    const noteLeaf = markdownLeaves[0] ?? app.workspace.getLeaf("tab");
    await noteLeaf.openFile(file);
    app.workspace.setActiveLeaf(noteLeaf, { focus: true });

    plugin.settings = {
      ...plugin.settings,
      enableStreaming: false,
      thinkingMode: "off",
      model: "playwright-e2e-mock",
      streamWritebackMode: "off",
    };
    plugin.conversationHistory = [];
    plugin.appendConversationMessage = async function appendConversationMessage(
      message: { role: string; content: string },
    ) {
      this.conversationHistory = [...this.conversationHistory, message];
    };
    plugin.clearConversationHistory = async function clearConversationHistory() {
      this.conversationHistory = [];
    };
    plugin.saveSettings = async function saveSettings() {
      return undefined;
    };
    plugin.createModelClient = function createModelClient() {
      return {
        async chat(request: { tools?: Array<{ function?: { name?: string } }> }) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const toolNames =
            request.tools?.map((tool) => tool.function?.name).filter(Boolean) ?? [];
          if (!toolNames.includes("append_to_current_file")) {
            throw new Error(
              `append_to_current_file was not available. Tools: ${toolNames.join(", ")}`,
            );
          }

          const toolCall = {
            id: "playwright-e2e-append",
            index: 0,
            name: "append_to_current_file",
            arguments: { text: marker },
          };

          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [toolCall],
            },
            toolCalls: [toolCall],
            raw: { playwrightE2E: true },
          };
        },
        async streamChat() {
          throw new Error("streamChat should not be called in this e2e test.");
        },
      };
    };

    await plugin.activateView();

    return {
      activeFilePath: app.workspace.getActiveFile()?.path ?? "",
      pluginId,
    };

    async function ensurePluginLoaded(app: any, pluginId: string) {
      let plugin = app.plugins.plugins[pluginId];
      if (plugin) {
        return plugin;
      }

      if (
        !app.plugins.manifests?.[pluginId] &&
        typeof app.plugins.loadManifests === "function"
      ) {
        await app.plugins.loadManifests();
      }

      if (!app.plugins.manifests?.[pluginId]) {
        throw new Error(`Plugin manifest is not installed: ${pluginId}`);
      }

      if (typeof app.plugins.enablePlugin === "function") {
        await app.plugins.enablePlugin(pluginId);
      } else if (typeof app.plugins.loadPlugin === "function") {
        await app.plugins.loadPlugin(pluginId);
      } else {
        throw new Error("Obsidian plugin loader API is unavailable.");
      }

      for (let attempt = 0; attempt < 40; attempt += 1) {
        plugin = app.plugins.plugins[pluginId];
        if (plugin) {
          return plugin;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      throw new Error(`Plugin did not load after enabling: ${pluginId}`);
    }

    async function waitForWorkspaceReady(app: any) {
      if (typeof app.workspace.onLayoutReady === "function") {
        await new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve));
      }

      for (let attempt = 0; attempt < 80; attempt += 1) {
        const rootSplit = app.workspace.rootSplit;
        const rootReady =
          rootSplit?.containerEl?.isConnected ||
          Boolean(document.querySelector(".workspace-split.mod-root"));
        if (rootReady) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      throw new Error("Obsidian workspace layout was not ready.");
    }
  }, { ...input, pluginId: PLUGIN_ID });
}

async function launchObsidian(): Promise<ChildProcessWithoutNullStreams> {
  const process = spawn(
    obsidianExe,
    [
      `--remote-debugging-port=${cdpPort}`,
      "--disable-gpu",
      "--no-first-run",
      vaultRoot,
    ],
    {
      windowsHide: true,
    },
  );

  process.on("error", (error) => {
    throw error;
  });

  return process;
}

async function getObsidianVaultPage(
  browser: Browser,
  expectedVaultPath: string,
): Promise<Page> {
  const deadline = Date.now() + 60_000;
  const expectedVault = normalizeVaultPath(expectedVaultPath);
  let sawObsidianApp = false;

  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed()) {
          continue;
        }

        const state = await page
          .evaluate(() => {
            const obsidianWindow = window as typeof window & { app?: any };
            const app = obsidianWindow.app;
            const basePath = app?.vault?.adapter?.basePath;

            return {
              hasApp: Boolean(app),
              basePath: typeof basePath === "string" ? basePath : null,
            };
          })
          .catch(() => null);

        if (!state) {
          continue;
        }

        sawObsidianApp = sawObsidianApp || state.hasApp;
        if (
          state.basePath &&
          normalizeVaultPath(state.basePath) === expectedVault
        ) {
          return page;
        }
      }
    }

    await sleep(250);
  }

  throw new Error(
    sawObsidianApp
      ? `Timed out waiting for Obsidian to load vault: ${expectedVaultPath}`
      : "Timed out waiting for the Obsidian renderer page.",
  );
}

function normalizeVaultPath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function getDefaultObsidianExe() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("Set OBSIDIAN_EXE to the Obsidian executable path.");
  }

  return path.join(localAppData, "Programs", "Obsidian", "Obsidian.exe");
}

function getDefaultVaultRoot() {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) {
    throw new Error("Set OBSIDIAN_VAULT to the live test vault path.");
  }

  return path.join(userProfile, "OneDrive", "Desktop", "test_vault_obsidian_ai");
}

async function expectNoRunningObsidian() {
  const { stdout } = await execFileAsync("tasklist", [
    "/FI",
    "IMAGENAME eq Obsidian.exe",
    "/FO",
    "CSV",
    "/NH",
  ]);

  if (/^"Obsidian\.exe"/im.test(stdout)) {
    throw new Error(
      "Obsidian is already running. Close Obsidian before npm run test:e2e so the harness can launch a controlled instance.",
    );
  }
}

async function expectPortFree(port: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (response.ok) {
      throw new Error(
        `OBSIDIAN_CDP_PORT ${port} is already serving a CDP endpoint. Pick another port.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already serving")) {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForCdp(
  port: number,
  process: ChildProcessWithoutNullStreams,
  timeoutMs: number,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`Obsidian exited before CDP became available: ${process.exitCode}`);
    }

    const ok = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) {
      return;
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for Obsidian CDP on port ${port}.`);
}

async function openVaultViaProtocol(vaultPath: string) {
  const uri = `obsidian://open?path=${encodeURIComponent(vaultPath)}`;
  await execFileAsync("cmd.exe", ["/c", "start", "", uri]);
}

async function terminateObsidian(
  process: ChildProcessWithoutNullStreams | null,
) {
  if (!process?.pid || process.exitCode !== null) {
    return;
  }

  await execFileAsync("taskkill", ["/PID", String(process.pid), "/T", "/F"]).catch(
    () => {
      process.kill();
    },
  );
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  });
}

async function restoreOptionalFile(filePath: string, content: string | null) {
  if (content === null) {
    await rm(filePath, { force: true });
    return;
  }

  await writeFile(filePath, content, "utf8");
}

async function ensureCommunityPluginEnabled(filePath: string, pluginId: string) {
  const existing = await readOptionalFile(filePath);
  let pluginIds: string[] = [];

  if (existing?.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (Array.isArray(parsed)) {
        pluginIds = parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      pluginIds = [];
    }
  }

  if (!pluginIds.includes(pluginId)) {
    pluginIds = [...pluginIds, pluginId];
  }

  await writeFile(filePath, `${JSON.stringify(pluginIds, null, 2)}\n`, "utf8");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
