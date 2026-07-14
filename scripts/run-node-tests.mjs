import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const env = { ...process.env };

// macOS exposes its temporary directory through /var while realpath resolves
// the same files under /private/var. Give every test fixture one canonical
// identity before strict workspace/profile fingerprints are constructed.
if (process.platform === "darwin") {
  const canonicalTemp = realpathSync(tmpdir());
  env.TMPDIR = canonicalTemp;
  env.TMP = canonicalTemp;
  env.TEMP = canonicalTemp;
}

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/**/*.test.ts",
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
