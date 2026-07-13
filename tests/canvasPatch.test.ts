import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCanvasPatch,
  deterministicCanvasAutoLayout,
  parseCanvasPatchOperations,
  type CanvasPatchOperation,
} from "../src/design/canvasPatch";
import type { JsonCanvas } from "../src/design/jsonCanvas";

test("Canvas patches preserve untouched objects, order, and unknown fields", () => {
  const canvas = createCanvas();
  const untouchedNode = canvas.nodes[1];
  const operations: CanvasPatchOperation[] = [
    {
      op: "update_node",
      id: "node-a",
      changes: { text: "# Updated A", color: "3" },
    },
    {
      op: "add_node",
      node: {
        id: "node-c",
        type: "text",
        x: 600,
        y: 0,
        width: 200,
        height: 100,
        text: "# C",
        pluginData: { createdBy: "test" },
      },
    },
    { op: "remove_edge", id: "edge-ab" },
    {
      op: "add_edge",
      edge: {
        id: "edge-bc",
        fromNode: "node-b",
        toNode: "node-c",
        toEnd: "arrow",
        customEdgeField: { weight: 2 },
      },
    },
  ];

  const result = applyCanvasPatch(canvas, operations);

  assert.deepEqual(result.canvas.nodes.map((node) => node.id), [
    "node-a",
    "node-b",
    "node-c",
  ]);
  assert.equal(result.canvas.nodes[1], untouchedNode);
  assert.deepEqual(result.canvas.nodes[0].pluginData, {
    owner: "user",
    nested: { keep: true },
  });
  assert.deepEqual(
    (result.canvas as JsonCanvas & { viewport?: unknown }).viewport,
    { x: 25, y: 50, zoom: 1.2 },
  );
  assert.deepEqual(result.preservation, {
    inputNodeCount: 2,
    outputNodeCount: 3,
    inputEdgeCount: 1,
    outputEdgeCount: 1,
    preservedNodeIds: ["node-a", "node-b"],
    preservedEdgeIds: [],
    untouchedNodeIds: ["node-b"],
    untouchedEdgeIds: [],
    addedNodeIds: ["node-c"],
    updatedNodeIds: ["node-a"],
    removedNodeIds: [],
    addedEdgeIds: ["edge-bc"],
    updatedEdgeIds: [],
    removedEdgeIds: ["edge-ab"],
    autoLaidOutNodeIds: [],
    preservedTopLevelKeys: ["viewport"],
  });
  assert.equal(canvas.nodes.length, 2);
  assert.equal(canvas.edges[0].id, "edge-ab");
  assert.equal((canvas.nodes[0] as { text?: string }).text, "# A");
});

test("Canvas patches reject duplicate and missing stable ids", () => {
  const canvas = createCanvas();

  assert.throws(
    () => applyCanvasPatch(canvas, [{ op: "add_node", node: canvas.nodes[0] }]),
    /duplicate Canvas id: node-a/i,
  );
  assert.throws(
    () =>
      applyCanvasPatch(canvas, [
        {
          op: "add_edge",
          edge: { id: "node-a", fromNode: "node-a", toNode: "node-b" },
        },
      ]),
    /duplicate Canvas id: node-a/i,
  );
  assert.throws(
    () =>
      applyCanvasPatch(canvas, [
        { op: "update_node", id: "missing", changes: { color: "2" } },
      ]),
    /missing node id: missing/i,
  );
  assert.throws(
    () =>
      applyCanvasPatch(canvas, [
        {
          op: "add_edge",
          edge: { id: "edge-missing", fromNode: "node-a", toNode: "missing" },
        },
      ]),
    /missing toNode id: missing/i,
  );
  assert.throws(
    () => applyCanvasPatch(canvas, [{ op: "remove_edge", id: "missing" }]),
    /missing edge id: missing/i,
  );
  assert.throws(
    () =>
      applyCanvasPatch(canvas, [
        {
          op: "update_node",
          id: "node-a",
          changes: { id: "replacement" } as never,
        },
      ]),
    /cannot change a stable Canvas id/i,
  );
});

test("node removal requires every incident edge removal in the same patch", () => {
  const canvas = createCanvas();
  assert.throws(
    () => applyCanvasPatch(canvas, [{ op: "remove_node", id: "node-a" }]),
    /incident edges must be removed in the same patch: edge-ab/i,
  );

  const result = applyCanvasPatch(canvas, [
    { op: "remove_node", id: "node-a" },
    { op: "remove_edge", id: "edge-ab" },
  ]);
  assert.deepEqual(result.canvas.nodes.map((node) => node.id), ["node-b"]);
  assert.deepEqual(result.canvas.edges, []);
  assert.deepEqual(result.preservation.removedNodeIds, ["node-a"]);
  assert.deepEqual(result.preservation.removedEdgeIds, ["edge-ab"]);
});

test("Canvas patches structurally validate the final graph", () => {
  const canvas = createCanvas();
  assert.throws(
    () =>
      applyCanvasPatch(canvas, [
        { op: "update_node", id: "node-a", changes: { width: 0 } },
      ]),
    /invalid Canvas.*width must be a positive integer/i,
  );
  assert.equal(canvas.nodes[0].width, 200);
});

test("auto-layout is deterministic, ordered, selective, and preserves unknown fields", () => {
  const canvas = createCanvas();
  const operation = {
    op: "auto_layout" as const,
    nodeIds: ["node-b", "node-a"],
    direction: "row" as const,
    originX: 10,
    originY: 20,
    gapX: 30,
  };

  const first = applyCanvasPatch(canvas, [operation]);
  const second = applyCanvasPatch(canvas, [operation]);
  assert.deepEqual(first.canvas, second.canvas);
  assert.deepEqual(
    first.canvas.nodes.map(({ id, x, y }) => ({ id, x, y })),
    [
      { id: "node-a", x: 10, y: 20 },
      { id: "node-b", x: 240, y: 20 },
    ],
  );
  assert.deepEqual(first.canvas.nodes[0].pluginData, {
    owner: "user",
    nested: { keep: true },
  });
  assert.deepEqual(first.preservation.autoLaidOutNodeIds, ["node-a", "node-b"]);
  assert.deepEqual(first.preservation.untouchedNodeIds, []);
  assert.deepEqual(
    deterministicCanvasAutoLayout(canvas, operation),
    deterministicCanvasAutoLayout(canvas, operation),
  );
});

test("auto-layout accepts a bounded hook and validates its complete result", () => {
  const canvas = createCanvas();
  const result = applyCanvasPatch(
    canvas,
    [{ op: "auto_layout", nodeIds: ["node-b"] }],
    {
      autoLayout: (_current, operation) => {
        assert.deepEqual(operation.nodeIds, ["node-b"]);
        return [{ id: "node-b", x: 901, y: 902 }];
      },
    },
  );
  assert.deepEqual(
    result.canvas.nodes.map(({ id, x, y }) => ({ id, x, y })),
    [
      { id: "node-a", x: 100, y: 200 },
      { id: "node-b", x: 901, y: 902 },
    ],
  );
  assert.deepEqual(result.preservation.untouchedNodeIds, ["node-a"]);

  assert.throws(
    () =>
      applyCanvasPatch(
        canvas,
        [{ op: "auto_layout", nodeIds: ["node-b"] }],
        { autoLayout: () => [] },
      ),
    /did not return positions for: node-b/i,
  );
});

test("runtime parser accepts and clones all bounded Canvas patch operations", () => {
  const addNodeSource = {
    op: "add_node",
    node: {
      id: "node-c",
      type: "text",
      x: 1,
      y: 2,
      width: 100,
      height: 60,
      text: "C",
      unknown: { tags: ["one", "two"], enabled: true, score: 1.5 },
    },
  };
  const source = [
    addNodeSource,
    { op: "update_node", id: "node-a", changes: { text: "Updated" } },
    { op: "remove_node", id: "node-b" },
    {
      op: "add_edge",
      edge: {
        id: "edge-ac",
        fromNode: "node-a",
        toNode: "node-c",
        toEnd: "arrow",
        metadata: [1, null, false],
      },
    },
    { op: "update_edge", id: "edge-ab", changes: { label: "updated" } },
    { op: "remove_edge", id: "edge-ab" },
    {
      op: "auto_layout",
      nodeIds: ["node-a", "node-c"],
      direction: "grid",
      columns: 2,
      originX: -10,
      originY: 20,
      gapX: 0,
      gapY: 40,
    },
  ];

  const parsed = parseCanvasPatchOperations(source);
  assert.equal(parsed.length, 7);
  assert.deepEqual(parsed.map((operation) => operation.op), [
    "add_node",
    "update_node",
    "remove_node",
    "add_edge",
    "update_edge",
    "remove_edge",
    "auto_layout",
  ]);
  assert.notEqual((parsed[0] as { node: unknown }).node, addNodeSource.node);
  addNodeSource.node.unknown.tags[0] = "mutated";
  const parsedAddNode = parsed[0];
  assert.equal(parsedAddNode.op, "add_node");
  if (parsedAddNode.op !== "add_node") {
    throw new Error("Expected an add_node operation.");
  }
  assert.deepEqual(parsedAddNode.node.unknown, {
    tags: ["one", "two"],
    enabled: true,
    score: 1.5,
  });
});

test("runtime parser enforces operation count, keys, and field types", () => {
  assert.throws(() => parseCanvasPatchOperations({}), /must be an array/i);
  assert.throws(() => parseCanvasPatchOperations([]), /between 1 and 100/i);
  assert.throws(
    () =>
      parseCanvasPatchOperations(
        Array.from({ length: 101 }, () => ({ op: "remove_node", id: "node" })),
      ),
    /between 1 and 100/i,
  );
  assert.throws(
    () => parseCanvasPatchOperations([{ op: "teleport_node", id: "node-a" }]),
    /unsupported: teleport_node/i,
  );
  assert.throws(
    () =>
      parseCanvasPatchOperations([
        { op: "remove_node", id: "node-a", destination: "Elsewhere.canvas" },
      ]),
    /unsupported keys: destination/i,
  );
  assert.throws(
    () => parseCanvasPatchOperations([{ op: "remove_node" }]),
    /missing required keys: id/i,
  );
  assert.throws(
    () =>
      parseCanvasPatchOperations([
        { op: "auto_layout", nodeIds: "node-a" },
      ]),
    /nodeIds must be an array/i,
  );
  assert.throws(
    () =>
      parseCanvasPatchOperations([
        { op: "auto_layout", originX: "10" },
      ]),
    /originX must be an integer/i,
  );
  assert.throws(
    () =>
      parseCanvasPatchOperations([
        { op: "auto_layout", columns: 0 },
      ]),
    /columns must be at least 1/i,
  );
  assert.throws(
    () =>
      parseCanvasPatchOperations([
        { op: "update_node", id: "node-a", changes: { x: "10" } },
      ]),
    /changes.x must be an integer/i,
  );
  assert.throws(
    () =>
      parseCanvasPatchOperations([
        { op: "update_node", id: "node-a", changes: { id: "node-b" } },
      ]),
    /changes cannot include id/i,
  );
  assert.throws(
    () =>
      parseCanvasPatchOperations([
        {
          op: "add_node",
          node: {
            id: "node-c",
            type: "text",
            x: 0,
            y: 0,
            width: "100",
            height: 60,
            text: "C",
          },
        },
      ]),
    /node is invalid.*width must be a positive integer/i,
  );
  assert.throws(
    () =>
      parseCanvasPatchOperations([
        {
          op: "add_edge",
          edge: { id: "edge", fromNode: 1, toNode: "node-b" },
        },
      ]),
    /edge.fromNode must be a string/i,
  );
});

test("runtime parser rejects non-JSON and non-plain nested values", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const sparse = new Array(2);
  sparse[1] = "value";

  for (const invalid of [
    undefined,
    () => true,
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date(),
    new Map(),
    circular,
    sparse,
  ]) {
    assert.throws(
      () =>
        parseCanvasPatchOperations([
          {
            op: "update_node",
            id: "node-a",
            changes: { custom: invalid },
          },
        ]),
      /JSON-safe|non-finite|plain object|circular|sparse/i,
    );
  }
});

test("edge updates shallow-merge and preserve unknown edge fields", () => {
  const canvas = createCanvas();
  const result = applyCanvasPatch(canvas, [
    {
      op: "update_edge",
      id: "edge-ab",
      changes: { label: "revised", color: "4" },
    },
  ]);
  assert.deepEqual(result.canvas.edges[0].customEdgeField, { keep: true });
  assert.equal(result.canvas.edges[0].label, "revised");
  assert.deepEqual(result.preservation.updatedEdgeIds, ["edge-ab"]);
  assert.deepEqual(result.preservation.untouchedEdgeIds, []);
});

function createCanvas(): JsonCanvas {
  return {
    nodes: [
      {
        id: "node-a",
        type: "text",
        x: 100,
        y: 200,
        width: 200,
        height: 100,
        text: "# A",
        pluginData: { owner: "user", nested: { keep: true } },
      },
      {
        id: "node-b",
        type: "text",
        x: 400,
        y: 200,
        width: 150,
        height: 80,
        text: "# B",
        customFlag: true,
      },
    ],
    edges: [
      {
        id: "edge-ab",
        fromNode: "node-a",
        toNode: "node-b",
        toEnd: "arrow",
        customEdgeField: { keep: true },
      },
    ],
    viewport: { x: 25, y: 50, zoom: 1.2 },
  } as JsonCanvas;
}
