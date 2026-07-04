import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import {
  DEFAULT_WEB_RESULTS,
  MAX_WEB_FETCH_CHARS,
  MAX_WEB_SEARCH_SNIPPET_CHARS,
} from "../src/tools/constants";
import type { ToolExecutionContext } from "../src/tools/types";

test("registry exposes tool definitions and rejects unknown tools", async () => {
  const registry = createDefaultToolRegistry();
  const definitions = registry.getDefinitions();

  assert.ok(definitions.some((tool) => tool.function.name === "read_current_file"));
  assert.ok(definitions.some((tool) => tool.function.name === "list_folder"));
  assert.ok(definitions.some((tool) => tool.function.name === "search_markdown_files"));
  assert.ok(definitions.some((tool) => tool.function.name === "read_markdown_files"));
  assert.ok(definitions.some((tool) => tool.function.name === "create_file"));

  const result = await registry.execute(
    { name: "missing_tool", arguments: {} },
    createMockContext().context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "unknown_tool");
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

  const replaced = await registry.execute(
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

  const trashed = await registry.execute(
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

test("path CRUD rejects unsafe paths and accidental overwrites", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({
    prompt: "Create, append, replace, rename, and delete vault paths.",
  });

  for (const [name, args] of [
    ["list_folder", { path: ".obsidian" }],
    ["create_file", { path: "../secret.md", content: "" }],
    ["create_folder", { path: ".agent-backups/new" }],
    ["append_file", { path: "Projects/../secret.md", text: "" }],
    ["replace_file", { path: "Projects/example.txt", text: "" }],
    ["move_path", { fromPath: "Projects/example.md", toPath: "/abs.md" }],
    ["delete_path", { path: ".agent-backups/123-Current.md" }],
  ] as const) {
    const result = await registry.execute({ name, arguments: args }, mock.context);
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

  const blocked = await registry.execute(
    { name: "delete_path", arguments: { path: "Projects" } },
    mock.context,
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.error?.message ?? "", /recursive=true/);

  const deleted = await registry.execute(
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

  const replace = await registry.execute(
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

  const result = await registry.execute(
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

test("replace_current_file is blocked without explicit replace intent", async () => {
  const registry = createDefaultToolRegistry();
  const mock = createMockContext({ prompt: "Summarize this note." });

  const result = await registry.execute(
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
  mock.context.httpTransport = async (request) => {
    requestUrl = request.url;
    requestBody = String(request.body);
    authHeader = request.headers?.Authorization ?? "";
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
  assert.deepEqual(result.output, {
    title: "Ollama Docs",
    url: "https://docs.ollama.com/capabilities/web-search",
    content: "Fetched page content",
    links: ["https://ollama.com/models"],
  });
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

  const result = await registry.execute(
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
  const withPath = await registry.execute(
    { name: "delete_current_file", arguments: { path: "Projects/example.md" } },
    createMockContext({ prompt: "Delete the current note." }).context,
  );

  assert.equal(withPath.ok, false);
  assert.equal(withPath.error?.code, "invalid_arguments");

  const withoutIntent = createMockContext({ prompt: "Summarize this note." });
  const result = await registry.execute(
    { name: "delete_current_file", arguments: {} },
    withoutIntent.context,
  );

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /explicitly ask/);
  assert.equal(withoutIntent.content.has("Current.md"), true);
});

function createMockContext(options: {
  prompt?: string;
  now?: Date;
  activePath?: string | null;
  currentMarkdownPath?: string;
  liveContent?: string;
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

    const extension = path.includes(".")
      ? path.split(".").pop()?.toLowerCase() ?? ""
      : "";

    return {
      path,
      name: path.split("/").pop() ?? path,
      basename: path.split("/").pop()?.replace(/\.[^.]+$/i, "") ?? path,
      extension,
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
      getFiles: () =>
        [...content.keys()]
          .map((path) => getFile(path))
          .filter((file): file is NonNullable<typeof file> => Boolean(file)),
      getAllLoadedFiles,
      cachedRead: async (file: { path: string }) => content.get(file.path) ?? "",
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
      ollamaApiKey: "test-key",
      ollamaBaseUrl: "https://ollama.com/api",
      model: "gpt-oss:120b",
      enableStreaming: true,
      thinkingMode: "auto",
      streamWritebackMode: "all_current_note_content_writes",
      requestTimeoutMs: 60000,
      temperature: null,
      topK: null,
      topP: null,
      numCtx: null,
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
