import assert from "node:assert/strict";
import test from "node:test";
import type { HttpResponse, HttpTransport } from "../src/model/types";
import {
  arxivSearch,
  crossrefSearch,
  openAlexSearch,
  pubmedSearch,
  runFreeSearchFallback,
  wikipediaSearch,
} from "../src/tools/freeSearchProviders";
import { webSearchTool } from "../src/tools/webTools";
import type { ToolExecutionContext } from "../src/tools/types";

function transportFor(routes: Record<string, HttpResponse>): HttpTransport {
  return async (request) => {
    for (const [needle, response] of Object.entries(routes)) {
      if (request.url.includes(needle)) return response;
    }
    return { status: 404, headers: {} };
  };
}

const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, json });
const okText = (text: string): HttpResponse => ({ status: 200, headers: {}, text });

/** Minimal arXiv Atom document with one entry per supplied id. */
function arxivFeed(
  entries: Array<{ id: string; title: string; summary?: string; published?: string }>,
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    ...entries.map((entry) =>
      [
        "<entry>",
        `<id>http://arxiv.org/abs/${entry.id}</id>`,
        `<title>${entry.title}</title>`,
        `<summary>${entry.summary ?? ""}</summary>`,
        `<published>${entry.published ?? "2024-01-01T00:00:00Z"}</published>`,
        "</entry>",
      ].join(""),
    ),
    "</feed>",
  ].join("");
}

test("wikipediaSearch parses REST pages and strips highlight markup", async () => {
  const results = await wikipediaSearch({
    transport: transportFor({
      "wikipedia.org": ok({
        pages: [
          {
            key: "Obsidian_(software)",
            title: "Obsidian (software)",
            excerpt: 'A <span class="searchmatch">note</span> app.',
          },
        ],
      }),
    }),
    query: "obsidian",
    maxResults: 5,
  });
  assert.equal(results.length, 1);
  assert.equal(
    results[0].url,
    "https://en.wikipedia.org/wiki/Obsidian_(software)",
  );
  assert.equal(results[0].snippet, "A note app.");
});

test("openAlexSearch resolves URLs, rebuilds abstracts, and skips urlless works", async () => {
  const results = await openAlexSearch({
    transport: transportFor({
      "openalex.org": ok({
        results: [
          {
            display_name: "Deep Study",
            doi: "10.1/abc",
            publication_year: 2024,
            primary_location: {
              landing_page_url: "https://journal.example/deep",
              source: { display_name: "J. Example" },
            },
            abstract_inverted_index: { Findings: [0], matter: [1] },
          },
          { display_name: "DOI only", doi: "10.2/xyz", publication_year: 2020 },
          { title: "No URL work" },
        ],
      }),
    }),
    query: "deep study",
    maxResults: 5,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://journal.example/deep");
  assert.match(results[0].snippet, /J\. Example, 2024/);
  assert.match(results[0].snippet, /Findings matter/);
  assert.equal(results[1].url, "https://doi.org/10.2/xyz");
});

test("runFreeSearchFallback isolates a failing provider and de-duplicates urls", async () => {
  const merged = await runFreeSearchFallback({
    transport: transportFor({
      // Wikipedia errors — must not break the OpenAlex results.
      "wikipedia.org": { status: 500, headers: {} },
      "openalex.org": ok({
        results: [
          { display_name: "A", primary_location: { landing_page_url: "https://x.example/p" } },
          { display_name: "B", primary_location: { landing_page_url: "https://x.example/p" } },
        ],
      }),
    }),
    query: "x",
    maxResults: 5,
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, "https://x.example/p");
});

test("arxivSearch parses Atom entries and returns the HTML abstract page", async () => {
  const results = await arxivSearch({
    transport: transportFor({
      "export.arxiv.org": okText(
        arxivFeed([
          {
            id: "2401.12345v2",
            title: "Retrieval\n  Augmented  Generation",
            summary: "We study retrieval.",
            published: "2024-01-22T10:00:00Z",
          },
        ]),
      ),
    }),
    query: "retrieval augmented generation",
    maxResults: 5,
  });
  assert.equal(results.length, 1);
  // The /abs/ landing page is HTML the existing fetch path can parse; /pdf/ is not.
  assert.equal(results[0].url, "https://arxiv.org/abs/2401.12345v2");
  assert.equal(results[0].title, "Retrieval Augmented Generation");
  assert.equal(results[0].publishedAt, "2024-01-22T10:00:00Z");
  assert.equal(results[0].sourceTypeHint, "paper");
});

test("arxivSearch drops the API's error entry rather than surfacing it as a result", async () => {
  const results = await arxivSearch({
    transport: transportFor({
      "export.arxiv.org": okText(
        arxivFeed([{ id: "http://arxiv.org/api/errors", title: "Error" }]),
      ),
    }),
    query: "bad",
    maxResults: 5,
  });
  assert.deepEqual(results, []);
});

test("crossrefSearch reads JATS abstracts and date-parts", async () => {
  const results = await crossrefSearch({
    transport: transportFor({
      "api.crossref.org": ok({
        message: {
          items: [
            {
              DOI: "10.1234/abc",
              URL: "https://journal.example/abc",
              title: ["Sleep and Memory"],
              "container-title": ["J. Sleep"],
              issued: { "date-parts": [[2023, 6, 2]] },
              abstract: "<jats:p>Sleep consolidates memory.</jats:p>",
            },
            { title: ["No identifier"] },
          ],
        },
      }),
    }),
    query: "sleep memory",
    maxResults: 5,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://journal.example/abc");
  assert.equal(results[0].publishedAt, "2023-06-02");
  assert.match(results[0].snippet, /J\. Sleep, 2023/);
  assert.match(results[0].snippet, /Sleep consolidates memory\./);
});

test("crossrefSearch keeps a bare year when the date has no month", async () => {
  const results = await crossrefSearch({
    transport: transportFor({
      "api.crossref.org": ok({
        message: {
          items: [
            {
              DOI: "10.1/x",
              title: ["Year only"],
              issued: { "date-parts": [[2019]] },
            },
          ],
        },
      }),
    }),
    query: "x",
    maxResults: 5,
  });
  assert.equal(results[0].publishedAt, "2019");
  assert.equal(results[0].url, "https://doi.org/10.1/x");
});

test("pubmedSearch joins esearch ids to esummary records in relevance order", async () => {
  const results = await pubmedSearch({
    transport: transportFor({
      esearch: ok({ esearchresult: { idlist: ["222", "111"] } }),
      esummary: ok({
        result: {
          uids: ["111", "222"],
          "111": { title: "Second by relevance", source: "Nature", pubdate: "2020 Feb 3" },
          "222": { title: "First by relevance", source: "Cell", pubdate: "2024" },
        },
      }),
    }),
    query: "crispr",
    maxResults: 5,
  });
  // Rank is what the fusion step consumes, so idlist order must win over the
  // response object's key order.
  assert.deepEqual(
    results.map((item) => item.title),
    ["First by relevance", "Second by relevance"],
  );
  assert.equal(results[0].url, "https://pubmed.ncbi.nlm.nih.gov/222/");
  assert.equal(results[0].publishedAt, "2024");
  assert.equal(results[1].publishedAt, "2020-02");
});

test("pubmedSearch returns nothing when esearch finds no ids", async () => {
  const results = await pubmedSearch({
    transport: transportFor({ esearch: ok({ esearchresult: { idlist: [] } }) }),
    query: "nothing",
    maxResults: 5,
  });
  assert.deepEqual(results, []);
});

test("every provider isolates a malformed or failing response as an empty list", async () => {
  const failures: HttpResponse[] = [
    { status: 500, headers: {} },
    { status: 200, headers: {}, text: "not json at all" },
    { status: 200, headers: {} },
  ];
  for (const response of failures) {
    const input = {
      transport: (async () => response) as HttpTransport,
      query: "q",
      maxResults: 3,
    };
    // runFreeSearchFallback wraps each provider in safeProvider, so a total
    // provider outage must degrade to an empty merge, never a throw.
    assert.deepEqual(await runFreeSearchFallback(input), []);
  }
});

test("runFreeSearchFallback keeps query-addressed urls distinct", async () => {
  // Regression: the previous canonical key was hostname+pathname, which
  // collapsed every result from a site that addresses pages by query string.
  const merged = await runFreeSearchFallback({
    transport: transportFor({
      "openalex.org": ok({
        results: [
          { display_name: "Record one", primary_location: { landing_page_url: "https://db.example/view?id=1" } },
          { display_name: "Record two", primary_location: { landing_page_url: "https://db.example/view?id=2" } },
        ],
      }),
    }),
    query: "records",
    maxResults: 5,
  });
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((item) => item.url).sort(),
    ["https://db.example/view?id=1", "https://db.example/view?id=2"],
  );
});

test("runFreeSearchFallback ranks a source three providers agree on above any single provider's top hit", async () => {
  const shared = "https://doi.org/10.9/shared";
  const merged = await runFreeSearchFallback({
    transport: transportFor({
      // Wikipedia ranks a unique page first; three scholarly providers all
      // rank the shared DOI second. Round-robin would have taken Wikipedia's
      // first; reciprocal-rank fusion must prefer the agreed-on source.
      "wikipedia.org": ok({
        pages: [{ key: "Solo", title: "Solo", excerpt: "Only here." }],
      }),
      "openalex.org": ok({
        results: [
          { display_name: "Filler A", primary_location: { landing_page_url: "https://a.example/1" } },
          { display_name: "Shared", doi: "10.9/shared" },
        ],
      }),
      "api.crossref.org": ok({
        message: {
          items: [
            { DOI: "10.8/filler", title: ["Filler B"] },
            { DOI: "10.9/shared", URL: shared, title: ["Shared"] },
          ],
        },
      }),
      esearch: ok({ esearchresult: { idlist: [] } }),
      "export.arxiv.org": okText(arxivFeed([])),
    }),
    query: "shared",
    maxResults: 5,
  });
  assert.equal(merged[0].url, shared);
});

test("web_search falls back to keyless providers when the primary provider fails", async () => {
  const context = {
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "k",
      requestTimeoutMs: 30_000,
      freeSearchFallbackEnabled: true,
    },
    httpTransport: transportFor({
      "/web_search": { status: 500, headers: {} },
      "wikipedia.org": ok({
        pages: [{ key: "Topic", title: "Topic", excerpt: "About the topic." }],
      }),
      "openalex.org": ok({ results: [] }),
    }),
  } as unknown as ToolExecutionContext;

  const result = (await webSearchTool.execute({ query: "topic" }, context)) as {
    results: Array<{ url: string }>;
  };
  assert.ok(
    result.results.some((item) =>
      item.url.includes("wikipedia.org/wiki/Topic"),
    ),
  );
});

test("web_search passes a scholarly publication date through to candidate ranking", async () => {
  const context = {
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "k",
      requestTimeoutMs: 30_000,
      freeSearchFallbackEnabled: true,
    },
    httpTransport: transportFor({
      "/web_search": { status: 500, headers: {} },
      "api.crossref.org": ok({
        message: {
          items: [
            {
              DOI: "10.5/dated",
              URL: "https://journal.example/dated",
              title: ["A dated work"],
              issued: { "date-parts": [[2025, 4, 9]] },
            },
          ],
        },
      }),
    }),
  } as unknown as ToolExecutionContext;

  const result = (await webSearchTool.execute({ query: "dated" }, context)) as {
    results: Array<{ url: string; published_at?: string }>;
  };
  const dated = result.results.find((item) => item.url.includes("journal.example"));
  // Without this field the worker's freshness signal falls back to a constant
  // and candidate ordering collapses to the source-type ordering.
  assert.equal(dated?.published_at, "2025-04-09");
});

test("web_search omits published_at entirely for providers that do not date results", async () => {
  const context = {
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "k",
      requestTimeoutMs: 30_000,
      freeSearchFallbackEnabled: true,
    },
    httpTransport: transportFor({
      "/web_search": { status: 500, headers: {} },
      "wikipedia.org": ok({
        pages: [{ key: "Topic", title: "Topic", excerpt: "About the topic." }],
      }),
    }),
  } as unknown as ToolExecutionContext;

  const result = (await webSearchTool.execute({ query: "topic" }, context)) as {
    results: Array<Record<string, unknown>>;
  };
  assert.ok(result.results.length > 0);
  assert.ok(!("published_at" in result.results[0]));
});

test("web_search surfaces the primary error when the fallback is disabled", async () => {
  const context = {
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "k",
      requestTimeoutMs: 30_000,
      freeSearchFallbackEnabled: false,
    },
    httpTransport: transportFor({ "/web_search": { status: 500, headers: {} } }),
  } as unknown as ToolExecutionContext;

  await assert.rejects(() => webSearchTool.execute({ query: "topic" }, context));
});
