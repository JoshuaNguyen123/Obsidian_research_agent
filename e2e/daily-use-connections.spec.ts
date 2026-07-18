import { expect, test } from "@playwright/test";

import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";

test.describe("daily-use connections and setup", () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");

  test("legacy explicit chat-only and memory opt-out survive schema 4 upgrade", async () => {
    let harness: NativeObsidianHarness | null = null;
    try {
      harness = await startNativeObsidianHarness({
        label: "daily-use-settings-upgrade",
        corePluginDataOverrides: {
          settingsSchemaVersion: 3,
          // The shared vault already has schema-4 fields. Undefined removes
          // them during JSON serialization so this is a genuine schema-3 seed.
          workingMode: undefined,
          memoryMode: undefined,
          autonomyProfile: "custom",
          outputProfile: "chat_first",
          enableStreaming: false,
          streamWritebackMode: "off",
          researchMemoryEnabled: false,
          experienceMemoryEnabled: false,
          e2eUnrelatedState: {
            marker: "PRESERVE_SCHEMA4_UNRELATED_DATA",
            nested: { count: 7 },
          },
        },
        setup: async ({ page }) => {
          await page.evaluate(async (pluginId) => {
            const app = (window as typeof window & { app?: any }).app;
            if (!app?.workspace || !app?.plugins) {
              throw new Error("Obsidian app services are unavailable.");
            }
            if (typeof app.workspace.onLayoutReady === "function") {
              await new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve));
            }
            if (!app.plugins.plugins?.[pluginId]) {
              await app.plugins.enablePlugin(pluginId);
            }
          }, NATIVE_CORE_PLUGIN_ID);
          await page.waitForFunction(
            async (pluginId) => {
              const plugin = (window as typeof window & { app?: any }).app?.plugins
                ?.plugins?.[pluginId];
              if (
                plugin?.settings?.settingsSchemaVersion !== 4 ||
                plugin.settings.workingMode !== "custom" ||
                plugin.settings.memoryMode !== "off"
              ) {
                return false;
              }
              const persisted = await plugin.loadData();
              return (
                persisted?.settingsSchemaVersion === 4 &&
                persisted?.workingMode === "custom" &&
                persisted?.memoryMode === "off"
              );
            },
            NATIVE_CORE_PLUGIN_ID,
            { timeout: 30_000 },
          );
        },
      });

      const state = await harness.page.evaluate(async (pluginId) => {
        const obsidianWindow = window as typeof window & { app?: any };
        const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
        const persisted = await plugin.loadData();
        return {
          settings: {
            settingsSchemaVersion: plugin.settings.settingsSchemaVersion,
            workingMode: plugin.settings.workingMode,
            memoryMode: plugin.settings.memoryMode,
            autonomyProfile: plugin.settings.autonomyProfile,
            outputProfile: plugin.settings.outputProfile,
            enableStreaming: plugin.settings.enableStreaming,
            streamWritebackMode: plugin.settings.streamWritebackMode,
            researchMemoryEnabled: plugin.settings.researchMemoryEnabled,
            experienceMemoryEnabled: plugin.settings.experienceMemoryEnabled,
          },
          unrelated: persisted.e2eUnrelatedState,
          persistedSettings: {
            settingsSchemaVersion: persisted.settingsSchemaVersion,
            workingMode: persisted.workingMode,
            memoryMode: persisted.memoryMode,
            autonomyProfile: persisted.autonomyProfile,
            outputProfile: persisted.outputProfile,
            enableStreaming: persisted.enableStreaming,
            streamWritebackMode: persisted.streamWritebackMode,
            researchMemoryEnabled: persisted.researchMemoryEnabled,
            experienceMemoryEnabled: persisted.experienceMemoryEnabled,
          },
        };
      }, NATIVE_CORE_PLUGIN_ID);

      expect(state.settings, JSON.stringify(state.persistedSettings)).toEqual({
        settingsSchemaVersion: 4,
        workingMode: "custom",
        memoryMode: "off",
        autonomyProfile: "custom",
        outputProfile: "chat_first",
        enableStreaming: false,
        streamWritebackMode: "off",
        researchMemoryEnabled: false,
        experienceMemoryEnabled: false,
      });
      expect(state.unrelated).toEqual({
        marker: "PRESERVE_SCHEMA4_UNRELATED_DATA",
        nested: { count: 7 },
      });

      await harness.page.evaluate(async (pluginId) => {
        const obsidianWindow = window as typeof window & { app?: any };
        obsidianWindow.app.setting.open();
        await obsidianWindow.app.setting.openTabById(pluginId);
      }, NATIVE_CORE_PLUGIN_ID);
      const settings = harness.page.locator(".agentic-researcher-settings");
      await expect(settings.locator("#agentic-settings-essentials")).toBeVisible();
      await expect(
        settings.locator(".agentic-settings-basic select").nth(1),
      ).toHaveValue("custom");
      await expect(
        settings.locator(".agentic-settings-basic select").nth(2),
      ).toHaveValue("off");
    } finally {
      if (harness) {
        await closeObsidianSettings(harness.page).catch(() => undefined);
      }
      await harness?.close();
    }
  });

  test("first-run model setup returns to Chat and removes the empty state only after a successful probe", async () => {
    let harness: NativeObsidianHarness | null = null;
    try {
      harness = await startNativeObsidianHarness({
        label: "daily-use-first-run-connection",
        corePluginDataOverrides: {
          modelConnectionVerifiedAt: undefined,
          modelConnectionVerifiedProvider: undefined,
          modelConnectionVerifiedModel: undefined,
          modelConnectionVerifiedBaseUrl: undefined,
        },
        setup: setupDailyUsePage,
      });
      const page = harness.page;
      const emptyState = page.getByTestId("first-run-model-setup");
      await expect(emptyState).toBeVisible();
      await expect(emptyState).toContainText("Connect a model to start");
      const prompt = page.locator("textarea.agentic-researcher-prompt");
      const preservedPrompt = `Preserve this setup prompt ${harness.marker}`;
      await prompt.fill(preservedPrompt);

      await closeObsidianSettings(page);
      await emptyState.getByRole("button", { name: "Connect model" }).click();
      const settings = page.locator(".agentic-researcher-settings");
      await expect(settings.locator("#agentic-settings-essentials")).toBeVisible();
      await page.evaluate((pluginId) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
        (window as typeof window & { __e2eConnectionShouldFail?: boolean })
          .__e2eConnectionShouldFail = true;
        plugin.createModelClient = () => ({
          descriptor: {
            provider: plugin.settings.modelProvider,
            model: plugin.settings.model,
            transportKind: "production",
          },
          async chat() {
            if (
              (window as typeof window & { __e2eConnectionShouldFail?: boolean })
                .__e2eConnectionShouldFail
            ) {
              throw new Error("bounded E2E connection failure");
            }
            return {
              message: { role: "assistant", content: "ok" },
              toolCalls: [],
            };
          },
          async streamChat() {
            throw new Error("Connection probe must not use streaming.");
          },
        });
      }, NATIVE_CORE_PLUGIN_ID);

      let connection = settings.locator(".agentic-settings-model-connection");
      await connection.getByRole("button", { name: "Test connection" }).click();
      connection = page.locator(".agentic-settings-model-connection");
      await expect(connection).toContainText(
        "Connection failed: bounded E2E connection failure",
        { timeout: 10_000 },
      );
      await expect(emptyState).not.toHaveClass(/is-hidden/u);

      await page.evaluate(() => {
        (window as typeof window & { __e2eConnectionShouldFail?: boolean })
          .__e2eConnectionShouldFail = false;
      });
      await connection.getByRole("button", { name: "Test connection" }).click();
      await expect(settings).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(emptyState).toBeHidden();
      await expect(prompt).toHaveValue(preservedPrompt);
      const status = await page.evaluate((pluginId) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        return {
          live: plugin?.getModelConnectionStatus?.() ?? null,
          readiness: plugin?.getCapabilityReadiness?.() ?? [],
        };
      }, NATIVE_CORE_PLUGIN_ID);
      expect(status.live?.status).toBe("ready");
      expect(status.readiness).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            version: 2,
            id: "model",
            status: "Ready",
            evidenceAt: expect.any(String),
            nextAction: "Review model setup",
          }),
        ]),
      );
    } finally {
      await harness?.page.evaluate(() => {
        delete (window as typeof window & { __e2eConnectionShouldFail?: boolean })
          .__e2eConnectionShouldFail;
      }).catch(() => undefined);
      if (harness) {
        await closeObsidianSettings(harness.page).catch(() => undefined);
      }
      await harness?.close();
    }
  });

  test("setup and resume preserves the exact continuation command across the settings hop", async () => {
    let harness: NativeObsidianHarness | null = null;
    let ledgerPath = "";
    try {
      harness = await startNativeObsidianHarness({
        label: "daily-use-capability-resume",
        setup: setupDailyUsePage,
      });
      const runId = `run-e2e-capability-${Date.now()}`;
      const continuationCommand = `continue run ${runId}`;
      ledgerPath = `Agent Runs/${runId}.md`;
      await harness.page.evaluate(
        async ({ runId, continuationCommand, ledgerPath }) => {
          const app = (window as typeof window & { app?: any }).app;
          if (!app.vault.getAbstractFileByPath("Agent Runs")) {
            await app.vault.createFolder("Agent Runs");
          }
          const now = new Date().toISOString();
          const ledger = {
            runId,
            mission: "Resume this exact blocked model setup mission.",
            route: "grounded_workflow",
            createdAt: now,
            updatedAt: now,
            status: "blocked",
            loopBudget: {
              hardCap: 30,
              toolStepBudget: 20,
              finalizationReserve: 4,
              expectedTools: [],
            },
            milestones: [],
            evidence: [],
            receipts: [],
            blockers: ["Cloud model API key is missing."],
            blockerCategory: "provider_auth",
            nextActions: ["Connect the configured model provider."],
            remainingActions: ["Create the research note."],
            continuationCommand,
            resumeCount: 0,
            lastSafeStep: 0,
          };
          await app.vault.create(
            ledgerPath,
            `# Agent Run ${runId}\n\n## Mission Ledger\n\`\`\`json\n${JSON.stringify(ledger, null, 2)}\n\`\`\`\n`,
          );
          const view = app.workspace.getLeavesOfType("agentic-researcher-view")[0]
            ?.view;
          await view.renderStartupResumeBanner();
        },
        { runId, continuationCommand, ledgerPath },
      );

      const banner = harness.page.locator(".agentic-researcher-resume-banner");
      await expect(banner).toContainText("Cloud model API key is missing.");
      await closeObsidianSettings(harness.page);
      await banner.getByRole("button", { name: "Set up & resume" }).click();
      const pending = harness.page.locator(".agentic-settings-pending-resume");
      await expect(pending).toContainText("Set up Model");
      await harness.page.evaluate(() => {
        const app = (window as typeof window & { app?: any }).app;
        const view = app.workspace.getLeavesOfType("agentic-researcher-view")[0]
          ?.view;
        view.submitMissionContinuation = async (command: string) => {
          (window as typeof window & { __e2eResumeCommand?: string })
            .__e2eResumeCommand = command;
        };
      });
      await pending.getByRole("button", { name: "Resume blocked mission" }).click();
      await expect
        .poll(() =>
          harness!.page.evaluate(() =>
            (window as typeof window & { __e2eResumeCommand?: string })
              .__e2eResumeCommand ?? "",
          ),
        )
        .toBe(continuationCommand);
      const pendingState = await harness.page.evaluate((pluginId) =>
        (window as typeof window & { app?: any }).app?.plugins?.plugins?.[
          pluginId
        ]?.getPendingCapabilityResume?.() ?? null,
      NATIVE_CORE_PLUGIN_ID);
      expect(pendingState).toBeNull();
    } finally {
      if (harness && ledgerPath) {
        await harness.page.evaluate(async (target) => {
          const app = (window as typeof window & { app?: any }).app;
          const file = app?.vault?.getAbstractFileByPath?.(target);
          if (file) await app.vault.delete(file, true);
          delete (window as typeof window & { __e2eResumeCommand?: string })
            .__e2eResumeCommand;
        }, ledgerPath).catch(() => undefined);
      }
      if (harness) {
        await closeObsidianSettings(harness.page).catch(() => undefined);
      }
      await harness?.close();
    }
  });
});

async function setupDailyUsePage(context: { page: NativeObsidianHarness["page"] }) {
  await context.page.evaluate(async (pluginId) => {
    const app = (window as typeof window & { app?: any }).app;
    if (!app?.plugins?.plugins?.[pluginId]) {
      throw new Error("Agentic Researcher plugin is unavailable.");
    }
    const plugin = app?.plugins?.plugins?.[pluginId];
    if (!plugin?.activateView) {
      throw new Error("Agentic Researcher view activation is unavailable.");
    }
    await plugin.activateView();
  }, NATIVE_CORE_PLUGIN_ID);
  // Obsidian can restore a settings modal from the preceding desktop run.
  // Close it after activating the daily-use panel and wait for its animated
  // teardown so it cannot intercept first-run connection controls.
  await closeObsidianSettings(context.page);
  await context.page.waitForFunction(
    () => {
      return Boolean(document.querySelector(".agentic-researcher-view"));
    },
    undefined,
    { timeout: 30_000 },
  );
}

async function closeObsidianSettings(page: NativeObsidianHarness["page"]) {
  await page.evaluate(() => {
    (window as typeof window & { app?: any }).app?.setting?.close?.();
  });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>(".modal.mod-settings"))
        .every((modal) => {
          const style = getComputedStyle(modal);
          return (
            style.display === "none" ||
            style.visibility === "hidden" ||
            modal.getClientRects().length === 0
          );
        }),
    undefined,
    { timeout: 5_000 },
  );
}
