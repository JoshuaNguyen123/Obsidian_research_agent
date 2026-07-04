import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type AgenticResearcherPlugin from "../main";
import {
  MAX_AGENT_STEPS,
  runAgentMission,
  type AgentRunCompleteEvent,
  type AgentRunConfigEvent,
  type AgentRunMetricEvent,
  type AgentRunPhase,
  type AgentRunReceipt,
  type AgentTraceEvent,
  type AgentToolRunEvent,
} from "./AgentRunner";
import { formatModelClientError } from "./model/types";

export const AGENT_VIEW_TYPE = "agentic-researcher-view";

type LogKind = "system" | "user" | "assistant" | "error";
type AgentViewTab = "chat" | "details";

export class AgentView extends ItemView {
  private readonly plugin: AgenticResearcherPlugin;
  private logEl: HTMLElement | null = null;
  private promptEl: HTMLTextAreaElement | null = null;
  private runButtonEl: HTMLButtonElement | null = null;
  private clearButtonEl: HTMLButtonElement | null = null;
  private chatTabButtonEl: HTMLButtonElement | null = null;
  private detailsTabButtonEl: HTMLButtonElement | null = null;
  private chatPanelEl: HTMLElement | null = null;
  private detailsPanelEl: HTMLElement | null = null;
  private phaseValueEl: HTMLElement | null = null;
  private stepValueEl: HTMLElement | null = null;
  private activeToolValueEl: HTMLElement | null = null;
  private activityValueEl: HTMLElement | null = null;
  private runStatusEl: HTMLElement | null = null;
  private runStatusTextEl: HTMLElement | null = null;
  private statusStreamEl: HTMLElement | null = null;
  private modelConfigEl: HTMLElement | null = null;
  private planningStreamEl: HTMLElement | null = null;
  private toolTimelineEl: HTMLElement | null = null;
  private finalStreamEl: HTMLElement | null = null;
  private receiptsEl: HTMLElement | null = null;
  private runLogEl: HTMLElement | null = null;
  private liveAssistantMessageEl: HTMLElement | null = null;
  private livePlanningMessageEl: HTMLElement | null = null;
  private liveFinalMessageEl: HTMLElement | null = null;
  private readonly toolTimelineItems = new Map<string, HTMLElement>();
  private readonly chatMessageEls = new Map<string, HTMLElement>();
  private readonly traceRowEls = new Map<string, HTMLElement>();
  private activeTab: AgentViewTab = "chat";
  private isRunning = false;
  private pendingAssistantContent = "";
  private chatMessageSequence = 0;
  private currentRunChatId: string | null = null;
  private runConfig: AgentRunConfigEvent | null = null;
  private usageTotals = this.createEmptyUsageTotals();

  constructor(leaf: WorkspaceLeaf, plugin: AgenticResearcherPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return AGENT_VIEW_TYPE;
  }

  getDisplayText() {
    return "Agentic Researcher";
  }

  getIcon() {
    return "bot";
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    this.contentEl.empty();
  }

  private render() {
    const container = this.contentEl;
    container.empty();
    this.chatMessageEls.clear();
    container.addClass("agentic-researcher-view");

    const headerEl = container.createDiv({ cls: "agentic-researcher-header" });
    headerEl.createEl("h2", { text: "Agentic Researcher" });
    headerEl.createEl("p", {
      text: "Mission console",
      cls: "agentic-researcher-subtitle",
    });

    this.renderTabs(container);

    this.chatPanelEl = container.createDiv({
      cls: "agentic-researcher-tab-panel",
    });
    this.detailsPanelEl = container.createDiv({
      cls: "agentic-researcher-tab-panel",
    });

    this.renderChat(this.chatPanelEl);
    this.renderDashboard(this.detailsPanelEl);
    this.setActiveTab(this.activeTab);
  }

  private renderTabs(container: HTMLElement) {
    const tabsEl = container.createDiv({
      cls: "agentic-researcher-tabs",
      attr: { role: "tablist" },
    });

    this.chatTabButtonEl = tabsEl.createEl("button", {
      text: "Chat",
      cls: "agentic-researcher-tab is-active",
      attr: {
        type: "button",
        role: "tab",
        "aria-selected": "true",
      },
    });
    this.detailsTabButtonEl = tabsEl.createEl("button", {
      text: "Run Details",
      cls: "agentic-researcher-tab",
      attr: {
        type: "button",
        role: "tab",
        "aria-selected": "false",
      },
    });

    this.chatTabButtonEl.addEventListener("click", () => this.setActiveTab("chat"));
    this.detailsTabButtonEl.addEventListener("click", () =>
      this.setActiveTab("details"),
    );
  }

  private renderChat(container: HTMLElement) {
    container.addClass("agentic-researcher-chat-panel");

    this.logEl = container.createDiv({
      cls: "agentic-researcher-log",
      attr: { "aria-live": "polite" },
    });
    this.renderConversationLog();

    const formEl = container.createEl("form", {
      cls: "agentic-researcher-form",
    });

    this.promptEl = formEl.createEl("textarea", {
      cls: "agentic-researcher-prompt",
      attr: {
        placeholder: "Ask a research question...",
        rows: "5",
      },
    });

    const actionsEl = formEl.createDiv({ cls: "agentic-researcher-actions" });

    this.runButtonEl = actionsEl.createEl("button", {
      text: "Run Mission",
      cls: "agentic-researcher-run",
      attr: {
        type: "submit",
      },
    });

    this.clearButtonEl = actionsEl.createEl("button", {
      text: "Clear chat",
      cls: "agentic-researcher-clear",
      attr: {
        type: "button",
      },
    });

    this.runStatusEl = actionsEl.createDiv({
      cls: "agentic-researcher-run-status",
      attr: { "aria-live": "polite" },
    });
    this.runStatusEl.createSpan({ cls: "agentic-researcher-spinner" });
    this.runStatusTextEl = this.runStatusEl.createSpan({
      text: "Idle",
      cls: "agentic-researcher-run-status-text",
    });

    formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.capturePrompt();
    });
    this.clearButtonEl.addEventListener("click", () => {
      void this.clearChat();
    });
  }

  private renderConversationLog() {
    if (!this.logEl) {
      return;
    }

    this.logEl.empty();
    this.createLogItem(
      "system",
      "Agent ready. Persistent chat memory is on.",
    );

    for (const message of this.plugin.conversationHistory) {
      this.createLogItem(message.role, message.content);
    }
  }

  private renderDashboard(container: HTMLElement) {
    container.addClass("agentic-researcher-details-panel");

    const dashboardEl = container.createDiv({
      cls: "agentic-researcher-dashboard",
      attr: { "aria-live": "polite" },
    });

    const metricsEl = dashboardEl.createDiv({
      cls: "agentic-researcher-metrics",
    });

    this.phaseValueEl = this.createMetric(metricsEl, "Phase", "Idle");
    this.stepValueEl = this.createMetric(metricsEl, "Step", this.formatStepMetric(0));
    this.activeToolValueEl = this.createMetric(metricsEl, "Active tool", "None");
    this.activityValueEl = this.createMetric(metricsEl, "Activity", "Idle");

    this.modelConfigEl = this.createDashboardSection(dashboardEl, "Model config");
    this.statusStreamEl = this.createDashboardSection(dashboardEl, "Status");

    const streamsEl = dashboardEl.createDiv({
      cls: "agentic-researcher-stream-grid",
    });

    this.planningStreamEl = this.createDashboardSection(streamsEl, "Planning");
    this.finalStreamEl = this.createDashboardSection(streamsEl, "Final answer");
    this.toolTimelineEl = this.createDashboardSection(dashboardEl, "Tool timeline");
    this.receiptsEl = this.createDashboardSection(dashboardEl, "Receipts");
    this.runLogEl = this.createDashboardSection(dashboardEl, "Run log");

    this.setSectionPlaceholder(this.modelConfigEl, "No run yet.");
    this.setSectionPlaceholder(this.statusStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.planningStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.finalStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.toolTimelineEl, "No tools yet.");
    this.setSectionPlaceholder(this.receiptsEl, "No writes yet.");
    this.setSectionPlaceholder(this.runLogEl, "No trace yet.");
  }

  private createMetric(
    container: HTMLElement,
    label: string,
    value: string,
  ): HTMLElement {
    const metricEl = container.createDiv({ cls: "agentic-researcher-metric" });
    metricEl.createDiv({
      text: label,
      cls: "agentic-researcher-metric-label",
    });
    return metricEl.createDiv({
      text: value,
      cls: "agentic-researcher-metric-value",
    });
  }

  private createDashboardSection(
    container: HTMLElement,
    label: string,
  ): HTMLElement {
    const sectionEl = container.createDiv({
      cls: "agentic-researcher-dashboard-section",
    });
    const labelEl = sectionEl.createDiv({
      cls: "agentic-researcher-dashboard-label-row",
    });
    labelEl.createDiv({
      text: label,
      cls: "agentic-researcher-dashboard-label",
    });
    const bodyEl = sectionEl.createDiv({
      cls: "agentic-researcher-dashboard-body",
    });
    this.createCopyButton(labelEl, () => bodyEl.textContent ?? "", `Copy ${label}`);
    return bodyEl;
  }

  private async capturePrompt() {
    if (this.isRunning) {
      return;
    }

    const prompt = this.promptEl?.value.trim() ?? "";

    if (!prompt) {
      this.appendLog("error", "Enter a mission prompt before running.");
      this.promptEl?.focus();
      return;
    }

    const conversationHistory = [...this.plugin.conversationHistory];
    this.resetDashboardForRun();
    this.pendingAssistantContent = "";
    const userLogItem = this.appendLog("user", prompt);
    this.currentRunChatId = userLogItem?.dataset.chatId ?? null;

    if (this.promptEl) {
      this.promptEl.value = "";
    }

    this.setRunning(true);

    try {
      await this.plugin.appendConversationMessage({
        role: "user",
        content: prompt,
      });

      await runAgentMission({
        prompt,
        conversationHistory,
        modelClient: this.plugin.createModelClient(),
        toolRegistry: this.plugin.createToolRegistry(),
        toolContext: this.plugin.createToolExecutionContext(prompt),
        enableStreaming: this.plugin.settings.enableStreaming,
        events: {
          onStatus: (message) => this.appendStatus(message),
          onPhaseChange: (phase, message) => this.updatePhase(phase, message),
          onPlanningStart: (step) => this.startPlanningStream(step),
          onPlanningDelta: (delta) => this.appendPlanningDelta(delta),
          onPlanningDone: () => this.finishPlanningStream(),
          onToolStart: (event) => this.handleToolStart(event),
          onToolDone: (event) => this.handleToolDone(event),
          onFinalStart: () => this.startFinalStream(),
          onFinalDelta: (delta) => this.appendFinalDelta(delta),
          onFinalDone: () => this.finishFinalStream(),
          onReceipt: (receipt) => this.appendReceipt(receipt),
          onAssistantMessageStart: () => this.startLiveAssistantMessage(),
          onAssistantDelta: (delta) => this.appendAssistantDelta(delta),
          onAssistantMessageDone: () => this.finishLiveAssistantMessage(),
          onThinkingMessageStart: () => this.startLiveThinkingMessage(),
          onThinkingDelta: () => undefined,
          onThinkingMessageDone: () => this.finishLiveThinkingMessage(),
          onMetric: (event) => this.appendMetric(event),
          onRunConfig: (event) => this.handleRunConfig(event),
          onRunComplete: (event) => this.handleRunComplete(event),
          onTrace: (event) => this.appendTraceEvent(event),
        },
      });
    } catch (error) {
      const message = formatModelClientError(error);
      this.updatePhase("error", "Error");
      this.appendLog("error", message);
    } finally {
      await this.persistPendingAssistantMessage();
      this.setRunning(false);
      this.promptEl?.focus();
    }
  }

  private async clearChat() {
    if (this.isRunning) {
      return;
    }

    const confirmed = confirm(
      "Clear the Agentic Researcher chat history? This will not modify notes, backups, receipts, or settings.",
    );

    if (!confirmed) {
      return;
    }

    await this.plugin.clearConversationHistory();
    this.pendingAssistantContent = "";
    this.liveAssistantMessageEl = null;
    this.renderConversationLog();
    this.promptEl?.focus();
  }

  private resetDashboardForRun() {
    this.toolTimelineItems.clear();
    this.traceRowEls.clear();
    this.livePlanningMessageEl = null;
    this.liveFinalMessageEl = null;
    this.runConfig = null;
    this.usageTotals = this.createEmptyUsageTotals();
    this.updatePhase("idle", "Queued");
    this.setMetric(this.stepValueEl, this.formatStepMetric(0));
    this.setMetric(this.activeToolValueEl, "None");
    this.setMetric(this.activityValueEl, "Queued");
    this.setSectionPlaceholder(this.modelConfigEl, "Starting run.");
    this.setSectionPlaceholder(this.statusStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.planningStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.finalStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.toolTimelineEl, "No tools yet.");
    this.setSectionPlaceholder(this.receiptsEl, "No writes yet.");
    this.setSectionPlaceholder(this.runLogEl, "No trace yet.");
  }

  private updatePhase(phase: AgentRunPhase, message: string) {
    this.setMetric(this.phaseValueEl, message || this.formatPhase(phase));
    this.setMetric(this.activityValueEl, message || this.formatPhase(phase));

    if (phase === "planning" && !this.livePlanningMessageEl) {
      this.setSectionPlaceholder(
        this.planningStreamEl,
        "Planning with standard chat.",
      );
    }

    if (phase === "done" || phase === "stopped" || phase === "error") {
      this.setMetric(this.activeToolValueEl, "None");
    }

    this.appendTrace("phase", message || this.formatPhase(phase));
  }

  private appendStatus(message: string, kind: "status" | "metric" = "status") {
    if (!message || !this.statusStreamEl) {
      return;
    }

    this.clearPlaceholder(this.statusStreamEl);
    this.statusStreamEl.createDiv({
      text: message,
      cls: "agentic-researcher-status-line",
    });
    this.statusStreamEl.scrollTop = this.statusStreamEl.scrollHeight;
    this.appendTrace(kind, message);
  }

  private startPlanningStream(step: number) {
    this.setMetric(this.stepValueEl, this.formatStepMetric(step));

    if (!this.planningStreamEl) {
      return;
    }

    this.planningStreamEl.empty();
    this.livePlanningMessageEl = this.planningStreamEl.createDiv({
      cls: "agentic-researcher-stream-text",
    });
    this.appendTrace("planning", `Planning step ${step}`);
  }

  private appendPlanningDelta(delta: string) {
    if (!delta) {
      return;
    }

    if (!this.livePlanningMessageEl) {
      this.startPlanningStream(this.getCurrentStepNumber());
    }

    this.appendText(this.livePlanningMessageEl, delta);
  }

  private finishPlanningStream() {
    this.livePlanningMessageEl = null;
  }

  private handleToolStart(event: AgentToolRunEvent) {
    this.setMetric(this.stepValueEl, this.formatStepMetric(event.step));
    this.setMetric(this.activeToolValueEl, event.name);

    const itemEl = this.ensureToolTimelineItem(event);
    itemEl.removeClass("is-complete");
    itemEl.removeClass("is-error");
    this.setTimelineStatus(itemEl, "Running");
    this.setTimelineDetail(itemEl, event.message ?? `Running tool: ${event.name}`);
    this.appendTrace("tool", event.message ?? `Running tool: ${event.name}`);
  }

  private handleToolDone(event: AgentToolRunEvent) {
    const itemEl = this.ensureToolTimelineItem(event);
    const ok = event.ok !== false;

    itemEl.addClass(ok ? "is-complete" : "is-error");
    this.setTimelineStatus(itemEl, ok ? "Complete" : "Error");
    this.setTimelineDetail(itemEl, event.message ?? event.name);
    this.setExpandablePayload(itemEl, event.output ?? event.error);
    this.setMetric(this.activeToolValueEl, "None");
    this.appendTrace(
      ok ? "tool" : "error",
      event.message ?? `${event.name} ${ok ? "complete" : "error"}`,
    );
  }

  private handleRunComplete(event: AgentRunCompleteEvent) {
    this.setMetric(this.stepValueEl, this.formatStepMetric(event.step));
    this.setMetric(this.phaseValueEl, this.formatStopReason(event.stopReason));
    this.setMetric(this.activityValueEl, this.formatStopReason(event.stopReason));
    this.setMetric(this.activeToolValueEl, "None");
    this.appendTrace("complete", this.formatStopReason(event.stopReason));
  }

  private ensureToolTimelineItem(event: AgentToolRunEvent): HTMLElement {
    const existing = this.toolTimelineItems.get(event.id);
    if (existing) {
      return existing;
    }

    if (!this.toolTimelineEl) {
      throw new Error("Tool timeline is not mounted.");
    }

    this.clearPlaceholder(this.toolTimelineEl);
    const itemEl = this.toolTimelineEl.createDiv({
      cls: "agentic-researcher-tool-item",
      attr: {
        role: "button",
        tabindex: "0",
      },
    });
    this.bindTraceNavigation(itemEl, this.currentRunChatId);
    const headerEl = itemEl.createDiv({
      cls: "agentic-researcher-tool-header",
    });
    headerEl.createSpan({
      text: `${event.step}. ${event.name}`,
      cls: "agentic-researcher-tool-name",
    });
    headerEl.createSpan({
      text: "Queued",
      cls: "agentic-researcher-tool-status",
    });
    itemEl.createDiv({
      text: event.message ?? "",
      cls: "agentic-researcher-tool-detail",
    });

    this.toolTimelineItems.set(event.id, itemEl);
    return itemEl;
  }

  private setTimelineStatus(itemEl: HTMLElement, status: string) {
    const statusEl = itemEl.querySelector(
      ".agentic-researcher-tool-status",
    ) as HTMLElement | null;
    statusEl?.setText(status);
  }

  private setTimelineDetail(itemEl: HTMLElement, detail: string) {
    const detailEl = itemEl.querySelector(
      ".agentic-researcher-tool-detail",
    ) as HTMLElement | null;
    detailEl?.setText(detail);
  }

  private startFinalStream() {
    if (!this.finalStreamEl) {
      return;
    }

    this.finalStreamEl.empty();
    this.liveFinalMessageEl = this.finalStreamEl.createDiv({
      cls: "agentic-researcher-stream-text",
    });
    this.appendTrace("final", "Final answer started");
  }

  private appendFinalDelta(delta: string) {
    if (!delta) {
      return;
    }

    if (!this.liveFinalMessageEl) {
      this.startFinalStream();
    }

    this.appendText(this.liveFinalMessageEl, delta);
  }

  private finishFinalStream() {
    this.liveFinalMessageEl = null;
  }

  private appendReceipt(receipt: AgentRunReceipt) {
    if (!this.receiptsEl) {
      return;
    }

    this.clearPlaceholder(this.receiptsEl);

    const receiptEl = this.receiptsEl.createDiv({
      cls: "agentic-researcher-receipt",
      attr: {
        role: "button",
        tabindex: "0",
      },
    });
    this.bindTraceNavigation(receiptEl, this.currentRunChatId);
    const headerEl = receiptEl.createDiv({
      cls: "agentic-researcher-receipt-header",
    });
    headerEl.createDiv({
      text: receipt.message,
      cls: "agentic-researcher-receipt-message",
    });
    this.createCopyButton(headerEl, () => receiptEl.textContent ?? "", "Copy receipt");

    const metaParts = [
      receipt.bytesWritten !== undefined
        ? `${receipt.bytesWritten} bytes written`
        : null,
      receipt.bytesDeleted !== undefined
        ? `${receipt.bytesDeleted} bytes deleted`
        : null,
    ].filter((part): part is string => Boolean(part));

    if (metaParts.length > 0) {
      receiptEl.createDiv({
        text: metaParts.join(" - "),
        cls: "agentic-researcher-receipt-meta",
      });
    }

    this.setExpandablePayload(receiptEl, receipt.output ?? receipt);
    this.appendTrace("receipt", receipt.message);
  }

  private appendMetric(event: AgentRunMetricEvent) {
    this.updateUsageTotals(event);
    this.renderModelConfig();
    this.appendStatus(this.formatMetric(event), "metric");
  }

  private handleRunConfig(event: AgentRunConfigEvent) {
    this.runConfig = event;
    this.renderModelConfig();
    this.appendTrace(
      "config",
      `Model ${event.model}, mission ${event.missionMode}, streaming ${event.streaming ? "on" : "off"}, write autonomy ${event.writeAutonomy ? "on" : "off"}`,
    );
  }

  private appendLog(kind: LogKind, message: string): HTMLElement | null {
    if (!this.logEl) {
      return null;
    }

    return this.createLogItem(kind, message);
  }

  private formatMetric(event: AgentRunMetricEvent): string {
    if (event.kind === "model_chat") {
      return [
        `Timing: model step ${event.step ?? "?"}`,
        this.formatDuration(event.durationMs),
        event.requestChars !== undefined
          ? `request ${this.formatChars(event.requestChars)}`
          : null,
        event.responseChars !== undefined
          ? `response ${this.formatChars(event.responseChars)}`
          : null,
        this.formatTokenParts(event),
      ]
        .filter((part): part is string => Boolean(part))
        .join(", ");
    }

    if (event.kind === "model_stream") {
      return [
        "Timing: final stream",
        this.formatDuration(event.durationMs),
        event.requestChars !== undefined
          ? `request ${this.formatChars(event.requestChars)}`
          : null,
        event.responseChars !== undefined
          ? `response ${this.formatChars(event.responseChars)}`
          : null,
        this.formatTokenParts(event),
      ]
        .filter((part): part is string => Boolean(part))
        .join(", ");
    }

    if (event.kind === "tool") {
      return [
        `Timing: ${event.name}`,
        this.formatDuration(event.durationMs),
        event.inputChars !== undefined
          ? `input ${this.formatChars(event.inputChars)}`
          : null,
        event.outputChars !== undefined
          ? `output ${this.formatChars(event.outputChars)}`
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(", ");
    }

    return `Timing: run ${this.formatDuration(event.durationMs)}`;
  }

  private renderModelConfig() {
    if (!this.modelConfigEl) {
      return;
    }

    if (!this.runConfig) {
      this.setSectionPlaceholder(this.modelConfigEl, "No run yet.");
      return;
    }

    this.modelConfigEl.empty();
    const lines = [
      `model=${this.runConfig.model}`,
      `base=${this.runConfig.base}`,
      `mission=${this.runConfig.missionMode}`,
      `vault_context=${this.runConfig.vaultContext ? "on" : "off"}`,
      `streaming=${this.runConfig.streaming ? "on" : "off"}`,
      `thinking=${this.runConfig.thinkingMode} (resolved ${this.runConfig.resolvedThink})`,
      `temperature=${this.formatOptionalNumber(this.runConfig.temperature)}`,
      `top_k=${this.formatOptionalNumber(this.runConfig.topK)}`,
      `top_p=${this.formatOptionalNumber(this.runConfig.topP)}`,
      `num_ctx=${this.formatOptionalNumber(this.runConfig.numCtx)}`,
      `write_autonomy=${this.runConfig.writeAutonomy ? "on" : "off"}`,
      `usage_chars=request ${this.formatChars(this.usageTotals.requestChars)}, response ${this.formatChars(this.usageTotals.responseChars)}`,
      `usage_tokens=prompt ${this.formatOptionalNumber(this.usageTotals.promptTokens)}, completion ${this.formatOptionalNumber(this.usageTotals.completionTokens)}, total ${this.formatOptionalNumber(this.usageTotals.totalTokens)}`,
    ];

    for (const line of lines) {
      this.modelConfigEl.createDiv({
        text: line,
        cls: "agentic-researcher-config-line",
      });
    }
  }

  private updateUsageTotals(event: AgentRunMetricEvent) {
    this.usageTotals.requestChars += event.requestChars ?? 0;
    this.usageTotals.responseChars += event.responseChars ?? 0;
    this.usageTotals.promptTokens += event.promptTokens ?? 0;
    this.usageTotals.completionTokens += event.completionTokens ?? 0;
    this.usageTotals.totalTokens += event.totalTokens ?? 0;
  }

  private createEmptyUsageTotals() {
    return {
      requestChars: 0,
      responseChars: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
  }

  private formatTokenParts(event: AgentRunMetricEvent): string | null {
    const parts = [
      event.promptTokens !== undefined ? `prompt tokens ${event.promptTokens}` : null,
      event.completionTokens !== undefined
        ? `completion tokens ${event.completionTokens}`
        : null,
      event.totalTokens !== undefined ? `total tokens ${event.totalTokens}` : null,
    ].filter((part): part is string => Boolean(part));

    return parts.length > 0 ? parts.join(", ") : null;
  }

  private formatOptionalNumber(value: number | undefined): string {
    return typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : "default";
  }

  private formatDuration(durationMs: number): string {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }

  private formatChars(chars: number): string {
    if (chars >= 1024) {
      return `${(chars / 1024).toFixed(1)} KB`;
    }

    return `${chars} B`;
  }

  private createLogItem(kind: LogKind, message = ""): HTMLElement | null {
    if (!this.logEl) {
      return null;
    }

    const chatId = this.nextChatMessageId();
    const itemEl = this.logEl.createDiv({
      cls: `agentic-researcher-log-item agentic-researcher-log-${kind}`,
      attr: {
        "data-chat-id": chatId,
      },
    });
    this.chatMessageEls.set(chatId, itemEl);
    const headerEl = itemEl.createDiv({
      cls: "agentic-researcher-log-header",
    });
    headerEl.createDiv({
      text: this.getLogLabel(kind),
      cls: "agentic-researcher-log-label",
    });
    const messageEl = itemEl.createDiv({
      text: message,
      cls: "agentic-researcher-log-message",
    });
    this.createCopyButton(
      headerEl,
      () => messageEl.textContent ?? "",
      `Copy ${this.getLogLabel(kind)} message`,
    );

    this.logEl.scrollTop = this.logEl.scrollHeight;
    return itemEl;
  }

  private startLiveAssistantMessage() {
    this.liveAssistantMessageEl = null;
  }

  private appendAssistantDelta(delta: string) {
    if (!delta) {
      return;
    }

    if (!this.liveAssistantMessageEl) {
      const itemEl = this.createLogItem("assistant");
      this.liveAssistantMessageEl = itemEl?.querySelector(
        ".agentic-researcher-log-message",
      ) as HTMLElement | null;
    }

    this.pendingAssistantContent = `${this.pendingAssistantContent}${delta}`;
    this.appendText(this.liveAssistantMessageEl, delta);

    if (this.logEl) {
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }

  private finishLiveAssistantMessage() {
    this.liveAssistantMessageEl = null;
  }

  private startLiveThinkingMessage() {
    this.appendStatus("Thinking...");
  }

  private finishLiveThinkingMessage() {
    this.appendStatus("Thinking complete.");
  }

  private async persistPendingAssistantMessage() {
    const content = this.pendingAssistantContent;
    this.pendingAssistantContent = "";

    if (!content.trim()) {
      return;
    }

    try {
      await this.plugin.appendConversationMessage({
        role: "assistant",
        content,
      });
    } catch (error) {
      this.appendLog("error", formatModelClientError(error));
    }
  }

  private getLogLabel(kind: LogKind) {
    switch (kind) {
      case "user":
        return "User";
      case "assistant":
        return "Assistant";
      case "error":
        return "Error";
      case "system":
      default:
        return "System";
    }
  }

  private setRunning(isRunning: boolean) {
    this.isRunning = isRunning;
    this.contentEl.classList.toggle("is-running", isRunning);
    this.contentEl.setAttribute("aria-busy", String(isRunning));

    if (this.runButtonEl) {
      this.runButtonEl.disabled = isRunning;
      this.runButtonEl.setText(isRunning ? "Running..." : "Run Mission");
    }

    if (this.clearButtonEl) {
      this.clearButtonEl.disabled = isRunning;
    }

    if (this.runStatusEl) {
      this.runStatusEl.classList.toggle("is-running", isRunning);
    }

    if (this.runStatusTextEl) {
      this.runStatusTextEl.setText(isRunning ? "Running mission..." : "Idle");
    }

    this.setMetric(
      this.activityValueEl,
      isRunning ? "Running" : (this.phaseValueEl?.textContent ?? "Idle"),
    );
  }

  private setActiveTab(tab: AgentViewTab) {
    this.activeTab = tab;
    const isChat = tab === "chat";

    this.chatTabButtonEl?.classList.toggle("is-active", isChat);
    this.chatTabButtonEl?.setAttribute("aria-selected", String(isChat));
    this.detailsTabButtonEl?.classList.toggle("is-active", !isChat);
    this.detailsTabButtonEl?.setAttribute("aria-selected", String(!isChat));

    if (this.chatPanelEl) {
      this.chatPanelEl.hidden = !isChat;
      this.chatPanelEl.classList.toggle("is-active", isChat);
    }

    if (this.detailsPanelEl) {
      this.detailsPanelEl.hidden = isChat;
      this.detailsPanelEl.classList.toggle("is-active", !isChat);
    }
  }

  private setMetric(element: HTMLElement | null, value: string) {
    element?.setText(value);
  }

  private setSectionPlaceholder(element: HTMLElement | null, text: string) {
    if (!element) {
      return;
    }

    element.empty();
    element.createDiv({
      text,
      cls: "agentic-researcher-placeholder",
    });
  }

  private clearPlaceholder(element: HTMLElement) {
    const placeholderEl = element.querySelector(".agentic-researcher-placeholder");
    placeholderEl?.remove();
  }

  private appendTrace(kind: string, message: string) {
    return this.appendTraceEvent({
      id: `local-${kind}-${Date.now()}-${this.traceRowEls.size}`,
      kind: this.normalizeTraceKind(kind),
      message,
    });
  }

  private appendTraceEvent(event: AgentTraceEvent) {
    if (!this.runLogEl || !event.message) {
      return null;
    }

    const chatId = event.chatId ?? this.currentRunChatId;
    this.clearPlaceholder(this.runLogEl);
    const rowEl = this.runLogEl.createDiv({
      cls: `agentic-researcher-trace-row agentic-researcher-trace-${event.kind}`,
      attr: {
        "data-trace-id": event.id,
        role: chatId ? "button" : "listitem",
        tabindex: chatId ? "0" : "-1",
      },
    });
    rowEl.createSpan({
      text: event.kind,
      cls: "agentic-researcher-trace-kind",
    });
    rowEl.createSpan({
      text: event.message,
      cls: "agentic-researcher-trace-message",
    });

    const metaParts = [
      event.toolName ? `tool=${event.toolName}` : null,
      event.operation ? `op=${event.operation}` : null,
      event.path ? `path=${event.path}` : null,
      event.toPath ? `to=${event.toPath}` : null,
      event.backupPath ? `backup=${event.backupPath}` : null,
    ].filter((part): part is string => Boolean(part));

    if (metaParts.length > 0) {
      const metaEl = rowEl.createSpan({
        text: ` ${metaParts.join(" ")}`,
        cls: "agentic-researcher-trace-meta",
      });

      if (event.path) {
        this.createCopyButton(metaEl, () => event.path ?? "", "Copy path");
        this.createOpenNoteButton(metaEl, event.path);
      }
    }

    this.setExpandablePayload(rowEl, this.buildTracePayload(event));

    if (chatId) {
      this.bindTraceNavigation(rowEl, chatId);
    }

    this.traceRowEls.set(event.id, rowEl);
    this.runLogEl.scrollTop = this.runLogEl.scrollHeight;
    return rowEl;
  }

  private normalizeTraceKind(kind: string): AgentTraceEvent["kind"] {
    switch (kind) {
      case "status":
      case "mission_intent":
      case "allowed_tools":
      case "model_call":
      case "tool_start":
      case "tool_result":
      case "tool_rejected":
      case "receipt":
      case "metric":
      case "final":
      case "phase":
      case "planning":
      case "tool":
      case "error":
      case "complete":
      case "config":
        return kind;
      default:
        return "status";
    }
  }

  private buildTracePayload(event: AgentTraceEvent): unknown {
    const payload = {
      input: event.inputPreview,
      output: event.outputPreview,
      error: event.error,
    };

    return payload.input === undefined &&
      payload.output === undefined &&
      payload.error === undefined
      ? null
      : payload;
  }

  private bindTraceNavigation(element: HTMLElement, chatId: string | null) {
    if (!chatId) {
      return;
    }

    element.addEventListener("click", (event) => {
      if ((event.target as HTMLElement | null)?.closest("button, details")) {
        return;
      }

      this.highlightChatMessage(chatId);
    });
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      this.highlightChatMessage(chatId);
    });
  }

  private highlightChatMessage(chatId: string) {
    const itemEl = this.chatMessageEls.get(chatId);
    if (!itemEl) {
      return;
    }

    this.setActiveTab("chat");
    itemEl.scrollIntoView({ block: "nearest" });
    itemEl.addClass("is-trace-highlighted");
    window.setTimeout(() => itemEl.removeClass("is-trace-highlighted"), 1600);
  }

  private setExpandablePayload(container: HTMLElement, payload: unknown) {
    if (payload === undefined || payload === null) {
      return;
    }

    const existing = container.querySelector(".agentic-researcher-payload");
    existing?.remove();
    const detailsEl = container.createEl("details", {
      cls: "agentic-researcher-payload",
    });
    detailsEl.addEventListener("click", (event) => event.stopPropagation());
    detailsEl.createEl("summary", { text: "Details" });
    detailsEl.createEl("pre", {
      text: this.truncateForDetails(JSON.stringify(payload, null, 2)),
    });
  }

  private createCopyButton(
    container: HTMLElement,
    getText: () => string,
    label: string,
  ) {
    const buttonEl = container.createEl("button", {
      cls: "agentic-researcher-copy",
      attr: {
        type: "button",
        "aria-label": label,
        title: label,
      },
    });
    setIcon(buttonEl, "copy");
    buttonEl.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = getText();
      if (!text) {
        return;
      }

      try {
        await navigator.clipboard.writeText(text);
        new Notice("Copied.");
      } catch (error) {
        new Notice(formatModelClientError(error));
      }
    });
  }

  private createOpenNoteButton(container: HTMLElement, path: string) {
    if (!path.toLowerCase().endsWith(".md")) {
      return;
    }

    const buttonEl = container.createEl("button", {
      cls: "agentic-researcher-open-note",
      attr: {
        type: "button",
        "aria-label": "Open note",
        title: "Open note",
      },
    });
    setIcon(buttonEl, "file-text");
    buttonEl.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const file = this.plugin.app.vault.getFileByPath(path);
      if (!file) {
        new Notice(`Note not found: ${path}`);
        return;
      }

      await this.plugin.app.workspace.getLeaf(false).openFile(file);
    });
  }

  private appendText(element: HTMLElement | null, text: string) {
    if (!element) {
      return;
    }

    element.textContent = `${element.textContent ?? ""}${text}`;
  }

  private nextChatMessageId(): string {
    this.chatMessageSequence += 1;
    return `chat-${this.chatMessageSequence}`;
  }

  private truncateForDetails(text: string): string {
    const maxChars = 2500;
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated]`;
  }

  private getCurrentStepNumber(): number {
    const value = this.stepValueEl?.textContent ?? "1";
    const step = Number.parseInt(value, 10);
    return Number.isFinite(step) && step > 0 ? step : 1;
  }

  private formatStepMetric(step: number): string {
    return `${step} used (max ${MAX_AGENT_STEPS})`;
  }

  private formatStopReason(stopReason: AgentRunCompleteEvent["stopReason"]) {
    switch (stopReason) {
      case "write_completed":
        return "Write complete";
      case "clarifying_question":
        return "Needs clarification";
      case "budget":
        return "Stopped at safety limit";
      case "error":
        return "Error";
      case "final":
      default:
        return "Done";
    }
  }

  private formatPhase(phase: AgentRunPhase): string {
    return phase
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
}
