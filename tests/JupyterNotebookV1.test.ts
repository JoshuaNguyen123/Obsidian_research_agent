import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJupyterNotebookV1,
  validateJupyterNotebookContentV1,
} from "../extensions/code/JupyterNotebookV1";

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
