import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLiveness,
  deadLinks,
  recheckLinkLiveness,
} from "../src/agent/deadLinkCheck";

test("classifyLiveness only calls a definitive 404/410 dead", () => {
  assert.equal(classifyLiveness(200), "alive");
  assert.equal(classifyLiveness(301), "alive");
  assert.equal(classifyLiveness(404), "dead");
  assert.equal(classifyLiveness(410), "dead");
  // Bot walls, rate limits, and transient failures are never proof it is gone.
  assert.equal(classifyLiveness(403), "unknown");
  assert.equal(classifyLiveness(429), "unknown");
  assert.equal(classifyLiveness(503), "unknown");
  assert.equal(classifyLiveness(null), "unknown");
});

test("recheckLinkLiveness probes deduped http urls and reports the dead ones", async () => {
  const statuses: Record<string, number | null> = {
    "https://alive.example/a": 200,
    "https://gone.example/b": 404,
    "https://flaky.example/c": null,
  };
  const probed: string[] = [];
  const results = await recheckLinkLiveness({
    urls: [
      "https://alive.example/a",
      "https://alive.example/a#frag", // duplicate of the first
      "https://gone.example/b",
      "https://flaky.example/c",
      "mailto:not@a.url", // non-http, skipped
    ],
    probe: async (url) => {
      probed.push(url);
      return statuses[url] ?? null;
    },
  });

  assert.equal(probed.length, 3); // dedup + non-http filtered
  const dead = deadLinks(results);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].url, "https://gone.example/b");
});

test("recheckLinkLiveness honors the maxChecks bound", async () => {
  const urls = Array.from({ length: 10 }, (_, i) => `https://x.example/${i}`);
  let probes = 0;
  const results = await recheckLinkLiveness({
    urls,
    probe: async () => {
      probes += 1;
      return 200;
    },
    maxChecks: 3,
  });
  assert.equal(results.length, 3);
  assert.equal(probes, 3);
});
