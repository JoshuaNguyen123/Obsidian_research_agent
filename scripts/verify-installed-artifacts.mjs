import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLUGIN_ARTIFACTS,
  PLUGIN_CATALOG,
  validatePluginCatalog,
} from "./plugin-catalog.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  await validatePluginCatalog(repoRoot);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "agentic-installed-artifacts-"));
  const vaultRoot = path.join(fixtureRoot, "vault");
  const pluginsRoot = path.join(vaultRoot, ".obsidian", "plugins");
  const dataJson = new Map();
  try {
    for (const [index, plugin] of PLUGIN_CATALOG.entries()) {
      const pluginRoot = path.join(pluginsRoot, plugin.id);
      await mkdir(pluginRoot, { recursive: true });
      const content = Buffer.from(
        JSON.stringify({ fixture: plugin.id, ordinal: index, preserve: true }, null, 2),
        "utf8",
      );
      await writeFile(path.join(pluginRoot, "data.json"), content, { flag: "wx" });
      await writeFile(path.join(pluginRoot, "main.js"), "stale fixture\n", { flag: "wx" });
      dataJson.set(plugin.id, content);
    }

    await runSync(vaultRoot);

    for (const plugin of PLUGIN_CATALOG) {
      const sourceRoot = path.resolve(repoRoot, plugin.sourceDir);
      const installedRoot = path.join(pluginsRoot, plugin.id);
      for (const artifact of PLUGIN_ARTIFACTS) {
        const [source, installed] = await Promise.all([
          readFile(path.join(sourceRoot, artifact)),
          readFile(path.join(installedRoot, artifact)),
        ]);
        if (sha256(source) !== sha256(installed)) {
          throw new Error(`Installed artifact is stale: ${plugin.id}/${artifact}.`);
        }
      }
      const preserved = await readFile(path.join(installedRoot, "data.json"));
      if (!preserved.equals(dataJson.get(plugin.id))) {
        throw new Error(`Installed sync changed ${plugin.id}/data.json.`);
      }
      const names = (await readdir(installedRoot)).sort();
      const expected = [...PLUGIN_ARTIFACTS, "data.json"].sort();
      if (names.join("\0") !== expected.join("\0")) {
        throw new Error(
          `Installed sync created unexpected files for ${plugin.id}: ${names.join(", ")}.`,
        );
      }
    }
    console.log(
      `Installed-artifact freshness passed for ${PLUGIN_CATALOG.length} plugins; ${PLUGIN_CATALOG.length} data.json files were byte-identical after sync.`,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function runSync(vaultRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/sync-test-vault.mjs"], {
      cwd: repoRoot,
      env: { ...process.env, OBSIDIAN_VAULT: vaultRoot },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const diagnostic = Buffer.concat([...stdout, ...stderr])
        .toString("utf8")
        .slice(0, 8_000);
      reject(new Error(`Test-vault sync exited ${String(code)}. ${diagnostic}`));
    });
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
