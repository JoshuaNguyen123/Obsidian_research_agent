import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { Page } from "@playwright/test";

import { NATIVE_CORE_PLUGIN_ID } from "./nativeObsidianHarness";

/**
 * Prepare a human-readable Obsidian state for a genuine demo run.
 *
 * This changes presentation only: the production plugin, model client, tool
 * contracts, approvals, receipts, and cleanup boundary remain untouched.
 */
export async function prepareDemoPresentationV1(
  page: Page,
  notePath: string,
): Promise<void> {
  await page.evaluate(
    async ({ pluginId, notePath, oneDriveRoot, userProfileRoot }) => {
      const app = (window as typeof window & { app?: any }).app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      const file = app?.vault?.getAbstractFileByPath?.(notePath);
      if (!app || !plugin || !file) {
        throw new Error(`Demo presentation could not open ${notePath}.`);
      }

      const leaf =
        app.workspace.getLeavesOfType("markdown")[0] ??
        app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      app.workspace.leftSplit?.collapse?.();
      app.workspace.rightSplit?.expand?.();
      app.setting?.close?.();
      await plugin.activateView?.();

      document.querySelector("#agentic-demo-presentation-style")?.remove();
      const style = document.createElement("style");
      style.id = "agentic-demo-presentation-style";
      style.textContent = [
        "body, body.theme-dark, .theme-dark {",
        "  color-scheme: dark;",
        "  --font-interface: \"Segoe UI Variable Text\", \"Segoe UI\", sans-serif;",
        "  --font-text: \"Segoe UI Variable Text\", \"Segoe UI\", sans-serif;",
        "  --font-monospace: \"Cascadia Mono\", \"Cascadia Code\", Consolas, monospace;",
        "  --background-primary: #151513;",
        "  --background-primary-alt: #191917;",
        "  --background-secondary: #1c1c19;",
        "  --background-secondary-alt: #22221e;",
        "  --background-modifier-border: #34342f;",
        "  --background-modifier-border-hover: #484740;",
        "  --background-modifier-hover: #292925;",
        "  --background-modifier-active-hover: #30302b;",
        "  --text-normal: #ebe8df;",
        "  --text-muted: #aaa79d;",
        "  --text-faint: #77746d;",
        "  --text-accent: #8fbea0;",
        "  --text-accent-hover: #a2caae;",
        "  --text-on-accent: #111410;",
        "  --interactive-normal: #242420;",
        "  --interactive-hover: #2d2d28;",
        "  --interactive-accent: #79aa8b;",
        "  --interactive-accent-hover: #8bb99a;",
        "  --color-green: #79aa8b;",
        "  --text-success: #8fbea0;",
        "}",
        ".tooltip,",
        ".notice-container,",
        ".mod-root .workspace-leaf-content[data-type='markdown'] > .view-header,",
        ".mod-root .workspace-tab-header-container,",
        ".mod-root .workspace-tab-header-status-container,",
        ".agentic-researcher-prompt-shortcut,",
        ".agentic-researcher-chat-only-toggle,",
        ".agentic-researcher-clear,",
        ".agentic-researcher-log-system,",
        ".agentic-researcher-steering,",
        ".agentic-researcher-copy,",
        ".agentic-researcher-metrics,",
        ".agentic-researcher-dashboard-section-status,",
        ".agentic-researcher-dashboard-section-evidence,",
        ".agentic-researcher-dashboard-section-preview,",
        ".agentic-researcher-dashboard-diagnostics,",
        ".agentic-researcher-orchestrator-reference,",
        ".agentic-researcher-payload {",
        "  display: none !important;",
        "}",
        ".workspace-ribbon.mod-left,",
        ".workspace-split.mod-left-split {",
        "  display: none !important;",
        "}",
        ".workspace-split.mod-right-split {",
        "  flex: 0 0 520px !important;",
        "  width: 520px !important;",
        "}",
        ".agentic-researcher-tabs.has-orchestrator {",
        "  grid-template-columns: repeat(2, minmax(0, 1fr)) !important;",
        "}",
        ".agentic-researcher-dashboard-section-final-answer .agentic-researcher-dashboard-body,",
        ".agentic-researcher-dashboard-section-receipts .agentic-researcher-dashboard-body,",
        ".agentic-researcher-dashboard-section-acceptance .agentic-researcher-dashboard-body {",
        "  max-height: none;",
        "}",
        ".markdown-preview-view, .markdown-source-view {",
        "  line-height: 1.55;",
        "}",
      ].join("\n");
      document.head.append(style);
      document.querySelectorAll(".tooltip, .notice").forEach((element) => {
        element.remove();
      });

      const win = window as typeof window & {
        __agenticDemoRedactionObserver?: MutationObserver;
      };
      win.__agenticDemoRedactionObserver?.disconnect();
      const replacements = [
        oneDriveRoot
          ? [`${oneDriveRoot.replace(/[\\/]+$/u, "")}\\Desktop\\`, "Desktop\\"]
          : null,
        userProfileRoot
          ? [`${userProfileRoot.replace(/[\\/]+$/u, "")}\\Desktop\\`, "Desktop\\"]
          : null,
        userProfileRoot
          ? [userProfileRoot.replace(/[\\/]+$/u, ""), "%USERPROFILE%"]
          : null,
      ].filter((item): item is [string, string] => item !== null);
      const redactTextNode = (node: Node): void => {
        let value = node.nodeValue ?? "";
        for (const [needle, replacement] of replacements) {
          value = value.split(needle).join(replacement);
        }
        if (value !== node.nodeValue) node.nodeValue = value;
      };
      const redactPersonalPaths = (root: Node): void => {
        if (root.nodeType === Node.TEXT_NODE) {
          redactTextNode(root);
          return;
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let current = walker.nextNode();
        while (current) {
          redactTextNode(current);
          current = walker.nextNode();
        }
      };
      const hideEphemeralRows = (): void => {
        for (const key of Array.from(
          document.querySelectorAll<HTMLElement>(
            ".agentic-researcher-acceptance-key",
          ),
        )) {
          const normalizedKey = key.textContent?.trim().toLowerCase() ?? "";
          if (normalizedKey === "status") {
            const value = key.parentElement?.querySelector<HTMLElement>(
              ".agentic-researcher-acceptance-value",
            );
            const status = value?.textContent?.trim().split(/\s+/u)[0] ?? "";
            // This helper runs inside a subtree MutationObserver. Reassigning
            // identical text still emits a child-list mutation in Chromium,
            // which recursively schedules the observer and can starve the
            // renderer exactly when terminal acceptance appears.
            if (value && status && value.textContent?.trim() !== status) {
              value.textContent = status;
            }
          }
          if (
            [
              "checked_at",
              "confidence",
              "source",
              "next_action",
              "reasons",
            ].includes(normalizedKey)
          ) {
            key.closest<HTMLElement>(".agentic-researcher-acceptance-row")?.style.setProperty(
              "display",
              "none",
              "important",
            );
          }
        }
        for (const item of Array.from(
          document.querySelectorAll<HTMLElement>(
            ".agentic-researcher-log-item",
          ),
        )) {
          const text = item.textContent?.replace(/\s+/gu, " ").trim() ?? "";
          if (
            /^SYSTEM Agent ready\. Persistent chat memory is on\./iu.test(text) ||
            /Chat memory cleared\. Vault notes were not modified/iu.test(text) ||
            /Click Confirm clear to clear chat history only/iu.test(text) ||
            /linear\.app\/e2e\/issue\/E2E-/iu.test(text)
          ) {
            item.remove();
          }
        }
        for (const line of Array.from(
          document.querySelectorAll<HTMLElement>(
            ".agentic-researcher-live-workstream-line",
          ),
        )) {
          const text = line.textContent?.replace(/\s+/gu, " ").trim() ?? "";
          if (
            /^(?:Research-team routing:|Classifying mission|Agent step \d+ of \d+|Thinking\.\.\.|Run diagnostics:|Tool complete:)/iu.test(
              text,
            )
          ) {
            line.remove();
            continue;
          }
          const readableToolEvent = [
            [/^Used code_workspace_create_file\b/iu, "Created text_file_organizer.py"],
            [/^Used code_validate_fast\b/iu, "Fast validation passed"],
            [/^Used code_validate_targeted\b/iu, "Targeted validation passed"],
            [/^Used code_validate_full\b/iu, "Full validation passed"],
            [
              /^Used code_workspace_export_directory\b/iu,
              "Delivered verified Desktop folder",
            ],
          ].find(([pattern]) => (pattern as RegExp).test(text));
          if (readableToolEvent) {
            line.textContent = readableToolEvent[1] as string;
          }
        }
        for (const tab of Array.from(
          document.querySelectorAll<HTMLElement>(
            ".agentic-researcher-tab",
          ),
        )) {
          if (tab.textContent?.trim() === "Orchestrator") {
            tab.style.setProperty("display", "none", "important");
          }
        }
      };
      redactPersonalPaths(document.body);
      hideEphemeralRows();
      win.__agenticDemoRedactionObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "characterData") {
            redactPersonalPaths(mutation.target);
          }
          for (const node of Array.from(mutation.addedNodes)) {
            redactPersonalPaths(node);
          }
        }
        hideEphemeralRows();
      });
      win.__agenticDemoRedactionObserver.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    },
    {
      pluginId: NATIVE_CORE_PLUGIN_ID,
      notePath,
      oneDriveRoot: process.env.OneDrive?.trim() ?? "",
      userProfileRoot: process.env.USERPROFILE?.trim() ?? "",
    },
  );
  await page.getByRole("tab", { name: "Chat" }).click().catch(() => undefined);
}

/**
 * Prove the presentation observer reaches quiescence before a real mission.
 *
 * Chromium emits a child-list mutation even when textContent is assigned the
 * same text. A non-idempotent observer therefore loops forever and starves the
 * terminal mission UI. The node-side deadline turns that regression into a
 * fast, explicit lane failure instead of a thirty-five-minute frozen capture.
 */
export async function assertDemoPresentationObserverSettlesV1(
  page: Page,
  timeoutMs = 5_000,
): Promise<void> {
  const probe = page.evaluate(async () => {
    const row = document.createElement("div");
    row.hidden = true;
    row.innerHTML = [
      '<span class="agentic-researcher-acceptance-key">status</span>',
      '<span class="agentic-researcher-acceptance-value">pass 0.91</span>',
    ].join("");
    document.body.append(row);
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      return (
        row.querySelector<HTMLElement>(
          ".agentic-researcher-acceptance-value",
        )?.textContent?.trim() ?? ""
      );
    } finally {
      row.remove();
    }
  });
  void probe.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const normalized = await Promise.race([
      probe,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Demo presentation observer did not settle within ${timeoutMs}ms.`,
              ),
            ),
          Math.max(250, timeoutMs),
        );
      }),
    ]);
    if (normalized !== "pass") {
      throw new Error(
        `Demo presentation observer returned an unexpected acceptance label: ${JSON.stringify(normalized)}.`,
      );
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export interface DemoMissionBrokerResultV1 {
  approvals: number;
  complete: boolean;
  seenRunning: boolean;
  runId: string | null;
  statusText: string;
  stopReason: string | null;
  error: string | null;
}

/**
 * Install the recording lane's approval observer before a mission starts.
 *
 * Some code actions keep Electron's CDP Runtime.evaluate request pending while
 * their host handler is active even though Obsidian continues to render. A
 * Node-side polling loop therefore cannot reliably click the next approval or
 * observe completion. This page-owned broker performs the same real button
 * clicks from the release UI and records only bounded control state; it does
 * not execute tools, synthesize receipts, or alter mission state directly.
 */
export async function installDemoMissionBrokerV1(page: Page): Promise<void> {
  await page.evaluate(({ pluginId }) => {
    interface BrokerState {
      approvals: number;
      complete: boolean;
      seenRunning: boolean;
      runId: string | null;
      statusText: string;
      stopReason: string | null;
      error: string | null;
    }
    interface BrokerController {
      state: BrokerState;
      stop(): void;
    }
    const win = window as typeof window & {
      __agenticDemoMissionBrokerV1?: BrokerController;
    };
    win.__agenticDemoMissionBrokerV1?.stop();

    const state: BrokerState = {
      approvals: 0,
      complete: false,
      seenRunning: false,
      runId: null,
      statusText: "",
      stopReason: null,
      error: null,
    };
    let intervalId = 0;
    let observer: MutationObserver | null = null;
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(intervalId);
      observer?.disconnect();
    };
    const tick = (): void => {
      if (stopped) return;
      try {
        const app = (window as typeof window & { app?: any }).app;
        const plugin = app?.plugins?.plugins?.[pluginId];
        const snapshot = plugin?.getMissionRunSnapshot?.();
        const pluginRunning = plugin?.isMissionRunning?.() === true;
        const runText =
          document
            .querySelector("button.agentic-researcher-run")
            ?.textContent?.trim() ?? "";
        state.statusText =
          document
            .querySelector(".agentic-researcher-run-status-text")
            ?.textContent?.trim() ?? "";
        state.stopReason = snapshot?.lastComplete?.stopReason ?? null;
        if (typeof snapshot?.lastMissionLedger?.runId === "string") {
          state.runId = snapshot.lastMissionLedger.runId;
        }
        if (pluginRunning) state.seenRunning = true;

        const buttons = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            "button[data-testid='chat-approval-approve']:not(:disabled):not([data-demo-approval-scheduled]), button.agentic-researcher-approval-approve:not(:disabled):not([data-demo-approval-scheduled])",
          ),
        );
        const button =
          buttons.find(
            (candidate) =>
              candidate.getAttribute("data-testid") ===
              "chat-approval-approve",
          ) ??
          buttons.find((candidate) => candidate.getClientRects().length > 0) ??
          buttons.at(-1);
        if (button) {
          button.dataset.demoApprovalScheduled = "true";
          window.setTimeout(() => {
            if (!button.isConnected || button.disabled) return;
            state.approvals += 1;
            button.click();
            const card = button.closest(
              ".agentic-researcher-approval-card, .agentic-researcher-chat-attention-controls, .agentic-researcher-chat-attention",
            );
            for (const action of Array.from(
              card?.querySelectorAll<HTMLButtonElement>(
                "button.agentic-researcher-approval-approve, button.agentic-researcher-approval-deny, button[data-testid='chat-approval-approve'], button[data-testid='chat-approval-deny']",
              ) ?? [button],
            )) {
              action.disabled = true;
            }
          }, 450);
        }

        if (
          state.seenRunning &&
          !pluginRunning &&
          !button &&
          runText === "Run Mission" &&
          /^Idle(?:\s+\u00b7\s+\S.*)?$/iu.test(state.statusText)
        ) {
          state.complete = true;
          stop();
        }
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        stop();
      }
    };

    win.__agenticDemoMissionBrokerV1 = { state, stop };
    intervalId = window.setInterval(tick, 125);
    observer = new MutationObserver(tick);
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    tick();
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

/**
 * Start this wait before submitting the mission so its in-page predicate is
 * registered before any long approval handler can occupy the renderer.
 */
export function waitForDemoMissionBrokerV1(
  page: Page,
  timeoutMs: number,
): Promise<DemoMissionBrokerResultV1> {
  return (async () => {
    await page.waitForFunction(
      () => {
        const win = window as typeof window & {
          __agenticDemoMissionBrokerV1?: {
            state?: { complete?: boolean; error?: string | null };
          };
        };
        const state = win.__agenticDemoMissionBrokerV1?.state;
        return state?.complete === true || Boolean(state?.error);
      },
      undefined,
      { timeout: timeoutMs, polling: 250 },
    );
    const result = await page.evaluate(() => {
      const win = window as typeof window & {
        __agenticDemoMissionBrokerV1?: {
          state?: DemoMissionBrokerResultV1;
        };
      };
      return win.__agenticDemoMissionBrokerV1?.state ?? null;
    });
    if (!result) {
      throw new Error("The demo mission broker disappeared before completion.");
    }
    if (result.error) {
      throw new Error(`The demo mission broker failed: ${result.error}`);
    }
    return result;
  })();
}

/**
 * Leave the release UI in a quiet proof state: the answer, receipt, and
 * acceptance stay visible while presentation-only diagnostics remain hidden.
 */
export async function prepareDemoFinaleV1(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>(
        ".agentic-researcher-dashboard details",
      )
      .forEach((details) => {
        details.open = false;
      });
    document
      .querySelectorAll<HTMLElement>(
        ".agentic-researcher-details-panel, .agentic-researcher-dashboard",
      )
      .forEach((element) => {
        element.scrollTop = 0;
      });
  });
  await page.waitForTimeout(1_500);
}

/**
 * Reject a recording marker when the pixels a viewer can actually see still
 * contain harness language, personal paths, or a duplicated note heading.
 */
export async function assertDemoFrameCleanV1(
  page: Page,
  expectedNoteTitle: string,
  options: Readonly<{ requireSingleTitle?: boolean }> = {},
): Promise<void> {
  const frame = await page.evaluate(
    ({ expectedNoteTitle, requireSingleTitle }) => {
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      const textNodes: string[] = [];
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      let node = walker.nextNode();
      while (node) {
        const value = node.nodeValue?.replace(/\s+/gu, " ").trim() ?? "";
        const parent = node.parentElement;
        if (value && parent) {
          const style = getComputedStyle(parent);
          const rect = parent.getBoundingClientRect();
          const intersectsViewport =
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < viewport.width &&
            rect.top < viewport.height;
          if (
            intersectsViewport &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0
          ) {
            textNodes.push(value);
          }
        }
        node = walker.nextNode();
      }
      const visibleText = textNodes.join("\n");
      const activeMarkdownLeaf =
        document.querySelector<HTMLElement>(
          ".mod-root .workspace-leaf.mod-active .workspace-leaf-content[data-type='markdown']",
        ) ??
        document.querySelector<HTMLElement>(
          ".mod-root .workspace-leaf-content[data-type='markdown']",
        );
      const inlineTitle =
        activeMarkdownLeaf
          ?.querySelector<HTMLElement>(".inline-title")
          ?.textContent?.trim() ?? "";
      const titleOccurrences = visibleText
        .split(expectedNoteTitle)
        .length - 1;
      return {
        visibleText,
        inlineTitle,
        titleOccurrences,
        requireSingleTitle,
      };
    },
    {
      expectedNoteTitle,
      requireSingleTitle: options.requireSingleTitle === true,
    },
  );

  const forbidden = [
    /\bE2E(?:[-_\s]|$)/iu,
    /\bPlaywright\b/iu,
    /\btest[-_\s]?vault\b/iu,
    /\bE2E Agent Tests\b/iu,
    /[A-Z]:\\Users\\/u,
  ];
  const violation = forbidden.find((pattern) =>
    pattern.test(frame.visibleText),
  );
  if (violation) {
    throw new Error(
      `Demo frame contains forbidden visible text ${violation}: ${frame.visibleText.slice(
        0,
        2_000,
      )}`,
    );
  }
  if (frame.inlineTitle !== expectedNoteTitle) {
    throw new Error(
      `Demo frame opened "${frame.inlineTitle || "(no title)"}"; expected "${expectedNoteTitle}".`,
    );
  }
  if (frame.requireSingleTitle && frame.titleOccurrences !== 1) {
    throw new Error(
      `Demo opening must show "${expectedNoteTitle}" exactly once; found ${frame.titleOccurrences}.`,
    );
  }
}

/**
 * Write bounded, secret-free shot markers beside raw footage when the capture
 * wrapper provided a directory. The markers make the later edit reproducible.
 */
export async function recordDemoMomentV1(
  name: string,
  details: Readonly<Record<string, string | number | boolean | null>> = {},
): Promise<void> {
  const captureDirectory = process.env.DEMO_CAPTURE_DIR?.trim();
  if (!captureDirectory) return;
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(name)) {
    throw new Error(`Invalid demo moment name: ${name}`);
  }
  const safeDetails = Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key.replace(/[^a-z0-9_-]+/giu, "-").slice(0, 64),
      typeof value === "string" ? value.slice(0, 160) : value,
    ]),
  );
  await mkdir(captureDirectory, { recursive: true });
  await appendFile(
    path.join(captureDirectory, "timeline.ndjson"),
    `${JSON.stringify({
      version: 1,
      at: new Date().toISOString(),
      name,
      details: safeDetails,
    })}\n`,
    "utf8",
  );
}
