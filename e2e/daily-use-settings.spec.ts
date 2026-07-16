import { expect, test } from "@playwright/test";

import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";

test.describe("daily-use settings migration", () => {
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
      await harness?.close();
    }
  });
});
