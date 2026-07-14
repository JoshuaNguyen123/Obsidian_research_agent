import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function buildCompanionWorker(repoRoot) {
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: ["extensions/companion/standaloneWorker.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    write: false,
    minify: true,
    sourcemap: false,
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output) throw new Error("Standalone companion worker build produced no output.");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const generatedDir = path.join(repoRoot, "extensions", "companion", "generated");
  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, "standalone-worker.txt"), output, "utf8");
}

const direct = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (direct) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await buildCompanionWorker(repoRoot);
}
