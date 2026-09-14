/**
 * Retention for `.agent-backups/`.
 *
 * Every risky write takes a full copy of the note first — replace, expand in
 * place, streamed writeback, link rewriting, diagram edits — and nothing ever
 * removed one. In this project's own test vault that folder held 438 files and
 * 4.2 MB, a quarter of the whole vault, and it only grows: a user who rewrites
 * a long note ten times has ten copies of it forever, syncing to whatever
 * syncs their vault.
 *
 * The policy is deliberately conservative, because a backup exists for the
 * moment someone needs it:
 *
 * - Anything younger than `retentionDays` is kept, whatever else is true.
 * - The newest `keepPerNote` backups of each note are kept at any age, so the
 *   undo path for a note nobody has touched in a year is still there.
 * - Only what survives neither rule is swept, oldest first, and it goes to
 *   Obsidian's trash rather than being deleted (AGENTS.md: hard delete is not
 *   a default capability).
 * - A path the current session created is never swept, whatever its age says.
 *
 * The selector is pure so the policy is testable without a vault, mirroring
 * `runRetentionPolicy.ts`, whose sweep shape this follows on purpose: one
 * proven idiom for "age out our own artifacts" beats two.
 */

import { BACKUP_FOLDER } from "../tools/constants";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Backups trashed in one session, so a huge folder drains over several. */
export const MAX_BACKUP_TRASHES_PER_SESSION = 200;

export interface BackupRetentionPolicyV1 {
  retentionDays: number;
  keepPerNote: number;
}

export const DEFAULT_BACKUP_RETENTION_POLICY_V1: BackupRetentionPolicyV1 = {
  retentionDays: 30,
  keepPerNote: 5,
};

export interface BackupArtifactV1 {
  path: string;
  mtimeMs: number;
}

/** True for a file this plugin wrote as a backup copy. */
export function isAgentBackupPathV1(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/");
  return normalized.startsWith(`${BACKUP_FOLDER}/`);
}

/**
 * Which note a backup belongs to, from the two shapes this project writes:
 * `<epochMs>-<basename>.md` (vault and graph writes, optionally
 * `-<n>`-suffixed on a same-millisecond collision) and
 * `<basename>.<stamp>.bak` (diagram artifacts).
 *
 * An unrecognised name groups under itself, which makes it its own newest
 * backup and therefore never sweepable by the per-note rule. Failing closed is
 * the right direction for a file whose provenance we cannot read.
 */
export function backupSourceKeyV1(path: string): string {
  const name = path.replace(/\\/gu, "/").split("/").pop() ?? path;
  const timestamped = /^(\d{10,})-(.+?)(?:-\d+)?\.md$/iu.exec(name);
  if (timestamped) return timestamped[2]!.toLowerCase();
  const stamped = /^(.+)\.(\d{10,}|[0-9TZ:.-]{10,})\.bak$/iu.exec(name);
  if (stamped) return stamped[1]!.toLowerCase();
  return name.toLowerCase();
}

/**
 * Backups that may be trashed now: older than the retention window, and not
 * among the newest `keepPerNote` copies of their note.
 *
 * Returned oldest first so a capped batch removes the least useful copies.
 */
export function selectPrunableBackupsV1(
  entries: readonly BackupArtifactV1[],
  policy: BackupRetentionPolicyV1,
  now: Date,
  options: { protectedPaths?: ReadonlySet<string> } = {},
): string[] {
  if (policy.retentionDays <= 0 || policy.keepPerNote < 0) return [];
  const cutoffMs = now.getTime() - policy.retentionDays * DAY_MS;
  const byNote = new Map<string, BackupArtifactV1[]>();
  for (const entry of entries) {
    if (!isAgentBackupPathV1(entry.path)) continue;
    const key = backupSourceKeyV1(entry.path);
    const group = byNote.get(key);
    if (group) group.push(entry);
    else byNote.set(key, [entry]);
  }

  const prunable: BackupArtifactV1[] = [];
  for (const group of byNote.values()) {
    const newestFirst = [...group].sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
    );
    for (const entry of newestFirst.slice(policy.keepPerNote)) {
      if (entry.mtimeMs >= cutoffMs) continue;
      if (options.protectedPaths?.has(entry.path)) continue;
      prunable.push(entry);
    }
  }
  return prunable
    .sort(
      (left, right) =>
        left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path),
    )
    .map((entry) => entry.path);
}

export interface BackupRetentionVaultV1 {
  getFiles(): Array<{ path: string; stat?: { mtime?: number } }>;
  getFileByPath?(path: string): unknown;
  getAbstractFileByPath?(path: string): unknown;
  trash?(file: unknown, system: boolean): Promise<void>;
}

/**
 * Sweep aged backups, best effort. One failure never blocks onload, and the
 * whole sweep is a no-op on a vault with no backup folder.
 */
export async function sweepAgentBackupsRetentionBestEffortV1(input: {
  vault: BackupRetentionVaultV1;
  policy?: BackupRetentionPolicyV1;
  now?: Date;
  maxTrashes?: number;
  protectedPaths?: ReadonlySet<string>;
}): Promise<{ trashed: string[] }> {
  const trashed: string[] = [];
  try {
    const policy = input.policy ?? DEFAULT_BACKUP_RETENTION_POLICY_V1;
    if (typeof input.vault.getFiles !== "function") return { trashed };
    if (typeof input.vault.trash !== "function") return { trashed };
    const files = input.vault
      .getFiles()
      .filter((file) => isAgentBackupPathV1(file.path));
    if (files.length === 0) return { trashed };

    const selected = selectPrunableBackupsV1(
      files.map((file) => ({
        path: file.path,
        mtimeMs: file.stat?.mtime ?? 0,
      })),
      policy,
      input.now ?? new Date(),
      { protectedPaths: input.protectedPaths },
    );
    const limit = Math.max(
      0,
      Math.min(
        input.maxTrashes ?? MAX_BACKUP_TRASHES_PER_SESSION,
        MAX_BACKUP_TRASHES_PER_SESSION,
      ),
    );
    for (const path of selected.slice(0, limit)) {
      try {
        const file =
          input.vault.getFileByPath?.(path) ??
          input.vault.getAbstractFileByPath?.(path) ??
          files.find((candidate) => candidate.path === path);
        if (!file) continue;
        await input.vault.trash(file, false);
        trashed.push(path);
      } catch {
        // Best effort: one failed trash must not stop the rest.
      }
    }
  } catch {
    return { trashed };
  }
  return { trashed };
}
