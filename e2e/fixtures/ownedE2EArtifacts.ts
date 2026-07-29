import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 50_000;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const OWNED_TREE = "E2E Agent Tests";
/**
 * Vault areas the product itself writes during a mission. Ownership here is
 * diff-based: anything that appears under these roots (or as a root-level
 * markdown note) after the pre-run snapshot was created during this harness
 * session and is removed at close unless the lane retains it. Content-marker
 * matching was abandoned after real-AI lanes (CRDT_/FLOW_REAL_ markers) left
 * 100+ run logs behind — one of them, truncated by a crash, froze Obsidian's
 * indexer on every subsequent vault open.
 */
const MACHINE_GENERATED_ROOTS = [
  "Agent Runs",
  "Agent Sources",
  "Agent Work",
] as const;
const OWNED_FIXED_FILES = [
  "Agent Memory/semantic-vault-index.json",
  "Agent Memory/Semantic Vault Index.md",
] as const;

export interface OwnedE2EArtifactSnapshotV1 {
  version: 1;
  vaultRoot: string;
  /** Existing test-tree files are path baselines; scenarios use unique paths. */
  treeFiles: Set<string>;
  treeDirectories: Set<string>;
  designFiles: Set<string>;
  /** Pre-run listing of machine-generated files; new ones are removed. */
  machineFiles: Set<string>;
  machineDirectories: Set<string>;
  /** Only fixed shared fixtures need byte restoration after each scenario. */
  fixedFiles: Map<string, Uint8Array>;
}

export interface RestoreOwnedE2EArtifactOptionsV1 {
  /**
   * Vault-relative paths a lane deliberately keeps (e.g. the retained-journey
   * deliverable note). Compared case-insensitively with forward slashes.
   */
  retainPaths?: readonly string[];
}

/** JSON-serializable cleanup contract for crash recovery via preflight. */
export interface VaultCleanupManifestV1 {
  version: 1;
  vaultRoot: string;
  machineFiles: string[];
  machineDirectories: string[];
  retainPaths: string[];
}

export function vaultCleanupManifestFromSnapshot(
  snapshot: OwnedE2EArtifactSnapshotV1,
  retainPaths: readonly string[] = [],
): VaultCleanupManifestV1 {
  // The crash sweeper has no separate tree pass, so the manifest baseline must
  // also carry the owned E2E test tree — otherwise a killed run's seed note
  // and semantic index survive preflight (observed live before this merge).
  return {
    version: 1,
    vaultRoot: snapshot.vaultRoot,
    machineFiles: [...snapshot.machineFiles, ...snapshot.treeFiles].sort(),
    machineDirectories: [
      ...snapshot.machineDirectories,
      ...snapshot.treeDirectories,
    ].sort(),
    retainPaths: [...retainPaths],
  };
}

/**
 * Applies a leftover cleanup manifest (a prior run was killed before its own
 * restore). Removes only machine-generated files that are new relative to the
 * manifest baseline and not retained. Returns the removed file count.
 */
export async function applyVaultCleanupManifest(
  manifest: VaultCleanupManifestV1,
): Promise<{ removedFiles: number }> {
  if (
    manifest?.version !== 1 ||
    typeof manifest.vaultRoot !== "string" ||
    !Array.isArray(manifest.machineFiles) ||
    !Array.isArray(manifest.machineDirectories) ||
    !Array.isArray(manifest.retainPaths)
  ) {
    throw new Error("Unsupported vault cleanup manifest.");
  }
  const vaultRoot = await canonicalDirectory(manifest.vaultRoot).catch(
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (!vaultRoot) return { removedFiles: 0 };
  return removeNewMachineGeneratedFiles(
    vaultRoot,
    new Set(manifest.machineFiles),
    new Set(manifest.machineDirectories),
    manifest.retainPaths,
    { includeOwnedTree: true },
  );
}

let cachedTreeBaseline: {
  vaultRoot: string;
  treeFiles: Set<string>;
  treeDirectories: Set<string>;
  designFiles: Set<string>;
} | null = null;

/**
 * Snapshots only explicitly test-owned vault paths. Existing tree/design paths
 * form an immutable baseline, while the two shared semantic fixtures retain
 * exact bytes. Agent Runs are captured per scenario and removed only when a
 * new, bounded run/graph file also contains an E2E ownership marker. Restore
 * rewrites only fixed fixtures; notes outside these boundaries are untouched.
 */
export async function snapshotOwnedE2EArtifacts(
  vaultRootInput: string,
): Promise<OwnedE2EArtifactSnapshotV1> {
  const vaultRoot = await canonicalDirectory(vaultRootInput);
  const baseline = cachedTreeBaseline?.vaultRoot === vaultRoot
    ? cachedTreeBaseline
    : await readTreeBaseline(vaultRoot);
  cachedTreeBaseline = baseline;
  const machineListing = await readMachineGeneratedListing(vaultRoot);
  const fixedFiles = new Map<string, Uint8Array>();
  let totalBytes = 0;
  const capture = async (relativePath: string) => {
    const normalized = ownedRelativePath(relativePath);
    const absolute = containedPath(vaultRoot, normalized);
    const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : Promise.reject(error));
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`E2E artifact snapshot rejects non-regular path: ${normalized}`);
    }
    const bytes = await readFile(absolute);
    totalBytes += bytes.byteLength;
    if (fixedFiles.size >= MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("E2E artifact snapshot exceeded its fixed file or byte bound.");
    }
    fixedFiles.set(normalized, new Uint8Array(bytes));
  };
  for (const file of OWNED_FIXED_FILES) await capture(file);
  assertSnapshotFileCap(
    baseline.treeFiles.size +
      baseline.designFiles.size +
      machineListing.files.size +
      fixedFiles.size,
  );
  return {
    version: 1,
    vaultRoot,
    treeFiles: new Set(baseline.treeFiles),
    treeDirectories: new Set(baseline.treeDirectories),
    designFiles: new Set(baseline.designFiles),
    machineFiles: machineListing.files,
    machineDirectories: machineListing.directories,
    fixedFiles,
  };
}

export async function restoreOwnedE2EArtifacts(
  snapshot: OwnedE2EArtifactSnapshotV1,
  options: RestoreOwnedE2EArtifactOptionsV1 = {},
): Promise<void> {
  if (
    snapshot.version !== 1 ||
    !(snapshot.treeFiles instanceof Set) ||
    !(snapshot.treeDirectories instanceof Set) ||
    !(snapshot.designFiles instanceof Set) ||
    !(snapshot.machineFiles instanceof Set) ||
    !(snapshot.machineDirectories instanceof Set) ||
    !(snapshot.fixedFiles instanceof Map)
  ) {
    throw new Error("Unsupported E2E artifact snapshot.");
  }
  const vaultRoot = await canonicalDirectory(snapshot.vaultRoot);
  const ownedTree = containedPath(vaultRoot, OWNED_TREE);
  await assertNotLinkedIfPresent(ownedTree);
  const currentTree = await readOwnedTreePaths(ownedTree, OWNED_TREE);
  for (const relativePath of currentTree.files) {
    if (!snapshot.treeFiles.has(relativePath)) {
      await rm(containedPath(vaultRoot, relativePath), { force: true });
    }
  }
  for (const relativeDirectory of [...currentTree.directories].sort(
    (left, right) => right.split("/").length - left.split("/").length,
  )) {
    if (!snapshot.treeDirectories.has(relativeDirectory)) {
      await rmdir(containedPath(vaultRoot, relativeDirectory)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
        },
      );
    }
  }

  const designsRoot = containedPath(vaultRoot, "Designs");
  for (const entry of await readDirectory(designsRoot)) {
    if (entry.name.startsWith("e2e-") && entry.isSymbolicLink()) {
      throw new Error("Refusing to remove a linked E2E design fixture.");
    }
    const relativePath = `Designs/${entry.name}`;
    if (
      entry.isFile() &&
      /^e2e-[^/\\]+\.(?:canvas|svg|md)$/u.test(entry.name) &&
      !snapshot.designFiles.has(relativePath)
    ) {
      await rm(containedPath(vaultRoot, relativePath), { force: true });
    }
  }
  await removeNewMachineGeneratedFiles(
    vaultRoot,
    snapshot.machineFiles,
    snapshot.machineDirectories,
    options.retainPaths ?? [],
  );
  for (const fixed of OWNED_FIXED_FILES) {
    await rm(containedPath(vaultRoot, fixed), { force: true });
  }
  for (const [relativePath, bytes] of snapshot.fixedFiles) {
    const normalized = ownedRelativePath(relativePath);
    const absolute = containedPath(vaultRoot, normalized);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes, { flag: "w" });
  }
}

async function readTreeBaseline(vaultRoot: string) {
  const tree = await readOwnedTreePaths(
    containedPath(vaultRoot, OWNED_TREE),
    OWNED_TREE,
  );
  if (tree.files.size > MAX_FILES) {
    throw new Error("E2E artifact snapshot exceeded its fixed file bound.");
  }
  const designFiles = new Set<string>();
  for (const entry of await readDirectory(containedPath(vaultRoot, "Designs"))) {
    if (entry.isSymbolicLink() && entry.name.startsWith("e2e-")) {
      throw new Error("E2E artifact snapshot rejects a linked design fixture.");
    }
    if (entry.isFile() && /^e2e-[^/\\]+\.(?:canvas|svg|md)$/u.test(entry.name)) {
      designFiles.add(`Designs/${entry.name}`);
    }
  }
  return {
    vaultRoot,
    treeFiles: tree.files,
    treeDirectories: tree.directories,
    designFiles,
  };
}

/**
 * Recursive listing of every machine-generated root plus root-level markdown
 * notes (mission seed notes land at the vault root). Symlinks are refused
 * anywhere in the walk.
 */
async function readMachineGeneratedListing(
  vaultRoot: string,
  options: { includeOwnedTree?: boolean } = {},
): Promise<{ files: Set<string>; directories: Set<string> }> {
  const files = new Set<string>();
  const directories = new Set<string>();
  const roots = options.includeOwnedTree
    ? [...MACHINE_GENERATED_ROOTS, OWNED_TREE]
    : [...MACHINE_GENERATED_ROOTS];
  for (const root of roots) {
    const absolute = containedPath(vaultRoot, root);
    await assertNotLinkedIfPresent(absolute);
    const tree = await readOwnedTreePaths(absolute, root);
    for (const file of tree.files) {
      files.add(file);
      assertSnapshotFileCap(files.size);
    }
    for (const directory of tree.directories) directories.add(directory);
  }
  for (const entry of await readDirectory(vaultRoot)) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.add(entry.name);
      assertSnapshotFileCap(files.size);
    }
  }
  return { files, directories };
}

async function removeNewMachineGeneratedFiles(
  vaultRoot: string,
  baselineFiles: ReadonlySet<string>,
  baselineDirectories: ReadonlySet<string>,
  retainPaths: readonly string[],
  options: { includeOwnedTree?: boolean } = {},
): Promise<{ removedFiles: number }> {
  const retained = new Set(
    retainPaths.map((value) => value.replace(/\\/gu, "/").toLowerCase()),
  );
  const isRetained = (relativePath: string) =>
    retained.has(relativePath.toLowerCase());
  const current = await readMachineGeneratedListing(vaultRoot, options);
  let removedFiles = 0;
  for (const relativePath of current.files) {
    if (baselineFiles.has(relativePath) || isRetained(relativePath)) continue;
    const absolute = containedPath(vaultRoot, relativePath);
    const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : Promise.reject(error));
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `Refusing to remove a linked or non-file machine artifact: ${relativePath}`,
      );
    }
    await rm(absolute, { force: true });
    removedFiles += 1;
  }
  // Deepest-first so nested new directories fold up; retained descendants
  // keep their ancestors alive via ENOTEMPTY.
  for (const relativeDirectory of [...current.directories].sort(
    (left, right) => right.split("/").length - left.split("/").length,
  )) {
    if (baselineDirectories.has(relativeDirectory)) continue;
    await rmdir(containedPath(vaultRoot, relativeDirectory)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      },
    );
  }
  return { removedFiles };
}

function assertSnapshotFileCap(fileCount: number): void {
  if (fileCount > MAX_FILES) {
    throw new Error("E2E artifact snapshot exceeded its fixed file bound.");
  }
}

async function readOwnedTreePaths(
  absoluteDirectory: string,
  relativeDirectory: string,
): Promise<{ files: Set<string>; directories: Set<string> }> {
  const files = new Set<string>();
  const directories = new Set<string>();
  const visit = async (absolute: string, relative: string): Promise<void> => {
    for (const entry of await readDirectory(absolute)) {
      const childRelative = `${relative}/${entry.name}`.replace(/\\/gu, "/");
      if (entry.isSymbolicLink()) {
        throw new Error(`E2E artifact snapshot rejects linked path: ${childRelative}`);
      }
      if (entry.isDirectory()) {
        directories.add(childRelative);
        await visit(path.join(absolute, entry.name), childRelative);
      } else if (entry.isFile()) {
        files.add(childRelative);
        if (files.size > MAX_FILES) {
          throw new Error("E2E artifact snapshot exceeded its fixed file bound.");
        }
      }
    }
  };
  await visit(absoluteDirectory, relativeDirectory);
  return { files, directories };
}

async function readDirectory(directory: string) {
  return readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : Promise.reject(error),
  );
}

async function canonicalDirectory(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error("E2E vault root must be absolute.");
  const stat = await lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("E2E vault root must be a real directory.");
  }
  return realpath(value);
}

async function assertNotLinkedIfPresent(target: string): Promise<void> {
  const stat = await lstat(target).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error));
  if (stat?.isSymbolicLink()) {
    throw new Error("Refusing recursive cleanup of a linked E2E artifact tree.");
  }
}

function ownedRelativePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  const owned =
    normalized === OWNED_TREE ||
    normalized.startsWith(`${OWNED_TREE}/`) ||
    /^Designs\/e2e-[^/]+\.(?:canvas|svg|md)$/u.test(normalized) ||
    OWNED_FIXED_FILES.includes(normalized as typeof OWNED_FIXED_FILES[number]);
  if (
    !owned ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Path is outside the E2E-owned artifact boundary: ${value}`);
  }
  return normalized;
}

function containedPath(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.replace(/\\/gu, "/").split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("E2E artifact path escaped the canonical test vault.");
  }
  return target;
}
