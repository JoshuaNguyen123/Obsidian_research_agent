import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * .gitattributes pins every text file to one checkout form (`eol=lf`, and
 * `eol=crlf` for *.ps1) so the build reads the same bytes on every machine —
 * scripts/build-companion-assets.mjs hashes working-tree bytes straight into
 * companion-assets.json, and that hash is bundled into main.js.
 *
 * Git only applies those attributes when it writes a file. A checkout that
 * already existed before .gitattributes landed keeps its old line endings
 * forever, so its builds bake non-canonical bytes into the committed
 * artifacts and every clean checkout then fails check:bundle-parity.
 *
 * This gate compares each tracked file's worktree form against the form its
 * own attributes demand, so the drift is caught in the checkout that has it
 * rather than in the next person's parity run.
 */
export const EOL_HYGIENE_REPAIR_HINT =
  "re-check-out the drifted files so git applies .gitattributes: " +
  "node scripts/check-eol-hygiene.mjs --fix";

const ATTRIBUTE_EOL = Object.freeze({
  "eol=lf": "lf",
  "eol=crlf": "crlf",
});

export function parseEolHygieneArgs(argv) {
  return { fix: argv.includes("--fix") };
}

/**
 * `git ls-files --eol` prints "i/<eol> w/<eol> attr/<attrs>\t<path>".
 * A file drifts when its attributes pin an end-of-line form and the worktree
 * holds a different one. "none" means the file has no line endings at all,
 * which satisfies either pin, and a file git reads as binary on both sides was
 * never subject to the pin no matter what `text=auto` says about it.
 */
export function findEolDriftedFiles(lsFilesEolOutput) {
  const text = typeof lsFilesEolOutput === "string" ? lsFilesEolOutput : "";
  const drifted = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    const file = line.slice(separator + 1);
    const forms = line.slice(0, separator);
    const index = /\bi\/(\S+)/u.exec(forms)?.[1];
    const worktree = /\bw\/(\S+)/u.exec(forms)?.[1];
    const attributes = /\battr\/(.*)$/u.exec(forms)?.[1] ?? "";
    const pinned = attributes
      .trim()
      .split(/\s+/u)
      .map((attribute) => ATTRIBUTE_EOL[attribute])
      .find(Boolean);
    if (!pinned || !worktree || worktree === "none") continue;
    if (index === "-text") continue;
    if (worktree !== pinned) drifted.push({ file, worktree, pinned });
  }
  return drifted;
}

export function formatEolDriftReport(drifted) {
  const byPin = new Map();
  for (const entry of drifted) {
    const key = `pinned to ${entry.pinned} but holding ${entry.worktree}`;
    byPin.set(key, (byPin.get(key) ?? 0) + 1);
  }
  const summary = [...byPin.entries()]
    .map(([key, count]) => `${count} ${key}`)
    .join(", ");
  const sample = drifted.slice(0, 10).map((entry) => `  ${entry.file}`);
  const elided = drifted.length - sample.length;
  return [
    `Line-ending drift in ${drifted.length} tracked file(s): ${summary}.`,
    ...sample,
    ...(elided > 0 ? [`  ...and ${elided} more`] : []),
  ].join("\n");
}

/**
 * A drifted checkout can hold hundreds of files, and Windows caps a command
 * line at ~32 KB, so every git call that takes the list has to be batched.
 */
export function chunkPathArguments(files, limit = 200) {
  const chunks = [];
  for (let index = 0; index < files.length; index += limit) {
    chunks.push(files.slice(index, index + limit));
  }
  return chunks;
}

async function repairDriftedFiles(repoRoot, drifted) {
  const files = drifted.map((entry) => entry.file);
  // Re-checking-out discards unstaged edits, so refuse while any drifted file
  // still carries work that is not in the index. Ask for the whole dirty set
  // once and intersect here rather than passing the list back to git.
  const { stdout } = await execFileAsync("git", ["diff", "--name-only"], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  const dirty = new Set(stdout.split("\n").filter(Boolean));
  const blocked = files.filter((file) => dirty.has(file));
  if (blocked.length > 0) {
    throw new Error(
      `Refusing to repair: ${blocked.length} drifted file(s) have unstaged changes that a re-checkout would discard. Commit or stash them first, starting with ${blocked[0]}.`,
    );
  }
  // The index already holds the canonical bytes; only the worktree copies are
  // stale. git leaves a file it considers up to date alone, so each one has to
  // be missing before the checkout will rewrite it through the eol filter.
  for (const chunk of chunkPathArguments(files)) {
    await Promise.all(chunk.map((file) => rm(path.resolve(repoRoot, file))));
    await execFileAsync("git", ["checkout", "--", ...chunk], { cwd: repoRoot });
  }
}

async function main() {
  const { fix } = parseEolHygieneArgs(process.argv.slice(2));
  // git reports and accepts paths relative to the top level, so anchor there
  // instead of wherever the script was invoked from.
  const { stdout: topLevel } = await execFileAsync("git", [
    "rev-parse",
    "--show-toplevel",
  ]);
  const repoRoot = topLevel.trim();
  const { stdout } = await execFileAsync("git", ["ls-files", "--eol"], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  const drifted = findEolDriftedFiles(stdout);
  if (drifted.length === 0) {
    console.log(
      "Line-ending hygiene: every tracked file checks out in the form .gitattributes pins.",
    );
    return;
  }
  console.error(formatEolDriftReport(drifted));
  if (!fix) {
    console.error(EOL_HYGIENE_REPAIR_HINT);
    process.exitCode = 1;
    return;
  }
  await repairDriftedFiles(repoRoot, drifted);
  console.log(`Repaired ${drifted.length} file(s); rebuild to refresh artifacts.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
