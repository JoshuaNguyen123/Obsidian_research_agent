import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cleanupOwnedExportDirectory } from "../e2e/fixtures/desktopDelivery";

test("cleanup refuses to delete a top-level Desktop entry from the baseline", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const desktopRoot = path.join(root, "Desktop");
  const topLevelName = "existing-export";
  const exportPath = path.join(desktopRoot, topLevelName);
  const sentinelPath = path.join(exportPath, "keep.txt");
  await mkdir(exportPath, { recursive: true });
  await writeFile(sentinelPath, "preserve me", "utf8");

  await assert.rejects(
    cleanupOwnedExportDirectory({
      desktopRoot,
      exportPath,
      desktopEntriesBefore: new Set([topLevelName]),
    }),
    /Refusing to clean a pre-existing Desktop entry/u,
  );
  assert.equal(await readFile(sentinelPath, "utf8"), "preserve me");
});
