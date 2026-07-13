import assert from "node:assert/strict";
import test from "node:test";

import {
  MERMAID_MAX_BYTES,
  MermaidBlockError,
  listMermaidBlocks,
  mermaidBlockIdMarker,
  readMermaidBlock,
  upsertMermaidBlock,
  validateMermaidText,
} from "../src/design/mermaidBlocks";

test("lists and reads Mermaid blocks while ignoring headings and fences inside other fenced code", () => {
  const markdown = [
    "# Diagram notes",
    "",
    "```text",
    "## Architecture",
    "```mermaid",
    "graph TD; Fake-->Block",
    "```",
    "",
    "## Architecture ##",
    "Some context remains outside the diagram.",
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "",
    "## Sequence",
    mermaidBlockIdMarker("request-flow"),
    "~~~mermaid",
    "sequenceDiagram",
    "  Alice->>Bob: Hello",
    "~~~",
    "",
  ].join("\n");

  const blocks = listMermaidBlocks(markdown);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].heading?.text, "Architecture");
  assert.equal(blocks[0].blockId, null);
  assert.equal(blocks[1].heading?.text, "Sequence");
  assert.equal(blocks[1].blockId, "request-flow");

  assert.equal(
    readMermaidBlock(markdown, { kind: "heading", heading: "Architecture" }).mermaid,
    "flowchart LR\n  A --> B",
  );
  assert.equal(
    readMermaidBlock(markdown, { kind: "block_id", blockId: "request-flow" }).mermaid,
    "sequenceDiagram\n  Alice->>Bob: Hello",
  );
});

test("supports exact Setext heading selection", () => {
  const markdown = [
    "System map",
    "----------",
    "",
    "```mermaid",
    "graph TD",
    "  A --> B",
    "```",
  ].join("\n");

  const result = readMermaidBlock(markdown, {
    kind: "heading",
    heading: "System map",
  });
  assert.equal(result.metadata.heading?.level, 2);
  assert.equal(result.mermaid, "graph TD\n  A --> B");
});

test("reports heading, block, and block-id ambiguity instead of guessing", () => {
  assertMermaidError(
    () => readMermaidBlock(
      "## Same\n\n```mermaid\ngraph TD\n```\n\n## Same\n\n```mermaid\ngraph LR\n```\n",
      { kind: "heading", heading: "Same" },
    ),
    "ambiguous_heading",
  );

  assertMermaidError(
    () => readMermaidBlock(
      "## Same\n\n```mermaid\ngraph TD\n```\n\n```mermaid\ngraph LR\n```\n",
      { kind: "heading", heading: "Same" },
    ),
    "ambiguous_heading_block",
  );

  const marker = mermaidBlockIdMarker("duplicate");
  assertMermaidError(
    () => readMermaidBlock(
      `${marker}\n\`\`\`mermaid\ngraph TD\n\`\`\`\n${marker}\n\`\`\`mermaid\ngraph LR\n\`\`\`\n`,
      { kind: "block_id", blockId: "duplicate" },
    ),
    "ambiguous_block_id",
  );
});

test("updates only selected Mermaid content and preserves unrelated CRLF Markdown byte-for-byte", () => {
  const markdown = [
    "# Design",
    "",
    "Intro with  two spaces.",
    "",
    "## Architecture",
    "Keep this prose exactly.",
    "```mermaid",
    "graph TD",
    "  Old --> Node",
    "```",
    "",
    "## Appendix",
    "```json",
    "{\"unchanged\":true}",
    "```",
    "Trailing text.",
    "",
  ].join("\r\n");
  const beforeBlock = readMermaidBlock(markdown, {
    kind: "heading",
    heading: "Architecture",
  }).metadata;
  const prefix = markdown.slice(0, beforeBlock.contentStart);
  const suffix = markdown.slice(beforeBlock.contentEnd);

  const result = upsertMermaidBlock(
    markdown,
    { kind: "heading", heading: "Architecture" },
    "flowchart LR\r\n  New --> Node\r\n",
  );

  assert.equal(result.operation, "update");
  assert.equal(result.before.matched, true);
  assert.equal(result.before.block?.contentStart, beforeBlock.contentStart);
  assert.equal(result.after.matched, true);
  assert.equal(result.markdown.slice(0, result.after.block?.contentStart), prefix);
  assert.equal(result.markdown.slice(result.after.block?.contentEnd), suffix);
  assert.equal(
    readMermaidBlock(result.markdown, {
      kind: "heading",
      heading: "Architecture",
    }).mermaid,
    "flowchart LR\r\n  New --> Node",
  );
  assert.equal(result.markdown.includes("{\"unchanged\":true}"), true);
});

test("inserts a missing heading block before the next peer section without rewriting either side", () => {
  const markdown = [
    "# Design",
    "",
    "## Target",
    "Target prose.",
    "",
    "## Next",
    "Next prose remains exact.",
    "",
  ].join("\n");
  const nextOffset = markdown.indexOf("## Next");
  const prefix = markdown.slice(0, nextOffset);
  const suffix = markdown.slice(nextOffset);

  const result = upsertMermaidBlock(
    markdown,
    { kind: "heading", heading: "Target" },
    "graph TD\n  Target --> Done",
  );

  assert.equal(result.operation, "insert");
  assert.equal(result.before.matched, false);
  assert.equal(result.changedRange.beforeStart, nextOffset);
  assert.equal(result.markdown.slice(0, nextOffset), prefix);
  assert.equal(result.markdown.slice(result.changedRange.afterEnd), suffix);
  assert.equal(result.after.block?.heading?.text, "Target");
  assert.equal(
    readMermaidBlock(result.markdown, {
      kind: "heading",
      heading: "Target",
    }).mermaid,
    "graph TD\n  Target --> Done",
  );
});

test("appends a missing explicit block id using the canonical marker and reads it back", () => {
  const markdown = "# Scratch\n\nExisting prose without a trailing newline.";
  const result = upsertMermaidBlock(
    markdown,
    { kind: "block_id", blockId: "service-map.v1" },
    "graph LR\n  Client --> Service",
  );

  assert.equal(result.operation, "insert");
  assert.equal(result.markdown.slice(0, markdown.length), markdown);
  assert.equal(
    result.markdown.includes("<!-- agentic-mermaid:block-id=service-map.v1 -->\n```mermaid\n"),
    true,
  );
  const readback = readMermaidBlock(result.markdown, {
    kind: "block_id",
    blockId: "service-map.v1",
  });
  assert.equal(readback.mermaid, "graph LR\n  Client --> Service");
  assert.equal(result.after.block?.blockId, "service-map.v1");
});

test("requires an exact immediately preceding block-id marker", () => {
  const markdown = [
    "<!-- agentic-mermaid:block-id=target -->",
    "intervening prose",
    "```mermaid",
    "graph TD",
    "```",
    "",
  ].join("\n");

  assert.equal(listMermaidBlocks(markdown)[0].blockId, null);
  assertMermaidError(
    () => readMermaidBlock(markdown, { kind: "block_id", blockId: "target" }),
    "block_not_found",
  );
});

test("rejects dangerous Mermaid directives, callbacks, external links, active HTML, and fences", () => {
  const dangerous = [
    "%%{init: { 'theme': 'dark' }}%%\ngraph TD",
    "graph TD\nsecurityLevel: loose",
    "graph TD\nclick A \"https://example.com\"",
    "graph TD\nA[https://example.com]",
    "graph TD\nA[javascript:alert(1)]",
    "graph TD\nA[<script>alert(1)</script>]",
    "graph TD\nA[<a href='relative'>link</a>]",
    "graph TD\n```text\nunsafe\n```",
  ];

  for (const content of dangerous) {
    assertMermaidError(() => validateMermaidText(content), "dangerous_mermaid");
  }
});

test("enforces Mermaid content and selector bounds", () => {
  assertMermaidError(() => validateMermaidText(" \n"), "mermaid_too_large");
  assertMermaidError(
    () => validateMermaidText(`graph TD\n${"A".repeat(MERMAID_MAX_BYTES)}`),
    "mermaid_too_large",
  );
  assertMermaidError(
    () => readMermaidBlock("", { kind: "block_id", blockId: "UPPERCASE" }),
    "invalid_block_id",
  );
  assertMermaidError(
    () => upsertMermaidBlock(
      "# Present\n",
      { kind: "heading", heading: "Missing" },
      "graph TD",
    ),
    "heading_not_found",
  );
});

test("rejects an unclosed Mermaid fence", () => {
  assertMermaidError(
    () => listMermaidBlocks("# Design\n\n```mermaid\ngraph TD\n"),
    "unclosed_mermaid_fence",
  );
});

function assertMermaidError(fn: () => unknown, code: string): void {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof MermaidBlockError && error.code === code,
    `expected MermaidBlockError code ${code}`,
  );
}
