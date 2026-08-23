import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertSafeMarkdownPath,
  getVaultPathExtension,
  isResearchDataFilePath,
  normalizeVaultContentPath,
  normalizeVaultPath,
  RESEARCH_DATA_FILE_EXTENSIONS,
} from "../src/tools/validation";
import { ToolExecutionError } from "../src/tools/types";

function expectUnsafe(path: string, run: () => unknown) {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === "unsafe_path",
    `expected ${JSON.stringify(path)} to be rejected as unsafe`,
  );
}

describe("research data file paths", () => {
  it("accepts markdown and reports it as markdown", () => {
    assert.deepEqual(normalizeVaultContentPath("Projects/Notes.md"), {
      path: "Projects/Notes.md",
      kind: "markdown",
    });
    assert.deepEqual(normalizeVaultContentPath("Projects/Notes.MD"), {
      path: "Projects/Notes.MD",
      kind: "markdown",
    });
  });

  it("accepts every allowlisted research data extension beside a note", () => {
    for (const extension of RESEARCH_DATA_FILE_EXTENSIONS) {
      const path = `Projects/Sources.${extension}`;
      assert.deepEqual(
        normalizeVaultContentPath(path),
        { path, kind: "research_data" },
        `${extension} should be allowed`,
      );
      assert.equal(isResearchDataFilePath(path), true);
    }
  });

  it("keeps the allowlist closed against everything else", () => {
    for (const path of [
      "Projects/figure.png",
      "Projects/script.js",
      "Projects/script.mjs",
      "Projects/analyze.py",
      "Projects/run.sh",
      "Projects/run.bat",
      "Projects/tool.exe",
      "Projects/archive.zip",
      "Projects/style.css",
      "Projects/page.html",
      "Projects/Notes",
      "Projects/Notes.md.js",
      "Projects/.hidden",
    ]) {
      expectUnsafe(path, () => normalizeVaultContentPath(path));
    }
  });

  it("keeps every path rejection that markdown creates already had", () => {
    // A widened extension list must not become a widened path surface. These
    // are the same rejections normalizeVaultPath enforces for markdown.
    for (const path of [
      "../secret.bib",
      "Projects/../../secret.csv",
      "/etc/passwd.json",
      "C:/Users/me/notes.csv",
      "Projects\\data.csv",
      ".obsidian/plugins/data.json",
      ".trash/data.csv",
      ".agent-backups/data.csv",
      "trash/data.csv",
      "Projects//data.csv",
      "Projects/./data.csv",
      "",
      "   ",
    ]) {
      expectUnsafe(path, () => normalizeVaultContentPath(path));
    }
  });

  it("rejects the blocked roots case-insensitively", () => {
    for (const path of [".Obsidian/data.json", ".TRASH/data.csv"]) {
      expectUnsafe(path, () => normalizeVaultContentPath(path));
    }
  });

  it("leaves markdown-only validation exactly as strict as it was", () => {
    // AGENTS.md: markdown-only tools must reject non-markdown paths. The data
    // allowlist lives on a separate function precisely so this stays true.
    for (const extension of RESEARCH_DATA_FILE_EXTENSIONS) {
      const path = `Projects/Sources.${extension}`;
      expectUnsafe(path, () => assertSafeMarkdownPath(path));
      expectUnsafe(path, () =>
        normalizeVaultPath(path, { requireMarkdown: true }),
      );
    }
    assert.doesNotThrow(() => assertSafeMarkdownPath("Projects/Notes.md"));
  });

  it("reads the extension from the file name, not from a folder name", () => {
    assert.equal(getVaultPathExtension("Projects/v1.2/Notes.md"), "md");
    assert.equal(getVaultPathExtension("Projects/v1.2/Sources.bib"), "bib");
    assert.equal(getVaultPathExtension("Projects/v1.2/README"), "");
    assert.equal(isResearchDataFilePath("Projects/data.csv/notes"), false);
  });

  it("does not allow an executable or config extension into the list", () => {
    for (const banned of [
      "js",
      "mjs",
      "cjs",
      "ts",
      "py",
      "sh",
      "bat",
      "cmd",
      "ps1",
      "exe",
      "dll",
      "html",
      "svg",
    ]) {
      assert.equal(
        RESEARCH_DATA_FILE_EXTENSIONS.includes(banned),
        false,
        `${banned} must not be an allowed research data extension`,
      );
    }
  });
});
