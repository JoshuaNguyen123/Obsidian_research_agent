import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ARTIFACTS = Object.freeze([
  "main.js",
  "styles.css",
  "manifest.json",
]);

export const PLUGIN_CATALOG = Object.freeze([
  Object.freeze({
    key: "core",
    id: "agentic-researcher",
    sourceDir: ".",
    entry: "main.ts",
    outfile: "main.js",
    expectedVersion: "0.4.0",
    desktopOnly: true,
    required: true,
  }),
]);

export async function validatePluginCatalog(repoRoot) {
  const ids = new Set();
  for (const plugin of PLUGIN_CATALOG) {
    if (ids.has(plugin.id)) {
      throw new Error(`Duplicate plugin id in catalog: ${plugin.id}`);
    }
    ids.add(plugin.id);

    const sourceRoot = path.resolve(repoRoot, plugin.sourceDir);
    const [packageJson, manifest, versions] = await Promise.all([
      readJson(path.join(sourceRoot, "package.json")),
      readJson(path.join(sourceRoot, "manifest.json")),
      readJson(path.join(sourceRoot, "versions.json")),
    ]);

    if (manifest.id !== plugin.id) {
      throw new Error(
        `Plugin id drift for ${plugin.key}: expected ${plugin.id}, found ${String(manifest.id)}.`,
      );
    }
    if (
      packageJson.version !== plugin.expectedVersion ||
      manifest.version !== plugin.expectedVersion
    ) {
      throw new Error(
        `Plugin version drift for ${plugin.id}: expected ${plugin.expectedVersion}, package=${String(packageJson.version)}, manifest=${String(manifest.version)}.`,
      );
    }
    if (versions[plugin.expectedVersion] !== manifest.minAppVersion) {
      throw new Error(
        `versions.json drift for ${plugin.id}@${plugin.expectedVersion}: expected minAppVersion ${String(manifest.minAppVersion)}.`,
      );
    }
    if (manifest.isDesktopOnly !== plugin.desktopOnly) {
      throw new Error(
        `Desktop-only drift for ${plugin.id}: expected ${String(plugin.desktopOnly)}.`,
      );
    }
  }
  return PLUGIN_CATALOG;
}

async function readJson(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`Missing plugin catalog file: ${filePath}`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in plugin catalog file: ${filePath}`);
  }
}

const directScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (directScript) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await validatePluginCatalog(repoRoot);
  console.log(
    `Plugin catalog passed: ${PLUGIN_CATALOG.map((plugin) => `${plugin.id}@${plugin.expectedVersion}`).join(", ")}`,
  );
}
