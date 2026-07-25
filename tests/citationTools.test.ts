import assert from "node:assert/strict";
import test from "node:test";

import {
  createCitationTools,
  extractArxivId,
  extractDoi,
  formatBibtexEntry,
} from "../src/tools/citationTools";
import type { HttpRequest, HttpResponse } from "../src/model/types";
import type { ToolExecutionContext } from "../src/tools/types";

const tools = createCitationTools();
const resolveCitation = tools.find((tool) => tool.name === "resolve_citation")!;
const verifyCitation = tools.find((tool) => tool.name === "verify_citation")!;
const exportBibtex = tools.find((tool) => tool.name === "export_bibtex")!;

function contextWith(
  transport:
    | HttpResponse
    | ((request: HttpRequest) => Promise<HttpResponse> | HttpResponse),
): ToolExecutionContext {
  return {
    app: { vault: { getFileByPath: () => null } },
    settings: { requestTimeoutMs: 30_000 },
    originalPrompt: "Resolve citations.",
    reportProgress: () => {},
    httpTransport: async (request: HttpRequest) =>
      typeof transport === "function" ? transport(request) : transport,
    now: () => new Date(0),
  } as unknown as ToolExecutionContext;
}

const CROSSREF_WORK = {
  message: {
    title: ["Attention Is All You Need"],
    author: [
      { given: "Ashish", family: "Vaswani" },
      { given: "Noam", family: "Shazeer" },
    ],
    issued: { "date-parts": [[2017, 6]] },
    "container-title": ["Advances in Neural Information Processing Systems"],
    DOI: "10.5555/3295222",
    URL: "https://doi.org/10.5555/3295222",
    abstract: "<jats:p>The dominant sequence transduction models…</jats:p>",
  },
};

test("identifier extraction handles DOI and arXiv forms", () => {
  assert.equal(extractDoi("10.1000/xyz123"), "10.1000/xyz123");
  assert.equal(extractDoi("https://doi.org/10.1000/xyz123?ref=1"), "10.1000/xyz123");
  assert.equal(extractDoi("Attention Is All You Need"), null);
  assert.equal(extractArxivId("2401.12345"), "2401.12345");
  assert.equal(extractArxivId("arXiv:2401.12345v2"), "2401.12345v2");
  assert.equal(extractArxivId("https://arxiv.org/abs/2401.12345"), "2401.12345");
  assert.equal(extractArxivId("https://arxiv.org/pdf/2401.12345v3"), "2401.12345v3");
  assert.equal(extractArxivId("not an id"), null);
});

test("resolve_citation resolves a DOI through Crossref and normalizes the record", async () => {
  const requests: HttpRequest[] = [];
  const context = contextWith((request) => {
    requests.push(request);
    return { status: 200, headers: {}, json: CROSSREF_WORK };
  });
  const result = (await resolveCitation.execute(
    { identifier: "https://doi.org/10.5555/3295222" },
    context,
  )) as Record<string, any>;
  assert.equal(result.status, "resolved");
  assert.equal(result.via, "crossref_doi");
  assert.match(requests[0]!.url, /api\.crossref\.org\/works\/10\.5555%2F3295222/u);
  assert.equal(result.record.title, "Attention Is All You Need");
  assert.deepEqual(result.record.authors, ["Ashish Vaswani", "Noam Shazeer"]);
  assert.equal(result.record.year, 2017);
  assert.equal(result.record.doi, "10.5555/3295222");
  assert.equal(result.record.sourceId, "citation:10.5555/3295222");
  // JATS markup is stripped from the abstract.
  assert.doesNotMatch(result.record.abstract ?? "", /<jats/u);
});

test("resolve_citation resolves arXiv ids from the Atom feed", async () => {
  const atom = [
    "<feed>",
    "<entry>",
    "<id>http://arxiv.org/abs/2401.12345v1</id>",
    "<published>2024-01-22T00:00:00Z</published>",
    "<title>A Study of  Things</title>",
    "<summary>We study things.</summary>",
    "<author><name>Jane Smith</name></author>",
    "<author><name>John Doe</name></author>",
    "</entry>",
    "</feed>",
  ].join("\n");
  const context = contextWith({ status: 200, headers: {}, text: atom } as never);
  const result = (await resolveCitation.execute(
    { identifier: "arXiv:2401.12345" },
    context,
  )) as Record<string, any>;
  assert.equal(result.via, "arxiv");
  assert.equal(result.record.title, "A Study of Things");
  assert.deepEqual(result.record.authors, ["Jane Smith", "John Doe"]);
  assert.equal(result.record.year, 2024);
  assert.equal(result.record.arxivId, "2401.12345");
  assert.equal(result.record.url, "https://arxiv.org/abs/2401.12345");
});

test("resolve_citation falls back to Crossref search for titles and reports misses", async () => {
  const found = contextWith({
    status: 200,
    headers: {},
    json: { message: { items: [CROSSREF_WORK.message] } },
  } as never);
  const hit = (await resolveCitation.execute(
    { identifier: "Attention Is All You Need" },
    found,
  )) as Record<string, any>;
  assert.equal(hit.via, "crossref_search");
  assert.equal(hit.record.kind, "search");

  const empty = contextWith({
    status: 200,
    headers: {},
    json: { message: { items: [] } },
  } as never);
  const miss = (await resolveCitation.execute(
    { identifier: "definitely nonexistent paper xyz" },
    empty,
  )) as Record<string, any>;
  assert.equal(miss.status, "not_found");
});

test("resolve_citation surfaces provider failures without fabricating records", async () => {
  const rateLimited = contextWith({ status: 429, headers: {} } as never);
  await assert.rejects(
    () => resolveCitation.execute({ identifier: "10.1000/x" }, rateLimited),
    /rate-limited/u,
  );
  const missing = contextWith({ status: 404, headers: {} } as never);
  await assert.rejects(
    () => resolveCitation.execute({ identifier: "10.1000/x" }, missing),
    /no record/u,
  );
  const malformed = contextWith({ status: 200, headers: {}, text: "not json" } as never);
  await assert.rejects(
    () => resolveCitation.execute({ identifier: "10.1000/x" }, malformed),
    /malformed JSON/u,
  );
});

test("verify_citation is unverifiable without a cached source and bounds its quote", async () => {
  const context = contextWith({ status: 500, headers: {} } as never);
  const result = (await verifyCitation.execute(
    { quote: "a quote that was never fetched into cache", url: "https://example.com/a" },
    context,
  )) as Record<string, any>;
  assert.equal(result.status, "unverifiable");

  await assert.rejects(
    () => verifyCitation.execute({ quote: "short", url: "https://x" }, context),
    /10–600 characters/u,
  );
  await assert.rejects(
    () => verifyCitation.execute({ quote: "a".repeat(20) }, context),
    /requires url or path/u,
  );
});

test("export_bibtex formats records with escaping and stable keys", async () => {
  const context = contextWith({ status: 500, headers: {} } as never);
  const result = (await exportBibtex.execute(
    {
      records: [
        {
          title: "Costs & Benefits: 100% of _cases_ {sometimes}",
          authors: ["Jane Smith", "John Doe"],
          year: 2024,
          venue: "Journal of Testing",
          doi: "10.1000/x_y",
          url: "https://doi.org/10.1000/x_y",
        },
        {
          title: "An arXiv preprint",
          authors: ["Solo Author"],
          year: 2023,
          arxivId: "2301.00001",
        },
      ],
    },
    context,
  )) as Record<string, any>;
  assert.equal(result.count, 2);
  assert.match(result.bibtex, /@article\{JaneSmith2024,/u);
  assert.match(result.bibtex, /Costs \\& Benefits: 100\\% of \\_cases\\_ sometimes/u);
  assert.match(result.bibtex, /author = \{Jane Smith and John Doe\}/u);
  assert.match(result.bibtex, /@misc\{SoloAuthor2023,/u);
  assert.match(result.bibtex, /archivePrefix = \{arXiv\}/u);

  await assert.rejects(
    () => exportBibtex.execute({ records: [] }, context),
    /at least one record/u,
  );
  assert.throws(() => formatBibtexEntry({ title: "" }, 0), /no title/u);
});
