import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import { DEFAULT_TEMPLATE_SEEDS } from "../src/tools/vaultTools";
import { chunkMarkdownForSemanticSearch } from "../src/tools/semanticSearchTools";
import {
  createSemanticIndexService,
  shouldSemanticIndexTrackPath,
} from "../src/embeddings/semanticIndex";
import {
  BACKUP_FOLDER,
  DEFAULT_WEB_RESULTS,
  MAX_WEB_FETCH_CHARS,
  MAX_WEB_SEARCH_SNIPPET_CHARS,
} from "../src/tools/constants";
import type { ResearchMemoryIndexEntry, ToolExecutionContext, ToolExecutionResult, ToolRegistry } from "../src/tools/types";

async function executeAuthorizedPrepared(
  registry: ToolRegistry,
  call: { name: string; arguments: Record<string, unknown> },
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const prepared = await registry.prepare!(call, {
    ...context,
    runId: context.runId ?? `test-run-${call.name}`,
    operationId: context.operationId ?? `test-op-${call.name}-${Date.now()}`,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      toolName: call.name,
      mutationState: "not_applied",
      error: prepared.error,
    };
  }
  return registry.executePrepared!(prepared.action, context, {
    preparedActionId: prepared.action.id,
    payloadFingerprint: prepared.action.payloadFingerprint,
    grantId: "test-grant",
  });
}

test("registry exposes tool definitions and rejects unknown tools", async () => {
  const registry = createDefaultToolRegistry();
  const definitions = registry.getDefinitions();

  assert.ok(definitions.some((tool) => tool.function.name === "read_current_file"));
  assert.ok(definitions.some((tool) => tool.function.name === "list_folder"));
  assert.ok(definitions.some((tool) => tool.function.name === "search_markdown_files"));
  assert.ok(definitions.some((tool) => tool.function.name === "semantic_search_notes"));
  assert.ok(definitions.some((tool) => tool.function.name === "inspect_semantic_index"));
  assert.ok(definitions.some((tool) => tool.function.name === "rebuild_semantic_index"));
  assert.ok(definitions.some((tool) => tool.function.name === "read_markdown_files"));
  assert.ok(definitions.some((tool) => tool.function.name === "inspect_vault_context"));
  assert.ok(definitions.some((tool) => tool.function.name === "count_words"));
  assert.ok(definitions.some((tool) => tool.function.name === "get_note_graph_context"));
  assert.ok(definitions.some((tool) => tool.function.name === "find_related_notes"));
  assert.ok(definitions.some((tool) => tool.function.name === "suggest_note_links"));
  assert.ok(
    definitions.some(
      (tool) => tool.function.name === "link_related_notes_in_current_file",
    ),
  );
  assert.ok(definitions.some((tool) => tool.function.name === "list_templates"));
  assert.ok(definitions.some((tool) => tool.function.name === "read_template"));
  assert.ok(definitions.some((tool) => tool.function.name === "seed_default_templates"));
  assert.ok(definitions.some((tool) => tool.function.name === "create_template"));
  assert.ok(definitions.some((tool) => tool.function.name === "fill_template"));
  assert.ok(definitions.some((tool) => tool.function.name === "search_research_memory"));
  assert.ok(definitions.some((tool) => tool.function.name === "read_research_memory"));
  assert.ok(definitions.some((tool) => tool.function.name === "append_research_memory"));
  assert.ok(definitions.some((tool) => tool.function.name === "review_research_memory"));
  assert.ok(definitions.some((tool) => tool.function.name === "compact_research_memory"));
  assert.ok(definitions.some((tool) => tool.function.name === "delete_research_memory_entry"));
  assert.ok(definitions.some((tool) => tool.function.name === "append_to_current_section"));
  assert.ok(definitions.some((tool) => tool.function.name === "highlight_current_file_phrase"));
  assert.ok(definitions.some((tool) => tool.function.name === "restore_current_file_from_backup"));
  assert.ok(definitions.some((tool) => tool.function.name === "create_file"));

  const result = await registry.execute(
    { name: "missing_tool", arguments: {} },
    createMockContext().context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "unknown_tool");
});

test("companion browser tool stays blocked when browser setting is disabled", async () => {
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    {
      name: "browser_open_page",
      arguments: { url: "https://example.com" },
    },
    createMockContext({
      settings: {
        browserToolsEnabled: false,
        experienceMemoryEnabled: false,
      },
    }).context,
  );

  assert.equal(result.ok, true);
  assert.equal((result.output as { status?: string }).status, "blocked");
  assert.match(
    String((result.output as { reason?: string }).reason),
    /Browser tools are disabled/i,
  );
});

test("companion memory tools stay blocked when disabled or unhealthy", async () => {
  const registry = createDefaultToolRegistry();
  const disabled = await registry.execute(
    {
      name: "memory_search",
      arguments: { query: "workflow" },
    },
    createMockContext({
      settings: {
        experienceMemoryEnabled: false,
      },
    }).context,
  );

  assert.equal(disabled.ok, true);
  assert.equal((disabled.output as { status?: string }).status, "blocked");
  assert.match(
    String((disabled.output as { reason?: string }).reason),
    /Experience memory is disabled/i,
  );

  const unhealthy = await registry.execute(
    {
      name: "memory_search",
      arguments: { query: "workflow" },
    },
    createMockContext({
      settings: {
        experienceMemoryEnabled: true,
        companionBaseUrl: "http://127.0.0.1:1",
      },
    }).context,
  );

  assert.equal(unhealthy.ok, true);
  assert.equal((unhealthy.output as { status?: string }).status, "blocked");
  assert.match(
    String((unhealthy.output as { reason?: string }).reason),
    /Companion memory service is unavailable/i,
  );
});

test("read_file rejects unsafe paths before vault access", async () => {
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    { name: "read_file", arguments: { path: "../secret.md" } },
    createMockContext().context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "unsafe_path");
});

test("read_current_file honors optional maxChars cap", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  mock.content.set("Current.md", "x".repeat(20));

  const result = await registry.execute(
    { name: "read_current_file", arguments: { maxChars: 10 } },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    path: "Current.md",
    content: `${"x".repeat(10)}\n\n[truncated]`,
  });
});

test("read_current_file uses plugin current page resolver and live editor text", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    activePath: null,
    currentMarkdownPath: "Current.md",
    liveContent: "Unsaved prompt from the open editor",
  });

  const result = await registry.execute(
    { name: "read_current_file", arguments: {} },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    path: "Current.md",
    content: "Unsaved prompt from the open editor",
  });
});

test("inspect_vault_context reads bounded notes outside the active folder", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({ activePath: "Projects/current.md" });
  mock.content.set("Projects/current.md", "Active note should be excluded.");
  mock.content.set("Projects/neighbor.md", "Neighbor should be excluded.");
  mock.content.set("People/Untitled.md", "People note details for the agent.");
  mock.content.set("Archive/Untitled.md", "Archive note details for the agent.");
  mock.content.set("Research/Long.md", "x".repeat(40));

  const result = await registry.execute(
    {
      name: "inspect_vault_context",
      arguments: {
        scope: "other_folders",
        maxFiles: 2,
        maxCharsPerFile: 8,
      },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    activeFile: { path: string; folder: string };
    selectedFiles: Array<{ path: string; folder: string }>;
    files: Array<{ path: string; content: string; truncated: boolean }>;
    skipped: Array<{ path: string; reason: string }>;
    truncated: boolean;
    limits: { maxFiles: number; maxCharsPerFile: number };
  };

  assert.equal(output.activeFile.path, "Projects/current.md");
  assert.equal(output.activeFile.folder, "Projects");
  assert.equal(output.limits.maxFiles, 2);
  assert.equal(output.limits.maxCharsPerFile, 8);
  assert.equal(output.files.length, 2);
  assert.ok(!output.selectedFiles.some((file) => file.path === "Projects/current.md"));
  assert.ok(!output.selectedFiles.some((file) => file.folder === "Projects"));
  assert.ok(output.files.every((file) => file.content.length <= 22));
  assert.equal(output.truncated, true);
  assert.ok(output.skipped.some((item) => item.reason === "file_limit_exceeded"));
});

test("inspect_vault_context targets folder basenames and descendants", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({ activePath: "Untitled/current.md" });
  mock.content.set("Untitled/current.md", "Active prompt should be excluded.");
  mock.content.set("Untitled/discovery.md", "Root untitled discovery.");
  mock.content.set("Untitled/Sub/deeper.md", "Nested untitled discovery.");
  mock.content.set("Research/Untitled/research.md", "Research untitled discovery.");
  mock.content.set("Untitled 1/one.md", "Second folder discovery.");
  mock.content.set("Unrelated/skip.md", "Should not be included.");

  const result = await registry.execute(
    {
      name: "inspect_vault_context",
      arguments: {
        scope: "all_vault",
        targetFolders: ["Untitled", "Untitled 1", "Missing Folder"],
      },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    targetFolders: {
      requested: string[];
      matched: Array<{ target: string; paths: string[] }>;
      unmatched: string[];
    };
    selectedFiles: Array<{ path: string; folder: string }>;
  };
  const selectedPaths = output.selectedFiles.map((file) => file.path);

  assert.deepEqual(output.targetFolders.requested, [
    "Untitled",
    "Untitled 1",
    "Missing Folder",
  ]);
  assert.ok(selectedPaths.includes("Untitled/discovery.md"));
  assert.ok(selectedPaths.includes("Untitled/Sub/deeper.md"));
  assert.ok(selectedPaths.includes("Research/Untitled/research.md"));
  assert.ok(selectedPaths.includes("Untitled 1/one.md"));
  assert.ok(!selectedPaths.includes("Untitled/current.md"));
  assert.ok(!selectedPaths.includes("Unrelated/skip.md"));
  assert.ok(
    output.targetFolders.matched.some(
      (item) => item.target === "Untitled" && item.paths.includes("Untitled/Sub"),
    ),
  );
  assert.deepEqual(output.targetFolders.unmatched, ["Missing Folder"]);
});

test("inspect_vault_context prioritizes recent files for targeted folders", async () => {
  const registry = createDefaultToolRegistry();
  const oldStats: Record<string, { mtime: number }> = {};

  for (let index = 0; index < 12; index += 1) {
    oldStats[`Untitled/old-${index}.md`] = { mtime: index + 1 };
  }

  const mock = createMockContext({
    activePath: "Current.md",
    fileStats: {
      ...oldStats,
      "Untitled/recent.md": { mtime: 100 },
      "Untitled 1/recent.md": { mtime: 101 },
      "Untitled 2/recent.md": { mtime: 102 },
    },
  });

  for (const path of Object.keys(oldStats)) {
    mock.content.set(path, `Old content for ${path}`);
  }
  mock.content.set("Untitled/recent.md", "Fresh folder one.");
  mock.content.set("Untitled 1/recent.md", "Fresh folder two.");
  mock.content.set("Untitled 2/recent.md", "Fresh folder three.");

  const result = await registry.execute(
    {
      name: "inspect_vault_context",
      arguments: {
        scope: "all_vault",
        targetFolders: ["Untitled", "Untitled 1", "Untitled 2"],
        maxFiles: 3,
      },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    selectedFiles: Array<{ path: string }>;
    skipped: Array<{ path: string; reason: string }>;
  };

  assert.deepEqual(
    output.selectedFiles.map((file) => file.path),
    ["Untitled 2/recent.md", "Untitled 1/recent.md", "Untitled/recent.md"],
  );
  assert.ok(
    output.skipped.some(
      (item) =>
        item.path === "Untitled/old-11.md" &&
        item.reason === "file_limit_exceeded",
    ),
  );
});

test("inspect_vault_context targets exact folder paths and rejects unsafe targets", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  mock.content.set("Untitled/root.md", "Root folder.");
  mock.content.set("Research/Untitled/research.md", "Nested folder.");

  const exact = await registry.execute(
    {
      name: "inspect_vault_context",
      arguments: {
        scope: "all_vault",
        targetFolders: ["Research/Untitled"],
      },
    },
    mock.context,
  );

  assert.equal(exact.ok, true);
  const output = exact.output as {
    selectedFiles: Array<{ path: string }>;
    targetFolders: { matched: Array<{ target: string; paths: string[] }> };
  };
  assert.deepEqual(
    output.selectedFiles.map((file) => file.path),
    ["Research/Untitled/research.md"],
  );
  assert.deepEqual(output.targetFolders.matched, [
    { target: "Research/Untitled", paths: ["Research/Untitled"] },
  ]);

  const unsafe = await registry.execute(
    {
      name: "inspect_vault_context",
      arguments: {
        targetFolders: ["../Secrets"],
      },
    },
    mock.context,
  );

  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error?.code, "unsafe_path");
});

test("list_folder traverses vault folders with depth, caps, and markdown filtering", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  mock.content.set("Projects/Nested/deep.md", "Deep note");
  mock.content.set("Projects/diagram.png", "image");

  const root = await registry.execute(
    { name: "list_folder", arguments: { path: "", recursive: false } },
    mock.context,
  );
  assert.equal(root.ok, true);
  assert.deepEqual(
    (root.output as { entries: Array<{ path: string }> }).entries.map(
      (entry) => entry.path,
    ),
    ["Current.md", "Projects"],
  );

  const nested = await registry.execute(
    {
      name: "list_folder",
      arguments: {
        path: "Projects",
        recursive: true,
        markdownOnly: true,
        maxDepth: 3,
        limit: 10,
      },
    },
    mock.context,
  );
  assert.equal(nested.ok, true);
  assert.deepEqual(
    (nested.output as { entries: Array<{ path: string }> }).entries.map(
      (entry) => entry.path,
    ),
    ["Projects/example.md", "Projects/Nested", "Projects/Nested/deep.md"],
  );
});

test("list_current_folder reports active note siblings and parent folder", async () => {
  const registry = createDefaultToolRegistry();
  const rootMock = createMockContext();

  const root = await registry.execute(
    { name: "list_current_folder", arguments: { markdownOnly: true } },
    rootMock.context,
  );
  assert.equal(root.ok, true);
  assert.deepEqual(
    (root.output as { activeFile: { path: string } }).activeFile.path,
    "Current.md",
  );
  assert.deepEqual(
    (root.output as { currentFolder: { path: string } }).currentFolder.path,
    "",
  );
  assert.equal((root.output as { parentFolder: unknown }).parentFolder, null);
  assert.deepEqual(
    (root.output as { entries: Array<{ path: string }> }).entries.map(
      (entry) => entry.path,
    ),
    ["Current.md", "Projects"],
  );

  const nestedMock = createMockContext({
    activePath: "Projects/Nested/Active.md",
  });
  nestedMock.content.set("Projects/Nested/Sibling.md", "Sibling");
  nestedMock.content.set("Projects/Nested/image.png", "Image");
  const nested = await registry.execute(
    {
      name: "list_current_folder",
      arguments: { recursive: false, markdownOnly: true, limit: 10 },
    },
    nestedMock.context,
  );

  assert.equal(nested.ok, true);
  assert.deepEqual(
    (nested.output as { currentFolder: { path: string } }).currentFolder.path,
    "Projects/Nested",
  );
  assert.deepEqual(
    (nested.output as { parentFolder: { path: string } }).parentFolder.path,
    "Projects",
  );
  assert.deepEqual(
    (nested.output as { entries: Array<{ path: string }> }).entries.map(
      (entry) => entry.path,
    ),
    ["Projects/Nested/Active.md", "Projects/Nested/Sibling.md"],
  );

  const blocked = await registry.execute(
    { name: "list_current_folder", arguments: {} },
    createMockContext({ activePath: ".agent-backups/Old.md" }).context,
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.error?.message ?? "", /not available/);
});

test("read_markdown_files reads safe markdown files and reports skipped paths", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  mock.content.set("People/Untitled.md", "Alex likes local AI tools.");
  mock.content.set("Archive/Untitled.md", "x".repeat(30));
  mock.content.set("Projects/image.png", "binary");

  const result = await registry.execute(
    {
      name: "read_markdown_files",
      arguments: {
        paths: [
          "People/Untitled.md",
          "Archive/Untitled.md",
          "Projects/image.png",
          "../secret.md",
          ".obsidian/config.md",
          "Missing.md",
        ],
        maxCharsPerFile: 10,
      },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    requestedCount: number;
    returnedCount: number;
    files: Array<{ path: string; content: string; truncated: boolean }>;
    skipped: Array<{ path: string; reason: string }>;
  };
  assert.equal(output.requestedCount, 6);
  assert.equal(output.returnedCount, 2);
  assert.deepEqual(
    output.files.map((file) => file.path),
    ["People/Untitled.md", "Archive/Untitled.md"],
  );
  assert.equal(output.files[1].content, `${"x".repeat(10)}\n\n[truncated]`);
  assert.equal(output.files[1].truncated, true);
  assert.ok(output.skipped.some((item) => item.path === "Projects/image.png"));
  assert.ok(output.skipped.some((item) => item.path === "../secret.md"));
  assert.ok(output.skipped.some((item) => item.path === ".obsidian/config.md"));
  assert.ok(output.skipped.some((item) => item.path === "Missing.md"));
});

test("search_markdown_files finds content in untitled notes and skips system folders", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  mock.content.set("People/Untitled.md", "Alex likes local AI tools. Alex uses Obsidian.");
  mock.content.set("Projects/Untitled.md", "The agent should trace every action.");
  mock.content.set(".agent-backups/Untitled.md", "Alex hidden backup match.");
  mock.content.set(".trash/Untitled.md", "Alex trashed match.");

  const result = await registry.execute(
    {
      name: "search_markdown_files",
      arguments: { query: "Alex", limit: 10, maxSnippetChars: 120 },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    results: Array<{
      path: string;
      basename: string;
      matchCount: number;
      snippet: string;
    }>;
    truncated: boolean;
  };
  assert.equal(output.truncated, false);
  assert.deepEqual(
    output.results.map((item) => item.path),
    ["People/Untitled.md"],
  );
  assert.equal(output.results[0].basename, "Untitled");
  assert.equal(output.results[0].matchCount, 2);
  assert.match(output.results[0].snippet, /local AI tools/);
});

test("search_markdown_files validates query and result limits", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  mock.content.set("A/Untitled.md", "match");
  mock.content.set("B/Untitled.md", "match");

  const empty = await registry.execute(
    { name: "search_markdown_files", arguments: { query: "   " } },
    mock.context,
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.error?.code, "invalid_arguments");

  const limited = await registry.execute(
    {
      name: "search_markdown_files",
      arguments: { query: "match", limit: 1 },
    },
    mock.context,
  );
  assert.equal(limited.ok, true);
  const output = limited.output as {
    results: Array<{ path: string }>;
    truncated: boolean;
  };
  assert.equal(output.results.length, 1);
  assert.equal(output.truncated, true);
});

test("semantic_search_notes rejects empty query and unsafe folders", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();

  const empty = await registry.execute(
    { name: "semantic_search_notes", arguments: { query: "   " } },
    mock.context,
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.error?.code, "invalid_arguments");

  const unsafe = await registry.execute(
    {
      name: "semantic_search_notes",
      arguments: { query: "local AI", folder: "../secret" },
    },
    mock.context,
  );
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error?.code, "unsafe_path");
});

test("semantic search chunking keeps bounded heading-aware chunks", () => {
  const paragraphs = Array.from({ length: 8 }, (_, index) => {
    const words = Array.from({ length: 90 }, (__, wordIndex) =>
      `token${index}_${wordIndex}`,
    );
    return words.join(" ");
  });
  const chunks = chunkMarkdownForSemanticSearch(`# Ritual Kingship\n\n${paragraphs.join("\n\n")}`, {
    minTokens: 300,
    targetTokens: 500,
    maxTokens: 700,
    overlapTokens: 80,
  });

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.tokenCount <= 700));
  assert.ok(chunks.some((chunk) => chunk.tokenCount >= 300));
  assert.equal(chunks[0].heading, "Ritual Kingship");
});

test("semantic_search_notes ranks semantic matches above lexical distractors", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  mock.content.set(
    "Research/Gilgamesh.md",
    "# Gilgamesh\n\nA flood myth about kingship, ritual duty, grief, and divine limits.",
  );
  mock.content.set(
    "Research/Keyword.md",
    "# Keyword\n\nThis note repeats the exact query words but is a shallow placeholder: sacred monarchy deluge story.",
  );
  mock.context.semanticEmbeddingProvider = {
    async embed(request) {
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        queries: [[1, 0]],
        documents: request.documents.map((document) =>
          document.includes("Gilgamesh") ? [1, 0] : [0.2, 0.8],
        ),
      };
    },
  };

  const result = await registry.execute(
    {
      name: "semantic_search_notes",
      arguments: {
        query: "sacred monarchy deluge story",
        limit: 2,
        maxSnippetChars: 200,
      },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    fallbackUsed: boolean;
    results: Array<{ path: string; reasons: string[]; semanticScore: number }>;
  };
  assert.equal(output.fallbackUsed, false);
  assert.equal(output.results[0].path, "Research/Gilgamesh.md");
  assert.ok(output.results[0].reasons.includes("semantic_similarity"));
  assert.ok(output.results[0].semanticScore > 0.9);
});

test("semantic_search_notes falls back to lexical search when embedding fails", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  mock.content.set("People/Untitled.md", "Alex likes local AI tools in Obsidian.");
  mock.context.semanticEmbeddingProvider = {
    async embed(request) {
      return {
        ok: false,
        model: request.model,
        dim: request.dim,
        code: "missing_fastembed",
        message: "Install FastEmbed with: python -m pip install fastembed",
      };
    },
  };

  const result = await registry.execute(
    {
      name: "semantic_search_notes",
      arguments: { query: "Alex local AI", limit: 5 },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    fallbackUsed: boolean;
    fallbackReason: string;
    results: Array<{ path: string; lexicalScore: number }>;
  };
  assert.equal(output.fallbackUsed, true);
  assert.equal(output.fallbackReason, "missing_fastembed");
  assert.equal(output.results[0].path, "People/Untitled.md");
  assert.ok(output.results[0].lexicalScore > 0);
});

test("semantic_search_notes uses a fresh semantic index before live embedding", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  let liveEmbeddingCalled = false;
  mock.context.semanticEmbeddingProvider = {
    async embed() {
      liveEmbeddingCalled = true;
      return {
        ok: false,
        model: "test",
        dim: 512,
        code: "should_not_call_live_embedding",
        message: "unexpected",
      };
    },
  };
  mock.context.semanticIndexService = {
    async load() {
      return null;
    },
    async rebuild() {
      throw new Error("not used");
    },
    async updatePaths() {
      throw new Error("not used");
    },
    async removePaths() {
      return undefined;
    },
    async search() {
      return {
        ok: true,
        operation: "semantic_index_search",
        mode: "indexed_semantic",
        indexUsed: true,
        indexFresh: true,
        model: "nomic-ai/nomic-embed-text-v1.5-Q",
        dim: 512,
        indexedAt: "2026-07-05T00:00:00.000Z",
        resultCount: 1,
        results: [
          {
            path: "Research/Semantic.md",
            title: "Semantic",
            score: 0.91,
            semanticScore: 0.9,
            lexicalScore: 0.1,
            reasons: ["indexed_semantic_similarity"],
            heading: "Local Embeddings",
            snippet: "Local semantic index evidence.",
          },
        ],
      };
    },
  };

  const result = await registry.execute(
    {
      name: "semantic_search_notes",
      arguments: { query: "local embeddings" },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    mode: string;
    indexUsed: boolean;
    results: Array<{ path: string; reasons: string[]; vector?: unknown }>;
  };
  assert.equal(output.mode, "indexed_semantic");
  assert.equal(output.indexUsed, true);
  assert.equal(output.results[0].path, "Research/Semantic.md");
  assert.equal(output.results[0].vector, undefined);
  assert.equal(liveEmbeddingCalled, false);
});

test("semantic index service rebuild writes v2 sharded vectors and vector-free markdown", async () => {
  const mock = createMockContext({
    fileStats: {
      "Research/Semantic.md": { mtime: 10, size: 120 },
      "Agent Runs/old.md": { mtime: 20, size: 50 },
      "Agent Memory/Semantic Vault Index.md": { mtime: 30, size: 50 },
    },
  });
  mock.content.delete("Current.md");
  mock.content.delete("Projects/example.md");
  mock.content.set(
    "Research/Semantic.md",
    "# Local Embeddings\n\nFastEmbed semantic retrieval with #ai and [[Search]].",
  );
  mock.content.set("Agent Runs/old.md", "# Old Run\n\nShould be skipped.");
  mock.content.set(
    "Agent Memory/Semantic Vault Index.md",
    "# Existing self index\n\nShould be skipped.",
  );
  mock.folders.add("Research");
  mock.folders.add("Agent Memory");
  mock.context.semanticEmbeddingProvider = {
    async embed(request) {
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map(() =>
          Array.from({ length: request.dim }, (_, index) =>
            index === 0 ? 1 : 0,
          ),
        ),
        queries: request.queries.map(() =>
          Array.from({ length: request.dim }, (_, index) =>
            index === 0 ? 1 : 0,
          ),
        ),
      };
    },
  };
  const service = createSemanticIndexService({
    app: mock.context.app,
    getSettings: () => mock.context.settings,
    getEmbeddingProvider: () => mock.context.semanticEmbeddingProvider!,
    now: () => new Date("2026-07-05T00:00:00.000Z"),
  });

  const result = await service.rebuild();

  assert.equal(result.ok, true);
  assert.equal(result.noteCount, 1);
  const json = JSON.parse(
    mock.content.get("Agent Memory/semantic-vault-index.json") ?? "{}",
  ) as {
    version: number;
    notes: Array<{ path: string; chunkCount: number; firstSnippet: string; chunks?: unknown }>;
    shards: Array<{ path: string; rowCount: number; vectorEncoding: string }>;
    totalRows: number;
  };
  assert.equal(json.version, 2);
  assert.equal(json.notes[0].path, "Research/Semantic.md");
  assert.equal(json.notes[0].chunkCount, 1);
  assert.equal(json.notes[0].chunks, undefined);
  assert.equal(json.totalRows, 1);
  assert.equal(json.shards[0].rowCount, 1);
  assert.equal(json.shards[0].vectorEncoding, "float32-base64");
  const shard = JSON.parse(mock.content.get(json.shards[0].path) ?? "{}") as {
    rows: unknown[];
    vectorsBase64?: string;
  };
  assert.equal(shard.rows.length, 1);
  assert.equal(typeof shard.vectorsBase64, "string");
  assert.ok((shard.vectorsBase64 ?? "").length > 0);
  const markdown = mock.content.get("Agent Memory/Semantic Vault Index.md") ?? "";
  assert.match(markdown, /# Semantic Vault Index/);
  assert.match(markdown, /Research\/Semantic\.md/);
  assert.doesNotMatch(markdown, /"vector"/);
  assert.doesNotMatch(markdown, /Agent Runs\/old\.md/);

  const search = await service.search({
    query: "local embeddings",
    limit: 1,
    mode: "deep",
    candidateLimit: 16,
  });
  assert.equal(search.ok, true);
  assert.equal(search.results[0].path, "Research/Semantic.md");
});

test("semantic index v2 updates only changed notes and removes paths without a full re-embed", async () => {
  const mock = createMockContext();
  mock.content.clear();
  mock.content.set("Research/Changed.md", "# Changed\n\nInitial alpha evidence.");
  mock.content.set("Research/Stable.md", "# Stable\n\nStable beta evidence.");
  mock.folders.add("Research");
  const documentBatchSizes: number[] = [];
  mock.context.semanticEmbeddingProvider = {
    async embed(request) {
      if (request.documents.length > 0) {
        documentBatchSizes.push(request.documents.length);
      }
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map((_document, documentIndex) =>
          Array.from({ length: request.dim }, (_value, index) =>
            index === documentIndex % 2 ? 1 : 0,
          ),
        ),
        queries: request.queries.map(() =>
          Array.from({ length: request.dim }, (_value, index) =>
            index === 0 ? 1 : 0,
          ),
        ),
      };
    },
  };
  const service = createSemanticIndexService({
    app: mock.context.app,
    getSettings: () => mock.context.settings,
    getEmbeddingProvider: () => mock.context.semanticEmbeddingProvider!,
    now: () => new Date("2026-07-10T00:00:00.000Z"),
  });

  assert.equal((await service.rebuild()).ok, true);
  documentBatchSizes.splice(0, documentBatchSizes.length);
  mock.content.set(
    "Research/Changed.md",
    "# Changed\n\nUpdated alpha evidence with a new conclusion.",
  );
  const update = await service.updatePaths(["Research/Changed.md"]);

  assert.equal(update.ok, true);
  assert.deepEqual(update.updatedPaths, ["Research/Changed.md"]);
  assert.deepEqual(documentBatchSizes, [1]);
  const updatedIndex = await service.load();
  assert.deepEqual(
    updatedIndex?.notes.map((note) => note.path),
    ["Research/Changed.md", "Research/Stable.md"],
  );

  documentBatchSizes.splice(0, documentBatchSizes.length);
  mock.content.delete("Research/Stable.md");
  await service.removePaths(["Research/Stable.md"]);
  const removedIndex = await service.load();
  assert.deepEqual(removedIndex?.notes.map((note) => note.path), ["Research/Changed.md"]);
  assert.deepEqual(documentBatchSizes, []);
});

test("semantic index excludes unsafe, system, and self paths", () => {
  const settings = createMockContext().context.settings;

  assert.equal(shouldSemanticIndexTrackPath("Research/Semantic.md", settings), true);
  assert.equal(shouldSemanticIndexTrackPath("../Secret.md", settings), false);
  assert.equal(
    shouldSemanticIndexTrackPath("C:/Users/example/Secret.md", settings),
    false,
  );
  assert.equal(shouldSemanticIndexTrackPath("Research\\Semantic.md", settings), false);
  assert.equal(shouldSemanticIndexTrackPath(".agent-backups/Old.md", settings), false);
  assert.equal(shouldSemanticIndexTrackPath("Agent Runs/Run.md", settings), false);
  assert.equal(
    shouldSemanticIndexTrackPath("Agent Memory/Semantic Vault Index.md", settings),
    false,
  );
  assert.equal(
    shouldSemanticIndexTrackPath("Agent Memory/semantic-vault-index.json", settings),
    false,
  );
});

test("rebuild_semantic_index delegates to the semantic index service", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  let called = false;
  mock.context.semanticIndexService = {
    async load() {
      return null;
    },
    async rebuild() {
      called = true;
      return {
        ok: true,
        operation: "semantic_index_rebuild",
        markdownPath: "Agent Memory/Semantic Vault Index.md",
        jsonPath: "Agent Memory/semantic-vault-index.json",
        indexedAt: "2026-07-05T00:00:00.000Z",
        noteCount: 0,
        chunkCount: 0,
        updatedPaths: [],
        removedPaths: [],
        skippedPaths: [],
      };
    },
    async updatePaths() {
      throw new Error("not used");
    },
    async removePaths() {
      return undefined;
    },
    async search() {
      throw new Error("not used");
    },
  };

  const result = await registry.execute(
    { name: "rebuild_semantic_index", arguments: {} },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(called, true);
});

test("get_path_info reports files, folders, and missing paths", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();

  const folder = await registry.execute(
    { name: "get_path_info", arguments: { path: "Projects" } },
    mock.context,
  );
  assert.equal(folder.ok, true);
  assert.deepEqual(folder.output, {
    path: "Projects",
    exists: true,
    type: "folder",
    basename: "Projects",
    extension: undefined,
    markdown: false,
    childCount: 1,
    supportedRead: true,
    supportedWrite: true,
  });

  const file = await registry.execute(
    { name: "get_path_info", arguments: { path: "Projects/example.md" } },
    mock.context,
  );
  assert.equal(file.ok, true);
  assert.deepEqual(file.output, {
    path: "Projects/example.md",
    exists: true,
    type: "file",
    basename: "example",
    extension: "md",
    markdown: true,
    childCount: undefined,
    supportedRead: true,
    supportedWrite: true,
  });

  const missing = await registry.execute(
    { name: "get_path_info", arguments: { path: "Projects/missing.md" } },
    mock.context,
  );
  assert.deepEqual(missing.output, {
    path: "Projects/missing.md",
    exists: false,
  });
});

test("get_note_graph_context returns links, backlinks, unresolved links, tags, aliases, and headings", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  mock.content.set("Backlinks/source.md", "Links to [[Current]].");
  attachMetadataCache(mock, {
    resolvedLinks: {
      "Current.md": { "Projects/example.md": 1 },
      "Backlinks/source.md": { "Current.md": 1 },
    },
    unresolvedLinks: {
      "Current.md": { "Missing Note": 1 },
    },
    fileCaches: {
      "Current.md": {
        links: [{ link: "Projects/example" }],
        tags: [{ tag: "#agent" }],
        headings: [{ heading: "Current Heading", level: 1 }],
        frontmatter: { aliases: ["Home Base"] },
      },
    },
  });

  const result = await registry.execute(
    { name: "get_note_graph_context", arguments: {} },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    source: { path: string };
    aliases: string[];
    tags: string[];
    headings: Array<{ heading: string; level: number }>;
    outgoingLinks: Array<{ path: string; count: number }>;
    backlinks: Array<{ path: string; count: number }>;
    unresolvedLinks: Array<{ target: string; count: number }>;
  };
  assert.equal(output.source.path, "Current.md");
  assert.deepEqual(output.aliases, ["Home Base"]);
  assert.deepEqual(output.tags, ["agent"]);
  assert.deepEqual(output.headings, [{ heading: "Current Heading", level: 1 }]);
  assert.deepEqual(output.outgoingLinks, [
    { path: "Projects/example.md", basename: "example", count: 1, exists: true },
  ]);
  assert.deepEqual(output.backlinks, [
    { path: "Backlinks/source.md", basename: "source", count: 1, exists: true },
  ]);
  assert.deepEqual(output.unresolvedLinks, [{ target: "Missing Note", count: 1 }]);
});

test("find_related_notes ranks explicit graph links above semantic overlap", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext();
  mock.content.set(
    "Current.md",
    "# Local AI Research\n\nAgentic Obsidian research with source receipts.",
  );
  mock.content.set(
    "Projects/example.md",
    "# Agentic Obsidian\n\nA directly linked note about receipts.",
  );
  mock.content.set(
    "Research/semantic.md",
    "# Local AI Notes\n\nLocal AI research and Obsidian context.",
  );
  attachMetadataCache(mock, {
    resolvedLinks: {
      "Current.md": { "Projects/example.md": 1 },
    },
    fileCaches: {
      "Current.md": {
        links: [{ link: "Projects/example" }],
        tags: [{ tag: "#research" }],
      },
      "Projects/example.md": {
        tags: [{ tag: "#research" }],
      },
      "Research/semantic.md": {
        tags: [{ tag: "#research" }],
      },
    },
  });

  const result = await registry.execute(
    { name: "find_related_notes", arguments: { limit: 5 } },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    results: Array<{ path: string; reasons: string[]; score: number }>;
  };
  assert.equal(output.results[0].path, "Projects/example.md");
  assert.ok(output.results[0].reasons.includes("direct_link"));
  assert.ok(
    output.results.some(
      (item) =>
        item.path === "Research/semantic.md" &&
        item.reasons.includes("content_overlap"),
    ),
  );
});

test("link_related_notes_in_current_file inserts inline wiki links with a backup", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Connect this note to related notes with inline links.",
  });
  mock.content.set(
    "Current.md",
    "Related Note belongs here.\n\n`Related Note` should stay code.\n",
  );
  mock.content.set("Topics/Related Note.md", "# Related Note\n\nGraph target.");
  attachMetadataCache(mock, {});

  const result = await registry.execute(
    {
      name: "link_related_notes_in_current_file",
      arguments: { targetPaths: ["Topics/Related Note.md"] },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    changed: boolean;
    backupPath: string;
    insertedLinks: Array<{ targetPath: string; wikiLink: string }>;
  };
  assert.equal(output.changed, true);
  assert.match(output.backupPath, /^\.agent-backups\/123-Current\.md$/);
  assert.deepEqual(output.insertedLinks, [
    {
      targetPath: "Topics/Related Note.md",
      label: "Related Note",
      wikiLink: "[[Topics/Related Note|Related Note]]",
      reasons: ["content_overlap"],
    },
  ]);
  assert.equal(
    mock.content.get("Current.md"),
    "[[Topics/Related Note|Related Note]] belongs here.\n\n`Related Note` should stay code.\n",
  );
  assert.equal(mock.content.get(".agent-backups/123-Current.md")?.includes("Related Note belongs here."), true);
});

test("count_words counts active live editor content and safe markdown paths", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    currentMarkdownPath: "Current.md",
    liveContent:
      "---\ntitle: Hidden\n---\n# Visible Title\n\nThis note has **five** visible words.\n```js\nignored code words\n```",
  });
  mock.content.set("Projects/word-count.md", "One two three.");

  const active = await registry.execute(
    { name: "count_words", arguments: {} },
    mock.context,
  );
  assert.equal(active.ok, true);
  assert.deepEqual(active.output, {
    path: "Current.md",
    wordCount: 8,
    characterCount: 47,
    nonWhitespaceCharacterCount: 40,
    lineCount: 9,
    mode: "markdown_visible_text",
  });

  const byPath = await registry.execute(
    { name: "count_words", arguments: { path: "Projects/word-count.md" } },
    mock.context,
  );
  assert.equal(byPath.ok, true);
  assert.equal((byPath.output as { wordCount: number }).wordCount, 3);

  const unsafe = await registry.execute(
    { name: "count_words", arguments: { path: "../secret.md" } },
    mock.context,
  );
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error?.code, "unsafe_path");

  const nonMarkdown = await registry.execute(
    { name: "count_words", arguments: { path: "Projects/image.png" } },
    mock.context,
  );
  assert.equal(nonMarkdown.ok, false);
  assert.equal(nonMarkdown.error?.code, "unsafe_path");
});

test("path CRUD tools create, append, replace with backup, move, and trash markdown files", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt:
      "Create a folder and file, append to the file, replace the file, rename the file, then delete Projects/New/Renamed.md.",
    now: new Date(123),
  });

  const folder = await registry.execute(
    { name: "create_folder", arguments: { path: "Projects/New" } },
    mock.context,
  );
  assert.equal(folder.ok, true);
  assert.deepEqual(folder.output, {
    path: "Projects/New",
    operation: "create_folder",
    createdFolders: ["Projects/New"],
  });

  const created = await registry.execute(
    {
      name: "create_file",
      arguments: { path: "Projects/New/Brief.md", content: "# Brief" },
    },
    mock.context,
  );
  assert.equal(created.ok, true);
  assert.equal(mock.content.get("Projects/New/Brief.md"), "# Brief");

  const appended = await registry.execute(
    {
      name: "append_file",
      arguments: { path: "Projects/New/Brief.md", text: "Next" },
    },
    mock.context,
  );
  assert.equal(appended.ok, true);
  assert.equal(mock.content.get("Projects/New/Brief.md"), "# Brief\nNext");

  const replaced = await executeAuthorizedPrepared(
    registry,
    {
      name: "replace_file",
      arguments: { path: "Projects/New/Brief.md", text: "# Replacement" },
    },
    mock.context,
  );
  assert.equal(replaced.ok, true);
  assert.deepEqual(replaced.output, {
    path: "Projects/New/Brief.md",
    operation: "replace",
    backupPath: ".agent-backups/123-Brief.md",
    bytesWritten: new TextEncoder().encode("# Replacement").length,
  });
  assert.equal(mock.content.get(".agent-backups/123-Brief.md"), "# Brief\nNext");

  const moved = await registry.execute(
    {
      name: "move_path",
      arguments: {
        fromPath: "Projects/New/Brief.md",
        toPath: "Projects/New/Renamed.md",
      },
    },
    mock.context,
  );
  assert.equal(moved.ok, true);
  assert.equal(mock.content.has("Projects/New/Brief.md"), false);
  assert.equal(mock.content.get("Projects/New/Renamed.md"), "# Replacement");

  const trashed = await executeAuthorizedPrepared(
    registry,
    {
      name: "delete_path",
      arguments: { path: "Projects/New/Renamed.md" },
    },
    mock.context,
  );
  assert.equal(trashed.ok, true);
  assert.equal(mock.content.has("Projects/New/Renamed.md"), false);
  assert.ok(mock.operations.includes("trash:Projects/New/Renamed.md:false"));
});

test("template tools list, read, create, and fill saved templates", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt:
      "Create a reusable template and fill the meeting template into a new note.",
  });
  mock.content.set(
    "Templates/Meeting.md",
    "# {{title}}\n\nDate: {{date}}\nAttendees: {{attendees}}",
  );

  const listed = await registry.execute(
    {
      name: "list_templates",
      arguments: { includePlaceholders: true },
    },
    mock.context,
  );
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.output, {
    templateFolder: "Templates",
    templates: [
      {
        path: "Templates/Meeting.md",
        basename: "Meeting",
        placeholders: ["title", "date", "attendees"],
      },
    ],
    truncated: false,
  });

  const read = await registry.execute(
    { name: "read_template", arguments: { path: "Meeting.md" } },
    mock.context,
  );
  assert.equal(read.ok, true);
  assert.deepEqual(read.output, {
    path: "Templates/Meeting.md",
    content: "# {{title}}\n\nDate: {{date}}\nAttendees: {{attendees}}",
    placeholders: ["title", "date", "attendees"],
    truncated: false,
  });

  const created = await registry.execute(
    {
      name: "create_template",
      arguments: {
        path: "Daily.md",
        content: "# {{title}}\n\n- {{priority}}",
      },
    },
    mock.context,
  );
  assert.equal(created.ok, true);
  assert.equal(mock.content.get("Templates/Daily.md"), "# {{title}}\n\n- {{priority}}");
  assert.deepEqual(created.output, {
    path: "Templates/Daily.md",
    operation: "create",
    templateFolder: "Templates",
    placeholders: ["title", "priority"],
    bytesWritten: new TextEncoder().encode("# {{title}}\n\n- {{priority}}").length,
  });

  const filled = await registry.execute(
    {
      name: "fill_template",
      arguments: {
        templatePath: "Meeting.md",
        values: {
          title: "Product Sync",
          date: "2026-07-04",
          attendees: "Alex, Jordan",
        },
        targetPath: "Meetings/Product Sync.md",
      },
    },
    mock.context,
  );
  assert.equal(filled.ok, true);
  assert.equal(
    mock.content.get("Meetings/Product Sync.md"),
    "# Product Sync\n\nDate: 2026-07-04\nAttendees: Alex, Jordan",
  );
  assert.deepEqual(filled.output, {
    path: "Meetings/Product Sync.md",
    operation: "create",
    templateSource: "saved_template",
    templatePath: "Templates/Meeting.md",
    placeholders: ["title", "date", "attendees"],
    valuesApplied: ["attendees", "date", "title"],
    bytesWritten: new TextEncoder().encode(
      "# Product Sync\n\nDate: 2026-07-04\nAttendees: Alex, Jordan",
    ).length,
  });
});

test("seed_default_templates creates starter templates without overwriting existing files", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Seed the default starter templates in my vault.",
  });
  mock.content.set("Templates/Research brief.md", "# Existing research brief");

  const seeded = await registry.execute(
    { name: "seed_default_templates", arguments: {} },
    mock.context,
  );

  assert.equal(seeded.ok, true);
  const output = seeded.output as {
    path: string;
    operation: string;
    createdTemplates: Array<{ path: string; placeholders: string[] }>;
    skippedExisting: string[];
    affectedCount: number;
  };
  assert.equal(output.path, "Templates");
  assert.equal(output.operation, "create");
  assert.equal(output.createdTemplates.length, Object.keys(DEFAULT_TEMPLATE_SEEDS).length - 1);
  assert.equal(output.affectedCount, Object.keys(DEFAULT_TEMPLATE_SEEDS).length - 1);
  assert.deepEqual(output.skippedExisting, ["Templates/Research brief.md"]);
  assert.equal(mock.content.get("Templates/Research brief.md"), "# Existing research brief");
  assert.equal(
    mock.content.get("Templates/Experiment log.md"),
    DEFAULT_TEMPLATE_SEEDS["Experiment log.md"],
  );
  assert.ok(mock.operations.includes("createFolder:Templates"));

  const repeated = await registry.execute(
    { name: "seed_default_templates", arguments: {} },
    mock.context,
  );
  assert.equal(repeated.ok, true);
  assert.equal(
    (repeated.output as { createdTemplates: unknown[] }).createdTemplates.length,
    0,
  );
  assert.equal(
    (repeated.output as { skippedExisting: unknown[] }).skippedExisting.length,
    Object.keys(DEFAULT_TEMPLATE_SEEDS).length,
  );
});

test("fill_template supports ad hoc template text and default output folders", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Use this template to create a note.",
  });
  mock.context.settings.templateOutputFolder = "Generated";

  const filled = await registry.execute(
    {
      name: "fill_template",
      arguments: {
        templateText: "# {{title}}\n\n{{body}}",
        values: {
          title: "Weekly Plan",
          body: "Focus on template support.",
        },
      },
    },
    mock.context,
  );

  assert.equal(filled.ok, true);
  assert.equal(
    mock.content.get("Generated/Weekly Plan.md"),
    "# Weekly Plan\n\nFocus on template support.",
  );
  assert.ok(mock.operations.includes("createFolder:Generated"));
});

test("fill_template defaults generated notes to the active project folder", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Use this template to create a note.",
    activePath: "Projects/Novel/Current.md",
  });

  const filled = await registry.execute(
    {
      name: "fill_template",
      arguments: {
        templateText: "# {{title}}\n\n{{body}}",
        values: {
          title: "Scene Plan",
          body: "Draft the opening scene.",
        },
      },
    },
    mock.context,
  );

  assert.equal(filled.ok, true);
  assert.equal(
    mock.content.get("Projects/Novel/Scene Plan.md"),
    "# Scene Plan\n\nDraft the opening scene.",
  );
  assert.ok(mock.operations.includes("createFolder:Projects/Novel"));
  assert.deepEqual(filled.output, {
    path: "Projects/Novel/Scene Plan.md",
    operation: "create",
    templateSource: "ad_hoc_template",
    templatePath: undefined,
    placeholders: ["title", "body"],
    valuesApplied: ["body", "title"],
    bytesWritten: new TextEncoder().encode(
      "# Scene Plan\n\nDraft the opening scene.",
    ).length,
  });
});

test("fill_template rejects unresolved placeholders before creating notes", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Fill this template into a note.",
  });

  const result = await registry.execute(
    {
      name: "fill_template",
      arguments: {
        templateText: "# {{title}}\n\nDate: {{date}}",
        values: {
          title: "Missing Date",
        },
        targetPath: "Missing Date.md",
      },
    },
    mock.context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "invalid_arguments");
  assert.match(result.error?.message ?? "", /date/);
  assert.equal(mock.content.has("Missing Date.md"), false);
});

test("fill_template supports safe builtins, collision suffixing, and read-back verification", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Use this template to create a note with safe builtins.",
    now: new Date("2026-07-04T12:00:00.000Z"),
  });
  mock.content.set("Generated/Brief.md", "# Existing");

  const result = await registry.execute(
    {
      name: "fill_template",
      arguments: {
        templateText: "# {{title}}\n\nDate: {{date}}\n\n{{body}}",
        values: { title: "Brief", body: "Verified content." },
        targetPath: "Generated/Brief.md",
        useBuiltins: true,
        collisionPolicy: "suffix",
      },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal((result.output as { path: string }).path, "Generated/Brief 2.md");
  assert.equal(
    mock.content.get("Generated/Brief 2.md"),
    "# Brief\n\nDate: 2026-07-04\n\nVerified content.",
  );
  assert.equal(
    (result.output as { verification: { passed: boolean } }).verification.passed,
    true,
  );
});

test("fill_template trashes a created note when read-back verification fails", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Use this template to create a note.",
    cachedReadTransform: (path, value) =>
      path === "Generated/Transactional.md" ? `${value}\ncorrupted` : value,
  });

  const result = await registry.execute(
    {
      name: "fill_template",
      arguments: {
        templateText: "# {{title}}\n\n{{body}}",
        values: { title: "Transactional", body: "Verified body." },
        targetPath: "Generated/Transactional.md",
      },
    },
    mock.context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "template_verification_failed");
  assert.match(result.error?.message ?? "", /rolled back/i);
  assert.equal(mock.content.has("Generated/Transactional.md"), false);
  assert.ok(mock.operations.includes("trash:Generated/Transactional.md:false"));
});

test("create_research_pack creates and verifies a linked four-note transaction", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Create a research pack with a brief, sources index, and synthesis.",
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
  const result = await registry.execute(
    {
      name: "create_research_pack",
      arguments: {
        baseFolder: "Research",
        title: "Template Intelligence",
        brief: "Research how metadata-aware templates should work.",
        sources: [
          {
            id: "source-1",
            title: "Primary documentation",
            url: "https://example.com/docs",
            passage: "The documentation defines required and optional fields.",
          },
        ],
        synthesis: "Metadata should drive discovery, ranking, and validation.",
      },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  const output = result.output as {
    createdPaths: string[];
    workflow: { status: string; phase: string };
    verification: { passed: boolean };
  };
  assert.equal(output.createdPaths.length, 4);
  assert.equal(output.workflow.status, "complete");
  assert.equal(output.workflow.phase, "complete");
  assert.equal(output.verification.passed, true);
  assert.match(
    mock.content.get("Research/Template Intelligence/Index.md") ?? "",
    /\[\[Research\/Template Intelligence\/Synthesis\|Synthesis\]\]/,
  );
});

test("create_research_pack rolls back every created note on verification failure", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Create a transactional research pack.",
    cachedReadTransform: (path, value) =>
      path.endsWith("/Sources.md") ? `${value}\ncorrupted` : value,
  });
  const result = await registry.execute(
    {
      name: "create_research_pack",
      arguments: {
        baseFolder: "Research",
        title: "Rollback Pack",
        brief: "A bounded brief.",
        sources: [{ id: "source-1", title: "Source" }],
        synthesis: "A bounded synthesis.",
      },
    },
    mock.context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "research_pack_verification_failed");
  assert.match(result.error?.message ?? "", /rolled back 4/i);
  assert.equal(
    [...mock.content.keys()].some((path) => path.startsWith("Research/Rollback Pack/")),
    false,
  );
});

test("path CRUD rejects unsafe paths and accidental overwrites", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt:
      "Create, append, replace, rename, and delete vault paths, and use a template.",
  });

  for (const [name, args] of [
    ["list_folder", { path: ".obsidian" }],
    ["create_file", { path: "../secret.md", content: "" }],
    ["create_folder", { path: ".agent-backups/new" }],
    ["append_file", { path: "Projects/../secret.md", text: "" }],
    ["replace_file", { path: "Projects/example.txt", text: "" }],
    ["move_path", { fromPath: "Projects/example.md", toPath: "/abs.md" }],
    ["delete_path", { path: ".agent-backups/123-Current.md" }],
    ["read_template", { path: ".obsidian/template.md" }],
    [
      "fill_template",
      {
        templateText: "# {{title}}",
        values: { title: "Unsafe" },
        targetPath: ".agent-backups/Unsafe.md",
      },
    ],
  ] as const) {
    const result =
      name === "replace_file" || name === "delete_path"
        ? await executeAuthorizedPrepared(
            registry,
            { name, arguments: { ...args } },
            mock.context,
          )
        : await registry.execute({ name, arguments: { ...args } }, mock.context);
    assert.equal(result.ok, false, name);
    assert.equal(result.error?.code, "unsafe_path", name);
  }

  const overwrite = await registry.execute(
    {
      name: "move_path",
      arguments: { fromPath: "Projects/example.md", toPath: "Current.md" },
    },
    mock.context,
  );
  assert.equal(overwrite.ok, false);
  assert.match(overwrite.error?.message ?? "", /already exists/);
});

test("delete_path requires recursive true for non-empty folders", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({ prompt: "Delete the Projects folder." });

  const blocked = await executeAuthorizedPrepared(
    registry,
    { name: "delete_path", arguments: { path: "Projects" } },
    mock.context,
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.error?.message ?? "", /recursive=true/);

  const deleted = await executeAuthorizedPrepared(
    registry,
    { name: "delete_path", arguments: { path: "Projects", recursive: true } },
    mock.context,
  );
  assert.equal(deleted.ok, true);
  assert.equal(mock.content.has("Projects/example.md"), false);
  assert.equal(mock.folders.has("Projects"), false);
});

test("reads, appends, and replaces the active markdown file with backup", async () => {
  const mock = createMockContext({
    prompt: "Please append to this note, then replace this note with a clean brief.",
    now: new Date(123),
  });
  const registry = createDefaultToolRegistry();

  const read = await registry.execute(
    { name: "read_current_file", arguments: {} },
    mock.context,
  );
  assert.equal(read.ok, true);
  assert.deepEqual(read.output, {
    path: "Current.md",
    content: "Initial note",
  });

  const append = await registry.execute(
    { name: "append_to_current_file", arguments: { text: "Appended" } },
    mock.context,
  );
  assert.equal(append.ok, true);
  assert.equal(mock.content.get("Current.md"), "Initial note\nAppended");

  const replace = await executeAuthorizedPrepared(
    registry,
    { name: "replace_current_file", arguments: { text: "" } },
    mock.context,
  );
  assert.equal(replace.ok, true);
  assert.equal(mock.content.get("Current.md"), "");
  assert.equal(mock.content.get(".agent-backups/123-Current.md"), "Initial note\nAppended");
});

test("replace_current_file uses a collision-safe backup path", async () => {
  const mock = createMockContext({
    prompt: "Replace this note with a clean brief.",
    now: new Date(123),
  });
  mock.content.set(".agent-backups/123-Current.md", "Existing backup");
  const registry = createDefaultToolRegistry();

  const result = await executeAuthorizedPrepared(
    registry,
    { name: "replace_current_file", arguments: { text: "Replacement" } },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    path: "Current.md",
    backupPath: ".agent-backups/123-Current-1.md",
    bytesWritten: new TextEncoder().encode("Replacement").length,
  });
  assert.equal(mock.content.get(".agent-backups/123-Current.md"), "Existing backup");
  assert.equal(mock.content.get(".agent-backups/123-Current-1.md"), "Initial note");
  assert.equal(mock.content.get("Current.md"), "Replacement");
});

test("replace_current_file tolerates an already existing backup folder", async () => {
  const mock = createMockContext({
    prompt: "Replace this current note with a short update.",
    now: new Date(123),
  });
  const vault = mock.context.app.vault as never as {
    getFolderByPath: (path: string) => unknown;
    createFolder: (path: string) => Promise<void>;
  };
  const originalGetFolderByPath = vault.getFolderByPath;

  vault.getFolderByPath = (path: string) =>
    path === BACKUP_FOLDER ? null : originalGetFolderByPath(path);
  vault.createFolder = async (path: string) => {
    mock.operations.push(`createFolder:${path}`);
    if (path === BACKUP_FOLDER) {
      throw new Error("Folder already exists.");
    }
  };

  const registry = createDefaultToolRegistry();
  const result = await executeAuthorizedPrepared(
    registry,
    { name: "replace_current_file", arguments: { text: "Replacement after race" } },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(mock.content.get("Current.md"), "Replacement after race");
  assert.equal(mock.content.get(".agent-backups/123-Current.md"), "Initial note");
  assert.ok(mock.operations.includes(`createFolder:${BACKUP_FOLDER}`));
});

test("replace_current_file is blocked without explicit replace intent", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({ prompt: "Summarize this note." });

  const result = await executeAuthorizedPrepared(
    registry,
    { name: "replace_current_file", arguments: { text: "New note" } },
    mock.context,
  );

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /explicitly ask/);
});

test("append_to_current_file is blocked without explicit append intent", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({ prompt: "Summarize this note." });

  const result = await registry.execute(
    { name: "append_to_current_file", arguments: { text: "New note" } },
    mock.context,
  );

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /explicitly ask/);
});

test("append_to_current_section inserts below a heading with backup", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Below the Findings section, write a short story.",
    now: new Date(234),
  });
  const original = [
    "# Research",
    "",
    "## Findings",
    "",
    "- Toyota",
    "- Lion",
    "- Blue",
    "",
    "## Next",
    "Keep this.",
  ].join("\n");
  mock.content.set("Current.md", original);

  const result = await registry.execute(
    {
      name: "append_to_current_section",
      arguments: {
        heading: "Findings",
        level: 2,
        content: "A blue Toyota rolled past a lion.",
      },
    },
    mock.context,
  );

  const expected = [
    "# Research",
    "",
    "## Findings",
    "",
    "- Toyota",
    "- Lion",
    "- Blue",
    "",
    "A blue Toyota rolled past a lion.",
    "",
    "## Next",
    "Keep this.",
  ].join("\n");

  assert.equal(result.ok, true);
  assert.equal(mock.content.get("Current.md"), expected);
  assert.equal(mock.content.get(".agent-backups/234-Current.md"), original);
  assert.deepEqual(result.output, {
    path: "Current.md",
    backupPath: ".agent-backups/234-Current.md",
    heading: "Findings",
    level: 2,
    bytesWritten: new TextEncoder().encode("A blue Toyota rolled past a lion.\n\n").length,
    insertedChars: "A blue Toyota rolled past a lion.\n\n".length,
  });
  assert.ok(
    mock.operations.indexOf("create:.agent-backups/234-Current.md") <
      mock.operations.indexOf("modify:Current.md"),
  );
});

test("highlight_current_file_phrase wraps a matching phrase with backup", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Find and highlight silver lantern in the current note.",
    now: new Date(456),
  });
  const original = "# Highlight Fixture\n\nThe silver lantern stayed on the desk.";
  mock.content.set("Current.md", original);

  const result = await registry.execute(
    {
      name: "highlight_current_file_phrase",
      arguments: { phrase: "silver lantern" },
    },
    mock.context,
  );

  const expected = "# Highlight Fixture\n\nThe ==silver lantern== stayed on the desk.";
  assert.equal(result.ok, true);
  assert.equal(mock.content.get("Current.md"), expected);
  assert.equal(mock.content.get(".agent-backups/456-Current.md"), original);
  assert.deepEqual(result.output, {
    path: "Current.md",
    operation: "highlight",
    phrase: "silver lantern",
    matchCount: 1,
    backupPath: ".agent-backups/456-Current.md",
    changed: true,
    bytesWritten: new TextEncoder().encode(expected).length,
  });
});

test("highlight_current_file_phrase skips already highlighted text", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Highlight silver lantern in the current note.",
    now: new Date(457),
  });
  const original = "The ==silver lantern== stayed near another silver lantern.";
  mock.content.set("Current.md", original);

  const result = await registry.execute(
    {
      name: "highlight_current_file_phrase",
      arguments: { phrase: "silver lantern", occurrence: "all" },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(
    mock.content.get("Current.md"),
    "The ==silver lantern== stayed near another ==silver lantern==.",
  );
  assert.doesNotMatch(mock.content.get("Current.md") ?? "", /====silver lantern====/);
});

test("highlight_current_file_phrase returns no-op when phrase is absent", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Find and highlight silver lantern in the current note.",
    now: new Date(458),
  });
  mock.content.set("Current.md", "No matching lamp is here.");

  const result = await registry.execute(
    {
      name: "highlight_current_file_phrase",
      arguments: { phrase: "silver lantern" },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(mock.content.get("Current.md"), "No matching lamp is here.");
  assert.equal(mock.content.has(".agent-backups/458-Current.md"), false);
  assert.deepEqual(result.output, {
    path: "Current.md",
    operation: "highlight",
    phrase: "silver lantern",
    matchCount: 0,
    changed: false,
    bytesWritten: 0,
  });
});

test("restore_current_file_from_backup restores latest current-note backup after backing up current state", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Undo the last agent edit in the current note from backup.",
    now: new Date(200),
  });
  mock.content.set("Current.md", "Broken note");
  mock.content.set(".agent-backups/100-Current.md", "Older note");
  mock.content.set(".agent-backups/150-Current.md", "Restored note");

  const result = await registry.execute(
    { name: "restore_current_file_from_backup", arguments: {} },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    path: "Current.md",
    operation: "restore",
    restoredFromBackupPath: ".agent-backups/150-Current.md",
    backupPath: ".agent-backups/200-Current.md",
    bytesWritten: new TextEncoder().encode("Restored note").length,
  });
  assert.equal(mock.content.get("Current.md"), "Restored note");
  assert.equal(mock.content.get(".agent-backups/200-Current.md"), "Broken note");

  const hiddenBackupMock = createMockContext({
    prompt: "Undo the last agent edit in the current note from backup.",
    now: new Date(201),
  });
  hiddenBackupMock.content.set("Current.md", "Broken adapter note");
  hiddenBackupMock.content.set(".agent-backups/175-Current.md", "Adapter restored note");
  const hiddenVault = hiddenBackupMock.context.app.vault as unknown as {
    getFiles: () => Array<{ path: string }>;
    getFileByPath: (path: string) => { path: string } | null;
  };
  const originalGetFiles = hiddenVault.getFiles.bind(hiddenVault);
  const originalGetFileByPath = hiddenVault.getFileByPath.bind(hiddenVault);
  hiddenVault.getFiles = () =>
    originalGetFiles().filter((file) => !file.path.startsWith(".agent-backups/"));
  hiddenVault.getFileByPath = (path) =>
    path.startsWith(".agent-backups/") ? null : originalGetFileByPath(path);

  const adapterResult = await registry.execute(
    { name: "restore_current_file_from_backup", arguments: {} },
    hiddenBackupMock.context,
  );

  assert.equal(adapterResult.ok, true);
  assert.deepEqual(adapterResult.output, {
    path: "Current.md",
    operation: "restore",
    restoredFromBackupPath: ".agent-backups/175-Current.md",
    backupPath: ".agent-backups/201-Current.md",
    bytesWritten: new TextEncoder().encode("Adapter restored note").length,
  });
  assert.equal(hiddenBackupMock.content.get("Current.md"), "Adapter restored note");
  assert.equal(
    hiddenBackupMock.content.get(".agent-backups/201-Current.md"),
    "Broken adapter note",
  );

  const blocked = await registry.execute(
    { name: "restore_current_file_from_backup", arguments: {} },
    createMockContext({ prompt: "Read the current note." }).context,
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.error?.message ?? "", /explicitly ask to undo/i);
});

test("replace_current_file allows clear-page-and-write wording", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt:
      "Delete all the notes on the page and then write a 300 word essay on the renaissance.",
    now: new Date(345),
  });

  const result = await executeAuthorizedPrepared(
    registry,
    {
      name: "replace_current_file",
      arguments: { text: "# The Renaissance\n\nNew essay." },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(mock.content.get("Current.md"), "# The Renaissance\n\nNew essay.");
  assert.equal(mock.content.get(".agent-backups/345-Current.md"), "Initial note");
});

test("replace_current_file allows delete-current-note-and-write wording", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt:
      "Delete the current note. Ensure that the space is empty. I want you to write now, a 300 word essay on Grapes of Wrath.",
    now: new Date(456),
  });

  const result = await executeAuthorizedPrepared(
    registry,
    {
      name: "replace_current_file",
      arguments: { text: "# The Grapes of Wrath\n\nNew essay." },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(mock.content.get("Current.md"), "# The Grapes of Wrath\n\nNew essay.");
  assert.equal(mock.content.get(".agent-backups/456-Current.md"), "Initial note");
});

test("research memory tools write markdown source and update index", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Save this to research memory for my Renaissance topic.",
    now: new Date("2026-07-04T12:00:00.000Z"),
  });
  let memoryIndex: ResearchMemoryIndexEntry[] = [];
  mock.context.getResearchMemoryIndex = () => memoryIndex;
  mock.context.setResearchMemoryIndex = async (entries) => {
    memoryIndex = entries;
  };

  const append = await registry.execute(
    {
      name: "append_research_memory",
      arguments: {
        topic: "Renaissance Research",
        text: "Humanism and patronage are important threads.",
        keywords: ["humanism", "patronage"],
      },
    },
    mock.context,
  );

  assert.equal(append.ok, true);
  assert.equal(mock.folders.has("Agent Memory"), true);
  assert.equal(mock.folders.has("Agent Memory/Research"), true);
  assert.match(
    mock.content.get("Agent Memory/Research/renaissance-research.md") ?? "",
    /Humanism and patronage/,
  );
  assert.equal(memoryIndex.length, 1);
  assert.equal(memoryIndex[0].topic, "Renaissance Research");
  assert.equal(memoryIndex[0].path, "Agent Memory/Research/renaissance-research.md");
  assert.deepEqual(memoryIndex[0].keywords, ["humanism", "patronage", "renaissance"]);
  assert.equal(memoryIndex[0].lastUpdated, "2026-07-04T12:00:00.000Z");
  assert.equal(memoryIndex[0].confidence, "high");
  assert.equal(memoryIndex[0].updateCount, 1);
  assert.equal(typeof memoryIndex[0].contentHash, "string");

  const read = await registry.execute(
    {
      name: "read_research_memory",
      arguments: { topic: "Renaissance Research" },
    },
    mock.context,
  );

  assert.equal(read.ok, true);
  assert.match((read.output as { content: string }).content, /Humanism/);

  const search = await registry.execute(
    {
      name: "search_research_memory",
      arguments: { query: "patronage" },
    },
    mock.context,
  );

  assert.equal(search.ok, true);
  const matches = (search.output as {
    matches: Array<{ path: string; found: boolean; content: string }>;
  }).matches;
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, "Agent Memory/Research/renaissance-research.md");
  assert.equal(matches[0].found, true);

  const duplicate = await registry.execute(
    {
      name: "append_research_memory",
      arguments: {
        topic: "Renaissance Research",
        text: "Humanism and patronage are important threads.",
        keywords: ["humanism", "patronage"],
      },
    },
    mock.context,
  );

  assert.equal(duplicate.ok, true);
  assert.equal((duplicate.output as { duplicate: boolean }).duplicate, true);
  assert.equal(memoryIndex[0].updateCount, 1);
});

test("research memory review, compact, and delete use backups and index hygiene", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Review, compact, and delete research memory for my Renaissance topic.",
    now: new Date("2026-07-04T12:00:00.000Z"),
  });
  let memoryIndex: ResearchMemoryIndexEntry[] = [
    {
      topic: "Renaissance Research",
      path: "Agent Memory/Research/renaissance-research.md",
      keywords: ["humanism"],
      lastUpdated: "2026-07-04T11:00:00.000Z",
      contentHash: "same-hash",
      updateCount: 1,
    },
    {
      topic: "Renaissance Research Copy",
      path: "Agent Memory/Research/renaissance-copy.md",
      keywords: ["humanism"],
      lastUpdated: "2026-07-04T11:30:00.000Z",
      contentHash: "same-hash",
      updateCount: 1,
    },
    {
      topic: "Missing Memory",
      path: "Agent Memory/Research/missing.md",
      keywords: [],
      lastUpdated: "2026-07-04T10:00:00.000Z",
    },
  ];
  mock.context.getResearchMemoryIndex = () => memoryIndex;
  mock.context.setResearchMemoryIndex = async (entries) => {
    memoryIndex = entries;
  };
  mock.content.set(
    "Agent Memory/Research/renaissance-research.md",
    "# Renaissance Research\n\nVerbose memory.",
  );
  mock.content.set(
    "Agent Memory/Research/renaissance-copy.md",
    "# Renaissance Research Copy\n\nDuplicate memory.",
  );

  const review = await registry.execute(
    {
      name: "review_research_memory",
      arguments: { includeExisting: true },
    },
    mock.context,
  );

  assert.equal(review.ok, true);
  const reviewOutput = review.output as {
    entryCount: number;
    duplicates: unknown[];
    stale: Array<{ path: string }>;
  };
  assert.equal(reviewOutput.entryCount, 3);
  assert.equal(reviewOutput.duplicates.length, 1);
  assert.deepEqual(reviewOutput.stale.map((entry) => entry.path), [
    "Agent Memory/Research/missing.md",
  ]);

  const compact = await registry.execute(
    {
      name: "compact_research_memory",
      arguments: {
        topic: "Renaissance Research",
        summary: "Compacted memory keeps humanism and patronage only.",
        keywords: ["humanism", "patronage"],
      },
    },
    mock.context,
  );

  assert.equal(compact.ok, true);
  const compactOutput = compact.output as { backupPath: string; bytesDeleted: number };
  assert.match(compactOutput.backupPath, /^\.agent-backups\//);
  assert.ok(compactOutput.bytesDeleted > 0);
  assert.match(
    mock.content.get("Agent Memory/Research/renaissance-research.md") ?? "",
    /Compacted memory keeps humanism/,
  );
  assert.equal(memoryIndex.find((entry) => entry.topic === "Renaissance Research")?.updateCount, 2);

  const deleted = await executeAuthorizedPrepared(
    registry,
    {
      name: "delete_research_memory_entry",
      arguments: { topic: "Renaissance Research Copy" },
    },
    mock.context,
  );

  assert.equal(deleted.ok, true);
  assert.equal(mock.content.has("Agent Memory/Research/renaissance-copy.md"), false);
  assert.ok(mock.operations.some((operation) => operation.startsWith("trash:Agent Memory/Research/renaissance-copy.md")));
  assert.equal(
    memoryIndex.some((entry) => entry.path === "Agent Memory/Research/renaissance-copy.md"),
    false,
  );
});

test("research memory write tolerates an already existing memory folder", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Save this to research memory for my Renaissance topic.",
    now: new Date("2026-07-04T12:00:00.000Z"),
  });
  const vault = mock.context.app.vault as never as {
    getFolderByPath: (path: string) => unknown;
    createFolder: (path: string) => Promise<void>;
  };
  const originalGetFolderByPath = vault.getFolderByPath;

  vault.getFolderByPath = (path: string) =>
    path === "Agent Memory/Research" ? null : originalGetFolderByPath(path);
  vault.createFolder = async (path: string) => {
    mock.operations.push(`createFolder:${path}`);
    if (path === "Agent Memory/Research") {
      throw new Error("Folder already exists.");
    }
  };

  const result = await registry.execute(
    {
      name: "append_research_memory",
      arguments: {
        topic: "Renaissance Research",
        text: "Memory survives the folder race.",
      },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.match(
    mock.content.get("Agent Memory/Research/renaissance-research.md") ?? "",
    /Memory survives the folder race/,
  );
  assert.ok(mock.operations.includes("createFolder:Agent Memory/Research"));
});

test("retitle_current_file updates metadata and H1 without renaming the file", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Retitle this note around native Obsidian agentic research.",
  });
  mock.content.set(
    "Current.md",
    [
      "---",
      "title: Old Agent Notes",
      "status: draft",
      "---",
      "",
      "# Old Agent Notes",
      "",
      "Existing content.",
    ].join("\n"),
  );

  const result = await registry.execute(
    {
      name: "retitle_current_file",
      arguments: { title: "Native Obsidian Agentic Research" },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  const expected = [
    "---",
    "title: Native Obsidian Agentic Research",
    "status: draft",
    "---",
    "",
    "# Native Obsidian Agentic Research",
    "",
    "Existing content.",
  ].join("\n");

  assert.equal(mock.content.get("Current.md"), expected);
  assert.deepEqual(result.output, {
    path: "Current.md",
    title: "Native Obsidian Agentic Research",
    previousFrontmatterTitle: "Old Agent Notes",
    previousH1: "Old Agent Notes",
    updatedFrontmatterTitle: "Native Obsidian Agentic Research",
    updatedH1: "Native Obsidian Agentic Research",
    changed: true,
    suggestedFileRename: {
      from: "Current.md",
      to: "Native Obsidian Agentic Research.md",
    },
    bytesWritten: new TextEncoder().encode(expected).length,
  });
});

test("rename_current_file renames active markdown file without changing content", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "No, you need to target Untitled and then change that.",
  });
  mock.content.set("Current.md", "# Old Heading\n\nExisting content.");

  const result = await registry.execute(
    {
      name: "rename_current_file",
      arguments: { title: "History Snapshot" },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(mock.content.has("Current.md"), false);
  assert.equal(
    mock.content.get("History Snapshot.md"),
    "# Old Heading\n\nExisting content.",
  );
  assert.ok(mock.operations.includes("rename:Current.md:History Snapshot.md"));
  assert.deepEqual(result.output, {
    path: "Current.md",
    toPath: "History Snapshot.md",
    title: "History Snapshot",
    previousTitle: "Current",
    changed: true,
    operation: "rename_current_file",
    bytesWritten: 0,
  });
});

test("retitle_current_file is blocked without explicit title intent", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({ prompt: "Summarize this note." });

  const result = await registry.execute(
    { name: "retitle_current_file", arguments: { title: "Summary" } },
    mock.context,
  );

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /explicitly ask/);
});

test("web_search normalizes request and response", async () => {
  const mock = createMockContext();
  let requestBody = "";
  let requestUrl = "";
  let authHeader = "";
  let requestAbortSignal: AbortSignal | undefined;
  const controller = new AbortController();
  mock.context.abortSignal = controller.signal;
  mock.context.httpTransport = async (request) => {
    requestUrl = request.url;
    requestBody = String(request.body);
    authHeader = request.headers?.Authorization ?? "";
    requestAbortSignal = request.abortSignal;
    return {
      status: 200,
      headers: {},
      json: {
        results: [
          {
            title: "Ollama",
            url: "https://ollama.com",
            content: "Search snippet",
          },
        ],
      },
    };
  };

  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    {
      name: "web_search",
      arguments: { query: "ollama web search", max_results: 99 },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(requestUrl, "https://ollama.com/api/web_search");
  assert.equal(authHeader, "Bearer test-key");
  assert.equal(requestAbortSignal, controller.signal);
  assert.equal(JSON.parse(requestBody).max_results, 10);
  assert.deepEqual(result.output, {
    results: [
      {
        title: "Ollama",
        url: "https://ollama.com",
        snippet: "Search snippet",
      },
    ],
  });
});

test("web_search defaults to compact result count and snippet caps", async () => {
  const mock = createMockContext();
  let requestBody = "";
  const longSnippet = "s".repeat(MAX_WEB_SEARCH_SNIPPET_CHARS + 1);
  mock.context.httpTransport = async (request) => {
    requestBody = String(request.body);
    return {
      status: 200,
      headers: {},
      json: {
        results: [
          {
            title: "Long result",
            url: "https://example.com",
            content: longSnippet,
            snippet: longSnippet,
          },
        ],
      },
    };
  };

  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    {
      name: "web_search",
      arguments: { query: "ollama web search" },
    },
    mock.context,
  );

  assert.equal(JSON.parse(requestBody).max_results, DEFAULT_WEB_RESULTS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    results: [
      {
        title: "Long result",
        url: "https://example.com",
        snippet: `${"s".repeat(MAX_WEB_SEARCH_SNIPPET_CHARS)}\n\n[truncated]`,
      },
    ],
  });
});

test("web_search returns tool error when transport times out", async () => {
  const mock = createMockContext();
  let timeoutMs = 0;
  mock.context.httpTransport = async (request) => {
    timeoutMs = request.timeoutMs ?? 0;
    throw new Error("Request timed out after 60000ms.");
  };

  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    {
      name: "web_search",
      arguments: { query: "ollama web search" },
    },
    mock.context,
  );

  assert.equal(timeoutMs, 60000);
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /timed out/);
});

test("web_fetch normalizes request and response", async () => {
  const mock = createMockContext();
  let requestBody = "";
  let requestUrl = "";
  let authHeader = "";
  mock.context.httpTransport = async (request) => {
    requestUrl = request.url;
    requestBody = String(request.body);
    authHeader = request.headers?.Authorization ?? "";
    return {
      status: 200,
      headers: {},
      json: {
        title: "Ollama Docs",
        content: "Fetched page content",
        links: ["https://ollama.com/models", 7],
      },
    };
  };

  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    {
      name: "web_fetch",
      arguments: { url: "docs.ollama.com/capabilities/web-search#top" },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(requestUrl, "https://ollama.com/api/web_fetch");
  assert.equal(authHeader, "Bearer test-key");
  assert.deepEqual(JSON.parse(requestBody), {
    url: "https://docs.ollama.com/capabilities/web-search",
  });
  const output = result.output as Record<string, unknown>;
  assert.deepEqual(
    {
      title: output.title,
      url: output.url,
      content: output.content,
      links: output.links,
      fromCache: output.fromCache,
      totalChars: output.totalChars,
      section: output.section,
      sectionCount: output.sectionCount,
      normalizedUrl: output.normalizedUrl,
      fetchedAt: output.fetchedAt,
      sourceChars: output.sourceChars,
      truncated: output.truncated,
      parserStatus: output.parserStatus,
    },
    {
    title: "Ollama Docs",
    url: "https://docs.ollama.com/capabilities/web-search",
    content: "Fetched page content",
    links: ["https://ollama.com/models"],
    fromCache: false,
    totalChars: 20,
    section: 1,
    sectionCount: 1,
      normalizedUrl: "https://docs.ollama.com/capabilities/web-search",
      fetchedAt: "1970-01-01T00:00:00.123Z",
      sourceChars: 20,
      truncated: false,
      parserStatus: "parsed",
    },
  );
  assert.match(
    String(output.cachedPath),
    /^Agent Sources\/docs\.ollama\.com\/Ollama-Docs-[a-f0-9]{16}\.md$/u,
  );
  assert.match(String(output.urlHash), /^[a-f0-9]{16}$/u);
  assert.match(String(output.contentHash), /^fnv1a32x2:[a-f0-9]{16}$/u);
});

test("web tools reject work when the run is already cancelled", async () => {
  const mock = createMockContext();
  const controller = new AbortController();
  controller.abort();
  mock.context.abortSignal = controller.signal;
  let transportCalled = false;
  mock.context.httpTransport = async () => {
    transportCalled = true;
    return { status: 200, headers: {}, json: { results: [] } };
  };

  const result = await createDefaultToolRegistry().execute(
    { name: "web_search", arguments: { query: "cancelled" } },
    mock.context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "operation_cancelled");
  assert.equal(transportCalled, false);
});

test("web_fetch returns tool error when transport times out", async () => {
  const mock = createMockContext();
  let timeoutMs = 0;
  mock.context.httpTransport = async (request) => {
    timeoutMs = request.timeoutMs ?? 0;
    throw new Error("Request timed out after 60000ms.");
  };

  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    { name: "web_fetch", arguments: { url: "https://example.com" } },
    mock.context,
  );

  assert.equal(timeoutMs, 60000);
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /timed out/);
});

test("web_fetch rejects unsafe URLs before transport", async () => {
  const mock = createMockContext();
  let transportCalled = false;
  mock.context.httpTransport = async () => {
    transportCalled = true;
    return {
      status: 200,
      headers: {},
      json: {},
    };
  };

  const registry = createDefaultToolRegistry();
  const unsafeUrls = [
    "http://localhost:11434",
    "http://127.0.0.1",
    "file:///secret",
    "javascript:alert(1)",
    "http://192.168.1.10",
    "http://10.0.0.5",
  ];

  for (const url of unsafeUrls) {
    const result = await registry.execute(
      { name: "web_fetch", arguments: { url } },
      mock.context,
    );

    assert.equal(result.ok, false, url);
  }

  assert.equal(transportCalled, false);
});

test("web_fetch truncates fetched page content", async () => {
  const mock = createMockContext();
  mock.context.httpTransport = async () => ({
    status: 200,
    headers: {},
    json: {
      title: "Long page",
      content: "x".repeat(MAX_WEB_FETCH_CHARS + 1),
      links: [],
    },
  });

  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    { name: "web_fetch", arguments: { url: "https://example.com" } },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(
    (result.output as { content: string }).content,
    `${"x".repeat(MAX_WEB_FETCH_CHARS)}\n\n[truncated]`,
  );
});

test("mutation tool schemas do not accept arbitrary paths", () => {
  const registry = createDefaultToolRegistry();
  const mutationToolNames = [
    "append_to_current_file",
    "append_to_current_section",
    "append_research_memory",
    "retitle_current_file",
    "prepare_edit_current_section",
    "edit_current_section",
    "replace_current_file",
    "delete_current_file",
  ];

  for (const toolName of mutationToolNames) {
    const definition = registry
      .getDefinitions()
      .find((tool) => tool.function.name === toolName);

    assert.ok(definition, `${toolName} should be exposed`);
    assert.equal(definition.function.parameters.properties?.path, undefined);
    assert.ok(!definition.function.parameters.required?.includes("path"));
  }
});

test("prepare_edit_current_section creates a backup and returns section boundaries", async () => {
  const mock = createMockContext({
    prompt: "Edit the Goals section in this note.",
    now: new Date(654),
  });
  const original = [
    "# Project",
    "",
    "Intro.",
    "",
    "## Goals",
    "Old goals.",
    "",
    "## Scope",
    "Keep scope.",
  ].join("\n");
  mock.content.set("Current.md", original);
  const registry = createDefaultToolRegistry();

  const result = await registry.execute(
    {
      name: "prepare_edit_current_section",
      arguments: {
        heading: "Goals",
        level: 2,
      },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(mock.content.get("Current.md"), original);
  assert.equal(mock.content.get(".agent-backups/654-Current.md"), original);
  assert.equal(mock.operations.includes("modify:Current.md"), false);
  assert.deepEqual(result.output, {
    path: "Current.md",
    backupPath: ".agent-backups/654-Current.md",
    heading: "Goals",
    level: 2,
    prefix: ["# Project", "", "Intro.", "", "## Goals", ""].join("\n"),
    suffix: ["## Scope", "Keep scope."].join("\n"),
    replacedChars: "Old goals.\n\n".length,
  });
});

test("edit_current_section replaces one heading section after backup", async () => {
  const mock = createMockContext({
    prompt: "Edit the Goals section in this note.",
    now: new Date(456),
  });
  mock.content.set(
    "Current.md",
    [
      "# Project",
      "",
      "Intro.",
      "",
      "## Goals",
      "Old goals.",
      "",
      "## Scope",
      "Keep scope.",
    ].join("\n"),
  );
  const registry = createDefaultToolRegistry();

  const result = await registry.execute(
    {
      name: "edit_current_section",
      arguments: {
        heading: "Goals",
        level: 2,
        content: "New goals.",
      },
    },
    mock.context,
  );

  const expected = [
    "# Project",
    "",
    "Intro.",
    "",
    "## Goals",
    "New goals.",
    "## Scope",
    "Keep scope.",
  ].join("\n");

  assert.equal(result.ok, true);
  assert.equal(mock.content.get("Current.md"), expected);
  assert.equal(
    mock.content.get(".agent-backups/456-Current.md"),
    [
      "# Project",
      "",
      "Intro.",
      "",
      "## Goals",
      "Old goals.",
      "",
      "## Scope",
      "Keep scope.",
    ].join("\n"),
  );
  assert.deepEqual(result.output, {
    path: "Current.md",
    backupPath: ".agent-backups/456-Current.md",
    heading: "Goals",
    level: 2,
    bytesWritten: new TextEncoder().encode(expected).length,
    replacedChars: "Old goals.\n\n".length,
  });
  assert.ok(
    mock.operations.indexOf("create:.agent-backups/456-Current.md") <
      mock.operations.indexOf("modify:Current.md"),
  );
});

test("edit_current_section ignores headings inside fenced code blocks", async () => {
  const mock = createMockContext({
    prompt: "Revise the Goals section.",
  });
  mock.content.set(
    "Current.md",
    [
      "# Project",
      "",
      "```md",
      "## Goals",
      "Do not edit.",
      "```",
      "",
      "## Goals",
      "Old goals.",
    ].join("\n"),
  );
  const registry = createDefaultToolRegistry();

  const result = await registry.execute(
    {
      name: "edit_current_section",
      arguments: {
        heading: "Goals",
        level: 2,
        content: "New goals.",
      },
    },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(
    mock.content.get("Current.md"),
    [
      "# Project",
      "",
      "```md",
      "## Goals",
      "Do not edit.",
      "```",
      "",
      "## Goals",
      "New goals.",
    ].join("\n"),
  );
});

test("edit_current_section rejects missing and ambiguous headings before backup", async () => {
  const registry = createDefaultToolRegistry();
  const missing = createMockContext({ prompt: "Edit the Missing section." });
  missing.content.set("Current.md", "# Project\n\n## Goals\nOld");

  const missingResult = await registry.execute(
    {
      name: "edit_current_section",
      arguments: { heading: "Missing", content: "New" },
    },
    missing.context,
  );

  assert.equal(missingResult.ok, false);
  assert.match(missingResult.error?.message ?? "", /not found/);
  assert.equal(missing.content.has(".agent-backups/123-Current.md"), false);

  const ambiguous = createMockContext({ prompt: "Edit the Goals section." });
  ambiguous.content.set("Current.md", "# Project\n\n## Goals\nA\n\n## Goals\nB");

  const ambiguousResult = await registry.execute(
    {
      name: "edit_current_section",
      arguments: { heading: "Goals", content: "New" },
    },
    ambiguous.context,
  );

  assert.equal(ambiguousResult.ok, false);
  assert.match(ambiguousResult.error?.message ?? "", /ambiguous/);
  assert.equal(ambiguous.content.has(".agent-backups/123-Current.md"), false);
});

test("delete_current_file creates backup before deleting active note", async () => {
  const mock = createMockContext({
    prompt: "Delete the current note.",
    now: new Date(789),
  });
  const registry = createDefaultToolRegistry();

  const result = await executeAuthorizedPrepared(
    registry,
    { name: "delete_current_file", arguments: {} },
    mock.context,
  );

  assert.equal(result.ok, true);
  assert.equal(mock.content.has("Current.md"), false);
  assert.equal(mock.content.get(".agent-backups/789-Current.md"), "Initial note");
  assert.deepEqual(result.output, {
    path: "Current.md",
    operation: "trash",
    backupPath: ".agent-backups/789-Current.md",
    bytesDeleted: new TextEncoder().encode("Initial note").length,
  });
  assert.ok(
    mock.operations.indexOf("create:.agent-backups/789-Current.md") <
      mock.operations.indexOf("trash:Current.md:false"),
  );
});

test("delete_current_file rejects arguments and requires delete intent", async () => {
  const registry = createDefaultToolRegistry();
  const withPath = await executeAuthorizedPrepared(
    registry,
    { name: "delete_current_file", arguments: { path: "Projects/example.md" } },
    createMockContext({ prompt: "Delete the current note." }).context,
  );

  assert.equal(withPath.ok, false);
  assert.equal(withPath.error?.code, "invalid_arguments");

  const withoutIntent = createMockContext({ prompt: "Summarize this note." });
  const result = await executeAuthorizedPrepared(
    registry,
    { name: "delete_current_file", arguments: {} },
    withoutIntent.context,
  );

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /explicitly ask/);
  assert.equal(withoutIntent.content.has("Current.md"), true);
});

function attachMetadataCache(
  mock: ReturnType<typeof createMockContext>,
  options: {
    resolvedLinks?: Record<string, Record<string, number>>;
    unresolvedLinks?: Record<string, Record<string, number>>;
    fileCaches?: Record<
      string,
      {
        links?: Array<{ link: string; displayText?: string; original?: string }>;
        tags?: Array<{ tag: string }>;
        headings?: Array<{ heading: string; level: number }>;
        frontmatter?: Record<string, unknown>;
      }
    >;
  },
) {
  const app = mock.context.app as unknown as {
    metadataCache?: unknown;
    vault: {
      getFileByPath: (path: string) => { path: string; extension: string } | null;
    };
  };
  app.metadataCache = {
    resolvedLinks: options.resolvedLinks ?? {},
    unresolvedLinks: options.unresolvedLinks ?? {},
    getFileCache: (file: { path: string }) =>
      options.fileCaches?.[file.path] ?? null,
    getFirstLinkpathDest: (linktext: string) => {
      const normalized = linktext.replace(/\.md$/i, "");
      const candidates = [
        `${normalized}.md`,
        ...[...mock.content.keys()].filter(
          (path) =>
            path.replace(/\.md$/i, "") === normalized ||
            path.split("/").pop()?.replace(/\.md$/i, "") === normalized,
        ),
      ];

      for (const candidate of candidates) {
        const file = app.vault.getFileByPath(candidate);
        if (file) {
          return file;
        }
      }

      return null;
    },
  };
}

function createMockContext(options: {
  prompt?: string;
  now?: Date;
  activePath?: string | null;
  currentMarkdownPath?: string;
  liveContent?: string;
  fileStats?: Record<string, { ctime?: number; mtime?: number; size?: number }>;
  settings?: Partial<ToolExecutionContext["settings"]>;
  cachedReadTransform?: (path: string, value: string) => string;
} = {}) {
  const activePath =
    options.activePath === null ? null : (options.activePath ?? "Current.md");
  const activeName = activePath?.split("/").pop() ?? activePath;
  const activeFile = activePath
    ? {
        path: activePath,
        basename: activeName?.replace(/\.[^.]+$/i, "") ?? activePath,
        extension: activeName?.includes(".")
          ? activeName.split(".").pop()?.toLowerCase() ?? ""
          : "",
      }
    : null;
  const projectFile = {
    path: "Projects/example.md",
    basename: "example",
    extension: "md",
  };
  const content = new Map<string, string>([
    ["Current.md", "Initial note"],
    ["Projects/example.md", "Project note"],
  ]);
  if (activePath && !content.has(activePath)) {
    content.set(activePath, "Initial note");
  }
  if (options.currentMarkdownPath && !content.has(options.currentMarkdownPath)) {
    content.set(options.currentMarkdownPath, "Initial note");
  }
  const folders = new Set<string>(["Projects"]);
  const operations: string[] = [];

  const getFile = (path: string) => {
    if (!content.has(path)) {
      return null;
    }

    const stats = options.fileStats?.[path];
    const extension = path.includes(".")
      ? path.split(".").pop()?.toLowerCase() ?? ""
      : "";

    return {
      path,
      name: path.split("/").pop() ?? path,
      basename: path.split("/").pop()?.replace(/\.[^.]+$/i, "") ?? path,
      extension,
      stat: {
        ctime: stats?.ctime ?? stats?.mtime ?? 0,
        mtime: stats?.mtime ?? stats?.ctime ?? 0,
        size: stats?.size ?? content.get(path)?.length ?? 0,
      },
    };
  };

  const getFolder = (path: string) => {
    if (!path || !folders.has(path)) {
      return null;
    }

    return {
      path,
      name: path.split("/").pop() ?? path,
    };
  };

  const getKnownFolders = () => {
    const knownFolders = new Set(folders);

    for (const path of content.keys()) {
      let folderPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      while (folderPath) {
        knownFolders.add(folderPath);
        folderPath = folderPath.includes("/")
          ? folderPath.slice(0, folderPath.lastIndexOf("/"))
          : "";
      }
    }

    return knownFolders;
  };

  const getAllLoadedFiles = () => [
    ...[...getKnownFolders()].map((path) => ({
      path,
      name: path.split("/").pop() ?? path,
    })),
    ...[...content.keys()].map((path) => getFile(path)),
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const app = {
    workspace: {
      getActiveFile: () => activeFile,
    },
    vault: {
      adapter: {
        list: async (folderPath: string) => {
          const prefix = folderPath ? `${folderPath}/` : "";
          const files = [...content.keys()].filter((path) => {
            if (!path.startsWith(prefix)) {
              return false;
            }
            return !path.slice(prefix.length).includes("/");
          });
          const childFolders = [...getKnownFolders()].filter((path) => {
            if (!path.startsWith(prefix) || path === folderPath) {
              return false;
            }
            return !path.slice(prefix.length).includes("/");
          });
          return { files, folders: childFolders };
        },
        read: async (path: string) => {
          const value = content.get(path);
          if (value === undefined) {
            throw new Error(`File not found: ${path}`);
          }
          return value;
        },
      },
      getFiles: () =>
        [...content.keys()]
          .map((path) => getFile(path))
          .filter((file): file is NonNullable<typeof file> => Boolean(file)),
      getAllLoadedFiles,
      cachedRead: async (file: { path: string }) => {
        const value = content.get(file.path) ?? "";
        return options.cachedReadTransform?.(file.path, value) ?? value;
      },
      read: async (file: { path: string }) => content.get(file.path) ?? "",
      modify: async (file: { path: string }, data: string) => {
        operations.push(`modify:${file.path}`);
        content.set(file.path, data);
      },
      getFileByPath: getFile,
      getFolderByPath: getFolder,
      getAbstractFileByPath: (path: string) => getFile(path) ?? getFolder(path),
      createFolder: async (path: string) => {
        operations.push(`createFolder:${path}`);
        folders.add(path);
      },
      create: async (path: string, data: string) => {
        operations.push(`create:${path}`);
        content.set(path, data);
        return {
          path,
          basename: path.split("/").pop()?.replace(/\.md$/i, "") ?? path,
          extension: "md",
        };
      },
      rename: async (target: { path: string; extension?: string }, newPath: string) => {
        operations.push(`rename:${target.path}:${newPath}`);

        if (target.extension !== undefined) {
          const value = content.get(target.path) ?? "";
          content.delete(target.path);
          content.set(newPath, value);
          target.path = newPath;
          return;
        }

        const oldPath = target.path;
        const folderUpdates = [...folders].filter(
          (path) => path === oldPath || path.startsWith(`${oldPath}/`),
        );
        for (const path of folderUpdates) {
          folders.delete(path);
          folders.add(`${newPath}${path.slice(oldPath.length)}`);
        }

        const fileUpdates = [...content.entries()].filter(
          ([path]) => path.startsWith(`${oldPath}/`),
        );
        for (const [path, value] of fileUpdates) {
          content.delete(path);
          content.set(`${newPath}${path.slice(oldPath.length)}`, value);
        }

        target.path = newPath;
      },
      trash: async (target: { path: string; extension?: string }, system: boolean) => {
        operations.push(`trash:${target.path}:${system}`);

        if (target.extension !== undefined) {
          content.delete(target.path);
          return;
        }

        const folderPath = target.path;
        for (const path of [...content.keys()]) {
          if (path.startsWith(`${folderPath}/`)) {
            content.delete(path);
          }
        }

        for (const path of [...folders]) {
          if (path === folderPath || path.startsWith(`${folderPath}/`)) {
            folders.delete(path);
          }
        }
      },
      delete: async (file: { path: string }) => {
        operations.push(`delete:${file.path}`);
        content.delete(file.path);
      },
    },
  };
  const currentMarkdownPath = options.currentMarkdownPath;

  const context: ToolExecutionContext = {
    app: app as never,
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
      ...options.settings,
    },
    originalPrompt: options.prompt ?? "Research this note.",
    httpTransport: async () => ({
      status: 500,
      headers: {},
      json: { error: "not mocked" },
    }),
    now: () => options.now ?? new Date(123),
    getCurrentMarkdownFile: currentMarkdownPath
      ? () => getFile(currentMarkdownPath) as never
      : undefined,
    getCurrentMarkdownContent:
      currentMarkdownPath && options.liveContent !== undefined
        ? (file) =>
            file.path === currentMarkdownPath
              ? options.liveContent ?? null
              : null
        : undefined,
  };

  return { context, content, folders, operations };
}
