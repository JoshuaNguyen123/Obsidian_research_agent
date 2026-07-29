import assert from "node:assert/strict";
import test from "node:test";

import {
  assertOwnedVaultBackupCleanupReadback,
  inspectOwnedVaultBackupCleanupReadback,
  selectPostBaselineOwnedVaultBackupPaths,
  validateOwnedVaultBackupDeletionPath,
} from "../e2e/fixtures/ownedVaultBackups";

const NOTE_PATH =
  "E2E Agent Tests/BYOK-AUTONOMOUS-84d74608f747.md";
const BASENAME = "BYOK-AUTONOMOUS-84d74608f747";
const OLD_BACKUP =
  `.agent-backups/${BASENAME}.2026-07-28T12-00-00-000Z.aaaaaaaaaaaa.backup.md`;
const NEW_BACKUP =
  `.agent-backups/${BASENAME}.2026-07-28T13-58-58-535Z.e18a99dce669.backup.md`;
const NEW_COLLISION_BACKUP =
  `.agent-backups/${BASENAME}.2026-07-28T13-58-58-535Z.e18a99dce669.1.backup.md`;
const OTHER_NOTE_BACKUP =
  ".agent-backups/Claude-note.2026-07-28T13-58-58-535Z.bbbbbbbbbbbb.backup.md";

test("selects only exact post-baseline backups for the unique note basename", () => {
  const selected = selectPostBaselineOwnedVaultBackupPaths({
    notePath: NOTE_PATH,
    baselinePaths: [
      OLD_BACKUP,
      ".agent-backups/123-Current.md",
    ],
    currentPaths: [
      OLD_BACKUP,
      NEW_BACKUP,
      NEW_COLLISION_BACKUP,
      OTHER_NOTE_BACKUP,
      `.agent-backups/${BASENAME}.2026-07-28T13-58-58-535Z.e18a99dce669.backup.canvas`,
      `.agent-backups/123-${BASENAME}.md`,
    ],
  });

  assert.equal(selected.notePath, NOTE_PATH);
  assert.equal(selected.noteBasename, BASENAME);
  assert.deepEqual(selected.paths, [NEW_COLLISION_BACKUP, NEW_BACKUP].sort());
});

test("preserves pre-baseline same-name and concurrent other-note backups", () => {
  const readback = inspectOwnedVaultBackupCleanupReadback({
    notePath: NOTE_PATH,
    baselinePaths: [OLD_BACKUP],
    currentPaths: [OLD_BACKUP, OTHER_NOTE_BACKUP],
  });

  assert.deepEqual(readback.survivors, []);
  assert.equal(readback.absenceVerified, true);
  assert.equal(
    assertOwnedVaultBackupCleanupReadback({
      notePath: NOTE_PATH,
      baselinePaths: [OLD_BACKUP],
      currentPaths: [OLD_BACKUP, OTHER_NOTE_BACKUP],
    }).absenceVerified,
    true,
  );
});

test("readback exposes exact survivors and its assertion fails closed", () => {
  const readback = inspectOwnedVaultBackupCleanupReadback({
    notePath: NOTE_PATH,
    baselinePaths: [OLD_BACKUP],
    currentPaths: [OLD_BACKUP, NEW_BACKUP, OTHER_NOTE_BACKUP],
  });

  assert.deepEqual(readback.survivors, [NEW_BACKUP]);
  assert.equal(readback.absenceVerified, false);
  assert.throws(
    () =>
      assertOwnedVaultBackupCleanupReadback({
        notePath: NOTE_PATH,
        baselinePaths: [OLD_BACKUP],
        currentPaths: [OLD_BACKUP, NEW_BACKUP, OTHER_NOTE_BACKUP],
      }),
    /survived cleanup/u,
  );
});

test("deletion validation rejects non-backups and another note's backups", () => {
  assert.equal(
    validateOwnedVaultBackupDeletionPath(NOTE_PATH, NEW_BACKUP),
    NEW_BACKUP,
  );
  for (const candidate of [
    `.agent-backups/${BASENAME}.md`,
    `.agent-backups/${BASENAME}.2026-07-28T13-58-58-535Z.e18a99dce669.backup.canvas`,
    OTHER_NOTE_BACKUP,
    `.agent-backups/nested/${BASENAME}.2026-07-28T13-58-58-535Z.e18a99dce669.backup.md`,
  ]) {
    assert.throws(
      () => validateOwnedVaultBackupDeletionPath(NOTE_PATH, candidate),
      /non-owned/u,
    );
  }
});

test("unsafe note and inventory paths are rejected without normalization", () => {
  for (const notePath of [
    String.raw`E2E Agent Tests\BYOK-AUTONOMOUS-84d74608f747.md`,
    "E2E Agent Tests/../BYOK-AUTONOMOUS-84d74608f747.md",
    "E2E Agent Tests/BYOK AUTONOMOUS 84d74608f747.md",
    "C:/vault/BYOK-AUTONOMOUS-84d74608f747.md",
    "E2E Agent Tests/BYOK-AUTONOMOUS-84d74608f747.txt",
  ]) {
    assert.throws(() =>
      selectPostBaselineOwnedVaultBackupPaths({
        notePath,
        baselinePaths: [],
        currentPaths: [],
      }),
    );
  }

  for (const candidate of [
    String.raw`.agent-backups\owned.backup.md`,
    ".agent-backups/../owned.backup.md",
    "../.agent-backups/owned.backup.md",
    "Agent Work/owned.backup.md",
    "/.agent-backups/owned.backup.md",
  ]) {
    assert.throws(() =>
      selectPostBaselineOwnedVaultBackupPaths({
        notePath: NOTE_PATH,
        baselinePaths: [],
        currentPaths: [candidate],
      }),
    );
  }
});

test("case-ambiguous inventories fail closed", () => {
  assert.throws(
    () =>
      selectPostBaselineOwnedVaultBackupPaths({
        notePath: NOTE_PATH,
        baselinePaths: [],
        currentPaths: [NEW_BACKUP, NEW_BACKUP.toLowerCase()],
      }),
    /ambiguous/u,
  );
});
