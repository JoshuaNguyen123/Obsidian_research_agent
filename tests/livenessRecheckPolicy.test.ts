import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVENESS_CAVEAT_HEADING,
  decideSingleAgentLivenessRecheck,
  formatLivenessCaveat,
  formatLivenessCaveatSection,
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

test("a standard run that committed a note re-probes its cited sources", () => {
  // Quick and standard research used to skip this entirely, so the tier whose
  // links most often rot -- an ordinary sourced note the reader comes back to
  // -- was the one tier that never checked them.
  const decision = decideSingleAgentLivenessRecheck({
    ...READY,
    tier: "standard",
    committedNote: true,
  });
  assert.equal(decision.recheck, true);
});

test("a chat-only standard run makes no extra outbound request", () => {
  // This is what keeps the cache-reuse proof lanes deterministic: they drive a
  // standard, chat-only mission and count transport calls.
  const decision = decideSingleAgentLivenessRecheck({
    ...READY,
    tier: "standard",
    committedNote: false,
  });
  assert.equal(decision.recheck, false);
  assert.equal(decision.reason, "no_committed_note");
});

test("quick runs never probe, with or without a note", () => {
  // A quick answer makes no claim of thoroughness and its sources were fetched
  // seconds ago in the same session.
  for (const committedNote of [true, false]) {
    const decision = decideSingleAgentLivenessRecheck({
      ...READY,
      tier: "quick",
      committedNote,
    });
    assert.equal(decision.recheck, false);
    assert.equal(decision.reason, "tier_below_threshold");
  }
});

test("an untiered run that committed a note still probes", () => {
  // Most sourced writebacks never build a research plan at all, so keying the
  // probe on an effort tier alone left it unreachable for the ordinary case
  // this feature exists to serve.
  assert.equal(
    decideSingleAgentLivenessRecheck({
      ...READY,
      tier: undefined,
      committedNote: true,
    }).recheck,
    true,
  );
  assert.equal(
    decideSingleAgentLivenessRecheck({
      ...READY,
      tier: undefined,
      committedNote: false,
    }).reason,
    "no_committed_note",
  );
});

test("the kill switch outranks the tier gate", () => {
  const decision = decideSingleAgentLivenessRecheck({ ...READY, enabled: false });
  assert.equal(decision.recheck, false);
  assert.equal(decision.reason, "disabled_by_setting");
});

test("an explicitly enabled setting still respects the tier gate", () => {
  // Turning the setting on must not silently make every quick run probe.
  const decision = decideSingleAgentLivenessRecheck({
    ...READY,
    tier: "quick",
    enabled: true,
    committedNote: true,
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

test("the caveat section is a note-shaped block under a stable heading", async () => {
  const results = await recheckLinkLiveness({
    urls: ["https://gone.example/a", "https://fine.example/b"],
    probe: async (url) => (url.includes("gone") ? 404 : 200),
  });
  const section = formatLivenessCaveatSection(results, {
    checkedAt: "2026-08-23T00:00:00.000Z",
  });
  assert.ok(section);
  // The heading is load-bearing: it is what makes appending the caveat
  // idempotent when a run is resumed or re-finalized.
  assert.ok(section.startsWith(`${LIVENESS_CAVEAT_HEADING}
`));
  assert.match(section, /gone\.example/);
  assert.doesNotMatch(section, /fine\.example/);
  assert.match(section, /rechecked 2026-08-23T00:00:00\.000Z/);
  assert.equal(formatLivenessCaveatSection([]), null);
});
