import { expect, test, chromium, type Browser, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  getE2EAiConfig,
  shouldRunRealAiE2E,
  type E2EAiConfig,
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
      await expect(
        page.locator(".agentic-researcher-log", { hasText: persistedChat }),
      ).toBeVisible();

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
      page.locator(".agentic-researcher-log-message", {
        hasText: input.folderAnswerMarker,
      }),
    ).toBeVisible();
    await expectToolRun(page, "inspect_vault_context");
  });
});

test("autonomous loop completes 1 5 10 15 25 and 30 step runs", async () => {
  test.setTimeout(600_000);
  await withE2EHarness("autonomous-loop-depth", async ({ page }) => {
    await setStreamingMode(page, false);

    for (const steps of [1, 5, 10, 15, 25, 30]) {
      const marker = `E2E_LOOP_DONE_${steps}`;
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
          hasText: `Step ${steps}/30`,
        }),
      ).toBeVisible({ timeout: 30_000 });
      if (steps > 1) {
        await expectToolRun(page, "get_note_graph_context");
      }
      if (steps >= 5) {
        await expectLatestAgentCheckpoint(page, `- Step: ${steps} of 30`);
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
  test("opt-in smoke subset writes notes and artifacts without safety-limit stop", async () => {
    test.skip(
      !shouldRunRealAiE2E(),
      "Set E2E_REAL_AI=1, E2E_AI_MODE=real, and E2E_OLLAMA_API_KEY to run real-AI e2e.",
    );
    test.setTimeout(900_000);
    const realAiConfig = getE2EAiConfig();
    const realScenarios = generatedOutputPromptScenarios.filter((scenario) =>
      ["revolutionary-war-100", "grapes-cited", "three-block-diagram"].includes(
        scenario.name,
      ),
    );

    await withE2EHarness(
      "real-ai-generated-output",
      async ({ page, notePath, noteFilePath, input }) => {
        await setStreamingMode(page, true);

        for (const scenario of realScenarios) {
          await runGeneratedPromptScenario(page, noteFilePath, input, scenario, {
            assertMock: false,
          });
        }

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

async function expectReceipt(page: Page, text: string) {
  await page.getByRole("tab", { name: "Run Details" }).click();
  await expect(
    page.locator(".agentic-researcher-receipt", { hasText: text }),
  ).toBeVisible();
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

async function runGeneratedPromptScenario(
  page: Page,
  noteFilePath: string,
  input: E2EInput,
  scenario: PromptScenario,
  options: { assertMock: boolean },
) {
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
  }

  if (scenario.expectReceipt) {
    await expectReceipt(page, "append");
  }
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
    memoryTopic,
    memoryMarker,
    designCanvasPath,
    designSvgPath,
    notePath,
    pluginId,
    aiMode,
    aiConfig,
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

    if (aiMode === "real") {
      plugin.settings = {
        ...plugin.settings,
        enableStreaming: true,
        thinkingMode: "off",
        model: aiConfig.model,
        ollamaBaseUrl: aiConfig.baseUrl,
        ollamaApiKey: aiConfig.apiKey,
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
                throw new Error(
                  `get_note_graph_context was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              loopStepCounts.set(key, completedToolSteps + 1);
              const toolCall = {
                id: `playwright-e2e-loop-${targetSteps}-${completedToolSteps + 1}`,
                index: 0,
                name: "get_note_graph_context",
                arguments: {},
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
        ollamaApiKey: aiConfig.apiKey,
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
        maxAgentSteps: 30,
        streamWritebackMode: "off",
      };
      activePlugin.appendConversationMessage = mockAppendConversationMessage;
      activePlugin.clearConversationHistory = mockClearConversationHistory;
      activePlugin.saveSettings = mockSaveSettings;
      activePlugin.createModelClient = mockCreateModelClient;
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
        lower.includes("generate me a 500 word essay") &&
        lower.includes("gilgamesh")
      ) {
        return "Gilgamesh essay: the story of Gilgamesh follows kingship, grief, friendship, mortality, and the search for wisdom in ancient Mesopotamian literature.\n";
      }
      if (
        lower.includes("generate me a 1000 word essay") &&
        lower.includes("grapes of wrath")
      ) {
        return "Grapes of Wrath essay: Steinbeck's Grapes of Wrath follows the Joad family through Dust Bowl migration, labor exploitation, and collective survival.\n";
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

    function installMockOverrides(target: any) {
      if (!target) {
        return;
      }

      target.settings = {
        ...target.settings,
        enableStreaming: false,
        thinkingMode: "off",
        model: "playwright-e2e-mock",
        maxAgentSteps: 30,
        streamWritebackMode: "off",
      };
      target.appendConversationMessage = mockAppendConversationMessage;
      target.clearConversationHistory = mockClearConversationHistory;
      target.saveSettings = mockSaveSettings;
      target.createModelClient = mockCreateModelClient;
      target.__playwrightE2EMockInstalled = true;

      const prototype = Object.getPrototypeOf(target);
      if (prototype) {
        prototype.appendConversationMessage = mockAppendConversationMessage;
        prototype.clearConversationHistory = mockClearConversationHistory;
        prototype.saveSettings = mockSaveSettings;
        prototype.createModelClient = mockCreateModelClient;
      }
    }
  }, { ...input, pluginId: PLUGIN_ID, aiMode, aiConfig });
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
  await page.evaluate(({ pluginId, history: nextHistory }) => {
    const obsidianWindow = window as typeof window & { app?: any };
    const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
    if (!plugin) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }

    plugin.conversationHistory = nextHistory;
  }, { pluginId: PLUGIN_ID, history });

  await expect
    .poll(
      () =>
        page.evaluate(({ pluginId }) => {
          const obsidianWindow = window as typeof window & { app?: any };
          return obsidianWindow.app?.plugins?.plugins?.[pluginId]?.conversationHistory ?? [];
        }, { pluginId: PLUGIN_ID }),
      { message: "seeded conversation history should be visible to the plugin" },
    )
    .toEqual(history);
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

async function setStreamingMode(page: Page, enabled: boolean) {
  await page.evaluate(({ pluginId, enabled: shouldEnable }) => {
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
      mutable.settings = {
        ...mutable.settings,
        enableStreaming: shouldEnable,
        thinkingMode: "off",
        model: "playwright-e2e-mock",
        maxAgentSteps: 30,
        streamWritebackMode: shouldEnable
          ? "all_current_note_content_writes"
          : "off",
      };
    }
  }, { pluginId: PLUGIN_ID, enabled });
  await assertHarnessMockReady(page);
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
