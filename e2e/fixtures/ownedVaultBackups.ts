const VAULT_BACKUP_ROOT = ".agent-backups";
const MAX_BACKUP_INVENTORY_PATHS = 10_000;
const MAX_VAULT_RELATIVE_PATH_LENGTH = 1_024;

const DIAGRAM_BACKUP_TIMESTAMP =
  String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`;
const DIAGRAM_BACKUP_HASH = String.raw`[a-f0-9]{12}`;

export interface OwnedVaultBackupInventoryV1 {
  /**
   * A caller-created, per-run markdown path. Its basename must already be safe;
   * this helper deliberately does not sanitize names because two distinct names
   * must never collapse into one cleanup boundary.
   */
  notePath: string;
  /** Exact inventory captured before the run-owned note can be mutated. */
  baselinePaths: readonly string[];
  /** Exact inventory observed at selection or readback time. */
  currentPaths: readonly string[];
}

export interface OwnedVaultBackupSelectionV1 {
  version: 1;
  notePath: string;
  noteBasename: string;
  paths: string[];
}

export interface OwnedVaultBackupReadbackV1 {
  version: 1;
  notePath: string;
  noteBasename: string;
  survivors: string[];
  absenceVerified: boolean;
}

/**
 * Selects only backups created after the baseline for one exact note basename.
 *
 * Safe unrelated files are ignored, including backups created concurrently for
 * another note. Unsafe inventory paths fail closed instead of being normalized.
 */
export function selectPostBaselineOwnedVaultBackupPaths(
  input: OwnedVaultBackupInventoryV1,
): OwnedVaultBackupSelectionV1 {
  const note = parseOwnedNotePath(input.notePath);
  const baseline = parseInventory(input.baselinePaths, "baseline");
  const current = parseInventory(input.currentPaths, "current");
  const baselineKeys = new Set(baseline.map(pathKey));
  const paths = current
    .filter(
      (candidate) =>
        !baselineKeys.has(pathKey(candidate)) &&
        isExactOwnedBackupPath(candidate, note.basename),
    )
    .sort((left, right) => left.localeCompare(right));
  return {
    version: 1,
    notePath: note.path,
    noteBasename: note.basename,
    paths,
  };
}

/**
 * Validates a path immediately before deletion. Callers should never delete a
 * raw inventory value without passing this exact-note ownership check.
 */
export function validateOwnedVaultBackupDeletionPath(
  notePath: string,
  candidatePath: string,
): string {
  const note = parseOwnedNotePath(notePath);
  const candidate = parseInventoryPath(candidatePath, "deletion candidate");
  if (!isExactOwnedBackupPath(candidate, note.basename)) {
    throw new Error(
      `Refusing non-owned vault backup deletion candidate: ${candidate}.`,
    );
  }
  return candidate;
}

/**
 * Re-runs the post-baseline ownership selection after deletion. Any returned
 * survivor is an exact run-owned backup, while baseline and other-note files do
 * not count against the cleanup proof.
 */
export function inspectOwnedVaultBackupCleanupReadback(
  input: OwnedVaultBackupInventoryV1,
): OwnedVaultBackupReadbackV1 {
  const selected = selectPostBaselineOwnedVaultBackupPaths(input);
  return {
    version: 1,
    notePath: selected.notePath,
    noteBasename: selected.noteBasename,
    survivors: selected.paths,
    absenceVerified: selected.paths.length === 0,
  };
}

export function assertOwnedVaultBackupCleanupReadback(
  input: OwnedVaultBackupInventoryV1,
): OwnedVaultBackupReadbackV1 & { absenceVerified: true } {
  const readback = inspectOwnedVaultBackupCleanupReadback(input);
  if (!readback.absenceVerified) {
    throw new Error(
      `Run-owned vault backups survived cleanup: ${readback.survivors.join(", ")}.`,
    );
  }
  return readback as OwnedVaultBackupReadbackV1 & {
    absenceVerified: true;
  };
}

function parseOwnedNotePath(value: string): {
  path: string;
  basename: string;
} {
  if (typeof value !== "string" || value.length > MAX_VAULT_RELATIVE_PATH_LENGTH) {
    throw new Error("Owned vault backup cleanup requires a bounded note path.");
  }
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error("Owned vault backup cleanup requires a safe vault-relative note path.");
  }
  const parts = value.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    parts.length < 2
  ) {
    throw new Error("Owned vault backup cleanup rejected an unsafe note path.");
  }
  const filename = parts.at(-1)!;
  if (!filename.endsWith(".md")) {
    throw new Error("Owned vault backup cleanup requires a markdown note.");
  }
  const basename = filename.slice(0, -".md".length);
  if (
    basename.length < 1 ||
    basename.length > 120 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(basename)
  ) {
    throw new Error(
      "Owned vault backup cleanup requires an exact safe note basename.",
    );
  }
  return { path: value, basename };
}

function parseInventory(
  values: readonly string[],
  label: string,
): string[] {
  if (!Array.isArray(values) || values.length > MAX_BACKUP_INVENTORY_PATHS) {
    throw new Error(`Owned vault backup ${label} inventory exceeded its bound.`);
  }
  const unique = new Map<string, string>();
  for (const raw of values) {
    const candidate = parseInventoryPath(raw, `${label} inventory`);
    const key = pathKey(candidate);
    const prior = unique.get(key);
    if (prior && prior !== candidate) {
      throw new Error(
        `Owned vault backup ${label} inventory contains an ambiguous path.`,
      );
    }
    unique.set(key, candidate);
  }
  return [...unique.values()];
}

function parseInventoryPath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_VAULT_RELATIVE_PATH_LENGTH ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`Owned vault backup ${label} contains an unsafe path.`);
  }
  const parts = value.split("/");
  if (
    parts.length < 2 ||
    parts[0] !== VAULT_BACKUP_ROOT ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      `Owned vault backup ${label} escaped ${VAULT_BACKUP_ROOT}.`,
    );
  }
  return value;
}

function isExactOwnedBackupPath(
  candidatePath: string,
  noteBasename: string,
): boolean {
  const filename = candidatePath.split("/").at(-1)!;
  if (candidatePath !== `${VAULT_BACKUP_ROOT}/${filename}`) return false;
  const pattern = new RegExp(
    `^${escapeRegExp(noteBasename)}\\.${DIAGRAM_BACKUP_TIMESTAMP}\\.` +
      `${DIAGRAM_BACKUP_HASH}(?:\\.[1-9]\\d*)?\\.backup\\.md$`,
    "u",
  );
  return pattern.test(filename);
}

function pathKey(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
