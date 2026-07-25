import { createHash } from "node:crypto";

import {
  buildDatasetChartShapesV1,
  suggestDatasetChartV1,
  type DatasetChartColumnV1,
} from "../design/datasetChart";
import type { AgentTool } from "./types";
import {
  getOptionalInteger,
  getOptionalString,
  getRequiredString,
  normalizeVaultPath,
} from "./validation";

/**
 * Deterministic in-process dataset analysis over vault files. Read-only by
 * design: the tool returns statistics plus ready-made chart shapes, and the
 * model writes results through the existing create_svg_design / create_file
 * mutation tools, keeping every write-policy table untouched. The sandbox is
 * deliberately NOT involved — its prepared-action contract (repository
 * profile, staging manifest, boundary probe, exact approval) has no seam for
 * "summarize a CSV", and statistics this small are pure computation.
 */

const MAX_DATASET_BYTES = 5 * 1024 * 1024;
const MAX_DATASET_ROWS = 50_000;
const DEFAULT_MAX_ROWS = 10_000;
const MAX_COLUMNS = 128;
const MAX_TOP_VALUES = 8;
const SUPPORTED_EXTENSIONS = new Set(["csv", "tsv", "json", "ndjson"]);

export interface DatasetColumnSummaryV1 {
  name: string;
  type: "number" | "string" | "boolean" | "date" | "empty";
  nullCount: number;
  uniqueCount: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  stddev: number | null;
  topValues: Array<{ value: string; count: number }>;
}

export function createDatasetTools(): AgentTool[] {
  return [analyzeDatasetTool];
}

const analyzeDatasetTool: AgentTool = {
  name: "analyze_dataset",
  description:
    "Analyze a tabular dataset file (.csv, .tsv, .json array, .ndjson) from the vault: per-column types and statistics, plus ready-to-render chart shapes for create_svg_design. Read-only; use create_file/append_file to write findings into a note.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative dataset path, for example Data/results.csv.",
      },
      maxRows: {
        type: "integer",
        description: `Rows to analyze (default ${DEFAULT_MAX_ROWS}, max ${MAX_DATASET_ROWS}). Truncation is reported explicitly.`,
      },
      columns: {
        type: "string",
        description:
          "Optional comma-separated column names to restrict the analysis to.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const path = normalizeVaultPath(getRequiredString(args, "path"));
    const maxRows = Math.min(
      MAX_DATASET_ROWS,
      Math.max(1, getOptionalInteger(args, "maxRows") ?? DEFAULT_MAX_ROWS),
    );
    const requestedColumns = (getOptionalString(args, "columns") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    const file = context.app.vault.getFileByPath(path);
    if (!file) throw new Error(`Dataset file not found: ${path}`);
    if (!SUPPORTED_EXTENSIONS.has(file.extension.toLowerCase())) {
      throw new Error(
        `Unsupported dataset extension .${file.extension}; expected one of ${[...SUPPORTED_EXTENSIONS].map((extension) => `.${extension}`).join(", ")}.`,
      );
    }
    if (file.stat.size > MAX_DATASET_BYTES) {
      throw new Error(
        `Dataset is ${file.stat.size} bytes; the bound is ${MAX_DATASET_BYTES} bytes (5 MB).`,
      );
    }

    const raw = await context.app.vault.cachedRead(file);
    assertUtf8Text(raw, path);
    const contentHash = `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;

    const table = parseDataset(raw, file.extension.toLowerCase());
    const totalRows = table.rows.length;
    const truncated = totalRows > maxRows;
    const rows = truncated ? table.rows.slice(0, maxRows) : table.rows;
    const names = (
      requestedColumns.length > 0
        ? table.columns.filter((name) => requestedColumns.includes(name))
        : table.columns
    ).slice(0, MAX_COLUMNS);
    if (names.length === 0) {
      throw new Error(
        requestedColumns.length > 0
          ? `None of the requested columns exist. Available: ${table.columns.slice(0, 24).join(", ")}`
          : "The dataset has no columns.",
      );
    }

    const chartColumns: DatasetChartColumnV1[] = names.map((name) => {
      const values = rows.map((row) => normalizeCell(row[name]));
      return { name, type: inferColumnType(values), values };
    });
    const columns = chartColumns.map((column) => summarizeColumn(column));
    const suggestion = suggestDatasetChartV1(chartColumns);
    const chart = buildDatasetChartShapesV1({
      title: `${file.basename} — ${suggestion.kind}`,
      suggestion,
      columns: chartColumns,
    });

    return {
      status: "analyzed",
      path: file.path,
      contentHash,
      rowCount: totalRows,
      analyzedRowCount: rows.length,
      truncated,
      columns,
      suggestedChart: suggestion,
      // Pass directly to create_svg_design as { path, title, width, height, shapes }.
      chartShapes: chart,
    };
  },
};

function parseDataset(
  raw: string,
  extension: string,
): { columns: string[]; rows: Array<Record<string, unknown>> } {
  if (extension === "json") {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("JSON datasets must be a top-level array of objects.");
    }
    return fromRecords(parsed);
  }
  if (extension === "ndjson") {
    const records = raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          throw new Error(`NDJSON line ${index + 1} is not valid JSON.`);
        }
      });
    return fromRecords(records);
  }
  const delimiter = extension === "tsv" ? "\t" : ",";
  return parseDelimited(raw, delimiter);
}

function fromRecords(records: unknown[]): {
  columns: string[];
  rows: Array<Record<string, unknown>>;
} {
  const rows: Array<Record<string, unknown>> = [];
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const record of records.slice(0, MAX_DATASET_ROWS)) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error("JSON dataset entries must be objects.");
    }
    const row = record as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (!seen.has(key) && seen.size < MAX_COLUMNS) {
        seen.add(key);
        columns.push(key);
      }
    }
    rows.push(row);
  }
  return { columns, rows };
}

/** RFC 4180-style delimited parser: quoted fields, embedded delimiters,
 * doubled quotes, CRLF. No dependencies. */
function parseDelimited(
  raw: string,
  delimiter: string,
): { columns: string[]; rows: Array<Record<string, unknown>> } {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (raw[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      record.push(field);
      field = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && raw[index + 1] === "\n") index += 1;
      record.push(field);
      field = "";
      if (record.length > 1 || record[0] !== "") records.push(record);
      record = [];
      if (records.length > MAX_DATASET_ROWS) break;
      continue;
    }
    field += char;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    if (record.length > 1 || record[0] !== "") records.push(record);
  }
  const header = records.shift();
  if (!header || header.every((cell) => !cell.trim())) {
    throw new Error("The dataset has no header row.");
  }
  const columns = header.map((cell, index) => cell.trim() || `column_${index + 1}`);
  const rows = records.map((cells) => {
    const row: Record<string, unknown> = {};
    columns.forEach((name, index) => {
      row[name] = cells[index] ?? "";
    });
    return row;
  });
  return { columns: columns.slice(0, MAX_COLUMNS), rows };
}

function normalizeCell(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "string") return JSON.stringify(value);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return trimmed;
}

function inferColumnType(
  values: ReadonlyArray<number | string | null>,
): DatasetColumnSummaryV1["type"] {
  let numbers = 0;
  let dates = 0;
  let booleans = 0;
  let nonNull = 0;
  for (const value of values) {
    if (value === null) continue;
    nonNull += 1;
    if (typeof value === "number") numbers += 1;
    else if (value === "true" || value === "false") booleans += 1;
    else if (isDateLike(value)) dates += 1;
  }
  if (nonNull === 0) return "empty";
  if (numbers / nonNull >= 0.9) return "number";
  if (booleans / nonNull >= 0.9) return "boolean";
  if (dates / nonNull >= 0.9) return "date";
  return "string";
}

function isDateLike(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function summarizeColumn(column: DatasetChartColumnV1): DatasetColumnSummaryV1 {
  const nonNull = column.values.filter(
    (value): value is number | string => value !== null,
  );
  const numbers = nonNull.filter(
    (value): value is number => typeof value === "number",
  );
  const sorted = [...numbers].sort((a, b) => a - b);
  const counts = new Map<string, number>();
  for (const value of nonNull) {
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const mean =
    numbers.length > 0
      ? numbers.reduce((total, value) => total + value, 0) / numbers.length
      : null;
  const stddev =
    mean !== null && numbers.length > 1
      ? Math.sqrt(
          numbers.reduce((total, value) => total + (value - mean) ** 2, 0) /
            (numbers.length - 1),
        )
      : null;
  return {
    name: column.name,
    type: column.type,
    nullCount: column.values.length - nonNull.length,
    uniqueCount: counts.size,
    min: sorted.length > 0 ? sorted[0]! : null,
    max: sorted.length > 0 ? sorted[sorted.length - 1]! : null,
    mean: roundStat(mean),
    median: roundStat(quantile(sorted, 0.5)),
    p25: roundStat(quantile(sorted, 0.25)),
    p75: roundStat(quantile(sorted, 0.75)),
    stddev: roundStat(stddev),
    topValues: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TOP_VALUES)
      .map(([value, count]) => ({
        value: value.length > 64 ? `${value.slice(0, 63)}…` : value,
        count,
      })),
  };
}

function quantile(sorted: ReadonlyArray<number>, q: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function roundStat(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 10_000) / 10_000;
}

function assertUtf8Text(raw: string, path: string): void {
  // Obsidian decodes vault files as UTF-8; a replacement character means the
  // source was binary or another encoding — refuse rather than mis-summarize.
  if (raw.includes("�")) {
    throw new Error(`Dataset is not valid UTF-8 text: ${path}`);
  }
  if (raw.includes("\0")) {
    throw new Error(`Dataset appears to be binary: ${path}`);
  }
}
