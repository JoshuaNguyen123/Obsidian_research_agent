import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_TEMPLATE_FOLDER,
  DEFAULT_AGENT_TEMPLATE_SEEDS,
  LINEAR_ISSUE_TEMPLATE_PATH,
  ensureAgentTemplateLibrary,
  getAgentTemplateLibraryErrorCode,
} from "../src/tools/agentTemplateLibrary";

test("managed template library creates its folder and useful defaults", async () => {
  const mock = createVault();

  const result = await ensureAgentTemplateLibrary(mock.vault);

  assert.equal(result.folder, "Agent Work/templates");
  assert.deepEqual(result.createdTemplates.sort(), [
    "Agent Work/templates/Implementation plan.md",
    "Agent Work/templates/Linear issue.md",
    "Agent Work/templates/Project brief.md",
    "Agent Work/templates/Research brief.md",
    "Agent Work/templates/Validation checklist.md",
  ]);
  assert.deepEqual(result.skippedExisting, []);
  assert.ok(result.bytesWritten > 0);
  assert.ok(mock.folders.has("Agent Work"));
  assert.ok(mock.folders.has(AGENT_TEMPLATE_FOLDER));

  const linearTemplate = mock.files.get(LINEAR_ISSUE_TEMPLATE_PATH) ?? "";
  for (const section of [
    "# {{title}}",
    "## Problem / impact",
    "## Evidence / source links",
    "## Confidence / limitations",
    "## Proposed work",
    "## Non-goals",
    "## Scope",
    "## Dependencies",
    "## Acceptance criteria",
    "## Validation",
  ]) {
    assert.ok(linearTemplate.includes(section), `missing section: ${section}`);
  }
});

test("managed template library is idempotent and never overwrites customization", async () => {
  const mock = createVault();
  await ensureAgentTemplateLibrary(mock.vault);
  const customized = "# My private Linear issue format\n\n## Required context\n";
  mock.files.set(LINEAR_ISSUE_TEMPLATE_PATH, customized);
  mock.operations.length = 0;

  const result = await ensureAgentTemplateLibrary(mock.vault);

  assert.deepEqual(result.createdTemplates, []);
  assert.equal(
    result.skippedExisting.length,
    Object.keys(DEFAULT_AGENT_TEMPLATE_SEEDS).length,
  );
  assert.equal(mock.files.get(LINEAR_ISSUE_TEMPLATE_PATH), customized);
  assert.deepEqual(mock.operations, []);
});

test("managed template library repairs only missing defaults", async () => {
  const mock = createVault();
  await ensureAgentTemplateLibrary(mock.vault);
  const missingPath = "Agent Work/templates/Validation checklist.md";
  mock.files.delete(missingPath);
  mock.operations.length = 0;

  const result = await ensureAgentTemplateLibrary(mock.vault);

  assert.deepEqual(result.createdTemplates, [missingPath]);
  assert.equal(
    result.skippedExisting.length,
    Object.keys(DEFAULT_AGENT_TEMPLATE_SEEDS).length - 1,
  );
  assert.deepEqual(mock.operations, [`create:${missingPath}`]);
});

test("managed template library accepts an adapter-verified empty Agent Work folder", async () => {
  const mock = createVault();
  mock.folders.add("Agent Work");
  mock.unindexedFolders.add("Agent Work");

  const result = await ensureAgentTemplateLibrary(mock.vault);

  assert.equal(result.createdTemplates.length, 5);
  assert.ok(mock.folders.has(AGENT_TEMPLATE_FOLDER));
  assert.equal(mock.operations.includes("mkdir:Agent Work"), false);
});

test("managed template library fails closed on a folder path conflict", async () => {
  const mock = createVault();
  mock.files.set("Agent Work", "not a folder");

  await assert.rejects(
    () => ensureAgentTemplateLibrary(mock.vault),
    (error: unknown) => {
      assert.equal(getAgentTemplateLibraryErrorCode(error), "folder_path_conflict");
      assert.doesNotMatch(String(error), /not a folder/u);
      return true;
    },
  );
  assert.deepEqual(mock.operations, []);
});

function createVault() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const unindexedFolders = new Set<string>();
  const operations: string[] = [];
  const file = (path: string) => ({ path });
  const folder = (path: string) => ({ path, children: [] });
  const vault = {
    getAbstractFileByPath(path: string) {
      if (files.has(path)) return file(path);
      if (folders.has(path) && !unindexedFolders.has(path)) return folder(path);
      return null;
    },
    adapter: {
      async stat(path: string) {
        if (files.has(path)) return { type: "file" as const };
        if (folders.has(path)) return { type: "folder" as const };
        return null;
      },
    },
    async createFolder(path: string) {
      if (files.has(path) || folders.has(path)) throw new Error("path exists");
      folders.add(path);
      operations.push(`mkdir:${path}`);
    },
    async create(path: string, value: string) {
      if (files.has(path) || folders.has(path)) throw new Error("path exists");
      files.set(path, value);
      operations.push(`create:${path}`);
      return file(path);
    },
  };
  return { files, folders, unindexedFolders, operations, vault };
}
