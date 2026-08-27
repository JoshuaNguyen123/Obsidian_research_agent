import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  COMPANION_ASSETS_ARTIFACT,
  findNonCanonicalAssets,
} from "../scripts/build-companion-assets.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("carriage returns in an asset source are refused before they are hashed", () => {
  assert.deepEqual(
    findNonCanonicalAssets({
      "config.py": "import os\nfrom pathlib import Path\n",
      "auth.py": "import os\r\nfrom pathlib import Path\r\n",
      "requirements.txt": "httpx\r\n",
    }),
    ["auth.py", "requirements.txt"],
  );
  assert.deepEqual(findNonCanonicalAssets({}), []);
});

test("the shipped artifact carries the canonical bytes", async () => {
  const artifact = JSON.parse(
    await readFile(path.join(repoRoot, COMPANION_ASSETS_ARTIFACT), "utf8"),
  ) as { files: Record<string, string> };
  assert.deepEqual(
    findNonCanonicalAssets(artifact.files),
    [],
    `${COMPANION_ASSETS_ARTIFACT} was built from a checkout with non-canonical line endings`,
  );
});
