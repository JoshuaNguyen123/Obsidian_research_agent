import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOCAL_ONLY_DIRECTORY_NAMES = new Set([
  ".agents",
  ".claude",
  ".codex",
  "docs",
  "skills",
]);
const LOCAL_ONLY_DOCUMENT_NAMES = new Set([
  "agents.md",
  "claude.md",
  "codex.md",
  "memory.md",
]);

export function findForbiddenPublicPaths(paths) {
  return paths.filter((file) => {
    const segments = file
      .replace(/\\/gu, "/")
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.toLowerCase());
    if (segments.some((segment) => LOCAL_ONLY_DIRECTORY_NAMES.has(segment))) {
      return true;
    }
    const basename = segments.at(-1) ?? "";
    return (
      LOCAL_ONLY_DOCUMENT_NAMES.has(basename) ||
      basename.endsWith(".local.md")
    );
  });
}

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

  const forbidden = findForbiddenPublicPaths(files);
  if (forbidden.length > 0) {
    console.error(
      "Local agent context or private documentation would enter the public repository:",
    );
    for (const file of forbidden) console.error(`- ${file}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Checked ${files.length} tracked/unignored paths; no duplicate or local-only public paths found.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
