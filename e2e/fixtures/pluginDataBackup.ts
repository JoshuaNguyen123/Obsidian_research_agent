import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface PluginDataBackupV1 {
  version: 1;
  content: string | null;
}

export function pluginDataBackupPath(filePath: string): string {
  return `${filePath}.e2e-backup-v1`;
}

/**
 * Persist the exact pre-launch plugin settings before a harness mutates
 * data.json. Exclusive creation makes overlapping or stale harness ownership
 * fail closed instead of silently replacing the only recovery copy.
 */
export async function createPluginDataBackup(
  filePath: string,
  content: string | null,
): Promise<void> {
  const backup: PluginDataBackupV1 = { version: 1, content };
  const backupPath = pluginDataBackupPath(filePath);
  await mkdir(path.dirname(backupPath), { recursive: true });
  const handle = await open(backupPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(backup), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Restore the exact baseline first; remove recovery authority only afterward. */
export async function restorePluginDataSnapshot(
  filePath: string,
  content: string | null,
): Promise<void> {
  await restoreOptionalText(filePath, content);
  await rm(pluginDataBackupPath(filePath), { force: true });
}

/**
 * A sidecar left by a hard-killed run is authoritative. Corrupt or unknown
 * sidecars fail setup rather than launching Obsidian against mutated settings.
 */
export async function recoverStalePluginDataBackup(
  filePath: string,
): Promise<void> {
  const backupPath = pluginDataBackupPath(filePath);
  const serialized = await readFile(backupPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (serialized === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(`Refusing to ignore corrupt E2E plugin-data backup: ${backupPath}`);
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !(typeof parsed.content === "string" || parsed.content === null)
  ) {
    throw new Error(`Invalid E2E plugin-data backup contract: ${backupPath}`);
  }

  await restoreOptionalText(filePath, parsed.content);
  await rm(backupPath, { force: true });
}

async function restoreOptionalText(
  filePath: string,
  content: string | null,
): Promise<void> {
  if (content === null) {
    await rm(filePath, { force: true });
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
