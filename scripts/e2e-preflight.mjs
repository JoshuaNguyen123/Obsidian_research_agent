import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  PLUGIN_ARTIFACTS,
  PLUGIN_CATALOG,
  validatePluginCatalog,
} from "./plugin-catalog.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userProfile = process.env.USERPROFILE;
const vaultRoot =
  process.env.OBSIDIAN_VAULT ??
  (userProfile
    ? path.join(userProfile, "OneDrive", "Desktop", "test_vault_obsidian_ai")
    : "");
const cdpPort = Number.parseInt(process.env.OBSIDIAN_CDP_PORT ?? "11223", 10);
const pluginsRoot = path.join(vaultRoot, ".obsidian", "plugins");
const playwrightLanes = (process.env.E2E_PLAYWRIGHT_LANE ?? "deterministic-core-mock")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

await validatePluginCatalog(repoRoot);
await assertObsidianClosed();
await assertPortFree(cdpPort);
await assertReadable("test vault", vaultRoot);

const expectedPluginIds = await resolveExpectedPluginIds();
for (const plugin of PLUGIN_CATALOG) {
  if (!expectedPluginIds.has(plugin.id)) continue;
  await verifyInstalledPlugin(plugin);
}
await assertLegacyPluginsRetired();
if (playwrightLanes.some((lane) => [
  "real-ai-contract",
  "real-ai-soak",
  "provider-canary",
  "release-vertical",
  "daily-use-research",
  "daily-use-code-live",
  "daily-use-compound",
].includes(lane))) {
  await assertLiveObsidianExecutable();
  await assertLiveProviderConfiguration();
}

console.log(
  process.env.CI
    ? `E2E preflight passed for the isolated test vault; lanes=${playwrightLanes.join(",")}; verified ${[...expectedPluginIds].join(", ")}`
    : `E2E preflight passed for ${vaultRoot}; lanes=${playwrightLanes.join(",")}; verified ${[...expectedPluginIds].join(", ")}`,
);

async function resolveExpectedPluginIds() {
  const catalogIds = new Set(PLUGIN_CATALOG.map((plugin) => plugin.id));
  const expected = new Set(
    PLUGIN_CATALOG.filter((plugin) => plugin.required).map((plugin) => plugin.id),
  );
  const enabled = await readEnabledCommunityPlugins();
  for (const pluginId of enabled) {
    if (catalogIds.has(pluginId)) expected.add(pluginId);
  }

  const requiredByLane = {
    "deterministic-core-mock": [],
    "daily-use-mock": [],
    "daily-use-connections": [],
    "daily-use-note": [],
    "daily-use-memory-reflex": [],
    "daily-use-research": [],
    "daily-use-code": [],
    "daily-use-code-live": [],
    "daily-use-linear": [],
    "daily-use-github": [],
    "daily-use-compound": [],
    "integration-mock": [],
    "integration-mock-legacy": [],
    sandbox: [],
    "companion-restart": [],
    "real-ai-contract": [],
    "real-ai-soak": [],
    "provider-canary": [],
    "release-vertical": [],
    "disposable-live-external": [],
    "configured-linear-live": [],
  };
  for (const lane of playwrightLanes) {
    const lanePlugins = requiredByLane[lane];
    if (!lanePlugins) throw new Error(`Unknown E2E_PLAYWRIGHT_LANE: ${lane}`);
    for (const pluginId of lanePlugins) expected.add(pluginId);
  }

  const configured = (process.env.OBSIDIAN_EXPECTED_PLUGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.includes("all")) {
    for (const pluginId of catalogIds) expected.add(pluginId);
  } else {
    for (const pluginId of configured) {
      if (!catalogIds.has(pluginId)) {
        throw new Error(`Unknown OBSIDIAN_EXPECTED_PLUGINS id: ${pluginId}`);
      }
      expected.add(pluginId);
    }
  }
  return expected;
}

async function assertLiveProviderConfiguration() {
  const pluginDataPath = path.join(
    pluginsRoot,
    "agentic-researcher",
    "data.json",
  );
  let settings = {};
  try {
    settings = JSON.parse(await readFile(pluginDataPath, "utf8"));
  } catch (error) {
    if (
      !process.env.E2E_OLLAMA_API_KEY?.trim() &&
      !process.env.E2E_OPENAI_COMPATIBLE_API_KEY?.trim()
    ) {
      throw new Error(`Live-provider data.json is unavailable and no provider credential is set: ${pluginDataPath}`);
    }
  }
  const provider = process.env.E2E_MODEL_PROVIDER === "openai_compatible"
    ? "openai_compatible"
    : settings.modelProvider === "openai_compatible"
      ? "openai_compatible"
      : "ollama";
  const model = process.env.E2E_AI_MODEL?.trim() || settings.model || "gpt-oss:120b-cloud";
  const baseUrl = provider === "openai_compatible"
    ? process.env.E2E_OPENAI_COMPATIBLE_BASE_URL?.trim() || settings.openAiCompatibleBaseUrl
    : process.env.E2E_OLLAMA_BASE_URL?.trim() || settings.ollamaBaseUrl || "https://ollama.com/api";
  const credential = (provider === "openai_compatible"
    ? process.env.E2E_OPENAI_COMPATIBLE_API_KEY?.trim()
    : process.env.E2E_OLLAMA_API_KEY?.trim()) ||
    (provider === "openai_compatible" ? settings.openAiCompatibleApiKey : settings.ollamaApiKey);
  const secureReferenceKey = provider === "openai_compatible"
    ? "openAiCompatible"
    : "ollama";
  const secureReference = settings.modelCredentialReferences?.[secureReferenceKey];
  const hasPersistentSecureReference = Boolean(
    secureReference &&
    typeof secureReference === "object" &&
    secureReference.version === 1 &&
    typeof secureReference.referenceId === "string" &&
    /^secret-obsidian-[a-z0-9-]{16,48}$/u.test(secureReference.referenceId) &&
    secureReference.backend === "obsidian-secret-storage" &&
    secureReference.persistent === true &&
    secureReference.metadata?.provider === provider &&
    secureReference.metadata?.credentialKind === "model_api_key",
  );
  if (!String(model).trim()) throw new Error("Live-provider model is not configured.");
  if (!String(baseUrl).trim()) throw new Error("Live-provider endpoint is not configured.");
  if (
    !String(credential).trim() &&
    !hasPersistentSecureReference &&
    !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/iu.test(String(baseUrl))
  ) {
    throw new Error(
      "Live-provider credential is missing for a non-local endpoint; configure an environment credential or a persistent opaque model credential reference.",
    );
  }
  if (playwrightLanes.includes("provider-canary") && !process.env.E2E_CANARY_MODEL?.trim()) {
    throw new Error("E2E_CANARY_MODEL is required for the provider-canary lane.");
  }
}

async function assertLiveObsidianExecutable() {
  const executable = process.env.OBSIDIAN_EXE?.trim() ||
    (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.exe")
      : "");
  await assertReadable("Obsidian executable", executable);
}

async function assertLegacyPluginsRetired() {
  for (const pluginId of [
    "agentic-researcher-code",
    "agentic-researcher-integrations",
    "agentic-researcher-companion",
  ]) {
    const manifestPath = path.join(pluginsRoot, pluginId, "manifest.json");
    try {
      await access(manifestPath, constants.F_OK);
    } catch {
      continue;
    }
    throw new Error(
      `Legacy plugin is still installed separately: ${pluginId}. Run npm run sync:test-vault to retire it safely.`,
    );
  }
}

async function readEnabledCommunityPlugins() {
  const filePath = path.join(vaultRoot, ".obsidian", "community-plugins.json");
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid community plugin registry: ${filePath}`);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`Community plugin registry must be a string array: ${filePath}`);
  }
  return parsed;
}

async function verifyInstalledPlugin(plugin) {
  const sourceRoot = path.resolve(repoRoot, plugin.sourceDir);
  const installedRoot = path.join(pluginsRoot, plugin.id);
  for (const artifact of PLUGIN_ARTIFACTS) {
    const source = path.join(sourceRoot, artifact);
    const installed = path.join(installedRoot, artifact);
    await assertReadable(`${plugin.id} source ${artifact}`, source);
    await assertReadable(`${plugin.id} installed ${artifact}`, installed);
    const [sourceHash, installedHash] = await Promise.all([
      hashFile(source),
      hashFile(installed),
    ]);
    if (sourceHash !== installedHash) {
      throw new Error(`Installed artifact is stale: ${plugin.id}/${artifact}`);
    }
  }

  const installedManifest = JSON.parse(
    await readFile(path.join(installedRoot, "manifest.json"), "utf8"),
  );
  if (
    installedManifest.id !== plugin.id ||
    installedManifest.version !== plugin.expectedVersion ||
    installedManifest.isDesktopOnly !== plugin.desktopOnly
  ) {
    throw new Error(`Installed manifest metadata drift for ${plugin.id}.`);
  }

  await assertOptionalReadable(
    `${plugin.id} data.json`,
    path.join(installedRoot, "data.json"),
  );
}

async function assertObsidianClosed() {
  if (process.platform !== "win32") return;
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
    server.once("listening", () => server.close(resolve));
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

async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}
