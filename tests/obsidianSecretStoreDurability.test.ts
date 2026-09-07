import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ObsidianSecretStoreV1 } from "../src/integrations/ObsidianSecretStoreV1";
import { resolveElectronDomStorageFlusherV1 } from "../src/platform/electronDomStorageFlush";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function recordingPort(options: { flush?: () => void } = {}) {
  const values = new Map<string, string>();
  const calls: string[] = [];
  return {
    calls,
    values,
    port: {
      getSecret: (id: string) => {
        calls.push(`get:${id}`);
        return values.get(id) ?? null;
      },
      setSecret: (id: string, value: string) => {
        calls.push(`set:${id}:${value === "" ? "<cleared>" : "<envelope>"}`);
        values.set(id, value);
      },
      ...(options.flush
        ? {
            flush: () => {
              calls.push("flush");
              options.flush?.();
            },
          }
        : {}),
    },
  };
}

test("a native secret write is followed by a disk commit request, after its readback", async () => {
  // 2026-09-07: a rotated Linear OAuth pair was written to SecretStorage
  // (Chromium DOMStorage, committed on a delay) and referenced from data.json
  // (written through). A kill six seconds later kept the reference and lost
  // the secrets. The commit request must come AFTER the readback that proves
  // the write, so a flush never covers a value the store did not verify.
  const recorder = recordingPort({ flush: () => undefined });
  const store = new ObsidianSecretStoreV1(recorder.port, {
    now: () => new Date("2026-09-07T19:18:34.060Z"),
    randomId: () => "7efc1aadfd1af587ea03bf3841e77a71359b",
  });
  const description = await store.put({
    value: "rotated-access-token",
    label: "Linear OAuth access token",
    metadata: { provider: "linear", credentialKind: "oauth_access_token" },
  });
  const id = description.referenceId;
  assert.deepEqual(recorder.calls, [`set:${id}:<envelope>`, `get:${id}`, "flush"]);

  recorder.calls.length = 0;
  assert.equal(await store.remove(id), true);
  assert.deepEqual(recorder.calls, [`get:${id}`, `set:${id}:<cleared>`, `get:${id}`, "flush"]);

  recorder.calls.length = 0;
  assert.equal(await store.remove(id), false, "an absent secret is not rewritten");
  assert.deepEqual(recorder.calls, [`get:${id}`], "nothing was written, so nothing is flushed");
});

test("a flush bridge that throws never fails the write it follows", async () => {
  const recorder = recordingPort({
    flush: () => {
      throw new Error("remote bridge gone");
    },
  });
  const store = new ObsidianSecretStoreV1(recorder.port, {
    randomId: () => "815d25400ba8090e6bf94f140e07fb54c2c2",
  });
  const description = await store.put({
    value: "rotated-refresh-token",
    label: "Linear OAuth refresh token",
    metadata: { provider: "linear", credentialKind: "oauth_refresh_token" },
  });
  assert.equal(recorder.calls.at(-1), "flush");
  assert.equal((await store.describe(description.referenceId)).label, "Linear OAuth refresh token");
  assert.equal(await store.remove(description.referenceId), true);
});

test("a port without a flush bridge behaves exactly as before", async () => {
  const recorder = recordingPort();
  const store = new ObsidianSecretStoreV1(recorder.port, {
    randomId: () => "0123456789abcdef0123456789abcdef0123",
  });
  const description = await store.put({ value: "v", label: "plain" });
  assert.ok(!recorder.calls.includes("flush"));
  assert.equal(await store.remove(description.referenceId), true);
  assert.ok(!recorder.calls.includes("flush"));
});

test("the Electron flusher binds session.flushStorageData from @electron/remote, then electron.remote, else null", () => {
  const flushed: string[] = [];
  const remoteSession = {
    flushStorageData() {
      flushed.push(`remote:${this === remoteSession ? "bound" : "unbound"}`);
    },
  };
  const modern = ((specifier: string) => {
    if (specifier === "@electron/remote") return { session: { defaultSession: remoteSession } };
    throw new Error(`unexpected require ${specifier}`);
  }) as unknown as NodeRequire;
  const flush = resolveElectronDomStorageFlusherV1(modern);
  assert.ok(flush);
  flush();
  assert.deepEqual(flushed, ["remote:bound"]);

  const legacySession = {
    flushStorageData() {
      flushed.push(`legacy:${this === legacySession ? "bound" : "unbound"}`);
    },
  };
  const legacy = ((specifier: string) => {
    if (specifier === "@electron/remote") throw new Error("Cannot find module '@electron/remote'");
    if (specifier === "electron") return { remote: { session: { defaultSession: legacySession } } };
    throw new Error(`unexpected require ${specifier}`);
  }) as unknown as NodeRequire;
  const legacyFlush = resolveElectronDomStorageFlusherV1(legacy);
  assert.ok(legacyFlush);
  legacyFlush();
  assert.deepEqual(flushed, ["remote:bound", "legacy:bound"]);

  const sandboxed = ((specifier: string) => {
    if (specifier === "electron") return { ipcRenderer: {} };
    throw new Error(`Cannot find module '${specifier}'`);
  }) as unknown as NodeRequire;
  assert.equal(resolveElectronDomStorageFlusherV1(sandboxed), null);
  assert.equal(resolveElectronDomStorageFlusherV1(null), null);
});

test("the plugin wires the Electron flusher into its native secret store", () => {
  // Source guard: the store only flushes when the plugin hands it the bridge.
  // Constructing the store straight from app.secretStorage would silently
  // return to the pre-2026-09-07 durability gap.
  const source = readFileSync(path.join(REPO_ROOT, "main.ts"), "utf8");
  assert.doesNotMatch(source, /new ObsidianSecretStoreV1\(this\.app\.secretStorage\)/u);
  const method = source.slice(source.indexOf("private createObsidianSecretStore()"));
  const body = method.slice(0, method.indexOf("\n  }\n"));
  assert.match(body, /resolveElectronDomStorageFlusherV1\(\)/u);
  assert.match(body, /new ObsidianSecretStoreV1\(\{/u);
  assert.match(body, /flush/u);
});
