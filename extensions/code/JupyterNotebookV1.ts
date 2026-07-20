import { canonicalJson } from "../../packages/headless-runtime/src/canonicalize";

const MAX_NOTEBOOK_CELLS_V1 = 200;
const MAX_NOTEBOOK_SOURCE_CHARS_V1 = 1_000_000;

export type JupyterNotebookCellTypeV1 = "markdown" | "code";

export interface JupyterNotebookCellInputV1 {
  type: JupyterNotebookCellTypeV1;
  source: string;
}

export interface JupyterNotebookInputV1 {
  cells: JupyterNotebookCellInputV1[];
  kernelName?: string;
  kernelDisplayName?: string;
  language?: string;
}

export interface JupyterNotebookBuildResultV1 {
  content: string;
  cellCount: number;
  codeCellCount: number;
  markdownCellCount: number;
  kernelName: string;
  language: string;
  executionState: "not_executed";
}

/**
 * Build a deterministic nbformat-v4 notebook from bounded structured cells.
 * New notebooks intentionally contain no outputs or execution counts. Runtime
 * execution remains an explicit sandbox validation step rather than a hidden
 * side effect of file creation.
 */
export function buildJupyterNotebookV1(
  value: unknown,
): JupyterNotebookBuildResultV1 {
  const input = parseNotebookInput(value);
  const kernelName = normalizeOptionalText(input.kernelName) ?? "python3";
  const language = normalizeOptionalText(input.language) ?? "python";
  const kernelDisplayName =
    normalizeOptionalText(input.kernelDisplayName) ??
    (kernelName === "python3" ? "Python 3" : kernelName);
  let totalSourceChars = 0;
  let codeCellCount = 0;
  let markdownCellCount = 0;
  const cells = input.cells.map((cell, index) => {
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
      throw new Error(`Notebook cell ${index + 1} must be an object.`);
    }
    const source = (cell as unknown as Record<string, unknown>).source;
    const type = (cell as unknown as Record<string, unknown>).type;
    if (type !== "markdown" && type !== "code") {
      throw new Error(
        `Notebook cell ${index + 1} type must be markdown or code.`,
      );
    }
    if (typeof source !== "string") {
      throw new Error(`Notebook cell ${index + 1} source must be a string.`);
    }
    totalSourceChars += source.length;
    if (totalSourceChars > MAX_NOTEBOOK_SOURCE_CHARS_V1) {
      throw new Error(
        `Notebook source exceeds ${MAX_NOTEBOOK_SOURCE_CHARS_V1} characters.`,
      );
    }
    if (type === "code") {
      codeCellCount += 1;
      return {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: toNotebookSourceLines(source),
      };
    }
    markdownCellCount += 1;
    return {
      cell_type: "markdown",
      metadata: {},
      source: toNotebookSourceLines(source),
    };
  });
  const notebook = {
    cells,
    metadata: {
      kernelspec: {
        display_name: kernelDisplayName,
        language,
        name: kernelName,
      },
      language_info: { name: language },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return {
    content: `${JSON.stringify(notebook, null, 2)}\n`,
    cellCount: cells.length,
    codeCellCount,
    markdownCellCount,
    kernelName,
    language,
    executionState: "not_executed",
  };
}

/** Validate a compatibility raw notebook payload without executing it. */
export function validateJupyterNotebookContentV1(content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Jupyter notebook content must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Jupyter notebook content must be a JSON object.");
  }
  const notebook = parsed as Record<string, unknown>;
  if (notebook.nbformat !== 4 || !Number.isInteger(notebook.nbformat_minor)) {
    throw new Error("Jupyter notebook content must use nbformat 4.");
  }
  if (!Array.isArray(notebook.cells)) {
    throw new Error("Jupyter notebook content must contain a cells array.");
  }
  if (notebook.cells.length > MAX_NOTEBOOK_CELLS_V1) {
    throw new Error(
      `Jupyter notebook content exceeds ${MAX_NOTEBOOK_CELLS_V1} cells.`,
    );
  }
  canonicalJson(parsed);
}

function parseNotebookInput(value: unknown): JupyterNotebookInputV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("notebook must be an object with a cells array.");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "cells",
    "kernelName",
    "kernelDisplayName",
    "language",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("notebook contains unsupported fields.");
  }
  if (
    !Array.isArray(input.cells) ||
    input.cells.length < 1 ||
    input.cells.length > MAX_NOTEBOOK_CELLS_V1
  ) {
    throw new Error(
      `notebook cells must contain 1-${MAX_NOTEBOOK_CELLS_V1} entries.`,
    );
  }
  return input as unknown as JupyterNotebookInputV1;
}

function normalizeOptionalText(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw new Error("Notebook kernel and language values must be 1-100 characters.");
  }
  return value.trim();
}

function toNotebookSourceLines(source: string): string[] {
  const normalized = source.replace(/\r\n?/gu, "\n");
  if (!normalized) return [];
  return normalized.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}
