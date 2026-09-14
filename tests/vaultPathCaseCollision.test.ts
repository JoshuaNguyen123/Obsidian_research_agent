import assert from "node:assert/strict";
import test from "node:test";

import type { ToolExecutionContext } from "../src/tools/types";
import {
  createFileTool,
  createFolderTool,
  findVaultPathCaseVariantV1,
  movePathTool,
} from "../src/tools/vaultTools";

/**
 * Obsidian keys its file map by exact path, so a lookup for `Notes/Report.md`
 * misses `notes/report.md`. On Windows and macOS the create that follows that
 * miss writes over the note that is already there, and create paths take no
 * backup — they are supposed to be making something new.
 */
test("a case-only difference is reported as an existing path", () => {
  const paths = ["Notes/report.md", "Projects", "Archive/2026/plan.md"];
  assert.equal(findVaultPathCaseVariantV1(paths, "Notes/Report.md"), "Notes/report.md");
  assert.equal(findVaultPathCaseVariantV1(paths, "PROJECTS"), "Projects");
  assert.equal(findVaultPathCaseVariantV1(paths, "archive/2026/PLAN.md"), "Archive/2026/plan.md");
  // An exact match is the caller's own existing-path check, not a variant.
  assert.equal(findVaultPathCaseVariantV1(paths, "Notes/report.md"), null);
  assert.equal(findVaultPathCaseVariantV1(paths, "Notes/other.md"), null);
});

test("create_file refuses to write over a note that differs only in case", async () => {
  const vault = createMockVault(["Notes/report.md"]);
  await assert.rejects(
    () =>
      createFileTool.execute(
        { path: "Notes/Report.md", content: "new draft" },
        vault.context,
      ),
    (error: unknown) =>
      error instanceof Error &&
      /differs only in letter case/u.test(error.message) &&
      error.message.includes("Notes/report.md"),
  );
  assert.deepEqual(vault.operations, [], "nothing may be written");
  assert.equal(vault.content.get("Notes/report.md"), "existing content");
});

test("create_file still creates a genuinely new path", async () => {
  const vault = createMockVault(["Notes/report.md"]);
  const result = (await createFileTool.execute(
    { path: "Notes/summary.md", content: "new draft" },
    vault.context,
  )) as { path: string };
  assert.equal(result.path, "Notes/summary.md");
  assert.equal(vault.content.get("Notes/summary.md"), "new draft");
});

test("create_folder refuses a case-variant folder", async () => {
  const vault = createMockVault(["Projects/one.md"]);
  await assert.rejects(
    () => createFolderTool.execute({ path: "projects" }, vault.context),
    /differs only in letter case/u,
  );
});

test("move_path may still rename a file to its own case variant", async () => {
  const vault = createMockVault(["Notes/report.md"]);
  const result = (await movePathTool.execute(
    { fromPath: "Notes/report.md", toPath: "Notes/Report.md" },
    vault.context,
  )) as { toPath: string };
  assert.equal(result.toPath, "Notes/Report.md");
});

test("move_path still refuses a different file's case variant", async () => {
  const vault = createMockVault(["Notes/report.md", "Notes/draft.md"]);
  await assert.rejects(
    () =>
      movePathTool.execute(
        { fromPath: "Notes/draft.md", toPath: "Notes/REPORT.md" },
        vault.context,
      ),
    /differs only in letter case/u,
  );
});

function createMockVault(files: readonly string[]): {
  context: ToolExecutionContext;
  content: Map<string, string>;
  operations: string[];
} {
  const content = new Map<string, string>(
    files.map((path) => [path, "existing content"]),
  );
  const folders = new Set<string>();
  for (const path of files) {
    const segments = path.split("/").slice(0, -1);
    for (let index = 0; index < segments.length; index += 1) {
      folders.add(segments.slice(0, index + 1).join("/"));
    }
  }
  const operations: string[] = [];
  const getFile = (path: string) =>
    content.has(path)
      ? {
          path,
          basename: path.split("/").pop()?.replace(/\.md$/iu, "") ?? path,
          extension: "md",
        }
      : null;
  const getFolder = (path: string) => (folders.has(path) ? { path } : null);

  const context = {
    app: {
      workspace: { getActiveFile: () => null },
      vault: {
        read: async (file: { path: string }) => content.get(file.path) ?? "",
        create: async (path: string, data: string) => {
          operations.push(`create:${path}`);
          content.set(path, data);
          return getFile(path)!;
        },
        createFolder: async (path: string) => {
          operations.push(`createFolder:${path}`);
          folders.add(path);
        },
        rename: async (file: { path: string }, toPath: string) => {
          operations.push(`rename:${file.path}:${toPath}`);
          const data = content.get(file.path) ?? "";
          content.delete(file.path);
          content.set(toPath, data);
        },
        getFileByPath: getFile,
        getFolderByPath: getFolder,
        getAbstractFileByPath: (path: string) => getFile(path) ?? getFolder(path),
        getAllLoadedFiles: () => [
          ...[...folders].map((path) => ({ path })),
          ...[...content.keys()].map((path) => getFile(path)!),
        ],
      },
      fileManager: {
        renameFile: async (file: { path: string }, toPath: string) => {
          operations.push(`rename:${file.path}:${toPath}`);
          const data = content.get(file.path) ?? "";
          content.delete(file.path);
          content.set(toPath, data);
        },
      },
    },
    settings: {
      templateFolder: "Templates",
      templateOutputFolder: "",
      researchMemoryEnabled: true,
      researchMemoryFolder: "Agent Research Memory",
      semanticIndexFolder: "Agent Memory",
      requestTimeoutMs: 60_000,
    },
    originalPrompt:
      "Create a new note at Notes/Report.md and move files as needed.",
    httpTransport: async () => ({ status: 500, headers: {}, json: {} }),
    now: () => new Date(123),
  } as unknown as ToolExecutionContext;

  return { context, content, operations };
}
