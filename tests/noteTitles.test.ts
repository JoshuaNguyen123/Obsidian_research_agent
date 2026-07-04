import test from "node:test";
import assert from "node:assert/strict";
import {
  detectFrontmatter,
  getFirstH1,
  getFrontmatterTitle,
  retitleNoteMarkdown,
} from "../src/tools/noteTitles";

test("retitleNoteMarkdown inserts an H1 when there is no frontmatter or H1", () => {
  const input = "These are rough notes about building an Obsidian plugin.";

  assert.equal(
    retitleNoteMarkdown(input, "Obsidian Plugin Research Notes"),
    "# Obsidian Plugin Research Notes\n\nThese are rough notes about building an Obsidian plugin.",
  );
});

test("retitleNoteMarkdown handles empty notes", () => {
  assert.equal(retitleNoteMarkdown("", "Empty Note"), "# Empty Note\n");
});

test("retitleNoteMarkdown updates frontmatter title and existing H1", () => {
  const input = [
    "---",
    "title: Old Agent Notes",
    "status: draft",
    "tags:",
    "  - obsidian",
    "---",
    "",
    "# Old Agent Notes",
    "",
    "## Summary",
    "",
    "This note describes an early version of the agent.",
  ].join("\n");

  const expected = [
    "---",
    "title: Native Obsidian Agentic Research",
    "status: draft",
    "tags:",
    "  - obsidian",
    "---",
    "",
    "# Native Obsidian Agentic Research",
    "",
    "## Summary",
    "",
    "This note describes an early version of the agent.",
  ].join("\n");

  assert.equal(
    retitleNoteMarkdown(input, "Native Obsidian Agentic Research"),
    expected,
  );
});

test("retitleNoteMarkdown inserts frontmatter title and missing H1", () => {
  const input = [
    "---",
    "status: active",
    "tags:",
    "  - research",
    "---",
    "",
    "This note contains rough research notes about Obsidian agents.",
  ].join("\n");

  const expected = [
    "---",
    "title: Obsidian Agent Research Notes",
    "status: active",
    "tags:",
    "  - research",
    "---",
    "",
    "# Obsidian Agent Research Notes",
    "",
    "This note contains rough research notes about Obsidian agents.",
  ].join("\n");

  assert.equal(retitleNoteMarkdown(input, "Obsidian Agent Research Notes"), expected);
});

test("retitleNoteMarkdown replaces only the first H1", () => {
  const input = ["# Old Title", "", "Existing content.", "", "# Later H1"].join("\n");
  const expected = ["# Better Title", "", "Existing content.", "", "# Later H1"].join(
    "\n",
  );

  assert.equal(retitleNoteMarkdown(input, "Better Title"), expected);
});

test("frontmatter detection ignores horizontal rules later in the note", () => {
  const input = ["# Old Title", "", "---", "", "Not frontmatter."].join("\n");

  assert.equal(detectFrontmatter(input), null);
  assert.equal(
    retitleNoteMarkdown(input, "Better Title"),
    ["# Better Title", "", "---", "", "Not frontmatter."].join("\n"),
  );
});

test("headings and delimiters inside code blocks are not note titles", () => {
  const input = [
    "```md",
    "# Not The Note Title",
    "---",
    "```",
    "",
    "Body content.",
  ].join("\n");

  assert.equal(getFirstH1(input), null);
  assert.equal(
    retitleNoteMarkdown(input, "Real Note Title"),
    [
      "# Real Note Title",
      "",
      "```md",
      "# Not The Note Title",
      "---",
      "```",
      "",
      "Body content.",
    ].join("\n"),
  );
});

test("retitleNoteMarkdown inserts H1 after frontmatter before code blocks", () => {
  const input = [
    "---",
    "status: active",
    "---",
    "",
    "```md",
    "# Not The Note Title",
    "---",
    "```",
  ].join("\n");

  const output = retitleNoteMarkdown(input, "Real Note Title");

  assert.equal(getFrontmatterTitle(output), "Real Note Title");
  assert.equal(
    output,
    [
      "---",
      "title: Real Note Title",
      "status: active",
      "---",
      "",
      "# Real Note Title",
      "",
      "```md",
      "# Not The Note Title",
      "---",
      "```",
    ].join("\n"),
  );
});

test("retitleNoteMarkdown is idempotent", () => {
  const once = retitleNoteMarkdown(
    ["---", "title: Old", "---", "", "# Old", "", "Body"].join("\n"),
    "Stable Title",
  );
  const twice = retitleNoteMarkdown(once, "Stable Title");

  assert.equal(twice, once);
  assert.equal((twice.match(/^# /gm) ?? []).length, 1);
  assert.equal((twice.match(/^title:/gm) ?? []).length, 1);
});
