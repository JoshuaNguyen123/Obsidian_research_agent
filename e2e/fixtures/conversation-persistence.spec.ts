import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { clearChatInline } from "./chatCleanup";
import { beginOfflineAttempt, readOfflineBuildIdentity, saveOfflineProbe } from "./offlineEvidence";
import { startNativeObsidianHarness, type NativeObsidianHarness } from "./nativeObsidianHarness";

test("installed folder chat persistence preserves vault chat across settings saves and restarts", async () => {
  test.skip(process.env.E2E_PLAYWRIGHT_LANE !== "offline-expand" || process.env.E2E_OFFLINE_AI !== "1");
  test.setTimeout(240_000);
  const proof = beginOfflineAttempt(await readOfflineBuildIdentity(), "conversation-store-restart");
  proof.observations = [];
  await saveOfflineProbe(proof);
  let harness: NativeObsidianHarness | undefined;
  let rootNotePath = "";
  const rootMarker = `ROOT_CHAT_${proof.attemptId}`;
  const folderMarker = `FOLDER_CHAT_${proof.attemptId}`;
  const modelRequests: string[] = [];
  try {
    harness = await startNativeObsidianHarness({
      label: "offline-conversation-store",
      corePluginDataOverrides: { semanticIndexEnabled: false, semanticSearchEnabled: false },
      setup: async ({ page, notePath, marker }) => {
        rootNotePath = `E2E_CONVERSATION_${marker}.md`;
        await page.evaluate(async ({ rootNotePath, notePath }) => {
          const app = (window as any).app;
          await app.vault.create(rootNotePath, "# Owned root conversation fixture\n");
          await app.vault.create(notePath, "# Owned folder conversation fixture\n");
          await app.plugins.plugins["agentic-researcher"].activateView();
        }, { rootNotePath, notePath });
      },
    });
    const observeModelRequests = () => harness!.page.on("request", request => {
      if (/\/(?:api\/chat|v1\/chat\/completions)(?:\?|$)/u.test(request.url())) {
        modelRequests.push(new URL(request.url()).pathname);
      }
    });
    observeModelRequests();
    const openContext = async (notePath: string) => harness!.page.evaluate(async (notePath) => {
      const app = (window as any).app;
      const plugin = app.plugins.plugins["agentic-researcher"];
      await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(notePath));
      await plugin.loadProjectMemoryData({ force: true });
      plugin.activeAgentView?.refreshConversationLog();
    }, notePath);
    const appendMessage = async (content: string) => harness!.page.evaluate(async (content) => {
      const plugin = (window as any).app.plugins.plugins["agentic-researcher"];
      await plugin.appendConversationMessage({ role: "user", content });
      await plugin.saveSettings();
    }, content);
    const snapshot = async (label: string) => {
      const data = JSON.parse(await readFile(path.join(harness!.vaultRoot, ".obsidian/plugins/agentic-researcher/data.json"), "utf8"));
      const observation = {
        label,
        rootHistory: data.conversationHistory,
        // Compare opaque credential state without returning it to test logs.
        credentialStateHash: createHash("sha256").update(JSON.stringify([
          data.modelCredentialReferences, data.linearCredentialReference, data.githubCredential,
        ])).digest("hex"),
        settings: Object.fromEntries(["model", "maxAgentSteps", "maxRunMinutes", "maxLongRunSegments", "overnightRunHours", "e2eHarnessAttestationEnabled"].map(key => [key, data[key]])),
        activeHistory: await harness!.page.evaluate(() =>
          (window as any).app.plugins.plugins["agentic-researcher"].conversationHistory),
      };
      proof.observations.push(observation);
      await saveOfflineProbe(proof);
      return observation;
    };
    await openContext(rootNotePath);
    await appendMessage(rootMarker);
    const baseline = await snapshot("root-chat-saved");
    expect(baseline.rootHistory).toEqual([{ role: "user", content: rootMarker }]);
    await openContext(harness.notePath);
    await appendMessage(folderMarker);
    const folderSaved = await snapshot("folder-chat-and-settings-saved");
    expect(folderSaved.activeHistory).toEqual([{ role: "user", content: folderMarker }]);
    expect(folderSaved.rootHistory).toEqual(baseline.rootHistory);
    await clearChatInline(harness.page);
    expect((await snapshot("folder-chat-cleared")).activeHistory).toEqual([]);
    for (let restart = 1; restart <= 2; restart += 1) {
      await harness.relaunchOwnedProcess(async ({ page }) => {
        await page.evaluate(async () => (window as any).app.plugins.plugins["agentic-researcher"].activateView());
      });
      observeModelRequests();
      await openContext(rootNotePath);
      const root = await snapshot(`restart-${restart}-vault-context`);
      expect(root.activeHistory).toEqual(baseline.rootHistory);
      expect(root.rootHistory).toEqual(baseline.rootHistory);
      expect(root.settings).toEqual(baseline.settings);
      expect(root.credentialStateHash).toBe(baseline.credentialStateHash);
      await openContext(harness.notePath);
      expect((await snapshot(`restart-${restart}-folder-context`)).activeHistory).toEqual([]);
      await expect(harness.page.locator(".agentic-researcher-log")).not.toContainText(folderMarker);
    }
    await openContext(rootNotePath);
    await clearChatInline(harness.page);
    expect((await snapshot("vault-chat-cleared")).rootHistory).toEqual([]);
    expect(modelRequests).toEqual([]);
    proof.status = "passed";
    proof.failureClass = "none";
    proof.failureDetail = "";
  } catch (error) {
    proof.failureDetail = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    proof.observedModelRequestCount = modelRequests.length;
    await saveOfflineProbe(proof);
    try { await harness?.close(); }
    catch (error) {
      proof.status = "failed";
      proof.cleanupFailure = error instanceof Error ? error.message : String(error);
      await saveOfflineProbe(proof);
      throw error;
    }
  }
});
