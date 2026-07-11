import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function main() {
  const { stdout } = await execFileAsync("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const files = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const byNormalizedPath = new Map();

  for (const file of files) {
    const normalized = file.replace(/\\/g, "/").toLowerCase();
    const existing = byNormalizedPath.get(normalized) ?? [];
    existing.push(file);
    byNormalizedPath.set(normalized, existing);
  }

  const duplicates = [...byNormalizedPath.values()].filter(
    (items) => items.length > 1,
  );
  if (duplicates.length > 0) {
    console.error("Duplicate normalized repository paths found:");
    for (const group of duplicates) {
      console.error(`- ${group.join(" | ")}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Checked ${files.length} tracked/unignored paths; no duplicates found.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
