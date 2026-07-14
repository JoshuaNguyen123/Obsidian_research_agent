import { expect, test, chromium, type Browser, type Locator, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildBackgroundAuthorizationV1,
  buildCompanionReceiptV1,
  buildMissionCapabilityEnvelopeV1,
  CompanionCoordinatorClientV1,
  CompanionWorkerCoordinatorV1,
  createSessionBootstrapTokenLeaseV1,
  type BackgroundAuthorizationV1,
  type CompanionEventV1,
  type CompanionReceiptV1,
  type CompanionRemoteJobV1,
  type HeadlessDomainExecutorV1,
  type MissionGraphV3,
  type MissionNodeV3,
} from "../packages/headless-runtime/src";
import { MissionGraphSession } from "../src/agent/missionGraphSession";
import {
  createMissionLedger,
  writeMissionLedger,
} from "../src/agent/missionLedger";
import {
  createMissionRuntimeSnapshot,
  readMissionRuntimeSnapshotByRunId,
  writeMissionRuntimeSnapshot,
} from "../src/agent/runStore";
import type { ToolExecutionContext } from "../src/tools/types";
import {
  getE2EAiConfig,
  getE2ESemanticEmbeddingConfig,
  shouldRunRealAiE2E,
  type E2EAiConfig,
  type E2ESemanticEmbeddingConfig,
} from "./aiHarness";
import {
  restoreOwnedE2EArtifacts,
  snapshotOwnedE2EArtifacts,
} from "./fixtures/ownedE2EArtifacts";
import { expectRenderedScreenshotState } from "./fixtures/renderedScreenshotQa";
import {
  generatedOutputPromptScenarios,
  type PromptScenario,
} from "./promptMatrix";
import { terminateControlledObsidian } from "../scripts/obsidian-process-lifecycle";

const execFileAsync = promisify(execFile);

const PLUGIN_ID = "agentic-researcher";
const OPTIONAL_EXTENSION_IDS = [
  "agentic-researcher-code",
  "agentic-researcher-integrations",
  "agentic-researcher-companion",
] as const;
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

test("controlled Obsidian teardown drains before the next launch", async () => {
  test.setTimeout(180_000);

  await withE2EHarness("controlled-teardown-first", async ({ page }) => {
    await expect(page.locator(".agentic-researcher-view")).toHaveCount(1);
  });
  await expectNoRunningObsidian();
  await expectPortFree(cdpPort);

  await withE2EHarness("controlled-teardown-second", async ({ page }) => {
    await expect(page.locator(".agentic-researcher-view")).toHaveCount(1);
  });
});

test("one installed plugin exposes Code, Companion, and Integrations as built-in capabilities", async () => {
  await withE2EHarness(
    "unified-plugin-capabilities",
    async ({ page, notePath, noteFilePath, input }) => {
      const projection = await page.evaluate(
        ({ corePluginId, capabilityIds }) => {
          const app = (window as typeof window & { app?: any }).app;
          const core = app?.plugins?.plugins?.[corePluginId];
          const installedAgenticIds = Object.keys(
            app?.plugins?.manifests ?? {},
          )
            .filter((id) => id.startsWith("agentic-researcher"))
            .sort();
          return {
            installedAgenticIds,
            bundled: capabilityIds.map((id) => ({
              id,
              present: Boolean(core?.getBundledCapability?.(id)),
            })),
            statusLines: core?.getExtensionStatusLines?.() ?? [],
          };
        },
        { corePluginId: PLUGIN_ID, capabilityIds: [...OPTIONAL_EXTENSION_IDS] },
      );

      expect(projection.installedAgenticIds).toEqual([PLUGIN_ID]);
      expect(projection.bundled).toEqual(
        OPTIONAL_EXTENSION_IDS.map((id) => ({ id, present: true })),
      );
      for (const capabilityId of OPTIONAL_EXTENSION_IDS) {
        const key = capabilityId.replace("agentic-researcher-", "");
        expect(projection.statusLines.join("\n")).toContain(
          `extension_${key}=registered`,
        );
      }
      const tools = await readCoreToolNames(page);
      expect(tools).toContain("run_code_block");
      expect(tools).toContain("write_workspace_file");
      expect(tools).toContain("browser_open_page");

      await page.getByRole("tab", { name: "Chat" }).click();
      await submitMission(
        page,
        `Append this exact E2E marker to the current note: ${input.marker}`,
      );
      await expectNoteToContain(
        noteFilePath,
        input.marker,
        "the unified plugin should preserve normal vault writeback",
      );
      await deleteVaultFixture(page, notePath);
    },
  );
});

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

test("silent completed turn stays conversational for the next prompt", async () => {
  await withE2EHarness("silent-turn-followup", async ({ page }) => {
    const silentPrompt = "E2E_SILENT_TURN Complete without visible assistant text.";
    const fallbackText =
      "I finished that turn but did not receive visible answer text.";

    await page.evaluate(({ pluginId, silentPrompt: prompt }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eRestoreSilentRunMission?: (() => void) | null;
      };
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      if (!plugin?.runMission || !plugin?.runCoordinator?.start) {
        throw new Error("Plugin run mission APIs were unavailable.");
      }

      const originalRunMission = plugin.runMission.bind(plugin);
      plugin.runMission = async function runMissionWithSilentTurn(
        missionPrompt: string,
        conversationHistory: unknown[],
        options: unknown,
      ) {
        if (missionPrompt === prompt) {
          return await this.runCoordinator.start(
            async (_abortSignal: AbortSignal, events: any) => {
              events.onRunComplete?.({
                step: 1,
                maxSteps: 1,
                stopReason: "final",
              });
            },
          );
        }

        return originalRunMission(missionPrompt, conversationHistory, options);
      };
      obsidianWindow.__e2eRestoreSilentRunMission = () => {
        plugin.runMission = originalRunMission;
        obsidianWindow.__e2eRestoreSilentRunMission = null;
      };
    }, { pluginId: PLUGIN_ID, silentPrompt });

    try {
      await submitMission(page, silentPrompt, { assertMock: false });
      await expect(
        page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
          hasText: fallbackText,
        }),
      ).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(
          () =>
            page.evaluate(({ pluginId, fallback }) => {
              const obsidianWindow = window as typeof window & { app?: any };
              const history =
                obsidianWindow.app?.plugins?.plugins?.[pluginId]?.conversationHistory ??
                [];
              return history.some(
                (message: { role?: string; content?: string }) =>
                  message.role === "assistant" &&
                  message.content?.includes(fallback),
              );
            }, { pluginId: PLUGIN_ID, fallback: fallbackText }),
          {
            message: "silent run fallback should be persisted as assistant history",
            timeout: 10_000,
          },
        )
        .toBe(true);
    } finally {
      await page.evaluate(() => {
        const obsidianWindow = window as typeof window & {
          __e2eRestoreSilentRunMission?: (() => void) | null;
        };
        obsidianWindow.__e2eRestoreSilentRunMission?.();
      });
    }

    await submitMission(
      page,
      "E2E_DAY1_CHAT_ANSWER_NO_TOOLS: What is 2+2? Answer in chat only; do not write to the note and do not use tools.",
    );
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_DAY1_CHAT_ANSWER",
      }),
    ).toBeVisible({ timeout: 30_000 });
  });
});

test("day-1 chat answer without tools", async () => {
  await withE2EHarness("day1-chat-answer-no-tools", async ({ page, noteFilePath }) => {
    const before = (await readOptionalFile(noteFilePath)) ?? "";
    await setStreamingMode(page, false);

    await submitMission(
      page,
      "E2E_DAY1_CHAT_ANSWER_NO_TOOLS: What is 2+2? Answer in chat only; do not write to the note and do not use tools.",
    );

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_DAY1_CHAT_ANSWER",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Run Details" }).click();
    await expect(page.locator(".agentic-researcher-tool-item")).toHaveCount(0);
    await expectNoReceipts(page);
    await expect
      .poll(async () => (await readOptionalFile(noteFilePath)) ?? "", {
        message: "chat-only answer must not mutate the current note",
        timeout: 5_000,
      })
      .toBe(before);
  });
});

test("explicit GitHub review repair uses the native exact approval surface and denial performs zero pushes", async () => {
  test.setTimeout(240_000);

  await withE2EHarness("github-review-repair-approval-route", async ({ page, input }) => {
    await installGitHubReviewRepairApprovalRouteHarness(page, input.marker);
    try {
      await submitMission(
        page,
        `Address the GitHub PR review feedback for ${input.marker}.`,
        { waitForCompletion: false },
      );
      await page.getByRole("tab", { name: "Run Details" }).click();
      const approvedCard = activePreparedApproval(page, "github_review_repair");
      await expect(approvedCard).toBeVisible({ timeout: 30_000 });
      await expect(approvedCard).toContainText("github_review_repair");
      await expect(approvedCard).toContainText("confirmation=1/1");
      await expect(approvedCard).toContainText("sha256:");
      expect(await readGitHubReviewRepairRoutePushCount(page)).toBe(0);
      await approvePreparedApproval(page, approvedCard);
      await waitForMissionComplete(page, 120_000);
      expect(await readGitHubReviewRepairRoutePushCount(page)).toBe(1);

      await page.getByRole("tab", { name: "Chat" }).click();
      await submitMission(
        page,
        `Handle the GitHub pull request review comments for ${input.secondMarker}.`,
        { waitForCompletion: false },
      );
      await page.getByRole("tab", { name: "Run Details" }).click();
      const deniedCard = activePreparedApproval(page, "github_review_repair");
      await expect(deniedCard).toBeVisible({ timeout: 30_000 });
      expect(await readGitHubReviewRepairRoutePushCount(page)).toBe(1);
      await deniedCard
        .locator("button.agentic-researcher-approval-deny")
        .click();
      const deniedResolvedCard = page
        .locator(".agentic-researcher-approval-card", {
          hasText: "github_review_repair",
        })
        .last();
      await expect(deniedResolvedCard).toContainText("decision=denied");
      await waitForMissionComplete(page, 120_000);
      expect(await readGitHubReviewRepairRoutePushCount(page)).toBe(1);
    } finally {
      await restoreGitHubReviewRepairApprovalRouteHarness(page);
    }
  });
});

test("day-1 clear chat clears memory only", async () => {
  await withE2EHarness(
    "day1-clear-chat-memory-only",
    async ({ page, notePath, noteFilePath, input }) => {
      const noteBefore = `Day-1 clear-chat note body ${input.marker}`;
      await setActiveNoteContent(page, notePath, noteBefore);
      const settingsBefore = await page.evaluate(({ pluginId }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        return {
          model: plugin?.settings?.model ?? null,
          keepAwakeDuringOvernightRuns:
            plugin?.settings?.keepAwakeDuringOvernightRuns ?? null,
          modelRouterMode: plugin?.settings?.modelRouterMode ?? null,
        };
      }, { pluginId: PLUGIN_ID });

      await expectConversationHistory(page, "Day1 persisted chat memory");
      await clearChatInline(page);
      await expectConversationHistoryMissing(page, "Day1 persisted chat memory");
      await expect
        .poll(
          () =>
            page.evaluate(({ pluginId }) => {
              const history =
                (window as typeof window & { app?: any }).app?.plugins?.plugins?.[
                  pluginId
                ]?.conversationHistory ?? [];
              return Array.isArray(history) ? history.length : -1;
            }, { pluginId: PLUGIN_ID }),
          {
            message: "clear chat should empty conversationHistory",
            timeout: 5_000,
          },
        )
        .toBe(0);

      await expect
        .poll(async () => (await readOptionalFile(noteFilePath)) ?? "", {
          message: "clear chat must not modify the current note",
          timeout: 5_000,
        })
        .toBe(noteBefore);

      const settingsAfter = await page.evaluate(({ pluginId }) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        return {
          model: plugin?.settings?.model ?? null,
          keepAwakeDuringOvernightRuns:
            plugin?.settings?.keepAwakeDuringOvernightRuns ?? null,
          modelRouterMode: plugin?.settings?.modelRouterMode ?? null,
        };
      }, { pluginId: PLUGIN_ID });
      expect(settingsAfter).toEqual(settingsBefore);
    },
    {
      conversationHistory: [
        {
          role: "assistant",
          content: "Day1 persisted chat memory",
        },
      ],
    },
  );
});

test("day-1 overnight activates only for explicit overnight prompts", async () => {
  await withE2EHarness("day1-overnight-explicit-only", async ({ page, noteFilePath, input }) => {
    await setPluginSettingOverrides(page, {
      overnightRunsEnabled: true,
      overnightRunHours: 10,
      overnightMaxSegments: 24,
    });
    await setStreamingMode(page, false);

    const missionStartedAt = Date.now();
    await submitMission(
      page,
      `Append this exact E2E marker to the current note: ${input.marker}`,
    );
    await expectNoteToContain(
      noteFilePath,
      input.marker,
      "ordinary append should still write without overnight activation",
    );
    await expect(page.locator(".agentic-researcher-view")).not.toContainText(
      "Durable overnight mission activated.",
    );
    const overnightManifests = await page.evaluate(async ({ missionStartedAt }) => {
      const app = (window as typeof window & { app?: any }).app;
      const folder = app?.vault?.getAbstractFileByPath?.("Agent Runs/Missions");
      if (!folder?.children) {
        return [];
      }
      return folder.children
        .filter((child: { path?: string; stat?: { mtime?: number } }) =>
          /^Agent Runs\/Missions\/overnight-run-/u.test(child.path ?? "") &&
          (child.stat?.mtime ?? 0) >= missionStartedAt - 2_000,
        )
        .map((child: { path?: string }) => child.path ?? "");
    }, { missionStartedAt });
    expect(overnightManifests).toEqual([]);
  });
});

test("day-1 stop mission mid-run leaves resumable ledger", async () => {
  test.setTimeout(180_000);
  await withE2EHarness("day1-stop-mid-run", async ({ page }) => {
    await setStreamingMode(page, false);

    await submitMission(
      page,
      "Inspect the current note graph for E2E_DAY1_STOP_MID_RUN and E2E_LOOP_STEPS_8 and complete exactly 8 model steps before the final answer.",
      { waitForCompletion: false },
    );

    await expect(page.locator("button.agentic-researcher-run")).toHaveText(
      "Stop Mission",
      { timeout: 15_000 },
    );
    await expectToolRun(page, "get_note_graph_context");
    await page.getByRole("tab", { name: "Chat" }).click();
    await page.locator("button.agentic-researcher-run").click();
    await expect(page.locator("button.agentic-researcher-run")).toHaveText(
      "Run Mission",
      { timeout: 60_000 },
    );
    await page.getByRole("tab", { name: "Run Details" }).click();
    await expectDetailsText(page, "ledger_can_resume=on");
    await expect(
      page.getByRole("button", { name: "Continue Latest Run" }),
    ).toBeVisible({ timeout: 15_000 });
  });
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

test("chat loader stays hidden without stale idle text until active", async () => {
  await withE2EHarness("chat-loader-active-state", async ({ page }) => {
    const loader = page.locator(".agentic-researcher-chat-loader");
    const loaderText = page.locator(".agentic-researcher-chat-loader-text");
    const staleIdleLoader = loader.filter({ hasText: /\bidle\b/i });

    await expect(loader).toBeHidden();
    await expect(staleIdleLoader).toHaveCount(0);

    await reloadAssistantPanel(page);
    await expect(loader).toBeHidden();
    await expect(staleIdleLoader).toHaveCount(0);

    const prompt =
      "Inspect the current note graph for E2E_LOOP_STEPS_5 and complete exactly 5 model steps before the final answer.";
    await submitMission(page, prompt, { waitForCompletion: false });

    await expect(loader).toBeVisible({ timeout: 5_000 });
    await expect(loaderText).not.toHaveText(/\bidle\b/i);

    await waitForMissionComplete(page, 90_000);
    await expect(loader).toBeHidden();
    await expect(staleIdleLoader).toHaveCount(0);
  });
});

test("active mission survives panel detach and replays progress after reopen", async () => {
  test.setTimeout(180_000);
  await withE2EHarness("mission-view-reattach", async ({ page }) => {
    await setStreamingMode(page, false);

    const completionMarker = "E2E_VIEW_REATTACH_DONE";
    const prompt = `Say ${completionMarker} in chat.`;
    await expect(page.locator(".agentic-researcher-tool-item")).toHaveCount(0);
    await page.evaluate(({ pluginId }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eDetachedAgentView?: unknown;
        __e2eAllowViewReattachCompletion?: boolean;
        __e2eViewReattachActive?: boolean;
      };
      const app = obsidianWindow.app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      if (!plugin) {
        throw new Error("Agentic Researcher plugin was unavailable for detach.");
      }
      obsidianWindow.__e2eAllowViewReattachCompletion = false;
      obsidianWindow.__e2eViewReattachActive = true;
    }, { pluginId: PLUGIN_ID });
    await page.evaluate(async ({ pluginId, prompt }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eViewReattachRunPromise?: Promise<unknown>;
      };
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      if (!plugin?.runMission || !plugin?.appendConversationMessage) {
        throw new Error("Mission coordinator API was unavailable.");
      }
      await plugin.appendConversationMessage({ role: "user", content: prompt });
      obsidianWindow.__e2eViewReattachRunPromise = plugin.runMission(
        prompt,
        [...(plugin.conversationHistory ?? [])],
      );
    }, { pluginId: PLUGIN_ID, prompt });

    await expect
      .poll(
        () =>
          page.evaluate(({ pluginId }) => {
            const obsidianWindow = window as typeof window & { app?: any };
            return Boolean(
              obsidianWindow.app?.plugins?.plugins?.[pluginId]?.isMissionRunning?.(),
            );
          }, { pluginId: PLUGIN_ID }),
        { timeout: 10_000 },
      )
      .toBe(true);

    const detached = await page.evaluate(async ({ pluginId }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eDetachedAgentView?: unknown;
      };
      const app = obsidianWindow.app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      const leaf = app?.workspace?.getLeavesOfType?.("agentic-researcher-view")?.[0];
      if (!leaf) {
        throw new Error("Active Agentic Researcher view was unavailable for detach.");
      }
      obsidianWindow.__e2eDetachedAgentView = leaf.view;
      const wasRunning = Boolean(plugin?.isMissionRunning?.());
      await leaf.detach?.();
      return {
        wasRunning,
        remainingViews:
          app.workspace.getLeavesOfType?.("agentic-researcher-view")?.length ?? -1,
      };
    }, { pluginId: PLUGIN_ID });

    expect(detached).toEqual({ wasRunning: true, remainingViews: 0 });
    await expect(page.locator(".agentic-researcher-view")).toHaveCount(0);

    const reopened = await page.evaluate(async ({ pluginId }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eDetachedAgentView?: unknown;
      };
      const app = obsidianWindow.app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      if (!plugin?.activateView) {
        throw new Error(`Plugin activation API was unavailable: ${pluginId}`);
      }

      await plugin.activateView();
      const leaf = app.workspace.getLeavesOfType?.("agentic-researcher-view")?.[0];
      return {
        isNewView: Boolean(
          leaf?.view && leaf.view !== obsidianWindow.__e2eDetachedAgentView,
        ),
        isRunning: Boolean(plugin.isMissionRunning?.()),
        snapshot: plugin.getMissionRunSnapshot?.() ?? null,
        buttonText:
          leaf?.view?.contentEl?.querySelector?.("button.agentic-researcher-run")
            ?.textContent ?? null,
      };
    }, { pluginId: PLUGIN_ID });

    expect(reopened.isNewView).toBe(true);
    expect(reopened.isRunning).toBe(true);
    await expect(page.locator(".agentic-researcher-view")).toHaveCount(1);
    await expect(page.locator("button.agentic-researcher-run")).toHaveText(
      "Stop Mission",
      { timeout: 10_000 },
    );
    await expect(page.locator(".agentic-researcher-run-status-text")).toHaveText(
      "Running mission...",
    );
    await page.evaluate(() => {
      const obsidianWindow = window as typeof window & {
        __e2eAllowViewReattachCompletion?: boolean;
      };
      obsidianWindow.__e2eAllowViewReattachCompletion = true;
    });

    await waitForMissionComplete(page, 120_000);
    await page.getByRole("tab", { name: "Chat" }).click();
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: completionMarker,
      }),
    ).toHaveCount(1);
    await expect
      .poll(
        () =>
          page.evaluate(({ pluginId, marker }) => {
            const obsidianWindow = window as typeof window & { app?: any };
            const history =
              obsidianWindow.app?.plugins?.plugins?.[pluginId]?.conversationHistory ?? [];
            return history.filter(
              (message: { role?: string; content?: string }) =>
                message.role === "assistant" && message.content?.includes(marker),
            ).length;
          }, { pluginId: PLUGIN_ID, marker: completionMarker }),
        {
          message: "reattached mission should persist exactly one assistant result",
          timeout: 10_000,
        },
      )
      .toBe(1);
  });
});

test("long-run event flood stays bounded across pane detach and replay", async () => {
  test.setTimeout(180_000);
  await withE2EHarness("bounded-run-replay", async ({ page, input }) => {
    const completionMarker = `E2E_BOUNDED_REPLAY_DONE_${input.marker}`;
    let released = false;

    try {
      const floodedSnapshot = await page.evaluate(
        ({ pluginId, completionMarker }) => {
          const obsidianWindow = window as typeof window & {
            app?: any;
            __e2eBoundedReplayPlugin?: any;
            __e2eBoundedReplayRelease?: (() => void) | null;
            __e2eBoundedReplayRunPromise?: Promise<unknown>;
          };
          const plugin =
            obsidianWindow.app?.workspace?.getLeavesOfType?.(
              "agentic-researcher-view",
            )?.[0]?.view?.plugin ??
            obsidianWindow.app?.plugins?.plugins?.[pluginId];
          const coordinator = plugin?.runCoordinator;
          if (!coordinator?.start || !plugin?.appendConversationMessage) {
            throw new Error("Private mission coordinator API was unavailable.");
          }

          obsidianWindow.__e2eBoundedReplayPlugin = plugin;
          obsidianWindow.__e2eBoundedReplayRelease = null;
          const largePayload = "bounded-replay-payload-".repeat(48);
          obsidianWindow.__e2eBoundedReplayRunPromise = coordinator.start(
            async (abortSignal: AbortSignal, events: any) => {
              for (let index = 0; index < 840; index += 1) {
                const step = index + 1;
                events.onStatus?.(
                  `Bounded replay status ${step}: ${largePayload}`,
                );
                events.onTrace?.({
                  id: `e2e-bounded-replay-trace-${step}`,
                  kind: "tool_result",
                  step,
                  message: `Bounded replay trace ${step}: ${largePayload}`,
                  toolName: "web_fetch",
                });
                events.onToolStart?.({
                  id: `e2e-bounded-replay-tool-${step}`,
                  name: "web_fetch",
                  step,
                  message: `Bounded replay tool ${step}: ${largePayload}`,
                });
              }

              await new Promise<void>((resolve) => {
                const finish = () => {
                  abortSignal.removeEventListener("abort", finish);
                  obsidianWindow.__e2eBoundedReplayRelease = null;
                  resolve();
                };
                obsidianWindow.__e2eBoundedReplayRelease = finish;
                if (abortSignal.aborted) {
                  finish();
                } else {
                  abortSignal.addEventListener("abort", finish, { once: true });
                }
              });

              if (abortSignal.aborted) {
                events.onRunComplete?.({
                  step: 840,
                  maxSteps: 840,
                  stopReason: "user_stopped",
                });
                return;
              }

              events.onAssistantMessageStart?.();
              events.onAssistantReplace?.(completionMarker);
              events.onAssistantMessageDone?.();
              await plugin.appendConversationMessage({
                role: "assistant",
                content: completionMarker,
              });
              events.onRunComplete?.({
                step: 840,
                maxSteps: 840,
                stopReason: "final",
              });
            },
          );

          return {
            snapshot: plugin.getMissionRunSnapshot?.() ?? null,
            releaseReady:
              typeof obsidianWindow.__e2eBoundedReplayRelease === "function",
          };
        },
        { pluginId: PLUGIN_ID, completionMarker },
      );

      expect(floodedSnapshot.releaseReady).toBe(true);
      expect(floodedSnapshot.snapshot).toMatchObject({
        isRunning: true,
        state: "running",
      });
      expect(floodedSnapshot.snapshot.bufferedEventCount).toBeLessThanOrEqual(800);
      expect(floodedSnapshot.snapshot.bufferedEventChars).toBeLessThanOrEqual(
        2_000_000,
      );
      expect(floodedSnapshot.snapshot.droppedEventCount).toBeGreaterThan(0);
      expect(floodedSnapshot.snapshot.eventSequence).toBeGreaterThan(800);

      await page.evaluate(async () => {
        const obsidianWindow = window as typeof window & { app?: any };
        const leaves =
          obsidianWindow.app?.workspace?.getLeavesOfType?.(
            "agentic-researcher-view",
          ) ?? [];
        if (leaves.length !== 1) {
          throw new Error(
            `Expected one Agentic Researcher view before detach, found ${leaves.length}.`,
          );
        }
        await leaves[0].detach?.();
      });
      await expect(page.locator(".agentic-researcher-view")).toHaveCount(0);

      await page.evaluate(async ({ pluginId }) => {
        const obsidianWindow = window as typeof window & { app?: any };
        const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
        if (!plugin?.activateView) {
          throw new Error(`Plugin activation API was unavailable: ${pluginId}`);
        }
        await plugin.activateView();
      }, { pluginId: PLUGIN_ID });

      await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
        timeout: 10_000,
      });
      await expect
        .poll(
          () =>
            page.evaluate(({ pluginId }) => {
              const obsidianWindow = window as typeof window & { app?: any };
              const view =
                obsidianWindow.app?.workspace?.getLeavesOfType?.(
                  "agentic-researcher-view",
                )?.[0]?.view;
              const runPlugin = (obsidianWindow as typeof obsidianWindow & {
                __e2eBoundedReplayPlugin?: any;
              }).__e2eBoundedReplayPlugin;
              return {
                snapshot: runPlugin?.getMissionRunSnapshot?.() ?? null,
                samePluginInstance: view?.plugin === runPlugin,
                viewPluginSnapshot:
                  view?.plugin?.getMissionRunSnapshot?.() ?? null,
                viewRunningFlag: view?.isRunning ?? null,
                viewCanStart: view?.canStartMission?.() ?? null,
                buttonText:
                  view?.contentEl?.querySelector?.(
                    "button.agentic-researcher-run",
                  )?.textContent ?? null,
                statusText:
                  view?.contentEl?.querySelector?.(
                    ".agentic-researcher-run-status-text",
                  )?.textContent ?? null,
              };
            }, { pluginId: PLUGIN_ID }),
          {
            message:
              "replacement view should project the still-active coordinator state",
            timeout: 10_000,
          },
        )
        .toMatchObject({
          snapshot: { isRunning: true, state: "running" },
          samePluginInstance: true,
          viewPluginSnapshot: { isRunning: true, state: "running" },
          viewRunningFlag: true,
          viewCanStart: false,
          buttonText: "Stop Mission",
          statusText: "Running mission...",
        });

      const replaySnapshot = await page.evaluate(() => {
        const obsidianWindow = window as typeof window & {
          __e2eBoundedReplayPlugin?: any;
        };
        return (
          obsidianWindow.__e2eBoundedReplayPlugin
            ?.getMissionRunSnapshot?.() ?? null
        );
      });
      expect(replaySnapshot).toMatchObject({ isRunning: true, state: "running" });
      expect(replaySnapshot.bufferedEventCount).toBeLessThanOrEqual(800);
      expect(replaySnapshot.bufferedEventChars).toBeLessThanOrEqual(2_000_000);
      expect(replaySnapshot.droppedEventCount).toBeGreaterThan(0);

      await page.getByRole("tab", { name: "Run Details" }).click();
      await expect(
        page.locator(
          ".agentic-researcher-dashboard-section-status .agentic-researcher-status-line",
        ),
      ).toHaveCount(200);
      await expect(
        page.locator(
          ".agentic-researcher-dashboard-section-run-log .agentic-researcher-trace-row",
        ),
      ).toHaveCount(400);
      await expect(
        page.locator(
          ".agentic-researcher-dashboard-section-tool-timeline .agentic-researcher-tool-item",
        ),
      ).toHaveCount(200);

      const detailRowCounts = await page
        .locator(".agentic-researcher-dashboard-body")
        .evaluateAll((bodies) =>
          bodies
            .map(
              (body) =>
                body.querySelectorAll(":scope > .agentic-researcher-detail-line")
                  .length,
            )
            .filter((count) => count > 0),
        );
      expect(detailRowCounts.length).toBeGreaterThan(0);
      expect(Math.max(...detailRowCounts)).toBe(100);
      expect(detailRowCounts.every((count) => count <= 100)).toBe(true);

      await expect(
        page.locator(
          ".agentic-researcher-dashboard-section-status .agentic-researcher-compacted",
          { hasText: "Older activity compacted." },
        ),
      ).toBeVisible();
      await expect(
        page.locator(
          ".agentic-researcher-dashboard-section-run-log .agentic-researcher-compacted",
          { hasText: "Older activity compacted." },
        ),
      ).toBeVisible();

      const completion = await page.evaluate(
        async ({ pluginId, completionMarker }) => {
          const obsidianWindow = window as typeof window & {
            app?: any;
            __e2eBoundedReplayPlugin?: any;
            __e2eBoundedReplayRelease?: (() => void) | null;
            __e2eBoundedReplayRunPromise?: Promise<unknown>;
          };
          const release = obsidianWindow.__e2eBoundedReplayRelease;
          if (typeof release !== "function") {
            throw new Error("Bounded replay executor release was unavailable.");
          }
          release();
          const outcome = await obsidianWindow.__e2eBoundedReplayRunPromise;
          const plugin =
            obsidianWindow.__e2eBoundedReplayPlugin ??
            obsidianWindow.app?.plugins?.plugins?.[pluginId];
          const assistantCount = (plugin?.conversationHistory ?? []).filter(
            (message: { role?: string; content?: string }) =>
              message.role === "assistant" &&
              message.content?.includes(completionMarker),
          ).length;
          delete obsidianWindow.__e2eBoundedReplayRunPromise;
          delete obsidianWindow.__e2eBoundedReplayRelease;
          delete obsidianWindow.__e2eBoundedReplayPlugin;
          return {
            outcome,
            snapshot: plugin?.getMissionRunSnapshot?.() ?? null,
            assistantCount,
          };
        },
        { pluginId: PLUGIN_ID, completionMarker },
      );
      released = true;

      expect(completion.outcome).toMatchObject({ stopReason: "final" });
      expect(completion.snapshot).toMatchObject({
        isRunning: false,
        state: "idle",
        lastComplete: { stopReason: "final" },
      });
      expect(completion.assistantCount).toBe(1);
      await expect(page.locator("button.agentic-researcher-run")).toHaveText(
        "Run Mission",
      );
      await expect(page.locator(".agentic-researcher-run-status-text")).toHaveText(
        "Idle",
      );
      await page.getByRole("tab", { name: "Chat" }).click();
      await expect(
        page.locator(
          ".agentic-researcher-log-assistant .agentic-researcher-log-message",
          { hasText: completionMarker },
        ),
      ).toHaveCount(1);
    } finally {
      if (!released) {
        await page
          .evaluate(async ({ pluginId }) => {
            const obsidianWindow = window as typeof window & {
              app?: any;
              __e2eBoundedReplayPlugin?: any;
              __e2eBoundedReplayRelease?: (() => void) | null;
              __e2eBoundedReplayRunPromise?: Promise<unknown>;
            };
            obsidianWindow.__e2eBoundedReplayRelease?.();
            (
              obsidianWindow.__e2eBoundedReplayPlugin ??
              obsidianWindow.app?.plugins?.plugins?.[pluginId]
            )?.requestMissionStop?.();
            await obsidianWindow.__e2eBoundedReplayRunPromise?.catch(() => undefined);
            delete obsidianWindow.__e2eBoundedReplayRunPromise;
            delete obsidianWindow.__e2eBoundedReplayRelease;
            delete obsidianWindow.__e2eBoundedReplayPlugin;
          }, { pluginId: PLUGIN_ID })
          .catch(() => undefined);
      }
    }
  });
});

test("long-running research auto-continues one budgeted segment", async () => {
  test.setTimeout(180_000);
  await withE2EHarness("long-run-auto-segment", async ({ page, notePath }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);
    await setPluginSettingOverrides(page, {
      autoContinueLongRuns: true,
      completionDrivenLoops: false,
      maxLongRunSegments: 2,
      // The dedicated wall-clock test below proves the tight stop. This lane
      // needs enough per-segment time for three source readbacks plus write
      // verification after the durable continuation starts.
      maxRunMinutes: 1,
    });
    await page.evaluate(({ pluginId }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eAutoSegmentCounts?: {
          runComplete: number;
          assistantStart: number;
          assistantDone: number;
        };
      };
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      if (!plugin?.subscribeMissionEvents) {
        throw new Error("Mission event subscription API was unavailable.");
      }
      obsidianWindow.__e2eAutoSegmentCounts = {
        runComplete: 0,
        assistantStart: 0,
        assistantDone: 0,
      };
      plugin.subscribeMissionEvents({
        onRunComplete: () => {
          obsidianWindow.__e2eAutoSegmentCounts!.runComplete += 1;
        },
        onAssistantMessageStart: () => {
          obsidianWindow.__e2eAutoSegmentCounts!.assistantStart += 1;
        },
        onAssistantMessageDone: () => {
          obsidianWindow.__e2eAutoSegmentCounts!.assistantDone += 1;
        },
      });
    }, { pluginId: PLUGIN_ID });

    const renameTitle = `E2E Long Research Target ${Date.now()}`;
    const expectedRenamedNotePath = `${notePath.slice(
      0,
      notePath.lastIndexOf("/") + 1,
    )}${renameTitle}.md`;
    const prompt =
      "Perform long-running research for E2E_AUTO_SEGMENT_CONTINUATION. " +
      `Rename the current note to "${renameTitle}", then ` +
      "Inspect the current note graph for E2E_WALL_CLOCK and keep reading " +
      "graph context until the segment budget requires durable continuation.";
    const missionStartedAt = Date.now();
    await submitMission(page, prompt, { waitForCompletion: false });

    const firstRunId = await page.evaluate(async ({ pluginId, missionStartedAt }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const app = obsidianWindow.app;
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      const findLedgerRunId = async () => {
        const files = (app?.vault?.getFiles?.() ?? [])
          .filter((file: { path?: string; stat?: { mtime?: number } }) =>
            /^Agent Runs\/run-[^/]+\.md$/u.test(file.path ?? "") &&
            (file.stat?.mtime ?? 0) >= missionStartedAt - 2_000,
          )
          .sort(
            (
              left: { stat?: { mtime?: number } },
              right: { stat?: { mtime?: number } },
            ) => (right.stat?.mtime ?? 0) - (left.stat?.mtime ?? 0),
          );
        for (const file of files.slice(0, 8)) {
          const markdown = await app.vault.read(file);
          if (markdown.includes("E2E_AUTO_SEGMENT_CONTINUATION")) {
            return /^Agent Runs\/(.+)\.md$/u.exec(file.path)?.[1] ?? "";
          }
        }
        return "";
      };
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const runId = plugin?.getMissionRunSnapshot?.().lastConfig?.runId;
        if (typeof runId === "string" && runId) {
          return runId;
        }
        const ledgerRunId = await findLedgerRunId();
        if (ledgerRunId) {
          return ledgerRunId;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("First long-running segment did not publish a run id.");
    }, { pluginId: PLUGIN_ID, missionStartedAt });

    await page.getByRole("tab", { name: "Run Details" }).click();
    await expect(
      page.locator(".agentic-researcher-details-panel", {
        hasText: "Long research segment 1/2",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(".agentic-researcher-details-panel", {
        hasText: `Continuing long research from segment ${firstRunId}.`,
      }),
    ).toBeVisible();
    await expect(page.locator("button.agentic-researcher-run")).toHaveText(
      "Stop Mission",
    );
    await expect(page.locator(".agentic-researcher-run-status-text")).toHaveText(
      "Running mission...",
    );

    const interimState = await page.evaluate(async ({
      pluginId,
      firstRunId,
      notePath,
      expectedRenamedNotePath,
    }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eAutoSegmentCounts?: {
          runComplete: number;
          assistantStart: number;
          assistantDone: number;
        };
      };
      const app = obsidianWindow.app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      const file = app?.vault?.getFileByPath?.(`Agent Runs/${firstRunId}.md`);
      const markdown = file ? await app.vault.read(file) : "";
      return {
        counts: obsidianWindow.__e2eAutoSegmentCounts,
        hasRuntimeSnapshot: markdown.includes("## Runtime Snapshot"),
        snapshotOwnsFirstSegment:
          markdown.includes(`\"segmentId\": \"${firstRunId}\"`) &&
          markdown.includes("\"status\": \"paused\""),
        snapshotPinsCurrentNote: markdown.includes(
          `\"currentNotePath\": \"${expectedRenamedNotePath}\"`,
        ),
        renamedTargetExists: Boolean(
          app?.vault?.getFileByPath?.(expectedRenamedNotePath),
        ),
        originalTargetGone: !app?.vault?.getFileByPath?.(notePath),
      };
    }, {
      pluginId: PLUGIN_ID,
      firstRunId,
      notePath,
      expectedRenamedNotePath,
    });
    expect(interimState).toEqual({
      counts: { runComplete: 0, assistantStart: 0, assistantDone: 0 },
      hasRuntimeSnapshot: true,
      snapshotOwnsFirstSegment: true,
      snapshotPinsCurrentNote: true,
      renamedTargetExists: true,
      originalTargetGone: true,
    });

    const secondRunId = await page.evaluate(async ({ pluginId, firstRunId, missionStartedAt }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const app = obsidianWindow.app;
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      const findLedgerRunId = async () => {
        const files = (app?.vault?.getFiles?.() ?? [])
          .filter((file: { path?: string; stat?: { mtime?: number } }) =>
            /^Agent Runs\/run-[^/]+\.md$/u.test(file.path ?? "") &&
            (file.stat?.mtime ?? 0) >= missionStartedAt - 2_000,
          )
          .sort(
            (
              left: { stat?: { mtime?: number } },
              right: { stat?: { mtime?: number } },
            ) => (right.stat?.mtime ?? 0) - (left.stat?.mtime ?? 0),
          );
        for (const file of files.slice(0, 12)) {
          const runId = /^Agent Runs\/(.+)\.md$/u.exec(file.path)?.[1] ?? "";
          if (!runId || runId === firstRunId) {
            continue;
          }
          const markdown = await app.vault.read(file);
          if (
            markdown.includes("E2E_AUTO_SEGMENT_CONTINUATION") &&
            markdown.includes(`\"parentSegmentId\": \"${firstRunId}\"`)
          ) {
            return runId;
          }
        }
        return "";
      };
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const runId = plugin?.getMissionRunSnapshot?.().lastConfig?.runId;
        if (typeof runId === "string" && runId && runId !== firstRunId) {
          return runId;
        }
        const ledgerRunId = await findLedgerRunId();
        if (ledgerRunId) {
          return ledgerRunId;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Durable continuation segment did not publish a new run id.");
    }, { pluginId: PLUGIN_ID, firstRunId, missionStartedAt });

    await waitForMissionComplete(page, 120_000);
    await expectToolRun(page, "web_search");
    await expectToolRun(page, "web_fetch");

    const completedState = await page.evaluate(
      async ({ pluginId, firstRunId, secondRunId }) => {
        const obsidianWindow = window as typeof window & {
          app?: any;
          __e2eAutoSegmentCounts?: {
            runComplete: number;
            assistantStart: number;
            assistantDone: number;
          };
        };
        const app = obsidianWindow.app;
        const firstFile = app?.vault?.getFileByPath?.(`Agent Runs/${firstRunId}.md`);
        const secondFile = app?.vault?.getFileByPath?.(`Agent Runs/${secondRunId}.md`);
        const firstMarkdown = firstFile ? await app.vault.read(firstFile) : "";
        const secondMarkdown = secondFile ? await app.vault.read(secondFile) : "";
        return {
          lineageContinuesFirstSegment:
            secondMarkdown.includes(`\"parentSegmentId\": \"${firstRunId}\"`) &&
            secondMarkdown.includes(`\"priorSegmentIds\": [\n      \"${firstRunId}\"`) &&
            secondMarkdown.includes("\"segmentIndex\": 1"),
          verifierPreventedPrematureFinal:
            firstMarkdown.includes("\"acceptance\"") &&
            firstMarkdown.includes("needs_more_work"),
          continuationAccepted:
            secondMarkdown.includes('"status": "pass"') ||
            secondMarkdown.includes("E2E_AUTO_SEGMENT_CONTINUATION_DONE"),
          sourceCoverageRecorded: [
            "https://alpha.example.com/deep-source",
            "https://beta.example.org/deep-source",
            "https://gamma.example.net/deep-source",
          ].every((url) => secondMarkdown.includes(url)),
          passageProofRecorded:
            secondMarkdown.includes('"passageIds"') &&
            secondMarkdown.includes(":passage:"),
        };
      },
      { pluginId: PLUGIN_ID, firstRunId, secondRunId },
    );
    expect(completedState.lineageContinuesFirstSegment).toBe(true);
    expect(completedState.verifierPreventedPrematureFinal).toBe(true);
    expect(completedState.continuationAccepted).toBe(true);
    expect(completedState.sourceCoverageRecorded).toBe(true);
    expect(completedState.passageProofRecorded).toBe(true);
  });
});

test("overnight research uses two durable bounded segments and one terminal completion", async () => {
  test.setTimeout(240_000);
  await withE2EHarness("overnight-durable-two-segments", async ({ page, notePath }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);
    await setPluginSettingOverrides(page, {
      overnightRunsEnabled: true,
      overnightRunHours: 8,
      overnightMaxSegments: 2,
      autoResumeOvernightRuns: true,
      keepAwakeDuringOvernightRuns: false,
      maxAgentSteps: 100,
    });
    await page.evaluate(({ pluginId }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eOvernightCounts?: {
          runComplete: number;
          assistantStart: number;
          assistantDone: number;
        };
      };
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      if (!plugin?.subscribeMissionEvents) {
        throw new Error("Mission event subscription API was unavailable.");
      }
      obsidianWindow.__e2eOvernightCounts = {
        runComplete: 0,
        assistantStart: 0,
        assistantDone: 0,
      };
      plugin.subscribeMissionEvents({
        onRunComplete: () => {
          obsidianWindow.__e2eOvernightCounts!.runComplete += 1;
        },
        onAssistantMessageStart: () => {
          obsidianWindow.__e2eOvernightCounts!.assistantStart += 1;
        },
        onAssistantMessageDone: () => {
          obsidianWindow.__e2eOvernightCounts!.assistantDone += 1;
        },
      });
    }, { pluginId: PLUGIN_ID });

    const renameTitle = `E2E Overnight Target ${Date.now()}`;
    const expectedRenamedNotePath = `${notePath.slice(
      0,
      notePath.lastIndexOf("/") + 1,
    )}${renameTitle}.md`;
    const prompt =
      "Run research for 8 hours overnight for E2E_OVERNIGHT_DURABLE and " +
      "E2E_AUTO_SEGMENT_CONTINUATION. " +
      `Rename the current note to "${renameTitle}", then inspect the current ` +
      "note graph for E2E_WALL_CLOCK and research with deep web " +
      "sources until the durable mission is complete.";
    const missionStartedAt = Date.now();

    await submitMission(page, prompt, {
      waitForCompletion: false,
    });
    await page.getByRole("tab", { name: "Run Details" }).click();
    await expect(
      page.locator(".agentic-researcher-details-panel", {
        hasText: "Durable overnight mission activated.",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("button.agentic-researcher-run")).toHaveText(
      "Stop Mission",
    );

    await waitForMissionComplete(page, 180_000);
    await assertMockModelUsed(page);

    const completed = await page.evaluate(async ({
      pluginId,
      missionStartedAt,
      prompt,
      expectedRenamedNotePath,
    }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eRestoreOvernightClock?: (() => void) | null;
        __e2eOvernightCounts?: {
          runComplete: number;
          assistantStart: number;
          assistantDone: number;
        };
      };
      const app = obsidianWindow.app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      const candidates = (app?.vault?.getFiles?.() ?? [])
        .filter((file: { path?: string; stat?: { mtime?: number } }) =>
          /^Agent Runs\/Missions\/[^/]+\.md$/u.test(file.path ?? "") &&
          (file.stat?.mtime ?? 0) >= missionStartedAt - 2_000,
        )
        .sort(
          (
            left: { stat?: { mtime?: number } },
            right: { stat?: { mtime?: number } },
          ) => (right.stat?.mtime ?? 0) - (left.stat?.mtime ?? 0),
        );
      let manifestPath = "";
      let manifest: any = null;
      for (const file of candidates) {
        const markdown = await app.vault.read(file);
        if (!markdown.includes("E2E_OVERNIGHT_DURABLE")) {
          continue;
        }
        const json = /## Durable Mission Manifest\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(
          markdown,
        )?.[1];
        if (json) {
          manifestPath = file.path;
          manifest = JSON.parse(json);
          break;
        }
      }
      if (!manifest) {
        throw new Error("The completed overnight manifest was not found.");
      }

      const childLedgers: Array<{ path: string; markdown: string }> = [];
      for (const segmentId of manifest.lineage?.childSegmentIds ?? []) {
        const path = `Agent Runs/${segmentId}.md`;
        const file = app?.vault?.getFileByPath?.(path);
        childLedgers.push({
          path,
          markdown: file ? await app.vault.read(file) : "",
        });
      }
      const assistantMessages = (plugin?.conversationHistory ?? []).filter(
        (message: { role?: string; content?: string }) =>
          message.role === "assistant" &&
          message.content?.includes("E2E_AUTO_SEGMENT_CONTINUATION_DONE_"),
      );
      const createdAtMs = Date.parse(manifest.createdAt);
      const deadlineAtMs = Date.parse(manifest.deadlineAt);
      obsidianWindow.__e2eRestoreOvernightClock?.();
      delete obsidianWindow.__e2eRestoreOvernightClock;

      return {
        manifestPath,
        manifest,
        deadlineFromCreationMs: deadlineAtMs - createdAtMs,
        deadlineFromStartMs: deadlineAtMs - missionStartedAt,
        childLedgers,
        eventCounts: obsidianWindow.__e2eOvernightCounts,
        assistantMessages: assistantMessages.map(
          (message: { content?: string }) => message.content ?? "",
        ),
        activeDurableMissionId: plugin?.getActiveDurableMissionId?.() ?? null,
        renamedTargetExists: Boolean(
          app?.vault?.getFileByPath?.(expectedRenamedNotePath),
        ),
        promptWasPersisted: manifest.prompt === prompt,
      };
    }, {
      pluginId: PLUGIN_ID,
      missionStartedAt,
      prompt,
      expectedRenamedNotePath,
    });

    expect(completed.manifestPath).toMatch(
      /^Agent Runs\/Missions\/overnight-run-[^/]+\.md$/u,
    );
    if (completed.manifest.status !== "complete") {
      throw new Error(
        `overnight manifest not complete: ${JSON.stringify(
          {
            status: completed.manifest.status,
            usage: completed.manifest.usage,
            blockers: completed.manifest.blockers,
            decision: completed.manifest.decision,
            lastOutcome: completed.manifest.lastOutcome,
            lineage: completed.manifest.lineage,
            assistantMessages: completed.assistantMessages,
            eventCounts: completed.eventCounts,
          },
          null,
          2,
        )}`,
      );
    }
    expect(completed.manifest).toMatchObject({
      version: 1,
      missionId: expect.stringMatching(/^overnight-run-/u),
      rootMissionId: expect.stringMatching(/^overnight-run-/u),
      status: "complete",
      policy: {
        durationHours: 8,
        maxSegments: 2,
        maxModelSteps: 200,
        maxToolCalls: 400,
      },
      usage: {
        segments: 2,
      },
      lineage: {
        segmentIndex: 2,
        childSegmentIds: expect.any(Array),
      },
      keepAwake: {
        requested: false,
        active: false,
      },
      reconciliation: {
        status: "clean",
      },
    });
    expect(completed.manifest.rootMissionId).toBe(
      completed.manifest.missionId,
    );
    expect(completed.manifest.lineage.childSegmentIds).toHaveLength(2);
    expect(completed.manifest.lineage.currentSegmentId).toBe(
      completed.manifest.lineage.childSegmentIds[1],
    );
    expect(completed.manifest.usage.modelSteps).toBeGreaterThanOrEqual(4);
    expect(completed.manifest.usage.modelSteps).toBeLessThanOrEqual(8);
    expect(completed.manifest.usage.toolCalls).toBeGreaterThanOrEqual(6);
    expect(completed.manifest.usage.toolCalls).toBeLessThanOrEqual(12);
    expect(completed.deadlineFromCreationMs).toBe(8 * 60 * 60 * 1_000);
    expect(completed.deadlineFromStartMs).toBeGreaterThanOrEqual(
      8 * 60 * 60 * 1_000,
    );
    expect(completed.deadlineFromStartMs).toBeLessThanOrEqual(
      8 * 60 * 60 * 1_000 + 30_000,
    );
    expect(completed.childLedgers).toHaveLength(2);
    expect(
      completed.childLedgers.every(({ markdown }) =>
        markdown.includes("E2E_OVERNIGHT_DURABLE"),
      ),
    ).toBe(true);
    expect(completed.childLedgers[1].markdown).toContain(
      `\"parentSegmentId\": \"${completed.manifest.lineage.childSegmentIds[0]}\"`,
    );
    expect(completed.activeDurableMissionId).toBeNull();
    expect(completed.renamedTargetExists).toBe(true);
    expect(completed.promptWasPersisted).toBe(true);

    await page.getByRole("tab", { name: "Chat" }).click();
    await expect(
      page.locator(
        ".agentic-researcher-log-assistant .agentic-researcher-log-message",
        { hasText: "E2E_AUTO_SEGMENT_CONTINUATION_DONE_" },
      ),
    ).toHaveCount(1);
  });
});

test("long research does not auto-continue a required tool failure", async () => {
  test.setTimeout(120_000);
  await withE2EHarness("long-run-required-tool-failure", async ({ page }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);
    await setPluginSettingOverrides(page, {
      autoContinueLongRuns: true,
      maxLongRunSegments: 3,
    });
    const missionStartedAt = Date.now();
    await submitMission(
      page,
      "Perform long-running research for E2E_LONG_RUN_REQUIRED_TOOL_FAILURE using current web sources.",
      { timeout: 120_000 },
    );

    const state = await page.evaluate(async ({ pluginId, missionStartedAt }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const app = obsidianWindow.app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      const matchingLedgers: string[] = [];
      const files = (app?.vault?.getFiles?.() ?? []).filter(
        (file: { path?: string; stat?: { mtime?: number } }) =>
          /^Agent Runs\/run-[^/]+\.md$/u.test(file.path ?? "") &&
          (file.stat?.mtime ?? 0) >= missionStartedAt - 2_000,
      );
      for (const file of files) {
        const markdown = await app.vault.read(file);
        if (markdown.includes("E2E_LONG_RUN_REQUIRED_TOOL_FAILURE")) {
          matchingLedgers.push(file.path);
        }
      }
      return {
        snapshot: plugin?.getMissionRunSnapshot?.(),
        matchingLedgers,
      };
    }, { pluginId: PLUGIN_ID, missionStartedAt });

    expect(state.snapshot?.lastComplete).toMatchObject({
      stopReason: "budget",
      autoContinueRecommended: false,
      autoContinueReason: "required_tool_failure",
    });
    expect(state.matchingLedgers).toHaveLength(1);
    await page.getByRole("tab", { name: "Run Details" }).click();
    await expect(
      page.locator(".agentic-researcher-details-panel", {
        hasText: "Long research segment",
      }),
    ).toHaveCount(0);
  });
});

test("settings basic view exposes profiles and capability status", async () => {
  await withE2EHarness("settings-basic-profiles", async ({ page }) => {
    await openPluginSettings(page);
    const settings = page.locator(".agentic-researcher-settings");
    await expect(settings.locator(".agentic-settings-basic")).toBeVisible();
    await expect(settings.getByText("Autonomy profile")).toBeVisible();
    await expect(
      settings.locator(".agentic-settings-basic .setting-item-name", {
        hasText: /^Output profile$/u,
      }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", {
        name: "Use recommended automatic defaults",
      }),
    ).toBeVisible();
    await expect(settings.locator(".agentic-capability-status")).toContainText(
      "Vault / note output",
    );
    await expect(settings.locator(".agentic-capability-status")).toContainText(
      "Semantic retrieval",
    );
    await expect(
      settings.locator("details.agentic-settings-advanced-section").first(),
    ).toBeVisible();
    await expect(settings.getByText("Utility model")).toHaveCount(0);
    await expect(settings.getByText("modelRouterEnabled")).toHaveCount(0);
  });
});

test("automatic profile resets thinking, streaming, and reflex defaults", async () => {
  await withE2EHarness("settings-automatic-profile-defaults", async ({ page }) => {
    await openPluginSettings(page);
    const settings = page.locator(".agentic-researcher-settings");
    await expect(settings.getByText("Autonomy profile")).toBeVisible();
    await page.evaluate(async ({ pluginId }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      if (!plugin || typeof plugin.loadSettings !== "function") {
        throw new Error(`Plugin settings loader is unavailable for ${pluginId}.`);
      }
      await plugin.loadSettings();
    }, { pluginId: PLUGIN_ID });

    await expect
      .poll(
        async () =>
          page.evaluate(({ pluginId }) => {
            const obsidianWindow = window as typeof window & { app?: any };
            const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
            return {
              autonomyProfile: plugin?.settings?.autonomyProfile ?? null,
              outputProfile: plugin?.settings?.outputProfile ?? null,
              thinkingMode: plugin?.settings?.thinkingMode ?? null,
              enableStreaming: plugin?.settings?.enableStreaming ?? null,
              streamWritebackMode: plugin?.settings?.streamWritebackMode ?? null,
              agenticReflexEnabled: plugin?.settings?.agenticReflexEnabled ?? null,
            };
          }, { pluginId: PLUGIN_ID }),
        { timeout: 30_000 },
      )
      .toMatchObject({
        autonomyProfile: "automatic",
        outputProfile: "active_or_new_note",
        thinkingMode: "auto",
        enableStreaming: true,
        streamWritebackMode: "all_current_note_content_writes",
        agenticReflexEnabled: true,
      });
  });
});

test("settings semantic chunk controls stay labeled and contained", async () => {
  await withE2EHarness("settings-semantic-chunk-layout", async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 820 });
    await openPluginSettings(page);

    const settings = page.locator(".agentic-researcher-settings");
    await settings
      .locator("details.agentic-settings-advanced-section", {
        hasText: "Semantic retrieval tuning",
      })
      .evaluate((el) => {
        (el as HTMLDetailsElement).open = true;
      });

    const setting = page.locator(".agentic-researcher-semantic-chunk-setting");
    await expect(setting.getByText("Semantic chunk tokens")).toBeVisible();
    await expect(
      setting.getByText(
        "Token estimates for markdown chunks. These control semantic search and the derived semantic index.",
      ),
    ).toBeVisible();
    await expect(
      setting.locator(".agentic-researcher-semantic-chunk-label"),
    ).toHaveText(["Min", "Target", "Max", "Overlap"]);
    await expect(
      setting.locator(".agentic-researcher-semantic-chunk-input"),
    ).toHaveCount(4);

    const layout = await setting.evaluate((element) => {
      const rootRect = element.getBoundingClientRect();
      const grid = element.querySelector(
        ".agentic-researcher-semantic-chunk-grid",
      );
      const gridRect = grid?.getBoundingClientRect();
      const inputRects = Array.from(
        element.querySelectorAll(".agentic-researcher-semantic-chunk-input"),
      ).map((input) => input.getBoundingClientRect());
      return {
        gridWidth: gridRect?.width ?? 0,
        inputOverflow: inputRects.some(
          (rect) =>
            rect.left < rootRect.left - 1 ||
            rect.right > rootRect.right + 1 ||
            rect.width < 48,
        ),
      };
    });

    expect(layout.gridWidth).toBeGreaterThan(0);
    expect(layout.inputOverflow).toBe(false);
  });
});

test("Linear settings start sanitized and keep queue authority gated", async () => {
  await withE2EHarness("linear-settings-safety", async ({ page }) => {
    const startup = await page.evaluate(({ pluginId }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const grant = plugin?.getLinearQueueGrantStatus?.();
      const github = plugin?.getGitHubCredentialStatus?.();
      return {
        enabled: plugin?.settings?.linearEnabled ?? null,
        capabilityGate: plugin?.settings?.linearCapabilityGate ?? null,
        queueEnabled: plugin?.settings?.linearQueueEnabled ?? null,
        hasApiKey: plugin?.hasLinearApiKey?.() ?? null,
        grantActive: grant?.active ?? null,
        github: {
          enabled: plugin?.settings?.githubEnabled ?? null,
          oauthClientId: plugin?.settings?.githubOAuthClientId ?? null,
          connected: github?.connected ?? null,
          waitingForUser: github?.waitingForUser ?? null,
        },
      };
    }, { pluginId: PLUGIN_ID });
    expect(startup).toEqual({
      enabled: false,
      capabilityGate: 0,
      queueEnabled: false,
      hasApiKey: false,
      grantActive: false,
      github: {
        enabled: false,
        oauthClientId: "",
        connected: false,
        waitingForUser: false,
      },
    });

    await openPluginSettings(page);
    const settings = page.locator(".agentic-researcher-settings");
    await expect(settings).toContainText(
      "Vault work requires Obsidian; an installed, healthy Companion may continue only already-authorized non-vault operations.",
    );
    await settings
      .locator("details.agentic-settings-advanced-section", {
        hasText: "Browser and integrations",
      })
      .evaluate((el) => {
        (el as HTMLDetailsElement).open = true;
      });
    await expect(
      settings.getByRole("heading", { name: "Linear integration" }),
    ).toBeVisible();
    await expect(settings).toContainText("fixed Linear GraphQL operations");
    await expect(settings).toContainText(
      "New keys use the authenticated companion's persistent OS credential store",
    );
    await expect(settings).toContainText(
      "legacy plaintext remains foreground-only until you explicitly migrate it",
    );
    await expect(settings).toContainText("Linear OAuth client ID");
    await expect(settings).toContainText("Linear OAuth callback port");
    await expect(settings).toContainText(
      "http://127.0.0.1:43119/oauth/linear/callback",
    );
    await expect(settings).toContainText("Linear OAuth actor");
    const oauthSetting = settings.locator(".setting-item", {
      hasText: "Linear OAuth connection",
    });
    await expect(oauthSetting).toContainText("Linear OAuth is not connected.");
    await expect(
      oauthSetting.getByRole("button", { name: "Connect OAuth" }),
    ).toBeDisabled();
    await expect(settings).toContainText("Connection capability report");
    await expect(settings).toContainText("No verified discovery snapshot");

    await expect(
      settings.getByRole("heading", { name: "GitHub integration" }),
    ).toBeVisible();
    await expect(settings).toContainText("fixed-catalog GitHub access");
    await expect(settings).toContainText("verified through /user");
    const githubEnableSetting = settings.locator(".setting-item", {
      hasText: "Enable GitHub",
    });
    await expect(githubEnableSetting.locator(".checkbox-container")).not.toHaveClass(
      /is-enabled/,
    );
    const githubOAuthSetting = settings.locator(".setting-item", {
      hasText: "GitHub OAuth client ID",
    });
    await expect(githubOAuthSetting.locator('input[type="text"]')).toHaveValue("");
    const githubConnection = settings.locator(".setting-item", {
      hasText: "GitHub connection",
    });
    await expect(githubConnection).toContainText("GitHub is not connected.");
    await expect(
      githubConnection.getByRole("button", { name: "Connect OAuth" }),
    ).toBeDisabled();
    const githubPatSetting = settings.locator(".setting-item", {
      hasText: "GitHub fine-grained personal access token",
    });
    await expect(githubPatSetting.locator('input[type="password"]')).toHaveValue("");
    await expect(
      githubPatSetting.getByRole("button", { name: "Verify and save" }),
    ).toBeDisabled();

    const enableSetting = settings.locator(".setting-item", {
      hasText: "Enable Linear",
    });
    const enableToggle = enableSetting.locator(".checkbox-container");
    await expect(enableToggle).not.toHaveClass(/is-enabled/);

    const keySetting = settings.locator(".setting-item", {
      hasText: "Linear personal API key",
    });
    const keyInput = keySetting.locator('input[type="password"]');
    await expect(keyInput).toHaveValue("");
    await expect(
      keySetting.getByRole("button", { name: "Save key" }),
    ).toBeEnabled();
    await expect(
      keySetting.getByRole("button", { name: "Test connection" }),
    ).toBeDisabled();

    const queueSetting = settings.locator(".setting-item", {
      hasText: "Automatic Linear queue",
    });
    await expect(queueSetting).toContainText(
      "Unavailable: Test the Linear connection to discover this workspace.",
    );
    const queueToggle = queueSetting.locator(".checkbox-container");
    await expect(queueToggle).toHaveClass(/is-disabled/);
    await expect(queueToggle).not.toHaveClass(/is-enabled/);

    const authoritySetting = settings.locator(".setting-item", {
      hasText: "Queue authority",
    });
    await expect(authoritySetting).toContainText("No live queue authority");
    await expect(authoritySetting).toContainText(
      "Ready tickets cannot execute until you explicitly authorize a four-hour bounded grant.",
    );
    await expect(
      authoritySetting.getByRole("button", { name: "Authorize 4 hours" }),
    ).toBeDisabled();
    await expect(
      authoritySetting.getByRole("button", { name: "Revoke" }),
    ).toBeDisabled();

    await enableToggle.click();
    await expect(enableToggle).toHaveClass(/is-enabled/);
    await expect(queueToggle).toHaveClass(/is-disabled/);
    await expect(
      authoritySetting.getByRole("button", { name: "Authorize 4 hours" }),
    ).toBeDisabled();

    const afterEnable = await page.evaluate(({ pluginId }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      return {
        queueEnabled: plugin?.settings?.linearQueueEnabled ?? null,
        grantActive: plugin?.getLinearQueueGrantStatus?.()?.active ?? null,
      };
    }, { pluginId: PLUGIN_ID });
    expect(afterEnable).toEqual({ queueEnabled: false, grantActive: false });
  });
});

test("production bundle resolves desktop Node builtins through require", async () => {
  const bundle = await readFile(path.join(process.cwd(), "main.js"), "utf8");

  for (const specifier of ["child_process", "fs/promises", "os", "path"]) {
    expect(bundle).not.toContain(`import("${specifier}")`);
    expect(bundle).not.toContain(`import('${specifier}')`);
  }
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
    await expectDetailsText(page, "Timing: append_to_current_file");
    await expectLatestMissionLedger(page, [
      "\"operation\": \"append\"",
      "\"state\": \"committed\"",
      "receipt-proof:write_receipt",
    ]);
  });
});

test("title rename updates file explorer, active tab, and vault path", async () => {
  await withE2EHarness("title-rename-regression", async ({ page }) => {
    await setStreamingMode(page, false);
    await setPluginSettingOverrides(page, { autoTitleOnWrite: false });
    const untitledPath = "Untitled.md";
    const renamedPath = "History Snapshot.md";
    const untitledFilePath = path.join(vaultRoot, untitledPath);
    const renamedFilePath = path.join(vaultRoot, renamedPath);

    await page.evaluate(async ({ untitledPath, renamedPath }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const app = obsidianWindow.app;
      const renamed = app.vault.getAbstractFileByPath(renamedPath);
      if (renamed) {
        await app.vault.trash(renamed, false);
      }
      let file = app.vault.getAbstractFileByPath(untitledPath);
      if (file) {
        await app.vault.modify(file, "");
      } else {
        file = await app.vault.create(untitledPath, "");
      }
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }, { untitledPath, renamedPath });

    await expect(
      page.locator(".nav-file-title-content", { hasText: "Untitled" }).first(),
    ).toBeVisible({ timeout: 10_000 });

    await submitMission(
      page,
      "E2E_TITLE_RENAME_HISTORY_WRITE Write exactly 50 words about a historical topic to this page.",
      { timeout: 120_000 },
    );

    await expectFileToContain(
      untitledFilePath,
      "printing press changed history",
      "history write should land in Untitled.md before rename",
      20_000,
    );
    const written = await readFile(untitledFilePath, "utf8");
    expect(countPlainWords(written)).toBe(50);

    await submitMission(
      page,
      "E2E_TITLE_RENAME_HISTORY_TITLE Change the page title to History Snapshot.",
      { timeout: 120_000 },
    );

    await expectFileToContain(
      renamedFilePath,
      "printing press changed history",
      "renamed vault file should preserve history text",
      20_000,
    );
    await expect.poll(async () => readOptionalFile(untitledFilePath), {
      message: "Untitled.md should be gone after visible title rename",
      timeout: 20_000,
    }).toBeNull();

    await expect(
      page.locator(".nav-file-title-content", { hasText: "History Snapshot" }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator(".workspace-tab-header.is-active .workspace-tab-header-inner-title, .workspace-leaf.mod-active .view-header-title", {
        hasText: "History Snapshot",
      }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expectReceipt(page, "rename_current_file");
    await expectToolRun(page, "rename_current_file");
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: '"tool":"rename_current_file"',
      }),
    ).toHaveCount(0);
  });
});

test("generated titled text replaces visible Untitled page title", async () => {
  await withE2EHarness("title-replacement-50", async ({ page }) => {
    await setStreamingMode(page, false);
    const untitledPath = "Untitled.md";
    const renamedPath = "Purple Horizon.md";
    const untitledFilePath = path.join(vaultRoot, untitledPath);
    const renamedFilePath = path.join(vaultRoot, renamedPath);

    await page.evaluate(async ({ untitledPath, renamedPath }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const app = obsidianWindow.app;
      const renamed = app.vault.getAbstractFileByPath(renamedPath);
      if (renamed) {
        await app.vault.trash(renamed, false);
      }
      let file = app.vault.getAbstractFileByPath(untitledPath);
      if (file) {
        await app.vault.modify(file, "");
      } else {
        file = await app.vault.create(untitledPath, "");
      }
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }, { untitledPath, renamedPath });

    await submitMission(
      page,
      "E2E_TITLE_REPLACEMENT_50 Create a 50 word piece of text with the title Purple Horizon on this page.",
      { timeout: 120_000 },
    );

    await expectFileToContain(
      renamedFilePath,
      "Purple horizons glow",
      "renamed title replacement file should contain generated body",
      20_000,
    );
    await expectFileToBeAbsent(
      untitledFilePath,
      "Untitled.md should be gone after generated visible title replacement",
      20_000,
    );
    const written = (await readOptionalFile(renamedFilePath)) ?? "";
    expect(countPlainWords(written.replace(/^#\s+[^\n]+\n*/, ""))).toBe(50);
    expect(written).toMatch(/^#\s*Purple Horizon\b/m);
    expect(written).not.toMatch(/^#\s*Untitled\b/m);

    await expect(
      page.locator(".nav-file-title-content", { hasText: "Purple Horizon" }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator(".workspace-tab-header.is-active .workspace-tab-header-inner-title, .workspace-leaf.mod-active .view-header-title", {
        hasText: "Purple Horizon",
      }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expectToolRun(page, "append_to_current_file");
    await expectReceipt(page, "append");
    await expectReceipt(page, "rename_current_file");
  });
});

test("streaming writeback auto-renames Untitled 1 from leading H1", async () => {
  await withE2EHarness("stream-placeholder-title", async ({ page }) => {
    await setStreamingMode(page, true);
    const untitledPath = "Untitled 1.md";
    const renamedPath = "Hello World in TypeScript.md";
    const untitledFilePath = path.join(vaultRoot, untitledPath);
    const renamedFilePath = path.join(vaultRoot, renamedPath);

    await page.evaluate(async ({ untitledPath, renamedPath }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const app = obsidianWindow.app;
      const renamed = app.vault.getAbstractFileByPath(renamedPath);
      if (renamed) {
        await app.vault.trash(renamed, false);
      }
      let file = app.vault.getAbstractFileByPath(untitledPath);
      if (file) {
        await app.vault.modify(file, "");
      } else {
        file = await app.vault.create(untitledPath, "");
      }
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }, { untitledPath, renamedPath });

    await submitMission(
      page,
      "E2E_STREAM_PLACEHOLDER_TITLE Write Hello World in TypeScript on this page.",
      { timeout: 120_000 },
    );

    await expectFileToContain(
      renamedFilePath,
      "Hello, world!",
      "streamed placeholder rename file should contain body",
      20_000,
    );
    await expectFileToBeAbsent(
      untitledFilePath,
      "Untitled 1.md should be gone after streamed placeholder auto-rename",
      20_000,
    );
    await expect(
      page.locator(".nav-file-title-content", { hasText: "Hello World in TypeScript" }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator(".workspace-tab-header.is-active .workspace-tab-header-inner-title, .workspace-leaf.mod-active .view-header-title", {
        hasText: "Hello World in TypeScript",
      }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expectReceipt(page, "append");
    await expectReceipt(page, "rename_current_file");
  });
});

test("agent highlights a requested phrase in the current note", async () => {
  await withE2EHarness("phrase-highlight", async ({ page, notePath, noteFilePath }) => {
    await setStreamingMode(page, false);
    const original = "# Highlight Fixture\n\nThe silver lantern stayed on the desk.\n";
    await setActiveNoteContent(page, notePath, original);

    await submitMission(
      page,
      "E2E_HIGHLIGHT_PHRASE Find and highlight silver lantern in the current note.",
      { timeout: 120_000 },
    );

    await expectFileToContain(
      noteFilePath,
      "==silver lantern==",
      "highlight mission should wrap the requested phrase",
      20_000,
    );
    await expectFileNotToContain(
      noteFilePath,
      "====silver lantern====",
      "highlight mission should not double-wrap the phrase",
      20_000,
    );
    await expectBackupToContain(
      page,
      original,
      "highlight mission should save the original note in backups",
      20_000,
    );
    await expectToolRun(page, "highlight_current_file_phrase");
    await expectReceipt(page, "highlight");
    await expectReceipt(page, "matches: 1");
  });
});

test("agent restores the current note from the latest backup", async () => {
  await withE2EHarness("restore-current-backup", async ({ page, notePath, noteFilePath }) => {
    await setStreamingMode(page, false);
    const broken = "# Restore Fixture\n\nBroken draft should be undone.\n";
    const restored =
      "# Restore Fixture\n\nRestored source from the latest backup.\n";
    const backupBasename =
      path.basename(notePath, ".md").trim().replace(/[^a-zA-Z0-9._-]+/g, "-") ||
      "untitled";
    const backupPath = `.agent-backups/9999999999999-${backupBasename}.md`;

    await setActiveNoteContent(page, notePath, broken);
    await page.evaluate(
      async ({ backupPath: targetPath, restored: restoredContent }) => {
        const obsidianWindow = window as typeof window & { app?: any };
        const app = obsidianWindow.app;
        if (!app?.vault) {
          throw new Error("Obsidian vault is unavailable.");
        }

        const folder = ".agent-backups";
        if (!app.vault.getAbstractFileByPath(folder)) {
          try {
            await app.vault.createFolder(folder);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/already exists/i.test(message)) {
              throw error;
            }
          }
        }

        const existing = app.vault.getAbstractFileByPath(targetPath);
        if (existing) {
          await app.vault.modify(existing, restoredContent);
        } else {
          await app.vault.create(targetPath, restoredContent);
        }
      },
      { backupPath, restored },
    );

    await submitMission(
      page,
      "E2E_RESTORE_BACKUP Undo the last agent edit in the current note from backup.",
      { timeout: 120_000 },
    );

    await expect
      .poll(async () => (await readOptionalFile(noteFilePath)) ?? "", {
        message: "restore mission should replace the active note with backup content",
        timeout: 20_000,
      })
      .toBe(restored);
    await expectBackupToContain(
      page,
      broken,
      "restore mission should back up the pre-restore note",
      20_000,
    );
    await expectToolRun(page, "restore_current_file_from_backup");
    await expectReceipt(page, "restore");
    await expectReceipt(page, backupPath);
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

test("default note writeback streams plain answers to the active note", async () => {
  await withE2EHarness("default-note-writeback", async ({ page, noteFilePath, input }) => {
    const prompt = `What is 2+2? Include ${input.streamChunkOne} and ${input.streamChunkTwo} in the answer.`;
    await setStreamingMode(page, true);
    await submitMission(page, prompt, { waitForCompletion: false });

    await expectNoteToContain(
      noteFilePath,
      input.streamChunkOne,
      "default answer stream should append the first chunk to the active note",
      10_000,
    );

    await waitForMissionComplete(page, 45_000);
    await assertMockModelUsed(page);
    await expectNoteToContain(
      noteFilePath,
      input.streamChunkTwo,
      "default answer stream should finish in the active note",
      10_000,
    );
    await expectReceipt(page, "append");
    await expectDetailsText(page, "note_writeback=streaming_current_note");
    await expectDetailsText(page, "chat_only_override=off");
  });
});

test("chat-only toggle keeps streamed answers in chat and resets", async () => {
  await withE2EHarness("chat-only-toggle", async ({ page, noteFilePath, input }) => {
    const prompt = `What is 2+2? Include ${input.streamChunkOne} and ${input.streamChunkTwo} in the answer.`;
    await setStreamingMode(page, true);

    const chatOnlyInput = page.locator(".agentic-researcher-chat-only-input");
    await expect(chatOnlyInput).toBeVisible();
    await chatOnlyInput.check();
    await expect(chatOnlyInput).toBeChecked();

    await submitMission(page, prompt);

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: input.streamChunkOne,
      }),
    ).toBeVisible();
    await expectFileNotToContain(
      noteFilePath,
      input.streamChunkOne,
      "chat-only toggle should not write the first stream chunk to the note",
      5_000,
    );
    await expectFileNotToContain(
      noteFilePath,
      input.streamChunkTwo,
      "chat-only toggle should not write the final stream chunk to the note",
      5_000,
    );
    await expect(chatOnlyInput).not.toBeChecked();
    await expect(chatOnlyInput).toBeEnabled();
    await expectNoReceipts(page);
    await expectDetailsText(page, "note_writeback=off");
    await expectDetailsText(page, "chat_only_override=on");
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
    await expectDetailsText(page, "route_reasons=prefetchable_vault_folder_answer");
    await expectDetailsText(page, "allowed_tools=none");
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

test("agentic reflex routes ambiguous semantic prompt", async () => {
  await withE2EHarness("agentic-reflex-semantic", async ({ page, input }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, true);
    await submitMission(
      page,
      `Surface E2E_SEMANTIC_SEARCH ${input.folderAnswerMarker} implications.`,
    );

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: input.folderAnswerMarker,
      }),
    ).toBeVisible();
    await expectToolRun(page, "semantic_search_notes");
    await expectDetailsText(page, "reflex_intent=semantic_vault_search");
    await expectNoReceipts(page);
  });
});

test("deep vault research expands sampled semantic retrieval before synthesis", async () => {
  test.setTimeout(180_000);
  await withE2EHarness("deep-vault-research", async ({ page }) => {
    await setStreamingMode(page, false);
    await page.evaluate(async () => {
      const obsidianWindow = window as typeof window & { app?: any };
      const app = obsidianWindow.app;
      const folder = "E2E Agent Tests/Scaled Vault";
      if (!app.vault.getAbstractFileByPath(folder)) {
        await app.vault.createFolder(folder);
      }
      for (let index = 1; index <= 100; index += 1) {
        const path = `${folder}/scaled-${String(index).padStart(3, "0")}.md`;
        const marker =
          index === 42 ? "E2E_DEEP_VAULT_TARGET" : "E2E_DEEP_VAULT_SUPPORT";
        const content = `# Scaled Vault Evidence\n\n${marker} discusses local retrieval, evidence coverage, and semantic expansion.\n`;
        const file = app.vault.getAbstractFileByPath(path);
        if (file) {
          await app.vault.modify(file, content);
        } else {
          await app.vault.create(path, content);
        }
      }
    });

    await submitMission(
      page,
      "E2E_DEEP_VAULT_RESEARCH Do deep research across my notes about local retrieval coverage and synthesize the relevant evidence.",
      { timeout: 180_000 },
    );

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_DEEP_VAULT_DONE",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectToolRun(page, "semantic_search_notes");
    await expectToolRun(page, "read_markdown_files");
    await expectDetailsText(page, "coverage was sampled");
    await expectDetailsText(page, "candidateLimit");
    await expectLatestMissionLedger(page, [
      "\"researchPlan\"",
      "\"mode\": \"deep_vault\"",
      "E2E_DEEP_VAULT_TARGET",
    ]);
  });
});

test("web research persists fetched passage evidence and refuses terminal replay", async () => {
  await withE2EHarness("web-ledger-terminal-replay", async ({ page, noteFilePath }) => {
    await setStreamingMode(page, false);
    await page.evaluate(({ pluginId }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eWebLedgerToolStarts?: {
          webSearch: number;
          webFetch: number;
          noteWrite: number;
          total: number;
        };
      };
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      if (!plugin?.subscribeMissionEvents) {
        throw new Error("Mission event subscription API was unavailable.");
      }
      obsidianWindow.__e2eWebLedgerToolStarts = {
        webSearch: 0,
        webFetch: 0,
        noteWrite: 0,
        total: 0,
      };
      plugin.subscribeMissionEvents({
        onToolStart: (event: { name?: string }) => {
          const counts = obsidianWindow.__e2eWebLedgerToolStarts!;
          counts.total += 1;
          if (event.name === "web_search") {
            counts.webSearch += 1;
          } else if (event.name === "web_fetch") {
            counts.webFetch += 1;
          }
          if (
            [
              "append_to_current_file",
              "replace_current_file",
              "edit_current_section",
            ].includes(event.name ?? "")
          ) {
            counts.noteWrite += 1;
          }
        },
      });
    }, { pluginId: PLUGIN_ID });

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
      "E2E_WEB_LEDGER_SOURCE fetched source content for mission evidence tracking.",
      "\"passageIds\"",
      ":passage:",
    ]);
    const beforeReplay = await page.evaluate(() => {
      const mockWindow = window as typeof window & {
        __e2eWebLedgerToolStarts?: {
          webSearch: number;
          webFetch: number;
          noteWrite: number;
          total: number;
        };
      };
      return mockWindow.__e2eWebLedgerToolStarts ?? {
        webSearch: 0,
        webFetch: 0,
        noteWrite: 0,
        total: 0,
      };
    });
    expect(beforeReplay).toMatchObject({
      webSearch: 1,
      webFetch: 1,
      noteWrite: 0,
    });
    const noteBeforeReplay = await readFile(noteFilePath, "utf8");

    await submitMission(page, `continue run ${ledger.runId}`, {
      timeout: 120_000,
    });
    await page.getByRole("tab", { name: "Chat" }).click();
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: `Run ${ledger.runId} is already complete and accepted`,
      }),
    ).toBeVisible({ timeout: 30_000 });
    const afterReplay = await page.evaluate(() => {
      const mockWindow = window as typeof window & {
        __e2eWebLedgerToolStarts?: {
          webSearch: number;
          webFetch: number;
          noteWrite: number;
          total: number;
        };
      };
      return mockWindow.__e2eWebLedgerToolStarts ?? {
        webSearch: 0,
        webFetch: 0,
        noteWrite: 0,
        total: 0,
      };
    });
    expect(afterReplay).toEqual(beforeReplay);
    await expect
      .poll(() => readFile(noteFilePath, "utf8"), {
        message: "terminal replay refusal must not duplicate note writeback",
      })
      .toBe(noteBeforeReplay);
    await expectConversationHistoryMissing(page, "Structured Agent Runs mission ledger");
  });
});

test("source-backed mission auto-fetches searched source and shows run gates", async () => {
  await withE2EHarness("auto-followup-source", async ({ page }) => {
    await setStreamingMode(page, false);

    await submitMission(
      page,
      "E2E_AUTO_FOLLOWUP_SOURCE Use web sources and citations. Give a concise sourced answer.",
      { timeout: 120_000 },
    );

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_AUTO_FOLLOWUP_DONE",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectToolRun(page, "web_search");
    await expectToolRun(page, "web_fetch");
    await expectDetailsText(page, "budget_profile=route_specific_budget");
    await expectDetailsText(page, "budget_tools=");
    await expectDetailsText(page, "dependency_provider_auth=");

    await expectLatestMissionLedger(page, [
      "E2E Auto Followup Source",
      "https://example.com/e2e-auto-followup-source",
      "\"kind\": \"web_source\"",
    ]);
  });
});

test("invalid model dependency blocks before model loop", async () => {
  await withE2EHarness("dependency-preflight-block", async ({ page }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);
    await setPluginSettingOverrides(page, {
      requestTimeoutMs: 0,
    });

    await submitMission(
      page,
      "E2E_DEPENDENCY_PREFLIGHT_BLOCK Search the web for a sourced answer.",
      { timeout: 60_000, assertMock: false },
    );

    await expectDetailsText(page, "Dependency preflight: blocked");
    await expectDetailsText(page, "dependency_model_timeout=blocked");
    await expectDetailsText(page, "Blocked before model loop");
  });
});

test("deep web research fetches three sources and records research plan", async () => {
  await withE2EHarness(
    "deep-web-research",
    async ({ page }) => {
      await setStreamingMode(page, false);

      await submitMission(
        page,
        "E2E_DEEP_WEB_RESEARCH Do deep research with multiple current web sources about a test topic. Include source URLs, citations, limitations, and confidence.",
        { timeout: 180_000 },
      );

      await expect(
        page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
          hasText: "E2E_DEEP_WEB_DONE",
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expectToolRun(page, "web_search");
      await expectToolRun(page, "web_fetch");
      await expectDetailsText(page, "https://alpha.example.com/deep-source");
      await expectDetailsText(page, "https://beta.example.org/deep-source");
      await expectDetailsText(page, "https://gamma.example.net/deep-source");
      await expectVerification(page, "claim_grounding");
      await expect(
        page.locator(".agentic-researcher-claim-grounding-row", {
          hasText: /claims=\d+/,
        }).first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.locator(".agentic-researcher-claim-grounding-row", {
          hasText: /grounded=\d+/,
        }).first(),
      ).toBeVisible();
      await expect(
        page.locator(".agentic-researcher-claim-grounding-row", {
          hasText: /ungrounded=\d+/,
        }).first(),
      ).toBeVisible();

      await expectLatestMissionLedger(page, [
        "\"researchPlan\"",
        "\"mode\": \"deep_web\"",
        "https://alpha.example.com/deep-source",
        "https://beta.example.org/deep-source",
        "https://gamma.example.net/deep-source",
        "\"kind\": \"web_source\"",
        "\"passageIds\"",
        "\"claimLedger\"",
      ]);
    },
    { aiMode: "mock" },
  );
});

test("quote verify mission requires quote span inside cited passage", async () => {
  await withE2EHarness(
    "quote-verify-passage",
    async ({ page }) => {
      await setStreamingMode(page, false);

      await submitMission(
        page,
        "E2E_QUOTE_VERIFY_MISSION Verify with text-level quotation from the web source. Quote the exact phrase and cite the passage id.",
        { timeout: 180_000 },
      );

      await expect(
        page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
          hasText: "E2E_QUOTE_VERIFY_DONE",
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expectToolRun(page, "web_search");
      await expectToolRun(page, "web_fetch");
      await expectVerification(page, "claim_grounding");
      await expect(
        page.locator(".agentic-researcher-claim-grounding-row", {
          hasText: /status=pass/,
        }).first(),
      ).toBeVisible({ timeout: 15_000 });
      await expectLatestMissionLedger(page, [
        "\"claimLedger\"",
        "\"quoteSpans\"",
        "e2e-quote-verify-source",
      ]);
    },
    { aiMode: "mock" },
  );
});

test("resume incomplete deep research ledger executes next plan item", async () => {
  await withE2EHarness("resume-incomplete-research", async ({ page }) => {
    await setStreamingMode(page, false);
    const runId = `run-e2e-incomplete-${Date.now()}`;
    await page.evaluate(async ({ runId }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const app = obsidianWindow.app;
      const folder = "Agent Runs";
      if (!app.vault.getAbstractFileByPath(folder)) {
        await app.vault.createFolder(folder);
      }
      const now = new Date().toISOString();
      const ledger = {
        runId,
        mission: "E2E incomplete deep research mission",
        route: "grounded_workflow",
        createdAt: now,
        updatedAt: now,
        status: "running",
        loopBudget: {
          hardCap: 30,
          toolStepBudget: 24,
          finalizationReserve: 3,
          expectedTools: ["web_search", "web_fetch"],
        },
        researchPlan: {
          version: 1,
          mode: "deep_web",
          sourceRequirements: { minFetchedSources: 3, minDistinctDomains: 2 },
          coverageRequirements: {
            minVaultCoverageConfidence: "medium",
            expandWhenSampledOrTruncated: true,
          },
          subquestions: [
            {
              id: "rq-1",
              question: "Find current external evidence for the resume e2e topic.",
              requiredEvidenceType: "web_source",
              minEvidence: 3,
              status: "in_progress",
              evidenceIds: [],
            },
          ],
          evidenceIds: [],
          status: "in_progress",
          nextAction: {
            toolName: "web_search",
            reason: "Gather fetched web evidence for rq-1.",
            subquestionId: "rq-1",
            query: "resume e2e topic",
          },
        },
        tasks: [
          {
            id: "rq-1",
            title: "Find current external evidence for the resume e2e topic.",
            status: "in_progress",
            toolNames: [],
            evidenceIds: [],
            notes: "",
          },
        ],
        milestones: [],
        evidence: [],
        receipts: [],
        blockers: [],
        nextActions: ["Gather fetched web evidence for rq-1."],
        remainingActions: ["Gather fetched web evidence for rq-1."],
        resumeCount: 0,
        lastSafeStep: 0,
      };
      const content = `# Agent Run ${runId}\n\n## Mission Ledger\n\`\`\`json\n${JSON.stringify(ledger, null, 2)}\n\`\`\`\n`;
      const path = `${folder}/${runId}.md`;
      const file = app.vault.getAbstractFileByPath(path);
      if (file) {
        await app.vault.modify(file, content);
      } else {
        await app.vault.create(path, content);
      }
    }, { runId });

    await submitMission(page, `continue run ${runId}`, { timeout: 120_000 });
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: `E2E_RESUME_RESEARCH_DONE_${runId}`,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectToolRun(page, "web_search");
    await expectDetailsText(page, "Loaded continuation memory bundle.");
    await expectDetailsText(page, "Resume first incomplete research item: rq-1");
  });
});

test("resume banner hides when a new mission starts", async () => {
  await withE2EHarness("resume-banner-hide", async ({ page, input, noteFilePath }) => {
    const runId = `run-e2e-resume-banner-${Date.now()}`;
    await page.evaluate(async ({ runId }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const app = obsidianWindow.app;
      const folder = "Agent Runs";
      if (!app.vault.getAbstractFileByPath(folder)) {
        await app.vault.createFolder(folder);
      }
      const now = new Date().toISOString();
      const ledger = {
        runId,
        mission: "E2E resume banner stale mission",
        route: "grounded_workflow",
        createdAt: now,
        updatedAt: now,
        status: "running",
        loopBudget: {
          hardCap: 30,
          toolStepBudget: 20,
          finalizationReserve: 4,
          expectedTools: ["web_search"],
        },
        milestones: [],
        evidence: [],
        receipts: [],
        blockers: [],
        nextActions: ["Continue stale banner mission."],
        remainingActions: ["Continue stale banner mission."],
        resumeCount: 0,
        lastSafeStep: 0,
      };
      const content = `# Agent Run ${runId}\n\n## Mission Ledger\n\`\`\`json\n${JSON.stringify(ledger, null, 2)}\n\`\`\`\n`;
      const path = `${folder}/${runId}.md`;
      const file = app.vault.getAbstractFileByPath(path);
      if (file) {
        await app.vault.modify(file, content);
      } else {
        await app.vault.create(path, content);
      }
      const view = app.workspace.getLeavesOfType("agentic-researcher-view")[0]?.view;
      await view?.renderStartupResumeBanner?.();
    }, { runId });

    const banner = page.locator(".agentic-researcher-resume-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText("E2E resume banner stale mission");

    await submitMission(page, `Append ${input.secondMarker} to the current note.`, {
      timeout: 120_000,
    });

    await expectNoteToContain(
      noteFilePath,
      input.secondMarker,
      "new mission should still complete after hiding stale resume banner",
    );
    await expect(banner).toBeHidden();
    await expect(banner).not.toContainText("E2E resume banner stale mission");
  });
});

test("narrow right pane contains tabs resume banner and mission controls", async () => {
  await withE2EHarness("narrow-pane-resume-containment", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const runId = `run-e2e-narrow-pane-${Date.now()}`;
    const ledgerPath = `Agent Runs/${runId}.md`;
    const mission =
      "Walk me through how diagonalization works in Linear Algebra with grounded examples, " +
      "then compare the result with a second carefully sourced example and preserve every citation.";

    try {
      const initialGeometry = await page.evaluate(async ({ runId, mission }) => {
        const obsidianWindow = window as typeof window & { app?: any };
        const app = obsidianWindow.app;
        const folder = "Agent Runs";
        if (!app?.vault?.getAbstractFileByPath?.(folder)) {
          await app.vault.createFolder(folder);
        }

        const now = new Date().toISOString();
        const ledger = {
          runId,
          mission,
          route: "grounded_workflow",
          createdAt: now,
          updatedAt: now,
          status: "running",
          loopBudget: {
            hardCap: 30,
            toolStepBudget: 20,
            finalizationReserve: 4,
            expectedTools: ["web_search", "web_fetch"],
          },
          milestones: [],
          evidence: [],
          receipts: [],
          blockers: [],
          nextActions: ["Gather and compare grounded examples."],
          remainingActions: ["Gather and compare grounded examples."],
          resumeCount: 0,
          lastSafeStep: 0,
        };
        const ledgerPath = `${folder}/${runId}.md`;
        const content = `# Agent Run ${runId}\n\n## Mission Ledger\n\`\`\`json\n${JSON.stringify(ledger, null, 2)}\n\`\`\`\n`;
        const existing = app.vault.getAbstractFileByPath(ledgerPath);
        if (existing) {
          await app.vault.modify(existing, content);
        } else {
          await app.vault.create(ledgerPath, content);
        }

        const view = app.workspace.getLeavesOfType("agentic-researcher-view")[0]?.view;
        if (!view?.renderStartupResumeBanner) {
          throw new Error("Agent view resume banner API was unavailable.");
        }
        await view.renderStartupResumeBanner();

        const root = document.querySelector<HTMLElement>(".agentic-researcher-view");
        const rightSplit = root?.closest<HTMLElement>(".workspace-split.mod-right-split");
        if (!root || !rightSplit) {
          throw new Error("Agent view was not mounted in the Obsidian right split.");
        }
        rightSplit.style.setProperty("flex", "0 0 320px", "important");
        rightSplit.style.setProperty("width", "320px", "important");
        rightSplit.style.setProperty("min-width", "320px", "important");
        rightSplit.style.setProperty("max-width", "320px", "important");

        return {
          desktopWidth: window.innerWidth,
          paneWidth: rightSplit.getBoundingClientRect().width,
          rootWidth: root.getBoundingClientRect().width,
        };
      }, { runId, mission });

      expect(initialGeometry.desktopWidth).toBeGreaterThanOrEqual(1_400);
      expect(initialGeometry.paneWidth).toBeGreaterThanOrEqual(319);
      expect(initialGeometry.paneWidth).toBeLessThanOrEqual(321);
      expect(initialGeometry.rootWidth).toBeLessThanOrEqual(321);

      const chatTab = page.getByRole("tab", { name: "Chat" });
      const detailsTab = page.getByRole("tab", { name: "Run Details" });
      const banner = page.locator(".agentic-researcher-resume-banner");
      const continueButton = banner.getByRole("button", { name: "Continue" });
      const dismissButton = banner.getByRole("button", { name: "Dismiss" });
      const prompt = page.locator("textarea.agentic-researcher-prompt");
      const runButton = page.locator("button.agentic-researcher-run");
      const chatOnlyToggle = page.locator(".agentic-researcher-chat-only-toggle");
      const clearButton = page.locator("button.agentic-researcher-clear");

      await expect(chatTab).toBeVisible();
      await expect(detailsTab).toBeVisible();
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(mission);
      await expect(continueButton).toBeVisible();
      await expect(dismissButton).toBeVisible();
      await expect(prompt).toBeVisible();
      await expect(runButton).toBeVisible();
      await expect(chatOnlyToggle).toBeVisible();
      await expect(clearButton).toBeVisible();

      const geometry = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>(".agentic-researcher-view");
        if (!root) {
          throw new Error("Agent view disappeared before geometry assertions.");
        }
        const rootRect = root.getBoundingClientRect();
        const isVisible = (element: Element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const visibleDescendants = Array.from(root.querySelectorAll("*"))
          .filter(isVisible);
        const boundaryOffenders = visibleDescendants
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1;
          })
          .map((element) => ({
            className: element.className?.toString?.() ?? "",
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
          }));
        const selectors = [
          ".agentic-researcher-tab:first-child",
          ".agentic-researcher-tab:last-child",
          ".agentic-researcher-resume-banner",
          ".agentic-researcher-resume-banner-controls",
          ".agentic-researcher-prompt",
          ".agentic-researcher-run",
          ".agentic-researcher-chat-only-toggle",
          ".agentic-researcher-clear",
        ];
        const keyBoxes = selectors.map((selector) => {
          const element = root.querySelector<HTMLElement>(selector);
          if (!element) {
            throw new Error(`Missing narrow-pane element: ${selector}`);
          }
          const rect = element.getBoundingClientRect();
          return { selector, left: rect.left, right: rect.right, width: rect.width };
        });
        return {
          rootLeft: rootRect.left,
          rootRight: rootRect.right,
          clientWidth: root.clientWidth,
          scrollWidth: root.scrollWidth,
          boundaryOffenders,
          keyBoxes,
        };
      });

      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
      expect(geometry.boundaryOffenders).toEqual([]);
      for (const box of geometry.keyBoxes) {
        expect(box.width, `${box.selector} should retain visible width`).toBeGreaterThan(0);
        expect(box.left, `${box.selector} should stay inside the pane's left edge`).toBeGreaterThanOrEqual(
          geometry.rootLeft - 1,
        );
        expect(box.right, `${box.selector} should stay inside the pane's right edge`).toBeLessThanOrEqual(
          geometry.rootRight + 1,
        );
      }
    } finally {
      await page.evaluate(async ({ ledgerPath }) => {
        const obsidianWindow = window as typeof window & { app?: any };
        const app = obsidianWindow.app;
        const file = app?.vault?.getAbstractFileByPath?.(ledgerPath);
        if (file) {
          await app.vault.delete(file);
        }
      }, { ledgerPath }).catch(() => undefined);
    }
  });
});

test("Orchestrator tab replays task and worktree state at 320px", async () => {
  await withE2EHarness("orchestrator-tab-replay", async ({ page }) => {
    await expect(page.getByRole("tab", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Run Details" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Orchestrator" })).toBeVisible();

    const unsentPrompt = "Unsent prompt must survive Orchestrator settings changes";
    const promptInput = page.locator("textarea.agentic-researcher-prompt");
    await promptInput.fill(unsentPrompt);

    await page.evaluate(({ pluginId }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      const now = new Date().toISOString();
      const budget = {
        modelSteps: { used: 3, limit: 20 },
        toolCalls: { used: 4, limit: 24 },
        wallClockMs: { used: 1_000, limit: 900_000 },
      };
      const snapshot = {
        version: 1,
        runId: `e2e-orchestrator-run-${Date.now()}`,
        mode: "code_team",
        status: "running",
        rootNodeIds: ["mission"],
        nodes: {
          mission: {
            id: "mission",
            parentId: null,
            childIds: ["code", "verify"],
            kind: "mission",
            title: "Implement template intelligence",
            status: "running",
            ownerId: "lead",
            dependencyIds: [],
            evidenceIds: [],
            receiptIds: [],
            artifactIds: [],
            createdAt: now,
            updatedAt: now,
          },
          code: {
            id: "code",
            parentId: "mission",
            childIds: [],
            kind: "code",
            title: "Implement template catalog",
            status: "running",
            ownerId: "worker",
            dependencyIds: [],
            evidenceIds: ["evidence-template"],
            receiptIds: [],
            artifactIds: [],
            worktreeId: "worktree-1",
            lastAction: "npm test",
            createdAt: now,
            updatedAt: now,
          },
          verify: {
            id: "verify",
            parentId: "mission",
            childIds: [],
            kind: "verify",
            title: "Merge and verify",
            status: "blocked",
            ownerId: "lead",
            dependencyIds: ["code"],
            evidenceIds: [],
            receiptIds: [],
            artifactIds: [],
            blocker: "Waiting for test result",
            createdAt: now,
            updatedAt: now,
          },
        },
        participants: {
          lead: {
            id: "lead",
            role: "lead",
            displayName: "Lead",
            status: "waiting",
            currentNodeId: "verify",
            budget,
            handoffStatus: "none",
            updatedAt: now,
          },
          worker: {
            id: "worker",
            role: "code_worker",
            displayName: "Code Worker",
            status: "coding",
            currentNodeId: "code",
            budget,
            handoffStatus: "preparing",
            updatedAt: now,
          },
        },
        worktrees: {
          "worktree-1": {
            id: "worktree-1",
            taskId: "code",
            repositoryRoot: "C:/repo",
            path: "C:/temp/worktrees/code",
            branch: "codex/agent-e2e-template",
            baseBranch: "main",
            baseSha: "abc1234",
            status: "testing",
            changedFiles: 7,
            changedFilePaths: ["src/template.ts"],
            validationCommands: ["npm test", "npm run build"],
            validationPassed: false,
            currentValidationCommand: "npm test",
          },
        },
        handoffs: [],
        merge: {
          status: "blocked",
          evidenceReceived: 1,
          evidenceAccepted: 1,
          evidenceRejected: 0,
          evidenceDeduplicated: 0,
          conflicts: 0,
          commitShas: [],
          verificationStatus: "pending",
          integrationStatus: "pending",
          blocker: "base checkout dirty",
        },
        sequence: Date.now(),
        createdAt: now,
        updatedAt: now,
      };
      plugin.latestOrchestratorSnapshot = null;
      plugin.orchestratorSnapshot = null;
      if (plugin.activeAgentView) {
        plugin.activeAgentView.orchestratorSnapshot = null;
        plugin.activeAgentView.orchestratorTab?.renderEmpty?.();
      }
      plugin.latestOrchestratorSnapshot = snapshot;
      plugin.settings.orchestratorEnabled = true;
      plugin.settings.orchestratorPreviewEnabled = true;
      plugin.refreshAgentView();
      plugin.activeAgentView?.orchestratorTab?.update?.(snapshot);
    }, { pluginId: PLUGIN_ID });

    await expect(promptInput).toHaveValue(unsentPrompt);
    await promptInput.fill("");

    const orchestratorTab = page.getByRole("tab", { name: "Orchestrator" });
    await expect(orchestratorTab).toBeVisible();
    await orchestratorTab.click();
    await expect(page.locator(".agentic-researcher-orchestrator")).toBeVisible();
    const taskTree = page.locator(".agentic-researcher-orchestrator-tree");
    const codeTask = taskTree.getByText("Implement template catalog", { exact: true });
    await expect(codeTask).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("codex/agent-e2e-template", { exact: true })).toBeVisible();
    await expect(page.getByText("C:/repo", { exact: true })).toBeVisible();
    await expect(page.getByText("main @ abc1234", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Pending; automatic cleanup is disabled.", { exact: true }),
    ).toBeVisible();
    const elapsedValue = page
      .locator(".agentic-researcher-orchestrator-summary-metric", { hasText: "Elapsed" })
      .locator(".agentic-researcher-orchestrator-value");
    await expect.poll(async () => elapsedValue.textContent(), { timeout: 4_000 }).not.toBe("0s");
    await codeTask.click();
    await page.getByRole("button", { name: "evidence-template", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Run Details" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator('[data-evidence-id="evidence-template"]')).toBeVisible();
    await orchestratorTab.click();
    await taskTree.getByText("Merge and verify", { exact: true }).click();
    await expect(
      page
        .getByLabel("Selected task details")
        .getByText("Waiting for test result", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("npm test", { exact: true }).first()).toBeVisible();

    const geometry = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".agentic-researcher-view");
      const rightSplit = root?.closest<HTMLElement>(".workspace-split.mod-right-split");
      if (!root || !rightSplit) throw new Error("Right pane was unavailable.");
      rightSplit.style.setProperty("flex", "0 0 320px", "important");
      rightSplit.style.setProperty("width", "320px", "important");
      rightSplit.style.setProperty("min-width", "320px", "important");
      rightSplit.style.setProperty("max-width", "320px", "important");
      const rootRect = root.getBoundingClientRect();
      const selectors = [
        ".agentic-researcher-orchestrator",
        ".agentic-researcher-orchestrator-section",
        ".agentic-researcher-orchestrator-tree",
        ".agentic-researcher-orchestrator-inspector",
        ".agentic-researcher-orchestrator-agent-card",
        ".agentic-researcher-orchestrator-worktree-card",
      ];
      const boxes = selectors.flatMap((selector) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector)).map((element) => {
          const box = element.getBoundingClientRect();
          return { selector, left: box.left, right: box.right };
        }),
      );
      const orchestrator = document.querySelector<HTMLElement>(
        ".agentic-researcher-orchestrator",
      );
      return {
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
        orchestratorClientWidth: orchestrator?.clientWidth ?? 0,
        orchestratorScrollWidth: orchestrator?.scrollWidth ?? 0,
        rootLeft: rootRect.left,
        rootRight: rootRect.right,
        boxes,
      };
    });
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.orchestratorScrollWidth).toBeLessThanOrEqual(
      geometry.orchestratorClientWidth + 1,
    );
    for (const box of geometry.boxes) {
      expect(box.left, `${box.selector} should stay inside the pane's left edge`).toBeGreaterThanOrEqual(
        geometry.rootLeft - 1,
      );
      expect(box.right, `${box.selector} should stay inside the pane's right edge`).toBeLessThanOrEqual(
        geometry.rootRight + 1,
      );
    }

    await page.getByRole("button", { name: "View verification", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Run Details" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const reopened = await page.evaluate(async ({ pluginId }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      plugin.settings.orchestratorEnabled = false;
      plugin.settings.orchestratorPreviewEnabled = false;
      await plugin.saveSettings?.();
      const app = obsidianWindow.app;
      const leaf = app?.workspace?.getLeavesOfType?.("agentic-researcher-view")?.[0];
      if (!leaf) throw new Error("Agentic Researcher view was unavailable for detach.");
      const priorView = leaf.view;
      await leaf.detach?.();
      await plugin.activateView();
      const reopenedLeaf = app.workspace.getLeavesOfType?.("agentic-researcher-view")?.[0];
      return {
        isNewView: Boolean(reopenedLeaf?.view && reopenedLeaf.view !== priorView),
        viewCount: app.workspace.getLeavesOfType?.("agentic-researcher-view")?.length ?? 0,
      };
    }, { pluginId: PLUGIN_ID });
    expect(reopened).toEqual({ isNewView: true, viewCount: 1 });
    await expect(page.locator(".agentic-researcher-view")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: "Orchestrator" })).toBeVisible();
    await page.getByRole("tab", { name: "Orchestrator" }).click();
    await expect(page.getByText("codex/agent-e2e-template", { exact: true })).toBeVisible();
  });
});

test("research team Orchestrator lead writes after researcher handoff", async () => {
  test.setTimeout(240_000);
  await withE2EHarness(
    "research-team-handoff-write",
    async ({ page }) => {
      await setStreamingMode(page, false);
      await setAgenticReflexMode(page, false);
      await setPluginSettingOverrides(page, {
        orchestratorEnabled: true,
        orchestratorPreviewEnabled: true,
        maxAgentSteps: 24,
        orchestratorWorkerMaxSteps: 6,
      });

      await submitMission(
        page,
        "E2E_RESEARCH_TEAM Do deep research with sources about a test topic and append the findings to this note.",
        { timeout: 210_000 },
      );

      await expect(page.getByRole("tab", { name: "Orchestrator" })).toBeVisible();
      await expectDetailsText(page, "ORCH>");
      await page.getByRole("tab", { name: "Run Details" }).click();
      await expect(
        page.locator(".agentic-researcher-details-panel", {
          hasText: /ORCH>|Researcher|web_search|web_fetch|E2E_RESEARCH_TEAM/i,
        }),
      ).toBeVisible({ timeout: 15_000 });
    },
    { aiMode: "mock" },
  );
});

test("code workspace multi-file run", async () => {
  test.setTimeout(180_000);
  await withE2EHarness("code-workspace-multi-file", async ({ page }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);

    await submitMission(
      page,
      "E2E_CODE_WORKSPACE Build a small javascript workspace program with util.js and main.js, then run the entryPath.",
      { timeout: 150_000 },
    );

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_CODE_WORKSPACE_DONE",
      }),
    ).toBeVisible({ timeout: 60_000 });
    await expectToolRun(page, "write_workspace_file");
    await expectToolRun(page, "run_code_block");
    await expect(
      page
        .locator(".agentic-researcher-code-output-chunk", {
          hasText: "E2E_CODE_WORKSPACE_OUTPUT",
        })
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await expectDetailsText(page, "Code finished with exit code 0.");
  });
});

test("design revise updates canvas with backup", async () => {
  test.setTimeout(240_000);
  await withE2EHarness("design-revise-canvas", async ({ page, input }) => {
    const canvasFilePath = path.join(vaultRoot, ...input.designCanvasPath.split("/"));
    const initialCanvas = JSON.stringify(
      {
        nodes: [
          {
            id: "canvas-title",
            type: "text",
            x: 0,
            y: 0,
            width: 720,
            height: 120,
            color: "4",
            text: "# Original Canvas Title",
          },
          {
            id: "unrelated-sentinel",
            type: "text",
            x: 0,
            y: 240,
            width: 360,
            height: 180,
            color: "5",
            text: "Unrelated sentinel must survive",
            futureField: { preserved: true },
          },
        ],
        edges: [],
        futureTopLevel: { preserved: true },
      },
      null,
      2,
    );
    const revisePrompt = `E2E_DESIGN_REVISE_UPDATE Revise the canvas design at ${input.designCanvasPath} and update the diagram title.`;
    await page.evaluate(
      async ({ pluginId, canvasPath, content, prompt }) => {
        const obsidianWindow = window as typeof window & { app?: any };
        const app = obsidianWindow.app;
        const plugin = app?.plugins?.plugins?.[pluginId];
        if (!app?.vault || !plugin) throw new Error("Plugin/vault unavailable");
        const parts = canvasPath.split("/");
        let folder = "";
        for (const part of parts.slice(0, -1)) {
          folder = folder ? `${folder}/${part}` : part;
          if (!app.vault.getAbstractFileByPath(folder)) {
            try {
              await app.vault.createFolder(folder);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!/already exists/i.test(message)) {
                throw error;
              }
            }
          }
        }
        const existing = app.vault.getAbstractFileByPath(canvasPath);
        if (existing) {
          await app.vault.modify(existing, content);
        } else {
          await app.vault.create(canvasPath, content);
        }

      },
      {
        pluginId: PLUGIN_ID,
        canvasPath: input.designCanvasPath,
        content: initialCanvas,
        prompt: revisePrompt,
      },
    );

    await submitMission(page, revisePrompt, {
      timeout: 120_000,
      waitForCompletion: false,
    });
    await page.getByRole("tab", { name: "Run Details" }).click();
    const approval = activePreparedApproval(page, "update_design_canvas");
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval).toContainText("exact_payload_approval");
    await expect(approval).toContainText("sha256:");
    expect(await readOptionalFile(canvasFilePath)).toBe(initialCanvas);
    await approvePreparedApproval(page, approval);
    await waitForMissionComplete(page, 120_000);
    await assertMockModelUsed(page);

    await expectFileToContain(
      canvasFilePath,
      "Revised Canvas Title",
      "design revise should update the same canvas path",
    );
    const persistedCanvas = JSON.parse(
      (await readOptionalFile(canvasFilePath)) ?? "null",
    );
    expect(persistedCanvas.nodes.map((node: any) => node.id)).toEqual([
      "canvas-title",
      "unrelated-sentinel",
    ]);
    expect(persistedCanvas.nodes[1].futureField).toEqual({ preserved: true });
    expect(persistedCanvas.futureTopLevel).toEqual({ preserved: true });
    await expectBackupToContain(
      page,
      "Original Canvas Title",
      "design revise should backup the prior canvas contents",
    );
    await expectToolRun(page, "read_design_canvas");
    await expectToolRun(page, "update_design_canvas");
    await expectReceipt(page, input.designCanvasPath);

    await page.evaluate(async (canvasPath) => {
      const app = (window as typeof window & { app?: any }).app;
      const file = app?.vault?.getFileByPath?.(canvasPath);
      if (!file) throw new Error(`Canvas missing for rendered QA: ${canvasPath}`);
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
    }, input.designCanvasPath);
    const canvasView = page.locator(
      '.workspace-leaf-content[data-type="canvas"]',
    ).last();
    await expect(canvasView).toBeVisible({ timeout: 30_000 });
    await expect(canvasView.locator(".canvas-node")).toHaveCount(2, {
      timeout: 30_000,
    });
    await expect(canvasView).toContainText("Revised Canvas Title");
    await expect(canvasView).toContainText("Unrelated sentinel must survive");
    await expectRenderedScreenshotState(canvasView, "phase5-canvas-render", {
      minimumWidth: 240,
      minimumHeight: 160,
    });
  });
});

test("design revise updates and renders SVG with backup", async () => {
  test.setTimeout(240_000);
  await withE2EHarness("design-revise-svg", async ({ page, input }) => {
    const svgFilePath = path.join(vaultRoot, ...input.designSvgPath.split("/"));
    const initialSvg = [
      '<svg id="svg-root" xmlns="http://www.w3.org/2000/svg" width="720" height="320" viewBox="0 0 720 320" role="img" aria-label="E2E SVG">',
      '  <rect id="frame" x="20" y="20" width="680" height="280" fill="#101010" stroke="#22c55e" />',
      '  <text id="svg-title" x="360" y="100" font-size="30" text-anchor="middle" fill="#22c55e">Original SVG Title</text>',
      '  <text id="svg-sentinel" x="360" y="190" font-size="20" text-anchor="middle" fill="#86efac" data-preserve="yes">Unrelated SVG sentinel</text>',
      "</svg>",
    ].join("\n");
    await createVaultFixture(page, input.designSvgPath, initialSvg);

    const prompt = `E2E_SVG_REVISE_UPDATE Revise the SVG design at ${input.designSvgPath} and update its title.`;
    await submitMission(page, prompt, {
      timeout: 120_000,
      waitForCompletion: false,
    });
    await page.getByRole("tab", { name: "Run Details" }).click();
    const approval = activePreparedApproval(page, "update_svg_design");
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval).toContainText("exact_payload_approval");
    await expect(approval).toContainText("sha256:");
    expect(await readOptionalFile(svgFilePath)).toBe(initialSvg);
    await approvePreparedApproval(page, approval);
    await waitForMissionComplete(page, 120_000);
    await assertMockModelUsed(page);

    await expectFileToContain(
      svgFilePath,
      "Revised SVG Title",
      "SVG revision should update the selected text element",
    );
    await expectFileToContain(
      svgFilePath,
      'data-preserve="yes">Unrelated SVG sentinel',
      "SVG revision should preserve unrelated source slices",
    );
    await expectBackupToContain(
      page,
      "Original SVG Title",
      "SVG revision should back up the prior artifact",
    );
    await expectToolRun(page, "read_svg_design");
    await expectToolRun(page, "update_svg_design");
    await expectReceipt(page, input.designSvgPath);

    await page.evaluate(async (svgPath) => {
      const app = (window as typeof window & { app?: any }).app;
      const file = app?.vault?.getFileByPath?.(svgPath);
      if (!file) throw new Error(`SVG missing for rendered QA: ${svgPath}`);
      await app.workspace.getLeaf("tab").openFile(file);
    }, input.designSvgPath);
    const imageView = page.locator(
      '.workspace-leaf-content[data-type="image"]',
    ).last();
    await expect(imageView).toBeVisible({ timeout: 30_000 });
    const renderedImage = imageView.locator("img").last();
    await expect(renderedImage).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => renderedImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await expectRenderedScreenshotState(imageView, "phase5-svg-render", {
      minimumWidth: 240,
      minimumHeight: 160,
    });
  });
});

test("design revise updates and renders Mermaid with backup", async () => {
  test.setTimeout(240_000);
  await withE2EHarness("design-revise-mermaid", async ({ page, input }) => {
    const mermaidFilePath = path.join(
      vaultRoot,
      ...input.designMermaidPath.split("/"),
    );
    const initialMarkdown = [
      "# Mermaid Flow",
      "",
      "Unrelated Markdown introduction must survive.",
      "",
      "<!-- agentic-mermaid:block-id=flow-main -->",
      "```mermaid",
      "flowchart LR",
      "  A[Original Mermaid Start] --> B[Original Finish]",
      "```",
      "",
      "Unrelated Markdown tail must survive.",
      "",
    ].join("\n");
    await createVaultFixture(page, input.designMermaidPath, initialMarkdown);

    const prompt = `E2E_MERMAID_REVISE_UPDATE Revise the Mermaid diagram in ${input.designMermaidPath} with block id flow-main.`;
    await submitMission(page, prompt, {
      timeout: 120_000,
      waitForCompletion: false,
    });
    await page.getByRole("tab", { name: "Run Details" }).click();
    const approval = activePreparedApproval(page, "upsert_mermaid_block");
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval).toContainText("exact_payload_approval");
    await expect(approval).toContainText("sha256:");
    expect(await readOptionalFile(mermaidFilePath)).toBe(initialMarkdown);
    await approvePreparedApproval(page, approval);
    await waitForMissionComplete(page, 120_000);
    await assertMockModelUsed(page);

    await expectFileToContain(
      mermaidFilePath,
      "Revised Mermaid Start",
      "Mermaid revision should update the selected fenced block",
    );
    await expectFileToContain(
      mermaidFilePath,
      "Unrelated Markdown introduction must survive.",
      "Mermaid revision should preserve Markdown before the selected block",
    );
    await expectFileToContain(
      mermaidFilePath,
      "Unrelated Markdown tail must survive.",
      "Mermaid revision should preserve Markdown after the selected block",
    );
    await expectBackupToContain(
      page,
      "Original Mermaid Start",
      "Mermaid revision should back up the prior Markdown artifact",
    );
    await expectToolRun(page, "read_mermaid_block");
    await expectToolRun(page, "upsert_mermaid_block");
    await expectReceipt(page, input.designMermaidPath);

    await page.evaluate(async (markdownPath) => {
      const app = (window as typeof window & { app?: any }).app;
      const file = app?.vault?.getFileByPath?.(markdownPath);
      if (!file) throw new Error(`Markdown missing for Mermaid QA: ${markdownPath}`);
      const leaf = app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: "markdown",
        state: { file: markdownPath, mode: "preview" },
        active: true,
      });
    }, input.designMermaidPath);
    const markdownView = page.locator(
      '.workspace-leaf-content[data-type="markdown"]',
    ).last();
    await expect(markdownView).toBeVisible({ timeout: 30_000 });
    const renderedMermaid = markdownView.locator(".mermaid svg").last();
    await expect(renderedMermaid).toBeVisible({ timeout: 30_000 });
    await expect(markdownView).toContainText("Revised Mermaid Start");
    await expect(markdownView).toContainText("Unrelated Markdown tail must survive.");
    await expectRenderedScreenshotState(markdownView, "phase5-mermaid-render", {
      minimumWidth: 240,
      minimumHeight: 160,
    });
  });
});

test("budget-stopped run exposes Continue Latest Run action", async () => {
  await withE2EHarness("continue-latest-run-action", async ({ page, noteFilePath }) => {
    await setStreamingMode(page, false);

    await submitMission(
      page,
      "E2E_CONTINUE_BUTTON_BUDGET Append the result to the current note.",
      { timeout: 180_000 },
    );

    await page.getByRole("tab", { name: "Run Details" }).click();
    await expectDetailsText(page, "ledger_status=budget");
    await expectDetailsText(page, "ledger_can_resume=on");
    await expectDetailsText(page, "dependency_provider_auth=");
    const detailsText =
      (await page.locator(".agentic-researcher-details-panel").textContent()) ?? "";
    const runId =
      /ledger_continuation=continue run (run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z(?:-[a-f0-9]+)?)/.exec(
        detailsText,
      )?.[1] ?? "";
    expect(runId, "Run Details should expose a concrete continuation command").not.toBe("");

    await page.getByRole("button", { name: "Continue Latest Run" }).click();
    await waitForMissionComplete(page, 120_000);
    await page.getByRole("tab", { name: "Chat" }).click();
    await expect(
      page.locator(".agentic-researcher-log-user .agentic-researcher-log-message", {
        hasText: `continue run ${runId}`,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectNoteToContain(
      noteFilePath,
      `E2E_RESUME_LEDGER_${runId}`,
      "continuing a write-required budget run should complete through the write tool",
    );
  });
});

test("code workflow runs javascript with streamed output and exit-code proof", async () => {
  await withE2EHarness("code-workflow-run", async ({ page }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);

    await submitMission(
      page,
      "E2E_CODE_WORKFLOW Run this javascript snippet and show me the result.",
      { timeout: 120_000 },
    );

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_CODE_WORKFLOW_DONE",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectToolRun(page, "run_code_block");
    await expect(
      page
        .locator(".agentic-researcher-code-output-chunk", {
          hasText: "E2E_CODE_WORKFLOW_OUTPUT",
        })
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    await expectDetailsText(page, "Code finished with exit code 0.");
  });
});

test("approval card gates long code runs through deny and approve", async () => {
  await withE2EHarness("code-approval-card", async ({ page }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);

    await submitMission(
      page,
      "E2E_CODE_DENY Run this javascript code with a long timeout.",
      { waitForCompletion: false },
    );
    await page.getByRole("tab", { name: "Run Details" }).click();
    const denyCard = page
      .locator(".agentic-researcher-approval-card", { hasText: "run_code_block" })
      .last();
    await expect(denyCard).toBeVisible({ timeout: 30_000 });
    await expect(denyCard).toContainText("long_code_timeout");
    await denyCard.locator("button.agentic-researcher-approval-deny").click();
    await expect(denyCard).toContainText("decision=denied");
    await waitForMissionComplete(page, 120_000);
    await expect(
      page.locator(".agentic-researcher-code-output-chunk", {
        hasText: "E2E_CODE_DENY_OUTPUT",
      }),
    ).toHaveCount(0);

    await submitMission(
      page,
      "E2E_CODE_APPROVAL Run this javascript code with a long timeout.",
      { waitForCompletion: false },
    );
    await page.getByRole("tab", { name: "Run Details" }).click();
    const approveCard = page
      .locator(".agentic-researcher-approval-card", { hasText: "run_code_block" })
      .last();
    await expect(approveCard).toBeVisible({ timeout: 30_000 });
    await expect(approveCard).toContainText("long_code_timeout");
    await approveCard.locator("button.agentic-researcher-approval-approve").click();
    await expect(approveCard).toContainText("decision=approved");
    await waitForMissionComplete(page, 120_000);
    await expect(
      page
        .locator(".agentic-researcher-code-output-chunk", {
          hasText: "E2E_CODE_APPROVAL_OUTPUT",
        })
        .first(),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Chat" }).click();
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_CODE_APPROVAL_DONE",
      }),
    ).toBeVisible({ timeout: 30_000 });
  });
});

test("wall-clock budget stops run with resumable ledger", async () => {
  await withE2EHarness("wall-clock-budget", async ({ page }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);
    await setPluginSettingOverrides(page, { maxRunMinutes: 0.05 });

    await submitMission(
      page,
      "Inspect the current note graph for E2E_WALL_CLOCK and keep expanding graph context until stopped.",
      { timeout: 120_000 },
    );

    await expectDetailsText(page, "Wall-clock run budget expired");
    await expectDetailsText(page, "ledger_status=budget");
    await expectDetailsText(page, "ledger_can_resume=on");
    await expect(
      page.getByRole("button", { name: "Continue Latest Run" }),
    ).toBeVisible();
  });
});

test("small context budget compacts loop messages mid-run", async () => {
  await withE2EHarness("context-compaction", async ({ page }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);
    await setPluginSettingOverrides(page, { numCtx: 1200 });

    await submitMission(
      page,
      "Inspect the current note graph for E2E_LOOP_STEPS_5 and complete exactly 5 model steps before the final answer.",
      { timeout: 180_000 },
    );

    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_LOOP_DONE_5",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectDetailsText(page, "Compacted loop context");
    await expectDetailsText(page, "estimated_prompt_chars_after");
  });
});

test("web fetch caches sources and reuses the cache on refetch", async () => {
  await withE2EHarness("source-cache-reuse", async ({ page }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);

    await submitMission(
      page,
      "Use web sources and citations for E2E_SOURCE_CACHE_FIRST. Give a concise sourced answer.",
      { timeout: 120_000 },
    );
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_SOURCE_CACHE_FIRST_DONE",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expectToolRun(page, "web_fetch");

    const cacheNoteContent = await page.evaluate(async () => {
      const obsidianWindow = window as typeof window & { app?: any };
      const app = obsidianWindow.app;
      const files =
        typeof app?.vault?.getFiles === "function" ? app.vault.getFiles() : [];
      for (const file of files) {
        const filePath = String(file.path ?? "");
        if (!filePath.startsWith("Agent Sources/") || !filePath.endsWith(".md")) {
          continue;
        }
        const content = await app.vault.read(file);
        if (content.includes("e2e-cache-source")) {
          return content;
        }
      }
      return "";
    });
    expect(
      cacheNoteContent,
      "web_fetch should write a full-text cache note under Agent Sources/",
    ).toContain("E2E_SOURCE_CACHE_CONTENT");
    expect(cacheNoteContent).toContain('url: "https://example.com/e2e-cache-source"');

    await submitMission(
      page,
      "Use web sources and citations for E2E_SOURCE_CACHE_SECOND. Give a concise sourced answer.",
      { timeout: 120_000 },
    );
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_SOURCE_CACHE_HIT",
      }),
    ).toBeVisible({ timeout: 30_000 });
  });
});

test("scheduled mission fires through MissionScheduler with panel closed", async () => {
  test.setTimeout(180_000);
  await withE2EHarness("scheduled-run-panel-closed", async ({ page }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);

    const scheduleId = `e2e-scheduled-${Date.now()}`;
    const prompt =
      "E2E_SCHEDULED_RUN Say E2E_SCHEDULED_DONE in chat after the scheduled fire.";

    const detached = await page.evaluate(async ({ pluginId }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eDetachedAgentView?: unknown;
      };
      const app = obsidianWindow.app;
      const leaf = app?.workspace?.getLeavesOfType?.("agentic-researcher-view")?.[0];
      if (!leaf) {
        throw new Error("Active Agentic Researcher view was unavailable for detach.");
      }
      obsidianWindow.__e2eDetachedAgentView = leaf.view;
      await leaf.detach?.();
      return {
        remainingViews:
          app.workspace.getLeavesOfType?.("agentic-researcher-view")?.length ?? -1,
        pluginLoaded: Boolean(app?.plugins?.plugins?.[pluginId]),
      };
    }, { pluginId: PLUGIN_ID });
    expect(detached).toEqual({ remainingViews: 0, pluginLoaded: true });
    await expect(page.locator(".agentic-researcher-view")).toHaveCount(0);

    const fired = await page.evaluate(
      async ({ pluginId, scheduleId, prompt }) => {
        const obsidianWindow = window as typeof window & { app?: any };
        const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
        if (!plugin?.missionScheduler?.tick || !plugin?.settings) {
          throw new Error("MissionScheduler API was unavailable for scheduled e2e.");
        }
        if (typeof plugin.runScheduledMission !== "function") {
          throw new Error("runScheduledMission was unavailable for scheduled e2e.");
        }

        plugin.settings.scheduledMissions = [
          {
            id: scheduleId,
            prompt,
            cadence: "hourly",
            enabled: true,
            lastRunAt: null,
            lastRunId: null,
          },
        ];

        await plugin.missionScheduler.tick(new Date());

        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const mission = (plugin.settings.scheduledMissions ?? []).find(
            (item: { id?: string }) => item.id === scheduleId,
          );
          if (
            mission?.lastRunId &&
            mission?.lastOutcome &&
            !plugin.isMissionRunning?.()
          ) {
            return {
              lastRunId: mission.lastRunId as string,
              lastOutcome: mission.lastOutcome as string,
              coordinatorRunning: Boolean(plugin.isMissionRunning?.()),
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const mission = (plugin.settings.scheduledMissions ?? []).find(
          (item: { id?: string }) => item.id === scheduleId,
        );
        throw new Error(
          `Scheduled mission did not persist run id/outcome. lastRunId=${
            mission?.lastRunId ?? "null"
          } lastOutcome=${mission?.lastOutcome ?? "null"} running=${Boolean(
            plugin.isMissionRunning?.(),
          )}`,
        );
      },
      { pluginId: PLUGIN_ID, scheduleId, prompt },
    );

    expect(fired.lastRunId).toMatch(/^run-/);
    expect(fired.lastOutcome).toMatch(/^(final|write_completed)$/);
    expect(fired.coordinatorRunning).toBe(false);

    await page.evaluate(async ({ pluginId }) => {
      const obsidianWindow = window as typeof window & { app?: any };
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      if (!plugin?.activateView) {
        throw new Error("Plugin activation API was unavailable after scheduled run.");
      }
      await plugin.activateView();
    }, { pluginId: PLUGIN_ID });
    await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
      timeout: 30_000,
    });
    await page.getByRole("tab", { name: "Chat" }).click();
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_SCHEDULED_DONE",
      }).last(),
    ).toBeVisible({ timeout: 30_000 });
  });
});

test("parallel read-only tools run concurrently then mutating tool stays sequential", async () => {
  test.setTimeout(180_000);
  await withE2EHarness("parallel-read-tools", async ({ page, noteFilePath, input }) => {
    await setStreamingMode(page, false);
    await setAgenticReflexMode(page, false);

    const marker = `E2E_PARALLEL_DONE_${input.marker}`;
    await page.evaluate(({ pluginId }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eParallelToolEvents?: Array<{
          phase: "start" | "done";
          name: string;
          at: number;
        }>;
      };
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      if (!plugin?.subscribeMissionEvents) {
        throw new Error("Mission event subscription API was unavailable.");
      }
      obsidianWindow.__e2eParallelToolEvents = [];
      plugin.subscribeMissionEvents({
        onToolStart: (event: { name?: string }) => {
          obsidianWindow.__e2eParallelToolEvents!.push({
            phase: "start",
            name: String(event.name ?? ""),
            at: Date.now(),
          });
        },
        onToolDone: (event: { name?: string }) => {
          obsidianWindow.__e2eParallelToolEvents!.push({
            phase: "done",
            name: String(event.name ?? ""),
            at: Date.now(),
          });
        },
      });
    }, { pluginId: PLUGIN_ID });

    await submitMission(
      page,
      `E2E_PARALLEL_READ Inspect the current note with parallel vault reads, then append ${marker} to this note.`,
      { timeout: 120_000 },
    );

    await expectNoteToContain(
      noteFilePath,
      marker,
      "parallel-read scenario should append the marker after reads",
      60_000,
    );
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        // Write-completion may short-circuit before a model final answer; the
        // append text still carries E2E_PARALLEL_DONE_* into the note.
        hasText: /E2E_PARALLEL_DONE|Done\./,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expectDetailsText(page, "read-only tools in parallel");
    await expectToolRun(page, "append_to_current_file");

    const parallelProof = await page.evaluate(() => {
      const mockWindow = window as typeof window & {
        __e2eParallelToolEvents?: Array<{
          phase: "start" | "done";
          name: string;
          at: number;
        }>;
      };
      const events = mockWindow.__e2eParallelToolEvents ?? [];
      const readNames = [
        "semantic_search_notes",
        "read_markdown_files",
      ];
      const readStarts = events.filter(
        (event) => event.phase === "start" && readNames.includes(event.name),
      );
      const readDones = events.filter(
        (event) => event.phase === "done" && readNames.includes(event.name),
      );
      const appendStart = events.find(
        (event) => event.phase === "start" && event.name === "append_to_current_file",
      );
      const firstReadDoneAt = Math.min(...readDones.map((event) => event.at));
      const lastReadStartAt = Math.max(...readStarts.map((event) => event.at));
      const toolOrder = events
        .filter((event) => event.phase === "start")
        .map((event) => event.name);
      return {
        readStartCount: readStarts.length,
        readDoneCount: readDones.length,
        overlappingStarts: lastReadStartAt <= firstReadDoneAt,
        appendAfterReads:
          appendStart !== undefined &&
          readDones.every((event) => event.at <= appendStart.at),
        toolOrder,
      };
    });

    expect(parallelProof.readStartCount).toBeGreaterThanOrEqual(2);
    expect(parallelProof.readStartCount).toBeLessThanOrEqual(4);
    expect(parallelProof.readDoneCount).toBe(parallelProof.readStartCount);
    expect(parallelProof.overlappingStarts).toBe(true);
    expect(parallelProof.appendAfterReads).toBe(true);
    expect(parallelProof.toolOrder.at(-1)).toBe("append_to_current_file");
  });
});

test("sourced append keeps web and write tools available together", async () => {
  await withE2EHarness("sourced-append-multitool", async ({ page, noteFilePath, input }) => {
    const marker = `E2E_SOURCED_APPEND_MULTI_TOOL_${input.marker}`;
    await setStreamingMode(page, true);

    await submitMission(
      page,
      `E2E_SOURCED_APPEND_MULTI_TOOL: Research MCP server sources and append a concise cited summary with ${marker} to this note. Include source URLs.`,
      { timeout: 120_000 },
    );

    await expectNoteToContain(
      noteFilePath,
      marker,
      "sourced append should write the marker after web tools",
      20_000,
    );
    await expectToolRun(page, "web_search");
    await expectToolRun(page, "web_fetch");
    // The mock asserts append_to_current_file is model-visible alongside both
    // web tools. The proof gate then performs the verified streamed mutation
    // host-side, so completion proof is the canonical append receipt rather
    // than a model-requested append entry in the tool timeline.
    await expectReceipt(page, "append");
    await page.getByRole("tab", { name: "Run Details" }).click();
    await expect(page.locator(".agentic-researcher-details-panel")).not.toContainText(
      /Rejected unavailable tool/,
    );
  });
});

test("proof-gated sourced writeback rejects premature mutation and commits one corrected draft", async () => {
  await withE2EHarness(
    "proof-gated-dependency-writeback",
    async ({ page, notePath, noteFilePath, input }) => {
      const originalNote =
        "E2E proof gate original note must remain byte-identical before commit.";
      const committedMarker = `E2E_PROOF_GATED_COMMIT_${input.marker}`;
      await setActiveNoteContent(page, notePath, originalNote);
      await setStreamingMode(page, true);
      await setPluginSettingOverrides(page, {
        maxAgentSteps: 16,
      });

      await submitMission(
        page,
        `E2E_PROOF_GATED_DEPENDENCY_WRITEBACK ${committedMarker}: Research MCP servers on the web and append a concise summary with citations to this note.`,
        { timeout: 180_000 },
      );

      await expectNoteToContain(
        noteFilePath,
        committedMarker,
        "the corrected proof-bound draft should commit after fetched evidence exists",
        20_000,
      );
      const finalNote = await readFile(noteFilePath, "utf8");
      expect(finalNote.startsWith(originalNote)).toBe(true);
      expect(finalNote).not.toContain("E2E_PREMATURE_PROOF_GATED_WRITE");
      expect(finalNote).not.toContain("E2E_INVALID_UNCITED_PROOF_DRAFT");
      expect(finalNote.match(new RegExp(committedMarker, "g")) ?? []).toHaveLength(1);
      expect(finalNote).toContain("https://example.com/e2e-proof-gated-source");
      expect(finalNote).toMatch(/source:[A-Za-z0-9]+:passage:\d+-\d+/);

      await expectToolRun(page, "web_search");
      await expectToolRun(page, "web_fetch");
      await expectReceipt(page, "append");
      await expectDetailsText(page, "plan_dependency_violation");
      await expectDetailsText(page, "Writeback draft held for verification");
      await expect(
        page.locator(".agentic-researcher-receipt", { hasText: "append" }),
      ).toHaveCount(1);
    },
  );
});

test("current market writeback uses web fallback before streaming note output", async () => {
  await withE2EHarness("current-market-web-writeback", async ({ page, noteFilePath, input }) => {
    const marker = `E2E_CURRENT_MARKET_WRITEBACK_${input.marker}`;
    await setStreamingMode(page, true);

    await submitMission(
      page,
      `${marker}
I want you to write on this note.

Start by titling it Software project.

I want you to find and organize information about the current online dating market and also the social media market.

Write in a business type, market research format.`,
      { timeout: 180_000 },
    );

    await expectNoteToContain(
      noteFilePath,
      "# Software project",
      "current market writeback should title the note output",
      20_000,
    );
    await expectNoteToContain(
      noteFilePath,
      marker,
      "current market writeback should stream the final report after web fallback",
      20_000,
    );
    await expectToolRun(page, "web_search");
    await expectToolRun(page, "web_fetch");
    await expectReceipt(page, "append");
    await page.getByRole("tab", { name: "Run Details" }).click();
    // Core product proof for this scenario: model skipped tools, runner ran
    // read-only web fallback, then streamed writeback. Retry status may be
    // absent when the injected 500 is absorbed before the status stream.
    await expect(
      page.locator(".agentic-researcher-details-panel"),
    ).toContainText(/running read-only web fallback|Transient (?:streaming )?model/i, {
      timeout: 15_000,
    });
    await expect(page.locator(".agentic-researcher-details-panel")).not.toContainText(
      "I could not get the model to request the required read tools before writing",
    );
  });
});

test("mission acceptance retries early word-count answer before completion", async () => {
  await withE2EHarness("mission-acceptance-word-count", async ({ page }) => {
    await submitMission(
      page,
      "E2E_ACCEPTANCE_WORD_COUNT Count the words in the current note before answering.",
      { timeout: 120_000 },
    );

    await expectToolRun(page, "count_words");
    await page.getByRole("tab", { name: "Chat" }).click();
    await expect(
      page.locator(".agentic-researcher-log-assistant .agentic-researcher-log-message", {
        hasText: "E2E_ACCEPTANCE_WORD_COUNT_DONE",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Run Details" }).click();
    await expect(page.locator(".agentic-researcher-details-panel")).toContainText(
      "Mission acceptance",
    );
    await expect(
      page.locator(".agentic-researcher-dashboard-body-acceptance"),
    ).toContainText("status");
    await expect(
      page.locator(".agentic-researcher-dashboard-body-acceptance"),
    ).toContainText("pass");
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
  test.setTimeout(180_000);
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
      { waitForCompletion: false },
    );

    await page.getByRole("tab", { name: "Run Details" }).click();
    const replaceApproval = page
      .locator(".agentic-researcher-approval-card", {
        hasText: "replace_file",
      })
      .filter({ hasText: "confirmation=1/1" })
      .last();
    await expect(replaceApproval).toBeVisible({ timeout: 30_000 });
    const beforeReplace = await readOptionalFile(initialFilePath);
    expect(beforeReplace).not.toBeNull();
    expect(beforeReplace).toContain(`CREATE:${input.marker}`);
    expect(beforeReplace).toContain(`APPEND:${input.secondMarker}`);
    expect(beforeReplace).not.toContain(`REPLACE:${input.marker}`);
    expect(await readOptionalFile(movedFilePath)).toBeNull();
    for (const backupFilePath of await listFilesRecursively(
      path.join(vaultRoot, ".agent-backups"),
    )) {
      expect(await readOptionalFile(backupFilePath)).not.toContain(
        `APPEND:${input.secondMarker}`,
      );
    }
    await replaceApproval
      .locator("button.agentic-researcher-approval-approve")
      .click();
    await expect(replaceApproval).toContainText("decision=approved");

    const firstDeleteApproval = page
      .locator(".agentic-researcher-approval-card", {
        hasText: "delete_path",
      })
      .filter({ hasText: "confirmation=1/2" })
      .last();
    await expect(firstDeleteApproval).toBeVisible({ timeout: 30_000 });
    const movedBeforeDelete = await readOptionalFile(movedFilePath);
    expect(movedBeforeDelete).toBe(
      `# CRUD Replaced\n\nREPLACE:${input.marker}\n`,
    );
    expect(await readOptionalFile(initialFilePath)).toBeNull();
    await expect(
      page.locator(".agentic-researcher-receipt", { hasText: "trash" }),
    ).toHaveCount(0);
    const firstDeleteIdentity = await readPendingPreparedApproval(
      page,
      "delete_path",
      1,
    );
    await firstDeleteApproval
      .locator("button.agentic-researcher-approval-approve")
      .click();
    await expect(firstDeleteApproval).toContainText("decision=approved");

    const secondDeleteApproval = page
      .locator(".agentic-researcher-approval-card", {
        hasText: "delete_path",
      })
      .filter({ hasText: "confirmation=2/2" })
      .last();
    await expect(secondDeleteApproval).toBeVisible({ timeout: 30_000 });
    expect(await readOptionalFile(movedFilePath)).toBe(movedBeforeDelete);
    expect(await readOptionalFile(initialFilePath)).toBeNull();
    await expect(
      page.locator(".agentic-researcher-receipt", { hasText: "trash" }),
    ).toHaveCount(0);
    const secondDeleteIdentity = await readPendingPreparedApproval(
      page,
      "delete_path",
      2,
    );
    expect(secondDeleteIdentity.preparedActionId).toBe(
      firstDeleteIdentity.preparedActionId,
    );
    expect(secondDeleteIdentity.payloadFingerprint).toBe(
      firstDeleteIdentity.payloadFingerprint,
    );
    expect(secondDeleteIdentity.requestId).not.toBe(firstDeleteIdentity.requestId);
    await secondDeleteApproval
      .locator("button.agentic-researcher-approval-approve")
      .click();
    await expect(secondDeleteApproval).toContainText("decision=approved");

    await waitForMissionComplete(page, 120_000);
    await assertMockModelUsed(page);

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
      page,
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

test("CRUD delete denial preserves exact bytes without trashing", async () => {
  test.setTimeout(180_000);
  await withE2EHarness("crud-delete-denial", async ({ page, input }) => {
    const targetPath = `E2E Agent Tests/CRUD Denial/delete-deny-${input.marker}.md`;
    const targetFilePath = path.join(vaultRoot, ...targetPath.split("/"));
    const targetContent = `# Delete denial fixture\n\n${input.marker}\n${input.secondMarker}\n`;

    await createVaultFixture(page, targetPath, targetContent);
    try {
      const targetBefore = await snapshotFileBytes(targetFilePath);
      const trashBefore = await snapshotVaultTrash();
      expect(targetBefore).not.toBeNull();

      await submitMission(
        page,
        `E2E_DELETE_DENY ${input.marker}: trash ${targetPath}. If approval is denied, report the denial without retrying.`,
        { waitForCompletion: false },
      );

      await page.getByRole("tab", { name: "Run Details" }).click();
      const deleteApproval = page
        .locator(".agentic-researcher-approval-card", {
          hasText: "delete_path",
        })
        .filter({ hasText: "confirmation=1/2" })
        .last();
      await expect(deleteApproval).toBeVisible({ timeout: 30_000 });
      expect(await snapshotFileBytes(targetFilePath)).toEqual(targetBefore);
      expect(await snapshotVaultTrash()).toEqual(trashBefore);
      const firstDeleteIdentity = await readPendingPreparedApproval(
        page,
        "delete_path",
        1,
      );

      await deleteApproval
        .locator("button.agentic-researcher-approval-approve")
        .click();
      await expect(deleteApproval).toContainText("decision=approved");

      const finalDeleteApproval = page
        .locator(".agentic-researcher-approval-card", {
          hasText: "delete_path",
        })
        .filter({ hasText: "confirmation=2/2" })
        .last();
      await expect(finalDeleteApproval).toBeVisible({ timeout: 30_000 });
      const finalDeleteIdentity = await readPendingPreparedApproval(
        page,
        "delete_path",
        2,
      );
      expect(finalDeleteIdentity.preparedActionId).toBe(
        firstDeleteIdentity.preparedActionId,
      );
      expect(finalDeleteIdentity.payloadFingerprint).toBe(
        firstDeleteIdentity.payloadFingerprint,
      );
      expect(await snapshotFileBytes(targetFilePath)).toEqual(targetBefore);
      expect(await snapshotVaultTrash()).toEqual(trashBefore);

      await finalDeleteApproval
        .locator("button.agentic-researcher-approval-deny")
        .click();
      await expect(finalDeleteApproval).toContainText("decision=denied");
      await waitForMissionComplete(page, 30_000);

      expect(await snapshotFileBytes(targetFilePath)).toEqual(targetBefore);
      expect(await snapshotVaultTrash()).toEqual(trashBefore);
      await expect(
        page.locator(".agentic-researcher-receipt", { hasText: "trash" }),
      ).toHaveCount(0);
    } finally {
      await deleteVaultFixture(page, targetPath);
    }
  });
});

test("authoritative MissionGraph is visible and persisted before tool execution", async () => {
  test.setTimeout(180_000);
  await withE2EHarness("mission-graph-visible-before-tool", async ({ page, input }) => {
    const targetPath =
      `E2E Agent Tests/Mission Graph Guard/visible-${input.marker}.md`;
    const targetFilePath = path.join(vaultRoot, ...targetPath.split("/"));

    try {
      await submitMission(
        page,
        `E2E_MGV3_VISIBLE_BEFORE_TOOL ${input.marker}: Create file ${targetPath} with the exact marker ${input.marker}.`,
        { waitForCompletion: false },
      );

      await page.getByRole("tab", { name: "Run Details" }).click();
      const missionIdField = missionGraphField(page, "mission_id");
      await expect(missionIdField).toHaveText(/^mission_id=run-/u, {
        timeout: 30_000,
      });
      await expect(missionGraphField(page, "objective")).toContainText(
        "E2E_MGV3_VISIBLE_BEFORE_TOOL",
      );
      await expect(missionGraphField(page, "routing_source")).toHaveText(
        "routing_source=deterministic",
      );
      await expect(missionGraphField(page, "routing_fallback")).not.toHaveText(
        "routing_fallback=none",
      );
      await expect(missionGraphField(page, "active_node")).not.toHaveText(
        "active_node=none",
      );
      await expect(missionGraphField(page, "status")).toHaveText("status=ready");
      await expect(page.locator(".agentic-researcher-tool-item")).toHaveCount(0);
      expect(await snapshotFileBytes(targetFilePath)).toBeNull();

      const missionId = (await missionIdField.textContent())?.replace(
        /^mission_id=/u,
        "",
      ) ?? "";
      expect(missionId).not.toBe("");
      const persistedBeforeTool = await readPersistedMissionGraphRecord(missionId);
      expect(persistedBeforeTool.graph.missionId).toBe(missionId);
      expect(persistedBeforeTool.graph.revision).toBeGreaterThanOrEqual(0);
      expect(
        Object.values(persistedBeforeTool.graph.nodes).some(
          (node: any) =>
            Array.isArray(node.allowedTools) &&
            node.allowedTools.includes("create_file") &&
            node.status === "ready" &&
            node.retries?.attempts === 0 &&
            node.evidence?.length === 0,
        ),
      ).toBe(true);

      await page.evaluate(() => {
        (window as typeof window & {
          __e2eReleaseMissionGraphTool?: boolean;
        }).__e2eReleaseMissionGraphTool = true;
      });
      await waitForMissionComplete(page, 120_000);
      await expectFileToContain(
        targetFilePath,
        input.marker,
        "the host-persisted graph should authorize the planned create after release",
      );
      await expectToolRun(page, "create_file");
      await expectReceipt(page, targetPath);
    } finally {
      await page
        .evaluate(() => {
          (window as typeof window & {
            __e2eReleaseMissionGraphTool?: boolean;
          }).__e2eReleaseMissionGraphTool = true;
        })
        .catch(() => undefined);
      await deleteVaultFixture(page, targetPath).catch(() => undefined);
    }
  });
});

test("authoritative MissionGraph rejects an extra mutation without changing protected bytes", async () => {
  test.setTimeout(180_000);
  await withE2EHarness("mission-graph-rejects-extra-mutation", async ({
    page,
    noteFilePath,
    input,
  }) => {
    const allowedPath =
      `E2E Agent Tests/Mission Graph Guard/allowed-${input.marker}.md`;
    const protectedPath =
      `E2E Agent Tests/Mission Graph Guard/protected-${input.marker}.md`;
    const allowedFilePath = path.join(vaultRoot, ...allowedPath.split("/"));
    const protectedFilePath = path.join(vaultRoot, ...protectedPath.split("/"));

    try {
      await deleteVaultFixture(page, allowedPath);
      await deleteVaultFixture(page, protectedPath);
      const noteBefore = await snapshotFileBytes(noteFilePath);
      const protectedBefore = await snapshotFileBytes(protectedFilePath);
      const trashBefore = await snapshotVaultTrash();
      expect(protectedBefore).toBeNull();

      await submitMission(
        page,
        `E2E_MGV3_MALICIOUS_EXTRA ${input.marker}: Create ${allowedPath} with ALLOWED_CREATE:${input.marker}. Only write to that requested file.`,
        { timeout: 120_000 },
      );

      await expectFileToContain(
        allowedFilePath,
        `ALLOWED_CREATE:${input.marker}`,
        "the single explicitly planned create should execute",
      );
      expect((await readFile(allowedFilePath, "utf8")).split(
        `ALLOWED_CREATE:${input.marker}`,
      )).toHaveLength(2);
      expect(await snapshotFileBytes(protectedFilePath)).toEqual(protectedBefore);
      expect(await snapshotFileBytes(noteFilePath)).toEqual(noteBefore);
      expect(await snapshotVaultTrash()).toEqual(trashBefore);

      await page.getByRole("tab", { name: "Run Details" }).click();
      await expect(
        page.locator(".agentic-researcher-details-panel"),
      ).toContainText(
        /(?:mission_graph_authority_blocked|plan_dependency_violation|Deferred create_file|Rejected create_file)/u,
      );
      await expect(
        page.locator(".agentic-researcher-receipt", { hasText: protectedPath }),
      ).toHaveCount(0);

      const missionId = (await missionGraphField(page, "mission_id").textContent())
        ?.replace(/^mission_id=/u, "") ?? "";
      const record = await readPersistedMissionGraphRecord(missionId);
      const createNodes = Object.values(record.graph.nodes).filter(
        (node: any) =>
          Array.isArray(node.allowedTools) && node.allowedTools.includes("create_file"),
      );
      expect(createNodes).toHaveLength(1);
      expect((createNodes[0] as any).retries.attempts).toBe(1);
    } finally {
      await deleteVaultFixture(page, allowedPath).catch(() => undefined);
      await deleteVaultFixture(page, protectedPath).catch(() => undefined);
    }
  });
});

test("plugin restart resumes MissionGraph without replaying a completed write", async () => {
  test.setTimeout(240_000);
  await withE2EHarness(
    "mission-graph-restart-no-write-replay",
    async ({ page, noteFilePath, input }) => {
      const writeMarker = `E2E_MGV3_RESTART_MARKER_${input.marker}`;
      const completionPath =
        `E2E Agent Tests/Mission Graph Guard/restart-complete-${input.marker}.md`;
      const completionFilePath = path.join(
        vaultRoot,
        ...completionPath.split("/"),
      );
      try {
        await createVaultFixture(
          page,
          completionPath,
          `# Restart completion target\n\n${input.secondMarker}\n`,
        );
        await submitMission(
          page,
          [
            `E2E_MGV3_RESTART_WRITE ${input.marker}:`,
            `Append this exact E2E marker to the current note: ${writeMarker}.`,
            `Then append this exact E2E marker to the existing markdown file ${completionPath}: COMPLETE:${input.marker}.`,
          ].join(" "),
          { waitForCompletion: false },
        );

      await expectNoteToContain(
        noteFilePath,
        writeMarker,
        "the first segment should complete its authorized write before restart",
        60_000,
      );
      await page.getByRole("tab", { name: "Run Details" }).click();
      const missionId = (await missionGraphField(page, "mission_id").textContent())
        ?.replace(/^mission_id=/u, "") ?? "";
      expect(missionId).toMatch(/^run-/u);

      await page.getByRole("tab", { name: "Chat" }).click();
      const runButton = page.locator("button.agentic-researcher-run");
      await expect(runButton).toHaveText("Stop Mission", { timeout: 30_000 });
      await runButton.click();
      await page.evaluate(() => {
        (window as typeof window & {
          __e2eHoldMissionGraphRestartAfterWrite?: boolean;
        }).__e2eHoldMissionGraphRestartAfterWrite = false;
      });
      await waitForMissionComplete(page, 60_000);

      await page.getByRole("tab", { name: "Run Details" }).click();
      await expectDetailsText(page, "ledger_can_resume=on");
      await expect(
        page.getByRole("button", { name: "Continue Latest Run" }),
      ).toBeVisible({ timeout: 30_000 });
      const noteBeforeRestart = await snapshotFileBytes(noteFilePath);
      const graphBeforeRestart = await readPersistedMissionGraphRecord(missionId);
      const completedWriteBefore = findMissionGraphToolNode(
        graphBeforeRestart,
        "append_to_current_file",
      );
      expect(completedWriteBefore.status).toBe("complete");
      expect(completedWriteBefore.retries.attempts).toBe(1);
      expect(completedWriteBefore.receipts.length).toBeGreaterThan(0);

      await restartCorePluginWithHarnessMock(page);
      await page.getByRole("tab", { name: "Run Details" }).click();
      await expect(
        page.getByRole("button", { name: "Continue Latest Run" }),
      ).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Continue Latest Run" }).click();
      await waitForMissionComplete(page, 120_000);

      expect(await snapshotFileBytes(noteFilePath)).toEqual(noteBeforeRestart);
      const noteAfterResume = await readFile(noteFilePath, "utf8");
      expect(noteAfterResume.split(writeMarker)).toHaveLength(2);
      await page.getByRole("tab", { name: "Run Details" }).click();
      await expect(missionGraphField(page, "mission_id")).toHaveText(
        `mission_id=${missionId}`,
      );
      const graphAfterResume = await readPersistedMissionGraphRecord(missionId);
      const completedWriteAfter = findMissionGraphToolNode(
        graphAfterResume,
        "append_to_current_file",
      );
      expect({
        status: completedWriteAfter.status,
        attempts: completedWriteAfter.retries.attempts,
        evidence: completedWriteAfter.evidence,
        receipts: completedWriteAfter.receipts,
      }).toEqual({
        status: completedWriteBefore.status,
        attempts: completedWriteBefore.retries.attempts,
        evidence: completedWriteBefore.evidence,
        receipts: completedWriteBefore.receipts,
      });
        await expectDetailsText(page, "ledger_acceptance_status=pass");
        await expectToolRun(page, "append_file");
        await expectFileToContain(
          completionFilePath,
          `COMPLETE:${input.marker}`,
          "the resumed graph should finish only the still-pending path append node",
        );
      } finally {
        await deleteVaultFixture(page, completionPath).catch(() => undefined);
      }
    },
  );
});

test.describe("phase-3 authenticated companion continuation", () => {
  test.describe.configure({ mode: "serial" });

  test("authenticated worker completion reconciles and resumes the same vault node exactly once", async () => {
    test.setTimeout(420_000);
    await withE2EHarness(
      "phase3-companion-restart-replay",
      async ({ page, notePath, noteFilePath, input }) => {
        const worker = await startPhase3AuthenticatedCompanionWorker(input.marker);
        const contract = await createPhase3BackgroundGraph(
          input.marker,
          input.secondMarker,
        );
        const persistence = await persistPhase3MissionContinuation(
          contract.graph,
          notePath,
          input.secondMarker,
        );
        const companionDataPath = path.join(
          vaultRoot,
          ".obsidian",
          "plugins",
          PLUGIN_ID,
          "data.json",
        );
        const installedCompanionBundle = await readFile(
          path.join(
            vaultRoot,
            ".obsidian",
            "plugins",
            PLUGIN_ID,
            "main.js",
          ),
          "utf8",
        );

        expect(installedCompanionBundle).toContain("install-background-service");
        expect(installedCompanionBundle).toContain("connect-background-service");
        expect(installedCompanionBundle).toContain("remove-background-service");
        expect(installedCompanionBundle).toContain("standalone-worker.cjs");
        expect(installedCompanionBundle).toContain("worker-executors.json");

        try {
          const vaultBeforeDisconnect = await snapshotFileIdentity(noteFilePath);
          expect(vaultBeforeDisconnect).not.toBeNull();

          const dispatched = await page.evaluate<any, any>(
            async (payload) => {
              const {
                companionPluginId,
                baseUrl,
                bootstrapToken,
                graph,
                authorization,
              } = payload;
              const app = (window as typeof window & { app?: any }).app;
              const extension = app?.plugins?.plugins?.[payload.corePluginId]
                ?.getBundledCapability?.(companionPluginId);
              if (
                !extension?.pairForegroundCompanion ||
                !extension?.companionCoordinator?.submitAuthorizedNode
              ) {
                throw new Error(
                  "The installed companion production coordinator is unavailable.",
                );
              }
              await extension.pairForegroundCompanion({
                baseUrl,
                acquireBootstrapToken: async () => bootstrapToken,
              });
              const external = await extension.companionCoordinator.submitAuthorizedNode({
                graph,
                nodeId: "research",
                authorization,
              });
              const vault = await extension.companionCoordinator.submitAuthorizedNode({
                graph,
                nodeId: "vault-write",
                authorization,
              });
              const persisted = JSON.stringify((await extension.loadData?.()) ?? {});
              return {
                external,
                vault,
                snapshot: extension.companionCoordinator.snapshot(),
                runtimeState: extension.companionCoordinator.getRuntimeState(),
                persistedContainsBootstrapToken: persisted.includes(bootstrapToken),
              };
            },
            {
              corePluginId: PLUGIN_ID,
              companionPluginId: "agentic-researcher-companion",
              baseUrl: worker.baseUrl,
              bootstrapToken: worker.bootstrapToken,
              graph: contract.graph,
              authorization: contract.authorization,
            },
          );

          expect(dispatched.external.status).toBe("submitted");
          expect(dispatched.vault.status).toBe("waiting_obsidian");
          expect(dispatched.snapshot.configured).toBe(true);
          expect(dispatched.snapshot.health?.coordinatorReady).toBe(true);
          expect(dispatched.snapshot.health?.workerReady).toBe(true);
          expect(dispatched.snapshot.health?.backgroundEnabled).toBe(true);
          expect(dispatched.persistedContainsBootstrapToken).toBe(false);
          expect(worker.submittedBodies).toHaveLength(1);
          expect(dispatched.runtimeState.jobs).toHaveProperty(
            dispatched.external.job.id,
          );
          expect(JSON.stringify(worker.submittedBodies).includes(worker.bootstrapToken)).toBe(
            false,
          );
          expect(JSON.stringify(worker.submittedBodies)).not.toMatch(
            /vault[_-]?(?:path|content)|note[_-]?content/iu,
          );
          if (dispatched.external.status !== "submitted") {
            throw new Error("The external node was not submitted to the companion.");
          }
          const jobId = dispatched.external.job.id;
          await worker.waitForExecutorStarted();

          let coreDisabled = false;
          try {
            await page.evaluate(async ({ corePluginId }) => {
              const app = (window as typeof window & { app?: any }).app;
              if (!app?.plugins?.disablePlugin) {
                throw new Error("Obsidian core plugin disable API is unavailable.");
              }
              await app.plugins.disablePlugin(corePluginId);
            }, { corePluginId: PLUGIN_ID });
            await expect
              .poll(
                () =>
                  page.evaluate(
                    ({ corePluginId }) =>
                      Boolean(
                        (window as typeof window & { app?: any }).app?.plugins
                          ?.plugins?.[corePluginId],
                      ),
                    { corePluginId: PLUGIN_ID },
                  ),
                { timeout: 10_000 },
              )
              .toBe(false);
            coreDisabled = true;

            worker.releaseExecutor();
            const terminal = await worker.waitForTerminal(jobId);
            expect(terminal.state).toBe("complete");
            expect(terminal.output?.resultFingerprint).toMatch(
              /^sha256:[a-f0-9]{64}$/u,
            );
            expect(worker.receiptsFor(jobId)).toHaveLength(1);
            expect(worker.eventsFor(jobId).map((event) => event.type)).toEqual([
              "job_accepted",
              "job_leased",
              "job_started",
              "job_progress",
              "receipt_committed",
              "job_completed",
            ]);

            expect(await snapshotFileIdentity(noteFilePath)).toEqual(
              vaultBeforeDisconnect,
            );
            const disconnectedGraph = await readPersistedMissionGraphRecord(
              contract.graph.missionId,
            );
            expect(disconnectedGraph.graph.nodes.research.status).toBe("ready");
            expect(disconnectedGraph.graph.nodes["vault-write"].status).toBe(
              "queued",
            );

            await restartCorePluginWithHarnessMock(page);
            coreDisabled = false;
            const observed = await page.evaluate<any, any>(
              async (payload) => {
                const {
                  corePluginId,
                  companionPluginId,
                  baseUrl,
                  bootstrapToken,
                  jobId,
                } = payload;
                const extension = (window as typeof window & { app?: any }).app
                  ?.plugins?.plugins?.[corePluginId]
                  ?.getBundledCapability?.(companionPluginId);
                if (
                  !extension?.pairForegroundCompanion ||
                  !extension?.companionCoordinator?.reconcilePersistedJobs
                ) {
                  throw new Error(
                    "The reloaded companion production coordinator is unavailable.",
                  );
                }
                await extension.pairForegroundCompanion({
                  baseUrl,
                  acquireBootstrapToken: async () => bootstrapToken,
                });
                const reconciled = await extension.companionCoordinator.reconcilePersistedJobs();
                const runtimeState = extension.companionCoordinator.getRuntimeState();
                const persisted = JSON.stringify((await extension.loadData?.()) ?? {});
                return {
                  reconciledCount: reconciled.length,
                  lineage: runtimeState.jobs[jobId],
                  persistedContainsBootstrapToken: persisted.includes(bootstrapToken),
                };
              },
              {
                corePluginId: PLUGIN_ID,
                companionPluginId: "agentic-researcher-companion",
                baseUrl: worker.baseUrl,
                bootstrapToken: worker.bootstrapToken,
                jobId,
              },
            );

            expect(observed.reconciledCount).toBe(1);
            expect(observed.lineage.missionId).toBe(contract.graph.missionId);
            expect(observed.lineage.nodeId).toBe("research");
            expect(observed.lineage.lastObservedEventSequence).toBe(6);
            expect(observed.lineage.receiptFingerprints).toHaveLength(1);
            expect(observed.lineage.resultFingerprint).toMatch(
              /^sha256:[a-f0-9]{64}$/u,
            );
            expect(observed.persistedContainsBootstrapToken).toBe(false);
            expect(await readFile(companionDataPath, "utf8")).not.toContain(
              worker.bootstrapToken,
            );
            expect(await snapshotFileIdentity(noteFilePath)).toEqual(
              vaultBeforeDisconnect,
            );

            await expect
              .poll(
                async () => {
                  const record = await readPersistedMissionGraphRecord(
                    contract.graph.missionId,
                  );
                  return {
                    research: record.graph.nodes.research.status,
                    vault: record.graph.nodes["vault-write"].status,
                  };
                },
                {
                  message: "core startup should reconcile proof and promote the same vault node",
                  timeout: 45_000,
                },
              )
              .toEqual({ research: "complete", vault: "ready" });

            await expect
              .poll(
                () =>
                  page.evaluate<any, any>(
                    ({ corePluginId, companionPluginId, jobId }) => {
                      const extension = (
                        window as typeof window & { app?: any }
                      ).app?.plugins?.plugins?.[corePluginId]
                        ?.getBundledCapability?.(companionPluginId);
                      const lineage = extension?.companionCoordinator
                        ?.getRuntimeState?.().jobs?.[jobId];
                      return {
                        observed: lineage?.lastObservedEventSequence ?? null,
                        applied: lineage?.lastAppliedEventSequence ?? null,
                      };
                    },
                    {
                      corePluginId: PLUGIN_ID,
                      companionPluginId: "agentic-researcher-companion",
                      jobId,
                    },
                  ),
                {
                  message:
                    "the unified Companion capability should durably apply the terminal cursor",
                  timeout: 30_000,
                },
              )
              .toEqual({ observed: 6, applied: 6 });

            const reconciledGraph = await readPersistedMissionGraphRecord(
              contract.graph.missionId,
            );
            const reconciledRuntime = await readMissionRuntimeSnapshotByRunId(
              createPhase3FilesystemToolContext(
                "Read back the reconciled Phase-3 runtime reference.",
              ),
              contract.graph.missionId,
            );
            expect(reconciledRuntime?.snapshot.missionGraphRef).toEqual({
              version: 1,
              missionId: reconciledGraph.missionId,
              path: persistence.graphPath,
              storeRevision: reconciledGraph.storeRevision,
              graphRevision: reconciledGraph.graph.revision,
              recordFingerprint: reconciledGraph.recordFingerprint,
              journalHeadFingerprint:
                reconciledGraph.graph.journalHeadFingerprint,
            });
            await expect
              .poll(
                () =>
                  page.evaluate(({ corePluginId }) => {
                    const plugin = (window as typeof window & { app?: any }).app
                      ?.plugins?.plugins?.[corePluginId];
                    const snapshot = plugin?.getMissionRunSnapshot?.();
                    return {
                      runId: snapshot?.runId ?? null,
                      graphMissionId:
                        snapshot?.lastMissionGraph?.missionId ?? null,
                      ledgerRunId:
                        snapshot?.lastMissionLedger?.runId ?? null,
                      canResume:
                        snapshot?.lastMissionLedger?.canResume ?? false,
                    };
                  }, { corePluginId: PLUGIN_ID }),
                {
                  message:
                    "core should hydrate the exact reconciled runtime projection",
                  timeout: 30_000,
                },
              )
              .toEqual({
                runId: contract.graph.missionId,
                graphMissionId: contract.graph.missionId,
                ledgerRunId: contract.graph.missionId,
                canResume: true,
              });

            await page.evaluate(({ corePluginId }) => {
              const plugin = (window as typeof window & { app?: any }).app
                ?.plugins?.plugins?.[corePluginId];
              const view = plugin?.activeAgentView;
              if (!view?.refreshDurableMissionProjection) {
                throw new Error(
                  "The mounted AgentView durable-projection refresh seam is unavailable.",
                );
              }
              // Reproduce an in-place reconciliation while the panel still
              // carries another run's view-local config and receipt DOM.
              view.runConfig = { runId: "stale-panel-run" };
              view.appendReceipt({
                runId: "stale-panel-run",
                toolName: "stale_receipt",
                operation: "read",
                message: "STALE_PANEL_RECEIPT",
              });
              view.refreshDurableMissionProjection();
            }, { corePluginId: PLUGIN_ID });
            await expect(
              page.locator(".agentic-researcher-dashboard-section-model-config"),
            ).toContainText(`run_id=${contract.graph.missionId}`);
            await expect(
              page.locator(
                '.agentic-researcher-receipt[data-run-id="stale-panel-run"]',
              ),
            ).toHaveCount(0);

            await page.getByRole("tab", { name: "Run Details" }).click();
            await expect(
              page.getByRole("button", { name: "Continue Latest Run" }),
            ).toBeVisible({ timeout: 30_000 });
            await page.getByRole("button", { name: "Continue Latest Run" }).click();
            await waitForMissionComplete(page, 120_000);
            await expectNoteToContain(
              noteFilePath,
              input.secondMarker,
              "the original host-bound graph node should execute after core reconnect",
            );
            const noteAfterResume = await readFile(noteFilePath, "utf8");
            expect(noteAfterResume.split(input.secondMarker)).toHaveLength(2);

            const completedGraph = await readPersistedMissionGraphRecord(
              contract.graph.missionId,
            );
            const completedVaultNode = completedGraph.graph.nodes["vault-write"];
            expect(completedVaultNode.status).toBe("complete");
            expect(completedVaultNode.retries.attempts).toBe(1);
            expect(completedVaultNode.receipts).toHaveLength(1);
            expect(completedGraph.graph.nodes.research.receipts).toHaveLength(1);
            const completedIdentity = await snapshotFileIdentity(noteFilePath);

            await restartCorePluginWithHarnessMock(page);
            await page.waitForTimeout(5_000);
            expect(await snapshotFileIdentity(noteFilePath)).toEqual(completedIdentity);
            const replaySafeGraph = await readPersistedMissionGraphRecord(
              contract.graph.missionId,
            );
            expect({
              revision: replaySafeGraph.graph.revision,
              research: replaySafeGraph.graph.nodes.research,
              vault: replaySafeGraph.graph.nodes["vault-write"],
            }).toEqual({
              revision: completedGraph.graph.revision,
              research: completedGraph.graph.nodes.research,
              vault: completedGraph.graph.nodes["vault-write"],
            });
          } finally {
            if (coreDisabled) {
              await restartCorePluginWithHarnessMock(page).catch(() => undefined);
            }
          }
        } finally {
          await worker.close();
          await deleteVaultFixture(page, persistence.graphPath).catch(() => undefined);
          const phase3RunPaths = await page
            .evaluate(async ({ missionId, writeMarker }) => {
              const app = (window as typeof window & { app?: any }).app;
              const files =
                typeof app?.vault?.getFiles === "function" ? app.vault.getFiles() : [];
              const matches: string[] = [];
              for (const file of files) {
                if (!/^Agent Runs\/[^/]+\.md$/iu.test(file.path ?? "")) continue;
                const content = await app.vault.cachedRead(file);
                if (content.includes(missionId) && content.includes(writeMarker)) {
                  matches.push(file.path);
                }
              }
              return matches;
            }, {
              missionId: contract.graph.missionId,
              writeMarker: input.secondMarker,
            })
            .catch(() => [persistence.runPath]);
          for (const runPath of phase3RunPaths) {
            await deleteVaultFixture(page, runPath).catch(() => undefined);
          }
        }
      },
    );
  });
});

test("autonomous loop respects bounded tool budget and checkpoints", async () => {
  test.setTimeout(900_000);
  await withE2EHarness("autonomous-loop-depth", async ({ page }) => {
    await setStreamingMode(page, false);

    for (const steps of [1, 5, 10, 15, 30, 60, 100]) {
      // Four steps remain reserved for finalization, while MissionGraphV3's
      // 16-node ceiling can force synthesis earlier for deliberately
      // pathological repeated-read prompts.
      const visibleStep = Math.min(Math.max(1, steps - 3), 16);
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
          hasText: `Step ${visibleStep}/${steps}`,
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.locator(".agentic-researcher-dashboard-section-status", {
          hasText: `Agent step ${visibleStep} of max ${steps}`,
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.locator(".agentic-researcher-dashboard-section-planning", {
          hasText: "finalization_reserved=4",
        }),
      ).toBeVisible({ timeout: 30_000 });
      if (steps > 1) {
        await expectToolRun(page, "get_note_graph_context");
      }
      const latestCheckpointStep = Math.floor(visibleStep / 5) * 5;
      if (latestCheckpointStep >= 5) {
        await expectLatestAgentCheckpoint(page, `- Step: ${latestCheckpointStep} of`);
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
      "Draw E2E_DESIGN_CANVAS as an Obsidian canvas software architecture diagram for the agent user flow.",
    );
    await expectFileToContain(
      canvasFilePath,
      '"nodes"',
      "canvas artifact should contain JSON Canvas nodes",
    );
    await expectFileToContain(
      canvasFilePath,
      "Agent Architecture",
      "canvas artifact should include the requested architecture title",
    );
    await expectFileToContain(
      canvasFilePath,
      "Tool Registry",
      "canvas artifact should include architecture components",
    );
    await expectFileToContain(
      canvasFilePath,
      "safe write",
      "canvas artifact should include labeled architecture connections",
    );
    await expectToolRun(page, "create_design_canvas");
    await expectDetailsText(page, "Canvas architecture planned");
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
    await expectFileToContain(
      svgFilePath,
      "<polygon",
      "svg artifact should include decision diamond markup",
    );
    await expectFileToContain(
      svgFilePath,
      "Model API",
      "svg artifact should include architecture ellipse label",
    );
    await expectToolRun(page, "create_svg_design");
    await expectDetailsText(page, "SVG design planned");
    await expectReceipt(page, input.designSvgPath);
    await expectVerification(page, "SVG verified");
  });
});

test("design graph conversion creates a native canvas instead of appending a render disclaimer", async () => {
  test.setTimeout(240_000);
  await withE2EHarness(
    "design-graph-conversion",
    async ({ page, noteFilePath, input }) => {
      const canvasFilePath = path.join(
        vaultRoot,
        ...input.designCanvasPath.split("/"),
      );

      await submitMission(
        page,
        "E2E_DESIGN_GRAPH I want this five-law flow map to be on an Obsidian Canvas.",
        { timeout: 120_000 },
      );

      await expectFileToContain(
        canvasFilePath,
        '"nodes"',
        "design graph conversion should create JSON Canvas nodes",
      );
      for (const term of [
        "Power & Control",
        "Never Outshine the Master",
        "Conceal Your Intentions",
        "Guard Your Reputation",
      ]) {
        await expectFileToContain(
          canvasFilePath,
          term,
          `design graph should contain ${term}`,
        );
      }
      await expectToolRun(page, "create_design_canvas");
      await expectReceipt(page, input.designCanvasPath);
      await expectVerification(page, "Canvas verified");

      const canvasView = page.locator(
        '.workspace-leaf-content[data-type="canvas"]',
      ).last();
      await expect(canvasView).toBeVisible({ timeout: 30_000 });
      await expect(canvasView.locator(".canvas-node")).toHaveCount(7, {
        timeout: 30_000,
      });
      // Obsidian intentionally elides text-node bodies when a larger Canvas is
      // zoomed to fit, while retaining edge labels in the mounted DOM. The
      // file assertions above prove the requested semantic labels; this check
      // proves the native Canvas opened with its visible relationship layer.
      await expect(canvasView).toContainText("requires");
      await expectRenderedScreenshotState(canvasView, "design-graph-canvas-render", {
        minimumWidth: 240,
        minimumHeight: 160,
      });

      const currentNote = (await readOptionalFile(noteFilePath)) ?? "";
      expect(currentNote).not.toContain("Since I cannot render a visual image");
    },
  );
});

test("government branch diagram creates and opens a native canvas", async () => {
  test.setTimeout(240_000);
  await withE2EHarness(
    "government-branch-canvas",
    async ({ page, input }) => {
      const canvasFilePath = path.join(
        vaultRoot,
        ...input.designCanvasPath.split("/"),
      );

      await submitMission(
        page,
        "E2E_GOVERNMENT_BRANCH_CANVAS Can you draw me a diagram of the United States branches of government?",
        { timeout: 120_000 },
      );

      for (const term of ["Legislative", "Executive", "Judicial"]) {
        await expectFileToContain(
          canvasFilePath,
          term,
          `government canvas should contain ${term}`,
        );
      }
      await expectFileToContain(
        canvasFilePath,
        "_branch_",
        "government canvas should preserve branch visual metadata",
      );
      await expectToolRun(page, "create_design_canvas");
      await expectReceipt(page, input.designCanvasPath);
      await expectVerification(page, "Canvas verified");

      const canvasView = page.locator(
        '.workspace-leaf-content[data-type="canvas"]',
      ).last();
      await expect(canvasView).toBeVisible({ timeout: 30_000 });
      await expect(canvasView).toContainText("Legislative");
      await expect(canvasView).toContainText("Executive");
      await expect(canvasView).toContainText("Judicial");
    },
  );
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
    const beforeReplacement = await readFile(noteFilePath, "utf8");
    await submitMission(
      page,
      `I want you to delete all the notes on the page and then write a 300 word essay on the renaissance containing ${input.replaceMarker}.`,
      { waitForCompletion: false },
    );
    await page.getByRole("tab", { name: "Run Details" }).click();
    const replacementApproval = activePreparedApproval(
      page,
      "replace_current_file",
    );
    await expect(replacementApproval).toBeVisible({
      timeout: GENERATED_WRITING_E2E_TIMEOUT_MS,
    });
    expect(await readFile(noteFilePath, "utf8")).toBe(beforeReplacement);
    await approvePreparedApproval(page, replacementApproval);
    await waitForMissionComplete(page, GENERATED_WRITING_E2E_TIMEOUT_MS);

    await expectNoteToContain(
      noteFilePath,
      input.replaceMarker,
      "replace-current-page should write replacement content",
    );
    const replacedContent = await readFile(noteFilePath, "utf8");
    expect(replacedContent).not.toContain(input.secondMarker);
    expect(replacedContent).toMatch(/Renaissance/i);
    expect(replacedContent).toMatch(/humanism/i);
    expect(
      countWords(replacedContent),
      "replace-current-page should write a substantial Renaissance essay",
    ).toBeGreaterThanOrEqual(270);
    await expectReceipt(page, "replace");
    await expectReceipt(page, ".agent-backups");
  });
});

test("delete current note then write replaces without safety-limit stop", async () => {
  await withE2EHarness(
    "delete-current-note-write",
    async ({ page, notePath, noteFilePath, input }) => {
      const oldMarker = `E2E_DELETE_CURRENT_OLD_${input.marker}`;
      const replacementMarker = `E2E_DELETE_CURRENT_WRITE_${input.marker}`;
      await setActiveNoteContent(page, notePath, `# Old E2E Page\n\n${oldMarker}\n`);
      await setStreamingMode(page, false);
      const beforeReplacement = await readFile(noteFilePath, "utf8");
      await submitMission(
        page,
        `Delete the current note. Ensure that the space is empty. I want you to write now, a 300 word essay on Grapes of Wrath. Include ${replacementMarker}.`,
        { waitForCompletion: false },
      );
      await page.getByRole("tab", { name: "Run Details" }).click();
      const replacementApproval = activePreparedApproval(
        page,
        "replace_current_file",
      );
      await expect(replacementApproval).toBeVisible({
        timeout: GENERATED_WRITING_E2E_TIMEOUT_MS,
      });
      expect(await readFile(noteFilePath, "utf8")).toBe(beforeReplacement);
      await approvePreparedApproval(page, replacementApproval);
      await waitForMissionComplete(page, GENERATED_WRITING_E2E_TIMEOUT_MS);

      await expectNoteToContain(
        noteFilePath,
        replacementMarker,
        "delete-current-note write should write replacement content",
      );
      await expectNoteToContain(
        noteFilePath,
        "Grapes",
        "delete-current-note write should stay on topic",
        GENERATED_WRITING_E2E_TIMEOUT_MS,
        { ignoreCase: true },
      );
      await expectNoteToContain(
        noteFilePath,
        "Wrath",
        "delete-current-note write should stay on topic",
        GENERATED_WRITING_E2E_TIMEOUT_MS,
        { ignoreCase: true },
      );
      const replacedContent = await readFile(noteFilePath, "utf8");
      expect(replacedContent).not.toContain(oldMarker);
      expect(
        countWords(replacedContent),
        "delete-current-note write should produce a substantial Grapes of Wrath essay",
      ).toBeGreaterThanOrEqual(270);
      await expectToolRun(page, "replace_current_file");
      await expectReceipt(page, "replace");
      await expectReceipt(page, ".agent-backups");
      await expectNoSafetyLimit(page);
    },
  );
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

    const beforeReplacement = await readFile(noteFilePath, "utf8");
    await submitMission(page, "Go ahead and revise", {
      waitForCompletion: false,
    });
    await page.getByRole("tab", { name: "Run Details" }).click();
    const replacementApproval = activePreparedApproval(
      page,
      "replace_current_file",
    );
    await expect(replacementApproval).toBeVisible({
      timeout: GENERATED_WRITING_E2E_TIMEOUT_MS,
    });
    expect(await readFile(noteFilePath, "utf8")).toBe(beforeReplacement);
    await approvePreparedApproval(page, replacementApproval);
    await waitForMissionComplete(page, GENERATED_WRITING_E2E_TIMEOUT_MS);

    await expectNoteToContain(
      noteFilePath,
      input.revisionMarker,
      "revision follow-up should write replacement content",
    );
    const replacedContent = await readFile(noteFilePath, "utf8");
    expect(replacedContent).not.toContain(input.secondMarker);
    await expectBackupToContain(
      page,
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

test("direct current-note writeback hands the output contract to the model as a user turn", async () => {
  test.setTimeout(180_000);
  await withE2EHarness(
    "direct-user-role-writeback",
    async ({ page, noteFilePath, input }) => {
      await setStreamingMode(page, true);
      const marker = `E2E_DIRECT_USER_ROLE_WRITEBACK_${input.marker}`;

      await submitMission(
        page,
        `Write a short project status update on this current note and include ${marker}.`,
        { timeout: GENERATED_WRITING_E2E_TIMEOUT_MS },
      );

      await expectNoteToContain(
        noteFilePath,
        marker,
        "direct note writeback should receive and persist the user-role output handoff",
        GENERATED_WRITING_E2E_TIMEOUT_MS,
      );
      await expectReceipt(page, "append");
      await expectNoSafetyLimit(page);
    },
  );
});

test.describe("real ai generated output", () => {
  test("Kimi writes the requested summary onto the page and retitles the note", async () => {
    test.skip(
      !shouldRunRealAiE2E(),
      "Set E2E_REAL_AI=1 and E2E_AI_MODE=real to run the Kimi page-writeback proof. Credentials are read from the plugin unless E2E_OLLAMA_API_KEY overrides them.",
    );
    test.setTimeout(1_200_000);
    const kimiConfig: E2EAiConfig = {
      ...getE2EAiConfig(),
      model: "kimi-k2.6:cloud",
    };

    await withE2EHarness(
      "real-ai-kimi-page-writeback",
      async ({ page, notePath, input }) => {
        await setStreamingMode(page, true, {
          aiConfig: kimiConfig,
          aiMode: "real",
        });

        const renameTitle = `Kimi First Five Laws ${Date.now()}`;
        const renamedNotePath = `${notePath.slice(
          0,
          notePath.lastIndexOf("/") + 1,
        )}${renameTitle}.md`;
        const renamedFilePath = path.join(
          vaultRoot,
          ...renamedNotePath.split("/"),
        );
        const originalFilePath = path.join(vaultRoot, ...notePath.split("/"));
        const marker = `${input.marker}_KIMI_PAGE_WRITEBACK`;
        const prompt = [
          "Write a concise summary of the first five laws in Robert Greene's book The 48 Laws of Power.",
          `Retitle the current document exactly to \"${renameTitle}\" and generate the summary onto the active page.`,
          `Include the exact verification marker ${marker} as its own final line.`,
        ].join(" ");

        await submitMission(page, prompt, {
          timeout: kimiConfig.missionTimeoutMs,
          assertMock: false,
        });

        await expectFileToContain(
          renamedFilePath,
          marker,
          "Kimi should stream the requested summary into the renamed active note",
          kimiConfig.completionTimeoutMs,
        );
        await expectFileToBeAbsent(
          originalFilePath,
          "the original path should be gone after Kimi retitles the current note",
          kimiConfig.completionTimeoutMs,
        );
        const written = (await readOptionalFile(renamedFilePath)) ?? "";
        expect(written.toLowerCase()).toContain("outshine");
        expect(written.toLowerCase()).toContain("reputation");
        expect(written.length).toBeGreaterThan(300);
        await expect(
          page.locator(
            ".workspace-tab-header.is-active .workspace-tab-header-inner-title, .workspace-leaf.mod-active .view-header-title",
            { hasText: renameTitle },
          ).first(),
        ).toBeVisible({ timeout: kimiConfig.completionTimeoutMs });
        await expectToolRun(page, "rename_current_file");
        await expectReceipt(page, "rename_current_file");
        await expectReceipt(page, "append");
        await expectDetailsText(page, "model=kimi-k2.6:cloud");
        await expectDetailsText(page, "ledger_status=complete");
        await expectNoSafetyLimit(page);
      },
      {
        aiMode: "real",
        aiConfig: kimiConfig,
      },
    );
  });

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
  designMermaidPath: string;
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

const DEFAULT_E2E_MISSION_TIMEOUT_MS = 60_000;
const GENERATED_WRITING_E2E_TIMEOUT_MS = 240_000;

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
  const ownedArtifactsBefore = await snapshotOwnedE2EArtifacts(vaultRoot);
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
    const trustVaultButton = page.getByRole("button", {
      name: "Trust author and enable plugins",
    });
    const trustDisposableVaultIfPrompted = async (): Promise<boolean> => {
      if (!(await trustVaultButton.isVisible().catch(() => false))) {
        return false;
      }
      if (process.env.E2E_TRUST_DISPOSABLE_VAULT !== "1") {
        throw new Error(
          "Obsidian opened this vault in Restricted Mode. Set E2E_TRUST_DISPOSABLE_VAULT=1 only for a controlled disposable vault containing trusted local plugin artifacts.",
        );
      }
      await trustVaultButton.click();
      await expect(trustVaultButton).toBeHidden({ timeout: 30_000 });
      return true;
    };
    await trustDisposableVaultIfPrompted();
    const aiConfig = options.aiConfig ?? getE2EAiConfig();
    const aiMode = options.aiMode ?? aiConfig.mode;
    const setupDiagnostics: string[] = [];
    const captureConsole = (message: { type(): string; text(): string }) => {
      if (
        setupDiagnostics.length < 20 &&
        ["warning", "error"].includes(message.type())
      ) {
        setupDiagnostics.push(`${message.type()}: ${message.text()}`);
      }
    };
    const capturePageError = (error: Error) => {
      if (setupDiagnostics.length < 20) {
        setupDiagnostics.push(`pageerror: ${error.message}`);
      }
    };
    page.on("console", captureConsole);
    page.on("pageerror", capturePageError);
    let setupResult: { activeFilePath: string; pluginId: string };
    try {
      try {
        setupResult = await setupVaultNoteAndMockModel(
          page,
          input,
          aiMode,
          aiConfig,
          options.semanticEmbeddingConfig ?? getE2ESemanticEmbeddingConfig(),
        );
      } catch (error) {
        // A first-open prompt can mount after the renderer's CDP endpoint and
        // plugin manager become visible. Retry setup only when the explicitly
        // authorized disposable-vault prompt actually appeared.
        if (!(await trustDisposableVaultIfPrompted())) {
          throw error;
        }
        setupResult = await setupVaultNoteAndMockModel(
          page,
          input,
          aiMode,
          aiConfig,
          options.semanticEmbeddingConfig ?? getE2ESemanticEmbeddingConfig(),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}; renderer setup diagnostics=${JSON.stringify(
          setupDiagnostics,
        )}`,
      );
    } finally {
      page.off("console", captureConsole);
      page.off("pageerror", capturePageError);
    }

    expect(setupResult.activeFilePath).toBe(input.notePath);
    expect(setupResult.pluginId).toBe(PLUGIN_ID);
    await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(page.getByRole("tab", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Run Details" })).toBeVisible();
    await expect(page.locator("textarea.agentic-researcher-prompt")).toBeVisible();
    if (aiMode === "mock") {
      await assertHarnessMockReady(page);
    } else {
      await assertHarnessRealAiReady(page, aiConfig);
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
    let teardownError: unknown = null;
    try {
      await terminateObsidian(obsidianProcess);
    } catch (error) {
      teardownError = error;
    }
    await browser?.close().catch(() => undefined);
    try {
      await restoreOwnedE2EArtifacts(ownedArtifactsBefore);
      await restoreOptionalFile(obsidianAppStatePath, obsidianAppStateBefore);
      await restoreOptionalFile(pluginDataPath, dataBefore);
      await restoreOptionalFile(communityPluginsPath, communityPluginsBefore);
    } catch (error) {
      teardownError ??= error;
    }
    if (teardownError) {
      throw teardownError;
    }
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
    designMermaidPath: `Designs/e2e-mermaid-flow-${id}.md`,
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

  await waitForMissionComplete(
    page,
    options.timeout ?? inferMissionCompletionTimeout(prompt),
  );
  if (options.assertMock !== false) {
    await assertMockModelUsed(page);
  }
  await page.getByRole("tab", { name: "Chat" }).click();
}

function inferMissionCompletionTimeout(prompt: string): number {
  if (
    /\b(write|generate|draft|compose)\b[\s\S]{0,80}\b(essay|article|explanation|guide|story|report)\b/i.test(
      prompt,
    ) ||
    /\b\d{2,5}[\s-]*word\b/i.test(prompt) ||
    /\b(delete|clear|replace)\b[\s\S]{0,100}\b(write|generate|draft|compose)\b/i.test(
      prompt,
    )
  ) {
    return GENERATED_WRITING_E2E_TIMEOUT_MS;
  }

  return DEFAULT_E2E_MISSION_TIMEOUT_MS;
}

async function waitForMissionComplete(page: Page, timeout = 60_000) {
  const runButton = page.locator("button.agentic-researcher-run");
  await expect(runButton).toHaveText("Run Mission", { timeout });
  await expect(runButton).toBeEnabled();
  await expect(page.locator(".agentic-researcher-run-status-text")).toHaveText(
    "Idle",
  );
}

function activePreparedApproval(page: Page, toolName: string): Locator {
  return page
    .locator(".agentic-researcher-approval-card", { hasText: toolName })
    .filter({
      has: page.locator(
        "button.agentic-researcher-approval-approve:enabled",
      ),
    })
    .last();
}

async function approvePreparedApproval(
  page: Page,
  approval: Locator,
): Promise<void> {
  const approvalText = (await approval.textContent()) ?? "";
  const approvalFingerprint = approvalText.match(
    /fingerprint=(sha256:[a-f0-9]{17})/u,
  )?.[1];
  expect(approvalFingerprint).toBeTruthy();
  const approvedCards = page
    .locator(".agentic-researcher-approval-card")
    .filter({ hasText: approvalFingerprint! })
    .filter({ hasText: "decision=approved" });
  const approvedBefore = await approvedCards.count();
  await approval
    .locator("button.agentic-researcher-approval-approve:enabled")
    .click();
  await expect
    .poll(() => approvedCards.count(), { timeout: 5_000 })
    .toBeGreaterThan(approvedBefore);
}

function missionGraphField(page: Page, key: string) {
  return page.locator(`[data-mission-field="${key}"]`);
}

async function restartCorePluginWithHarnessMock(page: Page) {
  await page.evaluate(async ({ pluginId }) => {
    const obsidianWindow = window as typeof window & {
      app?: any;
      __e2eInstallAgentMockOverrides?: (() => void) | null;
    };
    const app = obsidianWindow.app;
    const reinstallMock = obsidianWindow.__e2eInstallAgentMockOverrides;
    if (!app?.plugins || typeof reinstallMock !== "function") {
      throw new Error("Core plugin restart harness is unavailable.");
    }
    if (typeof app.plugins.disablePlugin !== "function") {
      throw new Error("Obsidian disablePlugin API is unavailable.");
    }
    if (typeof app.plugins.enablePlugin !== "function") {
      throw new Error("Obsidian enablePlugin API is unavailable.");
    }

    await app.plugins.disablePlugin(pluginId);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (!app.plugins.plugins?.[pluginId]) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (app.plugins.plugins?.[pluginId]) {
      throw new Error("Core plugin did not unload during restart coverage.");
    }

    await app.plugins.enablePlugin(pluginId);
    let restartedPlugin: any = null;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      restartedPlugin = app.plugins.plugins?.[pluginId] ?? null;
      if (restartedPlugin?.agenticResearcherApi?.state === "ready") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (restartedPlugin?.agenticResearcherApi?.state !== "ready") {
      throw new Error(
        `Core plugin did not become ready after restart: ${String(
          restartedPlugin?.agenticResearcherApi?.state ?? "missing",
        )}`,
      );
    }

    reinstallMock();
    await restartedPlugin.activateView?.();
    reinstallMock();
  }, { pluginId: PLUGIN_ID });

  await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.getByRole("tab", { name: "Run Details" })).toBeVisible();
  await assertHarnessMockReady(page);
}

async function readPendingPreparedApproval(
  page: Page,
  toolName: string,
  confirmationIndex: number,
): Promise<{
  requestId: string;
  preparedActionId: string;
  payloadFingerprint: string;
}> {
  const readPending = () =>
    page.evaluate(
      ({ pluginId, requestedToolName, requestedConfirmationIndex }) => {
        const obsidianWindow = window as typeof window & { app?: any };
        const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
        const pending = plugin?.approvalBroker?.getPending?.() ?? [];
        const request = pending.find(
          (candidate: any) =>
            candidate?.toolName === requestedToolName &&
            (candidate?.confirmationIndex ?? 1) === requestedConfirmationIndex,
        );
        const prepared = request?.preparedAction;
        return request && prepared
          ? {
              requestId: String(request.id ?? ""),
              preparedActionId: String(prepared.id ?? ""),
              payloadFingerprint: String(prepared.payloadFingerprint ?? ""),
            }
          : null;
      },
      {
        pluginId: PLUGIN_ID,
        requestedToolName: toolName,
        requestedConfirmationIndex: confirmationIndex,
      },
    );

  await expect
    .poll(readPending, {
      message: `pending ${toolName} approval ${confirmationIndex} should retain its prepared identity`,
      timeout: 10_000,
    })
    .not.toBeNull();
  const identity = await readPending();
  expect(identity).not.toBeNull();
  expect(identity?.requestId).not.toBe("");
  expect(identity?.preparedActionId).not.toBe("");
  expect(identity?.payloadFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  return identity!;
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
            ollamaBaseUrl: plugin?.settings?.ollamaBaseUrl ?? "",
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
      ollamaBaseUrl: "http://127.0.0.1:11434",
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
  options: { ignoreCase?: boolean } = {},
) {
  await expectFileToContain(noteFilePath, expected, message, timeout, options);
}

function countPlainWords(text: string): number {
  return (text.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g) ?? []).length;
}

async function expectFileToContain(
  filePath: string,
  expected: string,
  message: string,
  timeout = 15_000,
  options: { ignoreCase?: boolean } = {},
) {
  await expect
    .poll(async () => {
      const content = (await readOptionalFile(filePath)) ?? "";
      return options.ignoreCase ? content.toLocaleLowerCase() : content;
    }, {
      message,
      timeout,
    })
    .toContain(options.ignoreCase ? expected.toLocaleLowerCase() : expected);
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
  page: Page,
  expected: string,
  message: string,
  timeout = 15_000,
) {
  await page.getByRole("tab", { name: "Run Details" }).click();
  const backupReceipts = page.locator(".agentic-researcher-receipt", {
    hasText: ".agent-backups/",
  });
  await expect(backupReceipts.first()).toBeVisible({ timeout });
  await expect
    .poll(
      async () => {
        const receiptText = (await backupReceipts.allTextContents()).join("\n");
        const relativePaths = [
          ...new Set(
            [...receiptText.matchAll(/\.agent-backups\/[^;\r\n]+?\.(?:md|canvas|svg)/giu)]
              .map((match) => match[0].trim().replace(/\\/gu, "/")),
          ),
        ].slice(-16);
        for (const relativePath of relativePaths.reverse()) {
          const segments = relativePath.split("/");
          if (
            segments[0] !== ".agent-backups" ||
            segments.some((segment) => !segment || segment === "." || segment === "..")
          ) {
            continue;
          }
          const absolutePath = path.resolve(vaultRoot, ...segments);
          const relativeToVault = path.relative(vaultRoot, absolutePath);
          if (
            !relativeToVault ||
            relativeToVault.startsWith("..") ||
            path.isAbsolute(relativeToVault)
          ) {
            continue;
          }
          const content = await readOptionalFile(absolutePath);
          if (content?.includes(expected)) return true;
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
  const receipt = page.locator(".agentic-researcher-receipt", { hasText: text }).first();
  try {
    await expect(receipt).toBeVisible({ timeout: 5_000 });
    return;
  } catch (error) {
    const ledger = await readLatestMissionLedger(page);
    if (ledger?.content.includes(text)) {
      return;
    }
    throw error;
  }
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

async function expectDetailsText(page: Page, text: string) {
  await page.getByRole("tab", { name: "Run Details" }).click();
  await expect(
    page.locator(".agentic-researcher-details-panel", { hasText: text }).first(),
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
        { ignoreCase: true },
      );
    }
    const afterNoteContent = (await readOptionalFile(noteFilePath)) ?? "";
    const newText = getNewlyGeneratedText(beforeNoteContent, afterNoteContent);
    if (scenario.name === "grapes-stream-title") {
      expect(afterNoteContent).toMatch(/^# Harvest of Injustice/m);
      expect(afterNoteContent).not.toMatch(/^# Untitled/m);
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
    designMermaidPath,
    notePath,
    pluginId,
    aiMode,
    aiConfig,
    semanticEmbeddingConfig,
  }) => {
    const obsidianWindow = window as typeof window & {
      app?: any;
      __e2eAllowViewReattachCompletion?: boolean;
      __e2eViewReattachActive?: boolean;
      __e2eOvernightClockAdvanced?: boolean;
      __e2eRestoreOvernightClock?: (() => void) | null;
      __e2eReleaseMissionGraphTool?: boolean;
      __e2eHoldMissionGraphRestartAfterWrite?: boolean;
      __e2eInstallAgentMockOverrides?: (() => void) | null;
    };
    obsidianWindow.__e2eRestoreOvernightClock?.();
    obsidianWindow.__e2eRestoreOvernightClock = null;
    obsidianWindow.__e2eOvernightClockAdvanced = false;
    obsidianWindow.__e2eAllowViewReattachCompletion = false;
    obsidianWindow.__e2eViewReattachActive = false;
    obsidianWindow.__e2eReleaseMissionGraphTool = false;
    obsidianWindow.__e2eHoldMissionGraphRestartAfterWrite = true;
    obsidianWindow.__e2eInstallAgentMockOverrides = null;
    const app = obsidianWindow.app;
    if (!app?.vault || !app?.workspace || !app?.plugins) {
      throw new Error("Obsidian app API is unavailable.");
    }

    // A disposable vault can connect over CDP before Obsidian has finished
    // laying out the root split and initializing the community plugin loader.
    // Wait for that boundary before attempting an explicit plugin enable.
    await waitForWorkspaceReady(app);
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

    // Close stale markdown/empty tabs persisted from prior e2e sessions so the
    // tab strip stays small enough for tab-title visibility assertions. Always
    // keep at least one leaf so the root tab group is not destroyed.
    const staleMarkdownLeaves =
      typeof app.workspace.getLeavesOfType === "function"
        ? app.workspace.getLeavesOfType("markdown")
        : [];
    const retainedMarkdownLeaf =
      staleMarkdownLeaves.find(
        (leaf: any) => leaf?.view?.containerEl?.isConnected,
      ) ?? staleMarkdownLeaves[0] ?? null;
    for (const staleLeaf of staleMarkdownLeaves) {
      if (staleLeaf !== retainedMarkdownLeaf) {
        staleLeaf.detach?.();
      }
    }
    const staleEmptyLeaves =
      typeof app.workspace.getLeavesOfType === "function"
        ? app.workspace.getLeavesOfType("empty")
        : [];
    const retainedEmptyLeaf = retainedMarkdownLeaf
      ? null
      : staleEmptyLeaves.find(
          (leaf: any) => leaf?.view?.containerEl?.isConnected,
        ) ?? staleEmptyLeaves[0] ?? null;
    for (const staleLeaf of staleEmptyLeaves) {
      if (staleLeaf !== retainedEmptyLeaf) {
        staleLeaf.detach?.();
      }
    }
    const markdownLeaves =
      typeof app.workspace.getLeavesOfType === "function"
        ? app.workspace.getLeavesOfType("markdown")
        : [];
    const emptyLeaves =
      typeof app.workspace.getLeavesOfType === "function"
        ? app.workspace.getLeavesOfType("empty")
        : [];
    let noteLeaf =
      markdownLeaves.find(
        (leaf: any) => leaf?.view?.containerEl?.isConnected,
      ) ??
      emptyLeaves.find(
        (leaf: any) => leaf?.view?.containerEl?.isConnected,
      ) ??
      markdownLeaves[0] ??
      emptyLeaves[0] ??
      app.workspace.getLeaf("tab");
    await noteLeaf.openFile(file);
    app.workspace.setActiveLeaf(noteLeaf, { focus: true });
    await app.workspace.revealLeaf?.(noteLeaf);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (app.workspace.getActiveFile()?.path === notePath) {
        break;
      }
      // Extension startup and migration can refresh the right pane while the
      // markdown leaf is opening. Reopen and reassert the intended note so a
      // detached or repurposed leaf cannot leave the harness on a stale file.
      const currentMarkdownLeaves =
        typeof app.workspace.getLeavesOfType === "function"
          ? app.workspace.getLeavesOfType("markdown")
          : [];
      noteLeaf =
        currentMarkdownLeaves.find(
          (candidate: any) =>
            candidate.view?.file?.path === notePath &&
            candidate.view?.containerEl?.isConnected,
        ) ??
        currentMarkdownLeaves.find(
          (candidate: any) => candidate.view?.containerEl?.isConnected,
        ) ??
        currentMarkdownLeaves[0] ??
        app.workspace.getLeaf("tab");
      await noteLeaf.openFile(file);
      app.workspace.setActiveLeaf(noteLeaf, { focus: true });
      await app.workspace.revealLeaf?.(noteLeaf);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (app.workspace.getActiveFile()?.path !== notePath) {
      const activeLeaf = app.workspace.activeLeaf;
      throw new Error(
        `Unable to activate the E2E note: ${notePath}; ${JSON.stringify({
          activeFilePath: app.workspace.getActiveFile()?.path ?? null,
          activeLeafType: activeLeaf?.getViewState?.()?.type ?? null,
          activeLeafFilePath: activeLeaf?.view?.file?.path ?? null,
          attemptedLeafFilePath: noteLeaf?.view?.file?.path ?? null,
          attemptedLeafConnected: Boolean(
            noteLeaf?.view?.containerEl?.isConnected,
          ),
          markdownLeaves: (
            app.workspace.getLeavesOfType?.("markdown") ?? []
          ).map((leaf: any) => ({
            path: leaf?.view?.file?.path ?? null,
            connected: Boolean(leaf?.view?.containerEl?.isConnected),
          })),
        })}`,
      );
    }

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
        maxAgentSteps: 100,
        streamWritebackMode: "all_current_note_content_writes",
      };
    } else {
    plugin.settings = {
      ...plugin.settings,
      enableStreaming: false,
      thinkingMode: "off",
      model: "playwright-e2e-mock",
      // Mock web tools must never depend on a credential preserved in an
      // established test vault. A loopback base URL exercises the injected
      // transport without triggering Ollama Cloud's real API-key precondition.
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaApiKey: "",
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
      maxAgentSteps: 100,
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
    const deepWebStepCounts = new Map<string, number>();
    const quoteVerifyStepCounts = new Map<string, number>();
    const resumeResearchStepCounts = new Map<string, number>();
    const sourcedAppendStepCounts = new Map<string, number>();
    const proofGatedPrematureAttempted = new Set<string>();
    const proofGatedStreamStepCounts = new Map<string, number>();
    const currentMarketWritebackStepCounts = new Map<string, number>();
    const semanticSearchStepCounts = new Map<string, number>();
    const deepVaultStepCounts = new Map<string, number>();
    const acceptanceWordCountStepCounts = new Map<string, number>();
    const titleReplacementStepCounts = new Map<string, number>();
    const highlightStepCounts = new Map<string, number>();
    const restoreStepCounts = new Map<string, number>();
    const codeWorkflowStepCounts = new Map<string, number>();
    const codeWorkspaceStepCounts = new Map<string, number>();
    const researchTeamStepCounts = new Map<string, number>();
    const designReviseStepCounts = new Map<string, number>();
    const codeApprovalStepCounts = new Map<string, number>();
    const codeDenyStepCounts = new Map<string, number>();
    const deleteDenyStepCounts = new Map<string, number>();
    const wallClockStepCounts = new Map<string, number>();
    const sourceCacheFirstStepCounts = new Map<string, number>();
    const sourceCacheSecondStepCounts = new Map<string, number>();
    const autoFollowupSourceStepCounts = new Map<string, number>();
    const autoSegmentContinuationStepCounts = new Map<string, number>();
    const longRunRequiredToolFailureStepCounts = new Map<string, number>();
    const continueButtonStepCounts = new Map<string, number>();
    const parallelReadStepCounts = new Map<string, number>();
    const folderTraversalStepCounts = new Map<string, number>();
    const missionGraphVisibilityStepCounts = new Map<string, number>();
    const missionGraphMaliciousStepCounts = new Map<string, number>();
    const missionGraphRestartStepCounts = new Map<string, number>();
    const phase3ResumeStepCounts = new Map<string, number>();
    plugin.createModelClient = function createModelClient() {
      return {
        playwrightE2EMock: true,
        async chat(request: {
          messages?: Array<{ role?: string; content?: string }>;
          tools?: Array<{ function?: { name?: string } }>;
          format?: unknown;
          abortSignal?: AbortSignal;
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
          const missionGraphE2eRequest =
            requestText.includes("E2E_MGV3_VISIBLE_BEFORE_TOOL") ||
            requestText.includes("E2E_MGV3_MALICIOUS_EXTRA") ||
            requestText.includes("E2E_MGV3_RESTART_WRITE");
          const phase3ResumeRequest = requestText.includes("E2E_PHASE3_RESUME");
          if (phase3ResumeRequest && request.format !== undefined) {
            return {
              message: { role: "assistant", content: "{}" },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }
          if (phase3ResumeRequest && request.format === undefined) {
            const key = `E2E_PHASE3_RESUME:${secondMarker}`;
            const step = phase3ResumeStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("append_to_current_file")) {
                throw new Error(
                  `append_to_current_file was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              phase3ResumeStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-phase3-resume-append",
                index: 0,
                name: "append_to_current_file",
                arguments: { text: secondMarker },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }
            return {
              message: { role: "assistant", content: "E2E_PHASE3_RESUME_DONE" },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }
          if (missionGraphE2eRequest && request.format !== undefined) {
            // Keep the transport deterministic while exercising the host's
            // conservative structured-routing fallback. Runtime tool calls
            // below are returned only after the graph has been persisted.
            return {
              message: { role: "assistant", content: "{}" },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (requestText.includes("E2E_MGV3_VISIBLE_BEFORE_TOOL")) {
            const key = `E2E_MGV3_VISIBLE_BEFORE_TOOL:${marker}`;
            const step = missionGraphVisibilityStepCounts.get(key) ?? 0;
            if (step === 0 && toolNames.length > 0) {
              if (!toolNames.includes("create_file")) {
                throw new Error(
                  `create_file was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              const deadline = Date.now() + 60_000;
              while (
                !(window as typeof window & {
                  __e2eReleaseMissionGraphTool?: boolean;
                }).__e2eReleaseMissionGraphTool
              ) {
                if (request.abortSignal?.aborted) {
                  return {
                    message: { role: "assistant", content: "E2E_MGV3_VISIBLE_STOPPED" },
                    toolCalls: [],
                    raw: { playwrightE2E: true },
                  };
                }
                if (Date.now() >= deadline) {
                  throw new Error(
                    "Timed out waiting for the mission-graph visibility assertion.",
                  );
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              missionGraphVisibilityStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-mission-graph-visible-create",
                index: 0,
                name: "create_file",
                arguments: {
                  path: `E2E Agent Tests/Mission Graph Guard/visible-${marker}.md`,
                  content: `# Mission graph persisted first\n\n${marker}\n`,
                  createFolders: true,
                },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }
            if (toolNames.length > 0) {
              return {
                message: {
                  role: "assistant",
                  content: "E2E_MGV3_VISIBLE_DONE",
                },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }
          }

          if (requestText.includes("E2E_MGV3_MALICIOUS_EXTRA")) {
            const key = `E2E_MGV3_MALICIOUS_EXTRA:${marker}`;
            const step = missionGraphMaliciousStepCounts.get(key) ?? 0;
            if (step === 0 && toolNames.length > 0) {
              if (!toolNames.includes("create_file")) {
                throw new Error(
                  `create_file was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              missionGraphMaliciousStepCounts.set(key, 1);
              const allowedCall = {
                id: "playwright-e2e-mission-graph-allowed-create",
                index: 0,
                name: "create_file",
                arguments: {
                  path: `E2E Agent Tests/Mission Graph Guard/allowed-${marker}.md`,
                  content: `# Allowed graph target\n\nALLOWED_CREATE:${marker}\n`,
                  createFolders: true,
                },
              };
              const maliciousCall = {
                id: "playwright-e2e-mission-graph-malicious-create",
                index: 1,
                name: "create_file",
                arguments: {
                  path: `E2E Agent Tests/Mission Graph Guard/protected-${marker}.md`,
                  content: `# Unplanned graph target\n\nMALICIOUS_CREATE:${marker}\n`,
                  createFolders: true,
                },
              };
              return {
                message: {
                  role: "assistant",
                  content: "",
                  toolCalls: [allowedCall, maliciousCall],
                },
                toolCalls: [allowedCall, maliciousCall],
                raw: { playwrightE2E: true },
              };
            }
            if (toolNames.length > 0) {
              return {
                message: {
                  role: "assistant",
                  content:
                    "E2E_MGV3_MALICIOUS_EXTRA_DONE: the unplanned mutation was rejected.",
                },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }
          }

          if (requestText.includes("E2E_MGV3_RESTART_WRITE")) {
            const resumed =
              /continue\s+run\s+[A-Za-z0-9._:-]+/iu.test(requestText) ||
              /Resume count:\s*[1-9]/iu.test(requestText);
            if (resumed && toolNames.length > 0) {
              const completionPath =
                `E2E Agent Tests/Mission Graph Guard/restart-complete-${marker}.md`;
              const appendAlreadyObserved = (request.messages ?? []).some(
                (message) =>
                  message.role === "tool" &&
                  (message.content ?? "").includes(completionPath),
              );
              if (!appendAlreadyObserved) {
                if (!toolNames.includes("append_file")) {
                  throw new Error(
                    `append_file was not available while resuming the MissionGraph. Tools: ${toolNames.join(", ")}`,
                  );
                }
                const toolCall = {
                  id: "playwright-e2e-mission-graph-restart-path-append",
                  index: 0,
                  name: "append_file",
                  arguments: {
                    path: completionPath,
                    text: `\nCOMPLETE:${marker}\n`,
                  },
                };
                return {
                  message: { role: "assistant", content: "", toolCalls: [toolCall] },
                  toolCalls: [toolCall],
                  raw: { playwrightE2E: true },
                };
              }
              return {
                message: {
                  role: "assistant",
                  content:
                    `E2E_MGV3_RESTART_DONE ${marker}: resumed from durable graph state without replaying the completed write.`,
                },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }
            const key = `E2E_MGV3_RESTART_WRITE:${marker}`;
            const step = missionGraphRestartStepCounts.get(key) ?? 0;
            if (step === 0 && toolNames.length > 0) {
              if (!toolNames.includes("append_to_current_file")) {
                throw new Error(
                  `append_to_current_file was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              missionGraphRestartStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-mission-graph-restart-append",
                index: 0,
                name: "append_to_current_file",
                arguments: { text: `\n\nE2E_MGV3_RESTART_MARKER_${marker}\n` },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }
            if (step > 0 && toolNames.length > 0) {
              const deadline = Date.now() + 60_000;
              while (
                (window as typeof window & {
                  __e2eHoldMissionGraphRestartAfterWrite?: boolean;
                }).__e2eHoldMissionGraphRestartAfterWrite
              ) {
                if (request.abortSignal?.aborted || Date.now() >= deadline) {
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              return {
                message: {
                  role: "assistant",
                  content: "E2E_MGV3_RESTART_STOP_READY",
                },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }
          }
          if (latestUserText.includes("E2E_DAY1_CHAT_ANSWER_NO_TOOLS")) {
            return {
              message: {
                role: "assistant",
                content:
                  "E2E_DAY1_CHAT_ANSWER 2+2 equals 4. No tools were needed for this chat answer.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }
          if (
            latestUserText.includes("E2E_VIEW_REATTACH") &&
            (window as typeof window & {
              __e2eViewReattachActive?: boolean;
            }).__e2eViewReattachActive === true
          ) {
            const deadline = Date.now() + 30_000;
            while (
              !(window as typeof window & {
                __e2eAllowViewReattachCompletion?: boolean;
              }).__e2eAllowViewReattachCompletion
            ) {
              if (Date.now() >= deadline) {
                throw new Error(
                  "Timed out waiting for the replacement AgentView to reattach.",
                );
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            (window as typeof window & {
              __e2eViewReattachActive?: boolean;
            }).__e2eViewReattachActive = false;
            return {
              message: {
                role: "assistant",
                content: "E2E_VIEW_REATTACH_DONE",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }
          if (latestUserText.includes("E2E_TITLE_RENAME_HISTORY_WRITE")) {
            if (!toolNames.includes("append_to_current_file")) {
              throw new Error(
                `append_to_current_file was not available for title rename history write. Tools: ${toolNames.join(", ")}`,
              );
            }
            const toolCall = {
              id: "playwright-e2e-title-history-write",
              index: 0,
              name: "append_to_current_file",
              arguments: {
                text: "Renaissance sailors mapped coasts, traded ideas, and carried inventions between ports, but the printing press changed history more quietly. Cheap books spread arguments, diagrams, laws, and scripture beyond elites. Readers compared claims, challenged authorities, and built shared knowledge that strengthened reform, science, education, and political imagination across Europe for centuries.",
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

          if (latestUserText.includes("E2E_TITLE_RENAME_HISTORY_TITLE")) {
            if (!toolNames.includes("rename_current_file")) {
              throw new Error(
                `rename_current_file was not available for title rename. Tools: ${toolNames.join(", ")}`,
              );
            }
            return {
              message: {
                role: "assistant",
                content:
                  '{"tool":"rename_current_file","title":"History Snapshot"}',
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_TITLE_REPLACEMENT_50")) {
            const key = "E2E_TITLE_REPLACEMENT_50";
            const step = titleReplacementStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("append_to_current_file")) {
                throw new Error(
                  `title replacement append tool unavailable. Tools: ${toolNames.join(", ")}`,
                );
              }
              if (toolNames.includes("rename_current_file")) {
                throw new Error(
                  "ordinary titled writeback must not require rename_current_file; plugin auto-renames placeholders",
                );
              }
              titleReplacementStepCounts.set(key, 1);
              const body =
                "# Purple Horizon\n\nPurple horizons glow over quiet fields as morning rain lifts from cedar roofs and windows. A traveler pauses, listens to trains beyond the ridge, and writes a promise to return with stories, patience, and courage for everyone still waiting beside the road under violet clouds after winter finally breaks open.";
              const toolCalls = [
                {
                  id: "playwright-e2e-title-replacement-append",
                  index: 0,
                  name: "append_to_current_file",
                  arguments: { text: body },
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

            return {
              message: {
                role: "assistant",
                content: "E2E_TITLE_REPLACEMENT_DONE",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_HIGHLIGHT_PHRASE")) {
            const key = "E2E_HIGHLIGHT_PHRASE";
            const step = highlightStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("highlight_current_file_phrase")) {
                throw new Error(
                  `highlight_current_file_phrase was not available. Tools: ${toolNames.join(", ")}`,
                );
              }
              highlightStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-highlight-phrase",
                index: 0,
                name: "highlight_current_file_phrase",
                arguments: { phrase: "silver lantern" },
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
                content: "E2E_HIGHLIGHT_DONE",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_RESTORE_BACKUP")) {
            const key = "E2E_RESTORE_BACKUP";
            const step = restoreStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("restore_current_file_from_backup")) {
                throw new Error(
                  `restore_current_file_from_backup was not available. Tools: ${toolNames.join(", ")}`,
                );
              }
              restoreStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-restore-backup",
                index: 0,
                name: "restore_current_file_from_backup",
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
                content: "E2E_RESTORE_BACKUP_DONE",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          const requestContainsContinueRun =
            /continue\s+run\s+[A-Za-z0-9._:-]+/i.test(requestText);
          if (
            latestUserText.includes("E2E_CONTINUE_BUTTON_BUDGET") &&
            !requestContainsContinueRun
          ) {
            return {
              message: {
                role: "assistant",
                content: "E2E_CONTINUE_BUTTON_BUDGET_CHAT_ONLY",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_ACCEPTANCE_WORD_COUNT")) {
            const key = "E2E_ACCEPTANCE_WORD_COUNT";
            const step = acceptanceWordCountStepCounts.get(key) ?? 0;
            if (step === 0) {
              acceptanceWordCountStepCounts.set(key, 1);
              return {
                message: {
                  role: "assistant",
                  content: "The current note has 0 words.",
                },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }

            if (step === 1 && toolNames.includes("count_words")) {
              acceptanceWordCountStepCounts.set(key, 2);
              const toolCall = {
                id: "playwright-e2e-acceptance-count-words",
                index: 0,
                name: "count_words",
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
                content: "E2E_ACCEPTANCE_WORD_COUNT_DONE after count_words verification.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_VIEW_REATTACH")) {
            const deadline = Date.now() + 30_000;
            while (
              !(window as typeof window & {
                __e2eAllowViewReattachCompletion?: boolean;
              }).__e2eAllowViewReattachCompletion
            ) {
              if (Date.now() >= deadline) {
                throw new Error(
                  "Timed out waiting for the replacement AgentView to reattach.",
                );
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            return {
              message: {
                role: "assistant",
                content: "E2E_VIEW_REATTACH_DONE",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_SCHEDULED_RUN")) {
            return {
              message: {
                role: "assistant",
                content: "E2E_SCHEDULED_DONE scheduled mission completed through MissionScheduler.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (
            latestUserText.includes("E2E_PARALLEL_READ") ||
            requestText.includes("E2E_PARALLEL_READ")
          ) {
            const key = "E2E_PARALLEL_READ";
            const step = parallelReadStepCounts.get(key) ?? 0;
            const preferredReads = [
              "semantic_search_notes",
              "read_markdown_files",
            ];
            const availableReads = preferredReads.filter((name) =>
              toolNames.includes(name),
            );
            if (step === 0) {
              if (availableReads.length < 2) {
                // Router/classification probes may call chat without tools.
                // Do not consume the parallel scenario or emit a fake final.
                return {
                  message: {
                    role: "assistant",
                    content: "",
                  },
                  toolCalls: [],
                  raw: { playwrightE2E: true },
                };
              }
              const markerMatch =
                /E2E_PARALLEL_DONE_[A-Za-z0-9_]+/.exec(
                  latestUserText.includes("E2E_PARALLEL_DONE_")
                    ? latestUserText
                    : requestText,
                )?.[0] ?? "E2E_PARALLEL_DONE";
              const readBatch = availableReads.slice(0, 4).map((name, index) => ({
                id: `playwright-e2e-parallel-read-${index + 1}`,
                index,
                name,
                arguments:
                  name === "semantic_search_notes"
                    ? {
                        query: markerMatch,
                        folder: "E2E Agent Tests",
                        limit: 3,
                      }
                    : {
                        paths: [notePath],
                        maxCharsPerFile: 1200,
                      },
              }));
              // Always run reads first, then append on the next model turn.
              // Batching append in the same response can hit mission-plan
              // dependency deferral before read proof is applied to the plan.
              parallelReadStepCounts.set(key, 1);
              return {
                message: {
                  role: "assistant",
                  content: "",
                  toolCalls: readBatch,
                },
                toolCalls: readBatch,
                raw: { playwrightE2E: true },
              };
            }
            if (step === 1) {
              const markerMatch =
                /E2E_PARALLEL_DONE_[A-Za-z0-9_]+/.exec(
                  latestUserText.includes("E2E_PARALLEL_DONE_")
                    ? latestUserText
                    : requestText,
                )?.[0] ?? "E2E_PARALLEL_DONE";
              if (!toolNames.includes("append_to_current_file")) {
                return {
                  message: {
                    role: "assistant",
                    content: `E2E_PARALLEL_DONE blocked: append_to_current_file missing after reads. Tools: ${toolNames.join(", ") || "(none)"}`,
                  },
                  toolCalls: [],
                  raw: { playwrightE2E: true },
                };
              }
              parallelReadStepCounts.set(key, 2);
              const toolCall = {
                id: "playwright-e2e-parallel-append",
                index: 0,
                name: "append_to_current_file",
                arguments: {
                  text: `\n\n${markerMatch} parallel reads completed before this append.\n`,
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
                  "E2E_PARALLEL_DONE parallel read-only tools ran concurrently, then append stayed sequential.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

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

          const resumeText = /continue\s+run\s+([A-Za-z0-9._:-]+)/i.test(
            latestUserText,
          )
            ? latestUserText
            : requestText;
          if (
            !requestText.includes("E2E_AUTO_SEGMENT_CONTINUATION") &&
            /continue\s+run\s+([A-Za-z0-9._:-]+)/i.test(resumeText)
          ) {
            const requestedRunId =
              /continue\s+run\s+([A-Za-z0-9._:-]+)/i.exec(resumeText)?.[1] ?? "";
            if (
              requestedRunId &&
              !requestText.includes("Structured Agent Runs mission ledger")
            ) {
              throw new Error(`Resume context was not injected for ${requestedRunId}.`);
            }

            if (requestText.includes("E2E_CONTINUE_BUTTON_BUDGET")) {
              const step = continueButtonStepCounts.get(requestedRunId) ?? 0;
              if (step === 0) {
                if (!toolNames.includes("append_to_current_file")) {
                  throw new Error(
                    `append_to_current_file was not available for continue button resume. Tools: ${toolNames.join(", ")}`,
                  );
                }
                continueButtonStepCounts.set(requestedRunId, 1);
                const toolCall = {
                  id: "playwright-e2e-continue-button-append",
                  index: 0,
                  name: "append_to_current_file",
                  arguments: {
                    text: `\n\nE2E_RESUME_LEDGER_${requestedRunId}`,
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
                  content: `E2E_RESUME_LEDGER_${requestedRunId}`,
                },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }

            if (/Resume first incomplete research item:\s+rq-/i.test(requestText)) {
              const step = resumeResearchStepCounts.get(requestedRunId) ?? 0;
              if (step === 0) {
                if (!toolNames.includes("web_search")) {
                  throw new Error(
                    `web_search was not available for incomplete research resume. Tools: ${toolNames.join(", ")}`,
                  );
                }
                resumeResearchStepCounts.set(requestedRunId, 1);
                const toolCall = {
                  id: "playwright-e2e-resume-research-search",
                  index: 0,
                  name: "web_search",
                  arguments: {
                    query: `resume ${requestedRunId} first incomplete research item`,
                    max_results: 3,
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

              const passageIds = Array.from(
                requestText.matchAll(/source:[A-Za-z0-9]+:passage:\d+-\d+/g),
                (match) => match[0],
              );
              return {
                message: {
                  role: "assistant",
                  content: [
                    `E2E_RESUME_RESEARCH_DONE_${requestedRunId}`,
                    `Alpha evidence: https://alpha.example.com/deep-source${passageIds[0] ? ` [${passageIds[0]}]` : ""}.`,
                    `Beta evidence: https://beta.example.org/deep-source${passageIds[1] ? ` [${passageIds[1]}]` : ""}.`,
                    `Gamma evidence: https://gamma.example.net/deep-source${passageIds[2] ? ` [${passageIds[2]}]` : ""}.`,
                    "Limitations: these are deterministic e2e fixtures rather than live sources.",
                    "Confidence: high for the resumed research workflow.",
                  ].join(" "),
                },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
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

          if (latestUserText.includes("E2E_CODE_WORKFLOW")) {
            const key = "E2E_CODE_WORKFLOW";
            const step = codeWorkflowStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("run_code_block")) {
                throw new Error(
                  `run_code_block was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              codeWorkflowStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-code-workflow-run",
                index: 0,
                name: "run_code_block",
                arguments: {
                  language: "javascript",
                  code: "console.log('E2E_CODE_WORKFLOW_OUTPUT');",
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
                  "E2E_CODE_WORKFLOW_DONE javascript run finished with exit code 0 and printed E2E_CODE_WORKFLOW_OUTPUT.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (
            latestUserText.includes("E2E_CODE_WORKSPACE") ||
            requestText.includes("E2E_CODE_WORKSPACE")
          ) {
            const key = "E2E_CODE_WORKSPACE";
            const step = codeWorkspaceStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("write_workspace_file")) {
                throw new Error(
                  `write_workspace_file was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              codeWorkspaceStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-code-workspace-util",
                index: 0,
                name: "write_workspace_file",
                arguments: {
                  path: "util.js",
                  content:
                    "module.exports = { marker: 'E2E_CODE_WORKSPACE_OUTPUT' };\n",
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
            if (step === 1) {
              if (!toolNames.includes("write_workspace_file")) {
                throw new Error(
                  `write_workspace_file was not available for ${key} main. Tools: ${toolNames.join(", ")}`,
                );
              }
              codeWorkspaceStepCounts.set(key, 2);
              const toolCall = {
                id: "playwright-e2e-code-workspace-main",
                index: 0,
                name: "write_workspace_file",
                arguments: {
                  path: "main.js",
                  content:
                    "const { marker } = require('./util.js');\nconsole.log(marker);\n",
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
            if (step === 2) {
              if (!toolNames.includes("run_code_block")) {
                throw new Error(
                  `run_code_block was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              codeWorkspaceStepCounts.set(key, 3);
              const toolCall = {
                id: "playwright-e2e-code-workspace-run",
                index: 0,
                name: "run_code_block",
                arguments: {
                  language: "javascript",
                  entryPath: "main.js",
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
                  "E2E_CODE_WORKSPACE_DONE multi-file workspace run finished with exit code 0 and printed E2E_CODE_WORKSPACE_OUTPUT.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (
            latestUserText.includes("E2E_RESEARCH_TEAM") ||
            requestText.includes("E2E_RESEARCH_TEAM")
          ) {
            const key = "E2E_RESEARCH_TEAM";
            const isResearcher = /Original mission:[\s\S]*Assigned task:/i.test(
              latestUserText,
            );
            const stepKey = isResearcher ? `${key}:researcher` : `${key}:lead`;
            const step = researchTeamStepCounts.get(stepKey) ?? 0;
            if (isResearcher) {
              if (step === 0) {
                if (!toolNames.includes("web_search")) {
                  throw new Error(
                    `web_search was not available for researcher ${key}. Tools: ${toolNames.join(", ")}`,
                  );
                }
                researchTeamStepCounts.set(stepKey, 1);
                const toolCall = {
                  id: "playwright-e2e-research-team-search",
                  index: 0,
                  name: "web_search",
                  arguments: {
                    query: "E2E_RESEARCH_TEAM test topic sources",
                    max_results: 3,
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
              if (step === 1) {
                if (!toolNames.includes("web_fetch")) {
                  throw new Error(
                    `web_fetch was not available for researcher ${key}. Tools: ${toolNames.join(", ")}`,
                  );
                }
                researchTeamStepCounts.set(stepKey, 2);
                const toolCall = {
                  id: "playwright-e2e-research-team-fetch",
                  index: 0,
                  name: "web_fetch",
                  arguments: {
                    url: "https://alpha.example.com/research-team-source",
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
              researchTeamStepCounts.set(stepKey, 3);
              return {
                message: {
                  role: "assistant",
                  content:
                    "Researcher handoff: E2E_RESEARCH_TEAM evidence gathered from https://alpha.example.com/research-team-source. Lead should append findings.",
                },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }

            // Lead path — keep advancing until append is available, then write once.
            if (toolNames.includes("append_to_current_file") && step < 10) {
              researchTeamStepCounts.set(stepKey, 10);
              const toolCall = {
                id: "playwright-e2e-research-team-append",
                index: 0,
                name: "append_to_current_file",
                arguments: {
                  text: "E2E_RESEARCH_TEAM_DONE Lead appended sourced findings from the Researcher handoff.",
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

            if (step >= 10) {
              return {
                message: {
                  role: "assistant",
                  content:
                    "E2E_RESEARCH_TEAM_DONE Lead finalized the research team writeback.",
                },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }

            if (toolNames.includes("web_search") && step === 0) {
              researchTeamStepCounts.set(stepKey, 1);
              const toolCall = {
                id: "playwright-e2e-research-team-lead-search",
                index: 0,
                name: "web_search",
                arguments: {
                  query: "E2E_RESEARCH_TEAM lead follow-up sources",
                  max_results: 2,
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

            if (toolNames.includes("web_fetch") && step < 5) {
              researchTeamStepCounts.set(stepKey, step + 1);
              const toolCall = {
                id: `playwright-e2e-research-team-lead-fetch-${step}`,
                index: 0,
                name: "web_fetch",
                arguments: {
                  url: "https://alpha.example.com/research-team-source",
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

            throw new Error(
              `append_to_current_file was not available for lead ${key} after research tools. Tools: ${toolNames.join(", ")}`,
            );
          }

          if (latestUserText.includes("E2E_CODE_APPROVAL")) {
            const key = "E2E_CODE_APPROVAL";
            const step = codeApprovalStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("run_code_block")) {
                throw new Error(
                  `run_code_block was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              codeApprovalStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-code-approval-run",
                index: 0,
                name: "run_code_block",
                arguments: {
                  language: "javascript",
                  code: "console.log('E2E_CODE_APPROVAL_OUTPUT');",
                  timeoutMs: 45000,
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
                  "E2E_CODE_APPROVAL_DONE approved javascript run finished with exit code 0 and printed E2E_CODE_APPROVAL_OUTPUT.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_CODE_DENY")) {
            const key = "E2E_CODE_DENY";
            const step = codeDenyStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("run_code_block")) {
                throw new Error(
                  `run_code_block was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              codeDenyStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-code-deny-run",
                index: 0,
                name: "run_code_block",
                arguments: {
                  language: "javascript",
                  code: "console.log('E2E_CODE_DENY_OUTPUT');",
                  timeoutMs: 45000,
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
                  "E2E_CODE_DENY_DONE the code run was not executed because approval was denied.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_LONG_RUN_REQUIRED_TOOL_FAILURE")) {
            const key = "E2E_LONG_RUN_REQUIRED_TOOL_FAILURE";
            const step = longRunRequiredToolFailureStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("web_search")) {
                throw new Error(
                  `web_search was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              longRunRequiredToolFailureStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-long-run-required-tool-failure",
                index: 0,
                name: "web_search",
                arguments: { query: key, max_results: 3 },
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
                  "E2E_LONG_RUN_REQUIRED_TOOL_FAILURE_DONE: the required web search failed, so research cannot continue.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (
            requestText.includes("E2E_AUTO_SEGMENT_CONTINUATION") &&
            (/^continue\s+run\s+[A-Za-z0-9._:-]+/iu.test(latestUserText.trim()) ||
              /Continuation command:\s*continue\s+run\s+[A-Za-z0-9._:-]+/iu.test(
                requestText,
              ) ||
              /Runtime snapshot v\d+ revision/u.test(requestText) ||
              /Resume count:\s*[1-9]/iu.test(requestText) ||
              (/Ledger path:\s*Agent Runs\//iu.test(requestText) &&
                /Run id:\s*run-/iu.test(requestText)))
          ) {
            // Overnight segment 1 advances performance.now; restore before the
            // continuation segment so wall-clock budget does not immediately stop it.
            const overnightWindow = window as typeof window & {
              __e2eRestoreOvernightClock?: (() => void) | null;
            };
            overnightWindow.__e2eRestoreOvernightClock?.();
            wallClockStepCounts.delete("E2E_WALL_CLOCK");
            const requestedRunId =
              /^continue\s+run\s+([A-Za-z0-9._:-]+)/iu.exec(
                latestUserText.trim(),
              )?.[1] ??
              /Continuation command:\s*continue\s+run\s+([A-Za-z0-9._:-]+)/iu.exec(
                requestText,
              )?.[1] ??
              /Run id:\s*([A-Za-z0-9._:-]+)/u.exec(requestText)?.[1] ??
              /"segmentId":\s*"([^"]+)"/u.exec(requestText)?.[1] ??
              "";
            if (!requestedRunId) {
              throw new Error(
                "Runtime snapshot did not include a segment id for automatic continuation.",
              );
            }
            const continuationKey = requestText.includes("E2E_OVERNIGHT_DURABLE")
              ? "E2E_OVERNIGHT_DURABLE_CONTINUATION"
              : requestedRunId;
            const continuationStep =
              autoSegmentContinuationStepCounts.get(continuationKey) ?? 0;
            if (continuationStep === 0) {
              const requiredTools = ["web_search", "web_fetch"];
              const missingTools = requiredTools.filter(
                (toolName) => !toolNames.includes(toolName),
              );
              if (missingTools.length > 0) {
                throw new Error(
                  `Automatic continuation was missing research tools: ${missingTools.join(", ")}.`,
                );
              }
              autoSegmentContinuationStepCounts.set(continuationKey, 1);
              const toolCalls = [
                {
                  id: `playwright-e2e-auto-segment-search-${continuationKey}`,
                  index: 0,
                  name: "web_search",
                  arguments: {
                    query: "E2E_AUTO_SEGMENT_CONTINUATION deep sources",
                    max_results: 3,
                  },
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
            if (continuationStep === 1) {
              if (!toolNames.includes("web_fetch")) {
                throw new Error(
                  `Automatic continuation was missing web_fetch after search. Tools: ${toolNames.join(", ")}`,
                );
              }
              autoSegmentContinuationStepCounts.set(continuationKey, 2);
              const toolCalls = [
                {
                  id: `playwright-e2e-auto-segment-fetch-alpha-${continuationKey}`,
                  index: 0,
                  name: "web_fetch",
                  arguments: {
                    url: "https://alpha.example.com/deep-source",
                    max_chars: 4000,
                  },
                },
                {
                  id: `playwright-e2e-auto-segment-fetch-beta-${continuationKey}`,
                  index: 1,
                  name: "web_fetch",
                  arguments: {
                    url: "https://beta.example.org/deep-source",
                    max_chars: 4000,
                  },
                },
                {
                  id: `playwright-e2e-auto-segment-fetch-gamma-${continuationKey}`,
                  index: 2,
                  name: "web_fetch",
                  arguments: {
                    url: "https://gamma.example.net/deep-source",
                    max_chars: 4000,
                  },
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
            const overnightContinuation = requestText.includes(
              "E2E_OVERNIGHT_DURABLE",
            );
            const autoSegmentLongRun =
              requestText.includes("E2E_AUTO_SEGMENT_CONTINUATION") &&
              !overnightContinuation;
            if (
              (overnightContinuation || autoSegmentLongRun) &&
              continuationStep === 2 &&
              toolNames.includes("append_to_current_file")
            ) {
              autoSegmentContinuationStepCounts.set(continuationKey, 3);
              const toolCall = {
                id: `playwright-e2e-auto-segment-append-${continuationKey}`,
                index: 0,
                name: "append_to_current_file",
                arguments: {
                  text: `\n\n### E2E_AUTO_SEGMENT_CONTINUATION_DONE_${requestedRunId}\n`,
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
            if (overnightContinuation && continuationStep === 3) {
              if (!toolNames.includes("rename_current_file")) {
                throw new Error(
                  `Overnight continuation was missing rename_current_file after writeback. Tools: ${toolNames.join(", ")}`,
                );
              }
              const title =
                /Rename the current note to "([^"]+)"/u.exec(requestText)?.[1];
              if (!title) {
                throw new Error("Overnight continuation rename title was missing.");
              }
              autoSegmentContinuationStepCounts.set(continuationKey, 4);
              const toolCall = {
                id: `playwright-e2e-overnight-rename-${continuationKey}`,
                index: 0,
                name: "rename_current_file",
                arguments: { title },
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
            const passageIds = [
              ...new Set(
                Array.from(
                  requestText.matchAll(/source:[A-Za-z0-9]+:passage:\d+-\d+/g),
                  (match) => match[0],
                ),
              ),
            ];
            if (passageIds.length < 3 && !overnightContinuation && !autoSegmentLongRun) {
              throw new Error(
                `automatic continuation expected at least 3 passage citation ids, found ${passageIds.length}`,
              );
            }
            const cited = [
              passageIds[0] ?? "source:alpha:passage:1-40",
              passageIds[1] ?? "source:beta:passage:1-40",
              passageIds[2] ?? "source:gamma:passage:1-40",
            ];
            return {
              message: {
                role: "assistant",
                content: [
                  `### E2E_AUTO_SEGMENT_CONTINUATION_DONE_${requestedRunId}`,
                  "",
                  "## Findings",
                  `Alpha evidence shows the test topic finding from the alpha source [${cited[0]}].`,
                  `Beta evidence confirms a second independent finding about the test topic [${cited[1]}].`,
                  `Gamma evidence adds a third corroborating detail for the test topic [${cited[2]}].`,
                  "",
                  "## Sources",
                  `- https://alpha.example.com/deep-source [${cited[0]}]`,
                  `- https://beta.example.org/deep-source [${cited[1]}]`,
                  `- https://gamma.example.net/deep-source [${cited[2]}]`,
                  "",
                  "## Limitations",
                  "Limitations: deterministic e2e fixture sources only.",
                  "",
                  "## Confidence",
                  "High confidence in segment lineage and completion-event behavior.",
                ].join("\n"),
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_WALL_CLOCK")) {
            // Overnight/auto-continue child segments must not re-enter the
            // wall-clock graph loop; the continuation handler above owns them.
            // After resume, activeIntentPrompt is restored to the original
            // mission, so latestUserText still contains E2E_WALL_CLOCK.
            const isResumedContinuation =
              /Continuation command:\s*continue\s+run\s+[A-Za-z0-9._:-]+/iu.test(
                requestText,
              ) ||
              /Runtime snapshot v\d+ revision/u.test(requestText) ||
              /Resume count:\s*[1-9]/iu.test(requestText);
            if (isResumedContinuation) {
              wallClockStepCounts.delete("E2E_WALL_CLOCK");
              // fall through to later handlers / default
            } else {
            const key = "E2E_WALL_CLOCK";
            const step = wallClockStepCounts.get(key) ?? 0;
            const autoSegmentInitial = latestUserText.includes(
              "E2E_AUTO_SEGMENT_CONTINUATION",
            );
            if (autoSegmentInitial && step === 0) {
              if (!toolNames.includes("rename_current_file")) {
                throw new Error(
                  `rename_current_file was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              const title =
                /Rename the current note to "([^"]+)"/u.exec(latestUserText)?.[1];
              if (!title) {
                throw new Error("Automatic continuation rename title was missing.");
              }
              wallClockStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-auto-segment-rename",
                index: 0,
                name: "rename_current_file",
                arguments: { title },
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
              autoSegmentInitial &&
              !isResumedContinuation &&
              !/^continue\s+run\s+[A-Za-z0-9._:-]+/iu.test(latestUserText.trim())
            ) {
              const overnightWindow = window as typeof window & {
                __e2eOvernightClockAdvanced?: boolean;
                __e2eRestoreOvernightClock?: (() => void) | null;
              };
              if (overnightWindow.__e2eOvernightClockAdvanced !== true) {
                const originalPerformanceNow = window.performance.now.bind(
                  window.performance,
                );
                Object.defineProperty(window.performance, "now", {
                  configurable: true,
                  value: () => originalPerformanceNow() + 31 * 60_000,
                });
                overnightWindow.__e2eOvernightClockAdvanced = true;
                overnightWindow.__e2eRestoreOvernightClock = () => {
                  Object.defineProperty(window.performance, "now", {
                    configurable: true,
                    value: originalPerformanceNow,
                  });
                  overnightWindow.__e2eOvernightClockAdvanced = false;
                  overnightWindow.__e2eRestoreOvernightClock = null;
                };
              }
            }
            const graphStep = autoSegmentInitial ? step - 1 : step;
            if (graphStep < 8 && toolNames.includes("get_note_graph_context")) {
              wallClockStepCounts.set(key, step + 1);
              const loopContextPath =
                loopContextNotePaths[graphStep % loopContextNotePaths.length];
              const toolCall = {
                id: `playwright-e2e-wall-clock-${graphStep + 1}`,
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
                content: "E2E_WALL_CLOCK_FALLBACK_DONE",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
            }
          }

          if (latestUserText.includes("E2E_SOURCE_CACHE_FIRST")) {
            const key = "E2E_SOURCE_CACHE_FIRST";
            const step = sourceCacheFirstStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("web_search")) {
                throw new Error(
                  `web_search was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              sourceCacheFirstStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-source-cache-first-search",
                index: 0,
                name: "web_search",
                arguments: {
                  query: "E2E_SOURCE_CACHE source",
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

            if (step === 1) {
              if (!toolNames.includes("web_fetch")) {
                if (requestText.includes("https://example.com/e2e-cache-source")) {
                  sourceCacheFirstStepCounts.set(key, 2);
                  const passageId =
                    /source:[A-Za-z0-9]+:passage:\d+-\d+/.exec(requestText)?.[0] ?? "";
                  return {
                    message: {
                      role: "assistant",
                      content:
                        `E2E_SOURCE_CACHE_FIRST_DONE sourced from https://example.com/e2e-cache-source${passageId ? ` [${passageId}]` : ""}.`,
                    },
                    toolCalls: [],
                    raw: { playwrightE2E: true },
                  };
                }
                throw new Error(
                  `web_fetch was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              sourceCacheFirstStepCounts.set(key, 2);
              const toolCall = {
                id: "playwright-e2e-source-cache-first-fetch",
                index: 0,
                name: "web_fetch",
                arguments: {
                  url: "https://example.com/e2e-cache-source",
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
                  "E2E_SOURCE_CACHE_FIRST_DONE sourced from https://example.com/e2e-cache-source.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_SOURCE_CACHE_SECOND")) {
            const key = "E2E_SOURCE_CACHE_SECOND";
            const step = sourceCacheSecondStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("web_search")) {
                throw new Error(
                  `web_search was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              sourceCacheSecondStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-source-cache-second-search",
                index: 0,
                name: "web_search",
                arguments: {
                  query: "E2E_SOURCE_CACHE source refresh",
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

            if (step === 1) {
              if (!toolNames.includes("web_fetch")) {
                if (requestText.includes("https://example.com/e2e-cache-source")) {
                  sourceCacheSecondStepCounts.set(key, 2);
                } else {
                  throw new Error(
                    `web_fetch was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                  );
                }
              } else {
                sourceCacheSecondStepCounts.set(key, 2);
                const toolCall = {
                  id: "playwright-e2e-source-cache-second-fetch",
                  index: 0,
                  name: "web_fetch",
                  arguments: {
                    url: "https://example.com/e2e-cache-source",
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
            }

            const fetchToolResults = (request.messages ?? []).filter(
              (message: { role?: string; content?: string }) =>
                message.role === "tool" &&
                String(message.content ?? "").includes("e2e-cache-source"),
            );
            const latestFetchResult = String(
              fetchToolResults[fetchToolResults.length - 1]?.content ?? "",
            );
            const cacheHit = /"fromCache"\s*:\s*true/.test(latestFetchResult);
            const passageId =
              /source:[A-Za-z0-9]+:passage:\d+-\d+/.exec(requestText)?.[0] ?? "";
            return {
              message: {
                role: "assistant",
                content: cacheHit
                  ? `E2E_SOURCE_CACHE_HIT reused the cached copy sourced from https://example.com/e2e-cache-source${passageId ? ` [${passageId}]` : ""}.`
                  : `E2E_SOURCE_CACHE_MISS refetched over the network sourced from https://example.com/e2e-cache-source${passageId ? ` [${passageId}]` : ""}.`,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (requestText.includes("E2E_AUTO_FOLLOWUP_SOURCE")) {
            const key = "E2E_AUTO_FOLLOWUP_SOURCE";
            const step = autoFollowupSourceStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("web_search")) {
                throw new Error(
                  `web_search was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              autoFollowupSourceStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-auto-followup-search",
                index: 0,
                name: "web_search",
                arguments: {
                  query: "E2E_AUTO_FOLLOWUP_SOURCE",
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

            const passageId =
              /source:[A-Za-z0-9]+:passage:\d+-\d+/.exec(requestText)?.[0] ?? "";
            return {
              message: {
                role: "assistant",
                content:
                  `E2E_AUTO_FOLLOWUP_DONE sourced from https://example.com/e2e-auto-followup-source${passageId ? ` [${passageId}]` : ""}.`,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_WEB_LEDGER_SOURCE")) {
            const key = "E2E_WEB_LEDGER_SOURCE";
            const webStep = webLedgerStepCounts.get(key) ?? 0;
            const ledgerPassageId =
              Array.from(
                requestText.matchAll(/source:[A-Za-z0-9]+:passage:\d+-\d+/g),
                (match) => match[0],
              )[0] ?? "";
            // Keep the material claim in the same sentence as the passage id and
            // reuse fetched passage wording so claim→passage grounding can bind.
            const ledgerFinal = ledgerPassageId
              ? `E2E_WEB_LEDGER_DONE. E2E_WEB_LEDGER_SOURCE fetched source content for mission evidence tracking from https://example.com/e2e-ledger-source [${ledgerPassageId}].`
              : "E2E_WEB_LEDGER_DONE sourced from https://example.com/e2e-ledger-source.";
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
              if (
                requestText.includes("https://example.com/e2e-ledger-source") &&
                !toolNames.includes("web_fetch")
              ) {
                webLedgerStepCounts.set(key, 2);
                return {
                  message: {
                    role: "assistant",
                    content: ledgerFinal,
                  },
                  toolCalls: [],
                  raw: { playwrightE2E: true },
                };
              }
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
                content: ledgerFinal,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_DEEP_WEB_RESEARCH")) {
            const key = "E2E_DEEP_WEB_RESEARCH";
            const step = deepWebStepCounts.get(key) ?? 0;
            const buildDeepWebFinal = () => {
              const passageIds = [
                ...new Set(
                  Array.from(
                    requestText.matchAll(/source:[A-Za-z0-9]+:passage:\d+-\d+/g),
                    (match) => match[0],
                  ),
                ),
              ];
              if (passageIds.length < 3) {
                throw new Error(
                  `deep web research expected at least 3 passage citation ids, found ${passageIds.length}`,
                );
              }
              return [
                "E2E_DEEP_WEB_DONE",
                `Alpha evidence shows the test topic finding from the alpha source [${passageIds[0]}].`,
                `Beta evidence confirms a second independent finding about the test topic [${passageIds[1]}].`,
                `Gamma evidence adds a third corroborating detail for the test topic [${passageIds[2]}].`,
                "",
                "## Sources",
                `- https://alpha.example.com/deep-source [${passageIds[0]}]`,
                `- https://beta.example.org/deep-source [${passageIds[1]}]`,
                `- https://gamma.example.net/deep-source [${passageIds[2]}]`,
                "",
                "Limitations: mocked e2e sources only.",
                "",
                "Confidence: high for e2e coverage.",
              ].join("\n");
            };
            if (step === 0) {
              if (!toolNames.includes("web_search")) {
                throw new Error(
                  `web_search was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              deepWebStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-deep-web-search",
                index: 0,
                name: "web_search",
                arguments: {
                  query: "E2E_DEEP_WEB_RESEARCH test topic current sources",
                  max_results: 6,
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

            if (step === 1) {
              const urls = [
                "https://alpha.example.com/deep-source",
                "https://beta.example.org/deep-source",
                "https://gamma.example.net/deep-source",
              ];
              const alreadyFetchedUrls = urls.filter((url) =>
                requestText.includes(url),
              );
              if (alreadyFetchedUrls.length >= urls.length && !toolNames.includes("web_fetch")) {
                deepWebStepCounts.set(key, 2);
                return {
                  message: {
                    role: "assistant",
                    content: buildDeepWebFinal(),
                  },
                  toolCalls: [],
                  raw: { playwrightE2E: true },
                };
              }
              if (!toolNames.includes("web_fetch")) {
                throw new Error(
                  `web_fetch was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              deepWebStepCounts.set(key, 2);
              const toolCalls = urls.map((url, index) => ({
                id: `playwright-e2e-deep-web-fetch-${index}`,
                index,
                name: "web_fetch",
                arguments: { url },
              }));
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

            return {
              message: {
                role: "assistant",
                content: buildDeepWebFinal(),
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_QUOTE_VERIFY_MISSION")) {
            const key = "E2E_QUOTE_VERIFY_MISSION";
            const step = quoteVerifyStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("web_search")) {
                throw new Error(
                  `web_search was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              quoteVerifyStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-quote-verify-search",
                index: 0,
                name: "web_search",
                arguments: {
                  query: "E2E_QUOTE_VERIFY_MISSION exact quotation source",
                  max_results: 3,
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

            if (step === 1) {
              const urls = [
                "https://example.com/e2e-quote-verify-source",
                "https://beta.example.org/deep-source",
                "https://gamma.example.net/deep-source",
              ];
              const alreadyFetchedUrls = urls.filter((url) =>
                requestText.includes(url),
              );
              if (alreadyFetchedUrls.length >= urls.length && !toolNames.includes("web_fetch")) {
                quoteVerifyStepCounts.set(key, 2);
              } else {
                if (!toolNames.includes("web_fetch")) {
                  throw new Error(
                    `web_fetch was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                  );
                }
                quoteVerifyStepCounts.set(key, 2);
                const toolCalls = urls.map((url, index) => ({
                  id: `playwright-e2e-quote-verify-fetch-${index}`,
                  index,
                  name: "web_fetch",
                  arguments: { url },
                }));
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
            }

            const passageIds = [
              ...new Set(
                Array.from(
                  requestText.matchAll(/source:[A-Za-z0-9]+:passage:\d+-\d+/g),
                  (match) => match[0],
                ),
              ),
            ];
            if (passageIds.length === 0) {
              throw new Error("quote verify mission expected a persisted passage id");
            }
            const quote =
              "The exact quoteable phrase for e2e verification";
            const sourceUrl = "https://example.com/e2e-quote-verify-source";
            return {
              message: {
                role: "assistant",
                content: [
                  "E2E_QUOTE_VERIFY_DONE",
                  `Source ${sourceUrl} states "${quote}" [${passageIds[0]}].`,
                  `Beta evidence from https://beta.example.org/deep-source [${passageIds[1] ?? passageIds[0]}].`,
                  `Gamma evidence from https://gamma.example.net/deep-source [${passageIds[2] ?? passageIds[0]}].`,
                  "",
                  "## Sources",
                  `- ${sourceUrl} [${passageIds[0]}]`,
                  `- https://beta.example.org/deep-source [${passageIds[1] ?? passageIds[0]}]`,
                  `- https://gamma.example.net/deep-source [${passageIds[2] ?? passageIds[0]}]`,
                  "",
                  "Limitations: mocked quote-verify source only.",
                  "",
                  "Confidence: high for e2e quote coverage.",
                ].join("\n"),
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (requestText.includes("E2E_CURRENT_MARKET_WRITEBACK")) {
            const originatingMissionText =
              request.messages?.find(
                (message: { role?: string; content?: string }) =>
                  message.role === "user" &&
                  String(message.content ?? "").includes("E2E_CURRENT_MARKET_WRITEBACK"),
              )?.content ?? requestText;
            const marker =
              /E2E_CURRENT_MARKET_WRITEBACK_[A-Za-z0-9_]+/.exec(
                originatingMissionText,
              )?.[0] ?? "E2E_CURRENT_MARKET_WRITEBACK_MISSING";
            const step = currentMarketWritebackStepCounts.get(marker) ?? 0;
            currentMarketWritebackStepCounts.set(marker, step + 1);
            if (step === 0) {
              const error = new Error(
                "Internal Server Error (ref: e2e-current-market-retry)",
              ) as Error & { category?: string; status?: number };
              error.name = "ModelClientError";
              error.category = "api";
              error.status = 500;
              throw error;
            }

            return {
              message: {
                role: "assistant",
                content: `E2E current market model skipped tools for ${marker} step ${step}.`,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (requestText.includes("E2E_PROOF_GATED_DEPENDENCY_WRITEBACK")) {
            const key = "E2E_PROOF_GATED_DEPENDENCY_WRITEBACK";
            if (toolNames.length === 0) {
              return {
                message: { role: "assistant", content: "" },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }
            const missingTools = [
              "web_search",
              "web_fetch",
              "append_to_current_file",
            ].filter((toolName) => !toolNames.includes(toolName));
            if (missingTools.length > 0) {
              throw new Error(
                `proof-gated writeback tools were not available: ${missingTools.join(", ")}. Tools: ${toolNames.join(", ")}`,
              );
            }
            const webSearchDone =
              requestText.includes("E2E MCP Proof-Gated Source") ||
              requestText.includes("e2e-proof-gated-source");
            const fetchDone =
              requestText.includes("This fetched passage is the proof required") &&
              /source:[A-Za-z0-9]+:passage:\d+-\d+/.test(requestText);
            const prematureDone = proofGatedPrematureAttempted.has(key);

            if (!prematureDone) {
              proofGatedPrematureAttempted.add(key);
              const toolCalls = [
                {
                  id: "playwright-e2e-proof-gated-premature-write",
                  index: 0,
                  name: "append_to_current_file",
                  arguments: {
                    text: "E2E_PREMATURE_PROOF_GATED_WRITE must be rejected before fetch.",
                  },
                },
                {
                  id: "playwright-e2e-proof-gated-search",
                  index: 1,
                  name: "web_search",
                  arguments: {
                    query: "E2E_PROOF_GATED_DEPENDENCY_WRITEBACK MCP servers",
                    max_results: 1,
                  },
                },
              ];
              return {
                message: { role: "assistant", content: "", toolCalls },
                toolCalls,
                raw: { playwrightE2E: true },
              };
            }

            if (!webSearchDone) {
              const toolCall = {
                id: "playwright-e2e-proof-gated-search",
                index: 0,
                name: "web_search",
                arguments: {
                  query: "E2E_PROOF_GATED_DEPENDENCY_WRITEBACK MCP servers",
                  max_results: 1,
                },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }

            if (!fetchDone) {
              const toolCall = {
                id: "playwright-e2e-proof-gated-fetch",
                index: 0,
                name: "web_fetch",
                arguments: {
                  url: "https://example.com/e2e-proof-gated-source",
                },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }

            return {
              message: {
                role: "assistant",
                content: "Fetched MCP evidence is ready for verified writeback.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_SOURCED_APPEND_MULTI_TOOL")) {
            const key = "E2E_SOURCED_APPEND_MULTI_TOOL";
            const sourcedAppendStep = sourcedAppendStepCounts.get(key) ?? 0;
            const missingTools = [
              "web_search",
              "web_fetch",
              "append_to_current_file",
            ].filter((toolName) => !toolNames.includes(toolName));
            if (missingTools.length > 0) {
              throw new Error(
                `sourced append tools were not available: ${missingTools.join(", ")}. Tools: ${toolNames.join(", ")}`,
              );
            }

            if (sourcedAppendStep === 0) {
              sourcedAppendStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-sourced-append-search",
                index: 0,
                name: "web_search",
                arguments: {
                  query: "E2E_SOURCED_APPEND_MULTI_TOOL MCP sources",
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

            if (sourcedAppendStep === 1) {
              sourcedAppendStepCounts.set(key, 2);
              const toolCall = {
                id: "playwright-e2e-sourced-append-fetch",
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

            sourcedAppendStepCounts.set(key, 3);
            return {
              message: {
                role: "assistant",
                content: "Fetched MCP evidence is ready for verified writeback.",
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          const deleteCurrentNoteWriteMarker =
            getDeleteCurrentNoteWriteMarker(latestUserText);
          if (deleteCurrentNoteWriteMarker) {
            const hasSuccessfulDeleteCurrentReplace = (request.messages ?? []).some(
              (message) => {
                const toolName = (message as { toolName?: string }).toolName;
                const content = String(message.content ?? "");
                return (
                  message.role === "tool" &&
                  (toolName === "replace_current_file" ||
                    content.includes('"toolName":"replace_current_file"')) &&
                  content.includes('"ok":true')
                );
              },
            );
            if (hasSuccessfulDeleteCurrentReplace) {
              return {
                message: {
                  role: "assistant",
                  content: `Done. Replaced the current note with a Grapes of Wrath essay containing ${deleteCurrentNoteWriteMarker}.`,
                },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }

            const replacementEssay = getGrapesReplacementEssay(
              deleteCurrentNoteWriteMarker,
            );
            if (!toolNames.includes("replace_current_file")) {
              throw new Error(
                `replace_current_file was not available for delete-current-note write. Tools: ${toolNames.join(", ")}`,
              );
            }

            const toolCall = {
              id: "playwright-e2e-delete-current-note-write",
              index: 0,
              name: "replace_current_file",
              arguments: {
                text: replacementEssay,
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

          if (latestUserText.includes(replaceMarker)) {
            const replacementEssay = getRenaissanceReplacementEssay(replaceMarker);
            if (toolNames.includes("replace_current_file")) {
              const toolCall = {
                id: "playwright-e2e-replace",
                index: 0,
                name: "replace_current_file",
                arguments: {
                  text: replacementEssay,
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
                content: replacementEssay,
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
            const key = "folder-traversal-other-notes";
            const step = folderTraversalStepCounts.get(key) ?? 0;
            if (step === 0 && toolNames.includes("inspect_vault_context")) {
              folderTraversalStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-folder-inspect-vault",
                index: 0,
                name: "inspect_vault_context",
                arguments: { scope: "other_folders" },
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
                content: `The other folder note says ${folderAnswerMarker}.`,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes("E2E_SEMANTIC_SEARCH")) {
            const key = `E2E_SEMANTIC_SEARCH:${folderAnswerMarker}`;
            const semanticStep = semanticSearchStepCounts.get(key) ?? 0;
            if (semanticStep > 1) {
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
              if (toolNames.includes("inspect_semantic_index")) {
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
                  `semantic search tools were not available. Tools: ${toolNames.join(", ")}`,
                );
              }
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

          if (latestUserText.includes("E2E_DEEP_VAULT_RESEARCH")) {
            const key = "E2E_DEEP_VAULT_RESEARCH";
            const step = deepVaultStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("semantic_search_notes")) {
                throw new Error(
                  `semantic_search_notes was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              deepVaultStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-deep-vault-search",
                index: 0,
                name: "semantic_search_notes",
                arguments: {
                  query: "E2E_DEEP_VAULT_TARGET local retrieval coverage",
                  folder: "E2E Agent Tests/Scaled Vault",
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

            if (step === 1) {
              // Expansion coaching may be absent if the first search already used
              // deep/exact coverage; still request the deep second pass.
              deepVaultStepCounts.set(key, 2);
              const toolCall = {
                id: "playwright-e2e-deep-vault-search-expanded",
                index: 0,
                name: "semantic_search_notes",
                arguments: {
                  query: "E2E_DEEP_VAULT_TARGET local retrieval coverage",
                  folder: "E2E Agent Tests/Scaled Vault",
                  mode: "deep",
                  candidateLimit: 128,
                  limit: 8,
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

            if (step === 2) {
              if (!toolNames.includes("read_markdown_files")) {
                throw new Error(
                  `read_markdown_files was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              deepVaultStepCounts.set(key, 3);
              const toolCall = {
                id: "playwright-e2e-deep-vault-read",
                index: 0,
                name: "read_markdown_files",
                arguments: {
                  paths: ["E2E Agent Tests/Scaled Vault/scaled-042.md"],
                  maxCharsPerFile: 1200,
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
                content: (() => {
                  const passageIds = [
                    ...new Set(
                      Array.from(
                        requestText.matchAll(
                          /source:[A-Za-z0-9]+:passage:\d+-\d+/g,
                        ),
                        (match) => match[0],
                      ),
                    ),
                  ];
                  const vaultPaths = [
                    ...new Set(
                      Array.from(
                        requestText.matchAll(
                          /E2E Agent Tests\/Scaled Vault\/scaled-\d+\.md/g,
                        ),
                        (match) => match[0],
                      ),
                    ),
                  ];
                  const citationIds = [
                    ...passageIds.slice(0, 4),
                    ...vaultPaths.slice(0, 2),
                  ];
                  const citation = citationIds[0] ? ` [${citationIds[0]}]` : "";
                  const evidenceWindows = citationIds.length
                    ? `\n\nEvidence windows: ${citationIds.map((id) => `[${id}]`).join(" ")}.`
                    : "";
                  return (
                    "E2E_DEEP_VAULT_DONE Local evidence includes E2E_DEEP_VAULT_TARGET note discussing local retrieval, evidence coverage, and semantic expansion" +
                    `${citation}.${evidenceWindows}\n\nLimitations: sampled e2e vault.\n\nConfidence: high.`
                  );
                })(),
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

          if (latestUserText.includes("E2E_GOVERNMENT_BRANCH_CANVAS")) {
            if (!toolNames.includes("create_design_canvas")) {
              throw new Error(
                `create_design_canvas was not available for a government branch diagram. Tools: ${toolNames.join(", ")}`,
              );
            }

            const toolCall = {
              id: "playwright-e2e-government-branch-canvas",
              index: 0,
              name: "create_design_canvas",
              arguments: {
                path: designCanvasPath,
                title: "United States Branches of Government",
                diagramType: "architecture",
                direction: "row",
                items: [
                  {
                    id: "legislative",
                    title: "Legislative",
                    text: "Congress writes laws and controls appropriations.",
                    kind: "branch",
                    lane: "Article I",
                  },
                  {
                    id: "executive",
                    title: "Executive",
                    text: "The President executes and enforces laws.",
                    kind: "branch",
                    lane: "Article II",
                  },
                  {
                    id: "judicial",
                    title: "Judicial",
                    text: "Federal courts interpret laws and the Constitution.",
                    kind: "branch",
                    lane: "Article III",
                  },
                ],
                connections: [
                  { from: "legislative", to: "executive", label: "checks" },
                  { from: "executive", to: "judicial", label: "checks" },
                  { from: "judicial", to: "legislative", label: "checks" },
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

          if (latestUserText.includes("E2E_DESIGN_GRAPH")) {
            if (!toolNames.includes("create_design_canvas")) {
              throw new Error(
                `create_design_canvas was not available for a design graph conversion. Tools: ${toolNames.join(", ")}`,
              );
            }

            const toolCall = {
              id: "playwright-e2e-design-graph",
              index: 0,
              name: "create_design_canvas",
              arguments: {
                path: designCanvasPath,
                title: "The First Five Laws of Power",
                diagramType: "mind_map",
                items: [
                  {
                    id: "goal",
                    title: "Power & Control",
                    text: "The central objective shared by the five laws.",
                    color: "6",
                  },
                  {
                    id: "law-1",
                    title: "Never Outshine the Master",
                    text: "Manage the ego of those above you.",
                    color: "4",
                  },
                  {
                    id: "law-2",
                    title: "Never Put Too Much Trust in Friends",
                    text: "Limit the risk of familiarity and betrayal.",
                    color: "4",
                  },
                  {
                    id: "law-3",
                    title: "Conceal Your Intentions",
                    text: "Preserve strategic secrecy.",
                    color: "5",
                  },
                  {
                    id: "law-4",
                    title: "Always Say Less Than Necessary",
                    text: "Use restraint to protect intent.",
                    color: "5",
                  },
                  {
                    id: "law-5",
                    title: "Guard Your Reputation",
                    text: "Protect the foundation of influence.",
                    color: "4",
                  },
                ],
                connections: [
                  { from: "goal", to: "law-1", label: "requires" },
                  { from: "goal", to: "law-2", label: "requires" },
                  { from: "goal", to: "law-3", label: "requires" },
                  { from: "goal", to: "law-4", label: "requires" },
                  { from: "goal", to: "law-5", label: "requires" },
                  { from: "law-1", to: "law-5", label: "protects" },
                  { from: "law-2", to: "law-3", label: "necessitates" },
                  { from: "law-3", to: "law-4", label: "supports" },
                  { from: "law-4", to: "law-3", label: "enhances" },
                  { from: "law-5", to: "goal", label: "creates" },
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
                title: "Agent Architecture",
                diagramType: "architecture",
                items: [
                  {
                    id: "user",
                    title: "User",
                    kind: "actor",
                    lane: "Client",
                    text: "User submits a mission.",
                    color: "4",
                  },
                  {
                    id: "runner",
                    title: "Agent Runner",
                    kind: "service",
                    lane: "Application",
                    text: "Plans steps and routes tools.",
                    color: "5",
                  },
                  {
                    id: "tools",
                    title: "Tool Registry",
                    kind: "service",
                    lane: "Application",
                    text: "Executes validated design tools.",
                    color: "6",
                  },
                  {
                    id: "vault",
                    title: "Obsidian Vault",
                    kind: "database",
                    lane: "Data",
                    text: "Stores notes, canvases, and SVG artifacts.",
                    color: "5",
                  },
                ],
                connections: [
                  { from: "user", to: "runner", label: "mission" },
                  { from: "runner", to: "tools", label: "tool call" },
                  { from: "tools", to: "vault", label: "safe write" },
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

          if (
            latestUserText.includes("E2E_SVG_REVISE_UPDATE") ||
            requestText.includes("E2E_SVG_REVISE_UPDATE")
          ) {
            const key = "E2E_SVG_REVISE_UPDATE";
            const step = designReviseStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("read_svg_design")) {
                throw new Error(
                  `read_svg_design was not available for SVG revision. Tools: ${toolNames.join(", ")}`,
                );
              }
              designReviseStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-svg-revise-read",
                index: 0,
                name: "read_svg_design",
                arguments: { path: designSvgPath },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }
            if (!toolNames.includes("update_svg_design")) {
              throw new Error(
                `update_svg_design was not available for SVG revision. Tools: ${toolNames.join(", ")}`,
              );
            }
            const hashes = [...requestText.matchAll(
              /"sha256"\s*:\s*"(sha256:[a-f0-9]{64})"/gu,
            )].map((match) => match[1]);
            const baseHash = hashes[hashes.length - 1];
            if (!baseHash) {
              throw new Error("read_svg_design result did not expose its SHA-256.");
            }
            designReviseStepCounts.set(key, 2);
            const toolCall = {
              id: "playwright-e2e-svg-revise-update",
              index: 0,
              name: "update_svg_design",
              arguments: {
                path: designSvgPath,
                baseHash,
                operations: [
                  {
                    op: "update_text",
                    id: "svg-title",
                    text: "Revised SVG Title",
                  },
                ],
              },
            };
            return {
              message: { role: "assistant", content: "", toolCalls: [toolCall] },
              toolCalls: [toolCall],
              raw: { playwrightE2E: true },
            };
          }

          if (
            latestUserText.includes("E2E_MERMAID_REVISE_UPDATE") ||
            requestText.includes("E2E_MERMAID_REVISE_UPDATE")
          ) {
            const key = "E2E_MERMAID_REVISE_UPDATE";
            const step = designReviseStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("read_mermaid_block")) {
                throw new Error(
                  `read_mermaid_block was not available for Mermaid revision. Tools: ${toolNames.join(", ")}`,
                );
              }
              designReviseStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-mermaid-revise-read",
                index: 0,
                name: "read_mermaid_block",
                arguments: {
                  path: designMermaidPath,
                  selector: { kind: "block_id", blockId: "flow-main" },
                },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }
            if (!toolNames.includes("upsert_mermaid_block")) {
              throw new Error(
                `upsert_mermaid_block was not available for Mermaid revision. Tools: ${toolNames.join(", ")}`,
              );
            }
            const hashes = [...requestText.matchAll(
              /"sha256"\s*:\s*"(sha256:[a-f0-9]{64})"/gu,
            )].map((match) => match[1]);
            const baseHash = hashes[hashes.length - 1];
            if (!baseHash) {
              throw new Error("read_mermaid_block result did not expose its SHA-256.");
            }
            designReviseStepCounts.set(key, 2);
            const toolCall = {
              id: "playwright-e2e-mermaid-revise-update",
              index: 0,
              name: "upsert_mermaid_block",
              arguments: {
                path: designMermaidPath,
                baseHash,
                selector: { kind: "block_id", blockId: "flow-main" },
                mermaid: "flowchart LR\n  A[Revised Mermaid Start] --> B[Verified Finish]",
              },
            };
            return {
              message: { role: "assistant", content: "", toolCalls: [toolCall] },
              toolCalls: [toolCall],
              raw: { playwrightE2E: true },
            };
          }

          if (
            latestUserText.includes("E2E_DESIGN_REVISE_UPDATE") ||
            requestText.includes("E2E_DESIGN_REVISE_UPDATE")
          ) {
            const key = "E2E_DESIGN_REVISE_UPDATE";
            const step = designReviseStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("read_design_canvas")) {
                throw new Error(
                  `read_design_canvas was not available for revise precondition read. Tools: ${toolNames.join(", ")}`,
                );
              }
              designReviseStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-design-revise-read",
                index: 0,
                name: "read_design_canvas",
                arguments: { path: designCanvasPath },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightE2E: true },
              };
            }
            if (!toolNames.includes("update_design_canvas")) {
              throw new Error(
                `update_design_canvas was not available for revise update. Tools: ${toolNames.join(", ")}`,
              );
            }
            const hashes = [...requestText.matchAll(
              /"sha256"\s*:\s*"(sha256:[a-f0-9]{64})"/gu,
            )].map((match) => match[1]);
            const baseHash = hashes[hashes.length - 1];
            if (!baseHash) {
              throw new Error("read_design_canvas result did not expose its SHA-256.");
            }
            designReviseStepCounts.set(key, 2);
            const toolCall = {
              id: "playwright-e2e-design-revise-update",
              index: 0,
              name: "update_design_canvas",
              arguments: {
                path: designCanvasPath,
                baseHash,
                operations: [
                  {
                    op: "update_node",
                    id: "canvas-title",
                    changes: {
                      text: "# Revised Canvas Title",
                      color: "3",
                    },
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

          if (latestUserText.includes("E2E_DESIGN_REVISE_CREATE")) {
            if (!toolNames.includes("create_design_canvas")) {
              throw new Error(
                `create_design_canvas was not available for revise create. Tools: ${toolNames.join(", ")}`,
              );
            }
            const toolCall = {
              id: "playwright-e2e-design-revise-create",
              index: 0,
              name: "create_design_canvas",
              arguments: {
                path: designCanvasPath,
                title: "Original Canvas Title",
                items: [
                  {
                    title: "Start",
                    text: "Original canvas node for revise e2e.",
                    color: "4",
                  },
                  {
                    title: "Finish",
                    text: "Second original node.",
                    color: "5",
                  },
                ],
                connect: "sequence",
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
            (latestUserText.includes("E2E_DESIGN_REVISE") ||
              requestText.includes("E2E_DESIGN_REVISE")) &&
            !latestUserText.includes("E2E_DESIGN_REVISE_UPDATE") &&
            !latestUserText.includes("E2E_DESIGN_REVISE_CREATE")
          ) {
            const key = "E2E_DESIGN_REVISE";
            const step = designReviseStepCounts.get(key) ?? 0;
            if (step === 0 && toolNames.includes("create_design_canvas")) {
              designReviseStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-design-revise-create-multi",
                index: 0,
                name: "create_design_canvas",
                arguments: {
                  path: designCanvasPath,
                  title: "Original Canvas Title",
                  items: [
                    {
                      title: "Start",
                      text: "Original canvas node for revise e2e.",
                      color: "4",
                    },
                    {
                      title: "Finish",
                      text: "Second original node.",
                      color: "5",
                    },
                  ],
                  connect: "sequence",
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
            if (toolNames.includes("update_design_canvas")) {
              designReviseStepCounts.set(key, 2);
              const toolCall = {
                id: "playwright-e2e-design-revise-update-multi",
                index: 0,
                name: "update_design_canvas",
                arguments: {
                  path: designCanvasPath,
                  title: "Revised Canvas Title",
                  items: [
                    {
                      title: "Revised Start",
                      text: "Updated canvas node after revise.",
                      color: "3",
                    },
                    {
                      title: "Revised Finish",
                      text: "Updated second node.",
                      color: "6",
                    },
                  ],
                  connect: "sequence",
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
                  "E2E_DESIGN_REVISE_DONE canvas created then revised in place with backup.",
              },
              toolCalls: [],
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
                    type: "diamond",
                    x: 330,
                    y: 118,
                    width: 120,
                    height: 90,
                    label: "Policy",
                  },
                  {
                    type: "cylinder",
                    x: 500,
                    y: 112,
                    width: 130,
                    height: 110,
                    label: "Vault",
                  },
                  {
                    type: "ellipse",
                    cx: 560,
                    cy: 286,
                    rx: 78,
                    ry: 36,
                    label: "Model API",
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

          if (latestUserText.includes("E2E_DELETE_DENY")) {
            const key = `E2E_DELETE_DENY:${marker}`;
            const step = deleteDenyStepCounts.get(key) ?? 0;
            if (step === 0) {
              if (!toolNames.includes("delete_path")) {
                throw new Error(
                  `delete_path was not available for ${key}. Tools: ${toolNames.join(", ")}`,
                );
              }
              deleteDenyStepCounts.set(key, 1);
              const toolCall = {
                id: "playwright-e2e-delete-deny",
                index: 0,
                name: "delete_path",
                arguments: {
                  path: `E2E Agent Tests/CRUD Denial/delete-deny-${marker}.md`,
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
                  "E2E_DELETE_DENY_DONE the prepared delete was not applied because final approval was denied.",
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

          if (
            latestUserText.includes(streamChunkOne) &&
            latestUserText.includes(streamChunkTwo) &&
            !toolNames.includes("append_to_current_file")
          ) {
            return {
              message: {
                role: "assistant",
                content: `${streamChunkOne}\n${streamChunkTwo}\n`,
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
          if (requestText.includes("E2E_DIRECT_USER_ROLE_WRITEBACK")) {
            const lastMessage = request.messages?.at(-1);
            if (
              lastMessage?.role !== "user" ||
              !String(lastMessage.content ?? "").includes("OUTPUT CONTRACT")
            ) {
              throw new Error(
                "direct writeback output contract must be the final user turn",
              );
            }
            const marker =
              /E2E_DIRECT_USER_ROLE_WRITEBACK_[A-Za-z0-9_]+/.exec(
                requestText,
              )?.[0] ?? "E2E_DIRECT_USER_ROLE_WRITEBACK_MISSING";
            const content = `# Direct Writeback Status\n\n${marker}\n\nThe project remains on track.`;
            events?.onContentDelta?.(content);
            return {
              message: { role: "assistant", content },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }
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

          if (requestText.includes("E2E_SOURCED_APPEND_MULTI_TOOL")) {
            const originatingMissionText =
              request.messages?.find(
                (message) =>
                  message.role === "user" &&
                  String(message.content ?? "").includes(
                    "E2E_SOURCED_APPEND_MULTI_TOOL",
                  ),
              )?.content ?? requestText;
            const marker =
              /E2E_SOURCED_APPEND_MULTI_TOOL_[A-Za-z0-9_]+/.exec(
                originatingMissionText,
              )?.[0] ?? "E2E_SOURCED_APPEND_MULTI_TOOL_MISSING";
            const passageId =
              /source:[A-Za-z0-9]+:passage:\d+-\d+/.exec(requestText)?.[0] ?? "";
            if (!passageId) {
              throw new Error(
                "sourced append writeback request omitted fetched passage proof",
              );
            }
            const content = `${marker}: Alpha evidence shows the test topic finding [${passageId}].\n\nAlpha evidence shows the test topic finding in the fetched MCP source. Source: https://alpha.example.com/deep-source [${passageId}]`;
            const splitAt = Math.max(1, Math.floor(content.length / 2));
            events?.onContentDelta?.(content.slice(0, splitAt));
            await new Promise((resolve) => setTimeout(resolve, 100));
            events?.onContentDelta?.(content.slice(splitAt));
            return {
              message: { role: "assistant", content },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          // emitFinalAnswer appends its writeback instruction as the latest
          // user turn. Match the complete request transcript so this fixture
          // remains bound to the originating mission instead of whichever
          // internal instruction happens to be last.
          if (requestText.includes("E2E_PROOF_GATED_DEPENDENCY_WRITEBACK")) {
            const key = "E2E_PROOF_GATED_DEPENDENCY_WRITEBACK";
            const originatingMissionText =
              request.messages?.find(
                (message) =>
                  message.role === "user" &&
                  String(message.content ?? "").includes(key),
              )?.content ?? requestText;
            const step = proofGatedStreamStepCounts.get(key) ?? 0;
            proofGatedStreamStepCounts.set(key, step + 1);
            if (step === 0) {
              const content =
                "E2E_INVALID_UNCITED_PROOF_DRAFT MCP servers expose tools, but this draft has no bound citation.";
              events?.onContentDelta?.(content);
              return {
                message: { role: "assistant", content },
                toolCalls: [],
                raw: { playwrightE2E: true },
              };
            }

            const obsidianWindow = window as typeof window & { app?: any };
            const activeFile = obsidianWindow.app?.workspace?.getActiveFile?.();
            const noteBeforeCorrection = activeFile
              ? await obsidianWindow.app.vault.read(activeFile)
              : "";
            const expectedOriginal =
              "E2E proof gate original note must remain byte-identical before commit.";
            if (noteBeforeCorrection !== expectedOriginal) {
              throw new Error(
                `proof-gated draft mutated the note before verification: ${noteBeforeCorrection}`,
              );
            }

            const passageId =
              /source:[A-Za-z0-9]+:passage:\d+-\d+/.exec(requestText)?.[0] ?? "";
            if (!passageId) {
              throw new Error("proof-gated correction request omitted fetched passage proof");
            }
            const marker =
              /E2E_PROOF_GATED_COMMIT_[A-Za-z0-9_]+/.exec(originatingMissionText)?.[0] ??
              "E2E_PROOF_GATED_COMMIT_MISSING";
            const content = `${marker}\n\nMCP servers expose tools and resources through a standard protocol. Source: https://example.com/e2e-proof-gated-source Passage evidence: [${passageId}]`;
            events?.onContentDelta?.(content);
            return {
              message: { role: "assistant", content },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (requestText.includes("E2E_CURRENT_MARKET_WRITEBACK")) {
            const originatingMissionText =
              request.messages?.find(
                (message) =>
                  message.role === "user" &&
                  String(message.content ?? "").includes("E2E_CURRENT_MARKET_WRITEBACK"),
              )?.content ?? requestText;
            const marker =
              /E2E_CURRENT_MARKET_WRITEBACK_[A-Za-z0-9_]+/.exec(
                originatingMissionText,
              )?.[0] ?? "E2E_CURRENT_MARKET_WRITEBACK_MISSING";
            const passageIds = Array.from(
              requestText.matchAll(/source:[A-Za-z0-9]+:passage:\d+-\d+/g),
              (match) => match[0],
            );
            const content = `# Software project

${marker}

## Market Overview

Current online dating market and social media market findings were organized after web fallback.

## Source Notes

- Online dating market source: https://example.com/current-dating-market
- Social media market source: https://example.org/current-social-market
- Cross-market source: https://research.example.net/current-market-overview

Passage evidence: ${passageIds.map((passageId) => `[${passageId}]`).join(", ")}

Limitations: mocked e2e current-market sources only.

Confidence: high for deterministic workflow coverage.
`;
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

          if (requestText.includes("E2E_STREAM_PLACEHOLDER_TITLE")) {
            const content =
              '# Hello World in TypeScript\n\n```ts\nconsole.log("Hello, world!");\n```\n';
            events?.onContentDelta?.(content.slice(0, 28));
            await new Promise((resolve) => setTimeout(resolve, 200));
            events?.onContentDelta?.(content.slice(28));
            return {
              message: {
                role: "assistant",
                content,
              },
              toolCalls: [],
              raw: { playwrightE2E: true },
            };
          }

          if (latestUserText.includes(replaceMarker)) {
            const content = getRenaissanceReplacementEssay(replaceMarker);
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
              document.includes(folderAnswerMarker) ||
              /notes say|related ideas|conceptually/i.test(document)
                ? [1, 0]
                : [0, 1],
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

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((app.workspace.getLeavesOfType?.("agentic-researcher-view") ?? []).length === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const viewLifecycleErrors: string[] = [];
    const captureError = (event: ErrorEvent) =>
      viewLifecycleErrors.push(event.error?.stack ?? event.message);
    const captureRejection = (event: PromiseRejectionEvent) =>
      viewLifecycleErrors.push(
        event.reason instanceof Error ? event.reason.stack ?? event.reason.message : String(event.reason),
      );
    window.addEventListener("error", captureError);
    window.addEventListener("unhandledrejection", captureRejection);
    await plugin.activateView();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((app.workspace.getLeavesOfType?.("agentic-researcher-view") ?? []).length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (attempt === 19) {
        await plugin.activateView();
      }
    }
    if ((app.workspace.getLeavesOfType?.("agentic-researcher-view") ?? []).length === 0) {
      throw new Error("Agentic Researcher view did not reopen after stale-view cleanup.");
    }
    window.removeEventListener("error", captureError);
    window.removeEventListener("unhandledrejection", captureRejection);
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
        maxAgentSteps: 100,
        streamWritebackMode: "all_current_note_content_writes",
      };
    } else {
      activePlugin.settings = {
        ...activePlugin.settings,
        enableStreaming: false,
        thinkingMode: "off",
        model: "playwright-e2e-mock",
        ollamaBaseUrl: "http://127.0.0.1:11434",
        ollamaApiKey: "",
        semanticEmbeddingModel:
          semanticEmbeddingConfig.mode === "ollama"
            ? semanticEmbeddingConfig.model
            : activePlugin.settings.semanticEmbeddingModel,
        maxAgentSteps: 100,
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
      obsidianWindow.__e2eInstallAgentMockOverrides = () => {
        const restartedPlugin = app.plugins.plugins?.[pluginId];
        installMockOverrides(restartedPlugin);
        for (const leaf of app.workspace.getLeavesOfType?.("agentic-researcher-view") ?? []) {
          installMockOverrides(leaf.view?.plugin);
        }
      };
    }

    const mountedAgentLeaves = app.workspace.getLeavesOfType?.(
      "agentic-researcher-view",
    ) ?? [];
    if (!document.querySelector(".agentic-researcher-view")) {
      throw new Error(
        `Agent view leaf exists without mounted content: ${JSON.stringify(
          mountedAgentLeaves.map((leaf: any) => ({
            connected: Boolean(leaf?.view?.containerEl?.isConnected),
            viewType: leaf?.view?.getViewType?.() ?? leaf?.view?.getViewType,
            viewClass: leaf?.view?.constructor?.name ?? "unknown",
            stateType: leaf?.getViewState?.()?.type ?? "unknown",
            contentClasses: leaf?.view?.contentEl?.className ?? "",
            contentChildren: leaf?.view?.contentEl?.childElementCount ?? -1,
            contentText: leaf?.view?.contentEl?.textContent?.slice(0, 500) ?? "",
            contentHtml: leaf?.view?.contentEl?.innerHTML?.slice(0, 1_000) ?? "",
            viewKeys: Object.keys(leaf?.view ?? {}).sort(),
            hasOnOpen: typeof leaf?.view?.onOpen === "function",
            samePlugin: leaf?.view?.plugin === plugin,
            coreStillSame: app.plugins.plugins?.[pluginId] === plugin,
            registeredAsActive: plugin?.activeAgentView === leaf?.view,
          })),
        )}; lifecycle=${JSON.stringify(viewLifecycleErrors)}`,
      );
    }

    return {
      // The right-side agent leaf is expected to own focus. Verify the
      // plugin's preserved markdown context, which is the production source
      // of truth while users type in that pane.
      activeFilePath:
        plugin.getCurrentMarkdownFile?.()?.path ??
        plugin.resolveCurrentMarkdownFile?.()?.path ??
        app.workspace.getActiveFile()?.path ??
        "",
      pluginId,
    };

    async function ensurePluginLoaded(app: any, pluginId: string) {
      let plugin = app.plugins.plugins[pluginId];
      if (plugin) {
        return waitForCorePluginReady(app, pluginId, plugin);
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
      }
      if (
        !app.plugins.plugins?.[pluginId] &&
        typeof app.plugins.loadPlugin === "function"
      ) {
        await app.plugins.loadPlugin(pluginId);
      } else if (
        !app.plugins.plugins?.[pluginId] &&
        typeof app.plugins.enablePlugin !== "function"
      ) {
        throw new Error("Obsidian plugin loader API is unavailable.");
      }

      for (let attempt = 0; attempt < 40; attempt += 1) {
        plugin = app.plugins.plugins[pluginId];
        if (plugin) {
          return waitForCorePluginReady(app, pluginId, plugin);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      throw new Error(
        `Plugin did not load after enabling: ${pluginId}; ${JSON.stringify({
          manifestPresent: Boolean(app.plugins.manifests?.[pluginId]),
          enabled:
            app.plugins.enabledPlugins?.has?.(pluginId) ??
            app.plugins.enabledPlugins?.includes?.(pluginId) ??
            null,
          safeMode: app.plugins.safeMode ?? null,
          restrictedMode: app.plugins.restrictedMode ?? null,
          managerLoaded: app.plugins._loaded ?? null,
          bodyText: document.body?.innerText?.slice(0, 1_500) ?? "",
          managerMethods: Object.getOwnPropertyNames(
            Object.getPrototypeOf(app.plugins) ?? {},
          ).sort(),
        })}`,
      );
    }

    async function waitForCorePluginReady(
      app: any,
      pluginId: string,
      initialPlugin: any,
    ) {
      let candidate = initialPlugin;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        candidate = app.plugins.plugins?.[pluginId] ?? candidate;
        if (candidate?.agenticResearcherApi?.state === "ready") {
          return candidate;
        }
        if (candidate?.agenticResearcherApi?.state === "unloading") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      throw new Error(
        `Agentic Researcher core did not become ready: ${JSON.stringify({
          apiState: candidate?.agenticResearcherApi?.state ?? "missing",
          startupPhase: candidate?.startupPhase ?? "missing",
          startupFailure: candidate?.startupFailure ?? "missing",
          startupExistingViewCreator:
            candidate?.startupExistingViewCreator ?? "missing",
          obsidianLoadedFlag: candidate?._loaded ?? "missing",
          pluginLoaded: Boolean(app.plugins.plugins?.[pluginId]),
          pluginEnabled:
            app.plugins.enabledPlugins?.has?.(pluginId) ??
            app.plugins.enabledPlugins?.includes?.(pluginId) ??
            "unknown",
          extensionMigrationMode: candidate?.extensionStateMigration?.mode ?? "missing",
          extensionMigrationStatuses: candidate?.extensionStateMigration?.namespaces
            ? Object.fromEntries(
                Object.entries(candidate.extensionStateMigration.namespaces).map(
                  ([namespace, state]: [string, any]) => [namespace, state?.status],
                ),
              )
            : "missing",
          pluginDataMigrationHash:
            candidate?.pluginDataV3Migration?.integrityHash ?? "missing",
          settingsSchemaVersion:
            candidate?.settings?.settingsSchemaVersion ?? "missing",
          pluginKeys: Object.keys(candidate ?? {}).sort(),
        })}`,
      );
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
          const testOwnedPath =
            path.startsWith("E2E Agent Tests/") ||
            path.startsWith("Agent Memory/") ||
            path.startsWith("Designs/e2e-");
          if (!testOwnedPath || !app.vault.adapter?.remove) {
            throw error;
          }
          // A prior interrupted Obsidian run can leave a test-owned file on
          // disk before the new vault index observes it. Remove only that
          // bounded fixture path, then recreate it through Vault so the index
          // and filesystem become consistent again.
          await app.vault.adapter.remove(path);
          const indexedAfterRemove = app.vault.getAbstractFileByPath(path);
          if (indexedAfterRemove) {
            await app.vault.modify(indexedAfterRemove, text);
            return indexedAfterRemove;
          }
          return app.vault.create(path, text);
        }
      }
    }

    function getRenaissanceReplacementEssay(marker: string): string {
      return [
        "# The Renaissance",
        "",
        `${marker}`,
        "",
        "The Renaissance was a period of renewal that changed European art, learning, politics, and daily imagination. It did not simply copy the ancient world; it used Greek and Roman examples to ask new questions about human ability, civic life, beauty, and evidence. Humanism gave scholars and artists a language for studying history, rhetoric, poetry, and moral choice while still working inside a deeply religious culture.",
        "",
        "In Italian cities such as Florence, Venice, and Rome, merchants, guilds, princes, and popes funded painters, architects, and writers because culture displayed power as clearly as armies or walls. Patronage helped Brunelleschi experiment with architecture, Leonardo investigate anatomy and motion, Michelangelo connect physical strength with spiritual drama, and Raphael create balanced scenes of learning and faith. Perspective, proportion, and close observation made paintings feel like ordered spaces rather than flat symbols.",
        "",
        "The movement also changed how knowledge traveled. Printing made books cheaper, more consistent, and easier to debate across borders. Students could compare editions of classical texts, reformers could circulate arguments, and scientists could preserve diagrams and measurements. This did not make Europe modern overnight, but it built habits of criticism and exchange that mattered later.",
        "",
        "The Renaissance was uneven. Its wealth depended on hierarchy, colonial expansion, gender limits, and political rivalry. Still, its lasting importance comes from the way it joined imagination with disciplined study. It showed that people could honor inherited tradition while revising it, and that art, language, and inquiry could reshape how a society understood the human person. That balance of recovery and invention is why the era remains central to explanations of cultural change across Europe and beyond.",
        "",
      ].join("\n");
    }

    function getDeleteCurrentNoteWriteMarker(text: string): string | null {
      const lower = text.toLowerCase();
      if (
        !lower.includes("delete the current note") ||
        !lower.includes("ensure that the space is empty") ||
        !lower.includes("grapes of wrath")
      ) {
        return null;
      }

      return text.match(/\bE2E_DELETE_CURRENT_WRITE_[A-Za-z0-9_-]+\b/)?.[0] ?? null;
    }

    function getGrapesReplacementEssay(marker: string): string {
      return [
        "# Grapes of Wrath",
        "",
        `${marker}`,
        "",
        "John Steinbeck's Grapes of Wrath follows the Joad family as drought, debt, and mechanized farming push them away from Oklahoma and toward California. The novel is not only a migration story. It is also an argument about what happens when land, labor, and law stop protecting ordinary people. By showing families uprooted by the Dust Bowl and then exploited by growers who control wages, Steinbeck turns private hardship into a public indictment.",
        "",
        "The book's power comes from the way it joins personal scenes with broad social chapters. Tom Joad's return from prison gives the story a human center, while Ma's practical courage keeps the family moving after each loss. Around them, interchapters describe banks, tractors, police, camps, and markets as forces larger than any one character. That structure makes the Joads representative without making them abstract. Their hunger, grief, humor, and anger remain specific.",
        "",
        "Grapes of Wrath also changes the meaning of survival. At first, the family hopes that work in California will restore the old dream of independence. Instead, they find that isolated families can be broken one by one. The novel gradually points toward solidarity: shared meals, strike talk, government camps, and Tom's decision to carry forward Casy's belief in collective action. Hope becomes less about individual escape and more about mutual responsibility.",
        "",
        "Steinbeck makes that argument persuasive by refusing to sentimentalize the migrants. The Joads argue, doubt, make mistakes, and sometimes act from fear. Yet the novel keeps returning to their capacity for care under pressure. Ma's steadiness, Tom's growth, and Casy's sacrifice show that moral strength is built through choices made in crisis, not through speeches alone.",
        "",
        "That is why the ending still matters. Rose of Sharon's final act does not solve poverty, but it rejects the idea that suffering people must compete for scraps. Steinbeck suggests that dignity survives when people see one another clearly and act together. The novel remains urgent because it asks whether an economy that produces abundance can also produce justice.",
        "",
      ].join("\n");
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
        return "   # Harvest of Injustice #\n\nGrapes of Wrath stream-title essay: the Dust Bowl, migration, and labor exploitation force the Joad family toward collective survival.\n";
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
        const body = typeof request?.body === "string" ? request.body : "";
        const query = (() => {
          try {
            const parsed = JSON.parse(body) as { query?: unknown };
            return typeof parsed.query === "string" ? parsed.query : "";
          } catch {
            return "";
          }
        })();
        if (query.includes("E2E_LONG_RUN_REQUIRED_TOOL_FAILURE")) {
          return {
            status: 500,
            json: {
              error: "forced required-tool failure for long-run continuation e2e",
            },
            text: "",
          };
        }
        if (query.includes("E2E_PROOF_GATED_DEPENDENCY_WRITEBACK")) {
          return {
            status: 200,
            json: {
              results: [
                {
                  title: "E2E MCP Proof-Gated Source",
                  url: "https://example.com/e2e-proof-gated-source",
                  snippet:
                    "MCP servers expose tools and resources through a standard protocol.",
                },
              ],
            },
            text: "",
          };
        }
        if (query.includes("E2E_QUOTE_VERIFY_MISSION")) {
          return {
            status: 200,
            json: {
              results: [
                {
                  title: "E2E Quote Verify Source",
                  url: "https://example.com/e2e-quote-verify-source",
                  snippet: "E2E_QUOTE_VERIFY_MISSION quotation source.",
                },
                {
                  title: "E2E Quote Corroboration Beta",
                  url: "https://beta.example.org/deep-source",
                  snippet: "E2E_QUOTE_VERIFY_MISSION corroborating quotation source.",
                },
                {
                  title: "E2E Quote Corroboration Gamma",
                  url: "https://gamma.example.net/deep-source",
                  snippet: "E2E_QUOTE_VERIFY_MISSION corroborating quotation source.",
                },
              ],
            },
            text: "",
          };
        }
        if (query.includes("E2E_SOURCE_CACHE")) {
          return {
            status: 200,
            json: {
              results: [
                {
                  title: "E2E Cache Source",
                  url: "https://example.com/e2e-cache-source",
                  snippet: "E2E_SOURCE_CACHE search result snippet.",
                },
              ],
            },
            text: "",
          };
        }

        if (query.includes("E2E_RESEARCH_TEAM")) {
          return {
            status: 200,
            json: {
              results: [
                {
                  title: "E2E Research Team Source",
                  url: "https://alpha.example.com/research-team-source",
                  snippet: "E2E_RESEARCH_TEAM researcher source snippet.",
                },
              ],
            },
            text: "",
          };
        }

        if (query.includes("E2E_AUTO_FOLLOWUP_SOURCE")) {
          return {
            status: 200,
            json: {
              results: [
                {
                  title: "E2E Auto Followup Source",
                  url: "https://example.com/e2e-auto-followup-source",
                  snippet: "E2E_AUTO_FOLLOWUP_SOURCE search result snippet.",
                },
              ],
            },
            text: "",
          };
        }

        if (query.includes("E2E_WEB_LEDGER_SOURCE")) {
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

        if (
          query.includes("E2E_CURRENT_MARKET_WRITEBACK") ||
          /current\s+online\s+dating\s+market/i.test(query) ||
          /social\s+media\s+market/i.test(query)
        ) {
          return {
            status: 200,
            json: {
              results: [
                {
                  title: "E2E Current Dating Market",
                  url: "https://example.com/current-dating-market",
                  snippet: "E2E_CURRENT_MARKET_SOURCE search result for online dating.",
                },
                {
                  title: "E2E Current Social Market",
                  url: "https://example.org/current-social-market",
                  snippet: "E2E_CURRENT_MARKET_SOURCE search result for social media.",
                },
                {
                  title: "E2E Current Cross-Market Overview",
                  url: "https://research.example.net/current-market-overview",
                  snippet: "E2E_CURRENT_MARKET_SOURCE cross-market comparison result.",
                },
              ],
            },
            text: "",
          };
        }

        return {
          status: 200,
          json: {
            results: [
              {
                title: "E2E Deep Alpha",
                url: "https://alpha.example.com/deep-source",
                snippet: "E2E_DEEP_WEB_RESEARCH alpha source.",
              },
              {
                title: "E2E Deep Beta",
                url: "https://beta.example.org/deep-source",
                snippet: "E2E_DEEP_WEB_RESEARCH beta source.",
              },
              {
                title: "E2E Deep Gamma",
                url: "https://gamma.example.net/deep-source",
                snippet: "E2E_DEEP_WEB_RESEARCH gamma source.",
              },
              {
                title: "E2E Quote Verify Source",
                url: "https://example.com/e2e-quote-verify-source",
                snippet: "E2E_QUOTE_VERIFY_MISSION quotation source.",
              },
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
        const body = typeof request?.body === "string" ? request.body : "";
        const requestedUrl = (() => {
          try {
            const parsed = JSON.parse(body) as { url?: unknown };
            return typeof parsed.url === "string" ? parsed.url : "";
          } catch {
            return "";
          }
        })();
        if (requestedUrl.includes("e2e-cache-source")) {
          const mockWindow = window as typeof window & {
            __e2eCacheSourceNetworkFetches?: number;
          };
          mockWindow.__e2eCacheSourceNetworkFetches =
            (mockWindow.__e2eCacheSourceNetworkFetches ?? 0) + 1;
          // A second network fetch means the source cache was bypassed;
          // fail it loudly so the cache regression is unmistakable.
          if (mockWindow.__e2eCacheSourceNetworkFetches > 1) {
            return {
              status: 500,
              json: {
                error: "e2e-cache-source was refetched over the network.",
              },
              text: "",
            };
          }
          return {
            status: 200,
            json: {
              title: "E2E Cache Source",
              content: `E2E_SOURCE_CACHE_CONTENT full text fetched from ${requestedUrl}. ${"Cached source body sentence. ".repeat(40)}`,
              links: [],
            },
            text: "",
          };
        }

        if (requestedUrl.includes("e2e-proof-gated-source")) {
          return {
            status: 200,
            json: {
              title: "E2E MCP Proof-Gated Source",
              url: requestedUrl,
              content:
                "MCP servers expose tools and resources through a standard protocol. This fetched passage is the proof required before current-note writeback.",
              links: [],
            },
            text: "",
          };
        }

        if (requestedUrl.includes("e2e-auto-followup-source")) {
          return {
            status: 200,
            json: {
              title: "E2E Auto Followup Source",
              content:
                "E2E_AUTO_FOLLOWUP_SOURCE_FETCHED full text for runner-owned auto fetch evidence.",
              links: [],
            },
            text: "",
          };
        }

        if (requestedUrl.includes("e2e-quote-verify-source")) {
          return {
            status: 200,
            json: {
              title: "E2E Quote Verify Source",
              url: requestedUrl,
              content:
                "E2E quote verify source body. The exact quoteable phrase for e2e verification appears in this fetched passage so quote spans can be checked.",
              links: [],
            },
            text: "",
          };
        }

        if (requestedUrl.includes("e2e-ledger-source")) {
          return {
            status: 200,
            json: {
              title: "E2E Web Ledger Source",
              url: requestedUrl,
              content:
                "E2E_WEB_LEDGER_SOURCE fetched source content for mission evidence tracking.",
              links: [],
            },
            text: "",
          };
        }

        if (requestedUrl.includes("research-team-source")) {
          return {
            status: 200,
            json: {
              title: "E2E Research Team Source",
              url: requestedUrl,
              content:
                "E2E_RESEARCH_TEAM fetched source content for Lead handoff. The test topic finding is corroborated here.",
              links: [],
            },
            text: "",
          };
        }

        const isCurrentMarketSource =
          requestedUrl.includes("current-dating-market") ||
          requestedUrl.includes("current-social-market");
        return {
          status: 200,
          json: {
            title: isCurrentMarketSource
              ? `E2E Current Market Source ${requestedUrl}`
              : requestedUrl.includes("deep-source")
                ? `E2E Deep Source ${requestedUrl}`
                : "E2E Web Ledger Source",
            content:
              isCurrentMarketSource
                ? `E2E_CURRENT_MARKET_SOURCE_FETCHED fetched source content from ${requestedUrl}.`
                : requestedUrl.includes("deep-source")
                ? `E2E_DEEP_WEB_RESEARCH fetched source content from ${requestedUrl}. Alpha evidence shows the test topic finding. Beta evidence confirms a second independent finding. Gamma evidence adds a third corroborating detail.`
                : "E2E_WEB_LEDGER_SOURCE fetched source content for mission evidence tracking.",
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
        ollamaBaseUrl: "http://127.0.0.1:11434",
        ollamaApiKey: "",
        // Keep single-agent mock paths stable; research-team e2e opts in explicitly.
        orchestratorEnabled: false,
        orchestratorPreviewEnabled: false,
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
        maxAgentSteps: 100,
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

async function openPluginSettings(page: Page) {
  await page.evaluate(async ({ pluginId }) => {
    const obsidianWindow = window as typeof window & { app?: any };
    const setting = obsidianWindow.app?.setting;
    if (!setting?.open || !setting?.openTabById) {
      throw new Error("Obsidian settings API is unavailable.");
    }

    setting.open();
    await setting.openTabById(pluginId);
  }, { pluginId: PLUGIN_ID });

  await expect(page.locator(".agentic-researcher-settings")).toBeVisible({
    timeout: 10_000,
  });
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

    const activeFilePath =
      plugin.getCurrentMarkdownFile?.()?.path ??
      plugin.resolveCurrentMarkdownFile?.()?.path ??
      app?.workspace?.getActiveFile?.()?.path ??
      "";
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

    // Persist first, then start a fresh guarded hydration. View activation can
    // leave older fire-and-forget file/leaf hydration reads in flight; the new
    // load invalidates them and reads the seeded bytes as the latest request.
    const targets = Array.from(
      new Set([
        plugin,
        ...leaves.map((leaf: { view?: { plugin?: unknown } }) => leaf.view?.plugin),
      ].filter(Boolean)),
    );
    for (const target of targets) {
      const mutable = target as {
        conversationHistory?: typeof nextHistory;
        loadProjectMemoryData?: () => Promise<void>;
      };
      if (typeof mutable.loadProjectMemoryData === "function") {
        await mutable.loadProjectMemoryData.call(target);
      } else {
        // Compatibility fallback for an older installed bundle. Assignment is
        // intentionally after the awaited write so old bytes cannot win while
        // the fixture is persisting the seed.
        mutable.conversationHistory = nextHistory;
      }
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
  const aiConfig = getE2EAiConfig();
  const aiMode = aiConfig.mode;
  await page.evaluate(async ({ pluginId, aiMode: mode, aiConfig: config }) => {
    const obsidianWindow = window as typeof window & { app?: any };
    const app = obsidianWindow.app;
    const plugin = app?.plugins?.plugins?.[pluginId];
    if (!app?.workspace || !plugin) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }

    if (typeof plugin.loadSettings === "function") {
      await plugin.loadSettings();
    }
    if (mode === "real") {
      plugin.settings = {
        ...plugin.settings,
        enableStreaming: true,
        thinkingMode: "off",
        model: config.model,
        ollamaBaseUrl: config.baseUrl,
        ollamaApiKey: config.apiKey || plugin.settings?.ollamaApiKey,
        requestTimeoutMs: config.missionTimeoutMs,
        maxAgentSteps: 100,
        streamWritebackMode: "all_current_note_content_writes",
      };
    } else {
      plugin.settings = {
        ...plugin.settings,
        enableStreaming: false,
        thinkingMode: "off",
        model: "playwright-e2e-mock",
        ollamaBaseUrl: "http://127.0.0.1:11434",
        ollamaApiKey: "",
        maxAgentSteps: 100,
        streamWritebackMode: "off",
      };
    }

    const existingAgentLeaves =
      typeof app.workspace.getLeavesOfType === "function"
        ? app.workspace.getLeavesOfType("agentic-researcher-view")
        : [];
    for (const leaf of existingAgentLeaves) {
      await leaf.detach?.();
    }

    await plugin.activateView();
  }, { pluginId: PLUGIN_ID, aiMode, aiConfig });

  await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
    timeout: 30_000,
  });
  if (aiMode === "real") {
    await assertHarnessRealAiReady(page, aiConfig);
  } else {
    await assertHarnessMockReady(page);
  }
}

async function setStreamingMode(
  page: Page,
  enabled: boolean,
  options: { aiConfig?: E2EAiConfig; aiMode?: "mock" | "real" } = {},
) {
  const aiConfig = options.aiConfig ?? getE2EAiConfig();
  const aiMode = options.aiMode ?? aiConfig.mode;
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
        maxAgentSteps: 100,
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
        nextSettings.ollamaBaseUrl = "http://127.0.0.1:11434";
        nextSettings.ollamaApiKey = "";
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

async function setAgenticReflexMode(page: Page, enabled: boolean) {
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
        agenticReflexEnabled: shouldEnable,
        agenticReflexDiagnosticsEnabled: true,
      };
    }
  }, { pluginId: PLUGIN_ID, enabled });
}

async function setPluginSettingOverrides(
  page: Page,
  overrides: Record<string, unknown>,
) {
  await page.evaluate(({ pluginId, overrides: nextOverrides }) => {
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
        ...nextOverrides,
      };
    }
  }, { pluginId: PLUGIN_ID, overrides });
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
  if (await isCdpEndpointAvailable(port)) {
    throw new Error(
      `OBSIDIAN_CDP_PORT ${port} is already serving a CDP endpoint. Pick another port.`,
    );
  }
}

async function isCdpEndpointAvailable(port: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);

  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    return true;
  } catch {
    return controller.signal.aborted;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForCdpClose(port: number, timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!(await isCdpEndpointAvailable(port))) {
      return true;
    }
    await sleep(250);
  }

  return !(await isCdpEndpointAvailable(port));
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
  if (!process?.pid) {
    return;
  }

  await terminateControlledObsidian(process, {
    terminateOwnedTree: async (pid) => {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {
        process.kill();
      });
    },
    waitForOwnedExit: () => waitForChildClose(process, 10_000),
    waitForNoRunningProcess: () => waitForNoRunningObsidian(30_000),
    waitForCdpClose: () => waitForCdpClose(cdpPort, 10_000),
  });
}

async function waitForChildClose(
  process: ChildProcessWithoutNullStreams,
  timeoutMs: number,
) {
  if (process.exitCode !== null || process.signalCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const onClose = () => finish(true);
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      process.off("close", onClose);
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    process.once("close", onClose);
  });
}

async function createVaultFixture(
  page: Page,
  targetPath: string,
  content: string,
) {
  await page.evaluate(async ({ targetPath: requestedPath, content: body }) => {
    const obsidianWindow = window as typeof window & { app?: any };
    const app = obsidianWindow.app;
    if (!app?.vault) {
      throw new Error("Obsidian vault is unavailable for fixture creation.");
    }

    const existing = app.vault.getAbstractFileByPath(requestedPath);
    if (existing) {
      await app.vault.delete(existing, true);
    }
    const parts = requestedPath.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(current)) {
        await app.vault.createFolder(current);
      }
    }
    await app.vault.create(requestedPath, body);
  }, { targetPath, content });
}

async function deleteVaultFixture(page: Page, targetPath: string) {
  await page.evaluate(async ({ targetPath: requestedPath }) => {
    const obsidianWindow = window as typeof window & { app?: any };
    const app = obsidianWindow.app;
    const target = app?.vault?.getAbstractFileByPath?.(requestedPath);
    if (target) {
      await app.vault.delete(target, true);
    }

    const folderPath = requestedPath.slice(0, requestedPath.lastIndexOf("/"));
    const folder = app?.vault?.getAbstractFileByPath?.(folderPath);
    if (folder && Array.isArray(folder.children) && folder.children.length === 0) {
      await app.vault.delete(folder, true);
    }
  }, { targetPath });
}

async function snapshotFileBytes(
  filePath: string,
): Promise<{ size: number; sha256: string } | null> {
  try {
    const bytes = await readFile(filePath);
    return {
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function snapshotVaultTrash(): Promise<
  Array<{ relativePath: string; size: number; sha256: string }>
> {
  const trashRoot = path.join(vaultRoot, ".trash");
  const files = await listFilesRecursively(trashRoot);
  const snapshot = await Promise.all(
    files.map(async (filePath) => {
      const file = await snapshotFileBytes(filePath);
      if (!file) {
        throw new Error(`Trash file disappeared while snapshotting: ${filePath}`);
      }
      return {
        relativePath: path.relative(trashRoot, filePath).split(path.sep).join("/"),
        ...file,
      };
    }),
  );
  return snapshot.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function readPersistedMissionGraphRecord(missionId: string): Promise<any> {
  const safeMissionId =
    missionId
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "mission";
  const filePath = path.join(
    vaultRoot,
    "Agent Runs",
    "Mission Graphs",
    `${safeMissionId}.md`,
  );
  const markdown = await readFile(filePath, "utf8");
  const json = /```json\r?\n([\s\S]*?)\r?\n```/u.exec(markdown)?.[1];
  if (!json) {
    throw new Error(`Mission graph store JSON was missing: ${filePath}`);
  }
  const record = JSON.parse(json) as any;
  if (record?.missionId !== missionId || record?.graph?.missionId !== missionId) {
    throw new Error(`Mission graph store identity mismatch for ${missionId}.`);
  }
  return record;
}

function findMissionGraphToolNode(record: any, toolName: string): any {
  const matches = Object.values(record?.graph?.nodes ?? {}).filter(
    (node: any) =>
      Array.isArray(node?.allowedTools) && node.allowedTools.includes(toolName),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${toolName} mission node, found ${matches.length}.`,
    );
  }
  return matches[0];
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  });
}

interface Phase3CoordinatorEventRecord {
  sequence: number;
  jobId: string;
  type: CompanionEventV1["type"];
  payload: Record<string, unknown>;
  createdAt: string;
}

interface Phase3CoordinatorReceiptRecord {
  id: string;
  jobId: string;
  provider: CompanionReceiptV1["provider"];
  operation: string;
  status: CompanionReceiptV1["status"];
  fingerprint: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface Phase3AuthenticatedCompanionWorker {
  baseUrl: string;
  bootstrapToken: string;
  submittedBodies: Array<Record<string, unknown>>;
  waitForExecutorStarted(): Promise<void>;
  releaseExecutor(): void;
  waitForTerminal(jobId: string): Promise<CompanionRemoteJobV1>;
  eventsFor(jobId: string): Phase3CoordinatorEventRecord[];
  receiptsFor(jobId: string): Phase3CoordinatorReceiptRecord[];
  close(): Promise<void>;
}

async function startPhase3AuthenticatedCompanionWorker(
  marker: string,
): Promise<Phase3AuthenticatedCompanionWorker> {
  const bootstrapToken = `phase3-e2e-bootstrap-${createHash("sha256")
    .update(`${Date.now()}:${Math.random()}`)
    .digest("hex")}`;
  const leaseToken = `phase3-e2e-lease-${createHash("sha256")
    .update(`lease:${Date.now()}:${Math.random()}`)
    .digest("hex")}`;
  const submittedBodies: Array<Record<string, unknown>> = [];
  const jobs = new Map<string, CompanionRemoteJobV1>();
  const events = new Map<string, Phase3CoordinatorEventRecord[]>();
  const receipts = new Map<string, Phase3CoordinatorReceiptRecord[]>();
  let workerReady = false;
  let executorReleased = false;
  let releaseExecutor!: () => void;
  const executorGate = new Promise<void>((resolve) => {
    releaseExecutor = () => {
      executorReleased = true;
      resolve();
    };
  });
  let markExecutorStarted!: () => void;
  const executorStarted = new Promise<void>((resolve) => {
    markExecutorStarted = resolve;
  });

  const appendEvent = (
    jobId: string,
    type: CompanionEventV1["type"],
    payload: Record<string, unknown>,
  ): Phase3CoordinatorEventRecord => {
    const list = events.get(jobId) ?? [];
    const event = {
      sequence: list.length + 1,
      jobId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    list.push(event);
    events.set(jobId, list);
    return event;
  };

  const server = createServer(async (request, response) => {
    try {
      applyPhase3CompanionCors(request, response);
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${bootstrapToken}`) {
        writePhase3Json(response, 401, {
          ok: false,
          error: "authentication_required",
        });
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        writePhase3Json(response, 200, {
          ok: true,
          service: "obsidian-research-companion",
          browserReady: false,
          memoryReady: true,
          coordinatorReady: true,
          workerReady,
          workerDiagnostic: workerReady ? null : "awaiting_worker_heartbeat",
          secureStorePersistent: true,
          backgroundEnabled: true,
          backgroundBlocker: null,
          version: "0.3.0-e2e",
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/worker/heartbeat") {
        await readPhase3JsonBody(request);
        workerReady = true;
        writePhase3Json(response, 200, {
          ok: true,
          workerReady: true,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/jobs") {
        const body = await readPhase3JsonBody(request);
        submittedBodies.push(body);
        const existing = [...jobs.values()].find(
          (candidate) => candidate.idempotencyKey === String(body.idempotencyKey ?? ""),
        );
        if (existing) {
          writePhase3Json(response, 200, existing);
          return;
        }
        const now = new Date().toISOString();
        const job: CompanionRemoteJobV1 = {
          id: String(body.id ?? ""),
          missionId: String(body.missionId ?? ""),
          nodeId: String(body.nodeId ?? ""),
          executionHost: String(body.executionHost ?? "research") as CompanionRemoteJobV1["executionHost"],
          state: "queued",
          payload: asPhase3Record(body.payload) as CompanionRemoteJobV1["payload"],
          capabilityEnvelope: asPhase3Record(
            body.capabilityEnvelope,
          ) as CompanionRemoteJobV1["capabilityEnvelope"],
          idempotencyKey: String(body.idempotencyKey ?? ""),
          ownerCoordinatorId: null,
          leaseExpiresAt: null,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        };
        if (!job.id || !job.missionId || !job.nodeId || !job.idempotencyKey) {
          writePhase3Json(response, 422, { error: "invalid_job" });
          return;
        }
        jobs.set(job.id, job);
        appendEvent(job.id, "job_accepted", { executionHost: job.executionHost });
        writePhase3Json(response, 200, job);
        return;
      }

      if (request.method === "GET" && url.pathname === "/jobs") {
        const requestedStates = url.searchParams.getAll("state");
        const selected = [...jobs.values()].filter(
          (job) => requestedStates.length === 0 || requestedStates.includes(job.state),
        );
        writePhase3Json(response, 200, { jobs: selected });
        return;
      }

      const claimMatch = /^\/jobs\/([^/]+)\/claim$/u.exec(url.pathname);
      if (request.method === "POST" && claimMatch) {
        const jobId = decodeURIComponent(claimMatch[1]);
        const job = jobs.get(jobId);
        if (!job) {
          writePhase3Json(response, 404, { error: "job_not_found" });
          return;
        }
        const body = await readPhase3JsonBody(request);
        const now = new Date();
        job.state = "running";
        job.ownerCoordinatorId = String(body.coordinatorId ?? "");
        job.leaseExpiresAt = new Date(
          now.getTime() + Number(body.leaseSeconds ?? 60) * 1_000,
        ).toISOString();
        job.attempts += 1;
        job.updatedAt = now.toISOString();
        appendEvent(jobId, "job_leased", {
          coordinatorId: job.ownerCoordinatorId,
        });
        writePhase3Json(response, 200, { job, leaseToken });
        return;
      }

      const heartbeatMatch = /^\/jobs\/([^/]+)\/heartbeat$/u.exec(url.pathname);
      if (request.method === "POST" && heartbeatMatch) {
        const jobId = decodeURIComponent(heartbeatMatch[1]);
        const job = jobs.get(jobId);
        const body = await readPhase3JsonBody(request);
        if (!job || body.leaseToken !== leaseToken) {
          writePhase3Json(response, job ? 409 : 404, { error: "invalid_lease" });
          return;
        }
        job.leaseExpiresAt = new Date(
          Date.now() + Number(body.leaseSeconds ?? 60) * 1_000,
        ).toISOString();
        job.updatedAt = new Date().toISOString();
        writePhase3Json(response, 200, job);
        return;
      }

      const eventMatch = /^\/jobs\/([^/]+)\/events$/u.exec(url.pathname);
      if (request.method === "POST" && eventMatch) {
        const jobId = decodeURIComponent(eventMatch[1]);
        const body = await readPhase3JsonBody(request);
        if (!jobs.has(jobId) || body.leaseToken !== leaseToken) {
          writePhase3Json(response, jobs.has(jobId) ? 409 : 404, {
            error: "invalid_lease",
          });
          return;
        }
        const event = appendEvent(
          jobId,
          String(body.type) as CompanionEventV1["type"],
          asPhase3Record(body.payload),
        );
        writePhase3Json(response, 200, event);
        return;
      }
      if (request.method === "GET" && eventMatch) {
        const jobId = decodeURIComponent(eventMatch[1]);
        if (!jobs.has(jobId)) {
          writePhase3Json(response, 404, { error: "job_not_found" });
          return;
        }
        const after = Number(url.searchParams.get("after") ?? "0");
        const body = (events.get(jobId) ?? [])
          .filter((event) => event.sequence > after)
          .map(
            (event) =>
              `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(
                event,
              )}\n\n`,
          )
          .join("");
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Cache-Control", "no-store");
        response.end(body);
        return;
      }

      const receiptMatch = /^\/jobs\/([^/]+)\/receipts$/u.exec(url.pathname);
      if (request.method === "POST" && receiptMatch) {
        const jobId = decodeURIComponent(receiptMatch[1]);
        const body = await readPhase3JsonBody(request);
        if (!jobs.has(jobId) || body.leaseToken !== leaseToken) {
          writePhase3Json(response, jobs.has(jobId) ? 409 : 404, {
            error: "invalid_lease",
          });
          return;
        }
        const list = receipts.get(jobId) ?? [];
        const receipt: Phase3CoordinatorReceiptRecord = {
          id: `phase3-receipt-${list.length + 1}`,
          jobId,
          provider: String(body.provider) as CompanionReceiptV1["provider"],
          operation: String(body.operation),
          status: String(body.status) as CompanionReceiptV1["status"],
          fingerprint: String(body.fingerprint),
          payload: asPhase3Record(body.payload),
          createdAt: new Date().toISOString(),
        };
        list.push(receipt);
        receipts.set(jobId, list);
        appendEvent(jobId, "receipt_committed", { receiptId: receipt.id });
        writePhase3Json(response, 200, receipt);
        return;
      }
      if (request.method === "GET" && receiptMatch) {
        const jobId = decodeURIComponent(receiptMatch[1]);
        if (!jobs.has(jobId)) {
          writePhase3Json(response, 404, { error: "job_not_found" });
          return;
        }
        writePhase3Json(response, 200, { receipts: receipts.get(jobId) ?? [] });
        return;
      }

      const completeMatch = /^\/jobs\/([^/]+)\/complete$/u.exec(url.pathname);
      if (request.method === "POST" && completeMatch) {
        const jobId = decodeURIComponent(completeMatch[1]);
        const job = jobs.get(jobId);
        const body = await readPhase3JsonBody(request);
        if (!job || body.leaseToken !== leaseToken) {
          writePhase3Json(response, job ? 409 : 404, { error: "invalid_lease" });
          return;
        }
        job.state = String(body.state);
        job.output = asPhase3Record(body.output) as CompanionRemoteJobV1["output"];
        job.leaseExpiresAt = null;
        job.updatedAt = new Date().toISOString();
        appendEvent(
          jobId,
          job.state === "complete" ? "job_completed" : "job_failed",
          { state: job.state },
        );
        writePhase3Json(response, 200, job);
        return;
      }

      const jobMatch = /^\/jobs\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && jobMatch) {
        const job = jobs.get(decodeURIComponent(jobMatch[1]));
        if (!job) {
          writePhase3Json(response, 404, { error: "job_not_found" });
          return;
        }
        writePhase3Json(response, 200, job);
        return;
      }

      writePhase3Json(response, 404, { error: "not_found" });
    } catch (error) {
      writePhase3Json(response, 500, {
        error: error instanceof Error ? error.message : "fake_service_error",
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new CompanionCoordinatorClientV1({
    baseUrl,
    credential: createSessionBootstrapTokenLeaseV1(bootstrapToken),
  });
  const executor: HeadlessDomainExecutorV1 = async (job, context) => {
    markExecutorStarted();
    await context.reportProgress("deterministic authorized research is running");
    await executorGate;
    return {
      status: "complete",
      outputs: { answer: `verified:${marker}` },
      evidence: [
        {
          kind: "public_web_source",
          fingerprint: e2eFingerprint(`phase3-source:${marker}`),
        },
      ],
      receipts: [
        await buildCompanionReceiptV1({
          job,
          id: `phase3-worker-receipt-${marker}`,
          provider: "research",
          operation: "public_research_fetch",
          status: "verified",
          payload: { sourceCount: 1 },
          committedAt: new Date().toISOString(),
        }),
      ],
    };
  };
  const coordinator = new CompanionWorkerCoordinatorV1({
    client,
    coordinatorId: "phase3-e2e-worker",
    executorCatalog: { research: executor },
    catalogFingerprint: e2eFingerprint("phase3-e2e-worker-catalog"),
    leaseSeconds: 5,
    heartbeatIntervalMs: 1_000,
    workerHeartbeatIntervalMs: 250,
    pollIntervalMs: 250,
  });
  const workerAbort = new AbortController();
  const workerLoop = coordinator.runForever(workerAbort.signal);

  return {
    baseUrl,
    bootstrapToken,
    submittedBodies,
    waitForExecutorStarted: () => executorStarted,
    releaseExecutor() {
      if (!executorReleased) releaseExecutor();
    },
    async waitForTerminal(jobId) {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const job = jobs.get(jobId);
        if (job && ["complete", "blocked", "cancelled", "failed"].includes(job.state)) {
          return { ...job };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for companion job ${jobId}.`);
    },
    eventsFor: (jobId) => [...(events.get(jobId) ?? [])],
    receiptsFor: (jobId) => [...(receipts.get(jobId) ?? [])],
    async close() {
      if (!executorReleased) releaseExecutor();
      workerAbort.abort();
      await workerLoop.catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function applyPhase3CompanionCors(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const origin = request.headers.origin;
  if (!origin) return;
  if (origin !== "app://obsidian.md") {
    response.statusCode = 403;
    throw new Error("browser_origin_not_allowed");
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Cache-Control, Content-Type, Accept",
  );
}

async function readPhase3JsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_048_576) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  return asPhase3Record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

function writePhase3Json(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function asPhase3Record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function persistPhase3MissionContinuation(
  graph: MissionGraphV3,
  notePath: string,
  writeMarker: string,
): Promise<{ graphPath: string; runPath: string }> {
  const resumeMission =
    `E2E_PHASE3_RESUME: Append this exact E2E marker to the current note: ${writeMarker}`;
  const context = createPhase3FilesystemToolContext(
    resumeMission,
  );
  const session = await MissionGraphSession.open({
    context,
    initialGraph: graph,
  });
  const ledger = createMissionLedger({
    runId: graph.missionId,
    mission: resumeMission,
    route: "direct_writeback",
    loopBudget: {
      hardCap: 8,
      toolStepBudget: 4,
      finalizationReserve: 4,
      expectedTools: ["append_to_current_file"],
      stopWhenSatisfied: true,
    },
  });
  ledger.nextActions = ["Resume the original Obsidian-bound vault node."];
  ledger.remainingActions = ["Append the authorized marker once."];
  const ledgerWrite = await writeMissionLedger(context, ledger);
  if (!ledgerWrite) throw new Error("Phase-3 mission ledger was not persisted.");
  const snapshot = createMissionRuntimeSnapshot({
    runId: graph.missionId,
    originalMission: ledger.mission,
    currentNotePath: notePath,
    status: "paused",
    missionGraphRef: session.reference,
    operationGoals: { append_to_current_file: "pending" },
    notes: ["External research is delegated; the vault node remains host-bound."],
  });
  const snapshotWrite = await writeMissionRuntimeSnapshot(context, snapshot);
  if (!snapshotWrite) throw new Error("Phase-3 runtime snapshot was not persisted.");
  return {
    graphPath: session.reference.path,
    runPath: snapshotWrite.path,
  };
}

function createPhase3FilesystemToolContext(originalPrompt: string): ToolExecutionContext {
  const resolveVaultPath = (vaultPath: string) => {
    const normalized = vaultPath.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
    const resolved = path.resolve(vaultRoot, ...normalized.split("/"));
    const relative = path.relative(vaultRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Unsafe phase-3 vault path: ${vaultPath}`);
    }
    return resolved;
  };
  const entry = (vaultPath: string, kind: "file" | "folder") => {
    const absolute = resolveVaultPath(vaultPath);
    if (!existsSync(absolute)) return null;
    const metadata = statSync(absolute);
    if ((kind === "file" && !metadata.isFile()) || (kind === "folder" && !metadata.isDirectory())) {
      return null;
    }
    return {
      path: vaultPath.replace(/\\/gu, "/"),
      name: path.basename(vaultPath),
      stat: {
        ctime: metadata.ctimeMs,
        mtime: metadata.mtimeMs,
        size: metadata.size,
      },
    };
  };
  const vault = {
    getFileByPath: (vaultPath: string) => entry(vaultPath, "file"),
    getFolderByPath: (vaultPath: string) => entry(vaultPath, "folder"),
    getAbstractFileByPath: (vaultPath: string) =>
      entry(vaultPath, "file") ?? entry(vaultPath, "folder"),
    createFolder: async (vaultPath: string) => {
      await mkdir(resolveVaultPath(vaultPath), { recursive: true });
      return entry(vaultPath, "folder");
    },
    create: async (vaultPath: string, content: string) => {
      const absolute = resolveVaultPath(vaultPath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
      return entry(vaultPath, "file");
    },
    read: async (file: { path: string }) =>
      readFile(resolveVaultPath(file.path), "utf8"),
    modify: async (file: { path: string }, content: string) => {
      await writeFile(resolveVaultPath(file.path), content, "utf8");
    },
  };
  return {
    app: { vault },
    settings: {},
    originalPrompt,
    httpTransport: {},
    now: () => new Date(),
  } as unknown as ToolExecutionContext;
}

async function createPhase3BackgroundGraph(
  marker: string,
  writeMarker: string,
): Promise<{
  graph: MissionGraphV3;
  authorization: BackgroundAuthorizationV1;
}> {
  const now = new Date();
  const timestamp = now.toISOString();
  const missionId = `phase3-${createHash("sha256").update(marker).digest("hex").slice(0, 16)}`;
  const envelope = await buildMissionCapabilityEnvelopeV1({
    missionId,
    issuedAt: timestamp,
    expiresAt: null,
    capabilities: ["vault.write", "web.read"],
    executionHosts: ["obsidian_core", "headless_runtime"],
    executors: {
      core: {
        id: "core",
        executionHosts: ["obsidian_core"],
        allowedEffects: ["mutation"],
      },
      researcher: {
        id: "researcher",
        executionHosts: ["headless_runtime"],
        allowedEffects: ["read"],
      },
    },
    verifiers: ["companion-external-result-v1"],
    tools: {
      web_fetch: {
        name: "web_fetch",
        effect: "read",
        capabilityIds: ["web.read"],
        executionHosts: ["headless_runtime"],
        bindingKinds: [],
      },
      append_to_current_file: {
        name: "append_to_current_file",
        effect: "mutation",
        capabilityIds: ["vault.write"],
        executionHosts: ["obsidian_core"],
        bindingKinds: ["vault-note"],
      },
    },
    bindings: {
      "active-note": {
        id: "active-note",
        kind: "vault-note",
        destinationFingerprint: e2eFingerprint(`note:${marker}`),
        allowedEffects: ["mutation"],
      },
    },
    budgets: {
      maxNodes: 16,
      maxDepth: 4,
      maxConcurrentReadNodes: 3,
      maxTotalToolCalls: 8,
      maxExternalActions: 0,
      maxWallClockMs: 120_000,
      maxAttemptsPerNode: 3,
    },
  });
  const defaultNode = (overrides: Partial<MissionNodeV3>): MissionNodeV3 => ({
    id: "node",
    dependencyIds: [],
    objective: "Run one already-authorized external step.",
    executorId: "researcher",
    executionHost: "headless_runtime",
    effect: "read",
    inputs: {
      url: {
        kind: "literal",
        value: `https://example.com/phase3-${encodeURIComponent(marker)}`,
      },
    },
    outputs: {},
    requiredCapabilities: ["web.read"],
    allowedTools: ["web_fetch"],
    destination: null,
    resourceLocks: [],
    budget: { toolCalls: 1, externalActions: 0, wallClockMs: 30_000 },
    retries: {
      maxAttempts: 3,
      attempts: 0,
      failureFingerprints: [],
      consecutiveFailureFingerprint: null,
      consecutiveFailureCount: 0,
    },
    status: "ready",
    evidence: [],
    receipts: [],
    verification: null,
    completionContract: {
      criteria: ["A verified public research result is recorded."],
      minimumEvidence: 1,
      requiredEvidenceKinds: ["public_web_source"],
      minimumReceipts: 1,
      requiredReceiptKinds: ["external:research:public_research_fetch"],
      verifierId: "companion-external-result-v1",
    },
    blocker: null,
    ...overrides,
  });
  const graph: MissionGraphV3 = {
      schemaVersion: 3,
      missionId,
      objective: `Continue external research, then append ${writeMarker} in Obsidian.`,
      revision: 0,
      journalHeadFingerprint: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      routing: {
        source: "deterministic",
        fallbackFrom: null,
        fallbackReason: null,
        confidence: 1,
        decidedAt: timestamp,
        decisionFingerprint: e2eFingerprint(`route:${marker}`),
      },
      continuationCheckpoint: null,
      capabilityEnvelope: envelope,
      nodes: {
        research: defaultNode({ id: "research" }),
        "vault-write": defaultNode({
          id: "vault-write",
          dependencyIds: ["research"],
          executorId: "core",
          executionHost: "obsidian_core",
          effect: "mutation",
          inputs: {
            target: {
              kind: "binding",
              bindingId: "active-note",
              selector: null,
            },
          },
          requiredCapabilities: ["vault.write"],
          allowedTools: ["append_to_current_file"],
          destination: {
            bindingId: "active-note",
            effect: "mutation",
            selector: null,
          },
          resourceLocks: [{ bindingId: "active-note", mode: "exclusive" }],
          completionContract: {
            criteria: ["Obsidian reads back a receipted note write."],
            minimumEvidence: 0,
            requiredEvidenceKinds: [],
            minimumReceipts: 1,
            requiredReceiptKinds: ["vault-write"],
            verifierId: null,
          },
          status: "queued",
        }),
      },
  };
  return {
    graph,
    authorization: await buildBackgroundAuthorizationV1({
      graph,
      nodeId: "research",
      grantId: `grant-${missionId}`,
      authorizedAt: timestamp,
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      authorizedGraphRevision: graph.revision,
    }),
  };
}

function e2eFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function snapshotFileIdentity(filePath: string): Promise<{
  size: number;
  sha256: string;
  mtimeMs: number;
} | null> {
  const bytes = await snapshotFileBytes(filePath);
  if (!bytes) return null;
  const metadata = await stat(filePath);
  return { ...bytes, mtimeMs: metadata.mtimeMs };
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
        maxAgentSteps: 100,
        streamWritebackMode: "off",
        scheduledMissions: [],
        autoResumeOvernightRuns: false,
        linearEnabled: false,
        linearCapabilityGate: 0,
        linearQueueEnabled: false,
        linearApiKey: "",
        linearCredentialReference: null,
        linearOAuthRuntimeState: null,
        linearCapabilitySnapshot: null,
        authorityGrants: [],
        authorityGrantUsage: {},
        authorityGrantStoreState: null,
        linearIntegrationState: null,
        linearQueueState: null,
        pendingLinearReconciliationState: null,
        queueResourceLockState: null,
        queueDailyStartBudgetState: null,
        githubApiToken: "",
        githubCredential: null,
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

async function readCoreToolNames(page: Page): Promise<string[]> {
  return page.evaluate(({ corePluginId }) => {
    const core = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[corePluginId];
    if (!core?.createToolRegistry) {
      throw new Error("Core tool registry diagnostics are unavailable.");
    }
    return core
      .createToolRegistry()
      .getDefinitions()
      .map((definition: any) => String(definition?.function?.name ?? ""))
      .filter(Boolean)
      .sort();
  }, { corePluginId: PLUGIN_ID });
}

async function installGitHubReviewRepairApprovalRouteHarness(
  page: Page,
  marker: string,
): Promise<void> {
  await page.evaluate(async ({ corePluginId, markerValue }) => {
    const core = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[corePluginId];
    if (
      !core ||
      typeof core.runGitHubReviewRepair !== "function" ||
      typeof core.requestGitHubReviewRepairExactApproval !== "function"
    ) {
      throw new Error("The production GitHub review-repair route is unavailable.");
    }
    const state = {
      original: core.runGitHubReviewRepair,
      pushes: 0,
      sequence: 0,
    };
    core.__e2eGitHubReviewRepairApprovalRoute = state;
    core.runGitHubReviewRepair = async () => {
      state.sequence += 1;
      const previousHeadSha = "a".repeat(40);
      const newHeadSha = "b".repeat(40);
      const preparedAt = new Date(Date.now() + state.sequence * 1_000).toISOString();
      const action = {
        version: 1,
        id: `github-review-fast-forward-e2e-${state.sequence}`,
        runId: `e2e-github-review-${state.sequence}`,
        toolCallId: `e2e-github-review-call-${state.sequence}`,
        toolName: "github_review_repair",
        target: {
          system: "github",
          resourceType: "pull_request",
          id: "acme/fixture#42",
          url: "https://github.com/acme/fixture/pull/42",
          accountId: "e2e-account",
          repositoryId: "acme/fixture",
          repositoryProfileId: "fixture",
          revision: newHeadSha,
        },
        relatedResources: [],
        normalizedArgs: {
          kind: "repair_fast_forward",
          publicationId: `e2e-review-publication-${markerValue}`,
          repairId: `e2e-review-${state.sequence}`,
          bindingFingerprint: `sha256:${"c".repeat(64)}`,
          branch: "codex/e2e-review",
          headSha: newHeadSha,
          previousHeadSha,
          baseBranch: "main",
        },
        preview: {
          summary: `Fast-forward pull request #42 from ${previousHeadSha} to ${newHeadSha}.`,
          destination: "GitHub acme/fixture PR #42",
          outboundPayload: {
            pullRequestNumber: 42,
            branch: "codex/e2e-review",
            previousHeadSha,
            newHeadSha,
          },
          warnings: [],
          outboundBytes: 192,
        },
        expectedTargetRevision: newHeadSha,
        idempotencyKey: `github-review-e2e:${markerValue}:${state.sequence}`,
        reconciliationKey: "github-pr:acme/fixture:42",
        preparedAt,
        expiresAt: new Date(Date.parse(preparedAt) + 120_000).toISOString(),
        requiredConfirmations: 1,
      };
      const canonical = (value: any): string => {
        if (value === null || typeof value !== "object") return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        return `{${Object.keys(value).sort().map((key) =>
          `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
      };
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(action)),
      );
      const payloadFingerprint = `sha256:${Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")}`;
      const preparedAction = { ...action, payloadFingerprint };
      const approval = await core.requestGitHubReviewRepairExactApproval({
        kind: "repair_fast_forward",
        approvalFingerprint: payloadFingerprint,
        preparedAction,
        requiredConfirmations: 1,
        summary: action.preview.summary,
        destination: action.preview.destination,
      });
      if (!approval.approved) {
        return {
          status: "blocked",
          checkpoint: {
            blocker: { message: "The exact review-repair fast-forward was denied." },
            remoteHeadSha: null,
            newHandoff: null,
          },
        };
      }
      state.pushes += 1;
      return {
        status: "complete",
        checkpoint: {
          blocker: null,
          remoteHeadSha: newHeadSha,
          newHandoff: null,
        },
      };
    };
  }, { corePluginId: PLUGIN_ID, markerValue: marker });
}

async function readGitHubReviewRepairRoutePushCount(page: Page): Promise<number> {
  return page.evaluate(({ corePluginId }) => {
    const core = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[corePluginId];
    return Number(core?.__e2eGitHubReviewRepairApprovalRoute?.pushes ?? -1);
  }, { corePluginId: PLUGIN_ID });
}

async function restoreGitHubReviewRepairApprovalRouteHarness(page: Page): Promise<void> {
  await page.evaluate(({ corePluginId }) => {
    const core = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[corePluginId];
    const state = core?.__e2eGitHubReviewRepairApprovalRoute;
    if (core && state?.original) core.runGitHubReviewRepair = state.original;
    if (core) delete core.__e2eGitHubReviewRepairApprovalRoute;
  }, { corePluginId: PLUGIN_ID });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
