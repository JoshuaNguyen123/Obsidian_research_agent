import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * CLASS guard for the blocker-message leak, not an instance guard.
 *
 * `f0fcb0b` sanitized four sites inside `CodeExecutionContributionsV2`, and its
 * green tests made the leak class look closed. It was not: two producers in
 * `SandboxManager.ts` put a caught exception's own `message` into
 * `blocker(...)`, whose string the contributions module copies verbatim into
 * `PreparedActionResultV1.error.message` (lines 288 and 362). Per-producer
 * sanitizing demonstrably did not hold, so this test guards the SHAPE at every
 * producer, including ones nobody has audited yet.
 *
 * `safeDiagnostic` is explicitly forbidden here too. It redacts
 * credential-shaped keywords and caps length; a measured reproduction showed a
 * host path, a command line and a private note title surviving it intact.
 *
 * Two anti-vacuity pairings, because a scanner that finds nothing would
 * otherwise "pass":
 *   - a POSITIVE CONTROL asserting the scan really located the producers;
 *   - a NEGATIVE PROOF running the same predicate over the pre-fix source shape
 *     and requiring it to report a violation.
 */

const SANDBOX_MANAGER_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "extensions",
  "code",
  "sandbox",
  "SandboxManager.ts",
);

/** Foreign text this boundary must never copy into a durable blocker message. */
const FORBIDDEN_BLOCKER_DETAIL_SOURCES_V1 = [
  "error.message",
  "String(error)",
  "safeDiagnostic(error)",
] as const;

/** Extract the argument text of every `blocker(` call in a source string. */
function blockerCallArgumentsV1(source: string): string[] {
  const calls: string[] = [];
  const marker = "blocker(";
  let cursor = 0;
  for (;;) {
    const start = source.indexOf(marker, cursor);
    if (start === -1) break;
    cursor = start + marker.length;
    // Skip the declaration itself and any prose in comments.
    const lineStart = source.lastIndexOf("\n", start) + 1;
    const line = source.slice(lineStart, start);
    if (/function \s*$/u.test(line) || line.trimStart().startsWith("*")) continue;
    let depth = 1;
    let index = cursor;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      index += 1;
    }
    calls.push(source.slice(cursor, index - 1));
  }
  return calls;
}

function blockerDetailViolationsV1(source: string): string[] {
  return blockerCallArgumentsV1(source).flatMap((args) =>
    FORBIDDEN_BLOCKER_DETAIL_SOURCES_V1.filter((forbidden) =>
      args.includes(forbidden),
    ).map((forbidden) => `${forbidden} in blocker(${args.slice(0, 60)}...)`),
  );
}

test("POSITIVE CONTROL: the blocker scanner actually locates the producers it guards", () => {
  const source = readFileSync(SANDBOX_MANAGER_PATH, "utf8");
  const calls = blockerCallArgumentsV1(source);
  // If this ever drops to zero the guard below would pass while checking
  // nothing, which is the exact instrument defect this campaign exists to stop.
  assert.ok(
    calls.length >= 8,
    `expected the scanner to find the SandboxManager blocker producers, found ${calls.length}`,
  );
  assert.ok(
    calls.some((args) => args.includes("sandbox_artifact_readback_failed")),
    "the scanner must reach the artifact-readback producer",
  );
  assert.ok(
    calls.some((args) => args.includes("sandbox_staging_mismatch")),
    "the scanner must reach the staging-mismatch producer",
  );
});

test("NEGATIVE PROOF: the predicate reports a violation on the pre-fix source shape", () => {
  // Verbatim shape of the two producers before this repair.
  const preFix = [
    "        blocker: blocker(",
    '          "sandbox_staging_mismatch",',
    "          error instanceof Error ? error.message : String(error),",
    '          "Restage the workspace from the declared manifest and retry.",',
    "          true,",
    "        ),",
  ].join("\n");
  const violations = blockerDetailViolationsV1(preFix);
  assert.ok(
    violations.length > 0,
    "the predicate MUST flag the pre-fix producer; if it does not, the guard below proves nothing",
  );
});

test("no SandboxManager blocker copies a caught exception's own text into its durable message", () => {
  const source = readFileSync(SANDBOX_MANAGER_PATH, "utf8");
  assert.deepEqual(
    blockerDetailViolationsV1(source),
    [],
    "a durable blocker message reaches the provider, the persisted trace and the UI; use the typed code for attribution and withhold the caught text",
  );
});
