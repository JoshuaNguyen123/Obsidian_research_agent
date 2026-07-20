import test from "node:test";
import assert from "node:assert/strict";
import { renderJsonCanvasSvg } from "../src/design/canvasSvg";
import type { JsonCanvas } from "../src/design/jsonCanvas";

const canvas: JsonCanvas = {
  nodes: [
    {
      id: "boundary",
      type: "group",
      x: -120,
      y: -80,
      width: 680,
      height: 320,
      label: "Trust & <scale> boundary",
      background: "https://should-not-be-exported.example/image.png",
      color: "4",
    },
    {
      id: "api",
      type: "text",
      x: -80,
      y: 0,
      width: 220,
      height: 100,
      text: "API <Gateway> & ingress",
      color: "5",
    },
    {
      id: "workers",
      type: "text",
      x: 280,
      y: 0,
      width: 220,
      height: 100,
      text: "Workers\n<script>alert('no')</script>",
      color: "6",
    },
  ],
  edges: [
    {
      id: "requests",
      fromNode: "api",
      fromSide: "right",
      toNode: "workers",
      toSide: "left",
      toEnd: "arrow",
      label: "async & bounded",
    },
  ],
};

test("renders text, groups, edges, and negative coordinates deterministically", () => {
  const first = renderJsonCanvasSvg(canvas, { title: "Distributed <system>", padding: 40 });
  const second = renderJsonCanvasSvg(canvas, { title: "Distributed <system>", padding: 40 });

  assert.equal(first, second);
  assert.match(first, /width="760" height="400" viewBox="0 0 760 400"/u);
  assert.match(first, /transform="translate\(160 120\)"/u);
  assert.match(first, /data-node-id="boundary"/u);
  assert.match(first, /stroke-dasharray="8 6"/u);
  assert.match(first, /data-edge-id="requests"/u);
  assert.match(first, /marker-end="url\(#canvas-arrow\)"/u);
  assert.match(first, /API &lt;Gateway&gt; &amp;/u);
  assert.match(first, />ingress<\/tspan>/u);
  assert.match(first, /Trust &amp; &lt;scale&gt; boundary/u);
  assert.match(first, /async &amp; bounded/u);
});

test("exports only passive SVG content and does not expose file or URL targets", () => {
  const withReferences: JsonCanvas = {
    nodes: [
      ...canvas.nodes,
      {
        id: "file",
        type: "file",
        x: 0,
        y: 180,
        width: 200,
        height: 80,
        file: "Private/credentials.md",
      },
      {
        id: "link",
        type: "link",
        x: 240,
        y: 180,
        width: 200,
        height: 80,
        url: "https://secret.example/path?token=hidden",
      },
    ],
    edges: canvas.edges,
  };

  const svg = renderJsonCanvasSvg(withReferences);
  assert.doesNotMatch(svg, /<script\b/iu);
  assert.doesNotMatch(svg, /<foreignObject\b|<image\b|\bhref=/iu);
  assert.doesNotMatch(svg, /should-not-be-exported|credentials\.md|secret\.example|token=hidden/iu);
  assert.match(svg, /File reference/u);
  assert.match(svg, /External link/u);
  assert.match(svg, /&lt;script&gt;alert\('no'\)&lt;/u);
  assert.match(svg, /\/script&gt;/u);
});

test("uses JSON Canvas default arrow semantics and validates input", () => {
  const implicitArrow: JsonCanvas = {
    ...canvas,
    edges: [{
      id: "implicit",
      fromNode: "api",
      toNode: "workers",
    }],
  };
  const svg = renderJsonCanvasSvg(implicitArrow);
  assert.match(svg, /data-edge-id="implicit"[\s\S]*marker-end="url\(#canvas-arrow\)"/u);

  assert.throws(
    () => renderJsonCanvasSvg({ nodes: [], edges: [{ id: "bad", fromNode: "a", toNode: "b" }] } as JsonCanvas),
    /Invalid JSON Canvas/u,
  );
  assert.throws(
    () => renderJsonCanvasSvg(canvas, { padding: -1 }),
    /padding must be a finite number from 0 to 500/u,
  );
});

test("rejects pathological geometry before producing an oversized SVG", () => {
  const node = canvas.nodes[1];
  assert.throws(
    () => renderJsonCanvasSvg({
      nodes: [{ ...node, id: "far-away", x: 1_000_001 }],
      edges: [],
    }),
    /coordinates must stay within/iu,
  );
  assert.throws(
    () => renderJsonCanvasSvg({
      nodes: [{ ...node, id: "too-wide", width: 8_193 }],
      edges: [],
    }),
    /dimensions must not exceed/iu,
  );
  assert.throws(
    () => renderJsonCanvasSvg({
      nodes: [
        { ...node, id: "left", x: -40_000, width: 10 },
        { ...node, id: "right", x: 40_000, width: 10 },
      ],
      edges: [],
    }),
    /viewport must not exceed/iu,
  );
});
