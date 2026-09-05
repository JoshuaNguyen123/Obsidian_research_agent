import assert from "node:assert/strict";
import test from "node:test";

import { CanvasWriter } from "../src/agent/design/CanvasWriter";
import {
  buildLayoutCanvas,
  inferCanvasLane,
} from "../src/design/layout";
import type { JsonCanvas } from "../src/design/jsonCanvas";

function groupLabels(canvas: JsonCanvas): string[] {
  return canvas.nodes
    .filter((node) => node.type === "group")
    .map((node) => node.label ?? "");
}

test("distributed system layout infers ordered tiers and preserves explicit trust zones", () => {
  const canvas = buildLayoutCanvas({
    title: "Global order platform",
    diagramType: "distributed_system",
    connect: "none",
    items: [
      { id: "db", kind: "database", title: "Orders" },
      { id: "web", kind: "client", title: "Web clients" },
      { id: "worker", kind: "worker", title: "Fulfillment workers" },
      { id: "bus", kind: "broker", title: "Event bus" },
      { id: "slo", kind: "metric", title: "SLO telemetry" },
      { id: "erp", kind: "external_system", title: "Partner ERP" },
      {
        id: "payment",
        kind: "service",
        title: "Payment service",
        lane: "PCI Trust Zone",
      },
    ],
  });

  assert.deepEqual(groupLabels(canvas), [
    "Clients & Edge",
    "Compute & Services",
    "Messaging",
    "Data & State",
    "Operations & Governance",
    "External Systems",
    "PCI Trust Zone",
  ]);
});

test("large architecture lanes override extreme row and column strips", () => {
  for (const direction of ["row", "column"] as const) {
    const canvas = buildLayoutCanvas({
      title: "Transformer architecture",
      diagramType: "architecture",
      direction,
      connect: "sequence",
      items: Array.from({ length: 51 }, (_, index) => ({
        id: `component-${index + 1}`,
        kind: "service" as const,
        title: `Component ${index + 1}`,
      })),
    });

    const group = canvas.nodes.find((node) => node.type === "group");
    const itemNodes = canvas.nodes.filter(
      (node) => node.type !== "group" && node.id !== "canvas-title",
    );
    assert.ok(group && group.type === "group");
    assert.ok(group.width <= 2_720, `${direction} width was ${group.width}`);
    assert.ok(group.height <= 2_420, `${direction} height was ${group.height}`);
    assert.ok(new Set(itemNodes.map((node) => node.x)).size > 1);
    assert.ok(new Set(itemNodes.map((node) => node.y)).size > 1);
  }
});

test("architecture maps stay connected even when model requests no auto-edges", () => {
  const canvas = buildLayoutCanvas({
    title: "Transformer architecture",
    diagramType: "architecture",
    connect: "none",
    items: Array.from({ length: 8 }, (_, index) => ({
      id: `component-${index + 1}`,
      kind: "process" as const,
      title: `Component ${index + 1}`,
    })),
  });

  assert.equal(canvas.edges.length, 7);
  assert.deepEqual(
    canvas.edges.map((edge) => [edge.fromNode, edge.toNode]),
    Array.from({ length: 7 }, (_, index) => [
      `component-${index + 1}`,
      `component-${index + 2}`,
    ]),
  );

  const nonArchitecture = buildLayoutCanvas({
    diagramType: "sequence",
    connect: "none",
    items: [
      { id: "one", title: "One" },
      { id: "two", title: "Two" },
    ],
  });
  assert.equal(nonArchitecture.edges.length, 0);
});

test("multiple small column lanes form a compact canvas without changing their contents or edges", () => {
  const lanes = ["Input", "Encoder", "Decoder", "Output", "System"];
  const counts = [3, 4, 6, 2, 1];
  const items = lanes.flatMap((lane, index) =>
    Array.from({ length: counts[index] }, (_, itemIndex) => ({
      id: `${lane}-${itemIndex}`,
      lane,
      title: `${lane} component ${itemIndex}`,
      text: `Preserve ${lane} details ${itemIndex}`,
    })),
  );
  const connections = items.slice(1).map((item, index) => ({
    from: items[index].id, to: item.id, label: `Connection ${index}`,
  }));
  const canvas = buildLayoutCanvas({
    title: "Transformer architecture",
    diagramType: "architecture",
    direction: "column",
    items,
    connections,
  });
  const width = Math.max(...canvas.nodes.map((node) => node.x + node.width));
  const height = Math.max(...canvas.nodes.map((node) => node.y + node.height));
  assert.ok(Math.max(width, height) <= 6_000, `${width} x ${height}`);
  assert.ok(Math.max(width, height) / Math.min(width, height) <= 4, `${width} x ${height}`);
  assert.deepEqual(groupLabels(canvas), lanes);
  assert.deepEqual(canvas.edges.map((edge) => ({
    from: edge.fromNode, to: edge.toNode, label: edge.label,
  })), connections);
  const groups = canvas.nodes.filter((node) => node.type === "group");
  for (const [index, group] of groups.entries()) {
    for (const other of groups.slice(index + 1)) {
      assert.ok(group.x + group.width <= other.x || other.x + other.width <= group.x ||
        group.y + group.height <= other.y || other.y + other.height <= group.y,
      `${group.label} overlaps ${other.label}`);
    }
    const members = items.filter((item) => item.lane === group.label)
      .map((item) => canvas.nodes.find((node) => node.id === item.id)!);
    assert.equal(new Set(members.map((node) => node.x)).size, 1, "column direction retained");
    for (const node of members) {
      assert.ok(node.x > group.x && node.x + node.width < group.x + group.width);
      assert.ok(node.y > group.y && node.y + node.height < group.y + group.height);
      assert.ok(node.type === "text" && node.text.includes(items.find((item) => item.id === node.id)!.text));
    }
  }
});

test("already compact lane layouts retain their original positions", () => {
  const canvas = buildLayoutCanvas({
    title: "Two stages",
    diagramType: "architecture",
    direction: "column",
    items: [
      { id: "input", title: "Input", lane: "Input" },
      { id: "output", title: "Output", lane: "Output" },
    ],
  });
  assert.deepEqual(canvas.nodes.filter((node) => node.type === "group")
    .map((node) => [node.x, node.y]), [[0, 220], [0, 600]]);
});

test("business and manufacturing layouts infer process-specific swimlanes", () => {
  assert.equal(inferCanvasLane("business_process", "actor"), "Participants");
  assert.equal(inferCanvasLane("business_process", "process"), "Process Flow");
  assert.equal(inferCanvasLane("business_process", "document"), "Systems & Records");
  assert.equal(inferCanvasLane("business_process", "control"), "Controls & Outcomes");

  const canvas = buildLayoutCanvas({
    title: "Production order value stream",
    diagramType: "manufacturing_process",
    connect: "none",
    items: [
      { id: "finished", kind: "output", title: "Finished goods" },
      { id: "supplier", kind: "supplier", title: "Steel supplier" },
      { id: "buffer", kind: "inventory", title: "Raw material buffer" },
      { id: "cell", kind: "workcell", title: "Assembly cell" },
      { id: "quality", kind: "inspection", title: "Quality gate" },
      { id: "mes", kind: "external_system", title: "MES" },
    ],
  });

  assert.deepEqual(groupLabels(canvas), [
    "Inputs & Suppliers",
    "Material Flow",
    "Production",
    "Quality & Control",
    "Systems & Automation",
    "Outputs & Distribution",
  ]);
});

test("design package writer carries explicit model-authored lanes into Canvas", async () => {
  const mock = createMockVault();
  const writer = new CanvasWriter(mock.vault as never);
  const result = await writer.createPackage({
    title: "Order exception process",
    kind: "business_process",
    items: [
      {
        id: "planner",
        kind: "actor",
        title: "Production planner",
        summary: "Owns the exception.",
        lane: "Planning Team",
      },
      {
        id: "triage",
        kind: "process",
        title: "Triage exception",
        summary: "Classify impact and priority.",
      },
      {
        id: "record",
        kind: "document",
        title: "Deviation record",
        summary: "Retain the disposition.",
      },
      {
        id: "approval",
        kind: "control",
        title: "Quality approval",
        summary: "Release or reject the order.",
      },
    ],
    edges: [
      { id: "triage-record", from: "triage", to: "record", label: "records" },
      { id: "record-approval", from: "record", to: "approval", label: "requests approval" },
    ],
  });

  const canvas = JSON.parse(mock.files.get(result.canvasPath) ?? "") as JsonCanvas;
  assert.deepEqual(groupLabels(canvas), [
    "Process Flow",
    "Systems & Records",
    "Controls & Outcomes",
    "Planning Team",
  ]);
});

test("distributed package creates editable Canvas, passive SVG, readiness review, and receipts", async () => {
  const mock = createMockVault();
  const writer = new CanvasWriter(mock.vault as never);
  const result = await writer.createPackage({
    title: "Global Orders Architecture",
    kind: "distributed_system",
    items: [
      {
        id: "gateway",
        kind: "gateway",
        title: "API Gateway",
        summary: "TLS entry and identity boundary with rate limiting.",
        details: ["Load balances across regions and enforces least privilege."],
      },
      {
        id: "orders",
        kind: "service",
        title: "Order Service",
        summary: "Stateless compute with autoscaling replicas and SLO health checks.",
        details: ["Idempotent retries and circuit breakers protect downstream calls."],
      },
      {
        id: "events",
        kind: "broker",
        title: "Event Bus",
        summary: "Partitioned asynchronous delivery with dead-letter recovery.",
      },
      {
        id: "database",
        kind: "database",
        title: "Orders Database",
        summary: "Sharded state with encrypted failover replicas.",
      },
      {
        id: "telemetry",
        kind: "metric",
        title: "Observability",
        summary: "Metrics, traces, logs, alerts, and service-level objectives.",
      },
    ],
    edges: [
      { id: "gateway-orders", from: "gateway", to: "orders", label: "authenticated request" },
      { id: "orders-events", from: "orders", to: "events", label: "publishes idempotent event" },
      { id: "orders-db", from: "orders", to: "database", label: "transaction" },
      { id: "telemetry-orders", from: "telemetry", to: "orders", label: "observes SLO" },
    ],
  });

  assert.equal(result.svgPath, "Design Packages/global-orders-architecture.svg");
  assert.deepEqual(result.assessment.warnings, []);
  assert.ok(result.assessment.coveredConcerns.includes("capacity and scaling"));
  const svg = mock.files.get(result.svgPath ?? "") ?? "";
  assert.match(svg, /^<svg/u);
  assert.match(svg, /API Gateway/u);
  assert.doesNotMatch(svg, /<script\b|\bhref=/iu);
  const brief = mock.files.get(result.briefPath) ?? "";
  assert.match(brief, /SVG image: !\[\[Design Packages\/global-orders-architecture\.svg\]\]/u);
  assert.match(brief, /Scale, Reliability, Security, and Operations Review/u);
  assert.match(brief, /Outstanding proof debt[\s\S]*None detected/u);
});

function createMockVault() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const fileFor = (path: string) => files.has(path)
    ? { path, extension: path.split(".").pop() ?? "" }
    : null;
  const vault = {
    getAbstractFileByPath(path: string) {
      return fileFor(path) ?? (folders.has(path) ? { path } : null);
    },
    getFileByPath: fileFor,
    getFolderByPath: (path: string) => folders.has(path) ? { path } : null,
    createFolder: async (path: string) => {
      folders.add(path);
    },
    create: async (path: string, content: string) => {
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      files.set(path, content);
      return { path, extension: path.split(".").pop() ?? "" };
    },
    read: async (file: { path: string }) => files.get(file.path) ?? "",
    trash: async (file: { path: string }) => {
      files.delete(file.path);
    },
    delete: async (file: { path: string }) => {
      files.delete(file.path);
    },
  };
  return { files, vault };
}
