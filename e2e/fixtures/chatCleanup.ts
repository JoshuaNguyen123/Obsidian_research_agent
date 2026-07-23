import { expect, type Page } from "@playwright/test";

/**
 * Clear persisted Chat memory only (not notes, backups, receipts, or settings).
 * Use before independent major e2e missions. Do not call mid-Continue.
 */
export async function clearChatInline(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Chat" }).click();
  const clearButton = page.locator("button.agentic-researcher-clear");
  await expect(clearButton).toHaveText("Clear chat");
  await clearButton.click();
  await expect(clearButton).toHaveText("Confirm clear");
  await expect(
    page.locator(".agentic-researcher-log").getByText(
      /Click Confirm clear to clear chat history only/i,
    ),
  ).toBeVisible({ timeout: 5_000 });
  await clearButton.click();
  await expect(clearButton).toHaveText("Clear chat");
  await expect(
    page.locator(".agentic-researcher-log").getByText(
      /Chat memory cleared\. Vault notes were not modified/i,
    ),
  ).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("textarea.agentic-researcher-prompt")).toBeFocused();
}
