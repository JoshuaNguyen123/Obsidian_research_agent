import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deleteNativeSecretsInPageV1,
  discardedSecretReferencesV1,
  removeDiscardedSecretsV1,
  SECRET_REMOVAL_ABANDON_GRACE_MS,
  type NativeSecretRemovalRequestV1,
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
  const evaluated: NativeSecretRemovalRequestV1[] = [];
  const page: SecretRemovalPageLike = {
    isClosed: () => false,
    evaluate: (async (_fn: unknown, arg: NativeSecretRemovalRequestV1) => {
      evaluated.push(arg);
      return 2;
    }) as SecretRemovalPageLike["evaluate"],
  };
  assert.equal(await removeDiscardedSecretsV1(page, [ID_LANE_OLLAMA, "not-native", ID_LANE_GITHUB], 900), 2);
  assert.deepEqual(evaluated, [{ targets: [ID_LANE_OLLAMA, ID_LANE_GITHUB], budgetMs: 900 }]);

  assert.equal(await removeDiscardedSecretsV1(page, []), 0, "nothing to remove evaluates nothing");
  assert.equal(await removeDiscardedSecretsV1(null, [ID_LANE_OLLAMA]), 0);
  assert.equal(
    await removeDiscardedSecretsV1({ isClosed: () => true, evaluate: page.evaluate }, [ID_LANE_OLLAMA]),
    0,
  );
  const throwing: SecretRemovalPageLike = {
    isClosed: () => false,
    evaluate: (async () => {
      throw new Error("Execution context was destroyed");
    }) as SecretRemovalPageLike["evaluate"],
  };
  assert.equal(await removeDiscardedSecretsV1(throwing, [ID_LANE_OLLAMA]), 0);
});

test("the timeout is a budget the page is given, not just a wait the fixture abandons", async () => {
  // Racing a timeout against an evaluate stops the waiting, not the deleting:
  // the fixture returned, teardown killed the app, and deletions were still
  // landing behind it — an uncounted, uncommitted write, which is the shape of
  // the loss this whole fixture exists to stop growing. The page is told the
  // deadline so it can stop itself; the fixture then reports only what came
  // back, and waits for the answer only a fixed grace beyond that deadline.
  const seen: NativeSecretRemovalRequestV1[] = [];
  const hanging: SecretRemovalPageLike = {
    isClosed: () => false,
    evaluate: ((_fn: unknown, arg: NativeSecretRemovalRequestV1) => {
      seen.push(arg);
      return new Promise(() => undefined);
    }) as SecretRemovalPageLike["evaluate"],
  };
  const startedAt = Date.now();
  assert.equal(await removeDiscardedSecretsV1(hanging, [ID_LANE_OLLAMA], 20), 0);
  const waited = Date.now() - startedAt;
  assert.deepEqual(
    seen,
    [{ targets: [ID_LANE_OLLAMA], budgetMs: 20 }],
    "the page carries its own deadline, so nothing keeps deleting after the fixture gives up",
  );
  assert.ok(waited >= 20, `abandoned after ${waited}ms, before the page's own budget`);
  assert.ok(
    waited < 20 + SECRET_REMOVAL_ABANDON_GRACE_MS + 2_000,
    `waited ${waited}ms, far past the budget plus its round-trip grace`,
  );
});

interface FakeSecretStorageOptions {
  ids: readonly string[];
  api: "delete" | "clear" | "none";
  msPerWrite?: number;
}

/** An in-page SecretStorage stand-in; values are obvious non-secrets. */
function fakeSecretStorage(options: FakeSecretStorageOptions) {
  const secrets = new Map(options.ids.map((id) => [id, "dummy-not-a-secret"]));
  const attempted: string[] = [];
  const burn = () => {
    const until = Date.now() + (options.msPerWrite ?? 0);
    while (Date.now() < until) {
      // Deliberate wall-clock burn: the page's deadline is wall-clock too.
    }
  };
  const storage: Record<string, unknown> = {
    getSecret: (id: string) => secrets.get(id) ?? null,
  };
  if (options.api === "delete") {
    storage.deleteSecret = (id: string) => {
      attempted.push(id);
      burn();
      return secrets.delete(id);
    };
  }
  if (options.api === "clear") {
    storage.setSecret = (id: string, value: string) => {
      attempted.push(id);
      burn();
      secrets.set(id, value);
    };
  }
  return { secrets, attempted, storage };
}

function withFakeAppWindow<T>(runtime: unknown, run: () => T): T {
  const scope = globalThis as { window?: unknown };
  const had = "window" in scope;
  const previous = scope.window;
  scope.window = runtime;
  try {
    return run();
  } finally {
    if (had) scope.window = previous;
    else delete scope.window;
  }
}

test("the in-page removal deletes, proves, and asks Chromium to commit", async () => {
  const fake = fakeSecretStorage({ ids: [ID_LANE_OLLAMA, ID_LANE_GITHUB], api: "delete" });
  const bridge: string[] = [];
  const removed = withFakeAppWindow(
    {
      app: { secretStorage: fake.storage },
      require: (moduleId: string) => {
        bridge.push(moduleId);
        return {
          session: { defaultSession: { flushStorageData: () => bridge.push("flushStorageData") } },
        };
      },
    },
    () =>
      deleteNativeSecretsInPageV1({
        targets: [ID_LANE_OLLAMA, ID_LANE_GITHUB],
        budgetMs: 1_000,
      }),
  );
  assert.equal(removed, 2);
  assert.equal(fake.secrets.size, 0);
  assert.deepEqual(
    bridge,
    ["@electron/remote", "flushStorageData"],
    "these deletions are DOMStorage writes like any other, and the harness kills the app moments later",
  );
});

test("the in-page removal stops at its budget and counts only what it proved gone", async () => {
  const targets = Array.from(
    { length: 12 },
    (_unused, index) => `secret-obsidian-${String(index).padStart(2, "0")}${"e".repeat(34)}`,
  );
  const fake = fakeSecretStorage({ ids: targets, api: "delete", msPerWrite: 10 });
  const startedAt = Date.now();
  const removed = withFakeAppWindow({ app: { secretStorage: fake.storage } }, () =>
    deleteNativeSecretsInPageV1({ targets, budgetMs: 25 }),
  );
  const spent = Date.now() - startedAt;
  assert.ok(
    fake.attempted.length < targets.length,
    `deleted all ${targets.length} ids despite a 25ms budget`,
  );
  assert.ok(fake.attempted.length > 0, "a budget it can meet must still do work");
  assert.equal(removed, fake.attempted.length, "the count is the number it proved");
  assert.equal(fake.secrets.size, targets.length - removed);
  assert.ok(spent < 25 + 10 + 200, `the page ran ${spent}ms past a 25ms budget`);
});

test("the in-page removal falls back to a cleared value, and counts nothing when the value survives", async () => {
  const fake = fakeSecretStorage({ ids: [ID_LANE_OLLAMA], api: "clear" });
  const cleared = withFakeAppWindow({ app: { secretStorage: fake.storage } }, () =>
    deleteNativeSecretsInPageV1({ targets: [ID_LANE_OLLAMA], budgetMs: 1_000 }),
  );
  assert.equal(cleared, 1);
  assert.equal(fake.secrets.get(ID_LANE_OLLAMA), "", "a build without deleteSecret leaves a tombstone");

  const stubborn = fakeSecretStorage({ ids: [ID_LANE_GITHUB], api: "none" });
  const bridge: string[] = [];
  const none = withFakeAppWindow(
    {
      app: { secretStorage: stubborn.storage },
      require: (moduleId: string) => {
        bridge.push(moduleId);
        return {};
      },
    },
    () => deleteNativeSecretsInPageV1({ targets: [ID_LANE_GITHUB], budgetMs: 1_000 }),
  );
  assert.equal(none, 0, "no write API means nothing was removed");
  assert.deepEqual(bridge, [], "nothing was mutated, so nothing is committed");
  assert.equal(
    withFakeAppWindow({}, () => deleteNativeSecretsInPageV1({ targets: [ID_LANE_OLLAMA], budgetMs: 10 })),
    0,
    "a page without the app object removes nothing",
  );
});

test("deleteSecret is declared on SecretStorage, optional, and probed for at the call site", () => {
  // The call was type-safe only by way of an `any` on window.app.secretStorage:
  // obsidian.d.ts (1.11.4) declares setSecret, getSecret and listSecrets and
  // nothing else, so neither the name nor the arity was checked. The method is
  // real in the shipped runtime but not in the published types, and not every
  // build has to have it, so it is declared optional and probed for.
  const augmentation = readFileSync(
    path.join(REPO_ROOT, "src", "platform", "obsidianSecretStorage.d.ts"),
    "utf8",
  );
  assert.match(augmentation, /declare module "obsidian"/u);
  assert.match(augmentation, /interface SecretStorage\b/u);
  assert.match(
    augmentation,
    /deleteSecret\?\(id: string\): boolean;/u,
    "optional, and matching the runtime's own boolean return",
  );
  const fixture = readFileSync(
    path.join(REPO_ROOT, "e2e", "fixtures", "discardedSecretReferences.ts"),
    "utf8",
  );
  assert.doesNotMatch(fixture, /secretStorage\?: any/u, "the cast that masked the missing declaration");
  assert.match(fixture, /import type \{ App \} from "obsidian";/u);
  assert.match(fixture, /typeof storage\.deleteSecret === "function"/u);
});

test("the native harness removes discarded secrets before it asks Obsidian to quit", () => {
  // The ordering this pins used to be read off the FIRST mention of the
  // removal anywhere in the file — which is the helper's own definition, near
  // the top of the factory — against the FIRST terminate, which belongs to the
  // relaunch path. Deleting every call to the helper left both indexes where
  // they were and the assert green: an ordering guard that also passed when
  // the thing never happened. Each teardown path is now read on its own, so a
  // skipped removal fails it exactly as a late one does.
  const source = readFileSync(
    path.join(REPO_ROOT, "e2e", "fixtures", "nativeObsidianHarness.ts"),
    "utf8",
  )
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
    .join("\n");
  assert.match(source, /discardedSecretReferencesV1\(/u);
  assert.match(
    source,
    /const removeSecretsTheRestoreDiscards = async \(/u,
    "the helper the teardown paths call",
  );
  const invocations = source.match(/await removeSecretsTheRestoreDiscards\(/gu) ?? [];
  assert.ok(
    invocations.length >= 2,
    `awaited on ${invocations.length} teardown path(s); both close() and the failed-start path must run it`,
  );
  for (const [label, regionStart] of [
    ["close()", source.indexOf("async close() {")],
    ["failed start", source.indexOf("} catch (error) {", source.indexOf("async close() {"))],
  ] as const) {
    assert.ok(regionStart > 0, `${label} is where the teardown lives`);
    const removal = source.indexOf("await removeSecretsTheRestoreDiscards(", regionStart);
    const terminate = source.indexOf("await terminateObsidian(", regionStart);
    assert.ok(terminate > regionStart, `${label} tears the app down`);
    assert.ok(removal > regionStart, `${label} removes the secrets its restore discards`);
    assert.ok(
      removal < terminate,
      `${label} removes the secrets while the app is still alive, before teardown`,
    );
  }
});
