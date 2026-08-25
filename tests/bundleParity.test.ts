import assert from "node:assert/strict";
import test from "node:test";

import {
  BUNDLE_PARITY_ARTIFACTS,
  BUNDLE_PARITY_REBUILD_HINT,
  driftedParityArtifactsFromStat,
  parseBundleParityArgs,
} from "../scripts/check-bundle-parity.mjs";

test("bundle parity tracks only generated install artifacts", () => {
  assert.deepEqual([...BUNDLE_PARITY_ARTIFACTS], [
    "main.js",
    "companion-assets.json",
  ]);
  assert.equal(
    BUNDLE_PARITY_ARTIFACTS.includes("styles.css"),
    false,
    "styles.css is hand-authored and must stay out of bundle parity",
  );
});

test("bundle parity --no-build is the test:ci mode that assumes a prior build", () => {
  assert.deepEqual(parseBundleParityArgs([]), { noBuild: false });
  assert.deepEqual(parseBundleParityArgs(["--no-build"]), { noBuild: true });
});

test("dirty git --stat output names which artifact drifted", () => {
  const stat = [
    " main.js               | 756 +++++++++++++++++++++++++-------------------------",
    " companion-assets.json |   2 +-",
    " 2 files changed, 382 insertions(+), 376 deletions(-)",
    "",
  ].join("\n");
  assert.deepEqual(driftedParityArtifactsFromStat(stat), [
    "main.js",
    "companion-assets.json",
  ]);
  assert.deepEqual(
    driftedParityArtifactsFromStat(" companion-assets.json |   2 +-\n"),
    ["companion-assets.json"],
  );
  assert.deepEqual(driftedParityArtifactsFromStat(""), []);
  assert.match(BUNDLE_PARITY_REBUILD_HINT, /run npm run build and commit artifacts/u);
});
