import type { SvgWireframeInput, SvgWireframeShape } from "./svgDesign";

/**
 * Deterministic chart-shape synthesis for analyze_dataset. Produces the exact
 * structured-shape input consumed by the existing create_svg_design tool, so
 * chart output reuses the verified SVG writer instead of introducing a new
 * mutation surface. Pure: no DOM, no randomness, no clock.
 */

export type DatasetChartKind = "bar" | "histogram" | "line" | "scatter";

export interface DatasetChartColumnV1 {
  name: string;
  type: "number" | "string" | "boolean" | "date" | "empty";
  values: ReadonlyArray<number | string | null>;
}

export interface DatasetChartSuggestionV1 {
  kind: DatasetChartKind;
  x: string | null;
  y: string | null;
  reason: string;
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 420;
const MARGIN = { top: 48, right: 24, bottom: 56, left: 64 };
const MAX_BAR_CATEGORIES = 12;
const MAX_POINTS = 300;
const HISTOGRAM_BINS = 12;

/**
 * Pick the chart the columns support: two numerics → scatter; one numeric +
 * low-cardinality string → bar of means; one numeric → histogram; numeric with
 * a date column → line. Null y means no chartable numeric column exists.
 */
export function suggestDatasetChartV1(
  columns: ReadonlyArray<DatasetChartColumnV1>,
): DatasetChartSuggestionV1 {
  const numeric = columns.filter((column) => column.type === "number");
  const date = columns.find((column) => column.type === "date");
  const categorical = columns.find(
    (column) =>
      column.type === "string" &&
      distinctCount(column.values) <= MAX_BAR_CATEGORIES &&
      distinctCount(column.values) >= 2,
  );
  if (numeric.length === 0) {
    return {
      kind: "bar",
      x: null,
      y: null,
      reason: "No numeric column; nothing chartable.",
    };
  }
  if (date && numeric[0]) {
    return {
      kind: "line",
      x: date.name,
      y: numeric[0].name,
      reason: "Date column with a numeric series.",
    };
  }
  if (categorical && numeric[0]) {
    return {
      kind: "bar",
      x: categorical.name,
      y: numeric[0].name,
      reason: "Low-cardinality category with a numeric measure.",
    };
  }
  if (numeric.length >= 2) {
    return {
      kind: "scatter",
      x: numeric[0]!.name,
      y: numeric[1]!.name,
      reason: "Two numeric columns.",
    };
  }
  return {
    kind: "histogram",
    x: numeric[0]!.name,
    y: null,
    reason: "Single numeric column distribution.",
  };
}

/** Build ready-to-render shapes for create_svg_design from the suggestion. */
export function buildDatasetChartShapesV1(input: {
  title: string;
  suggestion: DatasetChartSuggestionV1;
  columns: ReadonlyArray<DatasetChartColumnV1>;
}): SvgWireframeInput | null {
  const { suggestion } = input;
  const byName = new Map(input.columns.map((column) => [column.name, column]));
  const frame = frameShapes(input.title);
  if (suggestion.kind === "histogram" && suggestion.x) {
    const values = numericValues(byName.get(suggestion.x));
    if (values.length === 0) return null;
    return {
      title: input.title,
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      shapes: [...frame, ...histogramShapes(values, suggestion.x)],
    };
  }
  if (suggestion.kind === "bar" && suggestion.x && suggestion.y) {
    const bars = categoryMeans(byName.get(suggestion.x), byName.get(suggestion.y));
    if (bars.length === 0) return null;
    return {
      title: input.title,
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      shapes: [...frame, ...barShapes(bars, suggestion.x, suggestion.y)],
    };
  }
  if (
    (suggestion.kind === "scatter" || suggestion.kind === "line") &&
    suggestion.x &&
    suggestion.y
  ) {
    const points = pairedPoints(byName.get(suggestion.x), byName.get(suggestion.y));
    if (points.length === 0) return null;
    return {
      title: input.title,
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      shapes: [
        ...frame,
        ...pointShapes(points, suggestion.kind === "line"),
      ],
    };
  }
  return null;
}

function frameShapes(title: string): SvgWireframeShape[] {
  const plotWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  return [
    { type: "text", x: MARGIN.left, y: 28, text: title, fontSize: 16 },
    {
      type: "line",
      x1: MARGIN.left,
      y1: MARGIN.top + plotHeight,
      x2: MARGIN.left + plotWidth,
      y2: MARGIN.top + plotHeight,
    },
    {
      type: "line",
      x1: MARGIN.left,
      y1: MARGIN.top,
      x2: MARGIN.left,
      y2: MARGIN.top + plotHeight,
    },
  ];
}

function histogramShapes(values: number[], name: string): SvgWireframeShape[] {
  const plotWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
  for (const value of values) {
    const bin = Math.min(
      HISTOGRAM_BINS - 1,
      Math.floor(((value - min) / span) * HISTOGRAM_BINS),
    );
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  const peak = Math.max(...counts, 1);
  const barWidth = plotWidth / HISTOGRAM_BINS;
  const shapes: SvgWireframeShape[] = counts.map((count, index) => ({
    type: "rect",
    x: round(MARGIN.left + index * barWidth + 2),
    y: round(MARGIN.top + plotHeight * (1 - count / peak)),
    width: round(Math.max(1, barWidth - 4)),
    height: round(Math.max(1, (plotHeight * count) / peak)),
  }));
  shapes.push(axisLabel(`${name} (${values.length} values, ${HISTOGRAM_BINS} bins)`));
  return shapes;
}

function barShapes(
  bars: Array<{ label: string; value: number }>,
  x: string,
  y: string,
): SvgWireframeShape[] {
  const plotWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const peak = Math.max(...bars.map((bar) => Math.abs(bar.value)), 1);
  const barWidth = plotWidth / bars.length;
  const shapes: SvgWireframeShape[] = [];
  bars.forEach((bar, index) => {
    const height = Math.max(1, (plotHeight * Math.abs(bar.value)) / peak);
    shapes.push({
      type: "rect",
      x: round(MARGIN.left + index * barWidth + 4),
      y: round(MARGIN.top + plotHeight - height),
      width: round(Math.max(1, barWidth - 8)),
      height: round(height),
    });
    shapes.push({
      type: "text",
      x: round(MARGIN.left + index * barWidth + barWidth / 2),
      y: CHART_HEIGHT - MARGIN.bottom + 18,
      text: truncateLabel(bar.label),
      fontSize: 11,
      anchor: "middle",
    });
  });
  shapes.push(axisLabel(`mean ${y} by ${x}`));
  return shapes;
}

function pointShapes(
  points: Array<{ x: number; y: number }>,
  connect: boolean,
): SvgWireframeShape[] {
  const plotWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xMin = Math.min(...xs);
  const xSpan = Math.max(...xs) - xMin || 1;
  const yMin = Math.min(...ys);
  const ySpan = Math.max(...ys) - yMin || 1;
  const project = (point: { x: number; y: number }) => ({
    x: round(MARGIN.left + ((point.x - xMin) / xSpan) * plotWidth),
    y: round(MARGIN.top + plotHeight * (1 - (point.y - yMin) / ySpan)),
  });
  const projected = points.map(project);
  const shapes: SvgWireframeShape[] = [];
  if (connect) {
    for (let index = 1; index < projected.length; index += 1) {
      const from = projected[index - 1]!;
      const to = projected[index]!;
      shapes.push({ type: "line", x1: from.x, y1: from.y, x2: to.x, y2: to.y });
    }
  } else {
    for (const point of projected) {
      shapes.push({ type: "circle", cx: point.x, cy: point.y, r: 3 });
    }
  }
  shapes.push(axisLabel(`${points.length} points`));
  return shapes;
}

function axisLabel(text: string): SvgWireframeShape {
  return {
    type: "text",
    x: CHART_WIDTH - MARGIN.right,
    y: CHART_HEIGHT - 12,
    text,
    fontSize: 11,
    anchor: "end",
  };
}

function numericValues(column: DatasetChartColumnV1 | undefined): number[] {
  if (!column) return [];
  return column.values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .slice(0, MAX_POINTS * 10);
}

function categoryMeans(
  category: DatasetChartColumnV1 | undefined,
  measure: DatasetChartColumnV1 | undefined,
): Array<{ label: string; value: number }> {
  if (!category || !measure) return [];
  const sums = new Map<string, { total: number; count: number }>();
  const length = Math.min(category.values.length, measure.values.length);
  for (let index = 0; index < length; index += 1) {
    const label = category.values[index];
    const value = measure.values[index];
    if (typeof label !== "string" || typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    const entry = sums.get(label) ?? { total: 0, count: 0 };
    entry.total += value;
    entry.count += 1;
    sums.set(label, entry);
  }
  return [...sums.entries()]
    .slice(0, MAX_BAR_CATEGORIES)
    .map(([label, entry]) => ({ label, value: entry.total / entry.count }));
}

function pairedPoints(
  xColumn: DatasetChartColumnV1 | undefined,
  yColumn: DatasetChartColumnV1 | undefined,
): Array<{ x: number; y: number }> {
  if (!xColumn || !yColumn) return [];
  const points: Array<{ x: number; y: number }> = [];
  const length = Math.min(xColumn.values.length, yColumn.values.length);
  for (let index = 0; index < length && points.length < MAX_POINTS; index += 1) {
    const x = coerceNumeric(xColumn.values[index]);
    const y = coerceNumeric(yColumn.values[index]);
    if (x !== null && y !== null) points.push({ x, y });
  }
  return points;
}

function coerceNumeric(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function distinctCount(values: ReadonlyArray<number | string | null>): number {
  return new Set(values.filter((value) => value !== null)).size;
}

function truncateLabel(label: string): string {
  return label.length > 12 ? `${label.slice(0, 11)}…` : label;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
