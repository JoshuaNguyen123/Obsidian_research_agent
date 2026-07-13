import test from "node:test";
import assert from "node:assert/strict";
import { validateJsonCanvas } from "../src/design/jsonCanvas";
import {
  createDesignCanvasTool,
  createSvgDesignTool,
  readDesignCanvasTool,
  updateDesignCanvasTool,
} from "../src/tools/designTools";
import { sha256DiagramContent } from "../src/design/diagramArtifactStore";
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
    diagramType: "sequence",
    bytesWritten: mock.bytes("Designs/workflow.canvas"),
    nodeCount: 3,
    edgeCount: 2,
    summary: "Canvas sequence planned: 3 nodes, 2 edges.",
    opened: true,
  });
  assert.ok(mock.operations.includes("open:Designs/workflow.canvas"));
  assert.equal(mock.folders.has("Designs"), true);
  assert.match(mock.content.get("Designs/workflow.canvas") ?? "", /Read context/);
  assert.ok(mock.progress.includes("Planning canvas design for Designs/workflow.canvas..."));
  assert.ok(mock.progress.includes("Canvas structure validated; writing artifact..."));
});

test("create_design_canvas creates lane-based architecture diagrams", async () => {
  const mock = createMockContext({
    prompt: "Create a software architecture diagram as an Obsidian canvas.",
  });

  const output = await createDesignCanvasTool.execute(
    {
      path: "Designs/architecture.canvas",
      title: "Agent Architecture",
      diagramType: "architecture",
      items: [
        {
          id: "user",
          title: "User",
          kind: "actor",
          lane: "Client",
          text: "Submits a mission.",
        },
        {
          id: "plugin",
          title: "Obsidian Plugin",
          kind: "service",
          lane: "Application",
          text: "Runs the agent loop.",
        },
        {
          id: "tools",
          title: "Tool Registry",
          kind: "service",
          lane: "Application",
          text: "Executes validated tools.",
        },
        {
          id: "vault",
          title: "Vault",
          kind: "database",
          lane: "Data",
          text: "Stores notes and artifacts.",
        },
      ],
      connections: [
        { from: "user", to: "plugin", label: "mission" },
        { from: "plugin", to: "tools", label: "tool call" },
        { from: "tools", to: "vault", label: "safe write" },
      ],
    },
    mock.context,
  );

  assert.equal((output as { diagramType: string }).diagramType, "architecture");
  assert.equal((output as { nodeCount: number }).nodeCount, 8);
  assert.equal((output as { edgeCount: number }).edgeCount, 3);
  assert.match(
    (output as { summary: string }).summary,
    /Canvas architecture planned: 8 nodes, 3 edges across 3 lanes\./,
  );
  const canvas = mock.content.get("Designs/architecture.canvas") ?? "";
  assert.match(canvas, /"label": "Application"/);
  assert.match(canvas, /"label": "safe write"/);
  assert.match(canvas, /_database_/);
  assert.ok(
    mock.progress.includes(
      "Canvas architecture planned: 8 nodes, 3 edges across 3 lanes.",
    ),
  );
});

test("create_svg_design creates an escaped SVG artifact", async () => {
  const mock = createMockContext({
    prompt: "Create an SVG software architecture diagram for the run details.",
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
          type: "diamond",
          x: 300,
          y: 80,
          width: 120,
          height: 90,
          label: "Decision",
        },
        {
          type: "cylinder",
          x: 470,
          y: 90,
          width: 140,
          height: 110,
          label: "Vault",
        },
        {
          type: "ellipse",
          cx: 540,
          cy: 280,
          rx: 80,
          ry: 38,
          label: "Model API",
        },
      ],
    },
    mock.context,
  );

  assert.equal((output as { path: string }).path, "Designs/run-details.svg");
  assert.equal((output as { shapeCount: number }).shapeCount, 4);
  assert.deepEqual((output as { shapeTypes: string[] }).shapeTypes, [
    "rect",
    "diamond",
    "cylinder",
    "ellipse",
  ]);
  const svg = mock.content.get("Designs/run-details.svg") ?? "";
  assert.match(svg, /Safe &lt;label&gt;/);
  assert.match(svg, /<polygon/);
  assert.match(svg, /<ellipse/);
  assert.match(svg, /<path/);
  assert.doesNotMatch(svg, /<script/);
  assert.ok(
    mock.progress.includes(
      "SVG design planned: 4 shapes (rect, diamond, cylinder, ellipse).",
    ),
  );
});

test("Canvas read and prepared patch preserve unrelated structure with exact hashes", async () => {
  const mock = createMockContext({
    prompt: "Revise the existing Canvas diagram title without replacing unrelated nodes.",
    now: new Date("2026-07-12T18:00:00.000Z"),
  });
  const path = "Designs/existing.canvas";
  mock.folders.add("Designs");
  const initial = JSON.stringify({
    nodes: [
      {
        id: "title",
        type: "text",
        x: 0,
        y: 0,
        width: 720,
        height: 120,
        text: "# Original title",
      },
      {
        id: "sentinel",
        type: "text",
        x: 0,
        y: 240,
        width: 360,
        height: 180,
        text: "Unrelated sentinel",
        futureField: { preserved: true },
      },
    ],
    edges: [
      {
        id: "title-to-sentinel",
        fromNode: "title",
        toNode: "sentinel",
        label: "preserve me",
      },
    ],
    futureTopLevel: { preserved: true },
  }, null, 2);
  mock.content.set(path, initial);

  const read = await readDesignCanvasTool.execute({ path }, mock.context) as {
    sha256: string;
    canvas: { nodes: Array<{ id: string }> };
  };
  assert.equal(read.sha256, await sha256DiagramContent(initial));
  assert.deepEqual(read.canvas.nodes.map((node) => node.id), ["title", "sentinel"]);

  const context = {
    ...mock.context,
    runId: "run-canvas-patch",
    operationId: "call-canvas-patch",
  };
  const prepared = await updateDesignCanvasTool.prepare!(
    {
      path,
      baseHash: read.sha256,
      operations: [
        { op: "update_node", id: "title", changes: { text: "# Revised title" } },
      ],
    },
    context,
  );
  if (!prepared.ok) assert.fail(prepared.error.message);
  assert.equal(prepared.action.expectedTargetRevision, read.sha256);
  assert.equal(prepared.action.preview.before?.sha256, read.sha256);
  const executed = await updateDesignCanvasTool.executePrepared!(
    prepared.action,
    {
      ...context,
      authorizedAction: {
        preparedActionId: prepared.action.id,
        payloadFingerprint: prepared.action.payloadFingerprint,
        grantId: "grant-canvas-patch",
      },
    },
  );
  const persisted = JSON.parse(mock.content.get(path) ?? "null") as any;
  assert.equal(persisted.nodes[0].text, "# Revised title");
  assert.deepEqual(persisted.nodes[1].futureField, { preserved: true });
  assert.deepEqual(persisted.futureTopLevel, { preserved: true });
  assert.equal(persisted.edges[0].label, "preserve me");
  assert.equal(executed.receipt.operation, "update");
  assert.equal(executed.receipt.readback.status, "verified");
  const output = executed.output as {
    beforeSha256: string;
    afterSha256: string;
    backupPath: string;
    backupSha256: string;
  };
  assert.equal(output.beforeSha256, read.sha256);
  assert.equal(output.afterSha256, await sha256DiagramContent(mock.content.get(path) ?? ""));
  assert.equal(output.backupSha256, read.sha256);
  assert.equal(mock.content.get(output.backupPath), initial);
});

test("Canvas patch preparation rejects a stale base hash without changing bytes", async () => {
  const mock = createMockContext({
    prompt: "Update the existing Canvas diagram safely.",
  });
  const path = "Designs/stale.canvas";
  mock.folders.add("Designs");
  const content = JSON.stringify({
    nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 300, height: 160, text: "A" }],
    edges: [],
  });
  mock.content.set(path, content);
  const operationsBefore = [...mock.operations];
  const prepared = await updateDesignCanvasTool.prepare!(
    {
      path,
      baseHash: `sha256:${"0".repeat(64)}`,
      operations: [{ op: "update_node", id: "a", changes: { text: "changed" } }],
    },
    { ...mock.context, runId: "run-stale", operationId: "call-stale" },
  );
  assert.equal(prepared.ok, false);
  assert.equal(mock.content.get(path), content);
  assert.deepEqual(mock.operations, operationsBefore);
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
  const progress: string[] = [];

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
    },
    originalPrompt: options.prompt ?? "Create a design artifact.",
    reportProgress: (message) => progress.push(message),
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
    progress,
    bytes: (path: string) => new TextEncoder().encode(content.get(path) ?? "").length,
  };
}
