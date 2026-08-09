import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderHealthResultV1,
  ProviderHealthCacheV1,
} from "../src/extensions/providerHealthCache";

test("provider health exposes disabled, credential-blocked, and unverified states", () => {
  const cache = new ProviderHealthCacheV1();
  assert.equal(
    cache.read({ provider: "linear", enabled: false, credentialPresent: false }).status,
    "disabled",
  );
  assert.equal(
    cache.read({ provider: "linear", enabled: true, credentialPresent: false }).status,
    "blocked",
  );
  assert.equal(
    cache.read({ provider: "linear", enabled: true, credentialPresent: true }).status,
    "degraded",
  );
});

test("older async refresh generations cannot overwrite newer provider proof", () => {
  const cache = new ProviderHealthCacheV1();
  const older = cache.beginRefresh();
  const newer = cache.beginRefresh();
  assert.equal(
    cache.commit(older, [
      createProviderHealthResultV1({
        provider: "github",
        status: "blocked",
        summary: "old",
      }),
    ]),
    false,
  );
  assert.equal(
    cache.commit(newer, [
      createProviderHealthResultV1({
        provider: "github",
        status: "healthy",
        summary: "new",
      }),
    ]),
    true,
  );
  assert.equal(
    cache.read({ provider: "github", enabled: true, credentialPresent: true }).summary,
    "new",
  );
});

test("provider verification expires after its session TTL", () => {
  const cache = new ProviderHealthCacheV1();
  const generation = cache.beginRefresh();
  cache.commit(generation, [
    createProviderHealthResultV1({
      provider: "linear",
      status: "healthy",
      summary: "fresh",
      checkedAt: new Date("2026-08-08T00:00:00.000Z"),
      ttlMs: 15 * 60_000,
    }),
  ]);
  assert.equal(
    cache.read({
      provider: "linear",
      enabled: true,
      credentialPresent: true,
      now: new Date("2026-08-08T00:14:59.000Z"),
    }).status,
    "healthy",
  );
  assert.equal(
    cache.read({
      provider: "linear",
      enabled: true,
      credentialPresent: true,
      now: new Date("2026-08-08T00:15:00.000Z"),
    }).status,
    "degraded",
  );
});
