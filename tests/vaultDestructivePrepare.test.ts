import assert from "node:assert/strict";
import test from "node:test";
import { verifyPreparedActionFingerprint } from "../src/agent/actions";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import { descriptorFor } from "../src/tools/toolDescriptors";
import type { ToolExecutionContext } from "../src/tools/types";
import {
  deleteCurrentFileTool,
  deletePathTool,
  replaceCurrentFileTool,
} from "../src/tools/vaultTools";

test("destructive vault descriptors require preparation with exact or double_exact approval", () => {
  for (const name of ["replace_current_file", "replace_file"] as const) {
    const descriptor = descriptorFor(name);
    assert.equal(descriptor.execution.preparation, "required");
    assert.equal(descriptor.approval.fallback, "exact");
    assert.equal(descriptor.capability.action, "replace");
  }
  for (const name of [
    "delete_current_file",
    "delete_path",
    "delete_research_memory_entry",
  ] as const) {
    const descriptor = descriptorFor(name);
    assert.equal(descriptor.execution.preparation, "required");
    assert.equal(descriptor.approval.fallback, "double_exact");
    assert.equal(descriptor.capability.action, "delete");
  }
});

test("raw execute is refused for destructive vault tools", async () => {
  const registry = createDefaultToolRegistry();
  const context = createVaultMockContext({
    prompt: "Replace this note and then delete the current note.",
  }).context;

  for (const name of [
    "replace_current_file",
    "delete_current_file",
    "delete_path",
  ] as const) {
    const result = await registry.execute(
      {
        name,
        arguments:
          name === "replace_current_file"
            ? { text: "Nope" }
            : name === "delete_path"
              ? { path: "Projects/example.md" }
              : {},
      },
      context,
    );
    assert.equal(result.ok, false, name);
    assert.equal(result.error?.code, "prepared_action_required", name);
    assert.equal(result.mutationState, "not_applied", name);
  }

  await assert.rejects(
    () => replaceCurrentFileTool.execute({ text: "Nope" }, context),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "prepared_action_required",
  );
  await assert.rejects(
    () => deleteCurrentFileTool.execute({}, context),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "prepared_action_required",
  );
  await assert.rejects(
    () =>
      deletePathTool.execute({ path: "Projects/example.md" }, context),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "prepared_action_required",
  );
});

test("prepare then approve then executePrepared works with fingerprint binding", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createVaultMockContext({
    prompt: "Replace this note with a clean brief.",
    now: new Date(123),
  });

  const prepared = await registry.prepare!(
    { name: "replace_current_file", arguments: { text: "Replacement" } },
    {
      ...mock.context,
      runId: "run-vault-1",
      operationId: "call-replace-1",
    },
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(await verifyPreparedActionFingerprint(prepared.action), true);
  assert.equal(prepared.action.payloadFingerprint.startsWith("sha256:"), true);
  assert.equal(mock.content.get("Current.md"), "Initial note");
  assert.equal(
    [...mock.content.keys()].some((path) => path.startsWith(".agent-backups/")),
    false,
  );

  const denied = await registry.executePrepared!(
    prepared.action,
    mock.context,
  );
  assert.equal(denied.error?.code, "authorization_required");
  assert.equal(mock.content.get("Current.md"), "Initial note");

  const mismatched = await registry.executePrepared!(
    prepared.action,
    mock.context,
    {
      preparedActionId: prepared.action.id,
      payloadFingerprint: "sha256:not-the-action",
      grantId: "grant-1",
    },
  );
  assert.equal(mismatched.error?.code, "authorization_mismatch");
  assert.equal(mock.content.get("Current.md"), "Initial note");

  const executed = await registry.executePrepared!(
    prepared.action,
    mock.context,
    {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "grant-1",
    },
  );
  assert.equal(executed.ok, true);
  assert.equal(executed.mutationState, "applied");
  assert.equal(executed.receipt?.payloadFingerprint, prepared.action.payloadFingerprint);
  assert.equal(executed.receipt?.grantId, "grant-1");
  assert.equal(executed.receipt?.operation, "replace");
  assert.deepEqual(executed.output, {
    path: "Current.md",
    backupPath: ".agent-backups/123-Current.md",
    bytesWritten: new TextEncoder().encode("Replacement").length,
  });
  assert.equal(mock.content.get("Current.md"), "Replacement");
  assert.equal(mock.content.get(".agent-backups/123-Current.md"), "Initial note");
});

test("delete_current_file prepare to executePrepared trashes after backup", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createVaultMockContext({
    prompt: "Delete the current note.",
    now: new Date(789),
  });

  const prepared = await registry.prepare!(
    { name: "delete_current_file", arguments: {} },
    {
      ...mock.context,
      runId: "run-vault-2",
      operationId: "call-delete-1",
    },
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(await verifyPreparedActionFingerprint(prepared.action), true);
  assert.equal(mock.content.has("Current.md"), true);

  const executed = await registry.executePrepared!(
    prepared.action,
    mock.context,
    {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "grant-delete",
    },
  );
  assert.equal(executed.ok, true);
  assert.equal(executed.receipt?.operation, "delete");
  assert.equal(mock.content.has("Current.md"), false);
  assert.equal(mock.content.get(".agent-backups/789-Current.md"), "Initial note");
  assert.deepEqual(executed.output, {
    path: "Current.md",
    operation: "trash",
    backupPath: ".agent-backups/789-Current.md",
    bytesDeleted: new TextEncoder().encode("Initial note").length,
  });
});

test("delete_path prepare to executePrepared uses fingerprint-bound trash", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createVaultMockContext({
    prompt: "Delete Projects/example.md from the vault.",
  });

  const prepared = await registry.prepare!(
    {
      name: "delete_path",
      arguments: { path: "Projects/example.md" },
    },
    {
      ...mock.context,
      runId: "run-vault-3",
      operationId: "call-delete-path-1",
    },
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(await verifyPreparedActionFingerprint(prepared.action), true);

  const executed = await registry.executePrepared!(
    prepared.action,
    mock.context,
    {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "grant-delete-path",
    },
  );
  assert.equal(executed.ok, true);
  assert.equal(mock.content.has("Projects/example.md"), false);
  assert.ok(mock.operations.includes("trash:Projects/example.md:false"));
  assert.equal(executed.receipt?.operation, "delete");
  assert.equal(executed.receipt?.payloadFingerprint, prepared.action.payloadFingerprint);
});

test("recursive delete rejects descendant content drift after approval", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createVaultMockContext({
    prompt: "Delete Projects recursively from the vault.",
  });
  mock.content.set("Projects/second.md", "Second project note");

  const prepared = await registry.prepare!(
    {
      name: "delete_path",
      arguments: { path: "Projects", recursive: true },
    },
    {
      ...mock.context,
      runId: "run-vault-recursive",
      operationId: "call-delete-projects",
    },
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  mock.content.set("Projects/second.md", "Changed after approval");
  const executed = await registry.executePrepared!(
    prepared.action,
    mock.context,
    {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "grant-delete-projects",
    },
  );

  assert.equal(executed.ok, false);
  assert.equal(executed.error?.code, "vault_precondition_changed");
  assert.equal(mock.content.has("Projects/example.md"), true);
  assert.equal(mock.content.has("Projects/second.md"), true);
  assert.equal(mock.operations.some((entry) => entry.startsWith("trash:Projects:")), false);
});

function createVaultMockContext(options: {
  prompt?: string;
  now?: Date;
} = {}): {
  context: ToolExecutionContext;
  content: Map<string, string>;
  operations: string[];
} {
  const content = new Map<string, string>([
    ["Current.md", "Initial note"],
    ["Projects/example.md", "Project note"],
  ]);
  const folders = new Set<string>(["Projects"]);
  const operations: string[] = [];
  const getFile = (path: string) => {
    if (!content.has(path)) return null;
    return {
      path,
      basename: path.split("/").pop()?.replace(/\.md$/i, "") ?? path,
      extension: "md",
    };
  };
  const getFolder = (path: string) =>
    folders.has(path) ? { path } : null;

  const context: ToolExecutionContext = {
    app: {
      workspace: {
        getActiveFile: () => getFile("Current.md"),
      },
      vault: {
        read: async (file: { path: string }) => content.get(file.path) ?? "",
        modify: async (file: { path: string }, data: string) => {
          operations.push(`modify:${file.path}`);
          content.set(file.path, data);
        },
        create: async (path: string, data: string) => {
          operations.push(`create:${path}`);
          content.set(path, data);
          return getFile(path)!;
        },
        createFolder: async (path: string) => {
          operations.push(`createFolder:${path}`);
          folders.add(path);
        },
        getFileByPath: getFile,
        getFolderByPath: getFolder,
        getAbstractFileByPath: (path: string) => getFile(path) ?? getFolder(path),
        getAllLoadedFiles: () => [
          ...[...folders].map((path) => ({ path })),
          ...[...content.keys()].map((path) => getFile(path)!),
        ],
        trash: async (target: { path: string }, system: boolean) => {
          operations.push(`trash:${target.path}:${system}`);
          content.delete(target.path);
          folders.delete(target.path);
        },
      },
    } as never,
    settings: {
      modelProvider: "ollama",
      ollamaApiKey: "test-key",
      ollamaBaseUrl: "https://ollama.com/api",
      openAiCompatibleApiKey: "",
      openAiCompatibleBaseUrl: "https://api.openai.com/v1",
      model: "gpt-oss:120b",
      enableStreaming: true,
      thinkingMode: "auto",
      streamWritebackMode: "all_current_note_content_writes",
      maxAgentSteps: 10,
      companionBaseUrl: "http://127.0.0.1:8765",
      browserToolsEnabled: false,
      experienceMemoryEnabled: false,
      defaultBrowserMissionMode: "supervised",
      agenticReflexEnabled: false,
      agenticReflexDiagnosticsEnabled: true,
      templateFolder: "Templates",
      templateOutputFolder: "",
      researchMemoryEnabled: true,
      researchMemoryFolder: "Agent Research Memory",
      semanticSearchEnabled: true,
      semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
      semanticEmbeddingDim: 512,
      semanticChunkMinTokens: 300,
      semanticChunkTargetTokens: 500,
      semanticChunkMaxTokens: 700,
      semanticChunkOverlapTokens: 80,
      semanticPythonCommand: "",
      semanticModelCacheDir: "",
      semanticIndexEnabled: true,
      semanticIndexFolder: "Agent Memory",
      semanticIndexDebounceMs: 3000,
      semanticIndexMaxFiles: 1000,
      semanticIndexPersistVectors: true,
      requestTimeoutMs: 60000,
      temperature: null,
      topK: null,
      topP: null,
      numCtx: null,
    } as never,
    originalPrompt: options.prompt ?? "Research this note.",
    httpTransport: async () => ({
      status: 500,
      headers: {},
      json: { error: "not mocked" },
    }),
    now: () => options.now ?? new Date(123),
  };

  return { context, content, operations };
}
