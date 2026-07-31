import assert from "node:assert/strict";
import test from "node:test";
import {
  decideSingleAgentLivenessRecheck,
  formatLivenessCaveat,
} from "../src/agent/livenessRecheckPolicy";
import { buildLivenessProbe, recheckLinkLiveness } from "../src/agent/deadLinkCheck";

const READY = {
  tier: "deep",
  enabled: undefined,
  hasTransport: true,
  citedUrlCount: 2,
};

test("deep and extended runs re-probe their cited sources", () => {
  assert.equal(decideSingleAgentLivenessRecheck(READY).recheck, true);
  assert.equal(
    decideSingleAgentLivenessRecheck({ ...READY, tier: "extended" }).recheck,
    true,
  );
});

test("quick and standard runs never probe, which is what protects the proof lanes", () => {
  // The lanes count transport calls to prove cache reuse; extra probes on a
  // standard-tier run would change those counts. This gate is load-bearing.
  for (const tier of ["quick", "standard", undefined, "none"]) {
    const decision = decideSingleAgentLivenessRecheck({ ...READY, tier });
    assert.equal(decision.recheck, false, `expected no probe at tier ${tier}`);
    assert.equal(decision.reason, "tier_below_threshold");
  }
});

test("the kill switch outranks the tier gate", () => {
  const decision = decideSingleAgentLivenessRecheck({ ...READY, enabled: false });
  assert.equal(decision.recheck, false);
  assert.equal(decision.reason, "disabled_by_setting");
});

test("an explicitly enabled setting still respects the tier gate", () => {
  // Turning the setting on must not silently make every standard run probe.
  const decision = decideSingleAgentLivenessRecheck({
    ...READY,
    tier: "standard",
    enabled: true,
  });
  assert.equal(decision.recheck, false);
  assert.equal(decision.reason, "tier_below_threshold");
});

test("no transport and no cited urls both short-circuit", () => {
  assert.equal(
    decideSingleAgentLivenessRecheck({ ...READY, hasTransport: false }).reason,
    "no_transport",
  );
  assert.equal(
    decideSingleAgentLivenessRecheck({ ...READY, citedUrlCount: 0 }).reason,
    "no_cited_urls",
  );
});

test("a caveat names only definitively dead sources", async () => {
  const statuses: Record<string, number> = {
    "https://gone.example/a": 404,
    "https://blocked.example/b": 403,
    "https://flaky.example/c": 503,
    "https://fine.example/d": 200,
  };
  const results = await recheckLinkLiveness({
    urls: Object.keys(statuses),
    probe: async (url) => statuses[url] ?? null,
  });
  const caveat = formatLivenessCaveat(results);
  assert.ok(caveat);
  // A bot wall or a transient 5xx must stay silent: telling a user their
  // source is dead when it is merely rate-limited is worse than saying nothing.
  assert.match(caveat, /gone\.example/);
  assert.doesNotMatch(caveat, /blocked\.example/);
  assert.doesNotMatch(caveat, /flaky\.example/);
  assert.doesNotMatch(caveat, /fine\.example/);
  assert.match(caveat, /1 cited source/);
});

test("an all-healthy recheck produces no caveat at all", async () => {
  const results = await recheckLinkLiveness({
    urls: ["https://fine.example/a", "https://fine.example/b"],
    probe: async () => 200,
  });
  assert.equal(formatLivenessCaveat(results), null);
  assert.equal(formatLivenessCaveat([]), null);
});

test("the shared probe falls back to a ranged GET when HEAD is rejected", async () => {
  const calls: Array<{ method: string; range?: string }> = [];
  const probe = buildLivenessProbe(async (request) => {
    calls.push({ method: request.method, range: request.headers?.Range });
    return { status: request.method === "HEAD" ? 405 : 200 };
  });
  assert.equal(await probe("https://example.com/a"), 200);
  assert.deepEqual(calls, [
    { method: "HEAD", range: undefined },
    { method: "GET", range: "bytes=0-0" },
  ]);
});

test("a throwing transport reports unknown rather than dead", async () => {
  const probe = buildLivenessProbe(async () => {
    throw new Error("network down");
  });
  assert.equal(await probe("https://example.com/a"), null);

  const results = await recheckLinkLiveness({
    urls: ["https://example.com/a"],
    probe,
  });
  assert.equal(results[0].liveness, "unknown");
  assert.equal(formatLivenessCaveat(results), null);
});
