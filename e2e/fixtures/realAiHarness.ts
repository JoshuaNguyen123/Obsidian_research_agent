import { expect, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

import {
  getE2EAiConfig,
  getE2EAiCredential,
  type E2EAiConfig,
} from "../aiHarness";
import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./nativeObsidianHarness";

export interface RealAiHarness extends NativeObsidianHarness {
  config: E2EAiConfig;
  submitMission(prompt: string, options?: { waitForCompletion?: boolean; timeoutMs?: number }): Promise<void>;
  waitForMissionComplete(timeoutMs?: number): Promise<void>;
  seedNote(path: string, content: string, activate?: boolean): Promise<void>;
  indexSemanticNotes(paths: string[]): Promise<void>;
  readNote(path?: string): Promise<string>;
  installOwnedWebBackend(options?: {
    failFirstFetch?: boolean;
    sourceCount?: 2 | 3;
    topic?: "generic" | "checkers";
  }): Promise<void>;
  attestProductionRun(options?: { requireStructuredRouting?: boolean }): Promise<any>;
  restartCorePlugin(): Promise<void>;
  approveUntilMissionComplete(
    timeoutMs?: number,
    options?: CompoundMissionApprovalOptions,
  ): Promise<number>;
  activePreparedApproval(toolName: string): Locator;
  approve(approval: Locator): Promise<void>;
  deny(approval: Locator): Promise<void>;
}

export type ProjectLifecycleStageName =
  | "accepted_research"
  | "linear_hierarchy"
  | "code_execution"
  | "private_github_publication"
  | "reconciliation_cleanup";

export interface CompoundMissionApprovalOptions {
  maxContinuations?: number;
  /** Restart the production plugin immediately after selected durable stage commits. */
  restartAfterProjectStages?: readonly ProjectLifecycleStageName[];
  onStageRestarted?: (stage: ProjectLifecycleStageName) => Promise<void>;
}

export interface RealAiHarnessNativeOptions {
  /** Reuse only the vault's opaque native Linear reference; never copy a token. */
  preserveConfiguredLinearCredential?: boolean;
  /** Reuse only the vault's opaque native GitHub reference; never copy a token. */
  preserveConfiguredGitHubCredential?: boolean;
}

const PROJECT_STAGE_COMPLETION_TOOL: Readonly<
  Record<ProjectLifecycleStageName, string>
> = Object.freeze({
  accepted_research: "publish_research_to_linear",
  linear_hierarchy: "publish_research_project_to_linear",
  code_execution: "code_commit_verified",
  private_github_publication: "publish_verified_code_to_github",
  reconciliation_cleanup: "github_delete_private_repository",
});

export async function startRealAiHarness(
  label: string,
  overrides: Partial<E2EAiConfig> = {},
  pluginDataOverrides: Readonly<Record<string, unknown>> = {},
  nativeOptions: RealAiHarnessNativeOptions = {},
): Promise<RealAiHarness> {
  const config = { ...getE2EAiConfig(), ...overrides, mode: "real" as const };
  const ownedIndexLabel = label.replace(/[^A-Za-z0-9_-]+/gu, "-").slice(0, 80);
  const provider =
    process.env.E2E_MODEL_PROVIDER === "openai_compatible"
      ? "openai_compatible"
      : "ollama";
  const credential = getE2EAiCredential(provider);
  const corePluginDataOverrides: Record<string, unknown> = {
    modelProvider: provider,
    model: config.model,
    enableStreaming: false,
    thinkingMode: "off",
    requestTimeoutMs: config.missionTimeoutMs,
    maxRunMinutes: 14,
    maxAgentSteps: 24,
    modelRouterEnabled: true,
    modelRouterMode: "authority",
    streamWritebackMode: "off",
    semanticIndexEnabled: true,
    // A missing or incompatible index makes updatePaths() rebuild the configured
    // vault slice. Keep that production fallback real, but bound it to an owned
    // per-scenario fixture so a developer's shared test-vault size cannot turn a
    // semantic contract test into an unbounded soak.
    semanticIndexFolder: `E2E Agent Tests/.semantic-index-${ownedIndexLabel}`,
    semanticIndexMaxFiles: 16,
    autoTitleOnWrite: false,
    orchestratorEnabled: false,
    agenticReflexEnabled: true,
    ...pluginDataOverrides,
  };
  if (provider === "openai_compatible") {
    corePluginDataOverrides.openAiCompatibleBaseUrl =
      process.env.E2E_OPENAI_COMPATIBLE_BASE_URL?.trim() || config.baseUrl;
    if (credential) corePluginDataOverrides.openAiCompatibleApiKey = credential;
  } else {
    corePluginDataOverrides.ollamaBaseUrl = config.baseUrl;
    if (credential) corePluginDataOverrides.ollamaApiKey = credential;
  }

  const native = await startNativeObsidianHarness({
    label,
    corePluginDataOverrides,
    preserveConfiguredLinearCredential:
      nativeOptions.preserveConfiguredLinearCredential === true,
    preserveConfiguredGitHubCredential:
      nativeOptions.preserveConfiguredGitHubCredential === true,
    setup: installRealAiPageHarness,
    beforeClose: async ({ page }) => restoreOwnedWebBackend(page),
  });
  try {
    await expect(native.page.locator(".agentic-researcher-view")).toHaveCount(1, {
      timeout: 30_000,
    });
    await assertProductionClientReady(native.page, config, provider);
  } catch (error) {
    await native.close().catch(() => undefined);
    throw error;
  }

  return {
    ...native,
    config,
    submitMission: (prompt, options = {}) => submitMission(native.page, prompt, {
      timeoutMs: options.timeoutMs ?? config.missionTimeoutMs,
      waitForCompletion: options.waitForCompletion,
    }),
    waitForMissionComplete: (timeoutMs = config.completionTimeoutMs) =>
      waitForMissionComplete(native.page, timeoutMs),
    seedNote: (path, content, activate = false) =>
      seedNote(native.page, path, content, activate),
    indexSemanticNotes: (paths) => indexSemanticNotes(native.page, paths),
    readNote: async (target = native.noteFilePath) => readFile(target, "utf8"),
    installOwnedWebBackend: (options = {}) =>
      installOwnedWebBackend(native.page, native.marker, options),
    attestProductionRun: (options = {}) =>
      attestProductionRun(native.page, config, options),
    restartCorePlugin: () =>
      restartCorePlugin(native.page, config, provider),
    approveUntilMissionComplete: (
      timeoutMs = config.completionTimeoutMs,
      options = {},
    ) =>
      approveUntilMissionComplete(native.page, timeoutMs, {
        ...options,
        restartCorePlugin: (stage) =>
          restartCorePlugin(native.page, config, provider, stage).then(async () => {
            await options.onStageRestarted?.(stage);
          }),
      }),
    activePreparedApproval: (toolName) => activePreparedApproval(native.page, toolName),
    approve: (approval) => resolveApproval(approval, "approve"),
    deny: (approval) => resolveApproval(approval, "deny"),
  };
}

async function restartCorePlugin(
  page: Page,
  config: E2EAiConfig,
  provider: "ollama" | "openai_compatible",
  stage?: ProjectLifecycleStageName,
): Promise<void> {
  await page.evaluate(async ({ pluginId, requiredLifecycleTool }) => {
    const app = (window as typeof window & { app?: any }).app;
    if (!app?.plugins?.disablePlugin || !app?.plugins?.enablePlugin) {
      throw new Error("Obsidian plugin lifecycle APIs are unavailable.");
    }
    const activePlugin = app.plugins.plugins?.[pluginId];
    if (requiredLifecycleTool) {
      const prepared =
        await activePlugin?.prepareForDurableMissionRestart?.(
          requiredLifecycleTool,
        );
      if (prepared !== true) {
        throw new Error(
          "The active lifecycle stage did not reach a quiescent durable restart boundary.",
        );
      }
    }
    await app.plugins.disablePlugin(pluginId);
    await app.plugins.enablePlugin(pluginId);
    let plugin: any = null;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      plugin = app.plugins.plugins?.[pluginId] ?? null;
      if (plugin?.agenticResearcherApi?.state === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (plugin?.agenticResearcherApi?.state !== "ready") {
      throw new Error("Agentic Researcher did not become ready after restart.");
    }
    await plugin.activateView?.();
  }, {
    pluginId: NATIVE_CORE_PLUGIN_ID,
    requiredLifecycleTool: stage
      ? PROJECT_STAGE_COMPLETION_TOOL[stage]
      : null,
  });
  await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
    timeout: 30_000,
  });
  await assertProductionClientReady(page, config, provider);
}

async function approveUntilMissionComplete(
  page: Page,
  timeoutMs: number,
  options: CompoundMissionApprovalOptions & {
    restartCorePlugin?: (stage: ProjectLifecycleStageName) => Promise<void>;
  } = {},
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let approvals = 0;
  let continuations = 0;
  let missingContinuationPolls = 0;
  let lastDurableState: Record<string, unknown> | null = null;
  const maximumContinuations = Math.max(
    1,
    Math.min(12, Math.floor(options.maxContinuations ?? 3)),
  );
  const restartStages = new Set(options.restartAfterProjectStages ?? []);
  const restartedStages = new Set<ProjectLifecycleStageName>();
  await page.getByRole("tab", { name: "Run Details" }).click({ timeout: 10_000 });
  while (Date.now() < deadline) {
    const ui = await page.evaluate(async ({ pluginId }) => {
      const app = (window as typeof window & { app?: any }).app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      const snapshot = plugin?.getMissionRunSnapshot?.();
      const durableRestart =
        await plugin?.getDurableMissionRestartReadiness?.() ?? null;
      const lastError = Array.from(document.querySelectorAll<HTMLElement>(
        ".agentic-researcher-log-error .agentic-researcher-log-message",
      )).at(-1)?.textContent ?? "";
      return {
        runText: document.querySelector("button.agentic-researcher-run")?.textContent?.trim() ?? "",
        statusText: document.querySelector(".agentic-researcher-run-status-text")?.textContent?.trim() ?? "",
        hasEnabledApproval: Array.from(document.querySelectorAll<HTMLButtonElement>(
          "button.agentic-researcher-approval-approve:not(:disabled)",
        )).some((button) => button.getClientRects().length > 0),
        stopReason: snapshot?.lastComplete?.stopReason ?? null,
        canResume: snapshot?.lastMissionLedger?.canResume === true,
        continuationCommand:
          snapshot?.lastMissionLedger?.continuationCommand ?? "",
        acceptanceStatus:
          snapshot?.lastMissionLedger?.acceptance?.status ?? null,
        ledgerStatus: snapshot?.lastMissionLedger?.status ?? null,
        ledger: snapshot?.lastMissionLedger
          ? {
              status: snapshot.lastMissionLedger.status,
              acceptance: snapshot.lastMissionLedger.acceptance,
              evidenceCount: snapshot.lastMissionLedger.evidenceCount,
              receiptCount: snapshot.lastMissionLedger.receiptCount,
              nextAction: snapshot.lastMissionLedger.nextAction,
            }
          : null,
        graph: snapshot?.lastMissionGraph
          ? Object.values(snapshot.lastMissionGraph.nodes ?? {}).map((node: any) => ({
              id: node.id,
              status: node.status,
              allowedTools: node.allowedTools,
              attempts: node.retries?.attempts ?? 0,
              blockerCode: node.blocker?.code ?? null,
              blockerMessage:
                typeof node.blocker?.message === "string"
                  ? node.blocker.message.slice(0, 500)
                  : null,
            }))
          : [],
        providerUsage: snapshot?.providerUsage ?? null,
        lastComplete: snapshot?.lastComplete ?? null,
        modelCallPhases: Array.isArray(snapshot?.modelCallEvidence)
          ? snapshot.modelCallEvidence.slice(-4).map((item: any) => ({
              phase: item?.phase ?? null,
              outcome: item?.outcome ?? null,
            }))
          : [],
        lastError: lastError
          .replace(/(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9_]+|[A-Za-z0-9_-]{48,})/giu, "[REDACTED]")
          .slice(0, 500),
        diagnostics: Array.isArray(snapshot?.diagnosticAttestations)
          ? snapshot.diagnosticAttestations.slice(-12).map((item: any) => ({
              id: item.id ?? null,
              errorCode: item.errorCode ?? null,
              message: typeof item.message === "string"
                ? item.message
                    .replace(/(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{48,})/giu, "[REDACTED]")
                    .slice(0, 500)
                : "",
            }))
          : [],
        hasGraphBlocker: Object.values(snapshot?.lastMissionGraph?.nodes ?? {}).some(
          (node: any) => node?.status === "blocked" || Boolean(node?.blocker),
        ),
        projectStages: Array.from(new Set(
          (app?.plugins?.plugins?.[pluginId]?.getProjectLineages?.() ?? [])
            .flatMap((lineage: any) =>
              Array.isArray(lineage?.commits)
                ? lineage.commits.map((commit: any) => commit?.stage)
                : [],
            )
            .filter((stage: unknown) => typeof stage === "string"),
        )),
        durablyCompletedLifecycleTools: Array.isArray(
          durableRestart?.completedLifecycleTools,
        )
          ? durableRestart.completedLifecycleTools.filter(
              (toolName: unknown) => typeof toolName === "string",
            )
          : [],
      };
    }, { pluginId: NATIVE_CORE_PLUGIN_ID });
    const preAuthorityReconciliationBlock = ui.diagnostics.some(
      (diagnostic: { id: string; errorCode: string }) =>
        diagnostic.id === "resume-mutation-reconciliation-required" ||
        diagnostic.errorCode === "mutation_reconciliation_required",
    );
    const previousDiagnostics = Array.isArray(lastDurableState?.diagnostics)
      ? lastDurableState.diagnostics
      : [];
    const preservesRicherFailureState =
      previousDiagnostics.length > 0 && ui.diagnostics.length === 0;
    if (
      (ui.ledger || ui.graph.length > 0) &&
      !preAuthorityReconciliationBlock &&
      !preservesRicherFailureState
    ) {
      lastDurableState = JSON.parse(JSON.stringify(ui)) as Record<string, unknown>;
    }
    const committedRestartStage = ui.projectStages.find(
      (stage): stage is ProjectLifecycleStageName =>
        restartStages.has(stage as ProjectLifecycleStageName) &&
        !restartedStages.has(stage as ProjectLifecycleStageName) &&
        ui.graph.some(
          (node) =>
            node.status === "complete" &&
            node.allowedTools.includes(
              PROJECT_STAGE_COMPLETION_TOOL[stage as ProjectLifecycleStageName],
            ),
        ) &&
        ui.durablyCompletedLifecycleTools.includes(
          PROJECT_STAGE_COMPLETION_TOOL[stage as ProjectLifecycleStageName],
        ),
    );
    if (committedRestartStage && options.restartCorePlugin) {
      restartedStages.add(committedRestartStage);
      await options.restartCorePlugin(committedRestartStage);
      await page.getByRole("tab", { name: "Run Details" }).click({ timeout: 10_000 });
      const continued = await continueLatestRunAfterStageRestart(page);
      if (continued) continuations += 1;
      continue;
    }
    if (ui.hasEnabledApproval) {
      const clicked = await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>(
          "button.agentic-researcher-approval-approve:not(:disabled)",
        )).find((candidate) => candidate.getClientRects().length > 0);
        if (!button) return false;
        button.click();
        return true;
      });
      if (clicked) {
        approvals += 1;
      }
      await page.waitForTimeout(100);
      continue;
    }
    if (ui.runText === "Run Mission" && ui.statusText === "Idle") {
      if (ui.acceptanceStatus === "pass" || ui.ledgerStatus === "complete") {
        return approvals;
      }
      if (
        !ui.hasGraphBlocker &&
        (
          ui.stopReason === "budget" ||
          (
            ui.stopReason === null &&
            ui.canResume &&
            Boolean(ui.continuationCommand)
          )
        )
      ) {
        const continuation = page.getByRole("button", {
          name: /Continue Latest Run/iu,
        });
        if (!ui.canResume || !ui.continuationCommand) {
          throw new Error(
            `Idle mission did not expose its required durable continuation: ${JSON.stringify(ui)}.`,
          );
        }
        const visible = await continuation.isVisible().catch(() => false);
        const enabled = visible
          ? await continuation.isEnabled().catch(() => false)
          : false;
        if (!visible || !enabled) {
          missingContinuationPolls += 1;
          if (missingContinuationPolls >= 40) {
            throw new Error(
              `Mission is resumable but its continuation action stayed unavailable; approved=${approvals}; state=${JSON.stringify(ui)}.`,
            );
          }
          await page.waitForTimeout(250);
          continue;
        }
        missingContinuationPolls = 0;
        continuations += 1;
        if (continuations > maximumContinuations) {
          throw new Error(
            `Mission exceeded ${maximumContinuations} explicit continuations; approved=${approvals}; state=${JSON.stringify(ui)}.`,
          );
        }
        await continuation.click();
        await page.waitForTimeout(250);
        continue;
      }
      throw new Error(
        `Mission stopped before acceptance; approved=${approvals}; state=${JSON.stringify(ui)}; previousDurableState=${JSON.stringify(lastDurableState)}.`,
      );
    }
    missingContinuationPolls = 0;
    await page.waitForTimeout(250);
  }
  const safeState = await page.evaluate(({ pluginId }) => {
    const app = (window as typeof window & { app?: any }).app;
    const snapshot = app?.plugins?.plugins?.[pluginId]?.getMissionRunSnapshot?.();
    return {
      phase: snapshot?.phase ?? null,
      complete: snapshot?.lastComplete ?? null,
      graph: snapshot?.lastMissionGraph
        ? {
            revision: snapshot.lastMissionGraph.revision,
            routing: snapshot.lastMissionGraph.routing,
            nodes: Object.values(snapshot.lastMissionGraph.nodes ?? {}).map((node: any) => ({
              id: node.id,
              status: node.status,
              allowedTools: node.allowedTools,
              attempts: node.retries?.attempts ?? 0,
              blockerCode: node.blocker?.code ?? null,
              blockerMessage:
                typeof node.blocker?.message === "string"
                  ? node.blocker.message.slice(0, 500)
                  : null,
            })),
          }
        : null,
      acceptance: snapshot?.lastMissionLedger?.acceptance ?? null,
      providerUsage: snapshot?.providerUsage ?? null,
      diagnostics: Array.isArray(snapshot?.diagnosticAttestations)
        ? snapshot.diagnosticAttestations.slice(-12).map((item: any) => ({
            id: item.id ?? null,
            errorCode: item.errorCode ?? null,
            message: typeof item.message === "string"
              ? item.message
                  .replace(/(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{48,})/giu, "[REDACTED]")
                  .slice(0, 500)
              : "",
          }))
        : [],
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
  throw new Error(
    `Timed out after ${timeoutMs} ms while resolving prepared approvals; approved=${approvals}; state=${JSON.stringify(safeState)}; previousDurableState=${JSON.stringify(lastDurableState)}.`,
  );
}

async function continueLatestRunAfterStageRestart(page: Page): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  let lastState: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const state = await page.evaluate(({ pluginId }) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
      const snapshot = plugin?.getMissionRunSnapshot?.();
      return {
        running: plugin?.isMissionRunning?.() === true,
        phase: snapshot?.phase ?? null,
        complete:
          snapshot?.lastMissionLedger?.acceptance?.status === "pass" ||
          snapshot?.lastMissionLedger?.status === "complete",
        ledgerStatus: snapshot?.lastMissionLedger?.status ?? null,
        acceptanceStatus: snapshot?.lastMissionLedger?.acceptance?.status ?? null,
        canResume: snapshot?.lastMissionLedger?.canResume === true,
        continuationCommand: snapshot?.lastMissionLedger?.continuationCommand ?? "",
        nextAction: snapshot?.lastMissionLedger?.nextAction ?? null,
        blockerCategory: snapshot?.lastMissionLedger?.blockerCategory ?? null,
        graph: snapshot?.lastMissionGraph
          ? Object.values(snapshot.lastMissionGraph.nodes ?? {}).map((node: any) => ({
              id: node.id,
              status: node.status,
              allowedTools: node.allowedTools,
              blockerCode: node.blocker?.code ?? null,
            }))
          : [],
      };
    }, { pluginId: NATIVE_CORE_PLUGIN_ID });
    lastState = state;
    if (state.running || state.complete) return false;
    if (state.canResume && state.continuationCommand) {
      const continuation = page.getByRole("button", { name: /Continue Latest Run/iu });
      if (
        await continuation.isVisible().catch(() => false) &&
        await continuation.isEnabled().catch(() => false)
      ) {
        await continuation.click();
        await page.waitForTimeout(250);
        return true;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Restarted lifecycle stage did not expose a safe continuation or a completed ledger; state=${JSON.stringify(lastState)}.`,
  );
}

async function installRealAiPageHarness(context: {
  page: Page;
  marker: string;
  notePath: string;
}): Promise<void> {
  await context.page.evaluate(async ({ pluginId, notePath, marker }) => {
    const app = (window as typeof window & { app?: any }).app;
    if (!app?.plugins || !app?.vault || !app?.workspace) {
      throw new Error("Obsidian app APIs are unavailable.");
    }
    if (typeof app.workspace.onLayoutReady === "function") {
      await new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve));
    }
    let plugin: any = null;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      plugin = app.plugins.plugins?.[pluginId] ?? null;
      if (plugin?.agenticResearcherApi?.state === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (plugin?.agenticResearcherApi?.state !== "ready") {
      throw new Error("Agentic Researcher core did not become ready.");
    }
    // A reused Obsidian process may retain the Settings modal from another
    // lane. Close it before real-provider work so failure snapshots and traces
    // cannot capture credential inputs that were seeded only on the Node side.
    app.setting?.close?.();
    const ensureFolder = async (folderPath: string) => {
      let current = "";
      for (const part of folderPath.split("/").filter(Boolean)) {
        current = current ? `${current}/${part}` : part;
        if (app.vault.getAbstractFileByPath(current)) continue;
        try { await app.vault.createFolder(current); } catch (error) {
          if (!/already exists/iu.test(String(error))) throw error;
        }
      }
    };
    await ensureFolder(notePath.split("/").slice(0, -1).join("/"));
    const existing = app.vault.getAbstractFileByPath(notePath);
    if (existing) await app.vault.delete(existing, true);
    const note = await app.vault.create(
      notePath,
      `# Live Provider Contract\n\nOwned live-provider fixture ${marker}.\n`,
    );
    const leaf =
      app.workspace.getLeavesOfType?.("markdown")?.[0] ??
      app.workspace.getLeavesOfType?.("empty")?.[0] ??
      app.workspace.getLeaf("tab");
    await leaf.openFile(note);
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await plugin.activateView?.();
  }, {
    pluginId: NATIVE_CORE_PLUGIN_ID,
    notePath: context.notePath,
    marker: context.marker,
  });
}

async function assertProductionClientReady(
  page: Page,
  config: E2EAiConfig,
  provider: "ollama" | "openai_compatible",
): Promise<void> {
  const state = await page.evaluate(({ pluginId }) => {
    const app = (window as typeof window & { app?: any }).app;
    const plugin = app?.plugins?.plugins?.[pluginId];
    const views = app?.workspace?.getLeavesOfType?.("agentic-researcher-view") ?? [];
    return {
      settingsModel: plugin?.settings?.model ?? "",
      descriptor: plugin?.createModelClient?.()?.descriptor ?? null,
      mockInstalled: Boolean(plugin?.__playwrightE2EMockInstalled),
      viewMocks: views.map((leaf: any) => Boolean(leaf.view?.plugin?.__playwrightE2EMockInstalled)),
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
  expect(state.settingsModel).toBe(config.model);
  expect(state.descriptor).toMatchObject({
    provider,
    model: config.model,
    transportKind: "production",
  });
  expect(state.mockInstalled).toBe(false);
  expect(state.viewMocks.every((value: boolean) => value === false)).toBe(true);
}

async function submitMission(
  page: Page,
  prompt: string,
  options: { waitForCompletion?: boolean; timeoutMs: number },
): Promise<void> {
  await page.getByRole("tab", { name: "Chat" }).click();
  const input = page.locator("textarea.agentic-researcher-prompt");
  await input.fill(prompt);
  await page.locator("button.agentic-researcher-run").click();
  await expect(page.locator(".agentic-researcher-log-user", { hasText: prompt }).last())
    .toBeVisible({ timeout: 5_000 });
  if (options.waitForCompletion === false) return;
  await waitForMissionComplete(page, options.timeoutMs);
}

async function waitForMissionComplete(page: Page, timeoutMs: number): Promise<void> {
  const run = page.locator("button.agentic-researcher-run");
  await expect(run).toHaveText("Run Mission", { timeout: timeoutMs });
  await expect(run).toBeEnabled();
  await expect(page.locator(".agentic-researcher-run-status-text")).toHaveText("Idle");
}

async function seedNote(page: Page, path: string, content: string, activate: boolean): Promise<void> {
  await page.evaluate(async ({ path, content, activate }) => {
    const app = (window as typeof window & { app?: any }).app;
    const folder = path.split("/").slice(0, -1).join("/");
    let current = "";
    for (const part of folder.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
    }
    const existing = app.vault.getAbstractFileByPath(path);
    const file = existing
      ? (await app.vault.modify(existing, content), existing)
      : await app.vault.create(path, content);
    if (activate) {
      const leaf = app.workspace.getLeavesOfType("markdown")[0] ?? app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }
  }, { path, content, activate });
}

async function indexSemanticNotes(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(async ({ pluginId, paths }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
    const service = plugin?.getSemanticIndexService?.() ?? plugin?.semanticIndexService;
    if (!service?.updatePaths) {
      throw new Error("Production semantic index service is unavailable.");
    }
    const result = await service.updatePaths(paths);
    if (!result?.ok) {
      throw new Error(
        `Production semantic index update failed: ${result?.code ?? result?.message ?? "unknown"}`,
      );
    }
    const updated = new Set(result.updatedPaths ?? []);
    for (const path of paths) {
      if (!updated.has(path)) {
        throw new Error(`Production semantic index did not attest ${path}.`);
      }
    }
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, paths });
}

async function installOwnedWebBackend(
  page: Page,
  marker: string,
  options: {
    failFirstFetch?: boolean;
    sourceCount?: 2 | 3;
    topic?: "generic" | "checkers";
  },
): Promise<void> {
  await page.evaluate(({ pluginId, failFirstFetch, sourceCount, marker, topic }) => {
    const w = window as typeof window & { app?: any; __realAiWebRestore?: () => void };
    const plugin = w.app?.plugins?.plugins?.[pluginId];
    if (!plugin) throw new Error("Core plugin unavailable.");
    w.__realAiWebRestore?.();
    const original = plugin.createToolExecutionContext;
    let fetchCalls = 0;
    plugin.createToolExecutionContext = function (prompt: string) {
      const context = original.call(this, prompt);
      const realTransport = context.httpTransport;
      context.httpTransport = async (request: any) => {
        if (String(request.url).endsWith("/web_search")) {
          const markerPath = encodeURIComponent(marker);
          const results = topic === "checkers"
            ? [
                {
                  title: "Owned American checkers rules",
                  url: `https://primary.owned.example/checkers/${markerPath}`,
                  snippet:
                    "American checkers uses an 8x8 board, twelve men per side, diagonal movement, mandatory captures, multi-jumps, and kings.",
                },
                {
                  title: "Owned checkers end conditions and implementation notes",
                  url: `https://alternate-owned.example/checkers/${markerPath}`,
                  snippet:
                    "A player wins when the opponent has no pieces or legal moves; implementations must preserve forced-capture and turn-continuation state.",
                },
              ]
            : [
                { title: "Owned primary", url: `https://primary.owned.example/evidence/${markerPath}`, snippet: "Owned passage: alpha evidence establishes the first finding." },
                { title: "Owned alternate", url: `https://alternate-owned.example/evidence/${markerPath}`, snippet: "Owned passage: beta evidence establishes the second finding." },
              ];
          if (sourceCount === 3) {
            results.push({
              title: "Owned corroborating",
              url: `https://corroborating-owned.example/evidence/${markerPath}`,
              snippet: "Owned passage: gamma evidence independently corroborates the bounded synthesis.",
            });
          }
          return { status: 200, headers: {}, json: { results } };
        }
        if (String(request.url).endsWith("/web_fetch")) {
          fetchCalls += 1;
          const body = JSON.parse(String(request.body ?? "{}"));
          if (failFirstFetch && fetchCalls === 1) {
            return { status: 503, headers: { "retry-after": "0" }, json: { error: "owned retryable source failure" } };
          }
          const alternate = String(body.url).includes("alternate");
          const corroborating = String(body.url).includes("corroborating");
          return { status: 200, headers: {}, json: {
            title: corroborating
              ? "Owned corroborating"
              : alternate
                ? "Owned alternate"
                : "Owned primary",
            content: topic === "checkers"
              ? alternate
                ? "American checkers ends when a player has no pieces or no legal move. A legal-move engine must return captures instead of quiet moves whenever any capture exists. After a jump, the same piece must continue while another jump is available, so the turn changes only after the capture sequence ends. A man reaching the opponent's back rank is crowned as a king; kings may move and capture diagonally forward or backward. Draw conventions vary and should be documented rather than invented for a bounded implementation."
                : "American checkers, also called English draughts, is played only on the dark squares of an 8 by 8 board. Each side begins with twelve men on the first three rows nearest that player. Men move one dark square diagonally forward. Captures jump an adjacent opposing piece into the empty square beyond and are mandatory when available. Multiple jumps continue with the same piece. Reaching the farthest row crowns a man as a king, which can move and capture in both diagonal directions."
              : corroborating
                ? "Gamma evidence is a third independently fetched passage. It positively corroborates the bounded synthesis and preserves the existing tool authority."
                : alternate
                  ? "Beta evidence is the independently fetched second passage. It supports bounded recovery and source verification."
                  : "Alpha evidence is the fetched primary passage. It supports the first verified claim with owned deterministic content.",
            links: [],
          } };
        }
        return realTransport(request);
      };
      return context;
    };
    w.__realAiWebRestore = () => {
      plugin.createToolExecutionContext = original;
      delete w.__realAiWebRestore;
    };
  }, {
    pluginId: NATIVE_CORE_PLUGIN_ID,
    failFirstFetch: options.failFirstFetch === true,
    sourceCount: options.sourceCount ?? 2,
    marker,
    topic: options.topic ?? "generic",
  });
}

async function restoreOwnedWebBackend(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as typeof window & { __realAiWebRestore?: () => void }).__realAiWebRestore?.();
  });
}

async function attestProductionRun(
  page: Page,
  config: E2EAiConfig,
  options: { requireStructuredRouting?: boolean },
): Promise<any> {
  const snapshot = await page.evaluate(async ({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[pluginId];
    const current = plugin?.getMissionRunSnapshot?.() ?? null;
    const ledgerPath = current?.persistedProjection?.missionLedgerPath;
    const ledgerFile = ledgerPath
      ? (window as typeof window & { app?: any }).app?.vault?.getFileByPath?.(ledgerPath)
      : null;
    if (!current || !ledgerFile) return current;
    try {
      const markdown = await (window as typeof window & { app?: any }).app.vault.read(ledgerFile);
      const match = /## Mission Ledger\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(markdown);
      const ledger = match ? JSON.parse(match[1]) : null;
      current.redactedEvidenceConflicts = Array.isArray(ledger?.evidenceConflicts)
        ? ledger.evidenceConflicts.map((conflict: any) => ({
            id: conflict?.id ?? null,
            status: conflict?.status ?? null,
            passageIds: Array.isArray(conflict?.passageIds)
              ? conflict.passageIds.slice(0, 4)
              : [],
          }))
        : [];
    } catch {
      current.redactedEvidenceConflicts = [];
    }
    return current;
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
  expect(snapshot).toBeTruthy();
  expect(snapshot.modelCallEvidence.length).toBeGreaterThan(0);
  const successes = snapshot.modelCallEvidence.filter(
    (item: any) => item.outcome === "success" && item.transportKind === "production",
  );
  expect(successes.length).toBeGreaterThan(0);
  expect(successes.some((item: any) => item.model === config.model && item.responseChars > 0)).toBe(true);
  for (const item of successes.filter((candidate: any) => candidate.tokenUsageReported)) {
    expect(item.totalTokens).toBeGreaterThan(0);
  }
  expect(snapshot.providerUsage.modelCallCount).toBeGreaterThan(0);
  expect(snapshot.modelCallEvidence.some((item: any) => "prompt" in item || "response" in item || "url" in item)).toBe(false);
  expect(Array.isArray(snapshot.missionEvidence)).toBe(true);
  expect(
    snapshot.missionEvidence.some(
      (item: any) =>
        "summary" in item ||
        "content" in item ||
        "title" in item ||
        "path" in item ||
        "url" in item,
    ),
  ).toBe(false);
  if (options.requireStructuredRouting) {
    const routing = snapshot.lastMissionGraph?.routing;
    if (routing?.source !== "structured_model" || routing?.fallbackReason !== null) {
      const plannerEvidence = snapshot.modelCallEvidence
        .filter((item: any) => item.phase === "graph_planner" || item.phase === "retry")
        .map((item: any) => ({
          phase: item.phase,
          attempt: item.attempt,
          outcome: item.outcome,
          errorCategory: item.errorCategory ?? null,
          responseChars: item.responseChars,
        }));
      throw new Error(
        `Structured MissionGraph routing was not accepted: ${JSON.stringify({ routing, plannerEvidence })}`,
      );
    }
  }
  return snapshot;
}

function activePreparedApproval(page: Page, toolName: string): Locator {
  return page.locator(".agentic-researcher-approval-card", { hasText: toolName })
    .filter({ has: page.locator("button.agentic-researcher-approval-approve:enabled") })
    .last();
}

async function resolveApproval(approval: Locator, decision: "approve" | "deny"): Promise<void> {
  await approval.locator(
    decision === "approve"
      ? "button.agentic-researcher-approval-approve:enabled"
      : "button.agentic-researcher-approval-deny:enabled",
  ).click({ timeout: 10_000 });
}
