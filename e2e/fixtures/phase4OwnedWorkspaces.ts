import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

const PHASE4_WORKSPACE_NAME =
  /^phase4-(?:crud|repair)-e2e_phase4_\d+-\d+$/u;

export interface Phase4OwnedWorkspaceSnapshotV1 {
  version: 1;
  root: string;
  existingNames: Set<string>;
}

/**
 * Captures names only. Workspace bytes are never read, and pre-existing
 * containers remain outside the harness cleanup boundary.
 */
export async function snapshotPhase4OwnedWorkspaces(
  rootInput: string,
): Promise<Phase4OwnedWorkspaceSnapshotV1> {
  const root = requireAbsolutePath(rootInput);
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error));
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error("Phase 4 workspace root must be a real directory.");
  }
  return {
    version: 1,
    root: stat ? await realpath(root) : root,
    existingNames: new Set((await readDirectory(root)).map((entry) => entry.name)),
  };
}

/** Remove only new, exact-marker Phase 4 containers after Obsidian exits. */
export async function removeNewPhase4OwnedWorkspaces(
  snapshot: Phase4OwnedWorkspaceSnapshotV1,
  marker: string,
): Promise<void> {
  if (snapshot.version !== 1 || !(snapshot.existingNames instanceof Set)) {
    throw new Error("Unsupported Phase 4 workspace snapshot.");
  }
  const normalizedMarker = marker.trim().toLowerCase();
  if (!/^e2e_phase4_\d+-\d+$/u.test(normalizedMarker)) {
    throw new Error("Phase 4 cleanup marker is invalid.");
  }
  const root = requireAbsolutePath(snapshot.root);
  const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error));
  if (!rootStat) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Phase 4 workspace cleanup rejects a linked root.");
  }
  const canonicalRoot = await realpath(root);
  for (const entry of await readDirectory(canonicalRoot)) {
    if (snapshot.existingNames.has(entry.name)) continue;
    const normalizedName = entry.name.toLowerCase();
    if (
      !PHASE4_WORKSPACE_NAME.test(normalizedName) ||
      !normalizedName.endsWith(normalizedMarker)
    ) {
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Refusing to remove non-directory Phase 4 workspace ${entry.name}.`);
    }
    const candidate = path.join(canonicalRoot, entry.name);
    const canonicalCandidate = await realpath(candidate);
    if (
      path.dirname(canonicalCandidate) !== canonicalRoot ||
      path.basename(canonicalCandidate) !== entry.name
    ) {
      throw new Error(`Phase 4 workspace escaped its cleanup root: ${entry.name}.`);
    }
    await rm(canonicalCandidate, { recursive: true, force: true });
  }
}

function requireAbsolutePath(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error("Phase 4 workspace root must be absolute.");
  }
  return path.resolve(value);
}

async function readDirectory(directory: string) {
  return readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : Promise.reject(error),
  );
}
