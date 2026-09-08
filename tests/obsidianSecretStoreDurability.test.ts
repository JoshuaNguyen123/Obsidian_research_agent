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

test("a write the store cannot prove is cleared through the same proven, committed seam", async () => {
  // The readback-failure clear is a mutation like any other: before it went
  // through the write seam it was the one path that wrote without proving the
  // write and, in an earlier revision of this file, the one that could be
  // written without a commit at all. A store that mangles what it is given
  // fails the first readback; the clear that follows must itself be read back
  // and committed, or the mangled value stays on disk under a reference the
  // caller was told does not exist.
  const values = new Map<string, string>();
  const calls: string[] = [];
  const store = new ObsidianSecretStoreV1(
    {
      getSecret: (id: string) => {
        calls.push(`get:${id}`);
        return values.get(id) ?? null;
      },
      setSecret: (id: string, value: string) => {
        calls.push(`set:${id}:${value === "" ? "<cleared>" : "<envelope>"}`);
        values.set(id, value === "" ? "" : `${value}#mangled`);
      },
      flush: () => {
        calls.push("flush");
      },
    },
    { randomId: () => "c0ffee11c0ffee11c0ffee11c0ffee11c0ff" },
  );
  const id = "secret-obsidian-c0ffee11c0ffee11c0ffee11c0ffee11c0ff";
  await assert.rejects(
    store.put({ value: "dummy-not-a-real-token", label: "Mangling store" }),
    /readback failed/u,
  );
  assert.deepEqual(calls, [
    `set:${id}:<envelope>`,
    `get:${id}`,
    "flush",
    `set:${id}:<cleared>`,
    `get:${id}`,
    "flush",
  ]);
  assert.equal(values.get(id), "", "the unprovable value is gone, not merely overwritten");
});

test("every mutation goes through the store's single write seam", () => {
  // Source guard for the flush bypass a review found: with more than one
  // `setSecret` call site, staying durable is something each new method has to
  // remember, and one already did not. One seam, and forgetting is impossible.
  const source = readFileSync(
    path.join(REPO_ROOT, "src", "integrations", "ObsidianSecretStoreV1.ts"),
    "utf8",
  );
  const writeSites = source.match(/this\.storage\.setSecret\(/gu) ?? [];
  assert.equal(
    writeSites.length,
    1,
    "a second write site is a mutation that can forget to prove and commit itself",
  );
  const seam = source.slice(source.indexOf("private writeSecret("));
  const body = seam.slice(0, seam.indexOf("\n  }\n"));
  assert.match(body, /this\.storage\.setSecret\(/u, "the one write site is the seam");
  assert.match(body, /return this\.storage\.getSecret\(referenceId\) === value;/u);
  assert.match(
    body,
    /\}\s*finally\s*\{\s*this\.flushAfterWrite\(\);/u,
    "the commit request survives a write that throws",
  );
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

function mainSourceV1(): string {
  return readFileSync(path.join(REPO_ROOT, "main.ts"), "utf8");
}

function methodBodyV1(source: string, signature: string): string {
  const at = source.indexOf(signature);
  assert.notEqual(at, -1, `${signature} is not in main.ts`);
  const method = source.slice(at);
  const end = method.indexOf("\n  }\n");
  assert.notEqual(end, -1, `${signature} has no closing brace`);
  return method.slice(0, end);
}

test("the plugin wires the Electron flusher into its native secret store", () => {
  // Source guard: the store only flushes when the plugin hands it the bridge.
  // Constructing the store straight from app.secretStorage would silently
  // return to the pre-2026-09-07 durability gap. The resolver moved behind a
  // memoized seam when a second caller appeared, so the guard follows the
  // seam rather than pinning the call to one method.
  const source = mainSourceV1();
  assert.doesNotMatch(source, /new ObsidianSecretStoreV1\(this\.app\.secretStorage\)/u);
  const body = methodBodyV1(source, "private createObsidianSecretStore()");
  assert.match(body, /resolveSecretStorageCommit\(\)/u);
  assert.match(body, /new ObsidianSecretStoreV1\(\{/u);
  assert.match(body, /flush/u);
  const seam = methodBodyV1(source, "private resolveSecretStorageCommit()");
  assert.match(seam, /resolveElectronDomStorageFlusherV1\(\)/u);
});

test("the bridge is looked up in exactly one place", () => {
  // Two lookups would be two memoizations, so one caller could hold a null
  // resolved before the bridge existed while the other holds a working one.
  const source = mainSourceV1();
  const lookups = source.match(/resolveElectronDomStorageFlusherV1\(\)/gu) ?? [];
  assert.equal(lookups.length, 1, `expected one lookup, found ${lookups.length}`);
});

test("the legacy Linear clear commits, like every other SecretStorage write", () => {
  // This was the third write into SecretStorage and the only one with no
  // commit request behind it: the credential predates reference ids, so it is
  // cleared by its fixed id rather than through the store. SecretStorage is
  // DOMStorage and commits lazily, while the data.json record saying the
  // credential is gone is write-through and lands at once. A kill inside the
  // delay therefore leaves a disconnected Linear token still on disk.
  const source = mainSourceV1();
  const body = methodBodyV1(
    source,
    "private clearLinearCredentialFromObsidianSecretStorage()",
  );
  assert.match(body, /commitSecretStorage\(\)/u);
  // The commit has to be unconditional: a throwing setSecret can still have
  // rewritten the single blob, and an early return would skip it.
  assert.match(body, /\}\s*finally\s*\{[^}]*commitSecretStorage\(\)/u);
});

test("no SecretStorage write in the plugin escapes a commit", () => {
  // Derived, not listed: every direct setSecret call in main.ts must sit in a
  // method that also asks for a commit. A fourth write path added later fails
  // here rather than quietly reopening the gap that lost a rotated pair.
  const source = mainSourceV1();
  const lines = source.split(/\r?\n/u);
  const offenders: string[] = [];
  let inspected = 0;
  for (const [index, line] of lines.entries()) {
    if (!/\bsecretStorage\.setSecret\(/u.test(line)) continue;
    inspected += 1;
    // Walk back to the enclosing method and read its whole body.
    let start = index;
    while (start > 0 && !/^ {2}(?:private |protected |public )?\w[\w<>, ]*\(/u.test(lines[start])) {
      start -= 1;
    }
    const body = lines.slice(start, index + 40).join(String.fromCharCode(10));
    const guarded =
      /commitSecretStorage\(\)/u.test(body) ||
      /resolveSecretStorageCommit\(\)/u.test(body);
    if (!guarded) offenders.push(`main.ts:${index + 1}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [], offenders.join(String.fromCharCode(10)));
  // Without this the guard passes by finding nothing, which is how a rewrite
  // that renames the call would silently switch it off.
  assert.ok(inspected > 0, "the guard inspected no SecretStorage write at all");
});
