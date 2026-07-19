import { expect, test, type Page } from "@playwright/test";

import {
  DAILY_USE_ACCEPTANCE_V1,
  evaluateDailyUseAcceptanceV1,
} from "../src/agent/dailyUseAcceptance";
import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";
import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";

test.describe("daily-use note creation", () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");

  test("DU-01 automatic mode creates one collision-free note when no markdown note is active", async ({}, testInfo) => {
    test.setTimeout(300_000);
    let harness: NativeObsidianHarness | null = null;
    const markerOne = `DU01_STREAM_ONE_${Date.now()}`;
    const markerTwo = `DU01_STREAM_TWO_${Date.now()}`;
    let createdPath: string | null = null;
    let seededUntitled = false;

    try {
      harness = await startNativeObsidianHarness({
        label: "du01-no-active-note",
        corePluginDataOverrides: {
          workingMode: "automatic",
          outputProfile: "active_or_new_note",
          enableStreaming: true,
          streamWritebackMode: "all_current_note_content_writes",
          model: "playwright-daily-use-note-mock",
          ollamaBaseUrl: "http://127.0.0.1:11434",
          ollamaApiKey: "",
          modelConnectionVerifiedAt: new Date().toISOString(),
          modelConnectionVerifiedProvider: "ollama",
          modelConnectionVerifiedModel: "playwright-daily-use-note-mock",
          modelConnectionVerifiedBaseUrl: "http://127.0.0.1:11434",
        },
        setup: async ({ page, marker, notePath }) => {
          await installFocusedNoteHarness(page, {
            marker,
            markerOne,
            markerTwo,
            notePath,
          });
        },
      });

      const setup = await harness.page.evaluate(async ({ originalPath }) => {
        const app = (window as typeof window & { app?: any }).app;
        if (!app?.vault || !app?.workspace) throw new Error("Obsidian app unavailable.");
        const existing = app.vault.getAbstractFileByPath("Untitled.md");
        const seeded = !existing;
        if (seeded) {
          await app.vault.create("Untitled.md", "# Existing Untitled\n\nCollision guard.\n");
        }
        for (const leaf of app.workspace.getLeavesOfType?.("markdown") ?? []) {
          await leaf.setViewState({ type: "empty", active: false });
        }
        const agentLeaf = app.workspace.getLeavesOfType?.("agentic-researcher-view")?.[0];
        if (!agentLeaf) throw new Error("Agent view is unavailable.");
        app.workspace.setActiveLeaf(agentLeaf, { focus: true });
        return {
          seeded,
          baseline: (app.vault.getMarkdownFiles?.() ?? []).map((file: any) => file.path),
          activeFile: app.workspace.getActiveFile?.()?.path ?? null,
          originalExists: Boolean(app.vault.getAbstractFileByPath(originalPath)),
        };
      }, { originalPath: harness.notePath });
      seededUntitled = setup.seeded;
      expect(setup.activeFile).toBeNull();
      expect(setup.originalExists).toBe(true);

      const prompt =
        `Create a short project brief for a neighborhood garden. Include ${markerOne} and ${markerTwo}.`;
      await submitMission(harness.page, prompt);
      await expectMockModelUsed(harness.page);

      createdPath = await harness.page.evaluate(
        async ({ baseline, first, second }) => {
          const app = (window as typeof window & { app?: any }).app;
          const before = new Set(baseline);
          for (const file of app?.vault?.getMarkdownFiles?.() ?? []) {
            if (before.has(file.path)) continue;
            const content = await app.vault.cachedRead(file);
            if (content.trim() === `${first}\n${second}`) {
              return file.path as string;
            }
          }
          return null;
        },
        { baseline: setup.baseline, first: markerOne, second: markerTwo },
      );
      expect(createdPath).toBeTruthy();
      expect(createdPath).not.toBe("Untitled.md");
      if (!createdPath) {
        throw new Error("DU-01 did not resolve the newly created note path.");
      }
      await expectReceipt(harness.page, createdPath);
      await expectDetailsText(harness.page, "receipt=note_append");
      await expectDetailsText(harness.page, "note_output");

      const reloadProof = await harness.page.evaluate(
        async ({ pluginId, targetPath, marker }) => {
          const app = (window as typeof window & { app?: any }).app;
          const fileBefore = app?.vault?.getAbstractFileByPath?.(targetPath);
          const contentBefore = fileBefore ? await app.vault.cachedRead(fileBefore) : "";
          await app?.plugins?.disablePlugin?.(pluginId);
          await app?.plugins?.enablePlugin?.(pluginId);
          const fileAfter = app?.vault?.getAbstractFileByPath?.(targetPath);
          const contentAfter = fileAfter ? await app.vault.cachedRead(fileAfter) : "";
          return {
            unchanged: contentAfter === contentBefore,
            markerCountBefore: contentBefore.split(marker).length - 1,
            markerCountAfter: contentAfter.split(marker).length - 1,
          };
        },
        {
          pluginId: NATIVE_CORE_PLUGIN_ID,
          targetPath: createdPath,
          marker: markerOne,
        },
      );
      expect(reloadProof.unchanged).toBe(true);
      expect(reloadProof.markerCountBefore).toBeGreaterThan(0);
      expect(reloadProof.markerCountAfter).toBe(reloadProof.markerCountBefore);

      const observed = {
        artifacts: ["vault:markdown_note"],
        proofs: [
          "vault:collision_free_target",
          "stream:complete",
          "receipt:vault_write",
          "restart:no_replay",
        ],
        approvals: [],
        bindings: [],
        cleanup: [],
      };
      expect(
        evaluateDailyUseAcceptanceV1(DAILY_USE_ACCEPTANCE_V1["DU-01"], observed),
      ).toEqual({ status: "pass", missing: [] });
      await recordDailyUseAcceptance(
        testInfo,
        "DU-01",
        observed,
        { modelCalls: 1, toolCalls: 1 },
        { requireComplete: true },
      );
    } finally {
      if (harness) {
        await harness.page.evaluate(async ({ createdPath, removeSeed }) => {
          const app = (window as typeof window & { app?: any }).app;
          for (const target of [createdPath, removeSeed ? "Untitled.md" : null]) {
            if (!target) continue;
            const file = app?.vault?.getAbstractFileByPath?.(target);
            if (file) await app.vault.delete(file, true);
          }
        }, { createdPath, removeSeed: seededUntitled }).catch(() => undefined);
        await harness.close();
      }
    }
  });
});

async function installFocusedNoteHarness(
  page: Page,
  input: {
    marker: string;
    markerOne: string;
    markerTwo: string;
    notePath: string;
  },
): Promise<void> {
  await page.evaluate(async ({ pluginId, marker, markerOne, markerTwo, notePath }) => {
    const app = (window as typeof window & { app?: any }).app;
    const plugin = app?.plugins?.plugins?.[pluginId];
    if (!app?.vault || !app?.workspace || !plugin) {
      throw new Error("Focused DU-01 harness could not access Obsidian services.");
    }

    const ensureFolder = async (folderPath: string) => {
      let current = "";
      for (const part of folderPath.split("/").filter(Boolean)) {
        current = current ? `${current}/${part}` : part;
        if (app.vault.getAbstractFileByPath(current)) continue;
        try {
          await app.vault.createFolder(current);
        } catch (error) {
          if (!/already exists/iu.test(String(error))) throw error;
        }
      }
    };
    await ensureFolder(notePath.split("/").slice(0, -1).join("/"));
    const existing = app.vault.getAbstractFileByPath(notePath);
    if (existing) await app.vault.delete(existing, true);
    const note = await app.vault.create(
      notePath,
      `# Daily-use note fixture\n\n${marker}\n`,
    );
    const markdownLeaves = app.workspace.getLeavesOfType?.("markdown") ?? [];
    const emptyLeaves = app.workspace.getLeavesOfType?.("empty") ?? [];
    const noteLeaf = markdownLeaves[0] ?? emptyLeaves[0] ?? app.workspace.getLeaf("tab");
    await noteLeaf.openFile(note);
    app.workspace.setActiveLeaf(noteLeaf, { focus: true });

    const response = `${markerOne}\n${markerTwo}\n`;
    const createModelClient = () => ({
      playwrightE2EMock: true,
      async chat(request: { format?: unknown }) {
        if (request.format !== undefined) {
          return {
            message: { role: "assistant", content: "{}" },
            toolCalls: [],
            raw: { focusedDailyUseNote: true },
          };
        }
        return {
          message: { role: "assistant", content: response },
          toolCalls: [],
          raw: { focusedDailyUseNote: true },
        };
      },
      async streamChat(
        _request: unknown,
        events?: { onContentDelta?: (delta: string) => void },
      ) {
        events?.onContentDelta?.(`${markerOne}\n`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        events?.onContentDelta?.(`${markerTwo}\n`);
        return {
          message: { role: "assistant", content: response },
          toolCalls: [],
          raw: { focusedDailyUseNote: true },
        };
      },
    });
    const appendConversationMessage = async function (this: any, message: unknown) {
      this.conversationHistory = [...(this.conversationHistory ?? []), message];
    };
    const saveSettings = async () => undefined;
    const install = (target: any) => {
      if (!target) return;
      target.settings = {
        ...target.settings,
        workingMode: "automatic",
        outputProfile: "active_or_new_note",
        enableStreaming: true,
        streamWritebackMode: "all_current_note_content_writes",
        thinkingMode: "off",
        model: "playwright-daily-use-note-mock",
        ollamaBaseUrl: "http://127.0.0.1:11434",
        ollamaApiKey: "",
        modelConnectionVerifiedAt:
          target.settings?.modelConnectionVerifiedAt ?? new Date().toISOString(),
        modelConnectionVerifiedProvider: "ollama",
        modelConnectionVerifiedModel: "playwright-daily-use-note-mock",
        modelConnectionVerifiedBaseUrl: "http://127.0.0.1:11434",
        orchestratorEnabled: false,
        maxAgentSteps: 20,
      };
      target.createModelClient = createModelClient;
      target.appendConversationMessage = appendConversationMessage;
      target.saveSettings = saveSettings;
      target.__playwrightE2EMockInstalled = true;
      const prototype = Object.getPrototypeOf(target);
      if (prototype) {
        prototype.createModelClient = createModelClient;
        prototype.appendConversationMessage = appendConversationMessage;
        prototype.saveSettings = saveSettings;
      }
    };
    install(plugin);

    for (const leaf of app.workspace.getLeavesOfType?.("agentic-researcher-view") ?? []) {
      await leaf.detach?.();
    }
    await plugin.activateView();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const leaves = app.workspace.getLeavesOfType?.("agentic-researcher-view") ?? [];
      if (leaves.length > 0 && document.querySelector(".agentic-researcher-view")) {
        for (const leaf of leaves) install(leaf.view?.plugin);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Focused DU-01 harness could not mount the Chat view.");
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, ...input });

  await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.locator("textarea.agentic-researcher-prompt")).toBeVisible();
}

async function submitMission(page: Page, prompt: string): Promise<void> {
  await page.getByRole("tab", { name: "Chat" }).click();
  const input = page.locator("textarea.agentic-researcher-prompt");
  const run = page.locator("button.agentic-researcher-run");
  await input.fill(prompt);
  await run.click();
  await expect(
    page.locator(".agentic-researcher-log-user .agentic-researcher-log-message", {
      hasText: prompt,
    }).last(),
  ).toBeVisible({ timeout: 5_000 });
  await expect(run).toHaveText("Run Mission", { timeout: 120_000 });
  await expect(run).toBeEnabled();
  await expect(page.locator(".agentic-researcher-run-status-text")).toHaveText("Idle");
}

async function expectMockModelUsed(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Run Details" }).click();
  await expect(
    page.locator(".agentic-researcher-details-panel", {
      hasText: "model=playwright-daily-use-note-mock",
    }),
  ).toBeVisible({ timeout: 5_000 });
}

async function expectReceipt(page: Page, text: string): Promise<void> {
  await page.getByRole("tab", { name: "Run Details" }).click();
  await expect(
    page.locator(".agentic-researcher-receipt", { hasText: text }).first(),
  ).toBeVisible({ timeout: 10_000 });
}

async function expectDetailsText(page: Page, text: string): Promise<void> {
  await page.getByRole("tab", { name: "Run Details" }).click();
  await expect(
    page.locator(".agentic-researcher-details-panel", { hasText: text }).first(),
  ).toBeVisible({ timeout: 10_000 });
}
