import assert from "node:assert/strict";
import test from "node:test";
import { findRelatedNotesTool } from "../src/tools/graphTools";
import { listMarkdownFilesTool } from "../src/tools/vaultTools";
import { MAX_LISTED_FILES } from "../src/tools/constants";
import type { ToolExecutionContext } from "../src/tools/types";

/*
 * Silent truncation in vault listings.
 *
 * Both of these tools capped their input at MAX_LISTED_FILES and said nothing
 * about it. On a vault larger than the cap, callers could not distinguish an
 * exhaustive answer from a sample -- and find_related_notes took that sample in
 * raw vault iteration order, so *which* notes it considered was arbitrary.
 */

interface FakeNote {
  path: string;
  mtime: number;
  body: string;
}

function contextFor(notes: FakeNote[]): ToolExecutionContext {
  const files = notes.map((note) => ({
    path: note.path,
    basename: note.path.replace(/^.*\//u, "").replace(/\.md$/u, ""),
    extension: "md",
    stat: { mtime: note.mtime, size: note.body.length },
  }));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const bodies = new Map(notes.map((note) => [note.path, note.body]));

  return {
    app: {
      vault: {
        getFiles: () => files,
        getFileByPath: (path: string) => byPath.get(path) ?? null,
        cachedRead: async (file: { path: string }) => bodies.get(file.path) ?? "",
        read: async (file: { path: string }) => bodies.get(file.path) ?? "",
      },
      metadataCache: {
        getFileCache: () => null,
        resolvedLinks: {},
        unresolvedLinks: {},
      },
      workspace: { getActiveFile: () => null },
    },
    runtimeCache: {},
  } as unknown as ToolExecutionContext;
}

function notes(count: number, body = "shared topic term"): FakeNote[] {
  return Array.from({ length: count }, (_unused, index) => ({
    // Deliberately not sorted by path, and mtime descending as index grows, so
    // "first in iteration order" and "most recent" are different answers.
    path: `Notes/note-${String(index).padStart(4, "0")}.md`,
    mtime: index,
    body,
  }));
}

test("list_markdown_files reports the cap instead of implying completeness", async () => {
  const over = await listMarkdownFilesTool.execute(
    {},
    contextFor(notes(MAX_LISTED_FILES + 25)),
  );

  assert.equal((over as { truncated: boolean }).truncated, true);
  assert.equal((over as { total: number }).total, MAX_LISTED_FILES + 25);
  assert.equal((over as { files: unknown[] }).files.length, MAX_LISTED_FILES);

  const under = await listMarkdownFilesTool.execute({}, contextFor(notes(3)));
  assert.equal((under as { truncated: boolean }).truncated, false);
  assert.equal((under as { total: number }).total, 3);
});

test("a list_markdown_files result is shaped so mission evidence can read it", async () => {
  const result = await listMarkdownFilesTool.execute({}, contextFor(notes(2)));

  // The bare array this used to return is not a record, so missionEvidence's
  // isRecord guard skipped the tool entirely and it produced no evidence at
  // all. vaultSearchEvidenceFromToolResult already recognises a "files" array.
  assert.equal(typeof result, "object");
  assert.ok(!Array.isArray(result));
  assert.ok(Array.isArray((result as { files: unknown[] }).files));
  assert.equal(
    (result as { files: Array<{ path: string }> }).files[0]?.path,
    "Notes/note-0000.md",
  );
});

test("find_related_notes samples the most recent notes and says that it sampled", async () => {
  const context = contextFor(notes(MAX_LISTED_FILES + 10));
  const result = (await findRelatedNotesTool.execute(
    { query: "shared topic term", limit: 5 },
    context,
  )) as {
    truncated: boolean;
    considered: number;
    coverage: { mode: string };
    results: Array<{ path: string }>;
  };

  assert.equal(result.truncated, true);
  assert.equal(result.considered, MAX_LISTED_FILES + 10);
  assert.equal(result.coverage.mode, "sampled");

  // The ten oldest notes are the ones dropped. Previously the cap fell wherever
  // vault iteration order put it, so the dropped set was arbitrary.
  const returned = result.results.map((item) => item.path);
  assert.ok(!returned.includes("Notes/note-0000.md"));
});

test("find_related_notes reports exact coverage when nothing was dropped", async () => {
  const result = (await findRelatedNotesTool.execute(
    { query: "shared topic term", limit: 5 },
    contextFor(notes(6)),
  )) as { truncated: boolean; considered: number; coverage: { mode: string } };

  assert.equal(result.truncated, false);
  assert.equal(result.considered, 6);
  assert.equal(result.coverage.mode, "exact");
});
