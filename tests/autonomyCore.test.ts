import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateLoopBudget,
  resolveConfiguredMaxAgentSteps,
} from "../src/agent/runBudget";
import {
  appendAgentRunCheckpoint,
  getAgentRunCheckpointPath,
  readLatestAgentRunCheckpoint,
} from "../src/agent/checkpoints";
import {
  compactConversationForPrompt,
} from "../src/memory/contextCompaction";
import { buildVaultMetadataIndex } from "../src/memory/vaultIndex";
import {
  CHECKPOINT_EVERY_STEPS,
  LONG_RUN_STEP_WARN_AT,
  MAX_AGENT_STEPS,
} from "../src/tools/constants";
import type { AgentConversationMessage } from "../src/conversationHistory";
import type { ToolExecutionContext } from "../src/tools/types";

test("run budget keeps quick routes small and raises grounded cap to 100", () => {
  assert.equal(MAX_AGENT_STEPS, 100);
  assert.equal(CHECKPOINT_EVERY_STEPS, 5);
  assert.equal(LONG_RUN_STEP_WARN_AT, 15);
  assert.equal(
    estimateLoopBudget({
      route: "instant_local",
      configuredMaxSteps: 100,
    }),
    0,
  );
  assert.equal(
    estimateLoopBudget({
      route: "direct_writeback",
      configuredMaxSteps: 100,
    }),
    1,
  );
  assert.equal(
    estimateLoopBudget({
      route: "single_model_answer",
      expectedTimeClass: "quick",
      configuredMaxSteps: 100,
    }),
    2,
  );
  assert.equal(
    estimateLoopBudget({
      route: "grounded_workflow",
      expectedTimeClass: "long",
      slowPathReason: "needs_web_sources",
      configuredMaxSteps: 100,
    }),
    100,
  );
});

test("configured max agent steps remains a true upper cap", () => {
  assert.equal(resolveConfiguredMaxAgentSteps(999), 100);
  assert.equal(resolveConfiguredMaxAgentSteps(99), 99);
  assert.equal(resolveConfiguredMaxAgentSteps(4), 4);
  assert.equal(resolveConfiguredMaxAgentSteps(null), 100);
  assert.equal(
    estimateLoopBudget({
      route: "grounded_workflow",
      expectedTimeClass: "long",
      configuredMaxSteps: 4,
    }),
    4,
  );
  assert.equal(
    estimateLoopBudget({
      route: "tool_required",
      requestedSteps: 8,
      configuredMaxSteps: 3,
    }),
    3,
  );
});

test("conversation compaction keeps recent messages under prompt budget without persistence", () => {
  const history: AgentConversationMessage[] = [
    { role: "user", content: "older user request " + "a".repeat(80) },
    { role: "assistant", content: "older assistant reply " + "b".repeat(80) },
    { role: "user", content: "middle user request " + "c".repeat(80) },
    { role: "assistant", content: "middle assistant reply " + "d".repeat(80) },
    { role: "user", content: "recent user request" },
    { role: "assistant", content: "recent assistant reply" },
  ];

  const compacted = compactConversationForPrompt(history, {
    promptCharBudget: 190,
    summaryCharBudget: 220,
  });

  assert.ok(compacted.summary);
  assert.match(compacted.summary ?? "", /not persisted/);
  assert.ok(compacted.compactedCount > 0);
  assert.deepEqual(compacted.messages, [
    { role: "user", content: "recent user request" },
    { role: "assistant", content: "recent assistant reply" },
  ]);
  assert.equal(
    history.some((message) => /Earlier conversation summary/.test(message.content)),
    false,
  );
});

test("checkpoint helper appends visible markdown under Agent Runs", async () => {
  const mock = createCheckpointContext();

  const first = await appendAgentRunCheckpoint(mock.context, {
    runId: "run:test",
    step: 5,
    maxSteps: 30,
    status: "running",
    route: "grounded_workflow",
    toolNames: ["web_search"],
    message: "Collected first sources.",
    timestamp: new Date("2026-07-05T12:00:00.000Z"),
  });
  const second = await appendAgentRunCheckpoint(mock.context, {
    runId: "run:test",
    step: 10,
    maxSteps: 30,
    status: "running",
    route: "grounded_workflow",
    toolNames: ["web_fetch"],
    timestamp: new Date("2026-07-05T12:05:00.000Z"),
  });

  const path = getAgentRunCheckpointPath("run:test");
  assert.equal(path, "Agent Runs/run-test.md");
  assert.equal(first.path, path);
  assert.equal(second.path, path);
  assert.equal(mock.folders.has("Agent Runs"), true);
  assert.match(mock.files.get(path) ?? "", /^# Agent Run run-test/);
  assert.match(mock.files.get(path) ?? "", /## Step 5/);
  assert.match(mock.files.get(path) ?? "", /## Step 10/);
  assert.match(mock.files.get(path) ?? "", /- Tools: web_search/);
});

test("checkpoint helper reads the most recent Agent Runs checkpoint for resume", async () => {
  const mock = createCheckpointContext();

  await appendAgentRunCheckpoint(mock.context, {
    runId: "run:older",
    step: 5,
    maxSteps: 30,
    status: "running",
    route: "grounded_workflow",
    toolNames: ["web_search"],
    message: "Older checkpoint.",
    timestamp: new Date("2026-07-05T12:00:00.000Z"),
  });
  await appendAgentRunCheckpoint(mock.context, {
    runId: "run:latest",
    step: 10,
    maxSteps: 30,
    status: "running",
    route: "grounded_workflow",
    toolNames: ["web_fetch"],
    message: "Latest checkpoint.",
    timestamp: new Date("2026-07-05T12:05:00.000Z"),
  });

  const checkpoint = await readLatestAgentRunCheckpoint(mock.context, 1000);

  assert.equal(checkpoint?.path, "Agent Runs/run-latest.md");
  assert.match(checkpoint?.content ?? "", /Latest checkpoint/);
  assert.doesNotMatch(checkpoint?.content ?? "", /Older checkpoint/);
});

test("vault metadata index returns metadata only and never reads note content", () => {
  const mock = createVaultIndexContext();
  const index = buildVaultMetadataIndex(mock.context);

  assert.equal(mock.readCount, 0);
  assert.deepEqual(index, {
    files: [
      {
        path: "Projects/A.md",
        basename: "A",
        extension: "md",
        mtime: 100,
        headings: [{ heading: "Alpha", level: 1 }],
        tags: ["agent", "frontmatter"],
        links: [
          {
            link: "Projects/B",
            displayText: "B",
            original: "[[Projects/B|B]]",
          },
        ],
      },
      {
        path: "Projects/B.md",
        basename: "B",
        extension: "md",
        mtime: 200,
        headings: [],
        tags: [],
        links: [],
      },
    ],
    truncated: false,
    limit: 300,
  });
});

function createCheckpointContext() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const fileMtimes = new Map<string, number>();
  let mtime = 1000;
  const getFileByPath = (path: string) => {
    if (!files.has(path)) {
      return null;
    }

    return {
      path,
      basename: path.split("/").pop()?.replace(/\.md$/i, "") ?? path,
      extension: path.split(".").pop()?.toLowerCase() ?? "",
      stat: {
        ctime: fileMtimes.get(path) ?? 0,
        mtime: fileMtimes.get(path) ?? 0,
        size: files.get(path)?.length ?? 0,
      },
    };
  };

  const context = {
    app: {
      vault: {
        getFolderByPath: (path: string) =>
          folders.has(path) ? { path, name: path.split("/").pop() ?? path } : null,
        createFolder: async (path: string) => {
          folders.add(path);
        },
        getFileByPath,
        getFiles: () =>
          [...files.keys()]
            .map((path) => getFileByPath(path))
            .filter((file): file is NonNullable<typeof file> => Boolean(file)),
        cachedRead: async (file: { path: string }) => files.get(file.path) ?? "",
        create: async (path: string, content: string) => {
          files.set(path, content);
          fileMtimes.set(path, ++mtime);
        },
        read: async (file: { path: string }) => files.get(file.path) ?? "",
        modify: async (file: { path: string }, content: string) => {
          files.set(file.path, content);
          fileMtimes.set(file.path, ++mtime);
        },
      },
    },
  } as unknown as ToolExecutionContext;

  return {
    context,
    files,
    folders,
  };
}

function createVaultIndexContext() {
  let readCount = 0;
  const files = [
    {
      path: "Projects/A.md",
      basename: "A",
      extension: "md",
      stat: { mtime: 100 },
    },
    {
      path: "Projects/B.md",
      basename: "B",
      extension: "md",
      stat: { mtime: 200 },
    },
    {
      path: ".obsidian/private.md",
      basename: "private",
      extension: "md",
      stat: { mtime: 300 },
    },
    {
      path: "Assets/image.png",
      basename: "image",
      extension: "png",
      stat: { mtime: 400 },
    },
  ];
  const context = {
    app: {
      metadataCache: {
        getFileCache: (file: { path: string }) =>
          file.path === "Projects/A.md"
            ? {
                headings: [{ heading: "Alpha", level: 1 }],
                tags: [{ tag: "#agent" }],
                frontmatter: { tags: ["frontmatter"] },
                links: [
                  {
                    link: "Projects/B",
                    displayText: "B",
                    original: "[[Projects/B|B]]",
                  },
                ],
              }
            : null,
      },
      vault: {
        getFiles: () => files,
        cachedRead: () => {
          readCount += 1;
          throw new Error("vault index must not read note content");
        },
        read: () => {
          readCount += 1;
          throw new Error("vault index must not read note content");
        },
      },
    },
  } as unknown as ToolExecutionContext;

  return {
    context,
    get readCount() {
      return readCount;
    },
  };
}
