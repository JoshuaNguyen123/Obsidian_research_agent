import assert from "node:assert/strict";
import test from "node:test";
import type { HttpResponse, HttpTransport } from "../src/model/types";
import {
  clinicalTrialsSearch,
  courtListenerSearch,
  extractDoi,
  resolveFreeSearchProviders,
  resolveOpenAccessEditions,
} from "../src/tools/freeSearchProviders";
import { webSearchTool } from "../src/tools/webTools";
import type { ToolExecutionContext } from "../src/tools/types";

/*
 * Directly addressable research indexes.
 *
 * OpenAlex, arXiv, CrossRef, PubMed and Wikipedia were real, working clients
 * reachable only when the primary provider threw or returned nothing: a
 * researcher could not ask to search PubMed. These pin the two halves of
 * fixing that — naming an index, and the two new indexes that make the law and
 * medicine groups more than a claim.
 *
 * Fixtures are recorded from the live APIs (see the provider modules for the
 * exact endpoints); the shapes here are the shapes those endpoints return.
 */

function transportFor(routes: Record<string, HttpResponse>): HttpTransport {
  return async (request) => {
    for (const [needle, response] of Object.entries(routes)) {
      if (request.url.includes(needle)) return response;
    }
    return { status: 404, headers: {} };
  };
}

const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, json });

test("clinicalTrialsSearch reads the v2 protocol section and links the study page", async () => {
  const results = await clinicalTrialsSearch({
    transport: transportFor({
      "clinicaltrials.gov/api/v2/studies": ok({
        studies: [
          {
            protocolSection: {
              identificationModule: {
                nctId: "NCT06996132",
                briefTitle:
                  "Bispecific Antibody-Based Salvage Therapy Followed by CAR-T in Aggressive B-Cell Lymphoma",
              },
              statusModule: {
                overallStatus: "RECRUITING",
                startDateStruct: { date: "2025-06-01" },
              },
              descriptionModule: {
                briefSummary: "A phase II study of salvage therapy   before CAR-T.",
              },
            },
          },
          // No usable registration id: a trial we cannot address is not a source.
          { protocolSection: { identificationModule: { briefTitle: "Untitled" } } },
        ],
      }),
    }),
    query: "CAR-T lymphoma",
    maxResults: 5,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://clinicaltrials.gov/study/NCT06996132");
  assert.match(results[0].title, /Bispecific Antibody-Based Salvage Therapy/);
  assert.equal(results[0].publishedAt, "2025-06-01");
  // A registration states what was pre-registered, including for trials that
  // never published. That is a primary record, and the "primary" prior is what
  // makes it outrank secondary commentary.
  assert.equal(results[0].sourceTypeHint, "primary");
  assert.match(results[0].snippet, /RECRUITING/);
  assert.match(results[0].snippet, /salvage therapy before CAR-T/);
});

test("courtListenerSearch keeps the court in the title and the matched passage in the snippet", async () => {
  const results = await courtListenerSearch({
    transport: transportFor({
      "courtlistener.com/api/rest/v4/search": ok({
        results: [
          {
            caseName: "City of Tahlequah v. Bond",
            court: "Supreme Court of the United States",
            citation: ["142 S. Ct. 9"],
            dateFiled: "2021-10-18",
            absolute_url: "/opinion/5292018/city-of-tahlequah-v-bond/",
            opinions: [
              { snippet: "" },
              { snippet: "<em>qualified immunity</em> protects officers unless ..." },
            ],
          },
          // A result we cannot turn into an absolute URL is unusable.
          { caseName: "Unlinkable", absolute_url: "https://elsewhere.example/x" },
        ],
      }),
    }),
    query: "qualified immunity",
    maxResults: 5,
  });

  assert.equal(results.length, 1);
  assert.equal(
    results[0].url,
    "https://www.courtlistener.com/opinion/5292018/city-of-tahlequah-v-bond/",
  );
  // The court is the most load-bearing fact about an opinion's authority, and
  // the credibility signals read it out of the title.
  assert.match(results[0].title, /Supreme Court of the United States/);
  assert.match(results[0].snippet, /142 S\. Ct\. 9/);
  assert.match(results[0].snippet, /qualified immunity protects officers/);
  assert.equal(results[0].publishedAt, "2021-10-18");
  assert.equal(results[0].sourceTypeHint, "primary");
});

test("resolveFreeSearchProviders accepts ids, groups and lists, and refuses the rest", () => {
  assert.deepEqual(resolveFreeSearchProviders("pubmed"), ["pubmed"]);
  assert.deepEqual(resolveFreeSearchProviders("LAW"), ["courtlistener"]);
  assert.deepEqual(resolveFreeSearchProviders("scholar"), [
    "openalex",
    "arxiv",
    "crossref",
    "pubmed",
  ]);
  assert.deepEqual(resolveFreeSearchProviders("pubmed, clinicaltrials"), [
    "pubmed",
    "clinicaltrials",
  ]);
  // "no index named" and "an index we do not serve" must stay distinguishable:
  // the first means the general web, the second is an error the caller must see.
  assert.equal(resolveFreeSearchProviders(undefined), null);
  assert.equal(resolveFreeSearchProviders("auto"), null);
  assert.equal(resolveFreeSearchProviders("web"), null);
  assert.equal(resolveFreeSearchProviders("westlaw"), null);
});

test("web_search reaches a named index without touching the primary provider", async () => {
  let primaryCalls = 0;
  const context = {
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "k",
      requestTimeoutMs: 30_000,
      freeSearchFallbackEnabled: true,
    },
    httpTransport: async (request: { url: string }) => {
      if (request.url.includes("/web_search")) {
        primaryCalls += 1;
        return ok({
          results: [
            { title: "General", url: "https://general.example/", snippet: "x" },
          ],
        });
      }
      if (request.url.includes("eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch")) {
        return ok({ esearchresult: { idlist: ["40000001"] } });
      }
      if (request.url.includes("eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary")) {
        return ok({
          result: {
            "40000001": {
              title: "Semaglutide and weight regain",
              source: "N Engl J Med",
              pubdate: "2024 Mar 14",
            },
          },
        });
      }
      return { status: 404, headers: {} };
    },
  } as unknown as ToolExecutionContext;

  const result = (await webSearchTool.execute(
    { query: "semaglutide weight regain", index: "pubmed" },
    context,
  )) as { index?: string; results: Array<{ url: string }> };

  assert.equal(result.index, "pubmed");
  assert.equal(
    primaryCalls,
    0,
    "a named index is an instruction, not a preference",
  );
  assert.ok(
    result.results.some((item) =>
      item.url.includes("pubmed.ncbi.nlm.nih.gov/40000001"),
    ),
    JSON.stringify(result.results),
  );
});

test("web_search refuses an index it does not serve instead of quietly searching the web", async () => {
  const context = {
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "k",
      requestTimeoutMs: 30_000,
      freeSearchFallbackEnabled: true,
    },
    httpTransport: async () => ok({ results: [] }),
  } as unknown as ToolExecutionContext;

  await assert.rejects(
    () => webSearchTool.execute({ query: "x", index: "westlaw" }, context),
    /not available/i,
  );
});

test("web_search ranks a readable open-access page above an unreadable paywalled pdf", async () => {
  const context = {
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "k",
      requestTimeoutMs: 30_000,
    },
    now: () => new Date("2026-08-23T00:00:00.000Z"),
    httpTransport: transportFor({
      "/web_search": ok({
        results: [
          {
            title: "Paywalled PDF",
            url: "https://www.sciencedirect.com/science/article/pii/S1.pdf",
            snippet: "Abstract only.",
          },
          {
            title: "Open access article",
            url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC1/",
            snippet:
              "A full-text open-access article whose passages can actually be extracted, with a long enough snippet to show the page will yield real content rather than a JavaScript shell.",
          },
        ],
      }),
    }),
  } as unknown as ToolExecutionContext;

  const result = (await webSearchTool.execute({ query: "topic" }, context)) as {
    results: Array<{ url: string }>;
  };
  // The provider returned the unreadable one first. Fetchability is a real
  // signal: a paywalled PDF costs a whole fetch attempt and yields no passages,
  // so it must not be the source the model reaches for first.
  assert.match(result.results[0].url, /pmc\.ncbi\.nlm\.nih\.gov/);
});

test("web_search leaves provider order alone when the signals tie", async () => {
  const context = {
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "k",
      requestTimeoutMs: 30_000,
    },
    now: () => new Date("2026-08-23T00:00:00.000Z"),
    httpTransport: transportFor({
      "/web_search": ok({
        results: [
          { title: "First", url: "https://one.example/a", snippet: "Same shape." },
          { title: "Second", url: "https://two.example/a", snippet: "Same shape." },
        ],
      }),
    }),
  } as unknown as ToolExecutionContext;

  const result = (await webSearchTool.execute({ query: "topic" }, context)) as {
    results: Array<{ url: string }>;
  };
  assert.deepEqual(
    result.results.map((item) => item.url),
    ["https://one.example/a", "https://two.example/a"],
  );
});

test("extractDoi finds a DOI in a doi.org url, a publisher url, or a bare string", () => {
  assert.equal(
    extractDoi("https://doi.org/10.1038/s41586-020-2649-2"),
    "10.1038/s41586-020-2649-2",
  );
  assert.equal(
    extractDoi("https://www.sciencedirect.com/x?doi=10.1016/j.cell.2020.02.052"),
    "10.1016/j.cell.2020.02.052",
  );
  assert.equal(extractDoi("10.5555/abc"), "10.5555/abc");
  assert.equal(extractDoi("https://example.com/article"), null);
});

test("a paywalled DOI resolves to the open-access edition instead of dead-ending", async () => {
  const editions = await resolveOpenAccessEditions({
    transport: transportFor({
      "api.openalex.org/works/doi": ok({
        best_oa_location: {
          pdf_url: "https://www.nature.com/articles/s41586-020-2649-2.pdf",
          landing_page_url: "https://doi.org/10.1038/s41586-020-2649-2",
        },
        open_access: {
          is_oa: true,
          oa_url: "https://www.nature.com/articles/s41586-020-2649-2.pdf",
        },
        locations: [
          { is_oa: true, pdf_url: "https://repository.example/eprint/1.pdf" },
          { is_oa: false, pdf_url: "https://paywall.example/closed.pdf" },
        ],
      }),
    }),
    url: "https://doi.org/10.1038/s41586-020-2649-2",
  });

  assert.deepEqual(editions, [
    "https://www.nature.com/articles/s41586-020-2649-2.pdf",
    "https://repository.example/eprint/1.pdf",
  ]);
  // The DOI landing page is the paywall we just failed to read, and a closed
  // location is not an edition at all.
  assert.ok(!editions.some((url) => url.includes("doi.org")));
  assert.ok(!editions.some((url) => url.includes("paywall.example")));
});

test("a url with no DOI never asks OpenAlex anything", async () => {
  let calls = 0;
  const editions = await resolveOpenAccessEditions({
    transport: async () => {
      calls += 1;
      return { status: 200, headers: {}, json: {} };
    },
    url: "https://example.com/blog/post",
  });
  assert.deepEqual(editions, []);
  assert.equal(calls, 0);
});
