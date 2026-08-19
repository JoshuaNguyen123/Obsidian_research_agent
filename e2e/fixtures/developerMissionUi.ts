import type { Page } from "@playwright/test";

import { NATIVE_CORE_PLUGIN_ID } from "./nativeObsidianHarness";

const LIFECYCLE_STAGES = [
  "accepted_research",
  "linear_hierarchy",
  "code_execution",
  "code_validation",
  "private_github_publication",
  "reflection",
] as const;

export async function mountDeveloperMissionProgressUi(page: Page): Promise<void> {
  await page.evaluate(
    async ({ pluginId, stages }) => {
      const app = (window as typeof window & { app?: any }).app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
      for (const leaf of app.workspace?.getLeavesOfType?.("agentic-researcher-view") ?? []) {
        leaf.detach?.();
      }
      plugin.conversationHistory = [];
      await plugin.activateView?.();
      const view = plugin.activeAgentView;
      if (!view) throw new Error("Agentic Researcher view did not mount.");
      view.resetDashboardForRun?.();
      view.showLifecycleStageStrip?.(stages);
      view.setRunning?.(true, "Running developer mission");
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, stages: [...LIFECYCLE_STAGES] },
  );
}

export async function advanceDeveloperMissionToValidation(page: Page): Promise<void> {
  await page.evaluate(({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    const view = plugin?.activeAgentView;
    if (!view) throw new Error("Agentic Researcher view is unavailable.");
    view.appendReceipt?.({
      runId: "e2e-developer-mission-ui",
      toolName: "code_workspace_edit",
      operation: "edit",
      message: "Implementation edit committed with a host receipt.",
      path: "src/feature.ts",
    });
    view.handleToolStart?.({
      id: "e2e-validation-start",
      name: "code_workspace_validate_full",
      step: 4,
      message: "Running full validation.",
    });
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

export async function presentDeveloperMissionCompletionUi(page: Page): Promise<void> {
  await page.evaluate(({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    const view = plugin?.activeAgentView;
    if (!view) throw new Error("Agentic Researcher view is unavailable.");
    const phases = [
      ["research", "Research"],
      ["linear_plan", "Linear plan"],
      ["implement", "Implement"],
      ["test", "Test"],
      ["github", "GitHub"],
      ["reflect", "Reflect"],
    ].map(([id, label]) => ({ id, label, status: "complete" }));
    view.presentDeveloperMissionCompletionV1?.({
      version: 1,
      kind: "developer_mission_completion",
      status: "complete",
      summary: "Research, implementation, validation, publication, and reflection were verified.",
      progress: {
        version: 1,
        kind: "developer_mission_progress",
        phases,
      },
      artifacts: [
        {
          kind: "results",
          label: "Results",
          vaultPath: "Agent Work/Results/e2e-developer-mission-ui.md",
        },
        {
          kind: "linear",
          label: "Linear ENG-42",
          url: "https://linear.app/example/issue/ENG-42",
        },
        { kind: "validation", label: "Validation evidence (2)" },
        {
          kind: "commit",
          label: "Commit 01234567",
          url: "https://github.com/example/repo/commit/0123456789012345678901234567890123456789",
        },
        {
          kind: "pull_request",
          label: "Draft pull request 7",
          url: "https://github.com/example/repo/pull/7",
        },
      ],
    });
    view.setRunning?.(false);
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}
