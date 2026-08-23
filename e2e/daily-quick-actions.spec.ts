import { expect, test } from "@playwright/test";

import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";
import { laneSelectedV1 } from "./fixtures/laneSelection";
import {
  SELECTION_RESEARCH_ACTIONS,
  SELECTION_RESEARCH_MENU_SECTION,
} from "../src/agent/selectionResearchPrompt";

const LANE = "safe-assistant-renderer";

/**
 * The lane runs the installed bundle in real Obsidian with no model and no
 * network. That is exactly what a surface proof needs: registration, menu
 * routing, and blocked-run rendering are host wiring, and a unit test cannot
 * tell whether Obsidian actually accepted them.
 */
const SELECTION_LABELS = SELECTION_RESEARCH_ACTIONS.filter(
  (action) => action.inEditorMenu && action.scope === "selection",
).map((action) => action.label);

const CURSOR_LABELS = SELECTION_RESEARCH_ACTIONS.filter(
  (action) => action.inEditorMenu && action.scope === "cursor",
).map((action) => action.label);

const FILE_LABELS = SELECTION_RESEARCH_ACTIONS.filter(
  (action) => action.inFileMenu && action.requiresLinear !== true,
).map((action) => action.label);

const LINEAR_LABELS = SELECTION_RESEARCH_ACTIONS.filter(
  (action) => action.requiresLinear === true,
).map((action) => action.label);

const COMMAND_IDS = SELECTION_RESEARCH_ACTIONS.map((action) => action.commandId);

test("daily quick actions register as commands and route to the right context menu", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(!laneSelectedV1(LANE), `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`);
  test.setTimeout(4 * 60_000);

  let harness: NativeObsidianHarness | null = null;
  try {
    harness = await startNativeObsidianHarness({
      label: "daily-quick-actions",
      setup: async () => {
        // Registration happens at plugin load; nothing to stage.
      },
    });

    const probe = await harness.page.evaluate(
      async ({ pluginId, commandIds, notePath }) => {
        const app = (window as typeof window & { app?: any }).app;
        const plugin = app?.plugins?.plugins?.[pluginId];
        if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");

        const registered = app?.commands?.commands ?? {};
        const commands = commandIds.map((id: string) => {
          const command = registered[`${pluginId}:${id}`];
          return {
            id,
            present: Boolean(command),
            name: command?.name ?? null,
            // Selection/cursor actions gate through editorCheckCallback; note
            // actions gate through checkCallback. A palette entry with neither
            // would run against whatever happened to be open.
            gate: command?.editorCheckCallback
              ? "editor"
              : command?.checkCallback
                ? "note"
                : "none",
          };
        });

        const collect = (
          trigger: (menu: {
            addItem: (build: (item: any) => void) => void;
          }) => void,
        ) => {
          const items: Array<{ title: string; section: string | null; icon: string | null }> = [];
          const menu = {
            addItem(build: (item: any) => void) {
              const record: { title: string; section: string | null; icon: string | null } = {
                title: "",
                section: null,
                icon: null,
              };
              const item = {
                setTitle(value: string) {
                  record.title = value;
                  return item;
                },
                setIcon(value: string) {
                  record.icon = value;
                  return item;
                },
                setSection(value: string) {
                  record.section = value;
                  return item;
                },
                onClick() {
                  return item;
                },
              };
              build(item);
              items.push(record);
            },
          };
          trigger(menu);
          return items;
        };

        // The harness reserves its note path for a mission to create; this
        // lane runs no mission, so fall back to any note already in the vault.
        // Reading menu registration must not mutate the user's vault.
        const noteFile =
          app.vault.getFileByPath(notePath) ??
          app.vault.getMarkdownFiles?.()?.[0] ??
          null;
        if (!noteFile) {
          throw new Error("The e2e vault contains no markdown note to test against.");
        }

        const leadIn =
          "The 2024 pouch-cell results changed how the field reads cycle life, and the follow-up work has not caught up.";
        const editorWithSelection = {
          getSelection: () => "lithium metal anodes reach 400 Wh/kg",
          getCursor: () => ({ line: 3, ch: 12 }),
          getRange: () => leadIn,
        };
        const editorWithCaretOnly = {
          getSelection: () => "",
          getCursor: () => ({ line: 3, ch: 12 }),
          getRange: () => leadIn,
        };
        const editorOnEmptyNote = {
          getSelection: () => "",
          getCursor: () => ({ line: 0, ch: 0 }),
          getRange: () => "",
        };

        return {
          commands,
          withSelection: collect((menu) =>
            app.workspace.trigger("editor-menu", menu, editorWithSelection, {
              file: noteFile,
            }),
          ),
          withCaretOnly: collect((menu) =>
            app.workspace.trigger("editor-menu", menu, editorWithCaretOnly, {
              file: noteFile,
            }),
          ),
          onEmptyNote: collect((menu) =>
            app.workspace.trigger("editor-menu", menu, editorOnEmptyNote, {
              file: noteFile,
            }),
          ),
          fileMenu: collect((menu) =>
            app.workspace.trigger("file-menu", menu, noteFile, "e2e"),
          ),
          linearConnected: plugin.hasLinearApiKey?.() === true,
        };
      },
      {
        pluginId: NATIVE_CORE_PLUGIN_ID,
        commandIds: COMMAND_IDS,
        notePath: harness.notePath,
      },
    );

    // Every quick action is in the palette, with the gate its scope requires.
    for (const command of probe.commands) {
      expect(command.present, `${command.id} is not a registered command`).toBe(
        true,
      );
      expect(command.gate, `${command.id} has no availability gate`).not.toBe(
        "none",
      );
    }
    const noteScoped = new Set(
      SELECTION_RESEARCH_ACTIONS.filter((action) => action.scope === "note").map(
        (action) => action.commandId,
      ),
    );
    for (const command of probe.commands) {
      expect(command.gate, command.id).toBe(
        noteScoped.has(command.id) ? "note" : "editor",
      );
    }

    const titles = (items: Array<{ title: string }>) =>
      items.map((item) => item.title);

    // A selection offers the selection actions and never the cursor action.
    expect(titles(probe.withSelection)).toEqual(
      expect.arrayContaining(SELECTION_LABELS),
    );
    for (const label of CURSOR_LABELS) {
      expect(titles(probe.withSelection)).not.toContain(label);
    }

    // A bare caret after real prose offers only the cursor action.
    expect(titles(probe.withCaretOnly)).toEqual(CURSOR_LABELS);

    // A caret with nothing before it offers nothing: there is no voice to
    // match, and an entry that opens the panel to complain is worse than none.
    expect(titles(probe.onEmptyNote)).toEqual([]);

    // Whole-note actions live in the file menu, not the editor menu.
    expect(titles(probe.fileMenu)).toEqual(
      expect.arrayContaining(FILE_LABELS),
    );
    for (const label of FILE_LABELS) {
      expect(titles(probe.withSelection)).not.toContain(label);
    }

    // Linear publication is hidden until a Linear credential exists.
    if (!probe.linearConnected) {
      for (const label of LINEAR_LABELS) {
        expect(titles(probe.fileMenu)).not.toContain(label);
      }
    }

    // Everything clusters in one menu section instead of scattering through
    // Obsidian's own items.
    for (const items of [probe.withSelection, probe.withCaretOnly, probe.fileMenu]) {
      for (const item of items) {
        expect(item.section, item.title).toBe(SELECTION_RESEARCH_MENU_SECTION);
        expect(item.icon, item.title).toBeTruthy();
      }
    }
  } finally {
    await harness?.close();
  }
});

test("a blocked run shows its own artifacts above the stop reason", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(!laneSelectedV1(LANE), `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`);
  test.setTimeout(4 * 60_000);

  let harness: NativeObsidianHarness | null = null;
  try {
    harness = await startNativeObsidianHarness({
      label: "blocked-run-evidence",
      setup: async ({ page }) => {
        await page.evaluate(
          async ({ pluginId }) => {
            const app = (window as typeof window & { app?: any }).app;
            const plugin = app?.plugins?.plugins?.[pluginId];
            if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
            for (const leaf of app.workspace?.getLeavesOfType?.(
              "agentic-researcher-view",
            ) ?? []) {
              leaf.detach?.();
            }
            await plugin.activateView?.();
            const view = plugin.activeAgentView;
            if (!view) throw new Error("Agentic Researcher view did not mount.");
            view.resetDashboardForRun?.();

            // The artifacts a real blocked run leaves behind: the refused tool
            // call with its arguments, and the frontier it was offered.
            view.recordRunFailureEvidence?.({
              id: "tool-result-7",
              kind: "tool_rejected",
              step: 7,
              toolName: "code_workspace_create_file",
              message: "Path already exists: main.py",
              inputPreview: { path: "main.py", createFolders: false },
              error: {
                code: "path_exists",
                message: "Path already exists: main.py",
              },
            });
            view.recordRunFailureEvidence?.({
              id: "model-tool-noncompliance-8",
              kind: "error",
              step: 8,
              message:
                "Blocked: the model twice returned no tool call against the same unchanged executable frontier.",
              outputPreview: {
                code: "model_tool_noncompliance",
                rejectedFrontier: ["code_workspace_create_file"],
                attempts: 2,
              },
              error: {
                code: "model_tool_noncompliance",
                message: "the model twice returned no tool call",
              },
            });

            view.renderChatBlockedContinueAttention?.(
              {
                what: "The mission's internal plan could not advance.",
                why:
                  "Blocked: the model twice returned no tool call against the same unchanged executable frontier. Retry with a tool-compliant model or continue after changing the frontier.",
                next: "Retry the mission; if it repeats, report the run ID from Run Details.",
              },
              "Mission blocked",
              { facts: view.buildRunFailureFacts?.() ?? [] },
            );
          },
          { pluginId: NATIVE_CORE_PLUGIN_ID },
        );
      },
    });

    const evidence = harness.page.getByTestId("chat-blocked-evidence");
    await expect(evidence).toBeVisible();
    await expect(evidence).toContainText("What actually happened");

    // The tool call and its arguments, not a narrative about the model.
    const failedTool = evidence.locator('[data-failure-fact="failed_tool"]');
    await expect(failedTool).toContainText("code_workspace_create_file");
    await expect(failedTool).toContainText('path="main.py"');
    await expect(
      evidence.locator('[data-failure-fact="failed_tool_error"]'),
    ).toContainText("path_exists");

    // A one-tool frontier is the fact that separates "the model stalled" from
    // "the model had exactly one legal call and it was refused".
    const frontier = evidence.locator('[data-failure-fact="offered_frontier"]');
    await expect(frontier).toContainText("Only legal tool call");
    await expect(frontier).toContainText("code_workspace_create_file");

    // The evidence block precedes the narrative in the banner.
    const banner = harness.page.locator(".agentic-researcher-chat-attention");
    const bannerText = (await banner.innerText()).replace(/\s+/gu, " ");
    expect(bannerText.indexOf("What actually happened")).toBeLessThan(
      bannerText.indexOf("Why:"),
    );
    // And the model-blaming narrative is labelled as the run's own account.
    expect(bannerText).toContain("the facts above are what it actually recorded");
  } finally {
    await harness?.close();
  }
});
