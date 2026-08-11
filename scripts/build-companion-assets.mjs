import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Companion runtime assets ship as a sibling plugin artifact
 * (companion-assets.json) instead of ~950 KB of text inlined into main.js.
 *
 * This script is the single source of truth for the asset set. It emits:
 * - companion-assets.json at the repo root — the installable artifact
 *   (name -> content), registered in PLUGIN_ARTIFACTS and copied by the
 *   vault sync next to main.js.
 * - extensions/companion/generated/runtime-assets-manifest.json — a small
 *   generated manifest (per-file and bundle hashes) that IS bundled into
 *   main.js, so runtime identity (runtime/v1-<hash16>) and attestation work
 *   without reading the sibling file, and disk-loaded content can be
 *   verified against the exact build that shipped it.
 *
 * Hashing must stay byte-identical to the legacy in-bundle computation
 * (sorted name -> "sha256:<hex>" map, bundle hash over its JSON), so
 * already-materialized runtimes keep their directory identity.
 */
export const COMPANION_ASSETS_ARTIFACT = "companion-assets.json";

const ASSET_SOURCES = Object.freeze({
  "auth.py": "companion/auth.py",
  "browser_service.py": "companion/browser_service.py",
  "browser_security.py": "companion/browser_security.py",
  "companion_control.py": "companion/companion_control.py",
  "config.py": "companion/config.py",
  "coordinator_store.py": "companion/coordinator_store.py",
  "memory_store.py": "companion/memory_store.py",
  "persisted_data.py": "companion/persisted_data.py",
  "runtime_preflight.py": "companion/runtime_preflight.py",
  "runtime-lock.json": "companion/runtime-lock.json",
  "schemas.py": "companion/schemas.py",
  "secure_store.py": "companion/secure_store.py",
  "server.py": "companion/server.py",
  "service_launcher.py": "companion/service_launcher.py",
  "service_manager.py": "companion/service_manager.py",
  "web_extract.py": "companion/web_extract.py",
  "requirements.txt": "companion/requirements.txt",
  "static/ruffle-host.html": "companion/static/ruffle-host.html",
  "standalone-worker.cjs": "extensions/companion/generated/standalone-worker.txt",
});

export async function buildCompanionAssets(repoRoot) {
  const files = {};
  for (const [assetName, sourcePath] of Object.entries(ASSET_SOURCES)) {
    files[assetName] = await readFile(path.join(repoRoot, sourcePath), "utf8");
  }

  const fileHashes = Object.fromEntries(
    Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, content]) => [name, sha256(content)]),
  );
  const bundleHash = sha256(JSON.stringify(fileHashes));

  const artifact = {
    schemaVersion: 1,
    bundleHash,
    files,
  };
  await writeFile(
    path.join(repoRoot, COMPANION_ASSETS_ARTIFACT),
    `${JSON.stringify(artifact)}\n`,
    "utf8",
  );

  const manifest = {
    schemaVersion: 1,
    artifact: COMPANION_ASSETS_ARTIFACT,
    bundleHash,
    fileHashes,
  };
  const generatedDir = path.join(repoRoot, "extensions", "companion", "generated");
  await mkdir(generatedDir, { recursive: true });
  await writeFile(
    path.join(generatedDir, "runtime-assets-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return { bundleHash, fileCount: Object.keys(files).length };
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const direct = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (direct) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await buildCompanionAssets(repoRoot);
  console.log(
    `Companion assets artifact written: ${result.fileCount} files, ${result.bundleHash}`,
  );
}
