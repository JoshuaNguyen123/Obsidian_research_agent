import test from "node:test";
import assert from "node:assert/strict";
import { validateJsonCanvas } from "../src/design/jsonCanvas";
import {
  createDesignCanvasTool,
  createSvgDesignTool,
} from "../src/tools/designTools";
import { openWebSourceTool } from "../src/tools/webViewerTools";
import {
  __setCodeToolsDesktopAppForTests,
  renderHtmlPreviewTool,
  runCodeBlockTool,
} from "../src/tools/codeTools";
import type { ToolExecutionContext } from "../src/tools/types";

test("JSON Canvas validation catches duplicate ids and invalid link URLs", () => {
  const result = validateJsonCanvas({
    nodes: [
      {
        id: "same",
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: "A",
      },
      {
        id: "same",
        type: "link",
        x: 120,
        y: 0,
        width: 100,
        height: 100,
        url: "ftp://example.com",
      },
    ],
    edges: [
      {
        id: "edge",
        fromNode: "same",
        toNode: "missing",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /duplicates/.test(error)));
  assert.ok(result.errors.some((error) => /http or https/.test(error)));
  assert.ok(result.errors.some((error) => /missing node/.test(error)));
});

test("create_design_canvas creates and verifies a canvas artifact", async () => {
  const mock = createMockContext({
    prompt: "Create a design canvas wireframe for this workflow.",
  });

  const output = await createDesignCanvasTool.execute(
    {
      path: "Designs/workflow.canvas",
      title: "Workflow",
      items: [
        { title: "Plan", text: "Read context." },
        { title: "Act", text: "Use tools." },
      ],
      direction: "row",
    },
    mock.context,
  );

  assert.deepEqual(output, {
    path: "Designs/workflow.canvas",
    operation: "create",
    bytesWritten: mock.bytes("Designs/workflow.canvas"),
    nodeCount: 3,
    edgeCount: 2,
    opened: false,
  });
  assert.equal(mock.folders.has("Designs"), true);
  assert.match(mock.content.get("Designs/workflow.canvas") ?? "", /Read context/);
});

test("create_svg_design creates an escaped SVG artifact", async () => {
  const mock = createMockContext({
    prompt: "Create an SVG wireframe design for the run details.",
  });

  const output = await createSvgDesignTool.execute(
    {
      path: "Designs/run-details.svg",
      title: "Run Details",
      shapes: [
        {
          type: "rect",
          x: 20,
          y: 20,
          width: 220,
          height: 80,
          label: "Safe <label>",
        },
        {
          type: "arrow",
          x1: 240,
          y1: 60,
          x2: 340,
          y2: 60,
        },
      ],
    },
    mock.context,
  );

  assert.equal((output as { path: string }).path, "Designs/run-details.svg");
  assert.equal((output as { shapeCount: number }).shapeCount, 2);
  const svg = mock.content.get("Designs/run-details.svg") ?? "";
  assert.match(svg, /Safe &lt;label&gt;/);
  assert.doesNotMatch(svg, /<script/);
});

test("open_web_source creates a source note and returns fallback when window is unavailable", async () => {
  const mock = createMockContext({
    prompt: "Open this source URL in the browser and save the source.",
    now: new Date("2026-07-04T12:00:00.000Z"),
  });

  const output = await openWebSourceTool.execute(
    {
      url: "https://example.com/research?id=1",
      title: "Example Research",
    },
    mock.context,
  );

  assert.equal((output as { operation: string }).operation, "create_source_note");
  assert.equal((output as { url: string }).url, "https://example.com/research?id=1");
  assert.equal((output as { opened: boolean }).opened, false);
  assert.equal((output as { fallback: string }).fallback, "https://example.com/research?id=1");
  const path = (output as { path: string }).path;
  assert.match(path, /^Agent Sources\/example-com-research-[a-f0-9]+\.md$/);
  assert.match(mock.content.get(path) ?? "", /Opened: 2026-07-04T12:00:00.000Z/);
});

test("run_code_block requires explicit code execution intent", async () => {
  __setCodeToolsDesktopAppForTests(true);
  const mock = createMockContext({ prompt: "Summarize this note." });

  await assert.rejects(
    () =>
      runCodeBlockTool.execute(
        {
          language: "javascript",
          code: "console.log('hi')",
        },
        mock.context,
      ),
    /explicitly ask/,
  );

  __setCodeToolsDesktopAppForTests(null);
});

test("run_code_block executes explicit JavaScript and returns stdout metadata", async () => {
  __setCodeToolsDesktopAppForTests(true);
  const mock = createMockContext({
    prompt: "Run this JavaScript code snippet.",
  });

  try {
    const output = await runCodeBlockTool.execute(
      {
        language: "javascript",
        code: "console.log(JSON.stringify({ ok: true, value: 2 + 3 }));",
        timeoutMs: 1000,
      },
      mock.context,
    );

    assert.equal((output as { language: string }).language, "javascript");
    assert.equal((output as { operation: string }).operation, "run");
    const result = (output as { result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean } }).result;
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /"value":5/);
  } finally {
    __setCodeToolsDesktopAppForTests(null);
  }
});

test("render_html_preview returns a sandboxed preview document", async () => {
  __setCodeToolsDesktopAppForTests(true);
  const mock = createMockContext({
    prompt: "Render this HTML code preview.",
  });

  const output = await renderHtmlPreviewTool.execute(
    {
      html: "<main><h1>Hello</h1><script>window.evil=true</script></main>",
      title: "Preview",
    },
    mock.context,
  );

  assert.equal((output as { operation: string }).operation, "render_html_preview");
  assert.equal((output as { sandbox: string }).sandbox, "");
  assert.match((output as { previewHtml: string }).previewHtml, /Content-Security-Policy/);
  assert.match((output as { previewHtml: string }).previewHtml, /script-src &#39;none&#39;/);

  __setCodeToolsDesktopAppForTests(null);
});

function createMockContext(options: {
  prompt?: string;
  now?: Date;
} = {}) {
  const content = new Map<string, string>();
  const folders = new Set<string>();
  const operations: string[] = [];

  const getFile = (path: string) => {
    if (!content.has(path)) {
      return null;
    }

    const name = path.split("/").pop() ?? path;
    const extension = name.includes(".")
      ? name.split(".").pop()?.toLowerCase() ?? ""
      : "";

    return {
      path,
      name,
      basename: name.replace(/\.[^.]+$/i, ""),
      extension,
      stat: {
        ctime: 0,
        mtime: 0,
        size: content.get(path)?.length ?? 0,
      },
    };
  };

  const getFolder = (path: string) => {
    if (!folders.has(path)) {
      return null;
    }

    return {
      path,
      name: path.split("/").pop() ?? path,
    };
  };

  const app = {
    workspace: {
      getActiveFile: () => null,
      getLeaf: () => ({
        openFile: async (file: { path: string }) => {
          operations.push(`open:${file.path}`);
        },
      }),
    },
    vault: {
      getFiles: () =>
        [...content.keys()]
          .map((path) => getFile(path))
          .filter((file): file is NonNullable<typeof file> => Boolean(file)),
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
        return getFile(path);
      },
      read: async (file: { path: string }) => content.get(file.path) ?? "",
      cachedRead: async (file: { path: string }) => content.get(file.path) ?? "",
      modify: async (file: { path: string }, data: string) => {
        operations.push(`modify:${file.path}`);
        content.set(file.path, data);
      },
    },
  };

  const context: ToolExecutionContext = {
    app: app as never,
    settings: {
      ollamaApiKey: "test-key",
      ollamaBaseUrl: "https://ollama.com/api",
      model: "gpt-oss:120b",
      enableStreaming: true,
      thinkingMode: "auto",
      streamWritebackMode: "all_current_note_content_writes",
      maxAgentSteps: 10,
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
    },
    originalPrompt: options.prompt ?? "Create a design artifact.",
    httpTransport: async () => ({
      status: 500,
      headers: {},
      json: { error: "not mocked" },
    }),
    now: () => options.now ?? new Date(123),
  };

  return {
    context,
    content,
    folders,
    operations,
    bytes: (path: string) => new TextEncoder().encode(content.get(path) ?? "").length,
  };
}
