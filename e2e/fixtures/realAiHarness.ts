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
import { clearChatInline } from "./chatCleanup";
import {
  HOST_PROVISIONED_SANDBOX_READINESS_TIMEOUT_MS_V1,
  readHostProvisionedSandboxBindingV1,
} from "../../extensions/code/sandbox/HostProvisionedSandboxBindingV1";
import {
  assertRealAiLaneNonMock,
  RealAiConnectionAttestationRegistry,
  verifyWithWorkerConnectionAttestation,
} from "./realAiConnectionAttestation";

export { clearChatInline } from "./chatCleanup";

export interface RealAiHarness extends NativeObsidianHarness {
  config: E2EAiConfig;
  /** Relaunch the same owned Obsidian process boundary without reseeding state. */
  relaunch(): Promise<Page>;
  submitMission(
    prompt: string,
    options?: {
      waitForCompletion?: boolean;
      timeoutMs?: number;
      /** Clear Chat memory before submit (default true). Set false only for dependent Continues. */
      clearChatFirst?: boolean;
    },
  ): Promise<void>;
  clearChat(): Promise<void>;
  waitForMissionComplete(timeoutMs?: number): Promise<void>;
  seedNote(path: string, content: string, activate?: boolean): Promise<void>;
  indexSemanticNotes(paths: string[]): Promise<void>;
  readNote(path?: string): Promise<string>;
  installOwnedWebBackend(options?: {
    failFirstFetch?: boolean;
    sourceCount?: 1 | 2 | 3;
    topic?: "generic" | "checkers";
    conflictingEvidence?: boolean;
  }): Promise<void>;
  readOwnedWebMetrics(): Promise<OwnedWebMetricsV1>;
  attestProductionRun(options?: { requireStructuredRouting?: boolean }): Promise<any>;
  restartCorePlugin(): Promise<void>;
  approveUntilMissionComplete(
    timeoutMs?: number,
    options?: CompoundMissionApprovalOptions,
  ): Promise<number>;
  /**
   * Set-loose compound: wait for Idle/complete without clicking Bound approvals.
   * Fails if chat-approval-approve appears (set-loose Bound should auto-run).
   */
  waitUntilIdleOrComplete(timeoutMs?: number): Promise<void>;
  readProgressCounters(): {
    approvals: number;
    continuations: number;
    modelCalls: number;
    modelCallScopes: Array<{
      usageScopeId: string;
      modelCalls: number;
    }>;
  };
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
  /** Fail closed instead of clicking an unexpected prepared mutation. */
  allowedApprovalToolNames?: readonly string[];
  /** GitHub repository creation must visibly name private visibility. */
  requirePrivateRepositoryApproval?: boolean;
  /** Every clicked request must carry a matching prepared-action fingerprint. */
  requireExactPreparedActionApproval?: boolean;
  onApproval?: (approval: E2EPreparedApprovalObservationV1) => void;
  /** Redacted harness counters retained even when the mission fails mid-loop. */
  onProgress?: (counters: {
    approvals: number;
    continuations: number;
    modelCalls: number;
  }) => void;
  /** Restart the production plugin immediately after selected durable stage commits. */
  restartAfterProjectStages?: readonly ProjectLifecycleStageName[];
  onStageRestarted?: (stage: ProjectLifecycleStageName) => Promise<void>;
}

export interface E2EPreparedApprovalObservationV1 {
  toolName: string;
  requestId: string;
  preparedActionId: string | null;
  payloadFingerprint: string | null;
  visibility: string | null;
}

export interface RealAiHarnessNativeOptions {
  /** Reuse only the vault's opaque native Linear reference; never copy a token. */
  preserveConfiguredLinearCredential?: boolean;
  /** Reuse only the vault's opaque native GitHub reference; never copy a token. */
  preserveConfiguredGitHubCredential?: boolean;
  /** Vault-relative paths the lane deliberately keeps after harness close. */
  retainVaultPaths?: readonly string[];
  /** Use an empty Untitled note to reproduce first-write product behavior. */
  placeholderCurrentNote?: boolean;
}

export interface OwnedWebMetricsV1 {
  version: 1;
  searchTransportCalls: number;
  fetchTransportCalls: number;
  failedFetchTransportCalls: number;
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

// `Idle` is the durable primary status. AgentView may append non-semantic
// autonomy/team stats after it, so lifecycle waits must not confuse that
// presentation detail with a still-running mission.
const IDLE_PRIMARY_STATUS_PATTERN = /^Idle(?:\s+\u00b7\s+\S.*)?$/iu;

function hasIdlePrimaryStatus(statusText: string): boolean {
  return IDLE_PRIMARY_STATUS_PATTERN.test(statusText.trim());
}

/**
 * One real provider health check is enough for the exact provider/model/base
 * tuple during a single serial Playwright worker. Each mission still uses the
 * production client; this only avoids rate-limiting the redundant preflight.
 */
const VERIFIED_REAL_AI_CONNECTIONS =
  new RealAiConnectionAttestationRegistry();

const CODE_CAPABILITY_ID_V1 = "agentic-researcher-code";

/**
 * The runtime digest a repository profile must pin, read from the same
 * host-provisioned source the production plugin adopts. Lanes no longer build
 * their own provider configuration, so this is the only place the value enters
 * a test.
 */
export function hostProvisionedSandboxRuntimeDigestV1(): string {
  const binding = readHostProvisionedSandboxBindingV1(
    process.env,
    process.platform,
  );
  if (!binding) {
    throw new Error(
      "No host-provisioned sandbox binding is available. Run npm run setup:sandbox:wsl2 (or the platform equivalent) before a live code lane.",
    );
  }
  return binding.provider.runtimeDigest;
}

/**
 * Assert the sandbox the PRODUCTION plugin reached by itself.
 *
 * Live lanes used to call `configureSandboxProvider` with a test-built config,
 * which made every one of them green on a host whose plugin held zero
 * providers — the exact state that stopped a real "write me a Python game on
 * my desktop" mission at code_validate_fast. Nothing here supplies provider
 * configuration: the plugin must adopt the host-provisioned binding and pass
 * its own boundary probe, so a regression in that path fails the lane.
 */
export async function assertProductionAdoptedSandboxV1(
  page: Page,
  notBeforeMs: number,
): Promise<{
  selectedProvider: string;
  providerConfigCount: number;
  observedAt: string;
}> {
  const observed = await page.evaluate(async (codePluginId) => {
    const app = (window as typeof window & { app?: any }).app;
    const code = app?.plugins?.plugins?.["agentic-researcher"]
      ?.getBundledCapability?.(codePluginId);
    if (typeof code?.ensureHostProvisionedSandboxReadinessV1 !== "function") {
      throw new Error(
        "The production Code capability exposes no host-provisioned sandbox readiness path.",
      );
    }
    const status = await code.ensureHostProvisionedSandboxReadinessV1();
    const state = code.readState?.() ?? null;
    return {
      status,
      providerConfigCount: Array.isArray(state?.sandbox?.providerConfigs)
        ? state.sandbox.providerConfigs.length
        : 0,
      observedAt: state?.sandbox?.lastProbe?.observedAt ?? null,
    };
  }, CODE_CAPABILITY_ID_V1);

  expect(
    observed.providerConfigCount,
    "the plugin must adopt the host-provisioned sandbox binding without test injection",
  ).toBeGreaterThan(0);
  expect(observed.status).toMatchObject({
    editingAvailable: true,
    executionAvailable: true,
  });
  expect(typeof observed.status.selectedProvider).toBe("string");
  const observedAtMs = Date.parse(String(observed.observedAt ?? ""));
  expect(
    Number.isFinite(observedAtMs) && observedAtMs >= notBeforeMs,
    "the boundary probe must be proven fresh in this session, not replayed from durable history",
  ).toBe(true);
  return {
    selectedProvider: String(observed.status.selectedProvider),
    providerConfigCount: observed.providerConfigCount,
    observedAt: String(observed.observedAt),
  };
}

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
    // Live-contract scenarios prove one explicitly selected provider model.
    // Never inherit a stale utility model from the developer's test vault.
    utilityModel: "",
    enableStreaming: false,
    thinkingMode: "off",
    // The console now remembers its last tab. Without pinning it, a scenario
    // that ends on Run Details leaves the next one's Chat panel hidden, and
    // submitMission's fill() on textarea.agentic-researcher-prompt would time
    // out on an invisible element depending purely on scenario order.
    runDetailsActiveTab: "chat",
    // Cap per-request HTTP timeout below the mission wall clock. Coupling them
    // lets one stalled chat() burn the full completion wait (seen as
    // Running mission... with empty progress after Continue on error).
    requestTimeoutMs: Math.min(config.missionTimeoutMs, 10 * 60_000),
    maxRunMinutes: 14,
    maxAgentSteps: 24,
    modelRouterEnabled: true,
    modelRouterMode: "authority",
    streamWritebackMode: "off",
    semanticIndexEnabled: true,
    // A missing or incompatible index makes updatePaths() perform a bounded
    // rebuild. Keep its generated files in a visible, owned per-scenario vault
    // folder: Obsidian's metadata API intentionally does not expose dot-prefixed
    // adapter directories, which makes them invalid for a vault-API index.
    semanticIndexFolder: `E2E Agent Tests/Semantic Index/${ownedIndexLabel}`,
    semanticIndexMaxFiles: 16,
    autoTitleOnWrite: false,
    orchestratorEnabled: false,
    agenticReflexEnabled: true,
    autoContinueLongRuns: false,
    completionDrivenLoops: false,
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
    ...(nativeOptions.placeholderCurrentNote
      ? { noteBasenamePrefix: "Untitled" }
      : {}),
    corePluginDataOverrides,
    preserveConfiguredLinearCredential:
      nativeOptions.preserveConfiguredLinearCredential === true,
    preserveConfiguredGitHubCredential:
      nativeOptions.preserveConfiguredGitHubCredential === true,
    ...(nativeOptions.retainVaultPaths
      ? { retainVaultPaths: nativeOptions.retainVaultPaths }
      : {}),
    setup: (context) =>
      installRealAiPageHarness(context, {
        placeholderCurrentNote:
          nativeOptions.placeholderCurrentNote === true,
      }),
    beforeClose: async ({ page }) => restoreOwnedWebBackend(page),
  });
  let recordedApprovals = 0;
  let recordedContinuations = 0;
  const recordedModelCallsByUsageScopeId = new Map<string, number>();
  const totalRecordedModelCalls = () =>
    [...recordedModelCallsByUsageScopeId.values()].reduce(
      (total, count) => total + count,
      0,
    );
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
    get page() {
      return native.page;
    },
    config,
    relaunch: async () =>
      native.relaunchOwnedProcess(async ({ page }) => {
        await page.evaluate(async (pluginId) => {
          const app = (window as typeof window & { app?: any }).app;
          const plugin = app?.plugins?.plugins?.[pluginId];
          if (plugin?.agenticResearcherApi?.state !== "ready") {
            throw new Error(
              "Agentic Researcher core was not ready after owned-process relaunch.",
            );
          }
          app.setting?.close?.();
          await plugin.activateView?.();
        }, NATIVE_CORE_PLUGIN_ID);
        await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
          timeout: 30_000,
        });
        await assertProductionClientReady(page, config, provider);
      }),
    submitMission: (prompt, options = {}) => submitMission(native.page, prompt, {
      timeoutMs: options.timeoutMs ?? config.missionTimeoutMs,
      waitForCompletion: options.waitForCompletion,
      clearChatFirst: options.clearChatFirst,
    }),
    clearChat: () => clearChatInline(native.page),
    waitForMissionComplete: (timeoutMs = config.completionTimeoutMs) =>
      waitForMissionComplete(native.page, timeoutMs),
    seedNote: (path, content, activate = false) =>
      seedNote(native.page, path, content, activate),
    indexSemanticNotes: (paths) => indexSemanticNotes(native.page, paths),
    readNote: async (target = native.noteFilePath) => readFile(target, "utf8"),
    installOwnedWebBackend: (options = {}) =>
      installOwnedWebBackend(native.page, native.marker, options),
    readOwnedWebMetrics: () => readOwnedWebMetrics(native.page),
    attestProductionRun: (options = {}) =>
      attestProductionRun(native.page, config, options),
    restartCorePlugin: () =>
      restartCorePlugin(native.page, config, provider),
    approveUntilMissionComplete: async (
      timeoutMs = config.completionTimeoutMs,
      options = {},
    ) => {
      let callApprovals = 0;
      let callContinuations = 0;
      try {
        return await approveUntilMissionComplete(native.page, timeoutMs, {
          ...options,
          onProgress: (counters) => {
            callApprovals = Math.max(callApprovals, counters.approvals);
            callContinuations = Math.max(
              callContinuations,
              counters.continuations,
            );
            options.onProgress?.({
              approvals: recordedApprovals + callApprovals,
              continuations: recordedContinuations + callContinuations,
              modelCalls: totalRecordedModelCalls(),
            });
          },
          onUsageScopeModelCalls: (usageScopeId, modelCalls) => {
            recordedModelCallsByUsageScopeId.set(
              usageScopeId,
              Math.max(
                recordedModelCallsByUsageScopeId.get(usageScopeId) ?? 0,
                modelCalls,
              ),
            );
          },
          restartCorePlugin: (stage) =>
            restartCorePlugin(native.page, config, provider, stage).then(async () => {
              await options.onStageRestarted?.(stage);
            }),
        });
      } finally {
        recordedApprovals += callApprovals;
        recordedContinuations += callContinuations;
      }
    },
    waitUntilIdleOrComplete: (timeoutMs = config.completionTimeoutMs) =>
      waitUntilIdleOrComplete(native.page, timeoutMs),
    readProgressCounters: () => ({
      approvals: recordedApprovals,
      continuations: recordedContinuations,
      modelCalls: totalRecordedModelCalls(),
      modelCallScopes: [...recordedModelCallsByUsageScopeId]
        .map(([usageScopeId, modelCalls]) => ({
          usageScopeId,
          modelCalls,
        }))
        .sort((left, right) =>
          left.usageScopeId.localeCompare(right.usageScopeId),
        ),
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
    // A plugin-manager disable does not reliably destroy an already-open
    // ItemView in the shared renderer. Detach the owned leaf first so enable
    // creates a view bound to the new plugin instance instead of leaving the
    // old instance's connection gate on screen.
    for (const leaf of app.workspace.getLeavesOfType?.(
      "agentic-researcher-view",
    ) ?? []) {
      await leaf.detach?.();
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

async function waitUntilIdleOrComplete(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let continuations = 0;
  let missingContinuationPolls = 0;
  const maximumContinuations = 12;
  // Progress stall: must exceed the capped per-request timeout (10m). Model-call
  // evidence is only recorded on completion, so a healthy long chat() looks
  // unchanged until it returns.
  const stallTimeoutMs = Math.min(timeoutMs, 12 * 60_000);
  let lastProgressKey = "";
  let lastProgressAt = Date.now();
  while (Date.now() < deadline) {
    const state = await page.evaluate(({ pluginId }) => {
      const approveVisible = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "button[data-testid='chat-approval-approve']:not(:disabled), button.agentic-researcher-approval-approve:not(:disabled)",
        ),
      ).some((button) => button.getClientRects().length > 0);
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const snapshot = plugin?.getMissionRunSnapshot?.();
      const ledger = snapshot?.lastMissionLedger;
      const nextAction =
        typeof ledger?.nextAction === "string" ? ledger.nextAction : "";
      return {
        runText:
          document
            .querySelector("button.agentic-researcher-run")
            ?.textContent?.trim() ?? "",
        statusText:
          document
            .querySelector(".agentic-researcher-run-status-text")
            ?.textContent?.trim() ?? "",
        approveVisible,
        stopReason: snapshot?.lastComplete?.stopReason ?? null,
        canResume: ledger?.canResume === true,
        continuationCommand:
          typeof ledger?.continuationCommand === "string"
            ? ledger.continuationCommand
            : null,
        acceptanceStatus: ledger?.acceptance?.status ?? null,
        ledgerStatus: ledger?.status ?? null,
        nextAction,
        evidenceCount: ledger?.evidenceCount ?? null,
        receiptCount: ledger?.receiptCount ?? null,
        providerUsage: snapshot?.providerUsage ?? null,
        modelCallPhases: Array.isArray(snapshot?.modelCallEvidence)
          ? snapshot.modelCallEvidence.slice(-4).map((item: any) => ({
              phase: item?.phase ?? null,
              outcome: item?.outcome ?? null,
            }))
          : [],
        autoContinueRecommended:
          snapshot?.lastComplete?.autoContinueRecommended === true,
      };
    }, { pluginId: NATIVE_CORE_PLUGIN_ID });
    if (state.approveVisible) {
      const approveDiagnostics = await collectIdleWaitDiagnostics(page);
      console.error(
        "waitUntilIdleOrComplete Bound Approve appearance diagnostics:",
        JSON.stringify(approveDiagnostics),
      );
      throw new Error(
        [
          "Set-loose compound waitUntilIdleOrComplete saw a Bound Chat approval control; expected Bound tools to auto-run without approve.",
          `approvalTitle=${JSON.stringify(approveDiagnostics.approvalTitle ?? "")}`,
          `approvalReason=${JSON.stringify(approveDiagnostics.approvalReason ?? "")}`,
          `diagnostics=${JSON.stringify(approveDiagnostics)}`,
        ].join(" "),
      );
    }
    const running =
      state.runText === "Stop Mission" ||
      /running mission/iu.test(state.statusText);
    if (running) {
      const progressKey = JSON.stringify({
        statusText: state.statusText,
        ledgerStatus: state.ledgerStatus,
        evidenceCount: state.evidenceCount,
        receiptCount: state.receiptCount,
        nextAction: state.nextAction,
        modelCallPhases: state.modelCallPhases,
        providerUsage: state.providerUsage,
      });
      if (progressKey !== lastProgressKey) {
        lastProgressKey = progressKey;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > stallTimeoutMs) {
        const stallDiagnostics = await collectIdleWaitDiagnostics(page);
        throw new Error(
          [
            `waitUntilIdleOrComplete stalled for ${stallTimeoutMs}ms with no progress while Running.`,
            `progressKey=${progressKey}`,
            `diagnostics=${JSON.stringify(stallDiagnostics)}`,
          ].join(" "),
        );
      }
    } else {
      lastProgressKey = "";
      lastProgressAt = Date.now();
    }
    if (
      state.runText === "Run Mission" &&
      hasIdlePrimaryStatus(state.statusText)
    ) {
      if (
        state.acceptanceStatus === "pass" ||
        state.ledgerStatus === "complete"
      ) {
        const idleDiagnostics = await collectIdleWaitDiagnostics(page);
        console.log(
          "waitUntilIdleOrComplete Idle:",
          JSON.stringify(idleDiagnostics),
        );
        return;
      }
      const latestModelCall = state.modelCallPhases.at(-1);
      const modelStepFailed = state.nextAction.startsWith("Model step failed:");
      // Align with approveUntilMissionComplete: only auto-Continue budget /
      // recommended / retryable provider stops — never generic stopReason=error.
      const retryableProviderStop =
        state.canResume &&
        Boolean(state.continuationCommand) &&
        modelStepFailed &&
        (state.stopReason === "error" ||
          state.stopReason === "user_stopped" ||
          (latestModelCall?.phase === "retry" &&
            latestModelCall.outcome === "error"));
      // write_completed + needs_more_work is a set-loose Soft-union pause when
      // GitHub/reflection proofs remain unpaid — Continue rather than accept Idle.
      const unfinishedWriteCompleted =
        state.stopReason === "write_completed" &&
        state.acceptanceStatus === "needs_more_work";
      const shouldAutoContinue =
        state.canResume &&
        Boolean(state.continuationCommand) &&
        (state.stopReason === "budget" ||
          state.autoContinueRecommended === true ||
          retryableProviderStop ||
          unfinishedWriteCompleted ||
          state.stopReason === null);
      if (shouldAutoContinue) {
        const preContinueDiagnostics = await collectIdleWaitDiagnostics(page);
        const nextAction = String(preContinueDiagnostics.nextAction ?? "");
        const diagnosticBlob = [
          nextAction,
          preContinueDiagnostics.blockerCategory,
          preContinueDiagnostics.lastError,
          preContinueDiagnostics.lastStatusLog,
          ...(Array.isArray(preContinueDiagnostics.recentLogs)
            ? preContinueDiagnostics.recentLogs
            : []),
          ...(Array.isArray(preContinueDiagnostics.diagnostics)
            ? preContinueDiagnostics.diagnostics.map(
                (item) =>
                  `${String((item as { errorCode?: unknown }).errorCode ?? "")} ${String((item as { message?: unknown }).message ?? "")}`,
              )
            : []),
        ]
          .map((value) => String(value ?? ""))
          .join("\n");
        // Terminal validation / MissionGraph blockers cannot be healed by
        // burning more Continue budget loops — fail immediately.
        if (
          /Mission graph stopped|Validation completed red|Fast validation remained red|passing cycle is still required|tool_failure_terminal|tool_failure_repeated|same fast-validation failure fingerprint|third bounded repair cycle|host envelope is exhausted|lacks enough reserved budget|cannot be added within the graph budget/iu.test(
            diagnosticBlob,
          )
        ) {
          throw new Error(
            [
              "Set-loose compound hit a terminal validation/MissionGraph blocker; refusing further Continue loops.",
              `diagnostics=${JSON.stringify(preContinueDiagnostics)}`,
            ].join(" "),
          );
        }
        // Fail closed when Continue keeps retrying the same unpaid graph node
        // without healing (seen as dozens of "alternate path" budget stops).
        if (
          continuations >= 6 &&
          /already tried \d+ alternate path|set_loose_delivery_unpaid=|mission_graph_incomplete/iu.test(
            diagnosticBlob,
          )
        ) {
          throw new Error(
            [
              "Set-loose compound is spinning on unpaid/incomplete graph work across Continues; refusing further Continue loops.",
              `diagnostics=${JSON.stringify(preContinueDiagnostics)}`,
            ].join(" "),
          );
        }
        // Hard cap: any set-loose budget Continue storm without Idle completion.
        if (continuations >= 6 && state.stopReason === "budget") {
          throw new Error(
            [
              "Set-loose compound exceeded 6 budget Continues without completion; refusing further Continue loops.",
              `diagnostics=${JSON.stringify(preContinueDiagnostics)}`,
            ].join(" "),
          );
        }
        // Fail fast on durable code-commit blockers that Continue cannot heal
        // (missing repair checkpoint). Avoids 45m budget loops.
        if (
          continuations >= 2 &&
          /durable code repair checkpoint is missing|repair_checkpoint_missing|sandbox_project_binding_mismatch|exactly one project covering|Required tool execution failed without producing usable proof|verified passing fast cycle is required|passing_fast_validation_missing/iu.test(
            nextAction,
          )
        ) {
          throw new Error(
            [
              "Set-loose compound stuck on a non-healable tool/validation blocker; Continue cannot create it.",
              `diagnostics=${JSON.stringify(preContinueDiagnostics)}`,
            ].join(" "),
          );
        }
        // Continue lives on the Chat composer; Orchestrator/Details can hide it.
        await page
          .getByRole("tab", { name: "Chat" })
          .click({ timeout: 5_000 })
          .catch(() => undefined);
        const continuation = page.getByRole("button", {
          name: /Continue Latest Run/iu,
        });
        const visible = await continuation.isVisible().catch(() => false);
        const enabled = visible
          ? await continuation.isEnabled().catch(() => false)
          : false;
        let continueViaView = false;
        if (!visible || !enabled) {
          missingContinuationPolls += 1;
          // After a few Chat-tab polls, drive Continue through the view API so a
          // hidden/disabled composer control cannot stall a resumable budget Idle.
          if (missingContinuationPolls >= 4 && state.continuationCommand) {
            continueViaView = await page.evaluate(
              async ({ command }) => {
                const app = (window as typeof window & { app?: any }).app;
                const view = app?.workspace?.getLeavesOfType?.(
                  "agentic-researcher-view",
                )?.[0]?.view;
                if (
                  !view ||
                  typeof view.submitMissionContinuation !== "function"
                ) {
                  return false;
                }
                await view.submitMissionContinuation(command);
                return true;
              },
              { command: state.continuationCommand },
            );
          }
          if (!continueViaView) {
            if (missingContinuationPolls >= 40) {
              throw new Error(
                [
                  "Set-loose compound Idle is resumable but Continue Latest Run stayed unavailable.",
                  `diagnostics=${JSON.stringify(preContinueDiagnostics)}`,
                ].join(" "),
              );
            }
            await page.waitForTimeout(250);
            continue;
          }
        }
        missingContinuationPolls = 0;
        continuations += 1;
        if (continuations > maximumContinuations) {
          throw new Error(
            [
              `Set-loose compound exceeded ${maximumContinuations} Continue clicks without Idle completion.`,
              `diagnostics=${JSON.stringify(preContinueDiagnostics)}`,
            ].join(" "),
          );
        }
        const rateLimited =
          /rate limit|usage limit|Retry-After|upgrade for higher limits|429\b/iu.test(
            nextAction,
          );
        console.log(
          `waitUntilIdleOrComplete ${continueViaView ? "view-submitting" : "clicking"} Continue Latest Run continuation=${continuations} stopReason=${state.stopReason} retryableProviderStop=${retryableProviderStop}${rateLimited ? " rateLimited=true" : ""}`,
        );
        if (rateLimited) {
          // Cloud session limits need a real cooldown; 1s Continues just burn the cap.
          console.log(
            "waitUntilIdleOrComplete rate-limit backoff 90s before Continue",
          );
          await page.waitForTimeout(90_000);
        } else if (retryableProviderStop) {
          await page.waitForTimeout(1_000);
        }
        if (!continueViaView) {
          await continuation.click();
        }
        lastProgressKey = "";
        lastProgressAt = Date.now();
        await page.waitForTimeout(500);
        continue;
      }
      const idleDiagnostics = await collectIdleWaitDiagnostics(page);
      console.log(
        "waitUntilIdleOrComplete Idle:",
        JSON.stringify(idleDiagnostics),
      );
      if (
        state.stopReason === "error" &&
        !retryableProviderStop
      ) {
        throw new Error(
          [
            "Set-loose compound reached Idle with non-retryable stopReason=error; refusing to auto-Continue.",
            `nextAction=${JSON.stringify(state.nextAction)}`,
            `diagnostics=${JSON.stringify(idleDiagnostics)}`,
          ].join(" "),
        );
      }
      return;
    }
    await page.waitForTimeout(500);
  }
  const timeoutDiagnostics = await collectIdleWaitDiagnostics(page);
  console.error(
    "waitUntilIdleOrComplete timeout diagnostics:",
    JSON.stringify(timeoutDiagnostics),
  );
  throw new Error(
    [
      `waitUntilIdleOrComplete timed out after ${timeoutMs}ms without Idle.`,
      `diagnostics=${JSON.stringify(timeoutDiagnostics)}`,
    ].join(" "),
  );
}

/** Additive healing aid: last UI status + ledger snippet (secrets redacted). */
async function collectIdleWaitDiagnostics(
  page: Page,
): Promise<Record<string, unknown>> {
  return page.evaluate(({ pluginId }) => {
    const redact = (value: unknown): string =>
      String(value ?? "")
        .replace(
          /(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{48,})/giu,
          "[REDACTED]",
        )
        .slice(0, 500);
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    const snapshot = plugin?.getMissionRunSnapshot?.();
    const ledger = snapshot?.lastMissionLedger;
    const lastError =
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".agentic-researcher-log-error .agentic-researcher-log-message",
        ),
      )
        .at(-1)
        ?.textContent ?? "";
    const recentLogs = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".agentic-researcher-log-error .agentic-researcher-log-message, .agentic-researcher-log-status .agentic-researcher-log-message, .agentic-researcher-log-tool .agentic-researcher-log-message",
      ),
    )
      .slice(-8)
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean);
    const lastStatusLog =
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".agentic-researcher-log-status .agentic-researcher-log-message, .agentic-researcher-run-status-text",
        ),
      )
        .at(-1)
        ?.textContent ?? "";
    return {
      runText:
        document
          .querySelector("button.agentic-researcher-run")
          ?.textContent?.trim() ?? "",
      statusText:
        document
          .querySelector(".agentic-researcher-run-status-text")
          ?.textContent?.trim() ?? "",
      approveVisible: Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "button[data-testid='chat-approval-approve']:not(:disabled), button.agentic-researcher-approval-approve:not(:disabled)",
        ),
      ).some((button) => button.getClientRects().length > 0),
      approvalTitle:
        document
          .querySelector(
            ".agentic-researcher-approval-title, .agentic-researcher-chat-approval-title",
          )
          ?.textContent?.trim()
          ?.slice(0, 240) ?? "",
      approvalReason:
        document
          .querySelector(
            ".agentic-researcher-approval-reason, .agentic-researcher-chat-approval-reason",
          )
          ?.textContent?.trim()
          ?.slice(0, 240) ?? "",
      stopReason: snapshot?.lastComplete?.stopReason ?? null,
      autoContinueRecommended:
        snapshot?.lastComplete?.autoContinueRecommended === true,
      phase: snapshot?.phase ?? null,
      ledgerStatus: ledger?.status ?? null,
      acceptanceStatus: ledger?.acceptance?.status ?? null,
      canResume: ledger?.canResume === true,
      continuationCommand:
        typeof ledger?.continuationCommand === "string"
          ? ledger.continuationCommand
          : null,
      nextAction: redact(ledger?.nextAction),
      blockerCategory: ledger?.blockerCategory ?? null,
      lastError: redact(lastError),
      lastStatusLog: redact(lastStatusLog),
      recentLogs: recentLogs.map((line) => redact(line)),
      evidenceCount: ledger?.evidenceCount ?? null,
      receiptCount: ledger?.receiptCount ?? null,
      providerUsage: snapshot?.providerUsage ?? null,
      modelCallPhases: Array.isArray(snapshot?.modelCallEvidence)
        ? snapshot.modelCallEvidence.slice(-4).map((item: any) => ({
            phase: item?.phase ?? null,
            outcome: item?.outcome ?? null,
            durationMs: item?.durationMs ?? null,
          }))
        : [],
      diagnostics: Array.isArray(snapshot?.diagnosticAttestations)
        ? snapshot.diagnosticAttestations.slice(-8).map((item: any) => ({
            id: item?.id ?? null,
            errorCode: item?.errorCode ?? null,
            message: redact(item?.message),
          }))
        : [],
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

async function safePageWait(
  page: Page,
  ms: number,
  context: string,
): Promise<void> {
  if (page.isClosed()) {
    throw new Error(
      `Obsidian page closed during ${context}; reopen Obsidian and Continue the durable run if the mission is still resumable.`,
    );
  }
  try {
    await page.waitForTimeout(ms);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (page.isClosed() || /has been closed/iu.test(message)) {
      throw new Error(
        `Obsidian page/context closed during ${context}; reopen Obsidian and Continue the durable run if the mission is still resumable. Cause: ${message}`,
      );
    }
    throw error;
  }
}

/**
 * page.evaluate has no timeout of its own, and page.isClosed() only reports a
 * closure the browser process announced. When the renderer dies without the
 * main process tearing down its CDP target — observed for real: the target
 * stayed listed and a direct Runtime.evaluate went unanswered — every poll
 * hangs until the outer test timeout and the run reports nothing useful.
 * Bounding each poll converts that into a fast failure that names the cause.
 */
const configuredRendererPollDeadlineMs = Number.parseInt(
  process.env.E2E_RENDERER_POLL_DEADLINE_MS ?? "",
  10,
);
const RENDERER_POLL_DEADLINE_MS =
  Number.isSafeInteger(configuredRendererPollDeadlineMs) &&
  configuredRendererPollDeadlineMs >= 30_000 &&
  configuredRendererPollDeadlineMs <= 15 * 60_000
    ? configuredRendererPollDeadlineMs
    : 120_000;

async function raceRendererResponsive<T>(
  evaluation: Promise<T>,
  pollContext: string,
): Promise<T> {
  // The losing evaluate settles later (usually on browser close); keep its
  // rejection observed so it cannot surface as an unhandled rejection.
  void Promise.resolve(evaluation).catch(() => undefined);
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      evaluation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Obsidian did not answer the ${pollContext} poll within ${RENDERER_POLL_DEADLINE_MS}ms. ` +
                "The renderer process has most likely crashed while its CDP target stayed registered; " +
                "check the obsidian-stdio-*.log capture in test-results for the crash reason.",
            ),
          );
        }, RENDERER_POLL_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function approveUntilMissionComplete(
  page: Page,
  timeoutMs: number,
  options: CompoundMissionApprovalOptions & {
    restartCorePlugin?: (stage: ProjectLifecycleStageName) => Promise<void>;
    onUsageScopeModelCalls?: (
      usageScopeId: string,
      modelCalls: number,
    ) => void;
  } = {},
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let approvals = 0;
  let continuations = 0;
  const modelCallsByUsageScopeId = new Map<string, number>();
  const progress = () => ({
    approvals,
    continuations,
    modelCalls: [...modelCallsByUsageScopeId.values()].reduce(
      (total, count) => total + count,
      0,
    ),
  });
  const recordModelCalls = (
    usageScopeId: string | null,
    modelCalls: number,
  ) => {
    if (
      !usageScopeId ||
      !Number.isSafeInteger(modelCalls) ||
      modelCalls < 0
    ) {
      return;
    }
    const maximum = Math.max(
      modelCallsByUsageScopeId.get(usageScopeId) ?? 0,
      modelCalls,
    );
    modelCallsByUsageScopeId.set(usageScopeId, maximum);
    options.onUsageScopeModelCalls?.(usageScopeId, maximum);
  };
  let missingContinuationPolls = 0;
  let lastDurableState: Record<string, unknown> | null = null;
  // Long code-stage repair ladders (read → write_expected × N → revalidate)
  // need more durable Continues than short vault missions.
  const maximumContinuations = Math.max(
    1,
    Math.min(24, Math.floor(options.maxContinuations ?? 3)),
  );
  const restartStages = new Set(options.restartAfterProjectStages ?? []);
  const restartedStages = new Set<ProjectLifecycleStageName>();
  const sampleFinalModelProgress = async () => {
    if (page.isClosed()) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const sample = await Promise.race([
        page
          .evaluate(({ pluginId }) => {
            const snapshot = (window as typeof window & { app?: any }).app
              ?.plugins?.plugins?.[pluginId]?.getMissionRunSnapshot?.();
            const usageScopeId =
              typeof snapshot?.providerUsageScopeId === "string"
                ? snapshot.providerUsageScopeId
                : null;
            const modelCalls =
              Number.isSafeInteger(
                snapshot?.providerUsage?.modelCallCount,
              ) &&
              snapshot.providerUsage.modelCallCount >= 0
                ? snapshot.providerUsage.modelCallCount
                : 0;
            return { usageScopeId, modelCalls };
          }, { pluginId: NATIVE_CORE_PLUGIN_ID })
          .catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1_500);
        }),
      ]);
      if (sample) {
        recordModelCalls(sample.usageScopeId, sample.modelCalls);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
  while (Date.now() < deadline) {
    // Stay on Chat — do not flip Chat ↔ Run Details every poll (UI flicker).
    // Soft→Bound Chat Approve and Run Details cards are both clickable via DOM
    // even when the Details panel is not the active tab.
    if (page.isClosed()) {
      throw new Error(
        `Obsidian page closed while waiting for mission completion; approved=${approvals}; continuations=${continuations}; previousDurableState=${JSON.stringify(lastDurableState)}.`,
      );
    }
    const preparedApproval = await raceRendererResponsive(
      approveFirstVisiblePreparedAction(page, options),
      "prepared-approval",
    );
    if (preparedApproval) {
      approvals += 1;
      options.onApproval?.(preparedApproval);
      options.onProgress?.(progress());
      await safePageWait(page, 100, "post-approval settle");
      continue;
    }
    let ui: {
      runText: string;
      statusText: string;
      hasEnabledApproval: boolean;
      pluginRunning: boolean;
      stopReason: string | null;
      autoContinueReason: string | null;
      canResume: boolean;
      continuationCommand: string;
      acceptanceStatus: string | null;
      ledgerStatus: string | null;
      ledger: {
        status?: string;
        acceptance?: unknown;
        evidenceCount?: unknown;
        receiptCount?: unknown;
        nextAction?: unknown;
      } | null;
      graph: Array<{
        id: string;
        status: string;
        allowedTools: string[];
        attempts: number;
        blockerCode: string | null;
        blockerMessage: string | null;
      }>;
      providerUsage: unknown;
      providerUsageScopeId: string | null;
      runId: string | null;
      coordinatorModelCalls: number;
      lastComplete: unknown;
      modelCallPhases: Array<{ phase: string | null; outcome: string | null }>;
      lastError: string;
      diagnostics: Array<{ id: string | null; errorCode: string | null; message: string }>;
      hasGraphBlocker: boolean;
      projectStages: string[];
      durablyCompletedLifecycleTools: string[];
    };
    try {
      ui = await raceRendererResponsive(page.evaluate(async ({ pluginId }) => {
        const app = (window as typeof window & { app?: any }).app;
        const plugin = app?.plugins?.plugins?.[pluginId];
        const snapshot = plugin?.getMissionRunSnapshot?.();
        const pluginRunning = plugin?.isMissionRunning?.() === true;
        // A lifecycle stage can commit and render the next exact approval after
        // the outer pre-poll but before this durable read acquires its storage
        // boundary. Active runs do not need restart-readiness data, and the
        // durable read can legitimately wait behind an in-flight host action.
        // Skip it until the coordinator is idle so the approval broker keeps
        // observing the live mission instead of misclassifying that lock wait
        // as an unresponsive renderer.
        const durableRestart = pluginRunning
          ? null
          : await Promise.race([
              Promise.resolve(plugin?.getDurableMissionRestartReadiness?.())
                .catch(() => null),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
            ]) ?? null;
        const lastError = Array.from(document.querySelectorAll<HTMLElement>(
          ".agentic-researcher-log-error .agentic-researcher-log-message",
        )).at(-1)?.textContent ?? "";
        return {
          runText: document.querySelector("button.agentic-researcher-run")?.textContent?.trim() ?? "",
          statusText: document.querySelector(".agentic-researcher-run-status-text")?.textContent?.trim() ?? "",
          hasEnabledApproval: Array.from(document.querySelectorAll<HTMLButtonElement>(
            "button.agentic-researcher-approval-approve:not(:disabled), button[data-testid='chat-approval-approve']:not(:disabled)",
          )).some((button) => button.getClientRects().length > 0),
          pluginRunning,
          stopReason: snapshot?.lastComplete?.stopReason ?? null,
          autoContinueReason:
            snapshot?.lastComplete?.autoContinueReason ?? null,
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
          providerUsageScopeId:
            typeof snapshot?.providerUsageScopeId === "string"
              ? snapshot.providerUsageScopeId
              : null,
          runId:
            typeof snapshot?.lastMissionLedger?.runId === "string"
              ? snapshot.lastMissionLedger.runId
              : null,
          coordinatorModelCalls:
            Number.isSafeInteger(
              snapshot?.providerUsage?.modelCallCount,
            ) &&
            snapshot.providerUsage.modelCallCount >= 0
              ? snapshot.providerUsage.modelCallCount
              : 0,
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
      }, { pluginId: NATIVE_CORE_PLUGIN_ID }), "mission-state");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (page.isClosed() || /has been closed/iu.test(message)) {
        throw new Error(
          `Obsidian page closed while reading mission state; approved=${approvals}; continuations=${continuations}; previousDurableState=${JSON.stringify(lastDurableState)}. Cause: ${message}`,
        );
      }
      throw error;
    }
    recordModelCalls(ui.providerUsageScopeId, ui.coordinatorModelCalls);
    options.onProgress?.(progress());
    const preAuthorityReconciliationBlock = ui.diagnostics.some(
      (diagnostic) =>
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
      if (continued) {
        continuations += 1;
        options.onProgress?.(progress());
      }
      continue;
    }
    if (ui.hasEnabledApproval) {
      const clicked = await approveFirstVisiblePreparedAction(page, options);
      if (clicked) {
        approvals += 1;
        options.onApproval?.(clicked);
        options.onProgress?.(progress());
      }
      await safePageWait(page, 100, "post-approval settle");
      continue;
    }
    if (
      ui.runText === "Run Mission" &&
      hasIdlePrimaryStatus(ui.statusText)
    ) {
      // Run-complete events update the durable/UI projection before the
      // coordinator finishes terminal persistence and releases ownership.
      // Continue is invalid during that gap even though the surface is Idle.
      if (ui.pluginRunning) {
        await safePageWait(page, 250, "coordinator terminal settle");
        continue;
      }
      if (
        ui.stopReason === "budget" &&
        ui.autoContinueReason === "no_progress"
      ) {
        throw new Error(
          `Mission stopped at the production no-progress circuit; approved=${approvals}; continuations=${continuations}; state=${JSON.stringify(ui)}.`,
        );
      }
      const successfulTerminal =
        ui.stopReason === null ||
        ui.stopReason === "final" ||
        ui.stopReason === "write_completed";
      if (
        successfulTerminal &&
        (ui.acceptanceStatus === "pass" || ui.ledgerStatus === "complete")
      ) {
        return approvals;
      }
      const latestModelCall = ui.modelCallPhases.at(-1);
      const modelStepFailed =
        typeof ui.ledger?.nextAction === "string" &&
        ui.ledger.nextAction.startsWith("Model step failed:");
      // Provider 5xx / abort races can finish as stopReason=error or user_stopped
      // while the ledger still exposes a durable Continue. Treat both as
      // retryable when the next action is clearly a model-step failure.
      const retryableProviderStop =
        ui.canResume &&
        Boolean(ui.continuationCommand) &&
        modelStepFailed &&
        (
          ui.stopReason === "error" ||
          ui.stopReason === "user_stopped" ||
          (
            latestModelCall?.phase === "retry" &&
            latestModelCall.outcome === "error"
          )
        );
      if (
        !ui.hasGraphBlocker &&
        (
          (
            ui.stopReason === "budget" &&
            ui.autoContinueReason !== "no_progress"
          ) ||
          retryableProviderStop ||
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
          await safePageWait(page, 250, "missing-continuation poll");
          continue;
        }
        missingContinuationPolls = 0;
        continuations += 1;
        options.onProgress?.(progress());
        if (continuations > maximumContinuations) {
          throw new Error(
            `Mission exceeded ${maximumContinuations} explicit continuations; approved=${approvals}; state=${JSON.stringify(ui)}.`,
          );
        }
        // A provider terminal stop is already the result of the production
        // client's bounded retry policy. Briefly yield before exercising the
        // durable continuation so a transient upstream outage is not retried
        // in a tight loop by the harness.
        if (retryableProviderStop) {
          await safePageWait(page, 1_000, "provider-retry backoff");
        }
        const launchBaseline = JSON.stringify({
          stopReason: ui.stopReason,
          canResume: ui.canResume,
          continuationCommand: ui.continuationCommand,
          acceptanceStatus: ui.acceptanceStatus,
          ledgerStatus: ui.ledgerStatus,
          ledger: ui.ledger,
          providerUsage: ui.providerUsage,
          lastComplete: ui.lastComplete,
          modelCallPhases: ui.modelCallPhases,
        });
        await continuation.click();
        // `submitMissionContinuation` first copies the durable command into the
        // Chat composer, then asynchronously enters `capturePrompt`. Do not
        // read the still-idle snapshot and click Continue again during that
        // handoff. A short segment can also finish before the next DOM poll, so
        // accept either the native Stop state or a changed durable
        // ledger/provider snapshot; the unchanged prior Idle state remains a
        // hard failure.
        const launchAcknowledged = await expect
          .poll(async () => {
            return page.evaluate(({ pluginId, launchBaseline }) => {
              const runText =
                document
                  .querySelector("button.agentic-researcher-run")
                  ?.textContent?.trim() ?? "";
              if (/Stop/iu.test(runText)) {
                return "acknowledged";
              }
              const snapshot = (window as typeof window & { app?: any }).app
                ?.plugins?.plugins?.[pluginId]?.getMissionRunSnapshot?.();
              const ledger = snapshot?.lastMissionLedger;
              const current = JSON.stringify({
                stopReason: snapshot?.lastComplete?.stopReason ?? null,
                canResume: ledger?.canResume === true,
                continuationCommand:
                  typeof ledger?.continuationCommand === "string"
                    ? ledger.continuationCommand
                    : "",
                acceptanceStatus: ledger?.acceptance?.status ?? null,
                ledgerStatus: ledger?.status ?? null,
                ledger: ledger
                  ? {
                      status: ledger.status,
                      acceptance: ledger.acceptance,
                      evidenceCount: ledger.evidenceCount,
                      receiptCount: ledger.receiptCount,
                      nextAction: ledger.nextAction,
                    }
                  : null,
                providerUsage: snapshot?.providerUsage ?? null,
                lastComplete: snapshot?.lastComplete ?? null,
                modelCallPhases: Array.isArray(snapshot?.modelCallEvidence)
                  ? snapshot.modelCallEvidence.slice(-4).map((item: any) => ({
                      phase: item?.phase ?? null,
                      outcome: item?.outcome ?? null,
                    }))
                  : [],
              });
              return current !== launchBaseline
                ? "acknowledged"
                : "stale-idle";
            }, {
              pluginId: NATIVE_CORE_PLUGIN_ID,
              launchBaseline,
            });
          }, { timeout: 15_000 })
          .toBe("acknowledged")
          .then(
            () => true,
            () => false,
          );
        if (!launchAcknowledged) {
          // Keep the soak moving through the same public ItemView continuation
          // seam when a visible button's listener was replaced or otherwise
          // failed to launch. Invoke it only after 15 seconds of unchanged
          // durable Idle state, and require independent state change before
          // accepting the fallback.
          const fallback = await page.evaluate(
            async ({ command, launchBaseline, pluginId }) => {
              const app = (window as typeof window & { app?: any }).app;
              const plugin = app?.plugins?.plugins?.[pluginId];
              const view = app?.workspace?.getLeavesOfType?.(
                "agentic-researcher-view",
              )?.[0]?.view;
              const summarize = () => {
                const snapshot = plugin?.getMissionRunSnapshot?.();
                const ledger = snapshot?.lastMissionLedger;
                return JSON.stringify({
                  stopReason: snapshot?.lastComplete?.stopReason ?? null,
                  canResume: ledger?.canResume === true,
                  continuationCommand:
                    typeof ledger?.continuationCommand === "string"
                      ? ledger.continuationCommand
                      : "",
                  acceptanceStatus: ledger?.acceptance?.status ?? null,
                  ledgerStatus: ledger?.status ?? null,
                  ledger: ledger
                    ? {
                        status: ledger.status,
                        acceptance: ledger.acceptance,
                        evidenceCount: ledger.evidenceCount,
                        receiptCount: ledger.receiptCount,
                        nextAction: ledger.nextAction,
                      }
                    : null,
                  providerUsage: snapshot?.providerUsage ?? null,
                  lastComplete: snapshot?.lastComplete ?? null,
                  modelCallPhases: Array.isArray(snapshot?.modelCallEvidence)
                    ? snapshot.modelCallEvidence.slice(-4).map((item: any) => ({
                        phase: item?.phase ?? null,
                        outcome: item?.outcome ?? null,
                      }))
                    : [],
                });
              };
              const diagnostics = () => ({
                pluginRunning: plugin?.isMissionRunning?.() === true,
                viewRunning: view?.isRunning === true,
                connected: plugin?.hasVerifiedModelConnection?.() === true,
                prompt:
                  typeof view?.promptEl?.value === "string"
                    ? view.promptEl.value.slice(0, 160)
                    : "",
                recentErrors: Array.from(
                  document.querySelectorAll<HTMLElement>(
                    ".agentic-researcher-log-error .agentic-researcher-log-message",
                  ),
                )
                  .slice(-4)
                  .map((element) => element.textContent?.trim() ?? ""),
              });
              if (
                !view ||
                typeof view.submitMissionContinuation !== "function" ||
                plugin?.isMissionRunning?.() === true ||
                view.isRunning === true
              ) {
                return {
                  acknowledged: false,
                  invoked: false,
                  diagnostics: diagnostics(),
                };
              }
              await view.submitMissionContinuation(command);
              return {
                acknowledged: summarize() !== launchBaseline,
                invoked: true,
                diagnostics: diagnostics(),
              };
            },
            {
              command: ui.continuationCommand,
              launchBaseline,
              pluginId: NATIVE_CORE_PLUGIN_ID,
            },
          );
          if (!fallback.acknowledged) {
            throw new Error(
              `Continue remained on its prior idle snapshot after button and ItemView submission: ${JSON.stringify(fallback)}.`,
            );
          }
        }
        await safePageWait(page, 100, "post-continue launch");
        continue;
      }
      const failureSummary = {
        blockedGraph: ui.graph
          .filter((node) => node.status === "blocked" || node.blockerCode)
          .map((node) => ({
            id: node.id,
            allowedTools: node.allowedTools,
            attempts: node.attempts,
            blockerCode: node.blockerCode,
            blockerMessage: node.blockerMessage,
          })),
        projectStages: ui.projectStages,
        durablyCompletedLifecycleTools: ui.durablyCompletedLifecycleTools,
        autoContinueReason: ui.autoContinueReason,
        recentDiagnostics: ui.diagnostics.slice(-6),
      };
      throw new Error(
        `Mission stopped before acceptance; approved=${approvals}; summary=${JSON.stringify(failureSummary)}; state=${JSON.stringify(ui)}; previousDurableState=${JSON.stringify(lastDurableState)}.`,
      );
    }
    missingContinuationPolls = 0;
    try {
      await safePageWait(page, 250, "mission-running poll");
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Mission page closed during the running poll; approved=${approvals}; continuations=${continuations}; previousDurableState=${JSON.stringify(lastDurableState)}. Cause: ${cause}`,
      );
    }
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
  } finally {
    await sampleFinalModelProgress().catch(() => undefined);
    options.onProgress?.(progress());
  }
}

async function approveFirstVisiblePreparedAction(
  page: Page,
  policy: Pick<
    CompoundMissionApprovalOptions,
    | "allowedApprovalToolNames"
    | "requirePrivateRepositoryApproval"
    | "requireExactPreparedActionApproval"
  > = {},
): Promise<E2EPreparedApprovalObservationV1 | null> {
  // Click Approve in-place via DOM — no tab switching. Prefer Chat Soft→Bound
  // Approve, then any Run Details approve card (including when Details is hidden).
  if (page.isClosed()) {
    throw new Error(
      "Obsidian page closed while looking for prepared approvals; reopen Obsidian and Continue the durable run if the mission is still resumable.",
    );
  }
  try {
    return await page.evaluate(({ pluginId, allowedToolNames, requirePrivateRepository, requireExactPreparedAction }) => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "button[data-testid='chat-approval-approve']:not(:disabled):not([data-e2e-approval-scheduled]), button.agentic-researcher-approval-approve:not(:disabled):not([data-e2e-approval-scheduled])",
        ),
      );
      const chat = buttons.find(
        (candidate) => candidate.getAttribute("data-testid") === "chat-approval-approve",
      );
      const button =
        chat ??
        buttons.find((candidate) => candidate.getClientRects().length > 0) ??
        buttons.at(-1);
      if (!button) return null;
      const chatAttention = button.closest(
        ".agentic-researcher-chat-attention",
      );
      const detailCard = button.closest(
        ".agentic-researcher-approval-card",
      );
      const renderedTitle = String(
        chatAttention
          ?.querySelector(".agentic-researcher-chat-attention-title")
          ?.textContent ??
          detailCard
            ?.querySelector(".agentic-researcher-approval-title")
            ?.textContent ??
          "",
      ).trim();
      const chatTool = renderedTitle.match(/^Approval needed:\s*(\S+)$/u)?.[1];
      const detailTool = renderedTitle.match(/^([^:\s]+):/u)?.[1];
      const toolName = chatTool ?? detailTool ?? "";
      if (allowedToolNames.length > 0 && !allowedToolNames.includes(toolName)) {
        throw new Error(
          `E2E refused unexpected prepared approval tool ${toolName || "unknown"}; title=${JSON.stringify(renderedTitle)}.`,
        );
      }
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const pending = plugin?.approvalBroker?.getPending?.() ?? [];
      const matching = pending.filter(
        (request: any) => String(request?.toolName ?? "") === toolName,
      );
      if (allowedToolNames.length > 0 && matching.length !== 1) {
        throw new Error(
          `E2E requires one exact pending approval for ${toolName}; observed ${matching.length}.`,
        );
      }
      const request = matching[0] ?? null;
      const prepared = request?.preparedAction ?? null;
      const payloadFingerprint = String(
        request?.payloadFingerprint ?? prepared?.payloadFingerprint ?? "",
      );
      if (
        requireExactPreparedAction &&
        (!prepared ||
          prepared.toolName !== toolName ||
          prepared.runId !== request?.runId ||
          !/^sha256:[a-f0-9]{64}$/u.test(payloadFingerprint) ||
          prepared.payloadFingerprint !== payloadFingerprint)
      ) {
        throw new Error(
          `E2E refused ${toolName || "unknown"} without an exact prepared-action fingerprint.`,
        );
      }
      const visibility = String(
        prepared?.normalizedArgs?.visibility ??
          (prepared?.normalizedArgs?.private === true ? "private" : ""),
      ).toLowerCase();
      if (
        requirePrivateRepository &&
        toolName === "github_create_repository" &&
        visibility !== "private"
      ) {
        throw new Error(
          `E2E refused GitHub repository approval without exact private visibility: ${JSON.stringify(visibility)}.`,
        );
      }
      // Dispatch on the next renderer turn so Runtime.evaluate can return
      // before the host approval handler starts a long code/tool action. A
      // synchronous button.click() can keep the CDP request outstanding for
      // the entire approved action even while Obsidian visibly keeps updating.
      button.dataset.e2eApprovalScheduled = "true";
      setTimeout(() => {
        if (!button.isConnected || button.disabled) return;
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
      }, 0);
      return {
        toolName,
        requestId: String(request?.id ?? ""),
        preparedActionId: prepared ? String(prepared.id ?? "") : null,
        payloadFingerprint: payloadFingerprint || null,
        visibility: visibility || null,
      };
    }, {
      pluginId: NATIVE_CORE_PLUGIN_ID,
      allowedToolNames: [...(policy.allowedApprovalToolNames ?? [])],
      requirePrivateRepository:
        policy.requirePrivateRepositoryApproval === true,
      requireExactPreparedAction:
        policy.requireExactPreparedActionApproval === true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (page.isClosed() || /has been closed/iu.test(message)) {
      throw new Error(
        `Obsidian page/context closed while clicking prepared approval. Cause: ${message}`,
      );
    }
    throw error;
  }
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
}, options: { placeholderCurrentNote?: boolean } = {}): Promise<void> {
  await context.page.evaluate(async ({ pluginId, notePath, marker, placeholderCurrentNote }) => {
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
      placeholderCurrentNote
        ? ""
        : `# Live Provider Contract\n\nOwned live-provider fixture ${marker}.\n`,
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
    placeholderCurrentNote: options.placeholderCurrentNote === true,
  });
}

async function assertProductionClientReady(
  page: Page,
  config: E2EAiConfig,
  provider: "ollama" | "openai_compatible",
): Promise<void> {
  await verifyWithWorkerConnectionAttestation({
    registry: VERIFIED_REAL_AI_CONNECTIONS,
    target: { provider, baseUrl: config.baseUrl, model: config.model },
    // Provider preflight must leave enough time for the mission it protects.
    // A stalled health/tool probe previously consumed the entire 15-minute
    // Playwright test before Chat received the prompt.
    timeoutMs: Math.max(
      1_000,
      Math.min(60_000, config.firstChunkTimeoutMs, config.missionTimeoutMs),
    ),
    verify: async ({ reuseWorkerAttestation }) =>
      page.evaluate(async ({ pluginId, reuseWorkerAttestation }) => {
        const app = (window as typeof window & { app?: any }).app;
        const plugin = app?.plugins?.plugins?.[pluginId];
        const views =
          app?.workspace?.getLeavesOfType?.("agentic-researcher-view") ?? [];
        if (reuseWorkerAttestation) {
          if (!plugin?.hasVerifiedModelConnection?.()) {
            if (typeof plugin?.markModelConnectionVerifiedForHarness !== "function") {
              throw new Error("Harness connection-reuse marker is unavailable.");
            }
            plugin.markModelConnectionVerifiedForHarness({
              message:
                "Reused the exact live connection attestation from this serial Playwright worker.",
            });
            // Plugin restart can finish before the reattached AgentView has
            // rendered the persisted connection proof. Refresh both the
            // plugin-owned view reference and every live leaf before asserting
            // that Run Mission is enabled.
            plugin.activeAgentView?.refreshFirstRunState?.();
            plugin.refreshAgentView?.();
            for (const leaf of views) {
              leaf.view?.refreshFirstRunState?.();
            }
          }
        } else {
          if (typeof plugin?.testModelConnection !== "function") {
            throw new Error("Production model connection test is unavailable.");
          }
          // The first proof for this exact tuple is always fresh, even when
          // the disposable vault happens to contain matching persisted state.
          await plugin.testModelConnection();
        }
        return {
          settingsModel: plugin?.settings?.model ?? "",
          descriptor: plugin?.createModelClient?.()?.descriptor ?? null,
          connection: plugin?.getModelConnectionStatus?.() ?? null,
          verified: Boolean(plugin?.hasVerifiedModelConnection?.()),
          mockInstalled: Boolean(plugin?.__playwrightE2EMockInstalled),
          viewMocks: views.map((leaf: any) =>
            Boolean(leaf.view?.plugin?.__playwrightE2EMockInstalled),
          ),
        };
      }, { pluginId: NATIVE_CORE_PLUGIN_ID, reuseWorkerAttestation }),
    validate: async (state) => {
      assertRealAiLaneNonMock({
        mockInstalled: state.mockInstalled,
        viewMocks: state.viewMocks,
        descriptorTransportKind: state.descriptor?.transportKind ?? null,
        settingsModel: state.settingsModel,
        expectedModel: config.model,
      });
      expect(state.settingsModel).toBe(config.model);
      expect(state.descriptor).toMatchObject({
        provider,
        model: config.model,
        transportKind: "production",
      });
      expect(state.connection, JSON.stringify(state.connection)).toMatchObject({
        status: "ready",
        provider,
        model: config.model,
      });
      expect(state.verified).toBe(true);
      expect(state.mockInstalled).toBe(false);
      expect(state.viewMocks.every((value: boolean) => value === false)).toBe(
        true,
      );
      await expect(page.locator("button.agentic-researcher-run")).toBeEnabled({
        timeout: 30_000,
      });
    },
  });
}

async function submitMission(
  page: Page,
  prompt: string,
  options: {
    waitForCompletion?: boolean;
    timeoutMs: number;
    clearChatFirst?: boolean;
  },
): Promise<void> {
  await page.getByRole("tab", { name: "Chat" }).click();
  if (options.clearChatFirst !== false) {
    await clearChatInline(page);
  }
  const priorCoordinator = await page.evaluate((pluginId) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    const snapshot = plugin?.getMissionRunSnapshot?.();
    return {
      runId: typeof snapshot?.runId === "string" ? snapshot.runId : null,
      startedAtMs:
        typeof snapshot?.startedAtMs === "number" ? snapshot.startedAtMs : null,
    };
  }, NATIVE_CORE_PLUGIN_ID);
  const input = page.locator("textarea.agentic-researcher-prompt");
  const runButton = page.locator("button.agentic-researcher-run");
  // Compound DU prompts exceed chat bubble text; match a stable unique marker.
  const marker =
    prompt.match(/\bDU0[0-9]_[A-Za-z0-9_]+\b/u)?.[0] ??
    prompt.match(/\bFLOW_REAL_[A-Za-z0-9_]+\b/u)?.[0] ??
    prompt.match(/\bCOMPOUND_REAL_[A-Za-z0-9_]+\b/u)?.[0] ??
    prompt.match(/\bCOMPOUND_SMOKE_[A-Za-z0-9_]+\b/u)?.[0] ??
    prompt.match(/\bOBS_HELLO_[A-Za-z0-9_]+\b/u)?.[0] ??
    prompt.match(/\bE2E Agent Tests\/[^\s]+\.md\b/u)?.[0] ??
    prompt.slice(0, 96);
  await expect(runButton).toBeEnabled({ timeout: 30_000 });
  await input.fill(prompt);
  await runButton.click();
  await expect(
    page.locator(".agentic-researcher-log-user .agentic-researcher-log-message", {
      hasText: marker,
    }).last(),
  ).toBeVisible({ timeout: 30_000 });
  try {
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ pluginId, priorCoordinator }) => {
              const plugin = (window as typeof window & { app?: any }).app?.plugins
                ?.plugins?.[pluginId];
              const snapshot = plugin?.getMissionRunSnapshot?.();
              const currentRunId =
                typeof snapshot?.runId === "string" ? snapshot.runId : null;
              const freshRunId =
                currentRunId !== null &&
                currentRunId.length > 0 &&
                currentRunId !== priorCoordinator.runId;
              const freshCoordinator =
                snapshot?.isRunning === true &&
                snapshot?.state === "running" &&
                typeof snapshot?.startedAtMs === "number" &&
                snapshot.startedAtMs !== priorCoordinator.startedAtMs;
              return freshRunId || freshCoordinator;
            },
            { pluginId: NATIVE_CORE_PLUGIN_ID, priorCoordinator },
          ),
        {
          // A code mission may spend the complete provider probe budget plus the
          // production persistence margin before RunCoordinator.start(). Give
          // that strict gate a separate handoff margin, but never hand the
          // previous successful idle snapshot to the completion broker.
          timeout: Math.min(
            options.timeoutMs,
            HOST_PROVISIONED_SANDBOX_READINESS_TIMEOUT_MS_V1 + 15_000,
          ),
          message:
            "A submitted mission must publish a fresh run identity before completion polling begins.",
        },
      )
      .toBe(true);
  } catch (error) {
    const diagnostic = await page.evaluate((pluginId) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      const snapshot = plugin?.getMissionRunSnapshot?.();
      const readiness = plugin?.getCapabilityReadiness?.();
      const logText =
        document.querySelector(".agentic-researcher-log")?.textContent ?? "";
      return {
        coordinator: {
          isRunning: snapshot?.isRunning ?? null,
          state: snapshot?.state ?? null,
          runId: snapshot?.runId ?? null,
          startedAtMs: snapshot?.startedAtMs ?? null,
          stopReason: snapshot?.lastComplete?.stopReason ?? null,
        },
        runButton: {
          text:
            document
              .querySelector("button.agentic-researcher-run")
              ?.textContent?.trim() ?? null,
          disabled:
            (
              document.querySelector(
                "button.agentic-researcher-run",
              ) as HTMLButtonElement | null
            )?.disabled ?? null,
        },
        readiness: Array.isArray(readiness)
          ? readiness.map((row: any) => ({
              id: row?.id ?? null,
              status: row?.status ?? null,
              reason: row?.reason ?? null,
              nextAction: row?.nextAction ?? null,
            }))
          : [],
        blocker:
          document
            .querySelector(".agentic-researcher-mission-readiness-card")
            ?.textContent?.trim()
            .slice(0, 2_000) ?? null,
        recentChat: logText.trim().slice(-4_000),
      };
    }, NATIVE_CORE_PLUGIN_ID);
    const original =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `Mission launch did not publish a fresh coordinator identity. ${original.slice(
        0,
        1_000,
      )} Safe diagnostic: ${JSON.stringify(diagnostic)}`,
    );
  }
  if (options.waitForCompletion === false) return;
  await waitForMissionComplete(page, options.timeoutMs);
}

async function waitForMissionComplete(page: Page, timeoutMs: number): Promise<void> {
  const run = page.locator("button.agentic-researcher-run");
  await expect(run).toHaveText("Run Mission", { timeout: timeoutMs });
  await expect(run).toBeEnabled({ timeout: timeoutMs });
  await expect(page.locator(".agentic-researcher-run-status-text")).toHaveText(
    IDLE_PRIMARY_STATUS_PATTERN,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const coordinatorReleased = await page.evaluate((pluginId) => {
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      return plugin?.getMissionRunSnapshot?.()?.isRunning === false;
    }, NATIVE_CORE_PLUGIN_ID);
    if (coordinatorReleased) return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Mission UI became idle but the coordinator did not release ownership within ${timeoutMs}ms.`,
  );
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
    if (!plugin?.settings) {
      throw new Error("Production semantic settings are unavailable.");
    }
    // Semantic fixtures are seeded with watcher indexing disabled so setup has
    // one writer. Re-enable the actual production capability before obtaining
    // and exercising its service; the subsequent mission sees the same setting.
    plugin.settings.semanticIndexEnabled = true;
    const service = plugin?.getSemanticIndexService?.() ?? plugin?.semanticIndexService;
    if (!service?.updatePaths) {
      throw new Error("Production semantic index service is unavailable.");
    }
    const runUpdate = async (phase: string) => {
      try {
        return await service.updatePaths(paths);
      } catch (error) {
        const folder = String(plugin.settings.semanticIndexFolder ?? "");
        const abstract = (window as typeof window & { app?: any }).app?.vault
          ?.getAbstractFileByPath?.(folder);
        const kind = abstract
          ? Array.isArray(abstract.children)
            ? "folder"
            : "file"
          : "missing";
        throw new Error(
          `Production semantic index ${phase} threw: ` +
            `${error instanceof Error ? error.message : String(error)}; ` +
            `indexFolder=${folder}; folderKind=${kind}.`,
        );
      }
    };
    let result = await runUpdate("initial update");
    if (!result?.ok) {
      throw new Error(
        `Production semantic index update failed: ` +
          `${result?.code ?? "unknown"}${result?.message ? `: ${result.message}` : ""}`,
      );
    }
    let updated = new Set(result.updatedPaths ?? []);
    if (paths.some((path) => !updated.has(path))) {
      // updatePaths() intentionally falls back to a bounded rebuild when the
      // per-scenario index does not exist yet. That initial rebuild may omit an
      // exact fixture outside semanticIndexMaxFiles. Once it has created a
      // compatible index, a second production update indexes the requested
      // paths directly instead of weakening the product's bounded rebuild cap.
      result = await runUpdate("exact-path retry");
      if (!result?.ok) {
        throw new Error(
          `Production semantic index retry failed: ` +
            `${result?.code ?? "unknown"}${result?.message ? `: ${result.message}` : ""}`,
        );
      }
      updated = new Set(result.updatedPaths ?? []);
    }
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
    sourceCount?: 1 | 2 | 3;
    topic?: "generic" | "checkers";
    conflictingEvidence?: boolean;
  },
): Promise<void> {
  await page.evaluate(({ pluginId, failFirstFetch, sourceCount, marker, topic, conflictingEvidence }) => {
    const w = window as typeof window & {
      app?: any;
      __realAiWebRestore?: () => void;
      __realAiWebMetrics?: OwnedWebMetricsV1;
    };
    const plugin = w.app?.plugins?.plugins?.[pluginId];
    if (!plugin) throw new Error("Core plugin unavailable.");
    w.__realAiWebRestore?.();
    w.__realAiWebMetrics = {
      version: 1,
      searchTransportCalls: 0,
      fetchTransportCalls: 0,
      failedFetchTransportCalls: 0,
    };
    const original = plugin.createToolExecutionContext;
    let fetchCalls = 0;
    plugin.createToolExecutionContext = function (prompt: string) {
      const context = original.call(this, prompt);
      const realTransport = context.httpTransport;
      context.httpTransport = async (request: any) => {
        if (String(request.url).endsWith("/web_search")) {
          if (w.__realAiWebMetrics) {
            w.__realAiWebMetrics.searchTransportCalls += 1;
          }
          const markerPath = encodeURIComponent(marker);
          const results = topic === "checkers"
            ? [
                {
                  title: "Owned primary source: American checkers rules",
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
                { title: "Owned primary source", url: `https://primary.owned.example/evidence/${markerPath}`, snippet: "Owned passage: alpha evidence establishes the first finding." },
                { title: "Owned alternate", url: `https://alternate-owned.example/evidence/${markerPath}`, snippet: "Owned passage: beta evidence establishes the second finding." },
              ];
          if (sourceCount === 3) {
            results.push({
              title: "Owned corroborating",
              url: `https://corroborating-owned.example/evidence/${markerPath}`,
              snippet: "Owned passage: gamma evidence independently corroborates the bounded synthesis.",
            });
          }
          return {
            status: 200,
            headers: {},
            json: { results: results.slice(0, sourceCount) },
          };
        }
        if (String(request.url).endsWith("/web_fetch")) {
          fetchCalls += 1;
          if (w.__realAiWebMetrics) {
            w.__realAiWebMetrics.fetchTransportCalls += 1;
          }
          const body = JSON.parse(String(request.body ?? "{}"));
          if (failFirstFetch && fetchCalls === 1) {
            if (w.__realAiWebMetrics) {
              w.__realAiWebMetrics.failedFetchTransportCalls += 1;
            }
            return { status: 503, headers: { "retry-after": "0" }, json: { error: "owned retryable source failure" } };
          }
          const alternate = String(body.url).includes("alternate");
          const corroborating = String(body.url).includes("corroborating");
          return { status: 200, headers: {}, json: {
            title: corroborating
              ? "Owned corroborating"
              : alternate
                ? "Owned alternate"
                : "Owned primary source",
            content: topic === "checkers"
              ? alternate
                ? "American checkers ends when a player has no pieces or no legal move. A legal-move engine must return captures instead of quiet moves whenever any capture exists. After a jump, the same piece must continue while another jump is available, so the turn changes only after the capture sequence ends. A man reaching the opponent's back rank is crowned as a king; kings may move and capture diagonally forward or backward. Draw conventions vary and should be documented rather than invented for a bounded implementation."
                : "American checkers, also called English draughts, is played only on the dark squares of an 8 by 8 board. Each side begins with twelve men on the first three rows nearest that player. Men move one dark square diagonally forward. Captures jump an adjacent opposing piece into the empty square beyond and are mandatory when available. Multiple jumps continue with the same piece. Reaching the farthest row crowns a man as a king, which can move and capture in both diagonal directions."
              : corroborating
                ? "Gamma evidence is a third independently fetched passage. It positively corroborates the bounded synthesis and preserves the existing tool authority."
                : alternate
                  ? conflictingEvidence
                    ? "The controlled onboarding validation evidence does not show improved user retention rate or reduced errors. The alternate study reports no reliable benefit."
                    : "Beta evidence is the independently fetched second passage. It supports bounded recovery and source verification."
                  : conflictingEvidence
                    ? "The controlled onboarding validation evidence shows improved user retention rate and reduced errors. The primary study reports a reliable benefit."
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
    conflictingEvidence: options.conflictingEvidence === true,
  });
}

async function readOwnedWebMetrics(page: Page): Promise<OwnedWebMetricsV1> {
  return page.evaluate(() => {
    const metrics = (window as typeof window & {
      __realAiWebMetrics?: OwnedWebMetricsV1;
    }).__realAiWebMetrics;
    if (!metrics) {
      throw new Error("Owned web metrics are unavailable.");
    }
    return { ...metrics };
  });
}

async function restoreOwnedWebBackend(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & {
      __realAiWebRestore?: () => void;
      __realAiWebMetrics?: OwnedWebMetricsV1;
    };
    w.__realAiWebRestore?.();
    delete w.__realAiWebMetrics;
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
    if (!current) return current;
    const runId = typeof current.runId === "string" ? current.runId.trim() : "";
    if (!runId) throw new Error("Current production run has no run id for ledger attestation.");
    const configRootRunId =
      typeof current.lastConfig?.runId === "string"
        ? current.lastConfig.runId.trim()
        : "";
    if (!configRootRunId || configRootRunId !== runId) {
      throw new Error(
        "Current production run does not match its exact config root identity.",
      );
    }
    const summaryRunId =
      typeof current.lastMissionLedger?.runId === "string"
        ? current.lastMissionLedger.runId.trim()
        : "";
    const configLedgerRunId =
      typeof current.lastConfig?.missionLedger?.runId === "string"
        ? current.lastConfig.missionLedger.runId.trim()
        : "";
    if (!summaryRunId || !configLedgerRunId || summaryRunId !== configLedgerRunId) {
      throw new Error(
        "Current production run does not have one exact config/summary ledger identity.",
      );
    }
    const ledgerRunId = summaryRunId;
    // persistedProjection describes startup hydration and is intentionally
    // cleared once a fresh run publishes authority. Resolve the current run's
    // exact canonical ledger path from its identity instead of silently
    // treating a null/stale projection as an empty persisted proof set.
    const safeRunId =
      ledgerRunId
        .replace(/[^A-Za-z0-9._-]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 120) || "run";
    const ledgerPath = `Agent Runs/${safeRunId}.md`;
    const app = (window as typeof window & { app?: any }).app;
    const ledgerFile = app?.vault?.getFileByPath?.(ledgerPath);
    try {
      const markdown = ledgerFile
        ? await app.vault.read(ledgerFile)
        : await app?.vault?.adapter?.read?.(ledgerPath);
      if (typeof markdown !== "string" || markdown.length === 0) {
        throw new Error(`Current production ledger is missing at ${ledgerPath}.`);
      }
      const match = /## Mission Ledger\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(markdown);
      const ledger = match ? JSON.parse(match[1]) : null;
      const runtimeMatch = /## Runtime Snapshot\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(markdown);
      const runtime = runtimeMatch ? JSON.parse(runtimeMatch[1]) : null;
      if (!ledger || ledger.runId !== ledgerRunId) {
        throw new Error(`Persisted ledger identity mismatch at ${ledgerPath}.`);
      }
      if (
        !runtime ||
        runtime.runId !== ledgerRunId ||
        runtime.lineage?.segmentId !== ledgerRunId
      ) {
        throw new Error(`Persisted runtime identity mismatch at ${ledgerPath}.`);
      }
      const runtimeLineage = runtime.lineage;
      const rootRunId =
        typeof runtimeLineage?.rootRunId === "string"
          ? runtimeLineage.rootRunId.trim()
          : "";
      const segmentId =
        typeof runtimeLineage?.segmentId === "string"
          ? runtimeLineage.segmentId.trim()
          : "";
      const segmentIndex = runtimeLineage?.segmentIndex;
      const parentSegmentId =
        typeof runtimeLineage?.parentSegmentId === "string"
          ? runtimeLineage.parentSegmentId.trim()
          : null;
      const rawPriorSegmentIds = runtimeLineage?.priorSegmentIds;
      const priorSegmentIds = Array.isArray(rawPriorSegmentIds)
        ? rawPriorSegmentIds.filter(
            (value: unknown): value is string =>
              typeof value === "string" &&
              value.length > 0 &&
              value === value.trim(),
          )
        : [];
      const uniquePriorSegmentIds = new Set(priorSegmentIds);
      if (
        !rootRunId ||
        !segmentId ||
        segmentId !== ledgerRunId ||
        !Number.isInteger(segmentIndex) ||
        segmentIndex < 0 ||
        !Array.isArray(rawPriorSegmentIds) ||
        priorSegmentIds.length !== rawPriorSegmentIds.length ||
        uniquePriorSegmentIds.size !== priorSegmentIds.length ||
        uniquePriorSegmentIds.has(segmentId)
      ) {
        throw new Error(`Persisted runtime lineage is invalid at ${ledgerPath}.`);
      }
      if (
        segmentIndex === 0
          ? (
              rootRunId !== segmentId ||
              parentSegmentId !== null ||
              priorSegmentIds.length !== 0
            )
          : (
              priorSegmentIds.length !== segmentIndex ||
              priorSegmentIds[0] !== rootRunId ||
              priorSegmentIds.at(-1) !== parentSegmentId
            )
      ) {
        throw new Error(`Persisted runtime continuation chain is invalid at ${ledgerPath}.`);
      }
      current.attestedRunLineage = {
        rootRunId,
        segmentId,
        segmentIndex,
        parentSegmentId,
        priorSegmentIds,
        segmentIds: [...priorSegmentIds, segmentId],
      };
      if (ledgerRunId !== runId) {
        const graph = current.lastMissionGraph;
        const orchestratorRootBound =
          graph?.missionId === runId &&
          graph?.nodes?.dispatch?.executorId === "research-team";
        if (!orchestratorRootBound) {
          throw new Error(
            `Persisted child ledger ${ledgerRunId} is not bound to research-team root ${runId}.`,
          );
        }

        const leadRootRunId = `${runId}-lead`;
        const lineage = runtime.lineage;
        const segmentIndex = lineage?.segmentIndex;
        const priorSegmentIds = Array.isArray(lineage?.priorSegmentIds)
          ? lineage.priorSegmentIds
          : [];
        const parentSegmentId =
          typeof lineage?.parentSegmentId === "string"
            ? lineage.parentSegmentId
            : "";
        if (lineage?.rootRunId !== leadRootRunId) {
          throw new Error("Research-team lead lineage has the wrong root identity.");
        }
        if (segmentIndex === 0) {
          if (
            ledgerRunId !== leadRootRunId ||
            parentSegmentId ||
            priorSegmentIds.length !== 0
          ) {
            throw new Error("Initial research-team lead lineage is invalid.");
          }
        } else {
          const uniquePriorSegmentIds = new Set(priorSegmentIds);
          if (
            !Number.isInteger(segmentIndex) ||
            segmentIndex < 1 ||
            priorSegmentIds.length !== segmentIndex ||
            priorSegmentIds[0] !== leadRootRunId ||
            priorSegmentIds.at(-1) !== parentSegmentId ||
            uniquePriorSegmentIds.size !== priorSegmentIds.length ||
            uniquePriorSegmentIds.has(ledgerRunId)
          ) {
            throw new Error("Continued research-team lead lineage is invalid.");
          }
        }
      }
      const nonNegativeNumber = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : null;
      const nonNegativeInteger = (value: unknown): number | null => {
        const numeric = nonNegativeNumber(value);
        return numeric !== null && Number.isInteger(numeric) ? numeric : null;
      };
      const effort = ledger?.researchPlan?.effort;
      const effortUsage = ledger?.researchPlan?.effortUsage;
      const effortClosure = ledger?.researchPlan?.effortClosure;
      const tier = ["quick", "standard", "deep", "extended"].includes(
        effort?.tier,
      )
        ? effort.tier
        : null;
      const closureReason = [
        "duration_cap_reached",
        "model_step_cap_reached",
        "tool_call_cap_reached",
        "research_budget_reached",
      ].includes(effortClosure?.reason)
        ? effortClosure.reason
        : null;
      // Explicit projection only: never expose planner reasons, prompt text,
      // evidence content, source URLs, credentials, or provider payloads.
      current.redactedResearchEffort = tier
        ? {
            tier,
            budget: {
              maxModelStepsPerSegment: nonNegativeInteger(
                effort?.budget?.maxModelStepsPerSegment,
              ),
              maxToolCallsPerSegment: nonNegativeInteger(
                effort?.budget?.maxToolCallsPerSegment,
              ),
              maxSegments: nonNegativeInteger(effort?.budget?.maxSegments),
              maxTotalModelSteps: nonNegativeInteger(
                effort?.budget?.maxTotalModelSteps,
              ),
              maxTotalToolCalls: nonNegativeInteger(
                effort?.budget?.maxTotalToolCalls,
              ),
              maxDurationMs:
                effort?.budget?.maxDurationMs === null
                  ? null
                  : nonNegativeNumber(effort?.budget?.maxDurationMs),
            },
            usage: {
              modelSteps: nonNegativeInteger(effortUsage?.modelSteps),
              toolCalls: nonNegativeInteger(effortUsage?.toolCalls),
              segmentsStarted: nonNegativeInteger(
                effortUsage?.segmentsStarted,
              ),
              modelStepsInCurrentSegment: nonNegativeInteger(
                effortUsage?.modelStepsInCurrentSegment,
              ),
              toolCallsInCurrentSegment: nonNegativeInteger(
                effortUsage?.toolCallsInCurrentSegment,
              ),
              completionSegmentsStarted: nonNegativeInteger(
                effortUsage?.completionSegmentsStarted,
              ),
              elapsedMs: nonNegativeNumber(effortUsage?.elapsedMs),
            },
            closure: effortClosure
              ? {
                  requested: effortClosure.requested === true,
                  attempts: nonNegativeInteger(effortClosure.attempts),
                  reason: closureReason,
                }
              : null,
          }
        : null;
      current.redactedEvidenceConflicts = Array.isArray(ledger?.evidenceConflicts)
        ? ledger.evidenceConflicts.map((conflict: any) => ({
            id: conflict?.id ?? null,
            status: conflict?.status ?? null,
            passageIds: Array.isArray(conflict?.passageIds)
              ? conflict.passageIds.slice(0, 4)
              : [],
          }))
        : [];
      current.redactedClaimPassageIds = Array.isArray(ledger?.claimPassages)
        ? ledger.claimPassages
            .map((passage: any) => passage?.id)
            .filter(
              (id: unknown) =>
                typeof id === "string" &&
                /^source:[a-z0-9-]+:passage:\d+-\d+$/u.test(id),
            )
            .slice(0, 24)
        : [];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to attest the current production ledger at ${ledgerPath}: ${detail}`,
      );
    }
    return current;
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
  expect(snapshot).toBeTruthy();
  expect(snapshot.modelCallEvidence.length).toBeGreaterThan(0);
  const successes = snapshot.modelCallEvidence.filter(
    (item: any) => item.outcome === "success" && item.transportKind === "production",
  );
  if (successes.length === 0) {
    const redactedCalls = snapshot.modelCallEvidence.slice(-8).map((item: any) => ({
      phase: item.phase ?? null,
      attempt: item.attempt ?? null,
      outcome: item.outcome ?? null,
      transportKind: item.transportKind ?? null,
      model: item.model ?? null,
      errorCategory: item.errorCategory ?? null,
      responseChars: item.responseChars ?? 0,
      tokenUsageReported: item.tokenUsageReported === true,
    }));
    throw new Error(
      `No successful production model call was attested: ${JSON.stringify(redactedCalls)}.`,
    );
  }
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
