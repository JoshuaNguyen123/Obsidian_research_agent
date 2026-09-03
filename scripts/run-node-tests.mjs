import { readdirSync, realpathSync, statSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const env = { ...process.env };

// Hosted platforms may expose their temporary directory through an alias:
// macOS /var -> /private/var and Windows 8.3 RUNNER~1 -> runneradmin are both
// real examples. Give every fixture one canonical identity before strict
// workspace/profile fingerprints are constructed.
// Use the host-native resolver here. On Windows the compatibility resolver can
// preserve an 8.3 parent segment such as RUNNER~1 even though runtime safety
// checks later resolve the same directory to its long runneradmin identity.
const canonicalTemp = realpathSync.native(tmpdir());
env.TMPDIR = canonicalTemp;
env.TMP = canonicalTemp;
env.TEMP = canonicalTemp;

// Node runs each test file in its own child process, so file-level
// parallelism is safe here: the suite has no process.chdir, no shared fixed
// fixture paths (every filesystem fixture is an mkdtemp), and no env mutation.
// The old --test-concurrency=1 pin was undocumented and cost ~58% of the
// 7.9-minute wall clock in serial spawn + tsx transform overhead (measured
// 2026-09-02, 4,345 tests). Concurrency is capped so a dozen tsx processes
// transforming the 40k-line runner cannot exhaust memory; TEST_CONCURRENCY
// overrides it (1 restores the serial order for bisecting order dependence).
const configured = Number.parseInt(process.env.TEST_CONCURRENCY ?? "", 10);
const testConcurrency = Number.isFinite(configured) && configured >= 1
  ? configured
  : Math.max(1, Math.min(6, availableParallelism() - 1));

// Node starts test files in argument order, and the suite's wall clock is
// bounded by its longest files (tests/AgentRunner.test.ts alone runs about two
// minutes). Largest-first ordering lets those files overlap the rest of the
// suite instead of extending its tail. File size is the proxy for duration:
// it needs no recorded timings and is stable across machines. TEST_FILE_ORDER=
// alpha restores the glob order for bisecting order dependence.
function collectTestFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

const testFiles = collectTestFiles("tests");
if (process.env.TEST_FILE_ORDER !== "alpha") {
  const sizes = new Map(testFiles.map((file) => [file, statSync(file).size]));
  testFiles.sort(
    (left, right) =>
      sizes.get(right) - sizes.get(left) || left.localeCompare(right),
  );
} else {
  testFiles.sort((left, right) => left.localeCompare(right));
}

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    `--test-concurrency=${testConcurrency}`,
    ...testFiles,
  ],
  {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error) throw result.error;
if (result.signal) {
  throw new Error(`Node test runner terminated by ${result.signal}.`);
}
process.exitCode = result.status ?? 1;
