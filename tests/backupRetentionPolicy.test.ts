import assert from "node:assert/strict";
import test from "node:test";

import {
  backupSourceKeyV1,
  DEFAULT_BACKUP_RETENTION_POLICY_V1,
  isAgentBackupPathV1,
  selectPrunableBackupsV1,
  sweepAgentBackupsRetentionBestEffortV1,
} from "../src/agent/backupRetentionPolicy";

const NOW = new Date("2026-09-14T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): number {
  return NOW.getTime() - days * DAY_MS;
}

/** Distinct, stable backup paths for one note. Fixtures age index 0 most. */
function notePath(index: number): string {
  return `.agent-backups/17262720${String(90 - index).padStart(4, "0")}-Note.md`;
}

function backup(path: string, days: number) {
  return { path, mtimeMs: daysAgo(days) };
}

test("only this plugin's backup folder is in scope", () => {
  assert.ok(isAgentBackupPathV1(".agent-backups/1726272000000-Note.md"));
  assert.ok(!isAgentBackupPathV1("Notes/1726272000000-Note.md"));
  assert.ok(!isAgentBackupPathV1(".agent-backups-other/x.md"));
});

test("a backup is grouped by the note it copied, in either written shape", () => {
  assert.equal(backupSourceKeyV1(".agent-backups/1726272000000-Weekly-Review.md"), "weekly-review");
  assert.equal(backupSourceKeyV1(".agent-backups/1726272000000-Weekly-Review-2.md"), "weekly-review");
  assert.equal(backupSourceKeyV1(".agent-backups/Diagram.1726272000000.bak"), "diagram");
  // Unrecognised: its own group, so the keep-newest rule protects it.
  assert.equal(backupSourceKeyV1(".agent-backups/handwritten.md"), "handwritten.md");
});

test("recent backups are never swept", () => {
  const entries = Array.from({ length: 20 }, (_, index) =>
    backup(`.agent-backups/17262720000${index}-Note.md`, 1),
  );
  assert.deepEqual(
    selectPrunableBackupsV1(entries, DEFAULT_BACKUP_RETENTION_POLICY_V1, NOW),
    [],
  );
});

test("the newest copies of a note survive at any age", () => {
  const entries = Array.from({ length: 8 }, (_, index) =>
    backup(notePath(index), 400 - index),
  );
  const pruned = selectPrunableBackupsV1(
    entries,
    DEFAULT_BACKUP_RETENTION_POLICY_V1,
    NOW,
  );
  assert.equal(pruned.length, 3, "eight aged copies, five kept");
  // Oldest first, and never one of the five newest.
  assert.deepEqual(pruned, [notePath(0), notePath(1), notePath(2)]);
});

test("each note keeps its own copies; a busy note cannot evict a quiet one", () => {
  const entries = [
    ...Array.from({ length: 9 }, (_, index) =>
      backup(`.agent-backups/172627200${index}0-Busy.md`, 300 - index),
    ),
    backup(".agent-backups/1726272999-Quiet.md", 900),
  ];
  const pruned = selectPrunableBackupsV1(
    entries,
    DEFAULT_BACKUP_RETENTION_POLICY_V1,
    NOW,
  );
  assert.ok(!pruned.includes(".agent-backups/1726272999-Quiet.md"));
  assert.equal(pruned.length, 4);
});

test("a path the session created is never swept", () => {
  const entries = Array.from({ length: 7 }, (_, index) =>
    backup(notePath(index), 500 - index),
  );
  // The oldest copy, which the policy would otherwise select first.
  const protectedPath = notePath(0);
  const pruned = selectPrunableBackupsV1(
    entries,
    DEFAULT_BACKUP_RETENTION_POLICY_V1,
    NOW,
    { protectedPaths: new Set([protectedPath]) },
  );
  assert.ok(!pruned.includes(protectedPath));
});

test("a disabled policy sweeps nothing", () => {
  const entries = Array.from({ length: 30 }, (_, index) =>
    backup(notePath(index), 900),
  );
  assert.deepEqual(
    selectPrunableBackupsV1(entries, { retentionDays: 0, keepPerNote: 5 }, NOW),
    [],
  );
});

/**
 * A vault that behaves like Obsidian: `.agent-backups/` is dot-prefixed, so
 * the app never indexes it and `getFiles()` cannot see a single backup. The
 * adapter is the only way in, and `trashLocal` the only way out. The first
 * version of this sweep read `getFiles()` alone, passed against a mock that
 * volunteered the paths, and did nothing at all in the installed plugin.
 */
function createHiddenFolderVault(
  backups: ReadonlyArray<{ path: string; mtimeMs: number }>,
  options: { indexedFiles?: ReadonlyArray<{ path: string; stat: { mtime: number } }> } = {},
) {
  const present = new Map(backups.map((item) => [item.path, item.mtimeMs]));
  const trashed: string[] = [];
  return {
    trashed,
    present,
    vault: {
      // Only user-visible notes, exactly as Obsidian reports them.
      getFiles: () => [...(options.indexedFiles ?? [])],
      getFileByPath: () => null,
      adapter: {
        list: async () => ({ files: [...present.keys()], folders: [] }),
        stat: async (path: string) =>
          present.has(path) ? { mtime: present.get(path)!, type: "file" } : null,
        trashLocal: async (path: string) => {
          if (path === "LOCKED") throw new Error("locked");
          present.delete(path);
          trashed.push(path);
        },
      },
    },
  };
}

test("the sweep reads the hidden folder through the adapter and trashes there", async () => {
  const harness = createHiddenFolderVault(
    Array.from({ length: 7 }, (_, index) => ({
      path: notePath(index),
      mtimeMs: daysAgo(500 - index),
    })),
    { indexedFiles: [{ path: "Notes/Note.md", stat: { mtime: daysAgo(500) } }] },
  );
  const result = await sweepAgentBackupsRetentionBestEffortV1({
    vault: harness.vault,
    now: NOW,
  });
  assert.deepEqual(result.trashed, harness.trashed);
  assert.equal(harness.trashed.length, 2);
  assert.ok(harness.trashed.every((path) => path.startsWith(".agent-backups/")));
  assert.ok(!harness.trashed.includes("Notes/Note.md"));
});

test("a vault that offers no way to trash is left untouched", async () => {
  const result = await sweepAgentBackupsRetentionBestEffortV1({
    vault: {
      adapter: {
        list: async () => ({ files: [notePath(0)], folders: [] }),
        stat: async () => ({ mtime: daysAgo(900), type: "file" }),
      },
    },
    now: NOW,
  });
  assert.deepEqual(result.trashed, []);
});

test("one failing trash does not stop the rest of the sweep", async () => {
  const harness = createHiddenFolderVault(
    Array.from({ length: 8 }, (_, index) => ({
      path: notePath(index),
      mtimeMs: daysAgo(500 - index),
    })),
  );
  const oldest = notePath(0);
  const vault = {
    ...harness.vault,
    adapter: {
      ...harness.vault.adapter,
      trashLocal: async (path: string) => {
        if (path === oldest) throw new Error("locked");
        harness.present.delete(path);
        harness.trashed.push(path);
      },
    },
  };
  const result = await sweepAgentBackupsRetentionBestEffortV1({ vault, now: NOW });
  // Three copies are prunable; the oldest throws and the other two still go.
  assert.equal(result.trashed.length, 2);
  assert.ok(!result.trashed.includes(oldest));
});

test("an indexed backup is trashed through the vault API, not the adapter", async () => {
  // Some hosts do index the folder. Prefer the vault's own trash there so the
  // file leaves the index with it.
  const path = notePath(0);
  const trashedFiles: string[] = [];
  const adapterTrashed: string[] = [];
  const files = Array.from({ length: 7 }, (_, index) => ({
    path: notePath(index),
    stat: { mtime: daysAgo(500 - index) },
  }));
  const result = await sweepAgentBackupsRetentionBestEffortV1({
    vault: {
      getFiles: () => files,
      getFileByPath: (candidate: string) =>
        files.find((file) => file.path === candidate) ?? null,
      trash: async (file: unknown) => {
        trashedFiles.push((file as { path: string }).path);
      },
      adapter: {
        list: async () => ({ files: [], folders: [] }),
        trashLocal: async (candidate: string) => {
          adapterTrashed.push(candidate);
        },
      },
    },
    now: NOW,
  });
  assert.ok(result.trashed.includes(path));
  assert.deepEqual(adapterTrashed, []);
  assert.equal(trashedFiles.length, 2);
});
