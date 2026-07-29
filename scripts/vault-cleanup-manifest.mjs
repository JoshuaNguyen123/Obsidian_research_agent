/**
 * Crash-recovery sweep for e2e vault residue.
 *
 * The native Obsidian harness writes `test-results/vault-cleanup-manifest.json`
 * when it snapshots the vault and deletes it after a successful restore. A
 * manifest that survives means the run was killed mid-flight, so its
 * machine-generated files were never cleaned — the exact accumulation that once
 * left a truncated run log freezing Obsidian's indexer on every vault open.
 *
 * This module applies that manifest: it removes files under the machine
 * generated roots (and root-level markdown notes) that are NEW relative to the
 * manifest baseline and not in the retain list. Pre-existing user files are in
 * the baseline by construction and are never touched. Symlinked roots or
 * entries abort the sweep rather than following the link.
 */
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";

export const MACHINE_GENERATED_ROOTS = [
  "Agent Runs",
  "Agent Sources",
  "Agent Work",
  // The crash path has no separate owned-tree pass, so seed notes and
  // semantic indexes from a killed run are swept here as well.
  "E2E Agent Tests",
];

export async function applyLeftoverVaultCleanupManifest(
  manifestPath,
  expectedVaultRoot,
) {
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { applied: false, removedFiles: 0 };
    throw error;
  }
  const manifest = JSON.parse(raw);
  if (
    manifest?.version !== 1 ||
    typeof manifest.vaultRoot !== "string" ||
    !Array.isArray(manifest.machineFiles) ||
    !Array.isArray(manifest.machineDirectories) ||
    !Array.isArray(manifest.retainPaths)
  ) {
    throw new Error(`Unsupported vault cleanup manifest at ${manifestPath}.`);
  }
  const vaultRoot = manifest.vaultRoot;
  if (typeof expectedVaultRoot !== "string" || !path.isAbsolute(expectedVaultRoot)) {
    throw new Error(
      "Vault cleanup manifest application requires the exact expected vault root.",
    );
  }
  const [canonicalExpectedRoot, canonicalManifestRoot] = await Promise.all([
    realpath(expectedVaultRoot),
    realpath(vaultRoot).catch(() => null),
  ]);
  if (
    !canonicalManifestRoot ||
    pathKey(canonicalManifestRoot) !== pathKey(canonicalExpectedRoot)
  ) {
    throw new Error(
      `Vault cleanup manifest root does not match the current isolated vault: ${vaultRoot}.`,
    );
  }
  const rootStat = await lstat(vaultRoot).catch((error) =>
    error?.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    await rm(manifestPath, { force: true });
    return { applied: false, removedFiles: 0 };
  }

  const baselineFiles = new Set(manifest.machineFiles);
  const baselineDirectories = new Set(manifest.machineDirectories);
  const retained = new Set(
    manifest.retainPaths.map((value) => String(value).replace(/\\/gu, "/").toLowerCase()),
  );
  const listing = await readMachineListing(vaultRoot);
  let removedFiles = 0;
  for (const relativePath of listing.files) {
    if (baselineFiles.has(relativePath)) continue;
    if (retained.has(relativePath.toLowerCase())) continue;
    const absolute = containedPath(vaultRoot, relativePath);
    const stat = await lstat(absolute).catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error),
    );
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing to remove a linked or non-file artifact: ${relativePath}`);
    }
    await rm(absolute, { force: true });
    removedFiles += 1;
  }
  for (const relativeDirectory of [...listing.directories].sort(
    (left, right) => right.split("/").length - left.split("/").length,
  )) {
    if (baselineDirectories.has(relativeDirectory)) continue;
    await rmdir(containedPath(vaultRoot, relativeDirectory)).catch((error) => {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    });
  }
  await rm(manifestPath, { force: true });
  return { applied: true, removedFiles };
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readMachineListing(vaultRoot) {
  const files = new Set();
  const directories = new Set();
  const visit = async (absolute, relative) => {
    for (const entry of await readDirectorySafe(absolute)) {
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`Vault cleanup refuses a linked path: ${childRelative}`);
      }
      if (entry.isDirectory()) {
        directories.add(childRelative);
        await visit(path.join(absolute, entry.name), childRelative);
      } else if (entry.isFile()) {
        files.add(childRelative);
      }
    }
  };
  for (const root of MACHINE_GENERATED_ROOTS) {
    const absolute = containedPath(vaultRoot, root);
    const stat = await lstat(absolute).catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error),
    );
    if (stat?.isSymbolicLink()) {
      throw new Error(`Vault cleanup refuses a linked root: ${root}`);
    }
    await visit(absolute, root);
  }
  for (const entry of await readDirectorySafe(vaultRoot)) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.add(entry.name);
    }
  }
  return { files, directories };
}

async function readDirectorySafe(directory) {
  return readdir(directory, { withFileTypes: true }).catch((error) =>
    error?.code === "ENOENT" ? [] : Promise.reject(error),
  );
}

function containedPath(root, relativePath) {
  const target = path.resolve(root, ...String(relativePath).replace(/\\/gu, "/").split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Vault cleanup path escaped the vault root.");
  }
  return target;
}
