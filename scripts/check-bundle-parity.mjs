import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Production install artifacts that must match a clean `npm run build`.
 * styles.css is hand-authored and is intentionally excluded.
 */
export const BUNDLE_PARITY_ARTIFACTS = Object.freeze([
  "main.js",
  "companion-assets.json",
]);

export const BUNDLE_PARITY_REBUILD_HINT =
  "run npm run build and commit artifacts with the source change";

export function parseBundleParityArgs(argv) {
  return { noBuild: argv.includes("--no-build") };
}

export function driftedParityArtifactsFromStat(statOutput) {
  const text = typeof statOutput === "string" ? statOutput : "";
  return BUNDLE_PARITY_ARTIFACTS.filter((artifact) => {
    const escaped = artifact.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(^|\\n)\\s*${escaped}\\s*\\|`, "mu").test(text);
  });
}

async function main() {
  // Default and --no-build both assume a prior build. test:ci passes
  // --no-build so this gate never rebuilds after the suite's production build.
  parseBundleParityArgs(process.argv.slice(2));
  try {
    await execFileAsync("git", [
      "diff",
      "--exit-code",
      "--stat",
      "--",
      ...BUNDLE_PARITY_ARTIFACTS,
    ]);
    console.log(
      "Bundle parity: main.js and companion-assets.json match HEAD (styles.css is hand-authored and excluded).",
    );
  } catch (error) {
    if (error && typeof error === "object" && error.code === 1) {
      const stat = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      const drifted = driftedParityArtifactsFromStat(stat);
      const names =
        drifted.length > 0
          ? drifted.join(", ")
          : "main.js or companion-assets.json";
      console.error(`Bundle parity drifted: ${names}`);
      if (stat.trim()) console.error(stat.trim());
      console.error(BUNDLE_PARITY_REBUILD_HINT);
      process.exitCode = 1;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
