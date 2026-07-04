import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
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

const LEGACY_DEFAULT_REQUEST_TIMEOUT_MS = 60000;

export default class AgenticResearcherPlugin extends Plugin {
  settings: AgentSettings = { ...DEFAULT_SETTINGS };
  conversationHistory: AgentConversationMessage[] = [];
  private lastActiveMarkdownFile: TFile | null = null;

  async onload() {
    await this.loadSettings();
    this.updateLastActiveMarkdownFile(this.resolveCurrentMarkdownFile());

    this.registerView(
      AGENT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new AgentView(leaf, this),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.updateLastActiveMarkdownFile(file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.updateLastActiveMarkdownFile(getMarkdownFileFromLeaf(leaf));
      }),
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

    const settings = Object.assign({}, DEFAULT_SETTINGS, settingsData);
    if (
      settings.requestTimeoutMs === LEGACY_DEFAULT_REQUEST_TIMEOUT_MS ||
      !Number.isFinite(settings.requestTimeoutMs) ||
      settings.requestTimeoutMs <= 0
    ) {
      settings.requestTimeoutMs = DEFAULT_SETTINGS.requestTimeoutMs;
    }

    this.settings = settings;
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
      getCurrentMarkdownFile: () => this.getCurrentMarkdownFile(),
      getCurrentMarkdownContent: (file) => this.getCurrentMarkdownContent(file),
    };
  }

  getCurrentMarkdownFile(): TFile | null {
    const resolved = this.resolveCurrentMarkdownFile();
    if (resolved) {
      this.updateLastActiveMarkdownFile(resolved);
      return resolved;
    }

    if (this.lastActiveMarkdownFile) {
      const file = this.app.vault.getFileByPath(this.lastActiveMarkdownFile.path);
      if (file && file.extension === "md") {
        this.lastActiveMarkdownFile = file;
        return file;
      }
    }

    return null;
  }

  getCurrentMarkdownContent(file: TFile): string | null {
    const liveFile = this.getCurrentMarkdownFile();
    if (!liveFile || liveFile.path !== file.path) {
      return null;
    }

    const recentText = getMarkdownTextFromLeaf(
      this.app.workspace.getMostRecentLeaf(),
      file,
    );
    if (recentText !== null) {
      return recentText;
    }

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const text = getMarkdownTextFromLeaf(leaf, file);
      if (text !== null) {
        return text;
      }
    }

    return null;
  }

  private resolveCurrentMarkdownFile(): TFile | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (isMarkdownFile(activeFile)) {
      return activeFile;
    }

    const recentFile = getMarkdownFileFromLeaf(
      this.app.workspace.getMostRecentLeaf(),
    );
    if (recentFile) {
      return recentFile;
    }

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const file = getMarkdownFileFromLeaf(leaf);
      if (file) {
        return file;
      }
    }

    return null;
  }

  private updateLastActiveMarkdownFile(file: TFile | null) {
    if (isMarkdownFile(file)) {
      this.lastActiveMarkdownFile = file;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMarkdownFile(file: TFile | null | undefined): file is TFile {
  return Boolean(file && file.extension === "md");
}

function getMarkdownFileFromLeaf(leaf: WorkspaceLeaf | null): TFile | null {
  const file = (leaf?.view as { file?: TFile | null } | undefined)?.file;
  return isMarkdownFile(file) ? file : null;
}

function getMarkdownTextFromLeaf(
  leaf: WorkspaceLeaf | null,
  file: TFile,
): string | null {
  const view = leaf?.view as
    | { file?: TFile | null; editor?: { getValue?: () => string } }
    | undefined;

  if (!view || view.file?.path !== file.path) {
    return null;
  }

  const value = view.editor?.getValue?.();
  return typeof value === "string" ? value : null;
}
