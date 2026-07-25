import assert from "node:assert/strict";
import test from "node:test";

import { buildHtmlPreviewDocument } from "../src/ui/htmlPreview";

test("html preview srcdoc is deterministic and theme-independent", () => {
  // Tool receipts fingerprint this document; it must be byte-identical across
  // calls and carry no computed theme values. Theme adaptation happens purely
  // through CSS system colors resolved by the embedder's color-scheme.
  const first = buildHtmlPreviewDocument("<p>hello</p>", { title: "Doc" });
  const second = buildHtmlPreviewDocument("<p>hello</p>", { title: "Doc" });
  assert.equal(first, second);
  assert.match(first, /color-scheme:light dark/u);
  assert.match(first, /background:Canvas;color:CanvasText/u);
  // No hardcoded light-theme colors and no injected rgb/hex values.
  assert.doesNotMatch(first, /#fff|#111|rgb\(/u);
});

test("html preview keeps its locked-down CSP and document shell", () => {
  const document = buildHtmlPreviewDocument("<p>content</p>");
  assert.match(document, /^<!doctype html>/u);
  assert.match(document, /http-equiv="Content-Security-Policy"/u);
  assert.match(document, /default-src &#39;none&#39;/u);
  assert.match(document, /script-src &#39;none&#39;/u);
  assert.match(document, /connect-src &#39;none&#39;/u);
});

test("html preview escapes the title and embeds the body verbatim", () => {
  const document = buildHtmlPreviewDocument("<p>body</p>", {
    title: '<script>"x"</script>',
  });
  assert.match(document, /<title>&lt;script&gt;&quot;x&quot;&lt;\/script&gt;<\/title>/u);
  assert.match(document, /<p>body<\/p>/u);
});
