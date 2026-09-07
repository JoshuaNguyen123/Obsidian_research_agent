import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  discardedSecretReferencesV1,
  removeDiscardedSecretsV1,
  type SecretRemovalPageLike,
} from "../e2e/fixtures/discardedSecretReferences";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ID_BASELINE_OLLAMA = "secret-obsidian-76144e760859b8d3fd1848b0fa769a625a40";
const ID_LANE_OLLAMA = "secret-obsidian-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_LANE_GITHUB = "secret-obsidian-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID_LANE_LINEAR_ACCESS = "secret-obsidian-cccccccccccccccccccccccccccccccccccc";
const ID_LANE_LINEAR_REFRESH = "secret-obsidian-dddddddddddddddddddddddddddddddddddd";

function reference(referenceId: string) {
  return { version: 1, referenceId, label: "x", metadata: {}, backend: "obsidian-secret-storage", persistent: true };
}

const baseline = JSON.stringify({
  modelCredentialReferences: { version: 1, ollama: reference(ID_BASELINE_OLLAMA), openAiCompatible: null, specialist: null },
  githubCredential: null,
  linearCredentialReference: null,
  linearOAuthRuntimeState: null,
});

const afterLane = JSON.stringify({
  modelCredentialReferences: {
    version: 1,
    ollama: reference(ID_BASELINE_OLLAMA),
    openAiCompatible: reference(ID_LANE_OLLAMA),
    specialist: null,
  },
  githubCredential: { version: 1, credentialKind: "oauth_device", tokenReferenceId: ID_LANE_GITHUB },
  linearCredentialReference: null,
  linearOAuthRuntimeState: {
    version: 1,
    credential: {
      accessTokenReferenceId: ID_LANE_LINEAR_ACCESS,
      refreshTokenReferenceId: ID_LANE_LINEAR_REFRESH,
    },
  },
});

test("secrets a lane created and the restore forgets are discarded; the baseline's own are kept", () => {
  // 2026-09-07 inventory: 308 GitHub device credentials and 334 model keys
  // orphaned one or two per lane by exactly this restore.
  const discarded = discardedSecretReferencesV1(baseline, afterLane, {
    preserveLinear: false,
    preserveGitHub: false,
  });
  assert.deepEqual(discarded, [
    ID_LANE_OLLAMA,
    ID_LANE_GITHUB,
    ID_LANE_LINEAR_ACCESS,
    ID_LANE_LINEAR_REFRESH,
  ]);
  assert.ok(!discarded.includes(ID_BASELINE_OLLAMA));
});

test("a preserved Linear or GitHub record keeps every secret it references", () => {
  assert.deepEqual(
    discardedSecretReferencesV1(baseline, afterLane, { preserveLinear: true, preserveGitHub: true }),
    [ID_LANE_OLLAMA],
  );
  assert.deepEqual(
    discardedSecretReferencesV1(baseline, afterLane, { preserveLinear: true, preserveGitHub: false }),
    [ID_LANE_OLLAMA, ID_LANE_GITHUB],
  );
});

test("an id the baseline mentions anywhere is never discarded, and only native ids qualify", () => {
  const baselineMentioningElsewhere = JSON.stringify({
    modelCredentialReferences: { version: 1, ollama: null, openAiCompatible: null, specialist: null },
    someOtherRecord: { referenceId: ID_LANE_OLLAMA },
  });
  const current = JSON.stringify({
    modelCredentialReferences: {
      version: 1,
      ollama: reference(ID_LANE_OLLAMA),
      openAiCompatible: reference("companion:not-native-reference"),
      specialist: reference("secret-obsidian-short"),
    },
  });
  assert.deepEqual(
    discardedSecretReferencesV1(baselineMentioningElsewhere, current, { preserveLinear: false, preserveGitHub: false }),
    [],
  );
});

test("malformed or missing data.json content discards nothing", () => {
  const options = { preserveLinear: false, preserveGitHub: false };
  assert.deepEqual(discardedSecretReferencesV1(baseline, null, options), []);
  assert.deepEqual(discardedSecretReferencesV1(baseline, "{not json", options), []);
  assert.deepEqual(discardedSecretReferencesV1(null, "[]", options), []);
  assert.deepEqual(
    discardedSecretReferencesV1(null, afterLane, options),
    [ID_BASELINE_OLLAMA, ID_LANE_OLLAMA, ID_LANE_GITHUB, ID_LANE_LINEAR_ACCESS, ID_LANE_LINEAR_REFRESH],
    "no baseline file means the restore deletes data.json, so every reference is forgotten",
  );
});

test("removal runs inside the app, counts what is gone, and never throws", async () => {
  const evaluated: unknown[] = [];
  const page: SecretRemovalPageLike = {
    isClosed: () => false,
    evaluate: (async (_fn: unknown, arg: unknown) => {
      evaluated.push(arg);
      return 2;
    }) as SecretRemovalPageLike["evaluate"],
  };
  assert.equal(await removeDiscardedSecretsV1(page, [ID_LANE_OLLAMA, "not-native", ID_LANE_GITHUB]), 2);
  assert.deepEqual(evaluated, [[ID_LANE_OLLAMA, ID_LANE_GITHUB]]);

  assert.equal(await removeDiscardedSecretsV1(page, []), 0, "nothing to remove evaluates nothing");
  assert.equal(await removeDiscardedSecretsV1(null, [ID_LANE_OLLAMA]), 0);
  assert.equal(
    await removeDiscardedSecretsV1({ isClosed: () => true, evaluate: page.evaluate }, [ID_LANE_OLLAMA]),
    0,
  );
  const hanging: SecretRemovalPageLike = {
    isClosed: () => false,
    evaluate: (() => new Promise(() => undefined)) as SecretRemovalPageLike["evaluate"],
  };
  assert.equal(await removeDiscardedSecretsV1(hanging, [ID_LANE_OLLAMA], 20), 0);
  const throwing: SecretRemovalPageLike = {
    isClosed: () => false,
    evaluate: (async () => {
      throw new Error("Execution context was destroyed");
    }) as SecretRemovalPageLike["evaluate"],
  };
  assert.equal(await removeDiscardedSecretsV1(throwing, [ID_LANE_OLLAMA]), 0);
});

test("the native harness removes discarded secrets before it asks Obsidian to quit", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "e2e", "fixtures", "nativeObsidianHarness.ts"),
    "utf8",
  )
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
    .join("\n");
  const cleanup = source.indexOf("removeDiscardedSecretsV1(");
  const teardown = source.indexOf("await terminateObsidian(");
  assert.ok(cleanup > 0, "close() computes and removes discarded secrets");
  assert.ok(cleanup < teardown, "cleanup runs while the app is still alive, before teardown");
  assert.match(source, /discardedSecretReferencesV1\(/u);
});
