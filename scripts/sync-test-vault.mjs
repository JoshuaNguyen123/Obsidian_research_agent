import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
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
const retiredPluginsRoot = path.join(
  pluginsRoot,
  ".agentic-researcher-retired",
);
const LEGACY_PLUGIN_IDS = Object.freeze([
  "agentic-researcher-code",
  "agentic-researcher-integrations",
  "agentic-researcher-companion",
]);

async function main() {
  await validatePluginCatalog(repoRoot);
  const dataJsonBefore = await snapshotExistingDataJson(pluginsRoot);
  let syncError = null;
  let relocations = new Map();

  try {
    relocations = await retireLegacyPluginFolders();
    for (const plugin of PLUGIN_CATALOG) {
      await syncPlugin(plugin);
    }
    await consolidateCommunityPluginRegistry();
  } catch (error) {
    syncError = error;
  }

  let dataJsonError = null;
  try {
    const dataJsonAfter = await snapshotExistingDataJson(pluginsRoot);
    assertDataJsonPreserved(dataJsonBefore, dataJsonAfter, relocations);
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
    process.env.CI
      ? `Synced ${PLUGIN_CATALOG.length} plugin artifact sets to the isolated test vault.`
      : `Synced ${PLUGIN_CATALOG.length} plugin artifact sets to ${pluginsRoot}`,
  );
  console.log(
    `Verified only ${PLUGIN_ARTIFACTS.join(", ")} were copied for each plugin.`,
  );
  console.log(
    `Hash-verified ${dataJsonBefore.size} existing data.json file(s) before and after sync.`,
  );
  if (relocations.size > 0) {
    console.log(
      `Retired ${relocations.size} legacy plugin folder(s) without deleting their data.json files.`,
    );
  }
}

async function consolidateCommunityPluginRegistry() {
  const filePath = path.join(vaultRoot, ".obsidian", "community-plugins.json");
  let enabled = [];
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error(`Community plugin registry must be a string array: ${filePath}`);
    }
    enabled = parsed;
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }
  const legacy = new Set(LEGACY_PLUGIN_IDS);
  const coreId = PLUGIN_CATALOG[0].id;
  const removedLegacyCount = enabled.filter((pluginId) => legacy.has(pluginId)).length;
  const consolidated = enabled.filter((pluginId) => !legacy.has(pluginId));
  if (!consolidated.includes(coreId)) consolidated.unshift(coreId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(consolidated, null, 2)}\n`, "utf8");
  console.log(
    `Enabled ${coreId} and removed ${removedLegacyCount} legacy registry entr${removedLegacyCount === 1 ? "y" : "ies"}.`,
  );
}

async function retireLegacyPluginFolders() {
  const relocations = new Map();
  await mkdir(retiredPluginsRoot, { recursive: true });
  assertContainedPath(pluginsRoot, retiredPluginsRoot, "retired plugin root");
  for (const pluginId of LEGACY_PLUGIN_IDS) {
    const source = path.join(pluginsRoot, pluginId);
    const destination = path.join(retiredPluginsRoot, pluginId);
    assertContainedPath(pluginsRoot, source, `legacy plugin ${pluginId}`);
    assertContainedPath(pluginsRoot, destination, `retired plugin ${pluginId}`);
    const sourceStat = await lstat(source).catch((error) => {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!sourceStat) continue;
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`Refusing to retire unsafe plugin path: ${source}`);
    }
    const destinationStat = await lstat(destination).catch((error) => {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (destinationStat) {
      throw new Error(
        `Cannot retire ${pluginId}: preserved destination already exists at ${destination}.`,
      );
    }
    await rename(source, destination);
    relocations.set(
      `${pluginId}/data.json`,
      `.agentic-researcher-retired/${pluginId}/data.json`,
    );
    console.log(`Retired legacy plugin folder ${pluginId}`);
  }
  return relocations;
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

function assertDataJsonPreserved(before, after, relocations) {
  const changed = [];
  const expectedAfter = new Map();
  for (const [filePath, hash] of before) {
    expectedAfter.set(relocations.get(filePath) ?? filePath, hash);
  }
  const paths = new Set([...expectedAfter.keys(), ...after.keys()]);
  for (const filePath of [...paths].sort()) {
    if (expectedAfter.get(filePath) !== after.get(filePath)) {
      changed.push(filePath);
    }
  }
  if (changed.length > 0) {
    throw new Error(
      `data.json preservation failed for: ${changed.join(", ")}`,
    );
  }
}

function assertContainedPath(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate === resolvedRoot ||
    !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Unsafe ${label} path: ${resolvedCandidate}`);
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
