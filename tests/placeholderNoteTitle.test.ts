import test from "node:test";
import assert from "node:assert/strict";
import {
  isExplicitVisibleFileRenameIntent,
  isPlaceholderNoteBasename,
  isTitleOnlyIntent,
  isVisibleTitleRenameIntent,
} from "../src/agent/titleIntent";
import {
  allocateUniqueMarkdownPath,
  extractLeadingH1Title,
  resolveWritebackVisibleTitle,
  sanitizeFileBasename,
} from "../src/agent/placeholderNoteTitle";

test("isPlaceholderNoteBasename matches Untitled and Untitled N", () => {
  assert.equal(isPlaceholderNoteBasename("Untitled"), true);
  assert.equal(isPlaceholderNoteBasename("Untitled 1"), true);
  assert.equal(isPlaceholderNoteBasename("untitled 12"), true);
  assert.equal(isPlaceholderNoteBasename("Hello World"), false);
  assert.equal(isPlaceholderNoteBasename("Untitled Notes"), false);
});

test("resolveWritebackVisibleTitle prefers leading H1 then mission", () => {
  assert.equal(
    resolveWritebackVisibleTitle({
      leadingH1: "Hello World in TypeScript",
      prompt: "Write something else",
      basename: "Untitled 1",
    }),
    "Hello World in TypeScript",
  );
  assert.equal(
    resolveWritebackVisibleTitle({
      writtenMarkdown: "# Purple Horizon\n\nBody",
      prompt: "Create text with the title Purple Horizon on this page.",
      basename: "Untitled",
    }),
    "Purple Horizon",
  );
  assert.equal(
    resolveWritebackVisibleTitle({
      prompt: "Write Hello World in TypeScript on this page.",
      basename: "Untitled",
    }),
    "Hello World in TypeScript on this page",
  );
  assert.equal(
    resolveWritebackVisibleTitle({
      leadingH1: "Untitled",
      prompt: "Append more text",
      basename: "Untitled",
    }),
    "more text",
  );
  assert.equal(
    resolveWritebackVisibleTitle({
      leadingH1: "Untitled",
      prompt: "ok",
      basename: "Untitled",
    }),
    null,
  );
});

test("extractLeadingH1Title and sanitizeFileBasename", () => {
  assert.equal(
    extractLeadingH1Title("# Hello World in TypeScript\n\nbody"),
    "Hello World in TypeScript",
  );
  assert.equal(sanitizeFileBasename('A/B:C*?"<>|'), "A-B-C-");
});

test("allocateUniqueMarkdownPath suffixes collisions", () => {
  const existing = new Set(["Hello.md"]);
  assert.equal(
    allocateUniqueMarkdownPath("Hello.md", (path) => existing.has(path)),
    "Hello 2.md",
  );
});

test("generate-with-title is visible title intent but not explicit rename", () => {
  const prompt =
    "Create a 50 word piece of text with the title Purple Horizon on this page.";
  assert.equal(isVisibleTitleRenameIntent(prompt), true);
  assert.equal(isExplicitVisibleFileRenameIntent(prompt), false);
  assert.equal(isTitleOnlyIntent(prompt), false);
  assert.equal(
    isExplicitVisibleFileRenameIntent("Rename the current note to Purple Horizon."),
    true,
  );
});
