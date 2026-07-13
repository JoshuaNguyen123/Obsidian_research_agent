import assert from "node:assert/strict";
import test from "node:test";

import { createSessionBootstrapTokenLeaseV1 } from "../packages/headless-runtime/src/backgroundContinuation";
import {
  CompanionSecretStoreClientV1,
  InMemorySecretStoreV1,
  SecretStoreBoundaryErrorV1,
  requireBackgroundSecretStoreV1,
} from "../packages/headless-runtime/src/secretStoreV1";

test("foreground SecretStoreV1 persists only opaque metadata and redacts leases", async () => {
  const plaintext = "github_pat_plaintext_must_never_serialize";
  const store = new InMemorySecretStoreV1({
    randomBytes: deterministicBytes,
  });

  const description = await store.put({
    value: plaintext,
    label: "GitHub account",
    metadata: { provider: "github", account: "octocat" },
  });

  assert.match(description.referenceId, /^secret_[a-f0-9]{36}$/);
  assert.equal(description.persistent, false);
  assert.equal("value" in description, false);
  assert.equal(JSON.stringify(description).includes(plaintext), false);
  assert.equal(JSON.stringify(store).includes(plaintext), false);

  const lease = await store.lease(description.referenceId, { ttlSeconds: 30 });
  assert.equal(await lease.withSecret(async (value) => value), plaintext);
  assert.deepEqual(JSON.parse(JSON.stringify(lease)), {
    redacted: true,
    description: lease.description,
  });
  assert.equal(JSON.stringify(lease).includes(plaintext), false);

  assert.equal(await store.remove(description.referenceId), true);
  assert.equal(lease.disposed, true);
  await assert.rejects(
    () => lease.withSecret(async () => undefined),
    hasCode("secret_lease_disposed"),
  );
  await assert.rejects(() => store.describe(description.referenceId), hasCode("secret_reference_not_found"));
});

test("foreground leases expire and cannot enable background execution", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new InMemorySecretStoreV1({
    now: () => now,
    randomBytes: deterministicBytes,
  });
  const description = await store.put({ value: "a", label: "Session credential" });
  const lease = await store.lease(description.referenceId, { ttlSeconds: 1 });
  now = new Date("2026-01-01T00:00:01.001Z");

  await assert.rejects(
    () => lease.withSecret(async () => undefined),
    hasCode("secret_lease_expired"),
  );
  assert.equal(lease.disposed, true);
  await assert.rejects(
    () => requireBackgroundSecretStoreV1(store),
    hasCode("secure_persistent_credential_backend_required"),
  );
});

test("SecretStoreV1 rejects unsafe persisted metadata and unbounded leases", async () => {
  const store = new InMemorySecretStoreV1({ randomBytes: deterministicBytes });
  await assert.rejects(
    () =>
      store.put({
        value: "safe-value",
        label: "Unsafe metadata fixture",
        metadata: { token: "must-not-persist" } as never,
      }),
    hasCode("invalid_secret_input"),
  );
  const description = await store.put({ value: "safe-value", label: "Fixture" });
  await assert.rejects(
    () => store.lease(description.referenceId, { ttlSeconds: 301 }),
    hasCode("invalid_secret_input"),
  );
});

test("authenticated companion adapter returns closure-backed leases and persistent health", async () => {
  const bootstrap = "bootstrap-token-with-at-least-thirty-two-bytes";
  const plaintext = "linear-personal-api-key-plaintext";
  const referenceId = "secret_12345678-abcd-1234-abcd-123456789abc";
  const now = "2026-01-01T00:00:00.000Z";
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${bootstrap}`);
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");

    if (url.endsWith("/status")) {
      return jsonResponse({
        secureStorePersistent: true,
        secureStoreBackend: "keyring:test",
      });
    }
    if (url.endsWith("/secrets") && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(body.value, plaintext);
      return jsonResponse(secretDescription(referenceId, now));
    }
    if (url.endsWith(`/secrets/${referenceId}`) && init.method === "GET") {
      return jsonResponse(secretDescription(referenceId, now));
    }
    if (url.endsWith(`/secrets/${referenceId}/lease`)) {
      return jsonResponse({
        leaseId: "lease_12345678-abcdefghijklmnop",
        referenceId,
        value: plaintext,
        expiresAt: "2026-01-01T00:01:00.000Z",
      });
    }
    if (url.endsWith(`/secrets/${referenceId}`) && init.method === "DELETE") {
      return jsonResponse({ removed: true });
    }
    return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  };
  const credential = createSessionBootstrapTokenLeaseV1(bootstrap);
  const client = new CompanionSecretStoreClientV1({
    baseUrl: "http://127.0.0.1:43110",
    credential,
    fetchImpl,
    now: () => new Date(now),
  });

  const health = await requireBackgroundSecretStoreV1(client);
  assert.equal(health.persistent, true);
  const created = await client.put({
    value: plaintext,
    label: "Linear",
    metadata: { provider: "linear", account: "actor" },
  });
  assert.equal(created.referenceId, referenceId);
  assert.equal(JSON.stringify(created).includes(plaintext), false);
  const lease = await client.lease(referenceId, { ttlSeconds: 60 });
  assert.equal(lease.description.source, "secure_store_lease");
  assert.equal(await lease.withSecret(async (value) => value), plaintext);
  assert.equal(JSON.stringify(lease).includes(plaintext), false);
  assert.equal(JSON.stringify(client).includes(plaintext), false);
  assert.equal(await client.remove(referenceId), true);
  assert.equal(lease.disposed, true);
  assert.equal(requests.length, 5);
  credential.dispose();
});

test("companion adapter rejects cacheable secret responses", async () => {
  const credential = createSessionBootstrapTokenLeaseV1(
    "bootstrap-token-with-at-least-thirty-two-bytes",
  );
  const client = new CompanionSecretStoreClientV1({
    baseUrl: "http://localhost:43110",
    credential,
    fetchImpl: async () =>
      new Response(
        JSON.stringify(secretDescription("secret_12345678-abcd-1234-abcd-123456789abc", new Date().toISOString())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => client.describe("secret_12345678-abcd-1234-abcd-123456789abc"),
    hasCode("invalid_secret_response"),
  );
  credential.dispose();
});

function deterministicBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index + 1) % 256);
}

function secretDescription(referenceId: string, timestamp: string): Record<string, unknown> {
  return {
    referenceId,
    label: "Linear",
    metadata: { provider: "linear", account: "actor" },
    backend: "keyring:test",
    persistent: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function hasCode(code: SecretStoreBoundaryErrorV1["code"]): (error: unknown) => boolean {
  return (error) => error instanceof SecretStoreBoundaryErrorV1 && error.code === code;
}
