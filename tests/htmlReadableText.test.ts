import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeHtmlEntitiesV1,
  htmlTitleV1,
  htmlToReadableTextV1,
  isReadableTextContentTypeV1,
} from "../src/tools/htmlReadableText";

const PAGE = `<!doctype html>
<html><head>
  <title>Sharding &amp; Replication</title>
  <style>body { color: #fff }</style>
  <script>console.log("tracker");</script>
</head>
<body>
  <nav><a href="/home">Home</a></nav>
  <main>
    <h1>Sharding &amp; Replication</h1>
    <p>A shard is a horizontal partition of data. Each shard holds a
       distinct subset of rows.</p>
    <h2>Trade-offs</h2>
    <ul><li>Cross-shard joins get expensive.</li><li>Rebalancing moves data.</li></ul>
    <p>See the <a href="/papers/spanner.html">Spanner paper</a> for more.</p>
  </main>
  <footer><a href="/legal">Legal</a></footer>
</body></html>`;

test("the reader keeps prose and structure and drops code", () => {
  const readable = htmlToReadableTextV1(PAGE, { baseUrl: "https://db.example/guide" });
  assert.equal(readable.title, "Sharding & Replication");
  assert.match(readable.text, /# Sharding & Replication/u);
  assert.match(readable.text, /## Trade-offs/u);
  assert.match(readable.text, /- Cross-shard joins get expensive\./u);
  assert.match(readable.text, /A shard is a horizontal partition of data\./u);
  assert.ok(!readable.text.includes("tracker"), "script text must not survive");
  assert.ok(!readable.text.includes("color: #fff"), "style text must not survive");
  assert.ok(!readable.text.includes("<"), "no markup may survive");
});

test("navigation and footer chrome are dropped with the main region present", () => {
  const readable = htmlToReadableTextV1(PAGE, { baseUrl: "https://db.example/guide" });
  assert.ok(!readable.text.includes("Home"));
  assert.ok(!readable.text.includes("Legal"));
});

test("links are resolved against the page and deduplicated", () => {
  const readable = htmlToReadableTextV1(PAGE, { baseUrl: "https://db.example/guide" });
  assert.ok(readable.links.includes("https://db.example/papers/spanner.html"));
  assert.equal(new Set(readable.links).size, readable.links.length);
  assert.ok(
    !readable.links.some((link) => /^(javascript|mailto|data):/iu.test(link)),
  );
});

test("a page with no main region still yields its body text", () => {
  const readable = htmlToReadableTextV1(
    "<html><body><p>Plain body paragraph.</p></body></html>",
  );
  assert.match(readable.text, /Plain body paragraph\./u);
});

test("entities decode, including numeric forms", () => {
  assert.equal(decodeHtmlEntitiesV1("A &amp; B &#8212; C &#x2014; D &nbsp;E"), "A & B — C — D  E");
  assert.equal(decodeHtmlEntitiesV1("&unknownentity;"), "&unknownentity;");
  assert.equal(htmlTitleV1("<html><head><title> Spaced  Title </title>"), "Spaced Title");
});

test("output is bounded", () => {
  const long = `<html><body><p>${"word ".repeat(50_000)}</p></body></html>`;
  const readable = htmlToReadableTextV1(long, { maxChars: 1_000 });
  assert.equal(readable.text.length, 1_000);
});

test("only text-ish content types are read here", () => {
  assert.ok(isReadableTextContentTypeV1("text/html; charset=utf-8"));
  assert.ok(isReadableTextContentTypeV1("application/json"));
  assert.ok(isReadableTextContentTypeV1("application/xhtml+xml"));
  assert.ok(isReadableTextContentTypeV1(undefined));
  // A PDF belongs to extract_document, which has a parser for it.
  assert.ok(!isReadableTextContentTypeV1("application/pdf"));
  assert.ok(!isReadableTextContentTypeV1("image/png"));
  assert.ok(!isReadableTextContentTypeV1("application/octet-stream"));
});
