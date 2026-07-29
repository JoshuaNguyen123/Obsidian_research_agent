import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";

import {
  assertOwnedVaultBackupCleanupReadback,
  selectPostBaselineOwnedVaultBackupPaths,
  validateOwnedVaultBackupDeletionPath,
  type OwnedVaultBackupReadbackV1,
} from "./ownedVaultBackups";

const VAULT_BACKUP_ROOT = ".agent-backups";

/**
 * This is a cleanup safety bound, not an inventory truncation. Refusing the
 * whole operation is safer than moving only part of an unexpectedly large
 * exact-note selection.
 */
export const MAX_OFFLINE_OWNED_VAULT_BACKUPS = 64;

export interface OfflineOwnedVaultBackupQuarantineInputV1 {
  /** Absolute path to an offline, real Obsidian vault directory. */
  vaultRoot: string;
  /** Vault-relative markdown path of the caller-created, run-owned note. */
  notePath: string;
  /** Exact root-level backup inventory captured before the run. */
  baselinePaths: readonly string[];
  /**
   * Absolute path outside the vault. It may be absent or an existing empty
   * real directory, but it must be unique to this cleanup attempt.
   */
  quarantineRoot: string;
}

export interface OfflineOwnedVaultBackupQuarantineProofV1 {
  version: 1;
  vaultRoot: string;
  backupRoot: string;
  quarantineRoot: string;
  selectedPaths: string[];
  quarantinedPaths: string[];
  survivors: string[];
  absenceVerified: true;
  readback: OwnedVaultBackupReadbackV1 & { absenceVerified: true };
}

interface BackupInventory {
  vaultRoot: string;
  backupRoot: string;
  backupRootStat: Awaited<ReturnType<typeof lstat>> | null;
  paths: string[];
}

interface PreparedMove {
  relativePath: string;
  sourcePath: string;
  destinationPath: string;
  sourceStat: Awaited<ReturnType<typeof lstat>>;
}

/**
 * Inventories regular files directly under `.agent-backups`.
 *
 * Nested content is deliberately ignored. A linked backup root or linked
 * root-level entry fails closed so a later absence proof cannot be satisfied
 * by silently following or skipping an escape.
 */
export async function inventoryRootLevelVaultBackupPaths(
  vaultRoot: string,
): Promise<string[]> {
  return (await inspectBackupInventory(vaultRoot)).paths;
}

/**
 * Moves exact post-baseline backups for one run-owned note into an offline
 * quarantine. `rename` is the only transfer operation: there is no
 * copy/delete fallback across filesystems and no overwrite path.
 *
 * If the process is killed between renames, already-moved backups remain in
 * the caller's quarantine instead of being deleted. A successful return means
 * a fresh filesystem inventory passed the existing exact-ownership readback.
 */
export async function quarantinePostBaselineOwnedVaultBackups(
  input: OfflineOwnedVaultBackupQuarantineInputV1,
): Promise<OfflineOwnedVaultBackupQuarantineProofV1> {
  const current = await inspectBackupInventory(input.vaultRoot);
  const selection = selectPostBaselineOwnedVaultBackupPaths({
    notePath: input.notePath,
    baselinePaths: input.baselinePaths,
    currentPaths: current.paths,
  });
  if (selection.paths.length > MAX_OFFLINE_OWNED_VAULT_BACKUPS) {
    throw new Error(
      `Offline owned vault backup quarantine exceeded its ${MAX_OFFLINE_OWNED_VAULT_BACKUPS}-file bound.`,
    );
  }

  const quarantineRoot = await prepareQuarantineRoot(
    input.quarantineRoot,
    current.vaultRoot,
  );
  const quarantineStat = await lstat(quarantineRoot);
  if (
    current.backupRootStat &&
    current.backupRootStat.dev !== quarantineStat.dev
  ) {
    throw new Error(
      "Offline owned vault backup quarantine requires a same-filesystem atomic rename.",
    );
  }

  const prepared: PreparedMove[] = [];
  for (const rawPath of selection.paths) {
    const relativePath = validateOwnedVaultBackupDeletionPath(
      selection.notePath,
      rawPath,
    );
    if (!current.backupRootStat) {
      throw new Error(
        "Offline owned vault backup quarantine lost its backup root before preflight.",
      );
    }
    const filename = relativePath.slice(`${VAULT_BACKUP_ROOT}/`.length);
    const sourcePath = path.join(current.backupRoot, filename);
    const sourceStat = await assertConfinedRegularFile(
      sourcePath,
      current.backupRoot,
      filename,
      "source",
    );
    const destinationPath = path.join(quarantineRoot, filename);
    assertDirectChild(
      quarantineRoot,
      destinationPath,
      filename,
      "quarantine destination",
    );
    if (await lstatIfPresent(destinationPath)) {
      throw new Error(
        `Refusing existing offline backup quarantine destination or overwrite: ${destinationPath}.`,
      );
    }
    prepared.push({
      relativePath,
      sourcePath,
      destinationPath,
      sourceStat,
    });
  }

  const quarantinedPaths: string[] = [];
  for (const move of prepared) {
    const freshSourceStat = await assertConfinedRegularFile(
      move.sourcePath,
      current.backupRoot,
      path.basename(move.sourcePath),
      "source",
    );
    if (!sameFileIdentity(move.sourceStat, freshSourceStat)) {
      throw new Error(
        `Offline owned vault backup changed after preflight: ${move.relativePath}.`,
      );
    }
    if (await lstatIfPresent(move.destinationPath)) {
      throw new Error(
        `Refusing existing offline backup quarantine destination or overwrite: ${move.destinationPath}.`,
      );
    }

    await rename(move.sourcePath, move.destinationPath);

    if (await lstatIfPresent(move.sourcePath)) {
      throw new Error(
        `Offline owned vault backup source survived its atomic rename: ${move.relativePath}.`,
      );
    }
    await assertConfinedRegularFile(
      move.destinationPath,
      quarantineRoot,
      path.basename(move.destinationPath),
      "quarantined backup",
    );
    quarantinedPaths.push(move.destinationPath);
  }

  const readbackInventory = await inspectBackupInventory(current.vaultRoot);
  const readback = assertOwnedVaultBackupCleanupReadback({
    notePath: selection.notePath,
    baselinePaths: input.baselinePaths,
    currentPaths: readbackInventory.paths,
  });
  return {
    version: 1,
    vaultRoot: current.vaultRoot,
    backupRoot: current.backupRoot,
    quarantineRoot,
    selectedPaths: [...selection.paths],
    quarantinedPaths,
    survivors: [...readback.survivors],
    absenceVerified: true,
    readback,
  };
}

async function inspectBackupInventory(vaultRootInput: string): Promise<BackupInventory> {
  const vaultRoot = await canonicalRealDirectory(
    vaultRootInput,
    "Offline backup vault root",
  );
  const expectedBackupRoot = path.join(vaultRoot, VAULT_BACKUP_ROOT);
  const backupRootStat = await lstatIfPresent(expectedBackupRoot);
  if (!backupRootStat) {
    return {
      vaultRoot,
      backupRoot: expectedBackupRoot,
      backupRootStat: null,
      paths: [],
    };
  }
  if (!backupRootStat.isDirectory() || backupRootStat.isSymbolicLink()) {
    throw new Error(
      "Offline owned vault backup root must be a real non-linked directory.",
    );
  }
  const backupRoot = await realpath(expectedBackupRoot);
  assertDirectChild(
    vaultRoot,
    backupRoot,
    VAULT_BACKUP_ROOT,
    "backup root",
  );

  const entries = await readdir(backupRoot, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const candidatePath = path.join(backupRoot, entry.name);
    const candidateStat = await lstat(candidatePath);
    if (entry.isSymbolicLink() || candidateStat.isSymbolicLink()) {
      throw new Error(
        `Offline owned vault backup inventory rejects linked entry: ${entry.name}.`,
      );
    }
    if (entry.isDirectory() && candidateStat.isDirectory()) {
      continue;
    }
    if (!entry.isFile() || !candidateStat.isFile()) {
      throw new Error(
        `Offline owned vault backup inventory rejects non-regular entry: ${entry.name}.`,
      );
    }
    assertSafeFilename(entry.name);
    await assertConfinedRegularFile(
      candidatePath,
      backupRoot,
      entry.name,
      "inventory candidate",
    );
    paths.push(`${VAULT_BACKUP_ROOT}/${entry.name}`);
  }
  return {
    vaultRoot,
    backupRoot,
    backupRootStat,
    paths,
  };
}

async function prepareQuarantineRoot(
  quarantineRootInput: string,
  vaultRoot: string,
): Promise<string> {
  const requested = requireAbsolutePath(
    quarantineRootInput,
    "Offline backup quarantine root",
  );
  const requestedParent = path.dirname(requested);
  const parent = await canonicalRealDirectory(
    requestedParent,
    "Offline backup quarantine parent",
  );
  const basename = path.basename(requested);
  assertSafeFilename(basename);
  const expectedRoot = path.join(parent, basename);
  assertDisjointRoots(vaultRoot, expectedRoot);

  const initialStat = await lstatIfPresent(expectedRoot);
  if (initialStat) {
    if (!initialStat.isDirectory() || initialStat.isSymbolicLink()) {
      throw new Error(
        "Offline backup quarantine root must be a real non-linked directory.",
      );
    }
  } else {
    await mkdir(expectedRoot);
  }

  const rootStat = await lstat(expectedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(
      "Offline backup quarantine root must be a real non-linked directory.",
    );
  }
  const quarantineRoot = await realpath(expectedRoot);
  assertDirectChild(
    parent,
    quarantineRoot,
    basename,
    "quarantine root",
  );
  assertDisjointRoots(vaultRoot, quarantineRoot);
  const existingEntries = await readdir(quarantineRoot);
  if (existingEntries.length > 0) {
    throw new Error(
      "Offline backup quarantine must be uniquely empty; refusing an existing destination or overwrite.",
    );
  }
  return quarantineRoot;
}

async function canonicalRealDirectory(
  value: string,
  label: string,
): Promise<string> {
  const absolute = requireAbsolutePath(value, label);
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real non-linked directory.`);
  }
  return realpath(absolute);
}

async function assertConfinedRegularFile(
  candidatePath: string,
  root: string,
  expectedFilename: string,
  label: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  assertDirectChild(root, candidatePath, expectedFilename, label);
  const stat = await lstat(candidatePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `Offline owned vault backup ${label} must be a real regular file.`,
    );
  }
  const canonicalCandidate = await realpath(candidatePath);
  assertDirectChild(root, canonicalCandidate, expectedFilename, label);
  return stat;
}

function assertDirectChild(
  root: string,
  candidate: string,
  expectedFilename: string,
  label: string,
): void {
  if (
    filesystemPathKey(path.dirname(candidate)) !== filesystemPathKey(root) ||
    filesystemPathKey(path.basename(candidate)) !==
      filesystemPathKey(expectedFilename)
  ) {
    throw new Error(
      `Offline owned vault backup ${label} escaped its approved root.`,
    );
  }
}

function assertDisjointRoots(vaultRoot: string, quarantineRoot: string): void {
  if (
    isAtOrWithin(vaultRoot, quarantineRoot) ||
    isAtOrWithin(quarantineRoot, vaultRoot)
  ) {
    throw new Error(
      "Offline backup quarantine root must be outside and disjoint from the vault.",
    );
  }
}

function isAtOrWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSafeFilename(value: string): void {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error("Offline backup quarantine rejected an unsafe filename.");
  }
}

function requireAbsolutePath(value: string, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute.`);
  }
  return path.resolve(value);
}

async function lstatIfPresent(
  value: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return lstat(value).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function filesystemPathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
