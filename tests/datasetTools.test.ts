import assert from "node:assert/strict";
import test from "node:test";

import { createDatasetTools } from "../src/tools/datasetTools";
import {
  buildDatasetChartShapesV1,
  suggestDatasetChartV1,
  type DatasetChartColumnV1,
} from "../src/design/datasetChart";
import { renderSvgWireframe } from "../src/design/svgDesign";
import type { ToolExecutionContext } from "../src/tools/types";

const analyzeDataset = createDatasetTools().find(
  (tool) => tool.name === "analyze_dataset",
)!;

function contextWith(files: Record<string, string>): ToolExecutionContext {
  const getFile = (path: string) => {
    if (!(path in files)) return null;
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.[^.]+$/iu, ""),
      extension: name.includes(".") ? name.split(".").pop()!.toLowerCase() : "",
      stat: { ctime: 0, mtime: 0, size: files[path]!.length },
    };
  };
  return {
    app: {
      vault: {
        getFileByPath: getFile,
        cachedRead: async (file: { path: string }) => files[file.path] ?? "",
      },
    },
    settings: { requestTimeoutMs: 30_000 },
    originalPrompt: "Analyze the dataset.",
    reportProgress: () => {},
    httpTransport: async () => ({ status: 500, headers: {} }),
    now: () => new Date(0),
  } as unknown as ToolExecutionContext;
}

test("analyze_dataset summarizes a quoted CSV with embedded commas and mixed types", async () => {
  const csv = [
    'name,score,joined,"favorite, food"',
    '"Smith, Jane",91.5,2024-01-05,"pizza, deep dish"',
    '"Doe, John",78,2024-02-10,sushi',
    '"Roe, Rich",,2024-03-15,"pizza, deep dish"',
  ].join("\n");
  const context = contextWith({ "Data/people.csv": csv });
  const result = (await analyzeDataset.execute(
    { path: "Data/people.csv" },
    context,
  )) as Record<string, any>;

  assert.equal(result.status, "analyzed");
  assert.equal(result.rowCount, 3);
  assert.equal(result.truncated, false);
  assert.match(result.contentHash, /^sha256:[a-f0-9]{64}$/u);
  const byName = new Map(result.columns.map((column: any) => [column.name, column]));
  const name = byName.get("name") as any;
  assert.equal(name.type, "string");
  assert.equal(name.uniqueCount, 3);
  const score = byName.get("score") as any;
  assert.equal(score.type, "number");
  assert.equal(score.nullCount, 1);
  assert.equal(score.min, 78);
  assert.equal(score.max, 91.5);
  assert.equal(score.mean, 84.75);
  const joined = byName.get("joined") as any;
  assert.equal(joined.type, "date");
  const food = byName.get("favorite, food") as any;
  assert.equal(food.topValues[0].value, "pizza, deep dish");
  assert.equal(food.topValues[0].count, 2);
});

test("analyze_dataset handles NDJSON, truncation reporting, and column selection", async () => {
  const rows = Array.from({ length: 40 }, (_, index) =>
    JSON.stringify({ id: index, value: index * 2, label: `row-${index % 3}` }),
  ).join("\n");
  const context = contextWith({ "Data/events.ndjson": rows });
  const result = (await analyzeDataset.execute(
    { path: "Data/events.ndjson", maxRows: 10, columns: "value,missing" },
    context,
  )) as Record<string, any>;
  assert.equal(result.rowCount, 40);
  assert.equal(result.analyzedRowCount, 10);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.columns.map((column: any) => column.name),
    ["value"],
  );
});

test("analyze_dataset rejects unsupported, binary, and malformed inputs", async () => {
  const context = contextWith({
    "Data/file.parquet": "PAR1binary",
    "Data/binary.csv": "a,b\n\0\0",
    "Data/object.json": '{"not":"array"}',
    "Data/headerless.csv": "",
  });
  await assert.rejects(
    () => analyzeDataset.execute({ path: "Data/missing.csv" }, context),
    /not found/u,
  );
  await assert.rejects(
    () => analyzeDataset.execute({ path: "Data/file.parquet" }, context),
    /Unsupported dataset extension/u,
  );
  await assert.rejects(
    () => analyzeDataset.execute({ path: "Data/binary.csv" }, context),
    /binary/u,
  );
  await assert.rejects(
    () => analyzeDataset.execute({ path: "Data/object.json" }, context),
    /top-level array/u,
  );
  await assert.rejects(
    () => analyzeDataset.execute({ path: "Data/headerless.csv" }, context),
    /no header row/u,
  );
});

test("chart suggestion picks bar for category+measure and its shapes render as valid SVG input", async () => {
  const csv = [
    "team,points",
    "alpha,10",
    "alpha,14",
    "beta,8",
    "beta,4",
    "gamma,20",
  ].join("\n");
  const context = contextWith({ "Data/scores.csv": csv });
  const result = (await analyzeDataset.execute(
    { path: "Data/scores.csv" },
    context,
  )) as Record<string, any>;
  assert.equal(result.suggestedChart.kind, "bar");
  assert.equal(result.suggestedChart.x, "team");
  assert.equal(result.suggestedChart.y, "points");
  assert.ok(result.chartShapes);
  // The shapes feed the existing verified SVG writer directly.
  const svg = renderSvgWireframe(result.chartShapes);
  assert.match(svg, /^<svg /u);
  assert.ok(svg.includes("<rect"), "bar chart must contain rects");

  // Determinism: identical input produces identical shapes.
  const again = (await analyzeDataset.execute(
    { path: "Data/scores.csv" },
    context,
  )) as Record<string, any>;
  assert.deepEqual(again.chartShapes, result.chartShapes);
});

test("chart suggestion falls back to histogram and to nothing chartable", () => {
  const numericOnly: DatasetChartColumnV1[] = [
    { name: "value", type: "number", values: [1, 2, 3, 4, 5] },
  ];
  assert.equal(suggestDatasetChartV1(numericOnly).kind, "histogram");

  const nothing: DatasetChartColumnV1[] = [
    { name: "label", type: "string", values: ["a", "b"] },
  ];
  const suggestion = suggestDatasetChartV1(nothing);
  assert.equal(suggestion.y, null);
  assert.equal(
    buildDatasetChartShapesV1({ title: "t", suggestion, columns: nothing }),
    null,
  );
});
