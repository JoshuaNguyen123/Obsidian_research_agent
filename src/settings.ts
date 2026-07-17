import { App, PluginSettingTab, Setting } from "obsidian";
import type AgenticResearcherPlugin from "../main";
import type { ExtensionSettingFieldProjectionV1 } from "./extensions/extensionHealthProjection";
import type { ModelProvider } from "./model/types";
import { MAX_AGENT_STEPS, MAX_CODE_RUNS_PER_MISSION } from "./tools/constants";
import {
  normalizeScheduledMissions,
  type ScheduledMission,
} from "./agent/missionScheduler";
import type { ModelRouterMode } from "./agent/missionRouter";
import { normalizeModelRouterMode } from "./agent/missionRouter";
import { runDependencyPreflight } from "./agent/dependencyPreflight";
import type { MissionDependencyStatus } from "./agent/missionLedger";
import {
  applyMemoryModeDefaults,
  applyRecommendedAutomaticDefaults,
  applyWorkingModeDefaults,
} from "./agent/settingsNormalize";
import type {
  MemoryModeSetting,
  NormalizableAgentSettings,
  WorkingModeSetting,
} from "./agent/settingsNormalize";
import {
  capabilitySetupLabel,
  type CapabilitySetupTarget,
} from "./agent/capabilitySetup";

export type ThinkingMode = "auto" | "off" | "low" | "medium" | "high" | "max";
export type StreamWritebackMode = "off" | "all_current_note_content_writes";
export type BrowserMissionMode = "supervised" | "extract_only";
export type AutonomyProfile = "automatic" | "conservative" | "custom";
export type OutputProfile =
  | "active_or_new_note"
  | "active_note_only"
  | "chat_first";
export type { ModelRouterMode };

export interface AgentSettings {
  /** Settings schema version for profile migration. */
  settingsSchemaVersion?: number;
  /** Canonical normal-user behavior profile. Legacy autonomy/output fields are derived. */
  workingMode?: WorkingModeSetting;
  /** Canonical memory consent profile. Legacy memory booleans are derived. */
  memoryMode?: MemoryModeSetting;
  /** High-level autonomy profile; Custom preserves legacy per-feature flags. */
  autonomyProfile?: AutonomyProfile;
  /** Default note vs chat output behavior for content-producing missions. */
  outputProfile?: OutputProfile;
  modelProvider: ModelProvider;
  ollamaApiKey: string;
  ollamaBaseUrl: string;
  openAiCompatibleApiKey: string;
  openAiCompatibleBaseUrl: string;
  model: string;
  utilityModel?: string;
  utilityModelProvider?: ModelProvider;
  /** @deprecated Prefer modelRouterMode. true maps to shadow. */
  modelRouterEnabled?: boolean;
  /** Automatic uses authority; Conservative uses off; Custom may choose any mode. */
  modelRouterMode?: ModelRouterMode;
  enableStreaming: boolean;
  requestTimeoutMs: number;
  maxAgentSteps: number;
  maxRunMinutes?: number | null;
  autoContinueLongRuns?: boolean;
  maxLongRunSegments?: number;
  /** Soft multi-segment loops until acceptance + proof debt clear (default on). */
  completionDrivenLoops?: boolean;
  /** Max soft 100-step segments when completionDrivenLoops is on (clamped 4–48). */
  maxCompletionSegments?: number;
  overnightRunsEnabled?: boolean;
  overnightRunHours?: number;
  overnightMaxSegments?: number;
  autoResumeOvernightRuns?: boolean;
  keepAwakeDuringOvernightRuns?: boolean;
  /** Opt-in Lead + Worker orchestration and Orchestrator tab. */
  orchestratorPreviewEnabled?: boolean;
  /** Lead + Worker team runtime. Defaults on; migrate from orchestratorPreviewEnabled. */
  orchestratorEnabled?: boolean;
  /** Permit guarded fast-forward promotion after isolated integration is green. */
  orchestratorAutoMergeGreen?: boolean;
  orchestratorWorkerMaxSteps?: number;
  orchestratorWorkerMaxToolCalls?: number;
  orchestratorWorkerMaxMinutes?: number;
  /** After note writeback, auto-rename Untitled/generic notes from H1/mission. */
  autoTitleOnWrite?: boolean;
  /** Cap run_code_block executions per mission (defaults to MAX_CODE_RUNS_PER_MISSION). */
  maxCodeRunsPerMission?: number;
  thinkingMode: ThinkingMode;
  streamWritebackMode: StreamWritebackMode;
  templateFolder: string;
  templateOutputFolder: string;
  researchMemoryEnabled: boolean;
  researchMemoryFolder: string;
  companionBaseUrl: string;
  browserToolsEnabled: boolean;
  experienceMemoryEnabled: boolean;
  defaultBrowserMissionMode: BrowserMissionMode;
  agenticReflexEnabled: boolean;
  agenticReflexDiagnosticsEnabled: boolean;
  semanticSearchEnabled: boolean;
  semanticEmbeddingModel: string;
  semanticEmbeddingDim: 256 | 512;
  semanticChunkMinTokens: number;
  semanticChunkTargetTokens: number;
  semanticChunkMaxTokens: number;
  semanticChunkOverlapTokens: number;
  semanticPythonCommand: string;
  semanticModelCacheDir: string;
  semanticIndexEnabled: boolean;
  semanticIndexFolder: string;
  semanticIndexDebounceMs: number;
  semanticIndexMaxFiles: number;
  semanticIndexPersistVectors: boolean;
  temperature: number | null;
  topK: number | null;
  topP: number | null;
  numCtx: number | null;
  /** Fixed-operation Linear integration. Credentials are plugin-owned state. */
  linearEnabled?: boolean;
  /** Non-secret client id from the user's configured Linear OAuth application. */
  linearOAuthClientId?: string;
  /** Stable loopback port registered in the Linear OAuth application. */
  linearOAuthCallbackPort?: number;
  /** Linear-issued OAuth actor identity; app actor requires persistent secure storage. */
  linearOAuthActor?: "user" | "app";
  /** @deprecated Derived from the verified connection-discovery snapshot. */
  linearCapabilityGate?: 0 | 1 | 2 | 3 | 4 | 5;
  linearDefaultTeamId?: string;
  linearQueueEnabled?: boolean;
  linearQueueProjectId?: string;
  linearStartedStateId?: string;
  linearCompletedStateId?: string;
  linearBlockedStateId?: string;
  /** Intentionally fixed at 15 minutes for the local-first polling release. */
  linearScanIntervalMinutes?: 15;
  /** Fixed-catalog GitHub integration; credentials are plugin-owned state. */
  githubEnabled?: boolean;
  /** Non-secret OAuth application client ID used for device authorization. */
  githubOAuthClientId?: string;
  scheduledMissions?: ScheduledMission[];
}

export const DEFAULT_SETTINGS: AgentSettings = {
  settingsSchemaVersion: 4,
  workingMode: "automatic",
  memoryMode: "research",
  autonomyProfile: "automatic",
  outputProfile: "active_or_new_note",
  modelProvider: "ollama",
  ollamaApiKey: "",
  ollamaBaseUrl: "https://ollama.com/api",
  openAiCompatibleApiKey: "",
  openAiCompatibleBaseUrl: "https://api.openai.com/v1",
  model: "gpt-oss:120b-cloud",
  utilityModel: "",
  utilityModelProvider: "ollama",
  modelRouterEnabled: true,
  modelRouterMode: "authority",
  enableStreaming: true,
  requestTimeoutMs: 180000,
  maxAgentSteps: MAX_AGENT_STEPS,
  maxRunMinutes: null,
  autoContinueLongRuns: true,
  maxLongRunSegments: 4,
  completionDrivenLoops: true,
  maxCompletionSegments: 24,
  overnightRunsEnabled: true,
  overnightRunHours: 10,
  overnightMaxSegments: 24,
  autoResumeOvernightRuns: true,
  keepAwakeDuringOvernightRuns: false,
  orchestratorPreviewEnabled: true,
  orchestratorEnabled: true,
  orchestratorAutoMergeGreen: true,
  orchestratorWorkerMaxSteps: 20,
  orchestratorWorkerMaxToolCalls: 24,
  orchestratorWorkerMaxMinutes: 15,
  autoTitleOnWrite: true,
  maxCodeRunsPerMission: undefined,
  thinkingMode: "auto",
  streamWritebackMode: "all_current_note_content_writes",
  templateFolder: "Templates",
  templateOutputFolder: "",
  researchMemoryEnabled: true,
  researchMemoryFolder: "Agent Research Memory",
  companionBaseUrl: "http://127.0.0.1:8765",
  browserToolsEnabled: false,
  experienceMemoryEnabled: false,
  defaultBrowserMissionMode: "supervised",
  agenticReflexEnabled: true,
  agenticReflexDiagnosticsEnabled: true,
  semanticSearchEnabled: true,
  semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
  semanticEmbeddingDim: 512,
  semanticChunkMinTokens: 300,
  semanticChunkTargetTokens: 500,
  semanticChunkMaxTokens: 700,
  semanticChunkOverlapTokens: 80,
  semanticPythonCommand: "",
  semanticModelCacheDir: "",
  semanticIndexEnabled: true,
  semanticIndexFolder: "Agent Memory",
  semanticIndexDebounceMs: 3000,
  semanticIndexMaxFiles: 10000,
  semanticIndexPersistVectors: true,
  temperature: null,
  topK: null,
  topP: null,
  numCtx: null,
  linearEnabled: false,
  linearOAuthClientId: "",
  linearOAuthCallbackPort: 43119,
  linearOAuthActor: "user",
  linearCapabilityGate: 0,
  linearDefaultTeamId: "",
  linearQueueEnabled: false,
  linearQueueProjectId: "",
  linearStartedStateId: "",
  linearCompletedStateId: "",
  linearBlockedStateId: "",
  linearScanIntervalMinutes: 15,
  githubEnabled: false,
  githubOAuthClientId: "",
  scheduledMissions: [],
};

export class AgentSettingTab extends PluginSettingTab {
  private readonly plugin: AgenticResearcherPlugin;
  private extensionContributionsEl: HTMLDetailsElement | null = null;
  private pendingFocusTarget: CapabilitySetupTarget | null = null;
  private readinessRefreshTimer: number | null = null;
  private readinessSignature = "";

  constructor(app: App, plugin: AgenticResearcherPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.stopReadinessRefresh();
    const { containerEl } = this;
    containerEl.empty();
    this.extensionContributionsEl = null;
    containerEl.addClass("agentic-researcher-settings");

    containerEl.createEl("h2", { text: "Agentic Researcher" });
    containerEl.createEl("p", {
      text: "Native right-side co-researcher for Obsidian. Basic settings stay compact; tuning lives under Advanced. Vault work requires Obsidian; an installed, healthy Companion may continue only already-authorized non-vault operations.",
      cls: "setting-item-description agentic-settings-intro",
    });

    this.renderPendingMissionSetup(containerEl);

    this.renderBasicSection(containerEl);
    this.renderCapabilityStatus(containerEl);
    this.renderAdvancedSections(containerEl);
    this.applyPendingFocus();
    this.startReadinessRefresh();
  }

  hide(): void {
    this.stopReadinessRefresh();
  }

  focusCapability(target: CapabilitySetupTarget): void {
    this.pendingFocusTarget = target;
    this.display();
  }

  private renderPendingMissionSetup(containerEl: HTMLElement): void {
    const pending = this.plugin.getPendingCapabilityResume();
    if (!pending) return;

    const panel = containerEl.createDiv({
      cls: "agentic-settings-pending-resume agentic-settings-panel",
    });
    panel.createEl("h3", { text: `Set up ${capabilitySetupLabel(pending.target)}` });
    panel.createEl("p", {
      text: `${pending.reason} Your unfinished mission is preserved and will resume only when you choose it.`,
      cls: "setting-item-description",
    });
    const controls = panel.createDiv({ cls: "agentic-settings-pending-resume-controls" });
    const resume = controls.createEl("button", {
      text: "Resume blocked mission",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    resume.addEventListener("click", () => {
      void this.plugin.resumePendingCapabilityMission();
    });
    const cancel = controls.createEl("button", {
      text: "Cancel",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => {
      this.plugin.clearPendingCapabilityResume();
      this.display();
    });
  }

  private applyPendingFocus(): void {
    const target = this.pendingFocusTarget;
    this.pendingFocusTarget = null;
    if (!target) return;
    const targetId = capabilitySetupTargetId(target);
    const element = this.containerEl.querySelector<HTMLElement>(`#${targetId}`);
    if (!element) return;
    if (element instanceof HTMLDetailsElement) element.open = true;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  private renderBasicSection(containerEl: HTMLElement): void {
    const basicEl = containerEl.createDiv({
      cls: "agentic-settings-basic agentic-settings-panel",
      attr: { id: "agentic-settings-essentials" },
    });
    basicEl.createEl("h3", { text: "Essentials" });
    basicEl.createEl("p", {
      text: "Choose the model and the default way Agentic Researcher works. Everything else can stay collapsed.",
      cls: "setting-item-description agentic-settings-section-intro",
    });

    const provider = this.plugin.settings.modelProvider;

    new Setting(basicEl)
      .setName("Model provider")
      .setDesc(
        "Provider adapter for chat, tool calling, and streaming. The agent loop stays provider-agnostic.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ollama", "Ollama-compatible")
          .addOption("openai_compatible", "GPT/OpenAI-compatible")
          .setValue(provider)
          .onChange(async (value) => {
            this.plugin.settings.modelProvider = isModelProvider(value)
              ? value
              : DEFAULT_SETTINGS.modelProvider;
            this.plugin.invalidateModelConnectionStatus();
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (provider === "openai_compatible") {
      new Setting(basicEl)
        .setName("GPT/OpenAI-compatible API key")
        .setDesc(
          "Bearer token for OpenAI Chat Completions or an OpenAI-compatible gateway.",
        )
        .addText((text) => {
          text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.openAiCompatibleApiKey)
            .onChange(async (value) => {
              this.plugin.settings.openAiCompatibleApiKey = value.trim();
              this.plugin.invalidateModelConnectionStatus();
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
        });
    } else {
      new Setting(basicEl)
        .setName("Ollama API key")
        .setDesc(
          "Used for Ollama Cloud or any Ollama-compatible endpoint that requires a bearer token.",
        )
        .addText((text) => {
          text
            .setPlaceholder("ollama_...")
            .setValue(this.plugin.settings.ollamaApiKey)
            .onChange(async (value) => {
              this.plugin.settings.ollamaApiKey = value.trim();
              this.plugin.invalidateModelConnectionStatus();
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
        });
    }

    new Setting(basicEl)
      .setName("Model")
      .setDesc("Default model for agent missions.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.model)
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
            this.plugin.invalidateModelConnectionStatus();
            await this.plugin.saveSettings();
          }),
      );

    const endpointDetails = basicEl.createEl("details", {
      cls: "agentic-settings-disclosure",
    });
    endpointDetails.createEl("summary", { text: "Custom endpoint" });
    if (provider === "openai_compatible") {
      new Setting(endpointDetails)
        .setName("GPT/OpenAI-compatible base URL")
        .setDesc("Base URL ending at /v1 for Chat Completions-compatible APIs.")
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_SETTINGS.openAiCompatibleBaseUrl)
            .setValue(this.plugin.settings.openAiCompatibleBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.openAiCompatibleBaseUrl =
                normalizeProviderBaseUrl(value) ??
                DEFAULT_SETTINGS.openAiCompatibleBaseUrl;
              this.plugin.invalidateModelConnectionStatus();
              await this.plugin.saveSettings();
            }),
        );
    } else {
      new Setting(endpointDetails)
        .setName("Ollama base URL")
        .setDesc("Base URL for the Ollama-compatible /chat API.")
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_SETTINGS.ollamaBaseUrl)
            .setValue(this.plugin.settings.ollamaBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.ollamaBaseUrl =
                value.trim() || DEFAULT_SETTINGS.ollamaBaseUrl;
              this.plugin.invalidateModelConnectionStatus();
              await this.plugin.saveSettings();
            }),
        );
    }

    this.renderConnectionStatusRow(basicEl);

    const workingModeSetting = new Setting(basicEl)
      .setName("Working mode")
      .setDesc(
        "Automatic is note-first and agentic; Chat only keeps ordinary answers in chat; Custom exposes expert overrides under Advanced.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("automatic", "Automatic (recommended)")
          .addOption("chat_only", "Chat only")
          .addOption("custom", "Custom")
          .setValue(this.plugin.settings.workingMode ?? "automatic")
          .onChange(async (value) => {
            await this.applyWorkingModeChange(value);
          }),
      );
    workingModeSetting.addButton((button) =>
      button
        .setButtonText("Reset Automatic")
        .setTooltip("Restore safe Automatic defaults without clearing credentials or memory consent.")
        .onClick(async () => {
          Object.assign(
            this.plugin.settings,
            applyRecommendedAutomaticDefaults(
              this.plugin.settings as NormalizableAgentSettings,
            ),
          );
          await this.plugin.saveSettings();
          this.display();
        }),
    );

    new Setting(basicEl)
      .setName("Memory consent")
      .setDesc(
        "Choose durable local memory. Research memory is stored as Markdown; Clear chat never removes it.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("off", "Off")
          .addOption("research", "Research memory only")
          .addOption(
            "research_and_experience",
            "Research + experience memory",
          )
          .setValue(this.plugin.settings.memoryMode ?? "research")
          .onChange(async (value) => {
            await this.applyMemoryModeChange(value);
          }),
      );
  }

  private renderConnectionStatusRow(containerEl: HTMLElement): void {
    const rows = buildSettingsDependencyRows(this.plugin.settings);
    const preflight = runDependencyPreflight(rows);
    const live = this.plugin.getModelConnectionStatus();
    const summary = rows
      .map((row) => `${formatDependencyRowName(row)} — ${row.summary}`)
      .join(" ");

    const setting = new Setting(containerEl)
      .setName("Connection status")
      .setDesc(
        `${live.message} Configuration preflight: ${preflight.status}. ${summary}`,
      );
    setting.settingEl.addClass("agentic-settings-model-connection");
    setting.addButton((button) =>
      button
        .setButtonText(live.status === "testing" ? "Testing..." : "Test connection")
        .setDisabled(live.status === "testing")
        .onClick(async () => {
          const pending = this.plugin.testModelConnection();
          this.display();
          await pending;
          this.display();
        }),
    );
  }

  private renderCapabilityStatus(containerEl: HTMLElement): void {
    const statusEl = containerEl.createDiv({
      cls: "agentic-settings-readiness agentic-settings-panel",
    });
    this.renderCapabilityStatusContents(statusEl);
  }

  private renderCapabilityStatusContents(statusEl: HTMLElement): void {
    const rows = buildCapabilityStatusRows(this.plugin);
    this.readinessSignature = JSON.stringify(rows);
    statusEl.empty();
    const readyCount = rows.filter((row) => row.status === "Ready").length;
    const header = statusEl.createDiv({
      cls: "agentic-settings-readiness-header",
    });
    const headerCopy = header.createDiv();
    headerCopy.createEl("h3", { text: "System readiness" });
    headerCopy.createEl("p", {
      text: "Open a status to jump directly to its controls.",
      cls: "setting-item-description agentic-settings-section-intro",
    });
    header.createEl("span", {
      text: `${readyCount}/${rows.length} ready`,
      cls: "agentic-settings-readiness-count",
    });

    const grid = statusEl.createDiv({ cls: "agentic-settings-readiness-grid" });
    for (const row of rows) {
      const targetId = capabilitySettingsTargetId(row.name);
      const item = grid.createEl("button", {
        cls: "agentic-settings-readiness-item",
        attr: {
          type: "button",
          "data-status": capabilityStatusSlug(row.status),
          "aria-label": `${row.name}: ${row.status}. Open settings.`,
        },
      });
      const itemHeader = item.createDiv({
        cls: "agentic-settings-readiness-item-header",
      });
      itemHeader.createEl("span", {
        text: row.name,
        cls: "agentic-settings-readiness-name",
      });
      itemHeader.createEl("span", {
        text: row.status,
        cls: `agentic-settings-status-badge is-${capabilityStatusSlug(row.status)}`,
      });
      item.createEl("span", {
        text: row.detail,
        cls: "agentic-settings-readiness-detail",
      });
      item.createEl("span", {
        text: capabilityPrimaryAction(row.name, row.status),
        cls: "agentic-settings-readiness-action",
      });
      item.addEventListener("click", () => {
        const target = this.containerEl.querySelector<HTMLDetailsElement>(
          `#${targetId}`,
        );
        if (!target) return;
        target.open = true;
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  private startReadinessRefresh(): void {
    this.readinessRefreshTimer = window.setInterval(() => {
      const rows = buildCapabilityStatusRows(this.plugin);
      const signature = JSON.stringify(rows);
      if (signature === this.readinessSignature) return;
      const statusEl = this.containerEl.querySelector<HTMLElement>(
        ".agentic-settings-readiness",
      );
      if (statusEl) this.renderCapabilityStatusContents(statusEl);
    }, 1_000);
  }

  private stopReadinessRefresh(): void {
    if (this.readinessRefreshTimer === null) return;
    window.clearInterval(this.readinessRefreshTimer);
    this.readinessRefreshTimer = null;
  }

  private redisplayWithAdvancedSectionOpen(sectionId: string): void {
    this.display();
    const section = this.containerEl.querySelector<HTMLDetailsElement>(
      `#${sectionId}`,
    );
    if (section) section.open = true;
  }

  refreshConnectionStatus(): void {
    this.redisplayWithAdvancedSectionOpen("agentic-settings-connections");
  }

  private renderAdvancedSections(containerEl: HTMLElement): void {
    const advancedRoot = containerEl.createDiv({
      cls: "agentic-settings-advanced agentic-settings-panel",
    });
    advancedRoot.createEl("h3", { text: "Advanced controls" });
    advancedRoot.createEl("p", {
      text: "Power-user controls are grouped by job. Readiness stays visible while the details remain out of the way.",
      cls: "setting-item-description agentic-settings-section-intro",
    });

    const accordion = advancedRoot.createDiv({
      cls: "agentic-settings-accordion",
    });
    this.renderAdvancedModelRouting(accordion);
    this.renderAdvancedOutputOverrides(accordion);
    this.renderAdvancedAutonomyBudgets(accordion);
    this.renderAdvancedSemantic(accordion);
    this.renderAdvancedBrowserIntegrations(accordion);
    this.renderAdvancedExtensionContributions(accordion);
    this.renderAdvancedDiagnostics(accordion);
  }

  private createAdvancedDetails(
    parent: HTMLElement,
    id: string,
    title: string,
    description: string,
    capabilityNames: string[] = [],
  ): HTMLDetailsElement {
    const details = parent.createEl("details", {
      cls: "agentic-settings-advanced-section",
      attr: { id },
    });
    const summary = details.createEl("summary");
    const summaryContent = summary.createSpan({
      cls: "agentic-settings-advanced-summary",
    });
    const copy = summaryContent.createSpan({
      cls: "agentic-settings-advanced-summary-copy",
    });
    copy.createSpan({
      text: title,
      cls: "agentic-settings-advanced-title",
    });
    copy.createSpan({
      text: description,
      cls: "agentic-settings-advanced-description",
    });
    const statuses = buildCapabilityStatusRows(this.plugin).filter((row) =>
      capabilityNames.includes(row.name),
    );
    if (statuses.length > 0) {
      const statusGroup = summaryContent.createSpan({
        cls: "agentic-settings-advanced-statuses",
      });
      for (const status of statuses) {
        statusGroup.createSpan({
          text: `${capabilityStatusShortName(status.name)} · ${status.status}`,
          title: `${status.name}: ${status.detail}`,
          cls: `agentic-settings-status-badge is-${capabilityStatusSlug(status.status)}`,
        });
      }
    }
    return details;
  }

  private renderAdvancedModelRouting(parent: HTMLElement): void {
    const section = this.createAdvancedDetails(
      parent,
      "agentic-settings-model-routing",
      "Model & routing",
      "Provider behavior, request limits and generation controls.",
    );

    new Setting(section)
      .setName("Structured model router (experimental)")
      .setDesc(
        "Experimental opt-in. Off (default) keeps regex routing only. Shadow logs a JSON-schema classification beside regex without changing policy. Authority may use a high-confidence model route for mode/needs flags, but never widens destructive write scope beyond regex+policy.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("off", "Off (Conservative)")
          .addOption("shadow", "Shadow (log only)")
          .addOption("authority", "Authority (Automatic)")
          .setValue(
            normalizeModelRouterMode(
              this.plugin.settings.modelRouterMode,
              this.plugin.settings.modelRouterEnabled,
            ),
          )
          .onChange(async (value) => {
            const mode = normalizeModelRouterMode(value);
            this.plugin.settings.modelRouterMode = mode;
            this.plugin.settings.modelRouterEnabled = mode !== "off";
            this.plugin.settings.autonomyProfile = "custom";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Thinking mode")
      .setDesc(
        "Uses Ollama thinking for supported models. Auto enables known thinking-capable families.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "Auto")
          .addOption("off", "Off")
          .addOption("low", "Low")
          .addOption("medium", "Medium")
          .addOption("high", "High")
          .addOption("max", "Max")
          .setValue(this.plugin.settings.thinkingMode)
          .onChange(async (value) => {
            this.plugin.settings.thinkingMode = isThinkingMode(value)
              ? value
              : DEFAULT_SETTINGS.thinkingMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Temperature")
      .setDesc("Optional sampling temperature. Leave blank for provider default.")
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(formatOptionalNumber(this.plugin.settings.temperature))
          .onChange(async (value) => {
            this.plugin.settings.temperature = parseOptionalNumber(value, {
              min: 0,
            });
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Top K")
      .setDesc("Optional top_k value. Leave blank for provider default.")
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(formatOptionalNumber(this.plugin.settings.topK))
          .onChange(async (value) => {
            this.plugin.settings.topK = parseOptionalInteger(value, { min: 1 });
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Top P")
      .setDesc("Optional top_p value. Leave blank for provider default.")
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(formatOptionalNumber(this.plugin.settings.topP))
          .onChange(async (value) => {
            this.plugin.settings.topP = parseOptionalNumber(value, {
              min: 0,
              max: 1,
            });
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Context window")
      .setDesc("Optional num_ctx value. Leave blank for provider default.")
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(formatOptionalNumber(this.plugin.settings.numCtx))
          .onChange(async (value) => {
            this.plugin.settings.numCtx = parseOptionalInteger(value, {
              min: 1,
            });
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Request timeout")
      .setDesc(
        "Maximum time to wait for model and web requests, in milliseconds. Default is 180000 (3 minutes).",
      )
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.requestTimeoutMs))
          .setValue(String(this.plugin.settings.requestTimeoutMs))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value.trim(), 10);
            this.plugin.settings.requestTimeoutMs =
              Number.isFinite(parsed) && parsed > 0
                ? parsed
                : DEFAULT_SETTINGS.requestTimeoutMs;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderAdvancedOutputOverrides(parent: HTMLElement): void {
    const section = this.createAdvancedDetails(
      parent,
      "agentic-settings-output-memory",
      "Output & memory",
      "Note targeting, streaming, titles and durable research memory.",
      ["Notes & research"],
    );

    new Setting(section)
      .setName("Stream final answers")
      .setDesc(
        "Streams final prose when available; planning and tool selection use standard chat for reliability.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableStreaming)
          .onChange(async (value) => {
            this.plugin.settings.enableStreaming = value;
            this.plugin.settings.autonomyProfile = "custom";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Stream note writeback")
      .setDesc(
        "Streams content-producing current-note writes directly into the note.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption(
            "all_current_note_content_writes",
            "All current-note content writes",
          )
          .addOption("off", "Off")
          .setValue(this.plugin.settings.streamWritebackMode)
          .onChange(async (value) => {
            this.plugin.settings.streamWritebackMode = isStreamWritebackMode(
              value,
            )
              ? value
              : DEFAULT_SETTINGS.streamWritebackMode;
            this.plugin.settings.autonomyProfile = "custom";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Auto-title on write")
      .setDesc(
        "After substantial note writeback, rename Untitled or generic notes from a leading H1 or short mission phrase.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoTitleOnWrite !== false)
          .onChange(async (value) => {
            this.plugin.settings.autoTitleOnWrite = value;
            this.plugin.settings.autonomyProfile = "custom";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Template folder")
      .setDesc(
        "Vault folder for reusable markdown templates with {{field}} placeholders.",
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.templateFolder)
          .setValue(this.plugin.settings.templateFolder)
          .onChange(async (value) => {
            this.plugin.settings.templateFolder =
              value.trim() || DEFAULT_SETTINGS.templateFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Template output folder")
      .setDesc(
        "Optional default vault folder for notes created from filled templates. Blank uses the active note's project folder.",
      )
      .addText((text) =>
        text
          .setPlaceholder("active project folder")
          .setValue(this.plugin.settings.templateOutputFolder)
          .onChange(async (value) => {
            this.plugin.settings.templateOutputFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Research memory folder")
      .setDesc("Vault folder for durable topic memory notes.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.researchMemoryFolder)
          .setValue(this.plugin.settings.researchMemoryFolder)
          .onChange(async (value) => {
            this.plugin.settings.researchMemoryFolder =
              value.trim() || DEFAULT_SETTINGS.researchMemoryFolder;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderAdvancedAutonomyBudgets(parent: HTMLElement): void {
    const section = this.createAdvancedDetails(
      parent,
      "agentic-settings-autonomy",
      "Autonomy, teams & schedules",
      "Budgets, long runs, Lead + Worker routing and recurring missions.",
      ["Background work"],
    );

    new Setting(section)
      .setName("Maximum agent steps")
      .setDesc(
        `Upper bound for autonomous planning/tool loops. The hard safety ceiling is ${MAX_AGENT_STEPS}.`,
      )
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxAgentSteps))
          .setValue(String(this.plugin.settings.maxAgentSteps))
          .onChange(async (value) => {
            const parsed = parseOptionalInteger(value, {
              min: 1,
              max: MAX_AGENT_STEPS,
            });
            this.plugin.settings.maxAgentSteps =
              parsed ?? DEFAULT_SETTINGS.maxAgentSteps;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Maximum run minutes")
      .setDesc(
        "Optional wall-clock budget. Blank means no wall-clock limit; step budget still applies.",
      )
      .addText((text) =>
        text
          .setPlaceholder("unlimited")
          .setValue(formatOptionalNumber(this.plugin.settings.maxRunMinutes))
          .onChange(async (value) => {
            this.plugin.settings.maxRunMinutes = parseOptionalNumber(value, {
              min: 0.1,
            });
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Max code runs per mission")
      .setDesc(
        `Upper bound for run_code_block executions in one mission. Blank uses the default of ${MAX_CODE_RUNS_PER_MISSION}.`,
      )
      .addText((text) =>
        text
          .setPlaceholder(String(MAX_CODE_RUNS_PER_MISSION))
          .setValue(
            formatOptionalNumber(this.plugin.settings.maxCodeRunsPerMission),
          )
          .onChange(async (value) => {
            this.plugin.settings.maxCodeRunsPerMission =
              parseOptionalNumber(value, { min: 1, max: 64 }) ?? undefined;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Auto-continue long research")
      .setDesc(
        "When a prompt explicitly asks for deep or long-running research, continue from the durable run snapshot after a segment reaches its step budget.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoContinueLongRuns !== false)
          .onChange(async (value) => {
            this.plugin.settings.autoContinueLongRuns = value;
            this.plugin.settings.autonomyProfile = "custom";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Maximum long-run segments")
      .setDesc(
        "Used only when completion-driven loops are off. Bounded number of soft 100-step segments for explicit long research missions (1–8).",
      )
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxLongRunSegments))
          .setValue(
            String(
              this.plugin.settings.maxLongRunSegments ??
                DEFAULT_SETTINGS.maxLongRunSegments,
            ),
          )
          .onChange(async (value) => {
            this.plugin.settings.maxLongRunSegments =
              parseOptionalInteger(value, { min: 1, max: 8 }) ??
              DEFAULT_SETTINGS.maxLongRunSegments;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Completion-driven long loops")
      .setDesc(
        "When on (default), explicit long research continues soft 100-step segments until acceptance passes and proof debt is clear, up to the completion segment cap.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.completionDrivenLoops !== false)
          .onChange(async (value) => {
            this.plugin.settings.completionDrivenLoops = value;
            this.plugin.settings.autonomyProfile = "custom";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Maximum completion segments")
      .setDesc(
        "Soft cap on 100-step segments when completion-driven loops are on (4–48).",
      )
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxCompletionSegments))
          .setValue(
            String(
              this.plugin.settings.maxCompletionSegments ??
                DEFAULT_SETTINGS.maxCompletionSegments,
            ),
          )
          .onChange(async (value) => {
            this.plugin.settings.maxCompletionSegments =
              parseOptionalInteger(value, { min: 4, max: 48 }) ??
              DEFAULT_SETTINGS.maxCompletionSegments;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Enable overnight research")
      .setDesc(
        "Allow explicit overnight or 8-12 hour prompts to use durable multi-segment execution. Vault nodes wait for Obsidian; eligible pre-authorized non-vault nodes may use the optional secure Companion.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.overnightRunsEnabled !== false)
          .onChange(async (value) => {
            this.plugin.settings.overnightRunsEnabled = value;
            this.plugin.settings.autonomyProfile = "custom";
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(section)
      .setName("Default overnight hours")
      .setDesc(
        "Maximum wall-clock window for an overnight mission. Explicit prompt durations override this value within 8-12 hours.",
      )
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.overnightRunHours))
          .setValue(
            String(
              this.plugin.settings.overnightRunHours ??
                DEFAULT_SETTINGS.overnightRunHours,
            ),
          )
          .onChange(async (value) => {
            this.plugin.settings.overnightRunHours =
              parseOptionalInteger(value, { min: 8, max: 12 }) ??
              DEFAULT_SETTINGS.overnightRunHours;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Maximum overnight segments")
      .setDesc(
        "Additional hard bound for overnight work. Each segment remains limited to 100 agent steps.",
      )
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.overnightMaxSegments))
          .setValue(
            String(
              this.plugin.settings.overnightMaxSegments ??
                DEFAULT_SETTINGS.overnightMaxSegments,
            ),
          )
          .onChange(async (value) => {
            this.plugin.settings.overnightMaxSegments =
              parseOptionalInteger(value, { min: 1, max: 24 }) ??
              DEFAULT_SETTINGS.overnightMaxSegments;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Resume overnight runs after reload")
      .setDesc(
        "Resume the newest safe overnight mission after a plugin reload or crash. Explicitly stopped missions never resume automatically.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoResumeOvernightRuns !== false)
          .onChange(async (value) => {
            this.plugin.settings.autoResumeOvernightRuns = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Keep computer awake during overnight runs (experimental)")
      .setDesc(
        "Experimental desktop-only opt-in (default off). Best-effort prevention of application suspension while an overnight mission is active.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.keepAwakeDuringOvernightRuns === true)
          .onChange(async (value) => {
            this.plugin.settings.keepAwakeDuringOvernightRuns = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Orchestrator team runtime")
      .setDesc(
        "On by default. Eligible deep research / sources / verify prompts and explicit code-team requests use Lead + Worker. Turn off to force single-agent.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.orchestratorEnabled !== false)
          .onChange(async (value) => {
            this.plugin.settings.orchestratorEnabled = value;
            this.plugin.settings.orchestratorPreviewEnabled = value;
            this.plugin.settings.autonomyProfile = "custom";
            await this.plugin.saveSettings();
            this.plugin.refreshAgentView();
            this.display();
          }),
      );

    new Setting(section)
      .setName("Auto-merge green orchestrator worktrees")
      .setDesc(
        "After an approved coding mission, fast-forward only when the isolated integration worktree is green and the base checkout is still clean.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.orchestratorAutoMergeGreen === true)
          .onChange(async (value) => {
            this.plugin.settings.orchestratorAutoMergeGreen = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Orchestrator worker max steps")
      .setDesc("Per-worker step budget for Lead + Worker missions.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.orchestratorWorkerMaxSteps))
          .setValue(
            String(
              this.plugin.settings.orchestratorWorkerMaxSteps ??
                DEFAULT_SETTINGS.orchestratorWorkerMaxSteps,
            ),
          )
          .onChange(async (value) => {
            this.plugin.settings.orchestratorWorkerMaxSteps =
              parseOptionalInteger(value, { min: 1, max: MAX_AGENT_STEPS }) ??
              DEFAULT_SETTINGS.orchestratorWorkerMaxSteps;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Orchestrator worker max tool calls")
      .setDesc("Per-worker tool-call budget for Lead + Worker missions.")
      .addText((text) =>
        text
          .setPlaceholder(
            String(DEFAULT_SETTINGS.orchestratorWorkerMaxToolCalls),
          )
          .setValue(
            String(
              this.plugin.settings.orchestratorWorkerMaxToolCalls ??
                DEFAULT_SETTINGS.orchestratorWorkerMaxToolCalls,
            ),
          )
          .onChange(async (value) => {
            this.plugin.settings.orchestratorWorkerMaxToolCalls =
              parseOptionalInteger(value, { min: 1, max: 128 }) ??
              DEFAULT_SETTINGS.orchestratorWorkerMaxToolCalls;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Orchestrator worker max minutes")
      .setDesc("Per-worker wall-clock budget in minutes.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.orchestratorWorkerMaxMinutes))
          .setValue(
            String(
              this.plugin.settings.orchestratorWorkerMaxMinutes ??
                DEFAULT_SETTINGS.orchestratorWorkerMaxMinutes,
            ),
          )
          .onChange(async (value) => {
            this.plugin.settings.orchestratorWorkerMaxMinutes =
              parseOptionalInteger(value, { min: 1, max: 240 }) ??
              DEFAULT_SETTINGS.orchestratorWorkerMaxMinutes;
            await this.plugin.saveSettings();
          }),
      );

    this.renderScheduledMissionControls(section);
  }

  private renderAdvancedSemantic(parent: HTMLElement): void {
    const section = this.createAdvancedDetails(
      parent,
      "agentic-settings-semantic",
      "Semantic retrieval",
      "Local embeddings, chunking and index persistence.",
      ["Notes & research"],
    );

    new Setting(section)
      .setName("Semantic search")
      .setDesc(
        "Adds local FastEmbed-powered conceptual vault search as a read-only tool.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.semanticSearchEnabled)
          .onChange(async (value) => {
            this.plugin.settings.semanticSearchEnabled = value;
            this.plugin.settings.autonomyProfile = "custom";
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(section)
      .setName("Semantic embedding model")
      .setDesc("FastEmbed model used for semantic_search_notes.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.semanticEmbeddingModel)
          .setValue(this.plugin.settings.semanticEmbeddingModel)
          .onChange(async (value) => {
            this.plugin.settings.semanticEmbeddingModel =
              value.trim() || DEFAULT_SETTINGS.semanticEmbeddingModel;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Semantic embedding dimension")
      .setDesc(
        "Matryoshka truncation dimension. Use 512 for quality or 256 for a smaller/faster search footprint.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("512", "512")
          .addOption("256", "256")
          .setValue(String(this.plugin.settings.semanticEmbeddingDim))
          .onChange(async (value) => {
            this.plugin.settings.semanticEmbeddingDim =
              value === "256" ? 256 : 512;
            await this.plugin.saveSettings();
          }),
      );

    const semanticChunkSetting = new Setting(section)
      .setName("Semantic chunk tokens")
      .setDesc(
        "Token estimates for markdown chunks. These control semantic search and the derived semantic index.",
      );
    semanticChunkSetting.settingEl.addClass(
      "agentic-researcher-semantic-chunk-setting",
    );
    const semanticChunkGrid = semanticChunkSetting.controlEl.createDiv({
      cls: "agentic-researcher-semantic-chunk-grid",
    });
    this.addSemanticChunkNumberField(semanticChunkGrid, {
      label: "Min",
      description: "Minimum",
      placeholder: "300",
      value: this.plugin.settings.semanticChunkMinTokens,
      min: 50,
      max: 700,
      fallback: DEFAULT_SETTINGS.semanticChunkMinTokens,
      update: (value) => {
        this.plugin.settings.semanticChunkMinTokens = value;
      },
    });
    this.addSemanticChunkNumberField(semanticChunkGrid, {
      label: "Target",
      description: "Target",
      placeholder: "500",
      value: this.plugin.settings.semanticChunkTargetTokens,
      min: 50,
      max: 700,
      fallback: DEFAULT_SETTINGS.semanticChunkTargetTokens,
      update: (value) => {
        this.plugin.settings.semanticChunkTargetTokens = value;
      },
    });
    this.addSemanticChunkNumberField(semanticChunkGrid, {
      label: "Max",
      description: "Maximum",
      placeholder: "700",
      value: this.plugin.settings.semanticChunkMaxTokens,
      min: 50,
      max: 1000,
      fallback: DEFAULT_SETTINGS.semanticChunkMaxTokens,
      update: (value) => {
        this.plugin.settings.semanticChunkMaxTokens = value;
      },
    });
    this.addSemanticChunkNumberField(semanticChunkGrid, {
      label: "Overlap",
      description: "Overlap",
      placeholder: "80",
      value: this.plugin.settings.semanticChunkOverlapTokens,
      min: 0,
      max: 300,
      fallback: DEFAULT_SETTINGS.semanticChunkOverlapTokens,
      update: (value) => {
        this.plugin.settings.semanticChunkOverlapTokens = value;
      },
    });

    new Setting(section)
      .setName("Semantic Python command")
      .setDesc(
        "Optional Python command for FastEmbed. Leave blank to try python, then py.",
      )
      .addText((text) =>
        text
          .setPlaceholder("python")
          .setValue(this.plugin.settings.semanticPythonCommand)
          .onChange(async (value) => {
            this.plugin.settings.semanticPythonCommand = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Semantic model cache folder")
      .setDesc("Optional local folder for downloaded FastEmbed model files.")
      .addText((text) =>
        text
          .setPlaceholder("FastEmbed default")
          .setValue(this.plugin.settings.semanticModelCacheDir)
          .onChange(async (value) => {
            this.plugin.settings.semanticModelCacheDir = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Semantic index")
      .setDesc(
        "Maintains a derived Markdown map and local JSON vector index for faster conceptual vault search.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.semanticIndexEnabled)
          .onChange(async (value) => {
            this.plugin.settings.semanticIndexEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Semantic index folder")
      .setDesc(
        "Vault folder for Semantic Vault Index.md and semantic-vault-index.json.",
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.semanticIndexFolder)
          .setValue(this.plugin.settings.semanticIndexFolder)
          .onChange(async (value) => {
            this.plugin.settings.semanticIndexFolder =
              normalizeVaultFolderSetting(
                value,
                DEFAULT_SETTINGS.semanticIndexFolder,
              );
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Semantic index debounce")
      .setDesc(
        "Milliseconds to wait before indexing changed markdown files after vault events.",
      )
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.semanticIndexDebounceMs))
          .setValue(String(this.plugin.settings.semanticIndexDebounceMs))
          .onChange(async (value) => {
            this.plugin.settings.semanticIndexDebounceMs =
              parseOptionalInteger(value, { min: 250, max: 60000 }) ??
              DEFAULT_SETTINGS.semanticIndexDebounceMs;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Semantic index max files")
      .setDesc(
        "Maximum markdown files to include in the derived semantic index.",
      )
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.semanticIndexMaxFiles))
          .setValue(String(this.plugin.settings.semanticIndexMaxFiles))
          .onChange(async (value) => {
            this.plugin.settings.semanticIndexMaxFiles =
              parseOptionalInteger(value, { min: 1, max: 10000 }) ??
              DEFAULT_SETTINGS.semanticIndexMaxFiles;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Persist semantic vectors")
      .setDesc(
        "Stores local embedding vectors in semantic-vault-index.json. Vectors are never shown to the model.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.semanticIndexPersistVectors)
          .onChange(async (value) => {
            this.plugin.settings.semanticIndexPersistVectors = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderAdvancedBrowserIntegrations(parent: HTMLElement): void {
    const section = this.createAdvancedDetails(
      parent,
      "agentic-settings-connections",
      "Companion & integrations",
      "Browser tools plus Linear and GitHub connections.",
      ["Browser & web", "Linear", "GitHub"],
    );

    new Setting(section)
      .setName("Companion service URL")
      .setDesc(
        "Local companion URL for desktop browser automation and explicit experience memory.",
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.companionBaseUrl)
          .setValue(this.plugin.settings.companionBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.companionBaseUrl =
              normalizeCompanionBaseUrl(value) ??
              DEFAULT_SETTINGS.companionBaseUrl;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Browser tools")
      .setDesc(
        "Enable desktop-only browser observation and supervised interaction through the local companion service.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.browserToolsEnabled)
          .onChange(async (value) => {
            this.plugin.settings.browserToolsEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (
      this.plugin.settings.browserToolsEnabled ||
      this.plugin.settings.companionBaseUrl.trim() !==
        DEFAULT_SETTINGS.companionBaseUrl
    ) {
      new Setting(section)
        .setName("Default browser mission mode")
        .setDesc(
          "Supervised mode allows safety-gated actions; extract-only limits browser work to page observation and markdown extraction.",
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOption("supervised", "Supervised")
            .addOption("extract_only", "Extract only")
            .setValue(this.plugin.settings.defaultBrowserMissionMode)
            .onChange(async (value) => {
              this.plugin.settings.defaultBrowserMissionMode =
                isBrowserMissionMode(value)
                  ? value
                  : DEFAULT_SETTINGS.defaultBrowserMissionMode;
              await this.plugin.saveSettings();
            }),
        );
    }

    section.createEl("h4", { text: "Linear integration" });
    section.createEl("p", {
      text: "Connect once, then use fixed Linear GraphQL tools without per-tool setup. Credentials live in secure storage; plugin settings retain only an opaque reference.",
      cls: "setting-item-description",
    });

    const oauthConnectionHost = section.createDiv({
      cls: "agentic-linear-oauth-primary",
    });
    const oauthAdvanced = section.createEl("details", {
      cls: "agentic-settings-disclosure agentic-linear-oauth-advanced",
    });
    oauthAdvanced.createEl("summary", { text: "OAuth app setup (advanced)" });
    oauthAdvanced.createEl("p", {
      text: "Most people only need to enter a client ID once. The safe loopback port and user actor defaults can stay unchanged.",
      cls: "setting-item-description",
    });

    new Setting(oauthAdvanced)
      .setName("Linear OAuth client ID")
      .setDesc(
        "Non-secret client ID from your Linear OAuth application.",
      )
      .addText((text) => {
        text.inputEl.addClass("agentic-linear-oauth-client-id");
        return text
          .setPlaceholder("Linear OAuth client ID")
          .setValue(this.plugin.settings.linearOAuthClientId ?? "")
          .onChange(async (value) => {
            this.plugin.settings.linearOAuthClientId = value.trim();
            await this.plugin.saveSettings();
          });
      });

    const oauthCallbackPort = this.plugin.settings.linearOAuthCallbackPort ?? 43119;
    const oauthRedirectUri =
      `http://127.0.0.1:${oauthCallbackPort}/oauth/linear/callback`;
    new Setting(oauthAdvanced)
      .setName("Linear OAuth callback port")
      .setDesc(
        `Register this exact redirect URI in the Linear OAuth application before connecting: ${oauthRedirectUri}`,
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1024";
        text.inputEl.max = "65535";
        text.inputEl.step = "1";
        return text
          .setValue(String(oauthCallbackPort))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65535) {
              return;
            }
            this.plugin.settings.linearOAuthCallbackPort = parsed;
            await this.plugin.saveSettings();
          });
      });

    new Setting(oauthAdvanced)
      .setName("Linear OAuth actor")
      .setDesc(
        "User acts as the consenting member. App uses the OAuth app actor. Foreground credentials use Obsidian SecretStorage; optional background continuation requires the Companion credential store.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("user", "User")
          .addOption("app", "App")
          .setValue(this.plugin.settings.linearOAuthActor ?? "user")
          .onChange(async (value) => {
            this.plugin.settings.linearOAuthActor = value === "app" ? "app" : "user";
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    const oauthStatus = this.plugin.getLinearOAuthStatus();
    const oauthSetting = new Setting(oauthConnectionHost)
      .setName("Connect Linear with OAuth")
      .setDesc(oauthStatus.message);
    oauthSetting.addButton((button) =>
      button
        .setButtonText(
          oauthStatus.waitingForCallback
            ? "Waiting for approval"
            : oauthStatus.connected
              ? "Reconnect"
              : "Connect Linear",
        )
        .setDisabled(oauthStatus.waitingForCallback)
        .setCta()
        .onClick(async () => {
          if (!(this.plugin.settings.linearOAuthClientId ?? "").trim()) {
            oauthAdvanced.open = true;
            oauthSetting.setDesc(
              "Enter the one-time OAuth client ID below, then choose Connect Linear again.",
            );
            window.setTimeout(() => {
              oauthAdvanced
                .querySelector<HTMLInputElement>(".agentic-linear-oauth-client-id")
                ?.focus();
            }, 0);
            return;
          }
          button.setDisabled(true).setButtonText("Starting...");
          const result = await this.plugin.startLinearOAuthAuthorization();
          oauthSetting.setDesc(result.message);
          if (!result.ok) {
            button
              .setDisabled(false)
              .setButtonText(oauthStatus.connected ? "Reconnect" : "Connect Linear");
            return;
          }
          if (result.ok && result.authorizationUrl) {
            const opened = openLinearAuthorizationUrl(result.authorizationUrl);
            if (!opened) {
              const copied = await copyTextToClipboard(result.authorizationUrl);
              oauthSetting.setDesc(
                copied
                  ? "The browser could not be opened, so the authorization URL was copied. The loopback listener remains active."
                  : "The browser could not be opened. Use Open authorization while the loopback listener is active.",
              );
            }
          }
          this.refreshConnectionStatus();
        }),
    );
    if (oauthStatus.authorizationUrl) {
      oauthSetting.addButton((button) =>
        button.setButtonText("Open authorization").onClick(async () => {
          if (!openLinearAuthorizationUrl(oauthStatus.authorizationUrl!)) {
            const copied = await copyTextToClipboard(oauthStatus.authorizationUrl!);
            oauthSetting.setDesc(
              copied
                ? "Authorization URL copied; paste it into your browser."
                : "Unable to open or copy the authorization URL.",
            );
          }
        }),
      );
    }
    if (oauthStatus.connected || oauthStatus.waitingForCallback) {
      oauthSetting.addButton((button) =>
        button
          .setButtonText(oauthStatus.connected ? "Revoke OAuth" : "Cancel")
          .onClick(async () => {
            button.setDisabled(true).setButtonText("Disconnecting...");
            const result = await this.plugin.disconnectLinearOAuth();
            oauthSetting.setDesc(result.message);
            if (result.ok) {
              this.refreshConnectionStatus();
            } else {
              button
                .setDisabled(false)
                .setButtonText(oauthStatus.connected ? "Revoke OAuth" : "Cancel");
            }
          }),
      );
    }

    const credentialStatus = this.plugin.getLinearCredentialStatus();
    let pendingLinearKey = "";
    const linearKeySetting = new Setting(section)
      .setName(`Linear personal API key - ${credentialStatus.presenceLabel}`)
      .setDesc(credentialStatus.message);
    linearKeySetting.addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.setAttribute(
        "aria-label",
        "Linear personal API key (saved value stays hidden)",
      );
      text
        .setPlaceholder(
          credentialStatus.configured
            ? credentialStatus.secure
              ? "******** (saved securely)"
              : "******** (session only)"
            : "Paste a personal API key",
        )
        .setValue("")
        .onChange((value) => {
          pendingLinearKey = value;
        });
    });
    linearKeySetting.addButton((button) =>
      button.setButtonText("Save key").onClick(async () => {
        button.setDisabled(true).setButtonText("Saving...");
        const result = await this.plugin.setLinearApiKey(pendingLinearKey);
        if (!result.ok) {
          linearKeySetting.setDesc(result.message);
          button.setDisabled(false).setButtonText("Save key");
          return;
        }
        button.setButtonText("Verifying...");
        const verified = await this.plugin.testLinearConnection();
        linearKeySetting.setDesc(
          verified.ok ? `${result.message} ${verified.message}` : verified.message,
        );
        button.setButtonText(verified.ok ? "Connected" : "Saved; verify failed");
        this.refreshConnectionStatus();
      }),
    );
    if (credentialStatus.configured && !credentialStatus.secure) {
      linearKeySetting.addButton((button) =>
        button.setButtonText("Migrate legacy key").onClick(async () => {
          button.setDisabled(true).setButtonText("Migrating...");
          const result = await this.plugin.migrateLegacyLinearApiKeyToSecureStore();
          linearKeySetting.setDesc(result.message);
          if (result.ok) {
            this.refreshConnectionStatus();
          } else {
            button.setDisabled(false).setButtonText("Migrate legacy key");
          }
        }),
      );
    }
    linearKeySetting.addButton((button) =>
      button
        .setButtonText("Clear key")
        .setDisabled(!credentialStatus.configured)
        .onClick(async () => {
          const result = await this.plugin.clearLinearApiKey();
          linearKeySetting.setDesc(result.message);
          if (result.ok) this.refreshConnectionStatus();
        }),
    );
    linearKeySetting.addButton((button) =>
      button
        .setButtonText("Test connection")
        .setDisabled(!this.plugin.hasLinearApiKey())
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Testing...");
          const result = await this.plugin.testLinearConnection();
          button.setButtonText(result.ok ? "Connected" : "Test failed");
          linearKeySetting.setDesc(result.message);
          this.refreshConnectionStatus();
        }),
    );

    const linearSnapshot = this.plugin.getLinearCapabilitySnapshot();
    const capabilityReport = section.createDiv({
      cls: "agentic-linear-capability-report",
    });
    capabilityReport.createEl("h5", { text: "Connection capability report" });
    if (!linearSnapshot) {
      capabilityReport.createEl("p", {
        text: "No verified discovery snapshot. Test the connection to load teams, projects, workflow states, and enabled/disabled capability evidence.",
        cls: "setting-item-description",
      });
    } else {
      capabilityReport.createEl("p", {
        text: `Workspace: ${linearSnapshot.workspace.name ?? linearSnapshot.workspace.id}. Discovered ${linearSnapshot.discoveredAt}; refresh by testing the connection again.`,
        cls: "setting-item-description",
      });
      for (const capability of linearSnapshot.capabilities) {
        capabilityReport.createEl("p", {
          text: `${capability.enabled ? "Enabled" : "Disabled"}: ${capability.summary}`,
          cls: `setting-item-description agentic-linear-capability-${capability.enabled ? "enabled" : "disabled"}`,
        });
      }
    }

    if (linearSnapshot) {
      new Setting(section)
        .setName("Default Linear team")
        .setDesc(
          "Connection-derived team used when a prepared action omits a team.",
        )
        .addDropdown((dropdown) => {
          dropdown.addOption("", "Select a team");
          for (const team of linearSnapshot.teams) {
            dropdown.addOption(
              team.id,
              `${team.name ?? team.id}${team.key ? ` (${team.key})` : ""}`,
            );
          }
          return dropdown
            .setValue(this.plugin.settings.linearDefaultTeamId ?? "")
            .onChange(async (value) => {
              this.plugin.settings.linearDefaultTeamId = value;
              await this.plugin.saveSettings();
              this.display();
            });
        });

      const selectedTeamId = this.plugin.settings.linearDefaultTeamId ?? "";
      const projects = linearSnapshot.projects.filter(
        (project) =>
          !selectedTeamId ||
          project.teamIds.length === 0 ||
          project.teamIds.includes(selectedTeamId),
      );
      new Setting(section)
        .setName("Linear queue project")
        .setDesc(
          "Only issues in this connection-derived project can enter the automatic execution queue.",
        )
        .addDropdown((dropdown) => {
          dropdown.addOption("", "Select a project");
          for (const project of projects) {
            dropdown.addOption(project.id, project.name ?? project.id);
          }
          return dropdown
            .setValue(this.plugin.settings.linearQueueProjectId ?? "")
            .onChange(async (value) => {
              this.plugin.settings.linearQueueProjectId = value;
              await this.plugin.saveSettings();
            });
        });

      for (const state of [
        {
          name: "Started workflow state",
          key: "linearStartedStateId" as const,
          description: "State applied only after a claim comment is verified.",
          allowedTypes: ["started"],
        },
        {
          name: "Completed workflow state",
          key: "linearCompletedStateId" as const,
          description: "State applied only after the proof contract passes.",
          allowedTypes: ["completed"],
        },
        {
          name: "Blocked workflow state",
          key: "linearBlockedStateId" as const,
          description:
            "Optional. Leave blank to keep blocked work in its current state.",
          allowedTypes: [] as string[],
        },
      ]) {
        const states = linearSnapshot.workflowStates.filter(
          (candidate) =>
            (!selectedTeamId ||
              candidate.teamId === null ||
              candidate.teamId === selectedTeamId) &&
            (state.allowedTypes.length === 0 ||
              (candidate.type !== null && state.allowedTypes.includes(candidate.type))),
        );
        new Setting(section)
          .setName(state.name)
          .setDesc(state.description)
          .addDropdown((dropdown) => {
            dropdown.addOption("", state.allowedTypes.length === 0 ? "No blocked state" : "Select a state");
            for (const candidate of states) {
              dropdown.addOption(candidate.id, candidate.name ?? candidate.id);
            }
            return dropdown
              .setValue(this.plugin.settings[state.key] ?? "")
              .onChange(async (value) => {
                this.plugin.settings[state.key] = value;
                await this.plugin.saveSettings();
              });
          });
      }
    }

    const queueConfiguration = this.plugin.getLinearQueueConfigurationStatus();
    new Setting(section)
      .setName("Automatic Linear queue")
      .setDesc(
        queueConfiguration.ready
          ? "Scan at most ten updated issues every 15 minutes while Obsidian is open. Authorize once to activate this queue and grant its four-hour execution window."
          : `Unavailable: ${queueConfiguration.reason}`,
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.linearQueueEnabled === true)
          .setDisabled(!queueConfiguration.ready)
          .onChange(async (value) => {
            this.plugin.settings.linearQueueEnabled =
              queueConfiguration.ready && value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    const queueGrant = this.plugin.getLinearQueueGrantStatus();
    const queueGrantSetting = new Setting(section)
      .setName("Queue authority")
      .setDesc(
        queueGrant.active
          ? `Explicit bounded authority is active until ${queueGrant.expiresAt}. It never covers permanent deletion or GitHub publication.`
          : "No live queue authority. Authorizing activates the queue and grants a four-hour execution window; it never covers permanent deletion or GitHub publication.",
      );
    queueGrantSetting.addButton((button) =>
      button
        .setButtonText(
          queueGrant.active
            ? "Renew 4 hours"
            : this.plugin.settings.linearQueueEnabled === true
              ? "Authorize 4 hours"
              : "Activate & authorize",
        )
        .setCta()
        .setDisabled(!queueConfiguration.ready)
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Authorizing...");
          const result = await this.plugin.authorizeLinearQueueForFourHours();
          queueGrantSetting.setDesc(result.message);
          button.setButtonText(result.ok ? "Authorized" : "Not authorized");
          window.setTimeout(() => this.display(), 1_500);
        }),
    );
    queueGrantSetting.addButton((button) =>
      button
        .setButtonText("Revoke")
        .setDisabled(!queueGrant.active)
        .onClick(async () => {
          await this.plugin.revokeLinearQueueAuthority();
          this.display();
        }),
    );

    section.createEl("h4", { text: "GitHub integration" });
    section.createEl("p", {
      text: "Optional fixed-catalog GitHub access. OAuth device flow and fine-grained tokens are verified through /user, stored in Obsidian SecretStorage for foreground use, and pinned to the returned account identity. Background continuation remains Companion-gated.",
      cls: "setting-item-description",
    });

    new Setting(section)
      .setName("GitHub OAuth client ID")
      .setDesc(
        "Non-secret client ID from a GitHub OAuth app with device flow enabled.",
      )
      .addText((text) => {
        text.inputEl.addClass("agentic-github-oauth-client-id");
        return text
          .setPlaceholder("GitHub OAuth client ID")
          .setValue(this.plugin.settings.githubOAuthClientId ?? "")
          .onChange(async (value) => {
            this.plugin.settings.githubOAuthClientId = value.trim();
            await this.plugin.saveSettings();
          });
      });

    const githubStatus = this.plugin.getGitHubCredentialStatus();
    const githubConnection = new Setting(section)
      .setName("GitHub connection")
      .setDesc(githubStatus.message);
    githubConnection.addButton((button) =>
      button
        .setButtonText(githubStatus.connected ? "Reconnect OAuth" : "Connect OAuth")
        .setDisabled(githubStatus.waitingForUser)
        .onClick(async () => {
          if (!(this.plugin.settings.githubOAuthClientId ?? "").trim()) {
            githubConnection.setDesc(
              "Enter the GitHub OAuth client ID above, then choose Connect OAuth again.",
            );
            section
              .querySelector<HTMLInputElement>(".agentic-github-oauth-client-id")
              ?.focus();
            return;
          }
          button.setDisabled(true).setButtonText("Starting...");
          const result = await this.plugin.startGitHubDeviceAuthorization();
          githubConnection.setDesc(result.message);
          if (!result.ok) {
            button
              .setDisabled(false)
              .setButtonText(githubStatus.connected ? "Reconnect OAuth" : "Connect OAuth");
            return;
          }
          if (result.ok && result.verificationUri) {
            if (!openGitHubDeviceAuthorizationUrl(result.verificationUri)) {
              await copyTextToClipboard(result.verificationUri);
            }
          }
          this.refreshConnectionStatus();
        }),
    );
    if (githubStatus.waitingForUser) {
      githubConnection.addButton((button) =>
        button.setButtonText("Copy user code").onClick(async () => {
          const copied = await copyTextToClipboard(githubStatus.userCode ?? "");
          githubConnection.setDesc(
            copied
              ? `Copied ${githubStatus.userCode}. Complete authorization at ${githubStatus.verificationUri}.`
              : githubStatus.message,
          );
        }),
      );
      githubConnection.addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          const result = this.plugin.cancelGitHubDeviceAuthorization();
          githubConnection.setDesc(result.message);
          this.refreshConnectionStatus();
        }),
      );
    }
    if (githubStatus.connected) {
      githubConnection.addButton((button) =>
        button.setButtonText("Disconnect").onClick(async () => {
          button.setDisabled(true).setButtonText("Disconnecting...");
          const result = await this.plugin.disconnectGitHub();
          githubConnection.setDesc(result.message);
          if (result.ok) {
            this.refreshConnectionStatus();
          } else {
            button.setDisabled(false).setButtonText("Disconnect");
          }
        }),
      );
    }

    let pendingGitHubPat = "";
    const githubPatSetting = new Setting(section)
      .setName("GitHub fine-grained personal access token")
      .setDesc(
        "Fallback for an account or repository where OAuth device authorization is unavailable. The field is never persisted.",
      );
    githubPatSetting.addText((text) => {
      text.inputEl.type = "password";
      text
        .setPlaceholder(githubStatus.connected ? "Credential configured" : "github_pat_...")
        .setValue("")
        .onChange((value) => {
          pendingGitHubPat = value;
        });
    });
    githubPatSetting.addButton((button) =>
      button
        .setButtonText("Verify and save")
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Verifying...");
          const result = await this.plugin.setGitHubFineGrainedPat(
            pendingGitHubPat,
          );
          pendingGitHubPat = "";
          githubPatSetting.setDesc(result.message);
          if (result.ok) {
            this.refreshConnectionStatus();
          } else {
            button.setDisabled(false).setButtonText("Verify and save");
          }
        }),
    );

  }

  private renderScheduledMissionControls(section: HTMLElement): void {
    section.createEl("h4", { text: "Recurring missions" });
    section.createEl("p", {
      text: "Create a recurring mission with ordinary fields. Schedules share the same autonomy budgets and safety boundaries as foreground missions.",
      cls: "setting-item-description agentic-settings-subsection-intro",
    });

    const schedules = this.plugin.settings.scheduledMissions ?? [];
    const list = section.createDiv({ cls: "agentic-schedule-list" });
    if (schedules.length === 0) {
      list.createEl("p", {
        text: "No recurring missions yet. Add one to start with a safe, disabled daily template.",
        cls: "setting-item-description agentic-schedule-empty",
      });
    }

    schedules.forEach((mission, index) => {
      const card = list.createDiv({
        cls: "agentic-schedule-card",
        attr: { "data-schedule-id": mission.id },
      });
      const header = card.createDiv({ cls: "agentic-schedule-card-header" });
      header.createEl("h5", {
        text: mission.name?.trim() || `Recurring mission ${index + 1}`,
      });
      header.createEl("span", {
        text: mission.enabled ? "Enabled" : "Paused",
        cls: `agentic-settings-status-badge ${mission.enabled ? "is-ready" : "is-needs-setup"}`,
      });

      new Setting(card)
        .setName("Enabled")
        .setDesc("Run this mission when its schedule becomes due.")
        .addToggle((toggle) =>
          toggle.setValue(mission.enabled).onChange(async (value) => {
            mission.enabled = value;
            await this.plugin.saveSettings();
            this.redisplayWithAdvancedSectionOpen("agentic-settings-autonomy");
          }),
        );

      new Setting(card)
        .setName("Name")
        .setDesc("A short label shown only in settings and run details.")
        .addText((text) =>
          text
            .setPlaceholder(`Recurring mission ${index + 1}`)
            .setValue(mission.name ?? "")
            .onChange(async (value) => {
              mission.name = value.trim() || undefined;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(card)
        .setName("Mission prompt")
        .setDesc("Tell the agent the outcome to produce; it will plan the intermediate steps.")
        .addTextArea((text) => {
          text.inputEl.rows = 4;
          text.inputEl.addClass("agentic-schedule-prompt");
          return text
            .setPlaceholder("Research this topic, verify sources, and append the result to my note.")
            .setValue(mission.prompt)
            .onChange(async (value) => {
              mission.prompt = value;
              await this.plugin.saveSettings();
            });
        });

      new Setting(card)
        .setName("Repeat")
        .setDesc("Hourly runs start when due. Daily and weekly runs use your local time.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("hourly", "Every hour")
            .addOption("daily", "Every day")
            .addOption("weekly", "Every week")
            .setValue(mission.cadence)
            .onChange(async (value) => {
              mission.cadence =
                value === "hourly" || value === "weekly" ? value : "daily";
              await this.plugin.saveSettings();
              this.redisplayWithAdvancedSectionOpen("agentic-settings-autonomy");
            }),
        );

      if (mission.cadence !== "hourly") {
        if (mission.cadence === "weekly") {
          new Setting(card)
            .setName("Day")
            .setDesc("Local weekday for the weekly run.")
            .addDropdown((dropdown) => {
              ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
                .forEach((label, weekday) => dropdown.addOption(String(weekday), label));
              return dropdown
                .setValue(String(mission.weekday ?? 1))
                .onChange(async (value) => {
                  mission.weekday = Number(value);
                  await this.plugin.saveSettings();
                });
            });
        }
        new Setting(card)
          .setName("Start hour")
          .setDesc("Local hour from 0 through 23.")
          .addText((text) => {
            text.inputEl.type = "number";
            text.inputEl.min = "0";
            text.inputEl.max = "23";
            text.inputEl.step = "1";
            return text
              .setValue(String(mission.hourLocal ?? 8))
              .onChange(async (value) => {
                const parsed = Number(value);
                if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) return;
                mission.hourLocal = parsed;
                await this.plugin.saveSettings();
              });
          });
      }

      new Setting(card)
        .setName("Output note (optional)")
        .setDesc("Vault-relative Markdown path. Leave blank to let the mission choose its normal output.")
        .addText((text) =>
          text
            .setPlaceholder("Research/Daily review.md")
            .setValue(mission.targetNotePath ?? "")
            .onChange(async (value) => {
              mission.targetNotePath = value.trim() || undefined;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(card)
        .setName("Remove schedule")
        .setDesc("Removes this schedule only; it does not delete notes or prior run receipts.")
        .addButton((button) =>
          button.setButtonText("Remove").setWarning().onClick(async () => {
            this.plugin.settings.scheduledMissions = schedules.filter(
              (_, candidateIndex) => candidateIndex !== index,
            );
            await this.plugin.saveSettings();
            this.redisplayWithAdvancedSectionOpen("agentic-settings-autonomy");
          }),
        );
    });

    new Setting(section)
      .setName("Add recurring mission")
      .setDesc("Adds a paused daily template. Review its prompt, then enable it.")
      .addButton((button) =>
        button.setButtonText("Add mission").setCta().onClick(async () => {
          const now = Date.now();
          this.plugin.settings.scheduledMissions = [
            ...schedules,
            {
              id: `schedule-${now.toString(36)}`,
              name: "Daily vault review",
              prompt:
                "Review today's active project notes, summarize meaningful progress, and append a concise next-actions section.",
              cadence: "daily",
              hourLocal: 8,
              weekday: 1,
              enabled: false,
              lastRunAt: null,
              lastRunId: null,
              mode: "standard",
            },
          ];
          await this.plugin.saveSettings();
          this.redisplayWithAdvancedSectionOpen("agentic-settings-autonomy");
        }),
      );

    const advanced = section.createEl("details", {
      cls: "agentic-settings-disclosure agentic-schedule-json",
    });
    advanced.createEl("summary", { text: "Advanced JSON import/export" });
    advanced.createEl("p", {
      text: "Optional power-user view for moving schedules between vaults. Invalid JSON is never applied.",
      cls: "setting-item-description",
    });
    let pendingJson = JSON.stringify(schedules, null, 2);
    const jsonStatus = advanced.createEl("p", {
      text: "Edit the JSON, then choose Apply JSON.",
      cls: "setting-item-description agentic-schedule-json-status",
    });
    new Setting(advanced)
      .setName("Schedule JSON")
      .setDesc("The form above remains the recommended editor.")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.addClass("agentic-researcher-scheduled-missions-input");
        return text.setValue(pendingJson).onChange((value) => {
          pendingJson = value;
          jsonStatus.setText("JSON has unapplied changes.");
        });
      })
      .addButton((button) =>
        button.setButtonText("Apply JSON").onClick(async () => {
          const parsed = parseScheduledMissionsJson(pendingJson);
          if (parsed === null) {
            jsonStatus.setText("Invalid JSON. Nothing was changed.");
            return;
          }
          this.plugin.settings.scheduledMissions = parsed;
          await this.plugin.saveSettings();
          this.redisplayWithAdvancedSectionOpen("agentic-settings-autonomy");
        }),
      );
  }

  private renderAdvancedDiagnostics(parent: HTMLElement): void {
    const section = this.createAdvancedDetails(
      parent,
      "agentic-settings-diagnostics",
      "Diagnostics",
      "Effective runtime settings, dependency checks and reflex visibility.",
    );
    const s = this.plugin.settings;
    const provider = s.modelProvider ?? "ollama";
    const base =
      provider === "openai_compatible"
        ? s.openAiCompatibleBaseUrl
        : s.ollamaBaseUrl;

    section.createEl("p", {
      text: `Effective profile: working=${s.workingMode ?? "automatic"}, memory=${s.memoryMode ?? "research"}, autonomy=${s.autonomyProfile ?? "automatic"}, output=${s.outputProfile ?? "active_or_new_note"}, schema=${s.settingsSchemaVersion ?? 1}. Provider=${provider}, model=${s.model}, thinking=${s.thinkingMode}, base=${base}. Streaming=${s.enableStreaming ? "on" : "off"}, note_stream=${s.streamWritebackMode}, auto_title=${s.autoTitleOnWrite !== false ? "on" : "off"}, orchestrator=${s.orchestratorEnabled !== false ? "on" : "off"}, router=${normalizeModelRouterMode(s.modelRouterMode, s.modelRouterEnabled)}, reflex=${s.agenticReflexEnabled ? "on" : "off"}.`,
      cls: "setting-item-description agentic-settings-diagnostics-summary",
    });

    this.renderDependencyPreflight(section);

    new Setting(section)
      .setName("Agentic reflex layer")
      .setDesc(
        "Uses local embeddings and deterministic checks for safer route hints, next-action scoring, loop detection, and completion checks.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.agenticReflexEnabled)
          .onChange(async (value) => {
            this.plugin.settings.agenticReflexEnabled = value;
            this.plugin.settings.autonomyProfile = "custom";
            this.plugin.settings.workingMode = "custom";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(section)
      .setName("Reflex diagnostics")
      .setDesc(
        "Shows inferred intent, confidence, action, progress, loop risk, and completion checks in Run Details.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.agenticReflexDiagnosticsEnabled)
          .onChange(async (value) => {
            this.plugin.settings.agenticReflexDiagnosticsEnabled = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderAdvancedExtensionContributions(parent: HTMLElement): void {
    const section = this.createAdvancedDetails(
      parent,
      "agentic-settings-system-health",
      "Built-in system health",
      "Internal Code, Companion and Integrations contracts.",
      ["Code", "Background work"],
    );
    this.extensionContributionsEl = section;
    section.createEl("p", {
      text: "Code, Companion, and Integrations ship inside Agentic Researcher. Their internal boundaries stay isolated and appear here only for health and migration diagnostics.",
      cls: "setting-item-description",
    });

    const contributions = this.plugin.getExtensionSettingsSections();
    if (contributions.length === 0) {
      section.createEl("p", {
        text: "Built-in capability metadata is not ready. Reload Agentic Researcher and inspect Run Details for the startup blocker.",
        cls: "setting-item-description agentic-extension-settings-empty",
      });
      return;
    }

    for (const contribution of contributions) {
      section.createEl("h4", {
        text: contribution.title,
        cls: "agentic-extension-settings-title",
      });
      section.createEl("p", {
        text: `Owner: ${contribution.extensionId}; contribution: ${contribution.contributionId}.`,
        cls: "setting-item-description agentic-extension-settings-owner",
      });
      for (const field of contribution.fields) {
        new Setting(section)
          .setName(field.label)
          .setDesc(formatExtensionSettingMetadata(field));
      }
    }
  }

  refreshExtensionContributions(): void {
    const current = this.extensionContributionsEl;
    const parent = current?.parentElement;
    if (!current?.isConnected || !parent) {
      return;
    }
    const wasOpen = current.open;
    const next = current.nextSibling;
    current.remove();
    this.renderAdvancedExtensionContributions(parent);
    const replacement = this.extensionContributionsEl;
    if (replacement && next) {
      parent.insertBefore(replacement, next);
    }
    if (replacement) {
      replacement.open = wasOpen;
    }
  }

  private async applyWorkingModeChange(value: string): Promise<void> {
    const mode: WorkingModeSetting =
      value === "chat_only" || value === "custom" ? value : "automatic";
    applyWorkingModeDefaults(
      this.plugin.settings as NormalizableAgentSettings,
      mode,
    );
    await this.plugin.saveSettings();
    this.display();
  }

  private async applyMemoryModeChange(value: string): Promise<void> {
    const mode: MemoryModeSetting =
      value === "off" || value === "research_and_experience"
        ? value
        : "research";
    applyMemoryModeDefaults(
      this.plugin.settings as NormalizableAgentSettings,
      mode,
    );
    await this.plugin.saveSettings();
    this.display();
  }

  private addSemanticChunkNumberField(
    containerEl: HTMLElement,
    options: {
      label: string;
      description: string;
      placeholder: string;
      value: number;
      min: number;
      max: number;
      fallback: number;
      update: (value: number) => void;
    },
  ) {
    const fieldEl = containerEl.createEl("label", {
      cls: "agentic-researcher-semantic-chunk-field",
    });
    fieldEl.createSpan({
      text: options.label,
      cls: "agentic-researcher-semantic-chunk-label",
    });
    const inputEl = fieldEl.createEl("input", {
      cls: "agentic-researcher-semantic-chunk-input",
      attr: {
        "aria-label": `Semantic chunk ${options.description.toLowerCase()} tokens`,
        inputmode: "numeric",
        max: String(options.max),
        min: String(options.min),
        placeholder: options.placeholder,
        step: "1",
        type: "number",
        value: String(options.value),
      },
    });

    inputEl.addEventListener("change", async () => {
      const parsed =
        parseOptionalInteger(inputEl.value, {
          min: options.min,
          max: options.max,
        }) ?? options.fallback;
      options.update(parsed);
      inputEl.value = String(parsed);
      await this.plugin.saveSettings();
    });
  }

  /** Advisory-only dependency status for Settings (does not block runs). */
  private renderDependencyPreflight(containerEl: HTMLElement): void {
    const rows = buildSettingsDependencyRows(this.plugin.settings);
    const preflight = runDependencyPreflight(rows);

    containerEl.createEl("h4", { text: "Dependency preflight" });
    containerEl.createEl("p", {
      text: `Advisory only (status: ${preflight.status}). Missing keys or embeddings degrade capabilities; they do not block opening Settings.`,
      cls: "setting-item-description",
    });

    for (const row of preflight.rows) {
      new Setting(containerEl)
        .setName(formatDependencyRowName(row))
        .setDesc(`${row.summary} — ${row.nextAction}`);
    }
  }
}

type CapabilityUiStatus =
  | "Ready"
  | "Degraded"
  | "Needs setup"
  | "Approval required";

function capabilityStatusSlug(status: CapabilityUiStatus): string {
  return status.toLowerCase().replace(/\s+/g, "-");
}

function capabilitySettingsTargetId(name: string): string {
  if (name === "Notes & research") return "agentic-settings-output-memory";
  if (name === "Browser & web" || name === "Linear" || name === "GitHub") {
    return "agentic-settings-connections";
  }
  return "agentic-settings-system-health";
}

function capabilitySetupTargetId(target: CapabilitySetupTarget): string {
  if (target === "model") return "agentic-settings-essentials";
  if (target === "notes_research") return "agentic-settings-output-memory";
  if (
    target === "browser_web" ||
    target === "linear" ||
    target === "github"
  ) {
    return "agentic-settings-connections";
  }
  return "agentic-settings-system-health";
}

function capabilityStatusShortName(name: string): string {
  if (name === "Notes & research") return "Notes";
  if (name === "Browser & web") return "Web";
  if (name === "Background work") return "Background";
  return name;
}

function capabilityPrimaryAction(
  name: string,
  status: CapabilityUiStatus,
): string {
  if (status === "Ready") return "Review";
  if (status === "Approval required") return "Review approval";
  if (name === "Linear") return "Connect Linear";
  if (name === "GitHub") return "Connect GitHub";
  if (name === "Code") return "Set up execution";
  if (name === "Browser & web") return "Test web tools";
  if (name === "Background work") return "Set up background work";
  return "Review note setup";
}

function buildCapabilityStatusRows(
  plugin: AgenticResearcherPlugin,
): Array<{ name: string; status: CapabilityUiStatus; detail: string }> {
  const settings = plugin.settings;
  const output = settings.outputProfile ?? "active_or_new_note";
  const notesStatus: CapabilityUiStatus =
    output === "chat_first"
      ? "Ready"
      : settings.enableStreaming === false ||
          settings.streamWritebackMode === "off"
        ? "Degraded"
        : "Ready";
  const notesDetail =
    output === "active_or_new_note"
      ? `Active-or-new-note output is ready; semantic retrieval is ${settings.semanticSearchEnabled ? "on" : "optional/off"}.`
      : output === "active_note_only"
        ? "Active note only; falls back to chat when no Markdown note is open."
        : "Chat-first default; explicit note writes still work.";

  let browserStatus: CapabilityUiStatus = "Ready";
  let browserDetail = "Web search/fetch are available; supervised browser actions are off.";
  if (settings.browserToolsEnabled) {
    browserStatus = "Approval required";
    browserDetail =
      "Web plus supervised browser tools are available; click/type/submit remain SafetyPolicy gated.";
  }

  const registered = new Set(plugin.getRegisteredCapabilityIds());
  const codeReady = registered.has("agentic-researcher-code");
  const codeStatus: CapabilityUiStatus = codeReady ? "Ready" : "Degraded";
  const codeDetail = codeReady
    ? "Durable workspace editing is ready; execution still verifies the configured sandbox per mission."
    : "Built-in Code did not register; reload and inspect system health.";

  let linearStatus: CapabilityUiStatus = "Needs setup";
  let linearDetail = "Connect Linear to expose fixed-catalog tools for explicit Linear requests.";
  if (plugin.hasLinearApiKey()) {
    if (settings.linearQueueEnabled === true) {
      const grant = plugin.getLinearQueueGrantStatus();
      if (!grant.active) {
        linearStatus = "Approval required";
        linearDetail =
          "Queue enabled; authorize a bounded four-hour grant to execute.";
      } else {
        linearStatus = "Ready";
        linearDetail = `Queue authority active until ${grant.expiresAt}.`;
      }
    } else if (!plugin.getLinearCapabilitySnapshot()) {
      linearStatus = "Degraded";
      linearDetail = "Connected credential present; test once to discover workspace capabilities.";
    } else {
      linearStatus = "Ready";
      linearDetail = "Connected with verified workspace discovery; automatic queue remains optional.";
    }
  }

  const github = plugin.getGitHubCredentialStatus();
  const githubStatus: CapabilityUiStatus = github.connected
    ? github.enabled
      ? "Ready"
      : "Degraded"
    : github.waitingForUser
      ? "Approval required"
      : "Needs setup";
  const githubDetail = github.connected
    ? github.enabled
      ? `Connected as ${github.account?.login ?? "verified account"}; repository access remains profile-bound.`
      : "Credential is connected but a legacy disabled flag still blocks tools; reconnect or reset the connection."
    : github.waitingForUser
      ? "Finish the active GitHub device authorization."
      : "Connect GitHub to enable fixed-catalog repository activity.";

  const companionReady = registered.has("agentic-researcher-companion");
  const schedules = settings.scheduledMissions ?? [];
  const enabledSchedules = (settings.scheduledMissions ?? []).filter(
    (mission) => mission.enabled,
  );
  const backgroundStatus: CapabilityUiStatus = companionReady
    ? "Ready"
    : "Degraded";
  const backgroundDetail = !companionReady
    ? "Built-in Companion did not register; background work is unavailable."
    : enabledSchedules.length > 0
      ? `${enabledSchedules.length} schedule(s) enabled; service and grant health remain visible in Run Details.`
      : schedules.length > 0
        ? `${schedules.length} recurring schedule(s) paused; background runtime is ready when you choose to enable one.`
        : "Background runtime is ready and idle; add a recurring mission only when you want unattended work.";

  return [
    {
      name: "Notes & research",
      status: notesStatus,
      detail: notesDetail,
    },
    {
      name: "Code",
      status: codeStatus,
      detail: codeDetail,
    },
    {
      name: "Linear",
      status: linearStatus,
      detail: linearDetail,
    },
    {
      name: "GitHub",
      status: githubStatus,
      detail: githubDetail,
    },
    {
      name: "Browser & web",
      status: browserStatus,
      detail: browserDetail,
    },
    {
      name: "Background work",
      status: backgroundStatus,
      detail: backgroundDetail,
    },
  ];
}

function formatExtensionSettingMetadata(
  field: ExtensionSettingFieldProjectionV1,
): string {
  const defaultValue =
    field.type === "secret_reference"
      ? "extension-owned secret reference (value never displayed)"
      : field.defaultValue === undefined
        ? "unspecified"
        : JSON.stringify(field.defaultValue);
  const options = field.options?.length
    ? ` Options: ${field.options.map((option) => `${option.label}=${option.value}`).join(", ")}.`
    : "";
  return [
    field.description?.trim(),
    `Read-only metadata: id=${field.id}, type=${field.type}, declared default=${defaultValue}.${options}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}


function isThinkingMode(value: string): value is ThinkingMode {
  return (
    value === "auto" ||
    value === "off" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max"
  );
}

function isStreamWritebackMode(value: string): value is StreamWritebackMode {
  return value === "off" || value === "all_current_note_content_writes";
}

function isBrowserMissionMode(value: string): value is BrowserMissionMode {
  return value === "supervised" || value === "extract_only";
}

function isModelProvider(value: string): value is ModelProvider {
  return (
    value === "ollama" ||
    value === "openai_compatible"
  );
}

function formatOptionalNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function parseOptionalNumber(
  value: string,
  bounds: { min?: number; max?: number } = {},
): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (bounds.min !== undefined && parsed < bounds.min) {
    return null;
  }

  if (bounds.max !== undefined && parsed > bounds.max) {
    return null;
  }

  return parsed;
}

function parseOptionalInteger(
  value: string,
  bounds: { min?: number; max?: number } = {},
): number | null {
  const parsed = parseOptionalNumber(value, bounds);
  return parsed === null ? null : Math.trunc(parsed);
}

function parseScheduledMissionsJson(value: string): ScheduledMission[] | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  try {
    return normalizeScheduledMissions(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function normalizeVaultFolderSetting(value: string, fallback: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return fallback;
  }
  if (
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:/.test(trimmed)
  ) {
    return fallback;
  }

  const parts = trimmed.split("/");
  if (parts.some((part) => !part || part === ".")) {
    return fallback;
  }

  return trimmed;
}

function buildSettingsDependencyRows(
  settings: AgentSettings,
): MissionDependencyStatus[] {
  const checkedAt = new Date().toISOString();
  const provider = settings.modelProvider ?? "ollama";
  const baseUrl =
    provider === "openai_compatible"
      ? settings.openAiCompatibleBaseUrl
      : settings.ollamaBaseUrl;
  const providerMissingKey =
    provider === "openai_compatible"
      ? !settings.openAiCompatibleApiKey?.trim()
      : /ollama\.com/i.test(baseUrl) && !settings.ollamaApiKey?.trim();
  const embeddingDegraded =
    settings.semanticSearchEnabled === true &&
    !settings.semanticEmbeddingModel?.trim();

  return [
    {
      category: "provider_auth",
      status: providerMissingKey ? "degraded" : "ok",
      capability: "model requests",
      summary: providerMissingKey
        ? `${provider} API key looks missing for the configured endpoint.`
        : `${provider} credentials look configured.`,
      nextAction: providerMissingKey
        ? "Add the provider API key above if cloud models fail."
        : "No action needed.",
      checkedAt,
    },
    {
      category: "semantic_retrieval",
      status: embeddingDegraded ? "degraded" : "ok",
      capability: "semantic search / embeddings",
      summary: embeddingDegraded
        ? "Semantic search is enabled but no embedding model is set."
        : settings.semanticSearchEnabled
          ? `Embedding model: ${settings.semanticEmbeddingModel}.`
          : "Semantic search is disabled.",
      nextAction: embeddingDegraded
        ? "Set a semantic embedding model or disable semantic search."
        : "No action needed.",
      checkedAt,
    },
  ];
}

function formatDependencyRowName(row: MissionDependencyStatus): string {
  const label =
    row.category === "provider_auth"
      ? "API key"
      : row.category === "semantic_retrieval"
        ? "Embedding"
        : row.category;
  return `${label}: ${row.status}`;
}

function normalizeCompanionBaseUrl(value: string): string | null {
  const normalized = normalizeProviderBaseUrl(value);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" ||
      host === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function normalizeProviderBaseUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function openLinearAuthorizationUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== "https://linear.app" ||
      parsed.pathname !== "/oauth/authorize"
    ) {
      return false;
    }
    return window.open(parsed.toString(), "_blank", "noopener,noreferrer") !== null;
  } catch {
    return false;
  }
}

function openGitHubDeviceAuthorizationUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== "https://github.com" ||
      parsed.pathname !== "/login/device" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      return false;
    }
    return window.open(parsed.toString(), "_blank", "noopener,noreferrer") !== null;
  } catch {
    return false;
  }
}

async function copyTextToClipboard(value: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
