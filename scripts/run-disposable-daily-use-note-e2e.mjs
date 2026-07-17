import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownedRoot = await mkdtemp(
  path.join(os.tmpdir(), "agentic-researcher-daily-use-"),
);
const vaultRoot = path.join(
  ownedRoot,
  "Nested portability",
  "Vault With Spaces Ω",
);

let exitCode = 1;
let seededFiles = new Map();
try {
  await mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
  seededFiles = await seedExistingKnowledge(vaultRoot);
  exitCode = await run(process.execPath, [
    path.join(repoRoot, "scripts", "run-e2e-exclusive.mjs"),
    "--mock-ai",
    "--project=daily-use-note",
  ], {
    ...process.env,
    OBSIDIAN_VAULT: vaultRoot,
    E2E_TRUST_DISPOSABLE_VAULT: "1",
  });
} finally {
  await assertSeededKnowledgeUnchanged(seededFiles);
  assertOwnedRoot(ownedRoot, vaultRoot);
  await rm(ownedRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 500,
  });
}

async function seedExistingKnowledge(root) {
  const files = new Map();
  for (let index = 0; index < 250; index += 1) {
    const batch = String(Math.floor(index / 25)).padStart(2, "0");
    const fileName = `Research ${String(index).padStart(3, "0")}.md`;
    const filePath = path.join(
      root,
      "Existing Knowledge",
      "项目 Ω",
      `Batch ${batch}`,
      fileName,
    );
    const content = `# Existing research ${index}\n\nPortable seed marker: ${index}.\n`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    files.set(filePath, content);
  }
  return files;
}

async function assertSeededKnowledgeUnchanged(files) {
  for (const [filePath, expected] of files) {
    const actual = await readFile(filePath, "utf8");
    if (actual !== expected) {
      throw new Error(`DU-01 modified unrelated existing note: ${filePath}`);
    }
  }
}

process.exitCode = exitCode;

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`Disposable DU-01 lane was interrupted by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function assertOwnedRoot(root, target) {
  const resolvedRoot = path.resolve(root);
  const relativeToTemp = path.relative(path.resolve(os.tmpdir()), resolvedRoot);
  const relativeTarget = path.relative(resolvedRoot, path.resolve(target));
  if (
    !path.basename(resolvedRoot).startsWith("agentic-researcher-daily-use-") ||
    !relativeToTemp ||
    relativeToTemp.startsWith("..") ||
    path.isAbsolute(relativeToTemp) ||
    !relativeTarget ||
    relativeTarget.startsWith("..") ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(`Refusing to clean an unowned disposable vault root: ${root}`);
  }
}
