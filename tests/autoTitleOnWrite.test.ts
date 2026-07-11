import test from "node:test";
import assert from "node:assert/strict";
import {
  decideAutoTitle,
  deriveAutoTitle,
  isGenericBasename,
  shouldSkipAutoTitle,
} from "../src/agent/autoTitleOnWrite";

test("isGenericBasename matches Untitled and generic stems", () => {
  assert.equal(isGenericBasename("Untitled"), true);
  assert.equal(isGenericBasename("Untitled 3"), true);
  assert.equal(isGenericBasename("New Note"), true);
  assert.equal(isGenericBasename("Draft"), true);
  assert.equal(isGenericBasename("Quantum Computing Brief"), false);
});

test("shouldSkipAutoTitle skips tiny appends and keep-title language", () => {
  assert.equal(
    shouldSkipAutoTitle({
      prompt: "append a short note",
      kind: "append",
      writtenChars: 12,
    }),
    true,
  );
  assert.equal(
    shouldSkipAutoTitle({
      prompt: "write a report but keep the title",
      kind: "replace",
      writtenChars: 400,
    }),
    true,
  );
  assert.equal(
    shouldSkipAutoTitle({
      prompt: "write a long report about fusion",
      kind: "replace",
      writtenChars: 400,
    }),
    false,
  );
});

test("deriveAutoTitle prefers leading H1", () => {
  assert.equal(
    deriveAutoTitle({
      prompt: "write about fusion energy",
      writtenMarkdown: "# Fusion Energy Primer\n\nBody text here.",
      basename: "Untitled",
    }),
    "Fusion Energy Primer",
  );
});

test("decideAutoTitle renames generic basename from H1", () => {
  const decision = decideAutoTitle({
    prompt: "write a brief about fusion energy",
    kind: "replace",
    writtenMarkdown: "# Fusion Energy Primer\n\n" + "x".repeat(200),
    basename: "Untitled",
    writtenChars: 250,
  });
  assert.equal(decision.skip, false);
  assert.equal(decision.title, "Fusion Energy Primer");
});

test("decideAutoTitle skips non-generic without substantial H1", () => {
  const decision = decideAutoTitle({
    prompt: "append a sentence",
    kind: "append",
    writtenMarkdown: "just a line",
    basename: "My Research Note",
    writtenChars: 12,
  });
  assert.equal(decision.skip, true);
});
