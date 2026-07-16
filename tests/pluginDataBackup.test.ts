import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createPluginDataBackup,
  pluginDataBackupPath,
  recoverStalePluginDataBackup,
  restorePluginDataSnapshot,
} from "../e2e/fixtures/pluginDataBackup";

test("plugin data backup recovers a hard-killed settings mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-plugin-data-backup-"));
  const dataPath = path.join(root, "data.json");
  try {
    const baseline = '{"model":"configured-primary","credential":"preserved"}\n';
    await writeFile(dataPath, baseline, "utf8");
    await createPluginDataBackup(dataPath, baseline);
    await writeFile(dataPath, '{"model":"playwright-e2e-mock"}\n', "utf8");

    await recoverStalePluginDataBackup(dataPath);

    assert.equal(await readFile(dataPath, "utf8"), baseline);
    await assert.rejects(readFile(pluginDataBackupPath(dataPath), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin data backup is removed only after an exact normal restore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-plugin-data-restore-"));
  const dataPath = path.join(root, "data.json");
  try {
    const baseline = '{"model":"configured-primary"}\n';
    await writeFile(dataPath, baseline, "utf8");
    await createPluginDataBackup(dataPath, baseline);
    await writeFile(dataPath, '{"model":"temporary"}\n', "utf8");

    await restorePluginDataSnapshot(dataPath, baseline);

    assert.equal(await readFile(dataPath, "utf8"), baseline);
    await assert.rejects(readFile(pluginDataBackupPath(dataPath), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin data recovery fails closed on a corrupt sidecar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-plugin-data-corrupt-"));
  const dataPath = path.join(root, "data.json");
  try {
    await writeFile(dataPath, '{"model":"configured-primary"}\n', "utf8");
    await writeFile(pluginDataBackupPath(dataPath), "not-json", "utf8");

    await assert.rejects(
      recoverStalePluginDataBackup(dataPath),
      /Refusing to ignore corrupt E2E plugin-data backup/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
