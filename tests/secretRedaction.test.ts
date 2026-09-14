import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  redactSecretsV1,
  redactedErrorMessageV1,
} from "../src/agent/secretRedaction";
import { redactLinearSecrets } from "../src/integrations/linear/client";

/**
 * One specimen of every credential shape this project can hold. A seat that
 * writes any of these into a run note, a receipt, or a notice has leaked it:
 * those files live in the user's vault and are read back by the model.
 */
const CREDENTIAL_SPECIMENS_V1 = [
  "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
  "gho_0123456789abcdefghijklmnopqrstuvwxyzAB",
  "ghs_0123456789abcdefghijklmnopqrstuvwxyzAB",
  "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890",
  `lin_api_${"s".repeat(40)}`,
  "sk-abcdefghijklmnopqrstuvwxyz0123",
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
  "sk-proj-abcdefghijklmnopqrstuvwxyz0123",
] as const;

const LABELLED_SPECIMENS_V1 = [
  "token=abcdefghijklmnop",
  "api_key: abcdefghijklmnop",
  "client_secret = abcdefghijklmnop",
  "password: hunter22hunter22",
  "Authorization: Bearer abcdefghijklmnop",
] as const;

function assertNoSecretSurvives(label: string, redacted: string): void {
  for (const specimen of CREDENTIAL_SPECIMENS_V1) {
    assert.ok(
      !redacted.includes(specimen),
      `${label} leaked the credential ${specimen.slice(0, 12)}…`,
    );
  }
  assert.ok(
    !/abcdefghijklmnop|hunter22hunter22/u.test(redacted),
    `${label} leaked a labelled secret value`,
  );
}

test("the shared redactor removes every credential shape this project holds", () => {
  const text = [
    ...CREDENTIAL_SPECIMENS_V1,
    ...LABELLED_SPECIMENS_V1,
    "https://user:ghp_0123456789abcdefghijklmnopqrstuvwxyzAB@github.com/o/r.git",
    "https://example.test/callback?code=abcdefghijklmnop&state=abcdefghijklmnop",
  ].join(" | ");
  assertNoSecretSurvives("redactSecretsV1", redactSecretsV1(text));
});

test("a caller's own secret is removed even in a shape nobody anticipated", () => {
  // An Ollama cloud key has no provider prefix and no fixed length. The seat
  // that holds one says so; the redactor does not have to recognise it.
  const key = "9f2c.7d41-QQ";
  const redacted = redactSecretsV1(`Provider refused key ${key} at 09:12`, {
    knownSecrets: [key],
  });
  assert.ok(!redacted.includes(key));
  assert.match(redacted, /\[REDACTED\]/u);
});

test("proof fingerprints survive redaction", () => {
  // The project states sha256 fingerprints in error messages as evidence. A
  // redactor that eats them removes proof rather than secrets — so the opaque
  // pass skips hex runs even when it is switched on.
  const sha = `sha256:${"a1b2c3d4".repeat(8)}`;
  assert.ok(redactSecretsV1(`expected ${sha}`).includes(sha));
  assert.ok(
    redactSecretsV1(`expected ${sha}`, { redactOpaqueRuns: true }).includes(sha),
  );
});

test("the opaque pass catches an unprefixed token when a seat asks for it", () => {
  const opaque = `${"Zx9_".repeat(14)}`;
  const redacted = redactSecretsV1(`bearerless ${opaque}`, {
    redactOpaqueRuns: true,
  });
  assert.ok(!redacted.includes(opaque));
});

test("redactedErrorMessageV1 bounds and redacts, and keeps a non-Error fallback", () => {
  const message = redactedErrorMessageV1(
    new Error(`failed with lin_api_${"s".repeat(40)}`),
    "fallback",
    4_096,
  );
  assert.ok(!message.includes("lin_api_"));
  assert.equal(redactedErrorMessageV1("not an error", "fallback", 4_096), "fallback");
  assert.equal(redactedErrorMessageV1(new Error("abcdef"), "fallback", 3), "abc");
});

test("the Linear client's exported redactor answers like the shared one", () => {
  const text = CREDENTIAL_SPECIMENS_V1.join(" ");
  assertNoSecretSurvives("redactLinearSecrets", redactLinearSecrets(text, []));
});

/**
 * Source-level guard. The leak this module closed was not one bad regex: it
 * was twelve hand-rolled redactors whose vocabularies disagreed, so a Linear
 * key survived in the seats that only knew GitHub's prefixes. A thirteenth
 * copy would reopen it silently, which no behavioural test can catch — the new
 * seat would simply never be exercised with the shape it forgot.
 */
test("no seat re-implements credential redaction outside the shared module", () => {
  const seats = [
    "src/agent/backgroundMissionDispatch.ts",
    "src/agent/CompanionClient.ts",
    "src/agent/runCoordinator.ts",
    "src/extensions/BundledCapabilityRuntime.ts",
    "src/integrations/github/GitHubAuth.ts",
    "src/integrations/github/GitHubRestClient.ts",
    "src/integrations/github/SecureGitPushRuntime.ts",
    "src/integrations/github/VerifiedGitPushGateway.ts",
    "src/integrations/linear/client.ts",
    "src/tools/jupyterReflectionTool.ts",
    "src/tools/linearQueueVaultTool.ts",
    "src/tools/projectResultsTool.ts",
  ];
  for (const file of seats) {
    assert.ok(
      /redactSecretsV1|redactedErrorMessageV1/u.test(readFileSync(file, "utf8")),
      `${file} must redact through the shared module`,
    );
  }

  // Producing the placeholder anywhere else means a new local redactor, with
  // its own vocabulary to fall behind. The one exception is documented and
  // additive: the git gateway relabels what the shared pass already redacted.
  const allowedPlaceholderSites = new Set([
    "src/agent/secretRedaction.ts",
    "src/integrations/github/VerifiedGitPushGateway.ts",
  ]);
  const offenders = walkTypeScriptFiles("src").filter(
    (file) =>
      !allowedPlaceholderSites.has(file) &&
      readFileSync(file, "utf8").includes("[REDACTED]"),
  );
  assert.deepEqual(
    offenders,
    [],
    "redact through secretRedaction.ts instead of emitting [REDACTED] locally",
  );
});

function walkTypeScriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walkTypeScriptFiles(entryPath));
    else if (entry.name.endsWith(".ts")) found.push(entryPath);
  }
  return found;
}
