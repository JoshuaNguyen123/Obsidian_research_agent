import { expect, type Locator, type Page } from "@playwright/test";

import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./nativeObsidianHarness";

export interface FixedLinearQueueFixture {
  issueId: string;
  issueIdentifier: string;
  issueUrl: string;
  description: string;
  workItemFingerprint: string;
}

export interface FixedLinearQueueSnapshot {
  calls: Array<{ operationKey: string; variables: Record<string, unknown> }>;
  issue: any;
  comments: any[];
  candidate: any | null;
  pendingStages: string[];
  resourceLockKeys: string[];
  receipts: any[];
  queueGrantScopes: any[];
  modelCreateCalls: number;
  modelPrompts: string[];
  modelRequests: Array<{
    structured: boolean;
    step: number;
    tools: string[];
    recentMessages: Array<{ role: string; content: string }>;
  }>;
}

export interface Phase6LinearHarness extends NativeObsidianHarness {
  submitMission(
    prompt: string,
    options?: { waitForCompletion?: boolean; timeoutMs?: number },
  ): Promise<void>;
  waitForMissionComplete(timeoutMs?: number): Promise<void>;
  activePreparedApproval(toolName: string): Locator;
  approvePreparedApproval(approval: Locator): Promise<void>;
  installLinearIntentSentinel(): Promise<void>;
  readLinearIntentExposures(): Promise<
    Array<{ prompt: string; toolNames: string[] }>
  >;
  restoreLinearIntentSentinel(): Promise<void>;
  installResearchPublicationClient(): Promise<void>;
  readResearchPublicationState(notePath: string): Promise<{
    createCalls: number;
    issueGetCalls: number;
    issue: any | null;
    checkpoint: any | null;
    hierarchyCreateCalls: number;
    hierarchyRecords: any[];
    hierarchyCheckpoint: any | null;
    missionSnapshot: any | null;
    toolFailures: Array<{
      name: string;
      code: string;
      message: string;
    }>;
    runErrors: Array<{
      id: string;
      code: string;
      message: string;
    }>;
  }>;
  cleanupResearchPublication(notePath: string): Promise<void>;
  cleanupResearchProjectHierarchy(): Promise<{
    removed: number;
    remaining: number;
  }>;
  installQueueClient(fixture: FixedLinearQueueFixture): Promise<void>;
  authorizeAndRunQueue(): Promise<{ ok: boolean; message: string }>;
  waitForReconciliation(issueId: string): Promise<FixedLinearQueueSnapshot>;
  restartQueueForReconciliation(): Promise<void>;
  readQueueState(issueId: string): Promise<FixedLinearQueueSnapshot>;
  stopQueueClient(): Promise<void>;
  deleteVaultFixture(targetPath: string): Promise<void>;
}

/**
 * Dedicated Phase 6 native harness. Its model is limited to the explicit
 * research-publication action, ordinary chat-only negative probes, and the
 * host-bound create_file used by trusted queue work. Linear effects still
 * travel through production publication/queue contracts and fixed clients.
 */
export async function startPhase6LinearHarness(): Promise<Phase6LinearHarness> {
  const native = await startNativeObsidianHarness({
    label: "linear-queue-vault-reconciliation",
    setup: installPhase6LinearPageHarness,
    beforeClose: async ({ page }) => {
      await stopFixedLinearQueueClient(page).catch(() => undefined);
      await restoreFixedLinearPublicationClient(page).catch(() => undefined);
      await restoreLinearIntentSentinel(page).catch(() => undefined);
    },
  });

  try {
    await expect(native.page.locator(".agentic-researcher-view")).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(native.page.getByRole("tab", { name: "Chat" })).toBeVisible();
    await expect(
      native.page.getByRole("tab", { name: "Run Details" }),
    ).toBeVisible();
  } catch (error) {
    await native.close().catch(() => undefined);
    throw error;
  }

  return {
    ...native,
    submitMission: (prompt, options = {}) =>
      submitMission(native.page, prompt, options),
    waitForMissionComplete: (timeoutMs = 60_000) =>
      waitForMissionComplete(native.page, timeoutMs),
    activePreparedApproval: (toolName) =>
      activePreparedApproval(native.page, toolName),
    approvePreparedApproval: (approval) =>
      approvePreparedApproval(native.page, approval),
    installLinearIntentSentinel: () =>
      installLinearIntentSentinel(native.page),
    readLinearIntentExposures: () => readLinearIntentExposures(native.page),
    restoreLinearIntentSentinel: () =>
      restoreLinearIntentSentinel(native.page),
    installResearchPublicationClient: () =>
      installFixedLinearPublicationClient(native.page),
    readResearchPublicationState: (notePath) =>
      readFixedLinearPublicationState(native.page, notePath),
    cleanupResearchPublication: (notePath) =>
      cleanupResearchPublication(native.page, notePath),
    cleanupResearchProjectHierarchy: () =>
      cleanupResearchProjectHierarchy(native.page),
    installQueueClient: (fixture) =>
      installFixedLinearQueueClient(native.page, fixture),
    authorizeAndRunQueue: () => authorizeAndRunFixedLinearQueue(native.page),
    waitForReconciliation: (issueId) =>
      waitForFixedLinearQueueReconciliationState(native.page, issueId),
    restartQueueForReconciliation: () =>
      restartFixedLinearQueueForReconciliation(native.page),
    readQueueState: (issueId) => readFixedLinearQueueState(native.page, issueId),
    stopQueueClient: () => stopFixedLinearQueueClient(native.page),
    deleteVaultFixture: (targetPath) =>
      deleteVaultFixture(native.page, targetPath),
  };
}

async function installPhase6LinearPageHarness(context: {
  page: Page;
  marker: string;
  notePath: string;
}): Promise<void> {
  await context.page.evaluate(
    async ({ pluginId, marker, notePath }) => {
      const phase6Window = window as typeof window & {
        app?: any;
        __e2eLinearIntentToolExposure?: Array<{
          prompt: string;
          toolNames: string[];
        }>;
        __e2eLinearQueueModelCreateCalls?: number;
        __e2eLinearQueueModelPrompts?: string[];
        __e2eLinearQueueModelRequests?: Array<{
          structured: boolean;
          step: number;
          tools: string[];
          recentMessages: Array<{ role: string; content: string }>;
        }>;
      };
      const app = phase6Window.app;
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

      const ensureFolder = async (folderPath: string) => {
        let current = "";
        for (const part of folderPath.split("/").filter(Boolean)) {
          current = current ? `${current}/${part}` : part;
          if (app.vault.getAbstractFileByPath(current)) continue;
          try {
            await app.vault.createFolder(current);
          } catch (error) {
            if (!/already exists/iu.test(String(error))) throw error;
          }
        }
      };
      await ensureFolder(notePath.split("/").slice(0, -1).join("/"));
      const existing = app.vault.getAbstractFileByPath(notePath);
      if (existing) await app.vault.delete(existing, true);
      const note = await app.vault.create(
        notePath,
        `# Phase 6 Linear Playwright\n\nFixture ${marker}.\n`,
      );
      const markdownLeaves = app.workspace.getLeavesOfType?.("markdown") ?? [];
      const emptyLeaves = app.workspace.getLeavesOfType?.("empty") ?? [];
      const noteLeaf =
        markdownLeaves[0] ?? emptyLeaves[0] ?? app.workspace.getLeaf("tab");
      await noteLeaf.openFile(note);
      app.workspace.setActiveLeaf(noteLeaf, { focus: true });

      const stepCounts = new Map<string, number>();
      const createModelClient = () => ({
        playwrightE2EMock: true,
        async chat(request: {
          messages?: Array<{ role?: string; content?: string }>;
          tools?: Array<{ function?: { name?: string } }>;
          format?: unknown;
        }) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const latestUserText =
            [...(request.messages ?? [])]
              .reverse()
              .find((message) => message.role === "user")
              ?.content ?? "";
          const requestText = (request.messages ?? [])
            .map((message) => message.content ?? "")
            .join("\n");
          const tools = (request.tools ?? [])
            .map((tool) => tool.function?.name)
            .filter((name): name is string => typeof name === "string");

          if (requestText.includes("E2E_LINEAR_PROJECT_HIERARCHY")) {
            if (request.format !== undefined) {
              return {
                message: { role: "assistant", content: "{}" },
                toolCalls: [],
                raw: { playwrightPhase6Linear: true },
              };
            }
            const activeRunId =
              plugin.getMissionRunSnapshot?.()?.lastConfig?.runId ?? "unknown-run";
            const hierarchyKey =
              `E2E_LINEAR_PROJECT_HIERARCHY:${marker}:${activeRunId}`;
            const hierarchyStep = stepCounts.get(hierarchyKey) ?? 0;
            if (hierarchyStep === 0) {
              if (
                !tools.includes("read_template") ||
                tools.includes("publish_research_project_to_linear")
              ) {
                throw new Error(
                  `The Linear issue template must be the first hierarchy frontier. Tools: ${tools.join(", ")}`,
                );
              }
              stepCounts.set(hierarchyKey, 1);
              const toolCall = {
                id: "playwright-e2e-linear-project-template",
                index: 0,
                name: "read_template",
                arguments: {
                  path: "Agent Work/templates/Linear issue.md",
                  maxChars: 12_000,
                },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightPhase6Linear: true },
              };
            }
            if (hierarchyStep === 1) {
              if (
                !requestText.includes("{{problem_impact}}") ||
                !requestText.includes("## Acceptance criteria")
              ) {
                throw new Error("The hierarchy mission did not receive the canonical Linear issue template.");
              }
              if (!tools.includes("publish_research_project_to_linear")) {
                throw new Error(
                  `Explicit project hierarchy intent did not expose its composite tool. Tools: ${tools.join(", ")}`,
                );
              }
              const notePath = `E2E Agent Tests/Accepted Research ${marker}.md`;
              const checkpoints =
                await plugin.researchPublicationCheckpointStore?.list?.();
              const accepted = Array.isArray(checkpoints)
                ? checkpoints.find(
                    (candidate: any) => candidate?.artifact?.notePath === notePath,
                  )
                : null;
              const artifactFingerprint =
                accepted?.artifact?.artifactFingerprint;
              if (typeof artifactFingerprint !== "string") {
                throw new Error(
                  "The hierarchy mission could not resolve its accepted research binding.",
                );
              }
              stepCounts.set(hierarchyKey, 2);
              const toolCall = {
                id: "playwright-e2e-linear-project-hierarchy",
                index: 0,
                name: "publish_research_project_to_linear",
                arguments: {
                  plan: {
                    planId: `e2e-project-plan-${marker.toLowerCase()}`,
                    acceptedResearchArtifactFingerprint: artifactFingerprint,
                    sourceNotePath: notePath,
                    initiative: {
                      key: "initiative-e2e",
                      title: `E2E Research Initiative ${marker}`,
                      description:
                        "Own the accepted research through verified delivery.",
                    },
                    project: {
                      key: "project-e2e",
                      title: `E2E Research Project ${marker}`,
                      description:
                        "Deliver the dependency-aware accepted research plan.",
                    },
                    issues: [
                      {
                        key: "issue-foundation",
                        title: `Implement foundation ${marker}`,
                        description: "Implement the first verified work slice.",
                        dependencyKeys: [],
                        acceptanceCriteria: [
                          "Targeted and fresh-full validation both pass.",
                        ],
                        workItemFingerprint: `sha256:${"b".repeat(64)}`,
                      },
                      {
                        key: "issue-reconcile",
                        title: `Reconcile delivery ${marker}`,
                        description: "Backlink and reconcile the verified result.",
                        dependencyKeys: ["issue-foundation"],
                        acceptanceCriteria: [
                          "Provider readbacks and backlinks are independently verified.",
                        ],
                        workItemFingerprint: `sha256:${"c".repeat(64)}`,
                      },
                    ],
                  },
                },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightPhase6Linear: true },
              };
            }
            return {
              message: {
                role: "assistant",
                content: `E2E_LINEAR_PROJECT_HIERARCHY_DONE ${marker}`,
              },
              toolCalls: [],
              raw: { playwrightPhase6Linear: true },
            };
          }

          if (requestText.includes("E2E_LINEAR_RESEARCH_PUBLICATION")) {
            if (request.format !== undefined) {
              return {
                message: { role: "assistant", content: "{}" },
                toolCalls: [],
                raw: { playwrightPhase6Linear: true },
              };
            }
            const publicationKey = `E2E_LINEAR_RESEARCH_PUBLICATION:${marker}`;
            const publicationStep = stepCounts.get(publicationKey) ?? 0;
            if (publicationStep === 0) {
              if (
                !tools.includes("read_template") ||
                tools.includes("publish_research_to_linear")
              ) {
                throw new Error(
                  `The Linear issue template must be the first publication frontier. Tools: ${tools.join(", ")}`,
                );
              }
              stepCounts.set(publicationKey, 1);
              const toolCall = {
                id: "playwright-e2e-linear-research-template",
                index: 0,
                name: "read_template",
                arguments: {
                  path: "Agent Work/templates/Linear issue.md",
                  maxChars: 12_000,
                },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightPhase6Linear: true },
              };
            }
            if (publicationStep === 1) {
              if (
                !requestText.includes("{{problem_impact}}") ||
                !requestText.includes("## Acceptance criteria")
              ) {
                throw new Error("The publication mission did not receive the canonical Linear issue template.");
              }
              if (!tools.includes("publish_research_to_linear")) {
                throw new Error(
                  `Explicit research publication did not expose its composite tool. Tools: ${tools.join(", ")}`,
                );
              }
              const activeRunId =
                plugin.getMissionRunSnapshot?.()?.lastConfig?.runId;
              if (typeof activeRunId !== "string" || !activeRunId.trim()) {
                throw new Error(
                  "The active host run id was unavailable for accepted research publication.",
                );
              }
              stepCounts.set(publicationKey, 2);
              const toolCall = {
                id: "playwright-e2e-linear-research-publication",
                index: 0,
                name: "publish_research_to_linear",
                arguments: {
                  notePath: `E2E Agent Tests/Accepted Research ${marker}.md`,
                  mode: "create",
                  package: {
                    schemaVersion: 1,
                    title: `E2E Linear publication ${marker}`,
                    problemImpact:
                      `The accepted ${marker} research must be note-backed before any external mutation.`,
                    evidence: [
                      {
                        id: "evidence-user-1",
                        kind: "user",
                        reference: "e2e-user-accepted-evidence",
                        contentSha256: `sha256:${"a".repeat(64)}`,
                        label: "Accepted E2E evidence",
                        summary:
                          "The deterministic evidence supports the approved handoff scope.",
                      },
                    ],
                    confidenceLimitations:
                      "High confidence in the deterministic handoff; live provider smoke testing is separate.",
                    proposedWork: [
                      "Publish one verified work item with durable lineage.",
                    ],
                    nonGoals: ["Automatic merge or hidden publication."],
                    scope: ["Explicit Obsidian to Linear research handoff."],
                    dependencies: ["A verified Linear workspace binding."],
                    acceptanceCriteria: [
                      {
                        id: "AC-1",
                        text: "The accepted note exists before Linear mutation.",
                      },
                      {
                        id: "AC-2",
                        text: "Verified readback and backlink receipts preserve lineage.",
                      },
                    ],
                    validationRequirementKeys: ["tests.playwright"],
                    riskClass: "medium",
                    executionClass: "research",
                    objective:
                      "Deliver the accepted research handoff with verified lineage.",
                  },
                },
              };
              return {
                message: { role: "assistant", content: "", toolCalls: [toolCall] },
                toolCalls: [toolCall],
                raw: { playwrightPhase6Linear: true },
              };
            }
            return {
              message: {
                role: "assistant",
                content:
                  `E2E_LINEAR_RESEARCH_PUBLICATION_DONE ${marker}: accepted research was verified in Obsidian and Linear.`,
              },
              toolCalls: [],
              raw: { playwrightPhase6Linear: true },
            };
          }

          if (latestUserText.includes("E2E_LINEAR_INTENT_NEGATIVE")) {
            const exposure = { prompt: latestUserText, toolNames: tools };
            phase6Window.__e2eLinearIntentToolExposure = [
              ...(phase6Window.__e2eLinearIntentToolExposure ?? []),
              exposure,
            ];
            const exposedLinearTools = tools.filter((name) =>
              name.startsWith("linear_"),
            );
            if (exposedLinearTools.length > 0) {
              throw new Error(
                `Ordinary Linear-looking text exposed Linear tools: ${exposedLinearTools.join(", ")}`,
              );
            }
            const responseMarker =
              /E2E_LINEAR_INTENT_NEGATIVE_[A-Z]+/u.exec(latestUserText)?.[0] ??
              "E2E_LINEAR_INTENT_NEGATIVE_MISSING";
            return {
              message: {
                role: "assistant",
                content:
                  `${responseMarker}: handled as ordinary chat text without Linear routing.`,
              },
              toolCalls: [],
              raw: { playwrightPhase6Linear: true },
            };
          }

          const queueMarker =
            /E2E_LINEAR_QUEUE_VAULT_E2E_MARKER_\d+_\d+/u.exec(requestText)?.[0] ??
            null;
          if (!queueMarker) {
            throw new Error("Phase 6 model received an unsupported mission.");
          }
          const step = stepCounts.get(queueMarker) ?? 0;
          phase6Window.__e2eLinearQueueModelRequests = [
            ...(phase6Window.__e2eLinearQueueModelRequests ?? []),
            {
              structured: request.format !== undefined,
              step,
              tools,
              recentMessages: (request.messages ?? []).slice(-4).map((message) => ({
                role: String(message.role ?? ""),
                content: String(message.content ?? "").slice(-800),
              })),
            },
          ];
          if (request.format !== undefined) {
            return {
              message: { role: "assistant", content: "{}" },
              toolCalls: [],
              raw: { playwrightPhase6Linear: true },
            };
          }
          if (step === 0) {
            if (!tools.includes("create_file")) {
              throw new Error(
                `Trusted queue host did not expose create_file. Tools: ${tools.join(", ")}`,
              );
            }
            const targetPath =
              /(Agent Work\/Linear Queue\/[0-9a-f]{32}\.md)/u.exec(requestText)?.[1] ??
              "";
            if (!targetPath) {
              throw new Error(
                "The trusted Linear queue prompt omitted its host-bound target path.",
              );
            }
            const evidenceRef = `research:${queueMarker}`;
            const content = [
              "# Verified Linear queue result",
              "",
              queueMarker,
              "",
              "## Acceptance verification",
              "",
              `- AC-1: ${queueMarker} was written through the host-bound create tool.`,
              `- Evidence: ${evidenceRef}`,
            ].join("\n");
            phase6Window.__e2eLinearQueueModelCreateCalls =
              (phase6Window.__e2eLinearQueueModelCreateCalls ?? 0) + 1;
            phase6Window.__e2eLinearQueueModelPrompts = [
              ...(phase6Window.__e2eLinearQueueModelPrompts ?? []),
              requestText,
            ];
            stepCounts.set(queueMarker, 1);
            const toolCall = {
              id: `playwright-linear-queue-vault-${targetPath.slice(-35, -3)}`,
              index: 0,
              name: "create_file",
              arguments: { path: targetPath, content, createFolders: true },
            };
            return {
              message: { role: "assistant", content: "", toolCalls: [toolCall] },
              toolCalls: [toolCall],
              raw: { playwrightPhase6Linear: true },
            };
          }
          return {
            message: {
              role: "assistant",
              content: [
                `${queueMarker}_DONE`,
                "AC-1 satisfied by the verified host-bound vault receipt.",
                `Evidence: research:${queueMarker}`,
              ].join("\n"),
            },
            toolCalls: [],
            raw: { playwrightPhase6Linear: true },
          };
        },
        async streamChat() {
          throw new Error("Phase 6 deterministic Linear tests disable streaming.");
        },
      });
      const install = (target: any) => {
        if (!target) return;
        target.settings = {
          ...target.settings,
          enableStreaming: false,
          thinkingMode: "off",
          model: "playwright-phase6-linear-mock",
          orchestratorEnabled: false,
          orchestratorPreviewEnabled: false,
          agenticReflexEnabled: false,
          completionDrivenLoops: false,
          semanticIndexEnabled: false,
          maxAgentSteps: 100,
          streamWritebackMode: "off",
        };
        target.saveSettings = async () => undefined;
        target.appendConversationMessage = async function (message: unknown) {
          this.conversationHistory = [...(this.conversationHistory ?? []), message];
        };
        target.createModelClient = createModelClient;
        target.__playwrightE2EMockInstalled = true;
        const prototype = Object.getPrototypeOf(target);
        if (prototype) prototype.createModelClient = createModelClient;
      };
      phase6Window.__e2eLinearQueueModelCreateCalls = 0;
      phase6Window.__e2eLinearQueueModelPrompts = [];
      phase6Window.__e2eLinearQueueModelRequests = [];
      install(plugin);
      for (const leaf of app.workspace.getLeavesOfType?.(
        "agentic-researcher-view",
      ) ?? []) {
        install(leaf.view?.plugin);
      }
      await plugin.activateView?.();
      install(app.plugins.plugins?.[pluginId]);
      for (const leaf of app.workspace.getLeavesOfType?.(
        "agentic-researcher-view",
      ) ?? []) {
        install(leaf.view?.plugin);
      }
    },
    {
      pluginId: NATIVE_CORE_PLUGIN_ID,
      marker: context.marker,
      notePath: context.notePath,
    },
  );
}

async function submitMission(
  page: Page,
  prompt: string,
  options: { waitForCompletion?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  await page.getByRole("tab", { name: "Chat" }).click();
  const promptInput = page.locator("textarea.agentic-researcher-prompt");
  const runButton = page.locator("button.agentic-researcher-run");
  await promptInput.fill(prompt);
  await expect(promptInput).toHaveValue(prompt);
  await runButton.click();
  await expect(
    page.locator(
      ".agentic-researcher-log-user .agentic-researcher-log-message",
      { hasText: prompt },
    ).last(),
  ).toBeVisible({ timeout: 5_000 });
  if (options.waitForCompletion === false) return;
  await waitForMissionComplete(page, options.timeoutMs ?? 60_000);
  await page.getByRole("tab", { name: "Chat" }).click();
}

async function waitForMissionComplete(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  const runButton = page.locator("button.agentic-researcher-run");
  await expect(runButton).toHaveText("Run Mission", { timeout: timeoutMs });
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

async function installLinearIntentSentinel(page: Page): Promise<void> {
  await page.evaluate(({ pluginId }) => {
    const obsidianWindow = window as typeof window & {
      app?: any;
      __e2eLinearIntentToolExposure?: Array<{
        prompt: string;
        toolNames: string[];
      }>;
      __e2eRestoreLinearIntentRegistry?: (() => void) | null;
    };
    const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
    if (!plugin?.createToolRegistry || !plugin?.settings) {
      throw new Error("Plugin tool registry API is unavailable.");
    }
    const originalCreateToolRegistry = plugin.createToolRegistry.bind(plugin);
    const originalLinearEnabled = plugin.settings.linearEnabled;
    obsidianWindow.__e2eLinearIntentToolExposure = [];
    plugin.settings.linearEnabled = true;
    plugin.createToolRegistry = function createToolRegistryWithLinearSentinel() {
      const registry = originalCreateToolRegistry();
      return new Proxy(registry, {
        get(target, property) {
          if (property === "getDefinitions") {
            return () => [
              ...target.getDefinitions(),
              {
                type: "function",
                function: {
                  name: "linear_get_issue",
                  description:
                    "E2E-only sentinel. It must stay unavailable without explicit Linear intent.",
                  parameters: {
                    type: "object",
                    properties: { issueId: { type: "string" } },
                    required: ["issueId"],
                    additionalProperties: false,
                  },
                },
              },
            ];
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    obsidianWindow.__e2eRestoreLinearIntentRegistry = () => {
      plugin.createToolRegistry = originalCreateToolRegistry;
      plugin.settings.linearEnabled = originalLinearEnabled;
      obsidianWindow.__e2eRestoreLinearIntentRegistry = null;
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

async function readLinearIntentExposures(
  page: Page,
): Promise<Array<{ prompt: string; toolNames: string[] }>> {
  return page.evaluate(() => {
    const obsidianWindow = window as typeof window & {
      __e2eLinearIntentToolExposure?: Array<{
        prompt: string;
        toolNames: string[];
      }>;
    };
    return obsidianWindow.__e2eLinearIntentToolExposure ?? [];
  });
}

async function restoreLinearIntentSentinel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const obsidianWindow = window as typeof window & {
      __e2eRestoreLinearIntentRegistry?: (() => void) | null;
    };
    obsidianWindow.__e2eRestoreLinearIntentRegistry?.();
  });
}

async function installFixedLinearPublicationClient(page: Page): Promise<void> {
  await page.evaluate(async ({ pluginId }) => {
    const obsidianWindow = window as typeof window & {
      app?: any;
      __e2eFixedLinearPublication?: any;
    };
    const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
    if (
      !plugin?.createSecretBackedLinearClient ||
      !plugin?.testLinearConnection ||
      !plugin?.settings
    ) {
      throw new Error("Production Linear integration APIs were unavailable.");
    }
    if (obsidianWindow.__e2eFixedLinearPublication) {
      throw new Error("The fixed Linear publication client is already installed.");
    }

    const linearSettingKeys = [
      "linearEnabled",
      "linearCapabilityGate",
      "linearDefaultTeamId",
      "linearQueueEnabled",
      "linearQueueProjectId",
      "linearStartedStateId",
      "linearCompletedStateId",
      "linearBlockedStateId",
    ];
    const originalSettings = Object.fromEntries(
      linearSettingKeys.map((key) => [
        key,
        {
          present: Object.prototype.hasOwnProperty.call(plugin.settings, key),
          value: plugin.settings[key],
        },
      ]),
    );
    const original = {
      createSecretBackedLinearClient: plugin.createSecretBackedLinearClient,
      linearApiKey: plugin.linearApiKey,
      persistLegacyLinearApiKey: plugin.persistLegacyLinearApiKey,
      linearCredentialReference: plugin.linearCredentialReference,
      linearCapabilitySnapshot: plugin.linearCapabilitySnapshot,
      linearIntegrationState: plugin.linearIntegrationState,
      settings: originalSettings,
    };

    plugin.linearApiKey = "e2e-session-credential-placeholder";
    plugin.persistLegacyLinearApiKey = true;
    const productionClient = original.createSecretBackedLinearClient.call(plugin);
    let LinearClientErrorConstructor: any = null;
    try {
      await productionClient.execute("__e2e_unknown_operation__", {});
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        (error as { code?: string }).code === "linear_unknown_operation"
      ) {
        LinearClientErrorConstructor = (error as { constructor: any }).constructor;
      } else {
        throw error;
      }
    }
    if (typeof LinearClientErrorConstructor !== "function") {
      throw new Error("Unable to resolve the production Linear error type.");
    }

    const state: {
      calls: Array<{
        operationKey: string;
        variables: Record<string, unknown>;
      }>;
      issue: any | null;
      records: Map<string, any>;
    } = { calls: [], issue: null, records: new Map() };
    const fetchedAt = () => new Date().toISOString();
    const pageResult = (items: any[]) => ({
      items,
      pageInfo: { hasNextPage: false },
      fetchedAt: fetchedAt(),
    });
    const fakeClient = {
      execute: async (
        operationKey: string,
        variables: Record<string, unknown> = {},
      ) => {
        state.calls.push({
          operationKey,
          variables: JSON.parse(JSON.stringify(variables)),
        });
        switch (operationKey) {
          case "connection.context":
            return {
              viewer: { id: "e2e-viewer", name: "E2E Researcher" },
              workspace: { id: "e2e-workspace", name: "E2E Workspace" },
              fetchedAt: fetchedAt(),
            };
          case "teams.list":
            return pageResult([
              {
                resourceType: "team",
                id: "e2e-team",
                name: "E2E Team",
                key: "E2E",
                snapshotHash: `sha256:${"1".repeat(64)}`,
              },
            ]);
          case "projects.list":
            return pageResult([
              {
                resourceType: "project",
                id: "e2e-project",
                name: "E2E Agentic Research",
                url: "https://linear.app/e2e/project/agentic-research",
                attributes: { teams: ["e2e-team"] },
                snapshotHash: `sha256:${"2".repeat(64)}`,
              },
              ...[...state.records.values()].filter(
                (record) => record.resourceType === "project",
              ),
            ]);
          case "workflow_states.list":
            return pageResult([
              {
                resourceType: "workflow_state",
                id: "e2e-started",
                name: "In Progress",
                type: "started",
                attributes: { team: "e2e-team" },
                snapshotHash: `sha256:${"3".repeat(64)}`,
              },
              {
                resourceType: "workflow_state",
                id: "e2e-completed",
                name: "Done",
                type: "completed",
                attributes: { team: "e2e-team" },
                snapshotHash: `sha256:${"4".repeat(64)}`,
              },
            ]);
          case "issues.search":
            return pageResult([]);
          case "initiatives.list":
            return pageResult(
              [...state.records.values()].filter(
                (record) => record.resourceType === "initiative",
              ),
            );
          case "issues.list":
            return pageResult([
              ...(state.issue ? [state.issue] : []),
              ...[...state.records.values()].filter(
                (record) => record.resourceType === "issue",
              ),
            ]);
          case "initiative_project_links.list":
            return pageResult(
              [...state.records.values()].filter(
                (record) => record.resourceType === "initiative_project_link",
              ),
            );
          case "issue_relations.list":
            return pageResult(
              [...state.records.values()].filter(
                (record) => record.resourceType === "issue_relation",
              ),
            );
          case "issues.get": {
            const requestedId = String(variables.id ?? "");
            const issue =
              state.issue?.id === requestedId
                ? state.issue
                : state.records.get(requestedId);
            if (!issue) {
              throw new LinearClientErrorConstructor(
                "linear_not_found",
                `E2E issue ${requestedId || "unknown"} was not found.`,
                { operationKey },
              );
            }
            return JSON.parse(JSON.stringify(issue));
          }
          case "initiatives.get":
          case "projects.get":
          case "initiative_project_links.get":
          case "issue_relations.get": {
            const requestedId = String(variables.id ?? "");
            const record = state.records.get(requestedId);
            if (!record) {
              throw new LinearClientErrorConstructor(
                "linear_not_found",
                `E2E hierarchy resource ${requestedId || "unknown"} was not found.`,
                { operationKey },
              );
            }
            return JSON.parse(JSON.stringify(record));
          }
          case "issues.create": {
            const candidateInput =
              variables.input && typeof variables.input === "object"
                ? variables.input as Record<string, unknown>
                : variables;
            if (
              [...state.records.values()].some(
                (record) =>
                  record.resourceType === "project" &&
                  record.id === String(candidateInput.projectId ?? ""),
              )
            ) {
              return createHierarchyRecord("issue", variables, operationKey);
            }
            if (state.issue) {
              throw new Error(
                "The E2E fixed client observed a duplicate issue create.",
              );
            }
            const input =
              variables.input && typeof variables.input === "object"
                ? (variables.input as Record<string, unknown>)
                : {};
            const id = String(input.id ?? "");
            if (!id) throw new Error("The prepared Linear create omitted its id.");
            const timestamp = fetchedAt();
            state.issue = {
              resourceType: "issue",
              id,
              identifier: "E2E-1",
              url: "https://linear.app/e2e/issue/E2E-1",
              title: String(input.title ?? ""),
              description: String(input.description ?? ""),
              priority: 0,
              trashed: false,
              labels: [],
              team: {
                id: String(input.teamId ?? ""),
                name: "E2E Team",
                key: "E2E",
              },
              state: {
                id: "e2e-started",
                name: "In Progress",
                type: "started",
              },
              project: {
                id: String(input.projectId ?? ""),
                name: "E2E Agentic Research",
              },
              createdAt: timestamp,
              updatedAt: timestamp,
              snapshotHash: `sha256:${"5".repeat(64)}`,
            };
            return {
              success: true,
              operationKey,
              operationName: "IssueCreate",
              resourceType: "issue",
              acknowledgedAt: timestamp,
            };
          }
          case "initiatives.create":
            return createHierarchyRecord("initiative", variables, operationKey);
          case "projects.create":
            return createHierarchyRecord("project", variables, operationKey);
          case "initiative_project_links.create":
            return createHierarchyRecord(
              "initiative_project_link",
              variables,
              operationKey,
            );
          case "issue_relations.create":
            return createHierarchyRecord("issue_relation", variables, operationKey);
          default:
            throw new Error(`Unexpected fixed Linear operation: ${operationKey}`);
        }

        function createHierarchyRecord(
          resourceType: string,
          rawVariables: Record<string, unknown>,
          operation: string,
        ) {
          const input =
            rawVariables.input && typeof rawVariables.input === "object"
              ? rawVariables.input as Record<string, unknown>
              : rawVariables;
          const id = String(input.id ?? rawVariables.id ?? "");
          if (!id) {
            throw new Error(`${operation} omitted its host-prepared resource id.`);
          }
          if (state.records.has(id)) {
            throw new Error(`Duplicate hierarchy mutation for ${id}.`);
          }
          const timestamp = fetchedAt();
          const snapshotHash = `sha256:${(state.records.size + 6)
            .toString(16)
            .padStart(64, "0")}`;
          const record = resourceType === "issue"
            ? {
                resourceType,
                id,
                identifier: `E2E-H${state.records.size + 1}`,
                title: String(input.title ?? ""),
                description: String(input.description ?? ""),
                url: `https://linear.app/e2e/issue/${id}`,
                priority: 0,
                trashed: false,
                labels: [],
                team: {
                  id: String(input.teamId ?? ""),
                  name: "E2E Team",
                  key: "E2E",
                },
                state: {
                  id: String(input.stateId ?? "e2e-started"),
                  name: "In Progress",
                  type: "started",
                },
                ...(typeof input.projectId === "string"
                  ? {
                      project: {
                        id: input.projectId,
                        name: "E2E Agentic Research",
                      },
                    }
                  : {}),
                createdAt: timestamp,
                updatedAt: timestamp,
                snapshotHash,
              }
            : {
                resourceType,
                id,
                name: String(input.name ?? input.title ?? resourceType),
                title: String(input.title ?? input.name ?? resourceType),
                description: String(input.description ?? ""),
                content: String(input.content ?? ""),
                url: `https://linear.app/e2e/${resourceType}/${id}`,
                createdAt: timestamp,
                updatedAt: timestamp,
                attributes: JSON.parse(JSON.stringify(input)),
                snapshotHash,
              };
          state.records.set(id, record);
          return {
            success: true,
            operationKey: operation,
            operationName: operation,
            resourceType,
            acknowledgedAt: timestamp,
          };
        }
      },
    };

    plugin.createSecretBackedLinearClient = () => fakeClient;
    plugin.settings.linearEnabled = true;
    plugin.settings.linearQueueEnabled = false;
    const connection = await plugin.testLinearConnection();
    if (!connection?.ok) {
      throw new Error(
        `Unable to configure the production Linear capability: ${String(
          connection?.message ?? "unknown error",
        )}`,
      );
    }
    if (
      plugin.settings.linearDefaultTeamId !== "e2e-team" ||
      plugin.settings.linearQueueProjectId !== "e2e-project"
    ) {
      throw new Error(
        "Connection discovery did not bind the fixed Linear destination.",
      );
    }
    obsidianWindow.__e2eFixedLinearPublication = {
      state,
      original,
      fakeClient,
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

async function readFixedLinearPublicationState(
  page: Page,
  acceptedNotePath: string,
): Promise<{
  createCalls: number;
  issueGetCalls: number;
  issue: any | null;
  checkpoint: any | null;
  hierarchyCreateCalls: number;
  hierarchyRecords: any[];
  hierarchyCheckpoint: any | null;
  missionSnapshot: any | null;
  toolFailures: Array<{
    name: string;
    code: string;
    message: string;
  }>;
  runErrors: Array<{
    id: string;
    code: string;
    message: string;
  }>;
}> {
  return page.evaluate(
    async ({ pluginId, notePath }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eFixedLinearPublication?: any;
      };
      const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
      const fixed = obsidianWindow.__e2eFixedLinearPublication;
      if (!plugin || !fixed?.state) {
        throw new Error("The fixed Linear publication client is not installed.");
      }
      const checkpoints =
        await plugin.researchPublicationCheckpointStore?.list?.();
      if (!Array.isArray(checkpoints)) {
        throw new Error(
          "The production research publication checkpoint store is unavailable.",
        );
      }
      const checkpoint =
        checkpoints.find(
          (candidate: any) => candidate?.artifact?.notePath === notePath,
          ) ?? null;
      const hierarchyNamespace =
        plugin.researchProjectHierarchyCheckpointNamespace;
      const hierarchyCheckpoints =
        hierarchyNamespace?.checkpoints &&
        typeof hierarchyNamespace.checkpoints === "object"
          ? Object.values(hierarchyNamespace.checkpoints)
          : [];
      const hierarchyCheckpoint =
        hierarchyCheckpoints.find(
          (candidate: any) =>
            candidate?.items?.some?.(
              (item: any) => item.kind === "project",
          ),
        ) ?? null;
      const bufferedEvents = (
        Array.isArray(plugin.runCoordinator?.bufferedEvents)
          ? plugin.runCoordinator.bufferedEvents
          : []
      );
      const toolFailures = bufferedEvents
        .filter((event: any) => event?.key === "onToolDone")
        .map((event: any) => event?.args?.[0])
        .filter((event: any) => event?.ok === false)
        .map((event: any) => ({
          name: String(event?.name ?? "unknown"),
          code: String(event?.error?.code ?? "unknown"),
          message: String(event?.error?.message ?? event?.message ?? ""),
        }));
      const runErrors = bufferedEvents
        .filter((event: any) => event?.key === "onTrace")
        .map((event: any) => event?.args?.[0])
        .filter((event: any) => event?.kind === "error" || event?.error)
        .map((event: any) => ({
          id: String(event?.id ?? "unknown"),
          code: String(event?.error?.code ?? "unknown"),
          message: String(event?.error?.message ?? event?.message ?? ""),
        }));
      const runSnapshot =
        typeof plugin.getMissionRunSnapshot === "function"
          ? plugin.getMissionRunSnapshot()
          : null;
      const redactedMissionSnapshot = runSnapshot
        ? {
            lastComplete: runSnapshot.lastComplete
              ? JSON.parse(JSON.stringify(runSnapshot.lastComplete))
              : null,
            diagnosticAttestations: Array.isArray(
              runSnapshot.diagnosticAttestations,
            )
              ? JSON.parse(JSON.stringify(runSnapshot.diagnosticAttestations))
              : [],
            lastMissionGraph: runSnapshot.lastMissionGraph
              ? {
                  nodes: Object.fromEntries(
                    Object.entries(runSnapshot.lastMissionGraph.nodes ?? {}).map(
                      ([id, node]: [string, any]) => [
                        id,
                        {
                          id,
                          status: node?.status,
                          allowedTools: Array.isArray(node?.allowedTools)
                            ? [...node.allowedTools]
                            : [],
                          effect: node?.effect,
                        },
                      ],
                    ),
                  ),
                }
              : null,
          }
        : null;
      return {
        createCalls: fixed.state.calls.filter(
          (call: any) => call.operationKey === "issues.create",
        ).length,
        issueGetCalls: fixed.state.calls.filter(
          (call: any) => call.operationKey === "issues.get",
        ).length,
        issue: fixed.state.issue
          ? JSON.parse(JSON.stringify(fixed.state.issue))
          : null,
        checkpoint: checkpoint
          ? JSON.parse(JSON.stringify(checkpoint))
          : null,
        hierarchyCreateCalls: fixed.state.records.size,
        hierarchyRecords: [...fixed.state.records.values()].map((record: any) =>
          JSON.parse(JSON.stringify(record)),
        ),
        hierarchyCheckpoint: hierarchyCheckpoint
          ? JSON.parse(JSON.stringify(hierarchyCheckpoint))
          : null,
        missionSnapshot: redactedMissionSnapshot,
        toolFailures,
        runErrors,
      };
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, notePath: acceptedNotePath },
  );
}

async function deleteResearchPublicationBackups(
  page: Page,
  acceptedNotePath: string,
): Promise<void> {
  await page.evaluate(
    async ({ pluginId, notePath }) => {
      const app = (window as typeof window & { app?: any }).app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      const checkpoints =
        await plugin?.researchPublicationCheckpointStore?.list?.();
      const checkpoint = Array.isArray(checkpoints)
        ? checkpoints.find(
            (candidate: any) => candidate?.artifact?.notePath === notePath,
          )
        : null;
      const backupPaths = new Set<string>();
      const collect = (value: unknown, key = "") => {
        if (
          key === "backupPath" &&
          typeof value === "string" &&
          value.startsWith(".agent-backups/")
        ) {
          backupPaths.add(value);
          return;
        }
        if (Array.isArray(value)) {
          for (const entry of value) collect(entry);
          return;
        }
        if (value && typeof value === "object") {
          for (const [childKey, child] of Object.entries(value)) {
            collect(child, childKey);
          }
        }
      };
      collect(checkpoint);
      for (const backupPath of backupPaths) {
        const file = app?.vault?.getAbstractFileByPath?.(backupPath);
        if (file) {
          await app.vault.delete(file, true);
        } else if (await app?.vault?.adapter?.exists?.(backupPath)) {
          await app.vault.adapter.remove(backupPath);
        }
      }
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID, notePath: acceptedNotePath },
  );
}

async function restoreFixedLinearPublicationClient(page: Page): Promise<void> {
  await page.evaluate(async ({ pluginId }) => {
    const obsidianWindow = window as typeof window & {
      app?: any;
      __e2eFixedLinearPublication?: any;
    };
    const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
    const fixed = obsidianWindow.__e2eFixedLinearPublication;
    if (!plugin || !fixed?.original) return;
    const original = fixed.original;
    plugin.createSecretBackedLinearClient = original.createSecretBackedLinearClient;
    plugin.linearApiKey = original.linearApiKey;
    plugin.persistLegacyLinearApiKey = original.persistLegacyLinearApiKey;
    plugin.linearCredentialReference = original.linearCredentialReference;
    plugin.linearCapabilitySnapshot = original.linearCapabilitySnapshot;
    plugin.linearIntegrationState = original.linearIntegrationState;
    for (const [key, entry] of Object.entries(original.settings) as Array<
      [string, { present: boolean; value: unknown }]
    >) {
      if (entry.present) plugin.settings[key] = entry.value;
      else delete plugin.settings[key];
    }
    obsidianWindow.__e2eFixedLinearPublication = null;
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

async function cleanupResearchPublication(
  page: Page,
  notePath: string,
): Promise<void> {
  let cleanupError: unknown = null;
  for (const cleanup of [
    () => deleteResearchPublicationBackups(page, notePath),
    () => restoreFixedLinearPublicationClient(page),
    () => deleteVaultFixture(page, notePath),
  ]) {
    await cleanup().catch((error) => {
      cleanupError ??= error;
    });
  }
  if (cleanupError) throw cleanupError;
}

async function cleanupResearchProjectHierarchy(
  page: Page,
): Promise<{ removed: number; remaining: number }> {
  return page.evaluate((pluginId) => {
    const obsidianWindow = window as typeof window & {
      app?: any;
      __e2eFixedLinearPublication?: any;
    };
    const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
    const fixed = obsidianWindow.__e2eFixedLinearPublication;
    const checkpoints = Object.values(
      plugin?.researchProjectHierarchyCheckpointNamespace?.checkpoints ?? {},
    ) as any[];
    const complete = checkpoints.find(
      (candidate) => candidate?.status === "complete",
    );
    if (!complete || !(fixed?.state?.records instanceof Map)) {
      throw new Error("The marker-owned hierarchy cleanup state is unavailable.");
    }
    let removed = 0;
    for (const item of complete.items ?? []) {
      if (fixed.state.records.delete(String(item.resourceId ?? ""))) {
        removed += 1;
      }
    }
    const remaining = fixed.state.records.size;
    if (remaining !== 0) {
      throw new Error(
        `Marker-owned hierarchy cleanup left ${remaining} resource(s).`,
      );
    }
    return { removed, remaining };
  }, NATIVE_CORE_PLUGIN_ID);
}

async function installFixedLinearQueueClient(
  page: Page,
  fixture: FixedLinearQueueFixture,
): Promise<void> {
  await page.evaluate(async ({ pluginId, fixture: input }) => {
    const obsidianWindow = window as typeof window & {
      app?: any;
      __e2eFixedLinearQueue?: any;
      __e2eLinearQueueModelCreateCalls?: number;
      __e2eLinearQueueModelPrompts?: string[];
      __e2eLinearQueueModelRequests?: Array<{
        structured: boolean;
        step: number;
        tools: string[];
        recentMessages: Array<{ role: string; content: string }>;
      }>;
    };
    const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
    if (
      !plugin?.createSecretBackedLinearClient ||
      !plugin?.testLinearConnection ||
      !plugin?.authorizeLinearQueueForFourHours ||
      !plugin?.restartLinearQueueRuntime ||
      !plugin?.stopLinearQueueRuntime
    ) {
      throw new Error("Production Linear queue runtime APIs were unavailable.");
    }
    if (obsidianWindow.__e2eFixedLinearQueue) {
      throw new Error("The fixed Linear queue client is already installed.");
    }

    const original = {
      createSecretBackedLinearClient: plugin.createSecretBackedLinearClient,
      linearApiKey: plugin.linearApiKey,
      persistLegacyLinearApiKey: plugin.persistLegacyLinearApiKey,
      linearCredentialReference: plugin.linearCredentialReference,
      settings: {
        linearEnabled: plugin.settings.linearEnabled,
        linearQueueEnabled: plugin.settings.linearQueueEnabled,
        linearCapabilityGate: plugin.settings.linearCapabilityGate,
        linearDefaultTeamId: plugin.settings.linearDefaultTeamId,
        linearQueueProjectId: plugin.settings.linearQueueProjectId,
        linearStartedStateId: plugin.settings.linearStartedStateId,
        linearCompletedStateId: plugin.settings.linearCompletedStateId,
        linearBlockedStateId: plugin.settings.linearBlockedStateId,
      },
    };

    plugin.linearApiKey = "e2e-linear-queue-session-credential";
    plugin.persistLegacyLinearApiKey = true;
    plugin.linearCredentialReference = null;
    const productionClient = original.createSecretBackedLinearClient.call(plugin);
    let LinearClientErrorConstructor: any = null;
    try {
      await productionClient.execute("__e2e_unknown_operation__", {});
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        (error as { code?: string }).code === "linear_unknown_operation"
      ) {
        LinearClientErrorConstructor = (error as { constructor: any }).constructor;
      } else {
        throw error;
      }
    }
    if (typeof LinearClientErrorConstructor !== "function") {
      throw new Error("Unable to resolve the production Linear error type.");
    }

    const baseTime = Date.now() - 120_000;
    const state: {
      calls: Array<{
        operationKey: string;
        variables: Record<string, unknown>;
      }>;
      issue: any;
      comments: Record<string, any>;
      sequence: number;
      ambiguousCompletionDispatches: number;
    } = {
      calls: [],
      comments: {},
      sequence: 1,
      ambiguousCompletionDispatches: 0,
      issue: {
        resourceType: "issue",
        id: input.issueId,
        identifier: input.issueIdentifier,
        url: input.issueUrl,
        title: `E2E trusted vault queue ${input.issueIdentifier}`,
        description: input.description,
        priority: 0,
        trashed: false,
        labels: [],
        team: { id: "e2e-team", name: "E2E Team", key: "E2E" },
        state: { id: "e2e-backlog", name: "Backlog", type: "unstarted" },
        project: { id: "e2e-project", name: "E2E Agent Queue" },
        createdAt: new Date(baseTime - 60_000).toISOString(),
        updatedAt: new Date(baseTime).toISOString(),
        snapshotHash: `sha256:${"1".repeat(64)}`,
      },
    };
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const timestamp = () =>
      new Date(baseTime + ++state.sequence * 1_000).toISOString();
    const snapshotHash = () =>
      `sha256:${state.sequence.toString(16).padStart(64, "0")}`;
    const pageResult = (items: any[]) => ({
      items: clone(items),
      pageInfo: { hasNextPage: false },
      fetchedAt: new Date().toISOString(),
    });
    const notFound = (resource: string, id: string, operationKey: string) =>
      new LinearClientErrorConstructor(
        "linear_not_found",
        `E2E ${resource} ${id || "unknown"} was not found.`,
        { operationKey },
      );
    const mutationAck = (operationKey: string, resourceType: string) => ({
      success: true,
      operationKey,
      operationName: operationKey,
      resourceType,
      acknowledgedAt: new Date().toISOString(),
    });

    const fakeClient = {
      execute: async (
        operationKey: string,
        variables: Record<string, unknown> = {},
      ) => {
        state.calls.push({ operationKey, variables: clone(variables) });
        switch (operationKey) {
          case "connection.context":
            return {
              viewer: { id: "e2e-viewer", name: "E2E Queue Agent" },
              workspace: { id: "e2e-workspace", name: "E2E Workspace" },
              fetchedAt: new Date().toISOString(),
            };
          case "teams.list":
            return pageResult([
              {
                resourceType: "team",
                id: "e2e-team",
                name: "E2E Team",
                key: "E2E",
                snapshotHash: `sha256:${"2".repeat(64)}`,
              },
            ]);
          case "projects.list":
            return pageResult([
              {
                resourceType: "project",
                id: "e2e-project",
                name: "E2E Agent Queue",
                url: "https://linear.app/e2e/project/agent-queue",
                attributes: { teams: ["e2e-team"] },
                snapshotHash: `sha256:${"3".repeat(64)}`,
              },
            ]);
          case "workflow_states.list":
            return pageResult([
              {
                resourceType: "workflow_state",
                id: "e2e-backlog",
                name: "Backlog",
                type: "unstarted",
                attributes: { team: "e2e-team" },
                snapshotHash: `sha256:${"4".repeat(64)}`,
              },
              {
                resourceType: "workflow_state",
                id: "e2e-started",
                name: "In Progress",
                type: "started",
                attributes: { team: "e2e-team" },
                snapshotHash: `sha256:${"5".repeat(64)}`,
              },
              {
                resourceType: "workflow_state",
                id: "e2e-completed",
                name: "Done",
                type: "completed",
                attributes: { team: "e2e-team" },
                snapshotHash: `sha256:${"6".repeat(64)}`,
              },
            ]);
          case "issues.list":
            return pageResult([state.issue]);
          case "issues.get": {
            const id = String(variables.id ?? "");
            if (id !== state.issue.id) throw notFound("issue", id, operationKey);
            return clone(state.issue);
          }
          case "comments.get": {
            const id = String(variables.id ?? "");
            const comment = state.comments[id];
            if (!comment) throw notFound("comment", id, operationKey);
            return clone(comment);
          }
          case "comments.create": {
            const mutationInput =
              variables.input && typeof variables.input === "object"
                ? (variables.input as Record<string, unknown>)
                : {};
            const id = String(mutationInput.id ?? "");
            const issueId = String(mutationInput.issueId ?? "");
            const body = String(mutationInput.body ?? "");
            if (!id || issueId !== state.issue.id || !body) {
              throw new Error(
                "The E2E comment mutation escaped its issue or omitted content.",
              );
            }
            if (state.comments[id]) {
              throw new Error(
                "The E2E fixed client observed a duplicate comment create.",
              );
            }
            const at = timestamp();
            state.comments[id] = {
              resourceType: "comment",
              id,
              body,
              issue: { id: state.issue.id, identifier: state.issue.identifier },
              user: { id: "e2e-viewer", name: "E2E Queue Agent" },
              createdAt: at,
              updatedAt: at,
              snapshotHash: snapshotHash(),
            };
            return mutationAck(operationKey, "comment");
          }
          case "issues.update": {
            const id = String(variables.id ?? "");
            const mutationInput =
              variables.input && typeof variables.input === "object"
                ? (variables.input as Record<string, unknown>)
                : {};
            const stateId = String(mutationInput.stateId ?? "");
            if (id !== state.issue.id) throw notFound("issue", id, operationKey);
            const nextState =
              stateId === "e2e-started"
                ? { id: "e2e-started", name: "In Progress", type: "started" }
                : stateId === "e2e-completed"
                  ? { id: "e2e-completed", name: "Done", type: "completed" }
                  : null;
            if (!nextState) {
              throw new Error(`Unexpected E2E workflow state: ${stateId}`);
            }
            const at = timestamp();
            state.issue.state = nextState;
            state.issue.updatedAt = at;
            state.issue.snapshotHash = snapshotHash();
            if (stateId === "e2e-completed") {
              state.issue.completedAt = at;
              if (state.ambiguousCompletionDispatches === 0) {
                state.ambiguousCompletionDispatches += 1;
                throw new Error(
                  "E2E timeout after Linear applied the completed-state mutation.",
                );
              }
            }
            return mutationAck(operationKey, "issue");
          }
          default:
            throw new Error(
              `Unexpected fixed Linear queue operation: ${operationKey}`,
            );
        }
      },
    };

    plugin.createSecretBackedLinearClient = () => fakeClient;
    plugin.settings.linearEnabled = true;
    plugin.settings.linearQueueEnabled = false;
    plugin.settings.linearDefaultTeamId = "";
    plugin.settings.linearQueueProjectId = "";
    plugin.settings.linearStartedStateId = "";
    plugin.settings.linearCompletedStateId = "";
    plugin.settings.linearBlockedStateId = "";
    obsidianWindow.__e2eLinearQueueModelCreateCalls = 0;
    obsidianWindow.__e2eLinearQueueModelPrompts = [];
    obsidianWindow.__e2eLinearQueueModelRequests = [];
    const connection = await plugin.testLinearConnection();
    if (!connection?.ok) {
      throw new Error(
        `Unable to configure the production Linear queue: ${String(
          connection?.message ?? "unknown error",
        )}`,
      );
    }
    if (
      plugin.settings.linearDefaultTeamId !== "e2e-team" ||
      plugin.settings.linearQueueProjectId !== "e2e-project" ||
      plugin.settings.linearStartedStateId !== "e2e-started" ||
      plugin.settings.linearCompletedStateId !== "e2e-completed"
    ) {
      throw new Error(
        "Connection discovery did not bind the fixed queue lifecycle.",
      );
    }
    await plugin.restartLinearQueueRuntime(false);
    obsidianWindow.__e2eFixedLinearQueue = {
      state,
      original,
      workItemFingerprint: input.workItemFingerprint,
    };
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, fixture });
}

async function authorizeAndRunFixedLinearQueue(
  page: Page,
): Promise<{ ok: boolean; message: string }> {
  return page.evaluate(async ({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    if (!plugin?.authorizeLinearQueueForFourHours) {
      throw new Error("Production Linear queue authorization is unavailable.");
    }
    plugin.settings.linearQueueEnabled = true;
    return plugin.authorizeLinearQueueForFourHours();
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

async function waitForFixedLinearQueueReconciliationState(
  page: Page,
  issueId: string,
): Promise<FixedLinearQueueSnapshot> {
  const deadlineAt = Date.now() + 150_000;
  while (Date.now() < deadlineAt) {
    const state = await readFixedLinearQueueState(page, issueId);
    if (state.pendingStages.includes("completed_state")) return state;
    const status = state.candidate?.status;
    if (status === "blocked" || status === "failed" || status === "completed") {
      throw new Error(
        `Queue candidate reached ${status} before completed-state reconciliation: ${state.candidate?.lastError ?? "no durable error"}; modelCreateCalls=${state.modelCreateCalls}; modelRequests=${JSON.stringify(state.modelRequests)}`,
      );
    }
    if (state.pendingStages.length > 0) {
      throw new Error(
        `Queue candidate required unexpected reconciliation at ${state.pendingStages.join(", ")}.`,
      );
    }
    await page.waitForTimeout(250);
  }
  const state = await readFixedLinearQueueState(page, issueId);
  throw new Error(
    `Timed out waiting for completed-state reconciliation; status=${state.candidate?.status ?? "missing"}; error=${state.candidate?.lastError ?? "none"}.`,
  );
}

async function restartFixedLinearQueueForReconciliation(
  page: Page,
): Promise<void> {
  await page.evaluate(async ({ pluginId }) => {
    const plugin = (window as typeof window & { app?: any }).app?.plugins
      ?.plugins?.[pluginId];
    if (!plugin?.stopLinearQueueRuntime || !plugin?.restartLinearQueueRuntime) {
      throw new Error("Production Linear queue restart APIs are unavailable.");
    }
    await plugin.stopLinearQueueRuntime();
    await plugin.restartLinearQueueRuntime(true);
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

async function readFixedLinearQueueState(
  page: Page,
  issueId: string,
): Promise<FixedLinearQueueSnapshot> {
  return page.evaluate(({ pluginId, issueId: expectedIssueId }) => {
    const obsidianWindow = window as typeof window & {
      app?: any;
      __e2eFixedLinearQueue?: any;
      __e2eLinearQueueModelCreateCalls?: number;
      __e2eLinearQueueModelPrompts?: string[];
      __e2eLinearQueueModelRequests?: Array<{
        structured: boolean;
        step: number;
        tools: string[];
        recentMessages: Array<{ role: string; content: string }>;
      }>;
    };
    const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
    const fixed = obsidianWindow.__e2eFixedLinearQueue;
    if (!plugin || !fixed?.state) {
      throw new Error("The fixed Linear queue client is not installed.");
    }
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const pending = Object.values(
      plugin.pendingLinearReconciliationState?.pendingByActionId ?? {},
    ) as Array<{ queueStage?: string; issueId?: string }>;
    return clone({
      calls: fixed.state.calls,
      issue: fixed.state.issue,
      comments: Object.values(fixed.state.comments).sort(
        (left: any, right: any) =>
          String(left.createdAt).localeCompare(String(right.createdAt)),
      ),
      candidate: plugin.linearQueueState?.candidates?.[expectedIssueId] ?? null,
      pendingStages: pending
        .filter((entry) => entry.issueId === expectedIssueId)
        .map((entry) => String(entry.queueStage))
        .sort(),
      resourceLockKeys: Object.keys(
        plugin.queueResourceLockState?.locks ?? {},
      ).sort(),
      receipts: plugin.getExternalActionReceipts?.() ?? [],
      queueGrantScopes: (plugin.authorityGrantStoreState?.grants ?? []).filter(
        (grant: any) => grant?.subject?.type === "schedule",
      ),
      modelCreateCalls: obsidianWindow.__e2eLinearQueueModelCreateCalls ?? 0,
      modelPrompts: obsidianWindow.__e2eLinearQueueModelPrompts ?? [],
      modelRequests: obsidianWindow.__e2eLinearQueueModelRequests ?? [],
    });
  }, { pluginId: NATIVE_CORE_PLUGIN_ID, issueId });
}

async function stopFixedLinearQueueClient(page: Page): Promise<void> {
  await page.evaluate(async ({ pluginId }) => {
    const obsidianWindow = window as typeof window & {
      app?: any;
      __e2eFixedLinearQueue?: any;
      __e2eLinearQueueModelCreateCalls?: number;
      __e2eLinearQueueModelPrompts?: string[];
      __e2eLinearQueueModelRequests?: unknown[];
    };
    const plugin = obsidianWindow.app?.plugins?.plugins?.[pluginId];
    const fixed = obsidianWindow.__e2eFixedLinearQueue;
    if (!plugin || !fixed?.original) return;
    await plugin.stopLinearQueueRuntime?.();
    plugin.createSecretBackedLinearClient =
      fixed.original.createSecretBackedLinearClient;
    plugin.linearApiKey = fixed.original.linearApiKey;
    plugin.persistLegacyLinearApiKey = fixed.original.persistLegacyLinearApiKey;
    plugin.linearCredentialReference = fixed.original.linearCredentialReference;
    for (const [key, value] of Object.entries(fixed.original.settings)) {
      plugin.settings[key] = value;
    }
    obsidianWindow.__e2eFixedLinearQueue = null;
    obsidianWindow.__e2eLinearQueueModelCreateCalls = 0;
    obsidianWindow.__e2eLinearQueueModelPrompts = [];
    obsidianWindow.__e2eLinearQueueModelRequests = [];
  }, { pluginId: NATIVE_CORE_PLUGIN_ID });
}

async function deleteVaultFixture(page: Page, targetPath: string): Promise<void> {
  await page.evaluate(async ({ targetPath: requestedPath }) => {
    const app = (window as typeof window & { app?: any }).app;
    const target = app?.vault?.getAbstractFileByPath?.(requestedPath);
    if (target) await app.vault.delete(target, true);
    const folderPath = requestedPath.slice(0, requestedPath.lastIndexOf("/"));
    const folder = app?.vault?.getAbstractFileByPath?.(folderPath);
    if (folder && Array.isArray(folder.children) && folder.children.length === 0) {
      await app.vault.delete(folder, true);
    }
  }, { targetPath });
}
