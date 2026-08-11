import { requireNodeModule } from "../../src/platform/nodeRequire";
import manifestSource from "./generated/runtime-assets-manifest.json";

/**
 * Companion runtime assets ship as a sibling plugin artifact
 * (companion-assets.json, ~950 KB) installed next to main.js, instead of
 * being inlined into the bundle. Only this small generated manifest — the
 * per-file and bundle hashes computed by scripts/build-companion-assets.mjs
 * from exactly this build's assets — is bundled. Runtime identity
 * (runtime/v1-<hash16>) and attestation therefore never need the sibling
 * file; only materialization reads it, and every byte it provides is
 * verified against the manifest before being written anywhere.
 */
export const COMPANION_RUNTIME_ASSETS_FILE_NAME = "companion-assets.json";

export interface CompanionRuntimeAssetManifestV1 {
  bundleHash: string;
  fileHashes: Readonly<Record<string, string>>;
}

/**
 * The companion service is an optional capability: a partial install (BRAT
 * and manual installs historically copied only main.js, styles.css, and
 * manifest.json) must disable it with a clear reinstall instruction, never
 * break plugin load. Callers surface `message` as the companion state.
 */
export class CompanionRuntimeAssetsUnavailableError extends Error {
  readonly code = "companion_runtime_assets_unavailable";

  constructor(detail: string) {
    super(
      `Companion runtime assets are unavailable: ${detail} ` +
        "The companion service stays disabled. Reinstall the plugin with its " +
        "complete artifact set (main.js, styles.css, manifest.json, " +
        `${COMPANION_RUNTIME_ASSETS_FILE_NAME}).`,
    );
    this.name = "CompanionRuntimeAssetsUnavailableError";
  }
}

let cachedManifest: CompanionRuntimeAssetManifestV1 | null = null;

/** Bundled hash manifest for this exact build; parsed once, fails closed. */
export function getCompanionRuntimeAssetManifestV1(): CompanionRuntimeAssetManifestV1 {
  if (cachedManifest) {
    return cachedManifest;
  }
  // The production bundle loads .json as text; unit-test bundles may use the
  // default json loader, which yields an object. Accept both.
  const raw: unknown =
    typeof manifestSource === "string"
      ? JSON.parse(manifestSource)
      : manifestSource;
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    typeof raw.bundleHash !== "string" ||
    !isStringRecord(raw.fileHashes) ||
    Object.keys(raw.fileHashes).length === 0
  ) {
    throw new CompanionRuntimeAssetsUnavailableError(
      "the bundled runtime-asset manifest is malformed (corrupt build).",
    );
  }
  cachedManifest = Object.freeze({
    bundleHash: raw.bundleHash,
    fileHashes: Object.freeze({ ...raw.fileHashes }),
  });
  return cachedManifest;
}

/**
 * Read and verify the sibling companion-assets.json installed next to the
 * running plugin bundle. Every returned byte is hash-verified against the
 * bundled manifest, so a stale artifact left behind by a partial update can
 * never materialize; the returned record contains exactly the manifest's
 * asset names.
 */
export function loadCompanionRuntimeAssetsFromDiskV1(): Readonly<
  Record<string, string>
> {
  const manifest = getCompanionRuntimeAssetManifestV1();
  const fs = requireNodeModule<typeof import("fs")>(
    "fs",
    "companion_runtime_assets",
  );
  const path = requireNodeModule<typeof import("path")>(
    "path",
    "companion_runtime_assets",
  );
  const crypto = requireNodeModule<typeof import("crypto")>(
    "crypto",
    "companion_runtime_assets",
  );

  if (typeof __dirname !== "string" || !__dirname) {
    throw new CompanionRuntimeAssetsUnavailableError(
      "the plugin bundle directory could not be resolved in this runtime.",
    );
  }
  const artifactPath = path.join(__dirname, COMPANION_RUNTIME_ASSETS_FILE_NAME);
  let content: string;
  try {
    content = fs.readFileSync(artifactPath, "utf8");
  } catch {
    throw new CompanionRuntimeAssetsUnavailableError(
      `"${COMPANION_RUNTIME_ASSETS_FILE_NAME}" was not found next to the installed main.js.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CompanionRuntimeAssetsUnavailableError(
      `"${COMPANION_RUNTIME_ASSETS_FILE_NAME}" is not valid JSON (corrupt install).`,
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.bundleHash !== "string" ||
    !isStringRecord(parsed.files)
  ) {
    throw new CompanionRuntimeAssetsUnavailableError(
      `"${COMPANION_RUNTIME_ASSETS_FILE_NAME}" has an unsupported shape (corrupt install).`,
    );
  }
  if (parsed.bundleHash !== manifest.bundleHash) {
    throw new CompanionRuntimeAssetsUnavailableError(
      `"${COMPANION_RUNTIME_ASSETS_FILE_NAME}" belongs to a different plugin build (stale or partial update).`,
    );
  }

  const files: Record<string, string> = {};
  for (const [name, expectedHash] of Object.entries(manifest.fileHashes)) {
    const fileContent = parsed.files[name];
    if (typeof fileContent !== "string") {
      throw new CompanionRuntimeAssetsUnavailableError(
        `"${COMPANION_RUNTIME_ASSETS_FILE_NAME}" is missing the "${name}" asset (stale or partial update).`,
      );
    }
    const actual = `sha256:${crypto
      .createHash("sha256")
      .update(fileContent)
      .digest("hex")}`;
    if (actual !== expectedHash) {
      throw new CompanionRuntimeAssetsUnavailableError(
        `the "${name}" asset does not match this plugin build (stale or tampered install).`,
      );
    }
    files[name] = fileContent;
  }
  // Only manifest-listed assets are returned: extra entries in the sibling
  // file must never reach the materializer's write loop.
  return Object.freeze(files);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}
