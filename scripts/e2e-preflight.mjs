import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const userProfile = process.env.USERPROFILE;
const vaultRoot =
  process.env.OBSIDIAN_VAULT ??
  (userProfile
    ? path.join(userProfile, "OneDrive", "Desktop", "test_vault_obsidian_ai")
    : "");
const cdpPort = Number.parseInt(process.env.OBSIDIAN_CDP_PORT ?? "11223", 10);
const pluginRoot = path.join(
  vaultRoot,
  ".obsidian",
  "plugins",
  "agentic-researcher",
);

const checks = [
  ["test vault", vaultRoot],
  ["installed main.js", path.join(pluginRoot, "main.js")],
  ["installed styles.css", path.join(pluginRoot, "styles.css")],
  ["installed manifest.json", path.join(pluginRoot, "manifest.json")],
];
const dataJsonPath = path.join(pluginRoot, "data.json");

await assertObsidianClosed();
await assertPortFree(cdpPort);

for (const [label, filePath] of checks) {
  await assertReadable(label, filePath);
}
await assertOptionalReadable("preserved data.json", dataJsonPath);

console.log(`E2E preflight passed for ${vaultRoot}`);

async function assertObsidianClosed() {
  if (process.platform !== "win32") {
    return;
  }

  const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq Obsidian.exe"]);
  if (/\bObsidian\.exe\b/i.test(stdout)) {
    throw new Error(
      "Obsidian.exe is already running. Close Obsidian before running Playwright e2e.",
    );
  }
}

async function assertPortFree(port) {
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid OBSIDIAN_CDP_PORT: ${String(process.env.OBSIDIAN_CDP_PORT)}`);
  }

  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      reject(new Error(`CDP port ${port} is not free: ${error.message}`));
    });
    server.once("listening", () => {
      server.close(resolve);
    });
    server.listen(port, "127.0.0.1");
  });
}

async function assertReadable(label, filePath) {
  if (!filePath) {
    throw new Error(`Missing path for ${label}. Set OBSIDIAN_VAULT explicitly.`);
  }

  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(`Missing or unreadable ${label}: ${filePath}`);
  }
}

async function assertOptionalReadable(label, filePath) {
  try {
    await access(filePath, constants.F_OK);
  } catch {
    console.warn(`Optional ${label} is absent: ${filePath}`);
    return;
  }

  await assertReadable(label, filePath);
}
