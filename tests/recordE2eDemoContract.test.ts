import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const recorderSource = readFileSync("scripts/record-e2e-demo.mjs", "utf8");
const nativeHarnessSource = readFileSync(
  "e2e/fixtures/nativeObsidianHarness.ts",
  "utf8",
);

test("Windows demo capture discovers Electron top-level windows by process id", () => {
  assert.match(recorderSource, /EnumWindows/u);
  assert.match(recorderSource, /GetWindowThreadProcessId/u);
  assert.match(recorderSource, /IsWindowVisible/u);
  assert.doesNotMatch(recorderSource, /\.MainWindowHandle/u);
  assert.doesNotMatch(recorderSource, /\.MainWindowTitle/u);
});

test("demo recording explicitly opts into a visible Obsidian window", () => {
  assert.match(recorderSource, /E2E_SHOW_OBSIDIAN_WINDOW: "1"/u);
  assert.match(
    nativeHarnessSource,
    /windowsHide: process\.env\.E2E_SHOW_OBSIDIAN_WINDOW !== "1"/u,
  );
});
