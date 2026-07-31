import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOpenHtmlEquivalents,
  buildResearchFallbackCandidates,
  retrieveUsableResearchSource,
  type ResearchRetrievalProvider,
} from "../src/orchestrator/researchProvider";

test("an arxiv pdf link yields the abstract page and the ar5iv html rendering", () => {
  assert.deepEqual(buildOpenHtmlEquivalents("https://arxiv.org/pdf/2401.12345v2"), [
    "https://arxiv.org/abs/2401.12345v2",
    "https://ar5iv.labs.arxiv.org/html/2401.12345",
  ]);
  // The trailing .pdf form maps to the same pair.
  assert.deepEqual(buildOpenHtmlEquivalents("https://arxiv.org/pdf/2401.12345.pdf"), [
    "https://arxiv.org/abs/2401.12345",
    "https://ar5iv.labs.arxiv.org/html/2401.12345",
  ]);
});

test("an arxiv DOI resolves to the same html editions without a network lookup", () => {
  assert.deepEqual(buildOpenHtmlEquivalents("https://doi.org/10.48550/arXiv.2401.12345"), [
    "https://arxiv.org/abs/2401.12345",
    "https://ar5iv.labs.arxiv.org/html/2401.12345",
  ]);
});

test("a pubmed record maps to Europe PMC, which is addressable by PMID", () => {
  assert.deepEqual(buildOpenHtmlEquivalents("https://pubmed.ncbi.nlm.nih.gov/38123456/"), [
    "https://europepmc.org/article/MED/38123456",
  ]);
});

test("a PMC pdf maps up to the article body and preprint pdfs drop the suffix", () => {
  assert.deepEqual(
    buildOpenHtmlEquivalents("https://pmc.ncbi.nlm.nih.gov/articles/PMC987654/pdf/main.pdf"),
    ["https://pmc.ncbi.nlm.nih.gov/articles/PMC987654/"],
  );
  assert.deepEqual(
    buildOpenHtmlEquivalents(
      "https://www.biorxiv.org/content/10.1101/2024.01.01.123456v1.full.pdf",
    ),
    ["https://www.biorxiv.org/content/10.1101/2024.01.01.123456v1.full"],
  );
});

test("urls with no derivable html edition yield nothing rather than a guess", () => {
  // A bare DOI needs a redirect and a PMID needs NCBI's id converter; this
  // function is network-free by contract, so it must not invent either.
  assert.deepEqual(buildOpenHtmlEquivalents("https://doi.org/10.1234/abc"), []);
  assert.deepEqual(buildOpenHtmlEquivalents("https://example.com/report.pdf"), []);
  assert.deepEqual(buildOpenHtmlEquivalents("not a url"), []);
  assert.deepEqual(buildOpenHtmlEquivalents(""), []);
});

test("an html equivalent identical to the primary url is not re-queued", () => {
  assert.deepEqual(buildOpenHtmlEquivalents("https://pmc.ncbi.nlm.nih.gov/articles/PMC1/"), []);
});

test("html equivalents are attempted before the browser and document fallbacks", () => {
  const candidates = buildResearchFallbackCandidates({
    url: "https://arxiv.org/pdf/2401.12345v1",
    documentLike: true,
    alternateUrls: ["https://elsewhere.example/paper"],
  });
  const order = candidates.map((candidate) => candidate.strategy);
  const firstHtmlEquivalent = candidates.findIndex((candidate) =>
    candidate.id.startsWith("html-equivalent-"),
  );
  const browserIndex = order.indexOf("browser_extract");
  const documentIndex = order.indexOf("document_extract");

  assert.ok(firstHtmlEquivalent > 0);
  assert.ok(
    firstHtmlEquivalent < browserIndex && browserIndex < documentIndex,
    `expected html equivalents before browser/document fallbacks, got ${JSON.stringify(order)}`,
  );
  // They ride the provider_fetch strategy because the strategy union is
  // provider-declared: a novel value would match no provider and never run.
  assert.equal(candidates[firstHtmlEquivalent].strategy, "provider_fetch");
  assert.equal(order[0], "cached_section");
  assert.equal(order[order.length - 1], "alternate_result");
});

test("a plain html url keeps exactly the original candidate chain", () => {
  const candidates = buildResearchFallbackCandidates({ url: "https://example.com/article" });
  assert.deepEqual(
    candidates.map((candidate) => candidate.strategy),
    ["cached_section", "provider_fetch", "browser_extract"],
  );
});

test("provider-neutral retrieval rejects empty proof and falls back", async () => {
  const provider: ResearchRetrievalProvider = {
    id: "test",
    strategies: ["cached_section", "provider_fetch", "browser_extract"],
    async retrieve(candidate) {
      if (candidate.strategy !== "browser_extract") {
        return {
          title: "Empty",
          url: candidate.url,
          content: "",
          parserStatus: "empty",
        };
      }
      return {
        title: "Usable",
        url: candidate.url,
        content:
          "Browser extraction returned a concrete source passage with enough context for claim-level verification and citation.",
        parserStatus: "parsed",
      };
    },
  };
  const result = await retrieveUsableResearchSource({
    candidates: buildResearchFallbackCandidates({
      url: "https://example.com/report",
    }),
    providers: [provider],
  });
  assert.equal(result.output?.title, "Usable");
  assert.ok(result.passageIds.length > 0);
  assert.deepEqual(result.attempts.map((item) => item.status), [
    "unparsed",
    "unparsed",
    "usable",
  ]);
});
