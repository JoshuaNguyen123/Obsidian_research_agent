import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_ARTIFACTS,
  PLUGIN_CATALOG,
  validatePluginCatalog,
} from "./plugin-catalog.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = process.env.OBSIDIAN_VAULT ?? getDefaultVaultRoot();
const pluginsRoot = path.join(vaultRoot, ".obsidian", "plugins");

async function main() {
  await validatePluginCatalog(repoRoot);
  const dataJsonBefore = await snapshotExistingDataJson(pluginsRoot);
  let syncError = null;

  try {
    for (const plugin of PLUGIN_CATALOG) {
      await syncPlugin(plugin);
    }
  } catch (error) {
    syncError = error;
  }

  let dataJsonError = null;
  try {
    const dataJsonAfter = await snapshotExistingDataJson(pluginsRoot);
    assertDataJsonUnchanged(dataJsonBefore, dataJsonAfter);
  } catch (error) {
    dataJsonError = error;
  }

  if (syncError && dataJsonError) {
    throw new AggregateError(
      [syncError, dataJsonError],
      "Plugin sync failed and data.json preservation could not be verified.",
    );
  }
  if (syncError) throw syncError;
  if (dataJsonError) throw dataJsonError;

  console.log(
    `Synced ${PLUGIN_CATALOG.length} plugin artifact sets to ${pluginsRoot}`,
  );
  console.log(
    `Verified only ${PLUGIN_ARTIFACTS.join(", ")} were copied for each plugin.`,
  );
  console.log(
    `Hash-verified ${dataJsonBefore.size} existing data.json file(s) before and after sync.`,
  );
}

async function syncPlugin(plugin) {
  const sourceRoot = path.resolve(repoRoot, plugin.sourceDir);
  const pluginDir = path.join(pluginsRoot, plugin.id);
  await mkdir(pluginDir, { recursive: true });

  for (const artifact of PLUGIN_ARTIFACTS) {
    const source = path.join(sourceRoot, artifact);
    const destination = path.join(pluginDir, artifact);
    await assertFile(source, `${plugin.id}/${artifact}`);
    await copyFile(source, destination);
    await assertSameFile(source, destination, `${plugin.id}/${artifact}`);
  }

  const installedManifest = JSON.parse(
    await readFile(path.join(pluginDir, "manifest.json"), "utf8"),
  );
  if (
    installedManifest.id !== plugin.id ||
    installedManifest.version !== plugin.expectedVersion
  ) {
    throw new Error(
      `Installed manifest drift for ${plugin.id}: id=${String(installedManifest.id)}, version=${String(installedManifest.version)}.`,
    );
  }
  console.log(`Synced ${plugin.id}@${plugin.expectedVersion}`);
}

async function snapshotExistingDataJson(root) {
  const snapshot = new Map();
  await walk(root);
  return snapshot;

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name === "data.json") {
        const relativePath = path.relative(root, entryPath).replaceAll("\\", "/");
        snapshot.set(relativePath, await hashFile(entryPath));
      }
    }
  }
}

function assertDataJsonUnchanged(before, after) {
  const changed = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const filePath of [...paths].sort()) {
    if (before.get(filePath) !== after.get(filePath)) changed.push(filePath);
  }
  if (changed.length > 0) {
    throw new Error(
      `data.json preservation failed for: ${changed.join(", ")}`,
    );
  }
}

async function assertFile(filePath, label) {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error(`Missing required artifact: ${label}`);
  }
}

async function assertSameFile(source, destination, label) {
  const [sourceHash, destinationHash] = await Promise.all([
    hashFile(source),
    hashFile(destination),
  ]);
  if (sourceHash !== destinationHash) {
    throw new Error(`Copied artifact is stale: ${label}`);
  }
}

async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function getDefaultVaultRoot() {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) {
    throw new Error("Set OBSIDIAN_VAULT to the live test vault path.");
  }
  return path.join(userProfile, "OneDrive", "Desktop", "test_vault_obsidian_ai");
}

main().catch((error) => {
  if (error instanceof AggregateError) {
    console.error(error.message);
    for (const nested of error.errors) {
      console.error(`- ${nested instanceof Error ? nested.message : String(nested)}`);
    }
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
