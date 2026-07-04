import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { AgentView, AGENT_VIEW_TYPE } from "./src/AgentView";
import {
  appendConversationMessage,
  normalizeConversationHistory,
  type AgentConversationMessage,
} from "./src/conversationHistory";
import {
  createConfiguredModelClient,
  requestUrlTransport,
} from "./src/model/createModelClient";
import type { ModelClient } from "./src/model/types";
import { AgentSettings, AgentSettingTab, DEFAULT_SETTINGS } from "./src/settings";
import { createDefaultToolRegistry } from "./src/tools/createToolRegistry";
import type { ToolExecutionContext, ToolRegistry } from "./src/tools/types";

export default class AgenticResearcherPlugin extends Plugin {
  settings: AgentSettings = { ...DEFAULT_SETTINGS };
  conversationHistory: AgentConversationMessage[] = [];

  async onload() {
    await this.loadSettings();

    this.registerView(
      AGENT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new AgentView(leaf, this),
    );

    this.addRibbonIcon("bot", "Open Agentic Researcher", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-agentic-researcher",
      name: "Open Agentic Researcher",
      callback: () => {
        void this.activateView();
      },
    });

    this.addSettingTab(new AgentSettingTab(this.app, this));
  }

  async activateView() {
    const existingLeaves = this.app.workspace.getLeavesOfType(AGENT_VIEW_TYPE);

    if (existingLeaves.length > 0) {
      await this.app.workspace.revealLeaf(existingLeaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);

    if (!leaf) {
      new Notice("Unable to open Agentic Researcher panel.");
      return;
    }

    await leaf.setViewState({
      type: AGENT_VIEW_TYPE,
      active: true,
    });

    await this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const data = await this.loadData();
    const record = isRecord(data) ? data : {};
    const { conversationHistory: rawHistory, ...settingsData } = record;

    this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsData);
    this.conversationHistory = normalizeConversationHistory(rawHistory);
  }

  async saveSettings() {
    await this.savePluginData();
  }

  async appendConversationMessage(message: AgentConversationMessage) {
    this.conversationHistory = appendConversationMessage(
      this.conversationHistory,
      message,
    );
    await this.savePluginData();
  }

  async clearConversationHistory() {
    this.conversationHistory = [];
    await this.savePluginData();
  }

  private async savePluginData() {
    await this.saveData({
      ...this.settings,
      conversationHistory: this.conversationHistory,
    });
  }

  createModelClient(): ModelClient {
    return createConfiguredModelClient(this.settings);
  }

  createToolRegistry(): ToolRegistry {
    return createDefaultToolRegistry();
  }

  createToolExecutionContext(originalPrompt: string): ToolExecutionContext {
    return {
      app: this.app,
      settings: this.settings,
      originalPrompt,
      httpTransport: requestUrlTransport,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
