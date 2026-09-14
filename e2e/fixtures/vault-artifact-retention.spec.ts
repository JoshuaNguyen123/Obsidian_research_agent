import { expect, test } from "@playwright/test";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  beginOfflineAttempt,
  readOfflineBuildIdentity,
  saveOfflineProbe,
} from "./offlineEvidence";
import {
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./nativeObsidianHarness";

/**
 * The installed plugin must age out its own vault artifacts at startup.
 *
 * Unit tests cover the selector; what they cannot cover is that the sweep is
 * reached at all inside a real Obsidian load, reads the mtimes Obsidian
 * reports, and trashes through the vault API rather than deleting. Nothing
 * ever removed a backup before this landed, and `.agent-backups/` was a
 * quarter of this project's own test vault.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

test("installed startup ages out its own backups and keeps the recent ones", async () => {
  test.skip(
    process.env.E2E_PLAYWRIGHT_LANE !== "offline-expand" ||
      process.env.E2E_OFFLINE_AI !== "1",
    "Run through npm run test:e2e:offline so the exclusive zero-cloud policy is active.",
  );
  test.setTimeout(240_000);

  const identity = await readOfflineBuildIdentity();
  // A probe, not an application attempt: this lane drives no mission and
  // scores no scenario, so it must not add a row to the attempt summary the
  // offline gate reconciles against its required scenario list.
  const attempt = beginOfflineAttempt(identity, "vault-artifact-retention");
  attempt.observations = [];
  await saveOfflineProbe(attempt);

  const vaultRoot =
    process.env.OBSIDIAN_VAULT ??
    path.join(
      process.env.USERPROFILE ?? process.env.HOME ?? "",
      "OneDrive",
      "Desktop",
      "test_vault_obsidian_ai",
    );
  const backupsRoot = path.join(vaultRoot, ".agent-backups");
  const probe = `RetentionProbe${attempt.attemptId}`.replace(/[^A-Za-z0-9]/gu, "");

  // Seven aged copies of one note plus one written today. The policy keeps the
  // five newest copies of a note at any age and everything under 30 days old,
  // so the five survivors are today's copy and the four newest aged ones, and
  // the three oldest go.
  const aged = [] as string[];
  await mkdir(backupsRoot, { recursive: true });
  for (let index = 0; index < 7; index += 1) {
    const name = `17000000${String(index).padStart(3, "0")}-${probe}.md`;
    const filePath = path.join(backupsRoot, name);
    await writeFile(filePath, `# aged backup ${index}\n`, "utf8");
    const mtime = new Date(Date.now() - (365 - index) * DAY_MS);
    await utimes(filePath, mtime, mtime);
    aged.push(name);
  }
  const freshName = `17999999999-${probe}.md`;
  await writeFile(path.join(backupsRoot, freshName), "# fresh backup\n", "utf8");

  let harness: NativeObsidianHarness | undefined;
  try {
    harness = await startNativeObsidianHarness({
      label: "offline-vault-artifact-retention",
      corePluginDataOverrides: {
        semanticIndexEnabled: false,
        semanticSearchEnabled: false,
      },
      // The sweep is a startup behavior: nothing has to be driven in the app,
      // but the harness still wants its owned note in place before asserting.
      setup: async ({ page, notePath }) => {
        await page.evaluate(async (notePath: string) => {
          const app = (window as unknown as { app: any }).app;
          if (!app.vault.getAbstractFileByPath(notePath)) {
            await app.vault.create(notePath, "# Retention probe fixture\n");
          }
        }, notePath);
      },
    });

    // The sweep runs at workspace layout-ready; wait for the plugin to be
    // loaded and then for the two oldest copies to disappear.
    await harness.page.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { app?: { plugins?: { plugins?: Record<string, unknown> } } })
            .app?.plugins?.plugins?.["agentic-researcher"],
        ),
      undefined,
      { timeout: 120_000 },
    );

    const remaining = async (): Promise<string[]> =>
      (await readdir(backupsRoot)).filter((name) => name.includes(probe));
    await expect
      .poll(async () => (await remaining()).length, { timeout: 60_000 })
      .toBe(5);

    const survivors = await remaining();
    attempt.observations.push({
      label: "backup-retention",
      seeded: [...aged, freshName],
      survivors,
    });

    // The three oldest went; today's copy and the four newest aged ones stayed.
    for (const name of aged.slice(0, 3)) expect(survivors).not.toContain(name);
    for (const name of aged.slice(3)) expect(survivors).toContain(name);
    expect(survivors).toContain(freshName);

    // Trashed, never hard-deleted: Obsidian's own trash holds the copies.
    const trashRoot = path.join(vaultRoot, ".trash");
    const trashed = await readdir(trashRoot).catch(() => [] as string[]);
    expect(trashed.some((name) => name.includes(probe))).toBe(true);

    await saveOfflineProbe({
      ...attempt,
      status: "passed",
      failureClass: "none",
      failureDetail: "",
      artifactReadbacks: survivors.map((name) => `backup:${name}`),
    });
  } catch (error) {
    await saveOfflineProbe({
      ...attempt,
      failureClass: "product:backup_retention_not_applied",
      failureDetail: String(error).slice(0, 500),
    });
    throw error;
  } finally {
    await harness?.close();
  }
});
