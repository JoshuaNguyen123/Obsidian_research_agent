import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
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
