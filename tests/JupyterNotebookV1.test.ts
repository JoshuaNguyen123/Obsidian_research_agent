import assert from "node:assert/strict";
import test from "node:test";

import {
  appendJupyterReflectionV1,
  buildJupyterNotebookV1,
  validateJupyterNotebookContentV1,
  verifyJupyterReflectionReadbackV1,
} from "../extensions/code/JupyterNotebookV1";
import { portableSha256Text } from "../packages/core-api/src/portableSha256";
import { verifiedCodeReflectionFixture } from "./fixtures/verifiedCodeReflection";

test("JupyterNotebookV1 builds deterministic unexecuted nbformat 4 content", () => {
  const input = {
    cells: [
      { type: "markdown" as const, source: "# Reproducible analysis\n" },
      { type: "code" as const, source: "value = 6 * 7\nprint(value)\n" },
    ],
  };
  const first = buildJupyterNotebookV1(input);
  const second = buildJupyterNotebookV1(input);
  assert.equal(first.content, second.content);
  assert.deepEqual(
    {
      cellCount: first.cellCount,
      codeCellCount: first.codeCellCount,
      markdownCellCount: first.markdownCellCount,
      kernelName: first.kernelName,
      language: first.language,
      executionState: first.executionState,
    },
    {
      cellCount: 2,
      codeCellCount: 1,
      markdownCellCount: 1,
      kernelName: "python3",
      language: "python",
      executionState: "not_executed",
    },
  );
  const notebook = JSON.parse(first.content) as {
    nbformat: number;
    nbformat_minor: number;
    cells: Array<{
      cell_type: string;
      execution_count?: number | null;
      outputs?: unknown[];
      source: string[];
    }>;
  };
  assert.equal(notebook.nbformat, 4);
  assert.equal(notebook.nbformat_minor, 5);
  assert.deepEqual(notebook.cells[0].source, ["# Reproducible analysis\n"]);
  assert.equal(notebook.cells[1].execution_count, null);
  assert.deepEqual(notebook.cells[1].outputs, []);
  validateJupyterNotebookContentV1(first.content);
});

test("JupyterNotebookV1 rejects malformed and oversized notebook inputs", () => {
  assert.throws(
    () => buildJupyterNotebookV1({ cells: [] }),
    /1-200 entries/u,
  );
  assert.throws(
    () => buildJupyterNotebookV1({
      cells: [{ type: "shell", source: "rm -rf ." }],
    }),
    /markdown or code/u,
  );
  assert.throws(
    () => validateJupyterNotebookContentV1('{"nbformat":3,"cells":[]}'),
    /nbformat 4/u,
  );
});

test("Jupyter reflection append preserves existing cells and adds unexecuted verified examples once", () => {
  const originalNotebook = {
    cells: [
      {
        cell_type: "code",
        execution_count: 7,
        metadata: { tags: ["keep-me"] },
        outputs: [{ output_type: "stream", name: "stdout", text: ["42\n"] }],
        source: ["print(42)\n"],
      },
    ],
    metadata: { custom: { preserve: true } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  const currentContent = `${JSON.stringify(originalNotebook, null, 2)}\n`;
  const { examples } = verifiedCodeReflectionFixture();
  const appended = appendJupyterReflectionV1({
    target: { kind: "jupyter_notebook", notebookPath: "Research/Reflection.ipynb" },
    currentContent,
    expectedBeforeSha256: hash(currentContent),
    markerId: "run-notebook-1",
    markdown: "The verified implementation now adds two numeric inputs, and targeted plus full validation confirm the published commit behaves as intended.",
    codeExamples: examples,
  });
  assert.equal(appended.appended, true);
  assert.equal(appended.appendedCellCount, 2);
  assert.equal(appended.executionPerformed, false);
  const updated = JSON.parse(appended.content) as typeof originalNotebook & {
    cells: Array<Record<string, unknown>>;
  };
  assert.deepEqual(updated.cells[0], originalNotebook.cells[0]);
  assert.deepEqual(updated.metadata, originalNotebook.metadata);
  assert.equal(updated.cells[1]?.cell_type, "markdown");
  assert.equal(updated.cells[2]?.cell_type, "code");
  assert.equal(updated.cells[2]?.execution_count, null);
  assert.deepEqual(updated.cells[2]?.outputs, []);
  assert.equal(
    (updated.cells[2]?.metadata as { agentic_researcher_reflection?: { artifactSha256?: string } })
      .agentic_researcher_reflection?.artifactSha256,
    examples.examples[0]?.artifactSha256,
  );
  assert.deepEqual(
    verifyJupyterReflectionReadbackV1(
      appended.content,
      appended.expectedReadbackSha256,
    ),
    { version: 1, verified: true, sha256: appended.expectedReadbackSha256 },
  );

  const retry = appendJupyterReflectionV1({
    target: appended.target,
    currentContent: appended.content,
    expectedBeforeSha256: hash(currentContent),
    markerId: "run-notebook-1",
    markdown: "The verified implementation now adds two numeric inputs, and targeted plus full validation confirm the published commit behaves as intended.",
    codeExamples: examples,
  });
  assert.equal(retry.appended, false);
  assert.equal(retry.content, appended.content);
  assert.equal(retry.appendedCellCount, 0);
  assert.throws(
    () => appendJupyterReflectionV1({
      target: appended.target,
      currentContent: appended.content,
      expectedBeforeSha256: appended.expectedReadbackSha256,
      markerId: "run-notebook-1",
      markdown: "A different completion narrative cannot reuse this marker because its content and verified provenance no longer match the stored reflection.",
      codeExamples: examples,
    }),
    /marker already exists with different content or provenance/iu,
  );
});

test("Jupyter reflection append fails closed for stale, unsafe, or meaningless requests", () => {
  const currentContent = buildJupyterNotebookV1({
    cells: [{ type: "markdown", source: "# Existing analysis" }],
  }).content;
  const base = {
    target: { kind: "jupyter_notebook" as const, notebookPath: "Research/Reflection.ipynb" },
    currentContent,
    markerId: "run-notebook-2",
    markdown: "This completed analysis records the tested implementation outcome and keeps the exact evidence attached for a later reviewer.",
  };
  assert.throws(
    () => appendJupyterReflectionV1({
      ...base,
      expectedBeforeSha256: `sha256:${"0".repeat(64)}`,
    }),
    /changed after its expected pre-write hash/iu,
  );
  assert.throws(
    () => appendJupyterReflectionV1({
      ...base,
      target: { kind: "jupyter_notebook", notebookPath: "../Reflection.ipynb" },
      expectedBeforeSha256: hash(currentContent),
    }),
    /safe vault-relative/iu,
  );
  assert.throws(
    () => appendJupyterReflectionV1({
      ...base,
      expectedBeforeSha256: hash(currentContent),
      markdown: "<!-- done --> https://github.com/acme/repo",
    }),
    /meaningful explanatory prose/iu,
  );
});

function hash(value: string): string {
  return `sha256:${portableSha256Text(value)}`;
}
