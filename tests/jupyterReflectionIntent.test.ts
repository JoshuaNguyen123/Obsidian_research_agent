import assert from "node:assert/strict";
import test from "node:test";
import {
  extractExplicitJupyterNotebookPathsV1,
  hasJupyterReflectionIntentV1,
} from "../src/agent/jupyterReflectionIntent";

test("extracts safe explicit notebook targets without widening to unsafe paths", () => {
  assert.deepEqual(
    extractExplicitJupyterNotebookPathsV1(
      "Append the reflection to `Projects/Run audit.ipynb`.",
    ),
    ["Projects/Run audit.ipynb"],
  );
  assert.deepEqual(
    extractExplicitJupyterNotebookPathsV1(
      "Reflect into Results.ipynb, never ../Secrets.ipynb or C:\\Temp\\x.ipynb.",
    ),
    ["Results.ipynb"],
  );
});

test("requires affirmative reflection language and rejects negation", () => {
  assert.equal(
    hasJupyterReflectionIntentV1(
      "Write the final reflection to a Jupyter notebook.",
    ),
    true,
  );
  assert.equal(
    hasJupyterReflectionIntentV1(
      "I want the project retrospective in a Jupyter notebook.",
    ),
    true,
  );
  assert.equal(
    hasJupyterReflectionIntentV1(
      "Write back the verified completion reflection to `Projects/Run.ipynb`.",
    ),
    true,
  );
  assert.equal(
    hasJupyterReflectionIntentV1(
      "Inspect `Projects/Run.ipynb` without writing a reflection.",
    ),
    false,
  );
  assert.equal(
    hasJupyterReflectionIntentV1(
      "Do not append a reflection to `Projects/Run.ipynb`.",
    ),
    false,
  );
  assert.equal(
    hasJupyterReflectionIntentV1(
      "Do not call append_jupyter_reflection; leave `Projects/Run.ipynb` unchanged.",
    ),
    false,
  );
  assert.equal(
    hasJupyterReflectionIntentV1(
      "Call append_jupyter_reflection for `Projects/Run.ipynb`.",
    ),
    true,
  );
  assert.equal(
    hasJupyterReflectionIntentV1(
      "Write the final report to `Projects/Run.ipynb`.",
    ),
    true,
  );
  assert.equal(
    hasJupyterReflectionIntentV1(
      "Write the final reflection to a Results page, not to a Jupyter notebook.",
    ),
    false,
  );
  assert.equal(
    hasJupyterReflectionIntentV1(
      "Do not write the final reflection to a Jupyter notebook.",
    ),
    false,
  );
  assert.equal(
    hasJupyterReflectionIntentV1(
      "Write the final reflection to a Jupyter notebook; do not execute cells.",
    ),
    true,
  );
});
