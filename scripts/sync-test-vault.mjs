import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = process.env.OBSIDIAN_VAULT ?? getDefaultVaultRoot();
const pluginDir = path.join(
  vaultRoot,
  ".obsidian",
  "plugins",
  "agentic-researcher",
);
const artifacts = ["main.js", "styles.css", "manifest.json"];

async function main() {
  await mkdir(pluginDir, { recursive: true });

  for (const artifact of artifacts) {
    const source = path.join(repoRoot, artifact);
    const destination = path.join(pluginDir, artifact);

    await assertFile(source, artifact);
    await copyFile(source, destination);
    await assertSameFile(source, destination, artifact);
  }

  await assertContains(path.join(pluginDir, "main.js"), "Agentic Researcher");
  await assertContains(
    path.join(pluginDir, "styles.css"),
    "agentic-researcher-view",
  );
  await assertContains(path.join(pluginDir, "manifest.json"), "agentic-researcher");

  console.log(`Synced plugin artifacts to ${pluginDir}`);
  console.log("Verified main.js, styles.css, and manifest.json are current.");
  console.log("Left data.json untouched.");
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

async function assertContains(filePath, expectedText) {
  const content = await readFile(filePath, "utf8");
  if (!content.includes(expectedText)) {
    throw new Error(
      `Installed artifact ${path.basename(filePath)} is missing ${expectedText}`,
    );
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
