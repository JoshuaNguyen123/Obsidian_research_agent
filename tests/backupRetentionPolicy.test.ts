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

test("the sweep trashes aged copies and leaves everything else alone", async () => {
  const files = [
    ...Array.from({ length: 7 }, (_, index) => ({
      path: notePath(index),
      stat: { mtime: daysAgo(500 - index) },
    })),
    { path: "Notes/Note.md", stat: { mtime: daysAgo(500) } },
  ];
  const trashed: string[] = [];
  const result = await sweepAgentBackupsRetentionBestEffortV1({
    vault: {
      getFiles: () => files,
      getFileByPath: (path: string) =>
        files.find((file) => file.path === path) ?? null,
      trash: async (file: unknown) => {
        trashed.push((file as { path: string }).path);
      },
    },
    now: NOW,
  });
  assert.deepEqual(result.trashed, trashed);
  assert.equal(trashed.length, 2);
  assert.ok(trashed.every((path) => path.startsWith(".agent-backups/")));
  assert.ok(!trashed.includes("Notes/Note.md"));
});

test("a vault without trash support is left untouched", async () => {
  const result = await sweepAgentBackupsRetentionBestEffortV1({
    vault: {
      getFiles: () => [
        { path: ".agent-backups/17262720000-Note.md", stat: { mtime: daysAgo(900) } },
      ],
    },
    now: NOW,
  });
  assert.deepEqual(result.trashed, []);
});

test("one failing trash does not stop the rest of the sweep", async () => {
  const files = Array.from({ length: 8 }, (_, index) => ({
    path: notePath(index),
    stat: { mtime: daysAgo(500 - index) },
  }));
  const trashed: string[] = [];
  const result = await sweepAgentBackupsRetentionBestEffortV1({
    vault: {
      getFiles: () => files,
      getFileByPath: (path: string) =>
        files.find((file) => file.path === path) ?? null,
      trash: async (file: unknown) => {
        const { path } = file as { path: string };
        if (path === notePath(0)) throw new Error("locked");
        trashed.push(path);
      },
    },
    now: NOW,
  });
  // Three copies are prunable; the oldest throws and the other two still go.
  assert.equal(result.trashed.length, 2);
  assert.deepEqual(result.trashed, trashed);
});
