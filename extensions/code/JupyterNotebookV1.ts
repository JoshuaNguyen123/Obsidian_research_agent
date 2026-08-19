import { canonicalJson } from "../../packages/headless-runtime/src/canonicalize";
import { assertMeaningfulReflectionContentV1 } from "../../packages/core-api/src/reflectionContentV1";
import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
import {
  parseVerifiedCodeReflectionExamplesV1,
  type VerifiedCodeReflectionExamplesV1,
} from "../../packages/core-api/src/verifiedCodePublicationHandoffV1";

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

export interface JupyterReflectionTargetV1 {
  kind: "jupyter_notebook";
  /** Explicit vault-relative notebook path. */
  notebookPath: string;
}

export interface AppendJupyterReflectionInputV1 {
  target: JupyterReflectionTargetV1;
  currentContent: string;
  /** Hash of the exact bytes read before append; prevents stale overwrites. */
  expectedBeforeSha256: string;
  markerId: string;
  /** Human-facing reflection prose. */
  markdown: string;
  /** Optional exact-commit excerpts, already bound to verified artifact hashes. */
  codeExamples?: VerifiedCodeReflectionExamplesV1 | null;
}

export interface AppendJupyterReflectionResultV1 {
  version: 1;
  target: JupyterReflectionTargetV1;
  marker: string;
  content: string;
  appended: boolean;
  appendedCellCount: number;
  beforeSha256: string;
  expectedReadbackSha256: string;
  executionPerformed: false;
}

export interface JupyterReflectionReadbackV1 {
  version: 1;
  verified: true;
  sha256: string;
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

/**
 * Flatten structured notebook cells into ordinary file text. Used when a model
 * supplies a notebook object for a non-.ipynb path (common when a mission says
 * "notebook" meaning an Obsidian note while Code work expects source files).
 */
export function flattenNotebookCellsToPlainContentV1(value: unknown): string {
  const input = parseNotebookInput(value);
  let totalSourceChars = 0;
  const parts: string[] = [];
  for (const [index, cell] of input.cells.entries()) {
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
    const normalized = source.replace(/\r\n?/gu, "\n").replace(/\n+$/u, "");
    if (normalized.length > 0) parts.push(normalized);
  }
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
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

/**
 * Append a reflection to an explicitly bound notebook without executing it.
 * Existing cells, cell metadata, outputs, and notebook metadata are preserved
 * semantically. A stable cell marker makes retries append-once.
 */
export function appendJupyterReflectionV1(
  input: AppendJupyterReflectionInputV1,
): AppendJupyterReflectionResultV1 {
  const target: JupyterReflectionTargetV1 = {
    kind: "jupyter_notebook",
    notebookPath: safeNotebookPath(input.target?.notebookPath),
  };
  if (input.target?.kind !== "jupyter_notebook") {
    throw new Error("Jupyter reflection requires an explicit notebook target.");
  }
  if (typeof input.currentContent !== "string" || input.currentContent.length > 10_000_000) {
    throw new Error("Jupyter reflection requires bounded notebook content.");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.expectedBeforeSha256)) {
    throw new Error("Jupyter reflection expected pre-write hash is invalid.");
  }
  const beforeSha256 = sha256Text(input.currentContent);
  const markdown = assertMeaningfulReflectionContentV1(
    input.markdown,
    "Jupyter reflection",
  );
  const marker = buildJupyterReflectionMarkerV1(input.markerId);
  const notebook = parseNotebookContent(input.currentContent);
  const codeExamples = input.codeExamples
    ? parseVerifiedCodeReflectionExamplesV1(input.codeExamples)
    : null;
  if (notebookHasReflectionMarker(notebook, marker)) {
    if (!notebookHasExactReflection(notebook, marker, markdown, codeExamples)) {
      throw new Error("Jupyter reflection marker already exists with different content or provenance.");
    }
    return {
      version: 1,
      target,
      marker,
      content: input.currentContent,
      appended: false,
      appendedCellCount: 0,
      beforeSha256,
      expectedReadbackSha256: beforeSha256,
      executionPerformed: false,
    };
  }
  if (input.expectedBeforeSha256 !== beforeSha256) {
    throw new Error("Jupyter reflection target changed after its expected pre-write hash was captured.");
  }
  const appendedCells: Record<string, unknown>[] = [
    {
      cell_type: "markdown",
      metadata: {
        agentic_researcher_reflection: {
          version: 1,
          marker,
          kind: "summary",
          ...(codeExamples ? { commitSha: codeExamples.commitSha } : {}),
        },
      },
      source: toNotebookSourceLines(`${markdown.replace(/\s+$/u, "")}\n\n${marker}\n`),
    },
  ];
  for (const example of codeExamples?.examples ?? []) {
    appendedCells.push({
      cell_type: "code",
      execution_count: null,
      metadata: {
        agentic_researcher_reflection: {
          version: 1,
          marker,
          kind: "verified_code_example",
          commitSha: example.commitSha,
          path: example.path,
          artifactSha256: example.artifactSha256,
          codeSha256: example.codeSha256,
          startLine: example.startLine,
          endLine: example.endLine,
        },
      },
      outputs: [],
      source: toNotebookSourceLines(example.code),
    });
  }
  if (notebook.cells.length + appendedCells.length > MAX_NOTEBOOK_CELLS_V1) {
    throw new Error(`Jupyter notebook content exceeds ${MAX_NOTEBOOK_CELLS_V1} cells after reflection append.`);
  }
  assertNotebookSourceBudget([...notebook.cells, ...appendedCells]);
  const updated = {
    ...notebook,
    cells: [...notebook.cells, ...appendedCells],
  };
  const content = `${JSON.stringify(updated, null, 2)}\n`;
  return {
    version: 1,
    target,
    marker,
    content,
    appended: true,
    appendedCellCount: appendedCells.length,
    beforeSha256,
    expectedReadbackSha256: sha256Text(content),
    executionPerformed: false,
  };
}

/** Verify exact post-write bytes; schema validity alone is insufficient proof. */
export function verifyJupyterReflectionReadbackV1(
  content: string,
  expectedSha256: string,
): JupyterReflectionReadbackV1 {
  if (!/^sha256:[0-9a-f]{64}$/u.test(expectedSha256)) {
    throw new Error("Jupyter reflection expected readback hash is invalid.");
  }
  validateJupyterNotebookContentV1(content);
  const sha256 = sha256Text(content);
  if (sha256 !== expectedSha256) {
    throw new Error("Jupyter reflection readback hash does not match the appended notebook.");
  }
  return { version: 1, verified: true, sha256 };
}

export function buildJupyterReflectionMarkerV1(markerId: string): string {
  if (typeof markerId !== "string") throw new Error("Jupyter reflection marker id must be text.");
  const id = markerId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 200);
  if (!id) throw new Error("Jupyter reflection marker id cannot be blank.");
  return `agentic-jupyter-reflection:${id}`;
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

function parseNotebookContent(content: string): Record<string, unknown> & { cells: Record<string, unknown>[] } {
  validateJupyterNotebookContentV1(content);
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const cells = parsed.cells as unknown[];
  const normalizedCells = cells.map((cell, index) => {
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
      throw new Error(`Jupyter notebook cell ${index + 1} must be an object.`);
    }
    return cell as Record<string, unknown>;
  });
  assertNotebookSourceBudget(normalizedCells);
  return { ...parsed, cells: normalizedCells };
}

function notebookHasReflectionMarker(
  notebook: { cells: Record<string, unknown>[] },
  marker: string,
): boolean {
  return notebook.cells.some((cell) => {
    const metadata = asRecord(cell.metadata);
    const reflection = asRecord(metadata?.agentic_researcher_reflection);
    if (reflection?.marker === marker) return true;
    const source = Array.isArray(cell.source)
      ? cell.source.filter((part): part is string => typeof part === "string").join("")
      : typeof cell.source === "string"
        ? cell.source
        : "";
    return source.includes(marker);
  });
}

function notebookHasExactReflection(
  notebook: { cells: Record<string, unknown>[] },
  marker: string,
  markdown: string,
  codeExamples: VerifiedCodeReflectionExamplesV1 | null,
): boolean {
  const expectedSummary = `${markdown.replace(/\s+$/u, "")}\n\n${marker}\n`;
  const summary = notebook.cells.find((cell) => {
    const reflection = asRecord(asRecord(cell.metadata)?.agentic_researcher_reflection);
    return (
      cell.cell_type === "markdown" &&
      reflection?.marker === marker &&
      reflection.kind === "summary"
    );
  });
  const summaryReflection = summary
    ? asRecord(asRecord(summary.metadata)?.agentic_researcher_reflection)
    : null;
  if (
    !summary ||
    notebookCellSource(summary) !== expectedSummary ||
    (codeExamples
      ? summaryReflection?.commitSha !== codeExamples.commitSha
      : summaryReflection?.commitSha !== undefined)
  ) return false;
  const expectedExamples = codeExamples?.examples ?? [];
  const observedExamples = notebook.cells.filter((cell) => {
    const reflection = asRecord(asRecord(cell.metadata)?.agentic_researcher_reflection);
    return reflection?.marker === marker && reflection.kind === "verified_code_example";
  });
  if (observedExamples.length !== expectedExamples.length) return false;
  return expectedExamples.every((example) => observedExamples.some((cell) => {
    const reflection = asRecord(asRecord(cell.metadata)?.agentic_researcher_reflection);
    return (
      reflection?.path === example.path &&
      reflection.commitSha === example.commitSha &&
      reflection.artifactSha256 === example.artifactSha256 &&
      reflection.codeSha256 === example.codeSha256 &&
      reflection.startLine === example.startLine &&
      reflection.endLine === example.endLine &&
      cell.cell_type === "code" &&
      cell.execution_count === null &&
      Array.isArray(cell.outputs) &&
      cell.outputs.length === 0 &&
      notebookCellSource(cell) === example.code
    );
  }));
}

function notebookCellSource(cell: Record<string, unknown>): string {
  return Array.isArray(cell.source)
    ? cell.source.filter((part): part is string => typeof part === "string").join("")
    : typeof cell.source === "string"
      ? cell.source
      : "";
}

function assertNotebookSourceBudget(cells: readonly Record<string, unknown>[]): void {
  let chars = 0;
  for (const [index, cell] of cells.entries()) {
    const source = cell.source;
    if (typeof source === "string") {
      chars += source.length;
    } else if (Array.isArray(source) && source.every((part) => typeof part === "string")) {
      chars += source.reduce((total, part) => total + part.length, 0);
    } else {
      throw new Error(`Jupyter notebook cell ${index + 1} source must be text or text lines.`);
    }
    if (chars > MAX_NOTEBOOK_SOURCE_CHARS_V1) {
      throw new Error(`Notebook source exceeds ${MAX_NOTEBOOK_SOURCE_CHARS_V1} characters.`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeNotebookPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) {
    throw new Error("Jupyter reflection notebook path must be bounded text.");
  }
  const path = value.trim();
  const parts = path.split("/");
  if (
    !path.toLowerCase().endsWith(".ipynb") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[a-z]:/iu.test(path) ||
    parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  ) {
    throw new Error("Jupyter reflection target must be a safe vault-relative .ipynb path.");
  }
  return path;
}

function sha256Text(value: string): string {
  return `sha256:${portableSha256Text(value)}`;
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
