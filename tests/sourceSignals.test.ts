import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_FETCHABILITY,
  UNKNOWN_FRESHNESS,
  inferFetchability,
  inferFreshness,
  inferQuality,
  inferSourceSignals,
  inferSourceType,
  registrableDomain,
} from "../src/agent/sourceSignals";
import { scoreSourceCandidate } from "../src/orchestrator/sourceCandidateLedger";

const NOW = new Date("2026-07-31T00:00:00Z");

test("an absent publication date reproduces the pre-existing constant", () => {
  // The whole point: an undated source must rank exactly where it did before
  // freshness was a real signal, never as though it were stale.
  assert.equal(inferFreshness(undefined, NOW), UNKNOWN_FRESHNESS);
  assert.equal(inferFreshness("", NOW), UNKNOWN_FRESHNESS);
  assert.equal(inferFreshness("not a date", NOW), UNKNOWN_FRESHNESS);
});

test("freshness decays on a three-year half life and floors above zero", () => {
  const brandNew = inferFreshness("2026-07-30", NOW);
  const threeYears = inferFreshness("2023-07-31", NOW);
  const fifteenYears = inferFreshness("2011-07-31", NOW);

  assert.ok(brandNew > 0.99, `expected ~1 for a same-week source, got ${brandNew}`);
  assert.ok(
    Math.abs(threeYears - 0.5) < 0.02,
    `expected ~0.5 at one half life, got ${threeYears}`,
  );
  assert.ok(fifteenYears >= 0.15 && fifteenYears < 0.2);
  assert.ok(brandNew > threeYears && threeYears > fifteenYears);
});

test("a future publication date is treated as brand new rather than negative", () => {
  assert.equal(inferFreshness("2030-01-01", NOW), 1);
});

test("bare years and year-months parse to mid-period anchors", () => {
  // A bare year is only known to within a year; anchoring mid-year avoids
  // systematically over-aging every source a provider dated loosely.
  const bareYear = inferFreshness("2024", NOW);
  const january = inferFreshness("2024-01", NOW);
  const december = inferFreshness("2024-12", NOW);
  assert.ok(december > bareYear && bareYear > january);
});

test("fetchability ranks readable HTML above documents the parser cannot open", () => {
  assert.ok(inferFetchability("https://arxiv.org/abs/2401.12345") > 0.85);
  assert.ok(inferFetchability("https://pmc.ncbi.nlm.nih.gov/articles/PMC123/") > 0.85);
  assert.ok(inferFetchability("https://www.cdc.gov/report") > 0.8);
  assert.equal(inferFetchability("https://example.com/article"), BASE_FETCHABILITY);
  assert.ok(inferFetchability("https://doi.org/10.1/abc") < BASE_FETCHABILITY);
  assert.ok(inferFetchability("https://www.sciencedirect.com/science/article/pii/X") <= 0.3);
  assert.ok(inferFetchability("https://example.com/paper.pdf") <= 0.35);
  assert.ok(inferFetchability("https://example.com/deck.pptx") <= 0.3);
});

test("arxiv pdf links score below arxiv abstract pages", () => {
  assert.ok(
    inferFetchability("https://arxiv.org/pdf/2401.12345v1") <
      inferFetchability("https://arxiv.org/abs/2401.12345"),
  );
});

test("quality adds authority, DOI, and extractability terms on top of the type prior", () => {
  const plainWeb = inferQuality({ url: "https://blog.example/post", title: "A post" });
  const government = inferQuality({ url: "https://www.cdc.gov/data", title: "Data" });
  const withDoi = inferQuality({ url: "https://doi.org/10.1234/abc", title: "Study" });
  const thinSnippet = inferQuality({
    url: "https://blog.example/post",
    title: "A post",
    snippet: "Loading",
  });
  const richSnippet = inferQuality({
    url: "https://blog.example/post",
    title: "A post",
    snippet: "x".repeat(240),
  });

  assert.ok(government > plainWeb);
  assert.ok(withDoi > plainWeb);
  assert.ok(richSnippet > plainWeb);
  assert.ok(thinSnippet < plainWeb);
  for (const value of [plainWeb, government, withDoi, thinSnippet, richSnippet]) {
    assert.ok(value >= 0 && value <= 1);
  }
});

test("source type classification covers each branch", () => {
  assert.equal(inferSourceType("https://arxiv.org/abs/1", "x"), "paper");
  assert.equal(inferSourceType("https://nih.gov/", "x"), "official");
  assert.equal(inferSourceType("https://example.com/x", "transcript of the hearing"), "primary");
  assert.equal(inferSourceType("https://example.com/x", "news roundup"), "news");
  assert.equal(inferSourceType("https://example.com/x", "x"), "web");
});

test("a url-shaped pattern is matched against the url, not url-plus-title", () => {
  // Regression: the original helper tested `.pdf(?:$|[?#])` against
  // `url + " " + title`, so appending any title pushed the anchor out of reach
  // and a PDF classified as `web` unless the title was empty.
  assert.equal(inferSourceType("https://example.com/a.pdf", "Annual report"), "pdf");
  assert.equal(inferSourceType("https://example.com/a.pdf?v=2", "Annual report"), "pdf");
  assert.equal(inferSourceType("https://example.com/a.pdf", ""), "pdf");
  assert.equal(inferSourceType("https://data.gov/set", "Some page"), "official");
  assert.equal(inferSourceType("https://example.com/deck.pptx", "Slides"), "document");
  // A URL that merely mentions pdf in a path segment is not a PDF.
  assert.equal(inferSourceType("https://example.com/pdf-guide", "Guide"), "web");
});

test("a provider hint only breaks ties that would fall through to generic web", () => {
  assert.equal(inferSourceType("https://example.com/x", "x", "paper"), "paper");
  // A hint must never downgrade a confident URL-derived classification.
  assert.equal(inferSourceType("https://example.com/a.pdf", "a", "news"), "pdf");
});

test("registrableDomain collapses subdomains and honours multi-part suffixes", () => {
  assert.equal(registrableDomain("https://journals.example.com/x"), "example.com");
  assert.equal(registrableDomain("https://www.example.com/x"), "example.com");
  assert.equal(registrableDomain("https://www.ox.ac.uk/x"), "ox.ac.uk");
  assert.equal(registrableDomain("https://data.gov.au/x"), "data.gov.au");
  assert.equal(registrableDomain("not a url"), null);
});

test("a fresh government page outranks an old paywalled pdf once signals are real", () => {
  // The regression this module exists to prevent: with constant freshness and
  // fetchability, candidate ordering collapsed to the source-type ordering, so
  // a decade-old paywalled PDF could outrank a current official page.
  const fresh = inferSourceSignals({
    url: "https://www.cdc.gov/flu/season-2026.html",
    title: "2026 season summary",
    snippet: "x".repeat(220),
    publishedAt: "2026-06-01",
    now: NOW,
  });
  const stale = inferSourceSignals({
    url: "https://www.sciencedirect.com/science/article/pii/S1.pdf",
    title: "A 2011 journal study",
    publishedAt: "2011-01-01",
    now: NOW,
  });

  const freshScore = scoreSourceCandidate({
    sourceType: fresh.sourceType,
    signals: fresh,
  });
  const staleScore = scoreSourceCandidate({
    sourceType: stale.sourceType,
    signals: stale,
  });
  assert.ok(
    freshScore > staleScore,
    `expected the fresh official page to win, got ${freshScore} vs ${staleScore}`,
  );
});

test("two sources of the same type now separate on freshness alone", () => {
  const base = { url: "https://example.com/study", title: "A journal study", now: NOW };
  const recent = inferSourceSignals({ ...base, publishedAt: "2026-01-01" });
  const old = inferSourceSignals({ ...base, publishedAt: "2014-01-01" });

  assert.equal(recent.sourceType, old.sourceType);
  assert.ok(
    scoreSourceCandidate({ sourceType: recent.sourceType, signals: recent }) >
      scoreSourceCandidate({ sourceType: old.sourceType, signals: old }),
  );
});
