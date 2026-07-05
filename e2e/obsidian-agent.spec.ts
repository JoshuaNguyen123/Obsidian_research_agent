import { expect, test, chromium, type Browser, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  getE2EAiConfig,
  getE2ESemanticEmbeddingConfig,
  shouldRunRealAiE2E,
  type E2EAiConfig,
  type E2ESemanticEmbeddingConfig,
} from "./aiHarness";
import {
  generatedOutputPromptScenarios,
  type PromptScenario,
} from "./promptMatrix";

const execFileAsync = promisify(execFile);

const PLUGIN_ID = "agentic-researcher";
const DEFAULT_CDP_PORT = 11223;

const obsidianExe = process.env.OBSIDIAN_EXE ?? getDefaultObsidianExe();
const vaultRoot = process.env.OBSIDIAN_VAULT ?? getDefaultVaultRoot();
const cdpPort = Number.parseInt(
  process.env.OBSIDIAN_CDP_PORT ?? String(DEFAULT_CDP_PORT),
  10,
);
const pluginDataPath = path.join(
  vaultRoot,
  ".obsidian",
  "plugins",
  PLUGIN_ID,
  "data.json",
);
const communityPluginsPath = path.join(vaultRoot, ".obsidian", "community-plugins.json");
const obsidianAppStatePath = getObsidianAppStatePath();

test.describe.configure({ mode: "serial" });

test("clear chat allows prompt click type submit", async () => {
  await withE2EHarness(
    "clear-chat-submit",
    async ({ page, noteFilePath, input }) => {
      const persistedChat = "Persisted existing chat";
      await expectConversationHistory(page, persistedChat);

      await clearChatInline(page);
      await expectPromptClickable(page);
      await expectRunButtonClickable(page);

      const prompt = `Append this exact E2E marker to the current note: ${input.marker}`;
      const promptInput = page.locator("textarea.agentic-researcher-prompt");
      await promptInput.click();
      await page.keyboard.type(prompt);
      await submitMission(page, prompt, { alreadyEntered: true });

      await expectNoteToContain(
        noteFilePath,
        input.marker,
        "clear-chat submit should write the typed prompt marker",
      );
    },
    {
      conversationHistory: [
        {
          role: "assistant",
          content: `Persisted existing chat ${Date.now()}`,
        },
      ],
    },
  );
});

test("prompt textarea click edits at clicked position", async () => {
  await withE2EHarness("prompt-middle-click-edit", async ({ page }) => {
    const promptInput = page.locator("textarea.agentic-researcher-prompt");
    const prompt =
      "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda.";
    await promptInput.fill(prompt);
    await promptInput.evaluate((textarea) => {
      const input = textarea as HTMLTextAreaElement;
      input.setSelectionRange(input.value.length, input.value.length);
    });

    const box = await promptInput.boundingBox();
    assertBox(box);
    await page.mouse.click(box.x + 8, box.y + Math.min(18, box.height / 2));
    await page.keyboard.type("START ");

    const value = await promptInput.inputValue();
    expect(value.startsWith("START ")).toBe(true);
    expect(value.endsWith("START ")).toBe(false);
  });
});

test("append mission writes current note", async () => {
  await withE2EHarness("append-current-note", async ({ page, noteFilePath, input }) => {
    const prompt = `Append this exact E2E marker to the current note: ${input.marker}`;

    await submitMission(page, prompt);
    await expectNoteToContain(
      noteFilePath,
      input.marker,
      "append mission should write the marker",
    );
    await expectReceipt(page, "append");
  });
});

test("prior assistant writeback appends previous response", async () => {
  await withE2EHarness("prior-assistant-writeback", async ({ page, noteFilePath, input }) => {
    await seedConversationHistory(page, [
      {
        role: "assistant",
        content: input.priorEssay,
      },
    ]);

    await submitMission(page, "Can you write this essay onto the page?");
    await expectNoteToContain(
      noteFilePath,
      input.priorEssay,
      "prior assistant writeback should append the prior response",
    );
    await expectReceipt(page, "append");
  });
});

test("streaming writeback writes early and final chunks", async () => {
  await withE2EHarness("streaming-writeback", async ({ page, noteFilePath, input }) => {
    const prompt = `In this note, write a short streaming E2E update containing ${input.streamChunkOne} and ${input.streamChunkTwo}.`;
    await setStreamingMode(page, true);
    await submitMission(page, prompt, { waitForCompletion: false });

    await expectNoteToContain(
      noteFilePath,
      input.streamChunkOne,
      "first streaming chunk should appear before completion",
      10_000,
    );
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: input.streamChunkOne,
      }),
    ).toBeVisible();

    await waitForMissionComplete(page, 45_000);
    await assertMockModelUsed(page);
    await expectNoteToContain(
      noteFilePath,
      input.streamChunkTwo,
      "second streaming chunk should appear after completion",
      10_000,
    );
  });
});

test("folder traversal uses inspect_vault_context", async () => {
  await withE2EHarness("folder-traversal", async ({ page, input }) => {
    await setStreamingMode(page, false);
    await submitMission(page, "What do the other notes in the other folders say?");

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: input.folderAnswerMarker,
      }),
    ).toBeVisible();
    await expectToolRun(page, "inspect_vault_context");
  });
});

test("semantic vault search uses semantic_search_notes", async () => {
  await withE2EHarness("semantic-vault-search", async ({ page, input }) => {
    await setStreamingMode(page, false);
    await submitMission(
      page,
      `What do my notes say about E2E_SEMANTIC_SEARCH ${input.folderAnswerMarker} themes?`,
    );

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: input.folderAnswerMarker,
      }),
    ).toBeVisible();
    await expectToolRun(page, "inspect_semantic_index");
    await expectToolRun(page, "semantic_search_notes");
    await expectNoReceipts(page);
  });
});

test("web research writes mission ledger evidence and resumes by run id", async () => {
  await withE2EHarness("web-ledger-resume", async ({ page }) => {
    await setStreamingMode(page, false);

    await submitMission(
      page,
      "Use web sources and citations for E2E_WEB_LEDGER_SOURCE. Give a concise sourced answer.",
      { timeout: 120_000 },
    );
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_WEB_LEDGER_DONE",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectToolRun(page, "web_search");
    await expectToolRun(page, "web_fetch");

    const ledger = await expectLatestMissionLedger(page, [
      "Mission Ledger",
      "E2E Web Ledger Source",
      "https://example.com/e2e-ledger-source",
      "\"kind\": \"web_source\"",
    ]);

    await submitMission(page, `continue run ${ledger.runId}`, {
      timeout: 120_000,
    });
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: `E2E_RESUME_LEDGER_${ledger.runId}`,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectConversationHistoryMissing(page, "Structured Agent Runs mission ledger");
  });
});

test("broad vault mutation does not write without explicit scope", async () => {
  await withE2EHarness("broad-vault-no-write", async ({ page, noteFilePath }) => {
    const marker = "E2E_BROAD_NO_WRITE_MARKER";
    await submitMission(page, `Update my whole vault with ${marker}.`, {
      timeout: 120_000,
    });

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_BROAD_NO_WRITE_BLOCKED",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectNoReceipts(page);
    await expectFileNotToContain(
      noteFilePath,
      marker,
      "broad unscoped mutation should not write to the active note",
    );
  });
});

test("file-scoped write touches only the requested path", async () => {
  await withE2EHarness("file-scoped-write", async ({ page, noteFilePath }) => {
    const scopedPath = "E2E Agent Tests/Scoped Folder/scoped-output.md";
    const scopedFilePath = path.join(vaultRoot, ...scopedPath.split("/"));
    const marker = "E2E_FOLDER_SCOPE_MARKER";

    await rm(scopedFilePath, { force: true });
    await submitMission(
      page,
      `Create ${scopedPath} with ${marker}. Only write to that requested file.`,
      { timeout: 120_000 },
    );

    await expectFileToContain(
      scopedFilePath,
      marker,
      "file-scoped write should create the requested file",
      20_000,
    );
    await expectFileNotToContain(
      noteFilePath,
      marker,
      "file-scoped write should not touch the active note",
    );
    await expectReceipt(page, scopedPath);
  });
});

test("CRUD mission reads creates writes updates moves and trashes explicit path", async () => {
  await withE2EHarness("crud-capabilities", async ({ page, noteFilePath, input }) => {
    const basePath = `E2E Agent Tests/CRUD Chain/${input.marker}`;
    const initialPath = `${basePath}/crud-target-${input.marker}.md`;
    const movedPath = `${basePath}/crud-target-${input.marker}-moved.md`;
    const initialFilePath = path.join(vaultRoot, ...initialPath.split("/"));
    const movedFilePath = path.join(vaultRoot, ...movedPath.split("/"));

    await submitMission(
      page,
      [
        `E2E_CRUD_CHAIN ${input.marker}: read the current note,`,
        `create folder ${basePath}, create file ${initialPath},`,
        `append APPEND:${input.secondMarker} to it, replace that file,`,
        `move it to ${movedPath}, then trash ${movedPath}.`,
      ].join(" "),
      { timeout: 180_000 },
    );

    for (const toolName of [
      "read_current_file",
      "create_folder",
      "create_file",
      "append_file",
      "replace_file",
      "move_path",
      "delete_path",
    ]) {
      await expectToolRun(page, toolName);
    }

    await expectReceipt(page, "create_folder");
    await expectReceipt(page, "create");
    await expectReceipt(page, "append");
    await expectReceipt(page, "replace");
    await expectReceipt(page, "move");
    await expectReceipt(page, "trash");
    await expectReceipt(page, ".agent-backups");

    await expectBackupToContain(
      `APPEND:${input.secondMarker}`,
      "replace_file should back up the created-and-appended content before replacement",
    );
    await expectFileToBeAbsent(
      initialFilePath,
      "moved CRUD source path should no longer exist",
    );
    await expectFileToBeAbsent(
      movedFilePath,
      "deleted CRUD destination path should be trashed",
    );
    await expectFileNotToContain(
      noteFilePath,
      `APPEND:${input.secondMarker}`,
      "path CRUD smoke should not write CRUD payload into the active note",
    );
  });
});

test("autonomous loop respects bounded tool budget and checkpoints", async () => {
  test.setTimeout(600_000);
  await withE2EHarness("autonomous-loop-depth", async ({ page }) => {
    await setStreamingMode(page, false);

    for (const steps of [1, 5, 10, 15, 25, 30]) {
      const marker = `E2E_LOOP_DONE_${steps}`;
      const expectedRenderedStep = Math.min(steps, 5);
      await submitMission(
        page,
        `Inspect the current note graph for E2E_LOOP_STEPS_${steps} and complete exactly ${steps} model steps before the final answer.`,
        { timeout: 300_000 },
      );
      await expect(
        page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
          hasText: marker,
        }),
      ).toBeVisible({ timeout: 30_000 });
      await page.getByRole("tab", { name: "Run Details" }).click();
      await expect(
        page.locator(".agentic-researcher-dashboard-section-planning", {
          hasText: `Step ${expectedRenderedStep}/`,
        }),
      ).toBeVisible({ timeout: 30_000 });
      if (steps > 1) {
        await expectToolRun(page, "get_note_graph_context");
      }
      if (steps >= 5) {
        await expectLatestAgentCheckpoint(page, `- Step: ${expectedRenderedStep} of`);
        await expectLatestAgentCheckpoint(page, "- Route: grounded_workflow");
      }
    }
  });
});

test("native design drawing creates canvas and svg artifacts", async () => {
  await withE2EHarness("native-design-artifacts", async ({ page, input }) => {
    const canvasFilePath = path.join(vaultRoot, ...input.designCanvasPath.split("/"));
    const svgFilePath = path.join(vaultRoot, ...input.designSvgPath.split("/"));

    await submitMission(
      page,
      "Draw E2E_DESIGN_CANVAS as an Obsidian canvas design for the product flow.",
    );
    await expectFileToContain(
      canvasFilePath,
      '"nodes"',
      "canvas artifact should contain JSON Canvas nodes",
    );
    await expectFileToContain(
      canvasFilePath,
      "Product Flow",
      "canvas artifact should include the requested product flow",
    );
    await expectToolRun(page, "create_design_canvas");
    await expectReceipt(page, input.designCanvasPath);
    await expectVerification(page, "Canvas verified");

    await submitMission(
      page,
      "Create E2E_DESIGN_SVG as an SVG wireframe mockup for the settings screen.",
    );
    await expectFileToContain(
      svgFilePath,
      "<svg",
      "svg artifact should contain SVG markup",
    );
    await expectFileToContain(
      svgFilePath,
      "Settings",
      "svg artifact should include the settings label",
    );
    await expectToolRun(page, "create_svg_design");
    await expectReceipt(page, input.designSvgPath);
    await expectVerification(page, "SVG verified");
  });
});

test("prompt-on-page folder traversal writes findings", async () => {
  await withE2EHarness("prompt-on-page-traversal", async ({ page, notePath, noteFilePath, input }) => {
    const notepagePrompt = [
      "You job is to traverse the 3 untitled folders. They are named Untitled, Untitled 1 and Untitled 2.",
      "",
      "I need you to tell me about the things discovered in those folders. Specifically, I want you to stream them onto this page.",
    ].join("\n");

    await setActiveNoteContent(page, notePath, notepagePrompt);
    await setStreamingMode(page, true);
    await submitMission(page, "Refer  to the notes in the notepage as the prompt");

    await expectNoteToContain(
      noteFilePath,
      input.notepageFindingMarker,
      "prompt-on-page traversal should write findings",
    );
    await expectNoteToContain(
      noteFilePath,
      input.targetFolderMarkerOne,
      "prompt-on-page traversal should include the Untitled folder marker",
    );
    await expect(
      page.locator(".agentic-researcher-log-message", {
        hasText: "I could not get the model to request vault tools",
      }),
    ).toHaveCount(0);
    await expectToolRun(page, "inspect_vault_context");
    await expectReceipt(page, "append");
  });
});

test("replace current page writes backup and removes old content", async () => {
  await withE2EHarness("replace-current-page", async ({ page, notePath, noteFilePath, input }) => {
    await setActiveNoteContent(
      page,
      notePath,
      `# Old E2E Page\n\n${input.marker}\n${input.secondMarker}\n`,
    );
    await setStreamingMode(page, true);
    await submitMission(
      page,
      `I want you to delete all the notes on the page and then write a 300 word essay on the renaissance containing ${input.replaceMarker}.`,
    );

    await expectNoteToContain(
      noteFilePath,
      input.replaceMarker,
      "replace-current-page should write replacement content",
    );
    const replacedContent = await readFile(noteFilePath, "utf8");
    expect(replacedContent).not.toContain(input.secondMarker);
    await expectReceipt(page, "replace");
    await expectReceipt(page, ".agent-backups");
  });
});

test("revision approval follow-up replaces current essay with backup", async () => {
  await withE2EHarness("followup-essay-revision", async ({ page, notePath, noteFilePath, input }) => {
    await setActiveNoteContent(
      page,
      notePath,
      `# Revision E2E\n\nThin original paragraph ${input.secondMarker}.\n`,
    );
    await setStreamingMode(page, true);
    await seedConversationHistory(page, [
      {
        role: "assistant",
        content: `I'll revise the essay to add more detail and include ${input.revisionMarker}. Let me update the current section with an expanded version.`,
      },
    ]);

    await submitMission(page, "Go ahead and revise");

    await expectNoteToContain(
      noteFilePath,
      input.revisionMarker,
      "revision follow-up should write replacement content",
    );
    const replacedContent = await readFile(noteFilePath, "utf8");
    expect(replacedContent).not.toContain(input.secondMarker);
    await expectBackupToContain(
      input.secondMarker,
      "revision follow-up should preserve the old essay in a backup",
    );
    await expectReceipt(page, "replace");
    await expectReceipt(page, ".agent-backups");
  });
});

test("generated output prompt matrix writes notes and artifacts", async () => {
  test.setTimeout(900_000);
  const mockScenarios = generatedOutputPromptScenarios.filter(
    (scenario) => scenario.mode !== "real",
  );

  await withE2EHarness("generated-output-matrix", async ({ page, noteFilePath, input }) => {
    await setStreamingMode(page, true);

    for (const scenario of mockScenarios) {
      await runGeneratedPromptScenario(page, noteFilePath, input, scenario, {
        assertMock: true,
      });
    }
  });
});

test.describe("real ai generated output", () => {
  test("opt-in smoke subset writes notes and verifies word count without safety-limit stop", async () => {
    test.skip(
      !shouldRunRealAiE2E(),
      "Set E2E_REAL_AI=1 and E2E_AI_MODE=real to run real-AI e2e. Credentials are read from the plugin unless E2E_OLLAMA_API_KEY overrides them.",
    );
    test.setTimeout(1_800_000);
    const realAiConfig = getE2EAiConfig();
    const realScenarios = [
      "gilgamesh-500",
      "revolutionary-war-100",
      "grapes-cited",
    ].map((name) => getPromptScenario(name));

    await withE2EHarness(
      "real-ai-generated-output",
      async ({ page, notePath, noteFilePath, input }) => {
        await setStreamingMode(page, true, {
          aiConfig: realAiConfig,
          aiMode: "real",
        });

        for (const [index, scenario] of realScenarios.entries()) {
          await runGeneratedPromptScenario(page, noteFilePath, input, scenario, {
            assertMock: false,
          });
          if (scenario.name === "gilgamesh-500") {
            await waitBetweenRealAiCalls(page, realAiConfig);
            await submitMission(
              page,
              "Use the count_words tool to count the words in the current note.",
              {
                timeout: realAiConfig.missionTimeoutMs,
                assertMock: false,
              },
            );
            await expectToolRun(page, "count_words");
          }
          if (index < realScenarios.length - 1) {
            await waitBetweenRealAiCalls(page, realAiConfig);
          }
        }

        await waitBetweenRealAiCalls(page, realAiConfig);
        const oldMarker = `E2E_REAL_DELETE_OLD_${Date.now()}`;
        await setActiveNoteContent(page, notePath, `# Old note\n\n${oldMarker}\n`);
        await submitMission(
          page,
          "Delete the current note. Ensure that the space is empty. I want you to write now, a 300 word essay on Grapes of Wrath.",
          {
            timeout: realAiConfig.missionTimeoutMs,
            assertMock: false,
          },
        );
        await expectNoteToContain(
          noteFilePath,
          "Grapes",
          "real delete-plus-write should replace the note with generated content",
          realAiConfig.completionTimeoutMs,
        );
        await expectNoteToContain(
          noteFilePath,
          "Wrath",
          "real delete-plus-write should stay on topic",
          realAiConfig.completionTimeoutMs,
        );
        const replacedContent = await readFile(noteFilePath, "utf8");
        expect(replacedContent).not.toContain(oldMarker);
        await expectReceipt(page, "replace");
        await expectNoSafetyLimit(page);
      },
      {
        aiMode: "real",
        aiConfig: realAiConfig,
      },
    );
  });
});

function getPromptScenario(name: string): PromptScenario {
  const scenario = generatedOutputPromptScenarios.find((item) => item.name === name);
  if (!scenario) {
    throw new Error(`Missing prompt scenario: ${name}`);
  }
  return scenario;
}

test("research memory save clear reload recall", async () => {
  await withE2EHarness("research-memory", async ({ page, input }) => {
    const memoryPath = path.join(
      vaultRoot,
      "E2E Agent Tests",
      "Agent Memory",
      "Research",
      `${slugifyForE2e(input.memoryTopic)}.md`,
    );

    await submitMission(
      page,
      `Save this to research memory for ${input.memoryTopic}: ${input.memoryMarker}`,
    );
    await expectFileToContain(
      memoryPath,
      input.memoryMarker,
      "research memory note should be written in the vault",
    );

    await clearChatInline(page);
    await reloadAssistantPanel(page);
    await submitMission(page, `Continue this research from memory: ${input.memoryTopic}`);

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: input.memoryMarker,
      }),
    ).toBeVisible();
  });
});

interface E2EInput {
  marker: string;
  secondMarker: string;
  priorEssay: string;
  streamChunkOne: string;
  streamChunkTwo: string;
  folderAnswerMarker: string;
  notepageFindingMarker: string;
  targetFolderMarkerOne: string;
  targetFolderMarkerTwo: string;
  targetFolderMarkerThree: string;
  replaceMarker: string;
  revisionMarker: string;
  memoryTopic: string;
  memoryMarker: string;
  designCanvasPath: string;
  designSvgPath: string;
  notePath: string;
}

interface E2EHarnessContext {
  page: Page;
  notePath: string;
  noteFilePath: string;
  input: E2EInput;
}

interface SubmitMissionOptions {
  alreadyEntered?: boolean;
  timeout?: number;
  waitForCompletion?: boolean;
  assertMock?: boolean;
}

async function withE2EHarness(
  label: string,
  runScenario: (context: E2EHarnessContext) => Promise<void>,
  options: {
    conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
    aiMode?: "mock" | "real";
    aiConfig?: E2EAiConfig;
    semanticEmbeddingConfig?: E2ESemanticEmbeddingConfig;
  } = {},
) {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e is Windows-only.");

  if (!Number.isInteger(cdpPort) || cdpPort <= 0) {
    throw new Error(`Invalid OBSIDIAN_CDP_PORT: ${String(process.env.OBSIDIAN_CDP_PORT)}`);
  }

  const dataBefore = await readOptionalFile(pluginDataPath);
  const communityPluginsBefore = await readOptionalFile(communityPluginsPath);
  const obsidianAppStateBefore = await readOptionalFile(obsidianAppStatePath);
  const input = createE2EInput(label);
  const noteFilePath = path.join(vaultRoot, ...input.notePath.split("/"));
  let browser: Browser | null = null;
  let obsidianProcess: ChildProcessWithoutNullStreams | null = null;

  await expectPortFree(cdpPort);

  try {
    await expectNoRunningObsidian();
    await forceOnlyTestVaultOpen(
      obsidianAppStatePath,
      obsidianAppStateBefore,
      vaultRoot,
    );
    await seedPluginConversationHistory(
      pluginDataPath,
      dataBefore,
      options.conversationHistory ?? [],
    );
    await ensureCommunityPluginEnabled(communityPluginsPath, PLUGIN_ID);
    obsidianProcess = await launchObsidian();
    await waitForCdp(cdpPort, obsidianProcess, 45_000);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await getOnlyObsidianVaultPage(browser, vaultRoot);
    const setupResult = await setupVaultNoteAndMockModel(
      page,
      input,
      options.aiMode ?? "mock",
      options.aiConfig ?? getE2EAiConfig(),
      options.semanticEmbeddingConfig ?? getE2ESemanticEmbeddingConfig(),
    );

    expect(setupResult.activeFilePath).toBe(input.notePath);
    expect(setupResult.pluginId).toBe(PLUGIN_ID);
    await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(page.getByRole("tab", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Run Details" })).toBeVisible();
    await expect(page.locator("textarea.agentic-researcher-prompt")).toBeVisible();
    if ((options.aiMode ?? "mock") === "mock") {
      await assertHarnessMockReady(page);
    } else {
      await assertHarnessRealAiReady(page, options.aiConfig ?? getE2EAiConfig());
    }
    if ((options.conversationHistory ?? []).length > 0) {
      await seedConversationHistory(page, options.conversationHistory ?? []);
    }

    await runScenario({
      page,
      notePath: input.notePath,
      noteFilePath,
      input,
    });
  } finally {
    await browser?.close().catch(() => undefined);
    await terminateObsidian(obsidianProcess);
    await restoreOptionalFile(obsidianAppStatePath, obsidianAppStateBefore);
    await restoreOptionalFile(pluginDataPath, dataBefore);
    await restoreOptionalFile(communityPluginsPath, communityPluginsBefore);
  }
}

function createE2EInput(label: string): E2EInput {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;

  return {
    marker: `E2E_MARKER_${id}`,
    secondMarker: `E2E_SECOND_MARKER_${id}`,
    priorEssay: `E2E prior assistant essay ${id} about Obsidian writeback.`,
    streamChunkOne: `E2E_STREAM_CHUNK_ONE_${id}`,
    streamChunkTwo: `E2E_STREAM_CHUNK_TWO_${id}`,
    folderAnswerMarker: `E2E_FOLDER_TRAVERSAL_${id}`,
    notepageFindingMarker: `E2E_NOTEPAGE_FINDINGS_${id}`,
    targetFolderMarkerOne: `E2E_UNTITLED_ONE_${id}`,
    targetFolderMarkerTwo: `E2E_UNTITLED_TWO_${id}`,
    targetFolderMarkerThree: `E2E_UNTITLED_THREE_${id}`,
    replaceMarker: `E2E_REPLACE_PAGE_${id}`,
    revisionMarker: `E2E_REVISION_REPLACE_${id}`,
    memoryTopic: `E2E memory topic ${id}`,
    memoryMarker: `E2E_MEMORY_MARKER_${id}`,
    designCanvasPath: `Designs/e2e-product-flow-${id}.canvas`,
    designSvgPath: `Designs/e2e-settings-wireframe-${id}.svg`,
    notePath: `E2E Agent Tests/${label}-${id}.md`,
  };
}

async function submitMission(
  page: Page,
  prompt: string,
  options: SubmitMissionOptions = {},
) {
  await page.getByRole("tab", { name: "Chat" }).click();
  const promptInput = page.locator("textarea.agentic-researcher-prompt");
  const runButton = page.locator("button.agentic-researcher-run");

  if (!options.alreadyEntered) {
    await promptInput.fill(prompt);
  }
  await expect(promptInput).toHaveValue(prompt);

  await runButton.click();
  await expect(
    page.locator(".agentic-researcher-log-user .agentic-researcher-log-message", {
      hasText: prompt,
    }).last(),
  ).toBeVisible({ timeout: 5_000 });

  if (options.waitForCompletion === false) {
    return;
  }

  await waitForMissionComplete(page, options.timeout ?? 60_000);
  if (options.assertMock !== false) {
    await assertMockModelUsed(page);
  }
  await page.getByRole("tab", { name: "Chat" }).click();
}

async function waitForMissionComplete(page: Page, timeout = 60_000) {
  const runButton = page.locator("button.agentic-researcher-run");
  await expect(runButton).toHaveText("Run Mission", { timeout });
  await expect(runButton).toBeEnabled();
  await expect(page.locator(".agentic-researcher-run-status-text")).toHaveText(
    "Idle",
  );
}

async function assertHarnessMockReady(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(({ pluginId }) => {
          const obsidianWindow = window as typeof window & { app?: any };
          const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
          const client = plugin?.createModelClient?.();
          const viewPlugins =
            obsidianWindow.app?.workspace
              ?.getLeavesOfType?.("agentic-researcher-view")
              ?.map((leaf: { view?: { plugin?: unknown } }) => leaf.view?.plugin)
              ?? [];
          return {
            model: plugin?.settings?.model ?? "",
            mockInstalled: Boolean(plugin?.__playwrightE2EMockInstalled),
            clientMock: Boolean(client?.playwrightE2EMock),
            viewMockInstalled: viewPlugins.every((viewPlugin: any) =>
              Boolean(viewPlugin?.__playwrightE2EMockInstalled),
            ),
          };
        }, { pluginId: PLUGIN_ID }),
      { message: "e2e harness should install the mock model before running" },
    )
    .toEqual({
      model: "playwright-e2e-mock",
      mockInstalled: true,
      clientMock: true,
      viewMockInstalled: true,
    });
}

async function assertMockModelUsed(page: Page) {
  await page.getByRole("tab", { name: "Run Details" }).click();
  await expect(
    page.locator(".agentic-researcher-details-panel", {
      hasText: "model=playwright-e2e-mock",
    }),
  ).toBeVisible({ timeout: 5_000 });
}

async function assertHarnessRealAiReady(page: Page, aiConfig: E2EAiConfig) {
  await expect
    .poll(
      () =>
        page.evaluate(({ pluginId }) => {
          const obsidianWindow = window as typeof window & { app?: any };
          const settings =
            obsidianWindow.app?.plugins?.plugins?.[pluginId]?.settings ?? {};
          return {
            model: settings.model ?? "",
            baseUrl: settings.ollamaBaseUrl ?? "",
            streamWritebackMode: settings.streamWritebackMode ?? "",
          };
        }, { pluginId: PLUGIN_ID }),
      { message: "e2e harness should install real AI settings before running" },
    )
    .toEqual({
      model: aiConfig.model,
      baseUrl: aiConfig.baseUrl,
      streamWritebackMode: "all_current_note_content_writes",
    });
}

async function expectNoteToContain(
  noteFilePath: string,
  expected: string,
  message: string,
  timeout = 15_000,
) {
  await expectFileToContain(noteFilePath, expected, message, timeout);
}

async function expectFileToContain(
  filePath: string,
  expected: string,
  message: string,
  timeout = 15_000,
) {
  await expect
    .poll(async () => (await readOptionalFile(filePath)) ?? "", {
      message,
      timeout,
    })
    .toContain(expected);
}

async function expectFileNotToContain(
  filePath: string,
  unexpected: string,
  message: string,
  timeout = 15_000,
) {
  await expect
    .poll(async () => (await readOptionalFile(filePath)) ?? "", {
      message,
      timeout,
    })
    .not.toContain(unexpected);
}

async function expectFileToBeAbsent(
  filePath: string,
  message: string,
  timeout = 15_000,
) {
  await expect
    .poll(async () => (await readOptionalFile(filePath)) === null, {
      message,
      timeout,
    })
    .toBe(true);
}

async function expectBackupToContain(
  expected: string,
  message: string,
  timeout = 15_000,
) {
  const backupRoot = path.join(vaultRoot, ".agent-backups");
  await expect
    .poll(
      async () => {
        const files = await listFilesRecursively(backupRoot);
        for (const filePath of files) {
          const content = await readOptionalFile(filePath);
          if (content?.includes(expected)) {
            return true;
          }
        }

        return false;
      },
      {
        message,
        timeout,
      },
    )
    .toBe(true);
}

async function expectReceipt(page: Page, text: string) {
  await page.getByRole("tab", { name: "Run Details" }).click();
  await expect(
    page.locator(".agentic-researcher-receipt", { hasText: text }).first(),
  ).toBeVisible();
}

async function expectNoReceipts(page: Page) {
  await page.getByRole("tab", { name: "Run Details" }).click();
  await expect(page.locator(".agentic-researcher-receipt")).toHaveCount(0);
}

async function expectToolRun(page: Page, toolName: string) {
  await page.getByRole("tab", { name: "Run Details" }).click();
  await expect(
    page.locator(".agentic-researcher-tool-item", { hasText: toolName }).first(),
  ).toBeVisible();
}

async function expectVerification(page: Page, text: string) {
  await page.getByRole("tab", { name: "Run Details" }).click();
  await expect(
    page.locator(".agentic-researcher-verification-row", { hasText: text }).first(),
  ).toBeVisible();
}

async function expectLatestAgentCheckpoint(page: Page, text: string) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const obsidianWindow = window as typeof window & { app?: any };
          const app = obsidianWindow.app;
          const files =
            typeof app?.vault?.getFiles === "function"
              ? app.vault.getFiles()
              : [];
          const checkpoints = files
            .filter(
              (file: { path?: string; extension?: string }) =>
                file.extension === "md" &&
                /^Agent Runs\/[^/]+\.md$/i.test(file.path ?? ""),
            )
            .sort(
              (
                a: { stat?: { mtime?: number } },
                b: { stat?: { mtime?: number } },
              ) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0),
            );
          const latest = checkpoints[0];
          return latest ? await app.vault.cachedRead(latest) : "";
        }),
      { message: `latest checkpoint should contain ${text}`, timeout: 20_000 },
    )
    .toContain(text);
}

async function expectLatestMissionLedger(page: Page, expectedText: string[]) {
  await expect
    .poll(
      async () => (await readLatestMissionLedger(page))?.runId ?? "",
      {
        message: "latest mission ledger should be readable",
        timeout: 20_000,
      },
    )
    .not.toBe("");

  const ledger = await readLatestMissionLedger(page);
  if (!ledger) {
    throw new Error("Expected a latest mission ledger.");
  }

  for (const text of expectedText) {
    expect(ledger.content).toContain(text);
  }

  return ledger;
}

async function readLatestMissionLedger(page: Page): Promise<{
  path: string;
  runId: string;
  content: string;
} | null> {
  return page.evaluate(async () => {
    const obsidianWindow = window as typeof window & { app?: any };
    const app = obsidianWindow.app;
    const files =
      typeof app?.vault?.getFiles === "function" ? app.vault.getFiles() : [];
    const ledgers = files
      .filter(
        (file: { path?: string; extension?: string }) =>
          file.extension === "md" &&
          /^Agent Runs\/[^/]+\.md$/i.test(file.path ?? ""),
      )
      .sort(
        (
          a: { stat?: { mtime?: number } },
          b: { stat?: { mtime?: number } },
        ) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0),
      );
    const latest = ledgers[0];
    if (!latest) {
      return null;
    }

    const content = await app.vault.cachedRead(latest);
    const jsonBlock = /```json\s*([\s\S]*?)```/i.exec(content);
    if (!jsonBlock) {
      return null;
    }

    try {
      const parsed = JSON.parse(jsonBlock[1]) as { runId?: unknown };
      const runId = typeof parsed.runId === "string" ? parsed.runId : "";
      return runId ? { path: latest.path, runId, content } : null;
    } catch {
      return null;
    }
  });
}

async function runGeneratedPromptScenario(
  page: Page,
  noteFilePath: string,
  input: E2EInput,
  scenario: PromptScenario,
  options: { assertMock: boolean },
) {
  const beforeNoteContent = (await readOptionalFile(noteFilePath)) ?? "";
  await submitMission(page, scenario.prompt, {
    timeout: scenario.timeoutMs,
    assertMock: options.assertMock,
  });
  await expectNoSafetyLimit(page);
  await expectNoRawToolMarkup(page);

  for (const toolName of scenario.expectTools ?? []) {
    await expectToolRun(page, toolName);
  }

  if (scenario.expectArtifact === ".canvas") {
    const canvasFilePath = path.join(vaultRoot, ...input.designCanvasPath.split("/"));
    await expectFileToContain(
      canvasFilePath,
      '"nodes"',
      "generated diagram should create a canvas file",
      scenario.timeoutMs,
    );
    for (const term of scenario.requiredTerms) {
      await expectFileToContain(
        canvasFilePath,
        term,
        `generated diagram should contain ${term}`,
        scenario.timeoutMs,
      );
    }
    await expectCanvasContentNodeCount(canvasFilePath, 3, scenario.timeoutMs);
    await expectReceipt(page, ".canvas");
    return;
  }

  if (scenario.expectNoteWrite) {
    for (const term of scenario.requiredTerms) {
      await expectNoteToContain(
        noteFilePath,
        term,
        `generated output should write ${term} to the note`,
        scenario.timeoutMs,
      );
    }
    const afterNoteContent = (await readOptionalFile(noteFilePath)) ?? "";
    const newText = getNewlyGeneratedText(beforeNoteContent, afterNoteContent);
    if (scenario.name === "grapes-stream-title") {
      expect(afterNoteContent).toMatch(/^# Harvest of Injustice/m);
      expect(
        afterNoteContent.match(/^# Harvest of Injustice/gm)?.length ?? 0,
        "streamed generated H1 should retitle the note instead of duplicating in the body",
      ).toBe(1);
    }
    for (const term of scenario.requiredNewTextTerms ?? []) {
      expect(newText, `${scenario.name} should generate meaningful text containing ${term}`).toMatch(
        new RegExp(escapeRegExp(term), "i"),
      );
    }
    if (scenario.minNewWords !== undefined) {
      expect(
        countWords(newText),
        `${scenario.name} should generate at least ${scenario.minNewWords} words of new text`,
      ).toBeGreaterThanOrEqual(scenario.minNewWords);
    }
  }

  if (scenario.expectReceipt) {
    await expectReceipt(page, "append");
  }
}

async function waitBetweenRealAiCalls(page: Page, aiConfig: E2EAiConfig) {
  if (aiConfig.interCallPauseMs <= 0) {
    return;
  }

  await page.waitForTimeout(aiConfig.interCallPauseMs);
}

function getNewlyGeneratedText(before: string, after: string) {
  return after.startsWith(before) ? after.slice(before.length) : after;
}

function countWords(text: string) {
  return text.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)?/g)?.length ?? 0;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectNoSafetyLimit(page: Page) {
  await page.getByRole("tab", { name: "Run Details" }).click();
  await expect(
    page.locator(".agentic-researcher-details-panel", {
      hasText: "Stopped at safety limit",
    }),
  ).toHaveCount(0);
}

async function expectNoRawToolMarkup(page: Page) {
  await page.getByRole("tab", { name: "Chat" }).click();
  await expect(
    page.locator(".agentic-researcher-log-message", {
      hasText: "<tool_call",
    }),
  ).toHaveCount(0);
}

async function expectCanvasNodeCount(
  canvasFilePath: string,
  expectedNodeCount: number,
  timeout = 15_000,
) {
  await expect
    .poll(
      async () => {
        const raw = await readOptionalFile(canvasFilePath);
        if (!raw) {
          return -1;
        }

        try {
          const parsed = JSON.parse(raw) as { nodes?: unknown[] };
          return Array.isArray(parsed.nodes) ? parsed.nodes.length : -1;
        } catch {
          return -1;
        }
      },
      {
        message: `canvas should contain ${expectedNodeCount} nodes`,
        timeout,
      },
    )
    .toBe(expectedNodeCount);
}

async function expectCanvasContentNodeCount(
  canvasFilePath: string,
  expectedNodeCount: number,
  timeout = 15_000,
) {
  await expect
    .poll(
      async () => {
        const raw = await readOptionalFile(canvasFilePath);
        if (!raw) {
          return -1;
        }

        try {
          const parsed = JSON.parse(raw) as {
            nodes?: Array<{ id?: string }>;
          };
          if (!Array.isArray(parsed.nodes)) {
            return -1;
          }

          return parsed.nodes.filter(
            (node) =>
              node.id !== "canvas-title" &&
              node.id !== "canvas-title-node",
          ).length;
        } catch {
          return -1;
        }
      },
      {
        message: `canvas should contain ${expectedNodeCount} content nodes`,
        timeout,
      },
    )
    .toBe(expectedNodeCount);
}

async function setupVaultNoteAndMockModel(
  page: Page,
  input: E2EInput,
  aiMode: "mock" | "real" = "mock",
  aiConfig: E2EAiConfig = getE2EAiConfig(),
  semanticEmbeddingConfig: E2ESemanticEmbeddingConfig =
    getE2ESemanticEmbeddingConfig(),
): Promise<{ activeFilePath: string; pluginId: string }> {
  return page.evaluate(async ({
    marker,
    secondMarker,
    priorEssay,
    streamChunkOne,
    streamChunkTwo,
    folderAnswerMarker,
    notepageFindingMarker,
    targetFolderMarkerOne,
    targetFolderMarkerTwo,
    targetFolderMarkerThree,
    replaceMarker,
    revisionMarker,
    memoryTopic,
    memoryMarker,
    designCanvasPath,
    designSvgPath,
    notePath,
    pluginId,
    aiMode,
    aiConfig,
    semanticEmbeddingConfig,
  }) => {
    const obsidianWindow = window as typeof window & { app?: any };
    const app = obsidianWindow.app;
    if (!app?.vault || !app?.workspace || !app?.plugins) {
      throw new Error("Obsidian app API is unavailable.");
    }

    const plugin = await ensurePluginLoaded(app, pluginId);

    const folderPath = "E2E Agent Tests";
    if (!app.vault.getAbstractFileByPath(folderPath)) {
      try {
        await app.vault.createFolder(folderPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists/i.test(message)) {
          throw error;
        }
      }
    }
    await ensureFolderPath(app, "E2E Agent Tests/Agent Memory");
    await writeVaultTextFile(
      app,
      "E2E Agent Tests/Agent Memory/conversation-history.json",
      "[]\n",
    );
    await writeVaultTextFile(
      app,
      "E2E Agent Tests/Agent Memory/research-memory-index.json",
      "[]\n",
    );
    plugin.conversationHistory = [];
    plugin.researchMemoryIndex = [];

    const seedContent = `# Playwright Agent E2E\n\nSeed note for ${marker}.\n\n`;
    const file = await writeVaultTextFile(app, notePath, seedContent);
    const loopContextBaseName =
      notePath.split("/").pop()?.replace(/\.md$/i, "") ?? `loop-${Date.now()}`;
    const loopContextNotePaths = Array.from(
      { length: 30 },
      (_, index) =>
        `E2E Agent Tests/loop-context-${loopContextBaseName}-${index + 1}.md`,
    );
    for (const [index, loopContextNotePath] of loopContextNotePaths.entries()) {
      await writeVaultTextFile(
        app,
        loopContextNotePath,
        `# Loop Context ${index + 1}\n\nRelated to [[${loopContextBaseName}]].\n\nStep ${
          index + 1
        } graph context.\n`,
      );
    }

    const folderTraversalNotePath = `E2E Agent Tests/Other Folder/folder-${Date.now()}.md`;
    const folderTraversalFolderPath = "E2E Agent Tests/Other Folder";
    if (!app.vault.getAbstractFileByPath(folderTraversalFolderPath)) {
      try {
        await app.vault.createFolder(folderTraversalFolderPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists/i.test(message)) {
          throw error;
        }
      }
    }
    const folderTraversalContent = `# Other Folder Note\n\n${folderAnswerMarker}\n`;
    const folderTraversalFile = app.vault.getAbstractFileByPath(
      folderTraversalNotePath,
    );
    if (folderTraversalFile) {
      await app.vault.modify(folderTraversalFile, folderTraversalContent);
    } else {
      await writeVaultTextFile(
        app,
        folderTraversalNotePath,
        folderTraversalContent,
      );
    }
    const semanticIndexedFile =
      app.vault.getAbstractFileByPath(folderTraversalNotePath);
    const semanticIndexVector = Array.from({ length: 512 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const semanticIndexModel =
      semanticEmbeddingConfig.mode === "ollama"
        ? semanticEmbeddingConfig.model
        : "nomic-ai/nomic-embed-text-v1.5-Q";
    const semanticIndex = {
      version: 1,
      model: semanticIndexModel,
      dim: 512,
      chunking: {
        minTokens: 300,
        targetTokens: 500,
        maxTokens: 700,
        overlapTokens: 80,
      },
      indexedAt: new Date().toISOString(),
      notes: [
        {
          path: folderTraversalNotePath,
          title: "Other Folder Note",
          mtime: semanticIndexedFile?.stat?.mtime ?? 0,
          size: semanticIndexedFile?.stat?.size ?? folderTraversalContent.length,
          contentHash: "e2e-semantic-content",
          tags: ["e2e"],
          links: [],
          headings: ["Other Folder Note"],
          chunks: [
            {
              id: `${folderTraversalNotePath}#0`,
              path: folderTraversalNotePath,
              title: "Other Folder Note",
              heading: "Other Folder Note",
              textHash: "e2e-semantic-chunk",
              tokenCount: 12,
              snippet: folderTraversalContent.replace(/\s+/g, " ").trim(),
              vector: semanticIndexVector,
            },
          ],
        },
      ],
    };
    await ensureFolderPath(app, "Agent Memory");
    await writeVaultTextFile(
      app,
      "Agent Memory/semantic-vault-index.json",
      `${JSON.stringify(semanticIndex, null, 2)}\n`,
    );
    await writeVaultTextFile(
      app,
      "Agent Memory/Semantic Vault Index.md",
      [
        "# Semantic Vault Index",
        "",
        `Indexed at: ${semanticIndex.indexedAt}`,
        `Model: ${semanticIndex.model}`,
        "Dimension: 512",
        "Notes: 1",
        "Chunks: 1",
        "",
        "## Indexed Notes",
        "",
        "### Other Folder Note",
        "",
        `- Path: ${folderTraversalNotePath}`,
        `- Snippet: ${folderAnswerMarker}`,
        "",
      ].join("\n"),
    );

    const targetFolderSeeds = [
      {
        folder: "Untitled",
        path: `Untitled/000-e2e-${Date.now()}-one.md`,
        content: `# Untitled Folder E2E\n\n${targetFolderMarkerOne}\n`,
      },
      {
        folder: "Untitled 1",
        path: `Untitled 1/000-e2e-${Date.now()}-two.md`,
        content: `# Untitled 1 Folder E2E\n\n${targetFolderMarkerTwo}\n`,
      },
      {
        folder: "Untitled 2",
        path: `Untitled 2/000-e2e-${Date.now()}-three.md`,
        content: `# Untitled 2 Folder E2E\n\n${targetFolderMarkerThree}\n`,
      },
    ];

    for (const seed of targetFolderSeeds) {
      if (!app.vault.getAbstractFileByPath(seed.folder)) {
        try {
          await app.vault.createFolder(seed.folder);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/already exists/i.test(message)) {
            throw error;
          }
        }
      }

      const seededFile = app.vault.getAbstractFileByPath(seed.path);
      if (seededFile) {
        await app.vault.modify(seededFile, seed.content);
      } else {
        await writeVaultTextFile(app, seed.path, seed.content);
      }
    }

    await waitForWorkspaceReady(app);
    const markdownLeaves =
      typeof app.workspace.getLeavesOfType === "function"
        ? app.workspace.getLeavesOfType("markdown")
        : [];
    const noteLeaf = markdownLeaves[0] ?? app.workspace.getLeaf("tab");
    await noteLeaf.openFile(file);
    app.workspace.setActiveLeaf(noteLeaf, { focus: true });

    let mockAppendConversationMessage: any = null;
    let mockClearConversationHistory: any = null;
    let mockSaveSettings: any = null;
    let mockCreateModelClient: any = null;
    let mockCreateToolExecutionContext: any = null;

    if (aiMode === "real") {
      plugin.settings = {
        ...plugin.settings,
        enableStreaming: true,
        thinkingMode: "off",
        model: aiConfig.model,
        ollamaBaseUrl: aiConfig.baseUrl,
        ollamaApiKey: aiConfig.apiKey || plugin.settings.ollamaApiKey,
        requestTimeoutMs: aiConfig.missionTimeoutMs,
        maxAgentSteps: 30,
        streamWritebackMode: "all_current_note_content_writes",
      };
    } else {
    plugin.settings = {
      ...plugin.settings,
      enableStreaming: false,
      thinkingMode: "off",
      model: "playwright-e2e-mock",
      semanticEmbeddingModel:
        semanticEmbeddingConfig.mode === "ollama"
          ? semanticEmbeddingConfig.model
          : plugin.settings.semanticEmbeddingModel,
      semanticEmbeddingDim: 512,
      semanticChunkMinTokens: 300,
      semanticChunkTargetTokens: 500,
      semanticChunkMaxTokens: 700,
      semanticChunkOverlapTokens: 80,
      semanticIndexEnabled: true,
      semanticIndexFolder: "Agent Memory",
      semanticIndexPersistVectors: true,
      maxAgentSteps: 30,
      streamWritebackMode: "off",
    };
    plugin.appendConversationMessage = async function appendConversationMessage(
      message: { role: string; content: string },
    ) {
      this.conversationHistory = [...this.conversationHistory, message];
    };
    plugin.clearConversationHistory = async function clearConversationHistory() {
      this.conversationHistory = [];
    };
    plugin.saveSettings = async function saveSettings() {
      return undefined;
    };
    const loopStepCounts = new Map<string, number>();
    const webLedgerStepCounts = new Map<string, number>();
    const semanticSearchStepCounts = new Map<string, number>();
    plugin.createModelClient = function createModelClient() {
      return {
        playwrightE2EMock: true,
        async chat(request: {
          messages?: Array<{ role?: string; content?: string }>;
          tools?: Array<{ function?: { name?: string } }>;
        }) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const toolNames =
            request.tools?.map((tool) => tool.function?.name).filter(Boolean) ?? [];
          const latestUserText =
            [...(request.messages ?? [])]
              .reverse()
              .find((message) => message.role === "user")
              ?.content ?? "";
          const requestText =
            request.messages?.map((message) => message.content ?? "").join("\n") ?? "";
          const loopMatch = /E2E_LOOP_STEPS_(\d+)/.exec(latestUserText);
          if (loopMatch) {
            const targetSteps = Math.max(1, Number.parseInt(loopMatch[1], 10));
            const key = loopMatch[0];
            const completedToolSteps = loopStepCounts.get(key) ?? 0;
            if (completedToolSteps < targetSteps - 1) {
              if (!toolNames.includes("get_note_graph_context")) {
                return {
                  message: {
                    role: "assistant",
                    content: `E2E_LOOP_DONE_${targetSteps}`,
                  },
                  toolCalls: [],
                  raw: { playwrightE2E: true },
                };
              }
              loopStepCounts.set(key, completedToolSteps + 1);
              const loopContextPath =
                loopContextNotePaths[completedToolSteps % loopContextNotePaths.length];
              const toolCall = {
                id: `playwright-e2e-loop-${targetSteps}-${completedToolSteps + 1}`,
                index: 0,
                name: "get_note_graph_context",
                arguments: { path: loopContextPath },
              };

              return {
                message: {
                  role: "assistant",
                  content: "",
                  toolCalls: [toolCall],
                },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }

            return {
              message: {
                role: "assistant",
                content: `E2E_LOOP_DONE_${targetSteps}`,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (/continue\s+run\s+([A-Za-z0-9._:-]+)/i.test(latestUserText)) {
            const requestedRunId =
              /continue\s+run\s+([A-Za-z0-9._:-]+)/i.exec(latestUserText)?.[1] ?? "";
            if (
              requestedRunId &&
              !requestText.includes("Structured Agent Runs mission ledger")
            ) {
              throw new Error(`Resume context was not injected for ${requestedRunId}.`);
            }

            return {
              message: {
                role: "assistant",
                content: `E2E_RESUME_LEDGER_${requestedRunId}`,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_WEB_LEDGER_SOURCE")) {
            const key = "E2E_WEB_LEDGER_SOURCE";
            const webStep = webLedgerStepCounts.get(key) ?? 0;
            if (webStep === 0) {
              if (!toolNames.includes("web_search")) {
                throw new Error(
                  `web_search was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              webLedgerStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-web-ledger-search",
                index: 0,
                name: "web_search",
                arguments: {
                  query: "E2E_WEB_LEDGER_SOURCE",
                  max_results: 1,
                },
              };

              return {
                message: {
                  role: "assistant",
                  content: "",
                  toolCalls: [toolCall],
                },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }

            if (webStep === 1) {
              if (!toolNames.includes("web_fetch")) {
                throw new Error(
                  `web_fetch was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              webLedgerStepCounts.set(key, 2);
              const toolCall = {
                id: "playwright-e2e-web-ledger-fetch",
                index: 0,
                name: "web_fetch",
                arguments: {
                  url: "https://example.com/e2e-ledger-source",
                },
              };

              return {
                message: {
                  role: "assistant",
                  content: "",
                  toolCalls: [toolCall],
                },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }

            return {
              message: {
                role: "assistant",
                content:
                  "E2E_WEB_LEDGER_DONE sourced from https://example.com/e2e-ledger-source.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes(replaceMarker)) {
            if (toolNames.includes("replace_current_file")) {
              const toolCall = {
                id: "playwright-e2e-replace",
                index: 0,
                name: "replace_current_file",
                arguments: {
                  text: `${replaceMarker}: Renaissance replacement essay.\n`,
                },
              };

              return {
                message: {
                  role: "assistant",
                  content: "",
                  toolCalls: [toolCall],
                },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }

            return {
              message: {
                role: "assistant",
                content: `${replaceMarker}: Renaissance replacement essay.`,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (requestText.includes(revisionMarker)) {
            if (
              toolNames.includes("prepare_edit_current_section") ||
              toolNames.includes("edit_current_section")
            ) {
              throw new Error(
                `revision follow-up should not expose section-edit tools. Tools: ${toolNames.join(", ")}`,
              );
            }

            if (toolNames.includes("replace_current_file")) {
              const toolCall = {
                id: "playwright-e2e-revision-replace",
                index: 0,
                name: "replace_current_file",
                arguments: {
                  text: `# Revision E2E\n\n${revisionMarker}: expanded essay revision with added detail.\n`,
                },
              };

              return {
                message: {
                  role: "assistant",
                  content: "",
                  toolCalls: [toolCall],
                },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }

            return {
              message: {
                role: "assistant",
                content: `Ready to revise ${revisionMarker}.`,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("other notes in the other folders")) {
            return {
              message: {
                role: "assistant",
                content: `The other folder note says ${folderAnswerMarker}.`,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (requestText.includes("E2E_SEMANTIC_SEARCH")) {
            const key = `E2E_SEMANTIC_SEARCH:${folderAnswerMarker}`;
            const semanticStep = semanticSearchStepCounts.get(key) ?? 0;
            if (semanticStep > 1) {
              if (
                !(
                  requestText.includes('"mode":"indexed_semantic"') ||
                  requestText.includes('"mode":"hybrid_semantic"')
                ) ||
                !requestText.includes('"fallbackUsed":false')
              ) {
                throw new Error(
                  "semantic_search_notes did not return a non-fallback semantic result.",
                );
              }
              if (!requestText.includes(folderAnswerMarker)) {
                throw new Error(
                  `semantic_search_notes result did not include ${folderAnswerMarker}.`,
                );
              }
              return {
                message: {
                  role: "assistant",
                  content: `Semantic search found ${folderAnswerMarker} in E2E Agent Tests/Other Folder.`,
                },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }

            if (semanticStep === 0) {
              if (!toolNames.includes("inspect_semantic_index")) {
                throw new Error(
                  `inspect_semantic_index was not available. Tools: ${toolNames.join(", ")}`,
                );
              }

              semanticSearchStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-inspect-semantic-index",
                index: 0,
                name: "inspect_semantic_index",
                arguments: {
                  query: `E2E_SEMANTIC_SEARCH ${folderAnswerMarker} themes`,
                  limit: 5,
                },
              };

              return {
                message: {
                  role: "assistant",
                  content: "",
                  toolCalls: [toolCall],
                },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }

            if (!toolNames.includes("semantic_search_notes")) {
              throw new Error(
                `semantic_search_notes was not available. Tools: ${toolNames.join(", ")}`,
              );
            }

            semanticSearchStepCounts.set(key, 2);
            const toolCall = {
              id: "playwright-e2e-semantic-search",
              index: 0,
              name: "semantic_search_notes",
              arguments: {
                query: `E2E_SEMANTIC_SEARCH ${folderAnswerMarker} themes`,
                folder: "E2E Agent Tests/Other Folder",
                limit: 5,
              },
            };

            return {
              message: {
                role: "assistant",
                content: "",
                toolCalls: [toolCall],
              },
              toolCalls: [toolCall],
              raw: { playwrightE2E: true },
            };
          }

          if (
            requestText.includes(memoryMarker) &&
            !latestUserText.includes(memoryMarker) &&
            !toolNames.includes("append_research_memory")
          ) {
            return {
              message: {
                role: "assistant",
                content: `Research memory recalls ${memoryMarker}.`,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (toolNames.includes("append_research_memory")) {
            const toolCall = {
              id: "playwright-e2e-memory-append",
              index: 0,
              name: "append_research_memory",
              arguments: {
                topic: memoryTopic,
                text: memoryMarker,
                keywords: ["playwright", "memory"],
              },
            };

            return {
              message: {
                role: "assistant",
                content: "",
                toolCalls: [toolCall],
              },
              toolCalls: [toolCall],
              raw: { playwrightE2E: true },
            };
          }

          if (toolNames.includes("search_research_memory")) {
            const toolCall = {
              id: "playwright-e2e-memory-search",
              index: 0,
              name: "search_research_memory",
              arguments: {
                query: memoryTopic,
              },
            };

            return {
              message: {
                role: "assistant",
                content: "",
                toolCalls: [toolCall],
              },
              toolCalls: [toolCall],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.toLowerCase().includes("simple 3 block diagram")) {
            if (!toolNames.includes("create_design_canvas")) {
              throw new Error(
                `create_design_canvas was not available. Tools: ${toolNames.join(", ")}`,
              );
            }

            const toolCall = {
              id: "playwright-e2e-three-block-canvas",
              index: 0,
              name: "create_design_canvas",
              arguments: {
                path: designCanvasPath,
                title: "House Transportation Workplace",
                direction: "row",
                items: [
                  {
                    title: "house",
                    text: "A home starting point.",
                    color: "4",
                  },
                  {
                    title: "transportation",
                    text: "Travel between home and work.",
                    color: "5",
                  },
                  {
                    title: "workplace",
                    text: "The destination for the commute.",
                    color: "6",
                  },
                ],
              },
            };

            return {
              message: {
                role: "assistant",
                content: "",
                toolCalls: [toolCall],
              },
              toolCalls: [toolCall],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_DESIGN_CANVAS")) {
            if (!toolNames.includes("create_design_canvas")) {
              throw new Error(
                `create_design_canvas was not available. Tools: ${toolNames.join(", ")}`,
              );
            }

            const toolCall = {
              id: "playwright-e2e-design-canvas",
              index: 0,
              name: "create_design_canvas",
              arguments: {
                path: designCanvasPath,
                title: "Product Flow",
                direction: "row",
                items: [
                  {
                    title: "Intake",
                    text: "User submits a mission.",
                    color: "4",
                  },
                  {
                    title: "Plan",
                    text: "Agent selects tools.",
                    color: "5",
                  },
                  {
                    title: "Artifact",
                    text: "Validated design is written.",
                    color: "6",
                  },
                ],
              },
            };

            return {
              message: {
                role: "assistant",
                content: "",
                toolCalls: [toolCall],
              },
              toolCalls: [toolCall],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_DESIGN_SVG")) {
            if (!toolNames.includes("create_svg_design")) {
              throw new Error(
                `create_svg_design was not available. Tools: ${toolNames.join(", ")}`,
              );
            }

            const toolCall = {
              id: "playwright-e2e-design-svg",
              index: 0,
              name: "create_svg_design",
              arguments: {
                path: designSvgPath,
                title: "Settings Wireframe",
                width: 720,
                height: 420,
                shapes: [
                  {
                    type: "rect",
                    x: 40,
                    y: 60,
                    width: 640,
                    height: 300,
                    label: "Settings",
                  },
                  {
                    type: "text",
                    x: 72,
                    y: 116,
                    text: "Agent autonomy",
                  },
                  {
                    type: "rect",
                    x: 72,
                    y: 150,
                    width: 260,
                    height: 54,
                    label: "Run budget",
                  },
                ],
              },
            };

            return {
              message: {
                role: "assistant",
                content: "",
                toolCalls: [toolCall],
              },
              toolCalls: [toolCall],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_BROAD_NO_WRITE_MARKER")) {
            return {
              message: {
                role: "assistant",
                content: "E2E_BROAD_NO_WRITE_BLOCKED: explicit scope is required.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_CRUD_CHAIN")) {
            const requiredTools = [
              "read_current_file",
              "create_folder",
              "create_file",
              "append_file",
              "replace_file",
              "move_path",
              "delete_path",
            ];
            const missingTools = requiredTools.filter(
              (toolName) => !toolNames.includes(toolName),
            );
            if (missingTools.length > 0) {
              throw new Error(
                `CRUD e2e tools were not available: ${missingTools.join(", ")}. Tools: ${toolNames.join(", ")}`,
              );
            }

            const basePath = `E2E Agent Tests/CRUD Chain/${marker}`;
            const initialPath = `${basePath}/crud-target-${marker}.md`;
            const movedPath = `${basePath}/crud-target-${marker}-moved.md`;
            const toolCalls = [
              {
                id: "playwright-e2e-crud-read",
                index: 0,
                name: "read_current_file",
                arguments: {},
              },
              {
                id: "playwright-e2e-crud-create-folder",
                index: 1,
                name: "create_folder",
                arguments: { path: basePath },
              },
              {
                id: "playwright-e2e-crud-create-file",
                index: 2,
                name: "create_file",
                arguments: {
                  path: initialPath,
                  content: `# CRUD Target\n\nCREATE:${marker}\n`,
                },
              },
              {
                id: "playwright-e2e-crud-append",
                index: 3,
                name: "append_file",
                arguments: {
                  path: initialPath,
                  text: `\nAPPEND:${secondMarker}\n`,
                },
              },
              {
                id: "playwright-e2e-crud-replace",
                index: 4,
                name: "replace_file",
                arguments: {
                  path: initialPath,
                  text: `# CRUD Replaced\n\nREPLACE:${marker}\n`,
                },
              },
              {
                id: "playwright-e2e-crud-move",
                index: 5,
                name: "move_path",
                arguments: {
                  fromPath: initialPath,
                  toPath: movedPath,
                },
              },
              {
                id: "playwright-e2e-crud-delete",
                index: 6,
                name: "delete_path",
                arguments: { path: movedPath },
              },
            ];

            return {
              message: {
                role: "assistant",
                content: "",
                toolCalls,
              },
              toolCalls,
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_FOLDER_SCOPE_MARKER")) {
            if (!toolNames.includes("create_file")) {
              throw new Error(
                `create_file was not available for scoped write. Tools: ${toolNames.join(", ")}`,
              );
            }

            const toolCall = {
              id: "playwright-e2e-file-scoped-create",
              index: 0,
              name: "create_file",
              arguments: {
                path: "E2E Agent Tests/Scoped Folder/scoped-output.md",
                content: "# Scoped Output\n\nE2E_FOLDER_SCOPE_MARKER\n",
                createFolders: true,
              },
            };

            return {
              message: {
                role: "assistant",
                content: "",
                toolCalls: [toolCall],
              },
              toolCalls: [toolCall],
              raw: { playwrightE2E: true },
            };
          }

          const generatedMatrixContent = getGeneratedMatrixContent(latestUserText);
          if (generatedMatrixContent && !toolNames.includes("append_to_current_file")) {
            return {
              message: {
                role: "assistant",
                content: generatedMatrixContent,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (!toolNames.includes("append_to_current_file")) {
            throw new Error(
              `append_to_current_file was not available. Tools: ${toolNames.join(", ")}`,
            );
          }

          const generatedMatrixAppendContent =
            getGeneratedMatrixContent(latestUserText) ??
            getGeneratedMatrixContent(requestText);
          const textToAppend = generatedMatrixAppendContent
            ? generatedMatrixAppendContent
            : requestText.includes("most recent assistant response")
            ? priorEssay
            : latestUserText.includes(secondMarker)
              ? secondMarker
              : marker;
          const toolCall = {
            id: "playwright-e2e-append",
            index: 0,
            name: "append_to_current_file",
            arguments: { text: textToAppend },
          };

          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [toolCall],
            },
            toolCalls: [toolCall],
            raw: { playwrightE2E: true },
          };
        },
        async streamChat(
          request: {
            messages?: Array<{ role?: string; content?: string }>;
          },
          events?: { onContentDelta?: (delta: string) => void },
        ) {
          const latestUserText =
            [...(request.messages ?? [])]
              .reverse()
              .find((message) => message.role === "user")
              ?.content ?? "";
          const requestText =
            request.messages?.map((message) => message.content ?? "").join("\n") ?? "";
          const generatedMatrixContent =
            getGeneratedMatrixContent(latestUserText) ??
            getGeneratedMatrixContent(requestText);
          if (generatedMatrixContent) {
            const splitAt = Math.max(1, Math.floor(generatedMatrixContent.length / 2));
            events?.onContentDelta?.(generatedMatrixContent.slice(0, splitAt));
            await new Promise((resolve) => setTimeout(resolve, 250));
            events?.onContentDelta?.(generatedMatrixContent.slice(splitAt));
            return {
              message: {
                role: "assistant",
                content: generatedMatrixContent,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes(replaceMarker)) {
            const content = `${replaceMarker}: Renaissance replacement essay.\n`;
            events?.onContentDelta?.(content);
            return {
              message: {
                role: "assistant",
                content,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (requestText.includes(revisionMarker)) {
            const content = `# Revision E2E\n\n${revisionMarker}: expanded essay revision with added detail.\n`;
            events?.onContentDelta?.(content);
            return {
              message: {
                role: "assistant",
                content,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (requestText.includes("Prefetched vault context")) {
            for (const marker of [
              targetFolderMarkerOne,
              targetFolderMarkerTwo,
              targetFolderMarkerThree,
            ]) {
              if (!requestText.includes(marker)) {
                throw new Error(`Prefetched context was missing ${marker}`);
              }
            }

            const content = `${notepageFindingMarker}: ${targetFolderMarkerOne}; ${targetFolderMarkerTwo}; ${targetFolderMarkerThree}\n`;
            events?.onContentDelta?.(content);
            return {
              message: {
                role: "assistant",
                content,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          events?.onContentDelta?.(`${streamChunkOne}\n`);
          await new Promise((resolve) => setTimeout(resolve, 1800));
          events?.onContentDelta?.(`${streamChunkTwo}\n`);
          await new Promise((resolve) => setTimeout(resolve, 250));
          return {
            message: {
              role: "assistant",
              content: `${streamChunkOne}\n${streamChunkTwo}\n`,
            },
            toolCalls: [],
            raw: { playwrightE2E: true },
          };
        },
      };
    };
    const pluginPrototype = Object.getPrototypeOf(plugin);
    pluginPrototype.appendConversationMessage = plugin.appendConversationMessage;
    pluginPrototype.clearConversationHistory = plugin.clearConversationHistory;
    pluginPrototype.saveSettings = plugin.saveSettings;
    pluginPrototype.createModelClient = plugin.createModelClient;
    mockAppendConversationMessage = plugin.appendConversationMessage;
    mockClearConversationHistory = plugin.clearConversationHistory;
    mockSaveSettings = plugin.saveSettings;
    mockCreateModelClient = plugin.createModelClient;
    const originalCreateToolExecutionContext =
      typeof plugin.createToolExecutionContext === "function"
        ? plugin.createToolExecutionContext.bind(plugin)
        : null;
    const createSemanticEmbeddingProvider = () => {
      if (semanticEmbeddingConfig.mode === "ollama") {
        return {
          async embed(request: {
            model: string;
            dim: 256 | 512;
            documents: string[];
            queries: string[];
          }) {
            const allInputs = [
              ...request.documents.map((document) => `search_document: ${document}`),
              ...request.queries.map((query) => `search_query: ${query}`),
            ];
            const controller = new AbortController();
            const timeout = window.setTimeout(
              () => controller.abort(),
              semanticEmbeddingConfig.timeoutMs,
            );

            try {
              const response = await fetch(
                `${semanticEmbeddingConfig.baseUrl.replace(/\/+$/, "")}/api/embed`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: semanticEmbeddingConfig.model,
                    input: allInputs,
                  }),
                  signal: controller.signal,
                },
              );

              const body = await response.json();
              if (!response.ok) {
                return {
                  ok: false,
                  model: semanticEmbeddingConfig.model,
                  dim: request.dim,
                  code: "ollama_embed_http_error",
                  message:
                    typeof body?.error === "string"
                      ? body.error
                      : `Ollama embed request failed with ${response.status}.`,
                };
              }

              const embeddings = Array.isArray(body?.embeddings)
                ? body.embeddings
                : Array.isArray(body?.embedding)
                  ? [body.embedding]
                  : [];
              if (embeddings.length !== allInputs.length) {
                return {
                  ok: false,
                  model: semanticEmbeddingConfig.model,
                  dim: request.dim,
                  code: "ollama_embed_invalid_response",
                  message: `Expected ${allInputs.length} embeddings, got ${embeddings.length}.`,
                };
              }

              const vectors = embeddings.map((embedding: unknown) =>
                truncateAndNormalizeEmbedding(embedding, request.dim),
              );
              return {
                ok: true,
                model: semanticEmbeddingConfig.model,
                dim: request.dim,
                documents: vectors.slice(0, request.documents.length),
                queries: vectors.slice(request.documents.length),
                downloadedOrVerified: true,
              };
            } catch (error) {
              return {
                ok: false,
                model: semanticEmbeddingConfig.model,
                dim: request.dim,
                code: "ollama_embed_failed",
                message: error instanceof Error ? error.message : String(error),
              };
            } finally {
              window.clearTimeout(timeout);
            }
          },
        };
      }

      return {
        async embed(request: {
          model: string;
          dim: 256 | 512;
          documents: string[];
          queries: string[];
        }) {
          return {
            ok: true,
            model: request.model,
            dim: request.dim,
            documents: request.documents.map((document) =>
              document.includes(folderAnswerMarker) ? [1, 0] : [0, 1],
            ),
            queries: request.queries.map(() => [1, 0]),
            downloadedOrVerified: true,
          };
        },
      };
    };
    const truncateAndNormalizeEmbedding = (embedding: unknown, dim: 256 | 512) => {
      if (
        !Array.isArray(embedding) ||
        embedding.length < dim ||
        embedding.some((value) => typeof value !== "number")
      ) {
        throw new Error(`Invalid Ollama embedding vector for dim ${dim}.`);
      }

      const fullNorm =
        Math.sqrt(
          embedding.reduce((sum: number, value: number) => sum + value * value, 0),
        ) || 1;
      const truncated = embedding
        .slice(0, dim)
        .map((value: number) => value / fullNorm);
      const truncatedNorm =
        Math.sqrt(
          truncated.reduce((sum: number, value: number) => sum + value * value, 0),
        ) || 1;
      return truncated.map((value: number) => value / truncatedNorm);
    };
    mockCreateToolExecutionContext = function createToolExecutionContext(
      this: any,
      originalPrompt: string,
    ) {
      const context = originalCreateToolExecutionContext
        ? originalCreateToolExecutionContext(originalPrompt)
        : {};
      return {
        ...context,
        settings: this?.settings ?? context.settings,
        httpTransport: mockHttpTransport,
        semanticEmbeddingProvider: createSemanticEmbeddingProvider(),
      };
    };
    pluginPrototype.createToolExecutionContext = mockCreateToolExecutionContext;
    }

    const existingAgentLeaves =
      typeof app.workspace.getLeavesOfType === "function"
        ? app.workspace.getLeavesOfType("agentic-researcher-view")
        : [];
    for (const leaf of existingAgentLeaves) {
      await leaf.detach?.();
    }

    await plugin.activateView();
    const activePlugin = app.plugins.plugins[pluginId] ?? plugin;
    if (aiMode === "real") {
      activePlugin.settings = {
        ...activePlugin.settings,
        enableStreaming: true,
        thinkingMode: "off",
        model: aiConfig.model,
        ollamaBaseUrl: aiConfig.baseUrl,
        ollamaApiKey: aiConfig.apiKey || activePlugin.settings.ollamaApiKey,
        requestTimeoutMs: aiConfig.missionTimeoutMs,
        maxAgentSteps: 30,
        streamWritebackMode: "all_current_note_content_writes",
      };
    } else {
      activePlugin.settings = {
        ...activePlugin.settings,
        enableStreaming: false,
        thinkingMode: "off",
        model: "playwright-e2e-mock",
        semanticEmbeddingModel:
          semanticEmbeddingConfig.mode === "ollama"
            ? semanticEmbeddingConfig.model
            : activePlugin.settings.semanticEmbeddingModel,
        maxAgentSteps: 30,
        streamWritebackMode: "off",
      };
      activePlugin.appendConversationMessage = mockAppendConversationMessage;
      activePlugin.clearConversationHistory = mockClearConversationHistory;
      activePlugin.saveSettings = mockSaveSettings;
      activePlugin.createModelClient = mockCreateModelClient;
      activePlugin.createToolExecutionContext = mockCreateToolExecutionContext;
      installMockOverrides(plugin);
      installMockOverrides(activePlugin);
      for (const leaf of app.workspace.getLeavesOfType?.("agentic-researcher-view") ?? []) {
        installMockOverrides(leaf.view?.plugin);
      }
    }

    return {
      activeFilePath: app.workspace.getActiveFile()?.path ?? "",
      pluginId,
    };

    async function ensurePluginLoaded(app: any, pluginId: string) {
      let plugin = app.plugins.plugins[pluginId];
      if (plugin) {
        return plugin;
      }

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (
          !app.plugins.manifests?.[pluginId] &&
          typeof app.plugins.loadManifests === "function"
        ) {
          await app.plugins.loadManifests();
        }

        if (app.plugins.manifests?.[pluginId]) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      if (!app.plugins.manifests?.[pluginId]) {
        throw new Error(`Plugin manifest is not installed: ${pluginId}`);
      }

      if (typeof app.plugins.enablePlugin === "function") {
        await app.plugins.enablePlugin(pluginId);
      } else if (typeof app.plugins.loadPlugin === "function") {
        await app.plugins.loadPlugin(pluginId);
      } else {
        throw new Error("Obsidian plugin loader API is unavailable.");
      }

      for (let attempt = 0; attempt < 40; attempt += 1) {
        plugin = app.plugins.plugins[pluginId];
        if (plugin) {
          return plugin;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      throw new Error(`Plugin did not load after enabling: ${pluginId}`);
    }

    async function waitForWorkspaceReady(app: any) {
      if (typeof app.workspace.onLayoutReady === "function") {
        await new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve));
      }

      for (let attempt = 0; attempt < 80; attempt += 1) {
        const rootSplit = app.workspace.rootSplit;
        const rootReady =
          rootSplit?.containerEl?.isConnected ||
          Boolean(document.querySelector(".workspace-split.mod-root"));
        if (rootReady) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      throw new Error("Obsidian workspace layout was not ready.");
    }

    async function ensureFolderPath(app: any, path: string) {
      const parts = path.split("/").filter(Boolean);
      let currentPath = "";
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (app.vault.getAbstractFileByPath(currentPath)) {
          continue;
        }

        try {
          await app.vault.createFolder(currentPath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/already exists/i.test(message)) {
            throw error;
          }
        }
      }
    }

    async function writeVaultTextFile(app: any, path: string, text: string) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file) {
        await app.vault.modify(file, text);
        return file;
      } else {
        try {
          return await app.vault.create(path, text);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/already exists/i.test(message)) {
            throw error;
          }

          for (let attempt = 0; attempt < 20; attempt += 1) {
            const existing = app.vault.getAbstractFileByPath(path);
            if (existing) {
              await app.vault.modify(existing, text);
              return existing;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }

          throw error;
        }
      }
    }

    function getGeneratedMatrixContent(text: string): string | null {
      const lower = text.toLowerCase();
      if (
        lower.includes("generate me a 100 word essay") &&
        lower.includes("revolutionary war")
      ) {
        return "Revolutionary war essay: the Revolutionary war reshaped colonial politics, taxation debates, and independence arguments in a concise generated note.\n";
      }
      if (
        (lower.includes("500 word essay") || lower.includes("500-word essay")) &&
        lower.includes("epic") &&
        lower.includes("gilgamesh")
      ) {
        return [
          "The Epic of Gilgamesh is meaningful because it turns an ancient king's adventures into a lasting meditation on power, friendship, grief, and mortality. At the beginning of the epic, Gilgamesh rules Uruk with strength but without wisdom. He is impressive, restless, and excessive, and the people need the gods to create a counterweight to his pride. That counterweight is Enkidu, a wild man whose movement from nature into the city helps reveal what civilization gives and what it costs.",
          "The friendship between Gilgamesh and Enkidu is the emotional center of the story. Their bond changes both men. Gilgamesh learns to direct his energy toward action that can help his city, while Enkidu learns loyalty, speech, and human attachment. Together they defeat Humbaba and challenge the Bull of Heaven, but those victories also expose the danger of heroic ambition. The epic does not treat fame as worthless, yet it shows that glory without humility can lead to suffering.",
          "Enkidu's death is the turning point that makes the poem more than a tale of conquest. Gilgamesh is shattered because he sees his own future in his friend's body. His grief becomes a philosophical crisis: if even the strongest companion can die, then kingship, beauty, and victory cannot protect anyone from mortality. Gilgamesh then searches for Utnapishtim, hoping to find a way around death. The journey is difficult and strange, but its lesson is plain. Human beings cannot possess eternal life by force of will.",
          "By the end, Gilgamesh returns to Uruk without immortality, but not without wisdom. He learns that meaning must be built inside human limits. The walls of Uruk matter because they represent responsible labor, community, memory, and care for what can outlast one life. The epic remains useful because it refuses an easy answer. It honors friendship and achievement while admitting that loss is unavoidable. Gilgamesh becomes meaningful when he stops trying to escape being human and begins to understand how a mortal life can still create value.",
          "That final insight is why the poem still feels alive in a modern classroom or personal reading. Gilgamesh is not useful because it offers a simple moral, but because it dramatizes questions people still ask: how to use power, how to love another person, how to mourn honestly, and how to live with limits without surrendering to despair.",
        ].join("\n\n") + "\n";
      }
      if (
        lower.includes("generate me a 1000 word essay") &&
        lower.includes("grapes of wrath")
      ) {
        return "Grapes of Wrath essay: Steinbeck's Grapes of Wrath follows the Joad family through Dust Bowl migration, labor exploitation, and collective survival.\n";
      }
      if (
        lower.includes("stream it to the page") &&
        lower.includes("grapes of wrath")
      ) {
        return "# Harvest of Injustice\n\nGrapes of Wrath stream-title essay: the Dust Bowl, migration, and labor exploitation force the Joad family toward collective survival.\n";
      }
      if (
        lower.includes("tell me about how to cook") &&
        lower.includes("cast iron") &&
        lower.includes("steak")
      ) {
        return "steak guide: season the steak, preheat the cast iron until very hot, sear both sides, baste with butter, rest, and slice against the grain.\n";
      }
      if (
        lower.includes("walk me through how diagonalization works") &&
        lower.includes("linear algebra")
      ) {
        return "diagonalization explanation: in Linear Algebra, diagonalization rewrites a matrix as PDP inverse when enough eigenvectors form a basis, making powers and transformations easier.\n";
      }

      return null;
    }

    async function mockHttpTransport(request: any) {
      const url = String(request?.url ?? "");
      if (url.endsWith("/web_search")) {
        return {
          status: 200,
          json: {
            results: [
              {
                title: "E2E Web Ledger Source",
                url: "https://example.com/e2e-ledger-source",
                snippet: "E2E_WEB_LEDGER_SOURCE search result snippet.",
              },
            ],
          },
          text: "",
        };
      }

      if (url.endsWith("/web_fetch")) {
        return {
          status: 200,
          json: {
            title: "E2E Web Ledger Source",
            content:
              "E2E_WEB_LEDGER_SOURCE fetched source content for mission evidence tracking.",
            links: [],
          },
          text: "",
        };
      }

      return {
        status: 404,
        json: {
          error: `Unexpected e2e HTTP request: ${url}`,
        },
        text: "",
      };
    }

    function installMockOverrides(target: any) {
      if (!target) {
        return;
      }

      target.settings = {
        ...target.settings,
        enableStreaming: false,
        thinkingMode: "off",
        model: "playwright-e2e-mock",
        semanticEmbeddingModel:
          semanticEmbeddingConfig.mode === "ollama"
            ? semanticEmbeddingConfig.model
            : target.settings.semanticEmbeddingModel,
        semanticEmbeddingDim: 512,
        semanticChunkMinTokens: 300,
        semanticChunkTargetTokens: 500,
        semanticChunkMaxTokens: 700,
        semanticChunkOverlapTokens: 80,
        semanticIndexEnabled: true,
        semanticIndexFolder: "Agent Memory",
        semanticIndexPersistVectors: true,
        maxAgentSteps: 30,
        streamWritebackMode: "off",
      };
      target.appendConversationMessage = mockAppendConversationMessage;
      target.clearConversationHistory = mockClearConversationHistory;
      target.saveSettings = mockSaveSettings;
      target.createModelClient = mockCreateModelClient;
      target.createToolExecutionContext = mockCreateToolExecutionContext;
      target.__playwrightE2EMockInstalled = true;

      const prototype = Object.getPrototypeOf(target);
      if (prototype) {
        prototype.appendConversationMessage = mockAppendConversationMessage;
        prototype.clearConversationHistory = mockClearConversationHistory;
        prototype.saveSettings = mockSaveSettings;
        prototype.createModelClient = mockCreateModelClient;
        prototype.createToolExecutionContext = mockCreateToolExecutionContext;
      }
    }
  }, { ...input, pluginId: PLUGIN_ID, aiMode, aiConfig, semanticEmbeddingConfig });
}

async function expectRunButtonClickable(page: Page) {
  const runButton = page.locator("button.agentic-researcher-run");
  await expect(runButton).toBeVisible();
  await expect(runButton).toBeEnabled();
  await expect(runButton).toHaveText("Run Mission");
  await expect(runButton).toHaveAttribute("aria-label", "Run Mission");
  const blockingElement = await runButton.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const element = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (element === button || button.contains(element)) {
      return null;
    }

    return element
      ? `${element.tagName.toLowerCase()}.${Array.from(element.classList).join(".")}`
      : "none";
  });
  expect(blockingElement).toBeNull();
  await runButton.click({ trial: true });
}

async function expectPromptClickable(page: Page) {
  const prompt = page.locator("textarea.agentic-researcher-prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt).toBeEnabled();
  const blockingElement = await prompt.evaluate((textarea) => {
    const rect = textarea.getBoundingClientRect();
    const points = [
      [rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 24)],
      [rect.left + 12, rect.top + 12],
      [rect.right - 12, rect.bottom - 12],
    ];
    for (const [x, y] of points) {
      const element = document.elementFromPoint(x, y);
      if (element === textarea || textarea.contains(element)) {
        continue;
      }

      return element
        ? `${element.tagName.toLowerCase()}.${Array.from(element.classList).join(".")}`
        : "none";
    }

    return null;
  });
  expect(blockingElement).toBeNull();
  const before = await prompt.inputValue();
  const probe = `probe-${Date.now()}`;
  await prompt.click();
  await prompt.evaluate((textarea) => {
    const input = textarea as HTMLTextAreaElement;
    input.setSelectionRange(input.value.length, input.value.length);
  });
  await page.keyboard.type(probe);
  await expect(prompt).toHaveValue(`${before}${probe}`);
  await prompt.fill(before);
}

function assertBox(
  box: { x: number; y: number; width: number; height: number } | null,
): asserts box is { x: number; y: number; width: number; height: number } {
  expect(box).not.toBeNull();
}

async function clearChatInline(page: Page) {
  const clearButton = page.locator("button.agentic-researcher-clear");
  await expect(clearButton).toHaveText("Clear chat");
  await clearButton.click();
  await expect(clearButton).toHaveText("Confirm clear");
  await clearButton.click();
  await expect(clearButton).toHaveText("Clear chat");
  await expect(page.locator("textarea.agentic-researcher-prompt")).toBeFocused();
}

async function seedConversationHistory(
  page: Page,
  history: Array<{ role: "user" | "assistant"; content: string }>,
) {
  await page.evaluate(async ({ pluginId, history: nextHistory }) => {
    const obsidianWindow = window as typeof window & { app?: any };
    const app = obsidianWindow.app;
    const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
    if (!plugin) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }

    const leaves =
      obsidianWindow.app?.workspace?.getLeavesOfType?.("agentic-researcher-view") ?? [];
    const targets = [
      plugin,
      ...leaves.map((leaf: { view?: { plugin?: unknown } }) => leaf.view?.plugin),
    ].filter(Boolean);
    for (const target of targets) {
      (target as { conversationHistory?: typeof nextHistory }).conversationHistory =
        nextHistory;
    }

    const activeFilePath = app?.workspace?.getActiveFile?.()?.path ?? "";
    const lastSlash = activeFilePath.lastIndexOf("/");
    const projectRoot = lastSlash > 0 ? activeFilePath.slice(0, lastSlash) : "";
    const memoryFolder = projectRoot ? `${projectRoot}/Agent Memory` : "Agent Memory";
    const conversationPath = `${memoryFolder}/conversation-history.json`;
    const memoryParts = memoryFolder.split("/").filter(Boolean);
    let currentPath = "";
    for (const part of memoryParts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (app.vault.getAbstractFileByPath(currentPath)) {
        continue;
      }

      try {
        await app.vault.createFolder(currentPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists/i.test(message)) {
          throw error;
        }
      }
    }

    const serializedHistory = `${JSON.stringify(nextHistory, null, 2)}\n`;
    const existingMemoryFile = app.vault.getAbstractFileByPath(conversationPath);
    if (existingMemoryFile) {
      await app.vault.modify(existingMemoryFile, serializedHistory);
    } else {
      await app.vault.create(conversationPath, serializedHistory);
    }

    for (const leaf of leaves) {
      leaf.view?.renderConversationLog?.();
    }
  }, { pluginId: PLUGIN_ID, history });

  await expect
    .poll(
      () =>
        page.evaluate(({ pluginId }) => {
          const obsidianWindow = window as typeof window & { app?: any };
          const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
          const leaves =
            obsidianWindow.app?.workspace?.getLeavesOfType?.("agentic-researcher-view") ?? [];
          return [
            plugin,
            ...leaves.map((leaf: { view?: { plugin?: unknown } }) => leaf.view?.plugin),
          ]
            .filter(Boolean)
            .map(
              (target: { conversationHistory?: unknown }) =>
                target.conversationHistory ?? [],
            );
        }, { pluginId: PLUGIN_ID }),
      { message: "seeded conversation history should be visible to the plugin" },
    )
    .toEqual(expect.arrayContaining([history]));
}

async function expectConversationHistory(page: Page, expected: string) {
  await expect
    .poll(
      () =>
        page.evaluate(({ pluginId }) => {
          const obsidianWindow = window as typeof window & { app?: any };
          const history =
            obsidianWindow.app?.plugins?.plugins?.[pluginId]?.conversationHistory ?? [];
          return history.map((message: { content?: string }) => message.content ?? "");
        }, { pluginId: PLUGIN_ID }),
      { message: "seeded conversation history should be available to the plugin" },
    )
    .toContainEqual(expect.stringContaining(expected));
}

async function expectConversationHistoryMissing(page: Page, unexpected: string) {
  await expect
    .poll(
      () =>
        page.evaluate(({ pluginId }) => {
          const obsidianWindow = window as typeof window & { app?: any };
          const history =
            obsidianWindow.app?.plugins?.plugins?.[pluginId]?.conversationHistory ?? [];
          return history.map((message: { content?: string }) => message.content ?? "");
        }, { pluginId: PLUGIN_ID }),
      { message: "transient resume context should not be persisted to chat history" },
    )
    .not.toContainEqual(expect.stringContaining(unexpected));
}

async function reloadAssistantPanel(page: Page) {
  await page.evaluate(async ({ pluginId }) => {
    const obsidianWindow = window as typeof window & { app?: any };
    const app = obsidianWindow.app;
    const plugin = app?.plugins?.plugins?.[pluginId];
    if (!app?.workspace || !plugin) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }

    if (typeof plugin.loadSettings === "function") {
      await plugin.loadSettings();
    }
    plugin.settings = {
      ...plugin.settings,
      enableStreaming: false,
      thinkingMode: "off",
      model: "playwright-e2e-mock",
      maxAgentSteps: 30,
      streamWritebackMode: "off",
    };

    const existingAgentLeaves =
      typeof app.workspace.getLeavesOfType === "function"
        ? app.workspace.getLeavesOfType("agentic-researcher-view")
        : [];
    for (const leaf of existingAgentLeaves) {
      await leaf.detach?.();
    }

    await plugin.activateView();
  }, { pluginId: PLUGIN_ID });

  await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
    timeout: 30_000,
  });
  await assertHarnessMockReady(page);
}

async function setStreamingMode(
  page: Page,
  enabled: boolean,
  options: { aiConfig?: E2EAiConfig; aiMode?: "mock" | "real" } = {},
) {
  const aiMode = options.aiMode ?? "mock";
  const aiConfig = options.aiConfig ?? getE2EAiConfig();
  await page.evaluate(({ pluginId, enabled: shouldEnable, aiMode: mode, aiConfig: config }) => {
    const obsidianWindow = window as typeof window & { app?: any };
    const app = obsidianWindow.app;
    const plugin = app?.plugins?.plugins?.[pluginId];
    if (!plugin) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }

    const targets = [
      plugin,
      ...(app.workspace
        ?.getLeavesOfType?.("agentic-researcher-view")
        ?.map((leaf: { view?: { plugin?: unknown } }) => leaf.view?.plugin)
        ?? []),
    ];

    for (const target of targets) {
      if (!target) {
        continue;
      }
      const mutable = target as {
        settings?: Record<string, unknown>;
      };
      const nextSettings: Record<string, unknown> = {
        ...mutable.settings,
        enableStreaming: shouldEnable,
        thinkingMode: "off",
        maxAgentSteps: 30,
        streamWritebackMode: shouldEnable
          ? "all_current_note_content_writes"
          : "off",
      };
      if (mode === "real") {
        nextSettings.model = config.model;
        nextSettings.ollamaBaseUrl = config.baseUrl;
        nextSettings.ollamaApiKey =
          config.apiKey || mutable.settings?.ollamaApiKey;
      } else {
        nextSettings.model = "playwright-e2e-mock";
      }
      mutable.settings = {
        ...nextSettings,
      };
    }
  }, { pluginId: PLUGIN_ID, enabled, aiMode, aiConfig });
  if (aiMode === "real") {
    await assertHarnessRealAiReady(page, aiConfig);
  } else {
    await assertHarnessMockReady(page);
  }
}

async function setActiveNoteContent(page: Page, notePath: string, content: string) {
  await page.evaluate(async ({ notePath: targetPath, content: nextContent }) => {
    const obsidianWindow = window as typeof window & { app?: any };
    const app = obsidianWindow.app;
    const file = app?.vault?.getAbstractFileByPath?.(targetPath);
    if (!file) {
      throw new Error(`Active test note not found: ${targetPath}`);
    }

    await app.vault.modify(file, nextContent);
    const markdownLeaves =
      typeof app.workspace.getLeavesOfType === "function"
        ? app.workspace.getLeavesOfType("markdown")
        : [];
    const leaf =
      markdownLeaves.find((candidate: any) => candidate.view?.file?.path === targetPath) ??
      markdownLeaves[0] ??
      app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    app.workspace.setActiveLeaf(leaf, { focus: true });
    if (leaf.view?.editor?.setValue) {
      leaf.view.editor.setValue(nextContent);
    }
  }, { notePath, content });

  await expect
    .poll(
      async () =>
        page.evaluate(({ notePath: targetPath }) => {
          const obsidianWindow = window as typeof window & { app?: any };
          const app = obsidianWindow.app;
          return app?.workspace?.getActiveFile?.()?.path ?? "";
        }, { notePath }),
      {
        message: "active Obsidian note should settle before the next mission",
        timeout: 5_000,
      },
    )
    .toBe(notePath);
  await expect
    .poll(async () => readFile(path.join(vaultRoot, ...notePath.split("/")), "utf8"), {
      message: "active note disk content should settle before the next mission",
      timeout: 5_000,
    })
    .toBe(content);
  await expect
    .poll(
      async () =>
        page.evaluate(({ notePath: targetPath }) => {
          const obsidianWindow = window as typeof window & { app?: any };
          const app = obsidianWindow.app;
          const markdownLeaves =
            typeof app?.workspace?.getLeavesOfType === "function"
              ? app.workspace.getLeavesOfType("markdown")
              : [];
          const activeLeaf =
            markdownLeaves.find(
              (candidate: any) => candidate.view?.file?.path === targetPath,
            ) ?? null;
          return activeLeaf?.view?.editor?.getValue?.() ?? "";
        }, { notePath }),
      {
        message: "active note editor content should settle before the next mission",
        timeout: 5_000,
      },
    )
    .toBe(content);
}

async function launchObsidian(): Promise<ChildProcessWithoutNullStreams> {
  const process = spawn(
    obsidianExe,
    [
      `--remote-debugging-port=${cdpPort}`,
      "--disable-gpu",
      "--no-first-run",
      vaultRoot,
    ],
    {
      windowsHide: true,
    },
  );

  process.on("error", (error) => {
    throw error;
  });

  return process;
}

async function getOnlyObsidianVaultPage(
  browser: Browser,
  expectedVaultPath: string,
): Promise<Page> {
  const deadline = Date.now() + 60_000;
  const expectedVault = normalizeVaultPath(expectedVaultPath);
  let sawObsidianApp = false;

  while (Date.now() < deadline) {
    const vaultPages = await listObsidianVaultPages(browser);

    sawObsidianApp = sawObsidianApp || vaultPages.some((state) => state.hasApp);

    const loadedVaultPages = vaultPages.filter((state) => state.basePath);
    const unexpectedVaultPages = loadedVaultPages.filter(
      (state) => normalizeVaultPath(state.basePath ?? "") !== expectedVault,
    );
    if (unexpectedVaultPages.length > 0) {
      throw new Error(
        [
          `Obsidian e2e opened an unexpected vault. Expected only: ${expectedVaultPath}`,
          `Saw: ${unexpectedVaultPages
            .map((state) => state.basePath)
            .filter(Boolean)
            .join(", ")}`,
        ].join("\n"),
      );
    }

    const expectedVaultPages = loadedVaultPages.filter(
      (state) => normalizeVaultPath(state.basePath ?? "") === expectedVault,
    );
    if (expectedVaultPages.length === 1) {
      return expectedVaultPages[0].page;
    }
    if (expectedVaultPages.length > 1) {
      throw new Error(
        `Obsidian e2e opened ${expectedVaultPages.length} windows for ${expectedVaultPath}; expected exactly one.`,
      );
    }

    await sleep(250);
  }

  throw new Error(
    sawObsidianApp
      ? `Timed out waiting for Obsidian to load vault: ${expectedVaultPath}`
      : "Timed out waiting for the Obsidian renderer page.",
  );
}

async function listObsidianVaultPages(browser: Browser) {
  const states: Array<{
    page: Page;
    hasApp: boolean;
    basePath: string | null;
  }> = [];

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.isClosed()) {
        continue;
      }

      const state = await page
        .evaluate(() => {
          const obsidianWindow = window as typeof window & { app?: any };
          const app = obsidianWindow.app;
          const basePath = app?.vault?.adapter?.basePath;

          return {
            hasApp: Boolean(app),
            basePath: typeof basePath === "string" ? basePath : null,
          };
        })
        .catch(() => null);

      if (!state?.hasApp) {
        continue;
      }

      states.push({
        page,
        hasApp: state.hasApp,
        basePath: state.basePath,
      });
    }
  }

  return states;
}

function normalizeVaultPath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function slugifyForE2e(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled-topic"
  );
}

function getDefaultObsidianExe() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("Set OBSIDIAN_EXE to the Obsidian executable path.");
  }

  return path.join(localAppData, "Programs", "Obsidian", "Obsidian.exe");
}

function getObsidianAppStatePath() {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("Set APPDATA so e2e can isolate Obsidian's open-vault list.");
  }

  return path.join(appData, "Obsidian", "obsidian.json");
}

function getDefaultVaultRoot() {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) {
    throw new Error("Set OBSIDIAN_VAULT to the live test vault path.");
  }

  return path.join(userProfile, "OneDrive", "Desktop", "test_vault_obsidian_ai");
}

async function forceOnlyTestVaultOpen(
  filePath: string,
  existingContent: string | null,
  targetVaultPath: string,
) {
  const state = parseJsonObject(existingContent) ?? {};
  const existingVaults = isRecord(state.vaults) ? state.vaults : {};
  const normalizedTarget = normalizeVaultPath(targetVaultPath);
  let targetVaultId: string | null = null;

  const nextVaults: Record<string, Record<string, unknown>> = {};
  for (const [vaultId, rawVault] of Object.entries(existingVaults)) {
    if (!isRecord(rawVault)) {
      continue;
    }

    const candidatePath = typeof rawVault.path === "string" ? rawVault.path : "";
    const isTarget = normalizeVaultPath(candidatePath) === normalizedTarget;
    if (isTarget) {
      targetVaultId = vaultId;
    }

    nextVaults[vaultId] = {
      ...rawVault,
      open: isTarget,
    };
  }

  targetVaultId = targetVaultId ?? createStableVaultId(targetVaultPath);
  nextVaults[targetVaultId] = {
    ...(nextVaults[targetVaultId] ?? {}),
    path: targetVaultPath,
    ts: Date.now(),
    open: true,
  };

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({
      ...state,
      vaults: nextVaults,
      cli: true,
    }),
    "utf8",
  );
}

function parseJsonObject(content: string | null) {
  if (!content?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function createStableVaultId(vaultPath: string) {
  return createHash("sha256")
    .update(normalizeVaultPath(vaultPath))
    .digest("hex")
    .slice(0, 16);
}

async function expectNoRunningObsidian() {
  if (await waitForNoRunningObsidian(8_000)) {
    return;
  }

  throw new Error(
    "Obsidian is already running. Close Obsidian before npm run test:e2e so the harness can launch a controlled instance.",
  );
}

async function waitForNoRunningObsidian(timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!(await isObsidianRunning())) {
      return true;
    }

    await sleep(250);
  }

  return !(await isObsidianRunning());
}

async function isObsidianRunning() {
  const { stdout } = await execFileAsync("tasklist", [
    "/FI",
    "IMAGENAME eq Obsidian.exe",
    "/FO",
    "CSV",
    "/NH",
  ]);

  return /^"Obsidian\.exe"/im.test(stdout);
}

async function expectPortFree(port: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (response.ok) {
      throw new Error(
        `OBSIDIAN_CDP_PORT ${port} is already serving a CDP endpoint. Pick another port.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already serving")) {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForCdp(
  port: number,
  process: ChildProcessWithoutNullStreams,
  timeoutMs: number,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`Obsidian exited before CDP became available: ${process.exitCode}`);
    }

    const ok = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) {
      return;
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for Obsidian CDP on port ${port}.`);
}

async function terminateObsidian(
  process: ChildProcessWithoutNullStreams | null,
) {
  if (!process?.pid || process.exitCode !== null) {
    return;
  }

  await execFileAsync("taskkill", ["/PID", String(process.pid), "/T", "/F"]).catch(
    () => {
      process.kill();
    },
  );
  await waitForNoRunningObsidian(10_000);
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  });
}

async function listFilesRecursively(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }

      throw error;
    },
  );
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function seedPluginConversationHistory(
  filePath: string,
  existingContent: string | null,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
) {
  let data: Record<string, unknown> = {};
  if (existingContent?.trim()) {
    try {
      const parsed = JSON.parse(existingContent) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = {};
    }
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        ...data,
        enableStreaming: false,
        thinkingMode: "off",
        model: "playwright-e2e-mock",
        maxAgentSteps: 30,
        streamWritebackMode: "off",
        conversationHistory,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function restoreOptionalFile(filePath: string, content: string | null) {
  if (content === null) {
    await rm(filePath, { force: true });
    return;
  }

  await writeFile(filePath, content, "utf8");
}

async function ensureCommunityPluginEnabled(filePath: string, pluginId: string) {
  const existing = await readOptionalFile(filePath);
  let pluginIds: string[] = [];

  if (existing?.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (Array.isArray(parsed)) {
        pluginIds = parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      pluginIds = [];
    }
  }

  if (!pluginIds.includes(pluginId)) {
    pluginIds = [...pluginIds, pluginId];
  }

  await writeFile(filePath, `${JSON.stringify(pluginIds, null, 2)}\n`, "utf8");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
