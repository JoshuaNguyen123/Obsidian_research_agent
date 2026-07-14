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
const MAX_AGENT_RUN_OWNERSHIP_BYTES = 2 * 1024 * 1024;
const OWNED_TREE = "E2E Agent Tests";
const AGENT_RUNS_ROOT = "Agent Runs";
const MISSION_GRAPHS_ROOT = "Agent Runs/Mission Graphs";
const E2E_AGENT_RUN_MARKER =
  /(?:\bE2E_MARKER_\d+_\d+\b|\bE2E_[A-Z0-9][A-Z0-9_]*\b|E2E Agent Tests[\\/])/u;
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
  /** Agent run paths are captured per scenario; content is never snapshotted. */
  agentRunFiles: Set<string>;
  /** Only fixed shared fixtures need byte restoration after each scenario. */
  fixedFiles: Map<string, Uint8Array>;
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
  const agentRunFiles = await readAgentRunPaths(vaultRoot);
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
      agentRunFiles.size +
      fixedFiles.size,
  );
  return {
    version: 1,
    vaultRoot,
    treeFiles: new Set(baseline.treeFiles),
    treeDirectories: new Set(baseline.treeDirectories),
    designFiles: new Set(baseline.designFiles),
    agentRunFiles,
    fixedFiles,
  };
}

export async function restoreOwnedE2EArtifacts(
  snapshot: OwnedE2EArtifactSnapshotV1,
): Promise<void> {
  if (
    snapshot.version !== 1 ||
    !(snapshot.treeFiles instanceof Set) ||
    !(snapshot.treeDirectories instanceof Set) ||
    !(snapshot.designFiles instanceof Set) ||
    !(snapshot.agentRunFiles instanceof Set) ||
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
  await removeNewOwnedAgentRunFiles(vaultRoot, snapshot.agentRunFiles);
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

async function readAgentRunPaths(vaultRoot: string): Promise<Set<string>> {
  const files = new Set<string>();
  const agentRunsRoot = containedPath(vaultRoot, AGENT_RUNS_ROOT);
  await assertNotLinkedIfPresent(agentRunsRoot);
  const missionGraphsRoot = containedPath(vaultRoot, MISSION_GRAPHS_ROOT);

  const addFile = (relativePath: string) => {
    if (!isBoundedAgentRunFile(relativePath)) {
      throw new Error(`Agent run path escaped its bounded directories: ${relativePath}`);
    }
    files.add(relativePath);
    assertSnapshotFileCap(files.size);
  };

  for (const entry of await readDirectory(agentRunsRoot)) {
    const relativePath = `${AGENT_RUNS_ROOT}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`E2E artifact snapshot rejects linked path: ${relativePath}`);
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      addFile(relativePath);
    }
  }

  await assertNotLinkedIfPresent(missionGraphsRoot);
  for (const entry of await readDirectory(missionGraphsRoot)) {
    const relativePath = `${MISSION_GRAPHS_ROOT}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`E2E artifact snapshot rejects linked path: ${relativePath}`);
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      addFile(relativePath);
    }
  }
  return files;
}

async function removeNewOwnedAgentRunFiles(
  vaultRoot: string,
  baseline: Set<string>,
): Promise<void> {
  const current = await readAgentRunPaths(vaultRoot);
  for (const relativePath of current) {
    if (baseline.has(relativePath) || !isBoundedAgentRunFile(relativePath)) continue;
    const absolute = containedPath(vaultRoot, relativePath);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing to inspect a linked or non-file agent run: ${relativePath}`);
    }
    if (stat.size > MAX_AGENT_RUN_OWNERSHIP_BYTES) continue;
    const content = await readFile(absolute, "utf8");
    if (!E2E_AGENT_RUN_MARKER.test(content)) continue;
    const currentStat = await lstat(absolute);
    if (currentStat.isSymbolicLink() || !currentStat.isFile()) {
      throw new Error(`Refusing to remove a linked or non-file agent run: ${relativePath}`);
    }
    await rm(absolute, { force: true });
  }
}

function isBoundedAgentRunFile(relativePath: string): boolean {
  return (
    /^Agent Runs\/[^/\\]+\.md$/iu.test(relativePath) ||
    /^Agent Runs\/Mission Graphs\/[^/\\]+\.md$/iu.test(relativePath)
  );
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
