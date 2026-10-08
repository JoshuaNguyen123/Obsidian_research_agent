import test from "node:test";
import assert from "node:assert/strict";
import { CompanionExtensionCoordinatorV1 } from "../extensions/companion/CompanionExtensionCoordinator";
import { CompanionCoordinatorClientV1, createSessionBootstrapTokenLeaseV1 } from "../packages/headless-runtime/src";

test("health reads coalesce and a retired session cannot publish its late health", async () => {
  const coordinator = new CompanionExtensionCoordinatorV1();
  let resolve!: (response: Response) => void, calls = 0;
  coordinator.configureSession({ baseUrl: "http://127.0.0.1:18941", credential: createSessionBootstrapTokenLeaseV1("test-owned-session-token-0123456789abcdef"),
    fetchImpl: async () => { calls++; return new Promise<Response>((done) => { resolve = done; }); } });
  const first = coordinator.refreshHealth(), second = coordinator.refreshHealth();
  assert.equal(first, second); assert.equal(calls, 1);
  coordinator.clearSession(); resolve(new Response(JSON.stringify({ ok: true, browserReady: true, pdfReady: true, coordinatorReady: true, workerReady: true })));
  await first;
  assert.equal(coordinator.snapshot().configured, false); assert.equal(coordinator.snapshot().health, null);
});

test("only known read-only health/status gets one transient retry; authentication and mutations get none", async () => {
  let calls = 0;
  const client = new CompanionCoordinatorClientV1({ baseUrl: "http://127.0.0.1:18942", credential: createSessionBootstrapTokenLeaseV1("test-owned-session-token-0123456789abcdef"),
    fetchImpl: async () => { calls++; return calls % 2 ? new Response("unavailable", { status: 503 }) : new Response('{"ok":true}'); } });
  assert.equal((await client.health()).ok, true); assert.equal(calls, 2);
  const privateClient = client as unknown as { requestJson(path: string, init: RequestInit): Promise<unknown> };
  await assert.rejects(privateClient.requestJson("/jobs", { method: "POST", body: "{}" })); assert.equal(calls, 3);
  const unauthenticated = new CompanionCoordinatorClientV1({ baseUrl: "http://127.0.0.1:18943", credential: createSessionBootstrapTokenLeaseV1("test-owned-session-token-0123456789abcdef"),
    fetchImpl: async () => { calls++; return new Response("denied", { status: 401 }); } });
  await assert.rejects(unauthenticated.health()); assert.equal(calls, 4);
});
