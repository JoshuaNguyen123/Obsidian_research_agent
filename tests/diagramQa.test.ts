import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectCanvasQa,
  MAX_CANVAS_QA_REPAIR_PASSES,
  runCanvasQa,
} from "../src/design/diagramQa";
import type { JsonCanvas, JsonCanvasNode } from "../src/design/jsonCanvas";

test("Canvas QA exempts contained groups and title nodes from connectivity noise", () => {
  const canvas: JsonCanvas = {
    nodes: [
      textNode("canvas-title", 0, 0, 720, 120, "# Architecture"),
      { id: "lane", type: "group", x: 0, y: 200, width: 680, height: 260, label: "System" },
      textNode("api", 40, 240, 240, 160, "# API\n\nReceives requests."),
      textNode("store", 360, 240, 240, 160, "# Store\n\nPersists data."),
    ],
    edges: [{ id: "api-store", fromNode: "api", toNode: "store" }],
  };

  const report = runCanvasQa(canvas);

  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
  assert.equal(report.passCount, 0);
});

test("Canvas QA deterministically reports bounds, overlap, truncation, intersections, and components", () => {
  const canvas: JsonCanvas = {
    nodes: [
      textNode("a", 0, 0, 100, 100, "A"),
      textNode("b", 80, 0, 100, 80, "This text is intentionally long enough to wrap across many narrow lines and be truncated."),
      textNode("c", 400, 0, 100, 100, "C"),
      textNode("d", 0, 300, 100, 100, "D"),
      textNode("invalid", Number.NaN, 0, 0, 100, "Invalid"),
    ],
    edges: [{ id: "a-c", fromNode: "a", fromSide: "right", toNode: "c", toSide: "left" }],
  };

  const first = inspectCanvasQa(canvas);
  const second = inspectCanvasQa(canvas);
  const kinds = new Set(first.map((item) => item.kind));

  assert.deepEqual(first, second);
  assert.equal(kinds.has("invalid_bounds"), true);
  assert.equal(kinds.has("node_overlap"), true);
  assert.equal(kinds.has("text_truncation"), true);
  assert.equal(kinds.has("edge_node_intersection"), true);
  assert.equal(kinds.has("disconnected_component"), true);
  assert.deepEqual(
    first.map((item) => item.id),
    [...first.map((item) => item.id)].sort((left, right) => {
      const order = [
        "invalid_bounds",
        "node_overlap",
        "text_truncation",
        "edge_node_intersection",
        "disconnected_component",
        "excessive_edge_crossings",
      ];
      const leftKind = left.split(":")[1];
      const rightKind = right.split(":")[1];
      return order.indexOf(leftKind) - order.indexOf(rightKind) || left.localeCompare(right);
    }),
  );
});

test("Canvas QA counts only proper crossings between edges without shared nodes", () => {
  const canvas = crossingCanvas();
  canvas.edges.push({ id: "a-extra", fromNode: "a", toNode: "c" });

  const issues = inspectCanvasQa(canvas, { maxEdgeCrossings: 0 });
  const crossing = issues.find((item) => item.kind === "excessive_edge_crossings");

  assert.ok(crossing);
  assert.equal(crossing.metrics?.crossingCount, 1);
  assert.deepEqual(crossing.edgeIds, ["a-b", "c-d"]);
});

test("Canvas QA repairs safe geometry without mutating input", () => {
  const canvas: JsonCanvas = {
    nodes: [
      textNode("a", 0, 0, 180, 60, "A very long text block ".repeat(18)),
      textNode("b", 0, 0, 180, 60, "B"),
    ],
    edges: [{ id: "a-b", fromNode: "a", toNode: "b" }],
  };
  const original = structuredClone(canvas);

  const report = runCanvasQa(canvas, { autoRepair: true });

  assert.deepEqual(canvas, original);
  assert.equal(report.ok, true);
  assert.equal(report.passCount, 1);
  assert.ok(report.repairs.some((item) => item.kind === "resize_text_node"));
  assert.ok(report.repairs.some((item) => item.kind === "move_node"));
  assert.notDeepEqual(report.canvas.nodes, original.nodes);
});

test("automatic crossing repair is deterministic and never exceeds two passes", () => {
  const first = runCanvasQa(crossingCanvas(), {
    autoRepair: true,
    maxRepairPasses: 99,
    maxEdgeCrossings: 0,
  });
  const second = runCanvasQa(crossingCanvas(), {
    autoRepair: true,
    maxRepairPasses: 99,
    maxEdgeCrossings: 0,
  });

  assert.equal(first.passCount <= MAX_CANVAS_QA_REPAIR_PASSES, true);
  assert.equal(first.passCount, 2);
  assert.deepEqual(first, second);
  assert.ok(first.repairs.some((item) => item.kind === "relayout_crossings"));
  assert.ok(first.issues.some((item) => item.kind === "disconnected_component"));
});

function crossingCanvas(): JsonCanvas {
  return {
    nodes: [
      textNode("a", 0, 0, 40, 40, "A"),
      textNode("b", 400, 400, 40, 40, "B"),
      textNode("c", 0, 400, 40, 40, "C"),
      textNode("d", 400, 0, 40, 40, "D"),
    ],
    edges: [
      { id: "a-b", fromNode: "a", toNode: "b" },
      { id: "c-d", fromNode: "c", toNode: "d" },
    ],
  };
}

function textNode(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
): JsonCanvasNode {
  return { id, type: "text", x, y, width, height, text };
}
