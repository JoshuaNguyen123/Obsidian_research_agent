import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type AgenticResearcherPlugin from "../main";
import {
  MAX_AGENT_STEPS,
  type AgentRunCompleteEvent,
  type AgentRunConfigEvent,
  type AgentRunEvents,
  type AgentRunMetricEvent,
  type AgentRunPhase,
  type AgentRunReceipt,
  type AgentRunStopReason,
  type CodeOutputEvent,
  type AgentStreamLifecycleEvent,
  type AgentTraceEvent,
  type AgentToolRunEvent,
} from "./AgentRunner";
import {
  type ApprovalDecision,
  type ApprovalRequest,
} from "./agent/approvalBroker";
import {
  approvalDeniedFailureCopy,
  claimGroundingFailureCopy,
  formatFailureCopy,
} from "./agent/failureCopy";
import { formatModelClientError } from "./model/types";
import { renderSandboxedHtmlPreview } from "./ui/htmlPreview";
import { getConnectedRegistryElement } from "./ui/connectedElementRegistry";
import {
  readLatestMissionLedger,
  type MissionLedgerSummary,
} from "./agent/missionLedger";
import { buildMissionResumePlan } from "./agent/missionResume";
import {
  computeProofDebt,
  proofDebtSnapshotFromLedger,
  proofDebtSnapshotFromRuntime,
} from "./agent/proofDebt";
import { readMissionRuntimeSnapshotByRunId } from "./agent/runStore";
import type { RunOutcome } from "./agent/runCoordinator";
import type { OrchestratorSnapshotV1 } from "./orchestrator/types";
import { inferCapabilitySetupTarget } from "./agent/capabilitySetup";
import {
  OrchestratorTab,
  type OrchestratorDetailsTarget,
} from "./ui/OrchestratorTab";
import {
  projectMissionGraphRunDetails,
  type MissionGraphRunDetailsProjectionV1,
} from "../packages/headless-runtime/src/missionGraphProjection";

export const AGENT_VIEW_TYPE = "agentic-researcher-view";

const MAX_STATUS_ROWS = 200;
const MAX_TRACE_ROWS = 400;
const MAX_TOOL_ROWS = 200;
const MAX_RECEIPT_ROWS = 256;
const MAX_CODE_OUTPUT_ROWS = 100;
const MAX_VERIFICATION_ROWS = 100;
const MAX_DETAIL_ROWS = 100;

type LogKind = "system" | "user" | "assistant" | "error";
type AgentViewTab = "chat" | "orchestrator" | "details";

interface MissionAcceptanceChecklist {
  status: string;
  confidence?: number;
  missing: string[];
  reasons: string[];
  nextAction?: string;
  checkedAt?: string;
}

export class AgentView extends ItemView {
  private readonly plugin: AgenticResearcherPlugin;
  private logEl: HTMLElement | null = null;
  private promptEl: HTMLTextAreaElement | null = null;
  private runButtonEl: HTMLButtonElement | null = null;
  private chatOnlyToggleEl: HTMLInputElement | null = null;
  private clearButtonEl: HTMLButtonElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private chatTabButtonEl: HTMLButtonElement | null = null;
  private orchestratorTabButtonEl: HTMLButtonElement | null = null;
  private detailsTabButtonEl: HTMLButtonElement | null = null;
  private chatPanelEl: HTMLElement | null = null;
  private orchestratorPanelEl: HTMLElement | null = null;
  private detailsPanelEl: HTMLElement | null = null;
  private orchestratorTab: OrchestratorTab | null = null;
  private orchestratorSnapshot: OrchestratorSnapshotV1 | null = null;
  private orchestratorReferenceRunId: string | null = null;
  private resumeBannerEl: HTMLElement | null = null;
  private phaseValueEl: HTMLElement | null = null;
  private stepValueEl: HTMLElement | null = null;
  private activeToolValueEl: HTMLElement | null = null;
  private activityValueEl: HTMLElement | null = null;
  private runStatusEl: HTMLElement | null = null;
  private runStatusTextEl: HTMLElement | null = null;
  private statusStreamEl: HTMLElement | null = null;
  private modelConfigEl: HTMLElement | null = null;
  private missionGraphEl: HTMLElement | null = null;
  private planningStreamEl: HTMLElement | null = null;
  private toolTimelineEl: HTMLElement | null = null;
  private finalStreamEl: HTMLElement | null = null;
  private receiptsEl: HTMLElement | null = null;
  private acceptanceEl: HTMLElement | null = null;
  private browserDetailsEl: HTMLElement | null = null;
  private actionsDetailsEl: HTMLElement | null = null;
  private codeOutputEl: HTMLElement | null = null;
  private milestonesDetailsEl: HTMLElement | null = null;
  private memoryDetailsEl: HTMLElement | null = null;
  private evidenceDetailsEl: HTMLElement | null = null;
  private artifactsDetailsEl: HTMLElement | null = null;
  private verificationEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private runLogEl: HTMLElement | null = null;
  private chatLoaderEl: HTMLElement | null = null;
  private chatLoaderTextEl: HTMLElement | null = null;
  private liveAssistantMessageEl: HTMLElement | null = null;
  private livePlanningMessageEl: HTMLElement | null = null;
  private liveFinalMessageEl: HTMLElement | null = null;
  private readonly toolTimelineItems = new Map<string, HTMLElement>();
  private readonly chatMessageEls = new Map<string, HTMLElement>();
  private readonly traceRowEls = new Map<string, HTMLElement>();
  private readonly approvalCardEls = new Map<string, HTMLElement>();
  private readonly receiptKeys = new Set<string>();
  private readonly dismissedResumeRunIds = new Set<string>();
  private activeTab: AgentViewTab = "chat";
  private isRunning = false;
  private isClearingChat = false;
  private clearConfirmPending = false;
  private clearConfirmTimeout: number | null = null;
  private resumeBannerRequestId = 0;
  private missionSubmittedSinceOpen = false;
  private stopRequested = false;
  private unsubscribeRunEvents: (() => void) | null = null;
  private readonly runningStateSyncTimers: number[] = [];
  private pendingAssistantContent = "";
  private chatMessageSequence = 0;
  private currentRunChatId: string | null = null;
  private runConfig: AgentRunConfigEvent | null = null;
  private missionGraphProjection: MissionGraphRunDetailsProjectionV1 | null = null;
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
    this.plugin.registerAgentView(this);
    const coordinatorSnapshot = this.plugin.getMissionRunSnapshot();
    const missionRunningAtOpen = coordinatorSnapshot.isRunning;
    this.render();
    this.refreshDurableMissionProjection();
    this.pendingAssistantContent = "";
    if (missionRunningAtOpen) {
      this.stopRequested = coordinatorSnapshot.state === "stopping";
      this.setRunning(true, "SYS> mission still running");
      this.updateChatLoader(
        this.stopRequested
          ? "SYS> reattached while mission is stopping"
          : "SYS> reattached to active mission",
      );
      if (this.stopRequested && this.runStatusTextEl) {
        this.runStatusTextEl.setText("Stopping mission...");
      }
    }
    this.unsubscribeRunEvents?.();
    this.unsubscribeRunEvents = this.plugin.subscribeMissionEvents(
      this.createRunEventHandlers(),
      {
        replay:
          missionRunningAtOpen ||
          coordinatorSnapshot.lastMissionGraph !== null,
      },
    );
    if (this.plugin.isMissionRunning()) {
      this.setRunning(true, "SYS> reattached to active mission");
    }
    this.scheduleRunningStateSync();
    if (!missionRunningAtOpen) {
      this.renderModelConfig();
    }
  }

  async onClose() {
    this.clearRunningStateSyncTimers();
    this.unsubscribeRunEvents?.();
    this.unsubscribeRunEvents = null;
    this.plugin.unregisterAgentView(this);
    this.setClearConfirmPending(false);
    this.orchestratorTab?.destroy();
    this.orchestratorTab = null;
    this.contentEl.empty();
  }

  refreshExternalActionReceipts(): void {
    const snapshot = this.plugin.getMissionRunSnapshot();
    const visibleRunId =
      this.runConfig?.runId?.trim() ||
      (snapshot.persistedProjection ? snapshot.runId?.trim() : null) ||
      null;
    for (const receipt of this.plugin.getExternalActionReceipts()) {
      if (visibleRunId && receipt.runId !== visibleRunId) {
        continue;
      }
      this.appendReceipt({ ...receipt, output: receipt });
    }
  }

  canStartMission(): boolean {
    return !this.isRunning && !this.plugin.isMissionRunning();
  }

  refreshConversationLog() {
    this.renderConversationLog();
  }

  /** Refreshes the restart-safe Run Details projection from coordinator state. */
  refreshDurableMissionProjection(): void {
    const snapshot = this.plugin.getMissionRunSnapshot();
    const persistedRunId = snapshot.persistedProjection
      ? snapshot.runId?.trim() || null
      : null;
    const visibleRunChanged = Boolean(
      persistedRunId &&
        ((this.runConfig && this.runConfig.runId !== persistedRunId) ||
          (this.missionGraphProjection &&
            this.missionGraphProjection.missionId !== persistedRunId)),
    );
    if (visibleRunChanged) {
      // A persisted projection can arrive while this panel remains mounted.
      // Never combine the reconciled graph/ledger with a previous run's local
      // config or receipt DOM.
      this.runConfig = null;
      this.missionSubmittedSinceOpen = false;
      this.receiptKeys.clear();
      this.setSectionPlaceholder(this.receiptsEl, "No receipts yet.");
    }
    this.missionGraphProjection = snapshot.lastMissionGraph
      ? projectMissionGraphRunDetails(snapshot.lastMissionGraph)
      : null;
    this.renderMissionGraph();
    this.renderModelConfig();
    this.renderMissionAcceptance(
      snapshot.lastMissionLedger?.acceptance ?? null,
      "ledger",
    );
  }

  /** Keeps the Orchestrator tab mounted; Chat remains the landing tab. */
  refreshOrchestratorAvailability(): void {
    const loaded = this.plugin.getLatestOrchestratorSnapshot();
    const next =
      loaded && !this.shouldAcceptOrchestratorSnapshot(loaded)
        ? this.orchestratorSnapshot
        : loaded;
    this.orchestratorSnapshot = next;
    if (!this.orchestratorTabButtonEl) {
      this.mountOrchestratorSurface(next);
      return;
    }
    if (!this.orchestratorTab) return;
    if (next) {
      this.orchestratorTab.update(next);
      this.syncOrchestratorRunDetailReferences(next);
    } else {
      this.orchestratorTab.renderEmpty();
    }
  }

  async submitMissionPrompt(
    prompt: string,
    options?: { forceChatOnly?: boolean },
  ): Promise<RunOutcome | null> {
    if (this.isRunning || this.plugin.isMissionRunning() || !this.promptEl) {
      return null;
    }
    this.promptEl.value = prompt;
    if (this.chatOnlyToggleEl) {
      this.chatOnlyToggleEl.checked = options?.forceChatOnly === true;
    }
    this.focusPrompt({ moveCaretToEnd: true });
    return this.capturePrompt();
  }

  private render() {
    const container = this.contentEl;
    // Obsidian may reopen the same ItemView instance after onClose emptied its
    // DOM. Never let element registries from the previous mount participate in
    // replay deduplication or row-cap accounting for the new mount.
    this.resetDomBackedState();
    container.empty();
    container.addClass("agentic-researcher-view");
    this.orchestratorSnapshot = this.plugin.getLatestOrchestratorSnapshot();

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
    if (this.shouldShowOrchestrator()) {
      this.orchestratorPanelEl = container.createDiv({
        cls: "agentic-researcher-tab-panel",
      });
      this.orchestratorTab = new OrchestratorTab(this.orchestratorPanelEl, {
        onNavigateToRunDetails: (target) =>
          this.navigateFromOrchestrator(target),
      });
    }
    this.detailsPanelEl = container.createDiv({
      cls: "agentic-researcher-tab-panel",
    });

    this.renderChat(this.chatPanelEl);
    if (this.orchestratorSnapshot && this.orchestratorTab) {
      this.orchestratorTab.render(this.orchestratorSnapshot);
    } else {
      this.orchestratorTab?.renderEmpty();
    }
    this.renderDashboard(this.detailsPanelEl);
    if (this.orchestratorSnapshot) {
      this.syncOrchestratorRunDetailReferences(this.orchestratorSnapshot);
    }
    this.setActiveTab(this.activeTab);
  }

  private resetDomBackedState() {
    this.toolTimelineItems.clear();
    this.chatMessageEls.clear();
    this.traceRowEls.clear();
    this.approvalCardEls.clear();
    this.receiptKeys.clear();
    this.chatLoaderEl = null;
    this.chatLoaderTextEl = null;
    this.liveAssistantMessageEl = null;
    this.livePlanningMessageEl = null;
    this.liveFinalMessageEl = null;
    this.orchestratorTab?.destroy();
    this.orchestratorTab = null;
    this.orchestratorReferenceRunId = null;
    this.tabsEl = null;
    this.orchestratorTabButtonEl = null;
    this.orchestratorPanelEl = null;
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
    this.tabsEl = tabsEl;
    if (this.shouldShowOrchestrator()) {
      tabsEl.addClass("has-orchestrator");
      this.orchestratorTabButtonEl = tabsEl.createEl("button", {
        text: "Orchestrator",
        cls: "agentic-researcher-tab",
        attr: {
          type: "button",
          role: "tab",
          "aria-selected": "false",
        },
      });
    }
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
    this.orchestratorTabButtonEl?.addEventListener("click", () =>
      this.setActiveTab("orchestrator"),
    );
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
    this.resumeBannerEl = container.createDiv({
      cls: "agentic-researcher-resume-banner is-hidden",
    });
    this.resumeBannerEl.hide();
    void this.renderStartupResumeBanner();

    const formEl = container.createEl("form", {
      cls: "agentic-researcher-form",
    });

    this.promptEl = formEl.createEl("textarea", {
      cls: "agentic-researcher-prompt",
      attr: {
        placeholder: "Ask a research question...",
        rows: "5",
        "aria-label": "Ask a research question",
        tabindex: "0",
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

    const chatOnlyLabelEl = actionsEl.createEl("label", {
      cls: "agentic-researcher-chat-only-toggle",
      attr: {
        title: "Keep this run in chat without writing to the active note.",
      },
    });
    this.chatOnlyToggleEl = chatOnlyLabelEl.createEl("input", {
      cls: "agentic-researcher-chat-only-input",
      attr: {
        type: "checkbox",
        "aria-label": "Chat only",
      },
    });
    chatOnlyLabelEl.createSpan({
      text: "Chat only",
      cls: "agentic-researcher-chat-only-label",
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
      event.stopPropagation();
      void this.capturePrompt();
    });
    const stopPromptEvent = (event: Event) => {
      event.stopPropagation();
    };
    this.promptEl.addEventListener("pointerdown", stopPromptEvent, {
      capture: true,
    });
    this.promptEl.addEventListener("mousedown", stopPromptEvent, {
      capture: true,
    });
    this.promptEl.addEventListener("click", stopPromptEvent, {
      capture: true,
    });
    this.promptEl.addEventListener("keydown", (event) => {
      event.stopPropagation();

      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }

      event.preventDefault();
      void this.capturePrompt();
    });
    this.promptEl.addEventListener("keyup", (event) => {
      event.stopPropagation();
    });
    this.runButtonEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.capturePrompt();
    });
    chatOnlyLabelEl.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    chatOnlyLabelEl.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    chatOnlyLabelEl.addEventListener("keydown", (event) => {
      event.stopPropagation();
    });
    chatOnlyLabelEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    this.clearButtonEl.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    this.clearButtonEl.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    this.clearButtonEl.addEventListener("keydown", (event) => {
      event.stopPropagation();
    });
    this.clearButtonEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.clearChat();
    });
  }

  private renderConversationLog() {
    if (!this.logEl) {
      return;
    }

    this.logEl.empty();
    this.chatLoaderEl = null;
    this.chatLoaderTextEl = null;
    this.createLogItem(
      "system",
      "Agent ready. Persistent chat memory is on.",
    );

    for (const message of this.plugin.conversationHistory) {
      this.createLogItem(message.role, message.content);
    }
  }

  private async renderStartupResumeBanner() {
    if (!this.resumeBannerEl) {
      return;
    }

    const requestId = ++this.resumeBannerRequestId;
    this.resumeBannerEl.addClass("is-hidden");
    this.resumeBannerEl.hide();

    if (this.isRunning || this.missionSubmittedSinceOpen) {
      return;
    }

    try {
      const toolContext = this.plugin.createToolExecutionContext("continue");
      const loaded = await readLatestMissionLedger(toolContext);
      if (
        requestId !== this.resumeBannerRequestId ||
        this.isRunning ||
        this.missionSubmittedSinceOpen ||
        !this.resumeBannerEl?.isConnected
      ) {
        return;
      }
      if (!loaded) {
        return;
      }
      const plan = buildMissionResumePlan(loaded.ledger);
      if (!plan.canResume || this.dismissedResumeRunIds.has(loaded.ledger.runId)) {
        return;
      }

      let debt = plan.proofDebt;
      try {
        const runtime = await readMissionRuntimeSnapshotByRunId(
          toolContext,
          loaded.ledger.runId,
        );
        if (runtime?.snapshot) {
          debt = computeProofDebt(
            proofDebtSnapshotFromRuntime(runtime.snapshot, {
              blockers: loaded.ledger.blockers,
              blockerCategory: loaded.ledger.blockerCategory,
              acceptance: loaded.ledger.acceptance,
            }),
          );
        } else {
          debt = computeProofDebt(
            proofDebtSnapshotFromLedger(loaded.ledger),
          );
        }
      } catch {
        debt = plan.proofDebt;
      }

      const nextLine =
        debt.blocked || debt.resumeBlocked
          ? `Blocked: ${debt.nextAction.summary}`
          : !debt.empty
            ? `Next: ${
                debt.nextAction.toolName
                  ? `${debt.nextAction.toolName} — ${debt.nextAction.reason}`
                  : debt.nextAction.summary
              }`
            : null;

      this.resumeBannerEl.empty();
      this.resumeBannerEl.removeClass("is-hidden");
      this.resumeBannerEl.show();
      this.resumeBannerEl.style.removeProperty("display");
      this.resumeBannerEl.createDiv({
        text: `Unfinished run from ${loaded.ledger.updatedAt}: ${loaded.ledger.mission}`,
        cls: "agentic-researcher-resume-banner-text",
      });
      if (nextLine) {
        this.resumeBannerEl.createDiv({
          text: nextLine,
          cls: "agentic-researcher-resume-banner-next",
        });
      }
      const controlsEl = this.resumeBannerEl.createDiv({
        cls: "agentic-researcher-resume-banner-controls",
      });
      if (!debt.resumeBlocked) {
        const setupTarget = debt.blocked
          ? inferCapabilitySetupTarget({
              mission: loaded.ledger.mission,
              summary: debt.nextAction.summary,
              reason: debt.nextAction.reason,
              blockerCategory: loaded.ledger.blockerCategory,
              missing: debt.missing,
              toolName: debt.nextAction.toolName,
            })
          : null;
        const continueButton = controlsEl.createEl("button", {
          text: setupTarget ? "Set up & resume" : "Continue",
          cls: "agentic-researcher-secondary-action",
          attr: { type: "button" },
        });
        continueButton.addEventListener("click", (event) => {
          event.preventDefault();
          if (setupTarget) {
            void this.plugin.openCapabilitySetup(setupTarget, {
              runId: loaded.ledger.runId,
              continuationCommand: plan.continuationCommand,
              reason: debt.nextAction.summary,
            });
            return;
          }
          this.hideStartupResumeBanner();
          void this.submitMissionContinuation(plan.continuationCommand);
        });
      }
      const dismissButton = controlsEl.createEl("button", {
        text: "Dismiss",
        cls: "agentic-researcher-secondary-action",
        attr: { type: "button" },
      });
      dismissButton.addEventListener("click", (event) => {
        event.preventDefault();
        this.dismissedResumeRunIds.add(loaded.ledger.runId);
        this.hideStartupResumeBanner();
      });
    } catch (error) {
      console.warn("Unable to render agent resume banner", error);
    }
  }

  private hideStartupResumeBanner() {
    this.resumeBannerRequestId += 1;
    this.resumeBannerEl?.empty();
    this.resumeBannerEl?.addClass("is-hidden");
    this.resumeBannerEl?.hide();
  }

  private renderDashboard(container: HTMLElement) {
    container.addClass("agentic-researcher-details-panel");

    const dashboardEl = container.createDiv({
      cls: "agentic-researcher-dashboard agentic-researcher-responsive-run-details",
      attr: { "aria-live": "polite" },
    });

    const metricsEl = dashboardEl.createDiv({
      cls: "agentic-researcher-metrics",
    });

    this.phaseValueEl = this.createMetric(metricsEl, "Phase", "Idle");
    this.stepValueEl = this.createMetric(metricsEl, "Step", this.formatStepMetric(0));
    this.activeToolValueEl = this.createMetric(metricsEl, "Active tool", "None");
    this.activityValueEl = this.createMetric(metricsEl, "Activity", "Idle");

    this.modelConfigEl = this.createDashboardSection(
      dashboardEl,
      "Model config",
      "model-config",
    );
    this.missionGraphEl = this.createDashboardSection(
      dashboardEl,
      "Mission",
      "mission-graph",
    );
    this.statusStreamEl = this.createDashboardSection(
      dashboardEl,
      "Status",
      "status",
    );

    const streamsEl = dashboardEl.createDiv({
      cls: "agentic-researcher-stream-grid",
    });

    this.planningStreamEl = this.createDashboardSection(
      streamsEl,
      "Planning",
      "planning",
    );
    this.finalStreamEl = this.createDashboardSection(
      streamsEl,
      "Final answer",
      "final-answer",
    );
    this.toolTimelineEl = this.createDashboardSection(
      dashboardEl,
      "Tool timeline",
      "tool-timeline",
    );
    this.receiptsEl = this.createDashboardSection(
      dashboardEl,
      "Receipts",
      "receipts",
    );
    this.acceptanceEl = this.createDashboardSection(
      dashboardEl,
      "Mission acceptance",
      "acceptance",
    );
    this.browserDetailsEl = this.createDashboardSection(
      dashboardEl,
      "Browser",
      "browser",
    );
    this.actionsDetailsEl = this.createDashboardSection(
      dashboardEl,
      "Actions",
      "actions",
    );
    this.codeOutputEl = this.createDashboardSection(
      dashboardEl,
      "Code output",
      "code-output",
    );
    this.milestonesDetailsEl = this.createDashboardSection(
      dashboardEl,
      "Milestones",
      "milestones",
    );
    this.memoryDetailsEl = this.createDashboardSection(
      dashboardEl,
      "Memory",
      "memory",
    );
    this.evidenceDetailsEl = this.createDashboardSection(
      dashboardEl,
      "Evidence",
      "evidence",
    );
    this.artifactsDetailsEl = this.createDashboardSection(
      dashboardEl,
      "Artifacts",
      "artifacts",
    );
    this.verificationEl = this.createDashboardSection(
      dashboardEl,
      "Verification",
      "verification",
    );
    this.previewEl = this.createDashboardSection(
      dashboardEl,
      "Preview",
      "preview",
    );
    this.runLogEl = this.createDashboardSection(dashboardEl, "Run log", "run-log");

    this.setSectionPlaceholder(this.modelConfigEl, "No run yet.");
    this.setSectionPlaceholder(this.missionGraphEl, "No mission graph yet.");
    this.setSectionPlaceholder(this.statusStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.planningStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.finalStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.toolTimelineEl, "No tools yet.");
    this.setSectionPlaceholder(this.receiptsEl, "No receipts yet.");
    this.setSectionPlaceholder(this.acceptanceEl, "Acceptance not checked yet.");
    this.setSectionPlaceholder(
      this.browserDetailsEl,
      "Live browser embedding is unavailable. Showing screenshot and extracted page state instead.",
    );
    this.setSectionPlaceholder(this.actionsDetailsEl, "No actions yet.");
    this.setSectionPlaceholder(this.codeOutputEl, "No code output yet.");
    this.setSectionPlaceholder(this.milestonesDetailsEl, "No milestones yet.");
    this.setSectionPlaceholder(this.memoryDetailsEl, "No memory activity yet.");
    this.setSectionPlaceholder(this.evidenceDetailsEl, "No evidence yet.");
    this.setSectionPlaceholder(this.artifactsDetailsEl, "No artifacts yet.");
    this.setSectionPlaceholder(this.verificationEl, "No artifacts verified yet.");
    this.setSectionPlaceholder(this.previewEl, "No preview yet.");
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
    key: string,
  ): HTMLElement {
    const sectionEl = container.createDiv({
      cls: `agentic-researcher-dashboard-section agentic-researcher-dashboard-section-${key}`,
    });
    const labelEl = sectionEl.createDiv({
      cls: "agentic-researcher-dashboard-label-row",
    });
    labelEl.createDiv({
      text: label,
      cls: "agentic-researcher-dashboard-label",
    });
    const bodyEl = sectionEl.createDiv({
      cls: `agentic-researcher-dashboard-body agentic-researcher-dashboard-body-${key}`,
    });
    this.createCopyButton(labelEl, () => bodyEl.textContent ?? "", `Copy ${label}`);
    return bodyEl;
  }

  private async capturePrompt(): Promise<RunOutcome | null> {
    if (this.isRunning || this.plugin.isMissionRunning()) {
      this.requestStop();
      return null;
    }

    this.setClearConfirmPending(false);
    const prompt = this.promptEl?.value.trim() ?? "";
    const forceChatOnly = this.chatOnlyToggleEl?.checked === true;

    if (!prompt) {
      this.appendLog("error", "Enter a mission prompt before running.");
      this.promptEl?.focus();
      return null;
    }

    const conversationHistory = [...this.plugin.conversationHistory];
    this.missionSubmittedSinceOpen = true;
    this.hideStartupResumeBanner();
    this.stopRequested = false;
    this.resetDashboardForRun();
    this.pendingAssistantContent = "";
    this.appendStatus("Starting mission...");
    const userLogItem = this.appendLog("user", prompt);
    this.currentRunChatId = userLogItem?.dataset.chatId ?? null;
    this.setRunning(true, "SYS> mission accepted");
    this.updateChatLoader("SYS> mission accepted");

    let outcome: RunOutcome | null = null;
    try {
      await this.plugin.appendConversationMessage({
        role: "user",
        content: prompt,
      });

      if (this.promptEl?.value.trim() === prompt) {
        this.promptEl.value = "";
      }
      if (this.chatOnlyToggleEl) {
        this.chatOnlyToggleEl.checked = false;
      }

      outcome = await this.plugin.runMission(prompt, conversationHistory, {
        forceChatOnly,
      });
    } catch (error) {
      const message = formatModelClientError(error);
      this.updatePhase("error", "Error");
      this.setSectionPlaceholder(this.finalStreamEl, message);
      this.appendLog("error", message);
    } finally {
      this.setRunning(false);
      this.stopRequested = false;
      this.promptEl?.focus();
    }
    return outcome;
  }

  private createRunEventHandlers(): AgentRunEvents {
    return {
      onStatus: (message) => this.appendStatus(message),
      onPhaseChange: (phase, message) => this.updatePhase(phase, message),
      onPlanningStart: (step) => this.startPlanningStream(step),
      onPlanningDelta: (delta) => this.appendPlanningDelta(delta),
      onPlanningDone: () => this.finishPlanningStream(),
      onToolStart: (event) => this.handleToolStart(event),
      onToolDone: (event) => this.handleToolDone(event),
      onFinalStart: () => this.startFinalStream(),
      onFinalDelta: (delta) => this.appendFinalDelta(delta),
      onFinalReplace: (content) => this.replaceFinalContent(content),
      onFinalDone: () => this.finishFinalStream(),
      onReceipt: (receipt) => this.appendReceipt(receipt),
      onAssistantMessageStart: () => this.startLiveAssistantMessage(),
      onAssistantDelta: (delta) => this.appendAssistantDelta(delta),
      onAssistantReplace: (content) => this.replaceAssistantContent(content),
      onAssistantMessageDone: () => this.finishLiveAssistantMessage(),
      onThinkingMessageStart: () => this.startLiveThinkingMessage(),
      onThinkingDelta: () => undefined,
      onThinkingMessageDone: () => this.finishLiveThinkingMessage(),
      onStreamLifecycle: (event) => this.handleStreamLifecycle(event),
      onMetric: (event) => this.appendMetric(event),
      onRunConfig: (event) => this.handleRunConfig(event),
      onRunComplete: (event) => this.handleRunComplete(event),
      onApprovalRequest: (request) => this.renderApprovalRequest(request),
      onApprovalResolved: (event) =>
        this.renderApprovalResolved(event.request, event.decision),
      onCodeOutput: (event) => this.appendCodeOutput(event),
      onTrace: (event) => this.appendTraceEvent(event),
      onMissionGraphUpdate: (graph) => {
        this.missionGraphProjection = projectMissionGraphRunDetails(graph);
        this.renderMissionGraph();
      },
      onOrchestratorEvent: (_event, snapshot) => {
        if (!this.shouldAcceptOrchestratorSnapshot(snapshot)) {
          return;
        }
        this.orchestratorSnapshot = snapshot;
        if (!this.orchestratorTabButtonEl) {
          this.refreshOrchestratorAvailability();
          return;
        }
        this.orchestratorTab?.update(snapshot);
        this.syncOrchestratorRunDetailReferences(snapshot);
      },
    };
  }

  private requestStop() {
    if (
      (!this.isRunning && !this.plugin.isMissionRunning()) ||
      this.stopRequested
    ) {
      return;
    }

    this.stopRequested = true;
    this.plugin.requestMissionStop();
    this.appendStatus("Stop requested. Finishing current operation...");
    this.updateChatLoader("SYS> stop requested");
    this.updatePhase("stopped", "Stop requested");
    this.updateRunButtonState();

    if (this.runStatusTextEl) {
      this.runStatusTextEl.setText("Stopping mission...");
    }
  }

  private scheduleRunningStateSync() {
    this.clearRunningStateSyncTimers();
    const sync = () => {
      const snapshot = this.plugin.getMissionRunSnapshot();
      if (snapshot.isRunning) {
        this.stopRequested = snapshot.state === "stopping";
        this.setRunning(true, "SYS> reattached to active mission");
        if (this.stopRequested && this.runStatusTextEl) {
          this.runStatusTextEl.setText("Stopping mission...");
        }
      }
    };
    this.runningStateSyncTimers.push(
      window.setTimeout(sync, 0),
      window.setTimeout(sync, 100),
      window.setTimeout(sync, 500),
    );
  }

  private clearRunningStateSyncTimers() {
    for (const timer of this.runningStateSyncTimers.splice(0)) {
      window.clearTimeout(timer);
    }
  }

  private async clearChat() {
    if (this.isRunning || this.isClearingChat) {
      return;
    }

    if (!this.clearConfirmPending) {
      this.setClearConfirmPending(true);
      this.appendStatus(
        "Click Confirm clear to clear chat history only. Notes, memory, backups, receipts, and settings are unchanged.",
      );
      this.restorePromptInteractivity();
      return;
    }

    this.isClearingChat = true;
    this.setClearConfirmPending(false);

    try {
      await this.plugin.clearConversationHistory();
      this.pendingAssistantContent = "";
      this.liveAssistantMessageEl = null;
      this.renderConversationLog();
    } finally {
      this.isClearingChat = false;
      this.restorePromptInteractivity();
    }
  }

  private restorePromptInteractivity() {
    this.setActiveTab("chat");
    this.setRunning(false);
    this.setChatLoaderActive(false);
    this.updateRunButtonState();
    this.focusPrompt({ moveCaretToEnd: true });

    const promptEl = this.promptEl;
    if (!promptEl) {
      return;
    }

    const focus = () => {
      this.focusPrompt({ moveCaretToEnd: true });
    };

    window.setTimeout(focus, 0);
    window.setTimeout(focus, 50);
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focus);
    }
  }

  private focusPrompt(options: { moveCaretToEnd?: boolean } = {}) {
    const promptEl = this.promptEl;
    if (!promptEl || !promptEl.isConnected) {
      return;
    }

    promptEl.disabled = false;
    promptEl.removeAttribute("aria-disabled");
    promptEl.focus({ preventScroll: true });
    if (options.moveCaretToEnd) {
      promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
    }
  }

  private resetDashboardForRun() {
    this.toolTimelineItems.clear();
    this.traceRowEls.clear();
    this.approvalCardEls.clear();
    this.receiptKeys.clear();
    this.livePlanningMessageEl = null;
    this.liveFinalMessageEl = null;
    this.runConfig = null;
    this.missionGraphProjection = null;
    this.usageTotals = this.createEmptyUsageTotals();
    this.updatePhase("idle", "Queued");
    this.setMetric(this.stepValueEl, this.formatStepMetric(0));
    this.setMetric(this.activeToolValueEl, "None");
    this.setMetric(this.activityValueEl, "Queued");
    this.setSectionPlaceholder(this.modelConfigEl, "Starting run.");
    this.setSectionPlaceholder(this.missionGraphEl, "Building mission graph.");
    this.setSectionPlaceholder(this.statusStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.planningStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.finalStreamEl, "Waiting.");
    this.setSectionPlaceholder(this.toolTimelineEl, "No tools yet.");
    this.setSectionPlaceholder(this.receiptsEl, "No receipts yet.");
    this.setSectionPlaceholder(this.acceptanceEl, "Acceptance not checked yet.");
    this.setSectionPlaceholder(
      this.browserDetailsEl,
      "Live browser embedding is unavailable. Showing screenshot and extracted page state instead.",
    );
    this.setSectionPlaceholder(this.actionsDetailsEl, "No actions yet.");
    this.setSectionPlaceholder(this.codeOutputEl, "No code output yet.");
    this.setSectionPlaceholder(this.milestonesDetailsEl, "No milestones yet.");
    this.setSectionPlaceholder(this.memoryDetailsEl, "No memory activity yet.");
    this.setSectionPlaceholder(this.evidenceDetailsEl, "No evidence yet.");
    this.setSectionPlaceholder(this.artifactsDetailsEl, "No artifacts yet.");
    this.setSectionPlaceholder(this.verificationEl, "No artifacts verified yet.");
    this.setSectionPlaceholder(this.previewEl, "No preview yet.");
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
    this.trimRows(
      this.statusStreamEl,
      ".agentic-researcher-status-line",
      MAX_STATUS_ROWS,
    );
    this.statusStreamEl.scrollTop = this.statusStreamEl.scrollHeight;
    if (kind === "status") {
      this.updateChatLoader(message);
    }
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
    this.updateChatLoader(`RUN> ${event.name}`);

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
    this.renderToolVerification(event);
    this.renderToolPreview(event);
    this.setMetric(this.activeToolValueEl, "None");
    this.updateChatLoader(event.message ?? `${event.name} complete`);
    this.appendTrace(
      ok ? "tool" : "error",
      event.message ?? `${event.name} ${ok ? "complete" : "error"}`,
    );
  }

  private renderToolVerification(event: AgentToolRunEvent) {
    if (!this.verificationEl || event.ok === false || !isPlainRecord(event.output)) {
      return;
    }

    const message = this.getVerificationMessage(event.name, event.output);
    if (!message) {
      return;
    }

    this.clearPlaceholder(this.verificationEl);
    const rowEl = this.verificationEl.createDiv({
      cls: "agentic-researcher-verification-row",
    });
    rowEl.dataset.verificationId = event.id;
    rowEl.createSpan({
      text: event.name,
      cls: "agentic-researcher-verification-kind",
    });
    rowEl.createSpan({
      text: message,
      cls: "agentic-researcher-verification-message",
    });
    this.trimRows(
      this.verificationEl,
      ".agentic-researcher-verification-row",
      MAX_VERIFICATION_ROWS,
    );
  }

  private renderClaimGroundingVerification(event: AgentTraceEvent) {
    if (!this.verificationEl || !isPlainRecord(event.outputPreview)) {
      return;
    }
    const kind = event.outputPreview.kind;
    if (kind === "evidence_conflicts") {
      this.renderEvidenceConflictsVerification(event.outputPreview, event.id);
      return;
    }
    if (kind !== "claim_grounding") {
      return;
    }
    const claimLedger = isPlainRecord(event.outputPreview.claimLedger)
      ? event.outputPreview.claimLedger
      : null;
    const claimCount =
      typeof claimLedger?.claimCount === "number"
        ? claimLedger.claimCount
        : null;
    const grounded =
      typeof claimLedger?.grounded === "number" ? claimLedger.grounded : null;
    const ungrounded =
      typeof claimLedger?.ungrounded === "number"
        ? claimLedger.ungrounded
        : null;
    const status =
      typeof event.outputPreview.status === "string"
        ? event.outputPreview.status
        : "unknown";
    const nextAction =
      typeof claimLedger?.nextAction === "string" && claimLedger.nextAction.trim()
        ? claimLedger.nextAction.trim()
        : typeof event.outputPreview.message === "string"
          ? event.outputPreview.message
          : event.message;
    const blocked =
      status === "fail" ||
      status === "needs_more_work" ||
      status === "blocked";
    const summary = [
      `claims=${claimCount ?? "?"}`,
      grounded !== null ? `grounded=${grounded}` : null,
      ungrounded !== null ? `ungrounded=${ungrounded}` : null,
      `status=${status}`,
      blocked
        ? formatFailureCopy(claimGroundingFailureCopy(nextAction))
        : nextAction
          ? `next=${nextAction}`
          : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");

    this.clearPlaceholder(this.verificationEl);
    const rowEl = this.verificationEl.createDiv({
      cls: "agentic-researcher-verification-row agentic-researcher-claim-grounding-row",
    });
    rowEl.dataset.verificationId = event.id;
    rowEl.createSpan({
      text: "claim_grounding",
      cls: "agentic-researcher-verification-kind",
    });
    rowEl.createSpan({
      text: summary,
      cls: "agentic-researcher-verification-message",
    });
    this.trimRows(
      this.verificationEl,
      ".agentic-researcher-verification-row",
      MAX_VERIFICATION_ROWS,
    );
  }

  private renderEvidenceConflictsVerification(
    preview: Record<string, unknown>,
    eventId: string,
  ) {
    if (!this.verificationEl) {
      return;
    }
    const openConflicts = Array.isArray(preview.openConflicts)
      ? preview.openConflicts.filter(isPlainRecord)
      : [];
    const openConflictCount =
      typeof preview.openConflictCount === "number"
        ? preview.openConflictCount
        : openConflicts.length;
    const status =
      typeof preview.status === "string" ? preview.status : "unknown";
    if (openConflictCount === 0 && openConflicts.length === 0) {
      return;
    }
    this.clearPlaceholder(this.verificationEl);
    const summary = [
      `open=${openConflictCount}`,
      `status=${status}`,
      ...openConflicts.slice(0, 4).map((item) => {
        const id = typeof item.id === "string" ? item.id : "conflict";
        const text =
          typeof item.summary === "string" ? item.summary : id;
        return text;
      }),
    ].join(" · ");
    const rowEl = this.verificationEl.createDiv({
      cls: "agentic-researcher-verification-row agentic-researcher-evidence-conflicts-row",
    });
    rowEl.dataset.verificationId = eventId;
    rowEl.createSpan({
      text: "evidence_conflicts",
      cls: "agentic-researcher-verification-kind",
    });
    rowEl.createSpan({
      text: summary,
      cls: "agentic-researcher-verification-message",
    });
    this.trimRows(
      this.verificationEl,
      ".agentic-researcher-verification-row",
      MAX_VERIFICATION_ROWS,
    );
  }

  private getVerificationMessage(
    toolName: string,
    output: Record<string, unknown>,
  ): string | null {
    if (toolName === "create_design_canvas") {
      return `Canvas verified: ${String(output.nodeCount ?? 0)} nodes, ${String(output.edgeCount ?? 0)} edges.`;
    }

    if (toolName === "create_svg_design") {
      return `SVG verified: ${String(output.shapeCount ?? 0)} shapes.`;
    }

    if (toolName === "render_html_preview" || output.previewHtml) {
      return `HTML preview ready: ${String(output.bytesRendered ?? "srcdoc")} bytes.`;
    }

    if (toolName === "run_code_block") {
      const result = isPlainRecord(output.result)
        ? output.result
        : isPlainRecord(output.run)
          ? output.run
          : null;
      if (!result) {
        return output.previewHtml ? "HTML code preview ready." : null;
      }

      const exitCode = result.exitCode;
      const timedOut = result.timedOut === true;
      return timedOut
        ? "Code run timed out and was stopped."
        : `Code run completed with exit code ${String(exitCode ?? "unknown")}.`;
    }

    if (toolName === "open_web_source") {
      return `Source note saved: ${String(output.path ?? "Agent Sources")}.`;
    }

    return null;
  }

  private renderToolPreview(event: AgentToolRunEvent) {
    if (!this.previewEl || event.ok === false || !isPlainRecord(event.output)) {
      return;
    }

    const previewHtml = event.output.previewHtml;
    if (typeof previewHtml !== "string" || previewHtml.trim().length === 0) {
      return;
    }

    this.previewEl.empty();
    renderSandboxedHtmlPreview(this.previewEl, previewHtml, {
      title: "Agent HTML preview",
    });
  }

  private handleRunComplete(event: AgentRunCompleteEvent) {
    this.appendSilentTurnFallbackIfNeeded(event);
    this.setMetric(this.stepValueEl, this.formatStepMetric(event.step, event.maxSteps));
    this.setMetric(this.phaseValueEl, this.formatStopReason(event.stopReason));
    this.setMetric(this.activityValueEl, this.formatStopReason(event.stopReason));
    this.setMetric(this.activeToolValueEl, "None");
    this.appendTrace("complete", this.formatStopReason(event.stopReason));
    this.renderModelConfig();
    this.stopRequested = false;
    this.setRunning(false);
    this.currentRunChatId = null;
  }

  private appendSilentTurnFallbackIfNeeded(event: AgentRunCompleteEvent) {
    if (!this.currentRunChatId || this.pendingAssistantContent.trim()) {
      return;
    }

    const message = this.getSilentTurnFallbackMessage(event.stopReason);
    this.appendLog("assistant", message);
    this.pendingAssistantContent = message;
    void this.plugin.appendConversationMessage({
      role: "assistant",
      content: message,
    });
  }

  private getSilentTurnFallbackMessage(stopReason: AgentRunStopReason): string {
    if (stopReason === "user_stopped") {
      return "Stopped. Send the next message when you are ready and I will continue from this chat.";
    }

    if (stopReason === "budget") {
      return "I paused before producing a visible answer because the run hit its budget. Ask me to continue and I will keep going from this chat.";
    }

    if (stopReason === "error") {
      return "I could not complete that turn before producing a visible answer. Check Run Details for the blocker, then send the next message and I will continue from this chat.";
    }

    return "I finished that turn but did not receive visible answer text. Send the next message and I will continue from this chat.";
  }

  private renderApprovalRequest(request: ApprovalRequest) {
    if (!this.actionsDetailsEl) {
      return;
    }

    this.clearPlaceholder(this.actionsDetailsEl);
    const cardEl = this.actionsDetailsEl.createDiv({
      cls: "agentic-researcher-approval-card",
    });
    cardEl.createDiv({
      text: `${request.toolName}: ${request.action}`,
      cls: "agentic-researcher-approval-title",
    });
    cardEl.createDiv({
      text: request.reason,
      cls: "agentic-researcher-approval-reason",
    });
    cardEl.createDiv({
      text: `policy=${request.policyTags.join(",") || "approval_required"}`,
      cls: "agentic-researcher-approval-meta",
    });
    if (request.preparedAction) {
      const prepared = request.preparedAction;
      const previewEl = cardEl.createDiv({
        cls: "agentic-researcher-approval-preview",
      });
      previewEl.createDiv({
        text: prepared.preview.destination,
        cls: "agentic-researcher-approval-destination",
      });
      previewEl.createDiv({
        text: prepared.preview.summary,
        cls: "agentic-researcher-approval-summary",
      });
      const targetParts = [
        `${prepared.target.system}:${prepared.target.resourceType}`,
        prepared.target.identifier ?? prepared.target.id,
        prepared.target.url,
      ].filter((item): item is string => Boolean(item));
      previewEl.createDiv({
        text: `target=${targetParts.join(" ")}`,
        cls: "agentic-researcher-approval-meta",
      });
      if (prepared.preview.before || prepared.preview.after) {
        const diffEl = previewEl.createEl("pre", {
          cls: "agentic-researcher-approval-payload",
        });
        diffEl.setText(
          JSON.stringify(
            {
              before: prepared.preview.before ?? null,
              after: prepared.preview.after ?? null,
            },
            null,
            2,
          ),
        );
      }
      if (prepared.preview.outboundPayload) {
        const payloadEl = previewEl.createEl("pre", {
          cls: "agentic-researcher-approval-payload",
        });
        payloadEl.setText(
          JSON.stringify(prepared.preview.outboundPayload, null, 2),
        );
      }
      if ((prepared.preview.duplicateCandidates?.length ?? 0) > 0) {
        const duplicatesEl = previewEl.createDiv({
          cls: "agentic-researcher-approval-duplicates",
        });
        duplicatesEl.createDiv({
          text: "Possible duplicates",
          cls: "agentic-researcher-approval-summary",
        });
        for (const candidate of prepared.preview.duplicateCandidates ?? []) {
          duplicatesEl.createDiv({
            text: `${candidate.identifier ?? candidate.id}${candidate.url ? ` — ${candidate.url}` : ""}`,
            cls: "agentic-researcher-approval-meta",
          });
        }
      }
      for (const warning of prepared.preview.warnings) {
        previewEl.createDiv({
          text: `warning=${warning}`,
          cls: "agentic-researcher-approval-warning",
        });
      }
      const confirmation = request.requiredConfirmations ?? 1;
      const confirmationIndex = request.confirmationIndex ?? 1;
      previewEl.createDiv({
        text: `fingerprint=${prepared.payloadFingerprint.slice(0, 24)}… outbound=${prepared.preview.outboundBytes}B confirmation=${confirmationIndex}/${confirmation}`,
        cls: "agentic-researcher-approval-meta",
      });
    }
    const controlsEl = cardEl.createDiv({
      cls: "agentic-researcher-approval-controls",
    });
    const approveButton = controlsEl.createEl("button", {
      text:
        request.requiredConfirmations === 2
          ? request.confirmationIndex === 2
            ? "Confirm permanent delete"
            : "Approve deletion"
          : "Approve",
      cls: "agentic-researcher-secondary-action agentic-researcher-approval-approve",
      attr: { type: "button" },
    });
    const denyButton = controlsEl.createEl("button", {
      text: "Deny",
      cls: "agentic-researcher-secondary-action agentic-researcher-approval-deny",
      attr: { type: "button" },
    });
    approveButton.addEventListener("click", (event) => {
      event.preventDefault();
      this.plugin.resolveMissionApproval(request.id, "approved");
    });
    denyButton.addEventListener("click", (event) => {
      event.preventDefault();
      this.plugin.resolveMissionApproval(request.id, "denied");
    });
    this.approvalCardEls.set(request.id, cardEl);
    this.appendTrace("status", `Approval requested: ${request.toolName}`);
  }

  private renderApprovalResolved(
    request: ApprovalRequest,
    decision: ApprovalDecision,
  ) {
    const cardEl = this.approvalCardEls.get(request.id);
    if (!cardEl) {
      return;
    }
    cardEl.addClass(`is-${decision}`);
    cardEl.querySelectorAll("button").forEach((button) => {
      (button as HTMLButtonElement).disabled = true;
    });
    const decisionText =
      decision === "approved"
        ? `decision=approved Approval ${decision}: ${request.toolName}`
        : `decision=${decision} ${formatFailureCopy(
            approvalDeniedFailureCopy(request.toolName, decision),
          )}`;
    cardEl.createDiv({
      text: decisionText,
      cls: "agentic-researcher-approval-meta",
    });
    this.appendTrace("status", decisionText);
  }

  private appendCodeOutput(event: CodeOutputEvent) {
    if (!this.codeOutputEl || !event.chunk) {
      return;
    }

    this.clearPlaceholder(this.codeOutputEl);
    const rowEl = this.codeOutputEl.createDiv({
      cls: `agentic-researcher-code-output-row agentic-researcher-code-output-${event.stream}`,
    });
    rowEl.createSpan({
      text: event.stream,
      cls: "agentic-researcher-code-output-stream",
    });
    rowEl.createSpan({
      text: event.chunk,
      cls: "agentic-researcher-code-output-chunk",
    });
    this.trimRows(
      this.codeOutputEl,
      ".agentic-researcher-code-output-row",
      MAX_CODE_OUTPUT_ROWS,
    );
  }

  private handleStreamLifecycle(event: AgentStreamLifecycleEvent) {
    const streamLabel = this.formatStreamLifecycleLabel(event.kind);
    const parts = [
      `${streamLabel}: ${event.message}`,
      event.bufferedChars !== undefined
        ? `buffered ${this.formatChars(event.bufferedChars)}`
        : null,
      event.releasedChars !== undefined
        ? `released ${this.formatChars(event.releasedChars)}`
        : null,
      `${event.elapsedMs}ms`,
    ].filter((part): part is string => Boolean(part));

    this.appendStatus(parts.join(" "));
    this.updateChatLoader(event.message);
  }

  private formatStreamLifecycleLabel(
    kind: AgentStreamLifecycleEvent["kind"],
  ): string {
    if (kind === "first_visible_content") {
      return "chat_stream";
    }
    if (kind === "first_note_write") {
      return "note_stream";
    }
    return kind;
  }

  private formatReceiptOperationLabel(
    operation: AgentRunReceipt["operation"],
  ): string {
    if (operation === "append") {
      return "note_append";
    }
    if (
      operation === "replace" ||
      operation === "edit" ||
      operation === "retitle"
    ) {
      return "note_replace";
    }
    if (operation === "trash" || operation === "delete") {
      return "note_delete";
    }
    return `note_${operation}`;
  }

  private ensureToolTimelineItem(event: AgentToolRunEvent): HTMLElement {
    const existing = getConnectedRegistryElement(this.toolTimelineItems, event.id);
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
    while (this.toolTimelineItems.size > MAX_TOOL_ROWS) {
      const oldest = this.toolTimelineItems.entries().next().value as
        | [string, HTMLElement]
        | undefined;
      if (!oldest) {
        break;
      }
      oldest[1].remove();
      this.toolTimelineItems.delete(oldest[0]);
      this.ensureCompactionMarker(this.toolTimelineEl);
    }
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

  private replaceFinalContent(content: string) {
    if (!this.finalStreamEl) {
      return;
    }

    if (!this.liveFinalMessageEl) {
      this.startFinalStream();
    }

    this.liveFinalMessageEl?.empty();
    this.appendText(this.liveFinalMessageEl, content);
  }

  private finishFinalStream() {
    this.liveFinalMessageEl = null;
  }

  private appendReceipt(receipt: AgentRunReceipt) {
    if (!this.receiptsEl) {
      return;
    }

    const receiptKey = this.getReceiptKey(receipt);
    if (this.receiptKeys.has(receiptKey)) {
      return;
    }
    this.receiptKeys.add(receiptKey);
    while (this.receiptKeys.size > MAX_RECEIPT_ROWS) {
      const oldest = this.receiptKeys.values().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.receiptKeys.delete(oldest);
    }
    this.clearPlaceholder(this.receiptsEl);

    const stableReceiptId = [
      receipt.toolName,
      receipt.operation,
      receipt.resource
        ? `${receipt.resource.system}:${receipt.resource.resourceType}:${receipt.resource.id}`
        : receipt.path ?? receipt.toPath ?? "vault",
    ].join(":");
    for (const existing of Array.from(
      this.receiptsEl.querySelectorAll<HTMLElement>(
        ".agentic-researcher-orchestrator-reference[data-receipt-id]",
      ),
    )) {
      if (existing.dataset.receiptId === stableReceiptId) existing.remove();
    }
    const receiptEl = this.receiptsEl.createDiv({
      cls: "agentic-researcher-receipt",
      attr: {
        role: "button",
        tabindex: "0",
      },
    });
    receiptEl.dataset.receiptId = stableReceiptId;
    const receiptRunId = receipt.runId?.trim() || this.runConfig?.runId?.trim() || "";
    if (receiptRunId) {
      receiptEl.dataset.runId = receiptRunId;
    }
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
      `receipt=${this.formatReceiptOperationLabel(receipt.operation)}`,
      receipt.bytesWritten !== undefined
        ? `${receipt.bytesWritten} bytes written`
        : null,
      receipt.bytesDeleted !== undefined
        ? `${receipt.bytesDeleted} bytes deleted`
        : null,
      receipt.restoredFromBackupPath
        ? `restored from ${receipt.restoredFromBackupPath}`
        : null,
    ].filter((part): part is string => Boolean(part));

    if (metaParts.length > 0) {
      receiptEl.createDiv({
        text: metaParts.join(" - "),
        cls: "agentic-researcher-receipt-meta",
      });
    }

    this.setExpandablePayload(receiptEl, receipt.output ?? receipt);
    this.trimRows(
      this.receiptsEl,
      ".agentic-researcher-receipt",
      MAX_RECEIPT_ROWS,
    );
    this.appendTrace("receipt", receipt.message);
  }

  private getReceiptKey(receipt: AgentRunReceipt): string {
    return [
      receipt.runId ?? this.runConfig?.runId ?? "",
      receipt.toolName,
      receipt.operation,
      receipt.path ?? "",
      receipt.toPath ?? "",
      receipt.backupPath ?? "",
      receipt.resource
        ? `${receipt.resource.system}:${receipt.resource.resourceType}:${receipt.resource.id}`
        : "",
      receipt.message,
    ].join("|");
  }

  private appendMetric(event: AgentRunMetricEvent) {
    this.updateUsageTotals(event);
    this.renderModelConfig();
    this.appendStatus(this.formatMetric(event), "metric");
  }

  private handleRunConfig(event: AgentRunConfigEvent) {
    this.runConfig = event;
    if (this.plugin.isMissionRunning() && !this.isRunning) {
      this.setRunning(true, "SYS> reattached to active mission");
    }
    this.renderModelConfig();
    this.renderMissionAcceptance(event.missionLedger?.acceptance ?? null, "ledger");
    this.appendTrace(
      "config",
      `Model ${event.model}, mission ${event.missionMode}, streaming ${event.streaming ? "on" : "off"}, write autonomy ${event.writeAutonomy ? "on" : "off"}, note writeback ${event.writebackMode}, chat-only override ${event.chatOnlyOverride ? "on" : "off"}`,
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
        event.cached ? `Cache hit: ${event.name}` : `Timing: ${event.name}`,
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

    const snapshot = this.plugin.getMissionRunSnapshot();
    const awaitingLiveRunConfig =
      this.missionSubmittedSinceOpen && this.runConfig === null;
    if (!awaitingLiveRunConfig && !this.runConfig) {
      const snapshotConfig = snapshot.lastConfig;
      if (snapshotConfig) {
        this.runConfig = snapshotConfig;
      }
    }

    // A newly submitted run resets the dashboard before its live config event
    // arrives. Replaying the previous snapshot in that window leaks historical
    // receipts into the active mission. Active runs receive their vault
    // receipts from live/replayed events; durable external receipts are
    // rehydrated only when their runId matches the visible run.
    if (!this.isRunning) {
      for (const receipt of snapshot.lastReceipts) {
        this.appendReceipt(receipt);
      }
    }
    if (!awaitingLiveRunConfig) {
      this.refreshExternalActionReceipts();
    }

    if (!this.runConfig) {
      if (snapshot.lastMissionLedger) {
        this.renderPersistedMissionConfig(snapshot.lastMissionLedger);
      } else {
        this.renderModelConfigFallback();
      }
      return;
    }

    this.modelConfigEl.empty();
    const scope = this.runConfig.autonomyScope;
    const ledger = this.runConfig.missionLedger;
    const lines = [
      `run_id=${this.runConfig.runId}`,
      `model=${this.runConfig.model}`,
      `provider=${this.runConfig.modelProvider ?? "ollama"}`,
      `base=${this.runConfig.base}`,
      `mission=${this.runConfig.missionMode}`,
      `context_scope=${this.runConfig.contextScope}`,
      `vault_question=${this.runConfig.vaultContext ? "on" : "off"}`,
      `current_note_context=${this.runConfig.currentNoteContext ? "on" : "off"}`,
      `streaming=${this.runConfig.streaming ? "on" : "off"}`,
      `note_writeback=${this.runConfig.writebackMode}`,
      ...(this.runConfig.noteOutputPlan
        ? [
            `note_output=${this.runConfig.noteOutputPlan.destination}/${this.runConfig.noteOutputPlan.mutation}/${this.runConfig.noteOutputPlan.delivery}/${this.runConfig.noteOutputPlan.title}`,
            `note_output_reason=${this.runConfig.noteOutputPlan.reason}`,
          ]
        : []),
      `chat_only_override=${this.runConfig.chatOnlyOverride ? "on" : "off"}`,
      `route=${this.runConfig.route}`,
      `expected=${this.runConfig.expectedTimeClass}`,
      `step_cap=${this.runConfig.maxStepsForRun}`,
      ...(this.runConfig.budgetProfile
        ? [
            `budget_profile=${this.runConfig.budgetProfile.reason}`,
            `budget_tools=${this.runConfig.budgetProfile.toolSteps}`,
            `budget_finalization_reserve=${this.runConfig.budgetProfile.finalizationReserve}`,
          ]
        : []),
      `slow_path=${this.runConfig.slowPathReason}`,
      `route_reasons=${this.formatScopeList(this.runConfig.routeTraceReasons)}`,
      `allowed_tools=${this.formatScopeList(this.runConfig.allowedToolNames)}`,
      `english_guard=${this.runConfig.englishGuard ? "on" : "off"}`,
      `thinking=${this.runConfig.thinkingMode} (resolved ${this.runConfig.resolvedThink})`,
      `temperature=${this.formatOptionalNumber(this.runConfig.temperature)}`,
      `top_k=${this.formatOptionalNumber(this.runConfig.topK)}`,
      `top_p=${this.formatOptionalNumber(this.runConfig.topP)}`,
      `num_ctx=${this.formatOptionalNumber(this.runConfig.numCtx)}`,
      `estimated_prompt_chars=${this.formatOptionalNumber(this.runConfig.estimatedPromptChars)}`,
      `context_budget_chars=${this.formatOptionalNumber(this.runConfig.contextBudgetChars)}`,
      `write_autonomy=${this.runConfig.writeAutonomy ? "on" : "off"}`,
      `autonomy_read=current_note ${scope.read.currentNote ? "on" : "off"}, vault ${scope.read.vault ? "on" : "off"}, web ${scope.read.web ? "on" : "off"}, files ${this.formatScopeList(scope.read.files)}, folders ${this.formatScopeList(scope.read.folders)}`,
      `autonomy_write=current_note ${scope.write.currentNote ? "on" : "off"}, files ${this.formatScopeList(scope.write.files)}, folders ${this.formatScopeList(scope.write.folders)}, artifacts ${scope.write.artifacts ? "on" : "off"}, research_memory ${scope.write.researchMemory ? "on" : "off"}`,
      `autonomy_destructive=replace_current_note ${scope.destructive.replaceCurrentNote ? "on" : "off"}, delete_current_note ${scope.destructive.deleteCurrentNote ? "on" : "off"}, delete_paths ${scope.destructive.deletePaths ? "on" : "off"}`,
      ...this.runConfig.dependencyStatus.map((dependency) =>
        this.formatDependencyStatusLine(dependency),
      ),
      ...this.plugin.getExtensionStatusLines(),
      ...((this.runConfig.performanceGates ?? [])
        .filter((gate) => gate.status !== "pass")
        .map((gate) => `performance_gate=${gate.name}:${gate.status}:${gate.observed}/${gate.threshold}`)),
      ...(this.runConfig.reflexLabel
        ? [
            `reflex_intent=${this.runConfig.reflexLabel}`,
            `reflex_confidence=${this.formatOptionalNumber(this.runConfig.reflexConfidence)}`,
            `reflex_top_action=${this.runConfig.reflexTopAction ?? "none"}`,
            `reflex_progress=${this.formatOptionalNumber(this.runConfig.reflexProgressScore)}`,
            `reflex_loop_risk=${this.formatOptionalNumber(this.runConfig.reflexLoopRisk)}`,
            `reflex_missing=${this.formatScopeList(this.runConfig.reflexCompletionMissing ?? [])}`,
            `reflex_reason=${this.runConfig.reflexAppliedReason ?? "none"}`,
          ]
        : []),
      ...(ledger
        ? [
            `ledger_status=${ledger.status}`,
            `ledger_acceptance_status=${ledger.acceptance?.status ?? "unchecked"}`,
            `ledger_acceptance_missing=${this.formatScopeList(ledger.acceptance?.missing ?? [])}`,
            `ledger_acceptance_next_action=${ledger.acceptance?.nextAction ?? "none"}`,
            `ledger_evidence=${ledger.evidenceCount}`,
            `ledger_receipts=${ledger.receiptCount}`,
            `ledger_expected_tools=${this.formatScopeList(ledger.expectedTools)}`,
            `ledger_iterations=${ledger.iterationCount}`,
            `ledger_progress=${this.formatOptionalNumber(ledger.progressScore)}`,
            `ledger_stalled_count=${ledger.stalledCount}`,
            `ledger_last_action=${ledger.lastMeaningfulAction ?? "none"}`,
            `ledger_next_action=${ledger.nextAction}`,
            `ledger_remaining_actions=${this.formatScopeList(ledger.remainingActions)}`,
            ...(ledger.missionPlan
              ? [
                  `ledger_mission_plan=${ledger.missionPlan.status}`,
                  `ledger_plan_active_task=${ledger.missionPlan.activeTaskId ?? "none"}`,
                  `ledger_plan_progress=${this.formatOptionalNumber(ledger.missionPlan.progressScore)}`,
                  `ledger_plan_remaining_tasks=${ledger.missionPlan.remainingTasks}`,
                  `ledger_plan_stalled_count=${ledger.missionPlan.stalledCount}`,
                  `ledger_plan_next_action=${ledger.missionPlan.nextAction}`,
                ]
              : []),
            `ledger_continuation=${ledger.continuationCommand}`,
            `ledger_can_resume=${ledger.canResume ? "on" : "off"}`,
            `ledger_blocker=${ledger.blockerCategory ?? "none"}`,
          ]
        : []),
      `usage_chars=request ${this.formatChars(this.usageTotals.requestChars)}, response ${this.formatChars(this.usageTotals.responseChars)}`,
      `usage_tokens=prompt ${this.formatOptionalNumber(this.usageTotals.promptTokens)}, completion ${this.formatOptionalNumber(this.usageTotals.completionTokens)}, total ${this.formatOptionalNumber(this.usageTotals.totalTokens)}`,
    ];

    for (const line of lines) {
      this.modelConfigEl.createDiv({
        text: line,
        cls: "agentic-researcher-config-line",
      });
    }

    this.renderContinuationAction(this.modelConfigEl, ledger);
  }

  private renderPersistedMissionConfig(ledger: MissionLedgerSummary): void {
    if (!this.modelConfigEl) {
      return;
    }
    this.modelConfigEl.empty();
    for (const line of [
      `run_id=${ledger.runId}`,
      "run_config=restored_from_durable_state",
      `ledger_status=${ledger.status}`,
      `ledger_acceptance_status=${ledger.acceptance?.status ?? "unchecked"}`,
      `ledger_acceptance_missing=${this.formatScopeList(ledger.acceptance?.missing ?? [])}`,
      `ledger_evidence=${ledger.evidenceCount}`,
      `ledger_receipts=${ledger.receiptCount}`,
      `ledger_expected_tools=${this.formatScopeList(ledger.expectedTools)}`,
      `ledger_iterations=${ledger.iterationCount}`,
      `ledger_progress=${this.formatOptionalNumber(ledger.progressScore)}`,
      `ledger_last_action=${ledger.lastMeaningfulAction ?? "none"}`,
      `ledger_next_action=${ledger.nextAction}`,
      `ledger_remaining_actions=${this.formatScopeList(ledger.remainingActions)}`,
      `ledger_continuation=${ledger.continuationCommand}`,
      `ledger_can_resume=${ledger.canResume ? "on" : "off"}`,
      `ledger_blocker=${ledger.blockerCategory ?? "none"}`,
      ...this.plugin.getExtensionStatusLines(),
    ]) {
      this.modelConfigEl.createDiv({
        text: line,
        cls: "agentic-researcher-config-line",
      });
    }
    this.renderContinuationAction(this.modelConfigEl, ledger);
  }

  private renderMissionGraph() {
    if (!this.missionGraphEl) {
      return;
    }
    const projection = this.missionGraphProjection;
    if (!projection) {
      this.setSectionPlaceholder(this.missionGraphEl, "No mission graph yet.");
      return;
    }

    this.missionGraphEl.empty();
    const active = projection.activeNode;
    const lines: Array<[string, string]> = [
      ["mission_id", projection.missionId],
      ["objective", projection.objective],
      ["graph_revision", String(projection.revision)],
      ["routing_source", projection.routingSource],
      ["routing_fallback", projection.routingFallbackReason ?? "none"],
      ["active_node", active?.id ?? "none"],
      ["active_objective", active?.objective ?? "none"],
      ["executor", active?.executorId ?? "none"],
      ["execution_host", active?.executionHost ?? "none"],
      ["status", active?.status ?? "terminal"],
      [
        "attempts",
        active ? `${active.attempts}/${active.maxAttempts}` : "none",
      ],
      ["evidence", active?.evidenceIds.join(", ") || "none"],
      ["receipts", active?.receiptIds.join(", ") || "none"],
      ["blocker_code", active?.blocker?.code ?? "none"],
      ["blocker_message", active?.blocker?.message ?? "none"],
      ["required_action", active?.blocker?.requiredAction ?? "none"],
      ["next_action", projection.nextAction],
      [
        "progress",
        `${projection.completedNodeCount}/${projection.totalNodeCount}`,
      ],
    ];

    for (const [key, value] of lines) {
      this.missionGraphEl.createDiv({
        text: `${key}=${value}`,
        cls: "agentic-researcher-config-line agentic-researcher-mission-graph-line",
        attr: { "data-mission-field": key },
      });
    }
  }

  private renderModelConfigFallback() {
    if (!this.modelConfigEl) {
      return;
    }
    const settings = this.plugin.settings;
    const provider = settings.modelProvider ?? "ollama";
    const base = provider === "openai_compatible"
      ? settings.openAiCompatibleBaseUrl
      : settings.ollamaBaseUrl;
    this.modelConfigEl.empty();
    for (const line of [
      `model=${settings.model}`,
      `provider=${provider}`,
      `base=${base}`,
      "run_config=not_started_or_unavailable",
      ...this.plugin.getExtensionStatusLines(),
    ]) {
      this.modelConfigEl.createDiv({
        text: line,
        cls: "agentic-researcher-config-line",
      });
    }
  }

  refreshExtensionCapabilities(): void {
    this.renderModelConfig();
  }

  private formatDependencyStatusLine(
    dependency: AgentRunConfigEvent["dependencyStatus"][number],
  ) {
    return [
      `dependency_${dependency.category}=${dependency.status}`,
      `capability=${dependency.capability}`,
      `summary=${dependency.summary}`,
      `next=${dependency.nextAction}`,
    ].join("; ");
  }

  private renderContinuationAction(
    container: HTMLElement,
    ledger: AgentRunConfigEvent["missionLedger"] | undefined,
  ) {
    if (!ledger?.canResume || !ledger.continuationCommand.trim()) {
      return;
    }

    const actionEl = container.createDiv({
      cls: "agentic-researcher-continuation-action",
    });
    actionEl.createDiv({
      text: `Latest incomplete ledger: ${ledger.runId}`,
      cls: "agentic-researcher-config-line",
    });
    const nextAction =
      ledger.acceptance?.nextAction?.trim() ||
      ledger.nextAction?.trim() ||
      "";
    if (nextAction) {
      actionEl.createDiv({
        text: `Next: ${nextAction}`,
        cls: "agentic-researcher-config-line agentic-researcher-proof-debt-next",
      });
    }
    const buttonEl = actionEl.createEl("button", {
      text: "Continue Latest Run",
      cls: "agentic-researcher-secondary-action",
      attr: {
        type: "button",
        "aria-label": `Continue latest run ${ledger.runId}`,
      },
    });
    buttonEl.disabled = this.isRunning;
    buttonEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.submitMissionContinuation(ledger.continuationCommand);
    });
  }

  async submitMissionContinuation(command: string) {
    if (this.isRunning || !this.promptEl) {
      return;
    }
    this.promptEl.value = command;
    this.focusPrompt({ moveCaretToEnd: true });
    await this.capturePrompt();
  }

  private renderMissionAcceptance(
    acceptance: MissionAcceptanceChecklist | null,
    source: "ledger" | "live",
  ) {
    if (!this.acceptanceEl) {
      return;
    }

    if (!acceptance) {
      this.setSectionPlaceholder(
        this.acceptanceEl,
        "Acceptance not checked yet.",
      );
      return;
    }

    this.acceptanceEl.empty();
    const statusEl = this.acceptanceEl.createDiv({
      cls: `agentic-researcher-acceptance-row agentic-researcher-acceptance-${acceptance.status}`,
    });
    statusEl.createSpan({
      text: "status",
      cls: "agentic-researcher-acceptance-key",
    });
    statusEl.createSpan({
      text: [
        acceptance.status,
        acceptance.confidence !== undefined
          ? `confidence=${this.formatOptionalNumber(acceptance.confidence)}`
          : null,
        `source=${source}`,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" "),
      cls: "agentic-researcher-acceptance-value",
    });

    this.createAcceptanceRow("missing", this.formatScopeList(acceptance.missing));
    this.createAcceptanceRow(
      "next_action",
      acceptance.nextAction?.trim() || "none",
    );
    this.createAcceptanceRow("reasons", this.formatScopeList(acceptance.reasons));
    if (acceptance.checkedAt) {
      this.createAcceptanceRow("checked_at", acceptance.checkedAt);
    }
  }

  private createAcceptanceRow(label: string, value: string) {
    if (!this.acceptanceEl) {
      return;
    }
    const rowEl = this.acceptanceEl.createDiv({
      cls: "agentic-researcher-acceptance-row",
    });
    rowEl.createSpan({
      text: label,
      cls: "agentic-researcher-acceptance-key",
    });
    rowEl.createSpan({
      text: value,
      cls: "agentic-researcher-acceptance-value",
    });
  }

  private formatScopeList(values: string[]) {
    return values.length > 0 ? values.join(",") : "none";
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

  private compactLoaderMessage(message: string): string {
    const normalized = message.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "running";
    }

    const maxChars = 72;
    return normalized.length <= maxChars
      ? normalized
      : `${normalized.slice(0, maxChars - 3)}...`;
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

    this.moveChatLoaderToEnd();
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

  private replaceAssistantContent(content: string) {
    this.pendingAssistantContent = content;

    if (!this.liveAssistantMessageEl) {
      const itemEl = this.createLogItem("assistant");
      this.liveAssistantMessageEl = itemEl?.querySelector(
        ".agentic-researcher-log-message",
      ) as HTMLElement | null;
    }

    this.liveAssistantMessageEl?.empty();
    this.appendText(this.liveAssistantMessageEl, content);

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

  private setRunning(isRunning: boolean, loaderMessage?: string) {
    this.isRunning = isRunning;
    if (isRunning) {
      this.setClearConfirmPending(false);
    }
    this.contentEl.classList.toggle("is-running", isRunning);
    this.contentEl.setAttribute("aria-busy", String(isRunning));

    this.updateRunButtonState();

    if (this.chatOnlyToggleEl) {
      this.chatOnlyToggleEl.disabled = isRunning;
    }

    if (this.clearButtonEl) {
      this.clearButtonEl.disabled = isRunning || this.isClearingChat;
    }

    if (this.runStatusEl) {
      this.runStatusEl.classList.toggle("is-running", isRunning);
    }

    if (this.runStatusTextEl) {
      this.runStatusTextEl.setText(isRunning ? "Running mission..." : "Idle");
    }

    this.setChatLoaderActive(isRunning, loaderMessage);

    this.setMetric(
      this.activityValueEl,
      isRunning ? "Running" : (this.phaseValueEl?.textContent ?? "Idle"),
    );
    this.renderModelConfig();
  }

  private setClearConfirmPending(pending: boolean) {
    this.clearConfirmPending = pending;

    if (this.clearConfirmTimeout !== null) {
      window.clearTimeout(this.clearConfirmTimeout);
      this.clearConfirmTimeout = null;
    }

    if (pending) {
      this.clearConfirmTimeout = window.setTimeout(() => {
        this.setClearConfirmPending(false);
        this.restorePromptInteractivity();
      }, 5000);
    }

    if (!this.clearButtonEl) {
      return;
    }

    this.clearButtonEl.setText(pending ? "Confirm clear" : "Clear chat");
    this.clearButtonEl.classList.toggle("is-confirming", pending);
    this.clearButtonEl.setAttribute(
      "aria-label",
      pending ? "Confirm clear chat history" : "Clear chat",
    );
  }

  private ensureChatLoader(): HTMLElement | null {
    if (this.chatLoaderEl?.isConnected) {
      return this.chatLoaderEl;
    }

    if (!this.logEl) {
      return null;
    }

    this.chatLoaderEl = this.logEl.createDiv({
      cls: "agentic-researcher-chat-loader",
      attr: { "aria-live": "polite", "aria-hidden": "true" },
    });
    const headerEl = this.chatLoaderEl.createDiv({
      cls: "agentic-researcher-chat-loader-header",
    });
    headerEl.createSpan({
      text: "CRT LOAD",
      cls: "agentic-researcher-chat-loader-label",
    });
    this.chatLoaderTextEl = headerEl.createSpan({
      text: "",
      cls: "agentic-researcher-chat-loader-text",
    });
    this.chatLoaderEl.createDiv({
      cls: "agentic-researcher-chat-loader-bar",
      attr: { "aria-hidden": "true" },
    });
    this.moveChatLoaderToEnd();

    return this.chatLoaderEl;
  }

  private setChatLoaderActive(isActive: boolean, loaderMessage?: string) {
    const loaderEl = this.ensureChatLoader();
    if (!loaderEl) {
      return;
    }

    loaderEl.classList.toggle("is-active", isActive);
    loaderEl.setAttribute("aria-hidden", String(!isActive));
    if (this.chatLoaderTextEl) {
      if (isActive) {
        const message =
          loaderMessage?.trim() ||
          this.chatLoaderTextEl.textContent?.trim() ||
          "loading...";
        this.chatLoaderTextEl.setText(this.compactLoaderMessage(message));
      } else {
        this.chatLoaderTextEl.setText("");
      }
    }
    this.moveChatLoaderToEnd();
  }

  private updateChatLoader(message: string) {
    if (!this.isRunning && !this.stopRequested) {
      return;
    }

    const loaderEl = this.ensureChatLoader();
    if (!loaderEl || !this.chatLoaderTextEl) {
      return;
    }

    this.chatLoaderTextEl.setText(this.compactLoaderMessage(message));
    loaderEl.classList.add("is-active");
    loaderEl.setAttribute("aria-hidden", "false");
    this.moveChatLoaderToEnd();
  }

  private moveChatLoaderToEnd() {
    if (!this.logEl || !this.chatLoaderEl?.isConnected) {
      return;
    }

    this.logEl.appendChild(this.chatLoaderEl);
  }

  private updateRunButtonState() {
    if (!this.runButtonEl) {
      return;
    }

    this.runButtonEl.disabled = this.isRunning && this.stopRequested;
    this.runButtonEl.classList.toggle(
      "is-stop",
      this.isRunning && !this.stopRequested,
    );
    this.runButtonEl.classList.toggle(
      "is-stopping",
      this.isRunning && this.stopRequested,
    );
    this.runButtonEl.setAttribute(
      "aria-label",
      this.isRunning
        ? this.stopRequested
          ? "Stopping mission"
          : "Stop mission"
        : "Run Mission",
    );
    this.runButtonEl.setText(
      this.isRunning
        ? this.stopRequested
          ? "Stopping..."
          : "Stop Mission"
        : "Run Mission",
    );
  }

  private mountOrchestratorSurface(
    snapshot: OrchestratorSnapshotV1 | null,
  ): void {
    if (
      this.orchestratorTabButtonEl ||
      !this.tabsEl ||
      !this.detailsTabButtonEl ||
      !this.detailsPanelEl
    ) {
      return;
    }
    this.tabsEl.addClass("has-orchestrator");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agentic-researcher-tab";
    button.textContent = "Orchestrator";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false");
    button.addEventListener("click", () => this.setActiveTab("orchestrator"));
    this.tabsEl.insertBefore(button, this.detailsTabButtonEl);
    this.orchestratorTabButtonEl = button;

    const panel = document.createElement("div");
    panel.className = "agentic-researcher-tab-panel";
    this.detailsPanelEl.parentElement?.insertBefore(panel, this.detailsPanelEl);
    this.orchestratorPanelEl = panel;
    this.orchestratorTab = new OrchestratorTab(panel, {
      onNavigateToRunDetails: (target) =>
        this.navigateFromOrchestrator(target),
    });
    if (snapshot) {
      this.orchestratorTab.render(snapshot);
      this.syncOrchestratorRunDetailReferences(snapshot);
    } else {
      this.orchestratorTab.renderEmpty();
    }
    this.setActiveTab(this.activeTab);
  }

  private unmountOrchestratorSurface(): void {
    if (this.activeTab === "orchestrator") {
      this.setActiveTab("chat");
    }
    this.orchestratorTab?.destroy();
    this.clearOrchestratorRunDetailReferences();
    this.orchestratorPanelEl?.remove();
    this.orchestratorTabButtonEl?.remove();
    this.tabsEl?.removeClass("has-orchestrator");
    this.orchestratorTab = null;
    this.orchestratorPanelEl = null;
    this.orchestratorTabButtonEl = null;
  }

  private setActiveTab(tab: AgentViewTab) {
    if (tab === "orchestrator" && !this.orchestratorTabButtonEl) {
      tab = "chat";
    }
    this.activeTab = tab;
    const isChat = tab === "chat";
    const isOrchestrator = tab === "orchestrator";
    const isDetails = tab === "details";

    this.chatTabButtonEl?.classList.toggle("is-active", isChat);
    this.chatTabButtonEl?.setAttribute("aria-selected", String(isChat));
    this.orchestratorTabButtonEl?.classList.toggle("is-active", isOrchestrator);
    this.orchestratorTabButtonEl?.setAttribute(
      "aria-selected",
      String(isOrchestrator),
    );
    this.detailsTabButtonEl?.classList.toggle("is-active", isDetails);
    this.detailsTabButtonEl?.setAttribute("aria-selected", String(isDetails));

    if (this.chatPanelEl) {
      this.chatPanelEl.hidden = !isChat;
      this.chatPanelEl.classList.toggle("is-active", isChat);
    }

    if (this.detailsPanelEl) {
      this.detailsPanelEl.hidden = !isDetails;
      this.detailsPanelEl.classList.toggle("is-active", isDetails);
    }

    if (this.orchestratorPanelEl) {
      this.orchestratorPanelEl.hidden = !isOrchestrator;
      this.orchestratorPanelEl.classList.toggle("is-active", isOrchestrator);
    }
  }

  private shouldShowOrchestrator(): boolean {
    return true;
  }

  private shouldAcceptOrchestratorSnapshot(
    snapshot: OrchestratorSnapshotV1,
  ): boolean {
    return (
      !this.orchestratorSnapshot ||
      this.orchestratorSnapshot.runId !== snapshot.runId ||
      snapshot.sequence > this.orchestratorSnapshot.sequence
    );
  }

  private syncOrchestratorRunDetailReferences(
    snapshot: OrchestratorSnapshotV1,
  ): void {
    if (
      this.orchestratorReferenceRunId &&
      this.orchestratorReferenceRunId !== snapshot.runId
    ) {
      this.clearOrchestratorRunDetailReferences();
    }
    this.orchestratorReferenceRunId = snapshot.runId;
    for (const node of Object.values(snapshot.nodes)) {
      this.appendOrchestratorReference(
        this.runLogEl,
        "node",
        node.id,
        `Task ${node.title}: ${node.status}`,
      );
      for (const evidenceId of node.evidenceIds) {
        this.appendOrchestratorReference(
          this.evidenceDetailsEl,
          "evidence",
          evidenceId,
          `Orchestrator evidence ${evidenceId} · task ${node.title}`,
        );
      }
      for (const receiptId of node.receiptIds) {
        this.appendOrchestratorReference(
          this.receiptsEl,
          "receipt",
          receiptId,
          `Orchestrator receipt ${receiptId} · task ${node.title}`,
        );
      }
    }
    for (const worktree of Object.values(snapshot.worktrees)) {
      this.appendOrchestratorReference(
        this.verificationEl,
        "worktree",
        worktree.id,
        `Worktree ${worktree.branch}: ${worktree.status}`,
      );
    }
    this.appendOrchestratorReference(
      this.verificationEl,
      "verification",
      "orchestrator",
      `Orchestrator verification: ${snapshot.merge.verificationStatus}`,
    );
  }

  private clearOrchestratorRunDetailReferences(): void {
    for (const section of [
      this.runLogEl,
      this.evidenceDetailsEl,
      this.receiptsEl,
      this.verificationEl,
    ]) {
      for (const row of Array.from(
        section?.querySelectorAll(
          ".agentic-researcher-orchestrator-reference",
        ) ?? [],
      )) {
        row.remove();
      }
    }
    this.orchestratorReferenceRunId = null;
  }

  private appendOrchestratorReference(
    section: HTMLElement | null,
    kind: OrchestratorDetailsTarget["kind"],
    id: string,
    message: string,
  ): void {
    if (!section || !id) return;
    const deepLinkAttribute =
      kind === "evidence"
        ? "data-evidence-id"
        : kind === "receipt"
          ? "data-receipt-id"
          : kind === "verification"
            ? "data-verification-id"
            : kind === "worktree"
              ? "data-worktree-id"
              : "data-orchestrator-node-id";
    const existingDeepLink = Array.from(
      section.querySelectorAll<HTMLElement>(`[${deepLinkAttribute}]`),
    ).find((element) => element.getAttribute(deepLinkAttribute) === id);
    if (
      existingDeepLink &&
      !existingDeepLink.classList.contains("agentic-researcher-orchestrator-reference")
    ) {
      return;
    }
    const existing = existingDeepLink ?? Array.from(
      section.querySelectorAll<HTMLElement>(
        "[data-orchestrator-reference-kind][data-orchestrator-reference-id]",
      ),
    ).find(
      (element) =>
        element.dataset.orchestratorReferenceKind === kind &&
        element.dataset.orchestratorReferenceId === id,
    );
    if (existing) {
      const messageEl = existing.querySelector<HTMLElement>(
        ".agentic-researcher-detail-message",
      );
      messageEl?.setText(message);
      return;
    }
    this.clearPlaceholder(section);
    const row = section.createDiv({
      cls: "agentic-researcher-detail-line agentic-researcher-orchestrator-reference",
    });
    row.dataset.orchestratorReferenceKind = kind;
    row.dataset.orchestratorReferenceId = id;
    if (kind === "evidence") row.dataset.evidenceId = id;
    if (kind === "receipt") row.dataset.receiptId = id;
    if (kind === "verification") row.dataset.verificationId = id;
    if (kind === "worktree") row.dataset.worktreeId = id;
    if (kind === "node") row.dataset.orchestratorNodeId = id;
    row.createSpan({
      text: `${kind}: `,
      cls: "agentic-researcher-detail-kind",
    });
    row.createSpan({
      text: message,
      cls: "agentic-researcher-detail-message",
    });
    const rows = section.querySelectorAll(
      ":scope > .agentic-researcher-orchestrator-reference",
    );
    for (const stale of Array.from(rows).slice(0, Math.max(0, rows.length - MAX_DETAIL_ROWS))) {
      stale.remove();
    }
  }

  private navigateFromOrchestrator(target: OrchestratorDetailsTarget): void {
    this.setActiveTab("details");
    const section =
      target.kind === "evidence"
        ? this.evidenceDetailsEl
        : target.kind === "receipt"
          ? this.receiptsEl
          : target.kind === "verification" || target.kind === "worktree"
            ? this.verificationEl
            : this.runLogEl;
    if (section instanceof HTMLDetailsElement) {
      section.open = true;
    }
    const exact = this.findOrchestratorRunDetailTarget(target);
    const exactSection = exact?.closest("details");
    if (exactSection instanceof HTMLDetailsElement) exactSection.open = true;
    (exact ?? section)?.scrollIntoView({ block: "nearest" });
  }

  private findOrchestratorRunDetailTarget(
    target: OrchestratorDetailsTarget,
  ): HTMLElement | null {
    if (!target.id || !this.detailsPanelEl) return null;
    const attribute =
      target.kind === "evidence"
        ? "data-evidence-id"
        : target.kind === "receipt"
          ? "data-receipt-id"
          : target.kind === "verification"
            ? "data-verification-id"
            : target.kind === "worktree"
              ? "data-worktree-id"
              : "data-orchestrator-node-id";
    const exact = Array.from(
      this.detailsPanelEl.querySelectorAll<HTMLElement>(`[${attribute}]`),
    ).find((element) => element.getAttribute(attribute) === target.id);
    if (exact) return exact;
    return Array.from(
      this.detailsPanelEl.querySelectorAll<HTMLElement>("[data-trace-id]"),
    ).find((element) => element.dataset.traceId === target.id) ?? null;
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

    const existing = getConnectedRegistryElement(this.traceRowEls, event.id);
    if (existing) {
      return existing;
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
    this.appendRunDetailProjection(event);

    if (chatId) {
      this.bindTraceNavigation(rowEl, chatId);
    }

    this.traceRowEls.set(event.id, rowEl);
    while (this.traceRowEls.size > MAX_TRACE_ROWS) {
      const oldest = this.traceRowEls.entries().next().value as
        | [string, HTMLElement]
        | undefined;
      if (!oldest) {
        break;
      }
      oldest[1].remove();
      this.traceRowEls.delete(oldest[0]);
      this.ensureCompactionMarker(this.runLogEl);
    }
    this.enforceTraceRowLimit();
    this.runLogEl.scrollTop = this.runLogEl.scrollHeight;
    return rowEl;
  }

  private enforceTraceRowLimit() {
    if (!this.runLogEl) {
      return;
    }

    const markerAllowance = this.runLogEl.querySelector(
      ":scope > .agentic-researcher-compacted",
    )
      ? 1
      : 0;
    if (
      this.runLogEl.childElementCount <=
      MAX_TRACE_ROWS + markerAllowance
    ) {
      return;
    }

    // The mounted DOM is the authoritative memory bound. A registry can lag a
    // remounted pane while replay is in flight, so cap direct children too and
    // then discard registry entries whose rows were compacted.
    this.trimRows(
      this.runLogEl,
      ".agentic-researcher-trace-row",
      MAX_TRACE_ROWS,
    );
    for (const [id, element] of this.traceRowEls) {
      if (!element.isConnected) {
        this.traceRowEls.delete(id);
      }
    }
  }

  private appendRunDetailProjection(event: AgentTraceEvent) {
    const toolName = event.toolName ?? "";
    if (event.kind === "acceptance") {
      this.renderMissionAcceptance(
        this.getMissionAcceptanceFromTrace(event),
        "live",
      );
      this.appendDetailLine(this.milestonesDetailsEl, event);
    }

    if (event.kind === "verification") {
      this.renderClaimGroundingVerification(event);
    }

    if (toolName.startsWith("browser_")) {
      this.appendDetailLine(this.browserDetailsEl, event);
    }

    if (
      event.kind === "tool_start" ||
      event.kind === "tool_result" ||
      event.kind === "tool_rejected" ||
      event.kind === "receipt"
    ) {
      this.appendDetailLine(this.actionsDetailsEl, event);
    }

    if (
      event.kind === "planning" ||
      event.kind === "tool_result" ||
      event.kind === "receipt" ||
      event.kind === "final" ||
      event.kind === "complete"
    ) {
      this.appendDetailLine(this.milestonesDetailsEl, event);
    }

    if (toolName.startsWith("memory_")) {
      this.appendDetailLine(this.memoryDetailsEl, event);
    }

    if (
      toolName === "web_fetch" ||
      toolName === "open_web_source" ||
      toolName === "read_file" ||
      toolName === "read_markdown_files" ||
      toolName === "browser_extract_markdown"
    ) {
      this.appendDetailLine(this.evidenceDetailsEl, event);
    }

    if (
      toolName === "create_design_canvas" ||
      toolName === "create_svg_design" ||
      toolName === "create_design_package" ||
      toolName === "open_web_source" ||
      event.kind === "receipt"
    ) {
      this.appendDetailLine(this.artifactsDetailsEl, event);
    }
  }

  private appendDetailLine(element: HTMLElement | null, event: AgentTraceEvent) {
    if (!element || !event.message) {
      return;
    }

    this.clearPlaceholder(element);
    const rowEl = element.createDiv({
      cls: `agentic-researcher-detail-line agentic-researcher-detail-${event.kind}`,
    });
    rowEl.dataset.traceId = event.id;
    rowEl.createSpan({
      text: event.toolName ? `${event.toolName}: ` : `${event.kind}: `,
      cls: "agentic-researcher-detail-kind",
    });
    rowEl.createSpan({
      text: event.message,
      cls: "agentic-researcher-detail-message",
    });
    const meta = [
      event.path ? `path=${event.path}` : null,
      event.toPath ? `to=${event.toPath}` : null,
      event.operation ? `op=${event.operation}` : null,
    ].filter((part): part is string => Boolean(part));
    if (meta.length > 0) {
      rowEl.createSpan({
        text: ` ${meta.join(" ")}`,
        cls: "agentic-researcher-detail-meta",
      });
    }
    this.setExpandablePayload(rowEl, this.buildTracePayload(event));
    this.trimRows(
      element,
      ".agentic-researcher-detail-line",
      MAX_DETAIL_ROWS,
    );
  }

  private trimRows(
    element: HTMLElement,
    selector: string,
    maxRows: number,
  ) {
    const rows = Array.from(element.querySelectorAll(`:scope > ${selector}`));
    const removeCount = Math.max(0, rows.length - maxRows);
    for (const row of rows.slice(0, removeCount)) {
      row.remove();
    }
    if (removeCount > 0) {
      this.ensureCompactionMarker(element);
    }
  }

  private ensureCompactionMarker(element: HTMLElement) {
    if (element.querySelector(":scope > .agentic-researcher-compacted")) {
      return;
    }
    const marker = document.createElement("div");
    marker.className = "agentic-researcher-compacted";
    marker.textContent = "Older activity compacted.";
    element.prepend(marker);
  }

  private normalizeTraceKind(kind: string): AgentTraceEvent["kind"] {
    switch (kind) {
      case "status":
      case "acceptance":
      case "mission_intent":
      case "allowed_tools":
      case "model_call":
      case "tool_start":
      case "tool_result":
      case "tool_rejected":
      case "receipt":
      case "verification":
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

  private getMissionAcceptanceFromTrace(
    event: AgentTraceEvent,
  ): MissionAcceptanceChecklist | null {
    if (!isPlainRecord(event.outputPreview)) {
      return null;
    }

    const status = event.outputPreview.status;
    if (typeof status !== "string") {
      return null;
    }

    return {
      status,
      confidence:
        typeof event.outputPreview.confidence === "number"
          ? event.outputPreview.confidence
          : undefined,
      missing: this.getStringArray(event.outputPreview.missing),
      reasons: this.getStringArray(event.outputPreview.reasons),
      nextAction:
        typeof event.outputPreview.nextAction === "string"
          ? event.outputPreview.nextAction
          : undefined,
      checkedAt:
        typeof event.outputPreview.checkedAt === "string"
          ? event.outputPreview.checkedAt
          : undefined,
    };
  }

  private getStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
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

  private formatStepMetric(
    step: number,
    maxSteps = this.runConfig?.maxStepsForRun ?? MAX_AGENT_STEPS,
  ): string {
    return `${step} used (max ${maxSteps})`;
  }

  private formatStopReason(stopReason: AgentRunCompleteEvent["stopReason"]) {
    switch (stopReason) {
      case "write_completed":
        return "Write complete";
      case "clarifying_question":
        return "Needs clarification";
      case "user_stopped":
        return "Stopped by user";
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
