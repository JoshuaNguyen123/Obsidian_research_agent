import test from "node:test";
import assert from "node:assert/strict";
import {
  applySafeSvgPatch,
  MAX_SAFE_SVG_BYTES,
  parseSafeSvg,
  type SvgPatchOperation,
} from "../src/design/svgPatch";

const SAFE_SVG = [
  '<svg id="root" xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180" role="img" aria-label="Flow">',
  "  <!-- preserve this comment -->",
  '  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#5cff8d"/></marker></defs>',
  '  <rect id="keep" x="10" y="20" width="100" height="60" fill="#061007" stroke="#5cff8d"/>',
  '  <text id="label" x="20" y="50" fill="#a8ffbf" font-size="16">Original</text>',
  '  <line id="remove" x1="110" y1="50" x2="200" y2="50" stroke="#5cff8d" marker-end="url(#arrow)"/>',
  "</svg>",
  "",
].join("\n");

test("safe SVG parser accepts repository output and returns deterministic structure", () => {
  const first = parseSafeSvg(SAFE_SVG);
  const second = parseSafeSvg(SAFE_SVG);

  assert.deepEqual(first, second);
  assert.equal(first.elementCount, 7);
  assert.deepEqual(first.stableIds, ["root", "arrow", "keep", "label", "remove"]);
  assert.equal(first.qa.ok, true);
  assert.deepEqual(first.qa.canvasBounds, { x: 0, y: 0, width: 320, height: 180 });
});

test("safe SVG parser rejects active content and external-resource channels", () => {
  const unsafe = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/icon.svg#x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml,evil"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.com/paint)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://example.com/x)}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="javascript:alert(1)"/></svg>',
  ];

  unsafe.forEach((source) => assert.throws(() => parseSafeSvg(source), /not allowed|DOCTYPE|href|URL|url|attribute/i));
  assert.throws(
    () => parseSafeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><desc>${"x".repeat(MAX_SAFE_SVG_BYTES)}</desc></svg>`),
    /exceeds/i,
  );
  assert.throws(
    () => parseSafeSvg('<svg xmlns="http://www.w3.org/2000/svg">\ud800</svg>'),
    /Unicode/i,
  );
});

test("ID-scoped SVG patches preserve unrelated content and element order", () => {
  const operations: SvgPatchOperation[] = [
    { op: "update_text", id: "label", text: "Updated <safe> & reviewed" },
    { op: "update_attributes", id: "keep", attributes: { fill: "#123456", rx: 8 } },
    { op: "remove_element", id: "remove" },
    {
      op: "add_shape",
      parentId: "root",
      shape: {
        type: "circle",
        id: "added",
        cx: 250,
        cy: 90,
        r: 24,
        fill: "#061007",
        stroke: "#5cff8d",
        strokeWidth: 2,
      },
    },
  ];

  const result = applySafeSvgPatch(SAFE_SVG, operations);

  assert.match(result.content, /<!-- preserve this comment -->/);
  assert.match(result.content, /Updated &lt;safe&gt; &amp; reviewed/);
  assert.match(result.content, /id="keep" x="10" y="20" width="100" height="60" fill="#123456" stroke="#5cff8d" rx="8"/);
  assert.doesNotMatch(result.content, /id="remove"/);
  assert.match(result.content, /<circle id="added" cx="250" cy="90" r="24"/);
  assert.ok(result.content.indexOf('id="keep"') < result.content.indexOf('id="label"'));
  assert.ok(result.content.indexOf('id="label"') < result.content.indexOf('id="added"'));
  assert.equal(result.document.qa.ok, true);
  assert.deepEqual(result.preservation.targetedIds, ["keep", "label", "remove", "root"]);
  assert.deepEqual(result.preservation.addedIds, ["added"]);
  assert.deepEqual(result.preservation.removedIds, ["remove"]);
  assert.equal(result.preservation.stableIdOrderPreserved, true);
  assert.ok(result.preservation.preservedStartTagIds.includes("arrow"));
  assert.ok(result.preservation.preservedStartTagIds.includes("label"));
  assert.equal(result.preservation.unrelatedSourceSlicesPreserved, true);
});

test("SVG patching requires stable ids and validates attributes and shapes", () => {
  assert.throws(
    () => applySafeSvgPatch(SAFE_SVG, [{ op: "update_text", id: "missing", text: "x" }]),
    /not found/i,
  );
  assert.throws(
    () => applySafeSvgPatch(SAFE_SVG, [{ op: "update_attributes", id: "keep", attributes: { onclick: "evil" } }]),
    /not allowed|event handler/i,
  );
  assert.throws(
    () => applySafeSvgPatch(SAFE_SVG, [{ op: "update_attributes", id: "keep", attributes: { fill: "url(https://evil)" } }]),
    /URL/i,
  );
  assert.throws(
    () => applySafeSvgPatch(SAFE_SVG, [{ op: "update_attributes", id: "keep", attributes: { id: "changed" } }]),
    /identity/i,
  );
  assert.throws(
    () => applySafeSvgPatch(SAFE_SVG, [{ op: "remove_element", id: "root" }]),
    /root/i,
  );
  assert.throws(
    () => applySafeSvgPatch(SAFE_SVG, [{ op: "add_shape", parentId: "root", shape: { type: "circle", id: "bad", cx: 10, cy: 10, r: -2 } }]),
    /positive/i,
  );
  assert.throws(
    () => applySafeSvgPatch(SAFE_SVG, [{ op: "add_shape", parentId: "missing", shape: { type: "circle", id: "new", cx: 10, cy: 10, r: 2 } }]),
    /not found/i,
  );
  assert.throws(
    () => parseSafeSvg('<svg id="root" xmlns="http://www.w3.org/2000/svg"><rect id="same"/><circle id="same"/></svg>'),
    /duplicated/i,
  );
});

test("SVG QA deterministically reports shape bounds and estimated text overflow", () => {
  const source = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">',
    '  <rect id="outside" x="90" y="90" width="20" height="20"/>',
    '  <text id="overflow" x="92" y="20" font-size="16">This cannot fit</text>',
    "</svg>",
  ].join("\n");

  const first = parseSafeSvg(source).qa;
  const second = parseSafeSvg(source).qa;

  assert.deepEqual(first, second);
  assert.equal(first.ok, false);
  assert.deepEqual(first.issues.map((item) => item.kind), ["out_of_bounds", "text_overflow"]);
  assert.deepEqual(first.issues.map((item) => item.elementId), ["outside", "overflow"]);
});
