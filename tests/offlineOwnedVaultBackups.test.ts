import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inventoryRootLevelVaultBackupPaths,
  MAX_OFFLINE_OWNED_VAULT_BACKUPS,
  quarantinePostBaselineOwnedVaultBackups,
} from "../e2e/fixtures/offlineOwnedVaultBackups";

const NOTE_PATH = "E2E Agent Tests/BYOK-OFFLINE-84d74608f747.md";
const BASENAME = "BYOK-OFFLINE-84d74608f747";
const OLD_BACKUP =
  `.agent-backups/${BASENAME}.2026-07-28T12-00-00-000Z.aaaaaaaaaaaa.backup.md`;
const NEW_BACKUP =
  `.agent-backups/${BASENAME}.2026-07-28T13-58-58-535Z.e18a99dce669.backup.md`;
const COLLISION_BACKUP =
  `.agent-backups/${BASENAME}.2026-07-28T13-58-58-535Z.e18a99dce669.1.backup.md`;
const OTHER_BACKUP =
  ".agent-backups/Other-note.2026-07-28T13-58-58-535Z.bbbbbbbbbbbb.backup.md";

test("offline quarantine moves only exact post-baseline root backups and proves absence", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "offline-owned-backups-"),
  );
  const vaultRoot = path.join(fixtureRoot, "vault");
  const backupRoot = path.join(vaultRoot, ".agent-backups");
  const quarantineRoot = path.join(fixtureRoot, "quarantine");
  try {
    await mkdir(path.join(backupRoot, "nested"), { recursive: true });
    await writeVaultBackup(vaultRoot, OLD_BACKUP, "old");
    await writeVaultBackup(vaultRoot, OTHER_BACKUP, "other-before");
    const baselinePaths =
      await inventoryRootLevelVaultBackupPaths(vaultRoot);

    await writeVaultBackup(vaultRoot, NEW_BACKUP, "new");
    await writeVaultBackup(vaultRoot, COLLISION_BACKUP, "collision");
    await writeVaultBackup(
      vaultRoot,
      ".agent-backups/Concurrent-note.2026-07-28T13-59-00-000Z.cccccccccccc.backup.md",
      "concurrent",
    );
    await writeFile(
      path.join(
        backupRoot,
        "nested",
        path.posix.basename(NEW_BACKUP),
      ),
      "nested-owned-looking",
      "utf8",
    );

    const proof = await quarantinePostBaselineOwnedVaultBackups({
      vaultRoot,
      notePath: NOTE_PATH,
      baselinePaths,
      quarantineRoot,
    });

    const selectedPaths = [COLLISION_BACKUP, NEW_BACKUP].sort();
    const canonicalQuarantine = await realpath(quarantineRoot);
    assert.deepEqual(proof.selectedPaths, selectedPaths);
    assert.deepEqual(
      proof.quarantinedPaths,
      selectedPaths.map((relative) =>
        path.join(canonicalQuarantine, path.posix.basename(relative)),
      ),
    );
    assert.deepEqual(proof.survivors, []);
    assert.deepEqual(proof.readback.survivors, []);
    assert.equal(proof.absenceVerified, true);
    assert.equal(proof.readback.absenceVerified, true);

    await assert.rejects(
      lstat(path.join(vaultRoot, ...NEW_BACKUP.split("/"))),
      /ENOENT/u,
    );
    await assert.rejects(
      lstat(path.join(vaultRoot, ...COLLISION_BACKUP.split("/"))),
      /ENOENT/u,
    );
    assert.equal(
      await readFile(
        path.join(canonicalQuarantine, path.posix.basename(NEW_BACKUP)),
        "utf8",
      ),
      "new",
    );
    assert.equal(await readVaultBackup(vaultRoot, OLD_BACKUP), "old");
    assert.equal(await readVaultBackup(vaultRoot, OTHER_BACKUP), "other-before");
    assert.equal(
      await readFile(
        path.join(backupRoot, "nested", path.posix.basename(NEW_BACKUP)),
        "utf8",
      ),
      "nested-owned-looking",
    );
    assert.equal(
      (await inventoryRootLevelVaultBackupPaths(vaultRoot)).some((relative) =>
        relative.includes("/nested/"),
      ),
      false,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("offline quarantine refuses an existing destination without moving its source", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "offline-owned-overwrite-"),
  );
  const vaultRoot = path.join(fixtureRoot, "vault");
  const quarantineRoot = path.join(fixtureRoot, "quarantine");
  try {
    await mkdir(path.join(vaultRoot, ".agent-backups"), { recursive: true });
    await mkdir(quarantineRoot);
    await writeVaultBackup(vaultRoot, NEW_BACKUP, "source");
    const destination = path.join(
      quarantineRoot,
      path.posix.basename(NEW_BACKUP),
    );
    await writeFile(destination, "existing", "utf8");

    await assert.rejects(
      quarantinePostBaselineOwnedVaultBackups({
        vaultRoot,
        notePath: NOTE_PATH,
        baselinePaths: [],
        quarantineRoot,
      }),
      /existing destination|overwrite/u,
    );

    assert.equal(await readVaultBackup(vaultRoot, NEW_BACKUP), "source");
    assert.equal(await readFile(destination, "utf8"), "existing");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("offline quarantine rejects a linked backup root when supported", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "offline-owned-root-link-"),
  );
  const outsideRoot = await mkdtemp(
    path.join(os.tmpdir(), "offline-owned-root-outside-"),
  );
  const vaultRoot = path.join(fixtureRoot, "vault");
  const backupRoot = path.join(vaultRoot, ".agent-backups");
  let linked = false;
  try {
    await mkdir(vaultRoot, { recursive: true });
    try {
      await symlink(
        outsideRoot,
        backupRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      linked = true;
    } catch (error) {
      if (!isUnavailableSymlinkError(error)) throw error;
      t.skip("This filesystem does not permit directory symlink creation.");
      return;
    }

    await assert.rejects(
      inventoryRootLevelVaultBackupPaths(vaultRoot),
      /real non-linked|linked/u,
    );
  } finally {
    if (linked) {
      await unlink(backupRoot).catch(() => undefined);
    }
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("offline quarantine rejects a quarantine root inside the vault", async () => {
  const secondFixture = await mkdtemp(
    path.join(os.tmpdir(), "offline-owned-in-vault-"),
  );
  const secondVault = path.join(secondFixture, "vault");
  try {
    await mkdir(path.join(secondVault, ".agent-backups"), { recursive: true });
    await assert.rejects(
      quarantinePostBaselineOwnedVaultBackups({
        vaultRoot: secondVault,
        notePath: NOTE_PATH,
        baselinePaths: [],
        quarantineRoot: path.join(secondVault, "quarantine"),
      }),
      /outside and disjoint/u,
    );
  } finally {
    await rm(secondFixture, { recursive: true, force: true });
  }
});

test("offline quarantine rejects a root-level backup symlink escape when supported", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "offline-owned-file-link-"),
  );
  const outsideRoot = await mkdtemp(
    path.join(os.tmpdir(), "offline-owned-file-outside-"),
  );
  const vaultRoot = path.join(fixtureRoot, "vault");
  const backupRoot = path.join(vaultRoot, ".agent-backups");
  const outsideFile = path.join(outsideRoot, "outside.md");
  const linkedFile = path.join(backupRoot, path.posix.basename(NEW_BACKUP));
  let linked = false;
  try {
    await mkdir(backupRoot, { recursive: true });
    await writeFile(outsideFile, "outside", "utf8");
    try {
      await symlink(outsideFile, linkedFile, "file");
      linked = true;
    } catch (error) {
      if (!isUnavailableSymlinkError(error)) throw error;
      t.skip("This filesystem does not permit file symlink creation.");
      return;
    }

    await assert.rejects(
      inventoryRootLevelVaultBackupPaths(vaultRoot),
      /linked entry/u,
    );
    assert.equal(await readFile(outsideFile, "utf8"), "outside");
  } finally {
    if (linked) {
      await unlink(linkedFile).catch(() => undefined);
    }
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("offline quarantine fails closed above its exact-selection bound", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "offline-owned-bound-"),
  );
  const vaultRoot = path.join(fixtureRoot, "vault");
  const quarantineRoot = path.join(fixtureRoot, "quarantine");
  try {
    await mkdir(path.join(vaultRoot, ".agent-backups"), { recursive: true });
    for (let index = 0; index <= MAX_OFFLINE_OWNED_VAULT_BACKUPS; index += 1) {
      const suffix = index === 0 ? "" : `.${index}`;
      await writeVaultBackup(
        vaultRoot,
        `.agent-backups/${BASENAME}.2026-07-28T14-00-00-000Z.dddddddddddd${suffix}.backup.md`,
        String(index),
      );
    }

    await assert.rejects(
      quarantinePostBaselineOwnedVaultBackups({
        vaultRoot,
        notePath: NOTE_PATH,
        baselinePaths: [],
        quarantineRoot,
      }),
      /64-file bound/u,
    );
    await assert.rejects(lstat(quarantineRoot), /ENOENT/u);
    assert.equal(
      (await inventoryRootLevelVaultBackupPaths(vaultRoot)).length,
      MAX_OFFLINE_OWNED_VAULT_BACKUPS + 1,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function writeVaultBackup(
  vaultRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFile(
    path.join(vaultRoot, ...relativePath.split("/")),
    content,
    "utf8",
  );
}

async function readVaultBackup(
  vaultRoot: string,
  relativePath: string,
): Promise<string> {
  return readFile(path.join(vaultRoot, ...relativePath.split("/")), "utf8");
}

function isUnavailableSymlinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}
